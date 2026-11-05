// Stack 保存横排/竖排共有的孩子配置与尺寸分配规则；VStack、HStack 和 layout.ts 复用这些规则。
// LAYOUT_NODE 是运行时符号，type 标记的接口只参与 TypeScript 检查。
import { LAYOUT_NODE, type LayoutViewport, type StackLayoutEntry, type StackLayoutNode } from "../layout-node.ts";
// Container 提供基础孩子列表与事件行为；Component 是孩子需满足的编译期接口。
import { type Component, Container } from "../tui.ts";

// 单个孩子的主轴尺寸配置；竖排主轴是高度，横排主轴是宽度，? 表示可省略。
export interface StackEntryOptions {
	// 数字表示初始尺寸；"auto" 或省略表示使用测得的自然尺寸，之后仍可能被增长或收缩。
	basis?: number | "auto";
	// 多余空间的增长权重，省略按 0，不主动增长。
	grow?: number;
	// 空间不足的收缩权重，省略按 1；实际权重还乘当前尺寸。
	shrink?: number;
	// 允许的最小主轴尺寸，省略按 0。
	minSize?: number;
	// 允许的最大主轴尺寸，省略按 Number.MAX_SAFE_INTEGER。
	maxSize?: number;
	// 接收视口并返回是否显示；回调在筛选阶段执行，隐藏不等于从孩子列表永久删除。
	visible?: (viewport: LayoutViewport) => boolean;
}

// extends 复用上面所有可选配置，再补充真正的组件；接口只约束类型，不创建对象。
export interface StackEntry extends StackEntryOptions {
	// 要放入布局的组件实例。
	component: Component;
}

// 联合类型允许直接传组件，也允许传 { component, grow: 1 } 这样的带配置条目。
export type StackChild = Component | StackEntry;

// 整个 Stack 的公共配置，与单个孩子的尺寸选项分开。
export interface StackOptions {
	// 相邻可见孩子的间距；构造时会规范成非负整数。
	gap?: number;
	// 交叉轴对齐方式；布局帧中横排会据此计算孩子高度与纵向位置。
	align?: "stretch" | "start" | "center" | "end";
}

// 区分两种孩子写法，返回类型谓词 child is StackEntry 使 TypeScript 在分支中收窄类型。
// 例：{component: text, grow: 1} 没有 render，被视作条目；它只检查属性存在性，不是完整的运行时结构校验，也不验证 render 是否可调用。
function isStackEntry(child: StackChild): child is StackEntry {
	// in 检查对象自身或原型链上有无 render；取反表示没有该属性的是配置条目。
	return !("render" in child);
}

