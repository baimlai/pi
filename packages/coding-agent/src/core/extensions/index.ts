// 扩展系统汇总入口，向SDK、会话与扩展作者重导出加载/运行/类型/包装能力；此处只连接模块，不主动创建会话或派发事件。
/**
 * Extension system for lifecycle events and custom tools.
 */

// 重导出斜杠命令信息及来源类型，让使用者统一从扩展入口取描述结构；export type 在运行时擦除。
export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.ts";
// 重导出工具/命令等资源的 SourceInfo 来源类型。
export type { SourceInfo } from "../source-info.ts";
// 下面是加载器的运行值重导出；取得函数不等于调用函数，实际文件导入/工厂初始化在调用时发生。
export {
	// 重导出 createExtensionRuntime：创建共享未绑定运行时，多数会话动作初始为抛错桩，注册供应商可先排队。
	createExtensionRuntime,
	// 重导出 discoverAndLoadExtensions：从项目/全局/显式路径发现并按序加载扩展，单文件错误汇总。
	discoverAndLoadExtensions,
	// 重导出 loadExtensionFromFactory：直接执行宿主传入的同步/异步工厂并提交声明，失败拒绝。
	loadExtensionFromFactory,
	// 重导出 loadExtensions：不使用工厂缓存按路径串行加载，返回成功扩展/错误/runtime。
	loadExtensions,
	// 上述四个实际加载函数来自loader；缓存专用loadExtensionsCached等内部入口未在这一组公开重导出。
} from "./loader.ts";
// 下面只重导出运行器辅助函数类型，不生成这些宿主动作的实现。
export type {
	// 重导出 ExtensionErrorListener：接收结构化扩展错误的同步观察者函数。
	ExtensionErrorListener,
	// 重导出 ForkHandler：按条目与 before/at 位置分叉、异步返回取消状态的宿主动作。
	ForkHandler,
	// 重导出 NavigateTreeHandler：导航会话树并可生成分支摘要的宿主动作。
	NavigateTreeHandler,
	// 重导出 NewSessionHandler：新建会话，可初始化并在替换后用新上下文继续的宿主动作。
	NewSessionHandler,
	// 重导出 ShutdownHandler：请求宿主有序关闭的无参 void 动作。
	ShutdownHandler,
	// 重导出 SwitchSessionHandler：恢复其他会话文件并提供新上下文的宿主动作。
	SwitchSessionHandler,
	// 这些宿主控制回调类型来自runner，只声明输入/异步结果，不提供已绑定动作。
} from "./runner.ts";
// 重导出 ExtensionRunner 运行值：把宿主能力绑定到扩展并按各事件规则执行/聚合处理器的运行容器；仍需 new 和绑定宿主能力后使用。
export { ExtensionRunner } from "./runner.ts";
// 下面逐项重导出types里的纯类型，供SDK/会话/扩展作者使用；export type编译后擦除，类型存在不等于运行时验证存在。
export type {
	// 重导出 AfterProviderResponseEvent：收到供应商HTTP响应、消费响应体前的通知。
	AfterProviderResponseEvent,
	// 重导出 AgentActivityOutcome：活动完成/中止/错误的字符串联合。
	AgentActivityOutcome,
	// 重导出 AgentBeforeSettleEvent：最终收尾前可追加草稿/请求继续的边界事件。
	AgentBeforeSettleEvent,
	// 重导出 AgentBeforeSettleEventResult：收尾前边界的可选 entries/continue 覆盖。
	AgentBeforeSettleEventResult,
	// 重导出 AgentEndEvent：底层Agent循环结束，之后会话仍可能重试/压缩/续跑。
	AgentEndEvent,
	// 重导出 AgentSettledEvent：会话活动已稳定、无计划内自动续跑的通知。
	AgentSettledEvent,
	// 重导出 AgentStartEvent：底层Agent循环开始通知。
	AgentStartEvent,
	// Re-exports
	// 重导出 AgentToolResult：工具最终内容/详情/可选结构化输出的泛型类型。
	AgentToolResult,
	// 重导出 AgentToolUpdateCallback：工具部分结果回调类型。
	AgentToolUpdateCallback,
	// 重导出 AppendEntryHandler：持久化扩展状态条目的宿主动作，不直接发模型。
	AppendEntryHandler,
	// App keybindings (for custom editors)
	// 重导出 AppKeybinding：可配置应用快捷键动作类型。
	AppKeybinding,
	// 重导出 AutocompleteProviderFactory：输入当前自动补全提供者、返回增强提供者的工厂。
	AutocompleteProviderFactory,
	// Events - Tool (ToolCallEvent types)
	// 重导出 BashToolCallEvent：bash调用前事件，带命令等具体输入。
	BashToolCallEvent,
	// 重导出 BashToolResultEvent：bash结果事件，详情为输出裁剪/日志位置等。
	BashToolResultEvent,
	// 重导出 BeforeAgentStartCustomEvent：空闲自定义消息带triggerTurn启动的前置事件。
	BeforeAgentStartCustomEvent,
	// 重导出 BeforeAgentStartEvent：用户或自定义消息触发的启动前事件联合。
	BeforeAgentStartEvent,
	// 重导出 BeforeAgentStartEventResult：启动前可追加消息与完整系统提示覆盖。
	BeforeAgentStartEventResult,
	// 重导出 BeforeAgentStartUserEvent：用户文字/图片触发的启动前事件。
	BeforeAgentStartUserEvent,
	// 重导出 BeforeProviderHeadersEvent：请求发送前原地改请求头，null删除标记，返回值忽略。
	BeforeProviderHeadersEvent,
	// 重导出 BeforeProviderRequestEvent：供应商专用负载改写事件，payload为unknown。
	BeforeProviderRequestEvent,
	// 重导出 BeforeProviderRequestEventResult：任意供应商负载替代值，undefined表示不覆盖。
	BeforeProviderRequestEventResult,
	// 重导出 BoundaryContextPreview：候选草稿应用后的投影/消息/待续队列/可继续性预览。
	BoundaryContextPreview,
	// 重导出 BoundaryResult：可选整体草稿列表与继续意图覆盖，非自动追加数组。
	BoundaryResult,
	// 重导出 BoundaryState：边界当前草稿、继续意图、预览及活动结果。
	BoundaryState,
	// 重导出 BuildSystemPromptOptions：系统提示构造的原始可选分段/资源/工作目录材料。
	BuildSystemPromptOptions,
	// 重导出 CacheWarmingDecisionEvent：核心缓存预热建议及相关状态事件。
	CacheWarmingDecisionEvent,
	// 重导出 CacheWarmingDecisionEventResult：扩展对预热action的可选覆盖。
	CacheWarmingDecisionEventResult,
	// 重导出 CompactionEntryDraft：待追加压缩草稿，改变投影不删除原日志。
	CompactionEntryDraft,
	// Context
	// 重导出 CompactOptions：后台压缩指示及成功/失败回调。
	CompactOptions,
	// 重导出 ContextEditEntryDraft：待追加上下文编辑草稿，引用目标条目并替换投影。
	ContextEditEntryDraft,
	// Events - Agent
	// 重导出 ContextEvent：第一阶段只见非system消息，runner随后恢复系统状态。
	ContextEvent,
	// Event Results
	// 重导出 ContextEventResult：可选替代消息列表，空数组也是有效替代。
	ContextEventResult,
	// 重导出 ContextUsage：上下文token估算/窗口/百分比，未知数值可null。
	ContextUsage,
	// 重导出 ContextWithSystemEvent：第二阶段完整transcript，处理器负责保留提示和工具状态。
	ContextWithSystemEvent,
	// 重导出 CustomEntryDraft：待追加扩展状态草稿，默认不进模型会话。
	CustomEntryDraft,
	// 重导出 CustomMessageEntryDraft：待追加扩展消息草稿，带可见标记与正文。
	CustomMessageEntryDraft,
	// 重导出 CustomToolCallEvent：自定义任意工具名及unknown参数字典的前置事件。
	CustomToolCallEvent,
	// 重导出 CustomToolResultEvent：自定义工具结果，details为unknown。
	CustomToolResultEvent,
	// 重导出 EditorFactory：输入TUI/主题/宿主快捷键、返回编辑器组件的工厂。
	EditorFactory,
	// 重导出 EditToolCallEvent：edit调用前事件，关联批量或单次替换参数。
	EditToolCallEvent,
	// 重导出 EditToolResultEvent：edit结果事件，详情带diff与首变行。
	EditToolResultEvent,
	// Message and Entry Rendering
	// 重导出 EntryRenderer：扩展自定义状态条目的显示回调，不将状态送模型。
	EntryRenderer,
	// 重导出 EntryRenderOptions：状态条目展开与宿主快捷键显示选项。
	EntryRenderOptions,
	// 重导出 ExecOptions：进程cwd/signal/timeout/maxBuffer选项，超时单位毫秒。
	ExecOptions,
	// 重导出 ExecResult：进程stdout/stderr/code及killed/truncated结果。
	ExecResult,
	// 重导出 ExecuteToolOptions：嵌套工具信号覆盖及部分结果回调。
	ExecuteToolOptions,
	// 重导出 Extension：已加载扩展的处理器/工具/命令/标志/渲染等注册记录。
	Extension,
	// 重导出 ExtensionActions：pi.*会话动作的宿主实现集合。
	ExtensionActions,
	// API
	// 重导出 ExtensionAPI：工厂收到的事件/工具/资源注册与会话动作接口。
	ExtensionAPI,
	// 重导出 ExtensionCommandContext：普通上下文加等待/新建/分叉/导航/恢复/重载能力。
	ExtensionCommandContext,
	// 重导出 ExtensionCommandContextActions：命令控制方法的宿主绑定函数集合。
	ExtensionCommandContextActions,
	// 重导出 ExtensionContext：事件处理器的会话读取、UI、取消、压缩上下文。
	ExtensionContext,
	// 重导出 ExtensionContextActions：ctx.*读取与控制能力的宿主绑定集合。
	ExtensionContextActions,
	// Errors
	// 重导出 ExtensionError：来源路径/事件名/文字/可选堆栈组成的诊断数据。
	ExtensionError,
	// 重导出 ExtensionEvent：所有公开扩展事件联合，各事件聚合规则并不相同。
	ExtensionEvent,
	// 重导出 ExtensionFactory：接收pi API并同步或异步初始化的函数，加载器等待它。
	ExtensionFactory,
	// 重导出 ExtensionFlag：CLI参数声明及来源，当前值存共享runtime。
	ExtensionFlag,
	// 重导出 ExtensionHandler：事件和上下文输入，可同步/异步返回结果或void的泛型回调。
	ExtensionHandler,
	// 重导出 ExtensionMode：tui/rpc/json/print运行模式联合。
	ExtensionMode,
	// Runtime
	// 重导出 ExtensionRuntime：加载状态与宿主动作的组合接口，bindCore后动作可用。
	ExtensionRuntime,
	// 重导出 ExtensionShortcut：按键组合、说明、处理器与来源记录。
	ExtensionShortcut,
	// 重导出 ExtensionToolContext：普通上下文加callable工具列表与executeTool嵌套调用。
	ExtensionToolContext,
	// 重导出 ExtensionUIContext：各模式提供的对话/编辑器/挂件/主题等UI能力契约。
	ExtensionUIContext,
	// 重导出 ExtensionUIDialogOptions：对话框取消信号与超时设置。
	ExtensionUIDialogOptions,
	// 重导出 ExtensionVirtualModel：每请求路由时额外收到扩展上下文的虚拟模型声明。
	ExtensionVirtualModel,
	// 重导出 ExtensionWidgetOptions：编辑器上方/下方挂件位置选项。
	ExtensionWidgetOptions,
	// 重导出 FindToolCallEvent：find调用前事件，带文件名模式及范围参数。
	FindToolCallEvent,
	// 重导出 FindToolResultEvent：find结果事件，详情标记结果数量/输出裁剪。
	FindToolResultEvent,
	// 重导出 GetActiveToolsHandler：读取直接声明给模型的工具名集合的宿主函数。
	GetActiveToolsHandler,
	// 重导出 GetAllToolsHandler：读取已配置工具元数据全集的宿主函数。
	GetAllToolsHandler,
	// 重导出 GetCommandsHandler：读取当前斜杠命令目录的宿主函数。
	GetCommandsHandler,
	// 重导出 GetThinkingLevelHandler：读取当前思考档位的宿主函数。
	GetThinkingLevelHandler,
	// 重导出 GrepToolCallEvent：grep调用前事件，带搜索表达式和过滤参数。
	GrepToolCallEvent,
	// 重导出 GrepToolResultEvent：grep结果事件，详情含匹配/字节/单行裁剪。
	GrepToolResultEvent,
	// 重导出 InlineExtension：裸工厂或带名称/hidden/replaceable/builtin策略的内联声明。
	InlineExtension,
	// Events - Input
	// 重导出 InputEvent：用户输入预处理事件，含文字/图片/来源/队列方式。
	InputEvent,
	// 重导出 InputEventResult：continue/transform/handled判别联合。
	InputEventResult,
	// 重导出 InputSource：交互/RPC/扩展注入三种来源。
	InputSource,
	// 重导出 KeybindingHints：从宿主配置格式化keyText/keyHint的显示方法。
	KeybindingHints,
	// 重导出 KeybindingsManager：宿主快捷键配置管理器类型。
	KeybindingsManager,
	// 重导出 LoadExtensionsResult：成功扩展、错误/警告及共享runtime的加载结果。
	LoadExtensionsResult,
	// 重导出 LsToolCallEvent：ls调用前事件，带目录和条数参数。
	LsToolCallEvent,
	// 重导出 LsToolResultEvent：ls结果事件，详情含条数/输出裁剪。
	LsToolResultEvent,
	// 重导出 MarkdownTransformContext：Markdown展示类型、流状态、宽度和可选持久条目信息。
	MarkdownTransformContext,
	// 重导出 MarkdownTransformer：同步转换交互Markdown显示文字，不直接改模型上下文。
	MarkdownTransformer,
	// 重导出 McpServersChangeEvent：绑定后MCP声明注册表变化，由接管扩展负责连接。
	McpServersChangeEvent,
	// Events - Message
	// 重导出 MessageEndEvent：消息完成事件，可返回同role替代消息。
	MessageEndEvent,
	// 重导出 MessageEndEventResult：可选最终消息替代，runner要求保持原role。
	MessageEndEventResult,
	// 重导出 MessageRenderer：自定义消息显示组件回调。
	MessageRenderer,
	// 重导出 MessageRenderOptions：消息展开/留白/宿主快捷键显示选项。
	MessageRenderOptions,
	// 重导出 MessageStartEvent：消息开始通知。
	MessageStartEvent,
	// 重导出 MessageUpdateEvent：助手流累计消息与本次标准化增量通知。
	MessageUpdateEvent,
	// 重导出 ModelSelectEvent：当前聊天模型选中后通知，含之前模型与来源。
	ModelSelectEvent,
	// 重导出 ModelSelectSource：直接设置/轮换/恢复模型的来源联合。
	ModelSelectSource,
	// 重导出 NormalizedBuildSystemPromptOptions：已补齐集合字段、供扩展共同修改的提示构造选项。
	NormalizedBuildSystemPromptOptions,
	// 重导出 PowerShellToolCallEvent：PowerShell工具调用前具体参数事件。
	PowerShellToolCallEvent,
	// 重导出 PowerShellToolResultEvent：PowerShell结果及裁剪详情事件。
	PowerShellToolResultEvent,
	// 重导出 ProjectTrustContext：项目信任阶段只提供目录/模式/有限对话方法的上下文。
	ProjectTrustContext,
	// 重导出 ProjectTrustEvent：项目本地资源加载前的信任决策事件。
	ProjectTrustEvent,
	// 重导出 ProjectTrustEventDecision：yes/no/undecided信任决定联合。
	ProjectTrustEventDecision,
	// 重导出 ProjectTrustEventResult：信任决定及可选记住标记。
	ProjectTrustEventResult,
	// 重导出 ProjectTrustHandler：接信任事件/受限上下文、同步或异步返回决定的处理器。
	ProjectTrustHandler,
	// Provider Registration
	// 重导出 ProviderConfig：兼容式供应商模型/流/认证等能力声明，注册不等于请求。
	ProviderConfig,
	// 重导出 ProviderModelConfig：聊天/图像/分类模型配置联合。
	ProviderModelConfig,
	// 重导出 ProviderStreamEvent：适配器解析后、标准化前的原生供应商流观察事件。
	ProviderStreamEvent,
	// 重导出 ReadToolCallEvent：read调用前事件，带路径和行区间。
	ReadToolCallEvent,
	// 重导出 ReadToolResultEvent：read结果与裁剪详情事件。
	ReadToolResultEvent,
	// Commands
	// 重导出 RegisteredCommand：原命令名/来源/参数补全/执行处理器记录。
	RegisteredCommand,
	// 重导出 RegisteredTool：工具定义及来源记录。
	RegisteredTool,
	// 重导出 ReplacedSessionContext：会话替换后的新有效命令上下文，消息方法可await。
	ReplacedSessionContext,
	// 重导出 ResolvedCommand：原命令加冲突解析后的唯一调用名。
	ResolvedCommand,
	// Events - Resources
	// 重导出 ResourcesDiscoverEvent：启动/重载后补充技能/提示/主题路径事件。
	ResourcesDiscoverEvent,
	// 重导出 ResourcesDiscoverResult：三类可选额外资源路径。
	ResourcesDiscoverResult,
	// 重导出 SendMessageHandler：宿主发送扩展自定义消息的void动作。
	SendMessageHandler,
	// 重导出 SendUserMessageHandler：宿主注入用户输入并启动/排队的void动作。
	SendUserMessageHandler,
	// 重导出 SessionBeforeCompactEvent：压缩准备材料、原因/重试标志/取消信号的前置事件。
	SessionBeforeCompactEvent,
	// 重导出 SessionBeforeCompactResult：取消或整份自定义摘要结果。
	SessionBeforeCompactResult,
	// 重导出 SessionBeforeForkEvent：分叉锚点和位置的前置事件。
	SessionBeforeForkEvent,
	// 重导出 SessionBeforeForkResult：分叉取消结果，skipConversationRestore当前会话路径未使用。
	SessionBeforeForkResult,
	// 重导出 SessionBeforeSwitchEvent：新建/恢复会话前的可取消事件。
	SessionBeforeSwitchEvent,
	// 重导出 SessionBeforeSwitchResult：可选取消标记。
	SessionBeforeSwitchResult,
	// 重导出 SessionBeforeTreeEvent：导航前的准备材料与取消信号。
	SessionBeforeTreeEvent,
	// 重导出 SessionBeforeTreeResult：可取消/自定义摘要/指示/标签的导航覆盖。
	SessionBeforeTreeResult,
	// 重导出 SessionBoundaryDraft：边界允许的状态/消息/上下文编辑/压缩草稿联合。
	SessionBoundaryDraft,
	// 重导出 SessionCompactEvent：成功追加压缩条目后通知。
	SessionCompactEvent,
	// 重导出 SessionCompactFailedEvent：压缩失败/取消后通知，willRetry表示原计划而非已重试。
	SessionCompactFailedEvent,
	// 重导出 SessionEvent：全部会话生命周期事件联合。
	SessionEvent,
	// 重导出 SessionInfoChangedEvent：规范化会话名称变化通知。
	SessionInfoChangedEvent,
	// 重导出 SessionShutdownEvent：退出/重载/会话替换前清理通知。
	SessionShutdownEvent,
	// Events - Session
	// 重导出 SessionStartEvent：会话启动/新建/恢复/分叉/重载后通知。
	SessionStartEvent,
	// 重导出 SessionTreeEvent：树导航完成后的新旧叶节点和可选分支摘要。
	SessionTreeEvent,
	// 重导出 SetActiveToolsHandler：重设active工具声明集合的宿主动作。
	SetActiveToolsHandler,
	// 重导出 SetLabelHandler：设置或用undefined清除条目标签的宿主动作。
	SetLabelHandler,
	// 重导出 SetModelHandler：异步切换会话模型并返回认证配置等结果的宿主动作。
	SetModelHandler,
	// 重导出 SetThinkingLevelHandler：按模型能力调整会话思考档位的宿主动作。
	SetThinkingLevelHandler,
	// 重导出 TerminalInputHandler：原始终端输入回调，可拦截或改写键数据。
	TerminalInputHandler,
	// 重导出 ThinkingLevelSelectEvent：思考档位选中后的新旧值通知。
	ThinkingLevelSelectEvent,
	// 重导出 ToolAnnotations：作者未验证的只读/破坏/幂等/开放世界提示。
	ToolAnnotations,
	// Events - Tool
	// 重导出 ToolCallEvent：工具执行前联合，input可原地改且之后不再校验。
	ToolCallEvent,
	// 重导出 ToolCallEventResult：阻止调用、原因及批次终止提示。
	ToolCallEventResult,
	// Tools
	// 重导出 ToolDefinition：参数schema、execute、暴露/并发/显示等完整工具声明。
	ToolDefinition,
	// Events - Tool Execution
	// 重导出 ToolExecutionEndEvent：工具执行结束结果及可选实际耗时通知。
	ToolExecutionEndEvent,
	// Tool execution mode
	// 重导出 ToolExecutionMode：顺序/并行工具调度策略类型。
	ToolExecutionMode,
	// 重导出 ToolExecutionStartEvent：工具开始执行通知，含调用/可选父调用ID。
	ToolExecutionStartEvent,
	// 重导出 ToolExecutionUpdateEvent：工具部分输出通知，含调用/可选父调用ID。
	ToolExecutionUpdateEvent,
	// 重导出 ToolExposure：direct/model-only/codemode/deferred/hidden五种可达策略。
	ToolExposure,
	// 重导出 ToolInfo：不含execute的工具目录元数据。
	ToolInfo,
	// 重导出 ToolLoadout：准备模型布局时的declared/callable/registered集合。
	ToolLoadout,
	// 重导出 ToolLoadoutChanges：工具说明覆盖和隐藏请求声明的布局调整。
	ToolLoadoutChanges,
	// 重导出 ToolNamespace：工具分组名称/别名/短说明/长使用指示。
	ToolNamespace,
	// 重导出 ToolRendererResolver：按工具名解析显示方法、可通过next委托下游的回调。
	ToolRendererResolver,
	// 重导出 ToolRenderers：工具外框/调用/结果三项显示能力子集。
	ToolRenderers,
	// 重导出 ToolRenderResultOptions：结果是否展开和是否部分流式的显示选项。
	ToolRenderResultOptions,
	// 重导出 ToolResultEvent：工具执行后的结果联合，允许逐字段覆盖。
	ToolResultEvent,
	// 重导出 ToolResultEventResult：内容/详情/结构/错误/用量可选覆盖。
	ToolResultEventResult,
	// 重导出 TreePreparation：导航目标/共同祖先/离开分支待摘要条目及指示。
	TreePreparation,
	// 重导出 TurnEndEvent：回合消息/工具结果/日志ID及可调整边界状态。
	TurnEndEvent,
	// 重导出 TurnEndEventResult：回合末边界草稿/继续意图覆盖。
	TurnEndEventResult,
	// 重导出 TurnStartEvent：回合开始的索引与派发毫秒时间戳。
	TurnStartEvent,
	// 重导出 UIPromptEndEvent：最外层阻塞式扩展UI等待结束通知。
	UIPromptEndEvent,
	// 重导出 UIPromptKind：选择/确认/输入/编辑器/自定义阻塞UI种类。
	UIPromptKind,
	// 重导出 UIPromptStartEvent：最外层阻塞式扩展UI等待开始通知。
	UIPromptStartEvent,
	// Events - User Bash
	// 重导出 UserBashEvent：用户!/!!命令接管事件，与模型bash调用不同。
	UserBashEvent,
	// 重导出 UserBashEventResult：自定义operations或现成result二选一接管结果。
	UserBashEventResult,
	// 重导出 WidgetPlacement：编辑器上方/下方两种挂件位置。
	WidgetPlacement,
	// 重导出 WorkingIndicatorOptions：工作指示帧及间隔配置。
	WorkingIndicatorOptions,
	// 重导出 WriteToolCallEvent：write调用前路径/内容参数事件。
	WriteToolCallEvent,
	// 重导出 WriteToolResultEvent：write结果事件，默认details为undefined。
	WriteToolResultEvent,
	// 所有上述事件/上下文/工具声明来自同一types模块，运行时事件聚合仍在runner与宿主中实现。
} from "./types.ts";
// 下面重导出实际可调用辅助函数；类型谓词只按名称判断的边界见各条说明。
// Type guards
// 重导出实际类型谓词与defineTool运行值；取得函数不会立即校验事件或登记工具。
export {
	// 重导出 defineTool：保持独立工具对象泛型推导，运行时仅返回同一引用，不注册或验证。
	defineTool,
	// 重导出 isBashToolResult：仅按bash名称缩小结果类型，不验证详情。
	isBashToolResult,
	// 重导出 isEditToolResult：仅按edit名称缩小结果类型，不验证详情。
	isEditToolResult,
	// 重导出 isFindToolResult：仅按find名称缩小结果类型，不验证详情。
	isFindToolResult,
	// 重导出 isGrepToolResult：仅按grep名称缩小结果类型，不验证详情。
	isGrepToolResult,
	// 重导出 isLsToolResult：仅按ls名称缩小结果类型，不验证详情。
	isLsToolResult,
	// 重导出 isPowerShellToolResult：仅按powershell名称缩小结果类型，不验证详情。
	isPowerShellToolResult,
	// 重导出 isReadToolResult：仅按read名称缩小结果类型，不验证详情。
	isReadToolResult,
	// 重导出 isToolCallEventType：按名称及重载缩小工具输入类型，运行时只比较名字。
	isToolCallEventType,
	// 重导出 isWriteToolResult：仅按write名称缩小结果类型，不验证详情。
	isWriteToolResult,
	// 这些辅助函数也来自types模块；和前面的export type不同，它们编译后仍为可调用导出。
} from "./types.ts";
// 重导出单个/批量工具包装函数：把声明转成执行链接口，不会在导出时运行工具业务。
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";
