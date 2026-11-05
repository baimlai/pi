// One run of a job (§15, slice 6b §4.1): its record (id, version, key, args, phase, restarts, finish failures, abort
// mark, outcome), its current invocation (the fence of its seal token, its abort signal, the end an abort joins: one
// per invocation, as a persisted run is invoked again after a seal, R3), its `running` entry and the `Run` handle its
// callers wait on.

// 文件导读（单次运行的状态机与等待句柄）
// 所属：packages/chord/src/jobs，Chord v2 作业模块的运行对象层。
// 职责边界：定义一次运行在内存中的数据（JobRun）、调用方持有的句柄（Run）、每次 run 调用（Invocation）以及等待机制；
// 不直接写 store、不决定持久化时机、不构造 running 条目（entryFor 只做投影，登记由 records.ts 完成）。
// 上游入口：records.ts 创建/加载 JobRun 并推进 phase/restarts/outcome；job.ts 在调用 run 前 begin() 出新 Invocation。
// 下游依赖：documents 的 SealToken（提交围栏）、context 的 Context/AbortSignal、definition 的 Outcome。
// 结果流向：Run.outcome() 的 Promise 由 Waiters 结算；错误流向：阻塞的运行继续等待，被丢弃/对象结束的运行以
// ChordError 拒绝；运行自身的业务失败则封装在 Outcome.kind === "failed" 里正常解析。
// 能力清单：
// - Run：调用方持有的公开句柄（id 与 outcome(context)）。
// - AnyOutcome：擦除具体类型后的内部结果类型。
// - Phase：运行记录相位（pending/running/stopped/finishing/blocked）。
// - BlockedReason：冻结原因（finish_failed/version）。
// - Answer：等待者的内部结算值（done 带 outcome，failed 带 ChordError）。
// - Waiter / Waiters：一次/一组对 outcome 的等待，context 取消只结束该等待。
// - JobRun：一次运行的完整内存记录（身份、args、phase、计数、当前 invocation、entry、outcome、waiters）。
// - Invocation：一次 run 执行的围栏、abort 信号与结束等待（Joins）。
// - answer / Joins：把内部结算值转成 Promise，以及等待 invocation 结束的工具。
// 组合关系/典型顺序：records 创建 JobRun -> start 返回 run.handle -> 调用方 await outcome -> job.ts begin() ->
// run 执行期间 ctx 捕获 Invocation -> 结束/结算时 records 调 resolve/reject 或 Invocation.ended()。
// 示例（真实签名）：
//   const run: Run<Outcome<Args, number, undefined>> = handle.start({ n: 1 }, ctx);
//   const outcome = await run.outcome(ctx); // done -> { kind:"done", result }；失败 -> { kind:"failed", error }
// 建议阅读顺序：Run/AnyOutcome -> Phase/BlockedReason -> JobRun 字段 -> entryFor/begin/over -> Invocation ->
// Waiters/Joins（等待与取消细节）。
// 生命周期要点：一次运行可以经历多个 Invocation（持久化运行被切断后重新调用），但 JobRun 身份 id 不变；
// 每个 Invocation 有独立 SealToken 与 AbortController，旧的调用不能代表新的调用做决定。
import type { Context } from "../context/index.ts";
import type { ChordError } from "../data/index.ts";
import { SealToken } from "../documents/internal.ts";
import type { JsonValue } from "../json.ts";
import type { Outcome } from "./definition.ts";

/** A started run as its caller holds it: its id and a wait for its outcome. */
// 泛型 O 是 outcome 的解析类型（实际为 Outcome<...>）；接口只暴露 id 与 outcome，调用方拿不到内部记录。
// 例：const run = handle.start(args, ctx); const outcome = await run.outcome(ctx);
export interface Run<O> {
	readonly id: string;
	/**
	 * Resolves with the outcome once `finish` committed (also without a `finish`); a blocked run keeps waiting, a dropped
	 * one rejects `aborted`, the object's end rejects with its error; `context` ends only this wait, which then keeps
	 * nothing of it. A rejection's error keeps its stack's receivers (the transaction that ended the run) until its
	 * `stack` is read (V8).
	 */
	// 关键语义：context 被取消只影响“这一次等待”，不会取消运行本身；同一个 run 可以被多次等待。
	// 阻塞（blocked）的运行不会在这里报错，而是一直等：它可能因为 reload/retryBlocked 恢复。
	outcome(context: Context): Promise<O>;
}

