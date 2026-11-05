// 文件导读（Chord v1 的可复制状态与订阅分发）
// ==========================================
// 所属包与模块：packages/chord/src/old/state.ts，Chord v1 中独立于宿主的可观察状态。
//
// 解决问题：给一份不可变 JSON 值提供一个读取入口 value、有序且串行化的订阅通知，以及两种产生新值的方式：
// 1) replicatedState(initial)：本对象是权威值，调用方用 change()/replace() 提交修改；
// 2) replicatedState(source)：本对象只是外部权威修订源（source）的发布视图，自己不修改值，只按 cursor 顺序转发。
//
// 职责边界：本文件管理本地发布顺序、订阅者的串行投递、hydrate 与 update 的顺序、慢订阅者的溢出策略、
// 监听器错误隔离，以及 source cursor 连续性检查。它不计算增量、不编码操作、不持久化；change() 的增量由
// delta 模块的 track()/prepare() 产生。它也不拥有外部 source 的提交，只消费 source 的不可变帧。
//
// 上游入口：应用从 old/index.ts 导入 replicatedState；测试通过 ReplicatedStateSource 实现假源。
// 下游依赖：../context 的 Context/BACKGROUND_CONTEXT；../delta 的 Draft/Op/Prepared/Tracker/track。
// 结果与错误流向：change() 的同步回调错误原样抛给调用方；订阅回调错误交给 onError（默认异步抛出）；
// source 违约（cursor 非安全整数或跳号）会 dispose 附件并报告错误，但不会抛进 source 的 commit 调用。
//
// 能力清单（导出项）：
// - ReplicatedStateDelivery：一条投递的 kind（hydrate/update）与 sequence。
// - ReplicatedState<T>：value + subscribe 的只读接口。
// - MutableReplicatedState<T>：在只读接口上增加 value、change(context, mutate)、replace(context, value)。
// - ReplicatedStateSourceFrame<T>：source 提交的一帧（cursor/value/ops/context）。
// - ReplicatedStateSourceAttachment<T>：attach 得到的快照与 activate/dispose。
// - ReplicatedStateSource<T>：外部权威修订源的 attach() 接口。
// - ReplicatedStateSourceOptions：onError 回调。
// - AttachedReplicatedState<T>：附加模式的状态接口，额外有 dispose()。
// - replicatedState()：两个重载，按传入对象是否有 attach() 分派到可变实现或附加实现。
// 文件内实现（未导出）：StateSubscriber、ReplicatedStatePublisher、MutableReplicatedStateImpl、
// AttachedReplicatedStateImpl、attachReplicatedStateSource、assertCursor、isPromiseLike、reportErrorAsync、toError。
//
// 组合关系与典型顺序：
//   可变模式：track(initial) -> beginChange -> 修改 Draft -> prepare -> adopt -> publisher.publish
//   附加模式：source.attach()（快照 + 缓冲）-> 构造 publisher -> activate 排空缓冲帧 -> 每帧检查 cursor 后 publish
//   订阅：publisher.subscribe -> 先投递 hydrate(当前值, 当前 sequence) -> 之后只投递更新的 update
//
// 例子（示例；真实签名见下方重载）：
//   const state = replicatedState({ count: 0 });
//   const off = state.subscribe((value, context, delivery) => {
//     console.log(delivery.kind, value.count); // 第一次是 "hydrate"，之后是 "update"
//   });
//   state.change(BACKGROUND_CONTEXT, (draft) => { draft.count += 1; });
//   state.replace(BACKGROUND_CONTEXT, { count: 10 });
//   off();
//
// 建议阅读顺序：先看 ReplicatedState/MutableReplicatedState/Source 三组接口；再读 StateSubscriber 的队列与
// 串行投递；接着读 ReplicatedStatePublisher 如何保证 hydrate 在 update 之前；然后读两个 Impl 的写入/附加流程；
// 最后看 replicatedState 的重载与 source 判别。
/**
 * Replicated state: an immutable JSON value with ordered, serialized change notifications. Either authoritative and
 * mutable (`replicatedState(initial)`) or a publication-only view of an external revision source
 * (`replicatedState(source)`).
 */
import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import { type Draft, type Op, type Prepared, type Tracker, track } from "../delta/index.ts";

