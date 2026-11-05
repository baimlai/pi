// SettingsList 显示和修改设置，可带搜索与子菜单；改变值时同步回调宿主，真正保存配置由宿主决定。
// fuzzyFilter 用标签做模糊筛选和排序，与 SelectList 的 value 前缀匹配不同。
import { fuzzyFilter } from "../fuzzy.ts";
// 读取可配置键位与翻页下标计算；具体按键不是在本组件里硬编码的。
import { getKeybindings, getSelectPageIndex } from "../keybindings.ts";
// type 导入只约束组件与鼠标事件结构，不注册事件。
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
// 按终端显示列测量、截断与折行，保留 ANSI 样式。
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
// 搜索使用同包单行 Input，主列表负责把未消费按键传给它。
import { Input } from "./input.ts";

// 一条设置的编译期结构；保留调用方传入对象，组件会直接改 currentValue，不自动持久化到文件。
export interface SettingItem {
	/** Unique identifier for this setting */
	// 用于查找与 onChange 的标识；唯一性是调用方约定，这里不做重复检测。
	id: string;
	/** Display label (left side) */
	// 左侧显示名称，也是搜索匹配的文字。
	label: string;
	/** Optional description shown when selected */
	// 选中该项时在列表后额外显示的说明，可多行折行。
	description?: string;
	/** Current value to display (right side) */
	// 右侧当前显示值，也是打开子菜单时的初始值。
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	// 可选循环值列表，确认时依次切换；有 submenu 时优先走子菜单，不走循环。
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback.
	 *  done() accepts an optional selectedValue and an optional navigateTo id to move the cursor after close. */
	// 可选的子菜单工厂函数；调用后返回 Component，函数声明本身并未打开菜单。
	submenu?: (
		// 当前值传给子菜单，供它自行确定初始选择。
		currentValue: string,
		// 关闭回调：可选提交值和可选 navigateTo 标识；返回 void，没传值只关闭，不自动代表撤销外部副作用。
		done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
		// 工厂返回子菜单组件，后续由 SettingsList 转发 render 和输入；没有自动 dispose 协议。
	) => Component;
}

// 主题接口只约束回调签名，渲染时才执行函数，异常向上传播。
export interface SettingsListTheme {
	// 给左侧标签着色，selected 表明当前是否被选中。
	label: (text: string, selected: boolean) => string;
	// 给右侧值着色。
	value: (text: string, selected: boolean) => string;
	// 给选中项下方的说明着色。
	description: (text: string) => string;
	// 选中行的文字前缀，宽度用 visibleWidth 测量。
	cursor: string;
	// 给空结果、页码和快捷键提示加样式。
	hint: (text: string) => string;
}

// 组件选项接口，省略时由构造采用默认值。
export interface SettingsListOptions {
	// 是否创建搜索输入，默认 false；布尔字段的类型并不负责运行时验证。
	enableSearch?: boolean;
}

// 实现 Component 的有状态列表，没有跨帧行缓存；菜单回调和状态变化不会在这里直接写终端。
export class SettingsList implements Component {
	// 聚焦后声明优先处理全屏视口输入，上游据此避免把列表导航误当背景滚动。
	readonly capturesViewportInput: boolean = true;
	// 全部设置项数组引用，元素可被直接更新。
	private items: SettingItem[];
	// 搜索后的项数组，元素仍是原对象，空搜索可直接共享 items 数组。
	private filteredItems: SettingItem[];
	// 主题回调与前缀配置的引用。
	private theme: SettingsListTheme;
	// 当前显示数组中的选中下标，不是原始数组里固定不变的下标。
	private selectedIndex = 0;
	// 按下时的项下标，click 时复用以防居中滚动改变命中行。
	private mousePressedIndex: number | undefined;
	// 最多显示的候选行数，不包含搜索、说明与快捷提示行。
	private maxVisible: number;
	// 值变化通知，参数为设置 id 和新值；不是每次移动选择都调用。
	private onChange: (id: string, newValue: string) => void;
	// 取消主面板的回调，是否关闭界面由调用方决定。
	private onCancel: () => void;
	// 启用搜索才创建，? 表示尚无对象时为 undefined。
	private searchInput?: Input;
	// 搜索开关固定由构造配置初始化。
	private searchEnabled: boolean;

