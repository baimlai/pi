// /settings 面板把宿主配置快照转成可搜索设置项/主题和思考子菜单；修改即时通知宿主，实际应用及排队保存不在本组件执行。
// 统一思考档位的字符串联合类型；导入本身不会开启模型思考。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
// 运行函数按模型目录能力列支持档位；Model/Transport 仅作类型，实际网络传输由宿主设置后交请求层。
import { getSupportedThinkingLevels, type Model, type Transport } from "@earendil-works/pi-ai";
import {
	// 界面组件契约，用于主题子菜单的渲染/输入代理。
	type Component,
	// 容器纵向摆放边框和列表，不自动把按键交给某个孩子。
	Container,
	// 读共享终端能力缓存，首次可能探测环境/tmux；这里只据图片协议是否可用决定插入哪些 UI 项。
	getCapabilities,
	// 滚动条模式 hidden/auto/always 的编译期类型。
	type ScrollViewScrollbar,
	// 单步列表候选类型，value 和 label 可以不同。
	type SelectItem,
	// 设置项类型：显示值/循环值或子菜单工厂，不是已持久化设置对象。
	type SettingItem,
	// 管理设置搜索、值循环、子菜单及修改回调，回调前会更新当前显示值。
	SettingsList,
	// 显式空白行。
	Spacer,
	// 普通文本显示，非 Markdown。
	Text,
	// 滚轮行数 number 或 auto 的联合类型。
	type WheelScrollLines,
} from "@earendil-works/pi-tui";
// 只用时间档位与展示格式函数，导入不会调用 configureHttpDispatcher 安装调度器；真正应用由宿主回调。
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
// 共享默认表仅用于缺警告字段时补显示值，不是把所有 config 自动填默认。
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import {
	// 缓存预热的三个实际候选 off/streaming/idle，运行数组不是类型枚举。
	CACHE_WARMING_MODES,
	// 预热模式类型；主宿主通过 Session 设置并协调已有 warmer，组件不直接预热。
	type CacheWarmingMode,
	// 默认信任模式 ask/always/never，不是当前项目已信任的状态。
	type DefaultProjectTrust,
	// 全屏退出输出的两种模式类型。
	type FullscreenExitOutput,
	// Mermaid 展示 off/final/streaming，与原 Markdown 文本保存不同。
	type MermaidRenderingMode,
	// 启动输出 false/true/header 的联合类型。
	type QuietStartup,
	// 分享目的地 auto/gist/radius，组件改偏好不会立即上传会话。
	type SessionShareDestination,
	// 界面 regular/fullscreen 模式类型。
	type TuiMode,
	// 分类警告开关结构，缺单项时由具体显示/消费方取默认。
	type WarningSettings,
} from "../../../core/settings-manager.ts";
import {
	// 创建设置列表的当前主题着色函数。
	getSettingsListTheme,
	// 将恰一个斜杠、两侧非空的文字解析为 light/dark 名称，不检查主题文件是否存在。
	parseAutoThemeSetting,
	// 特殊 system 主题名，由主题层按终端颜色构造。
	SYSTEM_THEME_NAME,
	// 构造时终端 light/dark 分类，用于自动模式改为单主题时选哪一侧。
	type TerminalTheme,
	// 当前主题的文字加粗/着色等方法。
	theme,
} from "../theme/theme.ts";
// 上下边框随 render 宽度生成。
import { DynamicBorder } from "./dynamic-border.ts";
// 把配置动作转为帮助文字，不在这里注册动作。
import { keyDisplayText } from "./keybinding-hints.ts";
// 单步菜单负责选值，多步菜单用于先选模型再选思考档位；type 项运行时擦除。
import { SelectSubmenu, SteppedSubmenu, type SteppedSubmenuStep } from "./settings-submenu.ts";

// 模型选择列目标宽度 12..46，最终仍受窗口宽限制，不是整张面板固定宽。
const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

// Record 要求每个 ThinkingLevel 都有文案；这里约数只是说明，不是发给 provider 的 token 预算。
const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	// 关闭思考的文案。
	off: "No reasoning",
	// 极简思考近似文案。
	minimal: "Very brief reasoning (~1k tokens)",
	// 低档文案，不在此计 token。
	low: "Light reasoning (~2k tokens)",
	// 中档文案。
	medium: "Moderate reasoning (~8k tokens)",
	// 高档文案。
	high: "Deep reasoning (~16k tokens)",
	// 更高档只有模型能力允许时才列进候选，文案本身不赋予能力。
	xhigh: "Extra-high reasoning (~32k tokens)",
	// 最高档文案，不指定精确预算。
	max: "Maximum reasoning",
};

// 信任配置值→英文显示标签的全量映射，不执行授权。
const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	// 缺信任结论时询问的标签。
	ask: "Ask",
	// 用户选择默认信任的标签。
	always: "Always trust",
	// 用户选择默认不信任的标签。
	never: "Never trust",
};

// 反向 Map 用显示标签找配置值，避免把 Ask 等英文原样写配置。
const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	// entries 得键值对，map 解构再反转；as 表示来自这个闭合映射的 key 可视为 DefaultProjectTrust，不运行验证。
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

// 宿主提供的显示配置快照；类型接口不读文件、不补默认、不验证任意 JS 调用的字段。
export interface SettingsConfig {
	// 自动压缩偏好，主宿主取 Session 当前开关；切开关不当场调用模型压缩。
	autoCompact: boolean;
	// 默认 provider/modelId 组合或宿主的 not set 占位，仅用于思考模型菜单排序/预选，不在本组件直接选默认模型。
	defaultModel: string;
	// 可缺当前模型；已有 any 泛型放宽 API 关联，不表示模型字段已被本界面运行校验。
	currentModel?: Model<any>;
	// 可选默认模型的可用目录快照，只读数组约束不深冻结模型，本菜单不自行刷新它。
	availableDefaultModels: readonly Model<any>[];
	// 终端内联展示偏好，和 blockImages 控制发送给模型分开。
	showImages: boolean;
	// 终端图片首选字符格宽度，不是像素；菜单只给 60/80/120 档，不保留自定义宽作为循环候选。
	imageWidthCells: number;
	// 模型图片输入自动缩放偏好，关闭终端图片展示不自动改变它。
	autoResizeImages: boolean;
	// 阻止向模型发送图片，不是在本界面删文件/历史图片。
	blockImages: boolean;
	// 是否将技能注册为 /skill:name 命令；主宿主改后重建自动补全。
	enableSkillCommands: boolean;
	// 流式期间引导消息的队列投递策略，字面量联合不是在此取队列。
	steeringMode: "all" | "one-at-a-time";
	// Agent 停下后 follow-up 消息的投递策略，与 steering 是独立队列。
	followUpMode: "all" | "one-at-a-time";
	// 传输偏好 sse/websocket/websocket-cached/auto，不保证每个 provider 都支持全部选项。
	transport: Transport;
	// 会话分享默认目的地，仅偏好，无上传操作。
	sessionShareDestination: SessionShareDestination;
	// 等待 HTTP 头/正文片段的空闲超时毫秒，0 为禁用对应超时，不是整个任务总时长。
	httpIdleTimeoutMs: number;
	// 预热费用相关偏好；主 SettingsManager getter 只从用户层读取，不让项目自行开启。
	cacheWarmingMode: CacheWarmingMode;
	// 全局默认档位，仅用于清模型覆盖时的说明；不是当前会话一定正在用的档位。
	thinkingLevel: ThinkingLevel;
	// 保留的配置字段，本文件没有读取它；每模型可选级别由目录 model.reasoning/thinkingLevelMap 决定。
	availableThinkingLevels: ThinkingLevel[];
	// 完整 provider/modelId→思考档位字典，本组件会复制一份跟踪菜单修改。
	modelThinkingLevels: Record<string, ThinkingLevel>;
	// 原始主题设置文字，可以是单名或 light/dark 配对，和当前生效 theme.name 不总相同。
	currentTheme: string;
	// 打开面板时终端明暗快照，本组件不订阅后续变化。
	terminalTheme: TerminalTheme;
	// 打开面板时可用主题名数组，不在本界面重新扫描目录。
	availableThemes: string[];
	// 隐藏 UI 思考块，不是禁止模型思考或从磁盘删除内容。
	hideThinkingBlock: boolean;
	// Mermaid 显示时机偏好，不保证图语法有效/一定可绘。
	mermaidRenderingMode: MermaidRenderingMode;
	// 是否显示缓存成本/恢复诊断通知，不是是否启用缓存。
	showCacheMissNotices: boolean;
	// 启动更新日志是否精简展开，当前菜单不加载更新日志。
	collapseChangelog: boolean;
	// 匿名安装/更新版本通知开关，不是分析数据分享；改菜单值不在本组件发网络请求。
	enableInstallTelemetry: boolean;
	// 空编辑器双 Escape 动作，包含 none，不同于下面一处过窄 as 断言，运行时 none 仍保留。
	doubleEscapeAction: "fork" | "tree" | "none";
	// 会话树打开时的默认筛选模式，菜单本身不执行树过滤。
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	// 终端硬件光标显示偏好，不是 Input 焦点状态。
	showHardwareCursor: boolean;
	// 编辑器左右留白列数，菜单给 0..3，真正约束/应用由宿主及设置管理器。
	editorPaddingX: number;
	// 输出正文左右留白，仅允许 0 或 1 的 TS 数字字面量联合。
	outputPad: 0 | 1;
	// 补全菜单可见项数，菜单给几个固定档位，而非补全结果总数。
	autocompleteMaxVisible: number;
	// 启动输出简化 true/header/false；构造时 String 变成显示值。
	quietStartup: QuietStartup;
	// 新项目没有更高优先信任决定时的默认政策；主 getter 只读用户层，不立即变更当前项目授权。
	defaultProjectTrust: DefaultProjectTrust;
	// 内容收缩时是否清掉空行；主 getter 可受显式设置或 PI_CLEAR_ON_SHRINK 回退影响。
	clearOnShrink: boolean;
	// 是否显示终端 OSC 9;4 进度偏好，本界面不发对应控制码。
	showTerminalProgress: boolean;
	// 当前 UI 模式，主宿主取实际 ui.mode，切换可能因活动 overlay 被拒绝并回写显示值。
	tuiMode: TuiMode;
	// 全屏退出时打印 transcript 或 resume-hint 的偏好。
	fullscreenExitOutput: FullscreenExitOutput;
	// 全屏滚动条 auto/always/hidden，regular 下不应用该全屏效果。
	fullscreenScrollbar: ScrollViewScrollbar;
	// 全屏选中文本时自动复制偏好，本组件不读取/写入系统剪贴板。
	fullscreenCopyOnSelect: boolean;
	// 全屏每次滚轮行数或 auto；菜单会将自定义数值加入循环候选，保留如 7 这样的已有值。
	fullscreenWheelScrollLines: WheelScrollLines;
	// 警告字典原快照，单项缺省不等于 false，例如 Anthropic 额外用量警告默认 true。
	warnings: WarningSettings;
}