// 一条投递的元数据。kind 区分首次水合与后续更新；sequence 是本状态发布器内部递增的序号，
// 不是外部 source 的 cursor（附加模式会在下一层把 cursor 转成自己的发布序号）。
export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

// 只读的可观察状态。
export interface ReplicatedState<T> {
	/**
	 * Contract-immutable value, or undefined until hydration. It is not frozen and may share containers with an
	 * in-process provider; consumers must not mutate it. Later updates do not mutate previously returned values.
	 */
	// 当前值：按约定不可变，但运行时没有 Object.freeze，也没有深拷贝；可能和进程内提供方共享未修改的容器。
	// 后续更新返回新值，不会原地修改这里已经交出去的值。消费方必须自己遵守不修改约定。
	readonly value: T | undefined;
	/**
	 * Each subscription serializes callbacks, awaiting hydration before updates. Values are immutable and may
	 * share unchanged revision data. At most 100 deliveries wait behind the running callback; overflow keeps
	 * only the newest pending value/context/delivery, so update sequences may skip. Failures are reported in
	 * isolation and delivery continues. Unsubscribe discards pending work without aborting or joining a callback.
	 */
	// 订阅有两个类型重载：一个接收返回 Promise<void> 的监听器，一个接收返回 void 的监听器，方便调用方通过类型检查。
	// 运行时按监听器的实际返回值判断：返回 thenable 就等它完成再投递下一条，否则立即继续。
	// 返回的函数取消订阅，丢弃尚未投递的帧，但不会中断或等待正在执行的回调。
	// 每个订阅最多积压 100 条；溢出时保留最新一条（以及尚未投递的首次 hydrate），因此 update 序号可能跳跃。
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => Promise<void>): () => void;
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void;
}

// 权威且可写的可复制状态；T 必须是对象，因为 delta tracker 只接管对象根。
export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	// 可变模式始终有值，不需要处理 undefined。
	readonly value: T;
	/**
	 * Atomically publish one synchronous overlay mutation. Draft handles are unusable after the callback returns.
	 * Values placed through the draft are cloned by value; assigning `undefined` to an object property deletes it.
	 */
	// 在一个同步回调里修改草稿，然后原子提交并通知订阅者。
	// 回调返回后草稿失效；通过草稿放入的新值按值克隆（外部后续修改不会影响状态）；
	// 给对象属性赋 undefined 等价于删除该属性，而不是写入 undefined。
	// 回调抛错会整体回滚；回调返回 Promise 会同步抛 TypeError（见 MutableReplicatedStateImpl.change）。
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
	/**
	 * Atomically take immutable ownership of an alias-free strict-JSON replacement.
	 * The caller must not mutate the transferred root after this call.
	 */
	// 用一份“没有别名、严格 JSON”的值整体替换，并接管其不可变所有权；调用后调用方不得再修改传入的根。
	// 与 change 不同，这里不经过草稿回调，直接走 tracker.prepareReplace（内部会深比较识别无变化）。
	replace(context: Context, value: T): void;
}

/** One immutable authoritative revision committed after an attachment snapshot. */
// source 在某个快照之后提交的一帧。
// cursor 由 source 维护、单调递增；snapshot.cursor + 1 必须是激活后第一帧的 cursor，用于发现丢帧。
// value 是提交后的精确不可变值；ops 是产生该值的精确操作批次。Chord 只转发这些引用，不会重新应用 ops。
export interface ReplicatedStateSourceFrame<T> {
	/** Monotonic source cursor. The first frame after a snapshot must be `snapshot.cursor + 1`. */
	readonly cursor: number;
	/** The exact immutable value produced by this commit. */
	readonly value: T;
	/** The exact immutable operation batch that produced `value` from the preceding source revision. */
	readonly ops: readonly Op[];
	// 该提交发生时携带的 Context；会原样出现在订阅回调里。
	readonly context: Context;
}

