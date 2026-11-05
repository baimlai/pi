// The documents engine (S13, slice 6a §8, slice 6b §1.5): one record per incarnation of an address, revisions made of
// bases and deltas, a history rule per record (R1); its writes inside the commit step, checked by the writes
// themselves (the partial unique index on the live address, the counted conditional `UPDATE` on the record's
// revision), and its reads, of the current state or at a point.

// 文件导读
// 所属：packages/chord/src/store（store 层，documents 引擎）。
// 职责边界：定义文档地址/记录/修订的类型与 SQL；把 create/change/retire 包装成 StagedWrite；不做事务提交、排队或错误映射（由 step/store 负责）。
// 上游：store 的文档句柄、import 的 applier、batch 回放调用这些函数。下游：Step 执行 SQL，delta.apply 应用增量，schema 提供表名。
// 结果与错误流向：写函数在 apply 中返回 DocumentWrite 供 outbox/归档；内存与磁盘状态不一致时 throw Error（内部错误，事务回滚）。
// 能力清单：
// - DocumentAddress/DocumentHistory/DocumentRecord：地址、历史规则与存储记录；
// - DocumentBase/DocumentContent/RevisionContent/DocumentRevision：值与修订内容；
// - DocumentWrite/StoredDocument/DocumentPoint：写入记录、加载结果与读取点；
// - createDocument/changeDocument/retireDocument：生成 StagedWrite 的三个入口；
// - insertDocument/writeContent/retireRecord/retireDocument/insertRevision/dropRetired：步骤内 SQL；
// - readDocument/findDocument/loadDocument/listDocumentKeys/listDocuments/listRecords/listRevisions：读取；
// - readDocumentEntry/findDocumentEntry/listDocumentEntries：只读 meta 的适配器视图；
// - recordOf：行到记录的字段映射。
// 组合顺序：构造 StagedWrite -> Step 提交时 apply -> insertDocument/writeContent/retireRecord -> 提交后 readDocument/findDocument -> loadDocument 应用 base+deltas。
// 示例：const staged = createDocument(address, base, text, (id) => { adopted = id; }); 它在步骤中 mint id、插入记录并返回一个 document.create 写入。
// 建议阅读顺序：地址/历史/记录类型 -> 内容类型 -> createDocument/changeDocument/retireDocument -> insertDocument/writeContent/retireRecord -> loadContent 的 base+delta 读取 -> 其余查询与 entry 视图 -> recordOf。
import { apply, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteExecutor } from "../sqlite/index.ts";
import { TABLES } from "./schema.ts";
import type { StagedWrite, Step } from "./step.ts";

/**
 * A document's address: the owner name, the adapter's namespace (claimed with the owner: Chord's `chord`, `chord.jobs`,
 * `chord.job-states`; Durable's scopes), the kind and, for a keyed document, its key; a singleton has none. The column
 * keeps `""` for it, which a keyed document's empty key shares (its definition says which it is).
 */
// 文档地址的四个维度；key 缺席表示单例文档。
export type DocumentAddress = {
	// 拥有者（通常是插件/应用名）；同一 owner 下 namespace 隔离。
	readonly owner: string;
	// 适配器命名空间；同一 SQL 表里多个适配器互不干扰。
	readonly namespace: string;
	// 文档种类，由定义决定。
	readonly kind: string;
	// 有键文档的业务键；单例文档不填，SQL 列存空串。
	readonly key?: string;
};

/**
 * What a record keeps (R1), applied at a new base and at retirement: `none` (Chord) drops older revisions at a new base
 * and the row and its revisions at retirement; `latest` drops older revisions at a new base and its revisions at
 * retirement, keeping the row; `rewindable` keeps everything.
 */
// R1 历史规则：none 删除行与修订，latest 保留行删修订，rewindable 全保留。
export type DocumentHistory = "none" | "latest" | "rewindable";

