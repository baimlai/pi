// MouseRegion 给现有组件套一层鼠标兜底处理，文字渲染原样转交孩子；上游事件分发器负责实际坐标和焦点安排。
import {
	// Component 接口只在编译时要求 render/invalidate 等成员。
	type Component,
	// 运行时分发工具，会把孩子的处理结果转换成带目标与坐标变换信息的结果。
	dispatchMouseEvent,
	// 已分发结果类型，包含具体 target 和 handled 标记，仅参与类型检查。
	type TuiMouseDispatchResult,
	// 归一化鼠标事件类型，x/y 是接收组件内的坐标。
	type TuiMouseEvent,
	// 普通处理结果类型，描述是否处理、捕获、请求焦点或重画。
	type TuiMouseEventResult,
} from "../tui.ts";

// 处理函数的类型别名：接收事件，返回处理意图或 undefined；声明本身不注册监听器。
export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** Adds mouse handling to an existing component without changing its rendering. */
// 不实现额外布局协议或键盘转发，仅包装孩子的 render、鼠标与 invalidate 行为。
export class MouseRegion implements Component {
	// 保存孩子引用，readonly 禁止通过本字段重新赋值，不会冻结孩子。
	private readonly child: Component;
	// 保存兜底回调；只有孩子分发未得到有效结果时才执行。
	private readonly onMouse: MouseRegionHandler;

	// 创建包装组件，输入孩子与兜底函数，只保存引用，无显式返回语句。
	// 例：给没有 handleMouse 的 Text 增加点击处理；这里不立即调用孩子或回调，也不要求宿主重画。
	constructor(child: Component, onMouse: MouseRegionHandler) {
		// 记录原孩子对象，没有复制它。
		this.child = child;
		// 记录处理函数引用，不在构造时执行。
		this.onMouse = onMouse;
	}

	// 按相同宽度渲染孩子并原样返回行数组，不加边距、不复制、不直接写终端。例：包装 Text 后显示仍一致；孩子异常向上传播。
	render(width: number): string[] {
		// 这里实际调用孩子 render，完全保留其返回引用与缓存行为。
		return this.child.render(width);
	}

	// 先向孩子分发鼠标事件；有结果优先返回，否则调用本层兜底，返回两种结果之一或 undefined。
	// 例：孩子已申请 focus 则不会再触发兜底；孩子只返回 {render:true} 而无处理/捕获/焦点意图时，分发器会视为未处理。没有改坐标，异常向上传播。
	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		// dispatchMouseEvent 调用孩子的可选处理器，并规范目标信息；可能得到 undefined。
		const childResult = dispatchMouseEvent(this.child, event);
		// ?? 仅在左边 null/undefined 时执行右侧回调，不会同时执行两边；保持孩子已处理事件的优先级。
		return childResult ?? this.onMouse(event);
	}

	// 把缓存失效通知交给孩子，无参数、无返回值；包装层不存结果，不请求重画。例：父容器 invalidate 时孩子也收到通知，异常向上传播。
	invalidate(): void {
		// 直接调用孩子的接口方法，不重建孩子或清掉回调。
		this.child.invalidate();
	}
}