	// Submenu state
	// 当前子菜单，null 表示主列表显示；没有 dispose 时关闭只放弃引用。
	private submenuComponent: Component | null = null;
	// 打开子菜单前的显示下标，普通关闭后用来恢复选择。
	private submenuItemIndex: number | null = null;
	// 关闭后希望跳转并激活的设置标识，null 表示没有跳转请求。
	private navigateAfterClose: string | null = null;

	// 创建列表，输入设置、可见项数、主题、修改/取消回调和选项，保存引用并按需创建 Input，不请求重画。
	// 例：设置 values=["off","on"]，确认可切换值并通知 onChange；启用搜索后还会绘一条输入行。构造无显式返回语句，未验证项唯一性或 maxVisible 整数范围。
	constructor(
		// 调用方提供的原设置项，可被本实例更新 currentValue。
		items: SettingItem[],
		// 指定一页最多显示多少设置项。
		maxVisible: number,
		// 提供显示样式回调。
		theme: SettingsListTheme,
		// 提交值变化时同步调用，真正写磁盘由外部完成。
		onChange: (id: string, newValue: string) => void,
		// 主列表取消时同步调用。
		onCancel: () => void,
		// 可选设置，默认新建空对象。
		options: SettingsListOptions = {},
	) {
		// 保存原数组，不拷贝条目。
		this.items = items;
		// 最初还没过滤，两个字段指向同一数组。
		this.filteredItems = items;
		// 保存可见项数，不在这里规范数值。
		this.maxVisible = maxVisible;
		// 保存主题引用。
		this.theme = theme;
		// 保存修改回调，不在构造时调用。
		this.onChange = onChange;
		// 保存取消回调。
		this.onCancel = onCancel;
		// 只在 null/undefined 时采用默认 false，合法 false 保留。
		this.searchEnabled = options.enableSearch ?? false;
		// 启用搜索才构造输入组件。
		if (this.searchEnabled) {
			// 默认 Input 的 prompt 为 "> "，实际键盘事件后面会委托给它。
			this.searchInput = new Input();
		}
	}

	/** Update an item's currentValue */
	// 从全部设置按 id 找首项并更新值，无返回值；不调用 onChange、不重做搜索、不请求重画。
	// 例：宿主收到外部配置变化后 updateValue("mode","on") 同步显示数据；找不到时不操作，过滤结果引用同一对象也能看到更新。
	updateValue(id: string, newValue: string): void {
		// find 取第一个 id 相等的对象，缺失为 undefined。
		const item = this.items.find((i) => i.id === id);
		// 找到才写入。
		if (item) {
			// 直接修改原项，调用方持有同一引用时也会观察到变化。
			item.currentValue = newValue;
		}
	}

	/** Move selection to the item with the given id (no-op if not found). */
	// 把选择移动到当前显示范围内匹配 id 的第一项，无返回值，不激活或通知。
	// 例：搜索开启且目标被过滤掉时不移动；id 不存在时保留原选择，不保证后续激活必定命中该目标。
	selectItem(id: string): void {
		// 启用搜索时只查 filteredItems，否则查全部项。
		const items = this.searchEnabled ? this.filteredItems : this.items;
		// findIndex 没找到返回 -1。
		const index = items.findIndex((i) => i.id === id);
		// 找到才采用这个下标。
		if (index !== -1) {
			// 更新光标选择，不改变值。
			this.selectedIndex = index;
		}
	}

	// 传播缓存失效到当前子菜单，无参数、无返回值；主列表与搜索 Input 没有本层需清的行缓存。
	// 例：主题切换时已打开的菜单收到 invalidate，未打开则不操作；子菜单异常向上传播。
	invalidate(): void {
		// 两个 ?. 分别处理菜单缺失和方法缺失，不在此关闭菜单。
		this.submenuComponent?.invalidate?.();
	}

	// 按当前状态返回子菜单或主列表的行数组，不写终端、不更改选择。
	// 例：已打开主题子菜单时主列表整块被替换，输入也会委托过去；子菜单和主题回调错误向上传播。
	render(width: number): string[] {
		// If submenu is active, render it instead
		// 菜单存在时优先渲染它。
		if (this.submenuComponent) {
			// 返回子菜单原结果，不与主列表同时拼接。
			return this.submenuComponent.render(width);
		}

		// 无子菜单才生成主列表。
		return this.renderMainList(width);
	}

