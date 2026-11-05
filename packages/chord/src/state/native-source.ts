// Native sources (W4, slice 8 §2): in-process values that change, compared by identity (a `writable`, a registry's
// composed value, `ref.state`). Derives and registry tables depend on them and the batch marks them; the followed
// ones (writables, registry values) give their watches and observers one call per batch that changed them.

// 文件导读
// 所属包与模块：packages/chord/src/state 的原生来源模块（W4，slice 8 §2），属于 Chord 状态层。
// 职责边界：保存进程内任意类型的可变值并按身份比较，向 derive/registry 提供只读输入，向 watch/observer 提供
// 每批一次的调用；不要求 JSON，也不生成 diff。上游：writable.ts、registries/value.ts、ref.state 继承；
// 上游变更通过 changed() 进入批次。下游：derive 读取 value/current，watch 收到 value/failed 调用，
// observer 在批次内同步记录。
// 错误流向：失败不抛出到发布路径，而是作为 failed 调用发给已有值的跟随者；无值的跟随者继续等待首值。
// 结束（end）会让所有 watch/observer 收到 ended 并释放批次引用。
// 能力清单：
// - NativeObserver/NativeObservation（类型）：同步观察者接口与 observe 的返回值。
// - NativeStart（联合类型）：原生 watch 的起点，失败时带可选最后好值。
// - NativeSource（抽象类）：最小骨架，提供 dependents、value/watch 抽象、start/current、batch getter、
//   changed/end。
// - FollowedSource（抽象类）：完整实现，维护 watch、observer、shown 状态、listed 标记与投递逻辑。
// 组合关系与典型调用顺序：子类改值后调用 changed() -> list() 排进批次 -> Batch 调 deliver -> #deliver 读取
// start() -> 给 watch.advance/fail 与 observer.advance；无跟随者时 #settleFollowers 丢弃 shown。
// 示例（真实签名）：class Count extends FollowedSource<number> { get value() { return 0; } }
// const obs = source.observe({ advance(call) { records.push(call); }, end() {} }, context);
// 建议阅读顺序：先读 NativeObserver/NativeObservation/NativeStart，再看 NativeSource 的依赖与批次生命周期，
// 然后 FollowedSource 字段与 watched/openWatch/observe，接着 changed/list/deliver，最后 #deliver 与结束清理。

import type { Context } from "../context/index.ts";
import {
	NativeWatch,
	type NativeWatchable,
	type NativeWatchCall,
	type NativeWatchHandle,
	type WatchEnd,
} from "../watch.ts";
import type { Batch } from "./batch.ts";
import { type Dependent, handedOut } from "./watchable.ts";

/**
 * A synchronous observer of a native source (Durable's observer shape): `advance` is called inside the batch that
 * changed the source, so it only records; `end` once, when the source ended (`ended`) or the observer's context was
 * aborted (`aborted`).
 */
// 观察者接口：advance 在批次内同步调用，因此实现只能记录/转发，不能做重活或抛错；
// end 只会调用一次，结束原因可能是 source 结束（ended）或观察上下文中止（aborted）。
// T 是值类型，编译期约束，运行时不做形状检查。
export interface NativeObserver<T> {
	/** The source's call of this batch: its new value, or a failure it may recover from. */
	// NativeWatchCall<T> 是原生值的调用联合：{kind:"value",value} 或 {kind:"failed",error}。
	// 示例：advance(call) { if (call.kind === "value") records.push(call.value); } 内只做同步记录。
	advance(call: NativeWatchCall<T>, context: Context): void;
	/** The observer is detached for good with `end`. */
	// 示例：end(end) { console.log(end.kind); } 只会被调用一次。
	end(end: WatchEnd): void;
}

/** What `observe` gives: the value the observer starts at, and how to detach it (Durable's `Observation`). */
// observe 的同步返回值：初始值 + detach 函数。没有 Promise，因为注册必须在当前同步段内完成。
export type NativeObservation<T> = { readonly value: T; detach(): void };

/**
 * What a new watch of a native source starts at: its value, or while it is failed, the failure and its last good value
 * (`last` undefined when it never had one: a watch cannot start then).
 */
// 原生 watch 的启动点：失败时 last 用 {value} 包装而不是直接 T，
// 这样即使 T 本身可以是 undefined 也能区分“没有最后好值”。
export type NativeStart<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: { readonly value: T } | undefined };

