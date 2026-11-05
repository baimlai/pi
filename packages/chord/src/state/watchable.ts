// Chord's JSON watchables: sources (documents and derives, with their watches and dependent derives) and constants.

// 文件导读
// 所属包与模块：packages/chord/src/state 的 JSON 可观察来源模块（design §11），属于 Chord 状态层。
// 职责边界：定义 JSON 值的 Source 基类与 Constant 实现，管理 watch/subscriber/dependent 的登记、批次内变更
// 登记与帧投递；不决定具体值（文档、derive 由子类实现），也不编码网络消息（flush 负责）。
// 上游：文档引擎、derive、replica、reference 成员继承 Source；应用调用 watch()。下游：帧进入 Watch.advance，
// 最终由链路发送或被 derive 读取；失败帧让 watch 保持打开，结束帧永久关闭。
// 错误流向：watch 监听器抛错交给 Batch.reportListener；openWatch 在失败且无最后好值时抛出 source 的错误；
// 批次内打开会被 assertOutside 拒绝为 invalid/reentrant。
// 能力清单：
// - Subscriber（接口）：批次内同步接收 advance/end/endAfterDelivery 的订阅者，用于链路与 reference 成员。
// - WatchStart（联合类型）：新 watch 的起点，正常值或“失败 + 最后好值”。
// - handedOut（函数）：交出错误前字符串化堆栈，避免应用长期持有 host 调用帧。
// - Dependent（接口）：可被 source 标脏/退役传播的读取方，derive 实现它。
// - Source（抽象类）：JSON 来源骨架，提供 dependents、watched、watch/openWatch/start、subscribe/unsubscribe，
//   以及受保护的 changed/retiredInBatch/publish/forward/failWatches/endWatches*。
// - constant（函数）与 Constant（类）：永不变化的 watchable。
// 组合关系与典型调用顺序：子类变更时调用 changed() 登记 -> Batch.commit 调用 deliver -> 子类 publish/forward
// -> Watch.advance 与 Subscriber.advance。watch 打开时先 start() 取起点，再登记并在失败时补发失败帧。
// 示例（真实签名）：const c = constant({ count: 0 }); const w = await c.watch(context);
// const s: Source = someDocument; s.openWatch(context); // reference 使用的同步版本
// 建议阅读顺序：先读 Subscriber/WatchStart/常量 ENDED，再看 Source 的字段和 watched，接着 openWatch/start，
// 然后 changed/publish/forward 与三种结束路径，最后读 Constant。

import type { Context } from "../context/index.ts";
import type { Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { Watch, type Watchable, type WatchCall, type WatchEnd } from "../watch.ts";
import type { Batch } from "./batch.ts";

/**
 * A synchronous subscriber of a source (a hold over a link, a reference's member): fed the source's call inside the batch
 * that made it, before the batch ends, so everything one commit changed can leave in one message. The watch's own sink
 * shape (`Watch.advance`, `Watch.end`).
 */
// 订阅者接口：比 watch 更底层，直接在批次内同步接收 call。
// 用途：链路持有（hold）和 reference 成员，它们需要在批次结束前把变化编入同一条消息。
// 与 watch 不同，subscriber 不排队、不复制值；它必须快速返回，不能抛错到发布路径。
export interface Subscriber {
	/**
	 * The source's call of this batch, in its batch's `context`: a value (the ops from the previous one, and whether its
	 * document was retired in it, or for a derive one of its sources' documents), or a failure it may recover from; the
	 * next value after a failure is `[["r", value]]`.
	 */
	// 接收本批次的一次 call：正常值是 {kind:"value", value, ops, retired}，失败是 {kind:"failed", error}。
	// 失败后 source 仍开放，恢复时下一帧带 "r"（replace）操作，表示订阅方必须整体替换旧值。
	// 示例：advance(call, context) { if (call.kind === "value") message.enqueue(call.ops); }
	advance(call: WatchCall<JsonValue>, context: Context): void;
	/** The source ended for good with `end`; nothing follows, and the subscriber is dropped. */
	// 永久结束：之后不会再有 advance；实现应释放句柄。end 是判别联合，常见值 {kind:"ended"}。
	// 示例：end({ kind: "ended" }) 触发后，订阅者从 source 的集合中移除。
	end(end: WatchEnd): void;
	/**
	 * The source ended for good after its last call (a followed runtime ended): a subscriber delivering later (a watch)
	 * ends `ended` once it delivered what it was given, others end now.
	 */
	// 延迟结束：先让已排队的最后一帧送达，再以 ended 结束。用于 followed runtime 自然结束的场景。
	// 示例：runtime 自然结束后调用；watch 先送完积压帧，订阅者立即结束。
	endAfterDelivery(): void;
}

/**
 * What a new watch of a source starts at (design §11): its value, or, while it is failed, the failure and its last good
 * value (`undefined` when it never had one: a watch cannot start then, there is nothing to start at).
 */
// watch 启动点的判别联合：
// - value：source 正常，直接以该值开始；
// - failed：source 处于失败态，新 watch 以 last（最后一次好值）开始，并立即收到失败帧；
//   如果 last 为 undefined（从未有过好值），watch 无法建立，openWatch 会抛该失败。
export type WatchStart =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined };

