// 文件导读：Durable Session 内核
//
// 所属包与模块：packages/durable/src/session，Durable（@earendil-works/pi-durable）的核心会话层。
// 本文件实现 Session：一条串行变更线（mutation line）、提交与发布流水线、文档追踪缓存、延迟持久化、观察者
// 通知、关闭与失败处理。上游通过 createSession() 创建它，Harness 和应用再调用 commit()、snapshot()、watchDoc()、
// observeDoc()、snapshotAsOf()、observeCommits()、subscribeClose() 和 close()。
//
// 职责边界：Session 拥有提交顺序、已提交状态的可观察性、文档 tracker 缓存和 Storage 失败策略；它不实现具体
// 持久化（Storage）、不决定任务调度（Harness/Scheduler），也不定义文档业务语义（documents.ts/definitions）。
// 下游依赖：Transaction（构造并落盘一批写入）、Writer（逻辑准入、分组提交与发布）、CachedStorage、
// ConversationTails、GatedStorage、原始 Storage，以及 Chord 的 context/watch/delta 工具。
// 错误流向：任何 Storage 调用（除 StorageRequestError 或调用方取消的读）抛错都会经 GuardedStorage 使 Session
// 失败；失败是最终的，之后调用得到 SessionFailed，close 仍会关闭后端。提交回调、监听器和计时器的错误各有
// 不同边界，详见对应方法。
//
// 能力清单：
//   - createSession：公开工厂，配置时钟、文档保留期、计时器、延迟提交窗口和只读模式，返回 Session。
//   - ObservedCommit：Session 内部观察者看到的“已存储提交”或“仅内存采用”的提交。
//   - SessionImpl：Session 接口实现，包含提交、读、文档 watch、关闭、缓存/淘汰、延迟提交、线路排队与失败守卫。
//   - GuardedStorage（文件内私有）：包在 Storage 外面的失败守卫；每个调用先检查失败/关闭状态，再决定是否让
//     整个 Session 失败。
//   - documentRetention/persistWithin：把可选毫秒值校验成合法窗口，否则使用默认值。
//   - setDefaultDocumentRetention：仅供测试修改默认文档保留期。
//   - contained/guardObserver/closeEnds/closeEndOf/observation/ENDED 等模块辅助函数：封装回调错误、观察者
//     生命周期和关闭结束原因。
//
// 提交流程示例（示例，不是运行时日志）：
//   const session = createSession(storage);
//   const entry = await session.commit((tx) => tx.appendEntry(conversationId, { kind: "note" }), context);
//   await session.close(context);
//   commit() -> commitWith() -> #enqueue() -> #runCommit()：回调在 Transaction 中读写，成功结算出 writes。
//   #runCommit() 把 writes、键和发布回调交给 Writer；Writer 让 Storage 分组提交，stored 回调更新缓存，
//   发布时 #adopt()/#publish() 更新内存、通知观察者；最后结果按线路顺序交付给调用方。
//   若 options.persistence 为 deferred 且事务满足条件，写入先只在内存采用（#hold），随后由 #storeHolds 落盘。
//
// 建议阅读顺序：先读类型/常量与 createSession，理解配置入口；再看 SessionImpl 的字段和 constructor，建立
// “线路、缓存、Writer、守卫”四块结构；然后读 latestEntryId/touch/commit 等公开入口；接着按 #runCommit ->
// #adopt -> #publish -> #enqueue 追一条提交；之后读文档缓存/淘汰（#touchDocument 到 #pinDocument）和延迟提交；
// 最后读模块辅助函数与 GuardedStorage。
//
// ---------------------------------------------------------------------------
import { awaitWithContext, BACKGROUND_CONTEXT, type Context, withoutAbortSignal } from "@earendil-works/chord/context";
import { type Op, PendingOps, track } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import { Watch, type WatchEnd } from "@earendil-works/chord/watch";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import {
	type AnyDocToken,
	addressId,
	checkRecordScope,
	checkRecordVersion,
	materializeDocument,
	resolveAddress,
} from "../documents.ts";
import { ReadOnlySession, SessionFailed, StorageRequestError } from "../errors.ts";
import { idFromNumber } from "../ids.ts";
import { hostTimers, type Timers } from "../timers.ts";
import type {
	CommitChange,
	CommitObservation,
	CommitObserver,
	CommitOptions,
	CommitPersistence,
	CommitPublication,
	CommitResult,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentCommitChange,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	DocumentWatch,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Observation,
	Observer,
	Page,
	ReportInfo,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	Seq,
	Session,
	SessionDocFamilyToken,
	SessionDocToken,
	SessionEnd,
	SetTimer,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskQuery,
	TaskRecord,
	Tx,
} from "../types.ts";
import { CachedStorage, scopeOf } from "./cached-storage.ts";
import { ConversationTails, type HeadMarker } from "./conversation-tails.ts";
import { ALL_KEYS, appendKey, conversationKey, documentKey, GatedStorage, incarnationKey } from "./keys.ts";
import {
	type AdoptedDocuments,
	type HeldDocument,
	type LoadedDocument,
	storeHeld,
	Transaction,
	type TransactionHost,
	type TransactionScope,
} from "./transaction.ts";
import { type PublishFailure, Writer } from "./writer.ts";

// Session 内部观察者看到的一次提交，用于让调度器等组件把内存状态与已存储状态同步。
// stored：已经存入 Storage 的提交，带提交序号和全部表/文档变化；memory：deferred 提交只在内存采用，
// 只有文档变化，没有 seq，因为还没有落盘。kind 是判别字段；后续分支据此收窄 changes 的元素类型。
/**
 * What the Session's own components observe of one commit (`followCommits()`): a stored commit with its own changes, or
 * a deferred one adopted in memory only (`CommitPersistence`), which changes documents only. Memory is never behind:
 * a later store of held changes is not observed again.
 */
export type ObservedCommit =
	| { readonly kind: "stored"; readonly seq: Seq; readonly changes: readonly CommitChange[] }
	| { readonly kind: "memory"; readonly changes: readonly DocumentCommitChange[] };

// Session 保存的 held 文档：在 HeldDocument（缓存中的已加载文档 + 待存操作）上增加 deadline 和 unpin。
// deadline 用 Session 时钟表示该文档最早一个延迟提交的落盘期限；unpin 用于释放缓存 pin。
/** A held document (`HeldDocument`) as the Session keeps it: pinned in the cache until stored. */
type Hold = HeldDocument & {
	/** When the earliest of its held commits must be stored, on the Session clock. */
	deadline: number;
	readonly unpin: () => void;
};

// 已经武装的 held 文档落盘计时器：at 是目标时钟时间，disarm 取消计时器，fired 表示对应线路任务已排队。
// fired 后不能仅因 at 相同就跳过重新武装；要等任务真正处理完。
/** The armed store of held documents: a foreground timer for the earliest deadline, `fired` once its job is queued. */
type HoldTimer = { readonly at: number; disarm: () => void; fired: boolean };

// 空 held 列表的共享常量：避免在热路径上反复分配空数组；调用方只读，不修改它。
const NO_HOLDS: readonly Hold[] = [];

// 空操作列表的共享常量：用于没有 delta 的发布（如 retirement），避免重复分配。
const NO_OPERATIONS: readonly Op[] = [];

// 线路任务在线内阶段的结果：value 是提交回调的返回值；after 是 Writer 的发布/落盘结果（如果有提交）。
// after 存在时，任务对外结果必须等它完成；不存在时任务可以只按线路顺序交付。
/** A line job's result: its value, delivered once `after`, the publication of its commit, settles, if it has one. */
type Ran<T> = { readonly value: T; readonly after?: Promise<void> };

// 一个线路任务的元数据：index 是线路顺序号；hit 记录它的读取是否真的等过未发布写入；
// ends 保存 onJobEnd() 注册的回调，在该任务结果结算后统一执行。
/** A job on the line: its index in line order, and whether a touch of it waited for an unpublished writer. */
type Job = {
	readonly index: number;
	hit: boolean;
	/** Called once its outcome settles: its commit published, or never to be (`onJobEnd()`). */
	ends?: (() => void)[];
};

// 空键列表的共享常量，供不需要额外 membership 键的普通 Session 使用。
const NO_KEYS: readonly string[] = [];

/**
 * Jobs admitted to the line whose outcome is not delivered yet, beyond which the line waits. A count, not bytes: what
 * waits is bounded by what one commit can hold (tool output by its output limits), times the count.
 */
// 同时在途、尚未交付结果的任务上限；线路在此暂停，形成背压。计的是任务数而不是字节数。
const MAX_OUTSTANDING = 256;

// 丢弃参数并返回 void 的辅助函数，用于 then 的成功/失败回调中明确“不处理这个值”。
const ignore = (): void => {};

/**
 * Queues a commit's host dispatch as one microtask through `then`: in the same queue as `queueMicrotask()`, which Node
 * wraps in an async resource that costs about twice the memory and three times the time per stored commit.
 */
// 一个已 resolve 的 Promise，用来把 host 观察者分发排进微任务队列，而不是 queueMicrotask 的额外开销。
const SETTLED: Promise<void> = Promise.resolve();

/** The default source of a report: a listener, which never fails what ran it. */
// 默认的报告来源：外部监听器错误；报告本身不应让触发它的操作失败。
const LISTENER: ReportInfo = { kind: "listener_error" };

/** A telemetry adapter that threw on a commit's event, which must not fail the durable commit. */
// 遥测适配器抛错时的报告来源；遥测失败绝不能影响已经持久的提交。
const TELEMETRY: ReportInfo = { kind: "host_error", callback: "telemetry" };

// 公开工厂：在给定 Storage 上创建一个普通（非只读、无 Harness 扩展）Session。
// 参数：storage 是持久化后端；options 可配置 now 时钟、documentRetentionMs、setTimer、persistWithinMs。
// 返回 Session 接口；构造本身不做 IO，实际读写发生在后续方法中。
// 示例：const session = createSession(storage, { documentRetentionMs: 60_000 });
/**
 * Open a Session kernel over one storage backend. `now` is the wall clock for task times; default `Date.now`.
 * `setTimer` arms the timers that evict idle documents; default `setTimeout` (see `HarnessOptions.setTimer`). The first
 * error a Storage method throws fails the Session (`SessionFailed`); see `SessionImpl`.
 */
export function createSession(
	storage: Storage,
	options?: {
		readonly now?: () => number;
		readonly documentRetentionMs?: number;
		readonly setTimer?: SetTimer;
		/** Default `withinMs` of a deferred commit (`CommitPersistence`); default 1,000. */
		readonly persistWithinMs?: number;
	},
): Session {
	const retention = options?.documentRetentionMs;
	const within = options?.persistWithinMs;
	return new SessionImpl(
		storage,
		options?.now,
		retention === undefined ? undefined : () => retention,
		options?.setTimer,
		false,
		() => within,
	);
}

/** Default document retention: ten minutes, as for kept contexts. */
// 默认文档保留期：10 分钟（600000 ms）。Session 未被显式配置时使用这个值。
let defaultRetention = 600_000;

// 仅供测试：修改所有“使用默认保留期”的 Session 的默认值。返回 void，有全局副作用。
// 它不是公共运行时配置入口；生产代码应通过 createSession/documentRetentionMs 指定。
/** Internal, for tests: the retention of every Session that keeps the default, as a suite run with eviction at once. */
export function setDefaultDocumentRetention(ms: number): void {
	defaultRetention = ms;
}

// 把调用方给的保留期规范化为毫秒数：是 number 且 >= 0 时采用（Infinity 也合法，表示永不淘汰），
// 否则返回默认值。这里的 typeof/比较是运行时校验，因为选项来自 JS/外部配置，类型系统不能保证。
// 示例：documentRetention(0) === 0；documentRetention(undefined) === 600000；documentRetention(-1) 用默认值。
/**
 * A retention as given, when it is a number of milliseconds, `0` or more (`Infinity` keeps documents); otherwise the
 * default.
 */
export function documentRetention(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : defaultRetention;
}

/** Default `withinMs` of a deferred commit, `settings.progress.persistWithinMs`. */
// deferred 提交的默认落盘窗口：1000 ms；可由 settings.progress.persistWithinMs 覆盖。
const DEFAULT_PERSIST_WITHIN_MS = 1_000;

// 把 deferred 提交的 withinMs 规范化为毫秒数：number 且 >= 0 时采用（Infinity 表示等下一次读/写或关闭），
// 否则使用默认 1000 ms。运行时校验用于公开选项边界。
// 示例：persistWithin(0) === 0；persistWithin(undefined) === 1000。
/**
 * A deferred commit's default window as given, when it is a number of milliseconds, `0` or more (`Infinity` waits for a
 * reading or writing commit or close); otherwise the default.
 */
export function persistWithin(ms: number | undefined): number {
	return typeof ms === "number" && ms >= 0 ? ms : DEFAULT_PERSIST_WITHIN_MS;
}

// Session 的具体实现：所有提交串行经过同一条线路，缓存与观察者围绕这条线路保持一致。
// 下面先看字段（线路、缓存、Writer、失败状态），再看 constructor 如何把它们接起来。
/**
 * Session kernel: one mutation line, the loaded document tracker cache, and committed publication.
 *
 * The cache is bounded by use: a document with no watch attached leaves it once it was not read or
 * written for the retention period, and the next access loads it from Storage. Eviction runs as a job on the mutation
 * line, so no transaction ever holds a tracker that leaves.
 *
 * Only committed state is observable. A deferred commit (`CommitPersistence`) is committed in memory first: it is
 * adopted and shown to the Session's own observers, and its changes wait, folded per document and pinned in the cache,
 * for the first commit that reads or writes the document, the document's deadline, a drop of its tracker, or close,
 * which store them.
 *
 * Group commit: the line runs one job at a time, a commit's callback and settlement; a commit with writes then joins
 * the writer's pending batch (logical admission, `Writer`) and the line goes on. The writer stores every commit admitted
 * while no call is in flight in one `commit()` call, off the line, and publishes them one by one, in line order, a
 * macrotask apart: the read caches, adoption, telemetry events, the Session's own observers, and one microtask later
 * `observeCommits()` observers, before every wait the commit resolves and every abort it queues. Host listeners and
 * watch listeners have no order. A deferred commit is published when the commits before it are. A job's every read
 * touches its key (`touch()`); while an unpublished commit writes that key, the job waits for its publication, so no
 * job observes state that is not stored. Outcomes are delivered in line order (`#enqueue()`).
 *
 * Storage failures are final. Every Storage call goes through one guard: the first error a Storage method throws, other
 * than for a cancelled caller, fails the Session, as does a commit it cannot adopt. That call gets the error; every later
 * call and every Storage call still underway gets `SessionFailed`; close listeners run at once with the error, and the
 * Session then closes itself, Storage included, and `closed` settles. Nothing retries: transient errors are the
 * Storage's to retry. Reopening recovers from what was committed.
 */
export class SessionImpl implements Session {
	// 带失败守卫的 Storage；Session 的所有后端 IO 都经它，避免某个错误后继续使用不可信状态。
	readonly #storage: GuardedStorage;
	// 会话尾部缓存；只读 Session 没有它，因为另一个进程可能写入 Storage，缓存会过期。
	/** Newest entry and head marker per conversation; none for a read-only Session, whose Storage another process writes. */
	readonly #tails: ConversationTails | undefined;
	// 本 Session 创建过的活任务 -> 其当前文档记录。任务终结时可直接退休这些文档，不必扫描 Storage。
	// Map 的记录只随活任务增长；#indexTaskDocuments 在发布时维护它。
	/**
	 * The current documents of each live task this Session created, so the commit that ends a task retires them without
	 * a scan. An entry starts with its task's creation and goes when the task is terminal: bounded by live tasks.
	 */
	readonly #taskDocuments = new Map<TaskId, Map<DocumentId, DocumentRecord>>();
	// 文档缓存：逻辑地址字符串 -> 已加载的 incarnation/tracker。key 来自 addressId(address)。
	readonly #documents = new Map<string, LoadedDocument>();
	// 没有观察者的缓存文档，按最后使用时间从旧到新排列；用于淘汰。值是 Session 时钟时间。
	/** Cached documents with no observer attached, by address, oldest use first, with the time of that use. */
	readonly #idleDocuments = new Map<string, number>();
	// 每个文档 incarnation（DocumentId）当前挂了多少个观察者；> 0 时不能被淘汰。
	/** Observers attached per document incarnation (record ID); a cached incarnation with any is never evicted. */
	readonly #attachedDocuments = new Map<DocumentId, number>();
	// Session 时钟包装：应用传入的 now 抛错时退回 Date.now，缓存记账不能改变业务结果。
	readonly #clock: () => number;
	// 每次读取保留期的函数；应用回调抛错时退回合法默认值，而不是让淘汰路径崩溃。
	readonly #documentRetentionMs: () => number;
	// 每次读取 deferred 默认窗口的函数；应用回调抛错时退回合法默认值。
	readonly #persistWithinMs: () => number;
	// 带未落盘变更的文档：DocumentId -> Hold。每个文档的多次 deferred 变更折叠在 Hold.pending 中。
	/** Documents with held changes, by incarnation (record ID); each is pinned in the cache until they are stored. */
	readonly #holds = new Map<DocumentId, Hold>();
	// 当前 foreground 落盘计时器；没有 held 文档或 Session 正在关闭时为 undefined。
	#holdTimer: HoldTimer | undefined;
	// 只读 Session 拒绝任何带写入的提交；它也不维护缓存和尾部缓存，因为后端可能被别的进程修改。
	/** Refuse every commit with writes (`HarnessOptions.readOnly`). */
	readonly #readOnly: boolean;
	// 宿主计时器封装（foreground/background）；background 计时器不阻止进程退出，宿主可拒绝。
	readonly #timers: Timers;
	// 待执行的文档淘汰：目标时间 at 和可选 disarm；未执行前保持设置，避免线路繁忙时重复排队。
	/** The pending eviction: a timer for the oldest idle document, or a line job when the retention is 0. */
	#documentSweep: { readonly at: number; disarm: (() => void) | undefined } | undefined;
	// 已经排到线路上的淘汰任务数，仅供测试观察缓存记账是否收敛。
	#sweepJobs = 0;
	/** Set once the host declined a background timer: then none is kept, and the end of each commit evicts what expired. */
	// 宿主拒绝 background 计时器后设为 true；此后不保留淘汰计时器，改由每次提交结束时清理过期文档。
	#documentTimersUnavailable = false;
	// 外部 observeCommits() 监听器集合；每个都经过 guardObserver，抛错只报告并摘除该监听器。
	/** Host commit observers (`observeCommits()`), each behind `guardObserver()`. */
	readonly #commitListeners = new Set<GuardedObserver<CommitPublication>>();
	// Session 自己的同步监听器（如调度器）；它们维护与存储同步的内存状态，抛错会使 Session 失败。
	/** The Session's own listeners, such as its scheduler's: they keep memory in step with storage, so a throw fails it. */
	readonly #internalListeners = new Set<(publication: ObservedCommit, context: Context) => void>();
	// close 开始时同步调用的监听器集合；每个独立执行，抛错只报告，不影响其他监听器。
	readonly #closeListeners = new Set<() => void>();
	// 提供给 Transaction 的宿主服务（读取、缓存、文档加载、任务索引等）；Transaction 只能通过它访问 Session。
	readonly #host: TransactionHost;
	// 记录缓存包装器；只读 Session 没有它，直接读原始 Storage。
	/** The record cache under the guard, which the writer applies each batch to at its publication. */
	readonly #cached: CachedStorage | undefined;
	// 写入协调器：负责逻辑准入、分组提交、发布顺序和发布失败；Session 通过它得到每个提交的 outcome。
	readonly #writer: Writer;
	// 线路任务读取用的 Storage 包装器；每次读先 touch 键，等待相关未发布写入。
	/** The Storage jobs on the line read through: each read waits while its key has an unpublished writer. */
	readonly #gated: GatedStorage;
	/** The end of the last line job: the line runs one job at a time. */
	// 线路尾部：新任务串在它后面，保证同一时刻只有一个任务执行线内阶段。
	#tail: Promise<void> = Promise.resolve();
	/** Line index of the next job; outcomes are delivered in this order. */
	// 下一个线路任务的序号；结果按这个序号顺序交付。
	#nextIndex = 0;
	/** The job on the line, while one runs: its index, and whether it waited at a gate. */
	// 当前正在线内执行的任务；touch() 通过它记录 hit，onJobEnd() 把回调挂到它上面。
	#current: Job | undefined;
	/** Settles once every job so far has its outcome delivered. */
	// 线路顺序栅栏：第 n 个任务的结果交付要等第 n-1 个任务的 outcome 链，保证调用方按顺序观察。
	#fence: Promise<void> = Promise.resolve();
	// 最近一个已交付（且经过 fence）的任务序号；用于失败边界判断。
	#lastDelivered = -1;
	/** Jobs that started on the line and have no outcome delivered yet (`MAX_OUTSTANDING`). */
	// 已经开始、尚未交付结果的任务数；达到 MAX_OUTSTANDING 时线路暂停。
	#outstanding = 0;
	// 线路因 outstanding 上限暂停时创建的一次性唤醒器；有任务交付后 resolve。
	#room: PromiseWithResolvers<void> | undefined;
	/** The line index whose outcome the failure is: every later job's outcome is `SessionFailed`, except `#ownOutcomes`. */
	// 失败边界：这个序号之后、且没有自己错误的后续任务，结果要改成 SessionFailed。
	#failAt: number | undefined;
	/** Later jobs whose outcome is their own error all the same: the other parts of a storage call that rejected. */
	// 失败边界之后仍保留自身错误结果的任务序号；例如同一次 Storage 调用中其他分片的拒绝。
	readonly #ownOutcomes = new Set<number>();
	// close() 的进行中 Promise；第一次调用创建，后续调用复用，保证关闭只执行一次。
	#closing: Promise<void> | undefined;
	// 第一个导致 Session 失败的 error；一旦设置就不会被后续错误覆盖。
	#failure: { readonly error: unknown } | undefined;
	/** Set when close reaches the backend: calls that fail from then on fail because it closes. */
	// 失败信号 Promise：失败时立即 reject SessionFailed，供等待方竞速；永不 resolve。
	readonly #failed = Promise.withResolvers<never>();
	// 关闭完成信号：close 收尾后 resolve 为 closed 或 failed，包含最终原因。
	readonly #closed = Promise.withResolvers<SessionEnd>();

