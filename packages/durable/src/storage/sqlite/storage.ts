// 文件导读
// 所属：packages/durable/src/storage/sqlite 的 SQLite 存储实现，是 Durable 的 Storage 接口在可移植 SQLite 上的完整后端。
// 职责边界：拥有一个已打开的 SqliteDatabase；打开时应用迁移、读取全局 next_id/next_seq；提交时在一个 SQL 事务里
//   逐 batch 检查并写入表行与文档；读取时按表查询、沿 fork 链拼装历史、按时间点物化文档。它不创建连接、
//   不选择驱动（Node/Durable Object 入口在 node.ts/cloudflare.ts），也不解释任务或会话业务状态。
// 上下游：Session/Harness 通过 Storage 接口调用；上游打开入口传入 SqliteDatabase；下游是 schema.ts 的表名、
//   migrations.ts 的迁移历史、Chord delta 的 apply 以及 SQLite 驱动。
// 结果与错误：非法读取抛 StorageRequestError（只失败该读取）；提交/关闭/数据库错误是致命错误；
//   close 后所有方法立即抛错。
// 能力清单：
// - SqliteStorageOptions（类型）：表/索引前缀。
// - SqliteStorage（类）：open/commit/mintId 与全部读取方法。
// - 内部辅助：分页/游标、文档地址编码、id 检查、文档动作检查、行写入与文档物化。
// 组合顺序：SqliteStorage.open(db, options) -> commit([...]) / 读取 -> close(context)。
// 示例：const storage = await SqliteStorage.open(db, { prefix: "pi_" });
//   await storage.commit([[{ type: "conversation", value }]], (i, seq) => {}, context);
// 阅读顺序：类型与常量 -> 打开 -> commit（检查/写入的事务骨架）-> 表读取 -> fork 链 -> 文档物化与文档写入。
import type { Context } from "@earendil-works/chord/context";
// Context 只用于接口一致性；SQLite 方法本身不持有取消状态（commit 的 _context 未使用）。
import { apply, type Op } from "@earendil-works/chord/delta";
// apply 把文档的 delta 操作序列应用到 base 值上，用于历史点物化。
import type { JsonValue } from "@earendil-works/chord/json";
// 驱动契约：SqliteDatabase 拥有事务/close，SqliteExecutor 是事务内执行器，SqliteValue 是可绑定值。
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
// 请求级读取错误：未知会话、非法游标、历史点不可用等，不应停止 Session。
import { StorageRequestError } from "../../errors.ts";
// 数字与品牌类型的转换；品牌只在编译期区分会话/条目/提交序号。
import { idFromNumber, seqFromNumber } from "../../ids.ts";
import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
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
import { applySqliteMigrationsForSchema } from "./migrations.ts";
import { createSqliteSchema, type SqliteSchema } from "./schema.ts";

// 任务记录在存储层不关心输入/检查点/结果的具体类型，统一用 JsonValue。
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
// record_ids 允许的五种记录类型。
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
// record_ids 查询只取类型列。
type RecordIdRow = { readonly record_type: TableName };
// 只选 record 列的通用行；record 是完整记录的 JSON 文本。
type JsonRow = { readonly record: string };
// entry 查询额外需要 commit_seq。
type EntryJsonRow = { readonly record: string; readonly commit_seq: number };
// 文档修订行：seq 定位，kind 区分 base/delta，version 用于版本边界检查，content 是 JSON 文本。
type RevisionRow = {
	readonly seq: number;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: string;
};
// 只取 id：当前地址查询与最大 id 查询使用。
type IdRow = { readonly id: number };
// durable_metadata 单行：next_id 以文本保存（避免超出安全整数时丢精度），next_seq 是下一个提交序号。
type MetadataRow = { readonly next_id: string; readonly next_seq: number };
// 一个文档在批次内合并后的命令：创建、复制源、内容、退役。
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};
// 文档作用域落库为 scope_kind + owner_id；session 的 owner_id 固定为 0。
type ScopeColumns = {
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
};

// 打开选项：prefix 会加到所有表和索引名之前。
// 它必须是合法 SQLite 标识符且不能使用保留的 sqlite_ 前缀；改变 prefix 不会迁移已有数据。
export type SqliteStorageOptions = {
	/**
	 * Prefix for every table and index in the durable schema. It must be a SQLite identifier and must not use
	 * SQLite's reserved `sqlite_` prefix. Existing data is not migrated when this changes.
	 */
	readonly prefix?: string;
};

// JSON 解析/序列化辅助：存储层信任自己写入的 JSON，因此断言目标类型而不做 schema 校验。
const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value) as string;
// 需要索引的字符串（kind/request_id/文档 kind/key）用 JSON 编码，避免 SQLite 驱动替换孤立 UTF-16 代理项
// 或丢失 NUL 导致身份冲突。encodeIndexedString 与写入端必须保持一致。
// Some SQLite bindings replace lone UTF-16 surrogates. JSON encoding keeps indexed identities lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

// 从游标读取 after 并转成品牌 id；游标是外部请求数据，因此做数字与安全整数检查。
// 例：{ after: 8 } 在升序扫描中表示从 id > 8 继续。
const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	return idFromNumber<I>(after);
};

// 把多取一条的结果切成页：超过 limit 时用最后一条返回项生成 next 游标。
// order 缺省为升序，与旧调用兼容；items.at(-1)! 只在确实超长时求值。
const page = <T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: nextCursor(items.at(-1)!.id, order) };
};

