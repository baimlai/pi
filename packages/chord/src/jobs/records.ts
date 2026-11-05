// A job's records on its object (§15, slice 6a §1.2, slice 6b §4): its runs by id and by key, the active count, the
// run state documents, `running` and the runs waiting for a live attempt, across the object's attempts. Records and
// state documents change only in transactions on the object's line (staged changes adopted in the commit step); a
// persisted job's also in its object's store, in the same commits, loaded once per object, and written back stopped by
// the close writer when a clean stop cuts its runs off. Across a reload (slice 7b §8) the records take the new
// declaration's definition and every run keeps its version: an older one is mapped forwards through `accepts`, one
// without an adapter (or newer, or of a job the code no longer declares) is blocked `version` until a reload brings
// matching code.

// 文件导读（作业记录：运行、键、计数、状态文档、running、等待队列）
// 所属：packages/chord/src/jobs，Chord v2 作业模块在对象上跨 attempt 的记账核心（slice 6a §1.2、6b §4、7b §8）。
// 职责边界：维护一个作业名在一个对象上的所有未结算运行（按 id 与按 key 去重）、活跃计数、状态文档、running 列表，
// 以及等待 live attempt 的运行；不执行插件 run/finish（那是 job.ts），不直接写 store（通过事务的 staged/adoption）。
// 上游入口：host/attempt.ts 在对象激活/重启时创建并调用 load/attach；job.ts 的 start 走 stage、invoke 走 reserve、
// finish 走 change、seal 走 cut；对象结束时 close writer 调 writeAtClose；reload 走 check/redefine/undeclare/retryBlocked。
// 下游依赖：documents 的事务（tx/stage/adopt/commit/fence/retireSlot/draftSlot）、PersistedRuns（记录文档）、
// RunStates（状态文档与延迟持久化）、Running（观察者视图）、JobRun（运行对象）、stored.ts（记录形状）。
// 结果与错误流向：stage 成功返回 Run.handle，失败抛 ChordError（invalid/args、unavailable/busy、gone）；
// 异步 record/#recordOutcome 的 store 错误按 store 语义向上抛，对象已结束时静默放弃；运行结果由 #committed 兑现 handle。
// 能力清单：
// - RecordsOwner：JobRecords 对宿主对象的最小依赖（label、context、documents、store、countRuns、held）。
// - Settled：一次调用结束的两种结果（done/result 或 failed/JobError）。
// - Staging：一笔事务里本作业的临时记账（started/changes/adopts/finishing 与 adopt/committed/discarded 回调）。
// - JobRecords：作业记录类，提供声明检查与 reload 接管、参数/结果映射、开始/加载、分派、结算、关闭写回与报告。
// 组合关系/典型调用顺序：对象激活 -> load（持久化）-> attach(job) -> 开始运行走 stage -> 提交后 #committed -> #need
// -> #dispatch -> job.invoke -> 运行结束 #recordOutcome -> 提交 outcome -> job.finish -> 提交 delete -> handle.resolve。
// 示例（真实签名，展示调用形状而非完整可运行程序）：
//   const records = new JobRecords(definition, owner);
//   const handle = records.stage(tx, { n: 1 }, context, { key: "once" }); // 返回 Run<AnyOutcome>
//   await records.load(context); // 持久化作业恢复未结算运行
// 建议阅读顺序：RecordsOwner/Settled/RecordChange/Staging -> JobRecords 字段与构造 -> check/redefine/undeclare/retryBlocked
// -> stage/change/staging -> load/#restored -> attach/detach/#need/#dispatch -> #adopt/#committed -> end/drop。
// 关键不变量：所有记录变化只在对象线（documents 事务）上发生；#adopt 在提交步骤内、#committed 在提交成功后；
// 同一事务里创建的运行在提交前就能被去重和并发计算看到（staged.started），但对外可见要等 adoption。
// 内存与持久化：内存作业不写 store，cut 直接记录 aborted；持久化作业在同一提交里写 chord.jobs 记录，
// 干净停止由 close writer 在 seal 之后直接 commit 一次（writeAtClose），崩溃则靠下一个 attempt 的 load 计数。

import { type Context, withoutAbortSignal } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { check, validatorFor } from "../data/internal.ts";
import type { Op } from "../delta/index.ts";
import type { JsonObject } from "../documents/index.ts";
import { type Documents, Persistence, type Staged, type Transaction } from "../documents/internal.ts";
import type { AnyHost } from "../host/internal.ts";
import { uuidv7 } from "../host/internal.ts";
import type { JsonValue } from "../json.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ChordStore } from "../store/store.ts";
import type { JobDefinition, JobError } from "./definition.ts";
import type { CutReason, Job, StartOptions } from "./job.ts";
import { type LoadedRecord, PersistedRuns } from "./persisted.ts";
import { type AnyOutcome, type BlockedReason, JobRun, type Phase, type Run } from "./run.ts";
import { RunStates } from "./run-states.ts";
import { Running } from "./running.ts";
import { outcomeOf, type StoredFields, storedRun } from "./stored.ts";

/** What a job's records need of their object. */
// 这些字段由 host/attempt.ts 组装；records.ts 不持有对象本身，只通过这个窄接口使用它。
// context 不带 abort signal：记录运行结果时对象自身的取消不应阻止写。
export type RecordsOwner = {
	readonly label: string;
	readonly host: AnyHost;
	/** The object's context, without an abort signal: outcomes are recorded under it. */
	readonly context: Context;
	readonly documents: Documents;
	/** The host's store and the object's owner name in it, when the object may persist (P3). */
	readonly store: { readonly store: ChordStore; readonly owner: string } | undefined;
	/** Counts running and finishing runs: they keep the object alive (`host.activity.jobs`). */
	countRuns(delta: number): void;
	/** A held state change must be stored by `deadline`: the object's one timer flushes it (D8). */
	held(deadline: number): void;
};

/** How a run's invocation ended, before its outcome is recorded. */
// 这是“调用已结束”的原始结果；记录层随后会附加 id/args/state 变成 AnyOutcome。
// 与 AnyOutcome 的区别：Settled 不含运行身份和状态快照，发生在写记录之前。
export type Settled =
	| { readonly kind: "done"; readonly result: unknown }
	| { readonly kind: "failed"; readonly error: JobError };

/** What a change sets on a run's record besides its phase transitions below (D6, D7, the finish failure count). */
// 这些字段直接 Object.assign 到 JobRun 上，并在持久化时通过 recordFields 写进记录。
// abortMarked 是“已标记取消”的持久化标记；restarts 归零代表有进展；finishFailures 用于 5 次封顶。
type RunFields = {
	readonly phase?: Phase;
	readonly restarts?: number;
	readonly finishFailures?: number;
	readonly abortMarked?: true;
};

/** A loaded run and the change its activation writes, if any. */
// load 阶段先把所有恢复结果收集在内存，再一次性提交；change 为 undefined 表示记录已是最新，无需改写。
type Restored = { readonly run: JobRun; readonly change: RecordChange | undefined };

