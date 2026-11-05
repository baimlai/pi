// 文件导读
// 所属：packages/durable 的工具输出截断工具，被 tools/read.ts、tools/bash.ts、harness/tool.ts 与测试使用。
// 作用：按“行数”和“UTF-8 字节数”两个独立上限截断文本，先到先限；绝不返回半行。还提供人类可读的大小格式化和
// chord/output 的 utf8ByteLength 复用出口。
// 职责边界：纯函数，不读文件、不写输出、无全局状态；流式工具输出由 @earendil-works/chord/output 的 OutputBuffer 限界，
// 这里只处理已经拿到的完整字符串。上游：工具读取/执行后决定给模型的文本；下游：chord 的 utf8ByteLength、本地 defaults。
// 能力清单：
// - DEFAULT_MAX_LINES（2000）与 DEFAULT_MAX_BYTES（50KB）：默认上限。
// - TruncationResult：截断结果与统计（是否截断、哪个上限、原始/输出行数与字节数、首行是否超限等）。
// - TruncationOptions：可选的 maxLines/maxBytes 覆盖。
// - utf8ByteLength：从 chord/output 转出，按 UTF-8 计字节（含代理对/非 ASCII）。
// - formatSize(bytes)：把字节数格式化为 B/KB/MB（1024 进制，保留一位小数）。
// - truncateHead(content, options)：从头部保留内容，内部先统计总量再委托 truncateHeadOf。
// - truncateHeadOf(prefix, totals, options)：已知前缀与总量时的实现；前缀必须满足英文注释中的完整性/长度前提。
// - （私有）splitLinesForCounting：计行时忽略末尾换行，空串为 0 行。
// 组合与典型顺序：工具拿到完整文本 → truncateHead(text, limits) → 用 result.content 发给模型，用 result.truncated/
// truncatedBy/formatSize(...) 生成诊断（例如“输出已截断，共 N 行”）。
// 示例（真实签名）：
//   const result = truncateHead("a\nb\nc\n", { maxLines: 2 });
//   // result.content === "a\nb"，result.truncated === true，result.truncatedBy === "lines"
//   formatSize(1536) === "1.5KB"
// 阅读顺序：先 defaults 与 TruncationResult/TruncationOptions 字段，再看 truncateHead 的委托，最后读 truncateHeadOf 的
// 无截断、首行超限、逐行收集与 truncatedBy 判定四段。
import { utf8ByteLength } from "@earendil-works/chord/output";
/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines. Tool output streams are bounded by `OutputBuffer` from `@earendil-works/chord/output` instead.
 */

// 默认行数上限；与默认字节上限独立，任一先到即截断。
export const DEFAULT_MAX_LINES = 2000;
// 默认字节上限 50KB；按 UTF-8 字节计算，不是字符数。
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
	/** The truncated content */
	// 实际返回给调用方的文本；截断时只含完整行。
	content: string;
	/** Whether truncation occurred */
	// 是否发生了截断；未截断时 content 等于完整原文。
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	// 哪个上限先触发："lines" / "bytes"；未截断为 null。这是普通字符串字面量联合，运行时没有额外校验。
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	// 原文总行数；计数时忽略末尾换行（"a\n" 记 1 行，"" 记 0 行）。
	totalLines: number;
	/** Total number of bytes in the original content */
	// 原文总 UTF-8 字节数，包含末尾换行与多字节字符的完整编码长度。
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	// 输出中包含的完整行数，可能因字节上限小于 totalLines。
	outputLines: number;
	/** Number of bytes in the truncated output */
	// 输出内容的实际 UTF-8 字节数；由最终 content 重新计算。
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	// 尾部截断才可能为 true；本文件只做头部截断，因此这里总是 false。
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	// 首行本身超过字节上限：此时 content 为空，避免返回半行。
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	// 本次实际采用的行数上限（传入值或默认 2000）。
	maxLines: number;
	/** The max bytes limit that was applied */
	// 本次实际采用的字节上限（传入值或默认 50KB）。
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	// 可选的行数上限；省略时使用 DEFAULT_MAX_LINES。传入 0 会截成空内容（0 行）。
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	// 可选的字节上限；省略时使用 DEFAULT_MAX_BYTES。按 UTF-8 字节比较，不是字符数。
	maxBytes?: number;
}

// One implementation, shared with the output buffer.
// 直接转出 chord/output 的实现，确保“字节数”的算法与本包其他限界逻辑完全一致；这里不重新实现。
export { utf8ByteLength };

