// The batch (W1), one per host: a commit adopts inside it, then every watched value that changed gets one frame, then
// the flushes it collected run (a link sends one message); Chord calls that would reenter it are refused while it runs.

// 文件导读
// 所属包与模块：packages/chord/src/state 的发布批次模块，是 Chord 状态层（W1）的同步发布核心。
// 职责边界：只负责“一次同步提交如何收集变更、投递帧、运行 flush，以及如何拒绝重入”；不保存业务值，
// 不认识文档、链路或注册表。上游是 host：每个 host 创建一个 Batch，并把它交给所有 source 与派生值；
// writable.set、文档变更、derive 失效、registry 合成通过 within/soon/changed/flushing 把工作排进来。
// 下游：Source/FollowedSource.deliver 把帧推给 watch/observer；flush 通常由 link 注册，用来把本批编码成
// 一条消息。错误不向上抛：单个 deliver/flush 抛错会被隔离并交给构造时的 report（host 的 onError）。
// 能力清单：
// - Batch（类）：一个 host 的批次状态，提供 running、compute/run、commit、within、soon、changed、
//   flushing、count 和重入检查 assertOutside/assertNotComputing。
// - BatchError（联合类型）：批次内错误的两类上报形状，listener_error 与 delivery_failed。
// - Delivered（接口）：任何能在本批投递一帧的对象；Batch 只依赖这个最小接口。
// 组合关系与典型顺序：host 创建 Batch -> writable/derive 等在 adopt 中调用 changed()/flushing() 登记 ->
// host 调用 commit(adopt, ctx)：adopt -> 逐个 Delivered.deliver -> flush -> 处理 flush 期间延后的 within。
// soon 把批次外到达的变更合并到下一个微任务；compute 用于派生/合成的纯计算，期间禁止改 source。
// 示例（真实签名）：const batch = new Batch((error) => host.report(error), metrics);
// batch.commit(() => count.set(1), context);  // 改值、投递、发送在同一次提交内完成。
// 建议阅读顺序：先看 BatchError 与 Delivered 理解数据形状，再看 Batch 的字段注释，然后 read compute/run
// 建立重入概念，接着 commit（核心流程）、within/soon（批次归属），最后 count 与 getter。

import type { TelemetryMetrics } from "@earendil-works/pi-telemetry";
import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";

/** What a batch reports: a watch listener that threw, or a frame delivery that threw (a derive's value is no JSON). */
// 判别联合：kind 是运行时标签。listener_error 来自用户 watch 回调抛错；
// delivery_failed 来自 deliver/flush 抛错（例如 derive 产出的值不能被 JSON 处理）。
// error 类型是 unknown，因为抛出值可以是任意类型，接收方使用前必须窄化。
export type BatchError =
	| { readonly kind: "listener_error"; readonly error: unknown }
	| { readonly kind: "delivery_failed"; readonly error: unknown };

/** What a commit lists to get its frame delivered: a watched source it changed (JSON or native). */
// 最小接口：Batch 只要求对象能“投递这一批的帧”，不需要知道它是 JSON source 还是原生 source。
// deliver 每批只调用一次，由 changed() 登记；实现负责通知 watch 与订阅者。
export interface Delivered {
	/** Delivers this batch's frame to its watches and subscribers; called once per batch that listed it. */
	deliver(context: Context): void;
}

