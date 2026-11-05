// 精确编辑的匹配与 diff 算法；edit.ts 用它计算写回正文，编辑渲染器用同一算法生成只读预览。
/**
 * Shared diff computation utilities for the edit and similar tools.
 */

// 命名空间导入第三方 diff 的公开函数；下面调用 diffLines 和 createTwoFilesPatch，不手写最小编辑距离。
import * as Diff from "diff";
// 使用 R_OK 做只读预览权限检查；本模块的 diff 计算不负责写入。
import { constants } from "fs";
// Node 异步访问检查和 UTF-8 文件读取，只读预览阶段使用。
import { access, readFile } from "fs/promises";
// 去掉模型通常看不到的 BOM，避免 oldText 匹配因不可见文件头失败。
import { splitBom } from "../../utils/text.ts";
// 预览路径与实际 edit 执行遵循同一个会话目录解析规则。
import { resolveToCwd } from "./path-utils.ts";

/**
 * 推断文本首先使用的换行习惯，返回 LF 或 CRLF；没有换行时默认 LF，纯字符串计算。
 * 例："a\r\nb" 返回 CRLF；混合换行以第一次观察到的 LF/CRLF 先后决定，未扫描统计全文件多数习惯。
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	// 找到第一次 CRLF 的起点，找不到返回 -1。
	const crlfIdx = content.indexOf("\r\n");
	// 找到第一次 LF；CRLF 中的 LF 也会命中，所以结合两个位置判断。
	const lfIdx = content.indexOf("\n");
	// 没有 LF 时默认采用 LF 作为写回换行习惯。
	if (lfIdx === -1) return "\n";
	// 有 LF 但没有 CRLF，也按普通 LF。
	if (crlfIdx === -1) return "\n";
	// CRLF 的 CR 位置先于其 LF 时采用 CRLF；若前面已有单 LF，就采用 LF。
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/**
 * 将 CRLF 和单独 CR 全部统一为 LF，便于跨平台匹配 oldText；返回新字符串，不改磁盘。
 * 例如 Windows 文件和模型传来的 LF 片段可在同一坐标空间匹配。
 */
