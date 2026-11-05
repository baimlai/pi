// 把 stdin 的任意输入片段拼成可分发的序列，完整普通输入通过 data 事件发出，括号粘贴正文单独通过 paste 发出。
// ProcessTerminal 在上游调用 process，消费部分终端回复，再把 data 交给 TUI；paste 会被它重新包回开始/结束标记供编辑器处理。本层不执行编辑动作，也不写终端。
/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

// 继承 Node EventEmitter；emit 同步调用已注册监听器，返回值不表示监听器已完成异步任务，监听器抛错会向上传播。
import { EventEmitter } from "events";

// ESC 控制字符，作为多种终端序列的共同起始字节。
const ESC = "\x1b";
// 普通不完整按键/鼠标或歧义 Alt 输入默认等 50ms；已识别回复头有不同等待策略。
const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
// 孤立 ESC 只默认等 10ms，以便较快当作 Escape 键发出。
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
// 括号粘贴开始序列，与普通文本区分。
const BRACKETED_PASTE_START = "\x1b[200~";
// 括号粘贴结束序列；正文中换行等内容在本层原样保留。
const BRACKETED_PASTE_END = "\x1b[201~";
// Color and program-status OSC replies, XTVersion, and Kitty graphics replies.
// Until their header is complete, the input may be batched legacy Alt keystrokes.
// 识别颜色/程序状态 OSC、XTVersion DCS、Kitty 图片 APC 的特定完整回复头。^ 限定起点，数字/分隔符需符合本正则；并不把所有 OSC/DCS/APC 都自动认作这些回复，也不验证来源真实性。
const TERMINAL_REPLY_HEADER_PATTERN = /^\x1b(?:\](?:1[01];|4;\d{1,3};|7501;\?)|P>\||_G(?:[a-z]=\d+,)*[a-z]=\d+;)/;

// 判断字符串是否以 OSC/DCS/APC 引导符开头，返回 boolean，无副作用。例：ESC+] 命中，但这本身还不能说明是终端回复，也不检查终止符。
function isControlString(data: string): boolean {
	// 三个 startsWith 逻辑或，任一符合即可；模板插值拼的是控制字符加分类字符。
	return data.startsWith(`${ESC}]`) || data.startsWith(`${ESC}P`) || data.startsWith(`${ESC}_`);
}

/**
 * Check if a string is a complete escape sequence or needs more data
 */