	// 公开的关闭结果 Promise；Session 关闭完成或失败后 settle。返回同一个 Promise，不复制。
	get closed(): Promise<SessionEnd> {
		return this.#closed.promise;
	}

	/** Internal: the error that failed the Session, if one did. */
	// 内部读取失败原因；没有失败时 undefined。返回对象引用，不复制。
	get failure(): { readonly error: unknown } | undefined {
		return this.#failure;
	}

	/** Internal: rejects with `SessionFailed` the moment the Session fails, before work underway has ended; never resolves. */
	// 内部失败竞速 Promise；失败时以 SessionFailed reject，永不 resolve。
	get failed(): Promise<never> {
		return this.#failed.promise;
	}

	constructor(
		storage: Storage,
		now: () => number = Date.now,
		documentRetentionMs: () => number | undefined = () => undefined,
		setTimer?: SetTimer,
		readOnly = false,
		persistWithinMs: () => number | undefined = () => undefined,
	) {
		// Waits race it; none has to.
		// 构造函数：把原始 Storage 包上缓存和失败守卫，创建 Writer、线路读取门、尾部缓存、计时器和 TransactionHost。
		// 参数：storage 后端；now 时钟；documentRetentionMs 保留期提供者；setTimer 计时器工厂；readOnly 只读标记；
		// persistWithinMs 延迟提交默认窗口提供者。构造不发起 Storage IO，也不提交。
		// 错误：应用提供的 now/retention/persist 回调不会在此抛给调用方，而是在各自包装函数中兜底。
		// 第一行先给 #failed 挂空 catch，避免没有任何等待方时触发 unhandled rejection。
		this.#failed.promise.catch(() => {});
		// 保存只读标记；后续 #runCommit 在发现 writes 时拒绝。
		this.#readOnly = readOnly;
		// A read-only Session shows a Storage another process writes, so nothing it reads stays current.
		// 只读 Session 不使用缓存：另一个进程可能随时写后端，缓存值无法保证仍然最新。
		this.#cached = readOnly ? undefined : new CachedStorage(storage);
		// 所有后端调用都经过 GuardedStorage；失败时由它调用 Session.fail。
		this.#storage = new GuardedStorage(this.#cached ?? storage, this);
		// 线路任务通过 GatedStorage 读；touch 回调把“键上有未发布写入就等待”的规则接到 Session。
		this.#gated = new GatedStorage(this.#storage, (key) => this.touch(key));
		// Writer 的配置：真正提交、存储完成后的缓存更新、发布作用域、失败查询/上报。
		this.#writer = new Writer({
			commit: (batches, receive, context) => this.#storage.commit(batches, receive, context),
			// Storage 已存好一批 writes 后调用：先更新记录缓存，再更新会话尾部缓存；二者都不发起 IO。
			stored: (writes) => {
				// 把已存储的写入应用到 CachedStorage；只读 Session 的 #cached 为 undefined。
				this.#cached?.published(writes);
				// 把条目/根会话写入应用到尾部缓存；分叉的初始尾部留给 Storage 按祖先关系查询。
				this.#tails?.apply(writes);
			},
			publishing: (publish, context) => this.#publishing(publish, context),
			failure: () => this.#failure,
			fail: (error, at, own) => this.fail(error, undefined, at, own),
			report: (error, context) => this.report(error, LISTENER, context),
		});
		// 只有拥有缓存的 Session 维护尾部；只读 Session 的尾部永远未知。
		this.#tails = readOnly ? undefined : new ConversationTails();
		// 包装宿主计时器；setTimer 抛错或调用失败时通过 report 上报，不影响构造。
		this.#timers = hostTimers(setTimer, (error) => this.report(error, { kind: "host_error", callback: "setTimer" }));
		// Cache bookkeeping must never change the outcome of the operation it follows: a clock or a retention setting
		// that throws counts as now, and as the default.
		// 时钟包装：应用回调抛错时用 Date.now，缓存时间戳不能改变业务结果。
		this.#clock = () => {
			try {
				return now();
			} catch {
				return Date.now();
			}
		};
		// 保留期包装：回调抛错时按“未指定”处理，即使用默认值。
		this.#documentRetentionMs = () => {
			try {
				return documentRetention(documentRetentionMs());
			} catch {
				return documentRetention(undefined);
			}
		};
		// 延迟窗口包装：回调抛错时按“未指定”处理，即使用默认值。
		this.#persistWithinMs = () => {
			try {
				return persistWithin(persistWithinMs());
			} catch {
				return persistWithin(undefined);
			}
		};
		// TransactionHost 把 Session 的能力暴露给 Transaction；下面每个字段都只在事务持有线路时调用。
		this.#host = {
			// 事务的读取走 GatedStorage，因此自动等待未发布写入；事务写入则通过 Session 的 Writer 提交。
			storage: this.#gated,
			touch: (key) => this.touch(key),
			now,
			// 按地址取缓存文档；命中时刷新其 LRU 使用时间，未命中返回 undefined，不加载。
			cached: (id) => {
				const cached = this.#documents.get(id);
				if (cached !== undefined) this.#touchDocument(id);
				return cached;
			},
			load: (definition, addressId, address, context) => this.#loadDocument(definition, addressId, address, context),
			// 安装新提交的 incarnation 到缓存，并刷新使用时间。
			install: (document) => {
				this.#documents.set(document.addressId, document);
				this.#touchDocument(document.addressId);
			},
			// 只有当前缓存仍指向同一个 incarnation 时才删除，避免退休旧记录误删新记录。
			evict: (id, recordId) => {
				if (this.#documents.get(id)?.record.id === recordId) this.#dropDocument(id);
			},
			conversationCreated: (tx, record) => this.conversationCreated(tx, record),
			// 返回本 Session 记录的活任务文档集合；未知任务返回 undefined，让 Transaction 回退到扫描。
			taskDocuments: (taskId) => this.#taskDocuments.get(taskId)?.values(),
			latestEntryId: (conversationId, context) => this.latestEntryId(conversationId, context),
			latestHeadMarker: (conversationId, context) => this.latestHeadMarker(conversationId, undefined, context),
		};
	}

	// 保护性 getter：把失败守卫后的 Storage 暴露给子类（如 Harness）；普通外部代码通过 Session 接口读写。
	// 子类直接使用它意味着绕过线路门控，只能用于明确的维护/宿主操作。
	/** The Storage behind the failure guard; every component reads and writes through it. */
	protected get storage(): Storage {
		return this.#storage;
	}

	// 线路内读取会话最新条目 ID：先等待会话创建和追加流发布，再查尾部缓存或 Storage。
	// 输入 conversationId/context；返回最新 EntryId 或 undefined（会话没有条目）；无写入副作用。
	// 错误：门 Promise 或 Storage 读取拒绝会原样传播。
	// 示例：会话 1 首次读取扫描 Storage 得到 7，之后同一 Session 的提交会直接命中 #tails。
	/**
	 * Internal, on the Session line: the newest entry ID visible from `conversationId`. Known from the Session's own
	 * commits when it owns its Storage, so it costs no Storage read after the first.
	 */
	latestEntryId(conversationId: ConversationId, context: Context): Promise<EntryId | undefined> {
		// 先取得两个未发布写入门（会话创建 + 追加流）；后面所有读取都在这两个门之后。
		const gate = this.#touchEntries(conversationId);
		// 把“准备读取”封装成函数：门存在时用 gate.then(latest) 延迟执行，门不存在时同步执行。
		const latest = (): Promise<EntryId | undefined> => {
			// 冷读：按 conversationId 扫描条目，limit=1，不传 cursor；默认顺序是 descending，所以第一项就是最新条目。
			const read = async () =>
				(await this.#storage.scanEntries({ conversationId }, 1, undefined, context)).items[0]?.id;
			// 有尾部缓存时交给它：命中则返回缓存 ID，未命中才调用 read；只读 Session 的 #tails 为 undefined，直接读 Storage。
			return this.#tails === undefined ? read() : this.#tails.latest(conversationId, read);
		};
		// 没有未发布写入时立即执行；有门时等它发布后再执行，避免看到旧尾部。
		return gate === undefined ? latest() : gate.then(latest);
	}

	// 同步查询缓存中已知的最新条目 ID，不读取 Storage、不等待门，也没有异步副作用。
	// 返回值是三态：EntryId 表示已知；null 表示已确认没有条目；undefined 表示缓存不知道（或只读 Session）。
	// 示例：从未读取过的会话返回 undefined；已确认空会话返回 null。
	/**
	 * Internal: the newest entry ID of `conversationId` as known from the Session's commits right now, without reading;
	 * `undefined` when not known (and always for a read-only Session).
	 */
	knownLatestEntryId(conversationId: ConversationId): EntryId | null | undefined {
		// 可选链在 #tails 为 undefined 时直接返回 undefined；peek 不改变缓存。
		return this.#tails?.peek(conversationId);
	}

	// 线路内读取会话在截止点（含）前的最新 head 标记：先等会话创建和追加流发布，再查尾部缓存或 Storage。
	// 返回 HeadMarker | undefined；无条目/无标记时 undefined；错误由门或 Storage 传播。
	// 示例：atOrBefore 为条目 12 时，已知标记 10 可直接命中；查询截止 8 则需要重新读 Storage。
	/**
	 * Internal, on the Session line: the newest visible head marker of `conversationId` at or before `atOrBefore`, any
	 * when `undefined`; known from the Session's own commits as `latestEntryId()` is.
	 */
	latestHeadMarker(
		conversationId: ConversationId,
		atOrBefore: EntryId | undefined,
		context: Context,
	): Promise<HeadMarker | undefined> {
		// 同样先等会话创建和追加流；head 标记属于条目读取面。
		const gate = this.#touchEntries(conversationId);
		// 延迟读取函数：门通过后才真正查缓存/Storage。
		const marker = (): Promise<HeadMarker | undefined> => {
			// 真实查询把包含式截止 ID 交给 Storage；undefined 表示任意截止点（取最新标记）。
			const read = () => this.#storage.findLatestHeadMarker(conversationId, atOrBefore, context);
			// 尾部缓存命中且覆盖截止点时直接返回；否则 read 查询 Storage。
			return this.#tails === undefined ? read() : this.#tails.marker(conversationId, atOrBefore, read);
		};
		// 无门立即查；有门发布后再查。
		return gate === undefined ? marker() : gate.then(marker);
	}

	// 组合两个门：会话创建键（conv:<id>）和追加流键（entry-append:<id>）。
	// 返回 undefined 表示两个键都没有未发布写入；否则返回等待它们的 Promise。
	// 为什么需要会话创建门：Storage 对尚未存入的会话会拒绝条目读取。
	/**
	 * On the line: wait for what an unpublished commit wrote of a conversation's entries, its appends and its creation,
	 * as reading them from Storage fails for a conversation not stored yet.
	 */
	#touchEntries(conversationId: ConversationId): Promise<void> | undefined {
		// 先 touch 会话创建键；touch 可能返回 undefined 或门 Promise。
		const created = this.touch(conversationKey(conversationId));
		// 再 touch 追加流键；两次调用都在当前任务线内同步完成，记录的是各自最新未发布写入。
		const appended = this.touch(appendKey(conversationId));
		// 只有追加门时直接返回它；两边都无门时返回 undefined。
		if (created === undefined) return appended;
		// 两个门都存在时并行等待，任一拒绝都会使结果拒绝；ignore 丢弃无用的 void 结果。
		return appended === undefined ? created : Promise.all([created, appended]).then(ignore);
	}

	// 读取前的门控入口：查询 Writer 中该键最新的未发布写入，返回等待其发布的 Promise，或 undefined。
	// 特殊值 ALL_KEYS 改为等待所有未发布写入（Writer.drained）；用于无法按键的扫描。
	// 副作用：如果当前有线路任务，且真的存在门，就把 job.hit 设为 true；门通过后还要检查 Session 是否已失败。
	// 错误：门拒绝（Session 失败）或健康检查抛 SessionFailed 会传给调用方。
	// 示例：提交写 entry:7 尚未发布时，touch("entry:7") 返回 Promise；没有未发布写入时返回 undefined。
	/**
	 * Internal, on the line: wait, while `key` has an unpublished writer (for `ALL_KEYS`, while anything is unpublished),
	 * until it is published, then check that the Session is healthy; `undefined` when there is nothing to wait for. A
	 * job's every read touches its key first, so it never observes state an earlier job admitted and the writer has not
	 * published.
	 */
	touch(key: string): Promise<void> | undefined {
		// ALL_KEYS 是通配屏障；其他键查询 Writer 的未发布映射。
		const gate = key === ALL_KEYS ? this.#writer.drained() : this.#writer.gate(key);
		// 没有需要等待的写入；调用方可以直接读取。
		if (gate === undefined) return undefined;
		// 只有线路任务会等待门；记录 hit 后，#enqueue 对 exempt 任务不再提前交付。
		if (this.#current !== undefined) this.#current.hit = true;
		// 门通过后先确认 Session 没有失败，再把控制权交回读取方；健康检查抛错会让读取拒绝。
		return gate.then(() => this.#assertHealthy());
	}

	// 公开提交入口：在当前 Session 线路上执行一次事务；返回回调结果。
	// 输入 change 是事务回调，context 控制取消，options.persistence 选择立即或延迟存储。
	// 错误：参数/会话不可用、回调错误、Storage 失败都会使返回 Promise 拒绝。
	// 示例：await session.commit((tx) => tx.appendEntry(cid, { kind: "note" }), context);
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context, options?: CommitOptions): Promise<T> {
		// 不绑定 TransactionScope（默认会话/任务归属），直接转给内部实现。
		return this.commitWith(change, context, undefined, options);
	}

	// 让 Session 失败：第一个 error 生效，后续调用直接返回；失败后准入结束、关闭监听器同步运行。
	// 参数 at 指定失败对应的线路序号；own 列出仍应保留自身错误结果的序号。
	// 副作用：设置 #failure、reject #failed、后台 close、上报 storage_failed。
	// 示例：GuardedStorage 捕获后端错误后调用 fail(error)；调用方仍看到原始错误。
	/**
	 * Internal: fail the Session with `error`, the first wins, and report it once. Admission ends, and close listeners run
	 * now; they read the error from `failure`. The Storage guard calls this; the Harness also calls it for a throw in its
	 * scheduler's own commits. `at` is the line index of the job whose outcome the failure is, by default the job on the
	 * line: later jobs' outcomes become `SessionFailed`.
	 */
	fail(error: unknown, context?: Context, at?: number, own?: readonly number[]): void {
		// 第一个失败者获胜；后续错误不覆盖原因，也不重复关闭。
		if (this.#failure !== undefined) return;
		// 保存失败原因；#assertHealthy 与 #poisoned 都从这里取值。
		this.#failure = { error };
		// The job that caused it keeps its own outcome; without one, every outcome not delivered yet is `SessionFailed`.
		// 确定失败边界：优先用调用方给的线路序号，否则用当前任务，再否则用最近已交付序号。
		this.#failAt = at ?? this.#current?.index ?? this.#lastDelivered;
		// 这些任务的结果是自己的错误，不应被统一改写成 SessionFailed。
		if (own !== undefined) for (const index of own) this.#ownOutcomes.add(index);
		// 立即唤醒所有竞速等待失败的任务；#failed 永不 resolve。
		this.#failed.reject(new SessionFailed(error));
		// Seal first, so a report handler that calls back finds the Session failed. Closing runs the close listeners
		// synchronously; a failing backend close is the caller's to see, and here nobody waits.
		// 失败后自行关闭（不阻塞失败路径）；关闭错误已通过 #failure/closed 体现，这里只避免未处理拒绝。
		this.close(BACKGROUND_CONTEXT).catch(() => {});
		// 只上报一次存储失败；普通 Session 的 report 为空实现，Harness 可记录。
		this.report(error, { kind: "storage_failed" }, context);
	}

	// 内部提交入口：允许传入 TransactionScope，指定 tx.createTask 的默认会话和追加条目的 byTaskId。
	// 先同步校验参数和延迟窗口，再把任务排到线路；返回回调结果。
	// 错误：不可用/非法 persistence 会在入队前直接 reject。
	/**
	 * Internal commit exposing the concrete transaction and its internal operations, such as the reserved-ID root
	 * bootstrap and task replacement. `scope` sets the default `tx.createTask()` conversation and the task attributed to
	 * appended entries.
	 */
	commitWith<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope?: TransactionScope,
		options?: CommitOptions,
	): Promise<T> {
		// 在 try 外声明，成功校验后才传给 #runCommit。
		let withinMs: number | undefined;
		try {
			// 检查 Session 未失败且未关闭；失败时抛 SessionFailed，关闭时抛普通 Error。
			this.assertUsable();
			// 把 immediate/deferred 选项规范化为延迟毫秒数；deferred 且未给 withinMs 时取配置默认值。
			withinMs = this.#deferral(options?.persistence);
		} catch (error) {
			return Promise.reject(error);
		}
		// 任务在线路上执行；#enqueue 负责顺序、背压和结果交付。
		return this.#enqueue((index) => this.#runCommit(change, context, scope, withinMs, index));
	}

	// 调度器内部提交：结果只给调度器代码；不写且没等门的任务可以提前交付。
	// 为什么豁免安全：这样的任务等价于在所有未发布提交之前运行，不会依赖尚未持久的预留。
	// 有写入（或等过门）的任务绝不豁免，仍要等自己的发布和此前所有结果。
	/**
	 * Internal: `commitWith()` for a commit of the scheduler's own whose outcome goes only to scheduler code. When it
	 * writes nothing and waited at no gate, it is equivalent to having run before every unpublished commit, so its
	 * outcome is delivered at once, ahead of theirs. One that writes is never exempt: its outcome waits for its own
	 * publication and every earlier outcome, so no invocation starts on a reservation that is not durable.
	 */
	commitInternal<T>(change: (tx: Transaction) => T | Promise<T>, context: Context): Promise<T> {
		try {
			// 入队前检查；排队期间状态变化由线内的 #assertHealthy 再检查。
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		// exempt=true 只影响结果交付时机，不改变提交的发布顺序。
		return this.#enqueue((index) => this.#runCommit(change, context, undefined, undefined, index), true);
	}

	// 注册一个回调，在当前线路任务结果结算后执行（提交已发布，或确定不会发布）。
	// 不在线路上（#current 为 undefined）时立即执行；在线路上时挂到 job.ends。
	// 无返回值；回调错误不会被本方法捕获。
	/**
	 * Internal, on the line: call `end` once the outcome of the job on the line settles, its commit published or never to
	 * be; at once off the line.
	 */
	onJobEnd(end: () => void): void {
		// 只有任务持有线路时才需要延迟；否则没有“任务结束”可等。
		const job = this.#current;
		// 线路外调用立即执行，保证语义一致。
		if (job === undefined) {
			end();
			return;
		}
		// 惰性创建回调数组，避免每个任务都分配；已有数组时直接 push。
		if (job.ends === undefined) job.ends = [end];
		else job.ends.push(end);
	}

	// 线路任务应使用的 Storage：GatedStorage，保证每次读等待相关未发布写入。
	// 线路外代码应使用普通 storage getter；两者返回同一个底层后端，但门控语义不同。
	/** Internal: the Storage jobs on the line read through (`touch()`); off the line, use the plain one. */
	get lineStorage(): Storage {
		// 返回同一个长期包装器，不复制、不缓存新对象。
		return this.#gated;
	}

	// 把 CommitPersistence 选项转换成 #runCommit 使用的延迟窗口；immediate 返回 undefined。
	// deferred.withinMs 未给时读取配置；显式给出时做运行时校验（number 且 >= 0），非法抛 TypeError。
	// 为什么这里校验：公开选项可能来自 JS；类型系统保证不了数值范围。
	// 示例：#deferral({kind:"deferred"}) 返回默认窗口；{kind:"deferred", withinMs: -1} 抛 TypeError。
	/** How long a commit may stay in memory before it is stored; `undefined` when it is immediate. */
	#deferral(persistence: CommitPersistence | undefined): number | undefined {
		// immediate 或未指定都立即存储；可选链避免 persistence 为 undefined 时访问 kind。
		if (persistence?.kind !== "deferred") return undefined;
		// 取得显式窗口；下面区分“未给”和“非法值”。
		const ms = persistence.withinMs;
		// 未给窗口时使用配置默认值（默认 1000ms，Infinity 表示等下一次读/写或关闭）。
		if (ms === undefined) return this.#persistWithinMs();
		// Public options: checked here, as the types cannot.
		// 运行时校验：排除非数字、NaN 和负数；Infinity >= 0 为 true，按合法值处理。
		if (typeof ms !== "number" || !(ms >= 0)) {
			// 公开参数的信任边界：抛 TypeError，让调用方在入队前看到参数错误。
			throw new TypeError("CommitPersistence.withinMs must be a number of milliseconds, 0 or more");
		}
		return ms;
	}

	// 类型谓词 + 运行时检查：判断 tx 是否由本 Session 的 TransactionHost 创建。
	// 返回 true 时 TypeScript 在后续分支把 tx 收窄为 Transaction；运行时委托 Transaction.ownedBy。
	/** Internal: whether `tx` is the transaction of one of this Session's commits. */
	ownsTransaction(tx: Tx): tx is Transaction {
		// 身份判断基于 host 对象，而不是 tx 形状；外部仿造对象不会被认作自己的事务。
		return Transaction.ownedBy(tx, this.#host);
	}

	// 在线路上执行只读任务，使多次读取看到同一个已提交状态。
	// job 收到 GatedStorage，读取自动等待此前未发布写入；结果排在此前任务结果之后。
	// 错误：Session 不可用时立即 reject；job 抛错/拒绝会作为该任务结果传播。
	// 示例：await session.readOnLine(async (s) => s.task(id, context));
	/**
	 * Internal: run a read-only job on the mutation line so multi-read derivations observe one committed state. It reads
	 * through `storage`, whose reads wait for the publication of what the line admitted before; its outcome comes after
	 * theirs.
	 */
	readOnLine<T>(job: (storage: Storage) => Promise<T>): Promise<T> {
		try {
			// 同步检查失败/关闭状态；不可用时转成 rejected Promise。
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		// 入队后在线内执行；没有提交，因此不会产生 writes 或 after。
		return this.#enqueue(async () => {
			// 线内再次检查：排队期间 Session 可能已经失败。
			this.#assertHealthy();
			// 执行只读任务并包装成 Ran：value 是结果，after 未设置，所以只需线路顺序交付。
			return { value: await job(this.#gated) };
		});
	}

	// 线路内读取会话文档的当前 incarnation 与值；供已经持有线路的代码使用（如 readOnLine 内部）。
	// token 提供定义，conversationId/context 解析地址；文档不存在返回 undefined。
	// 错误：resolveAddress 的 ID 校验、checkRecordScope/checkRecordVersion、加载错误都会拒绝。
	// 示例：const current = await session.conversationDocumentOnLine(token, cid, context);
	/**
	 * Internal: a conversation document's current incarnation and value, for a job already running on the line (see
	 * `readOnLine()`). Absent documents are `undefined`.
	 */
	async conversationDocumentOnLine(
		token: ConversationDocToken<JsonObject>,
		conversationId: ConversationId,
		context: Context,
	): Promise<{ readonly record: DocumentRecord; readonly version: number; readonly value: JsonObject } | undefined> {
		// 取出擦除后的定义；具体泛型 T 已在公开签名中约束，这里内部按 JsonObject 处理。
		const definition = token.definition;
		// 把重载参数数组解析成逻辑地址；nextArgument 表示消费了几个参数。
		const resolved = resolveAddress(definition, [conversationId, context]);
		// 按地址加载、迁移并缓存；缺失返回 undefined，不抛“未找到”。
		const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
		// 文档不存在是正常结果，不是错误。
		if (loaded === undefined) return undefined;
		// 运行时不变量：持久记录必须与 token 的 scope/history/fork 语义一致。
		checkRecordScope(definition, loaded.record);
		// 存储版本必须能由当前定义读取或迁移；不兼容时抛错。
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		// 返回当前记录的不可变快照信息：record、值所符合的定义版本、tracker 的当前值。
		return { record: loaded.record, version: loaded.valueVersion, value: loaded.tracker.value };
	}

	// snapshot 的六个公开重载分别对应 Session/Conversation/Task 的单例与族文档；
	// 重载只影响 TypeScript 参数检查，运行时统一进入下面的实现，按 resolveAddress 解析参数。
	// 返回只读值或 undefined；读取失败会拒绝。
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
	// snapshot 实现：先解析地址，再尝试缓存；缓存值版本匹配才可直接返回，否则排队冷加载。
	// 为什么缓存命中不排队：缓存里的 tracker 只反映已发布状态，读取它不改变线路；只刷新 LRU。
	// 错误：assertUsable、地址解析、加载/迁移错误都会拒绝。
	// 示例：const value = await session.snapshot(token, conversationId, context);
	async snapshot(token: AnyDocToken, ...args: readonly unknown[]): Promise<JsonObject | undefined> {
		// 同步检查失败/关闭状态；不可用时抛错，async 方法会把它变成拒绝的 Promise。
		this.assertUsable();
		// 擦除具体值类型；下面的 materialize/check 使用定义与存储版本。
		const definition = token.definition;
		// args 是重载参数的运行时数组；解析出 address、地址字符串 id 和下一个参数下标。
		const resolved = resolveAddress(definition, args);
		// nextArgument 处是 context；`as` 只告诉编译器，运行时不做类型检查。
		const context = args[resolved.nextArgument] as Context;
		// 按逻辑地址取缓存；key 与 documentKey 使用同一个 addressId。
		const cached = this.#documents.get(resolved.id);
		// 版本匹配时刷新 LRU 使用时间；不匹配的缓存不能直接交给当前定义。
		if (cached?.valueVersion === definition.version) this.#touchDocument(resolved.id);
		// 命中且版本匹配返回缓存；否则入队加载。
		const loaded =
			// 三元条件：只有版本一致才复用 tracker。
			cached?.valueVersion === definition.version
				? cached
				: // 冷加载在线路上进行，避免与提交/退休交错；返回 Ran，因此结果按线路顺序交付。
					await this.#enqueue(async () => {
						// 排队期间可能失败；加载前再检查。
						this.#assertHealthy();
						// 加载并包装成 Ran.value；没有 after，因为没有提交。
						return { value: await this.#loadDocument(definition, resolved.id, resolved.address, context) };
					});
		// 文档不存在时返回 undefined。
		if (loaded === undefined) return undefined;
		// 缓存或冷加载得到的记录必须匹配 token 语义。
		checkRecordScope(definition, loaded.record);
		// 存储版本必须可读/可迁移。
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		// 返回 tracker 的当前只读对象；调用方不应修改它。
		return loaded.tracker.value;
	}

	// watchDoc 的六个重载对应不同文档作用域；运行时统一进入下面的实现。
	// 返回 DocumentWatch 或 undefined（文档不存在）；取消 context 会中止挂接并清理。
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
	// watchDoc 实现：解析地址后在线上原子地加载并创建 Watch，确保 watch 从某个已提交值开始。
	// 方法本身不是 async，避免多一层异步帧；同步抛错会转成 rejected Promise。
	// 错误：不可用、地址解析、加载/版本检查、取消都拒绝。
	watchDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		// Not async, so an attachment costs one async frame, `#attachDocument`'s; a throw here still rejects.
		try {
			// 检查失败/关闭；不可用时直接 reject。
			this.assertUsable();
			// 取出定义，供地址解析和版本检查。
			const definition = token.definition;
			// 解析地址；args 中 owner/key/context 的具体位置由 nextArgument 决定。
			const resolved = resolveAddress(definition, args);
			// watchDoc 的 context 位于 owner/key 之后；`as` 不做运行时校验。
			const context = args[resolved.nextArgument] as Context;
			// 取出可选取消信号；undefined 表示调用方不取消。
			const signal = context.abortSignal;
			// 挂接流程：在线路上加载并执行 attach；若期间被取消，cancel 会撤销已创建的 watch。
			return this.#attachDocument(
				definition,
				resolved,
				context,
				// attach 回调只在加载成功且未取消时执行。
				(loaded) => {
					// 创建 Watch 并订阅后续提交；createWatch/endWatch 是模块函数，避免闭包捕获调用方。
					const watch = this.#observeDocument(definition, loaded, createWatch, endWatch);
					// 取消信号触发时自动 abort watch，清理提交/关闭订阅。
					if (signal !== undefined) watch.observeAbort(signal);
					// attach 返回 Watch，作为 #attachDocument 的 A 类型结果。
					return watch;
				},
				// 取消竞态发生在挂接之后时，用 abortWatch 撤销刚创建的 watch。
				abortWatch,
			);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// observeDoc 的六个重载对应不同文档作用域；运行时统一进入下面的实现。
	// 返回 Observation（value + detach）或 undefined；context 只控制挂接阶段。
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
	// observeDoc 实现：与 watchDoc 相同地原子挂接，但返回同步 Observer 的 Observation。
	// 观察者通过 guardObserver 保护：抛错只报告并摘除，不影响提交。
	// 错误：不可用、地址解析/加载、取消都会拒绝。
	observeDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<Observation<Readonly<JsonObject>> | undefined> {
		// Not async, as `watchDoc()`; a throw here still rejects.
		try {
			// 检查失败/关闭；不可用时 reject。
			this.assertUsable();
			// 取出文档定义。
			const definition = token.definition;
			// 解析逻辑地址和参数位置。
			const resolved = resolveAddress(definition, args);
			// observeDoc 的参数顺序是 owner/key、observer、context；nextArgument 指向 observer。
			const observer = args[resolved.nextArgument] as Observer<Readonly<JsonObject>>;
			// context 在 observer 之后；运行时按这个位置读取，不重新解析重载签名。
			const context = args[resolved.nextArgument + 1] as Context;
			// 原子挂接；attach 内的 guard 保证观察者生命周期与提交订阅一致。
			return this.#attachDocument(
				definition,
				resolved,
				context,
				// attach 回调创建 guarded observer 和 Observation。
				(loaded) => {
					// 创建 guarded observer：advance 抛错会通过 report 上报并 detach。
					const guarded = this.#observeDocument(
						definition,
						loaded,
						// 观察者工厂只保留 detach 和 report 回调；_value 是初始值，由 observation() 单独放入结果。
						(_value, detach, report) => guardObserver(observer, detach, report),
						endGuarded,
					);
					// Observation.value 是挂接时的值；detach 转给 guard 的 detach。
					return observation(loaded.tracker.value, guarded);
				},
				// 取消竞态时撤销已创建的 Observation。
				detachObservation,
			);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// snapshotAsOf 的两个重载读取可回看的会话文档在某个条目提交时的历史值。
	// 运行时统一进入实现；文档不存在返回 undefined，条目不可见或历史值不可读会抛错。
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
	// snapshotAsOf 实现：在线上先确认条目可见，再按条目所属会话和提交序号读取当时的文档。
	// 关键点：分叉条目可能属于父/祖先会话，所以地址的 scope 要改成 entry.entry.conversationId。
	// 错误：非会话文档、非法条目 ID、条目不可见、历史记录/值不可读都会拒绝或抛错。
	// 示例：const old = await session.snapshotAsOf(token, cid, entryId, context);
	async snapshotAsOf(token: AnyDocToken, ...args: readonly unknown[]): Promise<JsonObject | undefined> {
		// 同步检查失败/关闭状态。
		this.assertUsable();
		// 取出文档定义，用于地址解析和物化。
		const definition = token.definition;
		// 解析逻辑地址；snapshotAsOf 只接受 conversation scope。
		const resolved = resolveAddress(definition, args);
		// 运行时拒绝 Session/Task 文档；这是公开 API 的语义约束，类型上由 RewindableConversation 重载表达。
		if (resolved.address.scope.kind !== "conversation") {
			// 调用方传入不支持的作用域时立即抛错，不进入线路。
			throw new TypeError("Session.snapshotAsOf() requires a conversation document");
		}
		// 取出调用方指定的会话 ID；后面还会用条目实际所属会话覆盖它。
		const conversationId = resolved.address.scope.conversationId;
		// at 参数位于 owner/key 之后；这里按 unknown 读取，因为实现签名擦除了重载类型。
		const atValue = args[resolved.nextArgument];
		// 运行时校验条目 ID：必须是安全整数；品牌类型在运行时不存在。
		if (typeof atValue !== "number" || !Number.isSafeInteger(atValue)) {
			// 非法 ID 直接拒绝，避免把任意数字当作 EntryId 查询 Storage。
			throw new TypeError("Session.snapshotAsOf() requires an entry ID");
		}
		// 通过校验后加类型品牌；运行时仍是同一个数字。
		const at = idFromNumber<EntryId>(atValue);
		// context 在 at 之后；`as` 只影响编译期。
		const context = args[resolved.nextArgument + 1] as Context;
		// 整个历史读取在线路上执行，保证看到一致的已提交状态。
		return this.#enqueue(async () => {
			// 排队期间可能失败，先检查。
			this.#assertHealthy();
			// 用可见性重载读取条目；GatedStorage 会等待该会话创建和条目写入发布。
			const storedEntry = await this.#gated.entry(conversationId, at, context);
			// 条目不存在或对给定会话不可见：历史快照无从谈起，抛普通 Error。
			if (storedEntry === undefined) {
				// 错误包含条目和会话 ID，便于定位分叉/可见性问题。
				throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
			}
			// 把文档地址的 scope 改为条目实际所属会话；祖先条目的文档在祖先 scope 中。
			const address: DocumentAddress = {
				...resolved.address,
				// 保留 kind/key，仅替换 conversationId；这是历史文档所在的真实 scope。
				scope: { kind: "conversation", conversationId: storedEntry.entry.conversationId },
			};
			// 在条目提交序号处查该地址当时存活的 incarnation；不可见返回 undefined。
			const record = await this.#gated.findDocument(address, storedEntry.commitSeq, context);
			// 文档在该时点不存在：正常返回 undefined，而不是错误。
			if (record === undefined) return { value: undefined };
			// 按 incarnation ID 读取该提交序号的值；GatedStorage 等待该 incarnation 的写入发布。
			const stored = await this.#gated.document(record.id, storedEntry.commitSeq, context);
			// 记录存在但值读不到，说明历史数据不完整；抛错而不是静默返回 undefined。
			if (stored === undefined) {
				// 错误携带记录 ID 和 kind，便于诊断存储损坏。
				throw new Error(`Historical document ${record.id} (${record.kind}) cannot be read`);
			}
			// 按当前定义迁移/校验并返回历史值；包装成 Ran.value，无 after。
			return { value: materializeDocument(definition, stored) };
		});
	}

	// 关闭 Session：封住新准入，等待已准入任务结算，落盘 held 文档，结束观察者，再关闭 Storage。
	// 首次调用创建 #closing；后续调用复用同一个 Promise，因此关闭是幂等的。
	// 错误：beforeClose/落盘/Storage.close 的错误会让返回 Promise 拒绝，并可能记录到 #failure。
	// 示例：await session.close(context); await session.closed;
	close(context: Context): Promise<void> {
		// 只有第一次调用真正执行关闭；并发/后续调用复用已有 Promise。
		if (this.#closing === undefined) {
			// 关闭不能在调用方取消时半途而废，所以去掉 abort signal，但保留其他 context 信息。
			const cleanup = withoutAbortSignal(context);
			// Seal admission before anything else runs, then stop observers; admitted work settles before Storage closes.
			// 关闭流水线：封准入、等既有提交、写 held、清理观察者/缓存、关 Storage。
			this.#closing = Promise.resolve()
				// 先运行子类钩子（Harness 可在这里停止调度器等），再进入线路维护任务。
				.then(() => this.beforeClose())
				// 用一个线路维护任务串行执行关闭步骤；#maintain 不产生对外结果，也不会被 SessionFailed 改写。
				.then(() =>
					// 维护任务排队在线尾，保证关闭发生在所有已准入任务之后。
					this.#maintain(async () => {
						// 等待关闭前已准入的所有提交发布或确定不会发布，再处理 held 和关闭。
						await this.#drained();
						// Last, after the writes at close (`writeAtClose()`), while the trackers are still here. A failed Session
						// writes nothing; a failing store fails it, and the backend still closes.
						// 保存 held 落盘错误，等 Storage 关闭后仍能抛出最初原因。
						let unstored: { readonly error: unknown } | undefined;
						// Only with something to store: otherwise the backend's close begins in this very job.
						// 失败 Session 不再写 held；没有 held 时直接进入关闭 Storage，避免多一个异步任务。
						if (this.#failure === undefined && this.#holds.size > 0) {
							// 把全部 held 变更写入 Storage；错误先保存，等观察者和 Storage 关闭后仍向调用方抛出。
							await this.#storeHolds(() => [...this.#holds.values()], cleanup).catch((error: unknown) => {
								unstored = { error };
							});
						}
						// 复制后清空：关闭期间不再接受新 observer，且 end 只调用一次。
						const observers = [...this.#commitListeners];
						// 先清空集合，避免 observer.end 回调中重新挂接。
						this.#commitListeners.clear();
						// After the last publication: the commits admitted before the seal have settled, held changes are stored.
						// Commit observers are synchronous observers, all of them.
						// 外部提交观察者收到 observer 版结束原因：正常关闭为 failed("session closed")，失败为 failed(原错误)。
						const end = closeEnds(this.#failure).observer;
						// 同步结束每个 observer；guard 会保证只结束一次。
						for (const observer of observers) observer.end(end);
						// 内部观察者随 Session 关闭直接丢弃；不需要 end 协议。
						this.#internalListeners.clear();
						// 清空文档缓存，释放 tracker 引用。
						this.#documents.clear();
						// 清空 idle 表；attached 计数也必须清空，否则 Session 对象被引用时仍保留 ID。
						this.#idleDocuments.clear();
						// 清空 attached 计数。
						this.#attachedDocuments.clear();
						// held 文档已经尝试落盘，或 Session 已失败；清空避免阻止 GC。
						this.#holds.clear();
						// 任务文档索引只在 Session 生命周期内有意义，关闭时清空。
						this.#taskDocuments.clear();
						// 关闭后端；关闭错误本身也可能使 Session 失败。
						try {
							// GuardedStorage.close 会先等待所有在途调用结束，再关闭原始 Storage。
							await this.#storage.close(cleanup);
						} catch (error) {
							// A Storage that cannot close is a failed one; an earlier failure stays the cause.
							// 已有失败原因时保留第一个；否则把关闭错误记录为新的失败原因。
							if (this.#failure === undefined) {
								// 记录关闭失败；调用方仍看到抛出的 error。
								this.#failure = { error };
								// 上报关闭失败；普通 Session 为空实现。
								this.report(error, { kind: "storage_failed" });
							}
							// 关闭错误继续向上传播，让 close() 的调用方看到。
							throw error;
						}
						// held 落盘失败但 Storage 已关闭：抛出最初保存的错误，保持失败原因不被关闭错误覆盖。
						if (unstored !== undefined) throw unstored.error;
					}),
				)
				// 无论关闭成功/失败，都解析 #closed：正常为 {kind:"closed"}，失败为 {kind:"failed", error}。
				.finally(() => {
					// 读取最终失败原因；此时不再有新的写入路径。
					const failure = this.#failure;
					// 解析关闭结果 Promise，等待方可以据此判断 Session 结束原因。
					this.#closed.resolve(
						failure === undefined ? { kind: "closed" } : { kind: "failed", error: failure.error },
					);
				});
			// 同步通知 close 监听器；放在 #closing 创建之后、返回之前，失败也能触发。
			this.#notifyClose();
		}
		// 等待关闭完成，同时保留调用方 context 的取消语义（内部 cleanup 已去掉取消信号）。
		return awaitWithContext(this.#closing, context);
	}

	// 一次性通知关闭监听器：先取消淘汰/held 计时器，再逐个执行监听器。
	// 每个监听器用 contained 执行，抛错只报告，不影响其余监听器。
	/** Run the close listeners once, each on its own: one that fails is reported, and the rest still run. */
	#notifyClose(): void {
		// 取消待执行的文档淘汰计时器；可选链兼容没有计时器/没有 disarm 的情况。
		this.#documentSweep?.disarm?.();
		// 清除调度，避免关闭后 touch 再排队淘汰任务。
		this.#documentSweep = undefined;
		// 取消 held 文档的 foreground 落盘计时器，关闭后不再触发。
		this.#holdTimer?.disarm();
		// 清除计时器引用。
		this.#holdTimer = undefined;
		// 复制后清空，保证关闭通知只发一次，且监听器回调中不会重复触发。
		const listeners = [...this.#closeListeners];
		// 先清空集合，再执行回调。
		this.#closeListeners.clear();
		// 逐个执行；contained 捕获同步 throw 和异步 rejection，全部走 report。
		for (const listener of listeners) contained(listener, (error) => this.report(error));
	}

	// 报告钩子：普通 Session 丢弃错误，Harness 可覆写记录；默认来源是 listener_error。
	// 它不应抛错，否则会破坏调用它的发布/关闭路径。
	/**
	 * Internal: the Session's failure, and errors of listeners, which never fail what ran them; `info` defaults to a
	 * listener. A plain Session drops them.
	 */
	report(_error: unknown, _info: ReportInfo = LISTENER, _context?: Context): void {}

	// 会话创建/分叉钩子：在事务已 stage 会话记录后调用；普通 Session 不做额外工作。
	// Harness 会在这里 stage 内置文档；返回 Promise，失败会使该提交失败。
	/**
	 * Runs inside every transaction that creates or forks a conversation, after the conversation record is staged. A
	 * plain Session stages nothing; a Harness stages its built-in documents.
	 */
	protected conversationCreated(_tx: Transaction, _record: ConversationRecord): Promise<void> {
		// 普通 Session 的默认实现：没有内置文档要 stage。
		return Promise.resolve();
	}

	// 关闭前写钩子：在线路上、已准入提交结算后，直接经由 Writer 把 writes() 写入 Storage，不做发布。
	// 失败 Session 不写；批次为空直接返回。没有发布回调，因为 Session 正在关闭。
	// 错误：Writer/Storage 错误会使这次维护任务拒绝。
	/**
	 * Internal, for `beforeClose()`: on the line, after every commit admitted before the seal has settled, write what
	 * `writes()` returns then straight to Storage. Nothing is published, since the Session is closing; a failed Session
	 * writes nothing.
	 */
	protected writeAtClose(writes: () => readonly StorageWrite[]): Promise<void> {
		// 通过维护任务占住线路；index 用于 Writer 的失败边界记录。
		return this.#maintain(async (index) => {
			// 先等此前准入的提交都发布；关闭写入必须排在它们之后。
			await this.#drained();
			// 失败 Session 不允许再写任何东西。
			if (this.#failure !== undefined) return;
			// 此时才生成关闭批次；回调可读取当前内存状态。
			const batch = writes();
			// 空批次不提交；Storage 不接受没有写入的批次。
			if (batch.length === 0) return;
			const context = BACKGROUND_CONTEXT;
			// 把批次逻辑准入给 Writer，并等待它存储完成；publish 为空，discard 也只做忽略。
			await this.#writer.admit({
				index,
				writes: batch,
				keys: [],
				context,
				// 关闭期间不发布；返回 undefined 表示没有发布失败。
				publish: () => undefined,
				// 关闭写入不需要事务回滚；discard 是空操作。
				discard: ignore,
			}).outcome;
		});
	}

	// 提交准入时补充的 membership 键：普通 Session 没有，Harness 用它登记所有权树变化。
	// 可同步返回数组或 Promise；异步拒绝会使提交在准入前失败。
	/**
	 * Keys a commit writes besides its records' (`Transaction.writeKeys()`), at its admission, on the line: a Harness
	 * adds the ownership memberships its task changes write. A plain Session adds none.
	 */
	protected membershipKeys(_tx: Transaction): readonly string[] | Promise<readonly string[]> {
		// 返回共享的空数组，不分配新数组。
		return NO_KEYS;
	}

	// 关闭钩子：在准入封住后、线路关闭 Storage 前运行；普通 Session 立即完成。
	// 钩子不应拒绝；子类需要保证自己的清理不破坏关闭流程。
	/** Runs after close seals admission and before the line closes Storage; must not reject. */
	protected beforeClose(): Promise<void> {
		// 默认无清理工作。
		return Promise.resolve();
	}

	// 挂接已存储提交的同步观察者；返回可 detach 的 CommitObservation。
	// observer.advance 在提交发布后一个微任务运行，必须同步且不能调用 Session API；抛错会被报告并摘除。
	// 示例：const observation = session.observeCommits({ advance, end });
	/**
	 * Attach a synchronous observer of every stored commit, with exactly what it stored (`CommitPublication`). Its
	 * `advance` runs one microtask after the commit's publication, which follows its storage call, in line order, before
	 * every wait the commit resolves and every abort it queues (in no order with watch listeners); it must not block or
	 * call Session operations. A throw is reported, detaches it, and ends it `listener_error`; `end` gets the Session's
	 * close after its last publication.
	 */
	observeCommits(observer: CommitObserver): CommitObservation {
		// 关闭/失败后不能挂接新观察者。
		this.assertUsable();
		// 用 guardObserver 包住外部 observer：统一处理同步 throw、异步 rejection、detach 和 end。
		const guarded = guardObserver(
			observer,
			() => this.#commitListeners.delete(guarded),
			(error, context) => this.report(error, LISTENER, context),
		);
		// 加入集合后，下一次提交发布就会通知；挂接本身是同步的。
		this.#commitListeners.add(guarded);
		// 对外只暴露 detach；end 由 Session 关闭流程调用。
		return { detach: () => guarded.detach() };
	}

	// Session 内部观察者：跟随每个提交在内存中的采用（stored 或 deferred memory）。
	// listener 同步运行，不能调用 Storage/任务代码；抛错会使 Session 失败。返回取消订阅函数。
	/**
	 * Internal: follow every commit as memory adopts it (`ObservedCommit`), for the Session's own components, whose state
	 * follows memory. A throw leaves that state behind, so it fails the Session instead of being reported. They run at
	 * the commit's publication, synchronously, so they call no Storage method, run no task code, and contain every host
	 * callback; the waits they resolve and the aborts they queue run after host observers.
	 */
	followCommits(listener: (publication: ObservedCommit, context: Context) => void): () => void {
		// 关闭/失败后不能挂接新的内部观察者。
		this.assertUsable();
		// 内部监听器集合没有 guard；调用方必须保证同步且不抛错。
		this.#internalListeners.add(listener);
		// 返回幂等的取消函数；删除不存在的监听器不报错。
		return () => this.#internalListeners.delete(listener);
	}

	// 注册 close 开始时的同步监听器；返回取消函数。失败关闭也会触发。
	// listener 不应阻塞或调用 Session API；抛错会被报告，但不阻止其他监听器。
	/**
	 * Register a listener called synchronously when close begins, also when a failure closes the Session (`failure` is
	 * then set). It must not block or call Session operations; a throw is reported.
	 */
	subscribeClose(listener: () => void): () => void {
		// 已关闭/失败的 Session 不再接受 close 监听器。
		this.assertUsable();
		// 加入集合；close 开始时复制并清空。
		this.#closeListeners.add(listener);
		// 取消订阅；删除结果被忽略，调用方只需知道删除完成。
		return () => this.#closeListeners.delete(listener);
	}

	// 在线路上卸载全部缓存 tracker；先落盘 held 变更，再清空文档和 idle 表。
	// 之后访问会从 Storage 冷加载；held 落盘失败会让返回 Promise 拒绝。
	/** Drop every loaded tracker on the mutation line, held changes stored first; later access cold-loads from Storage. */
	unloadDocuments(): Promise<void> {
		// 维护任务占住线路，避免卸载与提交/读交错。
		return this.#maintain(async () => {
			// 失败 Session 不写 held；正常时先把 held 变更存入 Storage，避免卸载后丢失。
			if (this.#failure === undefined) await this.#storeHolds(() => [...this.#holds.values()], BACKGROUND_CONTEXT);
			// 清空文档缓存；观察者持有的 tracker 仍由它们自己引用。
			this.#documents.clear();
			// 清空 idle 时间表，避免淘汰任务访问已卸载的地址。
			this.#idleDocuments.clear();
		});
	}

	// 测试观察接口：返回缓存、idle、attached、已排队淘汰任务、held 文档、任务文档索引和尾部缓存的条目数。
	// 只读快照，不改变缓存状态；用于验证内存有界。
	/**
	 * Internal, for tests: how many documents the cache holds, how many are idle, how many incarnations are pinned, how
	 * many sweep jobs were queued on the line so far, how many documents have held changes, how many live tasks have
	 * their documents indexed, and how many conversations have their newest entry kept.
	 */
	get documentCacheSizes(): {
		readonly cached: number;
		readonly idle: number;
		readonly attached: number;
		readonly sweeps: number;
		readonly held: number;
		readonly taskDocuments: number;
		readonly tails: number;
	} {
		// 每个字段直接读取对应容器的 size，不做遍历。
		return {
			// 缓存 tracker 的逻辑地址数。
			cached: this.#documents.size,
			// 没有观察者、可被淘汰的地址数。
			idle: this.#idleDocuments.size,
			// 正被观察者 pin 住的 incarnation 数。
			attached: this.#attachedDocuments.size,
			// 累计排队的淘汰任务数，不随清理归零。
			sweeps: this.#sweepJobs,
			// 仍有未落盘变更的文档数。
			held: this.#holds.size,
			// 建立了任务文档索引的活任务数。
			taskDocuments: this.#taskDocuments.size,
			// 尾部缓存条目数；只读 Session 没有尾部，计为 0。
			tails: this.#tails?.size ?? 0,
		};
	}

	// 测试观察接口：未交付任务数、未发布写入键数、记录缓存中在途读数量。
	// 线路空闲时三者都应为 0；只读快照。
	/**
	 * Internal, for tests that bound memory: jobs whose outcome is not delivered yet, keys with an unpublished writer,
	 * and record reads in flight in the cache. All three are 0 once the line is idle.
	 */
	get lineSizes(): { readonly outstanding: number; readonly unpublished: number; readonly reads: number } {
		// 返回当前计数，不触发任何清理或等待。
		return {
			// 已开始但结果尚未交付的任务数。
			outstanding: this.#outstanding,
			// Writer 中仍有未发布写入的键数。
			unpublished: this.#writer.unpublished,
			// CachedStorage 在途记录读取数；只读 Session 没有缓存，计为 0。
			reads: this.#cached?.readsInFlight ?? 0,
		};
	}

	// 记录一次缓存文档使用：没有观察者的文档移到 idle 表末尾，并按需调度淘汰。
	// 输入逻辑地址字符串；副作用是更新 Map 顺序/时间、可能设置 #documentSweep。无返回值、不读 Storage。
	// 已 attached 的文档不参与淘汰；高频使用时按时间粒度合并重排，避免每次提交都移动。
	/** Note a use of a cached document: an unattached one becomes the newest idle one, and an eviction is scheduled. */
	#touchDocument(addressId: string): void {
		// 先确认缓存存在；不存在就无需记录使用。
		const cached = this.#documents.get(addressId);
		// attached 文档由观察者 pin 住，不进入 idle 表。
		if (cached === undefined || this.#attachedDocuments.has(cached.record.id)) return;
		// 读取 Session 时钟；包装器保证回调抛错时退回 Date.now。
		const now = this.#clock();
		// 上次记录的使用时间；undefined 表示第一次进入 idle 表。
		const since = this.#idleDocuments.get(addressId);
		// A hot document moves to the back at most once per granule, a tenth of the retention up to 1 s: it may then leave
		// up to a granule early, which costs a reload, while a commit-heavy workload skips the reordering.
		// 时间粒度：保留期的十分之一，最多 1 秒。粒度内重复使用不重排，减少热路径工作；
		// 代价是文档可能提前最多一个粒度被淘汰，之后重新加载。
		if (since !== undefined && now - since < Math.min(1_000, this.#documentRetentionMs() / 10)) return;
		// 先删再插入，把地址移到 Map 末尾（最近使用）。
		this.#idleDocuments.delete(addressId);
		// Map 插入顺序就是 idle 的旧->新顺序；淘汰从第一个开始。
		this.#idleDocuments.set(addressId, now);
		// A pending sweep for the oldest document comes first unless the retention was shortened since; then it moves up.
		// 没有待执行淘汰，或现有淘汰时间晚于当前文档到期时间时，重新调度；缩短保留期会把淘汰提前。
		if (this.#documentSweep === undefined || this.#documentSweep.at > now + this.#documentRetentionMs()) {
			// 调度只会提前或补上淘汰，不会让淘汰晚于当前文档的到期时间。
			this.#scheduleDocumentSweep();
		}
	}

	// 从文档缓存和 idle 表中同时删除一个地址；不处理 held 或 attached，调用方需保证安全。
	#dropDocument(addressId: string): void {
		// 删除 tracker 引用；若仍有观察者持有它，观察者自己的闭包会保持其存活。
		this.#documents.delete(addressId);
		// 同时移除 idle 记账，避免淘汰任务再次访问。
		this.#idleDocuments.delete(addressId);
	}

	// 调度最早 idle 文档的淘汰：保留期为 0 时用微任务立即在线路上执行，否则用 background 计时器。
	// 宿主拒绝 background 计时器时不再保留计时器，改由提交结束时的 sweep 处理。
	// 副作用：设置/替换 #documentSweep，可能排队线路任务；无直接 Storage IO。
	/**
	 * Schedule the eviction of the oldest idle document: on the line at once when the retention is 0, otherwise when it
	 * expires, by a background timer (`HarnessOptions.setTimer`), which never keeps the process alive. Where the host
	 * declines it, as the default does in Cloudflare Workers, none is kept: the end of each commit evicts what expired.
	 */
	#scheduleDocumentSweep(): void {
		// 关闭后不再调度淘汰。
		if (this.#closing !== undefined) return;
		// Documents with unpublished changes are not swept: their publication touches them again.
		// 找到第一个“没有未发布写入”的 idle 文档时间；有未发布变更的文档不能淘汰。
		let oldest: number | undefined;
		// Map 按使用时间旧->新遍历；第一个可用项就是最早可淘汰项。
		for (const [addressId, since] of this.#idleDocuments) {
			// 该地址有未发布写入；跳过，等待其发布再次 touch。
			if (this.#writer.gate(documentKey(addressId)) !== undefined) continue;
			// 记录最早可淘汰时间。
			oldest = since;
			// 只需最早一项。
			break;
		}
		// 没有可淘汰的 idle 文档（都 attached 或有未发布写入）。
		if (oldest === undefined) return;
		// 淘汰目标时间 = 最早使用时间 + 保留期。
		const at = oldest + this.#documentRetentionMs();
		// 已有更早/同样早的淘汰任务时不重复调度。
		if (this.#documentSweep !== undefined && this.#documentSweep.at <= at) return;
		// 取消旧计时器；新任务会覆盖 #documentSweep。
		this.#documentSweep?.disarm?.();
		// The pending sweep stays set until its job runs, so touches while the line is busy queue no more.
		// 先创建记录对象，run 通过身份比较判断自己是否仍是当前调度。
		const sweep: { readonly at: number; disarm: (() => void) | undefined } = { at, disarm: undefined };
		// 计时器/微任务触发时执行：增加测试计数，并排一个线路维护任务。
		const run = (): void => {
			// 测试观察：每排队一次淘汰任务计数一次，即使实际没有文档过期。
			this.#sweepJobs++;
			// 用维护任务在线路上执行；#maintain 不追踪对外结果，因此错误只需内部忽略。
			this.#maintain(async () => {
				// 只有自己仍是当前调度时才清除，避免误删更新的调度。
				if (this.#documentSweep === sweep) this.#documentSweep = undefined;
				// 关闭中不再淘汰；否则清理过期文档并安排下一次。
				if (this.#closing === undefined) this.#sweepDocuments();
				// 维护任务失败（例如时钟异常）不应产生未处理拒绝；Session 的失败另有路径。
			}).catch(() => {});
		};
		// 根据 Session 时钟计算延迟；时钟可能回拨，所以下面用 <= 0 判断立即执行。
		const delay = at - this.#clock();
		// 在排队前设置当前调度，run 触发时才能识别。
		this.#documentSweep = sweep;
		// 已到期：用 queueMicrotask 排队 run，不占计时器。
		if (delay <= 0) {
			// 微任务执行 run；此时 #documentSweep 已设置，run 会在线路上处理。
			queueMicrotask(run);
			// 已安排微任务，不再申请计时器。
			return;
		}
		// 宿主曾拒绝 background 计时器：不保留调度，等提交结束时的 sweep。
		if (this.#documentTimersUnavailable) {
			// 清除调度，避免 _touchDocument 误以为已有计时器。
			this.#documentSweep = undefined;
			// 没有计时器，调度结束。
			return;
		}
		// A timer that fires early sweeps nothing and arms the next one.
		// 请求 background 计时器；它不应阻止进程退出。
		const disarm = this.#timers.background(run, delay);
		// 宿主拒绝计时器：记录不可用，清除调度；后续提交结束会清理过期文档。
		if (disarm === undefined) {
			// 永久标记（本 Session 生命周期内）不再尝试 background 计时器。
			this.#documentTimersUnavailable = true;
			// 清除当前调度。
			this.#documentSweep = undefined;
			// 没有计时器，调度结束。
			return;
		}
		// 保存取消函数，供后续调度替换或关闭时取消。
		sweep.disarm = disarm;
	}

	// 线路上清理已过保留期的 idle 文档：按旧->新遍历，遇到未过期就停止，然后调度下一次。
	// 有未发布写入的文档跳过；attached 文档不在 idle 表中。
	/** On the line: evict the idle documents whose retention passed, oldest first, then schedule the next eviction. */
	#sweepDocuments(): void {
		// 计算过期阈值：使用时间 <= 这个值的文档已超过保留期。
		const expired = this.#clock() - this.#documentRetentionMs();
		// idle 表按使用时间升序；第一个未过期项之后的都未过期。
		for (const [addressId, since] of this.#idleDocuments) {
			// 因为顺序保证，后面都不会过期，直接停止。
			if (since > expired) break;
			// A document with an unpublished change stays until its publication touches it.
			// 有未发布变更时不淘汰；发布后的 touch 会更新其时间。
			if (this.#writer.gate(documentKey(addressId)) !== undefined) continue;
			// 真正删除缓存和 idle 记账；下一次访问会冷加载。
			this.#dropDocument(addressId);
		}
		// 安排下一个最早到期文档；没有 idle 文档时什么也不做。
		this.#scheduleDocumentSweep();
	}

	// 为一个观察者 pin 住某个 incarnation：增加 attached 计数、从 idle 表移除，并返回只生效一次的 release。
	// release 减计数；最后一个观察者释放后，若缓存仍指向同一 incarnation，就重新记入 idle 并调度淘汰。
	// 输入地址和具体记录 ID；副作用是更新 attached/idle Map；无 IO。
	/** Pin a cached incarnation for one observer; the returned release unpins it once, idle again after the last. */
	#pinDocument(addressId: string, recordId: DocumentId): () => void {
		// 同一 incarnation 可能有多个观察者；计数是引用计数，不是布尔。
		this.#attachedDocuments.set(recordId, (this.#attachedDocuments.get(recordId) ?? 0) + 1);
		// attached 文档不能留在 idle 表中被淘汰。
		this.#idleDocuments.delete(addressId);
		// release 必须幂等：观察者可能重复 detach 或先 detach 再 end。
		let pinned = true;
		// 返回的 release 闭包捕获 pinned、addressId、recordId；调用多次只生效一次。
		return () => {
			// 已经释放过；直接返回。
			if (!pinned) return;
			pinned = false;
			// 计数应存在；?? 1 只是防御不可达状态（不变量保证存在）。
			const count = (this.#attachedDocuments.get(recordId) ?? 1) - 1;
			// 还有其他观察者：更新计数后返回，保持 pinned。
			if (count > 0) {
				// 写回剩余计数。
				this.#attachedDocuments.set(recordId, count);
				return;
			}
			// 最后一个观察者离开：删除计数。
			this.#attachedDocuments.delete(recordId);
			// 只有缓存仍指向该 incarnation 时才重新进入 idle；地址可能已指向新记录。
			if (this.#documents.get(addressId)?.record.id === recordId) this.#touchDocument(addressId);
		};
	}

	// 线路任务的核心：在线程上创建 Transaction，运行用户回调，结算写入，决定延迟/立即提交并交给 Writer。
	// 输入 change/context/scope/withinMs/index；返回 Ran<T>（结果 + 可选发布后置 Promise）。
	// 错误：回调错误、结算错误、只读拒绝、membership 错误都会以任务结果拒绝；存储失败由 Writer 另行处理。
	// 流程：健康检查 → 建 tx → 执行 → 结算 → 空写/只读/延迟/立即分支 → 准入 Writer。
	async #runCommit<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope: TransactionScope | undefined,
		withinMs: number | undefined,
		index: number,
	): Promise<Ran<T>> {
		// 开跑前检查 Session 未失败；失败后不再执行新事务。
		this.#assertHealthy();
		// 调用方已取消时直接抛取消错误，不创建事务。
		context.abortSignal?.throwIfAborted();
		// 事务通过 TransactionHost 读取 GatedStorage、缓存文档并在结算时产生 StorageWrite。
		const tx = new Transaction(this.#host, context, scope);
		// 保存用户回调返回值；只有提交成功才交给调用方。
		let result: T;
		try {
			// 运行用户回调；它可以在事务内做多次读写。
			result = await change(tx);
			// 用户可能捕获了失败读取；这里再检查一次，防止带着已失败的 Session 继续提交。
			// A callback that caught a failed read must not commit, nor succeed as if it had.
			// 回调结束后确认 Session 仍健康。
			this.#assertHealthy();
			// 回调或健康检查失败：放弃事务中已 stage 的变更。
		} catch (error) {
			// 回滚/清理事务；它可能触发缓存退休等内存操作。
			await tx.settleFailure();
			// 任务结束前顺便清理过期文档，避免失败路径跳过淘汰。
			this.#sweepDocuments();
			// 保留用户回调的原始错误。
			throw error;
		}
		// 保存事务结算出的写入；空数组表示只读提交。
		let writes: readonly StorageWrite[];
		try {
			// 结算成功路径：把事务内的变更转成不可变写入列表。
			writes = await tx.settleSuccess();
			// 结算失败：事务已自行清理。
		} catch (error) {
			// Settlement aborted every change already.
			// 失败路径也做一次淘汰。
			this.#sweepDocuments();
			// 把结算错误交给调用方。
			throw error;
		}
		// 没有写入：不需要 Writer 准入，直接丢弃事务。
		if (writes.length === 0) {
			// 释放事务资源。
			tx.discard();
			// 只读提交结束后清理过期文档。
			this.#sweepDocuments();
			// Ran 没有 after，因此 #enqueue 只按线路顺序交付。
			return { value: result };
		}
		// 只读 Session 拒绝任何带写入的提交；在进入 Storage 前拒绝，Session 仍保持健康。
		if (this.#readOnly) {
			// Refused before Storage: the Session stays healthy, and the caller sees why.
			// 丢弃已 stage 的写入。
			tx.discard();
			this.#sweepDocuments();
			// 调用方看到特定的只读错误，而不是通用失败。
			throw new ReadOnlySession("a commit with writes");
		}
		// Writer 在发布失败/丢弃时调用；箭头函数保留 tx 引用。
		const discard = (): void => tx.discard();
		// 延迟提交分支：事务必须提供 holdable 快照。
		if (withinMs !== undefined) {
			// 取得可延迟保存的变更快照；不可延迟时返回 undefined。
			const held = tx.holdable();
			// 可延迟：只做内存采用，真正的存储由 hold 计时器/后续提交触发。
			if (held !== undefined) {
				// Adopted in memory when the commits before it are published, as a part of no storage call.
				// Writer 准入不带 writes；publish 时才在内存中执行 #hold。
				const part = this.#writer.admit({
					index,
					writes: undefined,
					keys: tx.writeKeys(),
					context,
					// 发布回调返回 PublishFailure 或 undefined；内存采用成功才算发布。
					publish: () => this.#hold(tx, held, withinMs, context),
					// 准入失败时丢弃事务。
					discard,
				});
				// 提交路径结束前清理过期文档。
				this.#sweepDocuments();
				// after 是 Writer 的发布结果；#enqueue 会等它再交付。
				return { value: result, after: part.outcome };
			}
		}
		// 取得额外 membership 键；可能同步返回数组或 Promise。
		let membership = this.membershipKeys(tx);
		// Promise 分支必须 await；Array.isArray 是运行时区分 thenable 与数组的信任边界。
		if (!Array.isArray(membership)) {
			try {
				// 等待异步 membership；失败时丢弃事务。
				membership = await membership;
			} catch (error) {
				// membership 计算失败，事务不能提交。
				tx.discard();
				// 失败路径也做淘汰。
				this.#sweepDocuments();
				// 把 membership 错误交给调用方。
				throw error;
			}
		}
		// Logical admission. Held changes leave their queue only here, once nothing but Storage can fail; a commit never
		// stores a hold adopted after it in line order. Taken before the keys, so the documents it stores held changes of
		// are its writes too: a later job that reads one waits for it instead of storing them again.
		// 把已 held 的变更并入本次提交；必须在取得 writeKeys 之前，使其键也属于本提交。
		const taken = this.#holds.size === 0 ? NO_HOLDS : tx.takeHeld((id) => this.#holds.get(id));
		// 取得事务自身写入涉及的键；后面追加 membership 键。
		const keys = tx.writeKeys();
		// membership 已在上面收窄为数组；`as` 只是帮助编译器。
		for (const key of membership as readonly string[]) keys.push(key);
		// 立即提交：把写入列表和键交给 Writer 做逻辑准入。
		const part = this.#writer.admit({
			index,
			writes,
			keys,
			context,
			// 发布回调在写入持久后执行；`seq!` 由 Writer 保证存在。
			publish: (seq) => this.#adopt(tx, writes, taken, seq!, context),
			discard,
		});
		// 提交路径结束前清理过期文档。
		this.#sweepDocuments();
		// 结果等待 Writer 的 outcome 后再交付。
		return { value: result, after: part.outcome };
	}

	// 提交持久化后的发布步骤：先让事务把变更应用到内存，再更新任务索引、发布通知、释放 hold。
	// 返回 PublishFailure 并让 Writer 使 Session 失败；正常返回 undefined。
	/**
	 * Publish a stored commit (`Writer`), after the read caches took its writes: adopt it in memory and run its
	 * publication. A throw of the adoption leaves memory behind durable state; the writer fails the Session with it.
	 */
	#adopt(
		tx: Transaction,
		writes: readonly StorageWrite[],
		taken: readonly Hold[],
		seq: Seq,
		context: Context,
	): PublishFailure | undefined {
		// 内存采用结果：stored/observed 文档变更列表。
		let documents: AdoptedDocuments;
		try {
			// 把已存写入应用到事务的 tracker/缓存；失败说明内存无法与存储保持一致。
			documents = tx.adopt(seq);
			// 采用失败：返回 adoption 类型的发布失败。
		} catch (error) {
			return { kind: "adoption", error };
		}
		// 更新活任务 -> 文档索引，使任务终结时无需扫描 Storage。
		this.#indexTaskDocuments(tx, writes, documents, seq);
		// 通知观察者并记录 telemetry；自身观察者抛错会返回 failure。
		const failure = this.#publish(seq, writes, documents, context);
		// 本次提交已包含 held 变更：释放对应 hold 并解除 pin。
		if (taken.length > 0) this.#release(taken);
		// 刷新被写入文档的 LRU 使用时间。
		for (const document of documents.stored) this.#touchDocument(addressId(document.record));
		// 把观察者错误包装成发布失败；Writer 会据此使 Session 失败。
		return failure === undefined ? undefined : { kind: "listener", error: failure.error };
	}

	// 发布时更新任务文档索引：新建任务从空 Map 开始，任务文档加入/退休，终结任务移除。
	// 只处理已经建立索引的任务；未知任务交给 Transaction 在其他路径扫描。
	/**
	 * At publication: keep `#taskDocuments` in step with a stored commit: the tasks it creates start with no documents,
	 * task documents it creates join their task, ones it retires leave, and tasks it ends leave the index.
	 */
	#indexTaskDocuments(tx: Transaction, writes: readonly StorageWrite[], documents: AdoptedDocuments, seq: Seq): void {
		// 本提交创建的任务先登记空索引。
		for (const id of tx.createdTaskIds()) this.#taskDocuments.set(id, new Map());
		// 没有任何活任务索引时无需继续。
		if (this.#taskDocuments.size === 0) return;
		// 只检查已存储（非 observed-only）的文档变更。
		for (const change of documents.stored) {
			// 只关心任务文档；会话/Session 文档与本索引无关。
			if (change.type !== "document" || change.record.scope.kind !== "task") continue;
			// 任务必须已有索引；没有索引说明不是本 Session 启动的任务。
			const known = this.#taskDocuments.get(change.record.scope.taskId);
			// 未知任务跳过。
			if (known === undefined) continue;
			// 退休文档从任务索引移除。
			if (change.kind === "retire") known.delete(change.record.id);
			// 只有本提交创建（createdAt 等于本提交序号）的文档才加入索引；更新不重复加入。
			else if (change.record.createdAt === seq) known.set(change.record.id, change.record);
		}
		// 再检查任务终结写入。
		for (const write of writes) {
			// 任务进入 terminal 后不可能再改其文档，索引可以删除。
			if (write.type === "task" && write.value.state.status === "terminal")
				// 移除终结任务的文档索引。
				this.#taskDocuments.delete(write.value.id);
		}
	}

	// 延迟提交的发布：在内存中采用变更、按文档合并 pending ops、pin 住 tracker，并通知内部观察者。
	// 返回 PublishFailure 或 undefined；adoption 失败会让 Writer 使 Session 失败。
	/**
	 * Hold a deferred commit (`Transaction.holdable()`): adopt it in memory, queue its changes per document, pinned, by
	 * the earliest deadline of the document's held commits, and show it to the Session's own observers.
	 */
	#hold(
		tx: Transaction,
		held: NonNullable<ReturnType<Transaction["holdable"]>>,
		withinMs: number,
		context: Context,
	): PublishFailure | undefined {
		// 保存内存采用的文档变更，供内部观察者使用。
		let documents: DocumentCommitChange[];
		try {
			// 把 held 变更应用到 tracker，但不写 Storage。
			documents = tx.adoptHeld();
			// 采用失败：与已存储提交一样，返回 adoption 失败。
		} catch (error) {
			// As a stored commit's: memory could not adopt it; the writer fails the Session.
			return { kind: "adoption", error };
		}
		// 本次 hold 的最晚落盘时间。
		const deadline = this.#clock() + withinMs;
		// 逐文档合并：同一 incarnation 的多次 deferred 变更折叠进一个 Hold。
		for (const { loaded, ops, base } of held) {
			// incarnation ID 是 hold 的键。
			const id = loaded.record.id;
			// 已有 hold 时直接合并；没有则创建。
			let hold = this.#holds.get(id);
			// 第一次 hold 该文档：pin 住缓存并登记。
			if (hold === undefined) {
				// pin 防止 held 变更在落盘前被淘汰。
				const unpin = this.#pinDocument(loaded.addressId, id);
				// base=false 表示还没有新的 base 值；deadline 是当前最早截止。
				hold = { loaded, pending: new PendingOps(), base: false, deadline, unpin };
				// 登记 hold。
				this.#holds.set(id, hold);
			}
			// 把本次变更的操作追加到 pending 队列；读取 tracker 时按顺序应用。
			hold.pending.push(ops);
			// 只要有一次 base 变更，落盘时就可以从该 base 重新开始，减少增量。
			if (base) hold.base = true;
			// 同一文档取最早截止时间，保证先到的提交不会晚落盘。
			if (deadline < hold.deadline) hold.deadline = deadline;
		}
		// 根据所有 hold 的最早 deadline 调整 foreground 计时器。
		this.#armHoldTimer();
		// 内部观察者看到的是内存采用事件，而不是存储提交。
		const publication: ObservedCommit = { kind: "memory", changes: documents };
		// 保留第一个内部观察者错误。
		let failure: PublishFailure | undefined;
		// 复制集合：监听器可能 detach 自己或他人。
		for (const listener of [...this.#internalListeners]) {
			// Our own observers are synchronous.
			// 内部监听器必须同步；这里仍捕获异常以统一失败。
			try {
				// 通知监听器内存已采用这些变更。
				listener(publication, context);
				// 第一个错误生效；其他监听器继续运行。
			} catch (error) {
				// 只记录第一个。
				failure ??= { kind: "listener", error };
			}
		}
		// 返回 undefined 或 listener 失败，供 Writer 决定是否使 Session 失败。
		return failure;
	}

	// 把选中的 held 变更作为一个 Storage 事务落盘：先等待线路屏障，再构造 document.change 写入。
	// 内存已经采用这些变更，所以只有 observeCommits 观察者会看到发布；失败会使 Session 失败。
	// 为什么先 drained：保证此前准入的提交已发布，hold 的 base 与顺序一致。
	/**
	 * Store the held changes `select` returns in one storage transaction, through the writer, from a job on the line. A
	 * barrier: they are selected once every commit admitted before is published. Memory already has them, so only
	 * `observeCommits()` observers see it, published as the writer publishes it. A failure fails the Session, as every
	 * Storage failure does.
	 */
	async #storeHolds(select: () => readonly Hold[], context: Context): Promise<void> {
		// 等待所有已准入提交发布；这是 hold 落盘的顺序栅栏。
		await this.#drained();
		// 在屏障之后取快照，避免选择到尚未发布的 hold。
		const holds = select();
		// 没有需要落盘的 hold。
		if (holds.length === 0) return;
		// 只构造 document.change 写入；类型 Extract 收窄 StorageWrite 的联合成员。
		const writes: Extract<StorageWrite, { readonly type: "document.change" }>[] = [];
		// 给 host 观察者的变更列表。
		const changes: DocumentCommitChange[] = [];
		// 收集逻辑地址键和 incarnation 键，供 Writer 排序/门控。
		const keys: string[] = [];
		// 逐个 hold 生成写入；每个 hold 只产生一个 document.change。
		for (const hold of holds) {
			// 解构并重命名 valueVersion；tracker 提供当前内存值。
			const { record, tracker, valueVersion: version } = hold.loaded;
			// 读取当前值，作为本次落盘的完整内容依据。
			const value = tracker.value;
			// 把 pending 操作折叠成可存储的 content/ops；NO_OPERATIONS 表示不再追加新操作。
			const stored = storeHeld(hold, NO_OPERATIONS, value, version);
			// 写入按记录 ID 定位 incarnation。
			writes.push({ type: "document.change", id: record.id, content: stored.content });
			// 同时登记逻辑地址和 incarnation 键，读这两者的任务都会等待本次写入。
			keys.push(documentKey(hold.loaded.addressId), incarnationKey(record.id));
			// Held documents are conversation documents.
			// held 文档按设计都是会话文档；其他 scope 给 undefined，仅作类型收窄。
			const conversationId = record.scope.kind === "conversation" ? record.scope.conversationId : undefined;
			// 构造 host 观察者看到的文档变更。
			changes.push({ type: "document", kind: "change", record, conversationId, version, value, ops: stored.ops });
		}
		// Writer 发布回调：更新 deltasSinceBase、通知 host 观察者并释放 hold。
		const publish = (seq: Seq | undefined): undefined => {
			// writes 与 holds 一一对应；index 用于找到对应写入。
			for (const [index, hold] of holds.entries()) {
				// base 写入重置增量计数；`!` 由同一循环保证存在。
				if (writes[index]!.content.kind === "base") hold.loaded.deltasSinceBase = 0;
				// 增量写入累加计数。
				else hold.loaded.deltasSinceBase++;
			}
			// 只有存在 host 观察者时才构造并派发发布；`seq!` 由 Writer 保证。
			if (this.#commitListeners.size > 0) this.#notifyHosts({ seq: seq!, changes }, context);
			// 落盘完成：删除 hold、解除 pin 并重新安排计时器。
			this.#release(holds);
			// 没有发布失败。
			return undefined;
		};
		// Run from a job on the line, which a failure it causes is the outcome of.
		// 本方法由线路任务调用；`!` 表示当前任务必然存在。
		const index = this.#current!.index;
		// 准入并等待存储结果；discard 为空，因为内存已采用，失败会使 Session 失败。
		await this.#writer.admit({ index, writes, keys, context, publish, discard: ignore }).outcome;
	}

	// 存储完成后释放 hold：删除记录、解除缓存 pin，并让计时器指向下一个 deadline。
	/** After their store: forget `holds`, unpin their documents, and move the timer to the next deadline. */
	#release(holds: readonly Hold[]): void {
		// 逐个释放；hold 表按 incarnation 合并，每个记录只对应一个 Hold。
		for (const hold of holds) {
			// 从 hold 表删除。
			this.#holds.delete(hold.loaded.record.id);
			// 解除观察者/pin 引用；最后一个释放会让文档重新可淘汰。
			hold.unpin();
		}
		// 重新计算最早 deadline。
		this.#armHoldTimer();
	}

	// 保持一个 foreground 计时器指向所有 hold 的最早 deadline；触发时一次性落盘全部 hold。
	// 已触发但任务尚未运行的计时器不重复创建；关闭后不再安排。
	/**
	 * Keep a foreground timer (Workers refuse background ones) for the earliest deadline of the held documents. When it
	 * fires, every held document is stored, in one storage transaction: a deadline is the latest time, and the others
	 * cost little more in the same transaction. Once fired, it stays until its job ran.
	 */
	#armHoldTimer(): void {
		// 关闭流程自己会落盘 hold，不再安排计时器。
		if (this.#closing !== undefined) return;
		// Infinity 表示没有 hold。
		let at = Infinity;
		// 取最小 deadline；hold 表规模受缓存上限约束。
		for (const hold of this.#holds.values()) if (hold.deadline < at) at = hold.deadline;
		// 现有计时器可能已触发但尚未执行，或指向同一 deadline。
		const armed = this.#holdTimer;
		// 已触发或时间相同则不重排；保持已有计时器。
		if (armed !== undefined && (armed.fired || armed.at === at)) return;
		// 取消旧计时器，准备替换。
		armed?.disarm();
		// 清除旧引用。
		this.#holdTimer = undefined;
		// 没有 hold，不创建计时器。
		if (at === Infinity) return;
		// 先创建对象；run 需要引用它做身份比较。
		const timer: HoldTimer = { at, disarm: () => {}, fired: false };
		// 计时器回调：标记 fired，并排队维护任务。
		const run = (): void => {
			// 表示已触发，后续 #armHoldTimer 不再复用它。
			timer.fired = true;
			// 落盘在线路上执行；#maintain 不产生对外结果。
			this.#maintain(async () => {
				// 只有自己仍是当前计时器时才清除。
				if (this.#holdTimer === timer) this.#holdTimer = undefined;
				// Close stores what is held itself.
				// 关闭/失败时不再写；关闭流程负责落盘（失败则不写）。
				if (this.#closing !== undefined || this.#failure !== undefined) return;
				// 一次性落盘全部 hold；错误由维护任务的 catch 忽略，Session 已由 Writer 失败。
				await this.#storeHolds(() => [...this.#holds.values()], BACKGROUND_CONTEXT);
				// 避免未处理拒绝；失败状态另有记录。
			}).catch(() => {});
		};
		// 登记当前计时器，供后续重排/关闭取消。
		this.#holdTimer = timer;
		// foreground 计时器阻止进程退出；延迟不能为负。
		timer.disarm = this.#timers.foreground(run, Math.max(0, at - this.#clock()));
	}

	// 发布已存储提交：先发 telemetry，再派发 host 观察者，最后同步通知 Session 自身观察者。
	// 自身观察者错误会被记录并返回，Writer 在存储调用结算后使 Session 失败；发布路径本身不抛错。
	/**
	 * At publication: publish a stored commit. Its telemetry events first, then the dispatch to `observeCommits()`
	 * observers, queued before the waits and aborts the observers wake, then the Session's own observers. Never throws:
	 * returns the first error of an own observer, which fails the Session once its storage call settled.
	 */
	#publish(
		seq: Seq,
		writes: readonly StorageWrite[],
		documents: AdoptedDocuments,
		context: Context,
	): { readonly error: unknown } | undefined {
		// 没有观察者时 changes 为 undefined，跳过后续构造和派发。
		const changes: CommitChange[] | undefined =
			this.#commitListeners.size > 0 || this.#internalListeners.size > 0 ? [] : undefined;
		// 按写入类型生成 telemetry 和观察者变更列表。
		for (const write of writes) {
			// StorageWrite 是判别联合；switch 对每个 type 做穷尽处理。
			switch (write.type) {
				case "entry":
					// 条目写入产生 entry 事件；attributes 是扁平键值。
					this.#event("pi.durable.entry", { "entry.id": write.value.id, "entry.kind": write.value.kind }, context);
					// 可选链：changes 为 undefined 时跳过 push。
					changes?.push(write);
					break;
				// 提交（submission）写入只在 done/unanswered 时发事件。
				case "submission":
					// 中间状态不发事件，避免噪声。
					if (write.value.status === "done" || write.value.status === "unanswered") {
						// 事件包含提交 ID、状态和应答条目。
						this.#event(
							"pi.durable.submission",
							{
								"submission.id": write.value.id,
								status: write.value.status,
								"answer.entry_id": write.value.answer,
							},
							context,
						);
					}
					// 所有 submission 写入仍进入观察者列表。
					changes?.push(write);
					break;
				// conversation/task 写入没有 telemetry，只通知观察者。
				case "conversation":
				case "task":
					// 加入观察者变更列表。
					changes?.push(write);
			}
		}
		// 没有观察者：无需发布，直接成功。
		if (changes === undefined) return undefined;
		// 记录表写入数量，后面拼文档变更时保留顺序。
		const tables = changes.length;
		// observed 是内存采用后的文档变更；host 观察者看到它们。
		for (const document of documents.observed) changes.push(document);
		// 内部观察者看到的已存储提交。
		const observed: ObservedCommit = { kind: "stored", seq, changes };
		// 只有存在 host 观察者时才构造并派发 CommitPublication。
		if (this.#commitListeners.size > 0) {
			// One publication for both, unless the commit also stored held changes, which only host listeners get.
			// 若 stored 与 observed 相同，可复用对象；否则为 host 单独构造（只含表写入 + stored 文档）。
			const stored: CommitPublication =
				documents.stored === documents.observed
					? observed
					: { seq, changes: [...changes.slice(0, tables), ...documents.stored] };
			// host 观察者在微任务中运行，排在内部观察者之前。
			this.#notifyHosts(stored, context);
		}
		// The commit is durable: a failing observer neither fails the commit nor skips the others.
		// 保留第一个内部观察者错误。
		let failure: { readonly error: unknown } | undefined;
		// 复制集合，允许监听器在回调中 detach。
		for (const listener of [...this.#internalListeners]) {
			// Our own observers are synchronous.
			// 内部观察者必须同步；异常会被收束成 Session 失败。
			try {
				// 通知内存已采用本提交。
				listener(observed, context);
				// 第一个错误生效，其他监听器继续。
			} catch (error) {
				// 记录第一个错误。
				failure ??= { error };
			}
		}
		// 返回 undefined 或错误，供 #adopt 转成 PublishFailure。
		return failure;
	}

	// 发布时记录一个 telemetry 事件；适配器抛错只报告，不能让发布失败。
	/** At publication: record a commit's telemetry event. A throwing adapter is reported, as publication must not throw. */
	#event(name: string, attributes: SpanAttributes, context: Context): void {
		try {
			// 调用调用方提供的 telemetry 适配器。
			context.telemetry.addEvent(name, attributes);
			// 适配器异常不能影响提交，只上报。
		} catch (error) {
			// 报告来源标记为 host_error/telemetry。
			this.report(error, TELEMETRY, context);
		}
	}

	// 发布 host 观察者：延迟一个微任务，在内部观察者之后运行；集合在运行时复制。
	// 为什么用微任务：host 观察者的派发排在该提交唤醒的等待和 abort 继续之前，且不阻塞发布路径。
	/**
	 * At publication: call the `observeCommits()` observers with `publication` one microtask from now, and, queued
	 * before the Session's own observers run, before the waits they resolve and the aborts they queue. The observers are
	 * those attached when it runs; their guards report a throw.
	 */
	#notifyHosts(publication: CommitPublication, context: Context): void {
		// SETTLED 是已 resolve 的共享 Promise，then 把回调排到微任务；void 表示不等待。
		void SETTLED.then(() => {
			// 复制集合，避免观察者 detach 影响本次遍历；guard 处理抛错。
			for (const observer of [...this.#commitListeners]) observer.advance(publication, context);
		});
	}

	// 在线路上作为一个任务加载文档并执行 attach；返回 attach 结果或 undefined（文档不存在）。
	// 取消 context 会在加载前后检查，若已 attach 则调用 cancel 撤销，再抛取消错误。
	/**
	 * On the line, as one job: load the document at `resolved` and `attach` to it, so the attachment sees every commit
	 * after the value it starts from; `undefined` when absent. Cancelling `context` meanwhile rejects, after `cancel`
	 * undid an attachment made.
	 */
	async #attachDocument<A extends object>(
		definition: AnyDocToken["definition"],
		resolved: { readonly id: string; readonly address: DocumentAddress },
		context: Context,
		attach: (loaded: LoadedDocument) => A,
		cancel: (attached: A) => void,
	): Promise<A | undefined> {
		// 取消信号可缺省；缺省时 cancelled 只由同步状态决定。
		const signal = context.abortSignal;
		// 先读一次当前状态；信号可能在排队期间触发。
		let cancelled = signal?.aborted ?? false;
		// 监听器只设置标志；真正的检查在线上任务前后进行。
		const markCancelled = (): void => {
			cancelled = true;
		};
		// once 避免重复触发；finally 里移除。
		signal?.addEventListener("abort", markCancelled, { once: true });
		// 确保无论成功/失败都移除 abort 监听。
		try {
			// 加载/attach 在线路上原子执行。
			const attached = await this.#enqueue(async () => {
				// 排队期间 Session 可能失败。
				this.#assertHealthy();
				// 开始前已取消：不执行加载；`!` 表示取消必然来自 signal。
				if (cancelled) throw cancellationError(signal!);
				// 加载并缓存文档；缺失返回 undefined。
				const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
				// 加载期间被取消：不 attach，直接失败。
				if (cancelled) throw cancellationError(signal!);
				// 文档缺失时值 undefined；否则执行 attach 并包装成 Ran。
				return { value: loaded === undefined ? undefined : attach(loaded) };
			});
			// 文档不存在：返回 undefined，不创建 watch/observation。
			if (attached === undefined) return undefined;
			// attach 已创建但等待结果期间被取消：需要撤销。
			if (cancelled) {
				// 调用方提供的 cancel 撤销 watch/observation。
				cancel(attached);
				// 向调用方抛出取消错误。
				throw cancellationError(signal!);
			}
			// 成功路径：返回 attach 的结果。
			return attached;
			// 清理 abort 监听，避免信号持有闭包。
		} finally {
			// 移除监听；remove 对未添加的监听是安全的。
			signal?.removeEventListener("abort", markCancelled);
		}
	}

	// 在已加载文档上创建观察者并订阅后续提交：校验定义、pin 当前 incarnation、维护地址/值/版本状态。
	// 文档退休时发 retired 值；地址换成新 incarnation 时发整值替换；任务文档的 owner 终结时结束观察。
	// 返回 observer；detach 幂等，先于 end 运行，释放 pin 和提交/关闭订阅。
	/**
	 * Follow the address of the incarnation `loaded`, after checking the definition, with the observer `create` makes
	 * from its value, the idempotent detach, and the report of a listener error; returns that observer. It gets each
	 * committed change there, a retirement as a `retired` change with the last value it was given and no ops (a change
	 * in the retiring commit is not published), and a later incarnation as a root replacement. When the commit makes the
	 * owner task of a task document terminal, no later commit can change the address: after its changes the commit
	 * subscription and the pin go, and `ownerEnded` tells the observer, which stays subscribed to the Session's close
	 * until it ends (its detach drops that). `end` gets the Session's close. The current incarnation is pinned in the
	 * cache. The detach runs before `end`; once it ran, nothing more of the commit underway reaches the observer or pins
	 * anything for it. `create` and `ownerEnded` are module functions where they can be, so a watch keeps no closure of
	 * its caller.
	 */
	#observeDocument<O extends Observer<Readonly<JsonObject>>>(
		definition: AnyDocToken["definition"],
		loaded: LoadedDocument,
		create: (value: Readonly<JsonObject>, detach: () => void, report: (error: unknown) => void) => O,
		ownerEnded: (observer: O) => void,
	): O {
		// 加载结果必须匹配 token 的 scope 语义。
		checkRecordScope(definition, loaded.record);
		// 存储版本必须可读/可迁移。
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		// The closures below keep only the address, as the cache's ID and first record, which the cache shares while the
		// document is cached: `loaded` holds its incarnation's tracker, which a retirement frees.
		// 闭包只保留地址字符串和首个记录，不持有整个 loaded/tracker。
		const addressId = loaded.addressId;
		// 地址记录在观察期间保持不变；退休后地址仍用于判断新 incarnation。
		const address: DocumentAddress = loaded.record;
		// 当前跟随的 incarnation；undefined 表示地址暂时空缺。
		let incarnation: DocumentId | undefined = loaded.record.id;
		// The value of the incarnation followed; none while the address is absent, so the Session keeps no retired value.
		// 当前值；地址缺失时为 undefined，避免保留退休值。
		let value: Readonly<JsonObject> | undefined = loaded.tracker.value;
		// The definition version the observer's value has: a change of another version replaces it whole.
		// 观察者看到的定义版本；不同版本的变更会整值替换。
		let version = loaded.valueVersion;
		// The incarnation observed stays cached; once it retires or the observer detaches, it is idle again.
		// pin 住当前 incarnation，防止观察期间被淘汰。
		let unpin = this.#pinDocument(addressId, incarnation);
		// 先占位，稍后订阅提交；detach 可能在订阅前调用。
		let unsubscribeCommit = (): void => {};
		// 关闭订阅同样先占位。
		let unsubscribeClose = (): void => {};
		// detach 的幂等标志，也用于提交回调中提前退出。
		let attached = true;
		// detach：取消提交/关闭订阅并解除 pin；多次调用只执行一次。
		const detach = (): void => {
			// 已 detach 或已结束。
			if (!attached) return;
			// 标记已分离。
			attached = false;
			// 停止接收提交变更。
			unsubscribeCommit();
			// 停止接收关闭通知。
			unsubscribeClose();
			// 解除缓存 pin。
			unpin();
		};
		// 创建 Watch/Observer；report 只上报监听器错误。
		const observer = create(loaded.tracker.value, detach, (error) => this.report(error));
		// 订阅每个提交；回调在发布路径同步运行，不能抛错。
		unsubscribeCommit = this.followCommits((publication, context) => {
			// Listeners run from a copy of the set: another observer's call may have detached this one.
			// 另一个观察者可能已 detach 本观察者；提交剩余部分不再处理。
			if (!attached) return;
			// 本提交是否终结了任务文档的 owner。
			let ownerEnds = false;
			// 逐变更处理；顺序与提交内写入顺序一致。
			for (const change of publication.changes) {
				// 任务变更只用于检测 owner 终结。
				if (change.type === "task") {
					// 地址的 scope 固定；任务文档才有 task scope。
					const scope = address.scope;
					// 复合条件：地址属于该任务，且提交把任务置为 terminal。
					if (
						// 非任务 scope 不参与 owner 结束判断。
						scope.kind === "task" &&
						// 只关心地址所属的任务。
						change.value.id === scope.taskId &&
						// terminal 是任务终结状态。
						change.value.state.status === "terminal"
					) {
						// 记录本提交结束 owner；文档变更处理完后结束观察。
						ownerEnds = true;
					}
					// 任务变更不是文档变更，继续下一个。
					continue;
				}
				// The incarnation followed is at the address by definition; only another record needs the address compared.
				// 只处理文档变更；其他类型不改变地址。
				if (change.type !== "document") continue;
				// 当前 incarnation 的变更直接相关；其他记录必须落在同一地址。
				if (change.record.id !== incarnation && !atAddress(change.record, address)) continue;
				// 退休变更：只有当前 incarnation 的退休才通知观察者。
				if (change.kind === "retire") {
					// 其他 incarnation 的退休不影响本观察者。
					if (change.record.id !== incarnation) continue;
					// Set with every incarnation.
					// 退休值就是退休前的最后值；`!` 由 incarnation 存在保证。
					const last = value!;
					// 地址现在空缺，不再跟随 incarnation。
					incarnation = undefined;
					// 不保留退休值，避免 Session 长期持有。
					value = undefined;
					// 退休记录不再需要 pin。
					unpin();
					// 发一个 retired 值，ops 为空；观察者据此知道地址退休。
					observer.advance({ kind: "value", value: last, ops: NO_OPERATIONS, retired: true }, context);
					// 新 incarnation 或不同定义版本：值形状可能改变，必须整值替换。
				} else if (change.record.id !== incarnation || change.version !== version) {
					// A new incarnation at the address, or a value of another definition version, whose shape the observer's
					// value does not have: shown whole.
					// 地址换了 incarnation：重新 pin 新记录。
					if (change.record.id !== incarnation) {
						// 更新跟随 ID。
						incarnation = change.record.id;
						// 释放旧记录 pin。
						unpin();
						// pin 新记录，防止观察期间被淘汰。
						unpin = this.#pinDocument(addressId, incarnation);
					}
					// 记录新版本。
					version = change.version;
					// 缓存新值。
					value = change.value;
					// 用 replace 操作（r）把整值交给观察者。
					observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, context);
					// 同一 incarnation、同一版本：增量变更。
				} else {
					// A migration-only base changes nothing for an observer of the new version.
					// 迁移-only base 不改变观察者看到的值。
					if (change.ops.length === 0) continue;
					// 更新缓存值。
					value = change.value;
					// 把增量 ops 交给观察者。
					observer.advance({ kind: "value", value, ops: change.ops, retired: false }, context);
				}
				// The observer may detach in its call, or throw and be detached: the rest of the commit is not its.
				// 观察者可能在 advance 中 detach 或抛错被 detach；提交剩余部分不再处理。
				if (!attached) return;
			}
			// owner 未终结：继续正常观察。
			if (!ownerEnds) return;
			// owner 已终结，后续提交不会改变该地址。
			unsubscribeCommit();
			// 释放 pin，允许淘汰。
			unpin();
			// 通知观察者 owner 结束（Watch 会延迟到退休值交付后结束）。
			ownerEnded(observer);
		});
		// Session 关闭时结束观察；detach 先清理订阅和 pin。
		unsubscribeClose = this.subscribeClose(() => {
			// 先 detach，保证后续不再收到提交。
			detach();
			// 根据观察者类型和失败原因选择 WatchEnd，再结束。
			observer.end(closeEndOf(observer, closeEnds(this.#failure)));
		});
		return observer;
	}

	// 加载/迁移一个文档地址：等待未发布写入，命中版本匹配缓存则复用，否则处理旧版本/held，读 Storage 并物化。
	// 返回 LoadedDocument 或 undefined（地址不存在）；读值缺失会抛 Error。
	// 错误：Gate、held 落盘、Storage 读取/物化错误都会拒绝。
	async #loadDocument(
		definition: AnyDocToken["definition"],
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined> {
		// What an unpublished commit wrote at the address is in neither the cache nor what Storage shows yet.
		// 有未发布写入时先等待，否则缓存/Storage 可能看到旧状态。
		const gate = this.touch(documentKey(addressId));
		// Gate 通过后 Session 仍健康才继续。
		if (gate !== undefined) await gate;
		// 等待后再查缓存，尽可能复用已加载 tracker。
		const cached = this.#documents.get(addressId);
		// A tracker serves only tokens of the version its value was materialized for; others reload from Storage.
		// 只有值物化版本匹配当前定义才能直接复用。
		if (cached?.valueVersion === definition.version) {
			// 刷新 LRU。
			this.#touchDocument(addressId);
			// 复用 tracker。
			return cached;
		}
		// 版本不匹配的缓存必须替换，但先处理它可能持有的 held 变更。
		if (cached !== undefined) {
			// The reload must find what memory holds: held changes are stored before their tracker goes, after a barrier.
			// 按 incarnation 找 hold。
			const id = cached.record.id;
			// 在丢弃旧 tracker 前落盘它的 held 变更；这是顺序屏障。
			await this.#storeHolds(() => {
				// 只取该 incarnation 的 hold。
				const hold = this.#holds.get(id);
				// 没有 hold 时返回共享空数组。
				return hold === undefined ? NO_HOLDS : [hold];
			}, context);
			// 移除旧 tracker；后续从 Storage 重新加载。
			this.#dropDocument(addressId);
		}
		// 查找地址当前存活的 incarnation；不存在返回 undefined。
		const record = await this.#storage.findDocument(address, "current", context);
		// 地址空缺是正常结果。
		if (record === undefined) return undefined;
		// 读取该 incarnation 的当前值。
		const stored = await this.#storage.document(record.id, "current", context);
		// 记录存在但值缺失说明存储不一致；不能静默当作不存在。
		if (stored === undefined) throw new Error(`Current document ${record.id} (${record.kind}) cannot be read`);
		// 按当前定义迁移/校验存储值。
		const value = materializeDocument(definition, stored);
		// 构造缓存项：地址、记录、存储版本、值物化版本、增量基线和 tracker。
		const loaded: LoadedDocument = {
			addressId,
			record: stored.record,
			storedVersion: stored.version,
			valueVersion: definition.version,
			deltasSinceBase: stored.deltasSinceBase,
			tracker: track(value),
		};
		// 安装缓存。
		this.#documents.set(addressId, loaded);
		// 记入 idle/刷新 LRU。
		this.#touchDocument(addressId);
		// 返回加载结果。
		return loaded;
	}

	// 线路调度核心：给任务编号、串到 #tail 后执行、按序号交付结果，并限制未交付任务数。
	// exempt 任务在无写入且未等门时可提前交付；有写入任务必须等发布和此前结果。
	// 失败边界之后的任务结果改写成 SessionFailed；done 时减少 outstanding 并唤醒暂停的线路。
	/**
	 * Run `job` on the line, after the jobs before it, and deliver its outcome in line order: once the jobs before it
	 * have theirs, and once its commit, if it admitted one, is published. With `exempt`, a job that admitted no commit and
	 * waited at no gate is delivered as soon as it has its outcome: it is equivalent to having run before every
	 * unpublished commit. A job
	 * whose outcome comes after the one a failure is gets `SessionFailed` instead. At most `MAX_OUTSTANDING` jobs wait
	 * for their delivery; beyond it the line waits.
	 */
	#enqueue<T>(work: (index: number) => Promise<Ran<T>>, exempt = false): Promise<T> {
		// 分配单调递增序号；hit 由 touch() 在等待门时设置。
		const job: Job = { index: this.#nextIndex++, hit: false };
		// 串到线路尾部；async 回调允许背压等待。
		const ran = this.#tail.then(async () => {
			// 背压：未交付任务达到上限时暂停线路。
			while (this.#outstanding >= MAX_OUTSTANDING) {
				// 惰性创建唤醒器；多个等待任务共享同一个。
				this.#room ??= Promise.withResolvers();
				// 等待有任务交付后释放容量。
				await this.#room.promise;
			}
			// 占用一个未交付名额。
			this.#outstanding++;
			// 真正执行线内工作；#onLine 设置/清除 #current。
			return this.#onLine(job, work);
		});
		// 线路尾部吞掉结果和错误，保证下一个任务总能继续。
		this.#tail = ran.then(ignore, ignore);
		// 把 Ran 转成调用方结果：有 after 就等发布结果，再标记任务结束。
		const outcome = ran.then(
			(result) => {
				// 没有提交/发布后置：直接交付。
				if (result.after === undefined) {
					// 结算 onJobEnd 回调。
					this.#ended(job);
					// 返回回调结果。
					return result.value;
				}
				// 有 after：等待 Writer 的发布 outcome。
				return result.after.then(
					() => {
						// 发布成功：任务结束。
						this.#ended(job);
						return result.value;
					},
					(error: unknown) => {
						// 发布失败：任务同样结束，然后传播错误。
						this.#ended(job);
						// 保留 Writer 的失败原因（可能是 SessionFailed）。
						throw error;
					},
				);
			},
			// 线内工作失败：标记结束并传播错误。
			(error: unknown) => {
				// 失败路径也运行 onJobEnd。
				this.#ended(job);
				throw error;
			},
		);
		// Delivered later, after the outcomes before it: handled now, so an early rejection is not reported unhandled.
		// 提前挂拒绝处理器，避免结果在 fence 前被报告为未处理拒绝。
		outcome.catch(ignore);
		// 捕获前一个 fence，形成交付顺序链。
		const fence = this.#fence;
		// 新 fence 等前一个和本任务 outcome，无论成败都继续。
		this.#fence = fence.then(() => outcome).then(ignore, ignore);
		// 闭包捕获任务序号，交付和失败边界判断都使用这个快照。
		const index = job.index;
		// 交付函数：fenced 为 true 时先等前面结果；然后处理失败边界。
		const deliver = (fenced: boolean) =>
			// 选择是否串行交付；exempt 任务可以绕过 fence。
			(fenced ? fence.then(() => outcome) : outcome).then(
				(value) => {
					// 标记已交付并释放背压名额。
					this.#delivered(index, fenced);
					// 失败边界之后且非 own 的任务统一改写成 SessionFailed。
					if (this.#poisoned(index)) throw new SessionFailed(this.#failure!.error);
					// 正常结果原样交付。
					return value;
				},
				(error: unknown) => {
					// 失败结果同样标记已交付。
					this.#delivered(index, fenced);
					// 按失败边界决定保留原错误还是 SessionFailed。
					throw this.#poisoned(index) ? new SessionFailed(this.#failure!.error) : error;
				},
			);
		// Only a job without writes is exempt: one with writes waits for its own publication and the outcomes before it.
		// exempt 任务走特殊交付：按 hit 或 after 判断是否必须等 fence。
		return exempt
			? ran.then(
					// 有写入（after）或等待过门（hit）时必须等 fence；否则可提前交付。
					(result) => deliver(job.hit || result.after !== undefined),
					// 失败路径没有 after；只有 hit 时仍需等 fence。
					() => deliver(job.hit),
				)
			: // 普通任务始终按 fence 顺序交付。
				deliver(true);
	}

	// 判断任务是否位于失败边界之后且没有自己的结果：是则结果要改写成 SessionFailed。
	/** Whether job `index` comes after the failure's boundary without an outcome of its own: it gets `SessionFailed`. */
	#poisoned(index: number): boolean {
		// 没有失败边界时永不污染；ownOutcomes 中的任务保留自己的错误。
		return this.#failAt !== undefined && index > this.#failAt && !this.#ownOutcomes.has(index);
	}

	// 任务结果结算时运行 onJobEnd 回调；先清空数组保证只执行一次。
	/** The job's outcome settled: run what waited for it (`onJobEnd()`). */
	#ended(job: Job): void {
		// 没有回调时快速返回。
		const ends = job.ends;
		// 大多数任务没有 onJobEnd 回调。
		if (ends === undefined) return;
		// 先清除，避免回调中重复触发。
		job.ends = undefined;
		// 同步执行所有回调；回调抛错会传播到调用 #ended 的路径。
		for (const end of ends) end();
	}

	// 调度 Session 自身的维护任务：无对外结果、无 fence、无 SessionFailed 改写。
	// 仍与普通任务共享线路顺序，并通过 #tail 串行化。
	/** Run a job of the Session's own upkeep on the line: no outcome to deliver, so no fence and no `SessionFailed`. */
	#maintain<T>(work: (index: number) => Promise<T>): Promise<T> {
		// 维护任务也占用线路序号，用于失败边界和 Writer 记录。
		const job: Job = { index: this.#nextIndex++, hit: false };
		// 串到线路尾部执行。
		const ran = this.#tail.then(() => this.#onLine(job, work));
		// 尾部吞掉结果/错误，让后续任务继续。
		this.#tail = ran.then(ignore, ignore);
		// 调用方仍可等待维护任务的成功/失败。
		return ran;
	}

	// 设置 #current 后执行工作，finally 清除；期间 touch() 能记录 hit，onJobEnd 能挂回调。
	/** Hold the line for job `index` until its line part, through admission, is done. Gates are its touches' own. */
	async #onLine<R>(job: Job, work: (index: number) => Promise<R>): Promise<R> {
		// 标记当前线路任务。
		this.#current = job;
		// 确保无论工作成功/失败都清除 #current。
		try {
			// 执行任务并透传结果。
			return await work(job.index);
			// 线路任务结束。
		} finally {
			// 清除当前任务，避免后续代码误挂回调。
			this.#current = undefined;
		}
	}

	// 等待 Writer 已准入的所有提交发布（或确定不会发布）；没有未发布写入时立即返回。
	/** A `*` barrier: once every part admitted so far is published, or never will be. */
	async #drained(): Promise<void> {
		// 取当前屏障 Promise。
		const drained = this.#writer.drained();
		// 有未发布写入才等待；undefined 表示已排空。
		if (drained !== undefined) await drained;
	}

	// 在 Storage 提供的 publishing 作用域内执行发布；没有作用域时直接执行。
	// 返回 undefined 表示同步执行；否则返回 Promise，等待发布完成。
	// Storage.publishing 抛错时报告并直接执行发布：提交已经存储，必须发布。
	/**
	 * Run one commit's publication inside the Storage's own scope (`Storage.publishing`), such as a store host's batch;
	 * directly without one. `undefined` when it ran at once, else settles once it ran. A Storage that throws instead of
	 * running it is reported, and the publication runs directly: the commit is stored, so it must be published.
	 */
	#publishing(publish: () => void, context: Context): Promise<void> | undefined {
		// 读取后端发布作用域；这是 Storage 的可选能力。
		const publishing = this.#storage.publishing;
		// 没有作用域：直接同步发布。
		if (publishing === undefined) {
			// 同步调用发布；抛错会传回 Writer。
			publish();
			// 已立即执行。
			return undefined;
		}
		// 作用域可能异步完成；用 Promise 告诉 Writer 何时发布结束。
		const done = Promise.withResolvers<void>();
		// once 的幂等标志，防止 Storage 调用多次回调。
		let ran = false;
		// 包装 publish：无论 publish 是否抛错，都 resolve done。
		const once = (): void => {
			// 只执行一次。
			if (ran) return;
			// 标记已执行。
			ran = true;
			try {
				// 执行发布；抛错进入 finally。
				publish();
			} finally {
				// finally 中 resolve，确保发布错误也能结束等待。
				done.resolve();
			}
		};
		// Storage.publishing 可能同步抛错。
		try {
			// 把回调交给 Storage；Storage 决定何时运行。
			publishing(once, context);
			// Storage 拒绝作用域：报告后直接执行发布，不能因为作用域失败而漏发布。
		} catch (error) {
			// 上报 host/Storage 错误。
			this.report(error, LISTENER, context);
			// 直接发布（若 Storage 已调用过则幂等）。
			once();
		}
		// Writer 等待发布完成。
		return done.promise;
	}

	// 任务结果已交付：记录最后交付序号、减少未交付计数，并在低于上限时唤醒暂停的线路。
	/** Job `index` has its outcome: let the line go on past `MAX_OUTSTANDING`. */
	#delivered(index: number, fenced: boolean): void {
		// 只有按 fence 交付的序号才能作为失败边界参考。
		if (fenced) this.#lastDelivered = index;
		// 释放名额。
		this.#outstanding--;
		// 只有线路因上限暂停时才存在唤醒器。
		const room = this.#room;
		// 低于上限且有人等待时唤醒。
		if (room !== undefined && this.#outstanding < MAX_OUTSTANDING) {
			// 先清除共享唤醒器，避免重复 resolve。
			this.#room = undefined;
			// 唤醒所有等待任务。
			room.resolve();
		}
	}

	// 准入检查：失败时抛 SessionFailed，关闭时抛普通 Error；通过时无副作用。
	/** Internal: throw `SessionFailed` when failed, else an error when closing. */
	assertUsable(): void {
		// 先检查失败；失败原因优先于关闭错误。
		this.#assertHealthy();
		// 关闭已开始：不再接受新操作。
		if (this.#closing !== undefined) throw new Error("Session is closed");
	}

	// 内部健康检查：有失败原因就抛 SessionFailed；无返回值。
	#assertHealthy(): void {
		// 包装原始错误，调用方只需识别 SessionFailed。
		if (this.#failure !== undefined) throw new SessionFailed(this.#failure.error);
	}
}

