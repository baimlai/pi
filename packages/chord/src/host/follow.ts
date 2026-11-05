// Followed sources (slice 6b D9, R4, §3): `self.follow(attach)`, a Chord source over a synchronous observer of another
// runtime (Durable's `observeConversation`, `observeTaskGraph`, `observeDoc`). Attached during its attempt's
// activation, detached at the attempt's end. Calls inside a running batch (Durable adopting in the store's commit step)
// are marked in that batch, calls outside one are grouped into one batch on the next microtask, so a derive over two
// views of one commit computes once with both changes.
// 文件导读
// 所属：packages/chord/src/host（主机层），把外部运行时的同步观察者包装成 Chord 源。
// 职责：缓存值、按序应用调用、把批次外调用合并到下一微任务、在外部结束时先交付再结束 watch。
// 边界：不解释数据形状、不校验值；失败/结束语义由 FollowOwner（Attempt）决定。
// 上游：Attempt 的 self.follow 创建，并在激活时 attach；Attempt.detach 在结束时 detach。
// 下游：derive/on/watch 订阅；Source 批次负责发布；owner.ended 触发激活失败或 live 失败。
// 错误：attach 返回 undefined 或 reject、读取未 attach 的值抛 not_ready；外部 failed 上报 transient。
// 能力清单：
// - FollowObserver<T>：advance/end 两个同步回调。
// - FollowAttachment<T>：初始值 + detach。
// - FollowAttach<T>：把 observer 接到外部运行时的异步函数。
// - FollowOwner：label/context/ended 回调。
// - FollowSource：Source 子类，实现 attach、detach、watch 与批次交付。
// 组合与顺序：follow -> attach -> advance 入队/应用 -> batch deliver -> 外部 end -> 帧后 endWatches。
// 示例：const doc = self.follow((observer) => runtime.observeDoc(id, observer));
// 建议阅读顺序：FollowObserver/Attachment/Attach -> FollowState -> FollowSource.attach -> #advance/#end
// -> deliver/openWatch。

import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { type Batch, Source, type Subscriber } from "../state/internal.ts";
import type { Watch, WatchCall, WatchEnd } from "../watch.ts";

/** The observer a followed runtime is given: Chord's watch shapes (Durable's `Observer`). */
// 交给外部运行时的观察者接口。advance 是同步的“有新调用”；end 表示源失败或永久结束。
// T 只是调用方看到的类型参数；运行时不会校验值形状，因为 Chord 只记录并转发。
export type FollowObserver<T> = {
	/** One change, synchronously and quickly: Chord only records it. */
	// 外部运行时在它自己的同步流程里调用；这里必须快速返回，不能 await，否则会拖慢对方提交。
	// call 携带 kind、value/ops/retired 等字段；context 是外部运行时的上下文，仅用于计时/追踪。
	advance(call: WatchCall<T>, context: Context): void;
	/** The followed source ended: `failed` (its runtime failed), or `ended` for good. */
	// 结束通知：failed 表示外部运行时异常（可重试）；ended 表示永久结束（不再重连，保留最后值）。
	end(end: WatchEnd): void;
};

/** What attaching gives: the value every later call starts from, and how to detach (Durable's `Observation`). */
// attach 成功后的返回：value 是初始值，detach 用于断开观察；返回 undefined 表示目标地址不存在。
export type FollowAttachment<T> = { readonly value: T; detach(): void };

/**
 * What `self.follow` takes: attaches `observer`, resolving with the attachment, `undefined` for an absent address.
 * The observer takes calls of any value (it only records them), so `T` is inferred from the attachment alone.
 */
// attach 回调的签名。输入 observer 与上下文，返回 Promise<FollowAttachment<T> | undefined>。
// 注意 observer 的值类型是 unknown：Chord 不依赖外部值类型，T 只由返回的 attachment 推导。
// 例：self.follow((observer) => runtime.observeConversation(id, observer))。
export type FollowAttach<T> = (
	observer: FollowObserver<unknown>,
	context: Context,
) => Promise<FollowAttachment<T> | undefined>;