// 把文本切成用于计数的行：空串没有行；末尾换行不算新的一行（与编辑器/工具的“行数”直觉一致）。
// 例如 "a\nb\n" → ["a", "b"]（2 行），而 split("\n") 会得到 ["a", "b", ""]。
function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	// 只移除最后一个空段；文本中间的连续换行仍会产生空行并计数。
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * Format bytes as human-readable size.
 */
// 把字节数格式化成展示文本：小于 1KB 用 B，小于 1MB 用 KB，其余用 MB；1KB = 1024 字节，保留一位小数。
// 例：formatSize(512) === "512B"；formatSize(1536) === "1.5KB"；formatSize(2 * 1024 * 1024) === "2.0MB"。
export function formatSize(bytes: number): string {
	// 用 1024 进制逐级比较；toFixed(1) 保证稳定的一位小数展示。
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
// 从头部保留内容：先统计完整文本的行数与 UTF-8 字节数，再交给 truncateHeadOf 做真正的裁剪。
// 输入：content 为完整文本，options 可覆盖两个上限；输出：截断结果；无副作用、不抛错。
// 为什么先统计再委托：截断逻辑只需要“前缀 + 总量”，这样它也能被已持有完整文本统计结果的调用方复用。
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	return truncateHeadOf(
		content,
		{ lines: splitLinesForCounting(content).length, bytes: utf8ByteLength(content) },
		options,
	);
}

/**
 * `truncateHead` of a text known by a prefix and its totals (`lines` counted like `truncateHead`, ignoring a trailing
 * newline). The prefix must be the whole text, or longer than `maxBytes + 1` UTF-8 bytes, or hold at least `maxLines`
 * newlines; then the result equals `truncateHead` of the whole text.
 */
// 已知“前缀 + 全量统计”时的截断实现。
// 输入：prefix（通常就是完整文本；也可以是长到足以决定结果的前缀）、totals（整个文本的行数与字节数）、options。
// 输出：与 truncateHead(完整文本, options) 等价的结果；无副作用。
// 前提（英文注释已说明）：prefix 必须是完整文本，或者本身已超过 maxBytes+1 字节 / 含至少 maxLines 个换行；
// 否则 totals 与 prefix 不匹配，结果没有意义。运行时不会校验这些前提。
// 四段流程：无需截断 → 首行超限 → 逐行收集完整行 → 根据是否还有未输出的行判定 truncatedBy。
export function truncateHeadOf(
	prefix: string,
	totals: { readonly lines: number; readonly bytes: number },
	options: TruncationOptions = {},
): TruncationResult {
	// `??` 只替换 null/undefined；显式传入 0 会被保留（并导致空输出）。
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	// 总量来自调用方；行数组只从 prefix 中切出，用于判断首行大小和逐行累加。
	const totalBytes = totals.bytes;
	const lines = splitLinesForCounting(prefix);
	const totalLines = totals.lines;

	// Check if no truncation needed
	// 两个上限都没超过：原样返回，避免复制或改动文本。
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content: prefix,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Check if first line alone exceeds byte limit
	// 首行的 UTF-8 字节数单独计算；若它一个就超限，返回空内容而不是半行。
	const firstLineBytes = utf8ByteLength(lines[0]);
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	// 逐行收集；i 同时受实际行数和 maxLines 限制，因此行数上限在循环条件里生效。
	const outputLinesArr: string[] = [];
	// 已累计的输出字节数（含行间换行），用于提前判断下一行是否放得下。
	let outputBytesCount = 0;
	// 先假定是行数先到；只有字节放不下时才改成 "bytes"。
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		// 第 0 行前没有换行；后续每个输出行前面都要补一个 "\n"，所以多算 1 字节（仅在 i > 0 时）。
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 for newline

		// 这一行会让总字节超出上限：立即停止，保留此前完整行；绝不能只放半行。
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// Without a byte break, only omitted lines prove the line limit was reached; otherwise a trailing newline exceeded bytes.
	// 没有因字节中断时：确实漏掉了行 → 行数上限生效；所有行都收下却仍被判定为截断 → 应是末尾换行导致总字节超限。
	if (truncatedBy !== "bytes") truncatedBy = outputLinesArr.length < totalLines ? "lines" : "bytes";

	// 用 "\n" 重新拼接，再按实际拼接结果重新计算字节数（不依赖上面累加值，保证 outputBytes 与 content 一致）。
	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}