/** A change of the records, staged in a transaction and adopted in its commit step. */
// 判别字段 kind 决定 #adopt（提交步骤内更新内存与 running）和 #committed（提交后兑现 handle/计数）的行为。
// create：新运行；update：普通字段；outcome：结束结果并进入 finishing；block：进入 blocked（版本/收尾失败）；
// unblock：reload 重试；delete：finish 完成、记录消失；drop：blocked 运行被取消，直接丢弃。
type RecordChange =
	| { readonly kind: "create"; readonly run: JobRun }
	| { readonly kind: "update"; readonly run: JobRun; readonly fields: RunFields }
	| { readonly kind: "outcome"; readonly run: JobRun; readonly outcome: AnyOutcome }
	| { readonly kind: "block"; readonly run: JobRun; readonly reason: BlockedReason }
	/** A blocked run is retried (a reload): back to `phase` (finishing with its outcome, or to be invoked). */
	| { readonly kind: "unblock"; readonly run: JobRun; readonly phase: Phase }
	| { readonly kind: "delete"; readonly run: JobRun }
	| { readonly kind: "drop"; readonly run: JobRun };

/** What a commit step adopts of the records: a change, or a loaded run taken into memory as stored. */
// restore 专用于 load：把从 store 读到的 JobRun 直接放进内存（不触发运行），随后才处理它的激活 change。
type Adopted = RecordChange | { readonly kind: "restore"; readonly run: JobRun };

/** One transaction's changes of one job: the runs it started (dedupe, concurrency) and whose finish it is. */
// Staged 是 documents 事务给每个 stage 键提供的槽；这里扩展出作业需要的字段。
// started 用于同事务内按 key 去重和并发计数；changes/adopts 在提交步骤 adopt；finishing 让并发计算排除正在收尾的运行。
export type Staging = Staged & {
	readonly started: JobRun[];
	readonly changes: Adopted[];
	/** What the transaction's store writes leave in memory, adopted with the changes. */
	readonly adopts: (() => void)[];
	finishing: JobRun | undefined;
};

// 三个预制的失败结果：分别对应对象重启（restart）、reload 交接（reload）、显式取消（abort）。
// 复用常量避免每次 cut/abandon 都分配新对象；它们在记录里会转成 wire error 形状。
const RESTART: Settled = { kind: "failed", error: { kind: "aborted", reason: "restart" } };

const RELOAD: Settled = { kind: "failed", error: { kind: "aborted", reason: "reload" } };

const ABORTED: Settled = { kind: "failed", error: { kind: "aborted", reason: "abort" } };

/** A persisted run cut off this many times in a row ends `restart_limit` (D6, Durable's limit). */
// 计数在每次 load 发现 phase 仍是 running 时 +1；任何 state.change 的进展会把 restarts 归零。
// 达到上限后不再重跑，直接记录 restart_limit，避免“启动即崩溃”的作业无限循环。
const RESTART_LIMIT = 5;

/**
 * The records of one job name on one object. The live attempt's `Job` invokes and finishes its runs; between live
 * attempts, committed runs not yet invoked and runs whose outcome is recorded wait for the next one.
 */
// 生命周期：随对象第一次声明该作业时创建，随对象 drop 结束；跨多个 attempt 保持同一实例（记录不随代码版本重建）。
// #job 只在 live attempt 期间非空；没有 live attempt 时运行进入 #waiting，等 attach 时统一分派。
export class JobRecords {
	/** The latest declaration's definition: a reload's new attempt redefines it; each run keeps its own version. */
	// 新运行的 version/fingerprint 取自这里；旧运行仍保存自己的 version，读取参数/结果时按需映射。
	definition: JobDefinition<unknown, unknown, unknown>;
	readonly running: Running;
	readonly #owner: RecordsOwner;
	#states: RunStates | undefined;
	/** The store side of a persisted job's state documents; `undefined` in memory. */
	readonly #statePersistence: Persistence | undefined;
	/** The store side of a persisted job's runs; `undefined` in memory. */
	readonly #persisted: PersistedRuns | undefined;
	// 运行索引：按 id 查运行（outcome/abort/state 变化），按 key 查去重对象。
	readonly #runs = new Map<string, JobRun>();
	readonly #keys = new Map<string, JobRun>();
	/** Running and finishing runs: concurrency and keep-alive count them. */
	// 只统计 running/finishing；blocked 不计入并发，但仍占着记录和键。
	#active = 0;
	/** The live attempt's job; `undefined` between live attempts. */
	#job: Job | undefined;
	/** Runs waiting for a live attempt: to be invoked (`invocation` pending) or finished (phase `finishing`). */
	readonly #waiting = new Set<JobRun>();
	/** Runs a clean stop cut off whose record the close writer has not written `stopped` yet. */
	// 只有持久化作业会加入：clean stop 时先标记 stopped，对象排空后由 writeAtClose 一次性落盘。
	readonly #stopped = new Set<JobRun>();
	/** Whether a persisted job's records were loaded (once per object). */
	#loaded = false;
	/** The object's end error, once it ended. */
	#ended: ChordError | undefined;
	/** Whether the latest live attempt declares the job: its runs are blocked `version` while it does not. */
	#declared = true;

	constructor(definition: JobDefinition<unknown, unknown, unknown>, owner: RecordsOwner) {
		this.definition = definition;
		this.#owner = owner;
		const { state, persist, name } = definition;
		// 非持久化作业没有 store，owner.store 必须为 undefined；持久化作业在这里拿到 store 与对象 owner 名。
		// 本文件中的 ! 断言都建立在“persist 声明与 owner.store 由 host 同步提供”的内部不变量上。
		const store = persist === undefined ? undefined : owner.store!;
		// 两条独立 Persistence：chord.job-states 给状态文档，chord.jobs 给运行记录；namespace 由 Chord 独占。
		const persistence =
			store === undefined ? undefined : new Persistence(store.store, store.owner, "chord.job-states", name);
		this.#statePersistence = persistence;
		this.#states = state === undefined ? undefined : this.#runStates(state);
		this.#persisted =
			store === undefined
				? undefined
				: new PersistedRuns(new Persistence(store.store, store.owner, "chord.jobs", name), persistence!);
		// running 绑定到对象当前的 batch：所有条目变化都在对象事务的批次内发布。
		this.running = new Running(owner.documents.batch, this.name);
	}

	/** The run state documents of `state`, reporting their changes to `running` and their held deadlines. */
	// 输入状态定义；输出 RunStates。changed 回调把状态 op 投影到 running 条目，held 回调交给对象定时器。
	#runStates(state: NonNullable<JobDefinition<unknown, unknown, unknown>["state"]>): RunStates {
		const owner = this.#owner;
		const states = {
			documents: owner.documents,
			changed: (id: string, ops: readonly Op[]) => this.#stateChanged(id, ops),
			held: (deadline: number) => owner.held(deadline),
		};
		return new RunStates(state, states, this.#statePersistence);
	}

	/**
	 * Refuses a declaration of this job that its records cannot take (slice 7b §8): the same version with another
	 * fingerprint (its args, result or state schema changed without a version bump), or a state document definition
	 * the run documents refuse (`SlotDefinition.check`). A reload's staging checks it too.
	 */
	// 输入同名的 JobDefinition；输出 void，拒绝时抛普通 Error（声明错误，不是运行期 ChordError）。
	// 只在版本相同而 fingerprint 不同时拒绝；版本变化是合法 reload，交给 redefine 接管。
	// 状态定义变化交给 SlotDefinition.check：判断已有文档能否按新 schema 迁移/继续使用。
	check(definition: JobDefinition<unknown, unknown, unknown>): void {
		const current = this.definition;
		if (definition.version === current.version && definition.fingerprint !== current.fingerprint) {
			throw new Error(`${this.name}: its schema changed without a version bump (version ${definition.version})`);
		}
		const { state } = definition;
		const states = this.#states;
		if (state !== undefined && states !== undefined && state !== states.definition.current) {
			states.definition.check(state);
		}
	}

