// 文件导读
// 所属：packages/durable（@earendil-works/pi-durable）的核心契约模块。除 ROOT_CONVERSATION_ID 外，本文件全是类型声明，
// 编译后被擦除，不在运行时产生对象或校验。
// 作用：集中定义 Session、Storage、Tx、文档/条目/任务/提交、观察者与事务等跨层数据结构，让实现模块共享同一套形状。
// 职责边界：只描述数据与接口；不包含状态机执行、持久化、调度或校验逻辑。这些由 session/、storage/、harness/ 实现。
// 上游依赖：
// - @earendil-works/chord：Context（取消/追踪上下文）、Draft/Op（文档增量）、JsonValue（JSON 约束）、watch 的 WatchCall/WatchEnd/WatchHandle。
// - @earendil-works/pi-ai：Message（模型消息）与 Models（模型提供方集合）。
// - ./env/index.ts 的 ExecutionEnv、./harness/types.ts 的 Agent/ContextView/ConversationHandle/RegistrySnapshot/Settings/SettledTask。
// 下游使用：documents.ts（定义/地址/令牌）、entries.ts（条目）、tasks.ts（任务定义）、session/session.ts 与 session/transaction.ts
// （Tx/Session/Storage）、storage/*（记录与查询）、harness/*（运行时、报告、观察、持久化策略），以及包根 index.ts 的类型出口。
// 能力清单（按导出分组，一项一句）：
// - JsonObject：文档根值必须是 JSON 对象；Id/Seq 及其别名：擦除式名义类型，防止不同记录 ID/提交序号混用；
//   ROOT_CONVERSATION_ID：根会话保留 ID（本文件唯一运行时值）。
// - 文档语义：Latest/RewindableConversationSemantics、DocumentSemantics、CheckpointInfo、CommonDocDefinition、DocDefinition、
//   DocFamilyDefinition 与各类 DocToken/DocFamilyToken：声明 scope/history/fork、初始值、迁移与检查点策略。
// - 报告与定时器：ReportTask、HostCallback、ReportInfo、Report、ReportFrom、SetTimer：非致命错误上报与宿主定时器契约。
// - 任务运行时：RunningTask、NextTaskState、PhaseHandler、HookRunner、TaskRuntime、TaskDefinition、Task、TaskOwnership、
//   JoinPolicy、TaskOptions：可持久化任务的定义、阶段承诺与运行时能力。
// - 会话与提交：ConversationOwnership、ConversationRecord、ContextEdit、EntryRecord/EntryDraft/TypedEntry/Draft、Entry、
//   SubmissionRecord/Settlement/Create：历史、条目与用户输入的持久生命周期。
// - 任务结果：TaskOutcomeError、TaskOutcome、TaskState、TaskRecord：任务状态机与终态收据。
// - 文档持久化：DocumentRecord/Create、Page/Cursor/ScanOrder、各类 Query、DocumentPoint/Address/Content/CopySource、StoredDocument：
//   记录化身、分页查询与物化内容。
// - 提交与存储：StorageWrite、DocumentCommitChange、TableCommitChange、CommitChange、CommitPublication、Tx、DocumentWatch、
//   Observer/CommitObserver/Observation/CommitObservation、DocumentReader/DocumentObserver、SessionEnd、CommitPersistence/
//   CommitOptions、Session、CommitResult、Storage：物理提交、事务面、观察与持久化边界。
// 典型调用顺序（类型在编译期约束，运行时动作由 Session/Storage 执行）：
//   defineDoc → commit((tx) => tx.doc(token, conversationId)) → draft.value = ... → tx.createTask(...) →
//   storage.commit(batches, receive, context) → 发布后 Observer.advance 收到 WatchCall → Session.close 结束观察。
// 类型小例（ROOT_CONVERSATION_ID 是真实运行时值，其余是类型标注）：
//   const conversationId = ROOT_CONVERSATION_ID;           // 类型 ConversationId
//   const taskId = 42 as TaskId<MyResult>;                 // 断言只影响类型，运行时仍是 42，不做任何检查
//   const state: TaskState<MyPhase, MyResult> = { status: "pending", checkpoint: initialPhase };
// 阅读顺序：先看 ID/文档语义，再看任务运行时与状态机，然后条目/提交、文档记录与查询、提交/Tx/Session/Storage；
// 报告与 SetTimer 可最后读。
import type { Context } from "@earendil-works/chord/context";
// Draft 是文档草稿（读写 value/ops），Op 是基础与增量提交中的单个操作。
import type { Draft, Op } from "@earendil-works/chord/delta";
// JsonValue 约束所有可持久化负载；Durable 不允许 undefined、Date、类实例等非 JSON 值。
import type { JsonValue } from "@earendil-works/chord/json";
// watch 的三元组：一次值/操作调用、结束原因、以及可用的 watch 句柄。
import type { WatchCall, WatchEnd, WatchHandle } from "@earendil-works/chord/watch";
// Message 是模型消息；Models 是模型提供方集合，供任务运行时按需解析。
import type { Message, Models } from "@earendil-works/pi-ai";
// 遥测载体：跨任务/提交传递 trace 上下文；不在这里解释其内部结构。
import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
// 工具/任务执行环境（文件、命令等），由宿主 HarnessOptions.env 构建。
import type { ExecutionEnv } from "./env/index.ts";
// 表层 API 的引用类型：Agent 配置、上下文视图、会话句柄、注册表快照、设置与已结算任务。
import type {
	Agent,
	ContextView,
	ConversationHandle,
	RegistrySnapshot,
	Settings,
	SettledTask,
} from "./harness/types.ts";

/** JSON object used as the root of every durable document. */
// 文档根必须是对象（不能是数组/标量），这样字段可按 key 增量更新；值本身仍递归受 JsonValue 限制。
export type JsonObject = { [key: string]: JsonValue };

declare const idBrand: unique symbol;

/** Erased nominal number identifying one durable record kind. */
// 擦除式名义类型：运行时就是 number，泛型 Kind/Type 只存在于编译期，用来阻止“把条目 ID 当任务 ID 用”。
// 由于 brand 字段从未真正存在，构造 Id 必须经 storage.mintId 或显式断言（如 idFromNumber）。
export type Id<Kind extends string, Type = unknown> = number & {
	readonly [idBrand]: {
		readonly kind: Kind;
		readonly type: Type;
	};
};

// 各记录种类的 ID 别名；Type 只用于 TaskId，把任务结果类型带到句柄/查询上。运行时都没有额外检查。
export type ConversationId = Id<"conversation">;
export type EntryId = Id<"entry">;
export type TaskId<Result = unknown> = Id<"task", Result>;
export type SubmissionId = Id<"submission">;
export type DocumentId = Id<"document">;

declare const seqBrand: unique symbol;

/** Strictly increasing sequence assigned to one atomic storage commit; gaps are permitted. */
// 每次原子存储提交分配一个严格递增序号；允许跳号（并发/失败批次），仅保证先后顺序。
// 与 Id 一样是擦除式 brand：扫描第一关键字、历史 as-of 读取都以它为准。
export type Seq = number & { readonly [seqBrand]: "sequence" };

/** The root conversation always uses this reserved ID. */
// 本文件唯一运行时值：数字 1，并断言成 ConversationId。断言不检查，1 本身就是约定保留值。
// harness.root() 与根任务都使用它；不要用 mintId 再生成一个“根”。
export const ROOT_CONVERSATION_ID = 1 as ConversationId;

/** Conversation document that retains only its current state. */
// “最新值”语义：只保留当前状态和最新 base，不保留可按历史条目回溯的增量；存储更省，但不能 snapshotAsOf。
export type LatestConversationSemantics = {
	// 文档归属于某个会话（随会话创建/删除）。
	readonly scope: "conversation";
	// 不保留可回放历史；变更折叠进当前 base。
	readonly history: "latest";
	// 分叉时只能复制当前状态或定义初始值，不能回到某个历史点。
	readonly fork: "current" | "initial";
};

/** Conversation document whose history remains addressable for as-of reads. */
// “可回放”语义：保留 base + 增量链，支持按条目读取历史（snapshotAsOf）；代价是存储与重放成本更高。
export type RewindableConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "rewindable";
	// 分叉可回到某个历史点（asOf）、当前状态或初始值。
	readonly fork: "asOf" | "current" | "initial";
};

/** Ownership and lifetime of a document; only conversation documents declare history and fork behavior. */
// 文档归属：session（整个存储生命周期）、conversation（随会话，支持 latest/rewindable）、task（随任务终结退役）。
// session/task 分支用 `never` 明确禁止 history/fork 字段，编译期阻止非法组合。
export type DocumentSemantics =
	| { readonly scope: "session"; readonly history?: never; readonly fork?: never }
	| LatestConversationSemantics
	| RewindableConversationSemantics
	| { readonly scope: "task"; readonly history?: never; readonly fork?: never };

/** Stored replay state supplied to a document's checkpoint predicate. */
// 传给 checkpointWhen 的存储侧信息：评估本次变更之前，最新 base 之后已有多少条增量。
// 注意是“普通变更”的判定输入；创建初始 base 不需要它。
export type CheckpointInfo = {
	/** Deltas already stored after the newest base, excluding the change being evaluated. */
	// 已存增量条数（不含当前正评估的变更）；数值越大，继续用 delta 的链越长。
	readonly deltasSinceBase: number;
};

/** Definition fields shared by singleton documents and document families. */
// 单例文档与文档族的共同定义。注意：这里是“类型形状”，真正的运行时校验在 documents.ts 的 defineDoc/defineDocFamily
// 与存储读取时发生；只有 version 在定义时被校验为正整数。
export type CommonDocDefinition<T extends JsonObject> = {
	/** Stable persisted kind; part of the public protocol. */
	// 持久化种类名：写入 DocumentRecord.kind 并参与地址匹配；改名等于换一种文档（旧记录不会自动匹配）。
	readonly kind: string;
	/** Positive integer version of the stored value shape. */
	// 存储值形状的版本号（正整数）；defineDoc 会在定义时检查，迁移与读取版本比较都依赖它。
	readonly version: number;
	// 首次创建时生成初始值；族成员则是 initial(seed)。必须是纯 JSON 对象。
	initial(): T;
	// 可选迁移：存储版本与当前版本不同且需要读取时调用，把旧 JsonObject 转成当前形状。
	// 迁移结果会按 JSON 复制后再物化；返回不符合 T 的运行时值不会被类型系统拦截。
	migrate?(value: JsonObject, fromVersion: number): T;
	/** Required policy: return true to store this ordinary change as a complete base instead of a delta. */
	// 必填的检查点策略：对一次普通变更返回 true 时，存储完整 base 而不是追加 delta。
	// value 是变更后的只读值，ops 是本次变更的操作，info 提供已有增量条数；用于控制增量链长度/成本。
	checkpointWhen(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean;
};

/** Singleton document definition. */
// 单例定义 = 共同字段 + 语义；同一地址（kind + scope + key 缺省）只有一个化身。
export type DocDefinition<T extends JsonObject> = CommonDocDefinition<T> & DocumentSemantics;

/** Keyed document family definition; `initial(seed)` runs only when a member is absent. */
// 文档族：同一 kind/scope 下按 key 分成多个成员；initial 接收调用方 seed，且只在成员不存在时执行。
// `Omit<..., "initial">` 去掉无参 initial，再补上带 seed 的版本；`family: true` 是运行时也可读的判别字段。
export type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> &
	DocumentSemantics & {
		readonly family: true;
		initial(seed: I): T;
	};

declare const docType: unique symbol;

/** Typed singleton document token passed explicitly to typed access. */
// 类型化单例令牌：definition 提供 kind/版本等运行时信息；docType 是纯编译期“幽灵字段”，
// 让 token 携带 T，以便 tx.doc/snapshot/watchDoc 推导文档值类型。令牌本身不保存数据。
export interface DocToken<T extends JsonObject, D extends DocDefinition<T>> {
	readonly definition: D;
	readonly [docType]?: T;
}

/** Typed document family token passed explicitly to typed access. */
// 类型化文档族令牌：额外携带 seed 类型 I，tx.doc 的 seed 参数据此检查。
export interface DocFamilyToken<T extends JsonObject, I extends JsonValue, D extends DocFamilyDefinition<T, I>> {
	readonly definition: D;
	readonly [docType]?: T;
}

// 以下别名把“作用域”编码进令牌类型，用来选择 Tx.doc / snapshot / watchDoc 的重载：
// session 令牌不带会话/任务参数；conversation 令牌必须带 conversationId；task 令牌必须带 taskId。
// 这些约束只在编译期生效，运行时令牌仍只是 { definition }。
export type SessionDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "session" }>;
// 普通会话令牌接受 latest 或 rewindable，可用于 snapshot/watchDoc，但 snapshotAsOf 只接受 Rewindable*Token。
export type ConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
// snapshotAsOf 专用：要求定义确实声明 history: "rewindable" 与 fork 支持 asOf。
export type RewindableConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & RewindableConversationSemantics
>;
export type TaskDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "task" }>;

