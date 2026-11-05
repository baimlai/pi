/**
 * Bounded output streams and adaptive progress commits: `OutputBuffer` keeps a head or tail window of a stream at a cost
 * proportional to each chunk, and `Progress` paces commits of a changing value by their size.
 */
//
// 文件导读
// 所属：packages/chord 的根级输出工具模块，供工具调用、进程输出和进度提交等场景复用。
// 职责边界：只做“有界保留/精确切片/清洗”与“按写入量节流提交”，不负责 I/O、不决定 UI、不持久化。
// 上游：调用方把字符串块或字节块推入 OutputBuffer，或对 Progress 调用 mark/markAndWait；下游：snapshot 返回文本与
// 丢弃计数，Progress 的 write 回调返回本次写入字节数。错误：非法配置在 push 时抛 Error；Progress 的 write 拒绝会
// 交给 onError，并拒绝对应 waiter。
// 能力清单：
// - OutputLimits / BoundedOutput / OutputSlice / OutputSkip：保留策略、快照结果、精确切片与“上游省略输出”的描述。
// - sanitizeOutput：去掉转义序列和破坏显示的 C0/C1 控制字符，保留 tab 与换行。
// - boundOutput：按 head/tail、maxBytes/maxLines 取精确的整行切片，单行过长时按字符边界截断。
// - characterEnd / characterStart（私有）：向前/向后找 UTF-8 字符边界。
// - OutputBuffer：增量接收块，维护总字节/行数与窗口，snapshot 给出清洗后的有界输出和精确丢弃量。
// - utf8ByteLength / countNewlines：独立于 Buffer 的 UTF-8 字节数和换行统计。
// - PROGRESS_BYTES_PER_SECOND：进度提交的节流速率（100 KiB/s）。
// - ProgressClock / SYSTEM_CLOCK：可注入的时钟与定时器。
// - Progress：自适应提交器，空闲后立即提交，之后按最小间隔与写入量延迟，合并期间的变更。
// 组合与顺序：数据流 chunk → OutputBuffer.push（必要时先 #skip）→ snapshot → boundOutput → sanitizeOutput；
// 进度流 mark → #schedule → #flush → write() 返回字节数 → 计算下次时间 → 合并 #dirty。
// 示例：`const out = new OutputBuffer({ maxBytes: 4096, maxLines: 100, retain: "tail" });
// out.push("line\n"); const snapshot = out.snapshot();`
// 阅读顺序：先看四个类型与 sanitizeOutput/boundOutput，再看 headRange/tailRange 与字符边界，然后 OutputBuffer，
// 最后看 Progress 的 mark/schedule/flush。

/** Retention limits of one output stream. */
// 保留策略：retain 是字面量联合 "head" | "tail"，运行时没有校验；maxBytes/maxLines 任一为 0 表示不保留。
// readonly 只在编译期阻止改写字段。
export type OutputLimits = { readonly maxBytes: number; readonly maxLines: number; readonly retain: "head" | "tail" };

/** Retained output and what the limits dropped. */
// 快照结果：text 是清洗后的保留文本；droppedBytes/droppedLines 是相对“整个流”的丢弃量（不是仅本次窗口）。
export type BoundedOutput = { readonly text: string; readonly droppedBytes: number; readonly droppedLines: number };

/** An exact slice of the input within the limits, and what it left out. */
// boundOutput 的结果：text 与 bytes 是切出的部分；dropped* 是切掉的量。
// bytes 是 UTF-8 字节数，不是字符数；text 可能因解码边界而不同于原字符串的简单子串。
export type OutputSlice = {
	readonly text: string;
	readonly bytes: number;
	readonly droppedBytes: number;
	readonly droppedLines: number;
};

/**
 * Output a producer omitted before a chunk, measured on the decoded text: every U+FFFD counts as three bytes, and no
 * sanitizing is applied.
 */
