// 启动阶段的小型终端对话框：装配主题/键位，显示首次设置、选择器或输入框，再释放界面；主聊天会话不在这里运行。
// 从终端 UI 库引入屏幕/终端对象及全局能力、按键配置；带 type 的 TUI 仅用于类型检查。
import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
// 同步判断设置文件是否存在；这里只用来决定首次设置入口，不读取文件内容。
import { existsSync } from "fs";
// 应用名、配置目录和路径都经 config.ts 帮助函数取得，适配源码运行、npm 与独立二进制。
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
// 首次设置当前仍受实验特性开关控制。
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
// 读取用户可配置按键，避免启动对话框另写一套硬编码快捷键。
import { KeybindingsManager } from "../core/keybindings.ts";
// 解析资源包及主题路径；ResolvedResource 描述路径是否启用，不是已经加载的主题对象。
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
// 访问全局/项目配置，也可建立只用于启动资源解析的内存配置视图。
import { SettingsManager } from "../core/settings-manager.ts";
// 启动时的单行输入组件，负责按键、提交、取消等交互。
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
// 启动选择列表组件，回调给的是选项显示文字，外层再映射为业务值。
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
// 首次设置组件负责展示主题和分析开关；FirstTimeSetupResult 仅描述提交结果的类型。
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
// 系统主题跟随终端颜色；颜色尚未返回时可以先用灰度显示。
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/system-theme.ts";
// 主题系统提供名称解析、主题加载/注册、终端颜色与全局主题切换；Theme 类型不产生运行时代码。
import {
	getTerminalTheme,
	initTheme,
	loadThemeFromPath,
	markTerminalColorsPending,
	resolveThemeSetting,
	setRegisteredThemes,
	setTerminalColors,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";
// 异步查询终端前景/背景/调色板，内部有超时与迟到回复处理。
import { requestTerminalColors } from "../modes/interactive/theme/theme-controller.ts";

// 官方发行包名，用来决定是否显示官方首次设置，不据此证明软件完整性或来源可信。
const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
// 官方应用名称，fork/rebrand 可以使用其他名称。
const OFFICIAL_APP_NAME = "pi";
// 官方配置目录名，与实际绝对路径 getAgentDir() 不同。
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

// 用作发行版身份比较的三个文字字段；这不是签名或密码学认证结构。
interface DistributionMetadata {
	// npm/发行配置中的包名。
	packageName: string;
	// 命令行应用名。
	appName: string;
	// 默认配置目录的名字。
	configDirName: string;
}

/**
 * 比较发行配置里的包名、应用名和配置目录名，三个都匹配才返回 true，无副作用。
 * 参数对象解构后逐项精确比较。例：fork 将应用名改为别的值时返回 false；这只是首次设置的显示条件，不是完整性验证。
 */
function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	// 括号把下面的多行条件当作一个布尔表达式返回。
	return (
		// 包名先精确匹配；&& 要求后面条件也成立。
		packageName === OFFICIAL_PACKAGE_NAME &&
		// 应用名称也必须一致，单改包名不会被当作官方首次设置目标。
		appName === OFFICIAL_APP_NAME &&
		// 配置目录名也一致，三个条件缺一不可。
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

/**
 * 从启用的已解析资源路径读取主题，按名字保留第一个成功项，返回 Theme 数组。
 * 文件读取/JSON 解析失败只跳过该主题，不让启动提示崩溃。例：两个同名 dark 主题按资源顺序优先第一个成功加载者。
 */
function loadThemes(resources: ResolvedResource[]): Theme[] {
	// 按资源顺序收集真正加载成功的主题对象。
	const themes: Theme[] = [];
	// 记录已经采用的主题名字，Set 用于去重而不保存重复项。
	const seen = new Set<string>();
	// 按解析器给的优先顺序逐个处理资源，不在这里重新排序。
	for (const resource of resources) {
		// 禁用资源跳过，不能因为文件存在就自动启用。
		if (!resource.enabled) continue;
		// 坏主题按单个资源隔离处理，启动提示仍可用其他主题继续显示。
		try {
			// 读取主题文件、解析/校验 JSON 并构造 Theme；这里会有文件读取副作用。
			const loadedTheme = loadThemeFromPath(resource.path);
			// 有主题名字才参与按名字去重。
			if (loadedTheme.name) {
				// 相同名字只保留先加载成功的那个，后面的同名主题不覆盖。
				if (seen.has(loadedTheme.name)) continue;
				// 先登记名称，供后续资源检查碰撞。
				seen.add(loadedTheme.name);
			}
			// 把可用主题加入结果；没有名字的对象也可先进入列表，注册函数会再按其规则处理。
			themes.push(loadedTheme);
			// 读取/解析某主题失败就忽略它；正常资源加载阶段会负责后续诊断显示。
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	// 返回加载成功的数组，不在这里修改全局主题注册表。
	return themes;
}

/**
 * 用全局设置的临时内存视图解析启动主题，缺失源选择 skip，然后加载成功的主题文件。
 * 返回异步 Theme 数组，涉及资源解析/文件读取；projectTrusted:false 交由既有解析规则处理，不保证任意资源的绝对安全。例：启动前先注册用户全局主题供选择。
 */
async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	// 从全局设置创建临时内存视图，不把当前完整 SettingsManager 直接交给包解析器。
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		// 明确给临时视图设置项目未信任标记；具体资源访问边界仍由包解析器实现，不能当作任意代码的沙箱保证。
		projectTrusted: false,
	});
	// 创建资源解析器，使用当前工作目录、标准 agent 目录和上面的临时设置。
	const packageManager = new DefaultPackageManager({
		// 启动时进程工作目录，用于解析器定位相对资源。
		cwd: process.cwd(),
		// 由 config.ts 获取适用于当前安装形态的配置目录。
		agentDir: getAgentDir(),
		// 使用临时全局设置视图，避免直接复用正在变更的启动对话框设置对象。
		settingsManager: globalSettingsManager,
	});
	// 等待资源解析；遇到缺失源时回调选择 skip，不弹额外安装询问。它不是对所有解析过程“不联网”的绝对保证。
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	// 只取主题资源进一步读文件；扩展等其他资源不在这个函数执行。
	return loadThemes(resolvedPaths.themes);
}

/**
 * 组装启动对话框使用的终端 UI：应用能力覆盖、注册主题、初始主题、键位与光标/缩屏设置，返回 TUI。
 * 会修改这些模块级配置并创建屏幕/终端对象，但不在本函数 start。例：调用方先 addChild(selector) 再启动接收按键。
 */
export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	// 将用户配置的终端能力覆盖项交给 TUI 全局能力解析。
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	// 等待启动主题加载，再替换当前主题注册表，为后面按名称查主题提供来源。
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	// The system theme starts in grayscale until the terminal reports its colors.
	// 标记终端颜色尚未到达，系统主题先以灰度占位，避免用错误颜色预设。
	markTerminalColorsPending();
	// 结合用户设置和当前终端明暗解析主题；没有明确结果时采用系统主题，加载失败时 initTheme 自己有兜底。
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	// 读取/设置可配置按键表，选择与输入组件之后使用同一组动作绑定。
	setKeybindings(KeybindingsManager.create());
	// 创建主屏和真实进程终端适配器，带硬件光标偏好/配置目录；这里只构造，下面 start 才启动界面。
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	// 应用内容高度缩小时是否清屏的渲染偏好。
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	// 返回已配置但尚未由本函数 start 的 TUI，调用方可先装入组件再启动。
	return ui;
}

