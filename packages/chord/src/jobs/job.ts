// Jobs (§15), in memory: the handle `self.job` returns, one per attempt, over the job's records on its object. It
// holds the implementation and the invocations: `run` runs outside transactions, `finish` in one with the cleanup,
// both on the attempt that is live; the attempt's seal cuts its invocations off (slice 6a §1.3).

// 文件导读（单次声明的作业句柄）
// 所属：packages/chord/src/jobs，Chord v2 作业模块的句柄/执行层（slice 6a §1.3、§15）。
// 职责边界：`self.job(Job, implementation)` 的返回值与内部执行器。它持有某次 attempt 的实现、该 attempt 上
// 正在跑的 invocation 和收尾；不保存运行列表本身（records.ts 持有），也不直接写 store。
// 上游入口：host/attempt.ts 在对象尝试里构造 Job；Transaction.start/tx.start 通过 Job.stage 把启动夹进事务；
// Attempt.seal 调用 Job.seal；reload 的 swap 调用 Job.handOver。
// 下游依赖：JobRecords（记录、去重、并发、持久化）、RunStates（ctx.state）、Documents/Transaction（事务与围栏）、
// CallContext（ctx.get 的引用生命周期）、host 的 sleep/nextDelay（finish 退避）。
// 结果与错误流向：start 返回 Run 句柄（Promise 在事务提交后解析）；参数/并发/状态错误以 ChordError 抛出；
// run 的抛错经 #failed 转成 Settled（ChordError/PluginError 保留，其他包成 PluginError internal）并上报；
// finish 失败重试 5 次后 block；attempt seal 时运行被 cut（内存运行以 aborted/restart|reload 结算，持久化运行写 stopped）。
// 能力清单：
// - JobHandle：公开句柄接口（start/outcome/abort/running）。
// - StartOptions：start/tx.start 的选项（key 去重）。
// - JobImplementation：插件实现（run 必需，finish 可选）。
// - JobCtx：run/finish 的上下文（Ctx + jobId + 可选 state）。
// - RunState：状态文档的 value/change 接口。
// - JobOwner：Attempt 向 Job 提供的依赖集合（host/caller/context/signal/token/documents/admit/admitRun）。
// - CutReason：seal 切断运行的原因（restart/reload）。
// - AnyJobImplementation：擦除泛型后的内部实现类型。
// - FINISH_ATTEMPTS：finish 连续失败达到 5 次即 block 的常量。
// - Job：核心类，实现 JobHandle，并含 load/writeAtClose/live/stage/seal/handOver/invoke/finish 等内部方法。
// - IMMEDIATE / checkedPersistence：默认立即持久化常量与插件传入 persistence 的运行期校验。
// - internal：把普通抛出值包装成 PluginError(internal)。
// - JobContext：CallContext 子类，额外携带 jobId 与 state。
// 组合关系/典型顺序：Attempt 创建 JobRecords 与 Job -> live() 后 attach -> 插件 start -> Transaction 提交 ->
// records 在 create 提交后 queueMicrotask 调 Job.invoke -> run 执行 -> records.settled 记录 outcome -> Job.finish 执行收尾。
// 示例（真实签名）：
//   const handle = self.job(Summarize, { run: async (args, ctx) => args.text.length });
//   const run = await handle.start({ text: "hi" }, ctx);      // Run<Outcome<{text:string}, number, undefined>>
//   const outcome = await run.outcome(ctx);                    // { kind:"done", result:2, ... }
// 建议阅读顺序：JobHandle/StartOptions -> JobImplementation/JobCtx/RunState -> JobOwner/CutReason -> Job 字段与
// start/stage/seal/handOver -> invoke/#start/#settled -> finish/#finish -> #stateOf -> checkedPersistence/JobContext。
// in-memory 语义：`run` 在事务之外执行，`finish` 在一个带清理的事务里执行，二者都绑定在当前 live 的 attempt 上；
// attempt 的 seal 会切断它的 invocation。持久化语义由 records.ts/run-states.ts 补齐。
import { type Context, withAbortSignal, withoutAbortSignal } from "../context/index.ts";
import { ChordError, isChordError, PluginError, type Principal } from "../data/index.ts";
import type { Draft } from "../delta/index.ts";
import type { CommitPersistence, JsonObject, Tx } from "../documents/index.ts";
import type { Documents, SealToken, Transaction } from "../documents/internal.ts";
import { type Ctx, sleep } from "../host/index.ts";
import { type AnyHost, CallContext, type Caller, nextDelay } from "../host/internal.ts";
import type { JsonValue } from "../json.ts";
import type { Watchable } from "../watch.ts";
import type { JobDefinition, Outcome } from "./definition.ts";
import type { JobRecords, Settled } from "./records.ts";
import type { AnyOutcome, Invocation, JobRun, Run } from "./run.ts";
import type { RunningEntry } from "./running.ts";