// 文档族的同类作用域别名：决定 tx.doc/retireDoc/watchDoc 需要 key 还是 seed，以及会话/任务参数。
export type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "session" }
>;
export type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
export type RewindableConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & RewindableConversationSemantics
>;
export type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "task" }
>;

/** The task a report is about. */
// 报告关联的任务“坐标”：ID、注册名 kind、所属会话。只需这三项即可让宿主定位任务，不携带完整记录。
export type ReportTask = {
	readonly id: TaskId;
	/** The task's registered name. */
	// 注册的任务名（TaskDefinition.name）；与 TaskRecord.kind 相同，便于日志直接显示。
	readonly kind: string;
	readonly conversationId: ConversationId;
};

/**
 * A host callback, by its `HarnessOptions` name; `env` is the environment builder, `models` a provider call, and
 * `telemetry` a telemetry adapter call made while a commit is published, which must not fail it.
 */
// 宿主回调的固定名字联合：报告 host_error 时指明是哪一个回调失败；也用于任务运行时的 from 参数。
// 这些名字是协议字符串，运行时只是字符串，类型系统把所有合法值列全。
export type HostCallback = "now" | "settings" | "registry" | "env" | "models" | "setTimer" | "onWake" | "telemetry";

/**
 * What a report to `HarnessOptions.onReport` is about, by `kind` (`Report` adds the error). `extension`, where present,
 * names the extension whose code failed, when known; for a task's own code, the one that installed the definition the
 * task ran.
 * - `storage_failed`: the error failed the Session, which closes: a Storage error, often a platform reset.
 * - `task_faulted`: the task ended `faulted`: its phase threw (`reason: "threw"`), or its abort handler was cut off
 *   `settings.restartLimit` times (`reason: "restart_limit"`), as was a phase of a task of an extension's kind.
 * - `task_interrupted`: crashes ended the task: it ended itself after being cut off `settings.restartLimit` times in a
 *   row (`reason: "restart_limit"`; a tool call, a compaction, a generation), or a generation's run ended because the
 *   host kept stopping while the model answered (`reason: "interrupted"`). `restarts` is the task's count when it ended.
 * - `migration_failed`: the task's stored state could not be migrated; it is blocked until the registry changes.
 * - `task_outdated`: a running task keeps running under its old definition, which was uninstalled (`missing_task`)
 *   or replaced by one that cannot take over its state: older than the task (`task_too_old`), or newer without a
 *   `migrate` (`migration_failed`).
 * - `task_error`: the task's own `runtime.report()`, or a failure in running it.
 * - `extension_error`: a hook, a section, a wrapper, or a tool's invalid structured output; with the task that ran it,
 *   or, outside a task, the conversation whose agent was resolved.
 * - `host_error`: a host callback threw; with the task that called it, if one did.
 * - `listener_error`: a commit, close, watch, view, or document listener threw.
 */
// 非致命报告的分类：只描述“发生了什么”，具体错误对象由 Report 的 error 字段附带；是否为致命由 Session 语义决定。
// 大多数任务相关分支都带可选 extension（已知时指明是哪个扩展的代码失败）；任务自身代码失败时通常是安装该定义的扩展。
export type ReportInfo =
	// Storage 出错导致 Session 失败并关闭；这通常意味着平台重置等无法继续的情况。
	| { readonly kind: "storage_failed" }
	// 任务 faulted：阶段抛错（threw），或 abort 处理连续被中断到 restartLimit 次（restart_limit）。
	| {
			readonly kind: "task_faulted";
			readonly task: ReportTask;
			readonly extension?: string;
			readonly reason: "threw" | "restart_limit";
	  }
	// 任务因崩溃/驱逐/重置打断而自行结束：连续达到 restartLimit，或生成任务的模型请求反复被宿主停止。
	// restarts 是任务结束时的累计重启次数，便于诊断。
	| {
			readonly kind: "task_interrupted";
			readonly task: ReportTask;
			readonly extension?: string;
			readonly reason: "restart_limit" | "interrupted";
			readonly restarts: number;
	  }
	// 任务存储状态无法迁移；在注册表变化（安装/升级定义）之前它会一直阻塞。
	| { readonly kind: "migration_failed"; readonly task: ReportTask; readonly extension?: string }
	// 正在运行的任务仍用旧定义继续：定义被卸载（missing_task）、比任务旧（task_too_old），或更新但没有 migrate。
	| {
			readonly kind: "task_outdated";
			readonly task: ReportTask;
			readonly extension?: string;
			readonly reason: "missing_task" | "task_too_old" | "migration_failed";
	  }
	// 任务自身 runtime.report() 上报的错误，或执行任务代码时的失败。
	| { readonly kind: "task_error"; readonly task: ReportTask; readonly extension?: string }
	// 扩展代码失败：hook、section、wrapper 或工具的非法结构化输出；可能属于某任务，也可能发生在解析会话 agent 时。
	| {
			readonly kind: "extension_error";
			readonly extension?: string;
			readonly task?: ReportTask;
			readonly conversationId?: ConversationId;
	  }
	// 宿主回调抛错；callback 指明是哪一个，若由任务调用则附带 task。
	| { readonly kind: "host_error"; readonly callback: HostCallback; readonly task?: ReportTask }
	// 提交、关闭、watch、视图或文档监听器抛错（监听器禁止抛错，抛错会被转为这条报告）。
	| { readonly kind: "listener_error" };

/** One report to `HarnessOptions.onReport`: what it is about (`ReportInfo`, by `kind`) and the `error` reported. */
// Report = 分类信息 + 原始错误。error 为 unknown：可能来自宿主、扩展或任意抛出值，宿主需自行格式化。
export type Report = ReportInfo & { readonly error: unknown };

/** Whose code a task's `runtime.report()` is about when not the task's own: an extension's, or a host callback. */
// runtime.report(error, from) 的来源选择：默认按任务自身（task_error）；
// 传 extension 记为 extension_error，传 host 记为 host_error（callback 指明回调名）。
export type ReportFrom =
	| { readonly kind: "extension"; readonly extension?: string }
	| { readonly kind: "host"; readonly callback: HostCallback };

/**
 * A host timer, given as `HarnessOptions.setTimer`: call `callback` once, about `delayMs` from now, and return
 * a function that disarms it. `background` timers only free memory, and a host may decline one by returning
 * `undefined`, for example where a pending timer keeps the process from hibernating; the Harness then frees that memory
 * at later commits. Other timers pace or resume work: one the host throws on or declines is armed with `setTimeout`.
 * A timer should not fire early; callers check their clock again when it fires.
 */
// 宿主定时器契约。返回值：取消函数；后台定时器可返回 undefined 表示拒绝（例如 Cloudflare Workers 中 pending
// 定时器会阻止休眠）。前台定时器（background: false）若抛错或拒绝，Harness 会退回 setTimeout。
// 类型层只约束形状，是否真的按时/只调用一次由宿主实现与 timers.ts 的 hostTimers 负责。
export type SetTimer = (
	callback: () => void,
	delayMs: number,
	options: { readonly background: boolean },
) => (() => void) | undefined;

/** Live task record reserved by one invocation. */
// 运行中的任务记录：TaskRecord 的联合收窄为 state.status === "running"，让阶段处理器拿到确定的 checkpoint。
export type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
	readonly state: Extract<TaskState<S, R>, { readonly status: "running" }>;
};

/**
 * Next state a task commits for itself: a replacement checkpoint, a wait on tasks, a sleep, or its outcome. A returned `terminal` state is
 * stored as `completing` while ordinary owned work below the task is live (spec §5.5).
 */
// runtime.commit() 的返回值只能是这四种状态：继续运行并替换检查点、等待子任务、睡眠、或终态结果。
// 不能直接返回 pending（任务不能把自己重新排队）或 running（本来就是 running）；terminal 在仍有普通子任务存活时
// 由 Session 落库成 completing，等子任务结束后才真正 terminal。
export type NextTaskState<S, R> = Extract<
	TaskState<S, R>,
	{ readonly status: "running" | "waiting" | "sleeping" | "terminal" }
>;

/**
 * Runs one checkpoint phase. It must commit a changed checkpoint or a terminal outcome through `runtime.commit()`;
 * returning without durable progress faults the task.
 */
// 一个阶段处理器：接收收窄到当前 phase 的任务、运行时能力与上下文；异步完成。
// 关键契约：返回前必须通过 runtime.commit() 提交了“改变的检查点”或终态；什么都不提交就返回会导致任务 faulted。
export type PhaseHandler<I, P, S, R, H extends object> = (
	task: RunningTask<I, P, R>,
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
) => Promise<void>;

/** Dispatches one hook of a task to every matching registered handler, in registry order of the phase snapshot. */
// 钩子分发器：按阶段快照的注册表顺序，把同名钩子依次交给每个匹配的处理器。
// 语义核心：普通抛出会被报告并继续下一个；一旦本次调用已被 signal（任务结束/中止），错误则向上传播。
export interface HookRunner<H extends object> {
	/**
	 * Call `invoke` with each matching handler named `name`. An ordinary throw from `invoke` is reported and the next
	 * handler runs; once the invocation is signalled, the error propagates. Composition happens inside `invoke`.
	 */
	// name 必须是 H 的键；invoke 接收 NonNullable 的处理器（排除可选的 undefined）。组合逻辑在 invoke 内完成。
	each<K extends keyof H>(name: K, invoke: (handler: NonNullable<H[K]>) => void | Promise<void>): Promise<void>;
}

/**
 * Operations of one task invocation. Every operation rejects after the invocation ends; watches acquired through it
 * stop at invocation end.
 */
