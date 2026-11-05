// 文件导读
// ========
// 所属：packages/durable/src/session 的提交写入器（Writer），是 Session“分组提交（group commit）”的存储与发布调度器。
// 上游：SessionImpl 构造 Writer，并在每次提交结算后调用 admit()；Session.touch()/Session.drained() 分别调用
// gate()/drained()。
// 下游：WriterHost.commit() 实际调用 Storage.commit()（一次调用写多个原子批次）；WriterHost.publishing() 让发布
// 运行在 Storage 自己的作用域；WriterHost.stored() 把批次应用到读缓存，part.publish() 完成内存采纳；失败时
// WriterHost.fail() 终止 Session。
//
// 解决什么问题：Session 的变更行一次只运行一个回调，但回调结算后的存储可以离线并行。Writer 把“行内准入”与
// “存储+发布”解耦：
// - admit() 返回的 part 立即登记写键，使后续读取这些键的行内任务等待它的 gate；
// - 当没有 Storage 调用在飞时，把队列里所有 part 合成一次 commit() 调用（stored part 的批次数组），减少往返；
// - 按行顺序逐个发布（相邻两个 part 之间让出一个宏任务），让等待者先恢复，再发布下一个；
// - 失败具有最终性：某个 part 失败后，之前已发布的保留，之后的 part 不再发布，其 outcome 以 SessionFailed 拒绝；
//   同一个 Storage 调用里已经持久化的其他 part 保留自己的存储错误。
//
// 职责边界：Writer 不解释 StorageWrite 内容，不校验业务语义；它只负责批次顺序、seq 收据、发布顺序、
// gate/outcome 生命周期和失败传播。它不访问 Storage 本身，全部经 WriterHost。
//
// 能力清单（导出项）：
// - PublishFailure：一个 part 发布失败的两类原因：adoption（内存无法采纳）或 listener（Session 自己的观察者抛错）。
// - PartSpec：调用方交给 Writer 的一个逻辑提交：行索引、可选的写批次（undefined 表示 held 提交）、写键、context、
//   publish(seq) 与 discard()。
// - Part：PartSpec 加上 outcome Promise。
// - WriterHost：Writer 需要的 Session 能力：commit/stored/publishing/failure/fail/report。
// - Writer：写器本体，方法 admit()、gate()、drained()、unpublished（测试用计数）。
// 内部类型：Admitted（Part + settle + done + gate）、FailedOutcome、SESSION_FAILED。
//
// 组合与典型流程：
//   Session 结算一次提交 -> writer.admit({index, writes, keys, context, publish, discard})
//   -> Writer 合并队列 -> host.commit(所有 stored 批次) -> 收到 seq -> 逐 part:
//      host.stored(writes) -> host.publishing(() => part.publish(seq)) -> 打开 gate/结算 outcome。
//   读取方：Session.touch(key) -> writer.gate(key)，等待该键最新未发布 part 的 gate。
//   全部发布完成：drained() 的 gate 打开（由最后 admit 的 part 控制）。
//   held 提交：writes === undefined，不进入 commit() 调用；等它前面的 part 发布后单独 publish(undefined)。
//
// 示例（内部 API；WriterHost 由 SessionImpl 实现）：
//   const part = writer.admit({
//     index: 7,
//     writes: [{ type: "entry", value: entryRecord }],
//     keys: ["entry:12", "entry-append:3"],
//     context,
//     publish: (seq) => { cache.apply(entryRecord); return undefined; },
//     discard: () => {},
//   });
//   await part.outcome; // 发布完成；失败则以存储错误或 SessionFailed 拒绝。
// 说明：示例只展示真实签名与顺序；普通调用方应通过 Session.commit()，不要直接构造 Writer。
//
// 失败语义：
// - Storage.commit() 拒绝：有收据的 part 继续发布；第一个没有收据的 stored part 成为失败边界并以调用错误拒绝，
//   之后的 stored part 也保留调用错误，held part 则为 SessionFailed；Session 以调用错误失败；
// - adoption 失败：该 part 的 outcome 以自己的错误拒绝；listener 抛错：提交成立、该 part 正常 resolve，
//   但 Session 在它之后失败；
// - 某 part 失败后：后续 part 不再发布；它们通常以 SessionFailed 拒绝，除非属于同一次被拒绝的 Storage 调用
//   （仍保留调用错误）；
// - Writer 自身意外抛错（bug）：#abandon() 失败 Session 并结算所有 part，避免 outcome/gate 永远悬挂。
//
// 建议阅读顺序：先读 WriterHost/PartSpec/Part/PublishFailure 契约，再读 Writer 字段与 admit()/gate()/drained()，
// 然后读 #pump()/#flush()/#send() 的“合并存储”，最后逐行读 #publish() 的失败分支与 #abandon()/#unpublish()/
// #unregister()/#open()。相关测试经由 SessionImpl 覆盖：test/session-group-commit.test.ts（批量、gate、失败边界、
// 随机交错）、test/session-deferred-commits.test.ts（writes: undefined 的 held part）、
// test/harness-group-commit.test.ts 与 test/harness-storage-failure.test.ts。
// The Session's writer: commits the mutation line admitted, stored in batches off the line and published in line order.
import type { Context } from "@earendil-works/chord/context";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { SessionFailed } from "../errors.ts";
import type { CommitResult, Seq, StorageWrite } from "../types.ts";

