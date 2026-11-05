// 提供daemon普通pipe进程的启动和句柄：输入/EOF、分开的原始输出、退出与取消；上游通过openProcess取得句柄，真实进程在daemon端运行。
// type Connection只参与类型检查；RemoteError是真实错误类，运行时用于报告旧daemon缺能力。
import { type Connection, RemoteError } from "./connection.ts";

/** Input larger than this goes to the daemon in several writes; frames are at most 16 MiB. */
// 每份stdin输入最多1MiB字节，给JSON/帧头留余量；是分块大小，不是整次输入上限。
const WRITE_CHUNK = 1024 * 1024;

// 普通pipe进程的启动选项；类型声明本身不检查路径是否存在或argv是否非空。
export interface ProcessOptions {
	/** Working directory of the program; it must exist. */
	// 远端程序的工作目录；本函数不把相对路径自动改为绝对路径，调用者应传已解析的路径。
	cwd: string;
	/** Program and arguments, run directly without a shell. */
	// readonly限制TS侧修改数组，首项为程序、后面是独立参数；不自动经shell解析重定向或管道。
	argv: readonly string[];
	/** Added to the daemon's environment, or the whole environment with `inheritEnv: false`. */
	// ?允许不传环境表；Record<string,string>是字符串键和值的字典，真正组合环境在daemon端完成。
	env?: Record<string, string>;
	// 缺省交给daemon继承环境，显式false表示仅使用env；后面用===undefined以保留false。
	inheritEnv?: boolean;
	/** The program's stdout, raw bytes in order. */
	// stdout必须有接收函数，拿到原始字节；=>void表示不使用返回值，不自动await或捕获回调异常。
	onStdout: (bytes: Uint8Array) => void;
	/** The program's stderr, raw bytes in order. */
	// stderr回调可省，省略就忽略此流；此处不把stderr混进stdout或当成必然失败。
	onStderr?: (bytes: Uint8Array) => void;
}

/**
 * A program running with plain pipes in a pi-env daemon, for programs that speak a protocol on stdin and stdout. It
 * ends when the program exits, `close()` kills it, or the connection is lost (the daemon then kills it).
 */
// 普通管道程序的客户端句柄，例MCP服务器通过stdin/stdout交换JSON。进程由daemon运行，不由这个构造器直接spawn；连接失联后的远端清理依daemon/平台，close仅发取消。
export class RemoteProcess {
	// 远端进程pid用于展示，不应直接传给本机process.kill；readonly只限制TS重赋值。
	readonly pid: number;
	/** The exit code; rejects with the daemon's error, with code `aborted` after `close()`. */
	// Promise<number>等待整个process请求结算；非零退出码也可正常resolve，协议错误/取消/掉线才reject。
	readonly exited: Promise<number>;
	// #是真正JS私有字段，保存连接原引用；readonly不冻结Connection自身状态。
	readonly #connection: Connection;
	// 启动process请求的id，后续输入用target指向它，不是OS pid。
	readonly #id: number;
	// daemon的本地会话代号；旧句柄不能在重连后的新daemon上误用同号请求。
	readonly #session: number;
	// 该次启动请求的取消控制器，close触发它而非直接发送系统信号。
	readonly #abort: AbortController;

	// 把已经启动的请求包装成句柄：保存引用与编号，不发帧、不检查pid、也不另建退出Promise；通常由openProcess的started事件构造，例如id=7/pid=123两个编号分工不同。
	constructor(
		// 连接负责所有帧的收发和掉线处理。
		connection: Connection,
		// id关联processWrite/processCloseStdin的target。
		id: number,
		// session限制后续请求只能到原daemon。
		session: number,
		// pid来自started事件里的数值转换，不是这一步通过系统查询得到。
		pid: number,
		// 复用启动请求派生的exited，调用者可await它等终态。
		exited: Promise<number>,
		// 复用启动时的控制器，因此close会通知同一长请求。
		abort: AbortController,
	) {
		// 保存连接，不复制或启动它。
		this.#connection = connection;
		// 保存请求id。
		this.#id = id;
		// 保存会话id。
		this.#session = session;
		// 对外暴露远端pid值。
		this.pid = pid;
		// 保留同一退出Promise，构造器本身不等待程序结束。
		this.exited = exited;
		// 保留控制器引用供close使用。
		this.#abort = abort;
	}

	/** Write to the program's stdin, in order; once stdin is closed or the program has ended, input is dropped. */
	// 把文字转UTF-8或使用原字节，再按1MiB顺序发stdin请求，返回void不等待远端实际读取。例write("你好\n")按字节切，不按字符切；空输入不发请求，失败由私有助手吞掉。
	write(data: Uint8Array | string): void {
		// 联合类型Uint8Array|string用typeof收窄；文字新编码，传入字节数组则复用，孤立代理按TextEncoder规则替换。
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		// let允许递增offset，边界按bytes.length计算；并发帧由Connection按本次调用顺序排入stdin，不在此等待背压。
		for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
			// subarray是原字节视图，尾块自动截到数组末尾；助手发processWrite，不是本机写文件。
			this.#request("processWrite", bytes.subarray(offset, offset + WRITE_CHUNK));
		}
	}

	/** Close the program's stdin after the input written before it. */
	// 请求在已排队输入后关闭远端stdin，例喂完JSON后closeStdin使程序读到EOF；返回void只说明请求已交连接，错误不从此方法返回，不等整个程序退出。
	closeStdin(): void {
		// 发送单独processCloseStdin操作，不附payload、不销毁连接或其他进程。
		this.#request("processCloseStdin");
	}

	/** Kill the program and its process group. */
	// 请求取消这个process及daemon负责的进程组；例close后await exited可观察aborted/其他竞态终态。此行不等待或确认全部子孙退出，重复abort不会重复发同一abort事件。
	close(): void {
		// AbortController同步标记signal并通知Connection的监听器；仍由远端回复结算exited，已结束Promise不会被改写。
		this.#abort.abort();
	}

	// 给原id/session发辅助操作并吞掉拒绝，保证已结束后的输入可被忽略；不是自动重试。例失联时不把旧target发给新daemon，调用者也拿不到单次写入确认。
	#request(op: string, payload?: Uint8Array): void {
		// 从同一个连接对象发起辅助请求。
		this.#connection
			// 两个对象分别是JSON字段和本地选项；展开仅在payload有值时加入字节，session始终保留。
			.request(op, { target: this.#id }, { session: this.#session, ...(payload ? { payload } : {}) })
			// Stdin already closed, the program ended, or a lost connection: `exited` reports the end.
			// 空catch把辅助请求拒绝转为已处理；exited只代表主process请求，不保证每个写失败都单独反映在exited上。
			.catch(() => {});
	}
}