/** A run's outcome, as Chord keeps it whatever the job's types. */
// 内部统一用 JsonValue/unknown 擦除具体类型，避免 records.ts 对每个作业泛型化；
// 精度由公开的 Outcome<A,R,S> 在句柄层恢复。`state` 可为 undefined（作业没有状态文档）。
export type AnyOutcome = Outcome<JsonValue, unknown, JsonValue | undefined>;

/**
 * Where a run's record stands. A persisted run is `pending` from its start's commit until its reservation commit
 * (`running`, then its `run` starts), `stopped` once a clean stop cut it off; an in-memory run is `running` from its
 * start's commit. `finishing` once its outcome is recorded, `blocked` after five failed finishes or for another
 * version.
 */
// Phase 是运行记录的状态，不等同于“run 函数是否在跑”：finishing 表示已记下结果、正在执行 finish 收尾。
// 状态迁移由 records.ts 控制；非法迁移在那里按内部错误处理，本文件不校验。
export type Phase = "pending" | "running" | "stopped" | "finishing" | "blocked";

/**
 * Why a run is blocked: its `finish` failed five times in a row, or its version is not the code's (stored by another
 * job version or fingerprint, of a newer version or an older one without an adapter, or of a job the code no longer
 * declares, slice 7b §8).
 */
// 两种原因对应两种恢复方式：finish_failed 等人工/重载后重试；version 等新代码声明或 accepts 映射出现。
export type BlockedReason = "finish_failed" | "version";

/** How a run settled for its waiters. */
// 内部两种结果：done 带完整 outcome；failed 带 ChordError（例如对象结束、运行被丢弃）。
// 与 Outcome.failed 不同：Outcome 的失败是 run/finish 的业务失败，而这里的 failed 是“等待本身无法得到 outcome”。
type Answer =
	| { readonly kind: "done"; readonly outcome: AnyOutcome }
	| { readonly kind: "failed"; readonly error: ChordError };

/** One wait for a run's outcome, removed when its context aborts. */
// 只存一个 settle 回调；Waiter 由 Waiters.wait 创建并放进 Set。
type Waiter = { readonly settle: (settled: Answer) => void };

