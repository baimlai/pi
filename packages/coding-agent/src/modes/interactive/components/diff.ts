// 给工具的带行号差异文字着色；只做终端展示，不应用补丁，也不是完整 unified diff 文件解析器。
// 命名空间导入库的全部导出，这里只调用同步 diffWords 做一对行的词级比较。
import * as Diff from "diff";
// 读取当前主题的删除/新增/上下文色及反色样式。
import { theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
// 拆一行的前缀、可选行号及正文，返回对象或 null；例 "+12 hi" 得到 prefix="+"、lineNum="12"、content="hi"。
// 只解析工具约定的简单显示格式，不验证补丁区块/文件路径；无副作用，未匹配则由调用方按上下文显示。
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	// ^/$ 限定整串：首组是加/减/空白，第二组允许空白与零个以上数字，然后一个空白分隔正文；行号可以为空。
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	// 没有匹配时用 null 明确表示无法按此简单格式拆分。
	if (!match) return null;
	// 正则捕获组从下标 1 开始，保留行号组原有空格，不转成 number。
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
// 把每个 tab 换成三个空格，返回显示字符串；例 "a\tb" 变 "a   b"，不是按当前列计算 tabstop。
function replaceTabs(text: string): string {
	// g 替换全部 tab，不只第一个，不修改原输入字符串。
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
// 比较一条旧正文和新正文，返回两份带反色的显示行；例 "hello old"→"hello new" 只突出变化的词。
// 按库 diffWords 的词/标点规则比较，空白差异不作为主要匹配依据；首次增/删片段的前置空白留在反色之外。
// 只调用同步库与主题函数，不改文件，库或样式异常会传播。
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	// 不传异步回调或中止预算，按本地类型得到 ChangeObject[]，每项有 value 及可选 added/removed 标记。
	const wordDiff = Diff.diffWords(oldContent, newContent);

	// 累计旧行显示，let 允许追加字符串。
	let removedLine = "";
	// 分别累计新行，不能将两边混成一条。
	let addedLine = "";
	// 只对首个删除片段执行前置空白移出反色处理。
	let isFirstRemoved = true;
	// 新增片段使用自己的首次标记，独立于删除。
	let isFirstAdded = true;

	// 按库返回顺序遍历共同片段、删除片段和新增片段。
	for (const part of wordDiff) {
		// 删除片段只加到旧行，不加到新行。
		if (part.removed) {
			// 局部复制字符串引用后可截掉前置空白，不修改库返回对象。
			let value = part.value;
			// Strip leading whitespace from the first removed part
			// 第一次遇删除内容才检查空白；并非每个变化词都清前导空格。
			if (isFirstRemoved) {
				// ^ 开头的空白捕获组，?.[1] 是可选下标访问；无匹配/空白时回退空串。
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				// 去掉当前片段前缀空白，准备只反色剩余文字。
				value = value.slice(leadingWs.length);
				// 删除侧先保留未反色的空白。
				removedLine += leadingWs;
				// 记录已经处理首个删除片段。
				isFirstRemoved = false;
			}
			// 片段只剩空串时不添加无意义的反色控制序列。
			if (value) {
				// 将非空删除片段包反色后追加到旧行。
				removedLine += theme.inverse(value);
			}
			// 新增片段只影响新行；else if 保证一个片段只进一个分支。
		} else if (part.added) {
			// 局部复制字符串引用后可截掉前置空白，不修改库返回对象。
			let value = part.value;
			// Strip leading whitespace from the first added part
			// 新增侧也只处理首个新增片段的前置空白。
			if (isFirstAdded) {
				// ^ 开头的空白捕获组，?.[1] 是可选下标访问；无匹配/空白时回退空串。
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				// 去掉当前片段前缀空白，准备只反色剩余文字。
				value = value.slice(leadingWs.length);
				// 新增侧的空白保持正常背景，避免整段缩进反色。
				addedLine += leadingWs;
				// 后续新增片段不再做首次空白剥离。
				isFirstAdded = false;
			}
			// 片段只剩空串时不添加无意义的反色控制序列。
			if (value) {
				// 突出新内容中真正变化的非空部分。
				addedLine += theme.inverse(value);
			}
		} else {
			// 共同片段原样加入旧行。
			removedLine += part.value;
			// 同一共同片段也原样加入新行，不加反色。
			addedLine += part.value;
		}
	}

	// 对象属性简写返回旧/新两份显示正文，还未加整行红/绿前景色。
	return { removedLine, addedLine };
}

// 公开选项接口保留现有形状；它只参与 TS 检查，当前实现不读取这些选项。
export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	// 可选路径未参与渲染，不会据此读文件、生成链接或改变词比较方式。
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
// 按行解析并着色差异，返回带 ANSI 的多行字符串；输入已是工具生成的差异，_options 当前未使用。
// 流程：无法拆行的按上下文→收连续删除与紧随新增→仅一删一增做词内高亮→拼回换行。
// 例 "-1 old\n+1 new" 用删除/新增主题色分开显示并突出变化词；不改文件，不捕获库/主题异常。
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	// 按 LF 拆源文字；末尾换行会保留一个空元素，之后 join 可还原它。
	const lines = diffText.split("\n");
	// 显式字符串数组累计着色后的行。
	const result: string[] = [];

	// 共享扫描位置，从第一行开始。
	let i = 0;
	// 部分分支会消费一整组行，因此用手动推进的 while 而非每次固定加一。
	while (i < lines.length) {
		// 取当前尚未处理的原行。
		const line = lines[i];
		// 尝试按工具前缀/行号格式拆分，不假设每行都合规。
		const parsed = parseDiffLine(line);

		// 原样差异头或其他无法识别的行不会尝试词比较。
		if (!parsed) {
			// 只加上下文颜色；该分支不替换 tab。
			result.push(theme.fg("toolDiffContext", line));
			// 单行分支消费当前行，前进到下一行。
			i++;
			// 跳到下一轮，避免再访问 parsed 的字段。
			continue;
		}

		// 删除行开始一个组，尝试收它后面的连续新增。
		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			// 数组元素的内联对象类型只存行号原文及正文，前缀在输出时重新加。
			const removedLines: { lineNum: string; content: string }[] = [];
			// 从当前位置收同一类连续行，遇其他类型停，不先消费边界行。
			while (i < lines.length) {
				// 每条候选仍需按同一规则解析。
				const p = parseDiffLine(lines[i]);
				// 解析失败或不再是删除行时结束删除组。
				if (!p || p.prefix !== "-") break;
				// 保存删除行，保持原顺序。
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				// 成功收下一条后推进索引；之后组内无需重复处理它。
				i++;
			}

			// Collect consecutive added lines
			// 删除组之后紧邻的新增行另存数组，不跨上下文行配对。
			const addedLines: { lineNum: string; content: string }[] = [];
			// 从当前位置收同一类连续行，遇其他类型停，不先消费边界行。
			while (i < lines.length) {
				// 每条候选仍需按同一规则解析。
				const p = parseDiffLine(lines[i]);
				// 非新增候选留给外层循环，结束本新增组。
				if (!p || p.prefix !== "+") break;
				// 保存新增正文与行号，不在此计算变化。
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				// 成功收下一条后推进索引；之后组内无需重复处理它。
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			// 只有精确一删一增才尝试词内差异；多对多不猜逐行对应关系。
			if (removedLines.length === 1 && addedLines.length === 1) {
				// 读取已由长度条件保证存在的唯一删除行。
				const removed = removedLines[0];
				// 读取唯一新增行。
				const added = addedLines[0];

				// 解构词比较结果，用于分别绘制旧/新行。
				const { removedLine, addedLine } = renderIntraLineDiff(
					// 比较前先把旧行 tab 换为三个空格。
					replaceTabs(removed.content),
					// 新行使用相同正规化规则。
					replaceTabs(added.content),
				);

				// 旧行加减号/原行号/分隔空格，并套删除色，内部反色仍保留。
				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				// 新行加加号/原行号/空格并套新增色。
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				// 非一对一时先依次绘制所有旧行。
				for (const removed of removedLines) {
					// 仅整行删除色，仍正规化 tab，不做词内反色。
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				// 旧行全部完成后绘制该组新增行。
				for (const added of addedLines) {
					// 整行新增色，不尝试与某条删除行配对。
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
			// 没有紧接删除组的独立新增行按单行处理。
		} else if (parsed.prefix === "+") {
			// Standalone added line
			// 重建新增前缀并着色，未做词内比较。
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			// 单行分支消费当前行，前进到下一行。
			i++;
		} else {
			// Context line
			// 其余空白前缀作为上下文，用一个空格统一前缀并正规化正文 tab。
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			// 单行分支消费当前行，前进到下一行。
			i++;
		}
	}

	// 按源行顺序用 LF 拼回，返回可供 Text 展示的字符串。
	return result.join("\n");
}
