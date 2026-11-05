// 终端文本处理的公共基础：组件把带颜色/链接的字符串交给这里，得到显示列宽、换行或裁剪结果，再由 TUI 输出。
// 字符串下标按 UTF-16 码元计数，Unicode 码点、用户看到的字素、终端列是不同单位；例：“界”通常是 1 个字素、2 列。
// 码元是 JS 字符串的存储计数单位，码点是 Unicode 字符编号，字素是分段器认定的完整字符组合；例：U+1F642 笑脸是 2 个码元、1 个码点、1 个字素。
// ASCII 是常见英文字符/符号的编码范围；ANSI 转义代码以 ESC（\x1b）等控制字符表达命令，颜色代码的字符串长度不等于占用屏幕列数。
// 下文 CSI 是 ESC[ 开头的控制序列，SGR 是其中以 m 结尾的颜色/属性命令；OSC（ESC]）可带标题/链接，APC（ESC_）可带应用标记。
// OSC8 是超链接命令；BEL（\x07）或 ST（ESC 加反斜杠）用来结束字符串控制序列，关闭链接另需空 URL，而不是只写 SGR0。
// 这些函数只处理字符串，不向终端发送控制码，也不打开 URL；宽度采用本项目规则估算，并不探测每台终端的实际字形。
// 具名导入东亚宽度查询；实际依赖默认把 ambiguous 类字符按 1 列处理，调用处没有传宽字符选项。
import { eastAsianWidth } from "get-east-asian-width";

// segmenters (shared instance)
// 模块加载时创建共享字素分段器；undefined 使用运行时默认语言环境，grapheme 把 e 加重音、组合 emoji 等尽量作为完整显示单位。
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// 另建共享单词分段器供编辑器移动光标等使用；分词依赖语言环境，不等于简单地按空格切字符串。
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Get the shared grapheme segmenter instance.
 */
// 返回共享字素分段器，无参数、不复制也不修改它；调用方可用 segment("é界") 遍历字素，返回类型只在编译期约束 API。
// export 允许别的模块导入这个函数，function 声明可调用逻辑，(): Intl.Segmenter 表示“无参数，返回分段器类型”。
export function getGraphemeSegmenter(): Intl.Segmenter {
	// 每次返回同一个实例，不是新建一个分段器。
	return graphemeSegmenter;
}

/**
 * Get the shared word segmenter instance.
 */
// 返回共享单词分段器，无参数和额外副作用；例：segment("hello world") 可区分词和空白，实际分段由 Intl 实现决定。
export function getWordSegmenter(): Intl.Segmenter {
	// 调用者拿到模块级的 word 实例，其结果还能提供 isWordLike 标记。
	return wordSegmenter;
}

/**
 * Check if a grapheme cluster (after segmentation) could possibly be an RGI emoji.
 * This is a fast heuristic to avoid the expensive rgiEmojiRegex test.
 * The tested Unicode blocks are deliberately broad to account for future
 * Unicode additions.
 */
// 对已分段的非空字素先做便宜的 emoji 候选筛选，返回布尔值，不修改输入；true 仍需下一层 RGI 正则确认。
// 例：带 VS16 的符号会进入候选；这里不是完整 emoji 校验，也不会决定最终列宽。
function couldBeEmoji(segment: string): boolean {
	// 读取首个 Unicode 码点；末尾 ! 是 TypeScript 非空断言，依赖调用者提供非空字素，运行时不会替你检查。
	const cp = segment.codePointAt(0)!;
	// 各候选条件以 || 相连，任意一项命中就返回 true，并短路后续判断。
	return (
		// 首码点落在宽泛的 emoji/象形文字区间即可成为候选。
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
		// 技术符号区也可能包含 emoji，不能仅按名称排除。
		(cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
		// 通用符号和装饰符号区同样进入候选。
		(cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
		// 补充少量星形、圆形等符号所在区间。
		(cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
		// VS16 表示请求 emoji 外观；includes 只检查是否存在这个选择符。
		segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
		// length 是 UTF-16 码元数，大于 2 仅作为组合序列的宽松线索，不表示已经数出了多个 Unicode 码点。
		segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
	);
}

// Regexes for character classification (same as string-width library)
// ^ 与 $ 限定整个字素；+ 表示一个或多个默认忽略字符/控制符/组合标记/代理码元，v 开启 Unicode 集合与属性语法。
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
// 这里只匹配开头连续的不打印码点，另含 Format；后面据此找到基础可见码点，而不是删除整个字素里的所有标记。
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
// 单码点分类用于跳过字素尾部不打印的内容，含 Format；与上面的整串规则范围略有不同。
const nonPrintingCharRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
// \p{Mark} 匹配 Unicode 标记类，供后面的“前一个字符是组合标记”状态使用。
const markCharRegex = /^\p{Mark}$/v;
// Marks that terminals allocate cells for when attached to a base character.
// This includes Unicode spacing marks and non-spacing exceptions in legacy wcwidth tables.
// 某些标记在终端里需要单独计列，不能全部按零宽处理；下行保留项目的 Unicode 例外清单。
const terminalSpacingMarkRegex =
	// v 模式的 -- 是字符集合差集：从 Spacing_Mark 排除三个码点，再并入指定例外；+ 允许整串都由这些标记组成。
	/^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
// RGI_Emoji 是 Unicode 推荐通用 emoji 序列属性；在宽松预筛选后才做完整字素匹配，减少常见文本的开销。
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// Cache for non-ASCII strings
// 只为走过普通分段路径的字符串保存最多 512 项；ASCII 快速路径不会写入这个缓存。
const WIDTH_CACHE_SIZE = 512;
// Map<string, number> 在编译期限定“原字符串 → 列宽”；按插入顺序淘汰，命中时不提升顺序，因而不是 LRU。
// const 只禁止把 widthCache 重绑成另一个对象，不禁止下面的 set/delete 修改这个 Map 的条目。
const widthCache = new Map<string, number>();

// 导出中日韩等文字的换行候选正则，供本文件按字素拆词，也供外部补全逻辑组合使用。
export const cjkBreakRegex =
	// Script_Extensions 覆盖汉字、平/片假名、韩文、注音；u 开启 Unicode 属性匹配，没有 g 因而 test 不推进 lastIndex。
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

// CJK letters remain part of words and paths; only punctuation can separate prose from completions.
// 导出补全用的 CJK 标点规则；中文正文字符仍属于词或路径，标点才作为分隔符。
export const cjkPunctuationRegex = new RegExp(
	// 模板由“先确认 Punctuation 再匹配 CJK 脚本”和显式全角标点表两支组成；.source 取正则正文，双反斜杠用于在字符串里保留正则转义。
	`(?:(?=\\p{Punctuation})${cjkBreakRegex.source}|[，．：；！？（）［］｛｝“”‘’…—])`,
	// RegExp 构造器第二参数 u 启用 Unicode 语义；整个模式在模块加载时构造一次。
	"u",
);
// 补全分隔符是空白或上述标点；(?:...) 只分组不捕获，不会把普通中文汉字当成分隔符。
export const autocompleteSeparatorRegex = new RegExp(`(?:\\s|${cjkPunctuationRegex.source})`, "u");
// 补全边界在字符串开头或分隔符处成立；^ 是起点分支，不要求输入本身以空格开头。
export const autocompleteBoundaryRegex = new RegExp(`(?:^|${autocompleteSeparatorRegex.source})`, "u");

// 检查所有码元是否都是可打印 ASCII，返回布尔值且无副作用；例："abc" 为 true，"界"/tab 为 false，空串也为 true。
function isPrintableAscii(str: string): boolean {
	// i 是字符串码元下标，逐个遍历；ASCII 每个码元恰好对应 1 列。
	for (let i = 0; i < str.length; i++) {
		// charCodeAt 返回当前位置的 UTF-16 数值，足够检查 ASCII 范围。
		const code = str.charCodeAt(i);
		// 0x20 是空格、0x7e 是 ~，范围外不适用简单的一字符一列捷径。
		if (code < 0x20 || code > 0x7e) {
			// 遇到一个不合适的字符立即退出，避免多余扫描。
			return false;
		}
	}
	// 所有位置都通过检查，才允许调用方直接按 length/slice 计算。
	return true;
}

// 把一个片段截成不超过 maxWidth 的连续前缀，同时返回实际列宽；用于裁短省略号，不自行加省略号、关闭链接或重置颜色。
// 按 ASCII、无控制码字素、带控制码/tab 三条路径处理，不修改输入；例：“界a”限 1 列会返回空串和 0，不能保留半个汉字。
function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
	// 非正容量或空输入直接得到空片段。
	if (maxWidth <= 0 || text.length === 0) {
		// 对象返回类型中的 text 是保留字符串、width 是估算终端列数，并非原字符串 length。
		return { text: "", width: 0 };
	}

	// 普通 ASCII 每个字符 1 列，可省去字素分段和 ANSI 扫描。
	if (isPrintableAscii(text)) {
		// slice 的结束下标不包含该位置；容量以内保留整段，超出则取开头部分。
		const clipped = text.slice(0, maxWidth);
		// ASCII 的码元数就是这里的实际列宽。
		return { text: clipped, width: clipped.length };
	}

	// 先记下是否含 ESC，决定是否需要识别控制序列。
	const hasAnsi = text.includes("\x1b");
	// tab 采用固定 3 列规则，需要独立处理。
	const hasTabs = text.includes("\t");
	// 两者都没有时，直接按完整字素累加。
	if (!hasAnsi && !hasTabs) {
		// 累积已决定保留的连续前缀。
		let result = "";
		// 保存前缀的显示列宽，而不是它的码元数量。
		let width = 0;
		// segment 返回可迭代对象；解构只取每个结果的 segment 文本，保留组合字素完整性。
		for (const { segment } of graphemeSegmenter.segment(text)) {
			// 调用同一套字素宽度规则，避免本函数与 visibleWidth 算法不同。
			const w = graphemeWidth(segment);
			// 添加这个完整字素会超容量就停止，不跳过它再挑后面的窄字。
			if (width + w > maxWidth) {
				// break 退出字素循环，现有前缀仍可返回。
				break;
			}
			// 宽度允许时拼入原字素文本。
			result += segment;
			// 同步更新已用列数，零宽字素不会增加数值。
			width += w;
		}
		// 返回实际收集到的前缀；width 是属性简写，等于 width: width。
		return { text: result, width };
	}

	// 带控制码的慢路径也维护独立的文本结果。
	let result = "";
	// 这里继续按终端列计数。
	let width = 0;
	// i 按原字符串 UTF-16 下标推进。
	let i = 0;
	// 暂存尚未跟随保留文字的控制码，避免截断点之后的样式泄露到结果里。
	let pendingAnsi = "";

	// 只要还没读完字符串，就继续识别控制码、tab 或普通字素。
	while (i < text.length) {
		// 提取从 i 开始的受支持 ANSI/OSC/APC 序列；普通文本处返回 null。
		const ansi = extractAnsiCode(text, i);
		// 对象存在表示这一段控制码可以整体跳过，不计显示列宽。
		if (ansi) {
			// 先积攒控制码，直到确定下一个可见单位能够保留。
			pendingAnsi += ansi.code;
			// 按控制序列的码元长度越过它，而不是误将其中的 URL/数字当作文字。
			i += ansi.length;
			// 本轮已处理控制码，从新位置继续循环。
			continue;
		}

		// tab 独立分支，不交给终端按 tab stop 展开。
		if (text[i] === "\t") {
			// 整个 tab 固定 3 列，剩余不足时不能只保留其中一部分。
			if (width + 3 > maxWidth) {
				// 停止扫描并返回已保留的连续前缀。
				break;
			}
			// 只有这个 tab 能保留时，才附带前面暂存的控制码。
			if (pendingAnsi) {
				// 先恢复原先控制码与 tab 的顺序。
				result += pendingAnsi;
				// 清空已写出的待处理控制码，避免下一字符重复写入。
				pendingAnsi = "";
			}
			// 这里保留原 tab 字符；输出正规化由另一个函数处理。
			result += "\t";
			// 记账按 3 列，而不是 tab 字符的 length=1。
			width += 3;
			// 原输入下标只越过一个 tab 码元。
			i++;
			// 下一轮重新从控制码识别开始。
			continue;
		}

		// end 用来找下一段无控制码、无 tab 的普通文本区间。
		let end = i;
		// 到输入末尾或 tab 处停止扩展区间。
		while (end < text.length && text[end] !== "\t") {
			// 检查当前位置是否有完整的受支持控制码。
			const nextAnsi = extractAnsiCode(text, end);
			// 控制码起点也应成为普通区间的终点。
			if (nextAnsi) {
				// 让后续主循环单独处理这段控制码。
				break;
			}
			// 不是边界时继续按码元寻找，不在这里计算字素宽度。
			end++;
		}

		// 对 [i,end) 的普通区间一次分段；slice 不含 end。
		for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
			// 得到当前完整字素的列宽。
			const w = graphemeWidth(segment);
			// 前缀加上字素会超出预算时，连续前缀已经结束。
			if (width + w > maxWidth) {
				// 立即返回，暂存而未消费的控制码不会出现在结果中。
				return { text: result, width };
			}
			// 只有将保留字素时才提交其前面的控制码。
			if (pendingAnsi) {
				// 保持“控制码在可见字素之前”的原始顺序。
				result += pendingAnsi;
				// 提交之后清空暂存区。
				pendingAnsi = "";
			}
			// 拼入整个字素，绝不按码元切开 emoji 或组合字符。
			result += segment;
			// 增加该字素占用的终端列数。
			width += w;
		}
		// 这段普通文本处理完毕，转到其后边界。
		i = end;
	}

	// 到末尾或 tab 超限后统一返回；不附加尚未跟随保留内容的 pendingAnsi。
	return { text: result, width };
}

// 完成真正发生截断时的收尾：关闭前缀中仍打开的 OSC8 链接、重置 SGR、添加省略号并可选补空格，返回新字符串。
// 输入的两项宽度由调用者提供，不会在此重新测量；例：红色前缀会在省略号前恢复默认样式，省略号之后也重置，不恢复调用者外层样式。
function finalizeTruncatedResult(
	// 已经挑选好的正文连续前缀，可能含颜色或 OSC8 链接控制码。
	prefix: string,
	// 前缀已占用的列数。
	prefixWidth: number,
	// 要显示的省略号文本，也允许空串或自带样式。
	ellipsis: string,
	// 省略号预先计算出的列数。
	ellipsisWidth: number,
	// 目标总容量，只用于补齐剩余列，不在这里重新裁剪文本。
	maxWidth: number,
	// pad 决定是否在最后追加空格；布尔类型只由 TypeScript 检查。
	pad: boolean,
	// 返回值是整理后的终端文本字符串。
): string {
	// SGR 0 把颜色/文本属性恢复默认，不会自动关闭 OSC8 链接。
	const reset = "\x1b[0m";
	// 扫描前缀，若最后仍处于链接中则生成匹配其结束符的关闭代码。
	const hyperlinkClose = getActiveOsc8Close(prefix);
	// 局部变量与导出的 visibleWidth 函数同名，但这里是两项已知宽度之和，不是函数调用。
	const visibleWidth = prefixWidth + ellipsisWidth;
	// 先声明后在两个分支赋值；: string 是静态类型标注。
	let result: string;

	// 省略号是否为空决定要不要追加第二个重置码。
	if (ellipsis.length > 0) {
		// 模板拼接顺序是正文→关闭链接→重置→省略号→再次重置，避免正文样式影响省略号和后续补白。
		result = `${prefix}${hyperlinkClose}${reset}${ellipsis}${reset}`;
		// 省略号为空时仍需要把正文样式关闭。
	} else {
		// 只拼正文、链接关闭码和一次 SGR 重置。
		result = `${prefix}${hyperlinkClose}${reset}`;
	}

	// 三元表达式按 pad 选择补齐；Math.max 防止负重复次数，空格置于重置之后。
	return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
// 估算一个已分段字素的终端列宽，无输入修改；依次处理 ASCII/tab、占列标记、零宽、emoji、基础码点和尾部例外。
// 例：“界”通常 2 列、“é”1 列；这里采用终端兼容规则而非字形测量，不能保证所有终端/字体完全一致，调用者应提供非空字素。
function graphemeWidth(segment: string): number {
	// 只有一个 UTF-16 码元时才可能走这些最便宜的分支。
	if (segment.length === 1) {
		// 读取该单码元数值。
		const code = segment.charCodeAt(0);
		// 可打印 ASCII（包括空格）固定计 1 列。
		if (code >= 0x20 && code <= 0x7e) return 1;
		// tab 在全项目布局中固定计 3 列，不取决于当前列位置。
		if (code === 0x09) return 3;
	}

	// Some marks occupy cells even without a base character.
	// 先识别整个片段都由终端占列标记组成的情况，优先于普通 Mark 的零宽判断。
	if (terminalSpacingMarkRegex.test(segment)) {
		// 字符串展开运算按 Unicode 码点迭代；每个此类标记计 1 列，区别于 segment.length 的 UTF-16 数量。
		return [...segment].length;
	}

	// Zero-width clusters
	// 整个片段都属于零宽类时不占终端列。
	if (zeroWidthRegex.test(segment)) {
		// 返回数值 0，并非删除输入字符。
		return 0;
	}

	// Emoji check with pre-filter
	// && 先做便宜筛选，再确认整个字素符合 RGI_Emoji 属性。
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
		// 项目将确认的 emoji 字素整体计为 2 列，不逐个相加肤色、连接符等组成部分。
		return 2;
	}

	// Get base visible codepoint
	// 只移掉开头不打印字符，保留后续结合关系以便分析基础码点及尾部。
	const base = segment.replace(leadingNonPrintingRegex, "");
	// 读取基础 Unicode 码点，空串会得到 undefined。
	const cp = base.codePointAt(0);
	// 去掉前缀后可能没有基础码点，例如仅包含格式控制符。
	if (cp === undefined) {
		// 这种情况按零列处理。
		return 0;
	}

	// Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
	// full-width emoji in terminals, even when isolated during streaming.
	// Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
	// 单独区域指示符可能是流式输出中尚未组成旗帜的一半，采用保守的 2 列规则。
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		// 即使不是完整国旗组合，也按 2 列防止后续绘制发生位置漂移。
		return 2;
	}

	// 用依赖查询基础码点的东亚宽度（1 或 2），此处未启用 ambiguousAsWide。
	let width = eastAsianWidth(cp);

	// Intl.Segmenter can group multiple terminal-spacing code points into one
	// grapheme. Count trailing visible code points that terminals may allocate
	// cells for: Indic consonants after marks, halfwidth/fullwidth forms, and
	// Thai/Lao AM vowels.
	// 记录最近遇到的普通组合标记，决定后续可见码点是否需要额外占列。
	let followsMark = false;
	// 展开为 Unicode 码点数组，避免把辅助平面字符拆成代理对两半。
	const chars = [...base];
	// 跳过已经计算过的首个基础码点，只遍历其后的组成字符。
	for (const char of chars.slice(1)) {
		// 终端占列标记优先单独加宽。
		if (terminalSpacingMarkRegex.test(char)) {
			// 此类尾部标记再增加 1 列。
			width += 1;
			// 它已按独立占列规则处理，清除“普通标记之后”的状态。
			followsMark = false;
			// 其余 Unicode Mark 本身不直接增加列宽。
		} else if (markCharRegex.test(char)) {
			// 记住遇到标记，后面的可见字符可能是同一字素内额外占列的辅音等。
			followsMark = true;
			// 其余不打印字符跳过；只有可见码点进入这一分支，跳过时不会清除 followsMark。
		} else if (!nonPrintingCharRegex.test(char)) {
			// char 来自非空码点迭代，! 只是向 TypeScript 声明 codePointAt 不会为空。
			const c = char.codePointAt(0)!;
			// 标记之后的可见码点，或半角/全角形式区内的尾随码点，要另按东亚宽度计列。
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) {
				// halfwidth + fullwidth forms
				// 增加该尾随码点的 1/2 列，不重新计算已处理的基础码点。
				width += eastAsianWidth(c);
				// Thai/Lao AM 元音在该分支下还有专门的占列规则。
			} else if (c === 0x0e33 || c === 0x0eb3) {
				// 这两个尾随码点各增加 1 列。
				width += 1;
			}
			// 遇到可见码点后结束此前标记的影响，即使该码点没有触发额外加宽。
			followsMark = false;
		}
	}

	// 返回基础宽度与尾部兼容修正之和。
	return width;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
