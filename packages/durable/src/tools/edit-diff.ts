// 所属：packages/durable/src/tools，edit 工具的文本匹配与差异计算核心。
// 解决的问题：模型给出的 oldText 常与文件在换行、尾随空格、智能引号、Unicode 破折号上略有差异；替换既要
// 找到目标，又必须保证唯一、不重叠，并且在“模糊匹配”后只改真正涉及的行，不能重写整份文件的字节。
// 职责边界：纯字符串算法，不做文件 I/O、不知道 ExecutionEnv、不写文件；失败通过普通 Error 抛出（错误文本
// 面向模型）。它不判断是否允许编辑，也不做编码转换（BOM 由 stripBom 单独处理）。
// 上游：edit.ts 的 execute 在读取文件、统一换行后调用 applyEditsToNormalizedContent，再用两个生成器做展示。
// 下游：npm 包 diff 的 diffLines/createTwoFilesPatch；除此之外都是本文件的局部辅助函数。
// 能力清单（导出项）：
// - detectLineEnding(content)：判断文件主要使用 CRLF 还是 LF。
// - normalizeToLF(text) / restoreLineEndings(text, ending)：在匹配用 LF 与原始换行风格之间转换。
// - normalizeForFuzzyMatch(text)：NFKC、去行尾空白、智能引号/破折号/特殊空格转 ASCII，供宽松匹配。
// - applyReplacementsPreservingUnchangedLines(original, base, replacements)：把归一化空间中的替换贴回原文，
//   未触及的行保留原始字节。
// - fuzzyFindText(content, oldText)：先精确查找，再在归一化文本中查找，返回位置与用于替换的内容。
// - stripBom(content)：拆出开头 BOM 和去掉 BOM 的文本。
// - applyEditsToNormalizedContent(normalizedContent, edits, path)：核心入口；校验空 oldText、查找、唯一性、
//   重叠、无变化，返回 baseContent 与 newContent。
// - generateUnifiedPatch(path, oldContent, newContent, contextLines?)：标准 unified diff，用于 patch。
// - generateDiffString(oldContent, newContent, contextLines?)：带行号和上下文的展示差异，返回首个变化行号。
// - 类型 FuzzyMatchResult、Edit、AppliedEditsResult：匹配结果、单条替换输入和应用结果。
// 组合与顺序：edit.ts 先 stripBom + normalizeToLF → applyEditsToNormalizedContent（内部逐条 fuzzyFindText，
// 检查唯一/重叠，必要时在归一化空间替换再用 applyReplacementsPreservingUnchangedLines 映射回原文）→
// generateDiffString / generateUnifiedPatch。
// 示例（真实签名）：
//   const { baseContent, newContent } = applyEditsToNormalizedContent("a\nb\n", [{ oldText: "b", newText: "c" }], "a.txt");
//   const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);
// 建议阅读顺序：先看三个换行/BOM 辅助 → normalizeForFuzzyMatch → fuzzyFindText → applyEditsToNormalizedContent
// （配合 applyReplacements* 两个函数）→ 最后看两个 diff 生成器。

/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";

