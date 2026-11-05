// 文件导读
// 所属：packages/durable（@earendil-works/pi-durable）的包根入口。应用通常 `import { ... } from "@earendil-works/pi-durable"`。
// 作用：把各子系统的公共 API 汇总为一个稳定出口；本文件没有运行时逻辑，只有 re-export（类型 export 在编译后擦除）。
// 职责边界：不实现行为，也不重新导出子路径入口（env、tools、codemode、tool-search、images、storage/*、testing 由 package.json
// 的 exports 单独提供）。上游：应用代码与测试；下游：./documents.ts、./entries.ts、./errors.ts、./tasks.ts、./session/session.ts、
// ./storage/memory.ts、./harness/* 以及 chord 的 watch 类型。运行结果/错误由这些被转出的实现产生。
// 能力清单（按来源模块分组）：
// - chord/watch：NativeWatchCall、WatchCall、WatchEnd、WatchHandle，文档/会话观察使用的底层 watch 帧与句柄。
// - documents：defineDoc、defineDocFamily，声明 Session/Conversation/Task 范围的单例或文档族。
// - entries：defineEntry 与内置条目 token（UserEntry、AssistantEntry、SystemEntry、ToolResultEntry、ResetEntry、CompactionEntry）。
// - errors：ReadAfterWrite、StorageRequestError、SessionFailed、ReadOnlySession、ConversationBusy、ConversationIdle。
// - harness/agent：AgentDoc、configure、DEFAULT_COMPACTION_POLICY、DEFAULT_PROGRESS_POLICY、DEFAULT_RESTART_LIMIT、DEFAULT_RETRY_POLICY。
// - harness/compaction：CompactionTask 与 CompactionCheckpoint/CompactionInput/SummaryRequest 类型。
// - harness/define：defineExtension、defineTool、hook、runEndTask、section、wrapSection、wrapTool（扩展声明辅助）。
// - harness/generation：GenerationTask 与 GenerationCheckpoint/GenerationInput/GenerationResult。
// - harness/harness：DEFAULT_HARNESS_IDENTITY、Harness（长期运行的持久化 harness）。
// - harness/inbox：InboxDoc 与 InboxItem/InboxState（排队提交）。
// - harness/live：LiveDoc 与运行/工具槽位状态类型。
// - harness/provider：ProviderDoc/ProviderState（提供商会话身份）。
// - harness/registry：createRegistry；registry-reader：registryReader。
// - harness/scheduler：BlockedReason 类型。
// - harness/task-graph：TaskGraph/TaskGraphNode/TaskGraphState/TaskGraphWatch 类型。
// - harness/telemetry：DURABLE_TELEMETRY_SCHEMA。
// - harness/tool：NestedCallDoc、ToolTask 及工具任务检查点/输入/结果类型。
// - harness/transcript：ConversationTranscript 与 EntryLoader/TranscriptItem/TranscriptView 等。
// - harness/types：Harness 的公共契约类型（Agent、Conversation、Settings、Submission、ToolHooks、Registry 等，逐项说明见 types.ts）。
// - harness/usage：UsageDoc/UsageState。
// - harness/view：ConversationView/ConversationWindow。
// - session/session：createSession（低层 Session 内核，通常由 Harness.open 使用）。
// - storage/memory：MemoryStorage（内存后端，测试与快速开始）。
// - tasks：defineTask。
// - types：Session/Storage/Tx/任务/文档/提交等核心类型，以及常量 ROOT_CONVERSATION_ID；逐项说明见 types.ts 的文件导读。
// 组合与典型顺序（应用最常见的入口）：
//   MemoryStorage → Harness.open(storage, options, context) → harness.root(context, ...) → conversation.submit(...) →
//   submission.wait(context) → 用 AssistantEntry 读取回答 → harness.close(context)。
//   自定义状态则用 defineDoc/defineDocFamily 建 token，在 commit((tx) => ...) 中 tx.doc/snapshot 读写。
// 示例（省略 models 的构造；context 例如 chord 的 BACKGROUND_CONTEXT）：
//   const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
//   const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });
// 注意：示例只展示本文件提供的名字；models 来自 @earendil-works/pi-ai，context 来自 @earendil-works/chord/context。
// 阅读顺序：先看本清单，再按需进入 types.ts（数据结构）→ documents.ts/entries.ts（状态与日志）→ harness/harness.ts（运行）
// → session/session.ts 与 storage/memory.ts（提交与持久化）；错误语义见 errors.ts。
export type { NativeWatchCall, WatchCall, WatchEnd, WatchHandle } from "@earendil-works/chord/watch";
// 文档声明：token 只是定义引用，真正读写发生在 Session/Tx 上。
export { defineDoc, defineDocFamily } from "./documents.ts";
// 内置日志条目种类；is() 只按 kind 收窄，data/model 内容由写入方负责。
export {
	AssistantEntry,
	CompactionEntry,
	defineEntry,
	ResetEntry,
	SystemEntry,
	ToolResultEntry,
	UserEntry,
} from "./entries.ts";
// 公共错误类别；调用方按 instanceof 区分事务顺序、非法读取、Session 失败、只读与准入拒绝。
export {
	ConversationBusy,
	ConversationIdle,
	ReadAfterWrite,
	ReadOnlySession,
	SessionFailed,
	StorageRequestError,
} from "./errors.ts";
// 每个会话的 agent 选择：AgentDoc 是持久文档，configure 修改它，其余是策略默认值。
export {
	AgentDoc,
	configure,
	DEFAULT_COMPACTION_POLICY,
	DEFAULT_PROGRESS_POLICY,
	DEFAULT_RESTART_LIMIT,
	DEFAULT_RETRY_POLICY,
} from "./harness/agent.ts";
// 压缩任务及其阶段检查点/输入/摘要请求类型。
export {
	type CompactionCheckpoint,
	type CompactionInput,
	CompactionTask,
	type SummaryRequest,
} from "./harness/compaction.ts";
// 扩展声明辅助：把工具、提示段、包装器、钩子和结束任务组合成一个命名扩展。
export { defineExtension, defineTool, hook, runEndTask, section, wrapSection, wrapTool } from "./harness/define.ts";
// 生成任务（调用模型并把响应写成条目）及其检查点/输入/结果类型。
export {
	type GenerationCheckpoint,
	type GenerationInput,
	type GenerationResult,
	GenerationTask,
} from "./harness/generation.ts";
// 主入口：Harness 打开一个 Storage，序列化所有提交并调度持久任务；DEFAULT_HARNESS_IDENTITY 是请求身份默认值。
export { DEFAULT_HARNESS_IDENTITY, Harness } from "./harness/harness.ts";
// 会话收件箱文档：忙碌时排队的输入与写入，以及放置/结算状态。
export { InboxDoc, type InboxItem, type InboxState } from "./harness/inbox.ts";
// 运行中状态文档：当前 run、工具槽位、压缩状态与失败原因，供 UI/诊断读取。
export {
	type CompactionFailure,
	type CompactionStatus,
	LiveDoc,
	type LiveRun,
	type LiveState,
	type NestedToolSlot,
	type NestedToolSummary,
	type RunFailure,
	type RunFailureReason,
	type ToolSlot,
} from "./harness/live.ts";
// 提供商会话身份文档（例如 OpenAI 的 prompt cache key），与聊天历史分开保存。
export { ProviderDoc, type ProviderState } from "./harness/provider.ts";
// 注册表：本进程安装的扩展集合；可在 Harness 运行期间替换，新工作使用新快照。
export { createRegistry } from "./harness/registry.ts";
// 注册表只读视图，供工具/任务在不暴露修改入口的情况下查询已安装扩展。
export { registryReader } from "./harness/registry-reader.ts";
// 调度器对外暴露的“任务为何被阻塞”原因。
export type { BlockedReason } from "./harness/scheduler.ts";
// 任务图观察类型：实时任务依赖与阻塞原因的快照/ watch。
export type { TaskGraph, TaskGraphNode, TaskGraphState, TaskGraphWatch } from "./harness/task-graph.ts";
// Durable 的 telemetry 契约：span/event/metric 名称与允许的属性，属性只含 ID 与控制信息。
export { DURABLE_TELEMETRY_SCHEMA } from "./harness/telemetry.ts";
// 工具任务：把一次工具调用变成持久任务，并记录嵌套调用状态。
export {
	NestedCallDoc,
	type NestedCallState,
	ToolTask,
	type ToolTaskCheckpoint,
	type ToolTaskInput,
	type ToolTaskResult,
} from "./harness/tool.ts";
// 会话记录读取器：把可见条目与模型消息整理成应用可渲染的 transcript 视图。
export {
	ConversationTranscript,
	type ConversationTranscriptOptions,
	type EntryLoader,
	type TranscriptItem,
	type TranscriptView,
} from "./harness/transcript.ts";
// Harness 公共契约类型（类型专用导出，运行时不存在）：Agent 配置、会话句柄、设置、提交、钩子、注册表等。
export type {
	AfterFailedRun,
	Agent,
	AgentChange,
	AgentState,
	AnyTask,
	CompactionHooks,
	CompactionPolicy,
	CompactionReason,
	CompactionResult,
	CompactionSettings,
	ContextView,
	Conversation,
	ConversationAbortOptions,
	ConversationCreateOptions,
	ConversationHandle,
	ConversationInit,
	ConversationRetryPolicy,
	ConversationStreamOptions,
	ConversationWatch,
	EnvTarget,
	Extension,
	GenerationHooks,
	HarnessInspection,
	HarnessOptions,
	HarnessSettings,
	HookApi,
	HookRegistration,
	HookResult,
	HooksOf,
	InputEntry,
	InputSubmissionDraft,
	ModelRef,
	NestedToolExecutionResult,
	ProgressPolicy,
	PromptInput,
	PromptSection,
	QueueMode,
	Registry,
	RegistryReader,
	RegistrySnapshot,
	RunEndTask,
	RunSummary,
	Settings,
	SettledSubmissionRecord,
	SettledTask,
	Submission,
	SubmissionDraft,
	TaskInspection,
	ToolControl,
	ToolDiagnostic,
	ToolExecutionApi,
	ToolExecutionMode,
	ToolExecutionResult,
	ToolHookCall,
	ToolHooks,
	ToolRegistration,
	UserInput,
	Wake,
	Wrap,
} from "./harness/types.ts";
// 用量文档：按模型/阶段累计的 token 与花费。
export { UsageDoc, type UsageState } from "./harness/usage.ts";
// 会话视图类型：原始可见条目与派生的模型上下文。
export type { ConversationView, ConversationWindow } from "./harness/view.ts";
// 低层 Session 内核：直接打开一个 Storage；Harness 在其上提供 agent/任务调度。
export { createSession } from "./session/session.ts";
// 内存 Storage：所有记录保存在进程内，进程结束即丢失；适合测试与快速开始。
export { MemoryStorage } from "./storage/memory.ts";
// 自定义持久任务：defineTask 只包装定义；注册后由 Harness 调度。
export { defineTask } from "./tasks.ts";
// 核心数据契约（类型专用导出）：提交、文档、条目、任务状态机、查询、观察者、Session 与 Storage 接口。
// 逐项业务含义见 types.ts 的文件导读与各类型注释；这里只负责把它们放到包根。
export type {
	CheckpointInfo,
	CommitChange,
	CommitObservation,
	CommitObserver,
	CommitOptions,
	CommitPersistence,
	CommitPublication,
	CommitResult,
	CommonDocDefinition,
	ContextEdit,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationOwnership,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocDefinition,
	DocFamilyDefinition,
	DocFamilyToken,
	DocToken,
	DocumentAddress,
	DocumentCommitChange,
	DocumentContent,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentObserver,
	DocumentPoint,
	DocumentQuery,
	DocumentReader,
	DocumentRecord,
	DocumentSemantics,
	DocumentWatch,
	Entry,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	HookRunner,
	HostCallback,
	Id,
	JoinPolicy,
	JsonObject,
	LatestConversationSemantics,
	NextTaskState,
	Observation,
	Observer,
	Page,
	PhaseHandler,
	Report,
	ReportFrom,
	ReportInfo,
	ReportTask,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	RewindableConversationSemantics,
	RunningTask,
	ScanOrder,
	Seq,
	Session,
	SessionDocFamilyToken,
	SessionDocToken,
	SessionEnd,
	SetTimer,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionCreate,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	SubmissionSettlement,
	TableCommitChange,
	Task,
	TaskDefinition,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskOptions,
	TaskOutcome,
	TaskOutcomeError,
	TaskOwnership,
	TaskQuery,
	TaskRecord,
	TaskRuntime,
	TaskState,
	Tx,
	TypedEntry,
	TypedEntryDraft,
} from "./types.ts";
// 根会话保留 ID：harness.root() 总是使用它。
export { ROOT_CONVERSATION_ID } from "./types.ts";