// 所有修改通过宿主回调：本类先拿字符串值解码，宿主再更新运行状态和/或排队保存；void 不保证回调无副作用/不会抛错。
export interface SettingsCallbacks {
	// 通知自动压缩开关；主宿主保存偏好并更新 footer，不立即总结。
	onAutoCompactChange: (enabled: boolean) => void;
	// 通知终端展示开关；主宿主保存并更新已渲染工具输出。
	onShowImagesChange: (enabled: boolean) => void;
	// 通知字符格图片宽；与模型输入像素缩放分开。
	onImageWidthCellsChange: (width: number) => void;
	// 通知输入图片缩放偏好。
	onAutoResizeImagesChange: (enabled: boolean) => void;
	// 通知模型图片发送阻止偏好。
	onBlockImagesChange: (blocked: boolean) => void;
	// 通知技能命令开关，宿主可能重建补全提供器。
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	// 通知 steering 队列策略，函数参数类型不自动校验输入字符串。
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	// 通知 follow-up 队列策略。
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	// 通知网络传输偏好，宿主可同时改 Agent 当前字段。
	onTransportChange: (transport: Transport) => void;
	// 通知未来分享目的地，不立即上传。
	onSessionShareDestinationChange: (destination: SessionShareDestination) => void;
	// 通知超时毫秒；主宿主保存并重配全局 HTTP dispatcher。
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	// 通知预热模式，宿主保存并协调已运行 warmer，本组件不直接请求预热。
	onCacheWarmingModeChange: (mode: CacheWarmingMode) => void;
	// 以供应商/id/档位通知设置模型覆盖，主宿主可能也更新当前模型的会话档位。
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	// 通知删除用户层模型覆盖，不保证可信项目层同键也被删除。
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	// 最终主题选择通知，主宿主才保存并更新 ThemeController。
	onThemeChange: (theme: string) => void;
	// 可选临时主题预览，不等于持久化；缺回调时菜单仍能浏览/确认。
	onThemePreview?: (theme: string) => void;
	// 通知思考块展示偏好。
	onHideThinkingBlockChange: (hidden: boolean) => void;
	// 通知 Mermaid 展示模式，宿主会使聊天渲染失效重画。
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	// 通知缓存诊断展示，主宿主可重建消息显示。
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	// 通知更新日志折叠偏好。
	onCollapseChangelogChange: (collapsed: boolean) => void;
	// 通知版本通知开关，不在函数类型声明中启动统计。
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	// 通知双 Escape 动作，包含 none。
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	// 通知会话树默认筛选模式。
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	// 通知硬件光标开关，宿主实际改 TUI。
	onShowHardwareCursorChange: (enabled: boolean) => void;
	// 通知编辑器水平留白。
	onEditorPaddingXChange: (padding: number) => void;
	// 通知输出水平留白，数字联合限制正常 TS 调用。
	onOutputPadChange: (padding: 0 | 1) => void;
	// 通知补全可见数，宿主应用到默认/可定制编辑器。
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	// 通知启动输出简化模式。
	onQuietStartupChange: (quiet: QuietStartup) => void;
	// 通知用户默认信任政策，不是本组件直接保存信任决定。
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	// 通知收缩清屏偏好，主宿主实际更新 TUI。
	onClearOnShrinkChange: (enabled: boolean) => void;
	// 通知终端进度开关。
	onShowTerminalProgressChange: (enabled: boolean) => void;
	// 通知切界面模式，宿主可拒绝并恢复列表显示，不保证通知就一定成功。
	onTuiModeChange: (mode: TuiMode) => void;
	// 通知全屏退出输出策略。
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	// 通知滚动条策略。
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	// 通知选中自动复制偏好，不由组件执行复制。
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	// 通知滚轮自动/数值策略。
	onFullscreenWheelScrollLinesChange: (lines: WheelScrollLines) => void;
	// 通知完整警告字典，宿主负责写回偏好。
	onWarningsChange: (warnings: WarningSettings) => void;
	// 主面板取消/退出通知；不回滚此前已经提交的各项修改。
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
// 警告设置子面板，改变每项立即回调，不等退出再统一保存。
class WarningSettingsSubmenu extends Container {
	// 内部真实输入/显示列表。
	private settingsList: SettingsList;
	// 复制后的本地警告字典，不直接改构造传入对象。
	private state: WarningSettings;

	// 复制警告状态→建立单项列表→绑定修改及取消，返回子面板。例缺 anthropicExtraUsage 用默认 true 显示。
	// 修改先更新本地副本再回调，宿主保存；无直接 IO，回调/主题错误传播，取消不撤销已通知的开关。
	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		// 先初始化容器。
		super();

		// 浅复制字典，保留其他已有警告字段。
		this.state = { ...warnings };

		// 建立符合 SettingItem[] 的显示项，不在此执行警告检测。
		const items: SettingItem[] = [
			{
				// 内部 id 供修改 switch 分派。
				id: "anthropic-extra-usage",
				// 显示警告分类名称。
				label: "Anthropic extra usage",
				// 说明该开关控制额外用量提示，不保证 provider 永不产生额外费用。
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				// 布尔偏好在下一行转成列表显示字符串。
				currentValue:
					// ?? 保留显式 false；缺值采用共享默认，再用三元变 true/false 文案。
					(this.state.anthropicExtraUsage ?? SETTINGS_DEFAULTS.warnings.anthropicExtraUsage) ? "true" : "false",
				// 确认动作在两个字符串之间循环。
				values: ["true", "false"],
			},
		];

		// 创建实际设置列表，修改由下面回调处理。
		this.settingsList = new SettingsList(
			// 传刚建立的设置项数组原引用。
			items,
			// 最多 10 项，这里实际只有 1 项。
			Math.min(items.length, 10),
			// 用当前主题的设置列表样式。
			getSettingsListTheme(),
			// 修改回调收到 id 与新显示字符串，不是自动校验过的业务对象。
			(id, newValue) => {
				// 按已知警告 id 分派，其他 id 不作修改。
				switch (id) {
					// 当前只处理 Anthropic 额外用量警告。
					case "anthropic-extra-usage":
						// 浅展开原本地状态，仅严格 "true" 写 true，其他字符串写 false。
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						// 再传状态副本给宿主；同步异常不会回滚本地 state。
						onChange({ ...this.state });
						// 结束此 case，不落入后续分支。
						break;
				}
			},
			// 主列表取消原样交外部，是否调用上层 done 由宿主包装。
			onCancel,
		);

		// 将内部列表加入容器供继承 render 使用。
		this.addChild(this.settingsList);
	}

	// 把输入交内部 SettingsList，无返回值；例确认循环警告值，实际保存交上面回调，异常传播。
	handleInput(data: string): void {
		// 转发原始按键，规则由 SettingsList 当前配置决定。
		this.settingsList.handleInput(data);
	}
}

// 删除模型覆盖候选的内部哨兵值，不会作为 ThinkingLevel 持久化。
const CLEAR_OVERRIDE_VALUE = "__clear__";

// 生成精确模型配置键，返回字符串；例 provider=a,id=b/c 得 a/b/c，不解析其内部斜杠、不发请求。
function modelSettingKey(model: Model<any>): string {
	// 直接拼 provider/id；本函数不校验或转义字段，不用于通用无歧义任意字符串编码。
	return `${model.provider}/${model.id}`;
}

// 生成无颜色的模型显示标签，无状态修改；例 id=x、provider=p 得 x [p]。
function modelDisplayLabel(model: Model<any>): string {
	// 只连接元数据，不把显示文本当配置键。
	return `${model.id} [${model.provider}]`;
}

// 统计模型思考覆盖的自有可枚举字符串键数，返回 none 或 N configured；例两项显示 2 configured。
// 不检查模型是否可用或覆盖值是否合法，无存储副作用。
function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>): string {
	// Object.keys 不枚举继承/symbol 键。
	const count = Object.keys(overrides).length;
	// 零项用 none。
	if (count === 0) return "none";
	// 其他情况用实际键数，不遍历目录核对。
	return `${count} configured`;
}

