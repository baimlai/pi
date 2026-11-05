/**
 * 认证方式候选列表：宿主先投影供应商/已配置状态，本文件显示名字、方式与来源，提供模糊搜索、分页和选择回调。
 * 名称沿用 OAuthSelector，但候选也支持 API key；组件不启动认证、不删除凭证、不向服务端验证配置状态。
 * 例同供应商可各有 oauth/api_key 两行，确认回传 id+authType 让宿主分派；状态后缀只解释传入 AuthCheck，不证明凭证仍有效。
 */
// 三个类型来自 AI 认证契约，type 导入会擦除，不在此执行 login/check 或加载供应商登录流程。
import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@earendil-works/pi-ai";
// 布局、输入和模糊筛选等运行能力来自 TUI，Focusable 只是编译期接口。
import {
	// Container 组合子组件渲染，本类自行路由键盘。
	Container,
	// Focusable 的 focused 字段由宿主切换，下面再传给 Input。
	type Focusable,
	// fuzzyFilter 将空白/斜杠分词，要求各词匹配并按质量排序，不是简单 includes。
	fuzzyFilter,
	// 每次输入读取当前键位配置。
	getKeybindings,
	// 翻页 helper 计算新下标，不自己修改组件状态。
	getSelectPageIndex,
	// Input 维护搜索文字/光标并支持提交回调。
	Input,
	// Spacer 提供空行。
	Spacer,
	// TruncatedText 按显示宽度裁成单行，不像 Text 自动把候选折成多行。
	TruncatedText,
} from "@earendil-works/pi-tui";
// 共享主题为显示名/提示着色。
import { theme } from "../theme/theme.ts";
// 边框组件按当前主题生成行。
import { DynamicBorder } from "./dynamic-border.ts";

// 一行认证候选的数据类型，宿主可给同一 id 提供不同 authType，类型本身不保证唯一或关联 method/status 一致。
export type AuthSelectorProvider = {
	// 供应商 id，确认时回传，非秘密凭证。
	id: string;
	// 供应商显示名，也是模糊搜索字段。
	name: string;
	// 当前行代表的认证类别，字符串字面联合不等于实际当前使用的认证。
	authType: "oauth" | "api_key";
	// 可选认证能力描述对象，联合含 API key/OAuth；列表只读取其 name，不执行 login。
	method?: ApiKeyAuth | OAuthAuth;
	// 可选配置状态，没有就画未配置；AuthCheck 只含 type/可选来源，非 token 或远端有效性证明。
	status?: AuthCheck;
	/**
	 * Whether the provider's OAuth sign-in is backed by a subscription. `false` labels it as an account;
	 * unset keeps the "subscription" label.
	 */
	// 订阅标签元数据：恰为 false 用 account，undefined 保留 subscription；真实宿主通常从 isSubscription===true 生成布尔快照。
	subscription?: boolean;
};

// formatAuthSelectorProviderType 将认证类别/可选订阅标志转为英文标签，无副作用；例如 oauth+false 得 account，api_key 无论订阅标志都得 API key，不探测账号套餐。
export function formatAuthSelectorProviderType(
	// 索引访问类型取候选 authType 的两项联合，避免重复声明。
	authType: AuthSelectorProvider["authType"],
	// 可选布尔省略后为 undefined，不自动补 false。
	subscription?: boolean,
): string {
	// API key 分支优先并直接返回。
	if (authType === "api_key") return "API key";
	// OAuth 仅严格 false 用 account，其他允许值 true/undefined 都用 subscription。
	return subscription === false ? "account" : "subscription";
}

/** Themed suffix describing whether and how a login option is configured, for example " ✓ configured". */
// formatAuthSelectorProviderStatus 依配置缺失/方式不同/来源标签格式返回带主题后缀；例如 source=OPENAI_API_KEY 显示 env 前缀。无认证 I/O，不验证环境变量真的存在或 token 可用。
export function formatAuthSelectorProviderStatus(provider: AuthSelectorProvider): string {
	// 无 status 时显示未配置；只读传入快照，不临时查凭证。
	if (!provider.status) return theme.fg("muted", " • not configured");
	// 已有配置类别与此行不同，提醒用户配置的是另一方式。
	if (provider.status.type !== provider.authType) {
		// 用实际 status.type 的标签生成 configured 文字，subscription 仍沿用候选元数据。
		const label = `${formatAuthSelectorProviderType(provider.status.type, provider.subscription)} configured`;
		// 前导符用 muted，另一认证方式配置提示用 warning，名字相同也不表示本行方式已配置。
		return theme.fg("muted", " • ") + theme.fg("warning", label);
	}
	// 同方式时先判断是否使用无需展示详细来源的简洁提示。
	if (
		// source 缺失或空字符串都走简洁 configured。
		!provider.status.source ||
		// 来源原文恰为 OAuth 也不重复显示。
		provider.status.source === "OAuth" ||
		// 恰为 stored credential 同样只显示已配置。
		provider.status.source === "stored credential"
	) {
		// 返回 success 后缀，仅为快照说明，不发请求验证。
		return theme.fg("success", " ✓ configured");
	}
	// 正则要求一个或多个大写环境变量式名字、逗号后恰一个空格，整串匹配；不真的读取 process.env，也没有多行 m 模式。
	const source = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(provider.status.source)
		? // 符合外观就加 env: 标签，不能把这个显示猜测当作来源验证。
			`env: ${provider.status.source}`
		: // 不符合就原样展示来源说明，不自动脱敏或过滤任意控制字符。
			provider.status.source;
	// 状态文字着 success 色；字符串含原 source，不输出任何另取的凭证内容。
	return theme.fg("success", ` ✓ ${source}`);
}

