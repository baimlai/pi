/**
 * The `/mcp` manager view: menus that rebuild while servers connect, a read-only status screen, and
 * the sign-in screen that accepts a pasted redirect URL.
 */

// 管理界面只展示/收集用户选择；index.ts 提供菜单和业务操作，OAuth 校验与网络请求在 oauth.ts/runtime.ts。例：点“Sign in”后本界面接收粘贴地址，外层换码。
import {
	// type 项只描述组件/焦点/候选项/宿主类型；其余导入用于创建布局、输入框及按终端显示列测量文字。
	type Component,
	Container,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
// 命令上下文提供 ui.custom；KeybindingsManager 只作类型，实际实例由宿主传入。
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
// 链接组件负责显示和复制授权 URL；构造不打开浏览器，copy() 才尝试剪贴板操作。
import { AuthUrlComponent } from "../../modes/interactive/components/auth-url.ts";
// 边框按实际渲染宽度生成；显式传颜色函数，避免依赖另一模块缓存里的默认主题。
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
// 键提示与列表主题读取共享主题/键绑定；本类保存的 theme 则用于自己的标题/正文。
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getSelectListTheme, type Theme } from "../../modes/interactive/theme/theme.ts";

// 一份菜单数据的编译期结构；界面不在此验证唯一 value，也不执行 value 指定的业务。
export interface McpMenu {
	// 菜单标题，字符串不等于固定屏幕宽度。
	title: string;
	/** Shown below the title. */
	// 问号表示可省略；有 truthy details 才显示说明。
	details?: string;
	/** Shown below the details in the error color. */
	// 可选错误文字，用错误色显示，不自动抛异常。
	error?: string;
	// 候选项数组，每项 value 用于返回，label 用于显示。
	items: SelectItem[];
	/** Shown when there are no items. */
	// 空候选时的提示；undefined 回退默认文案，空字符串仍保留。
	empty?: string;
	/** Value of the item selected when the menu opens. */
	// 初始选项的 value，之后尽量保留用户当前选择；项被移除则回到新列表首项。
	selected?: string;
	/** What the confirm key does, for the key hint. */
	// 确认键的动作说明，例如 manage；不是键位定义。
	confirmLabel: string;
	/** What the cancel key does, for the key hint. */
	// 取消键说明，例如 back；实际匹配可配置键绑定。
	cancelLabel: string;
}

// 业务层依赖的三种交互接口；interface 只作 TS 检查，不产生窗口。
export interface McpUi {
	/**
	 * Show a menu and resolve to the chosen item's value, or undefined when cancelled. `subscribe`
	 * rebuilds the menu on every change, keeping the selected item.
	 */
	// build 每次返回新菜单；subscribe 接监听器并返回解除函数。Promise 在确认/取消时落定，异常边界由具体实现决定。
	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined>;
	/** Show a message while an operation runs. With `onCancel`, the cancel key calls it. */
	// 同步切到状态页；可选 onCancel 只发取消意图，不能强行终止外部异步任务。
	status(title: string, message: string, onCancel?: () => void): void;
	/**
	 * Show the authorization URL and wait for a pasted redirect URL. Resolves to undefined when
	 * cancelled or when `signal` aborts (the browser reached the callback).
	 */
	// 等待粘贴/取消并返回文字或 undefined；signal 也会结束等待。URL 是否属于本次授权由外层再验证。
	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined>;
}

// 组装标题、正文、页脚和边框并返回 Container；不写终端、不启动请求。例：body=[一行状态] 得带边框状态页；主题/子组件构造错误向上抛。
function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	// 新建按子组件顺序拼接行的容器。
	const container = new Container();
	// 上边框采用 accent 色；箭头回调在边框渲染时处理文字。
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	// 标题先加粗再着色，Text 的 1/0 是水平/垂直留白。
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	// for...of 依顺序添加正文组件，不复制组件内部状态。
	for (const child of body) container.addChild(child);
	// 只有非空页脚才额外排版。
	if (footer) {
		// 在正文与页脚间留一行空白。
		container.addChild(new Spacer(1));
		// 页脚使用 dim 色，左右留一列。
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	// 添加下边框，与上边框使用相同颜色规则。
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	// 返回布局对象；真正生成文字要等 render(width)。
	return container;
}

