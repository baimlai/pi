// 所属：packages/durable/src/harness，Durable Harness 的任务调度器（scheduler 层）。
// 解决的问题：把持久化的任务记录变成实际执行——决定谁现在能跑、谁在等待/睡眠/被阻塞，串行地在
// Session 线上决定每次状态转换并写入，恢复崩溃后的任务，处理取消/所有权级联，并维护内存中的任务索引。
// 职责边界：本文件不实现具体任务逻辑（generation/tool/compaction 各有任务定义），不直接写 Storage，
// 不负责输入队列和任务图视图；它通过 Session 提交、通过 Storage 读取，并在关闭时与 Harness 协作。
// 上游：Harness 构造函数创建 TaskScheduler 并注入依赖（harness.ts）；Harness.open 调 open()，
// resume()/wake()/abortTask()/abortConversation()/waitForTask()/waitForIdle()/inspect() 转发到这里。
// 下游：SessionImpl（commitWith/commitInternal/readOnLine/touch/followCommits/subscribeClose）、
// Storage（scan/task/conversation 读取）、RegistryReader（任务定义快照）、任务运行时（任务代码）、
// pi-telemetry（指标/span）与 Harness 的 report/settleOutcome/withdrawInputs 回调。
// 结果与错误：任务失败通常写入 faulted 记录并报告；调度器自己的提交失败会让 Session 失败（#failSession），
// 因为其中没有扩展代码，重跑无法修复存储/宿主回调错误。关闭后等待者以 closedError 拒绝。
// 能力清单：
// - BlockedSubject / blockedSubject()：任务图中判断“能否运行”所需的记录子集。
// - BlockedReason：missing_task、task_too_old、migration_failed 三种阻塞原因。
// - SchedulerOutcome：调度器自己写入的终端结果（faulted/orphaned）。
// - InvocationBinding：会话句柄绑定的 signal 与“调用是否已结束”的检查。
// - TaskSchedulerOptions：构造调度器的依赖注入列表。
// - TaskScheduler：调度核心；公开 open/resume/blockedReason/subscribeBlocked/wake/join/abort/waitForTask/
//   waitForIdle/abortConversation/membershipKeys/inspect/indexSizes/idleState，其余为内部决策/索引方法。
// - endedByCrashes()：给内置任务返回的终端状态打“因崩溃结束”的标记，供 task_interrupted 报告使用。
// 组合与顺序（典型生命周期）：Harness 构造 TaskScheduler → open() 扫描存活任务并把 running 回退为 pending →
// resume() 启用调度 → #kick/#drain/#reserve 选中可运行任务 → #start 执行 run/abort 调用 →
// 每个 phase 前 #step 在 Session 线上做决定 → 任务提交状态 → 终态经 #finalize 落盘 →
// 关闭时 #seal + join() 把仍在 running 的任务写回 pending。
// 示例（依赖由 Harness 注入，这里只展示真实调用顺序）：
//   const scheduler = new TaskScheduler({ session, storage, registry, models, agent, settings, env, now,
//     onWake, timers, writeAtClose, report, limitsRestarts, settleOutcome, withdrawInputs, conversation, context });
//   await scheduler.open(context);   // 恢复/回退中断的任务
//   scheduler.resume();              // 启用后才会开始 drain
//   const wake = scheduler.wake();   // { active: true } 或 { active, at: 最早睡眠到期时间 }
// 建议阅读顺序：先读 TaskSchedulerOptions 与类的字段注释了解索引含义，再读 open/resume/wake 的对外行为，
// 然后读 #observe → #track 的提交观察、#reserve → #start → #run → #step 的执行链，
// 最后读 #finalize/#reconcile 的清理与恢复，以及文件底部的纯函数助手。
// 测试：test/harness-scheduler-indexes.test.ts（索引规模）、harness-scheduler-retention.test.ts（上下文保留）、
// harness-tasks*.test.ts、harness-cancellation-barrier.test.ts、harness-ownership.test.ts 等。
// 复用的 Chord 上下文工具：awaitWithContext 让 await 可被取消，withAbortSignal 附加取消信号，
// withoutAbortSignal 去掉调用方信号（调度器提交不应被调用方取消），withTelemetry 附加 telemetry span。
import {
	awaitWithContext,
	type Context,
	withAbortSignal,
	withoutAbortSignal,
	withTelemetry,
} from "@earendil-works/chord/context";
// ownedSlice 用于截断过长的错误消息；copyJson 深复制 JSON，保证交付给任务的记录不与调度器内存共享。
import { ownedSlice } from "@earendil-works/chord/delta";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
// Models 是模型目录/凭证/请求转换的入口，任务运行时按需读取。
import type { Models } from "@earendil-works/pi-ai";
// 任务 span 与指标：createTypedMetrics/createTypedSpanStarter 校验 schema，NOOP 版本用于未配置 telemetry 的宿主。
import {
	createTypedMetrics,
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type TelemetryCarrier,
} from "@earendil-works/pi-telemetry";
// ExecutionEnv 是任务可用的执行环境（文件系统/命令），由 HarnessOptions.env 构建。
import type { ExecutionEnv } from "../env/index.ts";
// errorMessage 把 unknown 错误转成消息；ReadOnlySession 是只读会话上的操作拒绝类型。
import { errorMessage, ReadOnlySession } from "../errors.ts";
// Session 线的键：读这些键会等待对应未发布提交。INTENT_KEY 表示取消意图集合，ROOTS_KEY 表示无主会话根集合。
import { ALL_KEYS, conversationKey, INTENT_KEY, ownedKey, ROOTS_KEY, taskKey } from "../session/keys.ts";
// ObservedCommit 是提交发布事件；SessionImpl 是调度器使用的会话内核类型。
import type { ObservedCommit, SessionImpl } from "../session/session.ts";
// Transaction 是提交回调里的事务草稿接口。
import type { Transaction } from "../session/transaction.ts";
// Timers 是前台/后台定时器服务，分别决定是否保持进程存活。
import type { Timers } from "../timers.ts";
// 会话/任务/存储/报告的公共类型；TaskRecord 的泛型在调度器内部常被擦除为 JsonValue。
import type {
	CommitOptions,
	ConversationId,
	ConversationRecord,
	DocumentWatch,
	EntryId,
	EntryRecord,
	HookRunner,
	JsonObject,
	NextTaskState,
	ReportInfo,
	ReportTask,
	RunningTask,
	Storage,
	StorageWrite,
	TaskDefinition,
	TaskId,
	TaskOutcome,
	TaskOutcomeError,
	TaskRecord,
	TaskRuntime,
	TaskState,
} from "../types.ts";
// agentHooks 返回任务名对应扩展钩子；DEFAULT_RESTART_LIMIT 是宿主未给设置时的重启上限默认值。
import { agentHooks, DEFAULT_RESTART_LIMIT } from "./agent.ts";
// 上下文范围缓存：advanceRange 追加新条目，rangeEntry 在已缓存范围内取条目，readContextFrom 从存储读取。
import { advanceRange, type ContextRange, rangeEntry, readContextFrom } from "./context.ts";
// DURABLE_TELEMETRY_SCHEMA 约束调度器写入的 span/指标属性名。
import { DURABLE_TELEMETRY_SCHEMA } from "./telemetry.ts";
// Harness 侧类型：Agent 是会话解析结果，Wake 是宿主唤醒需求，TaskInspection 是 inspect() 的项。
import type {
	Agent,
	AnyTask,
	ConversationHandle,
	HarnessInspection,
	HarnessOptions,
	RegistryReader,
	RegistrySnapshot,
	Settings,
	SettledTask,
	TaskInspection,
	Wake,
} from "./types.ts";
// closedError 构造关闭错误；conversationEntries 拼条目查询；optionalExtension 省略空扩展字段；
// scanAll 拉平分页扫描；Waiters 是按任务/会话登记等待者的内存表。
import { closedError, conversationEntries, optionalExtension, scanAll, Waiters } from "./util.ts";

// 调度器内部不关心任务的具体参数/检查点类型：统一擦除成 JsonValue，运行时行为由任务定义自己解释。
type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
/** A record that can still run code: pending, running, waiting, or sleeping. */
// 从任务记录联合中取出四种“还能执行代码”的状态；completing 不在其中（它只等待子任务收尾）。
// Extract 在编译期按 state.status 的字面量筛选，不产生运行时检查。
type RunnableTaskRecord = Extract<
	AnyTaskRecord,
	{ readonly state: { readonly status: "pending" | "running" | "waiting" | "sleeping" } }
>;
// 跨任务统一使用的检查点形状：phase 是阶段名，attempt 是同一阶段的重试计数（可选）。
type Checkpoint = { readonly phase: string; readonly attempt?: number };
// 擦除具体任务泛型后的定义/运行时/运行记录，供调度器按名称装载任意任务。
type ErasedDefinition = TaskDefinition<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRuntime = TaskRuntime<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRunningTask = RunningTask<JsonValue, Checkpoint, JsonValue>;

// 初始扫描每页条目数；scanAll 会继续翻页，直到存储返回空页。
const SCAN_PAGE_SIZE = 256;
// 复用空键数组，避免没有观察键的提交区域每次分配新数组。
const NO_KEYS: readonly string[] = [];
// 调度器认为是“存活”的全部状态（含 completing）；据此过滤存储扫描与维护索引。
const LIVE_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const;

/** What `blockedReason()` reads of a task: the task graph keeps only this of each record. */
export type BlockedSubject = Pick<AnyTaskRecord, "id" | "kind" | "version" | "abortRequested" | "abortReason"> & {
	readonly status: TaskState<JsonValue, JsonValue>["status"];
};

/** The part of a record `blockedReason()` reads. */
// 输入一条完整任务记录，输出只含“能否运行”所需字段的浅对象；无副作用。
// 任务图（task-graph）用它展示阻塞原因，避免把整个记录复制进图。
// 例：pending 记录会得到 { id, kind, version, abortRequested, status: "pending" }。
export function blockedSubject(record: AnyTaskRecord): BlockedSubject {
	return {
		// 身份与版本决定注册表里是否有可接管它的定义。
		id: record.id,
		kind: record.kind,
		version: record.version,
		abortRequested: record.abortRequested,
		// abortReason 可选：值为 undefined 时条件展开省略该键，保持输出形状稳定。
		...(record.abortReason === undefined ? {} : { abortReason: record.abortReason }),
		// 只取 state.status，而不是整个 state（避免暴露任务参数/检查点）。
		status: record.state.status,
	};
}

/** Why a task cannot be reserved: no registered definition can take it. Derived from the registry. */
// 三种阻塞原因都由注册表推导：没有该任务、任务版本过旧、迁移钩子失败。
export type BlockedReason = "missing_task" | "task_too_old" | "migration_failed";

// #resolve 的结果：要么找到可运行的任务定义与记录，要么给出阻塞原因。
// 判别字段 kind 让调用方在编译期区分两个分支。
type Resolution =
	| { readonly kind: "ready"; readonly task: AnyTask; readonly record: RunnableTaskRecord }
	| { readonly kind: "blocked"; readonly reason: BlockedReason };

/** A definition that can take a record, or why none can; deciding it runs no task code. */
// 判断一个定义能否接管记录的内部结果：能则任务定义 + 是否需要迁移；不能则给原因与可选错误。
// 这里只做声明/版本检查，不运行任务代码。
type Fit =
	| { readonly task: AnyTask; readonly migrates: boolean }
	| { readonly reason: BlockedReason; readonly error?: unknown };

/** One in-memory execution of a task in run or abort mode. */
// 一次任务执行的内存状态；同一任务同时最多一个 invocation（#invocations 以 taskId 为键）。
// mode 为 abort 时运行的是取消钩子而不是正常阶段；controller 取消时，其下所有等待/定时器都应结束。
type Invocation = {
	// 目标任务；invocation 结束后从 #invocations 删除。
	readonly taskId: TaskId;
	// 任务种类（generation/tool/...），用于重启上限与遥测属性。
	readonly kind: string;
	/** The extension that installed the definition this invocation runs, as of its reservation; none for a built-in. */
	// 预留时安装该定义的扩展名；内置任务为 undefined。之后注册表变化不会改写它。
	readonly extension: string | undefined;
	// 所属会话；运行时的工具/输入都限定在这个会话。
	readonly conversationId: ConversationId;
	// run 执行正常阶段；abort 执行取消钩子（任务被取消且已注册 abort 阶段时）。
	readonly mode: "run" | "abort";
	// 取消传播到 invocation 内所有 await/信号；#runAbort 在取消意图到达时调用。
	readonly controller: AbortController;
	// telemetry 传播载体，供任务运行时把 span 串到调度器的任务 span 下。
	links?: readonly TelemetryCarrier[];
	/** Context passed to handlers; cancelled by `controller`. */
	// 交给任务阶段处理器的 Context；controller.abort 会级联取消它。
	context: Context;
	/** Keeps the terminal state available after it leaves the live index. Released when the invocation finishes. */
	// 终态记录缓存：任务离开 #live 后，#finalize 仍可从 invocation 读到它；invocation 结束时释放。
	record?: TaskRecord<JsonValue, Checkpoint, JsonValue>;
	// 已在决定区域判定为 faulted 的终态；结束 invocation 时用于写盘/报告，避免再读记录。
	fault?: Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" }>;
	/** Watches acquired through the runtime; stopped at invocation end. */
	// 运行期间通过 runtime.watch 建立的文档观察；invocation 结束时统一解除。
	readonly watches: Set<DocumentWatch<JsonObject>>;
	/** Timers armed through the runtime; disarmed at invocation end. */
	// 运行期间通过 runtime.setTimer 建立的定时器；invocation 结束时统一清除。
	readonly timers: Set<() => void>;
	// 结束标志：防止重复 finish/重复写终态。
	ended: boolean;
	// 外部（waitForTask/join）可等待的完成 Promise；finish() 使其 resolve。
	readonly done: Promise<void>;
	// 解析 done 的闭包；创建时配合 Promise.withResolvers 生成。
	readonly finish: () => void;
};

/** What a runtime reads for the phase handler it serves: the phase's snapshot and task, and its lazily resolved agent. */
// 运行时在每个阶段读取的上下文：快照/任务按需取当前值，agent 解析一次并缓存。
// snapshot/task 是闭包而非值：阶段执行期间注册表可能被重装，运行时需要看到更新后的定义。
type Phase = {
	readonly snapshot: () => RegistrySnapshot;
	readonly task: () => AnyTask;
	// 延迟解析：只有阶段真正需要 agent 时才调用注入的 #agent；同一 invocation 内复用。
	agent: Promise<Agent> | undefined;
};

// 预留成功后的三元组：invocation、接管它的任务定义、预留时的注册表快照。
// 快照固定后，阶段运行期间即使注册表变化也不会换定义，保证一次执行的一致性。
type Reservation = {
	readonly invocation: Invocation;
	readonly task: AnyTask;
	readonly snapshot: RegistrySnapshot;
};

/** Replacement definition already reported as unable to take over, per invocation. */
// 记录“已经报告过替换定义无法接管”的状态，避免每个阶段重复报告同一错误；undefined 表示尚未报告。
type ReportedTask = { readonly task: AnyTask | undefined } | undefined;

/** Outcome of the phase that just returned, judged by the next step. */
// 刚返回的阶段结果：checkpoint 是任务报告的下一阶段；failure 存在表示阶段以错误结束。
// #step 在决定区域里根据它和当前记录决定继续、结束或 fault。
type PhaseResult = { readonly checkpoint: Checkpoint; readonly failure?: { readonly error: unknown } };

/**
 * Step decision, made in a decision region: continue with the next phase, end the invocation, or end it by writing
 * `faulted`.
 */
// #step 的决定结果；fault 携带导致故障的错误，其余分支不带数据。
// continue/progress/end/cascade 都是“如何结束或继续”，由调用方按语义处理。
type StepPlan =
	| { readonly kind: "continue" | "progress" | "end" | "cascade" }
	| { readonly kind: "fault"; readonly error: unknown };

/** Continue with the next phase, the first one. */
// 常量对象在多个决定之间复用；它们只读，不随调用变化。
// CONTINUE 表示按 checkpoint 继续下一阶段（无检查点时执行第一阶段）。
const CONTINUE: StepPlan = { kind: "continue" };
/** Rule 5: the phase made durable progress; `#progress()` decides once the decision stands. */
// 阶段取得了持久进展；#step 在决定成立后调用 #progress() 记录/报告。
const PROGRESS: StepPlan = { kind: "progress" };
/** End the invocation without a write. */
// 结束 invocation，不再写任何记录（通常因为任务已被取消/接管）。
const END: StepPlan = { kind: "end" };
/** End it: an owner's cancellation intent reaches it before its cascade did; schedule the cascade. */
// 所有者的取消意图先于级联到达；结束当前 invocation，并安排一次级联处理。
const CASCADE: StepPlan = { kind: "cascade" };

/** Terminal outcomes the scheduler writes without running task code. */
// 调度器自己写入的终态：faulted（运行器故障）与 orphaned（失去所有者）。任务代码不会产生这两个分支，
// 因此 settleOutcome 回调可用它们做宿主清理。
export type SchedulerOutcome = Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" | "orphaned" }>;

/** An invocation a conversation handle is bound to: its signal, and a check that throws once it ended. */
// 交给会话句柄的绑定：signal 让把信号传给工具调用；check() 在 invocation 已结束（或取消）时抛错。
export type InvocationBinding = { readonly signal: AbortSignal; check(): void };

/** The immutable ownership fields of a task. */
// 任务不可变的所有权字段：所属会话、所有者任务（可选）、是否后台任务。用于构建/遍历所有权树。
type TaskNode = Pick<AnyTaskRecord, "conversationId" | "owner" | "background">;

/** Where a walk up the ownership tree continues: an owner task, or a conversation. */
// 向上遍历的下一个位置：所有者任务，或会话（到达会话表示链的顶端）。
type Up = { readonly task: TaskId } | { readonly conversation: ConversationId };

/** One step of a walk up: an owner task with its node, a conversation, or an owner edge that is not loaded yet. */
// 向上遍历的一步：已加载的 owner（附节点）、到达会话、或 owner 边尚未加载（unknown）。
// unknown 让调用方先去存储加载链，而不是把“未加载”误判为“无所有者”。
type Step =
	| { readonly task: TaskId; readonly node: TaskNode }
	| { readonly conversation: ConversationId }
	| { readonly unknown: true };

/** Candidate records a commit staged; they override committed records in ownership walks. */
// 提交暂存阶段的覆盖层：本次提交将要写入的任务记录与会话 owner 边。
// 遍历在读到未发布提交时需要把暂存值视为已生效，否则会把“即将变成子任务”的记录算错。
type Overlay = {
	readonly tasks: ReadonlyMap<TaskId, AnyTaskRecord>;
	readonly edges: ReadonlyMap<ConversationId, TaskId | null>;
	/** Links to the staged tasks `#below` does not list, by parent node, for walks down; built at first use. */
	// 反向链缓存：暂存任务尚未进入 #below 时，用父节点 -> 子节点集合补齐向下遍历；首次使用时构建。
	links?: ReadonlyMap<Node, ReadonlySet<Node>>;
};

/** Tasks a finalize pass has made terminal in its commit so far. */
// 当前 finalize 提交里已改为终态的任务集合；避免同一次清理重复处理同一 id。
type Finalized = { has(id: TaskId): boolean };

/** A node of the downward index: a task, or a conversation as `c<id>`. */
// 向下索引的节点：任务 id 直接使用，会话加 "c" 前缀，避免两种 id 空间冲突。
type Node = TaskId | `c${number}`;

// 会话 id -> 节点字符串；例如 conversationId 7 变成 "c7"。纯函数。
function conversationNode(id: ConversationId): Node {
	return `c${id}`;
}

// 节点字符串 -> 会话 id；调用方保证节点以 "c" 开头（类型已限定），运行时仅做 slice/Number。
function conversationOf(node: `c${number}`): ConversationId {
	return Number(node.slice(1)) as ConversationId;
}

/** The node a task hangs from: its owner task, or its conversation. */
// 任务挂载的父节点：有 owner 就是 owner 任务，否则挂在所属会话节点下。?? 只在 owner 为空时生效。
function parentNode(node: TaskNode): Node {
	return node.owner ?? conversationNode(node.conversationId);
}

/** Where ordinary ownership traversal starts: one conversation, or every ownerless conversation. */
// 普通所有权遍历的起点：指定会话，或所有无主会话（roots）。取消整棵会话树时用后者。
type Scope = { readonly conversation: ConversationId } | { readonly roots: true };

// 构造 TaskScheduler 的全部依赖；Harness 在 harness.ts 中逐项注入，测试可单独构造。
// 这些大多是回调而不是值：宿主运行期间可能替换模型访问、设置、唤醒实现，调度器每次使用时重新读取。
export type TaskSchedulerOptions = {
	// 宿主遥测配置；缺省时使用 NOOP span/metrics。
	readonly telemetry?: HarnessOptions["telemetry"];
	// 会话内核：所有状态转换经它的单线提交与读取。
	readonly session: SessionImpl;
	// 持久化存储：任务/会话记录、分组提交、初始扫描。
	readonly storage: Storage;
	// 当前注册表快照与变化通知；任务定义从这里解析。
	readonly registry: RegistryReader;
	/** The host's current model access (`HarnessOptions.models`); read at each access. */
	// 返回宿主当前模型访问；不缓存结果，因为凭证/目录可能在运行中更新。
	readonly models: () => Models;
	/** Resolve a conversation's agent against a snapshot; the runtime calls it at most once per phase. */
	// 用固定快照解析会话 agent（扩展/工具/段）；每个阶段最多调用一次，结果缓存在 Phase.agent。
	readonly agent: (conversationId: ConversationId, snapshot: RegistrySnapshot, context: Context) => Promise<Agent>;
	/** Resolve the settings; read at each access. */
	// 每次需要时读取设置（重启上限、上下文保留时长、节流间隔等），不缓存。
	readonly settings: () => Settings;
	/** Build a conversation's environment with `HarnessOptions.env`. */
	// 为该会话构建执行环境；undefined 表示宿主没有提供环境（任务运行时需自行处理）。
	readonly env: (conversationId: ConversationId, context: Context) => Promise<ExecutionEnv | undefined>;
	// 调度器的时间源；测试可注入假时钟，睡眠判断统一用它。
	readonly now: () => number;
	/** `HarnessOptions.onWake`: replaces the timer for sleeping tasks. */
	// 宿主自定义唤醒：不为睡眠任务设真实定时器，而把唤醒需求交给宿主；undefined 时用 #timers。
	readonly onWake: ((wake: Wake) => void) | undefined;
	/** The host's timers (`HarnessOptions.setTimer`). */
	// 宿主定时器服务；前台定时器保持进程存活，后台定时器不保持。
	readonly timers: Timers;
	/** While closing, on the line after admitted commits settle, write what the callback returns straight to Storage. */
	// 关闭期间在已准入提交落定后、仍处于会话线上时调用；返回的 writes 直接写存储（不经 Session 提交）。
	readonly writeAtClose: (writes: () => readonly StorageWrite[]) => Promise<void>;
	// 报告宿主可见错误（阶段失败、替换定义无法接管等）；context 可选，用于区分取消来源。
	readonly report: (error: unknown, info: ReportInfo, context?: Context) => void;
	/**
	 * Task kinds whose run phases end the task themselves once it was cut off `settings.restartLimit` times (the
	 * built-in tasks, from `TaskRecord.restarts`); the scheduler ends a task of any other kind `faulted` instead.
	 */
	// 判断某类任务是否自己处理重启上限：有限制类任务由运行阶段读 restarts 后结束，其他类型由调度器直接 fault。
	readonly limitsRestarts: (kind: string) => boolean;
	/** Harness cleanup staged in the commit that makes an outcome the scheduler wrote itself terminal. */
	// 调度器写 faulted/orphaned 终态时，在同一事务里安排 Harness 清理（撤销输入、通知等待者等）。
	readonly settleOutcome: (tx: Transaction, record: AnyTaskRecord, outcome: SchedulerOutcome) => Promise<void>;
	/** Withdraw a conversation's queued inputs, for conversation abort and abort cascades. */
	// 会话取消或级联到达时，在同一事务里撤回排队的输入。
	readonly withdrawInputs: (tx: Transaction, conversationId: ConversationId) => Promise<void>;
	/** Invocation-bound handle of an existing conversation, for task runtimes and tools. */
	// 为任务运行时/工具提供绑定到本次 invocation 的会话句柄；句柄的 signal/check 与 invocation 同生命周期。
	readonly conversation: (
		id: ConversationId,
		binding: InvocationBinding,
		context: Context,
	) => Promise<ConversationHandle | undefined>;
	/** Context for scheduler commits and invocations; carries no caller cancellation. */
	// 调度器提交与 invocation 的根 Context；不携带调用方取消，避免某次调用取消拖垮整个调度器。
	readonly context: Context;
	/**
	 * `HarnessOptions.readOnly`: open loads live tasks as committed, `running` ones included, and the scheduler never
	 * commits, runs anything, or asks for a wakeup.
	 */
	// 只读模式：open 把 running 也当作已提交的存活任务显示，但绝不提交、不运行、不请求唤醒。
	readonly readOnly?: boolean;
};

/**
 * Durable task scheduler of one Harness.
 *
 * `#live` mirrors every committed non-terminal task record: pending, running, waiting, sleeping, and completing. The
 * synchronous commit listener updates it on the Session line, so code running on the line reads exactly the committed
 * state from it.
 *
 * Tasks and conversations form one ownership tree (spec §5.5): a task's parent is its owner task, or its conversation;
 * a conversation's parent is its owner task, if any. Walks up that tree decide what reaches one task: a cancelling
 * owner, a scope. `#below` lists the tree downward around live work, so what lies below one node is a walk down from
 * it: a task's live ordinary owned work, which holds its outcome as `completing` and delays its abort handler, a
 * scope's tasks, a cascade's reach. No pass visits every live task; the sets below hold each pass's candidates.
 *
 * The ownership indexes are bounded by live work: an owner edge and an ended task's ownership fields are kept only while
 * something is listed below them in `#below`, so only the chains above live tasks are known, whole. Work that appears
 * later below a dropped node finds it unknown and loads its chain from storage again.
 *
 * Invariant: every task transition is decided and written by one callback serialized on the Session line. That covers
 * reservation, marks, runtime commits, finalization, and the step before each phase, which applies the precedence rules
 * and writes a fault or handover. Handlers and joins run off the line. An invocation ends inside the step that decides
 * its end, so a runtime commit it queued either lands before that decision or is rejected.
 *
 * Decisions stay serialized; their storage overlaps (group commit). The Session stores the commits of several jobs in
 * one call while the line runs on, and this memory changes only as each commit is published. So every decision reads
 * it in a decision region (`#region()`): synchronous, recording the keys it reads (a task's record, the live work below
 * a node, the cancellation intent set), staging nothing; when one of them has an unpublished writer, the region waits
 * for its publication and runs again, and only a region that read nothing unpublished is applied. Every commit writes
 * the memberships its task changes alter (`membershipKeys()`), so a walk that a pending commit would change waits.
 */
