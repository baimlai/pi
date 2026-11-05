// 交互模式的主题协调层：读取设置/启动覆盖、应用全局主题，再把TUI颜色与深浅报告同步进去；上层负责持久化，底层TUI负责真实查询和绘制。
// 只导入颜色/终端界面类型，不在本模块new真实终端；具体查询/渲染由传入的TUI实现。
import type { RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";
// SettingsManager仅作类型，保存的是取得它的getter；本控制器读设置而不调用保存主题的方法。
import type { SettingsManager } from "../../../core/settings-manager.ts";
// 从主题模块导入实际状态操作和少量类型，下面每项职责不同。
import {
	// 读取当前全局终端深浅判定，不执行新的终端查询。
	getTerminalTheme,
	// 初始化全局主题，加载失败可退system；第二参数控制文件watcher。
	initTheme,
	// 标记颜色查询尚未完成，让system主题暂时使用灰阶生成策略。
	markTerminalColorsPending,
	// 解析light/dark双主题设置，非法形状返回undefined，不实际加载主题。
	parseAutoThemeSetting,
	// 按当前终端外观把设置解析成具体主题名，单个名字原样返回。
	resolveThemeSetting,
	// 统一system主题的保留名称，不能和用户自定义同名主题混为优先级相同。
	SYSTEM_THEME_NAME,
	// 记录终端报告的深浅方案，未报告实际背景色时参与回退判断。
	setTerminalColorScheme,
	// 更新主题模块保存的终端颜色并结束pending，本函数不主动向终端问颜色。
	setTerminalColors,
	// 按名字设置全局主题并返回success/error，失败通常已回退system。
	setTheme,
	// 直接安装一个Theme实例，内部会停止主题文件watcher，不落盘设置。
	setThemeInstance,
	// type只保留终端深浅字符串联合用于TS检查，运行时擦除。
	type TerminalTheme,
	// Theme在此仅作为实例类型，不新建它或导入另一份主题校验器。
	type Theme,
} from "./theme.ts";

// 本地结果为成功布尔加可选错误文字，不是判别联合；success为true的类型也没有强制禁止error。
type ThemeResult = { success: boolean; error?: string };

/**
 * How long the system theme stays grayscale before falling back to palette indices. Terminals answer
 * the trailing DA1 request right after the color replies, so this only matters for terminals that
 * answer neither. Replies arriving later still apply.
 */
// 查询等待100ms，超时可先用已有/兜底颜色；这个数不保证用户终端一定及时回复，迟到完整回复仍可应用。
const TERMINAL_QUERY_TIMEOUT_MS = 100;

/**
 * Query the terminal's colors and pass them to `apply` when the query completes or times out, and again
 * if the terminal answers after the timeout. A failed query applies no colors. Settles after the first apply.
 */
// 向TUI查询并在首结果及迟到结果应用颜色，返回首轮apply完成的Promise。例：超时先apply({})，后续完整回复再apply(colors)；查询失败也传空对象，不保证apply自身不抛。
export function requestTerminalColors(ui: TUI, apply: (colors: TerminalColors) => void): Promise<void> {
	// 先声明Promise变量，try成功/失败两条路径都会赋值；let允许重新赋值。
	let query: Promise<TerminalColors>;
	// try只包发起查询的同步阶段，不包未来Promise回调或迟到事件。
	try {
		// 100ms传给TUI，apply同一个函数也作为onLateReply；这会真正请求I/O，是否写终端由具体实现决定。
		query = ui.queryTerminalColors({ timeoutMs: TERMINAL_QUERY_TIMEOUT_MS, onLateReply: apply });
		// 只捕获queryTerminalColors调用当场抛错，不把apply的所有异常都兜住。
	} catch {
		// Treat a failed query like a terminal that does not report colors.
		// 同步失败转成兑现空对象的Promise，随后仍走apply，不代表真的得到了终端完整颜色。
		query = Promise.resolve({});
	}
	// then的成功支应用结果，拒绝支应用{}；任一apply同步抛错会使返回Promise拒绝，晚回调异常不由它接管。
	return query.then(apply, () => apply({}));
}

// 比较两个可缺省RGB，返回布尔；例两个独立{r:1,g:2,b:3}相等。只按引用或三个分量比较，不验证范围/做颜色空间转换。
function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	// 同引用（含两边undefined）直接true，否则双方存在且r/g/b逐个严格相等；NaN分量不按近似数相等。
	return a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}