/** A job's handle, `self.job(Job, { run, finish? })`; `A`, `R` and `S` are its args, result and state. */
// 这是插件实际拿到的对象。三个类型参数来自 JobDefinition 的 ~types，因此 start/outcome 的输入输出有精确类型。
// 句柄属于一次 attempt：attempt 被替换/切开后，旧句柄的 start 会被拒绝（released/ended），但已启动的运行可能继续。
export interface JobHandle<A, R, S> {
	/**
	 * Starts a run in one transaction on the object's line and resolves with its `Run` after the commit: the args
	 * checked (`invalid/args`); a `key` of an unsettled run returns that run; at the `concurrency` limit (running plus
	 * finishing runs) it rejects `unavailable/busy`. `run` starts after the commit.
	 */
	// 返回 Promise<Run> 而不是 Run：启动本身是事务，必须等提交成功才能把句柄交给调用方。
	// 注意去重发生在事务内：同一 key 的未结算运行直接返回旧句柄，不创建新记录。
	start(args: A, context: Context, options?: StartOptions): Promise<Run<Outcome<A, R, S>>>;
	/** Waits for the outcome of the unsettled run `id`; a settled or unknown id rejects `gone`. */
	// 与 Run.outcome 的区别：这是按 id 查询，适合从 running 列表拿到 id 后再等待；已结算的记录已删除，故 gone。
	outcome(id: string, context: Context): Promise<Outcome<A, R, S>>;
	/**
	 * Aborts run `id` (D7, as Durable's `abortTask`): marks it (stored for a persisted job) and fires its `run`'s
	 * signal, resolving `"marked"` once its `run` settled (a run not invoked yet ends `aborted` without one); a
	 * finishing run is only marked, a blocked one dropped (no `finish`; its waiters reject `aborted`). `"terminal"` when
	 * no unsettled run has that id. `context` ends only this wait.
	 */
	// 返回字面量联合 "marked" | "terminal"，调用方可据此区分“确实处理了”和“已经没有这个运行”。
	// 运行期是 async：会等标记提交、abort 信号发出，并 join 当前 invocation 结束。
	abort(id: string, context: Context): Promise<"marked" | "terminal">;
	/** The unsettled runs, one entry each in start order, tagged by phase (a JSON watchable, a state member). */
	// 这是 Watchable 而不是快照数组：内部由 Running 维护，变化按批次发布增量。
	readonly running: Watchable<readonly RunningEntry<A, S>[]>;
}

/** What `start` and `tx.start` take besides the args. */
// 目前只有 key；它是去重键而不是运行 id（运行 id 由 uuidv7 生成）。key 不比较 args：同 key 直接复用未结算运行。
export type StartOptions = {
	/** Names one run: a start with the key of an unsettled run returns that run (args not compared). */
	readonly key?: string;
};

/** What `self.job` takes: the run and the optional finish. */
// P 是 principal 类型，默认 Principal；插件通常不需要显式写它。
// run 必须返回 Promise<R>；finish 在事务里执行，因此只能 `await tx.*`，不能调用其他对象或 self.tx。
export type JobImplementation<A, R, S, P extends Principal = Principal> = {
	/** The work, outside transactions; its ctx's abort signal fires on `abort(id)` and on its object's end. */
	// run 不在事务里执行，可以自由 await 外部 I/O；ctx.state.change 会自己开小事务。
	readonly run: (args: A, ctx: JobCtx<P, S>) => Promise<R>;
	/** Records the outcome in one transaction (only `await tx.*`); the run's record and state document go with it. */
	// finish 拿到完整 Outcome（id/args/state + done/failed）；它可以有副作用，但必须与运行记录的删除同一次提交。
	readonly finish?: (outcome: Outcome<A, R, S>, tx: Tx) => void | Promise<void>;
};

/** A run's ctx: a handler's ctx (the object's principal or the host's), its run's id and, with a state, the state. */
// 条件类型技巧与 RunningEntry 相同：`[S] extends [undefined]` 防止分配，S 为 undefined 时不加 state 字段。
// P extends Principal 让 ctx.principal 有具体类型；S 是状态文档的值类型。
// 例：JobCtx<Principal, {count:number}> 的 ctx.state 必填；JobCtx<Principal, undefined> 没有 state 属性。
export type JobCtx<P extends Principal, S> = Ctx<P> & { readonly jobId: string } & ([S] extends [undefined]
		? unknown
		: { readonly state: RunState<S> });

