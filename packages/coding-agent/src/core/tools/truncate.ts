// 工具输出的本地裁剪算法：read/搜索保留开头，shell 保留结尾，程序化大输出可保留首尾；这些函数不会调用模型做对话摘要。
/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

// 工具默认最多展示 2000 行，调用者可以在 options 覆盖。
export const DEFAULT_MAX_LINES = 2000;
// 默认正文预算 50×1024 字节；中文字符可能占 3 字节，字符数与字节数不同。
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
// grep 单行字符预算，和整体 50KB 输出预算是两层限制。
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

// 裁剪结果的共同契约，模型可读正文与给 UI/续读逻辑用的统计同时返回。
export interface TruncationResult {
	/** The truncated content */
	// 实际要展示/发送的正文；不同算法可能是开头、结尾或首尾组合。
	content: string;
	/** Whether truncation occurred */
	// true 表示原内容有部分未展示，不能据正文推断已看完整输出。
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	// 字面量联合类型只允许行数、字节或 null；null 表示无需裁剪。
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	// 裁剪前原文本的实际行数，尾部一个换行不产生虚假空行。
	totalLines: number;
	/** Total number of bytes in the original content */
	// 原文本 UTF-8 字节数，不是模型供应商 token 计数。
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	// 本次返回正文的行数；tail 超长末行的特殊路径可能只有一个片段行。
	outputLines: number;
	/** Number of bytes in the truncated output */
	// 最终正文的实际 UTF-8 字节数。
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	// tail 因末行单独过长，只能保留该末行后半段时标 true；并非一般性的任意行截断。
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	// head 的第一行本身过大，无法在不切断行的前提下返回时标 true。
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	// 本次实际采用的行数预算，便于调用者解释限制。
	maxLines: number;
	/** The max bytes limit that was applied */
	// 本次实际采用的 UTF-8 字节预算。
	maxBytes: number;
}

// 可选预算对象；? 字段允许调用者只覆盖一种上限。
export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	// 可省略的行数限制，缺省时用 2000。
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	// 可省略的字节限制，缺省时用 50KB。
	maxBytes?: number;
}

/**
 * 按真实输出行数拆分文本：空文本是 0 行，末尾换行不额外算一条空行；返回新数组，无 I/O。
 * 例如 "a\nb\n" 得到 ["a","b"]，但 "a\n\n" 仍有一条实际空行。
 */
function splitLinesForCounting(content: string): string[] {
	// 空字符串没有任何实际行，不能简单 split 后误算为一行。
	if (content.length === 0) {
		// 空内容的拆行结果是空数组。
		return [];
	}
	// 按换行分隔成数组；暂时会在结尾换行后产生一个空元素。
	const lines = content.split("\n");
	// 只有真实结尾换行才移除那一个多余尾元素，保留中间实际空行。
	if (content.endsWith("\n")) {
		// pop 原地删除数组最后一个元素；不修改原字符串 content。
		lines.pop();
	}
	// 返回用于计数/拼接的行数组。
	return lines;
}

/**
 * Format bytes as human-readable size.
 */
/**
 * 把字节数格式化为 B/KB/MB 字符串，不改变输出正文；1024 以下用 B，更大保留一位小数。
 * 例如 formatSize(1536) 返回 "1.5KB"，使用 1024 进制。
 */