/** A part's own failure at publication: memory could not adopt it, or one of the Session's own observers threw. */
// PublishFailure 只描述“发布阶段”的失败：
// - adoption：内存无法采纳已持久化或 held 的提交（包括读缓存 stored() 抛错），Session 在该行索引之后失败；
// - listener：Session 自己的内部观察者抛错；提交本身已存储且有效，Session 在它之后失败。
// error 保留任意抛出值；类型上 unknown 迫使调用方通过 errorMessage() 等辅助函数格式化。
export type PublishFailure = { readonly kind: "adoption" | "listener"; readonly error: unknown };

/** One logical commit the line admitted: stored (`writes`, never empty), or held in memory only (no `writes`). */
// 行内准入的一个逻辑提交。writes 为 undefined 表示只驻留内存的 held 提交，不参与 Storage.commit()；
// 其他 part 的 writes 至少一条。keys 用于 gate；publish(seq) 是发布回调；discard 在永不发布时 abort 草稿。
// 类型层用 readonly 表达“调用方不应修改”；运行时不再校验这些字段。
export type PartSpec = {
	/** Line index of the job that admitted it: a failure it causes makes only later jobs' outcomes `SessionFailed`. */
	// 行索引：失败边界按它编号；Session.fail 的 at 与 own 列表都使用这个编号。
	readonly index: number;
	// 要存储的原子批次；undefined = held 提交（没有 Storage 写）。
	// 联合类型让调用方必须显式处理 held 情况，但“stored 时非空”靠约定而不是类型保证。
	readonly writes: readonly StorageWrite[] | undefined;
	/** Keys it writes: a read of one waits for its publication. */
	// 本次写入的键；发布前同键读取等待其 gate。
	readonly keys: readonly string[];
	// 提交上下文；Storage.commit 会去掉 abort signal（见 #send）。
	readonly context: Context;
	/** Publish it in memory, in line order, once it is durable (with its seq) or, held, once the parts before it are. */
	// 发布内存状态；返回 PublishFailure 或 undefined。seq 为 undefined 仅用于 held 提交。
	readonly publish: (seq: Seq | undefined) => PublishFailure | undefined;
	/** It will never be published: abort what it prepared. */
	// 永不发布时清理已 prepare 的草稿；由 #unpublish 调用。
	readonly discard: () => void;
};

/** An admitted part and its outcome. */
// 已准入的 part：outcome 在发布完成时 resolve，在永不发布或存储失败时 reject。
// outcome 始终被 Writer 内部挂上 catch，因此无人 await 也不会产生 unhandled rejection。
export type Part = PartSpec & {
	/**
	 * Resolves once it is published; rejects once it never will be, and also after publication when its storage call
	 * rejected or the Session failed meanwhile. Always handled, so a part nobody awaits rejects silently.
	 */
	// 发布完成的信号；失败原因可能是任意抛出值或 SessionFailed。
	readonly outcome: Promise<void>;
};

// Writer 内部状态：调用方看到的 Part + 结算器 + done 标志 + gate（发布或永不发布时打开）。
type Admitted = Part & {
	// resolve/reject 同时置 done，保证重复结算不会发生。
	readonly settle: { resolve(): void; reject(error: unknown): void };
	/** Set once its outcome is settled. */
	// 已结算标志；#abandon 用它避免重复结算。
	done: boolean;
	/** Opens once it is published or never will be; never rejects. */
	// 无拒绝的 PromiseWithResolvers；gate.promise 永远不会 reject。
	readonly gate: PromiseWithResolvers<void>;
};

/** How a part that will not resolve settles: with an error of its own, which may be any value, or `SessionFailed`. */
// 失败 part 的结局：保留自己的错误（任意抛出值），或统一为 SessionFailed。
type FailedOutcome = { readonly kind: "own"; readonly error: unknown } | { readonly kind: "failed" };

