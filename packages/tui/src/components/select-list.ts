// SelectList 负责候选项过滤、选中状态、键鼠操作和行渲染；宿主接收回调后决定执行什么命令，并安排终端重画。
// 这里读取可配置键位，翻页工具只计算新下标，不自动修改组件。
import { getKeybindings, getSelectPageIndex } from "../keybindings.ts";
// type 导入只描述组件接口、鼠标输入与处理意图，不会注册运行时处理器。
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
// 截断和测量按终端显示列处理，ANSI 控制序列不算文字列。
import { truncateToWidth, visibleWidth } from "../utils.ts";

// 没有布局配置时，主列的默认上下限都取 32 列。
const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
// 主文字截断预算中预留的列间距；最终 spacing 会按实际文字列宽计算，至少放一个空格。
const PRIMARY_COLUMN_GAP = 2;
// 说明列的候选空间必须严格大于 10 列才实际绘制。
const MIN_DESCRIPTION_WIDTH = 10;

// 将 CR/LF 连续换行改成单个空格并去两端空白，输入文本、返回单行描述，无副作用。例："a\nb" 变 "a b"；箭头函数的表达式就是返回值。
const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
// 把 value 夹到 min/max 之间并返回，不修改外部状态。例：clamp(40, 12, 32) 得 32；这里没有额外取整或有限性检查。
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

// 一个候选项的编译期结构；对象会由调用者提供，这个接口不校验唯一性或内容。
export interface SelectItem {
	// 实际选择值，也用于 setFilter 的前缀匹配，不等同于显示标签。
	value: string;
	// 显示标签；空字符串时会回退显示 value。
	label: string;
	// 可选说明，渲染前规范为单行，窄区域可能不显示。
	description?: string;
}

// 主题函数集合，接收文字并返回样式字符串；render 时才实际调用。
export interface SelectListTheme {
	// 接口保留的选中前缀样式函数；当前 SelectList 绘制没有调用它，而是将前缀与正文一起传 selectedText。
	selectedPrefix: (text: string) => string;
	// 给选中的整条内容加样式，包括箭头、主文字及可能的说明。
	selectedText: (text: string) => string;
	// 非选中行的说明列样式。
	description: (text: string) => string;
	// 页码提示的样式。
	scrollInfo: (text: string) => string;
	// 没有匹配项时的提示样式。
	noMatch: (text: string) => string;
}

// 自定义主文字截断回调的参数对象，字段类型仅在编译期检查。
export interface SelectListTruncatePrimaryContext {
	// 准备显示的 label 或回退的 value。
	text: string;
	// 这次真正允许正文使用的最大列数，回调返回后仍会再按它截断。
	maxWidth: number;
	// 主列整体宽度，双列时包含留给列间空白的空间。
	columnWidth: number;
	// 原始候选项引用，便于回调依据业务信息调整显示。
	item: SelectItem;
	// 当前项是否选中，可用于不同截断策略。
	isSelected: boolean;
}

// 可选布局配置；省略值通过内部 getPrimaryColumnBounds 决定。
export interface SelectListLayoutOptions {
	// 主列下限，只配置这一项时也会成为默认上限。
	minPrimaryColumnWidth?: number;
	// 主列上限，只配置这一项时也会成为默认下限；两个端点反写时内部会排序。
	maxPrimaryColumnWidth?: number;
	// 可选截断函数，输入上面的上下文、返回显示文本，不应直接写终端；结果仍受 maxWidth 限制。
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

// 实现 Component，只管理内存状态和回调；不会自动执行候选项对应的业务操作。
export class SelectList implements Component {
	// 聚焦时声明优先接收全屏视口键，上游 TUI 据此路由；readonly 是类型检查约束。
	readonly capturesViewportInput: boolean = true;
	// 保留全部候选项的数组引用。
	private items: SelectItem[] = [];
	// 当前过滤结果，初始与 items 是同一数组，过滤后产生新数组但仍引用原项。
	private filteredItems: SelectItem[] = [];
	// 过滤结果中的选中下标，通常以 0 开始，不是原始 items 的固定下标。
	private selectedIndex: number = 0;
	// 左键按下时记录的项，click 优先使用它，避免选中居中后页面移动导致激活另一项。
	private mousePressedIndex: number | undefined;
	// 最多显示的候选行数，不含额外的页码提示；构造时必传参数会覆盖这里的初值。
	private maxVisible: number = 5;
	// 保存主题回调，不在字段赋值时绘制。
	private theme: SelectListTheme;
	// 保存列宽和自定义截断配置。
	private layout: SelectListLayoutOptions;

