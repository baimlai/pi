// /model 菜单：先展示可用模型快照，再后台刷新；搜索/当前勾/默认徽标/循环范围分开管理，真正切换与保存交给宿主。
// Model 仅为类型；modelsAreEqual 实际比较种类/provider/id，不深比较价格、URL 或对象引用。
import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	// 纵向排列孩子，父容器本身不替本类完成搜索/选择输入路由。
	Container,
	// 编译期焦点契约，setter 仍需显式传给内部输入框。
	type Focusable,
	// 本地字符模糊筛选/评分，不调用模型做语义搜索。
	fuzzyFilter,
	// 实时读取共享键位配置，避免把动作写死为某个控制字符。
	getKeybindings,
	// 根据可配置翻页键求目标下标；仅计算，不更新选择。
	getSelectPageIndex,
	// 搜索输入框，保存字符串与光标。
	Input,
	// 按行留白组件。
	Spacer,
	// 渲染普通文字并保留样式，非 Markdown。
	Text,
	// 宿主界面类型，运行时只使用传入实例的 requestRender。
	type TUI,
} from "@earendil-works/pi-tui";
// 模型运行时提供缓存快照、目录查询、刷新及错误状态；类型导入在运行 JS 中擦除。
import type { ModelRuntime } from "../../../core/model-runtime.ts";
// 与其他交互菜单共用刷新协调器，每个菜单的取消只先结束自己的等待。
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
// 分别生成额外名称和 /model 搜索评分文本。
import { getDistinctModelName, getModelSelectorSearchText } from "../model-search.ts";
// 当前主题颜色，由调用时主题状态决定。
import { theme } from "../theme/theme.ts";
// 边框按实际渲染宽度生成。
import { DynamicBorder } from "./dynamic-border.ts";
// 帮助文字由当前动作映射生成；显示提示本身不处理按键。
import { keyDisplayText, keyHint } from "./keybinding-hints.ts";

// 菜单中的模型条目：额外存身份字段方便排序/搜索，model 仍是目录原对象。
interface ModelItem {
	// 实际供应商身份，不是从 id 的斜杠路径猜出的前缀。
	provider: string;
	// 模型 id，可包含命名空间和斜杠。
	id: string;
	// 原有 any 泛型放宽 API 参数关联，不代表本类已验证所有模型字段；本类不构造请求。
	model: Model<any>;
}

// 调用方给的会话循环范围条目，保留原顺序。
interface ScopedModelItem {
	// 该范围条目的模型元数据。
	model: Model<any>;
	// 可选思考配置，本菜单刷新用 spread 保留它，但选择回调只回传 model，不直接应用此字段。
	thinkingLevel?: string;
}

// 已保存默认模型的最小身份引用，仅作标记/排序依据。
interface DefaultModelReference {
	// 默认供应商。
	provider: string;
	// 默认模型 id。
	id: string;
}

// 字符串字面量联合限制两种浏览范围；all 也是“可用快照全部”，并非所有公开模型。
type ModelScope = "all" | "scoped";

// 列表窗口最多放 10 个候选 Text；长文字仍可能折行，所以不是固定 10 个终端行。
const MAX_VISIBLE = 10;

/**
 * Component that renders a model selector with search
 */
