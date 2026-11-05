// 设置面板共用的单步选择与多步流程；只组织本地输入/候选/结果回调，设置应用、保存及关闭都由调用方接手。
import {
	// 界面组件接口只约束 render/invalidate/可选输入等契约，运行时由实例实现。
	type Component,
	// 纵向容器用于单步标题/搜索/列表布局；多步类另外直接委托活动组件渲染。
	Container,
	// 本地模糊过滤/评分，不调用模型搜索。
	fuzzyFilter,
	// 读取当前配置的列表导航/确认/取消动作。
	getKeybindings,
	// 可选单行搜索框，不在导入时创建。
	Input,
	// 候选 value/label/description 的编译期结构。
	type SelectItem,
	// 实际处理列表导航、鼠标和选择回调的组件。
	SelectList,
	// 列表主列宽度等选项类型。
	type SelectListLayoutOptions,
	// 生成显式空白行。
	Spacer,
	// 普通文字布局，不解析 Markdown。
	Text,
} from "@earendil-works/pi-tui";
// 标题与列表着色从当前主题取得，回调执行时才读取颜色。
import { getSelectListTheme, theme } from "../theme/theme.ts";

// 默认主列目标范围，只有有说明列且可用宽足够时参与双列布局，不是固定面板宽。
const SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	// 主列目标下限 12，窄窗口仍会受实际可用宽限制。
	minPrimaryColumnWidth: 12,
	// 主列目标上限 32，给说明留空间。
	maxPrimaryColumnWidth: 32,
};

// 单步选择器选项，? 表示可省略，不自动做运行时默认填充。
export interface SelectSubmenuOptions {
	/** Enable type-to-search fuzzy filtering. */
	// 真值时创建搜索框并分流输入；没有实现 Focusable 焦点传递。
	searchable?: boolean;
	/** Override the select list layout (column widths). */
	// 整个 layout 对象替换默认对象，不把单个字段深合并进默认值。
	layout?: SelectListLayoutOptions;
}

/**
 * Single-step submenu that shows a titled select list.
 * With `searchable: true`, typing filters the list using fuzzy matching.
 */
// 带标题的单步选择菜单；设置列表负责嵌入与关闭，本组件只回调选值/取消/预览，不直接落盘。
export class SelectSubmenu extends Container {
	// 当前候选列表，查询变化时换成新实例。
	private selectList: SelectList;
	// 列表在 children 中的固定位置，过滤时只替换这一项。
	private listChildIndex: number;
	// 保存原 options 数组引用，未过滤候选不会丢掉。
	private allOptions: SelectItem[];
	// 保存布局原引用，不冻结它。
	private listLayout: SelectListLayoutOptions;
	// 搜索禁用时 undefined；这里没有 focused setter 把外部焦点传给它。
	private searchInput: Input | undefined;
	// 最终确认时回传字符串 value。
	private onSelectCb: (value: string) => void;
	// 取消意图，宿主决定是否关闭或退回上一步。
	private onCancelCb: () => void;
	// 可选浏览变化回调，主题菜单用它做预览，和最终确认不同。
	private onSelectionChangeCb?: (value: string) => void;

