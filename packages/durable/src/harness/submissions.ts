// Durable 提交（submission）的接纳、等待与撤回：把输入、写入、continue 三种草稿变成提交记录与运行。
// 所属：packages/durable/src/harness，Durable harness 的提交层（spec §6）。
// 上游：Conversation.submit(tx, draft) 调 admit；Conversation/Harness 的 submit(draft, context) 调 submit；
// 会话拥有的 compaction 也复用 admitSubmission。
// 下游：admitSubmission 通过 Tx 写提交、pi.inbox、LiveDoc 与会话记录，并调 generation.startRun 启动运行；
// 等待者由 Session 的提交观察（#observe）唤醒。
// 错误流向：忙/闲冲突抛 ConversationBusy/ConversationIdle；先写表后提交抛 ReadAfterWrite；关闭时等待者以
// closedError 拒绝；存储与事务错误原样抛给调用方（提交由调用方负责回滚）。
// 能力清单：
// - Submissions：一个 Harness 的提交接纳、状态读取、等待与撤回入口。
// - SubmissionHandle：绑定提交 ID 的 Submission 实现，把查询/等待/撤回委托回 Submissions。
// - admitSubmission：单次接纳的全部规则（requestId、display-only、忙闲、队列、边界、stale、启动运行）。
// - isSettled / checkInputEntry：内部终态判定与输入条目校验。
// 组合与顺序：submit/admit → #traced span → admitSubmission；wait 先在 Session 线上检查并登记 Waiters，
// 之后 #observe 在提交观察里 resolve；abort 在事务里 settleSubmission 并移除 inbox 项。
// 示例：const submission = await conversation.submit({ type: "input", content: "hi" }, context);
//      const settled = await submission.wait(context);
// 建议阅读顺序：先看类字段与 constructor，再看 submit/admit/wait/abort，然后通读 admitSubmission 的分支，
// 最后看 SubmissionHandle 与两个辅助函数。
import { type Context, withTelemetry } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { ConversationBusy, ConversationIdle, ReadAfterWrite } from "../errors.ts";
import type { ObservedCommit, SessionImpl } from "../session/session.ts";
import type { ConversationId, JsonObject, SubmissionId, SubmissionRecord, Tx } from "../types.ts";
import { startRun } from "./generation.ts";
import {
	appendInput,
	applyBoundary,
	hasQueuedReset,
	InboxDoc,
	isDisplayOnly,
	isStale,
	pickInputEntry,
	prepareBoundary,
	type QueueModes,
	removeInboxItem,
} from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { DURABLE_TELEMETRY_SCHEMA } from "./telemetry.ts";
import type { InputEntry, SettledSubmissionRecord, Submission, SubmissionDraft, UserInput } from "./types.ts";
import { closedError, Waiters } from "./util.ts";

// abort 的三种成功结果：已撤回、已放置（无法再撤回）、已结算；调用方另会收到 "not_found"。
type AbortResult = "aborted" | "already_placed" | "settled";
// 接纳结果：排队、已放置、当次完成；只描述这次接纳，不保证之后不被撤回/结算。
type Admission = { readonly id: SubmissionId; readonly status: "queued" | "placed" | "done" };

/** Admission, waits, and withdrawal of the durable submissions of one Harness. */
/**
 * 一个 Harness 内的提交门面：负责接纳、查询状态、等待结算和撤回排队项。
 * 输入：构造时注入 Session、时钟、队列模式读取器和 resume 回调；方法接收 draft/ID 与 Context。
 * 输出：submit/admit 返回提交或 ID；wait 返回 SettledSubmissionRecord；abort 返回结果字符串。
 * 副作用：在调用方事务里写表；在内存中登记 Waiters；订阅 Session 的提交与关闭。
 * 错误：见各方法；关闭后登记等待会抛 closedError，构造后不再接受新提交由上层限制。
 * 示例（Harness 构造时）：new Submissions(this, now, settings, () => this.#tasks.resume(), options.telemetry)。
 *      const submission = await submissions.submit(conversationId, draft, context);
 */