// 共享常量，避免为每个失败 part 分配相同对象。
const SESSION_FAILED: FailedOutcome = { kind: "failed" };

/** What the writer needs of its Session. */
// Writer 对 Session 的最小依赖。SessionImpl 在构造时用箭头函数实现这些方法；
// 这样 Writer 不依赖 SessionImpl 类型，便于单测和替换。
export type WriterHost = {
	// 把 batches 按顺序原子存储；每个 batch 至少一条写；receive(index, seq) 对每个已 durable 的 batch
	// 同步回调。返回 { stored, refused? }；reject 表示结果未知。Writer 用 withoutAbortSignal 调用它。
	// batches 的下标是 stored part 在本次调用中的序号，不是行索引。
	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult>;
	/** Apply a stored batch to the Session's read caches, right before it is published. */
	// 发布前把已存储批次应用到读缓存（CachedStorage）与 ConversationTails，使内存与 Storage 一致。
	stored(writes: readonly StorageWrite[]): void;
	/**
	 * Run one part's publication inside the Storage's own scope (`Storage.publishing`); `undefined` when it ran at once,
	 * else settles once it ran.
	 */
	// 在 Storage 自己的作用域里运行 publish（例如 store 的 host batch）；没有作用域时同步运行并返回 undefined，
	// 否则返回运行完成的 Promise。publish 只运行一次。
	publishing(publish: () => void, context: Context): Promise<void> | undefined;
	/** The Session's failure, if it failed. */
	// Session 的首个失败；非 undefined 后所有后续 part 都只能以 SessionFailed 结束。
	failure(): { readonly error: unknown } | undefined;
	/**
	 * Fail the Session; `at` is the line index of the first job whose outcome the failure is, and `own` the jobs after it
	 * whose outcome is still their own error (the other parts of a call that rejected), not `SessionFailed`.
	 */
	// 标记 Session 失败：at 是失败的行索引；own 是同一 Storage 调用中仍应保留自己错误的行索引。
	// 失败后 Session 会关闭，后续 outcome 变 SessionFailed。
	fail(error: unknown, at: number, own: readonly number[]): void;
	/** Report an own observer's throw that cannot fail the Session, as it fails with a storage error. */
	// 报告无法失败 Session 的内部观察者错误（此时 Session 因存储错误已失败）。
	report(error: unknown, context: Context): void;
};

/**
 * The writer of one Session. The line admits each commit as a part once its callback and settlement succeeded; the
 * writer sends every part admitted while no call is in flight as one `commit()` call, off the line, and publishes
 * the parts of a call one by one, in line order, with a macrotask between two, so the continuations of the waits one
 * resolves start before the next is published. Held commits are parts without writes, published when the parts before
 * them are.
 *
 * Each part registers the keys it writes; until it is published, it is the newest unpublished writer of each, and a
 * job that touches one waits for its gate. A key leaves when its newest writer is published, so the map holds one entry
 * per key with an unpublished writer.
 */
// 一个 Session 的写入器：行内准入每个 part，离行合并存储，按行顺序发布。
// 每个 part 登记写键；在它发布前，它是这些键最新的未发布写者，触碰这些键的任务要等它的 gate。
// 某个键在其最新写者发布时（或确定永不发布时）移出 map，因此 map 大小等于“有未发布写的键数”。
export class Writer {
	// Session 提供的提交/缓存/失败接口。
	readonly #host: WriterHost;
	/** Admitted parts not yet sent, in line order. */
	// 已准入、还未送出的 part（按行顺序）。
	#queue: Admitted[] = [];
	// 是否有一次 Storage 调用/发布循环在飞；同一时刻最多一个。
	#flight = false;
	/** Per key, the newest unpublished part that writes it. */
	// 每个键 → 最新未发布 part；发布后删除。
	readonly #unpublished = new Map<string, Admitted>();
	/** The newest admitted part that is not yet published, whose gate opens after every earlier one's. */
	// 最新准入且未发布的 part；它的 gate 打开意味着所有更早 part 都已结束。
	#newest: Admitted | undefined;

	// 只保存 host；构造时不启动任何异步工作。
	// 例：const writer = new Writer(host);
	constructor(host: WriterHost) {
		this.#host = host;
	}

