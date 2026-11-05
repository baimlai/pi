// 按渲染宽度生成一条边框的组件，供MCP管理页、扩展对话框等布局使用；只返回字符串行，不写终端。Component为编译期接口。
import type { Component } from "@earendil-works/pi-tui";
// 默认颜色读取共享theme；跨模块加载器缓存使用时宜显式传颜色函数，原因保留在下面原说明。
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
// implements要求具备render/invalidate，不自动注册到TUI；调用方将实例加进Container后才参与布局。
export class DynamicBorder implements Component {
	// 保存字符串到样式字符串的回调，private不是运行时沙箱。
	private color: (str: string) => string;

	// 保存颜色回调，不立即渲染；例new DynamicBorder(s=>s)生成无颜色横线。缺参数使用theme.border，真正回调执行/抛错发生在render。
	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		// 只保存函数引用，之后每次render都重新调用，允许读取变化后的主题。
		this.color = color;
	}

	// 统一缓存失效接口，返回void；本组件没有缓存，所以主题变化后再render就会重新着色，不在这里requestRender。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 输入终端列宽，返回单行边框数组；例width=5生成五个横线。常规有限输入至少生成一个，未额外校验数值，repeat过大参数或颜色回调错误会传播。
	render(width: number): string[] {
		// Math.max把<=1的有限宽度抬到1；repeat按JS数量规则处理小数/NaN，Infinity或过大值可抛RangeError；外层数组表示一行。
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