/** One run: changed only by its job, inside its transactions' commit steps (records) and after them (actions). */
// JobRun 是运行记录的内存形态，字段大多数是 public 可写：records.ts 与 job.ts 需要直接推进状态机。
// “只由作业自己改”是内部约定，不靠 readonly 强制；跨对象没有共享这个对象。
export class JobRun {
	readonly id: string;
	/** The job version it was started with: it keeps it across reloads (slice 7b §8). */
	// id 与 version 一起构成持久化记录的键与解释依据；运行进行中代码升级不会改变它。
	readonly version: number;
	/** The fingerprint of its job version (a persisted run's record keeps it). */
	// 指纹用于区分“同版本号但 schema 变了”；旧运行据此决定是否需要 accepts 映射或阻塞。
	readonly fingerprint: string;
	// key 是 start 的去重键（可选）；args 是启动时已通过 schema 校验的 JSON 快照。
	readonly key: string | undefined;
	readonly args: JsonValue;
	// handle 是暴露给调用方的稳定对象；它只引用 Waiters，不引用整个 JobRun，避免调用方持有运行内部状态。
	readonly handle: Run<AnyOutcome>;
	/** Its args and outcome mapped forwards to the job's current version (once per run and version), when older. */
	// mapped 缓存向后兼容映射的结果；version 记录映射到的目标版本，避免同一版本重复映射。
	// outcome 可选：未结算时只需要映射 args（用于 running 展示）。
	mapped: { readonly version: number; readonly args: JsonValue; outcome?: AnyOutcome } | undefined;
	/** A persisted run blocked for its version at its load: the phase its record had, resumed when unblocked. */
	// 加载时发现版本不匹配会先冻结，但保留原 phase；恢复（新代码或 accepts 出现）时回到这个 phase。
	blockedPhase: Phase | undefined;
	/** Its current invocation, from its reservation (or its start in memory) on; a later one replaces it. */
	// 旧 Invocation 被替换后仍可能在自己的异步回调里结束，但它的 token 已被 fence，不能代表新调用。
	invocation: Invocation | undefined;
	phase: Phase;
	/** A persisted run's crashes in a row while running (D6); reset by a state change. */
	// restarts 只统计“运行中被切断”的次数；ctx.state.change 表示有进展，会把计数清零。
	restarts = 0;
	/** Failed finishes in a row (stored for a persisted run, so they count across a crash). */
	// 连续 finish 失败达到 5 次即 blocked；成功一次或换版本会重置。
	finishFailures = 0;
	/** Set by `abort(id)` (stored for a persisted run, D7): a run not invoked yet ends `aborted` without `run`. */
	// 标记而不是直接取消：如果 run 还没开始，就不必调用它，直接以 aborted 结算。
	abortMarked = false;
	/** A persisted run cut off by a crash or a clean stop, to be resumed per its job's `resume` (no new start). */
	// resuming 表示这次运行来自恢复而不是调用者 start；它决定是否消耗并发名额、如何报告等。
	resuming = false;
	blocked: BlockedReason | undefined;
	/** The start's trace carrier, when the adapter propagates (stored, slice 9 uses it). */
	// trace 是字符串键值对（W3C traceparent 等），持久化后仍可继续调用链。
	readonly trace: { readonly [key: string]: string } | undefined;
	/** What it ended with, once recorded (finishing and blocked). */
	// outcome 记录后运行不再改变结果；finish 可能失败并重试，但 outcome 本身保持不变。
	outcome: AnyOutcome | undefined;
	/** Its entry in `running`, while its record exists; replaced when its record or state document changes. */
	// 保存当前 entry 的引用，便于后续 replace/remove 通过身份找到它（running 列表内部用 indexOf）。
	entry: JsonValue | undefined;
	/** Its waiters: apart from the run, so a handle kept by a caller keeps only how the run settled. */
	// #waiters 是私有字段（ECMAScript private field），外部无法访问；handle 闭包捕获它，而不是捕获 this。
	readonly #waiters = new Waiters();

	constructor(
		id: string,
		version: number,
		fingerprint: string,
		key: string | undefined,
		args: JsonValue,
		phase: Phase,
		trace?: { readonly [key: string]: string },
	) {
		// 构造只保存身份与初始 phase，不创建 timer、不注册到任何表；登记由 records.ts 完成。
		this.id = id;
		this.version = version;
		this.fingerprint = fingerprint;
		this.key = key;
		this.args = args;
		this.phase = phase;
		this.trace = trace;
		// 先取私有字段到局部变量：箭头函数捕获的是 Waiters 对象本身，而不是 this。
		// 这样即使调用方只保留 handle，JobRun 的其他字段可以被回收（等待结果只需要 Waiters）。
		const waiters = this.#waiters;
		// handle 是普通对象；outcome 每次调用都新建一个等待，可被多个调用方、多个 context 同时等待。
		this.handle = { id, outcome: (context) => waiters.wait(context) };
	}

	/**
	 * Its `running` entry for its current record, `state` (the job's state document, `undefined` without one) and
	 * `args` (mapped forwards for an older version): a pending or stopped run shows as `running` (it runs, or will run
	 * again).
	 */
	// 把内部相位投影成公开的 running 条目：pending/stopped 对外都显示 running，因为调用方关心“它还会跑”。
	// blocked 条目只带原因，不带 args/state（可能来自旧版本代码无法解释的数据）。
	// 例：{ id:"r1", version:1, args:{n:2}, phase:"pending" } 会投影成 phase:"running" 的条目。
	entryFor(state: JsonValue | undefined, args: JsonValue): JsonValue {
		const { id, version, key, phase } = this;
		// blocked 分支使用 `this.blocked!`：非空断言告诉 TS “blocked 为 undefined 时不会进入该 phase”。
		// 运行期没有检查；records.ts 在把 phase 设为 blocked 时保证同时设置 blocked。
		if (phase === "blocked") return { id, version, phase, reason: this.blocked! };
		return {
			id,
			version,
			// 可选键只在存在时展开，避免出现 key: undefined（JSON 化会丢键，但内存比较会看到差异）。
			...(key === undefined ? {} : { key }),
			args,
			...(state === undefined ? {} : { state }),
			// 只有 finishing 保留收尾阶段；其余（pending/running/stopped）都显示 running。
			phase: phase === "finishing" ? "finishing" : "running",
		};
	}

