// 为 /llama 提供模型列表、HF搜索、选择确认和可取消进度面板；index.ts给出实际管理动作，本文件组合终端组件和异步回调。
// 输入到来时更新状态并requestRender，render只返回终端字符串行；网络由传入search/run/cancel执行，不在UI里直接fetch。
// Promise是等待将来结果的对象；本文件用resolve交回选择/停止意向、用then接续处理，完成不自动代表模型任务成功。HF是Hugging Face模型仓库服务。
// import中带type的成员只参与TS检查，其他成员是实际组件/计算函数；命名导入不会自动创建面板。
import {
	// 组件契约描述render/invalidate和可选输入能力，不生成运行对象。
	type Component,
	// 纵向容器，按加入顺序拼接子组件的行。
	Container,
	// 焦点接口使TS核对focused属性，不自动安装焦点转发。
	type Focusable,
	// 按文字模糊筛选/排序的纯函数，下方仅用它取匹配集合。
	fuzzyFilter,
	// 按当前快捷键配置计算翻页后的下标。
	getSelectPageIndex,
	// 单行输入框，真正实例在搜索组件字段初始化时创建。
	Input,
	// 选择项的静态结构，包含value/label/可选description。
	type SelectItem,
	// 处理列表移动、确认和取消的实际组件。
	SelectList,
	// 空白行组件，不接键盘输入。
	Spacer,
	// 带水平/垂直留白（padding）的文字组件。
	Text,
	// TUI仅作为宿主类型，不在本文件new一个终端实例。
	type TUI,
	// 按终端可见列裁文字，避免把ANSI颜色码算成正文宽度。
	truncateToWidth,
	// 测量可见列宽，和JS字符串length不同。
	visibleWidth,
} from "@earendil-works/pi-tui";
// 命令上下文提供custom/notify等宿主UI能力，type导入在执行JS中擦除。
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
// 快捷键管理器类型，按动作名匹配用户设置，不把某个键写死在组件里。
import type { KeybindingsManager } from "../../core/keybindings.ts";
// 边框每次渲染按当前宽度生成，显式颜色回调也避免扩展模块缓存中的默认主题问题。
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
// 把配置动作变成人能看到的按键提示，不触发该动作。
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
// 主题实例类型，fg/bold等实际能力由宿主传入。
import type { Theme } from "../../modes/interactive/theme/theme.ts";
// 服务目录条目和进度结构，只作类型，不因此发HTTP。
import type { LlamaModelInfo, LlamaProgress } from "./client.ts";
// HF搜索结果类型，包含仓库id和下载次数。
import type { HuggingFaceModel } from "./huggingface.ts";

// 用NUL开头的约定值表示下载菜单项，与普通模型id区别；没有额外运行时校验保证id绝不与它冲突。
const DOWNLOAD_VALUE = "\0download";
// 搜索列表最多显示10个模型行，另可能显示位置/状态行。
const SEARCH_MAX_VISIBLE = 10;

// 带type标签的联合：只有model分支带模型条目。例先判断action.type === "model"，TS才允许直接读action.model；不是enum。
export type LlamaManagerAction = { type: "model"; model: LlamaModelInfo } | { type: "download" } | { type: "close" };

// Pick从Component挑两个属性并保留原可选性；只描述输入转发，不复制组件或自动添加方法。
type InputHandler = Pick<Component, "handleInput" | "capturesViewportInput">;

// extends在接口里复用进度字段，再加面板标题/模型id；接口会被擦除，实际state由后面的对象字面量创建。
interface ProgressState extends LlamaProgress {
	// 当前面板标题，如Loading model。
	title: string;
	// 展示的模型标识，不是服务地址。
	model: string;
}

// 把目录容量变短标签，返回文字或undefined，无I/O；例32768显示33k，这里用十进制1000并四舍五入。
// 先n_ctx??n_ctx_train，真值即显示；再尝试args中的首个有限正数。与provider的安全整数/缓存优先级不同，不应当作请求预算算法。
function contextLabel(model: LlamaModelInfo): string | undefined {
	// ??仅在n_ctx缺失/null时用训练值；n_ctx=0会保留0，然后下一句跳过，不再改选训练值。
	const context = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	// 真值容量直接格式化，未对元数据做有限/正数验证；负数也能显示，NaN是假值。
	if (context) return context >= 1000 ? `${Math.round(context / 1000)}k` : String(context);
	// 没有args就用空数组；这里读取不修改服务条目。
	const args = model.status.args ?? [];
	// 只查到倒数第二项，保证flag后存在一个待转换值。
	for (let index = 0; index < args.length - 1; index++) {
		// 只认三个独立参数名，不支持--ctx-size=4096这种等号写法。
		if (args[index] !== "--ctx-size" && args[index] !== "-c" && args[index] !== "-ctx") continue;
		// 按JS Number转换下一项，可接受科学计数等数值文字。
		const value = Number(args[index + 1]);
		// args分支须有限且>0，但不要求整数；首个有效值就返回，不以后面的参数覆盖。
		if (Number.isFinite(value) && value > 0) return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
	}
	// 没有可显示容量时缺省，让调用方不加context文字。
	return undefined;
}

// 生成列表描述，不改变模型；例sleeping也标loaded且可附容量，unloaded不显示状态/容量。返回中点分隔文字，可能空串。
function modelDescription(model: LlamaModelInfo): string {
	// string[]是数组类型；新建本次描述片段容器。
	const details: string[] = [];
	// 管理展示把loaded和sleeping合为“已加载”，不表示两者在排序时同等优先。
	const loaded = model.status.value === "loaded" || model.status.value === "sleeping";
	// 这两状态统一写loaded，不唤醒睡眠模型。
	if (loaded) details.push("loaded");
	// 其他非unloaded状态写原文字；unloaded暂不添加状态片段。
	else if (model.status.value !== "unloaded") details.push(model.status.value);
	// 仅已加载/睡眠项计算容量标签，未加载preset即使有meta也不显示容量。
	const context = loaded ? contextLabel(model) : undefined;
	// 有非空标签才附“context”。
	if (context) details.push(`${context} context`);
	// 空数组join得到空串，不补默认状态。
	return details.join(" · ");
}