// 安全执行宿主回调：同步 throw 或返回的 thenable rejection 都交给 onError，不向调用方传播。
// onError 不被 await；任何 thenable 都通过 Promise.resolve 采用。
/**
 * Run a host callback that must not fail its caller: a throw, or a promise it returns that rejects, goes to `onError`,
 * which is not awaited.
 */
export function contained(callback: () => unknown, onError: (error: unknown) => void): void {
	try {
		// 先同步执行；这可能直接抛错。
		const result = callback();
		// Any thenable, also a promise from another realm; `Promise.resolve` adopts it with handlers of its own.
		// 运行时 thenable 检测：跨 realm 的 Promise 也覆盖；`as` 只用于访问 then。
		if (typeof (result as { then?: unknown } | null)?.then === "function") Promise.resolve(result).catch(onError);
		// 同步错误直接交给 onError。
	} catch (error) {
		onError(error);
	}
}

// 同步观察者的最小形状：advance 接收调用，end 接收结束原因；Watch 与 CommitObserver 都满足。
/** A synchronous observer as Durable attaches it: `Observer` (`advance` gets a `WatchCall`) or `CommitObserver`. */
type SyncObserver<A> = { advance(call: A, context: Context): void; end(end: WatchEnd): void };

// guarded observer 在同步观察者基础上增加幂等 detach。
/** A guarded observer (`guardObserver()`) with its observation's detach. */
export type GuardedObserver<A> = SyncObserver<A> & { detach(): void };

