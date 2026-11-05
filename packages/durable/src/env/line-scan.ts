// 文件导读
// 所属：packages/durable/src/env 的按行扫描实现，是 BinaryReader.scanLines 的核心。
// 解决的问题：文件可能很大，不能整块读入内存；调用者需要知道选中行在原始字节中的范围，以及这些行解码后的
// UTF-8 字节数（read 工具用它做分页和截断预算）。流式扫描必须与“一次性解码整个文件再按 \n 切分”一致，
// 包括文件开头 BOM 不计入解码长度、坏 UTF-8 字节被替换成 U+FFFD 后按 3 字节计算等细节。
// 职责边界：只处理字节和行号，不做 I/O、不打开文件、不缓存整份文件；push 的顺序由调用方保证。
// 上下游：上游是 node.ts 的 NodeBinaryReader.scanLines（按 64 KiB 读取并 push）；下游是 decode.ts 的
// rangeDecoder/startsWithBom。结果类型 LineScan 定义在 index.ts，由 read 工具消费。
// 能力清单：
// - LineScanner：有状态扫描器；push(chunk) 喂入字节，finish() 返回 LineScan。
// - decodedBytes(text)：内部辅助函数，计算文本的 UTF-8 字节数（空串为 0）。
// - 内部状态机：#releaseHead 处理跨块的 BOM 头，#process 查找 LF 并推进行号，#feed 把字节喂给仍打开的
//   解码器，#begin/#endFirstLine/#endSelection 维护选中范围的边界。
// 组合顺序：new LineScanner(startLine, endLine?) → 循环 push(chunk) → 最后调用一次 finish()。
// 示例（真实签名）：
//   const scanner = new LineScanner(1, 3);
//   scanner.push(new TextEncoder().encode("a\nb\nc\nd"));
//   const scan = scanner.finish();
//   // 选中零基行号 1、2（内容 "b" 和 "c"）；scan.start 是 "b" 的起始字节，scan.end 是 "c" 之后换行的位置，
//   // scan.selectedBytes 是文本 "b\nc" 的 UTF-8 长度 3。
// 建议阅读顺序：常量与 decodedBytes → LineScanner 字段 → constructor → push → #process → #feed → finish；
// #begin/#endFirstLine/#endSelection 是维护范围边界的辅助状态机。
import { rangeDecoder, startsWithBom } from "./decode.ts";
import type { LineScan } from "./index.ts";

// 按原始字节寻找 LF；CRLF 中的 CR 仍属于该行文本。编码器用于统计解码后文本的 UTF-8 长度。
const NEWLINE = 0x0a;
const encoder = new TextEncoder();

/** UTF-8 byte length of decoded text. */
/** 返回文本重新编码后的字节数，空串直接返回 0；例如“中”是 3 字节。它不等于原文件中坏 UTF-8 的字节数。 */
function decodedBytes(text: string): number {
	// TextEncoder.encode 分配 UTF-8 字节数组；length 是字节数，不是 JS 字符串的 UTF-16 长度。
	return text === "" ? 0 : encoder.encode(text).length;
}

/**
 * Computes a `LineScan` from a file's bytes fed in order, so an environment can scan any size in bounded memory. Decoded
 * sizes use the same streaming WHATWG decoder as decoding the whole file at once.
 */
/**
 * 流式行扫描器：一边接收原始字节，一边统计全文件的 LF 数，并记录选中行范围的原始偏移与解码后字节数。
 * “找行”用原始字节 0x0a 定位，“算长度”用两个独立的流式解码器累计，因此两者互不干扰。
 * 输入必须按文件顺序分块；finish 只应在最后调用一次，之后不应继续 push。
 */
export class LineScanner {
	// 目标是从 startLine（含）到 endLine（不含）的零基行号；Infinity 表示一直到文件末尾。
	readonly #startLine: number;
	readonly #endLine: number;
	// position 是已消费的原始字节数，newlines 是已遇到的 LF 数，lineStart 是当前行起始字节位置。
	#position = 0;
	#newlines = 0;
	#lineStart = 0;
	// undefined 表示尚未定位或尚未结束；这些偏移均指向原始文件，不是解码后的字符下标。
	#start: number | undefined;
	#end: number | undefined;
	#firstLineEnd: number | undefined;
	#lastLineStart: number | undefined;
	// 两个独立解码器同时累计整个选择区和第一行；结束后置 undefined，后续字节便不再进入它们。
	#selectedBytes = 0;
	#firstLineBytes = 0;
	#selection: InstanceType<typeof TextDecoder> | undefined;
	#firstLine: InstanceType<typeof TextDecoder> | undefined;
	/** The first bytes, held until it is known whether they are a byte-order mark. */
	/** 文件最前面的字节，暂存到能判断是否为 BOM 为止；最多 3 字节。 */
	#head: number[] | undefined = [];
	// 只有整个文件开头的 EF BB BF 会被当作 BOM 从解码长度里去掉。
	#bom = false;