// 列表最多显示12项，超出仍可滚动；不是服务器数量上限。
const MAX_VISIBLE_ITEMS = 12;

// Pick 只挑组件的输入方法和视口键标志，保留原可选性；不要求具备 render/invalidate。
type InputHandler = Pick<Component, "handleInput" | "capturesViewportInput">;

// 同一界面在菜单、状态和登录输入间切换。implements 约束编译期形状；这里只保留当前布局，不自动取消旧菜单或业务。
export class McpManagerView implements McpUi, Component, Focusable {
	// 宿主 TUI 用于请求重画；readonly 不冻结宿主对象。
	private readonly tui: TUI;
	// 保存传入主题引用，切换布局时调用其样式函数。
	private readonly theme: Theme;
	// 保存输入匹配器；键提示/SelectList 另读全局键绑定，宿主正常配置让它们一致。
	private readonly keybindings: KeybindingsManager;
	// 当前待渲染布局，可以被 setContent 替换。
	private content: Container;
	// 当前键盘处理器；undefined 表示不处理输入。
	private inputHandler: InputHandler | undefined;
	// 需要同步硬件光标焦点的目标；本类登录页传 Input，SelectList 不要求 Focusable。
	private inputTarget: Focusable | undefined;
	// 管理页自己的焦点状态，初始未聚焦。
	private _focused = false;