/** A run's state document. */
// 这个接口只暴露同步读 value 与异步事务写 change；文档的创建/退役由 records 管理，插件不能直接删除它。
export interface RunState<S> {
	/** The document's value. */
	// 读取的是内存 tracker 的当前值：在 run 内看到自己刚提交的 change；文档退役后读取抛 released/settled。
	readonly value: S;
	/**
	 * One transaction on the object's line drafting only this document, under `context` without its abort signal:
	 * admitted while `run` runs (also after an abort, with the run's own ctx), refused `released` once it settled. A
	 * persisted job's change may be `deferred` (D8): adopted and published at once, stored within `withinMs` (1,000 ms by
	 * default) or earlier; a crash loses it. In memory the option changes nothing.
	 */
	// fn 拿到 Draft<S>，返回任意 T；事务提交后 change 的 Promise 以 T 解析。
	// 关键点：change 会去掉 context 的 abort signal，因此运行被 abort 后仍可记录“已停止/已清理”的进展。
	change<T>(
		fn: (draft: Draft<S>) => T,
		context: Context,
		options?: { readonly persistence?: CommitPersistence },
	): Promise<T>;
}

/** Where a job's handle runs its work: its attempt, as the job sees it. */
// 这是 Attempt 与 Job 之间的窄接口，便于在测试里构造假宿主（不用完整 Attempt）。
export type JobOwner = {
	readonly host: AnyHost;
	/** Whom runs act for: the object's principal (remote) or the host's (local), from this host. */
	// caller 决定 ctx.principal/incarnation；本地对象使用 host 的 principal，远端调用使用链路传来的 principal。
	readonly caller: Caller;
	/** The object's context, without an abort signal: runs, state changes and finishes run under it. */
	// 注意这是对象级 context；每次 run 的取消信号由 Invocation 自己的 AbortController 叠加。
	readonly context: Context;
	/** Aborted when the attempt is sealed: a finish's backoff waits under it. */
	// 只用于 finish 重试的 sleep：attempt 被切开时立即停止退避，而不是继续等下一次重试。
	readonly signal: AbortSignal;
	/** The attempt's seal token: its starts and finishes are transactions under it. */
	// 文档提交的围栏：token 被 seal 后，基于它的新事务会被拒绝，保证旧 attempt 不会写入新 attempt 的状态。
	readonly token: SealToken;
	readonly documents: Documents;
	/**
	 * Adds running work (a finish, a reservation) to the attempt's calls drain; `cleanup` (its bookkeeping) runs once,
	 * when it settles or when the attempt ends with it still running.
	 */
	// drain 是对象尝试关闭前的“等待所有在途工作”机制；admit 让 Job 的异步工作被计入。
	admit(running: Promise<unknown>, cleanup?: () => void): void;
	/** Adds a run's invocation to the attempt's drain at its end (a swap does not wait for it), as `admit`. */
	// admitRun 与 admit 的差别在 reload swap：旧 invocation 可以继续跑，但不阻塞新 attempt 的切换。
	admitRun(running: Promise<unknown>, cleanup: () => void): void;
};

/**
 * Why a seal cuts a running in-memory run off: `restart` (its attempt ended while the object continues) or `reload`
 * (a native restart, slice 7b §8); its outcome is `failed { aborted }` with that reason.
 */
// restart 与 reload 都会把内存运行结算为 aborted；区别写进 Outcome，供 finish/调用方判断原因。
export type CutReason = "restart" | "reload";

/** A job's implementation as Chord calls it, whatever the job's types. */
// 内部表（JobRecords/Job）用擦除类型存放不同作业的实现；具体类型只在 JobHandle 的泛型层恢复。
export type AnyJobImplementation = {
	readonly run: (args: JsonValue, ctx: JobContext) => Promise<unknown>;
	readonly finish?: (outcome: AnyOutcome, tx: Tx) => void | Promise<void>;
};

/** Failed finishes in a row after which a run is blocked. */
// 常量而非配置：设计决定（D6 的 Durable 对应行为），不对外暴露选项。
const FINISH_ATTEMPTS = 5;

/**
 * A job as one attempt declares it: its implementation and the invocations and finishes running on the attempt. Starts
 * are taken while the attempt is live; the object's records keep the runs.
 */