	/** A new invocation, the current one from now on (a run marked aborted is never invoked: it ends without one). */
	// 输入无；输出新 Invocation，并把它设为 this.invocation。旧对象不被修改，只是不再是“当前”。
	// 每个 Invocation 自带 token/abort，使被替换的调用无法影响后继调用。
	begin(): Invocation {
		const invocation = new Invocation();
		this.invocation = invocation;
		return invocation;
	}

	/** Whether its current invocation runs (or is reserved): it is not invoked again meanwhile. */
	// 用可选链避免没有 invocation 的分支；只有 state === "running" 才算占用。
	get invoked(): boolean {
		return this.invocation?.state === "running";
	}

	/**
	 * Resolves once its current invocation ended, at once when none runs (`abort` joins it; one a seal cut off is
	 * fenced and is not waited for); `context` ends only the wait.
	 */
	// 若没有正在运行的 invocation，直接 resolve；否则等待它的 Joins。
	// 注意：返回 Promise<void> 而不是 outcome，调用方要结果仍需 outcome()。
	over(context: Context): Promise<void> {
		const invocation = this.invocation;
		return invocation?.state === "running" ? invocation.over(context) : Promise.resolve();
	}

	/** Its waiters get the outcome. */
	// 结算只发生一次：Waiters.settle 内部忽略重复调用。
	resolve(outcome: AnyOutcome): void {
		this.#waiters.settle({ kind: "done", outcome });
	}

	/** Its waiters get `error`. */
	// 例如对象在运行结束前被销毁，records.ts 会用 released/ended 调用这里。
	reject(error: ChordError): void {
		this.#waiters.settle({ kind: "failed", error });
	}
}

/**
 * One invocation of a run's `run`: its fence (`ctx.state.change` admitted while it runs, under its own seal token,
 * which its attempt's seal fences), its abort signal and the waits for its end. Captured by its ctx and its settling,
 * so a replaced invocation never acts for its successor.
 */
// 一次调用 = 一次 run 函数执行。它不与 JobRun 同寿：持久化运行被切断后会创建新的 Invocation。
// token 用于文档提交围栏（seal 后拒绝写入）；abort 用于取消 run 里的异步工作；#joins 让 abort 等待 run 真正结束。
export class Invocation {
	// SealToken 是 Chord 文档层的围栏对象：attempt 被切开时它被 seal，之后基于它的变更都被拒绝。
	readonly token = new SealToken();
	/** `run`'s abort signal: `abort(id)`, the attempt's seal, the object's end and `host.close` fire it. */
	// AbortController 本身不是 signal；ctx 里传递的是 invocation.abort.signal。
	readonly abort = new AbortController();
	/** `running` from its reservation until `run` settled or a seal cut it off. */
	// 只有 running 的 invocation 才占用运行名额/阻止再次调用；settled 后旧对象不再有作用。
	state: "running" | "settled" = "running";
	readonly #joins = new Joins();

	/** The fence closes: a change made later is refused. */
	// 只改状态，不触发 abort；关闭 token 由调用方（job.ts/attempt seal）另行处理。
	settle(): void {
		this.state = "settled";
	}

	/** Nothing of it runs here any more (its `run` settled, or the object ended): every join resolves. */
	// 注意这里只唤醒等待者，不修改 state；state 由 settle() 负责，两者分开是因为“结束”可能来自不同路径。
	ended(): void {
		this.#joins.end();
	}

	/** Resolves once it ended; `context` ends only the wait. */
	// 例：await invocation.over(ctx) 等 run 结束；ctx 取消只让这次等待拒绝，不影响运行。
	over(context: Context): Promise<void> {
		return this.#joins.wait(context);
	}
}

