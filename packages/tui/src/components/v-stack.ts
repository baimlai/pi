// VStack 将孩子从上到下堆叠；复用 Stack 的选项和尺寸算法，普通 render 返回文本行，layout.ts 则可读取符号节点做视口布局。
// type 标记的类型仅在开发时使用，另外几个函数和类是运行时导入。
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

// 继承共享孩子管理与节点协议，在本类实现竖排的普通文本渲染。
export class VStack extends Stack {
	// as const 保留精确的 "vstack" 字面量类型供协议识别，不会在运行时冻结实例。
	protected readonly layoutType = "vstack" as const;

	// 创建竖排容器，输入可选孩子和堆叠配置，无返回值。例：new VStack([title, body], {gap: 1}) 会在两者间留一行；构造只登记配置，不触发渲染。
	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		// 由父类规范间距并同时建立 children 与 entries 列表。
		super(children, options);
	}

	// 按给定宽度逐个渲染可见孩子，再依配置截取或补齐高度，返回连接后的行数组，不写终端。
	// 例：两项各一行且 gap=1 时返回“第一项、空行、第二项”；这条普通 render 路径不限定总高度，不执行视口滚动裁剪。孩子或可见性回调抛错会向上传播。
	override render(width: number): string[] {
		// 正文宽度至少为 1；高度用最大安全整数表示普通渲染没有真实屏幕高度限制，这里没有对 width 取整。
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		// 按这个视口调用可选 visible 回调，得到保留项的新数组。
		const entries = visibleStackEntries(this.entries, viewport);
		// 先以相同可用宽度渲染所有可见孩子，map 的结果与 entries 下标一一对应。
		const rendered = entries.map((entry) => entry.component.render(viewport.width));
		// 调用共用分配器决定各孩子保留多少行，以下参数顺序对应其声明。
		const sizes = allocateStackSizes(
			// 传入每个可见孩子的 basis、min/max 等规则。
			entries,
			// 把各孩子行数作为自然高度。
			rendered.map((lines) => lines.length),
			// 不提供总高度，因此此处不会通过 grow/shrink 去填满或收缩到视口高度。
			undefined,
			// 传入统一间距；最终仍由下面循环插入间隔行。
			this.gap,
		);
		// 创建最终输出行数组。
		const lines: string[] = [];
		// 按条目顺序读取渲染结果及分配高度。
		for (let index = 0; index < entries.length; index++) {
			// 第一项前不留间距，后续每项前加入 gap。
			if (index > 0) {
				// 每单位间距追加一个空字符串行，不填充可见字符。
				for (let gap = 0; gap < this.gap; gap++) lines.push("");
			}
			// slice 创建保留前若干行的新数组；! 只告诉类型检查器这个对应下标存在，不添加运行时断言。
			const childLines = rendered[index]!.slice(0, sizes[index]);
			// ... 将孩子行展开追加到总结果，而非把数组作为单个元素加入。
			lines.push(...childLines);
			// 若配置高度比孩子实际行数大，用空行补齐；反之多余行已由 slice 截掉。
			for (let padding = childLines.length; padding < sizes[index]!; padding++) lines.push("");
		}
		// 返回普通渲染结果，没有可见项时就是 []。
		return lines;
	}
}

// 重新导出公共选项类型，调用者可从本模块取得类型名；export type 不生成运行时值。
export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";