// 每个对象尝试对每个作业名各有一个 Job；它与 JobRecords 是多对一：records 跨 attempt 长存，Job 随 attempt 更替。
// #state 是句柄的生命周期：declared（尝试尚未 live）-> live（可 start/执行）-> handed（reload 交接）-> sealed。
export class Job implements JobHandle<JsonValue, unknown, JsonValue | undefined> {
	readonly #records: JobRecords;
	/** The definition its attempt declared: its invocations get args in its version, whatever the records' is now. */
	// 注意与 records.definition 的区别：reload 后 records 会用新定义，而旧 Job 仍按自己声明时的版本解释 args。
	readonly #definition: JobDefinition<unknown, unknown, unknown>;
	readonly #implementation: AnyJobImplementation;
	readonly #owner: JobOwner;
	/**
	 * `declared` until the attempt is live (starts are refused), `handed` once a reload's swap gave its records to the
	 * new attempt's job (starts refused, its invocations finish here), `sealed` once it is sealed.
	 */
	#state: "declared" | "live" | "handed" | "sealed" = "declared";
	/** Runs whose `run` runs on this attempt. */
	// 只统计本 attempt 的 invocation；seal 时遍历它逐个 cut。
	readonly #invocations = new Set<JobRun>();
	/** The seal's error and cut reason, once sealed: a reservation committing after it cuts its run off with them. */
	// 保存 seal 的错误与原因，供“提交晚于 seal”的 reservation 回调使用（见 invoke 的 .then）。
	#sealed: { readonly error: ChordError; readonly reason: CutReason } | undefined;
	/** Runs whose finish runs on this attempt. */
	// finish 可能在 seal 后仍继续（交接场景），seal 时交给 records.detach 等待下一次 live attempt。
	readonly #finishing = new Set<JobRun>();

	constructor(records: JobRecords, implementation: AnyJobImplementation, owner: JobOwner) {
		this.#records = records;
		// Its attempt's declaration redefined the records just before (`ChordObject.jobRecords`).
		// 构造时 records.definition 已经是本次声明的版本；先快照到私有字段，之后 records 再被 redefine 也不影响本 Job。
		this.#definition = records.definition;
		this.#implementation = implementation;
		this.#owner = owner;
	}

	get running(): Watchable<readonly RunningEntry<JsonValue, JsonValue | undefined>[]> {
		// Its value is the list of entries `JobRun.entryFor` builds.
		// running 属于 records（跨 attempt 共享），不是本 Job 私有；这里只做类型断言，把内部擦除类型暴露成公开形状。
		return this.#records.running as unknown as Watchable<readonly RunningEntry<JsonValue, JsonValue | undefined>[]>;
	}

	async start(args: JsonValue, context: Context, options: StartOptions = {}): Promise<Run<AnyOutcome>> {
		const { documents, token } = this.#owner;
		// 启动被包进对象自己的事务：args 校验、去重、并发检查、记录/状态文档创建都在同一提交里。
		// documents.tx 返回 Promise<Run>，因此 start 也返回 Promise；默认选项是新的空对象（无去重键）。
		return documents.tx((tx) => this.stage(tx, args, context, options), token, context);
	}

	outcome(id: string, context: Context): Promise<AnyOutcome> {
		// 直接委托 records：运行记录跨 attempt 存在，句柄只提供入口。
		return this.#records.outcome(id, context);
	}

	abort(id: string, context: Context): Promise<"marked" | "terminal"> {
		return this.#records.abort(id, context);
	}

	/** A persisted job's runs, loaded once per object at its first activation (before it goes live). */
	// 内存作业是 no-op；持久化作业在第一次激活时恢复记录，失败会让激活失败。
	load(context: Context): Promise<void> {
		return this.#records.load(context);
	}

	/** The close writer of this job's runs, after the attempt's drain (slice 6b §4.2). */
	// 对象关闭时绕过常规事务，直接把 stopped 运行与 held 状态写入 store；内存作业 no-op。
	writeAtClose(context: Context): Promise<void> {
		return this.#records.writeAtClose(context);
	}