// 按默认前景/背景和调色板判断颜色是否相同，供避免无变化重绘；不比较任意额外字段，也不复制/冻结输入。
function sameTerminalColors(a: TerminalColors, b: TerminalColors): boolean {
	// 前景或背景任一不同直接false，||短路避免后续无必要比较。
	if (!sameRgb(a.foreground, b.foreground) || !sameRgb(a.background, b.background)) return false;
	// palette同引用直接true，即使调用方原地改过它也无法从同引用看出历史变化。
	if (a.palette === b.palette) return true;
	// 只有一边有palette或长度不同就false；两边都缺省的情况已由上一行同undefined处理。
	if (!a.palette || !b.palette || a.palette.length !== b.palette.length) return false;
	// 逐项比RGB，?.取另一边同位置；every遇false即停且跳过稀疏孔，不是通用任意数组深相等。
	return a.palette.every((color, index) => sameRgb(color, b.palette?.[index]));
}

/**
 * Applies the theme setting and keeps it in sync with the terminal. The theme applies immediately, and the
 * terminal's colors update it when they arrive; the system theme renders in grayscale until then. Callers
 * that bake theme colors into content can wait for the colors with `waitForTerminalColors()`.
 */
// 管理交互主题设置与终端颜色联动，立即应用主题、异步补色；不保存设置、不实现终端输入解析，依赖宿主传入TUI和回调。
export class InteractiveThemeController {
	// 只读字段保留原TUI引用，不在rebindTui时替换成另一个对象。
	private readonly ui: TUI;
	// getter让每次读到宿主当前SettingsManager，能跟随会话切换，不缓存首次manager。
	private readonly getSettingsManager: () => SettingsManager;
	// 错误显示回调，由宿主决定如何展示；这里调用为同步，不await。
	private readonly showError: (message: string) => void;
	// 主题变化通知回调，和requestRender不是同一个动作。
	private readonly onChanged: () => void;
	// 当前显式设置/启动覆盖，缺省时才从manager读；可含light/dark主题对。
	private currentThemeSetting: string | undefined;
	// Last reported colors; a query that times out keeps them instead of erasing them.
	// 本控制器最近已采用颜色，查询部分缺字段时沿用；不是每轮原始回复完整副本。
	private terminalColors: TerminalColors | undefined;
	// 跟踪最近applyThemeName成功名或失败system回退名；preview不更新它，因此不总等于全局当前Theme。
	private activeThemeName: string | undefined;
	// 是否跟随终端外观通知，初始false；构造虽订监听，还未在此开启协议通知。
	private autoSyncEnabled = false;
	// 可选退订函数用整体函数类型与undefined联合；保存引用方便重绑/dispose。
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	// Settles when the latest color query completed or timed out, and its colors applied.
	// 初始已兑现Promise；每次查询替换为最新那份，不会自动等待此前所有查询或迟到回复。
	private terminalColorQuery: Promise<void> = Promise.resolve();

