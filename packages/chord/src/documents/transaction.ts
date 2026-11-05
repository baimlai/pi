// Transactions (§9, R12, R13): drafts of an object's documents, prepared and adopted in one batch, with Chord's own
// staged changes (job runs, §15), fenced by the token they run under; they run on the object's line (`line.ts`).

// 文件导读
// 所属：packages/chord/src/documents，单个对象的文档事务实现。
// 职责边界：草拟/退役文档、暂存表格写入与 Chord 自有变更（job run 记录）、准备 Delta、在纯内存批次或 store step 中收养；不负责排队拿线（Documents.tx 做）。
// 上游：Documents.tx 创建；句柄 change/retire、KeyedSlot 的冷读、TableHandle 写入、Job.stage 进入；下游：Delta tracker、Persistence.stage、store.commit、TableChanges、Batch。
// 结果/错误：commit 抛 pending/状态错误、context abort、store 拒绝（invalid/args 或 unavailable/broken）；cut 时所有后续使用抛 released/discarded；由调用者 discard/settle。
// 能力清单：Tx 应用接口；Staged Chord 自有变更回调；Entry/Adoption 内部记录；Transaction 类（draft/retire/start/get/page/rows/put/update/delete/updateWhere/deleteWhere/stage/staged/commit/discard/cut/settle）。
// 组合关系：tx 开始 → draft/retire/表格写入暂存 → commit 准备草稿并 stage 持久写入 → 无 store 写入则同步 #adopt；有则 #step（store 提交 → fence.adopt）→ Documents.tx finally 调 settle。
// 示例：await docs.tx(async (tx) => { const d = await tx.draft(counter); d.count += 1; tx.put(table, row); }, token, ctx); 提交后 watch 收到一帧。
// 阅读顺序：先看 Tx 接口与 Entry/Adoption 类型，再看 draft/retire，最后看 commit/#step/#adopt 与 cut/discard/settle 的状态机。
// 状态机：open → committing →（纯内存）committed /（store）stepping → committed；异常路径 discarded；封条切断 cut。stepping/committed 不再被 cut 打断。
import { type Context, withoutAbortSignal } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import { type Change, type Draft, type Prepared, type Tracker, track } from "../delta/index.ts";
import type { JobHandle, Outcome, Run, StartOptions } from "../jobs/index.ts";
import type { Job } from "../jobs/internal.ts";
import type { Columns, PutRowOf, RowOf } from "../store/columns.ts";
import type { Condition, SetOf } from "../store/expression.ts";
import type { ColumnRefs, Query } from "../store/query.ts";
import { refusalOf } from "../store/refusal.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ChordStore } from "../store/store.ts";
import type { KeyOf } from "../store/table.ts";
import { TableChanges } from "../store/table-changes.ts";
import { type Page, type PageOptions, ROWS_PAGE, type Table, TableHandle } from "../store/table-handle.ts";
import type { CommitPersistence, JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import type { Keyed, KeyedHandle, Singleton, SingletonHandle } from "./handles.ts";
import type { KeyedSlot } from "./keyed-slot.ts";
import { checkReadable, type FoundDocument, type Stored, type StoredChange } from "./persistence.ts";
import type { DocumentSlot, PersistedSlot, SingletonSlot } from "./slot.ts";

// Tx 是插件回调看到的接口；构造时不会拿到 Transaction 类，因此只能通过这里的方法操作文档与表格。
// 规则：回调内只能 await tx.*，不能再开 self.tx，也不能调用其他对象（跨对象写入需要各自的对象/事务）。
/** What `self.tx` gives its callback. Inside it: only `await tx.*`, no other `self.tx`, no calls to other objects. */
export interface Tx {
	// 两个重载共用一套实现：singleton 只有 handle，keyed 还要 key；同一文档在同一事务内始终返回同一个 Draft（entry 缓存）。
	// 返回 Promise 是因为冷持久文档要先加载；内存文档也在微任务后返回，调用方一律 await。
	/** The document's draft: the same one for the same document within one transaction. */
	draft<T extends JsonObject>(handle: SingletonHandle<T>): Promise<Draft<T>>;
	draft<T extends JsonObject>(handle: KeyedHandle<T>, key: string): Promise<Draft<T>>;
	// 退役在提交时生效：地址重新读 initial()，watch 收到 retired 帧；文档缺席时是空操作（commit 里用 exists/found 过滤）。
	// keyed 的 key 走与读取相同的规范化规则。
	/** Retires the document when the transaction commits (its address reads `initial()` again); a no-op when it is absent. */
	retire(handle: SingletonHandle<JsonObject>): Promise<void>;
	retire(handle: KeyedHandle<JsonObject>, key: string): Promise<void>;
	// start 的对象必须是本对象的 job（句柄由 self.job 产生）；返回的 Run 立即可用，但 outcome 要等事务提交或丢弃。
	// “both commit or neither”：run 的启动记录与本次事务的文档/表格写入在同一个 store step 中。
	// 同一事务内重复启动同一个未结算 run，会返回已有 run 而不是再建一个。
	/**
	 * Starts a run of `job`, one of this object's jobs, with this transaction's other writes (§15): both commit or
	 * neither. Returns its `Run` at once; a discarded transaction's `Run` rejects `released` from `outcome`. A key of an
	 * unsettled run (one started earlier in this transaction too) returns that run.
	 */
	start<A, R, S>(job: JobHandle<A, R, S>, args: A, options?: StartOptions): Run<Outcome<A, R, S>>;
	// get 读取“事务视角”的行：本事务此前的 put/update/deleteWhere 已经叠加（W10），尚未提交。
	// 这是异步读，会占用 #pending；回调若在它结算前返回，commit 会拒绝。
	/** The row with `key` as this transaction leaves it (its own `put`, `update`, `delete` overlaid; W10). */
	get<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): Promise<RowOf<C> | undefined>;
	// page 只读已提交的快照，不受本事务自己的表格写入影响；事务内多次 page 的结果稳定。
	// limit/options 与 store 的 TableHandle.page 相同，next 游标用于继续翻页。
	/** A page of committed rows, stable for the transaction (without its own writes). */
	page<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
		options?: PageOptions,
	): Promise<Page<RowOf<C>>>;
	// rows 是 page 的异步生成器封装：每页 100 行，用上一页的 next 作为下一页的 after。
	// 每次翻页都是一次 tx.page 调用，因此同样计入 pending。
	/** Every committed row of `q`, as `page`. */
	rows<C extends Columns, K extends readonly string[]>(table: Table<C, K>, q: Query<C, K>): AsyncIterable<RowOf<C>>;
	// put 是整行 upsert：提交时整行替换，不在旧行上合并；写入先进入 TableChanges 覆盖层与暂存列表。
	/** Writes `row` when the transaction commits (an upsert: the whole row replaced). */
	put<C extends Columns, K extends readonly string[]>(table: Table<C, K>, row: PutRowOf<C>): void;
	// update 只改给定列；key 不存在时什么也不做（不是错误）。set 可以是值对象或基于 ColumnRefs 的函数。
	/** Changes the row with `key` when the transaction commits; an absent key changes nothing. */
	update<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void;
	// delete 在提交时删除该 key；事务内的 get 会立刻看到它消失。
	/** Deletes the row with `key` when the transaction commits. */
	delete<C extends Columns, K extends readonly string[]>(table: Table<C, K>, key: KeyOf<C, K>): void;
	// updateWhere 生成一条 UPDATE 语句（SQL 计数记录在 TableChanges），事务内 get 按条件叠加结果。
	/** Changes every row matching `where` when the transaction commits (one statement, its count recorded). */
	updateWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void;
	// deleteWhere 生成一条 DELETE 语句；未匹配的行不受影响。
	/** Deletes every row matching `where` when the transaction commits. */
	deleteWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
	): void;
}