	/** `startLine` and `endLine` must be non-negative integers with `endLine > startLine`; `endLine` absent: to the end. */
	/** 建立有状态扫描器；输入是行号范围，结果由 finish 取得，不读取文件。
	 * 例如 new LineScanner(1, 3) 选择第二、三行，范围外的字节仍会扫描以统计全文件 LF。
	 * TypeScript 的 number 包含小数、NaN 和 Infinity，所以这里的数值范围校验仍有必要，非法范围抛 RangeError。 */
	constructor(startLine: number, endLine = Number.POSITIVE_INFINITY) {
		// 起点必须是安全非负整数，终点必须严格大于起点。
		if (!Number.isSafeInteger(startLine) || startLine < 0 || !(endLine > startLine)) {
			throw new RangeError("Invalid line range");
		}
		// 终点允许 Infinity 这一特例；其他值仍必须是安全整数。
		if (endLine !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(endLine))
			throw new RangeError("Invalid line range");
		// 保存调用者指定的范围，后续 push 不再传行号。
		this.#startLine = startLine;
		this.#endLine = endLine;
		// 第一行从字节 0 开始，选中它时立即打开两个范围解码器。
		if (startLine === 0) this.#begin(0);
	}

	/** 按文件顺序喂入一块字节，更新计数，不返回文本；块可任意切分。
	 * 例如 BOM 分成 1+2 字节送入，仍等收齐前三字节再判断；调用者负责按顺序传同一文件。 */
	push(chunk: Uint8Array): void {
		// 头部尚未决出 BOM 时最多先扣住三个字节。
		if (this.#head !== undefined) {
			// 本次只取补满三个字节所需的数量；subarray 是原数组的视图，不复制内容。
			const take = Math.min(3 - this.#head.length, chunk.length);
			// ... 把字节逐项传给 push，head 是独立数组。
			this.#head.push(...chunk.subarray(0, take));
			// 不足三个字节暂不扫描；短文件会在 finish 中统一释放。
			if (this.#head.length < 3) return;
			// 确定 BOM 后先扫描扣住的字节，再处理当前块剩余部分，保证顺序。
			this.#releaseHead();
			chunk = chunk.subarray(take);
		}
		// 当前位置与 LF 计数由 process 统一推进。
		this.#process(chunk);
	}

	/** 将暂存头部交给正常扫描流程；只由 push/finish 在头部未释放时调用。例如两字节短文件也在这里计入 size。 */
	#releaseHead(): void {
		// ?? 仅在 null/undefined 时选右侧；转为 Uint8Array 供同一字节扫描逻辑使用。
		const head = Uint8Array.from(this.#head ?? []);
		// 清掉头部状态，后续块不会再重复等待前三字节。
		this.#head = undefined;
		// 先记 BOM 再扫描，feed 才知道应跳过哪些开头字节。
		this.#bom = startsWithBom(head);
		this.#process(head);
	}

	/** 扫描一块中的全部 LF 并喂入仍打开的文本范围；更新原始偏移。
	 * 例如块含 A\nB，先喂 A，关闭对应行范围，再决定换行是否属于后续选择区，最后喂 B。 */
	#process(chunk: Uint8Array): void {
		// base 把块内下标换算成文件绝对字节位置，from 跟踪本块尚未喂入的位置。
		const base = this.#position;
		let from = 0;
		// indexOf 找到下一个 LF；-1 表示当前块再无 LF。
		for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
			// The newline ends line `this.#newlines`. It belongs to the selection between selected lines only.
			// LF 前的内容属于当前行，先解码它，再关闭以此 LF 为终点的范围。
			this.#feed(chunk, base, from, index);
			const line = this.#newlines;
			const position = base + index;
			// 第一行和整个选择区均不包含它们最后的 LF。
			if (line === this.#startLine) this.#endFirstLine(position);
			if (line === this.#endLine - 1) this.#endSelection(position);
			// 选择区内部的 LF 会继续进入尚未关闭的 selection；已结束的 firstLine 不会再接收。
			this.#feed(chunk, base, index, index + 1);
			from = index + 1;
			// 跨过 LF 后进入下一行，记录新行起点并按目标行号开启选择区。
			this.#newlines++;
			this.#lineStart = position + 1;
			if (this.#newlines === this.#startLine) this.#begin(this.#lineStart);
			// 当进入最后一条所选行，保存其起点；终点超过文件时由 finish 退回实际末行起点。
			if (this.#newlines === this.#endLine - 1) this.#lastLineStart = this.#lineStart;
		}
		// 喂掉块尾没有 LF 的部分；即使没选中它，也要将文件位置推进整块长度。
		this.#feed(chunk, base, from, chunk.length);
		this.#position += chunk.length;
	}

	/** 标记输入结束，冲刷不完整 UTF-8 字符，返回偏移和解码长度；会修改内部结束状态。
	 * 例如选中不存在的第十行，返回 start=end=文件大小，两个解码长度为 0；本方法不是复用扫描器的重置入口。 */
	finish(): LineScan {
		// 短于三个字节的文件直到此时才释放头部。
		if (this.#head !== undefined) this.#releaseHead();
		const size = this.#position;
		// 尚未到达起始行：用文件末尾表示空选择，仍保留全文件 LF 数。
		if (this.#start === undefined) {
			return {
				newlines: this.#newlines,
				start: size,
				end: size,
				firstLineEnd: size,
				lastLineStart: size,
				selectedBytes: 0,
				firstLineBytes: 0,
			};
		}
		// 文件末尾也能结束一行；decoder.decode() 会把末尾残缺编码按默认规则替换成 U+FFFD。
		if (this.#firstLineEnd === undefined) this.#endFirstLine(size);
		if (this.#end === undefined) this.#endSelection(size);
		// 字段与 LineScan 契约对应；?? size 是未获得该偏移时的末尾后备值。
		return {
			newlines: this.#newlines,
			start: this.#start,
			end: this.#end ?? size,
			firstLineEnd: this.#firstLineEnd ?? size,
			// A selection that reaches past the last line ends with the last line.
			lastLineStart: this.#lastLineStart ?? this.#lineStart,
			selectedBytes: this.#selectedBytes,
			firstLineBytes: this.#firstLineBytes,
		};
	}

	/** 在选中行起点开启两个独立解码范围；例如单行选择同时把 lastLineStart 定在 start。 */
	#begin(start: number): void {
		// 保存原始起点；单行选择的首行与末行是同一行。
		this.#start = start;
		if (this.#startLine === this.#endLine - 1) this.#lastLineStart = start;
		// 解码器不自动丢 BOM，文件开头的 BOM 统一由 feed 的绝对偏移判断排除。
		this.#selection = rangeDecoder();
		this.#firstLine = rangeDecoder();
	}

	/** 记录首行终点并冲刷首行解码器；例如文件以残缺 UTF-8 结束也计入替换字符长度。 */
	#endFirstLine(position: number): void {
		// 将终点记为 LF 之前或文件尾；只给仍存在的解码器做最后一次冲刷。
		this.#firstLineEnd = position;
		if (this.#firstLine !== undefined) this.#firstLineBytes += decodedBytes(this.#firstLine.decode());
		// 关闭后后续 feed 不再累计第一行。
		this.#firstLine = undefined;
	}

	/** 记录整个选择区终点并冲刷解码器；不会包含终结这段选择的最后一个 LF。 */
	#endSelection(position: number): void {
		// 冲刷再关闭，避免分块边界的半个字符丢失。
		this.#end = position;
		if (this.#selection !== undefined) this.#selectedBytes += decodedBytes(this.#selection.decode());
		this.#selection = undefined;
	}

	/** Feed `chunk[from, to)`, which starts at file offset `base`, to the decoders of the ranges still open. */
	/** 把块的半开子区间喂给仍开放的两个解码器，只累计解码后的 UTF-8 字节数。
	 * 例如文件头有 BOM 时跳过绝对位置 0..2；文件中间的相同字节则照常计入。 */
	#feed(chunk: Uint8Array, base: number, from: number, to: number): void {
		// Decoding the whole file drops a leading byte-order mark.
		// 即使 BOM 跨分块，绝对偏移也能让这三个字节只被排除一次。
		if (this.#bom && base + from < 3) from = Math.min(to, 3 - base);
		// 跳过后为空就不创建视图、不调用解码器。
		if (to <= from) return;
		const bytes = chunk.subarray(from, to);
		// stream:true 暂存结尾半个 UTF-8 字符；两个解码器保有各自的边界状态。
		if (this.#selection !== undefined) {
			this.#selectedBytes += decodedBytes(this.#selection.decode(bytes, { stream: true }));
		}
		if (this.#firstLine !== undefined) {
			// 第一行在结束时已关闭，因此不会误把后续行的字节加进来。
			this.#firstLineBytes += decodedBytes(this.#firstLine.decode(bytes, { stream: true }));
		}
	}
}
