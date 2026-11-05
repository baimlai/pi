// Watch handles: the watch types and the one implementation of their lifecycle, for JSON and native values.
//
// 文件导读
// 所属：packages/chord 的根级 watch 模块，为文档/派生值/引用成员提供“值 + 变更”观察接口。
// 职责边界：定义观察者的类型与统一的串行投递生命周期；不决定值如何产生，也不持有存储。JSON 值用 Watch，
// 进程内任意值（含函数、错误）用 NativeWatch。上游是 Watchable.watch / NativeWatchable.watch 的实现方（文档、derive 等）；
// 下游是监听器回调。终止结果通过 closed Promise 返回 WatchEnd；监听器抛错会以 listener_error 终止，源可恢复的失败
// 则以 failed call 继续观察，不终止。
// 能力清单：
// - WatchEnd：终止原因联合（stopped/aborted/ended/listener_error/failed）。
// - WatchCall / NativeWatchCall：回调帧；JSON 帧带 ops 与 retired，native 帧只有值或失败。
// - WatchHandle / NativeWatchHandle：对外句柄（当前值、start、stop、closed）。
// - Watchable / NativeWatchable：可观察对象接口（当前值 + watch）。
// - WatchLifecycle（私有抽象类）：串行投递、微任务调度、终止与资源释放的唯一实现。
// - Watch：JSON 源的句柄，用 PendingOps 折叠帧，必要时以根替换 op 表示溢出/失败后的新值。
// - NativeWatch：native 源的句柄，按顺序逐值投递；积压超过 100 个值时折叠为一个（默认最新值）。
// - STOPPED/ABORTED/ENDED、MAX_PENDING_NATIVE_VALUES、toError：常量与错误归一化辅助。
// 组合与顺序：源调用 advance/fail → pending() → queueMicrotask → #drain → next() → listener(call, context)。
// stop/abort/end/endAfterDelivery 最终都走 #terminate，且只生效一次；终止时释放源引用并 resolve closed。
// 示例：`const handle = await value.watch(ctx); handle.start(async (call, context) => {
//   if (call.kind === "value") use(call.value);
// }); const end = await handle.stop();`
// 阅读顺序：先看六个公开类型，再看 WatchLifecycle 的 start/stop/#schedule/#drain/#terminate，
// 然后 Watch 的 advance/next，最后 NativeWatch 的环形积压处理。
import { type Context, withoutAbortSignal } from "./context/index.ts";
import { type Op, PendingOps } from "./delta/index.ts";
import type { JsonValue } from "./json.ts";

/**
 * Terminal result of one watch, tagged by `kind`. A watch ends only for good; a failure its source recovers from is a
 * `failed` call (`WatchCall`), and the watch stays open.
 *
 * - `stopped`: `stop()` was called.
 * - `aborted`: the context the watch was acquired with was aborted.
 * - `ended`: the source closed (its owner ended or closed).
 * - `listener_error`: the listener threw or rejected with `error`.
 * - `failed`: the source failed for good with `error`.
 */
// 可辨识联合：kind 的前三个共享一个成员（无 error），后两个各自带 error。
// 编译期可据此收窄；运行时只是普通对象，没有校验。
export type WatchEnd =
	| { readonly kind: "stopped" | "aborted" | "ended" }
	| { readonly kind: "listener_error"; readonly error: Error }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * One call of a JSON watch's listener, and one frame a source hands its watch, tagged by `kind`:
 *
 * - `value`: the newest value, the ops that turn the previous value into it, and whether the document the watch follows
 *   was retired since the previous value call. A retirement does not end the watch: `value` is then what the address
 *   shows after it (the source decides; a Durable document keeps the last value the watch was given, with no ops), and a
 *   document created there later arrives as `[["r", value]]`, possibly in the same call.
 * - `failed`: the source cannot compute its value now, with `error`; the watch stays open, and the next value arrives as
 *   `[["r", value]]`. `WatchHandle.value` keeps the last value.
 *
 * Plain data: the frame's context is the listener's second argument, never part of the call.
 */