// 列表窗口最多8个供应商候选，不含上下边框/搜索/滚动说明行。
const MAX_VISIBLE = 8;

/**
 * Component that renders an auth provider selector
 */
// 实现 Focusable 只检查字段形状，本类主动把焦点传给搜索框；并不自动获得认证或存储能力。
export class OAuthSelectorComponent extends Container implements Focusable {
	// 全屏焦点模式下声明接收视口滚动类输入，让键可送给本选择器；readonly 不在运行时冻结实例。
	readonly capturesViewportInput: boolean = true;
	// 搜索输入实例，构造时创建。
	private searchInput: Input;

	// Focusable implementation - propagate to search input for IME cursor positioning
	// 私有焦点初始 false，不自己向 TUI 抢焦点。
	private _focused = false;
	// focused getter 返回标记，无副作用；例如宿主读焦点不移动选择。
	get focused(): boolean {
		// 直接读内部字段。
		return this._focused;
	}
	// focused setter 保存并透传 Input，返回隐式 void；例如聚焦选择器后搜索框可发 IME 光标位置标记，不代表开始认证。
	set focused(value: boolean) {
		// 更新外层焦点。
		this._focused = value;
		// 更新内部搜索框焦点，沿用同一个 Input。
		this.searchInput.focused = value;
	}

	// 候选显示子容器，每次重画 clear 后重建。
	private listContainer: Container;
	// 保存输入数组原引用，不拷贝/冻结供应商对象。
	private allProviders: AuthSelectorProvider[];
	// 当前过滤结果；无有效查询时可能仍与 allProviders 是同一个数组。
	private filteredProviders: AuthSelectorProvider[];
	// 0起始选中下标，搜索时只夹范围，不自动按供应商身份保留/移到第一项。
	private selectedIndex: number = 0;
	// 模式影响标题/空状态文案；是否只有已登录候选由宿主提前筛选。
	private mode: "login" | "logout";
	// 确认回传 id 与该行 authType；void 回调不在组件中 await，异常可传播。
	private onSelectCallback: (providerId: string, authType: AuthSelectorProvider["authType"]) => void;
	// 取消回调，组件不主动移除自身。
	private onCancelCallback: () => void;
	// 是否展示方式后缀在构造时按全部输入种类算一次，筛选后不重算。
	private showAuthTypeLabels: boolean;