// 一个 Harness 对应一个 TaskScheduler；这里是调度器本身的实现。
// 核心状态：#live 是已提交未终态任务的镜像；#invocations 是正在执行的内存状态；
// #below/#parents/#roots/#unloaded/#settled 构成所有权索引；#taskWaiters/#settledWaiters/#taskReservations
// 等维护等待者与提交串行化；#pending 是已观察到但尚未应用的提交队列。
// 设计约束（对应类上方英文文档）：
// - 所有任务状态转换都在 Session 单线上由一个回调决定并写出，读内存即可得到已提交状态；
// - 决定在 decision region 中完成，若读到未发布提交则等待并重放，避免读到旧值；
// - 所有权索引只保留存活工作附近的节点，超出范围后可从存储重新加载链。
export class TaskScheduler {
	// 规范化后的遥测配置（至少是空对象）；span/metrics 由它创建。
	readonly #telemetry: NonNullable<HarnessOptions["telemetry"]>;
	// 活跃任务数指标（gauge），随 #live 变化更新。
	readonly #activeMetric;
	// 任务执行时长指标（histogram），在 invocation 结束时记录。
	readonly #durationMetric;
	// 已执行过 resume 的任务 id：恢复时对每个任务只做一次“把 running 改回 pending”的转换。
	readonly #resumed = new Set<TaskId>();
	// 会话内核；所有提交、单线读取、关闭通知都经过它。
	readonly #session: SessionImpl;
	// 持久化存储；open 时扫描，加载未缓存所有权链时按 id 读取。
	readonly #storage: Storage;
	// 注册表读取器；#resolve 用它找任务定义，并订阅变化以重新调度。
	readonly #registry: RegistryReader;
	// 模型访问提供者；每次运行时读取，不在这里缓存。
	readonly #models: () => Models;
	// agent 解析器；由 Harness 注入，按会话 + 快照解析扩展。
	readonly #agent: TaskSchedulerOptions["agent"];
	// 设置读取器；重启上限/上下文保留/节流间隔都从这里取。
	readonly #settings: TaskSchedulerOptions["settings"];
	// 执行环境构建器，供任务运行时使用。
	readonly #env: TaskSchedulerOptions["env"];
	// 调度时钟；睡眠到期与遥测时间都使用它。
	readonly #now: () => number;
	// 宿主唤醒回调；提供时睡眠任务不占真实定时器。
	readonly #onWake: ((wake: Wake) => void) | undefined;
	// 定时器服务；#expiry 与睡眠任务使用。
	readonly #timers: Timers;
	// 关闭时直接写存储的回调（在会话线上、已准入提交之后）。
	readonly #writeAtClose: (writes: () => readonly StorageWrite[]) => Promise<void>;
	// 宿主错误报告回调。
	readonly #report: (error: unknown, info: ReportInfo, context?: Context) => void;
	// 调度器自己写终态时的 Harness 清理回调。
	readonly #settleOutcome: TaskSchedulerOptions["settleOutcome"];
	// 判断任务种类是否自行处理重启上限。
	readonly #limitsRestarts: TaskSchedulerOptions["limitsRestarts"];
	// 撤回会话排队输入的回调。
	readonly #withdrawInputs: TaskSchedulerOptions["withdrawInputs"];
	// 创建 invocation 绑定会话句柄的回调。
	readonly #conversation: TaskSchedulerOptions["conversation"];
	// 调度器根 Context；不随调用方取消。
	readonly #context: Context;
	// 已提交、未终态任务的镜像（pending/running/waiting/sleeping/completing）。
	// 只由 Session 提交监听器在会话线上更新；在线上读取即得到精确的已提交状态。
	readonly #live = new Map<TaskId, AnyTaskRecord>();
	/**
	 * Context range last read through a task runtime, per conversation: a later read, by any of its tasks, scans only
	 * newer entries. `idleSince` is the Harness time it was first seen idle. Derived and never persisted; dropped at the
	 * first idle check after `settings.contextRetentionMs` of idleness, and at close.
	 */
	// 每个会话上次读到的上下文范围缓存；任务运行时后续读取只需扫更新的条目。
	// idleSince 是首次观察到空闲的 Harness 时间；expiresAt 是算出/排定过期时间后的缓存。
	// 纯派生，不持久化；空闲超过 contextRetentionMs 后在下一次空闲检查中删除，关闭时也清空。
	readonly #contexts = new Map<
		ConversationId,
		{ range: ContextRange; idleSince: number | undefined; expiresAt?: number }
	>();
	/**
	 * The idle kept contexts by `idleSince`, oldest first: the expiry order, so neither an expiry nor finding the next one
	 * scans `#contexts`. Kept sorted also when the Harness clock goes back (see `#markIdle`).
	 */
	// 空闲上下文按 idleSince 排序的索引（最旧在前），让过期检查与寻找下一个过期项都不必扫描 #contexts。
	// 时钟回拨时也维持有序，见 #markIdle。
	readonly #idleOrder = new Map<ConversationId, number>();
	/** At least the newest `idleSince` in `#idleOrder` (drops do not lower it): an older one added means the clock went back. */
	// #idleOrder 中出现过的最新 idleSince 下界；删除不降低它，因此新增更旧值时说明时钟回拨。
	#idleNewest = Number.NEGATIVE_INFINITY;
	/**
	 * A chain load resolved what `#idle()` treats as unknown for a live task whose chain is not loaded, which can make a
	 * scope idle without a task change below it; the next idle check then covers every scope.
	 */
	// 链加载把“未知所有权”变成已知，可能让某个作用域在没有任何任务变更时变为空闲；
	// 置位后下一次空闲检查会覆盖全部作用域，而不是只检查候选集。
	#unknownsChanged = false;
	/** Idle checks that covered every scope (`idleState`, a test diagnostic). */
	// 覆盖全部作用域的空闲检查次数；只供测试诊断（idleState）使用，不参与业务判断。
	#fullIdleChecks = 0;
	/** Background timer for the earliest expiry of an idle context, unless the host declined it (see `#scheduleExpiry`). */
	// 最早空闲上下文过期时间的后台定时器；宿主拒绝后台定时器时为 undefined。
	#expiry: { readonly at: number; readonly disarm: () => void } | undefined;
	// 正在执行的任务：taskId -> Invocation。任务结束前一直存在。
	readonly #invocations = new Map<TaskId, Invocation>();
	// waitForTask 的等待者表；键为任务 id，值为终态 SettledTask。
	readonly #taskWaiters = new Waiters<TaskId, SettledTask<JsonValue>>();
	/** Idle waiters by conversation; `undefined` waits for the whole Harness. */
	// waitForIdle 的等待者表；键为会话 id，undefined 表示等待整个 Harness 空闲。
	readonly #idleWaiters = new Waiters<ConversationId | undefined, void>();
	/** Definition whose migration failed per task; retried only once the registry resolves another definition. */
	// 迁移失败缓存：同一任务在注册表仍解析出同一份定义时不重复尝试迁移，直到定义变化。
	readonly #failedMigrations = new Map<TaskId, { readonly task: AnyTask; readonly error: unknown }>();
	/** Owner task of each known conversation, `null` when ownerless. */
	// 已知会话的所有者任务；null 表示无主会话。这是所有权树的上行边缓存。
	readonly #edges = new Map<ConversationId, TaskId | null>();
	/** Ownership fields of the known terminal tasks, which walks pass through. */
	// 已知终态任务的所有权字段；向上遍历经过终态任务时仍需知道它挂在哪。
	readonly #settled = new Map<TaskId, TaskNode>();
	/**
	 * Ended tasks and conversations found unneeded, dropped by `#sweep()` at the end of the commit's publication unless
	 * needed again by then: a chain load installs nodes before the work below them is listed.
	 */
	// 提交发布末尾由 #sweep() 清理的候选节点；若在发布前又被需要则移除。
	// 链加载会先安装上层节点、再列出下层工作，因此不能立即删除安装过的节点。
	readonly #dropQueue = new Set<Node>();
	/**
	 * The tree downward around live work: each node's child nodes that are live tasks or have nodes listed below them.
	 * A conversation's parent is its owner task; ownerless ones with work are in `#roots`.
	 */
	// 存活工作附近的所有权树向下索引：父节点 -> 子节点集合。只有存活任务或仍有下层节点的节点会保留。
	// 有工作的无主会话放在 #roots，从中开始遍历。
	readonly #below = new Map<Node, Set<Node>>();
	// 无主但有存活工作的会话集合；根遍历的起点。
	readonly #roots = new Set<ConversationId>();
	/** Known tasks whose chain may not be loaded; every other known task's chain is, and stays, loaded. */
	// 所有权链尚未加载的已知任务；不在集合中的已知任务，其链已加载且会保持加载。
	readonly #unloaded = new Set<TaskId>();
	/** Live tasks with cancellation intent, the sources of abort cascades (spec §5.4). */
	// 带取消意图的存活任务；它们是取消级联的源头（设计 §5.4）。
	readonly #intent = new Set<TaskId>();
	/** Live tasks that are not `completing`, the candidates of a reservation pass; ones found waiting leave it. */
	// 非 completing 的存活任务，是预留扫描的候选；一旦确认在等待就从集合移除，避免每轮重复检查。
	readonly #runnable = new Set<TaskId>();
	/** `completing` tasks the next finalize pass checks: those that started holding, and holders of ended work. */
	// 下一次 finalize 需要检查的 completing 任务：刚开始持有的，以及有子任务结束的持有者。
	readonly #finalizeChecks = new Set<TaskId>();
	/** Live waiting tasks by each task in their `on`. */
	// 反向等待索引：被等待任务 id -> 等待它的存活任务集合。任务失败时据此找 failFast 等待者。
	readonly #waiters = new Map<TaskId, Set<TaskId>>();
	/**
	 * `failFast` waiters the next reconcile checks for a failed task in `on`: at open, when they start waiting, and when
	 * one of their tasks fails.
	 */
	// 下一次 reconcile 要检查其 on 中是否有失败任务的 failFast 等待者；在打开、开始等待、被等待任务失败时加入。
	readonly #failFastChecks = new Set<TaskId>();
	/**
	 * Live tasks with `abandonOnRestart` found at open, from an earlier Harness. The first reservation pass abort-marks
	 * them with reason `restart`, so nothing of them or below them runs a phase again.
	 */
	// 上次 Harness 遗留、带 abandonOnRestart 的存活任务；第一轮预留会给它们打 restart 取消标记，
	// 使它们及其下层不再执行任何阶段。
	readonly #abandoned = new Set<TaskId>();
	/** Sleeping live tasks, due or not: the candidates of `#wakeDue()`. */
	// 所有睡眠中的存活任务（无论是否到期），是 #wakeDue() 的候选集合。
	readonly #sleeping = new Set<TaskId>();
	/** Timer for the earliest sleep, without `onWake` while scheduling runs. */
	// 最早睡眠到期定时器；没有宿主 onWake 且调度已启用时使用。
	#timer: { readonly at: number; readonly disarm: () => void } | undefined;
	/** Last value given to `onWake`, so an unchanged one is not repeated. */
	// 上次传给 onWake 的值；相同则不再重复通知宿主。
	#lastWake: Wake | undefined;
	// 是否已安排一次唤醒通知（合并同一轮内的多次请求）。
	#wakeScheduled = false;
	// 阻塞原因订阅者；注册表变化或迁移失败时通知它们。
	readonly #blockedListeners = new Set<() => void>();
	/** A registry snapshot that threw for the task graph was reported; it is read per record, so only once. */
	// 注册表快照在任务图读取时抛错，已报告过一次；因为按记录读取，只报告一次避免刷屏。
	#snapshotReported = false;
	// 是否已安排 reconcile；合并同一轮内的多次触发。
	#reconcileScheduled = false;
	/** Reconcile passes underway with work (they may overlap): their commits finalize held outcomes and mark cascades. */
	// 正在执行且有实际工作的 reconcile 轮次数（可重叠，>0 表示还有收尾/级联工作未落定）。
	#reconcilingWork = 0;
	// 是否已安排 sweep。
	#sweepScheduled = false;
	/**
	 * Nodes chain loads installed for jobs whose commits are not published yet, with how many such jobs: the sweep keeps
	 * them, as work a pending commit creates below them needs them.
	 */
	// 链加载为尚未发布提交的作业安装的节点及引用计数；sweep 保留它们，因为待发布提交可能在其下创建任务。
	readonly #pins = new Map<Node, number>();
	/** Keys the decision region underway reads (`#region()`); set only while one runs. */
	// 当前决定区域读过的键集合，只在 #region() 运行期间存在；用于判断是否读到未发布提交。
	#reading: Set<string> | undefined;
	// 是否有待处理的取消级联（由 #scheduleReconcile 消费）。
	#cascadePending = false;
	// 注册表订阅的解除函数；初始为空函数，open 时替换。
	#unsubscribeRegistry: () => void = () => {};
	// resume() 之后为 true；只有启用后 #drain 才会真正调度。
	#enabled = false;
	// 只读模式标志（来自 options.readOnly）。
	readonly #readOnly: boolean;
	// 关闭中：新工作不再被接受，#kick 不再执行。
	#closing = false;
	// 有新的可运行工作或状态变化，需要重新 drain；用于合并唤醒。
	#dirty = false;
	// #drain 正在运行，防止重入；drain 结束后若 #dirty 会再跑一轮。
	#draining = false;