/**
 * A native source as derives and registry tables read it: its value (`start()` while it may fail), the dependents a
 * change marks (`changed()`, inside a batch), and the host's batch until it ended. How its watches get their calls is
 * the subclass's (`FollowedSource` for writables and registry values; `ref.state` gives each state to its watches).
 */
// 抽象基类：默认 T = unknown，便于不同子类以具体类型覆盖。
// #batch 可为 undefined：已结束的 source（例如 released reference 的 state）保留值但没有 host 批次。
export abstract class NativeSource<T = unknown> implements NativeWatchable<T> {
	/** Derives and registry tables reading this source; each removes itself when it stops. */
	// 依赖者集合：变化时只标脏，不直接计算。
	readonly dependents = new Set<Dependent>();
	/** The host's batch; dropped when the source ended, so an ended source keeps no host. */
	// 私有批次引用：置 undefined 是打破“已结束 source -> host”的强引用，帮助 GC。
	#batch: Batch | undefined;

	/** `batch` undefined: made ended (a released reference's state). */
	// 构造：undefined 表示从诞生起就是结束态；否则保存 host 批次。
	constructor(batch: Batch | undefined) {
		this.#batch = batch;
	}

	// 抽象读取：子类决定值；失败态下仍可能返回最后好值（见 current 的说明）。
	// 示例：const n = writable.value; 读取同步且无副作用。
	abstract get value(): T;

	// 抽象 watch：返回 Promise，具体帧投递由子类实现。
	// 示例：const handle = await writable.watch(context); handle.start(listener);
	abstract watch(context: Context): Promise<NativeWatchHandle<T>>;

	/** What a new watch starts at; a source that can fail and recover tells its failure. */
	// 默认无失败：直接以当前值启动。可失败子类覆盖。
	// 示例：const start = source.start(); start.kind === "value" 时读取 start.value。
	start(): NativeStart<T> {
		return { kind: "value", value: this.value };
	}

	/**
	 * Its value now as a contribution reads it: throws its failure while it is failed, where `.value` keeps the last good
	 * value for readers (a registry whose `compose` threw).
	 */
	// 供贡献/合成读取：语义上“当前是否可用”。默认实现直接返回值；
	// 失败型子类可覆盖为“失败时抛错”，从而让 compose 感知失败而不是拿到旧值。
	// 示例：来源正常时 source.current() 返回当前值；RegistryValueSource 失败时抛出该错误。
	current(): T {
		return this.value;
	}

	/** The host's batch, `undefined` once the source ended. */
	// 受保护 getter：子类通过 this.batch 访问；外部无法拿到，避免绕过生命周期。
	protected get batch(): Batch | undefined {
		return this.#batch;
	}

	/** Records a change inside the current batch: every dependent marked. */
	// 受保护的变更登记：只标脏依赖者；是否投递帧由子类决定（FollowedSource 会额外 list）。
	protected changed(): void {
		for (const dependent of this.dependents) dependent.invalidate();
	}

	/** Ends the source for good: its dependents dropped, the batch let go. */
	// 结束：清空依赖并释放批次引用。子类覆盖时应先/后调用 super.end()。
	protected end(): void {
		this.#batch = undefined;
		this.dependents.clear();
	}
}

/**
 * What the watches and observers were last given: a value, a failure (one call per failure episode), or nothing yet
 * (a source with no value, followed for its first one).
 */
// 内部记录：
// - value：跟随者最后一次看到的值；
// - failed：跟随者看到过值，随后收到失败帧；
// - none：有等待首值的跟随者，但还没有值可给。
// 这个状态用于“同一身份不重复投递”和“失败只发一次”的判断。
type Shown<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "failed" } | { readonly kind: "none" };

// 共享的结束原因对象。
const ENDED: WatchEnd = { kind: "ended" };

// 上下文 abort 导致的结束原因。
const ABORTED: WatchEnd = { kind: "aborted" };

// 失败状态的共享实例（值无关）。
const FAILED: Shown<never> = { kind: "failed" };

// none 状态常量；as const 让 kind 保持字面量类型 "none"。
const NONE = { kind: "none" } as const;

// 空操作：用于无需清理的 detach/停止路径，避免分配闭包。
const NOTHING = (): void => {};

