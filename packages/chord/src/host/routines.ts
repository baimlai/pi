// Routines (§14): the standing behaviour an object or a facet declares, `self.on(source, fn)` and `self.onLive(fn)`.
// They start once their owner went live and stop when it ends (their ctx aborted, the drain waits for running calls);
// each call gets its own ctx; a call that throws is reported and called again after a backoff.
// 所属模块：packages/chord/src/host 的常驻例程（routine）层，服务于对象/facet 的 self.on 与 self.onLive。
// 上下游：Routines 由工厂或 facet 声明，owner 进入 live 后 start；下游依赖 watch（Watch/NativeWatch）、CallContext、
//   backoff.nextDelay、sleep 与 resolveWatchable。
// 结果：每个例程在 owner 生命周期内运行，调用错误经 host.report 报告；本文件不直接写库或发网络消息（除非 handler 自己）。
// 能力清单：
// - RoutineOwner：例程运行所需的标签、宿主、调用者、上下文与 drain 接入。
// - OnHandler / WatchValueCall / NativeWatchValueCall / OnNativeHandler / OnLiveHandler：三类 handler 的签名。
// - RoutineDeclarations：工厂 self 上的 on/onLive 声明接口。
// - Routines：收集声明并在 start 时逐个启动。
// - OnRoutine / live / call / failed（内部）：单个例程的状态机、重试与错误报告。
// 组合关系：Routines.on/onLive -> Routines.start(owner) -> new OnRoutine(...).start() 或 live(...)
//   -> watch 帧/失败 -> #next -> call -> #called 决定 idle/settling/backoff。
// 示例：routines.on(notes, (call, ctx) => save(call.value, ctx)); routines.onLive((ctx) => warm(ctx)); routines.start(owner);
// 阅读顺序：先 RoutineOwner 与 handler 类型，再 Routines 的声明/启动，随后 call/live 的调用与重试；
//   最后读 OnRoutine 的状态机（start/#frame/#next/#called/#end）。