/**
 * 启动已装配的界面，并异步查询终端颜色；颜色返回后按启动主题设置重新解析并应用。
 * 无返回结果，不等待查询结束。例：终端背景后来被识别成浅色，自动主题可随之切换。
 */
export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	// 启动 TUI 终端交互/绘制；创建对象与启动交互是两个时点。
	ui.start();
	// 保存这次启动时的主题选择，用于终端颜色到达后的重新解析。
	const themeSetting = settingsManager.getThemeSetting();
	// 发起异步颜色查询，不在这里等待；回调在颜色到达/超时回退时更新主题。
	queryStartupTerminalColors(ui, () => {
		// 重新结合终端明暗选择主题，让自动主题对迟到的终端信息作响应。
		setTheme(resolveThemeSetting(themeSetting, getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	});
}

/**
 * Query the terminal's colors without waiting for them. When they arrive, including after the timeout,
 * record them for the system theme and "" (terminal default) tokens, run `onColors`, and re-render.
 */
/**
 * 不阻塞启动地查询终端颜色，收到结果后保存颜色、执行主题回调、使绘制缓存失效并请求重绘。
 * 底层查询支持超时回退和迟到回复，因此回调可能不止一次。例：先按超时回退画面显示，终端颜色晚到仍更新系统主题。
 */
function queryStartupTerminalColors(ui: TUI, onColors: () => void): void {
	// 主动不等待查询 Promise，避免启动交互被终端响应阻塞；具体查询函数会处理超时及迟到回复。
	void requestTerminalColors(ui, (colors) => {
		// 把查询到的颜色保存到主题系统，系统主题及默认色令牌可据此生成。
		setTerminalColors(colors);
		// 执行调用方的主题重选/预览恢复回调，不擅自决定所有场景使用哪套主题。
		onColors();
		// 使已有绘制缓存失效，颜色变化后必须重新生成外观。
		ui.invalidate();
		// 请求一轮重绘；这是调度绘制，不等于同步把所有字节显示到屏幕。
		ui.requestRender();
	});
}

/**
 * 清掉启动对话框组件，排一次重绘并短暂等待，再让调用方停止界面；返回 Promise<void>。
 * 副作用是 UI 清理与约 25ms 的异步等待，不是模型上下文清理，也不是严格的终端输出完成证明。
 */
async function clearStartupTui(ui: TUI): Promise<void> {
	// 清掉本次启动对话框的组件内容，不是删除终端历史文件或会话日志。
	ui.clear();
	// 请求一轮重绘；这是调度绘制，不等于同步把所有字节显示到屏幕。
	ui.requestRender();
	// 等待约 25ms 给已排队重绘一次执行机会；不是对操作系统输出完成的严格 flush 保证。
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * First-time setup runs when all of these hold:
 * - this is the official Pi distribution (not a fork/rebrand)
 * - experimental features are enabled (PI_EXPERIMENTAL=1)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 */
/**
 * 只判断是否显示首次设置：官方发行配置、实验特性已开、没有自定义 agent 目录，且设置文件不存在。
 * 默认路径从 config.ts 获取，文件存在检查无内容验证。例：使用自定义目录或已有 settings.json 时返回 false。
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	// 下面对发行版三个字段一起检查，任一不匹配就跳过首次设置。
	if (
		// 取反：本地发行标识不完全符合官方定义时不进入官方首次设置。
		!isOfficialDistribution({
			// 提供当前发行配置里的真实包名。
			packageName: PACKAGE_NAME,
			// 提供当前应用名。
			appName: APP_NAME,
			// 提供当前配置目录名。
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		// 此条件不满足，当前启动不显示首次设置；后面的判断不再执行。
		return false;
	}
	// 没有开启实验特性就跳过；用户首次启动也不代表一定会显示此对话框。
	if (!areExperimentalFeaturesEnabled()) {
		// 此条件不满足，当前启动不显示首次设置；后面的判断不再执行。
		return false;
	}
	// 用户显式覆盖 agent 配置目录时跳过，避免在自定义配置场景触发默认目录的首次流程。
	if (process.env[ENV_AGENT_DIR]) {
		// 此条件不满足，当前启动不显示首次设置；后面的判断不再执行。
		return false;
	}
	// 最终仅当目标设置文件不存在才显示；文件存在并不代表本函数验证过其内容或完成所有配置。
	return !existsSync(settingsPath);
}

/**
 * 显示启动选择框并等待用户选择，输入标签/业务值数组，返回对应 T 或取消的 undefined。
 * 流程：建 TUI → 建结果 Promise → 装选择组件/焦点 → 启动 → 提交或取消 → 防重复清理 → resolve。
 * 按标签 find 首个匹配项，因此标签应能明确识别选项。例：label 是显示名，value 可为模型对象；选择后返回对象而不是标签文字。
 */
export async function showStartupSelector<T>(
	// 读取当前启动设置，并在首次设置确认时用同一管理器保存选择。
	settingsManager: SettingsManager,
	// 显示在选择/输入对话框顶部的标题文字。
	title: string,
	// 泛型选项数组：label 给人看，value 保留调用方自己的 T 类型；T 只在类型检查时存在。
	options: Array<{ label: string; value: T }>,
	// 选择成功返回对应 T，取消或没找到匹配标签时返回 undefined。
): Promise<T | undefined> {
	// 先把终端能力、主题、键位配置好，再创建具体对话框组件。
	const ui = await createStartupTui(settingsManager);
	// 把“以后用户提交/取消”的回调交互包装成可 await 的 Promise；不是同步等待用户输入。
	return new Promise((resolve) => {
		// 防重复完成标记；提交/取消可能相邻触发，但清理与 resolve 只做一次。
		let settled = false;
		// 选择对话框的统一收尾函数，输入业务值或取消的 undefined，先清屏再停 UI，最后完成 Promise。
		const finish = async (result: T | undefined) => {
			// 已经进入一次收尾就忽略后续回调，避免 await 期间重复清理。
			if (settled) {
				// 结束这次重复收尾，不影响已经在进行的第一次收尾 Promise。
				return;
			}
			// 在第一个 await 前占住完成状态，避免重入竞争。
			settled = true;
			// 清空组件并等待一小段重绘时间，让退出界面尽量不留下旧对话框。
			await clearStartupTui(ui);
			// 停止这次启动 TUI 的终端交互，之后上层可以继续正常启动产品界面。
			ui.stop();
			// 把结果交给等待 showStartupSelector/showStartupInput 的调用者；resolve 后 Promise 只会完成一次。
			resolve(result);
		};

		// 创建通用列表组件，组件只理解标签文字，上层负责从标签找回业务值。
		const selector = new ExtensionSelectorComponent(
			// 透传对话框标题。
			title,
			// map 生成标签数组，原 options 的 value 仍由这个外层函数保存。
			options.map((option) => option.label),
			// 选择回调按标签找第一个匹配项，再把 value 交给异步收尾；void 适配同步 UI 回调，不额外等待它。
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			// 取消也走同一收尾路径，用 undefined 表示没有选择/没有输入结果。
			() => void finish(undefined),
			// 把屏幕对象交给组件，使其可按正常 TUI 方式渲染和管理交互。
			{ tui: ui },
		);
		// 把选择器放入屏幕的组件树。
		ui.addChild(selector);
		// 键盘焦点交给列表组件，方向键/确认/取消由它处理。
		ui.setFocus(selector);
		// 组件就位后启动界面并异步查询终端颜色，调用者继续 await 外层 Promise。
		startStartupTui(ui, settingsManager);
	});
}

/** Show the first-time setup dialog and persist the result */
/**
 * 显示首次主题与分析开关设置，预览只改外观，确认才写 SettingsManager 并 flush，取消不保存本次选择。
 * 流程：建界面/完成 Promise → 装首次设置组件 → 查询颜色 → 用户结束时清理界面并完成 Promise。例：浏览主题后取消，不把预览当正式设置。
 */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	// 先把终端能力、主题、键位配置好，再创建具体对话框组件。
	const ui = await createStartupTui(settingsManager);
	// 把“以后用户提交/取消”的回调交互包装成可 await 的 Promise；不是同步等待用户输入。
	return new Promise((resolve) => {
		// 防重复完成标记；提交/取消可能相邻触发，但清理与 resolve 只做一次。
		let settled = false;
		// 首次设置的统一收尾；有结果才保存主题/分析开关，取消则只清理 UI。
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			// 已经进入一次收尾就忽略后续回调，避免 await 期间重复清理。
			if (settled) {
				// 结束这次重复收尾，不影响已经在进行的第一次收尾 Promise。
				return;
			}
			// 在第一个 await 前占住完成状态，避免重入竞争。
			settled = true;
			// 用户确认才修改设置；undefined 取消不会隐式保存当前预览。
			if (result) {
				// 将正式选定的主题写入设置管理器，区别于下方只改外观的预览。
				settingsManager.setTheme(result.theme);
				// 保存用户本次选择的分析数据开关；这里不描述也不额外发送分析事件。
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				// 等待设置管理器排队的写入处理，再关闭对话框；具体存储错误语义由管理器实现。
				await settingsManager.flush();
			}
			// 清空组件并等待一小段重绘时间，让退出界面尽量不留下旧对话框。
			await clearStartupTui(ui);
			// 停止这次启动 TUI 的终端交互，之后上层可以继续正常启动产品界面。
			ui.stop();
			// 首次设置函数返回 void，只通知流程完成，不另返回完整设置对象。
			resolve();
		};

		// 启动 TUI 终端交互/绘制；创建对象与启动交互是两个时点。
		ui.start();
		// 记录预览中的主题名，后面终端颜色迟到时能恢复用户正在看的选择。
		let previewTheme = SYSTEM_THEME_NAME;
		// 首次画面先用系统主题；这一步只改变当前主题外观，不等于保存设置。
		setTheme(previewTheme);
		// 创建首次设置组件，通过主题预览、确认和取消三个回调连接外层逻辑。
		const component = new FirstTimeSetupComponent({
			// 用户在列表中浏览主题时马上预览，但还没提交到 SettingsManager。
			onThemePreview: (themeName) => {
				// 保存最新预览名称，给后面的颜色查询回调用。
				previewTheme = themeName;
				// 将当前全局主题切到预览名称，失败时主题系统按自身规则回退。
				setTheme(themeName);
				// 请求一轮重绘；这是调度绘制，不等于同步把所有字节显示到屏幕。
				ui.requestRender();
			},
			// 确认携带主题/分析偏好，进入会保存设置的收尾路径。
			onSubmit: (result) => void finish(result),
			// 取消不保存本次选择，只让对话框结束。
			onCancel: () => void finish(undefined),
		});
		// 把首次设置组件装进屏幕。
		ui.addChild(component);
		// 让首次设置组件接收键盘输入。
		ui.setFocus(component);
		// 请求一轮重绘；这是调度绘制，不等于同步把所有字节显示到屏幕。
		ui.requestRender();
		// The terminal's colors regenerate the system theme; re-rendering rebuilds the dialog with it.
		// 终端颜色会重建系统主题，回调重新应用当前预览，避免迟到颜色把用户选择无声切走。
		queryStartupTerminalColors(ui, () => setTheme(previewTheme));
	});
}