	// 构造只保存依赖并创建指标，不读存储、不提交、不订阅；open() 才做初始加载与订阅。
	// telemetry 缺省时用 NOOP 上下文；createTypedMetrics 按 schema 校验指标名，错误在构造时即暴露。
	constructor(options: TaskSchedulerOptions) {
		this.#telemetry = options.telemetry ?? NOOP_TELEMETRY_CONTEXT;
		// 指标描述必须符合 DURABLE_TELEMETRY_SCHEMA；upDownCounter 用于活跃任务数，histogram 用于阶段时长。
		const metrics = createTypedMetrics(this.#telemetry.metrics ?? NOOP_TELEMETRY_METRICS, [DURABLE_TELEMETRY_SCHEMA]);
		this.#activeMetric = metrics.upDownCounter("pi.durable.tasks.active");
		this.#durationMetric = metrics.histogram("pi.durable.phase.duration");
		// 逐项保存依赖；字段都是 readonly，之后不再替换（回调内部可返回新值）。
		this.#session = options.session;
		this.#storage = options.storage;
		this.#registry = options.registry;
		this.#models = options.models;
		this.#agent = options.agent;
		this.#settings = options.settings;
		this.#env = options.env;
		this.#now = options.now;
		this.#onWake = options.onWake;
		this.#timers = options.timers;
		this.#writeAtClose = options.writeAtClose;
		this.#report = options.report;
		this.#settleOutcome = options.settleOutcome;
		this.#limitsRestarts = options.limitsRestarts;
		this.#withdrawInputs = options.withdrawInputs;
		this.#conversation = options.conversation;
		this.#context = options.context;
		// 显式 true 才是只读；undefined/false 都是可写。
		this.#readOnly = options.readOnly === true;
	}

	/**
	 * Load live tasks and change surviving `running` tasks back to `pending`, counting the restart. Dispatches nothing;
	 * a task cut off `settings.restartLimit` times ends when it is next reserved. Read-only, it only loads them: a
	 * `running` task stays as committed, running in another process.
	 */
	// 输入 Context（可取消 open 的提交）；无返回值。
	// 流程：订阅提交/关闭/注册表 → 在会话线上扫描全部存活状态 → 镜像记录并回退 running → 安排 reconcile 与唤醒。
	// 副作用：#live/#resumed/#abandoned 等内存状态、一次 Session 提交、注册表订阅、可能的定时器。
	// 错误：提交或扫描失败会传播；失败时调用方不应继续使用该调度器。
	// 例：崩溃前状态为 running 的任务会被写成 pending 且 restarts+1；同一任务在重启上限内会再次被预留。
	async open(context: Context): Promise<void> {
		// 先订阅再扫描：扫描期间的新提交不会漏掉；#observe 会把它们排队应用。
		this.#session.followCommits((publication) => this.#observe(publication));
		// 会话关闭时 seal：停止接受新工作并处理仍在运行的 invocation。
		this.#session.subscribeClose(() => this.#seal());
		// 注册表变化可能让阻塞任务变为可运行，或让运行任务的定义被替换；通知阻塞订阅者并尝试调度。
		this.#unsubscribeRegistry = this.#registry.subscribe(() => {
			this.#notifyBlocked();
			this.#kick();
		});
		// 初始扫描放在一次提交里：在会话线上，读到的是已发布状态，且后续回退写入与扫描处于同一提交批次。
		await this.#session.commitWith(async (tx) => {
			// 等待此前已发布提交落定，保证扫描基于最新状态。
			await this.#published();
			// Every table read before the first write.
			// 先读完五种存活状态的分页扫描，再做写入：避免提交过程中改变后续扫描的可见结果。
			const scans = [];
			for (const status of LIVE_STATUSES) {
				// scanAll 自动翻页；SCAN_PAGE_SIZE 只是每页大小。
				scans.push(await scanAll((cursor) => tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)));
			}
			for (const records of scans) {
				for (const record of records) {
					// undefined 表示没有暂存覆盖：直接以已提交记录更新索引。
					this.#track(undefined, record);
					// 标记已处理过 resume 阶段，resume() 时不再重复回退。
					this.#resumed.add(record.id);
					// 只读模式不做任何恢复写入，running 保持原样（可能在另一个进程运行）。
					if (this.#readOnly) continue;
					// 上次 Harness 要求重启即放弃的任务，记录到 #abandoned，留给第一轮预留打取消标记。
					if (record.abandonOnRestart === true) this.#abandoned.add(record.id);
					if (record.state.status === "running") {
						// 进程崩溃/重启留下的 running 视为被打断一次；状态回退为 pending，检查点保留。
						const restarts = (record.restarts ?? 0) + 1;
						const pending = withState(record, { status: "pending", checkpoint: record.state.checkpoint });
						// 类型断言：withState 保留 kind 的运行时形状，但泛型已被擦除。
						tx.setTask({ ...pending, restarts } as AnyTaskRecord);
					}
					// failFast 等待者在 open 时先登记，reconcile 会检查其 on 中是否有失败任务。
					if (record.state.status === "waiting" && record.state.policy === "failFast") {
						this.#failFastChecks.add(record.id);
					}
				}
			}
		}, context);
		// 只读 Harness 不运行、不写、不唤醒；初始扫描已把它需要的记录放进 #live。
		if (this.#readOnly) return;
		// Derive abort marks a crash left unapplied below cancelled owners, and finalize held outcomes.
		// 崩溃可能留下“所有者已取消、下层还带旧标记”的状态；下一轮 reconcile 会补上级联标记并 finalize 持有结果。
		this.#cascadePending = true;
		this.#scheduleReconcile();
		// 根据睡眠任务与可运行任务安排宿主唤醒/定时器。
		this.#scheduleWake();
	}

	/**
	 * Enable scheduling, and make sleeping tasks that are due runnable: a host wakeup, such as an alarm, calls this.
	 * Idempotent; the kick does nothing once closing.
	 */
	// 无参数、无返回值；把 #enabled 置 true，唤醒已到期的睡眠任务并尝试 drain。
	// 幂等：重复调用只重复一次 wakeDue/kick，不会重复提交。
	// 错误：只读 Harness 调用会抛 ReadOnlySession。
	// 例：宿主在收到 Wake 后调用 resume()，到期的 sleep 任务立刻变为可运行。
	resume(): void {
		// 只读会话不能执行任务；这是运行时状态检查，不是类型可保证的条件。
		if (this.#readOnly) throw new ReadOnlySession("running tasks");
		this.#enabled = true;
		// 到期的睡眠任务先转 pending，再 drain，避免先跑一轮空调度。
		this.#wakeDue();
		this.#kick();
	}

	/**
	 * Why a live task cannot run here, if it cannot: its definition is missing, too old, or failed to migrate. A running
	 * task, an abort-marked one, and one holding its outcome are never blocked.
	 */
	// 输入任务的“阻塞主体”（身份/版本/状态等）；输出阻塞原因或 undefined（可运行/无需阻塞）。
	// 纯查询，不读存储、不写状态；注册表快照读取失败时报告一次并返回 undefined。
	// 规则：running/completing/terminal 永不阻塞；已请求取消但还没有 reason 时也不会阻塞
	// （等待执行 abort 处理器）；有 restart 标记则按定义缺失等规则判断。
	// 例：kind 在快照中不存在 -> "missing_task"；版本低于定义最低版本 -> "task_too_old"。
	blockedReason(record: BlockedSubject): BlockedReason | undefined {
		const status = record.status;
		// 这些状态不需要注册表定义就能继续/结束，任务图不显示它们被阻塞。
		if (status === "running" || status === "completing" || status === "terminal") return undefined;
		// An abort request runs its handler or orphans the task; a `restart` mark waits for the definition, blocked.
		// abortReason 已存在表示打标者已写明原因（如 restart），此时仍需定义才能处理；undefined 表示普通取消请求。
		if (record.abortRequested && record.abortReason === undefined) return undefined;
		let snapshot: RegistrySnapshot;
		try {
			snapshot = this.#registry.snapshot();
		} catch (error) {
			// 快照读取本身可能因组合失败抛错；按记录调用，所以只报告一次。
			if (!this.#snapshotReported) this.#report(error, REGISTRY);
			this.#snapshotReported = true;
			// 无法判断时不声称阻塞，避免任务图把一切显示为 missing_task。
			return undefined;
		}
		// #fit 只做声明/版本/迁移能力检查，不执行任务代码。
		const fit = this.#fit(record, snapshot.task(record.kind));
		// "reason" in fit 是判别联合收窄：存在 reason 即不可接管。
		if ("reason" in fit) return fit.reason;
		// 需要迁移但定义没有 migrate 钩子：声明上无法接管。
		return fit.migrates && fit.task.definition.migrate === undefined ? "migration_failed" : undefined;
	}

	/** Call `listener` when blocked reasons may have changed without a commit: a registry change or a failed migration. */
	// 注册无参监听器，返回解除函数；只保存在内存 Set 中，不触发立即回调。
	// 例：const stop = scheduler.subscribeBlocked(() => refreshGraph()); stop();
	subscribeBlocked(listener: () => void): () => void {
		this.#blockedListeners.add(listener);
		// 返回闭包而非直接删除：调用方可以选择何时解除。
		return () => this.#blockedListeners.delete(listener);
	}

	/**
	 * When the Session next needs a process: `active` while some task can run now or is running, `at` for the earliest
	 * sleep not yet due. Synchronous, from memory; a task whose chain is not loaded yet counts as it would alone.
	 */
	// 无参数；返回 Wake：{ active } 表示当前是否需要进程，{ active, at } 额外给出最早未到期睡眠时间。
	// 同步、只读内存；不提交、不运行任务。任务链未加载时按“单独一个任务”保守估计。
	// 例：只有一个 5 分钟后到期的睡眠任务时返回 { active: false, at: now+300000 }；
	// 有等待子任务的 completing 或已可运行任务时 active 为 true。
	wake(): Wake {
		// A read-only Harness runs nothing, so it never needs a process.
		// 只读 Harness 永远不需要进程：active 为 false 且不设 at。
		if (this.#readOnly) return { active: false };
		const now = this.#now();
		// A reconcile pass with work to do is work too: it finalizes held outcomes and marks cascades, at open as
		// recovery. A process that dies before it lands must be woken again. A pass with nothing to do is not.
		// 运行中的 invocation、未完成的 reconcile、仍有可运行的记录或当前扫描发现可运行任务，都算 active。
		const active =
			this.#invocations.size > 0 || this.#reconcilingWork > 0 || this.#reconcileWork() || this.#runsNow(now);
		// The earliest sleep not yet due: only `#sleeping` holds sleeping tasks, so no pass visits every live task.
		// 只遍历 #sleeping 候选集，避免扫描全部 #live；取消中的睡眠任务不参与（它会走 abort 路径）。
		let at: number | undefined;
		for (const id of this.#sleeping) {
			const record = this.#live.get(id);
			const state = record?.state;
			// until <= now 表示已到期，应 active=true 而不是给 at；这里只收集未来时间。
			if (state?.status === "sleeping" && !record!.abortRequested && state.until > now) {
				at = at === undefined ? state.until : Math.min(at, state.until);
			}
		}
		// 没有未来到期时间时省略 at 键，调用方看到的形状更简单。
		return at === undefined ? { active } : { active, at };
	}

	/** Whether a live task can run now: the scan `wake()` needs only while no invocation runs. */
	// 输入当前时间，输出是否存在“现在就能运行”的存活任务；只读内存，异常快照报告一次后跳过定义检查。
	// 规则：completing 不算；仍在等待存活依赖的 waiting 不算；未到期且未取消的 sleeping 不算；
	// 取消任务若其下层还有存活工作也不算；因定义缺失阻塞的任务不算。
	#runsNow(now: number): boolean {
		let snapshot: RegistrySnapshot | undefined;
		let snapshotFailed = false;
		for (const record of this.#live.values()) {
			const state = record.state;
			// completing 只等待子任务收尾，自身不运行。
			if (state.status === "completing") continue;
			// waiting 且至少一个 on 任务仍存活：尚未满足，不运行。
			if (state.status === "waiting" && !record.abortRequested && state.on.some((id) => this.#live.has(id)))
				continue;
			// 睡眠未到期且未取消：还没到运行时间。
			if (state.status === "sleeping" && !record.abortRequested && state.until > now) continue;
			// An abort invocation waits for the live work below it, which counts itself.
			// 取消 invocation 要等它拥有的存活工作结束；true 表示普通工作（含自身语义），有存活项则继续等。
			if (record.abortRequested && this.#waitingOn(record, true).length > 0) continue;
			// A task no definition can take waits for a registry change, except an abort-marked one, which is orphaned.
			// 无取消请求、或已有明确 abortReason 的任务，需要检查定义是否可接管；普通取消请求会直接走 abort 处理。
			if (!record.abortRequested || record.abortReason !== undefined) {
				// 快照只读一次并复用；读取失败按“无法判断”处理，不把任务当成可运行。
				if (snapshot === undefined && !snapshotFailed) {
					try {
						snapshot = this.#registry.snapshot();
					} catch (error) {
						snapshotFailed = true;
						this.#report(error, REGISTRY);
					}
				}
				// 定义缺失/过旧/无法迁移：任务在等注册表变化，不是现在可运行。
				if (snapshot !== undefined && "reason" in this.#fit(record, snapshot.task(record.kind))) continue;
			}
			// 通过以上筛选，说明该记录现在可以开始/继续。
			return true;
		}
		return false;
	}

	/**
	 * Signal every invocation and wait for them, then write the tasks they ran back as `pending` (`writeAtClose`), as a
	 * close is not a crash. Close calls this after every close listener has run, so waits, watches, and streams a task
	 * holds end with the Session's reason, not as cancelled by its signal.
	 */
	// 无参数、无返回值；对每个运行中的 invocation 调 controller.abort()，等待它们全部结束。
	// 副作用：写存储把仍为 running 的任务改回 pending；关闭不计数 restart。
	// 错误：writeAtClose 的失败被吞掉（Session 自身已通过 Storage guard 报告）。
	// 例：关闭一个正在生成的任务后，下次 open 看到的是 pending，restarts 不变。
	async join(): Promise<void> {
		// 先快照 invocation 列表：abort 过程中 Map 可能被删改，遍历原列表更稳定。
		const stopped = [...this.#invocations.values()];
		for (const invocation of stopped) invocation.controller.abort();
		// allSettled：单个 invocation 结束失败也继续等待其余任务，关闭不能被一个失败卡住。
		await Promise.allSettled(stopped.map((invocation) => invocation.done));
		// 没有运行中的任务就不用写回。
		if (stopped.length === 0) return;
		// A close is not a crash: a task it stopped is `pending` again, so the next open counts no restart for it. Read
		// on the line after commits admitted before the seal, such as an abort mark, so the write keeps them. A failure
		// leaves them `running`, counted as if cut off; the Storage guard fails the Session and reports it.
		// writeAtClose 在会话线上运行，能看到关闭前准入的提交（如 abort 标记），且写回不会覆盖它们。
		await this.#writeAtClose(
			() =>
				stopped.flatMap((invocation) => {
					const record = this.#live.get(invocation.taskId);
					// 期间已被其他路径改为终态/pending 的任务不再写；只处理仍是 running 的。
					if (record?.state.status !== "running") return [];
					// 关闭不是崩溃：恢复为 pending 且保留 checkpoint，restarts 不增加。
					const value = withState(record, { status: "pending", checkpoint: record.state.checkpoint });
					return [{ type: "task", value } as const];
				}),
			// 写回失败时保持 running；下次 open 会按崩溃处理并计数，Storage guard 负责报告。
		).catch(() => {});
	}

	/**
	 * Commit the abort mark, or settle a task that no registered definition can take as `orphaned` when nothing it owns
	 * is live, then join the run invocation seen on the line; the commit listener signalled it. The abort invocation
	 * starts once the task's ordinary owned work is gone. A `completing` task is only marked. A request replaces a
	 * `restart` mark, so a task abandoned after a restart that waits for its definition is orphaned; with `keepRestart`,
	 * as for an owner's own cleanup, such a task keeps its mark and waits on.
	 */
	// 输入任务 id、调用方 Context、keepRestart；输出 "marked"（已打取消标记/已 orphaned）或 "terminal"（本就结束）。
	// 流程：一次提交内读当前记录 → 处理终态/restart 特例 → 无运行 invocation 时检查是否还有存活下属 →
	// 若没有下属且定义不可接管则直接 orphaned → 否则打取消标记 → 等运行 invocation 结束。
	// 副作用：写取消标记或 orphaned 终态；可能加载所有权链、运行 migrate。
	// 错误：任务不存在抛 Error；提交/等待失败传播（等待同时被 session.failed 打断）。
	// 例：abort(某运行中任务) 会写 abortRequested，提交监听器发出信号，然后等待其 done。
	async abort(id: TaskId, context: Context, keepRestart = false): Promise<"marked" | "terminal"> {
		const marked = await this.#session.commitWith(async (tx) => {
			// 在事务里重新读取，避免使用过期记录；tx.task 看到本事务暂存与已提交值。
			const current = await tx.task(id);
			if (current === undefined) throw new Error(`Task ${id} does not exist`);
			// 已终态无需再标记。
			if (current.state.status === "terminal") return { result: "terminal" as const };
			const invocation = this.#invocations.get(id);
			// A restart-marked task has no run invocation; it only waits for its abort.
			// keepRestart 用于所有者自己的清理：不要用普通请求覆盖 restart 标记，任务继续等待定义。
			if (keepRestart && current.abortReason === "restart") return { result: "marked" as const };
			if (invocation === undefined && current.state.status !== "completing") {
				// 没有运行中的 invocation：需要知道它是否还有存活的下属工作（决定能否直接 orphan）。
				await this.#loadScopes(false);
				// 在决定区域里读“是否有普通拥有的存活工作”；读到未发布提交会重试。
				const owns = await this.#region(() => this.#hasOwnedLive(id), this.#reloadScopes);
				// Resolved once that decision stands, as it may run `migrate`.
				// 只有在没有存活下属时才需要解析定义；这一步在决定成立后执行，因为可能运行 migrate。
				const resolution = owns
					? undefined
					: this.#resolve(current as RunnableTaskRecord, this.#registry.snapshot());
				if (resolution?.kind === "blocked") {
					// 没有下属且没有定义能接管：直接写 orphaned 终态，无需运行 abort 处理器。
					await this.#terminate(tx, current, { status: "orphaned", reason: resolution.reason });
					return { result: "marked" as const };
				}
			}
			// 普通取消请求（没有 abortReason）只标记一次；已有 restart 等明确原因时，用普通请求替换为无原因取消。
			if (!current.abortRequested || current.abortReason !== undefined) tx.setTask(withAbortMark(current));
			// 若正好有运行 invocation，把它交给调用方等待；abort 模式的 invocation 无需再等。
			return { result: "marked" as const, run: invocation?.mode === "run" ? invocation : undefined };
		}, context);
		// The commit listener signalled the run; join it. A run that ignores its signal can outlive a failed Session,
		// which ends the wait instead.
		// 同时等待 invocation 完成与 session.failed：忽略取消信号的任务不会永久卡住关闭/取消流程。
		if (marked.run !== undefined) {
			await awaitWithContext(Promise.race([marked.run.done, this.#session.failed]), context);
		}
		return marked.result;
	}

	// 输入任务 id 与调用方 Context；返回该任务终态记录的 Promise（已终态则立即完成）。
	// 在会话线上“检查 + 登记等待者”，保证终态发布不会落在两者之间而漏掉唤醒。
	// 错误：关闭中抛 closed；任务不存在抛 Error；context 取消会让等待者拒绝。
	// 例：await scheduler.waitForTask(id, ctx) 得到 { status: "completed", output } 或 faulted 记录。
	async waitForTask(id: TaskId, context: Context): Promise<SettledTask<JsonValue>> {
		// Check and register on the line so no terminal publication falls between them.
		// readOnLine 提供线上的 storage 视图；返回对象里的 promise 才是实际等待结果。
		const found = await this.#session.readOnLine(async (storage) => {
			// 关闭后不再接受新等待者。
			if (this.#closing) throw closedError(this.#session);
			// 仍是存活任务：登记等待者，提交监听器在终态出现时 resolve。
			if (await this.#region(() => this.#liveRecord(id) !== undefined)) {
				return { promise: this.#taskWaiters.add(id, context) };
			}
			// 已不在 #live：从存储读终态记录；这里读到的一定是终态（否则会在 #live）。
			const record = await storage.task(id, context);
			if (record === undefined) throw new Error(`Task ${id} does not exist`);
			return { promise: Promise.resolve(record as SettledTask<JsonValue>) };
		});
		return found.promise;
	}

	/**
	 * Resolve when ordinary traversal from the conversation, or from every ownerless conversation, reaches no live
	 * non-background task.
	 */
	// 输入会话 id 或 undefined（整个 Harness）；返回空闲时完成的 Promise，不产生值。
	// 已是空闲立即 resolve；否则登记等待者并安排 reconcile（任务结束时靠它重新检查）。
	// 错误：关闭中返回已拒绝 Promise（同步路径，不抛异常）。
	waitForIdle(conversationId: ConversationId | undefined, context: Context): Promise<void> {
		// 关闭后不会再有“空闲”事件，直接拒绝。
		if (this.#closing) return Promise.reject(closedError(this.#session));
		// #idle 是同步只读检查；已满足则无需登记。
		if (this.#idle(conversationId)) return Promise.resolve();
		// 保证即使没有新的提交，也会有一轮 reconcile 在合适时机推进/唤醒。
		this.#scheduleReconcile();
		return this.#idleWaiters.add(conversationId, context);
	}

	/**
	 * `Conversation.abort()`: in one commit, withdraw the queued inputs and mark every live non-background task that
	 * ordinary traversal from the conversation reaches; resolves once the scope is idle. With `background`, traversal
	 * crosses background boundaries, and the wait also covers every task it reached.
	 */
	// 输入会话 id、是否跨越后台任务边界、Context；返回 Promise，在作用域空闲时完成。
	// 流程：同一提交里加载作用域 → 向下遍历会话树 → 给可达的非后台（或 background=true 时全部）存活任务打取消标记 →
	// 撤回该集合内会话的排队输入 → 等待全部任务结束与作用域空闲。
	// 副作用：批量写取消标记、撤回输入；等待期间登记 waiter。
	// 例：Conversation.abort() 调它；background=true 时连子任务及其后台工作一起取消。
	async abortConversation(conversationId: ConversationId, background: boolean, context: Context): Promise<void> {
		const reached = await this.#session.commitWith(async (tx) => {
			// 提交开始前等待此前发布落定，保证遍历基于最新所有权。
			await this.#published();
			// 加载作用域内所有会话（true 表示跨越后台边界，用于撤回输入时判断范围）。
			const queued = await this.#loadScopes(true);
			// 普通遍历的范围：只从当前会话出发；roots 不参与。
			const scope = { conversation: conversationId };
			const reached: TaskId[] = [];
			// 向下遍历返回每个节点与对应存活记录（若有）；background 选项决定是否跨过后台边界。
			const walk = this.#walkDown(conversationNode(conversationId), { crossBackground: background });
			for (const { node, live } of walk) {
				// 没有存活任务（仅结构节点）跳过；不跨后台时也跳过后台任务。
				if (live === undefined || (node.background && !background)) continue;
				reached.push(live.id);
				// 已有普通取消请求则不重复写；restart 等明确原因会被普通请求替换。
				if (!live.abortRequested || live.abortReason !== undefined) tx.setTask(withAbortMark(live));
			}
			// 撤回作用域内会话的排队输入；inScope 为 true 才处理，避免/background 边界外的输入被误撤。
			for (const id of queued) {
				if (this.#inScope({ conversation: id }, scope, background) === true) await this.#withdrawInputs(tx, id);
			}
			return reached;
		}, context);
		// 跨后台边界时，调用方通常要等所有被取消任务真正结束；普通会话取消只等作用域空闲。
		if (background) for (const id of reached) await this.waitForTask(id, context);
		await this.waitForIdle(conversationId, context);
	}

	/**
	 * The ownership memberships a commit's task and conversation changes write (group commit §4.2), at its admission on
	 * the line: for each task created or made terminal, every node from its parent up to and including the nearest live
	 * task, or the root conversation, and then the roots too, conservatively, as a pending end may unlist the root a
	 * creation finds listed; for each conversation created under a task, that task; and the intent set when
	 * a change sets, upgrades, or clears a mark or a held or ended outcome other than `completed`. Loads the chains it
	 * walks; the nodes it installs stay until the commit is published.
	 */
	// 输入提交事务；输出该提交应声明的所有权成员键（同步或异步，因为可能需要加载链）。
	// 无任务且会话没有 owner 变更时走快路径，复用 NO_KEYS，不加载任何链。
	// 这些键由 Session 的分组提交用来判断“读到这些成员的决定是否要等本提交发布”。
	membershipKeys(tx: Transaction): readonly string[] | Promise<readonly string[]> {
		const tasks = tx.stagedTasks();
		const conversations = tx.stagedConversations();
		// 快路径：没有任何任务变更，且没有会话被挂到任务下，则不影响所有权索引。
		if (tasks.length === 0 && conversations.every((record) => record.owner === undefined)) return NO_KEYS;
		return this.#membershipKeys(tx, tasks, conversations);
	}

	// 真正计算成员键的异步实现；读取暂存的任务/会话，沿所有权链向上收集 ownedKey。
	// overlayOf(tx) 生成覆盖层，让加载链时看到本提交暂存的 owner 边与记录。
	async #membershipKeys(
		tx: Transaction,
		tasks: readonly AnyTaskRecord[],
		conversations: readonly ConversationRecord[],
	): Promise<readonly string[]> {
		const keys = new Set<string>();
		// 暂存值覆盖已提交值；链加载也通过它判断父节点。
		const overlay = overlayOf(tx);
		// createdTaskIds 区分“新建任务”和“已有任务的状态更新”：只有新建或结束才改变存活集合。
		const created = new Set(tx.createdTaskIds());
		// 每条链走到哪里结束的缓存，避免同一提交的多个任务重复走共享祖先。
		const reached = new Map<string, ConversationId | undefined>();
		for (const record of tasks) {
			// 取消意图集合变化（设置/升级/清除标记或非 completed 的结局）需要键住 INTENT_KEY。
			if (intentChanges(this.#live.get(record.id), record)) keys.add(INTENT_KEY);
			// 只有新建或变为终态才改变“存活工作”成员关系；普通阶段更新不影响所有权索引。
			if (!created.has(record.id) && record.state.status !== "terminal") continue;
			// 先加载父链，确保 chainKeys 能读到 owner 记录而不是 unknown。
			await this.#loadChain(parentOf(record), overlay);
			// 从父节点向上收集，返回值非 undefined 表示链到达了无主根，需要声明 ROOTS_KEY。
			if ((await this.#chainKeys(parentNode(record), overlay, keys, reached)) !== undefined) keys.add(ROOTS_KEY);
		}
		for (const conversation of conversations) {
			// 只有会话被挂到任务下（owner 变化）才影响上行链。
			const owner = conversation.owner?.taskId;
			if (owner === undefined) continue;
			await this.#loadChain({ task: owner }, overlay);
			await this.#chainKeys(owner, overlay, keys, reached);
		}
		return [...keys];
	}

	/**
	 * Add the memberships from `start` up to and including the nearest live task, or the root conversation, which it
	 * returns. `reached` keeps, per node walked, where its walk ended, so a chain several tasks of a commit share is
	 * walked once. Whether an ancestor is live can change under a pending commit, so it is read after a touch of the
	 * ancestor's record: a pending end must not stop the chain early. Ownership fields are immutable, so not keyed.
	 */
	// 输入起点节点、覆盖层、累计键集合、已走缓存；返回该链到达的根会话（无主根）或 undefined。
	// 规则：从起点向上，记录经过的 ownedKey，直到遇到一个仍存活的任务（含它），或到达会话根；
	// 若节点未加载则 touch 对应键并等待，再重新加载链；所有权字段不可变，因此不键住字段本身。
	// 纯内存 + 可能的等待；不写存储、不改变记录。
	async #chainKeys(
		start: Node,
		overlay: Overlay,
		keys: Set<string>,
		reached: Map<string, ConversationId | undefined>,
	): Promise<ConversationId | undefined> {
		// 本轮走过的键；最后统一写入 reached，避免中途 break 时漏缓存。
		const walked: string[] = [];
		let root: ConversationId | undefined;
		// null 表示调用方明确表示“到达无主会话”，undefined 表示没有更多节点。
		let node: Node | null | undefined = start;
		while (node !== undefined && node !== null) {
			const key = ownedKey(node);
			// Walked up from here already, for another task of the commit.
			// 同一提交里另一任务已经走过这段链：直接复用其根，不必重复等待/加载。
			if (reached.has(key)) {
				root = reached.get(key);
				break;
			}
			keys.add(key);
			walked.push(key);
			// 节点字符串一定是会话节点（类型 Node 只允许 TaskId 或 `c${number}`；会话有 c 前缀）。
			if (typeof node === "string") {
				const conversation = conversationOf(node);
				// 会话的 owner 边：null 表示无主，遍历在此结束。
				node = this.#edge(conversation, overlay);
				if (node === null) root = conversation;
				continue;
			}
			// 优先读本提交暂存的记录，其次读已提交镜像。
			let record: AnyTaskRecord | undefined = overlay.tasks.get(node);
			if (record === undefined) {
				// touch 返回 undefined 表示没有未发布写者；否则等待它发布。
				const gate = this.#session.touch(taskKey(node));
				if (gate !== undefined) {
					await gate;
					// It may have ended meanwhile, and its node been swept: load the chain above it again.
					// 等待期间任务可能已结束并被 sweep，节点信息丢失，需要重新加载它上方的链。
					await this.#loadChain({ task: node }, overlay);
				}
				record = this.#live.get(node);
			}
			// 遇到仍存活的任务即停止向上：成员的“最近存活祖先”已经找到。
			if (record !== undefined && record.state.status !== "terminal") break;
			// 终态任务：从其所有权字段继续向上；记录已被 sweep 时用 #settled 缓存。
			const above: TaskNode | undefined = record ?? this.#settled.get(node);
			node = above === undefined ? undefined : parentNode(above);
		}
		for (const key of walked) reached.set(key, root);
		return root;
	}

	// ─── Scheduling ────────────────────────────────────────────────────────

	// 提交发布监听器：每次存储提交发布后在会话线上同步调用（#observe 由图顶 followCommits 注册）。
	// 输入 ObservedCommit（memory 或 stored）；无返回值。职责：把提交变化应用到 #live 与所有权索引，
	// 更新上下文缓存，登记 failFast/取消级联/终态等待者，最后 sweep、结算空闲并尝试调度。
	// 不执行任务代码；abort 信号通过 queueMicrotask 延后，避免在发布回调里重入 Session。
	// 例：某任务提交为 terminal 时，会从 #live 删除、resolve waitForTask、安排 reconcile 让所有者可能 finalize。
	#observe(publication: ObservedCommit): void {
		// A commit held in memory changes documents only.
		// 仅内存提交（如草稿/配置）不改变任务/会话记录，直接忽略。
		if (publication.kind === "memory") return;
		// 新条目可能追加到已保持的上下文范围，直接扩展缓存，无需后续 Storage 扫描。
		this.#advanceContexts(publication);
		// 本批中新出现的任务（交给后续“检查其上方是否已取消”的循环）。
		const updated: AnyTaskRecord[] = [];
		// 本批中首次变为失败结果的任务 id，用于唤醒 failFast 等待者。
		const failed: TaskId[] = [];
		// 是否有任务记录变化；没有则不影响任务图/空闲结算，只需 sweep 后返回。
		let changed = false;
		// The conversations whose idleness the commit's task changes can change; undefined when a chain is not known.
		// 受影响的会话作用域；undefined 表示某条链未知、只能做全量空闲检查。
		let dirty: Set<ConversationId> | undefined = new Set();
		// Edges first, so the tasks a commit creates in a new conversation hang from it.
		// 先处理会话 owner 边：新建会话下创建的任务在后续 task 循环里才能挂到正确父节点。
		for (const change of publication.changes) {
			if (change.type === "conversation" && !this.#edges.has(change.value.id)) {
				this.#setEdge(change.value.id, change.value.owner?.taskId ?? null);
			}
		}
		for (const change of publication.changes) {
			if (change.type !== "task") continue;
			changed = true;
			const record = change.value;
			const previous = this.#live.get(record.id);
			// 首次出现失败结局：记录 id 供后方唤醒等待者的循环使用；重复发布不重复加入。
			if (failedOutcome(record) && (previous === undefined || !failedOutcome(previous))) failed.push(record.id);
			// 把变化同步进 #live 与所有权索引（新增/结束任务会更新 #below/#roots/#settled 等）。
			this.#track(previous, record);
			// Idleness counts live tasks, so only a task that became live or ended can change it. Collected before `#sweep()`,
			// which may forget the chain of a task that ended.
			// 只有“从无到有”或“变为终态”会改变空闲判断；sweep 可能删除结束任务的链，因此先收集作用域。
			const liveness = previous === undefined || record.state.status === "terminal";
			if (liveness && dirty !== undefined && !this.#addScopesAbove(record, dirty)) dirty = undefined;
			if (record.state.status === "terminal") {
				// 终态后迁移失败缓存与 failFast 候选都失效。
				this.#failedMigrations.delete(record.id);
				this.#failFastChecks.delete(record.id);
				// 已登记的 waitForTask 立即得到终态记录。
				this.#taskWaiters.resolve(record.id, record as SettledTask<JsonValue>);
				// Its owner may finalize now.
				// 所有者的 completing 可能因下属结束而可以收尾。
				this.#scheduleReconcile();
				continue;
			}
			if (record.abortRequested && previous?.abortRequested !== true) {
				this.#cascadePending = true;
				// Signal a run invocation of the newly marked task; its next step ends it. Abort listeners are task code, which
				// never runs inside a publication: the signal follows in a microtask, after host commit listeners.
				// 运行中的 invocation 不能在这里同步收到 abort（会重入/执行任务代码），延后到微任务。
				const invocation = this.#invocations.get(record.id);
				if (invocation?.mode === "run") queueMicrotask(() => invocation.controller.abort());
			}
			// A request replacing a `restart` mark upgrades the marks of the work below.
			// restart 标记被普通取消请求替换：下层也应从 restart 升级为请求，所以重跑级联。
			if (previous?.abortReason !== undefined && record.abortReason === undefined) this.#cascadePending = true;
			const status = record.state.status;
			// 进入 completing 且自身带取消意图：需要把取消传播给它下面的工作。
			if (status === "completing" && previous?.state.status !== "completing") {
				if (cancellationIntent(record)) this.#cascadePending = true;
				this.#scheduleReconcile();
			}
			// 刚刚进入 failFast waiting：加入检查集合，reconcile 会看其 on 中是否已有失败任务。
			if (status === "waiting" && record.state.policy === "failFast" && previous?.state.status !== "waiting") {
				this.#failFastChecks.add(record.id);
				this.#scheduleReconcile();
			}
			// Its owners and place never change: what is above it is checked once, when it becomes live.
			// 所有权字段不可变，只需在首次出现时检查“上方是否已取消”。
			if (previous === undefined) updated.push(record);
		}
		// 失败任务可能让反向等待索引里的 failFast 等待者需要立即失败。
		for (const id of failed) {
			for (const waiter of this.#waiters.get(id) ?? []) {
				const state = this.#live.get(waiter)?.state;
				if (state?.status === "waiting" && state.policy === "failFast") {
					this.#failFastChecks.add(waiter);
					this.#scheduleReconcile();
				}
			}
		}
		for (const change of publication.changes) {
			// A queued input below a cancelled owner is withdrawn, even after its cascade.
			// 只关心“排队的输入”提交；其他提交类型与本逻辑无关。
			if (change.type !== "submission" || change.value.status !== "queued" || change.value.type !== "input")
				continue;
			// Only an owner with cancellation intent withdraws it; a later intent's mark runs the cascade then.
			// 没有取消意图时无需撤回；之后的意图标记会触发级联再处理。
			if (this.#intent.size === 0) continue;
			const conversation = change.value.conversationId;
			// 链未知或位于已取消所有者之下：安排级联，让 reconcile 撤回它。
			if (!this.#known(conversationNode(conversation)) || this.#belowCancelled({ conversation })) {
				this.#cascadePending = true;
			}
		}
		for (const record of updated) {
			// Work created below a cancelled owner, even after its cascade, is aborted too.
			// 新任务若链未加载，reconcile 会加载后判断；否则直接检查其父链是否已取消。
			if (this.#unloaded.has(record.id)) this.#scheduleReconcile();
			else if (!record.background && !record.abortRequested && this.#belowCancelled(parentOf(record))) {
				this.#cascadePending = true;
			}
		}
		// A cascade that a reservation or step found pending runs with the next commit of any kind.
		// 有级联待处理：安排 reconcile；后续任一提交发布也会推进它。
		if (this.#cascadePending) this.#scheduleReconcile();
		// 发布末尾清理不再需要的所有权节点；必须在本轮读取完（dirty 已收集）之后。
		this.#sweep();
		// 没有任务变化时，空闲状态/可运行集合都不会变，无需结算与调度。
		if (!changed) return;
		// 结算受影响作用域的空闲等待者与上下文保留。
		this.#settleIdle(dirty);
		// 尝试运行上一轮后新出现的可运行任务。
		this.#kick();
	}

	/**
	 * Add the conversations above `record` to `scopes`: those whose idleness a change of it can change. False when a node
	 * on the way up is not known. A conversation already in `scopes` has everything above it there too.
	 */
	// 输入任务记录与作用域集合；把该任务上方的会话加入集合，返回是否完整走到根（没有 unknown）。
	// false 表示某条链未加载，调用方应降级为全量空闲检查；true 表示收集完整。
	// 例：任务属于会话 A、A 属于任务 B、B 属于会话 C，则加入 A、C。
	#addScopesAbove(record: AnyTaskRecord, scopes: Set<ConversationId>): boolean {
		for (const step of this.#above(parentOf(record))) {
			// 遇到未加载的 owner 边：无法确定上方作用域。
			if ("unknown" in step) return false;
			// 还在任务节点上，继续向上；只有到达会话节点才记录。
			if (!("conversation" in step)) continue;
			// 该会话已收集，其上方也已收集过，可以提前结束。
			if (scopes.has(step.conversation)) return true;
			scopes.add(step.conversation);
		}
		return true;
	}

	/**
	 * Extend each kept context range with the entries a stored commit appended to its conversation, so a later read
	 * needs no Storage scan. Entries are published in ID order.
	 */
	// 输入 stored 类型的提交；对已缓存上下文的会话，把新条目追加进其范围。
	// 无返回值；若范围已不连续/不匹配（advanceRange 返回 undefined）则丢弃该会话缓存，下次从存储重读。
	// 例：任务运行时缓存了 [1..10]，提交追加条目 11，缓存直接扩到 11，下次读取无需扫描存储。
	#advanceContexts(publication: Extract<ObservedCommit, { readonly kind: "stored" }>): void {
		// 没有任何缓存上下文时无需遍历提交。
		if (this.#contexts.size === 0) return;
		// 按会话分组本批新增条目，保持发布顺序（条目按 id 递增）。
		let appended: Map<ConversationId, EntryRecord[]> | undefined;
		for (const change of publication.changes) {
			// 只处理已缓存会话的条目变化。
			if (change.type !== "entry" || !this.#contexts.has(change.value.conversationId)) continue;
			appended ??= new Map();
			const entries = appended.get(change.value.conversationId);
			if (entries === undefined) appended.set(change.value.conversationId, [change.value]);
			else entries.push(change.value);
		}
		if (appended === undefined) return;
		for (const [conversationId, entries] of appended) {
			const kept = this.#contexts.get(conversationId)!;
			// An idle range past its retention is dropped here too: entry-only commits do not run `#settleIdle()`, and a
			// host may decline the expiry timer. `expiresAt` was fixed when it went idle, so no settings are read here.
			// 空闲超过保留期的上下文即使有新条目也丢弃：保留策略优先于缓存命中。
			if (kept.idleSince !== undefined && kept.expiresAt !== undefined && kept.expiresAt <= this.#now()) {
				this.#dropContext(conversationId);
				continue;
			}
			const range = advanceRange(kept.range, entries);
			// 范围无法扩展（例如缺条目/顺序不符）就丢弃，退回从 Storage 读取的保守路径。
			if (range === undefined) this.#dropContext(conversationId);
			else kept.range = range;
		}
	}

	/**
	 * `settings.contextRetentionMs`, or 0 when the host's settings throw. Kept contexts are only a cache, so dropping them
	 * is safe, while a throw here would escape commit listeners, reconciliation, and the expiry timer.
	 */
	// 无参数；返回上下文保留毫秒数。设置读取抛错时报告并按 0 处理（不保留任何缓存）。
	// 只读，不缓存：设置可以在运行中改变。
	#contextRetentionMs(): number {
		try {
			return this.#settings().contextRetentionMs;
		} catch (error) {
			// 缓存上下文只是优化；读取设置失败不能让提交监听器/定时器崩溃。
			this.#report(error, SETTINGS);
			return 0;
		}
	}

	/**
	 * After task changes below the conversations in `scopes` (every conversation when undefined): resolve their idle
	 * waiters and the Harness-wide ones, drop the kept contexts whose idle period passed the retention, then start or end
	 * the idle periods of the kept contexts in `scopes`. A task change can change the idleness only of the conversations
	 * above it, so no check visits every conversation.
	 */
	// 输入受影响的会话集合（undefined 表示全部）或无变化标记；无返回值。
	// 流程：决定是否全量检查 → 唤醒空闲等待者 → 先处理过期 → 再按忙碌/空闲状态更新 idleSince/expiresAt → 安排过期定时器。
	// 副作用：删除过期上下文、更新 #idleOrder/#idleNewest、resolve #idleWaiters。
	// 例：任务结束后，该任务的会话由忙变闲，idleSince=now、expiresAt=now+retention。
	#settleIdle(scopes: ReadonlySet<ConversationId> | undefined): void {
		// #unknownsChanged 表示链加载改变了空闲判断的输入，需要全量重查。
		const all = scopes === undefined || this.#unknownsChanged;
		this.#unknownsChanged = false;
		// 全量检查计数，测试可据此确认没有退化成逐任务扫描。
		if (all) this.#fullIdleChecks++;
		// 先唤醒已经满足的等待者；传入 undefined 表示检查全部空闲等待。
		this.#resolveIdleWaiters(all ? undefined : scopes);
		const now = this.#now();
		const retention = this.#contextRetentionMs();
		// Expired first: a context past its retention is dropped even when the same commit makes it busy again.
		// 先过期再判忙：即使同一提交让它重新变忙，超过保留期也必须丢弃。
		this.#expireContexts(now, retention);
		// 只遍历受影响的会话（或全部已缓存会话），不扫描 #live 中的每个任务。
		for (const conversationId of all ? [...this.#contexts.keys()] : scopes) {
			const kept = this.#contexts.get(conversationId);
			if (kept === undefined) continue;
			if (!this.#idle(conversationId)) {
				// 从空闲变忙：清除 idleSince 并从过期顺序中移除。
				if (kept.idleSince === undefined) continue;
				kept.idleSince = undefined;
				this.#idleOrder.delete(conversationId);
			} else if (retention <= 0) {
				// 不保留上下文：空闲即丢弃。
				this.#dropContext(conversationId);
			} else if (kept.idleSince === undefined) {
				// 首次观察到空闲：记录起点与固定过期时间（之后设置变化不改已定的 expiresAt）。
				kept.idleSince = now;
				kept.expiresAt = now + retention;
				this.#markIdle(conversationId, now);
			}
		}
		// 根据最早 idleSince 重新安排/取消后台过期定时器。
		this.#scheduleExpiry();
	}

	/** Resolve the idle waiters of the conversations in `scopes` (all when undefined) and the Harness-wide ones. */
	// 输入作用域集合或 undefined（全部）；resolve 已空闲的等待者，无返回值。
	// 只遍历等待者而不是全部会话：通常等待者很少。
	#resolveIdleWaiters(scopes: ReadonlySet<ConversationId> | undefined): void {
		for (const conversationId of this.#idleWaiters.keys()) {
			// 指定了作用域时跳过无关会话；undefined 的键表示等待整个 Harness，总是检查。
			if (conversationId !== undefined && scopes !== undefined && !scopes.has(conversationId)) continue;
			// 再次同步检查，确保此刻确实空闲（期间可能有新任务提交）。
			if (this.#idle(conversationId)) this.#idleWaiters.resolve(conversationId);
		}
	}

	/**
	 * Drop the kept contexts idle for at least `retention`, oldest first, with the retention setting of now; with no
	 * retention, every idle one, also those whose idle period a clock that went back makes start after now.
	 */
	// 输入当前时间与保留毫秒数；按最旧优先删除已过期（或 retention<=0 时全部空闲）的上下文，无返回值。
	// #idleOrder 保持有序，因此遇到第一个未过期项即可停止，无需继续遍历。
	#expireContexts(now: number, retention: number): void {
		for (const [conversationId, idleSince] of this.#idleOrder) {
			// retention<=0 表示不保留；否则未满保留期就停止（后面的都更新）。
			if (retention > 0 && now - idleSince < retention) return;
			this.#dropContext(conversationId);
		}
	}

	/**
	 * Start the idle period of a kept context in the expiry order. An idle period older than the newest one kept, which
	 * a clock that went back starts, sorts the order again, and the newest is taken from what is kept then.
	 */
	// 输入会话 id 与空闲起点；把它放到 #idleOrder 的正确位置，无返回值。
	// 正常时钟下 idleSince 递增，直接 append 即可；只有时钟回拨导致新值更旧时才整体重排。
	#markIdle(conversationId: ConversationId, idleSince: number): void {
		// 先删除旧位置，避免同一会话重复。
		this.#idleOrder.delete(conversationId);
		this.#idleOrder.set(conversationId, idleSince);
		// 首个元素或新值不小于已知最新值：插入尾部，顺序仍正确。
		if (this.#idleOrder.size === 1 || idleSince >= this.#idleNewest) {
			this.#idleNewest = idleSince;
			return;
		}
		// 时钟回拨：按 idleSince 升序重排，并更新 #idleNewest 为当前最大。
		const sorted = [...this.#idleOrder].sort((a, b) => a[1] - b[1]);
		this.#idleOrder.clear();
		for (const [id, since] of sorted) this.#idleOrder.set(id, since);
		this.#idleNewest = sorted.at(-1)![1];
	}

	/** Forget a kept context, idle or not, and its place in the expiry order. */
	// 输入会话 id；删除其上下文范围与过期顺序项，无返回值。不改变任务状态，只丢弃缓存。
	#dropContext(conversationId: ConversationId): void {
		this.#contexts.delete(conversationId);
		this.#idleOrder.delete(conversationId);
	}

	/**
	 * Drop the expired contexts when the earliest idle context expires, on a background timer, which never keeps the
	 * process alive. Where the host declines it, as the default does in Cloudflare Workers, none is kept: a pending timer
	 * could keep a Durable Object from being evicted, and eviction frees the contexts. There, task changes alone check
	 * expiry.
	 */
	// 无参数；确保存在“最早空闲上下文过期”的后台定时器，时间未变则不动。
	// 后台定时器不保持进程存活；宿主拒绝（返回 undefined）时不保留缓存（见类文档），只靠任务变更时检查。
	// 副作用：disarm 旧定时器、设新定时器；回调内清除自身并递归安排下一个。
	#scheduleExpiry(): void {
		// #idleOrder 的第一个值就是最早 idleSince；迭代器 done 表示没有空闲上下文。
		const oldest = this.#idleOrder.values().next();
		const at = oldest.done === true ? undefined : oldest.value + this.#contextRetentionMs();
		// 目标时间未变：现有定时器仍有效。
		if (this.#expiry !== undefined && this.#expiry.at === at) return;
		// 取消旧定时器（时间变了或不再需要）。
		this.#expiry?.disarm();
		this.#expiry = undefined;
		// 没有需要过期的上下文，或正在关闭：不设新定时器。
		if (at === undefined || this.#closing) return;
		const disarm = this.#timers.background(() => {
			// 定时器只能触发一次：先清空自身，再过期、再安排下一个。
			this.#expiry = undefined;
			this.#expireContexts(this.#now(), this.#contextRetentionMs());
			this.#scheduleExpiry();
		}, at - this.#now());
		// 宿主拒绝后台定时器时保持 undefined；上下文仍会因任务变更被检查。
		if (disarm !== undefined) this.#expiry = { at, disarm };
	}

	// ─── Ownership ───────────────────────────────────────────────────────────

	// 无参数、无返回值；把 #reconcile 安排到微任务，同一时刻只安排一次。
	// 只读/关闭状态下不安排：reconcile 需要写，只读提交会被拒绝并可能让 Session 失败。
	// 例：每次提交发布发现终态、cancel 标记、failFast 候选后调用。
	#scheduleReconcile(): void {
		// A read-only reconcile could only fail: what it writes is refused, and its own commits fail the Session.
		if (this.#reconcileScheduled || this.#closing || this.#readOnly) return;
		this.#reconcileScheduled = true;
		// queueMicrotask 避免在提交发布回调中同步重入 Session；void 表示不等待其 Promise。
		queueMicrotask(() => void this.#reconcile());
	}

	/**
	 * One commit that applies what committed records imply: abort marks below live owners with cancellation intent
	 * (spec §5.4), `failFast` marks (spec §5.5), withdrawn queued inputs below cancelled owners, and the final terminal
	 * record of every `completing` task whose ordinary owned work is gone. The durable records are the intent, so this
	 * also repairs whatever a crash left unapplied. Resolves idle waiters that the loaded edges decide.
	 */
	// 无参数；执行一轮 reconcile 提交并做空闲/过期收尾。
	// 提交内容：推导并写入 abort 标记 → 撤回被取消所有者下的排队输入 → finalize 可收尾的 completing 任务。
	// 副作用：一次 commitInternal、可能多次加载作用域/链；失败时调用 #failSession。
	// 错误：此提交内没有扩展代码，抛错视为存储/宿主回调/内部 bug，重跑不能修复，因此让 Session 失败。
	async #reconcile(): Promise<void> {
		// 安排标志先清除，允许本轮期间的新触发再安排下一轮。
		this.#reconcileScheduled = false;
		const work = this.#reconcileWork();
		// 有实际工作时计数，让 wake() 在本轮结束前保持 active（进程不能在这期间退出）。
		if (work) this.#reconcilingWork++;
		try {
			await this.#session.commitInternal(async (tx) => {
				// 关闭中不再写任何状态。
				if (this.#closing) return;
				// A cascade scans the queued inputs, which waits for every unpublished commit: a request made before the scan
				// is covered by it, and none is published while the job holds the line after it.
				// 级联需要扫描排队输入；loadScopes(true) 会等待所有未发布提交，保证“扫描前发出的请求”也被覆盖。
				const cascade = this.#cascadePending;
				const queued = await this.#loadScopes(cascade);
				// 扫描成功后再清除待处理标志，失败则下轮重试。
				if (cascade) this.#cascadePending = false;
				// 根据已提交记录推导本轮的取消标记。
				const marks = await this.#marks();
				for (const { record, reason } of marks.values()) tx.setTask(withAbortMark(record, reason));
				// 在决定区域判断哪些排队会话位于已取消所有者之下；读到未发布提交则重载作用域后重试。
				const withdrawn = await this.#region(
					() => queued.filter((id) => this.#belowCancelled({ conversation: id })),
					this.#reloadScopes,
				);
				for (const id of withdrawn) await this.#withdrawInputs(tx, id);
				// 收尾所有已无普通下属的 completing 任务；可能在同一事务写终态。
				await this.#finalize(tx);
			}, this.#context);
		} catch (error) {
			// No extension code runs in this commit: a throw is a storage failure, a host callback, or a bug. None is fixed by
			// running the pass again, so it fails the Session, which reports it.
			this.#failSession(error);
		}
		// 无论成功失败都递减计数并重新评估唤醒需求。
		if (work) this.#reconcilingWork--;
		this.#scheduleWake();
		// Its commit's task changes were settled at their publication; a waiter that asked for this pass checks again, and
		// what its chain loads resolved can make any scope idle.
		// 链加载可能把未知所有权变为已知，需要一次全量空闲结算。
		if (this.#unknownsChanged) {
			this.#settleIdle(undefined);
			return;
		}
		// 即使没有任务变化，等待者请求本轮检查，也可能现在满足。
		this.#resolveIdleWaiters(undefined);
		// A pass checks expiry too, for hosts that decline the expiry timer.
		// 不依赖后台定时器的宿主也会在每轮 reconcile 时清理过期上下文。
		this.#expireContexts(this.#now(), this.#contextRetentionMs());
		this.#scheduleExpiry();
	}

	/**
	 * The abort marks committed records imply (spec §5.4, §5.5): every live foreground task below a live owner with
	 * cancellation intent, which is its nearest one (a walk down from each owner with intent does not enter another,
	 * whose own walk covers what is below it), and every other live task in the `on` of a `failFast` waiter one of whose
	 * tasks failed. A cascade from an abandoned owner passes its `restart` reason on; any other intent marks, or upgrades
	 * a `restart` mark, as a request. Collected first, so a request wins over a `restart` mark of the same pass. Derived
	 * again on every pass, as loading edges can reveal a cancelled owner. Takes the `failFast` checks once its decision
	 * stands.
	 */
	// 无参数；返回 taskId -> { 记录, restart 原因 } 的待打标记集合。
	// 流程：在决定区域尝试规划；若缺少某些 failFast 成员记录，从 lineStorage 读终态后重试。
	// 副作用：从 #failFastChecks 删除已检查项；读存储但不写。
	// 例：取消所有者 A 下有前景任务 B，则返回 B（reason 可能为 restart）；failFast 等待者 W 的 on 中有失败任务时返回其余成员。
	async #marks(): Promise<Map<TaskId, { readonly record: AnyTaskRecord; readonly reason: "restart" | undefined }>> {
		// Terminal tasks in a checked `on`, read from Storage: each one's outcome is final.
		// 缓存已终态但不在 #live 的成员；null 表示存储中也不存在（视为已结束但无失败结果）。
		const ended = new Map<TaskId, AnyTaskRecord | null>();
		for (;;) {
			// 规划可能要求先读存储；若 #planMarks 返回 missing，则补齐后重试同一决定。
			const plan = await this.#region(() => this.#planMarks(ended), this.#reloadScopes);
			if ("missing" in plan) {
				for (const id of plan.missing)
					ended.set(id, (await this.#session.lineStorage.task(id, this.#context)) ?? null);
				continue;
			}
			// 决定成立后才消费 failFast 检查项，避免失败重试丢失候选。
			for (const id of plan.checked) this.#failFastChecks.delete(id);
			return plan.marks;
		}
	}

	/** `#marks()`' decision region; the `failFast` members it needs from Storage first, when `ended` lacks them. */
	// #marks() 的决定区域实现；输入已知终态成员缓存，返回 marks 或需要读取的 missing 列表。
	// 纯同步：只读 #live/#intent/#failFastChecks 与缓存，不写存储；调用方负责在区域外加载 missing。
	#planMarks(ended: ReadonlyMap<TaskId, AnyTaskRecord | null>):
		| { readonly missing: readonly TaskId[] }
		| {
				readonly marks: Map<TaskId, { readonly record: AnyTaskRecord; readonly reason: "restart" | undefined }>;
				readonly checked: readonly TaskId[];
		  } {
		const marks = new Map<TaskId, { readonly record: AnyTaskRecord; readonly reason: "restart" | undefined }>();
		// A mark rewrites the whole record, so the record it copies is read as a task record, keyed: a commit of the task
		// that is not published yet makes the region wait and run again, rather than stage a mark over a stale checkpoint.
		// 标记会整体重写记录；#liveRecord 记录读键，让未发布提交使整个决定区域重跑，避免基于旧 checkpoint 打标。
		const mark = (found: AnyTaskRecord, reason: "restart" | undefined): void => {
			const record = this.#liveRecord(found.id)!;
			const staged = marks.get(record.id);
			// 已有普通请求标记时不降级为 restart；restart 可以被普通请求覆盖。
			if (staged !== undefined && staged.reason === undefined) return;
			// 已有普通取消请求则无需再标；已有明确 reason（如 restart）时，只有升级为普通请求才处理。
			if (record.abortRequested && (record.abortReason === undefined || reason !== undefined)) return;
			marks.set(record.id, { record, reason });
		};
		// 读取消意图集合；其成员变化会改变本决定。
		this.#record(INTENT_KEY);
		for (const id of this.#intent) {
			const owner = this.#liveRecord(id)!;
			// Only an owner abandoned after a restart, and nothing else, passes its reason on.
			// 只有“因 restart 被放弃且自身没有失败结局”的所有者把 restart 原因传给下层；其他意图传 undefined。
			const restart = owner.abortReason === "restart" && !failedOutcome(owner);
			// enter 返回 false 时不进入另一个带意图的子树：它自己的遍历会覆盖其下层。
			for (const { node, live } of this.#walkDown(id, { enter: (below) => !this.#intent.has(below) })) {
				// 只标记前景存活任务；后台任务不随普通意图级联。
				if (live !== undefined && !node.background) mark(live, restart ? "restart" : undefined);
			}
		}
		// failFast 检查项在决定成立后才由 #marks 删除，因此这里可以安全遍历副本。
		const checked = [...this.#failFastChecks];
		const missing: TaskId[] = [];
		for (const id of checked) {
			const waiter = this.#liveRecord(id);
			// 已不在等待（例如已被取消/结束）：本轮无需检查。
			if (waiter?.state.status !== "waiting") continue;
			let failed = false;
			for (const member of waiter.state.on) {
				// 先读存活镜像，再读已知终态缓存；都没有则需要从 Storage 补。
				const record = this.#liveRecord(member) ?? ended.get(member);
				if (record === undefined) missing.push(member);
				// null 表示存储中不存在，不算失败。
				else if (record !== null && failedOutcome(record)) failed = true;
			}
			if (!failed) continue;
			// Every other live task: the failed one keeps its own outcome.
			// 有失败成员：标记 on 中其余存活任务，让它们也以取消结束；失败成员保留自己的结局。
			for (const member of waiter.state.on) {
				const record = this.#liveRecord(member);
				if (record !== undefined && !failedOutcome(record)) mark(record, undefined);
			}
		}
		// 有缺失记录时不返回半成品 marks：调用方补齐 ended 后重跑整个规划。
		return missing.length > 0 ? { missing } : { marks, checked };
	}

	/** Whether a reconcile pass would have work: a cascade to derive, held outcomes to check, or `failFast` waits. */
	// 无参数；返回下一轮 reconcile 是否有工作可做。只读三个候选集合/标志，不扫描任务。
	#reconcileWork(): boolean {
		return this.#cascadePending || this.#finalizeChecks.size > 0 || this.#failFastChecks.size > 0;
	}

	/**
	 * Write the terminal record of every `completing` task without live ordinary owned work. Finalizing one can free its
	 * owner, so this repeats over the commit's candidates until nothing changes. A held scheduler outcome gets its
	 * Harness cleanup here. In rounds, one decision region each: the holders the tasks of one round free are checked once,
	 * in the next, so a holder of many tasks that end together is walked once, not once per task. The first round takes
	 * the `completing` tasks to check once its decision stands.
	 */
	// 输入事务；反复按轮 finalize，直到没有新的可收尾持有者，无返回值。
	// 副作用：tx.setTask 写终态、更新本地 overlay、调用 settleOutcome 安排 Harness 清理。
	// 轮次处理让“多个同时结束的子任务”只触发其共同持有者一次检查，避免逐任务重复遍历。
	// 例：两个子任务同批结束，第一轮 finalize 它们，下一轮只检查共同所有者一次。
	async #finalize(tx: Transaction): Promise<void> {
		// 本事务中已经 finalize 的任务，防止重复处理与环。
		const done = new Set<TaskId>();
		// The commit's candidates, kept in step with the terminal records each round stages.
		// overlay 让本轮决定看到前面轮次暂存的终态，而不只是已提交状态。
		const overlay = overlayOf(tx);
		// round 为 undefined 表示第一轮，使用 #finalizeChecks；之后使用上一轮给出的 next。
		let round: readonly TaskId[] | undefined;
		for (;;) {
			const ids = round;
			// 在决定区域里规划本轮；候选或链变化时重载后重跑。
			const plan = await this.#region(
				() => this.#planRound(ids ?? [...this.#finalizeChecks], overlay, done),
				this.#reloadScopes,
			);
			// 第一轮决定成立后消费检查集合；后续轮次不会新增到它。
			if (ids === undefined) this.#finalizeChecks.clear();
			for (const { record, terminal } of plan.finalized) {
				// 先写事务与 overlay，再安排 Harness 清理；清理看到的是本次提交的终态。
				tx.setTask(terminal);
				(overlay.tasks as Map<TaskId, AnyTaskRecord>).set(record.id, terminal);
				done.add(record.id);
				const outcome = (record.state as { readonly outcome: TaskOutcome<JsonValue> }).outcome;
				// REMINDER: only the scheduler writes `faulted` and `orphaned` (spec §5.4); their cleanup waits for this commit.
				// 调度器自己写的 faulted/orphaned 需要 Harness 清理；任务代码写的 completed/failed 不需要。
				if (outcome.status === "faulted" || outcome.status === "orphaned") {
					await this.#settleOutcome(tx, record, outcome);
				}
			}
			// 没有新的上层持有者需要检查：完成。
			if (plan.next.length === 0) return;
			round = plan.next;
		}
	}

	/**
	 * One finalize round's decision: which of `ids` are `completing` without live ordinary owned work below them, in the
	 * commit's candidates with the round's own finalizations applied in order, and the holders above them to check next.
	 * Tasks finalized have no live work below them, so walks down skip them. It applies the round's terminal records to
	 * `overlay` while it decides and takes them back before it returns, so a run again starts from the same candidates.
	 */
	// 单轮 finalize 的决定；输入候选 id、提交覆盖层、已完成集合，输出本轮终态与下一轮候选。
	// 纯同步决定：先把本轮终态临时写入 overlay 供后续判断，最后在 finally 中恢复，保证重跑从同一候选开始。
	// 例：completing 任务没有普通存活下属时生成 terminal 记录；其上层若也在 completing，则加入 next。
	#planRound(
		ids: readonly TaskId[],
		overlay: Overlay,
		finalized: ReadonlySet<TaskId>,
	): {
		readonly finalized: readonly { readonly record: AnyTaskRecord; readonly terminal: AnyTaskRecord }[];
		readonly next: readonly TaskId[];
	} {
		const tasks = overlay.tasks as Map<TaskId, AnyTaskRecord>;
		// The tasks finalized so far, earlier rounds' and this one's, without copying the former.
		// round 只存本轮；done 组合早先轮次（finalized）与本轮，避免复制大集合。
		const round = new Set<TaskId>();
		const done = { has: (id: TaskId) => round.has(id) || finalized.has(id) };
		const ended: { readonly record: AnyTaskRecord; readonly terminal: AnyTaskRecord; readonly staged: boolean }[] =
			[];
		const next = new Set<TaskId>();
		try {
			for (const id of ids) {
				// 优先读提交暂存值（前面轮次/同一提交写入），否则读已提交镜像。
				const staged = tasks.get(id);
				const record = staged ?? this.#liveRecord(id);
				// 只处理仍在 completing 且本轮未处理的任务。
				if (record?.state.status !== "completing" || done.has(id)) continue;
				// 仍有普通存活下属：现在不能收尾。
				if (this.#hasOwnedLive(id, overlay, done)) continue;
				// 保持原 outcome，只把状态改为 terminal。
				const terminal = withState(record, { status: "terminal", outcome: record.state.outcome });
				tasks.set(id, terminal);
				round.add(id);
				ended.push({ record, terminal, staged: staged !== undefined });
				// 最近存活上方若也在 completing，它可能因本任务结束而可收尾。
				const above = this.#nearestLiveAbove(record, overlay);
				if (above?.state.status === "completing") next.add(above.id);
			}
		} finally {
			// 撤销本轮临时写入：staged 的恢复原值，非 staged 的删除（原记录仍在 #live）。
			for (const { record, staged } of ended) {
				if (staged) tasks.set(record.id, record);
				else tasks.delete(record.id);
			}
		}
		return { finalized: ended, next: [...next] };
	}

	/**
	 * Load the owner chains of the tasks in `#unloaded` and, with `queued`, of every conversation with queued inputs,
	 * on the Session line; returns the latter. Reads through the line's Storage, so it may run inside a commit callback.
	 */
	// 输入是否还要收集排队输入会话；返回有排队输入的会话 id 列表（queued=false 时为空数组）。
	// 先加载所有 #unloaded 任务的链；再扫描 queued 输入提交（无法键住，会等待全部未发布提交），并加载这些会话的链。
	// 副作用：安装所有权节点、pin 它们、可能安排 reconcile/sweep；只通过 lineStorage 读取。
	async #loadScopes(queued: boolean): Promise<ConversationId[]> {
		for (const id of [...this.#unloaded]) {
			// An earlier load in this loop may have passed it.
			// 前面的加载可能顺带把该任务标为已加载，跳过。
			if (this.#unloaded.has(id)) await this.#loadChain({ task: id });
		}
		if (!queued) return [];
		// A scan, which cannot be keyed: it waits for every unpublished commit.
		// 分页扫描所有排队提交；scanAll 隐藏 cursor 细节。
		const submissions = await scanAll((cursor) =>
			this.#session.lineStorage.scanSubmissions({ status: "queued" }, SCAN_PAGE_SIZE, cursor, this.#context),
		);
		// 只有输入类型会随取消被撤回；其他提交类型忽略。
		const inputs = submissions.filter((submission) => submission.type === "input");
		// 去重得到会话集合。
		const conversations = [...new Set(inputs.map((submission) => submission.conversationId))];
		// 加载这些会话的 owner 链，之后才能判断它们是否位于已取消所有者之下。
		for (const id of conversations) await this.#loadChain({ conversation: id });
		return conversations;
	}

	/**
	 * Load the owner edges and task nodes from `start` up to its ownerless root. A known task outside `#unloaded` ends the
	 * walk, as its chain is loaded; the `#unloaded` tasks passed have a loaded chain afterwards. Loading a node can reveal
	 * a cancelled owner, so it makes the next reconcile derive cascade marks. The nodes it installs stay until the job's
	 * commit is published (`#pin()`).
	 */
	// 输入起点（任务或会话）与可选覆盖层；沿 owner 边向上加载到无主根或已加载节点，无返回值。
	// 所有读取都经 lineStorage：未发布创建/结束会等待其发布，避免把“尚未可见”误判成“无主/不存在”。
	// 副作用：安装 #settled/#edges 节点、pin 它们、安排 reconcile；加载完成后从 #unloaded 删除经过的任务。
	// 例：加载任务 T 的链时依次读到 T 的 owner、其会话 owner，直到某个已加载任务或 owner=null 的会话。
	async #loadChain(start: Up, overlay?: Overlay): Promise<void> {
		// 本次经过的任务 id（用于最后标记已加载，以及判断空闲未知是否被解决）。
		const passed: TaskId[] = [];
		// 是否安装了新节点（需要 pin 到 job 结束）。
		let installed = false;
		let at: Up | undefined = start;
		try {
			while (at !== undefined) {
				if ("task" in at) {
					const id: TaskId = at.task;
					// 已知节点优先从存活/终态缓存取。
					let node: TaskNode | undefined = this.#live.get(id) ?? this.#settled.get(id);
					// Created in this commit: the load from its own record covers what is above it.
					// 本提交新建：记录自身已带 owner 字段，无需再从存储读它。
					if (node === undefined && overlay?.tasks.has(id) === true) break;
					// 已知且链已加载：上方链已完整，停止。
					if (node !== undefined && !this.#unloaded.has(id)) break;
					if (node === undefined) {
						// Through the line's Storage: a task whose creation or end is not published yet waits for it.
						// 从线上存储读取：会等待未发布的创建/结束提交。
						const record = await this.#session.lineStorage.task(id, this.#context);
						// 任务不存在：无法继续向上，直接返回。
						if (record === undefined) return;
						node = nodeOf(record);
						// 读到的终态任务只需保留所有权字段供遍历；pin 防止提交发布前被 sweep。
						if (record.state.status === "terminal") {
							this.#settle(id, node);
							this.#pin(id);
							installed = true;
						}
						// A loaded node can reveal a cancelling owner: the next reconcile derives marks again.
						// 新加载的 owner 链可能揭示取消意图，下一轮 reconcile 重新推导标记。
						this.#scheduleReconcile();
					}
					passed.push(id);
					at = parentOf(node);
				} else {
					// 会话节点：先查覆盖层/缓存的 owner 边。
					let edge = this.#edge(at.conversation, overlay);
					if (edge === undefined) {
						// Through the line's Storage: a conversation whose creation is not published yet waits for it, so a missing
						// record is never mistaken for an ownerless one.
						// 读取会话记录；不存在时 owner 视为 null（无主），但 lineStorage 已确保未发布创建被等待。
						const record = await this.#session.lineStorage.conversation(at.conversation, this.#context);
						edge = record?.owner?.taskId ?? null;
						this.#setEdge(at.conversation, edge);
						this.#pin(conversationNode(at.conversation));
						installed = true;
						// A loaded node can reveal a cancelling owner: the next reconcile derives marks again.
						this.#scheduleReconcile();
					}
					// null = 到达无主根，结束；否则继续沿 owner 任务向上。
					at = edge === null ? undefined : { task: edge };
				}
			}
		} finally {
			// `#idle()` counts a live task whose chain is not loaded as inside every scope it may be in: what this load
			// resolved, also when it stopped early, can make such a scope idle without a task change below it.
			// 即使提前 break/return，已解析的未知也可能让某作用域变为空闲，因此置位并安排全量检查。
			if (passed.some((id) => this.#live.has(id)) || (installed && this.#liveUnloaded())) {
				this.#unknownsChanged = true;
				// A waiter such a task held is checked again at the pass's end, also when this load was not a reconcile's.
				this.#scheduleReconcile();
			}
		}
		// 经过的任务链现在都已加载；从待加载集合移除。
		for (const id of passed) this.#unloaded.delete(id);
	}

	/** Whether a live task's chain is not loaded yet: one `#idle()` counts as inside every scope it may be in. */
	// 无参数；返回是否存在“存活但链未加载”的任务。只读 #unloaded 与 #live 的交集。
	#liveUnloaded(): boolean {
		for (const id of this.#unloaded) if (this.#live.has(id)) return true;
		return false;
	}

	// 输入会话 id 与其 owner（null 表示无主）；记录边并更新向下索引，无返回值。
	// 例：setEdge(7, 12) 让会话 7 挂在任务 12 下，并把它从根集合移出（若之前是根）。
	#setEdge(conversationId: ConversationId, owner: TaskId | null): void {
		this.#edges.set(conversationId, owner);
		// The conversation now hangs from its owner, or is a root; with nothing below it, it waits for the sweep.
		this.#relist(conversationNode(conversationId));
		this.#dropIfUnneeded(conversationNode(conversationId));
	}

	/** Know a terminal task a chain load read, so walks pass through it; its own chain is not loaded yet. */
	// 输入终态任务 id 与所有权节点；记录它以便遍历经过，并加入待加载集合（其上方链尚未读），无返回值。
	// 例：加载链时读到终态任务 T，settle(T) 后向上遍历仍能通过 T 找到其 owner。
	#settle(id: TaskId, node: TaskNode): void {
		this.#settled.set(id, node);
		this.#unloaded.add(id);
		this.#relist(id);
		this.#dropIfUnneeded(id);
	}

	/** Queue an ended task or a conversation for the sweep when nothing is listed below it. */
	// 输入节点；当它不是存活任务且 #below 中无子节点时加入删除队列，无返回值。
	#dropIfUnneeded(node: Node): void {
		// 存活的非会话节点仍需要保留。
		if (typeof node !== "string" && this.#live.has(node)) return;
		// 还有列出的下层工作：不能删。
		if (this.#below.has(node)) return;
		this.#dropQueue.add(node);
		this.#scheduleSweep();
	}

	/**
	 * Sweep in a job of its own on the Session line, after the operation underway: a rejected commit, one with nothing to
	 * write, and a read publish nothing, so the sweep at the end of `#observe` would not run for what they loaded.
	 */
	// 无参数、无返回值；安排一次独立的线上 sweep（在操作之后执行）。
	// 因为无写入/被拒绝的提交不会触发 #observe 末尾的 sweep，加载安装的节点需要这条独立路径清理。
	#scheduleSweep(): void {
		// 合并多次请求；关闭中不再安排。
		if (this.#sweepScheduled || this.#closing) return;
		this.#sweepScheduled = true;
		this.#session
			.readOnLine(async () => {
				// 先清标志，允许 sweep 期间新的请求再安排。
				this.#sweepScheduled = false;
				this.#sweep();
			})
			// Rejected only once the Session is closing or failed, when nothing is kept anyway.
			.catch(() => {});
	}

	/**
	 * Drop the queued nodes that are still unneeded: not live, nothing listed below. Runs once a publication is fully
	 * tracked, and as a job of its own on the line, never inside an operation: work a commit creates below a chain its
	 * own callback loaded keeps that chain. A flat loop: unlisting already queued every node on the way up that lost its
	 * last listed node.
	 */
	// 无参数、无返回值；删除队列中仍不需要的节点（不再有下层、无 pin）。
	// 会话节点删除 owner 边与根标记；终态任务删除 #settled/#unloaded。平面循环即可：
	// 取消列出的动作已经在 #relist 中把沿途失去最后一个子节点的父节点加入队列。
	#sweep(): void {
		for (const node of this.#dropQueue) {
			// Queued again once its pins go.
			// 已重新有下层或被 pin（待发布提交需要）：保留，pin 结束会再次入队。
			if (this.#below.has(node) || this.#pins.has(node)) continue;
			if (typeof node === "string") {
				// 会话节点：删除缓存边与根集合项。
				this.#edges.delete(conversationOf(node));
				this.#roots.delete(conversationOf(node));
			} else if (!this.#live.has(node)) {
				// 终态/已结束任务：删除遍历缓存；存活任务永远不在这里删除。
				this.#settled.delete(node);
				this.#unloaded.delete(node);
			}
		}
		this.#dropQueue.clear();
	}

	/**
	 * Run `decide`, a decision region (group commit §6): synchronous, reading scheduler memory and recording the keys it
	 * reads, staging nothing and changing no scheduler state. When a key it read has an unpublished writer, its result,
	 * or its error, is dropped: once that writer is published, `refresh` reloads what the region needs and it runs
	 * again. A waiting job holds the line, so unpublished writes only shrink, and the runs converge. What a region read
	 * that had no unpublished writer gets none for the rest of the job, so its result stands while the job applies it.
	 */
	// 输入同步决定函数 decide 与可选刷新函数 refresh；返回决定结果（或抛其错误）。
	// 循环：运行决定并记录读键 → 对每个键查未发布写者 → 无写者则结果有效；否则等待全部写者发布、refresh 后重跑。
	// 关键不变量：等待期间作业持有会话线，未发布写只会减少，因此循环收敛。
	// 决定函数必须同步且不产生副作用；refresh 用于重新加载链/作用域。
	async #region<T>(decide: () => T, refresh?: () => Promise<unknown>): Promise<T> {
		for (;;) {
			const keys = new Set<string>();
			// 设置 #reading，让 #record/#liveRecord/#edge 等把读键记入本次决定。
			this.#reading = keys;
			let result: { readonly value: T } | { readonly error: unknown };
			try {
				result = { value: decide() };
			} catch (error) {
				// 捕获后不立即抛：若读到未发布提交，错误也可能来自旧状态，应重跑。
				result = { error };
			} finally {
				// 无论成功失败都停止记录，防止 decide 之后的异步代码误记。
				this.#reading = undefined;
			}
			const gates: Promise<void>[] = [];
			for (const key of keys) {
				// touch 返回未发布写者的发布 Promise；没有写者时为 undefined。
				const gate = this.#session.touch(key);
				if (gate !== undefined) gates.push(gate);
			}
			if (gates.length === 0) {
				// 所有读到的键都已发布：决定在该快照上成立。
				if ("error" in result) throw result.error;
				return result.value;
			}
			// 等待写者发布并刷新决定依赖，然后重跑。
			await Promise.all(gates);
			await refresh?.();
		}
	}

	/** Load the chains a region walks, again after it waited: what was published meanwhile may list new work. */
	// 决定区域等待后重新加载未加载的任务链；只加载任务链，不扫描排队输入（false）。
	readonly #reloadScopes = (): Promise<unknown> => this.#loadScopes(false);

	/** In a decision region, note that it reads `key`; anywhere else, nothing. */
	// 记录读键；不在决定区域内时静默忽略，调用方无需区分上下文。
	#record(key: string): void {
		this.#reading?.add(key);
	}

	/** A live task's committed record, read by a decision region. */
	// 读取存活任务记录并记录其键；返回 undefined 表示该任务不在存活集合。
	// 例：区域决定读到任务被未发布提交更新时，#region 会等该提交后重跑。
	#liveRecord(id: TaskId): AnyTaskRecord | undefined {
		this.#record(taskKey(id));
		return this.#live.get(id);
	}

	/**
	 * Keep `node`, which a chain load of the job on the line installed, until that job's commit is published or fails:
	 * work it creates below the node needs it, and the sweep would drop it as unneeded before then.
	 */
	// 输入已安装节点；引用计数加一并注册作业结束回调，无返回值。
	// 作业结束（提交发布或失败）时计数减一；归零后重新评估是否可删除（可能再次入队）。
	// 例：一次链加载 pin 了会话节点，提交尚未发布时 sweep 不会删它；发布后回调再决定。
	#pin(node: Node): void {
		this.#pins.set(node, (this.#pins.get(node) ?? 0) + 1);
		this.#session.onJobEnd(() => {
			const count = this.#pins.get(node)! - 1;
			if (count > 0) {
				// 还有其他作业在使用该节点。
				this.#pins.set(node, count);
				return;
			}
			// 最后一个 pin 释放：从集合删除，再按当前下层情况决定是否入队。
			this.#pins.delete(node);
			this.#dropIfUnneeded(node);
		});
	}

	/**
	 * Bring the scheduler's sets in line with a task's committed record. A task that ended may free the nearest live task
	 * above it: one holding its outcome finalizes, an abort-marked one runs its abort handler; its waiters may run.
	 */
	// 输入上一版记录（可能 undefined）与最新已提交记录；同步 #live 与所有候选索引，无返回值。
	// 覆盖新增、状态变化、终态删除；终态时释放其上方持有者、唤醒等待者、更新向下索引。
	// 例：pending -> running 只更新 #live 与运行候选；running -> terminal 会从 #live 删除并结算活跃指标。
	#track(previous: AnyTaskRecord | undefined, record: AnyTaskRecord): void {
		const id = record.id;
		// 正在运行的 invocation 保留最新记录副本，供结束时写终态/报告。
		const invocation = this.#invocations.get(id);
		if (invocation !== undefined) invocation.record = record as TaskRecord<JsonValue, Checkpoint, JsonValue>;
		if (record.state.status === "terminal") {
			// 从存活到终态：活跃任务指标减一（关闭期间不再更新遥测）。
			if (previous !== undefined && !this.#closing) this.#countActive(-1, record.kind);
			this.#resumed.delete(id);
		} else if (previous === undefined && !this.#closing) {
			// 首次出现：活跃任务指标加一。
			this.#countActive(1, record.kind);
		}
		// 旧状态是 waiting：从反向等待索引移除其所有 on 依赖。
		if (previous?.state.status === "waiting") for (const on of previous.state.on) deleteFrom(this.#waiters, on, id);
		if (record.state.status === "terminal") {
			const node = nodeOf(record);
			// 终态任务不再参与任何调度候选。
			this.#live.delete(id);
			this.#sleeping.delete(id);
			this.#intent.delete(id);
			this.#runnable.delete(id);
			this.#finalizeChecks.delete(id);
			// 保留所有权字段供后续向上遍历。
			this.#settled.set(id, node);
			// Before anything is forgotten: the walk up to the task it held passes the ended tasks between them. Its chain is
			// loaded, as every commit that ends a task loads the chains of `#unloaded` first.
			// 先 release 再 relist/sweep：release 需要经过刚结束的任务找到其上方存活持有者。
			this.#release(node);
			// 等待它的任务现在可以重新尝试运行。
			for (const waiter of this.#waiters.get(id) ?? []) this.#runnable.add(waiter);
			this.#relist(id);
			this.#dropIfUnneeded(id);
			return;
		}
		// 存活状态：更新镜像。
		this.#live.set(id, record);
		// 新任务：若父链未知则标记未加载；并挂到向下索引。
		if (previous === undefined) {
			if (!this.#known(parentNode(record))) this.#unloaded.add(id);
			this.#relist(id);
		}
		// 取消意图集合：有意图（请求/restart/失败结局等）则加入，否则移除。
		if (cancellationIntent(record)) this.#intent.add(id);
		else this.#intent.delete(id);
		if (record.state.status === "completing") {
			// completing 不是可运行候选，而是待 finalize 检查。
			this.#runnable.delete(id);
			this.#finalizeChecks.add(id);
		} else {
			this.#runnable.add(id);
		}
		// waiting 记录登记到反向等待索引；状态离开 waiting 时由上面的旧记录清理。
		if (record.state.status === "waiting") for (const on of record.state.on) addTo(this.#waiters, on, id);
		// 睡眠任务进入/离开睡眠候选集。
		if (record.state.status === "sleeping") this.#sleeping.add(id);
		else this.#sleeping.delete(id);
	}

	/** The nearest live task above ended ordinary work may be free now: one holding its outcome, or an aborting one. */
	// 输入结束工作的所有权节点与（可选）覆盖层；返回最近的存活上方任务，无则 undefined。
	// 副作用：若上方在 completing，加入 finalize 检查；若上方已请求取消，加入运行候选（以启动 abort）。
	#release(node: TaskNode, overlay?: Overlay): AnyTaskRecord | undefined {
		const above = this.#nearestLiveAbove(node, overlay);
		// 持有结局的完成任务：可能因没有下属而可收尾。
		if (above?.state.status === "completing") this.#finalizeChecks.add(above.id);
		// 取消中的任务：等待的下层结束后可以执行 abort 处理器。
		else if (above?.abortRequested === true) this.#runnable.add(above.id);
		return above;
	}

	/**
	 * List `start` under its parent node in `#below` while it is a live task or has nodes listed below it, and unlist it
	 * otherwise; then its parent, as far up as that changes. So `#below` holds exactly the tree around live work; a
	 * parent that loses its last listed node is queued for the sweep. A loop, as ownership chains can be deeper than the
	 * call stack.
	 */
	// 输入起点节点；向上更新 #below/#roots，使索引恰好围绕存活工作，无返回值。
	// 每个节点“需要”当且仅当它是存活任务，或其 #below 仍列出子节点；不需要则从父集合删除，并继续向上传播。
	// 用循环而不是递归：所有权链可能很深，避免调用栈溢出。
	// 例：最后一个子任务结束后，父任务失去最后一个子节点 => 从任务父的集合删除，再继续检查任务父自身是否仍被需要。
	#relist(start: Node): void {
		let node: Node = start;
		for (;;) {
			// 节点是否需要保留在索引中。
			const needed = (typeof node !== "string" && this.#live.has(node)) || this.#below.has(node);
			let parent: Node | null | undefined;
			if (typeof node === "string") {
				// 会话节点的父 = 其 owner 任务；undefined 表示边未加载，null 表示无主。
				parent = this.#edges.get(conversationOf(node));
			} else {
				// 任务节点的父 = owner 任务或所属会话；未知任务直接停止。
				const known = this.#live.get(node) ?? this.#settled.get(node);
				if (known === undefined) return;
				parent = parentNode(known);
			}
			// 父边尚未加载：无法继续更新，等加载后再 relist。
			if (parent === undefined) return;
			if (parent === null) {
				// 无主会话：它自己就是根，按 needed 更新 #roots。
				const root = conversationOf(node as `c${number}`);
				if (needed) this.#roots.add(root);
				else this.#roots.delete(root);
				return;
			}
			// 父集合中该节点的存在状态已与 needed 一致：上方不会再变化，停止。
			if ((this.#below.get(parent)?.has(node) === true) === needed) return;
			if (needed) {
				// 父第一次获得子节点：继续向上，因为父现在也被需要。
				const first = !this.#below.has(parent);
				addTo(this.#below, parent, node);
				if (!first) return;
			} else {
				// 删除子节点；若父仍有其他子节点则上方不变，停止。
				deleteFrom(this.#below, parent, node);
				if (this.#below.has(parent)) return;
				// 父失去最后一个子节点：可能整条链都不再需要，入队并继续向上。
				this.#dropIfUnneeded(parent);
			}
			node = parent;
		}
	}

	/**
	 * The nearest live task above ended ordinary work `node`, in the overlay's view: the one that work held, if any. Work
	 * at or below a background task holds nothing above it.
	 */
	// 输入结束工作的节点与覆盖层；返回最近存活的上方任务或 undefined。
	// 规则：经过终态任务继续向上；到达后台任务即停（后台边界之上不持有普通工作）；owner=null 表示无主。
	#nearestLiveAbove(node: TaskNode, overlay?: Overlay): AnyTaskRecord | undefined {
		// 读取消意图集合会影响结果（cancellationIntent 依赖它），记录键。
		this.#record(INTENT_KEY);
		for (let current = node; !current.background; ) {
			// owner 字段优先；否则查会话边（undefined=未加载，null=无主）。
			const owner = current.owner ?? this.#edge(current.conversationId, overlay);
			if (owner === undefined || owner === null) return undefined;
			const record = overlay?.tasks.get(owner) ?? this.#liveRecord(owner);
			// 找到仍存活的上方任务：它就是“持有”该工作的节点。
			if (record !== undefined && record.state.status !== "terminal") return record;
			// 终态记录：用其所有权字段继续向上；没有记录时用 #settled 缓存。
			const above = record ?? this.#settled.get(owner);
			if (above === undefined) return undefined;
			current = above;
		}
		return undefined;
	}

	/** Whether the chain above `node` is loaded, without walking: known tasks outside `#unloaded` have a loaded chain. */
	// 输入节点；返回其上方链是否全部已加载。任务需已知且不在 #unloaded；会话需 owner=null 或 owner 链已知。
	// 纯查询，不加载；遇到未知即 false。递归深度等于会话/任务交替的链长，通常很浅。
	#known(node: Node): boolean {
		if (typeof node !== "string") {
			return (this.#live.has(node) || this.#settled.has(node)) && !this.#unloaded.has(node);
		}
		const owner = this.#edges.get(conversationOf(node));
		return owner === null || (owner !== undefined && this.#known(owner));
	}

	/** Owner task of a conversation, `null` when ownerless, `undefined` while not loaded. */
	// 输入会话 id 与可选覆盖层；返回 owner（null=无主，undefined=未加载）。
	#edge(id: ConversationId, overlay?: Overlay): TaskId | null | undefined {
		// 提交暂存边优先，且不需要记录读键（它属于当前事务）。
		if (overlay?.edges.has(id) === true) return overlay.edges.get(id);
		// 缓存边；记录键，未发布 owner 变更会让决定重跑。
		this.#record(conversationKey(id));
		return this.#edges.get(id);
	}

	// 输入任务 id 与覆盖层；按“暂存 -> 存活 -> 终态缓存”顺序取所有权字段，找不到返回 undefined。
	#node(id: TaskId, overlay?: Overlay): TaskNode | undefined {
		return overlay?.tasks.get(id) ?? this.#live.get(id) ?? this.#settled.get(id);
	}

	/** Walk up from `start`: owner tasks and conversations, ending at an ownerless root or an edge not loaded yet. */
	// 生成器：从 start 向上逐步产出任务节点/会话，遇到无主根或未加载边结束。
	// 不预先收集列表，调用方可提前 break（例如找到作用域/取消所有者就停）。
	// 每个任务节点先产出再走向其父；会话节点先产出再走向其 owner。
	// 例：任务 T -> 会话 C -> 任务 P -> 无主会话 R 会依次产出 T、C、P、R。
	*#above(start: Up, overlay?: Overlay): Generator<Step> {
		let at: Up | undefined = start;
		while (at !== undefined) {
			if ("task" in at) {
				const node = this.#node(at.task, overlay);
				// 任务知识未知：产出 unknown 并结束，调用方据此降级/加载链。
				if (node === undefined) {
					yield { unknown: true };
					return;
				}
				yield { task: at.task, node };
				at = parentOf(node);
			} else {
				yield { conversation: at.conversation };
				const edge = this.#edge(at.conversation, overlay);
				// owner 边未加载：unknown 结束。
				if (edge === undefined) {
					yield { unknown: true };
					return;
				}
				// null 表示无主：不再有上层。
				at = edge === null ? undefined : { task: edge };
			}
		}
	}

	/**
	 * The tasks below `start` that a walk down reaches: those `#below` lists and, under an overlay, the commit's new tasks,
	 * with its candidates in place of committed records. Background tasks are reached but not entered, unless
	 * `crossBackground`, and neither are the tasks `enter` rejects. A loop, as chains can be deeper than the call stack.
	 */
	// 图下方的遍历生成器：从 start 向下产出可达任务及其节点/存活记录。
	// 选项：overlay 用提交暂存值覆盖；crossBackground 决定是否进入后台任务；enter 可拒绝进入某子树。
	// 子节点来自 #below 与（overlay 下）新任务的补链 links；会话子节点继续入栈，任务子节点产出。
	// 例：取消会话时从会话节点遍历，遇到后台任务默认只产出不深入。
	*#walkDown(
		start: Node,
		options: {
			readonly overlay?: Overlay;
			readonly crossBackground?: boolean;
			readonly enter?: (id: TaskId) => boolean;
		} = {},
	): Generator<{ readonly id: TaskId; readonly node: TaskNode; readonly live: AnyTaskRecord | undefined }> {
		const { overlay, crossBackground = false, enter } = options;
		// 暂存新任务的补链只在有 overlay 时构建。
		const links = overlay === undefined ? undefined : this.#links(overlay);
		// 显式栈而非递归，支持任意深度链。
		const pending: Node[] = [start];
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			// 读该节点的子集会影响“下方是否有工作”的判断，记录键。
			this.#record(ownedKey(at));
			// 两个来源：已提交索引 #below 和暂存补链 links。
			for (const children of [this.#below.get(at), links?.get(at)]) {
				for (const child of children ?? []) {
					// 会话子节点没有任务记录，继续向下展开。
					if (typeof child === "string") {
						pending.push(child);
						continue;
					}
					const record = overlay?.tasks.get(child) ?? this.#live.get(child);
					const node = record ?? this.#settled.get(child);
					// 既无记录也无所有权缓存：索引过期，跳过。
					if (node === undefined) continue;
					// 只有非终态记录算存活；终态节点仍产出以便调用方知道结构，但 live 为 undefined。
					const live = record !== undefined && record.state.status !== "terminal" ? record : undefined;
					yield { id: child, node, live };
					// 后台任务默认作为边界不深入；enter 可进一步排除子树（如已 finalize 的任务）。
					if ((crossBackground || !node.background) && (enter === undefined || enter(child))) pending.push(child);
				}
			}
		}
	}

	/**
	 * The links walks down need for the commit's new tasks: each one under its parent node, then each node above it that
	 * `#below` does not list yet, until one it lists, a live task (always listed), or the chain's end.
	 */
	// 输入覆盖层；构建并缓存“暂存新任务”在 #below 中尚不存在的父链补丁，返回父 -> 子集合。
	// 对每个新任务，从它向父节点挂链，直到 #below 已列出的位置、存活任务（一定已列出）或链顶。
	// 副产物：写入 overlay.links，后续同一次提交内复用。
	#links(overlay: Overlay): ReadonlyMap<Node, ReadonlySet<Node>> {
		if (overlay.links !== undefined) return overlay.links;
		const links = new Map<Node, Set<Node>>();
		for (const record of overlay.tasks.values()) {
			// 已存在（存活或终态已知）的任务已在 #below 中，无需补链。
			if (this.#live.has(record.id) || this.#settled.has(record.id)) continue;
			let child: Node = record.id;
			let parent: Node | null | undefined = parentNode(record);
			// 向上挂链，直到命中已列出的父边/存活任务/根。
			while (parent !== undefined && parent !== null && links.get(parent)?.has(child) !== true) {
				addTo(links, parent, child);
				// 父是存活任务（或本提交暂存任务）：它已在 #below，停止。
				if (typeof parent !== "string" && (this.#live.has(parent) || overlay.tasks.has(parent))) break;
				let above: Node | null | undefined;
				if (typeof parent === "string") {
					// 会话节点：向 owner 任务继续。
					above = this.#edge(conversationOf(parent), overlay);
				} else {
					const fields = this.#settled.get(parent);
					above = fields === undefined ? undefined : parentNode(fields);
				}
				// 上层 #below 已列出该父节点：无需再补。
				if (above !== undefined && above !== null && this.#below.get(above)?.has(parent) === true) break;
				child = parent;
				parent = above;
			}
		}
		overlay.links = links;
		return links;
	}

	/**
	 * The live ordinary owned work of `owner` (spec §5.5): the live non-background tasks below it that a walk down reaches
	 * without entering a background task; with `first`, only the first. Candidates in `overlay` replace committed records;
	 * the walk does not enter tasks in `done`, which have none. Owner chains must be loaded.
	 */
	// 输入所有者任务 id 与选项；返回其“普通拥有的存活工作” id 列表。
	// 普通 = 非后台，且不进入后台边界；overlay 替换暂存记录；done 中的任务不进入（已 finalize，无存活下属）。
	// first=true 时找到第一个即停止，供 #hasOwnedLive 做布尔判断。
	#ownedLive(
		owner: TaskId,
		options: { readonly overlay?: Overlay; readonly first?: boolean; readonly done?: Finalized } = {},
	): TaskId[] {
		const { overlay, first = false, done } = options;
		const found: TaskId[] = [];
		const walk = this.#walkDown(owner, {
			// 条件展开：只在有 overlay/done 时传对应选项。
			...(overlay === undefined ? {} : { overlay }),
			...(done === undefined ? {} : { enter: (id: TaskId) => !done.has(id) }),
		});
		for (const { id, node, live } of walk) {
			// 终态节点或后台任务不算普通存活工作。
			if (live === undefined || node.background) continue;
			found.push(id);
			if (first) break;
		}
		return found;
	}

	// 输入所有者及可选覆盖层/已完成集合；返回是否存在普通存活下属。调用 #ownedLive(first=true)。
	#hasOwnedLive(owner: TaskId, overlay?: Overlay, done?: Finalized): boolean {
		const options = {
			first: true,
			...(overlay === undefined ? {} : { overlay }),
			...(done === undefined ? {} : { done }),
		};
		return this.#ownedLive(owner, options).length > 0;
	}

	/**
	 * Whether ordinary traversal from `scope` reaches `start`: walking up reaches the scope's conversation, or an
	 * ownerless one for `roots`, without crossing a background owner, unless `crossBackground`. `undefined` while an
	 * edge is not loaded.
	 */
	// 输入起点、作用域、是否跨后台；返回 true/false，链未知时 undefined。
	// 规则：向上找到作用域会话即 true；未跨后台时遇到后台所有者立即 false；到顶后 roots 作用域为 true。
	#inScope(start: Up, scope: Scope, crossBackground = false): boolean | undefined {
		// 读取消意图集合同样会影响“作用域”判断（cancellationIntent），记录键。
		this.#record(INTENT_KEY);
		for (const step of this.#above(start)) {
			// 未加载边：无法判断，返回 undefined 让调用方加载后重试。
			if ("unknown" in step) return undefined;
			if ("conversation" in step) {
				// 指定会话作用域：命中即在内。
				if ("conversation" in scope && step.conversation === scope.conversation) return true;
			} else if (step.node.background && !crossBackground) {
				// 后台边界：普通遍历不越过。
				return false;
			}
		}
		// roots 作用域：只要没被后台边界截断，到达任意根都算在内。
		return "roots" in scope;
	}

	/**
	 * Whether a live owner's cancellation intent reaches `start`: walking up finds an owner with intent before a
	 * background owner without it. Terminal owners never cascade (spec §5.4).
	 */
	// 输入起点；返回是否存在能到达它的已取消所有者。等价于 #cancellingOwner !== undefined。
	#belowCancelled(start: Up): boolean {
		return this.#cancellingOwner(start) !== undefined;
	}

	/** The nearest live owner above `start` whose cancellation intent reaches it, if any; see `#belowCancelled`. */
	// 输入起点；返回最近且能影响到它的存活取消所有者，或 undefined。
	// 没有取消意图时走快路径不遍历；遇到后台所有者即停止（意图不跨后台）。
	#cancellingOwner(start: Up): AnyTaskRecord | undefined {
		// 结果直接依赖意图集合，记录键。
		this.#record(INTENT_KEY);
		// Nothing cancels, the common case: no walk.
		if (this.#intent.size === 0) return undefined;
		for (const step of this.#above(start)) {
			// 链未知时不声称已取消（保守：不错误级联）。
			if ("unknown" in step) return undefined;
			// 会话节点本身没有取消意图，继续向上。
			if (!("task" in step)) continue;
			const live = this.#live.get(step.task);
			// 最近的所有者带意图：就是级联源。
			if (live !== undefined && cancellationIntent(live)) return live;
			// 后台边界阻止继续向上寻找意图。
			if (step.node.background) return undefined;
		}
		return undefined;
	}

	/**
	 * Count a task in or out of `pi.durable.tasks.active`. Commit observers count at a commit's publication, which must not
	 * throw, so a throwing adapter is reported.
	 */
	// 输入增量（+1/-1）与任务种类；更新活跃任务 gauge，无返回值。
	// 遥测适配器抛错时报告而不是传播：提交观察回调不能因此中断。
	#countActive(delta: 1 | -1, kind: string): void {
		try {
			this.#activeMetric.add(delta, { task: kind });
		} catch (error) {
			this.#report(error, TELEMETRY);
		}
	}

	/** Fail the Session, which reports it, for a throw in one of the scheduler's own commits; ignored once closing. */
	// 输入错误与可选 Context；把 Session 标为失败（由它报告），关闭后忽略。
	// 用于调度器自身提交/回调中的错误：重跑不能修复，继续运行只会产生不一致状态。
	#failSession(error: unknown, context?: Context): void {
		if (!this.#closing) this.#session.fail(error, context);
	}

	/** Close listener: runs synchronously once admission is sealed, before `join()`, or when the Session fails. */
	// 会话关闭监听器；同步执行，无返回值。在准入被封后、join() 之前运行，或 Session 失败时运行。
	// 流程：清零活跃指标 → 置关闭标志 → 解除注册表订阅 → 拒绝所有等待者 → 丢弃上下文缓存与定时器。
	// 例：close 后 waitForTask 的等待者立即收到 closedError，而不是永久挂起。
	#seal(): void {
		// 关闭时把仍存活的任务从 gauge 中扣除，保证指标不会残留。
		for (const record of this.#live.values()) this.#countActive(-1, record.kind);
		this.#resumed.clear();
		// 先置标志，后续回调看到关闭状态会停止安排新工作。
		this.#closing = true;
		try {
			// 解除函数本身可能抛错（第三方注册表）；报告后继续关闭。
			this.#unsubscribeRegistry();
		} catch (error) {
			this.#report(error, REGISTRY);
		}
		const error = closedError(this.#session);
		// 关闭后不会再有终态/空闲事件，拒绝所有等待者。
		this.#taskWaiters.rejectAll(error);
		this.#idleWaiters.rejectAll(error);
		// 丢弃派生缓存并取消过期/睡眠定时器。
		this.#contexts.clear();
		this.#idleOrder.clear();
		this.#expiry?.disarm();
		this.#expiry = undefined;
		this.#timer?.disarm();
		this.#timer = undefined;
	}

	/**
	 * Recompute the wake in a microtask the line never waits for, with no order relative to host commit listeners (one
	 * already queued serves later changes too): arm the built-in timer, or tell `onWake` of a change.
	 */
	// 无参数、无返回值；在微任务里重新计算 wake 并布置定时器/通知宿主。
	// 合并同一轮多次请求；关闭/只读时不安排。与宿主提交监听器无顺序保证（已排队的微任务会服务后续变化）。
	#scheduleWake(): void {
		if (this.#wakeScheduled || this.#closing || this.#readOnly) return;
		this.#wakeScheduled = true;
		queueMicrotask(() => {
			this.#wakeScheduled = false;
			// 排到微任务后可能已关闭。
			if (this.#closing) return;
			const wake = this.wake();
			if (this.#onWake === undefined) {
				// 没有宿主 onWake：调度启用后才用内置前景定时器等待最早睡眠；未启用时只保持 active。
				this.#armTimer(this.#enabled ? wake.at : undefined);
				return;
			}
			const last = this.#lastWake;
			// 值未变则不重复通知宿主（Wake 只有 active/at 两个字段）。
			if (last !== undefined && last.active === wake.active && last.at === wake.at) return;
			try {
				this.#onWake(wake);
				// Only a delivered wake counts: after a throw, the next change or kick offers it again.
				// 成功交付后才记录 #lastWake；失败时下次仍会重试同一值。
				this.#lastWake = wake;
			} catch (error) {
				this.#report(error, ON_WAKE);
			}
		});
	}

	/**
	 * Keep the timer for the earliest sleep. It keeps the process alive, unlike the context expiry timer: a process with a
	 * sleeping task has work left, such as a retry backoff. Rechecks the clock when it fires, so a wake before `until`
	 * only arms it again.
	 */
	// 输入最早睡眠时间或 undefined；维护一个前景定时器，无返回值。
	// 时间未变则复用；变化则先 disarm 再按需重设。前景定时器会保持进程存活（有睡眠任务就还有工作）。
	#armTimer(at: number | undefined): void {
		// 同一到期时间：现有定时器仍准确。
		if (this.#timer !== undefined && this.#timer.at === at) return;
		this.#timer?.disarm();
		this.#timer = undefined;
		// 无需等待或已关闭：不再设定时器。
		if (at === undefined || this.#closing) return;
		const disarm = this.#timers.foreground(() => {
			// 触发后先清自身，再唤醒到期任务并调度。
			this.#timer = undefined;
			this.#wakeDue();
			this.#kick();
		}, at - this.#now());
		this.#timer = { at, disarm };
	}

	/** Make every sleeping task whose time has come a reservation candidate. */
	// 无参数；把所有已到期的睡眠任务加入运行候选，无返回值。
	// #notDue 同时处理“已到期”和“已取消”两种情况：取消的睡眠也不再等待。
	#wakeDue(): void {
		for (const id of this.#sleeping) {
			const record = this.#live.get(id);
			if (record !== undefined && !this.#notDue(record)) this.#runnable.add(id);
		}
	}

	/**
	 * The report info of a task's failure, with the extension that installed its definition: the code that failed is
	 * that extension's. Built-in tasks have none.
	 */
	/** What a report about `task`'s own code says of it: the task, and the extension that installed its definition. */
	// 输入任务身份信息与可选 extension；返回报告用的 { task, extension? }。
	// 有 extension 字段就用它（invocation 预留时的安装者）；否则从当前注册表快照查安装者。
	// 注册表读取失败时省略扩展名：报告仍要发出，错误已由调度路径报告。
	#aboutTask(task: {
		readonly taskId: TaskId;
		readonly kind: string;
		readonly conversationId: ConversationId;
		/** The installer of the definition whose code ran (an invocation's); absent: the current one's. */
		readonly extension?: string | undefined;
	}): { readonly task: ReportTask; readonly extension?: string } {
		let extension: string | undefined;
		// "extension" in task 区分“明确传入（可能 undefined）”与“未传”。
		if ("extension" in task) extension = task.extension;
		else {
			try {
				const snapshot = this.#registry.snapshot();
				extension = installerOf(snapshot, snapshot.task(task.kind));
			} catch {
				// A registry that throws is reported where it is read for scheduling; a report goes out without the name.
			}
		}
		// optionalExtension 在无扩展名时省略键，保持报告形状干净。
		return { task: reportTask(task), ...optionalExtension(extension) };
	}

	/** `settings.restartLimit`, or the default when the host's settings throw. */
	// 无参数；返回重启上限。设置抛错时报告并使用 DEFAULT_RESTART_LIMIT，避免调度因设置故障停止。
	#restartLimit(): number {
		try {
			return this.#settings().restartLimit;
		} catch (error) {
			this.#report(error, SETTINGS);
			return DEFAULT_RESTART_LIMIT;
		}
	}

	// 无参数、无返回值；同步通知所有阻塞原因订阅者。
	// 先复制监听器列表，避免回调中增删订阅影响遍历；单个监听器抛错只报告，不阻断其他监听器。
	#notifyBlocked(): void {
		for (const listener of [...this.#blockedListeners]) {
			try {
				listener();
			} catch (error) {
				this.#report(error, { kind: "listener_error" });
			}
		}
	}

	/** A sleep whose `until` the clock has not reached; an abort mark ends a sleep. */
	// 类型谓词：输入任务记录；当且仅当仍在睡眠、未被取消、且 until 晚于当前时间时返回 true。
	// 同时把类型收窄为 sleeping 记录，调用方之后可直接访问 state.until。
	#notDue(
		record: AnyTaskRecord,
	): record is AnyTaskRecord & { readonly state: { readonly status: "sleeping"; readonly until: number } } {
		const state = record.state;
		return state.status === "sleeping" && !record.abortRequested && state.until > this.#now();
	}

	// 无参数、无返回值；标记有可运行工作，并在允许时安排一次异步 drain。
	// 总是先安排 wake 通知；drain 只在已启用、未关闭且未运行时安排，合并多次 kick。
	#kick(): void {
		this.#scheduleWake();
		this.#dirty = true;
		if (this.#draining || !this.#enabled || this.#closing) return;
		this.#draining = true;
		// Never commit synchronously from a commit or registry listener.
		// 微任务中 drain，避免在提交/注册表回调里同步提交。
		queueMicrotask(() => void this.#drain());
	}

	// 无参数；循环执行预留并启动任务，直到没有新的 dirty 标记。
	// 错误：预留提交内没有扩展代码，失败视为存储/内部错误，直接让 Session 失败。
	// 结束：清除 draining；若循环最后检查后又有 kick，再安排一轮。
	async #drain(): Promise<void> {
		try {
			while (this.#dirty && this.#enabled && !this.#closing) {
				// 先清 dirty：drain 期间新变化会重新置位并驱动下一轮。
				this.#dirty = false;
				// 一轮提交预留所有合格任务；每个预留成功后立即启动（不等待其他任务）。
				for (const reservation of await this.#reserve()) this.#start(reservation);
			}
		} catch (error) {
			// As in `#reconcile()`: the reservation commit runs no extension code.
			this.#failSession(error);
		} finally {
			this.#draining = false;
			// A wakeup that arrived after the loop's last check still needs its pass.
			if (this.#dirty) this.#kick();
		}
	}

	/**
	 * Reserve every eligible task in one commit; orphan abort-marked tasks no definition can take, unless abandoned after
	 * a restart. The first pass after open only abort-marks the abandoned tasks, so later passes see the marks.
	 */
	// 无参数；在一个提交里预留所有合格任务，返回待启动的 Reservation 列表。
	// 提交内容：处理 abandonOnRestart（第一轮只打 restart 标记并返回）→ 加载链/唤醒到期睡眠 →
	// 规划候选 → 对重启超限或不可接管者写终态/跳过 → 其余写 running 并创建 invocation。
	// 失败时回滚已创建 invocation（从 #invocations 删除、放回 #runnable、finish）后重新抛出。
	// 成功提交后，在提交外报告 restart_limit 故障；若刚处理过 abandoned，置 dirty 让下一轮看到标记。
	async #reserve(): Promise<Reservation[]> {
		const reservations: Reservation[] = [];
		// 已写 faulted 的任务，提交成功后才报告（提交失败则不报告）。
		const faulted: { readonly record: AnyTaskRecord; readonly message: string }[] = [];
		// 本轮处理过的 abandoned 任务，提交后从集合删除。
		let abandoned: TaskId[] = [];
		try {
			await this.#session.commitInternal(async (tx) => {
				// 关闭/未启用时不做预留。
				if (!this.#enabled || this.#closing) return;
				if (this.#abandoned.size > 0) {
					// 第一轮：只给未标记的 abandoned 任务打 restart 标记，然后直接返回；下一轮才正常预留。
					const ids = [...this.#abandoned];
					// 决定区域读记录，读到未发布提交会重试；只选未标记的。
					const unmarked = await this.#region(() =>
						ids
							.map((id) => this.#liveRecord(id))
							.filter((record) => record !== undefined && !record.abortRequested),
					);
					for (const record of unmarked) tx.setTask(withAbortMark(record!, "restart"));
					abandoned = ids;
					return;
				}
				// 预留在事务中可能需要读父链；先加载，避免把未知当无主。
				await this.#loadScopes(false);
				// Every pass picks up sleeps whose time has come: a pass started by any change may be the first to run after
				// a deadline, and the wake it schedules no longer keeps a timer for a due sleep.
				// 每轮都重新收集到期睡眠：任何变更触发的轮次都可能是到期后的第一轮。
				this.#wakeDue();
				// 决定区域规划：丢弃不需要的候选、判断级联、列出可运行记录。
				const plan = await this.#region(() => this.#planReservation(), this.#reloadScopes);
				for (const id of plan.dropped) this.#runnable.delete(id);
				// Work below an owner with cancellation intent waits for its cascade mark instead of running a phase; schedule
				// the cascade, which may not have run yet.
				// 有工作位于已取消所有者下：先安排级联标记，不直接运行。
				if (plan.cascade) {
					this.#cascadePending = true;
					this.#scheduleReconcile();
				}
				// Taken once per pass, and only when some task is a candidate.
				// 快照惰性获取：只有确实有候选任务时才读注册表。
				let snapshot: RegistrySnapshot | undefined;
				for (const record of plan.ready) {
					const id = record.id;
					// 有取消请求则执行 abort 处理器，否则执行正常 run。
					const mode = record.abortRequested ? "abort" : "run";
					// Work cut off `restartLimit` times in a row would run forever: an abort handler, or a phase of a kind that
					// does not end itself at the limit, ends the task `faulted` instead.
					// The settings are read only for a task that was cut off at all.
					// 只有确实被中断过的任务才读取设置；undefined 表示从未中断。
					const cutOff = record.restarts !== undefined && record.restarts >= this.#restartLimit();
					if (cutOff && (mode === "abort" || !this.#limitsRestarts(record.kind))) {
						// abort 处理器超限，或任务种类自身不处理上限：调度器直接写 faulted，避免无限重启。
						const message =
							mode === "abort"
								? `Abort handler of task ${id} (${record.kind}) was cut off ${record.restarts} times`
								: `Task ${id} (${record.kind}) was cut off ${record.restarts} times without progress`;
						await this.#terminate(tx, record, {
							status: "faulted",
							error: { message, detail: { reason: "restart_limit" } },
						});
						faulted.push({ record, message });
						continue;
					}
					// 第一个候选时才读取快照，之后整轮复用同一快照，保证定义一致。
					snapshot ??= this.#registry.snapshot();
					// 解析定义/版本/迁移；blocked 表示没有定义能接管。
					const resolution = this.#resolve(record, snapshot);
					if (resolution.kind === "blocked") {
						// An abandoned task waits for its definition, so its abort handler can clean up.
						// 普通取消（无 reason）且定义缺失：直接 orphaned；restart 放弃的任务则等待定义以便清理。
						if (mode === "abort" && record.abortReason === undefined) {
							await this.#terminate(tx, record, { status: "orphaned", reason: resolution.reason });
						}
						continue;
					}
					// 需要迁移或状态不是 running 时写 running；已 running 且记录未变则无需写。
					if (resolution.record !== record || record.state.status !== "running") {
						tx.setTask(
							withState(resolution.record, {
								status: "running",
								checkpoint: resolution.record.state.checkpoint,
							}),
						);
					}
					// Registered on the line, so marks and later reservations see it and close joins it; `#end` makes it a
					// candidate again.
					// 从候选集移除并登记 invocation；任务结束时 #end 会重新加入候选。
					this.#runnable.delete(id);
					const invocation = this.#createInvocation(record, mode, installerOf(snapshot, resolution.task));
					reservations.push({ invocation, task: resolution.task, snapshot });
				}
			}, this.#context);
		} catch (error) {
			// 提交失败：本轮创建的 invocation 尚未真正运行，必须撤销登记与等待者，避免泄漏。
			for (const { invocation } of reservations) {
				this.#invocations.delete(invocation.taskId);
				this.#runnable.add(invocation.taskId);
				invocation.finish();
			}
			throw error;
		}
		// 提交成功后才报告，保证报告与已落盘终态一致。
		for (const { record, message } of faulted) {
			this.#report(new Error(message), {
				kind: "task_faulted",
				...this.#aboutTask(recordTask(record)),
				reason: "restart_limit",
			});
		}
		// Marked, or already marked or gone: done with them. Reserve again, now seeing the marks.
		// 处理完的 abandoned 从集合移除；本轮只打了标记，需再跑一轮正常预留。
		for (const id of abandoned) this.#abandoned.delete(id);
		if (abandoned.length > 0) this.#dirty = true;
		return reservations;
	}

	/**
	 * A reservation pass's decision region: the candidates it drops (gone, holding, waiting, asleep, or with an
	 * invocation), whether one waits for a cascade, and the runnable records to resolve. Iterating the candidates is not
	 * keyed: a pass that misses a task a pending commit makes runnable only delays it, as does skipping one with an
	 * invocation without reading its record, or a waiter's check whether what it waits on is still live.
	 */
	// 无参数；返回本轮 { dropped, cascade, ready }。纯同步决定，不写状态。
	// dropped：已不该在候选集中的任务；cascade：发现有工作位于已取消所有者下；ready：可预留的运行记录。
	// 遍历候选集本身不键住：漏掉一个最新变为可运行的任务只会延后，不会破坏一致性。
	#planReservation(): {
		readonly dropped: readonly TaskId[];
		readonly cascade: boolean;
		readonly ready: readonly RunnableTaskRecord[];
	} {
		const dropped: TaskId[] = [];
		const ready: RunnableTaskRecord[] = [];
		let cascade = false;
		for (const id of this.#runnable) {
			// 已有运行中 invocation：重复候选，丢弃。
			if (this.#invocations.has(id)) {
				dropped.push(id);
				continue;
			}
			const record = this.#liveRecord(id);
			// It returns once what it waits for ends, its record changes, or the work below it ends; a sleep at the first pass
			// after its time comes, which the timer, `resume()`, or any change starts.
			// 已不存在、completing、仍在等待依赖、睡眠未到期的，都不能运行；它们会在状态变化时重新入候选。
			if (
				record === undefined ||
				record.state.status === "completing" ||
				this.#waitingOn(record, true).length > 0 ||
				this.#notDue(record)
			) {
				dropped.push(id);
				continue;
			}
			// 普通前景任务位于已取消所有者下：等级联标记，不运行阶段。
			if (!record.abortRequested && !record.background && this.#belowCancelled(parentOf(record))) {
				cascade = true;
				continue;
			}
			// 类型断言：已排除 undefined/completing（以及 waiting/sleeping 的非运行状态由上面条件覆盖）。
			ready.push(record as RunnableTaskRecord);
		}
		return { dropped, cascade, ready };
	}

	/**
	 * Live tasks a task waits for before its next invocation: its live ordinary owned work when abort-marked, since
	 * abort runs bottom-up, otherwise the live part of the `on` of a wait.
	 */
	// 输入任务记录与 first 标志；返回下一次调用前仍需等待的存活任务 id 列表。
	// 已标记取消：等待自己的普通存活子任务（abort 自底向上执行）；first 只取一个用于预检。
	// 普通等待：过滤 on 中仍存活的任务；非 waiting 状态返回空数组。
	#waitingOn(record: AnyTaskRecord, first = false): readonly TaskId[] {
		// 取消标记优先于普通等待：此时只等被拥有的工作结束。
		if (record.abortRequested) return this.#ownedLive(record.id, { first });
		if (record.state.status !== "waiting") return [];
		// 非首轮返回全部存活的依赖，调度器需等它们全部结束。
		if (!first) return record.state.on.filter((id) => this.#live.has(id));
		// 首轮只需知道“是否还有活依赖”，因此取第一个即可。
		const live = record.state.on.find((id) => this.#live.has(id));
		return live === undefined ? [] : [live];
	}

	/** Resolve the record's definition by kind, migrating an older stored version. */
	// 输入可运行记录与注册表快照；返回 ready（可能带迁移后的记录）或 blocked。
	// 版本相同直接 ready；旧记录调用定义 migrate（可能执行任务代码），成功则复制迁移后的 input/checkpoint。
	// 迁移抛错时缓存失败、异步通知阻塞订阅者、安排唤醒并报告，返回 migration_failed。
	#resolve(record: RunnableTaskRecord, snapshot: RegistrySnapshot): Resolution {
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", reason: fit.reason };
		if (!fit.migrates) return { kind: "ready", task: fit.task, record };
		const definition = erased(fit.task);
		try {
			// 缺失 migrate 视为声明无法接管；用统一错误构造，便于报告 detail。
			if (definition.migrate === undefined) throw missingMigration(record, definition);
			// 迁移可能执行扩展代码；输入是记录中的旧 input/checkpoint/version。
			const migrated = definition.migrate(record.input, record.state.checkpoint, record.version);
			// 复制迁移结果，避免任务代码持有的对象与调度器记录共享可变引用。
			const state = { ...record.state, checkpoint: copyJson(migrated.checkpoint) };
			const migratedRecord = { ...record, version: definition.version, input: copyJson(migrated.input), state };
			return { kind: "ready", task: fit.task, record: migratedRecord as RunnableTaskRecord };
		} catch (error) {
			// 缓存“该任务 + 该定义”的失败；定义变化前不重试。
			this.#failedMigrations.set(record.id, { task: fit.task, error });
			// Blocked now without a commit: the graph and the host's wake must hear it.
			// 没有提交发生，因此手动通知阻塞监听者并安排唤醒，让任务图/宿主看到新阻塞原因。
			queueMicrotask(() => this.#notifyBlocked());
			this.#scheduleWake();
			const extension = installerOf(snapshot, fit.task);
			this.#report(error, { kind: "migration_failed", ...this.#aboutTask({ ...recordTask(record), extension }) });
			return { kind: "blocked", reason: "migration_failed" };
		}
	}

	// 输入记录的身份/版本与快照中的任务定义；返回能否接管及是否需要迁移。
	// 纯声明检查，不运行 migrate；同一任务 + 同一失败定义直接返回缓存错误，避免重复报告/重试。
	#fit(record: Pick<AnyTaskRecord, "id" | "version">, task: AnyTask | undefined): Fit {
		if (task === undefined) return { reason: "missing_task" };
		const version = task.definition.version;
		// 版本相同：无需迁移。
		if (version === record.version) return { task, migrates: false };
		// 定义版本比记录旧：不能降级接管。
		if (version < record.version) return { reason: "task_too_old" };
		// 新定义此前迁移失败：直接报告同一原因，除非注册表换成另一个对象。
		const failed = this.#failedMigrations.get(record.id);
		if (failed?.task === task) return { reason: "migration_failed", error: failed.error };
		return { task, migrates: true };
	}

	/** Sizes of the ownership indexes, for tests that bound the scheduler's memory. */
	// 只读诊断 getter：返回各索引规模；below 统计的是子边总数，不是父节点数。
	// 每次访问都遍历 #below，属于测试诊断路径，不在热路径使用。
	get indexSizes(): Readonly<
		Record<"live" | "settled" | "edges" | "below" | "roots" | "unloaded" | "dropQueue" | "pins", number>
	> {
		let below = 0;
		for (const children of this.#below.values()) below += children.size;
		return {
			live: this.#live.size,
			settled: this.#settled.size,
			edges: this.#edges.size,
			below,
			roots: this.#roots.size,
			unloaded: this.#unloaded.size,
			dropQueue: this.#dropQueue.size,
			pins: this.#pins.size,
		};
	}

	/**
	 * The kept contexts' idle state, for tests (a diagnostic, computed on demand): how many are kept and how many are
	 * idle, how many disagree with a full recompute (an idle period without `#idle()`, or `#idle()` without one; an
	 * expiry order that differs from the idle periods, or is not sorted), and how many idle checks covered every scope.
	 */
	// 只读诊断 getter：现算 kept contexts 的空闲一致性，返回计数对象。
	// idleMismatches 检测四类不一致：idleSince 与 #idle() 不符、#idleOrder 与 idleSince 不符、顺序未排序。
	// 仅供测试；每次访问全量扫描 #contexts/#idleOrder。
	get idleState(): Readonly<Record<"contexts" | "idleContexts" | "idleMismatches" | "fullIdleChecks", number>> {
		let mismatches = 0;
		let idle = 0;
		for (const [conversationId, kept] of this.#contexts) {
			// idleSince 有值表示缓存认为它空闲。
			if (kept.idleSince !== undefined) idle++;
			// 缓存的空闲状态应与重新计算 #idle() 一致。
			if ((kept.idleSince !== undefined) !== this.#idle(conversationId)) mismatches++;
			// 过期顺序中的值应与上下文记录一致。
			if (this.#idleOrder.get(conversationId) !== kept.idleSince) mismatches++;
		}
		// 单独遍历 #idleOrder 检查升序与双向一致。
		let previous = Number.NEGATIVE_INFINITY;
		for (const [conversationId, idleSince] of this.#idleOrder) {
			if (idleSince < previous || this.#contexts.get(conversationId)?.idleSince !== idleSince) mismatches++;
			previous = idleSince;
		}
		return {
			contexts: this.#contexts.size,
			idleContexts: idle,
			idleMismatches: mismatches,
			fullIdleChecks: this.#fullIdleChecks,
		};
	}

	/**
	 * Scheduling state and every live task with its derived state, read on the Session line. Runs no task code: a
	 * pending migration shows as `ready` with `migrates`, and only a migration the scheduler already tried, or one that
	 * cannot exist, shows as failed.
	 */
	// 输入注册表快照；返回调度状态与每个存活任务的派生状态（只读，不执行任务代码）。
	// 等待已发布提交并加载链后遍历 #live；inspect 的 state 可能显示 ready+migrates，但不实际迁移。
	// 例：一个 pending 且定义版本更新的任务显示为 pending，migrates:true；迁移已失败则 blocked。
	async inspect(
		snapshot: RegistrySnapshot,
	): Promise<{ scheduling: HarnessInspection["scheduling"]; tasks: TaskInspection[] }> {
		// 保证读到已发布状态；inspect 不在会话线上，但需要与提交保持一致。
		await this.#published();
		// 加载未加载的链，让 waiting/completing 判断准确。
		await this.#loadScopes(false);
		const tasks: TaskInspection[] = [];
		for (const record of this.#live.values()) tasks.push({ record, state: this.#inspectTask(record, snapshot) });
		// 关闭优先于启用：关闭后即使 enabled 仍为 true 也显示 closing。
		const scheduling = this.#closing ? "closing" : this.#enabled ? "running" : "paused";
		return { scheduling, tasks };
	}

	// 输入记录与快照；按优先级派生出 inspect 状态：running > completing > waiting > sleeping > blocked > pending。
	// 纯读，不改变调度器状态。blocked 三因由 #fit 给出；缺失 migrate 视为 migration_failed。
	#inspectTask(record: AnyTaskRecord, snapshot: RegistrySnapshot): TaskInspection["state"] {
		// 有活动 invocation（run 或 abort）即视为 running。
		if (this.#invocations.has(record.id)) return { kind: "running" };
		if (record.state.status === "completing") return { kind: "completing" };
		// 普通等待依赖的存活部分；非空表示仍在等待。
		const on = this.#waitingOn(record);
		if (on.length > 0) return { kind: "waiting", on };
		// 睡眠未到期：显示 until。
		if (this.#notDue(record)) return { kind: "sleeping", until: record.state.until };
		// 定义检查；reason 存在即 blocked。
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", ...fit };
		// 需要迁移但没有钩子：显示为 blocked，错误对象说明缺少 migrate。
		if (fit.migrates && fit.task.definition.migrate === undefined) {
			return { kind: "blocked", reason: "migration_failed", error: missingMigration(record, erased(fit.task)) };
		}
		// 可运行/可迁移：显示 pending，附 migrates 标志。
		return { kind: "pending", migrates: fit.migrates };
	}

	// 输入记录、模式与安装扩展名；创建并在 #invocations 登记 invocation，返回它。
	// 新 AbortController 及其派生 Context；startedAt 为 undefined（新启动）时继承记录里的 telemetry links。
	// 副作用：登记 #invocations；调用方负责启动（#start）和结束清理。
	#createInvocation(record: RunnableTaskRecord, mode: "run" | "abort", extension: string | undefined): Invocation {
		const controller = new AbortController();
		// Promise.withResolvers 同时取得 Promise 和 resolve，供 finish 使用。
		const { promise: done, resolve: finish } = Promise.withResolvers<void>();
		const invocation: Invocation = {
			taskId: record.id,
			kind: record.kind,
			extension,
			conversationId: record.conversationId,
			mode,
			controller,
			// 只有新启动（没有 startedAt）才继承 links；恢复运行不重复链接旧 trace。
			links: record.startedAt === undefined ? record.links : undefined,
			// Context 在根调度上下文上附加本次 controller.signal；取消会向下传播。
			context: withAbortSignal(controller.signal, this.#context),
			record: record as TaskRecord<JsonValue, Checkpoint, JsonValue>,
			watches: new Set(),
			timers: new Set(),
			ended: false,
			done,
			finish: () => finish(),
		};
		this.#invocations.set(record.id, invocation);
		return invocation;
	}

	// 输入预留；同步启动一个异步执行链，无返回值（错误通过报告处理）。
	// 流程：run/runAbort → 捕获意外错误报告 → finally 清理 invocation、释放记录/links/fault、完成 done、再次 kick。
	#start(reservation: Reservation): void {
		const invocation = reservation.invocation;
		// void 表示调用方不等待；执行链自身处理错误，不会产生未处理拒绝。
		void (async () => {
			try {
				if (invocation.mode === "run") await this.#run(reservation);
				else await this.#runAbort(reservation);
			} catch (error) {
				// 到达这里的错误是调度链自身的意外错误（阶段错误已在 #step 中转为终态）。
				this.#report(error, { kind: "task_error", ...this.#aboutTask(invocation) }, invocation.context);
			} finally {
				// #end 负责把任务从运行索引移除并判断是否需要重新入候选。
				this.#end(invocation);
				// 释放可能很大的记录/telemetry 引用，避免 invocation 结束后仍占用内存。
				invocation.record = undefined;
				invocation.links = undefined;
				invocation.fault = undefined;
				invocation.finish();
				// 任务结束后状态变化可能让其他任务可运行。
				this.#kick();
			}
		})();
	}

	/** Run phase handlers, each preceded by a step that decides on the line whether the invocation continues. */
	// 输入预留；执行 run invocation 直到 #step 返回 undefined 或关闭，无返回值。
	// 流程：初始 #step 应用规则 → 循环：包装 phase span 执行处理器 → 处理器返回后再次 #step 决定下一步。
	// state 保存当前任务定义与快照，供运行时在阶段内读取；每个阶段重新解析 agent（定义可能已替换）。
	async #run(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		// reported 记录已报告过“旧定义继续运行”的替换定义，避免每阶段重复报告。
		const state = { task: reservation.task, snapshot: reservation.snapshot, reported: undefined as ReportedTask };
		// Phase 的 snapshot/task 是闭包：调用时读取 state 的最新值，而不是构造时快照。
		const phase: Phase = { snapshot: () => state.snapshot, task: () => state.task, agent: undefined };
		const runtime = this.#runtime(invocation, phase);
		// progress 回调在 #step 的决定成立后执行，记录/判断是否取得持久进展。
		const progress = (tx: Transaction, current: ErasedRunningTask) =>
			this.#progress(tx, current, state, invocation.extension, invocation.context);
		// 第一次 step 没有上一阶段结果，因此 rules 的 previous 为 undefined。
		let current = await this.#step(invocation, (task) => this.#rules(task, undefined), progress);
		while (current !== undefined && !this.#closing) {
			const task = current;
			// #phase 负责 telemetry span 与 context 绑定；回调内执行具体阶段处理器。
			current = await this.#phase(invocation, task, async () => {
				const checkpoint = task.state.checkpoint;
				// Each phase handler resolves its agent afresh, at first use.
				// 每个阶段清空 agent 缓存：阶段间定义可能被替换，运行时按需重新解析。
				phase.agent = undefined;
				let previous: PhaseResult;
				try {
					// 阶段名来自 checkpoint.phase；phases 的定义在当前任务定义里，缺失会是运行时错误。
					await erased(state.task).phases[checkpoint.phase]!(task, runtime, invocation.context);
					// 正常返回：checkpoint 未变，后续 #rules 会判断是否“没有持久进展”。
					previous = { checkpoint };
				} catch (error) {
					// 阶段抛错不直接在任务代码处处理，而是交给决定区域转成 fault。
					previous = { checkpoint, failure: { error } };
				}
				// 阶段后的 step：决定继续/结束/fault；progress 只在决定成立后执行。
				return this.#step(invocation, (next) => this.#rules(next, previous), progress);
			});
		}
	}

	/** A phase owns its decision commit, not the next handler, a durable wait, or recovery. */
	// 输入 invocation、当前任务与执行回调；返回回调的 Promise，并为其套一层 phase span。
	// 副作用：临时替换 invocation.context 为带 span 的 Context，结束时恢复；记录耗时指标与 span 状态。
	// 错误：回调错误原样抛出；finally 先恢复 context 再写 telemetry，因此记录失败不影响错误传播。
	// 流程：选取父 span → 创建 pi.durable.phase span（含 attempt/resumed 属性）→ 附加 links →
	// 安装 span 到 context → 执行 run → finally 根据终态/等待/关闭推导 outcome 并落 span 与指标。
	#phase<T>(invocation: Invocation, task: ErasedRunningTask, run: () => Promise<T>): Promise<T> {
		// 有记录的 trace 时尝试恢复其父上下文；无法恢复则退回调度器根 telemetry。
		const parent =
			task.trace === undefined
				? this.#telemetry
				: (this.#telemetry.propagation?.extract(task.trace) ?? this.#telemetry);
		const checkpoint = task.state.checkpoint;
		const attempt = checkpoint.attempt;
		// #resumed 标记任务在本次进程中被首次装载；第一个 phase 用 delete 查询并消费它，写进 span 的 resumed 属性。
		const resumed = this.#resumed.delete(task.id);
		return createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])(
			"pi.durable.phase",
			{
				"task.id": task.id,
				"task.name": task.kind,
				phase: checkpoint.phase,
				kind: invocation.mode,
				resumed,
				// attempt 只在定义检查点时出现；条件展开避免写入 undefined 属性。
				...(attempt === undefined ? {} : { attempt }),
			},
			async (span) => {
				// links 记录跨进程/跨阶段因果（如恢复前 trace），只在支持传播时附加。
				if (span.propagation !== undefined && invocation.links !== undefined) {
					for (const carrier of invocation.links) span.addLink({ context: span.propagation.extract(carrier) });
				}
				// 保存旧 context，确保嵌套调用结束后恢复，而不是永久替换调用方的上下文。
				const previous = invocation.context;
				invocation.context = withTelemetry(span, previous);
				const started = performance.now();
				try {
					return await run();
				} finally {
					invocation.context = previous;
					// record 在调用期间保持有效；这里只读最新已提交状态来推导 span outcome。
					const state = invocation.record!.state;
					const terminal =
						invocation.fault ??
						(state.status === "terminal" || state.status === "completing" ? state.outcome : undefined);
					// 有终态时按结果映射；否则按等待/睡眠、关闭、继续下一阶段分别标记。
					const outcome =
						terminal !== undefined
							? terminal.status === "completed"
								? "done"
								: terminal.status === "aborted"
									? "aborted"
									: "faulted"
							: state.status === "waiting" || state.status === "sleeping"
								? state.status
								: invocation.ended || this.#closing
									? "aborted"
									: `next=${state.checkpoint!.phase}`;
					span.setAttributes({ outcome });
					// faulted/failed/orphaned 记为错误状态；消息截断到 500 字符限制 span 体积。
					if (terminal?.status === "faulted" || terminal?.status === "failed" || terminal?.status === "orphaned") {
						const message = terminal.status === "orphaned" ? terminal.reason : terminal.error.message;
						span.setStatus({
							status: "error",
							error: { name: `task_${terminal.status}`, message: ownedSlice(message, 0, 500) },
						});
					} else if (outcome === "aborted") {
						// 主动取消属于正常结束，不标红。
						span.setStatus({ status: "ok" });
					}
					// 指标标签用任务名/阶段/结果；span 作为记录上下文，便于关联到同一 trace。
					this.#durationMetric.record(
						performance.now() - started,
						{ task: task.kind, phase: checkpoint.phase, outcome },
						span,
					);
				}
			},
		);
	}

	/**
	 * Precedence rules for a run invocation, a decision region of its step. Rules 1 (terminal, `completing`, `waiting`, or
	 * `sleeping`) and 2 (closing) are applied by `#step`. Progress (rule 5) is decided by `#progress()` once the decision
	 * stands, as it takes a registry snapshot.
	 */
	// 输入当前运行任务与上一阶段结果；返回本次 step 的计划（continue/progress/end/cascade/fault 之一）。
	// 纯决策函数，不写事务；规则 1/2 已由 #step 处理。规则：取消标记结束、所有者取消级联、
	// 未捕获错误 fault、checkpoint 未变则“无持久进展” fault，否则 progress。
	#rules(current: ErasedRunningTask, previous: PhaseResult | undefined): StepPlan {
		// 3. abort mark: end; a fresh abort invocation starts once the task's ordinary owned work is gone.
		// 有持久取消标记：结束普通 run，稍后由 abort invocation 处理清理。
		if (current.abortRequested) return END;
		// An owner's cancellation intent ends it too, before its cascade marks it; reservation then holds it back.
		// 祖先已取消：标记级联，而不是直接写终态；随后由预留过滤阻止继续运行。
		if (!current.background && this.#belowCancelled(parentOf(current))) return CASCADE;
		// 第一次 step 没有上一阶段，直接继续执行阶段处理器。
		if (previous === undefined) return CONTINUE;
		// 4. uncaught error.
		// 阶段抛出的错误转成 fault；这里不区分错误类型，任务代码需自行处理可恢复错误。
		if (previous.failure !== undefined) return { kind: "fault", error: previous.failure.error };
		// 6. no durable progress.
		// 阶段正常返回但 checkpoint 与进入时完全相同：视为没有持久进展，防止死循环。
		if (jsonEqual(current.state.checkpoint, previous.checkpoint)) {
			const message = `Task ${current.kind} phase ${previous.checkpoint.phase} returned without durable progress`;
			return { kind: "fault", error: new Error(message) };
		}
		// 取得了进展：下一步会走 #progress 的注册表刷新与定义交接。
		return PROGRESS;
	}

	/**
	 * Rule 5, progress: refresh the snapshot; hand over to a replacement definition that can take the task, writing it
	 * back as `pending`, or keep running under the old one, reported once per resolved definition. Returns whether the
	 * invocation continues.
	 */
	// 输入事务、当前任务、run 级状态、扩展名与 context；返回 invocation 是否继续。
	// 副作用：可能把新定义能接管的记录写回 pending（事务内），或报告 task_outdated；不直接提交。
	// 流程：刷新快照 → 取同 kind 的新定义 → 未变继续；可接管则写 pending 并结束本次 invocation；
	// 否则保持旧定义继续跑，每个新定义只报告一次。
	#progress(
		tx: Transaction,
		current: ErasedRunningTask,
		state: { task: AnyTask; snapshot: RegistrySnapshot; reported: ReportedTask },
		extension: string | undefined,
		context: Context,
	): boolean {
		// 每次进展都重新读取注册表快照，让新安装/替换的定义有机会接管。
		state.snapshot = this.#registry.snapshot();
		const next = state.snapshot.task(current.kind);
		// 定义对象完全没变：无需交接，继续同一 invocation。
		if (next === state.task) return true;
		// 新定义能接管（同版本或更高版本且有 migrate）：写回 pending，由下一次预留重新解析并迁移。
		if (next !== undefined && canReserve(next, current)) {
			tx.setTask(withState(current, { status: "pending", checkpoint: current.state.checkpoint }));
			return false;
		}
		// 不能接管（缺失、过旧或迁移失败）：旧定义继续运行；同一替换定义只报告一次，避免刷屏。
		if (state.reported === undefined || state.reported.task !== next) {
			state.reported = { task: next };
			this.#report(
				new Error(`Task ${current.id} keeps running under its old ${current.kind} definition`),
				{
					kind: "task_outdated",
					...this.#aboutTask({ ...recordTask(current), extension }),
					reason: outdatedReason(next, current),
				},
				context,
			);
		}
		return true;
	}

	/** Run the abort handler once; rules 1, 2, and 4 apply, and returning without an outcome faults. */
	// 输入 abort 预留；执行一次 abort handler，无返回值。
	// 流程：确认任务仍存活且未关闭 → 包 phase span 调用定义的 abort → 无论 handler 是否抛错，
	// 都用一个 step 写入终态计划；handler 抛出的错误作为 fault，正常返回则 fault “未给出终态”。
	// 副作用：abort handler 可以通过 runtime 提交状态；最终 state 由 #step 落盘。
	async #runAbort(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		// 记录可能已被其他路径结束；此时不再运行 abort 代码。
		const current = this.#live.get(invocation.taskId) as ErasedRunningTask | undefined;
		if (current === undefined || this.#closing) return;
		await this.#phase(invocation, current, async () => {
			let failure: { readonly error: unknown } | undefined;
			try {
				// abort 阶段没有真实阶段推进，因此 Phase 直接返回预留时的任务与快照。
				const phase: Phase = {
					snapshot: () => reservation.snapshot,
					task: () => reservation.task,
					agent: undefined,
				};
				const runtime = this.#runtime(invocation, phase);
				// abort handler 只负责清理；它通常会在内部提交终态，但最终仍由下面的 step 统一校验。
				await erased(reservation.task).abort(current, runtime, invocation.context);
			} catch (error) {
				// handler 的错误保留下来，翻译成任务的 fault 终态。
				failure = { error };
			}
			const message = `Abort handler of task ${invocation.taskId} returned without a terminal outcome`;
			// 关键不变量：abort handler 返回时必须由它提交终态；否则调度器 fault，避免任务卡在取消中。
			await this.#step(invocation, () => ({ kind: "fault", error: failure?.error ?? new Error(message) }));
		});
	}

	/**
	 * One decision on the Session line, before a phase: a decision region (`#region()`) that reads the task's record. A
	 * task that is no longer running (rule 1: terminal, `completing`, `waiting`, or `sleeping`) or a closing Harness (rule
	 * 2) ends the invocation without a write; otherwise `plan` decides, and a decision that stands is applied: the
	 * invocation continues, with `progress` for rule 5, or ends, with a fault written. Ending happens inside the callback,
	 * before a fault's Harness cleanup. A rejected step, such as admission after close, also ends the invocation. Its
	 * outcome goes to the invocation only, so it is a scheduler commit (`commitInternal()`).
	 */
	// 输入 invocation、计划回调与可选的进展回调；返回继续时的当前任务，结束/拒收时返回 undefined。
	// 流程：在 commitInternal 内开一个决定区域读 live 记录 → 规则 1/2 不满足则 END →
	// plan 产出 StepPlan → continue/progress 继续，否则结束 invocation；cascade 安排 reconcile，
	// fault 写终态并交给 #terminate。提交后若发生 fault，再报告 task_faulted。
	async #step(
		invocation: Invocation,
		plan: (current: ErasedRunningTask) => StepPlan,
		progress?: (tx: Transaction, current: ErasedRunningTask) => boolean,
	): Promise<ErasedRunningTask | undefined> {
		let fault: { readonly error: unknown } | undefined;
		try {
			// 调度器自己的决定用 commitInternal：不暴露给任务代码，也不占用任务的提交上下文。
			const continued = await this.#session.commitInternal(async (tx) => {
				const decided = await this.#region(() => {
					const found = this.#liveRecord(invocation.taskId);
					// 规则 1：任务已不是 running（终态/completing/waiting/sleeping）时不再执行；
					// 规则 2：Harness 关闭同样结束，且不写记录。
					if (found?.state.status !== "running" || this.#closing) return { plan: END };
					const current = found as ErasedRunningTask;
					return { current, plan: plan(current) };
				});
				const { current } = decided;
				const step = decided.plan;
				// 继续运行：把当前记录交回 #run 的循环。
				if (step.kind === "continue") return current;
				// 进展：先执行 progress 回调（可能写 pending 并返回 false），成立才继续。
				if (step.kind === "progress" && progress!(tx, current!)) return current;
				this.#end(invocation);
				// 级联取消：标记待处理并安排一次 reconcile，不在此事务内递归处理子任务。
				if (step.kind === "cascade") {
					this.#cascadePending = true;
					this.#scheduleReconcile();
				}
				if (step.kind === "fault") {
					// fault 的错误先保存，等事务真正提交后再报告，避免报告一个未持久化的失败。
					fault = { error: step.error };
					const message = errorMessage(step.error);
					invocation.fault = { status: "faulted", error: { message } };
					// #terminate 判断是否 completing（有存活子任务）或直接终态并清理。
					await this.#terminate(tx, current!, invocation.fault);
				}
				// 结束路径统一返回 undefined，让 #run 的 while 退出。
				return undefined;
			}, withoutAbortSignal(invocation.context));
			// Reported once the fault is durable: a host may count it, for example toward a breaker.
			// 提交成功后才报告：宿主可能按 fault 次数触发断路器，不能在回滚的决定上计数。
			if (fault !== undefined)
				this.#report(
					fault.error,
					{ kind: "task_faulted", ...this.#aboutTask(invocation), reason: "threw" },
					invocation.context,
				);
			return continued;
		} catch (error) {
			// The step writes the scheduler's own decision, a fault or a terminal record; a throw there would otherwise
			// leave the task running, to be reserved and run again.
			// 决定/写入本身失败：结束 invocation 并把会话标为失败，避免任务被无限重新预留。
			this.#end(invocation);
			this.#failSession(error, invocation.context);
			return undefined;
		}
	}

	/**
	 * Write an outcome the scheduler decided. While the task's ordinary owned work is live it holds as `completing` and
	 * its Harness cleanup waits for the final commit (spec §5.5, rule 4); otherwise it is terminal with its cleanup.
	 */
	// 输入事务、任务记录与调度器决定的结果；在事务内写终态或 completing，无返回值。
	// 规则 4：普通存活子任务未结束时先写 completing，等最后一次提交再终态并清理。
	// 流程：加载作用域 → 决定区域内检查是否有存活子工作（可重试）→ 有则 completing；否则 terminal + settle。
	async #terminate(tx: Transaction, record: AnyTaskRecord, outcome: SchedulerOutcome): Promise<void> {
		// 子任务链未加载会把“有存活子任务”误判为无，因此先加载。
		await this.#loadScopes(false);
		// 决定区域读取可能因并发提交重试；#reloadScopes 在重试前刷新作用域。
		if (await this.#region(() => this.#hasOwnedLive(record.id, overlayOf(tx)), this.#reloadScopes)) {
			// 仍有普通存活工作：暂存为 completing，清理推迟到子工作结束后的最终提交。
			tx.setTask(withState(record, { status: "completing", outcome }));
			return;
		}
		// 无存活子工作：直接终态，并在同一事务内执行 Harness 清理（释放 owned 资源等）。
		tx.setTask(withState(record, { status: "terminal", outcome }));
		await this.#settleOutcome(tx, record, outcome);
	}

	/**
	 * Replace a running task's state with what it committed. A terminal state holds as `completing` while ordinary owned
	 * work is live, judged on the commit's candidates, so work the same commit creates below the task counts. A wait is
	 * validated first.
	 */
	// 输入事务、invocation、当前任务与任务提交的新状态；在事务内写入新状态，无返回值。
	// 流程：waiting 先校验依赖并查环，sleeping 校验 until，terminal 时重新判断存活子任务；
	// 有存活子任务则写 completing，否则写目标状态；状态与旧值相同则不算进展，不重置 restart 计数。
	async #commitState(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		next: NextTaskState<Checkpoint, JsonValue>,
	): Promise<void> {
		// wait 的合法性依赖任务图，必须在写入前检查；不合法直接抛错，事务回滚。
		if (next.status === "waiting") await this.#validateWait(tx, invocation, current, next.on, next.policy);
		// abort handler 不能 sleep，until 必须是合法时间。
		if (next.status === "sleeping") validateSleep(invocation, current.id, next.until);
		if (next.status === "terminal") {
			const overlay = overlayOf(tx);
			await this.#loadScopes(false);
			// 本事务可能新建子任务；逐个加载其父链，让 #hasOwnedLive 能看见它们。
			for (const record of overlay.tasks.values()) await this.#loadChain(parentOf(record), overlay);
			if (await this.#region(() => this.#hasOwnedLive(current.id, overlayOf(tx)), this.#reloadScopes)) {
				// 有普通存活子任务：终态推迟，先写 completing。
				tx.setTask(withState(progressed(current), { status: "completing", outcome: next.outcome }));
				return;
			}
		}
		// A state the task committed that differs from its current one is progress: its restart count starts over. The
		// same checkpoint committed again, for example as intent before an effect, is not.
		// 结构相等判断“是否真的换了状态”；重复提交同一 checkpoint 只更新意图，不重置重启计数。
		const same = jsonEqual(current.state as unknown as JsonValue, next as unknown as JsonValue);
		tx.setTask(withState(same ? current : progressed(current), next));
	}

	/**
	 * A wait names existing tasks, and `failFast` only tasks the waiter owns. It may not close a cycle in the wait-for
	 * graph, whose edges run from each task to what it waits on and to its live ordinary owned work (spec §5.5); waiting
	 * on itself or on an owner holding it are the shortest such cycles. An abort handler cannot wait.
	 *
	 * Invariant: the wait-for graph is acyclic. Only a wait adds an edge between existing tasks, as a new task has only
	 * incoming edges, so checking each wait maintains it.
	 */
	// 输入事务/调用、当前任务、依赖列表与策略；校验通过返回，失败抛 Error。
	// 规则：abort handler 不能 wait；依赖必须存在；failFast 只能指向自己拥有的任务；等待图不能成环。
	// 流程：按需从 Storage 读取非 live 依赖 → 决定区域检查 → 缺失则补读并重试 → 有环抛错。
	async #validateWait(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		on: readonly TaskId[],
		policy: string,
	): Promise<void> {
		// abort handler 的职责是清理，不允许再引入新的等待依赖。
		if (invocation.mode === "abort") throw new Error(`Abort handler of task ${current.id} cannot wait`);
		// Owned work is found by walks down, which need the chains of every live task loaded.
		// 向下遍历拥有关系前必须加载所有存活任务的链，否则可能漏掉子任务。
		await this.#loadScopes(false);
		// Tasks in `on` that are not live, read from Storage: terminal, or missing.
		// 缓存已从 Storage 读取且非 live 的依赖；null 表示确认不存在。
		const ended = new Map<TaskId, AnyTaskRecord | null>();
		for (;;) {
			const checked = await this.#region(
				() => this.#checkWait(current, on, policy, overlayOf(tx), ended),
				this.#reloadScopes,
			);
			// undefined 表示校验通过且所有依赖信息齐全。
			if (checked === undefined) return;
			if ("missing" in checked) {
				// 决定区域内不能做存储 I/O；把缺失的依赖读出来后再重试决定。
				for (const id of checked.missing)
					ended.set(id, (await this.#session.lineStorage.task(id, this.#context)) ?? null);
				continue;
			}
			// 另一分支一定带错误：存在性、所有权或环。
			throw checked.error;
		}
	}

	/**
	 * `#validateWait()`'s decision region: why the wait is refused, `undefined` when it may be stored, or the tasks in
	 * `on` it needs from Storage first, when `ended` lacks them.
	 */
	// 输入当前任务、依赖、策略、事务叠加层与已读取的历史记录；返回缺失依赖、错误或 undefined（可存储）。
	// 纯决策（在决定区域内），不做 I/O；overlay/live/Storage 三层依次查找依赖记录。
	#checkWait(
		current: ErasedRunningTask,
		on: readonly TaskId[],
		policy: string,
		overlay: Overlay,
		ended: ReadonlyMap<TaskId, AnyTaskRecord | null>,
	): { readonly missing: readonly TaskId[] } | { readonly error: Error } | undefined {
		// 需要检查等待环的目标（仍非终态且不是自己的子任务）。
		const targets: TaskId[] = [];
		// 尚未从 Storage 读取的依赖。
		const missing: TaskId[] = [];
		for (const id of on) {
			// 依次看本事务暂存、live 索引、已读历史；undefined 表示还未读取。
			const member = overlay.tasks.get(id) ?? this.#liveRecord(id) ?? ended.get(id);
			if (member === undefined) {
				missing.push(id);
				continue;
			}
			// null 是“已从 Storage 读取但不存在”的标记。
			if (member === null) return { error: new Error(`Task ${id} does not exist`) };
			// failFast 允许宿主快速失败，但只能等待自己拥有的任务，避免跨所有者强杀。
			if (policy === "failFast" && member.owner !== current.id) {
				return { error: new Error(`Task ${current.id} can wait failFast only on tasks it owns; ${id} is not one`) };
			}
			// A live child already holds the waiter (task-owned tasks are never background): waiting on it adds no edge. A
			// terminal task has no edges.
			// 自己的存活子任务本就会让当前任务保持 completing，不构成新的等待边；终态任务没有出边。
			if (member.state.status !== "terminal" && member.owner !== current.id) targets.push(id);
		}
		// 仍有未读依赖：先交给调用方补读，不能在此处直接访问 Storage。
		if (missing.length > 0) return { missing };
		// 没有需要检查的边，等待安全。
		if (targets.length === 0) return undefined;
		const cycle = this.#waitCycle(current.id, targets, overlay);
		if (cycle === undefined) return undefined;
		// 有环：错误消息给出完整路径，便于定位双方。
		return {
			error: new Error(
				`Task ${current.id} cannot wait on ${cycle[0]}: ${[current.id, ...cycle].join(" -> ")} is a wait cycle`,
			),
		};
	}

	/**
	 * The path from a member of `on` back to `task` in the wait-for graph, if the wait would close a cycle (spec §5.1).
	 * An edge X -> Y means X cannot settle before Y: Y is in the `on` of waiting X that is not abort-marked, or Y is live
	 * ordinary owned work of X, which holds X as `completing`. Each task is visited once and each subtree walked once,
	 * so a check is bounded by the live work it reaches. Part of a decision region: it records every record it reads.
	 * Owned work is found by walks down, which need the chains of every live task loaded.
	 */
	// 输入等待者 task、它想等待的任务（on）与事务叠加层；返回闭环路径（不含 task 本身）或 undefined。
	// 边方向 X -> Y 表示 X 在 Y 结束前不能结束：等待依赖，或 X 的普通存活子工作（此时 X 是 completing）。
	// 纯图搜索，无 I/O；visited 保证每个任务只访问一次，复杂度受可达存活工作限制。
	#waitCycle(task: TaskId, on: readonly TaskId[], overlay: Overlay): TaskId[] | undefined {
		// from 记录搜索的来路，用于重建路径；walked 记录已展开过子树的节点。
		const from = new Map<TaskId, TaskId | undefined>();
		const walked = new Set<TaskId>();
		const pending: TaskId[] = [];
		// 首次到达某节点时登记来路并入队；重复到达不再覆盖，保证每个节点只展开一次。
		const reach = (id: TaskId, via: TaskId | undefined) => {
			if (from.has(id)) return;
			from.set(id, via);
			pending.push(id);
		};
		// 从目标节点沿来路回溯到起点，得到正向路径。
		const path = (end: TaskId): TaskId[] => {
			const steps: TaskId[] = [];
			for (let at: TaskId | undefined = end; at !== undefined; at = from.get(at)) steps.unshift(at);
			return steps;
		};
		// 初始边：task -> on 中的每个目标。
		for (const id of on) reach(id, undefined);
		for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
			// 回到起点说明新等待会形成环。
			if (id === task) return path(id);
			const record = overlay.tasks.get(id) ?? this.#liveRecord(id);
			// 不存在或终态：没有出边。
			if (record === undefined || record.state.status === "terminal") continue;
			// An abort-marked task waits only for its owned work, as abort runs bottom-up (`#waitingOn`).
			// 未标记取消的 waiting 任务沿其 on 继续走；abort-marked 的等待边不算（它只等拥有工作）。
			if (record.state.status === "waiting" && !record.abortRequested) {
				for (const member of record.state.on) reach(member, id);
			}
			// 已展开过子树则跳过，避免重复向下走。
			if (walked.has(id)) continue;
			walked.add(id);
			// Below a walked task the walk does not go again: its own walk covered what lies below.
			// 只展开尚未访问的子任务，否则深层链会被反复遍历。
			const found: TaskId[] = [];
			const walk = this.#walkDown(id, { overlay, enter: (below) => !walked.has(below) });
			for (const { id: below, node, live } of walk) {
				// 只把普通（非 background）且存活的子工作算作持有关系。
				if (live === undefined || node.background) continue;
				found.push(below);
				reach(below, id);
			}
			// 这些子任务已作为当前节点的子树展开，后续无需再走。
			for (const below of found) walked.add(below);
		}
		return undefined;
	}

	/** End an invocation: its runtime operations reject from now on, its signal aborts, its watches stop, and its task is free. */
	// 输入 invocation；幂等结束一次调用，无返回值。
	// 副作用：标记 ended、从运行索引移除、任务重新入候选、停止 watches/timers、abort 该调用的 controller。
	// 幂等：重复调用直接返回；这允许 #start 的 finally 与决定路径都安全调用。
	#end(invocation: Invocation): void {
		if (invocation.ended) return;
		invocation.ended = true;
		// 只有当前索引里仍是这个 invocation 时才移除，避免覆盖同任务的后续调用。
		if (this.#invocations.get(invocation.taskId) === invocation) {
			this.#invocations.delete(invocation.taskId);
			// 任务仍存活则重新成为候选；终态任务的 live 记录会在 settle 中移除。
			if (this.#live.has(invocation.taskId)) this.#runnable.add(invocation.taskId);
		}
		// 停止文档观察；stop 返回 Promise，这里不等待，错误由观察实现处理。
		for (const watch of invocation.watches) void watch.stop();
		// 取消 invocation 自己设置的定时器，防止调用结束后回调仍执行。
		for (const disarm of invocation.timers) disarm();
		invocation.timers.clear();
		// Pending waits bound to the invocation, such as a tool's waitForTask(), reject with it.
		// 以 endedError abort：所有绑定该 invocation 信号的操作会以“调用已结束”拒绝。
		invocation.controller.abort(endedError(invocation));
	}

	/** No live non-background task in the scope; a task whose owner edges are not loaded yet counts as inside. */
	// 输入会话 id（undefined 表示全局）；返回该作用域内是否没有存活的前景任务。
	// 纯读判断，用于上下文保留与 idle waiter；保守策略：链未加载的子任务按“在作用域内”计。
	#idle(conversationId: ConversationId | undefined): boolean {
		// 全局作用域从所有根开始；会话作用域只看该会话树。
		const scope: Scope = conversationId === undefined ? { roots: true } : { conversation: conversationId };
		// In a decision region, global idle reads the roots it starts from.
		// 决定区域需记录全局空闲依赖的根键，便于并发提交时键控失效。
		if (conversationId === undefined) this.#record(ROOTS_KEY);
		// Tasks whose chain is not loaded are not listed below their scope yet; one counts as inside unless its walk up
		// decides otherwise.
		// 链未加载的任务尚未挂到父节点下：除非向上走明确判断在作用域外，否则一律视为不空闲。
		for (const id of this.#unloaded) {
			const record = this.#live.get(id);
			if (record !== undefined && !record.background && this.#inScope(parentOf(record), scope) !== false)
				return false;
		}
		// 已加载部分：向下遍历每个起点，发现任意存活前景任务即非空闲。
		const starts = conversationId === undefined ? this.#roots : [conversationId];
		for (const start of starts) {
			for (const { node, live } of this.#walkDown(conversationNode(start))) {
				if (live !== undefined && !node.background) return false;
			}
		}
		return true;
	}

	// ─── Invocation runtime ──────────────────────────────────────────────────

	// 输入 invocation 与阶段视图；返回暴露给任务代码的 ErasedRuntime。
	// 关键约束：runtime 方法在 invocation 结束后都必须拒绝；提交类方法通过 #gated 重新读取任务并检查模式。
	// 副作用：agent/registry/settings 按需解析并缓存；commit/sleep/memo 会写 Session 事务。
	// 错误：调用已结束抛 endedError；任务不处于 running、被 abort-marked 或 Harness 关闭时提交抛错。
	#runtime(invocation: Invocation, phase: Phase): ErasedRuntime {
		// Resolved at most once per phase handler, at first use, with the invocation's context; fixed for the phase.
		// 每个阶段首次使用时才解析 agent；并发调用共享同一个 Promise，避免重复构造。
		const agent = (): Promise<Agent> => {
			if (invocation.ended) return Promise.reject(endedError(invocation));
			if (phase.agent === undefined) {
				phase.agent = this.#agent(invocation.conversationId, phase.snapshot(), invocation.context);
				// A caller that stops waiting must not leave the shared resolution's failure unobserved.
				// 共享 Promise 有多个等待者时，某个调用方取消等待不应产生未处理的 rejection。
				phase.agent.catch(() => {});
			}
			return phase.agent;
		};
		// 钩子运行器：遍历该任务定义关联的扩展，逐个调用匹配的钩子；单个扩展失败被报告，不阻断其他扩展。
		const hooks: HookRunner<Record<string, unknown>> = {
			each: async (name, invoke) => {
				for (const { extension, handlers } of agentHooks(await agent(), phase.task().definition.name)) {
					const handler = (handlers as Record<string, unknown>)[name];
					// 扩展未实现该钩子时跳过；typeof 检查针对的是扩展提供的未类型化记录。
					if (typeof handler !== "function") continue;
					try {
						// bind 保证钩子里的 this 指向 handlers 对象。
						await invoke(handler.bind(handlers));
					} catch (error) {
						// 调用已取消时错误继续传播，由上层决定终态；否则作为扩展错误报告并继续。
						if (invocation.controller.signal.aborted) throw error;
						this.#report(
							error,
							{ kind: "extension_error", extension, task: reportTask(invocation) },
							invocation.context,
						);
					}
				}
			},
		};
		// 捕获 getter 供 runtime 使用；每次读取时调用，支持运行时替换。
		const settings = this.#settings;
		const models = this.#models;
		return {
			// 任务/会话身份直接取自 invocation；任务代码用它定位自己的记录。
			taskId: invocation.taskId as TaskId<JsonValue>,
			conversationId: invocation.conversationId,
			// signal 在 #end 时 abort；任务代码应把长操作绑定到它。
			signal: invocation.controller.signal,
			// getter 每次读取当前模型目录，允许宿主在运行期间替换。
			get models() {
				return models();
			},
			// 公开 agent 方法额外绑定调用方 context：调用方取消等待时只影响自己，不取消共享解析。
			agent: (context) =>
				invocation.ended ? Promise.reject(endedError(invocation)) : awaitWithContext(agent(), context),
			// getter 每次读取当前 settings，支持宿主热更新配置。
			get settings() {
				return settings();
			},
			// env 是已提交状态读取；#read 防止 invocation 结束后再发起读取。
			env: (context) => this.#read(invocation, () => this.#env(invocation.conversationId, context)),
			// hooks 是上面构造的扩展钩子运行器；类型擦除以适配通用 runtime 形状。
			hooks: hooks as ErasedRuntime["hooks"],
			// registry 读取阶段开始时固定的快照，保证同一阶段内定义一致。
			get registry() {
				return phase.snapshot();
			},
			// 任务提交状态的统一入口：在 gated 事务内读取最新记录，再调用 change 决定下一状态。
			commit: async (change, context, options) => {
				// 捕获阶段切换与崩溃中断信息，提交成功后再报告/记事件，避免回滚时误报。
				let checkpoint: string | undefined;
				let interrupted:
					| {
							readonly message: string;
							readonly reason: "restart_limit" | "interrupted";
							readonly restarts: number;
					  }
					| undefined;
				await this.#gated(
					invocation,
					async (tx, current) => {
						// change 接收事务与最新记录，返回 undefined 表示只做副作用不换状态。
						const next = await change(tx, current);
						if (next !== undefined) await this.#commitState(tx, invocation, current, next);
						// 阶段名变化说明任务推进到下一阶段，记一个 telemetry 事件。
						if (next?.status === "running" && current.state.checkpoint.phase !== next.checkpoint.phase) {
							checkpoint = next.checkpoint.phase;
						}
						// A task that ends for crashes says so (`task_interrupted`), so a host keeps a crash-loop signal.
						// 终态时识别“因重启上限/中断而结束”，让宿主能看到崩溃循环信号。
						if (next?.status === "terminal") {
							const restarts = current.restarts ?? 0;
							const reason = next.outcome.status === "failed" ? interruptionOf(next.outcome.error) : undefined;
							if (reason !== undefined && next.outcome.status === "failed") {
								interrupted = { message: next.outcome.error.message, reason, restarts };
							} else {
								// A task that ended for crashes with another outcome says so itself, as a generation whose run
								// answered ends `completed` without its after-run tasks.
								// 某些内置任务以 completed 结束但仍标记为中断（通过 endedByCrashesStates）。
								const message = endedByCrashesStates.get(next);
								if (message !== undefined) interrupted = { message, reason: "restart_limit", restarts };
							}
						}
					},
					context,
					options,
				);
				// 提交成功后才报告中断；消息来自任务定义或 outcome 的错误。
				if (interrupted !== undefined) {
					this.#report(
						new Error(interrupted.message),
						{
							kind: "task_interrupted",
							...this.#aboutTask(invocation),
							reason: interrupted.reason,
							restarts: interrupted.restarts,
						},
						invocation.context,
					);
				}
				// 阶段切换事件同样在提交后添加，保证只记录已持久化的推进。
				if (checkpoint !== undefined) {
					invocation.context.telemetry.addEvent("pi.durable.checkpoint", {
						phase: checkpoint,
					});
				}
			},
			// memo 双形态：一个参数为读取，两个参数（值 + context）为首次写入；写入只发生一次，先到者胜。
			memo: ((name: string, ...rest: readonly unknown[]) => {
				// rest.length === 1 表示只有 name：读取当前记录的 memo，不提交。
				if (rest.length === 1) {
					return this.#read(invocation, async () => memoOf(this.#live.get(invocation.taskId), name));
				}
				const candidate = rest[0] as JsonValue;
				return this.#gated(
					invocation,
					(tx, current) => {
						// 已存在则直接返回旧值，保证同一个 memo 在重试/重启下稳定。
						const winner = memoOf(current, name);
						if (winner !== undefined) return winner;
						tx.setTask({ ...current, memos: { ...current.memos, [name]: candidate } } as AnyTaskRecord);
						return candidate;
					},
					rest[1] as Context,
				);
			}) as ErasedRuntime["memo"],
			// 睡眠：把任务写成 sleeping 状态，直到 Harness 时钟到达 until。
			sleepUntil: (until, checkpoint, context) =>
				this.#gated(
					invocation,
					(tx, current) => this.#commitState(tx, invocation, current, { status: "sleeping", checkpoint, until }),
					context,
				),
			// 文档观察：额外登记到 invocation，结束调用时统一停止。
			watchDoc: ((...args: readonly unknown[]) => this.#watchDoc(invocation, args)) as ErasedRuntime["watchDoc"],
			// snapshot/snapshotAsOf 透传 Session 方法；用 #read 防止调用结束后仍读取。
			snapshot: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshot")(...args),
				)) as ErasedRuntime["snapshot"],
			snapshotAsOf: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshotAsOf")(...args),
				)) as ErasedRuntime["snapshotAsOf"],
			// 按 id 读取任务：通过 readOnLine 保证读到一致快照。
			getTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine((storage) => storage.task(id, context)),
				)) as ErasedRuntime["getTask"],
			// 等待其他任务结束；调用方的 context 与 invocation 信号合并，调用结束会取消等待。
			waitForTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.waitForTask(id, withAbortSignal(invocation.controller.signal, context)),
				)) as ErasedRuntime["waitForTask"],
			// 列出直接拥有的存活任务；在 readOnLine 内读取，保证看到已提交的最新所有权。
			ownedTasks: (context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(async () => {
						// The step that ends the invocation may have run on the line before this.
						// readOnLine 排队期间 invocation 可能已结束；进入后再次检查。
						if (invocation.ended) throw endedError(invocation);
						context.abortSignal?.throwIfAborted();
						// Every live task is listed under its parent node, its owner task when it has one.
						// 决定区域内枚举 #below 中直接子节点，并只保留 owner 指向自己的记录。
						const owned = await this.#region(() => {
							this.#record(ownedKey(invocation.taskId));
							const records: AnyTaskRecord[] = [];
							for (const node of this.#below.get(invocation.taskId) ?? []) {
								// 子节点可能是会话字符串键（表示会话根）或任务 id；字符串键不代表 owned task。
								const record = typeof node === "string" ? undefined : this.#liveRecord(node);
								if (record?.owner === invocation.taskId) records.push(record);
							}
							return records;
						});
						// Copies, as from storage: the scheduler reads its own.
						// 返回深拷贝，防止任务代码修改调度器内部记录。
						return owned
							.sort((a, b) => a.id - b.id)
							.map((record) => copyJson(record as unknown as JsonValue) as unknown as AnyTaskRecord);
					}),
				),
			// 取消一个自己拥有的任务，并等待其真正结束。
			abortOwned: (id, context) =>
				this.#read(invocation, async () => {
					const bound = withAbortSignal(invocation.controller.signal, context);
					// 先读记录并校验所有权，避免跨任务取消。
					const record = await this.#session.readOnLine((storage) => storage.task(id, bound));
					if (record?.owner !== invocation.taskId) {
						throw new Error(`Task ${id} is not owned by task ${invocation.taskId}`);
					}
					// 已终态无需再取消；否则 abort 后等待其结束。keepRestart=true 保留已有的 restart 标记，
					// 避免用普通取消请求覆盖“因重启被放弃”的原因。
					if (record.state.status === "terminal") return;
					await this.abort(id, bound, true);
					await this.waitForTask(id, bound);
				}),
			// 批量读取终态结果；任一 id 非终态则整体失败。
			outcomes: ((ids: readonly TaskId[], context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(async (storage) => {
						const outcomes: TaskOutcome<JsonValue>[] = [];
						for (const id of ids) {
							const state = (await storage.task(id, context))?.state;
							// 只有 terminal 状态才带 outcome；completing/waiting 等一律视为未结束。
							if (state?.status !== "terminal") throw new Error(`Task ${id} is not terminal`);
							outcomes.push(state.outcome);
						}
						return outcomes;
					}),
				)) as ErasedRuntime["outcomes"],
			// 打开/读取会话；check 回调让会话实现能在每次操作前确认 invocation 仍有效。
			conversation: (id, context) =>
				this.#read(invocation, () =>
					this.#conversation(
						id,
						{
							signal: invocation.controller.signal,
							check: () => {
								if (invocation.ended) throw endedError(invocation);
							},
						},
						context,
					),
				),
			// 读取单个 entry：带 kind 令牌时同时校验类型；保留上下文范围内的条目直接读内存，否则走 Storage。
			entry: ((...args: readonly unknown[]) => {
				// 重载两种调用形态：省略 token 时参数前进一位。
				const [token, id, context] =
					args.length === 2
						? [undefined, args[0] as EntryId, args[1] as Context]
						: [args[0] as { readonly kind: string }, args[1] as EntryId, args[2] as Context];
				return this.#read(invocation, async () => {
					// An entry of the conversation's kept context range is committed and visible: no Storage read.
					// kept 范围已包含已提交条目，可直接从内存范围取，省一次存储往返。
					const kept = this.#contexts.get(invocation.conversationId);
					const entry =
						(kept === undefined ? undefined : rangeEntry(kept.range, id)) ??
						(await this.#session.readOnLine((storage) => storage.entry(invocation.conversationId, id, context)))
							?.entry;
					// 未提供 token 或 kind 匹配时返回条目，否则 undefined（视为不存在）。
					return token === undefined || entry?.kind === token.kind ? entry : undefined;
				});
			}) as ErasedRuntime["entry"],
			// 扫描 entry；会话 id 由 invocation 固定，查询按键控读取。
			entries: (query, limit, cursor, context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine((storage) =>
						storage.scanEntries(conversationEntries(invocation.conversationId, query), limit, cursor, context),
					),
				),
			// 读取 ContextView，并尝试保留本次范围的缓存供后续复用。
			context: (conversationId, context, options) =>
				this.#read(invocation, async () => {
					const read = await readContextFrom(
						this.#session,
						this.#storage,
						conversationId,
						context,
						options?.at,
						this.#contexts.get(conversationId)?.range,
					);
					const { view } = read;
					// Checked again here, synchronously up to the install below: a commit published since the read returned
					// was not seen by `#advanceContexts`, so a range that missed it must not be advanced.
					// 读取返回后到安装前是同步段；若最新 entry 已变化，则不能把范围标为“已到最新”。
					const range =
						read.range?.current === true &&
						this.#session.knownLatestEntryId(conversationId) !== read.range.bounds.tail
							? { ...read.range, current: false }
							: read.range;
					// Keep it unless the invocation ended or a concurrent read already kept a newer range.
					// 安装条件：调用未结束、Harness 未关闭、且没有并发读取保留更新的范围。
					const kept = this.#contexts.get(conversationId);
					if (
						range !== undefined &&
						!this.#closing &&
						!invocation.ended &&
						(kept === undefined || kept.range.bounds.tail <= range.bounds.tail)
					) {
						// A read of another, idle conversation starts or continues its retention period.
						// 会话不空闲：保留范围但清除 idle 记录。
						if (!this.#idle(conversationId)) {
							this.#contexts.set(conversationId, { range, idleSince: undefined });
							this.#idleOrder.delete(conversationId);
						} else if (this.#contextRetentionMs() > 0) {
							// An idle period that already started keeps its expiry and its place; a new one starts now.
							// 空闲保留期一旦开始就沿用原到期时间；新空闲则从现在计时。
							const idleSince = kept?.idleSince ?? this.#now();
							const expiresAt =
								kept?.idleSince !== undefined && kept.expiresAt !== undefined
									? kept.expiresAt
									: idleSince + this.#contextRetentionMs();
							this.#contexts.set(conversationId, { range, idleSince, expiresAt });
							// 只有新空闲才插入空闲顺序表；已有记录保持原位置。
							if (kept?.idleSince === undefined) this.#markIdle(conversationId, idleSince);
							this.#scheduleExpiry();
						}
					}
					return view;
				}),
			// 读取 Harness 时钟；结束后拒绝。
			now: () => {
				if (invocation.ended) throw endedError(invocation);
				return this.#now();
			},
			// 设置 foreground 定时器；返回撤销函数，调用结束会自动 disarm。
			setTimer: (callback, delayMs) => {
				// An ended invocation's timers never fire.
				// 已结束的调用直接返回空操作，避免创建永远不会清理的定时器。
				if (invocation.ended) return () => {};
				const disarm = this.#timers.foreground(() => {
					// 先移出集合再执行回调，确保回调中再次 setTimer 不受旧项影响。
					invocation.timers.delete(disarm);
					if (!invocation.ended) callback();
				}, delayMs);
				invocation.timers.add(disarm);
				// 外部撤销：同时从集合移除并取消底层定时器。
				return () => {
					invocation.timers.delete(disarm);
					disarm();
				};
			},
			// 报告错误：根据来源标记 task_error/extension_error/host_error，再交给 Harness 报告通道。
			report: (error, from) => {
				if (invocation.ended) throw endedError(invocation);
				// The task's own failure names the task's extension; any other names whose code failed, if anyone's.
				// 任务自身失败归因到安装该任务的扩展；扩展回调失败归因到具体扩展；宿主回调失败只带 callback 名。
				const task = reportTask(invocation);
				this.#report(
					error,
					from === undefined
						? { kind: "task_error", ...this.#aboutTask(invocation) }
						: from.kind === "extension"
							? { kind: "extension_error", task, ...optionalExtension(from.extension) }
							: { kind: "host_error", callback: from.callback, task },
					invocation.context,
				);
			},
		};
	}

	/**
	 * On the line: wait until every commit admitted before is published, for a decision that reads what cannot be keyed,
	 * every live task (open, inspection) or every task a conversation abort reaches.
	 */
	// 在会话线上等待所有此前被接受的提交发布；返回 Promise，无其他副作用。
	// touch(ALL_KEYS) 取得一个 gate；undefined 表示无需等待。用于无法按键控的读取（全量任务/检查/会话取消）。
	async #published(): Promise<void> {
		const gate = this.#session.touch(ALL_KEYS);
		if (gate !== undefined) await gate;
	}

	/** Run a committed-state read unless the invocation has ended. */
	// 输入 invocation 与读取函数；调用未结束才执行，否则抛 endedError。
	// 不捕获读取自身的错误；它只是 invocation 生命周期的门。
	async #read<T>(invocation: Invocation, read: () => Promise<T>): Promise<T> {
		if (invocation.ended) throw endedError(invocation);
		return read();
	}

	/** Commit after rereading the task on the line and gating the invocation. */
	// 输入 invocation、change 回调、context 与可选提交选项；返回 change 的结果。
	// 流程：commitWith 内再次确认 invocation/关闭状态 → 决定区域读最新 running 记录 →
	// 检查 abort 标记（run 模式）→ 再次确认 invocation 未结束 → 执行 change。
	// 错误：任一检查失败都使提交回滚并向调用方抛错。
	#gated<T>(
		invocation: Invocation,
		change: (tx: Transaction, current: ErasedRunningTask) => T | Promise<T>,
		context: Context,
		options?: CommitOptions,
	): Promise<T> {
		if (invocation.ended) return Promise.reject(endedError(invocation));
		return this.#session.commitWith(
			async (tx) => {
				// 排队等待提交期间状态可能变化，因此在真正拿到事务后重新检查。
				if (invocation.ended) throw endedError(invocation);
				if (this.#closing) throw closedError(this.#session);
				const current = await this.#region(() => {
					const found = this.#liveRecord(invocation.taskId);
					// 任务已不在 live 索引：说明已终态，不能再提交。
					if (found === undefined) throw new Error(`Task ${invocation.taskId} is terminal`);
					// 只有 running 状态的任务可以提交；waiting/sleeping 等状态需先被唤醒。
					if (found.state.status !== "running")
						throw new Error(`Task ${invocation.taskId} is ${found.state.status}`);
					// 普通 run 遇到持久取消标记后必须停止提交，交给 abort 流程。
					if (invocation.mode === "run" && found.abortRequested) {
						throw new Error(`Task ${invocation.taskId} has a durable abort mark`);
					}
					return found as ErasedRunningTask;
				});
				// The step that ends it may have run while the region waited.
				// 决定区域等待了提交队列，期间 invocation 可能已被结束；返回前再检查一次。
				if (invocation.ended) throw endedError(invocation);
				return change(tx, current);
			},
			context,
			// 任务提交必须键控到自己的 taskId 与会话，避免与其他任务并发冲突。
			{ conversationId: invocation.conversationId, taskId: invocation.taskId },
			options,
		);
	}

	// 输入 invocation 与原始 watchDoc 参数；返回文档观察或 undefined。
	// 副作用：把观察登记到 invocation，closed 后自动移除；调用结束时若才拿到观察则立即停止并抛错。
	async #watchDoc(invocation: Invocation, args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		if (invocation.ended) throw endedError(invocation);
		// 透传 SessionImpl.watchDoc 的重载参数；具体参数形状由 Session 校验。
		const watch = (await sessionMethod(this.#session, "watchDoc")(...args)) as DocumentWatch<JsonObject> | undefined;
		if (watch === undefined) return undefined;
		if (invocation.ended) {
			// 等待期间调用已结束：不能再泄漏观察，停止后报错。
			void watch.stop();
			throw endedError(invocation);
		}
		invocation.watches.add(watch);
		// 观察自然关闭时从集合移除，避免 #end 再 stop 一次。
		void watch.closed.then(() => invocation.watches.delete(watch));
		return watch;
	}
}