	// 构造时保存宿主入口→解析名字→标pending→初始化主题→绑定深浅监听。例初始light覆盖manager的dark但不落盘；可能读内置文件/启动自定义主题watcher，回调/文件错误按消费方传播或回退。
	constructor(
		// 传入已有TUI；类型接口不验证任意JS对象实现是否完整。
		ui: TUI,
		// options是必需对象，内联类型逐项规定回调，不是额外的位置参数。
		options: {
			// 必需函数，无参返回当前设置manager。
			getSettingsManager: () => SettingsManager;
			// 必需错误展示函数，接字符串、调用方不使用返回值。
			showError: (message: string) => void;
			// 必需变化回调，无参返回void；异步回调返回的Promise不会被这里等待。
			onChanged: () => void;
			// 启动主题设置可省；提供字符串后会成为内存覆盖，不自动保存设置文件。
			initialThemeSetting?: string;
		},
	) {
		// 保存TUI原引用，readonly字段在构造里赋值。
		this.ui = ui;
		// 保存取得manager的函数，不在此直接保存某个manager实例。
		this.getSettingsManager = options.getSettingsManager;
		// 保存错误回调，尚不调用。
		this.showError = options.showError;
		// 保存变化回调，尚不调用。
		this.onChanged = options.onChanged;
		// 保存可选初始设置，undefined时以后读取manager。
		this.currentThemeSetting = options.initialThemeSetting;
		// 结合设置与当前全局终端外观解析名字，未设置/解析失败才回system；尚未检查该主题存在。
		this.activeThemeName = this.resolveThemeName();
		// The system theme starts in grayscale; color follows once the terminal reports its colors.
		// 全局标颜色未就绪；pending并不是给每个查询独立编号，也没有发查询。
		markTerminalColorsPending();
		// 初始化该名字并启自定义主题watcher；initTheme内部失败退system，此字段并未读回其实际结果。
		initTheme(this.activeThemeName, true);
		// 订阅TUI深浅报告，不在构造里调用applyFromSettings或开始颜色查询。
		this.bindTerminalColorSchemeListener();
	}