// 一次任务调用（invocation）的能力面：阶段处理器只能通过它读写持久状态、等待子任务、睡眠和上报。
// 生命周期：调用结束后所有方法都 reject，通过它获得的 watch 也会停止——避免崩溃/重启后的旧代码继续写。
// 它继承 DocumentObserver/DocumentReader，因此也能 watchDoc/snapshot/snapshotAsOf（作用域仍按任务/会话校验）。
export interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver, DocumentReader {
	// 当前任务的类型化 ID（结果类型 R 用于 waitForTask/outcomes 的类型推导）。
	readonly taskId: TaskId<R>;
	// 任务所属会话 ID；创建子任务时默认继承。
	readonly conversationId: ConversationId;
	/**
	 * Aborted when the run is signalled by `abortTask()`, the Harness closes, or the invocation ends. Work still using it
	 * after the invocation ended, such as a detached wait, is cancelled; it could not write anything anyway.
	 */
	// 中止信号：abortTask、Harness 关闭或本次调用结束时触发。detached 的异步工作会被取消；即使没取消也无法写入。
	readonly signal: AbortSignal;
	/** Registry snapshot of the current phase; refreshed at every phase boundary. */
	// 当前阶段的注册表快照；每个阶段边界刷新，阶段内保持固定，保证一次阶段看到一致的扩展集合。
	readonly registry: RegistrySnapshot;
	/** The task's conversation's agent, resolved at most once per phase, at first use, and fixed for the phase. */
	// 解析任务所属会话的 agent；每个阶段最多解析一次（首次使用时），该阶段内固定。可能触发宿主回调并可抛错。
	agent(context: Context): Promise<Agent>;
	/** `HarnessOptions.settings`, resolved at each access. */
	// 宿主设置；每次读取都重新解析（不是快照），因此运行期可变化。
	readonly settings: Settings;
	/** `HarnessOptions.models`, resolved at each access. */
	// 模型提供方集合；同样每次访问重新解析。
	readonly models: Models;
	/** Calls `HarnessOptions.env` for the task's conversation; rejects with its error. */
	// 为任务会话构建执行环境；宿主未配置时得到 undefined，构建失败则 reject 原始错误。
	env(context: Context): Promise<ExecutionEnv | undefined>;
	/** Handlers of this task's name from the extensions its conversation selects, in extension order. */
	// 该任务 kind 对应的钩子处理器，来自其会话选中的扩展，按扩展顺序排列。
	readonly hooks: HookRunner<H>;

	/**
	 * Commit on the Session line after rereading the task. Rejects when the task is terminal, the invocation ended, the
	 * Harness is closing, or, in a run invocation, the task carries an abort mark. A returned state replaces the task's
	 * state in the same commit; returning nothing leaves it unchanged. `tx.createTask()` defaults to the task's
	 * conversation. Inside the callback read only through `tx`: `snapshot()`, `watchDoc()`, `getTask()`, and the other Session and runtime reads may queue on the line the callback holds, and then never resolve.
	 * `options.persistence` may defer storing a commit that changes only documents (`CommitPersistence`); one that returns
	 * a state is immediate.
	 */
	// 任务专用提交：在 Session 事务线上先重读任务，再执行 change。以下情况 reject：任务已终态、调用已结束、
	// Harness 正在关闭，或 run 调用期间任务带 abort 标记。
	// change 返回值：NextTaskState 会在同一提交里替换任务状态；undefined 表示只写文档、状态不变（可用于进度刷新）。
	// 重要限制：回调内只能通过 tx 读，不能用 runtime.snapshot 等——它们可能排在当前事务线后面，永久等待。
	// 返回了状态的提交必定立即落库；只有纯文档变更才可能按 options.persistence 延迟。
	commit(
		change: (
			tx: Tx,
			current: RunningTask<I, S, R>,
		) => NextTaskState<S, R> | undefined | Promise<NextTaskState<S, R> | undefined>,
		context: Context,
		options?: CommitOptions,
	): Promise<void>;
	/** Read a durable memo of this task. */
	// 读取任务级持久备忘（不存在的 key 返回 undefined）；memo 只在小值、首写者胜的场景使用。
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	/** Store `candidate` unless a memo already exists; return the durable winner. */
	// 原子地“没有则写入”：并发/重试时返回已存在的值，保证同一 key 只有一个持久赢家。
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	/** Committed task record. */
	// 读取任意任务的已提交记录；未找到为 undefined。任务 ID 的结果类型 T 只影响返回值类型。
	getTask<T>(id: TaskId<T>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, T> | undefined>;
	/** Resolve with the task's terminal receipt; rejects when the invocation ends. */
	// 等待某个任务终态并拿到结算收据；本次调用结束时 reject（不能跨 invocation 持久等待）。
	waitForTask<T>(id: TaskId<T>, context: Context): Promise<SettledTask<T>>;
	/**
	 * Abort a task this task owns, as `Harness.abortTask()` does, and resolve once it is terminal. Rejects for a task
	 * another owns; resolves at once for a terminal one.
	 */
	// 中止本任务拥有的子任务，等它终态后返回；非本任务所有会 reject，已终态则立即完成。
	abortOwned(id: TaskId, context: Context): Promise<void>;
	/**
	 * Live tasks this task owns directly, in ID order: also those an earlier invocation created, before a restart. Tasks
	 * in conversations it owns are not included. Copies of the committed records.
	 */
	// 直接拥有的存活子任务（按 ID 升序）：包括重启前旧调用创建的；不包含其拥有的会话里的任务。返回已提交记录的副本。
	ownedTasks(context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]>;
	/** Outcomes of terminal tasks, in order; rejects when one is missing or not terminal. Used after a wait. */
	// 按传入顺序取多个终态结果；任一缺失或非终态即 reject。通常先 wait 再调用。
	outcomes<T>(ids: readonly TaskId<T>[], context: Context): Promise<TaskOutcome<T>[]>;
	/**
	 * Invocation-bound handle of an existing conversation, for example one this task owns; `undefined` when absent. Its
	 * operations and the submissions it returns reject after the invocation ends; admitted work stays durable.
	 */
	// 获取已有会话的调用绑定句柄（例如本任务拥有的会话）；不存在为 undefined。
	// 句柄及其提交在本次调用结束后 reject，但已经准入的工作仍然持久。
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	/** Committed entry visible from the task's conversation. */
	// 读取从任务会话可见的条目（fork 祖先也算可见）；未找到或不可见为 undefined。
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	/** Undefined when the entry is absent, not visible, or has another kind. */
	// 类型化条目读取：token 决定 kind；条目不存在、不可见或 kind 不匹配都是 undefined（不抛错）。
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId, context: Context): Promise<TypedEntry<D> | undefined>;
	/**
	 * Committed raw history of the task's conversation, fork-aware, as `Conversation.entries()`: every entry, also those a
	 * compaction summary or reset left behind. Entries never change, so a range bounded by entry IDs reads the same
	 * before and after a compaction, and in a rerun after a crash.
	 */
	// 读取任务会话的原始历史（可跨 fork）：包含压缩摘要/重置后“不可见”的旧条目。
	// query 省略 conversationId（由任务决定）；条目不可变，因此按条目 ID 划定的区间在压缩前后、崩溃重跑后都读到同样内容。
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	/** Committed raw active transcript and model context, optionally cut off at the visible entry `at`. */
	// 读取当前活跃 transcript 与模型上下文；at 指定某个可见条目时，只计算到该条目（as-of）。
	context(conversationId: ConversationId, context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	/** The Harness clock. */
	// Harness 时钟（毫秒）；所有睡眠/超时判断都用它，而不是直接读系统时间，便于宿主替换。
	now(): number;
	/**
	 * Call `callback` once after about `delayMs` on the Harness's timer (`HarnessOptions.setTimer`), for pacing work
	 * inside a phase, such as throttled progress commits. Not durable: the invocation's end disarms it, and after its end
	 * nothing is armed. Returns a function that disarms it. Wait for time between phases with `sleepUntil()`.
	 */
	// 阶段内的短期定时器：约 delayMs 后调用一次（如节流进度提交）。不持久：调用结束即取消，结束后不再武装。
	// 返回取消函数；跨阶段的等待必须用 sleepUntil() 提交持久睡眠，而不是靠它。
	setTimer(callback: () => void, delayMs: number): () => void;
	/**
	 * Forward a non-fatal failure to `HarnessOptions.onReport`, with this task in its info: a `task_error` about the
	 * task's own code, or, with `from`, an `extension_error` about extension code it called, such as a section, or a
	 * `host_error` about a host callback, such as the environment builder.
	 */
	// 非致命错误上报（同步、返回 void）：默认归为任务自身 task_error；from 可标为扩展代码或宿主回调。
	// 是否让任务失败由调用方决定；report 本身不会终止任务。
	report(error: unknown, from?: ReportFrom): void;
	/**
	 * Commit a sleep: the task holds no invocation until the Harness clock reaches `until`, then resumes at `checkpoint`.
	 * Resolves once the sleep is stored, not when the time comes; the phase returns right after. Returning
	 * `{ status: "sleeping", until, checkpoint }` from `commit()` is the same sleep, for one that must commit together
	 * with other writes.
	 */
	// 提交持久睡眠：任务释放调用，直到 Harness 时钟到达 until 后从 checkpoint 恢复。
	// Promise 只表示“睡眠已落库”，不代表时间已到；阶段随后应直接返回。需要与其他写入同批提交时，
	// 改为在 commit() 中返回 { status: "sleeping", until, checkpoint }。
	sleepUntil(until: number, checkpoint: S, context: Context): Promise<void>;
}

/** Executable durable state machine definition, registered in the registry by `name`. */
// 可执行的任务状态机定义：由 defineTask 包装并注册到 registry，Harness 调度时按 name/version 找到它。
// 泛型：I 输入、S 检查点（必须含 phase 字段）、R 结果、H 钩子集合。整个定义是纯数据 + 函数，不持运行时状态。
export type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
	/** Registered task kind persisted in `TaskRecord.kind`. */
	// 注册名，持久化到 TaskRecord.kind；改名视为新任务类型，旧记录无法匹配。
	readonly name: string;
	/** Definition version persisted with live input and checkpoints. */
	// 定义版本，随存活输入/检查点持久化；用于判断旧记录是否需要 migrate，以及 registry 替换后的兼容性。
	readonly version: number;
	/** First durable checkpoint for a newly created task. */
	// 新任务的第一个持久检查点；由 tx.createTask 即时调用，输入为创建时的 input。
	initial(input: I): S;
	/** Exhaustive phase map; each handler receives the task narrowed to its phase. */
	// 穷尽所有 phase 的映射（mapped type）：每个处理器拿到的任务收窄到对应 phase，漏写一个阶段会编译报错。
	readonly phases: {
		readonly [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H>;
	};
	/** Runs in a fresh invocation after an abort mark and must commit a terminal outcome. */
	// abort 处理器：任务带 abort 标记后，在一个全新 invocation 中运行，必须提交终态（不能只返回）。
	abort(task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<void>;
	/** Convert a record stored by any older supported version; runs at reservation. */
	// 可选迁移：读到任意受支持的旧版本记录时，在“预留任务”阶段把 input/checkpoint 转成当前形状。
	// 返回错误或缺失 migrate 会让任务阻塞/隔离，而不是带着不兼容状态继续运行。
	migrate?(
		input: JsonValue,
		checkpoint: JsonValue,
		fromVersion: number,
	): {
		input: I;
		checkpoint: S;
	};
	// 钩子的类型声明；实际处理器来自扩展注册表，运行时分发见 TaskRuntime.hooks。
	readonly hooks?: H;
};

/** Typed executable task definition. */
// 类型化任务句柄：只是 definition 的包装，用于把泛型参数固定后传给 tx.createTask。
export interface Task<I, S extends { phase: string }, R, H extends object> {
	readonly definition: TaskDefinition<I, S, R, H>;
}

/** Who owns a task: its conversation (a top-level task) or another task of the same conversation (a child task). */
// 任务归属：conversation 表示顶层任务，直接由会话拥有；task 表示同会话内的子任务，父任务负责其存活/中止级联。
export type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };

/** How a waiting task treats the tasks it waits on (spec §5.5). */
// 等待多个子任务时的汇合策略：failFast 任一失败即失败；allSettled 全部结束再根据结果决定。
export type JoinPolicy = "failFast" | "allSettled";

/** Creation options for a durable task. */
// 创建持久任务的选项；只有 ownership 必填，其余都有明确默认或仅特定场景使用。
export type TaskOptions = {
	/** Omitted: inherit the creator's carrier. "root": start at the adapter root without a stored carrier. */
	// 遥测父载体：省略则继承创建者的 carrier；"root" 从适配器根开始（不存 carrier）。
	readonly trace?: TelemetryCarrier | "root";
	/** Immutable creation-time links, attached to the spans of this task's first invocation. */
	// 创建时固定的遥测 links，附加到任务第一次调用的 span 上；之后不可修改。
	readonly links?: readonly TelemetryCarrier[];
	/** Required: a task always names its owner (spec §5.5). */
	// 必填：任务必须声明归属（会话或父任务），调度、级联中止与清理都依赖它。
	readonly ownership: TaskOwnership;
	/**
	 * Default: the owner task's conversation, or the transaction's bound conversation; required for conversation-owned
	 * tasks created by Session commits that are not bound to a conversation.
	 */
	// 所属会话：默认取父任务的会话，或当前事务绑定的会话；由未绑定会话的 Session 提交创建顶层任务时必须显式给出。
	readonly conversationId?: ConversationId;
	/** Conversation-owned tasks only: excluded from ordinary idle waits, conversation aborts, and cascades. */
	// 仅会话拥有的顶层任务可用：后台任务，不参与普通空闲等待、会话级中止和级联清理。
	readonly background?: boolean;
	/**
	 * Its creator awaits it only in memory and does not resume after a restart, so it is pointless once the Harness that
	 * created it is gone. When scheduling starts in a later Harness, the task, if still live, is abort-marked with reason
	 * `restart`, and the mark cascades to its ordinary owned work, before any of it runs again.
	 */
	// 仅内存等待、重启后不会恢复的任务：创建它的 Harness 消失后已无意义。后续 Harness 开始调度时，
	// 若任务仍存活，会先打上 reason: "restart" 的 abort 标记（并级联到普通子任务），然后才允许再次运行。
	readonly abandonOnRestart?: boolean;
};

/** Ownership selected explicitly whenever a conversation is created. */
// 会话创建时必须显式选择归属：ownerless（无任务拥有）或 task（由某任务拥有，随任务中止/清理）。
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId };

