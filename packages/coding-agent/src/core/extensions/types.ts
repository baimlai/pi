// 定义扩展 API、事件、上下文、工具、供应商与加载结果契约；绝大部分声明只供 TypeScript 检查，运行时执行/校验在 loader、runner 与调用方。
/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

// import type 只引入编译期名称，擦除类型后不会为了这些名称加载模块；这里描述 Agent 交给扩展的消息/工具契约。
import type {
	// AgentMessage 是系统、用户、助手、工具及扩展消息的会话联合类型。
	AgentMessage,
	// AgentTool 是可被 Agent 调用的工具结构。
	AgentTool,
	// 嵌套执行结果包含工具输出及错误等执行信息。
	AgentToolCallOutcome,
	// 工具最终输出的泛型结构，details 类型由工具作者指定。
	AgentToolResult,
	// 工具部分输出回调，供流式展示执行进度。
	AgentToolUpdateCallback,
	// 思考档位的允许值集合。
	ThinkingLevel,
	// 工具顺序/并发执行方式的类型。
	ToolExecutionMode,
	// 从 Agent 核心包取得上述纯类型。
} from "@earendil-works/pi-agent-core";
// 模型与供应商层类型：这里声明 API 契约，并不创建请求或读取凭证。
import type {
	// AnyModel 包括聊天、图像、分类模型的目录类型。
	AnyModel,
	// 聊天模型 API 协议标识。
	Api,
	// 标准化后的助手流事件。
	AssistantMessageEvent,
	// 可异步迭代并取得最终助手消息的流对象。
	AssistantMessageEventStream,
	// 分类器 API 标识。
	ClassifierApi,
	// 供应商约束采样选项。
	ConstrainedSamplingConfig,
	// 图像生成 API 标识。
	ImageApi,
	// 图片内容块，通常带 MIME 类型与编码数据。
	ImageContent,
	// 只能由 JSON 值组成的结构化数据类型。
	JsonValue,
	// 供应商可识别的模型消息联合类型。
	Message,
	// 聊天模型的描述结构，泛型区分 API 协议。
	Model,
	// 登录后保存的 OAuth 凭证结构。
	OAuthCredentials,
	// 登录过程用于展示链接、询问信息等回调集合。
	OAuthLoginCallbacks,
	// 原生供应商对象，包含目录与各能力实现。
	Provider,
	// 供应商分类器实现类型。
	ProviderClassifier,
	// 请求头字典；字符串设置值，null 表示删除同名头。
	ProviderHeaders,
	// 供应商标识类型。
	ProviderId,
	// 供应商图像生成实现类型。
	ProviderImages,
	// 刷新供应商目录时提供的上下文。
	RefreshModelsContext,
	// 简化聊天流选项，含认证、取消和请求生命周期钩子。
	SimpleStreamOptions,
	// 文本消息块。
	TextContent,
	// 工具结果消息，携带调用 ID 与结果内容。
	ToolResultMessage,
	// 包含系统状态的规范 transcript 上下文。
	TranscriptContext,
	// token/费用等用量统计结构。
	Usage,
	// 上述名字都来自模型适配层，仍然是纯类型导入。
} from "@earendil-works/pi-ai";
// 终端界面类型只约束扩展组件的形状，真正 UI 由当前模式提供。
import type {
	// 自动补全的一项候选。
	AutocompleteItem,
	// 自动补全提供者接口。
	AutocompleteProvider,
	// 可在终端渲染的组件接口。
	Component,
	// 编辑器组件接口。
	EditorComponent,
	// 编辑器所需的主题样式接口。
	EditorTheme,
	// 可配置快捷键动作的类型。
	Keybinding,
	// 按键组合标识，例如 "ctrl+x"。
	KeyId,
	// 控制浮层显示/隐藏的句柄。
	OverlayHandle,
	// 浮层位置和尺寸选项。
	OverlayOptions,
	// 终端程序状态的结构。
	ProgramStatus,
	// 终端 UI 主对象类型。
	TUI,
	// 结束 TUI 类型导入，不会因此创建终端实例。
} from "@earendil-works/pi-tui";
// TSchema 表示 TypeBox schema；Static<S> 从 schema 推导参数的编译期类型，实际运行验证另有调用方。
import type { Static, TSchema } from "typebox";
// 交互主题对象，给渲染器提供颜色/样式。
import type { Theme } from "../../modes/interactive/theme/theme.ts";
// 用户 bash 命令的最终执行结果。
import type { BashResult } from "../bash-executor.ts";
// 提示缓存预热决策事件及其可选改写结果。
import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../cache-warmer.ts";
// 压缩准备材料与压缩摘要结果类型；这里只描述结构，不调用压缩模型。
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
// 扩展之间共享的轻量事件总线接口。
import type { EventBus } from "../event-bus.ts";
// 扩展 exec 的进程选项与最终结果。
import type { ExecOptions, ExecResult } from "../exec.ts";
// 页脚可读数据接口；readonly 在类型层禁止写入。
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
// 宿主快捷键管理器，避免扩展另载一份包后读到不同配置。
import type { KeybindingsManager } from "../keybindings.ts";
// MCP 配置、注册表和带来源的服务器记录。
import type { McpServerConfig, McpServerRegistry, RegisteredMcpServer } from "../mcp-servers.ts";
// 扩展自定义可见消息类型，details 可泛型化。
import type { CustomMessage } from "../messages.ts";
// 当前会话模型目录及认证查询门面。
import type { ModelRegistry } from "../model-registry.ts";
// 会话范围内模型及关联思考设置。
import type { ScopedModel } from "../model-resolver.ts";
// 会话树记录类型用来描述扩展看到的历史与可追加边界条目。
import type {
	// 切换分支生成的摘要条目。
	BranchSummaryEntry,
	// 上下文压缩条目，原日志仍保留。
	CompactionEntry,
	// 对模型上下文投影进行替换的编辑条目。
	ContextEditEntry,
	// 扩展持久化状态条目，默认不作为模型会话。
	CustomEntry,
	// 应用上下文编辑后的条目投影。
	ProjectedSessionEntry,
	// 供普通扩展上下文使用的只读会话管理接口。
	ReadonlySessionManager,
	// 原始会话条目的联合类型。
	SessionEntry,
	// 完整会话管理器，只在明确允许初始化等地方传入。
	SessionManager,
	// 会话类型来自持久化/投影层。
} from "../session-manager.ts";
// 合并后的有效设置类型。
import type { Settings } from "../settings-manager.ts";
// 斜杠命令及其来源信息。
import type { SlashCommandInfo } from "../slash-commands.ts";
// 工具/命令等资源的来源标记。
import type { SourceInfo } from "../source-info.ts";
// 系统提示构造的原始选项和已补齐集合字段的规范选项。
import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
// bash 执行后端接口，可把执行转接到自定义环境。
import type { BashOperations } from "../tools/bash.ts";
// edit 工具返回的 diff 等详情。
import type { EditToolDetails } from "../tools/edit.ts";
// 内置工具输入/详情类型使事件处理器能按工具名获得字段提示。
import type {
	// bash 输出截断等详情。
	BashToolDetails,
	// bash 命令、超时等输入。
	BashToolInput,
	// edit 的文件路径与旧/新文本输入。
	EditToolInput,
	// find 截断及结果限制详情。
	FindToolDetails,
	// find 的模式、目录、条数等输入。
	FindToolInput,
	// grep 的截断/结果限制详情。
	GrepToolDetails,
	// grep 的搜索表达式和过滤选项。
	GrepToolInput,
	// ls 列表截断/限制详情。
	LsToolDetails,
	// ls 路径与限制输入。
	LsToolInput,
	// PowerShell 执行结果详情。
	PowerShellToolDetails,
	// PowerShell 命令输入。
	PowerShellToolInput,
	// read 的截断等详情。
	ReadToolDetails,
	// read 的文件路径和行区间输入。
	ReadToolInput,
	// write 的目标路径与内容输入。
	WriteToolInput,
	// 结束内置工具纯类型列表。
} from "../tools/index.ts";
// 虚拟模型请求、路由选择和定义类型；路由声明不等于发起真实供应商请求。
import type { ModelRoute, ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";

// 重导出进程执行类型，让扩展作者从扩展 API 入口取得它们。
export type { ExecOptions, ExecResult } from "../exec.ts";
// 重导出系统提示选项，供 before_agent_start 或命令修改构造过程。
export type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
// 重导出工具输出、进度回调和执行方式，省去扩展另找核心包入口。
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
// 重导出可配置应用快捷键与管理器类型。
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

// ============================================================================
// UI Context
// ============================================================================

/** Options for extension UI dialogs. */
// 对话框可选设置的接口；interface 只描述形状，运行时由具体 UI 模式解释这些字段。
export interface ExtensionUIDialogOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	// 可选取消信号；对话框实现监听后可程序化关闭。
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
	// 可选超时毫秒数；交互实现可展示倒计时并在到期时关闭。
	timeout?: number;
}

/** Placement for extension widgets. */
// 字符串字面量联合限定挂件放编辑器上方或下方，拼错会被 TypeScript 拦住。
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Options for extension widgets. */
// 挂件位置选项；省略时由 UI 使用默认上方位置。
export interface ExtensionWidgetOptions {
	/** Where the widget is rendered. Defaults to "aboveEditor". */
	// 问号表示可省略，而不是在本文件生成默认值。
	placement?: WidgetPlacement;
}

/** Raw terminal input listener for extensions. */
// 原始键盘输入回调类型：输入字符数据，返回 consume 拦截标记/替换 data，或 undefined 继续。例：仅吞掉自己处理的按键；注册不会立即调用它。
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Working indicator configuration for the interactive streaming loader. */
// 流式工作指示器配置，实际绘制由交互模式完成。
export interface WorkingIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
	// 动画帧；空数组用于隐藏指示器，帧文本不会自动加颜色。
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	// 可选帧间隔，单位毫秒。
	intervalMs?: number;
}

/** Wrap the current autocomplete provider with additional behavior. */
// 自动补全包装工厂：接收旧 provider，返回增强 provider。只声明签名，不在此安装或调用。
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
// 编辑器工厂接收宿主 TUI、编辑器主题、快捷键管理器，返回编辑器组件；例如构造自定义 Vim 编辑器，构造副作用由宿主实际调用时发生。
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * Formats the host's configured keybindings for display.
 * Extensions should use these instead of importing `keyText`/`keyHint`: an import may resolve to another copy of
 * pi-coding-agent, which does not see the host's keybindings.
 */
// 宿主快捷键显示接口；使用当前配置，不依赖扩展自己导入的另一份全局状态。
export interface KeybindingHints {
	/** Configured keys for a keybinding id, for example `"ctrl+o"`. Empty when the id has no keys. */
	// 输入动作 ID，返回其配置按键文本；未绑定时返回空文本。例如 keyText("...动作...") 的具体 ID 由 Keybinding 类型限定。
	keyText(keybinding: Keybinding): string;

	/** Configured keys followed by a description, styled as a hint, for example `"ctrl+o to expand"`. */
	// 输入动作 ID 和说明，返回带提示样式的文本；这里只声明显示方法，不注册按键。
	keyHint(keybinding: Keybinding, description: string): string;
}

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
// 各模式提供的 UI 能力契约；TUI/RPC/print 实现不同，无 UI 默认实现会返回占位值或不执行操作。
export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	// 显示标题与候选列表，异步返回所选字符串；取消/不支持可为 undefined。opts 控制取消和超时，例如从 ["A","B"] 中选择。
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	// 显示标题与确认正文，返回用户是否同意；false 也可表示关闭。不会因为声明签名就弹窗。
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	// 显示单行输入框，接收可选占位文字/取消设置，完成返回字符串，取消返回 undefined。
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	// 发送界面通知，type 限定三种等级，void 表示调用方不取得结果；是否可见取决于模式实现。
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	// 注册原始终端输入回调并返回取消订阅函数；仅交互模式处理。例如保存 off 后调用 off() 停止监听。
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** Set status text in the footer/status bar. Pass undefined to clear. */
	// 按 key 设置页脚状态，text 为 undefined 时清除该 key；同一 key 更新会替换原状态。
	setStatus(key: string, text: string | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	// 设置工作中文字；无参数恢复默认，真正显示仍由 UI 状态决定。
	setWorkingMessage(message?: string): void;

	/** Show or hide the built-in interactive working loader row during streaming. */
	// 控制流式工作行是否可见，不会因此启动/停止 Agent。
	setWorkingVisible(visible: boolean): void;

	/**
	 * Configure the interactive working indicator shown during streaming.
	 *
	 * - Omit the argument to restore the default animated spinner.
	 * - Use `frames: ["●"]` for a static indicator.
	 * - Use `frames: []` to hide the indicator entirely.
	 * - Custom frames are rendered as provided, so extensions must add their own colors.
	 */
	// 设置指示器帧和速度；省略参数恢复默认，frames:[] 隐藏指示器。此签名只声明配置入口。
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** Set the label shown for hidden thinking blocks. Call with no argument to restore default. */
	// 设置折叠思考块的标题；省略恢复默认标题，不修改模型的思考内容。
	setHiddenThinkingLabel(label?: string): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	// 挂件的字符串数组重载：以 key 定位，undefined 清除，options 控制位置；数组每项作为展示行。
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	// 挂件的组件工厂重载；与上面的字符串版本共用方法名，运行时实现区分传入内容。
	setWidget(
		// 挂件标识，同名更新相应挂件。
		key: string,
		// 传入 (tui,theme)=>组件 或 undefined 清除；& 表示组件还可带 dispose 清理方法，? 表示清理方法可缺省。
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		// 可选挂件位置设置。
		options?: ExtensionWidgetOptions,
		// 该重载返回 void；声明不会创建组件，宿主需要展示时才调用工厂。
	): void;

	/** Set a custom footer component, or undefined to restore the built-in footer.
	 *
	 * The factory receives a FooterDataProvider for data not otherwise accessible:
	 * git branch and extension statuses from setStatus(). Context usage is on
	 * ctx.getContextUsage(), token stats on ctx.sessionManager.getEntries(), model info on ctx.model.
	 */
	// 替换页脚组件，输入工厂或 undefined；undefined 恢复内置页脚。工厂可用只读 footerData 读取分支/扩展状态。
	setFooter(
		// factory 参数在下面用联合类型展开。
		factory: // 工厂接收终端、主题、页脚数据，返回组件及可选 dispose；实际分配资源应在 dispose 中释放。
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			// 联合分支 undefined 允许恢复内置页脚。
			| undefined,
		// 设置动作没有返回值，不代表组件工厂已在此调用。
	): void;

	/** Set a custom header component (shown at startup, above chat), or undefined to restore the built-in header. */
	// 设置头部组件工厂，undefined 恢复内置头部；工厂输入 TUI/主题，返回可选有清理方法的组件。
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** Set the terminal window/tab title. */
	// 设置终端窗口/标签标题，void 表示无返回数据；并不改变会话名称。
	setTitle(title: string): void;

	/** Show a custom component with keyboard focus. */
	// 显示自定义聚焦组件并等待结果；泛型 T 把 done(result) 的类型和返回 Promise<T> 连起来。例：done("选择A") 令等待者得到字符串；组件错误/资源清理由 UI 实现负责。
	custom<T>(
		// 传入组件工厂签名，注册声明本身不会执行工厂。
		factory: (
			// 宿主终端 UI 实例。
			tui: TUI,
			// 宿主主题，用于样式。
			theme: Theme,
			// 宿主快捷键配置。
			keybindings: KeybindingsManager,
			// 完成回调把 T 类型结果交给等待者，并结束该自定义交互。
			done: (result: T) => void,
			// 工厂可同步返回组件或异步返回 Promise；两者均可提供 dispose 释放资源。
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		// 可选显示设置的内联对象类型。
		options?: {
			// true 使用浮层，否则通常是内联自定义组件。
			overlay?: boolean;
			/** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
			// 浮层尺寸/位置既可固定对象，也可回调动态计算。
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** Called with the overlay handle after the overlay is shown. Use to control visibility. */
			// 浮层显示后拿到 handle，可进一步控制其可见性。
			onHandle?: (handle: OverlayHandle) => void;
			/**
			 * Report pi as blocked on user input (OSC 7501 program status) while this component is visible.
			 * Only applies to inline components, not overlays.
			 */
			// 内联显示时可报告等待用户输入的程序状态；NonNullable 去除 ProgramStatus["kind"] 的空值类型，message 给终端用户显示。
			blocked?: { kind: NonNullable<ProgramStatus["kind"]>; message: string };
		},
		// 异步结果类型为 T，与 done 参数保持一致；并不在类型层保证工厂最终调用 done。
	): Promise<T>;

	/** Paste text into the editor, triggering paste handling (collapse for large content). */
	// 把文字送入编辑器粘贴处理逻辑，大段文本可能折叠；与直接赋值不同，会经过粘贴路径。
	pasteToEditor(text: string): void;

	/** Set the text in the core input editor. */
	// 直接设置核心编辑器正文，不发送给模型。
	setEditorText(text: string): void;

	/** Get the current text from the core input editor. */
	// 同步读取编辑器当前文字，不提交输入。
	getEditorText(): string;

	/** Show a multi-line editor for text editing. */
	// 显示多行编辑器，接收标题/初始正文，返回完成文字或取消时 undefined；具体支持取决于模式。
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** Stack additional autocomplete behavior on top of the built-in provider. */
	// 把工厂叠加到自动补全链，后续调用可包装已有行为。
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * Set a custom editor component via factory function.
	 * Pass undefined to restore the default editor.
	 *
	 * The factory receives:
	 * - `theme`: EditorTheme for styling borders and autocomplete
	 * - `keybindings`: KeybindingsManager for app-level keybindings
	 *
	 * For full app keybinding support (escape, ctrl+d, model switching, etc.),
	 * extend `CustomEditor` from `@earendil-works/pi-coding-agent` and call
	 * `super.handleInput(data)` for keys you don't handle.
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@earendil-works/pi-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // Handle vim normal mode keys...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // App keybindings + text editing
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	// 设置编辑器工厂，undefined 恢复默认；自定义实现应转发未处理按键以保留应用快捷键。
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** Get the currently configured custom editor factory, or undefined when using the default editor. */
	// 读取当前自定义工厂，默认编辑器时返回 undefined；取函数不等于构造组件。
	getEditorComponent(): EditorFactory | undefined;

	/** Get the current theme for styling. */
	// 只读主题属性，readonly 约束调用者赋值，不是运行时深冻结。
	readonly theme: Theme;

	/** Get all available themes with their names and file paths. */
	// 取得主题名/路径列表；内置主题可能无文件路径，数组元素内联类型同时约束两字段。
	getAllThemes(): { name: string; path: string | undefined }[];

	/** Load a theme by name without switching to it. Returns undefined if not found. */
	// 按名称加载主题但不切换当前主题，找不到返回 undefined。
	getTheme(name: string): Theme | undefined;

	/** Set the current theme by name or Theme object. */
	// 尝试切换到主题名或对象，返回 success 和可选 error 供调用方展示失败。
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** Get current tool output expansion state. */
	// 读取工具结果是否展开的界面状态，不改变工具结果数据。
	getToolsExpanded(): boolean;

	/** Set tool output expansion state. */
	// 设置工具展示展开状态，不重新执行工具。
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context
// ============================================================================

// 当前模型上下文用量估计，未知 token 时用 null 明确表示无数值。
export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	// 估算 token 数；压缩后尚未拿到新回复等情形可能未知。
	tokens: number | null;
	// 当前模型上下文窗口 token 上限，用于计算占用比例。
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	// 百分比或 null；不同于 0，null 表示尚不知道占用。
	percent: number | null;
}

// 发起后台压缩的可选参数；这里只声明回调，真正压缩由绑定的会话动作执行。
export interface CompactOptions {
	// 附加给摘要过程的指示，不替换会话历史本身。
	customInstructions?: string;
	// 成功回调接收压缩结果，不返回值；调用顺序/时机由压缩动作负责。
	onComplete?: (result: CompactionResult) => void;
	// 失败回调接收 Error；没有在此启动任何异步任务。
	onError?: (error: Error) => void;
}

/**
 * Context passed to extension event handlers.
 */
// 运行模式字符串联合，区分终端交互、RPC、JSON、纯文本输出。
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

// 事件处理器的会话视图；runner 通过 getter/绑定动作构造，旧 runtime 失效后受保护访问会抛错。
export interface ExtensionContext {
	/** UI methods for user interaction */
	// 当前模式的 UI 实现，方法存在不保证每个模式都能展示终端组件。
	ui: ExtensionUIContext;
	/** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
	// 当前模式，用 mode==="tui" 可判断是否适合终端组件。
	mode: ExtensionMode;
	/** Whether dialog-capable UI is available (true in TUI and RPC modes) */
	// runner 依据是否绑定实际 UI 判断，不是逐方法能力探测；普通 TUI/RPC 能提供对话框。
	hasUI: boolean;
	/** Current working directory */
	// 此扩展上下文的工作目录。
	cwd: string;
	/** Session manager (read-only) */
	// 类型只暴露读取方法；readonly 接口不是把底层会话对象冻结。
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	// 模型目录与认证解析门面；读取目录不同于立即发起模型请求。
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined) */
	// 当前聊天模型，未选择时 undefined；any 泛型放宽这里的 API 类型，调用者需结合具体模型理解协议。
	model: Model<any> | undefined;
	/** Models scoped to this session (resolved from `--models` /
	 *  `enabledModels` settings against the available catalogue). Same set
	 *  the `/scoped-models` command shows. Empty when no scoping is
	 *  configured (all available models are usable). Read-only snapshot. */
	// 当前会话筛选模型的只读数组视图，空数组表示未配置筛选；readonly 在编译期限制数组写入，不是运行时深冻结。
	scopedModels: readonly ScopedModel[];
	/** Current thinking level, when provided by the session runtime. */
	// 宿主可选提供当前思考档位。
	thinkingLevel?: ThinkingLevel;
	/** Whether the agent is idle (not streaming) */
	// 读取会话是否空闲；普通 AgentSession 实现还考虑压缩，独立用户 bash 不包含在此判断里，不应据此断言所有外部动作停止。
	isIdle(): boolean;
	/** Whether project-local trust is active for this context. */
	// 判断当前上下文是否已启用项目本地信任。
	isProjectTrusted(): boolean;
	/** The current abort signal, or undefined when the agent is not streaming. */
	// 模型流进行中的取消信号，非流式时通常 undefined；实际信号来源由宿主绑定。
	signal: AbortSignal | undefined;
	/** Abort the current agent operation */
	// 请求中止当前 Agent 操作，void 不代表取消已经完成；外部工具需响应信号。
	abort(): void;
	/** Whether there are queued messages waiting */
	// 普通会话实现检查 steering/followUp 文字队列，不是枚举所有内部工作或自定义扩展事件。
	hasPendingMessages(): boolean;
	/** Gracefully shutdown pi and exit. Available in all contexts. */
	// 请求有序关闭，具体等待/退出流程交给宿主；调用本方法不返回关闭完成的 Promise。
	shutdown(): void;
	/** Get current context usage for the active model. */
	// 读取当前模型用量估计，尚不可得时返回 undefined。
	getContextUsage(): ContextUsage | undefined;
	/** Trigger compaction without awaiting completion. */
	// 请求压缩并立即返回，通过 options 回调取得结果；摘要过程可能调用模型并追加投影记录，原始日志不因此物理删除。
	compact(options?: CompactOptions): void;
	/** Get the current effective system prompt. */
	// 读取当前有效系统提示；before_agent_start 专用上下文会基于本轮最新共享选项重新渲染。
	getSystemPrompt(): string;
}