	/** Admit a part: register its keys, queue it, and send it at once unless a call is in flight. */
	// 准入一个 part：创建 outcome/gate，登记写键，入队，并在没有在飞调用时立即启动发送。
	// 返回的 Part 可以等待 outcome；即使无人等待，内部也挂 catch 防止 unhandled rejection。
	// 顺序保证：同一个 Writer 中 admit 的顺序就是发布顺序。
	// 例：const part = writer.admit(spec); await part.outcome;
	admit(spec: PartSpec): Part {
		// Promise.withResolvers 同时给出 promise 与 resolve/reject；Node 22+ 可用。
		const outcome = Promise.withResolvers<void>();
		// 提前消费 rejection，避免调用方忘了 await 时进程告警。
		// 返回的新 Promise 被丢弃；catch 回调本身不抛错，所以也不会产生新的 rejection。
		outcome.promise.catch(() => {});
		// 用对象字面量构造；settle 闭包在构造完成后引用 part 自身。
		const part: Admitted = {
			...spec,
			outcome: outcome.promise,
			settle: {
				// 结算成功：done 先置位，再 resolve Promise；gate 由 #open 单独打开。
				resolve: () => {
					part.done = true;
					outcome.resolve();
				},
				// 结算失败：同样先置 done；错误保留原始抛出值。
				reject: (error) => {
					part.done = true;
					outcome.reject(error);
				},
			},
			// 新 part 尚未结算。
			done: false,
			// gate 没有 reject 路径，只表示“可以继续”。
			gate: Promise.withResolvers<void>(),
		};
		// 每个键都指向这个 part；后准入的 part 会覆盖同键，因此 map 始终是最新写者。
		for (const key of spec.keys) this.#unpublished.set(key, part);
		// 记录最新 part，用于 drained()。
		this.#newest = part;
		// 入队；#pump 在 flight=false 时立即发送。
		this.#queue.push(part);
		this.#pump();
		return part;
	}

	/** The gate of the newest unpublished writer of `key`, or `undefined` when it has none. */
	// 返回 key 最新未发布写者的 gate；undefined 表示没有未发布写，调用方可以直接读。
	// 例：const gate = writer.gate("entry:12"); if (gate !== undefined) await gate;
	gate(key: string): Promise<void> | undefined {
		return this.#unpublished.get(key)?.gate.promise;
	}

	/** Opens once every part admitted so far is published or never will be. */
	// 返回“迄今为止所有已准入 part 都发布或确定不会发布”的 gate；undefined 表示没有已准入但未结束的 part。
	// 例：const all = writer.drained(); if (all !== undefined) await all;
	drained(): Promise<void> | undefined {
		// 因为每次 admit 都更新 #newest，最后那个 part 的 gate 打开时，它之前的所有 part 都已打开。
		return this.#newest?.gate.promise;
	}

	/** Keys with an unpublished writer, for tests that bound memory. */
	// 测试用：当前还有多少键有未发布写者，用来断言没有泄漏的键。
	// 例：const leaked = writer.unpublished; // 测试断言它应回到 0
	get unpublished(): number {
		return this.#unpublished.size;
	}

	// 启动一次发送：没有在飞调用且队列非空时，取走当前队列（之后 admit 的进入新队列），
	// 置 flight 后异步 flush；flush 结束会再次 pump，消化新队列。
	// 例（内部）：this.#pump();
	#pump(): void {
		// 已有调用在飞或没有待发 part：不启动第二个并发调用。
		if (this.#flight || this.#queue.length === 0) return;
		// 先置位，防止重入启动第二个 flush。
		this.#flight = true;
		// 先取走再异步，保证本次调用处理的是此刻的批次。
		const parts = this.#queue;
		this.#queue = [];
		// 不 await；调用方只通过 part.outcome 观察结果。
		void this.#flush(parts);
	}

