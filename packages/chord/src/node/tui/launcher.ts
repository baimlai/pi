// `startTerminal` (slice 11 §4, decision "Slice 11, P8"): the trusted launcher of a terminal client. It signs in with
// its token (given, from a file, or by pairing), downloads the terminal kind's base bundle and plugin scripts, and
// runs them in the sandbox, always. It keeps the credentials, the real terminal and the user's choices: the sandbox
// gets input and resizes, its frames pass the output filter, its Chord link is a socket the launcher opens and relays,
// its plugin script fetches go only to the terminal surface's files, and its actions on the machine (copy, open a URL,
// attach a file) are confirmed by the launcher's own prompt. A new base bundle on the server starts a new sandbox.
// Nothing the sandbox sends can end the launcher (fix round 2, Opus E3): its messages are checked (`pipe.ts`), a send
// on a socket not yet open is dropped, every buffer and the requests in flight are bounded, a signal cannot open the
// launcher's inspector, and however the launcher's process ends the terminal is given back (fix round 3, Opus E8,
// E10, E11). During a prompt Ctrl-C ends the client: its keys are the launcher's; and three Ctrl-C within a second
// always end it (Opus R2).

//
// 文件导读
// 所属：packages/chord 的 Node 终端启动器模块（node/tui），是终端客户端的受信任主控。
// 职责边界：运行在用户自己的 Node 进程里，持有 token、真实终端和用户选择；沙箱代码永远不在这里执行。
// 上游是应用调用 startTerminal；下游包括 credentials.ts（token）、sandbox.ts（子进程）、pipe.ts（帧协议）、
// filter.ts（输出过滤）、actions.ts（确认动作）、WebSocket 连接以及 stdin/stdout 流。成功结果是 RunningTerminal；
// 登录/下载/版本失败以 Promise 拒绝，运行期沙箱异常以退出码结束，不会让启动器进程崩溃。
// 能力清单：
// - TerminalOptions：启动选项（URL、凭据、输入输出、颜色、主题、opener）。
// - RunningTerminal：运行句柄，含 exited Promise 与 stop()。
// - terminalFile：把沙箱请求的路径限制在终端 surface 文件白名单内。
// - MAX_HELD/MAX_SOCKETS/MAX_SOCKET_BUFFER/MAX_REQUESTS：输出暂存、socket 数、发送缓冲、并发请求的上限。
// - PROMPT_GUARD_MS/INTERRUPT/INTERRUPTS_TO_END：确认提示的按键保护期与 Ctrl-C 强制退出规则。
// - RESET_MODES：退出时恢复终端模式的 ANSI 序列。
// - startTerminal：版本检查、取 token、创建 Launcher、启动并返回句柄。
// - Launcher（私有类）：start/finish、消息分发、socket 转发、请求响应、提示绘制与重启。
// - ignoreSignal：占据 SIGUSR1，阻止 Node 启动 inspector。
// 组合与顺序：startTerminal → tokenOf → Launcher.start → #startSandbox（GET start/script/combined）→ Sandbox.start
// → 接入输入/尺寸 → 消息循环 → finish（恢复终端、关 socket、终止沙箱）。重启路径是 outdated → #outdated → #restart。
// 示例：`const running = await startTerminal({ url, credentials }); process.exitCode = await running.exited;`
// 阅读顺序：先看两个类型与 startTerminal，再看 Launcher 的字段/#handle/#answer，然后 #write/#openSocket/#confirm。

// 只导入类型：Readable/Writable 在运行时不需要，擦除后无导入。
import type { Readable, Writable } from "node:stream";
// ws 提供 WebSocket 客户端；Node 内置 WebSocket 的 API 不完全一致，这里使用项目依赖。
import { WebSocket } from "ws";
// 颜色深度类型来自 surfaces 层。
import type { ColorDepth } from "../../surfaces/index.ts";
// 桥接协议：请求与沙箱消息的判别联合。
import type { BridgeRequest, SandboxMessage } from "../../tui/bridge.ts";
// 服务端下发的终端启动描述（base 哈希、脚本路径、combined 包路径等）。
import type { TuiStart } from "../surfaces/tui.ts";
// 动作确认与提示行生成。
import { act, attach, type PromptTerminal, promptLines } from "./actions.ts";
// 凭据来源与 token 获取。
import { type TerminalCredentials, tokenOf } from "./credentials.ts";
// 输出过滤器：沙箱输出与配对提示都经过它。
import { filterOutput } from "./filter.ts";
// 沙箱实现、bundle 大小上限和 Node 版本检查。
import { MAX_BUNDLE, requireSandboxNode, Sandbox } from "./sandbox.ts";