/** Options for {@link ExtensionToolContext.executeTool}. */
// 嵌套工具执行选项，默认继承调用工具信号，也可提供自己的信号/进度观察者。
export interface ExecuteToolOptions {
	/** Defaults to the calling tool's signal. */
	// 显式信号替代默认继承信号，不是自动与两者组合。
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	// 收到嵌套工具部分结果；同一执行还会产生 tool_execution_update 事件。
	onUpdate?: AgentToolUpdateCallback;
}

/**
 * Context passed to tool `execute()` in a session: the extension context plus `executeTool()`
 * for running other tools through the same validation, hooks, and permission checks as
 * model-issued calls.
 *
 * A tool wrapped with `wrapToolDefinition()` without a context factory, such as a built-in tool
 * created with `createBashTool()` and run in a plain `Agent` or called directly, gets no context.
 */
// 在普通上下文上增加嵌套工具能力；extends 让接口继承父字段，不在运行时自动安装方法。
export interface ExtensionToolContext extends ExtensionContext {
	/** Tools {@link executeTool} can call. */
	// 当前允许程序化调用的工具只读列表，可能不同于直接声明给模型的 active 列表。
	readonly tools: readonly AgentTool[];
	/**
	 * Run another tool. The call gets the id `<calling id>/<n>`, and the `tool_call`, `tool_result`,
	 * and `tool_execution_*` events carry `parentToolCallId`. It does not appear in the transcript;
	 * a bounded record of it is kept as `nestedCalls` on the calling tool's result message.
	 *
	 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
	 * errors come back as `isError: true`.
	 */
	// 执行指定工具，输入 name/unknown 参数及选项，异步返回统一 outcome。校验失败、阻止、工具异常等常规失败转 isError；旧 runtime 的 assertActive 仍可能先抛错，不能把“Never rejects”理解为所有情况绝不拒绝。
	executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
// 命令上下文增加用户主动触发的会话控制；这些方法可能替换会话并使旧上下文失效。
export interface ExtensionCommandContext extends ExtensionContext {
	/** Get the current base system-prompt construction options. */
	// 取当前基础提示构造选项，不等于取最终渲染字符串；用于命令了解/调整初始化材料。
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** Wait for the agent to finish streaming */
	// 等待 Agent 完成流式执行，Promise<void> 只通知完成，没有结果数据。
	waitForIdle(): Promise<void>;

	/** Start a new session, optionally with initialization. */
	// 新建会话并可初始化，返回 cancelled 区分被 before 钩子取消；真正替换后应使用 withSession 中的新上下文。例：await ctx.newSession({withSession:async fresh=>...})。
	newSession(options?: {
		// 可记录父会话文件，表达来源关系。
		parentSession?: string;
		// setup 获得新会话完整管理器，可在初始化阶段追加记录；它是会被等待的异步回调。
		setup?: (sessionManager: SessionManager) => Promise<void>;
		// withSession 获得替换完成后的新上下文，避免继续使用旧 ctx。
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		// 返回异步取消结果；cancelled:false 表示该绑定动作未报告取消，具体是否有动作仍取决于宿主实现。
	}): Promise<{ cancelled: boolean }>;

	/** Fork from a specific entry, creating a new session file. */
	// 从条目处分叉新会话文件，输入条目 ID 和可选位置/回调；返回取消状态，失败可拒绝。
	fork(
		// 源会话条目 ID。
		entryId: string,
		// before 表示目标条目前，at 表示包含目标；withSession 在替换后获得新上下文。
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
		// Promise 结果告知是否被取消。
	): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	// 在会话树定位另一条目，可生成离开分支摘要；输入目标和摘要设置，返回取消状态。
	navigateTree(
		// 目标条目 ID。
		targetId: string,
		// 可指定摘要、附加指示、是否替换默认指示和摘要标签；省略值由会话导航逻辑决定。
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
		// 返回导航是否取消，不直接返回摘要正文。
	): Promise<{ cancelled: boolean }>;

	/** Switch to a different session file. */
	// 切换到其他会话文件；成功后旧上下文失效，应在 withSession 中继续执行新会话操作。
	switchSession(
		// 目标会话路径。
		sessionPath: string,
		// 可选替换完成回调，接收新上下文。
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
		// 异步返回取消状态，读取/替换失败可拒绝。
	): Promise<{ cancelled: boolean }>;

	/** Reload extensions, skills, prompts, themes, and context files. */
	// 重载扩展/技能/提示/主题/项目上下文；可能使当前扩展运行时失效，Promise 表示绑定重载操作完成。
	reload(): Promise<void>;
}

/**
 * Fresh command-capable context bound to the replacement session after a session switch.
 *
 * This is passed to `withSession()` callbacks on `newSession()`, `fork()`, and `switchSession()`.
 */
// 会话替换后提供的新命令上下文；消息方法返回 Promise，可等待执行/入队步骤，与工厂 pi.* 的 void 方法不同。
export interface ReplacedSessionContext extends ExtensionCommandContext {
	// 发自定义消息，可泛型化 details；该签名只声明能力，不在此发送。
	sendMessage<T = unknown>(
		// Pick 只取自定义类型、内容、展示标记与详情，时间戳等由会话层补齐。
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		// triggerTurn 控制空闲时是否启动一轮，deliverAs 控制转向/跟进/下一轮递送。
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		// 可等待发送动作，拒绝由调用者处理。
	): Promise<void>;

	// 以用户身份发文字或文字/图片块；可等待这次输入处理动作。
	sendUserMessage(
		// 联合类型允许纯文字或多模态内容数组。
		content: string | (TextContent | ImageContent)[],
		// 忙碌时可选择队列方式；expandPromptTemplates 可启用扩展命令/技能命令/提示模板展开。
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
		// Promise<void> 表示异步完成但不携带回复文本。
	): Promise<void>;
}

// ============================================================================
// Tool Types
// ============================================================================

/** Rendering options for tool results */
// 工具结果渲染的当前选项，只影响显示，不重新执行工具或改变结果。
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	// 是否展开详情。
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	// 是否为执行中的部分结果，而非最终结果。
	isPartial: boolean;
}

/** Context passed to tool renderers. */
// 工具渲染上下文继承快捷键提示方法；泛型分别指定跨渲染状态和工具参数，默认 any 沿用原 API。
export interface ToolRenderContext<TState = any, TArgs = any> extends KeybindingHints {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	// 当前参数，同一工具调用的调用区/结果区渲染共享它。
	args: TArgs;
	/** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
	// 一次执行的稳定唯一 ID，用于关联多次流式重绘。
	toolCallId: string;
	/** Invalidate just this tool execution component for redraw. */
	// 请求仅重绘此工具组件；函数类型 () => void 表示无参数、无返回数据。
	invalidate: () => void;
	/** Previously returned component for this render slot, if any. */
	// 当前渲染槽上次返回的组件；首次通常 undefined，可复用组件降低分配。
	lastComponent: Component | undefined;
	/** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
	// 同一工具行共享的自定义状态，其实际形状由 TState 指定。
	state: TState;
	/** Working directory for this tool execution. */
	// 该次工具执行的工作目录。
	cwd: string;
	/** Whether the tool execution has started. */
	// 执行是否已经开始，不应把参数流入误当工具已经运行。
	executionStarted: boolean;
	/** Whether the tool call arguments are complete. */
	// 参数是否已完整收到；为 false 时渲染器可能看到未完成参数。
	argsComplete: boolean;
	/** Whether the tool result is partial/streaming. */
	// 本次是否部分结果。
	isPartial: boolean;
	/** Whether the result view is expanded. */
	// 当前结果是否展开。
	expanded: boolean;
	/** Whether inline images are currently shown in the TUI. */
	// 终端当前是否展示内联图片。
	showImages: boolean;
	/** Whether the current result is an error. */
	// 当前结果是否标记错误。
	isError: boolean;
	/**
	 * Milliseconds the tool's execution took, from the final result; `undefined` while it runs, when it did not run, or
	 * for results stored before durations were recorded.
	 */
	// 最终实际执行耗时；尚运行、未运行或旧日志没有耗时时为 undefined。
	durationMs: number | undefined;
	/** Horizontal padding configured by the outputPad setting. Renderers with `renderShell: "self"` apply it themselves. */
	// 配置的水平留白；工具自行绘制外框时需自行应用。
	outputPad: number;
}

/**
 * How the model reaches a tool. "Callable" means callable from other tools through
 * `ctx.executeTool()`, as the `codemode` tool does.
 *
 * - `direct`: declared to the model while active, and callable while active.
 * - `model-only`: declared to the model while active, never callable. Use it for orchestrating or
 *   interactive tools.
 * - `codemode`: callable whenever registered. Not declared to the model unless explicitly
 *   activated. Codemode tools list it in their description.
 * - `deferred`: like `codemode`, but codemode tools do not list it; tool search can find it.
 * - `hidden`: registered but unreachable. Activating it has no effect.
 *
 * `direct` and `model-only` tools are activated when they are registered; the others are not.
 * The active tool set (`getActiveTools`/`setActiveTools`) is the set declared to the model.
 */
// 五种可达性联合：direct 激活时声明且可嵌套，model-only 激活时只声明，codemode/deferred 已注册即可嵌套但默认不声明，hidden 不可达。direct/model-only 也可用 defaultActive:false 禁止默认激活。
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

/**
 * Hints about what a tool does, with the meaning of MCP tool annotations. They come from the tool's
 * author and are not verified; permission extensions can use them to decide which calls to confirm.
 */
// 作者提供的行为提示，仅元数据，不由框架验证；权限扩展可参考但不应把它当成执行隔离保证。
export interface ToolAnnotations {
	/** The tool does not modify its environment. */
	// 声明工具不改变环境；true 本身不会阻止工具写文件。
	readOnlyHint?: boolean;
	/** The tool may delete or overwrite data, rather than only add to it. Meaningful when not read-only. */
	// 声明可能删除/覆盖数据，在非只读工具上有意义。
	destructiveHint?: boolean;
	/** Repeating a call with the same arguments has no further effect. Meaningful when not read-only. */
	// 声明相同参数重复执行无额外影响；不会自动去重调用。
	idempotentHint?: boolean;
	/** The tool reaches an open world of external entities, such as the web, rather than a closed domain. */
	// 声明可访问开放外部世界，例如网络；不是网络开关。
	openWorldHint?: boolean;
}

/** A group of related tools, such as the tools of one MCP server. Codemode tools list them together. */
// 一组相关工具的命名空间元数据，例如某 MCP 服务，供 codemode 分组和查找。
export interface ToolNamespace {
	/** For example `mcp__docs`. */
	// 规范名称，例如 mcp__docs。
	name: string;
	/**
	 * Other names that refer to the namespace where tools look it up by name (codemode's
	 * `describeNamespace()` and the `namespace` option of `searchTools()`), for example `docs`.
	 */
	// 其他查找别名；readonly 限制通过此类型修改数组。
	aliases?: readonly string[];
	/** Short summary shown once with the group in model-facing tool listings. */
	// 模型工具列表中展示一次的分组短说明。
	description?: string;
	/**
	 * Longer usage guidance, such as MCP server instructions. Not part of tool listings; tools that
	 * describe the namespace on request (codemode's `describeNamespace()`) return it.
	 */
	// 按需描述命名空间时返回的长说明，不自动塞入每个工具声明。
	instructions?: string;
}