// 把宿主观察者包进 guard：advance 抛错或返回 rejected Promise 时，上报、detach 并 end(listener_error)。
// detach/end 后 guard 不再持有 observer；返回的 detach 只解除源订阅一次。
// 为什么需要：观察者在提交发布路径运行，任何异常都不能破坏发布或影响其他观察者。
/**
 * `observer`, a host's, behind the rule for observers that run at a commit's publication: one that throws, or whose
 * `advance` returns a promise that rejects, is reported through `report`, detached, and ended `listener_error`, so the
 * throw never reaches `adopt`; nothing reaches it after its detach or end, and from then on the guard references
 * neither it nor its source. `detach` is the source's; the returned `detach()` is the observation's.
 */
export function guardObserver<A>(
	observer: SyncObserver<A>,
	detach: () => void,
	report: (error: unknown, context?: Context) => void,
): GuardedObserver<A> {
	// 把 observer、源 detach、report 放在一个对象里；release 后置为 undefined 以释放引用。
	type Attached = {
		readonly observer: SyncObserver<A>;
		readonly detach: () => void;
		readonly report: (error: unknown, context?: Context) => void;
	};
	// 初始为 attached；detach/end 后变为 undefined。
	let attached: Attached | undefined = { observer, detach, report };
	/** Detach from the source once, and hand back what it was attached with. */
	// 释放一次：返回被释放的 Attached（若已释放则 undefined），并执行源 detach。
	const release = (): Attached | undefined => {
		// 先保存，再清空，避免 detach 回调重入。
		const released = attached;
		// 清除引用，让 guard 不再持有 observer。
		attached = undefined;
		// 调用源 detach；它应幂等。
		released?.detach();
		// 返回被释放对象，供调用方执行 observer.end。
		return released;
	};
	/** Report a throw of `current`'s `advance`, then detach and end it, unless that happened meanwhile. */
	// 处理观察者错误：上报、释放源订阅、再 end(listener_error)。
	const fault = (current: Attached, error: unknown, context: Context): void => {
		// 先上报；report 本身不应抛错。
		current.report(error, context);
		// 只有本次真正释放时才 end，避免重复结束。
		if (release() !== undefined) {
			// 统一把未知错误转成 Error，结束原因固定为 listener_error。
			const end: WatchEnd = { kind: "listener_error", error: toError(error) };
			// end 也可能抛错；用 contained 保护并走 report。
			contained(() => current.observer.end(end), current.report);
		}
	};
	// 返回 guard 观察者；advance/end/detach 都通过 attached 间接持有源。
	return {
		// advance 包装：捕获同步/异步错误并触发 fault。
		advance: (call, context) => {
			// 取当前 Attached；已 detach 时为 undefined。
			const current = attached;
			// 已释放：不再调用源观察者。
			if (current === undefined) return;
			try {
				// 同步调用源 advance；返回类型放宽为 unknown 以检测 thenable。
				const result: unknown = current.observer.advance(call, context);
				// Any thenable, as `contained()` takes it: a rejection is the observer's throw, after the fact.
				// 异步观察者返回 thenable：rejection 也按抛错处理。
				if (typeof (result as { then?: unknown } | null)?.then === "function") {
					// 用 Promise.resolve 采用任意 thenable，并挂 catch。
					Promise.resolve(result).catch((error: unknown) => fault(current, error, context));
				}
				// 同步 throw：立即 fault。
			} catch (error) {
				// 上报并结束。
				fault(current, error, context);
			}
		},
		// 正常结束：释放源订阅并调用 observer.end。
		end: (end) => {
			// 只有尚未释放时才 end。
			const ending = release();
			// end 抛错也安全上报。
			if (ending !== undefined) contained(() => ending.observer.end(end), ending.report);
		},
		// 对外 detach：只释放源订阅，不调用 end。
		detach: () => {
			// 幂等释放。
			release();
		},
	};
}

