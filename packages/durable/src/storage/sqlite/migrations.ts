// 声明 Durable 的 SQLite 表结构历史；SQL 字符串是历史输入，已发布迁移不能改写。
// 文件导读
// 所属：packages/durable/src/storage/sqlite 的迁移历史模块，被 SqliteStorage.open 与测试直接使用。
// 职责边界：只声明“版本 -> SQL 语句”的不可变历史，并把 schema 标识符渲染进 SQL；实际事务、版本账本、
//   回滚和“数据库比代码新”的拒绝由 Chord 的迁移运行器完成。此文件不打开数据库。
// 上下游：./schema.ts 生成带前缀的表名/索引名；上游 SqliteStorage.open 调用 applySqliteMigrationsForSchema；
//   下游 @earendil-works/chord/sqlite 的 applySqliteMigrations 执行这些语句。
// 结果与错误：构造期间只分配字符串；执行期间 SQL 错误、版本不连续、数据库版本过新都会拒绝 Promise。
// 能力清单：
// - SqliteMigration（类型，转导出）：一个版本的编号与语句列表。
// - createSqliteMigrations(schema)：为指定表名/索引名生成版本 1 和版本 2 的迁移数组。
// - SQLITE_MIGRATIONS：默认（无前缀）表名下的迁移数组。
// - CURRENT_SQLITE_SCHEMA_VERSION：历史最后一个版本号。
// - applySqliteMigrations(database, migrations?)：用默认表名应用迁移。
// - applySqliteMigrationsForSchema(database, schema, migrations?)：用指定 schema 的表名应用迁移。
// 组合顺序：createSqliteSchema(prefix) -> createSqliteMigrations(schema) -> applySqliteMigrationsForSchema。
// 示例：const schema = createSqliteSchema("pi_");
//   await applySqliteMigrationsForSchema(db, schema); // 建立/升级 pi_durable_metadata 等表，并把版本写进 pi_durable_schema。
// 阅读顺序：先看 initialSchema 的表/索引与字段含义，再看版本 2 的 sleeping 重建，最后看三个应用函数。
import {
	applySqliteMigrations as applyMigrations,
	type SqliteDatabase,
	type SqliteMigration,
} from "@earendil-works/chord/sqlite";
import { DEFAULT_SQLITE_SCHEMA, type SqliteSchema } from "./schema.ts";

export type { SqliteMigration } from "@earendil-works/chord/sqlite";