/**
 * 显示启动单行输入框，传入标题和可选提示参数，返回提交文字或取消的 undefined，不发模型请求；当前输入组件保留但未使用提示参数。
 * 流程：建 TUI → 装输入/提交取消回调 → 启动 → dispose 输入、清屏、stop、resolve。例：询问一个配置名称，调用者 await 后决定怎样使用文字。
 */
export async function showStartupInput(
	// 读取当前启动设置，并在首次设置确认时用同一管理器保存选择。
	settingsManager: SettingsManager,
	// 显示在选择/输入对话框顶部的标题文字。
	title: string,
	// 接口保留的可选提示文字；当前 ExtensionInputComponent 将它命名为 _placeholder 且未使用，因此不会实际显示占位提示。
	placeholder?: string,
	// 用户确认时返回输入框当前字符串，允许空串；取消返回 undefined，二者可以区分。
): Promise<string | undefined> {
	// 先把终端能力、主题、键位配置好，再创建具体对话框组件。
	const ui = await createStartupTui(settingsManager);
	// 把“以后用户提交/取消”的回调交互包装成可 await 的 Promise；不是同步等待用户输入。
	return new Promise((resolve) => {
		// 防重复完成标记；提交/取消可能相邻触发，但清理与 resolve 只做一次。
		let settled = false;
		// 输入框统一收尾：防重入、释放输入资源、清屏、停 UI，最后交付文字或取消。
		const finish = async (result: string | undefined) => {
			// 已经进入一次收尾就忽略后续回调，避免 await 期间重复清理。
			if (settled) {
				// 结束这次重复收尾，不影响已经在进行的第一次收尾 Promise。
				return;
			}
			// 在第一个 await 前占住完成状态，避免重入竞争。
			settled = true;
			// 调用组件 dispose（当前主要停止可选倒计时）；闭包定义时未访问 input，交互回调执行时组件已构造完成。
			input.dispose();
			// 清空组件并等待一小段重绘时间，让退出界面尽量不留下旧对话框。
			await clearStartupTui(ui);
			// 停止这次启动 TUI 的终端交互，之后上层可以继续正常启动产品界面。
			ui.stop();
			// 把结果交给等待 showStartupSelector/showStartupInput 的调用者；resolve 后 Promise 只会完成一次。
			resolve(result);
		};

		// 创建实际输入组件，传提交/取消回调和屏幕引用。
		const input = new ExtensionInputComponent(
			// 透传对话框标题。
			title,
			// 原样传入接口保留的提示参数；当前组件构造器暂未使用它，它也不是输入框初始值。
			placeholder,
			// 用户提交文字时异步清理并完成结果；这里不调用聊天模型。
			(value) => void finish(value),
			// 取消也走同一收尾路径，用 undefined 表示没有选择/没有输入结果。
			() => void finish(undefined),
			{
				// 输入组件使用当前启动屏幕。
				tui: ui,
			},
		);
		// 把输入框加入屏幕组件树。
		ui.addChild(input);
		// 焦点交给输入框，随后启动 TUI 处理实际按键。
		ui.setFocus(input);
		// 组件就位后启动界面并异步查询终端颜色，调用者继续 await 外层 Promise。
		startStartupTui(ui, settingsManager);
	});
}