/** Who a followed source belongs to: its attempt (R4) and its context. */
// 源的所有者：label 用于错误消息，context 用于批次外排程，ended 把外部结束上报给尝试。
export type FollowOwner = {
	// 对象 label；错误与诊断消息使用。
	readonly label: string;
	// 所有者上下文；批次外调用排程时传给 batch.soon，使工作归属正确。
	readonly context: Context;
	/**
	 * The followed runtime ended its observer: `failed` fails the attempt `transient` (live or activating, its retry
	 * attaches again); `ended` while the attempt activates fails it `transient` too (it would go live on a source that
	 * ended); `ended` while live is final for the source only.
	 */
	// 尝试根据当前处于激活还是已经 live 决定语义；这里只转交，不自行判断。
	ended(end: WatchEnd): void;
};

/**
 * Where a followed source stands: waiting for its attachment (with the runtime's end when it came first), attached,
 * ended by the runtime (its value stays; detached at its attempt's end), or detached by its attempt.
 */
// 四态可辨识联合。ended 与 detached 都带 detach（ended 仍持有外部观察，必须在尝试结束时断开）；
// detached 不再持有任何资源。attaching 记录“在 attach 完成前就收到的 end”，attach 成功后立即转为 ended。
type FollowState =
	| { readonly kind: "attaching"; readonly end: WatchEnd | undefined }
	| { readonly kind: "attached"; readonly detach: () => void }
	| { readonly kind: "ended"; readonly detach: () => void }
	| { readonly kind: "detached" };

// 共享空操作数组：发布时没有 op 就不分配新数组。
const NO_OPS: readonly Op[] = [];

// 共享的“永久结束”事件；WatchEnd 只读，复用安全。
const ENDED: WatchEnd = { kind: "ended" };

/** A followed source: the runtime's value, its calls applied in order, its frames delivered in the host's batch. */
// 跟随源。构造输入：attach 回调、所有者、主机的 Batch；不立即连接外部运行时（连接发生在 attach 方法）。
// 输出是一个 Watchable：derive/on/watch 可以订阅；值来自外部运行时。
// 例：const conversation = self.follow((observer) => runtime.observe(id, observer));
export class FollowSource extends Source {
	// 外部连接函数；attach 时调用一次。
	readonly #attach: FollowAttach<JsonValue>;
	// 所有者信息：label、上下文与结束回调。
	readonly #owner: FollowOwner;
	// 初始为“等待 attach”；end 字段预留给 attach 未完成时先到的结束事件。
	#state: FollowState = { kind: "attaching", end: undefined };
	// 最近一次值；undefined 也表示尚未 attach，因此 value getter 用它判断是否可就绪。
	#value: JsonValue | undefined;
	/** Calls not applied yet: before the attachment resolved, and outside a batch until the next microtask. */
	// 待应用调用队列：attach 前的调用，以及批次外调用；按到达顺序应用。
	#queued: WatchCall<JsonValue>[] = [];
	/** Whether a microtask is queued to apply `#queued` in a batch of its own. */
	// 防止批次外调用为每条调用各排一个微任务，一组调用共享一次排程。
	#scheduled = false;
	/**
	 * The runtime's end, still to reach the watches: `queued` after the queued calls' batch, `frame` after the current
	 * batch's frame (a retirement and an end in one batch: the retirement first).
	 */
	// 结束尚未送达 watch 的阶段：queued 表示等排队调用所属批次；frame 表示等当前批次帧送达。
	#ending: "none" | "queued" | "frame" = "none";
	/** The ops of the current batch's frame (kept only while watched), and whether a retirement came in it. */
	// 当前帧内累积的 op；只有被观察时才保存，避免无观察者时无限积累。
	#ops: Op[] = [];
	// 本帧是否收到 retired（文档退休）；发布时作为 publish 的第三个参数。
	#retired = false;
	// 本批次是否已经调用过 changed()，保证一个批次只标记一次变化。
	#listed = false;