/**
 * An error Chord hands to apps (a failure call, a report), its stack made text first: until then V8 keeps the frames'
 * receivers, which would keep the host behind the throw alive for as long as an app keeps the error.
 */
// 交给应用之前先访问 error.stack，让 V8 立即把堆栈字符串化；否则错误对象会长期持有抛出点的
// 调用帧与接收者（例如整个 host），造成内存滞留。非 Error 原样返回。
export function handedOut<E>(error: E): E {
	if (error instanceof Error) void error.stack;
	return error;
}

/**
 * What reads a source and is marked by its changes: a derive, or a reference's member forwarding to derives (`Source.
 * dependents`).
 */
// 依赖者接口：source 变化时只做标记，不立即计算（惰性拉取）。
export interface Dependent {
	/** The source changed in the current batch: flags only, no compute. */
	// 输入无参数；实现必须只置脏标记，不能同步重算（重算发生在被读取时）。
	// 示例：derive.invalidate() 只把状态改为 dirty，不调用 compute。
	invalidate(): void;
	/** A source's document was retired in the current batch (rule 21); `visited` keeps a diamond walked once. */
	// 文档退役（rule 21）的传播：visited 防止菱形依赖重复遍历；实现把 retired 标记带进自己的帧。
	// 示例：derive.sourceRetired(visited) 继续把标记传给它的下游 derive。
	sourceRetired(visited: Set<Dependent>): void;
}

// 常量结束原因对象，可被多个 watch 共享；{} 是普通对象，运行时不可变由约定保证。
const ENDED: WatchEnd = { kind: "ended" };

/**
 * A changing value on a host (a singleton document, a derive, a replica): its watches and subscribers get one frame
 * per batch that changed it, and the derives reading it are marked dirty when it changes.
 */
// 抽象基类：实现 Watchable<JsonValue>，是所有 JSON 值来源的共同骨架。
// dependents 是公开只读集合，derive 挂接/移除自己；#watches/#subscribers 惰性分配（多数 reference 成员没有订阅者）。
export abstract class Source implements Watchable<JsonValue> {
	/** Derives reading this source (and references' members forwarding to some); each removes itself when it stops. */
	// 依赖集合：source 变化时逐个 invalidate；集合本身不负责生命周期，derive 停止时自行 delete。
	readonly dependents = new Set<Dependent>();
	// 受保护字段：子类需要用它登记 changed/flushing。JS 的 protected 仅编译期可见性。
	protected readonly batch: Batch;
	/** Its watches and subscribers, each made by its first: most sources (a reference's members) never have one. */
	// 两个集合都按需创建：undefined 表示从未有 watch/subscriber，读取时必须用可选链。
	#watches: Set<Watch<JsonValue>> | undefined;
	#subscribers: Set<Subscriber> | undefined;

	// 构造：只保存批次引用，不注册任何东西。示例：子类 constructor(batch) { super(batch); }
	constructor(batch: Batch) {
		this.batch = batch;
	}

	// 抽象读取器：每个具体 source 决定当前值（文档当前态、derive 缓存、副本值等）。
	abstract get value(): JsonValue;

