// 把一段文字变成终端可显示的多行文本：Text 负责折行、留白、背景和结果缓存，上层 TUI 再把这些行画到屏幕。
// type 导入仅用于 TypeScript 检查，实现 Component 接口不会自动启动渲染或注册事件。
import type { Component } from "../tui.ts";
// 这些运行时工具分别补背景、减少缓存字符串的底层内存保留、计算终端列宽，以及保留 ANSI 样式折行。
import { applyBackgroundToLine, flattenLines, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

/**
 * Text component - displays multi-line text with word wrapping
 */
// 类实现 Component 约定；调用方通常先 setText，再由宿主调用 render(width)，这里不直接写终端。
export class Text implements Component {
	// private 限制 TypeScript 中的外部访问；保存原始文本，尚未替换制表符或折行。
	private text: string;
	// 左右各留多少列；number 是编译期类型，不会自动校验输入为非负整数。
	private paddingX: number; // Left/right padding
	// 上下各留多少行；空白文本会直接返回空数组，不会单独绘制这些留白。
	private paddingY: number; // Top/bottom padding
	// ? 表示可不提供；函数接收一行文本并返回加过背景样式的字符串。
	private customBgFn?: (text: string) => string;

	// Cache for rendered output
	// 缓存上一次使用的原始文本；未渲染时是 undefined。
	private cachedText?: string;
	// 缓存调用方传入的宽度，与下一次 width 做严格相等比较。
	private cachedWidth?: number;
	// 缓存已生成的整组行；string[] 是字符串数组，命中时直接复用这个数组引用。
	private cachedLines?: string[];

	// 创建文字组件；参数依次是文本、水平留白、垂直留白、可选背景函数，无返回值。
	// 只保存配置，不请求宿主重画。例：new Text("你好", 0, 0) 渲染时不附加边距。
	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		// 把参数保存到实例；this 指向当前 Text 对象。
		this.text = text;
		// 记录左右留白，实际 render 时会在窄屏下缩小它。
		this.paddingX = paddingX;
		// 记录上下留白，实际生成行时使用。
		this.paddingY = paddingY;
		// 保存函数引用；此时没有调用背景函数。
		this.customBgFn = customBgFn;
	}

	// 更新原文，无返回值；相同内容保留缓存，内容变化则清空缓存，下一次 render 才重新计算。
	// 例：连续两次 setText("完成") 不会因为第二次调用重新折行；方法本身不通知 TUI 重画。
	setText(text: string): void {
		// Renderers often set the same text on every update; keep the wrapped lines then.
		// 严格相等时提前 return：字符串按内容比较，避免每帧重复设置同文导致缓存失效。
		if (text === this.text) return;
		// 原文发生变化，先保存新内容。
		this.text = text;
		// 清除缓存的文本键；undefined 表示旧记录不可再用于匹配。
		this.cachedText = undefined;
		// 清除旧宽度键。
		this.cachedWidth = undefined;
		// 释放实例对旧行数组的引用；已有调用者拿到的数组不会因此被修改。
		this.cachedLines = undefined;
	}

	// 替换或移除背景函数，无返回值；清空三项缓存，确保下次 render 应用新配置。
	// 例：setCustomBgFn(undefined) 恢复无自定义背景；即使传入同一函数，也会失效缓存，不直接请求重画。
	setCustomBgFn(customBgFn?: (text: string) => string): void {
		// 保存新函数或 undefined。
		this.customBgFn = customBgFn;
		// 背景变了，旧文本键也清除，避免复用旧结果。
		this.cachedText = undefined;
		// 清除旧宽度键。
		this.cachedWidth = undefined;
		// 清除带旧背景的行数组。
		this.cachedLines = undefined;
	}

	// 修改左右留白，无返回值；写入后调用 invalidate，下一次渲染再折行。
	// 例：setPaddingX(0) 将空间留给正文；子类可以重写 invalidate，因此此调用也可能触发子类的刷新逻辑。
	setPaddingX(paddingX: number): void {
		// 记录新留白；没有在 setter 中做取整或范围校验。
		this.paddingX = paddingX;
		// 通过 this 调用可被子类重写的方法；Text 本身的实现仅清缓存。
		this.invalidate();
	}

	// 使渲染缓存失效，无参数、无返回值；不修改原文，也不直接请求宿主重画。
	// 例：外部颜色设置改变后 invalidate()，接着 render(80) 就会重新生成行。
	invalidate(): void {
		// 清除文本匹配记录。
		this.cachedText = undefined;
		// 清除宽度匹配记录。
		this.cachedWidth = undefined;
		// 清除渲染行数组。
		this.cachedLines = undefined;
	}

	// 按终端列宽 width 返回字符串数组，不写终端；先匹配缓存，再规范文字、折行、补边距与背景，最后缓存。
	// 例：new Text("abc", 0, 0).render(5) 返回正文后带空格的一行；宽度、留白通常由宿主提供有效整数，工具和背景回调的异常会向上传播。
	render(width: number): string[] {
		// Check cache
		// 只有缓存存在、原文相同且宽度相同才命中；空数组也是 truthy，因此空结果同样可缓存。
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			// 返回原数组引用，省去重新分配和折行；调用者不应改动这些缓存行。
			return this.cachedLines;
		}

		// Don't render anything if there's no actual text
		// 空字符串或 trim 后全为空白时不占任何行，连上下留白也跳过。
		if (!this.text || this.text.trim() === "") {
			// 显式声明空字符串数组，避免 TypeScript 对空数组推断出不合适的元素类型。
			const result: string[] = [];
			// 记住本次原文，下一次相同空白内容可以命中缓存。
			this.cachedText = this.text;
			// 记住本次宽度。
			this.cachedWidth = width;
			// 缓存这个空结果数组。
			this.cachedLines = result;
			// 直接返回，不再调用折行或背景函数。
			return result;
		}

		// Replace tabs with 3 spaces
		// 正则中的 g 表示替换所有匹配，把每个制表符固定改成三个空格，而不是计算制表位。
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Reduce margins when necessary so content and padding fit within the available width.
		// 左右边距取配置值和当前允许值中较小者；floor 向下取整，宽度正常时至少为正文留下一个终端列。
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		// 从总宽度扣掉两侧边距，正文可用宽度至少为 1。
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Wrap text (this preserves ANSI codes but does NOT pad)
		// 按可见列宽折行，并保留 ANSI 控制序列；工具本身不补齐每行末尾空格。
		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

		// Add margins and background to each line
		// repeat 生成左侧空格；配置需要符合 repeat 的有效次数约束。
		const leftMargin = " ".repeat(paddingX);
		// 生成相同宽度的右侧空格。
		const rightMargin = " ".repeat(paddingX);
		// 积累完成左右边距和背景处理的正文行。
		const contentLines: string[] = [];

		// for...of 按顺序遍历折好的每一行。
		for (const line of wrappedLines) {
			// Add margins
			// 用 + 拼接左空白、正文和右空白，此时还可能不足整行宽度。
			const lineWithMargins = leftMargin + line + rightMargin;

			// Apply background if specified (this also pads to full width)
			// 函数存在才执行背景分支；条件也让 TypeScript 在分支内把它收窄为可调用函数。
			if (this.customBgFn) {
				// 先补足可见宽度，再交给背景函数，并将返回字符串追加到正文行数组。
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
				// 没有背景函数时，只补空格即可。
			} else {
				// No background - just pad to width with spaces
				// 计算显示列数而非 string.length；中文、表情和 ANSI 控制序列会使两种长度不同。
				const visibleLen = visibleWidth(lineWithMargins);
				// 只补不足的列数，已超宽时取 0；这里不会额外截断超宽行。
				const paddingNeeded = Math.max(0, width - visibleLen);
				// 把末尾补齐后的这一行存起来。
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		// 准备与请求宽度相同的一整行空格，用作上下留白。
		const emptyLine = " ".repeat(width);
		// 存储一侧需要的留白行。
		const emptyLines: string[] = [];
		// 按配置次数生成垂直留白；这里直接比较 paddingY，没有额外取整。
		for (let i = 0; i < this.paddingY; i++) {
			// 有背景时空白行也上背景，否则复用纯空格字符串；三元表达式在两种值中选一个。
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			// 将这条留白行加入数组。
			emptyLines.push(line);
		}

		// ... 展开数组元素，按上留白、正文、下留白顺序组成新数组。
		const result = [...emptyLines, ...contentLines, ...emptyLines];
		// flattenLines 触发 V8 对拼接字符串的内部整理，减少缓存保留底层大字符串；不改变数组中的文字内容。
		flattenLines(result);

		// Update cache
		// 保存本次结果对应的文本键。
		this.cachedText = this.text;
		// 保存原始请求宽度键。
		this.cachedWidth = width;
		// 保存最终行数组，供相同请求复用。
		this.cachedLines = result;

		// 正常返回生成的行；若结果意外为空则返回单个空行，前面的空白文本分支仍是直接返回 []。
		return result.length > 0 ? result : [""];
	}
}