// 宿主回调失败时的固定报告模板；callback 名用于定位出错来源。
const REGISTRY: ReportInfo = { kind: "host_error", callback: "registry" };
const SETTINGS: ReportInfo = { kind: "host_error", callback: "settings" };
const ON_WAKE: ReportInfo = { kind: "host_error", callback: "onWake" };
const TELEMETRY: ReportInfo = { kind: "host_error", callback: "telemetry" };

/** The extension that installed `task` in `snapshot`, the last one that lists it; none for a built-in task. */
// 输入快照与任务定义；返回最后安装该任务的扩展名，内置任务或未找到返回 undefined。
// findLast 允许同名任务被后装扩展覆盖时归因到最新安装者；纯读，不修改快照。
function installerOf(snapshot: RegistrySnapshot, task: AnyTask | undefined): string | undefined {
	if (task === undefined) return undefined;
	return snapshot.installed().findLast((installed) => installed.tasks?.includes(task) === true)?.name;
}

/** The report info of a failure of a task. */
// 把 invocation/记录上的任务身份转换为报告用的 ReportTask；纯映射。
function reportTask(task: {
	readonly taskId: TaskId;
	readonly kind: string;
	readonly conversationId: ConversationId;
}): ReportTask {
	return { id: task.taskId, kind: task.kind, conversationId: task.conversationId };
}