/** A stored record: one incarnation of an address, live from `createdAt` until `retiredAt` (half-open). */
// 一条存储记录 = 地址 + 一次存活期（createdAt 到 retiredAt，半开）。
export type DocumentRecord = DocumentAddress & {
	// 全局文档 id，由 IdAllocator 分配。
	readonly id: number;
	// 该记录采用的历史规则。
	readonly history: DocumentHistory;
	/** The seq that created it. */
	// 创建它的 seq。
	readonly createdAt: number;
	/** The seq that retired it, once retired. */
	// 退役它的 seq；未退役时不存在。
	readonly retiredAt?: number;
	/** The adapter's details (Durable: its fork policy and history). */
	// 适配器自用的序列化细节（Durable 的 fork 策略/历史）。
	readonly meta?: string;
	/** Counts its changes: a change names the revision it was prepared on. */
	// 变更计数；每个 change 必须带上它准备时的 revision。
	readonly revision: number;
	/** The version and schema fingerprint of its current base. */
	// 当前 base 的版本号。
	readonly version: number;
	// 当前 base 的 schema 指纹。
	readonly fingerprint: string;
};

/** A base: a whole value at a version. */
// 一个完整值：版本、指纹与 JSON 值；新文档与整体替换都用它。
export type DocumentBase = { readonly version: number; readonly fingerprint: string; readonly value: JsonValue };

/** A change's content: a new base, or a delta on the current base's version. */
// 一次变更的内容：新 base，或基于当前版本的 delta。
export type DocumentContent =
	// base 携带完整值，提交后旧修订可能被丢弃。
	| ({ readonly kind: "base" } & DocumentBase)
	// delta 必须声明它基于的版本；ops 在读取时应用。
	| { readonly kind: "delta"; readonly version: number; readonly ops: readonly Op[] };

/** A stored revision's content: a base's value or a delta's ops, at a version (a revision keeps no fingerprint). */
// 存储修订的内容：base 的值或 delta 的 ops，不带指纹。
export type RevisionContent =
	// 修订里的 base 只记录版本与值。
	| { readonly kind: "base"; readonly version: number; readonly value: JsonValue }
	// 修订里的 delta 记录目标版本与操作。
	| { readonly kind: "delta"; readonly version: number; readonly ops: readonly Op[] };

/** One stored revision as archives carry it: its document, its seq, its content. */
// 归档形状的修订：属于哪个文档、哪个 seq、什么内容。
export type DocumentRevision = { readonly id: number; readonly seq: number; readonly content: RevisionContent };

/**
 * The engine's writes as the outbox and archives record them. A creation carries its base in a commit (stored at
 * `createdAt`); in an archive it has none and its `document.revision`s follow it.
 */
// 引擎写入的可记录形式；outbox 与归档按 kind 序列化。
export type DocumentWrite =
	// create：提交时带 base；归档里的 create 不带 base，修订紧随其后。
	| { readonly kind: "document.create"; readonly record: DocumentRecord; readonly base?: DocumentBase }
	// change：记录 id、准备时的 revision 与内容。
	| {
			readonly kind: "document.change";
			readonly id: number;
			readonly revision: number;
			readonly content: DocumentContent;
	  }
	// retire：记录 id 与准备时的 revision。
	| { readonly kind: "document.retire"; readonly id: number; readonly revision: number }
	// 归档专用：一条已存储的修订。
	| ({ readonly kind: "document.revision" } & DocumentRevision);

/** A loaded document: its record and its value (a base plus deltas applied once) at a point. */
// 加载后的文档：记录、按 base+deltas 计算的值及其版本信息。
export type StoredDocument = {
	// 记录本身：地址、历史规则、revision 与版本信息。
	readonly record: DocumentRecord;
	// 当前（或指定点）的 JSON 值。
	readonly value: JsonValue;
	/** The version of the base the value was built from. */
	// 值的版本来自其 base（delta 不改变版本）。
	readonly version: number;
	/** The deltas applied after its base (what `checkpointWhen` sees). */
	// 自 base 之后应用的 delta 数，供 checkpointWhen 判断。
	readonly deltasSinceBase: number;
};

/** Where a read looks: the current state, or the state after a seq. */
// 读取点：当前状态，或某个 seq 之后的状态。
export type DocumentPoint = number | "current";