/** A host's batch: the reentrancy flag, the watched sources a commit changed, and where background errors go. */
// 类职责：一个 host 的批次状态。所有字段都是私有实现细节，只有 count/running 等少量只读能力对外。
// 重要不变量：一个 Batch 不能被两个 host 共用；它保存的是“当前正在进行的 commit”的临时数组。
export class Batch {
	/** Reports a throwing watch listener's error (to the host's `onError`); what watches get as their `report`. */
	// 供 watch 回调使用的错误上报函数：只上报 listener_error，保留原抛出值。
	readonly reportListener: (error: unknown) => void;
	// 更通用的内部上报函数，能区分 listener_error 与 delivery_failed。
	readonly #report: (error: BatchError) => void;
	// 可选的遥测指标对象；undefined 表示未启用遥测，此时 count 是空操作。
	readonly #metrics: TelemetryMetrics | undefined;
	/** Set while adopting, delivering or computing a derive; one flag per host. */
	// 运行时布尔标志：当前是否处于批次内（adopt、deliver 或 compute）。用于重入拒绝与“变更归入当前批”判断。
	#running = false;
	/** Set while a pure compute runs (a derive's, a registry's `compose`): nothing may change a source then. */
	// 比 running 更窄：纯计算期间禁止改 source，但允许只读访问；compute() 会同时置两个标志。
	#computing = false;
	/** The watched sources the current commit changed, each listed once by its `changed`. */
	// 当前 commit 中发生变化的 source 列表；去重由 source 的 changed 逻辑保证（每个 source 每次 commit 只登记一次）。
	#changed: Delivered[] = [];
	/** What runs once the current commit's frames were delivered, each listed once by its `flushing`. */
	// 投递完成后要运行的 flush 回调（例如链路发送）。它们在本批末尾同步执行。
	#flushes: ((context: Context) => void)[] = [];
	/** Set while the current commit's flushes run (its links send). */
	// flush 执行期间为 true；此时 within 的变更不能并回本批，否则会改变已经发出的帧内容。
	#sending = false;
	/** Changes `within` deferred while the flushes sent, for the next commit. */
	// flush 期间产生的变更先存到这里，本批结束后立刻作为下一次 commit 运行。
	#later: (() => void)[] = [];
	/** Changes `soon` collected for the commit on the next microtask, while one is queued. */
	// 已排队的微任务批次；undefined 表示当前没有排队，下一次 soon 需要自己 queueMicrotask。
	#soon: (() => void)[] | undefined;

	// 构造：绑定错误上报函数与可选遥测。不启动任何定时器/微任务，也没有 I/O。
	// 示例：new Batch((error) => console.error(error), metrics)。
	constructor(report: (error: BatchError) => void, metrics: TelemetryMetrics | undefined) {
		this.#report = report;
		// 把“监听器错误”这一固定类别绑定好，watch 侧只需传 error。
		this.reportListener = (error) => report({ kind: "listener_error", error });
		this.#metrics = metrics;
	}

	/** Whether a commit's adoption, a delivery or a derive compute runs now: a change made now lands in this batch. */
	// 只读 getter：host 用它判断“现在改值会不会并入当前批次”。返回运行时标志，不是编译期常量。
	// 示例：if (!batch.running) batch.commit(adopt, context); 批次内调用时返回 true。
	get running(): boolean {
		return this.#running;
	}

