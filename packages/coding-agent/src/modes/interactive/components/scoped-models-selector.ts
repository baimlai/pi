// /models 菜单管理本次会话的循环候选和显式顺序，并通过独立保存回调通知宿主落盘；目录刷新由外层驱动。
// 只导入模型元数据类型，运行时不会由此发起模型调用。
import type { Model } from "@earendil-works/pi-ai";
import {
	// 容器纵向组织标题、搜索和列表。
	Container,
	// 焦点接口仅作 TS 契约，焦点需要下面 setter 主动传给搜索框。
	type Focusable,
	// 本地模糊筛选/排序，不是模型语义搜索。
	fuzzyFilter,
	// 读取共享可配置动作映射。
	getKeybindings,
	// 按翻页动作求下标，不修改候选或滚动状态。
	getSelectPageIndex,
	// 保存查询字符串/光标的单行输入框。
	Input,
	// 构造/引用原始键描述，本文件取消仍明确匹配 Ctrl+C 与 Escape。
	Key,
	// 匹配原始键描述，和 kb.matches 的可配置动作不是同一个接口。
	matchesKey,
	// 显式空白行组件。
	Spacer,
	// 带样式的普通文字组件，不解析 Markdown。
	Text,
} from "@earendil-works/pi-tui";
// 共享名称去重复说明与搜索文本规则，不查询模型目录。
import { getDistinctModelName, getModelSearchText } from "../model-search.ts";
// 使用当前主题颜色/加粗/删除线。
import { theme } from "../theme/theme.ts";
// 边框在渲染时按实际列宽生成。
import { DynamicBorder } from "./dynamic-border.ts";
// 将配置动作的当前按键转为帮助文字，不负责绑定。
import { keyDisplayText } from "./keybinding-hints.ts";

// EnabledIds: null = all enabled (no filter), string[] = explicit ordered list
// 联合类型：null 表示不设过滤、全部启用；数组是明确顺序，[] 是本组件的空选择。主交互宿主可能把空选择映成会话无范围限制，不等于绝对禁用所有模型。
type EnabledIds = string[] | null;

// 判断 id 在本组件是否启用，返回 boolean；例 null 对任意 id 为 true，[] 则为 false，无状态修改。
function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	// null 分支短路，否则做字符串精确 includes，不把 id 当 glob 模式匹配。
	return enabledIds === null || enabledIds.includes(id);
}

/** Collapse an explicit list back to null (= all enabled) when it covers every available model. */
// 尝试将全覆盖显式列表折成 null，返回 null 或原数组引用；例 [a,b] 对 all=[a,b] 变 null，也就放弃该显式顺序。
// 只比较长度和每项成员，不去重/证明任意重复数组集合相等；通常输入由菜单操作维护，无 IO 或原数组修改。
function normalizeEnabled(result: string[], allIds: string[]): EnabledIds {
	// 长度相等且每个 result 项都在 allIds 才折叠；[a,a] 对 [a,b] 也满足此表达式，不是通用集合相等算法。
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}

// 切一个 id：全启用时排除它，显式列表已有则移除、没有则追加并尝试全启用归一，返回新状态。
// 例 null/all=[a,b] 切 a 得 [b]，再启 a 可折回 null；不修改传入数组、不验证 id 是否存在。
function toggle(enabledIds: EnabledIds, allIds: string[], id: string): EnabledIds {
	// 全启用改为明确保留其他可用 id；filter 新建数组。
	if (enabledIds === null) return allIds.filter((modelId) => modelId !== id);
	// 在显式顺序中找第一个该 id，找不到 -1。
	const index = enabledIds.indexOf(id);
	// 存在时拼前后切片，移除首个匹配；不自动清所有重复项。
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	// 原列表末尾追加 id，再看是否应折叠成 null；全启用归一可能丢失重排后的显式顺序。
	return normalizeEnabled([...enabledIds, id], allIds);
}