// Chord 自己的事务内变更（job 的 run 记录）实现的钩子：adopt 与文档同批执行，committed/discarded 在线释放后调用。
// 例：Job.stage 返回一个 Staged：adopt 写入 run 记录，committed 真正启动 run，discarded 让等待者失败。
/**
 * Chord's own changes staged in a transaction (a job's run records): adopted in its commit step with the documents,
 * then told how the transaction ended, once the owner's line is free.
 */
export interface Staged {
	/** Adopts the changes, inside the commit's batch. */
	adopt(): void;
	/** The transaction committed: the actions after the commit (a run starts, waiters settle). */
	committed(): void;
	/** The transaction was discarded: nothing was adopted. */
	discarded(): void;
}

// Entry 是“一个槽 + 一个键”在本事务中的全部状态；Map<slot, Map<key, Entry>> 保证同一文档只草拟一次。
// found 只在“冷持久文档被退役且未加载”时使用：提交需要知道磁盘上的坐标与版本，才能写退役。
// retire 与 draft 可以同时存在：先退役再重新草拟，提交时先发 retired 帧再收养新值。
/**
 * What one transaction does with one document: a draft, a retirement, or both (retired, then drafted anew); `found`
 * is what is stored of a cold persisted document it retires without loading (R13).
 */
type Entry = {
	readonly slot: DocumentSlot;
	readonly key: string;
	draft: { readonly tracker: Tracker<JsonObject>; readonly change: Change<JsonObject> } | undefined;
	retire: boolean;
	found: Stored | undefined;
};

// 默认持久化策略：立即写入。D8 的延迟策略（run state）由调用者通过 CommitPersistence 传入。
const IMMEDIATE: CommitPersistence = { kind: "immediate" };

// Adoption 是 commit 准备阶段的产物，供 #adopt 使用：entry 提供槽/键，prepared 是 Delta 变更，stored 是存储写入结果。
// retires 与 prepared 可以同时为真；stored 为 undefined 表示纯内存槽。
/**
 * One document change a commit adopts: a removal, a draft's prepared change, or both; and for a persisted document
 * what the commit stores of it.
 */
type Adoption = {
	readonly entry: Entry;
	readonly prepared: Prepared<JsonObject> | undefined;
	readonly retires: boolean;
	readonly stored: StoredChange | undefined;
};