// 生成带弱色 provider 的模型候选标签，返回字符串；例模型 id 保持普通文字，供应商用括号弱色，无状态修改，主题异常传播。
function modelItemLabel(model: Model<any>): string {
	// 模板内仅 provider 部分着色，模型 id 原样。
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

// 把主题名映成候选新数组，勾固定表示传入当前主题；例 current=dark，浏览 light 时勾仍在 dark。
// 只生成显示数据，不加载/应用主题或发预览，主题名不在这里去重/验证。
function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	// 按可用数组原序生成新条目。
	return availableThemes.map((name) => ({
		// 真正回传/保存的值是原主题名。
		value: name,
		// 精确同名才加勾，列表光标箭头独立处理。
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
		// 条件对象展开只给 system 加来源说明，其余不提供 description。
		...(name === SYSTEM_THEME_NAME ? { description: "Theme created from your terminal's colors" } : {}),
	}));
}

// 单主题列表的 automatic 操作哨兵；单独 / 不是有效 light/dark 配对，不直接持久化它。
const AUTOMATIC_THEME_VALUE = "/";

/** The system theme comes first, then automatic mode, then the remaining themes. */
// 把 system 第一项提到前面，再放 automatic，再放剩余主题，返回新候选数组。
// 例 [dark,system,light]→[system,automatic,dark,light]；只改本地新数组，不改 availableThemes，不去重重复 system 名。
function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	// 先生成新的普通主题条目。
	const items = themeItems(availableThemes, currentTheme);
	// 找首个 system 候选，未找到 -1。
	const systemIndex = items.findIndex((item) => item.value === SYSTEM_THEME_NAME);
	// 找到时 splice 从本地数组拿出 1 项，返回一项数组；未找到用空数组。
	const system = systemIndex === -1 ? [] : items.splice(systemIndex, 1);
	// 按下列顺序拼接返回数组。
	return [
		// 先展开已取出的 system。
		...system,
		{
			// 插入“进入自动模式”的特殊 value。
			value: AUTOMATIC_THEME_VALUE,
			// 该操作行无当前主题勾。
			label: "  automatic",
			// 说明自动模式按终端明暗选主题，实际检测由宿主/主题控制器。
			description: "Use separate themes for light and dark terminal appearance",
		},
		// 最后展开其他原序主题候选。
		...items,
	];
}

// 按可用性选 preferred→fallback→首项→原 fallback，返回名称；例 preferred 不在目录而 system 在则用 system。
// 只查数组，不加载主题；目录为空仍可返回不存在的 fallback，不保证所返名字可实际加载。
function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	// preferred 必须真值且精确存在才优先。
	if (preferred && availableThemes.includes(preferred)) return preferred;
	// 其次采用目录中存在的 fallback。
	if (availableThemes.includes(fallback)) return fallback;
	// 目录非空可用首项，首项 undefined 时回 fallback；?? 不把明确空串当缺值。
	return availableThemes[0] ?? fallback;
}

// 为自动模式准备 light/dark 名称对，返回对象。例原值 light/dark 解析成功则原样采用，即使目录里已没有该主题。
// 否则从单主题/系统/首项选择一个名称同时填两侧；不加载文件、不保存设置，类型外错误传播。
function defaultAutomaticThemes(
	// 原始当前主题设置，可为固定名、配对或不完整的含斜杠文字。
	currentThemeSetting: string,
	// 用于固定名回退的目录快照。
	availableThemes: string[],
	// 返回结构有两个必需字符串字段，不是 Theme 实例。
): { lightTheme: string; darkTheme: string } {
	// 只解析一个斜杠两侧非空的格式并 trim，不检查可用主题集合。
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	// 已有有效配对直接用，不重新做 preferredTheme 过滤。
	if (autoTheme) return autoTheme;

	// 含任意斜杠的文字不当固定名，避免把坏配对当单个主题文件名。
	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	// 选现有固定名，失败按 system/首项回退。
	const themeName = preferredTheme(availableThemes, currentFixedTheme, SYSTEM_THEME_NAME);
	// 两侧起始都用这个名字，返回新对象。
	return { lightTheme: themeName, darkTheme: themeName };
}

// 主题子菜单可在单主题/自动配对之间切换，先本地保存待选值并预览，确认后才通过 onDone 提交主设置列表。
class ThemeSubmenu extends Container {
	// 可选输入代理；自动模式渲染的是标题容器，输入需交其内部 SettingsList。
	private inputComponent: Component | undefined;
	// 保存宿主回调对象原引用。
	private readonly callbacks: SettingsCallbacks;
	// 主题目录快照原数组，不在本组件刷新。
	private readonly availableThemes: string[];
	// 构造时终端明暗快照；本类不会随终端通知自动更新此字段。
	private readonly terminalTheme: TerminalTheme;
	// 上层 SettingsList 传入 done：有字符串即提交并关闭，无参数仅返回主列表。
	private readonly onDone: (selectedValue?: string) => void;
	// 打开主题面板时的原始设置，用于取消时预览恢复。
	private readonly originalThemeSetting: string;
	// 本地两种模式的字面量联合。
	private mode: "single" | "automatic";
	// 单主题候选名，本地变化不等于落盘。
	private singleTheme: string;
	// 自动模式的亮色名称。
	private lightTheme: string;
	// 自动模式的暗色名称。
	private darkTheme: string;

	// 解析当前设置→初始化配对/固定候选→显示相应菜单，返回实例。例 light/dark 直接进入自动面板。
	// 目录只作部分回退选择，不全面验证已有配对可用；预览依赖可选回调，构造/主题错误传播，不自行写配置。
	constructor(
		// 原始主题设置名或配对文字。
		currentThemeSetting: string,
		// 当前终端明暗快照。
		terminalTheme: TerminalTheme,
		// 当前可用名称数组。
		availableThemes: string[],
		// 预览及其他宿主能力引用。
		callbacks: SettingsCallbacks,
		// 最终有值提交，无值取消的结束回调。
		onDone: (selectedValue?: string) => void,
	) {
		// 先初始化父容器。
		super();
		// 保存回调引用。
		this.callbacks = callbacks;
		// 保存可用名称原引用。
		this.availableThemes = availableThemes;
		// 保存构造时明暗。
		this.terminalTheme = terminalTheme;
		// 保存上层完成函数。
		this.onDone = onDone;
		// 记原设置，取消可请求预览回去；不是复制整个主题实例。
		this.originalThemeSetting = currentThemeSetting;
		// 解析 light/dark 格式，仅检查文字结构。
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		// 已有配对保留；没有则按可用固定主题填双侧。
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		// 已是配对或含斜杠坏格式就不当固定名，?: 左侧 || 是运行时逻辑。
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		// 有效配对选 automatic，其他先 single。
		this.mode = autoTheme ? "automatic" : "single";
		// 采用准备好的亮色名称。
		this.lightTheme = automaticThemes.lightTheme;
		// 采用暗色名称。
		this.darkTheme = automaticThemes.darkTheme;
		// 计算单主题模式的初始候选，用下面三个参数。
		this.singleTheme = preferredTheme(
			// 传可用名称列表。
			availableThemes,
			// 固定名优先；否则已有自动配对时按构造明暗选一侧，再按可用性回退。
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			// 最终默认希望 system，目录空时仍可得到此名。
			SYSTEM_THEME_NAME,
		);

		// 按初始模式选择界面，不立即触发 onThemeChange。
		if (this.mode === "automatic") {
			// 自动模式建立两侧设置。
			this.showAutomaticMenu();
		} else {
			// 单主题模式建立普通候选列表。
			this.showSingleMenu();
		}
	}

	// 转发输入到当前内容的输入代理，无返回值；例自动面板转其 SettingsList，缺组件/方法则忽略，不直接保存，回调异常传播。
	handleInput(data: string): void {
		// 两个可选链分别处理无代理和无 handleInput。
		this.inputComponent?.handleInput?.(data);
	}