// 泛型 T 是观察者看到的值类型。value 帧的 ops 是把上一值变成新值的操作列表；
// retired 表示自上一帧后文档被 retire，但 watch 不因此结束（后续值由源决定）。
// failed 帧表示源暂时无法计算，watch 保持打开；下一次成功值会以 [["r", value]] 根替换到达。
// 两者都是纯数据对象，context 不在 call 里，而是回调的第二个参数。
export type WatchCall<T> =
	| { readonly kind: "value"; readonly value: T; readonly ops: readonly Op[]; readonly retired: boolean }
	| { readonly kind: "failed"; readonly error: unknown };

/** One call of a native watch's listener: the new value, or a failure its source may recover from, as in `WatchCall`. */
// native 版本的帧：没有 ops/retired，因为每个值按身份独立投递，不做差异合并。
// failed 的含义与 WatchCall 相同：可恢复失败，watch 继续。
export type NativeWatchCall<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown };

/**
 * Serialized observation of an immutable value: one listener call at a time; changes made meanwhile arrive folded into
 * the next call.
 */
// JSON watch 的对外句柄。四个成员：
// - value：start 前是获取时的值，之后是最新已投递的值（failed 不改变它）；
// - start：安装唯一监听器，异步投递，绝不同步内联调用；
// - stop：幂等停止并返回终止结果；
// - closed：终止时 settle 的 Promise，即使回调仍在运行也成立（运行中的回调归调用方负责）。
// 接口只描述形状，运行时由 Watch 类实现。
export interface WatchHandle<T> {
	/** Acquisition revision before start; latest delivered immutable revision afterward (a `failed` call keeps it). */
	readonly value: T;
	/** Install the sole asynchronous listener. Never invokes it inline. */
	start(listener: (call: WatchCall<T>, context: Context) => Promise<void>): void;
	/** Idempotently stop future callbacks and return this watch's terminal result. */
	stop(): Promise<WatchEnd>;
	/** Settle when the watch terminates; an already-running callback remains caller-owned. */
	readonly closed: Promise<WatchEnd>;
}

/**
 * A value that changes and can be watched: documents, derives, members of references. Values are immutable by
 * convention (JSON for state); each watch starts at the current value and then gets the changes, folded while its
 * listener is busy.
 */
// 可观察的 JSON 值接口。实现方通常是文档或 derive；watch(context) 返回从当前值开始的句柄，
// context 中止会以 aborted 结束 watch。调用方拿到句柄后必须显式 start 才开始投递。
export interface Watchable<T> {
	/** The current value. */
	readonly value: T;
	/** A watch holding the current value, then its changes; aborting the context ends it. */
	watch(context: Context): Promise<WatchHandle<T>>;
}

/**
 * An in-process value that changes and can be watched (it may hold anything, errors and functions included): a change
 * is a new value by identity, delivered without ops.
 */
// 进程内可观察值接口：T 可以是任意类型（函数、Error 等），变更按身份判定，不计算 ops。
export interface NativeWatchable<T> {
	/** The current value. */
	readonly value: T;
	/** A watch holding the current value, then one frame per new value; aborting the context ends it. */
	watch(context: Context): Promise<NativeWatchHandle<T>>;
}

/**
 * Serialized observation of an in-process value: as `WatchHandle`, but each new value is its own call, in order, without
 * ops.
 */
// native 句柄：形状与 WatchHandle 相同，但 start 接收 NativeWatchCall，且每个新值单独一次调用、保持顺序。
export interface NativeWatchHandle<T> {
	/** Acquisition value before start; latest delivered value afterward (a `failed` call keeps it). */
	readonly value: T;
	/** Install the sole asynchronous listener. Never invokes it inline. */
	start(listener: (call: NativeWatchCall<T>, context: Context) => Promise<void>): void;
	/** Idempotently stop future callbacks and return this watch's terminal result. */
	stop(): Promise<WatchEnd>;
	/** Settle when the watch terminates; an already-running callback remains caller-owned. */
	readonly closed: Promise<WatchEnd>;
}

