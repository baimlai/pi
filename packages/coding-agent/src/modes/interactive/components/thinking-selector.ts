// 带搜索的思考级别选择界面；普通确认和设默认是两种回调，模型设置与落盘由交互模式处理。
// 思考级别字符串联合类型，导入本身不改变模型能力。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	// 父容器纵向组织搜索框、列表和提示。
	Container,
	// 编译期焦点接口，要求 focused 属性以便传递硬件光标位置。
	type Focusable,
	// 同步按查询对候选匹配和排序，不是调用模型做语义搜索。
	fuzzyFilter,
	// 每次输入读取当前共享键位配置。
	getKeybindings,
	// 搜索输入框，保存查询文字。
	Input,
	// 列表项的值/标签/说明静态结构。
	type SelectItem,
	// 负责候选选择、键盘导航和列表行渲染。
	SelectList,
	// 主文字列宽等布局选项类型。
	type SelectListLayoutOptions,
	// 产生空行间距。
	Spacer,
	// 展示标题/说明，不解析 Markdown。
	Text,
} from "@earendil-works/pi-tui";
// 列表样式与提示前景色来自当前主题。
import { getSelectListTheme, theme } from "../theme/theme.ts";
// 上下边框随父宽渲染。
import { DynamicBorder } from "./dynamic-border.ts";
// 将可配置动作键转成首字母大写的提示文字，提示不绑定按键。
import { keyDisplayText } from "./keybinding-hints.ts";

// 主列目标范围供双列布局使用，最终仍受实际窗口宽限制。
const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	// 主列目标下限 12。
	minPrimaryColumnWidth: 12,
	// 主列目标上限 32，给说明列留空间。
	maxPrimaryColumnWidth: 32,
};

// Record 要求每个 ThinkingLevel 都有说明；其中 token 数只是界面近似文案，不是给提供商提交的精确预算。
const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	// 关闭级别的说明文字。
	off: "No reasoning",
	// 极低级别的近似说明，不执行计数。
	minimal: "Very brief reasoning (~1k tokens)",
	// 低级别文案；真正支持范围由调用方传入 availableLevels。
	low: "Light reasoning (~2k tokens)",
	// 中级别说明。
	medium: "Moderate reasoning (~8k tokens)",
	// 高级别说明。
	high: "Deep reasoning (~16k tokens)",
	// 更高级别说明。
	xhigh: "Extra-high reasoning (~32k tokens)",
	// 最高级别说明，没有在这里指定固定 token 数。
	max: "Maximum reasoning",
};

/**
 * Component that renders a thinking level selector with borders
 */
// extends 继承纵向布局，implements 只在 TS 检查焦点接口；按键由本类路由到搜索框或列表。
export class ThinkingSelectorComponent extends Container implements Focusable {
	// 搜索文字/光标由内部 Input 保存。
	private searchInput: Input;
	// 当前过滤结果列表，查询变化时会替换实例。
	private selectList: SelectList;
	// 列表在父 children 中的固定位置，便于原地替换而不重建标题。
	private selectListChildIndex: number;
	// 由可用级别生成的完整候选，不随查询丢弃。
	private allItems: SelectItem[];
	// 普通选择回调，主交互调用方通常只改本会话。
	private onSelect: (level: ThinkingLevel) => void;
	// 关闭/取消意图由宿主实现。
	private onCancel: () => void;
	// 可选设默认回调，是否持久化由宿主决定，不在此写盘。
	private onSelectAsDefault?: (level: ThinkingLevel) => void;
	// 焦点默认 false，setter 同时传给搜索框。
	private _focused = false;

	// 返回本容器记录的焦点标志，无副作用；例 TUI 可读取是否已聚焦，不自动从子组件反推。
	get focused(): boolean {
		// 直接读私有字段，get 让访问写成 selector.focused。
		return this._focused;
	}

	// 设置焦点并传给搜索 Input，无返回值；例 TUI 聚焦本面板时，输入法能定位搜索光标，不自动改变选择项。
	set focused(value: boolean) {
		// 保存外层状态。
		this._focused = value;
		// 让输入框 render 决定是否发硬件光标标记。
		this.searchInput.focused = value;
	}