// 批量启用目标，省 targetIds 则针对全部可用 id，返回 null 或新数组；例已有 [a]、目标 [b] 时追加 b。
// 不修改输入、不检查目标可用性；null 已是全启用直接保留，异步/IO 不在此发生。
function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	// 全启用状态无需再添加，直接返回 null。
	if (enabledIds === null) return null; // Already all enabled
	// ?? 仅在 targetIds 缺失时用 allIds，显式 [] 表示没有目标。
	const targets = targetIds ?? allIds;
	// 先复制已有顺序，后续只给副本 push。
	const result = [...enabledIds];
	// 按目标数组次序添加。
	for (const id of targets) {
		// 尚未出现才追加，避免这一步新添重复项，不清理原列表已有重复。
		if (!result.includes(id)) result.push(id);
	}
	// 合并后尝试全覆盖归一，不保存显式全启用顺序。
	return normalizeEnabled(result, allIds);
}

// 批量清目标，省 targetIds 则清全部启用，返回显式数组；例 null/all=[a,b,c] 清 [b] 得 [a,c]。
// 不修改输入、不自动删除用户设置或直接关闭模型；这里只产出菜单状态。
function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	// 全启用没有现成显式列表，需要从 allIds 生成。
	if (enabledIds === null) {
		// 有目标数组则排除它们，缺目标就 []；空数组是真值，所以 [] 目标会保留全 allIds 的显式副本。
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	// 显式状态下把目标变 Set，省目标用全部当前启用 id。
	const targets = new Set(targetIds ?? enabledIds);
	// 过滤出非目标 id，保留原相对顺序，不做 null 归一。
	return enabledIds.filter((id) => !targets.has(id));
}

// 在显式列表中把 id 与 index+delta 的位置交换，返回新列表；例 [a,b,c] 中 b,+1 得 [a,c,b]。
// null 保持 null，未知 id/越界返回副本；delta 通常由调用方给 ±1，其他值不在此取整或解释成多步插入移动。
function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	// 全启用不提供显式重排，直接返回 null。
	if (enabledIds === null) return null;
	// 复制原顺序，避免修改调用方数组。
	const list = [...enabledIds];
	// 查首个 id 位置。
	const index = list.indexOf(id);
	// 找不到也返回刚建副本，不是原数组。
	if (index < 0) return list;
	// 用输入 delta 求目标下标，没有在这里规范化为 ±1。
	const newIndex = index + delta;
	// 目标范围外不交换。
	if (newIndex < 0 || newIndex >= list.length) return list;
	// 再复制一份作为交换结果。
	const result = [...list];
	// 解构赋值交换两槽，右侧先读取旧值；不是 splice 把中间所有项顺移。
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	// 返回交换后的数组。
	return result;
}

// 构造显示 id 顺序：显式启用项在前、其余可用项在后；例 enabled=[b,x失效]，all=[a,b] 得 [b,x,a]。
// null 直接返回 allIds 原引用，显式时返回新数组；不按字母排序、不去重原 enabledIds、不删失效项。
function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	// 全启用沿用目录顺序及原数组引用。
	if (enabledIds === null) return allIds;
	// 集合只用于排除后半重复身份，不重排前半显式列表。
	const enabledSet = new Set(enabledIds);
	// 先原启用顺序，再追加尚未启用的可用项；失效显式 id 仍在前半。
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

// 当前列表行形状，模型元数据可缺以保留失效配置。
interface ModelItem {
	// provider/id 完整字符串，由构造时直接拼接，不在此拆斜杠或校验唯一性。
	fullId: string;
	// 目录中找不到时 undefined，已有 any 泛型放宽模型 API 关联，不是运行时验证。
	model: Model<any> | undefined;
	// 菜单启用标志；失效行也可持有 true，但渲染不会显示有效模型勾。
	enabled: boolean;
}

// 宿主给的配置快照，不由本组件读 settings.json。
export interface ModelsConfig {
	// 当前可用模型列表，构造按其顺序建立 allIds。
	allModels: Model<any>[];
	// null 全启用，数组明确范围/顺序，失效 id 也可保留。
	enabledModelIds: string[] | null;
	// 可选初始刷新文案；构造没提供时，后续 setRefreshStatus 不会凭空创建 Text。
	refreshStatus?: string;
}