// 监听器签名：接收一帧 call 和该帧的 context，返回 Promise。泛型 C 由具体句柄决定（WatchCall 或 NativeWatchCall）。
type Listener<C> = (call: C, context: Context) => Promise<void>;

// 无错误的终止常量，复用对象避免每次终止都分配；它们被多个 watch 共享，但对象未冻结，
// 约定上只读，代码中不会修改。
const STOPPED: WatchEnd = { kind: "stopped" };
const ABORTED: WatchEnd = { kind: "aborted" };
const ENDED: WatchEnd = { kind: "ended" };

/** A failure call, as both call types have it. */
// 两种 call 共有的失败形状，供抽象类内部使用；注意 error 是 unknown，因为源可以抛任意值。
type FailedCall = { readonly kind: "failed"; readonly error: unknown };

/**
 * The lifecycle both handles share: serialized delivery and termination. A source feeds it and ends it explicitly;
 * termination drops every reference the watch holds into its source, so a stopped watch that is still referenced keeps
 * nothing but its last value alive. Subclasses keep what is pending, each call apart from its frame's context, so the
 * call a listener gets carries nothing but its data.
 */
// 两个句柄共享的生命周期实现。泛型参数：
// - T：值类型；
// - C：call 类型，约束为“带 value:T 的 value 成员 或 FailedCall”。
// 子类只负责“待处理队列”的存取（pendingContext/next/release），基类负责启动、串行投递、终止与 closed。
// 终止时清空所有源引用（detach/report/listener），因此即使句柄仍被引用，也只保留最后一个值。
abstract class WatchLifecycle<T, C extends { readonly kind: "value"; readonly value: T } | FailedCall> {
	// 从源退订的函数；终止时调用一次，之后置 undefined。
	#detach: (() => void) | undefined;
	// 监听器抛错时的上报函数；终止时置 undefined。
	#report: ((error: unknown) => void) | undefined;
	// closed 的 Promise 与 resolve/reject 句柄；只 resolve，不 reject。
	readonly #closed = Promise.withResolvers<WatchEnd>();
	// 当前/最新已投递的值；start 前是获取值。
	#value: T;
	// 唯一监听器；未 start 或已终止时为 undefined。
	#listener: Listener<C> | undefined;
	// 是否已 start（只能一次）。
	#started = false;
	// 是否已排队一个微任务，避免重复调度。
	#scheduled = false;
	// 监听器是否正在执行；用于串行化。
	#running = false;
	/** Set by `endAfterDelivery()`: the source sends nothing more; the watch ends `ended` once it delivered the rest. */
	// 源已声明不再发帧；待处理帧投递完后终止为 ended。
	#ending = false;
	/** Set once, by `#terminate()`. */
	// 终止原因；一旦设置，所有入口都成为 no-op。
	#end: WatchEnd | undefined;
	// 安装的中止信号与监听器，终止时移除，避免泄漏。
	#abortSignal: AbortSignal | undefined;
	#abortListener: (() => void) | undefined;

	// 传入初始值、退订回调、错误上报回调；不自动启动投递。
	constructor(value: T, detach: () => void, report: (error: unknown) => void) {
		this.#value = value;
		this.#detach = detach;
		this.#report = report;
	}

	// 只读 getter：调用方读取最新值，但不能直接赋值。
	get value(): T {
		return this.#value;
	}

	// 终止 Promise 的只读视图；resolve 后值固定。
	get closed(): Promise<WatchEnd> {
		return this.#closed.promise;
	}