// 模型选择面板，主交互模式用回调切换模型/写默认；组件自己只管理浏览状态和后台目录刷新。
export class ModelSelectorComponent extends Container implements Focusable {
	// 交给全屏 TUI 判断：聚焦此组件时视口键应先给列表，而非滚动背后的聊天记录。readonly 只限制 TS 重赋。
	readonly capturesViewportInput: boolean = true;
	// 搜索框引用，setter 将焦点转给它定位输入法光标。
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	// 外层焦点标志，默认未聚焦。
	private _focused = false;
	// 读取本组件保存的焦点，无副作用；例宿主检查 selector.focused，不重新从子框反推。
	get focused(): boolean {
		// get 访问器可像普通属性一样读取。
		return this._focused;
	}
	// 保存焦点并同步给搜索框，无返回值；例宿主聚焦面板后由搜索框发光标标记，不改变当前候选。
	set focused(value: boolean) {
		// 更新外层标志。
		this._focused = value;
		// 让内部 Input 的渲染跟随同一焦点值。
		this.searchInput.focused = value;
	}
	// 只放当前窗口候选和状态文字的容器。
	private listContainer: Container;
	// 全部可用快照的排序后条目。
	private allModels: ModelItem[] = [];
	// 会话范围条目，保留调用方顺序，不走 allModels 的排序。
	private scopedModelItems: ModelItem[] = [];
	// 当前 all/scoped 范围指向的候选数组。
	private activeModels: ModelItem[] = [];
	// 搜索后候选；空查询时可与 activeModels 共用同一数组。
	private filteredModels: ModelItem[] = [];
	// 当前光标下标，与模型当前标记和 default 标记是三件事。
	private selectedIndex: number = 0;
	// 构造时当前模型，用于勾和初选；浏览时不跟着光标改它。
	private currentModel?: Model<any>;
	// 共享运行时原引用，不在面板内创建另一个目录服务。
	private modelRuntime: ModelRuntime;
	// 确认模型的回调，宿主决定怎样应用。
	private onSelectCallback: (model: Model<any>) => void;
	// 可选设默认回调；主交互调用方传 persist=true，本类不直接写 settings。
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	// 取消意图，宿主负责移除面板。
	private onCancelCallback: () => void;
	// 可展示目录刷新/配置等错误，不只表示空搜索结果。
	private errorMessage?: string;
	// 初始状态文字，在后台结果返回后修改。
	private refreshStatusMessage = "Refreshing model catalogs…";
	// 仅控制状态文字颜色，不证明所有目录都完成更新。
	private refreshStatusSuccess = false;
	// 保存刷新请求宿主。
	private tui: TUI;
	// ReadonlyArray 禁止通过该类型直接 push，但不深冻结条目；本类会重新 map 到新数组。
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	// 构造时已保存的默认身份引用。
	private defaultModel?: DefaultModelReference;
	// 初始 all，构造里有会话范围时会改 scoped。
	private scope: ModelScope = "all";
	// 只有初始提供了范围时才创建范围标题。
	private scopeText?: Text;
	// 同样可缺的范围切换帮助组件。
	private scopeHintText?: Text;
	// 本面板等待刷新的控制器，超时/关闭共用它；协调器另有共享工作控制器。
	private readonly refreshAbortController = new AbortController();
	// ReturnType 获取定时器句柄类型，联合 undefined 表示尚无句柄；不是立即启动计时器。
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	// 关闭标记用于拒收晚刷新结果，不是在每次 handleInput 开头检查的终态锁。
	private closed = false;