// 把 ScanStart 渲染成 id 比较 SQL 片段、绑定参数和 ORDER BY 方向；首页的边界用 -1 或 MAX_SAFE_INTEGER。
/** The ID condition, its parameter, and the `ORDER BY` direction of a table scan. */
const scanSql = (start: ScanStart): { readonly clause: string; readonly param: number; readonly direction: string } =>
	start.order === "ascending"
		? { clause: "id > ?", param: start.after ?? -1, direction: "ASC" }
		: { clause: "id < ?", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

// 把 Durable 作用域转成落库列：session 用 owner_id 0，conversation/task 用各自 id。
// switch 覆盖联合类型的全部分支，TS 因此认为函数总有返回值。
const scopeColumns = (scope: DocumentRecord["scope"]): ScopeColumns => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};

// 文档地址的索引列：kind 编码，作用域列展开，family 区分单例/带键，keyValue 编码（缺失用空串）。
// 单例与“空字符串 key 的族成员”共用列值，由记录中的 key 字段语义区分。
const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

// 地址唯一性检查的键：把 kind/作用域/family/key 组成 JSON 字符串，作为进程内 Map 的键。
const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

// 半开生存期：current 只看未退役；历史点要求 createdAt <= at < retiredAt（若已退役）。
const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

// 非会话作用域或 latest 历史的文档不保留历史内容，只能读 current。
const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

// 提取一条写入声明的 id：表记录取 value.id，文档创建/复制取 record.id；change/retire 不声明新 id。
// 返回 Id 品牌联合或 undefined，调用方据此跳过。
const writeId = (write: StorageWrite): Id<string> | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

// 提交检查期间记录数据库调用是否失败：失败说明是数据库故障（未知结果），不是 Durable 的拒绝。
/** Whether a database call of the checks failed, whatever it threw or rejected with. */
type CheckCalls = { failed: boolean };

/**
 * `executor`, setting `calls.failed` when one of its calls throws, synchronously (a synchronous driver) or by
 * rejecting, with any value: then a failing check is the database's, not one of Durable's own.
 */
// 包装执行器：所有方法都先捕获同步异常和 Promise 拒绝，置 failed 后再原样抛出。
// 这样 commit 能区分“检查拒绝该 batch”和“数据库坏了/断电”，后者必须回滚整个事务。
function watchCalls(executor: SqliteExecutor, calls: CheckCalls): SqliteExecutor {
	const watched = async <T>(call: () => Promise<T>): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			calls.failed = true;
			throw error;
		}
	};
	return {
		exec: (sql) => watched(() => executor.exec(sql)),
		run: (sql, ...params) => watched(() => executor.run(sql, ...params)),
		runCounted: (sql, ...params) => watched(() => executor.runCounted(sql, ...params)),
		get: (sql, ...params) => watched(() => executor.get(sql, ...params)),
		all: (sql, ...params) => watched(() => executor.all(sql, ...params)),
	};
}

// 可移植 SQLite 上的 Storage 实现；构造私有，必须经 open 完成迁移与元数据读取。
/** Portable SQLite implementation of the Pico storage contract. */
export class SqliteStorage implements Storage {
	// schema 固定本次打开的表名；nextId 是内存中的分配器，close 后不再使用。
	private readonly db: SqliteDatabase;
	private readonly schema: SqliteSchema;
	private nextId: number;
	private closed = false;
	// admittedReads 统计跨多条查询的读取；close 等待它们结束，避免后续查询打到已关闭连接。
	private closing: Promise<void> | undefined;
	private admittedReads = 0;
	private readsDrained: (() => void) | undefined;

	// 构造只保存已迁移的数据库、schema 和 next_id；不读表、不写表。
	private constructor(db: SqliteDatabase, schema: SqliteSchema, nextId: number) {
		this.db = db;
		this.schema = schema;
		this.nextId = nextId;
	}

	// 打开：生成 schema（含前缀校验）、应用迁移、读取元数据中的 next_id/next_seq。
	// 失败时先尝试关闭数据库以释放资源，再抛出原始初始化错误；返回已可用的存储。
	// 例：await SqliteStorage.open(db, { prefix: "pi_" }) 会创建 pi_conversations 等表并读取 pi_durable_metadata。
	/** Initialize storage over an owned SQLite database facade. */
	static async open(db: SqliteDatabase, options: SqliteStorageOptions = {}): Promise<SqliteStorage> {
		try {
			// 先校验前缀再拼接 SQL；非法名称在这里就失败，不会执行任何迁移。
			const schema = createSqliteSchema(options.prefix);
			// 迁移在事务中执行，已完成的版本会跳过；数据库版本比代码新时这里会抛错。
			await applySqliteMigrationsForSchema(db, schema);
			// 元数据表必须有 singleton=1 的一行；next_id 以字符串读出再转 number。
			const metadata = await db.get<MetadataRow>(
				`SELECT next_id, next_seq FROM ${schema.tables.durableMetadata} WHERE singleton = 1`,
			);
			// 元数据缺失属于数据库损坏/初始化异常，不能当成新库继续。
			if (metadata === undefined) throw new Error("Durable SQLite metadata is missing");
			return new SqliteStorage(db, schema, Number(metadata.next_id));
		} catch (error) {
			// 初始化失败后尽力关闭连接；关闭本身失败会被忽略，保留原始错误。
			try {
				await db.close();
			} catch {
				// Preserve the initialization failure.
			}
			throw error;
		}
	}

