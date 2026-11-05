/**
 * 首次设置的两步面板：先选主题并通知外部预览，再选是否分享使用分析数据，最终只把结果交给 startup-ui 宿主。
 * 组件不创建追踪标识、不保存设置或发送分析数据；宿主提交时调用设置 setter/flush，取消则不保存本次结果。
 * 例主题移到 Dark 会触发预览，确认仅进入分析选择，第二次确认才回传主题与 shareAnalytics；初始分析光标在 true，但未提交不等于已经同意或启用。
 */
// 布局/键位/空行/文字来自 TUI；Container 的渲染组合与本类键盘处理分别实现。
import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
// 欢迎文字使用应用配置名，不在此硬编码发行包名字。
import { APP_NAME } from "../../../config.ts";
// 系统主题的标识来自主题模块，和当前实际颜色值不是同一对象。
import { SYSTEM_THEME_NAME } from "../theme/system-theme.ts";
// 共享主题负责样式，切换预览时由宿主修改它。
import { theme } from "../theme/theme.ts";
// 动态边框读取当前主题。
import { DynamicBorder } from "./dynamic-border.ts";
// keyHint 查配置动作绑定，rawKeyHint 只显示给定键名，不注册按键。
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

// 提交数据接口；类型只约束形状，不在运行时写入设置。
export interface FirstTimeSetupResult {
	// 选中的主题标识，如 system/dark/light；string 本身不验证主题存在。
	theme: string;
	// 是否分享分析数据的选择结果，不是“网络已经发送”的状态。
	shareAnalytics: boolean;
}

// 三个外部回调把纯面板与设置/主题副作用连接起来，组件不持有 SettingsManager。
export interface FirstTimeSetupOptions {
	// 浏览到新主题时通知预览，void 不表示等待异步切换完成。
	onThemePreview: (themeName: string) => void;
	// 最终确认传结果给宿主；返回 void，组件不自动关闭或防重复提交。
	onSubmit: (result: FirstTimeSetupResult) => void;
	// 取消只发无参通知，不自动提交 false 或恢复预览。
	onCancel: () => void;
}

// Array<对象> 是数组泛型写法，每项 value 为业务标识、label 为英文显示文字。
const THEME_OPTIONS: Array<{ value: string; label: string }> = [
	// 初始第0项跟随终端系统色；标签本身不执行终端颜色查询。
	{ value: SYSTEM_THEME_NAME, label: "System (matches your terminal colors)" },
	// 深色主题项。
	{ value: "dark", label: "Dark" },
	// 浅色主题项，当前固定三项，不从全部已安装主题动态构建。
	{ value: "light", label: "Light" },
];

// 分析选项的 value 是 boolean，和用于显示的 label 分开。
const ANALYTICS_OPTIONS: Array<{ value: boolean; label: string }> = [
	// 第0项为愿意分享；它只是初始光标位置，真正保存需最终提交。
	{ value: true, label: "Share anonymous usage data" },
	// 第1项为不分享，取消面板则不提交这两项中的任何一项。
	{ value: false, label: "Don't share" },
];

// 静态 logo 的四行文字，update 用换行连接，不是图片文件或运行时绘图。
const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

/** First-time setup dialog: theme choice and analytics opt-in. */
// 继承 Container 的布局能力，自行维护步骤和光标；本类没有搜索/鼠标选项处理或 Focusable 字段。
export class FirstTimeSetupComponent extends Container {
	// 标签联合只允许两步，初始 theme；后面的 if 可按标签分派。
	private step: "theme" | "analytics" = "theme";
	// 主题0起始下标，在构造中赋初值。
	private themeIndex: number;
	// 分析选择初始下标0，对应 true，不读取已有分析设置。
	private analyticsIndex = 0;
	// readonly 禁止 TS 中重新绑定 options，但对象本身/回调并未冻结或克隆。
	private readonly options: FirstTimeSetupOptions;

	// 构造接预览/提交/取消回调，输出新面板；保存引用、选首主题并建组件树，无落盘/认证/分析发送。例如创建后显示主题步骤，但构造不主动调用预览。
	constructor(options: FirstTimeSetupOptions) {
		// 派生类先 super() 初始化 Container，之后才能访问 this。
		super();
		// 保留配置对象引用，不复制回调或验证其返回值。
		this.options = options;
		// 主题选中系统项，与字段初值 step=theme 配合。
		this.themeIndex = 0;
		// 生成初始画面，真正写终端由宿主安排。
		this.update();
	}