// 把未知 throw 值转成 Error，供 WatchEnd.error 使用；保证 end 原因始终有 Error 对象。
/** A listener's throw as the `Error` a `listener_error` end carries, as Chord's watch makes it. */
function toError(error: unknown): Error {
	// 已经是 Error 时原样返回。
	if (error instanceof Error) return error;
	// String(error) 可能抛错（例如恶意 toString）。
	try {
		// 普通值转成带字符串消息的 Error。
		return new Error(String(error));
		// String 失败时退回对象标签。
	} catch {
		// 用 Object.prototype.toString 得到 [object X]，不会调用自定义 toString。
		return new Error(Object.prototype.toString.call(error));
	}
}

// 源正常关闭时的通用结束原因；可共享的不可变对象。
/** The end of an observer whose source closed. */
export const ENDED: WatchEnd = { kind: "ended" };

// 根据 Session 是否失败，计算 close 对 Watch 和同步 Observer 的结束原因。
// 正常关闭：watch 为 ended，observer 为 failed("session closed")，让适配器可跟随下一个 Session；
// 失败关闭：两者都用 failed(原错误)。只计算一次，供多个观察者共享。
/**
 * How a Session's close ends what follows it (decision "Slice 8 S1"), made once per close: an app's watch `ended`; a
 * synchronous observer (an adapter following the Session, which may open it again) `failed` with "session closed", so
 * it follows the next Session; `ended` stays for an observed owner that ended (a task document's task). A failed
 * Session ends both `failed` with its error.
 */
