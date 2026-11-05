// SDK公共入口：把会话、扩展、工具、运行模式与UI能力集中从同一个包名导出，便于外部程序使用。
// 本文件没有函数体：沿 export ... from 跳到目标文件才是具体实现；下面逐项说明公开能力。
// export type 编译后擦除；export { type A, f } 只保留f运行值。运行值重导出仍参与模块加载，不能理解成整个依赖图零副作用。
// 例如 import { createAgentSession } from "@earendil-works/pi-coding-agent"，再 await createAgentSession({cwd})；取得工厂不等于已发送prompt。
// Core session management

// Args：命令行解析结果类型；type 修饰让它只用于 TS 检查，不成为运行值。
// parseArgs：解析 argv 为选项/位置参数的函数；导出此函数不会自动读取或执行一条 query。
export { type Args, parseArgs } from "./cli/args.ts";

// Config paths
// 配置目录、安装包资源路径和版本，供宿主定位包内文件。
export {
	// 项目配置目录名常量，供路径拼装统一使用。
	CONFIG_DIR_NAME,
	// 取得用户侧 Agent 数据目录的路径辅助，具体环境覆盖规则在 config 中。
	getAgentDir,
	// 定位安装包自带文档，而不是把调用者 cwd 当文档目录。
	getDocsPath,
	// 定位安装包中的示例目录。
	getExamplesPath,
	// 定位当前 Pi 包目录，兼顾源码/安装/打包布局。
	getPackageDir,
	// 定位包内 README 文件。
	getReadmePath,
	// 当前包版本值，不在这里生成或递增版本。
	VERSION,
} from "./config.ts";
// 会话管理及其调用/事件/统计契约，连接SDK与实际多轮执行。
export {
	// 会话管理类：协调 prompt、历史、工具、扩展与压缩；导出类不创建实例。
	AgentSession,
	// 构造会话所需的依赖和配置类型。
	type AgentSessionConfig,
	// 会话对外发布的事件联合，供消费者按 type 分支处理。
	type AgentSessionEvent,
	// 会话事件订阅回调的类型。
	type AgentSessionEventListener,
	// 轮换模型动作返回的结果类型。
	type ModelCycleResult,
	// 从技能包装文字中解析出的路径/正文等结果类型。
	type ParsedSkillBlock,
	// 单次 prompt 的图片、命令/模板展开、来源及忙时排队等选项类型。
	type PromptOptions,
	// 解析技能文字包装的辅助函数，不加载或执行技能代码。
	parseSkillBlock,
	// 会话消息、token、费用等统计结果类型。
	type SessionStats,
} from "./core/agent-session.ts";
// readStoredCredential：从认证存储读取凭证的辅助；真正读取要在调用时发生。
export { readStoredCredential } from "./core/auth-storage.ts";
// CacheWarmingDecision：缓存预热动作的决策数据类型。
// CacheWarmingStatus：预热流程的状态数据类型，不是一次预热已经成功的保证。
export type { CacheWarmingDecision, CacheWarmingStatus } from "./core/cache-warmer.ts";
// Compaction
// 压缩/分支摘要的准备、预算、模型生成与序列化能力。
export {
	// 准备分支摘要时收集的条目与导航材料类型。
	type BranchPreparation,
	// 分支摘要的结果数据类型。
	type BranchSummaryResult,
	// 收集分支条目的结果类型，区别于已调用模型得到的摘要。
	type CollectEntriesResult,
	// 压缩摘要与保留起点等结果类型，不表示删除磁盘历史。
	type CompactionResult,
	// 寻找压缩切点返回的位置和保留信息类型。
	type CutPointResult,
	// 从一份usage取totalTokens，缺省/零时累加输入、输出及缓存分量；不扫描后续消息或执行tokenizer。
	calculateContextTokens,
	// 收集离开分支时需要摘要的条目。
	collectEntriesForBranchSummary,
	// 执行压缩流程的函数，调用时可请求模型生成摘要；这里仅公开它。
	compact,
	// 压缩默认设置值；实际会话可合并用户配置。
	DEFAULT_COMPACTION_SETTINGS,
	// 对消息作本地 token 估算，结果不等于所有模型的精确 tokenizer 计数。
	estimateTokens,
	// 摘要里记录读写文件情况的数据类型，不是文件系统执行接口。
	type FileOperations,
	// 在条目中选择压缩后保留上下文的切点。
	findCutPoint,
	// 寻找某个位置所在轮次的开始索引。
	findTurnStartIndex,
	// 生成分支摘要时的模型、指示和预算等选项类型。
	type GenerateBranchSummaryOptions,
	// 为分支条目生成摘要的异步能力，真正调用时才请求模型。
	generateBranchSummary,
	// 生成压缩摘要文字的函数。
	generateSummary,
	// 生成摘要并附带模型使用量的函数。
	generateSummaryWithUsage,
	// 寻找最近助手消息报告的使用量信息。
	getLastAssistantUsage,
	// 整理供分支摘要使用的条目材料。
	prepareBranchEntries,
	// 把消息整理为摘要模型可读文字，不在这里改写会话日志。
	serializeConversation,
	// 依据上下文预算和设置决定是否建议压缩。
	shouldCompact,
} from "./core/compaction/index.ts";
// createEventBus：创建内存事件总线；导出函数不等于现在创建或派发事件。
// EventBus：订阅/发送事件的公共接口类型。
// EventBusController：供宿主控制事件总线的接口类型。
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
// Extension system
// 扩展的事件/上下文/工具契约及加载、运行、包装能力；type块全部擦除。
export type {
	// 收到供应商HTTP响应、消费响应体前的通知。
	AfterProviderResponseEvent,
	// 活动完成/中止/错误的字符串联合。
	AgentActivityOutcome,
	// 最终收尾前可追加草稿/请求继续的边界事件。
	AgentBeforeSettleEvent,
	// 收尾前边界的可选 entries/continue 覆盖。
	AgentBeforeSettleEventResult,
	// 底层Agent循环结束，之后会话仍可能重试/压缩/续跑。
	AgentEndEvent,
	// 会话活动已稳定、无计划内自动续跑的通知。
	AgentSettledEvent,
	// 底层Agent循环开始通知。
	AgentStartEvent,
	// 工具最终内容/详情/可选结构化输出的泛型类型。
	AgentToolResult,
	// 工具部分结果回调类型。
	AgentToolUpdateCallback,
	// 可配置应用快捷键动作类型。
	AppKeybinding,
	// 输入当前自动补全提供者、返回增强提供者的工厂。
	AutocompleteProviderFactory,
	// bash调用前事件，带命令等具体输入。
	BashToolCallEvent,
	// 空闲自定义消息带triggerTurn启动的前置事件。
	BeforeAgentStartCustomEvent,
	// 用户或自定义消息触发的启动前事件联合。
	BeforeAgentStartEvent,
	// 启动前可追加消息与完整系统提示覆盖。
	BeforeAgentStartEventResult,
	// 用户文字/图片触发的启动前事件。
	BeforeAgentStartUserEvent,
	// 请求发送前原地改请求头，null删除标记，返回值忽略。
	BeforeProviderHeadersEvent,
	// 供应商专用负载改写事件，payload为unknown。
	BeforeProviderRequestEvent,
	// 任意供应商负载替代值，undefined表示不覆盖。
	BeforeProviderRequestEventResult,
	// 候选草稿应用后的投影/消息/待续队列/可继续性预览。
	BoundaryContextPreview,
	// 可选整体草稿列表与继续意图覆盖，非自动追加数组。
	BoundaryResult,
	// 边界当前草稿、继续意图、预览及活动结果。
	BoundaryState,
	// 系统提示构造的原始可选分段/资源/工作目录材料。
	BuildSystemPromptOptions,
	// 核心缓存预热建议及相关状态事件。
	CacheWarmingDecisionEvent,
	// 扩展对预热action的可选覆盖。
	CacheWarmingDecisionEventResult,
	// 待追加压缩草稿，改变投影不删除原日志。
	CompactionEntryDraft,
	// 后台压缩指示及成功/失败回调。
	CompactOptions,
	// 待追加上下文编辑草稿，引用目标条目并替换投影。
	ContextEditEntryDraft,
	// 第一阶段只见非system消息，runner随后恢复系统状态。
	ContextEvent,
	// 可选替代消息列表，空数组也是有效替代。
	ContextEventResult,
	// 上下文token估算/窗口/百分比，未知数值可null。
	ContextUsage,
	// 第二阶段完整transcript，处理器负责保留提示和工具状态。
	ContextWithSystemEvent,
	// 待追加扩展状态草稿，默认不进模型会话。
	CustomEntryDraft,
	// 待追加扩展消息草稿，带可见标记与正文。
	CustomMessageEntryDraft,
	// 自定义任意工具名及unknown参数字典的前置事件。
	CustomToolCallEvent,
	// edit调用前事件，关联批量或单次替换参数。
	EditToolCallEvent,
	// 扩展自定义状态条目的显示回调，不将状态送模型。
	EntryRenderer,
	// 状态条目展开与宿主快捷键显示选项。
	EntryRenderOptions,
	// 进程cwd/signal/timeout/maxBuffer选项，超时单位毫秒。
	ExecOptions,
	// 进程stdout/stderr/code及killed/truncated结果。
	ExecResult,
	// 嵌套工具信号覆盖及部分结果回调。
	ExecuteToolOptions,
	// 已加载扩展的处理器/工具/命令/标志/渲染等注册记录。
	Extension,
	// pi.*会话动作的宿主实现集合。
	ExtensionActions,
	// 工厂收到的事件/工具/资源注册与会话动作接口。
	ExtensionAPI,
	// 普通上下文加等待/新建/分叉/导航/恢复/重载能力。
	ExtensionCommandContext,
	// 命令控制方法的宿主绑定函数集合。
	ExtensionCommandContextActions,
	// 事件处理器的会话读取、UI、取消、压缩上下文。
	ExtensionContext,
	// ctx.*读取与控制能力的宿主绑定集合。
	ExtensionContextActions,
	// 来源路径/事件名/文字/可选堆栈组成的诊断数据。
	ExtensionError,
	// 所有公开扩展事件联合，各事件聚合规则并不相同。
	ExtensionEvent,
	// 接收pi API并同步或异步初始化的函数，加载器等待它。
	ExtensionFactory,
	// CLI参数声明及来源，当前值存共享runtime。
	ExtensionFlag,
	// 事件和上下文输入，可同步/异步返回结果或void的泛型回调。
	ExtensionHandler,
	// 加载状态与宿主动作的组合接口，bindCore后动作可用。
	ExtensionRuntime,
	// 按键组合、说明、处理器与来源记录。
	ExtensionShortcut,
	// 普通上下文加callable工具列表与executeTool嵌套调用。
	ExtensionToolContext,
	// 各模式提供的对话/编辑器/挂件/主题等UI能力契约。
	ExtensionUIContext,
	// 对话框取消信号与超时设置。
	ExtensionUIDialogOptions,
	// 每请求路由时额外收到扩展上下文的虚拟模型声明。
	ExtensionVirtualModel,
	// 编辑器上方/下方挂件位置选项。
	ExtensionWidgetOptions,
	// find调用前事件，带文件名模式及范围参数。
	FindToolCallEvent,
	// grep调用前事件，带搜索表达式和过滤参数。
	GrepToolCallEvent,
	// 裸工厂或带名称/hidden/replaceable/builtin策略的内联声明。
	InlineExtension,
	// 用户输入预处理事件，含文字/图片/来源/队列方式。
	InputEvent,
	// continue/transform/handled判别联合。
	InputEventResult,
	// 交互/RPC/扩展注入三种来源。
	InputSource,
	// 从宿主配置格式化keyText/keyHint的显示方法。
	KeybindingHints,
	// 宿主快捷键配置管理器类型。
	KeybindingsManager,
	// 成功扩展、错误/警告及共享runtime的加载结果。
	LoadExtensionsResult,
	// ls调用前事件，带目录和条数参数。
	LsToolCallEvent,
	// Markdown展示类型、流状态、宽度和可选持久条目信息。
	MarkdownTransformContext,
	// 同步转换交互Markdown显示文字，不直接改模型上下文。
	MarkdownTransformer,
	// 绑定后MCP声明注册表变化，由接管扩展负责连接。
	McpServersChangeEvent,
	// 消息完成事件，可返回同role替代消息。
	MessageEndEvent,
	// 可选最终消息替代，runner要求保持原role。
	MessageEndEventResult,
	// 自定义消息显示组件回调。
	MessageRenderer,
	// 消息展开/留白/宿主快捷键显示选项。
	MessageRenderOptions,
	// 消息开始通知。
	MessageStartEvent,
	// 助手流累计消息与本次标准化增量通知。
	MessageUpdateEvent,
	// 当前聊天模型选中后通知，含之前模型与来源。
	ModelSelectEvent,
	// 直接设置/轮换/恢复模型的来源联合。
	ModelSelectSource,
	// 已补齐集合字段、供扩展共同修改的提示构造选项。
	NormalizedBuildSystemPromptOptions,
	// PowerShell工具调用前具体参数事件。
	PowerShellToolCallEvent,
	// 项目信任阶段只提供目录/模式/有限对话方法的上下文。
	ProjectTrustContext,
	// 项目本地资源加载前的信任决策事件。
	ProjectTrustEvent,
	// yes/no/undecided信任决定联合。
	ProjectTrustEventDecision,
	// 信任决定及可选记住标记。
	ProjectTrustEventResult,
	// 接信任事件/受限上下文、同步或异步返回决定的处理器。
	ProjectTrustHandler,
	// 兼容式供应商模型/流/认证等能力声明，注册不等于请求。
	ProviderConfig,
	// 聊天/图像/分类模型配置联合。
	ProviderModelConfig,
	// 适配器解析后、标准化前的原生供应商流观察事件。
	ProviderStreamEvent,
	// read调用前事件，带路径和行区间。
	ReadToolCallEvent,
	// 原命令名/来源/参数补全/执行处理器记录。
	RegisteredCommand,
	// 工具定义及来源记录。
	RegisteredTool,
	// 原命令加冲突解析后的唯一调用名。
	ResolvedCommand,
	// 启动/重载后补充技能/提示/主题路径事件。
	ResourcesDiscoverEvent,
	// 三类可选额外资源路径。
	ResourcesDiscoverResult,
	// 压缩准备材料、原因/重试标志/取消信号的前置事件。
	SessionBeforeCompactEvent,
	// 取消或整份自定义摘要结果。
	SessionBeforeCompactResult,
	// 分叉锚点和位置的前置事件。
	SessionBeforeForkEvent,
	// 分叉取消结果，skipConversationRestore当前会话路径未使用。
	SessionBeforeForkResult,
	// 新建/恢复会话前的可取消事件。
	SessionBeforeSwitchEvent,
	// 可选取消标记。
	SessionBeforeSwitchResult,
	// 导航前的准备材料与取消信号。
	SessionBeforeTreeEvent,
	// 可取消/自定义摘要/指示/标签的导航覆盖。
	SessionBeforeTreeResult,
	// 边界允许的状态/消息/上下文编辑/压缩草稿联合。
	SessionBoundaryDraft,
	// 成功追加压缩条目后通知。
	SessionCompactEvent,
	// 压缩失败/取消后通知，willRetry表示原计划而非已重试。
	SessionCompactFailedEvent,
	// 规范化会话名称变化通知。
	SessionInfoChangedEvent,
	// 退出/重载/会话替换前清理通知。
	SessionShutdownEvent,
	// 会话启动/新建/恢复/分叉/重载后通知。
	SessionStartEvent,
	// 树导航完成后的新旧叶节点和可选分支摘要。
	SessionTreeEvent,
	// 斜杠命令的公开描述类型，用于命令目录和UI显示。
	SlashCommandInfo,
	// 斜杠命令来自内置/扩展/模板等位置的来源类型。
	SlashCommandSource,
	// 工具/命令/资源的来源描述类型，便于诊断和显示。
	SourceInfo,
	// 原始终端输入回调，可拦截或改写键数据。
	TerminalInputHandler,
	// 思考档位选中后的新旧值通知。
	ThinkingLevelSelectEvent,
	// 作者未验证的只读/破坏/幂等/开放世界提示。
	ToolAnnotations,
	// 工具执行前联合，input可原地改且之后不再校验。
	ToolCallEvent,
	// 阻止调用、原因及批次终止提示。
	ToolCallEventResult,
	// 参数schema、execute、暴露/并发/显示等完整工具声明。
	ToolDefinition,
	// 工具执行结束结果及可选实际耗时通知。
	ToolExecutionEndEvent,
	// 顺序/并行工具调度策略类型。
	ToolExecutionMode,
	// 工具开始执行通知，含调用/可选父调用ID。
	ToolExecutionStartEvent,
	// 工具部分输出通知，含调用/可选父调用ID。
	ToolExecutionUpdateEvent,
	// direct/model-only/codemode/deferred/hidden五种可达策略。
	ToolExposure,
	// 不含execute的工具目录元数据。
	ToolInfo,
	// 准备模型布局时的declared/callable/registered集合。
	ToolLoadout,
	// 工具说明覆盖和隐藏请求声明的布局调整。
	ToolLoadoutChanges,
	// 工具分组名称/别名/短说明/长使用指示。
	ToolNamespace,
	// 按工具名解析显示方法、可通过next委托下游的回调。
	ToolRendererResolver,
	// 工具外框/调用/结果三项显示能力子集。
	ToolRenderers,
	// 结果是否展开和是否部分流式的显示选项。
	ToolRenderResultOptions,
	// 工具执行后的结果联合，允许逐字段覆盖。
	ToolResultEvent,
	// 内容/详情/结构/错误/用量可选覆盖。
	ToolResultEventResult,
	// 回合消息/工具结果/日志ID及可调整边界状态。
	TurnEndEvent,
	// 回合末边界草稿/继续意图覆盖。
	TurnEndEventResult,
	// 回合开始的索引与派发毫秒时间戳。
	TurnStartEvent,
	// 最外层阻塞式扩展UI等待结束通知。
	UIPromptEndEvent,
	// 选择/确认/输入/编辑器/自定义阻塞UI种类。
	UIPromptKind,
	// 最外层阻塞式扩展UI等待开始通知。
	UIPromptStartEvent,
	// 用户!/!!命令接管事件，与模型bash调用不同。
	UserBashEvent,
	// 自定义operations或现成result二选一接管结果。
	UserBashEventResult,
	// 编辑器上方/下方两种挂件位置。
	WidgetPlacement,
	// 工作指示帧及间隔配置。
	WorkingIndicatorOptions,
	// write调用前路径/内容参数事件。
	WriteToolCallEvent,
} from "./core/extensions/index.ts";
// 扩展的事件/上下文/工具契约及加载、运行、包装能力；type块全部擦除。
export {
	// 创建共享未绑定运行时，多数会话动作初始为抛错桩，注册供应商可先排队。
	createExtensionRuntime,
	// 保持独立工具对象泛型推导，运行时仅返回同一引用，不注册或验证。
	defineTool,
	// 从项目/全局/显式路径发现并按序加载扩展，单文件错误汇总。
	discoverAndLoadExtensions,
	// 把宿主能力绑定给扩展并按事件规则调度处理器的运行器类。
	ExtensionRunner,
	// 仅按bash名称缩小结果类型，不验证详情。
	isBashToolResult,
	// 仅按edit名称缩小结果类型，不验证详情。
	isEditToolResult,
	// 仅按find名称缩小结果类型，不验证详情。
	isFindToolResult,
	// 仅按grep名称缩小结果类型，不验证详情。
	isGrepToolResult,
	// 仅按ls名称缩小结果类型，不验证详情。
	isLsToolResult,
	// 仅按powershell名称缩小结果类型，不验证详情。
	isPowerShellToolResult,
	// 仅按read名称缩小结果类型，不验证详情。
	isReadToolResult,
	// 按名称及重载缩小工具输入类型，运行时只比较名字。
	isToolCallEventType,
	// 仅按write名称缩小结果类型，不验证详情。
	isWriteToolResult,
	// 把一个注册工具声明包装为Agent执行接口，不在包装时执行工具业务。
	wrapRegisteredTool,
	// 批量包装注册工具，供Agent工具执行链使用。
	wrapRegisteredTools,
} from "./core/extensions/index.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
// ReadonlyFooterDataProvider：扩展只读的 Git 分支/状态等页脚数据接口，readonly 不是冻结数据。
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
// RegisteredMcpServer：已登记 MCP 服务器的声明数据类型；声明不等于连接已建立。
export type { RegisteredMcpServer } from "./core/mcp-servers.ts";
// convertToLlm：把 Agent/会话自定义消息转换成模型消息的默认转换函数。
export { convertToLlm } from "./core/messages.ts";
// ModelRegistry：模型与供应商的注册/解析管理类，不在导出时选择某个聊天模型。
export { ModelRegistry } from "./core/model-registry.ts";
// 命令行模型与模型范围解析，连同诊断结果一起公开。
export {
	// 模型范围解析过程中产生的诊断类型。
	type ModelScopeDiagnostic,
	// 命令行模型参数解析结果类型。
	type ResolveCliModelResult,
	// 解析模型范围所得模型与诊断的结果类型。
	type ResolveModelScopeResult,
	// 解析命令行模型标识与可选思考档位。
	resolveCliModel,
	// 解析/筛选模型范围，并保留需要向用户解释的诊断。
	resolveModelScopeWithDiagnostics,
	// 模型与该范围相关思考档位等信息的组合类型。
	type ScopedModel,
} from "./core/model-resolver.ts";
// 模型运行层及认证覆盖/凭证同步错误。
export {
	// 创建模型运行层所需的提供商/认证等选项类型。
	type CreateModelRuntimeOptions,
	// 凭证同步失败的错误类；公开类本身不会触发同步。
	CredentialSynchronizationError,
	// 标明哪类凭证同步操作失败的类型。
	type CredentialSynchronizationOperation,
	// 统一管理模型/供应商及其认证状态的运行层类。
	ModelRuntime,
	// 单次getAuth认证解析的覆盖选项类型，含key/环境/有效期/signal，可能触发OAuth刷新。
	type ModelRuntimeAuthOverrides,
} from "./core/model-runtime.ts";
// 包管理接口、资源解析结果与进度契约；此type块不生成运行值。
export type {
	// 包安装失败的结构化记录类型。
	PackageInstallFailure,
	// 包来源解析/安装/更新等能力接口，不是接口声明时执行安装。
	PackageManager,
	// 解析路径的来源等附属信息类型。
	PathMetadata,
	// 包管理进度观察回调类型。
	ProgressCallback,
	// 包管理进度事件数据类型。
	ProgressEvent,
	// 资源路径解析的汇总结果类型。
	ResolvedPaths,
	// 单个已解析资源及其来源等信息类型。
	ResolvedResource,
} from "./core/package-manager.ts";
// DefaultPackageManager：包管理默认实现类；实例方法被调用时才执行相应安装等操作。
export { DefaultPackageManager } from "./core/package-manager.ts";
// ResourceCollision：资源加载时的命名冲突记录类型。
// ResourceDiagnostic：资源发现/加载中的诊断数据类型。
// ResourceLoader：向会话提供技能、提示词、扩展等资源的接口类型。
export type { ResourceCollision, ResourceDiagnostic, ResourceLoader } from "./core/resource-loader.ts";
// DefaultResourceLoader：资源加载默认实现，不因为导出就主动重载所有项目资源。
// loadProjectContextFiles：加载项目上下文文件的函数，文件 I/O 在实际调用时发生。
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
// SDK for programmatic usage
// SDK会话/服务/运行层工厂，以及可绑定工作目录的工具工厂。
export {
	// 把会话服务与运行模式所需能力协调起来的类。
	AgentSessionRuntime,
	// 会话运行层初始化/装配过程的诊断类型。
	type AgentSessionRuntimeDiagnostic,
	// 可复用的模型/认证/设置/资源等会话服务集合类型。
	type AgentSessionServices,
	// 复用已有服务创建会话的选项类型。
	type CreateAgentSessionFromServicesOptions,
	// SDK一站式创建会话的选项类型。
	type CreateAgentSessionOptions,
	// 会话创建成功后的返回结果类型。
	type CreateAgentSessionResult,
	// 注入自定义会话运行层工厂的函数类型。
	type CreateAgentSessionRuntimeFactory,
	// 运行层工厂的返回结果类型。
	type CreateAgentSessionRuntimeResult,
	// 单独创建服务集合的选项类型。
	type CreateAgentSessionServicesOptions,
	// Factory
	// SDK主工厂，返回含session的结果对象；例如 const {session} = await createAgentSession({cwd})，再 await session.prompt('解释代码')。
	createAgentSession,
	// 用现有服务集合创建会话，避免每次从零组装相同服务。
	createAgentSessionFromServices,
	// 创建/装配会话运行层的工厂。
	createAgentSessionRuntime,
	// 先单独装配会话依赖服务，供后续会话使用。
	createAgentSessionServices,
	// 按工作目录等配置创建可执行的 bash Agent 工具，尚不运行某条命令。
	createBashTool,
	// Tool factories (for custom cwd)
	// 创建默认编码工具集合，可显式指定工具工作目录。
	createCodingTools,
	// 创建文件替换编辑工具，真正替换发生在工具执行时。
	createEditTool,
	// 创建按文件名模式查找的工具。
	createFindTool,
	// 创建搜索文件正文的工具。
	createGrepTool,
	// 创建列目录工具。
	createLsTool,
	// 创建 PowerShell 命令工具，创建声明不等执行用户命令。
	createPowerShellTool,
	// 创建只读工具集合；具体成员由工厂定义，不是给所有代码装上只读沙箱。
	createReadOnlyTools,
	// 创建文件读取工具。
	createReadTool,
	// 创建文件写入工具，导出不写文件。
	createWriteTool,
	// 提示词模板的内容和来源等描述类型。
	type PromptTemplate,
} from "./core/sdk.ts";
// 会话文件版本、日志条目、树与投影，以及读取恢复能力。
export {
	// 会话树中的分支摘要日志条目类型。
	type BranchSummaryEntry,
	// 从条目构造模型上下文使用的条目投影。
	buildContextEntries,
	// 从会话记录构造消息、模型和思考档位等上下文。
	buildSessionContext,
	// 构造会话投影，应用上下文编辑等日志语义。
	buildSessionProjection,
	// 压缩日志条目，包含摘要与保留起点。
	type CompactionEntry,
	// 允许被上下文编辑条目替换的内容类型。
	type ContextEditableContent,
	// 通过追加日志修改上下文投影的条目类型，不要求删除旧条目。
	type ContextEditEntry,
	// 当前会话文件格式版本常量。
	CURRENT_SESSION_VERSION,
	// 扩展持久化状态条目类型，区别于默认进入模型的消息。
	type CustomEntry,
	// 扩展自定义消息日志条目类型。
	type CustomMessageEntry,
	// 会话文件中头部或日志条目组成的联合类型。
	type FileEntry,
	// 查找最近压缩条目的辅助函数。
	getLatestCompactionEntry,
	// 记录切换模型的日志条目类型。
	type ModelChangeEntry,
	// 迁移已有会话条目格式的函数；仅导出不会自动重写用户文件。
	migrateSessionEntries,
	// 会话管理器新建会话的选项类型。
	type NewSessionOptions,
	// 应用投影后供上下文构建使用的条目类型。
	type ProjectedSessionEntry,
	// 解析会话文本/条目的辅助函数；解析不是请求聊天模型。
	parseSessionEntries,
	// 从会话历史恢复出的上下文结果类型。
	type SessionContext,
	// 会话所有具体日志条目的判别联合，可按 type 区分。
	type SessionEntry,
	// 日志条目共有的 id、parentId、时间等基础字段类型。
	type SessionEntryBase,
	// JSONL会话文件头类型，区别于有父节点的消息条目。
	type SessionHeader,
	// 供会话列表使用的概要信息类型。
	type SessionInfo,
	// 记录会话名称等信息变化的条目类型。
	type SessionInfoEntry,
	// 管理会话日志/树/恢复/分叉/持久化的类。
	SessionManager,
	// 包含一条 Agent 消息的会话日志条目类型。
	type SessionMessageEntry,
	// 会话投影的结果结构类型。
	type SessionProjection,
	// 包含子节点的会话树节点类型，不等于一条线性消息。
	type SessionTreeNode,
	// 把单个SessionEntry转成零/多条Agent运行时消息，不选择分支或应用context_edit；之后再经convertToLlm适配模型。
	sessionEntryToContextMessages,
	// 思考档位变化的日志条目类型。
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.ts";
// 设置管理器及不同功能所用的配置类型。
export {
	// 缓存预热模式设置类型。
	type CacheWarmingMode,
	// 压缩使用模型的覆盖配置类型。
	type CompactionModelOverride,
	// 自动压缩开关、预算/保留等配置类型。
	type CompactionSettings,
	// 项目默认信任策略类型。
	type DefaultProjectTrust,
	// 全屏交互退出后输出策略类型。
	type FullscreenExitOutput,
	// 图片处理/展示相关设置类型。
	type ImageSettings,
	// 包来源的配置表示类型。
	type PackageSource,
	// 控制启动展示的设置类型。
	type QuietStartup,
	// 自动重试的启用、次数/延迟等配置类型。
	type RetrySettings,
	// 读取、合并和保存用户/项目设置的管理类。
	SettingsManager,
	// 创建设置管理器时的配置类型。
	type SettingsManagerCreateOptions,
	// 交互终端运行模式的设置类型。
	type TuiMode,
} from "./core/settings-manager.ts";
// Skills
// 技能发现、加载和提示词目录格式化。
export {
	// 把技能目录信息整理进提示词，不是立即执行每份技能正文。
	formatSkillsForPrompt,
	// 从一个目录发现技能的选项类型。
	type LoadSkillsFromDirOptions,
	// 技能加载结果及诊断的类型。
	type LoadSkillsResult,
	// 按资源路径和工作目录等规则收集技能。
	loadSkills,
	// 从指定目录加载技能文件的函数。
	loadSkillsFromDir,
	// 技能名称、说明、路径等元数据类型。
	type Skill,
	// 技能Markdown头部元数据的类型。
	type SkillFrontmatter,
} from "./core/skills.ts";
// createSyntheticSourceInfo：为内联/合成资源创建来源描述，不假装它来自真实磁盘文件。
export { createSyntheticSourceInfo } from "./core/source-info.ts";
// EditDiffResult：编辑差异展示的结果类型。
// generateDiffString：返回含diff文字和firstChangedLine的对象，区别于直接返回patch字符串。
// generateUnifiedPatch：生成 unified patch 格式差异文字。
export { type EditDiffResult, generateDiffString, generateUnifiedPatch } from "./core/tools/edit-diff.ts";
// Tools
// 内置工具声明工厂、可注入底层操作与输出裁剪。
export {
	// bash工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type BashOperations,
	// Bash启动钩子接收的命令/cwd/环境上下文类型。
	type BashSpawnContext,
	// 调整Bash进程启动信息的钩子类型；接口存在不代表钩子已运行。
	type BashSpawnHook,
	// bash工具输出附带的结构化详情类型。
	type BashToolDetails,
	// bash工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type BashToolInput,
	// 创建bash工具时的实现/行为选项类型。
	type BashToolOptions,
	// 创建bash工具的扩展式声明，执行仍由后续execute调用触发。
	createBashToolDefinition,
	// 创建文件替换工具的扩展式声明，执行仍由后续execute调用触发。
	createEditToolDefinition,
	// 创建文件名查找工具的扩展式声明，执行仍由后续execute调用触发。
	createFindToolDefinition,
	// 创建正文搜索工具的扩展式声明，执行仍由后续execute调用触发。
	createGrepToolDefinition,
	// 创建本机Bash操作实现，真正进程执行发生在操作方法被调用时。
	createLocalBashOperations,
	// 创建本机PowerShell操作实现，真正进程执行发生在操作方法被调用时。
	createLocalPowerShellOperations,
	// 创建目录列举工具的扩展式声明，执行仍由后续execute调用触发。
	createLsToolDefinition,
	// 创建PowerShell工具的扩展式声明，执行仍由后续execute调用触发。
	createPowerShellToolDefinition,
	// 创建文件读取工具的扩展式声明，执行仍由后续execute调用触发。
	createReadToolDefinition,
	// 创建文件写入工具的扩展式声明，执行仍由后续execute调用触发。
	createWriteToolDefinition,
	// 工具输出默认字节预算值；不表示任意进程总内存受此限制。
	DEFAULT_MAX_BYTES,
	// 工具输出默认行数预算值。
	DEFAULT_MAX_LINES,
	// 文件替换工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type EditOperations,
	// 文件替换工具输出附带的结构化详情类型。
	type EditToolDetails,
	// 文件替换工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type EditToolInput,
	// 创建文件替换工具时的实现/行为选项类型。
	type EditToolOptions,
	// 文件名查找工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type FindOperations,
	// 文件名查找工具输出附带的结构化详情类型。
	type FindToolDetails,
	// 文件名查找工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type FindToolInput,
	// 创建文件名查找工具时的实现/行为选项类型。
	type FindToolOptions,
	// 把字节大小格式化成易读文字。
	formatSize,
	// 正文搜索工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type GrepOperations,
	// 正文搜索工具输出附带的结构化详情类型。
	type GrepToolDetails,
	// 正文搜索工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type GrepToolInput,
	// 创建正文搜索工具时的实现/行为选项类型。
	type GrepToolOptions,
	// 目录列举工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type LsOperations,
	// 目录列举工具输出附带的结构化详情类型。
	type LsToolDetails,
	// 目录列举工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type LsToolInput,
	// 创建目录列举工具时的实现/行为选项类型。
	type LsToolOptions,
	// PowerShell工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type PowerShellOperations,
	// PowerShell启动钩子接收的命令/cwd/环境上下文类型。
	type PowerShellSpawnContext,
	// 调整PowerShell进程启动信息的钩子类型；接口存在不代表钩子已运行。
	type PowerShellSpawnHook,
	// PowerShell工具输出附带的结构化详情类型。
	type PowerShellToolDetails,
	// PowerShell工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type PowerShellToolInput,
	// 创建PowerShell工具时的实现/行为选项类型。
	type PowerShellToolOptions,
	// 文件读取工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type ReadOperations,
	// 文件读取工具输出附带的结构化详情类型。
	type ReadToolDetails,
	// 文件读取工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type ReadToolInput,
	// 创建文件读取工具时的实现/行为选项类型。
	type ReadToolOptions,
	// 批量创建工具时的共享配置类型。
	type ToolsOptions,
	// 输出裁剪时使用的行数/字节等选项类型。
	type TruncationOptions,
	// 裁剪后的文字与截断原因/统计等结果类型。
	type TruncationResult,
	// 从输出头部保留预算内内容的函数。
	truncateHead,
	// 对单行显示文字进行裁剪的函数。
	truncateLine,
	// 从输出尾部保留预算内内容的函数。
	truncateTail,
	// 文件写入工具依赖的底层操作接口，可注入实现；声明类型不会执行操作。
	type WriteOperations,
	// 文件写入工具参数类型；运行时参数校验由工具schema/调度路径负责。
	type WriteToolInput,
	// 创建文件写入工具时的实现/行为选项类型。
	type WriteToolOptions,
	// 让同路径文件修改按队列协调的包装函数，不提供跨进程事务或回滚。
	withFileMutationQueue,
} from "./core/tools/index.ts";
// formatReadLineRange：格式化 read 工具的行区间显示文字。
export { formatReadLineRange } from "./core/tools/render-utils.ts";
// 项目资源探测与持久信任决定，区别于扩展信任事件的返回值。
export {
	// 探测需项目信任的资源入口是否存在，不在导出时加载或执行扩展。
	hasTrustRequiringProjectResources,
	// true同意/false拒绝/null未独立决定的类型，与扩展yes/no/undecided类型不同。
	type ProjectTrustDecision,
	// 同步读改写 trust.json 并查询祖先继承决定的类。
	ProjectTrustStore,
	// 查询实际命中的路径与布尔决定类型，可能来自祖先目录。
	type ProjectTrustStoreEntry,
	// 待保存的路径/决定更新类型，null表示删除独立记录。
	type ProjectTrustUpdate,
} from "./core/trust-manager.ts";
// 虚拟模型路由输入/输出、定义与会话状态。
export {
	// 虚拟模型一次路由选出的目标信息类型。
	type ModelRoute,
	// 触发模型路由的原因类型。
	type ModelRouteReason,
	// 交给虚拟模型路由器的请求材料类型。
	type ModelRouteRequest,
	// 虚拟模型状态使用的自定义会话条目名称常量。
	VIRTUAL_MODEL_STATE_ENTRY,
	// 虚拟模型元数据与路由能力的声明类型。
	type VirtualModelDefinition,
	// 保存在会话自定义条目中的虚拟模型状态类型。
	type VirtualModelStateData,
} from "./core/virtual-models.ts";
// Built-in extensions. The CLI loads them; SDK sessions add them to their extension factories.
// CodemodeExtensionOptions：内置代码执行扩展的创建选项类型。
// createCodemodeExtension：创建codemode扩展工厂，具体注册随扩展加载发生。
export { type CodemodeExtensionOptions, createCodemodeExtension } from "./extensions/codemode/index.ts";
// CodemodeStoreEntryData：代码执行扩展持久化状态的数据类型。
// CodemodeToolDetails：代码执行工具返回的详情类型。
export type { CodemodeStoreEntryData, CodemodeToolDetails } from "./extensions/codemode/tool.ts";
// LoadedMcpConfig：合并/加载后的MCP配置结果类型。
// McpExposure：MCP工具如何暴露给模型/代码调用的策略类型。
// McpServerConfig：单个MCP服务器配置的类型。
// McpServerEntry：带来源等信息的MCP服务器声明条目类型。
export type { LoadedMcpConfig, McpExposure, McpServerConfig, McpServerEntry } from "./extensions/mcp/config.ts";
// createMcpExtension：创建接管MCP连接/工具注册的扩展工厂，不是在此立即启动服务器。
// McpExtensionOptions：MCP扩展的配置/回调等创建选项类型。
// McpTransportFactory：注入MCP传输实现的工厂函数类型。
export { createMcpExtension, type McpExtensionOptions, type McpTransportFactory } from "./extensions/mcp/index.ts";
// createToolSearchExtension：创建工具目录搜索扩展工厂。
export { createToolSearchExtension } from "./extensions/tool-search/index.ts";
// Main entry point
// MainOptions：启动CLI主流程时的宿主选项类型。
// main：CLI总入口函数，调用后才解析启动流程；SDK import不会替你调用 main。
export { type MainOptions, main } from "./main.ts";
// Run modes for programmatic SDK usage
// 交互、打印和RPC三种宿主运行模式及协议类型。
export {
	// 交互终端模式实现类，需要实例与run等调用进入交互。
	InteractiveMode,
	// 交互模式创建配置类型。
	type InteractiveModeOptions,
	// 供JSON模式输出的会话事件类型。
	type JsonAgentSessionEvent,
	// RPC等输出使用的模型信息类型。
	type ModelInfo,
	// 一次性/流式打印模式的运行选项类型。
	type PrintModeOptions,
	// 通过子进程JSONL控制Pi的客户端类，不等于MCP客户端。
	RpcClient,
	// RPC客户端启动/配置选项类型。
	type RpcClientOptions,
	// RPC命令协议的判别联合类型。
	type RpcCommand,
	// RPC事件订阅回调类型。
	type RpcEventListener,
	// RPC向宿主请求扩展UI交互的协议类型。
	type RpcExtensionUIRequest,
	// 宿主回应扩展UI请求的协议类型。
	type RpcExtensionUIResponse,
	// RPC命令回应的协议联合类型。
	type RpcResponse,
	// RPC查询会话状态得到的数据类型。
	type RpcSessionState,
	// 运行打印模式的异步入口，可能真正请求模型，不在重导出时执行。
	runPrintMode,
	// 运行JSONL RPC服务循环的入口，需显式调用。
	runRpcMode,
} from "./modes/index.ts";
// UI components for extensions
// 可供扩展复用的终端组件与显示辅助。
export {
	// 交互界面中的Armin装饰组件类。
	ArminComponent,
	// 展示助手文字/思考等内容的组件类。
	AssistantMessageComponent,
	// 展示用户bash执行过程与输出的组件类。
	BashExecutionComponent,
	// 可展示边框与取消提示的加载组件类。
	BorderedLoader,
	// 展示会话分支摘要的组件类。
	BranchSummaryMessageComponent,
	// 展示上下文压缩摘要的组件类。
	CompactionSummaryMessageComponent,
	// 接上宿主快捷键的自定义编辑器基类。
	CustomEditor,
	// 自定义编辑器创建选项类型。
	type CustomEditorOptions,
	// 展示扩展自定义消息的组件类。
	CustomMessageComponent,
	// 渲染时按当前主题生成边框的组件类。
	DynamicBorder,
	// 扩展多行文字编辑对话组件类。
	ExtensionEditorComponent,
	// 扩展单行输入组件类。
	ExtensionInputComponent,
	// 扩展选项选择组件类。
	ExtensionSelectorComponent,
	// 展示会话状态/统计等底部信息的组件类。
	FooterComponent,
	// 结合当前快捷键配置与说明生成提示文字。
	keyHint,
	// 把快捷键动作映射成可读的按键文字。
	keyText,
	// 展示认证入口/登录交互的组件类，导出不发起登录。
	LoginDialogComponent,
	// 模型选择组件类。
	ModelSelectorComponent,
	// OAuth供应商选择组件类。
	OAuthSelectorComponent,
	// 差异显示选项类型；目前只有未参与渲染的可选filePath，不控制主题或行号。
	type RenderDiffOptions,
	// 为原始按键值生成说明提示的函数。
	rawKeyHint,
	// 把差异文本转为终端展示文字。
	renderDiff,
	// 会话列表/搜索/选择组件类。
	SessionSelectorComponent,
	// 设置UI把用户修改交给宿主的回调类型。
	type SettingsCallbacks,
	// 构造设置UI所需的当前配置类型。
	type SettingsConfig,
	// 设置菜单组件类，具体修改由宿主回调接收。
	SettingsSelectorComponent,
	// 控制图片显示的选择组件类。
	ShowImagesSelectorComponent,
	// 展示技能调用来源与内容的消息组件类。
	SkillInvocationMessageComponent,
	// 主题列表/预览/选择组件类。
	ThemeSelectorComponent,
	// 思考档位选择组件类。
	ThinkingSelectorComponent,
	// 显示工具调用、流式更新和结果的组件类，不负责代替Agent调度执行。
	ToolExecutionComponent,
	// 工具执行显示组件的配置类型。
	type ToolExecutionOptions,
	// 会话树导航/筛选/分支选择组件类。
	TreeSelectorComponent,
	// 按终端实际折行后的可见行数裁剪文字。
	truncateToVisualLines,
	// 展示用户消息的组件类。
	UserMessageComponent,
	// 选择用户消息作为分叉位置的组件类。
	UserMessageSelectorComponent,
	// 可见行裁剪后的文字/是否裁剪等结果类型。
	type VisualTruncateResult,
} from "./modes/interactive/components/index.ts";
// Theme utilities for custom tools and extensions
// 主题类、token类型及代码/Markdown/列表显示适配。
export {
	// 按文件路径推测代码高亮语言。
	getLanguageFromPath,
	// 生成Markdown显示所需的主题方法集合。
	getMarkdownTheme,
	// 生成选择列表使用的主题配置。
	getSelectListTheme,
	// 生成设置列表使用的主题配置。
	getSettingsListTheme,
	// 将代码高亮为终端ANSI显示文字。
	highlightCode,
	// 初始化共享主题状态的函数，不是在这条导出语句中调用它。
	initTheme,
	// 按token和样式生成终端文字的主题类。
	Theme,
	// 明/暗外观类型。
	type ThemeAppearance,
	// 背景颜色token的类型。
	type ThemeBg,
	// 前景颜色token的类型。
	type ThemeColor,
	// 文字样式对象接口，含粗体等属性和可选fg/bg；颜色可用对应槽位token或Color值，不是样式名联合。
	type ThemeStyle,
	// 主题颜色token名称的联合类型。
	type ThemeToken,
} from "./modes/interactive/theme/theme.ts";
// Clipboard utilities
// copyToClipboard：复制文字到系统剪贴板的辅助函数，仅在调用时产生系统副作用。
export { copyToClipboard } from "./utils/clipboard.ts";
// parseFrontmatter：解析Markdown开头的YAML元数据与正文。
// stripFrontmatter：去掉Markdown头部元数据，取得正文。
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
// convertToPng：将支持的图片输入转换成PNG的异步辅助。
export { convertToPng } from "./utils/image-convert.ts";
// formatDimensionNote：生成图片处理前后尺寸说明文字。
// ResizedImage：图片缩放/编码后的结果数据类型。
// resizeImage：按尺寸约束处理图片的异步辅助函数。
export { formatDimensionNote, type ResizedImage, resizeImage } from "./utils/image-resize.ts";
// detectSupportedImageMimeTypeFromFile：根据本地文件内容识别支持的图片MIME，调用时读取文件。
export { detectSupportedImageMimeTypeFromFile } from "./utils/mime.ts";
// Shell utilities
// getPowerShellConfig：取得PowerShell进程启动所需的shell/参数配置。
// getShellConfig：按显式路径、平台Bash探测及回退规则取得shell/argv配置，不等于读取用户登录shell。
export { getPowerShellConfig, getShellConfig } from "./utils/shell.ts";
