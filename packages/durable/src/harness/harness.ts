// 所属：packages/durable/src/harness，Durable harness 的装配层：把 Session 内核、任务调度器、提交准入、会话句柄与
// 观察视图组合成一个可用的 agent harness。
// 解决的问题：调用方需要一个入口来打开存储、恢复未完成任务、创建/分叉/打开会话，并通过会话句柄提交输入、配置 agent、
// 压缩、观察状态；这些组件互相依赖（调度器需要 agent/env/settings，Conversation 需要调度器与提交服务），本文件负责接线。
// 职责边界：装配与转发；任务状态机在 scheduler.ts，提交规则在 submissions.ts，agent 解析在 agent.ts，上下文在 context.ts。
// 上游：宿主调用 Harness.open() 与 harness.root()/createConversation()/conversation()。
// 下游：Storage/Session（持久化与提交）、TaskScheduler（任务执行）、pi-ai Models（模型访问）、pi-telemetry（报告与指标）。
// 能力清单：
// - SCHEDULER_INDEX_SIZES/SCHEDULER_IDLE_STATE：测试用 Symbol 键，读取调度器内部索引与空闲状态；
// - ConversationImpl：Conversation 接口实现（agent/configure/submit/compact/reset/commit/context/entries/fork/abort/
//   waitForIdle/watch），每个方法把调用转发给 harness、scheduler 或视图层；
// - DEFAULT_HARNESS_IDENTITY：模型请求的默认客户端身份（provider attribution 指向 pi）；
// - HarnessImpl：SessionImpl 的扩展，构造调度器/提交服务/任务图视图/会话视图，并暴露检查、观察与创建 API；
// - safeReport：永不抛错的报告函数，写 onReport、指标与 telemetry 事件；
// - safeNow：包装宿主时钟，时钟抛错时回退 Date.now 且只报告第一次；
// - boundConversation：把任务/工具调用绑定到 InvocationBinding（检查调用仍有效、在调用 signal 下运行）；
// - Harness.open：打开 Harness、校验内置任务、恢复/对账未完成任务，失败时关闭并重新抛出。
// 典型顺序：Harness.open(storage, options, context) → new HarnessImpl + openTasks → root/createConversation/conversation
//   → #create（commitWith 内建文档 + conversationCreated）→ Conversation.submit/compact/abort/watch。
// 示例：
//   const harness = await Harness.open(storage, { models, registry }, context);
//   const conversation = await harness.root(context);
//   const submission = await conversation.submit({ type: "input", content: "hello" }, context);
//   await submission.wait(context); // 等待输入被放置并完成这次运行
//   示例假定 storage/models/registry 已由宿主提供；Harness.open 会校验 registry 含全部内置任务。
// 建议阅读顺序：先读 Harness.open 与 HarnessImpl 构造函数（接线关系），再读 ConversationImpl 的方法分组，
//   随后 #create/conversationCreated 的创建流程，最后读 safeReport/safeNow/boundConversation 三个边界辅助函数。
import type { Context } from "@earendil-works/chord/context";
import { withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Models } from "@earendil-works/pi-ai";
import {
	type ClientIdentity,
	mergeClientIdentity,
	PI_ATTRIBUTION,
	withClientIdentity,
} from "@earendil-works/pi-ai/utils/identity";
import {
	createTypedMetrics,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type SpanAttributes,
	type TelemetryContext,
} from "@earendil-works/pi-telemetry";
import { ResetEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { contained, SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import { hostTimers } from "../timers.ts";
import type {
	CommitOptions,
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryQuery,
	EntryRecord,
	Observation,
	Observer,
	Page,
	Report,
	ReportInfo,
	Storage,
	SubmissionId,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { AgentDoc, configure, createAgent, resolveAgent, resolveSettings } from "./agent.ts";
import { createCompaction } from "./compaction.ts";
import { readContext } from "./context.ts";
import { InboxDoc, withdrawQueuedInputs } from "./inbox.ts";
import { LIMITS_RESTARTS, LiveDoc, settleSchedulerOutcome } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { BUILTIN_TASKS } from "./registry.ts";
import { type InvocationBinding, TaskScheduler } from "./scheduler.ts";
import { Submissions } from "./submissions.ts";
import { type TaskGraph, TaskGraphView, type TaskGraphWatch } from "./task-graph.ts";
import { DURABLE_TELEMETRY_SCHEMA } from "./telemetry.ts";
import type {
	Agent,
	AgentChange,
	CompactionResult,
	ContextView,
	Conversation,
	ConversationAbortOptions,
	ConversationCreateOptions,
	ConversationHandle,
	ConversationInit,
	ConversationWatch,
	HarnessInspection,
	HarnessOptions,
	HarnessSettings,
	Harness as HarnessType,
	RegistrySnapshot,
	SettledTask,
	Submission,
	SubmissionDraft,
	ToolRegistration,
	Wake,
} from "./types.ts";
import { addUsageState, UsageDoc, type UsageState } from "./usage.ts";
import { conversationEntries, scanAll } from "./util.ts";
import { type ConversationView, ConversationViews, type ConversationWindow } from "./view.ts";

// 全量扫描 Conversations/Submissions 时的分页大小；只是批大小，不影响合并后的顺序。
const SCAN_PAGE_SIZE = 256;

// CreateTarget 是内部创建目标：root 单例、独立会话、或按条目分叉；ownership 决定会话归应用还是任务所有。
type CreateTarget =
	// root：返回已存在的 ROOT_CONVERSATION_ID 或创建它；同一存储只有一个根会话。
	| { readonly kind: "root" }
	// independent：应用创建的独立会话；ownership 描述谁拥有它（应用/任务）。
	| { readonly kind: "independent"; readonly ownership: ConversationOwnership }
	// fork：从父会话的某个可见条目复制；at 是分叉点，ownership 与创建选项相同。
	| {
			readonly kind: "fork";
			readonly parentId: ConversationId;
			readonly at: EntryId;
			readonly ownership: ConversationOwnership;
	  };

// CreateOptions 是创建提交里、conversationCreated 之后应用的便利配置：agent 变更与 init 回调。
/** What the conveniences apply in the creating commit, after the creation hook. */
type CreateOptions = { readonly agent?: AgentChange; readonly init?: ConversationInit };

// ConversationHost 是 ConversationImpl 可用的 Harness 私有服务集合；它避免每个句柄都重新构造调度器/视图。
/** Harness-private services used by Conversation handles. */
type ConversationHost<Tool extends ToolRegistration> = {
	readonly harness: HarnessImpl<Tool>;
	readonly storage: Storage;
	readonly tasks: TaskScheduler;
	readonly submissions: Submissions;
	readonly views: ConversationViews;
	readonly now: () => number;
	create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation>;
};

// 测试用 Symbol：通过 harness[SCHEDULER_INDEX_SIZES] 读取调度器索引大小，不影响公共 API。
/** Key of the Harness's internal index-size getter, for tests. */
export const SCHEDULER_INDEX_SIZES = Symbol.for("pi-durable.schedulerIndexSizes");

// 测试用 Symbol：读取调度器保留上下文的空闲状态，用于检查增量维护是否与全量重算一致。
/** Key of the Harness's internal idle-state getter (kept contexts against a full recompute), for tests. */
export const SCHEDULER_IDLE_STATE = Symbol.for("pi-durable.schedulerIdleState");

// ConversationImpl 是 Conversation 的句柄实现：只持有会话 ID 与宿主服务，所有操作即时转发，不缓存运行状态。
class ConversationImpl<Tool extends ToolRegistration> implements Conversation {
	readonly id: ConversationId;
	// id 是公开的不可变会话 ID；#host 是 ECMAScript 私有字段，外部无法读取或伪造。
	readonly #host: ConversationHost<Tool>;

	// 构造函数只记录引用，不读文档、不启动任务；句柄本身是轻量的。
	constructor(id: ConversationId, host: ConversationHost<Tool>) {
		this.id = id;
		this.#host = host;
	}

	// agent() 解析当前 agent；snapshot 为 undefined 表示使用注册表的最新快照。
	agent(context: Context): Promise<Agent> {
		return this.#host.harness.resolveAgent(this.id, undefined, context);
	}

	// configure() 在事务里应用一次 AgentChange；commitWith 负责提交与失败报告。
	configure(change: AgentChange, context: Context): Promise<void> {
		return this.#host.harness.commitWith((tx) => configure(tx, this.id, change), context);
	}

	// submit 有两个重载：传入 Context 时返回 Submission 句柄，传入 Tx 时只在事务内准入并返回 ID。
	submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
	submit(tx: Tx, submission: SubmissionDraft): Promise<SubmissionId>;
	// 实现签名必须覆盖两个重载；运行时用 "type" in first 区分“草稿 + Context”和“Tx + 草稿”。
	submit(first: SubmissionDraft | Tx, second: Context | SubmissionDraft): Promise<Submission | SubmissionId> {
		// The overloads pair a draft with a context, and anything else (a transaction) with a draft.
		// 草稿有 type 字段，Tx 没有；这是运行时判别，类型系统只保证两个重载的静态形状。
		if ("type" in first) return this.#host.submissions.submit(this.id, first, second as Context);
		// 传 Tx 时执行 admit（提交由调用方事务负责）；否则 submit 会等待/启动运行。
		return this.#host.submissions.admit(first, this.id, second as SubmissionDraft);
	}

	// compact() 创建手动压缩任务；先 resume 调度器，确保任务会被运行。
	async compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>> {
		this.#host.tasks.resume();
		// 输入原因固定 manual；instructions 缺省时条件展开省略字段，as const 保持 reason 字面量。
		const input = { reason: "manual", ...(instructions === undefined ? {} : { instructions }) } as const;
		// createCompaction 在提交里创建任务并登记 pi.live 状态；返回任务 ID。
		return this.#host.harness.commitWith((tx) => createCompaction(tx, this.id, input), context);
	}

	// reset() 提交一条 head:"self" 的写入条目；可选 handoff 成为新上下文的第一条用户消息。
	async reset(handoff: string | undefined, context: Context): Promise<void> {
		// handoff 缺省时 model 字段整个省略；有 handoff 时构造一条用户消息，时间戳来自 Harness 时钟。
		const model =
			handoff === undefined
				? {}
				: { model: [{ role: "user", content: handoff, timestamp: this.#host.now() } as const] };
		// 条目草稿用 ResetEntry.kind 与 head:"self"；as const 让判别字段保持字面量。
		const entry = { kind: ResetEntry.kind, head: "self", ...model } as const;
		// 通过 submissions.submit 走正常写入准入：忙会话会排队到边界，空闲时立即放置。
		await this.#host.submissions.submit(this.id, { type: "write", entry }, context);
	}

	// commit() 是 Conversation 级事务入口：把会话 ID 作为默认作用域，允许调用方提供提交选项。
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context, options?: CommitOptions): Promise<T> {
		return this.#host.harness.commitWith(change, context, { conversationId: this.id }, options);
	}

	// context() 读取活动转录与模型上下文；options.at 可指定历史切片。
	context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView> {
		return readContext(this.#host.harness, this.#host.storage, this.id, context, options?.at);
	}

	// entries() 分页读取条目；Omit<EntryQuery, "conversationId"> 在编译期去掉会话字段，函数补上当前会话。
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		// conversationEntries 构造带会话过滤的查询；scanEntries 在 Session 线上执行，保证与提交串行。
		const scan = conversationEntries(this.id, query);
		return this.#host.harness.readOnLine((storage) => storage.scanEntries(scan, limit, cursor, context));
	}

	// fork() 从当前会话的 at 条目分叉；选项中的 ownership 传给新会话。
	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#host.create({ kind: "fork", parentId: this.id, at, ownership: options.ownership }, options, context);
	}

	// abort() 取消会话的任务；background 决定是否跨越后台边界。
	async abort(context: Context, options?: ConversationAbortOptions): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.abortConversation(this.id, options?.background === true, context);
	}

	// waitForIdle() 等待调度器空闲；先 resume 让睡眠任务被重新调度。
	async waitForIdle(context: Context): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.waitForIdle(this.id, context);
	}

	// watch() 订阅会话视图；window 控制观察窗口。
	watch(context: Context, window?: ConversationWindow): Promise<ConversationWatch> {
		return this.#host.views.watch(this.id, context, window);
	}
}

// DEFAULT_HARNESS_IDENTITY 只设置 attribution；mergeClientIdentity 会把它与宿主身份逐字段合并。
/** Request identity of a Harness's model requests: pi-ai's defaults with provider attribution to pi. */
export const DEFAULT_HARNESS_IDENTITY: ClientIdentity = { attribution: PI_ATTRIBUTION };

// currentModels 把 HarnessOptions.models 统一成“每次使用读取”的函数；普通 Models 只包装一次，函数的结果每次包装。
/**
 * `HarnessOptions.models` as a function with `HarnessOptions.identity` applied. A plain `Models` is wrapped once; a
 * function's result is wrapped at each call.
 */
function currentModels(models: HarnessOptions["models"], identity: ClientIdentity | undefined): () => Models {
	// mergeClientIdentity 返回 undefined 时回退默认身份；?? 只处理 null/undefined。
	const merged = mergeClientIdentity(DEFAULT_HARNESS_IDENTITY, identity) ?? DEFAULT_HARNESS_IDENTITY;
	// models 是函数：每次调用先取当前 Models，再应用身份；宿主可热替换模型配置。
	if (typeof models === "function") return () => withClientIdentity(models(), merged);
	// 普通 Models：包装一次并复用同一个包装对象。
	const wrapped = withClientIdentity(models, merged);
	return () => wrapped;
}

// currentSettings 把设置统一成函数：函数原样返回（每次读取最新值），普通对象/undefined 用常量闭包。
/** `HarnessOptions.settings` as a function: plain settings, or none, are returned at every call. */
function currentSettings(settings: HarnessOptions["settings"]): () => HarnessSettings | undefined {
	// typeof settings === "function" 是运行时判别，因为类型是联合；返回类型保证调用方总拿到函数。
	return typeof settings === "function" ? settings : () => settings;
}

// HarnessImpl 继承 SessionImpl（存储、提交、文档、关闭生命周期），再组合调度器、提交服务与视图。
/** Session kernel extended with conversation handles and a registry. */
// 类声明；泛型 Tool 约束为 ToolRegistration，保持扩展工具的具体类型。
class HarnessImpl<Tool extends ToolRegistration> extends SessionImpl implements HarnessType {
	// #options 保存原始选项；#hostSettings 每次读取设置；#report 是安全报告函数。
	readonly #options: HarnessOptions<Tool>;
	readonly #hostSettings: () => HarnessSettings | undefined;
	readonly #report: (error: unknown, info: ReportInfo, context?: Context) => void;
	// #host 是 ConversationImpl 使用的服务束；#tasks/#submissions 是核心组件；#taskGraph 提供任务图视图。
	readonly #host: ConversationHost<Tool>;
	readonly #tasks: TaskScheduler;
	readonly #submissions: Submissions;
	readonly #taskGraph: TaskGraphView;

	// 构造函数完成全部接线；它不恢复任务（由 Harness.open 调 openTasks）。
	constructor(rawStorage: Storage, options: HarnessOptions<Tool>, context: Context) {
		// safeReport 包装宿主 onReport：报告失败不会抛出；telemetry 缺省用 NOOP，避免空值检查。
		const report = safeReport(options.onReport, options.telemetry ?? NOOP_TELEMETRY_CONTEXT);
		// safeNow 包装宿主时钟；report 用于第一次时钟错误。
		const now = safeNow(options.now, report);
		// hostSettings 是“每次读取”的函数；下面 super() 只按需读取两个性能敏感字段。
		const hostSettings = currentSettings(options.settings);
		// super 的 retention/persistWithin 回调每次提交都会调用，所以只读取这两个字段，避免解析整套设置。
		// Read at each use, as all settings are, but only these fields: they are read on every commit.
		// SessionImpl 参数：原始存储、时钟、文档保留毫秒、定时器、只读标志、进度持久化窗口。
		super(
			rawStorage,
			now,
			() => hostSettings()?.documentRetentionMs,
			options.setTimer,
			options.readOnly === true,
			() => hostSettings()?.progress?.persistWithinMs,
		);
		// 之后所有组件都通过 this.storage（带失败保护的包装）读写；rawStorage 只服务于 super()。
		// Every component reads and writes through the Session's failure guard: `rawStorage` serves only `super()`.
		// 保存包装后的 storage 引用；它不是复制，只是同一个受保护接口。
		const storage = this.storage;
		// 保存选项、报告函数与设置读取器；它们都是引用，不复制。
		this.#options = options;
		this.#report = report;
		this.#hostSettings = hostSettings;
		// settings 是“每次使用重新解析”的函数；resolveSettings 把可选 HarnessSettings 展开为必填 Settings。
		const settings = () => resolveSettings(hostSettings());
		// TaskScheduler 是任务执行核心；下面的对象字面量逐项注入依赖。
		this.#tasks = new TaskScheduler({
			// telemetry 用于任务指标/事件；缺省时组件内部使用 NOOP。
			telemetry: options.telemetry,
			// session 提供提交/文档/关闭钩子。
			session: this,
			// storage 是受保护的读写入口。
			storage,
			// registry 提供任务定义与扩展快照；调度器按名称解析任务。
			registry: options.registry,
			// models 每次使用读取当前 Models 并应用身份。
			models: currentModels(options.models, options.identity),
			// agent 回调解析会话 agent；snapshot 可能来自旧注册表，这里只做类型断言。
			agent: (id, snapshot, callContext) => this.resolveAgent(id, snapshot as RegistrySnapshot<Tool>, callContext),
			// settings 每次使用重新解析，策略变化会立即生效。
			settings,
			// env 按会话 cwd 构建执行环境；没有 env 选项时返回 undefined。
			env: (id, callContext) => this.buildEnv(id, callContext),
			// now 是安全时钟，供任务时间戳/睡眠截止时间使用。
			now,
			// onWake 让宿主在睡眠任务到期时唤醒进程。
			onWake: options.onWake,
			// timers 把宿主 setTimer 包装成定时器服务；定时器错误报告为 host_error。
			timers: hostTimers(options.setTimer, (error) => report(error, { kind: "host_error", callback: "setTimer" })),
			// writeAtClose 让 Session 关闭时写入延迟进度。
			writeAtClose: (writes) => this.writeAtClose(writes),
			// report 传入安全报告函数，任务错误不会因报告器抛错而丢失。
			report: this.#report,
			// limitsRestarts 判断某任务种类是否自带重启上限处理；内置生成/工具/压缩在其中。
			limitsRestarts: (kind) => LIMITS_RESTARTS.has(kind),
			// settleOutcome 是调度器写 faulted/orphaned 时的清理钩子（live.ts）。
			settleOutcome: settleSchedulerOutcome,
			// withdrawInputs 在取消级联时撤销排队输入（inbox.ts）。
			withdrawInputs: withdrawQueuedInputs,
			// conversation 回调把会话记录解析成绑定当前任务调用的 ConversationHandle；记录不存在时返回 undefined。
			conversation: async (id, binding, callContext) => {
				// readOnLine 保证读取在 Session 线上执行，与提交串行。
				const record = await this.readOnLine((line) => line.conversation(id, callContext));
				// boundConversation 把句柄操作绑定到任务的 signal 与有效性检查。
				return record === undefined ? undefined : boundConversation(id, binding, this.#submissions, this.#tasks);
			},
			// 构造期 Context 可能带调用方中止信号；传给调度器的版本去掉信号，避免打开阶段被调用方取消影响任务恢复。
			context: withoutAbortSignal(context),
			// readOnly 透传；只读 Harness 不允许提交。
			readOnly: options.readOnly === true,
		});
		// Submissions 负责输入准入/排队；resume 回调在提交时唤醒调度器。
		this.#submissions = new Submissions(this, now, settings, () => this.#tasks.resume(), options.telemetry);
		// TaskGraphView 提供任务图观察；blocked 与 subscribeBlocked 来自调度器。
		this.#taskGraph = new TaskGraphView(this, {
			blocked: (record) => this.#tasks.blockedReason(record),
			subscribeBlocked: (listener) => this.#tasks.subscribeBlocked(listener),
		});
		// #host 汇总 ConversationImpl 需要的服务；create 转发到私有 #create。
		this.#host = {
			harness: this,
			storage,
			tasks: this.#tasks,
			submissions: this.#submissions,
			views: new ConversationViews(this),
			now,
			create: (target, createOptions, context) => this.#create(target, createOptions, context),
		};
	}

	// resolveAgent 解析会话已提交的 pi.agent：snapshot 缺省时取注册表最新快照，设置每次重新读取。
	/** Resolve a conversation's committed `pi.agent` against `snapshot`, or the current one, and the current settings. */
	async resolveAgent(
		id: ConversationId,
		snapshot: RegistrySnapshot<Tool> | undefined,
		context: Context,
	): Promise<Agent<Tool>> {
		// snapshot 为 undefined 时使用当前注册表快照；否则使用调用方提供的快照（例如任务创建时的固定视图）。
		const registry = snapshot ?? this.#options.registry.snapshot();
		// 读取 pi.agent 文档的最新值；会话可能还没有文档（返回 undefined，按空状态解析）。
		const state = await this.snapshot(AgentDoc, id, context);
		// 调用 agent.ts 的 resolveAgent；报告回调带上会话 ID 与扩展名，kind 为 extension_error。
		return resolveAgent(state, registry, resolveSettings(this.#hostSettings()), (error, extension) =>
			this.#report(error, { kind: "extension_error", conversationId: id, extension }, context),
		);
	}

	// buildEnv 按会话当前 cwd 构建执行环境；没有 env 选项时返回 undefined。
	/** Build a conversation's environment from its current `cwd`; `undefined` without an `env` option. */
	async buildEnv(id: ConversationId, context: Context): Promise<ExecutionEnv | undefined> {
		// 取出宿主提供的 env 构造器；undefined 表示禁用执行环境。
		const build = this.#options.env;
		// 没有构造器直接返回；不读取 agent 文档，减少不必要的表读。
		if (build === undefined) return undefined;
		// 读取当前 cwd；cwd 可能未设置，此时不传该字段。
		const cwd = (await this.snapshot(AgentDoc, id, context))?.cwd;
		// 构造 EnvTarget：会话 ID、可选 cwd、只读文档读取器；上下文透传取消与遥测。
		return build({ conversationId: id, ...(cwd === undefined ? {} : { cwd }), read: this }, context);
	}

	// openTasks 对账“运行中”任务：把存活任务改回 pending，交给调度器重新执行；Harness.open 调用一次。
	/** Reconcile surviving `running` tasks to `pending`; part of open. */
	// 转发给调度器的 open；错误由 Harness.open 处理。
	openTasks(context: Context): Promise<void> {
		return this.#tasks.open(context);
	}

	// resume 显式唤醒调度器；在创建任务/等待空闲前调用。
	resume(): void {
		// assertUsable 检查 Harness 未关闭；关闭后继续使用会抛错。
		this.assertUsable();
		this.#tasks.resume();
	}

	// wake 返回下一次唤醒信息（截止时间/原因），供宿主安排进程唤醒。
	wake(): Wake {
		this.assertUsable();
		return this.#tasks.wake();
	}

	// getTask 按 ID 读取任务记录；readOnLine 保证与提交串行，as 断言把擦除的泛型恢复为 R。
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined> {
		return this.readOnLine((storage) => storage.task(id, context)) as Promise<
			TaskRecord<JsonValue, JsonValue, R> | undefined
		>;
	}

	// 测试用 getter：返回调度器索引大小；计算属性名来自 Symbol，外部只能通过导出的 Symbol 访问。
	/** Internal, for tests: sizes of the scheduler's ownership indexes. */
	get [SCHEDULER_INDEX_SIZES](): TaskScheduler["indexSizes"] {
		return this.#tasks.indexSizes;
	}

	// 测试用 getter：返回保留上下文的空闲状态与全量重算的差异。
	/** Internal, for tests: the kept contexts' idle state and its disagreements with a full recompute. */
	get [SCHEDULER_IDLE_STATE](): TaskScheduler["idleState"] {
		return this.#tasks.idleState;
	}

	// inspect 汇总调度状态、任务与提交：调度器提供 scheduling/tasks，Harness 扫描 queued/placed 提交并按 ID 合并。
	inspect(context: Context): Promise<HarnessInspection> {
		// readOnLine 让整个检查在同一 Session 线上完成，避免读到提交中间态。
		return this.readOnLine(async (storage) => {
			// registry.snapshot 提供任务定义的已知集合；inspect 据此标记 outdated/missing。
			const { scheduling, tasks } = await this.#tasks.inspect(this.#options.registry.snapshot());
			// scan 是分页扫描提交的局部函数；status 判别 queued/placed。
			const scan = (status: "queued" | "placed") =>
				scanAll((cursor) => storage.scanSubmissions({ status }, SCAN_PAGE_SIZE, cursor, context));
			// 合并两类提交并按 ID 排序；这是展示顺序，不是执行顺序。
			const submissions = [...(await scan("queued")), ...(await scan("placed"))].sort((a, b) => a.id - b.id);
			return { scheduling, tasks, submissions };
		});
	}

	// submission 按 ID 读取提交记录；不存在返回 undefined。
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		return this.#submissions.get(id, context);
	}

	// abortSubmission 取消一个尚未放置的提交；conversationId 可选，用于作用域校验。
	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found"> {
		return this.#submissions.abort(id, context, conversationId);
	}

	// abortTask 标记任务取消；返回 marked（已标记）或 terminal（已终态）。
	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		return this.#tasks.abort(id, context);
	}

	// waitForTask 等待任务终态；先 resume 确保睡眠任务被调度。
	async waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>> {
		this.#tasks.resume();
		return this.#tasks.waitForTask(id, context) as Promise<SettledTask<R>>;
	}

	// waitForIdle 等待整个 Harness 空闲；undefined 表示所有会话。
	async waitForIdle(context: Context): Promise<void> {
		this.#tasks.resume();
		return this.#tasks.waitForIdle(undefined, context);
	}

	// usage 汇总每个会话已提交的 pi.usage；文档各自读取，合计只增不减。
	/** Sum every conversation's committed `pi.usage`. Each document is read at its own point; totals only grow. */
	// 输入 context；返回新的 UsageState 合计对象。
	async usage(context: Context): Promise<UsageState> {
		// 分页扫描所有会话；scanAll 处理游标直到没有下一页。
		const conversations = await this.readOnLine((storage) =>
			scanAll((cursor) => storage.scanConversations({}, SCAN_PAGE_SIZE, cursor, context)),
		);
		// 从文档定义的 initial() 创建空合计；不要手写空对象，避免字段漂移。
		const total = UsageDoc.definition.initial();
		// 逐会话读取 pi.usage；文档可能不存在（旧会话/未使用模型）。
		for (const { id } of conversations) {
			// snapshot 返回已提交值；读取失败/不存在返回 undefined。
			const state = await this.snapshot(UsageDoc, id, context);
			// addUsageState 把单个会话的计数累加到合计；它不修改源文档。
			if (state !== undefined) addUsageState(total, state);
		}
		return total;
	}

	// watchTaskGraph 订阅任务图视图；返回 watch 句柄。
	watchTaskGraph(context: Context): Promise<TaskGraphWatch> {
		return this.#taskGraph.watch(context);
	}

	// observeTaskGraph 用观察者订阅任务图；assertUsable 防止关闭后订阅。
	async observeTaskGraph(observer: Observer<TaskGraph>, context: Context): Promise<Observation<TaskGraph>> {
		this.assertUsable();
		return this.#taskGraph.observe(observer, context);
	}

	// observeConversation 观察某个会话的视图；window 控制窗口大小。
	async observeConversation(
		id: ConversationId,
		observer: Observer<ConversationView>,
		context: Context,
		window?: ConversationWindow,
	): Promise<Observation<ConversationView>> {
		this.assertUsable();
		return this.#host.views.observe(id, observer, context, window);
	}

	// root 返回根会话；options 在创建提交里应用 agent 变更并运行 init。
	root(
		context: Context,
		options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
	): Promise<Conversation> {
		// target kind root；options 缺省为空对象。
		return this.#create({ kind: "root" }, options ?? {}, context);
	}

	// conversation 按 ID 打开已有会话的句柄；不存在返回 undefined，不创建。
	async conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> {
		this.assertUsable();
		// 读取会话记录；readOnLine 保证与创建/分叉提交串行。
		const record = await this.readOnLine((storage) => storage.conversation(id, context));
		return record === undefined ? undefined : new ConversationImpl(record.id, this.#host);
	}

	// createConversation 创建独立会话；ownership 由调用方指定。
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#create({ kind: "independent", ownership: options.ownership }, options, context);
	}

	// report 的公开重写：默认 kind 为 listener_error；转发到安全报告函数。
	override report(error: unknown, info: ReportInfo = { kind: "listener_error" }, context?: Context): void {
		this.#report(error, info, context);
	}

	// membershipKeys 让 Session 提交时写入/校验任务所有权成员索引；调度器根据事务中的任务变化计算键。
	/** The ownership memberships a commit's task changes write, from the scheduler's index. */
	// 转发给调度器；返回值允许同步数组或 Promise，Session 会 await。
	protected override membershipKeys(tx: Transaction): readonly string[] | Promise<readonly string[]> {
		return this.#tasks.membershipKeys(tx);
	}

	// beforeClose 在关闭监听器之后、Storage 关闭之前调用：通知并等待所有任务调用结束，不写任务结果。
	/** Signal and join task invocations after the close listeners and before Storage closes; writes no task outcome. */
	// join 会中止/等待正在运行的任务；错误由 Session 关闭流程报告。
	protected override beforeClose(): Promise<void> {
		return this.#tasks.join();
	}

	// #create 是三种创建路径的共同实现：在 commitWith 里创建/返回记录、应用 agent/init，然后构造句柄。
	async #create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation> {
		// 关闭后禁止创建。
		this.assertUsable();
		// commitWith 创建事务并提交；返回会话 ID，句柄在提交成功后构造。
		const id = await this.commitWith(async (tx) => {
			// root 已存在时直接复用 ID，不重复创建；tx.conversation 是事务内读取。
			if (target.kind === "root" && (await tx.conversation(ROOT_CONVERSATION_ID)) !== undefined) {
				return ROOT_CONVERSATION_ID;
			}
			// 根据 target 分支创建：root 用 createRootConversation，fork 用 forkConversation，independent 用 createConversation。
			const record =
				target.kind === "root"
					? await tx.createRootConversation()
					: target.kind === "fork"
						? await tx.forkConversation(target.parentId, target.at, { ownership: target.ownership })
						: await tx.createConversation({ ownership: target.ownership });
			// 便利 agent 变更在 conversationCreated 之后应用；configure 只修改文档草稿。
			if (options.agent !== undefined) await configure(tx, record.id, options.agent);
			// init 回调在同一事务里运行；它可以追加条目/文档，但读取表会抛 ReadAfterWrite。
			if (options.init !== undefined) await options.init(tx, record.id);
			return record.id;
		}, context);
		// 返回新句柄；句柄不持有事务，后续操作各自提交。
		return new ConversationImpl(id, this.#host);
	}

	// conversationCreated 是每个创建/分叉提交的内置钩子：初始化四个内置文档、复制 agent，再调用宿主钩子。
	/**
	 * The built-in creation hook, in every commit that creates or forks a conversation: empty `pi.live`, `pi.inbox`, and
	 * `pi.usage`, a fresh `pi.provider`, the conversation's `pi.agent` (see `createAgent()`), then
	 * `HarnessOptions.conversationCreated`.
	 */
	// 函数在事务里运行；record 是新会话记录。
	protected override async conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void> {
		// 读取四个文档的初始值（第一次 doc() 会写入 initial）；顺序不影响结果。
		await tx.doc(LiveDoc, record.id);
		await tx.doc(InboxDoc, record.id);
		await tx.doc(UsageDoc, record.id);
		await tx.doc(ProviderDoc, record.id);
		// 创建会话的 pi.agent：分叉已在 forkConversation 中复制，独立会话从空状态开始或复制拥有者。
		await createAgent(tx, record);
		// 宿主钩子最后运行，可以看到已初始化的内置文档；抛错会使创建提交失败。
		await this.#options.conversationCreated?.(tx, record);
	}
}

