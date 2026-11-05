// 为各运行模式汇总core公共入口；重导出不是创建会话或执行命令，运行值与type导出的加载影响不同。
/**
 * Core modules shared between all run modes.
 */

export {
	// 会话管理类，组合Agent、记录、扩展、压缩、模型选择等能力。
	AgentSession,
	// 构造会话所需的依赖/初始配置类型。
	type AgentSessionConfig,
	// 宿主可订阅的会话事件联合。
	type AgentSessionEvent,
	// 会话事件监听器签名。
	type AgentSessionEventListener,
	// 循环切换模型的返回信息类型。
	type ModelCycleResult,
	// 提交输入时的会话选项类型。
	type PromptOptions,
	// 会话统计结果类型。
	type SessionStats,
} from "./agent-session.ts";
// 运行时装配层：创建时处理启动/资源/会话边界，避免调用方自行拼所有依赖。
export {
	// 运行时对象本身的运行值。
	AgentSessionRuntime,
	// 可注入的运行时创建工厂签名。
	type CreateAgentSessionRuntimeFactory,
	// 创建结果类型，含运行时与诊断等装配信息。
	type CreateAgentSessionRuntimeResult,
	// 实际创建入口函数；只有调用才开始装配。
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
// 服务层把资源、认证、设置等依赖复用给具体会话。
export {
	// 启动/资源装配的诊断类型。
	type AgentSessionRuntimeDiagnostic,
	// 可复用服务集合的类型。
	type AgentSessionServices,
	// 用已有服务创建会话的输入类型。
	type CreateAgentSessionFromServicesOptions,
	// 创建服务集合时的输入类型。
	type CreateAgentSessionServicesOptions,
	// 用既有服务创建会话的运行值。
	createAgentSessionFromServices,
	// 创建服务集合的运行值。
	createAgentSessionServices,
} from "./agent-session-services.ts";
// Bash执行包装的选项/结果是类型，executeBashWithOperations才是可调用函数。
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
// 仅导出预热决定/状态类型，不通过此行运行一次预热。
export type { CacheWarmingDecision, CacheWarmingStatus } from "./cache-warmer.ts";
// 压缩结果类型，不把模型摘要请求当作导入时副作用。
export type { CompactionResult } from "./compaction/index.ts";
// 工厂是运行值，两个接口只参与编译期检查。
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
// 调用时读取实验开关的运行值。
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
// 下列type项都只导出契约；defineTool/发现函数/Runner是运行值，具体实现在扩展子入口。
export {
	// 一次Agent活动的结局分类。
	type AgentActivityOutcome,
	// 即将结束活动的事件输入。
	type AgentBeforeSettleEvent,
	// 对结束前事件的处理结果。
	type AgentBeforeSettleEventResult,
	// Agent结束事件契约。
	type AgentEndEvent,
	// 活动已稳定结束的事件契约。
	type AgentSettledEvent,
	// Agent开始事件契约。
	type AgentStartEvent,
	// 工具输出的结构类型。
	type AgentToolResult,
	// 工具流式局部更新回调签名。
	type AgentToolUpdateCallback,
	// 开始前扩展钩子的输入/结果分别导出。
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	// 边界阶段预览、结果和状态的类型，不是可调用的流程函数。
	type BoundaryContextPreview,
	type BoundaryResult,
	type BoundaryState,
	// 系统提示词构造选项。
	type BuildSystemPromptOptions,
	// 预热决策事件及返回值，不在重导出时发网络请求。
	type CacheWarmingDecisionEvent,
	type CacheWarmingDecisionEventResult,
	// 在会话边界提交的压缩/上下文编辑草稿类型。
	type CompactionEntryDraft,
	type ContextEditEntryDraft,
	// 上下文处理事件，有普通和含system消息两种契约。
	type ContextEvent,
	type ContextWithSystemEvent,
	// 自定义条目/消息的草稿数据类型。
	type CustomEntryDraft,
	type CustomMessageEntryDraft,
	// 辅助定义工具并保留推导类型；定义不等于执行或注册工具。
	defineTool,
	// 发现并加载扩展的函数，调用时可能执行扩展初始化。
	discoverAndLoadExtensions,
	// 扩展执行本地命令的选项/结果契约。
	type ExecOptions,
	type ExecResult,
	// 一份已加载扩展及其面向作者的API/上下文契约。
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	// 扩展错误、事件、工厂、标志和处理器签名。
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	// 运行时事件分发器类；导出它本身不实例化或绑定宿主上下文。
	ExtensionRunner,
	// 快捷键/UI/内联扩展契约。
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	// 加载结果与自定义消息渲染器签名。
	type LoadExtensionsResult,
	type MessageRenderer,
	// 已规范化提示词选项与登记的命令定义。
	type NormalizedBuildSystemPromptOptions,
	type RegisteredCommand,
	// 会话压缩/分叉/切换/树导航前的扩展事件，可供处理器按各自契约介入。
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	// 边界草稿以及生命周期事件；它们都是类型，不是事件实例。
	type SessionBoundaryDraft,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	// 工具调用、渲染和结果事件契约；各事件的聚合/短路规则见runner实现。
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	// 回合结束事件及可请求继续等的处理结果、回合开始事件。
	type TurnEndEvent,
	type TurnEndEventResult,
	type TurnStartEvent,
	// 工作状态指示器的界面配置类型。
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
// 构造内置/内联资源来源信息的函数；仅构造数据，不加载资源。
export { createSyntheticSourceInfo } from "./source-info.ts";