// 描述生产者在一块数据之前省略掉的输出。它是“计数”接口而不是文本：调用方已经丢弃了内容，只报告尺寸信息。
// 只有 retain 为 tail 时 OutputBuffer 才接受 skip（head 窗口无法跳过中间内容仍保持精确行数）。
// 字段：bytes 是省略文本的 UTF-8 字节数（无效字符 U+FFFD 按 3 字节计）；newlines 是 U+000A 数量；
// endsWithNewline 用于判断最后一行是否已结束。这些值必须来自与后续 chunk 相同的解码口径。
export interface OutputSkip {
	/** UTF-8 byte length of the omitted text. */
	readonly bytes: number;
	/** Newlines (U+000A) in the omitted text. */
	readonly newlines: number;
	/** Whether the omitted text ends with a newline. */
	readonly endsWithNewline: boolean;
}

// 换行字节值；用常量避免在循环里重复写 0x0a。
const NEWLINE = 0x0a;
// 需要清除的控制字符：0x00-0x08、0x0b-0x1f（保留 TAB 0x09 与 LF 0x0a，CR 0x0d 会被清除），
// 以及 U+FFF9-FFFB 注解字符；DEL(0x7f) 不在此列，由调用方另行处理。正则带 g，用于全局替换。
const INVALID_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;
/** Whole 7-bit escape sequences: strings (OSC, DCS, APC, PM, SOS) up to BEL or ST, CSI, and short `ESC x` forms. */
// 匹配完整的 7 位转义序列，分三支（|）：
// 1. 控制串：ESC 后跟 ] P X ^ _ 之一，内容直到 BEL(0x07) 或 ST(ESC \)；OSC/DCS/APC/PM/SOS。
// 2. CSI：ESC [ 参数字节 0x30-0x3f、中间字节 0x20-0x2f、终止字节 0x40-0x7e。
// 3. 短 ESC 序列：中间字节 0x20-0x2f 加终止字节 0x30-0x7e（如字符集选择）。
// 未终止的序列不会被完整匹配，因此保留原样（后续 INVALID_OUTPUT 会清掉 ESC 本身）。
const ESCAPE_SEQUENCE =
	/\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\x20-\x2f]*[\x30-\x7e]/g;
// 共享的编码器/解码器：构造一次，避免每块都分配。TextEncoder 总是 UTF-8。
const encoder = new TextEncoder();
/** Slices decode exactly: a U+FEFF at a slice's start is text, not a byte-order mark. */
// ignoreBOM: true 让切片中间的 U+FEFF 保留为普通字符，只有流最开头才可能被当作 BOM（由 OutputBuffer 单独处理）。
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Remove escape sequences and control characters that break display and transcripts; tabs and newlines stay. */
// 清洗显示文本：先删完整转义序列，再删不可见控制字符。输入字符串，返回新字符串；无副作用。
// 先删序列再删控制字符，避免只删掉 ESC 却留下序列参数文本。
// 示例：sanitizeOutput("\x1b[31mred\x1b[0m") 返回 "red"；tab 与换行保留。
export function sanitizeOutput(text: string): string {
	return text.replace(ESCAPE_SEQUENCE, "").replace(INVALID_OUTPUT, "");
}

/**
 * Bound `text` to whole lines within the limits: the first lines for `head`, the last lines for `tail`. The result is an
 * exact slice, trailing newline included. A single line longer than `maxBytes` is cut at the byte limit on a character
 * boundary.
 */
// 把 text 限制在 limits 内，返回切片与丢弃统计。
// 先编码成 UTF-8 字节，再按 head/tail 求字节区间；kept 是共享底层内存的 subarray 视图。
// 若整段都保留，直接返回原字符串，避免解码损失；否则用 decoder 解码，保证不切断多字节字符。
// droppedLines 用“总行数 - 保留行数”，边界行按是否以换行结束计算。
// 示例：tail、maxLines=2、text="a\nb\nc\n" 返回 "b\nc\n" 及丢弃计数。
export function boundOutput(text: string, limits: OutputLimits): OutputSlice {
	const bytes = encoder.encode(text);
	// 解构元组 [from, to)；head 与 tail 各自决定区间。
	const [from, to] = limits.retain === "head" ? headRange(bytes, limits) : tailRange(bytes, limits);
	const kept = bytes.subarray(from, to);
	return {
		text: kept.length === bytes.length ? text : decoder.decode(kept),
		bytes: kept.length,
		droppedBytes: bytes.length - kept.length,
		droppedLines: lineCount(bytes) - lineCount(kept),
	};
}