// 判断文件主要换行风格：找第一个 CRLF 和第一个 LF，谁先出现就用谁；没有换行时默认 LF。
// 只看“最早出现”，因此混合换行文件按开头风格处理；返回类型是两个字面量组成的联合。
export function detectLineEnding(content: string): "\r\n" | "\n" {
	// indexOf 返回 -1 表示不存在；CRLF 的位置一定不早于其内部的 LF。
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	// 没有任何 LF（含空文件）时按 LF 处理。
	if (lfIdx === -1) return "\n";
	// 有 LF 但没有 CRLF：纯 LF 文件。
	if (crlfIdx === -1) return "\n";
	// CRLF 的 "\r\n" 起点比单独的 "\n" 早，说明文件以 CRLF 为主。
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

// 把所有换行统一为 LF：先替换 CRLF，再替换剩余的孤立 CR，顺序不能颠倒。
// replace 返回新字符串；函数是纯的，不修改参数。
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// 把 LF 文本恢复成指定换行风格；ending 为 LF 时原样返回（仍返回同一字符串引用）。
// 注意它会替换文本中所有 \n，包括新增内容中的换行，这是写回整文件时想要的行为。
export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
// 生成用于“宽松匹配”的文本视图；它不用于写回，只用于查找位置。转换是逐步的：
// NFKC 兼容分解 → 每行去尾随空白 → 智能单/双引号转 ASCII → 各种破折号/连字符转 "-" → 特殊空格转普通空格。
// 纯函数；多次转换可能改变长度，因此匹配得到的索引只在该归一化文本中有效。
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

// 把文本切成“带换行的行”：每行包含其结尾的 \n（最后一行可能没有）。这样各行拼接后等于原文，
// 便于按原字节保留未修改的行。match 无结果时返回空数组（?? [] 处理 null）。
function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

// 一行在字符串中的半开区间 [start, end)，用于把字符偏移映射回行号。
interface LineSpan {
	start: number;
	end: number;
}

// 已匹配的一条编辑：editIndex 是它在调用方 edits 数组中的下标（用于错误消息），
// matchIndex/matchLength 是在“替换基准文本”中的位置和长度，newText 是替换内容。
interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

// Pick 从 MatchedEdit 中挑出三个字段组成新类型；applyReplacements 只需要这些，不需要 editIndex。
type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

// 计算每一行的字符区间；offset 在 map 回调中被推进，因此回调带副作用，但只影响本次局部数组。
// 例 "a\nb" → [{start:0,end:2},{start:2,end:3}]。
function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

// 把一条替换的字符区间扩成它实际触及的行范围 [startLine, endLine)，endLine 是开区间。
// 起点必须落在某行内；终点所在的行走查找到“行尾 >= 替换终点”为止。区间越界时抛错，说明匹配不来自这份文本。
// 返回行号而不是修改 lines，纯查询。
function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	// 替换覆盖 [matchIndex, matchIndex + matchLength) 的字符。
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	// 找起点所在行；-1 作为“未找到”的哨兵值。
	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// 半开区间：start 属于本行，end 属于下一行；最后一行可能没有换行。
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	// 起点不在任何行内，通常是匹配偏移与基准文本不一致的编程错误。
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	// 从起点行开始向后扩展到覆盖替换终点的那一行。
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	// 走到了文本末尾仍未覆盖终点，说明区间越界。
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	// endLine + 1 把闭区间转成开区间，方便 slice 使用。
	return { startLine, endLine: endLine + 1 };
}

// 在 content 上一次性应用多条替换，返回新字符串。替换按 matchIndex 从后往前执行，这样前面的偏移不会因
// 后面的长度变化而失效；offset 把“基准文本中的绝对位置”换算成当前子串内的位置。
// 纯函数；不检查重叠（调用方负责），不修改输入。
function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	// 逆序遍历是保持偏移稳定的关键。
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		// 调用方可能传入整份文本中的位置，而这里只处理一个行块，因此减去块起点。
		const matchIndex = replacement.matchIndex - offset;
		// 拼接：前缀 + 新文本 + 跳过长度的后缀；substring 不改原字符串。
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
// 把 baseContent（通常是 fuzzy 归一化后的文本）中匹配到的替换，应用到 originalContent（原始文本）上：
// 只重写替换实际触及的行，其余行从 originalContent 原样拷贝，从而保留原始空白、引号和换行字节。
// 参数：originalContent 与 baseContent 必须行数相同；replacements 的索引相对于 baseContent。
// 返回新字符串。行数不一致或区间越界时抛错（说明调用方用错了基准文本）。纯函数，不修改入参。
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	// 原始行带换行切分，便于按整行拼接回原文。
	const originalLines = splitLinesWithEndings(originalContent);
	// 基准文本只计算每行的字符区间，不切分内容。
	const baseLines = getLineSpans(baseContent);
	// 两个文本必须逐行对齐，否则无法把基准行号映射回原始行。
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	// groups 把相互重叠/相邻的替换合并成一个“重写块”，每块记录基准行范围与替换列表。
	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	// 复制后按位置排序；不排序原数组，避免修改调用方数据。
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		// 把字符区间扩成它触及的行范围。
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		// 与上一块有行重叠时合并，扩大块范围并收集替换；这样同一块只重写一次。
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		// 不重叠则开新块；...range 展开 startLine/endLine 两个字段。
		groups.push({ ...range, replacements: [replacement] });
	}

	// 逐块拼接：块之前未改动的原始行 + 用基准文本重写的块。
	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		// 块起点之前的行保持原始字节。
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		// 块在基准文本中的字符范围；endLine 是开区间，所以用 endLine - 1 的 end。
		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		// 只对块的基准子串应用替换，offset 把绝对位置换算成子串内位置。
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		// 下一块从本块结束行继续。
		originalLineIndex = group.endLine;
	}
	// 最后一个块之后的原始行。
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