/** Immutable identity, history ancestry, and task ownership of a transcript scope. */
// 会话记录：不可变身份 + 历史祖先 + 创建者/归属信息。会话是条目可见性与 fork 的边界。
export type ConversationRecord = {
	readonly id: ConversationId;
	/** Fork source and inclusive parent entry through which history is inherited. */
	// fork 来源：从父会话的某个条目（含该条目）继承历史；沿 parent 链可追溯到根。
	readonly parent?: {
		readonly conversationId: ConversationId;
		readonly at: EntryId;
	};
	/** Creator edge used for attribution, subtree abort, and subtree idle waits. */
	// 创建者边（由哪个会话/任务创建）：用于归属统计、子树中止与子树空闲等待；ownerless 会话没有它。
	readonly owner?: {
		readonly conversationId: ConversationId;
		readonly taskId: TaskId;
	};
};

/** An immutable override of one visible entry's contribution to model context. */
// 对某个可见条目的模型上下文贡献做不可变覆盖：omit 省略原消息，replace 换成新消息；应用层仍能看到原条目。
export type ContextEdit = {
	/** Entry whose model messages are omitted or replaced. */
	// 被覆盖的目标条目。
	readonly target: EntryId;
} & (
	| {
			readonly action: "omit";
			// omit 不允许携带 messages（never），编译期排除“又省略又替换”的歧义。
			readonly messages?: never;
	  }
	| {
			readonly action: "replace";
			/** Messages contributed instead of the target entry's model messages. */
			// 替换后的模型消息；只改变模型上下文，不修改原条目。
			readonly messages: readonly Message[];
	  }
);

/** Immutable transcript event with separate model-facing and application-facing payloads. */
// 不可变条目记录：写入后永不修改。模型可见内容（model）与应用可见内容（data）分开，
// 应用可存任意 JSON 而不污染模型上下文。
export type EntryRecord = {
	// 全局唯一条目 ID；跨会话唯一，扫描排序也以它为准。
	readonly id: EntryId;
	// 条目所属会话；fork 只继承祖先会话的可见条目，不复制记录。
	readonly conversationId: ConversationId;
	/** Application-defined entry discriminator. */
	// 应用自定义种类（entry token 的 kind）；运行时只按字符串相等判断，data 的形状由写入方/读取方约定。
	readonly kind: string;
	/** Messages contributed to model context; absent for display or bookkeeping entries. */
	// 贡献给模型上下文的消息；纯展示/记账条目没有此字段。
	readonly model?: readonly Message[];
	/** JSON payload consumed by views, extensions, or bookkeeping logic. */
	// 应用侧负载；必须是 JSON 值（不含 undefined/函数/类实例），由使用方按 kind 解释。
	readonly data?: JsonValue;
	/** First entry in the active context selected by this entry. */
	// 活动上下文起点标记：该条目指向“从这里开始”的可见条目；压缩/重置用它裁剪历史，不改动旧条目。
	readonly head?: EntryId;
	/** Context-only overrides of earlier visible entries. */
	// 仅影响模型上下文的覆盖列表（omit/replace），不改变应用可见历史。
	readonly edits?: readonly ContextEdit[];
	/** Task that appended this entry, when it was produced by durable work. */
	// 由持久任务写入时的任务 ID；用户/宿主直接写入通常没有。
	readonly byTaskId?: TaskId;
};

/** Entry content supplied before the Session assigns identity and task attribution. */
// 追加条目时的草稿：Session 负责分配 id、conversationId、byTaskId，并处理 head。
// 注意 Omit 去掉了 head，随后单独允许 "self"：表示“以新条目自身作为活动上下文起点”。
export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
	/** `"self"` starts active context at the newly assigned entry ID. */
	readonly head?: EntryId | "self";
};

/** Entry whose `data` has type `D`; `never` means the kind carries no data. */
// 类型化条目：data 被替换为 D。条件类型 `[D] extends [never]` 为避免分配式条件类型：
// D=never 时 data 必须是 never（无数据），否则 data 必填为 D。全部是编译期约束。
export type TypedEntry<D extends JsonValue> = Omit<EntryRecord, "data"> &
	([D] extends [never] ? { readonly data?: never } : { readonly data: D });

/** Entry content of a typed kind; the token supplies `kind`. */
// 类型化草稿：kind 与 data 都由 token 决定，调用 appendEntry(token, ...) 时不必重复传 kind。
export type TypedEntryDraft<D extends JsonValue> = Omit<EntryDraft, "kind" | "data"> &
	([D] extends [never] ? { readonly data?: never } : { readonly data: D });

/** Typed entry kind with a narrowing guard. */
// 条目种类令牌（由 defineEntry 生成）：kind 用于运行时匹配；is 是类型谓词，把 EntryRecord 收窄为 TypedEntry<D>。
// 注意：is() 只比较 kind，不校验 data 的实际 JSON 形状——类型断言成立，但运行时数据仍可能不符合 D。
export interface Entry<D extends JsonValue = never> {
	readonly kind: string;
	is(entry: EntryRecord | undefined): entry is TypedEntry<D>;
}

/** Identity fields shared by every durable submission state. */
// 所有提交状态共享的身份字段，不导出；具体状态由 SubmissionRecord 的判别联合展开。
type SubmissionRecordBase = {
	/** Adapter-owned context of the admission span; absent without propagation. */
	// 准入 span 的适配器上下文；未开启传播时没有。
	readonly trace?: TelemetryCarrier;
	readonly id: SubmissionId;
	readonly conversationId: ConversationId;
	/** Host-provided deduplication key, scoped to the conversation. */
	// 宿主提供的去重键（会话范围内唯一）：同一 requestId 重复提交应返回已有记录，而不是新建。
	readonly requestId?: string;
};