// 计算字符串的估算终端列宽，跳过受支持控制序列、把 tab 计 3 列；不解释移动光标后的实际屏幕布局。
// 先走 ASCII 快路，再查模块缓存，最后剥离控制码并按字素相加；例：红色的“日本 ok”计 7 列，颜色码不计列。
// 不会写终端或改原字符串，但普通路径会更新最多 512 项的模块缓存；未识别的转义不是已完成的合法序列。
export function visibleWidth(str: string): number {
	// 空输入没有可见列数。
	if (str.length === 0) {
		// 直接返回 0，不走缓存。
		return 0;
	}

	// Fast path: printable ASCII, tabs, and ANSI escape sequences. Styled lines take this path, so
	// re-rendering after a theme change does not run grapheme segmentation on every line.
	// 尝试不分段、不生成清理副本的 ASCII/tab/已识别 ANSI 扫描。
	const asciiWidth = asciiVisibleWidth(str);
	// -1 是“不能使用快速结果”的哨兵值，0 仍是有效宽度。
	if (asciiWidth !== -1) {
		// 成功时立即返回，含颜色的 ASCII 也不用字素分段。
		return asciiWidth;
	}

	// Check cache
	// 缓存键为传入的原始字符串，包括颜色码等，非去样式后的正文。
	const cached = widthCache.get(str);
	// 用 undefined 区分未命中，因此缓存值为 0 也能命中。
	if (cached !== undefined) {
		// 直接返回已有宽度，不改变 Map 的插入顺序。
		return cached;
	}

	// Normalize: tabs to 3 spaces, strip ANSI escape codes
	// 字符串不可变，clean 只是后续可能被替换的局部引用。
	let clean = str;
	// 只有出现 tab 时才生成替换副本。
	if (str.includes("\t")) {
		// g 表示替换所有 tab 为三个空格；此步先于控制码剥离，序列载荷内的 tab 也会先被替换。
		clean = clean.replace(/\t/g, "   ");
	}
	// indexOf 找第一个 ESC，未找到返回 -1。
	let escapeIndex = clean.indexOf("\x1b");
	// 有 ESC 才分配剥离序列用的结果缓冲字符串。
	if (escapeIndex !== -1) {
		// Strip supported ANSI/OSC/APC escape sequences in one pass.
		// This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
		// and APC sequences like CURSOR_MARKER.
		// 累积每段需要保留的普通文本。
		let stripped = "";
		// copyFrom 标记尚未复制的原文起点。
		let copyFrom = 0;
		// 逐个查找 ESC 起点，不为每个普通字符调用控制码解析。
		while (escapeIndex !== -1) {
			// 查询从这个 ESC 开始是否有受支持、带结束标记的序列。
			const length = ansiCodeLength(clean, escapeIndex);
			// 只剥离解析器确实识别出的序列。
			if (length > 0) {
				// 保留前一个已删序列之后、本次序列之前的原文。
				stripped += clean.slice(copyFrom, escapeIndex);
				// 越过序列的全部码元。
				escapeIndex += length;
				// 下一段待复制原文从序列之后开始。
				copyFrom = escapeIndex;
				// 未识别的 ESC 不能整体丢弃其后面的文字。
			} else {
				// 只把搜索下标向后移动，copyFrom 不变，因此这一段原文之后仍会保留。
				escapeIndex++;
			}
			// 从新位置找下一处 ESC，避免重复扫描同一开头。
			escapeIndex = clean.indexOf("\x1b", escapeIndex);
		}
		// 拼接之前保留的各段与最后尾部，得到供分段的文本。
		clean = stripped + clean.slice(copyFrom);
	}

	// Calculate width
	// 准备总列宽累计值。
	let width = 0;
	// 对清理后字符串按完整字素迭代，不按 UTF-16 length 累加。
	for (const { segment } of graphemeSegmenter.segment(clean)) {
		// 每个字素使用同一套 emoji/标记/东亚宽度规则。
		width += graphemeWidth(segment);
	}

	// Cache result
	// 写入新结果前，容量满时淘汰最早插入项。
	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		// Map.keys() 按插入顺序生成迭代器，next().value 是最早的键或 undefined。
		const firstKey = widthCache.keys().next().value;
		// 迭代器无键时不执行删除；这是 Map API 返回类型允许的情况。
		if (firstKey !== undefined) {
			// 删掉该键，给本次新字符串腾出一个名额。
			widthCache.delete(firstKey);
		}
	}
	// 把原字符串和刚计算的宽度保存，供后续完全相同输入复用。
	widthCache.set(str, width);

	// 返回估算列宽，调用者可以用它做换行、补白和鼠标列定位。
	return width;
}

/** Remove ANSI, OSC, and APC control sequences while preserving visible text. */
// 移除本解析器支持的 CSI/OSC/APC 序列，返回新文本且不改输入；例：红色 hello 得到 hello，未闭合序列的其余字节会保留。
// 这不是任意终端输入的全面消毒或完整 ANSI 验证器，不能据此保证结果无全部控制字符。
export function stripTerminalSequences(str: string): string {
	// 没有 ESC 就直接返回原串，不必额外遍历。
	if (!str.includes("\x1b")) return str;
	// 用来累积控制序列之外的字符。
	let result = "";
	// 按 UTF-16 下标扫描原文。
	let i = 0;
	// 扫描到字符串末尾为止。
	while (i < str.length) {
		// 当前位置若是受支持控制码起点，则可整段跳过。
		const ansi = extractAnsiCode(str, i);
		// null 以外的结果包含完整序列的长度。
		if (ansi) {
			// 越过整个序列，不复制它。
			i += ansi.length;
			// 继续处理紧接着的内容。
			continue;
		}
		// 不是序列时按原样保留一个码元，包含未识别的 ESC。
		result += str[i];
		// 向后移动一个码元；原字符的代理对两半最终会按顺序拼回。
		i++;
	}
	// 返回过滤后的字符串，不产生终端 I/O。
	return result;
}

// 收集文本中所有已识别控制码，舍弃普通文字；供换行丢掉空白时仍保留关闭样式的代码。
// 输入是任意字符串，输出按原顺序拼接的代码且无额外副作用；例：红色空格的正文被丢弃后仍可保留其中颜色/重置序列。
function extractAnsiCodes(str: string): string {
	// 累积找到的控制码，不存正文。
	let result = "";
	// 直接寻找第一个 ESC，跳过开头普通文字。
	let i = str.indexOf("\x1b");
	// 只要还有 ESC 候选点就继续扫描。
	while (i !== -1) {
		// 获取该起点受支持序列的长度。
		const length = ansiCodeLength(str, i);
		// 完整识别到序列才提取。
		if (length > 0) {
			// substring 的结束下标不含末尾，原样保留控制码全部内容和结束符。
			result += str.substring(i, i + length);
			// 跳过刚收集的序列。
			i += length;
			// 不能识别该 ESC 时仍需向后找，不能卡在原位置。
		} else {
			// 只越过这个候选起点，不假设后续都是有效载荷。
			i++;
		}
		// 从新位置寻找下一处 ESC。
		i = str.indexOf("\x1b", i);
	}
	// 返回所有已识别序列按原顺序组成的字符串。
	return result;
}

// Same character set as String.prototype.trim()
// \s 与 JS trim 的空白分类一致，包括普通空格以外的 Unicode 空白；无 g 的正则可反复 test。
const WHITESPACE_REGEX = /\s/;