	/** The attempt went live: starts are taken, and the records' waiting runs are invoked or finished here. */
	// declared -> live；attach 会把等待中的运行立即分派给本 Job。重复调用是幂等的。
	live(): void {
		if (this.#state !== "declared") return;
		this.#state = "live";
		this.#records.attach(this);
	}

	/**
	 * Stages a run in `tx` (`start`, `tx.start`), in order: the args checked, dedupe by key (runs started earlier in
	 * `tx` included), the concurrency check, then the record and the state document, created in the commit. The run
	 * whose finish `tx` is counts for neither: `finish` may start the same job again, with the same key too. Returns
	 * the run's handle at once; a start that only dedupes stages nothing.
	 */
	// 输入 tx（调用方的事务）、原始 args（运行期未知类型）、context、options；输出 Run 句柄（提交后可用）。
	// 错误：跨对象启动抛普通 Error；sealed/handed 抛 released/ended；declared 抛 not_ready；
	// 参数/并发错误由 records.stage 抛 ChordError。副作用：可能暂存运行创建与状态文档创建。
	// 例：同一事务中 start 两次同 key，第二次直接返回第一次的句柄，不再写记录。
	stage(tx: Transaction, args: unknown, context: Context, options: StartOptions): Run<AnyOutcome> {
		// Declaration policy: a handle belongs to its object (types cannot say whose transaction this is).
		// 运行期检查句柄与事务属于同一对象，防止把 A 对象的作业塞进 B 对象的事务。
		if (tx.documents !== this.#owner.documents) {
			throw new Error(`${this.#owner.documents.label}: a transaction starts only its own object's jobs`);
		}
		// handed 与 sealed 都意味着本 attempt 不再接受新启动；已启动的运行由 records 继续管理。
		if (this.#state === "sealed" || this.#state === "handed") {
			throw new ChordError({
				code: "released",
				reason: "ended",
				message: `${this.#records.name}: its attempt ended`,
			});
		}
		// declared 表示对象尚未 live：允许声明，但不允许启动（提交可能发生在激活之前）。
		if (this.#state === "declared") {
			throw new ChordError({ code: "not_ready", message: `${this.#records.name}: its object is not live yet` });
		}
		return this.#records.stage(tx, args, context, options);
	}

	/**
	 * The attempt is sealed with `error`: starts are refused, running invocations are cut off (their signals fire, in
	 * memory they end `aborted` with `reason` and finish on the next live attempt, persisted ones are stopped and
	 * resumed, R3), and the runs finishing here wait for it.
	 */
	// 输入 seal 的错误与原因；输出 void。幂等：重复 seal 不再处理。
	// 副作用：detach 本 Job 的 finish 集合；非 handed 的 invocation 逐个交给 records.cut（发 abort、围栏 token、结算/停止）。
	// 例：对象重启时 seal(error, "restart")，内存运行得到 failed/aborted/restart。
	seal(error: ChordError, reason: CutReason): void {
		if (this.#state === "sealed") return;
		// handed 的 Job 在 reload 交接中：它的 invocation 仍在本代码上跑完，不能像普通 seal 那样立即切断。
		const handed = this.#state === "handed";
		this.#state = "sealed";
		this.#sealed = { error, reason };
		// finish 中（或排队等待 finish）的运行交给 records，等下一个 live attempt 继续收尾。
		this.#records.detach(this, this.#finishing);
		this.#finishing.clear();
		// A handed-over job's invocations finish on its code; their outcomes go to the new attempt's job.
		// 只有非 handed 的 invocation 被 cut：交接场景下旧代码的 run 自然结束，结果由新 Job 记录。
		if (!handed) for (const run of this.#invocations) this.#records.cut(run, error, reason);
		this.#invocations.clear();
	}

	/**
	 * A reload swapped its attempt out (slice 7b §8): starts are refused, the records go to the new attempt's job once it
	 * is live, the runs it invokes finish on this code (their outcome is finished by the new code), a finish running here
	 * completes here.
	 */
	// 只允许 live/declared 的 Job 交接；handed 后 start 被拒绝，但已在本代码上运行的 invocation 继续。
	// detach(this, [])：本 Job 不再负责等待中的运行，records 会在新 attempt attach 时分派它们。
	handOver(): void {
		if (this.#state !== "live" && this.#state !== "declared") return;
		this.#state = "handed";
		// Runs needing a live attempt meanwhile wait for the new one.
		this.#records.detach(this, []);
	}

	/**
	 * Runs `run` for a committed run (with its signal aborted already after an early abort); a persisted run's
	 * reservation commits first (`running`: a crash from then on counts, D6). The reservation, the invocation and the
	 * run's finish are one piece of work in the drain, admitted before plugin code runs: `run` may end its own object
	 * before its first await.
	 */
	// 输入已提交创建（或已恢复 pending）的 JobRun。输出 void（异步工作在 drain 中）。
	// 内存运行直接 #start；持久化运行先提交 reservation（phase -> running），再启动 run。
	// 例：持久化作业在 reservation 提交前崩溃，恢复时记录仍是 pending，不增加 restart 计数。
	invoke(run: JobRun): void {
		const invocation = run.begin();
		// 内存作业（#records.persisted 为 false）或已经从 running 记录恢复的运行，无需 reservation。
		if (!this.#records.persisted || run.phase === "running") {
			this.#start(run, invocation);
			return;
		}
		const { documents, token, context } = this.#owner;
		// reservation 是空事务，只把 phase 改成 running，但它必须与 run 启动同属 drain 工作。
		const reserving = documents
			.tx((tx) => this.#records.reserve(tx, run), token, context)
			.then(
				() => {
					// 提交成功但 attempt 在等待期间被 seal：不再启动 run，按 seal 的原因切断并唤醒 invocation 的 join。
					if (this.#state !== "sealed") {
						this.#start(run, invocation);
						return;
					}
					this.#records.cut(run, this.#sealed!.error, this.#sealed!.reason);
					// No `run` started: nothing else ends it, and an abort joined to it returns.
					invocation.ended();
				},
				() => {
					// 提交被拒绝：先关闭本 invocation 的围栏/等待，避免泄漏。
					invocation.settle();
					invocation.ended();
					// Refused because this attempt was sealed (at admission, or queued past the seal): the run is pending still,
					// for the next live attempt (this one is detached already). Any other failure (the store closed or failed,
					// the object ended) is not retried here: retrying on this attempt would only fail again.
					// 只有 seal 造成的拒绝才 requeue；store 故障/对象结束重试也没有意义。
					if (this.#state === "sealed") this.#records.requeue(run);
				},
			);
		// admit 让 reservation 计入 attempt 的 drain：对象关闭前会等待它，避免半提交状态。
		this.#owner.admit(reserving);
	}

	/** Starts `invocation` of `run` on this attempt: its ctx and its settling act for this invocation only. */
	// 输入 run 与它刚创建的 invocation；输出 void。副作用：创建 JobContext、登记 drain、执行插件 run、结算 outcome。
	// 每个异步回调都捕获 invocation：旧 invocation 的结束不会误伤新 invocation。
	#start(run: JobRun, invocation: Invocation): void {
		const { context, caller, host } = this.#owner;
		const signal = invocation.abort.signal;
		// JobContext 组合了对象级 context 与本次 invocation 的 abort signal；ctx.state 由 #stateOf 生成。
		const ctx = new JobContext(
			withAbortSignal(signal, context),
			caller,
			host,
			run.id,
			this.#stateOf(run, invocation),
		);
		// work 是一个只用于 drain 的 Promise：run 结束、outcome 记录尝试、invocation.ended 之后才 resolve。
		const work = Promise.withResolvers<void>();
		// admitRun 的 cleanup 在 attempt 提前结束时也会调用 ctx.settle()，释放 ctx.get 引用。
		this.#owner.admitRun(work.promise, () => ctx.settle());
		this.#invocations.add(run);
		const running = (async () => {
			try {
				// Its own version's args: a handed-over attempt's late start runs its own code (Sol, reservation).
				// argsOf 使用本 Job 的 #definition（本 attempt 声明版本），而不是 records 的当前定义。
				return await this.#implementation.run(this.#records.argsOf(run, this.#definition), ctx);
			} finally {
				// The fence closes as `run` settles: a change made later is refused.
				// 即使 run 抛错，这里也关闭 state change 的围栏；abort 信号不在这里触发。
				invocation.settle();
			}
		})();
		// then 的两个回调分别处理成功/失败；finally 唤醒 invocation 的 joins，最后才 resolve drain 的 work。
		running
			.then(
				(result) => this.#settled(run, invocation, ctx, { kind: "done", result }),
				(error: unknown) => this.#settled(run, invocation, ctx, this.#failed(run, invocation, error)),
			)
			.finally(() => invocation.ended())
			.then(work.resolve);
	}

	/**
	 * Runs the finish of `run`, whose outcome is recorded: `finish` with the cleanup in one transaction under the
	 * attempt's token, retried with backoff after a throw (reported), blocked after five in a row. The attempt's seal
	 * stops it without a report or a count; the next live attempt finishes the run.
	 */
	// 输入处于 finishing 的 JobRun；输出 void（工作被 admit 进 drain）。
	// 与 run 不同，finish 在事务里执行，因此它可以和记录删除/状态退役一起原子提交。
	finish(run: JobRun): void {
		const work = this.#finish(run);
		this.#owner.admit(work);
	}

	/** How a throwing `run` ended: `aborted` after its invocation's signal fired, otherwise `threw` (reported). */
	// 输入 run/invocation/原始错误；输出 Settled。
	// 如果 abort signal 已触发，无论 run 抛什么，都归因于 aborted（避免把取消误报成插件失败）。
	// 其他错误：ChordError/PluginError 原样保留，普通值包成 PluginError(internal)，并上报 job_failed。
	#failed(run: JobRun, invocation: Invocation, error: unknown): Settled {
		if (invocation.abort.signal.aborted) return { kind: "failed", error: { kind: "aborted", reason: "abort" } };
		this.#records.report({ kind: "job_failed", id: run.id, error });
		const thrown = isChordError(error) || error instanceof PluginError ? error : internal(error);
		return { kind: "failed", error: { kind: "threw", error: thrown } };
	}

	/**
	 * `invocation` of `run` settled: its `ctx.get` references go; its outcome is recorded unless the attempt's seal cut
	 * it off (which recorded its own, or stopped the run for a later invocation), then the run finishes here while this
	 * attempt is live.
	 */
	// 结束回调可能晚于 seal：token 已封或 run 已换 invocation 时直接返回，避免旧调用覆盖新状态。
	// ctx.settle() 释放该 handler 通过 ctx.get 拿到的引用；records.settled 负责写 outcome 并触发 finish。
	async #settled(run: JobRun, invocation: Invocation, ctx: JobContext, ended: Settled): Promise<void> {
		ctx.settle();
		if (invocation.token.sealed || run.invocation !== invocation) return;
		this.#invocations.delete(run);
		this.#records.settled(run, ended);
	}

	// finish 的重试循环：事务失败 -> 上报 -> 计数 +1 -> 达上限则 block，否则记录计数并退避重试。
	// seal 期间停止重试且不计数；finally 保证无论成功/失败/中止都把 run 移出 #finishing。
	async #finish(run: JobRun): Promise<void> {
		const { documents, token, context, signal } = this.#owner;
		this.#finishing.add(run);
		// delay 在多次重试间保留，nextDelay 每次翻倍（1s, 2s, 4s...上限 60s）。
		let delay: number | undefined;
		try {
			for (;;) {
				try {
					// 每次重试都开新事务：finish 可能已经部分执行，但只有成功提交的那次生效。
					return await documents.tx(
						async (tx) => {
							// staging.finishing 让本次启动的去重/并发计算知道“当前 finish 的 run 不计数”。
							const staging = this.#records.staging(tx);
							staging.finishing = run;
							// outcomeOf 把旧版本结果映射到当前定义；finish 可执行任意 tx 写。
							await this.#implementation.finish?.(this.#records.outcomeOf(run, context), tx);
							// 删除运行记录/状态文档必须与 finish 的写同一次提交。
							this.#records.change(tx, { kind: "delete", run });
						},
						token,
						context,
					);
				} catch (error) {
					// attempt 已 seal：停止重试；记录保留，由下一个 live attempt 继续 finish。
					if (this.#state === "sealed") return;
					this.#records.report({ kind: "job_finish_failed", id: run.id, error });
					// The count is the run's (stored for a persisted job): failures count across a crash.
					const finishFailures = run.finishFailures + 1;
					if (finishFailures >= FINISH_ATTEMPTS) {
						return await this.#records.record(run, { kind: "block", run, reason: "finish_failed" });
					}
					await this.#records.record(run, { kind: "update", run, fields: { finishFailures } });
					delay = nextDelay(delay);
					try {
						// sleep 使用 attempt 的 signal：seal 会立即中断退避，而不是等到计时器到期。
						await sleep(delay, withAbortSignal(signal, context));
					} catch {
						return;
					}
				}
			}
		} finally {
			this.#finishing.delete(run);
		}
	}

	/** `ctx.state` of `invocation` of `run`, when the job has a state: changes under its token while it runs. */
	// 输入 run/invocation；输出 RunState 或 undefined（作业没有状态文档）。
	// 返回对象是每次调用新建的轻量视图：value 同步读 records.stateOf，change 走 documents.tx。
	#stateOf(run: JobRun, invocation: Invocation): RunState<JsonObject> | undefined {
		const records = this.#records;
		const states = records.states;
		if (states === undefined) return undefined;
		const { documents } = this.#owner;
		// refused 是统一的错误工厂：运行结束后再读写状态都得到 released/settled。
		const refused = (): ChordError =>
			new ChordError({
				code: "released",
				reason: "settled",
				message: `${records.name}: run ${run.id} settled; its state is closed`,
			});
		return {
			get value(): JsonObject {
				const value = records.stateOf(run.id);
				// 文档退役后 stateOf 返回 undefined：与“尚无状态”不同，运行已结束，读取应失败。
				if (value === undefined) throw refused();
				return value;
			},
			change: <T>(
				fn: (draft: Draft<JsonObject>) => T,
				context: Context,
				options: { readonly persistence?: CommitPersistence } = {},
			): Promise<T> => {
				// 每次 change 都重新检查 invocation 状态：闭包可能在 run 结束后才被调用。
				if (invocation.state !== "running") return Promise.reject(refused());
				let persistence: CommitPersistence;
				try {
					// persistence 来自插件，是信任边界：运行期校验 kind/withinMs。
					persistence = checkedPersistence(options.persistence, records.name);
				} catch (error) {
					return Promise.reject(error);
				}
				// Never the abort signal: a run records its progress also after an abort.
				// withoutAbortSignal 生成一个不可取消的 context；这是 D8 的语义，不是遗漏。
				const unaborted = withoutAbortSignal(context);
				// A change resetting the restart count is stored at once: the reset must be durable (D8).
				// run.restarts === 0 表示这次 change 会重置计数（progressed 在事务里更新），此时不能延迟落盘。
				const now = run.restarts === 0 ? persistence : IMMEDIATE;
				return documents.tx(
					async (tx) => {
						// draftSlot 只草稿该运行的文档；fn 的返回值原样作为事务结果。
						const value = fn(await tx.draftSlot(states, run.id));
						// progressed 在 restarts != 0 时把计数归零（同一次提交）。
						records.progressed(tx, run);
						return value;
					},
					invocation.token,
					unaborted,
					now,
				);
			},
		};
	}
}

const IMMEDIATE: CommitPersistence = { kind: "immediate" };

/**
 * A state change's `persistence` (a trust boundary: plugin code): `immediate` when omitted; a deferred one's `withinMs`
 * a number from 0 (`Infinity` waits for the others), `invalid/args` otherwise.
 */
// 输入插件传入的 persistence 与错误前缀；输出规范化的 CommitPersistence。
// 允许 undefined（默认 immediate）和 immediate；deferred 的 withinMs 必须是 >= 0 的数字或省略。
// 例：{ kind:"deferred", withinMs: 50 } 通过；{ kind:"deferred", withinMs: -1 } 抛 invalid/args。
function checkedPersistence(persistence: CommitPersistence | undefined, what: string): CommitPersistence {
	if (persistence === undefined || persistence.kind === "immediate") return IMMEDIATE;
	const { withinMs } = persistence;
	// `persistence.kind !== "deferred"` 也是运行期检查：JS 调用者可能传任意 kind。
	if (
		persistence.kind !== "deferred" ||
		(withinMs !== undefined && !(typeof withinMs === "number" && withinMs >= 0))
	) {
		throw new ChordError({
			code: "invalid",
			reason: "args",
			message: `${what}: persistence is immediate or deferred with withinMs >= 0`,
		});
	}
	// 返回原对象（不复制）：调用方已按契约传入；后续只读。
	return persistence;
}

/** A plugin's throw that is neither a ChordError nor a PluginError, as a run's outcome keeps it. */
// 保留 message，但不保留原始 stack/cause：运行结果要可持久化、可跨链接；细节属于报告通道。
function internal(error: unknown): PluginError {
	return new PluginError("internal", error instanceof Error ? error.message : String(error));
}

/** A run's ctx: the handler's ctx of its object, its id and, with a state, its state document. */
// 继承 CallContext 获得 ctx.get/principal/incarnation/abortSignal 与 settle 生命周期。
// state 用 declare 声明为可选字段（不生成 JS 属性），构造器只在有状态时赋值；运行期读取是 undefined 或对象。
export class JobContext extends CallContext {
	readonly jobId: string;
	declare readonly state: RunState<JsonObject> | undefined;

	constructor(
		context: Context,
		caller: Caller,
		host: AnyHost,
		jobId: string,
		state: RunState<JsonObject> | undefined,
	) {
		super(context, caller, host);
		this.jobId = jobId;
		// 只有存在 state 时才赋值；declare 字段在未赋值时读取得到 undefined。
		if (state !== undefined) this.state = state;
	}
}