// 规范尺寸选项，输入可缺省数值和回退值，返回非负整数或回退值，不修改调用者数据。
// 例：normalizeSize(2.8, 0) 得 2，undefined 或 Infinity 用回退；这是配置数值策略，不是 TypeScript 自动提供的行为。
function normalizeSize(value: number | undefined, fallback: number): number {
	// 缺失或非有限数直接回退，否则向下取整并将负数夹到 0。
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

// TypeScript 不允许直接 new 抽象基类；它集中同步孩子列表与条目，具体横排/竖排由子类给出布局标签和 render。abstract 在去掉类型后的 JavaScript 中不会留下实例化检查。
export abstract class Stack extends Container {
	// protected 允许子类访问；readonly 禁止重新赋值这个字段，数组内容仍可 push、splice 或清空。
	protected readonly entries: StackLayoutEntry[] = [];
	// 初始化后不再通过本类型重新赋值的间距。
	protected readonly gap: number;
	// 保存交叉轴对齐方式，字面量联合限制允许值。
	protected readonly align: "stretch" | "start" | "center" | "end";
	// abstract 要求具体子类提供标签；readonly 与类型限制都不会在运行时冻结对象。
	protected abstract readonly layoutType: "vstack" | "hstack";

	// 创建堆叠容器；输入可选孩子和配置，无返回值，先初始化父容器，再规范配置并逐个添加孩子。
	// 例：子类传 [{component: text, grow: 1}] 时既记录组件，也记录增长规则；这里只存布局信息，不请求重画。
	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		// 先运行 Container 构造逻辑，派生类使用 this 前必须完成 super。
		super();
		// 间距缺省或无效时取 0，正常值向下取整并夹到非负。
		this.gap = normalizeSize(options.gap, 0);
		// ?? 只对 null/undefined 使用默认值，合法的对齐字符串直接保留。
		this.align = options.align ?? "stretch";
		// 按原数组顺序添加每一项。
		for (const child of children) {
			// 若是带配置条目，取它的 component，并把同一个条目的配置传给 addChild。
			if (isStackEntry(child)) this.addChild(child.component, child);
			// 否则直接添加组件，沿用 addChild 的空配置默认值。
			else this.addChild(child);
		}
	}

	// 重写添加方法，无返回值；同步父类 children 与布局 entries，并规范可选权重/范围。
	// 例：addChild(text, {basis: 10, grow: 1}) 先以 10 为尺寸起点；保留对象引用，不克隆组件、不去重，也不立即绘制。
	override addChild(component: Component, options: StackEntryOptions = {}): void {
		// 父类列表用于通用容器行为，因此先把组件加入 children。
		super.addChild(component);
		// 另建布局条目，两个列表的顺序保持一致。
		this.entries.push({
			// 属性简写保存组件引用。
			component,
			// 对象展开按条件加入 basis；缺省时省略属性，显式数字或 "auto" 原样保留。
			...(options.basis === undefined ? {} : { basis: options.basis }),
			// 有 grow 时规范后保存，未提供时让分配器采用默认增长权重 0。
			...(options.grow === undefined ? {} : { grow: normalizeSize(options.grow, 0) }),
			// 有 shrink 时规范后保存；无效数值回退 1，0 则允许禁止收缩。
			...(options.shrink === undefined ? {} : { shrink: normalizeSize(options.shrink, 1) }),
			// 最小尺寸有配置才保存，规范为非负整数。
			...(options.minSize === undefined ? {} : { minSize: normalizeSize(options.minSize, 0) }),
			// 最大尺寸有配置才保存；无效数值回退最大安全整数，后续 clampSize 还会确保它不小于最小值。
			...(options.maxSize === undefined ? {} : { maxSize: normalizeSize(options.maxSize, Number.MAX_SAFE_INTEGER) }),
			// 仅在提供时保存可见性函数引用，不在这里执行它。
			...(options.visible === undefined ? {} : { visible: options.visible }),
		});
	}

	// 按组件引用移除第一个匹配项，无返回值；同步两个列表，不销毁孩子，也不自动重画。例：重复加入同一组件后 removeChild 一次只移除一项。
	override removeChild(component: Component): void {
		// 先按父类规则移除 children 中的第一个匹配项。
		super.removeChild(component);
		// findIndex 查找布局条目中同一个组件引用，未找到为 -1。
		const index = this.entries.findIndex((entry) => entry.component === component);
		// 找到才用 splice 原地删除，避免 -1 意外删掉末项。
		if (index !== -1) this.entries.splice(index, 1);
	}

	// 清空两个孩子列表，无参数、无返回值；不 dispose 孩子或请求重画。例：重新组成布局前 clear()。
	override clear(): void {
		// 父类清空通用 children 列表。
		super.clear();
		// 保留 entries 数组本身，通过 length=0 清除元素；readonly 字段仍允许修改数组内容。
		this.entries.length = 0;
	}

	// 通过符号方法提供布局描述，无参数，返回新节点对象；不测量、不分配坐标。
	// 例：layout.ts 读取 HStack 时得到 hstack 标签和尺寸规则；entries 仍是原数组引用，没有深拷贝或冻结。
	[LAYOUT_NODE](): StackLayoutNode {
		// 构造本次返回的描述对象。
		return {
			// 子类提供 vstack/hstack 标签，供布局器选择主轴。
			type: this.layoutType,
			// 共享布局条目数组，后续通过容器增删时会改变它。
			entries: this.entries,
			// 提供相邻孩子间距。
			gap: this.gap,
			// 提供交叉轴对齐方式。
			align: this.align,
		};
	}
}

