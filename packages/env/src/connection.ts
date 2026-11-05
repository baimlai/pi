// 管理pi-env子进程或SSH传输的帧连接：按需启动/hello、并发请求与事件、取消通知、心跳和失联重启；发送通知与远端真正完成分开理解。
// spawn按程序与argv起子进程，默认不经shell；type说明stdio有pipe句柄，不保证启动成功。
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
// 随机字节生成本次同步token，帮助从shell噪声里找到协议开头，不等于主机认证。
import { randomBytes } from "node:crypto";
// 剥VT控制序列仅用于错误摘要，原onLog诊断不自动走此过滤。
import { stripVTControlCharacters } from "node:util";

/** Frame types (docs/protocol.md). */
// 请求帧1，json.op标操作，id关联回复。
const REQUEST = 1;
// 结果帧2，某id操作成功结束。
const RESULT = 2;
// 错误帧3，某id操作失败结束。
const ERROR = 3;
// 事件帧4，报告进度，不结束请求。
const EVENT = 4;
// 取消帧5，按id取消；mode:kill与协作abort的远端结算口径不同。
const CANCEL = 5;
// 心跳帧6，无具体业务结果。
const PING = 6;

// 接收length最多16MiB，不含开头4字节；发送frame自己不检查该上限，调用方另分块。
const MAX_FRAME = 16 * 1024 * 1024;
// 每5秒尝试PING/检查静默，调度目标不保证严格实时。
const PING_INTERVAL_MS = 5000;
/** The daemon pings every five seconds; this much silence means the connection is gone. */
// 大于30秒没收stdout字节才判丢失，按5秒timer检查，使用墙钟。
const SILENCE_LIMIT_MS = 30_000;
/** How long starting the daemon and its `hello` may take. */
// 子进程spawn后等待hello的超时目标为60秒；异步命令准备不在此计时，timer调度也可延后。
const START_TIMEOUT_MS = 60_000;
/** How much stderr a startup error shows: short, because a tool error can reach the model. */
// ready前stderr先截末2000个UTF-16码元，不是UTF-8字节；摘要后面还会过滤/裁行。
const STDERR_TAIL_CHARS = 2000;
// 最终摘要最多20个非空行，不限制原onLog日志。
const STDERR_TAIL_LINES = 20;

// 字符串键→unknown值字典；名字Json不保证BigInt/循环等可序列化，也不自动校验内部形状。
export type Json = Record<string, unknown>;

/** A failure reported by the daemon, with its Node-style code. */
// 远端错误包装类，保留原fields并摘code/message/path；例ENOENT与/x。只建Error，不查文件或认证，不脱敏正文。
export class RemoteError extends Error {
	// readonly code只由TS限制重赋，未知码仍可原样保存。
	readonly code: string;
	// path?表示错误未必有路径，不默认空串。
	readonly path?: string;
	// 保存原字段字典引用，readonly不深冻结。
	readonly fields: Json;

	// 从协议JSON的unknown字段建错误，少量字段要实际检查，不是验证所有业务参数。
	constructor(fields: Json) {
		// message是string才采用，否则固定兜底；super设Error基类消息。
		super(typeof fields.message === "string" ? fields.message : "Remote operation failed");
		// name便于显示识别，实例判断仍用instanceof。
		this.name = "RemoteError";
		// code是string才采用，否则unknown，不限制成一张封闭枚举。
		this.code = typeof fields.code === "string" ? fields.code : "unknown";
		// 只保留字符串path，空串也通过类型判断。
		if (typeof fields.path === "string") this.path = fields.path;
		// 其他字段如lost/extra仍留原对象，不复制或删除。
		this.fields = fields;
	}
}

/** What `hello` reports about the remote machine. */
// hello数据的静态接口，声明不会验证wire；当前握手只明确检查protocol后作断言。
export interface RemoteInfo {
	// 传输协议号，目前只接受数值1。
	protocol: number;
	// daemon随包发布的版本号，不是Node版本。
	version: string;
	// Rust系统名，如windows/macos，后面再映Node拼写。
	os: string;
	// Rust架构名，如x86_64/aarch64。
	arch: string;
	// 远端home，不是本机HOME。
	home: string;
	// 远端临时目录，不是本机tmpdir。
	tmpdir: string;
	/** Path separator: `/`, or `\\` on Windows. */
	// 远端路径分隔符，接口未限制成二选一字面量。
	separator: string;
	/** The daemon's working directory, where Node's `path.resolve` would fall back to `process.cwd()`. */
	// daemon cwd用于远端路径解析兜底。
	cwd: string;
	/** Windows: per-drive working directories (`C:` → `C:\\work`) of the `=C:` variables. */
	// Windows每驱动器当前目录表，供C:foo等路径用，不等于C:/foo。
	driveCwds: Record<string, string>;
	// 远端daemon pid，不当成本机可直接kill的pid。
	pid: number;
	/** Operations added to protocol 1 that this daemon supports, such as `listFiles`; absent from older daemons. */
	// 旧daemon可能没features，调用方需按它判断listFiles/process能力。
	features?: string[];
}

