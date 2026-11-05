// 统一 Node 与 Cloudflare 的 SQLite 类型；这里只声明契约，不打开数据库。
// 文件导读
// 所属包与模块：packages/chord/src/sqlite 的驱动契约模块，连接续 store 层与具体 SQLite 实现。
// 职责边界：只定义值类型与两个接口，不含实现、不选择运行时；node.ts/cloudflare.ts 各自实现。
// 上游：store 层与迁移器依赖这些接口；下游：驱动把调用转换成 Node DatabaseSync 或 DO storage 操作。
// 结果与错误流向：所有操作返回 Promise；SQL 错误、绑定错误、事务回滚错误都以拒绝表示。接口本身不校验值。
// 能力清单：
// - SqliteValue（类型）：null/number/bigint/string/Uint8Array 的绑定值联合。
// - SqliteExecutor（接口）：exec、run、runCounted、get、all 五个异步操作。
// - SqliteDatabase（接口）：Executor 加 transaction 与 close。
// 组合关系与典型调用顺序：打开数据库 -> 执行 exec/run/get/all -> 需要原子性时 transaction(tx => ...) ->
// 结束 close。事务回调内必须使用 tx，不能等待数据库本身（会与队列互等）。
// 示例（真实签名）：const row = await db.get<{ id: string }>("SELECT id FROM notes WHERE id = ?", "n1");
// await db.transaction(async (tx) => { await tx.run("DELETE FROM notes"); });
// 建议阅读顺序：先 SqliteValue，再看 SqliteExecutor 的五个方法注释，最后 SqliteDatabase 的事务与关闭契约。

/** Values supported by the portable SQLite drivers. */
// 联合类型表示一个绑定值只能是以下一种；Uint8Array 对应二进制 BLOB，null 对应 SQL NULL。
export type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * Asynchronous SQL operations shared by a database and its transaction handles.
 *
 * `exec` runs SQL text without bindings and may contain several statements. `run`, `get`, and `all`
 * execute one statement with positional bindings. `runCounted` runs one like `run` and resolves with the rows it
 * inserted, updated or deleted, as SQLite's `changes()` counts them (index writes and rows changed by triggers do not
 * count); it may cost a statement more than `run`, so callers that need no count use `run`. Adapters may cache
 * prepared statements by SQL text, so callers pass values as bindings instead of interpolating them.
 */
export interface SqliteExecutor {
	// 无参数 SQL，可包含多条语句；例如 exec("CREATE TABLE ...")。失败以 Promise 拒绝报告。
	exec(sql: string): Promise<void>;
	// ...params 是剩余参数，例如 run("INSERT INTO x VALUES (?)", 1)；值由驱动绑定，不拼入 SQL。
	run(sql: string, ...params: SqliteValue[]): Promise<void>;
	// 与 run 相同但返回直接影响的行数；索引和触发器间接写入不计入 changes()。
	runCounted(sql: string, ...params: SqliteValue[]): Promise<number>;
	// T extends object 约束调用方给出的行类型；没有行返回 undefined。T 不会在运行时校验列。
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
	// 返回所有行数组；没有行是 []。T[] 表示元素类型为 T 的数组，不是 JSON Schema 校验。
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}

/**
 * Minimal portable SQLite database facade.
 *
 * All operations are asynchronous so adapters may execute outside the caller's runtime.
 *
 * `transaction` passes the callback a transaction handle. All work in the transaction
 * must use that handle; the handle is invalid after the callback settles. Adapters must
 * queue unrelated operations and other transactions until the transaction finishes. The
 * returned promise settles after commit or rollback. Calling the database itself (including
 * `transaction` or `close`) from inside a callback therefore waits for that transaction and
 * never settles.
 *
 * When the callback rejects, the adapter must roll the transaction back before rejecting
 * with that same error. If rollback fails, it must reject with a different error (for
 * example an `AggregateError`) so callers cannot mistake the callback error for a
 * guaranteed rollback.
 */
export interface SqliteDatabase extends SqliteExecutor {
	// 执行 callback 并提交其结果 T，异常时回滚；例如 transaction(async tx => tx.get(...))。
	// 回调必须使用传入的 transaction：数据库本身排在事务后面，在回调内等待它会造成互等。
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	// 等待先前操作后释放适配器拥有的资源；Cloudflare 的底层 storage 仍由运行时拥有。
	close(): Promise<void>;
}