// attach() 返回的附件：固定快照 + 激活/释放操作。
export interface ReplicatedStateSourceAttachment<T> {
	/** Fixed immutable snapshot captured at the atomic attachment boundary. */
	// 在原子附着边界捕获的快照；value 与 cursor 必须来自同一时刻，不能一个早于另一个。
	readonly snapshot: { readonly value: T; readonly cursor: number };
	/**
	 * Install the sole listener and synchronously drain every buffered frame in source commit order.
	 * This method is single-use. After it begins, every new committed frame must also be delivered in order
	 * until disposal, including commits made reentrantly while a prior frame is being delivered.
	 */
	// 安装唯一监听器，并同步排空 attach 之后缓冲的所有帧，顺序与 source 提交顺序一致。
	// 只能调用一次；开始后直到 dispose，每个新提交都必须按序投递，包括在投递上一帧期间重入产生的提交。
	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
	/** Stop delivery and release source resources. Disposal must be idempotent. */
	// 停止投递并释放 source 资源；必须可重复调用（实现方负责幂等）。
	dispose(): void;
}

/**
 * An authoritative immutable revision source.
 *
 * `attach()` must synchronously and atomically capture one snapshot and register the returned attachment to buffer
 * every later committed frame. The snapshot must include every commit before that boundary; buffered frames must
 * include every commit after it, with no overlap or gap. Snapshot values, frame values, and operation batches are
 * immutable and remain valid after delivery. Chord only publishes these references; it never applies or re-diffs them.
 */
// 外部权威不可变修订源。
// attach() 必须同步、原子地捕获一个快照，并登记附件以缓冲此后的每一帧；快照覆盖边界前的所有提交，
// 缓冲帧覆盖边界后的所有提交，两者不能重叠也不能有缺口。
// 快照/帧值/ops 都按不可变处理，投递后仍然有效。Chord 只发布这些引用，不应用 ops，也不重新做 diff。
export interface ReplicatedStateSource<T> {
	attach(): ReplicatedStateSourceAttachment<T>;
}

// 附加模式的错误回调：接收 source 契约违约和发布监听器失败，避免把错误抛进 source 的 commit 路径。
export interface ReplicatedStateSourceOptions {
	/** Receives source-contract and publication-listener failures without throwing them into the source. */
	readonly onError?: (error: Error) => void;
}

/** A synchronously hydrated publication-only state backed by one source attachment. */
// 附加模式的状态：构造时同步水合快照，之后只发布 source 帧；value 始终有值。
export interface AttachedReplicatedState<T> extends ReplicatedState<T> {
	readonly value: T;
	/** Idempotently release the source attachment. The last published value remains readable. */
	// 幂等释放附件；释放后最后发布的值仍可读取，但不再接收新帧。
	dispose(): void;
}

/** The void signature also accepts synchronous callbacks that return an ignored value. */
// 内部监听器类型声明为返回 void；TypeScript 允许返回任意值的同步函数赋给 void 返回类型，
// subscribe 的 Promise 重载只服务类型检查；真正的异步等待由运行时的 isPromiseLike 判断处理。
type StateListener<T> = (value: T, context: Context, delivery: ReplicatedStateDelivery) => void;

// 队列中保存的一条完整投递：值、上下文、投递元数据。
// 三个字段都是 readonly，但只约束通过该类型的赋值；底层值本身仍按不可变约定共享。
type StateDelivery<T> = {
	readonly value: T;
	readonly context: Context;
	readonly delivery: ReplicatedStateDelivery;
};

/** One public subscription, independent of producer and other subscriber progress. */
// 一个公开订阅的私有投递队列：每个订阅各自串行，慢订阅者不会阻塞其他订阅者。
// 类字段用 # 声明为真正的运行时私有字段，外部代码无法读写，也不会出现在 JSON 中。
class StateSubscriber<T> {
	// 用户提供的监听器；同步或异步（返回 PromiseLike）都可以。
	readonly #listener: StateListener<T>;
	// 报告监听器错误的函数；由发布器注入，最终指向 onError 或异步抛出。
	readonly #reportError: (error: Error) => void;
	// 等待投递的帧，先进先出；运行中的那条不在这个数组里。
	readonly #pending: StateDelivery<T>[] = [];
	// 是否正在执行监听器（或正在等待它返回的 Promise）。
	#running = false;
	// 是否已经投递过至少一条；用于在溢出时判断队列首条是否是尚未开始的 hydrate。
	#started = false;
	#closed = false;

	constructor(listener: StateListener<T>, reportError: (error: Error) => void) {
		this.#listener = listener;
		this.#reportError = reportError;
	}