	// 保存宿主依赖并先显示 Loading 布局，不连接 MCP。例：new McpManagerView(tui,theme,kb) 等外层调用 menu/status；构造布局出错会传播。
	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		// 保存终端宿主引用，不主动绘制。
		this.tui = tui;
		// 保存本页主题，不复制主题对象。
		this.theme = theme;
		// 保存可配置键匹配器。
		this.keybindings = keybindings;
		// 建立初始占位页面；真正菜单随后替换它。
		this.content = frame(theme, "MCP servers", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	// 读取 view.focused 返回本页焦点；getter 像字段访问，不产生输入事件。
	get focused(): boolean {
		// 返回保存的布尔值。
		return this._focused;
	}

	// 写 view.focused 同时更新当前可聚焦目标；例失焦时让输入框不再发硬件光标位置。
	set focused(value: boolean) {
		// 更新本页状态，setter 本身不重画。
		this._focused = value;
		// 有目标才同步焦点，状态/普通菜单可能没有该目标。
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	// 告诉全屏宿主是否让本页优先接收翻页等视口键；只有当前处理器显式 true 才返回 true。
	get capturesViewportInput(): boolean {
		// 可选链允许没有处理器；严格比较不把缺失或其他 truthy 值当 true。
		return this.inputHandler?.capturesViewportInput === true;
	}

	// 切换布局及输入接收者，先撤旧目标焦点再赋新目标并请求重画；例状态页切登录页。只替换引用，不解除 menu 的订阅或完成其 Promise。
	private setContent(content: Container, inputHandler?: InputHandler, inputTarget?: Focusable): void {
		// 先令旧输入框失焦，避免它继续输出硬件光标标记。
		if (this.inputTarget) this.inputTarget.focused = false;
		// 替换布局引用，旧布局不再由本页 render。
		this.content = content;
		// 替换键处理器，省略时清空旧处理器。
		this.inputHandler = inputHandler;
		// 替换需要焦点的目标，省略也会清掉旧目标。
		this.inputTarget = inputTarget;
		// 新目标继承本页当前焦点，不强制抢宿主焦点。
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		// 安排宿主重画；不是在这里直接向终端写完整屏幕。
		this.tui.requestRender();
	}

	// 显示菜单并等待确认/取消；输入 build 和可选订阅器，返回 value/undefined。例选中 docs 返回 "docs"；重建尽量保留同名项，finish 才退订，setContent 不自动退订。
	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined> {
		// Promise executor 立即运行；这里同步 build/render/subscribe 抛错会使 Promise 拒绝，后续订阅回调抛错不由 executor 自动捕获。
		return new Promise((resolve) => {
			// 保存可选退订函数，供完成时调用。
			let unsubscribe: (() => void) | undefined;
			// 布尔标记防止多次确认/取消重复执行完成逻辑。
			let settled = false;
			// 完成闭包：输入选中值或 undefined，先退订再 resolve；退订若抛错，后面的 resolve 不会执行。
			const finish = (value: string | undefined) => {
				// 已完成就忽略重复操作。
				if (settled) return;
				// 先设为完成，避免重入时重复退订。
				settled = true;
				// 可选调用；没有订阅器时不用退订。
				unsubscribe?.();
				// 把选择交给等待 menu 的业务循环，菜单本身不执行该业务。
				resolve(value);
			};
			// 保存最近选择 value，而不是数组下标，利于刷新后恢复。
			let selected: string | undefined;
			// 重建闭包：重新取数据、恢复可用选择、替换布局；不返回菜单业务结果。例服务器连好后刷新状态文字。
			const render = () => {
				// 调用业务层提供的最新快照函数，错误不在这里吞掉。
				const menu = build();
				// 已保存选择优先，否则用菜单初始 selected；?? 只回退 null/undefined。
				const wanted = selected ?? menu.selected;
				// 本次新建正文组件数组。
				const body: Component[] = [];
				// 有说明才加入正文，文本色使用本页传入主题。
				if (menu.details) body.push(new Text(this.theme.fg("muted", menu.details), 1, 0));
				// 有错误才加入错误色文字，不把它转成 JS 异常。
				if (menu.error) body.push(new Text(this.theme.fg("error", menu.error), 1, 0));
				// 说明区与候选区之间空一行。
				body.push(new Spacer(1));
				// 从可配置动作名生成确认/取消键提示，模板字符串拼接两个提示。
				const footer = `${keyHint("tui.select.confirm", menu.confirmLabel)} • ${keyHint("tui.select.cancel", menu.cancelLabel)}`;
				// 无候选时不用构造 SelectList。
				if (menu.items.length === 0) {
					// 显示空态，?? 保留显式空串。
					body.push(new Text(this.theme.fg("muted", menu.empty ?? "Nothing to show."), 1, 0));
					// 空态只提供取消处理器，无需传可聚焦目标。
					this.setContent(frame(this.theme, menu.title, body, keyHint("tui.select.cancel", menu.cancelLabel)), {
						// 原始键数据交配置匹配器；不是直接比较某个硬编码控制字符。
						handleInput: (data) => {
							// 命中取消动作就以 undefined 结束菜单。
							if (this.keybindings.matches(data, "tui.select.cancel")) finish(undefined);
						},
					});
					// 空态已布局，跳过下方非空列表构造。
					return;
				}
				// 非空时新建 SelectList；选择和翻页逻辑由组件实现。
				const list = new SelectList(
					// 传候选数组引用，不在此克隆每项。
					menu.items,
					// 可见项数取实际长度与12的较小值。
					Math.min(menu.items.length, MAX_VISIBLE_ITEMS),
					// 列表主题来自全局 theme helper，不是传入 this.theme 的直接别名保证。
					getSelectListTheme(),
				);
				// 按 value 找恢复项；重复 value 会选第一个。
				const index = menu.items.findIndex((item) => item.value === wanted);
				// 仍存在才恢复下标，不存在就沿用 SelectList 默认首项。
				if (index !== -1) list.setSelectedIndex(index);
				// 记录实际选中值，?. 容许没有选中项。
				selected = list.getSelectedItem()?.value;
				// 光标移动回调只记选择，不代表用户已经确认。
				list.onSelectionChange = (item) => {
					// 下次重建时优先尝试这个 value。
					selected = item.value;
				};
				// 确认才把选项 value 交 finish。
				list.onSelect = (item) => finish(item.value);
				// 取消统一返回 undefined。
				list.onCancel = () => finish(undefined);
				// 将列表加进正文布局。
				body.push(list);
				// 列表自身作键处理器；这里没传 inputTarget，不做 Focusable 字段转发。
				this.setContent(frame(this.theme, menu.title, body, footer), list);
			};
			// 先同步画初始菜单，之后才安装更新订阅。
			render();
			// 订阅器可缺失；返回的函数存给 finish。若订阅器同步触发完成再返回退订函数，本方法没有额外补退订逻辑。
			unsubscribe = subscribe?.(() => {
				// 已完成后忽略订阅通知，否则重新 build 并替换整个列表。
				if (!settled) render();
			});
		});
	}

	// 切换到状态页，不等待操作完成。例显示“Connecting…”；有 onCancel 才提供取消键，回调异常照常传播，不能保证业务真的停止。
	status(title: string, message: string, onCancel?: () => void): void {
		// 正文先空一行再显示状态文字。
		const body = [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)];
		// 没有取消回调时状态页不处理键。
		if (!onCancel) {
			// 换布局同时清掉旧处理器和焦点目标。
			this.setContent(frame(this.theme, title, body));
			// 直接返回 void，业务由外层继续运行。
			return;
		}
		// 有取消功能才显示 cancel 键提示并装处理器。
		this.setContent(frame(this.theme, title, body, keyHint("tui.select.cancel", "cancel")), {
			// 键事件闭包捕获本次 onCancel。
			handleInput: (data) => {
				// 命中配置动作就同步调用；重复按键可能重复通知，不在这里设置一次性标记。
				if (this.keybindings.matches(data, "tui.select.cancel")) onCancel();
			},
		});
	}

	// 显示授权链接并等待粘贴，返回 trim 后非空文字或 undefined。例粘完整回调URL回车后交外层校验；取消/abort 完成一次并去信号监听，不打开浏览器，也不自动换回状态页。
	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined> {
		// 异步等待由 Promise 表示，构造界面/注册监听同步进行。
		return new Promise((resolve) => {
			// 防止回车、取消、abort 多路重复完成。
			let settled = false;
			// 完成闭包移除 abort 监听再返回值；不会清空当前布局或 inputHandler。
			const finish = (value: string | undefined) => {
				// 重复调用不再产生结果。
				if (settled) return;
				// 先标完成以防重入。
				settled = true;
				// 移除本次取消监听；已经触发的 once 监听也可再次移除。
				signal.removeEventListener("abort", onAbort);
				// 把值交 OAuth 等待逻辑，URL合法性仍未在此验证。
				resolve(value);
			};
			// abort 与主动取消共用 undefined 结果。
			const onAbort = () => finish(undefined);
			// 先检查已取消，避免安装新页面后才发现取消。
			if (signal.aborted) {
				// 已取消立即完成，不构造输入框。
				finish(undefined);
				// 跳出 executor，其返回值本身不会成为 Promise 的结果。
				return;
			}
			// 未取消才订阅一次性 abort 通知。
			signal.addEventListener("abort", onAbort, { once: true });
			// 新建单行输入框，初始值为空。
			const input = new Input();
			// 创建可点击/可复制链接；不在构造时读写剪贴板或打开浏览器。
			const link = new AuthUrlComponent(this.tui, authorizationUrl);
			// 正文是组件数组，依序排列提示、链接与输入框。
			const body: Component[] = [
				// 标题下留一行空白。
				new Spacer(1),
				// 浏览器授权提示，不代表浏览器确实已成功打开。
				new Text(this.theme.fg("muted", "Approve access in your browser. If it did not open, visit:"), 1, 0),
				// 放入包含完整 URL 的链接组件。
				link,
				// 链接后留一行，分开手工粘贴提示。
				new Spacer(1),
				// 多行调用构造一段提示文字，下一行是实际文本参数。
				new Text(
					// 提示异机浏览器场景，文字只作说明。
					this.theme.fg("muted", "If the browser runs on another machine, paste the URL it was redirected to:"),
					// Text 左右留白1列。
					1,
					// Text 上下不另加空行。
					0,
				),
				// 加入输入框，后面也把同一实例作为焦点目标。
				input,
			];
			// 同时替换布局、键处理器和焦点目标。
			this.setContent(
				// frame 组合当前主题、标题和正文。
				frame(
					// 本页主题用于外框样式。
					this.theme,
					// 沿用登录业务提供的标题。
					title,
					// 正文使用上面新建组件数组。
					body,
					// 显示提交和取消动作对应的键提示。
					`${keyHint("tui.select.confirm", "submit")} • ${keyHint("tui.select.cancel", "cancel")}`,
				),
				// 自定义键处理对象包住 Input，先拦截业务快捷键。
				{
					// 处理原始输入数据，不在此解析 OAuth 参数。
					handleInput: (data) => {
						// 先匹配提交；同一键若也属于后续动作，只会走这个分支。
						if (this.keybindings.matches(data, "tui.select.confirm")) {
							// 读取完整输入值并 trim，不受屏幕截断影响。
							const value = input.getValue().trim();
							// 非空才完成；空输入继续等待。
							if (value) finish(value);
							// 提交键不再交 Input 处理，避免成为文字或换行。
							return;
						}
						// 其次匹配取消动作。
						if (this.keybindings.matches(data, "tui.select.cancel")) {
							// 以 undefined 告诉外层用户取消。
							finish(undefined);
							// 取消键不继续传给输入框。
							return;
						}
						// 复制动作优先复制授权 URL，而非当前输入文字。
						if (this.keybindings.matches(data, "app.message.copy")) {
							// void 放弃等待复制 Promise；AuthUrlComponent 内把剪贴板失败显示成提示，不能保证复制成功。
							void link.copy();
							// 复制快捷键被消费，不写进输入框。
							return;
						}
						// 其余键/粘贴数据交 Input 自身编辑逻辑。
						input.handleInput(data);
					},
				},
				// Input 才是 Focusable 目标；本页 focused 状态会同步给它。
				input,
			);
		});
	}

	// 将一次键输入转发给当前处理器并请求重画，返回 void。例菜单中翻页由 SelectList处理；处理器抛错时后续 requestRender 不执行。
	handleInput(data: string): void {
		// 两层可选调用分别容许没有处理器、处理器没有 handleInput。
		this.inputHandler?.handleInput?.(data);
		// 安排一次宿主重画，不直接同步 render。
		this.tui.requestRender();
	}

	// 按给定终端列宽返回当前布局文字行；超宽行二次截断，保留原数组以外的新映射结果。例80列窗口裁掉长提示，不改真实输入值；子组件错误传播。
	render(width: number): string[] {
		// 从当前布局取得渲染链起点。
		return (
			this.content
				// 先让各子组件按 width 布局。
				.render(width)
				// 用显示列而非字符串 length 衡量；超宽才无省略号截断，不限制输出行数。
				.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line))
		);
	}

	// 通知当前子组件缓存失效，无返回数据；例主题改变后调用。这里只 invalidate，不请求渲染或重建菜单快照。
	invalidate(): void {
		// Container 会逐个转发 invalidate；本页不另清自己的输入值。
		this.content.invalidate();
	}
}