export class Submissions {
	// 遥测上下文、Session、时钟与两个读取器；#queueModes 每次接纳时读取，保证设置变更立即生效。
	readonly #telemetry: TelemetryContext;
	readonly #session: SessionImpl;
	readonly #now: () => number;
	/** Read at each admission, on the Session line. */
	readonly #queueModes: () => QueueModes;
	/** Enable task scheduling; submitting or waiting asks for progress. */
	readonly #resume: () => void;
	readonly #waiters = new Waiters<SubmissionId, SettledSubmissionRecord>();
	#closed = false;

	/**
	 * 保存依赖并订阅 Session 的提交/关闭；构造本身不写存储。
	 * 参数：session 提供提交观察与关闭通知；now 生成时间戳；queueModes 每次接纳时读取队列模式；
	 * resume 请求调度推进；telemetry 缺省为 NOOP_TELEMETRY_CONTEXT（默认参数在调用方省略时求值）。
	 * 副作用：注册提交观察者与关闭订阅；关闭时把 #closed 置真并同步拒绝全部等待者。
	 * 例：见类文档中的 Harness 构造调用。
	 */
	constructor(
		session: SessionImpl,
		now: () => number,
		queueModes: () => QueueModes,
		resume: () => void,
		telemetry: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
	) {
		this.#telemetry = telemetry;
		this.#session = session;
		this.#now = now;
		this.#queueModes = queueModes;
		this.#resume = resume;
		// 提交观察是唤醒等待者的唯一入口；关闭订阅负责把未完成的等待统一拒绝。
		session.followCommits((publication) => this.#observe(publication));
		session.subscribeClose(() => {
			this.#closed = true;
			// closedError 保留 Session 的 failure；rejectAll 同步拒绝，之后 wait 不再登记新等待者。
			this.#waiters.rejectAll(closedError(this.#session));
		});
	}

	/** Admit a submission in one commit; see `admitSubmission()`. */
	/**
	 * 用一个独立提交接纳 draft：输入会话、草稿与 Context，输出 Submission 句柄。
	 * 副作用：开启 `pi.durable.submit` span，并在 withTelemetry 的上下文里 commitWith；失败时该提交回滚。
	 * 错误：事务/接纳错误原样抛给调用方；span 只标记 error 状态，不记录错误正文。
	 * 流程：#traced 请求推进并包 span → admitSubmission 在同一事务内完成 → 包装成 SubmissionHandle。
	 * 例：const submission = await submissions.submit(conversationId, { type: "input", content: "hi" }, context)。
	 */
	async submit(conversationId: ConversationId, draft: SubmissionDraft, context: Context): Promise<Submission> {
		// commitWith 的 change 回调拿到同一事务；withTelemetry 让事务内后续工作使用 span 作为遥测上下文。
		const { id } = await this.#traced(conversationId, draft, context, (span) =>
			this.#session.commitWith(
				(tx) => admitSubmission(tx, conversationId, draft, this.#now(), this.#queueModes(), span),
				withTelemetry(span, context),
			),
		);
		return new SubmissionHandle(id, this);
	}