/** What `startTerminal` takes. */
// startTerminal 的选项。除 url/credentials 外都有默认值；可注入 input/output/opener 以便测试。
export type TerminalOptions = {
	/** The app's server (`http://127.0.0.1:8788`). */
	// 应用服务器地址，会规范化为 URL 对象。
	readonly url: string;
	// token 的来源（直接给出、文件或设备配对）。
	readonly credentials: TerminalCredentials;
	/** The terminal's input and output: the process's by default (raw mode while running, when a TTY). */
	// 输入流：需要 setRawMode 时进入原始模式；isTTY 用于判断是否真的连接终端。
	// 交叉类型 `Readable & {...}` 表示既是可读流，又可能带这些终端方法；方法用可选是因为管道输入没有它们。
	readonly input?: Readable & { setRawMode?(raw: boolean): unknown; readonly isTTY?: boolean };
	// 输出流：columns/rows 用于布局；同样可选，因为非 TTY 环境可能没有。
	readonly output?: Writable & { readonly columns?: number; readonly rows?: number };
	/** How many colours the terminal shows: true colour when `COLORTERM` says so, else 256. */
	// 颜色深度；未指定时根据 COLORTERM 环境变量推断。
	readonly colors?: ColorDepth;
	/** The terminal's background, choosing between the user's dark and light theme: dark by default. */
	// 深色/浅色主题选择，默认 dark。
	readonly mode?: "dark" | "light";
	/** Opens a URL the user confirmed: the platform's opener by default. */
	// 打开浏览器的实现，默认用平台命令；测试可注入。
	readonly opener?: (url: string) => Promise<void>;
};

/** A running terminal client: its exit code once it ends, and its stop. */
// 返回给应用的句柄：exited 在客户端结束时给出退出码；stop 请求正常结束（退出码 0）。
// `readonly` 只防止重新赋值属性，不冻结 Promise 或对象。
export type RunningTerminal = { readonly exited: Promise<number>; stop(): Promise<void> };

/** The terminal surface's files (the server's `TUI_PREFIX`). */
// 终端 surface 在服务器上的固定路径前缀；start/base 和插件文件都在它下面。
const PREFIX = "/_chord/tui/";

/**
 * `path` resolved on the server `server` when it names one of the terminal surface's files (dot segments and encodings
 * resolved first: Opus M2, Fable L1); throws otherwise: the sandbox reaches nothing else of the server through the
 * launcher's token.
 */
// 把沙箱请求的路径解析成终端 surface 内的服务器路径；不在白名单内就抛错。
// 这是信任边界：path 来自沙箱，类型是 unknown，先确认是字符串，再用 URL 解析（相对路径基于 server）。
// new URL 会自动解析 `.`/`..` 和百分号编码，因此必须用解析后的 pathname 做白名单匹配，防止 `../` 逃逸。
// 检查项：同源（不能指向别的服务器）、无查询串（避免把参数带进请求）、pathname 匹配 TERMINAL_FILE。
// 返回 pathname（不是完整 URL），供 #get 拼接；调用方随后用启动器的 token 发请求。
// 例子：server=https://app.test，path="plugin/a.js" 返回 "/_chord/tui/plugin/a.js"；path="../secret" 抛错。
export function terminalFile(path: unknown, server: URL): string {
	// 非字符串直接视为无效；字符串才尝试解析（URL 构造可能抛错，但这里给了 base，通常不会）。
	const target = typeof path === "string" ? new URL(path, server) : undefined;
	if (
		target === undefined ||
		// 源包括协议、主机和端口；不同源意味着沙箱想把 token 发到别处。
		target.origin !== server.origin ||
		// 查询串一律不允许，保持请求路径纯粹。
		target.search !== "" ||
		// 正则只允许 /_chord/tui/ 下（可选的 plugin/）由字母数字、下划线、点、波浪号、@、连字符组成的单段文件名。
		!TERMINAL_FILE.test(target.pathname)
	) {
		throw new Error("terminal: no terminal file");
	}
	return target.pathname;
}

/** A terminal surface file's path, as the sandbox may ask for it. */
// 终端文件路径白名单：可选 plugin/ 子目录，文件名不含斜杠，因此不能穿越目录；`\w` 含字母数字和下划线。
const TERMINAL_FILE = /^\/_chord\/tui\/(?:plugin\/)?[\w.~@-]+$/;

/** The most frames held while a prompt is open: 1 MiB (characters); later ones are dropped. */
// 提示打开期间暂停向真实终端写入沙箱输出，先放进 #held；总量上限 1 MiB，超出部分直接丢弃，防止内存膨胀。
const MAX_HELD = 1024 * 1024;

/** The most link sockets the sandbox may have open at once. */
// 沙箱同时最多 4 个 Chord 链接 socket；连接循环通常只需 1 个，限制失控沙箱。
const MAX_SOCKETS = 4;

/** The most bytes a link socket may have waiting to go out; a sandbox sending more loses the socket. */
// 单个 socket 的发送缓冲上限 16 MiB；超过就 terminate，避免内存被慢速/恶意对端拖垮。
const MAX_SOCKET_BUFFER = 16 * 1024 * 1024;

/** How long after a prompt appears its keys are ignored: a key typed for the sandbox does not answer it (Opus E4). */
// 提示出现后的 300ms 内忽略按键：用户原本打给沙箱的键（例如回车）不会误答确认框。
const PROMPT_GUARD_MS = 300;

/**
 * The terminal modes the sandbox may have set, back to the shell's: sync, mouse, focus, paste, cursor, the scroll region
 * (the cursor kept where it was) and autowrap (Opus E11), screen, colours.
 */