	// 保存候选/回调→搭标题说明/可选搜索→建预选列表→加帮助，返回新菜单。
	// 例 options=[off,on]、currentValue=on 会预选 on；构造不会主动预览或提交。无文件/模型请求，主题或布局错误传播，宿主负责显示和移除。
	constructor(
		// 直接显示的标题。
		title: string,
		// 非空真值说明才占正文，空白字符串仍真值。
		description: string,
		// 全部候选原数组，元素不会被这里深复制。
		options: SelectItem[],
		// 按 value 精确预选，找不到时沿列表默认位置。
		currentValue: string,
		// 确认回传 value，不回传整项。
		onSelect: (value: string) => void,
		// 取消时同步调用，不在组件内部保存设置。
		onCancel: () => void,
		// 可选光标变化预览动作，构造的 setSelectedIndex 不会触发它。
		onSelectionChange?: (value: string) => void,
		// 搜索及主列布局可整体省略。
		submenuOptions?: SelectSubmenuOptions,
	) {
		// 先初始化父容器。
		super();

		// 保存候选引用，外部后续改数组会影响下一次过滤。
		this.allOptions = options;
		// ?. 处理缺选项，?? 仅缺 layout 时用共享默认对象。
		this.listLayout = submenuOptions?.layout ?? SUBMENU_SELECT_LIST_LAYOUT;
		// 保存确认函数，暂不执行。
		this.onSelectCb = onSelect;
		// 保存取消函数。
		this.onCancelCb = onCancel;
		// 保存可选预览函数。
		this.onSelectionChangeCb = onSelectionChange;

		// Title
		// 标题强调色并加粗，水平/垂直内边距均 0。
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		// 真值说明才渲染。
		if (description) {
			// 说明前留一行。
			this.addChild(new Spacer(1));
			// 说明用弱色普通 Text。
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Search input
		// 配置允许搜索时才建搜索组件。
		if (submenuOptions?.searchable) {
			// 搜索框前留一行。
			this.addChild(new Spacer(1));
			// 初始查询为空，不额外传占位/焦点选项。
			this.searchInput = new Input();
			// Input 自身提交动作会调用此闭包，而不是在此硬编码拦截所有 Enter。
			this.searchInput.onSubmit = () => {
				// 把固定 CR 交当前列表处理；真实确认仍取决于列表键位映射，重映射后不能保证 CR 必确认。
				this.selectList.handleInput("\r");
			};
			// 将搜索框加入可见布局。
			this.addChild(this.searchInput);
		}

		// Spacer
		// 列表前留一行。
		this.addChild(new Spacer(1));

		// Select list
		// 使用全部候选和当前值创建初始列表。
		this.selectList = this.buildSelectList(options, currentValue);
		// 加入前记下列表将占用的 children 下标。
		this.listChildIndex = this.children.length;
		// 加入实际列表。
		this.addChild(this.selectList);

		// Hint
		// 帮助前留一行。
		this.addChild(new Spacer(1));
		// 下面固定帮助文案按是否搜索选择，不会随自定义键位自动改写。
		const hint = submenuOptions?.searchable
			? // 有搜索时提示输入过滤；源码中的 \u00b7 是 Unicode 转义，运行后显示为中点分隔符。
				"  Type to filter \u00b7 Enter to select \u00b7 Esc to go back"
			: // 无搜索时仅显示选择/返回说明。
				"  Enter to select \u00b7 Esc to go back";
		// 弱色显示帮助，不注册新键位。
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
	}

	// 创建列表并按 value 预选、绑定确认/取消/可选浏览回调，返回实例；例 value=b 时找 b 的下标。
	// 最多 10 候选，空选项传可见数 0；不会通过预选触发预览，无外部 IO，样式/回调异常按实际调用传播。
	private buildSelectList(options: SelectItem[], preselect: string): SelectList {
		// 选项数不足 10 用实际数；没有像其他菜单那样 Math.max(1,...)，这不是参数合法性检查。
		const list = new SelectList(options, Math.min(options.length, 10), getSelectListTheme(), this.listLayout);

		// findIndex 对 value 严格比较，找不到 -1。
		const idx = options.findIndex((o) => o.value === preselect);
		// 只在找到时设下标，不因设置预选触发 onSelect/onSelectionChange。
		if (idx !== -1) list.setSelectedIndex(idx);

		// 列表确认回传 item.value，宿主可能由此关闭菜单。
		list.onSelect = (item) => this.onSelectCb(item.value);
		// 直接把同一取消函数引用交给列表，不立即运行它。
		list.onCancel = this.onCancelCb;
		// 提供预览回调才安装选择变化监听。
		if (this.onSelectionChangeCb) {
			// 局部 const 保存已收窄为函数的引用，后面闭包可安全调用。
			const cb = this.onSelectionChangeCb;
			// 光标/鼠标改变项时同步回传 value，不自动保存。
			list.onSelectionChange = (item) => cb(item.value);
		}

		// 返回新列表，不把它自动加入 children。
		return list;
	}

	// 按查询过滤 label+description，再替换孩子列表，无返回值；例搜 fast 可命中说明里的 fast，value 本身不参与此回调。
	// 不保留旧光标：重建时预选空字符串（若有该 value 则选它，否则默认首项）；不触发初始预览或主动请求重绘，主题/过滤错误传播。
	private applyFilter(query: string): void {
		// 查询真值才走过滤，空白串会交 fuzzyFilter 但它可直接复用数组。
		const filtered = query
			? // 搜索显示标签与说明，?? 让缺说明变空串，原项引用保留。
				fuzzyFilter(this.allOptions, query, (item) => `${item.label} ${item.description ?? ""}`)
			: // 空串恢复完整候选原数组。
				this.allOptions;

		// 新列表以空 value 预选，而不是上一选中 value；找不到空 value 才沿初始首项。
		const newList = this.buildSelectList(filtered, "");
		// 原地替换固定孩子位置，标题/搜索/帮助实例不变。
		this.children[this.listChildIndex] = newList;
		// 更新当前字段，后续按键和 Input 提交闭包都读新列表。
		this.selectList = newList;
	}

	// 有搜索时先把导航/翻页/确认/取消交列表，其余交输入框后过滤；无搜索则全部交列表，无返回值。
	// 例 PageDown 不应进入查询文字；回调可关闭宿主，错误传播，组件自己没有完成锁/自动刷新或保存。
	handleInput(data: string): void {
		// 依据搜索框实例存在分流，不临时创建。
		if (this.searchInput) {
			// 实时读取全局键位。
			const kb = getKeybindings();
			// 六种列表动作 OR 组成 isNav，以下跨行是同一个表达式。
			const isNav =
				// 上移动作。
				kb.matches(data, "tui.select.up") ||
				// 下移动作。
				kb.matches(data, "tui.select.down") ||
				// 上翻页动作。
				kb.matches(data, "tui.select.pageUp") ||
				// 下翻页动作。
				kb.matches(data, "tui.select.pageDown") ||
				// 确认动作。
				kb.matches(data, "tui.select.confirm") ||
				// 取消动作，也交列表而非搜索框的 onEscape。
				kb.matches(data, "tui.select.cancel");
			// 列表动作优先于输入框编辑。
			if (isNav) {
				// 转发原始输入，让列表决定选择/回调，不在本层重复处理。
				this.selectList.handleInput(data);
			} else {
				// 其他键按 Input 规则编辑，可能调用前面设置的 onSubmit。
				this.searchInput.handleInput(data);
				// 即使只是移动搜索光标/提交且文字没变也重建列表，没有先比旧查询。
				this.applyFilter(this.searchInput.getValue());
			}
			// 无搜索时不需要过滤路由。
		} else {
			// 全部输入交 SelectList，它可忽略不认识的键。
			this.selectList.handleInput(data);
		}
	}
}

// ============================================================================
// SteppedSubmenu — reusable multi-step selector
// ============================================================================

/** One step in a {@link SteppedSubmenu}. */
// 多步菜单某一步的描述数据；回调拿到同一可变 context，类型不保证它只读或键一定齐全。
export interface SteppedSubmenuStep {
	/** Unique key \u2014 the selected value is stored in the result context under this key. */
	// 结果键名约定唯一，但运行时不查重复或隔离 __proto__ 等普通对象特殊键。
	key: string;
	/** Title shown at the top of the step. Receives prior selections. */
	// 字符串或按上下文计算标题的函数；括号让联合右侧表示一个函数类型。
	title: string | ((context: Record<string, string>) => string);
	/** Description shown below the title. Receives prior selections. */
	// 说明同样可静态或动态产生。
	description: string | ((context: Record<string, string>) => string);
	/** Build the option list for this step. Called fresh each time the step is shown. */
	// 每次进入/回退重建该步都重新计算候选，可依赖之前选择，异常直接传播。
	options: (context: Record<string, string>) => SelectItem[];
	/** Optionally pre-select a value when entering this step. */
	// 可选预选函数，返回 undefined 时 fallback 空字符串，不自动回读 context[step.key]。
	preselect?: (context: Record<string, string>) => string | undefined;
	/** Enable type-to-search fuzzy filtering for this step. */
	// 本步是否显示搜索框。
	searchable?: boolean;
	/** Override the select list layout (column widths) for this step. */
	// 本步列表布局，可替换默认主列宽配置。
	layout?: SelectListLayoutOptions;
}

// 多步流程可选配置，只约束 TS，下面没有检查步骤总数/下标/缺失的上下文键。
interface SteppedSubmenuOptions {
	/** Start at this step index (0-based), skipping earlier steps. Requires initialContext for skipped keys. */
	// 起始下标，不是“取消就不能返回更早步骤”的下界；取消仍按 stepIndex>0 回退。
	startAtStep?: number;
	/** Pre-fill selections for skipped steps. */
	// 初始上下文只在构造浅复制一次，loop 下一轮不会重新灌入它。
	initialContext?: Record<string, string>;
	/** After completing the last step, loop back to step 0 instead of closing. */
	// 末步完成后是否清空 context 并回到第 0 步。
	loop?: boolean;
}

/**
 * Generic N-step submenu built on top of {@link SelectSubmenu}.
 *
 * Each step's options can depend on prior selections via the shared context.
 * Esc goes back one step; Esc at step 0 cancels.
 * With `loop: true`, completing the final step invokes `onComplete` then returns to step 0.
 */
// 多步菜单用一个 activeComponent 代理显示/输入，未把各步菜单放入自身 children，也没有焦点/鼠标转发实现。
export class SteppedSubmenu extends Container {
	// 保存步骤数组原引用；readonly 限字段重赋，不深冻结数组。
	private readonly steps: SteppedSubmenuStep[];
	// 完成整轮时同步接收上下文浅副本。
	private readonly onComplete: (context: Record<string, string>) => void;
	// 第一步取消或非循环完成后都调用这一宿主关闭回调，所以名字不等于用户一定主动取消。
	private readonly onCancel: () => void;
	// 保存选项原引用，后续完成时仍读取 opts.loop。
	private readonly opts: SteppedSubmenuOptions;
	// 当前步骤界面，切步时替换引用，不执行自动 dispose。
	private activeComponent: Component;
	// 同轮可变普通字典，按步骤 key 写选择；Record 的 string 值类型不保证任意键运行时都已存在。
	private context: Record<string, string>;