	// 生成搜索行、候选行、页码、当前说明和操作提示，输入总宽、返回新行数组，不保存行缓存。
	// 例：搜索开启会先出现输入行和一空行，最多 maxVisible 条设置之外还能多出说明/提示；主题函数与 Input 的异常向上传播。
	private renderMainList(width: number): string[] {
		// 建立输出数组，string[] 限制元素类型。
		const lines: string[] = [];

		// 开关启用且对象已创建才画搜索区。
		if (this.searchEnabled && this.searchInput) {
			// 展开 Input 的渲染行，追加到列表最上方。
			lines.push(...this.searchInput.render(width));
			// 搜索区与候选项之间插一空行，鼠标定位据此扣两行。
			lines.push("");
		}

		// 原始设置数组为空时使用“无设置”提示，而不是“无匹配”。
		if (this.items.length === 0) {
			// 此提示直接加样式，当前分支没有另行截到 width。
			lines.push(this.theme.hint("  No settings available"));
			// 只有启用搜索时，空设置分支还显示操作提示。
			if (this.searchEnabled) {
				// addHintLine 原地追加空行与提示。
				this.addHintLine(lines, width);
			}
			// 空设置分支返回，不继续计算标签宽度。
			return lines;
		}

		// 选择搜索结果或原列表作为显示集合。
		const displayItems = this.getDisplayItems();
		// 原始有设置但搜索无匹配时走这里。
		if (displayItems.length === 0) {
			// 先套提示样式再按可见列截断，沿用默认省略标记。
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			// 无匹配也显示操作提示。
			this.addHintLine(lines, width);
			// 提前返回，不访问选中条目。
			return lines;
		}

		// Calculate visible range with scrolling
		// 按当前选择计算可见半开区间。
		const { startIndex, endIndex } = this.getVisibleRange(displayItems);

		// Calculate max label width for alignment
		// 从所有原设置标签测最大宽，不随搜索结果缩窄；上限取 36，仅限制对齐目标，不提前截掉长标签。
		const maxLabelWidth = Math.min(36, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		// Render visible items
		// 逐项绘制可见范围。
		for (let i = startIndex; i < endIndex; i++) {
			// 取显示数组当前项。
			const item = displayItems[i];
			// 缺失则跳过。
			if (!item) continue;

			// 是否选中影响前缀和主题样式。
			const isSelected = i === this.selectedIndex;
			// 选中用配置 cursor，否则用两个空格。
			const prefix = isSelected ? this.theme.cursor : "  ";
			// 计算前缀显示列，ANSI 不占列。
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			// 标签不足目标宽度时补空格；超出 36 的长标签不在这里缩短，最后整行再截断。
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			// 实际调用标签样式函数，并传入选中状态。
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			// 标签和值之间固定两空格。
			const separator = "  ";
			// 按前缀、对齐目标宽、分隔符估算已用列数。
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			// 从总宽扣掉估算和两列余量，作为值的最大宽度，可能小于 0，交给截断工具处理。
			const valueMaxWidth = width - usedWidth - 2;

			// 先直接截值、不带省略符，再调用主题值函数。
			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			// 拼前缀、标签、分隔和值，再对整行截断，避免整体长于请求宽度。
			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// Add scroll indicator if needed
		// 还有未显示的项时加页码行，超过 maxVisible 的是辅助行而非候选项。
		if (startIndex > 0 || endIndex < displayItems.length) {
			// 用户看到的序号用下标加 1，总数是当前显示项数。
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			// 页码先预留两列余量直接截断，再套提示样式。
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		// 当前选中对象用于下方说明。
		const selectedItem = displayItems[this.selectedIndex];
		// 可选链同时处理没有选中项与没有说明的情况；空说明不绘制。
		if (selectedItem?.description) {
			// 说明前插入一条空行。
			lines.push("");
			// 正文给两侧留出余量后按 width-4 折行，工具保留 ANSI 样式。
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			// 逐条遍历说明折行结果。
			for (const line of wrappedDesc) {
				// 每行前加两个空格，再调用说明样式，不额外执行最后整行截断。
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		// 追加固定操作提示区，可能比候选区多占两行。
		this.addHintLine(lines, width);

		// 返回完整主列表文字。
		return lines;
	}

	// 处理局部鼠标事件，返回意图或 undefined：先转发子菜单/搜索，再处理滚轮选择、按下选择和 click 激活。
	// 例：有搜索时候选第 0 行对应组件 y=2；按下记录原项防止随后居中导致错选。实际焦点/重画由宿主执行，菜单或修改回调异常向上传播。
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 已打开子菜单时不处理主列表鼠标。
		if (this.submenuComponent) {
			// 可选直接调用菜单处理器；这里不用 dispatchMouseEvent 重新建立目标信息。
			const result = this.submenuComponent.handleMouse?.(event);
			// 有结果就复制并强制 focus:true，让代理主列表保留焦点；无结果返回 undefined。
			return result ? { ...result, focus: true } : undefined;
		}

		// 搜索开启时单独处理顶部搜索区。
		if (this.searchEnabled && this.searchInput) {
			// 第 0 行属于搜索 Input。
			if (event.y === 0) {
				// 直接把同一事件交给 Input，无坐标减法，因为它也位于本层第 0 行。
				const result = this.searchInput.handleMouse?.(event);
				// 有结果时同样要求焦点留在代理层。
				return result ? { ...result, focus: true } : undefined;
			}
			// 第 1 行是搜索后的空白，明确不命中候选项。
			if (event.y === 1) return undefined;
		}

		// 取得当前显示项列表。
		const displayItems = this.getDisplayItems();
		// 没有项时不移动或激活。
		if (displayItems.length === 0) return undefined;
		// 非零滚轮量才进入选择移动。
		if (event.type === "wheel" && event.wheelDelta) {
			// 只取方向，一次滚轮事件移动一项，不按幅度移动多项。
			const delta = event.wheelDelta < 0 ? -1 : 1;
			// 保存旧下标以决定是否请求重画。
			const previousIndex = this.selectedIndex;
			// 新下标夹在首末项，不循环，不在这里调用 onChange。
			this.selectedIndex = Math.max(0, Math.min(displayItems.length - 1, this.selectedIndex + delta));
			// 声明处理；只有选择变化才 render:true，边界时显式抑制默认重画。
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// Hover must not change selection: the visible range is centered on it.
		// 不响应悬停等事件，只处理左键按下和 click，避免选中居中范围跟着鼠标移动。
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;

		// 启用搜索时候选区域在第 2 行开始，否则在第 0 行。
		const rowOffset = this.searchEnabled ? 2 : 0;
		// 按当前选择取得候选可见范围。
		const { startIndex, endIndex } = this.getVisibleRange(displayItems);
		// 从本地 y 扣搜索区行数再加可见起点，换成项下标。
		const itemIndex = startIndex + event.y - rowOffset;
		// 页码、说明和提示不属于候选行，范围之外直接返回未处理。
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;
		// 按下仅选择并记录，不立即改设置值。
		if (event.type === "press") {
			// 记录按下的候选项。
			this.mousePressedIndex = itemIndex;
			// 更新显示数组中的选中下标。
			this.selectedIndex = itemIndex;
			// 请求焦点，宿主决定是否以及何时重画。
			return { handled: true, focus: true };
		}
		// click 才执行设置激活。
		if (event.type === "click") {
			// 优先采用按下时的下标，独立 click 才使用当前命中项。
			this.selectedIndex = this.mousePressedIndex ?? itemIndex;
			// 清除已消费的按下记录。
			this.mousePressedIndex = undefined;
			// 按当前项打开子菜单或循环值。
			this.activateItem();
			// 返回已处理，实际业务改变由 activateItem 的回调通知。
			return { handled: true };
		}
		// 其余路径返回未处理。
		return undefined;
	}

	// 处理按键，无返回值：菜单存在时全量委托，否则导航/翻页/确认/取消，剩余输入再交搜索。
	// 例：搜索串已非空时空格继续作为搜索文字，空搜索时空格激活设置；确认仍可激活。修改/菜单回调同步执行并可抛错，本方法不直接请求 TUI 重画。
	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		// 菜单存在时主列表完全让出键盘处理权。
		if (this.submenuComponent) {
			// 可选转发原始按键数据，取消后是否调用 done 由菜单实现负责，不是这里自动关闭。
			this.submenuComponent.handleInput?.(data);
			// 即使菜单没有 handleInput，也不会继续把键传给主列表。
			return;
		}

		// Main list input handling
		// 读取当前键位配置。
		const kb = getKeybindings();
		// 使用当前过滤或完整集合导航。
		const displayItems = this.getDisplayItems();
		// 翻页工具只算新下标，非翻页为 undefined，空列表的翻页仍需下面自行跳过。
		const pageIndex = getSelectPageIndex(kb, data, this.selectedIndex, displayItems.length, this.maxVisible);
		// 匹配向上动作。
		if (kb.matches(data, "tui.select.up")) {
			// 空列表立即结束，不让选中下标变为 -1。
			if (displayItems.length === 0) return;
			// 首项向上绕到末项，其余减 1。
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
			// 向下动作分支。
		} else if (kb.matches(data, "tui.select.down")) {
			// 空列表同样不改状态。
			if (displayItems.length === 0) return;
			// 末项向下绕回 0，其余加 1。
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
			// 已识别翻页键才采用辅助结果。
		} else if (pageIndex !== undefined) {
			// 空列表不选择任何项。
			if (displayItems.length === 0) return;
			// 保存夹到首末范围的新下标，不循环翻页。
			this.selectedIndex = pageIndex;
			// 下面两个条件任一成立都会激活当前项。
		} else if (
			// 配置的确认动作优先用于修改或打开菜单。
			kb.matches(data, "tui.select.confirm") ||
			// 空格只有未启用搜索或搜索内容为空时用作修改快捷键；已有搜索词时留给 Input 插入。
			(data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0))
		) {
			// 执行当前项激活，空选择会在辅助方法内跳过。
			this.activateItem();
			// 匹配取消动作时执行主列表取消回调。
		} else if (kb.matches(data, "tui.select.cancel")) {
			// 外部决定关闭面板，不在这里移除自身。
			this.onCancel();
			// 前面动作都不匹配，且存在搜索输入时才转交普通编辑按键。
		} else if (this.searchEnabled && this.searchInput) {
			// Input 处理文字、删除、光标移动等键；这里没有拦截它的原始编辑语义。
			this.searchInput.handleInput(data);
			// 随后从输入值重做模糊过滤，并重置选择，即使该按键只移动了搜索光标。
			this.applyFilter(this.searchInput.getValue());
		}
	}

	// 取得当前显示数组引用，无参数、无副作用。例：搜索开启时返回 filteredItems，不克隆对象，调用方不应把它当独立副本修改。
	private getDisplayItems(): SettingItem[] {
		// 按开关选择数组，不在这里重新计算过滤。
		return this.searchEnabled ? this.filteredItems : this.items;
	}

	// 按显示集合计算居中可见范围，返回含起点与不包含的终点的新对象，不改状态。
	// 例：12 项、页长 5、选中下标 6 时显示下标 4 到 8；readonly 仅限制本参数的数组写操作，不冻结元素。
	private getVisibleRange(displayItems: readonly SettingItem[]): { startIndex: number; endIndex: number } {
		// 起点由下限 0 和候选起点取大者。
		const startIndex = Math.max(
			// 可见起点不能小于 0。
			0,
			// 先将选择减半页，再限制末页起点，避免尾部留下不必要空洞。
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		// 终点不超过数组长度，和起点组成半开区间。
		return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, displayItems.length) };
	}

	// 激活当前项，无参数/返回值；有 submenu 就创建菜单并传 done，否则有非空 values 就循环更新并通知。
	// 例：currentValue="off"、values=["off","on"] 时变为 on；不在枚举中时从首值开始。直接改原对象，回调异常向上传播且不会回滚已写值；没有菜单/值列表就不操作。
	private activateItem(): void {
		// 从当前显示集合读取选择对象。
		const item = this.getDisplayItems()[this.selectedIndex];
		// 没有有效项就结束。
		if (!item) return;

		// 子菜单优先级高于循环值。
		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			// 保存打开前的显示下标，普通关闭时恢复。
			this.submenuItemIndex = this.selectedIndex;
			// 实际调用工厂函数并将其返回值设为当前菜单；工厂预期把 done 留给后续交互调用，不是异步 Promise。
			this.submenuComponent = item.submenu(
				// 把当前值作为菜单初始输入。
				item.currentValue,
				// 给菜单的完成回调接收可选值/跳转信息，返回 void：先更新并通知，再记跳转并关闭。例：done() 仅关闭，done("on",{navigateTo:"theme"}) 还请求跳转激活；没有一次性调用保护，异常向上传播。
				(selectedValue?: string, options?: { navigateTo?: string }) => {
					// 仅 undefined 表示未提交；空字符串是合法的新值。
					if (selectedValue !== undefined) {
						// 直接修改工厂捕获的 item 对象，而非按关闭时的当前选择重新查找。
						item.currentValue = selectedValue;
						// 同步通知外部值改变；若这里抛错，下面的菜单关闭尚未执行。
						this.onChange(item.id, selectedValue);
					}
					// 只有 truthy 的跳转 id 才保存，空字符串不会触发跳转。
					if (options?.navigateTo) {
						// 暂存目标，closeSubmenu 会消费。
						this.navigateAfterClose = options.navigateTo;
					}
					// 结束当前菜单并按记录恢复或跳转。
					this.closeSubmenu();
				},
			);
			// 没有子菜单且存在非空枚举值时才循环。
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			// 找当前值在数组中的首个位置，不存在为 -1。
			const currentIndex = item.values.indexOf(item.currentValue);
			// 加 1 再取模实现循环；-1 加 1 变 0，因此未知值跳首项。
			const nextIndex = (currentIndex + 1) % item.values.length;
			// 读取下一值，前面的非空与取模逻辑确定对应项。
			const newValue = item.values[nextIndex];
			// 先更新原项显示值。
			item.currentValue = newValue;
			// 再同步通知宿主，通知失败不会回滚 currentValue。
			this.onChange(item.id, newValue);
		}
	}

	// 结束子菜单并恢复选择或消费跳转目标，无参数/返回值；不调用 dispose。
	// 例：正常 done() 恢复原行；navigateTo 时 selectItem 后还会 activateItem，目标没有子菜单也可能循环值，找不到 id 则沿用旧选择再激活，因此不能保证一定跳到指定项。
	private closeSubmenu(): void {
		// 清掉菜单引用，主列表恢复可渲染状态，不代表菜单自己创建的资源已被释放。
		this.submenuComponent = null;
		// 有跳转请求就优先走跳转，不再恢复原下标。
		if (this.navigateAfterClose !== null) {
			// 先取出目标 id。
			const id = this.navigateAfterClose;
			// 清空待跳转字段，避免后续重复消费。
			this.navigateAfterClose = null;
			// 清空原菜单项下标。
			this.submenuItemIndex = null;
			// 尝试按 id 选择当前显示集合里的目标；不存在则不移动。
			this.selectItem(id);
			// Open the target item's submenu automatically
			// 立即激活选择到的项，可能打开菜单、循环值或不操作。
			this.activateItem();
			// 无跳转且有原下标时走恢复分支。
		} else if (this.submenuItemIndex !== null) {
			// Restore selection to the item that opened the submenu
			// 恢复原显示数组下标；这里不重新按 id 查找。
			this.selectedIndex = this.submenuItemIndex;
			// 恢复后清空记录。
			this.submenuItemIndex = null;
		}
	}

	// 按搜索文字模糊筛选标签并重置选择，无返回值；保留原项引用，不修改值或调用 onChange。
	// 例：query="md" 可按顺序匹配标签字符并按匹配分数排序；空白搜索直接复用原数组，下一次渲染显示结果。
	private applyFilter(query: string): void {
		// 把 item => item.label 作为文本提取函数交给 fuzzyFilter；实际筛选/排序在工具里，不按 id 或 currentValue 搜索。
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		// 新结果从第 0 项开始选，即使结果为空也设为 0。
		this.selectedIndex = 0;
	}

	// 向传入 lines 原地追加空行与快捷提示，无返回值，不请求宿主重画。
	// 例：搜索开启提示包含输入搜索说明；先主题着色再按 width 截断，回调异常向上传播。
	private addHintLine(lines: string[], width: number): void {
		// 提示与前面内容之间加一空行。
		lines.push("");
		// 将下面生成的完整提示行追加到同一数组。
		lines.push(
			// 最终按请求可见列宽截断，沿用工具默认省略符。
			truncateToWidth(
				// 先把所选提示文案交给主题样式函数。
				this.theme.hint(
					// 条件表达式按搜索开关选文案。
					this.searchEnabled
						? // 开启搜索使用包含输入搜索说明的固定字符串。
							"  Type to search · Enter/Space to change · Esc to cancel"
						: // 关闭搜索仅显示修改与取消说明，原文案不随自定义键位自动改写。
							"  Enter/Space to change · Esc to cancel",
				),
				// 截断的最大列数来自当前 render 宽度。
				width,
			),
		);
	}
}