	/**
	 * Takes a new attempt's declaration `definition` (another version after a reload, `ChordObject.checkJob` refused
	 * the same version with another fingerprint): new runs are of its version; the runs of others keep theirs, their
	 * `running` entries show their args mapped forwards (or blocked); their state documents keep their version until
	 * their run settles or moves to the new code.
	 */
	// 输入新声明；输出 void。幂等：同一 definition 对象直接返回。
	// 副作用：更新定义与状态定义；若已有运行，在对象的 batch 内重算它们 running 条目里的 args/state 投影。
	redefine(definition: JobDefinition<unknown, unknown, unknown>): void {
		this.#declared = true;
		if (definition === this.definition) return;
		this.definition = definition;
		const { state } = definition;
		if (state !== undefined) {
			// 新版本首次引入 state：现在创建状态文档管理；已有状态：把定义换成新的（旧文档按需迁移）。
			if (this.#states === undefined) this.#states = this.#runStates(state);
			else this.#states.redefine(state);
		}
		if (this.#runs.size === 0) return;
		// within 让所有条目替换在同一个批次/事务边界内，watcher 只看到一帧。
		this.#owner.documents.batch.within(() => {
			// entry 为 undefined 的运行表示 running 条目尚未建立（加载中/已结束），跳过。
			for (const run of this.#runs.values()) if (run.entry !== undefined) this.#replaceEntry(run);
		}, this.#owner.context);
	}

	/**
	 * The latest live attempt does not declare the job (slice 7b §8): its runs not invoked and its finishing runs are
	 * blocked `version` (kept, not invoked) until a reload declares it again or they are aborted; a running
	 * invocation finishes and is blocked then.
	 */
	// 输入无；输出 void。只处理等待中的运行（尚未被任何 live attempt 调用/收尾的）。
	// 每个等待运行写一条 block/version 记录；正在运行的 invocation 不在这里切断，等它结束时再 block。
	undeclare(): void {
		if (!this.#declared || this.#ended !== undefined) return;
		this.#declared = false;
		this.#job = undefined;
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		// record 是异步的，但这里不等待：blocked 状态会在记录提交后生效；void 明确表示有意丢弃 Promise。
		for (const run of waiting) void this.record(run, { kind: "block", run, reason: "version" });
	}

	/**
	 * A reload brought new code (its attempt is live): blocked runs are retried, once: a `finish_failed` one finishes
	 * again, a `version` one whose version the code now takes (its own, or an older one with an adapter) is invoked or
	 * finished; the others stay blocked. A persisted run blocked at its load has its state document read first.
	 */
	// 输入 context（读取旧版本状态文档用）；输出 Promise，完成一次重试扫描。
	// 流程：筛选可重试的 blocked -> 读旧状态文档（失败则整体保持 blocked）-> 一个事务内全部 unblock。
	async retryBlocked(context: Context): Promise<void> {
		if (!this.#declared || this.#ended !== undefined) return;
		// finish_failed 与版本无关，总是重试；version 只有当前代码能接管时才重试。
		const retried = [...this.#runs.values()].filter(
			(run) => run.phase === "blocked" && (run.blocked === "finish_failed" || this.#takes(run)),
		);
		if (retried.length === 0) return;
		try {
			// blockedPhase 存在表示它在 load 时因版本不匹配被 block，状态文档从未解码；现在代码能接管，先读出来。
			for (const run of retried) if (run.blockedPhase !== undefined) await this.#readBlockedState(run, context);
		} catch {
			// Its state document cannot be read: it stays blocked (the next reload tries again).
			return;
		}
		const { documents } = this.#owner;
		try {
			// documents.own 是对象自身的 token（不是某次 invocation 的 token）：这个事务不属于任何运行。
			await documents.tx(
				(tx) => {
					for (const run of retried) {
						// 事务创建前世界可能已变：再次确认仍是同一个运行且仍 blocked，避免重复 unblock。
						if (this.#runs.get(run.id) !== run || run.phase !== "blocked") continue;
						// 已有 outcome：回 finishing 重新走 finish；持久化运行无 outcome 则回 pending（等 reservation），
						// 内存运行直接回 running（无持久化恢复语义）。
						const phase =
							run.outcome !== undefined ? "finishing" : this.#persisted === undefined ? "running" : "pending";
						this.change(tx, { kind: "unblock", run, phase });
					}
				},
				documents.own,
				this.#owner.context,
			);
		} catch {
			// The object ended.
		}
	}

	/** Reads and decodes the state document of a persisted run blocked at its load, now that the code takes it. */
	// 输入 blocked 的旧版本运行；输出 Promise<void>。
	// 副作用：forgetBlockedState 取消“不解码退役”标记；解码成功后把文档登记进 RunStates，并补进 outcome.state。
	async #readBlockedState(run: JobRun, context: Context): Promise<void> {
		const states = this.#states;
		this.#persisted!.forgetBlockedState(run.id);
		if (states === undefined) return;
		const document = await states.persistence.read(run.id, context);
		if (document === undefined) return;
		// decode 使用当前状态定义：旧 schema 的文档在这里迁移或按定义拒绝。
		const { value, stored } = states.persistence.decode(document, states.definition.current, context);
		states.create(run.id, value, stored);
		// outcome 里保存的是结束时的状态快照；迁移后同步替换，保证 finish 看到当前形状。
		if (run.outcome !== undefined) run.outcome = { ...run.outcome, state: value };
	}

	/**
	 * Whether the current code takes `run`: of its version and fingerprint, or of an older version its `accepts` maps
	 * forwards; a newer one (a rollback) or an older one without an adapter is not (`blocked { version }`).
	 */
	// 版本相同：指纹也必须相同（同版本改 schema 是非法声明）。版本更旧：必须有该版本的 accepts 适配器。
	// 版本更新（代码回滚）：当前代码无法解释，也不尝试反向映射。
	#takes(run: JobRun): boolean {
		const { definition } = this;
		if (run.version === definition.version) return run.fingerprint === definition.fingerprint;
		return run.version < definition.version && definition.accepts[run.version] !== undefined;
	}

	/**
	 * `run`'s args as the code of `definition` takes them (the current code's, or an invoking attempt's own): mapped
	 * forwards once per run and version when older.
	 */
	// 输入运行与目标定义；输出映射后的 JSON 参数。
	// 映射结果缓存在 run.mapped（按目标版本）：同一运行被多个 attempt 处理时只映射一次。
	// accepts 的结果不做 schema 校验（适配器负责）；as never 用于绕过 accepts 的版本联合类型收窄。
	argsOf(run: JobRun, definition: JobDefinition<unknown, unknown, unknown>): JsonValue {
		if (run.version === definition.version) return run.args;
		const mapped = run.mapped;
		if (mapped !== undefined && mapped.version === definition.version) return mapped.args;
		// `#takes` found the adapter; its result is the current args (the provider's mapping, not validated).
		const args = definition.accepts[run.version]!.args(run.args as never) as JsonValue;
		run.mapped = { version: definition.version, args };
		return args;
	}

	/**
	 * `run`'s outcome as the current code's `finish` gets it: an older run's args and result mapped forwards (once per
	 * run), its state document migrated to the current state definition.
	 */
	// 输入已完成（outcome 已记录）的运行；输出当前代码可消费的 AnyOutcome。
	// 先确保 args 映射已发生（argsOf 会写 run.mapped），再映射结果；失败结果只保留原错误，不映射。
	// 状态文档用 states.migrated 迁移到当前定义；没有状态定义时沿用原值。
	outcomeOf(run: JobRun, context: Context): AnyOutcome {
		const outcome = run.outcome!;
		const { definition } = this;
		if (run.version === definition.version) return outcome;
		const args = this.argsOf(run, definition);
		const mapped = run.mapped!;
		if (mapped.outcome !== undefined) return mapped.outcome;
		const result =
			outcome.kind === "done"
				? { kind: "done" as const, result: definition.accepts[run.version]!.result(outcome.result as never) }
				: { kind: "failed" as const, error: outcome.error };
		const state = this.#states?.migrated(run.id, context) ?? outcome.state;
		mapped.outcome = { id: outcome.id, args, state, ...result };
		return mapped.outcome;
	}

	/** The job in errors: its object and its name. */
	// 错误信息里同时出现对象 label 与作业名，便于在链接/日志里定位是哪个对象的哪个作业。
	get name(): string {
		return `${this.#owner.label} job ${this.definition.name}`;
	}

	/** Waits for the outcome of the unsettled run `id`; a settled or unknown id rejects `gone`. */
	// 未知 id 或已结算（记录已删除）都按 gone 拒绝；进行中的运行通过 handle.outcome 等待。
	outcome(id: string, context: Context): Promise<AnyOutcome> {
		const run = this.#runs.get(id);
		if (run === undefined) {
			return Promise.reject(new ChordError({ code: "gone", message: `${this.name}: no unsettled run ${id}` }));
		}
		return run.handle.outcome(context);
	}

	/**
	 * Aborts run `id` (D7, Durable's `abortTask`): a blocked run is dropped; a finishing one is only marked; any other
	 * is marked (stored for a persisted job) in a transaction, its signal fired after the commit, outside the batch and
	 * the line, and the abort joins its invocation. `"marked"`, or `"terminal"` when no unsettled run has that id.
	 */
	// 输入运行 id 与 context；输出 "marked" 或 "terminal"。
	// blocked：drop 记录后立即返回（不会运行，无需信号）；finishing：只记录标记，结果保留；
	// 其他：先持久化 abortMarked（持久化作业崩溃后可识别），提交后才触发 abort signal 并等待调用结束。
	async abort(id: string, context: Context): Promise<"marked" | "terminal"> {
		const run = this.#runs.get(id);
		if (run === undefined || this.#ended !== undefined) return "terminal";
		if (run.phase === "blocked") {
			await this.record(run, { kind: "drop", run });
			return "marked";
		}
		// abortMarked 是持久化字段：只写一次，避免每次 abort 都产生事务。
		if (!run.abortMarked) await this.record(run, { kind: "update", run, fields: { abortMarked: true } });
		// A finishing run's outcome stays: it is only marked.
		if (run.phase === "finishing") return "marked";
		// 提交后才触发信号：保证“已标记”先于“已取消”被持久化，恢复时不会把取消当成崩溃。
		run.invocation?.abort.abort(new ChordError({ code: "aborted", message: `${this.name}: run ${id} aborted` }));
		// over 等待 invocation 真正结束（abort 事件是异步传播的）。
		await run.over(context);
		return "marked";
	}

	/** See `Job.stage`: the checks and the staged creation, against the object's runs. */
	// 输入已打开的事务、插件参数、context 与 StartOptions；输出 Run<AnyOutcome>（handle 立即返回）。
	// 检查顺序：参数 schema -> 同事务 key 去重 -> 已有 key 去重 -> 并发上限 -> 创建记录。
	// 副作用：JobRun 加入 staging.started、记录 change 排进提交、初始状态文档 stageCreate。
	stage(tx: Transaction, args: unknown, context: Context, options: StartOptions): Run<AnyOutcome> {
		const definition = this.definition;
		// Plugin code, not type-checked: the args are checked as a method's are (R7).
		// 运行期信任边界：TypeScript 的 args 泛型不保证 JS 调用者；编译后的 validator 在这里拒绝非法参数。
		check(validatorFor(definition.args, context), args, "args", context);
		const staged = tx.staged<Staging>(this);
		const { key } = options;
		if (key !== undefined) {
			// 同一事务里先找 started（尚未 adopt），再找已提交的 #keys；两者都算“同 key 已存在”。
			const known = staged?.started.find((run) => run.key === key) ?? this.#keys.get(key);
			// 正在 finish 的运行不阻止同 key 新运行：它的记录即将删除，键应让给后继者。
			if (known !== undefined && known !== staged?.finishing) return known.handle;
		}
		const { concurrency } = definition;
		// 本事务已启动的数量计入并发；本事务正在 finish 的运行从活跃数里扣除（它即将结束）。
		const active = this.#active + (staged?.started.length ?? 0) - (staged?.finishing === undefined ? 0 : 1);
		if (concurrency !== undefined && active >= concurrency) {
			const message = `${this.name}: at its concurrency limit (${concurrency})`;
			throw new ChordError({ code: "unavailable", reason: "busy", message });
		}
		const persisted = this.#persisted !== undefined;
		// 持久化运行把 trace 上下文注入记录，恢复后仍能关联原来的遥测链路；内存运行不需要。
		const trace = persisted ? context.telemetry.propagation?.inject(context.telemetry) : undefined;
		// Checked above: the args are JSON (the definition refuses bytes).
		// 持久化运行先记 pending，等 reservation 提交后才变 running；内存运行直接 running。
		const run = new JobRun(
			uuidv7(),
			definition.version,
			definition.fingerprint,
			key,
			args as JsonValue,
			persisted ? "pending" : "running",
			trace,
		);
		const staging = this.staging(tx);
		staging.started.push(run);
		this.change(tx, { kind: "create", run });
		// 初始状态就是在创建这次提交里生成的；stageCreate 的 adoption 在 store 写成功后更新内存位置。
		const state = definition.state?.initial(context);
		if (state !== undefined) staging.adopts.push(this.#states!.stageCreate(run.id, state, () => this.#store(tx)));
		return run.handle;
	}

	/**
	 * Stages `change` in `tx`: in the job's staging, adopted in the commit step, and for a persisted job the run's record
	 * written with it (rule 8: serialized now), and for a settled run its state document retired.
	 */
	// 输入事务与变更；输出 void。所有记录变更的唯一入口（stage 的 create 也走这里）。
	// 删除类变更先退役状态文档；持久化作业再排入记录文档的写入或退役；adoption 统一进 staging.adopts。
	change(tx: Transaction, change: RecordChange): void {
		const staging = this.staging(tx);
		staging.changes.push(change);
		const { run } = change;
		const states = this.#states;
		const retires = change.kind === "delete" || change.kind === "drop";
		// current(id) 非 undefined 才说明状态文档已登记；未登记时没有可退役的槽。
		if (retires && states?.current(run.id) !== undefined) tx.retireSlot(states, run.id);
		const persisted = this.#persisted;
		if (persisted === undefined) return;
		const writes = this.#store(tx);
		if (retires) {
			// 持久化记录与状态文档一起退役；提交成功后 adoption 清内存映射。
			staging.adopts.push(persisted.stageRetire(run.id, writes));
			return;
		}
		// recordFields 把本次变更映射成存储字段；storedRun 组装完整记录（总是整份 base）。
		const fields = recordFields(change);
		staging.adopts.push(persisted.stage(run.id, storedRun(run, fields), writes));
	}

	/** This job's changes in `tx`, made on the first. */
	// 输入事务；输出 Staging。tx.stage 保证每个 (事务, JobRecords) 只创建一次槽。
	// 三个回调的时序：adopt 在提交步骤内（内存可见），committed 在提交成功后（兑现 handle），discarded 在事务失败时。
	staging(tx: Transaction): Staging {
		return tx.stage(this, () => {
			const changes: Adopted[] = [];
			const adopts: (() => void)[] = [];
			return {
				started: [],
				changes,
				adopts,
				finishing: undefined,
				adopt: () => {
					// A step admitted before the object ended adopts after it: the records are not changed any more.
					// 对象已经结束（例如提交步骤排空期间收到 end）：不再改内存/计数，避免结束后的状态漂移。
					if (this.#ended !== undefined) return;
					// What is stored first: a new run's state document exists when its `running` entry is made.
					// 先执行 store 侧 adoption（更新 revision/初始状态位置），再改内存，保证 entryOf 读到的 state 已登记。
					runAll(adopts);
					for (const change of changes) this.#adopt(change);
				},
				committed: () => {
					const ended = this.#ended;
					if (ended === undefined) {
						for (const change of changes) this.#committed(change);
						return;
					}
					// 提交成功但对象已在提交期间结束：新建运行的 handle 用对象结束错误拒绝；其余变更不再兑现。
					// Its runs end as the object's other runs did.
					for (const change of changes) if (change.kind === "create") change.run.reject(ended);
				},
				discarded: () => {
					// 事务失败/被丢弃：本事务里创建的 handle 立即以 released/discarded 拒绝，调用方不会永远等待。
					for (const change of changes) if (change.kind === "create") change.run.reject(this.#discarded());
				},
			};
		});
	}

	/**
	 * A persisted job's runs, loaded once per object at its first activation (slice 6b §4.2), again only after a load
	 * failed (design §9): each record read; a record of another version or fingerprint blocked (`version`) as stored,
	 * its state document left undecoded; the others' state documents read and decoded, a run cut off while `running`
	 * counted (`restarts + 1`; at the limit it ends `restart_limit`, reported `job_interrupted`), `stopped` and
	 * `pending` ones made `pending` again. The runs and their activation changes are adopted in one commit, all before
	 * anything runs; a failure leaves nothing loaded.
	 */
	// 输入 context；输出 Promise<void>。内存作业或已加载过（#loaded）直接返回。
	// 流程：分页读记录 -> #restored 逐条重建 JobRun 并计算激活 change -> 一个事务提交全部 restore+change ->
	// 上报 restart_limit 的 job_interrupted -> 逐条 #need 进入分派。
	// 失败处理：清空 PersistedRuns 内存位置、退役已建状态，再原样抛出；#loaded 不置位，下次激活可重试。
	async load(context: Context): Promise<void> {
		const persisted = this.#persisted;
		if (persisted === undefined || this.#loaded) return;
		const restored: Restored[] = [];
		try {
			for (const loaded of await persisted.load(context)) restored.push(await this.#restored(loaded, context));
			if (restored.length > 0) {
				const { documents } = this.#owner;
				// documents.own：加载事务不属于任何运行；所有恢复在同一个提交里可见，避免一半运行先跑。
				await documents.tx((tx) => this.#restoreAll(tx, restored), documents.own, context);
			}
		} catch (error) {
			// 回滚内存侧：store 位置与已登记状态都不能留下，否则下次 load 会读到过期映射。
			persisted.drop();
			for (const { run } of restored) this.#states?.retire(run.id);
			throw error;
		}
		this.#loaded = true;
		// 达到重启上限的结局需要额外报告；它已经在 #restored 里成为 outcome，不会被再次运行。
		for (const { run, change } of restored) {
			if (
				change?.kind === "outcome" &&
				change.outcome.kind === "failed" &&
				change.outcome.error.kind === "restart_limit"
			) {
				this.report({ kind: "job_interrupted", id: run.id, restarts: change.outcome.error.restarts });
			}
		}
		// 提交完成后才分派：没有 live attempt 时进入 #waiting，有则立即 invoke/finish。
		for (const { run } of restored) this.#need(run);
	}

	/** Stages the loaded runs in `tx`: each restored, then the activation changes (adopted after every restore). */
	// restore 全部排在 change 之前：保证 #adopt 处理 update/outcome 时运行与 running 条目已经存在。
	#restoreAll(tx: Transaction, restored: readonly Restored[]): void {
		const staging = this.staging(tx);
		for (const { run } of restored) staging.changes.push({ kind: "restore", run });
		for (const { change } of restored) if (change !== undefined) this.change(tx, change);
	}

	/** `job`, of the attempt that went live, invokes and finishes the runs from now on; the waiting ones first. */
	// 输入 live attempt 的 Job；输出 void。先复制再清空 #waiting，防止分派过程中 #need 再次写入造成迭代错乱。
	attach(job: Job): void {
		if (this.#ended !== undefined) return;
		this.#job = job;
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		for (const run of waiting) this.#dispatch(run, job);
	}

	/**
	 * `job`'s attempt was sealed: its running invocations are cut off (`cut`), the runs it was finishing wait for the
	 * next live attempt.
	 */
	// 输入正在 seal 的 Job 与其 finish 集合；输出 void。
	// 只清掉“当前 job”指针；运行中的 invocation 由 Job.seal 自己调用 cut，这里只把 finish 中的运行放回等待。
	detach(job: Job, finishing: Iterable<JobRun>): void {
		if (this.#job === job) this.#job = undefined;
		for (const run of finishing) this.#need(run);
	}

	/**
	 * A run whose reservation its sealed attempt never committed waits for the next live attempt (dispatched now when one
	 * is attached already: the sealed attempt was detached at its seal).
	 */
	// 用于 reservation 提交因 seal 被拒绝的运行：记录仍是 pending，交给下一个 live attempt。
	requeue(run: JobRun): void {
		this.#need(run);
	}

	/** Records `run` running before its `run` is invoked (a persisted run's reservation: a crash after it counts). */
	// 只更新 phase：持久化记录中出现 running 后，任何后续崩溃都会被 load 计入 restarts。
	reserve(tx: Transaction, run: JobRun): void {
		this.change(tx, { kind: "update", run, fields: { phase: "running" } });
	}

	/** A state change of a run with restarts counted resets them in its commit (progress, D6). */
	// restarts != 0 表示恢复后还带着上次崩溃的计数；一次成功的状态变更即证明有进展，同事务归零。
	progressed(tx: Transaction, run: JobRun): void {
		if (run.restarts !== 0) this.change(tx, { kind: "update", run, fields: { restarts: 0 } });
	}

	/**
	 * A run's invocation settled: its outcome is recorded (phase `finishing`) in a transaction of the object behind the
	 * state changes admitted before, so `outcome.state` has them; then it is finished on the live attempt.
	 */
	// 输入运行与结束结果；输出 void（#recordOutcome 的 Promise 有意不等待，调用方不阻塞在记录上）。
	// 放到对象线上、排在已接纳的状态变更之后，是为了让 outcome.state 包含运行最后写入的状态。
	settled(run: JobRun, ended: Settled): void {
		void this.#recordOutcome(run, ended);
	}

	/**
	 * A running run whose attempt was sealed: its signal fires with `error`, its invocation is fenced (later state
	 * changes refused, the open one discarded, its settling ignored). In memory it ends `failed { aborted }` with
	 * `reason` (`reload` for a native restart, slice 7b §8), finished on the next live attempt; persisted it is stopped (R3), written back by the close writer and
	 * resumed by the next live attempt as after a clean close.
	 */
	// 输入运行、seal 的错误与原因；输出 void。
	// 顺序：settle 围栏（本次调用不再接受状态变更）-> documents.fence（丢弃在途状态事务）-> 触发 abort signal。
	// 持久化运行先记为 stopped 并加入 #stopped，等 close writer 落盘；内存运行立即写 aborted outcome。
	cut(run: JobRun, error: ChordError, reason: CutReason): void {
		// Only an invoked run is cut: its current invocation is the one the seal stops.
		// ! 是内部不变量：cut 只会被 Job 对它当前 invocation 集合里的运行调用。
		const invocation = run.invocation!;
		invocation.settle();
		this.#owner.documents.fence(invocation.token);
		invocation.abort.abort(error);
		if (this.#persisted !== undefined) {
			run.phase = "stopped";
			// Resumed per the job's `resume` (an `abandon` job's run ends `failed { aborted, restart }`).
			// resuming 让 #dispatch 在恢复时区分“重新运行”与“按 abandon 结束”。
			run.resuming = true;
			this.#stopped.add(run);
			if (this.#ended === undefined) this.#need(run);
			return;
		}
		// 内存运行：reload 交接用 reload 原因，其余（对象重启/redefine）用 restart。
		if (this.#ended === undefined) void this.#recordOutcome(run, reason === "reload" ? RELOAD : RESTART);
	}

	/**
	 * Records `change` (a run's finish failure, its block, its drop) in a transaction of the object, if `run` is still
	 * one of its runs there. The object's end ends it.
	 */
	// 输入运行与变更；输出 Promise。对象线事务内再次确认运行仍在 #runs（可能已被并发删除）。
	// 事务失败被吞掉：典型原因是对象结束，此时记录随对象一起消失，没有可写的目标。
	async record(run: JobRun, change: RecordChange): Promise<void> {
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					if (this.#runs.get(run.id) === run) this.change(tx, change);
				},
				documents.own,
				context,
			);
		} catch {
			// The object ended: its runs went with it.
		}
	}

	/**
	 * The close writer (slice 6b §4.2, Durable's `writeAtClose`): one commit past the seal writing the runs a clean stop
	 * cut off `stopped` and every held state change, straight to the store (the object's transactions are refused by
	 * now). Its failure is the store's; the records stay as they were (a crash counts them).
	 */
	// 输入 context（去掉 abort signal，关闭期间对象取消不应中断写回）；输出 Promise。
	// 这一步绕过 documents 事务，直接 store.commit：seal 之后对象线已停止接受提交，但必须把 stopped/held 落盘。
	// fence 用最小对象：admit 恒真，adopt 在提交成功后更新 PersistedRuns/RunStates 内存位置。
	async writeAtClose(context: Context): Promise<void> {
		const persisted = this.#persisted;
		if (persisted === undefined) return;
		const writes: StagedWrite[] = [];
		const adopts: (() => void)[] = [];
		for (const run of this.#stopped) {
			// storedRun 不带字段：记录当前 phase 已是 stopped，storedRun 读取运行时状态生成完整记录。
			adopts.push(persisted.stage(run.id, storedRun(run), writes));
		}
		// 先清 #stopped：无论 store 提交成功与否，这些运行已经尝试写回，不能重复排队。
		this.#stopped.clear();
		for (const id of this.#states?.heldIds ?? []) {
			const adopt = this.#states!.stageHeld(id, writes);
			if (adopt !== undefined) adopts.push(adopt);
		}
		if (writes.length === 0) return;
		const fence = { admit: () => true, adopt: () => runAll(adopts) };
		try {
			await this.#owner.store!.store.commit(writes, fence, withoutAbortSignal(context));
		} catch {
			// The store failed or refused it (reported as the store's): a crash loses as much.
		}
	}

	/** Stores every held state change whose deadline passed (`now`), in one transaction of the object (D8). */
	// 输入当前时间；输出 Promise。heldIds 为空时不开启事务。
	// 只处理 deadline <= now 的文档；其余留到下次定时器。事务失败被吞（对象正在结束，close writer 会兜底）。
	async flushHeld(now: number): Promise<void> {
		const states = this.#states;
		if (states === undefined || states.heldIds.length === 0) return;
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					const staging = this.staging(tx);
					for (const id of states.heldIds) {
						if (states.deadline(id) > now) continue;
						const adopt = states.stageHeld(id, this.#store(tx));
						if (adopt !== undefined) staging.adopts.push(adopt);
					}
				},
				documents.own,
				context,
			);
		} catch {
			// The object is ending: its close writer stores what is held.
		}
	}

	/** The earliest deadline of a held state change (`Infinity`: none). */
	// Math.min 里放入 Infinity 作为空数组的兜底；对象定时器据此设置下一次唤醒。
	nextDeadline(): number {
		const states = this.#states;
		if (states === undefined) return Number.POSITIVE_INFINITY;
		return Math.min(Number.POSITIVE_INFINITY, ...states.heldIds.map((id) => states.deadline(id)));
	}

	/** The value of run `id`'s state document, `undefined` without one or once retired. */
	// 状态文档退役后返回 undefined；#stateOf 会把它转成 released/settled 错误。
	stateOf(id: string): JsonObject | undefined {
		return this.#states?.value(id);
	}

	/** The run state documents, for `ctx.state.change`; `undefined` without a state definition. */
	get states(): RunStates | undefined {
		return this.#states;
	}

	/** Whether the job persists its runs. */
	// job.ts 用它在运行期选择 reservation、stopped/close writer 等持久化路径。
	get persisted(): boolean {
		return this.#persisted !== undefined;
	}

	/**
	 * The object ends: running runs' signals fire, every waiter rejects with `error`; blocked in-memory runs are
	 * dropped (reported), persisted ones keep their records; nothing finishes. The records stay readable until `drop`.
	 */
	// 输入对象结束错误；输出 void。幂等。
	// 不删除记录：调用方可能在 drop 前仍读取 state/outcome；持久化记录保持在 store 里，等恢复或显式清理。
	end(error: ChordError): void {
		if (this.#ended !== undefined) return;
		this.#ended = error;
		this.#job = undefined;
		this.#waiting.clear();
		for (const run of this.#runs.values()) {
			// 内存作业的 blocked 运行没有 store 记录可留，直接报告 job_dropped；持久化的保留给下一个对象实例。
			if (run.phase === "blocked" && this.#persisted === undefined) this.report({ kind: "job_dropped", id: run.id });
			const { invocation } = run;
			invocation?.abort.abort(error);
			run.reject(error);
			// 没有在运行的 invocation（已结束/尚未启动）由这里统一 ended，唤醒等待它的 joins。
			if (invocation?.state !== "running") invocation?.ended();
		}
		// 一次性归还本作业占用的 keep-alive 计数；之后不再有运行结束回调来递减。
		if (this.#active > 0) this.#owner.countRuns(-this.#active);
	}

	/** Its object's documents are dropped: the runs, their state documents and `running`'s watches go. */
	// 对象销毁后的最后清理：内存映射与本对象的观察者全部释放；持久化 store 中的文档不在此删除。
	drop(): void {
		this.#runs.clear();
		this.#keys.clear();
		this.#states?.drop();
		this.#persisted?.drop();
		this.running.end();
	}

	/** Reports a run's failure, drop or interruption to the host. */
	// 统一补充 object/job 字段后转交 host.report；错误内容原样传递，由 host 的观察者决定如何记录。
	report(
		error:
			| { readonly kind: "job_failed" | "job_finish_failed"; readonly id: string; readonly error: unknown }
			| { readonly kind: "job_dropped"; readonly id: string }
			| { readonly kind: "job_interrupted"; readonly id: string; readonly restarts: number },
	): void {
		this.#owner.host.report({ ...error, object: this.#owner.label, job: this.definition.name });
	}

	/** The store writes of `tx` (Chord's own documents of a persisted job). */
	// 把事务的 store 写入数组取出；持久化作业的每一步都通过它把文档写入与记录变化放进同一提交。
	#store(tx: Transaction): StagedWrite[] {
		return tx.stageStore(this.#owner.store!.store);
	}

	/**
	 * The run a loaded record stands for and the change its activation writes (D6): a record of another version or
	 * fingerprint blocked as stored (its state document only found, never decoded: slice 7 maps it); otherwise its state
	 * document read and decoded (migrated), pinned while it is unsettled, a crash counted, at the limit its outcome,
	 * marked resuming unless blocked or finishing.
	 */
	// 输入一条 LoadedRecord 与 context；输出 Restored（JobRun 与可选激活 change）。
	// 分支要点：版本/指纹不匹配 -> blocked/version，保留 blockedPhase 与已存在 outcome，状态文档只记位置不解码；
	// 匹配 -> 读/解码状态文档，phase 为 running 时计 restarts，达到上限转 outcome/restart_limit；
	// stopped/pending 回到 pending 并标记 resuming；finishing 等保持原样（无需 change）。
	async #restored(loaded: LoadedRecord, context: Context): Promise<Restored> {
		const { id, record } = loaded;
		const { definition } = this;
		const run = new JobRun(
			id,
			record.version,
			record.fingerprint,
			record.key,
			record.args,
			record.phase,
			record.trace,
		);
		run.restarts = record.restarts;
		run.finishFailures = record.finishFailures;
		run.abortMarked = record.abort === true;
		const states = this.#states;
		if (record.version !== definition.version || record.fingerprint !== definition.fingerprint) {
			run.phase = "blocked";
			run.blocked = "version";
			// What the record says, for the reload that brings its version (`retryBlocked`).
			// 保存原 phase：等能接管它的代码出现时，决定是重新 invoke 还是直接 finish。
			run.blockedPhase = record.phase;
			// 旧 outcome 的参数/结果无法用当前代码解释，state 传 undefined；等接管后用 outcomeOf 再映射。
			if (record.outcome !== undefined) run.outcome = outcomeOf(record.outcome, id, record.args, undefined);
			// What is stored of its state (also when this version declares none), so an abort drops it with the record.
			await this.#persisted!.findBlockedState(id, context);
			return { run, change: undefined };
		}
		// 匹配分支：状态文档存在则解码登记；不存在表示运行开始时没有状态或文档已退役。
		const document = await states?.persistence.read(id, context);
		if (document !== undefined) {
			const { value, stored } = states!.persistence.decode(document, states!.definition.current, context);
			states!.create(id, value, stored);
		}
		if (record.outcome !== undefined) run.outcome = outcomeOf(record.outcome, id, record.args, this.stateOf(id));
		run.blocked = record.blocked;
		// 按存储的 phase 决定激活动作；switch 覆盖 StoredRun 的全部 phase。
		switch (record.phase) {
			case "running": {
				// 记录仍是 running 说明上次对象在运行中崩溃：restarts + 1 代表一次中断。
				const restarts = record.restarts + 1;
				run.resuming = true;
				if (restarts < RESTART_LIMIT) {
					// 未达上限：回到 pending 重新运行（reservation 后变 running）。
					return { run, change: { kind: "update", run, fields: { phase: "pending", restarts } } };
				}
				// 达到上限：把 run 自身计数同步为上限值，并直接生成 restart_limit 结局（不再运行）。
				run.restarts = restarts;
				const outcome = this.#outcome(run, { kind: "failed", error: { kind: "restart_limit", restarts } });
				return { run, change: { kind: "outcome", run, outcome } };
			}
			case "stopped":
				// 干净停止：不增加崩溃计数，回到 pending 等分派（resume=abandon 时由 #dispatch 结束）。
				run.resuming = true;
				return { run, change: { kind: "update", run, fields: { phase: "pending" } } };
			case "pending":
				// 已提交但从未启动：直接等待分派，记录无需改写。
				run.resuming = true;
				return { run, change: undefined };
			default:
				// finishing：outcome 已记录，等下一个 live attempt 执行 finish；blocked 也保持原状。
				return { run, change: undefined };
		}
	}

	/** Records the outcome of `run` (with what its state holds, D8), then has it finished on the live attempt. */
	// 输入运行与结果；输出 Promise。事务内先写 outcome，再把该运行持有的状态变更 stageHeld 一并落盘。
	// 无论提交成功与否，finally 都关闭 invocation 的等待；成功后 #need 把运行交给 live attempt 收尾。
	async #recordOutcome(run: JobRun, ended: Settled): Promise<void> {
		const { documents, context } = this.#owner;
		try {
			await documents.tx(
				(tx) => {
					const outcome = this.#outcome(run, ended);
					this.change(tx, { kind: "outcome", run, outcome });
					// What its state holds is stored before the outcome is recorded (D8).
					// 同一事务里落盘延迟状态：在记录顺序上等价于“状态先提交、outcome 后提交”。
					const adopt =
						this.#persisted === undefined ? undefined : this.#states?.stageHeld(run.id, this.#store(tx));
					if (adopt !== undefined) this.staging(tx).adopts.push(adopt);
				},
				documents.own,
				context,
			);
		} catch {
			// The object ended: nothing finishes.
			return;
		} finally {
			// A run ending without an invocation (marked aborted, abandoned, cut off in memory) has none to wait for.
			run.invocation?.ended();
		}
		this.#need(run);
	}

	/** `run`'s outcome for `ended`, with its args and its state as it is now. */
	// 组装 AnyOutcome：运行身份 + 原始 args + 当前状态快照 + 结束结果。旧版本运行的映射在 outcomeOf 里做。
	#outcome(run: JobRun, ended: Settled): AnyOutcome {
		return { id: run.id, args: run.args, state: this.stateOf(run.id), ...ended };
	}

	/** `run` needs a live attempt (to be invoked or finished): now, or once one attaches. */
	// 分派前的守门：对象已结束/运行已不在册则忽略；作业未被声明则 block/version；有 live job 立即分派，否则排队。
	#need(run: JobRun): void {
		if (this.#ended !== undefined || this.#runs.get(run.id) !== run) return;
		// A job the code no longer declares: blocked `version`, kept (slice 7b §8).
		if (!this.#declared) {
			if (run.phase !== "blocked") void this.record(run, { kind: "block", run, reason: "version" });
			return;
		}
		const job = this.#job;
		if (job === undefined) this.#waiting.add(run);
		else this.#dispatch(run, job);
	}

	/**
	 * Invokes or finishes `run` on `job`, as its record stands: a finishing run is finished; a run not invoked yet is
	 * invoked, unless it is marked aborted (it ends `aborted` without `run`) or resumes abandoned (`failed { aborted,
	 * reason: "restart" }`).
	 */
	// 输入运行与 live Job；输出 void。分派优先级：版本不可接管 -> block；finishing -> finish；
	// 已 invoked 的重复 #need -> 忽略；已标记 abort -> 不运行直接记录 aborted；
	// 恢复且 resume=abandon -> 不运行直接记录 restart；其余清 resuming 后 invoke。
	#dispatch(run: JobRun, job: Job): void {
		if (this.#runs.get(run.id) !== run || run.phase === "blocked") return;
		// Not of a version the code takes: blocked `version` until a reload brings matching code.
		if (!this.#takes(run)) {
			void this.record(run, { kind: "block", run, reason: "version" });
			return;
		}
		if (run.phase === "finishing") {
			job.finish(run);
			return;
		}
		// invoked 为真表示已有 invocation 在跑（或已结束待记录）：不能重复启动。
		if (run.invoked) return;
		if (run.abortMarked) {
			void this.#recordOutcome(run, ABORTED);
			return;
		}
		if (run.resuming && this.definition.persist?.resume === "abandon") {
			void this.#recordOutcome(run, RESTART);
			return;
		}
		run.resuming = false;
		job.invoke(run);
	}

	/**
	 * Adopts one record change, inside the commit step: the maps, the active count, `running`. A new run is counted for
	 * its object here, before the commit's publication (a link closing while it sends may release the object's last
	 * reference) and before any run of the same commit settles in `#committed`.
	 */
	// 只改内存与观察者视图，不做 I/O；每个 change 在提交步骤内恰好调用一次。
	// create/restore：登记 map、key、活跃计数，创建 running 条目；update：Object.assign 字段并替换条目；
	// outcome：存结果并进入 finishing；block/unblock：切换 blocked 与活跃计数；delete/drop：移出索引与列表。
	#adopt(change: Adopted): void {
		const { run } = change;
		switch (change.kind) {
			case "create":
			case "restore":
				this.#runs.set(run.id, run);
				if (run.key !== undefined) this.#keys.set(run.key, run);
				// blocked 的运行不占并发（例如加载出的版本不匹配记录）。
				if (run.phase !== "blocked") {
					this.#active++;
					this.#owner.countRuns(1);
				}
				run.entry = this.#entryOf(run);
				this.running.add(run.entry);
				return;
			case "update":
				// RunFields 可能含 phase/restarts/finishFailures/abortMarked，直接覆盖运行时对象的同名字段。
				Object.assign(run, change.fields);
				this.#replaceEntry(run);
				return;
			case "outcome":
				run.outcome = change.outcome;
				run.phase = "finishing";
				this.#replaceEntry(run);
				return;
			case "block":
				run.phase = "blocked";
				run.blocked = change.reason;
				this.#active--;
				this.#replaceEntry(run);
				return;
			case "unblock":
				run.phase = change.phase;
				run.blocked = undefined;
				run.blockedPhase = undefined;
				run.finishFailures = 0;
				// A persisted run to be invoked again resumes per its job's `resume`, as after a stop.
				if (change.phase === "pending") run.resuming = true;
				this.#active++;
				this.#owner.countRuns(1);
				this.#replaceEntry(run);
				return;
			case "delete":
			case "drop":
				this.#runs.delete(run.id);
				// The finishing run's key may name its successor already, started in the same commit.
				// 只有该 key 仍指向本运行才删除，避免把同事务新启动的后继者从索引里删掉。
				if (run.key !== undefined && this.#keys.get(run.key) === run) this.#keys.delete(run.key);
				// drop 的 blocked 运行本来就不计入 active；delete 的 finishing 运行需要归还计数。
				if (change.kind === "delete") this.#active--;
				// entry 一定存在（create/restore 已建立）；! 表达内部不变量。
				this.running.remove(run.entry!);
				run.entry = undefined;
				return;
		}
	}

	/** The actions after a record change committed. */
	// 提交成功后的副作用：create 排队到微任务再分派（此时事务已结束、批次外）；
	// delete 归还 keep-alive 并兑现 handle；block 只归还计数；unblock 重新分派；drop 报告并拒绝 handle。
	#committed(change: Adopted): void {
		const { run } = change;
		switch (change.kind) {
			case "create":
				// After the commit, outside the batch, once the transaction settled; on the live attempt, or the next.
				// 微任务避开当前批次与提交步骤：运行时对象可能在这期间结束，但 handle 已可等待。
				queueMicrotask(() => this.#need(run));
				return;
			case "restore":
			case "update":
			case "outcome":
				return;
			case "delete":
				this.#owner.countRuns(-1);
				// delete 只发生在 finish 提交成功后：此时 run.outcome 必然已设置，! 表达该先决条件。
				run.resolve(run.outcome!);
				return;
			case "block":
				this.#owner.countRuns(-1);
				return;
			case "unblock":
				this.#need(run);
				return;
			case "drop":
				this.report({ kind: "job_dropped", id: run.id });
				run.reject(new ChordError({ code: "aborted", message: `${this.name}: run ${run.id} dropped` }));
				return;
		}
	}

	/** A run's state document changed by `ops`, inside the commit step: its entry is replaced. */
	// 输入运行 id 与状态文档内部的 op；输出 void。
	// 找到运行且已有 running 条目时，用同一次状态变化替换条目，并把 op 重新挂到条目的 state 下。
	#stateChanged(id: string, ops: readonly Op[]): void {
		const run = this.#runs.get(id);
		// Its record may not be adopted yet (a start creates both in one commit; its entry takes the state then).
		if (run?.entry === undefined) return;
		const before = run.entry;
		run.entry = this.#entryOf(run);
		this.running.stateChanged(before, run.entry, ops);
	}

	/** A run's record changed, inside the commit step: its entry is replaced. */
	// 与 #stateChanged 的区别：这里替换整个条目且没有子路径 op，watcher 收到一次 set。
	#replaceEntry(run: JobRun): void {
		const before = run.entry!;
		run.entry = this.#entryOf(run);
		this.running.replace(before, run.entry);
	}

	/**
	 * `run`'s `running` entry: blocked, or with its state and its args as the current code takes them (an older run's
	 * mapped; one the code does not take, or whose mapping throws, shows its own).
	 */
	// 输入运行；输出与 running 列表共享的 JSON 条目（entryFor 内部生成当前 state/args 快照）。
	// 版本不同且能接管时尝试映射 args；适配器映射抛错时退回原始 args（finish 时会再次遇到并重试）。
	#entryOf(run: JobRun): JsonValue {
		let args = run.args;
		if (run.phase !== "blocked" && run.version !== this.definition.version && this.#takes(run)) {
			try {
				args = this.argsOf(run, this.definition);
			} catch {
				// The provider's mapping threw: its own args (its finish meets the same throw and is retried).
			}
		}
		return run.entryFor(this.stateOf(run.id), args);
	}

	// 启动事务被丢弃时给新 handle 的错误：code released/reason discarded，与“已结束”区分开。
	#discarded(): ChordError {
		return new ChordError({
			code: "released",
			reason: "discarded",
			message: `${this.name}: the start's transaction was discarded`,
		});
	}
}

/** Runs every adoption of `adopts`. */
// 顺序执行 adoption：它们是纯内存更新，不返回 Promise；某个抛错会让提交步骤失败（属于内部不变量破坏）。
function runAll(adopts: readonly (() => void)[]): void {
	for (const adopt of adopts) adopt();
}

/** The record fields a change writes, its phase transitions included. */
// 输入非删除类变更；输出 StoredFields（phase/restarts/finishFailures/abort/blocked/outcome）。
// Exclude 把 delete/drop 从联合中排除：它们没有字段，走 stageRetire 而不是 stage。
// unblock 把 blocked 写成 undefined，storedRun 会据此省略该字段；finishFailures 归零是 D6 的重试语义。
function recordFields(change: Exclude<RecordChange, { kind: "delete" | "drop" }>): StoredFields {
	switch (change.kind) {
		case "create":
			return {};
		case "update":
			return change.fields;
		case "outcome":
			return { phase: "finishing", outcome: change.outcome };
		case "block":
			return { phase: "blocked", blocked: change.reason };
		case "unblock":
			return { phase: change.phase, blocked: undefined, finishFailures: 0 };
	}
}