	// 保存步骤/回调→浅复制初始上下文→构建起始步，返回新流程。例模型/级别两步选完回传 {model,level}，loop 可继续下一模型。
	// 不写配置、不自行查询模型；空 steps 或无效 startAtStep 没有兜底，可访问 undefined 抛错，用户回调异常传播。
	constructor(
		// 有序步骤数组，正常调用方应至少提供一项。
		steps: SteppedSubmenuStep[],
		// 最终结果回调，组件不等待其可能返回的 Promise。
		onComplete: (context: Record<string, string>) => void,
		// 结束流程的通知，由外层决定关闭哪个面板。
		onCancel: () => void,
		// 缺省每次调用创建空选项对象，不把显式非法 null 当缺省处理。
		opts: SteppedSubmenuOptions = {},
	) {
		// 先初始化父 Container。
		super();
		// 保存原步骤数组。
		this.steps = steps;
		// 保存完成回调。
		this.onComplete = onComplete;
		// 保存关闭回调。
		this.onCancel = onCancel;
		// 保存选项引用。
		this.opts = opts;
		// 展开初始字典做浅复制，未提供则从空对象开始，不校验跳过步骤的键是否齐全。
		this.context = { ...(opts.initialContext ?? {}) };
		// 缺起点用 0；没有范围/整数检查，buildStep 会直接取数组下标。
		this.activeComponent = this.buildStep(opts.startAtStep ?? 0);
	}