/**
 * Whether a token's visible text is only whitespace. Codes closing a styled word attach to the following space,
 * e.g. "\x1b[22m ", so they are skipped. Stops at the first visible non-whitespace text without allocating a
 * stripped copy, because styled words reach this check on every wrap.
 */
// 判断 token 除受支持控制码外是否全是空白，不创建去样式副本；例：“关闭粗体码 + 空格”为 true，普通词为 false。
// 空串和仅含可识别控制码也返回 true；用于换行决定是否丢弃边界空白，不是按实际终端可见性作全面判断。
function isWhitespaceToken(token: string): boolean {
	// 从 token 起始码元开始检查。
	let i = 0;
	// 逐段检查直到末尾或遇见非空白。
	while (i < token.length) {
		// 先用码元值快速区分 ESC、常见 ASCII 空白和其他字符。
		const code = token.charCodeAt(i);
		// ESC 可能是包在空白附近的样式关闭码。
		if (code === 0x1b) {
			// 只有受支持、已结束的控制序列才可跳过。
			const length = ansiCodeLength(token, i);
			// 孤立/无法识别的 ESC 在本判定中使 token 非空白；这不表示 graphemeWidth 一定会给 ESC 本身计列。
			if (length === 0) return false; // A lone ESC is visible text
			// 识别成功就越过整个控制码，不检查其内部参数是否含字母。
			i += length;
			// 普通空格及 tab/LF/VT/FF/CR 可用数值范围直接识别。
		} else if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
			// 消费这一个空白码元。
			i++;
			// 剩余 ASCII 肯定非空白；非 ASCII 再查 \s，|| 可短路正则开销，! 只是编译期非空断言。
		} else if (code < 0x80 || !WHITESPACE_REGEX.test(token[i]!)) {
			// 找到一个非空白单位就返回 false。
			return false;
			// 余下情况已经被正则确认是空白。
		} else {
			// 向后消费该空白码元。
			i++;
		}
	}
	// 遍历完仍未遇到非空白，就允许调用方把它作为空白 token 处理。
	return true;
}

// 匹配连续 C0 与 C1 控制字符，+ 把一串作为一次匹配，g 让替换覆盖所有匹配段。
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Replace each run of C0 and C1 control characters (ESC, BEL, newlines, ...) with one space. */
// 把每段连续控制字符替换成一个空格，返回新串且不改输入；例：“a\n\tb”变成“a b”。
// 这里只换控制字符，不识别 ANSI 整段；ESC[31m 的 ESC 被换后，其余 [31m 仍会留下。
export function replaceControlCharacters(str: string): string {
	// replace 按正则的每个连续段替换，不是对段内每个控制字符各加一个空格。
	return str.replace(CONTROL_CHARACTERS, " ");
}

// 一个字素占据的终端列区间，只有编译期结构约束；运行时返回普通对象，采用左闭右开 [start,end)。
interface GraphemeCellRange {
	// 字素起始列，第一列编号为 0。
	start: number;
	// 字素结束之后的一列；例：“界”从 0 开始时 end 为 2。
	end: number;
}

/** Return the terminal-cell range occupied by the grapheme at a visible column. */
// 查某个显示列属于哪个完整字素，供选择范围和滚动条替换对齐；输入是行文本/列号，返回区间或 undefined，不改行。
// 跳过受支持控制码并按字素累计列；例：“a界”第 2 列返回 {start:1,end:3}，不存在的列返回 undefined，不执行控制码的光标移动。
export function getGraphemeCellRange(line: string, column: number): GraphemeCellRange | undefined {
	// 当前字素起点的终端列坐标。
	let currentCol = 0;
	// 原字符串的扫描下标，单位是 UTF-16 码元。
	let i = 0;
	// 继续扫描所有序列和普通文字。
	while (i < line.length) {
		// 若当前位置是受支持控制码，整段不占显示列。
		const ansi = extractAnsiCode(line, i);
		// 可识别的控制码对象在此作为真值。
		if (ansi) {
			// 跳过控制码载荷。
			i += ansi.length;
			// 从其后位置继续，不增加 currentCol。
			continue;
		}
		// 准备寻找下一段可分字素的普通文字。
		let textEnd = i;
		// 直到下一个已识别控制码或行尾；未识别 ESC 仍留在普通片段中。
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
		// 对该普通片段分字素，解构取得每个 segment 文本。
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			// 统一估算该字素的占列数。
			const width = graphemeWidth(segment);
			// 仅正宽字素可能覆盖某列；起点包含、终点排除，宽字的两列都会命中同一区间。
			if (width > 0 && column >= currentCol && column < currentCol + width) {
				// 返回整个字素边界，调用方可避免只删/选择“半个宽字”。
				return { start: currentCol, end: currentCol + width };
			}
			// 未命中时推进显示列，零宽字符不会改变坐标。
			currentCol += width;
		}
		// 继续检查下一处控制码及其后文本。
		i = textEnd;
	}
	// 整个输入没有覆盖目标列的字素；例如负列或超出行宽。
	return undefined;
}

/** Return the OSC 8 hyperlink covering a visible terminal column. */
// 返回指定显示列当前生效的 OSC8 URL，找不到则 undefined；只解析字符串，不验证 URL、安全性或实际可点击能力，也不发起打开操作。
// 先跟踪链接开/关，再按字素列定位；例：链接内“界”的两列都返回同一 URL，空 URL 关闭之后的文字不再带链接。
export function getOsc8LinkAtColumn(line: string, column: number): string | undefined {
	// 联合类型允许字符串或 undefined；尚未遇到打开代码时没有活动 URL。
	let activeUrl: string | undefined;
	// 当前普通字素在显示行中的起始列。
	let currentCol = 0;
	// 逐码元扫描的源字符串下标。
	let i = 0;
	// 扫描至目标字素或行尾。
	while (i < line.length) {
		// 先提取受支持控制码，防止把 OSC 里的 URL 当显示文字。
		const ansi = extractAnsiCode(line, i);
		// 序列不占列，但可能改变活动链接。
		if (ansi) {
			// 完整 OSC8 模式：跳过参数字段，捕获 URL，接受 BEL 或 ST 结尾；不是 OSC8 的序列不会更新链接。
			const hyperlink = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(ansi.code);
			// 有匹配则更新活动 URL；|| 把空 URL 转为 undefined，表示关闭链接。
			if (hyperlink) activeUrl = hyperlink[1] || undefined;
			// 越过整段控制码。
			i += ansi.length;
			// 不增加显示列，从后续文本继续定位。
			continue;
		}
		// 定位普通文字区间的终点。
		let textEnd = i;
		// 扫描到下个完整受支持序列或行尾。
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
		// 按字素而不是单个码元判断列覆盖范围。
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			// tab 显式按 3 列；其他字素交给共用宽度函数。
			const width = segment === "\t" ? 3 : graphemeWidth(segment);
			// 找到覆盖列时返回当时的 URL；字素宽为 0 时此区间不会命中。
			if (column >= currentCol && column < currentCol + width) return activeUrl;
			// 未找到时把显示列推进整个字素宽度。
			currentCol += width;
		}
		// 普通区间结束后，继续处理其后的控制码。
		i = textEnd;
	}
	// 目标列超出文本，或者根本没有可覆盖的字素，统一返回 undefined。
	return undefined;
}

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers. Visible tabs are
 * expanded to the fixed width used by layout so terminal tab stops cannot wrap
 * a logical line, while tabs inside terminal string sequences stay untouched.
 */
// 先用无 g 正则廉价检查是否含 Thai/Lao AM 元音，不改变正则游标。
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
// 真正替换时用 g 覆盖每一个该元音；这是指定码点的兼容拆分，不是对全文运行 Unicode NFKC。
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

// 生成发往终端前的正规化文本，不改编辑器保存的逻辑字符串；先拆 Thai/Lao AM 元音，再把控制码之外的 tab 换成 3 个空格。
// 例：“a\tb”得到“a   b”，已识别 OSC8 内的 tab 保留；元音替换先作用于整个字符串，因此控制码载荷里的这些元音也可能被替换。
// 这里只返回字符串，无终端 I/O；沿用本文件的有限序列识别规则，未识别载荷内的 tab 不享受保护。
export function normalizeTerminalOutput(str: string): string {
	// 先保留原引用，只在确有元音/tab 时生成处理结果。
	let normalized = str;
	// 没有这两个元音就跳过 replace 分配。
	if (THAI_LAO_AM_REGEX.test(normalized)) {
		// 替换回调每次接收被匹配的一个元音，并同步返回兼容分解文本。
		normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
			// Thai AM 拆成 Thai 两码点，另一种匹配就是 Lao AM，拆成 Lao 两码点。
			char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
		);
	}
	// 没有 tab 则元音处理已完成，直接返回。
	if (!normalized.includes("\t")) return normalized;

	// 累积最终输出字符串，独立于原编辑文本。
	let result = "";
	// 下标按元音替换后的字符串计算。
	let i = 0;
	// 扫描所有字符与控制序列。
	while (i < normalized.length) {
		// 检查当前位置是否是可整体保留的控制码。
		const ansi = extractAnsiCode(normalized, i);
		// 识别到的序列要保持此阶段的内容，不对其中 tab 做展开。
		if (ansi) {
			// 拼入整段序列；若其载荷有上述元音，前一步可能已经改过它。
			result += ansi.code;
			// 按整段长度越过载荷。
			i += ansi.length;
			// 直接处理后面的内容。
			continue;
		}
		// 普通文本中的 tab 扩成 3 空格，其余码元原样拷贝；三元表达式只选择要拼接的文本。
		result += normalized[i] === "\t" ? "   " : normalized[i];
		// 推进一个普通文本码元。
		i++;
	}
	// 返回适合项目列宽规则的输出副本。
	return result;
}

/**
 * Extract ANSI escape sequences from a string at the given position.
 */
// 尝试提取 str 在 UTF-16 下标 pos 处的受支持序列，返回 {code,length} 或 null；不搜索后续位置、不修改输入。
// 例：红色代码起点返回整段代码及其码元长度，普通字母处返回 null；这只是有限序列识别，不保证参数或 URL 合法。
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	// 具体扫描工作由只返回长度的内部解析器承担。
	const length = ansiCodeLength(str, pos);
	// 识别到长度时才创建对象/substring；否则返回 null，让调用方按普通字符继续。
	return length > 0 ? { code: str.substring(pos, pos + length), length } : null;
}

/**
 * Width of a string made of printable ASCII, tabs, and ANSI escape sequences, or -1 if it contains
 * anything else. Matches `visibleWidth` for those strings without allocating.
 */
// 尝试无需分段/清理副本的列宽快算；输入只要全由可打印 ASCII、tab、可识别控制码组成，就返回宽度，否则返回 -1。
// 例：带红色码的 abc 返回 3，“界”返回 -1 转入慢路径；无终端副作用，也不更新宽度缓存。
function asciiVisibleWidth(str: string): number {
	// 累计普通字符与 tab 的列宽。
	let width = 0;
	// 原字符串扫描下标。
	let i = 0;
	// 遍历所有输入直到失败或读完。
	while (i < str.length) {
		// 取码元数值，快速分支不需创建单字符字符串。
		const code = str.charCodeAt(i);
		// 最常见的可打印 ASCII 优先判断。
		if (code >= 0x20 && code <= 0x7e) {
			// 每个这样的码元占 1 列。
			width++;
			// 推进到下一码元。
			i++;
			// tab 也是可快速算宽的特殊 ASCII。
		} else if (code === 0x09) {
			// tab 固定增加 3 列，与起始列无关。
			width += 3;
			// 源字符串中 tab 只占一个码元。
			i++;
			// ESC 交给序列扫描器判断能否整体跳过。
		} else if (code === 0x1b) {
			// 获取已结束、受支持序列的长度。
			const length = ansiCodeLength(str, i);
			// 未识别的 ESC 无法在此快算，返回哨兵 -1。
			if (length === 0) return -1;
			// 跳过整段，不增加列数。
			i += length;
			// 非 ASCII 或其他控制字符必须采用一般字素规则。
		} else {
			// 通知 visibleWidth 使用慢路径，不是返回真实的负列宽。
			return -1;
		}
	}
	// 完整扫描成功，返回已累加的宽度。
	return width;
}

/** Length of the ANSI/OSC/APC escape sequence starting at `pos`, or 0 if there is none. */
// 从 pos 检查本项目支持的 CSI/OSC/APC 序列，返回码元长度或 0；无字符串切片分配、无状态修改。
// 例：ESC[31m 能识别；这里只寻找特定结束字符，不做完整 ECMA-48 参数验证，也不支持全部 CSI（例如独立 ESC[A 不在列表）。
function ansiCodeLength(str: string, pos: number): number {
	// 当前位置不是 ESC 或已过行尾，直接表示没有序列；调用者按正常整数下标使用，没有额外参数正规化。
	if (pos >= str.length || str.charCodeAt(pos) !== 0x1b) return 0;

	// ESC 后一个码元决定是哪类序列。
	const next = str[pos + 1];

	// CSI sequence: ESC [ ... m/G/K/H/J
	// ESC[ 进入 CSI 分支。
	if (next === "[") {
		// 从前缀之后逐个码元寻找本实现接受的结束字母。
		for (let j = pos + 2; j < str.length; j++) {
			// 读取候选结束字符的数值。
			const c = str.charCodeAt(j);
			// m, G, K, H, J
			// 遇 m/G/K/H/J 即认为结束，长度含该字符；中间参数并未验证，不能把它当严格的合法性检查。
			if (c === 0x6d || c === 0x47 || c === 0x4b || c === 0x48 || c === 0x4a) return j + 1 - pos;
		}
		// 直到行尾都没找到认可的结束字母，返回 0 而不吞掉后续正文。
		return 0;
	}

	// OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
	// Used for hyperlinks (OSC 8), window titles, etc.
	// APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
	// Used for cursor marker and application-specific commands
	// ESC] 为 OSC、ESC_ 为 APC，两者采用相同的字符串结束符扫描。
	if (next === "]" || next === "_") {
		// 从两字符前缀之后遍历载荷，不在此解析具体命令编号。
		for (let j = pos + 2; j < str.length; j++) {
			// 读取当前载荷码元，检查是否结束。
			const c = str.charCodeAt(j);
			// BEL 本身占一个码元，长度包含它。
			if (c === 0x07) return j + 1 - pos;
			// ST 是 ESC 加反斜杠两个码元，因此长度包含这两者。
			if (c === 0x1b && str[j + 1] === "\\") return j + 2 - pos;
		}
		// 载荷未结束不能作为完整序列跳过。
		return 0;
	}

	// 其他 ESC 家族不在实现范围内，返回 0 由调用者决定如何处理原文。
	return 0;
}