// 例：attempt 的 handler 调 self.tx；handle.change 拿到 draft，d.count++；commit 准备并收养；若 handler 期间 attempt 被封，fence 调 cut 丢弃整笔。
// 事务不创建自己的线；线由 Documents.tx 在构造前 acquire，并作为 release 传入，cut 时由事务释放。
/**
 * One transaction of an object, under the seal token of whoever runs it (an attempt, a job run's invocation, the
 * object). Commit prepares every draft (Delta records ops and checks only placed values) and adopts the changed
 * documents and the staged changes in one batch; drafts are revoked once it settles. Cut at its token's seal, it
 * discards everything, releases the line and refuses every later use.
 */
export class Transaction implements Tx {
	// #entries 按槽分组；#staged 保存 Chord 自有变更；#writes 保存 store 写入与目标 store（第一次写入时创建）。
	// #tables 保存表格覆盖层；#pending 统计未结算的 tx 读；#persistence 决定持久写入的时机；#state 是状态机；#queued 让入队后的 cut 立刻失败。
	readonly #documents: Documents;
	readonly token: SealToken;
	readonly #release: () => void;
	readonly #context: Context;
	readonly #entries = new Map<DocumentSlot, Map<string, Entry>>();
	/** Chord's own staged changes, by their owner (a job); made by the first. */
	#staged: Map<object, Staged> | undefined;
	/**
	 * The store writes, in staging order, and the store they commit to; made by the first (the flag that sends the
	 * commit through the store's step, W12).
	 */
	#writes: { readonly store: ChordStore; readonly staged: StagedWrite[] } | undefined;
	/** The tables written, each with its writes and overlay. */
	#tables: Map<TableHandle, TableChanges> | undefined;
	/** `tx.*` reads underway: a callback settling with one is refused (rule 3, as Durable's). */
	#pending = 0;
	/** When its commit reaches the store (a run state's deferred change, D8). */
	readonly #persistence: CommitPersistence;
	#state: "open" | "committing" | "stepping" | "committed" | "discarded" | "cut" = "open";
	/** Rejected by `cut` while the commit waits in the store's queue: its caller is told at once (rule 3). */
	#queued: PromiseWithResolvers<never> | undefined;

	// 函数说明：保存对象/令牌/释放函数/context/持久化策略；无 I/O，不改变任何文档。
	// release 是 Documents.tx 传入的线释放函数；cut 和 Documents 的 finally 都会调用，但 release 幂等。
	constructor(
		documents: Documents,
		token: SealToken,
		release: () => void,
		context: Context,
		persistence: CommitPersistence = IMMEDIATE,
	) {
		this.#documents = documents;
		this.token = token;
		this.#release = release;
		this.#context = context;
		this.#persistence = persistence;
	}

	// 函数说明：取得（必要时创建）Chord 自有写入的暂存数组；返回的数组由 store step 消费。
	// 第一次调用会创建 #writes，从而把本次 commit 从纯内存路径切换到 store step（W12）。
	/**
	 * The store writes of this transaction, which `write`s join (Chord's own documents: a job's run records): made by the
	 * first, which sends the commit through `store`'s step.
	 */
	stageStore(store: ChordStore): StagedWrite[] {
		this.#writes ??= { store, staged: [] };
		return this.#writes.staged;
	}

	// 暴露对象管理器，供 jobs 层在事务内访问批次/上下文；不是给插件用的公开入口。
	/** The object whose transaction this is. */
	get documents(): Documents {
		return this.#documents;
	}

	// 重载声明只描述调用形状；实现签名把两种句柄合并成联合，key 默认空串。
	// 泛型 T 让调用者拿回 Draft<T>；运行期不检查 T 与定义是否一致（由 handle 的类型保证）。
	draft<T extends JsonObject>(handle: SingletonHandle<T>): Promise<Draft<T>>;
	draft<T extends JsonObject>(handle: KeyedHandle<T>, key: string): Promise<Draft<T>>;
	// 实现不是 async：内存路径无需额外 Promise 层，热路径更便宜；同步抛错统一转成 rejected Promise。
	// 先 #slotOf 做版本栅栏与归属检查，再把 key 规范化；singleton 的 key 固定为空串，不经过 keyed 的文本规则。
	// 失败返回 Promise.reject，调用方看到的仍是 await 抛错，而不是同步异常。
	// draftSlot 是本事务真正的草拟入口，返回的 Draft 与 entry 绑定。
	draft<T extends JsonObject>(handle: SingletonHandle<T> | KeyedHandle<T>, key = ""): Promise<Draft<T>> {
		// Not `async`: the draft's promise is returned as it is, without another promise around it (the in-memory path
		// stays as cheap as before the store); a throw still reaches the caller as a rejection.
		let slot: SingletonSlot | KeyedSlot;
		let at: string;
		// Keyed keys follow the text rules (`KeyedSlot.key`); a singleton's key is always "".
		try {
			slot = this.#slotOf(handle);
			at = key === "" ? key : slot.key(key);
		} catch (error) {
			return Promise.reject(error);
		}
		// The entry is made for this handle's slot, whose documents are `T`.
		return this.draftSlot(slot, at) as Promise<Draft<T>>;
	}