/** Run `manage` in the manager view until it returns. */
// 在宿主自定义组件中运行管理流程，完成后 done 退出，返回 Promise<void>。例 await showMcpManager(ctx,manage) 等用户关闭；manage 拒绝会通知并 done，但通知本身抛错/同步抛错没有额外保护。
export async function showMcpManager(
	// 命令上下文提供UI与通知，不是 MCP 网络客户端。
	ctx: ExtensionCommandContext,
	// 宿主业务函数接 McpUi 并异步完成，界面不自行决定服务器动作。
	manage: (ui: McpUi) => Promise<void>,
): Promise<void> {
	// custom 的泛型 void 表示 done 不携带结果；宿主负责聚焦/挂载这个组件。
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		// 创建本次独立界面实例。
		const view = new McpManagerView(tui, theme, keybindings);
		// 启动管理 Promise 并注册完成/失败回调，不在工厂内 await；manage若同步抛错发生在 then 安装前。
		void manage(view).then(
			// 正常结束时通知宿主关闭自定义组件。
			() => done(),
			// unknown 异常先经 instanceof 收窄，非 Error 用 String。
			(error: unknown) => {
				// 向界面发错误通知，不在此记录服务端日志。
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				// 通知成功返回后也关闭管理页；通知抛错则到不了这一行。
				done();
			},
		);
		// 工厂立即把组件交给宿主显示，管理流程仍可在等待用户。
		return view;
	});
}