/**
 * Stages the creation of a Chord document at `address` with `base`; its id is taken from the allocator when it
 * applies (a saturated allocator refuses the commit) and handed to `created` (its owner adopts it after `COMMIT`).
 * `text` is the base's value serialized before the queue (rule 8).
 */
// 暂存一个 Chord 文档的创建：apply 时 mint id、插记录与其 base，并返回 document.create 写入。
// 输入地址、base、已序列化的 text 与可选的 id 回调；输出 StagedWrite；分配器饱和时在 apply 中拒绝。
// 示例：createDocument(address, { version: 1, fingerprint: "f", value: {} }, "{}") 在提交后得到一条记录与一条 base 修订。
export function createDocument(
	address: DocumentAddress,
	base: DocumentBase,
	text: string,
	created?: (id: number) => void,
): StagedWrite {
	return {
		// order 决定该写入在提交步骤中的相对顺序。
		order: "create",
		// Step 在事务内调用；这里可以用 step.seq 与分配器。
		apply: async (step) => {
			// id 在提交时才分配，避免事务外泄漏分配器状态。
			const id = step.ids.mint();
			// 登记新建 id，提交后交给拥有者。
			step.created.push(id);
			// 可选回调让调用者在 COMMIT 后立即拿到 id（此时仍不能读）。
			created?.(id);
			// 记录与写入共用 base 的版本信息。
			const { version, fingerprint } = base;
			// Chord 文档固定 history = none；revision 从 1 开始。
			const record: DocumentRecord = {
				id,
				...address,
				// Chord 不需要历史，退役即删除。
				history: "none",
				// 存活期从当前提交 seq 开始。
				createdAt: step.seq,
				revision: 1,
				version,
				fingerprint,
			};
			// 写 documents 行，并把 text 作为 createdAt 的 base 修订。
			await insertDocument(step, record, text);
			// 提交时 outbox 记录带 base；归档导出会拆成 create + revision。
			return [{ kind: "document.create", record, base }];
		},
	};
}

/**
 * Inserts `record` as it is (id, seqs and revision kept: a creation, an import, a batch), with its base at `createdAt`
 * when `text` (the base's value serialized) is given; a record created retired (an empty lifetime) keeps what its
 * history keeps.
 */