	// 保存回调→按可用级别建候选→建搜索框/列表/提示并预选当前级别；不改模型设置或写配置。
	// 例 current=medium、available=[medium,high] 时 medium 带勾；移到 high 只移动选择，勾仍表示构造时当前值。
	// 过滤和主题/回调错误会传播；返回新组件，宿主负责焦点、显示和关闭。
	constructor(
		// 当前会话级别，用于勾选标记和初始选择，不会自动加入可用列表。
		currentLevel: ThinkingLevel,
		// 宿主根据实际模型能力给的候选，组件不另请求提供商。
		availableLevels: ThinkingLevel[],
		// 确认某项时调用。
		onSelect: (level: ThinkingLevel) => void,
		// 取消时调用。
		onCancel: () => void,
		// 可省略设置默认的能力。
		onSelectAsDefault?: (level: ThinkingLevel) => void,
		// 可选已有默认值，仅用于 default 标记，不决定当前光标。
		defaultThinkingLevel?: ThinkingLevel,
	) {
		// 初始化容器孩子数组。
		super();
		// 保存普通选择回调。
		this.onSelect = onSelect;
		// 保存取消回调。
		this.onCancel = onCancel;
		// 保存可选设默认回调。
		this.onSelectAsDefault = onSelectAsDefault;

		// 逐可用级别生成新候选数组，保留调用方的级别顺序。
		this.allItems = availableLevels.map((level) => ({
			// 实际回传的级别名。
			value: level,
			// 只给构造时当前级别加勾，光标箭头由 SelectList 另画。
			label: `${level === currentLevel ? "✓ " : "  "}${level}`,
			// 说明可能追加默认标记，三元表达式在下一行继续。
			description:
				// 标记持久化默认值，和当前会话值可以不同。
				level === defaultThinkingLevel ? `${LEVEL_DESCRIPTIONS[level]} · default` : LEVEL_DESCRIPTIONS[level],
		}));

		// Add top border
		// 分别在面板首尾放动态边框。
		this.addChild(new DynamicBorder());
		// 在相邻界面元素间加入一行空白，不注册计时器或输入监听。
		this.addChild(new Spacer(1));
		// 显示面板标题，内边距由外部布局与显式 Spacer 管理。
		this.addChild(new Text("Thinking Level", 0, 0));
		// 在相邻界面元素间加入一行空白，不注册计时器或输入监听。
		this.addChild(new Spacer(1));
		// 显示切换级别动作的当前按键，面板内该动作不在此绑定。
		this.addChild(new Text(`${keyDisplayText("app.thinking.cycle")} cycles thinking levels in-session`, 0, 0));
		// 在相邻界面元素间加入一行空白，不注册计时器或输入监听。
		this.addChild(new Spacer(1));

		// 创建默认搜索输入，查询初值为空。
		this.searchInput = new Input();
		// Input 的提交回调把固定 CR 转发给当前列表；是否命中列表确认仍取决于当前键位映射。
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		// 搜索框排在级别列表前。
		this.addChild(this.searchInput);
		// 在相邻界面元素间加入一行空白，不注册计时器或输入监听。
		this.addChild(new Spacer(1));

		// Create selector
		// 创建初始列表并按当前值预选，未找到时保留列表默认位置。
		this.selectList = this.buildSelectList(this.allItems, currentLevel);
		// 添加前记录即将占用的 children 下标。
		this.selectListChildIndex = this.children.length;
		// 把初始列表放入父容器。
		this.addChild(this.selectList);
		// 在相邻界面元素间加入一行空白，不注册计时器或输入监听。
		this.addChild(new Spacer(1));
		// 将下面的快捷键帮助 Text 放入面板，不注册实际按键。
		this.addChild(
			// Text 接收已着色提示，水平/垂直留白分别为下方两个 0。
			new Text(
				// 给整个帮助段使用弱化颜色。
				theme.fg(
					// 主题颜色名为 dim。
					"dim",
					// 拼出确认/设默认/取消的当前按键；即使未提供设默认回调，帮助文字仍显示该动作。
					`  ${keyDisplayText("tui.select.confirm")} to select · ${keyDisplayText("app.thinking.save")} to set as default · ${keyDisplayText("tui.select.cancel")} to cancel`,
				),
				// 第一个 0 指定左右内边距。
				0,
				// 第二个 0 指定上下内边距。
				0,
			),
		);

		// Add bottom border
		// 分别在面板首尾放动态边框。
		this.addChild(new DynamicBorder());
	}

