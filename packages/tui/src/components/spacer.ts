// Spacer 用空字符串行给相邻组件留出垂直距离，由宿主决定这些行如何铺满终端宽度。
// Component 只在编译期约束这个类提供渲染与缓存失效方法，不会自动安排绘制。
import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
// 实现组件接口的空行组件，不绘制字符或写终端。
export class Spacer implements Component {
	// 保存要生成多少行；private 是 TypeScript 的访问限制，number 不会自动验证整数范围。
	private lines: number;

	// 创建留白组件，无返回值；只保存行数，不触发绘制。例：new Spacer(2).render(80) 得到两个空字符串。
	constructor(lines: number = 1) {
		// 保存传入值；这里没有取整或夹紧。
		this.lines = lines;
	}

	// 更新行数，无返回值，不请求重画；下一次 render 使用新值。例：setLines(0) 使组件不占行。
	setLines(lines: number): void {
		// 覆盖旧配置；没有缓存需要同步清除。
		this.lines = lines;
	}

	// 满足组件的缓存失效接口，无参数、无返回值；这个类没有缓存，因此方法体不做事。例：父容器统一 invalidate 所有孩子时可以安全调用它。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 返回一组空行，无外部副作用；_width 表明参数用于接口兼容但这里不读取。
	// 循环条件直接使用配置：通常传非负整数，负值或 0 返回 []，正小数会按循环实际次数生成行。
	render(_width: number): string[] {
		// 创建本次结果数组，string[] 限定元素必须是字符串。
		const result: string[] = [];
		// let i 是可更新的循环计数器，从 0 开始，每次生成一行后加 1。
		for (let i = 0; i < this.lines; i++) {
			// 追加空字符串表示占用一行，而非生成 width 个空格。
			result.push("");
		}
		// 返回本次新建的行数组。
		return result;
	}
}