	// 可选选择回调，接收原项引用并返回 void；只有确认/点击才调用，不是移动选择就执行。
	public onSelect?: (item: SelectItem) => void;
	// 可选取消回调，无参数，宿主自行关闭列表或面板。
	public onCancel?: () => void;
	// 可选光标选择变化通知，与真正确认 onSelect 区分。
	public onSelectionChange?: (item: SelectItem) => void;

	// 创建选择列表，输入候选项、可见行数、主题和可选布局，只保存引用和配置，不通知选择或请求绘制。
	// 例：new SelectList(items, 5, theme) 最多生成五条候选行，另外可能加页码；maxVisible 未在这里取整/校验，构造没有显式返回语句。
	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout: SelectListLayoutOptions = {}) {
		// 保存原候选数组，不克隆每个项。
		this.items = items;
		// 尚未过滤时直接共享原数组。
		this.filteredItems = items;
		// 保存调用方传来的最大可见行数。
		this.maxVisible = maxVisible;
		// 保存主题对象引用，之后渲染时调用其方法。
		this.theme = theme;
		// 保存布局配置引用。
		this.layout = layout;
	}

	// 按 value 的不区分大小写前缀过滤，返回 void；生成结果数组并把选择重置到 0，不触发 onSelectionChange。
	// 例：filter="ab" 匹配 value="ABC"，不按 label 模糊搜索；空串会保留所有候选项，不请求宿主重画。
	setFilter(filter: string): void {
		// filter 对每个原项执行 startsWith；这里每次回调都计算小写过滤词，保留匹配项引用和原顺序。
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		// 新的过滤结果从第一项选起，即使结果为空也设为 0。
		this.selectedIndex = 0;
	}