/** A stored task's identity, as an invocation names it. */
// 把存储记录的身份转换为 reportTask 的输入形状；字段名从 id 改为 taskId。
function recordTask(record: Pick<AnyTaskRecord, "id" | "kind" | "conversationId">) {
	return { taskId: record.id, kind: record.kind, conversationId: record.conversationId };
}

/**
 * The record with an abort mark: `restart` for an abandonment; without a reason, a request, which replaces `restart`.
 * The restart count starts over: it now counts cut-offs of the abort handler.
 */
/** Why a failed outcome's error says crashes ended the task (`detail.reason`), if it does. */
/**
 * Terminal states a built-in task commits because it was cut off `settings.restartLimit` times, when their outcome does
 * not say so (a failure with detail `{ reason: "restart_limit" }` does), with the message the scheduler reports them
 * `task_interrupted` with. Keyed by the state object the task returns, so nothing is added to the stored state.
 */
// WeakMap 以任务返回的状态对象为键：不修改存储状态，也不阻止状态对象被回收。
const endedByCrashesStates = new WeakMap<object, string>();

/** `state`, marked as ending its task for crashes (`task_interrupted` with `message`), whatever its outcome. */
// 内置任务用它声明“虽然 outcome 是 completed，但这是重启上限导致的中断”；返回同一对象以便链式使用。
export function endedByCrashes<T extends object>(state: T, message: string): T {
	endedByCrashesStates.set(state, message);
	return state;
}