/** Durable lifecycle of one admitted user input, passive entry write, or continue. */
// 一次“已准入工作”的持久生命周期，按 type 分三类：
// - input：用户输入，等待被某个 run 放入 transcript 并回答；
// - write：被动写入条目（如系统提示/记录），不等待回答；
// - continue：不携带用户消息、直接让会话继续运行（入口不落地条目，也从不排队）。
// 每个状态用 never 字段显式禁止不适用的字段，编译期排除“done 却没有 answer”等非法组合；
// 运行时记录由 Session/Storage 按状态机写入，类型本身不做校验。
export type SubmissionRecord =
	// —— input：queued（已准入未落条目）→ placed（已落条目，run 负责回答）→ done（已回答）或 unanswered（终态无回答）。
	| (SubmissionRecordBase & {
			readonly type: "input";
	  } & (
				| {
						/** Admitted but not yet represented in the transcript. */
						// 已准入、尚未在 transcript 中形成条目；此时不能有 entry/answer/失败原因。
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Added to the transcript and owned by an active run. */
						// 已由某个活跃 run 放入 transcript（entry），等待生成回答。
						readonly status: "placed";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Successfully answered user input. */
						// 成功回答：entry 是输入条目，answer 是指向回答条目的 ID。
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer: EntryId;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Terminal input that can no longer receive an answer. */
						// 终态“无人回答”：可能有 entry（已放入但 run 结束），reason 必填，detail 可带结构化诊断。
						readonly status: "unanswered";
						readonly entry?: EntryId;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			))
	// —— write：queued（已准入未追加）→ done（已追加）或 unanswered（无法放置）；
	// 没有 placed：被动写入一旦落到条目就直接 done，不需要 run 回答。
	| (SubmissionRecordBase & {
			readonly type: "write";
	  } & (
				| {
						/** Admitted but not yet appended to the transcript. */
						// 已准入、尚未追加到 transcript。
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Successfully appended passive entry. */
						// 已完成：entry 是追加出的条目 ID；被动写入永远没有 answer。
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Terminal passive write that could not be placed. */
						// 终态失败：无法放置，没有 entry，只带原因与可选诊断。
						readonly status: "unanswered";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			))
	// —— continue：直接启动一个 run，不放置用户条目，也从不 queued；placed → done（有 answer）或 unanswered。
	| (SubmissionRecordBase & {
			/** A run started without a user message; it places no entry and is never queued. */
			// 无用户消息的继续运行：不产生 entry；三者都不允许 entry。
			readonly type: "continue";
	  } & (
				| {
						/** Owned by an active run. */
						// 已被某个活跃 run 接管。
						readonly status: "placed";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** The run answered. */
						// run 已有回答：answer 指向回答条目。
						readonly status: "done";
						readonly entry?: never;
						readonly answer: EntryId;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** The run ended without an answer. */
						// run 结束但未回答：只有原因与可选诊断。
						readonly status: "unanswered";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			));

/** Terminal status staged for a submission; identity, type, and entry come from its current record. */
// 结算提交只携带终态增量：身份/type/entry 沿用当前记录，这里只给 done 的 answer 或 unanswered 的 reason/detail。
export type SubmissionSettlement =
	| { readonly status: "done"; readonly answer: EntryId }
	| { readonly status: "unanswered"; readonly reason: string; readonly detail?: JsonValue };

/** Submission fields supplied before the Session assigns an ID. */
// 创建提交所需字段：在联合的每个成员上分别 Omit "id"，而不是对整个联合 Omit。
// `extends infer Record ? Record extends SubmissionRecord ? ...` 利用分配式条件类型逐成员处理；
// 若直接写 Omit<SubmissionRecord, "id">，Omit 会作用在联合上，丢失判别成员。
export type SubmissionCreate = SubmissionRecord extends infer Record
	? Record extends SubmissionRecord
		? Omit<Record, "id">
		: never
	: never;

/** JSON-safe error snapshot persisted instead of a runtime `Error` object. */
// 持久化的错误快照：Error 实例不能进 JSON，因此只存 message 与可选结构化 detail。
// 读取方拿到的是数据，不是可重新抛出的 Error；需要堆栈/原因时应在写入前放进 detail。
export type TaskOutcomeError = {
	readonly message: string;
	/** Optional structured diagnostic data for inspection or recovery. */
	// 任意 JSON 诊断（如错误码、字段、上游响应摘要）；运行时不做形状校验。
	readonly detail?: JsonValue;
};

/** Durable reason and optional result recorded when a task becomes terminal. */
// 任务终态收据：completed/failed/aborted/orphaned/faulted 五选一；各分支用 never 排除不合法字段。
// 一旦写入 terminal，任务记录不再变化，waitForTask/outcomes 读到的就是这个对象。
export type TaskOutcome<R> =
	// 正常完成：必须带结果。
	| {
			readonly status: "completed";
			readonly result: R;
			readonly error?: never;
			readonly reason?: never;
	  }
	/** Expected task or domain failure explicitly committed by its implementation. */
	// 预期内的业务/领域失败，由任务实现显式提交：必须有 error，可带部分 result。
	| {
			readonly status: "failed";
			readonly error: TaskOutcomeError;
			readonly result?: R;
			readonly reason?: never;
	  }
	/** Explicit cancellation handled by the task's abort protocol. */
	// 明确取消：由 abort 处理器提交；reason 可选（如取消来源），可带部分结果。
	| {
			readonly status: "aborted";
			readonly reason?: string;
			readonly result?: R;
			readonly error?: never;
	  }
	/** Task that cannot resume because its definition or migration is unavailable. */
	// 无法恢复（定义缺失/版本过旧/迁移失败）而被隔离：reason 必填，不能带结果。
	| {
			readonly status: "orphaned";
			readonly reason: string;
			readonly result?: never;
			readonly error?: never;
	  }
	/** Runtime-detected contract failure, such as an uncaught throw or no durable progress. */
	// 运行时发现契约被破坏（未捕获抛出、阶段无持久进展等）：error 必填，不能带结果。
	| {
			readonly status: "faulted";
			readonly error: TaskOutcomeError;
			readonly result?: never;
			readonly reason?: never;
	  };

/** Complete durable execution state of a task. */
// 任务完整持久状态机：pending → running → waiting/sleeping/running → … → terminal；
// completing 是“结果已定、等普通子任务结束”的过渡态。状态转换只由 Session 校验/写入，类型给出形状。
export type TaskState<S, R> =
	| {
			/** Eligible for scheduling. */
			// 待调度：可被 Harness 预留并进入 running。
			readonly status: "pending";
			/** Complete durable state from which execution resumes. */
			// 完整检查点；恢复时阶段处理器据此继续。
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			/** Reserved by one in-memory task invocation. */
			// 已被某个内存 invocation 预留（同一时刻至多一个）；崩溃后由恢复逻辑重新接管。
			readonly status: "running";
			/** Complete durable state from which execution resumes. */
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			/** Parked without an invocation until every task in `on` is terminal; then resumes at `checkpoint`. */
			// 等待子任务：不占 invocation，直到 on 中全部任务终态；之后按 policy 决定结果或继续。
			readonly status: "waiting";
			readonly checkpoint: S;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
			readonly outcome?: never;
	  }
	| {
			/**
			 * Parked without an invocation until the Harness clock reaches `until`, in milliseconds on the
			 * `HarnessOptions.now` clock; then resumes at `checkpoint`. An abort mark does not wait for it.
			 */
			// 睡眠：不占 invocation，直到 Harness 时钟（毫秒）到达 until；恢复时从 checkpoint 继续。
			// abort 标记不会等它自然醒来，而是会触发中止流程。
			readonly status: "sleeping";
			readonly checkpoint: S;
			readonly until: number;
			readonly outcome?: never;
	  }
	| {
			/** Outcome decided; becomes terminal once no ordinary owned work below is live. Runs no more code. */
			// 结果已定：不再运行任何任务代码；等其名下普通子任务全部结束后转为 terminal。
			readonly status: "completing";
			readonly checkpoint?: never;
			readonly outcome: TaskOutcome<R>;
	  }
	| {
			/** Permanently settled durable result receipt. */
			// 永久终态：记录不再变化，是外部可等待/查询的最终收据。
			readonly status: "terminal";
			readonly checkpoint?: never;
			readonly outcome: TaskOutcome<R>;
	  };

/** Identity, definition, and scheduling fields shared by every task state. */
// 所有任务状态共享的记录字段：身份、定义版本、输入、归属与运行统计。不导出，由 TaskRecord 组合。
type TaskRecordBase<I, R> = {
	/** Adapter-owned context that created this task; phase invocations extract it as their parent. */
	// 创建任务时的适配器遥测上下文；阶段调用的 span 以它为 parent。
	readonly trace?: TelemetryCarrier;
	/** Immutable creation-time links for the task's first invocation. */
	// 创建时固定的遥测 links，只用于第一次调用。
	readonly links?: readonly TelemetryCarrier[];
	// 任务 ID；R 把结果类型编码进 ID，waitForTask/outcomes 可推导结果。
	readonly id: TaskId<R>;
	// 所属会话；子任务通常与父任务同会话。
	readonly conversationId: ConversationId;
	/** Registered task definition name. */
	// 注册名，与 TaskDefinition.name 对应；运行时按它查定义。
	readonly kind: string;
	/** Definition version used to migrate live input and checkpoints. */
	// 创建/最后一次迁移后的定义版本；升级/降级判断与 migrate 使用。
	readonly version: number;
	/** Original task input retained while the task is live or terminal. */
	// 原始输入：存活与终态都保留，重启/迁移/诊断可重放。
	readonly input: I;
	/** Owning task of a child task; absent for a task its conversation owns. Immutable. */
	// 子任务的父任务 ID；由会话直接拥有的顶层任务没有该字段。创建后不可变。
	readonly owner?: TaskId;
	/** Whether this conversation-owned task is excluded from ordinary idle waits, conversation aborts, and cascades. */
	// 是否后台任务：不阻止会话空闲、不随会话中止、不参与普通级联清理。
	readonly background: boolean;
	/** Durable abort mark checked before run-mode progress is committed. */
	// 持久中止标记：run 模式提交进展前检查；置位后任务走 abort 流程。
	readonly abortRequested: boolean;
	/**
	 * Why the mark was set when not by an abort request: `restart` for a task abandoned after a restart
	 * (`TaskOptions.abandonOnRestart`) or below one. Such a task waits for its definition instead of becoming `orphaned`.
	 * A later abort request clears it.
	 */
	// 非显式中止时的标记原因：restart 表示因 abandonOnRestart 在重启后被放弃（或其下级如此）。
	// 这类任务会等待定义/注册表，而不是立即 orphaned；之后真正的 abort 请求会清掉该原因。
	readonly abortReason?: "restart";
	/** Set from `TaskOptions.abandonOnRestart`. Immutable. */
	// 从创建选项复制而来，创建后不可变；用于重启时判断是否放弃。
	readonly abandonOnRestart?: true;
	/**
	 * Wall-clock milliseconds of the first change to `running`, stamped by the Session. Kept through waits and recovery,
	 * so the span to `endedAt` includes them. Absent before the task first runs, and on records written by earlier
	 * versions.
	 */
	// 第一次进入 running 的墙上时钟毫秒（由 Session 打戳）；等待/恢复期间保留，因此到 endedAt 的跨度包含中间等待。
	// 首次运行前没有；旧版本记录也可能没有。
	readonly startedAt?: number;
	/** Wall-clock milliseconds of the change to `terminal`, stamped by the Session; absent while live. */
	// 进入 terminal 的墙上时钟毫秒；存活期间没有。
	readonly endedAt?: number;
	/**
	 * How many times in a row a crash, eviction, or reset cut the task off while it ran, without the task changing its
	 * state since; open counts them, and a close does not. At `HarnessSettings.restartLimit` the task ends (the built-in
	 * tasks end themselves, visibly; the scheduler faults any other kind), and a generation reads it to charge an
	 * interrupted model request as a failed attempt.
	 */
	// 连续重启计数：任务运行中因崩溃/驱逐/重置被切断且状态未变时累加；正常关闭不计。
	// 达到 restartLimit 时任务结束（内置任务显式结束；其他类型由调度器置 faulted）；生成任务也用它判断模型请求是否算失败尝试。
	readonly restarts?: number;
};

/** Complete replacement record for one durable task state machine. */
// 任务记录的完整替换值（不是补丁）：base + 当前 state；写入时整条替换，持久化实现据此保持不可变历史/最新值。
export type TaskRecord<I, S, R> = TaskRecordBase<I, R> &
	(
		| {
				// 存活/可运行状态（pending/running/waiting/sleeping）可以带 memos。
				readonly state: Extract<
					TaskState<S, R>,
					{ readonly status: "pending" | "running" | "waiting" | "sleeping" }
				>;
				/** Small first-writer-wins values retained while the task can run. */
				// 小型的首写者胜备忘；只有任务还能运行时保留，进入 completing/terminal 后必须清空。
				readonly memos?: Readonly<Record<string, JsonValue>>;
		  }
		| {
				// completing/terminal 不允许再有 memos（never），避免终态记录继续携带临时状态。
				readonly state: Extract<TaskState<S, R>, { readonly status: "completing" | "terminal" }>;
				readonly memos?: never;
		  }
	);

/** Persisted lifecycle record for one create-to-retire document incarnation. */
// 文档“化身”（incarnation）的持久生命周期：同一逻辑地址可以被创建、退役、再创建，每次得到新的 DocumentId。
// 记录本身不可变；变的是 createdAt/retiredAt 以及后来的新化身。
export type DocumentRecord = {
	/** Unique incarnation ID; never reused when the same logical document is recreated. */
	// 化身唯一 ID；同一逻辑文档重建会换新 ID，绝不复用。
	readonly id: DocumentId;
	/** Stable document definition kind. */
	// 定义 kind；与地址、Definition 匹配。
	readonly kind: string;
	/** Family member key; absent for singleton documents. */
	// 文档族成员 key；单例文档没有。
	readonly key?: string;
	/** Commit that created the incarnation, stamped by storage. */
	// 创建该化身的提交序号（storage 打戳）；用于 as-of 查询判断某时刻是否存活。
	readonly createdAt: Seq;
	/** Commit that retired the incarnation; absent while it is current. */
	// 退役提交序号；当前化身没有该字段。退役后仍可被历史读取。
	readonly retiredAt?: Seq;
} & ( // 作用域三种：session 全局、conversation 会话内、task 任务内；会话作用域额外带 history/fork 语义。
	| {
			readonly scope: { readonly kind: "session" };
			// session 文档不支持历史回放与分叉，故用 never 禁止。
			readonly history?: never;
			readonly fork?: never;
	  }
	| ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
			| {
					/** Retain only current state. */
					// 只保留当前状态。
					readonly history: "latest";
					/** Initialize a fork from current source state or the definition's initial value. */
					// fork 只能复制当前状态或初始值。
					readonly fork: "current" | "initial";
			  }
			| {
					/** Retain history needed for as-of reads. */
					// 保留可回放历史（base + delta 链）。
					readonly history: "rewindable";
					/** Initialize a fork at its cutoff, from current state, or from the initial value. */
					// fork 可回到历史点（asOf）、当前状态或初始值。
					readonly fork: "asOf" | "current" | "initial";
			  }
	  ))
	| {
			readonly scope: { readonly kind: "task"; readonly taskId: TaskId };
			// 任务文档随任务终结退役；不支持历史/分叉。
			readonly history?: never;
			readonly fork?: never;
	  }
);

/** Fields supplied when storage creates and stamps a new `DocumentRecord`. */
// 创建文档时调用方提供字段，createdAt/retiredAt 由 storage 打戳，所以逐成员 Omit（与 SubmissionCreate 同理）。
export type DocumentCreate = DocumentRecord extends infer Record
	? Record extends DocumentRecord
		? Omit<Record, "createdAt" | "retiredAt">
		: never
	: never;

/** One ordered scan result and its optional continuation state. */
// 通用分页结果：items 是本页；next 是后端私有的续扫游标，没有更多则为 undefined。
// T 元素类型、C 游标类型由具体查询决定。
export type Page<T, C> = {
	readonly items: readonly T[];
	readonly next?: C;
};

/**
 * Backend-owned JSON continuation state that callers only round-trip to the same scan. It carries the scan's order: a
 * scan given a cursor continues in that order, and rejects a different `order` in its query.
 */
// 后端私有的续扫状态：调用方不得解释，只需原样回传。游标绑定扫描顺序；带着游标却换 order 会被拒绝
// （通常表现为 StorageRequestError，非致命读取错误）。
export type Cursor = Readonly<Record<string, JsonValue>>;

/** ID order of a scan: `ascending` is oldest first, `descending` newest first. */
// 扫描顺序：ascending 按 ID 从旧到新；descending 从新到旧。ID 由 mintId 保证创建顺序。
export type ScanOrder = "ascending" | "descending";

/** Optional filters for an ordered conversation scan. */
// 会话扫描过滤：可按创建者（owner 边）筛选；所有条件为空则扫描全部会话。
export type ConversationQuery = {
	// 只返回 owner.conversationId 等于该值的会话。
	readonly ownerConversationId?: ConversationId;
	// 只返回 owner.taskId 等于该值的会话（即某任务创建的子树）。
	readonly ownerTaskId?: TaskId;
	/** Default `ascending`; with a cursor, the cursor's order. */
	// 默认升序；带游标时实际顺序由游标决定，不允许改 order。
	readonly order?: ScanOrder;
};

/** Inclusive ID bounds for a scan of one conversation's fork-aware history. */
// 单个会话（含 fork 祖先可见条目）的条目扫描：min/max 都是闭区间；默认从新到旧。
export type EntryQuery = {
	readonly conversationId: ConversationId;
	/** Oldest entry ID that may be returned. */
	// 可返回的最旧条目 ID（含）。
	readonly minEntryId?: EntryId;
	/** Newest entry ID that may be returned. */
	// 可返回的最新条目 ID（含）。
	readonly maxEntryId?: EntryId;
	/** Default `descending`; with a cursor, the cursor's order. */
	// 默认降序（先看最新）；带游标时沿用游标顺序。
	readonly order?: ScanOrder;
};

/** Optional filters for an ordered scan of durable task records. */
// 任务扫描过滤：字段间是 AND；status 取 TaskState 的判别值字符串。
export type TaskQuery = {
	readonly conversationId?: ConversationId;
	readonly kind?: string;
	readonly status?: TaskState<JsonValue, JsonValue>["status"];
	readonly abortRequested?: boolean;
	readonly background?: boolean;
	/** Default `ascending`; with a cursor, the cursor's order. */
	readonly order?: ScanOrder;
};

/** Optional filters for an ordered scan of submission records. */
// 提交扫描过滤：会话 + 状态；默认升序。
export type SubmissionQuery = {
	readonly conversationId?: ConversationId;
	readonly status?: SubmissionRecord["status"];
	/** Default `ascending`; with a cursor, the cursor's order. */
	readonly order?: ScanOrder;
};

/** Current state or one historical commit sequence used for document membership and content reads. */
// 文档读取“点”：current 表示最新状态；Seq 表示某个提交时刻（as-of），用于判断当时哪个化身存活。
export type DocumentPoint = Seq | "current";

/** Exact logical identity of a singleton or one keyed family member. */
// 文档精确逻辑地址：kind + scope（+ key）。key 缺省表示单例；同一地址可能先后有多个化身。
export type DocumentAddress = {
	readonly kind: string;
	readonly scope: DocumentRecord["scope"];
	/** Absent selects the singleton; present selects one family member. */
	// 省略选单例；提供则选文档族中该 key 的成员。
	readonly key?: string;
};

/** Ordered scan of document incarnations alive in one exact scope at one point. */
// 在某个精确作用域、某个时间点扫描“当时存活”的文档化身；kind 可选进一步筛选。
export type DocumentQuery = {
	readonly scope: DocumentRecord["scope"];
	readonly at: DocumentPoint;
	readonly kind?: string;
};

/** Complete checkpoint or Chord operation batch selected by the owning Session. */
// 文档的持久内容：base（完整 JSON + 版本）或 delta（Chord Op 列表 + 版本）。
// 由 Session 决定何时写 base/delta；storage 只负责存，不解释 Op。
export type DocumentContent =
	| {
			readonly version: number;
			readonly kind: "base";
			readonly value: JsonObject;
	  }
	| {
			readonly version: number;
			readonly kind: "delta";
			readonly ops: readonly Op[];
	  };

/** Exact persisted source selected for a definition-free document copy. */
// 不带定义的文档复制源：指定化身 ID 与读取点，storage 直接复制其持久内容，无需了解定义/迁移。
export type DocumentCopySource = {
	readonly id: DocumentId;
	readonly at: DocumentPoint;
};

/** Detached materialized value and stored definition version at a selected point. */
// Storage.document() 的结果：记录 + 物化后的完整 JSON + 定义版本 + 为物化重放的 delta 数。
// value 是分离副本（调用方修改不会影响存储）；deltasSinceBase 可用于诊断/检查点策略。
export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly version: number;
	readonly value: JsonObject;
	/** Deltas replayed after the selected base to materialize `value`. */
	readonly deltasSinceBase: number;
};

