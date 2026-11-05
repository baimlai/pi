// 用宿主提供的 Durable Object SQLite storage 初始化同一个可移植 Durable 后端。
// 文件导读
// 所属：packages/durable/src/storage/sqlite 的 Cloudflare 打开入口（包导出子路径 ./storage/sqlite/cloudflare）。
// 职责边界：把 Durable Object 的 ctx.storage 包装成 Chord 的 SqliteDatabase，再交给 SqliteStorage 完成表前缀校验、
//   迁移和元数据读取。本文件不实现 SQL、不新建连接、不负责 Durable Object 的创建或销毁。
// 上下游：Workers 中的 Durable Object 代码把 ctx.storage 传进来；下游依赖 Chord 的 DurableObjectSqliteDatabase
//   和本目录的 SqliteStorage.open。成功返回可用的 Storage，存储或迁移错误沿 Promise 拒绝传播。
// 能力清单：
// - DurableObjectSqliteStorage（类型，转导出）：宿主注入的 SQLite storage 结构。
// - DurableObjectSqliteDatabase（值，转导出）：Chord 提供的执行器/数据库适配器。
// - openDurableObjectSqliteStorage(storage, options?)：组合适配器与 Durable 存储的打开函数。
// 组合顺序：new DurableObjectSqliteDatabase(ctx.storage) -> SqliteStorage.open(database, options)。
// 示例：const storage = await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" });
//   返回的 storage 随后交给 Session/Harness；prefix 只改变表名，不迁移既有数据。
// 阅读顺序：先读 openDurableObjectSqliteStorage 的两步流程，再看 ./storage.ts 的 SqliteStorage.open，
//   最后按需看 ./schema.ts 与 ./migrations.ts 的表名和建表语句。
import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@earendil-works/chord/sqlite/cloudflare";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";

export { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@earendil-works/chord/sqlite/cloudflare";

/**
 * Open durable storage on a SQLite-backed Durable Object, optionally under a table prefix. Calls given the same
 * storage object share an operation queue.
 */
// storage 是 ctx.storage 的所需结构，options 为可选表名前缀；返回迁移完成后的存储 Promise。
// 构造适配器并由 SqliteStorage.open 检查前缀/迁移；会写入宿主数据库，失败由 Promise 拒绝。
// 例：传同一个 ctx.storage 两次时，两适配器通过 Chord 按该对象共享操作队列；直接访问 ctx.storage 会绕开队列。
export function openDurableObjectSqliteStorage(
	storage: DurableObjectSqliteStorage,
	options: SqliteStorageOptions = {},
): Promise<SqliteStorage> {
	// new 只包装已有宿主存储；此函数没有新建网络连接，也不拥有 Durable Object 的生命周期。
	return SqliteStorage.open(new DurableObjectSqliteDatabase(storage), options);
}