	// 把一帧放入等待队列；关闭后直接丢弃。
	push(frame: StateDelivery<T>): void {
		if (this.#closed) return;
		// 积压达到上限 100 条：丢弃旧的 update，只可能保留首次 hydrate。
		if (this.#pending.length === 100) {
			// A cold replica can queue updates reentrantly before this subscriber's first hydration starts.
			// 冷副本可能在首次 hydrate 开始前同步重入地排入多条 update；首条 hydrate 必须保留，否则订阅者永远拿不到基线。
			const hydration = this.#started ? undefined : this.#pending[0];
			// 直接改 length 清空数组，避免重新分配；这是有意的批量丢弃。
			this.#pending.length = 0;
			// 只有确实存在未开始的 hydrate 才放回；started 为 true 时 hydration 为 undefined。
			if (hydration !== undefined) this.#pending.push(hydration);
		}
		// 新帧总是保留，因此溢出时后续 update 序号可能跳跃，但订阅者拿到的是最新值。
		this.#pending.push(frame);
	}

	// 串行排空队列：同步监听器连续执行；异步监听器返回 Promise 时暂停，完成后再继续。
	drain(): void {
		// 已在执行或已关闭时不重入；保证同一订阅同一时刻只有一条投递在运行。
		if (this.#running || this.#closed) return;
		this.#running = true;
		// shift 从队首取帧，直到队列为空（取到 undefined）。for 的初始化/更新/条件三段都围绕这个队列。
		for (let frame = this.#pending.shift(); frame !== undefined; frame = this.#pending.shift()) {
			this.#started = true;
			try {
				// 监听器的返回类型声明为 void，但异步函数实际会返回 Promise；先用 unknown 接住再运行时判断。
				const result: unknown = this.#listener(frame.value, frame.context, frame.delivery);
				if (isPromiseLike(result)) {
					// Promise.resolve 把任意 thenable 归一成原生 Promise；void 表示不等待这个包装 Promise，
					// 真正的继续由 then 回调触发。成功和失败都要 resume，避免一次失败卡死后续投递。
					void Promise.resolve(result).then(
						() => this.#resume(),
						(error: unknown) => {
							// 异步失败同样只报告，不中断订阅。
							this.#report(error);
							this.#resume();
						},
					);
					// 关键：异步等待期间保持 #running=true，直接返回，不继续 shift 下一帧。
					return;
				}
			} catch (error) {
				// 同步监听器抛错：报告后继续消费后续帧；错误隔离在单个订阅、单条投递内。
				this.#report(error);
			}
		}
		// 队列排空且没有异步监听器在等待。
		this.#running = false;
	}

	// 丢弃所有尚未投递的帧；不清 #started（已经投递过的事实不变）。
	clear(): void {
		this.#pending.length = 0;
	}

	// 关闭订阅：之后 push 不再入队，drain 也不再执行；已经在运行的监听器不会被中断或等待。
	close(): void {
		this.#closed = true;
		this.clear();
	}

	// 异步监听器完成（成功或失败）后恢复运行状态，并继续排空。
	#resume(): void {
		this.#running = false;
		this.drain();
	}

	// 把监听器异常转成 Error 后交给上报函数；上报函数自己抛错时，用微任务异步抛出，避免吞掉。
	#report(error: unknown): void {
		try {
			this.#reportError(toError(error));
		} catch (reportError) {
			reportErrorAsync(toError(reportError));
		}
	}
}

// 待投递的发布项：值与上下文 + 发布时分配的本地序号。
type Publication<T> = {
	readonly value: T;
	readonly sequence: number;
	readonly context: Context;
};

/** Maintains local publication order independently of how revisions are produced. */
// 发布器维护本状态实例的本地发布顺序，不关心值来自 change、replace 还是附加 source。
// 它把所有订阅者与发布队列集中在一个位置，保证 hydrate 先于 update、并且重入发布也不会打乱顺序。
class ReplicatedStatePublisher<T> {
	// Map 的值是该订阅者水合时的 sequence；投递时用它跳过已包含在 hydrate 里的旧发布。
	readonly #listeners = new Map<StateSubscriber<T>, number>();
	readonly #reportError: (error: Error) => void;
	// 重入 publish 时暂存待投递项；非重入时边 shift 边投递。
	readonly #publications: Publication<T>[] = [];
	#value: T;
	// 本地发布序号从 0 开始，每次 publish 加一；hydrate 使用订阅时的当前值。
	#sequence = 0;
	// 防止监听器内同步调用 change/replace 导致嵌套投递循环。
	#delivering = false;

