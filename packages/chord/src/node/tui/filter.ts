// The terminal's output filter (slice 11 §4; p2's `tui-filter.ts`): the only path from the sandbox to the real
// terminal. A frame's text and the escape sequences a terminal UI needs to draw pass (cursor moves, erasing, colours,
// the alternate screen, bracketed paste, synchronized output, mouse reporting); every other sequence is dropped, so
// sandboxed code cannot set the clipboard (OSC 52), retitle or reconfigure the terminal, or smuggle a sequence across
// frames: an unterminated one ends with its frame.
//
// 文件导读
// 所属：packages/chord 的 Node 终端启动器模块（node/tui），是沙箱与真实终端之间的输出安全层。
// 职责边界：这是沙箱输出进入真实终端的唯一通道；它只做字符串过滤，不做 I/O、不修改输入、不持有状态。
// 上游是 launcher.ts 的 #write：沙箱 `write` 帧先经过这里；下游是 Node 终端输出流。正常结果是过滤后的新字符串；
// 超过 64 KiB（字符数或 UTF-8 字节数）时抛 RangeError，由 launcher 丢弃该帧。
// 能力清单：
// - MAX_FRAME：单帧上限 64 KiB 的常量，同时限制内存与可夹带的序列长度。
// - filterOutput：逐字符扫描一帧输出，只保留白名单序列与可打印字符。
// - escapeAt（私有）：解析 ESC/C1 引导的一个转义序列，返回结束位置与可保留的规范序列。
// - allowedCsi（私有）：判断 CSI 参数与终止字符是否在白名单内。
// - ESC、MODES：ESC 字符常量与允许的 DEC 私有模式编号集合。
// 组合与顺序：filterOutput 遇到 ESC 或 C1 调用 escapeAt；CSI 分支再调用 allowedCsi；控制串（OSC/DCS 等）整段丢弃。
// 设计要点：采用白名单而非黑名单，未终止的序列只吃到帧尾，不会跨帧延续，因此沙箱无法把序列拆成两帧绕过检查。
// 示例：filterOutput("a\x1b[31mb") 返回同样的红色文本；filterOutput("\x1b]52;c;...\x07") 返回空字符串。
// 阅读顺序：先看 MAX_FRAME/filterOutput 的主循环，再看 escapeAt 的 CSI 与控制串分支，最后看 allowedCsi 的规则。

/** The longest frame the sandbox may write. */
// 单帧上限 64 KiB：既限制内存，也限制一次可夹带的转义序列长度。
export const MAX_FRAME = 64 * 1024;

// ESC 控制字符的码元，后面多处使用。
const ESC = "\x1b";

/** DEC private modes output may set: cursor visibility, bracketed paste, sync, alternate screen, autowrap, mouse. */
// 允许设置的 DEC 私有模式编号白名单：25 光标可见性、2004 括号粘贴、2026 同步输出、
// 1049 备用屏幕、7 自动换行、1000/1002/1006/1004 鼠标与焦点事件。
// ReadonlySet 只是编译期标注，运行时仍是可变 Set 对象；这里没有防御性冻结。
const MODES: ReadonlySet<string> = new Set(["25", "2004", "2026", "1049", "7", "1000", "1002", "1006", "1004"]);

/** `output` with only the allowed sequences; throws for a frame over `MAX_FRAME`. */
// 过滤一帧终端输出：输入沙箱给的字符串，返回只含白名单序列/可打印字符的新字符串。
// 副作用：无。错误：字符数或 UTF-8 字节数超过 MAX_FRAME 时抛 RangeError（调用方会丢弃该帧）。
// 主流程：逐字符扫描；遇到 ESC 或 C1 控制符（0x80-0x9f）交给 escapeAt 判断是否保留；其余只保留 tab、
// 换行、回车和可打印字符。例子：`"a\x1b[31mb"` 保留为原样（红色），而 `"\x1b]52;c;…\x07"` 被整段删除。
export function filterOutput(output: string): string {
	// 用字符数和 UTF-8 字节数双重限制：多字节字符可能让字节数远超 length。
	if (output.length > MAX_FRAME || Buffer.byteLength(output) > MAX_FRAME) {
		throw new RangeError("terminal: a frame over 64 KiB");
	}
	// kept 累积允许输出的内容；遍历时会跳过被处理的序列，所以是 O(n) 一次扫描。
	let kept = "";
	for (let index = 0; index < output.length; index++) {
		// charCodeAt 返回 UTF-16 码元；C1 区（0x80-0x9f）在某些终端也会被当作控制序列引导符。
		const code = output.charCodeAt(index);
		if (code === 27 || (code >= 0x80 && code <= 0x9f)) {
			// 解构返回 [最后字符的索引, 保留的序列]；空字符串表示整段丢弃。
			const [next, sequence] = escapeAt(output, index);
			// 直接跳到序列末尾，避免把序列内部字符当普通文本复制。
			index = next;
			kept += sequence;
			continue;
		}
		// 普通文本只放行 TAB(9)、LF(10)、CR(13)、0x20 以上的可打印字符，排除 DEL(0x7f)。
		if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code !== 0x7f)) kept += output[index];
	}
	return kept;
}

