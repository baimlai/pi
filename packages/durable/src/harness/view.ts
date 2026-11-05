// Durable 的会话视图层：把一条会话的转录窗口与内建文档投影成不可变的 ConversationView，并逐帧推送。
// 所属：packages/durable/src/harness（spec §9.3），Harness 的会话观察接口。
// 上游：Conversation.watch 调 ConversationViews.watch；Harness.observeConversation 调 observe；
//   适配器可经 conversationViews(harness) 取到同一实例；window 参数控制每个观察者自己的窗口。
// 下游：SessionImpl.followCommits 提供 stored 与 memory 两类提交，subscribeClose 提供关闭结果，
//   readOnLine 把首次构建串行化，conversationDocumentOnLine 读取挂载文档；Storage.conversation 与
//   scanEntries 负责会话记录和带游标的转录扫描；Chord 的 applyImmutable/Watch 负责 delta 与序列化投递。
// 职责边界：每个会话至多一个 Mount，由首个观察者构建、最后一个观察者释放。Mount 共享会话记录与文档，
//   但每个观察者有自己的 entries 窗口（min/max/before）。文档变更一次应用、所有窗口共享；entries 变更
//   为每个窗口分别计算 append/trim ops。memory 提交只含文档变更，视图也处理它，因为文档可能先于存储可见。
// 结果与错误流：observe 返回初始 Observation，watch 返回序列化 WatchHandle；窗口参数非法在进入
//   Session line 前就以 RangeError 拒绝，会话不存在在构建时以 Error 拒绝；观察者抛错由 contained 捕获后 report。
//   Session 关闭时每个观察者收到 end（watch 为 ended，observer 为 failed("session closed")；失败时均为
//   failed(原错误)），关闭后 attach 以 closedError 拒绝；挂载期间取消则 detach/abort 后抛 signal.reason。
// 能力清单：
// - ConversationView：会话记录、转录窗口 entries、窗口前一条 before、内建文档 docs。
// - ConversationWindow：首帧窗口起点的 from 与最小/最大条数 min/max（默认 50 与 2*min）。
// - ViewObserver：每个窗口 revision 的 advance 与关闭时的 end。
// - conversationViews：按 Harness 对象从 WeakMap 取视图实例，供适配器复用。
// - ConversationViews：挂载管理类，提供 report/observe/watch/attach 与首次构建。
// - 文件内机制：resolveWindow 规范化窗口，loadWindow/scanUpTo 读取首帧，advance 逐提交计算窗口差异，
//   prefixed 把文档 op 移到 docs.<kind> 路径下。
// 组合与典型顺序：Harness 构造 new ConversationViews(session)；首个 attach -> readOnLine -> #build 读会话与
//   文档，loadWindow 读窗口；followCommits -> advance 应用文档/追加 entries/超限裁剪；最后一个 detach 丢弃
//   Mount；Session 关闭 -> end 全部观察者。
// 示例（真实签名）：
//   const views = new ConversationViews(session);
//   const watch = await views.watch(conversationId, context, { from: 100, min: 20, max: 40 });
//   watch.start(async (call) => { console.log(call.value.entries.length); });
// 建议阅读顺序：先看 ConversationView/ConversationWindow/ViewObserver 三个公开类型，再看 ConversationViews
//   的 attach 与 #build，随后读 loadWindow/scanUpTo 的首帧规则，最后读 advance 的文档与窗口 delta 计算及
//   prefixed 的路径改写。
import { type Context, withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, type NonEmptyPath, type Op, type Path } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import { Watch, type WatchCall, type WatchEnd, type WatchHandle } from "@earendil-works/chord/watch";
import { idFromNumber } from "../ids.ts";
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
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	Cursor,
	DocumentId,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Observation,
	Observer,
	Storage,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { InboxDoc } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { UsageDoc } from "./usage.ts";
import { closedError } from "./util.ts";

/** Structural view of one conversation: a window over its transcript and its built-in documents (spec §9.3). */
/**
 * 一个观察者看到的一帧会话视图：会话身份、按 ID 升序的窗口、窗口前一条记录和内建文档。
 * 输入/输出：纯类型，无运行时行为；由 view() 组装，每次 revision 是新对象。
 * entries 是 fork-aware 历史（等价于 Conversation.entries()）；head marker（如压缩摘要）留在写入位置。
 * before 只在窗口没有从转录开头开始时存在，用于客户端继续向上加载；值为窗口前一条记录的 EntryId。
 * docs 的键是文档 kind（pi.agent/pi.live/pi.inbox/pi.provider/pi.usage），未挂载的文档不出现。
 * 例：{ conversation, entries: [...], before: 99, docs: { "pi.agent": {...}, "pi.live": {...} } }。
 */