/** Build immutable, ordered schema history for a set of SQLite identifiers. */
// 输入渲染好的表/索引名，返回按版本排序的迁移数组；只构造字符串，不执行 SQL。
// 版本 1 建基础表，版本 2 重建任务表以允许 sleeping；例：带 pi_ 的 schema 会把所有名称一并加前缀。
// readonly 约束 TS 使用方不要改数组，并不在此执行 Object.freeze；数据库执行错误发生在后面的 apply 函数。
export function createSqliteMigrations(schema: SqliteSchema): readonly SqliteMigration[] {
	// 解构出两组固定名称；SQL 中的插值只能来自 createSqliteSchema 已验证的标识符。
	const { tables, indexes } = schema;
	// next_id is TEXT because node:sqlite rejects INTEGER results outside JavaScript's safe integer range.
	// 这一数组中的语句会严格按顺序执行；模板原文保持不变，不能在模板内部塞入源码注释。
	const initialSchema: readonly string[] = [
		// 元数据单行保存下一个全局 ID 与提交序号；singleton 的 CHECK 限定其主键为 1。
		`CREATE TABLE ${tables.durableMetadata} (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			next_id TEXT NOT NULL,
			next_seq INTEGER NOT NULL
		) STRICT`,
		// ID 从 2 起，序号从 1 起；next_id 以文本保存，耗尽后的下一值也能无精度损失地保存。
		`INSERT INTO ${tables.durableMetadata} (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
		// 全局 ID 表防止不同记录类型复用同一个数字；CHECK 是数据库实际执行的约束。
		`CREATE TABLE ${tables.recordIds} (
			id INTEGER PRIMARY KEY,
			record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
		) STRICT`,
		// 会话保存便于索引的所有权字段，完整记录仍作为有效 JSON 文本保存。
		`CREATE TABLE ${tables.conversations} (
			id INTEGER PRIMARY KEY,
			owner_conversation_id INTEGER,
			owner_task_id INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		// 两种所有者各有 (owner, id) 索引，支持按所有权和 ID 游标顺序扫描。
		`CREATE INDEX ${indexes.conversationsByOwnerConversation} ON ${tables.conversations} (owner_conversation_id, id)`,
		`CREATE INDEX ${indexes.conversationsByOwnerTask} ON ${tables.conversations} (owner_task_id, id)`,
		// entry 不可变；commit_seq 用于由某条历史消息定位当时的文档状态，head 是可选上下文标记。
		`CREATE TABLE ${tables.entries} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			head INTEGER,
			commit_seq INTEGER NOT NULL,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		// 普通历史扫描使用第一项索引；第二项是只包含 head 非空条目的部分索引。
		`CREATE INDEX ${indexes.entriesByConversation} ON ${tables.entries} (conversation_id, id DESC)`,
		`CREATE INDEX ${indexes.entryHeadsByConversation} ON ${tables.entries} (conversation_id, id DESC) WHERE head IS NOT NULL`,
		// 任务状态、取消标记和后台标记都有独立列；此初版 CHECK 尚未包含 sleeping。
		`CREATE TABLE ${tables.tasks} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		// 每种常见任务筛选都可以从相应索引按 ID 扫描；其他条件再组合过滤。
		`CREATE INDEX ${indexes.tasksByStatus} ON ${tables.tasks} (status, id)`,
		`CREATE INDEX ${indexes.tasksByConversation} ON ${tables.tasks} (conversation_id, id)`,
		`CREATE INDEX ${indexes.tasksByKind} ON ${tables.tasks} (kind, id)`,
		`CREATE INDEX ${indexes.tasksByAbortRequested} ON ${tables.tasks} (abort_requested, id)`,
		`CREATE INDEX ${indexes.tasksByBackground} ON ${tables.tasks} (background, id)`,
		// submission 为入队输入或写入的持久记录；可选 request_id 支持相同请求的重新查找。
		`CREATE TABLE ${tables.submissions} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			request_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		// 请求去重用 (conversation_id, request_id)，分页用会话/状态加 ID；这里不是 UNIQUE 索引。
		`CREATE INDEX ${indexes.submissionsByRequest} ON ${tables.submissions} (conversation_id, request_id)`,
		`CREATE INDEX ${indexes.submissionsByConversation} ON ${tables.submissions} (conversation_id, id)`,
		`CREATE INDEX ${indexes.submissionsByStatus} ON ${tables.submissions} (status, id)`,
		// 文档元数据保留每一代 incarnation 的作用域、地址与半开生存期 [created_at, retired_at)。
		// family 区分单例与带键文档，key_value 用于精确地址查找，record 保留完整定义选项。
		`CREATE TABLE ${tables.documents} (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL,
			family INTEGER NOT NULL CHECK (family IN (0, 1)),
			key_value TEXT NOT NULL,
			scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
			owner_id INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			retired_at INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		// 地址索引用于从同一逻辑地址找到当时存活的一代；作用域索引用于枚举，kind 索引用于进一步筛选。
		`CREATE INDEX ${indexes.documentsByAddress}
			ON ${tables.documents} (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
		`CREATE INDEX ${indexes.documentsByScope} ON ${tables.documents} (scope_kind, owner_id, id)`,
		`CREATE INDEX ${indexes.documentsByScopeKind} ON ${tables.documents} (scope_kind, owner_id, kind, id)`,
		// 每条版本保存完整 base 或 delta 的内容，复合主键确保一文档在一次提交只有一条内容版本。
		`CREATE TABLE ${tables.documentRevisions} (
			document_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
			version INTEGER NOT NULL,
			content TEXT NOT NULL CHECK (json_valid(content)),
			PRIMARY KEY (document_id, seq)
		) STRICT`,
		// 读取某时刻前最近的 base 时，按 document/kind/seq 降序直接定位。
		`CREATE INDEX ${indexes.documentRevisionsByKind} ON ${tables.documentRevisions} (document_id, kind, seq DESC)`,
	];
	// Version 2 adds the `sleeping` task status. SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
	// 临时表也从带前缀的名称派生，避免在共享数据库中碰到另一套 Durable 表。
	const rebuiltTasks = `${tables.tasks}_v2`;
	// 原表先复制到新表，再删旧表并重命名，所有操作由迁移运行器放进同一事务。
	const sleepingStatus: readonly string[] = [
		// 与原任务表相同的列，唯一行为扩展是状态 CHECK 允许 sleeping。
		`CREATE TABLE ${rebuiltTasks} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		// 显式列清单原样保留旧任务内容，不在迁移里重新解释 JSON 记录。
		`INSERT INTO ${rebuiltTasks} (id, conversation_id, kind, status, abort_requested, background, record)
			SELECT id, conversation_id, kind, status, abort_requested, background, record FROM ${tables.tasks}`,
		// 删旧表会同时移除旧索引；新表更名后按原索引名称重新创建。
		`DROP TABLE ${tables.tasks}`,
		`ALTER TABLE ${rebuiltTasks} RENAME TO ${tables.tasks}`,
		// 恢复五种任务查询索引，名称仍与运行时 schema 一致。
		`CREATE INDEX ${indexes.tasksByStatus} ON ${tables.tasks} (status, id)`,
		`CREATE INDEX ${indexes.tasksByConversation} ON ${tables.tasks} (conversation_id, id)`,
		`CREATE INDEX ${indexes.tasksByKind} ON ${tables.tasks} (kind, id)`,
		`CREATE INDEX ${indexes.tasksByAbortRequested} ON ${tables.tasks} (abort_requested, id)`,
		`CREATE INDEX ${indexes.tasksByBackground} ON ${tables.tasks} (background, id)`,
	];
	// 版本从 1 连续递增；执行器据元数据跳过已完成版本，而不是每次重建全部表。
	return [
		{ version: 1, statements: initialSchema },
		{ version: 2, statements: sleepingStatus },
	];
}

// 默认名称的迁移在模块加载时生成；这仍未连数据库或执行 SQL。
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = createSqliteMigrations(DEFAULT_SQLITE_SCHEMA);

// at(-1) 取末项；?. 和 ?? 使空迁移历史的支持版本为 0。
export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

/** Apply all pending schema migrations atomically. */
// 对 database 使用默认表名应用尚未执行的 migrations；默认取上面完整历史，返回 Promise<void>。
// 会写库，SQL/版本错误向上传播；例如已有版本 1 时只执行版本 2，并在同一事务更新版本号。
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	// await 使调用者只能在迁移成功后继续；实际事务及回滚由 Chord 的迁移运行器完成。
	await applySqliteMigrationsForSchema(database, DEFAULT_SQLITE_SCHEMA, migrations);
}

/** Apply migrations rendered for a particular schema. */
// schema 决定版本元数据表名，migrations 默认由同一 schema 渲染，返回迁移完成的 Promise<void>。
// Chord 运行器校验连续版本、拒绝比当前代码更新的数据库，并在一个事务执行所有待迁移 SQL。
// 例：prefix 为 pi_ 时版本写在 pi_durable_schema；本函数不自行捕获数据库错误或重试。
export async function applySqliteMigrationsForSchema(
	database: SqliteDatabase,
	schema: SqliteSchema,
	migrations: readonly SqliteMigration[] = createSqliteMigrations(schema),
): Promise<void> {
	// applyMigrations 是导入时重命名的 Chord 函数；table 指定这套 Durable 表自己的版本账本。
	await applyMigrations(database, migrations, { table: schema.tables.durableSchema });
}