	/**
	 * Send and publish `parts`, then what was admitted meanwhile. Never rejects: a throw the writer did not expect fails
	 * the Session and settles the parts (`#abandon()`), so no outcome or gate is stranded.
	 */
	// 发送并发布 parts，然后处理这期间新准入的 part。本方法保证不 reject：
	// 发送/发布中 Writer 自己的意外抛错交给 #abandon()，使所有 outcome/gate 都有归宿。
	// 例（内部）：void this.#flush(parts);
	async #flush(parts: readonly Admitted[]): Promise<void> {
		try {
			// #send 的正常失败（存储拒绝、发布失败）已在内部结算，不会以异常形式冒到这里。
			await this.#send(parts);
		} catch (error) {
			// 能到这里说明 Writer 自身有 bug（例如宿主实现违约）；兜底失败 Session 并结算所有 part。
			this.#abandon(parts, error);
		}
		// 释放“在飞”标志后再 pump，允许下一批立即开始。
		this.#flight = false;
		this.#pump();
	}

	/** Store `parts` in one call, then publish them in order; settles every one of them. */
	// 一次 Storage 调用：把 parts 中带 writes 的按顺序作为 batches 提交，然后按顺序发布。
	// held part（writes undefined）不发送，但仍参与发布循环。
	// 例（内部）：await this.#send(parts);
	async #send(parts: readonly Admitted[]): Promise<void> {
		// 只有带 writes 的 part 参与 commit；held part 只发布内存状态。
		const stored = parts.filter((part) => part.writes !== undefined);
		// 按 stored 的索引记录 seq；receive 回调可能同步多次调用。
		const seqs: (Seq | undefined)[] = [];
		// result 是正常返回值；rejected 保存调用级异常。二者只有一个会被设置。
		let result: CommitResult | undefined;
		// 调用级拒绝原因；类型用 unknown，因为 Storage 可以 reject 任何值。
		let rejected: { readonly error: unknown } | undefined;
		// 发送前 Session 已失败：不再调用 Storage，所有 part 以 SessionFailed 结束。
		const failed = this.#host.failure();
		if (failed !== undefined) {
			// held part 也一并拒绝：Session 已不可用，它们不会再有发布机会。
			for (const part of parts) this.#unpublish(part, new SessionFailed(failed.error));
			return;
		}
		// 有真实写才调用 Storage；纯 held 批次跳过 commit。
		if (stored.length > 0) {
			try {
				// 一次调用提交所有 stored part；Storage 按 batch 顺序分配 seq。
				result = await this.#host.commit(
					// 每个 part 的 writes 是一个原子 batch；! 断言由上方 filter 保证。
					stored.map((part) => part.writes!),
					// durability receipt：把 seq 写到对应 stored 索引；发布阶段按行顺序读取。
					(index, seq) => {
						// receive 可能同步调用多次；数组下标就是 batch 在本次调用中的位置。
						seqs[index] = seq;
					},
					// 存储调用不应因调用方取消而中断：批次一旦发出，结果必须确定。
					// 整个调用使用第一个 stored part 的 context（调用级 context 只有一个）。
					withoutAbortSignal(stored[0]!.context),
				);
			} catch (error) {
				// reject 表示结果未知；部分 batch 可能已 durable，发布阶段要按收据判断。
				rejected = { error };
			}
		}
		// A call that settles once another failure failed the Session reports `SessionFailed` with that first error,
		// whatever it returned (spec §10.1), and publishes nothing.
		// 等待 commit 期间，另一个调用或宿主可能失败 Session（规格 §10.1）：本调用也以首个错误结束，不发布。
		const failedMeanwhile = this.#host.failure();
		if (failedMeanwhile !== undefined) {
			// 已 durable 的 part 也以 SessionFailed 拒绝；Session 关闭后不能继续发布。
			for (const part of parts) this.#unpublish(part, new SessionFailed(failedMeanwhile.error));
			return;
		}
		// 发布阶段自行结算每个 part，不向本方法抛错。
		await this.#publish(parts, seqs, result, rejected);
	}

	/**
	 * Publish the received parts and held ones in order, a macrotask apart, and settle every part (group commit §3.4). A
	 * refusal, a rejection, or a part whose adoption or own observer throws fails the Session once the parts before it
	 * are published and the host observers got the last one; the parts after it are not published, and reject with
	 * `SessionFailed`. What the failure decides (the outcomes, and the gates of the parts it concerns) is settled only
	 * once the Session failed, so no job waiting at such a gate, and no later outcome, goes on as if it had not.
	 */
	// 按顺序发布收到的 parts 与 held parts：两个相邻 part 之间让出一个宏任务。
	// 一旦某个 part 失败（拒绝、adoption/listener 抛错、外部失败），它之前的已发布，它之后的不会发布；
	// 失败相关的 outcome 与 gate 只在 Session 真正标记失败后才结算，避免等待者提前像成功一样继续。
	// 例（内部）：await this.#publish(parts, seqs, result, rejected);
	async #publish(
		parts: readonly Admitted[],
		seqs: readonly (Seq | undefined)[],
		result: CommitResult | undefined,
		rejected: { readonly error: unknown } | undefined,
	): Promise<void> {
		// 失败边界：error/at/是否由外部失败导致。undefined 表示还没有失败。
		let stop: { readonly error: unknown; readonly at: number; readonly external?: true } | undefined;
		/**
		 * Settled once the Session failed: each part, whether it was published, and its outcome: an error of its own (any
		 * value, `undefined` included), or `SessionFailed`.
		 */
		// 本次调用中不再发布的 part 及其结局；在 Session.fail 之后统一结算。
		// published 表示它已经进入过发布步骤（adoption 失败或调用级拒绝），决定 gate 如何打开。
		const failing: { readonly part: Admitted; readonly outcome: FailedOutcome; readonly published: boolean }[] = [];
		// 本次 Storage 调用中的 stored 索引（与 seqs 对齐）；held part 不递增。
		let storedIndex = 0;
		// 已进入发布步骤的 part 计数，用于宏任务间隔（external 失败可能让它包含未真正发布的 part）。
		let published = 0;
		// 按行顺序逐个处理；held part 也占一个发布位置。
		for (const part of parts) {
			// held part 没有 Storage 索引；stored part 依次取 seqs 下标。
			const index = part.writes === undefined ? undefined : storedIndex++;
			// 失败边界之后：如果本次调用最终拒绝，stored part 保留调用级错误；其余 part 统一 SessionFailed。
			if (stop !== undefined) {
				// A part after a rejected call's last receipt has the call's error; any other part after a stop was not sent,
				// nor any part once something else failed the Session.
				// 只有本次调用拒绝、失败不是外部造成、且该 part 属于本次提交（stored）时，才保留调用级错误；
				// held part 统一 SessionFailed。
				const outcome: FailedOutcome =
					rejected !== undefined && index !== undefined && stop.external !== true
						? { kind: "own", error: rejected.error }
						: SESSION_FAILED;
				// published:false：这些 part 不会进入发布阶段，稍后走 #unpublish。
				failing.push({ part, outcome, published: false });
				continue;
			}
			// undefined 表示 held part 或该 stored part 没有收到收据。
			const seq = index === undefined ? undefined : seqs[index];
			// Storage 没接收这个 batch：调用拒绝、refusal，或“提交了却没采纳”。
			if (index !== undefined && seq === undefined) {
				// 优先用调用级拒绝；否则看 result.refused 是否正是本 batch；否则用内部错误。
				const error =
					rejected !== undefined
						? rejected.error
						: index === result?.stored && "refused" in result
							? result.refused
							: new Error("Storage committed without adopting the batch");
				// 该 part 以自身错误结束，并成为后续 part 的失败边界。
				failing.push({ part, outcome: { kind: "own", error }, published: false });
				// 边界从该 part 的行索引开始；后续 part 不再发布。
				stop = { error, at: part.index };
				continue;
			}
			// 第一个 part 的等待者与发布回调在微任务里恢复后，再发布下一个 part。
			// A macrotask between two parts: what the first resolves runs before the second is published.
			// 第一个 part 不等待；之后每个 part 前都让出一个宏任务。
			// published++ 返回旧值，所以 0 时跳过，1 及以上才 hop。
			if (published++ > 0) await hop();
			// failure 是发布回调自己的失败；external 是等待期间别处失败 Session。
			let failure: PublishFailure | undefined;
			// Failed by something else meanwhile, during the hop or before a storage's scope runs the publication: nothing
			// more of the call is published. Checked right before it would be, after every wait.
			// 外部失败快照；在发布作用域真正执行时再次读取。
			let external: { readonly error: unknown } | undefined;
			// publishing() 可能同步运行，也可能返回 Storage 作用域里的 Promise。
			const publication = this.#host.publishing(() => {
				// 每次等待后、真正发布前再检查一次，避免发布一个 Session 已失败的提交。
				external = this.#host.failure();
				// 已失败：跳过 stored/publish；该 part 的键注销与 gate 打开留给后续失败分支处理。
				if (external !== undefined) return;
				// 先注销键：发布回调里调度的读取应该看到它已发布；gate 稍后才打开。
				// Its keys leave first, so what its publication schedules sees it published; its waiters wake after it.
				// 注销后同键的新 part 可以成为最新写者；本 part 不再阻塞新写入。
				this.#unregister(part);
				// 读缓存写入也算发布的一部分：它抛错等同于 adoption 失败。
				// A throw anywhere in it, the read caches included, leaves memory behind what is stored: like an adoption's.
				try {
					// 只有真实存储的 part 才更新读缓存；held part 没有 Storage 写。
					if (part.writes !== undefined) this.#host.stored(part.writes);
					// 回调返回 PublishFailure 表达业务发布失败；抛错由 catch 包装成 adoption 失败。
					failure = part.publish(seq);
				} catch (error) {
					// 任意抛出值都归为 adoption；内存状态无法与已提交内容保持一致，Session 必须失败。
					failure = { kind: "adoption", error };
				}
			}, part.context);
			// Storage 可以用自己的作用域异步运行发布；必须等它真正跑完再继续。
			if (publication !== undefined) await publication;
			// 发布未执行：本 part 未发布，失败边界是外部错误。
			if (external !== undefined) {
				// external 标记让后续 part 不再保留本调用级的拒绝错误，统一 SessionFailed。
				stop = { error: external.error, at: part.index, external: true };
				failing.push({ part, outcome: SESSION_FAILED, published: false });
				continue;
			}
			// 内存无法采纳：本 part 已进入发布步骤但未完成；Session 在该行索引失败。
			if (failure?.kind === "adoption") {
				// published:true：该 part 的 gate 必须打开，但 outcome 以自己的错误拒绝。
				failing.push({ part, outcome: { kind: "own", error: failure.error }, published: true });
				stop = { error: failure.error, at: part.index };
				continue;
			}
			// 本 part 已发布，但所属 Storage 调用最终拒绝：outcome 用调用错误；内部观察者错误只报告。
			// A part published while its call rejected is durable but rejects (spec §10.1); an own observer's throw is then
			// reported, as the Session fails with the storage error.
			if (rejected !== undefined) {
				// Session 已因存储错误失败，listener 错误只能上报，不能再改变失败原因。
				if (failure !== undefined) this.#host.report(failure.error, part.context);
				// 保留调用级拒绝错误，而不是 SessionFailed；它已经是本次调用的结论。
				failing.push({ part, outcome: { kind: "own", error: rejected.error }, published: true });
				continue;
			}
			// listener 抛错：提交仍然成立，但 Session 在该 part 之后失败。
			// An own observer's throw: the commit stands; the Session fails after it.
			// 记录失败边界；当前 part 仍会正常 resolve/打开 gate，失败只影响后续 part 和 Session。
			if (failure !== undefined) stop = { error: failure.error, at: part.index };
			// 发布期间 Session 可能在别处失败。
			const failedMeanwhile = this.#host.failure();
			// 本 part 没有自己的错误，但 Session 已失败：outcome 以 SessionFailed 拒绝。
			if (failedMeanwhile !== undefined && failure === undefined) {
				// 使用 Session 的首个错误构造 SessionFailed，保持错误链一致。
				part.settle.reject(new SessionFailed(failedMeanwhile.error));
				// 正常发布（或 listener 失败但提交成立）：resolve outcome。
			} else part.settle.resolve();
			// 打开 gate；等待该键的任务继续。
			this.#open(part);
		}
		// 本次调用有失败：先标记 Session 失败，再统一结算失败边界后的 part。
		if (rejected !== undefined || stop !== undefined) {
			// After the host dispatch of the last part published, which is one microtask away.
			// 等一个微任务，让最后一个已发布 part 的 host dispatch 先跑。
			await Promise.resolve();
			// Every part of the call that rejected keeps the storage error; the first of them is the failure's boundary.
			// 同一 Storage 调用中，保留自己的错误那些 part 的行索引。
			const own = failing.flatMap(({ part, outcome }) => (outcome.kind === "own" ? [part.index] : []));
			// 调用级拒绝以第一个 own part 为边界；own 为空时传 undefined，Session.fail 会退回当前/最后投递的行索引。
			if (rejected !== undefined) this.#host.fail(rejected.error, own[0]!, own);
			// 非调用级失败（refusal/adoption/listener/external）使用 stop 的边界。
			else this.#host.fail(stop!.error, stop!.at, own);
		}
		// 统一结算失败列表；解构时把 published 改名 stored，避免与外部变量混淆。
		for (const { part, outcome, published: stored } of failing) {
			// own 保留原错误；否则包装成 SessionFailed（此时 Session 已记录失败）。
			const error = outcome.kind === "own" ? outcome.error : this.#failed(stop!.error);
			// 已进入发布步骤：保留错误但打开 gate，不能 discard。
			if (stored) {
				// 拒绝 outcome；错误可能是存储错误、adoption 错误或 SessionFailed。
				part.settle.reject(error);
				this.#open(part);
				// 未发布：discard 草稿、拒绝 outcome、注销键并打开 gate。
			} else this.#unpublish(part, error);
		}
		// 本调用期间新准入的 part 还未发送；Session 已失败，它们也永不发送。
		// Admitted while this call ran, after the failure: never sent.
		// 发布阶段也可能让 Session 失败；这里统一拒绝新队列。
		const failure = this.#host.failure();
		if (failure !== undefined) {
			// 先取走再清空，避免 #unpublish 期间又有新 part 入队时被误处理。
			const queued = this.#queue;
			this.#queue = [];
			// 这些 part 从未发送，也没有自己的存储错误，统一 SessionFailed。
			for (const part of queued) this.#unpublish(part, new SessionFailed(failure.error));
		}
	}

	/**
	 * A throw the writer itself did not expect while sending or publishing `parts` (a bug): fail the Session at the first
	 * of them and settle every one not settled yet, so no outcome, gate, or close waits on it forever.
	 */
	// Writer 自身意外抛错的兜底（表示 bug）：在第一个 part 的行索引失败 Session，
	// 然后结算所有尚未结算的 part 并打开 gate，保证没有 outcome/gate/close 永远等待。
	// 例（兜底）：this.#abandon(parts, error);
	#abandon(parts: readonly Admitted[], error: unknown): void {
		// 以第一个 part 的行索引作为失败边界；没有“保留自己错误”的 part。
		// parts[0]! 由调用方保证非空（#flush 只在队列非空时启动）。
		this.#host.fail(error, parts[0]!.index, []);
		// 逐个兜底结算。
		for (const part of parts) {
			// 已结算的跳过；未结算的统一 unpublish。
			if (!part.done) this.#unpublish(part, this.#failed(error));
			// 即使已结算也确保键注销（幂等）。
			this.#unregister(part);
			// 即使已结算也确保 gate 打开（幂等）。
			this.#open(part);
		}
	}

	/** `SessionFailed` with the Session's failure, or with `error` until the Session records it. */
	// 构造 SessionFailed：优先使用 Session 已记录的首个错误，否则用传入错误。
	// 例：const failure = this.#failed(storageError);
	#failed(error: unknown): SessionFailed {
		const failure = this.#host.failure();
		return new SessionFailed(failure !== undefined ? failure.error : error);
	}

	/** Settle a part that will never be published: discard it, reject it with `error`, and open its gate. */
	// 一个 part 永不发布：discard 草稿、以 error 拒绝 outcome、注销键并打开 gate。
	// 例：this.#unpublish(part, new SessionFailed(error));
	#unpublish(part: Admitted, error: unknown): void {
		// 释放已 prepare 的草稿；discard 由调用方实现，Writer 不关心其内容。
		part.discard();
		// 拒绝 outcome；之后 #open 让 gate 通过。
		part.settle.reject(error);
		this.#unregister(part);
		this.#open(part);
	}

	/** Drop the keys a part is still the newest writer of: it is published, or never will be. */
	// 只删除仍指向本 part 的键；后来的 part 可能已成为同键最新写者。
	// 例：this.#unregister(part);
	#unregister(part: Admitted): void {
		// 身份比较避免误删后来者的登记；循环覆盖该 part 登记过的全部键。
		for (const key of part.keys) if (this.#unpublished.get(key) === part) this.#unpublished.delete(key);
	}

	/** Open a part's gate: the jobs waiting for it go on. The newest part's opens `drained()` too. */
	// 打开 gate，让等待该 part 的任务继续；如果它是 #newest，drained() 也随之满足。
	// 例：this.#open(part);
	#open(part: Admitted): void {
		part.gate.resolve();
		if (this.#newest === part) this.#newest = undefined;
	}
}

/**
 * Yield to the event loop once: `setImmediate` where there is one, otherwise a `MessageChannel` message (Workers,
 * browsers). Microtasks queued before it, such as wait continuations, run first.
 */
// 宏任务让出：Node/Workers 有 setImmediate 时用它；浏览器/Workers 没有时用 MessageChannel。
// 只让出一个宏任务，不是固定延迟；之前排队的微任务会先运行。
// 例：await hop(); // 让出一个宏任务，让已排队的微任务先运行
function hop(): Promise<void> {
	// Node 与部分 Workers 提供 setImmediate；回调在下一个 check 阶段运行。
	if (typeof setImmediate === "function") return new Promise((resolve) => setImmediate(resolve));
	// 没有 setImmediate：用 MessageChannel 的消息（也是宏任务）实现同样的让出。
	const channel = new MessageChannel();
	return new Promise((resolve) => {
		// 收到消息后关闭 port，避免句柄泄漏，再 resolve。
		channel.port1.onmessage = () => {
			// 关闭端口；不关闭会让 Worker 的事件循环保持活跃。
			channel.port1.close();
			resolve();
		};
		// 发送一条消息触发 onmessage；undefined 只是占位 payload。
		channel.port2.postMessage(undefined);
	});
}