	/** Whether a watch or a subscriber follows this source. */
	// 只读 getter：任一集合非空即视为被观察。?? 0 处理集合尚未分配的情况。
	get watched(): boolean {
		return (this.#watches?.size ?? 0) > 0 || (this.#subscribers?.size ?? 0) > 0;
	}

	// async 方法把同步的 openWatch 包装成 Promise；接口 Watchable.watch 的返回类型要求 Promise。
	// 示例：const w = await source.watch(ctx)。
	async watch(context: Context): Promise<Watch<JsonValue>> {
		return this.openWatch(context);
	}

	/**
	 * `watch` without the Promise, for references, which must register the watch before anything else runs. On a failed
	 * source it opens at the last good value and its first call is the failure; with no value to start at it throws the
	 * failure.
	 */
	// 同步打开 watch：reference 需要在同一同步段内先注册再读取。
	// 流程：拒绝批次内调用 -> 取启动点 -> 失败且无最后好值时抛错 -> 分配集合 -> 创建 Watch -> 注册 abort -> 失败时补发失败帧。
	openWatch(context: Context): Watch<JsonValue> {
		// 在批次投递/计算期间打开 watch 会造成半状态观察，统一拒绝（invalid/reentrant）。
		this.batch.assertOutside("watch");
		const start = this.start();
		// 失败且从未有过值：没有起点可给，直接把失败抛给调用方。
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		// 条件表达式收窄后，失败分支的 last 一定有值；! 只是向 TS 确认这一点（运行时无检查）。
		const value = start.kind === "value" ? start.value : start.last!;
		// ??= 只在 undefined 时创建集合，保留已有集合。
		this.#watches ??= new Set();
		// 局部常量让下面的闭包稳定引用同一个集合（省去重复属性访问）。
		const watches = this.#watches;
		// 第三个参数是错误上报回调：watch 监听器抛错时交给 host 的 onError，而不是打断投递。
		// 停止函数从集合中删除自己，实现 watch.stop() 的清理。
		const watch: Watch<JsonValue> = new Watch(value, () => watches.delete(watch), this.batch.reportListener);
		watches.add(watch);
		// 如果调用方带中止信号，watch 会在中止时结束；没有信号则不注册。
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		// 失败源的新 watch 先以最后好值建立，再立即收到一次失败帧（可能恢复）。
		if (start.kind === "failed") watch.fail(start.error, context);
		return watch;
	}

	/** What a new watch starts at; a source that can fail and recover tells its failure (`WatchStart`). */
	// 默认实现无失败概念：直接返回当前值。可失败子类（derive、原生跟随源）覆写。
	// 示例：const start = source.start();（默认返回 { kind: "value", value: source.value }）
	start(): WatchStart {
		return { kind: "value", value: this.value };
	}

	/** Feeds `subscriber` every frame from now on, inside each batch; the caller took the current value first. */
	// 注册订阅者；调用方负责先取当前值，避免订阅后重复/遗漏。不发送历史帧。
	// 示例：const w = source.openWatch(ctx); source.subscribe(linkSubscriber); 之后只收新帧。
	subscribe(subscriber: Subscriber): void {
		this.#subscribers ??= new Set();
		this.#subscribers.add(subscriber);
	}

	// 取消订阅：集合可能从未创建，用可选链安全跳过；不存在时也无副作用。
	// 示例：source.unsubscribe(linkSubscriber); 之后再释放一次不会报错。
	unsubscribe(subscriber: Subscriber): void {
		this.#subscribers?.delete(subscriber);
	}

	/** Delivers this batch's frame to its watches; called once per batch that listed it with `changed`. */
	// 抽象投递：子类决定帧内容（值 + ops + retired 或失败），再调用 publish/forward。
	// 示例：Batch 对本批 changed() 登记过的每个 source 调用 deliver(context)。
	abstract deliver(context: Context): void;

	/** Records a change in the current batch: listed for a frame when watched, and every dependent marked dirty. */
	// 受保护的变更登记：只有被观察时才排进批次帧（无人 watch 就不产生帧），
	// 但依赖者无论是否被 watch 都要标脏，因为 derive 可能正被读取。
	protected changed(): void {
		if (this.watched) this.batch.changed(this);
		for (const derive of this.dependents) derive.invalidate();
	}

	/**
	 * Records a retirement of this source's document in the current batch: every derive reading it, directly or
	 * through other derives, carries the flag on in its frame (rule 21). Called after `changed`.
	 */
	// 文档退役传播：先建 visited 集合（只在罕见的退役路径分配），再让每个依赖者递归转发。
	// 必须在 changed() 之后调用，保证依赖者先被标脏，再记录 retired。
	protected retiredInBatch(): void {
		// Allocated only for a retirement, which is rare.
		// 菱形依赖（同一 derive 经两条路径到达）只访问一次，避免指数级传播。
		const visited = new Set<Dependent>();
		for (const derive of this.dependents) derive.sourceRetired(visited);
	}

	/** Queues one frame on every watch and feeds it to every subscriber. */
	// 受保护的正常值投递：组装 value 帧后统一走 forward。
	// ops 是相对上一帧的 JSON Patch 风格操作；retired 表示来源文档在本批退役。
	protected publish(value: JsonValue, ops: readonly Op[], retired: boolean, context: Context): void {
		this.forward({ kind: "value", value, ops, retired }, context);
	}

	/** Queues `call` on every watch and feeds it to every subscriber, as it is (a reference's member passes one on). */
	// 原样转发一帧：先推进所有 watch（Watch 内部会排队/合并），再同步交给订阅者。
	// 复制不需要：call 由调用方创建后只读使用。
	protected forward(call: WatchCall<JsonValue>, context: Context): void {
		if (this.#watches !== undefined) for (const watch of this.#watches) watch.advance(call, context);
		if (this.#subscribers !== undefined)
			for (const subscriber of this.#subscribers) subscriber.advance(call, context);
	}

	/**
	 * Gives every watch and subscriber one failure call (design §11): the source cannot compute its value now and may
	 * recover; they stay open, and its next value is `[["r", value]]`.
	 */
	// 失败帧：所有 watch/subscriber 保持打开；handedOut 先字符串化堆栈再交给应用。
	protected failWatches(error: unknown, context: Context): void {
		this.forward({ kind: "failed", error: handedOut(error) }, context);
	}

	/**
	 * Ends every watch and subscriber for good once what they were given is delivered (a followed runtime ended after a
	 * last call, Durable's `endAfterDelivery`): `ended`; nothing follows.
	 */
	// 延迟结束：watch 先处理完已排队帧；subscriber 使用数组副本，避免它们在结束回调中修改集合。
	protected endWatchesAfterDelivery(): void {
		if (this.#watches !== undefined) for (const watch of [...this.#watches]) watch.endAfterDelivery();
		if (this.#subscribers === undefined || this.#subscribers.size === 0) return;
		// 复制后清空：endAfterDelivery 可能同步触发 unsubscribe，直接遍历会被修改。
		const subscribers = [...this.#subscribers];
		this.#subscribers.clear();
		for (const subscriber of subscribers) subscriber.endAfterDelivery();
	}

	/** Ends every watch and subscriber for good (its owner ended): `ended`; nothing follows. */
	// 立即永久结束所有观察者。watch.end 会从集合中删除自己，因此边遍历边删除是安全的。
	protected endWatches(): void {
		// Ending detaches, which deletes the current entry (safe while iterating) and runs no listener.
		if (this.#watches !== undefined) for (const watch of this.#watches) watch.end(ENDED);
		if (this.#subscribers === undefined || this.#subscribers.size === 0) return;
		// A copy: a subscriber may unsubscribe as it ends.
		const subscribers = [...this.#subscribers];
		this.#subscribers.clear();
		for (const subscriber of subscribers) subscriber.end(ENDED);
	}
}

/** A watchable that never changes (start data, §18); usable as a state member and as a derive source. */
// 工厂函数：创建常量 watchable。const 类型参数保留字面量类型（例如 "a" 而非 string），
// 但不会冻结运行时对象。断言 unknown as 是因为 Constant 实现的是 JsonValue 泛型，而调用方需要更精确的 T。
export function constant<const T extends JsonValue>(value: T): Watchable<T> {
	// The constant holds `value` as it was given.
	return new Constant(value) as unknown as Watchable<T>;
}

/** The watchable behind `constant(value)`: its watches never get a frame and end only by stop or cancellation. */
// 常量实现：不参与批次，不登记变化，没有依赖者；watch 只会因调用方 stop 或 abort 结束。
export class Constant implements Watchable<JsonValue> {
	readonly value: JsonValue;

	// 保存原引用；不做深拷贝，也不校验 JSON 形状（类型层已约束为 JsonValue）。
	// 示例：new Constant({ theme: "dark" })。运行时仍可修改该对象，但 Chord 不会再发通知。
	constructor(value: JsonValue) {
		this.value = value;
	}

	// Promise 包装，与 Source 接口一致；没有异步工作。
	// 示例：const w = await constant(0).watch(context); 句柄以 0 开始，永不收到帧。
	async watch(context: Context): Promise<Watch<JsonValue>> {
		return this.openWatch(context);
	}

	/** As `Source.openWatch`; nothing is delivered, so nothing is reported. */
	// 打开 watch：初值即常量值；停止回调与错误上报都是空函数，因为永远不会有帧。
	// 仍需注册 abort，否则调用方无法通过 signal 结束这个 watch。
	// 示例：const w = constant(0).openWatch(context); w.value === 0，且不会收到 advance。
	openWatch(context: Context): Watch<JsonValue> {
		const watch = new Watch<JsonValue>(
			this.value,
			() => {},
			() => {},
		);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		return watch;
	}
}