	// 保存参数并建布局→先显示已有快照→启动一次后台刷新，返回新面板。例已有 scoped=[b,a] 时先按该顺序展示并预选当前项。
	// 可请求重绘/安装超时/触发目录与认证刷新，但不发送聊天、不直接写默认设置；同步布局异常传播，异步刷新错误通常转状态文字。
	constructor(
		// 必需界面宿主，供后台刷新请求重绘。
		tui: TUI,
		// 当前模型可空，空时没有当前模型勾。
		currentModel: Model<any> | undefined,
		// 目录/认证状态来源。
		modelRuntime: ModelRuntime,
		// 会话循环范围，不自动按 provider 重排。
		scopedModels: ReadonlyArray<ScopedModelItem>,
		// 普通确认时回传原模型元数据。
		onSelect: (model: Model<any>) => void,
		// 取消时通知宿主。
		onCancel: () => void,
		// 可选初始搜索，真值才预填，Input.setValue 不自动把光标放末尾。
		initialSearchInput?: string,
		// 可选设默认能力，缺失时不展示对应底部提示。
		onSelectAsDefault?: (model: Model<any>) => void,
		// 可选已保存默认身份，用于排序/搜索标记，不决定当前范围。
		defaultModel?: DefaultModelReference,
	) {
		// 先初始化父容器，之后才能用 this。
		super();

		// 保存宿主原引用。
		this.tui = tui;
		// 保存构造时当前模型。
		this.currentModel = currentModel;
		// 保存运行时原引用。
		this.modelRuntime = modelRuntime;
		// 先保存范围引用，loadModelsFromSnapshot 随后会构造新数组。
		this.scopedModels = scopedModels;
		// 保存默认身份，不立即应用默认模型。
		this.defaultModel = defaultModel;
		// 非空范围默认先看 scoped，空范围先看 all。
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		// 保存确认回调，不在构造时调用。
		this.onSelectCallback = onSelect;
		// 保存可选默认回调。
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		// 保存取消回调。
		this.onCancelCallback = onCancel;

		// Add top border
		// 分别在面板顶部/底部插入动态边框。
		this.addChild(new DynamicBorder());
		// 相邻界面区域之间留一行。
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		// 只有初始范围非空才创建 all/scoped 标题及提示。
		if (scopedModels.length > 0) {
			// 根据当前 scope 着色 all/scoped 字样。
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			// 将可更新标题加入布局。
			this.addChild(this.scopeText);
			// 建立跟随当前键位的切范围提示。
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			// 将提示组件加入布局。
			this.addChild(this.scopeHintText);
		} else {
			// 无范围时用固定文案解释可用模型列表，不在这行发起登录或认证。
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			// 警告色显示提示。
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		// 搜索区前留一行。
		this.addChild(new Spacer(1));

		// Create search input
		// 创建空搜索框。
		this.searchInput = new Input();
		// 只有真值初始查询才预填；空白串仍为真值。
		if (initialSearchInput) {
			// 原样保存查询，不在此展开 provider/id。
			this.searchInput.setValue(initialSearchInput);
		}
		// Input 自己的提交动作命中时执行闭包；和下面列表确认动作分开。
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			// 实际取当前 selectedIndex，不强制选第一项；输入非空查询后通常已将下标重置 0。
			if (this.filteredModels[this.selectedIndex]) {
				// 确认当前项，先清刷新等待再通知宿主。
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		// 把搜索框放到列表前面。
		this.addChild(this.searchInput);

		// 列表前留一行。
		this.addChild(new Spacer(1));

		// Create list container
		// 列表采用手工 Text 窗口，不用 SelectList 的鼠标选择实现。
		this.listContainer = new Container();
		// 把列表容器加入面板。
		this.addChild(this.listContainer);

		// 列表与底部帮助之间留一行。
		this.addChild(new Spacer(1));

		// Hint
		// 有设默认回调才显示这组完整底部快捷键帮助。
		if (this.onSelectAsDefaultCallback) {
			// 将下面构造的帮助 Text 加入孩子。
			this.addChild(
				// Text 接收已着色的单段文字和水平/垂直边距。
				new Text(
					// 为整段帮助套主题颜色。
					theme.fg(
						// 使用弱化颜色名 dim。
						"dim",
						// 三种动作提示读当前键位；它们是否生效仍看 handleInput 的先后分支。
						`  ${keyDisplayText("tui.select.confirm")} to select · ${keyDisplayText("app.models.save")} to set as default · ${keyDisplayText("tui.select.cancel")} to cancel`,
					),
					// 水平内边距为 0。
					0,
					// 垂直内边距为 0，间隔由外部 Spacer 管。
					0,
				),
			);
		}

		// Add bottom border
		// 放底部边框，不直接写终端。
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		// 同步用已有快照建列表，不先等网络。
		this.loadModelsFromSnapshot();
		// 真值初始查询立即过滤并重置光标为首结果。
		if (initialSearchInput) this.filterModels(initialSearchInput);
		// 无初始查询就按快照初选绘列表。
		else this.updateList();
		// 请求宿主下一次绘制，不是同步写出所有行。
		this.tui.requestRender();
		// void 表示不等异步刷新；方法内部 catch 常见刷新异常，但不构成任意回调绝不拒绝的保证。
		void this.refreshModels();
	}

	// 读取已有可用快照，更新 all/scoped 元数据及初选，无返回值。例刷新后同 provider/id 的 scoped 项换新元数据，查不到则保留旧项。
	// 不在这里联网/校验登录；重建数组但不深复制模型，运行时/比较回调异常传播。
	private loadModelsFromSnapshot(): void {
		// 把快照每个原模型包成菜单条目；快照可能暂未反映新认证。
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			// 复制供应商字符串。
			provider: model.provider,
			// 复制模型 id。
			id: model.id,
			// 属性简写保存同一 model 引用。
			model,
		}));
		// 只给 all 范围应用“当前→默认→provider”排序。
		this.allModels = this.sortModels(models);
		// 遍历旧范围生成新数组，保留其顺序与额外思考字段。
		this.scopedModels = this.scopedModels.map((scoped) => {
			// 按 provider/id 读最新目录元数据，不重新检查它是否属于可用快照。
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			// 查到则浅展开旧项并换 model，否则保留旧条目；这不是移除所有失效范围模型。
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		// 为范围重新构造可搜索/显示条目。
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			// 从此范围项的模型取供应商。
			provider: scoped.model.provider,
			// 取此范围项 id。
			id: scoped.model.id,
			// 保存范围模型引用。
			model: scoped.model,
		}));
		// 按当前 scope 选数组引用，scoped 不被 all 的可用性/排序自动替代。
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		// 先恢复全范围，后续调用方需要按查询再过滤。
		this.filteredModels = this.activeModels;
		// 按种类/provider/id 找构造时当前模型，未找到为 -1。
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		// 选择下标在下一行由三元表达式决定。
		this.selectedIndex =
			// 当前模型存在优先预选；否则把旧下标上限夹到列表末尾，空列表取 0。
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	// 安装 15 秒取消计时→共享目录刷新→接收有效结果/显示错误→清计时器。例窗口已关闭时晚结果不改列表。
	// 返回 Promise<void>，刷新可能读配置/目录/认证并请求重绘；超时只是取消本窗口等待，不保证共享底层立即停。catch 转常见异常为 UI 状态，catch/重绘自身抛错仍可拒绝。
	private async refreshModels(): Promise<void> {
		// 数字中的 _ 仅提高可读性，15_000 就是 15000 毫秒。
		const timeoutMs = 15_000;
		// 区分计时器取消与关闭取消，用于错误文案。
		let timedOut = false;
		// 保存到期回调句柄，本方法没有给该 timer unref。
		this.refreshTimeout = setTimeout(() => {
			// 先标记到期原因。
			timedOut = true;
			// 取消本面板等待；协调器只有无其他等待者时才取消共享工作。
			this.refreshAbortController.abort();
			// setTimeout 第二参是毫秒，实际执行受事件循环调度影响。
		}, timeoutMs);
		// 从等待开始捕获异常；前面安装计时器的错误不在此 try 内。
		try {
			// 等待共享刷新结果，传本窗口独立信号。
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			// 关闭后直接丢弃迟到结果，仍会进入 finally 清 timer。
			if (this.closed) return;
			// 先清掉“正在刷新”的状态文字，再判断结果。
			this.refreshStatusMessage = "";
			// 只有结果同时报告 aborted 且本地计时已到，才走此超时文案。
			if (result.aborted && timedOut) {
				// 展示缓存回退提示；不在此主动重新加载缓存文件。
				this.errorMessage = "Model refresh timed out; showing cached models.";
				// 恰一家刷新失败时显示其 id。
			} else if (result.errors.size === 1) {
				// Map.keys 迭代器第一项取供应商名字，具体异常正文不展示在这句。
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
				// 多家失败时显示数量和全部错误键。
			} else if (result.errors.size > 1) {
				// 展开错误键再 join，说明回退状态，不声称其他供应商也都失败。
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				// 目录错误表为空时仍检查 Runtime 配置/组合/可用性错误。
				this.errorMessage = this.modelRuntime.getError();
				// 没有其他错误才显示成功状态。
				if (!this.errorMessage) {
					// 成功文案只描述刷新流程，不保证每个 provider 都联网取回新目录。
					this.refreshStatusMessage = "Model catalogs refreshed.";
					// 把该状态改用 success 色。
					this.refreshStatusSuccess = true;
				}
			}
			// 成功返回结果后重新读取当前快照，允许部分目录失败仍保留可用模型。
			this.loadModelsFromSnapshot();
			// 使用此刻查询，而非请求发起时查询；真值查询会重新把光标置顶。
			this.filterModels(this.searchInput.getValue());
			// 请求更新后的界面。
			this.tui.requestRender();
			// 捕获共享等待拒绝或上面同步处理抛出的异常。
		} catch (error) {
			// 关闭后的异常同样不再写 UI。
			if (this.closed) return;
			// 失败时清正在刷新文案。
			this.refreshStatusMessage = "";
			// 按本地 timedOut 决定下方提示，不只看错误类名。
			this.errorMessage = timedOut
				? // 到期采用统一缓存提示。
					"Model refresh timed out; showing cached models."
				: // 其他抛出值若为 Error 取 message，否则 String 转成展示文字。
					`Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			// 错误时保留已有候选重新画状态，没有在此再次调用 loadModelsFromSnapshot。
			this.updateList();
			// 请求显示错误；若宿主自身抛错，当前 catch 不会递归捕获它。
			this.tui.requestRender();
			// 等待成功/失败/提前 return 均进入 finally。
		} finally {
			// 有句柄才清 timer；字段没有重置 undefined，但重复清理可行。
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	// 幂等标关闭、清超时并取消本窗口等待，无返回值；例取消或确认先 dispose，晚刷新结果会被忽略。
	// 不移除组件、不调用选择/取消回调，也没禁止宿主再次手动 handleInput；是否停止底层共享刷新由协调器计数决定。
	dispose(): void {
		// 重复关闭直接结束。
		if (this.closed) return;
		// 先设标记，避免随后完成的刷新再改列表。
		this.closed = true;
		// 停止还未到期的回调。
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		// 通知自己的信号取消，不直接销毁共享 Runtime。
		this.refreshAbortController.abort();
	}

	// 复制候选再排序，返回新数组；例当前 B 总在默认 A 前，同 provider 的其他项保留原相对顺序。
	// 不排序 scoped，亦不按 id 二次排序；不修改输入数组，比较/属性访问错误传播。
	private sortModels(models: ModelItem[]): ModelItem[] {
		// 展开复制数组，仅复制元素引用。
		const sorted = [...models];
		// Sort: current model first, default model second, then by provider.
		// sort 只原地改 sorted 副本，现代 JS 对比较值相同采用稳定排序。
		sorted.sort((a, b) => {
			// a 是否构造时当前模型。
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			// b 同理。
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			// 仅 a 当前时将 a 排前，比较器负数表示 a 在 b 前。
			if (aIsCurrent && !bIsCurrent) return -1;
			// 仅 b 当前时将 b 排前。
			if (!aIsCurrent && bIsCurrent) return 1;
			// 当前身份优先级相同时再看 a 默认标记。
			const aIsDefault = this.isDefaultModel(a.model);
			// 读取 b 默认标记。
			const bIsDefault = this.isDefaultModel(b.model);
			// 仅 a 默认时排前。
			if (aIsDefault && !bIsDefault) return -1;
			// 仅 b 默认时排前。
			if (!aIsDefault && bIsDefault) return 1;
			// 其余按供应商 localeCompare；没有模型 id 比较或价格比较。
			return a.provider.localeCompare(b.provider);
		});
		// 返回排序后的新数组。
		return sorted;
	}

	// 按当前范围生成着色标题，无状态修改；例 scope=scoped 让 scoped 用强调色，all 变弱色。
	private getScopeText(): string {
		// 当前是 all 才强调 all。
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		// 当前是 scoped 才强调 scoped。
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		// 连接标签/分隔符，返回带 ANSI 样式的文字。
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	// 生成切范围键提示字符串，无副作用；例默认配置显示 Tab，重新调用才反映新映射。
	private getScopeHintText(): string {
		// 用动作键位帮助加固定 all/scoped 说明，不在这里匹配输入。
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	// 按默认引用的 provider/id 判是否默认，返回 boolean；例相同 id 不同 provider 不成立，无副作用。
	private isDefaultModel(model: Model<any>): boolean {
		// ?. 先处理缺默认值，&& 短路使缺引用时不继续读 id；这里不比较 API/价格。
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	// 识别 default 的非空前缀查询，返回 boolean；例 " DEf " 成立而 "default model" 不成立，无外部状态修改。
	private isDefaultSearch(query: string): boolean {
		// 只为这个特殊判断裁空白并小写，不重写搜索框字符串。
		const normalized = query.trim().toLowerCase();
		// 要求非空，且查询是 default 前缀；不是“包含 default 任意片段”。
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	// 切 all/scoped 并按现有搜索重建列表，无返回值；例 scoped→all 保留查询，真值查询仍将光标置首。
	// 只修改菜单状态，不改变会话循环范围或请求模型，样式/筛选异常传播。
	private setScope(scope: ModelScope): void {
		// 相同范围不重画。
		if (this.scope === scope) return;
		// 保存新范围。
		this.scope = scope;
		// 切换活动数组引用，不复制模型。
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		// 新范围内寻找当前模型。
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		// 有当前模型则预选它，否则从 0 开始；下面过滤可能再把下标置顶。
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		// 按当前框内查询过滤并重画列表。
		this.filterModels(this.searchInput.getValue());
		// 范围标题可能未创建，存在时才更新。
		if (this.scopeText) {
			// 重建范围着色，不改变键位。
			this.scopeText.setText(this.getScopeText());
		}
	}

	// 按本地查询过滤并处理 default 前缀置顶，再重画，无返回值；例输入 def 将当前范围的默认模型推首位。
	// 不跨范围补默认项、不写模型设置；非空原查询即使只是空白也将光标归 0，筛选/主题异常传播。
	private filterModels(query: string): void {
		// 按 JS 真值判断，有空格的字符串仍进入这里。
		if (query) {
			// 在当前范围本地模糊筛选，回调产生带身份/名称的评分文字。
			const filtered = fuzzyFilter(this.activeModels, query, (item) => {
				// 默认模型额外加入 default 搜索词。
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				// 使用 selector 专用 provider 优先文本，再追加默认标记。
				return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
			});
			// 若查询是 default 的非空前缀，执行专门置顶规则。
			if (this.isDefaultSearch(query)) {
				// 只从当前范围取默认项，不从 all 外插入新候选。
				const defaultItems = this.activeModels.filter((item) => this.isDefaultModel(item.model));
				// \0 是 NUL 分隔符，不是界面空格；用 provider+id 作为内部去重键，不在此检查字段是否自含 NUL。
				const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
				// 构建新的顺序数组。
				this.filteredModels = [
					// 默认候选先放入。
					...defaultItems,
					// 追加模糊结果，但排除已置顶身份，避免同项重复出现。
					...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
				];
			} else {
				// 不是特殊查询就直接采用 fuzzyFilter 结果。
				this.filteredModels = filtered;
			}
		} else {
			// 空串恢复原活动数组引用，原活动顺序仍保留。
			this.filteredModels = this.activeModels;
		}
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		// 真值查询一律选第 0 项；清空查询则尽量保留旧位置并夹到末项，空列表下标也为 0。
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		// 更新组件树但不直接 requestRender，普通输入后宿主会安排绘制。
		this.updateList();
	}

	// 重建最多 10 项的光标居中窗口，再附滚动/错误/详情/刷新状态，无返回值。
	// 例光标下标 8 会尽量前后各留若干项；长 Text 可折行，非固定终端行预算。只改孩子树，不请求模型；主题/布局错误传播。
	private updateList(): void {
		// 先清旧列表孩子，避免导航后重复堆叠。
		this.listContainer.clear();

		// 计算窗口起点，下面同时限制头/尾边界。
		const startIndex = Math.max(
			// 外层 Math.max 不让起点负数。
			0,
			// 目标让光标前有 5 项，同时起点不能越过能显示末 10 项的位置。
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filteredModels.length - MAX_VISIBLE),
		);
		// 窗口右端不超过候选总数，endIndex 不包含自身。
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filteredModels.length);

		// Show visible slice of filtered models
		// 只为可见候选切片创建 Text。
		for (let i = startIndex; i < endIndex; i++) {
			// 读取该候选引用。
			const item = this.filteredModels[i];
			// 无候选时跳过，不在这里填造模型。
			if (!item) continue;

			// 光标箭头看下标。
			const isSelected = i === this.selectedIndex;
			// 当前勾看构造时模型身份，浏览不会移动这个勾。
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			// 默认标记看已保存默认引用。
			const isDefault = this.isDefaultModel(item.model);
			// 默认项追加弱色 default，否则空串。
			const defaultBadge = isDefault ? theme.fg("muted", " · default") : "";

			// 箭头与普通两格缩进互换，保持列位置。
			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			// 当前勾与光标独立，例如光标移到 B 时 A 的勾仍在。
			const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
			// 仅光标项 id 使用强调色。
			const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
			// 按词覆盖启发式决定是否补充名称，重复 id 含义的名字通常隐藏。
			const name = getDistinctModelName({ id: item.id, name: item.model.name });
			// 额外名字用括号弱色展示。
			const nameText = name ? theme.fg("muted", ` (${name})`) : "";
			// 总显示实际 provider，避免同名 id 造成身份歧义。
			const providerBadge = theme.fg("muted", `[${item.provider}]`);
			// 连接光标/当前勾/id/名称/供应商/默认徽标。
			const line = `${cursor}${currentMarker}${modelText}${nameText} ${providerBadge}${defaultBadge}`;

			// 候选 Text 无额外内边距，不自动提供鼠标点击回调。
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		// 窗口任一侧没覆盖全列表才显示当前位置提示。
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			// 界面下标加 1，让用户从 1 而不是 0 看位置。
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			// 将滚动提示放到窗口末。
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		// 有错误时优先显示错误，即使列表仍有候选也能浏览选择。
		if (this.errorMessage) {
			// Show error in red
			// 按 LF 拆错误文字为多段 Text。
			const errorLines = this.errorMessage.split("\n");
			// 逐行构建错误显示，不额外做错误内容解析。
			for (const line of errorLines) {
				// 每行使用 error 色。
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
			// 没有错误但过滤后无项，展示未匹配提示。
		} else if (this.filteredModels.length === 0) {
			// 空结果提示不表示目录服务整体失败。
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			// 有项时取光标对应候选，依赖前面方法维护有效下标。
			const selected = this.filteredModels[this.selectedIndex];
			// 模型详情前留一行。
			this.listContainer.addChild(new Spacer(1));
			// 显示原完整模型名称，和列表里可能被隐藏的额外名称规则不同。
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
		// 正在刷新/成功等非空状态额外附在末尾。
		if (this.refreshStatusMessage) {
			// 刷新提示前留一行。
			this.listContainer.addChild(new Spacer(1));
			// 将下面 Text 加入孩子。
			this.listContainer.addChild(
				// 用刷新成功标志选 success/muted 色，不修改目录结果。
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	// 路由范围切换→上下→翻页→确认→取消→设默认→搜索，无返回值；例同时绑定冲突键时前面的动作获胜。
	// 导航只改列表，确认/取消会先 dispose 刷新等待再调宿主；回调异常传播，Promise 返回不会在这里 await，没有 closed 输入锁。
	handleInput(keyData: string): void {
		// 每次取当前全局键位实例。
		const kb = getKeybindings();
		// 先求可选翻页下标，但实际分派仍让范围和上下键优先。
		const pageIndex = getSelectPageIndex(kb, keyData, this.selectedIndex, this.filteredModels.length, MAX_VISIBLE);
		// 切范围动作优先，使用配置而不是硬编码 Tab 字节。
		if (kb.matches(keyData, "tui.input.tab")) {
			// 只有实际 scoped 候选非空才可切换，空时也会消费这次输入。
			if (this.scopedModelItems.length > 0) {
				// 字面量联合保证这里只在 all/scoped 间切换。
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				// 切换候选并重画。
				this.setScope(nextScope);
				// 若存在帮助 Text，则更新动作提示。
				if (this.scopeHintText) {
					// 重新读取键位帮助字符串。
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			// 范围动作到此结束，不能同时当搜索文本。
			return;
		}
		// Up arrow - wrap to bottom when at top
		// 先匹配上移。
		if (kb.matches(keyData, "tui.select.up")) {
			// 空候选不移动下标。
			if (this.filteredModels.length === 0) return;
			// 首项上移环绕末项，否则减一。
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			// 只重建候选/状态区域。
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		// 上移未中再匹配下移。
		else if (kb.matches(keyData, "tui.select.down")) {
			// 空列表不导航。
			if (this.filteredModels.length === 0) return;
			// 末项下移环绕首项，否则加一。
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			// 根据新光标重建窗口。
			this.updateList();
		}
		// Page up/down
		// 翻页结果可能是 0，必须和 undefined 比，不能用 truthy。
		else if (pageIndex !== undefined) {
			// helper 对空列表翻页给 0，此处仍要拒绝取不存在候选。
			if (this.filteredModels.length === 0) return;
			// 采用已按边界夹紧的翻页位置，不环绕。
			this.selectedIndex = pageIndex;
			// 重画窗口。
			this.updateList();
		}
		// Enter
		// 确认动作在设默认前，冲突时普通确认先赢。
		else if (kb.matches(keyData, "tui.select.confirm")) {
			// 取当前候选而不是始终取首项。
			const selectedModel = this.filteredModels[this.selectedIndex];
			// 空结果不回调。
			if (selectedModel) {
				// 关闭刷新等待并通知普通选择。
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		// 取消使用配置动作，不单凭英语注释推固定 Escape/Ctrl+C。
		else if (kb.matches(keyData, "tui.select.cancel")) {
			// 先标关闭/清计时/取消等待。
			this.dispose();
			// 再由宿主移除面板，组件不自己删父孩子。
			this.onCancelCallback();
		}
		// Select and save as default
		// 只有配置匹配且具备默认回调才截获设默认动作。
		else if (kb.matches(keyData, "app.models.save") && this.onSelectAsDefaultCallback) {
			// 读取当前候选。
			const selectedModel = this.filteredModels[this.selectedIndex];
			// 确有候选才进行默认选择。
			if (selectedModel) {
				// 先停止本面板刷新等待。
				this.dispose();
				// 回传模型给默认回调，实际应用/落盘在宿主，不在这行等待异步完成。
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		}
		// Pass everything else to search input
		// 其余键交搜索编辑，包括没有专门匹配的应用动作。
		else {
			// Input 可能编辑文字或触发自己的提交回调。
			this.searchInput.handleInput(keyData);
			// 即使查询未实际改变也重新筛选；若 Input 已提交，宿主可能已关闭面板，本行仍会继续运行。
			this.filterModels(this.searchInput.getValue());
		}
	}

	// 统一普通确认：先 dispose 后回传模型，无返回值；例确认 B 不在本类写默认，仅宿主执行会话切换。
	// 同步回调异常传播，不对重复手动调用做结果去重。
	private handleSelect(model: Model<any>): void {
		// 清本窗口刷新资源，晚结果被 closed 忽略。
		this.dispose();
		// 同步调用保存的函数，不 await 它可能返回的 Promise。
		this.onSelectCallback(model);
	}

	// 返回搜索 Input 原引用，无副作用；例测试读取当前查询，外部可通过该实例公开方法改值，改值本身不自动调用本类 filterModels。
	getSearchInput(): Input {
		// 返回同一实例，不复制编辑状态。
		return this.searchInput;
	}
}