/** The tools of a session as {@link ToolDefinition.prepareLoadout} sees them. */
// 工具编排器准备展示布局时看到的三套集合，描述模型可见、程序可调用和全部已注册的区别。
export interface ToolLoadout {
	/** Tools declared to the model (the active tools), in order, with their original descriptions. */
	// 按顺序直接声明给模型的 active 工具及原始说明。
	readonly declared: readonly AgentTool[];
	/** Tools callable through `ctx.executeTool()`. */
	// 可通过 ctx.executeTool 嵌套调用的集合，和 declared 不一定相同。
	readonly callable: readonly AgentTool[];
	/** Every registered tool. */
	// 所有已注册工具，包括隐藏或未激活项。
	readonly registered: readonly AgentTool[];
	// 输入工具名读取 exposure；正常会话实现未找到定义或没写 exposure 都返回 direct，这不是保证该名字实际已注册可调用。
	getExposure(name: string): ToolExposure;
	// 输入工具名读取所属命名空间，没有则 undefined。
	getNamespace(name: string): ToolNamespace | undefined;
	/** A tool's `promptGuidelines`. Hidden declarations leave them out of the system prompt. */
	// 读取工具的提示规则数组；隐藏声明不会贡献给默认系统提示。
	getPromptGuidelines(name: string): readonly string[];
}

/** Changes {@link ToolDefinition.prepareLoadout} makes to what the model sees. */
// prepareLoadout 的可选展示调整，只改变给模型看的布局，不在这里执行工具。
export interface ToolLoadoutChanges {
	/** Model-facing descriptions of declared tools, by tool name. */
	// 按工具名覆写模型可见说明；Readonly<Record<...>> 在编译期限制字典写入。
	descriptions?: Readonly<Record<string, string>>;
	/**
	 * Declared tools whose declarations requests leave out. They stay active and callable, and the
	 * transcript still declares them, so the active set survives `/tree` and resume.
	 */
	// 从实际请求声明里隐藏的工具名；仍保留 active 状态和 transcript 声明，以便会话导航/恢复。
	hiddenDeclarations?: readonly string[];
}

/**
 * Tool definition for registerTool().
 */
// 完整工具定义；TParams 受 TSchema 约束，TDetails 描述结果详情，TState 描述渲染状态。泛型只帮助开发，不自动校验输入或输出。
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** Tool name (used in LLM tool calls) */
	// 模型调用使用的工具名称；同一扩展 Map 同名注册会替换，跨扩展 runner 默认先加载者胜出。
	name: string;
	/** Human-readable label for UI */
	// 给人看的界面标签，可不同于程序调用名。
	label: string;
	/** Description for LLM */
	// 模型阅读的工具用途说明，写清什么时候使用。
	description: string;
	/** Optional one-line snippet for the Available tools section in the default system prompt. Custom tools are omitted from that section when this is not provided. */
	// 默认系统提示工具列表的一行说明；自定义工具未提供时不进入那一节。
	promptSnippet?: string;
	/** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
	// 工具激活且声明可见时追加的使用规则。
	promptGuidelines?: string[];
	/** Parameter schema (TypeBox) */
	// TypeBox 参数 schema；Static<TParams> 推导类型，真正参数校验在工具执行链。
	parameters: TParams;
	/** Optional provider-side constrained sampling request for this tool. Set false to explicitly disable it, equivalent to leaving it undefined. */
	// 可选供应商约束采样请求；false 明确关闭，与未设置相同，不保证所有供应商都支持。
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
	// default 使用标准彩色外框，self 表示渲染器自己绘制框及留白。
	renderShell?: "default" | "self";

	/** Optional compatibility shim to prepare raw tool call arguments before schema validation. Must return an object conforming to TParams. */
	// 校验前兼容转换：输入 unknown 原参数，返回推导的参数对象，随后仍走 schema 校验。例：把旧参数别名变成新字段；此声明不会立即调用转换器。
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * JSON Schema of `structuredContent` in successful results. Tools that declare it should always
	 * set `structuredContent`; codemode scripts then receive it instead of the text content.
	 */
	// 结构化输出的 JSON schema 声明；包装层传递元数据，不等于自动按它验证输出。codemode 在声明了它且结果带 structuredContent 时优先返回结构数据（携带结构数据的错误结果也如此）。
	outputSchema?: TSchema;

	/**
	 * How the model reaches the tool. Default: `"direct"`. See {@link ToolExposure}.
	 */
	// 可达性选项，缺省 direct；影响模型声明与嵌套调用集合，详细规则见 ToolExposure。
	exposure?: ToolExposure;

	/** Group the tool belongs to, for example its MCP server. */
	// 所属工具分组，例如 MCP 服务。
	namespace?: ToolNamespace;

	/**
	 * For tools that reach other tools (such as `codemode`, which calls them, and `tool_search`, which
	 * loads them): which tools a call with `input` may reach. `"all"`, or the words of the input that
	 * may name them, where a word refers to a tool or namespace whose name it contains, so words may
	 * over-match. Extensions that register tools late, such as MCP servers that are still connecting,
	 * use it from their `tool_call` handler to finish registering those tools before the call runs.
	 */
	// 输入已知参数对象，返回可能触及工具/命名空间的词列表或 "all"；用于晚注册工具准备，词可过度匹配，不是精确调用审计或权限保证。
	reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[];

	/** Hints about what the tool does, for example from an MCP server. */
	// 作者行为提示，框架不会自动验证其真实性。
	annotations?: ToolAnnotations;

	/**
	 * Whether registering the tool activates it. Default: `true` for `direct` and `model-only` tools;
	 * other exposures are never activated on registration. A tool with `defaultActive: false` is
	 * activated by naming it in `--tools` or the `defaultTools` setting, or with `setActiveTools()`.
	 */
	// 是否随注册默认激活；仅 direct/model-only 默认 true，其他 exposure 注册时不激活。显式 false 可等用户选择工具后再激活。
	defaultActive?: boolean;

	/**
	 * Adjust how the loadout is presented to the model while this tool is active. Called whenever
	 * the active tools change. Tools that orchestrate other tools use it, for example to list the
	 * callable tools in their own description.
	 */
	// 工具激活时根据完整 loadout 返回描述/隐藏声明调整；活跃工具改变会重算。例：codemode 在自身说明列出可调用工具；undefined 表示无展示调整。
	prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;

	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	// 单工具并发策略覆盖，未设置沿用 Agent 默认；声明 parallel 不代表调用必定并发，仍由调度和其他工具策略决定。
	executionMode?: ToolExecutionMode;

	/** Execute the tool. */
	// 执行回调：标准管线传入经过初次校验和前置钩子的参数，钩子改参数后不会再校验；直接调用 execute 本身不附加校验。回调完成业务并返回 Promise 结果，可报告进度/响应取消/调用其他工具，例如读取文件返回 text+details；错误由执行链处理。
	execute(
		// 本次调用 ID，用于关联事件/嵌套调用。
		toolCallId: string,
		// 从 schema 推导的参数类型；编译期类型不取代运行时入参校验。
		params: Static<TParams>,
		// 可能没有取消信号；工具需要主动监听/传递它，类型本身不会中断 I/O。
		signal: AbortSignal | undefined,
		// 可选流式结果回调，详情类型跟 TDetails 保持一致。
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		// 会话工具上下文，提供 cwd/UI/嵌套执行等能力；无上下文工厂的直接包装调用不会自动得到真实会话能力。
		ctx: ExtensionToolContext,
		// 返回最终可见内容、详情及可选结构化结果等；此 Promise 的兑现不代表模型已经读取结果。
	): Promise<AgentToolResult<TDetails>>;

	/** Custom rendering for tool call display */
	// 可选调用展示回调：输入参数、主题、渲染状态，返回组件；展示可能在参数尚不完整时发生，应结合 context.argsComplete 使用，不执行工具。
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** Custom rendering for tool result display */
	// 可选结果展示回调：把部分/最终结果变为 UI 组件，业务输出仍由 execute 决定。
	renderResult?: (
		// 结果数据，details 使用 TDetails。
		result: AgentToolResult<TDetails>,
		// 展开及部分结果标记。
		options: ToolRenderResultOptions,
		// 当前主题。
		theme: Theme,
		// 本次工具共享的渲染上下文。
		context: ToolRenderContext<TState, Static<TParams>>,
		// 返回可绘制组件，没有在此启动渲染。
	) => Component;
}

// 内部把三种泛型都放宽为 any，便于收集不同参数/详情/状态的工具；这只是编译期兼容，不表示做了额外验证。
type AnyToolDefinition = ToolDefinition<any, any, any>;

// Pick 仅挑出外框/调用/结果三项渲染能力，形成解析器返回类型。
export type ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">;

/**
 * Chooses how calls to a tool are drawn, including tools that are not registered. `next()` returns
 * the renderers the remaining resolvers, then the registered tool, would use.
 */
// 工具渲染解析器签名：接收工具名及 next，返回自定义渲染器或 undefined；例如只接管特定工具，其他调用 next()。调用链由宿主建立。
export type ToolRendererResolver = (
	// 当前需要绘制的工具名，可能尚未注册。
	toolName: string,
	// 继续查询余下解析器及已注册工具的惰性回调，不调用就不会自动运行后续链。
	next: () => ToolRenderers | undefined,
	// 返回渲染器对象或无结果；不是 execute 实现。
) => ToolRenderers | undefined;

/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Use this when assigning a tool to a variable or passing it through arrays such
 * as `customTools`, where contextual typing would otherwise widen params to
 * `unknown`.
 */
// 保持独立工具对象的参数推导，输入工具定义并原样返回，不注册、不校验、不运行。
// 例如 const read = defineTool({ parameters: Type.Object(...), execute: ... }) 让 params 保持 schema 推导类型；extends 限制 schema 泛型，默认详情 unknown。
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	// 接收同一组三个泛型的工具对象。
	tool: ToolDefinition<TParams, TDetails, TState>,
	// 返回交叉类型：既保留具体泛型，又满足内部宽泛工具收集类型。
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	// 运行时仅返回原引用；as 断言在编译后消失，没有克隆或结构检查。
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// Startup/Resource Events
// ============================================================================

// 信任阶段事件，只含工作目录，供加载项目资源前决定是否允许项目本地能力。
export interface ProjectTrustEvent {
	// 字面量 type 是判别字段。
	type: "project_trust";
	// 待决定信任的项目目录。
	cwd: string;
}

// 信任决策只有允许、拒绝、尚未决定三值；runner 首个非 undecided 的返回生效。
export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

// 信任处理结果，描述本轮决定及是否要求记住。
export interface ProjectTrustEventResult {
	// 决策值；TypeScript 限定允许字符串，runner 的断言并不额外完整验证结构。
	trusted: ProjectTrustEventDecision;
	// 可选持久记住选择标志，是否写信任存储由信任流程决定。
	remember?: boolean;
}