export function closeEnds(failure: { readonly error: unknown } | undefined): {
	readonly watch: WatchEnd;
	readonly observer: WatchEnd;
} {
	// 失败优先：所有跟随者都看到同一个原始错误。
	if (failure !== undefined) {
		// 复用同一个对象，避免每个观察者分配。
		const failed: WatchEnd = { kind: "failed", error: failure.error };
		// 失败时两种结束原因相同。
		return { watch: failed, observer: failed };
	}
	// 正常关闭：watch 用共享 ENDED，同步 observer 用新的 failed 错误（每个 close 只创建一次）。
	return { watch: ENDED, observer: { kind: "failed", error: new Error("session closed") } };
}

// 按 follower 的运行时类型选择 WatchEnd：Watch 实例用 watch 版本，其他同步观察者用 observer 版本。
/** The end `ends` give `follower`: a watch's, or an observer's. */
export function closeEndOf(follower: unknown, ends: ReturnType<typeof closeEnds>): WatchEnd {
	// instanceof 是这里的运行时类型判断；Watch 是具体类。
	return follower instanceof Watch ? ends.watch : ends.observer;
}

// 构造 Observation：value 是挂接时的值，detach 委托给 guard。
// 在挂接闭包外构造，使已 detach 的 Observation 只保留 value 和已耗尽的 guard。
/**
 * The `Observation` of a guarded observer attached at `value`. Built outside the attaching closure, so a detached
 * observation keeps nothing but `value` and the spent guard alive.
 */
