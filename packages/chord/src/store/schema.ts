// The store's own SQL schema (slice 6a §2): its metadata, the recorded table definitions, the documents engine's
// records and revisions, and the outbox; versioned by `applySqliteMigrations`. Declared tables are named
// `"<owner>:<table>"`, so no name here can meet one of them.
// 文件导读
// 所属：packages/chord/src/store（store 层，内部 SQL schema 与迁移）。
// 职责边界：只定义 Chord 自己的元数据/目录/文档/修订/outbox 表和迁移；不处理声明表的 DDL（见 sql.ts）。
// 上游：openStore 调 applyStoreSchema；importStore 在导入事务内复用。下游：所有 store 模块通过 TABLES 引用表名，通过 STORE_SCHEMA/MetaRow 读取元数据。
// 能力清单：
// - TABLES：五个内部表名常量；
// - MIGRATIONS（内部）：版本 1/2 的 DDL 与初始 meta 行；
// - STORE_SCHEMA：当前 schema 版本，归档 manifest 使用；
// - MetaRow：单行元数据 last_seq/next_id/outbox/outbox_floor；
// - applyStoreSchema：快路径读取或执行迁移并返回 meta；
// - currentMeta（内部）：一次 JOIN 读取版本/编码/元数据。
// 组合顺序：currentMeta 成功且版本最新 -> 直接返回；否则检查 UTF-8 -> applySqliteMigrations -> 读 meta。
// 示例：const meta = await applyStoreSchema(db); 返回 { last_seq: 0, next_id: 2, outbox: 0, outbox_floor: 0 }（新 store）。
// 建议阅读顺序：先看 TABLES/STORE_SCHEMA/MetaRow，再看两版迁移，最后看 applyStoreSchema/currentMeta。

import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "../sqlite/index.ts";

/** The store's tables. */
export const TABLES = {
	meta: "chord_meta",
	tables: "chord_tables",
	documents: "chord_documents",
	revisions: "chord_revisions",
	outbox: "chord_outbox",
} as const;
// 常量对象集中内部表名，避免各处硬编码；chord_ 前缀与声明表 <owner>:<table> 的命名空间隔离。

/**
 * The schema history; never change an entry, append one (nothing is deployed yet: slice 6b changed entry 1 in place).
 * `chord_meta` is one row: `last_seq`, the allocator's next id (D3; from 2, id 1 is Durable's root conversation), and
 * the outbox setting with its floor (the seq it starts after, advanced by `trim`). A document record keeps its
 * history rule (R1), its current base's version and fingerprint and a `revision` counter for the conditional
 * `UPDATE`; the partial unique index refuses two live records at one address. Entry 2 adds the indexes of reads at a
 * point (slice 6b §1.5): an address's incarnations by creation, an owner's namespace by id, a document's bases (a
 * partial index: deltas write no entry).
 */