// 信任决策专用上下文，此时普通会话能力未必已绑定，因此只暴露小范围 UI/目录/模式。
export interface ProjectTrustContext {
	// 待信任工作目录。
	cwd: string;
	// 当前输出模式。
	mode: ExtensionMode;
	// 是否提供实际 UI，不是对每项 UI 方法的能力测试。
	hasUI: boolean;
	// Pick 仅提供选择、确认、输入和通知，不能直接使用自定义终端组件等完整 UI。
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

// 信任处理器可同步或异步返回决定；例如非交互模式返回 undecided 让其他处理器决定，不在声明时弹窗。
export type ProjectTrustHandler = (
	// 信任事件输入。
	event: ProjectTrustEvent,
	// 受限的信任上下文。
	ctx: ProjectTrustContext,
	// 返回结果或 Promise；与普通 ExtensionHandler 不同，这里要求有决定对象。
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

/** Fired after session_start to allow extensions to provide additional resource paths. */
// 资源发现事件，通常 session_start 后让扩展提供额外文件路径，不在此读取正文。
export interface ResourcesDiscoverEvent {
	// 事件判别字段。
	type: "resources_discover";
	// 本轮发现工作目录。
	cwd: string;
	// 启动发现或重载发现原因。
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
// 资源发现结果，各列表可独立省略；runner 汇总并标记来源，不在该层校验文件存在。
export interface ResourcesDiscoverResult {
	// 额外技能路径。
	skillPaths?: string[];
	// 额外提示模板路径。
	promptPaths?: string[];
	// 额外主题路径。
	themePaths?: string[];
}

/**
 * Fired when an extension registers or unregisters an MCP server after the extensions are bound
 * (see {@link ExtensionAPI.registerMcpServer}). Servers registered while extensions load are read
 * with `pi.getMcpServers()` on `session_start`. Handling this event marks an extension as the one
 * that connects registered servers.
 */
// 绑定之后 MCP 注册表变化的通知；加载期间记录由 session_start 时读取，不保证声明订阅就一定连接成功。
export interface McpServersChangeEvent {
	// 事件判别字段。
	type: "mcp_servers_change";
	/** Every registered server after the change. */
	// 变更后的全部扩展注册服务器视图，实际 MCP 配置文件合并/连接由接管扩展完成。
	servers: RegisteredMcpServer[];
}

// ============================================================================
// Session Events
// ============================================================================

/** Fired when a session is started, loaded, or reloaded */
// 会话启动、恢复、分叉或重载后的通知；没有可取消的返回值。
export interface SessionStartEvent {
	// 事件判别字段。
	type: "session_start";
	/** Why this session start happened. */
	// 为何启动，区分进程启动/重载/新建/恢复/分叉。
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** Previously active session file. Present for "new", "resume", and "fork". */
	// 会话替换时的原文件，可省略；初始启动/重载通常没有。
	previousSessionFile?: string;
}

/** Fired when the current session metadata changes. */
// 会话元信息变化通知，目前携带规范化名称。
export interface SessionInfoChangedEvent {
	// 事件判别字段。
	type: "session_info_changed";
	/** Current normalized session name. Undefined when the name is cleared. */
	// 当前名字，undefined 表示清除了名字，不是字符串 "undefined"。
	name: string | undefined;
}

/** Fired before switching to another session (can be cancelled) */
// 切换/新建之前的可取消事件；取消结果由 SessionBeforeSwitchResult 描述。
export interface SessionBeforeSwitchEvent {
	// 事件判别字段。
	type: "session_before_switch";
	// new 是新建，resume 是恢复已有会话。
	reason: "new" | "resume";
	// 恢复时的目标文件，新建未必有文件路径。
	targetSessionFile?: string;
}

/** Fired before forking a session (can be cancelled) */
// 分叉之前的可取消事件，指定原树位置。
export interface SessionBeforeForkEvent {
	// 事件判别字段。
	type: "session_before_fork";
	// 作为分叉锚点的条目 ID。
	entryId: string;
	// before 不含该条目，at 包含该条目。
	position: "before" | "at";
}

/** Fired before context compaction (can be cancelled or customized) */
// 开始压缩前让扩展取消或提供替代摘要；材料含准备结果/分支日志，实际追加由会话层执行。
export interface SessionBeforeCompactEvent {
	// 事件判别字段。
	type: "session_before_compact";
	// 内置压缩准备出的保留区间、需总结材料等。
	preparation: CompactionPreparation;
	// 当前分支原始条目，便于自定义摘要；不要把它等同于已投影模型消息。
	branchEntries: SessionEntry[];
	// 调用方给摘要的附加要求。
	customInstructions?: string;
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	// 手动、阈值预防或超长恢复触发原因。
	reason: "manual" | "threshold" | "overflow";
	/** True when the aborted turn is retried after this compaction (overflow recovery) */
	// 本次是否属于压缩后重试原中断轮次的溢出恢复路径，不保证重试最终成功。
	willRetry: boolean;
	// 压缩操作取消信号，自定义处理器应主动响应。
	signal: AbortSignal;
}

/** Fired after context compaction succeeds */
// 压缩成功追加后的通知；历史日志保留，模型后续上下文按压缩投影构造。
export interface SessionCompactEvent {
	// 事件判别字段。
	type: "session_compact";
	// 已追加的摘要/保留起点条目。
	compactionEntry: CompactionEntry;
	// 摘要是否由扩展提供。
	fromExtension: boolean;
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	// 压缩的触发原因。
	reason: "manual" | "threshold" | "overflow";
	/** True when the aborted turn is retried after this compaction (overflow recovery) */
	// 是否处于溢出恢复后重试路径。
	willRetry: boolean;
}

/** Fired after context compaction fails or is aborted */
// 压缩失败/中止后的通知，区分错误文本与取消状态。
export interface SessionCompactFailedEvent {
	// 事件判别字段。
	type: "session_compact_failed";
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	// 本次尝试的触发原因。
	reason: "manual" | "threshold" | "overflow";
	/** Error text when compaction failed for a non-abort reason. */
	// 非取消失败时的错误描述，可缺省。
	errorMessage?: string;
	/** True when compaction was cancelled or aborted. */
	// 是否取消/中止，不代表旧会话历史已经删除。
	aborted: boolean;
	/** True when the aborted turn would have been retried after this compaction (overflow recovery) */
	// 原计划成功后是否要重试，失败事件中的 true 不表示重试已经发生。
	willRetry: boolean;
	/** True when the failing compaction content came from a session_before_compact handler. */
	// 失败内容是否来自扩展提供的压缩结果。
	fromExtension: boolean;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
// 扩展运行时退出、重载或会话替换前的生命周期通知，供扩展清理自己的资源。
export interface SessionShutdownEvent {
	// 事件判别字段。
	type: "session_shutdown";
	// 退出/重载/新建/恢复/分叉原因。
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** Destination session file when shutting down due to session replacement. */
	// 会话替换的目标文件；其他关闭原因可没有。
	targetSessionFile?: string;
}

/** Preparation data for tree navigation */
// 树导航准备材料，摘要针对离开分支的指定条目，而非任意整仓库内容。
export interface TreePreparation {
	// 导航目标条目 ID。
	targetId: string;
	// 原活动叶节点，空会话可能 null。
	oldLeafId: string | null;
	// 原路径与目标路径的共同祖先，没有则 null。
	commonAncestorId: string | null;
	// 本次计划总结的离开分支条目。
	entriesToSummarize: SessionEntry[];
	// 用户是否要求生成分支摘要。
	userWantsSummary: boolean;
	/** Custom instructions for summarization */
	// 摘要附加要求。
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	// true 用自定义要求替换默认摘要指示，否则追加。
	replaceInstructions?: boolean;
	/** Label to attach to the branch summary entry */
	// 附在分支摘要条目上的导航标签。
	label?: string;
}

/** Fired before navigating in the session tree (can be cancelled) */
// 树导航前事件，扩展可取消或提供摘要/指示覆盖。
export interface SessionBeforeTreeEvent {
	// 事件判别字段。
	type: "session_before_tree";
	// 共享的导航准备材料。
	preparation: TreePreparation;
	// 该次导航/摘要取消信号。
	signal: AbortSignal;
}

/** Fired after navigating in the session tree */
// 树导航完成后通知。
export interface SessionTreeEvent {
	// 事件判别字段。
	type: "session_tree";
	// 新的叶节点 ID，可能为空树。
	newLeafId: string | null;
	// 导航前叶节点 ID。
	oldLeafId: string | null;
	// 本次实际生成的分支摘要，可不存在。
	summaryEntry?: BranchSummaryEntry;
	// 摘要是否由扩展提供，可省略。
	fromExtension?: boolean;
}

// 把所有会话生命周期事件组成联合；根据 type 可在编译期缩小到具体事件，联合本身不执行派发。
export type SessionEvent =
	// 会话启动/恢复通知分支。
	| SessionStartEvent
	// 会话名称变化分支。
	| SessionInfoChangedEvent
	// 切换前可取消分支。
	| SessionBeforeSwitchEvent
	// 分叉前可取消分支。
	| SessionBeforeForkEvent
	// 压缩前分支。
	| SessionBeforeCompactEvent
	// 压缩成功分支。
	| SessionCompactEvent
	// 压缩失败/中止分支。
	| SessionCompactFailedEvent
	// 运行时关闭分支。
	| SessionShutdownEvent
	// 树导航前分支。
	| SessionBeforeTreeEvent
	// 树导航成功分支。
	| SessionTreeEvent;

// ============================================================================
// Agent Events
// ============================================================================

/**
 * Fired before each LLM call. Can modify messages.
 *
 * `messages` holds the conversation without system messages. The prompt and tool state
 * belong to Pi: it restores them after the handler returns, so a handler cannot drop
 * them and does not need to preserve them.
 */
// 第一阶段上下文钩子，只给处理器非 system 消息；runner 隐藏并恢复系统状态，处理器仍可改消息内容或返回新列表。
export interface ContextEvent {
	// 阶段判别字段。
	type: "context";
	// 本次可见会话列表，可原地增删或通过 ContextEventResult 替换；系统消息另行恢复。
	messages: AgentMessage[];
}

/**
 * Fired before each LLM call, after every `context` handler has run and Pi has restored
 * the prompt and tool state. `messages` is the full transcript including system messages,
 * and the result is sent as returned: the handler owns the prompt and tool declarations.
 */
// 第二阶段能看到完整 system/会话列表，处理结果直接继续请求链；删掉开头 system 只报告扩展错误，不自动恢复。
export interface ContextWithSystemEvent {
	// 完整上下文阶段判别字段。
	type: "context_with_system";
	// 完整可修改消息数组，处理器承担保留提示/工具状态的责任。
	messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
// 供应商专用请求负载钩子，发生在协议适配后、发送前，允许返回任意替代负载。
export interface BeforeProviderRequestEvent {
	// 请求负载阶段判别字段。
	type: "before_provider_request";
	// 协议各异所以用 unknown；扩展在读取字段前应按自己支持的供应商结构处理。
	payload: unknown;
}

/**
 * Fired after request headers are assembled, before the provider HTTP call.
 * Handlers mutate `headers` in place (e.g. to inject tracing/session headers);
 * the return value is ignored. A `null` value deletes that header.
 */
// 最终请求头组装后的可变对象；处理器原地改，返回值无效。
export interface BeforeProviderHeadersEvent {
	// 请求头阶段判别字段。
	type: "before_provider_headers";
	// 字典值为 string 或 null，null 删除同名头；不是把 null 当字符串发送。
	headers: ProviderHeaders;
}

/** Fired after a provider response is received and before the response stream is consumed. */
// 收到供应商 HTTP 响应、尚未消费响应体时的通知，不表示模型内容已解析完。
export interface AfterProviderResponseEvent {
	// 响应阶段判别字段。
	type: "after_provider_response";
	// HTTP 状态码，不在本接口限制是否 2xx。
	status: number;
	// 响应头字符串字典，不含请求头的 null 删除标记。
	headers: Record<string, string>;
}

/** Fired for a parsed provider stream event before Pi normalizes it. */
// 协议适配器解析流事件后、标准化前的观察事件；data 仍是供应商原生结构，应按只读使用。
export interface ProviderStreamEvent {
	// 供应商流观察阶段判别字段。
	type: "provider_stream_event";
	// 实际请求的供应商标识。
	provider: ProviderId;
	// 实际聊天 API 类型。
	api: Api;
	// 实际模型 ID。
	model: string;
	// 协议事件数据 unknown，读取前需结合 provider/api 理解其形状；此类型不验证数据。
	data: unknown;
}

// 两种启动触发共享的字段，后续通过 messageType 区分用户消息与自定义消息。
interface BeforeAgentStartEventBase {
	// 启动前事件判别字段。
	type: "before_agent_start";
	/** The current system prompt, rendered from systemPromptOptions and earlier handler changes. */
	// 只读惰性系统提示，读取时从最新 options 渲染；readonly 限制赋值，修改应写下面 options 或返回覆盖。
	readonly systemPrompt: string;
	/** Mutable prompt sections. Later handlers observe mutations made by earlier handlers. */
	// 本轮共享可变提示选项，后处理器看到前处理器改动；失败不会自动回滚已写字段。
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/** A run started by a submitted prompt, RPC prompt, or `pi.sendUserMessage()`. */
// 用户输入启动的一轮，继承共同系统提示字段；不是所有排队消息都单独触发完整新启动。
export interface BeforeAgentStartUserEvent extends BeforeAgentStartEventBase {
	// messageType 的字面量用于区分触发源。
	messageType: "user";
	/** The raw user prompt text (after expansion). */
	// 展开后的用户文字，例如技能/提示模板已在输入链处理。
	prompt: string;
	/** Images attached to the user prompt, if any. */
	// 可选附图。
	images?: ImageContent[];
}

/** A run started by `pi.sendMessage(..., { triggerTurn: true })` while idle. */
// 空闲时带 triggerTurn 的自定义消息触发启动，与普通用户输入事件形状不同。
export interface BeforeAgentStartCustomEvent extends BeforeAgentStartEventBase {
	// 自定义消息触发的判别值。
	messageType: "custom";
	/** The custom message that starts the run. */
	// 启动这一轮的完整自定义消息。
	message: CustomMessage;
}

/** Fired before a run starts from a user message or an idle custom message with `triggerTurn`. */
// 两种启动事件的联合，检查 messageType 后才能安全访问 prompt 或 message。
export type BeforeAgentStartEvent = BeforeAgentStartUserEvent | BeforeAgentStartCustomEvent;

/** Fired when an agent loop starts */
// 底层 Agent 循环开始通知，没有可改写字段。
export interface AgentStartEvent {
	// 事件判别字段。
	type: "agent_start";
}

/** Fired when an agent loop ends */
// 底层 Agent 循环结束通知，之后会话层仍可能自动重试、压缩或继续队列；不等同于 agent_settled。
export interface AgentEndEvent {
	// 事件判别字段。
	type: "agent_end";
	// 本次底层循环产生的消息列表。
	messages: AgentMessage[];
}

// 边界对应的活动结果：正常完成、取消或错误；字符串联合仅作类型约束。
export type AgentActivityOutcome = "completed" | "aborted" | "error";

// 待追加自定义状态草稿，还没有持久化条目 ID/父节点/时间等。
export interface CustomEntryDraft {
	// 草稿类别，用来挑选追加方法。
	type: "custom";
	// 扩展自行约定的数据类别。
	customType: string;
	// 任意可选状态数据，unknown 提醒读取方需要知道其约定。
	data?: unknown;
}

// 待追加自定义消息草稿，参与会话展示/模型上下文的方式由 CustomMessage 规则决定。
export interface CustomMessageEntryDraft {
	// 自定义消息草稿判别字段。
	type: "custom_message";
	// 消息的扩展类别。
	customType: string;
	// 正文可为纯文字或文字/图片块数组。
	content: string | (TextContent | ImageContent)[];
	// 是否在交互会话中展示；false 不等于不送模型。
	display: boolean;
	// 扩展专用可选详情。
	details?: unknown;
}

// 待追加上下文编辑草稿，修改后续模型投影，不物理删除旧日志。
export interface ContextEditEntryDraft {
	// 上下文编辑判别字段。
	type: "context_edit";
	// 要替换投影内容的既有条目 ID。
	targetId: string;
	// 索引访问类型沿用 ContextEditEntry 的 replacement 契约，避免两处定义不一致。
	replacement: ContextEditEntry["replacement"];
}

// 待追加压缩草稿，用摘要与保留起点改变后续上下文投影。
export interface CompactionEntryDraft {
	// 压缩草稿判别字段。
	type: "compaction";
	// 提供给后续模型上下文的摘要文本。
	summary: string;
	/** Null creates a self-retaining compaction that keeps no preceding entries. */
	// null 表示不保留其前面条目，自身构成可保留压缩；字符串指定保留起点，不会删除磁盘日志。
	firstKeptEntryId: string | null;
	// 摘要附带的扩展元数据。
	details?: unknown;
	// 生成摘要消耗的可选模型用量。
	usage?: Usage;
}

// 边界可追加草稿联合，允许状态、自定义消息、上下文替换和压缩四类，运行时预览还需检查引用等约束。
export type SessionBoundaryDraft =
	// 扩展状态草稿分支。
	| CustomEntryDraft
	// 自定义消息草稿分支。
	| CustomMessageEntryDraft
	// 上下文编辑草稿分支。
	| ContextEditEntryDraft
	// 压缩草稿分支。
	| CompactionEntryDraft;

// 假设追加当前边界草稿后得到的上下文预览；预览不等于已持久化或发起请求。
export interface BoundaryContextPreview {
	// 应用上下文编辑/压缩后的条目投影。
	contextEntries: ProjectedSessionEntry[];
	// 从投影构造的 Agent 消息。
	contextMessages: AgentMessage[];
	// 转换成模型可识别的消息列表。
	llmMessages: Message[];
	// 本次边界看到的待续队列消息；普通会话优先看下一批 steering，否则 followUp，并非两队列全量合并。
	pendingMessages: AgentMessage[];
	// 根据活动状态/模型/预览等计算是否可以继续；并非请求一定成功的保证。
	canContinue: boolean;
}

// turn_end/agent_before_settle 共用状态，runner 在每个 handler 后重建预览。
export interface BoundaryState {
	// 当前累计待追加草稿，处理器返回新 entries 会整体替换该列表。
	entries: SessionBoundaryDraft[];
	// 当前是否要求保证下一次请求；后续处理器可显式 false 撤销前面的要求，仍受 canContinue/取消等约束。
	continue: boolean;
	// 对当前草稿重算的上下文预览。
	context: BoundaryContextPreview;
	// 这次活动完成、取消或错误的分类。
	outcome: AgentActivityOutcome;
}

// 边界 handler 的可选覆盖结果，字段省略表示保留之前值；不是把每个 entries 数组自动串接。
export interface BoundaryResult {
	// 替换本次边界全部草稿；空数组可清空前一个处理器的草稿。
	entries?: SessionBoundaryDraft[];
	// 覆盖继续意图，false 也明确生效。
	continue?: boolean;
}

/** Fired before final settlement. May append entries and ensure one next provider request. */
// 最终收尾前边界，扩展可追加条目并请求一次继续；无效条目预览会报错，最终无效时 runner 放弃该边界草稿/继续。
export interface AgentBeforeSettleEvent extends BoundaryState {
	// 收尾前判别字段。
	type: "agent_before_settle";
}

/** Fired after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run. */
// 会话层真正稳定后通知，此时没有计划中的自动重试/压缩/队列续跑；之后新外部输入仍可开启新活动。
export interface AgentSettledEvent {
	// 稳定结束判别字段。
	type: "agent_settled";
	/** Whether the run ended because it was aborted, for example with Escape. */
	// 该次运行是否因取消结束，例如 Escape。
	aborted: boolean;
}

// 会阻塞等待用户的扩展 UI 种类，供开始/结束通知标记。
export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** Fired when Pi starts waiting on a blocking user-facing extension UI prompt. */
// 开始等待阻塞式扩展 UI 的通知；runner 对嵌套等待只在最外层发成对通知。
export interface UIPromptStartEvent {
	// 开始等待判别字段。
	type: "ui_prompt_start";
	// 固定原因值，便于状态观察者分类。
	reason: "ui_prompt";
	// 所等待的 UI 种类。
	kind: UIPromptKind;
	// 可选标题，不是用户提交结果。
	title?: string;
}

/** Fired when Pi is no longer waiting on a blocking user-facing extension UI prompt. */
// 不再等待阻塞式扩展 UI 的通知，成功、取消或异常退出均可触发结束收尾。
export interface UIPromptEndEvent {
	// 结束等待判别字段。
	type: "ui_prompt_end";
	// 固定原因值。
	reason: "ui_prompt";
	// 与最外层等待对应的 UI 类别。
	kind: UIPromptKind;
	// 可选标题。
	title?: string;
}

/** Fired at the start of each turn */
// 每个 Agent turn 开始通知；一次活动可能因为工具调用有多个 turn。
export interface TurnStartEvent {
	// turn 开始判别字段。
	type: "turn_start";
	// 该次循环内 turn 索引。
	turnIndex: number;
	// 会话层派发此扩展事件时取 Date.now()，单位是自 Unix 纪元起的毫秒，不是模型请求耗时。
	timestamp: number;
}

/** Fired at the end of each turn */
// turn 结束事件继承边界状态，允许扩展调整投影/继续，同时保留这一轮消息及日志 ID。
export interface TurnEndEvent extends BoundaryState {
	// turn 结束判别字段。
	type: "turn_end";
	// 当前 turn 索引。
	turnIndex: number;
	// 本轮最终 Agent 消息。
	message: AgentMessage;
	// 该轮工具结果消息列表。
	toolResults: ToolResultMessage[];
	// 最终消息在会话日志中的条目 ID。
	messageEntryId: string;
	// 工具结果在会话日志中的对应条目 ID 列表。
	toolResultEntryIds: string[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
// 消息开始通知，可能是用户/助手/工具等 AgentMessage 类别。
export interface MessageStartEvent {
	// 消息开始判别字段。
	type: "message_start";
	// 刚开始的消息对象。
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
// 助手流中消息更新通知，更新粒度由适配器流事件决定，并非保证每个网络 token 一条。
export interface MessageUpdateEvent {
	// 更新事件判别字段。
	type: "message_update";
	// 截至此时的累计消息。
	message: AgentMessage;
	// 此次标准化助手增量/阶段事件。
	assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends */
// 消息完成事件，handler 可返回同 role 消息替换最终对象。
export interface MessageEndEvent {
	// 消息结束判别字段。
	type: "message_end";
	// 完成后的消息，错误/取消也可能有完成消息。
	message: AgentMessage;
}

/** Fired when a tool starts executing */
// 工具执行开始通知，仅表示执行路径开始，不表示最终成功。
export interface ToolExecutionStartEvent {
	// 执行开始判别字段。
	type: "tool_execution_start";
	// 本次调用唯一 ID。
	toolCallId: string;
	// 工具名。
	toolName: string;
	// 调用参数保留原 API 的 any，这个声明不执行校验；实际参数校验位于工具调用链。
	args: any;
	/** Set when another tool (for example a codemode script) made this call. */
	// 嵌套调用的父工具 ID，普通顶层调用省略。
	parentToolCallId?: string;
}

/** Fired during tool execution with partial/streaming output */
// 工具部分结果通知，来源于执行过程 onUpdate。
export interface ToolExecutionUpdateEvent {
	// 更新判别字段。
	type: "tool_execution_update";
	// 调用 ID，用于把多次更新合并到同一展示。
	toolCallId: string;
	// 工具名。
	toolName: string;
	// 本次参数。
	args: any;
	// 部分输出结构放宽为 any，不保证所有工具共享一个 details 类型。
	partialResult: any;
	/** Set when another tool (for example a codemode script) made this call. */
	// 嵌套时的父调用 ID。
	parentToolCallId?: string;
}

/** Fired when a tool finishes executing */
// 工具结束通知，可带错误结果及实际执行耗时。
export interface ToolExecutionEndEvent {
	// 结束判别字段。
	type: "tool_execution_end";
	// 调用 ID。
	toolCallId: string;
	// 工具名。
	toolName: string;
	// 最终结果，沿用宽泛 any 以兼容不同工具详情。
	result: any;
	// 最终结果是否错误，不能只凭收到结束事件认为成功。
	isError: boolean;
	/** Milliseconds `execute()` took, measured with a monotonic clock; absent when the tool did not run. */
	// 真正 execute 的单调时钟耗时；未执行（例如拦截/参数错误）可没有。
	durationMs?: number;
	/** Set when another tool (for example a codemode script) made this call. */
	// 嵌套父调用 ID。
	parentToolCallId?: string;
}

// ============================================================================
// Model Events
// ============================================================================

// 模型选择来源：直接设置、轮换、恢复。
export type ModelSelectSource = "set" | "cycle" | "restore";

/** Fired when a new model is selected */
// 切换当前聊天模型后的通知，不是在这里执行切换。
export interface ModelSelectEvent {
	// 模型选择判别字段。
	type: "model_select";
	// 新模型。
	model: Model<any>;
	// 原模型，首次选择可能没有。
	previousModel: Model<any> | undefined;
	// 本次选择来源。
	source: ModelSelectSource;
}

/** Fired when a new thinking level is selected */
// 思考档位改变后通知。
export interface ThinkingLevelSelectEvent {
	// 档位变化判别字段。
	type: "thinking_level_select";
	// 新档位。
	level: ThinkingLevel;
	// 旧档位。
	previousLevel: ThinkingLevel;
}

// ============================================================================
// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
// 用户 !/!! bash 输入事件，与模型调用 bash 工具是两条不同入口，可被扩展接管。
export interface UserBashEvent {
	// 用户 bash 判别字段。
	type: "user_bash";
	/** The command to execute */
	// 待执行命令文本，不在接口声明时执行。
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	// !! 请求不把结果放进模型上下文；并非阻止命令产生外部副作用。
	excludeFromContext: boolean;
	/** Current working directory */
	// 本次命令工作目录。
	cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** Source of user input */
// 输入来源联合，供 handler 区分交互输入、RPC 和扩展注入。
export type InputSource = "interactive" | "rpc" | "extension";

/** Fired when user input is received, before agent processing */
// 输入预处理事件，按序转换后才进入常规输入/模型启动链。
export interface InputEvent {
	// 输入判别字段。
	type: "input";
	/** The input text */
	// 目前累计文字，前一个 transform 可已改变它。
	text: string;
	/** Attached images, if any */
	// 当前附图；后处理器可用空数组明确清空。
	images?: ImageContent[];
	/** Where the input came from */
	// 最初的来源标记，runner 不随 transform 改它。
	source: InputSource;
	/** How the input will be delivered during streaming, or undefined when idle */
	// 忙碌时的队列方式；undefined 也可能来自调用方没有指定，最终由会话输入逻辑解释。
	streamingBehavior?: "steer" | "followUp";
}

/** Result from input event handler */
// 输入处理动作的判别联合；根据 action 选择继续、变换或已接管，字段要求随分支不同。
export type InputEventResult =
	// continue 不改变文字/图片，继续后续 handler。
	| { action: "continue" }
	// transform 要求新文字，图片省略保留、空数组清空；后续 handler 看到变换后的内容。
	| { action: "transform"; text: string; images?: ImageContent[] }
	// handled 立即结束后续输入处理，表示扩展已接手，不保证它一定调用过模型。
	| { action: "handled" };

// ============================================================================
// Tool Events
// ============================================================================

// 工具调用事件共享字段，具体工具接口再增加工具名/参数。
interface ToolCallEventBase {
	// 工具调用前判别字段。
	type: "tool_call";
	/**
	 * The call's id. For calls another tool made (with `parentToolCallId` set), pi assigns
	 * `<parent id>/<n>`; such ids never appear as tool calls or tool results in the transcript, only
	 * in the parent result's `nestedCalls` record.
	 */
	// 调用 ID，嵌套时形如 parent/1，只记录在父结果 nestedCalls，不单独加入 transcript。
	toolCallId: string;
	/** Set when another tool (for example a codemode script) issued this call. */
	// 嵌套调用父 ID。
	parentToolCallId?: string;
}

// Bash 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface BashToolCallEvent extends ToolCallEventBase {
	// 固定名称 bash，供名称匹配谓词使用。
	toolName: "bash";
	// bash 命令/超时等输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: BashToolInput;
}

// PowerShell 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface PowerShellToolCallEvent extends ToolCallEventBase {
	// 固定名称 powershell，供名称匹配谓词使用。
	toolName: "powershell";
	// PowerShell 命令输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: PowerShellToolInput;
}

// Read 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface ReadToolCallEvent extends ToolCallEventBase {
	// 固定名称 read，供名称匹配谓词使用。
	toolName: "read";
	// 文件路径/行区间输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: ReadToolInput;
}

// Edit 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface EditToolCallEvent extends ToolCallEventBase {
	// 固定名称 edit，供名称匹配谓词使用。
	toolName: "edit";
	// 路径及旧/新文本输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: EditToolInput;
}

// Write 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface WriteToolCallEvent extends ToolCallEventBase {
	// 固定名称 write，供名称匹配谓词使用。
	toolName: "write";
	// 路径及写入内容输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: WriteToolInput;
}

// Grep 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface GrepToolCallEvent extends ToolCallEventBase {
	// 固定名称 grep，供名称匹配谓词使用。
	toolName: "grep";
	// 内容搜索表达式/筛选输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: GrepToolInput;
}

// Find 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface FindToolCallEvent extends ToolCallEventBase {
	// 固定名称 find，供名称匹配谓词使用。
	toolName: "find";
	// 文件名模式/目录/限制输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: FindToolInput;
}

// Ls 调用事件继承公共调用 ID，再用固定工具名关联具体参数；这里只是类型声明。
export interface LsToolCallEvent extends ToolCallEventBase {
	// 固定名称 ls，供名称匹配谓词使用。
	toolName: "ls";
	// 目录路径/限制输入，类型来自对应内置工具 schema，不在此校验或执行。
	input: LsToolInput;
}

// 自定义工具调用分支，允许任意名称，因此其 string 与所有内置名字有重叠，普通判别不能彻底排除这个分支。
export interface CustomToolCallEvent extends ToolCallEventBase {
	// 任意自定义工具名，不在类型层禁止使用内置同名。
	toolName: string;
	// 未知参数值字典；读取某字段时还需知道该工具 schema。
	input: Record<string, unknown>;
}

/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
// 所有工具调用事件联合；参数初次校验后才发此钩子，handler 可原地修改 input，修改后不会重新 schema 校验。
export type ToolCallEvent =
	// bash 命令调用分支。
	| BashToolCallEvent
	// PowerShell 调用分支。
	| PowerShellToolCallEvent
	// read 读取文件分支。
	| ReadToolCallEvent
	// edit 文本替换分支。
	| EditToolCallEvent
	// write 写入文件分支。
	| WriteToolCallEvent
	// grep 内容搜索分支。
	| GrepToolCallEvent
	// find 文件查找分支。
	| FindToolCallEvent
	// ls 目录列举分支。
	| LsToolCallEvent
	// 自定义工具分支，其 string 名称与内置名字可重叠。
	| CustomToolCallEvent;

// 工具结果共享字段，子接口再根据工具名给 details 不同类型。
interface ToolResultEventBase {
	// 工具结果判别字段。
	type: "tool_result";
	/** The call's id; `<parent id>/<n>` for nested calls, see `ToolCallEvent`. */
	// 对应调用 ID，嵌套规则与 tool_call 相同。
	toolCallId: string;
	/** Set when another tool (for example a codemode script) issued this call. */
	// 可选父调用 ID。
	parentToolCallId?: string;
	// 执行参数字典，供结果处理器知道这份结果对应什么输入。
	input: Record<string, unknown>;
	// 模型/用户可见的文字或图片内容块。
	content: (TextContent | ImageContent)[];
	/**
	 * Machine-readable result for tools that declare an `outputSchema`. Handlers that redact
	 * `content` should also replace this; replacing `content` alone drops it.
	 */
	// 可选结构化 JSON 输出；若 handler 只替换 content 而不同时返它，runner 会丢弃旧结构，避免内容不一致或脱敏遗漏。
	structuredContent?: JsonValue;
	// 结果是否错误。
	isError: boolean;
	/** Usage from the tool execution itself, if available. */
	// 工具执行自身用量，不是这次模型请求 token 用量。
	usage?: Usage;
}

// Bash 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface BashToolResultEvent extends ToolResultEventBase {
	// 固定工具名 bash。
	toolName: "bash";
	// Bash 专用详情或 undefined；名字相同本身不在运行时证明详情结构正确。
	details: BashToolDetails | undefined;
}

// PowerShell 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface PowerShellToolResultEvent extends ToolResultEventBase {
	// 固定工具名 powershell。
	toolName: "powershell";
	// PowerShell 专用详情或 undefined；名字相同本身不在运行时证明详情结构正确。
	details: PowerShellToolDetails | undefined;
}

// Read 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface ReadToolResultEvent extends ToolResultEventBase {
	// 固定工具名 read。
	toolName: "read";
	// Read 专用详情或 undefined；名字相同本身不在运行时证明详情结构正确。
	details: ReadToolDetails | undefined;
}

// Edit 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface EditToolResultEvent extends ToolResultEventBase {
	// 固定工具名 edit。
	toolName: "edit";
	// Edit 专用详情或 undefined；名字相同本身不在运行时证明详情结构正确。
	details: EditToolDetails | undefined;
}