export function formatSize(bytes: number): string {
	// 不到一个 KiB 的小输出直接按 B 展示。
	if (bytes < 1024) {
		// 模板字符串在数值后加单位，例如 12B。
		return `${bytes}B`;
		// 不到 1MiB 时按 KB 展示；这里显示标签采用工具约定的 KB。
	} else if (bytes < 1024 * 1024) {
		// toFixed(1) 返回一位小数的字符串，例如 1.5KB。
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		// 更大输出除以 1024²，保留一位小数。
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
/**
 * 保留开头的完整行，行数或 UTF-8 字节任一上限先到就停；返回正文加截断原因/计数。
 * 例如三行文字在 maxLines=2 下只保留前两行；若第一行单独就超字节上限，返回空正文并标 firstLineExceedsLimit。
 * 纯字符串处理，不改源文件，也不按 token 计算。默认 2000 行、50KB。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	// ?? 只为空缺值兜底；显式的 0 不会被当作没设置。
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	// 读取这次调用的字节上限；函数本身不重新向模型估算 token。
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	// 按 UTF-8 编码计字节；content.length 是 UTF-16 码元数，两者不可混用。
	const totalBytes = Buffer.byteLength(content, "utf-8");
	// 按统一规则拆行，保证 head 与 tail 的总行数一致。
	const lines = splitLinesForCounting(content);
	// 数组长度即规范化计数后的行数。
	const totalLines = lines.length;

	// Check if no truncation needed
	// 两个预算都满足才直接返回原正文，不做无必要字符串重建。
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			// 属性简写 content: content，原正文或当前函数局部正文原样返回。
			content,
			// 原内容完整展示，没有裁剪。
			truncated: false,
			// 没有触发任何上限。
			truncatedBy: null,
			// 保留原文本行数统计。
			totalLines,
			// 保留原文本 UTF-8 字节数。
			totalBytes,
			// 完整返回时，展示行数等于原行数。
			outputLines: totalLines,
			// 完整返回时，展示字节数等于原字节数。
			outputBytes: totalBytes,
			// 当前返回没有保留半行的特殊情况。
			lastLinePartial: false,
			// 当前返回不属于 head 首行过大而无法展示的情况。
			firstLineExceedsLimit: false,
			// 附带实际行数预算，供调用方生成可读提示。
			maxLines,
			// 附带实际字节预算。
			maxBytes,
		};
	}

	// Check if first line alone exceeds byte limit
	// head 不允许半行，先看第一行单独能否放入字节预算。
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	// 首行超限，既不能跳过首行又假装保留开头，也不能拆坏整行规则。
	if (firstLineBytes > maxBytes) {
		return {
			// 返回空正文，由调用者提示这行太大、建议其他读取方式。
			content: "",
			// 有原内容未返回，必须标记为已裁剪。
			truncated: true,
			// 触发的是字节上限，和行数多少无关。
			truncatedBy: "bytes",
			// 保留原文本行数统计。
			totalLines,
			// 保留原文本 UTF-8 字节数。
			totalBytes,
			// head 首行超限时没有任何完整行能放进去。
			outputLines: 0,
			// 对应空正文占 0 字节。
			outputBytes: 0,
			// 当前返回没有保留半行的特殊情况。
			lastLinePartial: false,
			// 特别标志让 read 工具能给出单行过长的专门提示。
			firstLineExceedsLimit: true,
			// 附带实际行数预算，供调用方生成可读提示。
			maxLines,
			// 附带实际字节预算。
			maxBytes,
		};
	}

	// Collect complete lines that fit
	// 收集要返回的行；string[] 是字符串数组类型，不会自动填充元素。
	const outputLinesArr: string[] = [];
	// 累计已选正文加分隔换行的字节数，作为下一行是否能加入的依据。
	let outputBytesCount = 0;
	// 默认认为行数限制先到，发现字节超限时再改为 bytes。
	let truncatedBy: "lines" | "bytes" = "lines";

	// head 从第一行往后，文件结束或行数预算任一条件不满足就停止。
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		// 取得当前候选整行，尚未加入结果。
		const line = lines[i];
		// 除首行外，每多加入一行还需一个 LF 分隔字节；三元表达式决定加 1 还是 0。
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		// 加入该整行会超字节预算，就停在它之前；head 不返回此行的前半段。
		if (outputBytesCount + lineBytes > maxBytes) {
			// 记录真正阻止继续加入行的预算种类。
			truncatedBy = "bytes";
			// 结束当前 for/while 循环；不会退出整个模块，后面仍组装结果。
			break;
		}

		// head 将可放下的行追加到末尾，保持原始顺序。
		outputLinesArr.push(line);
		// += 累加该行及必要换行占用的字节。
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	// 确实达到行数上限、字节仍够时，将原因标为 lines。
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		// 记录按行数停止；调用者据此展示行范围提示。
		truncatedBy = "lines";
	}

	// 用 LF 把选中的行拼回文字；不会为结果额外添加末尾换行。
	const outputContent = outputLinesArr.join("\n");
	// 以实际拼接结果重新计字节，返回准确计数。
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		// 给模型/界面的实际正文。
		content: outputContent,
		// 有原内容未返回，必须标记为已裁剪。
		truncated: true,
		// 属性简写带出上面判断的 lines/bytes 原因。
		truncatedBy,
		// 保留原文本行数统计。
		totalLines,
		// 保留原文本 UTF-8 字节数。
		totalBytes,
		// 已选行数组长度是这次展示行数。
		outputLines: outputLinesArr.length,
		// 记录最终实际输出正文占用。
		outputBytes: finalOutputBytes,
		// 当前返回没有保留半行的特殊情况。
		lastLinePartial: false,
		// 当前返回不属于 head 首行过大而无法展示的情况。
		firstLineExceedsLimit: false,
		// 附带实际行数预算，供调用方生成可读提示。
		maxLines,
		// 附带实际字节预算。
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
/**
 * 从结尾向前保留完整行，适合 shell 最后的报错或最终结果；返回正文与同一份截断详情结构。
 * 例：100 行日志、maxLines=10 保留末 10 行；若最后一行自己超字节上限，特殊保留该行末尾的完整 UTF-8 字符片段。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	// ?? 只为空缺值兜底；显式的 0 不会被当作没设置。
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	// 读取这次调用的字节上限；函数本身不重新向模型估算 token。
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	// 按 UTF-8 编码计字节；content.length 是 UTF-16 码元数，两者不可混用。
	const totalBytes = Buffer.byteLength(content, "utf-8");
	// 按统一规则拆行，保证 head 与 tail 的总行数一致。
	const lines = splitLinesForCounting(content);
	// 数组长度即规范化计数后的行数。
	const totalLines = lines.length;

	// Check if no truncation needed
	// 两个预算都满足才直接返回原正文，不做无必要字符串重建。
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			// 属性简写 content: content，原正文或当前函数局部正文原样返回。
			content,
			// 原内容完整展示，没有裁剪。
			truncated: false,
			// 没有触发任何上限。
			truncatedBy: null,
			// 保留原文本行数统计。
			totalLines,
			// 保留原文本 UTF-8 字节数。
			totalBytes,
			// 完整返回时，展示行数等于原行数。
			outputLines: totalLines,
			// 完整返回时，展示字节数等于原字节数。
			outputBytes: totalBytes,
			// 当前返回没有保留半行的特殊情况。
			lastLinePartial: false,
			// 当前返回不属于 head 首行过大而无法展示的情况。
			firstLineExceedsLimit: false,
			// 附带实际行数预算，供调用方生成可读提示。
			maxLines,
			// 附带实际字节预算。
			maxBytes,
		};
	}

	// Work backwards from the end
	// 收集要返回的行；string[] 是字符串数组类型，不会自动填充元素。
	const outputLinesArr: string[] = [];
	// 累计已选正文加分隔换行的字节数，作为下一行是否能加入的依据。
	let outputBytesCount = 0;
	// 默认认为行数限制先到，发现字节超限时再改为 bytes。
	let truncatedBy: "lines" | "bytes" = "lines";
	// tail 仅在最后一行本身过大时才切该行，并把此标志改为 true。
	let lastLinePartial = false;

	// tail 从文件结尾向前选，最多选 maxLines 行；i-- 每轮倒退一行。
	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		// 取得当前候选整行，尚未加入结果。
		const line = lines[i];
		// 已有后续行时，新加的前一行需要一个连接 LF 字节。
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		// 整行超限先进入边界处理：尚未选行则取末行尾片段，否则停在该候选整行之前，保留已选的后续行。
		if (outputBytesCount + lineBytes > maxBytes) {
			// 记录真正阻止继续加入行的预算种类。
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			// 只有连最末行都放不下、尚未选中任何行时，才允许保留末行片段。
			if (outputLinesArr.length === 0) {
				// 在该行内部按完整 UTF-8 字符边界保留最后若干字节。
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				// unshift 从数组开头插入；tail 倒序遍历但最终输出仍按原始顺序。
				outputLinesArr.unshift(truncatedLine);
				// 记录该片段真实字节数，可能因跳过不完整字符略小于预算。
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				// 告诉 shell 格式化器“这里只有末行的一部分”，需要专门说明。
				lastLinePartial = true;
			}
			// 结束当前 for/while 循环；不会退出整个模块，后面仍组装结果。
			break;
		}

		// 把更早的一行插到前面，保持整个尾部片段的正常阅读顺序。
		outputLinesArr.unshift(line);
		// += 累加该行及必要换行占用的字节。
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	// 确实达到行数上限、字节仍够时，将原因标为 lines。
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		// 记录按行数停止；调用者据此展示行范围提示。
		truncatedBy = "lines";
	}

	// 用 LF 把选中的行拼回文字；不会为结果额外添加末尾换行。
	const outputContent = outputLinesArr.join("\n");
	// 以实际拼接结果重新计字节，返回准确计数。
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		// 给模型/界面的实际正文。
		content: outputContent,
		// 有原内容未返回，必须标记为已裁剪。
		truncated: true,
		// 属性简写带出上面判断的 lines/bytes 原因。
		truncatedBy,
		// 保留原文本行数统计。
		totalLines,
		// 保留原文本 UTF-8 字节数。
		totalBytes,
		// 已选行数组长度是这次展示行数。
		outputLines: outputLinesArr.length,
		// 记录最终实际输出正文占用。
		outputBytes: finalOutputBytes,
		// 返回 tail 是否裁剪过超长末行。
		lastLinePartial,
		// 当前返回不属于 head 首行过大而无法展示的情况。
		firstLineExceedsLimit: false,
		// 附带实际行数预算，供调用方生成可读提示。
		maxLines,
		// 附带实际字节预算。
		maxBytes,
	};
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
/**
 * 按 UTF-8 字节预算截取字符串末尾，跳过开头不完整字符，返回可正常解码的尾部文本。
 * 例如中文通常占多个字节，不能用 JS slice 的字符下标冒充字节限制；这里先编码成 Buffer。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	// 编码成字节数组，后面索引针对字节位置而非 JS 字符下标。
	const buf = Buffer.from(str, "utf-8");
	// 整串本来就符合字节预算时，不必重新截取。
	if (buf.length <= maxBytes) {
		// 直接返回输入字符串，保持其完整内容。
		return str;
	}

	// Start from the end, skip maxBytes back
	// 先按字节数倒推候选起点；它可能落在中文或 emoji 的续字节中间。
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	// UTF-8 续字节以二进制 10 开头；按位与检查后把起点继续右移到完整字符开头。
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		// 跳过一个续字节，避免解码输出替代字符。
		start++;
	}

	// 从安全起点取尾部字节，再解码为文字。
	return buf.slice(start).toString("utf-8");
}

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
/**
 * 按 JS 字符串长度裁剪 grep 单行，超长时加可见后缀；返回 text 和是否裁剪。
 * 例如 maxChars=5 时 "abcdef" 变为 "abcde... [truncated]"；预算针对保留正文，不含后缀，也不是 UTF-8 字节数。
 */
export function truncateLine(
	// 一条待展示文字；这个函数按字符串长度而非字节裁剪。
	line: string,
	// 默认参数为 500；显式传入其他值即可改变单行保留长度。
	maxChars: number = GREP_MAX_LINE_LENGTH,
	// 内联对象类型声明两个返回字段；运行时仍返回普通对象。
): { text: string; wasTruncated: boolean } {
	// 未超字符预算则原样保留，不加省略提示。
	if (line.length <= maxChars) {
		// 返回正文及明确的未裁剪标志。
		return { text: line, wasTruncated: false };
	}
	// 截前 maxChars 个 UTF-16 码元后追加提示；此算法没有 UTF-8 字节边界要求。
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

// 首尾裁剪的返回形状；removedChars 与原始 bytes/lines 分开记录。
export interface MiddleTruncationResult {
	/** The start and end of the content with a `…N chars truncated…` marker between them. */
	// 实际要展示/发送的正文；不同算法可能是开头、结尾或首尾组合。
	content: string;
	// true 表示原内容有部分未展示，不能据正文推断已看完整输出。
	truncated: boolean;
	/** Characters left out. */
	// 被省去的 Unicode 码点数量，给中间提示使用。
	removedChars: number;
	// 原文本 UTF-8 字节数，不是模型供应商 token 计数。
	totalBytes: number;
	// 裁剪前原文本的实际行数，尾部一个换行不产生虚假空行。
	totalLines: number;
}

/**
 * Keep the start and the end of `content`, half of `maxBytes` each, and replace the middle with a
 * `…N chars truncated…` marker, like Codex does for tool output. Cuts only at character boundaries.
 */
/**
 * 在字节预算内保留首尾两段，删除中间并插入省略字符数量；返回原始字节/行数统计。
 * 例如日志头部参数与结尾错误都要看时用它；省略标记本身会使最终文本字节数略超过 maxBytes。
 * 处理 UTF-8 边界避免拆坏中文/emoji；removedChars 用 Array.from 计 Unicode 码点，不等同于可见字形簇数。
 */
export function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult {
	// 中间裁剪先得到原文 UTF-8 字节，便于均分首尾字节预算。
	const buf = Buffer.from(content, "utf-8");
	// 记录整份原输出的行数，不根据裁剪后的首尾片段猜测。
	const totalLines = splitLinesForCounting(content).length;
	// 整串本来就符合字节预算时，不必重新截取。
	if (buf.length <= maxBytes) {
		// 未超预算直接返回全文和零省略数。
		return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
	}
	// Continuation bytes (10xxxxxx) are not character starts.
	// 局部箭头函数检查某字节位置是否为字符开头或缓冲区结尾；这是 UTF-8 编码规则。
	const isBoundary = (index: number) => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
	// 首段先分到一半预算，Math.floor 向下取整处理奇数字节。
	let headEnd = Math.floor(maxBytes / 2);
	// 首段末尾若在多字节字符内部，向左缩短到完整字符边界。
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
	// 剩余预算分给尾段，奇数字节中多出的一个归尾部。
	let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
	// 尾段起点向右移动，宁可少取几个字节也不截出半个 UTF-8 字符。
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
	// subarray 取头部字节视图，然后转成正常字符串。
	const head = buf.subarray(0, headEnd).toString("utf-8");
	// 取得完整字符起点后的尾部文本。
	const tail = buf.subarray(tailStart).toString("utf-8");
	// 中间省略部分解码后按码点枚举计数；Array.from 比 string.length 更能正确计单个非 BMP 字符。
	const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
	return {
		// 把保留首尾与清楚的省略标记拼起来；不能把省略标记误当原日志内容。
		content: `${head}…${removedChars} chars truncated…${tail}`,
		// 有原内容未返回，必须标记为已裁剪。
		truncated: true,
		// 返回省略数量供其他展示者复用。
		removedChars,
		// 原完整输出的字节数，不是加入标记后的长度。
		totalBytes: buf.length,
		// 保留原文本行数统计。
		totalLines,
	};
}
