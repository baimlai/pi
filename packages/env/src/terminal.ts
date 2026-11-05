// 提供远端伪终端的启动和句柄：输入、尺寸、前台作业、原始输出、退出与取消；上游可据此承载交互shell，真实PTY由daemon创建。
// import type只保留开发期Connection/Json约束，运行JS不会因这行加载连接模块。
import type { Connection, Json } from "./connection.ts";

/** Input larger than this goes to the daemon in several writes; frames are at most 16 MiB. */
// 每个输入payload最多1MiB字节，不是总输入限制；头部/JSON仍另占帧空间。
const WRITE_CHUNK = 1024 * 1024;

// 伪终端启动参数：程序连接到远端PTY，可有回显、换行转换和作业控制；接口不在运行时检验大小/路径。
export interface TerminalOptions {
	/** Working directory of the program; it must exist. */
	// 工作目录交daemon检查，本函数不自动解析相对路径、创建目录或切换本机cwd。
	cwd: string;
	/** Program and arguments. Default: the user's shell (`SHELL` in `env` or the daemon's environment) as a login shell. */
	// argv可缺省，daemon才决定默认登录shell；readonly只约束TS数组修改，不把参数拼成shell命令。
	argv?: readonly string[];
	/** Added to the daemon's environment, or the whole environment with `inheritEnv: false`. Set `TERM` here. */
	// env是可选字符串字典，TERM等在此传出；真实合并环境由daemon完成。
	env?: Record<string, string>;
	// 显式false表示不继承daemon环境，undefined由daemon用默认值，不能用真值判断丢掉false。
	inheritEnv?: boolean;
	// 终端列数，单位为显示单元；daemon校验1..4096，本客户端不另加检查。
	cols: number;
	// 终端行数，同样不是像素或最大输出行数。
	rows: number;
	/** The terminal's raw output, in order. */
	// 原始PTY输出字节回调，不区分stdout/stderr；void不自动await或吞异常，文字解码由调用者决定。
	onData: (bytes: Uint8Array) => void;
}

/** The foreground job of a terminal: its process group id, and its leader's name if the system tells. */
// 前台作业信息是静态接口，不会执行系统查询；shell提示符与它启动的前台编辑器要分清。
export interface TerminalForeground {
	// pid实际是前台进程组id，不一定等于RemoteTerminal.pid所代表的初始程序。
	pid: number;
	// 无法取得名称时可以没有name，?不同于必有字段但值为空串。
	name?: string;
}

/**
 * A program running in a pseudo-terminal of a pi-env daemon. It ends when the program exits, `close()` kills it, or
 * the connection is lost (the daemon then kills it).
 */
// 远端伪终端的客户端句柄，例运行交互shell并喂按键。构造器不创建PTY；写/缩放发辅助帧，关闭发取消，真正系统操作在daemon，掉线清理仍依平台实现。
export class RemoteTerminal {
	// 初始程序的远端pid，不直接拿来给本机process.kill。
	readonly pid: number;
	/** The exit code; rejects with the daemon's error, with code `aborted` after `close()`. */
	// 等整个pty请求终态的Promise；正常退出含非零code也可resolve，取消/掉线等reject，并不保证操作系统所有后代此刻已退出。
	readonly exited: Promise<number>;
	// readonly是TS约束，#是JS私有字段；保存原Connection引用，不冻结连接。
	readonly #connection: Connection;
	// pty启动请求id，后续target使用它，不使用OS pid。
	readonly #id: number;
	// 原daemon会话代号，防重连后把旧句柄请求发到新daemon。
	readonly #session: number;
	// 对应长请求的取消控制器，不影响连接上其他PTY或文件请求。
	readonly #abort: AbortController;

