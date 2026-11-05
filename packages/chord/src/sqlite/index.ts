// 可移植 SQLite 公共入口：只重新导出类型、迁移器和名字校验，不在此选择 Node/Cloudflare 驱动。
// 文件导读
// 所属包与模块：packages/chord/src/sqlite 的公共入口，供 store 层与 Durable 适配使用。
// 职责边界：只 re-export，不打开连接、不选择驱动；具体驱动由 node.ts/cloudflare.ts 提供，调用方按运行时选择。
// 上游：store 层创建数据库后调用 applySqliteMigrations；下游：驱动实现 SqliteDatabase，迁移写入真实表。
// 结果与错误流向：导入本文件无副作用；错误来自被调用函数（迁移版本错误、SQL 失败、非法表名）。
// 能力清单：
// - SqliteValue（类型）：可绑定的 SQL 值联合。
// - SqliteExecutor（接口）：exec/run/runCounted/get/all 五个异步操作。
// - SqliteDatabase（接口）：Executor 加 transaction/close。
// - SqliteMigration（类型）：版本与语句列表。
// - applySqliteMigrations（函数）：在事务中按顺序应用迁移并记录版本。
// - validateSqliteSchemaPrefix（函数）：校验被拼进标识符的前缀。
// 组合关系与典型调用顺序：选择一个驱动 -> 打开 SqliteDatabase -> validateSqliteSchemaPrefix(表名) ->
// applySqliteMigrations -> 业务 SQL。transaction 内部的回调必须使用传入的事务句柄。
// 示例（真实签名）：import { applySqliteMigrations } from "@earendil-works/pi-chord/sqlite";
// await applySqliteMigrations(db, [{ version: 1, statements: ["CREATE TABLE notes (id TEXT)"] }], { table: "schema" });
// 建议阅读顺序：先 database.ts 了解契约，再看 migrations.ts 的事务顺序，最后 schema.ts 的名字规则。
// export type 仅参与类型检查，擦除后不会产生运行时代码。
export type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";
// 同一条导出里 type SqliteMigration 是类型，applySqliteMigrations 则是运行时函数。
export { applySqliteMigrations, type SqliteMigration } from "./migrations.ts";
export { validateSqliteSchemaPrefix } from "./schema.ts";