// 两个字符串字面量组成的联合类型：只允许 BEL 或 ST；这在编译期约束保存/重发格式，不会自动校验外部字符串。
type Osc8Terminator = "\x07" | "\x1b\\";

// 描述当前已打开 OSC8 链接的普通对象，供跨行重新打开时保留参数、地址和原结束符；interface 不生成运行时代码。
interface ActiveHyperlink {
	// OSC8 的参数字段，保持原文，如 id=...，不在这里解释或校验。
	params: string;
	// 链接目标原文，不执行网络请求或地址过滤。
	url: string;
	// 记录打开链接时的 BEL/ST，使重新生成代码时保持同一种结束形式。
	terminator: Osc8Terminator;
}

// 把一个已提取序列解释成 OSC8 状态：对象表示打开、null 表示关闭、undefined 表示不处理；只返回数据，不修改跟踪器。
// 先查前缀再分隔参数与 URL；例：OSC8 的空 URL 得到 null。调用者已经负责提取完整序列，这里未再次严格验证 ST 结束符。
function parseOsc8Hyperlink(ansiCode: string): ActiveHyperlink | null | undefined {
	// 非 OSC8 前缀不是链接状态变化。
	if (!ansiCode.startsWith("\x1b]8;")) {
		// undefined 告诉调用者保持之前的活动链接。
		return undefined;
	}

	// BEL 结尾就保留 BEL，否则按 ST 处理；类型标注约束得到的两种值，不补做结束符验证。
	const terminator: Osc8Terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
	// 移除 ESC]8; 前缀及结尾，负下标表示从末尾向前数。
	const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
	// 剩余内容第一个分号分开参数与 URL。
	const separatorIndex = body.indexOf(";");
	// 缺少分号无法按本规则解释。
	if (separatorIndex === -1) {
		// 返回 undefined，不把畸形输入当关闭链接。
		return undefined;
	}

	// 分号之前原样保留为链接参数。
	const params = body.slice(0, separatorIndex);
	// 分号之后全部作为 URL，后续分号仍属于 URL。
	const url = body.slice(separatorIndex + 1);
	// 空 URL 是 OSC8 的关闭表示。
	if (!url) {
		// null 与 undefined 的含义不同：必须清空跟踪器里的链接。
		return null;
	}
	// 非空 URL 返回三个字段的对象，属性简写取同名局部变量。
	return { params, url, terminator };
}

// 按保存的参数/URL/结束符生成 OSC8 打开字符串，无 I/O 或转义校验；例：原链接用 BEL，就仍用 BEL 重新打开。
function formatOsc8Hyperlink(hyperlink: ActiveHyperlink): string {
	// 模板插值拼接完整 OSC8 代码，不向终端发送。
	return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}

// 生成指定结束符的 OSC8 关闭字符串，无副作用；调用者提供 BEL/ST，例如截断前缀后关闭原链接。
function formatOsc8Close(terminator: Osc8Terminator): string {
	// 两个分号表示空参数和空 URL；空 URL 才是关闭操作，结束符保持调用方选择。
	return `\x1b]8;;${terminator}`;
}

// 扫描被保留正文的前缀，返回其末尾仍打开的链接对应关闭码，或空串；不修改前缀/终端。
// 例：打开→文字且未关闭，会补一个关闭码；打开→文字→关闭则不用补，避免截断省略号继续成为链接。
function getActiveOsc8Close(prefix: string): string {
	// 完全没有 OSC8 前缀就省去一般控制码扫描。
	if (!prefix.includes("\x1b]8;")) {
		// 没有活动链接需要关闭，空串可直接参与拼接。
		return "";
	}

	// 保存扫描时最新链接状态，初始为未打开。
	let activeHyperlink: ActiveHyperlink | null = null;
	// 从原前缀起点按码元扫描。
	let i = 0;
	// 检查全部控制码，最终状态取决于最后一次有效打开/关闭。
	while (i < prefix.length) {
		// 先提取受支持的完整控制序列。
		const ansi = extractAnsiCode(prefix, i);
		// 序列可整体跳过并可能更新链接状态。
		if (ansi) {
			// 进一步区分 OSC8 打开、关闭与不相关代码。
			const hyperlink = parseOsc8Hyperlink(ansi.code);
			// undefined 表示不相关，null 仍需执行更新。
			if (hyperlink !== undefined) {
				// 对象设为打开，null 则清除；不更改其他序列状态。
				activeHyperlink = hyperlink;
			}
			// 跳过整段已识别序列。
			i += ansi.length;
			// 普通正文或未识别转义只需继续寻找下一位置。
		} else {
			// 消费一个码元，确保扫描进展。
			i++;
		}
	}
	// 末尾仍有链接才生成对应 BEL/ST 关闭码，否则返回空串。
	return activeHyperlink ? formatOsc8Close(activeHyperlink.terminator) : "";
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
// 用一组属性跟踪 SGR 样式和 OSC8 链接，为换行、覆盖层继承样式服务；并不模拟完整终端状态（如光标位置）。
// process 更新本实例，getActiveCodes 生成重开代码，reset 仅清 SGR、clear 还清链接；例：红色下划线跨行时可分别关闭下划线再在下一行恢复。
class AnsiCodeTracker {
	// Track individual attributes separately so we can reset them specifically
	// 粗体状态，初始关闭；private 是 TypeScript 访问限制，不是 JS 的 # 私有字段语法。
	// 未写 : boolean 时 TypeScript 从 false 推断字段类型，后面仍可赋 true；并没有把它限制成只能为 false。
	private bold = false;
	// 弱化/暗淡状态，与粗体独立保存，SGR 22 会同时清除两者。
	private dim = false;
	// 斜体是否生效。
	private italic = false;
	// 下划线是否生效，换行收尾时会单独生成关闭码。
	private underline = false;
	// 闪烁是否生效。
	private blink = false;
	// 反色是否生效。
	private inverse = false;
	// 隐藏文本属性是否生效，不在这里据此改变列宽。
	private hidden = false;
	// 删除线是否生效，避免后续填充空格也被画线。
	private strikethrough = false;
	// 前景色保存不含 ESC 前缀和 m 后缀的参数文本，null 表示默认色；联合类型是静态约束。
	private fgColor: string | null = null; // Stores the full code like "31" or "38;5;240"
	// 背景色同理，可保存基本色、256 色或 RGB 参数，方便下一行重新生成。
	private bgColor: string | null = null; // Stores the full code like "41" or "48;5;240"
	// 活动 OSC8 链接对象或 null；SGR 的重置与链接关闭是不同机制。
	private activeHyperlink: ActiveHyperlink | null = null;

	// 消费一个已提取控制码并更新当前实例，无返回值；先识别 OSC8，再解释受支持 SGR 参数，其余序列忽略。
	// 例：process(红色码) 后 getActiveCodes 可重发红色；仅接收/保存字符串，不验证颜色数值范围，也不发送到终端。
	process(ansiCode: string): void {
		// OSC 8 hyperlink: \x1b]8;;<url>\x1b\\ (open) or \x1b]8;;\x1b\\ (close).
		// Preserve the original terminator because some terminals only make BEL-terminated
		// links clickable. OAuth login URLs use BEL, so reopening wrapped lines with ST
		// made only the first physical line clickable in those terminals.
		// 尝试得到打开对象、关闭 null 或不相关 undefined，保留链接原来的 BEL/ST 形式。
		const hyperlink = parseOsc8Hyperlink(ansiCode);
		// 用 !== undefined 包含关闭状态 null，不能只做真值判断。
		if (hyperlink !== undefined) {
			// 打开时替换当前链接，关闭时清空它。
			this.activeHyperlink = hyperlink;
			// 链接已处理，不再尝试按 SGR 解释。
			return;
		}

		// 不是 m 结尾就不可能是此处处理的 SGR 样式代码。
		if (!ansiCode.endsWith("m")) {
			// 例如光标定位或其他 OSC 不改变本跟踪器的样式。
			return;
		}

		// Extract the parameters between \x1b[ and m
		// 捕获 ESC[ 与 m 之间的数字/分号；不支持冒号形式参数，也不是对整个输入加锚点的严格校验。
		const match = ansiCode.match(/\x1b\[([\d;]*)m/);
		// 匹配不到这套参数格式时忽略代码。
		if (!match) return;

		// 取第一个捕获组，即颜色/样式数字组成的参数串。
		const params = match[1];
		// 空参数与单独 0 都表示 SGR 全部恢复默认。
		if (params === "" || params === "0") {
			// Full reset
			// 只重置 SGR 字段，OSC8 链接仍保留。
			this.reset();
			// 整段已完成，无需逐项遍历。
			return;
		}

		// Parse parameters (can be semicolon-separated)
		// 例如 1;31 分成两个字符串参数，后面按顺序更新状态。
		const parts = params.split(";");
		// 参数数组下标，不是原控制码的码元下标。
		let i = 0;
		// 逐个处理参数；多参数颜色会自行跳过已消费的部分。
		while (i < parts.length) {
			// 十进制转数字；此处不对空段/超范围等再做协议校验，未知结果最终不匹配已知分支。
			const code = Number.parseInt(parts[i], 10);

			// Handle 256-color and RGB codes which consume multiple parameters
			// 38/48 分别引入扩展前景色/背景色，后续数字属于同一颜色指令。
			if (code === 38 || code === 48) {
				// 38;5;N (256 color fg) or 38;2;R;G;B (RGB fg)
				// 48;5;N (256 color bg) or 48;2;R;G;B (RGB bg)
				// 5 代表 256 色，且必须存在下一颜色索引字段才整体消费。
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					// 256 color: 38;5;N or 48;5;N
					// 把三个参数原样保存为一组，未校验索引是否处于 0..255。
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
					// 38 的颜色组应用于前景。
					if (code === 38) {
						// 覆盖当前记录的前景颜色参数。
						this.fgColor = colorCode;
						// 进入本颜色分支的另一个可能值是 48。
					} else {
						// 覆盖当前背景颜色参数。
						this.bgColor = colorCode;
					}
					// 三项已处理，直接移到下一条样式指令。
					i += 3;
					// 跳过下面的单参数 switch，防止颜色索引被误解释成粗体等样式。
					continue;
					// 2 表示 RGB，需要一直有到 B 的第五个参数；这里仅判断字段存在，不检查数值区间。
				} else if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					// RGB color: 38;2;R;G;B or 48;2;R;G;B
					// 保留 38/48;2;R;G;B 整组参数，重新输出时沿用这些文本。
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
					// 按 38/48 区分要更新哪一种颜色。
					if (code === 38) {
						// 把 RGB 组记为当前前景色。
						this.fgColor = colorCode;
						// 48 的 RGB 组属于背景。
					} else {
						// 把 RGB 组记为当前背景色。
						this.bgColor = colorCode;
					}
					// 已消费五项，推进到下一个独立参数。
					i += 5;
					// RGB 参数不再进入普通样式分支。
					continue;
				}
			}

			// Standard SGR codes
			// 按单个 SGR 数字分派；每个 case 的 break 只结束这次 switch，后面的 i++ 继续处理下一参数。
			switch (code) {
				// 0 出现在组合参数里时也要重置此前 SGR 状态，之后的参数仍会继续应用。
				case 0:
					// 复用 reset 清空所有 SGR 字段，仍保留 OSC8 链接。
					this.reset();
					break;
				// SGR 1 开启粗体。
				case 1:
					// 在跟踪器中记录粗体生效。
					this.bold = true;
					break;
				// SGR 2 开启暗淡/弱化。
				case 2:
					// 单独保存 dim，不修改 bold。
					this.dim = true;
					break;
				// SGR 3 开启斜体。
				case 3:
					// 记录斜体状态。
					this.italic = true;
					break;
				// SGR 4 开启下划线。
				case 4:
					// 后续跨行会据此关闭并恢复下划线。
					this.underline = true;
					break;
				// SGR 5 开启闪烁。
				case 5:
					// 记录闪烁状态，具体显示由终端决定。
					this.blink = true;
					break;
				// SGR 7 开启反色。
				case 7:
					// 记录前景/背景反显属性，不互换存储的颜色字符串。
					this.inverse = true;
					break;
				// SGR 8 开启隐藏属性。
				case 8:
					// 只记录属性，不从正文中删除字符。
					this.hidden = true;
					break;
				// SGR 9 开启删除线。
				case 9:
					// 记录删除线，换行时用于防止线条蔓延到填充区。
					this.strikethrough = true;
					break;
				// 这里把 SGR 21 解释为关闭粗体；不同终端可能对它有其他解释。
				case 21:
					// 按项目规则关闭 bold，保留 dim。
					this.bold = false;
					break; // Some terminals
				// SGR 22 关闭粗体和弱化。
				case 22:
					// 先清除粗体标记。
					this.bold = false;
					// 再清除暗淡标记，两个状态都恢复正常。
					this.dim = false;
					break;
				// SGR 23 关闭斜体。
				case 23:
					// 清除 italic 状态。
					this.italic = false;
					break;
				// SGR 24 关闭下划线。
				case 24:
					// 清除 underline，后续换行不再重开它。
					this.underline = false;
					break;
				// SGR 25 关闭闪烁。
				case 25:
					// 清除 blink 状态。
					this.blink = false;
					break;
				// SGR 27 关闭反色。
				case 27:
					// 清除 inverse 状态，保留已记颜色。
					this.inverse = false;
					break;
				// SGR 28 关闭隐藏。
				case 28:
					// 清除 hidden 属性。
					this.hidden = false;
					break;
				// SGR 29 关闭删除线。
				case 29:
					// 清除 strikethrough 属性。
					this.strikethrough = false;
					break;
				// SGR 39 恢复默认前景色。
				case 39:
					// null 表示不需要在下一行重新输出前景色码。
					this.fgColor = null;
					break; // Default fg
				// SGR 49 恢复默认背景色。
				case 49:
					// 背景参数清空，其他样式不受影响。
					this.bgColor = null;
					break; // Default bg
				// 其他数字还可能属于基本颜色，否则保持现状。
				default:
					// Standard foreground colors 30-37, 90-97
					// 30..37 为普通前景色，90..97 为明亮前景色。
					if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
						// 将数字存成参数字符串，供后续统一拼接 SGR。
						this.fgColor = String(code);
					}
					// Standard background colors 40-47, 100-107
					// 40..47 为普通背景色，100..107 为明亮背景色；这是 else if 的续分支。
					else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
						// 将该基本背景颜色参数保存在实例中。
						this.bgColor = String(code);
					}
					// 颜色判断结束；不认识的参数也直接忽略，不修改跟踪状态。
					break;
			}
			// 普通单参数只消费一项，进入下一轮；扩展颜色已经由上面 continue 处理。
			i++;
		}
	}

	// 内部重置所有受支持 SGR 属性，无参数/返回值；修改实例但特意保留 OSC8 链接，例：SGR0 不能代替关闭超链接。
	private reset(): void {
		// 粗体恢复关闭。
		this.bold = false;
		// 暗淡恢复关闭。
		this.dim = false;
		// 斜体恢复关闭。
		this.italic = false;
		// 下划线恢复关闭。
		this.underline = false;
		// 闪烁恢复关闭。
		this.blink = false;
		// 反色恢复关闭。
		this.inverse = false;
		// 隐藏恢复关闭。
		this.hidden = false;
		// 删除线恢复关闭。
		this.strikethrough = false;
		// 前景恢复默认，不再保存显式颜色参数。
		this.fgColor = null;
		// 背景恢复默认，链接对象不在此方法内清空。
		this.bgColor = null;
		// SGR reset does not affect OSC 8 hyperlink state
	}

	/** Clear all state for reuse. */
	// 清空实例供全新文本复用，无参数/返回值；先清 SGR 再关掉记录中的链接，不产生实际终端代码。
	// 例：池化跟踪器处理下一行前调用 clear，避免前一行状态漏入新任务。
	clear(): void {
		// 复用 SGR 字段的重置逻辑。
		this.reset();
		// 额外清除链接状态，这一点比 SGR0 的 reset 更彻底。
		this.activeHyperlink = null;
	}

	// 读取并生成当前所有样式/链接的重开字符串，不改跟踪状态；例：粗体红色可合成一个 SGR，后面接 OSC8 打开码。
	// 未生效的属性不会输出关闭码，因此调用者不能把结果当作“无条件覆盖终端全部旧状态”。
	getActiveCodes(): string {
		// string[] 保存要加入同一条 SGR 的参数，而不是完整控制序列。
		const codes: string[] = [];
		// 粗体开启才追加参数 1。
		if (this.bold) codes.push("1");
		// 暗淡开启才追加参数 2。
		if (this.dim) codes.push("2");
		// 斜体开启才追加参数 3。
		if (this.italic) codes.push("3");
		// 下划线开启才追加参数 4。
		if (this.underline) codes.push("4");
		// 闪烁开启才追加参数 5。
		if (this.blink) codes.push("5");
		// 反色开启才追加参数 7。
		if (this.inverse) codes.push("7");
		// 隐藏开启才追加参数 8。
		if (this.hidden) codes.push("8");
		// 删除线开启才追加参数 9。
		if (this.strikethrough) codes.push("9");
		// 若有显式前景色，把完整颜色参数组也接入同一个列表。
		if (this.fgColor) codes.push(this.fgColor);
		// 同样追加显式背景色，可以同时恢复文字属性与颜色。
		if (this.bgColor) codes.push(this.bgColor);

		// 非空参数以分号连接生成一个 SGR；没有 SGR 属性就从空串开始。
		let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
		// 活动链接是独立于 SGR 的状态。
		if (this.activeHyperlink) {
			// 将其 OSC8 打开代码接在 SGR 之后，保留原参数和结束符。
			result += formatOsc8Hyperlink(this.activeHyperlink);
		}
		// 返回待调用方拼接的字符串，本方法不发送到终端。
		return result;
	}

	// 只生成当前背景色的 SGR 或空串，无输入/副作用；供滚动条覆盖单元时继承背景，而不恢复前景、下划线或链接。
	getActiveBackgroundCode(): string {
		// 有显式背景则套上 ESC[ 和 m，否则用空串表示无需设置背景。
		return this.bgColor ? `\x1b[${this.bgColor}m` : "";
	}

	// 查询跟踪器是否记录任意样式或链接，返回布尔值不修改状态；例：仅有 OSC8 链接也算 true，不表示已实际写入终端。
	hasActiveCodes(): boolean {
		// 一串 || 做“任意条件成立”查询，首个 true 后就短路。
		return (
			// 粗体状态也是活动属性。
			this.bold ||
			// 或存在暗淡状态。
			this.dim ||
			// 或存在斜体状态。
			this.italic ||
			// 或存在下划线状态。
			this.underline ||
			// 或存在闪烁状态。
			this.blink ||
			// 或存在反色状态。
			this.inverse ||
			// 或存在隐藏状态。
			this.hidden ||
			// 或存在删除线状态。
			this.strikethrough ||
			// 非默认前景也算活动状态，使用 !== null 明确判断。
			this.fgColor !== null ||
			// 非默认背景也算活动状态。
			this.bgColor !== null ||
			// 链接打开时同样需要跨行处理，即使没有任何 SGR。
			this.activeHyperlink !== null
		);
	}

	/**
	 * Get reset codes for attributes that need to be turned off at line end.
	 * Underline and strikethrough must be closed to prevent bleeding into padding.
	 * Active OSC 8 hyperlinks must be closed and re-opened on the next line.
	 * Returns empty string if no attributes need closing.
	 */
	// 生成换行前针对下划线、删除线和链接的关闭字符串，不清除实例记录，因此下一行仍能重开。
	// 无参数，返回空串或控制码；例：有背景和下划线时只关下划线，保留背景供后续补白使用，不是完整 SGR 重置。
	getLineEndReset(): string {
		// 累积需要输出的关闭代码。
		let result = "";
		// 只有当前下划线生效时才需要关掉它。
		if (this.underline) {
			// SGR24 仅关闭下划线，不影响背景等其他属性。
			result += "\x1b[24m"; // Underline off only
		}
		// 删除线也要避免继续覆盖到行末填充空格。
		if (this.strikethrough) {
			// 追加 SGR29，只关闭删除线，实例仍记得下一行应恢复。
			result += "\x1b[29m"; // Strikethrough off only, re-opened at line start via getActiveCodes()
		}
		// 如果当前有链接，换行之前先结束其可点击范围。
		if (this.activeHyperlink) {
			// 用原链接的结束符生成关闭代码，下行开始可再由 getActiveCodes 重新打开。
			result += formatOsc8Close(this.activeHyperlink.terminator); // Re-opened at line start via getActiveCodes()
		}
		// 返回待拼入行尾的代码，内部状态保持不变。
		return result;
	}
}