// 退出时发送的一串 ANSI 序列，按顺序恢复终端到 shell 状态：
// 关闭同步输出(2026l)、鼠标(1000/1002/1006l)、焦点事件(1004l)、括号粘贴(2004l)、显示光标(25h)、
// 保存光标(ESC 7)、重置滚动区域([r)、恢复光标(ESC 8)、打开自动换行(7h)、离开备用屏幕(1049l)、重置样式(0m)。
// 这些序列由启动器直接写入，不经过沙箱输出过滤器；沙箱无法伪造它们。
const RESET_MODES =
	"\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8\x1b[?7h\x1b[?1049l\x1b[0m";

/** The most requests of one sandbox the launcher answers at once; more are refused at once (Opus E10). */
// 每个沙箱最多 8 个并发请求；超出的立即回 refused，避免请求堆积消耗内存或文件描述符。
const MAX_REQUESTS = 8;

/**
 * Ctrl-C: during a prompt it ends the client, so a sandbox asking again and again can always be left (Opus E11); and
 * three within a second always end it, whatever the sandbox does with them (Opus R2).
 */
// Ctrl-C 的字节值是 0x03。提示打开时它直接结束客户端，保证用户总能退出不断弹提示的沙箱；
// 一秒内三次则无论沙箱如何处理都结束（防止沙箱吞掉中断）。
const INTERRUPT = "\x03";

/** How many Ctrl-C within `INTERRUPT_WINDOW_MS` end the client however the sandbox takes them. */
// 窗口内达到 3 次 Ctrl-C 就强制结束；窗口长度 1 秒。
const INTERRUPTS_TO_END = 3;
const INTERRUPT_WINDOW_MS = 1000;

/** Starts a terminal client; rejects when it cannot sign in or download, or Node is too old for the sandbox. */
// 启动终端客户端的主入口：完成版本检查、取 token、创建 Launcher、下载并启动沙箱，返回运行句柄。
// 输入：TerminalOptions；输出：RunningTerminal（exited Promise 与 stop）。
// 副作用：可能发起配对网络请求、打印配对提示、启动子进程、接管 stdin/stdout。
// 错误：Node 版本不足、登录/下载失败时 Promise 拒绝；此时不会返回句柄。
// 例子：`const t = await startTerminal({url, credentials:{kind:"token",token}}); const code = await t.exited;`
// 注意 abort 控制器目前只用于配对流程；start 完成后若需要取消，应调用 stop。
export async function startTerminal(options: TerminalOptions): Promise<RunningTerminal> {
	// 沙箱依赖 Node 权限模型等新特性，版本不够直接抛错，不进入半初始化状态。
	requireSandboxNode();
	// 默认写进程标准输出；注入的 output 主要用于测试或嵌入。
	const output = options.output ?? process.stdout;
	// 规范化服务器地址；非法 URL 会在这里抛 TypeError。
	const url = new URL(options.url);
	// 配对阶段的中止信号；用户按 Ctrl-C 时（进程信号）可由调用方中止。
	const abort = new AbortController();
	// What the launcher prints of the server's (the pairing's code) passes the output filter too.
	// 即使是启动器自己打印的服务器文本，也经过 filterOutput：配对码等仍来自网络，不能直接信任其转义序列。
	// 末尾 `\r\n` 保证在原始模式终端中也换行。
	const token = await tokenOf(
		options.credentials,
		url,
		(line) => output.write(`${filterOutput(line)}\r\n`),
		abort.signal,
	);
	// Launcher 持有 token、输入输出和选项；它不会把 token 传给沙箱。
	const launcher = new Launcher(url, token, options);
	// 下载并启动沙箱、接管终端；失败会拒绝，由调用方处理。
	await launcher.start();
	// 只暴露退出 Promise 和停止函数，不泄露内部状态。
	return { exited: launcher.exited, stop: () => launcher.finish(0) };
}