// 从失败 outcome 的 error.detail 里读取中断原因；detail 是运行时传入的 JSON，需形状检查。
function interruptionOf(error: TaskOutcomeError): "restart_limit" | "interrupted" | undefined {
	const detail = error.detail;
	if (typeof detail !== "object" || detail === null || !("reason" in detail)) return undefined;
	return detail.reason === "restart_limit" || detail.reason === "interrupted" ? detail.reason : undefined;
}

// 给记录加持久取消标记；先解构掉旧 abortReason/restarts，再按需写入新 reason。
// 无 reason 表示普通取消请求；restart 表示因重启放弃。
function withAbortMark(record: AnyTaskRecord, reason?: "restart"): AnyTaskRecord {
	const { abortReason: _reason, restarts: _restarts, ...rest } = record;
	return { ...rest, abortRequested: true, ...(reason === undefined ? {} : { abortReason: reason }) } as AnyTaskRecord;
}

/** A live owner's durable cancellation intent: its abort mark, or a held outcome other than `completed`. */
// 判断记录的“取消意图”：非终态，且要么有 abort 标记，要么持有非 completed 的结果。
// 级联取消用它决定普通前景任务是否应被标记。
function cancellationIntent(record: AnyTaskRecord): boolean {
	return record.state.status !== "terminal" && (record.abortRequested || failedOutcome(record));
}