/** A run's waits for its outcome: each removed when its context aborts; late ones answered at once. */
// 等待者集合按“等待”而不是按调用方组织：同一 Run 可以被多次 outcome()，每个有自己的 context。
// 结算后等待者全部清空，之后新的等待直接得到已存结果。
class Waiters {
	/** How the run settled, once it did. */
	#settled: Answer | undefined;
	readonly #waiting = new Set<Waiter>();

	/** The run settled (once): every wait gets it. */
	// 幂等：第二次 settle 直接返回，保证结果不会被覆盖。
	settle(settled: Answer): void {
		if (this.#settled !== undefined) return;
		this.#settled = settled;
		// 遍历期间 waiter.settle 不会修改 #waiting（它只移除 abort 监听），因此可以安全迭代后再 clear。
		for (const waiter of this.#waiting) waiter.settle(settled);
		this.#waiting.clear();
	}

	/** A wait for the outcome: at once once settled; otherwise until it settles or `context` aborts. */
	// 三种路径：已结算 -> answer；context 已取消 -> 立即以原因拒绝；否则登记并在 settle/abort 时完成。
	wait(context: Context): Promise<AnyOutcome> {
		const settled = this.#settled;
		if (settled !== undefined) return answer(settled);
		const signal = context.abortSignal;
		// 可选链 signal?.aborted：没有 abortSignal 时视为未取消。
		if (signal?.aborted) return Promise.reject(signal.reason);
		// Promise.withResolvers（ES2024）把 resolve/reject 与 promise 一起取出，省去外层 new Promise 的样板。
		const { promise, resolve, reject } = Promise.withResolvers<AnyOutcome>();
		// abort 闭包在 context 取消时移除自己并拒绝这次等待；signal 可能为 undefined，所以拒绝值也用可选链。
		const abort = (): void => {
			this.#waiting.delete(waiter);
			reject(signal?.reason);
		};
		// waiter 引用闭包变量 waiter 自身（声明提升），在 settle 时移除 abort 监听，避免监听器泄漏。
		const waiter: Waiter = {
			settle: (each) => {
				signal?.removeEventListener("abort", abort);
				if (each.kind === "done") resolve(each.outcome);
				else reject(each.error);
			},
		};
		this.#waiting.add(waiter);
		// once: true 让监听器触发一次后自动移除；未触发时由 settle 手动移除。
		signal?.addEventListener("abort", abort, { once: true });
		return promise;
	}
}

/** A settled run's answer to a wait. */
// 把内部 Answer 转成调用方看到的 Promise：done 解析为 outcome，failed 拒绝为 ChordError。
function answer(settled: Answer): Promise<AnyOutcome> {
	return settled.kind === "done" ? Promise.resolve(settled.outcome) : Promise.reject(settled.error);
}

/** The waits for a run's invocation to be over: each removed when its context aborts, so a cancelled one keeps nothing. */
// 与 Waiters 结构相似，但只传递“结束”信号（void），不携带结果。abort 等待它，是为了确保 run 已停止后再做后续动作。
class Joins {
	#over = false;
	// 只存 resolve 回调：每个等待都返回 void，没有失败结果（取消走 context 的 reject）。
	readonly #waiting = new Set<() => void>();

	/** The invocation is over (once): every wait resolves. */
	// 幂等：重复 end 不会重复 resolve。
	end(): void {
		if (this.#over) return;
		this.#over = true;
		for (const resolve of this.#waiting) resolve();
		this.#waiting.clear();
	}

	/** A wait: at once when over; otherwise until it is or `context` aborts (rejecting with its reason). */
	wait(context: Context): Promise<void> {
		if (this.#over) return Promise.resolve();
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		// abort 从等待集合里移除 done（而不是 abort 自身），因为集合存的是完成回调。
		const abort = (): void => {
			this.#waiting.delete(done);
			reject(signal?.reason);
		};
		const done = (): void => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		this.#waiting.add(done);
		signal?.addEventListener("abort", abort, { once: true });
		return promise;
	}
}