	/**
	 * Admit a submission inside the caller's commit `tx`, with the rules of `submit()`. The admission is stored or lost
	 * with that commit. It must come before the commit's first table write, another admission's included.
	 */
	/**
	 * 在调用方事务内接纳 draft：输入 tx、会话 ID、草稿，输出 SubmissionId。
	 * 副作用：写提交/收件箱/运行记录；这些写入与调用方的提交同生共死。
	 * 错误：tx 不属于本 Session 抛 Error；事务已有表写抛 ReadAfterWrite；其余接纳错误原样上抛。
	 * 流程：校验事务归属与“先读后写” → #traced 包 span → admitSubmission → 返回 ID（不负责提交）。
	 * 例：const id = await submissions.admit(tx, conversationId, { type: "write", entry });
	 */
	async admit(tx: Tx, conversationId: ConversationId, draft: SubmissionDraft): Promise<SubmissionId> {
		// 事务只能属于本 Session，否则提交/观察链路对不上。
		if (!this.#session.ownsTransaction(tx)) throw new Error("The transaction belongs to another Session");
		// Enforced on every path: admission reads tables only on some (request IDs, an idle boundary, a steer's trace).
		// 即使当前草稿走不到表读分支，也统一在此拒绝，保证“接纳必须先于首条表写”的规则没有例外。
		if (tx.hasTableWrite) throw new ReadAfterWrite("submit(tx, draft)");
		// tx.context 提供本次接纳的取消信号与遥测上下文。
		const admission = await this.#traced(conversationId, draft, tx.context, (span) =>
			admitSubmission(tx, conversationId, draft, this.#now(), this.#queueModes(), span),
		);
		return admission.id;
	}

	/** Run one admission in its `pi.durable.submit` span, asking for progress first, as the run it starts needs it. */
	/**
	 * 在 `pi.durable.submit` span 中执行一次接纳，并先请求调度推进。
	 * 输入：会话、草稿、调用方 Context、具体接纳回调；输出接纳结果。
	 * 副作用：调用 #resume 请求推进；span 记录开始/结束属性；出错时标记 error 后原样抛出。
	 * 父级选择：input/continue 会启动运行，用 Harness 遥测作根并 link 调用方；write 用调用方上下文作父。
	 * 例：见 submit()；内部只由 submit/admit 调用。
	 */
	#traced(
		conversationId: ConversationId,
		draft: SubmissionDraft,
		context: Context,
		admit: (span: TelemetrySpan) => Promise<Admission>,
	): Promise<Admission> {
		// 接纳可能启动运行，先让调度器知道有活可做；不等待任何任务完成。
		this.#resume();
		// Inputs and continues start runs: root traces linked to their callers.
		// write 不启动运行，因此挂在调用方的 span 下；input/continue 起独立根追踪。
		const startsRun = draft.type !== "write";
		const parent = startsRun ? this.#telemetry : context.telemetry;
		// createTypedSpanStarter 绑定父上下文；第二参数是 schema 元组，只用于编译期推导名字与属性。
		return createTypedSpanStarter(parent, [DURABLE_TELEMETRY_SCHEMA])(
			"pi.durable.submit",
			{
				// 属性名与值都受 schema 约束：submission.type 只允许 input/write/continue，conversation.id 是数字。
				"submission.type": draft.type,
				"conversation.id": conversationId,
			},
			async (span) => {
				// 起根追踪时用链接指回调用方，而不是把调用方当父级，避免跨会话的追踪被串成一棵错误的树。
				if (startsRun) span.addLink({ context: context.telemetry });
				try {
					const admission = await admit(span);
					// 成功只在结束属性里记录 ID 与接纳结果，不记录草稿内容。
					span.setAttributes({ "submission.id": admission.id, result: admission.status });
					return admission;
				} catch (error) {
					// Error text may contain caller content. Record only the status.
					// 错误正文可能含调用方内容，因此只写状态；setStatus 不改变下面重新抛出的错误。
					span.setStatus({ status: "error" });
					throw error;
				}
			},
		);
	}

	/** Handle for an existing submission, or `undefined`. */
	/**
	 * 读取提交记录并返回句柄：输入 ID 与 Context，输出 Submission 或 undefined。
	 * 副作用：在 Session 线上读取一次；无写入，存储错误原样抛。
	 * 例：const submission = await submissions.get(id, context); // 不存在时为 undefined
	 */
	async get(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		// readOnLine 保证读到的是 Session 线一致快照，不会与并发提交交错。
		const record = await this.#session.readOnLine((storage) => storage.submission(id, context));
		return record === undefined ? undefined : new SubmissionHandle(record.id, this);
	}

	/**
	 * 读取提交的当前记录：输入 ID 与 Context，输出 SubmissionRecord；不存在时抛 Error。
	 * 只读，不判断终态，也不等待；例：const record = await submissions.status(id, context)。
	 */
	async status(id: SubmissionId, context: Context): Promise<SubmissionRecord> {
		const record = await this.#session.readOnLine((storage) => storage.submission(id, context));
		// 与 get 不同，status 把“找不到”当作错误，因为调用方明确要求这份记录。
		if (record === undefined) throw new Error(`Submission ${id} does not exist`);
		return record;
	}