// fuzzyFindText 的返回形状，是一个普通对象而不是可判别联合：found 为 false 时 index 为 -1、matchLength 为 0，
// 其余字段仍有值（调用方应先看 found）。contentForReplacement 明确告诉调用方索引属于哪份文本。
export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

// 工具输入中的一条替换：oldText 必须在原文中唯一出现，newText 是替换内容。
// 这里是编译期形状；字符串类型和唯一性分别由 schema 与 applyEditsToNormalizedContent 在运行时保证。
export interface Edit {
	oldText: string;
	newText: string;
}

// applyEditsToNormalizedContent 的结果：baseContent 是用于比较的 LF 文本（可能已 fuzzy 归一化），
// newContent 是替换后的文本。edit.ts 用这两份文本生成 diff，并写回 newContent。
export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
// 在 content 中查找 oldText：先精确 indexOf；找不到才把两边都 fuzzy 归一化后再找。
// 返回的位置属于 contentForReplacement（精确匹配是原文本，模糊匹配是归一化文本），matchLength 同理。
// 纯函数；不抛错，找不到时 found:false。注意模糊匹配可能改变文本长度，所以不能把索引直接用于原文。
// 例：content 使用 "don’t"，oldText 使用 "don't" 时，精确匹配失败，归一化后匹配成功。
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	// 精确匹配优先：位置可直接用于原文，且不会误伤引号/空白字符。
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	// 两边用同一套归一化规则，保证长度/字符对齐；索引属于 fuzzyContent。
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	// matchLength 取归一化后 oldText 的长度，因为位置是在 fuzzyContent 中。
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
// 拆出开头的 UTF-8 BOM（U+FEFF）和其余文本；没有 BOM 时 bom 为空串。纯函数。
// 例如 "\uFEFFabc" → { bom: "\uFEFF", text: "abc" }；edit 在写回时把 bom 拼回去。
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

// 统计 oldText 在归一化文本中出现的次数，用于拒绝有歧义的替换。
// 与 fuzzyFindText 使用同一归一化，因此“模糊匹配唯一”和这里的计数标准一致。
// 注意：空 oldText 会让 split 产生长度+1 的结果，调用方在此之前已拒绝空 oldText。
function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	// split 按分隔符切分：n 次出现产生 n+1 段，减 1 即次数。
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

// 四个错误工厂：根据“只有一条编辑”还是“多条编辑中的第 i 条”生成更具体的错误文本。
// 它们只构造 Error，不检查状态；抛出由 applyEditsToNormalizedContent 决定。路径和下标进入消息，便于模型修正。
function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

// 目标文本出现多次：提示提供更多上下文以变得唯一。
function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

// 空 oldText 会让 indexOf 永远命中位置 0，必须提前拒绝。
function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

// 替换后内容与原文相同：可能是特殊字符差异或 oldText 实际不存在于预期位置，不能静默当作成功。
function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
// 核心入口：在 LF 归一化的 normalizedContent 上应用全部 edits，返回用于 diff 的 baseContent 和写回的 newContent。
// 步骤：统一每条编辑的换行 → 拒绝空 oldText → 预判是否会用 fuzzy 匹配 → 在统一基准上逐条查找并检查唯一性 →
// 检查重叠 → 应用替换（fuzzy 时只重写涉及行）→ 拒绝无变化结果。
// 所有编辑都针对同一份原文匹配，而不是逐条增量应用；因此两条编辑的 oldText 可以基于原始文本描述。
// 失败时抛出面向模型的 Error（找不到、重复、重叠、无变化、空文本）；成功返回普通对象。
// 例：applyEditsToNormalizedContent("a\nb\n", [{oldText:"b",newText:"c"}], "a.txt") → {baseContent:"a\nb\n",newContent:"a\nc\n"}。
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	// 模型给的 oldText/newText 可能是 CRLF；统一成 LF 后才能与 normalizedContent 比较。
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	// 空 oldText 会在任何位置匹配，必须先拒绝；i 用于错误消息中的 edits[i]。
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	// 先探测是否至少有一条需要 fuzzy；这决定后续所有编辑使用的“替换基准”是哪份文本。
	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	// some 遇到第一个 true 即返回；只要有一条模糊匹配，整体就在归一化空间操作，保证偏移一致。
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	// fuzzy 时用归一化文本作为基准；否则原文即可。
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	// 逐条在统一基准上重新查找并记录位置；不能复用 initialMatches，因为基准可能已切换。
	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		// 任何一条找不到都整体失败，不做部分替换。
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		// 出现多次时替换有歧义，要求模型提供更多上下文。
		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	// 按位置排序后检查相邻区间是否重叠；重叠会让“逆序应用”失去确定含义。
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		// 前一条的结束位置大于后一条的起点即重叠（相邻不算）。
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	// baseContent 始终是原始归一化文本（不是 fuzzy 版本），这样 diff 不会显示归一化造成的假变化。
	const baseContent = normalizedContent;
	// 精确匹配时直接在基准上逆序替换；fuzzy 时把基准中的修改映射回原始文本，保留未触及行的字节。
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	// 例如把 "a" 替换成 "a"：结果与原文相同，视为失败而不是成功。
	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
