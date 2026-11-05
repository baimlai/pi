// Durable's `Storage` on Chord's store (slice 6b D1, D2, §2): opening under an owner name (claims, tables, the
// allocator), commits as one composite write of the store's commit step, and the reads, each one guarded read of the
// store (several queries at one state in a read transaction), its request errors in a tagged result told after it.

// 文件导读

// 所属：packages/durable/src/storage/store 的 StoreStorage 主体（Chord store 后端）。

// 职责边界：实现 Durable 的 Storage 接口。打开时在 store 的 owner 名下声明并准备六张表、占用文档命名空间、

//   抬高全局 id 分配器；提交时把每个 batch 变成 store 的 series commit；读取时通过 store 的受保护读执行 SQL。

//   它不拥有宿主 store（close 只释放 claims/命名空间），也不解析业务 JSON 的具体含义。

// 上下游：应用经 ./index.ts 导入；上游还有 Session/Harness；下游是 Chord 的 StoreOwnerTables、commitSeries、

//   read/readTransaction、文档引擎函数，以及本目录 commit.ts/documents.ts/queries.ts/tables.ts。

// 结果与错误：读取的请求级错误以 StorageRequestError 抛出且只失败该读取；打开/提交错误拒绝 Promise；

//   已关闭后的调用抛普通 Error。

// 能力清单：

// - StoreStorage（类）：Storage 实现；open 打开，commit/mintId 是写路径，其余是读取路径。

// - Read<T>（内部类型）：受保护读的“找到/拒绝”标记结果，拒绝在读事务结束后才转成异常。

// - scanFrom/page/cursorId 与 told/documentOf（辅助函数）：分页、游标和读取结果转换。

// 组合顺序：StoreStorage.open -> commitSeries(DurableCommit) / read -> close（不关闭 store）。

// 示例：const storage = await StoreStorage.open(store, "durable.app", context);

//   const result = await storage.commit([[{ type: "conversation", value }]], receive, context);

// 阅读顺序：类字段与 open -> commit -> 表扫描 -> 文档与 fork 链读取 -> 底部辅助函数。

import {
	type ChordStore,
	type Claimant,
	findDocumentEntry,
	listDocumentEntries,
	type SeriesCommit,
	type Store,
	StoreOwnerTables,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { StorageRequestError } from "../../errors.ts";
import { idFromNumber, seqFromNumber } from "../../ids.ts";
import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	Page,
	ScanOrder,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../../types.ts";
import { nextCursor, type ScanStart, scanStart } from "../scan.ts";
import { type CommitTables, DurableCommit } from "./commit.ts";
import { addressOf, type DocumentRead, namespaceOf, readAt, recordOfEntry, SCOPE_NAMESPACES } from "./documents.ts";
import { type Condition, type StorageQueries, storageQueries, type TableQueries } from "./queries.ts";
import { Conversations, Entries, EntryHeads, encodeIndexed, RecordIds, Submissions, Tasks } from "./tables.ts";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };

/**
 * A guarded read's result: its data, or its request error, which is thrown after the guarded read (slice 6b §1.4),
 * never inside it.
 */
type Read<T> = { readonly kind: "found"; readonly value: T } | { readonly kind: "refused"; readonly message: string };

/** The id condition of a table scan from `start`. */
// 把分页起点翻译成 id 条件：升序取大于 after 的行（首页用 -1），降序取小于 after 的行
// （首页用 MAX_SAFE_INTEGER），与方向共同保证游标不重复也不跳过。
function scanFrom(start: ScanStart): Condition {
	return start.order === "ascending"
		? ["id", "gt", start.after ?? -1]
		: ["id", "lt", start.after ?? Number.MAX_SAFE_INTEGER];
}

// 把“多取一条”的查询结果切成一页：values 可能含 limit+1 条，多出的那条只用于判断是否还有下一页。
// items.at(-1) 取最后一条返回项的 id 生成游标；! 断言它存在，因为只有超长时才会走到这里。
function page<T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder,
): Page<T, Cursor> {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items.at(-1)!.id, order) };
}

