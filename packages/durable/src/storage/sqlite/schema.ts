// 为 SQLite 的迁移和运行时查询统一生成表名/索引名，确保同一 prefix 指向同一组对象。
// 文件导读
// 所属：packages/durable/src/storage/sqlite 的表名/索引名生成模块。
// 职责边界：把固定的逻辑名称加上用户前缀，并在拼接 SQL 之前校验前缀是安全标识符；不建表、不查询、不做迁移。
// 上下游：./migrations.ts 与 ./storage.ts 都从这里取名称，因此迁移和运行时看到的是同一组物理表；
//   校验函数来自 Chord 的 SQLite 辅助模块。
// 能力清单：
// - SqliteSchema（类型）：tables 与 indexes 两组只读字符串映射。
// - createSqliteSchema(prefix?)：校验前缀并生成完整名称；缺省前缀为空串。
// - DEFAULT_SQLITE_SCHEMA：模块加载时生成的默认名称对象。
// - validateSqliteSchemaPrefix（转导出）：供其他模块复用同一套前缀校验。
// 内部常量：TABLE_NAMES 与 INDEX_NAMES 是“不可重命名”的历史标识符，新增名称只能追加。
// 组合顺序：createSqliteSchema(prefix) -> createSqliteMigrations(schema) / SqliteStorage 的运行时 SQL。
// 示例：createSqliteSchema("pi_") 返回 { tables: { entries: "pi_entries", ... }, indexes: { ... } }；
//   传入不合法或 sqlite_ 前缀会直接抛错，而不是生成可能注入 SQL 的名称。
// 阅读顺序：先看两个名称常量与 as const 的含义，再看映射类型 SqliteIdentifiers，最后看 createSqliteSchema。
import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";

export { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";

/**
 * Immutable identifier history for migrations and runtime queries. Never change or remove an existing value; a
 * rename adds a new entry so historical migrations keep rendering their original object names.
 */
// as const 保留每个值的字符串字面量类型，并在 TS 中将属性视为只读；不会执行运行时冻结。
const TABLE_NAMES = {
	durableSchema: "durable_schema",
	durableMetadata: "durable_metadata",
	recordIds: "record_ids",
	conversations: "conversations",
	entries: "entries",
	tasks: "tasks",
	submissions: "submissions",
	documents: "documents",
	documentRevisions: "document_revisions",
} as const;

const INDEX_NAMES = {
	conversationsByOwnerConversation: "conversations_by_owner_conversation",
	conversationsByOwnerTask: "conversations_by_owner_task",
	entriesByConversation: "entries_by_conversation",
	entryHeadsByConversation: "entry_heads_by_conversation",
	tasksByStatus: "tasks_by_status",
	tasksByConversation: "tasks_by_conversation",
	tasksByKind: "tasks_by_kind",
	tasksByAbortRequested: "tasks_by_abort_requested",
	tasksByBackground: "tasks_by_background",
	submissionsByRequest: "submissions_by_request",
	submissionsByConversation: "submissions_by_conversation",
	submissionsByStatus: "submissions_by_status",
	documentsByAddress: "documents_by_address",
	documentsByScope: "documents_by_scope",
	documentsByScopeKind: "documents_by_scope_kind",
	documentRevisionsByKind: "document_revisions_by_kind",
} as const;

// 映射类型逐一保留 T 的键 K，但把每个表/索引名称的值统一声明为 string。
// extends 限制输入必须是字符串键值对象；它不会在运行时遍历或校验外部对象。
type SqliteIdentifiers<T extends Record<string, string>> = { readonly [K in keyof T]: string };

// 两组标识符有各自固定的键；typeof 在类型位置提取常量的类型，不执行函数。
export type SqliteSchema = {
	readonly tables: SqliteIdentifiers<typeof TABLE_NAMES>;
	readonly indexes: SqliteIdentifiers<typeof INDEX_NAMES>;
};

// 给 names 的每个名称加 prefix，返回键不变的新对象，不修改 names，也不接触数据库。
// 例：{entries: "entries"} 加 "pi_" 得到 {entries: "pi_entries"}；调用方负责先验证 prefix。
function prefixIdentifiers<T extends Record<string, string>>(names: T, prefix: string): SqliteIdentifiers<T> {
	// entries 拆为 [键, 值] 数组，map 只改名称，fromEntries 再组回对象。
	return Object.fromEntries(
		// 解构回调的两个元素；模板插值拼接的是标识符，不是带引号的 SQL 值。
		Object.entries(names).map(([key, name]) => [key, `${prefix}${name}`]),
		// Object.fromEntries 的库类型无法保留原键集合；断言表达这里确实没有增删键的事实。
	) as SqliteIdentifiers<T>;
}

/** Build the identifiers used by every migration and storage query. */
// 输入可选前缀，先检查合法 SQLite 标识符和 sqlite_ 保留前缀，再返回完整表/索引名称。
// 不做 I/O；非法前缀直接抛错。例："pi_" 生成 pi_entries，未传参则保持 entries。
export function createSqliteSchema(prefix?: string): SqliteSchema {
	// 这是把宿主配置插入 SQL 标识符之前的边界校验，不是检查字符串类型本身。
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	// 缺省前缀为空串，既有默认数据库不需要改表名。
	const actualPrefix = prefix ?? "";
	// 同一套 prefix 同时应用到表和索引，避免共享数据库中的名称冲突。
	return {
		tables: prefixIdentifiers(TABLE_NAMES, actualPrefix),
		indexes: prefixIdentifiers(INDEX_NAMES, actualPrefix),
	};
}

// 模块加载时生成默认标识符对象；这里只分配对象，不创建 SQL 表。
export const DEFAULT_SQLITE_SCHEMA = createSqliteSchema();