/**
 * Node's names for the daemon's system and architecture, which `hello` reports in Rust's spelling: `windows` is
 * `win32`, `macos` is `darwin`, `x86_64` is `x64`, `aarch64` is `arm64`, so they compare with `process.platform` and
 * `process.arch`. Other names are kept.
 */
// 映射Rust系统/架构拼写为Node惯例。例windows/x86_64→win32/x64；Pick只要os/arch，查值缺省才回原名。普通对象索引可能命中原型同名键，不是运行白名单或系统探测。
export function nodePlatform(info: Pick<RemoteInfo, "os" | "arch">): { platform: string; arch: string } {
	// 系统映射表，每次调用新建，不改info。
	const platforms: Record<string, string> = { windows: "win32", macos: "darwin" };
	// 架构表含x86→ia32，不混同x86_64。
	const archs: Record<string, string> = { x86_64: "x64", aarch64: "arm64", x86: "ia32" };
	// ??只在查值null/undefined时回原名，返回新两字段对象。
	return { platform: platforms[info.os] ?? info.os, arch: archs[info.arch] ?? info.arch };
}

// 构造连接的选项类型，constructor只存引用，实际首次使用才启动。
export interface ConnectionOptions {
	/**
	 * Command that starts the daemon, before its `serve --token <hex>` arguments, e.g. `["ssh", "-T", "--", "host",
	 * "~/.pi/mobile/tools/pi-env"]`. A function computes it at each start (detecting and deploying first, for example);
	 * its failure fails that start, and the next request tries again.
	 */
	// 命令可给只读argv或异步工厂；每次新启动重新算，失败留给下一请求再试，工厂副作用由应用决定。
	command: readonly string[] | (() => Promise<readonly string[]>);
	/** Receives the daemon's and the transport's diagnostic output. */
	// 可选原诊断回调；void不要求实现无返回值，此层不统一捕获callback异常。
	onLog?: (text: string) => void;
}

// 成功回复带结构化JSON、原始payload与daemon本地会话号，方便句柄后续绑定同会话。
export interface Reply {
	// JSON字典的每个字段值仍为unknown，具体操作按协议解释，不自动解出FileInfo等。
	json: Json;
	// payload是独立复制的Uint8Array，非接收Buffer视图，不自动文本解码。
	payload: Uint8Array;
	/** The daemon session that answered; handles from it are only valid while it lives. */
	// 本Connection内daemon代号，不是远端请求id或会话文件id。
	session: number;
}

// 一条在途请求的结算/进度回调，Map按帧id查它。
type Pending = {
	// 成功回调完成对应Promise，不代表远端所有子孙工作已结束。
	resolve: (value: Reply) => void;
	// 失败回调以Error拒绝，拆连接可共享同一错误给多个请求。
	reject: (error: Error) => void;
	// 进度回调可省，事件不清pending。
	onEvent?: (json: Json, payload: Uint8Array) => void;
};

// 单次请求选项：payload、取消、事件/开始通知和会话门禁；接口不执行操作级校验。
export interface RequestOptions {
	// payload放JSON后，不用base64塞json。
	payload?: Uint8Array;
	/** Aborting sends `cancel`; the request still settles with the daemon's result or error. */
	// abort只发送cancel，仍等daemon终态，不当场本地拒绝所有工作。
	signal?: AbortSignal;
	/** Progress events of the request, such as `exec` output. */
	// EVENT对应此请求id，json/payload形状未按op继续验证。
	onEvent?: (json: Json, payload: Uint8Array) => void;
	/** The request's id and session, for `kill`. */
	// 写REQUEST前通知本地id/session，不是远端已启动确认。
	onStart?: (id: number, session: number) => void;
	/**
	 * Only run in this daemon session, for requests on handles it opened. After the connection was lost and started
	 * again, such requests fail instead of reaching a daemon that never opened the handle.
	 */
	// 带session就只准现有匹配daemon，不为旧句柄自动开新连接。
	session?: number;
}

/** Lone surrogates become U+FFFD, as Node encodes strings for system calls. */
// JSON replacer修复字符串值孤立代理为U+FFFD，其他值原样；_key未用，不规范化对象键。例异常UTF-16路径值，非路径权限检查。
function wellFormed(_key: string, value: unknown): unknown {
	// unknown输入先typeof收窄，toWellFormed保留合法代理对，不修改原字符串对象。
	return typeof value === "string" ? value.toWellFormed() : value;
}