// 按出现顺序把 text 中受支持控制码交给指定 tracker，返回 void 并修改该实例；普通字符不影响记录。
// 例：扫描“红色码→文字→默认色码”后前景记录为默认；此处不创建新 tracker，因此可接续前一行状态。
function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	// 只从 ESC 候选起点检查，跳过普通文字区间。
	let i = text.indexOf("\x1b");
	// 还有 ESC 就继续找下一个有效序列。
	while (i !== -1) {
		// 长度扫描器避免普通文字被当作控制码处理。
		const length = ansiCodeLength(text, i);
		// 只向 tracker 传完整受支持序列。
		if (length > 0) {
			// 截出该序列；process 只更新其支持的 SGR/OSC8 状态，其他序列忽略。
			tracker.process(text.substring(i, i + length));
			// 越过刚处理的序列，维持原始顺序。
			i += length;
			// 未识别 ESC 也必须向后移动，防止无限循环。
		} else {
			// 消费这个候选起点。
			i++;
		}
		// 从新位置找下一处 ESC，直到返回 -1。
		i = text.indexOf("\x1b", i);
	}
}

/** Return only the background color active at the end of an ANSI-styled string. */
// 读取 ANSI 文本末尾生效的背景色，返回 SGR 或空串；创建独立跟踪器，不污染其他调用状态，也不写终端。
// 例：红背景码后有 SGR49，结果是空串；没有关闭背景则返回其代码，供布局覆盖滚动条单元使用。
export function getActiveBackgroundAnsi(text: string): string {
	// 新实例从默认样式、无链接开始。
	const tracker = new AnsiCodeTracker();
	// 按原顺序应用整串控制码，得到最终状态。
	updateTrackerFromText(text, tracker);
	// 仅取背景代码，舍弃其余样式与链接状态。
	return tracker.getActiveBackgroundCode();
}

// 生成器把 Intl 分段结果包装成逐个字符串，输入普通文本、返回 Generator<string>；例：for...of 可逐个取出“界”和组合 emoji。
// function* 表示惰性执行，调用时先得到迭代器，迭代时才进入循环；不修改共享分段器或输入。
function* graphemeSegments(text: string): Generator<string> {
	// 解构出 segment，并用 yield 暂停/产出这个字素；下次迭代继续下一项。
	for (const { segment } of graphemeSegmenter.segment(text)) yield segment;
}

/**
 * Split text into words while keeping ANSI codes attached.
 */
// 把单行文字拆成换行用 token，保留控制码顺序；ASCII 空格连成 space token，普通词连成 word token，CJK 字素可单独断行。
// 返回新数组不改输入；例：“ab 中文”大体分为 ab、空格、中、文，颜色码挂在相邻内容上。本函数没有调用 wordSegmenter 做语言学分词。
function splitIntoTokensWithAnsi(text: string): string[] {
	// 保存已经完成的 token 文本。
	const tokens: string[] = [];
	// 当前尚未提交的 token 缓冲。
	let current = "";
	// 控制码先暂存，等后面的可见字素决定它属于哪个 token。
	let pendingAnsi = ""; // ANSI codes waiting to be attached to next visible content
	// 字面量联合类型区分当前连续 ASCII 空格/其他词/尚无 token，运行时仍是字符串或 null。
	let currentKind: "space" | "word" | null = null;
	// i 是原字符串码元下标。
	let i = 0;

	// 闭包提交当前 token，无参数/返回值；会修改 tokens/current/currentKind，例：从词切换到空格时调用，pendingAnsi 不在这里提交。
	const flushCurrent = (): void => {
		// 空缓冲无需生成空 token。
		if (!current) {
			// 直接结束闭包，不改变 token 列表。
			return;
		}
		// 把已收集文本按顺序放入数组。
		tokens.push(current);
		// 清空缓冲供下一 token 使用。
		current = "";
		// 新 token 还没有确定种类。
		currentKind = null;
	};

	// 扫描输入直到所有控制码和普通片段都处理完。
	while (i < text.length) {
		// 首先尝试整体读取当前位置的控制码。
		const ansiResult = extractAnsiCode(text, i);
		// 有控制码时，暂不把它算进可见 token 边界。
		if (ansiResult) {
			// Hold ANSI codes separately - they'll be attached to the next visible char
			// 等下一可见字素决定代码附着位置，避免样式提前影响上一行。
			pendingAnsi += ansiResult.code;
			// 按序列码元长度越过它。
			i += ansiResult.length;
			// 下一轮可能仍是控制码，可继续积攒。
			continue;
		}

		// Visible text runs up to the next escape sequence.
		// 寻找下一 ESC 候选，先跳过当前位置已知的普通字符。
		let end = text.indexOf("\x1b", i + 1);
		// 不完整/不支持的 ESC 不是片段边界，应继续寻找后面的完整序列。
		while (end !== -1 && ansiCodeLength(text, end) === 0) {
			// 向后查下一个 ESC，直到有效边界或末尾。
			end = text.indexOf("\x1b", end + 1);
		}
		// 没有下一序列时，普通文本延伸到行尾。
		if (end === -1) end = text.length;

		// 截取这一段不含已识别控制码的文本。
		const chunk = text.slice(i, end);
		// Printable ASCII characters are single graphemes, so skip the segmenter for them.
		// 整段可打印 ASCII 时无需 Intl 字素分段。
		const ascii = isPrintableAscii(chunk);
		// 三元表达式选择直接迭代 ASCII 字符串或惰性字素生成器，两者每次都产出一个文本单位。
		for (const segment of ascii ? chunk : graphemeSegments(chunk)) {
			// token 分类只把字面 ASCII 空格作为 space，其他空白仍会由后续 isWhitespaceToken 判断。
			const segmentIsSpace = segment === " ";
			// 非 ASCII 的非空格 CJK 字素单独成 token，允许没有空格的中文/日文等按字素断行。
			if (!ascii && !segmentIsSpace && cjkBreakRegex.test(segment)) {
				// 先提交前面累积的普通词或空格。
				flushCurrent();
				// 把待处理控制码附在当前 CJK 字素之前。
				const token = pendingAnsi + segment;
				// 这些代码已经归属本字素，清空暂存。
				pendingAnsi = "";
				// 直接提交这个可单独断行的 token。
				tokens.push(token);
				// 不再把该字素接回普通词缓冲。
				continue;
			}

			// 其他字素按是不是 ASCII 空格决定本轮种类。
			const segmentKind = segmentIsSpace ? "space" : "word";
			// 当前缓冲非空且种类变化，需要切 token。
			if (current && currentKind !== segmentKind) {
				// 先提交前一个连续词/空格片段。
				flushCurrent();
			}

			// Attach any pending ANSI codes to this visible character
			// 现在确定这个字素要加入 current，可同步附上它前面的控制码。
			if (pendingAnsi) {
				// 控制码排在当前字素之前，保持输入时序。
				current += pendingAnsi;
				// 已消费的暂存代码清空。
				pendingAnsi = "";
			}

			// 更新当前 token 的类别。
			currentKind = segmentKind;
			// 将整个字素加入缓冲，不拆内部码点。
			current += segment;
		}

		// 这个普通区间已完成，回到其后的序列起点。
		i = end;
	}

	// Handle any remaining pending ANSI codes (attach to last token)
	// 输入可能以控制码结束，仍要把它附着在末尾 token，不能丢掉关闭样式。
	if (pendingAnsi) {
		// 还有 current 时优先接在它末尾。
		if (current) {
			// 保留最后的颜色/属性重置等序列。
			current += pendingAnsi;
			// 没有 current 但已有 CJK 等已提交 token 时，归属最后一个 token。
		} else if (tokens.length > 0) {
			// 直接修改 tokens 数组最后一项字符串。
			tokens[tokens.length - 1] += pendingAnsi;
			// 全文只有控制码时，也要保留这些代码。
		} else {
			// 把代码当作最后的 current，后面统一提交。
			current = pendingAnsi;
		}
	}

	// 非空缓冲尚未进入 tokens，需要最后提交。
	if (current) {
		// 加入最后一个 token，可只包含控制码。
		tokens.push(current);
	}

	// 返回保留控制码的换行单位列表。
	return tokens;
}