	// 保存已启动PTY的编号、退出Promise和控制器，不发请求、不设终端尺寸；通常由openTerminal收到started后构造，例target=8和pid=123是两个不同编号。
	constructor(
		// 共享底层连接，辅助命令也走它。
		connection: Connection,
		// 启动请求的关联id。
		id: number,
		// 启动请求所在daemon的会话id。
		session: number,
		// 远端报告的初始程序pid。
		pid: number,
		// 复用调用者提供的退出Promise。
		exited: Promise<number>,
		// 复用启动时控制器，close才触发它。
		abort: AbortController,
	) {
		// 保存连接引用。
		this.#connection = connection;
		// 保存请求target编号。
		this.#id = id;
		// 保存原会话门禁编号。
		this.#session = session;
		// 向调用者暴露远端pid数值。
		this.pid = pid;
		// 保留同一退出Promise，不在此await它。
		this.exited = exited;
		// 保留控制器供关闭时发取消通知。
		this.#abort = abort;
	}

	/** Send input; once the terminal has ended, input is dropped. */
	// 文字转UTF-8后按1MiB分块交给远端PTY；例write("ls\n")仅喂输入，是否被shell执行由远端程序决定。返回void不等写入确认，空输入不发帧，辅助拒绝被吞掉。
	write(data: Uint8Array | string): void {
		// typeof收窄联合类型；字节数组保原引用，字符串由新TextEncoder编码，按字节而非字符切分。
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		// offset每轮加一块大小，确保大输入按顺序调用请求；本层没有等待背压。
		for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
			// ptyWrite的JSON只由助手加入target，原始字节作payload；subarray是视图，尾块自动缩短。
			this.#request("ptyWrite", {}, bytes.subarray(offset, offset + WRITE_CHUNK));
		}
	}

	/** Change the size; the program receives `SIGWINCH`. */
	// 请求改列/行数，例resize(100,30)让daemon设置PTY尺寸并按系统语义通知程序；不等待确认，非法值的拒绝被助手处理，不能据返回void认定已改好。
	resize(cols: number, rows: number): void {
		// 发送ptyResize和尺寸对象，不在本机更改终端，也不直接发SIGWINCH。
		this.#request("ptyResize", { cols, rows });
	}

	/** Kill the program and everything in its session. */
	// 请求取消该PTY，例close后await exited观察结果；本地只同步触发signal，不等远端真正杀组/关PTY，已结算的退出Promise不会因此改变。
	close(): void {
		// abort通知Connection为长请求发cancel，重复调用同一控制器不会反复触发abort事件。
		this.#abort.abort();
	}

	/**
	 * The job in the terminal's foreground when it is not the program itself: what a shell runs, such as an editor.
	 * Undefined while the program is in front (a shell at its prompt). Rejects once the terminal has ended.
	 */
	// 查询此刻前台作业，例shell跑vim时返回该组，shell自身在前台时undefined。返回Promise且保留请求错误，不像write/resize吞拒绝；查询后作业仍可能立刻变化。
	async foreground(): Promise<TerminalForeground | undefined> {
		// 绑定原session向原target查询，不因失联去新daemon查询旧编号；await拒绝会让此方法也reject。
		const reply = await this.#connection.request("ptyForeground", { target: this.#id }, { session: this.#session });
		// as只是断言远端字段可能为对象或null，没有补逐字段运行时校验；name在wire上用null表示未知。
		const foreground = reply.json.foreground as { pid: number; name: string | null } | null;
		// falsey结果当无前台作业；按合法协议是null，代码未用严格===null去拒绝其他异常值。
		if (!foreground) return undefined;
		// 新建返回对象；仅name真值才加入name字段，因此空串也会省略，不是把null原样暴露。
		return { pid: foreground.pid, ...(foreground.name ? { name: foreground.name } : {}) };
	}

	// 向原target/session发辅助请求并处理拒绝，例终端已结束后的write忽略EBADF；不是自动重连/重试，也不承诺每个resize错误都会出现在exited。
	#request(op: string, json: Json, payload?: Uint8Array): void {
		// 复用同一个Connection对象发帧。
		this.#connection
			// 展开json后再写target，因此target不能被json同名字段覆盖；payload有值才传，session始终限制原daemon。
			.request(op, { ...json, target: this.#id }, { session: this.#session, ...(payload ? { payload } : {}) })
			// A terminal that ended or a lost connection: `exited` reports it.
			// 空catch仅让辅助Promise拒绝被处理；无结果返回给write/resize调用者，exited只跟踪主pty请求。
			.catch(() => {});
	}
}