	// 函数说明：草拟槽/键对应的文档；输入槽与已规范化的键，返回 Draft；冷持久文档在事务内先加载。
	// 热路径（已有草稿、已退役、或文档已在内存）直接 #begin，不增加 pending。
	// 冷路径先 #pending++，加载期间回调不能返回（rule 3）；加载完成后再检查事务仍 open。
	// 例：首次 tx.draft(items, "a") 发现 a 不在内存且持久 → await load；随后 #begin 以加载后的 tracker 建草稿。
	/**
	 * The draft of the document at `key` of `slot` (Chord's own slots, a job's run states). A cold persisted document
	 * is loaded first, inside the transaction (it holds the line); the draft counts as pending until it settles (rule
	 * 3). A warm draft settles at once.
	 */
	async draftSlot(slot: DocumentSlot, key: string): Promise<Draft<JsonObject>> {
		const entry = this.#entry(slot, key);
		const persisted = slot.persisted;
		// 三重短路：已有草稿复用；已标记退役说明退役后再草拟应从 initial 开始，不必先加载；文档已在内存则直接草拟。
		// persisted?.cold(key) !== true 同时处理纯内存槽（persisted 为 undefined）。
		if (entry.draft !== undefined || entry.retire || persisted?.cold(key) !== true) return this.#begin(entry);
		// 从发起加载到结算都计为 pending；即使加载失败，finally 也会减回去。
		this.#pending++;
		try {
			// 加载在对象线上完成（调用者已持线）；token 用于加载期间被切断时放弃安装。
			await persisted.load(key, this.#context, this.token);
			// 加载期间事务可能被 cut；此时不能再建立草稿，抛 released/discarded。
			this.#assertOpen();
			return this.#begin(entry);
		} finally {
			this.#pending--;
		}
	}

	// 重载与 draft 对称；keyed 的 key 同样先规范化。
	retire(handle: SingletonHandle<JsonObject>): Promise<void>;
	retire(handle: KeyedHandle<JsonObject>, key: string): Promise<void>;
	// 函数说明：标记文档在提交时退役；输入句柄与键，返回 Promise<void>；冷持久文档会先 find 一次。
	// retireSlot 立即清除已有草稿（草稿作废），并设置 retire 标志。
	// 冷文档不加载整值，只读取存储坐标与版本（R13）；加载会浪费一次 decode，而退役只需要地址。
	// find 计入 pending；await 期间事务可能被 cut，因此之后要 assertOpen，避免失败已换代的 attempt。
	// checkFound 保证代码读得懂该版本/指纹；读不懂时让 owner broken，与 load 的行为一致。
	async retire(handle: SingletonHandle<JsonObject> | KeyedHandle<JsonObject>, key = ""): Promise<void> {
		const slot = this.#slotOf(handle);
		const at = key === "" ? key : slot.key(key);
		const entry = this.retireSlot(slot, at);
		const persisted = slot.persisted;
		// A cold persisted document is found, not loaded (one read; absent: a no-op, R13); a version or fingerprint
		// the code cannot read fails the owner as a load would (R15): a retirement of it is no exception.
		// 条件：尚未查过磁盘，且文档确实不在内存（cold）。已在内存的退役无需 find，提交时用 resident 的 stored。
		if (entry.found === undefined && persisted?.cold(at)) {
			// find 只查元数据（id/revision/version/deltas），不 decode 文档值。
			const found = await this.#track(persisted.persistence.find(at, this.#context));
			// Cut meanwhile: its attempt was sealed, and failing the owner now would fail its successor.
			// 被 cut 后不再 fail owner：失败的是旧 attempt，不能把错误算到后继 activation 上。
			this.#assertOpen();
			// 文档存在则做可读性检查；不存在则本次退役是空操作（commit 的 retires 条件会过滤掉）。
			if (found !== undefined) checkFound(found, persisted, slot);
			// 只保存 stored 坐标，供 stage 计算写入；文档值本身从未加载。
			entry.found = found?.stored;
		}
	}

	// 函数说明：退役槽/键；返回 entry；副作用是 abort 并清空已有草稿、置 retire。
	/** Retires the document at `key` of `slot` when the transaction commits. */
	retireSlot(slot: DocumentSlot, key: string): Entry {
		const entry = this.#entry(slot, key);
		entry.draft?.change.abort();
		entry.draft = undefined;
		entry.retire = true;
		return entry;
	}

	// 函数说明：把 run 的启动记录暂存到本事务；输入 job 句柄/参数/选项，返回 Run。
	// 句柄是 Chord 自己的 Job（self.job 产生），因此可以安全断言到内部类型并调用 stage；插件拿不到这个内部入口。
	// 返回类型用 Outcome<A, R, S> 描述 run 的最终结果；启动本身在事务提交后才真正发生。
	start<A, R, S>(job: JobHandle<A, R, S>, args: A, options: StartOptions = {}): Run<Outcome<A, R, S>> {
		// Job handles are Chord's own: `self.job` made them.
		return (job as unknown as Job).stage(this, args, this.#context, options) as Run<Outcome<A, R, S>>;
	}

	// 函数说明：读事务视角的单行；输入表与主键，返回行或 undefined；会叠加本事务对该表的写入。
	// 有 TableChanges 覆盖层时走覆盖层，否则直接读 store；两者都是异步，计入 pending。
	// #track 的返回被断言为 RowOf<C>|undefined：handle 的行类型由 C 保证，运行期不检查。
	get<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
	): Promise<RowOf<C> | undefined> {
		const handle = this.#handle(table);
		const changes = this.#tables?.get(handle);
		const read = changes === undefined ? handle.get(key, this.#context) : changes.get(key, this.#context);
		// The handle's rows are the table's, typed by `C`.
		return this.#track(read) as Promise<RowOf<C> | undefined>;
	}

	// 函数说明：读一页已提交行；输入表/查询/limit/options，返回 Page<RowOf<C>>。
	// q 断言为 Query：句柄与查询的表类型在编译期已对齐，运行期由 TableHandle 检查。
	page<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
		limit: number,
		options: PageOptions = {},
	): Promise<Page<RowOf<C>>> {
		// As in `get`; the query's table is checked against the handle's.
		const read = this.#handle(table).page(q as unknown as Query, limit, this.#context, options);
		return this.#track(read) as Promise<Page<RowOf<C>>>;
	}

	// 函数说明：逐页产出查询结果；让调用方用 for await 读全表而不用手写游标。
	// after 从 undefined 开始；每页 100 行；page.next 为 undefined 时结束。
	async *rows<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		q: Query<C, K>,
	): AsyncIterable<RowOf<C>> {
		let after: string | undefined;
		do {
			const page = await this.page(table, q, ROWS_PAGE, after === undefined ? {} : { after });
			yield* page.items;
			after = page.next;
		} while (after !== undefined);
	}