// 按type/id/JSON/可选payload创建一帧Buffer；例hello用type1。无IO，序列化/整数写头可抛，未检查MAX_FRAME或自动拆帧。
function frame(type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)): Buffer {
	// JSON值先经replacer再UTF-8编码，BigInt/循环/toJSON等仍可能失败或有副作用。
	const body = Buffer.from(JSON.stringify(json, wellFormed), "utf8");
	// 13字节头=length4+type1+id4+jsonLength4，alloc初始为0。
	const header = Buffer.alloc(13);
	// 大端length写余下9+JSON字节+payload字节，不含自己的4字节。
	header.writeUInt32BE(9 + body.length + payload.length, 0);
	// 偏移4写一字节type。
	header.writeUInt8(type, 4);
	// 偏移5写四字节请求id，不是JSON业务字段id。
	header.writeUInt32BE(id, 5);
	// 偏移9写JSON UTF-8字节长，不是JS string.length。
	header.writeUInt32BE(body.length, 9);
	// concat按头/JSON/payload复制成新连续Buffer。
	return Buffer.concat([header, body, payload]);
}

/** The connection failed or ended; a request may succeed once it is started again. */
// 创建带lost:true的unknown错误，表示连接失败/结果可能未知，不自动重试业务操作，无IO。
function lost(message: string): RemoteError {
	// lost留在原fields内，不自动变独立属性。
	return new RemoteError({ code: "unknown", message, lost: true });
}

/** Whether an error means the connection was lost, not that the daemon refused the request. */
// 判断任意抛值是否本模块RemoteError且lost严格true；不把所有unknown码都当掉线。
export function isConnectionLost(error: unknown): boolean {
	// &&短路后读fields；外形相同/别realm错误不一定识别，字符串true也不接受。
	return error instanceof RemoteError && error.fields.lost === true;
}

// 创建显式关闭错误，不附lost:true，无IO；关闭后不再准重连。
function closed(): RemoteError {
	// 固定unknown/message不意味着isConnectionLost就会true。
	return new RemoteError({ code: "unknown", message: "Connection closed" });
}

/**
 * `message` plus the last lines of `stderr`. The remote machine wrote that text, so terminal escapes and control
 * characters are removed.
 */
// 给启动错误拼已收stderr摘要：归一换行→去VT/控制→trim行尾→去空行→末20行。例SSH拒绝诊断；不是秘密脱敏，也不改变onLog原文，无IO。
function withStderr(message: string, stderr: string): string {
	// 累积清理后的新字符串，不改参数。
	let text = "";
	// 先CRLF/CR转LF再去VT，for...of逐码点遍历剩余内容。
	for (const char of stripVTControlCharacters(stderr.replace(/\r\n?/g, "\n"))) {
		// 首UTF-16码元用于排控制范围；非BMP char会保整字符，不按显示宽度计。
		const code = char.charCodeAt(0);
		// 保留LF/tab与非C0/DEL/C1的文字，不把所有空白都丢掉。
		if (char === "\n" || char === "\t" || (code >= 0x20 && (code < 0x7f || code > 0x9f))) text += char;
	}
	// 链式生成行数组供整理摘要。
	const lines = text
		// 按LF拆分，2000码元截尾早在收stderr时完成。
		.split("\n")
		// JS trimEnd裁每行右空白，保留有内容行的左缩进。
		.map((line) => line.trimEnd())
		// 只去清理后空串行，不一概裁行首。
		.filter((line) => line !== "");
	// 没有内容就原message，不补标题。
	if (lines.length === 0) return message;
	// 末20非空行拼摘要；非close失败可能只含当时已到尾部，不保证stderr已全收完。
	return `${message}\nremote stderr:\n${lines.slice(-STDERR_TAIL_LINES).join("\n")}`;
}

/** One running daemon. */
// 一个真实daemon子进程及其收发状态，构造器只赋引用，不自动spawn；Connection可先后换多个Session。
class Session {
	// 本地daemon代号，readonly只管TS重赋。
	readonly id: number;
	// 真实ChildProcess及三条pipe，不是fork IPC消息通道。
	readonly child: ChildProcessWithoutNullStreams;
	// 本次同步token，不放每个业务帧。
	readonly token: string;
	// Map仅含此daemon在途请求，掉线不跨会话重放。
	readonly pending = new Map<number, Pending>();
	/** Received bytes not yet parsed, without concatenating on every chunk. */
	// 保留Buffer分块，peek跨块才合并，非每块都concat全部。
	chunks: Buffer[] = [];
	// 总未消费字节，不是字符数/块数。
	buffered = 0;
	// 同步前不把shell噪声当二进制帧。
	synced = false;
	// 本机墙钟，任意stdout数据后刷新，不仅合法结果。
	lastSeen = Date.now();
	// ReturnType复用Node setInterval句柄类型，可缺省；不硬写浏览器number。
	timer: ReturnType<typeof setInterval> | undefined;
	// live供幂等拆除/晚数据门禁，false不等于系统已确认进程退出。
	live = true;
	// 只ready前积累stderr尾，ready后仍交onLog。
	stderrTail = "";