	// 构造保存 mode/候选/回调→建边框标题/搜索→设置提交回调→建列表→初筛，无认证副作用；例如传 oauth/api_key 混合列表才显示每行方式标签。
	constructor(
		// login/logout 是 UI 模式，构造不自动登录或注销。
		mode: "login" | "logout",
		// 宿主已选好的候选数组，顺序/数据在此不重新取目录。
		providers: AuthSelectorProvider[],
		// 所选结果通知宿主，由它调用真正认证服务。
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		// 关闭/返回操作通知宿主。
		onCancel: () => void,
		// 可选初始搜索，空字符串与省略都显示全列表。
		initialSearchInput?: string,
	) {
		// 先初始化父 Container，再访问 this。
		super();

		// 保存模式快照。
		this.mode = mode;
		// 保留完整候选原数组引用。
		this.allProviders = providers;
		// 初始过滤列表也指向同数组，后面初筛再按查询替换。
		this.filteredProviders = providers;
		// map 投影 authType，再用 Set 去重；种类数大于1才显示方式后缀，不按 id 数量决定。
		this.showAuthTypeLabels = new Set(providers.map((provider) => provider.authType)).size > 1;
		// 保存确认函数，不立即调用。
		this.onSelectCallback = onSelect;
		// 保存取消函数。
		this.onCancelCallback = onCancel;

		// Add top border
		// 加入顶部动态边框。
		this.addChild(new DynamicBorder());
		// 标题前留空行。
		this.addChild(new Spacer(1));

		// Add title
		// 按模式选英文标题，logout 不在此核对已存凭证。
		const title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";
		// 标题先粗体/accent，再用单行截断组件，左右留1列、上下0行。
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		// 标题和搜索框之间空一行。
		this.addChild(new Spacer(1));

		// 创建独立搜索框，文字初始为空。
		this.searchInput = new Input();
		// 初始文字为真值才 setValue，纯空格真值也会保留输入框显示。
		if (initialSearchInput) {
			// setValue 不自动把光标移到末尾；新框的光标仍按其原下标夹紧。
			this.searchInput.setValue(initialSearchInput);
		}
		// 搜索框的提交回调可处理 Input 自己识别的提交键，例如未由上层确认分支消费的 LF；不只是构造时执行一次。
		this.searchInput.onSubmit = () => {
			// 提交时读当前过滤数组和下标，不捕获构造时首项。
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			// 有候选才通知，空列表/越界不提交。
			if (selectedProvider) {
				// 回传 id 和类别，既不调用 method.login，也不直接关闭列表。
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		};
		// 将搜索框加入布局，焦点另由宿主设置。
		this.addChild(this.searchInput);
		// 搜索与列表之间空一行。
		this.addChild(new Spacer(1));

		// Create list container
		// 创建可重建的候选区。
		this.listContainer = new Container();
		// 接入父布局，之后 updateList 只改这个区。
		this.addChild(this.listContainer);

		// 候选后加空白。
		this.addChild(new Spacer(1));

		// Add bottom border
		// 底部边框完成布局。
		this.addChild(new DynamicBorder());

		// Initial render
		// 用初始查询筛选并建列表；?? 只在未提供时用空串，过滤 helper 会自行处理空白查询。
		this.filterProviders(initialSearchInput ?? "");
	}

	// filterProviders 由查询得候选→把旧数字下标夹到新范围→重建列表，无返回/认证；例如原下标3筛成2项会选下标1，不保证仍是原供应商或首项。
	private filterProviders(query: string): void {
		// 替换过滤列表引用，多行三元共同构成一次赋值。
		this.filteredProviders = query
			? // query 真值才调用 fuzzyFilter；只有空白的真值串也会由 helper 回退原数组。
				fuzzyFilter(
					// 模糊筛选输入为全部候选，不在上次结果上继续缩小。
					this.allProviders,
					// 传查询原文，分词/评分规则由 helper 负责。
					query,
					// 搜索拼供应商显示名/id/认证类别/方法名；?. 与 ?? 让缺 method 时补空串，不搜索 status 来源文字。
					(provider) => `${provider.name} ${provider.id} ${provider.authType} ${provider.method?.name ?? ""}`,
				)
			: // 空查询直接使用原数组，不建新副本。
				this.allProviders;
		// 夹紧数字下标到至少0和最后有效下标；空列表仍留0，不表示第0项存在。
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		// 重建显示行，不自动 requestRender。
		this.updateList();
	}

	// updateList 清候选区→取围绕光标的8项窗口→拼状态/方式/光标→加滚动/空提示，返回 void，无文件或网络副作用；例如筛空但原列表非空显示 No matching providers。
	private updateList(): void {
		// 清掉旧候选 Text，不清搜索框文字或所有供应商数组。
		this.listContainer.clear();

		// 窗口起点尽量让选中项居中，再夹到可用起点范围。
		const startIndex = Math.max(
			// 最外层 Math.max 的下界0避免负起点。
			0,
			// 半窗为4项，同时避免尾页后方空缺；列表不足8时内值可负，外层夹回0。
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filteredProviders.length - MAX_VISIBLE),
		);
		// 结束位置不含该下标，最多到列表长度。
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filteredProviders.length);