/**
 * Whether replacing `previous` (absent: a new task) with `next` changes the cancellation intent set or what it means: a
 * mark set, upgraded, or cleared, or a held or ended outcome other than `completed`.
 */
// 比较前后两条记录对“取消意图”的影响；用于决定是否可以跳过级联重算。
// previous 为 undefined 表示新任务：只要 next 有意图就算变化。
function intentChanges(previous: AnyTaskRecord | undefined, next: AnyTaskRecord): boolean {
	return (
		(previous?.abortRequested ?? false) !== next.abortRequested ||
		previous?.abortReason !== next.abortReason ||
		(previous !== undefined && failedOutcome(previous)) !== failedOutcome(next) ||
		(previous !== undefined && cancellationIntent(previous)) !== cancellationIntent(next)
	);
}

/** Whether the record holds or ends with an outcome other than `completed`. */
// completing/terminal 且 outcome 非 completed 视为失败结果；其余状态不算。
function failedOutcome(record: AnyTaskRecord): boolean {
	const state = record.state;
	return (state.status === "completing" || state.status === "terminal") && state.outcome.status !== "completed";
}

// 节点的父关系：有 owner 任务则挂到该任务，否则挂到会话根。
function parentOf(node: TaskNode): Up {
	return node.owner !== undefined ? { task: node.owner } : { conversation: node.conversationId };
}