// 按前缀与尾部判断一个候选序列完整性，返回三个字面量之一，不消费输入。
// 例：孤立 ESC 为 incomplete，ESC+[A 为 complete，普通 a 为 not-escape；这里只判断结构，不把序列解释成具体按键，也不保证未知序列合法。
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	// 不是 ESC 开头就交回普通文本类别。
	if (!data.startsWith(ESC)) {
		// not-escape 供外层解析器区分路径。
		return "not-escape";
	}

	// 只有一个 ESC 时还无法区分 Escape、Alt+字母或更长控制串。
	if (data.length === 1) {
		// 暂定不完整，是否超时由 StdinBuffer 后面安排。
		return "incomplete";
	}

	// 切掉首个 ESC，后面的分类判断只看剩余前缀。
	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	// ESC+[ 属于 CSI 家族。
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		// 旧鼠标 ESC+[M 固定还要三个载荷单元，不能看到 M 就按普通 CSI 结束。
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			// 总字符串长度至少 6 才完整；这里按字符串 length 判断，而非重新读取原始字节流。
			return data.length >= 6 ? "complete" : "incomplete";
		}
		// 其他 CSI 交给专用终止/鼠标结构判断。
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	// ESC+] 是 OSC，例如颜色查询回复或标题类控制串。
	if (afterEsc.startsWith("]")) {
		// 委托 OSC 的 BEL/ST 终止判断。
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	// ESC+P 是 DCS，例如 XTVersion 回复。
	if (afterEsc.startsWith("P")) {
		// 委托 DCS 的 ST 终止判断。
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	// ESC+_ 是 APC，例如 Kitty 图片回复。
	if (afterEsc.startsWith("_")) {
		// 委托 APC 的 ST 终止判断。
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	// ESC+O 是 SS3 按键序列前缀。
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		// O 后至少再有一个字符就按完整 SS3 候选处理，不检查那个字符是否具体已知功能键。
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	// 其他 ESC 后只有一个字符时，作为传统 Meta/Alt+字符的完整序列。
	if (afterEsc.length === 1) {
		// 可以交给后续键位解析，不再等待更多字符。
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	// 其余未知 ESC 形式也按完整处理，不在此拒绝或报语法错。
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
// 判断 CSI 候选是否结束，返回 complete/incomplete，无副作用；先确认最短长度，再检查末单元是否在终止区间，SGR 鼠标另要求三段数字。
// 例：ESC+[1;5H 完整，ESC+[<35;20 仍缺结尾；不是 CSI 的输入按约定直接返回 complete，不进行通用输入校验。
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	// 调用约定之外的非 CSI 字符串直接视为完整。
	if (!data.startsWith(`${ESC}[`)) {
		// 返回不代表它是合法 CSI，仅表示这个专用函数不等待它。
		return "complete";
	}

	// Need at least ESC [ and one more character
	// 至少要 ESC、[、一个后续字符才能判断尾部。
	if (data.length < 3) {
		// 过短继续缓冲。
		return "incomplete";
	}

	// 截去两个字符引导符得到 CSI 载荷。
	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	// 取载荷最后一个字符串单元；前面的长度判断支持它存在。
	const lastChar = payload[payload.length - 1];
	// 取得该单元数值以检查 CSI final-byte 范围。
	const lastCharCode = lastChar.charCodeAt(0);

	// 0x40..0x7e 可作为 CSI 终止字符，这一条件先决定是否可能结束。
	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		// 以 < 开始的载荷按 SGR 鼠标额外检查，不能任意见到字母就认为完整。
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			// 要求三段非空十进制数字、分号分隔、最后 M 或 m；是原始终端输入的结构识别，不是 TypeScript 自动验证。
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			// 规范鼠标格式直接接受。
			if (mouseMatch) {
				// 返回完整，外层可分发整条鼠标序列。
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			// 主正则未命中时仍保留下面 M/m 的结构判断分支；当前实现没有删除这一重复检查。
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				// 去掉 < 与结尾 M/m，再按分号拆载荷。
				const parts = payload.slice(1, -1).split(";");
				// 恰好三段且 every 每段全数字才接受；回调只返回是否符合数字模式，不解析实际坐标。
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					// 结构再次确认成功，返回完整。
					return "complete";
				}
			}

			// 带 < 的其他形式仍视为不完整，稍后可能由超时恢复；不在这里抛错。
			return "incomplete";
		}

		// 非鼠标 CSI 且末字符属于终止范围就算完整，不检查参数语义。
		return "complete";
	}

	// 末字符不是终止单元，继续等待更多输入。
	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
// 判断 OSC 是否以 ST 或 BEL 结束，无副作用，返回两种状态。例：ESC+]10;rgb:ffff/ffff/ffff+BEL 完整；不解析颜色值或校验完整协议语义。
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	// 非 OSC 输入不归本专用判断器等待。
	if (!data.startsWith(`${ESC}]`)) {
		// 按既有调用约定返回 complete，不是合法性背书。
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	// OSC 可以由 ESC+反斜杠组成的 ST 或单个 BEL 结束。
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		// 找到允许的尾部结束符就完整。
		return "complete";
	}

	// 否则继续等结束符；是否启用超时取决于回复头识别。
	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
// 判断 DCS 是否以 ST 结束，返回状态，不消费输入。例：XTVersion 的 ESC+P>|...+ST 完整；BEL 在这里不能结束 DCS，非 DCS 直接按调用约定视为完整。
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	// 只对 DCS 前缀检查结束符。
	if (!data.startsWith(`${ESC}P`)) {
		// 不是 DCS 就不要求等待。
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	// 检查 ESC+反斜杠这对 ST 结束单元。
	if (data.endsWith(`${ESC}\\`)) {
		// 存在 ST，候选完整。
		return "complete";
	}

	// 没有 ST，继续等待。
	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
// 判断 APC 是否以 ST 结束，返回状态，无副作用。例：Kitty 图片回复以 ESC+_ 开始，最终需 ST；不解码图片载荷或判断回复是否成功。
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	// 非 APC 输入不归本分支等待。
	if (!data.startsWith(`${ESC}_`)) {
		// 按调用约定直接视为完整。
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	// APC 只接受 ST 结束，不使用 OSC 的 BEL 结束规则。
	if (data.endsWith(`${ESC}\\`)) {
		// 尾部完整，返回 complete。
		return "complete";
	}

	// 否则尚未结束。
	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
// 从无显式修饰参数的 Kitty CSI-u 序列取首个数值码点，返回 number 或 undefined，无副作用，用于去重紧接的原始字符。
// 例：ESC+[97u 识别为 97，而带分号修饰参数的不识别；只检查码点至少为 32，不检查 Unicode 上限或所有控制码，因此不要当成通用可打印字符验证器。上方原英文是原有注释，本函数不负责切分整个缓冲。
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	// 整串正则匹配：数字主码点、可选冒号备用码点、最后 u；没有分号修饰字段。
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	// 不符合这个特定形状就返回 undefined。
	if (!match) return undefined;

	// ! 只影响 TypeScript；前面正则保证第一捕获组，按十进制转数值。
	const codepoint = parseInt(match[1]!, 10);
	// 数值达到 32 才用于去重，较小则忽略；并不把它转换成文字。
	return codepoint >= 32 ? codepoint : undefined;
}

// 把累积字符串切成完整序列数组与未完成尾部，返回新结构，不修改传入字符串或发事件。
// 从 pos 逐步扫描，ESC 候选逐渐加长，已识别回复可被 CAN/SUB 或新 ESC 中止，普通文字逐 UTF-16 单元切。例："a" 加半截 CSI 产生 ["a"] 与 CSI 余串；它不是 UTF-8 流式解码器，也不保证非 BMP 字符作为单事件输出。
function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	// 存已经提取的完整候选，元素仍是原始序列文字，不是动作对象。
	const sequences: string[] = [];
	// 当前消耗到的字符串下标从 0 开始。
	let pos = 0;

	// 只要原缓冲还有未处理单元就继续。
	while (pos < buffer.length) {
		// 取当前位置到末尾的剩余串，下面所有候选从它开头截。
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		// ESC 开头进入控制序列提取路径。
		if (remaining.startsWith(ESC)) {
			// 只有控制串前缀和特定回复头同时匹配才开启回复中止规则；只算一次，依据的是整个 remaining。
			const terminalReply = isControlString(remaining) && TERMINAL_REPLY_HEADER_PATTERN.test(remaining);
			// Find the end of this escape sequence
			// 先从单个 ESC 候选开始逐单元试探。
			let seqEnd = 1;
			// 每次最多试到当前剩余串的末尾。
			while (seqEnd <= remaining.length) {
				// 已识别回复头且已走过两个引导单元后，额外识别中止控制符或新的 ESC。
				if (terminalReply && seqEnd > 2) {
					// 读取本次新纳入候选的字符串单元。
					const char = remaining[seqEnd - 1];
					// CAN(0x18) 或 SUB(0x1a) 取消本回复字符串。
					if (char === "\x18" || char === "\x1a") {
						// CAN and SUB cancel the string, not subsequent keyboard input.
						// 消费回复直到取消符，整段不加入 sequences，后续输入从取消符之后继续。
						pos += seqEnd;
						// 退出内层候选循环，让外层重新处理剩余尾部。
						break;
					}
					// 中途遇到 ESC，后面已有字符且不是反斜杠，表明新序列而非 ST；尾部单独 ESC 先保留等待判定。
					if (char === ESC && seqEnd < remaining.length && remaining[seqEnd] !== "\\") {
						// A new escape sequence aborts an unterminated reply. Keep a
						// trailing ESC buffered until we can distinguish it from ST.
						// 丢弃未结束旧回复，但不消费新 ESC 本身，下一轮从它开始解析。
						pos += seqEnd - 1;
						// 结束旧回复候选的尝试。
						break;
					}
				}
				// 截取从开头到当前试探长度的候选。
				const candidate = remaining.slice(0, seqEnd);
				// 调用完整性判断器，可能需要再多一个单元。
				const status = isCompleteSequence(candidate);

				// 候选已完整时通常可以收集并前移。
				if (status === "complete") {
					// WezTerm with enable_kitty_keyboard sends the Escape key press as a
					// raw '\x1b' byte (simple text path in encode_kitty, ignoring
					// DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
					// sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
					// The buffer would normally treat '\x1b\x1b' as a complete meta-key
					// sequence (ESC + single char), leaving '[27;...u' to be typed as
					// plain text. If the character immediately following '\x1b\x1b'
					// would begin a new escape sequence, emit only the first ESC and
					// restart from the second.
					// 双 ESC 特例：只有其后还有能引入新转义的已知字符时，才把第一 ESC 拆成独立 Escape 事件。
					if (candidate === "\x1b\x1b") {
						// 查看双 ESC 后的下一单元，越界时为 undefined。
						const nextChar = remaining[seqEnd];
						// 下面任意前缀都说明第二个 ESC 可能属于新的终端序列。
						if (
							// [ 对应 CSI。
							nextChar === "[" || // CSI
							// ] 对应 OSC。
							nextChar === "]" || // OSC
							// O 对应 SS3。
							nextChar === "O" || // SS3
							// P 对应 DCS。
							nextChar === "P" || // DCS
							// _ 对应 APC。
							nextChar === "_" // APC
						) {
							// 仅收集第一个 ESC，避免把后续 Kitty 松键序列的载荷当作普通输入。
							sequences.push(ESC);
							// 只消费一个单元，第二 ESC 留待外层下一轮。
							pos += 1;
							// 结束这个候选分支，重新从第二个 ESC 解析。
							break;
						}
					}
					// 一般完整候选原样追加，尚不转换到具体按键。
					sequences.push(candidate);
					// 把扫描位置前移整个候选长度。
					pos += seqEnd;
					// 一个候选已处理，退出试探循环。
					break;
					// 不完整则还需要增加候选长度。
				} else if (status === "incomplete") {
					// 再纳入下一个字符串单元检查。
					seqEnd++;
					// 保留 not-escape 回退分支；正常 remaining 以 ESC 开始时不会走到。
				} else {
					// Should not happen when starting with ESC
					// 仍将当前候选收集，避免解析器停在原地。
					sequences.push(candidate);
					// 消费候选长度。
					pos += seqEnd;
					// 退出内层试探，外层继续。
					break;
				}
			}

			// 试遍当前剩余串仍未完整，不能继续分割这条尾部。
			if (seqEnd > remaining.length) {
				// 返回已提取部分和完整剩余尾串，后续 process 将继续累积它。
				return { sequences, remainder: remaining };
			}
			// 普通文字走单元路径，不等待转义结束。
		} else {
			// Not an escape sequence - take a single character
			// 读取 remaining[0] 只有一个 UTF-16 单元，非 BMP 代理对会拆开；! 不增加运行时检查。
			sequences.push(remaining[0]!);
			// 只前移一个字符串下标。
			pos++;
		}
	}

	// 全部消费完毕，余串为空，返回完整序列数组。
	return { sequences, remainder: "" };
}

// 可选的缓冲策略；只定义字段类型，构造不额外校验数值范围，实际 setTimeout 按 Node 定时规则运行。
export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for an incomplete keyboard or mouse sequence
	 * (default: 50ms). Strings with a recognized terminal reply header wait for
	 * their terminator instead, so delayed replies cannot become keypresses.
	 * Ambiguous legacy Alt-key input still uses this timeout.
	 */
	// 普通不完整序列等待毫秒数，缺省 50；符合已识别回复头模式的余串不启用这个倒计时。
	timeout?: number;
	/**
	 * Maximum time to wait after a lone ESC before treating it as Escape
	 * (default: 10ms). Increase for high-latency Alt+key input (SSH).
	 */
	// 孤立 ESC 的独立等待毫秒数，缺省 10；调长可兼顾延迟较高的 Alt 输入，但会延迟独立 Escape 的分发。
	escapeTimeout?: number;
};