	// 显式保存id/child/token，其他字段已有初始化；没有TS参数属性语法，不执行IO。
	constructor(id: number, child: ChildProcessWithoutNullStreams, token: string) {
		// 保存本地编号。
		this.id = id;
		// 保存进程引用供读流/发信号。
		this.child = child;
		// 保存本次标记值。
		this.token = token;
	}

	/** The first `length` buffered bytes as one buffer, without consuming them. */
	// 窥看前length字节不消费，返回视图；上游须保证非空且有足量字节，!无运行保护。跨块合并全部块，不只所需前缀，无IO。
	peek(length: number): Buffer {
		// 首块不足才合并，总量够不等于首块够。
		if (this.chunks[0]!.length < length) {
			// concat全部块为一块替换队列，buffered不变。
			this.chunks = [Buffer.concat(this.chunks)];
		}
		// 返回subarray视图，非对外独立快照。
		return this.chunks[0]!.subarray(0, length);
	}

	// 消费队首length字节并改计数/队列；例5字节块扣2保后3视图。依赖0<=length<=buffered，不额外校验，无IO。
	consume(length: number): void {
		// 先减总数，不改Buffer原字节。
		this.buffered -= length;
		// 剩余消费数大于0继续，0不进循环。
		while (length > 0) {
			// !来自上游足量不变量，不补空块。
			const first = this.chunks[0]!;
			// 首块全部落在消费范围时移除它。
			if (first.length <= length) {
				// shift去首引用，不清整队列。
				this.chunks.shift();
				// 扣此块长度，可能还需下一块。
				length -= first.length;
			} else {
				// 部分消费改成后缀视图，不复制余字节。
				this.chunks[0] = first.subarray(length);
				// 本地剩余设0，下一条件退出。
				length = 0;
			}
		}
	}
}

/**
 * One connection to a pi-env daemon: started lazily on the first request and started again after it is lost. Requests
 * in flight when it is lost fail with code `unknown`; for mutations their outcome is then unknown.
 */
// 连接按需启动/合并启动Promise、并发分发、心跳与下次请求重连。例new Connection({command:[daemon]}).info()；会起进程读写pipe，应用负责close。掉线后写结果可能未知，不自动重试已发业务。
export class Connection {
	// #是真正JS私有字段，readonly是TS约束；options仍原引用。
	readonly #options: ConnectionOptions;
	// 当前daemon可缺省，掉线不保旧句柄可用。
	#session: Session | undefined;
	// 共享在途/成功ready Promise，失败只清同次尝试。
	#ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
	// daemon启动编号从0起，spawn后递增。
	#sessions = 0;
	// 请求id从1起跨daemon递增，无u32回绕处理，超范围写头可抛。
	#nextId = 1;
	// 显式closed永久禁重启，与失联可重连不同。
	#closed = false;

	// 只存options，不spawn/探测SSH/发hello；首次使用才准备命令，外部对象未冻结。
	constructor(options: ConnectionOptions) {
		// 保存原选项引用，不深复制其数组/回调。
		this.#options = options;
	}