	// 根据当前候选建新列表，尝试预选指定级别并绑定确认/取消，返回列表。
	// 例过滤后仍有 high 就保留 high 的选择，否则回到默认第一项；不通知选择或自动应用设置，样式错误可传播。
	private buildSelectList(items: SelectItem[], preselect?: ThinkingLevel): SelectList {
		// 可见候选数至少 1，否则采用全部候选长度；没有固定 5/10 行分页上限。
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), THINKING_SELECT_LIST_LAYOUT);
		// 按 value 精确找预选，不按带勾的 label。
		const currentIndex = items.findIndex((item) => item.value === preselect);
		// 仍存在该值才设置光标下标。
		if (currentIndex !== -1) {
			// 直接设下标，不触发 onSelect 或预览。
			list.setSelectedIndex(currentIndex);
		}
		// as 是类型断言，候选原由 ThinkingLevel 生成；运行时不另校验名称。
		list.onSelect = (item) => this.onSelect(item.value as ThinkingLevel);
		// 将列表取消交宿主回调，不在列表里自动移除面板。
		list.onCancel = () => this.onCancel();
		// 返回新建实例，留给调用方加入/替换孩子。
		return list;
	}

	// 按查询过滤完整列表，保留仍存在的当前值并替换孩子列表，无返回值；例搜 high 可同时匹配 high/xhigh 及说明。
	// 修改当前列表与 children，不修改 allItems；不直接请求 TUI 重绘，查询/主题异常可传播。
	private applyFilter(query: string): void {
		// 有查询才执行 fuzzyFilter，空串直接复用完整候选数组。
		const filtered = query
			? // 以值和说明为搜索文本；?? 在说明缺失时用空串，匹配结果可按分数重排。
				fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
			: // 空查询恢复完整候选，不复制数组。
				this.allItems;
		// 可选链处理空列表，断言为原候选级别或 undefined，不生成新值。
		const selectedValue = this.selectList.getSelectedItem()?.value as ThinkingLevel | undefined;
		// 新列表尝试沿用先前选择值，不把旧过滤列表的下标生搬过去。
		const newList = this.buildSelectList(filtered, selectedValue);
		// 原地替换固定孩子位置，标题/搜索框/提示保留原实例。
		this.children[this.selectListChildIndex] = newList;
		// 更新字段供后续按键使用，旧列表不再由本组件持有。
		this.selectList = newList;
	}

	// 按当前映射路由：可用设默认动作优先→上下确认取消交列表→其余交搜索再过滤。
	// 例 Ctrl+S 只有在配置匹配且提供 onSelectAsDefault 时才通知保存；光标/文字会变化，回调异常传播，不在此写盘或请求模型。
	handleInput(keyData: string): void {
		// 实时取得全局键位，用户修改配置后无需重建组件才能匹配新按键。
		const kb = getKeybindings();
		// 同一输入先尝试设默认，只有提供回调才截获它。
		if (kb.matches(keyData, "app.thinking.save") && this.onSelectAsDefault) {
			// 读取当前项，过滤为空时为 null。
			const item = this.selectList.getSelectedItem();
			// 有效项才通知宿主，不因空列表伪造一个级别。
			if (item) this.onSelectAsDefault(item.value as ThinkingLevel);
			// 该输入已由当前分支处理，不同时进入搜索框。
			return;
		}

		// 计算下面四个列表动作的任一匹配结果。
		const isNav =
			// 向上选择动作。
			kb.matches(keyData, "tui.select.up") ||
			// 向下选择动作。
			kb.matches(keyData, "tui.select.down") ||
			// 确认动作。
			kb.matches(keyData, "tui.select.confirm") ||
			// 取消动作；这里没有把 pageUp/pageDown 算入 isNav。
			kb.matches(keyData, "tui.select.cancel");
		// 上述动作交列表；其他键包括未专门路由的动作会交搜索框处理。
		if (isNav) {
			// SelectList 更新选择或调用确认/取消回调，本组件不再重复处理。
			this.selectList.handleInput(keyData);
			// 该输入已由当前分支处理，不同时进入搜索框。
			return;
		}

		// 其余输入交 Input 编辑/提交，可能同步触发前面绑定的 onSubmit。
		this.searchInput.handleInput(keyData);
		// 无论查询是否实际改变都按当前值重建列表；例如未消费的控制键也可能走此路径。
		this.applyFilter(this.searchInput.getValue());
	}

	// 返回当前过滤列表原引用，无副作用；例测试/宿主读取所选级别，查询改变后先前取得的列表可能已被替换。
	getSelectList(): SelectList {
		// 取字段最新实例，不返回深拷贝。
		return this.selectList;
	}
}