export function observation<T>(value: T, guarded: { detach(): void }): Observation<T> {
	// 每次 detach 调用都转给 guard 的幂等 detach。
	return { value, detach: () => guarded.detach() };
}

// Watch 的工厂函数：把值、detach、report 传给 Watch 构造函数。
// 独立函数避免 attach 闭包捕获调用方变量。
/** A document watch over its source's detach and report. */
function createWatch(
	value: Readonly<JsonObject>,
	detach: () => void,
	report: (error: unknown) => void,
): Watch<Readonly<JsonObject>> {
	// 创建 Watcher；泛型参数显式写出，保持只读值类型。
	return new Watch<Readonly<JsonObject>>(value, detach, report);
}

// 取消竞态时的补偿：撤销已创建的 watch。
/** Undo a watch attached while its acquisition was aborted. */
function abortWatch(watch: Watch<Readonly<JsonObject>>): void {
	// abort 清理订阅并结束 watch。
	watch.abort();
}

// 取消竞态时的补偿：解除 Observation。
/** Undo an observation attached while its attachment was cancelled. */
function detachObservation(attached: Observation<Readonly<JsonObject>>): void {
	// detach 幂等，重复调用安全。
	attached.detach();
}

// 任务文档 owner 结束时：Watch 先交付退休值，再结束。
/** A task document's watch delivers the retirement that ends its task, then ends. */
function endWatch(watch: Watch<Readonly<JsonObject>>): void {
	// 把结束推迟到当前交付完成之后。
	watch.endAfterDelivery();
}