	// 替换当前显示孩子并设置输入代理，无返回值；例 content 是完整标题布局、input 是内部 SettingsList。
	// 输入代理缺省就是 renderComponent；不清理旧组件资源或请求宿主重画，方法异常传播。
	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		// 清旧孩子，避免切模式时重复叠加布局。
		this.clear();
		// 加入新显示组件。
		this.addChild(renderComponent);
		// 保存输入代理，它可与显示根是不同对象。
		this.inputComponent = inputComponent;
	}

	// 显示单主题选择界面，绑定浏览预览/最终提交/取消恢复，无返回值。
	// 例浏览 light 只预览，确认 light 才 onDone；选择 automatic 只切模式并预览待选配对，没有立即保存。同步回调/主题错误传播。
	private showSingleMenu(): void {
		// 先标 single，让后续 getThemeSetting 返回固定名。
		this.mode = "single";
		// 创建单步菜单，不开启搜索。
		const menu = new SelectSubmenu(
			// 标题文字。
			"Theme",
			// 单主题/自动操作的说明。
			"Select a theme, or choose automatic to follow terminal appearance.",
			// 候选排列 system→automatic→其他主题，勾仍是 singleTheme。
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			// 按本地单主题名称预选。
			this.singleTheme,
			// 真正确认某项后执行，不是普通浏览回调。
			(value) => {
				// 遇 / 哨兵表示进入自动设置，而非保存 /。
				if (value === AUTOMATIC_THEME_VALUE) {
					// 先改模式，getThemeSetting 才返回配对。
					this.mode = "automatic";
					// 若有预览回调，预览当前待选 light/dark 组合。
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					// 构建自动主题界面。
					this.showAutomaticMenu();
					// 已切模式，不继续普通固定名提交。
					return;
				}

				// 普通候选先记本地单主题名。
				this.singleTheme = value;
				// 通过 onDone(value) 向主列表提交并关闭本主题面板。
				this.apply(value);
			},
			// 取消恢复原设置的预览并无值 done。
			() => this.cancel(),
			// 浏览变化只做预览，不改 singleTheme/currentValue。
			(value) => {
				// automatic 行预览当前两侧组合，其他行预览名称；是否真的成功由宿主控制器决定。
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		// 让整个菜单同时承担显示/输入。
		this.setContent(menu);
	}

	// 建立自动主题面板：亮/暗二级选择、Apply 和改单主题动作，无返回值。
	// 例改亮色仅更新本地 lightTheme 并预览，最终 Apply 才提交配对；取消仍回原设置预览，不做文件保存，回调/布局异常传播。
	private showAutomaticMenu(): void {
		// 标 automatic，使后续预览/Apply 读配对。
		this.mode = "automatic";
		// 显示根容器，输入稍后另交内部 SettingsList。
		const content = new Container();
		// 自动模式标题强调并加粗。
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		// 标题后留一行。
		content.addChild(new Spacer(1));
		// 展示两侧主题的用途说明。
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		// 只显示检测依赖终端支持，不在这行探测终端。
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		// 设置列表前留一行。
		content.addChild(new Spacer(1));

		// 四项 SettingItem 列表，两个 submenu 与两个单值动作行。
		const items: SettingItem[] = [
			{
				// 亮色设置内部 id。
				id: "light-theme",
				// 显示亮色主题项名称。
				label: "Light theme",
				// 亮色终端时使用的主题说明。
				description: "Theme to use in automatic mode when the terminal is light",
				// 当前待选亮色名称，仅本地状态。
				currentValue: this.lightTheme,
				// 打开亮色二级菜单时收到当前值和内部 done。
				submenu: (currentValue, done) =>
					// 创建具有预览/取消恢复的主题选择器。
					this.createThemeSelect(
						// 二级标题。
						"Light Theme",
						// 二级说明。
						"Select the theme to use for light terminal appearance",
						// 用于勾/预选的亮色名称。
						currentValue,
						// 内部 SettingsList 关闭二级菜单用的函数。
						done,
						// 确认亮色主题的回调。
						(value) => {
							// 先改本地亮色状态。
							this.lightTheme = value;
							// 预览新的待选配对，不通知最终保存。
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							// 更新内部亮色行的显示值并关闭二级菜单；外层最终 Apply 还没发生。
							done(value);
						},
					),
			},
			{
				// 暗色设置内部 id。
				id: "dark-theme",
				// 显示暗色主题项名称。
				label: "Dark theme",
				// 暗色终端时使用的主题说明。
				description: "Theme to use in automatic mode when the terminal is dark",
				// 当前待选暗色名称。
				currentValue: this.darkTheme,
				// 暗色二级菜单工厂。
				submenu: (currentValue, done) =>
					// 复用创建主题选择器流程。
					this.createThemeSelect(
						// 暗色二级标题。
						"Dark Theme",
						// 暗色二级说明。
						"Select the theme to use for dark terminal appearance",
						// 用于勾/预选的暗色名称。
						currentValue,
						// 内部 SettingsList 的关闭回调。
						done,
						// 确认暗色主题的回调。
						(value) => {
							// 先改本地暗色状态。
							this.darkTheme = value;
							// 预览新配对，不立即写 settings。
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							// 更新内部暗色行并关二级菜单。
							done(value);
						},
					),
			},
			{
				// 提交配对动作的 id。
				id: "apply",
				// 显示 Apply 操作名。
				label: "Apply",
				// 说明提交后返回；实际由下面 apply→onDone→宿主回调保存。
				description: "Save and go back",
				// 单值动作行右侧显示的固定文字。
				currentValue: "save and go back",
				// 只有一个值，SettingsList 确认仍会回调，即使循环后字符串没变，借此充当按钮。
				values: ["save and go back"],
			},
			{
				// 改回单主题动作 id。
				id: "single-mode",
				// 显示模式切换操作名。
				label: "Change mode",
				// 说明改为明暗共用一个主题。
				description: "Switch to one theme for light and dark",
				// 动作行右侧固定文字。
				currentValue: "switch to single theme",
				// 同样单值循环借确认回调执行按钮行为。
				values: ["switch to single theme"],
			},
		];

		// 内部设置列表的回调主要处理 Apply/切模式，亮暗子菜单已有自己的本地更新。
		const settingsList = new SettingsList(
			// 传四项菜单。
			items,
			// 可见项数最多 10，这里为 4。
			Math.min(items.length, 10),
			// 用设置列表主题。
			getSettingsListTheme(),
			// 只需要 id，未声明 newValue 形参不妨碍调用方传第二参数。
			(id) => {
				// 按动作 id 分派；light-theme/dark-theme 的 done 也会回调，但本 switch 没有额外处理它们。
				switch (id) {
					// 改回单主题动作。
					case "single-mode":
						// 先改模式。
						this.mode = "single";
						// 按构造时 terminalTheme 选当前自动配对的一侧，不重新探测终端。
						this.singleTheme = this.getActiveAutomaticTheme();
						// 临时预览该固定名。
						this.callbacks.onThemePreview?.(this.singleTheme);
						// 显示单主题列表，未自动提交这个模式切换。
						this.showSingleMenu();
						// 结束此动作分支。
						break;
					// Apply 才最终提交配对。
					case "apply":
						// 拼 light/dark 传 onDone，主列表据此通知宿主保存。
						this.apply(this.getAutomaticThemeSetting());
						// 结束 Apply 分支。
						break;
				}
			},
			// 自动主面板取消恢复原设置预览并无值关闭。
			() => this.cancel(),
		);
		// 将真正列表加入完整显示容器。
		content.addChild(settingsList);
		// 显示用 content，输入只给内部 settingsList，防止普通 Container 吞掉按键。
		this.setContent(content, settingsList);
	}

	// 创建亮/暗二级选择器，返回 SelectSubmenu；例在亮色中浏览其他名可临时预览，取消回当前待选组合。
	// 不提交最终配对或写配置；预览/取消/选择回调异常传播，是否加载成功由宿主控制器决定。
	private createThemeSelect(
		// 标题。
		title: string,
		// 说明文字。
		description: string,
		// 当前这一侧主题名，勾固定表示它。
		currentValue: string,
		// 内部列表 done，有值改右侧显示，无值仅关二级菜单。
		done: (selectedValue?: string) => void,
		// 确认回调由亮/暗调用方提供，负责本地字段更新及 done(value)。
		onSelect: (value: string) => void,
	): SelectSubmenu {
		// 构造普通单步菜单，不开启搜索。
		return new SelectSubmenu(
			// 传标题。
			title,
			// 传说明。
			description,
			// 按当前可用名称做候选，不在这里加 automatic 哨兵。
			themeItems(this.availableThemes, currentValue),
			// 当前名预选。
			currentValue,
			// 直接保存调用方的确认处理器。
			onSelect,
			// 二级取消只退出当前一级，不关闭整个 ThemeSubmenu。
			() => {
				// 预览恢复到本面板目前待选配对/单名，而非一定恢复最初原设置。
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				// 无值 done 关二级菜单，不把浏览过的名字提交。
				done();
			},
			// 浏览时直接预览此单名，不更新 lightTheme/darkTheme，最后确认才写本地字段。
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	// 返回本地待选设置字符串，无副作用；例 automatic 返回 light/dark，single 返回 singleTheme，不校验可加载性。
	private getThemeSetting(): string {
		// 按模式在配对与固定名之间选值。
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	// 按构造时终端明暗选择自动配对一侧，返回名称，无新探测；例 light 取 lightTheme，其他合法 dark 取 darkTheme。
	private getActiveAutomaticTheme(): string {
		// 只用保存的 terminalTheme，不读取当前全局主题颜色。
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	// 拼自动配对文字，返回字符串，无副作用；例 light=a,dark=b 得 a/b，不转义名字内的斜杠或检查格式。
	private getAutomaticThemeSetting(): string {
		// 用一个 / 连两侧名称，主题名由前面列表选择。
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	// 最终主题提交只调用上层 onDone(value)，无返回值；例配对 a/b 交 SettingsList 更新主题行并通知宿主。
	// 此方法不直接用 callbacks.onThemeChange，持久化/主题应用在主层；回调异常传播，不保证界面已关闭。
	private apply(themeSetting: string): void {
		// 有值 done 才触发主 SettingsList 的 onChange("theme",value)。
		this.onDone(themeSetting);
	}

	// 取消整个主题面板：先请求恢复原设置预览，再无值 done 返回主列表，无返回值。
	// 例已试亮色 a 但未 Apply，则预览回 originalThemeSetting；可选预览缺失或失败不保证视觉恢复，回调抛错会阻断后面的关闭。
	private cancel(): void {
		// 仅做恢复预览，不重写用户配置，也不恢复整个主题控制器历史状态。
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		// 不传 selectedValue，所以不触发主列表主题保存回调。
		this.onDone();
	}
}

/**
 * Main settings selector component.
 */
// 主设置面板创建快照项和子菜单，并由宿主聚焦 getSettingsList()；本类没有自己的 handleInput/Focusable。
export class SettingsSelectorComponent extends Container {
	// 实际接受搜索/导航和子菜单输入的列表，外层仅加上下边框。
	private settingsList: SettingsList;

	// 从 config 快照建立设置项→按能力插额外项→绑定字符串解码回调→搭边框，返回新组件。
	// 例确认 block-images 从 false 到 true 只通知 onBlockImagesChange；主宿主保存并影响后续模型输入，不在本类删图片。
	// 构造可触发一次能力缓存探测，但不主动聊天/上传/遥测；每次改变即时回调而非退出统一提交，回调/主题异常传播且不自动回滚显示值。
	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		// 先初始化父容器。
		super();

		// 读取图片协议类型或 null 的快照；不检查 showImages 偏好是否 true，也不订阅后续能力变化。
		const supportsImages = getCapabilities().images;
		// 取 follow-up 当前动作键名用于说明。
		const followUpKey = keyDisplayText("app.message.followUp");
		// 取会话循环思考档位的键名，只作帮助文字。
		const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
		// 浅复制警告字典，let 允许子面板返回新字典时替换它。
		let currentWarnings = { ...config.warnings };
		// 浅复制思考覆盖表，const 禁止变量重赋但仍可增删键；不用它直接改传入 config 字典。
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		// 建立精确模型完整键→元数据 Map，供两步设置查模型；不是按查询刷新目录。
		const defaultModelByValue = new Map(
			// map 返回键值对，Map 同键后值覆盖前值，不在此做身份冲突诊断。
			config.availableDefaultModels.map((model) => [modelSettingKey(model), model]),
		);
		// 默认身份确实在可用 Map 中才用于默认排序/预选；没找到不插失效模型行。
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		// 当前模型有值就生成完整键，即使未在可用 Map 也保留该字符串，预选可能找不到。
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

		// 下面建立主设置数据数组，后面 splice 会插入能力/图片/编辑器相关项；元素仍由 SettingsList 改 currentValue。
		const items: SettingItem[] = [
			{
				// 自动压缩的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "autocompact",
				// label 是“自动压缩”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Auto-compact",
				// 说明超过上下文阈值后自动压缩的偏好，不是在绘菜单时调用模型。
				description: "Automatically compact context when it gets too large",
				// 布尔快照转 true/false 显示字符串；阈值/保留预算不在这个菜单调整。
				currentValue: config.autoCompact ? "true" : "false",
				// 两档循环，确认后同步通知宿主，手动压缩入口不受本菜单直接封锁。
				values: ["true", "false"],
			},
			{
				// 中途引导投递模式的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "steering-mode",
				// label 是“中途引导投递模式”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Steering mode",
				// 说明流式期间排队引导消息的投递粒度，实际读取队列发生在 Agent 循环。
				description:
					// 这行接上面的 description 属性正文，只生成界面说明，不在此执行其中描述的动作。
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				// 沿用当前会话 steeringMode 字符串。
				currentValue: config.steeringMode,
				// 候选顺序逐条→全部，SettingsList 确认循环下一个，不在此取出消息。
				values: ["one-at-a-time", "all"],
			},
			{
				// 后续消息投递模式的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "follow-up-mode",
				// label 是“后续消息投递模式”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Follow-up mode",
				// 模板加入当前 follow-up 快捷键，解释 Agent 停止后如何投递，和 steering 队列分开。
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				// 沿用当前会话 followUpMode。
				currentValue: config.followUpMode,
				// 候选逐条/全部，界面不修改已排队正文。
				values: ["one-at-a-time", "all"],
			},
			{
				// 传输方式的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "transport",
				// label 是“传输方式”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Transport",
				// 说明这是支持多传输 provider 的偏好，不保证所有提供商都支持每一项。
				description: "Preferred transport for providers that support multiple transports",
				// 采用宿主已解析的 transport。
				currentValue: config.transport,
				// 按 SSE、WebSocket、可缓存 WebSocket、自动循环；真正连接由请求层决定。
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				// 会话分享目的地的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "share-destination",
				// label 是“会话分享目的地”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Session share destination",
				// 说明未来 /share 的自动路由偏好，不在确认此菜单时上传会话。
				description:
					// 这行接上面的 description 属性正文，只生成界面说明，不在此执行其中描述的动作。
					"Where to upload sessions with /share (auto prefers Radius when authenticated, otherwise GitHub Gist)",
				// 采用已解析分享目的地，不在此看登录状态。
				currentValue: config.sessionShareDestination,
				// auto/gist/radius 字符串循环，回调再将它当目的地联合类型。
				values: ["auto", "gist", "radius"],
			},
			{
				// HTTP 空闲超时的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "http-idle-timeout",
				// label 是“HTTP 空闲超时”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "HTTP idle timeout",
				// 说明等待响应头/正文片段的空闲限制；不是整段任务、模型 token 总生成时间或所有重试超时。
				description:
					// 这行接上面的 description 属性正文，只生成界面说明，不在此执行其中描述的动作。
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				// 把毫秒格式化成已知标签或自定义秒数文字；自定义值可能不在候选数组里。
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				// 从已知时间档位取显示 label；未知当前值第一次确认跳首档，回调再按 label 查回毫秒，不解析任意显示文本。
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				// 缓存预热的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "cache-warming-mode",
				// label 是“缓存预热”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Cache warming",
				// 说明 off/运行中预热/空闲时也预热的策略；本组件不决定收益判定或发预热请求。
				description:
					// 这行接上面的 description 属性正文，只生成界面说明，不在此执行其中描述的动作。
					"off; streaming while the agent runs; idle also between runs while continuation stays profitable",
				// 当前模式来自宿主用户层 getter，项目不能靠同名设置自行启用费用相关预热。
				currentValue: config.cacheWarmingMode,
				// 展开复制三模式数组，SettingsList 可改显示字符串但不修改共享候选表。
				values: [...CACHE_WARMING_MODES],
			},
			{
				// 隐藏思考块的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "hide-thinking",
				// label 是“隐藏思考块”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Hide thinking",
				// 只控制助手思考内容的 UI 展示，不是关闭模型思考或删除会话历史。
				description: "Hide thinking blocks in assistant responses",
				// 把隐藏偏好转 true/false 显示值。
				currentValue: config.hideThinkingBlock ? "true" : "false",
				// 两档切换后由宿主更新已有消息展示。
				values: ["true", "false"],
			},
			{
				// Mermaid 图表的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "mermaid-rendering",
				// label 是“Mermaid 图表”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Mermaid diagrams",
				// 说明把代码块渲染为 Unicode 图，能否成功仍由语法/渲染器决定。
				description: "Render Mermaid code blocks as Unicode diagrams",
				// 沿用 off/final/streaming 模式。
				currentValue: config.mermaidRenderingMode,
				// 关闭、最终完成后、流式期间三个显示策略循环，不改原消息字符串。
				values: ["off", "final", "streaming"],
			},
			{
				// 缓存诊断通知的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "cache-miss-notices",
				// label 是“缓存诊断通知”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Cache miss notices",
				// 控制 transcript 中缓存成本和恢复诊断的可见性，不是禁用模型缓存。
				description: "Show transcript notices for cache costs and provider recovery diagnostics",
				// 把通知偏好转显示布尔字符串。
				currentValue: config.showCacheMissNotices ? "true" : "false",
				// 两档循环，宿主可重建消息显示。
				values: ["true", "false"],
			},
			{
				// 折叠更新日志的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "collapse-changelog",
				// label 是“折叠更新日志”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Collapse changelog",
				// 控制更新后日志精简展示，本菜单不加载日志或执行更新。
				description: "Show condensed changelog after updates",
				// 折叠偏好变 true/false。
				currentValue: config.collapseChangelog ? "true" : "false",
				// 两档循环，不是压缩模型上下文。
				values: ["true", "false"],
			},
			{
				// 简化启动输出的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "quiet-startup",
				// label 是“简化启动输出”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Quiet startup",
				// 说明 true/false 与 header 模式；header 只保留启动头，而不是任意布尔真值。
				description: "Disable verbose printing at startup (header: keep only the startup header)",
				// String 将布尔或 header 联合统一成列表字符串。
				currentValue: String(config.quietStartup),
				// 顺序 true→header→false，回调把 header 保成文字，其他再按严格 true 转布尔。
				values: ["true", "header", "false"],
			},
			{
				// 安装版本通知的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "install-telemetry",
				// label 是“安装版本通知”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Install telemetry",
				// 说明更新后匿名版本通知偏好，和 enableAnalytics 分享分析数据是两项不同设置。
				description: "Send an anonymous version/update ping after changelog-detected updates",
				// 偏好转 true/false，构造不发送版本通知。
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				// 两档循环只调用宿主设置回调，不立即访问统计服务。
				values: ["true", "false"],
			},
			{
				// 默认项目信任政策的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "default-project-trust",
				// label 是“默认项目信任政策”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Default project trust",
				// 只在扩展或已保存信任决定没有给结论时回退；不在此直接授予当前项目权限。
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
				// 把配置值映成显示标签 Ask/Always trust/Never trust，不直接显示原小写键。
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				// Object.values 产生三个显示标签；回调通过反向 Map 查真实配置值，用户层保存与当前项目决定分开。
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				// 双 Escape 动作的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "double-escape-action",
				// label 是“双 Escape 动作”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Double-escape action",
				// 空编辑器连续两次 Escape 的动作偏好，实际按键检测不在本菜单。
				description: "Action when pressing Escape twice with empty editor",
				// 当前 tree/fork/none 字符串原样展示。
				currentValue: config.doubleEscapeAction,
				// 三档包含 none；后面的 as "fork" | "tree" 虽然类型过窄，运行时不会丢掉 none。
				values: ["tree", "fork", "none"],
			},
			{
				// 会话树默认筛选的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "tree-filter-mode",
				// label 是“会话树默认筛选”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Tree filter mode",
				// 描述未来打开 /tree 的默认视图，不在菜单里遍历会话树。
				description: "Default filter when opening /tree",
				// 采用已解析的树筛选模式。
				currentValue: config.treeFilterMode,
				// 五种允许的视图名循环，默认规则实际由树组件解释。
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				// 警告分类子菜单 id，不是全部警告的一个布尔总开关。
				id: "warnings",
				// 左侧警告设置名称。
				label: "Warnings",
				// 说明可逐项开关警告，实际提示条件由各消费方决定。
				description: "Enable or disable individual warnings",
				// 右侧固定 configure，不把警告字典编码成 JSON 显示。
				currentValue: "configure",
				// 子菜单工厂忽略旧显示值，只保留完成函数，打开时才创建警告面板。
				submenu: (_currentValue, done) =>
					// 创建自己的本地警告副本与列表。
					new WarningSettingsSubmenu(
						// 传最近本菜单跟踪的警告字典，而不是每次重读原 config。
						currentWarnings,
						// 收到修改后的字典立即执行，不等主面板退出。
						(warnings) => {
							// 替换本地 currentWarnings，下一次重开子菜单沿新值。
							currentWarnings = warnings;
							// 调用宿主保存/应用警告偏好，异常不在本层吞掉。
							callbacks.onWarningsChange(warnings);
						},
						// 无值 done 仅关警告子菜单，之前逐项修改已经通知宿主，不回滚。
						() => done(),
					),
			},
			{
				// 每模型默认思考覆盖子菜单 id。
				id: "model-thinking",
				// 显示标题，功能是按模型覆盖，不是切换当前聊天模型。
				label: "Default thinking level per model",
				// 模板加入会话思考循环键的说明；这里的配置覆盖与会话临时循环分层。
				description: `Override the default thinking level for specific models. ${cycleThinkingKey} cycles in-session.`,
				// 初始显示覆盖键数量，未核对这些模型是否仍可用。
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
				// 打开时构建两步流程，忽略旧数量字符串；done 留到整体退出时更新摘要。
				submenu: (_currentValue, done) => {
					// 两步描述数组：先选模型身份，再选其支持的档位。
					const steps: SteppedSubmenuStep[] = [
						{
							// 第一步结果写 context.model。
							key: "model",
							// 模型步标题。
							title: "Per-Model Thinking Level",
							// 说明先挑模型，并非这里开始请求它。
							description: "Select a model to configure",
							// 每次进入/回退该步都重建候选，能读取本菜单最新本地覆盖。
							options: () => {
								// 复制可用模型数组后原地排序副本；希望当前模型优先，再已存默认，再 provider，不改宿主目录顺序。
								const sorted = [...config.availableDefaultModels].sort((a, b) => {
									// 生成比较项 a 的完整键。
									const aKey = modelSettingKey(a);
									// 生成比较项 b 的完整键。
									const bKey = modelSettingKey(b);
									// a 匹配当前模型则给负数；这里没有先对 a/b 同时匹配做对称特判，不额外推导重复输入的稳定顺序保证。
									if (aKey === currentModelKey) return -1;
									// 否则 b 匹配当前模型给正数。
									if (bKey === currentModelKey) return 1;
									// 再把 a 的已存默认模型排前。
									if (aKey === currentDefaultModelKey) return -1;
									// 默认匹配在 b 时把 b 排前。
									if (bKey === currentDefaultModelKey) return 1;
									// 余项按 provider 名比较，不按模型 id 另排。
									return a.provider.localeCompare(b.provider);
								});
								// 每个模型映成 SelectItem 新对象。
								const items: SelectItem[] = sorted.map((model) => {
									// 完整键供选择结果和覆盖查找用。
									const key = modelSettingKey(model);
									// 直接读本地普通字典对应档位，不在这里重新验证外部配置值。
									const override = currentModelThinkingLevels[key];
									// 返回候选对象，表达式块需要显式 return。
									return {
										// 候选 value 是完整 provider/id。
										value: key,
										// 标签中只将 provider 徽标弱色显示。
										label: modelItemLabel(model),
										// 现有覆盖作为说明，缺省为 undefined；不是从全局默认自动补进字典。
										description: override ?? undefined,
									};
								});
								// 没有可用模型时插一个占位项以显示原因。
								if (items.length === 0) {
									// 只往本地新 items 数组添加。
									items.push({
										// 占位的特殊 value 不在 defaultModelByValue 中，后续选档会得到空候选而非真实模型。
										value: "__none__",
										// 占位行文案。
										label: "No models available",
										// 说明需要配置提供商，本菜单不自动登录。
										description: "Log in to a provider or configure an API key first",
									});
								}
								// 返回模型步全部候选。
								return items;
							},
							// 优先当前模型键，再默认；当前键虽非空也可能不在候选，列表找不到时用默认位置，不继续尝试第二个键。
							preselect: () => currentModelKey ?? currentDefaultModelKey,
							// 模型步开启输入搜索，SelectSubmenu 按 label+description 过滤。
							searchable: true,
							// 模型主列目标更宽，具体宽受窗口限制。
							layout: MODEL_PICKER_LAYOUT,
						},
						{
							// 第二步结果写 context.level。
							key: "level",
							// 动态标题可读取前一步模型键。
							title: (ctx) => {
								// 按第一步完整键找模型元数据，不按名称模糊匹配。
								const m = defaultModelByValue.get(ctx.model);
								// 找到显示 id [provider]，找不到直接显示键（包括占位字符串）。
								return `Thinking Level for ${m ? modelDisplayLabel(m) : ctx.model}`;
							},
							// 说明为该模型选择默认档位。
							description: "Select default thinking level for this model",
							// 每次进入级别步都根据当前选模型生成候选。
							options: (ctx) => {
								// 按 context.model 查构造时的目录 Map。
								const model = defaultModelByValue.get(ctx.model);
								// 占位/失效模型没有级别候选，不伪造支持能力。
								if (!model) return [];
								// 下面条件表达式先得到级别数组。
								const levels =
									// reasoning 模型按 thinkingLevelMap 的支持规则过滤，否则只有 off；不发远端能力探测。
									(model.reasoning ? getSupportedThinkingLevels(model) : ["off"]) as ThinkingLevel[];
								// as ThinkingLevel[] 只统一类型，不是运行时验证或转换。
								// 读取本地为这一个模型保存的覆盖，可能缺省；不是当前会话档位。
								const activeLevel = currentModelThinkingLevels[ctx.model];
								// 按支持档位顺序生成候选。
								const items: SelectItem[] = levels.map((level) => ({
									// value 是真实档位名。
									value: level,
									// 勾固定代表当前模型覆盖，浏览光标独立；没有覆盖不在这里自动给全局默认打勾。
									label: `${level === activeLevel ? "✓ " : "  "}${level}`,
									// 界面约数文案，不是 provider 请求的精确 token 限额。
									description: THINKING_DESCRIPTIONS[level],
								}));
								// 本地字典该键有非 undefined 值才允许显示清覆盖候选。
								if (currentModelThinkingLevels[ctx.model] !== undefined) {
									// 追加一个操作项到档位后面。
									items.push({
										// 用内部 __clear__ 哨兵与正常档位区分。
										value: CLEAR_OVERRIDE_VALUE,
										// 显示清覆盖动作，不代表字段已经删除。
										label: "  (clear override)",
										// 文案展示构造时全局默认；主宿主删除用户覆盖后项目层值仍可能存在，因此不能把它当有效配置必已无覆盖的证明。
										description: `Revert to global default (${config.thinkingLevel})`,
									});
								}
								// 返回此模型级别候选及可选清除操作。
								return items;
							},
							// 只预选本地已存在模型覆盖；没有覆盖时返回 undefined，不按全局默认找预选。
							preselect: (ctx) => currentModelThinkingLevels[ctx.model],
						},
					];

					// 无参闭包每次现算覆盖数量，不能用构造时旧数字取代。
					const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);

					// 创建循环两步菜单，可以连续配置多个模型直到用户回退退出。
					return new SteppedSubmenu(
						// 传模型/级别两步描述。
						steps,
						// 每完成一轮就同步处理一次，不等整个设置面板关闭。
						(selections) => {
							// 从 selections.model 查原目录模型。
							const model = defaultModelByValue.get(selections.model);
							// 无真实模型则不保存，不把占位 id 传宿主。
							if (!model) return;
							// 哨兵选择走删除覆盖路径。
							if (selections.level === CLEAR_OVERRIDE_VALUE) {
								// 先通知宿主移除用户层该覆盖，主宿主可能把当前会话重置全局默认；项目同名配置不一定被删除。
								callbacks.onModelThinkingLevelRemove(model.provider, model.id);
								// 再删本地字典，下一轮清除项/数量跟着消失；同步回调抛错则此步未执行。
								delete currentModelThinkingLevels[selections.model];
							} else {
								// 正常档位走保存覆盖回调，三个参数在下方逐行传入。
								callbacks.onModelThinkingLevelChange(
									// 供应商身份。
									model.provider,
									// 模型 id。
									model.id,
									// 对菜单候选档位的静态断言，不验证任意传入字符串。
									selections.level as ThinkingLevel,
								);
								// 通知返回后更新本地覆盖表，const 字典仍能写键；异步返回不被等待。
								currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
							}
						},
						// 流程在第 0 步取消时用这个回调返回主设置列表。
						() => {
							// 有值 done 更新主行数量摘要并关闭子菜单；主 onChange switch 没有 model-thinking case，不重复保存这些已通知的覆盖。
							done(summary());
						},
						// 每轮完成清空步骤 context 并回第 0 步，但闭包里的本地覆盖表继续保留已完成修改。
						{ loop: true },
					);
				},
			},
			{
				// 交互界面模式的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "tui-mode",
				// label 是“交互界面模式”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "TUI mode",
				// regular 用正常终端回滚区，fullscreen 用全屏布局；只描述可选行为。
				description: "Interface layout; regular mode uses the terminal's normal scrollback",
				// 主宿主传实际 ui.mode，切换被拒绝时可 updateValue 恢复此显示。
				currentValue: config.tuiMode,
				// regular/fullscreen 两档；有活动 overlay 等情况下宿主可拒绝，不保证每次确认都切换成功。
				values: ["regular", "fullscreen"],
			},
			{
				// 全屏退出输出的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "fullscreen-exit-output",
				// label 是“全屏退出输出”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Fullscreen exit output",
				// 描述退出全屏后留下会话全文或仅恢复提示，当前菜单不退出终端。
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				// 采用已解析退出输出模式。
				currentValue: config.fullscreenExitOutput,
				// transcript/resume-hint 循环，与 regular 模式的终端历史不是同一个开关。
				values: ["transcript", "resume-hint"],
			},
			{
				// 全屏滚动条的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "fullscreen-scrollbar",
				// label 是“全屏滚动条”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Fullscreen scrollbar",
				// 说明只影响全屏滚动条，regular 模式无对应效果。
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				// 采用当前滚动条显示策略。
				currentValue: config.fullscreenScrollbar,
				// auto/always/hidden 顺序循环，实际绘制由全屏渲染器。
				values: ["auto", "always", "hidden"],
			},
			{
				// 全屏选择后复制的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "fullscreen-copy-on-select",
				// label 是“全屏选择后复制”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Fullscreen copy on select",
				// 描述全屏选中自动复制偏好，本组件不访问剪贴板，文案内默认键名未动态替换。
				description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
				// 当前布尔偏好转字符串。
				currentValue: config.fullscreenCopyOnSelect ? "true" : "false",
				// true/false 循环，主宿主才更新全屏渲染器设置。
				values: ["true", "false"],
			},
			{
				// 全屏滚轮行数的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "fullscreen-wheel-scroll-lines",
				// label 是“全屏滚轮行数”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Fullscreen wheel scrolling",
				// 说明每次滚轮事件行数及 auto 加速策略，菜单不会实际滚动聊天视口。
				description:
					// 这行接上面的 description 属性正文，只生成界面说明，不在此执行其中描述的动作。
					"Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not",
				// 数值或 auto 经 String 作为显示值，例如自定义 7 仍显示 7。
				currentValue: String(config.fullscreenWheelScrollLines),
				// 后续跨行构造候选：auto 在首，固定数字并入当前自定义值、去重/排序后转字符串。
				values: [
					// 候选先放 auto。
					"auto",
					// 用 Set 去重固定数值和当前自定义值，再展开成数组；后面三步处理非 auto 数字。
					...[...new Set([1, 2, 3, 5, 10, config.fullscreenWheelScrollLines])]
						// 剔除集合中可能已有的 auto，防后面重复该文字。
						.filter((lines) => lines !== "auto")
						// 按数字升序排列，不用字符串字典序（例如 10 不排在 2 前面）。
						.sort((a, b) => a - b)
						// 将数字转显示字符串并展开进 values；例如当前 7 得 auto,1,2,3,5,7,10。
						.map(String),
				],
			},
			{
				// 主题设置 id，子菜单最后有值 done 才通知该 id 修改。
				id: "theme",
				// 左侧主题显示标签。
				label: "Theme",
				// 界面主题说明，不在此加载 JSON 文件。
				description: "Color theme for the interface",
				// 保留宿主当前原始设置文字，可能为 light/dark 配对，不只生效主题名。
				currentValue: config.currentTheme,
				// 打开主题面板时以 SettingsList 当前显示值为起点，而不是反复使用最初 config.currentTheme。
				submenu: (currentValue, done) =>
					// 传构造时终端明暗/目录、宿主预览回调和当前 done，主题预览不自行写配置。
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		// Only show image toggle if terminal supports it
		// 只有图片协议快照为 kitty/iterm2 等真值才插终端显示/宽度项，不取决于 showImages 当前是否已开。
		if (supportsImages) {
			// Insert after autocompact
			// splice(index,0,item) 在自动压缩后插入，不删除原项，改变本地 items 顺序。
			items.splice(1, 0, {
				// 终端显示图片的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "show-images",
				// label 是“终端显示图片”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Show images",
				// 只影响内联展示，不等于阻止图片发送给模型。
				description: "Render images inline in terminal",
				// 把 showImages 偏好转显示布尔值；图片能力已由外层 supportsImages 决定此项是否存在。
				currentValue: config.showImages ? "true" : "false",
				// true/false 循环，不在这里改终端协议探测结论。
				values: ["true", "false"],
			});
			// 图片宽紧跟图片展示插入；此位置依赖上面已插入一项。
			items.splice(2, 0, {
				// 图片显示宽度的内部设置 id，修改回调按此名分派，不把显示标题当键。
				id: "image-width-cells",
				// label 是“图片显示宽度”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
				label: "Image width",
				// 首选宽度用字符格计，不是像素或模型输入大小。
				description: "Preferred inline image width in terminal cells",
				// 数值转显示字符串，自定义现值不自动加入下面档位。
				currentValue: String(config.imageWidthCells),
				// 固定 60/80/120；如当前 70 不在数组，确认按 SettingsList 规则从 60 起，不自动选最近的 80。
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		// 图片输入缩放总可用：有终端图项时插在它们后，无能力时仅在自动压缩后；两类设置职责不同。
		items.splice(supportsImages ? 3 : 1, 0, {
			// 图片输入自动缩放的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "auto-resize-images",
			// label 是“图片输入自动缩放”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Auto-resize images",
			// 这段固定文案描述 2000x2000；实际发送前处理还受模型输入元数据和下游规则影响，菜单本身不缩放图片。
			description: "Resize large images to 2000x2000 max for better model compatibility",
			// 把模型输入图片缩放偏好转 true/false。
			currentValue: config.autoResizeImages ? "true" : "false",
			// 两档循环，无图片展示能力的终端也可调整发送给模型的图片偏好。
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		// 按 id 找刚插入的缩放项，避免后面位置靠手算跟着变化。
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		// 把阻止发送紧跟缩放项放，不删除其他设置。
		items.splice(autoResizeIndex + 1, 0, {
			// 阻止发送图片的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "block-images",
			// label 是“阻止发送图片”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Block images",
			// 阻止图片传给模型，与终端是否展示图片独立；不删除本地文件。
			description: "Prevent images from being sent to LLM providers",
			// 把 blockImages 转显示值。
			currentValue: config.blockImages ? "true" : "false",
			// 两档循环，宿主存偏好，后续上下文转换再消费它。
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		// 查阻止图片项当前位置。
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		// 把技能命令开关插在它后面。
		items.splice(blockImagesIndex + 1, 0, {
			// 技能命令的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "skill-commands",
			// label 是“技能命令”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Skill commands",
			// 描述注册 /skill:name 命令，不表示把全部技能正文提前注入上下文。
			description: "Register skills as /skill:name commands",
			// 把技能命令开关转显示值。
			currentValue: config.enableSkillCommands ? "true" : "false",
			// 两档循环，主宿主保存后重建补全提供器。
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		// 查技能命令项位置。
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		// 在其后插硬件光标偏好。
		items.splice(skillCommandsIndex + 1, 0, {
			// 硬件光标的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "show-hardware-cursor",
			// label 是“硬件光标”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Show hardware cursor",
			// 说明采用终端光标的展示偏好，不是是否聚焦搜索框。
			description: "Use the terminal cursor instead of Pi's drawn cursor",
			// 当前硬件光标偏好变字符串。
			currentValue: config.showHardwareCursor ? "true" : "false",
			// 两档循环，宿主修改 TUI 的显示方式。
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		// 查硬件光标项位置。
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		// 在其后插编辑器留白。
		items.splice(hardwareCursorIndex + 1, 0, {
			// 编辑器水平留白的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "editor-padding",
			// label 是“编辑器水平留白”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Editor padding",
			// 编辑器左右的 0..3 列留白，不是正文输出留白。
			description: "Horizontal padding for input editor (0-3)",
			// Number 现值通过 String 展示；这里不负责将非法外部数修成合法值。
			currentValue: String(config.editorPaddingX),
			// 固定 0/1/2/3 字符串循环，回调 parseInt 后宿主 setter 再按范围规范数值。
			values: ["0", "1", "2", "3"],
		});

		// Output padding toggle (insert after editor-padding)
		// 查编辑器留白项位置。
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		// 在其后插输出留白，保持两种留白相邻但独立。
		items.splice(editorPaddingIndex + 1, 0, {
			// 输出水平留白的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "output-padding",
			// label 是“输出水平留白”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Output padding",
			// 消息、工具输出和命令输出左右留白，和编辑器设置分开。
			description: "Horizontal padding for messages, tool output, and command output",
			// 0 或 1 转成字符串值。
			currentValue: String(config.outputPad),
			// 固定 0/1，回调只把严格 "0" 当 0，其余写 1。
			values: ["0", "1"],
		});

		// Autocomplete max visible toggle (insert after output-padding)
		// 查输出留白项位置。
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		// 在其后插补全显示数量。
		items.splice(outputPaddingIndex + 1, 0, {
			// 补全可见项数的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "autocomplete-max-visible",
			// label 是“补全可见项数”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Autocomplete max items",
			// 显示补全下拉窗口的项数，不限制搜索总结果数或请求上下文。
			description: "Max visible items in autocomplete dropdown (3-20)",
			// 当前数量转字符串，现值如 4 不会自动插入候选。
			currentValue: String(config.autocompleteMaxVisible),
			// 固定几个 3..20 档位，不是每个整数都列出；宿主 setter 仍有 3..20 限制。
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		// 查补全数量项位置。
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		// 在其后插内容收缩清行偏好。
		items.splice(autocompleteIndex + 1, 0, {
			// 收缩清空余行的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "clear-on-shrink",
			// label 是“收缩清空余行”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Clear on shrink",
			// 内容变短时清空多余终端行可能闪烁，不等于清除会话消息。
			description: "Clear empty rows when content shrinks (may cause flicker)",
			// 当前有效偏好转 true/false，可能来自显式设置或环境回退。
			currentValue: config.clearOnShrink ? "true" : "false",
			// 两档循环，宿主保存后更新 TUI 清理策略。
			values: ["true", "false"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		// 查清行项位置。
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		// 在其后插终端进度提示。
		items.splice(clearOnShrinkIndex + 1, 0, {
			// 终端进度提示的内部设置 id，修改回调按此名分派，不把显示标题当键。
			id: "terminal-progress",
			// label 是“终端进度提示”的英文显示名；主列表搜索匹配这段英文，不匹配中文注释。
			label: "Terminal progress",
			// 描述 OSC 9;4 标签栏进度，终端是否支持由下游决定；设置菜单不发该控制序列。
			description: "Show OSC 9;4 progress indicators in the terminal tab bar",
			// 把进度偏好转显示值。
			currentValue: config.showTerminalProgress ? "true" : "false",
			// 两档循环，只通知设置变化。
			values: ["true", "false"],
		});

		// Add borders
		// 加入上边框，实际显示宽由 render 决定。
		this.addChild(new DynamicBorder());

		// 建立实际设置列表；按键/鼠标修改先改 item.currentValue，再调用下方解码回调，错误不自动回滚。
		this.settingsList = new SettingsList(
			// 传包含动态插入项的最终数组原引用。
			items,
			// 最多显示 10 个设置项，搜索/说明/帮助会额外占行。
			10,
			// 取当前主题列表样式。
			getSettingsListTheme(),
			// 收到显示字符串，用下面 switch 解码并分派宿主；没有统一 schema 校验、保存事务或 Promise 等待。
			(id, newValue) => {
				// id 是设置项内部标识，不是显示 label；未列出的 warnings/model-thinking 摘要完成事件不另保存。
				switch (id) {
					// 自动压缩布尔分支。
					case "autocompact":
						// 只把严格 "true" 当 true；宿主保存开关/更新 footer，不立即调用模型压缩。
						callbacks.onAutoCompactChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 终端展示分支，与阻止发送图片分开。
					case "show-images":
						// 将显示字符串解码成布尔后交宿主，主宿主还更新已有工具输出。
						callbacks.onShowImagesChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 终端图片字符格宽度分支。
					case "image-width-cells":
						// 十进制 parseInt 解码菜单档位；不是任意字符串的完整验证，NaN/范围由输入约定及下游处理。
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 模型输入图片缩放偏好。
					case "auto-resize-images":
						// 严格 true 解码，实际像素处理在后续输入管道。
						callbacks.onAutoResizeImagesChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 阻止图片向模型发送分支。
					case "block-images":
						// 只通知布尔偏好，不删除本地/会话图片。
						callbacks.onBlockImagesChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 技能命令开关。
					case "skill-commands":
						// 解码后宿主保存并重建补全命令。
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// steering 投递策略。
					case "steering-mode":
						// as 只告诉 TS 这些菜单值属于联合，不检查运行值、不改变字符串；主宿主同步改 Agent 并保存。
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// follow-up 策略分支。
					case "follow-up-mode":
						// 同理只静态断言，实际队列何时投递由 Agent 循环决定。
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 传输偏好分支。
					case "transport":
						// 断言为 Transport 原样传，菜单不验证 provider 支持此传输。
						callbacks.onTransportChange(newValue as Transport);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 分享目的地偏好分支。
					case "share-destination":
						// 原字符串静态收窄后通知，不启动 /share 上传。
						callbacks.onSessionShareDestinationChange(newValue as SessionShareDestination);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// HTTP 超时分支加独立块，允许局部 const choice 不和其他 case 混作用域。
					case "http-idle-timeout": {
						// 按显示 label 在已知档位查回 timeoutMs，不直接 parseInt("5 min")。
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						// 确有已知档位才通知；任意自定义显示文字不在这里解析成毫秒。
						if (choice) {
							// 发送已知毫秒，0 保留禁用；主宿主保存并重建 HTTP dispatcher。
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					}
					// 缓存预热分支。
					case "cache-warming-mode":
						// 静态断言三模式，宿主应用用户层偏好并协调 warmer，这里不直接预热。
						callbacks.onCacheWarmingModeChange(newValue as CacheWarmingMode);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 隐藏思考块分支。
					case "hide-thinking":
						// 解码隐藏偏好，主宿主更新展示，不改变模型 reasoning 能力。
						callbacks.onHideThinkingBlockChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// Mermaid 显示分支。
					case "mermaid-rendering":
						// 断言 mode 并通知宿主使消息显示失效；不校验图语法。
						callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 缓存诊断展示分支。
					case "cache-miss-notices":
						// 布尔解码后让宿主重建诊断可见性。
						callbacks.onShowCacheMissNoticesChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 更新日志折叠分支。
					case "collapse-changelog":
						// 保存折叠偏好，不把上下文内容作模型摘要。
						callbacks.onCollapseChangelogChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 启动输出联合值分支。
					case "quiet-startup":
						// header 明确保留文字，其他字符串只把严格 true 映 true；false 显示值得到布尔 false。
						callbacks.onQuietStartupChange(newValue === "header" ? "header" : newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 匿名版本通知开关。
					case "install-telemetry":
						// 布尔通知，不在此发送版本或分析数据。
						callbacks.onEnableInstallTelemetryChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 默认信任政策的显示标签反向映射分支。
					case "default-project-trust": {
						// Map 查不到返回 undefined，避免把显示标签当合法策略写入。
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						// 只在查到真实策略时通知。
						if (defaultProjectTrust) {
							// 主宿主写用户层默认政策，不直接授权/撤销当前项目。
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					}
					// 双 Escape 行为分支。
					case "double-escape-action":
						// 此 as 联合漏写 none，但断言在运行 JS 擦除，候选的 none 仍原样传给接受三种值的宿主回调。
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 树默认视图分支。
					case "tree-filter-mode":
						// 通知树筛选偏好，参数跨行书写。
						callbacks.onTreeFilterModeChange(
							// 字符串联合断言不运行合法性校验，实际只由上面候选约定来源。
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 硬件光标开关分支。
					case "show-hardware-cursor":
						// 布尔解码后宿主调用 TUI 设置，不在此处理搜索焦点。
						callbacks.onShowHardwareCursorChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 编辑器留白分支。
					case "editor-padding":
						// 十进制转整数值，宿主 setter 再 clamp 0..3 并应用编辑器；本层未检查任意字符串合法。
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 输出留白分支。
					case "output-padding":
						// 严格字符串 0 才选数值 0，任何其他值选择 1；返回参数类型保持 0|1。
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 补全可见数分支。
					case "autocomplete-max-visible":
						// 解析档位后交宿主规范为 3..20，并更新编辑器显示窗口。
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 内容收缩清行分支。
					case "clear-on-shrink":
						// 解码布尔后主宿主既保存也即时配置 TUI。
						callbacks.onClearOnShrinkChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 终端进度偏好分支。
					case "terminal-progress":
						// 通知布尔偏好，本层不直接发 OSC 控制码。
						callbacks.onShowTerminalProgressChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 界面模式分支。
					case "tui-mode":
						// 断言为模式名后通知，宿主可因 overlay 拒绝，并用 getSettingsList().updateValue 恢复实际模式显示。
						callbacks.onTuiModeChange(newValue as TuiMode);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 全屏退出输出策略。
					case "fullscreen-exit-output":
						// 原字符串按类型约定转交，不在当前时刻退出/打印 transcript。
						callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 全屏滚动条策略分支。
					case "fullscreen-scrollbar":
						// 转交策略名，主宿主更新全屏渲染器。
						callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 全屏自动复制偏好分支。
					case "fullscreen-copy-on-select":
						// 解码布尔，仅改变偏好，本层不接触系统剪贴板。
						callbacks.onFullscreenCopyOnSelectChange(newValue === "true");
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 滚轮行数/自动联合分支。
					case "fullscreen-wheel-scroll-lines":
						// auto 保留字符串，其余按十进制 parseInt；主 setter 数值取整/限制 1..100，真正滚动另处理。
						callbacks.onFullscreenWheelScrollLinesChange(newValue === "auto" ? "auto" : parseInt(newValue, 10));
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
					// 主题最终提交分支，浏览预览不会经这里。
					case "theme":
						// 把单名或 light/dark 配对原文字交宿主保存并应用；不能从 void 回调推断落盘已成功。
						callbacks.onThemeChange(newValue);
						// 结束当前设置分支，避免同一次修改落入后面的其他 case；不是退出整个构造函数。
						break;
				}
			},
			// 主设置列表取消回调，主宿主负责移除整个面板，不回滚此前即时变更。
			callbacks.onCancel,
			// 打开主列表输入搜索，仅过滤标签；本类不另外创建搜索框。
			{ enableSearch: true },
		);

		// 把实际列表放在两条边框之间，主宿主聚焦的也是此列表。
		this.addChild(this.settingsList);
		// 加入下边框。
		this.addChild(new DynamicBorder());
	}

	// 返回内部 SettingsList 原引用，无副作用；例主宿主用它聚焦、在模式切换被拒时 updateValue 恢复显示，不复制其状态。
	getSettingsList(): SettingsList {
		// 外部拿到同一可变列表，可调用其公开方法；不会因此自动保存。
		return this.settingsList;
	}
}
