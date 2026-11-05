// 把Markdown源码变成带ANSI样式的终端行数组；消息组件传文字/主题，TUI之后才把结果写终端。这里只用Marked词法树，不调用其HTML生成器。
// 流程是可选transform→分词→按块/行内语法渲染→按列换行和补白；包含流式半截数学/围栏处理、弱引用token/块缓存及独立代码高亮复用。
// Marked/Tokenizer是运行时类；type Token/Tokens/TokenizerExtension/TokensList只约束词法结果，不生成校验器。
import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens, type TokensList } from "marked";
// 第三方扩展改善中日韩邻接标点的强调分隔规则；下面只采用其emStrong，未采用它的del。
import markedCjkFriendly from "marked-cjk-friendly";
// 有限LaTeX子集转Unicode文本/二维字符布局，不执行TeX或网络服务；不支持的表达式返回undefined以保留原文。
import { renderLatex } from "../latex.ts";
// 读取终端能力、编码OSC8及识别图片行；生成链接不访问URL，冷能力查询可能探测环境，调用方可显式覆盖。
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
// Component只要求render/invalidate等静态契约，不因implements就自动挂到TUI。
import type { Component } from "../tui.ts";
// 共享列宽、ANSI换行、CJK标点和V8字符串压平；背景在整行补白阶段处理，避免只给正文着色。
import { applyBackgroundToLine, cjkPunctuationRegex, flattenLines, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

// 严格识别双波浪删除线：首尾不接空白/额外波浪，允许反斜杠转义，\1要求闭合符同为~~；没有启用单波浪语法。
const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

// 继承Marked的词法器，仅替换裸URL与删除线识别；super保留其他已安装版本的解析行为。
class MarkdownTokenizer extends Tokenizer {
	// 覆盖裸URL识别，输入当前剩余源码、返回Link或undefined；先用父实现取候选，再在CJK标点处缩短重新解析，无I/O。
	// 例：裸https地址后中文逗号留作正文；显式[文字](地址)和尖括号自动链接走其他Marked方法，不在这里截断。
	override url(src: string): Tokens.Link | undefined {
		// 先让父类识别裸链接/邮箱等默认形状。
		const token = super.url(src);
		// 父类没有命中就交回普通文本路径。
		if (!token) return undefined;

		// Bare URLs stop at CJK punctuation; explicit links and angle autolinks
		// use separate tokenizers and can still contain these characters.
		// 在候选原文里找第一个共享CJK标点，search未找到为-1，不把普通汉字视作标点。
		const punctuationIndex = token.raw.search(cjkPunctuationRegex);
		// 无标点保留原token；有则将标点之前的子串重新交父类，让英文末标点修剪等规则仍生效。
		return punctuationIndex < 0 ? token : super.url(token.raw.slice(0, punctuationIndex));
	}

	// 覆盖删除线词法规则，输入剩余源码、返回带子token的Del或undefined；例：~~word~~识别，~word~不识别，不修改源码。
	override del(src: string): Tokens.Del | undefined {
		// 只按本模块严格双波浪正则匹配起始位置。
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		// 不符合语法就不生成删除线token。
		if (!match) {
			// undefined让词法器继续其他候选规则。
			return undefined;
		}

		// 取第二捕获组作为不含~~的内容。
		const text = match[2];
		// 构造与Marked内置Del形状一致的普通对象。
		return {
			// type标签供后面的渲染switch分派。
			type: "del",
			// raw包含实际消费的完整分隔符和正文，供词法器前进及缓存键使用。
			raw: match[0],
			// text用属性简写保存不含外层分隔符的正文。
			text,
			// 递归解析其中的行内粗体/代码等，this.lexer来自Marked词法环境，不是本文件临时创建的独立树。
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

// 自定义数学token扩展Generic；as断言不会检查对象，实际字段由下面两个tokenizer构造。
interface LatexToken extends Tokens.Generic {
	// inline数学与块数学用不同标签，便于选择一维/二维布局。
	type: "latex" | "latexBlock";
	// 不含外层数学分隔符的源码。
	text: string;
	// 可选pending标记流式内容尚未闭合，渲染时保留raw而不强行算公式。
	pending?: boolean;
}

// 判断指定UTF-16位置前是否有奇数个连续反斜杠，返回boolean无修改；例：一个反斜杠转义美元，两个表示美元未被转义。
function isEscaped(source: string, index: number): boolean {
	// 累计紧邻目标之前的反斜杠数量。
	let backslashes = 0;
	// 从目标前一位置向左数，到非反斜杠或开头停止。
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		// 每个连续反斜杠加一。
		backslashes++;
	}
	// 模2余1表示最后一个反斜杠在转义目标，偶数表示成对抵消。
	return backslashes % 2 === 1;
}

// 从start寻找未被转义的closing分隔符，返回下标或-1，不修改源码；调用方提供非空closing，例：跳过被反斜杠转义的美元。
function findClosingDelimiter(source: string, closing: string, start: number): number {
	// 先用indexOf找到首个候选位置。
	let index = source.indexOf(closing, start);
	// 只要有候选且该处被转义，就继续往后找。
	while (index >= 0 && isEscaped(source, index)) {
		// 越过整个分隔符后再找下一处，避免重复同一位置。
		index = source.indexOf(closing, index + closing.length);
	}
	// 返回有效闭合位置，没找到保持-1。
	return index;
}

// 对未闭合美元内容做“像数学吗”的启发式判断，无副作用；例：x^2可保留为pending，普通价格文字未必算公式。
function looksLikePendingDollarMath(source: string): boolean {
	// 反斜杠命令或运算/括号等字符任一出现即true，不验证完整LaTeX，也不保证不会把普通文本当候选。
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

// 从当前源码开头识别行内数学，返回自定义token或undefined；支持美元/双美元/反斜杠括号，排除常见货币/变量/代码歧义。
// 例：闭合$x^2$生成latex，流式$加math命令可标pending；这是有限启发式，是否支持公式由renderLatex之后决定，不在此求值。
function tokenizeInlineLatex(source: string): LatexToken | undefined {
	// 稍后保存实际识别的开分隔符。
	let opening = "";
	// 闭分隔符可与开符相同，也可为对应右括号。
	let closing = "";
	// 双美元优先，避免被单美元分支抢先。
	if (source.startsWith("$$")) {
		// 开符记为$$。
		opening = "$$";
		// 闭符也为$$。
		closing = "$$";
		// 识别反斜杠左圆括号。
	} else if (source.startsWith("\\(")) {
		// 保留这个开符以便计算正文起点。
		opening = "\\(";
		// 闭符对应反斜杠右圆括号。
		closing = "\\)";
		// 反斜杠方括号也可作为这条行内识别路径的候选。
	} else if (source.startsWith("\\[")) {
		// 保存其开符。
		opening = "\\[";
		// 闭符为反斜杠右方括号。
		closing = "\\]";
		// 单美元后紧跟空白不算开数学，避免某些普通金额/文字歧义。
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		// 保存单美元开符。
		opening = "$";
		// 闭符为另一个未转义单美元。
		closing = "$";
		// 不是上述开头就不属于自定义数学。
	} else {
		// 返回undefined供Marked尝试其他行内语法。
		return undefined;
	}

	// 从开符之后找未转义闭符。
	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	// 下面只对已闭合的单美元额外排除几种常见歧义。
	if (
		// 确实找到闭合下标。
		closingIndex >= 0 &&
		// 只限制单美元，其他显式分隔符不执行这组歧义规则。
		opening === "$" &&
		// 正文以空白结束就拒绝，避免美元误配对。
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			// 闭美元之后立刻是数字也拒绝，帮助保留连续价格文本。
			/^\d/.test(source.slice(closingIndex + 1)) ||
			// 正文像大写shell变量（可带一个末尾标点）时，还需看后面是否接变量式文字。
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
				// 后面以字母/下划线标识符开头时，倾向把它看作相邻shell变量文本而非数学。
				/^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
			// 正文含反引号时也拒绝此数学识别，避免吞掉代码片段。
			source
				.slice(opening.length, closingIndex)
				.includes("`"))
	) {
		// 任一歧义成立则保留给Marked普通处理，不消费此串。
		return undefined;
	}

	// 还没找到闭符，可能是流式输出中的半截公式。
	if (closingIndex < 0) {
		// pending正文取开符之后的全部现有内容。
		const pendingSource = source.slice(opening.length);
		// 反斜杠显式开符，或美元内容看起来像数学，才生成pending；不是所有未闭合美元都吞到末尾。
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			// raw保留整段原文，pending=true阻止渲染阶段提前转换。
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		// 不够像公式的未闭合美元交给普通文本规则。
		return undefined;
	}

	// 闭合情况只取两个分隔符之间的正文。
	const text = source.slice(opening.length, closingIndex);
	// 空正文或跨换行不作为此行内token。
	if (!text || text.includes("\n")) {
		// 交回其他规则，块数学另有识别路径。
		return undefined;
	}

	// raw包含闭符，用于告诉Marked消费多少源字符串。
	const raw = source.slice(0, closingIndex + closing.length);
	// 返回完整行内数学token，未标pending即按已闭合处理。
	return { type: "latex", raw, text };
}

// 识别GFM表格分隔行：最多3空格缩进、可选边管道、连字符与可选冒号，支持单列/多列，不解析表格单元内容。
const TABLE_DELIMITER_ROW_REGEX = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

// A GFM table starts with a header row followed by a delimiter row such as "|---|---|" or "| --- |".
// The header needs a "|" only when the delimiter has none: a pipe-free delimiter without a pipe in the
// header is a thematic break, not a table.
// 扫描一段源码是否出现“表头+分隔行”组合，返回boolean不改文本；用于防止未闭公式吞表格，例：有管道表头加---行可命中。
function containsTableStart(source: string): boolean {
	// 以LF拆开候选数学内容。
	const lines = source.split("\n");
	// 每次检查相邻两行，最后一行单独不能构成表格开始。
	for (let index = 0; index < lines.length - 1; index++) {
		// 后一行作为表格分隔行候选。
		const delimiterRow = lines[index + 1];
		// 表头或分隔行至少一个含管道，且分隔行语法通过；纯无管道---不误当表格。
		if ((delimiterRow.includes("|") || lines[index].includes("|")) && TABLE_DELIMITER_ROW_REGEX.test(delimiterRow)) {
			// 找到一处就足够，立即true。
			return true;
		}
	}
	// 没有组合就false，允许数学继续处理。
	return false;
}

// 从源码开头识别块数学，返回latexBlock或undefined；先找闭合美元/方括号，再识别流式pending，并拒绝跨表格内容。
// 例：$$未闭但后面是GFM表格，就把机会让回Marked，不吞整张表；只分词，不调用TeX，不修改输入。
function tokenizeBlockLatex(source: string): LatexToken | undefined {
	// Display math never spans a table. Without this check, an unclosed "$$" or "\[" pairs with a later
	// opener or stays pending, swallowing the table. See https://github.com/earendil-works/pi/issues/11159.
	// 匹配最多3空格缩进、$$开闭、可选行尾空白/换行；[\s\S]*?跨行非贪婪找第一个可配闭符，此块正则未用isEscaped检查。
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	// 捕获正文真值且不含表格开始时才接受，?.避免无匹配访问。
	if (dollarMatch?.[1] && !containsTableStart(dollarMatch[1])) {
		// raw消费匹配整段，text去首尾空白后交二维渲染。
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	// 同样识别反斜杠方括号块开闭形式。
	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	// 正文存在且没有表格跨越才生成块token。
	if (bracketMatch?.[1] && !containsTableStart(bracketMatch[1])) {
		// 保存原文与trim后的数学源码。
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	// 未闭合反斜杠方括号可以覆盖目前剩余源码。
	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	// 有正文且没有表格开始时保留pending，不要求额外“像数学”启发式。
	if (pendingBracket?.[1] && !containsTableStart(pendingBracket[1])) {
		// 保留未经trim的正文和全部raw，pending渲染回原文。
		return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	}
	// 未闭合$$也作为候选，但还要检查是否像数学。
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	// 非空、看起来是数学、并且未跨表格时才保留。
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1]) && !containsTableStart(pendingDollar[1])) {
		// 标记块pending，不进行提前二维转换。
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	// 其他开头不由本tokenizer消费。
	return undefined;
}

// 只读类型的扩展数组约束开发期不能通过此引用push，运行时不freeze；对象里的函数在Marked扫描时才执行。
const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		// 块扩展名称要与生成token的type一致。
		name: "latexBlock",
		// block决定由Marked块级扫描阶段调用。
		level: "block",
		// 块级起点提示函数，输入剩余source、返回可能开头位置或undefined，无修改；例：普通段落后换行处的$$可提示提前切段。
		start(source) {
			// 寻找行头/换行后的显式块数学开头，允许最多3个空格。
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			// 若匹配包含前导LF，就把位置加1指向数学所在行，不把该LF当成开头文本。
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		// 登记真正tokenizer函数引用，此行不立刻识别公式。
		tokenizer: tokenizeBlockLatex,
	},
	{
		// 行内扩展与latex标签配对。
		name: "latex",
		// inline使它参与行内词法扫描。
		level: "inline",
		// 行内起点提示函数，返回三个开符最靠前的位置或undefined；只做查找，真正闭合/歧义判断在tokenizeInlineLatex。
		start(source) {
			// 同时找美元、反斜杠圆括号、反斜杠方括号的位置。
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
				// 过滤indexOf未找到的-1结果，箭头回调返回布尔值。
				(index) => index >= 0,
			);
			// 有候选取最小下标；...展开数字参数，无候选返回undefined让Marked继续。
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		// 登记行内tokenizer实现。
		tokenizer: tokenizeInlineLatex,
	},
];

// 原地修正最后一个流式代码token的text，返回void；只沿末尾列表最后项/引用递归，避免半截闭围栏显示后下一帧突然少一行。
// 例：开```、正文、末行``，先把末行从token.text去掉；raw不改、完整围栏不删。readonly只限制数组操作，不冻结其中token对象。
function trimPartialClosingFences(tokens: readonly Token[]): void {
	// 只考察数组最后一个token，空数组得到undefined。
	const token = tokens[tokens.length - 1];
	// 最后块是列表时，仅沿最后一项的子token继续找末尾代码。
	if (token?.type === "list") {
		// 缺最后项/tokens按空数组处理；递归会修改对应原token对象。
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		// 列表路径处理完就结束，不再把列表本身当代码。
		return;
	}
	// 末尾引用同样可能包住未完围栏。
	if (token?.type === "blockquote") {
		// 沿该引用末尾token递归。
		trimPartialClosingFences(token.tokens ?? []);
		// 引用路径结束。
		return;
	}
	// 最后token不是code（含空数组）就无需修正。
	if (token?.type !== "code") {
		// 不遍历/修改之前已完成的块。
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	// 从raw起头取至少3个相同反引号或波浪符作为开围栏；缩进等其他形式不在此匹配。
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	// 拿raw最后一行判断是不是流式半截闭合符。
	const lastLine = token.raw.split("\n").pop();
	// 必须有开围栏/非空末行，末行比开围栏短且全由相同符号构成；完整闭合围栏不会被删。
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		// 不满足则保留token.text。
		return;
	}

	// 从代码正文末尾减去半截围栏长度，再删一个尾LF，raw与其他字段不变。
	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

// 模块级创建专用Marked实例，供所有Markdown组件分词；不是调用全局marked默认实例，也未进行HTML渲染。
const markdownParser = new Marked();
// 给这份实例设置定制词法器。
markdownParser.setOptions({
	// url/del使用上面的继承实现，其他规则由Marked提供。
	tokenizer: new MarkdownTokenizer(),
});
// 合并安装额外词法扩展，注册本身不处理用户文字。
markdownParser.use({
	// 只取CJK扩展的emStrong函数改善强调；不安装它的del，保留本类严格双波浪行为。
	tokenizer: { emStrong: markedCjkFriendly().tokenizer?.emStrong },
	// ...浅复制数学扩展数组供Marked注册，块/行内方法引用不复制实现。
	extensions: [...LATEX_MARKDOWN_EXTENSIONS],
});

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
// 默认正文样式的编译期配置，字段都可缺；只有应用路径实际读取它们，背景另在完整行补白阶段处理。
export interface DefaultTextStyle {
	/** Foreground color function */
	// 可选前景包装回调，输入文本返回样式文本；类型不保证保持宽度或无副作用。
	color?: (text: string) => string;
	/** Background color function */
	// 可选背景回调，稍后接收包含补白的整行，避免只给正文上背景。
	bgColor?: (text: string) => string;
	/** Bold text */
	// 默认是否用主题粗体函数包正文。
	bold?: boolean;
	/** Italic text */
	// 默认斜体开关。
	italic?: boolean;
	/** Strikethrough text */
	// 默认删除线开关。
	strikethrough?: boolean;
	/** Underline text */
	// 默认下划线开关，不代表每一类块都应用默认样式。
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
// 各语法的主题回调契约，返回带ANSI的文本或其他显示串；声明不执行函数、不保证任意嵌套样式完全可恢复。
export interface MarkdownTheme {
	// 标题颜色/外观，一级标题外层还组合粗体/下划线。
	heading: (text: string) => string;
	// 链接文字样式。
	link: (text: string) => string;
	// 不支持超链接时，附在文字后面的括号URL样式。
	linkUrl: (text: string) => string;
	// 行内代码样式。
	code: (text: string) => string;
	// 没有highlightCode时的代码块逐行样式。
	codeBlock: (text: string) => string;
	// 显示代码围栏的样式。
	codeBlockBorder: (text: string) => string;
	// 引用正文样式，通常再组合斜体。
	quote: (text: string) => string;
	// 引用左侧竖线前缀样式。
	quoteBorder: (text: string) => string;
	// 水平分割线样式。
	hr: (text: string) => string;
	// 列表项目符号/任务标记样式。
	listBullet: (text: string) => string;
	// 粗体文字包装函数。
	bold: (text: string) => string;
	// 斜体包装函数。
	italic: (text: string) => string;
	// 删除线包装函数。
	strikethrough: (text: string) => string;
	// 下划线包装函数。
	underline: (text: string) => string;
	/** Highlighted lines of a code block. A Markdown component reuses the result for the same code until invalidate(). */
	// 可选同步代码高亮，输入正文/可缺语言，返回行数组；在弱块缓存仍存活时可跨resize复用，invalidate或GC后可能重做，不是永久只调用一次。
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	// 每条代码内容行在进入后续换行前加的缩进文本，缺省两个空格。
	codeBlockIndent?: string;
}

// 渲染策略接口，constructor会浅复制选项；不对数值/回调返回作统一运行时校验。
export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	// 保留源码列表标记的开关；当前实现也影响无序列表，名称虽有Ordered并非只管有序。
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	// 保留转义标点的原始反斜杠，默认用Marked解出的文本。
	preserveBackslashEscapes?: boolean;
	/** Transform source Markdown before parsing, with the exact width available for content. */
	// 渲染cache未命中时同步转换源码，收到扣横边距后的内容宽度；外部状态变化应invalidate，不因回调存在就每次必执行。
	transform?: (markdown: string, availableWidth: number) => string;
	/** Render supported LaTeX math expressions as Unicode text (default: true). */
	// 只有显式false禁用已识别数学的Unicode转换，数学token仍会保留raw供显示。
	renderLatex?: boolean;
}

// 行内渲染的外层样式上下文，不是通用ANSI栈；用正文函数和其开启前缀在局部关闭后补回。
interface InlineStyleContext {
	// 对普通文字应用外层样式的函数，引用路径可传恒等函数。
	applyText: (text: string) => string;
	// 从包装回调哨兵前提取的开启串，可能为空，不包括关闭串。
	stylePrefix: string;
}

/** A top-level block of the last render, keyed by its source, reused by the next render. */
// 一个顶层块的可复用渲染记录，按token.raw键控；相同raw不代表引用定义/后继间距都一样，因此还有额外失效条件。
interface RenderedBlock {
	/** Width and type of the following block (which decides the spacing) that the lines were rendered for. */
	// 渲染时的总组件宽度，初建-1强制首次绘制。
	width: number;
	// 后一token种类会改变块后空行，需参与块失效判断。
	nextTokenType: string | undefined;
	// 完整补边距/折行/填充后的块行数组，返回时复用其中字符串。
	lines: string[];
	/** Highlighted lines of the block's code, keyed by language and source; they survive a resize or new spacing. */
	// 代码高亮按语言+NUL+正文键控，可保留到宽度/间距变化时重排；Map不冻结回调返回行。
	highlightedCode: Map<string, string[]>;
}

// 有状态Markdown组件，render修改缓存并调用主题/转换回调，但不直接输出终端；例：AssistantMessage反复setText实现流式显示。
// 解析token和顶层块用WeakRef，不保证下一次render还在；整帧行缓存则强引用保留，外部需把返回数组当只读用。
export class Markdown implements Component {
	// 原始Markdown文本，不是transform后的源码。
	private text: string;
	// 左右各自的内边距列数，构造原样保存。
	private paddingX: number; // Left/right padding
	// 上下各自的空行数，构造不另作整数/非负验证。
	private paddingY: number; // Top/bottom padding
	// 可选默认正文样式对象原引用，可能被调用方更新。
	private defaultTextStyle?: DefaultTextStyle;
	// 主题对象原引用，内容改变应调用invalidate清样式结果。
	private theme: MarkdownTheme;
	// 浅复制后的策略对象，回调引用仍共享。
	private options: MarkdownOptions;
	// 默认样式开启前缀缓存，undefined未计算，空串表示算出无前缀。
	private defaultStylePrefix?: string;

	// Cache for rendered output
	// 整帧缓存对应的原text值。
	private cachedText?: string;
	// 整帧缓存对应总宽度。
	private cachedWidth?: number;
	// 可直接复用的行数组引用，包括空数组；调用方修改它会影响后续命中。
	private cachedLines?: string[];
	// Parsed tokens depend only on the source, so they survive theme and width invalidation. Held weakly: a token tree is
	// about ten times the size of its source, and every message of a long transcript keeps a Markdown component. The
	// tokens survive a burst of re-renders, such as a theme preview, and are collected afterwards.
	// WeakRef只弱持有{source,tokens}对象；GC可释放它，deref可能undefined，英文的容量比例/生命周期只是动机不是精确保证。
	private cachedTokens?: WeakRef<{ source: string; tokens: TokensList }>;
	// The last render's top-level blocks. While a message streams only its last block changes, so a render styles and
	// wraps only that block. Each render keeps only the blocks it used, which drops a streamed block's earlier versions.
	// Held weakly like the tokens: the blocks repeat the source in their keys and the code in their highlighting, and
	// only a burst of renders, such as streaming or a resize, needs them.
	// 只弱持有最近一次用到的块Map；旧流式版本不继续加入新Map，GC时间由运行时决定，并非setText就立刻释放。
	private blocks?: WeakRef<Map<string, RenderedBlock>>;
	// Highlighted code of the block being rendered, only set while renderBlock runs.
	// renderBlock临时指向当前块高亮缓存；正常结束清空，若渲染回调抛错没有finally清字段，不能承诺异常时也立刻清理。
	private blockHighlightedCode?: Map<string, string[]>;

	// 构造保存文本/边距/主题/可选样式与策略，无渲染/I/O；例：new Markdown("**hi**",0,0,theme)等宿主render时才分词和着色。
	constructor(
		// 原始源码。
		text: string,
		// 左右每侧边距列数。
		paddingX: number,
		// 上下每侧空行数。
		paddingY: number,
		// 语法主题函数集合。
		theme: MarkdownTheme,
		// 可缺正文基础样式。
		defaultTextStyle?: DefaultTextStyle,
		// 可缺渲染策略，如transform、保留转义或禁数学。
		options?: MarkdownOptions,
	) {
		// 直接保存文本值。
		this.text = text;
		// 保存横向边距，不在这里规范数值。
		this.paddingX = paddingX;
		// 保存纵向边距。
		this.paddingY = paddingY;
		// 保存主题原对象，不复制每个回调。
		this.theme = theme;
		// 保存默认样式原对象引用。
		this.defaultTextStyle = defaultTextStyle;
		// 有options时用...浅复制容器，否则新建空对象；回调函数/内部引用仍是同一对象。
		this.options = options ? { ...options } : {};
	}

	// 更新原始源码并清整帧缓存，返回void，不立即render；例：流式追加文字后让下次重绘重算，弱token/块缓存仍可在同源部分命中。
	setText(text: string): void {
		// 即使与旧值相同也执行赋值。
		this.text = text;
		// 只清三项整帧结果，不清弱缓存或默认样式前缀。
		this.clearRenderCache();
	}

	// 主题等外观变化时清整帧/块/默认前缀，返回void；例：主题对象被改后调用，分词仅依赖源码因此仍保留弱token缓存。
	invalidate(): void {
		// 清直接返回的整帧缓存。
		this.clearRenderCache();
		// The theme may have changed, which changes every styled line and the default style's prefix.
		// 不再从旧块复用着色/高亮结果，原Map何时被GC不由此保证。
		this.blocks = undefined;
		// 下次需要时重新通过样式回调提取前缀。
		this.defaultStylePrefix = undefined;
	}

	// 内部清整帧缓存，无参数/返回值；不清正文或分词，例：setText与invalidate复用这一步。
	private clearRenderCache(): void {
		// 原text缓存标记设为未缓存。
		this.cachedText = undefined;
		// 宽度缓存标记清空。
		this.cachedWidth = undefined;
		// 释放本字段对旧行数组的引用，外部仍可持有旧结果。
		this.cachedLines = undefined;
	}

	// 按总列宽生成终端行，先查整帧缓存，再transform/分词/逐块渲染/上下补白并缓存返回；不改原text或写终端。
	// 例：同源码同宽再次render直接返回同数组，变宽可复用仍活着的token/代码高亮。回调/分词/重复字符串等错误未统一捕获，极窄宽字不能保证每行都严格不超宽。
	render(width: number): string[] {
		// Check cache
		// 缓存行存在且原text、总宽度都相等则复用；[]也是真值，transform不会再执行。
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			// 返回原数组引用，不创建防修改副本。
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		// 扣左右边距后至少给内容1列；这不是对总宽/边距任意非法数值的全面校验。
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		// 有transform才同步执行，??仅对null/undefined回退原文，显式返回空串可隐藏内容。
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		// Don't render anything if there's no actual text
		// 转换后为空或全空白，就没有任何可绘正文。
		if (!text || text.trim() === "") {
			// 放弃旧块引用，这条路径不再绘边距/背景空行。
			this.blocks = undefined;
			// 准备零行数组而非一行空串。
			const result: string[] = [];
			// Update cache
			// 整帧cache键仍用原this.text，不是transform结果。
			this.cachedText = this.text;
			// 保存当前总宽度。
			this.cachedWidth = width;
			// 缓存同一个空数组。
			this.cachedLines = result;
			// 提前返回[]，不会走末尾至少一行的兜底。
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		// 全部tab替成3空格，与项目列宽规则一致；对整个转换源码做替换，不只普通正文。
		const normalizedText = text.replace(/\t/g, "   ");

		// Parse markdown to HTML-like tokens
		// deref尝试取得弱缓存，没有/已被GC就undefined。
		const cached = this.cachedTokens?.deref();
		// 只有规范化后的源码相同才复用token树；宽度/主题本身不参与分词键。
		let tokens = cached?.source === normalizedText ? cached.tokens : undefined;
		// 弱缓存没活着或源码变动时重新词法分析。
		if (!tokens) {
			// 调用lexer生成token数组和links定义表，不生成HTML或请求链接目标。
			tokens = markdownParser.lexer(normalizedText);
			// 原地修掉末尾流式半截闭围栏的代码text，减少高度抖动。
			trimPartialClosingFences(tokens);
			// 用新WeakRef包住源码/token树对象，不把它强存为永久会话记忆。
			this.cachedTokens = new WeakRef({ source: normalizedText, tokens });
		}

		// A reference link resolves through a definition anywhere in the text, so blocks with the same source can render
		// differently; such texts are rare in practice and render without reusing blocks.
		// 只要有引用式链接定义，整体禁块复用；相同raw可因定义地址变化显示不同，不能只按块源码命中。
		const reuseBlocks = Object.keys(tokens.links).length === 0;
		// 读取还存活的上一轮块Map，可能已被GC。
		const previousBlocks = this.blocks?.deref();
		// 本轮新建Map只保存确实使用的块，避免长期累计流式所有历史块版本。
		const blocks = new Map<string, RenderedBlock>();
		// 实例弱持本轮Map，render内部局部变量仍是强引用。
		this.blocks = new WeakRef(blocks);
		// 按顶层顺序汇总内容行。
		const contentLines: string[] = [];
		// 遍历词法器生成的每个顶层token。
		for (let i = 0; i < tokens.length; i++) {
			// 当前顶层块对象。
			const token = tokens[i];
			// 后一个块类型可能决定是否补空行；行尾没有则undefined。
			const nextTokenType = tokens[i + 1]?.type;
			// 允许复用时优先同一轮已遇到的相同raw，再查旧Map；??只在没找到时回退，不按token对象身份键控。
			const reused = reuseBlocks ? (blocks.get(token.raw) ?? previousBlocks?.get(token.raw)) : undefined;
			// 没缓存创建空记录，width=-1保证首次绘；高亮Map此时为空。
			const block = reused ?? { width: -1, nextTokenType, lines: [], highlightedCode: new Map() };
			// 宽度或后继类型变了要重排块行，即使代码高亮还能复用。
			if (block.width !== width || block.nextTokenType !== nextTokenType) {
				// 逐块渲染并更新记录，可能同步调用主题/高亮函数。
				this.renderBlock(block, token, nextTokenType, width, contentWidth);
			}
			// 仅在允许复用的文本里才把raw→块记录加入本轮Map。
			if (reuseBlocks) blocks.set(token.raw, block);
			// 取本块已经补好边距/填充的行。
			for (const line of block.lines) {
				// 顺序拼入内容结果，不为每行重新渲染相同块。
				contentLines.push(line);
			}
		}

		// Add top/bottom padding (empty lines)
		// 整行背景可缺，不与默认前景混为同一处理阶段。
		const bgFn = this.defaultTextStyle?.bgColor;
		// 构造总宽度的空白行，参数异常可由repeat抛错，未另捕获。
		const emptyLine = " ".repeat(width);
		// 保存上下共用的一组padding行。
		const emptyLines: string[] = [];
		// 按paddingY生成指定数量；类型只声明number，构造未取整。
		for (let i = 0; i < this.paddingY; i++) {
			// 有背景则给整条空白上背景，否则保留空白串。
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			// 加入一侧padding行组。
			emptyLines.push(line);
		}
		// 触发V8读取字符串使拼接树有机会压平，不改变行文字。
		flattenLines(emptyLines);

		// Combine top padding, content, and bottom padding
		// 上空白+内容+同一组下空白，concat新建结果数组，不修改contentLines。
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		// 保存原源码cache键。
		this.cachedText = this.text;
		// 保存总宽度cache键。
		this.cachedWidth = width;
		// 强持最终行数组，供相同输入直接返回。
		this.cachedLines = result;

		// 正常路径至少返回一行；若此处result为空，返回的新[""]与已缓存的空result不是同一数组，空白输入另在前面返回[]。
		return result.length > 0 ? result : [""];
	}

	/** Render one top-level block to output lines: wrapped, with margins, and padded or backgrounded to the width. */
	// 把一个顶层token变为完整块行并更新block记录，返回void；处理正文→换行→左右边距→背景/补空格，图片协议行整体保留。
	// 例：代码高亮Map临时交给renderToken复用，完成后记录宽度/后继类型。会调用外部样式函数，异常不捕获，临时字段清理没有finally。
	private renderBlock(
		// 要更新的可复用块记录，修改它的lines/width/nextTokenType。
		block: RenderedBlock,
		// 本次顶层token。
		token: Token,
		// 下一个顶层token类型，决定块后间距。
		nextTokenType: string | undefined,
		// 最终组件总宽度，补白按它算。
		width: number,
		// 扣横边距后的内容列预算。
		contentWidth: number,
		// 无返回结果，生成行写入传入block。
	): void {
		// 让深层代码渲染能找到当前块的高亮缓存。
		this.blockHighlightedCode = block.highlightedCode;
		// 左侧固定空格边距。
		const leftMargin = " ".repeat(this.paddingX);
		// 右侧固定空格边距。
		const rightMargin = " ".repeat(this.paddingX);
		// 取可选整行背景函数。
		const bgFn = this.defaultTextStyle?.bgColor;
		// 收集本块最终输出行。
		const lines: string[] = [];
		// 先按语法渲染得到未统一外层排版的行。
		for (const line of this.renderToken(token, contentWidth, nextTokenType)) {
			// 识别出的图片协议行不能按普通字串切开；只是检查协议前缀，不验证图像有效性。
			if (isImageLine(line)) {
				// 图片行原样传入，不添加普通边距或背景。
				lines.push(line);
				// 跳过它的文字换行处理。
				continue;
			}
			// 普通行交统一ANSI换行规则，保持完整字素与样式/链接。
			for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
				// 每条已换行结果加左右边距。
				const lineWithMargins = leftMargin + wrappedLine + rightMargin;
				// 配置默认背景时覆盖正文和其补白。
				if (bgFn) {
					// 函数内部只补缺少列，不裁掉过宽正文，回调结果原样使用。
					lines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
					// 无背景时直接用空格补满。
				} else {
					// No background - just pad to width
					// 按显示列宽计算剩余空间，控制码不算列。
					const paddingNeeded = Math.max(0, width - visibleWidth(lineWithMargins));
					// 不足才补空格，超宽时补0，不在此再截断。
					lines.push(lineWithMargins + " ".repeat(paddingNeeded));
				}
			}
		}
		// 正常完成后清临时高亮Map指针；抛错会跳过这一行。
		this.blockHighlightedCode = undefined;
		// 压平可能持有拼接树的缓存字符串，文字值不变。
		flattenLines(lines);
		// 更新块的完整行数组。
		block.lines = lines;
		// 记录这份行适用的总宽度。
		block.width = width;
		// 记录这份行适用的后继类型。
		block.nextTokenType = nextTokenType;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	// 给一段文字应用默认前景及装饰样式，返回新串，不改原文；按color→bold→italic→删除线→下划线执行，不在这里加背景。
	// 例：思考正文可默认灰色斜体；主题函数会被实际调用且可抛错，不保证任意包装函数都无副作用或保留宽度。
	private applyDefaultStyle(text: string): string {
		// 没默认样式对象就保留普通文字。
		if (!this.defaultTextStyle) {
			// 原样返回，不加控制码。
			return text;
		}

		// 从输入串开始逐层包装。
		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		// 存在默认前景回调才调用。
		if (this.defaultTextStyle.color) {
			// 将其返回结果交给下一层装饰，回调可抛错。
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		// 默认粗体开关为真时包装。
		if (this.defaultTextStyle.bold) {
			// 使用主题定义的粗体实现，不写死具体SGR。
			styled = this.theme.bold(styled);
		}
		// 默认斜体开启才包装。
		if (this.defaultTextStyle.italic) {
			// 将此前前景/粗体结果传入斜体函数。
			styled = this.theme.italic(styled);
		}
		// 删除线开启才处理。
		if (this.defaultTextStyle.strikethrough) {
			// 以删除线包装当前结果。
			styled = this.theme.strikethrough(styled);
		}
		// 默认下划线开启才处理。
		if (this.defaultTextStyle.underline) {
			// 最后加下划线包装，不加整行背景。
			styled = this.theme.underline(styled);
		}

		// 返回完成默认样式的字符串。
		return styled;
	}

	// 求并缓存默认样式的开启前缀，返回字符串，无参数；把NUL哨兵交同一套样式函数，再取哨兵前部分，例：灰色斜体可得其开启代码。
	// 会真实调用样式回调并修改defaultStylePrefix；假定包装保留哨兵，若被删除则空串，不是完整ANSI状态解析，也不提取关闭串。
	private getDefaultStylePrefix(): string {
		// 没默认样式就无需重开前缀。
		if (!this.defaultTextStyle) {
			// 直接空串，不必缓存一份。
			return "";
		}

		// undefined表示未算，缓存的空串也是有效结果。
		if (this.defaultStylePrefix !== undefined) {
			// 命中直接返回，外部改变样式应invalidate。
			return this.defaultStylePrefix;
		}

		// NUL作为定位哨兵，不是要输出给终端的正文。
		const sentinel = "\u0000";
		// 从哨兵文本开始按相同顺序包装。
		let styled = sentinel;

		// 有前景回调才处理哨兵。
		if (this.defaultTextStyle.color) {
			// 真正执行它得到“开启代码+哨兵+关闭代码”等形式。
			styled = this.defaultTextStyle.color(styled);
		}

		// 默认粗体也需反映到恢复前缀。
		if (this.defaultTextStyle.bold) {
			// 按主题粗体包当前哨兵串。
			styled = this.theme.bold(styled);
		}
		// 处理默认斜体。
		if (this.defaultTextStyle.italic) {
			// 调用斜体包装，保留哨兵供定位。
			styled = this.theme.italic(styled);
		}
		// 处理默认删除线。
		if (this.defaultTextStyle.strikethrough) {
			// 加入主题删除线。
			styled = this.theme.strikethrough(styled);
		}
		// 处理默认下划线。
		if (this.defaultTextStyle.underline) {
			// 加入主题下划线。
			styled = this.theme.underline(styled);
		}

		// 找包装结果中首次出现的原哨兵，不验证前面的字符串是否真的都是ANSI代码。
		const sentinelIndex = styled.indexOf(sentinel);
		// 哨兵还存在就取它之前内容，缺失则缓存空串。
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		// 返回可在局部样式结束后补回的前缀。
		return this.defaultStylePrefix;
	}

	// 从任意样式函数提取哨兵前的开启串，返回string；例：标题/引用各自获得恢复前缀，不缓存，也不改变输入函数。
	// styleFn会立即执行，可有自己的副作用/异常；若不保留NUL则得空串，不能保证支持所有样式包装方式。
	private getStylePrefix(styleFn: (text: string) => string): string {
		// 新建本次定位用的哨兵。
		const sentinel = "\u0000";
		// 实际调用传入的样式函数，不是只读取函数名/签名。
		const styled = styleFn(sentinel);
		// 定位哨兵在包装结果的位置。
		const sentinelIndex = styled.indexOf(sentinel);
		// 取其前缀，或在哨兵丢失时返回空串。
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	// 构造默认行内上下文，返回两个字段；applyText保存闭包，stylePrefix立即求默认前缀，例：普通段落在行内代码后可恢复灰色斜体。
	private getDefaultInlineStyleContext(): InlineStyleContext {
		// 每次创建新上下文对象，不把它当全局样式栈。
		return {
			// 闭包等普通文字渲染时才调用applyDefaultStyle，此处只是创建函数引用。
			applyText: (text: string) => this.applyDefaultStyle(text),
			// 恢复前缀此时读取/可能计算，和上面的延迟闭包执行时机不同。
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	// 将一个块token渲染成未统一加外边距的行，返回string[]；按type处理标题/段落/代码/列表/表格/引用/数学等，可递归调用自身。
	// 例：引用会减少2列并给每行加竖线，代码块可执行主题高亮；不写终端，不请求URL，回调错误传播，未知token通常退成文字。
	private renderToken(
		// Marked或自定义词法token，Generic扩展使部分字段需按约定断言。
		token: Token,
		// 当前块内部可用列数，不是整个终端像素宽度。
		width: number,
		// 可选下一块类型，控制是否额外补空行。
		nextTokenType?: string,
		// 可选外层文字样式，标题/引用会建立专门上下文。
		styleContext?: InlineStyleContext,
		// 返回行数组，长行还会在外层renderBlock统一换行。
	): string[] {
		// 本次块的局部输出缓冲。
		const lines: string[] = [];

		// 按type分派；case中的break只结束switch，不提前结束整个方法。
		switch (token.type) {
			// 标题块分支。
			case "heading": {
				// 取Marked给出的标题级别。
				const headingLevel = token.depth;
				// 准备原级别数量的#与空格，仅3级及以下实际显示它。
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				// 声明稍后按级别选出的标题包装函数。
				let headingStyleFn: (text: string) => string;
				// 一级标题增加下划线以强化层次。
				if (headingLevel === 1) {
					// 创建回调：调用时先下划线、再粗体、最后标题主题，当前行只是保存函数。
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
					// 其他标题不增加这个一级专用下划线。
				} else {
					// 它们使用粗体+标题主题。
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				// 建立标题专用的普通文字/恢复前缀上下文。
				const headingStyleContext: InlineStyleContext = {
					// 普通文字按标题函数着色，避免掉回默认正文样式。
					applyText: headingStyleFn,
					// 立刻用哨兵调用标题函数提取开启前缀。
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				// 递归渲染标题内部代码/强调等，使用标题上下文恢复外观。
				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				// 3级及更深在文字前显示着色#前缀，1/2级只显示标题内容。
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				// 加入标题结果。
				lines.push(styledHeading);
				// 后面确有块且不是显式space时，才补一条间距行。
				if (nextTokenType && nextTokenType !== "space") {
					// 补空串表示空行，不在文档末尾强行添空行。
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			// 普通段落分支。
			case "paragraph": {
				// 按传入或默认上下文处理行内token，缺数组按[]。
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				// 段落可能含LF，后续统一换行仍会拆它。
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				// 后继是列表/space时不额外添行，避免双重间距。
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					// 其他后继块前补空行。
					lines.push("");
				}
				break;
			}

			// 某些块级text包含行内子token，也走行内渲染。
			case "text":
				// 临时单元素数组复用行内处理流程。
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			// 自定义块数学分支。
			case "latexBlock": {
				// as只断言类型，实际对象由前面latexBlock tokenizer构造，并不在此再次运行时校验。
				const latexToken = token as LatexToken;
				// 准备数学转换结果，可能没有。
				let rendered =
					// 只有闭合且未显式禁数学时才尝试转换。
					!latexToken.pending && this.options.renderLatex !== false
						? // display:true启用二维分数/上下限等布局。
							renderLatex(latexToken.text, { display: true })
						: // pending或禁用时用undefined触发原文回退。
							undefined;
				// A 2D layout cannot be wrapped row by row; fall back to the raw source when it does not fit.
				// 不支持或任一二维行超宽，就不用逐行折断二维布局，改显示原始数学源码。
				if (rendered === undefined || rendered.split("\n").some((line) => visibleWidth(line) > width)) {
					// raw去首尾空白，保留其分隔符；之后仍会被外层普通换行处理。
					rendered = latexToken.raw.trim();
				}
				// 按LF逐行放数学结果或回退源码。
				for (const line of rendered.split("\n")) {
					// 每行应用默认前景/装饰，不沿用styleContext中的所有引用/标题约定。
					lines.push(this.applyDefaultStyle(line));
				}
				// 非末块且没有space接手间距时补空行。
				if (nextTokenType && nextTokenType !== "space") {
					// 用一个空串分隔下一块。
					lines.push("");
				}
				break;
			}

			// 代码块分支，不执行代码内容。
			case "code": {
				// 主题未配缩进时默认两个空格，空串可显式去缩进。
				const indent = this.theme.codeBlockIndent ?? "  ";
				// 显示规范化三反引号与语言标签的边界，不复刻源码原围栏符号/长度。
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				// 有可选高亮回调时优先于普通逐行codeBlock样式。
				if (this.theme.highlightCode) {
					// 语言和代码正文用NUL分隔作为块内缓存键，避免简单直接相接歧义。
					const key = `${token.lang ?? ""}\0${token.text}`;
					// 从本次顶层块的高亮Map取已保存行；递归代码块也共享该顶层记录。
					let highlighted = this.blockHighlightedCode?.get(key);
					// 没有高亮结果才调用外部函数，[]是真值也可作为缓存结果。
					if (!highlighted) {
						// 同步执行高亮并取得行数组，异常不在此捕获，类型不校验每行内容。
						highlighted = this.theme.highlightCode(token.text, token.lang);
						// 当前有块高亮缓存才保存，直接调用renderToken的其他上下文可无此Map。
						this.blockHighlightedCode?.set(key, highlighted);
					}
					// 逐条取高亮后的字符串，原数组不在这里改写。
					for (const hlLine of highlighted) {
						// 在每条高亮源行前加缩进，之后外层仍可能再折行。
						lines.push(`${indent}${hlLine}`);
					}
					// 没提供高亮函数时用普通代码块主题。
				} else {
					// Split code by newlines and style each line
					// 把代码正文按LF拆行，保留中间空行。
					const codeLines = token.text.split("\n");
					// 逐条处理代码源行。
					for (const codeLine of codeLines) {
						// 先给这一行加代码样式，再前置缩进。
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				// 输出统一三反引号闭围栏，不执行/求值任何代码。
				lines.push(this.theme.codeBlockBorder("```"));
				// 有下块且不是space才增加间距。
				if (nextTokenType && nextTokenType !== "space") {
					// 添加一条空行。
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			// 列表分支，实际缩进/项目符号在专门方法处理。
			case "list": {
				// 断言为List传入，深度从0开始，保留可用宽度和外层样式。
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				// 展开数组把所有列表行按顺序追加，不把数组当单行。
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			// 表格分支。
			case "table": {
				// 把列宽分配、单元换行和边框交renderTable。
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				// 按原行顺序并入输出。
				lines.push(...tableLines);
				break;
			}

			// 引用块可包含列表/表格/代码等块结构，不能只当行内文本。
			case "blockquote": {
				// 创建引用包装回调，执行时先斜体再引用主题，不立即绘制。
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				// 通过哨兵得到其开启前缀，可能为空。
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				// 逐行应用引用样式的闭包，返回string不改输入；遇SGR0先补引用前缀再整体包装，减少内部重置丢样式。
				const applyQuoteStyle = (line: string): string => {
					// 没有可提取前缀就只能直接包装。
					if (!quoteStylePrefix) {
						// 执行引用样式函数，不尝试改内部控制码。
						return quoteStyle(line);
					}
					// 只替换完整SGR0，不识别所有局部关闭码或任意ANSI嵌套栈。
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					// 再包整行引用主题，返回最终styledLine。
					return quoteStyle(lineWithReappliedStyle);
				};

				// With no room for another border ("│ " plus at least one content column), render the
				// nested content without one. Otherwise each extra level re-wraps every child line at
				// width 1 and the output grows exponentially with nesting depth.
				// 不足3列容不下“竖线+空格+至少一内容列”，停止继续叠边框，防止深引用不断在1列上重折行导致爆炸。
				if (width < 3) {
					// 取嵌套块token，缺省空数组。
					const quoteTokens = token.tokens || [];
					// 逐个渲染子块仍保留其前后间距关系。
					for (let i = 0; i < quoteTokens.length; i++) {
						// 使用原有宽度/外层styleContext递归，不再套本层引用边框/引用样式上下文。
						for (const line of this.renderToken(quoteTokens[i], width, quoteTokens[i + 1]?.type, styleContext)) {
							// 直接并入子内容行。
							lines.push(line);
						}
					}
					// 结束引用分支，不继续下面的加边框步骤。
					break;
				}

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				// 普通宽度扣掉“│ ”两列给引用正文。
				const quoteContentWidth = width - 2;

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				// 构造引用行内上下文，默认消息前景/装饰不自动加到引用普通文字上。
				const quoteInlineStyleContext: InlineStyleContext = {
					// 恒等回调让内部普通文字先原样返回，引用整体样式稍后逐行加。
					applyText: (text: string) => text,
					// 局部行内样式结束后用引用开启串恢复，而非默认正文前缀。
					stylePrefix: quoteStylePrefix,
				};
				// 引用中的块级子token列表。
				const quoteTokens = token.tokens || [];
				// 先收集未加本层引用边框的行。
				const renderedQuoteLines: string[] = [];
				// 依次处理每个引用子块。
				for (let i = 0; i < quoteTokens.length; i++) {
					// 当前子块。
					const quoteToken = quoteTokens[i];
					// 后继子块供间距判断，最后项可能undefined。
					const nextQuoteToken = quoteTokens[i + 1];
					// 递归处理子块，再遍历其输出行。
					for (const line of this.renderToken(
						// 传当前子token。
						quoteToken,
						// 传扣本层边框之后的预算。
						quoteContentWidth,
						// 下一块类型通过可选链取得。
						nextQuoteToken?.type,
						// 传引用专用的行内样式上下文。
						quoteInlineStyleContext,
					)) {
						// 暂收子块行，后面统一着引用样式/换行。
						renderedQuoteLines.push(line);
					}
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				// 去掉子块尾部空行，避免外层引用间距再补一遍。
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					// 只移除当前结果最后的空串，不裁掉正文内部空行。
					renderedQuoteLines.pop();
				}

				// 对每条剩余引用内容行做本层样式和列折行。
				for (const quoteLine of renderedQuoteLines) {
					// 实际执行引用闭包并修补SGR0后的开启串。
					const styledLine = applyQuoteStyle(quoteLine);
					// 按引用正文预算进行ANSI换行。
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					// 一条源行可能变成多条实际内容行。
					for (const wrappedLine of wrappedLines) {
						// 每条换行内容左侧都加着色“│ ”，再交上层继续排版。
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				// 后面还有非space块才补引用后空行。
				if (nextTokenType && nextTokenType !== "space") {
					// 添加一次间距行。
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			// Markdown水平分割线分支。
			case "hr":
				// 画不超过80列/当前宽度的横线并加主题，未对任意负宽度额外校验。
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				// 后续非space块前补间距。
				if (nextTokenType && nextTokenType !== "space") {
					// 加入空串。
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			// HTML块只作为文字显示，不创建DOM/执行脚本。
			case "html":
				// Render HTML as plain text (escaped for terminal)
				// 保留原实现对raw字段存在及类型的判断，Generic扩展token可带其他字段；不是完整HTML/终端安全过滤。
				if ("raw" in token && typeof token.raw === "string") {
					// 只trim原raw并加默认样式，没有把其ANSI/控制符统一转义，不能把英文escaped理解为消毒保证。
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			// space表示Markdown空行。
			case "space":
				// Space tokens represent blank lines in markdown
				// 用一个空串表示该行。
				lines.push("");
				break;

			// 其他未专门支持的块类型走文本回退。
			default:
				// Handle any other token types as plain text
				// 有字符串text才可显示，未实现该类型自己的特殊行为。
				if ("text" in token && typeof token.text === "string") {
					// 块默认分支直接放text、不加默认样式；例如未知扩展退成文字，Markdown图片也不会因此读取/下载href。
					lines.push(token.text);
				}
		}

		// 返回该块的行，不写终端。
		return lines;
	}

	// 递归拼接行内token为一个可含LF的样式字符串，返回新串，不改tokens；显式上下文优先，代码/强调/链接后补外层前缀。
	// 例：标题内代码结束后可恢复标题颜色；不是完整嵌套ANSI栈，主题/能力查询可能有副作用/异常，链接仅编码或展示地址，不访问URL。
	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		// 局部结果从空串开始。
		let result = "";
		// 只在未传上下文时构建默认正文上下文，??不把已有对象当空。
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		// 解构普通文字样式函数和用于恢复的开启串。
		const { applyText, stylePrefix } = resolvedStyleContext;
		// 对带LF文字逐行应用外层函数，再连接回LF，返回string；例：默认颜色闭合不会跨越普通逻辑行，仅修改局部结果。
		const applyTextWithNewlines = (text: string): string => {
			// 拆成数组保留换行边界。
			const segments: string[] = text.split("\n");
			// map同步调用applyText处理每段，然后以LF拼回，回调异常直接传播。
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		// 逐个拼接，保持行内语法原顺序。
		for (const token of tokens) {
			// 按token.type选择支持的行内语法。
			switch (token.type) {
				// 自定义行内数学分支。
				case "latex": {
					// 断言为本模块构造的LatexToken，as不检查运行时字段。
					const latexToken = token as LatexToken;
					// 准备显示公式或raw源码。
					const rendered =
						// 未pending且未禁数学时才尝试转换。
						!latexToken.pending && this.options.renderLatex !== false
							? // renderLatex不支持时??回到raw，空字符串仍可作为有效转换结果。
								(renderLatex(latexToken.text) ?? latexToken.raw)
							: // pending或禁用时始终保留原分隔符和正文。
								latexToken.raw;
					// 按外层样式逐行处理后拼入输出。
					result += applyTextWithNewlines(rendered);
					break;
				}

				// 转义标点token分支。
				case "escape":
					// 按选项选原始raw（含反斜杠）或Marked解出的text，再加外层样式。
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
					break;

				// 普通text可能还包含嵌套行内token，例如列表项内部。
				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					// 有非空子token则继续递归，而非同时显示text导致重复。
					if (token.tokens && token.tokens.length > 0) {
						// 沿用同一外层上下文。
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
						// 没有子token就直接处理文本。
					} else {
						// 普通文字分行应用外层样式。
						result += applyTextWithNewlines(token.text);
					}
					break;

				// 行内路径遇paragraph也展开其子token。
				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					// 缺子数组按空数组，不在这里额外补段落空行。
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				// 粗体分支。
				case "strong": {
					// 先递归内部语法，仍使用同一外层样式上下文。
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					// 执行主题粗体包装后补外层开启串；不把当前粗体加入新的完整嵌套样式栈。
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				// 斜体分支。
				case "em": {
					// 先递归处理内部行内内容。
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					// 斜体包装结束后补外层前缀，减少后续正文变默认色。
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				// 行内代码不继续递归Markdown语法。
				case "codespan":
					// 给原text加代码主题，再恢复外层开启串。
					result += this.theme.code(token.text) + stylePrefix;
					break;

				// 链接分支，可递归显示标签内的强调等内容。
				case "link": {
					// 标签内部沿同样外层上下文渲染。
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					// 给标签加下划线再加链接主题。
					const styledLink = this.theme.link(this.theme.underline(linkText));
					// 查当前共享超链接能力；冷缓存可能探测环境，显式能力可由上层设置。
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						// 支持时用OSC8包标签，地址不另以括号显示；返回控制串不打开网址，再补外层样式前缀。
						result += hyperlink(styledLink, token.href) + stylePrefix;
						// 不支持OSC8时用可读文字地址回退。
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						// 仅为比较去掉mailto:，实际href仍保持原值。
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						// 标签raw文本本就等于地址或去mailto后的地址，就无需重复印地址。
						if (token.text === token.href || token.text === hrefForComparison) {
							// 只加链接样式标签及外层恢复前缀。
							result += styledLink + stylePrefix;
							// 标签与地址不同才额外展示括号URL。
						} else {
							// 地址用linkUrl主题，不使用styled标签作相等比较，最后补外层开启串。
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				// 显式行内换行token。
				case "br":
					// 追加真实LF，后面统一拆逻辑行。
					result += "\n";
					break;

				// 删除线分支，语法已由严格tokenizer决定。
				case "del": {
					// 递归内部内容，保留可嵌套语法。
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					// 加主题删除线，再恢复外层前缀。
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				// 行内HTML标签也当文字。
				case "html":
					// Render inline HTML as plain text
					// 保留原raw字符串检查，不在这里做HTML执行或控制字符清洗。
					if ("raw" in token && typeof token.raw === "string") {
						// 原标签raw不trim，逐LF加外层样式后拼入。
						result += applyTextWithNewlines(token.raw);
					}
					break;

				// 未知行内类型走text回退。
				default:
					// Handle any other inline token types as plain text
					// 只有有字符串text时才输出，其他未知字段忽略。
					if ("text" in token && typeof token.text === "string") {
						// 逐行应用外层样式；图片token通常显示替代text，不加载图片href。
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		// 结果末尾可能只剩为后续文字准备的恢复前缀，连续重复则全部剥掉，避免装饰延伸到补白。
		while (stylePrefix && result.endsWith(stylePrefix)) {
			// 每轮去掉一个完整前缀文本长度；只检查字面后缀，不解析其ANSI意义。
			result = result.slice(0, -stylePrefix.length);
		}

		// 返回最终行内字符串，不自动关闭所有原输入样式/链接。
		return result;
	}

	// 从有序项raw取原编号/右括号形式，返回带一个空格的marker或undefined，无修改；例：4)保留为4)而非自动改编号。
	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		// 最多3空格缩进、1..9位数字、.或)、后接空白才识别。
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		// 有捕获则加一个规范空格，失败交调用方回退自动编号。
		return match ? `${match[1]} ` : undefined;
	}

	// 取无序项raw的原-/+/*标记，返回带空格文本或undefined，无修改；例：保留+项目符号，也接受空项目末尾换行/结束。
	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		// 最多3空格缩进，符号后需空白或行尾，避免把正文里的减号当项目标记。
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		// 有匹配返回原符号加空格，否则undefined。
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	// 递归渲染列表为终端行，输入List、嵌套深度、总预算与可选外层样式，返回新数组；每层缩进4空格、项目首行用符号、续行用等宽空白。
	// 例：10.项目换行后续行对齐正文，任务项显示[x]/[ ]；会调用主题/递归渲染，选项保留原标记时也处理无序符号，不执行列表内容或修改token。
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		// 保存当前列表的输出行。
		const lines: string[] = [];
		// 每层增加4个ASCII空格，depth由内部递归维护。
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		// Marked的start是number或空串，number用其起号，否则从1开始；不是所有列表都强制重编号为1。
		const startNumber = typeof token.start === "number" ? token.start : 1;

		// 按项目原顺序渲染。
		for (let i = 0; i < token.items.length; i++) {
			// 当前列表项，含块级子token。
			const item = token.items[i];
			// 记录是否最后项，用于loose列表项间隔。
			const isLastItem = i === token.items.length - 1;
			// 先看有序/无序选择符号策略，下面是嵌套三元的续行。
			const bullet = token.ordered
				? // 有序且要求保留原源码编号时尝试提取。
					this.options.preserveOrderedListMarkers
					? // 能提取则用原标记，失败回退startNumber+i加点和空格。
						(this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: // 默认按起号加当前索引生成连续编号。
						`${startNumber + i}. `
				: // 无序项也复用同一个保留标记开关。
					this.options.preserveOrderedListMarkers
					? // 尽量保留原+/*/-，提取失败退为-。
						(this.getUnorderedListMarker(item) ?? "- ")
					: // 默认无序符号统一成-加空格。
						"- ";
			// 任务列表才追加方括号x/空格标记，不是交互复选框状态处理。
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			// 最终项标记=普通项目符号+可选任务框。
			const marker = bullet + taskMarker;
			// 项目首行前缀含深度缩进与主题着色后的符号。
			const firstPrefix = indent + this.theme.listBullet(marker);
			// 续行仅用等标记列宽的空格，保持正文对齐；不把ANSI码元长度当列数。
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			// 扣首行前缀后至少留1内容列，极窄时并不保证总行不超预算。
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			// 记录该项目是否已经输出任何行，决定首符号是否已使用。
			let renderedAnyLine = false;

			// 项目内还可能有段落、代码、引用和嵌套列表。
			for (const itemToken of item.tokens) {
				// 嵌套列表独立递归，不把父项符号重复加在它每行。
				if (itemToken.type === "list") {
					// depth+1增加层级，width仍传列表总预算，不用已减父符号的itemWidth。
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					// 已有子列表内容视作本项已经绘制。
					renderedAnyLine = true;
					// 这项子token已经处理，不再当普通段落放置。
					continue;
				}

				// 普通子块用itemWidth渲染，nextTokenType传undefined不让子块自行加后继块间距。
				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				// 遍历子块输出的源行。
				for (const line of itemLines) {
					// 再按itemWidth统一换行，保证续行可以补项目对齐空白。
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						// 第一次实际输出用首符号，其后都用续行空白。
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						// 前缀与本条内容拼成完整列表行。
						lines.push(linePrefix + wrappedLine);
						// 标记符号已用，下一行不重复输出bullet。
						renderedAnyLine = true;
					}
				}
			}

			// 完全没有渲染内容的空项目仍需显示符号。
			if (!renderedAnyLine) {
				// 只输出首行前缀，让空项目可见。
				lines.push(firstPrefix);
			}

			// loose列表在非最后项之后额外加空行。
			if (token.loose && !isLastItem) {
				// 空串表示项间空白，不在列表末尾强加一行。
				lines.push("");
			}
		}

		// 返回本层及嵌套列表的全部输出。
		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	// 按空白拆“词”，求最大显示列宽，按可选maxWidth封顶返回数字，无修改；例：表格用最多30列的最长词估算初始列下限，不是真正语言分词。
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		// split后filter去空片段，中文无空白长串会被视作一个词，ANSI载荷也没有在这里先单独剥开再分词。
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		// 没有词时最长宽度为0。
		let longest = 0;
		// 遍历每个非空白片段。
		for (const word of words) {
			// visibleWidth跳受支持控制码并估算列宽，与当前最大值比较。
			longest = Math.max(longest, visibleWidth(word));
		}
		// 没给上限则返回完整最长值。
		if (maxWidth === undefined) {
			// 直接返回累计结果。
			return longest;
		}
		// 给了上限只截数值，不截原字符串或保证该长词不再换行。
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	// 把一格文字按列换行并在每片段后补必要关闭/外层恢复串，返回行数组，不改输入；例：长链接在窄表格里不会把粗体/前景延到边框。
	// 非末片段关闭若干文字属性与前景，未关闭背景；末片段仰赖原渲染文字自己的收尾，最后都追加可选stylePrefix，不是全面任意嵌套样式修复。
	private wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
		// 至少按1列调用统一ANSI换行器，单个宽字大于列宽时仍完整保留。
		const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
		// map为每条片段生成新字符串，index用于判断末片段。
		return lines.map((line, index) => {
			// Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
			// 除最后片段外发22/23/24/25/27/28/29/39关闭文字属性与前景，特意不含49背景重置。
			const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
			// 正文→局部关闭→外层恢复，下一步才能在正确样式下补白/画边框。
			return `${line}${styleReset}${stylePrefix}`;
		});
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	// 将GFM表格排成字符边框，输入token、总列预算、可选后继类型/外层样式，返回行数组；测自然宽/最长词、分配列宽、单元换行再补白拼行。
	// 例：窄列的长词换成多行，连每列至少1列都放不下则回原Markdown。当前不读取token.align，单元文字均向右补空白，不能承诺Markdown左右居中对齐已实现。
	// 会多次调用行内主题函数；自身只返回行，链接能力查询可能探测本机环境，回调也可有副作用。列宽是布局目标，极窄宽字/异常样式/某些宽度组合不保证严格上限。
	private renderTable(
		// Marked已解析的表头与数据行，按其token结构约定使用。
		token: Tokens.Table,
		// 这张表可用列数，通常已扣组件横边距。
		availableWidth: number,
		// 下一块类型，决定表后是否添加间距。
		nextTokenType?: string,
		// 可选引用等外层上下文，单元局部样式结束后恢复它。
		styleContext?: InlineStyleContext,
		// 结果包含边框行和按最高单元格展开的内容行。
	): string[] {
		// 累积表格输出。
		const lines: string[] = [];
		// 表头格数定义本表列数。
		const numCols = token.header.length;

		// 零列无法画稳定边框。
		if (numCols === 0) {
			// 返回空行数组，不制造一列表。
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		// n列固定边框/空格开销为3n+1：两侧与列间“竖线+空格”。
		const borderOverhead = 3 * numCols + 1;
		// 扣边框后才是各列正文可分的预算。
		const availableForCells = availableWidth - borderOverhead;
		// 连每列1列都不够，放弃字符表格形式。
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			// 有raw则按普通ANSI换行显示原Markdown，没raw为空列表，不生成部分破碎边框。
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			// 后面还有非space块时加一个分隔空行。
			if (nextTokenType && nextTokenType !== "space") {
				// 补一次间距。
				fallbackLines.push("");
			}
			// 提前返回回退文本，后面不分配列宽。
			return fallbackLines;
		}

		// 最长“不换词”宽度偏好最多30列，长于它仍可按字素折开，不是丢掉内容。
		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		// 各列完整单元文本自然宽度的最大值。
		const naturalWidths: number[] = [];
		// 各列最长词估出的偏好下限，后面不够总预算时还会降级。
		const minWordWidths: number[] = [];
		// 先按表头初始化每列。
		for (let i = 0; i < numCols; i++) {
			// 将表头行内语法转换成样式文本，测量需要其实际显示形式。
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			// 保存该列初始自然宽度。
			naturalWidths[i] = visibleWidth(headerText);
			// 最长词封顶30且至少1列，以免空表头把下限降成0。
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		// 再用各数据行扩充列需求。
		for (const row of token.rows) {
			// 遍历该行已有单元格，依赖Marked正常生成与表头对应结构。
			for (let i = 0; i < row.length; i++) {
				// 渲染单元里的行内语法供测量，之后实际画格时还会渲染一次。
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				// 取同一列所有单元文本的最大自然列宽。
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				// 该列偏好下限也取更大值。
				minWordWidths[i] = Math.max(
					// 已有下限或至少1列。
					minWordWidths[i] || 1,
					// 和本单元的最长词偏好比较，上限仍30。
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		// 初始直接引用最长词下限数组；只有需要整体压缩时才换一份新数组。
		let minColumnWidths = minWordWidths;
		// reduce回调从0累加各列下限总和，不改变原数组。
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		// 偏好下限总和都放不下，要先降低各列底线，而非继续让表格无限超宽。
		if (minCellsWidth > availableForCells) {
			// 为每列保底1列，新数组不再与minWordWidths是同一引用。
			minColumnWidths = new Array(numCols).fill(1);
			// 先扣每列保底之后的可分余额。
			const remaining = availableForCells - numCols;

			// 还有余额才按原最长词需求加权分配。
			if (remaining > 0) {
				// 每列超出1的需求视作权重，用reduce求总需求，低于0按0。
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				// map计算每列能分到的额外整数列，不直接修改原下限。
				const growth = minWordWidths.map((width) => {
					// 当前列的额外需求。
					const weight = Math.max(0, width - 1);
					// 有总权重按比例向下取整，否则不增长。
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				// 将算出的增长量加回各列1列保底。
				for (let i = 0; i < numCols; i++) {
					// 缺增长项按0，??只对null/undefined回退。
					minColumnWidths[i] += growth[i] ?? 0;
				}

				// 求已分配的额外列总数。
				const allocated = growth.reduce((total, width) => total + width, 0);
				// 向下取整会留下少量未分配列。
				let leftover = remaining - allocated;
				// 从左到右每列补一个，直到余数用完；此处只跑一遍列索引。
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					// 当前下限加1。
					minColumnWidths[i]++;
					// 余额减1。
					leftover--;
				}
			}

			// 重算经过压缩后的下限总和。
			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		// 自然列总宽再加固定边框，判断是否需要在自然宽/下限之间分配。
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		// 声明最终列宽数组，由两分支赋值。
		let columnWidths: number[];

		// 自然总宽看起来能放下时，直接用自然需求与下限较大者。
		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			// 逐列至少满足其当前下限；不把表格强行扩到整个availableWidth。
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
			// 自然总宽超过预算，需要在下限上按比例分配增长。
		} else {
			// Need to shrink columns to fit
			// 计算所有列从当前底线增长到自然宽度的总潜力。
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				// 单列超出下限的正差额累加，负值按0。
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			// 扣下限后剩余可分列数，不低于0。
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			// map为每列求最终宽度。
			columnWidths = minColumnWidths.map((minWidth, index) => {
				// 当前列自然需求。
				const naturalWidth = naturalWidths[index];
				// 当前列从下限到自然需求可增长的部分。
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				// 没有总潜力时先保持0增长。
				let grow = 0;
				// 有潜力才作比例除法，避开除0。
				if (totalGrowPotential > 0) {
					// 按需求比例给整数增长，向下取整可能留余数。
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				// 下限加本列增长成为初始最终宽度。
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			// 求初次分配后的列宽总和。
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			// 扣出尚未分掉的正文列。
			let remaining = availableForCells - allocated;
			// 还有余额就逐列补，最多补到各自自然宽。
			while (remaining > 0) {
				// 记录本轮是否真有列能增长，防止所有列满足后死循环。
				let grew = false;
				// 从左向右且余额大于0时依次尝试。
				for (let i = 0; i < numCols && remaining > 0; i++) {
					// 只有未到自然宽的列还需要更多空间。
					if (columnWidths[i] < naturalWidths[i]) {
						// 给这列补一列。
						columnWidths[i]++;
						// 可分余额减少1。
						remaining--;
						// 标记本轮有进展。
						grew = true;
					}
				}
				// 所有列都不能长时，应结束即使还留余宽。
				if (!grew) {
					// 跳出余额分配循环，不无限扩表。
					break;
				}
			}
		}

		// Render top border
		// 每列先生成对应宽度横线片段。
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		// 把片段用上方交叉边框连接，再包左右上角。
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		// string[][]表示每个表头格各有多条换行片段，map回调负责渲染一格。
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			// 按行内上下文重新生成这格文本，主题函数可能再次执行。
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			// 按本列最终宽度折行，并将外层样式前缀传给单元收尾。
			return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
		});
		// 最高表头单元决定需要画几条物理表头行；...将各格高度作为Math.max参数。
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		// 逐条输出表头物理行。
		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			// 在同一高度收集每列的对应片段。
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				// 该格不够高则本行为空串，仍需补白保持边框对齐。
				const text = cellLines[lineIdx] || "";
				// 只补不足列，若宽字本身比列更宽则不切半个字。
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				// 整个表头格含补白统一加粗，具体SGR收尾由主题函数决定。
				return this.theme.bold(padded);
			});
			// 单元之间以空格竖线空格拼接，两侧也加边框。
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		// 生成每列分隔横线。
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		// 使用中间交叉符号组成一条分隔线，后续数据行之间也复用它。
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		// 先放表头与数据之间的分隔线。
		lines.push(separatorLine);

		// Render rows with wrapping
		// 依次输出数据行，每行可能展开为多条物理终端行。
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			// 当前数据行的格数组。
			const row = token.rows[rowIndex];
			// 将每格渲染成片段数组，不直接拼整行避免列宽丢失。
			const rowCellLines: string[][] = row.map((cell, i) => {
				// 渲染行内格式，沿用可选外层样式。
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				// 按这列宽度折行，并在片段后恢复外层前缀。
				return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
			});
			// 此数据行所有格的最大高度决定其物理行数。
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			// 从第一片段高度到最高格末尾逐条拼行。
			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				// 每列选当前高度的片段。
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					// 短格缺片段用空串。
					const text = cellLines[lineIdx] || "";
					// 文字右补空格使格宽一致，不读取token的left/center/right对齐字段。
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				// 加列间/两侧竖线，输出这一条物理数据行。
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			// 不是最后数据行就在它之后加分隔横线。
			if (rowIndex < token.rows.length - 1) {
				// 复用表头下方相同几何的分隔线。
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		// 按最终列宽创建下边框横线片段。
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		// 连接下方交叉符号及两个底角结束表格。
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		// 有后继且非space时补表后间距，不在文档末尾无条件加行。
		if (nextTokenType && nextTokenType !== "space") {
			// 追加空串。
			lines.push(""); // Add spacing after table
		}
		// 返回完整表格/回退以外的结果，由外层统一补组件边距与背景。
		return lines;
	}
}