// 原样插入一条记录（创建/导入/批处理），可选附带 base；createdAt 已退役的记录按历史规则立即清理。
// 输入 step、记录与已序列化的 base text；text 为 undefined 时只有记录（归档中的 create）。
export async function insertDocument(step: Step, record: DocumentRecord, text: string | undefined): Promise<void> {
	// 解构只为把可选字段转换成 SQL 的 NULL/空串。
	const { id, namespace, owner, kind, key, history, createdAt, retiredAt, meta, revision, version, fingerprint } =
		record;
	// 所有列都显式列出，物理列变化时这里会显式失败。
	await step.run(
		`INSERT INTO ${TABLES.documents}
			(id, owner, namespace, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		owner,
		namespace,
		kind,
		// 单例文档的 key 列存空串，与有键文档的空键共享；由定义区分。
		key ?? "",
		history,
		createdAt,
		// undefined 转为 SQL NULL。
		retiredAt ?? null,
		meta ?? null,
		revision,
		version,
		fingerprint,
	);
	// 创建时的 base 修订使用 createdAt 作为 seq。
	if (text !== undefined) await insertRevision(step, id, createdAt, "base", version, text);
	// 生来已退役（空存活期）的记录按规则立即清理。
	if (retiredAt !== undefined) await dropRetired(step, id, history);
}

/**
 * Stages a change of Chord document `id` prepared on `revision`: a delta on the current base's version, or a new base.
 * `text` is the content serialized before the queue.
 */
// 暂存 Chord 文档的变更：apply 时在同一 seq 写修订并条件更新记录。
// 输入 id、准备时的 revision、内容与已序列化 text；输出 StagedWrite；记录不在该 revision 存活时抛错。
export function changeDocument(id: number, revision: number, content: DocumentContent, text: string): StagedWrite {
	// outbox 记录与实际写入使用同一对象。
	const write: DocumentWrite = { kind: "document.change", id, revision, content };
	return {
		// 变更属于普通写入组。
		order: "write",
		apply: async (step) => {
			// Chord 固定 none 历史。
			await writeContent(step, id, "none", revision, content, text);
			return [write];
		},
	};
}

/**
 * Writes `content` to document `id` (of `history`) prepared on `revision`, in the step's seq: its revision, the
 * counted conditional `UPDATE` (a delta only on the base's version), and at a new base the older revisions a
 * `none` or `latest` record drops. A record that is not live at `revision` throws (memory and disk disagree).
 */
// 在当前 seq 写入一次内容：先插修订，再用计数条件 UPDATE 推进 revision；base 变更时按历史规则删旧修订。
// 输入 step/id/history/revision/content/text；changed !== 1 说明内存与磁盘不一致，抛错让事务回滚。
// 示例：delta 的 UPDATE 同时要求 version 匹配，避免基于旧 base 的增量写到新 base 上。
export async function writeContent(
	step: Step,
	id: number,
	history: DocumentHistory,
	revision: number,
	content: DocumentContent,
	text: string,
): Promise<void> {
	// As ids: a revision past the safe range would stop counting exactly.
	// revision 用安全整数计数，越界就无法精确比较。
	if (revision >= Number.MAX_SAFE_INTEGER) throw new Error(`document ${id}: no revision past the safe range`);
	// 修订 seq 就是本次提交的 seq。
	await insertRevision(step, id, step.seq, content.kind, content.version, text);
	// 用受影响的计数区分“记录不存在/已退役/revision 不符”；delta 分支还要求 version 匹配，base 分支覆盖 version/fingerprint。
	const changed =
		// delta 额外要求记录的当前 version 与增量声明的 version 一致。
		content.kind === "delta"
			? await step.runCounted(
					`UPDATE ${TABLES.documents} SET revision = revision + 1
						WHERE id = ? AND revision = ? AND version = ? AND retired_at IS NULL`,
					id,
					revision,
					content.version,
				)
			: await step.runCounted(
					`UPDATE ${TABLES.documents} SET revision = revision + 1, version = ?, fingerprint = ?
						WHERE id = ? AND revision = ? AND retired_at IS NULL`,
					content.version,
					content.fingerprint,
					id,
					revision,
				);
	// 内部不变量被破坏：调用方应在事务内看到冲突破败。
	if (changed !== 1) throw new Error(`document ${id}: not live at revision ${revision}`);
	// 新 base 之后旧修订不再需要，none/latest 丢弃。
	if (content.kind === "base" && history !== "rewindable") {
		// 保留当前 base 自身（seq = step.seq）。
		await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ? AND seq < ?`, id, step.seq);
	}
}