	/** Connect if needed and return what the daemon reported about its machine. */
	// 按需连接等hello再返回info；async返回Promise，失败拒绝，不验证每个RemoteInfo字段。
	async info(): Promise<RemoteInfo> {
		// await共享连接后取info，并发调用不各自开daemon。
		return (await this.#connect()).info;
	}

	/** Connect if needed and return the live session's id. */
	// 按需连接返回本地daemon代号，非发送名为session的操作。
	async session(): Promise<number> {
		// 取握手成功session.id，供句柄后续约束。
		return (await this.#connect()).session.id;
	}

	// 请求op/JSON/选项→会话门禁或连接→send→等终态。例lstat:/x；返回Reply或拒绝，不检查所有操作参数、不自动重放，取消仅通知。
	async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
		// 非undefined才绑定session，0也算显式要求。
		if (options.session !== undefined) {
			// 读当前session快照，不为旧句柄建新daemon。
			const current = this.#session;
			// 缺会话/代号不合/已拆都失败，防新daemon误解旧数字句柄。
			if (current === undefined || current.id !== options.session || !current.live) {
				// async里throw转Promise拒绝，附lost，不触发重连。
				throw lost("pi-env connection lost");
			}
			// 门禁过就send，async采用其结果，无需重复await。
			return this.#send(current, op, json, options);
		}
		// 普通请求才等连接，可能启动/复用/重启。
		const { session } = await this.#connect();
		// 成功后发，不在这里设每操作默认超时。
		return this.#send(session, op, json, options);
	}

	/** Stop the daemon; it kills everything it started. */
	// 永久关闭并同步拆当前会话，返回void不等待远端/系统确认全部子孙退出；daemon清理范围仍依其平台实现。
	close(): void {
		// 先禁未来启动，准备命令期间的#start后面也会看到closed。
		this.#closed = true;
		// 有session才teardown并拒绝在途；命令准备期尚无session可拆。
		if (this.#session) this.#teardown(this.#session, closed());
	}

	/** Kill one `exec` without aborting it. */
	// 按id/session发mode:kill，杀对应执行而不按abort结算；本地无确认/等待，不为它启动连接。
	kill(id: number, session: number): void {
		// 只取当前会话。
		const current = this.#session;
		// 匹配且live才发CANCEL，否则静默无操作，防误杀新daemon。
		if (current?.id === session && current.live) this.#write(current, frame(CANCEL, id, { mode: "kill" }));
	}

	// 共享启动器：closed拒绝、无ready才start并登记失败清理，返回同Promise；只让后续请求可重启，不立即重试原业务。
	#connect(): Promise<{ info: RemoteInfo; session: Session }> {
		// 关闭返回拒绝Promise，无spawn，不附lost标记。
		if (this.#closed) return Promise.reject(closed());
		// 只有尚无ready才新启动，已有成功或在途ready则复用。
		if (this.#ready === undefined) {
			// async #start先跑到首个await后返回Promise，同步异常也变拒绝。
			const ready = this.#start();
			// 保存此次Promise身份，旧失败不得清新ready。
			this.#ready = ready;
			// A failed start is not remembered: the next request tries again.
			// catch只安排清理，callback不重抛；原ready仍以原错误拒绝调用者。
			ready.catch(() => {
				// 同一尝试才清空，不让晚旧失败覆盖新状态。
				if (this.#ready === ready) this.#ready = undefined;
			});
		}
		// 返回在途/成功ready，不重新发送原请求。
		return this.#ready;
	}

	// 活会话分id→建Promise/pending→监听取消/通知→写帧→补已abort通知。例hello也走它；同步回调/序列化异常可拒绝，但无catch全面回滚已登记项。
	#send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
		// 不活就拒绝lost，不新增pending。
		if (!session.live) return Promise.reject(lost("pi-env connection lost"));
		// 后置++先用当前号再递增，非按op去重。
		const id = this.#nextId++;
		// 执行器同步运行，把结算闭包留Map，Promise等待后续回复。
		return new Promise((resolve, reject) => {
			// abort仅写CANCEL，不删pending/直接拒绝；死session写会被丢弃。
			const onAbort = () => this.#write(session, frame(CANCEL, id, {}));
			// done只移除此请求signal监听，不关连接。
			const done = () => options.signal?.removeEventListener("abort", onAbort);
			// 先登记再发送防快速回复；后续同步throw未在此立刻撤销Map项。
			session.pending.set(id, {
				// 成功结算先清监听。
				resolve: (value) => {
					// 防结束后再发多余cancel。
					done();
					// 原Reply交调用者，不再克隆json。
					resolve(value);
				},
				// 失败也先清监听，可能远端ERROR或连接统一故障。
				reject: (error) => {
					// 沿同一取消监听清理。
					done();
					// 以原Error拒绝，不转成功undefined。
					reject(error);
				},
				// onEvent真值才加字段，原函数引用不包装/等待异常结果。
				...(options.onEvent ? { onEvent: options.onEvent } : {}),
			});
			// 一次性abort事件；早已abort不会重发事件，末尾另查状态。
			options.signal?.addEventListener("abort", onAbort, { once: true });
			// REQUEST写出前报本地编号，非远端已执行确认；同步callback异常可拒绝Promise。
			options.onStart?.(id, session.id);
			// 后展开op覆盖json同名值，序列化后写stdin，payload另放原始字节。
			this.#write(session, frame(REQUEST, id, { ...json, op }, options.payload));
			// 已abort也先REQUEST后CANCEL，符合先登记再取消协议，不保证操作全没执行。
			if (options.signal?.aborted) onAbort();
		});
	}

	// live才把Buffer交stdin，返回void不等flush/远端确认；未按write(false)等drain，不能当已发送完成。
	#write(session: Session, data: Buffer): void {
		// 忽略背压布尔值，Node可能缓冲；死会话静默不写。
		if (session.live) session.child.stdin.write(data);
	}

	// 准备命令→spawn→接流/超时/心跳→hello竞速→检查protocol→返回；失败附尾诊断拆会话，finally清启动timer。会起进程，不完整验证hello或主机信任。
	async #start(): Promise<{ info: RemoteInfo; session: Session }> {
		// 只读argv变量在两分支赋值，未预设假命令。
		let command: readonly string[];
		// 此try仅包来源计算，非整个spawn/握手。
		try {
			// 取当前options.command原引用。
			const option = this.#options.command;
			// 函数才await，数组直接用，非逐项可信性验证。
			command = typeof option === "function" ? await option() : option;
			// 命令工厂可抛任意值。
		} catch (error) {
			// Error取message，其他String化；自定义String再抛未另catch。
			const message = error instanceof Error ? error.message : String(error);
			// 包装spawn_error/lost，本次失败留给下一请求可重试工厂，非原地无限重试。
			throw new RemoteError({ code: "spawn_error", message, lost: true });
		}
		// 准备中若关闭，拿到命令后不继续spawn。
		if (this.#closed) throw closed();
		// 首项程序/余项argv，空数组program缺省，不经shell分词。
		const [program, ...args] = command;
		// 只检缺program，不检空串/文件存在/每项合法；这错误无lost:true。
		if (program === undefined) throw new RemoteError({ code: "spawn_error", message: "No daemon command" });
		// 16字节转32位hex，只用于同步标记，非整套远端认证。
		const token = randomBytes(16).toString("hex");
		// 追加serve/--token/token后三stdio pipe直接spawn；SSH部署/主机密钥由命令工厂负责。
		const child = spawn(program, [...args, "serve", "--token", token], { stdio: ["pipe", "pipe", "pipe"] });
		// spawn返回即耗新会话号，握手失败也不回退编号。
		const session = new Session(++this.#sessions, child, token);
		// 设置当前session，使hello有pending可回。
		this.#session = session;
		// 局部ready用于诊断/退出时机，不等于live。
		let ready = false;
		// 保存启动timer句柄供finally清理，可缺省。
		let startTimer: ReturnType<typeof setTimeout> | undefined;
		// Promise<never>只拒绝，和hello竞速不是第二次业务请求。
		const failed = new Promise<never>((_resolve, reject) => {
			// 安排异步超时，不阻塞线程60秒。
			startTimer = setTimeout(
				// timeout先拒绝lost，race的catch再拆会话。
				() => reject(lost(`pi-env did not answer within ${START_TIMEOUT_MS / 1000} s`)),
				// 使用统一启动常量，非每请求超时。
				START_TIMEOUT_MS,
			);
			// 一次error监听记录无法spawn的原消息。
			child.once("error", (error) =>
				// spawn_error/lost区别于远端hello正常拒绝EINVAL。
				reject(new RemoteError({ code: "spawn_error", message: error.message, lost: true })),
			);
			// ready前close等stdio关闭便于收stderr；ready后晚拒绝这份Promise不改已完成race。
			child.once("close", (code) => reject(lost(`pi-env exited with code ${code} before it was ready`)));
		});
		// 先空catch防未处理拒绝，原Promise仍可在race拒绝，并非把它改成成功。
		failed.catch(() => {});
		// stdout分块交本Session解析，迟旧数据由live门禁丢。
		child.stdout.on("data", (chunk: Buffer) => this.#onData(session, chunk));
		// UTF-8流解码跨chunk保多字节字符，非每Buffer单独toString。
		child.stderr.setEncoding("utf8").on("data", (text: string) => {
			// ready前截末2000码元，可能切到代理中间，未额外修复截断字符。
			if (!ready) session.stderrTail = (session.stderrTail + text).slice(-STDERR_TAIL_CHARS);
			// onLog接原诊断含VT/控制；此处未catch回调，摘要过滤在别处。
			this.#options.onLog?.(text);
		});
		// 通用error拆会话，与一次启动error监听并存，teardown幂等。
		child.on("error", () => this.#teardown(session, lost("pi-env connection lost")));
		// A ready session fails as soon as the daemon exits, even while a process it started keeps a pipe open.
		// ready后exit立即失败，不等可能被子孙占住pipe的close。
		child.on("exit", () => {
			// 未ready时等close/error/timeout，尽量带收到的stderr。
			if (ready) this.#teardown(session, lost("pi-env connection lost"));
		});
		// close最终兜底，若exit已拆则无操作。
		child.on("close", () => this.#teardown(session, lost("pi-env connection lost")));
		// 吞stdin error事件，结算靠连接/进程失败或静默超时，不保证写失败立刻专属报错。
		child.stdin.on("error", () => {});
		// timer每5秒尝试PING并检查最近stdout接收墙钟。
		session.timer = setInterval(() => {
			// PING id0，无特定pending；死会话不写。
			this.#write(session, frame(PING, 0, {}));
			// 严格>30秒才超时，墙钟跳变/timer调度影响实际时点。
			if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS) {
				// 静默则lost拆连接拒绝在途，远端变更结果仍可能未知。
				this.#teardown(session, lost("pi-env connection timed out"));
			}
			// 这里只是客户端周期，非daemon端实现。
		}, PING_INTERVAL_MS);
		// unref不让此timer独自留住Node，不等于clearInterval或关闭pipe。
		session.timer.unref();
		// try从hello竞速开始，不包前面全部spawn/监听设置。
		try {
			// 发hello协议1与failed竞速，只取json不取payload；握手完成不代表进程退出。
			const { json } = await Promise.race([this.#send(session, "hello", { protocol: 1 }, {}), failed]);
			// 只严格接数值protocol1，字符串1也拒绝；未逐字段验os/路径等。
			if (json.protocol !== 1) throw lost(`Unsupported protocol ${json.protocol}`);
			// 握手成功，随后exit立即拆，不再截stderr尾。
			ready = true;
			// 丢启动尾缓存，onLog后续仍可接收。
			session.stderrTail = "";
			// 双重as只当RemoteInfo，不新增校验/复制，返回同Session。
			return { info: json as unknown as RemoteInfo, session };
			// hello拒绝/超时/协议错等进入失败收尾。
		} catch (error) {
			// Add the captured stderr to whatever ended the start; only a pre-ready exit waits for it to drain.
			// 按错误类别选择新/原错误，只有RemoteError分支拼stderr。
			const failure =
				// 识别本模块RemoteError，含远端错误或本地lost。
				error instanceof RemoteError
					? // 复制fields后覆盖带摘要message，保code/path/lost/extra，不脱敏秘密。
						new RemoteError({ ...error.fields, message: withStderr(error.message, session.stderrTail) })
					: // 其他Error走原对象分支。
						error instanceof Error
						? // 保原Error引用，不为它额外拼stderr。
							error
						: // 其余String后包lost，String再抛未另保护。
							lost(String(error));
			// 先拆会话/清pending/心跳，不等远端清理确认。
			this.#teardown(session, failure);
			// 重抛failure，外层#connect会清同ready供下次重启。
			throw failure;
			// 成功失败都清启动timer，非取消所有任务。
		} finally {
			// clearTimeout接受undefined，不必另分支。
			clearTimeout(startTimer);
		}
	}

	// 幂等拆Session：标死→清timer→仅当前清槽→end/kill→清pending逐个拒绝。同步不等进程退出、不回滚远端写入。
	#teardown(session: Session, error: Error): void {
		// 已拆返回，防error/exit/close重复处理。
		if (!session.live) return;
		// 先关live读写门禁，非系统已退出确认。
		session.live = false;
		// 停此会话心跳，不碰其他会话。
		clearInterval(session.timer);
		// 仅同一当前Session才清槽，旧失败不清新连接。
		if (this.#session === session) {
			// 断当前引用，旧句柄后续失败，不自动指新daemon。
			this.#session = undefined;
			// 清ready供下次普通操作重启，closed门禁仍优先。
			this.#ready = undefined;
		}
		// stdin.end可flush已缓冲再关，本代码不await，不确认daemon已收EOF。
		session.child.stdin.end();
		// kill默认SIGTERM发给直接child，返回值忽略；远端/子孙清理靠daemon/传输/平台，不凭此行保证全停。
		session.child.kill();
		// 复制pending值列表，后续清Map不丢待拒绝闭包。
		const pending = [...session.pending.values()];
		// 清索引不撤销已发生业务副作用。
		session.pending.clear();
		// 以同Error逐个reject，包装done清signal监听，Promise只结算一次。
		for (const request of pending) request.reject(error);
	}

	// 接stdout：门禁→积累→找同步行→循环完整帧→验JSON对象→复制payload→分发。半帧等待、坏帧拆连接，非执行具体远端操作。
	#onData(session: Session, chunk: Buffer): void {
		// 死会话数据丢掉，旧输出不污染新Session。
		if (!session.live) return;
		// 任意stdout字节刷新lastSeen，含噪声/PING，不仅合法业务结果。
		session.lastSeen = Date.now();
		// 追加Buffer引用，peek必要时再合并。
		session.chunks.push(chunk);
		// 累加字节数，非UTF-16长度。
		session.buffered += chunk.length;
		// 未同步前不把banner当长度头。
		if (!session.synced) {
			// Shell startup files may print before the daemon runs; skip everything before its sync line.
			// 标记含token和LF，跨块需保留可能前缀，不认证主机。
			const marker = Buffer.from(`PI-ENV ${session.token}\n`, "utf8");
			// 窥看全部缓冲，跨块concat，不立刻消费。
			const all = session.peek(session.buffered);
			// 按字节indexOf完整marker，不要求恰是行首。
			const index = all.indexOf(marker);
			// 没找到继续等下一data。
			if (index === -1) {
				// 噪声超1MiB才裁，防无标记无限积累，非MAX_FRAME限制。
				if (session.buffered > 1024 * 1024) {
					// 仅保marker长度尾部，仍可拼后续跨块标记。
					session.consume(session.buffered - marker.length);
				}
				// 未同步返回，不解析剩余噪声为JSON。
				return;
			}
			// 标记前noise转UTF-8再trim两端空白，未用withStderr控制过滤。
			const noise = all.subarray(0, index).toString("utf8").trim();
			// 非空交onLog，回调异常未统一catch。
			if (noise !== "") this.#options.onLog?.(noise);
			// 消费噪声和marker，不留它们作payload。
			session.consume(index + marker.length);
			// 开始按帧流解析，重启会新建未同步Session。
			session.synced = true;
		}
		// 至少4字节且live才读头，一chunk可有多帧，chunk边界非帧边界。
		while (session.live && session.buffered >= 4) {
			// 大端length含后续9字节头/JSON/payload，不含自身4字节。
			const length = session.peek(4).readUInt32BE(0);
			// wire边界实际检查length在9..16MiB。
			if (length < 9 || length > MAX_FRAME) {
				// 坏长度lost拆连接拒绝在途，不丢一帧后猜下个位置。
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				// 结束data处理，会话已死。
				return;
			}
			// 未收全4+length则保缓存等下一块，不提前parse半JSON。
			if (session.buffered < 4 + length) return;
			// 窥完整帧去掉length4字节，body仍视图。
			const body = session.peek(4 + length).subarray(4);
			// body偏移0是type，对应全帧偏移4。
			const type = body.readUInt8(0);
			// 偏移1是请求id。
			const id = body.readUInt32BE(1);
			// 偏移5是JSON字节长。
			const jsonLength = body.readUInt32BE(5);
			// json只在下面验证成功后赋字典。
			let json: Json;
			// try仅保护解析，后面应用回调不在内。
			try {
				// 固定9加JSON长超过帧就坏，不准越payload范围解JSON。
				if (9 + jsonLength > length) throw new Error("JSON length out of range");
				// 只解JSON区域UTF-8再parse为unknown；无效UTF-8可替换，未严格验证字节编码。
				const parsed: unknown = JSON.parse(body.subarray(9, 9 + jsonLength).toString("utf8"));
				// wire最外层必须非null非数组对象，是输入边界收窄。
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
					// 根类型错抛局部异常，后catch统一Corrupt frame。
					throw new Error("not an object");
				// 只断言外层字典，内部字段仍unknown，非完整每op协议校验。
				json = parsed as Json;
				// 解析/形状任一异常都拆，不随便归到某pending。
			} catch {
				// 用固定lost诊断，不附整个坏JSON正文。
				this.#teardown(session, lost("Corrupt frame from pi-env"));
				// 返回防未赋json继续分发。
				return;
			}
			// A plain Uint8Array copy, like `NodeExecutionEnv`'s reader results, not a view of the receive buffer.
			// new Uint8Array从视图复制独立payload，不让调用者改接收缓存。
			const payload = new Uint8Array(body.subarray(9 + jsonLength));
			// 先消费后回调，后面throw也不回滚已消费字节。
			session.consume(4 + length);
			// 按id/type分发可同步调用onEvent，无统一catch/await隔离它。
			this.#dispatch(session, type, id, json, payload);
		}
	}

	// EVENT只报进度，RESULT/ERROR删pending并结算，其他类型/未知id忽略。例多次输出后结果才结束；不验操作级字段。
	#dispatch(session: Session, type: number, id: number, json: Json, payload: Uint8Array): void {
		// 查当前会话pending，未知或已完id为undefined。
		const pending = session.pending.get(id);
		// EVENT不走终态删除。
		if (type === EVENT) {
			// 两层?.：无请求/无回调就忽略，有则同步调用，不等待返回Promise。
			pending?.onEvent?.(json, payload);
			// 事件后立即返回，保pending等终态。
			return;
		}
		// 只RESULT/ERROR进入结算，PING等静默忽略。
		if (type !== RESULT && type !== ERROR) return;
		// 未知id终态也忽略，不新建请求。
		if (pending === undefined) return;
		// 先删Map，重复终态后找不到项。
		session.pending.delete(id);
		// RESULT传原json/已复制payload/当前session包装Reply。
		if (type === RESULT) pending.resolve({ json, payload, session: session.id });
		// ERROR用json建RemoteError拒绝，不附error帧payload，字段由构造器摘取。
		else pending.reject(new RemoteError(json));
	}
}