	// put 只登记写入，不立即执行；#changes 首次访问时创建覆盖层并切到 store step。
	put<C extends Columns, K extends readonly string[]>(table: Table<C, K>, row: PutRowOf<C>): void {
		this.#changes(table).put(row);
	}

	// 函数说明：update 委托覆盖层，语义见 TableChanges.update。
	update<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		key: KeyOf<C, K>,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void {
		this.#changes(table).update(key, set);
	}

	// 函数说明：delete 委托覆盖层，事务内后续 get 会看到删除。
	delete<C extends Columns, K extends readonly string[]>(table: Table<C, K>, key: KeyOf<C, K>): void {
		this.#changes(table).delete(key);
	}

	// updateWhere 的 where 是编译期构造条件的函数；覆盖层用同样的谓词叠加到事务内读取。
	updateWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
		set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>),
	): void {
		this.#changes(table).updateWhere(where, set);
	}

	// deleteWhere 与 updateWhere 相同，只是动作是删除。
	deleteWhere<C extends Columns, K extends readonly string[]>(
		table: Table<C, K>,
		where: (row: ColumnRefs<C>) => Condition,
	): void {
		this.#changes(table).deleteWhere(where);
	}

	// 函数说明：按 owner 取或创建 Staged；输入 owner 与惰性工厂，返回该 owner 的变更。
	// 每个 owner 只创建一次；后续调用复用，保证同一 run 只有一份暂存状态。
	// 断言 as S 是必要的：Map 的值类型是 Staged，而每个 owner 返回自己的子类型。
	/** The changes `owner` staged in this transaction, made by `make` on its first use. */
	stage<S extends Staged>(owner: object, make: () => S): S {
		this.#assertOpen();
		this.#staged ??= new Map();
		let staged = this.#staged.get(owner);
		if (staged === undefined) {
			staged = make();
			this.#staged.set(owner, staged);
		}
		// Each owner stages one kind of change, the one its `make` returns.
		return staged as S;
	}

	// 只读查询，不创建；未暂存时返回 undefined。
	/** The changes `owner` staged in this transaction so far, if any. */
	staged<S extends Staged>(owner: object): S | undefined {
		// As in `stage`: the owner's own kind.
		return this.#staged?.get(owner) as S | undefined;
	}

	// 函数说明：提交入口；准备所有草稿、暂存持久写入并收养变更；无变更时不产生帧。
	// 同步完成的条件：没有任何持久写入（纯内存）；否则返回 #step 的 Promise。
	// 先 assertOpen 再检查 pending：状态错误优先于“回调提前返回”。
	// context 的 abort 在准备前检查：已中止的事务不提交，Documents.tx 的 catch 会丢弃并报告取消。
	// 例：count 从 1 改成 2 → prepare 得到一次 replace 的 ops → 无持久化 → #adopt → committed；watch 在本批收到一帧。
	/**
	 * Prepares every draft and adopts what changed, and the staged changes, in one batch; nothing when nothing changed.
	 * A document retired and drafted anew is removed, then adopted: its frame carries the retirement. Persisted
	 * documents stage their writes here (rule 8), which sends the commit through the store's step.
	 */
	commit(): void | Promise<void> {
		// commit 只能从 open 调用一次；之后状态不再是 open，重复提交抛 settled 错误。
		this.#assertOpen();
		// rule 3：回调在 tx.get/page/rows 尚未结算时就结束了。这不是 ChordError，而是编程错误，直接抛普通 Error。
		if (this.#pending > 0)
			throw new Error(`${this.#documents.label}: the callback settled before its pending tx operations`);
		this.#state = "committing";
		// throwIfAborted 抛出 context 的 abort reason；此时状态已到 committing，Documents.tx 的 catch 会 discard。
		this.#context.abortSignal?.throwIfAborted();
		// 先收集，后统一收养：准备阶段任何一步抛错都不会只应用一部分变更。
		const adoptions: Adoption[] = [];
		// 外层按槽，内层按键；两层 Map 保证同一文档只有一个 entry，顺序是首次访问顺序。
		for (const entries of this.#entries.values()) {
			for (const entry of entries.values()) {
				// Delta 的 prepared 把草稿与 base 比较，记录写入操作；prepare 之后草稿不能再改。
				let prepared = entry.draft?.change.prepare();
				// 草稿最终与原值相同：abort 掉 prepared，按“没有变化”处理，避免空帧和空写入。
				if (prepared !== undefined && prepared.ops.length === 0) {
					prepared.abort();
					prepared = undefined;
				}
				const { slot, key } = entry;
				// 退役只有在“内存中存在”或“磁盘上找到过”时才算数；缺席文档的 retire 是空操作。
				const retires = entry.retire && (slot.current(key) !== undefined || entry.found !== undefined);
				if (prepared === undefined && !retires) continue;
				const persisted = slot.persisted;
				let stored: StoredChange | undefined;
				// 持久槽把 prepared/retires 转成存储写入；这一步会创建 #writes，从而触发 store step。
				// was 优先用内存 resident 的 stored，否则用退役时 find 到的 found。
				if (persisted !== undefined) {
					const writes = this.stageStore(persisted.persistence.store);
					const was = persisted.stored(key) ?? entry.found;
					stored = persisted.stage(key, { prepared, retires }, was, writes, this.#persistence);
				}
				adoptions.push({ entry, prepared, retires, stored });
			}
		}
		// 没有任何持久或表格写入：同步收养并标记 committed，commit 返回 void。
		const writes = this.#writes;
		if (writes === undefined) {
			this.#adopt(adoptions);
			this.#state = "committed";
			return;
		}
		return this.#step(writes.store, writes.staged, adoptions);
	}

	// 函数说明：通过 store step 提交；输入 store/暂存写入/收养列表，返回 Promise；拒绝时分类错误。
	// 排队前的 admit 与 store 的队列配合：state 必须仍是 committing 且 token 未封，才允许真正写入。
	// 被 admit 后进入 stepping；此后的 cut 不再打断（seal 允许已获准的 step 跑完）。
	// #queued 让 cut 在排队期间立即拒绝调用者；race 同时接管 store.commit 的最终拒绝，避免未处理拒绝。
	// withoutAbortSignal：一旦入队，调用者 context 的中止不再影响提交（存储已可能写入，不能半途而废）。
	/**
	 * Commits through the store's step (§3): admitted while neither cut nor sealed (else `released`, nothing written),
	 * then the documents and staged changes adopted inside the step. Once queued, the caller's abort no longer counts;
	 * a cut while queued rejects `released` at once (the queue drops the entry at its admission, writing nothing).
	 */
	async #step(store: ChordStore, staged: readonly StagedWrite[], adoptions: readonly Adoption[]): Promise<void> {
		// fence 是交给 store 的准入/收养钩子；adopt 只在 store 批准并执行写入后调用。
		// admit 的 false 让 store 以 released 拒绝，事务无需自己再抛。
		const fence = {
			admit: () => {
				if (this.#state !== "committing" || this.token.sealed) return false;
				this.#state = "stepping";
				return true;
			},
			adopt: () => this.#adopt(adoptions),
		};
		// 这个 Promise 只有一个用途：cut 时可以同步 reject，让 race 立即结束；never 表示它从不成功。
		this.#queued = Promise.withResolvers<never>();
		try {
			// The race handles the commit's own later rejection too.
			// store.commit 成功或失败都结束 race；cut 通过 #queued 提前结束等待。
			await Promise.race([store.commit(staged, fence, withoutAbortSignal(this.#context)), this.#queued.promise]);
		} catch (error) {
			// cut 赢得 race：即使 store 之后拒绝，调用者看到的也是 released/discarded。
			// 其他拒绝交给 #refused 分类：CHECK 只失败本事务，其他拒绝让对象 broken。
			if (this.#state === "cut") throw this.#cutError();
			throw this.#refused(error);
		} finally {
			this.#queued = undefined;
		}
		// 只有 store 确认成功后才标记 committed；之后的 settle 用这个状态告诉 staged 变更。
		this.#state = "committed";
	}

	// 函数说明：把 store 的拒绝转成 Chord 错误；输入任意抛出值，返回要抛出的错误。
	// refusalOf 返回 undefined 表示这是 store 自己的 released/storage_failed，原样传播。
	// check：invalid/args，只失败本事务；broken：unavailable，先 owner.fail 让 live 对象 broken，再抛出。
	// 例：int 列 CHECK 失败 → invalid/args；磁盘损坏等其他拒绝 → 对象 broken。
	/**
	 * The error a commit the store rejected rejects with (D4): the store's own (`released`, `storage_failed`) as it
	 * is; a refused step classified, an `int` `CHECK` failing only this transaction (`invalid/args`), any other refusal
	 * failing the live object `broken` too (memory and disk disagree).
	 */
	#refused(error: unknown): unknown {
		const refusal = refusalOf(error, this.#documents.label);
		if (refusal === undefined) return error;
		if (refusal.kind === "broken") this.#documents.fail(refusal.error);
		return refusal.error;
	}

	// 函数说明：在一个批次中收养文档变更与 Chord 自有变更；无变更时什么也不做。
	// 全部收养在 batch.commit 的回调里执行，因此 watch 只看到同一批的一帧。
	// 先 retire 再 adopt：退役后重新草拟的文档在观察者看来先移除、再加回。
	// staged.adopt 与文档同一批，保证 run 记录与业务写入原子地出现在观察者面前。
	/**
	 * Adopts the changed documents (persisted ones with what the commit stored of them) and the staged changes in one
	 * batch; nothing when nothing changed.
	 */
	#adopt(adoptions: readonly Adoption[]): void {
		const staged = this.#staged;
		// 没有文档变更也没有 staged 变更：不打开批次，避免空提交产生无意义的批处理开销。
		if (adoptions.length === 0 && staged === undefined) return;
		this.#documents.batch.commit(() => {
			for (const { entry, prepared, retires, stored } of adoptions) {
				// retire 用 slot.retire(key)；随后若有 prepared，再用本次草稿的 tracker 收养新值。
				// entry.draft! 的非空断言由 prepared !== undefined 保证：prepared 只来自 draft。
				if (retires) entry.slot.retire(entry.key);
				if (prepared === undefined) continue;
				entry.slot.adopt(entry.key, entry.draft!.tracker, prepared, stored);
			}
			for (const each of staged?.values() ?? []) each.adopt();
		}, this.#context);
	}

	// 函数说明：丢弃事务；已 cut 时不再改状态（cut 的错误语义优先）。
	// 只 abort 草稿，不改文档；未收养的 Delta 变更因此不会留下副作用。
	/** Aborts every draft and prepared change. */
	discard(): void {
		if (this.#state === "cut") return;
		this.#state = "discarded";
		this.#abortDrafts();
	}

	// 函数说明：封条切断事务；输入无，返回无；释放线并让排队中的 commit 立即失败。
	// 只有 open/committing 会被切断；stepping/committed 的提交已获准，必须跑完（seal fence 的保证）。
	// #release 只在这里和 Documents.tx 的 finally 调用；release 幂等，不会重复释放。
	/**
	 * Its token was sealed while it held the line: every draft is aborted, the line released, and every later use,
	 * its commit included, throws `released`.
	 */
	cut(): void {
		// A commit admitted to the step runs to its end; one still queued is refused at admission.
		// stepping 之后 cut 是空操作：写入可能已经发生，不能再谎称“什么都没做”。
		if (this.#state !== "open" && this.#state !== "committing") return;
		this.#state = "cut";
		this.#abortDrafts();
		this.#release();
		this.#queued?.reject(this.#cutError());
	}

	// 函数说明：通知 staged 变更事务结果；输入无，返回无；由 Documents.tx 在释放线后调用。
	// 只有 committed 才算成功；其他状态（discarded/cut/committing 抛错）都按丢弃处理。
	/** Tells the staged changes how the transaction ended; runs once the object's line is free. */
	settle(): void {
		if (this.#staged === undefined) return;
		const committed = this.#state === "committed";
		for (const staged of this.#staged.values()) {
			if (committed) staged.committed();
			else staged.discarded();
		}
	}

	// 遍历所有 entry 的草稿并 abort；没有草稿的 entry 是空操作。
	#abortDrafts(): void {
		for (const entries of this.#entries.values()) for (const entry of entries.values()) entry.draft?.change.abort();
	}

	// 函数说明：从句柄取出槽并做版本栅栏；输入句柄，返回槽；版本不匹配抛 released/version。
	// 句柄是 Chord 自己的 Singleton/Keyed，因此断言安全；插件无法伪造（句柄由 self.state 生成）。
	/** The slot behind a handle of this object, after the handle's version fence (R15). */
	#slotOf(handle: SingletonHandle<JsonObject> | KeyedHandle<JsonObject>): SingletonSlot | KeyedSlot {
		// Handles are Chord's own: `self.state` made them.
		const { slot, version } = handle as Singleton | Keyed;
		slot.definition.assertVersion(version);
		return slot;
	}

	// 函数说明：取或创建槽/键的 Entry；输入槽与键，返回 Entry；跨对象写入直接拒绝。
	// 归属检查是运行期信任边界：插件可能传入别的对象的句柄（虽然类型上通常已被限制）。
	// 两层 Map 都是首次访问时创建，之后复用；同一事务内同一文档始终得到同一 entry。
	#entry(slot: DocumentSlot, key: string): Entry {
		this.#assertOpen();
		// 用对象管理器身份比较判断归属；这是运行期检查，类型系统不区分不同对象的同类句柄。
		if (slot.owner !== this.#documents) {
			throw new Error(`${this.#documents.label}: a transaction drafts only its own object's documents`);
		}
		let entries = this.#entries.get(slot);
		if (entries === undefined) {
			entries = new Map();
			this.#entries.set(slot, entries);
		}
		let entry = entries.get(key);
		if (entry === undefined) {
			entry = { slot, key, draft: undefined, retire: false, found: undefined };
			entries.set(key, entry);
		}
		return entry;
	}

	// open 之外分两类：cut 抛可重试语义的 released/discarded；已结算（committed/discarded）抛普通 Error。
	// 普通 Error 表示调用时机错误（提交后用事务），不是 Chord 协议错误。
	#assertOpen(): void {
		if (this.#state === "open") return;
		if (this.#state === "cut") throw this.#cutError();
		throw new Error(`${this.#documents.label}: the transaction has settled`);
	}

	// 统一的切断错误：code released、reason discarded；消息带对象标签。
	// 每次新建对象：调用方可能修改/包装，不能共享可变错误实例。
	#cutError(): ChordError {
		return new ChordError({
			code: "released",
			reason: "discarded",
			message: `${this.#documents.label}: the transaction was discarded at the seal`,
		});
	}

	// 函数说明：校验并返回表句柄；输入任意对象，返回 TableHandle；非本对象/非本版本都拒绝。
	// 插件代码可以传任意值，因此这里必须做 instanceof 与归属检查（信任边界）。
	// assertVersion 检查句柄声明时的表定义版本，防止热重载后用旧句柄写新表。
	/** The handle behind `table`, one of this object's tables (another object's is refused). */
	// 参数类型是 object 而不是 Table：调用来自插件，运行期必须自己收窄。
	#handle(table: object): TableHandle {
		this.#assertOpen();
		// Plugin code may pass any table: only this object's handles are taken.
		const handle = table;
		// 两个条件：确实是 TableHandle，且 scope 是当前对象；任一不满足都抛普通 Error。
		if (!(handle instanceof TableHandle) || handle.owner.scope !== this.#documents) {
			throw new Error(`${this.#documents.label}: a transaction writes only its own object's tables`);
		}
		handle.assertVersion();
		return handle;
	}

	// 函数说明：取或创建表的写入覆盖层；输入表，返回 TableChanges。
	// 第一次创建时同时建立 #writes（store 来自 handle.store），让表格写入与文档写入共用一个 step。
	/** The writes to `table` in this transaction, made by the first. */
	// 覆盖层共享 #writes.staged 数组：提交时按登记顺序执行。
	#changes(table: object): TableChanges {
		const handle = this.#handle(table);
		// 懒创建：纯文档事务不会为表格 Map 分配内存。
		this.#tables ??= new Map();
		let changes = this.#tables.get(handle);
		if (changes === undefined) {
			this.#writes ??= { store: handle.store, staged: [] };
			changes = new TableChanges(handle, this.#writes.staged);
			this.#tables.set(handle, changes);
		}
		return changes;
	}

	// 函数说明：把一个异步读计入 pending，直到它结算；输入 Promise，返回同样的结果。
	// finally 保证失败也减计数；pending 只用于 commit 的“回调提前返回”检查。
	// 不复制/包装结果：调用方拿到原 Promise 的解析值，错误也原样传播。
	/** Counts `read` as pending until the operation's promise settles (rule 3). */
	async #track<T>(read: Promise<T>): Promise<T> {
		this.#pending++;
		try {
			return await read;
		} finally {
			this.#pending--;
		}
	}

	// 函数说明：取或创建 entry 的草稿；返回 Delta 的 Draft；同一 entry 只创建一次。
	// 若 entry 标记了退役，草稿从 initial 开始（退役后重新创建）；否则从当前文档开始。
	// tracker.beginChange() 返回一个 Change，其 state 就是可写的 Draft；同一事务内重复 draft 返回同一个 state。
	// 例：items 已存在 {n:1}，tx.draft(items) 返回的 Draft 读到 n=1，修改后 commit 时与 base 比较得到 ops。
	/** The entry's draft, begun on the current document (or a fresh `initial()`) by the first use. */
	#begin(entry: Entry): Draft<JsonObject> {
		// 首次草拟：有当前值就用其 tracker，否则把 initial 用 track 包成 tracker，然后开始一次变更。
		if (entry.draft === undefined) {
			const { slot, key } = entry;
			// 三元表达式：retire 为真时忽略当前值，草稿从 initial 重新开始；否则用槽当前 tracker（可能触发迁移）。
			const current = entry.retire ? undefined : slot.current(key);
			const tracker = current ?? track(slot.initial(this.#context));
			entry.draft = { tracker, change: tracker.beginChange() };
		}
		return entry.draft.change.state;
	}
}

// 函数说明：检查退役的冷文档是否可读；输入 find 结果/持久槽/槽，返回无；读不懂时 owner broken 并抛出。
// checkReadable 比较存储版本与代码版本、指纹；这是 R15 的版本栅栏，不是普通类型检查。
// 例：磁盘上是 v2 文档，代码仍是 v1 → 抛错并让对象 broken，而不是静默覆盖。
/** Throws, failing `slot`'s owner `broken`, when its definition cannot read the cold document `found` (R15). */
function checkFound(found: FoundDocument, persisted: PersistedSlot, slot: DocumentSlot): void {
	try {
		checkReadable({ version: found.stored.version, fingerprint: found.fingerprint }, persisted.definition.current);
	} catch (error) {
		const failure = asChordError(error, slot.owner.label);
		slot.owner.fail(failure);
		throw failure;
	}
}