/** Start a program in a new pseudo-terminal of the daemon behind `connection`. */
// 开启PTY：建开始/退出两份Promise→发pty长请求→等started交句柄，输出继续走onData。例await openTerminal(conn,{cwd:"/tmp",cols:80,rows:24,onData:consume})使用daemon默认shell；本层不探测PTY平台支持或验证尺寸，启动失败reject，返回不等退出。
export function openTerminal(connection: Connection, options: TerminalOptions): Promise<RemoteTerminal> {
	// 每次打开独立控制器，不拿调用者的全局signal关闭整个连接。
	const abort = new AbortController();
	// withResolvers提供promise及其外置resolve/reject，泛型规定开始成功值为RemoteTerminal。
	const started = Promise.withResolvers<RemoteTerminal>();
	// 尚未取得id/session时为undefined，随后onStart赋值；对象字面量类型不是运行时初始化值。
	let request: { id: number; session: number } | undefined;
	// 派生Promise等终态结果；正常Connection通过异步读流回调事件，不在该变量初始化前同步发started。
	const exited = connection
		// 发长请求，EVENT不结算它，最后RESULT/ERROR才结算exited。
		.request(
			// op为pty，不与普通pipe进程的process混同；本函数没有先检查hello.features。
			"pty",
			// 下面是要序列化发出的JSON启动参数。
			{
				// 原样发送cwd，目录存在性由daemon检查。
				cwd: options.cwd,
				// argv只有undefined时省略，空数组仍传给daemon判断，缺省登录shell也是daemon决定。
				...(options.argv === undefined ? {} : { argv: options.argv }),
				// env缺省时不发该键，空表仍保留，不在此把它和本机process.env合并。
				...(options.env === undefined ? {} : { env: options.env }),
				// 保留显式false，三元展开空对象只用于省略undefined。
				...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
				// 发送初始列数，不在此夹到合法区间。
				cols: options.cols,
				// 发送初始行数，最终PTY由远端创建。
				rows: options.rows,
			},
			// Connection本地选项与JSON参数分开，回调/signal不作为JSON发送。
			{
				// 控制器signal让close可发取消，signal触发本身不立即结算开始/退出Promise。
				signal: abort.signal,
				// onStart是REQUEST写出前的本地编号通知，并非远端创建成功。
				onStart: (id, session) => {
					// 存请求id/session，started事件据此把句柄绑定到正确daemon。
					request = { id, session };
				},
				// 按事件kind处理，未知事件忽略；json内部字段没有完整schema校验。
				onEvent: (json, payload) => {
					// output的payload原样交onData，不在此解码/按行拆分/分stderr；同步回调异常由外层调用路径处理，本层不catch。
					if (json.kind === "output") options.onData(payload);
					// 远端started且本地编号已知才交付句柄，重复resolve只第一次有效。
					else if (json.kind === "started" && request) {
						// 完成开始Promise，让await openTerminal返回；长请求仍在运行。
						started.resolve(
							// Number(pid)是转换而非有效pid校验，可能NaN；句柄保存同一exited/control/原会话编号。
							new RemoteTerminal(connection, request.id, request.session, Number(json.pid), exited, abort),
						);
					}
				},
			},
		)
		// 最终exitCode只做Number转换，非零码仍可resolve；若request拒绝则保留拒绝，不进入then。
		.then((reply) => Number(reply.json.exitCode));
	// Failing before it started rejects the open; afterwards, `exited` carries it.
	// 开始前失败拒绝open；开始后失败无法改已完成started，但exited仍拒绝；挂catch也处理该派生拒绝，不代表把exited变为成功。
	exited.catch(started.reject);
	// 返回开始Promise，函数本身无async但仍可await；若坏协议仅发成功RESULT却没started，不会自动完成这份开始Promise。
	return started.promise;
}