	/**
	 * 等待提交结算：输入 ID 与 Context，输出 SettledSubmissionRecord。
	 * 副作用：在 Session 线上检查后登记 Waiters；已结算立即返回；关闭时拒绝。
	 * 错误：提交不存在抛 Error；Harness 已关闭抛 closedError；context 取消只拒绝本次等待。
	 * 流程：readOnLine 内读取 → 已终态返回 resolved Promise → 未终态且未关闭则登记 → #observe 之后 resolve。
	 * 例：const settled = await submissions.wait(id, context)。
	 */
	async wait(id: SubmissionId, context: Context): Promise<SettledSubmissionRecord> {
		// 等待可能依赖调度推进（例如排队项需要边界），因此先请求 resume。
		this.#resume();
		// Check and register on the line so no settling publication falls between them.
		// 检查是否已结算和登记等待必须在同一条 Session 线上完成；否则结算提交可能恰好落在两步之间。
		const found = await this.#session.readOnLine(async (storage) => {
			const record = await storage.submission(id, context);
			if (record === undefined) throw new Error(`Submission ${id} does not exist`);
			// 已终态无需登记；Promise.resolve 生成一个已完成的 Promise，返回类型与登记分支一致。
			if (isSettled(record)) return { promise: Promise.resolve(record) };
			// Close rejects registered waiters synchronously and may begin during the read.
			// 关闭可能就在读取期间发生；#closed 已在关闭回调同步置真，因此这里再查一次。
			if (this.#closed) throw closedError(this.#session);
			return { promise: this.#waiters.add(id, context) };
		});
		return found.promise;
	}

	/** Withdraw a queued submission and remove its inbox item; placed inputs and settled submissions are reported. */
	/**
	 * 撤回排队中的提交：输入 ID、Context、可选会话 ID（校验归属），输出结果字符串。
	 * 副作用：一个事务内把 queued 结算为 unanswered/aborted，并从 inbox 删除该项；placed/settled 不改。
	 * 错误：事务/存储错误上抛；不存在或会话不匹配返回 "not_found"（由句柄层转成 Error）。
	 * 流程：读提交 → 校验归属 → queued 则 settle + remove → 否则按状态报告。
	 * 例：const result = await submissions.abort(id, context, conversationId)。
	 */
	abort(id: SubmissionId, context: Context, conversationId?: ConversationId): Promise<AbortResult | "not_found"> {
		// 撤回本身也要一次提交：结算记录与移除队列项必须原子生效，避免留下“已撤回但仍在队列”的项。
		return this.#session.commitWith(async (tx) => {
			const record = await tx.submission(id);
			// 可选会话 ID 是调用方给的归属约束；不匹配按不存在处理，不泄露其他会话的提交状态。
			if (record === undefined || (conversationId !== undefined && record.conversationId !== conversationId)) {
				return "not_found";
			}
			if (record.status === "queued") {
				// 终态写 unanswered + 固定原因；随后从 inbox 移除，后续边界不会再看到它。
				tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
				await removeInboxItem(tx, record.conversationId, id);
				return "aborted";
			}
			// 已放置/已结算的提交不能撤回，返回具体原因供调用方区分。
			return record.status === "placed" ? "already_placed" : "settled";
		}, context);
	}

	/**
	 * 提交观察回调：只处理已存储的结算提交，唤醒同 ID 的等待者。
	 * 输入是一次 ObservedCommit；输出 void；副作用仅解除 Waiters 登记，不写存储。
	 * 内存中的提交只改文档（例如边界放置），不触发结算等待，因此直接跳过。
	 * 例：一次提交里 submission 状态变为 done，会 resolve 所有 wait(id) 的 Promise。
	 */
	#observe(publication: ObservedCommit): void {
		// A commit held in memory changes documents only.
		// kind 是判别字段；"memory" 的提交尚未持久化，不会把提交记录变成终态。
		if (publication.kind === "memory") return;
		for (const change of publication.changes) {
			// 只关心提交记录，且只关心 done/unanswered；其他文档变更与仍排队的提交都与等待者无关。
			if (change.type !== "submission" || !isSettled(change.value)) continue;
			// resolve 后从 Waiters 删除该键；没有等待者时是空操作。
			this.#waiters.resolve(change.value.id, change.value);
		}
	}
}

/**
 * Submission 的句柄实现：只持有 ID 与 Submissions，方法委托回门面。
 * 调用方拿不到事务，也不能直接改提交记录；它只是同一个门面的窄接口。
 * 例：const handle = await conversation.submit(...); await handle.wait(context)。
 */
class SubmissionHandle implements Submission {
	readonly id: SubmissionId;
	readonly #submissions: Submissions;

	/** 绑定 ID 与门面；不读取存储，也不校验提交是否存在。 */
	constructor(id: SubmissionId, submissions: Submissions) {
		this.id = id;
		this.#submissions = submissions;
	}

