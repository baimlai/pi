// TruncatedText 只显示第一条以 LF 分隔的文本行，超宽截断而不折行；上游宿主拿 render 结果再绘制终端。
// type 导入的接口只做编译期约束，implements 不会自动注册组件。
import type { Component } from "../tui.ts";
// truncateToWidth 处理可见列与 ANSI，visibleWidth 测终端列宽，不能用普通字符数替代。
import { truncateToWidth, visibleWidth } from "../utils.ts";

/**
 * Text component that truncates to fit viewport width
 */
// 实现基础组件接口；内容和留白配置保存在实例中，没有渲染缓存。
export class TruncatedText implements Component {
	// 原始文字，后面只读取首个 LF 之前的部分。
	private text: string;
	// 左右各留多少列；private 是 TypeScript 的访问限制，不会自动验证非负整数。
	private paddingX: number;
	// 上下各留多少行。
	private paddingY: number;

	// 创建截断文字组件，输入文本和可选水平/垂直留白，只保存配置，不请求绘制。
	// 例：new TruncatedText("第一行\n第二行", 1, 0) 渲染时只显示“第一行”；new 表达式得到实例，构造函数没有显式返回语句。
	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		// 保存原始文字，不在构造时截断。
		this.text = text;
		// 保存水平留白配置。
		this.paddingX = paddingX;
		// 保存垂直留白配置。
		this.paddingY = paddingY;
	}

	// 响应宿主的缓存失效通知，无参数、无返回值；本类没有缓存，因此不做事。例：主题刷新时父容器可统一调用它。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 按 width 生成上下留白和一条正文，返回字符串数组，不写终端；先取首行、截断，再补边距和末尾空格。
	// 例：普通有效宽度 10、paddingX=1 时正文最多用 8 列；边距不会像 Text 那样自动缩小，过大边距仍可能超宽，repeat 等工具错误向上传播。
	render(width: number): string[] {
		// 建立本次输出数组，元素限定为字符串。
		const result: string[] = [];

		// Empty line padded to width
		// 准备整行空格；width 应适合 String.repeat 的次数约束。
		const emptyLine = " ".repeat(width);

		// Add vertical padding above
		// 按配置直接循环生成顶部留白，没有在此额外取整。
		for (let i = 0; i < this.paddingY; i++) {
			// 复用同一个空白字符串值作为留白行。
			result.push(emptyLine);
		}

		// Calculate available width after horizontal padding
		// 扣掉两侧边距，但至少给正文 1 列；不意味着总边距一定能塞进当前 width。
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// Take only the first line (stop at newline)
		// 先假定整段文本就是待显示内容，let 允许下面重新赋值。
		let singleLineText = this.text;
		// 查找首个 LF 换行符，未找到返回 -1；这里不单独查 CR。
		const newlineIndex = this.text.indexOf("\n");
		// 存在 LF 时才截取首段。
		if (newlineIndex !== -1) {
			// substring 的结束下标不包含 LF，后面的行全部不显示。
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		// 按可见列宽截断，沿用工具默认的 "..." 省略标记；保留必要 ANSI，不生成多行折行结果。
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		// 生成左侧空格，配置没有自动夹紧。
		const leftPadding = " ".repeat(this.paddingX);
		// 生成右侧同样数量的空格。
		const rightPadding = " ".repeat(this.paddingX);
		// 把固定左右留白拼在截断正文两侧。
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Pad line to exactly width characters
		// 计算包含留白后的显示列数，忽略 ANSI 控制序列。
		const lineVisibleWidth = visibleWidth(lineWithPadding);
		// 不足 width 才继续补空格，已经超宽时补 0，不再裁掉边距。
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		// 拼接尾部补齐空格；正常边距能容纳时得到恰好 width 列。
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		// 即使正文为空也追加这一条正文行，不像 Text 对空白内容直接返回 []。
		result.push(finalLine);

		// Add vertical padding below
		// 按相同配置生成底部留白。
		for (let i = 0; i < this.paddingY; i++) {
			// 底部同样使用铺满宽度的空白行。
			result.push(emptyLine);
		}

		// 返回本次生成的完整数组，没有缓存复用。
		return result;
	}
}
