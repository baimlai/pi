// 在一个 SQLite 事务里按顺序应用尚未执行的迁移，并记录最终版本。
// 文件导读
// 所属包与模块：packages/chord/src/sqlite 的迁移模块，服务 store 的建库与升级流程。
// 职责边界：校验迁移列表和元数据表名、在一个事务内建版本表、读取当前版本、执行缺失版本并更新版本；
// 不生成 SQL 内容、不做降级、不提供备份。
// 上游：store 打开数据库后调用；下游：使用 SqliteDatabase.transaction 与 schema.ts 的名字校验。
// 结果与错误流向：成功返回 Promise<void> 并提交；任一步失败由驱动回滚整个事务（包括版本写入）。
// 数据库版本高于代码支持版本时抛错，避免降级破坏数据；元数据缺失也视为异常。
// 能力清单：
// - SqliteMigration（类型）：version 与 statements。
// - applySqliteMigrations（函数）：应用迁移的主入口。
// （内部）SchemaRow：版本查询的行形状。
// 组合关系与典型调用顺序：validate -> 校验连续版本 -> transaction -> 建表/插 0 -> 读版本 -> 逐版本 exec -> 更新版本。
// 示例（真实签名）：await applySqliteMigrations(db, [
//   { version: 1, statements: ["CREATE TABLE notes (id TEXT)"] },
//   { version: 2, statements: ["ALTER TABLE notes ADD COLUMN body TEXT"] },
// ], { table: "schema" });
// 建议阅读顺序：先 SqliteMigration，再看 applySqliteMigrations 的前置检查，最后事务体与版本跳过逻辑。
import type { SqliteDatabase } from "./database.ts";
import { validateSqliteSchemaPrefix } from "./schema.ts";

// readonly 阻止 TypeScript 使用者通过此类型赋值，不会在运行时冻结对象或数组。
export type SqliteMigration = {
	// 迁移版本必须从 1 连续递增，下面的函数会在运行时检查这个声明策略。
	readonly version: number;
	// 一个版本包含依次执行的 SQL；字符串内容由调用方提供，不由此处生成。
	readonly statements: readonly string[];
};

type SchemaRow = { readonly version: number };

/** Apply all pending migrations atomically, tracking their version in the named metadata table. */
// 输入数据库、迁移列表和元数据表名；返回所有待执行版本完成后的 Promise<void>。
// 先检查名字/版本，再创建版本表、读取已有版本、执行新 SQL、更新版本；任一步失败由驱动回滚。
// 副作用是建表与改数据库。例如已到 v1、列表为 [v1,v2] 时，只执行 v2。
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[],
	options: { readonly table: string },
): Promise<void> {
	// 解构取出表名；它要拼进 SQL，所以须先走受限标识符检查。
	const { table } = options;
	validateSqliteSchemaPrefix(table);
	// 数组下标从 0 开始，要求版本恰好为下标 + 1，拒绝缺号、乱序或重复。
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("SQLite migrations must have contiguous versions starting at 1");
		}
	}

	// await 等整个事务提交或回滚；回调内部始终使用 transaction，避免排队互等。
	await database.transaction(async (transaction) => {
		// STRICT 表只允许一个 singleton=1 的版本行；此多行模板是实际 SQL，不向模板内部加注释。
		await transaction.exec(`CREATE TABLE IF NOT EXISTS ${table} (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		// 首次迁移写入版本 0；已有记录时 OR IGNORE 保留原版本。
		await transaction.run(`INSERT OR IGNORE INTO ${table} (singleton, version) VALUES (1, 0)`);
		// <SchemaRow> 只声明期望行形状，实际内容来自数据库。
		const row = await transaction.get<SchemaRow>(`SELECT version FROM ${table} WHERE singleton = 1`);
		// 版本元数据缺失属于数据库状态异常，不能当成版本 0 继续。
		if (row === undefined) throw new Error("SQLite schema metadata is missing");
		// at(-1) 取最后一个版本；空列表经 ?. 和 ?? 得到 0。
		const currentVersion = migrations.at(-1)?.version ?? 0;
		// 数据库比代码更新时拒绝降级，保留已有数据。
		if (row.version > currentVersion) {
			throw new Error(`SQLite schema version ${row.version} is newer than supported version ${currentVersion}`);
		}
		// 逐版本执行；事务中的版本写入和迁移 SQL 要么一起提交，要么一起回滚。
		for (const migration of migrations) {
			// 已执行版本跳过；这里比较的是刚读到的初始版本，列表本身已保证连续有序。
			if (migration.version <= row.version) continue;
			// 同一版本内按数组顺序等待每条 SQL。
			for (const statement of migration.statements) await transaction.exec(statement);
			// ? 绑定版本值；表名经过前面的名字校验后才直接插入 SQL。
			await transaction.run(`UPDATE ${table} SET version = ? WHERE singleton = 1`, migration.version);
		}
	});
}