/**
 * Start a program with plain pipes in the daemon behind `connection`. Fails with `not_supported` when the daemon was
 * released before the `process` operation.
 */
// 开普通pipe程序：先查process能力→创建开始/结束两份Promise→发请求→等started事件交句柄。例await openProcess(conn,{cwd:"/tmp",argv:["node","server.js"],onStdout:consume})；路径/参数校验由daemon负责，启动失败拒绝，成功返回不等于程序已结束。
export async function openProcess(connection: Connection, options: ProcessOptions): Promise<RemoteProcess> {
	// await info可能按需启动连接；features缺省或不含process都拒绝，不能把有能力标记当程序一定能启动。
	if (!(await connection.info()).features?.includes("process")) {
		// async函数内throw表现为Promise拒绝，采用not_supported固定错误，不先试发未知process操作。
		throw new RemoteError({ code: "not_supported", message: "The pi-env daemon cannot run processes; update it" });
	}
	// 每个程序独立控制器，不取消整条连接的其他请求。
	const abort = new AbortController();
	// withResolvers返回{promise,resolve,reject}；泛型规定成功值是句柄，创建Promise不会自动执行远端程序。
	const started = Promise.withResolvers<RemoteProcess>();
	// 对象类型与undefined联合表示本地onStart还没提供id/session，let用于随后赋值。
	let request: { id: number; session: number } | undefined;
	// exited接收整条request的派生Promise；started事件由异步读流触发，正常Connection不会在该声明初始化前同步回调事件。
	const exited = connection
		// 发送长生命周期请求，它会通过多条EVENT报告开始/输出，最后RESULT/ERROR才结算。
		.request(
			// op固定process，与PTY不同，stdout/stderr分开且不做终端回显转换。
			"process",
			// 这一对象是要编码进帧的JSON启动参数。
			{
				// 把cwd原值交给daemon，不在本层创建目录。
				cwd: options.cwd,
				// 传argv原数组的当前内容，Connection稍后序列化，不把数组拼成shell字符串。
				argv: options.argv,
				// env没传就展开空对象，显式空表{}仍会发送；这里不执行环境继承合并。
				...(options.env === undefined ? {} : { env: options.env }),
				// 只排除undefined，false仍传出，避免误把“不要继承”当缺省。
				...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
			},
			// 第二个对象是Connection本地请求选项，不会把回调本身序列化到daemon。
			{
				// signal让close能按请求id发cancel；它不是本地立即reject的开关。
				signal: abort.signal,
				// onStart在Connection写REQUEST前同步通知本地id/session，尚不是远端程序启动成功。
				onStart: (id, session) => {
					// 保存关联编号，后面的started事件才可构造正确句柄。
					request = { id, session };
				},
				// 进度回调按kind分支；json内字段仍unknown，代码只检查需要的标记，未全量校验协议形状。
				onEvent: (json, payload) => {
					// 只有output事件进入字节分流，其他未知kind不当输出处理。
					if (json.kind === "output") {
						// 仅精确stderr字符串走可选stderr回调，没提供时丢弃；回调同步异常会向事件调用方传播。
						if (json.stream === "stderr") options.onStderr?.(payload);
						// 其他stream值都当stdout处理，包含未知/缺省值；不把它描述成严格枚举验证。
						else options.onStdout(payload);
						// started事件且本地request已记录才构造句柄；启动完成resolve只第一次生效。
					} else if (json.kind === "started" && request) {
						// 通知等待openProcess的调用者，长请求本身仍继续收输出/等退出。
						started.resolve(
							// Number把unknown pid转数值，可能得到NaN，并非验证有效pid；传入同一exited/control及原会话编号。
							new RemoteProcess(connection, request.id, request.session, Number(json.pid), exited, abort),
						);
					}
				},
			},
		)
		// RESULT的exitCode也仅用Number转换，非零值仍resolve；若长请求拒绝则跳过then而保留拒绝。
		.then((reply) => Number(reply.json.exitCode));
	// Failing before it started rejects the open; afterwards, `exited` carries it.
	// 开始前拒绝使open失败；已交付句柄后reject不能改已settled的started，失败由exited保留；catch也处理派生拒绝，非重新启动。
	exited.catch(started.reject);
	// async采用started.promise的最终结果，不等待exited；若协议异常只给RESULT而没started，这份开始Promise不会因成功RESULT自动resolve。
	return started.promise;
}
