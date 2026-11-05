// 将顶层 Mermaid 代码块变成终端 Unicode 图形；这是 Markdown 显示转换，原消息与模型输入保持原文。
// Marked 是运行时 Markdown 分词器；Token 只描述解析结果的静态类型。
import { Marked, type Token } from "@earendil-works/pi-tui";
// render 同步生成字符图或 null；MermaidArt/Span 是该库的结果类型，不是浏览器 Mermaid 渲染器。
import { type MermaidArt, render, type Span } from "grok-mermaid";
// 转换器类型约定输入正文与显示上下文，输出字符串。
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
// 复用 off/final/streaming 设置类型，类型导入不会读取设置文件。
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
// 主题只用于把图形语义片段转成 ANSI 样式，不改变图形结构。
import type { Theme } from "../theme/theme.ts";

// 模块内复用一个默认解析器；实际正文在调用转换器时才 lexer。
const markdownParser = new Marked();

// 工厂选项接口，声明自身不安装转换器，也不运行图形排版。
interface MermaidTransformerOptions {
	// 动态读取当前模式的函数，每次转换重新调用，设置变化无需重建闭包。
	getMode: () => MermaidRenderingMode;
	// 可省略主题；没有时直接使用库给的无色 plain 行。
	theme?: Theme;
}