// 迁移数组只追加、不修改已发布项；版本 1 建表并插入单行 meta，版本 2 加文档读取索引。
// 每个 statement 在 applySqliteMigrations 的一个事务里按版本执行。
const MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE ${TABLES.meta} (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				last_seq INTEGER NOT NULL,
				next_id INTEGER NOT NULL,
				outbox INTEGER NOT NULL CHECK (outbox IN (0, 1)),
				outbox_floor INTEGER NOT NULL
			) STRICT`,
			// 单行表用 CHECK(singleton = 1) 固定；outbox 0/1 也用 CHECK 限制。
			`INSERT INTO ${TABLES.meta} (singleton, last_seq, next_id, outbox, outbox_floor) VALUES (1, 0, 2, 0, 0)`,
			// 新 store 从 last_seq=0、next_id=2 开始（id 1 留给 Durable 根会话），outbox 默认关闭。
			`CREATE TABLE ${TABLES.tables} (name TEXT PRIMARY KEY, definition TEXT NOT NULL) STRICT, WITHOUT ROWID`,
			// STRICT + WITHOUT ROWID；definition 是 TableRecord 的 JSON 文本。
			`CREATE TABLE ${TABLES.documents} (
				id INTEGER PRIMARY KEY,
				owner TEXT NOT NULL,
				namespace TEXT NOT NULL,
				kind TEXT NOT NULL,
				key TEXT NOT NULL,
				history TEXT NOT NULL CHECK (history IN ('none', 'latest', 'rewindable')),
				created_at INTEGER NOT NULL,
				retired_at INTEGER,
				meta TEXT,
				revision INTEGER NOT NULL,
				version INTEGER NOT NULL,
				fingerprint TEXT NOT NULL
			) STRICT`,
			// 文档记录保存地址四元组、历史规则、生命周期、修订计数与当前 base 版本/指纹。
			`CREATE UNIQUE INDEX chord_documents_live ON ${TABLES.documents} (owner, namespace, kind, key)
				WHERE retired_at IS NULL`,
			// 部分唯一索引只约束 retired_at IS NULL 的行：同一地址最多一条存活记录，退役记录可并存。
			`CREATE TABLE ${TABLES.revisions} (
				document_id INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
				version INTEGER NOT NULL,
				content TEXT NOT NULL,
				PRIMARY KEY (document_id, seq)
			) STRICT, WITHOUT ROWID`,
			// 修订以 (document_id, seq) 为主键；seq 是提交序号，content 是该修订的 JSON。
			`CREATE TABLE ${TABLES.outbox} (
				seq INTEGER PRIMARY KEY,
				format INTEGER NOT NULL,
				next_id INTEGER NOT NULL,
				writes TEXT NOT NULL
			) STRICT`,
			// outbox 每个提交一行，seq 为主键；format 支持未来写入词汇升级，next_id 是该提交持久化的分配器值。
		],
	},
	{
		version: 2,
		statements: [
			`CREATE INDEX chord_documents_address ON ${TABLES.documents} (owner, namespace, kind, key, created_at)`,
			`CREATE INDEX chord_documents_scope ON ${TABLES.documents} (owner, namespace, id)`,
			// Only bases are looked up by it (a load's newest base at or below a point): deltas write no entry.
			// 部分索引只给 base 建条目；读取「某点之前最新的 base」时无需扫描 delta。
			`CREATE INDEX chord_revisions_bases ON ${TABLES.revisions} (document_id, seq) WHERE kind = 'base'`,
		],
	},
];

/** The store's schema version: the newest entry of its history (archives carry it). */
export const STORE_SCHEMA = MIGRATIONS.at(-1)!.version;
// schema 版本取迁移数组最后一项；归档 manifest 用它判断兼容性。

/** The store's metadata row, as `openStore` reads it once. */
export type MetaRow = {
	readonly last_seq: number;
	readonly next_id: number;
	readonly outbox: number;
	readonly outbox_floor: number;
};
// 数据库列名用 snake_case；这些值在打开时一次读入，之后由 ChordStore 维护。

/**
 * Brings `db` to the store's newest schema (one transaction) and checks that it stores text as UTF-8 (the store
 * compares text by its bytes); returns the metadata row. A store already there is read in one statement, without the
 * migrations' write transaction (most opens: the cost of a reopen).
 */
// 确保 db 是最新 schema：先尝试一条 JOIN 快查（已有 store 的常见路径），失败才检查编码并跑迁移；返回 meta 行。
// 输入是已打开的 SqliteDatabase；输出 MetaRow；新建或升级时写数据库，编码不符或 meta 缺失抛普通 Error。
export async function applyStoreSchema(db: SqliteDatabase): Promise<MetaRow> {
	const current = await currentMeta(db);
	// 快路径：版本、编码、meta 一次读出；不是 store 或版本旧则返回 undefined。
	if (current !== undefined) return current;
	const encoding = await db.get<{ readonly encoding: string }>("PRAGMA encoding");
	// 只有新建/升级路径才检查 PRAGMA encoding；store 按 UTF-8 字节比较文本，编码不符拒绝。
	if (encoding?.encoding !== "UTF-8")
		throw new Error(`store: the database encoding is ${encoding?.encoding}, not UTF-8`);
	// applySqliteMigrations 在事务中执行尚未应用的版本。
	await applySqliteMigrations(db, MIGRATIONS, { table: "chord_store_schema" });
	// 迁移后 meta 必须存在（v1 已插入）。
	const meta = await db.get<MetaRow>(
		`SELECT last_seq, next_id, outbox, outbox_floor FROM ${TABLES.meta} WHERE singleton = 1`,
	);
	// 缺失说明数据库损坏或迁移被外部改动，直接抛错。
	if (meta === undefined) throw new Error("store: the metadata row is missing");
	return meta;
}

/** The schema version, the encoding and the metadata row of a store, in one read. */
const CURRENT_META = `SELECT s.version, e.encoding, m.last_seq, m.next_id, m.outbox, m.outbox_floor
	FROM chord_store_schema s, pragma_encoding e, ${TABLES.meta} m WHERE s.singleton = 1 AND m.singleton = 1`;
// 用 pragma_encoding 表函数把编码和 meta 放进同一查询；任一表缺失时查询抛错，由 currentMeta 捕获。

/** The metadata row of a store at the newest schema in UTF-8; `undefined` for any other database. */
// 快路径读取；捕获所有异常并返回 undefined，让迁移路径决定是新建、拒绝还是升级。
// 注意：这里只吞掉「不是已知 store」的错误，后续迁移的错误仍会正常抛出。
async function currentMeta(db: SqliteDatabase): Promise<MetaRow | undefined> {
	let row: (MetaRow & { readonly version: number; readonly encoding: string }) | undefined;
	try {
		row = await db.get(CURRENT_META);
	} catch {
		// A database without the store's tables (new, or not a store) or a backend without `pragma_encoding`: the
		// migrations' path creates, refuses or reads it.
		// 没有 chord_store_schema/pragma_encoding 时 get 会抛错；统一视为「不是已知 store」。
		return undefined;
	}
	// 版本或编码不符同样走完整路径（可能升级或抛编码错误）。
	if (row === undefined || row.version !== STORE_SCHEMA || row.encoding !== "UTF-8") return undefined;
	// 只返回 meta 字段，不把 version/encoding 泄漏给调用者。
	return { last_seq: row.last_seq, next_id: row.next_id, outbox: row.outbox, outbox_floor: row.outbox_floor };
}