	// 提交多个 batch：在一个 SQL 事务中按顺序检查并写入，每个 batch 一个提交序号。
	// 检查在写入之前执行；第一个被 Durable 检查拒绝的 batch 停止后续，但之前的 batch 仍随事务提交。
	// 不使用 savepoint（Durable Objects 不允许）；数据库调用失败则整个事务回滚，提交结果未知并拒绝。
	// receive 只在 COMMIT 成功后按顺序同步调用，表示这些批次已经持久化（不是发布）。
	// 例：commit([[a], [b]], receive, ctx)；若 b 检查失败，返回 { stored: 1, refused: errorB }。
	/**
	 * Commit `batches` in one SQL transaction, each with its own seq. Each batch is checked before it writes anything,
	 * against the state the earlier ones left, and the first one refused ends the batch: the transaction commits the ones
	 * before it. No savepoints, which Durable Objects do not allow: the checks run before the writes instead.
	 */
	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		_context: Context,
	): Promise<CommitResult> {
		// 关闭后保持关闭语义：所有方法先 assertOpen。
		this.assertOpen();
		// seqs 收集已写入 batch 的序号；refused 保存第一个检查拒绝；candidateNextId 先取内存值。
		const seqs: Seq[] = [];
		let refused: { readonly error: unknown } | undefined;
		let candidateNextId = this.nextId;
		// transaction 回调内所有语句共享同一事务；回调正常返回才 COMMIT。
		await this.db.transaction(async (transaction) => {
			// next 是事务内递增的下一个 seq；metadata 的 next_id 用于最后取最大。
			const metadata = await this.readMetadata(transaction);
			let next = metadata.next_seq;
			// calls 由 watchCalls 在数据库调用失败时置 true；每批开始前重置。
			// Whether a database call of a batch's checks failed: then the failure is an unknown outcome, not a refusal.
			const calls: CheckCalls = { failed: false };
			// checked 包装器让检查期间的数据库失败可以被识别。
			const checked = watchCalls(transaction, calls);
			// 逐 batch 处理；每个 batch 的 documentActions 在后两步复用。
			for (const writes of batches) {
				let documentActions: Map<DocumentId, DocumentAction>;
				// Only Durable's own checks refuse a batch, before it wrote anything: the ones before it stand. A failure of
				// the database rejects the call, and rolls back the batches before it with the transaction.
				calls.failed = false;
				// 每个 batch 先清空数据库失败标记；检查不写任何行。
				try {
					// prepareDocumentActions 只做批内结构校验（重复内容/退役），不改数据库。
					documentActions = this.prepareDocumentActions(writes);
					// checkBatch 依次做全局 id、文档动作和 copy 解析，全部只读。
					await this.checkBatch(checked, writes, documentActions);
				} catch (error) {
					// 数据库调用失败：整个事务回滚，reject 原错误（未知结果），不能当成普通拒绝。
					if (calls.failed) throw error;
					// Durable 自己的检查失败：记录拒绝并停止后续 batch；之前已写入的 batch 会在事务结束时提交。
					refused = { error };
					break;
				}
				// 本批通过检查：分配下一个 seq（next++ 先把当前值交给 seqFromNumber）。
				const seq = seqFromNumber(next++);
				// applyBatch 写表行和文档动作；任何一步抛错都会回滚事务。
				await this.applyBatch(transaction, writes, documentActions, seq);
				seqs.push(seq);
				// 显式 id 可能大于当前分配器；candidateNextId 取本批所有 id+1 的最大值。
				candidateNextId = Math.max(candidateNextId, this.candidateNextId(writes));
			}
			// 只有确实写入了 batch 才更新元数据；空数组调用不会推进 next_seq。
			// next_id 写入 max(原值, candidate)，避免显式大 id 回退分配器。
			if (seqs.length > 0) {
				await this.writeMetadata(transaction, Math.max(Number(metadata.next_id), candidateNextId), next);
			}
		});
		// 事务提交成功后把内存分配器抬到 candidateNextId；失败时不会执行到这里。
		this.nextId = Math.max(this.nextId, candidateNextId);
		// COMMIT 已返回：现在才发持久化回执，顺序与 batch 一致。
		// `COMMIT` returned: the stored batches are durable.
		// 有拒绝时仍返回已存储数量与拒绝原因；调用方据此决定是否重试/报告。
		for (const [index, seq] of seqs.entries()) receive(index, seq);
		return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
	}

	// 读取单行元数据；缺失视为存储损坏。
	private async readMetadata(executor: SqliteExecutor): Promise<MetadataRow> {
		const metadata = await executor.get<MetadataRow>(
			`SELECT next_id, next_seq FROM ${this.schema.tables.durableMetadata} WHERE singleton = 1`,
		);
		if (metadata === undefined) throw new Error("Durable SQLite metadata is missing");
		return metadata;
	}

	// 写回 next_id/next_seq；next_id 强制转字符串，与迁移中的 TEXT 列类型一致。
	private async writeMetadata(executor: SqliteExecutor, nextId: number, nextSeq: number): Promise<void> {
		await executor.run(
			`UPDATE ${this.schema.tables.durableMetadata} SET next_id = ?, next_seq = ? WHERE singleton = 1`,
			String(nextId),
			nextSeq,
		);
	}

	// 一个 batch 的全部只读检查：全局 id、文档动作、复制解析。
	/** Durable's own checks of one batch, copy resolution included, before it writes anything. */
	private async checkBatch(
		executor: SqliteExecutor,
		writes: readonly StorageWrite[],
		documentActions: Map<DocumentId, DocumentAction>,
	): Promise<void> {
		await this.checkGlobalIds(executor, writes);
		await this.checkDocumentActions(executor, documentActions);
		await this.resolveCopies(executor, documentActions);
	}

	// 一个 batch 的全部写入：先写普通表行，再写文档动作（内容/退役/创建）。
	private async applyBatch(
		executor: SqliteExecutor,
		writes: readonly StorageWrite[],
		documentActions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Promise<void> {
		for (const write of writes) await this.applyTableWrite(executor, write, seq);
		await this.applyDocumentActions(executor, documentActions, seq);
	}

	// 分配全局 id：先检查安全整数空间，再返回当前值并自增；不写库，持久化靠 commit 的元数据更新。
	// 注意：未提交的 mintId 在崩溃后可能被重新分配；Storage 契约依赖调用方只在提交中使用新 id。
	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return idFromNumber<I>(this.nextId++);
	}

	// 按 id 读取会话记录；不存在返回 undefined。
	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.conversations} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	// 扫描会话：id 方向由 scanStart 决定，可再按 owner_conversation_id/owner_task_id 过滤。
	// limit 是页大小；SQL 多取一条判断下一页。
	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		// scanStart 合并请求方向、游标方向与默认升序，并拒绝反转方向。
		const start = scanStart(query.order, cursor, "ascending");
		// clauses 与 params 平行构造：每追加一个条件就追加一个 ? 绑定值。
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: SqliteValue[] = [scan.param];
		if (query.ownerConversationId !== undefined) {
			clauses.push("owner_conversation_id = ?");
			params.push(query.ownerConversationId);
		}
		if (query.ownerTaskId !== undefined) {
			clauses.push("owner_task_id = ?");
			params.push(query.ownerTaskId);
		}
		// 多取 limit + 1 条；page() 会切片并根据是否超长生成 next。
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.conversations} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<ConversationRecord>(row.record)),
			limit,
			start.order,
		);
	}

	// entry 的两个重载：只给 entry id 查全局；给 conversation id 再验证 fork 链可见性。
	// 运行时实现按参数个数判断是哪个重载。
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		// 读取计数由 admitRead 管理：跨多条查询的读取要在 close 前完成。
		return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext, context));
	}

	// 在会话及 fork 祖先中查询最新 head 标记，可给出包含上界。
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	// 扫描会话的 fork-aware 历史；默认降序，游标决定继续方向。
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.admitRead(() => this.readEntries(query, limit, cursor));
	}

	// entry 读取的核心：解析重载参数，可选地沿 fork 链检查可见性。
	// context === undefined 表示三参重载；四参时 idOrContext 应是数字 id。
	private async readEntry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		// 三元表达式同时完成重载判定与数字转换；context 存在但 idOrContext 不是数字则为 undefined。
		const id =
			context === undefined
				? idFromNumber<EntryId>(idOrConversationId)
				: typeof idOrContext === "number"
					? idFromNumber<EntryId>(idOrContext)
					: undefined;
		// 缺少 entry id 是请求错误，而不是空结果。
		if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
		// 有 conversationId 时先读会话；未知会话是请求错误。
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			const conversationId = idFromNumber<ConversationId>(idOrConversationId);
			conversation = await this.readConversation(conversationId);
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		// 查询 entry 行，同时取持久化时的 commit_seq。
		const row = await this.db.get<EntryJsonRow>(
			`SELECT record, commit_seq FROM ${this.schema.tables.entries} WHERE id = ?`,
			id,
		);
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record);
		// 可见性检查：从请求会话沿 parent 上溯，直到 entry 所属会话。
		if (conversation !== undefined) {
			// upperEntryId 初始为无穷；每层 fork 收紧到父会话的 fork 点。
			let upperEntryId = Number.POSITIVE_INFINITY;
			// 当前会话不是 entry 所属会话时继续向祖先走。
			while (conversation.id !== entry.conversationId) {
				// 没有 parent 说明 entry 不属于这条链。
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = (await this.readConversation(conversation.parent.conversationId))!;
			}
			// entry id 超过 fork 点说明它在这条分支上不可见。
			if (entry.id > upperEntryId) return undefined;
		}
		// 返回 entry 与本行被写入时的 seq；seqFromNumber 只加品牌。
		return { entry, commitSeq: seqFromNumber(row.commit_seq) };
	}

	// 沿 fork 链找最新 head 标记；本段没有标记就上溯，并收紧 id 上界。
	private async readLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		// 先读会话；未知会话是请求错误。
		let conversation = await this.readConversation(conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		// upper 是本段允许的最大 id；undefined 表示无上界。
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			// 两条 SQL：无上界时直接取本段最新 head；有上界时加 id <= ?。
			// head IS NOT NULL 与迁移中的部分索引一致。
			const row =
				upper === undefined
					? await this.db.get<JsonRow>(
							`SELECT record FROM ${this.schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1`,
							conversation.id,
						)
					: await this.db.get<JsonRow>(
							`SELECT record FROM ${this.schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1`,
							conversation.id,
							upper,
						);
			// 找到就直接解析；head 行与 entry 在同一批写入，因此记录完整。
			if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
			// 本段没有则沿 parent 上溯；没有父会话表示整个链都没有。
			if (conversation.parent === undefined) return undefined;
			// 新的上界取原上界与父 fork 点的较小值，保证不会读到 fork 之后的内容。
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
	}

	// 降序读取 fork-aware 历史：从当前会话开始，逐段向祖先移动。
	// after 是游标位置：下一页从 after - 1 向下；minEntryId 是包含下界。
	private async readEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		// 游标继续创建时的方向；没有游标时默认降序。
		const { order, after } = scanStart(query.order, cursor, "descending");
		if (order === "ascending") return this.readEntriesAscending(query, limit, after);
		// 先定位会话；未知会话是请求错误。
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		// upper 是本轮最大 id；游标存在时进一步限制为 after - 1。
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		// values 累积记录；每段最多再取 limit + 1 - values.length 条。
		const values: EntryRecord[] = [];
		// 逐段查询，直到取够 limit+1 条或没有更多祖先。
		while (true) {
			// 当前段的 id 条件：conversation_id 加上可选的 min/max。
			const clauses = ["conversation_id = ?"];
			const params: SqliteValue[] = [conversation.id];
			if (query.minEntryId !== undefined) {
				clauses.push("id >= ?");
				params.push(query.minEntryId);
			}
			if (upper !== undefined) {
				clauses.push("id <= ?");
				params.push(upper);
			}
			// 多取一条用于判断下一页；ORDER BY id DESC 保证从新到旧。
			params.push(limit + 1 - values.length);
			const rows = await this.db.all<JsonRow>(
				`SELECT record FROM ${this.schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
				...params,
			);
			// 记录按查询顺序追加，保持全局降序。
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			// 已超过 limit 或没有父会话时停止；否则把上界移到父 fork 点。
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			// 下界已越过父 fork 点时，祖先段不会有符合范围的记录。
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		// 用最后一条返回项生成游标；方向固定为 descending。
		return page(values, limit, "descending");
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	// 升序读取 fork-aware 历史：先收集从根到当前会话的各段，再反向逐段查询。
	// 这样结果按全局 id 从小到大，跨 fork 边界也不会乱序。
	private async readEntriesAscending(
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		// segments 保存每段会话及其上界；reverse 后即从最老祖先到当前会话。
		const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
		// 先读请求会话；未知会话是请求错误。
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		// upper 是当前段允许的最大 id；初始来自查询的 maxEntryId。
		let upper: number | undefined = query.maxEntryId;
		// 沿 parent 上溯构建段列表，每层收紧上界。
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		let lower: number | undefined = query.minEntryId;
		// 游标 after 要求下界至少为 after+1；与查询的 minEntryId 取较大者。
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		const values: EntryRecord[] = [];
		// 从根段开始查询；每段最多补齐到 limit+1 条。
		for (const segment of segments.reverse()) {
			// 当前段的 id 条件：conversation_id 加可选下界/上界。
			const clauses = ["conversation_id = ?"];
			const params: SqliteValue[] = [segment.conversationId];
			if (lower !== undefined) {
				clauses.push("id >= ?");
				params.push(lower);
			}
			if (segment.upper !== undefined) {
				clauses.push("id <= ?");
				params.push(segment.upper);
			}
			params.push(limit + 1 - values.length);
			// 多取一条判断下一页；ORDER BY id ASC 保证段内升序。
			const rows = await this.db.all<JsonRow>(
				`SELECT record FROM ${this.schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`,
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			// 已超过 limit 就可以停止，后面的段只会更大。
			if (values.length > limit) break;
		}
		return page(values, limit, "ascending");
	}

	// 按 id 读取任务最新记录；不存在返回 undefined。
	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.tasks} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<StoredTask>(row.record);
	}

	// 扫描任务：所有给出的过滤条件 AND 组合，按 id 排序分页。
	// kind 用无损编码比较；boolean 列用 1/0。
	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		// scanStart 处理游标方向；默认升序。
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: SqliteValue[] = [scan.param];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		// kind 列写入时经过 encodeIndexedString，查询必须用同样编码。
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(encodeIndexedString(query.kind));
		}
		if (query.status !== undefined) {
			clauses.push("status = ?");
			params.push(query.status);
		}
		if (query.abortRequested !== undefined) {
			clauses.push("abort_requested = ?");
			params.push(query.abortRequested ? 1 : 0);
		}
		if (query.background !== undefined) {
			clauses.push("background = ?");
			params.push(query.background ? 1 : 0);
		}
		// 多取一条；page 负责切片与游标。
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.tasks} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<StoredTask>(row.record)),
			limit,
			start.order,
		);
	}

	// 按 id 读取 submission；不存在返回 undefined。
	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.submissions} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	// 扫描 submission：会话和状态条件可选，按 id 排序分页。
	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		const scan = scanSql(start);
		const clauses = [scan.clause];
		const params: SqliteValue[] = [scan.param];
		if (query.conversationId !== undefined) {
			clauses.push("conversation_id = ?");
			params.push(query.conversationId);
		}
		if (query.status !== undefined) {
			clauses.push("status = ?");
			params.push(query.status);
		}
		// 多取一条判断下一页。
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.submissions} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<SubmissionRecord>(row.record)),
			limit,
			start.order,
		);
	}

	// 按“会话 + requestId”查重；requestId 列是 JSON 编码后的文本。
	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(
			`SELECT record FROM ${this.schema.tables.submissions} WHERE conversation_id = ? AND request_id = ?`,
			conversationId,
			encodeIndexedString(requestId),
		);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	// 在某个时间点解析地址上的存活 incarnation；current 用 retired_at IS NULL。
	// 历史点用 created_at <= at 且（未退役或 retired_at > at），按创建时间倒序取最新。
	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		// 地址列先编码；at === "current" 与历史点的 SQL/参数不同。
		const parts = addressParts(address);
		const sql =
			at === "current"
				? `SELECT record FROM ${this.schema.tables.documents}
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
				: `SELECT record FROM ${this.schema.tables.documents}
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`;
		// 前五个参数来自地址；历史点再绑定两次 at（created_at 上界与 retired_at 下界）。
		const params: SqliteValue[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
		if (at !== "current") params.push(at, at);
		const row = await this.db.get<JsonRow>(sql, ...params);
		return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
	}

	// 按文档 id 物化内容；记录与修订必须在同一已提交状态读取。
	// 使用 transaction 而不是多条独立查询，避免两次查询之间 base 被替换。
	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		// The record and revision queries must observe one committed state; a commit between them can replace the base.
		return this.db.transaction((transaction) => this.materializeDocument(transaction, id, at));
	}

	// 扫描某作用域在某个时间点存活的文档，按 id 升序分页。
	// 游标只有 after；kind 可选过滤；at 决定 retired/created 条件。
	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		// 作用域列展开；游标缺省从 -1 开始，包含所有正 id。
		const scope = scopeColumns(query.scope);
		const clauses = ["scope_kind = ?", "owner_id = ?", "id > ?"];
		const params: SqliteValue[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
		if (query.kind !== undefined) {
			clauses.push("kind = ?");
			params.push(encodeIndexedString(query.kind));
		}
		// current 只看未退役；历史点要求生存期覆盖 at。
		if (query.at === "current") {
			clauses.push("retired_at IS NULL");
		} else {
			clauses.push("created_at <= ?", "(retired_at IS NULL OR retired_at > ?)");
			params.push(query.at, query.at);
		}
		// 多取一条判断下一页；page 默认按升序生成游标。
		params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM ${this.schema.tables.documents} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
			...params,
		);
		return page(
			rows.map((row) => parseJson<DocumentRecord>(row.record)),
			limit,
		);
	}

	// 关闭存储：首次调用设置 closed、缓存 closing Promise 并开始关闭数据库；重复调用返回同一 Promise。
	// 正在进行的多查询读取会先完成，数据库随后关闭。
	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.closeDatabase();
		}
		return this.closing;
	}

	// 等待 admittedReads 归零；drained 在 admitRead 的 finally 中调用。
	private async closeDatabase(): Promise<void> {
		if (this.admittedReads > 0) {
			await new Promise<void>((resolve) => {
				this.readsDrained = resolve;
			});
		}
		await this.db.close();
	}

	// 跨多条查询的读取登记：close 会等待它们，避免后续查询命中关闭的连接。
	// 单条查询和事务由数据库自身的关闭顺序保证，不需要登记。
	// 例：readEntries 一次可能查多段会话；期间 close 必须等它跑完。
	/**
	 * Run a read that issues several queries. Close waits for admitted reads, so their later queries never reach a
	 * closed database. Single-query reads and transactions are already ordered before close by the database.
	 */
	private async admitRead<T>(read: () => Promise<T>): Promise<T> {
		this.assertOpen();
		this.admittedReads++;
		try {
			return await read();
		} finally {
			if (--this.admittedReads === 0) this.readsDrained?.();
		}
	}

	// 内部会话读取，复用 SQL 与解析逻辑；调用者负责请求级错误。
	private async readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		const row = await this.db.get<JsonRow>(`SELECT record FROM ${this.schema.tables.conversations} WHERE id = ?`, id);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	// 物化文档：读记录 -> 历史/生存期判断 -> 最近 base -> 其后的 delta 依次 apply。
	// 返回记录的当前版本（base 的版本）和 delta 数量；缺失 base 或跨版本 delta 视为存储损坏。
	private async materializeDocument(
		executor: SqliteExecutor,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		// 按 id 读记录；不存在返回 undefined。
		const row = await executor.get<JsonRow>(`SELECT record FROM ${this.schema.tables.documents} WHERE id = ?`, id);
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record);
		// 请求历史点但记录只保留 latest：请求错误。
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		// 记录在请求点不存活：返回 undefined（不是错误）。
		if (!isAliveAt(record, at)) return undefined;
		// current 用最大安全整数作为修订上界；历史点用 at。
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		// 找 <= upper 的最近 base；若没有 base，说明历史保留不完整，属于存储损坏。
		const base = await executor.get<RevisionRow>(
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
			id,
			upper,
		);
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		// base.content 是完整 JSON 对象；后续 delta 依次 apply。
		let value = parseJson<JsonObject>(base.content);
		// 读取 base 之后到 upper 之间的全部修订，按 seq 升序。
		const tail = await executor.all<RevisionRow>(
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
			id,
			base.seq,
			upper,
		);
		// 若 base 与后续 delta 之间没有新的 base，delta 必须与 base 同版本；否则说明缺少版本边界 base。
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			// apply 返回 JsonValue；这里断言回 JsonObject，因为 Durable 文档根始终是对象。
			value = apply(value, parseJson<readonly Op[]>(revision.content)) as JsonObject;
		}
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	// 根据写入中的显式 id 计算候选 nextId：取当前值与每个 id+1 的最大值。
	// 只读取 id，不修改状态；commit 结束时用它更新元数据。
	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	// 全局 id 检查：conversation/entry/document 必须全新且批内不重复；
	// task/submission 允许同一 id 更新，但不得与其他类型冲突。
	private async checkGlobalIds(executor: SqliteExecutor, writes: readonly StorageWrite[]): Promise<void> {
		const claimed = new Map<Id<string>, TableName>();
		// claimed 记录批内已声明 id -> 类型，检测同一批的重复写入。
		for (const write of writes) {
			// change/retire 不声明新 id，跳过。
			if (write.type === "document.change" || write.type === "document.retire") continue;
			// 文档创建/复制归为 document 类型；表写入直接使用 write.type。
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			// 先查 record_ids 看该 id 是否已被持久化占用。
			const existing = (
				await executor.get<RecordIdRow>(`SELECT record_type FROM ${this.schema.tables.recordIds} WHERE id = ?`, id)
			)?.record_type;
			const earlier = claimed.get(id);
			// 三类不可复用 id：已存在或批内重复都拒绝。
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				// 任务/提交 id 可以复用同类型记录，但不能跨类型。
				if (existing !== undefined && existing !== table)
					throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	// 把批内的文档写入合并成每个文档一个 action；同时做批内结构检查。
	// 它只构造 Map，不访问数据库；数据库检查在 checkDocumentActions。
	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			) {
				continue;
			}
			// 从 create/copy 的记录或 change/retire 的 id 得到文档 id。
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				// 创建：记录与 base 内容一起暂存；重复内容命令直接拒绝。
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				// 复制：记录与源一起暂存；源的 base 在提交时解析。
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				// 变更：只允许一个内容命令；change 不能同时携带 copy。
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				// 退役：布尔标记，重复退役是批内矛盾。
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	// 文档动作的数据库检查：未知/已退役、重复创建、delta 版本、copy 源、地址唯一性。
	private async checkDocumentActions(
		executor: SqliteExecutor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<void> {
		// liveCounts 按地址键统计提交后仍存活的 incarnation 数。
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			// copy 源若也在本批被修改，复制语义不确定，直接拒绝。
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			// 读取现有文档记录（如有）。
			const row = await executor.get<JsonRow>(`SELECT record FROM ${this.schema.tables.documents} WHERE id = ?`, id);
			const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
			// change/retire 必须有现有记录；create 不能与现有 id 冲突。
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			// 已退役的文档不能再修改。
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			// delta 必须基于当前 base 的版本；同一版本由引擎的修订计数进一步保证。
			if (action.content?.kind === "delta") {
				const previous = await executor.get<{ readonly version: number }>(
					`SELECT version FROM ${this.schema.tables.documentRevisions} WHERE document_id = ? ORDER BY seq DESC LIMIT 1`,
					id,
				);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			// 用创建记录或现有记录构造地址键。
			const record = action.create ?? existing!;
			const key = addressKey(record);
			// 首次遇到该地址时查当前存活文档；存在则计数从 1 开始。
			let live = liveCounts.get(key);
			if (live === undefined) live = (await this.currentDocumentId(executor, record)) === undefined ? 0 : 1;
			// 本批退役现有记录会释放一个存活槽。
			if (action.retire && existing !== undefined) live--;
			// 新建且不立即退役会占用一个存活槽。
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		// 提交后同一地址最多一个存活 incarnation。
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	// 查询地址当前（未退役）的 incarnation id，用于唯一性检查。
	private async currentDocumentId(
		executor: SqliteExecutor,
		address: DocumentAddress | DocumentCreate | DocumentRecord,
	): Promise<DocumentId | undefined> {
		const parts = addressParts(address);
		const id = (
			await executor.get<IdRow>(
				`SELECT id FROM ${this.schema.tables.documents}
				WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
				LIMIT 1`,
				parts.kind,
				parts.scopeKind,
				parts.ownerId,
				parts.family,
				parts.keyValue,
			)
		)?.id;
		return id === undefined ? undefined : idFromNumber<DocumentId>(id);
	}

	// 写一条表记录：先 claim 全局 id，再 INSERT（任务/提交使用 upsert 更新同 id 记录）。
	// entry 的 commit_seq 来自本批 seq，而不是记录中的占位值。
	private async applyTableWrite(executor: SqliteExecutor, write: StorageWrite, seq: Seq): Promise<void> {
		switch (write.type) {
			// conversation 使用普通 INSERT；owner 缺失写 NULL，让索引忽略它。
			case "conversation":
				await this.claimId(executor, write.value.id, "conversation");
				await executor.run(
					`INSERT INTO ${this.schema.tables.conversations} (id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?)`,
					write.value.id,
					write.value.owner?.conversationId ?? null,
					write.value.owner?.taskId ?? null,
					encodeJson(write.value),
				);
				break;
			// entry 写入 commit_seq=seq；head 缺失写 NULL。
			case "entry":
				await this.claimId(executor, write.value.id, "entry");
				await executor.run(
					`INSERT INTO ${this.schema.tables.entries} (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)`,
					write.value.id,
					write.value.conversationId,
					write.value.head ?? null,
					seq,
					encodeJson(write.value),
				);
				break;
			// 任务是可更新记录：ON CONFLICT(id) 覆盖所有索引列与完整 record。
			case "task":
				await this.claimId(executor, write.value.id, "task");
				await executor.run(
					`INSERT INTO ${this.schema.tables.tasks} (id, conversation_id, kind, status, abort_requested, background, record)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, record = excluded.record`,
					write.value.id,
					write.value.conversationId,
					encodeIndexedString(write.value.kind),
					write.value.state.status,
					write.value.abortRequested ? 1 : 0,
					write.value.background ? 1 : 0,
					encodeJson(write.value),
				);
				break;
			// submission 同样 upsert；request_id 缺失写 NULL，存在则 JSON 编码。
			case "submission":
				await this.claimId(executor, write.value.id, "submission");
				await executor.run(
					`INSERT INTO ${this.schema.tables.submissions} (id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
					write.value.id,
					write.value.conversationId,
					write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
					write.value.status,
					encodeJson(write.value),
				);
				break;
			// 文档写入由 applyDocumentActions 统一处理，这里不重复。
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	// 登记全局 id 的类型；INSERT OR IGNORE 让同一批对同一 id 的重复 claim 保持幂等。
	private async claimId(executor: SqliteExecutor, id: Id<string>, table: TableName): Promise<void> {
		await executor.run(
			`INSERT OR IGNORE INTO ${this.schema.tables.recordIds} (id, record_type) VALUES (?, ?)`,
			id,
			table,
		);
	}

	// copy 解析：源必须在同一事务/批中读取，且本批不能修改源；源的值成为目标 base。
	// 目标与源必须在 scope/kind/key/history/fork 上匹配，否则拒绝。
	/** Resolve each copy to a base of its source's state before this batch, which may not change the source. */
	private async resolveCopies(executor: SqliteExecutor, actions: Map<DocumentId, DocumentAction>): Promise<void> {
		for (const [id, action] of actions) {
			if (action.copy === undefined) continue;
			// materializeDocument 在同一 executor 上读源文档；undefined 表示源不存在。
			try {
				const stored = await this.materializeDocument(executor, action.copy.id, action.copy.at);
				if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
				// 目标必须也是 conversation 作用域，才可能复制历史语义。
				const create = action.create!;
				if (
					stored.record.scope.kind !== "conversation" ||
					create.scope.kind !== "conversation" ||
					stored.record.kind !== create.kind ||
					stored.record.key !== create.key ||
					stored.record.history !== create.history ||
					stored.record.fork !== create.fork
				) {
					throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
				}
				// 把源的值作为 base 内容，版本沿用源版本；后续写入从该 base 开始。
				action.content = { kind: "base", version: stored.version, value: stored.value };
				// 统一包装错误，保留 cause 以区分源读取、不匹配或请求错误。
			} catch (error) {
				throw new Error(`Document copy ${id} was rejected`, { cause: error });
			}
		}
	}

	// 应用文档动作：创建/普通变更先写记录，再写修订；base 对 latest 文档会清空旧修订；退役按历史策略处理。
	private async applyDocumentActions(
		executor: SqliteExecutor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Promise<void> {
		// copy 已在 resolveCopies 中转成 base 内容，这里只使用 action.content。
		for (const [id, action] of actions) {
			// Copies are resolved to their content by `resolveCopies()`.
			const content = action.content;
			// record 最终用于判断历史策略；创建时先算 createdAt/retiredAt，修改时读取现有行。
			let record: DocumentRecord;
			if (action.create !== undefined) {
				// 创建记录：createdAt 固定为本批 seq；立即退役则 retiredAt 同 seq（空生存期）。
				record = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				const parts = addressParts(record);
				// 先 claim document 类型 id，再插入 documents 行；地址列从记录编码得到。
				await this.claimId(executor, id, "document");
				await executor.run(
					`INSERT INTO ${this.schema.tables.documents}
						(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					id,
					parts.kind,
					parts.family,
					parts.keyValue,
					parts.scopeKind,
					parts.ownerId,
					seq,
					action.retire ? seq : null,
					encodeJson(record),
				);
				// 已有文档：读取当前记录，后续只更新修订或 retired_at。
			} else {
				const row = (await executor.get<JsonRow>(
					`SELECT record FROM ${this.schema.tables.documents} WHERE id = ?`,
					id,
				))!;
				record = parseJson<DocumentRecord>(row.record);
			}

			// 写内容修订；base 对 latest 文档先删除旧修订，保持“只留当前状态”。
			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					await executor.run(`DELETE FROM ${this.schema.tables.documentRevisions} WHERE document_id = ?`, id);
				}
				// base 存 value，delta 存 ops；两者都序列化成 JSON 文本。
				const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				await executor.run(
					`INSERT INTO ${this.schema.tables.documentRevisions} (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)`,
					id,
					seq,
					content.kind,
					content.version,
					encodedContent,
				);
			}

			// 退役：创建时已写 retiredAt，无需更新；已有文档需更新记录并写 retired_at。
			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					await executor.run(
						`UPDATE ${this.schema.tables.documents} SET retired_at = ?, record = ? WHERE id = ?`,
						seq,
						encodeJson(record),
						id,
					);
				}
				// latest/none 文档退役后删除修订；rewindable 保留全部历史。
				if (isCurrentOnly(record)) {
					await executor.run(`DELETE FROM ${this.schema.tables.documentRevisions} WHERE document_id = ?`, id);
				}
			}
		}
	}

	// 关闭检查：所有公开方法在开始处调用；close 本身不调用，以便重复关闭幂等。
	private assertOpen(): void {
		if (this.closed) throw new Error("SqliteStorage is closed");
	}
}