	/** Rebuild on theme changes, e.g. when the system theme receives the terminal's colors. */
	// invalidate 重建当前步骤文字再通知新子组件清缓存，返回 void；例如系统主题收到迟到终端颜色后，旧文字的 ANSI 样式需要重新生成，不改变用户光标/选择。
	// override 明确重写父类方法，让 TS 检查父类确有此方法及签名兼容；不是运行时自动注册主题监听。
	override invalidate(): void {
		// 先按当前共享 theme 重新构建整棵面板子树。
		this.update();
		// 调用父 Container 的 invalidate，逐个通知刚创建的子组件；不是终端清屏。
		super.invalidate();
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	// update 清掉旧子组件→重建 logo/标题→按步骤加候选→加操作提示/边框，返回 void；例如从主题进入分析后主题候选被替换。仅改组件树，不保存或调用预览。
	private update(): void {
		// clear 换掉 children 数组，不自动释放外部资源/更改步骤。
		this.clear();
		// 顶边框随当前主题渲染。
		this.addChild(new DynamicBorder());
		// 边框后留一行空白。
		this.addChild(new Spacer(1));
		// 四行 logo 用 LF 连接后着 accent 色，Text 左右留1列、上下0行。
		this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
		// logo 与欢迎文字之间留空行。
		this.addChild(new Spacer(1));
		// 把欢迎 Text 放进布局，表达式在下一行构造完成。
		this.addChild(
			// 应用名插值后先粗体再着色；这里仅显示欢迎语，不启动 Agent。
			new Text(theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}, the minimal coding agent.`)), 1, 0),
		);
		// 欢迎语后空一行。
		this.addChild(new Spacer(1));

		// 根据当前步骤选择唯一一组候选。
		if (this.step === "theme") {
			// 主题步骤显示原英文提示。
			this.addChild(new Text(theme.fg("text", "Pick a theme."), 1, 0));
			// 提示与候选之间留一行。
			this.addChild(new Spacer(1));
			// 复用候选绘制方法，不改变主题实际配置。
			this.addOptionList(
				// map 投影 label 形成新字符串数组，候选 value 留待预览/提交使用。
				THEME_OPTIONS.map((option) => option.label),
				// 传当前主题光标，绘制方法不自行更新下标。
				this.themeIndex,
			);
		} else {
			// 另一分支为 analytics，显示分享数据询问。
			this.addChild(new Text(theme.fg("text", "Opt-in to anonymous usage data sharing?"), 1, 0));
			// 加入分析说明文字组件，尚无设置 setter 调用。
			this.addChild(
				// Text 按终端宽度折行，原文中的换行也参与显示。
				new Text(
					// 为整段说明加 muted 样式。
					theme.fg(
						// muted 是主题样式键，不是分析开关。
						"muted",
						// 这段英文是界面说明，原文中的换行转义在运行时成为 LF；组件不会解析它来创建标识或执行 /privacy。
						"Opting in stores a tracking identifier in settings.json and enables anonymous\nusage analytics. This helps us to better debug, reproduce, and resolve issues\nand bugs within Pi. You can observe what is shared using /privacy and make\nchanges anytime in settings.json.",
					),
					// 说明文字左右内边距1列。
					1,
					// 说明文字上下内边距0行。
					0,
				),
			);
			// 说明与候选留空行。
			this.addChild(new Spacer(1));
			// 画分析选项，不在此发送任何数据。
			this.addOptionList(
				// 只投影英文显示名，不把布尔值当文字展示。
				ANALYTICS_OPTIONS.map((option) => option.label),
				// 传分析步骤独立的光标下标。
				this.analyticsIndex,
			);
		}

		// 候选与底部操作提示之间空一行。
		this.addChild(new Spacer(1));
		// 将完整帮助文字作为一个 Text 加入。
		this.addChild(
			// Text 只是展示提示，不注册快捷键。
			new Text(
				// 原始上下箭头是固定提示，实际还支持可配置动作和 j/k。
				rawKeyHint("↑↓", "navigate") +
					// 两个空格分隔操作提示。
					"  " +
					// 确认键提示跟随配置；主题步说 continue，分析步说 finish，具体流程在 handleInput。
					keyHint("tui.select.confirm", this.step === "theme" ? "continue" : "finish") +
					// 再用两个空格分隔取消提示。
					"  " +
					// 取消文案为 skip setup，不意味着自动选择不分享或恢复原主题。
					keyHint("tui.select.cancel", "skip setup"),
				// 帮助左右留1列。
				1,
				// 帮助上下不额外加空行。
				0,
			),
		);
		// 底边框前留空行。
		this.addChild(new Spacer(1));
		// 最后加边框，不主动 requestRender。
		this.addChild(new DynamicBorder());
	}

	// addOptionList 按输入 label 顺序加 Text，指定下标带箭头/accent，返回 void 并追加到本面板；例如下标1选 Dark，其余用 text 色，不保存业务 value。
	private addOptionList(labels: string[], selectedIndex: number): void {
		// for 按0起始下标遍历，不分页或循环导航。
		for (let i = 0; i < labels.length; i++) {
			// 当前行下标与选择严格相等才算选中。
			const isSelected = i === selectedIndex;
			// 选中显示箭头，未选中用两空格对齐。
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			// 选中标签着 accent，其他 text；长标签由 Text 折行，不保证每项一行。
			const label = isSelected ? theme.fg("accent", labels[i]) : theme.fg("text", labels[i]);
			// 拼前缀/标签并加子组件，左右留1列、上下0行。
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	// moveSelection 输入增减量，夹到当前步骤边界后重建画面，无返回；例如 +1 从 System 到 Dark 时先通知主题预览，分析步骤只移光标。回调异常会传播并中止后续 update。
	private moveSelection(delta: number): void {
		// 主题步改变 themeIndex，分析步用另一下标。
		if (this.step === "theme") {
			// 先加 delta，再夹到0..最后一项；本类调用方只传 ±1，不自动环绕。
			const next = Math.max(0, Math.min(THEME_OPTIONS.length - 1, this.themeIndex + delta));
			// 只有主题下标真的变化才调用预览，停在边界不重复通知。
			if (next !== this.themeIndex) {
				// 先更新光标，若外部预览抛错不会回滚这个值。
				this.themeIndex = next;
				// 把当前主题 value 传给宿主预览；不在此保存，也不 await 外部异步结果。
				this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
			}
		} else {
			// 分析下标也夹边界，但不调用预览或即时分析设置 setter。
			this.analyticsIndex = Math.max(0, Math.min(ANALYTICS_OPTIONS.length - 1, this.analyticsIndex + delta));
		}
		// 不论是否到边界都重建当前步骤组件树，不自动请求终端重绘。
		this.update();
	}

	// handleInput 按上下/确认/取消分派，返回 void；例如首次确认进入分析、第二次确认回传结果，其他键忽略。没有组件内完成锁/回退上一步，重复确认保护由宿主 finish 负责。
	handleInput(keyData: string): void {
		// 每次输入读取当前配置键位。
		const kb = getKeybindings();
		// 配置上移或固定 k 均向上，优先于后续动作。
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			// 传 -1 移动本步骤光标。
			this.moveSelection(-1);
			// 配置下移或固定 j 向下。
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			// 传 +1，边界由 moveSelection 夹紧。
			this.moveSelection(1);
			// 确认动作或原始 LF 都可提交当前步骤。
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// 主题步骤只切到下一步，不在此保存主题。
			if (this.step === "theme") {
				// 更新标签联合为 analytics。
				this.step = "analytics";
				// 立刻用同一组件实例重建分析步骤画面。
				this.update();
			} else {
				// 分析步调用外部 onSubmit，外层 startup-ui 再保存设置/等待 flush/关闭。
				this.options.onSubmit({
					// 提交当前主题标识，而非已经渲染出的颜色对象。
					theme: THEME_OPTIONS[this.themeIndex].value,
					// 从分析候选取布尔值，未浏览分析时为初始 true。
					shareAnalytics: ANALYTICS_OPTIONS[this.analyticsIndex].value,
				});
			}
			// 前面未匹配才看取消动作，无独立硬编码 Ctrl+C 分支。
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 通知宿主结束设置；本类不关闭组件或恢复已预览的全局主题。
			this.options.onCancel();
		}
	}
}