// 从记录构造所有权节点；owner 只在存在时加入，background 决定是否计入空闲/取消级联。
function nodeOf(record: AnyTaskRecord): TaskNode {
	return {
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
	};
}

// 把事务暂存的任务/会话边包装成只读叠加层，供决定区域在没有已提交状态时也能看到本事务写入。
function overlayOf(tx: Transaction): Overlay {
	const tasks = new Map(tx.stagedTasks().map((record) => [record.id, record]));
	const edges = new Map(tx.stagedConversations().map((record) => [record.id, record.owner?.taskId ?? null]));
	return { tasks, edges };
}

// 向 Map<K, Set<V>> 添加值，必要时创建集合。
function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
	const values = map.get(key);
	if (values === undefined) map.set(key, new Set([value]));
	else values.add(value);
}

// 从 Map<K, Set<V>> 删除值；集合变空时同时删除键，避免索引留下空项。
function deleteFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
	const values = map.get(key);
	if (values === undefined) return;
	values.delete(value);
	if (values.size === 0) map.delete(key);
}

/** Own memo entry only; memo names such as `toString` must not resolve to inherited properties. */
// 只读取自有 memo；Object.hasOwn 防止 memo 名与 Object.prototype 属性冲突。
function memoOf(record: AnyTaskRecord | undefined, name: string): JsonValue | undefined {
	const memos = record?.memos;
	return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined;
}

/** Overloaded Session method bound for forwarding an argument list unchanged. */
// 输入 SessionImpl 与方法名；返回已 bind 的函数，便于用展开参数调用重载方法而不丢 this。
function sessionMethod(
	session: SessionImpl,
	name: "snapshot" | "snapshotAsOf" | "watchDoc",
): (...args: readonly unknown[]) => Promise<unknown> {
	return (session[name] as (...args: readonly unknown[]) => Promise<unknown>).bind(session);
}

// 构造“缺少 migrate”错误；记录定义版本，方便任务作者判断如何补迁移。
function missingMigration(record: AnyTaskRecord, definition: ErasedDefinition): Error {
	return new Error(`Task ${record.kind} version ${definition.version} has no migration from ${record.version}`);
}

// 擦除任务定义的泛型，供调度器统一调用 phases/abort/migrate；只是编译期桥接。
function erased(task: AnyTask): ErasedDefinition {
	return task.definition as unknown as ErasedDefinition;
}

// 构造“invocation 已结束”的错误；所有 runtime 方法在结束后都以它拒绝。
function endedError(invocation: Invocation): Error {
	return new Error(`Task ${invocation.taskId} invocation has ended`);
}

/** The record without its restart count, as after a state the task committed. */
// 清除 restart 计数：任务提交了新的可恢复状态后，之前的崩溃次数不再累计。
function progressed(record: AnyTaskRecord): AnyTaskRecord {
	if (record.restarts === undefined) return record;
	const { restarts: _restarts, ...rest } = record;
	return rest as AnyTaskRecord;
}

/** Replace a live record's state; memos and the restart count disappear once an outcome is decided. */
// 写入新状态；进入 completing/terminal（已决定结果）时同时清掉 memos 与 restarts，释放引用。
function withState(record: AnyTaskRecord, state: TaskState<JsonValue, JsonValue>): AnyTaskRecord {
	if (state.status !== "terminal" && state.status !== "completing") return { ...record, state } as AnyTaskRecord;
	const { memos: _memos, restarts: _restarts, ...rest } = record;
	return { ...rest, state };
}

/** Whether a definition can take the task at reservation: same version, or newer with a migration. */
/**
 * Why a replacement definition cannot take a running task, in `#fit()`'s words: none is registered, it is older than
 * the task, or it is newer without a `migrate`.
 */
// 把 #fit 的失败原因映射为对外的 BlockedReason；用于 task_outdated 报告。
function outdatedReason(task: AnyTask | undefined, record: AnyTaskRecord): BlockedReason {
	if (task === undefined) return "missing_task";
	return task.definition.version < record.version ? "task_too_old" : "migration_failed";
}

// 判断定义能否在预留时接管记录：版本相同，或版本更高且有 migrate。
function canReserve(task: AnyTask, record: AnyTaskRecord): boolean {
	const definition = task.definition;
	return (
		definition.version === record.version || (definition.version > record.version && definition.migrate !== undefined)
	);
}

/** A sleep's `until` is a time on the Harness clock; an abort handler cannot sleep. */
// 校验 sleep：abort handler 不允许睡眠；until 必须是有限非负毫秒时间。
function validateSleep(invocation: Invocation, task: TaskId, until: number): void {
	if (invocation.mode === "abort") throw new Error(`Abort handler of task ${task} cannot sleep`);
	if (typeof until !== "number" || !Number.isFinite(until) || until < 0) {
		throw new Error(`Task ${task} cannot sleep until ${until}: not a time in milliseconds`);
	}
}

/** Structural equality of two JSON values; object key order is ignored. */
// 输入两个 JsonValue（可能 undefined）；结构相等返回 true，忽略对象键顺序。
// 递归比较数组与对象；标量用 ===。只处理 JSON 形状，不处理 Date/Map 等非 JSON 值。
function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		// 只有两边都是数组且长度相同才逐项比较。
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => jsonEqual(value, right[index]));
	}
	// 键数量不同直接不等；键集合相同则逐键递归。
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}