// safeReport 返回永不抛错的报告函数：先调用宿主 onReport（contained 捕获异常），再计数并记录事件。
/**
 * Report to `onReport`, then count it and record its event. Never throws, since reports also come from inside Storage's
 * `adopt`: a throwing `onReport` is dropped, and so is a throwing metric or event, as reporting it would report again.
 */
// 参数 onReport 可选；telemetry 提供 metrics 与事件上下文。
function safeReport(
	onReport: ((report: Report) => void) | undefined,
	telemetry: TelemetryContext,
): (error: unknown, info: ReportInfo, context?: Context) => void {
	// 创建计数器；createTypedMetrics 只为类型/命名约束，NOOP 时计数无副作用。
	const reports = createTypedMetrics(telemetry.metrics ?? NOOP_TELEMETRY_METRICS, [DURABLE_TELEMETRY_SCHEMA]).counter(
		"pi.durable.reports",
	);
	// 返回报告闭包；error 是原始错误，info 是分类信息，context 可选（用于事件）。
	return (error, info, context) => {
		// 有宿主报告器时调用；contained 保证 onReport 抛错被吞掉，空回调是失败处理。
		if (onReport !== undefined) {
			contained(
				() => onReport({ ...info, error }),
				() => {},
			);
		}
		// attributes 是 telemetry 事件的属性；type 总是 kind。
		const attributes: SpanAttributes = {
			type: info.kind,
		};
		// switch 按 report 种类填充不同字段；判别联合让 TypeScript 在分支中收窄 info。
		switch (info.kind) {
			case "task_faulted":
			case "task_interrupted":
			case "task_outdated":
				attributes.reason = info.reason;
				attributes.extension = info.extension;
				attributes["task.id"] = info.task.id;
				break;
			case "migration_failed":
			case "task_error":
			case "extension_error":
				attributes.extension = info.extension;
				attributes["task.id"] = info.task?.id;
				break;
			case "host_error":
				attributes["task.id"] = info.task?.id;
				break;
		}
		// 指标与事件写入也可能抛错（例如自定义 telemetry 适配器）；catch 后丢弃，因为报告报告器会再次失败。
		try {
			// 计数一次；标签只含 type，避免高基数。
			reports.add(1, { type: info.kind });
			// 记录事件；context 缺省时不记录。
			context?.telemetry.addEvent("pi.durable.report", attributes);
		} catch {
			// Dropped: see above.
		}
	};
}