/** One record or document mutation in an atomic storage commit. */
// 原子存储提交中的单个变更。表记录（conversation/entry/task/submission）是整条替换；
// 文档有创建、定义无关复制、增量/基线变更、退役四种。
// 注意：document.create 只能配 base（不能新建一个 delta）；document.copy 不需要定义，storage 直接复制源内容。
export type StorageWrite =
	| { readonly type: "conversation"; readonly value: ConversationRecord }
	| { readonly type: "entry"; readonly value: EntryRecord }
	| { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
	| { readonly type: "submission"; readonly value: SubmissionRecord }
	| {
			readonly type: "document.create";
			readonly record: DocumentCreate;
			// Extract 把联合收窄到 base 分支：创建必须提供完整基线。
			readonly content: Extract<DocumentContent, { readonly kind: "base" }>;
	  }
	| { readonly type: "document.copy"; readonly record: DocumentCreate; readonly source: DocumentCopySource }
	| {
			readonly type: "document.change";
			readonly id: DocumentId;
			readonly content: DocumentContent;
	  }
	| { readonly type: "document.retire"; readonly id: DocumentId };

/**
 * Committed change of one document incarnation: `type: "document"` with `kind: "change"` (a creation or an update) or
 * `kind: "retire"` (this commit retired the incarnation), or a `document.copy`.
 */
// 发布给观察者的文档变更：change（创建或更新，携带采纳后的完整值/Op）、retire（本提交使其退役）、copy（复制子文档）。
// conversationId 仅在 session 文档时为 undefined；任务文档从任务记录推导，其余由作用域给出。
export type DocumentCommitChange =
	| {
			readonly type: "document";
			readonly kind: "change";
			readonly record: DocumentRecord;
			/** Conversation owning the document; task documents derive it from their task record. Undefined only for Session documents. */
			// 所属会话；只有 Session 级文档为 undefined。
			readonly conversationId: ConversationId | undefined;
			/** Definition version of `value`. */
			// 该值的定义版本。
			readonly version: number;
			/** Exact adopted immutable revision. */
			// 采纳后的精确不可变值；观察者据此重建状态。
			readonly value: JsonObject;
			/** Exact adopted operations for an ordinary update; empty for creation. */
			// 普通更新的操作列表；创建时为空数组。
			readonly ops: readonly Op[];
	  }
	| {
			readonly type: "document";
			readonly kind: "retire";
			readonly record: DocumentRecord;
			/** Conversation owning the document; task documents derive it from their task record. Undefined only for Session documents. */
			// 所属会话；只有 Session 级文档为 undefined。
			readonly conversationId: ConversationId | undefined;
	  }
	| {
			/** Definition-free child initialization; consumers hydrate through watch acquisition. */
			// 定义无关的子文档初始化；消费者通过后续 watch 获取内容，而不是在此处携带值。
			readonly type: "document.copy";
			readonly record: DocumentRecord;
			readonly conversationId: ConversationId;
			readonly source: DocumentCopySource;
	  };

/** Complete table record committed without another publication copy. */
// 表记录变更可直接作为发布内容；用 Extract 从 StorageWrite 中取四个表记录分支，排除文档分支。
export type TableCommitChange = Extract<
	StorageWrite,
	{ readonly type: "conversation" | "entry" | "task" | "submission" }
>;

// 一次提交发布的所有变更：表记录 + 文档变更。变更顺序不保证，观察者必须按值/Op 语义而非数组位置理解。
export type CommitChange = TableCommitChange | DocumentCommitChange;

/**
 * Every immutable change one Session storage transaction stored, with its `seq`. Change order is unspecified. A commit
 * held in memory (`CommitPersistence`) is published once it is stored: by the next commit that reads or writes its
 * document, alone (`seq` of its own), or with that commit, whose document change then carries the held operations
 * followed by its own.
 */
// 一次存储事务的完整发布：本批所有不可变变更 + 提交序号 seq。数组顺序无意义。
// 内存中延迟（CommitPersistence.deferred）的提交只在真正落库后发布：可能单独发布（自己的 seq），
// 也可能并入下一个读写该文档的提交，此时该文档变更的 ops 先含被持有的操作，再含新提交的操作。
export type CommitPublication = {
	readonly seq: Seq;
	readonly changes: readonly CommitChange[];
};

/**
 * Transaction surface of one Session commit callback.
 * Table reads and creation results are trusted immutable values and may be shared with internal commit state; the
 * Session may freeze them (its caches and context ranges keep them), so mutating one can throw.
 */
// 一次 Session 提交回调内的事务面：读与写都经过同一个 tx，Session 保证原子性与 ReadAfterWrite 顺序。
// 返回值/读取结果是“可信不可变值”，可能与会话缓存共享并被 Object.freeze，修改可能抛错；调用方应视为只读。
// 所有方法都是异步的，但实现可能直接返回已缓存值；不要在回调外保存 tx 再使用。
export interface Tx {
	// —— 单条读取：不存在返回 undefined；只读本提交之前已发布（或本事务已写）的状态。
	conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
	entry(id: EntryId): Promise<EntryRecord | undefined>;
	/** Undefined when the entry is absent or has another kind. */
	// 类型化读取：kind 不匹配或不存在都为 undefined；is 的收窄只在读取成功后成立。
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
	task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	// —— 分页扫描：limit 必填，cursor 可选；order 语义见各 Query。
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<ConversationRecord, Cursor>>;
	scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
	/** Newest visible entry of the conversation that carries a `head`. */
	// 最新活动上下文标记：返回带 head 的条目；用于在写入新条目时延续/替换 head 链。
	latestHeadMarker(conversationId: ConversationId): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
	/** ID of the newest entry visible from the conversation; `undefined` when it has none. */
	// 会话当前可见的最新条目 ID；空会话为 undefined。
	latestEntryId(conversationId: ConversationId): Promise<EntryId | undefined>;
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;
	/** Committed submission with a conversation-scoped request ID. */
	// 按会话内 requestId 查提交：宿主去重的读取入口。
	submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined>;

	// —— 写入：创建/追加立即成为本事务的一部分，提交成功才可见；返回的记录带 Session 分配的 ID。
	/** Create a conversation with explicitly selected ownership. */
	// 创建会话；必须显式给归属（ownerless 或某任务），没有默认值。
	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord>;
	/** Create a history fork at one concrete visible entry with explicitly selected ownership. */
	// 在指定父会话的某个可见条目处分叉；at 必须具体存在且可见，归属同样必填。
	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord>;
	/** Returned records are Session-owned immutable values and may be shared with commit listeners. */
	// 追加普通条目：kind/data 由 draft 给出；返回的记录可能被冻结。
	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	/** The token supplies `kind` and types `data`. */
	// 类型化追加：token 提供 kind；NoInfer<D> 阻止从 value 反向推断 D，确保 D 只由 token 决定。
	appendEntry<D extends JsonValue>(
		token: Entry<D>,
		conversationId: ConversationId,
		value: TypedEntryDraft<NoInfer<D>>,
	): Promise<TypedEntry<D>>;
	// 创建持久任务：调用 initial(input) 得到首个检查点；默认继承当前绑定/父任务的会话。
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: TaskOptions,
	): Promise<TaskId<R>>;
	/**
	 * Create a raw submission record with a fresh ID. No admission rules apply: no busy check, no inbox queueing, no
	 * placement. Use `Conversation.submit()` or a conversation handle unless the caller implements admission itself.
	 */
	// 创建原始提交记录：不做忙碌检查、不排队、不放置；仅当调用方自己实现准入时使用。
	// 普通应用应通过 Conversation.submit()/会话句柄，让 Harness 处理准入与放置。
	createSubmission(create: SubmissionCreate): Promise<SubmissionRecord>;
	/**
	 * Settle a queued or placed submission; only a placed input or continue can be answered, and a settled submission stays
	 * unchanged. Resolved against this transaction's latest record of the submission, so it works after table writes.
	 * Run tasks settle the inputs they answer.
	 */
	// 结算提交：只有 placed 的 input/continue 能被回答；已结算记录不再改变。
	// 解析时使用本事务最新记录（而非回调开始时的快照），因此可以在同一事务里先改写再结算。
	settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void;
	/**
	 * Place a queued submission at `entry`: an input becomes `placed`, a write `done`. Resolved like
	 * `settleSubmission()`. Inbox boundaries place the submissions they select.
	 */
	// 放置排队中的提交：input → placed，write → done；解析规则同 settleSubmission。
	// Inbox 在边界处调用它，把选中的排队项放进 transcript。
	placeSubmission(id: SubmissionId, entry: EntryId): void;

	// —— 文档读写：重载按 token 作用域选参数。doc() 返回 Chord 的 Draft<T>（可修改 value、产生 ops）；
	// 若地址不存在，会按定义 initial()/initial(seed) 创建初始化 base。文档族必须给 key 与 seed；
	// seed 只在成员缺失时传给 initial，已存在成员忽略 seed（不会覆盖已有值）。
	doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
	doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<Draft<T>>;
	doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;

	// —— 文档退役：使当前化身 retired；之后可重新创建同地址的新化身。族成员需要 key，单例不需要。
	// 退役是幂等的持久动作（对已退役地址再次调用是否报错由 Session 决定），本类型只约束参数。
	retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
	retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<void>;
	retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
	): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
	): Promise<void>;
}