/** The escape at `index`: the index of its last character, and the sequence kept (`""` when dropped). */
// 解析从 `start` 开始的一个转义序列：返回 [最后一个相关字符的下标, 需保留的规范序列]。
// 丢弃时第二个元素是空字符串；未终止的控制串会一直吃到帧尾，不会跨帧延续到下一次调用。
// 这里的“规范序列”会重新用 `\x1b[` 拼接，因此 C1 单字节 CSI 也会统一成 ESC [ 形式。
function escapeAt(output: string, start: number): [number, string] {
	let index = start;
	// 先读引导符：ESC 后面一个字符才是真正的 introducer；C1 引导符本身就占一个码元。
	const code = output.charCodeAt(index);
	// `++index` 先自增再取值；`?? ""` 处理 ESC 恰好在帧尾、没有后续字符的情况。
	const introducer = code === 27 ? (output[++index] ?? "") : output[index]!;
	// CSI：`ESC [` 或单字节 0x9b。参数字节范围 0x20-0x3f，最后是 0x40-0x7e 的终止字符。
	if (introducer === "[" || code === 0x9b) {
		const body = index + 1;
		// 扫描参数字节；循环条件保证不越过字符串末尾。
		while (
			index + 1 < output.length &&
			output.charCodeAt(index + 1) >= 0x20 &&
			output.charCodeAt(index + 1) <= 0x3f
		) {
			index++;
		}
		// 终止字符；帧尾截断则为空字符串，后续 allowedCsi 会拒绝保留。
		const final = output[++index] ?? "";
		// body 是参数字节，交给白名单判断具体动作。
		const text = output.slice(body, index);
		// 只有完整的 ESC [（不是单字节 C1）且通过 allowedCsi 才保留；否则整段丢弃。
		return [index, code === 27 && final !== "" && allowedCsi(text, final) ? `${ESC}[${text}${final}` : ""];
	}
	// 控制串：OSC `]`、DCS `P`、SOS `X`、PM `^`、APC `_`，以及对应的 C1 字节 0x90/0x98/0x9d/0x9e/0x9f。
	if ((introducer !== "" && "]PX^_".includes(introducer)) || [0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
		// A control string (OSC, DCS, ...): dropped up to its terminator, or the end of the frame.
		// 一直跳到 BEL(0x07) 或 ST(0x9c / ESC \)，或者帧尾；无论内容是什么都不保留。
		while (++index < output.length) {
			if (output.charCodeAt(index) === 0x9c || output.charCodeAt(index) === 7) break;
			if (output[index] === ESC && output[index + 1] === "\\") return [index + 1, ""];
		}
		return [index, ""];
	}
	// Any other ESC sequence with its intermediates (charset selection, ...): dropped.
	// 其他 ESC 序列（如字符集选择）连同中间字节一起跳过，不输出。
	while (index < output.length && output.charCodeAt(index) >= 0x20 && output.charCodeAt(index) <= 0x2f) index++;
	return [index, ""];
}

/** Whether the CSI sequence with parameters `body` and final `final` may reach the terminal. */
// CSI 白名单：`body` 是参数字节，`final` 是动作字符；返回 true 才允许到达真实终端。
// 规则按动作分组：模式设置只允许 DEC 私有模式白名单；SGR(m) 允许数字/分号/冒号且禁止五位数字；
// 移动、擦除、滚动区域等限制参数个数与位数；s/u 只允许无参数形式。
function allowedCsi(body: string, final: string): boolean {
	// 参数过长本身就是可疑输入，直接拒绝，避免正则回溯和终端解析负担。
	if (body.length > 128) return false;
	// h/l 是设置/重置模式：只接受 `?` 开头的 DEC 私有模式，且编号在 MODES 白名单。
	if (final === "h" || final === "l") return body.startsWith("?") && MODES.has(body.slice(1));
	// m 是 SGR（颜色/样式）：允许数字、分号、冒号；五位以上数字拒绝（例如超长参数注入）。
	if (final === "m") return /^[\d;:]*$/.test(body) && !/\d{5}/.test(body);
	// 其余动作先要求只含数字和分号，且有五位数字的一律拒绝。
	if (!/^[\d;]*$/.test(body) || /\d{5}/.test(body)) return false;
	// 光标移动 A-F、G、H、f 等：最多允许由分号分隔的 1 个或 2 个参数。
	if ("ABCDEFGHfd".includes(final)) return body.split(";").length <= ("Hf".includes(final) ? 2 : 1);
	// J/K 擦除：参数只能是 0、1、2 或省略。
	if (final === "J" || final === "K") return /^[012]?$/.test(body);
	// r 设置滚动区域：允许省略或 `上;下` 各最多 4 位数字。
	if (final === "r") return /^(?:\d{1,4};\d{1,4})?$/.test(body);
	// s/u 只有无参数形式（保存/恢复光标）；其他动作一律拒绝。
	return (final === "s" || final === "u") && body === "";
}