// Write 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface WriteToolResultEvent extends ToolResultEventBase {
	// 固定工具名 write。
	toolName: "write";
	// write 默认不提供详情，字段类型明确为 undefined。
	details: undefined;
}

// Grep 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface GrepToolResultEvent extends ToolResultEventBase {
	// 固定工具名 grep。
	toolName: "grep";
	// Grep 专用详情或 undefined；名字相同本身不在运行时证明详情结构正确。
	details: GrepToolDetails | undefined;
}

// Find 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface FindToolResultEvent extends ToolResultEventBase {
	// 固定工具名 find。
	toolName: "find";
	// Find 专用详情或 undefined；名字相同本身不在运行时证明详情结构正确。
	details: FindToolDetails | undefined;
}

// Ls 结果事件继承内容/错误等公共字段，再指定工具名与详情类型。
export interface LsToolResultEvent extends ToolResultEventBase {
	// 固定工具名 ls。
	toolName: "ls";
	// Ls 专用详情或 undefined；名字相同本身不在运行时证明详情结构正确。
	details: LsToolDetails | undefined;
}

// 自定义工具结果，细节 unknown，需要按自定义工具约定读取。
export interface CustomToolResultEvent extends ToolResultEventBase {
	// 任意工具名，含与内置字符串重叠的可能。
	toolName: string;
	// 详情未知，框架不会只凭此接口验证其形状。
	details: unknown;
}

/** Fired after a tool executes. Can modify result. */
// 全部工具结果联合，runner 允许 handler 按字段覆盖结果；类型联合本身不派发事件。
export type ToolResultEvent =
	// bash 执行结果分支。
	| BashToolResultEvent
	// PowerShell 结果分支。
	| PowerShellToolResultEvent
	// read 读取结果分支。
	| ReadToolResultEvent
	// edit 替换结果分支。
	| EditToolResultEvent
	// write 写入结果分支。
	| WriteToolResultEvent
	// grep 搜索结果分支。
	| GrepToolResultEvent
	// find 查找结果分支。
	| FindToolResultEvent
	// ls 列举结果分支。
	| LsToolResultEvent
	// 自定义结果分支，详情为 unknown。
	| CustomToolResultEvent;

// Type guards for ToolResultEvent
// 按名字判断 bash 结果，输入 ToolResultEvent、返回 boolean 并通过 e is BashToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "bash"。
	return e.toolName === "bash";
}
// 按名字判断 powershell 结果，输入 ToolResultEvent、返回 boolean 并通过 e is PowerShellToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isPowerShellToolResult(e: ToolResultEvent): e is PowerShellToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "powershell"。
	return e.toolName === "powershell";
}
// 按名字判断 read 结果，输入 ToolResultEvent、返回 boolean 并通过 e is ReadToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "read"。
	return e.toolName === "read";
}
// 按名字判断 edit 结果，输入 ToolResultEvent、返回 boolean 并通过 e is EditToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "edit"。
	return e.toolName === "edit";
}
// 按名字判断 write 结果，输入 ToolResultEvent、返回 boolean 并通过 e is WriteToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "write"。
	return e.toolName === "write";
}
// 按名字判断 grep 结果，输入 ToolResultEvent、返回 boolean 并通过 e is GrepToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "grep"。
	return e.toolName === "grep";
}
// 按名字判断 find 结果，输入 ToolResultEvent、返回 boolean 并通过 e is FindToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "find"。
	return e.toolName === "find";
}
// 按名字判断 ls 结果，输入 ToolResultEvent、返回 boolean 并通过 e is LsToolResultEvent 缩小类型，无副作用。例：if 检查成功后能读该工具详情；只比名字，不验证详情，自定义同名也会匹配。
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	// 唯一运行时检查是 toolName 严格等于 "ls"。
	return e.toolName === "ls";
}

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
// 按名称缩小 tool_call 类型的 bash 重载；e is T 为类型谓词，运行时仅比较名字，不深验 input。例：成功后编译器允许读取 event.input.command。
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
// PowerShell 名称重载，成功后把 input 看成 PowerShell 输入；不额外验证参数。
export function isToolCallEventType(toolName: "powershell", event: ToolCallEvent): event is PowerShellToolCallEvent;
// read 名称重载，获得路径/行区间字段提示。
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
// edit 名称重载，获得旧/新文本参数类型。
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
// write 名称重载，获得路径与内容类型。
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
// grep 名称重载，获得搜索参数类型。
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
// find 名称重载，获得文件查找参数类型。
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
// ls 名称重载，获得目录列举参数类型。
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
// 自定义重载让调用者提供名称/输入类型；extends 约束名称为字符串、输入为字典，不会在运行时证实 TInput。
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	// 要匹配的工具名，保留 TName 字面量。
	toolName: TName,
	// 待缩小的事件。
	event: ToolCallEvent,
	// 成功后给事件叠加具体名字/输入类型；这是调用者承担正确性的断言式谓词契约。
): event is ToolCallEvent & { toolName: TName; input: TInput };
// 所有重载共用一个实现，输入名字和事件，返回是否同名；没有副作用/参数 schema 检查，自定义工具冒用内置名字也会同样匹配。
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	// 唯一运行时判断是严格名称相等，重载签名会在编译后擦除。
	return event.toolName === toolName;
}

/** Union of all event types */
// 扩展事件总联合，把不同 type 事件集中供 runner 泛型筛选；不意味着所有事件采用同样的合并/错误策略。
export type ExtensionEvent =
	// 项目信任决定事件分支。
	| ProjectTrustEvent
	// 额外资源发现事件分支。
	| ResourcesDiscoverEvent
	// MCP 注册表变更事件分支。
	| McpServersChangeEvent
	// 所有会话生命周期事件分支。
	| SessionEvent
	// 隐藏 system 的第一阶段上下文事件分支。
	| ContextEvent
	// 包含 system 的第二阶段上下文事件分支。
	| ContextWithSystemEvent
	// 缓存预热决定事件分支。
	| CacheWarmingDecisionEvent
	// 供应商请求负载改写事件分支。
	| BeforeProviderRequestEvent
	// 供应商请求头原地改写事件分支。
	| BeforeProviderHeadersEvent
	// 供应商响应观察事件分支。
	| AfterProviderResponseEvent
	// 原生供应商流观察事件分支。
	| ProviderStreamEvent
	// 运行开始前消息/提示调整事件分支。
	| BeforeAgentStartEvent
	// 底层 Agent 循环开始事件分支。
	| AgentStartEvent
	// 底层 Agent 循环结束事件分支。
	| AgentEndEvent
	// 最终收尾前边界事件分支。
	| AgentBeforeSettleEvent
	// 会话活动稳定结束事件分支。
	| AgentSettledEvent
	// 阻塞 UI 等待开始事件分支。
	| UIPromptStartEvent
	// 阻塞 UI 等待结束事件分支。
	| UIPromptEndEvent
	// turn 开始事件分支。
	| TurnStartEvent
	// turn 结束及边界事件分支。
	| TurnEndEvent
	// 消息开始事件分支。
	| MessageStartEvent
	// 助手消息更新事件分支。
	| MessageUpdateEvent
	// 消息完成及可选替换事件分支。
	| MessageEndEvent
	// 工具执行开始事件分支。
	| ToolExecutionStartEvent
	// 工具部分结果事件分支。
	| ToolExecutionUpdateEvent
	// 工具执行完成事件分支。
	| ToolExecutionEndEvent
	// 模型选择事件分支。
	| ModelSelectEvent
	// 思考档位选择事件分支。
	| ThinkingLevelSelectEvent
	// 用户 bash 接管事件分支。
	| UserBashEvent
	// 输入预处理事件分支。
	| InputEvent
	// 工具执行前拦截事件分支。
	| ToolCallEvent
	// 工具结果字段覆盖事件分支。
	| ToolResultEvent;

// ============================================================================
// Event Results
// ============================================================================

// 上下文 handler 可返回的新消息数组；省略 messages 表示不显式替换，原地消息修改另由 runner 处理。
export interface ContextEventResult {
	// 空数组是明确替换，不同于 undefined；context 阶段还会恢复 system，完整阶段不恢复。
	messages?: AgentMessage[];
}

// turn_end 复用边界结果，允许替换草稿/继续意图。
export type TurnEndEventResult = BoundaryResult;
// 收尾前复用相同边界结果类型，生命周期触发点不同。
export type AgentBeforeSettleEventResult = BoundaryResult;