	/** 委托 Submissions.status；只读，不存在时抛 Error。 */
	status(context: Context): Promise<SubmissionRecord> {
		return this.#submissions.status(this.id, context);
	}

	/** 委托 Submissions.wait；返回登记或已完成的 Promise。 */
	wait(context: Context): Promise<SettledSubmissionRecord> {
		return this.#submissions.wait(this.id, context);
	}

	/** 委托 Submissions.abort；把 not_found 转成 Error，其他结果原样返回。 */
	async abort(context: Context): Promise<AbortResult> {
		const result = await this.#submissions.abort(this.id, context);
		if (result === "not_found") throw new Error(`Submission ${this.id} does not exist`);
		return result;
	}
}

/**
 * 类型谓词：status 为 done/unanswered 时把 SubmissionRecord 收窄为 SettledSubmissionRecord。
 * 运行时只比较字符串，不校验记录的其余字段；例：isSettled({ status: "done", ... }) 为 true。
 */
function isSettled(record: SubmissionRecord): record is SettledSubmissionRecord {
	return record.status === "done" || record.status === "unanswered";
}

/** Reject an input entry an untyped caller got wrong: its kind must be a non-empty string outside the `pi.` prefix. */
// 信任边界：draft.entry 可能来自未类型化的 JavaScript 调用者，kind 的运行时形状必须在这里检查。
// 禁止 "pi." 前缀，避免调用方伪造 Durable 自己的系统条目种类；空串也没有意义。
// 例：kind = "custom.note" 通过；kind = "pi.system"、"" 或非字符串抛 TypeError。
function checkInputEntry(entry: InputEntry): void {
	const { kind } = entry;
	// typeof 检查名字上是多余（InputEntry 已声明 string），但这里服务的正是类型系统之外的调用者。
	if (typeof kind !== "string" || kind.length === 0 || kind.startsWith("pi.")) {
		// String(kind) 让错误信息对数字/对象等任意值都可读，而不是依赖模板字符串的隐式转换。
		throw new TypeError(
			`An input entry's kind must be a non-empty string not starting with "pi.", got ${String(kind)}`,
		);
	}
}

/**
 * Admit a submission inside a commit (spec §6); both `Conversation.submit()` forms and conversation-owned compactions
 * share it. A known request ID returns its existing submission without writing. A display-only write (only `kind` and
 * `data`) is appended and settled `done` at once, busy or not, as it changes nothing the model sees; only behind a
 * queued reset it queues, so it lands after the reset instead of before it in the context the reset ends. A busy
 * conversation queues anything else in `pi.inbox`, or rejects `whenBusy: "reject"` input and any continue with
 * `ConversationBusy`; an idle one rejects `whenIdle: "reject"` input with `ConversationIdle`. An idle continue places
 * queued items and starts a run with them and itself, placing no entry of its own. An idle conversation with queued
 * items queues it behind them and runs a final boundary. Otherwise idle input places its entry (`pi.user`, or the
 * input's own) and starts a run, and an idle write appends its entry and settles `done`, or `stale` when its head
 * reaches before the active range.
 */
/**
 * 在调用方事务内接纳一次提交（spec §6）；Conversation.submit 的两种形式与会话拥有的 compaction 共用。
 * 输入：tx、会话 ID、SubmissionDraft、now、QueueModes、可选 span；输出 Admission（提交 ID 与接纳状态）。
 * 副作用：按分支写提交记录、pi.inbox、LiveDoc 与会话记录，可能启动运行；不提交事务。
 * 错误：requestId 类型冲突、ConversationBusy/ConversationIdle；输入条目 kind 非法抛 TypeError；读写错误上抛。
 * 主要流程：
 * 1. 校验输入条目；requestId 命中旧提交则直接返回（类型必须一致）。
 * 2. display-only 写且队列无 reset：立即追加并结算 done，忙闲都如此。
 * 3. 读 LiveDoc 判断忙闲；忙时给 steer 链接当前运行的 trace；忙/闲的 reject 策略在此报错。
 * 4. continue：忙则拒绝；否则准备边界、创建 placed 提交、放置队列项并启动运行。
 * 5. 其余：空闲时先准备边界（表读必须先于表写）；需要排队时写入 inbox，能应用边界时立即应用并按需启动运行。
 * 6. 空闲且无需排队：写先查 stale；input 追加记录并启动运行。
 * 例：await admitSubmission(tx, conversationId, { type: "input", content: "hi" }, now, queueModes, span)。
 */