	/** Throws `invalid/reentrant` inside the batch: `operation` may not run during adoptions or derive computes. */
	// 在批次内调用某些操作（如关闭 link、重置状态）会破坏正在投递的帧，统一抛 invalid/reentrant。
	// operation 只用于错误消息，例如 assertOutside("host.close")。
	// 示例：watch 打开前调用 batch.assertOutside("watch")；批次内会抛 invalid/reentrant。
	assertOutside(operation: string): void {
		if (this.#running) throw invalid("reentrant", `${operation} inside a commit or a derive compute`);
	}

	/**
	 * Throws `invalid/reentrant` inside a pure compute (a derive's, a registry's `compose`): `operation` would change a
	 * source while one is computed from it. Changes inside an adoption are fine (they land in its batch).
	 */
	// 纯计算期间禁止改 source：否则 derive 可能在同一轮计算中读到一半新一半旧的值。
	// 只检查 computing，所以普通 adopt 内的 set 是允许的。
	// 示例：writable.set 内调用 assertNotComputing("writable.set")；derive 计算中 set 会抛错。
	assertNotComputing(operation: string): void {
		if (this.#computing) throw invalid("reentrant", `${operation} inside a derive compute or a compose`);
	}

	/** Runs the pure compute `work` (`run`, and changes refused: `assertNotComputing`); nests. */
	// 执行一段纯计算并返回其结果；期间 running/computing 都为 true。
	// 嵌套时保存外层标志并在 finally 恢复，避免内层 compute 结束后错误地清掉外层状态。
	// 示例：const total = batch.compute(() => sources.map((s) => s.value).length);
	compute<T>(work: () => T): T {
		// 快照外层状态，支持 derive 内再触发另一个 derive 计算。
		const running = this.#running;
		const computing = this.#computing;
		this.#running = true;
		this.#computing = true;
		try {
			// 泛型 T 让调用方保留 work 的返回类型，不做类型转换。
			return work();
		} finally {
			// 即使 work 抛错也恢复外层标志，批次状态不能泄漏。
			this.#running = running;
			this.#computing = computing;
		}
	}

	/** Runs `work` with reentrant calls refused; nests (a derive compute inside a commit). */
	// 只置 running（不置 computing），用于 adopt/投递阶段；嵌套同样恢复外层值。
	// 示例：const n = batch.run(() => adoptAndCount());
	run<T>(work: () => T): T {
		const outer = this.#running;
		this.#running = true;
		try {
			return work();
		} finally {
			this.#running = outer;
		}
	}

	/**
	 * Runs one commit's adoptions, then, still synchronously, delivers a frame for every watched value they changed
	 * (watched derives recompute through their reads), then runs the flushes the deliveries listed. A delivery or flush
	 * that throws is reported; the others still run. What `within` deferred while the flushes sent runs as the next
	 * commit, right after.
	 */
	// 核心方法：执行一次完整提交。adopt 内产生的变更通过 changed()/flushing() 登记到本批次。
	// 输入 adopt（同步改值函数）和 context（归属上下文）；无返回值；副作用是投递帧、发链路消息。
	// 单个 deliver/flush 抛错只上报，不让其余回调丢失（错误隔离）；最后把 flush 期间延后的变更
	// 作为下一次 commit 同步执行，保证顺序。
	// 示例：batch.commit(() => writable.set(1), ctx) 会先改值，再通知 watch，再发送链路消息。
	commit(adopt: () => void, context: Context): void {
		// 整个提交都在 running 状态下执行，期间的 Chord 重入操作会被拒绝。
		this.run(() => {
			try {
				// 第一阶段：执行调用方提供的变更。
				adopt();
				// 第二阶段：逐个投递本批登记的变化 source。
				for (const source of this.#changed) {
					try {
						// deliver 内部可能触发 derive 重算或用户 watch 回调。
						source.deliver(context);
					} catch (error) {
						// 投递失败被隔离并上报，不会中断其他 source。
						this.#report({ kind: "delivery_failed", error });
					}
				}
				// 第三阶段：标记“正在发送”，使 within 的新变更排到下一批。
				this.#sending = true;
				for (const flush of this.#flushes) {
					try {
						// flush 例如 link.send：把本批的帧编码成一个消息。
						flush(context);
					} catch (error) {
						// 发送失败同样隔离上报。
						this.#report({ kind: "delivery_failed", error });
					}
				}
			} finally {
				// 无论 adopt/deliver/flush 是否抛错，都清空本批登记并恢复发送标志，
				// 否则下一批会重复投递旧帧。
				this.#sending = false;
				this.#changed = [];
				this.#flushes = [];
			}
		});
		// 取走 flush 期间延后的变更；没有则结束（常见路径）。
		const later = this.#later;
		if (later.length === 0) return;
		// 先清空再递归，避免下面的 commit 又把它们当作延后项。
		this.#later = [];
		this.commit(() => {
			// 依次执行延后的 adopt 闭包；它们会重新登记自己的 changed/flush。
			for (const each of later) each();
		}, context);
	}

	/**
	 * Runs `adopt` inside the commit running now, which delivers what it changed; outside one, as a commit of its own;
	 * while a commit's flushes send, as the next commit (a link closing while it sends ends its holds: their departure
	 * lands in the next batch, so one commit stays one message per link and origin). For changes that happen wherever a
	 * reference binds or ends (`host.references`, `host.activity`).
	 */
	// 统一的“归属当前批次”入口：三处调用点按状态分流。
	// - 正在 flush：不能改已发出的帧，先存到 #later，等本批结束后单独提交。
	// - 正在 adopt/deliver（但未 flush）：直接执行，变更落入当前批次。
	// - 完全空闲：自己开一个 commit。
	// 输入 adopt 与 context；无返回值。示例：writable 的 #change 用它保证同步多次 set 合并。
	within(adopt: () => void, context: Context): void {
		if (this.#sending) this.#later.push(adopt);
		else if (this.#running) adopt();
		else this.commit(adopt, context);
	}

	/**
	 * Runs `adopt` in one commit on the next microtask, together with every other `soon` until then (changes arriving
	 * outside any commit, as a followed runtime's calls off its commit step: one batch for all of them). `context` is
	 * the first one's.
	 */
	// 把变更推迟到下一个微任务，并与期间所有 soon 合并成一个批次。
	// 典型场景：followed runtime 在批次外异步调用，逐个提交会产生大量小批次。
	// context 使用第一个调用者的；后续调用只追加闭包。
	// 示例：batch.soon(() => writable.set(2), context) 在批次外调用时，微任务中与其它 soon 一起提交。
	soon(adopt: () => void, context: Context): void {
		// 已有排队批次时只追加；闭包在微任务里按加入顺序执行。
		if (this.#soon !== undefined) {
			this.#soon.push(adopt);
			return;
		}
		// 第一个调用者创建数组并清空队列标记的时机在微任务内。
		const soon = [adopt];
		this.#soon = soon;
		queueMicrotask(() => {
			// 先清空 soon 标记，使本批执行期间的新 soon 能开启下一轮，而不是追加到已取走的数组。
			this.#soon = undefined;
			// 把所有收集的变更放进同一个 commit；它们各自的 changed/flush 在这一批统一投递。
			this.commit(() => {
				for (const each of soon) each();
			}, context);
		});
	}

	/** Lists a watched source the current commit changed. */
	// 登记一个变化 source；实际去重（同一批次只登记一次）由调用方 Source.changed 处理。
	// 只在批次内调用有意义；在批次外调用会留到下一次 commit 才被投递。
	// 示例：在 adopt 中 this.batch.changed(this) 把 source 排进本批投递列表。
	changed(source: Delivered): void {
		this.#changed.push(source);
	}

	/** Lists `flush` to run at the end of the current commit, after its deliveries (a link sending what they fed it). */
	// 登记批次末尾要运行的 flush；flush 在 watch 回调之后执行，可安全编码最终值。
	// 示例：batch.flushing((context) => link.sendPending(context))。
	flushing(flush: (context: Context) => void): void {
		this.#flushes.push(flush);
	}

	/**
	 * Counts one unit of derive or registry work on the host's metrics (a lazy read has no context to count through).
	 */
	// 记录一次 derive/registry 工作计数。counter 是字符串字面量联合，拼错会在编译期报错，
	// 但运行时只把字符串交给遥测对象。metrics 未配置时可选链使其成为空操作。
	// 示例：batch.count("chord.derive.computes") 让本次重算在指标中加一。
	count(
		counter:
			| "chord.derive.computes"
			| "chord.derive.diffs"
			| "chord.registry.composes"
			| "chord.registry.adapts"
			| "chord.contract.adapts",
	): void {
		this.#metrics?.counter(counter).add(1);
	}
}