	// 直接设置过滤结果的选中下标，返回 void，不通知回调或重画。例：传超出末尾的整数会夹到末项；空结果设为 0，这里没有把小数取整。
	setSelectedIndex(index: number): void {
		// 先按数组末下标夹取，再确保至少为 0；number 类型本身不保证传入值有限或为整数。
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	// 实现缓存失效接口，无参数/返回值；本类不缓存渲染行，因此为空操作。例：主题切换后宿主可统一调用。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 返回当前列表的文本行，不写终端：空列表提示，否则计算主列宽、可见范围、逐项渲染，并按需加页码。
	// 例：12 项、maxVisible=5 时只绘一段五项，再加当前/总数提示；主题和自定义截断回调抛错向上传播，方法不执行选择业务。
	render(width: number): string[] {
		// 创建本次输出数组。
		const lines: string[] = [];

		// If no items match filter, show message
		// 没有匹配项时只显示无匹配提示。
		if (this.filteredItems.length === 0) {
			// 调用主题样式函数；这个分支未再按 width 截断提示。
			lines.push(this.theme.noMatch("  No matching commands"));
			// 空结果分支提前返回，不计算列宽或范围。
			return lines;
		}

		// 基于全部过滤结果的主文字计算列宽，不仅测当前可见项。
		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		// 解构得到要绘制的半开下标范围，尽量让当前选项居中。
		const { startIndex, endIndex } = this.getVisibleRange();

		// Render visible items
		// 按候选下标遍历可见段。
		for (let i = startIndex; i < endIndex; i++) {
			// 取出对应原项引用。
			const item = this.filteredItems[i];
			// 没有对应项时跳过，不调用 renderItem。
			if (!item) continue;

			// 当前下标等于选中下标时加选中样式。
			const isSelected = i === this.selectedIndex;
			// 有非空说明才进行换行规范化，缺省或空说明用 undefined。
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			// renderItem 生成一整条候选字符串，再追加到结果。
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		// Add scroll indicators if needed
		// 顶部或底部还有未显示项时加页码提示；候选行数本身仍不变。
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			// 模板插值把 0 基下标加 1，作为面向用户的当前序号。
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			// 预留两列余量，超长直接截断不加省略标记，再套页码样式。
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		// 返回本次生成的行数组，无跨次缓存。
		return lines;
	}

	// 接收局部鼠标事件，返回处理/焦点/重画意图或 undefined；滚轮每次移动一项，按下选中，点击确认。
	// 例：按下第 5 项引发可见范围居中后，click 仍优先激活按下时那项；不响应悬停，回调异常向上传播。实际重画与焦点由宿主执行。
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 空列表没有可选择项，所有鼠标事件直接略过。
		if (this.filteredItems.length === 0) return undefined;
		// 仅有非零 wheelDelta 的滚轮事件进入移动分支。
		if (event.type === "wheel" && event.wheelDelta) {
			// 只取方向，将滚轮幅度压成单步；不按绝对 delta 一次移动多项。
			const delta = event.wheelDelta < 0 ? -1 : 1;
			// 保存旧下标，随后判断是否真的变化。
			const previousIndex = this.selectedIndex;
			// 鼠标滚轮在首末项夹住，不像键盘上下会循环。
			this.selectedIndex = Math.max(0, Math.min(this.filteredItems.length - 1, this.selectedIndex + delta));
			// 实际变化才通知光标选择回调。
			if (this.selectedIndex !== previousIndex) this.notifySelectionChange();
			// 标记已处理；只有变化时请求渲染，抵达边界时显式 render:false 抑制宿主默认重画。
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// Hover must not change selection: the visible range is centered on it.
		// 只处理左键 press/click；move、drag、release 等返回 undefined，避免悬停改变居中范围。
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		// 按当前选择取得可见候选范围。
		const { startIndex, endIndex } = this.getVisibleRange();
		// 把组件内行坐标加上范围起点，换成候选下标；本组件没有顶部搜索行。
		const itemIndex = startIndex + event.y;
		// 页码行、范围上方或下方不属于候选项。
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;

		// 按下只选择与记录目标，不立即触发 onSelect。
		if (event.type === "press") {
			// 记住当时命中的项，供随后 click 使用。
			this.mousePressedIndex = itemIndex;
			// 与当前选中项不同才改状态并通知。
			if (this.selectedIndex !== itemIndex) {
				// 更新过滤结果中的选中下标。
				this.selectedIndex = itemIndex;
				// 同步执行可选变化通知。
				this.notifySelectionChange();
			}
			// 返回处理与焦点请求；没有直接调用 TUI.setFocus。
			return { handled: true, focus: true };
		}
		// click 才是激活阶段。
		if (event.type === "click") {
			// ?? 在未记录按下项时采用本次命中项；已记录时用原目标，防止可见范围移动造成错选。
			const clickedIndex = this.mousePressedIndex ?? itemIndex;
			// 消费完记录后清空，下次独立点击重新确定。
			this.mousePressedIndex = undefined;
			// 记录此次选择是否改变。
			const changed = this.selectedIndex !== clickedIndex;
			// 写入点击目标下标。
			this.selectedIndex = clickedIndex;
			// 改变时通知选择变化。
			if (changed) this.notifySelectionChange();
			// 按更新后的下标读取当前过滤结果中的项。
			const selectedItem = this.filteredItems[this.selectedIndex];
			// 仍有项时可选调用 onSelect；不会因缺少回调报错，不验证按下后列表是否曾被外部替换。
			if (selectedItem) this.onSelect?.(selectedItem);
			// 返回已处理，宿主决定默认的 click 重画行为。
			return { handled: true };
		}
		// 未进入前面分支时返回未处理。
		return undefined;
	}

	// 按配置处理上下循环、翻页、确认与取消，无返回值；修改选中状态并同步调用相应回调，不主动请求重画。
	// 例：非空列表首项按“上”绕到末项；翻页到边界后不重复通知。空列表的上下分支没有单独阻止下标变化，通知方法会检查是否实际取得项，不保证任意输入后下标始终有效。
	handleInput(keyData: string): void {
		// 读取当前全局键位管理器，配置可改变具体按键。
		const kb = getKeybindings();
		// 预先识别翻页键并计算夹在首末范围的新下标；普通键得到 undefined。
		const pageIndex = getSelectPageIndex(kb, keyData, this.selectedIndex, this.filteredItems.length, this.maxVisible);
		// Up arrow - wrap to bottom when at top
		// 先匹配向上动作，分支优先级高于翻页。
		if (kb.matches(keyData, "tui.select.up")) {
			// 首项绕到末项，其余减 1；空列表时这里可能变为 -1。
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			// 调用通知辅助方法；没有有效项时辅助方法不执行用户回调。
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		// 再匹配向下动作。
		else if (kb.matches(keyData, "tui.select.down")) {
			// 末项绕回 0，其余加 1，使用过滤列表长度判断。
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			// 通知当前项，方法内部检查项和回调是否存在。
			this.notifySelectionChange();
		}
		// Page up/down - move by one visible page, clamped to the list bounds
		// 已识别翻页键才进入此分支，undefined 不能用作选中下标。
		else if (pageIndex !== undefined) {
			// 空列表或翻页后没有变化直接结束，不通知。
			if (this.filteredItems.length === 0 || pageIndex === this.selectedIndex) return;
			// 采用辅助函数计算的下标。
			this.selectedIndex = pageIndex;
			// 通知变化。
			this.notifySelectionChange();
		}
		// Enter
		// 确认动作只触发选择回调，不改变过滤条件。
		else if (kb.matches(keyData, "tui.select.confirm")) {
			// 读取当前选中项。
			const selectedItem = this.filteredItems[this.selectedIndex];
			// 项和回调同时存在才执行。
			if (selectedItem && this.onSelect) {
				// 同步把原项引用交给调用方；回调的业务和异常由调用方决定。
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		// 取消动作由配置决定具体按键，原英文提示仅描述常见默认键。
		else if (kb.matches(keyData, "tui.select.cancel")) {
			// 检查可选回调已设置。
			if (this.onCancel) {
				// 通知宿主取消，不在组件内自动移除自身。
				this.onCancel();
			}
		}
	}

	// 计算可见候选下标区间，返回 startIndex/endIndex，不改状态。
	// 例：12 项、最大 5 行、选中下标 6 时尽量从下标 4 开始显示；前后端夹住边界，endIndex 不包含在结果内，输入行数预期有效。
	private getVisibleRange(): { startIndex: number; endIndex: number } {
		// 起点既不能为负，也不能让末页超过列表末尾，下面构成 Math.max 调用。
		const startIndex = Math.max(
			// 下限为 0。
			0,
			// 先试“当前项减半页”，再限制到列表长度减页长；floor 让半页偏移按整数行计算。
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		// 返回一个范围对象，而非切片数组。
		return {
			// 起点采用刚算出的值。
			startIndex,
			// 终点为起点加最大可见项数，但不能超过过滤结果长度。
			endIndex: Math.min(startIndex + this.maxVisible, this.filteredItems.length),
		};
	}

	// 生成单个候选行：宽屏且有足够描述空间时双列，否则只画主文字；返回字符串，不改选择状态。
	// 例：短主文字与长主文字都用统一主列宽对齐说明；选中行整体套 selectedText，非选中说明单独着色，回调异常向上传播。
	private renderItem(
		// 原始候选项，用于显示和自定义截断。
		item: SelectItem,
		// 是否选中，决定箭头和整行样式。
		isSelected: boolean,
		// 宿主给出的整条行宽。
		width: number,
		// 已经规范化的说明或 undefined。
		descriptionSingleLine: string | undefined,
		// 根据整份过滤结果确定的主列目标宽度。
		primaryColumnWidth: number,
	): string {
		// 选中时用箭头加空格，否则用两个空格，当前实现不调用 selectedPrefix。
		const prefix = isSelected ? "→ " : "  ";
		// 计算前缀实际占列，不以字节数或字符长度估算。
		const prefixWidth = visibleWidth(prefix);

		// 有非空说明且总宽严格大于 40，才尝试双列。
		if (descriptionSingleLine && width > 40) {
			// 主列不超过可容纳范围，至少取 1，并为前缀和后部保留空间。
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			// 主文字可用列数从主列扣掉固定间距，至少保留 1。
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			// 调用自定义或默认主文字截断逻辑，传入正文宽和完整列宽。
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			// 测最终主文字的显示列数，供对齐计算使用。
			const truncatedValueWidth = visibleWidth(truncatedValue);
			// 补到统一列宽，至少一个空格；repeat 的数量按列计算，此处空格单个恰占一列。
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			// 说明起点等于前缀列宽、主文字列宽及空格数之和。
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			// 从总宽扣掉说明起点和额外两列余量，得到说明可用空间。
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			// 空间必须严格超过阈值，等于 10 列也会退回单列。
			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				// 说明直接截断，不带省略标记。
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				// 选中时主文字和说明一起应用选择样式。
				if (isSelected) {
					// 模板只负责组合整行，然后调用主题函数；没有在此额外调用 description。
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				// 非选中时只给空格与说明套说明样式。
				const descText = this.theme.description(spacing + truncatedDesc);
				// 主文字保持原样，与前缀和样式说明组合返回。
				return prefix + truncatedValue + descText;
			}
		}

		// 双列条件未满足，改用一整段主文字空间，仍预留两列余量。
		const maxWidth = width - prefixWidth - 2;
		// 单列时把可用宽度同时作为 maxWidth 与 columnWidth 传给截断回调。
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		// 选中单列需要整行选择样式。
		if (isSelected) {
			// 将箭头与主文字组合后上样式。
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		// 非选中单列只返回前缀和主文字。
		return prefix + truncatedValue;
	}

	// 按过滤后所有候选的显示文字计算主列目标宽，返回夹在上下限中的列数，不改布局配置。
	// 例：文字最长 40 列但上限 32，最终取 32；计算调用 getDisplayValue，不调用自定义截断函数。
	private getPrimaryColumnWidth(): number {
		// 读取有效上下限，支持配置端点反写。
		const { min, max } = this.getPrimaryColumnBounds();
		// reduce 从 0 累计最宽主列需求；回调只测文字。
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			// 每项需求为 label/value 的可见宽加固定列间距，再取最大值。
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
			// 初始最大需求为 0，空数组时保持 0。
		}, 0);

		// 把测得需求夹在有效区间。
		return clamp(widestPrimary, min, max);
	}

	// 从可选配置推导主列 min/max，返回新对象，无副作用。
	// 例：仅 max=20 时两端都为 20；min=30/max=10 时排成 10..30，至少为 1，但不额外取整或排除 NaN。
	private getPrimaryColumnBounds(): { min: number; max: number } {
		// 先确定原始下限，表达式在下一行继续。
		const rawMin =
			// 下限缺省依次回退到上限、默认 32，?? 不把数值 0 当缺失。
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		// 再确定原始上限。
		const rawMax =
			// 上限缺省依次回退到下限、默认 32。
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		// 组成有效区间。
		return {
			// 取两个端点中较小者作为 min，并至少为 1。
			min: Math.max(1, Math.min(rawMin, rawMax)),
			// 取较大者作为 max，并至少为 1。
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	// 按项取得显示文字后执行可选自定义截断，再统一截到 maxWidth，返回字符串，不修改项。
	// 例：自定义函数返回一个带省略符的标签，最后仍按可见列约束一次；isSelected/columnWidth 供回调使用，异常向上传播。
	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		// label 非空则用它，否则回退 value。
		const displayValue = this.getDisplayValue(item);
		// 根据是否提供函数选择截断路径，下面是跨行三元表达式。
		const truncatedValue = this.layout.truncatePrimary
			? // 有自定义函数就实际调用它，而非仅保存回调。
				this.layout.truncatePrimary({
					// 传准备显示的原文。
					text: displayValue,
					// 属性简写传正文最大列数。
					maxWidth,
					// 传完整主列宽，用于列对齐策略。
					columnWidth,
					// 传原候选对象引用。
					item,
					// 传当前是否选中。
					isSelected,
				})
			: // 没有自定义函数时按列直接裁掉超出部分，不加省略标记。
				truncateToWidth(displayValue, maxWidth, "");

		// 对两条路径的结果都再做一次宽度限制，防止自定义函数返回超长文字；不是内容格式或安全校验器。
		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	// 选取显示文字，输入候选项、返回字符串，无副作用。例：label=""、value="run" 时显示 run；|| 把空标签视作需回退。
	private getDisplayValue(item: SelectItem): string {
		// 标签 truthy 则用标签，否则用实际值。
		return item.label || item.value;
	}

	// 同步通知当前选择，无参数、无返回值；只有当前下标有项且设置了回调才执行。例：过滤结果为空时静默跳过，不创建虚拟项，回调异常向上传播。
	private notifySelectionChange(): void {
		// 按当前过滤结果和选中下标读取项。
		const selectedItem = this.filteredItems[this.selectedIndex];
		// 同时检查项与可选处理函数。
		if (selectedItem && this.onSelectionChange) {
			// 把原项引用交给回调，不复制或改写它。
			this.onSelectionChange(selectedItem);
		}
	}

	// 读取当前选中项，返回原对象或 null，无副作用。例：空列表或无有效下标时为 null；不通过这个调用修正下标。
	getSelectedItem(): SelectItem | null {
		// 读取过滤结果中的当前项，可能缺失。
		const item = this.filteredItems[this.selectedIndex];
		// 有效对象为 truthy，缺失则返回 null，与内部可选字段的 undefined 约定区分。
		return item || null;
	}
}