export function normalizeToLF(text: string): string {
	// 先把 CRLF 折成一个 LF，再处理剩余 CR，避免一组 CRLF 被拆出两行。
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 把已规范为 LF 的新内容恢复成指定换行习惯；ending=LF 时原样返回。
 * 例如 edit 计算完结果后，用先前 detectLineEnding 的值恢复 CRLF，再写回文件。
 */
export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	// 三元表达式按目标换行选择转换或原样返回，前提是输入已规范为 LF。
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
/**
 * 创建用于容错匹配的规范文本：Unicode NFKC、去行尾空白、统一弯引号/横线/特殊空格。
 * 例如弯双引号与普通双引号可视为同一片段；它不做语义理解，也不是任意拼写模糊搜索。
 * 返回的索引必须配合规范文本使用，不能直接拿去切原文；规范化可能改变字符长度。
 */
export function normalizeForFuzzyMatch(text: string): string {
	// 返回整条字符串规范化链的最终结果，下面每步都产生新字符串，不原地改输入。
	return (
		// 开始对输入文字进行一串不可变字符串转换，每步返回新字符串交下一步。
		text
			// Unicode 兼容正规化，例如全角/兼容形式可能折为同一形态；不是仅修改显示样式。
			.normalize("NFKC")
			// Strip trailing whitespace per line
			// 按 LF 拆行，后面逐行去尾部空白而非清掉整文件所有空白。
			.split("\n")
			// map 对每行调用 trimEnd，保留前导缩进，只去行末空白。
			.map((line) => line.trimEnd())
			// 按 LF 重新合并，保持行数关系，供后续按行保留原文。
			.join("\n")
			// Smart single quotes → '
			// 不同弯单引号/引号形式统一成 ASCII 单引号；g 表示全部替换。
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			// 不同弯双引号统一成 ASCII 双引号。
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			// Unicode 多种横线与减号统一为 ASCII 横线，用于有限文字容错。
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			// 各种不可见宽度不同空格统一成普通空格，避免复制粘贴形式差异导致找不到。
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * 把正文拆成保留 LF 结尾的行块；与简单 split 不同，重新 join 空串能拼回原字节层面的文字。
 * 例："a\nb" 得到 ["a\n","b"]，空文本得到空数组，纯计算。
 */
function splitLinesWithEndings(content: string): string[] {
	// 正则保留每行 LF，同时允许最后一行无换行；没匹配到时用空数组，?? 只处理空缺。
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

// 一行在正文里的字符坐标半开区间，位置以 JS 字符串索引为准。
interface LineSpan {
	// 该行包含的第一个字符位置。
	start: number;
	// 该行结束后的首个位置，本位置本身不包含在该行。
	end: number;
}

// 已经定位的编辑项，保留原数组下标和匹配坐标供重叠检测/应用。
interface MatchedEdit {
	// 原 edits 数组下标，用于错误提示，不随按文本位置排序而改写。
	editIndex: number;
	// oldText 在当前统一基线中的起点字符下标。
	matchIndex: number;
	// 本次匹配长度，容错匹配后可能不同于原 oldText 长度。
	matchLength: number;
	// 替换进去的文字；允许空串表示删除。
	newText: string;
}

// Pick 从已定位编辑类型中只挑应用替换所需的三项字段。
type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

/**
 * 为保留换行的每行计算起止字符下标，返回半开区间数组；用来将匹配范围映射到行。
 * 例如 "ab\nc" 第一行占 [0,3)，第二行占 [3,4)；offset 累计每行长度。
 */
function getLineSpans(content: string): LineSpan[] {
	// 累计前面行块的字符长度，作为下一行起点。
	let offset = 0;
	// 按行块顺序构造对应坐标，不读取或修改文件。
	return splitLinesWithEndings(content).map((line) => {
		// 当前行区间包括它自己的末尾 LF（如果存在）。
		const span = { start: offset, end: offset + line.length };
		// 下一行紧接本行结束位置。
		offset = span.end;
		// 返回本行普通坐标对象给 map 收集。
		return span;
	});
}

/**
 * 把一项字符替换范围映射成覆盖的行范围，返回从 0 开始、末尾不包含的 startLine/endLine。
 * 替换起终点超出基线正文则抛错；例：替换只触及第 2 行，返回 {startLine:1,endLine:2}。
 */
function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	// 取替换起点，属于基线正文的全局字符坐标。
	const replacementStart = replacement.matchIndex;
	// 结束位置不包含本身，便于与行块半开区间比较。
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	// 尚未找到覆盖起点的行，用 -1 作明确未找到标志。
	let startLine = -1;
	// 从首行逐一定位替换起点属于哪一行。
	for (let i = 0; i < lines.length; i++) {
		// 取得当前行坐标区间。
		const line = lines[i];
		// 起点必须在区间左闭右开范围内，不能落在前一行结束后的边界上。
		if (replacementStart >= line.start && replacementStart < line.end) {
			// 保存从 0 开始的起始行数组下标。
			startLine = i;
			// 当前定位/验证循环已达到停止条件，退出后继续后续计算。
			break;
		}
	}
	// 没有行覆盖该替换起点，说明坐标与基线不一致。
	if (startLine === -1) {
		// 拒绝越界坐标，不能静默切错内容。
		throw new Error("Replacement range is outside the base content.");
	}

	// 从起始行开始向后寻找覆盖整个替换范围的末行。
	let endLine = startLine;
	// 当前行结束还不够覆盖替换末端时，继续检查下一行。
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		// 扩大行范围，包含多行 oldText 触及的各行。
		endLine++;
	}
	// 替换终点超出最后一行，属于非法基线坐标。
	if (endLine >= lines.length) {
		// 拒绝越界坐标，不能静默切错内容。
		throw new Error("Replacement range is outside the base content.");
	}

	// 返回末尾不包含的行范围，后面可直接用于 slice(startLine,endLine)。
	return { startLine, endLine: endLine + 1 };
}

/**
 * 在给定正文中按从后到前应用已排序替换；offset 用于把全局字符坐标换算到当前行组子串。
 * 例：先改字符串后部，再改前部，前面替换变长也不会破坏后面原匹配坐标；纯计算不写磁盘。
 */
function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	// 字符串不可变，逐次构造新结果并用 let 更新局部引用。
	let result = content;
	// 必须从文本后部向前替换，前部变长/变短才不会影响尚未执行的原坐标。
	for (let i = replacements.length - 1; i >= 0; i--) {
		// 取这次要应用的一项已定位替换。
		const replacement = replacements[i];
		// 将全局坐标减掉当前子串起点，变为局部字符位置。
		const matchIndex = replacement.matchIndex - offset;
		// 构造“原前缀 + 新片段 + 原后缀”，被替换旧片段不保留。
		result =
			// substring 的末尾不包含该位置；后缀从旧匹配结束处继续，避免多删一个字符。
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	// 返回计算得到的新正文，不在这里写磁盘。
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
/**
 * 将规范基线上匹配到的替换映射回原文本，只重建真正触及的行组，其余行逐块原样保留。
 * 流程：按原位置排序 → 找每项覆盖行 → 合并相交行组 → 在基线对应组上替换 → 拼接原文未改行。
 * 例如 Unicode 容错匹配需要正规化一整份基线，但只改其中两行时，不应顺便清除别处行尾空格；本函数不访问文件。
 */
export function applyReplacementsPreservingUnchangedLines(
	// 尚未为容错而正规化的原文字，用于保留未修改行的原样内容。
	originalContent: string,
	// 匹配坐标所对应的统一基线，可能已经去尾空白/统一 Unicode。
	baseContent: string,
	// 已经匹配且知道位置的替换列表；这里不是重新按 oldText 搜索。
	replacements: TextReplacement[],
	// 保留未修改行的同步纯函数返回新正文；这里没有磁盘写入或 async。
): string {
	// 保存原文逐行块，未触及的行直接从这里复制。
	const originalLines = splitLinesWithEndings(originalContent);
	// 计算规范基线的行坐标，定位真正受到替换影响的行。
	const baseLines = getLineSpans(baseContent);
	// 按行对应保留原文的前提是两份文本行数一致，否则不能安全映射。
	if (originalLines.length !== baseLines.length) {
		// 前提不成立就拒绝，不凭相似内容猜测对齐位置。
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	// 一个行组包含触及的行范围及组内替换；相交的组会合并后一次重建。
	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	// 先浅复制数组再按起点排序，不改变调用者给的数组排列。
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	// 依原文位置逐项分组，for...of 直接取得数组元素。
	for (const replacement of sortedReplacements) {
		// 把字符范围转换成覆盖行组的范围。
		const range = getReplacementLineRange(baseLines, replacement);
		// 只需比较最后一个行组，因替换已按起点排序。
		const current = groups[groups.length - 1];
		// 新替换触及当前组内行时合并；恰好邻接但不共享行则无需合并。
		if (current && range.startLine < current.endLine) {
			// 组末端扩大到两项覆盖范围中更远的一端。
			current.endLine = Math.max(current.endLine, range.endLine);
			// 把此项替换归入已有组，避免同一行被多次不同基线重建。
			current.replacements.push(replacement);
			// 这项已处理，进入下一项替换/循环步骤。
			continue;
		}
		// 没有相交组时新建一组；对象展开拷贝起止行，替换数组初始只有本项。
		groups.push({ ...range, replacements: [replacement] });
	}

	// 标记原文中已经复制到哪里，后续补回未改行段。
	let originalLineIndex = 0;
	// 从空串开始按原文顺序拼接最终结果。
	let result = "";
	// 逐个重建有变化的行组，中间未变化部分从原文取。
	for (const group of groups) {
		// 把前一组到本组之间的原行块原样拼入，保留原空白/Unicode。
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		// 本组在规范基线中的字符起点。
		const groupStartOffset = baseLines[group.startLine].start;
		// endLine 不包含末端，所以减一取得最后覆盖行的结束位置。
		const groupEndOffset = baseLines[group.endLine - 1].end;
		// 只对这一组基线行段应用替换，再把改后组接入结果。
		result += applyReplacements(
			// 截出组内规范基线文本；不能用同坐标切可能长度不同的原文。
			baseContent.slice(groupStartOffset, groupEndOffset),
			// 交入此组所有已定位替换。
			group.replacements,
			// 局部替换函数用这个偏移把全局 matchIndex 转为组内坐标。
			groupStartOffset,
		);
		// 下一次应从本组之后的原行开始补未改内容。
		originalLineIndex = group.endLine;
	}
	// 最后一个变化组之后的全部原文行也必须原样补回。
	result += originalLines.slice(originalLineIndex).join("");

	// 返回计算得到的新正文，不在这里写磁盘。
	return result;
}

// 匹配结果附带坐标空间信息，调用方不能只看 found/index。
export interface FuzzyMatchResult {
	/** Whether a match was found */
	// 是否找到了目标旧片段。
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	// 在 contentForReplacement 中的字符起点，未找到用 -1。
	index: number;
	/** Length of the matched text */
	// 本次匹配长度，容错匹配后可能不同于原 oldText 长度。
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	// 是否经过规范化才命中；false 可能是精确成功，也可能未命中。
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	// 应用这些坐标时必须采用的正文基线。
	contentForReplacement: string;
}

// 输入替换意图：旧片段与新片段，不含事先计算的位置。
export interface Edit {
	// 必须在原文中唯一定位的目标片段。
	oldText: string;
	// 替换进去的文字；允许空串表示删除。
	newText: string;
}

// 用于后续写文件和生成 diff 的前后正文。
export interface AppliedEditsResult {
	// 展示差异的修改前正文，这里是原 LF 规范文本。
	baseContent: string;
	// 应用整批替换并保留未改行后的正文。
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
/**
 * 先对原字符串找完整 oldText，失败才在容错规范后的两串里查找；返回是否找到、坐标、长度及应使用的基线。
 * 例：原文件是弯引号，oldText 是普通引号时，可在规范文本里找到；返回的 index 只属于 contentForReplacement。
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	// 先尝试最严格直接子串匹配，索引属于当前原文本。
	const exactIndex = content.indexOf(oldText);
	// 找到了就无需 Unicode/空白容错，优先保留原正文坐标。
	if (exactIndex !== -1) {
		// 精确命中时把原文基线、原字符坐标和 matched 长度成组返回，防止调用者混用坐标空间。
		return {
			// 明确命中，后面才可以计算替换。
			found: true,
			// 精确匹配起点，直接对应输入 content。
			index: exactIndex,
			// 精确模式下匹配长度就是旧文字的 JS 字符串长度。
			matchLength: oldText.length,
			// 没有为这次命中改变匹配坐标空间。
			usedFuzzyMatch: false,
			// 原文就是可应用坐标的基线。
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	// 精确失败后建立容错正文；只处理明确编码/空白差异，不做语言语义推测。
	const fuzzyContent = normalizeForFuzzyMatch(content);
	// oldText 必须使用同样规范规则，否则两边坐标/比较方式不一致。
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	// 在统一坐标空间里寻找目标片段。
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	// 容错后仍找不到，返回明确未命中而不是随便选相近文字。
	if (fuzzyIndex === -1) {
		// 两种匹配都失败时返回 found:false 和 -1/0 坐标占位，不保留虚构替换范围。
		return {
			// 当前编辑无法定位。
			found: false,
			// 按字符串 indexOf 习惯表示不存在。
			index: -1,
			// 没有目标区域可被替换。
			matchLength: 0,
			// 没有为这次命中改变匹配坐标空间。
			usedFuzzyMatch: false,
			// 原文就是可应用坐标的基线。
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	// 容错命中时必须同时返回规范后的基线及对应索引长度，不能只传一个看似属于原文件的数字。
	return {
		// 明确命中，后面才可以计算替换。
		found: true,
		// 容错匹配坐标属于正规化后的 fuzzyContent。
		index: fuzzyIndex,
		// 正规化可能改变长度，不能用原 oldText.length 替代。
		matchLength: fuzzyOldText.length,
		// 标明后续整批替换需使用统一的容错基线。
		usedFuzzyMatch: true,
		// 把对应的规范正文一起交给调用者，避免错用原文坐标。
		contentForReplacement: fuzzyContent,
	};
}

/**
 * 将正文和 oldText 都容错正规化，再用分隔片段数量减一计出现次数，用来拒绝不唯一替换。
 * 例：两处仅引号/空格形式不同的同内容也会被当作多处，要求模型提供更明确的 oldText 上下文。
 */
function countOccurrences(content: string, oldText: string): number {
	// 精确失败后建立容错正文；只处理明确编码/空白差异，不做语言语义推测。
	const fuzzyContent = normalizeForFuzzyMatch(content);
	// oldText 必须使用同样规范规则，否则两边坐标/比较方式不一致。
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	// 每个非重叠出现的旧片段都会多切一段，因此分段数减一就是该规则下出现次数。
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

/** 构造找不到 oldText 的 Error，不在本函数抛出；单项/多项采用不同文字帮助模型定位 edits 下标。 */
function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	// 单项请求只需提到目标片段；多项请求另外带 edits 下标，便于准确修正。
	if (totalEdits === 1) {
		// 构造单项未找到错误，并不在此处立即 throw；真正验证函数会抛出它终止整批操作。
		return new Error(
			// 提示构成是路径加匹配要求；这是提供给模型的错误文字，匹配算法实际仍可能先尝试有限的规范化容错。
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	// 多项未找到错误使用带 edits 下标的提示模板，返回 Error 给验证调用方。
	return new Error(
		// 多项版本额外插入原编辑下标，不因随后按文本位置排序而改变这个编号。
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

/** 构造 oldText 不唯一错误，附命中次数；要求补足上下文，避免随意编辑其中一个相同片段。 */
function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	// 单项请求只需提到目标片段；多项请求另外带 edits 下标，便于准确修正。
	if (totalEdits === 1) {
		// 构造单项重复命中错误，错误消息会携带计数与路径。
		return new Error(
			// 报告出现次数和路径，要求补充能唯一定位的上下文，而非任选第一处修改。
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	// 多项重复错误另外标明原编辑下标，以便模型准确修正目标片段。
	return new Error(
		// 多项版本将次数、原项下标和目标路径一起给出，帮助模型定位哪条 oldText 不唯一。
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

/** 构造空 oldText 错误；空字符串到处都能匹配，不能作为精确替换目标。 */
function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	// 单项请求只需提到目标片段；多项请求另外带 edits 下标，便于准确修正。
	if (totalEdits === 1) {
		// 单项空 oldText 错误只需说明目标路径，禁止无明确匹配范围的替换。
		return new Error(`oldText must not be empty in ${path}.`);
	}
	// 多项错误附原 edits 下标，方便只修正那一项。
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

/** 构造替换后正文没变化的错误，避免把没有实际修改的操作报告为成功。 */
function getNoChangeError(path: string, totalEdits: number): Error {
	// 单项请求只需提到目标片段；多项请求另外带 edits 下标，便于准确修正。
	if (totalEdits === 1) {
		// 无变化错误也是先创建 Error 对象，再由核心算法在确认为相同正文时抛出。
		return new Error(
			// 单项替换无变化时给出路径及可能排查方向；这些文字是提示，不保证实际原因一定是特殊字符。
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	// 多项编辑整体没有改变正文时返回明确 Error 对象，交调用者决定何时 throw。
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
/**
 * 验证并计算一批编辑后的正文；所有 oldText 对同一份原始内容定位，不按 edits 数组逐项改完再匹配。
 * 流程：统一各项换行 → 拒绝空 oldText → 决定是否需容错基线 → 每项唯一匹配 → 按位置排序并拒绝重叠 → 倒序替换 → 验证确有变化。
 * 例：同时把文首 red 改 blue、文末 on 改 off，两项都用原文坐标；任何一项找不到/重复/重叠就整批抛错，不写文件。
 */
export function applyEditsToNormalizedContent(
	// 已统一为 LF 的原文件正文，所有编辑项都对同一份输入定位。
	normalizedContent: string,
	// 一批旧片段/新片段替换意图，不是预先排序的最终坐标；函数内部统一验证与排序。
	edits: Edit[],
	// 核心替换算法只用这个路径构造错误提示，不自行读取或写入该文件。
	path: string,
	// 成功返回改前/改后正文；失败通过 throw 报告，调用者不能把它当成部分成功。
): AppliedEditsResult {
	// 先把每项 oldText/newText 都规范成 LF；map 生成新数组，不原地改调用者编辑对象。
	const normalizedEdits = edits.map((edit) => ({
		// 旧文本换行与文件 LF 基线对齐。
		oldText: normalizeToLF(edit.oldText),
		// 新文本也先统一换行，最终写入阶段再统一恢复文件习惯。
		newText: normalizeToLF(edit.newText),
	}));

	// 按原编辑数组顺序验证并定位，i 留作错误提示中的 edits 下标。
	for (let i = 0; i < normalizedEdits.length; i++) {
		// 空旧文本没有明确替换区域，先拒绝再做匹配。
		if (normalizedEdits[i].oldText.length === 0) {
			// 抛出包含路径/下标的构造错误，整批编辑终止。
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	// 第一次对每项做探测，判断整批是否至少有一项需要容错。
	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	// some 只要任意项为 true 就成立，随后整批必须统一坐标空间。
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	// 不能把部分精确原文坐标与部分容错坐标混合；需要容错时统一在同一规范正文重新定位。
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	// 保存最终统一基线上的匹配起点/长度与原 edits 下标。
	const matchedEdits: MatchedEdit[] = [];
	// 按原编辑数组顺序验证并定位，i 留作错误提示中的 edits 下标。
	for (let i = 0; i < normalizedEdits.length; i++) {
		// 取当前替换意图，不提前对正文应用它。
		const edit = normalizedEdits[i];
		// 在整批统一基线上重新查找当前目标，确保各项坐标可比较。
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		// 任一项找不到就整批失败，不允许其他项先改磁盘。
		if (!matchResult.found) {
			// 给出需要修正的路径和编辑项位置。
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		// 还要检查唯一性；首次命中不意味着只存在一处。
		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		// 容错等价的多处文本也不能任选一个，要求模型补更短但唯一的上下文。
		if (occurrences > 1) {
			// 多处命中时整批拒绝，并报告出现次数。
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		// 确认唯一后保存已定位编辑，不马上写回字符串。
		matchedEdits.push({
			// 记录原输入顺序的编号，后面位置排序不会丢失错误定位信息。
			editIndex: i,
			// 该项在统一基线中的字符起点。
			matchIndex: matchResult.index,
			// 使用匹配器返回的真实规范长度。
			matchLength: matchResult.matchLength,
			// 新片段已做 LF 统一，尚未恢复平台换行。
			newText: edit.newText,
		});
	}

	// 按正文起点升序排列，便于检查邻项是否重叠；原 edits 数组未改。
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	// 从第二项起，逐对比较相邻已排序区域即可发现重叠。
	for (let i = 1; i < matchedEdits.length; i++) {
		// 前一个区域按起点更早。
		const previous = matchedEdits[i - 1];
		// 当前区域起点更晚或相等。
		const current = matchedEdits[i];
		// 前一项结束越过当前起点就重叠；刚好接壤不算共享字符。
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			// 检测到相邻已排序匹配重叠后立即抛出，所有替换仍只在内存定位阶段，文件未被部分修改。
			throw new Error(
				// 重叠错误给出原输入的两项下标和路径，建议合并为一项或选不相交区域，不能依次覆盖来掩盖歧义。
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	// 展示 diff 的原文仍是未做全局容错规范的 LF 文本。
	const baseContent = normalizedContent;
	// 根据是否进入容错空间，选择保留原未改行的路径或直接替换路径。
	const newContent = usedFuzzyMatch
		? // 容错模式只把受影响行组的规范结果覆盖回原文，其余行不随便清空白/改引号。
			applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: // 精确模式全部坐标已属原 LF 正文，直接倒序替换即可。
			applyReplacements(replacementBaseContent, matchedEdits);

	// 即使找到了旧片段，newText 与原文相同也不是实际修改。
	if (baseContent === newContent) {
		// 不报告虚假成功，由上层将无变化解释给模型。
		throw getNoChangeError(path, normalizedEdits.length);
	}

	// 返回计算后的前后正文，实际文件写入由 edit.ts 完成。
	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
/**
 * 调用 diff 库生成标准 unified patch 字符串，默认每个变化旁 4 行上下文；纯计算，不应用补丁。
 * 输入同一目标路径和前后正文；例如 UI 或程序可保存 patch，真正文件写入由 edit.execute 负责。
 */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	// 标准库 API 接收前后文件名/正文与可选额外头信息；同文件编辑的两个文件名都用 path。
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		// 配置每个变化周边保留的上下文行数，默认 4。
		context: contextLines,
		// 保留文件头等约定形式，避免库默认额外元数据头混入此工具 patch。
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
/**
 * 生成终端易读 diff，带行号、加减标记、有限上下文和新文件首个变化行；不是标准 patch 格式。
 * 例：新增行使用 + 与新文件行号，删除行使用 - 与旧文件行号；远离变化的大段不变内容用 ... 省略。
 */
export function generateDiffString(
	// 变化前正文，用于比对删除行及旧文件行号。
	oldContent: string,
	// 变化后正文，用于比对增加行及新文件行号。
	newContent: string,
	// 默认展示每处变化周围 4 行；默认参数是真正运行时默认值，不只是类型说明。
	contextLines = 4,
	// 返回一个对象，含终端 diff 与可能没有的首变行；对象类型在冒号后声明。
): { diff: string; firstChangedLine: number | undefined } {
	// 第三方 diff 返回保留、增加、删除的连续行块；本函数在其上增加终端行号/省略逻辑。
	const parts = Diff.diffLines(oldContent, newContent);
	// 逐行收集显示 diff，最后用换行合并。
	const output: string[] = [];

	// 旧正文行数组用于估计最大行号的显示宽度。
	const oldLines = oldContent.split("\n");
	// 新正文同理，行号可能比旧文件更多。
	const newLines = newContent.split("\n");
	// 取两份正文较大的行数，统一行号列宽。
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	// 例如最大 123 行时列宽为 3；左侧补空格后代码列对齐。
	const lineNumWidth = String(maxLineNum).length;

	// 旧文件行号独立计数，删除时推进它。
	let oldLineNum = 1;
	// 新文件行号独立计数，增加时推进它。
	let newLineNum = 1;
	// 上一块是否有变化，决定本块不变内容要保留前几行作为上下文。
	let lastWasChange = false;
	// 尚未看到变化时没有首变行，不能默认给出第 1 行。
	let firstChangedLine: number | undefined;

	// 依 diff 块原顺序扫描，同时维护旧/新两组行号。
	for (let i = 0; i < parts.length; i++) {
		// 当前连续块带 value，added/removed 为可选变化标签。
		const part = parts[i];
		// 把连续块拆成待展示行。
		const raw = part.value.split("\n");
		// diff 块末尾换行会产生一个额外空元素，去掉避免多显示虚构行。
		if (raw[raw.length - 1] === "") {
			// 原地移除拆行后的最后空元素。
			raw.pop();
		}

		// 新增块与删除块都作为变化完整展示，不按 contextLines 省略其内部内容。
		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			// 只在首次变化时记录新文件坐标，以便 UI 定位。
			if (firstChangedLine === undefined) {
				// 删除发生在新文件某个位置，首变行仍用当时的新行号表示。
				firstChangedLine = newLineNum;
			}

			// Show the change
			// 逐行输出当前变化块，保留块内部顺序。
			for (const line of raw) {
				// 新增行属于新文件，使用 newLineNum。
				if (part.added) {
					// 把新行号左补空格到统一列宽。
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					// + 标明新增加行，不是原正文字符。
					output.push(`+${lineNum} ${line}`);
					// 新增行只推进新文件行号，旧文件没有对应新增行。
					newLineNum++;
					// 当前变化块是删除而非新增，使用旧文件行号；新增只推进新行号，删除只推进旧行号。
				} else {
					// removed
					// 删除/保留行按旧文件行号列宽生成显示编号。
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					// - 标明删除行，正文仍只展示原行文字。
					output.push(`-${lineNum} ${line}`);
					// 旧文件行号前进；若是保留行，附近下一行还会同步推进新行号。
					oldLineNum++;
				}
			}
			// 下一个不变块需要考虑其开头作为这次变化后的上下文。
			lastWasChange = true;
			// 当前块没有 added/removed 标签，属于两份正文共同的未改内容，按邻近变化决定展示哪些上下文。
		} else {
			// Context lines - only show a few before/after changes
			// 安全查看下一块是否变化，避免访问数组末尾之外。
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			// 本不变块前面紧邻变化。
			const hasLeadingChange = lastWasChange;
			// 本不变块后面紧邻变化。
			const hasTrailingChange = nextPartIsChange;

			// 夹在两个变化块中间的不变段，可能两端都要保留上下文。
			if (hasLeadingChange && hasTrailingChange) {
				// 段长不超过两侧上下文总预算时，整段显示，避免多余省略号。
				if (raw.length <= contextLines * 2) {
					// 逐行输出当前变化块，保留块内部顺序。
					for (const line of raw) {
						// 删除/保留行按旧文件行号列宽生成显示编号。
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						// 空格标记不变上下文行，与 +、- 行区分。
						output.push(` ${lineNum} ${line}`);
						// 旧文件行号前进；若是保留行，附近下一行还会同步推进新行号。
						oldLineNum++;
						// 新增行只推进新文件行号，旧文件没有对应新增行。
						newLineNum++;
					}
					// 中间不变块太长时，只保留两端各 contextLines，省略中间但保持旧/新行号准确跳转。
				} else {
					// 取靠近前一个变化的前 contextLines 行。
					const leadingLines = raw.slice(0, contextLines);
					// 取靠近后一个变化的后 contextLines 行。
					const trailingLines = raw.slice(raw.length - contextLines);
					// 算出中间未展示行数，旧/新行号都仍需向前跳过它们。
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					// 先展示靠前一个变化的那端上下文。
					for (const line of leadingLines) {
						// 删除/保留行按旧文件行号列宽生成显示编号。
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						// 空格标记不变上下文行，与 +、- 行区分。
						output.push(` ${lineNum} ${line}`);
						// 旧文件行号前进；若是保留行，附近下一行还会同步推进新行号。
						oldLineNum++;
						// 新增行只推进新文件行号，旧文件没有对应新增行。
						newLineNum++;
					}

					// 省略行不伪造行号，空列对齐后显示 ...。
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// 旧文件行号跳过未显示的保留行，不是从文件删除这些行。
					oldLineNum += skippedLines;
					// 保留行在新文件也存在，所以两边同步跳过。
					newLineNum += skippedLines;

					// 再展示靠后一个变化的那端上下文。
					for (const line of trailingLines) {
						// 删除/保留行按旧文件行号列宽生成显示编号。
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						// 空格标记不变上下文行，与 +、- 行区分。
						output.push(` ${lineNum} ${line}`);
						// 旧文件行号前进；若是保留行，附近下一行还会同步推进新行号。
						oldLineNum++;
						// 新增行只推进新文件行号，旧文件没有对应新增行。
						newLineNum++;
					}
				}
				// 只前面有变化，本段保留开头 contextLines 行即可，远离变化的末尾省略。
			} else if (hasLeadingChange) {
				// 取得变化之后紧邻的上下文。
				const shownLines = raw.slice(0, contextLines);
				// 剩余远处不变行不展示，但计数仍要推进。
				const skippedLines = raw.length - shownLines.length;

				// 按顺序输出这一侧上下文，行号两边同增。
				for (const line of shownLines) {
					// 删除/保留行按旧文件行号列宽生成显示编号。
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					// 空格标记不变上下文行，与 +、- 行区分。
					output.push(` ${lineNum} ${line}`);
					// 旧文件行号前进；若是保留行，附近下一行还会同步推进新行号。
					oldLineNum++;
					// 新增行只推进新文件行号，旧文件没有对应新增行。
					newLineNum++;
				}

				// 确实省略了行才加 ...，避免空省略提示。
				if (skippedLines > 0) {
					// 省略行不伪造行号，空列对齐后显示 ...。
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// 旧文件行号跳过未显示的保留行，不是从文件删除这些行。
					oldLineNum += skippedLines;
					// 保留行在新文件也存在，所以两边同步跳过。
					newLineNum += skippedLines;
				}
				// 只后面有变化，本段只保留靠近该变化的最后几行。
			} else if (hasTrailingChange) {
				// 前半段省略数量不能为负，小段不省略。
				const skippedLines = Math.max(0, raw.length - contextLines);
				// 确实省略了行才加 ...，避免空省略提示。
				if (skippedLines > 0) {
					// 省略行不伪造行号，空列对齐后显示 ...。
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// 旧文件行号跳过未显示的保留行，不是从文件删除这些行。
					oldLineNum += skippedLines;
					// 保留行在新文件也存在，所以两边同步跳过。
					newLineNum += skippedLines;
				}

				// 显示跳过前面远处行之后的尾部上下文。
				for (const line of raw.slice(skippedLines)) {
					// 删除/保留行按旧文件行号列宽生成显示编号。
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					// 空格标记不变上下文行，与 +、- 行区分。
					output.push(` ${lineNum} ${line}`);
					// 旧文件行号前进；若是保留行，附近下一行还会同步推进新行号。
					oldLineNum++;
					// 新增行只推进新文件行号，旧文件没有对应新增行。
					newLineNum++;
				}
				// 前后都没有变化相邻的保留块完全不展示，仍同步推进两组行号，不代表删除原文件内容。
			} else {
				// Skip these context lines entirely
				// 完全远离变化的不变块不显示，但旧行号仍前进整块。
				oldLineNum += raw.length;
				// 新行号也同步前进，因为它们是两份正文共有内容。
				newLineNum += raw.length;
			}

			// 当前处理完的是不变块，供下一块决定上下文边界。
			lastWasChange = false;
		}
	}

	// 返回终端 diff 与可选首变行；无变化时首变行保持 undefined。
	return { diff: output.join("\n"), firstChangedLine };
}

// 预览计算成功的结构，含显示 diff 与可选跳转行。
export interface EditDiffResult {
	// 终端显示 diff，不是写回文件全文。
	diff: string;
	// 新文件首变行，可能没有可定位变化。
	firstChangedLine: number | undefined;
}

// 预览失败也用普通数据返回，渲染器可展示错误而不让 UI Promise 整体失败。
export interface EditDiffError {
	// 错误说明文字。
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
/**
 * 给执行前 UI 预览计算一批 edits 的 diff：读取但不写文件，错误转成 {error} 返回而非拒绝整个渲染。
 * 流程：解析路径 → 检查可读 → 读 UTF-8 → 去 BOM/规范换行 → 复用执行用替换算法 → 生成展示 diff。
 * 预览只证明该次读取时可应用；实际执行仍需重新读文件并验证，以免文件在预览后变化。
 */
export async function computeEditsDiff(
	// 要预览的目标文件路径；本函数按 cwd 解析后实际读取当前内容，但不写回。
	path: string,
	// 一批旧片段/新片段替换意图，不是预先排序的最终坐标；函数内部统一验证与排序。
	edits: Edit[],
	// 会话工作目录，决定相对目标路径指向哪里。
	cwd: string,
	// 异步预览返回成功或错误数据两种形状，调用方可按 error 字段区分，不需把 UI 计算失败当进程崩溃。
): Promise<EditDiffResult | EditDiffError> {
	// 按会话工作目录解析路径，预览与真正执行使用相同路径规则。
	const absolutePath = resolveToCwd(path, cwd);

	// 整个预览读取/计算错误会在最外层转为 {error}，供渲染器显示而不造成未处理拒绝。
	try {
		// Check if file exists and is readable
		// 先单独检查读取权限，使错误消息能明确指向目标文件，不进入后续内容匹配。
		try {
			// 预览只需要读取权限，不在这里检查/执行写入。
			await access(absolutePath, constants.R_OK);
			// 文件系统错误可能不是标准 Error，所以先收窄并提取 code，再构成可读预览失败结果。
		} catch (error: unknown) {
			// 外部文件错误可带 code，否则 String 处理任意抛出值。
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			// 把路径错误当预览结果返回，调用者可选择显示，不误当成功 diff。
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		// 真正读取当前文件文字，后续计算不改文件。
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		// 预览时去掉不可见 BOM 并改名为 content；不需要写回因此不保留 bom 变量。
		const { text: content } = splitBom(rawContent);
		// 统一换行，保证与执行算法的匹配规则一致。
		const normalizedContent = normalizeToLF(content);
		// 复用正式执行的唯一性/重叠/容错检查，避免预览另实现一套规则。
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		// 只生成展示 diff；没有调用 writeFile，因此预览不修改文件。
		return generateDiffString(baseContent, newContent);
		// 读取或替换计算任意一步失败都作为错误数据返回，预览不会因为部分结果而写文件。
	} catch (err) {
		// 所有计算/读取失败都折成可读错误数据，便于 UI 安全展示。
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
/**
 * 单次编辑预览的便利包装，把 oldText/newText 包成一项数组后复用批量预览函数。
 * 返回 Promise<EditDiffResult|EditDiffError>；没有文件写入副作用。
 */
export async function computeEditDiff(
	// 单项预览的目标路径，交给批量预览入口执行只读查询。
	path: string,
	// 单项预览想定位的旧文字，必须能唯一匹配才可成功预览。
	oldText: string,
	// 预期替换后的文字，允许空串表示删除旧片段。
	newText: string,
	// 会话工作目录，决定相对目标路径指向哪里。
	cwd: string,
	// 异步预览返回成功或错误数据两种形状，调用方可按 error 字段区分，不需把 UI 计算失败当进程崩溃。
): Promise<EditDiffResult | EditDiffError> {
	// 单次替换包装为一元素数组，共享批量预览逻辑。
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