/**
 * Watch of one document address (kind, scope, and key), from the incarnation found at acquisition on. A retirement is a
 * call with `retired` set, the last value the watch was given and no ops (a change made in the retiring commit itself
 * is not shown: that commit publishes the retirement only); the watch goes on, and a document created at the address
 * later arrives as `[["r", value]]`, folded with what is pending. It ends `ended` when its scope's owner ends: a task
 * document's watch once the retirement call of the commit that makes its task terminal returned, every watch at Session
 * close (a pending retirement dropped); `failed` with the error that failed the Session.
 */
// 单个文档地址的 watch：从获取时找到的化身开始推送。退役会作为一次“retired 标记 + 最后值 + 空 ops”的调用出现；
// 同一提交里先改后退时只看到退役。watch 不会自己结束；之后同地址新建的文档会作为新的 value 调用出现。
// 结束条件：作用域拥有者结束（任务终态时先收到退役调用）、Session 关闭（所有 watch 结束）或 Session 失败。
export type DocumentWatch<T extends JsonObject> = WatchHandle<Readonly<T>>;

/**
 * A synchronous observer of committed Durable state, for adapters such as a Chord source (`observeDoc()`,
 * `Harness.observeConversation()`, `Harness.observeTaskGraph()`), with the shapes of Chord's watch: `advance` gets a
 * `WatchCall`, `end` a `WatchEnd`. `advance` gets every change, unfolded, as memory adopts it: for a stored commit at its
 * publication once Storage stored it, for a deferred one before it is stored. A view or the graph gets at most one call
 * per commit, a document observer one per change at its address (two for a commit that retires and recreates it); the
 * task graph also advances outside any commit's publication, on the Session line, when a registry change or a failed
 * migration changes a
 * `blocked` reason. Durable's failures are final, so every call is a `value` call; a failure ends the observer. Calls
 * may come before the attaching promise resolves; their ops apply from `Observation.value`. `advance` must only record
 * the call, synchronously and quickly, never await, call the Session, or throw. A throw is reported as
 * `listener_error`, detaches the observer, and ends it `listener_error` with the error. `end` is called once: `ended`
 * when the observed scope's owner ends (a task document's task, after its retirement change, inside that commit's
 * `adopt`), `failed` with "session closed" when the Session closes (an adapter follows the next Session) or with the
 * error that failed the Session; never after `detach()`.
 */
// 同步观察者：形态与 Chord watch 对齐（advance 收 WatchCall，end 收 WatchEnd）。要点：
// - advance 在内存采纳变更时调用；stored 提交在存储后发布，deferred 提交在落库前也会先推给观察者。
// - 视图/任务图每次提交至多一次 advance；文档观察者按地址每次变更一次（退役并重建可能两次）。
// - Durable 的失败是最终态，调用只会是 value 调用；失败即结束观察。
// - advance 必须同步、快速、只记录；禁止 await、调用 Session 或抛错。抛错会转成 listener_error 并分离观察者。
// - end 只调用一次：作用域结束为 ended；Session 关闭/失败为 failed；detach 后不再调用。
export type Observer<T> = {
	advance(call: WatchCall<T>, context: Context): void;
	end(end: WatchEnd): void;
};

/**
 * A synchronous observer of stored commits (`Session.observeCommits()`): `advance` gets each `CommitPublication`, `end`
 * the Session's close (`failed` with "session closed", or with the error that failed the Session).
 */
// 已存储提交的同步观察者：每次发布收到 CommitPublication；Session 关闭/失败时收到 end。
// 与 Observer 一样只能快速记录，不能阻塞或调用 Session API。
export type CommitObserver = {
	advance(publication: CommitPublication, context: Context): void;
	end(end: WatchEnd): void;
};

/** An attached `CommitObserver`: how to detach it. Idempotent: no `advance` or `end` follows it. */
// 已附加提交观察者的句柄；detach 幂等，调用后不再有 advance/end。
export type CommitObservation = { detach(): void };

/** An attached `Observer`: the value at attachment, which every later `advance` starts from, and how to detach it. */
// 已附加观察者的句柄：value 是附加瞬间的状态，后续每次 advance 的 ops 都从它开始应用；
// detach 幂等，且调用后（包括正在进行的提交的剩余部分）不再收到任何调用。
export type Observation<T> = {
	readonly value: T;
	/** Idempotent: no `advance` or `end` follows it, not even for the rest of a commit underway. */
	detach(): void;
};

/** Committed document reads. */
// 只读文档能力：直接复用 Session 的 snapshot/snapshotAsOf，不含写/观察方法。
export type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;

/** Non-creating document watch acquisition shared by Session and later invocation APIs. */
// 非创建式 watch 获取：文档不存在时返回 undefined，不会为了 watch 而初始化文档。
// 重载与 Tx.doc 一致，按 token 作用域决定是否需要 conversationId/taskId/key；Session 与任务运行时共享这组能力。
export interface DocumentObserver {
	watchDoc<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
}

/** Why a Session ended, by `kind`: `close()`, or a failed Storage call, whose error it carries. */
// Session 结束原因：主动 close()（closed），或某次 Storage 调用失败导致 Session 自动关闭（failed + error）。
// closed Promise 只会以这两种结果结束，不会 reject。
export type SessionEnd = { readonly kind: "closed" } | { readonly kind: "failed"; readonly error: unknown };

/**
 * When a commit reaches Storage. `immediate`, the default: before `commit()` resolves. `deferred`: when every write of
 * the commit changes an existing conversation document with `history: "latest"` and `fork: "initial"` (no creation,
 * migration, or retirement), the Session adopts it in memory, shows it to watches and views, and resolves, but stores it
 * later: with the next commit that reads (`tx.doc()`) or writes that document, before the document leaves memory or
 * retires, at `close()`, and at the latest about `withinMs` after the commit (default `settings.progress.persistWithinMs`,
 * 1,000 ms; `Infinity` waits for one of the others). A commit that writes anything else is immediate. A crash loses what
 * is held, so only state whose loss is acceptable, such as streamed progress, should be deferred, and nothing durable may
 * depend on it without reading it in a commit.
 */
// 提交何时真正进入 Storage：
// - immediate（默认）：commit() 解析前已存储；
// - deferred：仅当本提交所有写入都是“修改已存在的 conversation 文档，且 history: latest、fork: initial”
//   （无创建/迁移/退役）才可延迟。Session 先在内存采纳并推给 watch/视图，然后 commit() 返回，之后在
//   下一次读/写该文档的提交、文档离开内存/退役前、close()、或最迟 withinMs（默认 1000ms，Infinity 表示只依赖前述时机）时落库。
// 写入其他任何内容都会立即存储。崩溃会丢失被延迟的内容，因此只应延迟“丢了也能接受”的状态（如流式进度）；
// 任何持久语义都不能依赖未落库的延迟写入，除非在同一次提交内重新读取它。
export type CommitPersistence =
	| { readonly kind: "immediate" }
	| { readonly kind: "deferred"; readonly withinMs?: number };

/** Options of one Session commit. */
// 单次提交的选项；省略 persistence 等价于 immediate。
export type CommitOptions = { readonly persistence?: CommitPersistence };