// 判断一个顶层 token 是否为 Mermaid 代码，返回类型谓词以便 TS 读取 text/lang。
// 例代码语言为 " MERMAID extra" 也匹配首词；只识别语言标签，不校验图形语法，无副作用。
function isMermaid(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	// 先检查 code，再可选读取 lang：去首尾空白、按空白取首词并转小写；缺语言得到 undefined，不匹配。
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

// 把图形的一行包装成 Markdown 行内代码，返回保留空格/框线的文字；例空行用 NBSP 保持可见高度。
// 按内容里最长反引号串选择更长围栏，边缘是反引号则补间隔；不修改输入、不写终端，超大分配等错误会传播。
function codeSpan(line: string): string {
	// Encode each diagram row as inline code (` ... `) so Markdown preserves its spacing and
	// box-drawing characters. Use a non-breaking space for blank rows because an
	// empty code span has no visible height.
	// 空字符串换为不换行空格 U+00A0；非空字符串原样保留。
	const content = line || "\u00a0";
	// CommonMark code spans use matching backtick delimiters, so choose one
	// longer than any backtick run in the content (``hel`lo`` -> <code>hel`lo</code>).
	// If the content starts or ends with a backtick, separating it from the
	// delimiter with a space keeps that backtick as content; CommonMark removes
	// the padding when rendering (`` `edge` `` -> <code>`edge`</code>).
	// Mermaid labels can preserve backticks, for example:
	//   `┌──────────────┐    ┌──────────────┐`
	// ```│ plain ` tick ├───▶│ two `` ticks │```
	//   `└──────────────┘    └──────────────┘`
	// matchAll 找全部连续反引号，Array.from 映射其长度，展开后取最大；额外 0 处理没有匹配的情况。
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	// 围栏长度比内容里的最长连续反引号多 1，避免提前结束代码片段。
	const fence = "`".repeat(longestBacktickRun + 1);
	// 内容任一端是反引号时两边补空格，避免内容与围栏连成更长一串。
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	// 模板插值拼出围栏/可选间隔/正文；之后 Markdown 解析会去掉必要的边缘间隔。
	return `${fence}${padding}${content}${padding}${fence}`;
}

// 将一段字符图按语义类别套主题颜色并返回字符串；例如 edge 连接线用 accent，title 额外加粗。
// span.cls 由库的字符串字面量联合限定，没有运行时默认兜底；主题回调若抛错会传播。
function styleSpan(span: Span, theme: Theme): string {
	// 按库声明的六类片段分派，不重新判断文字形状。
	switch (span.cls) {
		// 节点框/分隔线等边框类别。
		case "border":
			// 边框使用弱化边框色。
			return theme.fg("borderMuted", span.text);
		// 节点等普通标签文字。
		case "text":
			// 使用普通正文前景色。
			return theme.fg("text", span.text);
		// 连接线和箭头。
		case "edge":
			// 使用强调色；title 分支也用同一颜色，但会先加粗。
			return theme.fg("accent", span.text);
		// 放在连接线上的说明文字。
		case "edgeLabel":
			// 使用弱化文字色。
			return theme.fg("muted", span.text);
		// 库的标题片段类别。
		case "title":
			// 先加粗再套强调前景色。
			return theme.fg("accent", theme.bold(span.text));
		// 空白填充等无语义片段。
		case "none":
			// 保持原文字，不加颜色。
			return span.text;
	}
}

// 把二维语义片段数组转成带样式的逐行字符串；例一行先有边框再有标签，就依顺序拼接。
// 不重排图形、不写终端；主题错误直接传播，返回新字符串数组。
function themedLines(art: MermaidArt, theme: Theme): string[] {
	// 外层 map 遍历行，内层 map 逐片段着色，join("") 保持原同行间距。
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

/** Create a transformer that replaces top-level Mermaid code blocks with Unicode terminal diagrams. */
// 创建同步显示转换器：先按模式跳过，再解析顶层代码块→尝试排图→检查宽度/警告→编码成 Markdown 行。
// 例 flowchart 的 A-->B 可显示框线；不支持/超宽时保留代码，最终有解析警告时保留代码并附首条警告。
// 创建仅保存 options 引用；实际 getMode/解析/主题异常可能抛出，接入通用转换链后会由该链保留原显示。
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	// 返回闭包接收每次正文和显示上下文；同样可处理用户正文，只有下面条件特定跳过。
	return (markdown, context) => {
		// 调用当前设置读取器，未在工厂构造时缓存模式。
		const mode = options.getMode();
		// 以下任一条件成立就跳过绘图，不调用 lexer 或 render。
		if (
			// 模式关闭则直接保留原文。
			mode === "off" ||
			// 助手思考块始终不转图形。
			context.messageType === "assistant-thinking" ||
			// 流式显示仅在 streaming 模式绘图；final 模式等流结束后再尝试。
			(context.isStreaming && mode !== "streaming")
		) {
			// 直接返回同一原文字符串，不生成占位图。
			return markdown;
		}

		// 进入可绘图路径，最后返回重新拼接的 Markdown。
		return (
			markdownParser
				// 解析顶层 token 列表；不递归遍历引用块/列表等孩子中的嵌套代码。
				.lexer(markdown)
				// 每个顶层 token 返回原 raw 或替代图形文字，保持原顺序。
				.map((token) => {
					// 非 Mermaid token 原样还原，不改普通代码/正文。
					if (!isMermaid(token)) return token.raw;
					// 让 grok-mermaid 按支持的语法尽力排图；语法不支持/无法成图等返回 null，部分解析可带 warnings。
					const art = render(token.text);
					// 没有图或最宽行超过可用显示列数时保留代码；不是按字符串 length 判断宽度，也不缩放图形。
					if (!art || art.width > context.availableWidth) return token.raw;
					// 最终显示不能把已丢语法的部分图当完整图，因此有警告则保留原代码；流式中暂允许不完整图。
					if (!context.isStreaming && art.warnings.length > 0) {
						// 多条警告只计其余条数，不把所有警告全文拼出。
						const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
						// 用首条警告与剩余数量组成显示说明。
						const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
						// 提供主题才给警告着色，否则保留普通字符串。
						const styledWarning = options.theme ? options.theme.fg("warning", warning) : warning;
						// 原代码之后加警告代码片段及 Markdown 强制换行；这里只检查图宽，没有再次裁警告文字。
						return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
					}
					// 可选主题决定使用逐片段着色行还是库的无色行。
					const lines = options.theme ? themedLines(art, options.theme) : art.plain;
					// Markdown hard breaks keep every diagram row on its own line.
					// 每行包装行内代码，两空格+换行是 Markdown 硬换行，保证图形各行不被合并。
					return `${lines.map(codeSpan).join("  \n")}\n`;
				})
				// 顶层 token 的结果直接拼接；它们各自 raw/替代文字已携带必要换行。
				.join("")
		);
	};
}