		// 只遍历本窗口候选，i++ 保持过滤排序后的次序。
		for (let i = startIndex; i < endIndex; i++) {
			// 取当前候选对象，不复制。
			const provider = this.filteredProviders[i];
			// 原实现对缺项直接跳过，不创建占位行。
			if (!provider) continue;

			// 判断本行是否处在选中下标。
			const isSelected = i === this.selectedIndex;

			// 根据传入 AuthCheck 快照生成后缀，不调用 provider 的 check 方法。
			const statusIndicator = formatAuthSelectorProviderStatus(provider);
			// 显示认证种类标签与否使用构造时总列表快照，不随过滤重新计算。
			const authTypeLabel = this.showAuthTypeLabels
				? // 需要时用候选 authType/subscription 生成方括号标签。
					theme.fg("muted", ` [${formatAuthSelectorProviderType(provider.authType, provider.subscription)}]`)
				: // 只有一种类型时省略，不自动改 provider.name。
					"";
			// let line 先空串，后面选中/未选中分支各自赋值。
			let line = "";
			// 选中行使用强调色箭头和名字。
			if (isSelected) {
				// 前缀包含箭头及一个空格。
				const prefix = theme.fg("accent", "→ ");
				// 只给名字加 accent，不对输入文字做额外控制符清理。
				const text = theme.fg("accent", provider.name);
				// 按固定顺序接名字、方式和状态后缀。
				line = prefix + text + authTypeLabel + statusIndicator;
			} else {
				// 未选中行用两个空格对齐，名字用普通 text 色。
				const text = `  ${theme.fg("text", provider.name)}`;
				// 方式和状态后缀与选中行相同。
				line = text + authTypeLabel + statusIndicator;
			}

			// 加单行截断候选，长名字/来源会被裁宽，左右留1列、上下0行。
			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		// 窗口前后还有未显示候选才加计数提示。
		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			// 选中序号改成1起始，分母是过滤后候选数，不是全部供应商数。
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			// 滚动说明另占一行，不计入8项窗口。
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		// Show "no providers" if empty
		// 过滤结果空时，区分原本无候选与查询未匹配。
		if (this.filteredProviders.length === 0) {
			// 嵌套三元组成一个空状态文案值。
			const message =
				// 先判断总候选是否为空。
				this.allProviders.length === 0
					? // 总候选空时再按 login/logout 选提示。
						this.mode === "login"
						? // 登录模式没有候选可选。
							"No providers available"
						: // 注销模式给原英文登录提示；实际是否已登录列表仍由宿主保证。
							"No providers logged in. Use /login first."
					: // 原有候选但搜索没命中，用匹配失败提示。
						"No matching providers";
			// 提示以 muted 文字展示，不虚构一条可提交候选。
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
		}
	}

	// handleInput 按上下/翻页/确认/取消分派，其他进搜索再筛选，返回 void；例如 PageDown 改数字光标、确认回传 id+方式。无组件内完成锁，回调错误透传，异步结果不 await。
	handleInput(keyData: string): void {
		// 读取当前键位配置，允许用户改默认键。
		const kb = getKeybindings();
		// 先计算翻页候选下标，非翻页键 undefined；最终上下分支仍比翻页处理优先。
		const pageIndex = getSelectPageIndex(kb, keyData, this.selectedIndex, this.filteredProviders.length, MAX_VISIBLE);
		// Up arrow
		// 配置上移键，不额外把 k 当上移；普通 k 可用于搜索。
		if (kb.matches(keyData, "tui.select.up")) {
			// 空结果没有可选项，直接返回，不把导航键输入搜索。
			if (this.filteredProviders.length === 0) return;
			// 向上减1并夹0，首项不环绕末项。
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			// 更新候选行文字，不自己写终端。
			this.updateList();
		}
		// Down arrow
		// 配置下移分支，和上移互斥。
		else if (kb.matches(keyData, "tui.select.down")) {
			// 空列表直接消费按键。
			if (this.filteredProviders.length === 0) return;
			// 向下加1并夹最后下标。
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			// 重画候选区。
			this.updateList();
		}
		// Page up/down
		// 只有 helper 识别翻页键才进入，!==undefined 允许合法的新下标0。
		else if (pageIndex !== undefined) {
			// helper 对空列表可能算0，仍须空列表早返。
			if (this.filteredProviders.length === 0) return;
			// 保存算出的分页下标，不另累加。
			this.selectedIndex = pageIndex;
			// 按新位置重建窗口。
			this.updateList();
		}
		// Enter
		// 配置确认键优先于 Input 的提交处理。
		else if (kb.matches(keyData, "tui.select.confirm")) {
			// 从当前过滤结果取所选项。
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			// 没有候选不调用回调。
			if (selectedProvider) {
				// 同步通知宿主，组件不执行 login/logout/自动关闭。
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		}
		// Escape or Ctrl+C
		// 取消只按配置匹配，原英语提到 Ctrl+C 不等于此处额外硬编码了该键。
		else if (kb.matches(keyData, "tui.select.cancel")) {
			// 通知宿主取消，不清候选或凭证。
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			// 未消费输入交搜索框，它还可能调用上面 onSubmit；Input 编辑规则决定哪些文字被接受。
			this.searchInput.handleInput(keyData);
			// 用完整搜索文字重新筛选/夹下标，即使这次输入只是提交而没改文字也会重建列表。
			this.filterProviders(this.searchInput.getValue());
		}
	}
}