// 从 JSON 游标取出 after 并做运行时校验：游标是调用方传入的请求数据，TypeScript 无法保证其形状。
// 非数字、小数、NaN、Infinity 或超出安全整数范围都抛 StorageRequestError，只失败该次读取。
function cursorId(cursor: Cursor | undefined): number | undefined {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	return after;
}

/**
 * Durable's `Storage` on Chord's store (slice 6b D1, D2, §2): its records as declared tables under an owner name, its
 * documents in the store's documents engine, its ids from the store's one allocator, each commit call as one series
 * of the store's commit queue (one backend transaction, one seq per batch), published in the host's batch. Several may share a store under distinct owner names
 * (claims); the app owns the store, and `close` leaves it open.
 */
export class StoreStorage implements Storage {
	// store 与 owner 名在打开后保持不变；tables 是已声明表的写入/查询句柄，queries 是预编译读取。
	readonly #store: ChordStore;
	readonly #owner: string;
	readonly #claimant: Claimant;
	readonly #tables: CommitTables;
	readonly #queries: StorageQueries;
	// closed/closing 实现幂等的 close；underway/drained 让 close 等待仍在进行的提交和 mintId。
	#closed = false;
	#closing: Promise<void> | undefined;
	/** Calls underway, which `close` waits for before it releases the claims (`#drained` once they reach 0). */
	#underway = 0;
	#drained: (() => void) | undefined;

	// 构造函数是 private：调用者必须走 open，确保 claim、迁移和 id 分配器提升都已完成。
	private constructor(store: ChordStore, owner: string, claimant: Claimant, tables: CommitTables) {
		this.#store = store;
		this.#owner = owner;
		this.#claimant = claimant;
		this.#tables = tables;
		this.#queries = storageQueries(tables);
	}

	/**
	 * Opens Durable's storage in `store` under `owner` (a lowercase `[a-z0-9@/._~-]` name): claims its tables and its
	 * document namespaces (a second claim is refused `invalid/args`), creates or migrates its tables, and raises the
	 * store's allocator above every id it holds (one index read). A failure releases what it claimed.
	 */
	// 打开：在 store 中占用 owner 名下的六张表和三个文档命名空间，创建/迁移表，再把分配器抬到
	// record_ids 的最大 id 之上。参数 store 是已打开（或导入）的 Chord store，owner 是区分同级存储的受限名字；
	// 返回可用的 StoreStorage。表声明冲突、迁移失败或读表失败会释放 claim 后拒绝。
	// 例：await StoreStorage.open(chordStore, "durable.app", context) 打开一个独立命名空间；
	// 同一个 owner 第二次 open 会因 claim 冲突失败，而不是静默共享。
	static async open(store: Store, owner: string, context: Context): Promise<StoreStorage> {
		// Chord's own: `openStore` or `importStore` made it.
		const chord = store as ChordStore;
		// claimant 标识本次打开；Chord 的 claims 用它判断表名和文档命名空间是否已被别人占用。
		const claimant: Claimant = { label: `StoreStorage(${owner})` };
		try {
			// StoreOwnerTables 把逻辑表名渲染成 "<owner>:<table>" 并登记 claim；此时还没有建表。
			const declared = new StoreOwnerTables(chord, owner, claimant);
			// 六张表在打开时一次性声明；任何一张被其他 claimant 占用都会抛 invalid/args。
			const tables: CommitTables = {
				recordIds: declared.declare(RecordIds),
				conversations: declared.declare(Conversations),
				entries: declared.declare(Entries),
				entryHeads: declared.declare(EntryHeads),
				tasks: declared.declare(Tasks),
				submissions: declared.declare(Submissions),
			};
			// 文档命名空间按 Durable 的三种作用域占用：session、conversation:（前缀覆盖具体 id）和 task:。
			for (const namespace of SCOPE_NAMESPACES) chord.claims.documents(owner, namespace, claimant);
			// prepare 在 store 的提交队列中创建新表或迁移旧表；失败会进入 catch 释放 claim。
			await declared.prepare(context);
			// 读取已有 record_ids 的最大 id；不可为空表，因此用 id: number | null 表示聚合结果。
			const highest = await chord.read(
				(executor) =>
					executor.get<{ readonly id: number | null }>(
						`SELECT max("id") AS id FROM "${tables.recordIds.sql.table}"`,
					),
				context,
			);
			// 把分配器抬到历史最大 id 之上，保证重启后 mintId 不会复用已持久化的编号。
			if (highest?.id != null) chord.ids.raise(highest.id);
			return new StoreStorage(chord, owner, claimant, tables);
			// 打开失败时释放该 claimant 的全部表与命名空间声明，再把原错误抛给调用者。
		} catch (error) {
			chord.claims.release(claimant);
			throw error;
		}
	}