/**
 * A native source its followers get through the batch (a writable, a registry value): a change lists it for one frame
 * when someone follows it; the frame is its value then, delivered only when it is another value (identity) than the
 * one its followers have, or after a failure, whose call comes once per episode.
 */
// 完整实现：跟随者 = watch + observer。变化时若有人跟随，则把 source 排进批次;
// 投递时再读取当前值，只有身份变化或新失败才发送。
// 这样多个同步 set 合并为一批一帧，且没有跟随者时不保留旧值。
export abstract class FollowedSource<T = unknown> extends NativeSource<T> {
	readonly #watches = new Set<NativeWatch<T>>();
	/** Synchronous observers and Chord's own subscribers (`retryOn`), fed inside the batch, each with its cleanup. */
	// Map 的值是清理函数（移除 abort 监听）；subscribe 的观察者没有清理函数时存 NOTHING。
	readonly #observers = new Map<NativeObserver<T>, () => void>();
	/** What the followers have; `undefined` while nobody follows (so no old value is kept). */
	#shown: Shown<T> | undefined;
	/** Listed for a frame in the current batch. */
	#listed = false;

	/** Whether a watch or an observer follows it (a registry value also while readers wait for its first value). */
	// 只读判断：任一集合非空。子类（RegistryValueSource）可覆盖以把等待首值的读者也算作跟随。
	// 示例：watch 句柄打开期间 source.watched 为 true，最后一个句柄 stop 后为 false。
	get watched(): boolean {
		return this.#watches.size > 0 || this.#observers.size > 0;
	}

	// 异步 watch：包装同步 openWatch，满足接口。
	// 示例：const handle = await writable.watch(context); handle.start(listener);
	async watch(context: Context): Promise<NativeWatch<T>> {
		return this.openWatch(context);
	}