// 按视口筛选可见条目，返回新数组，不修改原数组或销毁隐藏组件；回调异常会向上传播。
// 例：visible: v => v.width >= 80 会在窄屏时隐藏该项；viewport 来自调用方，布局帧和普通 render 的高度含义不同。
export function visibleStackEntries(
	// readonly 防止本函数通过该参数增删原数组元素，不代表运行时冻结。
	entries: readonly StackLayoutEntry[],
	// 传给每个可见性回调的视口对象。
	viewport: LayoutViewport,
	// 返回仍引用原条目的可变数组。
): StackLayoutEntry[] {
	// 可选调用 visible；缺省结果用 true，因此未提供回调的项保留。filter 按原顺序收集返回真值的条目。
	return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}

// 把一个初始尺寸限制到条目的最小/最大范围，返回数值，不修改条目。
// 例：尺寸 20、min=2、max=10 时得 10；约束也会取整，max 小于 min 时以 min 为准，没有对任意外部 NaN 输入做额外校验。
function clampSize(size: number, entry: StackLayoutEntry): number {
	// 缺省最小值为 0，向下取整后夹到非负。
	const min = Math.max(0, Math.floor(entry.minSize ?? 0));
	// 缺省最大值为最大安全整数，再确保不小于已计算的最小值。
	const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
	// 初始尺寸也先向下取整、夹到非负，再夹在有效 min/max 之间。
	return Math.max(min, Math.min(max, Math.max(0, Math.floor(size))));
}

// 把 amount 个主轴单位按权重分配到 sizes，原地修改数组，无返回值；mode 决定增加还是减少。
// 每轮筛选尚有容量的项、求总权重，再逐项分配，直到完成或无法前进。例：只有一个可增长项且有容量时，它接收全部多余空间；所有项达上限后会留下空余，收缩到下限后仍可能溢出。
// 这不是完全照搬 CSS 的同时比例分配：逐项处理时 remaining 已变化，整数舍入和顺序会影响结果。
function distribute(
	// 被原地调整的尺寸数组，元素顺序对应 entries。
	sizes: number[],
	// 只读取各条目的增长、收缩与尺寸限制。
	entries: readonly StackLayoutEntry[],
	// 还需要增加或减少的总量，调用方传入非负差额。
	amount: number,
	// 字符串联合限定分配模式；两种模式共用循环但采用不同权重和容量公式。
	mode: "grow" | "shrink",
): void {
	// 用局部可变变量跟踪尚未分完的数量。
	let remaining = amount;
	// 只要还有需求就继续尝试下一轮。
	while (remaining > 0) {
		// 在本轮重新筛选候选项，已到边界的项不参与后续分配。
		const candidates = entries
			// map 将条目与原始下标绑定，后面才能修改对应 sizes 元素。
			.map((entry, index) => ({ entry, index }))
			// 解构候选对象后检查其当前容量；filter 回调只决定是否保留，不在这里改尺寸。
			.filter(({ entry, index }) => {
				// 增长模式检查增长权重和上限。
				if (mode === "grow") {
					// 权重大于 0 且尚未达到最大值才参与；! 是 TypeScript 非空断言，不会在运行时检查数组下标。
					return (entry.grow ?? 0) > 0 && sizes[index]! < (entry.maxSize ?? Number.MAX_SAFE_INTEGER);
				}
				// 收缩模式要求收缩权重大于 0 且当前尺寸高于下限，缺省收缩权重为 1。
				return (entry.shrink ?? 1) > 0 && sizes[index]! > (entry.minSize ?? 0);
			});
		// 没有可调整项就结束，允许留下未分配的量，避免死循环。
		if (candidates.length === 0) return;

		// reduce 求本轮总权重，sum 是累加器；后面的 0 是起始和。
		const totalWeight = candidates.reduce((sum, { entry, index }) => {
			// 增长只用 grow；收缩用 shrink 乘至少为 1 的当前尺寸，大项通常承担更多缩减。
			return sum + (mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, sizes[index]!));
			// 初始总权重为 0，遍历完得到本轮权重之和。
		}, 0);
		// 记录本轮实际变化量，用于判断是否还能继续。
		let distributed = 0;
		// 按候选项原顺序尝试分配。
		for (const { entry, index } of candidates) {
			// 前面的项已用完需求时立即退出本轮。
			if (remaining <= 0) break;
			// 按当前尺寸再次求这一项的权重；收缩时权重可能随上一轮变化而改变。
			const weight = mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, sizes[index]!);
			// 按当前 remaining 和本轮总权重估算份额，向下取整且至少尝试 1 个单位，避免小比例一直取成 0。
			const proposed = Math.max(1, Math.floor((remaining * weight) / totalWeight));
			// 计算当前项在对应方向上最多还能调整多少。
			const capacity =
				// 增长方向取距离最大尺寸的差。
				mode === "grow"
					? // 上限减现有尺寸；未配置上限则用最大安全整数。
						(entry.maxSize ?? Number.MAX_SAFE_INTEGER) - sizes[index]!
					: // 收缩方向取现有尺寸减下限。
						sizes[index]! - (entry.minSize ?? 0);
			// 实际变化不能超过剩余需求、建议份额或当前容量中的任何一个。
			const delta = Math.min(remaining, proposed, capacity);
			// 容量不足或没有正变化时跳过这一项。
			if (delta <= 0) continue;
			// 原地加上 delta，或在收缩模式减去 delta；只改变对应的尺寸元素。
			sizes[index] = sizes[index]! + (mode === "grow" ? delta : -delta);
			// 从未分配总量中扣除实际调整量，因此后续项使用更小的 remaining。
			remaining -= delta;
			// 累积本轮确实调整过的数量。
			distributed += delta;
		}
		// 本轮没有进展就结束，不无限重复尝试同一批项。
		if (distributed === 0) return;
	}
}

