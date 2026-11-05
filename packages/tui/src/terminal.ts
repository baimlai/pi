// 连接 TUI 与真实进程终端：把 stdin 分成按键/粘贴事件，协商键盘协议，将渲染字符串和终端模式命令写 stdout，退出时复原部分状态。
// TuiBase 调用本文件的 Terminal 接口；测试可提供 VirtualTerminal，真实交互用 ProcessTerminal。创建实例尚未启用 raw 模式，start 才开始接管输入。
// * as fs 将 Node 文件 API 收到 fs 命名空间；这里用于可选输出日志和退出时同步写文件描述符，不负责组件布局。
import * as fs from "node:fs";
// path 以当前平台规则拼日志文件路径，避免手写路径分隔符。
import * as path from "node:path";
// 设置 keys.ts 的模块级协议状态，影响所有用它解释歧义键序列的组件，不是写终端的函数。
import { setKittyProtocolActive } from "./keys.ts";
// 查询原生修饰键的“此刻”状态，补认某些终端没有编码出来的 Shift+Enter，不能恢复事件发生时的历史状态。
import { isNativeModifierPressed } from "./native-modifiers.ts";
// 可选 native helper 用于 Windows VT 输入开关；获取可能同步加载 .node，能力缺失则降级。
import { getNativePlatformHelper } from "./native-platform.ts";
// 具名导入程序状态的编码、回复识别、查询常量与类型；type 导入在运行时擦除。
import {
	// 将结构化状态转成 OSC7501 字符串；发送仍在本文件进行。
	formatProgramStatus,
	// 辨认 OSC7501 支持性回复，不把它作为用户输入转给编辑器。
	isProgramStatusReply,
	// 询问终端是否支持程序状态协议的控制字符串。
	PROGRAM_STATUS_QUERY,
	// ProgramStatus 仅用于 TypeScript 检查状态字段，不会自动运行时校验调用者对象。
	type ProgramStatus,
} from "./program-status.ts";
// 输入缓冲器负责分批重组控制序列及括号粘贴，避免一批 stdin 数据被错误当成单个按键。
import { StdinBuffer } from "./stdin-buffer.ts";
// 把连续 C0/C1 控制字符替成一个空格，防止标题中 ESC/BEL 提前结束 OSC；并非完整 ANSI 正文解析。
import { replaceControlCharacters } from "./utils.ts";