// 操作回调接口，只描述返回类型；下面调用没有 await Promise，因此不提供异步失败回滚。
export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	// 变化时通知宿主更新会话，传副本或 null；可同步或异步，组件不等它完成。
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	// 明确保存意图，真正落盘由宿主实现；不是组件内自动写配置。
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	// 关闭意图回调，不代表撤销已通过 onChange 应用的会话变化。
	onCancel: () => void;
}

/**
 * Component for enabling/disabling models for Ctrl+P cycling.
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
// 模型循环范围/顺序面板，布局继承 Container，焦点显式传搜索框；默认快捷键名只是示例，动作大多可配置。
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	// 全屏 TUI 聚焦此组件时把视口键交列表，避免背后聊天记录抢滚动；不是自动获得焦点。
	readonly capturesViewportInput: boolean = true;
	// 完整 id→原模型对象；Map 同名 set 会覆盖值，但 allIds 仍逐条记录，不额外去重。
	private modelsById: Map<string, Model<any>> = new Map();
	// 当前可用目录顺序。
	private allIds: string[] = [];
	// 菜单启用状态，构造时会按 config 替换。
	private enabledIds: EnabledIds = null;
	// 查询后的显示行，含失效配置项。
	private filteredItems: ModelItem[] = [];
	// 光标下标，和启用勾不是同一状态。
	private selectedIndex = 0;
	// 内部搜索框，宿主可取得原引用。
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	// 本容器焦点标志，默认 false。
	private _focused = false;
	// 返回外层保存的焦点，无副作用；例 TUI 读取 focused，不重新查询 Input。
	get focused(): boolean {
		// get 使读取写成 selector.focused。
		return this._focused;
	}
	// 设置外层及搜索框焦点，无返回值；例打开对话框后聚焦搜索，不修改启用列表。
	set focused(value: boolean) {
		// 先更新外层标志。
		this._focused = value;
		// 再将同一值交实际输入框，影响光标标记。
		this.searchInput.focused = value;
	}
	// 当前候选窗口子容器，更新时清空重建。
	private listContainer: Container;
	// 显示快捷键、计数与未保存标记的固定 Text。
	private footerText: Text;
	// 宿主回调对象原引用，不做复制/冻结。
	private callbacks: ModelsCallbacks;
	// 最多显示 8 个候选 Text，长文字可能折行，非严格 8 个终端行预算。
	private maxVisible = 8;
	// 用户操作后未明确保存的 UI 标志；不是和磁盘做内容比对的结果。
	private isDirty = false;
	// 仅构造传非空 refreshStatus 时创建。
	private refreshStatusText?: Text;

	// 保存回调/目录→复制启用状态→搭标题、搜索、列表、状态和帮助→绘首屏，返回实例。
	// 例 enabled=[b,a] 先显示 b/a，null 沿用目录顺序。构造不发目录/聊天请求、不写设置；主题错误传播，异步目录刷新在主交互宿主。
	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		// 先初始化父容器。
		super();
		// 保存同一个回调对象，之后每次操作才读取其函数。
		this.callbacks = callbacks;

		// 遍历传入目录，不先排序或去重。
		for (const model of config.allModels) {
			// 直接用 provider/模型 id 拼完整字符串，模型 id 原本也可含斜杠。
			const fullId = `${model.provider}/${model.id}`;
			// 记录同一模型对象，重复身份覆盖先前 Map 值。
			this.modelsById.set(fullId, model);
			// 追加目录顺序，重复 id 不在本行被排除。
			this.allIds.push(fullId);
		}

		// null 原样保存；显式数组展开复制，之后菜单操作不会直接改调用方数组。
		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		// 建初始完整行列表，此时没有查询。
		this.filteredItems = this.buildItems();

		// Header
		// 上下各加一条动态边框。
		this.addChild(new DynamicBorder());
		// 界面各区之间留一行。
		this.addChild(new Spacer(1));
		// 标题加粗并用强调色，Text 不额外加内边距。
		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		// 把下面帮助 Text 加到容器。
		this.addChild(
			// 显示会话内变化/显式保存说明，键名从当前 app.models.save 映射取。
			new Text(theme.fg("muted", `Session-only. ${keyDisplayText("app.models.save")} to save to settings.`), 0, 0),
		);
		// 搜索前留一行。
		this.addChild(new Spacer(1));

		// Search input
		// 创建空查询框；没有绑定它的 onSubmit，切换启用由本类确认分支处理。
		this.searchInput = new Input();
		// 搜索框加入面板。
		this.addChild(this.searchInput);
		// 列表前留一行。
		this.addChild(new Spacer(1));

		// List container
		// 手工 Text 列表容器，不继承 SelectList 的鼠标选择。
		this.listContainer = new Container();
		// 将候选区加入面板。
		this.addChild(this.listContainer);

		// Footer hint
		// 底部帮助前留一行。
		this.addChild(new Spacer(1));
		// 只有初始文案是真值才创建刷新 Text。
		if (config.refreshStatus) {
			// 初始刷新消息用弱色，前置两格缩进。
			this.refreshStatusText = new Text(theme.fg("muted", `  ${config.refreshStatus}`), 0, 0);
			// 加入后续可改文本的同一实例。
			this.addChild(this.refreshStatusText);
		}
		// 用当前状态构造底部帮助/计数。
		this.footerText = new Text(this.getFooterText(), 0, 0);
		// 加入底部 Text，后续 setText 更新而不反复添加。
		this.addChild(this.footerText);

		// 添加底部边框。
		this.addChild(new DynamicBorder());
		// 按当前下标绘候选，不触发 onChange。
		this.updateList();
	}

	// 用新目录替换 Map/顺序，可选同时替换启用状态，尽量按完整 id 保留当前选中行，无返回值。
	// 例失效 x 后来重现，就把删除线行换成有效元数据；不发请求、不清 dirty，也不触发 onChange，样式错误传播。
	updateModels(models: readonly Model<any>[], enabledModelIds?: string[] | null): void {
		// 记住当前光标身份，空列表时为 undefined。
		const selectedId = this.filteredItems[this.selectedIndex]?.fullId;
		// undefined 表示保留本地启用变化，null 则明确换成全启用；显式数组复制。
		if (enabledModelIds !== undefined) this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		// 清空旧目录映射，不删除 enabledIds 中失效条目。
		this.modelsById.clear();
		// 重新建立可用目录 id 顺序。
		this.allIds = [];
		// 按新目录顺序遍历。
		for (const model of models) {
			// 生成新模型完整身份字符串。
			const fullId = `${model.provider}/${model.id}`;
			// 保存目录模型引用。
			this.modelsById.set(fullId, model);
			// 记录顺序，不去重。
			this.allIds.push(fullId);
		}
		// 按现有查询重建行、计数与帮助。
		this.refresh();
		// 有旧身份才找它的新过滤下标，找不到 -1。
		const refreshedIndex = selectedId ? this.filteredItems.findIndex((item) => item.fullId === selectedId) : -1;
		// 旧项仍存在时才按身份恢复光标。
		if (refreshedIndex >= 0) {
			// 采用恢复位置。
			this.selectedIndex = refreshedIndex;
			// 再次绘窗口，避免前次按旧下标造成跳动。
			this.updateList();
		}
	}

	// 更新已创建的刷新状态 Text，无返回值；例宿主刷新结束传 success，不发起刷新/重画或创建缺失 Text。
	// 参数 kind 是三个颜色名联合，仅静态限制；主题处理异常传播。
	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		// 可选调用：没有初始状态 Text 时连参数着色表达式也不求值，静默不显示。
		this.refreshStatusText?.setText(theme.fg(kind, `  ${message}`));
	}

	// 依 enabled/all 顺序构建完整显示行数组，返回新数组；例失效启用 id 也保留行，model=undefined。
	// 只读目录/状态，不过滤查询、不通知宿主。
	private buildItems(): ModelItem[] {
		// 先决定启用在前的顺序，再 map 每个 id。
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			// 保留完整 id。
			fullId: id,
			// Map 查不到就 undefined，不偷偷移除此配置。
			model: this.modelsById.get(id),
			// 启用是菜单状态判断；null 对任何列出的行均 true。
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	// 生成帮助、有效/失效计数及 dirty 提示，返回带样式字符串；例 [a,x失效] 可显示 1/N enabled · 1 unavailable。
	// 不写磁盘、不比较实际持久化结果；只是读取本组件状态，主题错误传播。
	private getFooterText(): string {
		// 显式状态只数当前 Map 中存在的启用 id；null 用 allIds 长度，?? 保留有效计数 0。
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		// 显式状态另数缺目录项，null 时 0；原列表重复项仍可能重复计数。
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		// 只有 null 才展示 all enabled，不用长度单独推断。
		const allEnabled = this.enabledIds === null;
		// 计数文案由下面三元选择。
		const countText = allEnabled
			? // 全启用显示简短文字。
				"all enabled"
			: // 明确列表显示有效数/可用总数，有失效 id 时附加数量。
				`${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		// 将各动作帮助及计数组成片段数组。
		const parts = [
			// 确认在本面板是开关，不是直接切换当前聊天模型。
			`${keyDisplayText("tui.select.confirm")} toggle`,
			// 全启用动作提示。
			`${keyDisplayText("app.models.enableAll")} all`,
			// 清选择动作提示。
			`${keyDisplayText("app.models.clearAll")} clear`,
			// 按当前模型供应商批量切换的动作提示。
			`${keyDisplayText("app.models.toggleProvider")} provider`,
			// 两种顺序调整动作，中间斜杠只是显示。
			`${keyDisplayText("app.models.reorderUp")}/${keyDisplayText("app.models.reorderDown")} reorder`,
			// 保存动作提示，不在这里保存。
			`${keyDisplayText("app.models.save")} save`,
			// 加入刚算的计数文案。
			countText,
		];
		// 按本地 dirty 状态决定是否附未保存警告。
		return this.isDirty
			? // 片段用中点连接、整体弱色，再拼 warning 色 unsaved。
				theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: // 干净状态仅弱色帮助，不代表刚核对过磁盘。
				theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	// 读取查询→重建行→模糊筛选→限制下标上界→重画/更新帮助，无返回值；例清空查询恢复启用在前的完整顺序。
	// 不发模型目录刷新，方法名 refresh 在这里只指 UI 数据；不按身份保留光标，不通知变化，主题/筛选异常传播。
	private refresh(): void {
		// 取搜索框当前全文。
		const query = this.searchInput.getValue();
		// 先建全量行，包括失效启用项。
		const items = this.buildItems();
		// 按原查询真值决定是否调用 fuzzyFilter，空白串仍进入筛选分支。
		this.filteredItems = query
			? // 筛选返回按评分排的候选，回调为每行提供搜索文本。
				fuzzyFilter(items, query, (item) =>
					// 有真实模型与失效行选择不同的评分文本。
					item.model
						? // 有效行用 id/provider/name 的重复身份文本。
							getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name })
						: // 失效行只有完整 id 可搜索。
							item.fullId,
				)
			: // 空串不筛，直接采用完整 items 数组。
				items;
		// 仅把下标上界夹到末项，空列表上限取 0；没有 Math.max 包住 selectedIndex，因此负下标不会被此式修成 0。
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		// 清旧候选 Text 后重画窗口。
		this.updateList();
		// 同步更新计数与 dirty 提示，不主动 requestRender。
		this.footerText.setText(this.getFooterText());
	}

	// 把当前启用状态通知宿主，无返回值；例切 a 后宿主可改会话循环范围。
	// 显式数组传副本，null 原样；调用不 await，异步拒绝没有在这里 catch，组件不负责回滚状态。
	private notifyChange(): void {
		// 同步发起 onChange，Promise 返回值被忽略；函数同步抛错仍会立即传播。
		this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	// 重建最多 8 个候选窗口，标出光标/有效启用勾/失效删除线，再放详情，无返回值。
	// 例失效 x 用 unavailable 且无有效勾；只改组件树、不写终端、不发模型请求，样式/无效索引访问可抛错。
	private updateList(): void {
		// 先移除旧窗口所有 Text。
		this.listContainer.clear();

		// 没有过滤结果时只绘空结果文字。
		if (this.filteredItems.length === 0) {
			// 提示搜索未匹配，不代表全部目录加载失败。
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			// 不继续画下方当前模型详情。
			return;
		}

		// 计算尽量让光标居中的窗口起点。
		const startIndex = Math.max(
			// 起点最少 0。
			0,
			// 光标前目标留 4 项，同时限制窗口尾部不过度空白。
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		// 结束位置不超过列表长度，为不包含的右界。
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		// 只画窗口内候选。
		for (let i = startIndex; i < endIndex; i++) {
			// ! 是 TS 非空断言，不产生运行时检查；依赖数组/窗口下标约定。
			const item = this.filteredItems[i]!;
			// 选中只看光标下标，不等于启用状态。
			const isSelected = i === this.selectedIndex;
			// 光标项显示箭头，其余两格缩进。
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			// 有效行显示裸模型 id，失效行显示完整 provider/id；?? 只在缺值时回退。
			const id = item.model?.id ?? item.fullId;
			// 无元数据行画删除线，不移除配置。
			const styledId = item.model ? id : theme.strikethrough(id);
			// 光标项再套强调色。
			const modelText = isSelected ? theme.fg("accent", styledId) : styledId;
			// 有效行才计算额外名称，重复 id 信息的名字可以隐藏。
			const name = item.model ? getDistinctModelName(item.model) : undefined;
			// 非空额外名放括号弱色显示。
			const nameText = name ? theme.fg("muted", ` (${name})`) : "";
			// 元数据存在显示实际供应商，否则显示 unavailable。
			const providerBadge = theme.fg("muted", item.model ? ` [${item.model.provider}]` : " [unavailable]");
			// 有效模型且启用才画勾；失效启用项仍可存 enabled=true，但此处没有有效勾。
			const status = item.model && item.enabled ? theme.fg("accent", "✓ ") : "  ";
			// 拼行加入普通 Text，无鼠标选择回调，长项可以折行。
			this.listContainer.addChild(new Text(`${prefix}${status}${modelText}${nameText}${providerBadge}`, 0, 0));
		}

		// Add scroll indicator if needed
		// 窗口未覆盖全部项时附位置提示。
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			// 向列表容器添加下面的 Text。
			this.listContainer.addChild(
				// 用户可见位置使用 1 基下标，总数是过滤后候选数。
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}

		// 有项时附光标详情；前面空结果分支已 return。
		if (this.filteredItems.length > 0) {
			// 直接读 selectedIndex 对应行，没有运行时兜底；调用流程需维持有效位置。
			const selected = this.filteredItems[this.selectedIndex];
			// 详情前留一行。
			this.listContainer.addChild(new Spacer(1));
			// 加入下面的详情 Text。
			this.listContainer.addChild(
				// 使用普通文本组件。
				new Text(
					// 有模型则展示完整名字，否则仅提示不可用；不尝试远端补目录。
					theme.fg("muted", `  ${selected.model ? `Model Name: ${selected.model.name}` : "Model unavailable"}`),
					// 水平内边距为 0。
					0,
					// 垂直内边距为 0。
					0,
				),
			);
		}
	}

	// 顺序处理导航→重排→单项切换→批量→供应商→保存→原始取消键→搜索，无返回值，冲突动作以前面分支优先。
	// 例确认切换启用不关闭面板，Ctrl+C 有查询先清空、无查询才取消；大多动作可配置，但此文件取消仍匹配固定键。状态先改再通知宿主，不 await 异步回调，不提供失败回滚/未保存退出确认。
	handleInput(data: string): void {
		// 取当前共享键位。
		const kb = getKeybindings();

		// Navigation
		// 上移优先于其他动作。
		if (kb.matches(data, "tui.select.up")) {
			// 无项则消费此输入但不动位置。
			if (this.filteredItems.length === 0) return;
			// 首项上移环绕末项，否则减一。
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			// 只更新候选窗口。
			this.updateList();
			// 已消费上移，不继续匹配。
			return;
		}
		// 其后匹配下移。
		if (kb.matches(data, "tui.select.down")) {
			// 空列表不导航。
			if (this.filteredItems.length === 0) return;
			// 末项下移环绕首项，否则加一。
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			// 重建光标窗口。
			this.updateList();
			// 消费下移输入。
			return;
		}
		// 求可配置翻页目标，以 maxVisible=8 为步长；不匹配返回 undefined。
		const pageIndex = getSelectPageIndex(kb, data, this.selectedIndex, this.filteredItems.length, this.maxVisible);
		// 0 也是有效翻页下标，不能用真值判断。
		if (pageIndex !== undefined) {
			// 空列表时 helper 返回 0，仍不能当存在第 0 项。
			if (this.filteredItems.length === 0) return;
			// 应用夹到首末边界的下标，不环绕。
			this.selectedIndex = pageIndex;
			// 重画候选。
			this.updateList();
			// 翻页输入不再进入搜索。
			return;
		}

		// Reorder enabled models
		// 记录上移重排是否匹配。
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		// 记录下移重排是否匹配。
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		// 任一重排动作命中都消费，哪怕之后不能移动。
		if (reorderUp || reorderDown) {
			// null 代表无显式顺序，不允许在本分支重排。
			if (this.enabledIds === null) return;
			// 取当前过滤结果行。
			const item = this.filteredItems[this.selectedIndex];
			// 必须有行且启用；失效但仍启用的显式 id 也可重排。
			if (item && isEnabled(this.enabledIds, item.fullId)) {
				// 上移优先给 -1，若两动作同键也是上移。
				const delta = reorderUp ? -1 : 1;
				// 重排位置来自完整 enabledIds，不是搜索结果下标。
				const currentIndex = this.enabledIds.indexOf(item.fullId);
				// 计算相邻交换目标。
				const newIndex = currentIndex + delta;
				// Only move if within bounds
				// 明确顺序内不越界才交换。
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					// 用纯 helper 生成新顺序。
					this.enabledIds = move(this.enabledIds, item.fullId, delta);
					// 标记本地有未明确保存的操作。
					this.isDirty = true;
					// 过滤列表光标也简单加 delta，并不按 id 恢复；筛选重排情况下可能偏离目标，refresh 只修上界。
					this.selectedIndex += delta;
					// 按当前查询重建显示及帮助。
					this.refresh();
					// 之后通知宿主新显式顺序，传数组副本。
					this.notifyChange();
				}
			}
			// 重排动作到此结束，不走确认/搜索。
			return;
		}

		// Toggle on Enter
		// 确认在这里切换单项启用状态。
		if (kb.matches(data, "tui.select.confirm")) {
			// 读取当前过滤项。
			const item = this.filteredItems[this.selectedIndex];
			// 无项就不切状态。
			if (item) {
				// 切 id 并可能归一成 null，全启用归一会丢掉显式全启用顺序。
				this.enabledIds = toggle(this.enabledIds, this.allIds, item.fullId);
				// 即使最终状态与某份已存配置相同也标 dirty，未进行磁盘内容比较。
				this.isDirty = true;
				// 重建行/窗口/底部计数。
				this.refresh();
				// 把新状态交宿主应用，不等待它返回。
				this.notifyChange();
			}
			// 确认键不继续交搜索 Input 提交。
			return;
		}

		// Enable all (filtered if search active, otherwise all)
		// 批量启用动作。
		if (kb.matches(data, "app.models.enableAll")) {
			// 查询真值时只取过滤结果；空白查询也算“有查询”，无查询则 undefined 表示全部可用。
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			// 追加目标并尝试全启用归一；已经 null 时仍 null。
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			// 操作触发即标 dirty，未判断集合是否真的变化。
			this.isDirty = true;
			// 更新列表/帮助。
			this.refresh();
			// 通知宿主，即使结果仍 null 也调用。
			this.notifyChange();
			// 消费全启用动作。
			return;
		}

		// Clear all (filtered if search active, otherwise all)
		// 批量清选择动作。
		if (kb.matches(data, "app.models.clearAll")) {
			// 有查询只清当前过滤 id，无查询清全部启用项。
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			// 返回显式剩余数组，空选择为 []，宿主如何解释由回调决定。
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			// 标未保存。
			this.isDirty = true;
			// 重建候选与计数。
			this.refresh();
			// 通知宿主空/剩余选择，不直接禁用 Provider 或注销。
			this.notifyChange();
			// 消费批量清选择动作。
			return;
		}

		// Toggle provider of current item
		// 按当前行供应商切整组，不仅当前搜索可见项。
		if (kb.matches(data, "app.models.toggleProvider")) {
			// 先取当前过滤行。
			const item = this.filteredItems[this.selectedIndex];
			// 无元数据的失效行不能据此切 provider。
			if (item?.model) {
				// 取元数据实际供应商。
				const provider = item.model.provider;
				// 在全部可用 id 中找该 provider；! 是 TS 非空断言，依赖 allIds 与 Map 同步构建，不额外运行验证。
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
				// 该供应商所有可用模型都已启用才选择清整组，否则补全整组。
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				// 三元在后两行产新启用状态。
				this.enabledIds = allEnabled
					? // 这个 provider 整组已启用时清掉该组可用 id，不要求其他 provider 也全启用。
						clearAll(this.enabledIds, this.allIds, providerIds)
					: // 否则把这个 provider 的所有可用 id 加入。
						enableAll(this.enabledIds, this.allIds, providerIds);
				// 标本地未保存。
				this.isDirty = true;
				// 重建显示。
				this.refresh();
				// 回调通知新范围，不等待异步结果。
				this.notifyChange();
			}
			// provider 动作无论是否有有效行都结束此次分派。
			return;
		}

		// Save/persist to settings
		// 保存动作只发明确持久化意图，不自行写文件或关闭面板。
		if (kb.matches(data, "app.models.save")) {
			// 传 null 或副本；onPersist 允许 Promise，但此处未 await/catch，异步失败不阻止下面先清 dirty，同步抛错则会跳过后面。
			this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			// 只要同步调用返回就立即标干净，不是确认磁盘保存完成。
			this.isDirty = false;
			// 刷新底部未保存标记，不改变已选项。
			this.footerText.setText(this.getFooterText());
			// 消费保存输入，不自动关闭。
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		// 这里保留原固定 Ctrl+C 匹配，不使用 tui.select.cancel 配置动作。
		if (matchesKey(data, Key.ctrl("c"))) {
			// 有任何真值查询（包括空白）先清搜索，不关闭。
			if (this.searchInput.getValue()) {
				// 直接设空值，不触发 Input 自己的提交。
				this.searchInput.setValue("");
				// 恢复完整显示行并尽量保留位置上界。
				this.refresh();
			} else {
				// 查询已空才通知宿主关闭；不回滚先前 onChange 更新的会话状态。
				this.callbacks.onCancel();
			}
			// Ctrl+C 到此消费。
			return;
		}

		// Escape - cancel
		// 原始 Escape 无条件取消，不走“先清搜索”的两段行为。
		if (matchesKey(data, Key.escape)) {
			// 调用宿主取消，不自行移除组件/询问未保存。
			this.callbacks.onCancel();
			// 消费 Escape。
			return;
		}

		// Pass everything else to search input
		// 其余输入交搜索框编辑；本组件没给 Input 绑定 onSubmit/onEscape。
		this.searchInput.handleInput(data);
		// 无论文字是否变化都更新过滤；可能执行主题/布局等同步逻辑。
		this.refresh();
	}

	// 返回搜索框原引用，无副作用；例测试读取查询，外部 setValue 后仍需让本组件 refresh 路径运行才更新列表。
	getSearchInput(): Input {
		// 不复制 Input 或光标/撤销状态。
		return this.searchInput;
	}
}