/**
 * Wrap text with ANSI codes preserved.
 *
 * ONLY does word wrapping - NO padding, NO background colors.
 * Returns lines where each line is <= width visible chars.
 * Active ANSI codes are preserved across line breaks.
 *
 * @param text - Text to wrap (may contain ANSI codes and newlines)
 * @param width - Maximum visible width per line
 * @returns Array of wrapped lines (NOT padded to width)
 */
/**
 * Flatten cached lines. V8 keeps a string built by concatenation as a tree of its parts until something reads it
 * whole, and a cached line kept as such a tree retains several times its own size. Converting a string to a number
 * reads it whole, so V8 flattens it in place; the strings' values do not change.
 */
// 触发 V8 读取每个缓存行的完整内容，意图压平拼接字符串以减少其引用树占用；不改变字符串值，也不替换数组元素。
// 参数 readonly string[] 只限制本函数通过该类型修改数组，运行时不会冻结数组；例：组件 render 缓存结果前调用，返回 void，不输出数值。
export function flattenLines(lines: readonly string[]): void {
	// Number(line) 的转换结果被丢弃，哪怕是 NaN 也不会抛给调用者；这里依赖 V8 字符串实现，不能把节省内存量当跨引擎保证。
	for (const line of lines) Number(line);
}

// 按显示列换行并保留受支持样式/链接，输入可含换行符，返回字符串行数组；不补白、不着背景、不写终端。
// 先按 CRLF/CR/LF 拆逻辑行，再用内部换行器处理，各逻辑行继承之前样式；例：“hello world”宽 5 可分两行，最后一行不做全面样式关闭。
// width 按布局中的正列数使用；没有运行时校验，如果宽度比一个字素还窄，不能保证每行都不超宽，也不能切半个字。
export function wrapTextWithAnsi(text: string, width: number): string[] {
	// 空输入也要代表一行空文本，不能返回零行导致布局高度变化。
	if (!text) {
		// 返回包含一个空串的数组。
		return [""];
	}

	// Handle newlines by processing each line separately
	// Track ANSI state across lines so styles carry over after literal newlines
	// 先匹配 CRLF 整体，再匹配独立 CR/LF，防止一组 CRLF 被拆成两次换行。
	const inputLines = text.split(/\r\n|\r|\n/);
	// 累积所有逻辑行展开后的实际行。
	const result: string[] = [];
	// 跟踪逻辑行之间的原始样式状态，独立于单行内部换行器。
	const tracker = new AnsiCodeTracker();

	// 依次处理每一条逻辑输入行，包括末尾换行产生的空行。
	for (const inputLine of inputLines) {
		// Prepend active ANSI codes from previous lines (except for first line)
		// 第一行不用继承；后续行前面补上上一逻辑行末尾生效的样式/链接重开代码。
		const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
		// 连同继承前缀交给单行换行器，可能产出一行或多行。
		const wrappedLines = wrapSingleLine(prefix + inputLine, width);
		// 逐一取出该逻辑行的实际换行结果。
		for (const wrappedLine of wrappedLines) {
			// 按原顺序并入最终数组。
			result.push(wrappedLine);
		}
		// Update tracker with codes from this line for next iteration
		// 只扫描原输入逻辑行来更新跨行状态；单行算法额外生成的行尾关闭码不应清掉原来的逻辑样式。
		updateTrackerFromText(inputLine, tracker);
	}

	// 返回收集结果，兜底仍保留一行空串。
	return result.length > 0 ? result : [""];
}

// 把不含逻辑换行的一行按 token 宽度拆行，返回不补齐的字符串数组；局部跟踪器记录样式，不修改源串。
// 优先整行直返，再按空白/词/CJK token 放置；长词改为按字素断开，换行边界只关下划线/删除线/链接以保留背景，例：红色长词在续行重新打开红色。
function wrapSingleLine(line: string, width: number): string[] {
	// 空逻辑行仍占一行。
	if (!line) {
		// 返回包含空串的数组，不制造额外样式代码。
		return [""];
	}

	// 先测整行列宽，若本来可放下则无需拆 token。
	const visibleLength = visibleWidth(line);
	// 总宽度未超过容量时保留原串及其尾部空白/控制码。
	if (visibleLength <= width) {
		// 快速返回原行，只有实际换行路径才执行下面的 trimEnd。
		return [line];
	}

	// 保存已经确定完成的输出行。
	const wrapped: string[] = [];
	// 局部跟踪器只用于这条逻辑行的内部换行状态。
	const tracker = new AnsiCodeTracker();
	// 拆出可按词/空格/CJK 字素处理的 token，并保持 ANSI 代码归属。
	const tokens = splitIntoTokensWithAnsi(line);

	// 当前正在拼接的行文本。
	let currentLine = "";
	// 当前行已占用列宽，不包含控制码的码元长度。
	let currentVisibleLength = 0;

	// 依次安排每个 token，不能任意重排正文。
	for (const token of tokens) {
		// 测 token 的可见列宽，不把其中链接载荷计入。
		const tokenVisibleLength = visibleWidth(token);
		// 判断除了控制码是否全是空白，便于换行时丢掉前导/尾随空白。
		const isWhitespace = isWhitespaceToken(token);

		// Token itself is too long - break it character by character
		// 非空白 token 本身就大于整行容量，整词换行仍放不下，要按完整字素再拆。
		if (tokenVisibleLength > width && !isWhitespace) {
			// 已有待完成行时先提交，长词从新行开始。
			if (currentLine) {
				// Trim before adding the reset, which would otherwise block the final trimEnd()
				// 先删当前文本末尾实际空白，再补关闭码；否则代码挡在末尾会使 trimEnd 看不到空白。
				currentLine = currentLine.trimEnd();
				// Add specific reset for underline only (preserves background)
				// 按当前逻辑样式生成行尾局部关闭码，不清空 tracker 状态。
				const lineEndReset = tracker.getLineEndReset();
				// 有需要关闭的线条或链接时才拼接。
				if (lineEndReset) {
					// 保留背景/其他属性，避免全面 reset 抹掉后续补白颜色。
					currentLine += lineEndReset;
				}
				// 把此前的行放入完成列表。
				wrapped.push(currentLine);
				// 为长词清空文本缓冲。
				currentLine = "";
				// 新行计宽从 0 开始。
				currentVisibleLength = 0;
			}

			// Break long token - breakLongWord handles its own resets
			// 长词拆分器复用同一个 tracker，自己处理段尾关闭/段首恢复并更新状态。
			const broken = breakLongWord(token, width, tracker);
			// 除最后一段外，长词拆出的各段已经不能再加后续 token。
			for (let i = 0; i < broken.length - 1; i++) {
				// 直接提交这些段；! 是静态非空断言，循环范围保证该索引存在。
				wrapped.push(broken[i]!);
			}
			// 最后一段仍可以接后面的词/空格，作为 currentLine 留下。
			currentLine = broken[broken.length - 1];
			// 重新测量末段宽度，控制码不占列。
			currentVisibleLength = visibleWidth(currentLine);
			// 该 token 已完成，不再进入普通整词放置分支。
			continue;
		}

		// Check if adding this token would exceed width
		// 预估把整个 token 放在当前行末尾后的总列数。
		const totalNeeded = currentVisibleLength + tokenVisibleLength;

		// 会超宽且当前已有可见文字，才把当前行提交；空行上的特殊情况留给后面处理。
		if (totalNeeded > width && currentVisibleLength > 0) {
			// Trim trailing whitespace, then add underline reset (not full reset, to preserve background)
			// 新建待提交行并去掉实际尾随空白。
			let lineToWrap = currentLine.trimEnd();
			// 边界 token 若是空白，文字可以丢掉，但它携带的样式代码不能丢。
			if (isWhitespace) {
				// The dropped space may carry codes (e.g. closing a styled word). Keep them on the wrapped line so
				// the style ends there and is not re-opened on the next line.
				// 只把这个空白 token 中的控制码接在旧行末，保留关闭粗体/颜色等时序。
				lineToWrap += extractAnsiCodes(token);
				// 先应用空白里携带的关闭码，下一行不应错误地重开已经结束的样式。
				updateTrackerFromText(token, tracker);
			}
			// 在应用完边界代码之后，计算仍需跨行临时关闭的属性/链接。
			const lineEndReset = tracker.getLineEndReset();
			// 仅有关闭码时才追加。
			if (lineEndReset) {
				// 将局部关闭码放在已去尾空白的行末。
				lineToWrap += lineEndReset;
			}
			// 完成旧行，加入输出列表。
			wrapped.push(lineToWrap);
			// 如果导致超宽的是空白，它不应成为下一行的起始文字。
			if (isWhitespace) {
				// Don't start new line with whitespace
				// 下一行只先放仍活动的样式/链接前缀，不放刚丢弃的空白。
				currentLine = tracker.getActiveCodes();
				// 这些控制码不占列，新行仍是 0 列。
				currentVisibleLength = 0;
				// 边界空白已处理并更新 tracker，跳过底部重复更新。
				continue;
			}
			// 非空白 token 整体移到下一行，前面先恢复原行仍活动的样式；token 自带代码随后按原顺序生效。
			currentLine = tracker.getActiveCodes() + token;
			// 新行正文宽度就是这个 token 的宽度。
			currentVisibleLength = tokenVisibleLength;
			// 空白比空行还宽且含代码时，不能只靠最终 trimEnd：末尾代码会挡住空白裁剪。
		} else if (isWhitespace && totalNeeded > width && token.includes("\x1b")) {
			// Whitespace wider than an empty line. Plain spaces are removed by the final trimEnd(), but codes after
			// them (e.g. a trailing reset) would block that and leave the line wider than width. Keep only the codes.
			// 因此只保留该 token 的控制码，舍弃其过长的空白正文，不增加 currentVisibleLength。
			currentLine += extractAnsiCodes(token);
			// 其余 token 可以正常追加；纯空白超宽的尾部会由最后 trimEnd 清掉。
		} else {
			// Add to current line
			// 拼入当前 token，保留其原始控制码顺序。
			currentLine += token;
			// 同步增加当前行的可见宽度。
			currentVisibleLength += tokenVisibleLength;
		}

		// 把刚放置 token 中的控制码依次应用到 tracker，供下次换行继承；没有 I/O。
		updateTrackerFromText(token, tracker);
	}

	// 可能还有最后一行，文本非空也可能只是控制码。
	if (currentLine) {
		// No reset at end of final line - let caller handle it
		// 最终行不额外关闭所有属性，完整重置责任留给上层渲染流程。
		wrapped.push(currentLine);
	}

	// Trailing whitespace can cause lines to exceed the requested width
	// map 回调为每行生成去尾空白的新串；仅去除字符串末尾空白，不会穿过尾部控制码清理中间空格，空结果兜底一行。
	return wrapped.length > 0 ? wrapped.map((line) => line.trimEnd()) : [""];
}

// 导出编辑器使用的一组 ASCII 标点符号；不是 Unicode 全部标点，正则无 g，不会积累 lastIndex 状态。
export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

/**
 * Check if a character is whitespace.
 */
// 检查输入里是否含 JS 空白并返回布尔值，无副作用；按单字符调用时可用于按词移动，例：空格 true、a false。
// 参数类型只是 string，没有运行时限制其长度，多字符字符串只要含任一空白也会为 true。
export function isWhitespaceChar(char: string): boolean {
	// \s 匹配 JS 定义的空白（不只 ASCII 空格），test 返回是否存在匹配。
	return /\s/.test(char);
}

/**
 * Check if a character is punctuation.
 */
// 检查输入是否含上面列出的 ASCII 标点，返回布尔值且不改输入；例：逗号 true，汉字 false。
// 调用者按字符使用，但这里没有要求长度为 1，也不把所有 Unicode 标点归为 true。
export function isPunctuationChar(char: string): boolean {
	// 复用无状态正则执行 test，而非每次新建完整规则。
	return PUNCTUATION_REGEX.test(char);
}

