// 用真实 Markdown/Mermaid 转换器产生字符串再断言；不启动终端或浏览器，不改变原消息。
import { describe, expect, it } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

// 测试辅助配置，? 表示每项可缺省；接口本身不执行校验或提供默认值。
interface TransformOptions {
	// maxWidth 是允许的显示列宽；isStreaming 指消息是否仍在输出。
	maxWidth?: number;
	isStreaming?: boolean;
	// 索引访问类型从 MarkdownTransformContext 取 messageType 的类型，避免重复声明联合。
	messageType?: MarkdownTransformContext["messageType"];
	// mode 复用产品的 off/final/streaming 字面量联合；theme 可提供着色替身。
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

// 接收 Markdown 和可选测试选项，构造转换器后同步返回转换结果；不写终端或磁盘。
// 例：未指定选项时按宽 100、已结束的助手消息转换；底层解析/主题异常直接传播。
function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	// 每次调用创建新的转换器闭包，下面传入动态模式读取函数和可选主题。
	const transformer = createMermaidMarkdownTransformer({
		// 无参箭头回调按需读取 mode；?? 只在 null/undefined 时选择 streaming。
		getMode: () => options.mode ?? "streaming",
		// theme 属性来自输入选项，不构造完整全局主题。
		theme: options.theme,
	});
	// 立即调用工厂返回的函数；第二参数对象提供此次显示上下文。
	return transformer(markdown, {
		// 把测试 maxWidth 映射成真实上下文的 availableWidth，缺省为 100。
		availableWidth: options.maxWidth ?? 100,
		// 缺省表示最终正文，显式 true 才模拟尚在流式传输。
		isStreaming: options.isStreaming ?? false,
		// 缺省是助手正文；assistant-thinking 会命中跳过绘图的分支。
		messageType: options.messageType ?? "assistant",
	});
}