// 从自然尺寸与配置计算每个孩子的主轴尺寸，返回新数组，不修改 entries 或 intrinsicSizes。
// 先决定初始尺寸并夹范围；availableSize 缺省时直接返回，否则扣间距后增长或收缩。例：VStack 的普通 render 不限高度，传 undefined 就不会为了填满屏幕而 grow；有上下限时结果不保证恰好填满可用区域。
export function allocateStackSizes(
	// 条目按孩子顺序提供尺寸规则，只读数组约束仅在编译期生效。
	entries: readonly StackLayoutEntry[],
	// 每个孩子测得的自然尺寸；某一项缺失时使用 0。
	intrinsicSizes: readonly number[],
	// 可用主轴总尺寸，undefined 表示没有这条方向上的整体限制。
	availableSize: number | undefined,
	// 孩子之间的间距，由调用方使用相同规则绘制。
	gap: number,
	// 返回与 entries 一一对应的尺寸数组。
): number[] {
	// map 创建新尺寸数组，不在原条目上写入计算结果。
	const sizes = entries.map((entry, index) =>
		// 每个初始尺寸先经过上下限夹取。
		clampSize(
			// 没有 basis 或为 "auto" 就使用自然尺寸；数字 basis 优先，?? 仅在自然尺寸缺失时给 0。
			entry.basis === undefined || entry.basis === "auto" ? (intrinsicSizes[index] ?? 0) : entry.basis,
			// 把对应条目传给 clampSize，读取它的 min/max。
			entry,
		),
	);
	// 无限定总尺寸时不进入增长/收缩阶段，直接采用各自初始值。
	if (availableSize === undefined) return sizes;

	// 总尺寸先向下取整，再扣掉 n-1 个间距；可分给孩子的空间至少为 0。
	const contentSize = Math.max(0, Math.floor(availableSize) - Math.max(0, entries.length - 1) * gap);
	// 求所有当前尺寸之和，reduce 的初始值为 0。
	const total = sizes.reduce((sum, size) => sum + size, 0);
	// 总量不足时原地增长，需求量为剩余空间；没有可增长项时保持空余。
	if (total < contentSize) distribute(sizes, entries, contentSize - total, "grow");
	// 总量超出时原地收缩，需求量为超出部分；所有项到下限后仍可能超出。
	else if (total > contentSize) distribute(sizes, entries, total - contentSize, "shrink");
	// 返回分配后的数组，调用方负责把这些尺寸转换为坐标与文本行。
	return sizes;
}
