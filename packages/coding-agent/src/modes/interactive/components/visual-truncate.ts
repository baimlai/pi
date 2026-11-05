/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by tool renderers and bash-execution.ts for consistent behavior.
 */

// 按终端实际折行结果裁工具预览，供bash和工具渲染器保持一致；Text先处理ANSI/留白/宽度，truncateToWidth只裁提示一行。这里的视觉裁剪不改变工具原结果、模型上下文或磁盘全文。
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

// 结果接口只描述展示行与隐藏计数，没有原文文件/网络读写能力。
export interface VisualTruncateResult {
	/** The visual lines to display */
	// 已经按给定宽度折行并保留ANSI的行数组，Text可能补齐尾部空格。
	visualLines: string[];
	/** Number of visual lines that were skipped (hidden) */
	// 按总视觉行数减预算计算；不是原文换行数，也不是token数。
	skippedCount: number;
}

/**
 * Truncate text to a maximum number of visual lines.
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @param keep - Which visual lines to keep: the last ones (default) or the first ones.
 * @returns The truncated visual lines and count of skipped lines
 */
// 先借Text折行再保留头/尾行，返回行数组与隐藏计数，无终端/文件副作用。例单行很长也会先折成多视觉行再裁；参数预期为有效宽度/正行数，本函数未校验，0/负数会暴露slice的特殊语义。
export function truncateToVisualLines(
	// 原文字可含LF与ANSI；空白字符串是否占行由Text决定。
	text: string,
	// 保留的视觉行数预算，不含VisualLinePreview另加的提示行。
	maxVisualLines: number,
	// 终端可用列宽，不是每行字符串length。
	width: number,
	// 默认不加左右边距；放Box中避免重复留白，显式1适合普通Container。
	paddingX: number = 0,
	// 字面量联合限制正常调用只能头/尾，默认保留尾部；TS类型不会替运行输入验证。
	keep: "start" | "end" = "end",
): VisualTruncateResult {
	// 空字符串直接返回，不创建Text；空白但非空文字会交Text处理。
	if (!text) {
		// 返回新空数组，隐藏计数0。
		return { visualLines: [], skippedCount: 0 };
	}

	// Create a temporary Text component to render and get visual lines
	// 临时Text使用指定水平留白/零垂直留白，不注册到TUI，构造不会实际绘屏。
	const tempText = new Text(text, paddingX, 0);
	// 生成全部视觉行再裁，仍需为完整文本做折行工作，不能当只读头尾的流式算法。
	const allVisualLines = tempText.render(width);

	// 未超行数预算就原样返回全部Text渲染行。
	if (allVisualLines.length <= maxVisualLines) {
		// 这条路径跳过slice，隐藏计数0。
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	// 超预算时选择要保留的数组切片。
	const truncatedLines =
		// start取前max行，end取最后max行；max=0时start空而end因slice(-0)保留全部，负数/小数也未归一化。
		keep === "start" ? allVisualLines.slice(0, maxVisualLines) : allVisualLines.slice(-maxVisualLines);
	// 隐藏数直接减传入数值；异常预算可使其与实际切片条数不一致，不是重新数被移除行。
	const skippedCount = allVisualLines.length - maxVisualLines;

	// 对象属性简写返回裁后行和计数，不额外生成省略提示。
	return { visualLines: truncatedLines, skippedCount };
}

// 带缓存预览所需选项，保留调用者对象引用；修改后要invalidate，不会自动观察字段变化。
export interface VisualLinePreviewOptions {
	/** Styled text; may contain newlines. */
	// 已着色原文，多行/长行都由Text折行后再裁。
	text: string;
	// 正文视觉行预算，额外提示会再占一行。
	maxVisualLines: number;
	/** Which visual lines to keep. The hint goes before kept end lines and after kept start lines. */
	// 保留头时提示排后，保留尾时提示排前；不改变原始工具内容。
	keep: "start" | "end";
	/** Styled hint line for the given number of hidden visual lines. */
	// 同步提示格式化函数，接隐藏视觉行数返回可着色文字；错误会由render传播，不保证返回本身只有一行。
	formatHint: (hidden: number) => string;
}

/**
 * Collapsed tool output limited to a number of visual lines, like bash output. Limiting logical
 * lines instead lets a single long line (such as minified JSON) wrap across the whole screen.
 * Caches its lines per width, since it renders on every frame for every result in the transcript.
 */
// 按宽度缓存折行预览，减少每帧重复计算；不监听终端宽度变化事件，由宿主每次render传width。
export class VisualLinePreview implements Component {
	// 保存options引用，不深复制/冻结，改它后同宽缓存仍可能旧值。
	private options: VisualLinePreviewOptions;
	// 上次成功渲染宽度，undefined为未缓存/已失效。
	private cachedWidth: number | undefined;
	// 缓存输出数组，空数组也可有效；调用方不应修改它，否则后续命中可见修改。
	private cachedLines: string[] | undefined;

	// 只保存预览配置，无折行或文件副作用；例new VisualLinePreview({text,maxVisualLines:5,keep:"end",formatHint})等render才计算。配置有效性由调用方保证。
	constructor(options: VisualLinePreviewOptions) {
		// 存同一个对象引用，不先调用formatHint。
		this.options = options;
	}

	// 按宽度返回缓存或重算正文+提示，例换窄窗口会增加隐藏行数；提示自身超宽再截到width。返回数组引用，格式化/折行异常传播，成功前不会发布新cachedWidth。
	render(width: number): string[] {
		// 没有缓存或宽度严格不同才重算，单改options字段不会命中这个条件。
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			// 从当前options解构此次值，函数引用仍指向调用方提供者。
			const { text, maxVisualLines, keep, formatHint } = this.options;
			// 预览固定paddingX=0，外层布局负责边距；内部先全量折行再裁。
			const preview = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
			// 保存正文视觉行引用，没隐藏提示时可直接缓存它。
			const lines = preview.visualLines;
			// 按skippedCount判断是否加提示，不额外验证实际切片是否少行。
			if (preview.skippedCount > 0) {
				// 同步生成隐藏说明，再按可见列裁提示，过长使用三个点；不是按UTF-8字节裁全文。
				const hint = truncateToWidth(formatHint(preview.skippedCount), width, "...");
				// 数组展开生成“正文+提示”或“提示+正文”；提示不计maxVisualLines预算，所以通常最多正文预算再加1行。
				this.cachedLines = keep === "start" ? [...lines, hint] : [hint, ...lines];
			} else {
				// 没有隐藏则直接使用正文行数组，不生成提示。
				this.cachedLines = lines;
			}
			// 只有上面计算成功才保存width键。
			this.cachedWidth = width;
		}
		// 返回内部缓存数组，不为每次render再克隆。
		return this.cachedLines;
	}

	// 清两缓存字段，返回void；例外层改文字/主题后调用，下一render重算。此方法不清原配置、不请求终端重画。
	invalidate(): void {
		// 移除上次宽度键。
		this.cachedWidth = undefined;
		// 移除行数组引用，旧调用方已取得的数组不会被改写。
		this.cachedLines = undefined;
	}
}