// 把超过行宽的非空白 token 按完整字素拆成多段，并更新传入 tracker；输入为词/容量/可延续样式实例，返回至少一段。
// 先将控制码与字素分离，再逐项装入行，超出时关闭线条/链接并在新段恢复；例：红色 abcdef 宽 3 可分成保留红色的 abc 与 def。
// 不切开单个宽字素，因此容量小于它时可能出现空段和仍超宽的字素段；不保证任意 width 下每段都 <= width，也不会输出到终端。
function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	// 收集完成的分段字符串。
	const lines: string[] = [];
	// 第一段先继承调用者此前的活动样式/链接。
	let currentLine = tracker.getActiveCodes();
	// 继承前缀不占列，初始可见宽度为 0。
	let currentWidth = 0;

	// First, separate ANSI codes from visible content
	// We need to handle ANSI codes specially since they're not graphemes
	// 第一遍扫描位置按原词的 UTF-16 码元计数。
	let i = 0;
	// Array<T> 与 T[] 都表示数组类型；每项 type 区分 ansi/grapheme，value 保存该类文本，这些标注不做运行时校验。
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];

	// 先把整个词解析成控制码与字素项，保持原顺序。
	while (i < word.length) {
		// 当前位置优先尝试读取完整控制码。
		const ansiResult = extractAnsiCode(word, i);
		// 序列整体成为 ansi 项，不允许 Intl 把其参数/URL 当成普通字素。
		if (ansiResult) {
			// 保存判别标记 type 和控制码文本 value。
			segments.push({ type: "ansi", value: ansiResult.code });
			// 跨过完整控制码长度。
			i += ansiResult.length;
			// 不是已识别控制码，就收集后面一段普通文本。
		} else {
			// Find the next ANSI code or end of string
			// 普通区间从当前位置开始。
			let end = i;
			// 逐码元找下个控制码起点或输入末尾。
			while (end < word.length) {
				// 查询当前候选下标的序列。
				const nextAnsi = extractAnsiCode(word, end);
				// 一旦找到完整控制码，普通片段就到此结束。
				if (nextAnsi) break;
				// 其他字符继续向后寻找，这一步不负责字素边界。
				end++;
			}
			// Segment this non-ANSI portion into graphemes
			// 截出完整普通区间，稍后一次性分字素。
			const textPortion = word.slice(i, end);
			// 迭代 Intl 的字素对象。
			for (const seg of graphemeSegmenter.segment(textPortion)) {
				// 每个完整字素成为 grapheme 项，内部组合码点不再拆开。
				segments.push({ type: "grapheme", value: seg.segment });
			}
			// 扫描下标转到下一控制码或词尾。
			i = end;
		}
	}

	// Now process segments
	// 第二遍依次放置已经识别的各项。
	for (const seg of segments) {
		// type 字段告诉本分支 value 是控制码文本。
		if (seg.type === "ansi") {
			// 保留控制码在当前段中的原始位置。
			currentLine += seg.value;
			// 同步更新传入 tracker，后续续行才能恢复最新样式。
			tracker.process(seg.value);
			// 控制码不加宽，直接处理下一项。
			continue;
		}

		// 此分支剩下的是字素项文本。
		const grapheme = seg.value;
		// Skip empty graphemes to avoid issues with string-width calculation
		// 空字素不进入宽度和超宽判断；一般 Intl 分段不会产出空片段。
		if (!grapheme) continue;

		// 局部变量 graphemeWidth 是本次可见宽度数字，与上面的同名内部函数不同，这里调用的是 visibleWidth。
		const graphemeWidth = visibleWidth(grapheme);

		// 当前段放不下整个字素时先提交旧段；不把字素剪成一半。
		if (currentWidth + graphemeWidth > width) {
			// Add specific reset for underline only (preserves background)
			// 生成局部关闭代码，背景等样式仍保持。
			const lineEndReset = tracker.getLineEndReset();
			// 确有待关闭样式/链接时才附加。
			if (lineEndReset) {
				// 把关闭代码加在当前段末尾，tracker 的逻辑状态没有被清空。
				currentLine += lineEndReset;
			}
			// 提交旧段；极窄 width 下，即使旧段没有可见文字也可能提交。
			lines.push(currentLine);
			// 新段恢复 tracker 保存的全部活动样式/链接。
			currentLine = tracker.getActiveCodes();
			// 新段的可见列数重新从 0 开始。
			currentWidth = 0;
		}

		// 整个字素拼入当前段；单个字素本身大于 width 时此处仍会保留它。
		currentLine += grapheme;
		// 累计该字素的估算列宽。
		currentWidth += graphemeWidth;
	}

	// 末段还包含正文或控制码时需要保存。
	if (currentLine) {
		// No reset at end of final segment - caller handles continuation
		// 末段不额外生成关闭码，调用者可能继续追加其他 token。
		lines.push(currentLine);
	}

	// 至少返回一个字符串项，避免调用方取最后一段时没有值。
	return lines.length > 0 ? lines : [""];
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
// 把行补空格到目标宽度后交给 bgFn，返回它的样式字符串；输入为文本、列数和字符串样式回调，不裁掉过长正文。
// 例：abc 目标 5 列先成为“abc  ”再着背景；bgFn 由调用方提供，可能抛错/产生自身副作用，本函数不捕获，也不会自行写终端。
// 回调类型 (text: string) => string 在编译期限定输入输出，运行时不保证它真的只加背景或保持列宽。
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	// 用通用宽度规则计算已有正文列数。
	const visibleLen = visibleWidth(line);
	// 只补欠缺列，正文超过目标时补 0，不执行截断。
	const paddingNeeded = Math.max(0, width - visibleLen);
	// 生成恰好 paddingNeeded 个 ASCII 空格。
	const padding = " ".repeat(paddingNeeded);

	// Apply background to content + padding
	// 把正文与补白一起交给同一个背景处理，避免末尾留出无背景区域。
	const withPadding = line + padding;
	// 同步调用外部样式函数并直接返回结果，错误沿调用栈传播。
	return bgFn(withPadding);
}

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis string to append when truncating (default: "...")
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
// 保留正文的连续前缀，使省略号与正文合计不超目标列；返回新串，原文能放下则保持原文，pad 可补齐列数。
// 先处理非正宽/空串/省略号过宽/ASCII，再按字素扫描；例：“笑脸 emoji + 界a”限 4 列、省略号“…”时，不能跳过装不下的宽字再保留后面的 a。
// 实际截断时关闭前缀链接、重置样式并加省略号；未截断时不自动修复原串未闭合样式，不向终端输出，列数按正常整数布局参数使用。
export function truncateToWidth(
	// 待处理文本，可含本文件支持的控制码以及固定计 3 列的 tab。
	text: string,
	// 目标总显示列数，包括省略号；<=0 返回空串。
	maxWidth: number,
	// 省略号默认为三个 ASCII 点，也可以传空串、Unicode 或带样式文本。
	ellipsis: string = "...",
	// pad 默认 false；true 时在结果末尾补空格到目标估算列数。
	pad: boolean = false,
	// 返回字符串，不返回是否发生截断的单独标记。
): string {
	// 容量不大于 0 时不能保留正文或省略号。
	if (maxWidth <= 0) {
		// 直接给出空结果，忽略 pad。
		return "";
	}

	// 空正文不需要省略号。
	if (text.length === 0) {
		// pad 打开则生成目标数量的空格，否则原样为空。
		return pad ? " ".repeat(maxWidth) : "";
	}

	// 先测省略号可见列宽，样式码本身不占预算。
	const ellipsisWidth = visibleWidth(ellipsis);
	// 省略号已大到占满或超过容量，需要特别处理，不能算出负的正文预算。
	if (ellipsisWidth >= maxWidth) {
		// 这条分支仍先确认正文是否本来可完整容纳。
		const textWidth = visibleWidth(text);
		// 正文能放下就无需省略号，即使省略号本身很宽。
		if (textWidth <= maxWidth) {
			// 保留完整原文，并按需补空格，不添加样式重置。
			return pad ? text + " ".repeat(maxWidth - textWidth) : text;
		}

		// 正文确实超宽时，只取省略号本身能容纳的完整前缀。
		const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
		// 省略号首个宽字素都放不下时可能得到 0 列。
		if (clippedEllipsis.width === 0) {
			// 这时不显示正文/省略号，pad 决定是否用空格占满。
			return pad ? " ".repeat(maxWidth) : "";
		}
		// 正文为空前缀，只有裁短后的省略号；仍用统一的样式重置和补齐逻辑。
		return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
	}

	// 普通 ASCII 可以直接用 length 和 slice，而不用分字素。
	if (isPrintableAscii(text)) {
		// 总长度未超容量就无须截断。
		if (text.length <= maxWidth) {
			// 按需补空格并保留原文，不额外重置样式。
			return pad ? text + " ".repeat(maxWidth - text.length) : text;
		}
		// 预留省略号宽度后才是可放正文的预算。
		const targetWidth = maxWidth - ellipsisWidth;
		// 取 ASCII 连续前缀，再统一关闭链接/样式、加入省略号和可选补白。
		return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad);
	}

	// 普通非 ASCII 路径同样先为省略号预留列数；后面仍要确认是否真的需要它。
	const targetWidth = maxWidth - ellipsisWidth;
	// 收集在预留预算内能保留的正文前缀。
	let result = "";
	// 保存尚未附着到保留字素的控制码，不贸然写入结果。
	let pendingAnsi = "";
	// 目前已扫描正文的总列数，可超过保留预算，用来确认整篇是否超 maxWidth。
	let visibleSoFar = 0;
	// 已经选入 result 的列数，可能小于 targetWidth（不能切半个宽字）。
	let keptWidth = 0;
	// 一旦有一个字素放不下，后续都不再选入前缀，确保不会跳字。
	let keepContiguousPrefix = true;
	// 标记是否已证明整段正文超出 maxWidth，和“预留预算放不下”是两回事。
	let overflowed = false;
	// 标记扫描是否真正到达输入末尾，以区分提前退出与完整扫描。
	let exhaustedInput = false;
	// 是否含 ESC，决定是否要保护控制码载荷。
	const hasAnsi = text.includes("\x1b");
	// 是否含 tab，它要独立按 3 列处理。
	const hasTabs = text.includes("\t");

	// 没有 ESC/tab 时，可直接对整串分字素，不必逐段拆控制码。
	if (!hasAnsi && !hasTabs) {
		// 逐字素迭代，保持 emoji/组合标记完整。
		for (const { segment } of graphemeSegmenter.segment(text)) {
			// 同一套字素列宽规则供保留预算和总宽度两本账使用。
			const width = graphemeWidth(segment);
			// 只有尚未遇到缺口、且整个字素能进入预留预算时才继续收集。
			if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
				// 拼入完整字素到候选前缀。
				result += segment;
				// 更新候选前缀宽度。
				keptWidth += width;
				// 字素放不下，或此前已经放不下过，后续都不再保留。
			} else {
				// 永久关闭本次扫描的前缀收集开关。
				keepContiguousPrefix = false;
			}
			// 即使不再保留，也要继续计算实际总宽度，以免误把本来能放下的文本截短。
			visibleSoFar += width;
			// 只要实际宽度超过 maxWidth，就已经可以确认需要截断。
			if (visibleSoFar > maxWidth) {
				// 记录确实超限。
				overflowed = true;
				// 停止遍历巨大后缀，避免为截取前缀扫描全文。
				break;
			}
		}
		// 若没超限，循环自然读到了末尾；这时可返回原文而非预留省略号的候选前缀。
		exhaustedInput = !overflowed;
		// 有 ESC 或 tab 时需要按序列/普通字素区间扫描。
	} else {
		// 本分支的源字符串码元下标。
		let i = 0;
		// 未到字符串末尾时继续解析。
		while (i < text.length) {
			// 优先读取完整的受支持控制码。
			const ansi = extractAnsiCode(text, i);
			// 控制码不占列，但它们应只附到实际保留的后续正文上。
			if (ansi) {
				// 积攒控制码，尚不确定是否能保留下一字素。
				pendingAnsi += ansi.code;
				// 跳过整段控制码载荷。
				i += ansi.length;
				// 继续处理后续序列或文字。
				continue;
			}

			// tab 在扫描中独立作为一个固定宽度单位。
			if (text[i] === "\t") {
				// 只在连续前缀开关仍开且再加 3 列能放下时保留。
				if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
					// 准备保留 tab 才提交其前面的控制码。
					if (pendingAnsi) {
						// 先把控制码加入正文，顺序与原文一致。
						result += pendingAnsi;
						// 清空已经写入的代码缓存。
						pendingAnsi = "";
					}
					// 保留原 tab 字符，真正发终端前由正规化函数展开。
					result += "\t";
					// 已保留前缀的列宽增加 3。
					keptWidth += 3;
					// 这个 tab 放不下，连续前缀只能到此为止。
				} else {
					// 禁止后续再捡起较窄字素，保持连续性。
					keepContiguousPrefix = false;
					// 不保留与被丢弃 tab 关联的待处理控制码。
					pendingAnsi = "";
				}
				// 总扫描宽度仍计入这个 tab，用于决定是否真的超整行容量。
				visibleSoFar += 3;
				// 超过 maxWidth 就已经证明正文需要截断。
				if (visibleSoFar > maxWidth) {
					// 置为真实超限状态。
					overflowed = true;
					// 提前结束慢路径扫描，后续内容不必全读。
					break;
				}
				// 没超限时才移动到 tab 后一个码元。
				i++;
				// 重新进入序列识别，不把后续文字误并入 tab。
				continue;
			}

			// 寻找一段不含 tab 和已识别控制码的普通文字。
			let end = i;
			// 到 tab 或行尾先停止；控制码边界在循环体内判断。
			while (end < text.length && text[end] !== "\t") {
				// 当前位置有完整序列时，应留给主循环处理。
				const nextAnsi = extractAnsiCode(text, end);
				// 检测到控制码边界。
				if (nextAnsi) {
					// 结束普通片段的寻找。
					break;
				}
				// 继续向后查找码元边界，此处尚不计算宽度。
				end++;
			}

			// 将普通片段按完整字素切分，不能按码元直接截断 Unicode 文本。
			for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
				// 算出当前字素占几列。
				const width = graphemeWidth(segment);
				// 必须没有此前缺口且完整字素能放入剩余预算。
				if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
					// 保留这个字素时，才把之前积攒的控制码一并提交。
					if (pendingAnsi) {
						// 将其样式/链接前缀按顺序写入结果。
						result += pendingAnsi;
						// 清空已经消费的代码缓存。
						pendingAnsi = "";
					}
					// 拼入整个候选字素。
					result += segment;
					// 更新 result 的实际列宽。
					keptWidth += width;
					// 放不下或此前已结束连续前缀时，此字素不进入 result。
				} else {
					// 收集开关一旦关闭，不会被之后的窄字符重新打开。
					keepContiguousPrefix = false;
					// 丢弃这段未被保留内容关联的待处理控制码。
					pendingAnsi = "";
				}

				// 总扫描列数依然包括未保留字素。
				visibleSoFar += width;
				// 扫描总宽度一旦超过 maxWidth，就不必再扫描剩余正文。
				if (visibleSoFar > maxWidth) {
					// 记录正文确实超限。
					overflowed = true;
					// 先结束片段内字素循环。
					break;
				}
			}
			// 如果内部已经证明确需截断，外层也不能继续扫描。
			if (overflowed) {
				// 跳出整个慢路径 while。
				break;
			}
			// 该普通片段全部处理完，把源下标推进到其终点。
			i = end;
		}
		// 未提前超限时，下标应到输入尾部；此标记与 overflowed 一起判断能否原样返回。
		exhaustedInput = i >= text.length;
	}

	// 扫描到末尾且没实际超行宽，省略号其实不需要。
	if (!overflowed && exhaustedInput) {
		// 丢掉临时候选结果，保留完整原串，按实际总宽度可选补白；不添加额外关闭样式码。
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
	}

	// 真正超宽时才使用候选连续前缀，统一关闭正文链接/样式、拼省略号并按需补空格。
	return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