export type ConversationView = {
	// 会话的创建/归属/分叉记录；同一 Mount 内不变。
	readonly conversation: ConversationRecord;
	/**
	 * A window over the transcript, its fork-aware history (`Conversation.entries()`), in entry ID order. Head markers
	 * such as compaction summaries sit where they were written; their `head` tells where the entries they summarize end.
	 */
	// readonly 数组在编译期阻止 push/splice；运行时与旧帧共享同一数组，调用方不得修改。
	readonly entries: readonly EntryRecord[];
	/** ID of the entry just before the window; absent when the window starts the transcript. */
	// ? 表示可省略；view() 只在 before 有值时加入该键。
	readonly before?: EntryId;
	/** Built-in conversation documents keyed by kind; absent documents are absent. */
	// 所有观察者共享同一份 docs 引用；文档变化时整个对象被新 revision 替换。
	readonly docs: Readonly<Record<string, JsonObject>>;
};

/**
 * Which entries a view's window holds (spec §9.3). The window holds between `min` and `max` entries: it starts with
 * the newest `min` entries, takes appends, and once it would hold more than `max`, drops its oldest in one splice down
 * to `min`. With `from`, it starts at `from` instead when at most `max` entries are at or after it.
 */
/**
 * 一个观察者的窗口参数：首帧起点 from 与容量 min/max。
 * 输入/输出：纯类型；交给 resolveWindow 校验并补默认值（min 默认 50，max 默认 2*min）。
 * 窗口行为：首帧取最新 min 条；之后每次提交把新 entries 追加进来；一旦超过 max，一次性裁掉最旧的，
 *   回到 min 条。给了 from 且从 from 起不超过 max 条时，首帧改为从 from 开始。
 * from 只影响首帧：挂载后提交的 entries 无论 ID 都追加；from 超过最新记录时首帧为空、before 为最新记录。
 * 例：{ min: 20, max: 40 } 表示首帧 20 条，涨到 41 条时裁回 20 条。
 */
export type ConversationWindow = {
	/**
	 * Where the first value's window starts, inclusive, such as right after the newest entry a client has
	 * (`ConversationTranscript.resume`). It selects only that first value: every entry committed after the attachment is
	 * appended, whatever its ID. A `from` past the newest entry starts the window empty, with `before` the newest entry.
	 */
	// 包含式下界：from 本身在首帧窗口内；它不限制后续追加。
	readonly from?: EntryId;
	/** Default 50; an integer, at least 1. */
	// 三处都是可选；resolveWindow 在运行时做 Number.isSafeInteger 检查。
	readonly min?: number;
	/** Default `2 * min`; an integer, at least `min`. */
	readonly max?: number;
};

/** Default `ConversationWindow.min`. */
// 只做常量，不导出；resolveWindow 用它计算默认 max = 2 * 50 = 100。
const DEFAULT_WINDOW_MIN = 50;

/** Receives each next revision of one observer's window, and the Session's close. */
/**
 * 视图观察者的最小接口：advance 收到该观察者窗口的下一 revision，end 收到 Session 关闭结果。
 * 输入/输出：纯类型；与 types.ts 的 Observer<ConversationView> 形状相同，guardObserver 可把实现包装成受保护观察者。
 * advance 的 call 含 value 与该窗口的最小 ops；context 是去掉取消信号的帧上下文。
 * end：watch 正常关闭为 ended，同步 observer 为 failed("session closed")，Session 失败为 failed(原错误)。
 * 例：{ advance(call) { use(call.value.entries); }, end(end) { cleanup(end); } }。
 */
export type ViewObserver = {
	// WatchCall 是 value/failed 的联合；视图源只发 value，failed 留给源的可恢复失败语义。
	advance(call: WatchCall<ConversationView>, context: Context): void;
	/** The Session closed (`ended`), or failed (`failed`). */
	// WatchEnd 还包含 stopped/aborted/listener_error，但这里只会收到关闭路径产生的 kind。
	end(end: WatchEnd): void;
};