// 计算 head 策略的结束下标：从头数 maxLines 个换行（包含换行本身），再受 maxBytes 限制。
// maxLines 或 maxBytes 为 0 时返回空区间 [0,0]。
function headRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [0, 0];
	let end = bytes.length;
	let lines = 0;
	// indexOf 从当前位置向后找换行；每找到一个行数加一，达到上限就把 end 定在该换行之后。
	for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, index + 1)) {
		if (++lines === limits.maxLines) {
			end = index + 1;
			break;
		}
	}
	// 行数满足但字节超限：尝试在限制内找最后一个换行，保留完整行；找不到换行则在字节上限处按字符边界截断。
	if (end > limits.maxBytes) {
		const newline = bytes.lastIndexOf(NEWLINE, limits.maxBytes - 1);
		end = newline === -1 ? characterEnd(bytes, limits.maxBytes) : newline + 1;
	}
	return [0, end];
}

// 计算 tail 策略的起始下标：从末尾向前数 maxLines 行，再受 maxBytes 限制。
// 空/零限制返回空区间 [length,length]。
function tailRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [bytes.length, bytes.length];
	// A trailing newline ends the last line rather than starting another.
	// 若最后一个字节是换行，从它的前一个字节开始向前找，避免把结尾换行当成新的一行。
	const last = bytes[bytes.length - 1] === NEWLINE ? bytes.length - 2 : bytes.length - 1;
	let start = 0;
	let lines = 1;
	// 从 last 向前找换行；lines 表示当前已覆盖的行数。找到第 maxLines 个换行时，start 设为其后一个字节。
	for (let index = last < 0 ? -1 : bytes.lastIndexOf(NEWLINE, last); index !== -1; ) {
		if (lines === limits.maxLines) {
			start = index + 1;
			break;
		}
		lines++;
		// index 为 0 时没有更早的换行，置 -1 结束循环。
		index = index === 0 ? -1 : bytes.lastIndexOf(NEWLINE, index - 1);
	}
	// 字节超限：从末尾回退 maxBytes 得到 from；优先取窗口内第一个换行之后的内容（保持整行），
	// 若窗口内没有可用换行（例如最后一行本身超长），则在字符边界截断。
	if (bytes.length - start > limits.maxBytes) {
		const from = bytes.length - limits.maxBytes;
		const newline = bytes.indexOf(NEWLINE, from - 1);
		// The first line starting inside the byte window, or a cut of the last line when it alone is too long.
		start = newline !== -1 && newline + 1 < bytes.length ? newline + 1 : characterStart(bytes, from);
	}
	return [start, bytes.length];
}

/** The last character boundary at or before `index`. */
// 找“不晚于 index 的最后一个字符边界”。UTF-8 续字节形如 10xxxxxx（& 0xc0 === 0x80），
// 向前跳过续字节，停在一个起始字节处。导出供需要按字节截断的其他模块复用。
// `?? 0` 处理 index 等于 length（越界）时读到 undefined 的情况。
export function characterEnd(bytes: Uint8Array, index: number): number {
	let end = index;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return end;
}

/** The first character boundary at or after `index`. */
// 找“不早于 index 的第一个字符边界”：向后跳过续字节。用于 tail 截断时避免从字符中间开始。
function characterStart(bytes: Uint8Array, index: number): number {
	let start = index;
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return start;
}

// 统计字节序列的行数：空串为 0；否则换行数加上“最后一行是否未终止”。
// 例如 "a\n" 为 1 行，"a\nb" 为 2 行。
function lineCount(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;
	let newlines = 0;
	for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, index + 1)) newlines++;
	return newlines + (bytes[bytes.length - 1] === NEWLINE ? 0 : 1);
}