// safeNow 包装宿主时钟：未提供时直接用 Date.now；提供时捕获异常并回退，第一次错误报告。
/**
 * The host clock, falling back to `Date.now` when it throws: a broken clock must not stop commits. The first throw is
 * reported; the clock is read in every task change, so later ones are not.
 */
// 输入可选 now 与报告函数；返回同步时钟。
export function safeNow(
	now: (() => number) | undefined,
	report: (error: unknown, info: ReportInfo) => void,
): () => number {
	// 没有自定义时钟：直接返回 Date.now 函数引用。
	if (now === undefined) return Date.now;
	// reported 是闭包状态，保证只报告第一次；任务变化每次都会读时钟，重复报告会淹没日志。
	let reported = false;
	// 返回包装时钟；每次读取都 try/catch。
	return () => {
		// 先尝试宿主时钟；成功直接返回。
		try {
			return now();
		} catch (error) {
			// Set first: a report handler that reads the clock again must not report again.
			// 先置位再报告：报告处理器若再次读取时钟，不会递归报告。
			if (!reported) {
				// 第一次错误：标记并报告 host_error/now。
				reported = true;
				report(error, { kind: "host_error", callback: "now" });
			}
			// 回退到 Date.now；即使宿主时钟损坏，提交仍能继续。
			return Date.now();
		}
	};
}