/** One terminal client's launcher. */
// 单个终端客户端的内部状态机。应用只拿 RunningTerminal，不直接接触这个类。
// 实例生命周期：start() 一次；之后处理输入/沙箱消息；finish() 幂等，多次调用只有第一次生效。
// 私有字段用 #，运行时不可从外部访问；字段大多 readonly，表示构造后不再重新赋值（内容仍可变）。
class Launcher {
	// 服务器地址与带 Bearer token 的请求头；headers 是只读记录类型，防止意外改键。
	readonly #url: URL;
	readonly #headers: Readonly<Record<string, string>>;
	// 完整选项，保留 opener/colors/mode 等注入值。
	readonly #options: TerminalOptions;
	// NonNullable<...> 去掉可选性并排除 undefined：构造后一定有值。
	readonly #input: NonNullable<TerminalOptions["input"]>;
	readonly #output: NonNullable<TerminalOptions["output"]>;
	// 沙箱侧的 socket 编号 → 启动器建立的 WebSocket；编号由沙箱分配，仅作为映射键。
	readonly #sockets = new Map<number, WebSocket>();
	// 当前沙箱；重启期间可能短暂为 undefined。
	#sandbox: Sandbox | undefined;
	/** The running base bundle's hash: an `outdated` sandbox restarts only for another. */
	// 当前运行 bundle 的哈希；收到 outdated 时先比较服务器哈希，相同则不重启（避免循环）。
	#base = "";
	/**
	 * Whether an action is being confirmed (one at a time), from its request to its end: meanwhile the sandbox's frames
	 * are held (`#held`, at most `MAX_HELD` bytes), so nothing draws over the prompt, even before it appears.
	 */
	// 是否有确认动作正在进行；期间沙箱帧被暂存，防止覆盖提示。
	#confirming = false;
	/** The running sandbox's requests being answered (at most `MAX_REQUESTS`). */
	// 正在处理的请求计数；计数归零不代表没有排队，Node 异步执行中由事件循环串行推进。
	#requests = 0;
	/** The prompt open: its lines, its answer, and when its keys start to count. Keys go to it, not the sandbox. */
	// 当前打开的提示：显示行、resolve 答案的回调、按键开始生效的时间戳。
	// 联合类型末尾的 `| undefined` 表示没有提示。
	#prompt:
		| { readonly lines: readonly string[]; readonly answer: (yes: boolean) => void; readonly ready: number }
		| undefined;
	// 提示期间暂存的沙箱输出帧与总字符数。
	#held: string[] = [];
	#heldBytes = 0;
	// finish 幂等标志；一旦为 true，后续调用直接返回。
	#finished = false;
	// 明确赋值断言 `!`：Promise 执行器同步运行，构造期间必定给 #exit 赋值，TypeScript 无法推断这一点。
	#exit!: (code: number) => void;
	// 对外暴露的退出 Promise；resolve 后值不再变化。
	readonly exited = new Promise<number>((resolve) => {
		this.#exit = resolve;
	});
	// 输入回调用箭头函数保存 this；data 可能是 Buffer（默认）或字符串（注入流）。
	// 处理顺序：先检查连续 Ctrl-C 强制结束 → 无提示则转发给沙箱 → 提示中且含 Ctrl-C 则结束 →
	// 提示已过保护期则把 y/Y 作为肯定答案（其他任意键都算否定）。
	readonly #onInput = (data: Buffer | string): void => {
		const text = data.toString();
		if (this.#interrupted(text)) {
			// void 表示不等待异步 finish；退出码 130 是 shell 惯例的 SIGINT。
			void this.finish(130);
			return;
		}
		if (this.#prompt === undefined) this.#sandbox?.post({ kind: "input", data: text });
		else if (text.includes(INTERRUPT)) void this.finish(130);
		else if (Date.now() >= this.#prompt.ready) this.#answered(text === "y" || text === "Y");
	};
	// 终端尺寸变化：提示打开时重绘（保持贴底），同时把新尺寸告诉沙箱。
	readonly #onResize = (): void => {
		if (this.#prompt !== undefined) this.#drawPrompt();
		this.#sandbox?.post({ kind: "resize", columns: this.#columns, rows: this.#rows });
	};
	/** When the last Ctrl-C keys came: three within a second end the client. */
	// 时间戳数组，只保留最近一秒内的 Ctrl-C。
	#interrupts: number[] = [];
	/** The terminal given back if the launcher's process ends without `finish` (a crash). */
	// 进程 exit 钩子：即使没走 finish，也恢复终端模式和光标。这里只能同步写，不能 await。
	readonly #onExit = (): void => {
		this.#output.write(RESET_MODES);
		if (this.#input.isTTY === true) this.#input.setRawMode?.(false);
	};

	// 构造函数只保存依赖，不产生 I/O；真正的网络与子进程工作在 start()。
	constructor(url: URL, token: string, options: TerminalOptions) {
		this.#url = url;
		// token 只放进请求头，不进入沙箱桥接数据。
		this.#headers = { authorization: `Bearer ${token}` };
		this.#options = options;
		// `??` 只在 null/undefined 时回退；空字符串等假值会被保留。
		this.#input = options.input ?? process.stdin;
		this.#output = options.output ?? process.stdout;
	}

	/** Whether `text` brings the third Ctrl-C within a second (each still goes to the sandbox otherwise). */
	// 统计一秒内收到的 Ctrl-C；达到 3 个返回 true。否则返回 false，按键仍会正常转发。
	// 实现：把本次文本里的每个 Ctrl-C 都记为 now，过滤掉窗口外的时间戳，再判断数量。
	// 例子：连续三次输入 "\x03"（间隔 <1s）→ 第三次返回 true。
	#interrupted(text: string): boolean {
		const now = Date.now();
		// for...of 按码点遍历；输入可能是多个字符粘在一起。
		for (const character of text) if (character === INTERRUPT) this.#interrupts.push(now);
		// 只保留窗口内记录，数组不会无限增长。
		this.#interrupts = this.#interrupts.filter((at) => now - at < INTERRUPT_WINDOW_MS);
		return this.#interrupts.length >= INTERRUPTS_TO_END;
	}