	// 按下标计算该步标题/选项/预选，生成绑定前进和回退的单步菜单，返回 Component。
	// 例第二步取消会删第二步键再回第一步，第一步旧键仍可留在 context；不自动清所有后续键或恢复预选，回调/构造错误传播。
	private buildStep(stepIndex: number): Component {
		// 直接按下标读步骤，不在此为无效位置返回占位组件。
		const step = this.steps[stepIndex];
		// 总数来自此刻 steps.length，不是编译期固定长度。
		const total = this.steps.length;
		// 多于一步才附 Step x/N，展示序号加 1；\u00b7 在运行时变成中点分隔符。
		const stepLabel = total > 1 ? `Step ${stepIndex + 1}/${total} \u00b7 ` : "";

		// 动态标题函数拿同一个上下文，可有副作用；静态文字直接采用。
		const title = typeof step.title === "function" ? step.title(this.context) : step.title;
		// 说明同理按类型分派。
		const desc = typeof step.description === "function" ? step.description(this.context) : step.description;
		// 每次展示实际调用候选工厂，不缓存上次候选。
		const items = step.options(this.context);
		// 预选回调可缺，?? 只在空缺时退空字符串，明确空串也保留。
		const preselect = step.preselect?.(this.context) ?? "";

		// 创建新 SelectSubmenu 并让闭包捕获本步下标/step。
		return new SelectSubmenu(
			// 传计算后的标题。
			title,
			// 把步骤序号和说明拼在一段文字里。
			`${stepLabel}${desc}`,
			// 传本步刚算的候选。
			items,
			// 传精确预选 value，没匹配时由单步列表决定默认位置。
			preselect,
			// 确认当前步骤后运行的闭包，输入为所选 value。
			(value) => {
				// 写共享普通字典当前步键，不自动删除其他步骤已有值。
				this.context[step.key] = value;

				// 未到末步就前进。
				if (stepIndex < total - 1) {
					// Advance to next step
					// 递归构建下一步并替换活动界面，不立即选择下一步。
					this.activeComponent = this.buildStep(stepIndex + 1);
				} else {
					// Final step \u2014 deliver result
					// 末步先回调浅副本；若抛错，下面清 context/关闭都不会执行，已写选择也不回滚。
					this.onComplete({ ...this.context });

					// 同步回调返回后才看是否循环；异步返回不会被等待。
					if (this.opts.loop) {
						// 下一轮从全新空上下文开始，不保留 initialContext 或上一轮字段。
						this.context = {};
						// 循环固定回第 0 步，不回 opts.startAtStep。
						this.activeComponent = this.buildStep(0);
					} else {
						// 非循环完成后复用关闭回调；完成结果已在前面交付。
						this.onCancel();
					}
				}
			},
			// 单步取消交这个闭包，决定回上步还是结束全流程。
			() => {
				// 只要下标大于 0 就回退，和起始 startAtStep 无关。
				if (stepIndex > 0) {
					// 仅删除当前步 key，不删除前一步已选值或所有后续残留值。
					delete this.context[step.key];
					// 重新构建前一步，options/title/preselect 都会重新调用。
					this.activeComponent = this.buildStep(stepIndex - 1);
				} else {
					// 第 0 步取消直接通知宿主，不自行清上下文字典。
					this.onCancel();
				}
			},
			// 不传浏览预览回调，只有整步确认才改 context。
			undefined,
			// 仅 searchable/layout 至少一个真值时传选项对象；属性简写保留本步原值，不执行深合并。
			step.searchable || step.layout ? { searchable: step.searchable, layout: step.layout } : undefined,
		);
	}

	// 把宽度转给当前步，返回其原行数组；例切到级别步就只渲染级别菜单，不拼自身 children，不直接写终端，错误传播。
	render(width: number): string[] {
		// 始终委托最新活动组件。
		return this.activeComponent.render(width);
	}

	// 将一段输入转给当前步，无返回值；例 Escape 可通过当前步回调切前一步，方法缺失就不操作，回调异常传播。
	handleInput(data: string): void {
		// ?. 只处理方法可缺，不验证组件是否已经关闭。
		this.activeComponent.handleInput?.(data);
	}

	// 通知当前步缓存失效，无返回值；例切主题后 invalidate 传播给现有子菜单，没有自动销毁或重建步骤，错误传播。
	invalidate(): void {
		// 可选调用组件的方法，不请求宿主重绘。
		this.activeComponent.invalidate?.();
	}
}