// 视图挂载的五个内建会话文档；数组元素的静态类型各不相同（AgentState/LiveState/...），
// 因而先 as unknown 再统一成 ConversationDocToken<JsonObject>，运行时只使用 token.definition.kind。
const MOUNTED = [
	AgentDoc,
	LiveDoc,
	InboxDoc,
	ProviderDoc,
	UsageDoc,
] as unknown as readonly ConversationDocToken<JsonObject>[];
// 预先收集 kind 集合：advance 对每个文档变更做 O(1) 过滤，避免每次线性查找。
const MOUNTED_KINDS: ReadonlySet<string> = new Set(MOUNTED.map((token) => token.definition.kind));
// 单次转录扫描页大小；loadWindow/scanUpTo 会按 limit 与它取较小值。
const SCAN_PAGE_SIZE = 256;

/** One observer of a mount and its window: the bounds and the revision it was last given. */
// 挂载内的单个观察者记录：min/max 固化其窗口策略（创建后不变），value 保存它最后收到的 revision。
// value 可变是因为 advance 为每个窗口单独推进；observer 是包装后的同步观察者或 Watch。
type Windowed = {
	readonly min: number;
	readonly max: number;
	value: ConversationView;
	readonly observer: ViewObserver;
};

/**
 * One conversation's mount: the documents it shows, shared by every observer, and the observers, each with its own
 * window over the entries.
 */
// 一条会话的挂载：conversation/docs/incarnations 由所有观察者共享，entries 窗口各自保存在 Windowed 中。
// incarnations 记录每个 kind 当前挂载的文档实例与定义版本，用来判断提交是 delta、整体替换还是 retire。
type Mount = {
	readonly conversation: ConversationRecord;
	// docs 可整体替换：文档提交后 applyImmutable 生成新对象，旧 revision 的观察者仍持有旧引用。
	docs: Readonly<Record<string, JsonObject>>;
	/** Mounted incarnation and definition version per kind; another incarnation or version is set whole. */
	readonly incarnations: Map<string, { id: DocumentId; version: number }>;
	readonly observers: Set<Windowed>;
};

// WeakMap 以 Harness 对象为键：键被回收后视图实例可一起回收，不会形成强引用缓存。
const VIEWS = new WeakMap<object, ConversationViews>();

/** The view mounts of a Harness, for adapters built on them. */
/**
 * 按 Harness 对象取它的 ConversationViews；适配器用它复用同一批挂载与通知。
 * 输入：任意 object（真实调用传 Harness）；输出：注册过的 ConversationViews 实例。
 * 错误：对象不是本文件注册的 Harness 时抛 Error("Not a Harness")；这是对未类型化输入的运行时检查。
 * 无副作用；WeakMap 查找不增加引用计数。
 * 例：const views = conversationViews(harness);
 */
export function conversationViews(harness: object): ConversationViews {
	const views = VIEWS.get(harness);
	// 参数类型是 object，TypeScript 无法保证它一定是 Harness，因此这里做运行时身份检查。
	if (views === undefined) throw new Error("Not a Harness");
	return views;
}

/** A window with its defaults applied. */
// 校验并补默认后的窗口参数；from 仍可为 undefined，表示从最新记录开始。
type WindowBounds = { readonly from: EntryId | undefined; readonly min: number; readonly max: number };

/** `window` with its defaults; throws a `RangeError` for bounds that are not integers or `max` below `min`. */
/**
 * 规范化窗口参数：补默认值并做数值校验；纯函数，不读存储。
 * 输入：可选的 ConversationWindow；输出：{ from, min, max }。
 * 规则：min 默认 50，且必须是 >=1 的安全整数；max 默认 2*min，且必须是 >=min 的安全整数；
 *   from 若存在必须是安全整数（不检查正数或是否真的存在）。
 * 错误：任何不满足上述条件的值抛 RangeError；这是对调用方输入的信任边界校验。
 * 例：resolveWindow({ min: 2 }) -> { from: undefined, min: 2, max: 4 }。
 */
function resolveWindow(window: ConversationWindow | undefined): WindowBounds {
	// ?. 处理 undefined；?? 只在 min 缺失（undefined/null）时用默认值。
	const min = window?.min ?? DEFAULT_WINDOW_MIN;
	// Number.isSafeInteger 排除 NaN、小数、Infinity 与超出安全范围的整数。
	if (!Number.isSafeInteger(min) || min < 1) throw new RangeError(`Window min must be an integer >= 1, got ${min}`);
	// 默认 max 由已校验的 min 计算，因此至少为 2。
	const max = window?.max ?? 2 * min;
	if (!Number.isSafeInteger(max) || max < min) {
		throw new RangeError(`Window max must be an integer >= min (${min}), got ${max}`);
	}
	const from = window?.from;
	// from 是品牌类型 EntryId，运行时只是数字；这里只验证整数形态。
	if (from !== undefined && !Number.isSafeInteger(from)) {
		throw new RangeError(`Window from must be an entry ID, got ${from}`);
	}
	return { from, min, max };
}