	// 安装唯一监听器。若已启动或已终止则抛错；否则记录并调度首次投递。
	// 即使已有待处理帧，也不会同步调用监听器（由 #schedule 的微任务保证）。
	start(listener: Listener<C>): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#end !== undefined) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		this.#schedule();
	}

	// 幂等停止：无论调用多少次都只终止一次，返回同一个 closed Promise。
	stop(): Promise<WatchEnd> {
		this.#terminate(STOPPED);
		return this.#closed.promise;
	}

	/** End the watch `aborted` when `signal` aborts; installed once. */
	// 绑定中止信号：只能安装一次；已终止的 watch 直接忽略。监听器只触发一次，触发后回调 abort()。
	// 若信号在安装时已经 abort，立即调用 abort()（addEventListener 不会补发历史事件）。
	observeAbort(signal: AbortSignal): void {
		if (this.#abortSignal !== undefined) throw new Error("Watch abort is already installed");
		if (this.#end !== undefined) return;
		this.#abortSignal = signal;
		this.#abortListener = () => this.abort();
		signal.addEventListener("abort", this.#abortListener, { once: true });
		if (signal.aborted) this.abort();
	}

	/** End the watch `aborted`: its acquisition context was aborted. */
	// 由 observeAbort 或源调用；以 aborted 终止。
	abort(): void {
		this.#terminate(ABORTED);
	}

	/**
	 * End the watch with `end` at once, dropping what is pending: the source closed (`ended`), or failed for good
	 * (`failed`). A failure the source may recover from is a `failed` call instead (`fail()`).
	 */
	// 立即终止并丢弃待处理帧。用于源关闭或永久失败；可恢复失败应使用子类的 fail() 产生 failed call。
	end(end: WatchEnd): void {
		this.#terminate(end);
	}

	/**
	 * The source sends nothing more after its last frames, such as a retirement: take no more frames, deliver what is
	 * pending, then end `ended`, after the running call returns, if one runs. Until then the watch stays attached, so
	 * `end()`, `stop()`, an abort, and a throwing listener still end it first; a watch never started keeps what is
	 * pending until one of them or `start()`.
	 */
	// 软结束：不再接收新帧，但先投递完待处理内容，再以 ended 终止。
	// 若当前没有运行中的回调且没有待处理帧，立即终止；否则由 #drain 在队列排空后终止。
	// 未 start 的 watch 会保留待处理帧，直到 start 或其他终止路径。
	endAfterDelivery(): void {
		if (this.#end !== undefined || this.#ending) return;
		this.#ending = true;
		if (!this.#running && this.pendingContext === undefined) this.#terminate(ENDED);
	}

	/** Whether the watch still takes frames: it has not ended, and its source has not ended. */
	// 子类用它判断是否还应接收源帧：已终止或已声明软结束都返回 false。
	protected get open(): boolean {
		return this.#end === undefined && !this.#ending;
	}

	/** The context of the newest frame the next call covers, or undefined when nothing is pending. */
	// 抽象成员：子类报告“下一帧的 context”，undefined 表示没有待处理帧。context 同时充当“有帧”标志。
	protected abstract get pendingContext(): Context | undefined;

	/** Take the next call; called only while something is pending. */
	// 抽象成员：子类取出一帧并组装成 listener 的 call；只有 pendingContext 非 undefined 时调用。
	protected abstract next(): C;

	/** Drop everything pending and every reference into the source; called once, on termination. */
	// 抽象成员：终止时清空子类队列与源引用，只调用一次。
	protected abstract release(): void;

	/** Something became pending: deliver it once started, never inline. */
	// 子类在入队后调用；未 start 时只保留待处理状态，start 时会调度。
	protected pending(): void {
		if (this.#started) this.#schedule();
	}

	// 调度一次投递：已有调度、正在运行或已终止时直接返回；否则用 queueMicrotask 延后，绝不同步调用。
	// #scheduled 防止同一 tick 内多个源帧触发多次微任务。
	#schedule(): void {
		if (this.#scheduled || this.#running || this.#end !== undefined) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			void this.#drain();
		});
	}

	/**
	 * Deliver until nothing is pending; what arrives during a call is taken after it returns. A watch whose source ended
	 * ends once it delivered the rest and its last call returned.
	 */
	// 串行投递循环：每次取一帧、更新 value、await 监听器；监听器运行期间到达的帧留在队列，等本次返回后再取。
	// 若没有待处理帧且源已 endAfterDelivery，则终止为 ended；否则退出循环等待下一次 pending。
	// 监听器抛错：先上报，再以 listener_error 终止（若尚未被其他路径终止）。finally 保证 running 复位。
	async #drain(): Promise<void> {
		if (this.#running || this.#end !== undefined || !this.#started) return;
		this.#running = true;
		try {
			while (this.#end === undefined) {
				const listener = this.#listener;
				if (listener === undefined) break;
				const frameContext = this.pendingContext;
				if (frameContext === undefined) {
					if (this.#ending) this.#terminate(ENDED);
					break;
				}
				const call = this.next();
				// failed call 不更新 value（保持最后一次成功投递的值）。
				if (call.kind === "value") this.#value = call.value;
				try {
					// withoutAbortSignal 移除 context 上的中止信号，防止监听器拿它去结束别的东西或看到已触发的信号。
					await listener(call, withoutAbortSignal(frameContext));
				} catch (error) {
					// 如果监听器运行期间 watch 已被 stop/end，则保留先前的终止原因，不覆盖为 listener_error。
					if (this.#end === undefined) {
						this.#report?.(error);
						this.#terminate({ kind: "listener_error", error: toError(error) });
					}
					break;
				}
			}
		} finally {
			this.#running = false;
		}
	}

	/**
	 * End the watch, once: detach, drop what is pending and every reference into the source, and settle `closed`. A
	 * callback already running keeps running.
	 */
	// 唯一终止路径：幂等设置 #end，清空 detach/report/listener，调用子类 release 丢弃队列，
	// 移除中止监听，最后调用 detach（退订源）并 resolve closed。
	// 正在运行的监听器不会被取消（Promise 无法取消），但它之后的循环会因 #end 停止。
	#terminate(end: WatchEnd): void {
		if (this.#end !== undefined) return;
		this.#end = end;
		const detach = this.#detach;
		this.#detach = undefined;
		this.#report = undefined;
		this.#listener = undefined;
		this.release();
		if (this.#abortListener !== undefined) this.#abortSignal?.removeEventListener("abort", this.#abortListener);
		this.#abortSignal = undefined;
		this.#abortListener = undefined;
		detach?.();
		this.#closed.resolve(end);
	}
}

// 把任意抛出值归一化为 Error：已经是 Error 就原样返回；否则先尝试 String()，
// 若 String 本身抛错（如恶意对象的 toString），退回到 Object.prototype.toString.call，保证不再次抛出。
function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	try {
		return new Error(String(error));
	} catch {
		return new Error(Object.prototype.toString.call(error));
	}
}

/**
 * The watch handle of a JSON source. Frames that arrive before `start()` or while the listener runs wait in one
 * `PendingOps` queue; the next call gets the newest value, the folded ops of every frame since the previous call (or
 * `[["r", newest]]` after the queue overflowed), `retired` when any of them was a retirement, and the newest frame's
 * context. A frame delivered alone is passed on as the source made it. A failure (`fail()`) drops the pending frames and
 * waits as one `failed` call; a value after it replaces it, and the first value call after a failure is `[["r",
 * value]]`. `detach` unsubscribes it from its source on termination; `report` gets a listener's throw, which also ends
 * the watch.
 */
// JSON 源的句柄实现。核心：把源发来的多帧折叠成一次 listener 调用。
// 待处理队列由 PendingOps 保存 ops；#lone 缓存“唯一一帧”的原始 call，避免为单帧重新分配；
// #newestValue/#newestContext 记录最新值与该帧 context（context 同时表示“有帧待处理”）；
// #retired 记录期间是否发生 retire；#failure/#replace 处理可恢复失败后的根替换语义。
export class Watch<T> extends WatchLifecycle<T, WatchCall<T>> implements WatchHandle<T> {
	// PendingOps 负责把每帧的 ops 合并，并在溢出时给出可判定的结果（take() 返回 ops 或 overflow）。
	readonly #ops = new PendingOps();
	/**
	 * The source's call while it is the only frame pending: the call passes it on, with no allocation. A second frame
	 * drops it, so its ops stay only as long as `PendingOps` keeps them (folded, or dropped by an overflow).
	 */
	// 仅当只有一帧待处理时保存源原始 call；第二帧到来就置 undefined，让 PendingOps 接管合并。
	#lone: WatchValueCall<T> | undefined;
	/** The newest frame's value and context, while a call is pending; the context also marks that one is. */
	// 最新值与最新帧 context；#newestValue 可能合法地为 undefined（T 允许），所以用 context 判断是否有帧。
	#newestValue: T | undefined;
	#newestContext: Context | undefined;
	/** A pending frame was a retirement. */
	// 只要本轮折叠的任一帧 retired 为 true，下一次 value call 就报告 retired。
	#retired = false;
	/** The newest frame was a failure: the next call is this. */
	// 待处理的 failed call；优先级高于值。
	#failure: FailedCall | undefined;
	/** A failure came after the last value call: the next value call replaces the root, and ops are not kept. */
	// 失败后进入“替换”模式：下一次值必须是根替换 [["r", value]]，因为之前的 ops 基线已不可靠。
	#replace = false;

	/**
	 * Queue the frame `call`. A value's ops turn the previous value into it, and `retired` says the document the watch
	 * follows was retired, which the next value call reports however many frames it folds; a failure is `fail()`.
	 */
	// 入队一帧：failed 转给 #fail；值帧在 watch 仍开放时折叠进队列。
	// 若处于 #replace 模式，只清除 failure（值将作为根替换）；否则缓存单帧或把 ops 推入 PendingOps。
	// 最后更新最新值/context/retired 并触发投递。
	advance(call: WatchCall<T>, context: Context): void {
		if (call.kind === "failed") {
			this.#fail(call, context);
			return;
		}
		if (!this.open) return;
		if (this.#replace) {
			// 失败后的第一个值：不需要保留 ops，next() 会生成根替换。
			this.#failure = undefined;
		} else {
			// 只有此前没有待处理帧时才保存原始 call；否则失效，交给 ops 合并。
			this.#lone = this.#newestContext === undefined ? call : undefined;
			this.#ops.push(call.ops);
		}
		this.#newestValue = call.value;
		this.#newestContext = context;
		if (call.retired) this.#retired = true;
		this.pending();
	}

	/**
	 * Queue a failure the source may recover from: the pending frames are dropped (`value` keeps the last delivered
	 * value), the listener gets `{ kind: "failed", error }`, and the next value arrives as `[["r", value]]`.
	 */
	// 公开的可恢复失败入口：组装 failed call 并交给内部实现。
	fail(error: unknown, context: Context): void {
		this.#fail({ kind: "failed", error }, context);
	}

	// 处理失败：丢弃待处理的 ops 与单帧，清空最新值（但不动已投递的 #value），记录 failure 与 context，
	// 进入 #replace 模式，并调度投递。
	#fail(call: FailedCall, context: Context): void {
		if (!this.open) return;
		// take() 清空 PendingOps；返回值不用，因为失败后基线失效。
		this.#ops.take();
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#failure = call;
		this.#newestContext = context;
		this.#replace = true;
		this.pending();
	}

	// 有帧待处理时返回最新帧 context；否则 undefined。
	protected get pendingContext(): Context | undefined {
		return this.#newestContext;
	}

	// 组装下一次 listener 调用并清空本轮状态。
	// 若处于失败后模式，交给 #nextAfterFailure；否则取出 PendingOps 批次：
	// - 只有单帧（#lone 存在）直接返回源原始 call，避免分配；
	// - 多帧折叠成功：ops 是合并后的操作；
	// - PendingOps 溢出：退化为一帧根替换 [["r", value]]，保证新值仍能到达。
	// `as T` 是编译期断言：有 pendingContext 就一定有 newestValue。
	protected next(): WatchCall<T> {
		// After a failure the call is that failure, or the value after it; otherwise one field read decides.
		if (this.#replace) return this.#nextAfterFailure();
		const lone = this.#lone;
		// Set with the context, which says a frame is pending.
		const value = this.#newestValue as T;
		const batch = this.#ops.take();
		const retired = this.#retired;
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#newestContext = undefined;
		this.#retired = false;
		// One frame never folds or overflows: its call is the listener's.
		if (lone !== undefined) return lone;
		// Values of a JSON watch are JSON; `T` is the source's narrower or wider view of them (e.g. a typed document).
		// batch 是可辨识联合：kind 为 "ops" 时带合并 ops，否则表示溢出。
		const ops: readonly Op[] = batch.kind === "ops" ? batch.ops : [["r", value as JsonValue]];
		return { kind: "value", value, ops, retired };
	}

	/** The pending failure, or the value after one as a root replacement (no ops were kept since the failure). */
	// 失败后模式：先交付 pending failure（如果有）；否则交付失败后的第一个值，ops 固定为根替换。
	// 交付后退出 #replace，后续帧恢复正常的 ops 折叠。
	#nextAfterFailure(): WatchCall<T> {
		const failure = this.#failure;
		this.#newestContext = undefined;
		if (failure !== undefined) {
			this.#failure = undefined;
			return failure;
		}
		const value = this.#newestValue as T;
		const retired = this.#retired;
		this.#newestValue = undefined;
		this.#retired = false;
		this.#replace = false;
		return { kind: "value", value, ops: [["r", value as JsonValue]], retired };
	}

	// 终止时清空所有待处理状态，释放对源数据的引用；由基类 #terminate 调用一次。
	protected release(): void {
		this.#ops.take();
		this.#lone = undefined;
		this.#newestValue = undefined;
		this.#newestContext = undefined;
		this.#retired = false;
		this.#failure = undefined;
		this.#replace = false;
	}
}

/** The value call of a JSON watch. */
// Extract 是内置条件类型：从联合中挑出可赋值给 { kind: "value" } 的成员，即 WatchCall 的值帧类型。
type WatchValueCall<T> = Extract<WatchCall<T>, { readonly kind: "value" }>;

/** Maximum values retained behind one unavailable native watch listener. */
// native watch 积压上限：待处理值达到 2×100 个槽（值与 context 各占一个）时折叠为一个。
const MAX_PENDING_NATIVE_VALUES = 100;

/**
 * The watch handle of a native source: every value in order, one call each; past 100 pending values they collapse to
 * one, `replace()` or by default the newest value. A failure (`fail()`) drops the pending values and waits as one
 * `failed` call; a value after it replaces it. `detach` and `report` as for `Watch`.
 */
// native 源的句柄实现：按顺序逐值投递，每个值单独一次 listener 调用，没有 ops 折叠。
// 积压过多时（超过 2×MAX 个槽）把队列折叠为一个值：默认取最新值，若构造时提供 replace 则取 replace() 的结果。
// 失败会清空待处理值并排队一个 failed call；之后的新值直接替换失败，作为普通 value 帧到达。
export class NativeWatch<T> extends WatchLifecycle<T, NativeWatchCall<T>> implements NativeWatchHandle<T> {
	/**
	 * Pending values in order, each followed by its frame's context, from `#head` on. Values are kept raw: the call a
	 * listener gets is built when it is taken, so a value an overflow drops costs no object. A read index instead of
	 * `shift()` takes a backlog in constant time per value; taken slots are cleared at once, the array is emptied once
	 * all of it was taken, and its taken prefix dropped after 100 values.
	 */
	// 交错存储 value 与 context 的扁平数组，每个值占两个槽；#head 指向第一个未取槽位。
	// 这样每个值只需一次 push，读取时也不需要额外对象。
	readonly #pending: Array<T | Context | undefined> = [];
	#head = 0;
	// 积压折叠时可选的替代值工厂；undefined 表示直接用最新值。
	#replace: (() => T) | undefined;
	/** A pending failure and its frame's context; nothing else is pending meanwhile. */
	// 待处理的失败及其 context；失败期间队列已被清空，因此二者互斥。
	#failure: FailedCall | undefined;
	#failureContext: Context | undefined;

	// 前三个参数传给基类；可选 replace 供积压折叠时生成替代值（例如“已丢失 N 个更新”的摘要）。
	constructor(value: T, detach: () => void, report: (error: unknown) => void, replace?: () => T) {
		super(value, detach, report);
		this.#replace = replace;
	}

	/** Queue `value`, the source's new value; it replaces a pending failure. */
	// 入队新值：先取消待处理失败（新值覆盖失败状态），再把值与其 context 压入队列。
	// 当待处理槽数达到 2×MAX 时清空队列，只保留一个值：默认最新值，若有 replace 则用其返回值。
	// 最后调用 pending() 触发调度。
	advance(value: T, context: Context): void {
		if (!this.open) return;
		this.#failure = undefined;
		this.#failureContext = undefined;
		if (this.#pending.length - this.#head < 2 * MAX_PENDING_NATIVE_VALUES) {
			this.#pending.push(value, context);
		} else {
			this.#pending.length = 0;
			this.#head = 0;
			this.#pending.push(this.#replace === undefined ? value : this.#replace(), context);
		}
		this.pending();
	}

	/**
	 * Queue a failure the source may recover from: the pending values are dropped (`value` keeps the last delivered
	 * value), and the listener gets `{ kind: "failed", error }`.
	 */
	// 记录可恢复失败：清空待处理值（value 保持最后已投递值），保存 failed call 与其 context，再调度。
	fail(error: unknown, context: Context): void {
		if (!this.open) return;
		this.#pending.length = 0;
		this.#head = 0;
		this.#failure = { kind: "failed", error };
		this.#failureContext = context;
		this.pending();
	}

	// 有失败时用失败 context；否则读取队首值后面的 context 槽。越界读取得到 undefined，表示没有待处理值。
	protected get pendingContext(): Context | undefined {
		// The slot after a value holds its context; past the end it is empty.
		return this.#failureContext ?? (this.#pending[this.#head + 1] as Context | undefined);
	}

	// 取下一帧：失败优先且只返回一次；否则读取队首值，并根据剩余槽数决定如何推进 #head。
	// - 正好取到末尾：清空数组并重置 head；
	// - 已取前缀达到 2×MAX：用 copyWithin 把未取部分搬到开头，裁剪数组，避免无限增长；
	// - 一般情况：把已取的两个槽置 undefined（释放引用），head 前进两个。
	protected next(): NativeWatchCall<T> {
		const failure = this.#failure;
		if (failure !== undefined) {
			this.#failure = undefined;
			this.#failureContext = undefined;
			return failure;
		}
		const head = this.#head;
		const pending = this.#pending;
		// The slot at `#head` holds a value.
		const value = pending[head] as T;
		if (head + 2 === pending.length) {
			pending.length = 0;
			this.#head = 0;
		} else if (head + 2 >= 2 * MAX_PENDING_NATIVE_VALUES) {
			// A backlog that never drains: drop the taken prefix, at most once per 100 values, so the array stays bounded.
			// copyWithin(target, start)：把 [head+2, length) 搬到 0；随后裁剪长度并重置 head。
			pending.copyWithin(0, head + 2);
			pending.length -= head + 2;
			this.#head = 0;
		} else {
			pending[head] = undefined;
			pending[head + 1] = undefined;
			this.#head = head + 2;
		}
		return { kind: "value", value };
	}

	// 终止清理：清空队列、head、replace 工厂和失败状态，释放对值与 context 的引用。
	protected release(): void {
		this.#pending.length = 0;
		this.#head = 0;
		this.#replace = undefined;
		this.#failure = undefined;
		this.#failureContext = undefined;
	}
}