// 供应商负载替代值可任意类型；undefined 表示不替换，类型不保证供应商最后能接受它。
export type BeforeProviderRequestEventResult = unknown;

// 把缓存预热决策事件/结果从本入口重导出，实际预热逻辑在 cache-warmer。
export type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../cache-warmer.ts";

// 工具调用前的控制结果，参数修改通过 event.input 原地完成。
export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	// true 阻止本次工具执行，runner 首个 block 真值即停止后续订阅者。
	block?: boolean;
	// 可选拦截原因，供结果/用户说明。
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	// 阻止时提示本批结束后停止 Agent；只有该批所有最终工具结果都要求终止才会提早结束，不是无条件 abort。
	terminate?: boolean;
}

/** Result from user_bash event handler */
// 用户 bash 接管二选一联合；never 字段在编译期禁止同时传两种，runner 另做最小运行时结构检查。
export type UserBashEventResult =
	// 第一分支提供执行后端，由常规 bash 执行逻辑继续管理流程。
	| {
			/** Custom operations to use for execution */
			// 自定义 exec 操作，例如转到远程环境；不是一份已完成结果。
			operations: BashOperations;
			// never 表示这一分支不能再带 result。
			result?: never;
	  }
	// 第二分支提供完整结果，表示扩展自行完成执行。
	| {
			// 此分支不允许再提供 operations。
			operations?: never;
			/** Full replacement: extension handled execution, use this result */
			// 现成 bash 结果，本地命令不会因为这个返回值再执行一次。
			result: BashResult;
	  };

/**
 * Changes a `tool_result` handler makes. Omitted fields stay as they are, except that replacing
 * `content` without returning `structuredContent` drops the structured content, because it may no
 * longer match. Return it along with `content` to keep it.
 */
// 工具结果的可选字段覆盖；多个处理器逐项累计，非 undefined 才覆盖，content 特例会连带清旧结构。
export interface ToolResultEventResult {
	// 可见内容整体替换，空数组有效。
	content?: (TextContent | ImageContent)[];
	// 详情整体替换，null 可作为明确值，undefined 保留原值。
	details?: unknown;
	// 结构输出覆盖；替换 content 时需同时带它才能保留旧结构。
	structuredContent?: JsonValue;
	// 错误标记覆盖，false 可以清除错误。
	isError?: boolean;
	// 用量对象覆盖，不会自动累加。
	usage?: Usage;
}

// 消息完成钩子的可选替代对象。
export interface MessageEndEventResult {
	/** Replace the finalized message. The replacement must keep the original message role. */
	// 必须维持原 role；runner 遇到不同 role 会报错并忽略该替代。
	message?: AgentMessage;
}

// 启动前返回值，可追加一条扩展消息并覆盖本轮完整系统提示。
export interface BeforeAgentStartEventResult {
	// Pick 限定自定义消息必要材料；多个 handler 的消息按序累计，不互相覆盖。
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** Replace the complete system prompt for this turn. Later handlers observe this exact override. */
	// 完整提示替换，空字符串也有效；后处理器的 getSystemPrompt 可看到此值。
	systemPrompt?: string;
}

// 切换前可取消结果；通用派发保存最后真值对象，遇 cancel 真值立即返回。
export interface SessionBeforeSwitchResult {
	// true 取消新建/恢复操作。
	cancel?: boolean;
}

// 分叉前结果声明，当前调用方主要读取 cancel。
export interface SessionBeforeForkResult {
	// true 取消分叉。
	cancel?: boolean;
	// 类型中保留此选项，但当前 AgentSession 分叉路径没有读取它；不要把字段存在当成已经实现跳过恢复功能。
	skipConversationRestore?: boolean;
}

// 压缩前结果，允许取消或提供整份自定义 CompactionResult。
export interface SessionBeforeCompactResult {
	// true 取消本次压缩。
	cancel?: boolean;
	// 替代内置摘要；会话层仍负责检查/追加，不是在此删除原日志。
	compaction?: CompactionResult;
}

// 树导航前结果，可取消、提供摘要或修改摘要指示/标签。
export interface SessionBeforeTreeResult {
	// true 取消导航。
	cancel?: boolean;
	// 扩展生成的分支摘要对象；提供后可跳过内置摘要生成。
	summary?: {
		// 摘要文字。
		summary: string;
		// 可选详情元数据。
		details?: unknown;
		// 生成摘要的用量。
		usage?: Usage;
	};
	/** Override custom instructions for summarization */
	// 覆盖摘要指示。
	customInstructions?: string;
	/** Override whether customInstructions replaces the default prompt */
	// 覆盖是否用自定义指示替代默认指示。
	replaceInstructions?: boolean;
	/** Override label to attach to the branch summary entry */
	// 覆盖分支摘要标签。
	label?: string;
}

// ============================================================================
// Message and Entry Rendering
// ============================================================================

// 自定义消息渲染设置，继承宿主快捷键提示能力。
export interface MessageRenderOptions extends KeybindingHints {
	// 是否展开详情。
	expanded: boolean;
	/** Horizontal padding configured by the outputPad setting. */
	// 水平留白设置，渲染器据此布局。
	outputPad: number;
}

// Markdown 转换时的展示上下文；这条链改变显示正文，不直接修改发给模型的消息。
export interface MarkdownTransformContext {
	// 待绘制的是用户、助手正文还是助手思考。
	messageType: "user" | "assistant" | "assistant-thinking";
	// 是否正在流式更新。
	isStreaming: boolean;
	// 当前可用字符宽度，供文本布局使用。
	availableWidth: number;
	/** Persisted session-entry id. Undefined for live messages or live rendering; available when rendering from persisted session entries. */
	// 持久化条目 ID，实时消息/实时展示可能没有。
	messageId?: string;
	/** Persisted session-entry ISO timestamp. Undefined for live messages or live rendering; available when rendering from persisted session entries. */
	// 持久化时间戳字符串，实时展示可没有。
	timestamp?: string;
}

// Markdown 转换器同步接收原文与显示上下文，返回替代显示文字。例：把项目链接改成终端友好形式；声明本身不读写日志。
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

// 自定义状态条目渲染选项，只有展示信息及继承快捷键方法。
export interface EntryRenderOptions extends KeybindingHints {
	// 是否展开状态条目。
	expanded: boolean;
}

// 自定义消息渲染回调，输入消息、显示选项、主题，返回组件或 undefined；例如根据 details 画状态卡。泛型 T 只约束详情读取，不执行转换/验证。
export type MessageRenderer<T = unknown> = (
	// 当前 CustomMessage，详情为 T。
	message: CustomMessage<T>,
	// 展开/留白/快捷键提示选项。
	options: MessageRenderOptions,
	// 宿主主题。
	theme: Theme,
	// 返回可绘制组件；undefined 表示没有提供自定义组件。
) => Component | undefined;

// 自定义持久状态条目渲染回调，不把条目转换为模型消息；输入 entry/选项/主题，返回组件或 undefined。
export type EntryRenderer<T = unknown> = (
	// 自定义状态条目，data 为 T。
	entry: CustomEntry<T>,
	// 展示设置。
	options: EntryRenderOptions,
	// 宿主主题。
	theme: Theme,
	// 可选组件返回值。
) => Component | undefined;

// ============================================================================
// Command Registration
// ============================================================================

// 注册后的斜杠命令记录，名字/来源由 loader 补齐，其余由扩展声明。
export interface RegisteredCommand {
	// 原命令名，不含 runner 解决重名时分配的调用后缀。
	name: string;
	// 扩展来源信息，供帮助/冲突诊断。
	sourceInfo: SourceInfo;
	// 可选命令说明。
	description?: string;
	// 参数补全回调，输入当前前缀，同步/异步返回候选或 null；注册不立即生成补全。
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	// 真正命令处理器，输入剩余参数文字及可控制会话的命令上下文，返回 Promise<void>；调用时才产生业务副作用，拒绝由命令入口处理。
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// 解析后的命令继承声明，并增加最终可输入的调用名称。
export interface ResolvedCommand extends RegisteredCommand {
	// 冲突处理后的名字，多个同名命令可得到 name:1 等后缀；不同于工具跨扩展先者胜规则。
	invocationName: string;
}

// ============================================================================
// Extension API
// ============================================================================

/** Handler function type for events */
// 通用事件处理器类型：输入事件 E 和上下文，同步或异步返回 R/void；void 允许裸 return。下面的 linter 忽略指令必须紧邻其目标，类型约束不等于运行时返回结构校验。
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * ExtensionAPI passed to extension factory functions.
 */
// 扩展工厂获得的注册/会话动作接口；注册会记录声明而非立即触发 handler，加载期很多动作尚未绑定，调用会抛错。
export interface ExtensionAPI {
	// =========================================================================
	// Event Subscription
	// =========================================================================

	// 订阅信任阶段，专用受限上下文，首个非 undecided 决定生效；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "project_trust", handler: ProjectTrustHandler): () => void;
	// 订阅 resources_discover：汇总三类额外路径，不在 runner 验文件。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "resources_discover"，使重载选择匹配的输入/结果类型。
		event: "resources_discover",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅会话启动，只通知不合并结果；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
	// 订阅会话名字变化，只通知；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): () => void;
	// 订阅 session_before_switch：遇 cancel 真值短路，否则保留最后真值返回对象。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "session_before_switch"，使重载选择匹配的输入/结果类型。
		event: "session_before_switch",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅 session_before_fork：可取消，当前会话层读取 cancel。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "session_before_fork"，使重载选择匹配的输入/结果类型。
		event: "session_before_fork",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅 session_before_compact：可取消或提供摘要，返回对象整体取最后真值而不是逐字段合并。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "session_before_compact"，使重载选择匹配的输入/结果类型。
		event: "session_before_compact",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅压缩成功，只通知；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): () => void;
	// 订阅压缩失败/中止，只通知；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): () => void;
	// 订阅运行时关闭，供清理资源；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
	// 订阅MCP 注册表变化，声明接管能力，实际连接需实现处理；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "mcp_servers_change", handler: ExtensionHandler<McpServersChangeEvent>): () => void;
	// 订阅 session_before_tree：可取消或提供摘要/指示覆盖。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "session_before_tree"，使重载选择匹配的输入/结果类型。
		event: "session_before_tree",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅树导航完成，只通知；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): () => void;
	// 订阅第一阶段上下文，隐藏/恢复 system，按返回消息数组累计；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
	// 订阅第二阶段完整上下文，处理器负责保留 system/工具状态；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>): () => void;
	// 订阅 cache_warming_decision：按定义的 action 覆盖预热决定。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "cache_warming_decision"，使重载选择匹配的输入/结果类型。
		event: "cache_warming_decision",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅 before_provider_request：非 undefined 返回替换负载，逐 handler 串接。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "before_provider_request"，使重载选择匹配的输入/结果类型。
		event: "before_provider_request",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅请求头原地修改，返回值忽略；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
	// 订阅收到 HTTP 响应后的观察，尚未消费响应体；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
	// 订阅原生供应商流观察，不是标准化消息增量；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "provider_stream_event", handler: ExtensionHandler<ProviderStreamEvent>): () => void;
	// 订阅 before_agent_start：累计消息并共享提示选项，返回提示覆盖可影响后续。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "before_agent_start"，使重载选择匹配的输入/结果类型。
		event: "before_agent_start",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅底层 Agent 循环开始；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
	// 订阅底层循环结束，之后可能还有会话续跑；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
	// 订阅 agent_before_settle：替换边界草稿/继续意图并重算预览。传入 handler、返回退订函数；登记不立即执行或发请求，处理错误规则见 runner 对应方法。
	on(
		// 事件名限定为 "agent_before_settle"，使重载选择匹配的输入/结果类型。
		event: "agent_before_settle",
		// handler 泛型把该事件与允许结果关联；可同步返回、异步返回或裸 return，不在运行时自动验证所有返回字段。
		handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>,
		// 返回无参数退订函数，用于移除这次登记的包装 handler。
	): () => void;
	// 订阅真正稳定结束，不等于底层 agent_end；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
	// 订阅最外层阻塞 UI 等待开始；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): () => void;
	// 订阅最外层阻塞 UI 等待结束；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): () => void;
	// 订阅turn 开始；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
	// 订阅turn 结束，替换边界草稿/继续意图后重算预览；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>): () => void;
	// 订阅消息开始；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
	// 订阅消息流更新；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
	// 订阅消息完成，同 role 替换逐个累计；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): () => void;
	// 订阅工具执行开始；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
	// 订阅工具部分结果；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
	// 订阅工具执行结束；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
	// 订阅当前模型切换；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): () => void;
	// 订阅思考档位变化；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): () => void;
	// 订阅工具调用，首个 block 真值中断，异常由上游接住；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
	// 订阅工具结果，非 undefined 字段逐项覆盖；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
	// 订阅用户 bash，首个合法接管结果生效，错误报告后重抛；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
	// 订阅输入，transform 串接，handled 立即中断；输入事件名/对应 handler，返回退订函数。这里只登记，事件到达才调用，例如保存 off 后可 off() 取消。
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;

	// =========================================================================
	// Tool Registration
	// =========================================================================

	/** Register a tool that the LLM can call. */
	// 注册带 schema/详情/渲染状态泛型的工具，不执行 execute。loader 只先检查 parameters 是非 null 对象且非数组（{} 也通过），完整参数验证在执行链；同一扩展同名覆盖，跨扩展 runner 先者胜。
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		// 工具定义对象，TParams 的推导贯穿 parameters 和 execute(params)。
		tool: ToolDefinition<TParams, TDetails, TState>,
		// 无返回值；动态注册会请求刷新宿主工具表，加载期刷新桩可为空操作。
	): void;

	// =========================================================================
	// Command, Shortcut, Flag Registration
	// =========================================================================

	/** Register a custom command. */
	// 注册斜杠命令，输入名称和去掉 name/sourceInfo 的配置，loader 补来源；例如注册 hello 后输入 /hello 才调用 handler。跨扩展重名由 runner 分配后缀，不在声明时执行命令。
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/** Register a keyboard shortcut. */
	// 注册终端快捷键，输入组合与回调，void 不返回解绑函数；实际冲突由 runner 结合宿主可配置绑定决定，保留键不能被覆盖。
	registerShortcut(
		// KeyId 限制快捷键书写类型。
		shortcut: KeyId,
		// 快捷键配置对象。
		options: {
			// 可选帮助说明。
			description?: string;
			// 按键真正触发时接收普通上下文，可同步或异步完成；不是可替换会话的命令上下文。
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
		// 注册签名无结果数据，注册并不触发回调。
	): void;

	/** Register a CLI flag. */
	// 声明扩展 CLI 参数，type 判别联合保证 boolean/string 默认值在编译期匹配。例：注册 debug 的 boolean 默认 false；实际 CLI 值另由解析流程写入。
	registerFlag(
		// 参数名，API 通常传不带 -- 的名字。
		name: string,
		// 配置由下面两种类型分支组成。
		options: // 布尔参数分支。
			| {
					// 帮助描述。
					description?: string;
					// 固定 boolean 判别值。
					type: "boolean";
					// 可选布尔默认值，false 仍是有效默认。
					default?: boolean;
			  }
			// 字符串参数分支。
			| {
					// 帮助描述。
					description?: string;
					// 固定 string 判别值。
					type: "string";
					// 可选字符串默认值，空字符串仍有效。
					default?: string;
			  },
		// 注册没有返回值，不在此解析进程 argv。
	): void;

	/** Get the value of a registered CLI flag. */
	// 按名读取共享标志值，可能是默认/CLI覆盖或 undefined；返回联合类型不会仅凭名字自动推导具体 boolean/string。
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Message Rendering
	// =========================================================================

	/** Register a custom renderer for CustomMessageEntry. */
	// 按 customType 注册自定义消息展示回调，T 指定详情类型；同一扩展同名 Map 更新会替换，不在注册时绘制消息。
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	/** Register a transformer for user and assistant Markdown before Pi renders it in the interactive transcript. */
	// 登记交互会话 Markdown 显示转换器；修改显示文字，不直接改模型上下文或持久化原文。
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	/** Register a custom renderer for CustomEntry. Custom entries do not participate in LLM context. */
	// 按 customType 注册自定义状态条目渲染器；条目用于持久状态，默认不进模型上下文。
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

	/** Choose how tool calls are drawn. Resolvers run in extension load order. */
	// 登记工具展示解析器链，按扩展加载顺序运行，可调用 next 查询下游；不改变工具 execute 业务。
	registerToolRenderer(resolver: ToolRendererResolver): void;

	// =========================================================================
	// Actions
	// =========================================================================

	/** Send a custom message to the session. */
	// 向当前会话注入自定义消息，调用返回 void，异步业务由宿主负责；空闲且 triggerTurn:true 才请求新一轮。与 ReplacedSessionContext 的 Promise 方法不同，不可用它等待模型回复。
	sendMessage<T = unknown>(
		// 只接受自定义类型、正文、显示和详情，其他字段由会话补齐；泛型 T 对应 details。
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		// triggerTurn 控制是否启动，deliverAs 控制繁忙时转向/跟进/下一轮；不同组合的实际规则由会话层处理。
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		// 工厂 API 此方法不返回完成 Promise。
	): void;

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 * Set expandPromptTemplates to dispatch extension commands and expand skill commands and prompt templates.
	 */
	// 以用户身份注入输入并触发输入链，返回 void；忙碌时应指定递送方式，expandPromptTemplates 可让命令/模板走完整展开路径。
	sendUserMessage(
		// 纯文本或文字/图片内容块数组。
		content: string | (TextContent | ImageContent)[],
		// 递送队列及展开开关；展开后可能先被扩展命令或 input handler 接管，并不保证每次都请求模型。
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
		// 无结果数据，真正异步错误由绑定宿主路径处理。
	): void;

	/** Append a custom entry to the session for state persistence (not sent to LLM). */
	// 追加扩展状态条目并持久化，不作为模型消息。customType 分类、可选 T 数据供以后重放恢复；实际写日志是调用动作时发生。
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// =========================================================================
	// Session Metadata
	// =========================================================================

	/** Set the session display name (shown in session selector). */
	// 设置会话展示名，交给会话层规范化/持久化并发送元信息事件；不修改工作目录或终端标题。
	setSessionName(name: string): void;

	/** Get the current session name, if set. */
	// 读取当前展示名，未命名返回 undefined。
	getSessionName(): string | undefined;

	/** Set or clear a label on an entry. Labels are user-defined markers for bookmarking/navigation. */
	// 给既有条目设置/清除标签，undefined 清除；用于书签导航，不改条目消息内容。
	setLabel(entryId: string, label: string | undefined): void;

	/** Execute a shell command. */
	// 启动指定进程 command 和参数数组，选项支持 cwd、取消 signal、超时 timeout、输出上限 maxBuffer；异步返回 stdout/stderr/code/killed/truncated。底层 shell:false 不自动解释管道/重定向，需运行 shell 时应明确指定程序与参数；非法上限会拒绝，常见进程启动错误转失败结果。
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Get the names of the active tools, which are the tools declared to the model. */
	// 返回直接声明给模型的 active 工具名，不等于全部可嵌套工具。
	getActiveTools(): string[];

	/** Get all configured tools with parameter schema, prompt guidelines, exposure, and source metadata. */
	// 读取所有配置工具的 schema、暴露方式、规则、来源等元数据，不执行工具。
	getAllTools(): ToolInfo[];

	/** Get a copy of the effective settings (global and project settings merged, with overrides). */
	// 取得合并设置的拷贝，包含全局/项目/覆盖值；改这份结果不会通过此方法自动保存配置。
	getSettings(): Settings;

	/**
	 * Set the active tools by name. Unknown and `hidden` tools are ignored. Tools with `codemode` or
	 * `deferred` exposure stay callable from codemode scripts whether active or not.
	 */
	// 按名字重设 active 声明集合，未知/hidden 项忽略；codemode/deferred 即使不 active 仍可能可嵌套调用，不能把 active 当唯一权限表。
	setActiveTools(toolNames: string[]): void;

	/** Get available slash commands in the current session. */
	// 返回当前可用斜杠命令描述，可能包含扩展/模板/技能等来源。
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// Model and Thinking Level
	// =========================================================================

	/**
	 * Set the model for the current session without changing the configured default for new sessions.
	 * Returns false if authentication is not configured for the model's provider.
	 */
	// 尝试切换当前会话模型并返回是否认证已配置，失败可 false/抛错；不更改新会话默认。通过认证配置检查也不是提前证明网络请求成功或凭证永不失效。
	setModel(model: Model<any>): Promise<boolean>;

	/** Get current thinking level. */
	// 读取当前思考档位，不触发模型生成。
	getThinkingLevel(): ThinkingLevel;

	/**
	 * Set the thinking level (clamped to model capabilities) for the current session without changing the configured default
	 * for new sessions.
	 */
	// 设置本会话思考档位，按当前模型能力调整，不修改新会话默认档位。
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// Provider Registration
	// =========================================================================

	/**
	 * Register or override a model provider.
	 *
	 * If `models` is provided: replaces all existing models for this provider.
	 * If only `baseUrl` is provided: overrides the URL for existing models.
	 * If `oauth` is provided: registers OAuth provider for /login support.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 *
	 * During initial extension load this call is queued and applied once the
	 * runner has bound its context. After that it takes effect immediately, so
	 * it is safe to call from command handlers or event callbacks without
	 * requiring a `/reload`.
	 *
	 * @example
	 * // Register a new provider with custom models
	 * pi.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "$PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // Register provider with OAuth support
	 * pi.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	// 原生供应商重载：传完整 Provider 对象，加载期提交到队列，绑定后交模型注册表；声明/注册本身不发聊天请求。
	registerProvider(provider: Provider): void;
	// 配置式供应商重载：输入名字与兼容配置，定义 models 可替换该供应商目录，仅提供 baseUrl 时可覆写已有模型 URL；实际认证/流适配由模型层处理。
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes all models belonging to the named provider and restores any
	 * built-in models that were overridden by it. Has no effect if the provider
	 * is not currently registered.
	 *
	 * Like `registerProvider`, this takes effect immediately when called after
	 * the initial load phase.
	 *
	 * @example
	 * pi.unregisterProvider("my-proxy");
	 */
	// 按名注销已注册供应商并恢复被覆盖的内置目录，加载期移除待处理记录，绑定后立即走注册表；不会因为注销自动撤销此前外部请求。
	unregisterProvider(name: string): void;

	// =========================================================================
	// MCP Servers
	// =========================================================================

	/**
	 * Register an MCP server for this session, with the same config as an `mcpServers` entry in
	 * `mcp.json`. The server connects next to the configured servers: on `session_start` when
	 * registered during extension load, right away when registered later. Registering a name again
	 * replaces the extension's earlier registration.
	 *
	 * The registration is not saved; register again on every load. A server of the same name in
	 * `mcp.json` takes precedence. Throws for invalid configs and for names another extension
	 * registered. When no loaded extension handles MCP servers (for example because another MCP
	 * extension replaced the built-in one), the registration is reported as an extension error.
	 *
	 * @example
	 * pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira" });
	 */
	// 注册本会话 MCP 配置，不写 mcp.json；配置需合法、已提交同名须属本扩展，自己的同名可替换。连接由 MCP 接管扩展异步处理，不保证方法返回时已连接；配置文件中的同名服务器优先。
	registerMcpServer(name: string, config: McpServerConfig): void;

	/** Remove an MCP server this extension registered and close its connection. */
	// 移除本扩展的 MCP 注册，连接关闭由接管扩展处理变更事件；本方法不返回等待断开的 Promise。
	unregisterMcpServer(name: string): void;

	/** Every MCP server registered by extensions. For extensions that connect MCP servers. */
	// 读取所有扩展注册的 MCP 记录拷贝，不等于配置文件合并后的最终连接列表。
	getMcpServers(): RegisteredMcpServer[];

	/**
	 * Register a virtual model: a selectable catalog entry that routes each request to a physical
	 * model. The selection (`ctx.model`, `model_change` entries) names the virtual model; assistant
	 * messages record the physical model and thinking level the router picked.
	 *
	 * `provider` may be any provider id, including one with physical models, and may list several
	 * virtual models. Registering the same provider and id again replaces the virtual model. See
	 * docs/virtual-models.md.
	 */
	// 登记虚拟模型及路由回调，选择界面保持虚拟名，实际每请求路由到真实模型；注册不立刻调用路由或发请求，重复 provider/id 替换。
	registerVirtualModel<TState = unknown>(model: ExtensionVirtualModel<TState>): void;

	/** Remove a virtual model registered with `registerVirtualModel()`. */
	// 移除指定 provider/id 的虚拟模型定义，不负责撤销已发请求。
	unregisterVirtualModel(provider: string, id: string): void;

	/** Shared event bus for extension communication. */
	// 扩展共享事件总线；emit 是通知入口不等待所有异步 listener，on 的退订函数由加载器跟踪以便失效清理。
	events: EventBus;
}