/** Stages the retirement of Chord document `id` (history `none`) at `revision`: its row and its revisions go. */
// 暂存 Chord 文档退役：计数条件删除记录行，再删全部修订。
// 输入 id 与准备时 revision；输出 StagedWrite；revision 不符时抛错回滚。
export function retireDocument(id: number, revision: number): StagedWrite {
	const write: DocumentWrite = { kind: "document.retire", id, revision };
	return {
		// 退役排在普通写入之后。
		order: "retire",
		apply: async (step) => {
			// A Chord document keeps no history (`none`): its row goes with a conditional, counted DELETE (6a's).
			// 只有仍存活且 revision 未变才删除；计数删除同时完成乐观并发检查。
			const deleted = await step.runCounted(
				`DELETE FROM ${TABLES.documents} WHERE id = ? AND revision = ? AND retired_at IS NULL`,
				id,
				revision,
			);
			// 删除不到一行即状态不一致。
			if (deleted !== 1) throw new Error(`document ${id}: not live at revision ${revision}`);
			// none 历史不保留任何修订。
			await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ?`, id);
			return [write];
		},
	};
}

/**
 * Retires live `record` in the step's seq by its history (R1): a `none` record's row and revisions go, a `latest` one
 * keeps its row with `retired_at` and drops its revisions, a `rewindable` one keeps everything.
 */
// 按记录自身历史规则退役：none 删行，latest 记 retired_at，rewindable 只保留原样。
export async function retireRecord(step: Step, record: DocumentRecord): Promise<void> {
	const { id, history } = record;
	// latest/rewindable 保留行并写退役 seq。
	if (history !== "none") await step.run(`UPDATE ${TABLES.documents} SET retired_at = ? WHERE id = ?`, step.seq, id);
	// 统一处理修订（可能还有 none 的行）。
	await dropRetired(step, id, history);
}

/** What a retired record of `history` drops: a `none` row too, every revision unless `rewindable`. */
// 退役后的清理：rewindable 无操作；none 再删行；其余删所有修订。
async function dropRetired(step: Step, id: number, history: DocumentHistory): Promise<void> {
	// 可回退历史必须保留全部修订。
	if (history === "rewindable") return;
	// none 连记录行一起删除。
	if (history === "none") await step.run(`DELETE FROM ${TABLES.documents} WHERE id = ?`, id);
	// latest 与 none 都丢弃修订。
	await step.run(`DELETE FROM ${TABLES.revisions} WHERE document_id = ?`, id);
}

/** Inserts one revision of document `id` at `seq`, `text` its serialized content. */
// 插入一条修订：document_id/seq 定位，kind 与 version 描述内容，content 是已序列化 JSON。
export function insertRevision(
	step: Step,
	id: number,
	seq: number,
	kind: "base" | "delta",
	version: number,
	text: string,
): Promise<void> {
	// (document_id, seq) 是主键：同一文档同一 seq 只允许一条修订。
	return step.run(
		`INSERT INTO ${TABLES.revisions} (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)`,
		id,
		seq,
		kind,
		version,
		text,
	);
}

// documents 表的行形状：SQL 列名到下划线字段的映射。
type RecordRow = {
	readonly id: number;
	readonly owner: string;
	readonly namespace: string;
	readonly kind: string;
	readonly key: string;
	readonly history: DocumentHistory;
	// SQL 列 created_at 对应记录的 createdAt。
	readonly created_at: number;
	// SQL NULL 表示未退役。
	readonly retired_at: number | null;
	// 未设置时为 NULL。
	readonly meta: string | null;
	readonly revision: number;
	readonly version: number;
	readonly fingerprint: string;
};

// 所有读取共用的列清单，顺序与 RecordRow 一致。
const RECORD_COLUMNS =
	"id, owner, namespace, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint";

// 按 id 读取，不区分存活状态。
const READ = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE id = ?`;

/** The record with `id`, live or retired, if there is one. */
// 按 id 读取记录（活的或已退役）；不存在返回 undefined。
export async function readDocument(
	executor: Pick<SqliteExecutor, "get">,
	id: number,
): Promise<DocumentRecord | undefined> {
	const row = await executor.get<RecordRow>(READ, id);
	// 行转记录：可选字段按 NULL 省略。
	return row === undefined ? undefined : recordOf(row);
}

// 当前读取：地址匹配且 retired_at IS NULL；部分唯一索引保证最多一行。
const FIND_CURRENT = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND retired_at IS NULL`;

// 按点读取：存活期覆盖 at，取 createdAt 最新的一代。
const FIND_AT = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
	ORDER BY created_at DESC LIMIT 1`;

/** The record at `address` live at `at` (the half-open lifetime `createdAt <= at < retiredAt`), if any. */
// 在地址上找 at 时存活的记录：当前用唯一索引，按点用半开区间 [createdAt, retiredAt)。
export async function findDocument(
	executor: Pick<SqliteExecutor, "get">,
	address: DocumentAddress,
	at: DocumentPoint = "current",
): Promise<DocumentRecord | undefined> {
	const { owner, namespace, kind } = address;
	// 单例文档的 key 列是空串。
	const key = address.key ?? "";
	// 两个查询只差 WHERE；结果都最多一行。
	const row =
		at === "current"
			? await executor.get<RecordRow>(FIND_CURRENT, owner, namespace, kind, key)
			: await executor.get<RecordRow>(FIND_AT, owner, namespace, kind, key, at, at);
	return row === undefined ? undefined : recordOf(row);
}

/**
 * A record as an adapter that keeps its own fields in `meta` reads it: the meta, and, where a read can find retired
 * records (at a point, by id), when it was retired. One or two columns: each column a read returns costs.
 */
// 只读 meta 的轻量视图；按点读取时才需要 retired_at。
export type DocumentEntry = { readonly meta: string | null; readonly retired_at?: number | null };

/** A document entry with what tells whose it is and what it keeps, as a read by id needs. */
// 按 id 读取时附上归属与历史规则，供适配器判断能否处理。
export type OwnedDocumentEntry = DocumentEntry & {
	readonly owner: string;
	readonly namespace: string;
	readonly history: DocumentHistory;
};

// 比 READ 少读值相关列；适配器只需要自己的 meta 与归属。
const READ_ENTRY = `SELECT meta, retired_at, owner, namespace, history FROM ${TABLES.documents} WHERE id = ?`;

/** The entry of the record with `id`, live or retired, with its owner, namespace and history; `undefined` if none. */
// 按 id 读取轻量 entry（活或退役）；不存在返回 undefined。
export function readDocumentEntry(
	executor: Pick<SqliteExecutor, "get">,
	id: number,
): Promise<OwnedDocumentEntry | undefined> {
	return executor.get<OwnedDocumentEntry>(READ_ENTRY, id);
}

// 当前读取只取 meta，少一列开销。
const FIND_ENTRY_CURRENT = `SELECT meta FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND retired_at IS NULL`;

// 按点读取要返回退役时间，故多取 retired_at。
const FIND_ENTRY_AT = `SELECT meta, retired_at FROM ${TABLES.documents}
	WHERE owner = ? AND namespace = ? AND kind = ? AND key = ? AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
	ORDER BY created_at DESC LIMIT 1`;

/** `findDocument` reading only what an adapter keeping its fields in `meta` needs (fewer columns, no record built). */
// findDocument 的轻量版：不构造完整记录，只返回适配器需要的列。
export function findDocumentEntry(
	executor: Pick<SqliteExecutor, "get">,
	address: DocumentAddress,
	at: DocumentPoint,
): Promise<DocumentEntry | undefined> {
	const { owner, namespace, kind } = address;
	// 单例 key 用空串匹配 SQL 列。
	const key = address.key ?? "";
	return at === "current"
		? executor.get<DocumentEntry>(FIND_ENTRY_CURRENT, owner, namespace, kind, key)
		: executor.get<DocumentEntry>(FIND_ENTRY_AT, owner, namespace, kind, key, at, at);
}

// revisions 表的行形状；content 是 JSON 文本。
type RevisionRow = {
	readonly seq: number;
	readonly kind: "base" | "delta";
	readonly version: number;
	readonly content: string;
};

// 先定位 at 之前最新的 base（子查询只找 base；没有 base 时上层得到空集并抛错），再取该 base 到 at 的所有修订，按 seq 排序。
const LOAD = `SELECT seq, kind, version, content FROM ${TABLES.revisions} WHERE document_id = ? AND seq <= ? AND seq >= (
	SELECT max(seq) FROM ${TABLES.revisions} WHERE document_id = ? AND kind = 'base' AND seq <= ?) ORDER BY seq`;

/**
 * Loads `record` at `at`: its newest base at or below it and the deltas after that base up to it, applied once; the
 * version is the base's. A record without such a base (one that keeps no history from there) throws.
 */
// 加载记录在 at 的值：合并 record 与 loadContent 的结果；无 base 时抛错。
export async function loadDocument(
	executor: Pick<SqliteExecutor, "all">,
	record: DocumentRecord,
	at: DocumentPoint = "current",
): Promise<StoredDocument> {
	return { record, ...(await loadContent(executor, record.id, at)) };
}

/** `loadDocument`'s content of document `id` at `at`, without its record (an adapter reads the fields it keeps). */
// 读取并计算文档 id 在 at 的值：取 base 后按 seq 依次应用 delta。
// 输入 executor/id/at；输出 value、base 版本与 delta 数量；缺 base 或 delta 跨版本时抛错。
// 示例：at = 7 时只使用 seq <= 7 的修订，得到那一刻的值。
export async function loadContent(
	executor: Pick<SqliteExecutor, "all">,
	id: number,
	at: DocumentPoint,
): Promise<Omit<StoredDocument, "record">> {
	// "current" 用一个永远够大的上界复用同一 SQL。
	const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
	const revisions = await executor.all<RevisionRow>(LOAD, id, upper, id, upper);
	// LOAD 保证第一条是所选 base；其余是后续 delta。
	const [base, ...deltas] = revisions;
	// 记录存在但没有可用 base：历史已被清理或数据损坏。
	if (base === undefined || base.kind !== "base") throw new Error(`document ${id}: no base`);
	// content 由 insertRevision 写入，是受信任的 JSON 文本。
	let value = JSON.parse(base.content) as JsonValue;
	for (const delta of deltas) {
		// 一个 base 之后的 delta 必须同版，这是写入时已保证的不变量。
		if (delta.version !== base.version) throw new Error(`document ${id}: a delta crosses a version`);
		// delta 按 seq 顺序应用，得到最终值。
		value = apply(value, JSON.parse(delta.content) as Op[]);
	}
	// 版本属于 base；delta 数供 checkpointWhen 判断。
	return { value, version: base.version, deltasSinceBase: deltas.length };
}

/** Up to `limit` keys of live documents of `kind` under `owner` after `after` (from the first), in code point order. */
// 列出某 owner/namespace/kind 下存活文档的键，按码点升序分页；空键也参与排序。
export async function listDocumentKeys(
	executor: SqliteExecutor,
	address: Omit<DocumentAddress, "key">,
	after: string | undefined,
	limit: number,
): Promise<string[]> {
	// The first page has no lower bound: `""` is a key too.
	// 第一页不加下界，避免漏掉空串键。
	const from = after === undefined ? "" : " AND key > ?";
	// 只选 key 列，减少读取成本。
	const rows = await executor.all<{ readonly key: string }>(
		`SELECT key FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND kind = ?${from}
			AND retired_at IS NULL ORDER BY key LIMIT ?`,
		address.owner,
		address.namespace,
		address.kind,
		...(after === undefined ? [] : [after]),
		limit,
	);
	// 保持 SQL 的码点顺序。
	return rows.map(({ key }) => key);
}

/** What `listDocuments` scans: one owner's namespace, optionally one kind. */
// 列表范围：一个 owner 的 namespace，kind 可选。
export type DocumentScope = { readonly owner: string; readonly namespace: string; readonly kind?: string };

/** The statements of `listDocuments`, by its shape: with a kind or not, current or at a point. */
// 预渲染四种列表 SQL：有无 kind × 当前/按点。
const LIST = (() => {
	const from = `SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND id > ?`;
	// 当前列表只取存活记录，按 id 全序分页。
	const current = " AND retired_at IS NULL ORDER BY id LIMIT ?";
	// 按点列表用半开存活区间，两个 at 参数。
	const at = " AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?) ORDER BY id LIMIT ?";
	return {
		current: `${from}${current}`,
		at: `${from}${at}`,
		kindCurrent: `${from} AND kind = ?${current}`,
		kindAt: `${from} AND kind = ?${at}`,
	};
})();

/** Up to `limit` records of `scope` live at `at` with ids above `after`, by id. */
// 按 id 分页列出 scope 中 at 时存活的记录；kind 可选，结果最多 limit 条。
export async function listDocuments(
	executor: Pick<SqliteExecutor, "all">,
	scope: DocumentScope,
	at: DocumentPoint,
	after: number,
	limit: number,
): Promise<DocumentRecord[]> {
	// 解构后按 kind 是否存在选择预渲染语句。
	const { owner, namespace, kind } = scope;
	// 四种分支只差 SQL 与参数。
	let rows: RecordRow[];
	if (kind === undefined) {
		rows =
			at === "current"
				? await executor.all<RecordRow>(LIST.current, owner, namespace, after, limit)
				: await executor.all<RecordRow>(LIST.at, owner, namespace, after, at, at, limit);
	} else {
		rows =
			at === "current"
				? await executor.all<RecordRow>(LIST.kindCurrent, owner, namespace, after, kind, limit)
				: await executor.all<RecordRow>(LIST.kindAt, owner, namespace, after, kind, at, at, limit);
	}
	return rows.map(recordOf);
}

/** The statements of `listDocumentEntries`, by shape, as `LIST`'s. */
// listDocuments 的 entry 版本：同样四种形状，只选 meta（按点另选 retired_at）。
const LIST_ENTRIES = (() => {
	const from = (columns: string) =>
		`SELECT ${columns} FROM ${TABLES.documents} WHERE owner = ? AND namespace = ? AND id > ?`;
	const current = " AND retired_at IS NULL ORDER BY id LIMIT ?";
	const at = " AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?) ORDER BY id LIMIT ?";
	return {
		current: `${from("meta")}${current}`,
		at: `${from("meta, retired_at")}${at}`,
		kindCurrent: `${from("meta")} AND kind = ?${current}`,
		kindAt: `${from("meta, retired_at")} AND kind = ?${at}`,
	};
})();

/** `listDocuments` reading only what an adapter keeping its fields in `meta` needs. */
// listDocuments 的轻量版：不构造记录，只返回适配器需要的列。
export function listDocumentEntries(
	executor: Pick<SqliteExecutor, "all">,
	scope: DocumentScope,
	at: DocumentPoint,
	after: number,
	limit: number,
): Promise<DocumentEntry[]> {
	const { owner, namespace, kind } = scope;
	if (kind === undefined) {
		return at === "current"
			? executor.all<DocumentEntry>(LIST_ENTRIES.current, owner, namespace, after, limit)
			: executor.all<DocumentEntry>(LIST_ENTRIES.at, owner, namespace, after, at, at, limit);
	}
	return at === "current"
		? executor.all<DocumentEntry>(LIST_ENTRIES.kindCurrent, owner, namespace, after, kind, limit)
		: executor.all<DocumentEntry>(LIST_ENTRIES.kindAt, owner, namespace, after, kind, at, at, limit);
}

/** Up to `limit` stored records, live and retired, with ids above `after`, by id (an export's pages). */
// 导出用：按 id 分页读取全部记录（含已退役），不做存活过滤。
export async function listRecords(executor: SqliteExecutor, after: number, limit: number): Promise<DocumentRecord[]> {
	const rows = await executor.all<RecordRow>(
		`SELECT ${RECORD_COLUMNS} FROM ${TABLES.documents} WHERE id > ? ORDER BY id LIMIT ?`,
		after,
		limit,
	);
	return rows.map(recordOf);
}

/** Up to `limit` stored revisions of document `id` after seq `after`, in seq order (an export's page). */
// 导出用：按 seq 分页读取某文档的修订，返回归档形状（base 值或 delta ops）。
export async function listRevisions(
	executor: SqliteExecutor,
	id: number,
	after: number,
	limit: number,
): Promise<DocumentRevision[]> {
	const rows = await executor.all<RevisionRow>(
		`SELECT seq, kind, version, content FROM ${TABLES.revisions} WHERE document_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
		id,
		after,
		limit,
	);
	return rows.map(({ seq, kind, version, content }) => {
		// Written by `insertRevision`: a base's value or a delta's ops, as JSON.
		// content 是 insertRevision 写入的 JSON；先解析再按 kind 收窄。
		const parsed = JSON.parse(content) as unknown;
		return {
			id,
			seq,
			// base 与 delta 的字段名不同：value vs ops。
			content:
				kind === "base"
					? { kind, version, value: parsed as JsonValue }
					: { kind, version, ops: parsed as readonly Op[] },
		};
	});
}

// SQL 行转 DocumentRecord：可选字段用条件展开，避免写入 undefined。
function recordOf(row: RecordRow): DocumentRecord {
	const { id, namespace, owner, kind, key, history, created_at, retired_at, meta, revision, version, fingerprint } =
		row;
	return {
		id,
		owner,
		namespace,
		kind,
		// 空串 key 视为单例：记录上不出现 key 字段。
		...(key === "" ? {} : { key }),
		history,
		createdAt: created_at,
		// NULL 表示未退役。
		...(retired_at === null ? {} : { retiredAt: retired_at }),
		// 未设置 meta 时省略字段。
		...(meta === null ? {} : { meta }),
		revision,
		version,
		fingerprint,
	};
}