// boundConversation 构造绑定到任务调用的 ConversationHandle：每个操作先 check()，再在调用的 signal 下运行。
// 调用结束后句柄操作会拒绝，但已经准入的提交仍然持久化。
/**
 * Invocation-bound handle for tasks and tools. Every operation, and every operation of a submission it returns, first
 * checks the invocation and runs under its signal, so it rejects once the invocation ends; admitted work stays durable.
 */
// 参数 id、binding（任务调用绑定）、submissions、tasks；返回 ConversationHandle。
function boundConversation(
	id: ConversationId,
	binding: InvocationBinding,
	submissions: Submissions,
	tasks: TaskScheduler,
): ConversationHandle {
	// bind 把调用的中止信号叠加到调用方 Context；withAbortSignal 返回新 Context，不修改原对象。
	const bind = (context: Context): Context => withAbortSignal(binding.signal, context);
	// bound 是通用包装器：返回一个先检查有效性、再以绑定 Context 执行操作的函数。
	const bound = <T>(operation: (context: Context) => Promise<T>) => {
		// 返回异步函数；它保留原操作的参数形状。
		return async (context: Context): Promise<T> => {
			// check() 在调用已结束时抛错；这是运行时检查，不依赖类型系统。
			binding.check();
			// 操作在绑定 Context 下运行；取消会传播到存储/提交。
			return operation(bind(context));
		};
	};
	// submit 的两个重载与 Conversation 一致：草稿+Context 返回 Submission，Tx+草稿返回 ID。
	function submit(draft: SubmissionDraft, context: Context): Promise<Submission>;
	function submit(tx: Tx, draft: SubmissionDraft): Promise<SubmissionId>;
	// 实现签名覆盖两个重载；运行时按 first 是否带 type 字段判别。
	async function submit(
		first: SubmissionDraft | Tx,
		second: Context | SubmissionDraft,
	): Promise<Submission | SubmissionId> {
		// 调用有效性检查。
		binding.check();
		// The overloads pair a draft with a context, and anything else (a transaction) with a draft.
		// 非草稿分支（first 是 Tx）：提交由调用方事务负责，因此只检查调用的中止信号。
		if (!("type" in first)) {
			// Tx 分支：提交由调用方事务负责，这里只检查调用的中止信号并直接准入。
			// The caller's commit carries its own context, so the invocation's abort is checked here.
			// throwIfAborted 在调用已中止时抛出原因；否则继续准入。
			binding.signal.throwIfAborted();
			// Submissions.admit 在调用方事务内写入提交；second 断言为草稿。
			return submissions.admit(first, id, second as SubmissionDraft);
		}
		// 草稿+Context 分支：submit 会等待准入/运行，Context 叠加调用 signal。
		const submission = await submissions.submit(id, first, bind(second as Context));
		// 返回新 Submission 句柄；每个方法都再次绑定，防止句柄在调用结束后继续操作。
		return {
			id: submission.id,
			status: bound((callContext) => submission.status(callContext)),
			wait: bound((callContext) => submission.wait(callContext)),
			abort: bound((callContext) => submission.abort(callContext)),
		};
	}
	// 返回 ConversationHandle；id 是公开字段。
	return {
		id,
		submit,
		// abort 先检查调用有效性，再在绑定 Context 下取消会话任务。
		abort: async (context, options) => {
			binding.check();
			return tasks.abortConversation(id, options?.background === true, bind(context));
		},
		// waitForIdle 直接用 bound 包装调度器等待。
		waitForIdle: bound((callContext) => tasks.waitForIdle(id, callContext)),
	};
}