/**
 * Bounded running output of one stream, such as a tool call's or a process's. Accepting a chunk costs time proportional to the chunk: head retention stops
 * storing once the window is full, and tail retention drops stored text the window no longer needs when it snapshots.
 * Counts of the whole stream are kept so the dropped totals stay exact.
 */
// 有界输出缓冲：随着 push 增量保存 head 或 tail 窗口。每个 chunk 只处理一次，成本与 chunk 大小成正比。
// head 策略在窗口满后停止存储；tail 策略在 snapshot 时丢弃不再需要的开头 chunk。
// 同时维护整个流的 totalBytes/totalNewlines，因此 dropped* 能保持精确。
// 不负责输出到任何地方；snapshot 才生成清洗后的结果。
export class OutputBuffer {
	readonly #limits: OutputLimits;
	/**
	 * Decoder of byte chunks. A string chunk or a skip ends an incomplete character of earlier bytes (it becomes U+FFFD);
	 * the next byte chunk then starts a new character. As in `StreamDecoder`, only a byte-order mark at the very start of
	 * the output is dropped, never a U+FEFF later in it.
	 */
	// 流式解码器：字节块可能切断多字节字符，decode(chunk, { stream: true }) 会保留不完整尾部。
	// 遇到字符串块或 skip 时先 decode() 冲掉不完整字符（变成 U+FFFD），再处理新内容。
	// ignoreBOM 保证只有输出最开头的 BOM 会被去掉（代码在 push 中显式处理），后续 U+FEFF 保留为文本。
	readonly #decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	// 是否已经接收过任何内容（含 skip）；用于判断 BOM 是否位于流的最开始。
	#started = false;
	/** Stored chunks: for head the start of the stream, for tail a suffix that still contains the next window. */
	// 存储的块及其预计算尺寸；tail 策略保留“比窗口多一行/一字节”的后缀，便于下次定位行首。
	#chunks: { readonly text: string; readonly bytes: number; readonly newlines: number }[] = [];
	// 当前存储的字节数与换行数（不是整个流）。
	#storedBytes = 0;
	#storedNewlines = 0;
	// head 窗口是否已满；满后不再追加存储，但继续计数。
	#full = false;
	// 整个流的累计字节数、换行数，以及流是否以换行结束（初始 true 表示空流视为已终止）。
	#totalBytes = 0;
	#totalNewlines = 0;
	#endsWithNewline = true;

	// 只保存限制，不分配窗口；真正的存储从第一次 push 开始。
	constructor(limits: OutputLimits) {
		this.#limits = limits;
	}

	/** Bytes currently held; bounded by the limits plus one chunk. */
	// 当前实际存储的字节数（可能略超限制，因为按块存储；snapshot 才做精确切片）。
	get storedBytes(): number {
		return this.#storedBytes;
	}