	// 保存依赖并交给 Source 的批次机制；不连接外部运行时，因此构造无外部副作用。
	constructor(attach: FollowAttach<JsonValue>, owner: FollowOwner, batch: Batch) {
		super(batch);
		this.#attach = attach;
		this.#owner = owner;
	}

	// 读取最近值。尚未 attach 时抛 not_ready（code 是 ChordError 已定义的错误码），而不是返回 undefined，
	// 因为 undefined 也可能是合法的 JSON 值。同步、无副作用。
	// 例：成员检查期间读取 derive 会触发该 getter；正常激活顺序保证 attach 已先完成。
	get value(): JsonValue {
		if (this.#value === undefined) {
			throw new ChordError({
				code: "not_ready",
				message: `${this.#owner.label}: a followed source read before it attached`,
			});
		}
		return this.#value;
	}

	/**
	 * Attaches (activation, after the natives opened): the calls that came meanwhile apply on the attachment's value,
	 * and an end that came meanwhile takes effect then (the value stays). A rejected attachment, or `undefined` (an
	 * absent address), throws; an attachment arriving after its attempt detached the source is detached at once.
	 */
	// 连接外部运行时。输入是激活期上下文；返回 Promise<void>。副作用：注册观察者并保存 detach。
	// 错误：attach reject、返回 undefined、或已收到 ended 时抛/导致失败（由调用方 #ownSteps 转换为 transient）。
	// 主要流程：构造 observer -> await attach -> 缺失地址报错 -> 若期间已 detach 则立即断开 ->
	// 用 attachment.value 作为当前值，按序重放排队调用 -> 根据期间是否收到 ended 决定最终状态。
	// 例：attach 返回 { value: [], detach }；排队中有一条 value 调用则 #value 更新为那次调用值。
	async attach(context: Context): Promise<void> {
		// 观察者方法用箭头函数绑定 this；外部运行时只看到两个同步函数。
		const observer: FollowObserver<JsonValue> = {
			advance: (call) => this.#advance(call),
			end: (end) => this.#end(end),
		};
		// 真正连接；插件/运行时代码可能在 await 期间调用 advance/end。
		const attached = await this.#attach(observer, context);
		// undefined 是“地址不存在”的明确约定，按不可用失败，而不是当作空值。
		if (attached === undefined) {
			throw new ChordError({ code: "unavailable", message: `${this.#owner.label}: the followed address is absent` });
		}
		const state = this.#state;
		// 包一层，避免把外部对象的 detach 方法直接暴露出去丢失 this。
		const detach = () => attached.detach();
		// 等待期间尝试已结束并 detach 了源：迟到的连接必须立刻断开。
		if (state.kind !== "attaching") {
			detach();
			return;
		}
		// 初始值来自 attachment；之后的调用在此基础上推进。
		this.#value = attached.value;
		// Nothing watches it yet (members are checked after this): the queued calls only move the value on.
		// 此时还没有成员检查，所以不会有 watch；只需按顺序取 value 类型调用的最新值，ops 无需保留。
		for (const call of this.#queued) if (call.kind === "value") this.#value = call.value;
		// 清空队列，防止重复应用。
		this.#queued = [];
		// 如果等待期间收到 ended，最终状态直接是 ended（保留值，但仍持有 detach 供尝试结束清理）。
		this.#state = state.end?.kind === "ended" ? { kind: "ended", detach } : { kind: "attached", detach };
	}

	/** Its attempt ended: the observer is detached (also after the runtime ended it) and its watches end `ended`. */
	// 尝试结束时断开。输入无；返回 void。状态先置 detached（后续 advance/end 全部丢弃），清空队列，
	// 若仍持有外部 detach 就调用，最后同步结束所有 watch。重复调用安全。
	detach(): void {
		const state = this.#state;
		this.#state = { kind: "detached" };
		this.#queued = [];
		// attaching 状态没有 detach 可调；attached/ended 都持有。
		if (state.kind === "attached" || state.kind === "ended") state.detach();
		this.endWatches();
	}

	/** A watch of an ended source opens at its value and ends `ended` at once. */
	// override 表示覆盖 Source 的同名方法。先走父类建立 watch，再根据 #over 决定是否立即结束。
	// 例：外部源已 ended 后再 watch，会先拿到当前值，然后马上收到 ended 回调。
	override openWatch(context: Context): Watch<JsonValue> {
		const watch = super.openWatch(context);
		// #over 为 true 表示不会再有交付（已结束且结束帧已送出，或已 detach）。
		if (this.#over) watch.end(ENDED);
		return watch;
	}

	/** A subscriber of an ended source (a reference's watch through its member) ends `ended` at once. */
	// 内部订阅者（例如引用成员）走 subscribe 而非 openWatch；同样立即结束，避免挂起。
	// 未结束时交回父类登记，之后由批次交付。
	override subscribe(subscriber: Subscriber): void {
		if (this.#over) subscriber.end(ENDED);
		else super.subscribe(subscriber);
	}

	// 批次交付：把本批次累积的 ops 和 retired 一次性 publish 给 watch，然后清理累积状态。
	// value! 非空断言成立：只有 attach 成功后才会进入批次并产生交付。
	deliver(context: Context): void {
		const ops = this.#ops;
		const retired = this.#retired;
		// 先重置累积字段，再发布；发布回调可能同步再次触发调用，不能带着旧状态。
		this.#ops = [];
		this.#retired = false;
		this.#listed = false;
		this.publish(this.#value!, ops.length === 0 ? NO_OPS : ops, retired, context);
		// 若结束在等这一帧（retirement 先于 end），发布完再结束 watch。
		if (this.#ending === "frame") {
			this.#ending = "none";
			this.endWatchesAfterDelivery();
		}
	}

	/** Whether nothing reaches its watches any more: ended by the runtime (what it gave delivered) or detached. */
	// 私有 getter 也是属性访问；条件用 && 与 || 组合，读作“已结束且没有待送达的结束帧，或已经 detached”。
	// 结束但仍有待送达调用时不算 over，保证最后一条值能到达 watch。
	get #over(): boolean {
		const { kind } = this.#state;
		return (kind === "ended" && this.#ending === "none") || kind === "detached";
	}

	/**
	 * A call of the runtime: before the attachment, queued; inside a running batch, applied there (after what was
	 * queued); outside one, queued for one batch on the next microtask.
	 */
	// 外部运行时的每次调用入口。输入一条 WatchCall（值调用或退休等），无返回。
	// 已结束/已断开直接丢弃；attach 前或批次外先排队；批次内先冲刷旧队列再应用，保证顺序。
	// 例：Durable 在一个提交批次内先后调用两个视图的 advance，两条都在同一批次应用。
	#advance(call: WatchCall<JsonValue>): void {
		const { kind } = this.#state;
		if (kind === "ended" || kind === "detached") return;
		// attaching 时没有批次可加入；batch.running 为 false 时属于批次外调用。
		if (kind === "attaching" || !this.batch.running) {
			this.#queued.push(call);
			// attach 前不需要排微任务：attach 成功时会统一重放；attached 的批次外调用才需要下一微任务。
			if (kind === "attached") this.#schedule();
			return;
		}
		// 批次运行中：先按序应用之前排队的调用（可能来自 attach 前或批次外），再应用当前调用。
		this.#applyQueued();
		this.#apply(call);
	}

	/**
	 * The runtime ended its observer (R4); its attempt is told. `ended` is final: what came before reaches the watches
	 * first (the queued calls in their batch, a call of the running batch in its frame), then they end, the value
	 * staying. A `failed` attempt detaches the source.
	 */
	// 外部结束通知。attaching 时只记录第一次 end 并通知尝试；attached 且 ended 时转为 ended，
	// 先保证已排队的调用送达，再在帧后结束 watch；failed 不由本类改状态，由尝试失败后的 detach 清理。
	#end(end: WatchEnd): void {
		const state = this.#state;
		// 已结束或已断开：迟到通知忽略（ended 是最终态）。
		if (state.kind === "ended" || state.kind === "detached") return;
		if (state.kind === "attaching") {
			// 只保留第一次结束事件；??= 在这里用 if 表达，因为要区分“首次”与已有值。
			if (state.end === undefined) this.#state = { kind: "attaching", end };
			// attach 尚未完成就告诉尝试：尝试会中止激活并最终 detach。
			this.#owner.ended(end);
			return;
		}
		if (end.kind === "ended") {
			// 保留外部 detach，值保持不变；watch 在已排队的调用/当前帧之后结束。
			this.#state = { kind: "ended", detach: state.detach };
			// 批次外且有排队调用：等这些调用在下一微任务的批次里应用后，再结束。
			if (this.#queued.length > 0 && !this.batch.running) this.#ending = "queued";
			else {
				// Inside a running batch the queued calls join it (none is queued outside one: they wait for their batch).
				// 批次内：旧队列可立即应用（同属当前批次），当前调用已在本帧，随后等帧结束后结束 watch。
				this.#applyQueued();
				this.#endAfterFrame();
			}
		}
		// failed 或 ended 都通知所有者：failed 让尝试失败并重试；ended 在激活期失败、live 期只结束源。
		this.#owner.ended(end);
	}

	/** The watches end once this batch's frame reached them, at once when the source is in none. */
	// #listed 为 true 表示本批次已有待发布的帧；把结束标记为 frame，交给 deliver 在发布后处理。
	// 没有帧可等时立即结束，避免 watch 永远挂起。
	#endAfterFrame(): void {
		// No frame to wait for (nothing watches it): the end is over now, and a later watch ends at once.
		this.#ending = this.#listed ? "frame" : "none";
		if (!this.#listed) this.endWatchesAfterDelivery();
	}

	// 批次外调用：在下一微任务把排队调用放进一个批次应用；已有排程则合并。
	// batch.soon 使用所有者上下文，确保这个微任务在尝试结束时能被正确归属/取消。
	#schedule(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		this.batch.soon(() => {
			// 先清标记，回调执行期间的新调用可以再排一次。
			this.#scheduled = false;
			const { kind } = this.#state;
			// 已 detach 的源不再应用；attached/ended 都允许把最后的值交付出去。
			if (kind === "attached" || kind === "ended") this.#applyQueued();
			// 结束在等这个批次：应用完队列后走帧后结束逻辑。
			if (this.#ending === "queued") this.#endAfterFrame();
		}, this.#owner.context);
	}

	// 清空并逐条应用排队调用；空队列直接返回，避免无意义状态变更。
	#applyQueued(): void {
		const queued = this.#queued;
		if (queued.length === 0) return;
		this.#queued = [];
		for (const call of queued) this.#apply(call);
	}

	/** Applies one value call inside the running batch: the new value, its ops for the frame, the source marked once. */
	// 应用单条调用。非 value 调用（如失败）忽略：外部运行时的失败通过 end 表示，而不是调用。
	#apply(call: WatchCall<JsonValue>): void {
		// The runtime's failures are final: it ends its observer instead of sending one.
		if (call.kind !== "value") return;
		this.#value = call.value;
		if (call.retired) this.#retired = true;
		// 没有任何 watch/订阅者时不必保存逐条 ops；但仍要标记变化，让可能的依赖者失效。
		if (!this.watched) {
			this.changed();
			if (call.retired) this.retiredInBatch();
			return;
		}
		// 被观察时累积 ops，供本批次帧一次性交付。
		for (const op of call.ops) this.#ops.push(op);
		// 每批次只标记一次，避免同一源在同一批次重复进入待发布集合。
		if (!this.#listed) {
			this.#listed = true;
			this.changed();
		}
		if (call.retired) this.retiredInBatch();
	}
}