// describe 注册各字符串回归用例；it 的无参回调产生结果，expect 不满足时抛测试错误。
describe("Mermaid rendering", () => {
	// 例：两节点流程图替代代码围栏，前后普通文字保留；仅断言列出的片段。
	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		// 构造带前文、代码块和后文的固定 Markdown；\n 是字符串中的实际换行。
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		// 同步运行辅助函数，获得供后续 Markdown 渲染的字符图文字。
		const rendered = transformMermaid(markdown);

		// 要求前文保留，下面依次检查上框、连线标签和底框/后文衔接。
		expect(rendered).toContain("Before");
		// 上框必须出现，不要求此子串在结果中的唯一性。
		expect(rendered).toContain("┌───────┐");
		// 两个节点与向右箭头必须以这个空格布局出现。
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		// 要求最后一行行内代码反引号后紧接换行和 After。
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		// 否定断言要求原 mermaid 围栏消失。
		expect(rendered).not.toContain("```mermaid");
		// 后文也必须保留，未逐字符比较整个结果。
		expect(rendered).toContain("After");
	});

	// 例：不支持的饼图或宽度限制为 10 的流程图应返回原文，不尝试缩小字符图。
	it("leaves unsupported and oversized diagrams unchanged", () => {
		// pie 是这里刻意选择的未支持图类。
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		// 另一份合法图用于只改变可用宽度，隔离超宽回退路径。
		const oversized = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		// 严格比较输入和输出，验证不支持图类没有被重写。
		expect(transformMermaid(unsupported)).toBe(unsupported);
		// 向辅助函数传局部选项，只覆盖宽度；图过宽时应原样回退。
		expect(transformMermaid(oversized, { maxWidth: 10 })).toBe(oversized);
	});

	// 例：用标签字符串模拟 Theme 颜色输出，要求图里出现边框和强调语义；不验证 ANSI 终端色。
	it("maps semantic spans through the Pi theme", () => {
		// 仅构造转换器会用到的主题方法，缺少 Theme 的其他成员。
		const theme = {
			// fg 回调接收色槽和文字，模板插值返回易于断言的标签，无外部副作用。
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			// bold 将文字包入粗体标签；本例的断言没有单独证明此回调被调用。
			bold: (text: string) => `<bold>${text}</bold>`,
			// as Theme 只绕过静态完整性检查，不会补出缺失方法或运行时校验对象。
		} as Theme;
		// 属性简写 { theme } 将替身传入真实转换器。
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme });

		// 要求边框使用 borderMuted 语义槽。
		expect(rendered).toContain("<borderMuted>");
		// 要求连接线等强调片段包含 accent 槽。
		expect(rendered).toContain("<accent>");
	});

	// 例：尚未闭合的 Mermaid 围栏在 streaming 模式仍可显示箭头；没有模拟网络流。
	it("renders incomplete Mermaid blocks during streaming", () => {
		// 刻意省略闭合围栏，用普通字符串模拟一段流式中间正文。
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";

		// isStreaming:true 允许不完整图，检查输出包含连接箭头即可。
		expect(transformMermaid(partialMarkdown, { isStreaming: true })).toContain("───▶");
	});

	// 例：节点带 :::highlight 类声明也可排图；不验证具体类的视觉样式。
	it("renders diagrams with class assignments", () => {
		// 固定图把 highlight 类赋给 Foo，再连接到 Bar。
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		// 运行真实转换逻辑，后面从三个片段观察成功路径。
		const rendered = transformMermaid(markdown);

		// 原代码围栏应被替代。
		expect(rendered).not.toContain("```mermaid");
		// 结果不能含最终解析警告提示。
		expect(rendered).not.toContain("Mermaid diagram not rendered");
		// 要求两个节点及连线出现，不比较所有渲染行。
		expect(rendered).toContain("│ Foo ├───▶│ Bar │");
	});

	// 例：相同无效语法在最终显示保留代码并警告，流式中暂显示能解析的节点。
	it("falls back to the code block with a warning after streaming", () => {
		// invalid 不是合法连接，作为可产生部分解析警告的固定输入。
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n```";
		// 缺省 isStreaming:false，模拟已经结束的正文。
		const final = transformMermaid(markdown);
		// 在代码后加普通正文，额外检查警告后的强制换行衔接。
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		// 同一输入开启流式，观察部分图路径；字符串本身不变。
		const streaming = transformMermaid(markdown, { isStreaming: true });

		// 最终正文必须包含原始代码块。
		expect(final).toContain(markdown);
		// 检查代码围栏后新增的警告行内代码开头。
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		// 首条警告必须说明丢弃了 invalid，避免只检查泛泛提示。
		expect(final).toContain('dropped, expected a link: "invalid"');
		// 只有一条警告时不应带额外条数摘要。
		expect(final).not.toContain("more)");
		// 两个空格加换行是 Markdown 强制换行，必须保留到后文。
		expect(followedByText).toContain("  \nFollowing text");
		// 流式结果不能出现最终警告文案。
		expect(streaming).not.toContain("Mermaid diagram not rendered");
		// 流式可成图时不应保留原围栏。
		expect(streaming).not.toContain("```mermaid");
		// 这里只要求已经可解析的 Foo 节点出现。
		expect(streaming).toContain("│ Foo │");
	});

	// 例：两条警告只展示首条全文和额外一条的数量，避免把每条错误都铺开。
	it("summarizes additional partial-render warnings", () => {
		// 两个节点各带一个无效连接后缀，构造两条警告。
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] invalid\n  B[Bar] also-invalid\n```";
		// 使用缺省最终显示模式，触发警告回退。
		const rendered = transformMermaid(markdown);

		// 仍必须保留完整输入代码。
		expect(rendered).toContain(markdown);
		// 只公开第一条无效连接的详情。
		expect(rendered).toContain('dropped, expected a link: "invalid"');
		// 计数摘要要求恰为额外一条。
		expect(rendered).toContain("(+1 more)");
		// 第二条详情不应在警告文案里展开；原代码仍含 also-invalid，所查子串还包含诊断前缀。
		expect(rendered).not.toContain('dropped, expected a link: "also-invalid"');
	});

	// 例：off 始终保留原文，final 等结束才画图，思考正文始终跳过；只检查这四个组合。
	it("respects rendering modes and skips thinking blocks", () => {
		// 各条件复用同一个合法图输入，使结果差异来自选项。
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		// 关闭模式要求字符串严格相等。
		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		// final 模式配流式标志仍返回原围栏。
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		// final 模式在默认已结束状态才移除围栏并绘图。
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
		// assistant-thinking 强制跳过，不受默认 streaming 模式影响。
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
	});
});