	// initial 必须是已经持有所有权的不可变值；reportError 默认异步抛出，便于独立使用时暴露错误。
	constructor(initial: T, reportError: (error: Error) => void = reportErrorAsync) {
		this.#value = initial;
		this.#reportError = reportError;
	}

	// 当前最新值；只需读取，不需要加锁，因为 JS 单线程且发布是同步完成的。
	get value(): T {
		return this.#value;
	}

	// 原子读取当前值与序号，供 subscribe 在同一时刻取到一致的基线。
	// 返回对象是新建的，避免调用方修改内部状态。
	snapshot(): { readonly value: T; readonly sequence: number } {
		return { value: this.#value, sequence: this.#sequence };
	}

	// 注册订阅：立即投递一条 hydrate，再按顺序投递之后的 update。返回取消函数。
	subscribe(listener: StateListener<T>): () => void {
		// 先取一致的 (value, sequence)，再创建订阅者；此后发布器分配的序号一定大于这个基线。
		const { value, sequence } = this.snapshot();
		const subscriber = new StateSubscriber(listener, this.#reportError);
		this.#listeners.set(subscriber, sequence);
		// Hydration has no caller; it is delivered with the background context.
		// hydrate 不是由某次应用调用触发，所以使用后台上下文；kind 让监听器区分首次基线与后续更新。
		subscriber.push({ value, context: BACKGROUND_CONTEXT, delivery: { kind: "hydrate", sequence } });
		// 立即开始排空：同步监听器会在 subscribe 返回前收到 hydrate；异步监听器则稍后完成。
		subscriber.drain();
		return () => {
			// 先关闭（丢弃未投递帧、阻止后续 push），再从 Map 删除，避免取消后仍被投递。
			subscriber.close();
			this.#listeners.delete(subscriber);
		};
	}

	/** Publish an already-prepared immutable revision. Subscriber failures are reported, never thrown. */
	// 发布一份已经准备好的不可变修订。
	// 输入：新值、触发本次修订的 Context。输出/副作用：更新 value/sequence，排队并同步投递给所有订阅者。
	// 错误：监听器失败由各自订阅者捕获并上报，不向 publish 调用方抛出。
	// 重入规则：如果当前正在投递（监听器里又调用了 change），只入队并立即返回；外层循环会在处理完当前发布后取到它。
	publish(value: T, context: Context): void {
		this.#value = value;
		this.#sequence += 1;
		// sequence 在入队时确定，保证重入期间的发布顺序与调用顺序一致。
		this.#publications.push({ value, sequence: this.#sequence, context });
		if (this.#delivering) return;

		this.#delivering = true;
		// try/finally 保证即使 push/drain 抛出意外错误，delivering 也会复位，后续发布不会永久卡住。
		try {
			// 与 drain 相同的队列循环：shift 直到空；重入新增的项也会被这个循环消费。
			for (
				let publication = this.#publications.shift();
				publication !== undefined;
				publication = this.#publications.shift()
			) {
				// as const 把 kind 收窄为字面量 "update"，满足 ReplicatedStateDelivery 的联合类型。
				const delivery = { kind: "update", sequence: publication.sequence } as const;
				// 复制监听器数组：投递过程中可能有订阅取消；复制后仍会遍历到它们，
				// 但 subscriber.close 会让 push/drain 变成空操作。
				for (const [subscriber, hydratedSequence] of [...this.#listeners]) {
					// 订阅时已经通过 hydrate 拿到序号 <= hydratedSequence 的值，跳过这些旧发布，避免重复或倒序。
					if (publication.sequence <= hydratedSequence) continue;
					// push 可能因溢出丢弃旧帧；drain 负责串行执行，不会在这里等待异步监听器。
					subscriber.push({ value: publication.value, context: publication.context, delivery });
					subscriber.drain();
				}
			}
		} finally {
			this.#delivering = false;
		}
	}
}

// 权威可写模式：tracker 持有当前不可变值，publisher 负责把提交后的值分发给订阅者。
class MutableReplicatedStateImpl<T extends object> implements MutableReplicatedState<T> {
	// delta 的事务跟踪器；本文件只使用 beginChange/prepareReplace/adopt。
	readonly #tracker: Tracker<T>;
	readonly #publisher: ReplicatedStatePublisher<T>;
	// 是否正在执行 change 回调；用于拒绝嵌套 change/replace，保护事务状态。
	#changing = false;

	// track 是 O(1) 所有权接管，不复制、不遍历，因此 initial 必须是 alias-free 的严格 JSON；
	// 调用方在构造后不得再修改它。
	constructor(initial: T) {
		this.#tracker = track(initial);
		this.#publisher = new ReplicatedStatePublisher(this.#tracker.value);
	}

	// 直接读 tracker 当前值；ref 只在成功 adopt 后更新。
	get value(): T {
		return this.#tracker.value;
	}

	// Parameters<MutableReplicatedState<T>["change"]>[1] 是类型工具组合：
	// 先索引访问接口的 change 方法类型，再用 Parameters 取参数元组，最后 [1] 取第二个参数（mutate）的类型。
	// 这样避免在这里重复书写 Draft<T> 的签名。
	change(context: Context, mutate: Parameters<MutableReplicatedState<T>["change"]>[1]): void {
		// 在 change 回调里再次 change 会破坏 tracker 的事务所有权，直接拒绝。
		if (this.#changing) throw new Error("Replicated state cannot be changed reentrantly from a change callback");
		this.#changing = true;
		// prepared 在 try 内赋值；若中途抛错，控制流不会走到后面的 adopt。
		let prepared: Prepared<T>;
		try {
			// beginChange 创建草稿视图；同一 tracker 同时只允许一个 open 草稿最终成功。
			const change = this.#tracker.beginChange();
			try {
				// 把草稿交给用户回调。声明返回 void，但 JS 可能返回 Promise；先用 unknown 接住再判断。
				const outcome = (mutate as (draft: typeof change.state) => unknown)(change.state);
				if (isPromiseLike(outcome)) {
					// 异步回调不能安全提交：先挂一个 catch 吞掉它未来的拒绝，避免 unhandled rejection；
					// 再抛 TypeError 进入下面的 abort 路径。回调中已发生的同步修改会被整体放弃。
					void Promise.resolve(outcome).catch(() => undefined);
					throw new TypeError("Replicated state change callbacks must be synchronous");
				}
				// prepare 物化草稿：生成新值和操作批次，并让草稿变为只读。
				prepared = change.prepare();
			} catch (error) {
				// 用户回调或 prepare 失败：放弃草稿并原样抛出。
				change.abort();
				throw error;
			}
		} finally {
			// 无论成功失败都退出“修改中”，但此时还没 adopt。
			this.#changing = false;
		}

		// 提交：O(1) 指针交换，revision 加一，竞争草稿变为 stale。
		this.#tracker.adopt(prepared);
		// 只有真正产生操作时才通知；无变化的 change 不应制造一次 update。
		// 订阅者在 publish 中同步回调时可以再次 change：此时 #changing 已复位，因此允许按序排队。
		if (prepared.ops.length > 0) this.#publisher.publish(prepared.value, context);
	}

	// 整体替换：不经过草稿回调，因此不需要设置 #changing；prepareReplace 会深比较以识别无变化。
	replace(context: Context, value: T): void {
		// 仍拒绝在 change 回调中调用，避免在同一事务未提交时替换根。
		if (this.#changing) throw new Error("Replicated state cannot be replaced from a change callback");
		const prepared = this.#tracker.prepareReplace(value);
		this.#tracker.adopt(prepared);
		// 深比较后没有操作说明值相同，不发通知。
		if (prepared.ops.length > 0) this.#publisher.publish(prepared.value, context);
	}

	// 订阅转交给发布器；取消函数由发布器返回。
	subscribe(listener: StateListener<T>): () => void {
		return this.#publisher.subscribe(listener);
	}
}

// 附加模式：只发布外部 source 的帧，不接受 change/replace。
class AttachedReplicatedStateImpl<T> implements AttachedReplicatedState<T> {
	readonly #publisher: ReplicatedStatePublisher<T>;
	readonly #attachment: ReplicatedStateSourceAttachment<T>;
	readonly #reportError: (error: Error) => void;
	// 下一帧必须等于 #cursor + 1；初始值是快照 cursor。
	#cursor: number;
	// 一旦释放或契约违约就置 true，后续帧和重复 dispose 都被忽略。
	#disposed = false;

	// 构造时快照已经由 source.attach() 捕获；这里只校验 cursor 并建立发布器，还未开始接收帧。
	constructor(attachment: ReplicatedStateSourceAttachment<T>, options: ReplicatedStateSourceOptions) {
		const { snapshot } = attachment;
		// cursor 来自外部 source 实现，是信任边界；必须是安全整数，否则无法可靠地做 +1 连续性比较。
		assertCursor(snapshot.cursor, "snapshot");
		this.#attachment = attachment;
		this.#cursor = snapshot.cursor;
		// onError 缺省时用异步抛出：不把错误抛回 source，但也不静默吞掉。
		this.#reportError = options.onError ?? reportErrorAsync;
		// 发布器的错误回调经过本类 #report，这样订阅监听器失败也走同一个 onError。
		this.#publisher = new ReplicatedStatePublisher(snapshot.value, (error) => this.#report(error));
	}

	// 快照值在构造后立即可读，因此覆盖了基类的 T | undefined。
	get value(): T {
		return this.#publisher.value;
	}

	// 订阅由发布器处理；hydrate 使用快照值。
	subscribe(listener: StateListener<T>): () => void {
		return this.#publisher.subscribe(listener);
	}

	// 安装 source 监听器并排空缓冲帧。source 规定 activate 只能调用一次，因此只由工厂在构造后调用。
	activate(): void {
		this.#attachment.activate((frame) => this.#receive(frame));
	}

	// 幂等释放：第一次调用标记并释放附件；后续调用直接返回。
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#attachment.dispose();
	}

	// source 每提交一帧就同步调用这里（或由 activate 排空时调用）。
	#receive(frame: ReplicatedStateSourceFrame<T>): void {
		if (this.#disposed) return;
		try {
			// 双重校验：cursor 类型 + 与上一帧的连续性；跳号说明 source 违约或丢帧。
			assertCursor(frame.cursor, "frame");
			const expected = this.#cursor + 1;
			if (frame.cursor !== expected) {
				throw new Error(`Replicated state source cursor has a gap: expected ${expected}, received ${frame.cursor}`);
			}
			// 先推进 cursor 再发布；publish 是同步的，订阅者回调抛错已被发布器隔离，不会在这里造成半状态。
			this.#cursor = frame.cursor;
			this.#publisher.publish(frame.value, frame.context);
		} catch (error) {
			// 契约违约不能抛回 source；释放附件并报告错误。
			this.#fail(toError(error));
		}
	}

	// 处理 source 契约失败：先标记 disposed，尽力释放附件；释放也失败时把两个错误一起报告。
	#fail(error: Error): void {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			this.#attachment.dispose();
		} catch (disposeError) {
			// AggregateError 保留两个错误；message 说明是 source 契约失败。
			this.#report(new AggregateError([error, disposeError], "Replicated state source contract failed"));
			return;
		}
		this.#report(error);
	}

	// 与 StateSubscriber 相同的上报策略：上报函数自己抛错时改为异步抛出。
	#report(error: unknown): void {
		try {
			this.#reportError(toError(error));
		} catch (reportError) {
			reportErrorAsync(toError(reportError));
		}
	}
}

/** Attach a publication-only replicated state to one authoritative immutable source stream. */
// 把发布视图附着到一个权威不可变 source 上。
// 输入：source 与可选 options。输出：已同步水合的 AttachedReplicatedState。
// 错误：source.attach()/activate()/构造校验抛错时，先 dispose 附件再抛出；dispose 也失败则抛 AggregateError。
// 流程：attach 捕获快照 -> 构造实现（校验 cursor）-> activate 排空缓冲 -> 返回。
// 示例：
//   const state = attachReplicatedStateSource(source, { onError: (e) => console.error(e) });
//   console.log(state.value); // 构造返回时已经是快照值
function attachReplicatedStateSource<T>(
	source: ReplicatedStateSource<T>,
	options: ReplicatedStateSourceOptions = {},
): AttachedReplicatedState<T> {
	// attach 必须同步、原子地返回快照与缓冲附件；它自身抛错时直接向外传播，没有附件需要清理。
	const attachment = source.attach();
	try {
		const state = new AttachedReplicatedStateImpl(attachment, options);
		// activate 会安装监听器并同步排空 attach 之后、activate 之前缓冲的帧。
		state.activate();
		return state;
	} catch (error) {
		// 构造或激活失败：必须释放 source 资源，避免泄漏监听器/缓冲区。
		try {
			attachment.dispose();
		} catch (disposeError) {
			// 原始错误和清理错误都保留，使用 AggregateError 一起抛出。
			throw new AggregateError([error, disposeError], "Failed to attach replicated state source");
		}
		throw error;
	}
}

// 校验 source 提供的 cursor 是安全整数（Number.isSafeInteger 排除 NaN、小数和超出 ±2^53-1 的值）。
// kind 只影响错误文字。source 是外部实现，这是明确的运行时信任边界。
function assertCursor(cursor: number, kind: "snapshot" | "frame"): void {
	if (!Number.isSafeInteger(cursor))
		throw new TypeError(`Replicated state source ${kind} cursor must be a safe integer`);
}

// 判断一个值是否 thenable。为什么需要运行时检查：监听器/change 回调的类型声明是 void，
// 但 JS 调用方或 async 函数可以返回 Promise；TypeScript 无法在运行时阻止，只能在这里识别。
// 类型谓词 value is PromiseLike<unknown> 让 true 分支内可以安全地当作 thenable 使用。
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		// 先要求是对象（非 null）或函数，因为原始值不可能有 then。
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		// 再检查 then 是函数；这是 PromiseLike 的结构定义，不依赖具体 Promise 实现。
		typeof (value as { then?: unknown }).then === "function"
	);
}