// 为SelectList建立5个上色回调，返回对象，无立即渲染；例描述走muted色，回调捕获传入theme。TS从返回字面量推导方法形状。
function selectTheme(theme: Theme) {
	return {
		// 按接口提供前缀accent回调，传函数不立即fg；当前SelectList渲染并不单独调用selectedPrefix。
		selectedPrefix: (text: string) => theme.fg("accent", text),
		// 当前SelectList把选中整行（包含箭头前缀）交给此回调一起上色，不把前缀另走上面回调。
		selectedText: (text: string) => theme.fg("accent", text),
		// 说明文字用muted，实际效果取决于主题槽定义。
		description: (text: string) => theme.fg("muted", text),
		// 翻页信息用dim槽；它可能含颜色和暗化，不能只当固定灰色。
		scrollInfo: (text: string) => theme.fg("dim", text),
		// 无匹配提示走warning。
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

// 组合上边框/标题/body/可选footer/下边框，返回Container，无终端写入；例body是Input和结果容器。
// 传入子组件保留引用，标题/底部文字现在上色，边框颜色回调在之后render时调用；不自动为子组件加dispose。
function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	// 新建纵向容器，尚未装进宿主UI。
	const container = new Container();
	// 添加上边框，颜色箭头稍后由边框render调用。
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	// 标题先bold再accent；Text参数1/0是水平1列、垂直0行padding。
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	// for...of按body顺序加入原组件，不复制内部状态。
	for (const child of body) container.addChild(child);
	// footer真值才显示，空串视为没有底部。
	if (footer) {
		// 底部前留1空行。
		container.addChild(new Spacer(1));
		// 提示文字现在按dim上色并左右留1列。
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	// 最后加另一条随宽度绘制的边框。
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	// 返回完整容器供LlamaView渲染，本函数不requestRender。
	return container;
}

// 管理流程依赖的UI接口，便于把实际TUI与动作分开；Promise只描述等待结果，不保证用户必定选择或任务成功。
export interface LlamaUi {
	// 显示模型菜单并等待带标签动作；例如选择下载返回{type:"download"}。
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction>;
	// 通用文字选项，取消时得到undefined。
	select(title: string, options: string[]): Promise<string | undefined>;
	// Yes/No确认，取消也按false。
	confirm(title: string, message: string): Promise<boolean>;
	// 连接错误界面最后只返回retry/close，不直接重试网络。
	connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
	// 显示HF搜索并等待仓库文字；搜索函数作为参数传入，不在接口里调用。
	searchModels(
		// 回调接查询与取消信号，Promise返回模型列表；接口不规定远端一定响应取消。
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined>;
	// 仅切换状态文字，不等待用户或工作完成。
	showStatus(title: string, message: string): void;
	// 显示进度并等待用户请求停止，兑现void并不表示模型任务已完成。
	progress(state: ProgressState): Promise<void>;
	// 更新已有进度画面，无完成结果。
	updateProgress(state: ProgressState): void;
}

// 把下载次数缩成十进制k/M文字，无I/O；例1500→1.5k、100000→100k。只格式化，不验证有限/非负数或本地化。
function compactCount(value: number): string {
	// 百万以上用M，千万以下1位小数，否则0位；数字下划线不影响数值。
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	// 千以上用k，十万以下1位小数，否则0位；四舍五入可能跨显示边界。
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	// 较小值直接String，包括负数/NaN等未额外校验值。
	return String(value);
}

// 搜索子组件继承纵向容器并实现焦点；Input管编辑，本类管结果/选中/500ms防抖/缓存与关闭。
// 防抖指输入变化后等一会儿才发查询，连续输入会撤旧计时；缓存来自整个LlamaView，按小写词存数组，无过期/容量限制。
class HuggingFaceSearch extends Container implements Focusable {
	// 聚焦时让全屏宿主把视口滚动/跳转键留给本组件，而非滚动聊天正文；不代表拦住所有全局快捷键。readonly只是TS赋值限制。
	readonly capturesViewportInput: boolean = true;
	// 宿主引用用于请求重画，不在此new终端。
	private readonly tui: TUI;
	// 保存主题对象供每次构建结果文字使用。
	private readonly theme: Theme;
	// 保存动作匹配器，private是TS访问限制，不等于JS #私有字段。
	private readonly keybindings: KeybindingsManager;
	// 保存注入的异步搜索函数，可能由HF客户端实现。
	private readonly search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>;
	// 与父视图共用缓存Map，泛型限定键/值类型，不自动校验内容。
	private readonly cache: Map<string, HuggingFaceModel[]>;
	// 最终选择/取消回调声明返回void；本类忽略其返回值，不等待回调的异步工作。
	private readonly onSelectModel: (model: string | undefined) => void;
	// 实例字段初始化就new Input，每个搜索组件有独立输入内容。
	private readonly input = new Input();
	// 动态结果的子容器，可单独clear重建而保留输入框。
	private readonly resultsContainer = new Container();
	// 最近一次采用的原结果数组，不等于按当前词过滤后的数组。
	private results: HuggingFaceModel[] = [];
	// 当前显示候选，初始空；条目对象仍与原结果共享。
	private filteredResults: HuggingFaceModel[] = [];
	// 0基选中位置，空列表时也保留0，不代表第0项存在。
	private selectedIndex = 0;
	// 已trim的当前词，与Input保留的原输入文字分开。
	private query = "";
	// 初始提示；英文说characters，实际门槛按JS length的UTF-16码元计算。
	private status = "Type at least 2 characters";
	// ReturnType<typeof setTimeout>取得函数返回类型；|undefined表示尚无句柄，不创建timer。
	private debounce: ReturnType<typeof setTimeout> | undefined;
	// 本次搜索的控制器，可请求取消；不是HTTP结果Promise。
	private request: AbortController | undefined;
	// 关闭门禁，防最终回调被close重复调用。
	private closed = false;
	// 本组件焦点状态，下面访问器会同步给输入框。
	private _focused = false;

	// 建搜索组件并安排初始显示，输入宿主/主题/快捷键/搜索/共享缓存/选择回调；不在构造里发查询。例用户后续输入qwen才开始防抖。
	constructor(
		// 宿主TUI。
		tui: TUI,
		// 本次UI的主题引用。
		theme: Theme,
		// 用户当前快捷键配置。
		keybindings: KeybindingsManager,
		// 可取消的搜索能力，参数是函数而不是已开始的请求。
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
		// 父视图持有的跨搜索面板缓存。
		cache: Map<string, HuggingFaceModel[]>,
		// 用户最终确认或取消时交回结果的闭包。
		onSelectModel: (model: string | undefined) => void,
	) {
		// 继承类须先super初始化Container，之后才能访问this。
		super();
		// 保存同一宿主引用。
		this.tui = tui;
		// 保存主题，不复制颜色表。
		this.theme = theme;
		// 保存键绑定管理器。
		this.keybindings = keybindings;
		// 保存回调，赋值不执行搜索。
		this.search = search;
		// 保存同一Map，写入会被之后的搜索组件看到。
		this.cache = cache;
		// 保存完成回调，尚未向用户交回结果。
		this.onSelectModel = onSelectModel;
		// 先加静态用法提示，冒号量化后缀只是输入约定。
		this.addChild(new Text(theme.fg("dim", "Model name or owner/repository[:quant]"), 1, 0));
		// 输入框排在提示之后。
		this.addChild(this.input);
		// 输入与结果间留1空行。
		this.addChild(new Spacer(1));
		// 加入可替换内容的结果容器。
		this.addChild(this.resultsContainer);
		// 构造初始无结果提示，并请求宿主重画；仍没有搜索调用。
		this.updateResults();
	}

	// 读取焦点标志，访问属性时执行getter，不接输入或请求渲染。
	get focused(): boolean {
		// 返回保存的布尔值，不查询操作系统焦点。
		return this._focused;
	}

	// 设置焦点并同步到Input，返回void；例父视图聚焦搜索时输入框也画光标，不自动取消查询。
	set focused(value: boolean) {
		// 更新本类本地焦点。
		this._focused = value;
		// 真正把焦点状态交子输入框，implements不会替我们做此步骤。
		this.input.focused = value;
	}

	// 重建最多10条可见结果与状态提示，返回void；例选中第8项时滚动窗口尽量使它位于中间。会换子组件并requestRender，不发搜索。
	private updateResults(): void {
		// clear只清子组件数组，不是清终端屏幕/调用dispose；旧Text随后可被垃圾回收。
		this.resultsContainer.clear();
		// 可见窗口起点先计算后夹限，避免尾部只剩很少行。
		const start = Math.max(
			// 起点下限0。
			0,
			// 取“选中位置居中”和“最后一整页起点”较小者。
			Math.min(
				// 10/2向下取整得5，让选中项前面尽量有5项。
				this.selectedIndex - Math.floor(SEARCH_MAX_VISIBLE / 2),
				// 少于10项时此值负数，外层max最终归0。
				this.filteredResults.length - SEARCH_MAX_VISIBLE,
			),
		);
		// 终点最多start+10，也不能超过实际候选数，右端不包含。
		const end = Math.min(start + SEARCH_MAX_VISIBLE, this.filteredResults.length);
		// 按可见区间索引逐条生成文字。
		for (let index = start; index < end; index++) {
			// 取原候选引用，不克隆模型。
			const model = this.filteredResults[index];
			// 当前索引没条目就跳过，保留原实现边界处理。
			if (!model) continue;
			// 选中项加箭头，其他项两空格，用于视觉定位，不是可执行命令。
			const prefix = index === this.selectedIndex ? "→ " : "  ";
			// 用缩写次数加英文downloads，未实时查询服务统计。
			const details = `${compactCount(model.downloads)} downloads`;
			// 把这一行新Text加入结果容器，下面跨行构造。
			this.resultsContainer.addChild(
				// Text接已上色的文字及两个padding参数。
				new Text(
					// 按当前项是否选中选一条显示分支。
					index === this.selectedIndex
						? // 选中行整体accent，包括仓库id和次数。
							this.theme.fg("accent", `${prefix}${model.id}  ${details}`)
						: // 未选中行只把次数标muted，仓库id保留普通样式。
							`${prefix}${model.id}${this.theme.fg("muted", `  ${details}`)}`,
					// 水平padding为0，前缀空格已在正文里。
					0,
					// 垂直padding为0，每条结果不额外加空白行。
					0,
				),
			);
		}
		// 上/下还有被窗口隐藏的结果才显示位置提示。
		if (start > 0 || end < this.filteredResults.length) {
			// 增加提示组件，不占前面的10条模型名额。
			this.resultsContainer.addChild(
				// 1基选中位置/总数，如8/20，用dim显示。
				new Text(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredResults.length})`), 0, 0),
			);
		}
		// 过滤结果为空时显示当前状态，既可能是长度提示、无结果或错误。
		if (this.filteredResults.length === 0) {
			// 状态前加两空格，左右不再加padding。
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
			// 已有结果但新搜索在途时，也在旧结果下显示Searching。
		} else if (this.status === "Searching Hugging Face…") {
			// 保留旧结果而不是在发请求时立即清空列表。
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
		}
		// 只排重画请求，真正终端输出由宿主渲染循环完成。
		this.tui.requestRender();
	}

	// 按当前词筛最近结果并调整下标，再重建显示，返回void，无网络。
	// 模糊函数虽按分数排序，这里转成id集合后从原results过滤，所以最终仍保留原结果顺序，不按模糊分重新排。
	private filterResults(): void {
		// 非空trim词才做模糊筛选，空串走原数组。
		if (this.query) {
			// 回调提取id，map再取匹配id，Set去重；得分顺序在这一步不再用于显示。
			const matches = new Set(fuzzyFilter(this.results, this.query, (model) => model.id).map((model) => model.id));
			// 从原结果按成员关系过滤，保留原顺序和对象引用；重复id的多项也可能一起保留。
			this.filteredResults = this.results.filter((model) => matches.has(model.id));
		} else {
			// 空词直接共享results数组，不创建副本。
			this.filteredResults = this.results;
		}
		// 把当前下标压到新末项之内，空数组时归0；这里不每次强制选首项。
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredResults.length - 1));
		// 用新筛选状态重建结果组件。
		this.updateResults();
	}

	// 输入变更后撤旧timer/请求，再看长度/缓存或安排500ms延迟搜索；返回void。
	// 例连续输入qw→qwe时只保留后一次计时；长度门槛2个UTF-16码元，不一定2个用户看见的字符。只请求取消，不能保证远端已停。
	private scheduleSearch(): void {
		// 已有防抖句柄就清timer，未把字段立即设undefined。
		if (this.debounce) clearTimeout(this.debounce);
		// 请求取消上一查询；控制器存在才调用，不等待取消完成。
		this.request?.abort();
		// 清当前控制器引用，旧请求的finally用身份判断避免清掉后来的新引用。
		this.request = undefined;
		// 按length而非码点/字素数，单个某些汉字即可占2码元。
		if (this.query.length < 2) {
			// 短词只改提示，不发网络；旧results还在。
			this.status = "Type at least 2 characters";
			// 用短词过滤旧结果，可能仍显示候选而非仅提示。
			this.filterResults();
			// 长度不足在此结束，不查缓存/排timer。
			return;
		}
		// 按小写词查共享Map，缓存不区分查询原大小写，无TTL。
		const cached = this.cache.get(this.query.toLowerCase());
		// 空数组也是真值，表示之前查过且没有匹配，不会重复请求。
		if (cached) {
			// 复用缓存数组，不复制条目。
			this.results = cached;
			// 只有空列表显示无GGUF，非空清状态文字。
			this.status = cached.length === 0 ? "No GGUF models found" : "";
			// 再按当前原词模糊过滤缓存结果。
			this.filterResults();
			// 命中缓存直接结束，不安排500ms搜索。
			return;
		}
		// 无缓存先显示Searching，下面仍会保留并筛旧结果。
		this.status = "Searching Hugging Face…";
		// 立即刷新等待提示，网络尚未开始。
		this.filterResults();
		// timer到时才取this.query发runSearch；void不等待Promise，不表示没有异步工作，错误主要由runSearch自己处理。
		this.debounce = setTimeout(() => void this.runSearch(this.query), 500);
	}

	// 执行一次搜索，成功缓存后有条件更新界面，失败有条件显示错误，最后清本次控制器引用。
	// 注意缓存写在closed/aborted/词变化检查之前：被取消但仍成功返回的旧请求也可写缓存，只是通常不覆盖当前画面。
	private async runSearch(query: string): Promise<void> {
		// 为此请求建立独立控制器。
		const request = new AbortController();
		// 登记当前控制器，用于下一次输入/close取消。
		this.request = request;
		// try覆盖search、缓存、结果处理和更新显示，相关同步错误也会进catch。
		try {
			// await注入的回调，不直接调用全局fetch；signal只表达协作取消。
			const results = await this.search(query, request.signal);
			// 先按小写词存原数组，即使已关闭/取消也先做这一行。
			this.cache.set(query.toLowerCase(), results);
			// 关闭、已取消或词不再相同就不采用画面结果；按字符串相等判断，没有单独请求代次编号。
			if (this.closed || request.signal.aborted || this.query !== query) return;
			// 采用这次结果引用，不深复制模型。
			this.results = results;
			// 真正采用新请求结果时选中下标重置0。
			this.selectedIndex = 0;
			// 按空列表决定无结果提示。
			this.status = results.length === 0 ? "No GGUF models found" : "";
			// 再过滤并请求重画。
			this.filterResults();
			// 捕获未知错误，下一句先看它是否还属于当前画面。
		} catch (error) {
			// 过期/取消/关闭请求的错误不显示，直接结束；finally仍会执行。
			if (this.closed || request.signal.aborted || this.query !== query) return;
			// 当前请求失败则清已采用结果，不保留旧结果当成功。
			this.results = [];
			// Error取message，其他抛值String化；不额外脱敏或清终端控制码，转换本身也可能抛错。
			this.status = error instanceof Error ? error.message : String(error);
			// 重建错误提示并请求渲染，这里的异常不由同一个catch再次捕获。
			this.filterResults();
			// 成功、失败或早返回都进入finally。
		} finally {
			// 只有仍指向自己时才清引用，避免旧请求结束误清新请求。
			if (this.request === request) this.request = undefined;
		}
	}

	// 关闭搜索并至多一次交回仓库或undefined，返回void；例如取消键传undefined。清timer/请求取消但不等待网络，也不清父缓存。
	private close(model: string | undefined): void {
		// 已经close就忽略重复确认/取消。
		if (this.closed) return;
		// 在回调前置门禁，回调即使抛错也不让下次重新交结果。
		this.closed = true;
		// 取消尚未开始的500ms任务。
		if (this.debounce) clearTimeout(this.debounce);
		// 请求停止当前搜索，不保证服务端已停止。
		this.request?.abort();
		// 同步通知父Promise的resolve；若传入自定义回调抛错，这里不捕获。
		this.onSelectModel(model);
	}

	// 按动作分派搜索键盘输入：上下环选、翻页夹限、确认仓库、取消；其他数据交Input再比较trim后的词。
	// 例上键在首项回到末项；确认可直接采用owner/repo[:quant]，不必已在搜索结果中，不验证仓库真实存在。
	handleInput(data: string): void {
		// 按配置匹配上选动作，不硬编码ArrowUp或ctrl键。
		if (this.keybindings.matches(data, "tui.select.up")) {
			// 有结果才移动，空列表不把0当真实项。
			if (this.filteredResults.length > 0) {
				// 首项向上环到末项，否则下标减1。
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredResults.length - 1 : this.selectedIndex - 1;
				// 只重画选择，不重发搜索。
				this.updateResults();
			}
			// 上选事件已处理，不再进入编辑。
			return;
		}
		// 再查下选动作。
		if (this.keybindings.matches(data, "tui.select.down")) {
			// 同样要求至少一候选。
			if (this.filteredResults.length > 0) {
				// 末项向下环回0，其余加1。
				this.selectedIndex = this.selectedIndex === this.filteredResults.length - 1 ? 0 : this.selectedIndex + 1;
				// 按新的选中下标重画窗口。
				this.updateResults();
			}
			// 下选处理完返回。
			return;
		}
		// 其他输入先委托翻页计算，函数只返回下标不改本组件。
		const pageIndex = getSelectPageIndex(
			// 使用同一快捷键配置。
			this.keybindings,
			// 原始终端输入片段。
			data,
			// 当前下标为移动基准。
			this.selectedIndex,
			// 当前过滤项数限制边界。
			this.filteredResults.length,
			// 按10项一页移动。
			SEARCH_MAX_VISIBLE,
		);
		// undefined代表不是翻页键；数值0仍是一次有效翻页结果。
		if (pageIndex !== undefined) {
			// 空列表翻页助手也返回0，所以这里仍查是否有项。
			if (this.filteredResults.length > 0) {
				// 保存夹限后的新位置，不环绕。
				this.selectedIndex = pageIndex;
				// 更新窗口显示。
				this.updateResults();
			}
			// 翻页键处理完返回，不把它插进文本。
			return;
		}
		// 按确认动作判断是否交出仓库。
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			// 正则粗判owner/repo[:quant]后优先用原词；repo段未禁止更多/，不是完整HF命名校验，冒号量化不要求在详情候选里。
			const exact = /^[^/\s]+\/[^:\s]+(?::[^\s:]+)?$/u.test(this.query) ? this.query : undefined;
			// ??使直接输入优先；否则安全取选中结果id，越界则undefined。
			const selected = exact ?? this.filteredResults[this.selectedIndex]?.id;
			// 有真值选中项才关闭/resolve，没候选不会凭空返回空串。
			if (selected) this.close(selected);
			// 确认键已处理，不再编辑输入。
			return;
		}
		// 匹配取消动作，与确认分开。
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			// 用undefined交回“未选择”，不发下载命令。
			this.close(undefined);
			// 取消后结束本次键处理。
			return;
		}
		// 其他键先由Input处理，可能只是移动光标而未改文字。
		this.input.handleInput(data);
		// 取输入全文并trim作为搜索词，Input本身仍保留两端空白。
		const query = this.input.getValue().trim();
		// trim后未变化就不重启防抖，光标移动通常在此结束。
		if (query === this.query) return;
		// 保存新词供显示/缓存与过期检查。
		this.query = query;
		// 撤旧并安排新查询/采用缓存。
		this.scheduleSearch();
	}
}

// 整个管理界面的组件，内部切模型菜单、搜索、确认和进度；implements核接口，键盘和焦点的转发仍要自己实现。
// 同一实例共享搜索缓存；没有dispose方法替它统一中止所有外部动作，流程由run/view回调和宿主done协调。
class LlamaView implements LlamaUi, Focusable {
	// 宿主TUI引用，用于requestRender。
	private readonly tui: TUI;
	// 本次主题引用。
	private readonly theme: Theme;
	// 动作匹配器，与子搜索组件共用。
	private readonly keybindings: KeybindingsManager;
	// 视图生命周期内的搜索缓存，不做过期/淘汰。
	private readonly searchCache = new Map<string, HuggingFaceModel[]>();
	// 当前画面容器，构造时一定赋值。
	private content: Container;
	// 可选输入接收者，可能为列表/搜索组件，进度时清空。
	private inputHandler: InputHandler | undefined;
	// 另存可接焦点的对象；不要求每个输入接收者都实现Focusable。
	private inputTarget: Focusable | undefined;
	// 等待进度取消键的Promise，不是后台下载Promise。
	private progressPromise: Promise<void> | undefined;
	// 对应resolve闭包，用取消键兑现上面Promise<void>。
	private progressResolver: (() => void) | undefined;
	// 是否接受进度重画；确认菜单时false，防后台进度盖住确认画面。
	private showingProgress = false;
	// 保存宿主给视图的焦点状态，之后转给当前inputTarget。
	private _focused = false;

	// 建立初始Loading画面，输入宿主/主题/快捷键，无HTTP；之后由外层run调用showModels等方法。构造不自动发目录查询。
	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		// 保存同一TUI。
		this.tui = tui;
		// 保存主题。
		this.theme = theme;
		// 保存快捷键配置。
		this.keybindings = keybindings;
		// 初始文字上下左右各留1行/列padding，外框加边框/标题；实际网络加载在index回调。
		this.content = frame(theme, "llama.cpp models", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	// 读取视图焦点，无副作用。
	get focused(): boolean {
		// 返回本地记录，不问操作系统窗口。
		return this._focused;
	}

	// 设置视图焦点并同步当前可聚焦子组件；例搜索输入框随面板获得/失去焦点。没有目标时只记状态。
	set focused(value: boolean) {
		// 保存当前布尔。
		this._focused = value;
		// 存在目标才赋focused，getter/setter由子对象自身实现。
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	// 向宿主报告视口滚动/跳转键是否应留给当前聚焦组件，返回严格boolean，不改变焦点或输入内容。
	get capturesViewportInput(): boolean {
		// 可选链没对象时undefined，===true只接受明确true，不按任意真值。
		return this.inputHandler?.capturesViewportInput === true;
	}

	// 切换画面/输入/焦点目标，返回void并请求重画；先让旧目标失焦，再清进度引用、装新组件。
	// 它丢弃旧进度Promise/resolve引用却不主动兑现旧Promise，也不dispose旧搜索组件或取消其请求；调用流程须自行协调生命周期。
	private setContent(content: Container, inputHandler?: InputHandler, inputTarget?: Focusable): void {
		// 旧目标先失焦，不再画其输入光标。
		if (this.inputTarget) this.inputTarget.focused = false;
		// 不再复用旧进度等待Promise，但不会因此让已等待它的代码收到完成。
		this.progressPromise = undefined;
		// 清取消键resolve，避免新菜单键被当进度取消。
		this.progressResolver = undefined;
		// 关闭进度重画，后台updateProgress暂不覆盖菜单。
		this.showingProgress = false;
		// 当前内容引用整体替换，不在这里render。
		this.content = content;
		// 装新的输入接收者，可为undefined。
		this.inputHandler = inputHandler;
		// 保存新的焦点目标，可与inputHandler为同一对象。
		this.inputTarget = inputTarget;
		// 新目标继承视图当前焦点，不总是强制true。
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		// 通知宿主稍后渲染。
		this.tui.requestRender();
	}

	// 复制排序模型并加下载入口，返回等待动作的Promise；例确认某项返回{type:"model",model}，取消返回close。
	// 只把状态精确loaded排前，sleeping虽描述为loaded也不享同一排序优先级；没有发模型加载/卸载请求。
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction> {
		// 展开复制数组再就地sort，不改变调用方数组顺序；条目对象仍共享。
		const sorted = [...models].sort((left, right) => {
			// boolean转0/1，右loaded减左loaded，使左loaded时负数排前。
			const loaded = Number(right.status.value === "loaded") - Number(left.status.value === "loaded");
			// 状态优先相同用id的localeCompare排序，具体区域比较遵循运行环境。
			return loaded || left.id.localeCompare(right.id);
		});
		// 按id建Map便于回选，重复id后者覆盖，但上面列表仍可能保留多行同id。
		const byId = new Map(sorted.map((model) => [model.id, model]));
		// 明确SelectItem[]类型，下面是模型项加固定动作项。
		const items: SelectItem[] = [
			// map新建每行描述对象，再数组展开合并。
			...sorted.map((model) => ({
				// value是回调识别键，沿用模型id。
				value: model.id,
				// label也是id，不改成别名。
				label: model.id,
				// 描述由状态/容量辅助纯计算。
				description: modelDescription(model),
			})),
			// 最后附加约定下载哨兵项，保证空目录也能显示下载操作。
			{ value: DOWNLOAD_VALUE, label: "Download model…", description: "Hugging Face owner/repository[:quant]" },
		];
		// Promise执行器立即建菜单，等待后续事件resolve；这里同步抛错会变Promise拒绝。
		return new Promise((resolve) => {
			// 可见项最多12，颜色回调与主列宽配置传给列表；不是最多只保留12个模型。
			const list = new SelectList(items, Math.min(items.length, 12), selectTheme(this.theme), {
				// 主标签列最低期望36列，实际终端很窄时仍受组件布局约束。
				minPrimaryColumnWidth: 36,
				// 主标签列最高期望56列，不是整个面板总宽56。
				maxPrimaryColumnWidth: 56,
			});
			// 注册确认回调，用户选择时才执行，不在赋值时选首项。
			list.onSelect = (item) => {
				// 下载哨兵直接resolve下载动作，不带model字段。
				if (item.value === DOWNLOAD_VALUE) resolve({ type: "download" });
				else {
					// 普通项再按id查条目，取Map内原对象。
					const model = byId.get(item.value);
					// 找到才resolve模型动作，未找到不伪造条目；Promise只接受第一次结算。
					if (model) resolve({ type: "model", model });
				}
			};
			// 列表取消时resolve关闭动作，具体收起宿主由外层流程完成。
			list.onCancel = () => resolve({ type: "close" });
			// 把菜单框设为当前内容，同时装list作输入接收者。
			this.setContent(
				// 复用frame构造边框/标题/底部。
				frame(
					// 传入保存主题。
					this.theme,
					// 模型菜单标题。
					"llama.cpp models",
					// 正文依次显示服务地址、空行、列表，不把地址变成网络调用。
					[new Text(this.theme.fg("dim", serverUrl), 1, 0), new Spacer(1), list],
					// 按用户配置生成确认/取消提示文字，不执行对应动作。
					`${keyHint("tui.select.confirm", "load/unload/download")} • ${keyHint("tui.select.cancel", "close")}`,
				),
				// list作为键盘处理对象，此调用没有另传Focusable目标。
				list,
			);
		});
	}

	// 显示通用字符串选择，返回选中文字或取消undefined；例[Yes,No]交confirm使用。空选项可只靠取消结束，不发管理命令。
	select(title: string, options: string[]): Promise<string | undefined> {
		// 立即安装菜单，等待onSelect/onCancel结算。
		return new Promise((resolve) => {
			// 创建独立SelectList，不复用模型菜单选中位置。
			const list = new SelectList(
				// 每个字符串同时作value/label；没有额外稳定id映射。
				options.map((option) => ({ value: option, label: option })),
				// 最多显示12项，空数组给0可见项。
				Math.min(options.length, 12),
				// 颜色回调沿用当前主题。
				selectTheme(this.theme),
			);
			// 确认回传value原字符串，可能与label相同。
			list.onSelect = (item) => resolve(item.value);
			// 取消回undefined，不强制选第一项。
			list.onCancel = () => resolve(undefined);
			// 切换内容会使showingProgress=false，防进度更新覆盖确认菜单。
			this.setContent(
				// 构建通用外框。
				frame(
					// 主题引用。
					this.theme,
					// 标题文字允许包含换行，由Text处理。
					title,
					// 正文加一空行再放列表。
					[new Spacer(1), list],
					// 动态键位提示选择/取消，不硬编码某个实际键。
					`${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "cancel")}`,
				),
				// 把列表装为输入处理者，没有焦点目标参数。
				list,
			);
		});
	}

	// 通过Yes/No菜单确认，返回Promise<boolean>；例No或取消都false，只有精确Yes为true。选择UI本身拒绝则向上传播。
	async confirm(title: string, message: string): Promise<boolean> {
		// 先把title和message用LF拼显示标题，再await选项并比较，不只是判断字符串真值。
		return (await this.select(`${title}\n${message}`, ["Yes", "No"])) === "Yes";
	}

	// 展示服务不可用原因，等待用户重试/关闭意向；返回retry/close，本方法自己不重新请求HTTP。例取消也归close。
	async connectionError(serverUrl: string, message: string): Promise<"retry" | "close"> {
		// 把地址和错误文字加入菜单标题，不净化/脱敏，底层选择可拒绝。
		const choice = await this.select(`llama.cpp unavailable\n${serverUrl}\n\n${message}`, ["Retry", "Close"]);
		// 只有精确Retry才重试，其余包括undefined一律close。
		return choice === "Retry" ? "retry" : "close";
	}

	// 安装一次HF搜索组件并等仓库字符串/undefined；传入search能力，缓存复用当前视图Map，构造时不自动查空词。
	searchModels(
		// 每次搜索回调接词和signal，返回候选列表Promise。
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined> {
		// Promise的resolve作为最终选择回调，组件关闭时结算。
		return new Promise((resolve) => {
			// 创建新搜索组件，上一面板输入内容不会自动复用。
			const component = new HuggingFaceSearch(
				// 同一宿主TUI。
				this.tui,
				// 当前主题。
				this.theme,
				// 当前键绑定管理器。
				this.keybindings,
				// 传函数引用，不在这里执行网络查询。
				search,
				// 共享缓存数组供以后相同小写词复用。
				this.searchCache,
				// 确认/取消最后调用resolve，不另启动下载。
				resolve,
			);
			// 把新组件装入当前面板和输入/焦点通道。
			this.setContent(
				// 构建搜索外框。
				frame(
					// 传入主题引用。
					this.theme,
					// 下载选择阶段标题，不表示文件已开始下载。
					"Download model",
					// 正文留一空行后放搜索组件。
					[new Spacer(1), component],
					// 确认选择与返回的用户配置键提示。
					`${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "back")}`,
				),
				// 搜索组件接收键盘。
				component,
				// 同一个搜索组件还接收焦点，内部再传给Input。
				component,
			);
		});
	}

	// 显示只读状态文字并返回void，不等工作/用户结束；例Loading model details提示期间没有本方法提供的取消回调。
	showStatus(title: string, message: string): void {
		// setContent同时清旧输入/进度引用并请求渲染，文字只展示，不在此发HTTP。
		this.setContent(frame(this.theme, title, [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)]));
	}

	// 显示或复用进度等待Promise，用户请求停止时兑现void；例runWithProgress把它与后台settled竞速，不能当作工作成功Promise。
	progress(state: ProgressState): Promise<void> {
		// 已有取消等待Promise就复用，不为每次更新建立一个。
		if (!this.progressPromise) {
			// 没有才新建，并立即执行下面执行器。
			this.progressPromise = new Promise((resolve) => {
				// 保存resolve闭包，直到取消键到来；不在这里立即resolve。
				this.progressResolver = resolve;
			});
		}
		// 允许updateProgress重建当前画面。
		this.showingProgress = true;
		// 先显示当前状态，即使后台尚无进度更新。
		this.updateProgress(state);
		// 返回同一个等待取消Promise，不等待任何HTTP。
		return this.progressPromise;
	}

	// 仅在进度显示开启时重建模型/消息/可选进度条/细节并requestRender；返回void。
	// 条形格数夹0..1，但旁边百分数用原ratio，例1.5可显示满条和150%；NaN/Infinity等没有完整数值验证。
	updateProgress(state: ProgressState): void {
		// 确认菜单通过setContent关闭标志时忽略后台更新，避免盖掉用户问题。
		if (!this.showingProgress) return;
		// 新建本帧正文组件数组，不修改上次组件。
		const body = [
			// 第一行显示模型标识，用text槽和水平1列padding。
			new Text(this.theme.fg("text", state.model), 1, 0),
			// 模型名与消息间留空行。
			new Spacer(1),
			// 当前阶段消息用muted，不发操作。
			new Text(this.theme.fg("muted", state.message), 1, 0),
		];
		// 明确检查undefined，所以0比例仍会显示，null不属于此类型约定。
		if (state.ratio !== undefined) {
			// 条形固定40个格，不按当前面板宽度动态缩成40以下。
			const available = 40;
			// 先夹0..1再乘40、四舍五入；不额外排除NaN，repeat会按JS数字转换规则处理。
			const filled = Math.round(Math.max(0, Math.min(1, state.ratio)) * available);
			// 有ratio就把进度条文字组件追加正文。
			body.push(
				// 创建Text，下面先生成上色字符串。
				new Text(
					// 用主题accent上色，不是直接写stdout。
					this.theme.fg(
						// accent是主题槽名。
						"accent",
						// filled个实块加剩余横线；百分数按未夹限的原ratio四舍五入，控制台真实绘制由render完成。
						`${"█".repeat(filled)}${"─".repeat(available - filled)} ${Math.round(state.ratio * 100)}%`,
					),
					// 水平padding1列。
					1,
					// 垂直padding0行。
					0,
				),
			);
		}
		// 真值detail才额外显示，空串省略。
		if (state.detail) body.push(new Text(this.theme.fg("dim", state.detail), 1, 0));
		// 直接换content而非setContent，保留progressPromise/resolver和showingProgress；底部提示停止键。
		this.content = frame(this.theme, state.title, body, keyHint("tui.select.cancel", "stop"));
		// 进度时不把输入转给旧列表，inputTarget引用未在这行清空/失焦。
		this.inputHandler = undefined;
		// 排一次重画请求。
		this.tui.requestRender();
	}

	// 分派视图输入，若正等进度取消且匹配取消键就resolve停止意向，否则交当前子组件；返回void，不在这里abort网络。
	handleInput(data: string): void {
		// 必须既有等待resolve又匹配动作，普通列表取消仍交list。
		if (this.progressResolver && this.keybindings.matches(data, "tui.select.cancel")) {
			// 先把resolve存局部，清字段后仍可调用。
			const resolve = this.progressResolver;
			// 允许后续progress再建新的等待Promise。
			this.progressPromise = undefined;
			// 本次停止意向只交一次，不让重复键继续resolve同一引用。
			this.progressResolver = undefined;
			// 兑现void，runWithProgress接着询问Yes/No，并非立刻远端停止。
			resolve();
			// 处理停止意向后返回，本分支不另requestRender，后续确认流程切画面。
			return;
		}
		// 两级可选调用：有处理者且有handleInput才转发原数据。
		this.inputHandler?.handleInput?.(data);
		// 转发后请求重画，即使子组件自己也可能排过渲染。
		this.tui.requestRender();
	}

	// 按列宽渲染当前内容，再把超宽行裁到width，返回字符串数组；不直接写终端，不在这里控制总行数。
	render(width: number): string[] {
		// 使用当前容器引用，随后链式渲染/逐行处理。
		return (
			this.content
				// 子组件按同一宽度生成含ANSI样式的行。
				.render(width)
				// 按可见列比较而非length，只裁超宽行，省略标记为空串；不重新排版成多行。
				.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line))
		);
	}

	// 使当前内容各子组件缓存失效，返回void；不主动重建所有已经上色的旧文字，也不requestRender。
	invalidate(): void {
		// 委托容器递归invalidate，子回调异常可向外传播。
		this.content.invalidate();
	}
}

// 在宿主custom中创建并展示LlamaView，同时启动run(view)，等待done结束；输入ctx和异步动作回调，成功Promise<void>。
// run成功直接done，拒绝先notify再done，通常把业务错误转提示；若notify/回调同步抛错等路径，不能保证总能done或统一清理。视图没有dispose总取消器。
export async function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> {
	// custom<void>把done结果限定为void；此处不传overlay选项，实际交互宿主默认使用内联对话组件。
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		// 创建视图，把宿主提供的TUI/主题/键位传入，不创建新终端。
		const view = new LlamaView(tui, theme, keybindings);
		// 立即调用run并挂then，不await其Promise以便先把组件交宿主；同步throw会在工厂执行时传播，不走这个拒绝回调。
		void run(view).then(
			// run成功调用done()，具体移除组件/恢复编辑器由宿主custom负责。
			() => done(),
			// 异步拒绝回调接unknown，不假定一定Error。
			(error: unknown) => {
				// 显示错误文字，String化/notify异常会阻止下一句；这里未给then返回Promise另挂catch。
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				// 只有通知正常返回才done，未重新throw原业务错误。
				done();
			},
		);
		// 工厂同步返回同一视图，宿主将它装到交互界面。
		return view;
	});
}

// 把后台操作和进度取消界面协调起来，泛型T保留run结果；成功返回{cancelled:false,value}，确认取消且收尾成功返回{cancelled:true}，工作失败拒绝。
// 例如下载run返回模型目录，未取消时value就是该数组；取消键只发意向，须确认、await cancel，再abort本地signal并等run结算。
// cancel拒绝时finally仍abort，但原拒绝会跳过后面的await settled/取消返回；UI拒绝也无外层统一abort，run不理signal时等待可不结束，不保证所有远端工作已停。
export async function runWithProgress<T>(
	// UI契约用于显示/确认，不在此固定具体TUI类，可由调用方提供实现。
	ui: LlamaUi,
	// 内联对象类型描述一次操作所需字段/方法，类型本身不创建默认值。
	options: {
		// 进度面板标题。
		title: string;
		// 展示的模型标识。
		model: string;
		// 首次显示的提示文字，后续进度可覆盖。
		initialMessage: string;
		// 取消确认标题。
		cancelTitle: string;
		// 取消确认正文。
		cancelMessage: string;
		// run接协作取消信号和同步更新回调，返回Promise<T>；例如client.downloadAndWait，类型不强制实现真正中止远端。
		run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
		// cancel执行服务侧取消请求并等Promise<void>；它与controller.abort是两件独立动作。
		cancel(): Promise<void>;
	},
	// 带cancelled标签的联合让TS检查分支后才允许读value；Promise兑现cancelled:true不意味着工作成功。
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
	// 给本次run单独创建取消控制器，默认未取消。
	const controller = new AbortController();
	// 可变进度对象只初始化三字段，没有ratio/detail。
	const state: ProgressState = { title: options.title, model: options.model, message: options.initialMessage };
	// settled把run成功/失败都装成ok标签结果，正常Promise拒绝不直接逃出竞速。
	const settled = options
		// 立刻启动run并传更新闭包，不等面板先显示；若run同步throw，该async函数会拒绝而后面UI循环不执行。
		.run(controller.signal, (progress) => {
			// Object.assign原地浅合并，未提供的旧ratio/detail会保留，明确提供undefined才覆盖；不把state换成新对象。
			Object.assign(state, progress);
			// 同步通知UI，确认菜单时实际LlamaView会忽略画面更新，但state合并仍已发生。
			ui.updateProgress(state);
		})
		// 两参数then分别处理成功和拒绝，都返回普通带标签对象。
		.then(
			// as const把ok类型保留为字面量true，value保持泛型T，不在运行时freeze。
			(value) => ({ ok: true as const, value }),
			// 拒绝原因保留unknown原值，ok:false用于最后分支收窄。
			(error: unknown) => ({ ok: false as const, error }),
		);
	// 尚未收到settled结算通知，let稍后会由微任务设true。
	let completed = false;
	// 成功/失败装成结果后都会执行finally；返回的派生Promise没有在这里另保存/await。
	settled.finally(() => {
		// 标记工作已经结算，不等于ok一定true，也不是服务端进程检查。
		completed = true;
	});

	// 只在工作未结算时反复显示/等待停止意向，取消确认No后可以再次进入。
	while (!completed) {
		// Promise.race等待两者谁先结算；不会自动取消落败的Promise或后台任务。
		const outcome = await Promise.race([
			// 工作结算无论ok真假都映成settled，最终错误留到循环后处理。
			settled.then(() => "settled" as const),
			// UI progress兑现表示用户按停止键，映成stop；它若拒绝，race也拒绝并退出，没有这里的外层finally中止run。
			ui
				.progress(state)
				.then(() => "stop" as const),
		]);
		// 工作先结算就退出显示循环，不要求再问用户取消。
		if (outcome === "settled") break;
		// 用户先请求停止才询确认；确认期间工作仍运行并可更新state。
		const stop = await ui.confirm(options.cancelTitle, options.cancelMessage);
		// 未确认或确认期间已完成就继续，下一轮条件会在completed=true时退出；不再无谓调cancel。
		if (!stop || completed) continue;
		// try/finally仅保护服务侧cancel调用，不包整个UI/工作循环。
		try {
			// 先等待外部取消方法，例如POST unload；返回只按该方法契约，不证明远端任务全部停止。
			await options.cancel();
			// 无论cancel成功/拒绝都在此请求本地signal取消，未吞掉cancel原错误。
		} finally {
			// abort(reason)把Cancelled错误交合作的run；不直接改settled标签或强制兑现Promise。
			controller.abort(new Error("Cancelled"));
		}
		// cancel正常返回后才等run结算；若它忽略取消且永不结算，这里可一直等待，已装标签所以run失败也不在此throw。
		await settled;
		// 返回取消分支，不再把run错误当普通失败抛出；但前面的cancel/UI异常可能已提前拒绝。
		return { cancelled: true };
	}

	// 自然结算路径取得带ok标签的结果，工作可能成功也可能失败。
	const result = await settled;
	// 失败重新抛原unknown错误，async把它变返回Promise拒绝，未改为字符串。
	if (!result.ok) throw result.error;
	// 成功保留泛型T数据并标记未取消，value: result.value是明确赋字段，不是属性简写。
	return { cancelled: false, value: result.value };
}
