// Durable 的实时任务图视图：把 Session 中仍存活的任务投影成不可变 TaskGraph，并在提交后推送给观察者。
// 所属：packages/durable/src/harness，Harness 的任务观察层（spec §9.4）。
// 上游：Harness.observeTaskGraph/watchTaskGraph 是公开入口；Harness 构造时通过 TaskGraphBlocking 注入
//   scheduler 的 blockedReason 与 subscribeBlocked，前者判断任务为何不能在当前注册表运行。
// 下游：TaskGraphView 用 SessionImpl.followCommits 读取已存储提交、subscribeClose 感知关闭、readOnLine 在
//   会话串行线上构建/刷新；用 Storage.scanTasks 与 scanConversations 做首次扫描；把 revision 交给
//   Observer/Watch（Chord watch），观察者抛出的错误交给 session.report。
// 职责边界：图只含 live 状态（pending/running/waiting/sleeping/completing）的任务；terminal 任务在对应提交
//   到达时删除。内存提交（publication.kind === "memory"）只改文档，不改变图，直接跳过。图不暴露 checkpoint
//   与 outcome 的正文，只保留 phase 字符串和 outcome 的状态；blocked 原因不落库，由 scheduler 按注册表现算。
// 结果与错误流：挂载的构建、阻塞刷新和发布都经 Session line 串行执行。观察者同步回调抛出的错误由 contained
//   捕获并上报，其余观察者仍收到同一 revision。Session 关闭时 #closed 置位并向所有观察者发 end：正常关闭时
//   watch 收到 ended、同步 observer 收到 failed("session closed")；失败关闭两者都收到 failed(原错误)。
//   关闭后 #attach 用 closedError 拒绝，不再登记观察者。
// 能力清单：
// - TaskGraphState：live 任务的精简状态联合，按 status 携带 phase、等待依赖与策略，或目标 outcome 状态。
// - TaskGraphNode：一个任务的 id/kind/会话、可选 owner、background/abortRequested、state、blocked、拥有的会话。
// - TaskGraph：全部 live 任务按十进制 ID 字符串索引的只读快照。
// - TaskGraphWatch：TaskGraph 的序列化 watch 句柄别名（WatchHandle<TaskGraph>）。
// - TaskGraphBlocking：scheduler 提供的阻塞原因查询，以及注册表变化时“原因可能改变”的通知订阅。
// - TaskGraphView：按需构建、随最后一个观察者释放的挂载；负责 observe/watch、阻塞刷新和关闭收尾。
// 组合与典型顺序：Harness 构造 -> new TaskGraphView(session, blocking)；首个 observe/watch -> #attach 在
//   Session line 上 #build 扫描并创建 Mount；每次 stored 提交 -> advance 计算 ops -> publish；
//   subscribeBlocked 通知 -> #refreshBlocked 重算 blocked；观察者 detach -> Mount 在无人使用时丢弃；
//   Session 关闭 -> 观察者收到 end。
// 示例（真实签名）：
//   const views = new TaskGraphView(session, {
//     blocked: (record) => tasks.blockedReason(record),
//     subscribeBlocked: (listener) => tasks.subscribeBlocked(listener),
//   });
//   const watch = await views.watch(context); // watch.value.tasks["7"]?.state.status
// 建议阅读顺序：先读 TaskGraphState/TaskGraphNode/TaskGraph 三个数据结构，再看 TaskGraphView 的 observe/watch
//   与 #attach 的挂载生命周期，随后读 advance 的两阶段变更处理和 publish，最后看 nodeOf/stateOf/phaseOf 投影。
import { BACKGROUND_CONTEXT, type Context, withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import { Watch, type WatchCall, type WatchHandle } from "@earendil-works/chord/watch";
import {
	closeEndOf,
	closeEnds,
	contained,
	guardObserver,
	type ObservedCommit,
	observation,
	type SessionImpl,
} from "../session/session.ts";
import type {
	ConversationId,
	JoinPolicy,
	Observation,
	Observer,
	Storage,
	TaskId,
	TaskOutcome,
	TaskRecord,
} from "../types.ts";
import { type BlockedReason, type BlockedSubject, blockedSubject } from "./scheduler.ts";
import { closedError, scanAll } from "./util.ts";

/** A live task's durable status without its checkpoint and outcome payloads (spec §9.4). */
/**
 * 图中的一个任务状态：只保留观察者需要的字段，不带 checkpoint 与 result 正文。
 * 输入/输出：纯类型，无运行时行为；由 stateOf 从 TaskState 投影得到。
 * 字段：pending/running 只有 phase；waiting 额外有 on（依赖的任务 ID）和 policy（failFast/allSettled）；
 *   sleeping 额外有 until（Harness 时钟的毫秒值）；completing 只留目标 outcome 的 status。
 * terminal 不在联合中：终止任务在提交处理时就从图里删除，观察者不会看到 terminal 节点。
 * 例：{ status: "waiting", phase: "review", on: [7], policy: "allSettled" }。
 */
export type TaskGraphState =
	// 两种状态共用形状：phase 是 checkpoint 的相位名，不含 checkpoint 其他字段。
	| { readonly status: "pending" | "running"; readonly phase: string }
	// 等待态把依赖与汇总策略原样暴露，观察者可据此展示“在等谁”。
	| {
			readonly status: "waiting";
			readonly phase: string;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
	  }
	/** Asleep until the Harness clock reaches `until`. */
	// until 是 HarnessOptions.now 时钟上的毫秒值；到点后任务从 checkpoint 的 phase 继续。
	| { readonly status: "sleeping"; readonly phase: string; readonly until: number }
	/** Outcome held until its ordinary owned work drains. */
	// 结果已决定但普通子任务尚未排空：只报告目标 outcome 的 status，不携带 result。
	| { readonly status: "completing"; readonly outcome: TaskOutcome<JsonValue>["status"] };

/**
 * 图中的一个完整节点：身份、归属、可中止标记、精简状态、阻塞原因和它拥有的会话。
 * 输入/输出：纯类型；由 nodeOf 生成，生成时省略值为 undefined 的可选字段。
 * owner 只在任务由另一个任务创建时存在；conversation-owned 任务没有 owner。
 * blocked 只表示“当前注册表无法接收该任务”，会随扩展注册/注销变化；运行时由 scheduler 计算，不是持久化字段。
 * conversations 是该任务拥有的会话 ID，按升序排列；它们由 session 表按 ownerTaskId 扫描得到。
 * 例：{ id: 7, kind: "summarize", conversationId: 3, owner: 5, background: false,
 *       abortRequested: false, state: { status: "pending", phase: "start" }, conversations: [8] }。
 */
export type TaskGraphNode = {
	// id 是全局数字 TaskId；kind 是注册表中的任务定义名；conversationId 是任务绑定的会话。
	readonly id: TaskId;
	readonly kind: string;
	readonly conversationId: ConversationId;
	/** Owner task; absent for a conversation-owned task. */
	// ? 让字段可省略；nodeOf 用条件展开保证 undefined 不会作为显式键出现。
	readonly owner?: TaskId;
	// background 表示它被排除在普通空闲等待、会话中止与级联之外；abortRequested 是已记录的中止标记。
	readonly background: boolean;
	readonly abortRequested: boolean;
	// state 是 stateOf 投影出的精简状态，不含 checkpoint 正文。
	readonly state: TaskGraphState;
	/**
	 * Why it cannot run here, when it cannot: no registered definition takes it (`missing_task`, `task_too_old`,
	 * `migration_failed`). Follows registry changes.
	 */
	readonly blocked?: BlockedReason;
	/** Conversations this task owns, in ID order. */
	readonly conversations: readonly ConversationId[];
};

/** Every live task of the Session (spec §9.4). */
/**
 * 一次 revision 的任务图：整个 Session 的 live 任务集合。
 * 输入/输出：纯类型；由 #build 首次扫描或 publish 的 applyImmutable 产生，每次发布都是新对象。
 * tasks 用字符串键是 JSON 对象的要求（Record<string, ...>）；键是 TaskId 的十进制文本，如 "7"。
 * Readonly 只在编译期阻止改写；运行时不冻结，观察者应把它当作不可变值。
 * 例：{ tasks: { "7": node7, "8": node8 } }。
 */
export type TaskGraph = {
	/** Every live task, keyed by its decimal ID. */
	// Readonly<Record<...>> 浅只读：不能替换或新增键，但节点内部仍由各字段的 readonly 约束。
	readonly tasks: Readonly<Record<string, TaskGraphNode>>;
};

// WatchHandle<T>：序列化观察句柄，value 保留最新已投递值；stop 或 context 取消会结束它。
// 别名让调用方不必再导入 Chord 类型。
export type TaskGraphWatch = WatchHandle<TaskGraph>;

// storage.scanTasks 返回的通用记录形状；checkpoint/result 都按 JsonValue 处理，图不解释其内容。
type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
// 一次挂载的内部状态：当前值、所有观察者，以及每个 live 任务的阻塞判定输入。
// records 只存 BlockedSubject（id/kind/version/abortRequested/abortReason/status），注册表变化时可重算而不必重扫。
type Mount = {
	value: TaskGraph;
	/** Watches and guarded host observers (`observeTaskGraph()`). */
	readonly observers: Set<Observer<TaskGraph>>;
	/** What the blocked reason reads of each live task, so a registry change can derive it again without payloads. */
	readonly records: Map<string, BlockedSubject>;
};

/** What the graph asks the scheduler: a task's blocked reason, and when reasons may change without a commit. */
/**
 * 图向 scheduler 提的两个问题；实现由 Harness 注入，本文件不依赖 scheduler 类。
 * blocked：给出任务的阻塞原因（missing_task / task_too_old / migration_failed）或 undefined；
 *   它只读取 BlockedSubject，不运行任务代码。
 * subscribeBlocked：注册“原因可能变化”的监听，返回取消订阅函数；扩展注册/注销不一定产生提交，
 *   所以需要这个旁路通知来刷新 blocked 字段。
 * 两个函数的具体实现不在本文件，其内部副作用由 scheduler 决定；抛出的错误会沿调用栈传到构建/刷新路径。
 * 例：{ blocked: (record) => tasks.blockedReason(record), subscribeBlocked: (listener) => tasks.subscribeBlocked(listener) }。
 */
export type TaskGraphBlocking = {
	readonly blocked: (record: BlockedSubject) => BlockedReason | undefined;
	// 返回 () => void 是取消订阅；TaskGraphView 构造时订阅一次且不保存取消函数：
	// 视图与 Harness 同生命周期，关闭后 listener 调用的 #refreshBlocked 会因 #closed 直接返回。
	readonly subscribeBlocked: (listener: () => void) => () => void;
};

// 首次构建要逐状态扫描；terminal 被排除，因为终止任务不属于 live 图。
// as const 让元素类型成为字面量联合，scanTasks 的 status 参数可按此收窄。
const LIVE_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const;
// 每次存储扫描的页大小；scanAll 会自动翻页，这个值只影响往返次数。
const SCAN_PAGE_SIZE = 256;

/**
 * The Harness's task graph mount: built on the Session line by its first observer and dropped with its last. It
 * advances from the Session's commit publications, which are durable.
 */
/**
 * 任务图的挂载管理：没有观察者时不占资源，首个观察者触发构建，最后一个离开时丢弃。
 * 输入：构造时给 SessionImpl（读取提交、串行线、关闭事件）和 TaskGraphBlocking（阻塞原因查询）。
 * 输出：observe 返回 Observation<TaskGraph>，watch 返回序列化 WatchHandle；自身不暴露当前值。
 * 副作用：订阅 followCommits 与 subscribeClose（构造时各一次）；观察者挂载时在 Session line 上扫描存储；
 *   发布时调用观察者的 advance，关闭时调用 end；不写任何表。
 * 错误：build/刷新中的存储错误使对应 Promise 拒绝或经 session.report 上报；观察者抛错被 contained 捕获；
 *   Session 关闭后 observe/watch 以 closedError 拒绝。
 * 流程：构造订阅 -> observe/watch 原子挂载 -> stored 提交 advance -> 阻塞通知刷新 -> 关闭/取消收尾。
 * 例：const view = new TaskGraphView(session, blocking); const watch = await view.watch(context);
 *     watch.value.tasks["7"]?.state.status。
 */
export class TaskGraphView {
	// # 前缀是 ECMAScript 私有字段：类外不可见，编译期与运行时都不暴露。
	// SessionImpl 是 Session 的内部接口，提供 readOnLine/followCommits/subscribeClose/report。
	readonly #session: SessionImpl;
	readonly #blocking: TaskGraphBlocking;
	// 首个观察者挂载前为 undefined；#closed 让关闭后不再接受新观察者，也跳过刷新。
	#mount: Mount | undefined;
	#closed = false;

	constructor(session: SessionImpl, blocking: TaskGraphBlocking) {
		// 保存依赖；构造函数不构建图，避免 Harness 启动时为无人观察的图扫描存储。
		this.#session = session;
		this.#blocking = blocking;
		// followCommits 监听已存储提交（stored）与仅内存提交（memory）；返回的取消函数不需要保存：
		// 该视图与 Session 同生命周期，关闭后挂载被清空，回调会因 #mount 为 undefined 自然短路。
		session.followCommits((publication, context) => {
			// A commit held in memory changes documents only, which the graph does not show.
			// 无挂载时无事可做；memory 提交只改文档，不改任务/会话表，因此不影响图。
			if (this.#mount === undefined || publication.kind === "memory") return;
			advance(this.#mount, publication, context, blocking.blocked, (error) => session.report(error));
		});
		// 扩展注册表变化可能让 blocked 原因改变，但没有提交可监听；用 scheduler 的通知主动刷新。
		blocking.subscribeBlocked(() => this.#refreshBlocked());
		session.subscribeClose(() => {
			// 先置关闭标记：此后 #attach 拒绝，刷新也直接返回。
			this.#closed = true;
			// closeEnds 一次给出 watch 与 observer 两个终止结果：Session 失败时两者都是 failed(原错误)；
			// 正常关闭时 watch 为 ended，observer 为 failed("session closed")，以便适配器跟随下一个 Session。
			// closeEndOf 再按跟随者实际类型选取对应的那个。
			const ends = closeEnds(this.#session.failure);
			// 展开成副本再遍历：观察者的 end 回调可能同步 detach，直接遍历 Set 会受删除影响。
			for (const observer of [...(this.#mount?.observers ?? [])]) {
				// contained 同时接住同步 throw 与异步拒绝；单个观察者失败不阻止其他观察者收到 end。
				contained(
					() => observer.end(closeEndOf(observer, ends)),
					(error) => session.report(error),
				);
			}
			// 丢弃挂载：观察者集合和缓存值都不再被引用，之后若再访问需重新构建（但 #closed 已阻止）。
			this.#mount = undefined;
		});
	}

	/**
	 * Attach a synchronous observer of the graph (`Harness.observeTaskGraph()`), behind `guardObserver()`; `context`
	 * governs only the attachment.
	 */
	/**
	 * 同步观察任务图：先挂载再返回初始值；返回的 detach 幂等，context 只约束“挂载这一刻”。
	 * 输入：Observer<TaskGraph>（advance/end）与 context；输出：Observation，含 value 与 detach。
	 * 副作用：在 Session line 上按需构建 Mount 并登记经 guardObserver 包装的观察者。
	 * 错误：构建/存储错误沿 Promise 拒绝；若挂载完成时 context 已取消，则 detach 后抛出 signal.reason。
	 * 注意：挂载成功后 context 再取消不会自动 detach；需要取消语义时用 watch。
	 * 例：const seen = await view.observe({ advance(call) {...}, end(end) {...} }, context); seen.detach();
	 */
	async observe(observer: Observer<TaskGraph>, context: Context): Promise<Observation<TaskGraph>> {
		// 明确赋值断言：value 在 #attach 的 create 回调中同步赋值，但 TS 无法跨回调证明，故用 !。
		let value!: TaskGraph;
		const attached = await this.#attach((current, release) => {
			value = current;
			// guardObserver 把 detach 与错误上报收进包装层：观察者抛错不会打断发布循环。
			return guardObserver(observer, release, (error) => this.#session.report(error));
		}, context);
		// 构建可能耗时，期间 context 可能被取消；此时不留下已登记的观察者。
		const signal = context.abortSignal;
		if (signal?.aborted) {
			attached.detach();
			throw signal.reason;
		}
		// observation 只保留 value 与已包装观察者的 detach，不持有挂载或其他观察者。
		return observation(value, attached.observer);
	}

	/** A serialized watch of the graph, an observer of its mount; aborting `context` ends it `aborted`. */
	/**
	 * 取得序列化 watch：一次只投递一个回调，期间的变化合并到下一帧；取消 context 会结束 watch。
	 * 输入：context；输出：Promise<WatchHandle<TaskGraph>>，含 value/start/stop 等 Chord 句柄成员。
	 * 副作用：挂载 Watch 观察者；context 的 abortSignal 被登记，watch 结束后自动解绑。
	 * 错误：构建错误拒绝；挂载后若已取消，调用 observer.abort() 并以 signal.reason 拒绝。
	 * 真实签名：watch(context: Context): Promise<WatchHandle<TaskGraph>>。
	 * 例：const watch = await view.watch(context); watch.start(async (call) => { void call.value; });
	 */
	async watch(context: Context): Promise<TaskGraphWatch> {
		// 只解构 observer；detach 已作为 release 传给 Watch，由它在停止/结束时调用。
		const { observer } = await this.#attach(
			(value, release) => new Watch<TaskGraph>(value, release, (error) => this.#session.report(error)),
			context,
		);
		const signal = context.abortSignal;
		// 挂载期间已取消：先以 aborted 终止刚挂载的 watch，再向调用方抛出取消原因。
		if (signal?.aborted) {
			observer.abort();
			throw signal.reason;
		}
		// 之后的取消由 observeAbort 监听；未提供信号时 watch 只受 stop/关闭影响。
		if (signal !== undefined) observer.observeAbort(signal);
		return observer;
	}

	/** Register an observer created from the current revision, atomically on the Session line. */
	/**
	 * 在 Session 串行线上原子挂载：复用现有 Mount，否则扫描构建；创建观察者后再确认未关闭/未取消。
	 * 输入：create 是“用当前值与 release 造观察者”的工厂，泛型 O 保留具体观察者类型（Observer 或 Watch）。
	 * 输出：{ observer, detach }；detach 从集合移除该观察者，最后一个离开时丢弃 Mount。
	 * 错误：存储错误拒绝 Promise；构建期间 Session 关闭抛 closedError；context 已取消抛 signal.reason。
	 * 例：const { observer } = await this.#attach((value, release) => new Watch(value, release, report), context);
	 */
	#attach<O extends Observer<TaskGraph>>(
		create: (value: TaskGraph, release: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		// readOnLine 把构建排到会话的串行线上：同一时刻不会有别的构建/提交处理并发改 this.#mount。
		return this.#session.readOnLine(async (storage) => {
			// ?? 只在没有挂载时构建；展开 Omit<Mount,"observers"> 并补上观察者集合。
			const mount = this.#mount ?? {
				...(await this.#build(storage, context)),
				observers: new Set<Observer<TaskGraph>>(),
			};
			// detach 引用稍后才初始化的 observer；本文件的两个 create 工厂都不会同步调用 release，
			// 因此闭包不会在 observer 初始化前执行，不触发 TDZ。
			const detach = (): void => {
				mount.observers.delete(observer);
				// 只有“当前挂载”且已空时才丢弃；旧挂载的 detach 不能误清新挂载。
				if (mount.observers.size === 0 && this.#mount === mount) this.#mount = undefined;
			};
			const observer = create(mount.value, detach);
			// Close or cancellation may begin while the mount builds; register nothing then.
			// 构建是 await 的，期间 Session 可能关闭或调用方取消：先检查，避免登记后立即泄漏。
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			// 两个检查都通过后才把挂载设为当前并登记观察者，保证不会出现“半挂载”。
			this.#mount = mount;
			mount.observers.add(observer);
			return { observer, detach };
		});
	}

	/** On the Session line: derive every node's blocked reason again, and publish the ones that changed. */
	/**
	 * scheduler 通知“注册表变了”时的刷新：不重扫存储，只对 mount.records 里的 BlockedSubject 重算 blocked。
	 * 输入：无（监听器签名是 () => void）；输出/副作用：把变化的 blocked 作为 delta 发布给观察者。
	 * 错误：readOnLine 在关闭/失败后拒绝，这里吞掉；真正的存储/发布错误已在行内交给 report。
	 * 流程：同步快筛 -> 排队到 Session line -> 在行内重新确认挂载 -> 计算最小 ops -> publish。
	 * 例：安装扩展后，某任务从 missing_task 变为 undefined，于是删除该节点的 blocked 字段。
	 */
	#refreshBlocked(): void {
		// 没有观察者就没有 Mount，无需刷新；关闭后也不再发布。
		if (this.#mount === undefined || this.#closed) return;
		this.#session
			.readOnLine(async () => {
				// 排队期间 Mount 可能因最后观察者 detach 而消失；在行内重新读取，不能信任行外的快照。
				const mount = this.#mount;
				if (mount === undefined) return;
				// Op 是 Chord 的 delta 元组联合：["s", path, value] 设置，["d", path] 删除。
				const ops: Op[] = [];
				for (const [key, record] of mount.records) {
					const blocked = this.#blocking.blocked(record);
					// 与当前发布值相同则跳过；?. 容忍节点已被删除的情况（此时两者应同为 undefined）。
					if (blocked === mount.value.tasks[key]?.blocked) continue;
					// 原因消失时删除字段而不是写入 undefined，保持节点对象是严格 JSON。
					ops.push(
						blocked === undefined ? ["d", ["tasks", key, "blocked"]] : ["s", ["tasks", key, "blocked"], blocked],
					);
				}
				// 内部刷新不属于任何调用方，用 BACKGROUND_CONTEXT 且不带调用方取消信号。
				publish(mount, ops, BACKGROUND_CONTEXT, (error) => this.#session.report(error));
			})
			// Rejected only once the Session is closing or failed.
			// 这个拒绝只来自关闭/失败中的 Session，已无接收者可上报；行内的存储与发布错误交给 report。
			.catch(() => {});
	}

	/** Read the graph on the line, through the line's `storage`. */
	/**
	 * 首次构建：按 live 状态扫描全部任务，再为每个任务扫描它拥有的会话，生成初始 TaskGraph 与 records 索引。
	 * 输入：行内的 Storage 与 context；输出：Omit<Mount, "observers">，观察者集合由 #attach 补上。
	 * 副作用：只读扫描，不写存储；顺序扫描每个状态与每个任务的会话。
	 * 错误：任一页扫描失败都会拒绝，挂载随之失败，不留下部分 Mount。
	 * 例：两个 pending 任务、一个 waiting 任务 -> records 按 id 升序，tasks 键为 "7"/"8"/"9"。
	 */
	async #build(storage: Storage, context: Context): Promise<Omit<Mount, "observers">> {
		// tasks 是可变的普通对象，构建完作为 Mount.value 的一次 revision；之后不再原地修改。
		const tasks: Record<string, TaskGraphNode> = {};
		// live 保存每个任务的 BlockedSubject，供后续注册表变化时重算 blocked，不必重扫记录。
		const live = new Map<string, BlockedSubject>();
		const records: AnyTaskRecord[] = [];
		// 每个状态单独分页扫描；scanAll 负责翻页并把页内元素按序拼起来。
		// 展开进 push 时仍保持“状态 -> 页序”的局部顺序，最后统一按 id 排序。
		for (const status of LIVE_STATUSES) {
			records.push(...(await scanAll((cursor) => storage.scanTasks({ status }, SCAN_PAGE_SIZE, cursor, context))));
		}
		// 跨状态合并后必须全局排序：不同状态的分页顺序无法保证整体按 id 递增。
		records.sort((a, b) => a.id - b.id);
		for (const record of records) {
			// ConversationQuery.ownerTaskId 查的是会话的创建者边；返回 ConversationRecord。
			const owned = await scanAll((cursor) =>
				storage.scanConversations({ ownerTaskId: record.id }, SCAN_PAGE_SIZE, cursor, context),
			);
			// 只保留会话 ID 并升序排列，节点的 conversations 字段因此不受扫描顺序影响。
			const conversations = owned.map((conversation) => conversation.id).sort((a, b) => a - b);
			// 只抽取阻塞原因需要的字段；checkpoint/result 正文不会留在 Mount 中。
			const subject = blockedSubject(record);
			// 对象键必须是字符串；TaskId 是数字品牌类型，String() 得到十进制文本。
			tasks[String(record.id)] = nodeOf(record, conversations, this.#blocking.blocked(subject));
			// records 与 tasks 使用同一个键，刷新时按 key 直接找当前节点的 blocked。
			live.set(String(record.id), subject);
		}
		return { value: { tasks }, records: live };
	}
}

/**
 * Derive the mount's operations from one publication, apply them, and hand the revision to every observer; one that
 * throws is reported through `report`, and the others still get it.
 */
/**
 * 把一次 stored 提交折算成最小 delta：先处理 task 变更，再处理 conversation 变更，最后统一发布。
 * 输入：当前 Mount、提交发布（stored，调用方已过滤 memory）、提交 context、blocked 查询和错误上报。
 * 输出：无；副作用是更新 mount.value/mount.records 并调用观察者 advance。
 * 错误：blocked 查询或发布中的观察者错误由 report 接收；本函数不抛出业务错误。
 * 流程：任务两阶段（新增/更新/删除）-> 按 owner 合并新会话 -> publish。
 * 例：提交新建任务 7 和它的会话 9 -> ops 依次设置 tasks["7"] 与 tasks["7"].conversations=[9]。
 */
function advance(
	mount: Mount,
	publication: ObservedCommit,
	context: Context,
	blocked: TaskGraphBlocking["blocked"],
	report: (error: unknown) => void,
): void {
	const ops: Op[] = [];
	// Nodes this publication set or deleted, over the mount's value.
	// changed 叠加在 mount.value 之上：提交内 change 顺序未定义，后续判断要看到同一提交里已算出的节点。
	// 值允许 undefined，表示本提交删除了该节点，与“从未出现”区分开。
	const changed = new Map<string, TaskGraphNode | undefined>();
	const node = (key: string): TaskGraphNode | undefined =>
		changed.has(key) ? changed.get(key) : mount.value.tasks[key];
	for (const change of publication.changes) {
		// 本视图只关心 task 表；entry/submission/document 等变更与图无关。
		if (change.type !== "task") continue;
		const record = change.value;
		const key = String(record.id);
		const previous = node(key);
		if (record.state.status === "terminal") {
			// 终止任务不再是 live：先从阻塞索引删除，图里若存在对应节点再发删除 op。
			mount.records.delete(key);
			// 从未发布过（例如构建前就终止）则无 op 可发。
			if (previous === undefined) continue;
			ops.push(["d", ["tasks", key]]);
			changed.set(key, undefined);
			continue;
		}
		// 非终止状态更新阻塞索引；即使节点内容没变，records 也要跟随最新记录。
		const subject = blockedSubject(record);
		mount.records.set(key, subject);
		// 任务提交本身不带“它拥有的会话”，沿用上一 revision 的列表；新会话由第二遍 conversation 变更补上。
		const next = nodeOf(record, previous?.conversations ?? [], blocked(subject));
		// 深比较避免无意义的发布：JSON.stringify 对同一键序的普通对象给出稳定文本。
		// 这里比较的是 nodeOf 的产物，字段插入顺序由同一函数固定，因此文本比较可用。
		if (previous !== undefined && JSON.stringify(next) === JSON.stringify(previous)) continue;
		// TaskGraphNode 的字段实际都是 JSON，但该类型没有 JsonValue 需要的索引签名，
		// 品牌 ID 与 readonly 结构也让 TS 无法自动证明，故显式断言。
		ops.push(["s", ["tasks", key], next as unknown as JsonValue]);
		changed.set(key, next);
	}
	// After the tasks, so a conversation created with its owner task in one commit finds the owner's node. Change order
	// within a publication is unspecified, so each owner's list is sorted again.
	// 第二遍才处理会话：同一提交可能先出现会话 change、后出现 owner task change，先任务可保证 owner 节点存在。
	// created 按 owner 任务键聚合本提交新增的会话 ID。
	const created = new Map<string, ConversationId[]>();
	for (const change of publication.changes) {
		// 只关心有 owner 的会话；ownerless 会话不属于任何任务节点。
		if (change.type !== "conversation" || change.value.owner === undefined) continue;
		const key = String(change.value.owner.taskId);
		// owner 节点可能已在同一提交中终止/删除，此时没有列表可追加。
		if (node(key) !== undefined) created.set(key, [...(created.get(key) ?? []), change.value.id]);
	}
	for (const [key, ids] of created) {
		// ! 是明确断言：上一循环已确认 node(key) 存在，且本循环不再改任务节点。
		// 展开旧列表并追加本提交的 ID，再排序，抵消提交内 change 顺序不确定的影响。
		const conversations = [...node(key)!.conversations, ...ids].sort((a, b) => a - b);
		ops.push(["s", ["tasks", key, "conversations"], conversations]);
	}
	publish(mount, ops, context, report);
}

/** Apply `ops` to the mount and hand the revision to every observer; one that throws is reported. */
/**
 * 应用 delta 并广播新 revision：空 ops 不发布；每个观察者收到同一 value 与 ops。
 * 输入：Mount、已计算的 ops、来源 context、错误上报函数；输出/副作用：替换 mount.value 并同步调用 advance。
 * 错误：applyImmutable 自身的错误会抛出；观察者错误由 contained 捕获后交给 report，不打断其他观察者。
 * 例：ops 为空时直接返回，观察者不会收到“无变化”的空帧。
 */
function publish(mount: Mount, ops: Op[], context: Context, report: (error: unknown) => void): void {
	// 没有实际变化就不产生新 revision，避免观察者做无意义的重绘。
	if (ops.length === 0) return;
	// applyImmutable 按 delta 生成新的不可变值；这里只替换引用，不原地改旧 revision。
	mount.value = applyImmutable(mount.value, ops);
	// 帧 context 去掉取消信号：提交/刷新结束后原 signal 可能已中止，观察者不应把过去的帧当作已取消。
	const frameContext = withoutAbortSignal(context);
	// retired 为 false：本视图不会“退休”某个值；watch 的终止走 end/abort，而不是 value 帧。
	const call: WatchCall<TaskGraph> = { kind: "value", value: mount.value, ops, retired: false };
	// 复制观察者集合再遍历：advance 内同步 detach 不影响本轮其他观察者。
	for (const observer of [...mount.observers]) contained(() => observer.advance(call, frameContext), report);
}

/**
 * 从持久化记录投影出一个图节点；纯函数，不读存储、不修改输入。
 * 输入：任意 live TaskRecord、已扫描出的会话 ID、当前阻塞原因；输出：TaskGraphNode。
 * 可选的 owner/blocked 用条件展开省略，而不是写成 undefined，保证对象只含 JSON 值。
 * 例：record.owner 为 undefined 时结果没有 owner 键。
 */
function nodeOf(
	record: AnyTaskRecord,
	conversations: readonly ConversationId[],
	blocked: BlockedReason | undefined,
): TaskGraphNode {
	return {
		// 直接沿用记录的字段；id 的品牌类型在赋值时保持不变。
		id: record.id,
		kind: record.kind,
		conversationId: record.conversationId,
		// 三元 + 展开：条件对象展开只在有 owner 时加入键。
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
		abortRequested: record.abortRequested,
		// stateOf 负责把完整 TaskState 缩成 TaskGraphState。
		state: stateOf(record),
		conversations,
		// 同上：无阻塞原因时不写 blocked 键，避免严格 JSON 中出现 undefined 属性。
		...(blocked === undefined ? {} : { blocked }),
	};
}

/**
 * 把持久化 TaskState 投影为不含正文的 TaskGraphState；纯函数。
 * 输入：任意 live TaskRecord；输出：按 status 分支的状态对象。
 * 流程：switch 收窄联合类型；pending/running、waiting、sleeping 各自只保留图需要的字段。
 * 例：waiting 记录 -> { status: "waiting", phase, on: [...], policy }。
 */
function stateOf(record: AnyTaskRecord): TaskGraphState {
	const state = record.state;
	// switch 对 state.status 做判别式收窄：每个 case 内可直接访问该分支独有字段。
	switch (state.status) {
		case "pending":
		case "running":
			// 两种状态共享 checkpoint 字段，phase 从 checkpoint 读取。
			return { status: state.status, phase: phaseOf(state.checkpoint) };
		case "waiting":
			// on 是 readonly TaskId[]；展开复制成普通数组，避免节点持有记录里的同一数组引用。
			return { status: "waiting", phase: phaseOf(state.checkpoint), on: [...state.on], policy: state.policy };
		case "sleeping":
			return { status: "sleeping", phase: phaseOf(state.checkpoint), until: state.until };
		// Terminal records never reach here: they leave the graph.
		// terminal 与 completing 共用 outcome.status：前者理论上不可达（advance 已删除节点），
		// 合并只为让 switch 覆盖联合的所有成员，不需要额外分支。
		case "completing":
		case "terminal":
			return { status: "completing", outcome: state.outcome.status };
	}
}

/**
 * 读取 checkpoint 顶层的 phase 字符串；checkpoint 被声明为 JsonValue，故需要断言。
 * 这是 scheduler 写入 checkpoint 时保证的形状（任务 checkpoint 约定），不是对任意输入的运行时校验。
 * 例：{ phase: "execute", ... } 得 "execute"。
 */
function phaseOf(checkpoint: JsonValue): string {
	// as 把 JsonValue 断言为带 phase 的对象；若 checkpoint 是缺少 phase 的非空对象，这里得到 undefined；
	// 若 checkpoint 本身是 null，访问 .phase 仍会抛 TypeError。函数不做运行时校验。
	return (checkpoint as { readonly phase: string }).phase;
}