/** Owner of one mutation line, its records, and its tracked documents. */
// Session：单条变更线的拥有者，串行化所有事务、维护缓存/文档并发布观察事件。
// 它本身不调度任务（那是 Harness 的职责），只提供原子提交、文档读写、watch/观察与关闭语义。
export interface Session extends DocumentObserver {
	/**
	 * Run one atomic transaction on the Session mutation line. Inside the callback read only through `tx`: `snapshot()`, `watchDoc()`, `getTask()`, and the other Session and runtime reads may queue on the line the callback holds, and then never resolve.
	 * `options.persistence` may defer storing it (`CommitPersistence`). The callback may run while an earlier commit is
	 * being stored: at its first read or write of what an unpublished commit wrote, it waits until that commit is stored
	 * and published; code before that runs early, so act on what it computes only once the commit resolves. Resolves
	 * once the commit is stored and published, after every earlier commit's outcome.
	 */
	// 在变更线上运行一个原子事务，返回回调结果。回调内只能通过 tx 读；调用 snapshot/watchDoc/getTask 等
	// 可能排在当前事务线之后，导致永不完成。
	// 与前一提交重叠：第一次读写“未发布提交写过的东西”时会等待其落库+发布；之前的代码可能提前执行，
	// 因此只有 commit() 解析后才应使用回调计算结果。解析时机：已存储并发布、且更早提交的结果都已确定。
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context, options?: CommitOptions): Promise<T>;
	/** Seal admission, settle admitted commits, then close storage. */
	// 关闭：先封住准入（不再接受新工作），结算已准入提交，再关闭 Storage；此后所有操作 reject。
	close(context: Context): Promise<void>;
	/**
	 * Settles once the Session has closed, Storage included: after `close()`, or after the first failed Storage call,
	 * which closes the Session itself. A failed Session is reopened from Storage; nothing else is left to clean up.
	 */
	// 关闭完成信号：主动 close() 或首次 Storage 调用失败（Session 自动关闭）后结算。
	// 不 reject；失败的 Session 需从 Storage 重新打开，内存中没有其他需要清理的状态。
	readonly closed: Promise<SessionEnd>;
	/**
	 * Attach a synchronous `Observer` to one document address, atomically on the Session line, as `watchDoc()` acquires
	 * a watch: the observation's value includes every commit before it, and `advance` gets every later one, retirements
	 * and later incarnations included. `undefined` when the address is absent. `context` governs only the attachment:
	 * cancelled while attaching, the promise rejects and nothing stays attached.
	 */
	// 原子地在 Session 线上附加文档观察者（与 watchDoc 获取同一时刻的值）：Observation.value 含此前所有提交，
	// 之后每次变更（含退役/新化身）走 advance。地址不存在返回 undefined。
	// context 只控制“附加”这一步：附加期间取消则 reject，且不留下任何观察者。重载按 token 作用域选参数。
	observeDoc<T extends JsonObject>(
		token: SessionDocToken<T>,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	observeDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		observer: Observer<Readonly<T>>,
		context: Context,
	): Promise<Observation<Readonly<T>> | undefined>;
	/**
	 * Observe stored commits, each with exactly what it stored, except that a document the commit retires is published
	 * as its retirement only; a commit held in memory is published when it is stored (`CommitPublication`). Commits are
	 * published in line order once Storage stored them, a macrotask apart; a publication queues one dispatch, which runs
	 * a microtask later, before every wait the commit resolves and every abort it queues, and calls the observers
	 * attached by then; a commit published while none was attached has no dispatch. There is no order relative to watch listeners. `advance` runs synchronously and must not block or
	 * call Session APIs; a throw is reported as `listener_error`, detaches the observer, and ends it `listener_error`.
	 * `end` is called once, when the Session closes (`ended`, after its last publication) or fails (`failed`), never
	 * after `detach()`. Attaches synchronously; the observation has no `value`: commits are events, not a state, and the
	 * Session does not know Storage's newest `seq` before its own first commit.
	 */
	// 观察已存储提交：每次拿到该提交实际存储的内容；退役提交只发布退役。提交按线顺序、存储后相隔一个宏任务发布，
	// 发布再排队一个微任务，在该提交相关的 wait/abort 之前调用“届时已附加”的观察者；没有观察者时没有派发。
	// 与 watch 监听器之间没有顺序保证。advance 同步执行，禁止阻塞或调用 Session API；抛错会转为 listener_error
	// 并分离/结束该观察者。end 只在 Session 关闭（ended，最后一次发布后）或失败（failed）时调用，detach 后不再调用。
	// observeCommits 同步附加；Observation 没有 value：提交是事件不是状态，Session 在首次提交前也不知道 Storage 的最新 seq。
	observeCommits(observer: CommitObserver): CommitObservation;
	/**
	 * Observe close synchronously when it begins, also when a failed Storage call closes the Session. The listener must
	 * not block or call Session APIs.
	 */
	// 同步观察关闭开始（包括 Storage 失败触发的自动关闭）；监听器禁止阻塞或调用 Session API。
	// 返回取消订阅函数；取消后不再调用。
	subscribeClose(listener: () => void): () => void;

	// 文档快照：返回当前值的只读视图；不存在为 undefined。重载与 doc/watchDoc 的作用域参数一致。
	// 返回对象可能与内部缓存共享，调用方不得修改；需要独立副本时自行复制。
	snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;

	// 历史读取：at 是可见条目 ID，读取“该条目被写入时”的文档值。只接受 Rewindable*Token
	// （history: "rewindable" 且 fork 支持 asOf）；不可回放的定义在编译期就被排除。
	// 文档不存在或该点不可用返回 undefined。
	snapshotAsOf<T extends JsonObject>(
		token: RewindableConversationDocToken<T>,
		conversationId: ConversationId,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshotAsOf<T extends JsonObject, I extends JsonValue>(
		token: RewindableConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
}

/** What `Storage.commit()` stored: the number of durable batches, and why the next one was refused, if one was. */
// 提交结果：stored 是已持久化的批次数；refused 是 Durable 自检拒绝下一批的原因（若有）。
// stored 可能小于输入批次数，调用方必须据此判断哪些批次已生效。
export type CommitResult = { readonly stored: number; readonly refused?: unknown };

/**
 * Atomic persistence boundary for Session records.
 *
 * Storage trusts the owning Session to supply semantically valid records, references,
 * ancestry, and transitions. Implementations enforce atomicity, global ID ownership,
 * immutable conversation/entry creation, document record consistency, and detached values;
 * Session serializes commits.
 *
 * An error a method throws is final: it fails the Session, which nothing retries, so retry transient failures inside
 * the method. Two errors of a read fail only that read: a `StorageRequestError` for an invalid request (an unknown
 * conversation, a foreign or malformed cursor, history a document does not keep), which must have no durable effect, and a
 * rejection because its caller's context was aborted. Any error from `commit()` or `mintId()` is fatal.
 */
// 原子持久化边界。信任边界：Storage 信任 Session 提供的记录在语义上有效（引用、祖先、状态转换），
// 自己只强制：原子性、全局 ID 唯一/顺序、conversation/entry 创建后不可变、文档记录一致性、返回值的“分离”副本；
// 提交串行化由 Session 负责，Storage 不需要处理并发 Session。
// 错误语义（非常重要）：
// - 一般方法抛错即最终失败：Session 关闭，不自动重试；因此瞬时故障必须在方法内部重试。
// - 只有两种读取错误不致命：StorageRequestError（非法请求：未知会话、外来/损坏游标、文档不保留的历史，且必须无持久副作用），
//   以及调用方 context 被取消导致的 rejection。
// - commit()/mintId() 的任何错误都是致命的。
export interface Storage {
	/**
	 * Persist `batches` in order, each as one ordinary atomic commit with its own seq, checked against the state the
	 * earlier ones left, in as few round trips as the backend can. Every batch has at least one write: a commit without
	 * writes never reaches Storage, so the Session never sends an empty batch. Stops at the first batch Durable's own checks refuse
	 * (global IDs, document actions, copy resolution): the batches before it are durable, it and the ones after are not.
	 * Calls `receive(index, seq)` once per durable batch, in order, synchronously, after all of them are durable and
	 * before the next commit starts. Resolves with the number of durable batches and the refusal, if any. Rejects for an
	 * unknown outcome (connection lost, statement or commit failed); `receive` calls made before the rejection still
	 * stand. `receive` is a durability receipt, not publication: the Session publishes later. Once it resolved, later
	 * reads through this storage observe the stored batches.
	 */
	// 按顺序持久化 batches，每批是独立原子提交、各自 seq，并相对前序批次的最终状态校验；后端应尽量合并往返。
	// 每批至少一个写入（Session 不会发送空批）。在 Durable 自检拒绝的第一批处停止（全局 ID、文档动作、复制源解析）：
	// 之前的批次已持久，该批及之后没有。
	// receive(index, seq) 在每个成功批次后同步调用一次（全部持久后、下一提交开始前）；resolve 时给出已持久批次数与拒绝原因；
	// 结果未知（连接丢失、语句/提交失败）则 reject，但 reject 前的 receive 仍然有效。
	// receive 只是持久回执，不是发布；Session 之后才发布。commit resolve 后，经此 Storage 的后续读取能看到已存批次。
	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult>;

	/**
	 * Optional. Run `publish`, the Session's publication of one stored or held commit (its cache write-through,
	 * adoption, and observers), inside this storage's own scope, such as a store's attached host batch, so what the
	 * publication marks lands together. Call `publish` exactly once, now or soon after; the Session publishes the next
	 * commit only once it ran. Without it, the Session publishes directly.
	 */
	// 可选钩子：把 Session 的发布动作（缓存写穿、内存采纳、通知观察者）放进 Storage 自己的作用域执行
	// （例如宿主批处理），使发布标记与存储动作一起生效。必须恰好调用 publish 一次（现在或稍后）；
	// Session 在它跑完前不会发布下一提交。未实现时 Session 直接发布。
	publishing?(publish: () => void, context: Context): void;

	/**
	 * Return a fresh branded candidate from the Session-global numeric ID namespace, greater than every ID minted since
	 * this storage was opened and every ID stored, also across reopen: scans order by ID as creation order, and the
	 * Harness relies on it.
	 */
	// 从会话全局数字 ID 空间分配新 ID：必须大于本 Storage 打开以来分配过的所有 ID，也大于已存储的所有 ID（跨重开）。
	// 扫描按 ID 视为创建顺序，Harness 依赖这一性质；实现通常持久化高水位。返回类型由调用方指定品牌（Id 子类型），
	// 运行时只是一个数字。
	mintId<I extends Id<string>>(): Promise<I>;

	/** Look up one conversation by exact ID. */
	// 按精确 ID 读会话记录；不存在为 undefined。
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;

	/** Scan conversations in `query.order` (default ascending) by ID. */
	// 按 ID 顺序分页扫描会话；默认升序。
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>>;

	/** Look up one global entry and the sequence of the commit that persisted it. */
	// 按全局 ID 读条目及其写入提交序号；不检查可见性（祖先关系）。
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	/** Look up one entry only when it is visible through the requested conversation's ancestry. */
	// 仅在请求会话的祖先链中可见时返回条目；commitSeq 可用于历史读取定位。
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;

	/**
	 * Return the newest visible entry with a `head` at or below the optional inclusive cutoff.
	 * The returned entry is the marker; its `head` value is the range's actual lower bound.
	 */
	// 找到不晚于 atOrBeforeEntryId（含）的最新 head 标记条目；返回的是“标记条目”，
	// 真正的上下文下界是它的 head 字段。
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;

	/** Scan the inclusive visible range in `query.order` (default descending), returning at most `limit` entries. */
	// 扫描会话可见范围内的条目（min/max 闭区间）；默认降序，limit 为上限。
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;

	/** Look up the latest complete record for one task. */
	// 读任务的最新完整记录（整条替换模型）；不存在为 undefined。
	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;

	/** Scan task records matching every supplied filter in `query.order` (default ascending) by ID. */
	// 按所有给定过滤条件（AND）扫描任务，默认升序。
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

	/** Look up the latest complete record for one admitted submission. */
	// 读已准入提交的最新完整记录。
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;

	/** Scan submissions matching every supplied filter in `query.order` (default ascending) by ID. */
	// 按过滤条件扫描提交，默认升序。
	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>>;

	/** Find a submission by its conversation-scoped host deduplication key. */
	// 按会话内 requestId 查提交（去重键）；没有为 undefined。
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined>;

	/** Resolve the incarnation occupying one exact logical address at the selected point. */
	// 在指定时间点（current 或某 seq）解析某个精确逻辑地址上“当时存活”的化身；不跟随之后的替换。
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;

	/** Materialize one specific incarnation by ID at the selected point without following a replacement at its address. */
	// 按化身 ID（而非地址）物化指定时间点的值：从最近 base 重放 delta，返回 record/version/value/deltasSinceBase。
	// 不会因为该地址后来重建而改读新化身；不存在或该点未创建/已退役则为 undefined。
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;

	/** Scan incarnations alive in one exact scope at the selected point. */
	// 扫描某精确作用域在指定时间点存活的化身；可按 kind 过滤。
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>>;

	/** Release backend resources; all later operations must reject. */
	// 释放后端资源；此后所有操作必须 reject。close 的错误同样会使 Session 失败。
	close(context: Context): Promise<void>;
}