	/**
	 * Accept a chunk; returns whether anything was accepted. `skipped` is output omitted right before the chunk, which
	 * must be more than the tail window by at least one byte or line; only tail retention accepts it.
	 */
	// 接收一块输出：chunk 可以是已解码字符串或原始字节；skipped 表示紧挨在这块之前被生产者省略的输出。
	// 返回是否接受了内容（空块且无 skip 返回 false）。副作用：更新窗口与全流计数。
	// 错误：只有 tail 策略支持 skip；head 下传 skip 抛 Error。字节块的不完整多字节字符会跨块保留。
	// 示例：push("hello") 返回 true；push(new Uint8Array([])) 返回 false。
	push(chunk: string | Uint8Array, skipped?: OutputSkip): boolean {
		// Bytes of an incomplete character from an earlier byte chunk come first.
		// 字符串块或 skip 会打断字节流，因此先 flush 解码器；纯字节块则保留不完整尾部到下次。
		const pending = typeof chunk === "string" || skipped !== undefined ? this.#decoder.decode() : "";
		// 字节块用 stream: true 增量解码；字符串块直接使用。
		let text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		// first 表示这是整个流的第一块（之前没有任何内容或 skip）。
		const first = !this.#started && pending === "" && skipped === undefined;
		// 只要出现了内容/待处理字符/skip，就标记已开始。
		if (pending !== "" || text !== "" || skipped !== undefined) this.#started = true;
		// 只有流开头的字节块才去掉 BOM；字符串块视为调用方已解码，不做 BOM 处理。
		if (first && typeof chunk !== "string" && text.startsWith("\ufeff")) text = text.slice(1);
		// 无 skip：把 pending 与 text 合并后交给 #accept（合并保证顺序正确）。
		if (skipped === undefined) return this.#accept(pending + text);
		// skip 只对 tail 有意义：head 窗口无法跳过中间内容仍保持精确计数。
		if (this.#limits.retain !== "tail") throw new Error("Skipped output requires tail retention");
		// 顺序：先处理之前的不完整字符，再记 skip，再处理当前文本。
		this.#accept(pending);
		this.#skip(skipped);
		this.#accept(text);
		return true;
	}

	/** Count omitted output; nothing stored before it can be in the window once the text after it arrives. */
	// 记录被省略的输出：累加全流计数，并清空已存储窗口——skip 之后的新文本才是 tail 窗口的候选，
	// 之前的存储不可能再进入最终窗口。bytes 为 0 时什么也不做。
	#skip(skipped: OutputSkip): void {
		if (skipped.bytes === 0) return;
		this.#totalBytes += skipped.bytes;
		this.#totalNewlines += skipped.newlines;
		this.#endsWithNewline = skipped.endsWithNewline;
		this.#chunks = [];
		this.#storedBytes = 0;
		this.#storedNewlines = 0;
	}

	/** Flush an incomplete trailing character as a replacement character; call when the stream ends. */
	// 流结束时调用：把解码器里残留的不完整字节冲成 U+FFFD 并计入窗口。没有残留则 #accept 返回 false。
	end(): void {
		this.#accept(this.#decoder.decode());
	}