	/**
	 * `watch` without the Promise. On a failed source it opens at the last good value and its first call is the
	 * failure; with no value to start at it throws the failure. An ended source gives a watch that has ended.
	 */
	// 同步打开 watch。流程：
	// 1) source 已结束：返回一个立即 ended 的 watch（仍给出最后值），不注册任何东西；
	// 2) 批次内打开：拒绝（invalid/reentrant）；
	// 3) 失败且无最后好值：抛出失败；
	// 4) 记录 shown（首个跟随者建立基准）、创建 watch、登记并处理 abort/失败帧。
	// 示例：const handle = source.openWatch(context); 同步得到句柄；失败且无 last 时这里直接抛错。
	openWatch(context: Context): NativeWatch<T> {
		const batch = this.batch;
		if (batch === undefined) {
			// 已结束的 source 不再投递；停止/上报回调都是空操作。
			const ended = new NativeWatch<T>(this.value, NOTHING, NOTHING);
			ended.end(ENDED);
			return ended;
		}
		// 批次投递/计算期间打开会看到半状态，统一拒绝。
		batch.assertOutside("watch");
		const start = this.start();
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		// 失败分支收窄后 last 一定存在；! 只是类型断言，运行时不做检查。
		const value = start.kind === "value" ? start.value : start.last!.value;
		// 先建立 shown 基准，再真正加入集合；顺序保证首个 watch 不会漏掉后续帧。
		this.#follow(start);
		// 停止函数只删除本 watch，不触发用户回调。
		const watch: NativeWatch<T> = new NativeWatch(value, () => this.#unfollow(watch), batch.reportListener);
		this.#watches.add(watch);
		if (context.abortSignal !== undefined) watch.observeAbort(context.abortSignal);
		// 失败源：先以最后好值建立，再立即补发失败调用。
		if (start.kind === "failed") watch.fail(handedOut(start.error), context);
		return watch;
	}

	/**
	 * Attaches a synchronous observer at the current value (Durable's `observeXXX`); it counts as following, so a lazy
	 * value is computed in the batch that changed it. Throws the failure when there is no value to start at; aborting
	 * `context` detaches it (`aborted`); the source's end detaches it too (`ended`), its abort listener removed.
	 */
	// 同步观察：与 watch 类似，但立即把当前值作为返回值给出，之后通过 advance 接收变化。
	// 结束路径有三种：source 已结束/context 已 abort（立即 end，返回空 detach）、
	// 调用 detach（只移除观察者）、context 后续 abort（移除并 end aborted）。
	// 示例：const seen = source.observe({ advance(call) { log(call); }, end(end) { log(end); } }, context);
	observe(observer: NativeObserver<T>, context: Context): NativeObservation<T> {
		// 可选链：已结束 source 的 batch 为 undefined，此时不检查重入。
		this.batch?.assertOutside("observe");
		const start = this.start();
		if (start.kind === "failed" && start.last === undefined) throw start.error;
		const value = start.kind === "value" ? start.value : start.last!.value;
		if (this.batch === undefined) {
			// 已结束：没有未来调用，观察者立即结束。
			observer.end(ENDED);
			return { value, detach: NOTHING };
		}
		const signal = context.abortSignal;
		// 已中止的信号：不注册监听，直接结束。
		if (signal?.aborted) {
			observer.end(ABORTED);
			return { value, detach: NOTHING };
		}
		const aborted = (): void => {
			// 可能已被 detach；只在仍登记时处理，避免重复 end。
			if (!this.#observers.has(observer)) return;
			// unsubscribe 会移除监听并重新结算跟随者。
			this.unsubscribe(observer);
			observer.end(ABORTED);
		};
		// 没有 signal 时无需清理；有 signal 时 cleanup 只移除监听（不 end）。
		const cleanup = signal === undefined ? NOTHING : () => signal.removeEventListener("abort", aborted);
		// once:true 让浏览器/Node 在触发后自动移除监听；cleanup 用于提前 detach。
		signal?.addEventListener("abort", aborted, { once: true });
		this.#follow(start);
		this.#observers.set(observer, cleanup);
		// detach 只取消观察，不调用 observer.end。
		return { value, detach: () => this.unsubscribe(observer) };
	}

	/**
	 * Feeds `observer` every call from now on, inside each batch, also while the source has no value (Chord's own
	 * followers: `retryOn`). Nothing is delivered for the current value.
	 */
	// 内部订阅：不要求当前有值，也不用给出初值；用于 Chord 自身的等待者。
	// 与 observe 的差别：没有 detach 返回、没有 abort 处理、不发送当前值。
	// 示例：source.subscribe(retryObserver); 之后每个批次收到一次 advance，当前值不会补发。
	subscribe(observer: NativeObserver<T>): void {
		if (this.batch === undefined) return;
		// 无值时记录 none，等待首值；有值则记录当前值基准。
		this.#follow(this.#startOrNone());
		this.#observers.set(observer, NOTHING);
	}

	// 取消观察/订阅：只处理仍登记的对象；cleanup 可能为空操作；
	// 最后重新结算，若已无跟随者则丢弃 shown 并通知子类 unfollowed。
	// 示例：source.unsubscribe(observer); 重复取消同一个 observer 无副作用。
	unsubscribe(observer: NativeObserver<T>): void {
		const cleanup = this.#observers.get(observer);
		if (cleanup === undefined) return;
		this.#observers.delete(observer);
		cleanup();
		this.#settleFollowers();
	}

	/** Delivers this batch's frame: the new value when the followers have another, or a failure once per episode. */
	// 批次投递入口：清除本批 listed 标记；无 shown 表示无跟随者，直接返回。
	// 实际帧由 #deliver 决定；投递后重新结算（等待首值的读者可能已在本次投递中被满足）。
	// 示例：Batch 对每个 changed() 登记过的 source 调用一次 source.deliver(context)。
	deliver(context: Context): void {
		this.#listed = false;
		const shown = this.#shown;
		if (shown === undefined) return;
		this.#deliver(shown, context);
		// Readers waiting for a first value pulled it through this delivery: nothing is kept for them.
		this.#settleFollowers();
	}

	/**
	 * Records a change inside the current batch: every dependent marked, and the source listed for a frame when someone
	 * follows it (or `watched` says so).
	 */
	// 覆写：先标脏依赖者，再决定是否把 source 排进批次帧。
	protected override changed(): void {
		super.changed();
		this.list();
	}

	/**
	 * Lists the source for a frame in the current batch when someone follows it (or `watched` says so), its dependents
	 * left as they are (marked already).
	 */
	// 登记帧：每批最多一次（#listed），且必须有人跟随、有批次。
	// 不在 adopt 阶段读取值：读取可能触发计算/订阅，统一推迟到 deliver。
	protected list(): void {
		if (this.#listed || !this.watched || this.batch === undefined) return;
		this.#listed = true;
		// Only readers waiting for a first value follow it without a follower's record: they have none. Not computed
		// here: marking runs inside adoptions, the value is pulled in the delivery.
		// ??= 只在 shown 仍为 undefined 时写入 none，建立“尚无值”的基准。
		this.#shown ??= NONE;
		this.batch.changed(this);
	}

	/** Nothing follows it any more (no watch, no observer): a subclass drops what it kept for followers. */
	// 钩子：无跟随者时由 #settleFollowers 调用；默认无动作，子类可释放映射缓存等。
	protected unfollowed(): void {}

	/** Ends the source for good: watches and observers end `ended` (their abort listeners removed). */
	// 覆写结束：先释放基类批次/依赖，再清理 shown、结束所有 watch、复制并清空 observer 后逐一 cleanup + end。
	protected override end(): void {
		super.end();
		this.#shown = undefined;
		// Ending detaches, which deletes the current entry (safe while iterating) and runs no listener.
		for (const watch of this.#watches) watch.end(ENDED);
		// 复制：end 可能间接触发 unsubscribe 修改 Map。
		const observers = [...this.#observers];
		this.#observers.clear();
		for (const [observer, cleanup] of observers) {
			cleanup();
			observer.end(ENDED);
		}
	}

	// 私有投递核心：重新读取 start 判断当前状态。
	// 失败分支：只有之前给过值的跟随者才收到失败；从未有值的跟随者继续等待首值。
	// 值分支：当前值合法且与 shown 值身份不同才发送；首次给值时 shown 可能是 none。
	// 示例：shown 为 value(1)、start 为 value(2) 时发送 value 帧；start 仍为 1 时不发帧。
	#deliver(shown: Shown<T>, context: Context): void {
		const start = this.#startOrNone();
		if (start.kind === "failed") {
			// A failure reaches followers that had a value: those without one wait for the first.
			if (shown.kind !== "value") return;
			this.#shown = FAILED;
			const error = handedOut(start.error);
			for (const watch of this.#watches) watch.fail(error, context);
			// 复制观察者键：观察者可能在回调中 detach 自己。
			for (const observer of [...this.#observers.keys()]) observer.advance({ kind: "failed", error }, context);
			return;
		}
		// 无值（none）或值身份相同：不发帧。
		if (start.kind !== "value" || (shown.kind === "value" && shown.value === start.value)) return;
		const { value } = start;
		// 先记录新 shown，再通知；回调中读到的基准已更新。
		this.#shown = start;
		for (const watch of this.#watches) watch.advance(value, context);
		// A copy: an observer may detach itself in its call.
		for (const observer of [...this.#observers.keys()]) observer.advance({ kind: "value", value }, context);
	}

	/** Its start, `none` while it has no value. */
	// 把“失败且无最后好值”统一映射为 none；其他状态原样返回。
	// 返回类型是联合，收窄时需先排除 none。
	// 示例：失败且无 last 的来源返回 { kind: "none" }；正常来源返回其 start。
	#startOrNone(): NativeStart<T> | { readonly kind: "none" } {
		const start = this.start();
		return start.kind === "failed" && start.last === undefined ? NONE : start;
	}

	/** A follower comes: the first one records what followers have (a later one opened at the same current value). */
	// 第一个跟随者建立 shown 基准；之后的跟随者不再改写，因为它们都从同一当前值开始。
	// 示例：第一个 openWatch 调用 #follow(start)；第二个 openWatch 不再改写 shown。
	#follow(start: NativeStart<T> | { readonly kind: "none" }): void {
		if (this.#shown !== undefined) return;
		// 失败启动记录为 failed；value/none 原样保存。
		this.#shown = start.kind === "failed" ? FAILED : start;
	}

	// watch 停止：从集合删除并重新结算。
	// 示例：handle.stop() 内部调用 #unfollow(watch)，然后重新结算 shown。
	#unfollow(watch: NativeWatch<T>): void {
		this.#watches.delete(watch);
		this.#settleFollowers();
	}

	/** No follower left: nothing is shown any more, so no old value is kept. */
	// 无任何跟随者时丢弃 shown（避免长期持有大对象）并通知子类。
	// 示例：最后一个 observer detach 后，shown 被清空，并调用子类的 unfollowed()。
	#settleFollowers(): void {
		if (this.#watches.size > 0 || this.#observers.size > 0) return;
		this.#shown = undefined;
		this.unfollowed();
	}
}