// ============================================================================
// Provider Registration Types
// ============================================================================

/** Virtual model registered via pi.registerVirtualModel(). */
// 复用虚拟模型定义除 route 外的字段，再加可访问扩展上下文的 route；Omit 仅编译期挑字段，不复制运行时对象。
export interface ExtensionVirtualModel<TState = unknown> extends Omit<VirtualModelDefinition<TState>, "route"> {
	/** Like `VirtualModelDefinition.route`, with an extension context. */
	// 每请求路由回调，输入 transcript/状态等请求与当前扩展上下文，返回真实模型/思考等路由或 Promise；例如按长度选择模型，真实请求在路由之后。TState 不做运行时验证。
	route(request: ModelRouteRequest<TState>, ctx: ExtensionContext): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

/** Configuration for registering a provider via pi.registerProvider(). */
// 兼容式供应商配置接口，只描述声明；模型层负责组合目录、凭证与具体能力实现。
export interface ProviderConfig {
	/** Display name for the provider in UI. */
	// 供应商显示名，缺省由模型层按 ID 等规则显示。
	name?: string;
	/** Base URL for the API endpoint. Required when defining models. */
	// API 基础 URL；定义模型通常需要，覆写已有供应商时可只提供它。
	baseUrl?: string;
	/** API key literal, env interpolation ($ENV_VAR or ${ENV_VAR}), or leading !command. Required when defining models (unless oauth provided). */
	// 静态 key、环境插值或 !命令来源字符串；动态解析在实际认证请求路径进行，不应把注册当成已执行命令/验证 key。
	apiKey?: string;
	/** API type. Required at provider or model level when defining models. */
	// 供应商默认聊天 API，单模型可覆盖，定义模型需能解析出具体 API。
	api?: Api;
	/**
	 * Optional streamSimple handler for custom APIs.
	 * The context is a normalized transcript: read the prompt and tools from its system messages
	 * (`getCurrentSystemPrompt(context.messages)`, `getCurrentTools(context.messages)`).
	 * Implementations must invoke `options.onPayload` before sending the provider request and use any
	 * returned replacement payload. They must invoke `options.onResponse` after receiving the response
	 * and before consuming its body, matching built-in providers. Implementations may invoke
	 * `options.onProviderStreamEvent(data, model)` with parsed stream events before normalization.
	 * Event data is adapter-owned and must be treated as read-only.
	 */
	// 自定义聊天流实现回调，返回 AssistantMessageEventStream 而非 Promise<消息>；实际调用时发请求并产流。实现必须自行遵守 onPayload/onResponse 等协议，类型声明不会自动补上这些钩子。
	streamSimple?: (
		// 所选聊天模型，API 泛型限制其协议类型。
		model: Model<Api>,
		// 规范 transcript，提示/工具状态在 system 消息中，不应只取旧式单独 prompt 字段。
		context: TranscriptContext,
		// 可选请求选项，含 key、取消及生命周期钩子。
		options?: SimpleStreamOptions,
		// 返回可消费的助手事件流，最终消息由该流汇总。
	) => AssistantMessageEventStream;
	/** Image-generation implementations keyed by image API. */
	// 按图像 API 提供实现的可选字典；Partial 允许只支持部分 API。
	images?: Partial<Record<ImageApi, ProviderImages>>;
	/** Classifier implementations keyed by classifier API. */
	// 按分类 API 提供实现的可选字典。
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	/** Custom headers to include in requests. */
	// 附加静态请求头，这里值仅 string，不是 before_provider_headers 的 null 删除标记类型。
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	// 要求把解析后的 key 放入 Authorization: Bearer 头，不等于凭证一定有效。
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	// 明确给 models 时替换此供应商已有模型列表；不提供则可只做覆盖。
	models?: ProviderModelConfig[];
	/**
	 * Refresh this provider's model list. The returned list replaces extension-provided models.
	 * Use context.publish({ persist: entry }) when the catalog should persist across sessions.
	 */
	// 刷新目录回调，输入刷新上下文、返回完整新列表替换扩展模型；要跨会话持久需显式 context.publish({persist:...})。声明不自动轮询或联网。
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** OAuth provider for /login support. The `id` is set automatically from the provider name. */
	// OAuth 能力配置，对应 /login，ID 由注册时供应商名补齐；不是已登录凭证。
	oauth?: {
		/** Display name for the provider in login UI. */
		// 登录界面显示名称。
		name: string;
		/** Whether access through this auth method is backed by a provider subscription. */
		// 该认证是否代表供应商订阅，供能力/策略使用，不验证用户账单。
		isSubscription?: boolean;
		/** @deprecated Retained for source compatibility; canonical auth flows ignore it. */
		// 废弃兼容字段，规范认证流程忽略；true 不会强制建立本地回调服务器。
		usesCallbackServer?: boolean;
		/** Run the login flow, return credentials to persist. */
		// 登录回调输入 UI 等回调集合，异步返回待保存凭证；实际交互/外部登录由实现执行，不在声明时发生。
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** Refresh expired credentials, return updated credentials to persist. */
		// 刷新回调输入旧凭证及取消信号，返回新凭证；需实现主动响应 signal，框架类型不保证所有刷新副作用都能撤销。
		refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
		/** Convert credentials to API key string for the provider. */
		// 从凭证同步提取请求 key，例如 access；不是刷新或验证 token。
		getApiKey(credentials: OAuthCredentials): string;
		/** Legacy synchronous credential-dependent model projection. */
		// 旧式同步聊天目录投影，根据凭证返回 Model<Api>[]，不处理图像/分类目录，也不在此做异步刷新。
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

// 各种模型配置共用的字段，实际有效性由模型注册/目录解析边界检查。
interface ProviderModelConfigBase {
	/** Model ID. */
	// 供应商内模型 ID。
	id: string;
	/** Display name. */
	// 模型显示名称。
	name: string;
	/** API type override for this model. */
	// 通用基础层 API 字符串，具体子类型可收窄成聊天/图像/分类 API。
	api?: string;
	/** API endpoint URL override for this model. */
	// 单模型基础 URL 覆盖，未设置沿用供应商配置。
	baseUrl?: string;
	/** Supported input types. */
	// 支持的输入内容类别列表，类型限定 text/image，并不代表本接口执行图片预处理。
	input: ("text" | "image")[];
	/** Provider input limits and cache-safe image preprocessing metadata. */
	// 沿用 AnyModel 的输入限制/缓存安全图片元信息类型，避免重复维护结构。
	inputLimits?: AnyModel["inputLimits"];
	/** Per-million-token cost rates and optional request-wide input pricing tiers. */
	// 沿用模型计费结构，每百万 token 费率及可选分段；目录元数据不是实际账单保证。
	cost: AnyModel["cost"];
	/** Custom headers for this model. */
	// 单模型静态请求头覆盖。
	headers?: Record<string, string>;
}

/** Chat model configuration. Omitted `type` is normalized to `"chat"`. */
// 聊天模型配置，未写 type 时规范化为 chat。
export interface ProviderChatModelConfig extends ProviderModelConfigBase {
	// 可省略 chat 判别字段，这是兼容默认，不是运行时立即赋值。
	type?: "chat";
	// 聊天协议类型覆盖，收窄基础 api:string。
	api?: Api;
	/** Whether the model supports extended thinking. */
	// 是否声明支持扩展思考。
	reasoning: boolean;
	/** Maps pi thinking levels to provider/model-specific values; null marks a level unsupported. */
	// 思考档位到供应商值的映射，null 表示不支持该档。
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Best-effort prompt cache lifetime in seconds per retention tier. Unset disables cache warming. */
	// 各缓存保留档位的尽力寿命，未配置不启用缓存预热；不是服务器命中率保证。
	promptCache?: Model<Api>["promptCache"];
	/** Maximum context window size in tokens. */
	// 目录声明的上下文 token 上限。
	contextWindow: number;
	/** Maximum output tokens. */
	// 目录声明的最大输出 token 数。
	maxTokens: number;
	// 额外采样参数字典，各值 unknown 需具体适配器理解，不在此验证供应商支持性。
	samplingParams?: Record<string, unknown>;
	/** OpenAI compatibility settings. */
	// OpenAI 兼容行为选项，复用 Model 的 compat 类型。
	compat?: Model<Api>["compat"];
}

/** Image-generation model configuration. */
// 图像生成模型配置，type 必须明确为 image，和聊天目录分开。
export interface ProviderImageModelConfig extends ProviderModelConfigBase {
	// 图像生成判别字段。
	type: "image";
	// 可选图像 API 覆盖。
	api?: ImageApi;
	// 输出支持文字/图片的哪些类型。
	output: ("text" | "image")[];
}

/** Structured classifier model configuration. */
// 结构化分类模型配置，type 必须是 classifier。
export interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	// 分类模型判别字段。
	type: "classifier";
	// 可选分类 API 覆盖。
	api?: ClassifierApi;
	// 分类器上下文 token 上限。
	contextWindow: number;
}

/** Configuration for a model within a provider. */
// 三类目录配置联合；检查 type 区分图像/分类，缺省类型走聊天规范化。
export type ProviderModelConfig = ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig;

/** Extension factory function type. Supports both sync and async initialization. */
// 扩展默认工厂接收 pi API，同步完成或返回 Promise；加载器会等待异步初始化。例：在工厂里 registerTool/on 登记能力，事件发生后才运行 handler；工厂也能有任意自身副作用，框架不保证通用回滚。
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// 内联扩展可直接是工厂或带名字/加载策略的对象，类型联合不在此加载扩展。
export type InlineExtension =
	// 简写直接工厂，显示名由加载器产生。
	| ExtensionFactory
	// 详细配置分支。
	| {
			/**
			 * Display name shown as `<inline:name>` in the startup Extensions list and errors. With
			 * `builtin`, the extension is named `builtin:name` in errors and diagnostics.
			 */
			// 显示名，普通内联呈现 <inline:name>，builtin 使用 builtin:name。
			name: string;
			// 实际初始化工厂，加载时仍会调用并等待。
			factory: ExtensionFactory;
			/** Omit this extension from the startup Extensions list. */
			// 是否从启动扩展列表隐藏，只影响显示，不停止加载。
			hidden?: boolean;
			/**
			 * Leave this extension out when another extension registers a tool, command, or flag with a
			 * name it registers during loading, instead of reporting a conflict. The CLI's built-in MCP,
			 * codemode, and tool search extensions use it, so for example an MCP extension that registers
			 * `/mcp` replaces the built-in MCP support. The factory still runs, so it should only register
			 * tools, commands, flags, and event handlers.
			 */
			// 允许其他不可替换扩展加载时注册同名工具/命令/flag 来替代它；两个可替换扩展不会彼此排除。工厂仍先运行，因此不保证任意外部副作用自动回滚。
			replaceable?: boolean;
			/**
			 * Supply the code of the `builtin:<name>` extension instead of loading as an inline extension.
			 * `builtin:<name>` is an extension resource like a file: it loads by default, `pi config` lists
			 * it, `-builtin:<name>` in the `extensions` setting and `--no-extensions` disable it, and
			 * `-e builtin:<name>` loads it explicitly. It is hidden from the startup Extensions list and
			 * loads after project trust is resolved, so it cannot handle `project_trust`. The CLI's built-in
			 * extensions use it.
			 */
			// 作为 builtin:name 可配置资源，受禁用/显式加载规则控制；项目信任之后才加载，不能靠它参与 project_trust 决策。
			builtin?: boolean;
	  };

// ============================================================================
// Loaded Extension Types
// ============================================================================

// 登记工具包含定义与来源，供 runner 汇总/冲突处理。
export interface RegisteredTool {
	// 工具 schema、execute 与渲染等定义本体。
	definition: ToolDefinition;
	// 该工具的来源元数据。
	sourceInfo: SourceInfo;
}

// 汇总后的 CLI flag 描述，与 registerFlag 的判别联合相比这里两个字段均放宽，类型不再表达默认值和 type 的对应关系。
export interface ExtensionFlag {
	// flag 名。
	name: string;
	// 帮助说明。
	description?: string;
	// 布尔/字符串类型标记。
	type: "boolean" | "string";
	// 可选默认值，运行时以共享 flagValues 保存当前值。
	default?: boolean | string;
	// 声明该 flag 的扩展路径。
	extensionPath: string;
}

// 已登记快捷键记录。
export interface ExtensionShortcut {
	// 键组合。
	shortcut: KeyId;
	// 帮助说明。
	description?: string;
	// 实际触发的同步/异步处理器，输入普通上下文；注册不立即运行。
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	// 来源扩展路径。
	extensionPath: string;
}

// 内部统一异步 handler 形状：可变 unknown 参数列表、Promise<unknown> 返回；loader 包装公开 handler 后存到这个集合，原返回可同步或 void。
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

// 宿主注入的自定义消息动作类型，泛型 T 对应 details，运行时绑定后 API 才能调用。
export type SendMessageHandler = <T = unknown>(
	// 消息材料，不要求扩展自己生成时间戳等内部字段。
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	// 启动与递送选项，nextTurn 只在自定义消息路径提供。
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	// 返回 void，不可据此 await 模型回复。
) => void;

// 宿主注入的用户输入动作，和 pi.sendUserMessage 对应。
export type SendUserMessageHandler = (
	// 用户纯文字或多模态内容。
	content: string | (TextContent | ImageContent)[],
	// 忙碌递送及是否展开命令/技能/模板。
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	// 动作没有完成 Promise 返回给 API 调用者。
) => void;

// 追加自定义状态的宿主函数类型，接收类别及泛型数据，无返回数据；真正调用时才写日志。
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

// 设置会话名动作，输入名称，无返回值。
export type SetSessionNameHandler = (name: string) => void;

// 取会话名动作，未设置返回 undefined。
export type GetSessionNameHandler = () => string | undefined;

// 取 active 工具名动作，不等于 callable 工具全集。
export type GetActiveToolsHandler = () => string[];

/** Tool info with name, description, parameter schema, prompt guidelines, and source metadata. */
// 工具目录展示信息由原定义挑字段再补充元数据，不包含 execute，查询不会执行工具。
export type ToolInfo = Pick<
	// Pick 的来源是 ToolDefinition。
	ToolDefinition,
	// 挑出名称、说明、schema、规则和可触及工具提示。
	"name" | "description" | "parameters" | "promptGuidelines" | "reachesTools"
	// 交叉类型 & 再加入下列字段。
> & {
	// 最终可达性分类，区别直接声明与嵌套调用。
	exposure: ToolExposure;
	// 可选命名空间。
	namespace?: ToolNamespace;
	// 未验证的作者行为提示。
	annotations?: ToolAnnotations;
	// 来源元数据。
	sourceInfo: SourceInfo;
};

// 取全部工具元数据的宿主函数类型。
export type GetAllToolsHandler = () => ToolInfo[];

// 取有效设置的宿主函数类型。
export type GetSettingsHandler = () => Settings;

// 取当前斜杠命令目录的宿主函数类型。
export type GetCommandsHandler = () => SlashCommandInfo[];

// 设置 active 声明集合的宿主函数类型。
export type SetActiveToolsHandler = (toolNames: string[]) => void;

// 刷新工具注册表/布局的宿主函数，加载期可先绑为空操作，真正会话绑定后才刷新。
export type RefreshToolsHandler = () => void;

// 切换当前模型的宿主函数，异步 boolean 表示认证配置检查等结果，不是聊天结果。
export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

// 读取思考档位的宿主函数类型。
export type GetThinkingLevelHandler = () => ThinkingLevel;

// 设置思考档位的宿主函数类型。
export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

// 写/清条目标签的宿主函数类型，undefined 清除。
export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * Shared state created by loader, used during registration and runtime.
 * Contains flag values (defaults set during registration, CLI values set after).
 */
// 加载器创建、所有扩展共享的运行时状态；初始化时会话动作还不可用，bindCore 后替换，失效时拒绝受保护调用。
export interface ExtensionRuntimeState {
	// 共享 CLI flag 当前值表，默认值在成功提交时进入，CLI 可随后覆盖；同名并不自动隔离扩展命名空间。
	flagValues: Map<string, boolean | string>;
	/** Legacy provider-config registrations queued during extension loading, processed when runner binds. */
	// 待应用兼容供应商配置，保存来源便于错误报告；会话服务可能先消费，runner 绑定时处理剩余项。
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	/** Native pi-ai provider registrations queued during extension loading, processed when runner binds. */
	// 待应用原生 Provider 对象及来源，尚未发模型请求。
	pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
	/** Virtual model registrations queued during extension loading, processed when runner binds. */
	// 待登记虚拟模型定义及来源，路由不会因入队而执行。
	pendingVirtualModelRegistrations: Array<{ definition: VirtualModelDefinition; extensionPath: string }>;
	/** Create an extension context. Throws before the runner binds. */
	// 创建当前扩展上下文，runner 尚未绑定时桩会抛错，创建后仍有惰性属性校验。
	createContext: () => ExtensionContext;
	/** Throws when this extension instance is stale after runtime replacement. */
	// 检查共享 runtime 是否失效；活跃不等于动作已经绑定，加载期 assertActive 可通过但具体动作仍抛未绑定。
	assertActive: () => void;
	/** Marks this extension instance as stale after runtime replacement or reload. */
	// 使旧实例失效，可自定义后续错误文本，同时清理由运行时追踪的总线订阅；不自动释放扩展任意外部资源。
	invalidate: (message?: string) => void;
	/** Retain an event-bus subscription until this runtime is invalidated. */
	// 登记退订清理函数并返回可手动退订的包装函数；失效时清理仍登记项，不意味着等所有事件任务完成。
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	/**
	 * Register or unregister a provider.
	 *
	 * Before bindCore(): queues registrations / removes from queue.
	 * After bindCore(): calls ModelRegistry directly for immediate effect.
	 */
	// 配置式注册动作，加载期入队、绑定后直接交目录；extensionPath 可选用于诊断来源。
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	// 原生 Provider 注册动作，加载期入队、绑定后登记；参数本身不会触发供应商聊天流。
	registerNativeProvider: (provider: Provider, extensionPath?: string) => void;
	// 注销供应商，绑定前移除待注册项，绑定后交目录恢复内置项。
	unregisterProvider: (name: string, extensionPath?: string) => void;
	/** Servers registered with `pi.registerMcpServer()`. */
	// MCP 注册表，保存配置与所有者，连接由另一个扩展管理。
	mcpServers: McpServerRegistry;
	// 登记虚拟模型定义，加载期排队；可选来源用于报告错误。
	registerVirtualModel: (definition: VirtualModelDefinition, extensionPath?: string) => void;
	// 按 provider/id 移除虚拟模型定义。
	unregisterVirtualModel: (provider: string, id: string) => void;
}

/**
 * Action implementations for pi.* API methods.
 * Provided to runner.initialize(), copied into the shared runtime.
 */
// 宿主提供 pi.* 动作实现的集合，当前 runner 方法名为 bindCore（原英文 initialize 指旧称）；这里只声明函数属性，不会自动执行动作。
export interface ExtensionActions {
	// 发送自定义消息的实现。
	sendMessage: SendMessageHandler;
	// 发送用户输入的实现。
	sendUserMessage: SendUserMessageHandler;
	// 追加自定义持久状态的实现。
	appendEntry: AppendEntryHandler;
	// 写会话名的实现。
	setSessionName: SetSessionNameHandler;
	// 取会话名的实现。
	getSessionName: GetSessionNameHandler;
	// 写/清标签的实现。
	setLabel: SetLabelHandler;
	// 取 active 工具列表的实现。
	getActiveTools: GetActiveToolsHandler;
	// 取全部工具元数据的实现。
	getAllTools: GetAllToolsHandler;
	// 取有效设置的实现。
	getSettings: GetSettingsHandler;
	// 设置 active 工具集的实现。
	setActiveTools: SetActiveToolsHandler;
	// 重建/刷新工具表的实现。
	refreshTools: RefreshToolsHandler;
	// 列出斜杠命令的实现。
	getCommands: GetCommandsHandler;
	// 异步切换当前模型的实现。
	setModel: SetModelHandler;
	// 读取思考档位的实现。
	getThinkingLevel: GetThinkingLevelHandler;
	// 设置思考档位的实现。
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * Actions for ExtensionContext (ctx.* in event handlers).
 * Required by all modes.
 */
// ctx.* 读取/动作的宿主实现，runner 用这些函数构造带生命周期保护的上下文；只是类型声明，不在此触发会话操作。
export interface ExtensionContextActions {
	// 惰性读取当前模型，可未选择。
	getModel: () => Model<any> | undefined;
	// 惰性读取会话筛选的模型数组，readonly 只是编译期数组写保护。
	getScopedModels: () => readonly ScopedModel[];
	// 读取空闲状态；正常会话绑定不把独立用户 bash 计入。
	isIdle: () => boolean;
	// 读取项目本地信任状态。
	isProjectTrusted: () => boolean;
	// 读取当前 Agent 取消信号，非流式可没有。
	getSignal: () => AbortSignal | undefined;
	// 请求中止 Agent 操作，函数返回不保证所有工具已退出。
	abort: () => void;
	// 查询待续输入队列，正常绑定检查 steering/followUp 队列。
	hasPendingMessages: () => boolean;
	// 请求宿主有序关闭。
	shutdown: () => void;
	// 查询上下文估算，可未知。
	getContextUsage: () => ContextUsage | undefined;
	// 后台发起压缩，结果用 CompactOptions 回调交付，不返回 Promise。
	compact: (options?: CompactOptions) => void;
	// 读取最终有效系统提示文本。
	getSystemPrompt: () => string;
	// 可选基础提示构造选项读取器，未提供时 runner 命令上下文有自己的回退。
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
	/** Backs `ExtensionToolContext.executeTool()`. Without it, nested calls fail. */
	// 嵌套执行的可选底层实现，缺省时 runner 返回 isError 的不可用结果；此声明不启动执行。
	executeTool?: (
		// 父调用 ID，用于派生 parent/n 和嵌套记录。
		callerId: string,
		// 目标工具名。
		name: string,
		// 未校验输入，在执行链边界校验。
		args: unknown,
		// runner 已组装的取消/进度选项，这里参数必需但各字段可缺省。
		options: ExecuteToolOptions,
		// 异步返回统一执行结果，常规工具失败转 isError。
	) => Promise<AgentToolCallOutcome>;
	/** Backs `ExtensionToolContext.tools`. */
	// 可选 callable 工具集合读取器，未提供时上下文列表为空。
	getCallableTools?: () => readonly AgentTool[];
}

/**
 * Actions for ExtensionCommandContext (ctx.* in command handlers).
 * Only needed for interactive mode where extension commands are invokable.
 */
// 命令会话控制绑定集合，未绑定时 runner 使用空实现占位；占位返回 cancelled:false 不代表做过真实会话切换。
export interface ExtensionCommandContextActions {
	// 等 Agent 空闲的异步动作。
	waitForIdle: () => Promise<void>;
	// 新建会话动作及可选初始化配置。
	newSession: (options?: {
		// 可记录父会话路径。
		parentSession?: string;
		// 初始化回调得到完整会话管理器，Promise 会被等待。
		setup?: (sessionManager: SessionManager) => Promise<void>;
		// 替换完成后回调得到新上下文，避免重用旧 ctx。
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		// 异步返回是否取消。
	}) => Promise<{ cancelled: boolean }>;
	// 分叉会话动作，可能替换 runtime。
	fork: (
		// 分叉锚点条目 ID。
		entryId: string,
		// 锚点前/包含锚点以及替换完成回调。
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
		// 异步取消状态。
	) => Promise<{ cancelled: boolean }>;
	// 树导航动作，可生成离开分支摘要。
	navigateTree: (
		// 目标条目 ID。
		targetId: string,
		// 可选摘要开关、指示覆盖方式、标签。
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
		// 异步返回取消状态。
	) => Promise<{ cancelled: boolean }>;
	// 切换既有会话文件动作。
	switchSession: (
		// 目标文件路径。
		sessionPath: string,
		// 替换完成回调使用新上下文。
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
		// 异步返回取消状态。
	) => Promise<{ cancelled: boolean }>;
	// 异步重载资源动作，旧扩展上下文可能随之失效。
	reload: () => Promise<void>;
}

/**
 * Full runtime = state + actions.
 * Created by loader with throwing action stubs, completed by runner.initialize().
 */
// 运行时接口同时继承状态与动作，extends 只是编译期组合；loader 建桩，当前由 bindCore 补齐（原英文 initialize 是旧称），不是实例化此接口就有可用会话。
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** Loaded extension with all registered items. */
// 单个已加载扩展的登记结果，存储声明/处理器；工厂已经运行过，工具 execute 和事件 handler 未必执行过。
export interface Extension {
	// 用于显示/诊断的扩展路径，内联可为合成标识。
	path: string;
	// 实际解析路径，用于来源/重复判断；不保证已 realpath 消除符号链接。
	resolvedPath: string;
	// 是否在启动扩展清单中隐藏，不是停止运行。
	hidden?: boolean;
	/** See {@link InlineExtension}. */
	// 是否允许按加载期能力名冲突被其他扩展替代。
	replaceable?: boolean;
	// 扩展来源元数据。
	sourceInfo: SourceInfo;
	// 事件名到异步包装处理器数组，数组保持注册顺序；派发时 runner 拍快照。
	handlers: Map<string, HandlerFn[]>;
	// 工具名到定义/来源，同一扩展同名 Map.set 覆盖。
	tools: Map<string, RegisteredTool>;
	// 自定义消息类别到渲染器。
	messageRenderers: Map<string, MessageRenderer>;
	// 可选工具渲染解析器链，按登记顺序使用。
	toolRenderers?: ToolRendererResolver[];
	// 可选 Markdown 显示转换器，单字段写入会替换同扩展之前的转换器。
	markdownTransformer?: MarkdownTransformer;
	// 可选自定义状态条目渲染器表。
	entryRenderers?: Map<string, EntryRenderer>;
	// 命令名到声明，同扩展同名覆盖，跨扩展后续解析分配调用名称。
	commands: Map<string, RegisteredCommand>;
	// flag 名到描述，共享值在 runtime.flagValues。
	flags: Map<string, ExtensionFlag>;
	// 快捷键到回调描述，跨扩展冲突另由 runner 与宿主绑定解决。
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** Result of loading extensions. */
// 多扩展加载结果，把成功项、可读失败和共享运行时交资源/会话层；部分失败不必阻止其他项加载。
export interface LoadExtensionsResult {
	// 成功完成加载/提交的扩展，保持加载顺序。
	extensions: Extension[];
	// 失败路径与错误文本，不等于完整 Error 实例。
	errors: Array<{ path: string; error: string }>;
	// 可选警告记录，具体加载入口可能只初始化为空列表。
	warnings?: Array<{ path: string; warning: string }>;
	/** Shared runtime - actions are throwing stubs until runner.initialize() */
	// 共享 runtime 在当前 bindCore 前大部分动作是抛错桩；refreshTools 初始为空操作，注册供应商可排队，不能把英文概括理解为每个字段都抛错。
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// ============================================================================

// runner 报告给错误观察者的结构，不是自动抛出的异常类；某些事件报告后继续，另一些重抛，需看具体派发方法。
export interface ExtensionError {
	// 出错扩展来源。
	extensionPath: string;
	// 出错事件名。
	event: string;
	// 可读错误文字。
	error: string;
	// Error 的可选堆栈，抛出普通字符串等值时可能没有。
	stack?: string;
}
