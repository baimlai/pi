// 定义组件向布局器描述结构的协议：Stack 和 ScrollView 暴露节点，layout.ts 读取节点后计算位置。
// type 导入只参与 TypeScript 检查，不会在运行时构造 Component。
import type { Component } from "./tui.ts";

// Symbol.for 从全局符号注册表获取固定键；组件与布局器通过同一个符号访问方法，避免普通字符串属性撞名。
export const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

// 视口的编译期结构约束；interface 不会在运行时检查数字是否有效。
export interface LayoutViewport {
	// 可见区域的终端列数。
	width: number;
	// 可见区域的终端行数。
	height: number;
}

// 描述一个堆叠孩子及其主轴尺寸规则；? 表示该配置可以省略。
export interface StackLayoutEntry {
	// 真正负责渲染内容的组件实例。
	component: Component;
	// 初始主轴尺寸：数字表示固定起点，"auto" 或省略表示先测自然尺寸；之后仍可能按 grow/shrink 调整。
	basis?: number | "auto";
	// 有剩余空间时的增长权重；省略时分配器按 0 处理。
	grow?: number;
	// 空间不够时的收缩权重；省略时按 1，并结合当前尺寸计算权重。
	shrink?: number;
	// 主轴最小尺寸，竖排是行数，横排是列数。
	minSize?: number;
	// 主轴最大尺寸，限制增长与初始尺寸。
	maxSize?: number;
	// 可选可见性回调；接收视口并返回是否保留该项，调用方会在布局或普通渲染时执行它。
	visible?: (viewport: LayoutViewport) => boolean;
}

// 堆叠节点的描述数据，不是已经计算好的坐标；布局器根据 type 选择主轴。
export interface StackLayoutNode {
	// 字符串字面量联合类型：只允许竖排或横排，分支比较后 TypeScript 可据此收窄节点类型。
	type: "vstack" | "hstack";
	// readonly 限制通过这个数组类型增删元素，不会冻结数组或深层对象；这里保留原条目的引用。
	entries: readonly StackLayoutEntry[];
	// 相邻可见孩子之间的空白行数或列数。
	gap: number;
	// 交叉轴对齐方式：拉伸、起点、居中、终点；实际布局算法决定对应高度和位置。
	align: "stretch" | "start" | "center" | "end";
}

// 滚动节点提供给布局器的状态接口；这里只声明方法和可读属性，不提供实现或运行时校验。
export interface ScrollLayoutState {
	// 当前内容顶部向上滚走的行数；readonly 禁止通过此接口赋值，实际 ScrollView 可在内部更新。
	readonly scrollTop: number;
	// 是否声明为主要滚动区域；布局器据此选择主要视图引用，不保证全树只有一个声明。
	readonly primary: boolean;
	// 供宿主决定命中滚动视图之间的越界传递；本接口不执行拦截，主要视图兜底仍由宿主决定。
	readonly overscroll: "chain" | "contain";
	// 最近一次布局得到的可视高度。
	readonly viewportHeight: number;
	// 由实现计算正文宽度，例如 always 滚动条在宽度允许时预留右侧一列；输入总宽度，返回正文列数。
	getContentWidth(width: number): number;
	// 布局器传入内容高度、视口高度和重画回调；实现更新滚动边界并保存回调，返回 void，不意味着此处已写终端。
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
}

// 滚动节点将单个内容组件和滚动状态组合在一起，位置与裁剪稍后计算。
export interface ScrollLayoutNode {
	// 固定的 "scroll" 标签供布局器识别滚动分支。
	type: "scroll";
	// 被滚动的内容组件，并非滚动条本身。
	component: Component;
	// 负责保存偏移、边界和滚动策略的对象。
	state: ScrollLayoutState;
}

// 联合类型表示两类节点之一；以 type 区分分支，不能同时当作两种结构使用。
export type LayoutNode = StackLayoutNode | ScrollLayoutNode;

// 在基础组件接口上增加布局描述方法；普通 Text 等没有此方法仍可作为叶子渲染。
export interface LayoutComponent extends Component {
	// 计算属性名使用上面的 Symbol，调用后返回结构描述；方法声明只约束类型，不会自动生成实现。
	[LAYOUT_NODE](): LayoutNode;
}

// 读取可选的布局描述；输入任意 Component，有协议方法时调用并返回其结果，否则返回 undefined。
// 例：Text 得到 undefined 后作为叶子，VStack 则得到 vstack 节点；方法抛错会向上传播，返回节点的字段不在这里逐项校验。
export function getLayoutNode(component: Component): LayoutNode | undefined {
	// as 是编译期类型断言，不会改造对象；Partial 把 LayoutComponent 的字段改成可选，允许探测协议是否存在。
	const candidate = component as Partial<LayoutComponent>;
	// 这是对可选协议的实际运行时探测：只检查属性是否为函数，再保持对象接收者调用它；三元表达式选择结果或 undefined。
	return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}