// Harness 类型别名：把实现类与接口分离，外部只依赖接口。
/** Durable agent harness over one Session. */
export type Harness = HarnessType;

// Harness 命名空间对象提供静态 open；与类型同名是 TypeScript 的声明合并。
export const Harness = {
	/** Open a Harness over storage. The registry may keep changing while the Harness runs. */
	// open 在存储上打开 Harness；registry 可以在运行期间继续变化（任务按名称解析最新定义）。
	async open<Tool extends ToolRegistration>(
		storage: Storage,
		options: HarnessOptions<Tool>,
		context: Context,
	): Promise<Harness> {
		// 打开前检查调用方 Context 已中止；避免在已取消的请求上做重活。
		context.abortSignal?.throwIfAborted();
		// 取注册表快照；open 校验的是打开时刻的内置任务集合。
		const snapshot = options.registry.snapshot();
		// BUILTIN_TASKS 列出所有内置任务；registry.task(名称) 缺失即视为不完整。
		const missing = BUILTIN_TASKS.filter((task) => snapshot.task(task.definition.name) === undefined);
		// 有缺失任务：Harness 无法恢复/运行它们，直接失败并给出名称。
		if (missing.length > 0) {
			// 用逗号连接缺失名称；错误消息提示用 createRegistry() 创建注册表。
			const names = missing.map((task) => task.definition.name).join(", ");
			throw new Error(`Registry lacks built-in tasks ${names}; create it with createRegistry()`);
		}
		// 构造 HarnessImpl；构造函数内部完成调度器/提交/视图接线。
		const harness = new HarnessImpl(storage, options, context);
		// try 只包住 openTasks：失败时需要关闭已构造的 Session，释放存储/监听器。
		try {
			await harness.openTasks(context);
			// 打开失败：调用方 Context 可能正是失败原因，所以用 withoutAbortSignal 关闭。
		} catch (error) {
			// 关闭失败会让 Session 进入失败状态并报告；这里吞掉关闭错误，保留原始 open 错误。
			// The caller's context may be what failed open: close without it, and rethrow the open error.
			// A failing Storage close fails the Session, which reports it.
			// close() 返回 Promise；catch(() => {}) 确保关闭错误不覆盖原始错误。
			await harness.close(withoutAbortSignal(context)).catch(() => {});
			// 重新抛出原始 open 错误。
			throw error;
		}
		// 打开成功：返回 Harness 接口（实现类已继承全部方法）。
		return harness;
	},
};
