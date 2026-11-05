// HStack 将孩子从左到右组合成终端行；先测自然宽度，再分列宽、重渲染并拼接，上层 TUI 才写终端。
// compositeTuiLine 按终端列合成文本并处理 ANSI/宽字符边界，而非简单拼接字符串。
import { compositeTuiLine } from "../tui.ts";
// 按显示列测量，不能用 string.length 代替中文或 ANSI 文本的列宽。
import { visibleWidth } from "../utils.ts";
// 复用堆叠配置、尺寸分配与可见性筛选；type 标记的名字只参与编译期检查。
import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

// 继承公共孩子列表和布局协议，本类实现横向的普通行渲染。
export class HStack extends Stack {
	// as const 保留字面量标签，用于 layout.ts 区分横排，不会把对象冻结。
	protected readonly layoutType = "hstack" as const;

	// 创建横排容器，输入可选孩子和选项，无返回值，只由父类保存并规范配置。例：new HStack([left, right], {gap: 1}) 在两项之间留一列，不在构造时绘制。
	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		// 让 Stack 同步登记孩子与各自的尺寸规则。
		super(children, options);
	}

	// 以给定总列宽渲染横排文本，无终端写入：筛选、测宽、分配、按分配宽度重渲染，最后逐行合成。
	// 例：两个两行孩子会在对应行左右并排；高度取最高孩子，center/end 通过空白偏移对齐。这里没有真实视口高度或全帧渲染缓存，回调和孩子 render 的错误会向上传播。
	override render(width: number): string[] {
		// 总宽度至少取 1；此处没有向下取整，正常由宿主传入终端整数列数。
		const safeWidth = Math.max(1, width);
		// 普通渲染以最大安全整数作为高度，因此 visible 回调看到的并非实际终端高度。
		const viewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
		// 得到当前可见项，保留原顺序，不修改原列表。
		const entries = visibleStackEntries(this.entries, viewport);
		// 没有可见孩子就不生成任何行，也不测尺寸。
		if (entries.length === 0) return [];

		// map 为每项测出自然宽度；回调会真实调用孩子 render。
		const intrinsicWidths = entries.map((entry) => {
			// 先让孩子在整个 safeWidth 内生成文字，作为测量依据。
			const lines = entry.component.render(safeWidth);
			// 取各行可见列数的最大值，空行数组从 0 开始累加，因此得到自然宽度 0。
			return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		});
		// 共用算法按 basis、grow/shrink、范围与间距分配列宽；受约束时可能留下空白或仍溢出。
		const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, this.gap);
		// 根据分配结果再生成每项的行数组，仍与 entries 对应。
		const rendered = entries.map((entry, index) =>
			// 宽度 0 的项直接视为空输出；其他项用自己的分配宽度重新 render，! 是编译期非空断言。
			widths[index] === 0 ? [] : entry.component.render(widths[index]!),
		);
		// 以所有孩子实际输出行数的最大值作为容器高度；空数组不会增加高度。
		const height = rendered.reduce((max, lines) => Math.max(max, lines.length), 0);
		// 创建高度对应的结果数组，每行起初为空字符串，后面再合成左右内容。
		const result = Array.from({ length: height }, () => "");
		// 跟踪当前孩子的起始列。
		let x = 0;
		// 按孩子顺序逐项绘制。
		for (let index = 0; index < rendered.length; index++) {
			// 取这一项的文本行；下标由 rendered.length 的循环边界保证。
			const lines = rendered[index]!;
			// 取得相同下标的已分配列宽。
			const childWidth = widths[index]!;
			// 默认不向下偏移，对应 start，也用于普通 render 的 stretch 情况；这里不会强迫孩子多渲染几行。
			let offset = 0;
			// 居中时把上下差值平分，取整后的偏移用于把孩子向下移动。
			if (this.align === "center") offset = Math.floor((height - lines.length) / 2);
			// 末端对齐时把全部高度差留在上方。
			else if (this.align === "end") offset = height - lines.length;
			// 只绘制这个孩子实际存在的行，不额外调用 render 补高度。
			for (let row = 0; row < lines.length; row++) {
				// 孩子局部行加上垂直偏移，得到总结果的目标行。
				const target = row + offset;
				// 超出数组范围的行跳过，避免写出目标高度。
				if (target < 0 || target >= result.length) continue;
				// 在当前行的 x 位置按 childWidth 合成，保留行内其他部分，并按 safeWidth 处理列宽边界。
				result[target] = compositeTuiLine(result[target]!, lines[row]!, x, childWidth, safeWidth);
			}
			// 下一项起始列为当前起点加分配宽度与间距；最后一次增加不会额外生成内容。
			x += childWidth + this.gap;
		}
		// 返回已合成的行数组；实际屏幕输出由调用方负责。
		return result;
	}
}