	// A pseudo-terminal may report 0 (Opus E4).
	// 列数：某些伪终端报告 0，使用 `||` 回退到 80（注意这里 0 被视为假值，正是想要的行为）。
	get #columns(): number {
		return this.#output.columns || 80;
	}

	// 行数同理，回退 24。
	get #rows(): number {
		return this.#output.rows || 24;
	}

	/** Downloads the base bundle and the plugins, starts the sandbox and takes the terminal. */
	// 启动流程：先创建沙箱（下载 + 启动子进程），再进入原始模式、挂接输入/尺寸/退出钩子。
	// 顺序很重要：下载失败时不应把终端切到原始模式。
	// 副作用：网络、子进程、流监听、进程信号监听。返回 Promise 在准备完成后 resolve。
	async start(): Promise<void> {
		await this.#startSandbox();
		// 只有真实 TTY 才切原始模式；可选链避免非 TTY 流没有 setRawMode。
		if (this.#input.isTTY === true) this.#input.setRawMode?.(true);
		// 监听输入与尺寸；回调都是箭头函数，this 绑定到实例。
		this.#input.on("data", this.#onInput);
		this.#output.on("resize", this.#onResize);
		// once：进程退出时只执行一次恢复逻辑。
		process.once("exit", this.#onExit);
		// Node opens its inspector on SIGUSR1 unless the signal has a listener: a sandbox may signal its launcher, and
		// an inspector would give any local process the launcher's token and files (Opus E8). Windows has no SIGUSR1.
		// 注册一个空监听器，阻止 Node 因 SIGUSR1 启动 inspector（否则本机任意进程可借此读取 token 与文件）。
		if (process.platform !== "win32") process.on("SIGUSR1", ignoreSignal);
	}

	/** Ends the client with `code`: the terminal given back, the sockets closed, the sandbox ended. */
	// 幂等结束：恢复终端、移除监听、关闭 socket、终止沙箱，最后 resolve exited。
	// 先设置 #finished，避免重入时重复清理；所有清理都尽量执行，不因某一步失败而跳过后续。
	// 错误：terminate 失败会让 finish 拒绝，但 exited 仍会在 terminate 之后 resolve（若 terminate 抛则不会执行到 #exit）。
	async finish(code: number): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		// off 是 removeListener 的别名；即使监听器不存在也不会报错。
		this.#input.off("data", this.#onInput);
		this.#output.off("resize", this.#onResize);
		process.off("exit", this.#onExit);
		if (process.platform !== "win32") process.off("SIGUSR1", ignoreSignal);
		if (this.#input.isTTY === true) this.#input.setRawMode?.(false);
		// 若提示仍打开，以否定答案解除等待，防止调用方永久挂起。
		this.#prompt?.answer(false);
		this.#prompt = undefined;
		// 直接写恢复序列（不经沙箱过滤器，因为这是启动器自己的可信输出）。
		this.#output.write(RESET_MODES);
		this.#closeSockets();
		// 可选链：沙箱可能尚未创建或已重启清空。
		await this.#sandbox?.terminate();
		// resolve 退出 Promise，应用可据此继续。
		this.#exit(code);
	}

	/** A new sandbox with what the server serves now. */
	// 向服务器下载启动描述、bundle 源码与 combined 包，组装 bridge，然后启动沙箱子进程。
	// 输入：无（使用实例的 URL/token/选项）。输出：无；成功后设置 #sandbox 与 #base。
	// 副作用：两个并行 GET、读取环境变量、启动子进程。错误：GET 失败、JSON 非法、沙箱启动失败都会拒绝。
	// 例子：服务器返回 start.script="/_chord/tui/base.js"，则下载该脚本作为沙箱入口源码。
	async #startSandbox(): Promise<void> {
		// JSON.parse 的结果运行时不可信；这里用 `as TuiStart` 只做编译期断言，字段随后被直接使用。
		// 若服务器返回畸形数据，后续使用会抛错并向上传播，由调用方结束启动。
		const start = JSON.parse(await this.#get(`${PREFIX}start`)) as TuiStart;
		// 两个下载互不依赖，用 Promise.all 并行；解构得到 [源码, combined 包文本]。
		const [source, combined] = await Promise.all([this.#get(start.script), this.#get(start.combined)]);
		// 记录 bundle 哈希，用于 outdated 时判断服务器是否真的换了版本。
		this.#base = start.base;
		// 颜色能力：显式选项优先；否则检查 COLORTERM 是否声明 truecolor/24bit；都不满足则 256 色。
		// `process.env.COLORTERM ?? ""` 处理未设置环境变量的情况。
		const colors =
			this.#options.colors ?? (/truecolor|24bit/.test(process.env.COLORTERM ?? "") ? "truecolor" : "256");
		// 传给沙箱的初始描述。`as const` 让字段成为字面量类型（readonly），便于 Sandbox.start 的类型检查。
		const bridge = {
			base: start.base,
			combined,
			columns: this.#columns,
			rows: this.#rows,
			colors,
			mode: this.#options.mode ?? "dark",
		} as const;
		// 新沙箱从 0 开始计请求。
		this.#requests = 0;
		// Sandbox.start 返回已启动的句柄；两个回调：
		// - message：沙箱发来的每条已校验消息；
		// - 第二个回调在沙箱异常结束时调用 finish(1)。
		this.#sandbox = await Sandbox.start(
			source,
			bridge,
			(message) => this.#message(message),
			() => void this.finish(1),
		);
	}

	/** One message of the sandbox; one the launcher fails on ends the client, never the launcher's process. */
	// 消息入口：捕获处理过程中的任何异常，转为结束客户端。沙箱不能通过畸形消息让启动器进程崩溃。
	// 注意 #handle 中有些分支启动异步任务（如 #answer），它们的错误各自处理，不经过这个 try。
	#message(message: SandboxMessage): void {
		try {
			this.#handle(message);
		} catch {
			// 不打印详细错误，避免把内部路径等信息展示给用户；直接以退出码 1 结束。
			void this.finish(1);
		}
	}

	// 按 kind 分发沙箱消息。每个分支 return，防止意外贯穿（虽然 switch 每个 case 都有 return 或隐式结束）。
	// 该方法是同步的；需要异步的操作用 void 启动并在内部自行捕获错误。
	#handle(message: SandboxMessage): void {
		switch (message.kind) {
			case "write":
				this.#write(message.data);
				return;
			case "socket_open":
				this.#openSocket(message.socket);
				return;
			case "socket_send":
				this.#send(message.socket, message.bytes);
				return;
			case "socket_close":
				// 可选链：找不到编号就什么也不做。
				this.#sockets.get(message.socket)?.close();
				return;
			case "request":
				// 不 await：避免阻塞后续消息；#answer 内部有并发上限与错误处理。
				void this.#answer(message.id, message.request);
				return;
			case "outdated":
				void this.#outdated();
				return;
			case "failed":
				// 沙箱启动失败：先写一行提示（固定字符串，无沙箱输入），再结束。
				this.#output.write("terminal: the terminal client failed to start\n");
				void this.finish(1);
				return;
			case "exit":
				// 采用沙箱报告的退出码（已在 pipe.ts 中校验为安全整数）。
				void this.finish(message.code);
		}
	}

	/** Writes the sandbox's frame through the output filter (held while a prompt is open); one over 64 KiB is dropped. */
	// 沙箱输出先过滤再写真实终端。确认动作进行中则暂存，等提示关闭后按顺序重放，避免覆盖提示。
	// 暂存上限 MAX_HELD：超出的帧直接丢弃（宁可少画一帧，也不能无限占内存）。
	// filterOutput 对超长帧抛 RangeError，这里吞掉该帧；沙箱不能借此结束客户端。
	#write(data: string): void {
		if (this.#confirming) {
			// 再次检查 typeof：虽然类型是 string，这里保留了运行时防御（消息已由 pipe 校验过，此检查是冗余的）。
			if (typeof data === "string" && this.#heldBytes + data.length <= MAX_HELD) {
				this.#held.push(data);
				this.#heldBytes += data.length;
			}
			return;
		}
		try {
			this.#output.write(filterOutput(data));
		} catch {
			// Over 64 KiB (or no text): dropped, as an escape it could hide would be.
			// 空 catch：丢弃即可，不影响其他帧。
		}
	}

	/** Opens socket `socket` to the links endpoint with the launcher's token, relaying it to the sandbox. */
	// 由启动器代表沙箱建立到 /chord 的 WebSocket，并双向转发。
	// 沙箱只拿到编号和字节，不接触 token；服务端只认识启动器的凭据。
	// socket 数量超过 MAX_SOCKETS 时立即回 socket_closed，让沙箱的连接循环知道失败。
	// 副作用：WebSocket 连接、事件监听、向沙箱 post 消息。
	#openSocket(socket: number): void {
		// A few at a time: the connection loop needs one; a runaway sandbox gets no more.
		if (this.#sockets.size >= MAX_SOCKETS) {
			this.#sandbox?.post({ kind: "socket_closed", socket });
			return;
		}
		// 基于服务器地址构造 /chord；new URL 会保留主机与端口。
		const target = new URL("/chord", this.#url);
		// http→ws、https→wss，保持加密属性。
		target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
		// 请求头带 Bearer token；WebSocket 构造是异步的，事件在后续触发。
		const ws = new WebSocket(target, { headers: this.#headers });
		// 先登记再挂事件：closed 回调需要能通过编号找回这个 ws。
		this.#sockets.set(socket, ws);
		ws.on("open", () => this.#sandbox?.post({ kind: "socket_opened", socket }));
		// data 是 Buffer；转成 Uint8Array 视图（不复制）后交给沙箱。
		ws.on("message", (data: Buffer) => {
			this.#sandbox?.post({ kind: "socket_message", socket, bytes: new Uint8Array(data) });
		});
		// close 与 error 共用一个清理函数；通过身份比较防止旧 ws 的事件误删同编号的新连接。
		const closed = (): void => {
			if (this.#sockets.get(socket) !== ws) return;
			this.#sockets.delete(socket);
			this.#sandbox?.post({ kind: "socket_closed", socket });
		};
		ws.on("close", closed);
		ws.on("error", closed);
	}

	/**
	 * Sends `bytes` on socket `socket` once it is open (before, the sandbox's link holds its messages; a send then is
	 * dropped: Opus E3); a socket with more than 16 MiB waiting is closed.
	 */
	// 仅在 WebSocket 处于 OPEN 时发送；连接尚未建立时静默丢弃（上层连接逻辑会重试）。
	// 若缓冲加上本次数据超过 16 MiB，直接 terminate，防止慢速对端导致内存无限增长。
	#send(socket: number, bytes: Uint8Array): void {
		const ws = this.#sockets.get(socket);
		// `ws?.readyState !== WebSocket.OPEN`：undefined 或 CONNECTING/CLOSING/CLOSED 都返回。
		if (ws?.readyState !== WebSocket.OPEN) return;
		if (ws.bufferedAmount + bytes.length > MAX_SOCKET_BUFFER) ws.terminate();
		else ws.send(bytes);
	}

	/** Answers the sandbox's request `id`. */
	// 处理一个沙箱能力请求：fetch/base 直接下载；attach/copy/open 先经用户确认。
	// 输入：请求编号 id（用于响应配对）与已校验的 BridgeRequest；输出：无，结果通过 sandbox.post 回传。
	// 并发：最多 MAX_REQUESTS 个在途，超出立即 refused。
	// 错误：任何异常都转成 refused 消息，包含错误文本；绝不因请求失败结束客户端。
	// 竞态：先保存当前 sandbox 引用，重启后旧请求的回复不会发给新沙箱。
	async #answer(id: number, request: BridgeRequest): Promise<void> {
		// The sandbox that asked: a reply never goes to the one a restart started meanwhile.
		const sandbox = this.#sandbox;
		if (sandbox === undefined) return;
		if (this.#requests >= MAX_REQUESTS) {
			sandbox.post({ kind: "refused", id, message: "terminal: too many requests at once" });
			return;
		}
		// 计数在 try 之外递增，保证 finally 能配对递减。
		this.#requests++;
		try {
			// value 的静态类型是 unknown：不同分支产生字符串、JSON 值、null 或布尔。
			let value: unknown;
			// fetch：terminalFile 做路径白名单，返回 pathname，再用 token 下载文本。
			if (request.kind === "fetch") value = await this.#get(terminalFile(request.path, this.#url));
			// base：下载 base 端点并解析 JSON；内容来自服务器，但仍按 unknown 交给桥接层。
			else if (request.kind === "base") value = JSON.parse(await this.#get(`${PREFIX}base`));
			// attach 特殊：成功时发送独立的 attached 消息（携带二进制 body），而不是 reply。
			else if (request.kind === "attach") {
				const file = await this.#confirm(() => attach(request.path, this.#prompter()));
				if (file !== null) {
					sandbox.post({ kind: "attached", id, name: file.name, bytes: file.bytes });
					return;
				}
				// 用户取消：回传 null，让沙箱知道没有文件，而不是“拒绝”。
				value = null;
				// copy/open 共用一个 act 调用；request 在此分支已被收窄为这两种。
			} else value = await this.#confirm(() => act(request, this.#prompter(), this.#options.opener));
			sandbox.post({ kind: "reply", id, value });
		} catch (error) {
			// instanceof 收窄 Error；非 Error 的抛出值用 String 转换，保证 message 字段是字符串。
			sandbox.post({ kind: "refused", id, message: error instanceof Error ? error.message : String(error) });
		} finally {
			// 只有在沙箱未被替换时才递减；新沙箱的 #requests 已在 #startSandbox 中重置为 0，
			// 若旧请求此时递减会把新沙箱的计数减成负数。
			if (this.#sandbox === sandbox) this.#requests--;
		}
	}

	/**
	 * Runs the action `run` (it asks the user), one at a time: a second is refused while one runs. Afterwards the held
	 * frames are written and the sandbox asked to redraw.
	 */
	// 串行化用户确认：同一时刻只允许一个提示。第二个并发请求直接抛错（由 #answer 转成 refused）。
	// 泛型 T 表示被包装动作的返回值类型；finally 保证无论成功/失败都解除标记并重放暂存帧。
	// 重放时调用 #write（此时 #confirming 已为 false）；最后发 resize 让沙箱重绘，避免提示覆盖后留下空白。
	async #confirm<T>(run: () => Promise<T>): Promise<T> {
		if (this.#confirming) throw new Error("terminal: a prompt is open");
		this.#confirming = true;
		try {
			return await run();
		} finally {
			this.#confirming = false;
			// 先取出并清空暂存，防止重放过程中又写入新帧造成顺序混乱。
			const held = this.#held;
			this.#held = [];
			this.#heldBytes = 0;
			for (const frame of held) this.#write(frame);
			// 请求沙箱按当前尺寸重绘。
			this.#sandbox?.post({ kind: "resize", columns: this.#columns, rows: this.#rows });
		}
	}

	/** The launcher's own prompt on the real terminal, for the action being confirmed: its key not the sandbox's. */
	// 构造 PromptTerminal 适配器：把 actions.ts 的提问接口接到真实终端和 #prompt 状态。
	// columns 是当前列数；ask 若换行后行数放不下就拒绝（提示必须完整显示，绝不截断）；
	// write 直接写终端（用于 OSC 52 剪贴板等启动器可信序列）。
	// 返回的对象方法都是箭头函数，保留 Launcher 的 this。
	#prompter(): PromptTerminal {
		return {
			columns: this.#columns,
			ask: (lines) => {
				// Shown whole or not at all: a prompt is never cut.
				// `>=` 而非 `>`：最后一行问题后还需留一行给用户输入/光标。
				if (promptLines(lines, this.#columns).length >= this.#rows) {
					return Promise.reject(new Error("terminal: the prompt does not fit the terminal"));
				}
				// 创建一个直到用户作答才 resolve 的 Promise；answer 回调保存到 #prompt，#answered 时调用。
				return new Promise<boolean>((answer) => {
					this.#prompt = { lines, answer, ready: Date.now() + PROMPT_GUARD_MS };
					this.#drawPrompt();
				});
			},
			write: (data) => this.#output.write(data),
		};
	}

	/**
	 * Draws the open prompt on the bottom lines after closing a synchronized update the sandbox began: its attributes
	 * reset and its colours explicit, black on white, so no state the sandbox left (concealed, black on black: Opus E4)
	 * applies to it.
	 */
	// 在终端底部绘制提示：先关闭沙箱可能开启的同步更新，保存光标，然后逐行定位、清行、设置黑字白底并写入。
	// 使用 `!` 非空断言：调用方（#prompter/#onResize）都保证此时 #prompt 存在。
	// top 至少为 1（终端行号从 1 开始）；lines.length 为换行后的实际行数。
	// 每条绘制序列：移动到 (top+index, 1) → 重置样式 → 设 30;47（黑字白底）→ 清除整行 → 文本前后各留一个空格。
	#drawPrompt(): void {
		const lines = promptLines(this.#prompt!.lines, this.#columns);
		const top = Math.max(1, this.#rows - lines.length + 1);
		const drawn = lines.map((line, index) => `\x1b[${top + index};1H\x1b[0;30;47m\x1b[2K ${line} `);
		// `\x1b[s` 保存光标；绘制完成后重置样式，但暂不恢复光标（提示显示期间光标位置由绘制决定）。
		this.#output.write(`\x1b[?2026l\x1b[s${drawn.join("")}\x1b[0m`);
	}

	/** The prompt answered: cleared, the cursor back where the sandbox had it. */
	// 收起提示：清除提示占用的每一行，恢复保存的光标位置，然后 resolve 提问 Promise。
	// 先置空 #prompt，防止 answer 触发的后续异步逻辑再次操作已关闭的提示。
	#answered(yes: boolean): void {
		const { lines, answer } = this.#prompt!;
		this.#prompt = undefined;
		const rows = promptLines(lines, this.#columns);
		const top = Math.max(1, this.#rows - rows.length + 1);
		// `_row` 表示不使用行内容，只需行数；每条序列定位、重置样式、清行。
		const cleared = rows.map((_row, index) => `\x1b[${top + index};1H\x1b[0m\x1b[2K`).join("");
		// `\x1b[u` 恢复之前保存的光标位置，把屏幕还给沙箱。
		this.#output.write(`${cleared}\x1b[u`);
		answer(yes);
	}

	/** The sandbox says its code is outdated: a new sandbox only when the server's base bundle is another. */
	// 沙箱报告自己的代码过期时调用：向服务器查询当前 base 哈希，只有确实不同才重启。
	// 若网络失败，catch 返回字符串 "null"，解析后不是字符串，因此不重启（保持现有会话可用）。
	// 这样避免服务器短暂不可用时反复重启沙箱。
	async #outdated(): Promise<void> {
		const base = JSON.parse(await this.#get(`${PREFIX}base`).catch(() => "null")) as unknown;
		if (typeof base === "string" && base !== this.#base) await this.#restart();
	}

	/** The server has a new base bundle: a new sandbox with it, the old one ended. */
	// 重启沙箱：先关闭所有链接 socket，终止旧沙箱并清空引用，再下载新 bundle 启动。
	// 启动成功后触发一次 resize，让新沙箱按当前尺寸绘制；失败则以退出码 1 结束整个客户端。
	// 副作用：连接与子进程的销毁和重建。注意 #finished 未置位，所以此时仍可正常 finish。
	async #restart(): Promise<void> {
		this.#closeSockets();
		await this.#sandbox?.terminate();
		this.#sandbox = undefined;
		try {
			await this.#startSandbox();
			this.#onResize();
		} catch {
			await this.finish(1);
		}
	}

	// 关闭并清空所有沙箱侧的 WebSocket。close() 是优雅关闭，服务端会收到关闭帧。
	#closeSockets(): void {
		for (const ws of this.#sockets.values()) ws.close();
		this.#sockets.clear();
	}

	/** The text at `path` on the server, signed in; at most 8 MiB, read no further. */
	// 带 token 从服务器 GET 文本：先检查状态与 Content-Length，再流式读取累计大小，超过 MAX_BUNDLE 立即停止。
	// 输入：path（已经过 terminalFile 校验或固定端点）；输出：UTF-8 文本。
	// 错误：非 2xx、无 body、超限都抛错。流式读取避免先完整缓冲一个超大响应。
	async #get(path: string): Promise<string> {
		const response = await fetch(new URL(path, this.#url), { headers: this.#headers });
		// body 为 null 表示没有可读内容（如 HEAD 或空响应），按错误处理。
		if (!response.ok || response.body === null) throw new Error(`terminal: GET ${path} answered ${response.status}`);
		// 头部声明的大小只是预检；服务器可能撒谎或使用 chunked，所以循环里还要再累计。
		if (Number(response.headers.get("content-length") ?? 0) > MAX_BUNDLE)
			throw new Error(`terminal: ${path} exceeds 8 MiB`);
		const chunks: Uint8Array[] = [];
		let size = 0;
		// for await 消费异步可迭代的 ReadableStream；每块是 Uint8Array。
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > MAX_BUNDLE) throw new Error(`terminal: ${path} exceeds 8 MiB`);
			chunks.push(chunk);
		}
		// 合并后一次性解码；TextDecoder 默认 UTF-8，并会替换非法序列而不是抛错。
		return new TextDecoder().decode(Buffer.concat(chunks));
	}
}

/** The launcher's SIGUSR1 listener: the signal does nothing. */
// 空监听器的唯一作用是“占用”SIGUSR1，阻止 Node 默认启动 inspector；函数本身不执行任何逻辑。
function ignoreSignal(): void {}