	// 同一TUI内部重建后重绑监听/重设通知开关，无参数/返回；先退旧后订新，不取消已有颜色查询，也不更换this.ui。
	rebindTui(): void {
		// 若旧退订函数存在则执行，?.调用不会吞它的异常。
		this.terminalColorSchemeUnsubscribe?.();
		// 安装一个新监听并保存新退订函数。
		this.bindTerminalColorSchemeListener();
		// 把当前autoSync状态交回TUI，可能写终端协议开关；TUI自己的同值门禁仍会生效。
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	/**
	 * Apply the theme setting now and query the terminal's colors, which update the theme when they arrive.
	 * Theme pairs and the system theme follow terminal appearance changes.
	 */
	// 从内存覆盖或manager读取设置，立即加载主题，再异步查询颜色；无参数/返回。例light/dark开启联动，固定dark关闭联动；不持久化、不等待查询完成。
	applyFromSettings(): void {
		// 取设置文字，undefined和空字符串在后面不完全同义。
		const themeSetting = this.getThemeSetting();
		// 再次按当前设置/外观解析具体名；getter若有副作用，两次读取不保证是原子快照。
		const themeName = this.resolveThemeName();
		// 合法主题对或system才开启自动深浅联动，不因普通自定义主题自动开启。
		this.setAutoSync(parseAutoThemeSetting(themeSetting) !== undefined || themeName === SYSTEM_THEME_NAME);
		// 明确提供过设置才请求显示加载错误；applyThemeName的成功/失败结果在这里未返回给调用者。
		this.applyThemeName(themeName, themeSetting !== undefined);
		// 发起查询并保存Promise，无await；可用waitForTerminalColors另等当前查询。
		this.queryTerminalColors();
	}

	/**
	 * Wait until the latest color query completed or timed out. Content that bakes theme colors into
	 * strings, such as the startup header, should be built after this. Terminals answer the DA1 request
	 * right after the color replies, so this only takes the full timeout when a terminal answers nothing.
	 */
	// 返回当前保存的颜色查询Promise，供构造依赖颜色的内容前等待；不另发查询、不等待所有迟到回复，也不取消旧查询。
	waitForTerminalColors(): Promise<void> {
		// 返回同一Promise引用；调用后又发新查询时，先前拿到的Promise不会被自动改成新那份。
		return this.terminalColorQuery;
	}

	// 返回选项应展示的设置，优先内存覆盖再manager再已记录名字；可能返回主题对，不通过全局Theme反查当前实际名字。
	getThemeSelection(): string | undefined {
		// ??仅跳过null/undefined，空串仍保留；getter若抛错会传播，后续回退不再执行。
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting() ?? this.activeThemeName;
	}

	// 按单个名字切主题，成功才更新内存设置，返回success/error；例setThemeName("dark")不写文件。失败可已回system，autoSync的变动也不会自动回滚。
	setThemeName(themeName: string, showError = false): ThemeResult {
		// 只有名字严格system才启联动；传light/dark文字不是此方法的主题对设置入口。
		this.setAutoSync(themeName === SYSTEM_THEME_NAME);
		// 加载并通知，showError缺省false只控制错误展示，不影响实际回退/结果。
		const result = this.applyThemeName(themeName, showError);
		// 结果success为true才把新名字作为之后读取的内存覆盖。
		if (result.success) {
			// 写内存覆盖，不调用SettingsManager.setTheme或flush。
			this.currentThemeSetting = themeName;
		}
		// 原结果对象返回，失败不改之前的currentThemeSetting。
		return result;
	}

	// 直接写完整设置再走applyFromSettings，例light/dark；没有返回结果也没有失败回滚/持久化，加载失败按下层回退。
	setThemeSetting(themeSetting: string): void {
		// 先保存输入，后续即使加载失败也留着该设置。
		this.currentThemeSetting = themeSetting;
		// 复用立即应用/联动开关/查询的完整流程。
		this.applyFromSettings();
	}

	// 安装Theme实例并关闭深浅联动、记<in-memory>，通知后返回success；不改变currentThemeSetting，不保存文件，回调仍可能抛。
	setThemeInstance(themeInstance: Theme): ThemeResult {
		// 关闭联动通知，但不移除此时已注册的深浅监听。
		this.setAutoSync(false);
		// 调用模块同名函数（不是递归调用this方法），它设置全局主题并停止文件watcher。
		setThemeInstance(themeInstance);
		// 用内部标记使后续reapplyForTerminal保留该实例，而不是按设置替换。
		this.activeThemeName = "<in-memory>";
		// 令UI失效并调用onChanged，未在这里直接requestRender。
		this.notifyChanged();
		// 正常完成才返回成功，未统一catch前面设置/回调异常。
		return { success: true };
	}

	// 按名字/主题对临时预览，成功使UI失效并请求重绘；不保存currentThemeSetting/activeThemeName或关闭联动。例预览light后其他终端回调仍可能按原设置再应用主题，不保证预览永久保留。
	preview(themeSettingOrName: string): void {
		// 当前深浅决定主题对选哪边，解析失败回已记录名字；不读取JSON或先验证名字一定存在。
		const themeName = resolveThemeSetting(themeSettingOrName, getTerminalTheme()) ?? this.activeThemeName;
		// 最终无真值名字就返回，空串在这里也被忽略。
		if (!themeName) return;
		// 实际设置全局主题并启watcher，失败时setTheme已可能回system，但本分支不会触发下面两项重绘。
		if (setTheme(themeName, true).success) {
			// 预览成功才使组件缓存失效，不调用本控制器notifyChanged/onChanged。
			this.ui.invalidate();
			// 主动请求UI重绘，实际帧合并/输出由TUI负责。
			this.ui.requestRender();
		}
	}

	// 只关闭自动深浅联动，无返回值；不取消查询、解绑监听或改当前主题。
	disableAutoSync(): void {
		// 共用开关逻辑，状态本来false时直接无额外动作。
		this.setAutoSync(false);
	}

	// 关闭深浅通知并退订监听，无参数/返回；不取消在途/迟到颜色查询或全局文件watcher，不设disposed门禁，不能说所有后续回调都已停止。
	dispose(): void {
		// 先关通知，若具体TUI抛错，后续退订不会由finally保证执行。
		this.setAutoSync(false);
		// 有退订函数就调用，停止此监听接收后续正常报告。
		this.terminalColorSchemeUnsubscribe?.();
		// 清退订槽，重复dispose通常不再重复调用同一退订器。
		this.terminalColorSchemeUnsubscribe = undefined;
	}

	// 只读全局终端深浅判定，无参数/副作用；不查询真实终端，也不返回主题JSON的appearance字段。
	getTerminalTheme(): TerminalTheme {
		// 调用导入函数，不是递归this.getTerminalTheme。
		return getTerminalTheme();
	}

	// 读取当前设置：内存覆盖优先manager，返回可缺省字符串；例启动覆盖存在时换manager也仍使用覆盖，无写操作。
	private getThemeSetting(): string | undefined {
		// ??保留空串，与后续解析缺省回system是两步；manager的异常不被吞掉。
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting();
	}

	/** The theme for the current setting and terminal appearance. Without a setting, pi uses the system theme. */
	// 把设置解析成具体主题名，未设置/格式无法解析才回system；不验证主题是否存在，不加载文件或更新activeThemeName。
	private resolveThemeName(): string {
		// 把当前全局深浅交解析器，??让undefined回保留system名称，空字符串仍可能原样保留。
		return resolveThemeSetting(this.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME;
	}

	// 真正按名字设置主题，写active记录并通知，按选项展示失败；例坏名字返回失败且记录system。返回原ThemeResult，不回滚所有状态，外部回调可抛。
	private applyThemeName(themeName: string, showError = false): ThemeResult {
		// setTheme内部可读文件/建watcher/调用全局回调，并在加载失败时回system；true是watcher开关。
		const result = setTheme(themeName, true);
		// 跟踪成功名或system回退，与currentThemeSetting分开；这行不修改用户设置。
		this.activeThemeName = result.success ? themeName : SYSTEM_THEME_NAME;
		// 先通知变化，再显示错误；通知回调若抛，后续错误提示与return都不会执行。
		this.notifyChanged();
		// 只有失败且showError真值才调用宿主错误显示。
		if (!result.success && showError) {
			// 按原英文格式传入失败/回退说明，字符串插值不脱敏/转义error，也不自己画UI。
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to the system theme.`);
		}
		// 返回setTheme给的原结果对象。
		return result;
	}

	/** Query the terminal's colors without waiting for them; `waitForTerminalColors()` waits for this query. */
	// 发起新颜色查询并覆盖当前等待槽，无返回值；例先拿wait再重查，不会替换旧调用者手上的Promise；没有统一取消/序号隔离旧结果。
	private queryTerminalColors(): void {
		// 箭头捕获this，将首结果和迟到结果都交applyTerminalColors；Promise拒绝存槽里，不在本行自动catch。
		this.terminalColorQuery = requestTerminalColors(this.ui, (colors) => this.applyTerminalColors(colors));
	}

	/**
	 * Record reported colors: themes use the default colors for tokens set to "", the system theme is
	 * generated from all of them, and light/dark detection uses them. Re-renders only when they changed.
	 */
	// 将本轮部分颜色与旧颜色合并，变化时写全局/按终端重应用并重绘；例空回复保留旧背景。同步函数不复制RGB/调色板，也不检查disposed或旧查询身份。
	private applyTerminalColors(reported: TerminalColors): void {
		// 记住上一份本控制器颜色引用，首轮为undefined。
		const previous = this.terminalColors;
		// 新建顶层颜色对象，内部RGB/数组引用仍可共享。
		const next: TerminalColors = {
			// 本轮前景非null/undefined才替换，否则沿用旧值；不把缺色当清除。
			foreground: reported.foreground ?? previous?.foreground,
			// 背景同样逐字段回退，允许只更新其中一种默认色。
			background: reported.background ?? previous?.background,
			// 调色板整体替换或沿用，不对16个位置逐个补旧值。
			palette: reported.palette ?? previous?.palette,
		};
		// Re-rendering rebuilds every component, so skip it when nothing changed (including timeouts).
		// 有旧值且所比较内容相同就跳过全部后续动作；首次空回复仍会应用，以结束全局pending。
		if (previous && sameTerminalColors(previous, next)) return;
		// 先更新本地引用；后续通知/绘制抛错时不回滚它。
		this.terminalColors = next;
		// 主题模块浅复制并保存颜色、结束pending，不在这里请求新颜色。
		setTerminalColors(next);
		// 按当前设置/深浅重建system或切主题对；in-memory被该函数专门保留。
		this.reapplyForTerminal();
		// 无论上一步是否换了主题，都使UI缓存失效，以便终端默认色变化可反映到内容。
		this.ui.invalidate();
		// 请求一帧绘制，不等真正写出/显示完成。
		this.ui.requestRender();
	}

	/**
	 * Re-apply the setting after the terminal's colors or appearance changed: regenerate the system theme,
	 * or switch the theme of a pair. Themes set through extensions or previews are left alone.
	 */
	// 颜色/外观变化后按设置重应用，system每次重建，其他名变化才重载；不直接更改设置，某些预览仍可能被原设置覆盖。
	private reapplyForTerminal(): void {
		// 直接实例标记则保留，不据颜色变化替换这份扩展实例。
		if (this.activeThemeName === "<in-memory>") return;
		// 重新根据设置和全局深浅求名，不单纯采用刚报告的light/dark文字。
		const themeName = this.resolveThemeName();
		// system需要按新颜色重新生成，即使名字未变；其他主题只在名字与记录不同才重载。
		if (themeName === SYSTEM_THEME_NAME || themeName !== this.activeThemeName) {
			// 用默认showError=false应用并通知，回调异常仍会传播。
			this.applyThemeName(themeName);
		}
	}

	// 更新自动同步开关并交TUI，输入布尔、无返回；例false停2031主动通知，不停止颜色查询或移除监听。
	private setAutoSync(enabled: boolean): void {
		// 与本控制器状态相同直接返回，不强制重发实际终端控制码。
		if (this.autoSyncEnabled === enabled) return;
		// 先更新本地开关，TUI调用失败不会自动回滚。
		this.autoSyncEnabled = enabled;
		// TUI依据自身状态决定是否写启停序列；本方法不等远端确认。
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	// 绑定一次深浅报告回调并保存退订函数，无返回；调用方rebind先退旧，本函数自身不主动清旧订阅。
	private bindTerminalColorSchemeListener(): void {
		// 向TUI注册箭头函数，捕获this；只是注册，不在这里立刻执行颜色查询。
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			// 实际事件到来时交私有方法，返回void，未设置统一异常捕获。
			this.applyTerminalColorSchemeChange(terminalTheme),
		);
	}

	/**
	 * The terminal reported a light/dark switch. Its colors changed too, so query them again: they decide
	 * the appearance. The reported scheme only matters for terminals that do not report their background.
	 */
	// 处理终端深浅报告：联动开启时记录scheme，必要时切主题，再重新查询具体颜色；例报告light但实际背景dark时颜色结果可再次决定dark，不把报告文字当绝对真相。
	private applyTerminalColorSchemeChange(terminalTheme: TerminalTheme): void {
		// 联动关闭则忽略该报告，不记录scheme也不开始新查询。
		if (!this.autoSyncEnabled) return;
		// 先记原全局判定，用于判断scheme是否实际改变有效深浅。
		const previous = getTerminalTheme();
		// 写全局scheme，但已有真实背景色时它可能不影响判定。
		setTerminalColorScheme(terminalTheme);
		// 有效深浅确实变化才立即重应用；相同仍继续下面查询，寻找新的具体颜色。
		if (getTerminalTheme() !== previous) this.reapplyForTerminal();
		// 重新查询而不await；旧查询/迟到回调仍可能继续到来。
		this.queryTerminalColors();
	}

	// 使UI缓存失效并同步调用宿主变化回调，无参数/返回；不在此直接requestRender，回调自己决定后续工作，抛错可传播。
	private notifyChanged(): void {
		// 使内容需要重算，具体渲染调度由TUI与宿主决定。
		this.ui.invalidate();
		// 调用保存的onChanged，无await或try/catch，不保证async回调的拒绝被处理。
		this.onChanged();
	}
}