import type { Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import { type Op, PendingOps } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { NativeSource, Source } from "../state/internal.ts";
import {
	NativeWatch,
	type NativeWatchable,
	type NativeWatchCall,
	type Watchable,
	type WatchCall,
	type WatchEnd,
} from "../watch.ts";
import { nextDelay } from "./backoff.ts";
import { CallContext, type Caller, type Ctx } from "./ctx.ts";
import type { AnyHost, Position } from "./host.ts";
import { resolveWatchable } from "./reference.ts";
import { sleep } from "./sleep.ts";

/**
 * Where routines run: their owner's label (for reports), its host, whom their calls act for, and the context of their
 * calls, aborted when the owner ends. `admit` adds a running call to the owner's drain.
 */
// 例程运行环境：label 用于错误报告，host 提供 report 与 CallContext，caller 是调用身份，context 描述 owner 生命周期。
// admit 让正在执行的调用进入 drain，owner 结束时先等待这些调用而不是直接丢弃。
export type RoutineOwner = {
	readonly label: string;
	readonly host: AnyHost;
	readonly caller: Caller;
	readonly context: Context;
	/**
	 * Adds a running call to the drain; `cleanup` (its bookkeeping) runs once, when it settles or when the attempt ends
	 * with it still running.
	 */
	admit(running: Promise<unknown>, cleanup: () => void): void;
};

/**
 * A routine's handler of a JSON source: the value call (the value, the ops since the previous call, whether the
 * source's document was retired since then) and the call's ctx. Failures are not calls of a handler (design §11): the
 * routine waits for the next value.
 */
// JSON 源 handler：输入一次 value 调用（值、自上次调用以来的 ops、是否退休）和本次调用的 ctx；可同步或异步返回。
// 失败不是调用，因此 handler 不会收到 kind="failed" 的帧；泛型 C 允许具体身份类型收窄 ctx。
export type OnHandler<T, C extends Ctx = Ctx> = (call: WatchValueCall<T>, ctx: C) => void | Promise<void>;

/** A JSON watch's value call: what an `on` handler gets. */
// 从 WatchCall 联合中只取 value 分支，排除 failed 等通知；Extract 是编译期类型运算。
export type WatchValueCall<T> = Extract<WatchCall<T>, { readonly kind: "value" }>;

/** A native watch's value call. */
// 原生源没有 ops/retired，只有值本身；同样只取 value 分支。
export type NativeWatchValueCall<T> = Extract<NativeWatchCall<T>, { readonly kind: "value" }>;

/** A routine's handler of a native source: the value call (the value) and the call's ctx. */
// 原生源 handler 的签名；除帧形状外与 OnHandler 相同的返回约定。
export type OnNativeHandler<T, C extends Ctx = Ctx> = (call: NativeWatchValueCall<T>, ctx: C) => void | Promise<void>;

/** An `onLive` routine: called once its owner is live. */
// 生命周期 handler：owner 进入 live 后调用一次；正常返回即结束，抛错则按退避重试。
export type OnLiveHandler<C extends Ctx = Ctx> = (ctx: C) => void | Promise<void>;

/** What the declarations of an owner (`on`, `onLive`) take; part of the factory's `self` and the facet's. */
// 声明接口：工厂的 self 与 facet 都暴露这组方法；P 把 ctx 收窄到应用身份类型。
// 两个 on 重载按 source 的 watch 类型区分 JSON 与原生源，实现方不能用相同参数签名同时覆盖两者。
export interface RoutineDeclarations<P extends Principal = Principal> {
	/**
	 * A routine over `source`: `fn` gets its current value first (ops `[["r", value]]`), then one call per change,
	 * never overlapping: changes during a call fold into one next call (the newest value, the ops since the previous
	 * call, `retired` when any of them was a retirement). After a call that threw, it is called again with the whole
	 * newest value (`retired` again if the call that threw had it) after a backoff (1 s doubling to 60 s), or at once on
	 * a change during the backoff. Ends with its source. A JSON watchable is one whose watch is Chord's shared `Watch`
	 * (every Chord and Durable source).
	 */
	on<T>(source: Watchable<T>, fn: OnHandler<T, Ctx<P>>): void;
	// 原生源重载：注册表值或 ref.state 等通过 NativeWatch 通知的源，只给值不给 ops。
	// 出现两次 on 是 TypeScript 重载声明，运行时只有一个实现。
	/**
	 * A routine over a native source (a registry value, `ref.state`): one whose watch is Chord's shared `NativeWatch`.
	 * As above without ops: after a busy call, one call with the newest value.
	 */
	on<T>(source: NativeWatchable<T>, fn: OnNativeHandler<T, Ctx<P>>): void;
	// onLive 在 owner 进入 live 时调用；正常返回结束，抛错按退避重启，owner 结束会中止其 ctx。
	/**
	 * A routine called once its owner is live. Returning ends it; a throw is reported and restarts it after a backoff
	 * (1 s doubling to 60 s, reset after a run of a minute); the owner's end aborts its ctx.
	 */
	onLive(fn: OnLiveHandler<Ctx<P>>): void;
}

/** A declared routine: its kind and position in reports (`{ kind: "on", position: 2 }`), its source and its handler. */
// 两条声明共用一个联合；at 是报告位置，position 在同类声明内从 1 递增。
// fn 的 `...args: never[]` 让任意 handler 都能存入，调用时再按 kind 断言成具体签名。
type Declaration =
	| {
			readonly kind: "on";
			readonly at: Position;
			readonly source: Watchable<unknown> | NativeWatchable<unknown>;
			readonly fn: (...args: never[]) => void | Promise<void>;
	  }
	| { readonly kind: "onLive"; readonly at: Position; readonly fn: OnLiveHandler };

/** How one routine call ended. */
// 调用结果用可辨识联合表示；失败时保留 unknown 错误，直到报告时才转成字符串/结构。
type Called = { readonly kind: "done" } | { readonly kind: "failed"; readonly error: unknown };

// 成功结果的共享常量，避免每次调用分配新对象；对象按约定只读。
const DONE: Called = { kind: "done" };

/** What `#failing` says of a source failed now. */
// as const 把 kind 收窄为字面量 "failed"，供返回类型判别。
const FAILING = { kind: "failed" } as const;

/** One run of an `onLive` that lasted this long resets its backoff. */
// 一次 onLive 运行超过 60 秒后，下一次失败从 1 秒重新退避，而不是继续沿用之前的指数值。
const LONG_RUN = 60_000;

/** An owner's routines: declared while its factory (or setup) runs, started once when it went live. */
// 声明收集器。declared 只增不减；ons/lives 是两类声明的独立计数，用于报告位置。
export class Routines {
	readonly #declared: Declaration[] = [];
	#ons = 0;
	#lives = 0;

	/** Declares `on(source, fn)`; whether the source is JSON or native is decided by its watch (`OnRoutine`). */
	// 只记录声明，不打开 watch；++ 前缀让第一次声明得到 position 1。
	on(source: Watchable<unknown> | NativeWatchable<unknown>, fn: (...args: never[]) => void | Promise<void>): void {
		this.#declared.push({ kind: "on", at: { kind: "on", position: ++this.#ons }, source, fn });
	}

	/** Whether nothing was declared. */
	// 只读判断，便于调用方跳过空 owner 的启动流程。
	get empty(): boolean {
		return this.#declared.length === 0;
	}

	/** Declares `onLive(fn)`. */
	// 与 on 相同，只入声明表；真正调用发生在 start。
	onLive(fn: OnLiveHandler): void {
		this.#declared.push({ kind: "onLive", at: { kind: "onLive", position: ++this.#lives }, fn });
	}

	/**
	 * Starts every routine for `owner`, which went live; they stop when its context is aborted. A routine whose
	 * synchronous start ends the owner (an `onLive` releasing its last reference) starts none of the later ones.
	 */
	// 按声明顺序启动全部例程，无返回。每个例程自行持有 Promise，因此 start 不等待它们。
	// 若 owner 在同步启动阶段已经结束（abortSignal 已 abort），后续声明不再启动。
	start(owner: RoutineOwner): void {
		for (const declaration of this.#declared) {
			if (owner.context.abortSignal?.aborted) return;
			// void 表示故意不等待；OnRoutine.start/live 都是永不拒绝的 async 函数。
			if (declaration.kind === "on") void new OnRoutine(owner, declaration).start();
			else void live(owner, declaration);
		}
	}
}

/**
 * Runs `onLive`'s handler until it returns or its owner ends; a throw is reported and the handler restarts after the
 * backoff.
 */
// 运行 onLive 直到正常返回或 owner 结束；返回 Promise<void>，永不拒绝。抛错时报告并按退避重试。
// 示例：fn 抛错 -> failed 报告 -> sleep(1s) -> fn 再运行；若这次运行超过 60 秒，下次失败重新从 1 秒开始。
async function live(owner: RoutineOwner, { at, fn }: Extract<Declaration, { kind: "onLive" }>): Promise<void> {
	// delay 在首次失败前是 undefined，nextDelay 会据此给出初始 1 秒。
	let delay: number | undefined;
	while (!owner.context.abortSignal?.aborted) {
		// started 用于判断本次运行是否足够长，从而重置退避。
		const started = Date.now();
		const called = await call(owner, fn);
		// 正常返回或 owner 已结束时永久退出；任务失败不重试。
		if (called.kind === "done" || owner.context.abortSignal?.aborted) return;
		failed(owner, at, called.error);
		// 下一次等待时长：长运行重置，否则指数增长封顶 60 秒。
		delay = nextDelay(Date.now() - started >= LONG_RUN ? undefined : delay);
		try {
			await sleep(delay, owner.context);
		} catch {
			// sleep 只会在上下文取消时拒绝；此时安静退出，不把取消当作失败。
			return;
		}
	}
}

/**
 * Runs one routine call under its own ctx (its `ctx.get` references released when it settles), admitted to the owner's
 * drain before the handler runs: a handler may end its own owner before its first await. Resolves with how it ended;
 * never rejects.
 */
// 在独立 ctx 下运行一次 handler。输入 owner 与调用函数；返回 Called 结果，Promise 永不拒绝。
// 先 admit 再执行 handler：即使 handler 同步结束 owner，drain 也已登记本次调用。结束时 settle ctx 释放引用。
// 示例：const outcome = await call(owner, (ctx) => handler({ kind: "value", value }, ctx));
function call(owner: RoutineOwner, invoke: (ctx: Ctx) => void | Promise<void>): Promise<Called> {
	// CallContext 以 owner 的 context 为父，继承取消、身份与宿主信息。
	const ctx = new CallContext(owner.context, owner.caller, owner.host);
	const settled = Promise.withResolvers<Called>();
	// admit 的 cleanup 与 finish 都会 settle；ctx.settle 需幂等，避免重复释放。
	owner.admit(settled.promise, () => ctx.settle());
	const finish = (called: Called): void => {
		ctx.settle();
		settled.resolve(called);
	};
	// Plugin code: a synchronous throw becomes the rejection.
	// async IIFE 把同步抛错转换成 rejected Promise，让失败走统一 finish 路径。
	(async () => invoke(ctx))().then(
		() => finish(DONE),
		(error: unknown) => finish({ kind: "failed", error }),
	);
	return settled.promise;
}

/** Reports a failed routine call or source. */
// 通过宿主 report 发送 routine_failed，附带对象标签、声明位置和原始错误；无返回值。
// 错误在这里汇总，调用方只决定何时重试。
function failed(owner: RoutineOwner, routine: Position, error: unknown): void {
	owner.host.report({ kind: "routine_failed", object: owner.label, routine, error });
}

/**
 * Where an `on` routine stands. `starting`: taking its watch; `idle`: waiting for a change; `calling`: a call runs
 * (changes meanwhile wait, folded, for the next); `settling`: a call succeeded while changes arrived, and the next one
 * waits for one macrotask, so every value its watch still buffers (a native watch replays them one per microtask) is
 * taken first; `backoff`: the last call threw and its timer calls again, unless a change during the backoff calls
 * first; `ended`: its watch ended (the owner ended, or the source ended or failed).
 */
// 状态机联合：前四个无附加数据；settling/backoff 各带一个计时器句柄，用于取消。
// ReturnType<typeof setTimeout> 兼容 Node 与浏览器计时器类型，不依赖具体实现。
type OnState =
	| { readonly kind: "starting" | "idle" | "calling" | "ended" }
	| { readonly kind: "settling" | "backoff"; readonly timer: ReturnType<typeof setTimeout> };

/**
 * What the next call's ops are relative to: `none` before the first call and after a throw (the handler may not have
 * applied what it got: the next call gets the whole value), `last` after a call that succeeded.
 */
// 基线只影响 ops 计算：none 时发 [["r", value]]，last 时发累积的增量。
type Basis = "none" | "last";

/**
 * One `on` routine. Its watch's listener never throws (a throwing listener would end the watch) and never waits: it
 * keeps the newest frame, folding JSON ops, and the routine makes one call at a time from it, the first call and the
 * retries after a throw through the same pending frame.
 */
// 单个 on 例程的状态机。监听回调只记录最新帧（绝不抛错、不 await），真正的调用由 #next 串行发起。
class OnRoutine {
	readonly #owner: RoutineOwner;
	readonly #declaration: Extract<Declaration, { kind: "on" }>;
	#state: OnState = { kind: "starting" };
	/** A native source's watch yields values without ops; decided by its watch's class. */
	// 由 start 中 watch instanceof NativeWatch 决定；之后 #frame/#invocation 按它选择帧形状。
	#native = false;
	/** The newest value no call got yet. */
	// pending 只保存值；ops 在 #ops 中折叠，调用时再组装。
	#pending: { readonly value: unknown } | undefined;
	/** The ops of the frames since the last call (JSON sources), folded. */
	// PendingOps 合并多个增量帧；take() 取走并清空，避免下次重复应用。
	readonly #ops = new PendingOps();
	/** One of the frames since the last call was a retirement (JSON sources). */
	// 一旦为 true，下一次调用带上 retired，提醒 handler 源文档已退休。
	#retired = false;
	// 首次调用和抛错后都是 none，保证 handler 收到可独立应用的全量值。
	#basis: Basis = "none";
	/** The value of the last call: a retry after a throw calls with it. */
	#last: unknown;
	/** The last call reported a retirement: a retry after a throw reports it again. */
	#lastRetired = false;
	#delay: number | undefined;
	/** The source failed after its last value: no call until its next value (a retry waits too). */
	#failed = false;

	constructor(owner: RoutineOwner, declaration: Extract<Declaration, { kind: "on" }>) {
		// 只保存引用；state 保持 starting，watch 尚未打开。
		this.#owner = owner;
		this.#declaration = declaration;
	}

	/**
	 * Takes the watch and calls with its value. On a failed Chord source it waits for its first good value instead (a
	 * source that never had one is followed until it has). A source that cannot be watched otherwise is reported; an
	 * owner or source that ended meanwhile ends the routine. Never rejects.
	 */
	// 打开 watch 并发出第一次调用。返回 Promise<void>，永不拒绝；失败按源/owner 状态决定等待还是结束。
	// 流程：处理“失败且无值”的源 -> 打开 watch -> 订阅 -> 取首值 -> #next。
	async start(): Promise<void> {
		const { source, at } = this.#declaration;
		let failing = this.#failing();
		// 源失败且从未有值时，普通 watch 无法起步；先作为订阅者等待首个好值。
		while (failing?.kind === "no_value") {
			// #firstValue 返回 false 表示 owner/源已结束，routine 永久停止。
			if (!(await this.#firstValue(failing.source))) {
				this.#state = { kind: "ended" };
				return;
			}
			// Asked again: a failure may have followed the first value before this resumed (one receive turn).
			failing = this.#failing();
		}
		let watch: Awaited<ReturnType<typeof source.watch>>;
		try {
			// watch 是异步打开；await 期间 owner 可能结束，因此后面仍要检查 closed/aborted。
			watch = await source.watch(this.#owner.context);
		} catch (error) {
			// 打开失败即结束本 routine；owner 已结束时不再报告（取消不是错误）。
			this.#state = { kind: "ended" };
			if (!this.#aborted()) failed(this.#owner, at, error);
			return;
		}
		// instanceof 是运行时类别判定：决定后续帧是否带 ops。
		this.#native = watch instanceof NativeWatch;
		// closed 是 Promise；then 注册结束处理，不阻塞 start。
		void watch.closed.then((end) => this.#end(end));
		try {
			// Both listeners return at once.
			// 监听器只把帧/失败交给状态机；返回已解决的 Promise，避免阻塞 watch。
			watch.start((call: WatchCall<unknown> | NativeWatchCall<unknown>) => {
				if (call.kind === "value") this.#frame(call);
				else this.#failure();
				return Promise.resolve();
			});
		} catch {
			// The watch ended while it was taken (the owner or the source ended): `closed` says how.
			return;
		}
		// A watch opened on a failed source holds its last good value, a stale one: its first call is the failure.
		if (failing?.kind === "failed") {
			// 该 watch 以失败帧起步，本 routine 等待下一个好值，不把 stale last 当作新帧。
			this.#state = { kind: "idle" };
			return;
		}
		// 首值来自 watch.value；随后立即发起第一次调用。
		this.#pending = { value: watch.value };
		this.#next();
	}

	/**
	 * Whether the source is a Chord source failed now (`failed`), or a JSON one with no value yet (`no_value`, with the
	 * source to follow); `undefined` otherwise (Durable's views tell their failures through their watches).
	 */
	// 判断源此刻是否失败/尚无值。返回判别对象或 undefined；会尝试解析并读取源的 start，失败则交给 watch 报告。
	#failing(): { readonly kind: "failed" } | { readonly kind: "no_value"; readonly source: Source } | undefined {
		const declared = this.#declaration.source;
		// A native source opens its watch at its last good value while failed (a registry whose `compose` threw): its
		// first call is the failure, not that stale value.
		// NativeSource 的 start 是纯数据描述，不抛错；failed 表示有 last 或没有。
		if (declared instanceof NativeSource) return declared.start().kind === "failed" ? FAILING : undefined;
		let source: unknown;
		try {
			// resolveWatchable 把引用成员解析为底层 Source；未绑定/已结束会抛错。
			source = resolveWatchable(this.#declaration.source);
		} catch {
			// Not bound or ended: the watch says so.
			return undefined;
		}
		if (!(source instanceof Source)) return undefined;
		let start: ReturnType<Source["start"]>;
		try {
			// 读取起始描述可能触发 derive 计算，计算抛错时交给 watch 处理。
			start = source.start();
		} catch {
			return undefined;
		}
		// 正常值无需特殊等待；失败但没有 last 时进入 no_value，有 last 时只等下一帧。
		if (start.kind === "value") return undefined;
		return start.last === undefined ? { kind: "no_value", source } : { kind: "failed" };
	}

	/**
	 * Follows `source`, failed with no value, until its first good value (`true`), or until it or the owner ends
	 * (`false`): a subscriber of its own, since a watch has nothing to start at.
	 */
	// 以普通订阅者身份等待首个好值。返回 true 表示拿到值，false 表示源结束或 owner 取消。
	// 因 watch 无法从“失败且无 last”起步，这里绕过 watch 直接订阅 Source。
	#firstValue(source: Source): Promise<boolean> {
		const signal = this.#owner.context.abortSignal;
		return new Promise((resolve) => {
			// done 统一清理订阅与取消监听，且只 resolve 一次（Promise 保证后续 resolve 无效）。
			const done = (got: boolean): void => {
				source.unsubscribe(subscriber);
				signal?.removeEventListener("abort", aborted);
				resolve(got);
			};
			const subscriber = {
				advance: (call: WatchCall<JsonValue>) => {
					// 只认 value 帧；失败帧不结束等待，因为下一个值仍可能出现。
					if (call.kind === "value") done(true);
				},
				// 源结束或投递后结束都表示不会再有好值。
				end: () => done(false),
				endAfterDelivery: () => done(false),
			};
			const aborted = (): void => done(false);
			// { once: true } 让监听在取消后自动移除；done 里再删一次也无害。
			signal?.addEventListener("abort", aborted, { once: true });
			// 监听安装前信号可能已经取消；先检查再订阅，避免错过取消。
			if (signal?.aborted) aborted();
			else source.subscribe(subscriber);
		});
	}

	/**
	 * The source failed: what was pending goes (a value a failure followed is stale), a pending retry or settle is
	 * dropped, and the next call waits for the next value, as a whole value; a running call runs on.
	 */
	// 处理源的失败帧：丢弃陈旧 pending/ops，停止退避与 settle，等待下一个值；正在执行的调用不被中断。
	#failure(): void {
		const state = this.#state;
		// 已结束后任何帧都忽略。
		if (state.kind === "ended") return;
		this.#failed = true;
		// 失败使此前未消费的值失效（其后可能已有更新值）。
		this.#pending = undefined;
		// take 清空累积 ops，避免把失败前的增量应用到失败后的值。
		this.#ops.take();
		this.#basis = "none";
		// 定时器只在 settling/backoff 状态存在；清掉并回到 idle。
		if (state.kind === "backoff" || state.kind === "settling") {
			clearTimeout(state.timer);
			this.#state = { kind: "idle" };
		}
	}

	/**
	 * A frame of the watch: kept as the newest; it is called at once when nothing runs or waits, during a backoff too
	 * (the backoff ends); while a call runs or settles it waits for the next call.
	 */
	// 接收一个 value 帧：保存最新值、折叠 ops，并在空闲/退避时立即安排下一次调用。
	// 正在调用（calling）或等待宏任务（settling）时只保存，等当前流程结束后再取。
	#frame(call: WatchValueCall<unknown> | NativeWatchValueCall<unknown>): void {
		const state = this.#state;
		if (state.kind === "ended") return;
		// 新值到达说明源已恢复；后续退避不再等待失败解除。
		this.#failed = false;
		this.#pending = { value: call.value };
		if (!this.#native) {
			// A JSON watch's call, as its class decided.
			// as 断言把宽联合收窄为带 ops 的 JSON 帧；#native 已由 watch 类别确定。
			const { ops, retired } = call as WatchValueCall<unknown>;
			this.#ops.push(ops);
			if (retired) this.#retired = true;
		}
		// 退避期间收到新值：取消计时器，立即调用，避免旧退避再触发一次。
		if (state.kind === "backoff") clearTimeout(state.timer);
		if (state.kind === "backoff" || state.kind === "idle") this.#next();
	}

	/** Makes the next call from the pending frame, if there is one and the owner still runs; otherwise idles. */
	// 从 pending 发起一次串行调用，无返回值；没有帧或 owner 已取消时回到 idle。
	// 进入 calling 前清空 pending 并记录 #last，保证调用期间的新帧折叠成下一次。
	#next(): void {
		const pending = this.#pending;
		if (pending === undefined || this.#aborted()) {
			this.#state = { kind: "idle" };
			return;
		}
		this.#pending = undefined;
		const { value } = pending;
		this.#state = { kind: "calling" };
		this.#last = value;
		// call 永不拒绝；then 只负责状态迁移 #called。
		void call(this.#owner, this.#invocation(value)).then((called) => this.#called(called));
	}

	/**
	 * The handler's call with `value`: a native one with the value alone, a JSON one with the folded ops or the whole
	 * value, and whether a retirement came since the last call.
	 */
	// 构造实际交给 handler 的调用闭包。返回 (ctx) => void；闭包在调用发生时才读取/清空 ops 与 retired。
	#invocation(value: unknown): (ctx: Ctx) => void | Promise<void> {
		const { fn } = this.#declaration;
		// The overloads typed `fn` for its source's kind, which the watch decided.
		// 断言把存储的宽签名恢复成具体 handler；这是编译期转换，运行时不检查。
		if (this.#native) return (ctx) => (fn as OnNativeHandler<unknown>)({ kind: "value", value }, ctx);
		const taken = this.#ops.take();
		// A JSON source's values are JSON.
		// basis=none 或累积操作退化为 replace 时发全量 r；否则发增量。`[["r", value]]` 是只读 Op 元组。
		const ops: readonly Op[] =
			this.#basis === "none" || taken.kind === "replace" ? [["r", value as JsonValue]] : taken.ops;
		const retired = this.#retired;
		this.#retired = false;
		this.#lastRetired = retired;
		return (ctx) => (fn as OnHandler<unknown>)({ kind: "value", value, ops, retired }, ctx);
	}

	/**
	 * A call settled. After a success the next frame's ops build on it, and changes that arrived during the call are
	 * called after one macrotask (`settling`). After a throw (reported) the backoff always starts, also when changes
	 * arrived during the call (a handler that changes its own source and throws would feed itself otherwise); its timer
	 * calls with the newest value, or the last call's, as a whole value.
	 */
	// 处理一次调用结果：成功则按是否有积压进入 idle/settling；失败则报告、重置基线并进入 backoff。
	// 正在结束时忽略结果；owner 已取消时不再报告或安排重试。
	#called(called: Called): void {
		if (this.#state.kind === "ended") return;
		if (called.kind === "done") {
			// 成功后下一次增量可以基于本次值累积。
			this.#basis = "last";
			// 一次成功运行清除之前的退避长度。
			this.#delay = undefined;
			// 无积压直接空闲；有积压先进入 settling，用 0ms 宏任务让 watch 缓冲的帧全部到达。
			if (this.#pending === undefined) this.#state = { kind: "idle" };
			else this.#state = { kind: "settling", timer: setTimeout(() => this.#next(), 0) };
			return;
		}
		// 失败但 owner 已结束：取消不是需要报告的错误。
		if (this.#aborted()) return;
		failed(this.#owner, this.#declaration.at, called.error);
		// handler 可能没有应用此前帧，下一次必须发全量值。
		this.#basis = "none";
		// The handler may not have applied the retirement either.
		// 失败调用带过 retired 时，重试仍要告诉 handler，避免它漏掉退休信息。
		if (this.#lastRetired) this.#retired = true;
		// 指数退避；undefined 是首次失败，nextDelay 给出 1 秒。
		this.#delay = nextDelay(this.#delay);
		// The source failed meanwhile: the retry waits for its next value, never the stale last one.
		if (this.#failed) {
			this.#state = { kind: "idle" };
			return;
		}
		const timer = setTimeout(() => {
			// ??= 只在 pending 仍为空时填入最后值；退避期间收到的新值优先。
			this.#pending ??= { value: this.#last };
			this.#next();
		}, this.#delay);
		// 保存计时器句柄，供新帧或结束取消。
		this.#state = { kind: "backoff", timer };
	}

	/** The watch ended: the owner ended (aborted), or the source ended (no report) or failed (reported once). */
	// 处理 watch 结束：清理计时器与积压，进入永久 ended；只有源失败且 owner 未取消时才报告。
	#end(end: WatchEnd): void {
		const state = this.#state;
		this.#state = { kind: "ended" };
		// settling/backoff 仍有未触发的计时器，必须清除，否则它会在此后调用 #next。
		if (state.kind === "settling" || state.kind === "backoff") clearTimeout(state.timer);
		this.#pending = undefined;
		this.#ops.take();
		this.#retired = false;
		// owner 结束导致的 watch 结束不是源错误；只有 failed 帧需要报告。
		if (end.kind === "failed" && !this.#aborted()) failed(this.#owner, this.#declaration.at, end.error);
	}

	#aborted(): boolean {
		// 可选链加严格比较：没有信号视为未取消，只有明确的 true 才取消。
		return this.#owner.context.abortSignal?.aborted === true;
	}
}