// 按终端列截取 line 的 [startCol,startCol+length) 区域，只返回文本，内部由 sliceWithWidth 实现；不修改原串，不补白或自动重置样式。
// 例：“a界b”从 1 取 1 列，strict=true 会排除放不下的“界”，false 则保留完整“界”而可能超过请求列数；跨越左边界且起点在左边的字素始终跳过。
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	// 转发全部参数并只取对象的 text 字段；调用者若还需实际列宽应直接用 sliceWithWidth。
	return sliceWithWidth(line, startCol, length, strict).text;
}

/** Like sliceByColumn but also returns the actual visible width of the result. */
// 按列取片段并返回 {text,width}，输入原行、起列、列数和右边界严格开关；从头扫描以保留之前出现的控制码时序，无终端 I/O。
// 起点落在宽字内部时丢弃该完整字素，不返回半个字；strict 只决定右端能否越界。返回宽度可能小于目标（或非 strict 时大于目标），例：汉字 2 列装不进 1 列严格区间会被排除。
// 保留此前积攒的原始控制码，不只 SGR，也不自动关闭结果末尾链接/颜色；上层负责与其他片段组合时的重置。
export function sliceWithWidth(
	// 可含 ANSI/OSC/APC 的原始行字符串。
	line: string,
	// 左闭起始显示列，按正常布局中的非负整数使用，类型本身没有运行时范围校验。
	startCol: number,
	// 请求的列数，不是源字符串码元数量。
	length: number,
	// 默认允许起点在区间内的字素越过右边界；true 要求整个字素都不超右端。
	strict = false,
	// text 是保留的原始片段加必要前置代码，width 是已保留字素列宽之和。
): { text: string; width: number } {
	// 没有正长度就立即返回空片段，不进行源文本扫描。
	if (length <= 0) return { text: "", width: 0 };
	// 右边界不包含 endCol 这一列。
	const endCol = startCol + length;
	// 同一条 let 用逗号声明多个局部变量：result 是累积的结果字符串。
	let result = "",
		// 记录已保留正文的实际列数。
		resultWidth = 0,
		// 源文本当前字素起点的显示列坐标，从 0 起。
		currentCol = 0,
		// 源字符串的 UTF-16 扫描下标。
		i = 0,
		// 暂存区间之前出现的控制码，保持原始顺序，直到有结果内容需要它们。
		pendingAnsi = "";

	// 从行头扫描，可正确保留在 startCol 之前开始的样式/链接。
	while (i < line.length) {
		// 先检查当前位置完整的受支持控制码。
		const ansi = extractAnsiCode(line, i);
		// 序列不推进显示列，但可能进入结果或暂存区。
		if (ansi) {
			// 当前显示列在目标区间内，代码应跟在已经积攒的前置代码之后。
			if (currentCol >= startCol && currentCol < endCol) {
				// Keep original order: codes from before the range must precede codes at the boundary
				// 先写区间之前的 pendingAnsi，再写边界处当前代码，避免如“绿色→默认色”次序颠倒。
				result += pendingAnsi + ansi.code;
				// 已输出的前置代码清空，不在下一字素重复添加。
				pendingAnsi = "";
				// 还没到左边界时先积攒所有已识别控制码；到右边界之外则不加入。
			} else if (currentCol < startCol) pendingAnsi += ansi.code;
			// 越过该序列全部码元。
			i += ansi.length;
			// 回到循环识别后续序列或正文，列坐标不变。
			continue;
		}

		// 寻找接下来一段可按字素处理的普通文字。
		let textEnd = i;
		// 扩展至下一个受支持控制码或行尾，不在控制码载荷中分字素。
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		// 对这段普通文字按 Intl 字素边界迭代。
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			// 得到整个字素的终端列宽。
			const w = graphemeWidth(segment);
			// 只看字素起点是否位于目标区间，跨越左边界的前一个宽字素不会被算进来。
			const inRange = currentCol >= startCol && currentCol < endCol;
			// 非 strict 直接允许；strict 时还要求字素末端不超右边界。
			const fits = !strict || currentCol + w <= endCol;
			// 两个条件同时成立才保留整个字素。
			if (inRange && fits) {
				// 首次需要正文而还留有区间之前的控制码时先提交它们。
				if (pendingAnsi) {
					// 前置控制码按原顺序放在保留字素前面。
					result += pendingAnsi;
					// 清空已提交的 pending 缓冲。
					pendingAnsi = "";
				}
				// 追加完整字素原文，不分割 emoji/组合字符。
				result += segment;
				// 只对实际保留的字素累加返回宽度。
				resultWidth += w;
			}
			// 无论是否保留，都要按原字素推进源行显示列。
			currentCol += w;
			// 达到右边界即可停掉片段内循环，不再为无关后缀分段。
			if (currentCol >= endCol) break;
		}
		// 普通片段扫描下标推进到其终点；若已够列宽，外层随后也会退出。
		i = textEnd;
		// 整段目标列已经处理完，停止扫描后续控制码和文字。
		if (currentCol >= endCol) break;
	}
	// 返回文本与实际保留宽度；缺口不补空格，也不为丢掉的左半宽字平移坐标。
	return { text: result, width: resultWidth };
}

// Pooled tracker instance for extractSegments (avoids allocation per call)
// 模块级复用一个样式跟踪器，减少覆盖层每次取两段时的对象分配；extractSegments 每次先 clear，再同步扫描，不向外暴露实例。
const pooledStyleTracker = new AnsiCodeTracker();

/**
 * Extract "before" and "after" segments from a line in a single pass.
 * Used for overlay compositing where we need content before and after the overlay region.
 * Preserves styling from before the overlay that should affect content after it.
 */
// 一次扫描同时取覆盖区左边 before 与右边 after，返回两段文本及各自实际宽度，不改原行或输出终端。
// 左段要求字素完整落在 beforeEnd 之前；右段按 afterStart/afterLen 取，首次保留正文时重建该处仍生效的样式/链接，包括被覆盖区里发生的变化。
// 例：“abcd让EFGH”在“让”中间开覆盖层时，左段不能留下半个“让”，调用方 compositeTuiLine 再补空格定位；本函数自身不补齐缺列。
export function extractSegments(
	// 原始行，可包含样式、超链接和 APC 标记。
	line: string,
	// 左段的排他终列，before 从原行第 0 列开始保留。
	beforeEnd: number,
	// 右段的包含起列；起点跨在宽字内部时该字素不会从中间切出来。
	afterStart: number,
	// 右段请求列数，<=0 时只需要收集 before。
	afterLen: number,
	// 右段默认允许完整字素越过右端，true 则排除越界字素；左段始终要求完整放下。
	strictAfter = false,
	// 四字段对象分别提供两个片段及其实际列数，供覆盖层计算补白。
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
	// 左段字符串缓冲，逗号继续声明同一条 let 的其他变量。
	let before = "",
		// 左段已保留的实际列宽。
		beforeWidth = 0,
		// 右段字符串缓冲。
		after = "",
		// 右段已保留的实际列宽。
		afterWidth = 0;
	// 当前源字素起点的终端列坐标。
	let currentCol = 0,
		// 原字符串扫描下标，与 currentCol 的单位不同。
		i = 0;
	// 暂存属于左段、还没跟随保留字素写出的控制码。
	let pendingAnsiBefore = "";
	// 记录是否已经开始保留右段正文，避免反复重建继承样式。
	let afterStarted = false;
	// 右段排他终列。
	const afterEnd = afterStart + afterLen;

	// Track styling state so "after" inherits styling from before the overlay
	// 先清空池化对象的 SGR 和链接状态，不能继承上一次独立调用的结果。
	pooledStyleTracker.clear();

	// 逐个控制码/普通片段同步扫描，没有 await 或外部回调插入。
	while (i < line.length) {
		// 优先识别整段受支持控制序列。
		const ansi = extractAnsiCode(line, i);
		// 控制码既可能改变继承状态，也可能需要原样留在结果。
		if (ansi) {
			// Track all SGR codes to know styling state at afterStart
			// 扫描到的所有代码都交给 tracker；它实际只理解其支持的 SGR/OSC8，其余忽略，覆盖区里的样式变化也会被记录。
			pooledStyleTracker.process(ansi.code);
			// Include ANSI codes in their respective segments
			// 控制码当前列在左段终点之前时，先留给左段。
			if (currentCol < beforeEnd) {
				// 等待下一保留字素再提交，不立即输出可能落在被删除宽字之前的代码。
				pendingAnsiBefore += ansi.code;
				// 否则考虑是否属于右段；三个条件共同限制何时可以直接保留原代码。
			} else if (
				// 控制码位置不能在右段起点之前。
				currentCol >= afterStart &&
				// 也不能已经达到右段终点。
				currentCol < afterEnd &&
				// 右段正文已开始后保留原代码；尚未开始也保留 APC，因为 cursor marker 不是 tracker 可重建的样式。
				(afterStarted || ansi.code.startsWith("\x1b_"))
			) {
				// SGR codes are only included after "after" started (styling already prepended). Zero-width APC
				// markers like CURSOR_MARKER are not tracked styling, so keep them at the boundary too.
				// 将本次序列按原顺序附到右段，普通 SGR 在首次正文前将由 tracker 重建而非重复拷贝。
				after += ansi.code;
			}
			// 越过整段序列，显示列不变。
			i += ansi.length;
			// 继续处理后面的控制码或正文。
			continue;
		}

		// 确定接下来一段普通文字的范围。
		let textEnd = i;
		// 从当前下标扫到下一个完整序列或行尾。
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		// 按字素处理片段，保持宽字符/emoji 的完整性。
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			// 测量当前字素占用列数。
			const w = graphemeWidth(segment);

			// 字素起点在左段且终点也不越 beforeEnd 时才保留，左侧总是严格边界。
			if (currentCol < beforeEnd && currentCol + w <= beforeEnd) {
				// 左段正文要保留时，才提交其前面暂存的控制码。
				if (pendingAnsiBefore) {
					// 保持代码先于对应字素的原始顺序。
					before += pendingAnsiBefore;
					// 清掉已经写入左段的暂存代码。
					pendingAnsiBefore = "";
				}
				// 保留完整左侧字素。
				before += segment;
				// 增加左段实际宽度，没放下的宽字不会被算入。
				beforeWidth += w;
				// 不属于左段时，字素起点还可能落在右段区间；两段若重叠，左段判断优先。
			} else if (currentCol >= afterStart && currentCol < afterEnd) {
				// strictAfter 开启时，右段字素也必须整个放得下；关闭时允许越过右边界。
				const fits = !strictAfter || currentCol + w <= afterEnd;
				// 满足右端要求才进入保留分支。
				if (fits) {
					// On first "after" grapheme, prepend inherited styling from before overlay
					// 第一次保留右段正文时，需要把截至当前位置的活动样式/链接恢复出来。
					if (!afterStarted) {
						// 重建生效状态而非复制被覆盖区的文字/全部控制码，维持右侧原有外观。
						after += pooledStyleTracker.getActiveCodes();
						// 后续正文不再重复添加继承前缀。
						afterStarted = true;
					}
					// 追加完整的右侧字素。
					after += segment;
					// 累计右段实际保留列宽。
					afterWidth += w;
				}
			}

			// 无论该字素落在左段/覆盖区/右段，都推进原行的显示列坐标。
			currentCol += w;
			// Early exit: done with "before" only, or done with both segments
			// 三元条件区分“只要左段”和“两段都要”：达到对应终列即可停止字素扫描，避免遍历无关尾部。
			if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
		}
		// 本段普通文字结束，转到下个序列边界；如果已达目标，下面会退出外层。
		i = textEnd;
		// 与内层使用同一停止条件，完成后不继续解析行尾的序列。
		if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd) break;
	}

	// 返回两段及宽度；上层据宽度补空格并在覆盖区两侧重置样式，池化 tracker 下次调用会重新清空。
	return { before, beforeWidth, after, afterWidth };
}