	/**
	 * Commit `batches` as one series of the store (`ChordStore.commitSeries`): one backend transaction, one seq per
	 * batch, each batch's checks (at staging, then against the state the earlier ones left) before its writes.
	 */
	// 提交：把每个 batch 构造成 DurableCommit（暂存行/内容并做本批检查），再作为 store 的一个 series 提交。
	// batches 按顺序检查；第一个被 Durable 拒绝的 batch 会停止 series，但之前的 batch 已经提交。
	// receive 只在所有已存储 batch 完成后同步调用，参数是 batch 下标和品牌化 Seq。
	// 例：commit([batchA, batchB], receive, ctx)；若 batchB 被拒绝，返回 { stored: 1, refused }。
	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult> {
		// #call 在关闭时拒绝新调用，并把进行中的调用计入 underway，供 close 等待。
		return this.#call(() => {
			const store = this.#store;
			// 暂存显式 id 时，DurableCommit 需要把 store 的分配器抬到该 id 之上，这里先绑定成简单函数。
			const raise = (id: number): void => store.ids.raise(id);
			// 构造 DurableCommit 就是暂存阶段：行被编码、文档内容被序列化、显式 id 被登记。
			const commits: SeriesCommit[] = [];
			for (const writes of batches) {
				// 逐个 batch 构造；try 只包住“Durable 自己拒绝”的情况，数据库错误仍会向上抛并回滚整个 series。
				try {
					commits.push(new DurableCommit(writes, this.#owner, this.#tables, raise, context));
					// 构造失败通常意味着该 batch 自身不合法（如两个内容命令、重复退役）。
				} catch (error) {
					// Staging runs Durable's checks of the batch itself: a refusal in its turn, the batches before it stored.
					// 用立即拒绝的 check 占位且 writes 为空：series 到这一批停止，前面的批次保持已提交。
					commits.push({ check: () => Promise.reject(error), writes: [] });
					break;
				}
			}
			// commitSeries 在 store 的提交队列里执行：一个后端事务、每批一个 seq，并在提交后回调 receive。
			// seq 从 store 的数字序号转成 Durable 的品牌 Seq；context 负责取消/追踪。
			return store.commitSeries(commits, (index, seq) => receive(index, seqFromNumber(seq)), context);
		});
	}

	/**
	 * Run a commit's publication in the attached host's batch (`batch.within`: it joins a running batch, opens one, or
	 * runs next while one sends): Chord sources over Durable's views are marked in one batch per commit. Plainly without
	 * a host.
	 */
	// 发布：把 Session 的发布步骤放进宿主 attached batch，使 Chord 观察者与提交处于同一批。
	// 没有宿主时直接同步执行 publish；with 的批量调度由 Chord host 负责。
	publishing(publish: () => void, context: Context): void {
		// batch 可能为 undefined（store 未附着 host）；batch.within 会加入/开启/排队一个 host batch。
		const batch = this.#store.batch;
		if (batch === undefined) publish();
		else batch.within(publish, context);
	}

	// 从 store 的全局分配器取号并打上 Id 品牌；关闭后 #call 拒绝，分配器耗尽时 Chord 抛错。
	mintId<I extends Id<string>>(): Promise<I> {
		return this.#call(async () => idFromNumber<I>(this.#store.mintId()));
	}