// 同步 Observer 版本：owner 结束后立即 end(ENDED)。
/** A task document's observer ends right after the retirement that ends its task. */
function endGuarded(guarded: Observer<Readonly<JsonObject>>): void {
	// ENDED 表示源正常结束。
	guarded.end(ENDED);
}

// 判断记录是否落在给定逻辑地址：kind/key 相同，且 scope 的身份字段一致。
/** Whether `record` is an incarnation at `address`. */
function atAddress(record: DocumentRecord, address: DocumentAddress): boolean {
	// 先比较逻辑地址的两个标识字段。
	if (record.kind !== address.kind || record.key !== address.key) return false;
	// scope 是判别联合；每种 scope 比较对应身份字段。
	switch (record.scope.kind) {
		case "session":
			// Session scope 没有额外身份字段。
			return address.scope.kind === "session";
		case "conversation":
			// Conversation scope 比较会话 ID。
			return address.scope.kind === "conversation" && address.scope.conversationId === record.scope.conversationId;
		case "task":
			// Task scope 比较任务 ID。
			return address.scope.kind === "task" && address.scope.taskId === record.scope.taskId;
	}
}

// 把 AbortSignal.reason 规范化为 Error：reason 是 Error 时直接用，否则构造 AbortError。
function cancellationError(signal: AbortSignal): Error {
	// DOMException 的 name 为 AbortError，符合取消语义。
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

// GuardedStorage 需要的 Session 能力：读取当前失败原因，以及让 Session 失败。
/** What the guard needs of its Session: the failure so far, and how to fail it. */
type FailureLatch = {
	readonly failure: { readonly error: unknown } | undefined;
	fail(error: unknown): void;
};

// Session 所有 Storage IO 的失败守卫：调用前失败则抛 SessionFailed；调用抛错则使 Session 失败并原样重抛。
// 例外：StorageRequestError 或 caller 已取消的读取不代表 Storage 损坏，只让该调用失败。
// close 总是到达后端，保证失败 Session 仍能关闭。
/**
 * The Session's Storage behind its failure guard; every component of the Session reads and writes through it. Before a
 * call, a failed Session gets `SessionFailed` without reaching the backend. A call that throws fails the Session and
 * rethrows the backend's error, unless it is a `StorageRequestError` or a read whose caller's context was aborted:
 * neither says the Storage is broken.
 * `close()` always reaches the backend, so a failed Session still closes it.
 */
class GuardedStorage implements Storage {
	// 真实后端；可能是 CachedStorage 包装，也可能是原始 Storage。
	readonly #storage: Storage;
	// Session 的失败闩锁；读取 failure 并调用 fail。
	readonly #latch: FailureLatch;
	/** Backend calls underway, also those off the Session line, which close waits for before it closes the backend. */
	// 记录所有在途后端调用（含线路外调用）；close 等它们结束后再关闭。
	readonly #underway = new Set<Promise<unknown>>();
	// 关闭开始后拒绝新调用，防止分页读取在关闭后请求下一页。
	#closing = false;

	// 保存后端和失败闩锁；不做 IO。
	constructor(storage: Storage, latch: FailureLatch) {
		// 直接使用传入的 Storage；调用方已经决定是否包缓存。
		this.#storage = storage;
		// 保存 Session 的失败接口。
		this.#latch = latch;
	}

	// 读取后端发布作用域（Storage.publishing）；这不是一次需要守卫的调用。
	/** The backend's own scope for a publication (`Storage.publishing`), when it has one; not a call to guard. */
	get publishing(): Storage["publishing"] {
		// scopeOf 处理可选能力并做必要的包装。
		return scopeOf(this.#storage);
	}

	// 带守卫的 commit：失败/关闭时拒绝；在途调用登记，close 会等待。
	// 错误判断交给 Writer：commit 已准入后无法确定是否持久化，因此这里的错误不在这里吞掉。
	/**
	 * Guarded like every call, but its outcome is the Session writer's to judge: it publishes the batches received first,
	 * then fails the Session for a refusal or a rejection, and for a Session that failed meanwhile.
	 */
	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult> {
		// 失败 Session 不再发起提交。
		this.#assertHealthy();
		// 关闭开始后拒绝新提交。
		if (this.#closing) throw new Error("Session is closed");
		// 立即启动调用并用 async IIFE 捕获同步 throw；call 代表整个后端调用。
		const call = (async () => this.#storage.commit(batches, receive, context))();
		// 登记在途调用，供 close 等待。
		this.#underway.add(call);
		// 等待后端提交结果。
		try {
			// 直接返回 CommitResult。
			return await call;
			// 无论成败都从在途集合移除。
		} finally {
			// 调用结束。
			this.#underway.delete(call);
		}
	}

	// 分配新的品牌 ID；经过 #call 守卫。无 caller context，因为 mint 不关联读取取消。
	mintId<I extends Id<string>>(): Promise<I> {
		// read=undefined：失败一律归因于 Storage。
		return this.#call(undefined, () => this.#storage.mintId<I>());
	}

	// 按 ID 读取会话；不存在返回 undefined；经 #call 守卫。
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		// 把 context 传给守卫，取消的读取不会使 Session 失败。
		return this.#call(context, () => this.#storage.conversation(id, context));
	}

	// 分页扫描会话；limit/cursor 由调用方控制；经守卫。
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		// 透传四个参数。
		return this.#call(context, () => this.#storage.scanConversations(query, limit, cursor, context));
	}

	// entry 的两个重载：按条目 ID 读取，或按会话 + 条目 ID 校验可见性。
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	// 第二个重载签名。
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	// 实现签名：用参数个数区分重载。
	entry(
		// first 在两种重载中分别是 EntryId 或 ConversationId。
		first: EntryId | ConversationId,
		// second 在两个参数调用中是 Context，三个参数调用中是 EntryId。
		second: EntryId | Context,
		third?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		// 两个参数（id, context）：走单 ID 重载。
		if (third === undefined) {
			// 收窄 second；`as` 是重载实现中的类型断言。
			const context = second as Context;
			// first 断言为 EntryId；守卫包装。
			return this.#call(context, () => this.#storage.entry(first as EntryId, context));
		}
		// 三个参数重载：上下文是 third，前两个断言为会话/条目 ID。
		return this.#call(third, () => this.#storage.entry(first as ConversationId, second as EntryId, third));
	}

	// 读取包含截止条目的最新 head 标记；atOrBeforeEntryId 为 undefined 表示任意截止。
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		// 透传并守卫。
		return this.#call(context, () => this.#storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context));
	}

	// 分页扫描条目；经 #call 守卫。
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		// 透传 query/limit/cursor/context。
		return this.#call(context, () => this.#storage.scanEntries(query, limit, cursor, context));
	}

	// 按 ID 读取任务；不存在返回 undefined。
	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
		// 透传并守卫。
		return this.#call(context, () => this.#storage.task(id, context));
	}

	// 分页扫描任务；经守卫。
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
		// 透传参数。
		return this.#call(context, () => this.#storage.scanTasks(query, limit, cursor, context));
	}

	// 按 ID 读取提交；不存在返回 undefined。
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		// 透传并守卫。
		return this.#call(context, () => this.#storage.submission(id, context));
	}

	// 分页扫描提交；经守卫。
	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		// 透传参数。
		return this.#call(context, () => this.#storage.scanSubmissions(query, limit, cursor, context));
	}

	// 按会话 + requestId 查询提交；用于幂等请求。
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		// 透传并守卫。
		return this.#call(context, () => this.#storage.submissionByRequest(conversationId, requestId, context));
	}

	// 按地址和时点（current 或提交序号）查找文档记录；不存在返回 undefined。
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		// 透传并守卫。
		return this.#call(context, () => this.#storage.findDocument(address, at, context));
	}

	// 按 incarnation ID 和时点读取存储值；不存在返回 undefined。
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		// 透传并守卫。
		return this.#call(context, () => this.#storage.document(id, at, context));
	}

	// 分页扫描文档元数据；经守卫。
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		// 透传参数。
		return this.#call(context, () => this.#storage.scanDocuments(query, limit, cursor, context));
	}

	// 关闭后端：先标记拒绝新调用，等待所有在途调用 settle，再调用底层 close。
	// 为什么等待：避免调用在 closed 之后失败或继续读写已关闭的后端；分页读取不能跨关闭拉下一页。
	/**
	 * Close the backend once every call underway has settled, so none outlives it or fails after `closed` settles. New
	 * calls are refused from here on: a paged read must not start its next page while the backend closes.
	 */
	async close(context: Context): Promise<void> {
		// 立即封住新调用。
		this.#closing = true;
		// 复制集合后 allSettled：即使某个调用失败也要等全部结束；不在这里改变错误。
		await Promise.allSettled([...this.#underway]);
		// 关闭真实后端；close 不受失败闩锁阻止。
		return this.#storage.close(context);
	}

	// 通用守卫：调用前失败/关闭则拒绝；调用错误时先检查 Session 是否已失败，再决定是否使 Session 失败。
	// read 参数标识这是一次读取及其 caller context；读请求错误或 caller 已取消属例外，不使 Session 失败。
	// 返回后端结果；错误原样抛出。
	/**
	 * Run one backend call under the guard. `read` is a read's context; `commit()` and `mintId()` pass none, so nothing
	 * exempts their errors: once a batch is admitted, whether it committed is unknown. A call still underway when another
	 * fails the Session ends with `SessionFailed` too, whatever it returns: nothing it read or wrote is used.
	 */
	async #call<T>(read: Context | undefined, run: () => Promise<T>): Promise<T> {
		// 失败 Session 的调用直接抛 SessionFailed，不触碰后端。
		this.#assertHealthy();
		// 关闭后拒绝新调用。
		if (this.#closing) throw new Error("Session is closed");
		// 保存成功结果；失败路径通过 catch 退出。
		let result: T;
		// An async wrapper, so a backend that throws synchronously is guarded too.
		// async IIFE 同时捕获同步 throw 和异步 rejection；call 代表完整调用。
		const call = (async () => run())();
		// 登记在途调用，close 会等待。
		this.#underway.add(call);
		// 等待后端结果。
		try {
			// 成功路径保存结果。
			result = await call;
			// 调用失败：区分存储故障与调用方错误。
		} catch (error) {
			// 如果 Session 已被别的调用置为失败，本次错误不再改变状态，直接抛 SessionFailed。
			this.#assertHealthy();
			// An invalid read, or one its caller cancelled, says nothing about the Storage; it fails that call only.
			// 例外判断：这是读取，且错误是 StorageRequestError 或 caller 已取消。
			const exempt =
				// StorageRequestError 表示请求非法；aborted 表示 caller 取消；两者都不说明后端坏了。
				read !== undefined && (error instanceof StorageRequestError || read.abortSignal?.aborted === true);
			// 只有非例外错误才使 Session 失败。
			if (!exempt) this.#latch.fail(error);
			// 无论是否失败，调用方都看到原始错误。
			throw error;
			// 所有路径都从在途集合移除。
		} finally {
			// 调用已 settle。
			this.#underway.delete(call);
		}
		// 成功返回前再检查：调用期间另一个调用可能已使 Session 失败。
		this.#assertHealthy();
		// 只有在 Session 仍健康时返回值才可信。
		return result;
	}

	// 读取失败闩锁，有失败则抛 SessionFailed；用于所有守卫入口。
	#assertHealthy(): void {
		// 取当前失败原因；undefined 表示健康。
		const failure = this.#latch.failure;
		// 包装原始错误，统一调用方可见的失败类型。
		if (failure !== undefined) throw new SessionFailed(failure.error);
	}
}