// 默认错误上报：在微任务里抛出，形成未捕获异常，让运行时/日志能看到，而不是把错误静默吞掉。
// 选择异步是为了不打断当前投递循环，也不把错误抛回 source 的 commit 调用。
function reportErrorAsync(error: Error): void {
	queueMicrotask(() => {
		throw error;
	});
}

// 把 unknown 异常归一为 Error：已经是 Error 的原样保留（包括子类和身份），其它值转成字符串消息。
// unknown 是 catch 变量的安全类型，使用前必须收窄或包装。
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

// 创建可复制状态。两个重载根据参数区分模式：
// - 传入 ReplicatedStateSource：返回附加视图（同步水合快照，只发布 source 帧）；
// - 传入普通对象：返回权威可写状态（接管所有权，可 change/replace）。
// 实现签名用联合返回类型；调用方由重载获得精确类型。
// 注意：可变模式的 initial 必须是 alias-free 严格 JSON，调用后调用方不得再修改它。
export function replicatedState<T>(
	source: ReplicatedStateSource<T>,
	options?: ReplicatedStateSourceOptions,
): AttachedReplicatedState<T>;
/**
 * Create authoritative state by taking immutable ownership of an alias-free strict-JSON root.
 * The caller must not mutate `initial` after this call.
 */
export function replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
export function replicatedState(
	initialOrSource: object | ReplicatedStateSource<unknown>,
	options?: ReplicatedStateSourceOptions,
): MutableReplicatedState<object> | AttachedReplicatedState<unknown> {
	// 先判断是否是 source；source 实现通常带有 attach 函数，而严格 JSON 根不可能包含函数，不会误判。
	if (isReplicatedStateSource(initialOrSource)) return attachReplicatedStateSource(initialOrSource, options);
	// 可变模式：initialOrSource 在这里被收窄为 object；options 对可变模式无意义，重载也禁止传入。
	return new MutableReplicatedStateImpl(initialOrSource);
}

// 运行时判别 source：只看 attach 是否为函数，不验证 attach 的返回值或行为。
// 类型谓词让 false 分支收窄为普通 object；attach 的行为契约由 source 接口和后续 attach 调用保证。
function isReplicatedStateSource(value: object): value is ReplicatedStateSource<unknown> {
	return typeof (value as { readonly attach?: unknown }).attach === "function";
}