	// 按 id 点查会话记录；不存在返回 undefined。这是单条读，不经过 fork 链判断。
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		return this.#read((executor) => this.#conversation(executor, id, context), context);
	}

	// 扫描会话：按 id 排序，可再按 owner_conversation_id / owner_task_id 过滤，limit 是每页上限。
	// 没有 owner 条件的行不会返回错误；条件不匹配只是空页。
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.#reading(() => {
			// scanStart 合并请求方向、游标方向与默认升序，并拒绝中途改变方向或非法游标。
			const start = scanStart(query.order, cursor, "ascending");
			// id 条件始终存在；所有者过滤按需追加，SQL 由 #scan 通过预编译查询执行。
			const conditions: Condition[] = [scanFrom(start)];
			if (query.ownerConversationId !== undefined) {
				conditions.push(["owner_conversation_id", "eq", query.ownerConversationId]);
			}
			if (query.ownerTaskId !== undefined) conditions.push(["owner_task_id", "eq", query.ownerTaskId]);
			// #scan 内部多取一条以判断下一页，最后 page() 会切回 limit 条。
			return this.#scan<ConversationRecord>(this.#queries.conversations, conditions, start, limit, context);
		});
	}

	// 两个 entry 重载：只给 entry id 查全局；给 conversation id 再查它在 fork 链上是否可见。
	// 重载签名只在编译期存在，运行时由下面的实现根据参数个数和类型分支。
	entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		maybeContext?: Context,
	): Promise<StoredEntry | undefined> {
		// maybeContext 缺失表示三参重载：第二个参数就是 Context。
		if (maybeContext === undefined) {
			const context = idOrContext as Context;
			return this.#read((executor) => this.#entry(executor, idOrConversationId as EntryId, context), context);
		}
		// 四参重载：idOrConversationId 是会话，idOrContext 是数字 entry id，maybeContext 才存在。
		const context = maybeContext;
		// typeof 在运行时收窄 number；Context 是对象，不能用类型断言代替这个分支。
		const id = typeof idOrContext === "number" ? idFromNumber<EntryId>(idOrContext) : undefined;
		return this.#reading(() => {
			// entry id 不是数字说明调用方传错；作为 StorageRequestError 只失败该读取。
			if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
			const conversationId = idOrConversationId as ConversationId;
			return (
				this.#store
					.read((executor) => this.#visibleEntry(executor, conversationId, id, context), context)
					// told 把受保护读内部的 refused 结果转成异常；读事务此时已结束。
					.then(told)
			);
		});
	}

	// 在会话及其 fork 祖先中找最新的、带 head 标记的 entry；可给出包含上界的 entry id。
	// 返回的 entry 的 head 字段才是实际上下文下界；没有标记时返回 undefined。
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		// 用 read（受保护读）执行多步查询；latestHeadMarker 只返回标记结果。
		return this.#reading(() =>
			this.#store
				.read((executor) => this.#latestHeadMarker(executor, conversationId, atOrBeforeEntryId, context), context)
				.then(told),
		);
	}

	// 扫描会话的 fork-aware 消息历史；query 可带 min/max entry id，order 默认降序。
	// 升序和降序分别由两个私有方法处理，因为 fork 链的遍历方向不同。
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.#reading(() => {
			// 游标继续它创建时的方向；没有游标时按查询方向或默认降序。
			const { order, after } = scanStart(query.order, cursor, "descending");
			// 选出方向对应的读实现；两个方法返回 Read<Page>，请求错误在 store.read 之外才抛出。
			const read =
				order === "ascending"
					? (executor: SqliteExecutor) => this.#entriesAscending(executor, query, limit, after, context)
					: (executor: SqliteExecutor) => this.#entriesDescending(executor, query, limit, after, context);
			return this.#store.read(read, context).then(told);
		});
	}

	// 按 id 读取任务的最新完整记录；不存在返回 undefined。
	task(id: TaskId, context: Context): Promise<StoredTask | undefined> {
		const tasks = this.#queries.tasks;
		// byId 使用预编译点查；record() 只解析 record 列中的 JSON 文本。
		return this.#read(async (executor) => {
			const row = await tasks.byId(executor, id);
			return row === undefined ? undefined : tasks.record<StoredTask>(row, context);
		}, context);
	}

	// 扫描任务：所有给出的过滤条件同时成立，按 id 方向排序并分页。
	// kind 用 encodeIndexed 编码后比较，保持与写入时的索引形式一致。
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		return this.#reading(() => {
			const start = scanStart(query.order, cursor, "ascending");
			const conditions: Condition[] = [scanFrom(start)];
			// 逐个追加可选条件；boolean 转成 1/0，因为数据库列是整数哨兵。
			if (query.conversationId !== undefined) conditions.push(["conversation_id", "eq", query.conversationId]);
			if (query.kind !== undefined) conditions.push(["kind", "eq", encodeIndexed(query.kind)]);
			if (query.status !== undefined) conditions.push(["status", "eq", query.status]);
			if (query.abortRequested !== undefined)
				conditions.push(["abort_requested", "eq", query.abortRequested ? 1 : 0]);
			if (query.background !== undefined) conditions.push(["background", "eq", query.background ? 1 : 0]);
			return this.#scan<StoredTask>(this.#queries.tasks, conditions, start, limit, context);
		});
	}

	// 按 id 读取 submission 的最新记录；不存在返回 undefined。
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		const submissions = this.#queries.submissions;
		return this.#read(async (executor) => {
			const row = await submissions.byId(executor, id);
			return row === undefined ? undefined : submissions.record<SubmissionRecord>(row, context);
		}, context);
	}

	// 扫描 submission：可按会话与状态过滤，按 id 排序分页。
	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.#reading(() => {
			const start = scanStart(query.order, cursor, "ascending");
			const conditions: Condition[] = [scanFrom(start)];
			if (query.conversationId !== undefined) conditions.push(["conversation_id", "eq", query.conversationId]);
			if (query.status !== undefined) conditions.push(["status", "eq", query.status]);
			return this.#scan<SubmissionRecord>(this.#queries.submissions, conditions, start, limit, context);
		});
	}

	// 按“会话 + 请求去重键”查找 submission；request_id 列存的是 JSON 编码后的字符串。
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		const submissions = this.#queries.submissions;
		const conditions: Condition[] = [
			["conversation_id", "eq", conversationId],
			["request_id", "eq", encodeIndexed(requestId)],
		];
		return this.#read(async (executor) => {
			const row = await submissions.first(executor, conditions, "ascending");
			return row === undefined ? undefined : submissions.record<SubmissionRecord>(row, context);
		}, context);
	}

	// 在某个时间点（Seq 或 current）解析文档地址上存活的 incarnation；只返回 Durable 记录。
	// 地址会先映射成 Chord 文档引擎的 owner/namespace/kind/key 形式。
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		return this.#read(async (executor) => {
			// findDocumentEntry 只读 meta/retired_at 等少量列；recordOfEntry 再解析出 Durable 记录。
			const entry = await findDocumentEntry(executor, addressOf(address, this.#owner), at);
			return entry === undefined ? undefined : recordOfEntry(entry);
		}, context);
	}

	// 按文档 id 在某个时间点物化内容；记录与修订必须在同一已提交状态读取，因此用 readTransaction。
	// 记录不保留历史（latest）却请求历史点时，documentOf 会抛 StorageRequestError。
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		// The record and its revisions must come from one committed state (S4).
		// readAt 返回标记结果；then(documentOf) 在读事务结束后把 current_only 转成请求错误。
		return this.#reading(() =>
			this.#store.readTransaction((executor) => readAt(executor, id, at, this.#owner), context).then(documentOf),
		);
	}

	// 扫描某个作用域在某个时间点存活的文档 incarnation，按 id 升序分页。
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.#reading(() => {
			// 文档扫描的游标只有 after；缺省从 -1 开始，保证第一页包含所有正 id。
			const after = cursorId(cursor) ?? -1;
			// scope 把 Durable 作用域映射为 owner + namespace；kind 作为可选过滤条件。
			const scope = {
				owner: this.#owner,
				namespace: namespaceOf(query.scope),
				// 条件展开：没有 kind 时不传该字段，而不是传 undefined 让查询层处理。
				...(query.kind === undefined ? {} : { kind: encodeIndexed(query.kind) }),
			};
			return (
				this.#store
					// 多取一条判断下一页；返回的条目先经过 recordOfEntry 还原成 Durable 记录。
					.read((executor) => listDocumentEntries(executor, scope, query.at, after, limit + 1), context)
					.then((found) => page(found.map(recordOfEntry), limit, "ascending"))
			);
		});
	}

	/**
	 * Refuses new calls, waits for its commits underway, then releases its claims; the store stays open (the app's),
	 * and finishes the reads underway, which change nothing.
	 */
	// 关闭 StoreStorage：拒绝新调用，等待正在进行的提交/mint，然后释放 claims；宿主 store 保持打开。
	// 读取不会被等待，因为它们不改变状态，且 store 仍可用。多次调用共享同一个 closing Promise。
	close(_context: Context): Promise<void> {
		if (this.#closing === undefined) {
			// 首次 close 设置 closed 并缓存 Promise；重复调用直接返回同一 Promise，保证幂等。
			this.#closed = true;
			this.#closing = (async () => {
				if (this.#underway > 0) {
					// 有提交或 mint 尚未结束时等待；#call 的 finally 在计数归零时调用 drained。
					await new Promise<void>((resolve) => {
						this.#drained = resolve;
					});
				}
				// 只释放本存储的声明；应用负责随后关闭 Chord store。
				this.#store.claims.release(this.#claimant);
			})();
		}
		return this.#closing;
	}

	/** Runs one commit or mint of this storage: refused once it closed, counted until it settles (`close` waits). */
	// 执行一个写路径调用（commit 或 mintId）：关闭后拒绝，并在整个 Promise 期间计入 underway。
	// 用 finally 保证成功、失败或取消都能把计数减回去，让 close 不会漏等。
	async #call<T>(run: () => Promise<T>): Promise<T> {
		if (this.#closed) throw new Error("StoreStorage is closed");
		// 先拒绝再自增；否则关闭后的调用可能让 close 永远等不到 drained。
		this.#underway++;
		try {
			return await run();
		} finally {
			if (--this.#underway === 0) this.#drained?.();
		}
	}

	/**
	 * A call that is one guarded read of the store: refused once closed; not waited for by `close` (a read changes
	 * nothing, and the store, which stays open, finishes it).
	 */
	// 单条受保护读：检查关闭后直接交给 store.read；读取不增加 close 的等待计数。
	#read<T>(read: (executor: SqliteExecutor) => Promise<T>, context: Context): Promise<T> {
		return this.#reading(() => this.#store.read(read, context));
	}

	/**
	 * A read call: `read` prepares its guarded read (a request error thrown then, before it) and returns it. Refused
	 * once closed; one promise per call besides the guard's (no async wrapper).
	 */
	// 读调用的统一入口：read 先构造受保护读（可能同步抛请求错误），这里把它转成 rejected Promise。
	// 不使用 async 包装，保持一个调用一个 Promise，避免额外微任务。
	#reading<T>(read: () => Promise<T>): Promise<T> {
		try {
			// 关闭后不再发起新读取。
			if (this.#closed) throw new Error("StoreStorage is closed");
			return read();
			// 同步抛出的错误也变成 Promise 拒绝，调用方只需 await。
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// 读一条会话并解析其 record；供 fork 链遍历复用。
	async #conversation(
		executor: SqliteExecutor,
		id: ConversationId,
		context: Context,
	): Promise<ConversationRecord | undefined> {
		const conversations = this.#queries.conversations;
		// 使用预编译的按 id 读取；record 列是完整 JSON 文本。
		const row = await conversations.byId(executor, id);
		return row === undefined ? undefined : conversations.record<ConversationRecord>(row, context);
	}

	// 读一条 entry 及它被持久化时的提交序号；不存在返回 undefined。
	#entry(executor: SqliteExecutor, id: EntryId, context: Context): Promise<StoredEntry | undefined> {
		const entries = this.#queries.entries;
		return entries.byId(executor, id).then((row) => {
			if (row === undefined) return undefined;
			// commit_seq! 表达所选行一定包含该列（列清单由 entries 表的 byIdExtra 保证）。
			return { entry: entries.record<EntryRecord>(row, context), commitSeq: seqFromNumber(row.commit_seq!) };
		});
	}

	/** Entry `id` when visible through `conversationId`'s fork chain (`SqliteStorage.readEntry`). */
	// 在 conversationId 的 fork 链上判断 entry id 是否可见，并返回其提交序号。
	// 返回 Read 标记结果：未知会话在受保护读结束后才转成 StorageRequestError。
	async #visibleEntry(
		executor: SqliteExecutor,
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
		// 先读请求的会话；未知会话是请求错误，不是空结果。
	): Promise<Read<StoredEntry | undefined>> {
		let conversation = await this.#conversation(executor, conversationId, context);
		if (conversation === undefined) return unknownConversation(conversationId);
		const stored = await this.#entry(executor, id, context);
		if (stored === undefined) return NOTHING_FOUND;
		// upper 是当前会话段允许的最大 entry id；初始无上界。
		let upper = Number.POSITIVE_INFINITY;
		// 沿着 parent 逐段向祖先走，直到找到 entry 所属的会话。
		while (conversation.id !== stored.entry.conversationId) {
			// 没有父会话说明 entry 不属于这条 fork 链。
			if (conversation.parent === undefined) return NOTHING_FOUND;
			// 每经过一层 fork，就把上界收紧到父会话的 fork 点。
			upper = Math.min(upper, conversation.parent.at);
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
		// entry id 超过 fork 点表示它来自另一条分支，对请求的会话不可见。
		return stored.entry.id > upper ? NOTHING_FOUND : { kind: "found", value: stored };
	}

	// 在 fork 链中找最新 head 标记：先查当前会话，找不到再查父会话，且上界随 fork 点收紧。
	// atOrBeforeEntryId 限制“最新”的范围；返回的 entry 记录里 head 才是上下文起点。
	async #latestHeadMarker(
		executor: SqliteExecutor,
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<Read<(EntryRecord & { readonly head: EntryId }) | undefined>> {
		// 先定位会话；未知会话是请求错误。
		let conversation = await this.#conversation(executor, conversationId, context);
		if (conversation === undefined) return unknownConversation(conversationId);
		// upper 是本段的最大 entry id；undefined 表示本段没有上界。
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			// latestHead 的两条预编译语句：不带/带 at-or-before 上界。
			const { latestHead } = this.#queries;
			const head =
				upper === undefined
					? await executor.get<{ readonly id: number }>(latestHead.any, conversation.id)
					: await executor.get<{ readonly id: number }>(latestHead.atOrBefore, conversation.id, upper);
			if (head !== undefined) {
				// head 行与 entry 在同一提交写入，因此按 id 一定能读到。
				// Written with its entry, in the same commit.
				const row = (await this.#queries.entries.byId(executor, head.id))!;
				const value = this.#queries.entries.record<EntryRecord & { readonly head: EntryId }>(row, context);
				return { kind: "found", value };
			}
			// 本段没有标记就沿 parent 继续；没有 parent 则整个链都没有。
			if (conversation.parent === undefined) return NOTHING_FOUND;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
	}

	/** Newest first: each conversation of the fork chain up to its fork point (`SqliteStorage.readEntries`). */
	// 降序扫描：从最新会话段开始，沿 fork 链逐段向前，每段只取到 fork 点。
	async #entriesDescending(
		executor: SqliteExecutor,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
		context: Context,
	): Promise<Read<Page<EntryRecord, Cursor>>> {
		// 先读会话；未知会话是请求错误。
		let conversation = await this.#conversation(executor, query.conversationId, context);
		if (conversation === undefined) return unknownConversation(query.conversationId);
		// upper 是本轮查询的最大 id；游标 after 进一步把它限制为 after - 1。
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		// values 累积已取到的记录；limit+1 的余量用于判断下一页。
		const values: EntryRecord[] = [];
		while (true) {
			// 当前段的 id 范围由 minEntryId 与本轮 upper 共同决定。
			const range = this.#range(conversation.id, query.minEntryId, upper);
			// 只请求还缺的条数（limit + 1 - values.length），避免多读。
			const rows = await this.#queries.entries.select(executor, range, "descending", limit + 1 - values.length);
			this.#queries.entries.records(rows, values, context);
			// 已超过 limit 或没有父会话时停止；否则把上界移到父会话 fork 点继续。
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			// 下界已经越过父 fork 点时，祖先段不可能再有符合范围的 entry。
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
		return { kind: "found", value: page(values, limit, "descending") };
	}

	// 升序扫描：先收集从根到当前会话的各段，再反向从根开始查询。
	/** Oldest first: the fork chain's segments from the root forward, each up to its fork point. */
	async #entriesAscending(
		executor: SqliteExecutor,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
		context: Context,
	): Promise<Read<Page<EntryRecord, Cursor>>> {
		// segments 保存每段会话及其上界；最后逆序即从最老祖先到当前会话。
		const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
		let conversation = await this.#conversation(executor, query.conversationId, context);
		if (conversation === undefined) return unknownConversation(query.conversationId);
		// 沿 fork 链构建段列表；每层都把上界收紧到父 fork 点。
		let upper: number | undefined = query.maxEntryId;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			// 下界已越过祖先 fork 点时，更早的段无需收集。
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.#conversation(executor, conversation.parent.conversationId, context))!;
		}
		// 游标 after 要求下界至少为 after + 1，避免重复上一页最后一条。
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		const values: EntryRecord[] = [];
		// 从根段开始逐段查询，保证升序结果与全局 id 顺序一致。
		for (const segment of segments.reverse()) {
			const range = this.#range(segment.conversationId, lower, segment.upper);
			const rows = await this.#queries.entries.select(executor, range, "ascending", limit + 1 - values.length);
			this.#queries.entries.records(rows, values, context);
			if (values.length > limit) break;
		}
		return { kind: "found", value: page(values, limit, "ascending") };
	}

	// 构造单会话的 entry 范围条件：会话相等，可选下界/上界都是包含的。
	/** One conversation's entries with ids from `lower` to `upper` (inclusive, each optional). */
	#range(conversationId: ConversationId, lower: number | undefined, upper: number | undefined): Condition[] {
		const conditions: Condition[] = [["conversation_id", "eq", conversationId]];
		if (lower !== undefined) conditions.push(["id", "gte", lower]);
		if (upper !== undefined) conditions.push(["id", "lte", upper]);
		return conditions;
	}

	// 通用表扫描：多取一条判断下一页，再把 record 列解码成 T。
	// queries.select 使用预编译 SQL；records 批量解析 JSON，context 供可能的列迁移使用。
	/** A page of a table scan: up to `limit` records of `queries`' table whose `conditions` hold, from `start`. */
	#scan<T extends { readonly id: Id<string> }>(
		queries: TableQueries,
		conditions: readonly Condition[],
		start: ScanStart,
		limit: number,
		context: Context,
	): Promise<Page<T, Cursor>> {
		return this.#store
			.read((executor) => queries.select(executor, conditions, start.order, limit + 1), context)
			.then((rows) => {
				const values: T[] = [];
				queries.records(rows, values, context);
				return page(values, limit, start.order);
			});
	}
}

// 常量结果复用同一个对象；Read<undefined> 表示“受保护读成功但没有值”。
/** A read that found nothing. */
const NOTHING_FOUND: Read<undefined> = { kind: "found", value: undefined };

// 未知会话的拒绝结果；由 told 在读事务结束后转成 StorageRequestError。
function unknownConversation(id: ConversationId): Read<never> {
	return { kind: "refused", message: `Unknown conversation: ${id}` };
}

/** A read's data, its request error thrown now that the guarded read returned (slice 6b §1.4). */
// 在读结束后抛出请求错误：在 store.read 的回调内抛会被视为后端故障并停止 store。
function told<T>(read: Read<T>): T {
	if (read.kind === "refused") throw new StorageRequestError(read.message);
	return read.value;
}

/** A document read's result, a record that keeps no history at the point thrown as Durable's request error. */
// 文档读结果转换：只有 latest 历史的文档请求历史点时才是请求错误；其余情况返回记录或 undefined。
function documentOf(read: DocumentRead): StoredDocument | undefined {
	if (read.kind === "current_only")
		throw new StorageRequestError(`Document ${read.id} does not retain historical content`);
	return read.document;
}