	// 接收已解码文本：空串忽略；累加全流计数；head 满后只计数不存储；tail 在存储后从头部丢弃多余 chunk。
	// 返回是否接受了内容。
	#accept(text: string): boolean {
		if (text.length === 0) return false;
		// 预先计算尺寸，避免 snapshot 时重复扫描。
		const bytes = utf8ByteLength(text);
		const newlines = countNewlines(text);
		this.#totalBytes += bytes;
		this.#totalNewlines += newlines;
		this.#endsWithNewline = text.endsWith("\n");
		// head 窗口满后无需再保存任何文本，但仍要维持全流计数。
		if (this.#full) return true;
		this.#chunks.push({ text, bytes, newlines });
		this.#storedBytes += bytes;
		this.#storedNewlines += newlines;
		// head：一旦超过任一限制就标记满；注意“超过/达到”的差异与 tail 的余量策略无关。
		if (this.#limits.retain === "head") {
			// Nothing past a full window is ever needed.
			this.#full = this.#storedBytes > this.#limits.maxBytes || this.#storedNewlines >= this.#limits.maxLines;
			return true;
		}
		// Drop leading chunks while the rest still holds more than a window: more than `maxBytes` bytes or `maxLines`
		// newlines, plus one, so the window's line start can still be found. Each chunk is dropped once.
		// tail：保留比窗口多一字节/一行的余量，snapshot 重新定位行首时不会丢信息。
		while (this.#chunks.length > 1) {
			const first = this.#chunks[0]!;
			const bytesAfter = this.#storedBytes - first.bytes;
			const newlinesAfter = this.#storedNewlines - first.newlines;
			// 两个维度都仍有多余量才允许丢弃；余量不足就停止。
			if (bytesAfter <= this.#limits.maxBytes + 1 && newlinesAfter <= this.#limits.maxLines + 1) break;
			this.#chunks.shift();
			this.#storedBytes = bytesAfter;
			this.#storedNewlines = newlinesAfter;
		}
		return true;
	}

	/** Retained, sanitized output and what the limits dropped from the whole stream. */
	// 生成快照：合并存储块，按限制切出窗口，清洗文本，并用全流计数计算精确丢弃量。
	// 副作用：tail 策略会把存储压缩为“比窗口多一字节/一行”的最短后缀，减少后续内存。
	// 返回 BoundedOutput；不会清空累计计数。示例：push("a\nb\nc\n") 后 snapshot() 得到末尾两行。
	snapshot(): BoundedOutput {
		// 单块直接取文本；多块用 join 拼接。空块数组得到 ""。
		const stored =
			this.#chunks.length === 1 ? this.#chunks[0]!.text : this.#chunks.map((chunk) => chunk.text).join("");
		const kept = boundOutput(stored, this.#limits);
		// 存储部分自身的行数；空串或已以换行结尾视为终止（不再多算一行）。
		const storedLines = lines(this.#storedNewlines, stored === "" || stored.endsWith("\n"));
		const keptLines = storedLines - kept.droppedLines;
		// Tail windows never reach back before this one, but finding a later window's first line needs what precedes it:
		// keep the shortest suffix longer than the window by a byte or a line, as `#accept` does.
		// tail 或存在多块时压缩存储；head 单块无需压缩。
		if (this.#limits.retain === "tail" || this.#chunks.length > 1) {
			const text = this.#limits.retain === "tail" ? tailMargin(stored, this.#limits) : stored;
			const bytes = this.#limits.retain === "tail" ? utf8ByteLength(text) : this.#storedBytes;
			// 压缩成一个块（或清空）；新块的 newlines 重新统计。
			this.#chunks = text === "" ? [] : [{ text, bytes, newlines: countNewlines(text) }];
			this.#storedBytes = bytes;
			this.#storedNewlines = this.#chunks[0]?.newlines ?? 0;
		}
		return {
			text: sanitizeOutput(kept.text),
			// 丢弃字节数按全流计算；行数用全流行数减去保留行数。
			droppedBytes: this.#totalBytes - kept.bytes,
			droppedLines: lines(this.#totalNewlines, this.#endsWithNewline) - keptLines,
		};
	}
}

/**
 * The shortest suffix of `text` with more than `maxBytes` bytes or more than `maxLines` newlines, or all of it. The
 * tail window of any text that ends with this suffix, followed by anything, is the same as of `text` followed by it.
 */
// 返回 text 的最短后缀，使其字节数超过 maxBytes 或换行数超过 maxLines；若整段都不够长则返回全部。
// 作用：tail 窗口之后追加任意内容时，用这个后缀重新计算的窗口与用完整 text 计算的结果一致，
// 因此可以安全丢弃更早的内容。分别按字节和行找起点，取更靠后的那个（Math.max）。
function tailMargin(text: string, limits: OutputLimits): string {
	const bytes = encoder.encode(text);
	// 字节维度：若总字节超过上限，从倒数 maxBytes+1 个字节处再向前退到字符边界；否则从 0 开始。
	const byteStart = bytes.length > limits.maxBytes ? characterEnd(bytes, bytes.length - limits.maxBytes - 1) : 0;
	let lineStart = 0;
	let newlines = 0;
	// 从末尾向前数换行；超过 maxLines 时把 lineStart 设在该换行处（保留这个换行之前的内容）。
	for (let index = bytes.lastIndexOf(NEWLINE); index !== -1; index = bytes.lastIndexOf(NEWLINE, index - 1)) {
		if (++newlines > limits.maxLines) {
			lineStart = index;
			break;
		}
		if (index === 0) break;
	}
	// 两个起点取较大者，保证得到的后缀在两个维度上都足够长。
	const start = Math.max(byteStart, lineStart);
	return start === 0 ? text : decoder.decode(bytes.subarray(start));
}

/** Lines of text with `newlines` newlines; a final unterminated line counts. */
// 行数公式：换行数 + (未以换行终止 ? 1 : 0)。terminated 为 true 表示最后一行已由换行结束。
function lines(newlines: number, terminated: boolean): number {
	return newlines + (terminated ? 0 : 1);
}

// 描述可能存在的全局 Buffer，只声明用到的方法；浏览器/边缘环境可能没有 Buffer。
interface RuntimeBuffer {
	byteLength(content: string, encoding: "utf8"): number;
}

// 通过 globalThis 读取，避免直接引用 Node 全局导致非 Node 环境报错；类型断言只声明我们检查过的形状。
const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
// 匹配任意非 ASCII 字符；search 返回首个匹配下标，-1 表示纯 ASCII。
const nonAsciiPattern = /[^\x00-\x7f]/;

/** UTF-8 byte length of `content`; a lone surrogate counts as U+FFFD, three bytes. */
// 计算字符串的 UTF-8 字节长度。有 Buffer 时直接调用其高效实现；否则用纯 JS 回退。
// 回退逻辑：ASCII 每字符 1 字节；<=0x7ff 为 2 字节；代理对（高代理 + 低代理）为 4 字节；孤立代理按替换字符计 3 字节。
// 这与 TextEncoder 的行为一致，因此计数与编码/切片结果匹配。
// 示例：utf8ByteLength("a中") === 4；utf8ByteLength("😀") === 4。
export function utf8ByteLength(content: string): number {
	if (runtimeBuffer) return runtimeBuffer.byteLength(content, "utf8");
	// 先跳过前缀 ASCII，减少循环；没有非 ASCII 时字符数即字节数。
	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;
	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			// 高代理后必须紧跟低代理才是完整码点；是则占 4 字节并跳过下一个码元。
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

// 统计字符串中 "\n" 的数量；indexOf 循环避免 split 分配数组。
function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

/** Each progress commit also buys a pause proportional to what it wrote. */
// 进度提交的节流速率：每写入 100 KiB 就额外等待约 1 秒。用于让“持续变化的值”不会把下游打爆。
export const PROGRESS_BYTES_PER_SECOND = 100 * 1024;

/** The clock and timer progress commits pace on. */
// 可注入的时钟接口，便于测试不用真实等待：
// - now 返回毫秒时间戳；
// - setTimer 在约 delayMs 后调用一次 callback，并返回取消函数（调用后不再触发）。
// 结构类型：任何满足这两个成员的对象都可传入。
export type ProgressClock = {
	readonly now: () => number;
	/** Call `callback` once after about `delayMs`; returns a function that disarms it. */
	readonly setTimer: (callback: () => void, delayMs: number) => () => void;
};

// 生产环境时钟：Date.now 与 setTimeout/clearTimeout。返回的取消函数闭包捕获 timer。
const SYSTEM_CLOCK: ProgressClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return () => clearTimeout(timer);
	},
};

/**
 * Adaptive progress commits: the first change after an idle period commits at once; each commit then delays the next
 * by at least `minIntervalMs` and by its written size at 100 KiB/s. At most one commit is in flight; changes made
 * meanwhile coalesce into the next one. Paces on `clock`, by default `Date.now` and `setTimeout`.
 */
// 自适应进度提交器：把一个“可写函数”包装成按节奏调用的提交器。
// 规则：空闲后第一次 mark 立即提交；每次提交根据 write 返回的写入字节数计算下一次最早时间
//（至少 minIntervalMs，或按 100 KiB/s 折合的时长）；同一时刻最多一个提交在途，期间的 mark 合并为下一次。
// 不负责生成内容；write 回调负责真正写入并返回字节数。错误交给 onError，同时拒绝本轮 waiter。
export class Progress {
	// 执行提交并返回本次写入字节数；onError 处理提交失败；minIntervalMs 是最小间隔；clock 可注入。
	readonly #write: () => Promise<number>;
	readonly #onError: (error: unknown) => void;
	readonly #minIntervalMs: number;
	readonly #clock: ProgressClock;
	// 等待“包含本次变更的提交”完成的调用方；每轮 flush 取走并 settle。
	#waiters: PromiseWithResolvers<void>[] = [];
	// 当前定时器的取消函数；undefined 表示没有排队。
	#timer: (() => void) | undefined;
	// 在途提交；undefined 表示空闲。
	#inFlight: Promise<void> | undefined;
	// 下一次允许提交的时间戳；0 表示可以立即提交。
	#nextAt = 0;
	// 自上次提交后是否有新变更；用于合并。
	#dirty = false;
	// stop 后不再调度新提交。
	#stopped = false;

	// 构造函数只保存依赖；不启动定时器。
	constructor(
		write: () => Promise<number>,
		onError: (error: unknown) => void,
		minIntervalMs: number,
		clock: ProgressClock = SYSTEM_CLOCK,
	) {
		this.#write = write;
		this.#onError = onError;
		this.#minIntervalMs = minIntervalMs;
		this.#clock = clock;
	}

	/** Schedule a commit. */
	// 标记有变更并尝试调度；不返回 Promise，调用方不等待提交完成。
	// 若已有定时器或在途提交，本次变更会被后续 flush 合并。
	mark(): void {
		this.#dirty = true;
		this.#schedule();
	}

	/** Schedule a commit; the promise settles with the commit that includes this change. */
	// 标记变更并返回一个 Promise，它在“包含这次变更的那次提交”成功/失败时 settle。
	// Promise.withResolvers() 同时给出 promise 与 resolve/reject；存入 #waiters 后由 #flush 处理。
	markAndWait(): Promise<void> {
		const waiter = Promise.withResolvers<void>();
		this.#waiters.push(waiter);
		this.mark();
		return waiter.promise;
	}

	/** Stop committing and wait for the commit in flight; returns the waiters the final commit must settle. */
	// 停止调度：置 #stopped、取消定时器、等待当前提交结束，然后取走剩余 waiter 交给调用方处理。
	// 返回数组而不是自行 settle，是因为最终提交可能由调用方在 stop 之后执行（例如关闭流程）。
	async stop(): Promise<PromiseWithResolvers<void>[]> {
		this.#stopped = true;
		this.#timer?.();
		this.#timer = undefined;
		await this.#inFlight;
		return this.#waiters.splice(0);
	}

	// 调度核心：若已停止/已有定时器/已有提交在途，直接返回（不做额外工作）。
	// 计算距 nextAt 的等待时间；<=0 立即 flush，否则设一个定时器，回调中重新检查。
	#schedule(): void {
		if (this.#stopped || this.#timer !== undefined || this.#inFlight !== undefined) return;
		const wait = this.#nextAt - this.#clock.now();
		if (wait <= 0) this.#flush();
		else
			this.#timer = this.#clock.setTimer(() => {
				this.#timer = undefined;
				// Checks the clock again: a timer that fires early waits for the rest.
				// 定时器可能提前触发；再次进入 #schedule 会用剩余时间重新等待。
				this.#schedule();
			}, wait);
	}

	// 执行一次提交：清 dirty、取走 waiter、记录开始时间，调用 write。
	// 成功：nextAt = 开始时间 + max(最小间隔, 字节数/速率)，resolve waiters；
	// 失败：nextAt = 开始时间 + 最小间隔，reject waiters 并调用 onError。
	// finally：清除 inFlight；若期间又有变更，立即按新节奏调度。
	#flush(): void {
		if (this.#stopped || !this.#dirty) return;
		this.#dirty = false;
		const waiters = this.#waiters.splice(0);
		const started = this.#clock.now();
		this.#inFlight = this.#write()
			.then(
				(bytes) => {
					// 字节数按 100 KiB/s 换算为毫秒；与最小间隔取较大者。
					this.#nextAt = started + Math.max(this.#minIntervalMs, (bytes * 1000) / PROGRESS_BYTES_PER_SECOND);
					for (const waiter of waiters) waiter.resolve();
				},
				(error: unknown) => {
					// 失败后至少等待一个最小间隔再重试，避免错误循环打满。
					this.#nextAt = started + this.#minIntervalMs;
					for (const waiter of waiters) waiter.reject(error);
					this.#onError(error);
				},
			)
			.finally(() => {
				this.#inFlight = undefined;
				if (this.#dirty) this.#schedule();
			});
	}
}