// EventEmitter 的泛型事件映射，约束事件名及参数元组，不会在运行时验证 emit 的参数。
export type StdinBufferEventMap = {
	// data 事件有且只有一个 string 参数；[string] 是单元素元组，不是任意长度 string[]。
	data: [string];
	// paste 事件同样一个字符串参数，内容不含开始/结束标记。
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
// 有状态的序列缓冲器；继承事件注册/分发，普通缓冲、粘贴缓冲和去重记录相互区分。监听器同步执行，返回的 Promise 不被这里等待。
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	// 待解析的普通尾串，包括尚未结束的控制序列。
	private buffer: string = "";
	// ReturnType<typeof setTimeout> 从函数类型取得返回句柄类型，typeof 在这里是类型查询，不执行定时器；null 表示当前无任务。
	private timeout: ReturnType<typeof setTimeout> | null = null;
	// 普通序列超时，构造后保持不变，readonly 仅为类型限制。
	private readonly timeoutMs: number;
	// 孤立 Escape 超时，独立于普通等待时长。
	private readonly escapeTimeoutMs: number;
	// 是否已进入括号粘贴模式。
	private pasteMode: boolean = false;
	// 粘贴正文及可能部分结束标记，未完成时不发普通 data。
	private pasteBuffer: string = "";
	// 上一条无修饰 Kitty 可打印形式的码点，下一条匹配的单单元原始字符可被丢掉一次。
	private pendingKittyPrintableCodepoint: number | undefined;

	// 创建空缓冲器，输入可选两种超时，保存默认值，无显式返回语句，不注册 stdin 或监听器。
	// 例：new StdinBuffer({escapeTimeout:100}) 增加 ESC/Alt 区分等待；调用方用 on("data",...)、on("paste",...) 订阅，再主动 process。
	constructor(options: StdinBufferOptions = {}) {
		// 初始化 EventEmitter 父类，派生类使用 this 前先 super。
		super();
		// 只对 null/undefined 回退 50，显式 0 会保留，最终遵循 setTimeout 规则。
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		// 独立保存孤立 ESC 时长，缺省 10，不复用 timeout 选项。
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
	}

	// 接收字符串或 Buffer 片段，返回 void；先取消旧超时、转字符串，按当前粘贴状态合并/拆分并同步发事件，余下普通半截输入再按策略计时。
	// 例：先 process(ESC+"[") 再 process("A")，足够快时发一条完整箭头；已识别终端回复可一直等终止符，粘贴也不设正文超时/大小上限。监听器异常会中断剩余分发，已写状态不回滚，不直接写终端。
	// Buffer 分片各自 toString，没有流式 UTF-8 解码状态，单个高字节还有历史 Alt 兼容规则，不能承诺任意字节边界都无损还原 Unicode。
	public process(data: string | Buffer): void {
		// Clear any pending timeout
		// 收到新片段先取消旧等待任务，之后按新余串重设倒计时。
		if (this.timeout) {
			// 取消还未触发的任务。
			clearTimeout(this.timeout);
			// 清掉句柄记录。
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		// 准备统一成字符串，let 允许分支分别赋值。
		let str: string;
		// 区分 string|Buffer 两种合法输入形式；这个联合类型的分支判断不是对字符串内容做校验。
		if (Buffer.isBuffer(data)) {
			// 单字节且最高位为 1 时采用历史 Meta/Alt 兼容映射，不按独立 UTF-8 字节解码。
			if (data.length === 1 && data[0]! > 127) {
				// 去掉高位，得到 0..127 的原始字符数值。
				const byte = data[0]! - 128;
				// 在该字符前加 ESC，模拟传统 Alt+字符形式。
				str = `\x1b${String.fromCharCode(byte)}`;
				// 其他 Buffer 路径按当前整片解码。
			} else {
				// 默认 UTF-8 toString，无跨 process 的 StringDecoder 缓冲，坏/拆开的字节不会由本类补回。
				str = data.toString();
			}
			// 调用方已经给字符串则不做 Buffer 转换。
		} else {
			// 直接使用该字符串片段。
			str = data;
		}

		// 空输入且普通缓冲也空时仍发一个空 data；判断在 pasteMode 分支之前，因此不是所有粘贴状态下的空调用都必定静默。
		if (str.length === 0 && this.buffer.length === 0) {
			// 沿用普通去重/分发入口发送空串，会清掉上一 Kitty 去重候选。
			this.emitDataSequence("");
			// 空输入分支结束。
			return;
		}

		// 把本片段追加到现有普通余串，随后按模式处理。
		this.buffer += str;

		// 前次已进入粘贴模式时，优先把新数据作为正文，不解释其中按键。
		if (this.pasteMode) {
			// 普通尾串全部并入粘贴缓冲，其中也可能包含被分片的结束标记。
			this.pasteBuffer += this.buffer;
			// 清空普通缓冲，避免重复消费。
			this.buffer = "";

			// 从累积粘贴串找首个完整结束标记。
			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			// 找得到才完成粘贴，找不到保留缓冲等待下一片，不设超时。
			if (endIndex !== -1) {
				// 取结束标记之前正文，保留换行、tab、控制字节等原内容。
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				// 保留结束标记之后尾串，可能还有普通按键或下一次粘贴。
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				// 先退出粘贴模式，再同步通知监听器。
				this.pasteMode = false;
				// 清粘贴缓冲。
				this.pasteBuffer = "";
				// 粘贴边界打断前一 Kitty 原始字符去重候选。
				this.pendingKittyPrintableCodepoint = undefined;

				// 同步发 paste 事件，不在此重新包标记；ProcessTerminal 的监听器会包回供编辑器处理。
				this.emit("paste", pastedContent);

				// 本片段还有尾部才继续解析。
				if (remaining.length > 0) {
					// 递归调用 process，按普通状态或下一次粘贴处理尾部；若 paste 监听器抛错，这一步不会执行。
					this.process(remaining);
				}
			}
			// 粘贴路径已处理或等待，不再走普通序列超时。
			return;
		}

		// 还没进入粘贴时，在累积普通缓冲中寻找完整开始标记，因此开始标记可以跨多次 process 片段拼起来。
		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		// 发现标记后切换模式。
		if (startIndex !== -1) {
			// 标记前有普通内容则先解析它。
			if (startIndex > 0) {
				// 取开始标记之前的串。
				const beforePaste = this.buffer.slice(0, startIndex);
				// 只从这段中提取完整序列；此分支没有保留 result.remainder，前置半截转义若存在会被舍弃。
				const result = extractCompleteSequences(beforePaste);
				// 按提取顺序发送标记之前的完整候选。
				for (const sequence of result.sequences) {
					// 通过去重入口发 data，监听器可同步运行或抛错。
					this.emitDataSequence(sequence);
				}
			}

			// 跨入粘贴边界前清去重候选。
			this.pendingKittyPrintableCodepoint = undefined;
			// 丢掉开始标记及前面已处理段，只留其后的本次片段内容。
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			// 开启粘贴模式。
			this.pasteMode = true;
			// 剩余所有文字先作为粘贴缓冲。
			this.pasteBuffer = this.buffer;
			// 普通缓冲清空。
			this.buffer = "";

			// 同一片段可能已包含结束标记，因此马上检查而不用等下一次 process。
			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			// 开始与结束都到齐就可立即发完整粘贴。
			if (endIndex !== -1) {
				// 读取纯正文，不含结束标记。
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				// 取结束标记后的尾串。
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				// 先复位模式再发事件。
				this.pasteMode = false;
				// 清除已消费正文缓冲。
				this.pasteBuffer = "";
				// 清除去重记录。
				this.pendingKittyPrintableCodepoint = undefined;

				// 同步发 paste，内容仍原样；处理器是否清换行由编辑器决定。
				this.emit("paste", pastedContent);

				// 还有尾部才再处理。
				if (remaining.length > 0) {
					// 递归解析后续内容，可能产生 data 或另一条 paste。
					this.process(remaining);
				}
			}
			// 开始标记路径结束，不在其后额外设置普通序列超时。
			return;
		}

		// 没有粘贴标记时按控制序列/普通单元拆分整个普通缓冲。
		const result = extractCompleteSequences(this.buffer);
		// 将未完成尾部保存起来，已完成序列留在 result 数组。
		this.buffer = result.remainder;

		// 按解析顺序逐条分发完整序列。
		for (const sequence of result.sequences) {
			// 每条都先经过 Kitty 原始重复字符去重。
			this.emitDataSequence(sequence);
		}

		// 仍有半截尾串才考虑等待策略。
		if (this.buffer.length > 0) {
			// Only a recognizable reply header establishes a delimited string.
			// Flushing it would turn a delayed tail into text and an OSC's BEL
			// terminator into Ctrl+G (the external editor shortcut). Other input,
			// including Alt+] followed by text, must retain bounded recovery.
			// 特定终端回复头模式一旦匹配，不设超时等待终止符/取消/新转义；避免延迟回复尾巴泄露为文字或 BEL 被当 Ctrl+G。不是所有控制串都有此待遇。
			if (TERMINAL_REPLY_HEADER_PATTERN.test(this.buffer)) return;
			// 余串恰是单 ESC 时采用更短的 escapeTimeout，否则用普通 timeout。
			const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
			// 注册超时回调，无参数/返回值；到时取出普通余串，歧义控制串拆成 Alt 前缀和重解析尾部，其余原样发送，监听器错误不在此捕获。
			this.timeout = setTimeout(() => {
				// flush 先清任务和普通缓冲，返回原始余串数组，不会自行 emit。
				const flushed = this.flush();

				// 遍历本次冲刷结果，正常最多一条整个余串。
				for (const sequence of flushed) {
					// 大于两个单元且为 OSC/DCS/APC 前缀的歧义串，需要保留 Alt+引导字符，再重解析后面的文字。
					if (sequence.length > 2 && isControlString(sequence)) {
						// Recover the Alt key and reparse its tail so batched text,
						// Enter, and control keys are not swallowed as one event.
						// 先只发前两个单元，如 ESC+] 表示传统 Alt+]。
						this.emitDataSequence(sequence.slice(0, 2));
						// 余下文本递归解析，里面的 Enter/控制键能成为各自事件，不被一整串吞掉。
						this.process(sequence.slice(2));
						// 其他类型的半截串使用直接发送路径。
					} else {
						// 原样发 data，即使它尚不是完整合法终端协议，也用于有限等待后的恢复。
						this.emitDataSequence(sequence);
					}
				}
				// 使用本次挑选的超时；没有 unref，任务清理由下一次 process/flush/clear/destroy 负责。
			}, timeoutMs);
		}
	}

	// 发送一条普通候选序列，无返回值；丢一次与紧前无修饰 Kitty 码点相同的单单元原始字符，否则更新候选并同步 emit。
	// 例：CSI-u 的 97 后紧接原始 a 时只留 CSI-u；不是任意文字去重，不会去重所有重复按键，非 BMP 单元拆分也不满足完整码点的一次匹配条件。
	private emitDataSequence(sequence: string): void {
		// 只有 sequence.length===1 才读原始码点，多单元序列（包括完整非 BMP 字符）不走此直接比对。
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		// 确有原始码点且与上一 Kitty 候选相同才丢弃。
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			// 消费后立刻清候选，所以后面再来一个相同原始字符仍可正常发出。
			this.pendingKittyPrintableCodepoint = undefined;
			// 此重复字符不触发 data 监听器。
			return;
		}

		// 当前序列若符合无修饰 Kitty 形状就记新码点，其余情况设 undefined，打断旧候选。
		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		// 同步通知所有 data 监听器；不会 await 监听器返回的 Promise，抛错向上传播。
		this.emit("data", sequence);
	}

	// 取出并清除普通缓冲，返回 [] 或包含整条余串的数组，不发事件、不清 paste 模式/正文。
	// 例：半截 CSI 显式 flush() 得到 [该余串]，调用方自己决定如何处理；普通缓冲为空时仅清计时器，不清 pendingKittyPrintableCodepoint。
	flush(): string[] {
		// 有待执行超时才先取消。
		if (this.timeout) {
			// 阻止之后的自动冲刷回调。
			clearTimeout(this.timeout);
			// 句柄设回 null。
			this.timeout = null;
		}

		// 普通缓冲为空就没有待返回内容；粘贴缓冲并不算在此长度中。
		if (this.buffer.length === 0) {
			// 直接返回新空数组，保留其他模式状态。
			return [];
		}

		// 将整个余串作为一条结果，不再尝试解析成更细输入。
		const sequences = [this.buffer];
		// 普通缓冲已被取出，清空它。
		this.buffer = "";
		// 有实际冲刷内容时清去重候选。
		this.pendingKittyPrintableCodepoint = undefined;
		// 返回结果，不自动 emit data。
		return sequences;
	}

	// 清所有缓冲、模式与去重记录并取消任务，无参数/返回值，不发事件、不移除监听器。
	// 例：放弃尚未完成的粘贴后 clear()，下次 process 重新按普通状态解析；此方法不永久关闭实例。
	clear(): void {
		// 存在任务才取消。
		if (this.timeout) {
			// 取消等待回调。
			clearTimeout(this.timeout);
			// 清句柄。
			this.timeout = null;
		}
		// 丢弃普通余串，不发给订阅者。
		this.buffer = "";
		// 复位粘贴模式。
		this.pasteMode = false;
		// 丢弃尚未完成粘贴正文。
		this.pasteBuffer = "";
		// 清重复字符候选。
		this.pendingKittyPrintableCodepoint = undefined;
	}

	// 读取普通未完成尾串，返回字符串，无副作用。例：粘贴进行中正文在 pasteBuffer，这里可能返回 ""，不能用它断言完全没有待处理内容。
	getBuffer(): string {
		// 只返回 buffer，不合并粘贴缓冲。
		return this.buffer;
	}

	// 清理当前解析资源，无参数/返回值，实际仅调用 clear，不移除 EventEmitter 监听器、不禁止复用。
	// 例：停止终端时 destroy() 取消任务和待处理数据；之后显式 process 仍能发事件，不能把它解释为永久销毁对象。
	destroy(): void {
		// 委托清任务、普通/粘贴缓冲和去重状态。
		this.clear();
	}
}