/**
 * The Harness's conversation view mounts: at most one per conversation, built on the Session line by its first
 * observer and dropped with its last. Each mount advances from the Session's commits as memory adopts them, deferred ones
 * (`CommitPersistence`) before they are stored, and hands each observer the next revision of its own window.
 */
/**
 * 会话视图挂载管理器：每个会话至多一个 Mount，首个观察者在线构建、最后一个离开时释放。
 * 输入：构造时给 SessionImpl（提交发布、关闭、串行线、文档读取、错误上报）。
 * 输出：observe 返回 Observation<ConversationView>；watch 返回 WatchHandle；attach 供两者复用。
 * 副作用：构造时把实例注册进 VIEWS，订阅 followCommits 与 subscribeClose；挂载时扫描存储；发布时逐窗口
 *   计算 ops 并同步调用观察者；不写存储。
 * 错误：窗口参数非法以 RangeError 拒绝，会话不存在在构建时以 Error 拒绝；存储读取失败使 attach 拒绝；
 *   观察者抛错由 contained 捕获后经 report 交给 Harness；关闭后 attach 以 closedError 拒绝。
 * 流程：构造 -> attach（#build + loadWindow）-> followCommits 的 advance -> 最后一个 detach -> 关闭 end。
 * 例：const views = new ConversationViews(session); const seen = await views.observe(id, observer, context);
 */
export class ConversationViews {
	// # 私有字段：会话引用；#mounts 按会话 ID 保存共享挂载；#closed 阻止关闭后的新挂载。
	readonly #session: SessionImpl;
	readonly #mounts = new Map<ConversationId, Mount>();
	#closed = false;