export async function admitSubmission(
	tx: Tx,
	conversationId: ConversationId,
	draft: SubmissionDraft,
	now: number,
	queueModes: QueueModes,
	span?: TelemetrySpan,
): Promise<Admission> {
	// 只有 input 的自定义条目在这里检查 kind；write 的 entry 走 EntryDraft 的写入路径。
	if (draft.type === "input" && draft.entry !== undefined) checkInputEntry(draft.entry);
	// requestId 是调用方提供的幂等键：同一个键只创建一个提交，重试返回已有记录。
	if (draft.requestId !== undefined) {
		const existing = await tx.submissionByRequest(conversationId, draft.requestId);
		if (existing !== undefined) {
			// 同一 requestId 不能代表不同类型的提交，否则重试语义无法确定。
			if (existing.type !== draft.type) {
				throw new Error(`Request ${draft.requestId} already identifies a submission of type ${existing.type}`);
			}
			// 旧提交已 unanswered 时按 done 返回：这次请求已有终局，不再新建提交；其余状态原样返回。
			return { id: existing.id, status: existing.status === "unanswered" ? "done" : existing.status };
		}
	}
	// fields 是所有分支共用的提交字段；trace 是遥测传播载体，span 未提供或适配器无传播能力时省略。
	const fields = { conversationId, requestId: draft.requestId, trace: span?.propagation?.inject(span) };
	// display-only 写不改变模型可见内容：没有 model/head/edits，忙闲都可以立即追加，无需边界。
	// 唯一例外是队列里已有 reset：它会把活动范围切到新上下文，此写必须排在 reset 之后才能落在正确的上下文里。
	if (
		draft.type === "write" &&
		isDisplayOnly(draft.entry) &&
		!hasQueuedReset((await tx.doc(InboxDoc, conversationId)).items)
	) {
		// 追加记录与创建提交都在同一事务；entry.id 由本次追加产生。
		const entry = await tx.appendEntry(conversationId, draft.entry);
		const write = { ...fields, type: "write", status: "done", entry: entry.id } as const;
		return { id: (await tx.createSubmission(write)).id, status: "done" };
	}
	// LiveDoc 的 run 字段存在即表示会话正忙；读取放在所有可能写表之前。
	const live = await tx.doc(LiveDoc, conversationId);
	const busy = live.run !== undefined;
	// steer 会打断当前运行并加入其中，因此在追踪上链接当前运行的 trace；其他模式不需要这次读取。
	if (
		draft.type === "input" &&
		draft.whenBusy === "steer" &&
		live.run !== undefined &&
		span?.propagation !== undefined
	) {
		const run = await tx.task(live.run.taskId);
		// trace 可能不存在（旧任务或未启用遥测）；extract 把存储的载体还原成父 Context。
		if (run?.trace !== undefined) span.addLink({ context: span.propagation.extract(run.trace) });
	}
	// whenBusy/whenIdle 只作用于 input；write 与 continue 各有自己的规则。
	if (busy && draft.type === "input" && draft.whenBusy === "reject") throw new ConversationBusy(conversationId);
	if (!busy && draft.type === "input" && draft.whenIdle === "reject") throw new ConversationIdle(conversationId);
	if (draft.type === "continue") {
		// Never queued: whether a run can continue depends on how the current one ends. Rejected before any write.
		// continue 永不排队：它能否继续取决于当前运行如何结束，所以忙时在任何表写之前直接拒绝。
		if (busy) throw new ConversationBusy(conversationId);
		// 边界读表，必须先于 createSubmission 的表写。
		const boundary = await prepareBoundary(tx, conversationId, queueModes);
		const { id } = await tx.createSubmission({ ...fields, type: "continue", status: "placed" });
		// Items an earlier failed run left queued (`afterFailedRun: "keep"`) are placed first and join the run. Its history
		// starts with the failed run's, so `afterRun` hooks see what that run did.
		// final 边界会放置队列：writes 先放，users 随后；这些 user 提交与本 continue 一起组成新一轮运行。
		const { users, first } = await applyBoundary(tx, boundary, "final", now);
		// first 优先沿用失败运行的起点，让 afterRun 钩子看到失败运行做过的事；没有失败记录时用边界给出的第一条。
		await startRun(tx, conversationId, live, { inputs: [...users, id], first: live.runFailure?.first ?? first });
		return { id, status: "placed" };
	}
	// A boundary reads the table, so it is prepared before the first table write; a busy one needs none.
	// 空闲才准备边界；忙时本次必然排队，不需要读 head/inbox。
	const boundary = busy ? undefined : await prepareBoundary(tx, conversationId, queueModes);
	// 忙，或空闲但队列已有项：本次必须排队（空闲时排在已有项之后），再尝试应用边界。
	if (boundary === undefined || boundary.inbox.items.length > 0) {
		const { id } = await tx.createSubmission({
			...fields,
			type: draft.type,
			status: "queued",
		});
		// Hosts may leave optional fields `undefined`; drafts take strict JSON.
		// copyJson 把草稿复制成严格 JSON 并去掉 undefined；as 只是把结果声明成文档值类型，不是运行时校验。
		const value = copyJson(draft.type === "write" ? draft.entry : draft.content, {
			omitUndefinedProperties: true,
		});
		// 有边界就复用其 inbox 草稿（后续 applyBoundary 也从同一草稿删除项）；忙时新开文档草稿。
		const items = (boundary?.inbox ?? (await tx.doc(InboxDoc, conversationId))).items;
		if (draft.type === "write") items.push({ id, mode: "write", entry: value as JsonObject });
		else {
			// steer 只在 whenBusy 为 steer 时排队为 steer；其余 input（含 whenIdle 策略）都按 followUp 排队。
			const mode = draft.whenBusy === "steer" ? "steer" : "followUp";
			const content = value as JsonRepresentation<UserInput>;
			// 自定义输入条目只保留 kind/data；没有 entry 时展开空对象，避免写入 undefined 字段。
			const entry = draft.entry === undefined ? {} : { entry: pickInputEntry(draft.entry) };
			items.push({ id, mode, content, ...entry });
		}
		// 忙：只入队，等运行结束后的边界放置。
		if (boundary === undefined) return { id, status: "queued" };
		// 空闲但有旧项：立即跑一次 final 边界，把能放的项（含可能的本项）放进上下文。
		const { users, first } = await applyBoundary(tx, boundary, "final", now);
		// 只有真的放置了 user 输入才启动新一轮；仅有 write 被放置时运行仍保持空闲。
		if (users.length > 0) await startRun(tx, conversationId, live, { inputs: users, first });
		// write 被边界放置，接纳即完成；input 只有在 users 末位（最新被放置）时才是 placed。
		return { id, status: draft.type === "write" ? "done" : users.at(-1) === id ? "placed" : "queued" };
	}
	// 走到这里：会话空闲且队列为空，边界已准备好，可以立即放置。
	if (draft.type === "write") {
		// stale head 会指向活动范围之前的记录；放置它等于把被压缩/重置切掉的历史又带回上下文，因此只记失败。
		if (isStale(boundary, draft.entry)) {
			const stale = { status: "unanswered", reason: "stale" } as const;
			// 接纳结果仍是 done：检查完成，只是这次写入没有生效（记录本身是 unanswered）。
			return {
				id: (await tx.createSubmission({ ...fields, type: "write", ...stale })).id,
				status: "done",
			};
		}
		// 非 stale：追加记录并创建 done 提交；两者同事务生效。
		const entry = await tx.appendEntry(conversationId, draft.entry);
		const write = { ...fields, type: "write", status: "done", entry: entry.id } as const;
		return { id: (await tx.createSubmission(write)).id, status: "done" };
	}
	// input：appendInput 会写 pi.user（或调用方自定义 kind），随后创建 placed 提交并启动运行。
	const entry = await appendInput(tx, conversationId, draft.content, draft.entry, now);
	const input = { ...fields, type: "input", status: "placed", entry: entry.id } as const;
	const { id } = await tx.createSubmission(input);
	// 本轮运行只含这一条输入，历史从它自己的记录开始。
	await startRun(tx, conversationId, live, { inputs: [id], first: entry.id });
	return { id, status: "placed" };
}