// 进度运行期间每 1000 毫秒重发一次保持活动的控制码，直到主动清除或 stop。
const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
// OSC9;4;3 表示不确定百分比的进行中进度，BEL 结束；常量声明本身不发送。
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
// OSC9;4;0 清除进度状态，与上面的活跃代码配对。
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";
// CSI-u 形式的 Shift+Enter：13 是回车码点，修饰值 2 表示 Shift。
const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
// 1|2|4 的标志和为 7，分别请求消除歧义、事件种类、替代键码；不代表终端最终一定接受全部标志。
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
// 当缓冲器已经产出疑似协商回复前缀时，再等 150ms 尝试拼全；不是所有普通输入都要等这个时间。
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
// 先把所需 Kitty 标志压入终端协议栈，再查询当前标志；模板插入上面的数值，不在此发送。
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u`;
// DA1 设备属性查询作为协商的顺序哨兵；与 Kitty 查询连发，用回复判断是否该启用后备协议。
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";

// 带 type 判别字段的联合类型：编译期可按 type 缩窄两种回复；实际输入还需下面的正则解析。
export type KeyboardProtocolNegotiationSequence =
	// Kitty 回复保存数值 flags，非零值后续作为已启用的依据，不要求恰好等于 7。
	| { type: "kitty-flags"; flags: number }
	// DA1 回复这里只标记类别，不保存其中设备属性数字。
	| { type: "device-attributes" };

// 把一段完整字符串解析成 Kitty 标志/DA1 回复，返回对象或 undefined，不改状态也不写终端。
// 例：ESC[?7u 得到 {type:"kitty-flags",flags:7}，普通 a 得到 undefined；只识别本协商所需格式。
export function parseKeyboardProtocolNegotiationSequence(
	// 待识别的完整序列，字符串下标/长度按 UTF-16 码元而非终端列计算。
	sequence: string,
	// 联合返回类型显式包含“不是协商回复”的 undefined，调用方须分支判断。
): KeyboardProtocolNegotiationSequence | undefined {
	// 捕获 ? 后连续十进制数字，^/$ 无 m 模式匹配整串，u 是协议结束字符而非正则标志。
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	// 有正则匹配时，捕获组可读为 flags。
	if (kittyFlags) {
		// 十进制转数字；! 是 TypeScript 非空断言，不增加数值范围或安全整数验证。
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	// 识别 ? 开头、数字/分号组成、c 结尾的 DA1 回复，不在这里解释设备能力。
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
		// 返回判别对象供后续欠账计数判断是否应吞掉回复。
		return { type: "device-attributes" };
	}
	// 其余字符串留给输入路径，不当协商事件。
	return undefined;
}

// 判断字符串是否可能是尚未收到结尾的协商回复，返回布尔值，无 I/O；例：ESC[ 或 ESC[?7 为 true。
function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	// 只接受两个有限前缀形式，完整回复由另外的 parser 处理；不把所有 ESC 输入都暂存。
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

// 依据运行平台与 TERM_PROGRAM 判断 Apple Terminal 会话，返回布尔值，无修改；环境标识是启发式，非实际终端探测。
export function isAppleTerminalSession(): boolean {
	// && 同时要求 macOS 和精确品牌字符串，别的 macOS 终端不进入这个分支。
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * Refresh terminal dimensions on POSIX platforms by sending SIGWINCH to this process.
 * Best-effort: some environments (restricted seccomp or LSM policies) return EACCES
 * for `kill(2)`; in that case the dimensions refresh is skipped rather than crashing.
 */
// 在 POSIX 尝试向自身发 SIGWINCH，促使 Node 刷新可能陈旧的终端尺寸；无参数/返回值，失败吞掉。
// 例：挂起后恢复时再刷新，不保证受限环境一定允许发信号，也不主动给终端发送尺寸查询。
export function refreshTerminalDimensions(): void {
	// Windows 不用 POSIX 信号；进程 PID 不可用时也直接跳过。
	if (process.platform === "win32" || process.pid <= 0) return;
	// 信号失败不应让交互启动崩溃。
	try {
		// 目标是当前进程，不是父 shell 或其他进程；信号的含义是窗口尺寸可能变化。
		process.kill(process.pid, "SIGWINCH");
		// 捕获同步发信号异常，具体错误不再往上抛。
	} catch {
		// Signal delivery not permitted in this environment; ignore.
	}
}

// Some Apple Terminal setups send ESC+CR (Alt+Enter) for Shift+Enter (#11559).
// 判断这段输入是否是可补认的回车形式，无修改；例：CR 与 ESC+CR 都为 true，普通文字不是候选。
function isNativeShiftEnterCandidate(data: string): boolean {
	// 精确比较整段字符串，避免把粘贴正文里含回车也误当成单个 Shift+Enter。
	return data === "\r" || data === "\x1b\r";
}

// 按调用方给定开关和 Shift 状态，把候选回车改成明确 CSI-u Shift+Enter；否则保留输入，无系统查询或输出。
// 例：CR + 开启检测 + Shift按下，返回 ESC[13;2u；这里的布尔值只是外部观测，函数本身不读取键盘。
export function normalizeNativeShiftEnterInput(
	// 原始的一次输入序列。
	data: string,
	// 调用者决定当前终端/事件是否应启用原生补认。
	shouldDetectNativeShiftEnter: boolean,
	// 外部已查询到的 Shift 状态，不是对字符串做解析的结果。
	isShiftPressed: boolean,
	// 返回正规化后的输入字符串。
): string {
	// 开关、候选格式、Shift 三个条件同时满足才改写，&& 会短路。
	if (shouldDetectNativeShiftEnter && isNativeShiftEnterCandidate(data) && isShiftPressed) {
		// 用标准 CSI-u 序列让下游 keybindings 能识别 Shift+Enter。
		return NATIVE_SHIFT_ENTER_SEQUENCE;
	}
	// 其他输入原样返回，不添加控制码。
	return data;
}

// Apple Terminal 兼容入口，转交相同的纯改写逻辑；输入平台判断/Shift状态由调用者提供，返回新序列或原文。
export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	// isAppleTerminal 在这里充当检测开关，函数本身不会再次查平台。
	return normalizeNativeShiftEnterInput(data, isAppleTerminal, isShiftPressed);
}

/**
 * Minimal terminal interface for TUI
 */
// TUI 面向的终端编译期契约，既可由真实进程也可由内存模拟器实现；interface 不会自动启用模式、注册监听或提供方法实现。
export interface Terminal {
	// Start the terminal with input and resize handlers
	// 启动实现并保存/注册两个回调：onInput 接收序列，onResize 通知尺寸变化；返回 void，真实实现在 start 时改终端模式。
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	// 结束接管并清理模式/监听器，无参数/返回值；具体复原范围看各实现，不自动撤销上层组件状态。
	stop(): void;

	/**
	 * Synchronously restore terminal modes from a process `exit` handler when stop() did not run.
	 * Writes `before`, then this terminal's own mode resets, then `after`.
	 */
	// ? 是可选方法；退出钩子可同步写 before→本实现模式复原→after，调用方须检查存在，不能等待普通异步 flush。
	restoreOnExit?(before: string, after: string): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	// 异步接收/丢弃晚到输入，参数可省略，Promise 完成表示等待阶段结束，不保证网络上不再有晚到字节。
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	// 写一段原始终端字符串，无返回值；真实实现可能另写日志，调用者负责生成内容。
	write(data: string): void;

	// Get terminal dimensions
	// 只读访问器返回列数；不把字符串长度当终端列数。
	get columns(): number;
	// 只读访问器返回行数，模拟终端可以给固定测试尺寸。
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	// 读取实现记录的 Kitty 激活状态，不是每次探测一次终端。
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	// 按行数相对移动光标，正向下、负向上、0 不动；无返回值，真实实现发送 CSI。
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	// 发送隐藏光标指令，无参数/返回值。
	hideCursor(): void; // Hide the cursor
	// 发送显示光标指令，无参数/返回值，不负责光标定位。
	showCursor(): void; // Show the cursor

	// Clear operations
	// 本真实实现清光标到当前行末；接口名的“清行”不应理解为总清整条行。
	clearLine(): void; // Clear current line
	// 清光标到屏幕末尾，无返回值。
	clearFromCursor(): void; // Clear from cursor to end of screen
	// 清可视屏幕并回到左上角，不等于保证清掉终端滚动历史。
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	// 把标题字符串交给终端实现；真实实现清控制字符后编码 OSC0。
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	// active 决定启动不定进度/清除；真实实现运行时会周期重发，不生成百分比。
	setProgress(active: boolean): void;

	/**
	 * Report what the program is doing (OSC 7501). Sent only to terminals that support it; the latest
	 * status is re-sent when support is confirmed or the terminal restarts.
	 */
	// 保存并在支持时发送结构化程序状态；不同于 OSC9;4 进度，clear 用来清除记录，具体支持由实现协商。
	setProgramStatus(status: ProgramStatus): void;
}

// 本地默认只等 10ms 就可把孤立 ESC 交给用户输入处理。
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
// 有 SSH 环境线索时默认延长为 100ms，减少 ESC 与后续 Alt 键字节被拆开的机会。
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;

/**
 * Resolve how long to wait for the rest of an escape sequence before
 * dispatching a lone ESC as the Escape key. Legacy Alt+key input is ESC plus
 * another byte, so high-latency transports need a longer reassembly window.
 */
// 从环境配置得出 ESC 等待毫秒数，返回正有限配置值或 SSH/本地默认，不改环境；例：配置80优先于SSH默认100。
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	// Number 允许小数/科学记数等 JS 数字形式，空串变 0、缺字段通常变 NaN；后面统一筛选。
	const configured = Number(env.PI_TUI_ESC_TIMEOUT);
	// 只有有限且大于 0 才接受，没有要求整数或设最大上限。
	if (Number.isFinite(configured) && configured > 0) {
		// 显式有效配置优先返回。
		return configured;
	}
	// SSH_CONNECTION/SSH_TTY 任一非空字符串就按 SSH 默认，不建立 SSH 连接或验证变量内容。
	if (env.SSH_CONNECTION || env.SSH_TTY) {
		// 高延迟场景的默认等待窗口。
		return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;
	}
	// 没有有效配置及 SSH 线索时采用本地默认。
	return DEFAULT_ESCAPE_TIMEOUT_MS;
}

/**
 * Real terminal using process.stdin/stdout
 */
// 真实 Terminal 实现，维护协议、回调、定时器；implements 仅要求类型兼容，不自动调用 start/stop。
// 例：TuiBase.start 先传输入/重绘回调，再由本类打开 raw/粘贴/协商；方法会影响进程 stdin/stdout，异常多数直接传播，不是纯渲染器。
export class ProcessTerminal implements Terminal {
	// 保存启动前的 raw 状态，stop 尝试恢复；boolean 从初值推断，private 是编译期访问限制。
	private wasRaw = false;
	// 业务输入回调可缺；停止/排空时暂时清空，以免把晚到事件送给编辑器。
	private inputHandler?: (data: string) => void;
	// 可选尺寸变化回调，start 注册到 stdout 的 resize 事件。
	private resizeHandler?: () => void;
	// 本实例是否已确认 Kitty 标志非零，初始尚未确认。
	private _kittyProtocolActive = false;
	// 是否已向终端启用 modifyOtherKeys 后备协议。
	private _modifyOtherKeysActive = false;
	// 是否已经请求压入 Kitty 协议栈；即使尚未收到回复，也要在退出时尝试弹出。
	private keyboardProtocolPushed = false;
	/** DA1 replies owed to keyboard protocol queries. Later DA1 replies answer other queries and are forwarded. */
	// 为键盘协商查询等待的 DA1 数量，stop 不清零，避免重启后旧回复错误地结束新一轮查询。
	private pendingKeyboardProtocolDeviceAttributes = 0;
	// 暂存被分段器提前产出的疑似协商前缀。
	private keyboardProtocolNegotiationBuffer = "";
	// ReturnType<typeof setTimeout> 提取 Node 定时器返回类型，? 允许尚无定时器；只用于静态检查。
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	// 本次启动创建的输入分批/粘贴缓冲器，stop 后设为 undefined。
	private stdinBuffer?: StdinBuffer;
	// 注册到真实 stdin 的函数引用，保存下来才能精确 removeListener。
	private stdinDataHandler?: (data: string) => void;
	// 进度保持活动的周期定时器，可缺，关闭时用其引用取消。
	private progressInterval?: ReturnType<typeof setInterval>;
	/** Latest program status, kept across stop() so start() can report it again. */
	// 最新状态对象引用跨 stop 保留，只在实例内保存、不持久化到磁盘；clear 会清掉引用。
	private programStatus?: ProgramStatus;
	/** Whether the terminal confirmed OSC 7501 support since the last start(), or `PI_PROGRAM_STATUS=1`. */
	// 本次启动是否确认支持程序状态，或显式环境强制为支持。
	private programStatusSupported = false;
	/** The support query was sent and its DA1 sentinel has not arrived yet. */
	// 是否尚在等待程序状态支持性回复；DA1 到齐会结束等待。
	private programStatusQueryPending = false;
	// 字段初始化时立即执行的箭头函数，实例创建就解析日志路径并可能 stat 文件；不是每次 write 都重新查环境。
	private writeLogPath = (() => {
		// 环境缺省/空串表示不记录 write 日志。
		const env = process.env.PI_TUI_WRITE_LOG || "";
		// 关闭日志时返回空路径，避免文件系统检查。
		if (!env) return "";
		// 路径可能不存在/不可访问，stat 异常只影响路径判定，不阻止构造。
		try {
			// 如果配置是已存在目录，就在目录下生成文件名。
			if (fs.statSync(env).isDirectory()) {
				// 使用当前本地日期时间，不是 UTC。
				const now = new Date();
				// 按年-月-日_时-分-秒组时间戳，getMonth 从0起所以加1，其余字符串 padStart 补到2位。
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				// 目录、时间戳和 PID 拼成日志文件路径；尚未创建或写入文件，也不保证同秒同PID创建多个实例时不同名。
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
			// stat 失败时按原值作为文件路径，写日志阶段再自行处理失败。
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		// 配置本来是文件路径也原样返回，不创建父目录。
		return env;
		// () 立即调用这个箭头函数，最终路径字符串赋给字段。
	})();

	// 读取本实例 Kitty 状态，无参数/副作用；例：已发查询未收回复时仍 false，访问器无需括号调用。
	get kittyProtocolActive(): boolean {
		// 只取本地标记，不读真实终端。
		return this._kittyProtocolActive;
	}

	// 读取 modifyOtherKeys 的启用记录，无参数/副作用；true 表示本实例发过启用请求，不是能力回执保证。
	get modifyOtherKeysActive(): boolean {
		// 返回后备协议记录的布尔值。
		return this._modifyOtherKeysActive;
	}

	// 接管真实 stdin/stdout，保存业务回调、启用 raw/UTF-8/括号粘贴、注册 resize，再配置平台输入并开始协议协商，返回 void。
	// 例：TUI 传入 handleTerminalInput 与 requestRender；会改进程输入模式和监听器，未提供重复 start 自动去重或失败时完整回滚。
	start(onInput: (data: string) => void, onResize: () => void): void {
		// 只保存输入函数，此行尚未调用业务处理。
		this.inputHandler = onInput;
		// 保存窗口尺寸变化通知函数。
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		// 记录 Node 当前 raw 标志，缺失按 false；该标志是 Node 记录值，非重新探测 OS 的全部终端状态。
		this.wasRaw = process.stdin.isRaw || false;
		// 非 TTY 流可能没有 setRawMode，所以先检查能力是否存在。
		if (process.stdin.setRawMode) {
			// 启用逐字符 raw 输入，Ctrl+C 等不再自动按普通终端规则生成信号。
			process.stdin.setRawMode(true);
		}
		// 让后续 data 事件得到 UTF-8 字符串，而不是 Buffer。
		process.stdin.setEncoding("utf8");
		// 恢复 stdin 流动，开始接收输入。
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		// 实际向 stdout 发开启括号粘贴代码，终端支持时会包住粘贴内容。
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		// 尽早监听尺寸变化，让 TUI 可请求重绘。
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only, best-effort.
		// POSIX 向本进程发尺寸刷新信号，失败不阻断启动。
		refreshTerminalDimensions();

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		// Windows 必须在 raw mode 之后再打开 VT 输入，因为 raw 配置可能覆盖控制台标志。
		this.enableWindowsVTInput();

		// Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		// 创建/挂载输入缓冲并实际发送查询；协商期间普通输入仍可转发，不同步等待能力回复。
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	// 为本次启动创建 StdinBuffer 并安装分段/粘贴回调，返回 void；此方法只准备回调，stdin监听在 queryAndEnableKittyProtocol 中注册。
	// 例：一批输入含多键时缓冲器逐段发 data；回调先吞程序状态/键盘回复，再送业务，调用业务函数时的异常不在此捕获。
	private setupStdinBuffer(): void {
		// 用环境解析出的 ESC 超时构造缓冲器，内部序列超时和下面额外150ms等待不是同一计时机制。
		this.stdinBuffer = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });

		// Forward individual sequences to the input handler
		// 注册 data 回调，sequence 是缓冲器解析后的一次输入项，事件发生时才执行下面分支。
		this.stdinBuffer.on("data", (sequence) => {
			// 程序状态支持性回复无论是否仍等待，都不应进入编辑器。
			if (isProgramStatusReply(sequence)) {
				// 只有尚在本轮等待窗口里才把回复视为支持确认。
				if (this.programStatusQueryPending) {
					// 确认之后不再等待这一回复。
					this.programStatusQueryPending = false;
					// 记录支持，之后 setProgramStatus 可以实际发送。
					this.programStatusSupported = true;
					// 若之前已有最新状态，现在补发它。
					this.writeProgramStatus();
				}
				// 迟到/无待查询的回复也吞掉，只是不再提升支持状态。
				return;
			}
			// 再识别键盘协商，必要时重组前缀；结果可能是对象、pending 或 undefined。
			const negotiation = this.readKeyboardProtocolNegotiationSequence(sequence);
			// pending 表示仅收到可继续的回复前缀。
			if (negotiation === "pending") {
				// 安排短暂等待，超时则作为原始输入重新分发。
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				// 本回调先结束，等后续片段或计时器，不阻塞线程。
				return; // Wait briefly for the rest of a split Kitty response.
			}
			// 完整协商对象交状态处理器；它返回 true 才表示由键盘协商消费了，不再交业务。
			if (negotiation && this.handleKeyboardProtocolNegotiationSequence(negotiation.parsed)) {
				// 终端回复不算用户按键，结束本次回调。
				return;
			}

			// 有完整却不应吞的协商序列时转发重组原文，否则转发当前原始项；?. 可选访问，?? 仅对 null/undefined 回退。
			this.forwardInputSequence(negotiation?.sequence ?? sequence);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		// paste 回调接收缓冲器收集好的正文，之后重新包上括号标记以兼容编辑器粘贴处理。
		this.stdinBuffer.on("paste", (content) => {
			// 排空/停止期间没有业务回调，就不再把粘贴交给编辑器。
			if (this.inputHandler) {
				// 按“开始标记→正文→结束标记”调用业务函数，不走 Shift+Enter 正规化。
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		// 保存连接 stdin data 与解析器的回调，此处只是赋函数，并未接收输入。
		this.stdinDataHandler = (data: string) => {
			// ! 向 TS 保证缓冲器已创建，运行时直接调用 process；一批原数据会被拆分/缓冲。
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable it if available.
	 *
	 * Kitty's progressive enhancement detection requires requesting the desired
	 * flags before querying them. The trailing DA query is a sentinel supported by
	 * terminals that do not know Kitty keyboard protocol; receiving DA before a
	 * Kitty response enables modifyOtherKeys fallback without a startup timeout.
	 *
	 * The requested flags are:
	 * - 1 = disambiguate escape codes
	 * - 2 = report event types (press/repeat/release)
	 * - 4 = report alternate keys (shifted key, base layout key)
	 *
	 * The OSC 7501 program status query shares the DA sentinel: a terminal that supports it replies
	 * before DA. `PI_PROGRAM_STATUS=1` or `0` skips the query.
	 */
	// 注册真实 stdin 数据监听并发起键盘/程序状态协商，返回 void；先请求Kitty标志，再可选询问OSC7501，最后DA1哨兵。
	// 例：无程序状态覆盖时发 Kitty请求+状态查询+DA1，不设总启动等待定时器；状态已强制支持且有保存值时立即重发。
	private queryAndEnableKittyProtocol(): void {
		// 为这一轮准备新的输入缓冲及其事件处理函数。
		this.setupStdinBuffer();
		// 把刚生成的连接函数挂到 stdin；! 是编译期非空断言，不是运行时判空。
		process.stdin.on("data", this.stdinDataHandler!);
		// 记住已经请求压栈，stop 即使没收到确认也会发弹栈码。
		this.keyboardProtocolPushed = true;
		// 新增一份待收 DA1 欠账，旧轮未到的回复份数保留。
		this.pendingKeyboardProtocolDeviceAttributes += 1;
		// 清掉此前的疑似片段与短等定时器，不把旧前缀拼入新轮。
		this.clearKeyboardProtocolNegotiationBuffer();
		// 读取当前启动时的程序状态覆盖值，只认字符串1和0。
		const programStatusOverride = process.env.PI_PROGRAM_STATUS;
		// 精确等于1直接视为支持；不是“环境变量只要定义就开启”。
		this.programStatusSupported = programStatusOverride === "1";
		// 除了1/0其他值仍需查询，包含空字符串。
		this.programStatusQueryPending = programStatusOverride !== "1" && programStatusOverride !== "0";
		// 本轮需查询才插入查询字符串，否则空串。
		const programStatusQuery = this.programStatusQueryPending ? PROGRAM_STATUS_QUERY : "";
		// 将请求按上述顺序一次写 stdout，这才是真正的 I/O。
		process.stdout.write(`${KITTY_KEYBOARD_PROTOCOL_QUERY}${programStatusQuery}${DEVICE_ATTRIBUTES_QUERY}`);
		// 支持已由环境确认且已有状态时补发，否则此调用不写。
		this.writeProgramStatus();
	}

	// 消费已解析协商回复，更新实例/全局协议状态并可能写后备启停代码，返回是否应吞掉这条输入。
	// 例：非零Kitty标志启用本地active；DA1无欠账返回false让颜色查询等上层处理，不会吞所有DA回复。
	private handleKeyboardProtocolNegotiationSequence(
		// 带type判别的对象，让不同分支只读取所属字段。
		negotiationSequence: KeyboardProtocolNegotiationSequence,
		// true 表示已经消费，false 表示仍需送上层；不返回终端是否真的支持全部请求的证明。
	): boolean {
		// 拿到完整回复后无需继续等待片段，清掉缓冲/计时器。
		this.clearKeyboardProtocolNegotiationBuffer();
		// DA1 需要先判定是不是属于键盘协商的欠账。
		if (negotiationSequence.type === "device-attributes") {
			// 已经没有待收键盘DA1，就交回上层，不抢颜色探测等其他查询的回复。
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) return false;
			// 消费一份欠账，跨重启迟到的旧回复也按发送顺序计数。
			this.pendingKeyboardProtocolDeviceAttributes -= 1;
			// The last owed DA answers the latest query, which got no program status reply first. Earlier DA
			// replies belong to queries from before a restart.
			// 最后一份DA1到齐就结束最新轮尚未完成的程序状态等待；若此前已经确认支持，也只清pending，不清supported。
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) this.programStatusQueryPending = false;
		}
		// Kitty 回复带有 flags，TypeScript 按type缩窄后允许访问它。
		if (negotiationSequence.type === "kitty-flags") {
			// 只看是否非零，不验证是否等于所请求的7或包含全部期望位。
			if (negotiationSequence.flags !== 0) {
				// Kitty 已确认时关闭可能先前开启的 modifyOtherKeys，避免两种输入增强同时记录为活跃。
				this.disableModifyOtherKeys();
				// 尚未active时再设置，避免重复更新全局布尔值。
				if (!this._kittyProtocolActive) {
					// 记录当前实例已经协商到非零标志。
					this._kittyProtocolActive = true;
					// 同步keys.ts模块级状态，影响共享键解释规则，但此行不向终端发送启用码。
					setKittyProtocolActive(true);
				}
				// flags为0就尝试后备；若实例原已Kitty active，enableModifyOtherKeys 的保护仍会阻止重复开启。
			} else {
				// 实际后备启用逻辑在单独方法里，按现有状态决定是否发码。
				this.enableModifyOtherKeys();
			}
			// 无论flags为0或非零，这条Kitty回复都由本层消费。
			return true;
		}

		// DA1分支到这里：若仍未确认Kitty，就启用后备输入协议。
		if (!this._kittyProtocolActive) {
			// 写 modifyOtherKeys 启用码并记状态，不等待额外回执。
			this.enableModifyOtherKeys();
		}
		// 属于键盘协商的DA1已消费，不继续转给业务。
		return true;
	}

	/** Returns the parsed negotiation reply with its full (possibly reassembled) sequence. */
	// 尝试把当前输入与前次疑似前缀拼成完整协商回复，返回完整对象、pending 或 undefined；必要时会把旧缓冲作为业务输入重放。
	// 例：先收到ESC[?7再收到u，得到完整flags对象；若后缀不是回复，先转交旧前缀，再单独判断当前片段，按顺序分开处理。
	private readKeyboardProtocolNegotiationSequence(
		// 本次由 StdinBuffer 产出的输入项，不保证就是完整协商回复。
		sequence: string,
		// 对象同时保留解析结果和完整原文，pending表示继续等，undefined表示本片段不是协商。
	): { parsed: KeyboardProtocolNegotiationSequence; sequence: string } | "pending" | undefined {
		// 已有前缀时先尝试与本片段拼接。
		if (this.keyboardProtocolNegotiationBuffer) {
			// 局部拼接不立即覆盖原缓冲，识别失败仍可单独重放旧前缀。
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			// 按完整回复格式解析组合后的字符串。
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			// 拼接已经完整有效，就无需再延迟。
			if (negotiationSequence) {
				// 清空旧缓冲及等待定时器。
				this.clearKeyboardProtocolNegotiationBuffer();
				// 返回解析对象与拼全的原序列，便于后续未消费的DA1也原样转发。
				return { parsed: negotiationSequence, sequence: bufferedSequence };
			}
			// 还只是合法前缀，则保留组合内容继续等待。
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				// 保存更长前缀，同时取消旧的短等计时器；上层随后重新安排等待。
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				// 通知上层本次不要立即送用户输入。
				return "pending";
			}
			// 拼接不是回复也不是前缀，先将此前暂存原文交给输入回调；回调可能同步抛错，未在此吞异常。
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		// 然后只判断当前这一个片段，避免把它也随旧缓冲一起错分发。
		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		// 完整回复直接返回，保留当前原文。
		if (negotiationSequence) return { parsed: negotiationSequence, sequence };
		// 否则若当前项本身是可继续的前缀，进入新一轮短等。
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			// 保存当前前缀，取消前一个计时器引用。
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			// 返回pending，由data回调安排150ms等待。
			return "pending";
		}
		// 非协商项交回上层作为正常输入转发。
		return undefined;
	}

	// 保存新疑似协商前缀，返回void；先取消旧计时器，不在此自行安排新定时器，例：前缀增长后由上层重计等待。
	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		// 避免旧计时器在新片段刚到时误把缓冲重放。
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		// 替换当前缓冲字符串，不追加；调用方已经完成拼接。
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	// 清疑似前缀和计时器，返回void且不重放输入；用于成功识别、启停及排空，例：新协商不会接续旧前缀。
	private clearKeyboardProtocolNegotiationBuffer(): void {
		// 先取消尚未执行的超时回调。
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		// 丢掉当前待拼接片段，区别于下方flush的业务重放。
		this.keyboardProtocolNegotiationBuffer = "";
	}

	// 把未能确认的缓冲前缀当原始输入重放一次，清空缓冲/计时器后调用业务，返回void；无回调时正文会丢弃。
	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		// 没有待重放内容就不动作。
		if (!this.keyboardProtocolNegotiationBuffer) return;
		// 先保存原文，清空后仍可使用。
		const sequence = this.keyboardProtocolNegotiationBuffer;
		// 先清状态，避免业务回调重入时又看到同一缓冲。
		this.clearKeyboardProtocolNegotiationBuffer();
		// 走统一的Shift+Enter补认与输入回调路径，不重新送进StdinBuffer分段。
		this.forwardInputSequence(sequence);
	}

	// 有疑似前缀且无定时器时安排短等，返回void；例：150ms仍没拼全，就按原输入重放，不等待整个启动完成。
	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		// 空缓冲或已经安排过都不重复创建任务。
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		// 保存超时句柄；箭头回调在之后执行，不是此刻执行重放。
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			// 回调触发时句柄已完成，先清字段。
			this.keyboardProtocolBufferFlushTimer = undefined;
			// 将仍未拼全的内容作为输入重放，业务回调错误可能从计时器回调传播。
			this.flushKeyboardProtocolNegotiationBufferAsInput();
			// 使用固定的回复片段等待时长；实际执行时刻还受事件循环调度影响。
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	// 取消当前回复片段定时器，返回void，无句柄则无动作；只取消任务，不自行清正文缓冲。
	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		// 还没有计时任务就立即结束。
		if (!this.keyboardProtocolBufferFlushTimer) return;
		// 取消这一句柄对应的回调。
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		// 恢复“尚无定时器”状态，允许后续重新安排。
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	// 将一次原始/重组输入补认后交给业务回调，返回void；只在候选回车且Apple/Windows平台时才查原生Shift。
	// 例：普通a不加载原生查询；Shift+CR可改成CSI-u。查询的是此刻键状态，业务回调同步执行，其异常向上传播。
	private forwardInputSequence(sequence: string): void {
		// 排空或停止时业务回调被清空，晚到事件不分发给编辑器。
		if (!this.inputHandler) return;
		// 先算是否应检测，续行里的&&/||决定必要的平台与格式条件。
		const shouldDetectNativeShiftEnter =
			// 必须是CR或ESC+CR，且为Apple Terminal或Windows；其他终端不做此补认。
			isNativeShiftEnterCandidate(sequence) && (isAppleTerminalSession() || process.platform === "win32");
		// 调用纯正规化函数，本行开始组装参数，真正原生查询在第三参数求值时发生。
		const input = normalizeNativeShiftEnterInput(
			// 传入当前原文。
			sequence,
			// 传入已算出的检测开关。
			shouldDetectNativeShiftEnter,
			// && 短路：开关为false就不调用native helper；开启才查询当前Shift是否按下，缺能力通常按false。
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		// 同步调用已注册业务输入函数，不在这里执行具体编辑动作。
		this.inputHandler(input);
	}

	// 尝试启用modifyOtherKeys级别2，返回void并修改记录/写stdout；例：DA1到但没有Kitty确认时使用，不做能力回执校验。
	private enableModifyOtherKeys(): void {
		// 已有Kitty或后备已开启时不重复发码。
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		// 实际发送启用序列。
		process.stdout.write("\x1b[>4;2m");
		// 记录已请求后备，后续stop据此清理。
		this._modifyOtherKeysActive = true;
	}

	// 后备记录为开启时发关闭码并清标志，无输入/返回值；例：迟到Kitty确认之后关闭先前后备。
	private disableModifyOtherKeys(): void {
		// 没开启就无需关闭。
		if (!this._modifyOtherKeysActive) return;
		// 发送modifyOtherKeys关闭序列，不操作Kitty栈。
		process.stdout.write("\x1b[>4;0m");
		// 清除本地后备状态。
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	// Windows尝试通过可选原生函数启用VT输入，返回void；用于让Shift+Tab等保留修饰信息，失败忽略，不保证调用成功。
	private enableWindowsVTInput(): void {
		// 其他平台立即跳过，不加载helper。
		if (process.platform !== "win32") return;
		// 原生模块加载或方法调用可能同步失败。
		try {
			// 两层可选链分别处理helper缺失和方法缺失，返回的boolean未被检查，不将“调用过”当作启用成功证明。
			getNativePlatformHelper()?.enableVirtualTerminalInput?.();
			// 同步异常降级，键位可能仍有歧义，不在此补发其他系统命令。
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
		}
	}

	// 退出前先退键盘增强协议，再暂停业务输入分发并接收晚到data，直到总预算或连续空闲预算满足，返回Promise<void>。
	// 例：默认最多约1000ms或空闲50ms；循环与定时器只是尽力等待，不是硬实时截止，也不保证网络/系统缓冲永久清空。finally恢复业务回调，不代替stop。
	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		// 只要请求过压栈或确认过active，就需要先尝试弹栈。
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		// 丢弃待拼协商前缀和计时器，不把这类残片当退出前业务输入。
		this.clearKeyboardProtocolNegotiationBuffer();
		// 需要退协议时先发退栈码，减少终端继续生成新的Kitty释放事件。
		if (shouldDisableKittyProtocol) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			// stdout输出请求弹出Kitty协议状态，不等待终端确认。
			process.stdout.write("\x1b[<u");
			// 本地记录不再认为有自己待弹出的压栈。
			this.keyboardProtocolPushed = false;
			// 当前实例Kitty标志清为false。
			this._kittyProtocolActive = false;
			// 同步清keys模块的共享解释状态。
			setKittyProtocolActive(false);
		}
		// 后备增强也关闭，尽量让后续输入恢复shell预期格式。
		this.disableModifyOtherKeys();

		// 暂存业务回调，排空结束后再恢复相同引用。
		const previousHandler = this.inputHandler;
		// 晚到按键/粘贴不会进入编辑器；既有StdinBuffer连接仍可解析输入和处理终端回复。
		this.inputHandler = undefined;

		// 最后一次data到达的墙上时间，开始等待也算空闲起点。
		let lastDataTime = Date.now();
		// 额外data监听器只记录到达时间，无业务处理/返回值；每次data会延后空闲退出条件。
		const onData = () => {
			// 数据到来时更新最后活动时刻，不检查内容是不是按键释放。
			lastDataTime = Date.now();
		};

		// 注册这个额外监听器，原stdin解析监听仍然存在。
		process.stdin.on("data", onData);
		// 计算总等待预算的结束时间，参数按调用方给出的毫秒使用，未额外范围验证。
		const endTime = Date.now() + maxMs;

		// 确保即使等待期间抛错，也会移除额外监听并恢复回调。
		try {
			// 每轮等待后重新检查总时长与空闲时长。
			while (true) {
				// 读取本轮时间，不是单独的终端确认信号。
				const now = Date.now();
				// 剩余总预算可能已到期。
				const timeLeft = endTime - now;
				// 总预算已用完则结束等待。
				if (timeLeft <= 0) break;
				// 连续无data达到idleMs也提前结束，不必等满maxMs。
				if (now - lastDataTime >= idleMs) break;
				// 异步等较短预算，Promise完成后继续检查；await让出事件循环，非阻塞睡眠。
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
			// 无论正常跳出或异常都执行收尾。
		} finally {
			// 只移除本方法新增的data监听，不移除原StdinBuffer输入连接。
			process.stdin.removeListener("data", onData);
			// 恢复调用之前的业务回调；后续真正退出仍应stop清理。
			this.inputHandler = previousHandler;
		}
	}

	// 结束真实终端接管：关进度/程序状态显示、括号粘贴和增强键盘，销毁本轮缓冲、卸监听、暂停stdin后恢复raw记录，返回void。
	// 例：挂起/退出前调用；程序状态对象与DA1欠账跨stop保留以支持重启。不是所有操作都包try/finally，未捕获的写入/模式错误可中断收尾。
	stop(): void {
		// 只有确有进度定时器才在stop附加一次进度清除码。
		if (this.clearProgressInterval()) {
			// 停止终端的进度显示，周期重发已由clearProgressInterval取消。
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
		// Remove the status while stopped, for example after exit or while suspended. start() reports it again.
		// 只在本轮已确认支持且有状态对象时清掉显示。
		if (this.programStatusSupported && this.programStatus) {
			// 发送程序状态clear，但不清内部最新状态对象，重启确认后可再次上报。
			process.stdout.write(formatProgramStatus({ state: "clear" }));
		}
		// 支持标记按启动周期重置，下次需环境覆盖或重新协商。
		this.programStatusSupported = false;
		// 不再等待本轮程序状态查询。
		this.programStatusQueryPending = false;

		// Disable bracketed paste mode
		// 发送关闭括号粘贴，即使之前未确认终端是否支持。
		process.stdout.write("\x1b[?2004l");

		// 排空可能已弹过栈，所以先根据记录决定是否还需要弹。
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		// 清除尚未拼全的回复和超时任务。
		this.clearKeyboardProtocolNegotiationBuffer();

		// Disable Kitty keyboard protocol if not already done by drainInput()
		// 仅在仍需弹栈时发送，避免drain后重复弹掉外层的协议栈。
		if (shouldDisableKittyProtocol) {
			// 实际发送Kitty弹栈指令。
			process.stdout.write("\x1b[<u");
			// 清“本实例已压栈”的记录。
			this.keyboardProtocolPushed = false;
			// 清实例激活标记。
			this._kittyProtocolActive = false;
			// 同步全局键解释标记为false。
			setKittyProtocolActive(false);
		}
		// 如有modifyOtherKeys后备，也关闭并清状态。
		this.disableModifyOtherKeys();

		// Clean up StdinBuffer
		// 本轮输入缓冲存在时清理它。
		if (this.stdinBuffer) {
			// destroy实际清内部缓冲/计时器，不代表它会移除自身所有EventEmitter监听或禁止再次process。
			this.stdinBuffer.destroy();
			// 本实例释放缓冲引用，后续start将新建一个。
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		// 只有曾注册过连接函数时才卸载它。
		if (this.stdinDataHandler) {
			// 用同一函数引用精确移除stdin data监听，不移除其他所有监听。
			process.stdin.removeListener("data", this.stdinDataHandler);
			// 清掉旧函数引用，避免stop后再次作为本轮连接使用。
			this.stdinDataHandler = undefined;
		}
		// 停止向业务转发输入。
		this.inputHandler = undefined;
		// 已注册resize回调也要卸载。
		if (this.resizeHandler) {
			// 只移除本实例保存的回调。
			process.stdout.removeListener("resize", this.resizeHandler);
			// 清空回调字段。
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		// 先暂停stdin流动，再还原raw，减少Ctrl+D等残留输入被普通模式重新解释的机会；不是物理清空缓冲的保证。
		process.stdin.pause();

		// Restore raw mode state
		// 非TTY输入可能没有raw配置能力。
		if (process.stdin.setRawMode) {
			// 还原start保存的布尔状态；不会在此恢复编码、所有其他监听或终端的全部模式。
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	// 进程exit兜底同步写“before→部分终端复原→after”，返回void；例：上层在未stop就process.exit时调用，避免异步stdout没来得及刷出。
	// 只尽力写一串代码，不执行完整stop，不取消监听/定时器或恢复raw，也不发OSC7501 clear；同步写失败吞掉，不承诺全部字节都已送达终端。
	restoreOnExit(before: string, after: string): void {
		// 先放上层提供的复原前缀，常包含显示光标/关闭上层模式。
		let sequence = before;
		// 若有进度周期任务，追加清进度指令；这里只拼字符串，不取消任务。
		if (this.progressInterval) sequence += TERMINAL_PROGRESS_CLEAR_SEQUENCE;
		// 始终追加关闭括号粘贴。
		sequence += "\x1b[?2004l";
		// 按记录决定是否追加Kitty弹栈。
		if (this.keyboardProtocolPushed || this._kittyProtocolActive) sequence += "\x1b[<u";
		// 按后备状态追加modifyOtherKeys关闭码。
		if (this._modifyOtherKeysActive) sequence += "\x1b[>4;0m";
		// 最后拼上调用者后缀，按上层要求退出备用屏等。
		sequence += after;
		// 退出阶段终端描述符可能已关闭，写入失败不再抛错。
		try {
			// process.stdout.write() may be asynchronous (e.g. Windows TTYs) and would not flush during exit.
			// 直接同步写stdout文件描述符；绕过普通write方法及日志，返回字节数未检查，也不循环重试部分写入。
			fs.writeSync(process.stdout.fd, sequence);
			// 吞掉同步写异常，不让退出钩子因此再失败。
		} catch {
			// The terminal may already be gone.
		}
	}

	// 写一段原始终端数据，返回void；先发stdout，再可选同步追加UTF-8日志，例：TUI渲染帧可被记录以复现显示问题。
	// 只记录经此方法的输出，start/stop等直接stdout.write的控制码不自动入日志；stdout错误不由此捕获，日志错误忽略，也不等待流的drain背压。
	write(data: string): void {
		// 先调用stdout.write，布尔背压结果未使用，不等于承诺输出已物理刷屏。
		process.stdout.write(data);
		// 实例创建时解析出非空日志路径才记录。
		if (this.writeLogPath) {
			// 只捕获日志追加的异常，不把stdout错误一起吞掉。
			try {
				// 同步追加原始data，包括其中的控制码；可新建文件但不创建缺少的父目录。
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
				// 日志失败不阻止后续交互，也不会在屏幕再显示报错。
			} catch {
				// Ignore logging errors
			}
		}
	}

	// 读取终端列数，优先Node记录，其次COLUMNS，再80；无参数/状态修改，例：管道无TTY尺寸时可用环境回退。
	get columns(): number {
		// ||按真值回退，0/NaN不用，但负数等非零环境数字仍可被接受；不是正整数验证器。
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	// 读取行数，优先Node记录、LINES、最后24，无副作用；与columns各自独立回退。
	get rows(): number {
		// 将环境字符串转数值，用||选首个真值，未验证有限/整数/正数。
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	// 按传入行数相对移动真实光标，返回void；正数向下、负数向上、0不发码，例：-2发向上两行代码，不维护本地光标位置。
	moveBy(lines: number): void {
		// 向下移动分支。
		if (lines > 0) {
			// Move down
			// 模板把行数写进CSI B；调用者应给合理整数，本函数未额外夹限。
			process.stdout.write(`\x1b[${lines}B`);
			// 负数进入向上分支。
		} else if (lines < 0) {
			// Move up
			// 取相反数作正幅度，发送CSI A。
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	// 隐藏真实硬件光标，无参数/返回值；例：TUI启动后自己控制光标位置时使用，不改变组件focused。
	hideCursor(): void {
		// 向stdout发DECTCEM关闭代码。
		process.stdout.write("\x1b[?25l");
	}

	// 显示真实硬件光标，无参数/返回值；例：退出交互把光标还给shell，不自动移动位置。
	showCursor(): void {
		// 发送与hideCursor配对的开启代码。
		process.stdout.write("\x1b[?25h");
	}

	// 清当前位置到本行末，返回void；例：短新行覆盖长旧行后清掉尾部，不保证删除光标左侧文字。
	clearLine(): void {
		// CSI K省略参数默认是0，即清到行末，不是参数2的整行清除。
		process.stdout.write("\x1b[K");
	}

	// 清当前位置到屏幕末，返回void；用于去掉下方陈旧渲染，不移动到原点或清滚动历史。
	clearFromCursor(): void {
		// 发送CSI J默认参数0。
		process.stdout.write("\x1b[J");
	}

	// 清可视屏幕并把光标移左上，返回void；例：强制重绘前清屏，是否影响历史由终端决定，不发送专门清滚动历史指令。
	clearScreen(): void {
		// CSI2J清屏、CSIH默认1行1列；布局通常用从0编号的坐标，两者表达同一左上位置。
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	// 设置终端窗口标题，返回void并写stdout；先把连续C0/C1换为空格，防止来自会话文件的标题提前结束OSC0并注入控制命令。
	// 例：标题里BEL/ESC被替换，剩余可打印载荷仍是标题文字；不改原title，也不控制终端实际是否显示标题。
	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title. A BEL or ESC in the title would end the sequence early and
		// send the rest to the terminal as escape sequences (session names come from session files).
		// 对替换后的标题包OSC0和BEL结束符，一次发送。
		process.stdout.write(`\x1b]0;${replaceControlCharacters(title)}\x07`);
	}

	// 保存最新ProgramStatus对象并在支持时立即上报，返回void；例：未确认支持前先设working，确认回执后补发。
	// clear清除保存引用；其他状态保存原引用不复制，调用者后续修改对象可能影响重发。formatter只处理字段编码，不推断任务真的在运行。
	setProgramStatus(status: ProgramStatus): void {
		// 三元表达式在clear时存undefined，否则保留调用者对象供stop后start重发。
		this.programStatus = status.state === "clear" ? undefined : status;
		// 只有支持标记为true才编码发送，包括clear；不支持时仅更新内部记录。
		if (this.programStatusSupported) process.stdout.write(formatProgramStatus(status));
	}

	// 尝试发送此前保存的最新状态，无参数/返回值；例：支持确认/重启后调用，缺支持或缺状态时无输出。
	private writeProgramStatus(): void {
		// 两个条件都满足才写，不在这里发支持性查询。
		if (this.programStatusSupported && this.programStatus) {
			// 即时格式化保存的对象并发stdout，不清除保存值。
			process.stdout.write(formatProgramStatus(this.programStatus));
		}
	}

	// 开启或清除不定进度，返回void并写stdout；active=true立即发一次并确保有一个1秒周期，false取消周期并发清除。
	// 例：多次true会各立即发一次，但不累积多个周期任务；不检查终端是否支持OSC9;4，需调用false或stop结束周期。
	setProgress(active: boolean): void {
		// 开启进度的分支。
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			// 每次调用true都立即发活跃指令。
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			// 已经有周期任务时不再增加第二个。
			if (!this.progressInterval) {
				// 创建保持活动的定时回调，今后每次执行才发码。
				this.progressInterval = setInterval(() => {
					// 重复发送同一活跃序列，不累计百分比，也不更新程序状态OSC7501。
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
					// 以1000ms作周期，实际调度可能延迟，没有unref让任务自行不阻止进程退出。
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
			// false走清除分支。
		} else {
			// 先停掉周期，避免清除后被下一次重发覆盖。
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			// 无论以前有没有任务，都发一次清除进度代码。
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	// 取消进度周期并返回是否确有任务被取消，无输入；例：stop只在返回true时追加进度清除码，本方法本身不写终端。
	private clearProgressInterval(): boolean {
		// 没有句柄表示无活动周期，返回false。
		if (!this.progressInterval) return false;
		// 取消未来的周期回调。
		clearInterval(this.progressInterval);
		// 清句柄，后续true可以创建新周期。
		this.progressInterval = undefined;
		// 通知调用者确实清理了一项周期任务。
		return true;
	}
}