	constructor(session: SessionImpl) {
		// 保存依赖并把 this 注册到 WeakMap；适配器可凭同一个 harness 对象取回。
		this.#session = session;
		VIEWS.set(session, this);
		// 监听所有提交（stored 与 memory）。每个挂载只处理自己会话的 entry/document 变更；
		// 这里没有像任务图那样跳过 memory，因为文档变更可能在存储前就对外可见。
		session.followCommits((publication, context) => {
			for (const [id, mount] of this.#mounts)
				advance(id, mount, publication, context, (error) => this.report(error));
		});
		session.subscribeClose(() => {
			// 关闭标记让后续 attach 拒绝；随后通知所有挂载的观察者。
			this.#closed = true;
			// 正常关闭 watch 得 ended、同步 observer 得 failed("session closed")；失败关闭两者都是原错误。
			const ends = closeEnds(this.#session.failure);
			// 复制观察者集合：end 回调可能同步 detach，直接遍历 Set 会漏掉或跳过元素。
			for (const mount of this.#mounts.values())
				for (const windowed of [...mount.observers]) {
					// contained 同时处理同步 throw 与异步拒绝，单个观察者失败不影响其他观察者。
					contained(
						() => windowed.observer.end(closeEndOf(windowed.observer, ends)),
						(error) => this.report(error),
					);
				}
			// 丢弃全部挂载；观察者集合、文档缓存与窗口值随之可回收。
			this.#mounts.clear();
		});
	}

	/** Report an observer's listener error through the Harness. */
	// 公开方法：observe/watch 的错误回调经它进入 Harness.report；参数刻意用 unknown，允许任何被抛出的值。
	report(error: unknown): void {
		this.#session.report(error);
	}

	/**
	 * Attach a synchronous observer of the view (`Harness.observeConversation()`), behind `guardObserver()`; `context`
	 * governs only the attachment.
	 */
	/**
	 * 同步观察会话视图：返回首帧值与 detach；窗口参数只作用于该观察者。
	 * 输入：会话 ID、Observer<ConversationView>、context、可选 window。
	 * 输出：Observation，value 是挂载时的窗口首帧，detach 幂等。
	 * 副作用：在 Session line 上按需构建 Mount 与自己的窗口，并登记经 guardObserver 包装的观察者。
	 * 错误：窗口/会话/存储错误使 Promise 拒绝；挂载完成时若 context 已取消，detach 后抛 signal.reason。
	 * 注意：挂载成功后 context 再取消不会自动 detach；需要取消语义时用 watch。
	 * 例：const seen = await views.observe(id, observer, context, { min: 10, max: 20 });
	 */
	async observe(
		id: ConversationId,
		observer: Observer<ConversationView>,
		context: Context,
		window?: ConversationWindow,
	): Promise<Observation<ConversationView>> {
		// 明确赋值断言：create 在 attach 内同步执行并赋值 value，TS 无法跨回调证明。
		let value!: ConversationView;
		const attached = await this.attach(
			id,
			window,
			(current, release) => {
				value = current;
				// guardObserver 统一处理 detach 与错误上报，保证观察者异常不破坏发布循环。
				return guardObserver(observer, release, (error) => this.report(error));
			},
			context,
		);
		// 构建期间可能被取消；已登记则先撤销，再以原原因拒绝。
		const signal = context.abortSignal;
		if (signal?.aborted) {
			attached.detach();
			throw signal.reason;
		}
		// 只把首帧值和包装后的 detach 交给调用方，不暴露 Mount。
		return observation(value, attached.observer);
	}

	/** A serialized watch of the view, an observer of its mount; aborting `context` ends it `aborted`. */
	/**
	 * 取得某个窗口的序列化 watch：一次一个回调，期间的变更合并到下一帧。
	 * 输入：会话 ID、context、可选 window；输出：Promise<WatchHandle<ConversationView>>。
	 * 副作用：挂载 Watch 观察者；context 的 abortSignal 在挂载后登记，watch 结束自动解绑。
	 * 错误：构建错误拒绝；挂载后若已取消，先 abort 再抛 signal.reason。
	 * 例：const watch = await views.watch(id, context, { max: 200 }); watch.start(async (call) => {});
	 */
	async watch(
		id: ConversationId,
		context: Context,
		window?: ConversationWindow,
	): Promise<WatchHandle<ConversationView>> {
		// 只取 observer；detach 作为 release 交给 Watch，由它终止时调用。
		const { observer } = await this.attach(
			id,
			window,
			(value, release) => new Watch<ConversationView>(value, release, (error) => this.#session.report(error)),
			context,
		);
		const signal = context.abortSignal;
		// 挂载期间已取消：终止刚创建的 watch，避免留下无人消费的挂载。
		if (signal?.aborted) {
			observer.abort();
			throw signal.reason;
		}
		// 之后的取消由 observeAbort 监听；无信号时只受 stop/关闭影响。
		if (signal !== undefined) observer.observeAbort(signal);
		return observer;
	}

	/**
	 * Register an observer created from its window's first revision, atomically on the Session line: it sees every later
	 * publication and nothing earlier. `release` drops it, and the mount with its last observer.
	 */
	/**
	 * 在 Session 串行线上原子挂载一个观察者：复用或构建 Mount，再读取该观察者自己的首帧窗口。
	 * 输入：会话 ID、窗口参数、create 工厂（首帧值 + release -> 观察者）、context。
	 * 输出：{ observer, detach }；detach 移除该窗口，最后一个窗口离开时删除 Mount。
	 * 错误：窗口非法以 RangeError 拒绝；会话不存在/存储错误拒绝；构建期间关闭抛 closedError；已取消抛取消原因。
	 * 流程：resolveWindow -> readOnLine -> 取/建 Mount -> loadWindow -> create -> 关闭/取消检查 -> 登记。
	 * 例：const { observer } = await this.attach(id, { min: 5 },
	 *   (value, release) => new Watch<ConversationView>(value, release, report), context);
	 */
	async attach<O extends ViewObserver>(
		id: ConversationId,
		window: ConversationWindow | undefined,
		create: (value: ConversationView, release: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		// 先校验窗口；async 函数中的 throw 会转成返回 Promise 的拒绝。非法参数不会排队到 Session line。
		const bounds = resolveWindow(window);
		// readOnLine 保证 Mount 的构建/登记与 Session 的提交处理互斥。
		return this.#session.readOnLine(async (storage) => {
			// 已有挂载则共享会话记录、文档与 incarnations；没有则在行内读取并构建。
			const mount = this.#mounts.get(id) ?? (await this.#build(storage, id, context));
			// 窗口是每个观察者独立的：即便 Mount 已存在，也要重新读取首帧 entries。
			const { entries, before } = await loadWindow(storage, id, bounds, context);
			// 首帧值共享 mount.docs，但 entries/before 来自本观察者的窗口。
			const value = view(mount.conversation, entries, before, mount.docs);
			// windowed 在 create 之后才赋值；detach 可能在此之前被调用（当前工厂不会），因此先判 undefined。
			let windowed: Windowed | undefined;
			const detach = (): void => {
				if (windowed !== undefined) mount.observers.delete(windowed);
				// 只有当前 Mount 的最后一个观察者离开时才丢弃；防止旧 detach 误删新 Mount。
				if (mount.observers.size === 0 && this.#mounts.get(id) === mount) this.#mounts.delete(id);
			};
			const observer = create(value, detach);
			// Close or cancellation may begin while the mount hydrates; register nothing then.
			// 构建/读窗口期间 Session 可能关闭或调用方取消；检查通过前不登记，避免留下无法收尾的观察者。
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			// 登记窗口记录、把 Mount 设为当前、加入观察者集合，三步在同一 Session line 内完成，外部看不到中间态。
			windowed = { min: bounds.min, max: bounds.max, value, observer };
			this.#mounts.set(id, mount);
			mount.observers.add(windowed);
			return { observer, detach };
		});
	}

	/** Hydrate a mount on the line, through the line's `storage`. */
	/**
	 * 首次构建一个会话挂载：在 Session line 上读取会话记录和五个内建文档的当前值。
	 * 输入：行内 Storage、会话 ID、context；输出：Mount（observers 为空，由 attach 登记第一个窗口）。
	 * 副作用：只读；对每个挂载文档调用 conversationDocumentOnLine（该调用本身在行内）。
	 * 错误：会话不存在抛 Error；存储/文档读取失败向上传播，调用方的 attach 拒绝。
	 * 例：会话 3 有 pi.agent/pi.live 两个文档 -> docs 含这两个键，incarnations 记录各自 id/version。
	 */
	async #build(storage: Storage, id: ConversationId, context: Context): Promise<Mount> {
		const conversation = await storage.conversation(id, context);
		// 观察不存在的会话是调用方错误：直接失败，而不是返回空视图。
		if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
		const docs: Record<string, JsonObject> = {};
		// 每个 kind 只挂载一个实例；incarnations 用于把后续提交匹配到当前实例与版本。
		const incarnations = new Map<string, { id: DocumentId; version: number }>();
		for (const token of MOUNTED) {
			// conversationDocumentOnLine 返回 { record, version, value } 或 undefined（文档尚未创建）。
			const loaded = await this.#session.conversationDocumentOnLine(token, id, context);
			// 缺失的文档不写键，观察者用 docs[kind] === undefined 判断。
			if (loaded === undefined) continue;
			// token.definition.kind 是文档定义的稳定 kind，如 "pi.agent"。
			docs[token.definition.kind] = loaded.value;
			incarnations.set(token.definition.kind, { id: loaded.record.id, version: loaded.version });
		}
		return { conversation, docs, incarnations, observers: new Set() };
	}
}

/** A view revision; `before` is a key only when set. */
/**
 * 组装一帧 ConversationView；纯函数，不复制 entries/docs，只决定是否加入 before 键。
 * 输入：会话记录、窗口 entries、可选 before、共享 docs；输出：新的视图对象。
 * 错误/副作用：无。例：before 为 undefined 时结果没有 before 属性。
 */
function view(
	conversation: ConversationRecord,
	entries: readonly EntryRecord[],
	before: EntryId | undefined,
	docs: Readonly<Record<string, JsonObject>>,
): ConversationView {
	// 两个分支的对象字面量键序一致（before 插在 entries 与 docs 之间），便于 JSON 比较与阅读。
	return before === undefined ? { conversation, entries, docs } : { conversation, entries, before, docs };
}

/**
 * A new observer's window, read on the Session line with bounded scans: the entries from `from` when at most `max` are
 * at or after it, otherwise the newest `min`, and the entry before them.
 */
/**
 * 读取一个新观察者的首帧窗口：优先按 from，否则取最新 min 条；同时给出窗口前一条记录。
 * 输入：行内 Storage、会话 ID、已校验的 bounds、context。
 * 输出：entries 按 ID 升序；before 是窗口前一条的 ID，窗口从转录开头开始时为 undefined。
 * 规则：from 分支最多探测 max+1 条；若不超过 max 就用它，否则退回“最新 min 条”。
 * 错误：存储扫描失败向上传播；不做额外校验。
 * 例：最新 120 条、min=50/max=100 -> entries 为最新 50 条，before 是第 51 条最新（被排除的下一条）的 ID。
 */
async function loadWindow(
	storage: Storage,
	conversationId: ConversationId,
	bounds: WindowBounds,
	context: Context,
): Promise<{ entries: readonly EntryRecord[]; before: EntryId | undefined }> {
	const { from, min, max } = bounds;
	if (from !== undefined) {
		// 从 from（含）向上扫，多取一条用于判断“是否超过 max”；order 显式升序，结果可直接作为窗口。
		const since = await scanUpTo(storage, { conversationId, minEntryId: from, order: "ascending" }, max + 1, context);
		if (since.length <= max) {
			// 前一条记录：用 from-1 作为上界再取 1 条；默认降序，得到小于 from 的最大 ID。
			// idFromNumber 只是把数字断言为品牌类型 EntryId，运行时无操作。
			const query = { conversationId, maxEntryId: idFromNumber<EntryId>(from - 1) };
			const previous = (await storage.scanEntries(query, 1, undefined, context)).items[0];
			return { entries: since, before: previous?.id };
		}
	}
	// 默认路径：不指定 order，EntryQuery 默认降序，取最新 min+1 条。
	const newest = await scanUpTo(storage, { conversationId }, min + 1, context);
	// 多出的一条是最旧的候选：把它 pop 出来作为 before；length > min 保证数组非空。
	const before = newest.length > min ? newest.pop()!.id : undefined;
	// 降序数组反转成升序；mutate 的是本函数刚创建的数组。
	return { entries: newest.reverse(), before };
}

/** Up to `limit` entries of `query`, following cursors past short pages. */
/**
 * 最多读取 limit 条记录；页很短但仍有 next 时继续翻页，直到够数或没有游标。
 * 输入：storage、查询、limit、context；输出：按查询顺序排列的数组（最多 limit 条）。
 * 错误：任何一页失败都拒绝并丢弃已读结果；不修改 query 或 storage。
 * 例：limit=100、页大小 256 -> 只请求 min(256,100)=100 条，一次往返。
 */
async function scanUpTo(storage: Storage, query: EntryQuery, limit: number, context: Context): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	// 首次 cursor 为 undefined；之后用上一页的 next。
	let cursor: Cursor | undefined;
	do {
		// 每页只请求剩余所需数量与页大小的较小值，避免多读。
		const page = await storage.scanEntries(query, Math.min(SCAN_PAGE_SIZE, limit - entries.length), cursor, context);
		// 展开 push 保持页内顺序；查询的 order 决定整体是升序还是降序。
		entries.push(...page.items);
		cursor = page.next;
		// 够数就停；即使 next 仍存在也不再请求。
	} while (cursor !== undefined && entries.length < limit);
	return entries;
}

/**
 * Derive the mount's operations from one publication and hand each observer the next revision of its window; one that
 * throws is reported through `report`, and the others still get theirs. Documents are applied once and shared; each
 * window takes the appended entries and, past its `max`, drops its oldest down to its `min` in one splice.
 */
/**
 * 把一次提交折算成视图变化：文档 op 只应用一次，entries 追加与裁剪按每个观察者的窗口分别计算。
 * 输入：会话 ID、Mount、提交发布（stored 或 memory）、帧 context、错误上报。
 * 输出/副作用：更新 mount.docs 与每个 windowed.value，并同步调用观察者 advance；不写存储。
 * 错误：观察者错误由 contained 捕获后交给 report，单个失败不影响其他窗口；applyImmutable 自身抛出的错误
 *   会离开本函数，由 Session 的提交发布路径处理。
 * 流程：收集 entry 追加与文档 ops -> 无变化则返回 -> 应用文档 -> 逐窗口生成 ops 与下一帧。
 * 例：提交新增 3 条 entry，某窗口已有 40 条、max=40、min=20 -> 追加到 43 条后一次裁掉最旧 23 条。
 */
function advance(
	id: ConversationId,
	mount: Mount,
	publication: ObservedCommit,
	context: Context,
	report: (error: unknown) => void,
): void {
	const docOps: Op[] = [];
	// Entry writes are published in ID order.
	// appended 保持提交内 entry 的发布顺序；原注释约定该顺序是 ID 升序，窗口因此可直接在尾部追加。
	const appended: EntryRecord[] = [];
	for (const change of publication.changes) {
		// 只取本会话的 entry；entry 变更没有文档路径，直接进入追加列表。
		if (change.type === "entry" && change.value.conversationId === id) {
			appended.push(change.value);
			continue;
		}
		// document.copy 的 type 是 "document.copy"，在此被排除；其他会话的文档也跳过。
		if (change.type !== "document" || change.conversationId !== id) continue;
		const kind = change.record.kind;
		// 只挂载五个内建、无 family key 的单例文档。
		if (!MOUNTED_KINDS.has(kind) || change.record.key !== undefined) continue;
		// 文档值在视图中的路径固定为 docs.<kind>。
		const path: NonEmptyPath = ["docs", kind];
		const mounted = mount.incarnations.get(kind);
		if (change.kind === "retire") {
			// 旧实例的 retire 与新实例无关：只处理当前挂载实例的 retire。
			if (mounted?.id !== change.record.id) continue;
			mount.incarnations.delete(kind);
			docOps.push(["d", path]);
		} else if (mounted?.id === change.record.id && mounted.version === change.version) {
			// 同一实例、同一定义版本：提交里的 ops 是相对上一值的增量，逐条移到 docs.<kind> 下。
			for (const op of change.ops) docOps.push(prefixed(op, path));
		} else {
			// 新实例或定义版本变化：增量不可复用，直接整体设置当前值并更新挂载记录。
			mount.incarnations.set(kind, { id: change.record.id, version: change.version });
			docOps.push(["s", path, change.value]);
		}
	}
	// 与本会话无关，或文档/entry 都没变：不产生新 revision。
	if (docOps.length === 0 && appended.length === 0) return;
	if (docOps.length > 0) mount.docs = applyImmutable({ docs: mount.docs }, docOps).docs;
	// 帧 context 去掉取消信号；提交结束后原 signal 可能已中止，不应影响观察者处理该帧。
	const frameContext = withoutAbortSignal(context);
	// EntryRecord 实际是 JSON，但缺少 JsonValue[] 需要的索引形状，故显式断言。
	const inserted = appended as unknown as JsonValue[];
	// 复制观察者集合：advance 内 detach 不会影响本轮其他窗口。
	for (const windowed of [...mount.observers]) {
		const previous = windowed.value;
		let entries = previous.entries;
		let before = previous.before;
		// 文档 op 对所有窗口相同；只有追加时才创建新数组，避免无谓复制。
		let ops: Op[] = docOps;
		if (appended.length > 0) {
			// ["p", path, index, deleteCount, items]：在 entries 末尾插入本提交的记录。
			ops = [...docOps, ["p", ["entries"], entries.length, 0, inserted]];
			entries = entries.concat(appended);
			if (entries.length > windowed.max) {
				// 一次裁到 min：drop 条最旧记录被移除。
				const drop = entries.length - windowed.min;
				// 裁剪后窗口的前一条就是被删掉的最后一条。
				before = entries[drop - 1]!.id;
				entries = entries.slice(drop);
				// 同一帧里先从头删除 drop 条，再更新 before；索引基于裁剪前的数组。
				ops.push(["p", ["entries"], 0, drop, []], ["s", ["before"], before]);
			}
		}
		// 每个窗口得到自己的新视图；docs 引用共享。
		windowed.value = view(mount.conversation, entries, before, mount.docs);
		// retired=false：视图源不退休值；watch 的终止走 end。
		const call: WatchCall<ConversationView> = { kind: "value", value: windowed.value, ops, retired: false };
		// contained 接住同步异常/异步拒绝；report 不会中断其他观察者。
		contained(() => windowed.observer.advance(call, frameContext), report);
	}
}

/** `op` moved under `prefix`; a root replacement becomes a set of the prefix. */
/**
 * 把文档根上的一个 op 移到视图的 docs.<kind> 子树下；纯函数，返回新的元组。
 * 输入：文档提交的 op、目标前缀（["docs", kind]）；输出：路径已加前缀的等价 op。
 * 特殊：根替换 ["r", value] 没有可拼接的路径，改为 ["s", prefix, value] 设置整个文档子树。
 * 其他 op 把原路径接到 prefix 后；p/m 的路径原本可为空，拼接后必为非空。
 * 错误：无；switch 覆盖 Op 的所有首元素，新增变体会让编译期报错。
 * 例：["s", ["phase"], "run"] 在 prefix ["docs","pi.live"] 下变为 ["s", ["docs","pi.live","phase"], "run"]。
 */
function prefixed(op: Op, prefix: NonEmptyPath): Op {
	// at 生成“前缀 + 原路径”；展开得到普通 string[]，TypeScript 无法证明非空，故断言。
	const at = (path: Path): NonEmptyPath => [...prefix, ...path] as unknown as NonEmptyPath;
	// op[0] 是 delta 的操作码判别式；每个分支保留其余元组元素。
	switch (op[0]) {
		case "r":
			return ["s", prefix, op[1]];
		case "p":
			return ["p", at(op[1]), op[2], op[3], op[4]];
		case "m":
			return ["m", at(op[1]), op[2]];
		case "s":
			return ["s", at(op[1]), op[2]];
		case "d":
			return ["d", at(op[1])];
		case "a":
			return ["a", at(op[1]), op[2]];
		case "t":
			return ["t", at(op[1]), op[2]];
	}
}