// 生成标准 unified diff（---/+++ 文件头 + @@ hunk），供 patch/details 使用；contextLines 默认 4 行上下文。
// 纯计算，不写文件；old/new 使用同一个 path，只显示文件头不显示时间戳（FILE_HEADERS_ONLY）。
// 例：generateUnifiedPatch("a.txt", "a\n", "b\n") 返回以 "--- a.txt" 开头的补丁文本。
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	// 底层 npm diff 包：createTwoFilesPatch(旧文件名, 新文件名, 旧内容, 新内容, 旧时间戳, 新时间戳, 选项)。
	// 时间戳传 undefined，避免输出不稳定；context 控制 hunk 上下文行数。
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
// 生成给模型/UI 阅读的差异文本：每行带旧/新行号，前缀 "+" 新增、"-" 删除、空格表示上下文；
// contextLines 控制每个变化块前后展示的行数，过长的中间上下文用 "..." 省略。
// 返回 diff 和“新文件中的首个变化行号”（无变化时为 undefined）。纯计算，不读文件。
// 例：generateDiffString("a\nb\n", "a\nc\n") → diff 含 "+2 c" 与 "-2 b"，firstChangedLine 为 2。
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	// diffLines 把两份文本切成 added/removed/unchanged 块，块内保留换行；这是展示布局的输入。
	const parts = Diff.diffLines(oldContent, newContent);
	// output 按最终显示顺序累积每一行，最后用 "\n" 连接。
	const output: string[] = [];

	// 行号宽度按两侧最大行数计算，便于在纯文本中对齐；split("\n") 末尾的空串也算一行，仅影响宽度。
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	// 旧/新行号都从 1 开始；lastWasChange 标记上一块是否变化，用于决定上下文保留多少。
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		// 块值按 "\n" 切分；末尾空串来自结尾换行，去掉它避免多显示一行。
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		// added/removed 是 diff 库在块上设置的布尔字段；两者互斥。
		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			// 删除块也可能先出现；这里记录的是新文件行号，对纯删除块就是删除位置对应的新行。
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			// 新增行显示新行号并推进 newLineNum；删除行显示旧行号并推进 oldLineNum。
			for (const line of raw) {
				if (part.added) {
					// padStart 左补空格，保证行号列对齐；模板字符串前导 "+" 是 diff 标记。
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			// 未变化块：根据前后是否紧邻变化块决定展示开头/结尾各 contextLines 行。
			// 下一块是变化块（i 不是最后一块，且下一块 added/removed）表示本块是“前导上下文”。
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			// 上一块是变化块表示本块是“后随上下文”。
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			// 前后都紧邻变化：中间上下文太长时保留首尾，省略中间。
			if (hasLeadingChange && hasTrailingChange) {
				// 不够两倍上下文长度时整块展示，无需省略。
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					// 保留前 contextLines 行和后 contextLines 行；差值就是中间省略的行数。
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					// 省略行显示为只有省略号的空行号；两侧行号仍按实际跳过数推进。
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				// 只有前一块是变化：展示本块开头若干行作为后随上下文，其余省略。
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				// 只有后一块是变化：省略本块开头，保留结尾若干行作为前导上下文。
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				// 前后都不是变化块的大段未改内容：完全跳过，但行号仍要前进，保证后续变化行号正确。
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}
