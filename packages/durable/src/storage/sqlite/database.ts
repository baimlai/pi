// 直接复用 Chord 的可移植 SQLite 类型：数据库、事务内执行器，以及可绑定的值。
// export type 在运行时被擦除；此文件不打开数据库，也不创建另一个驱动实现。
// 文件导读
// 所属：packages/durable/src/storage/sqlite 的驱动契约再导出模块。
// 职责边界：只把 Chord 的 SQLite 接口以类型形式暴露给本包其他模块，没有任何运行时代码，也不绑定具体驱动。
// 上下游：上层（SqliteStorage、migrations.ts）从这里取得数据库/执行器类型；真正实现来自
//   @earendil-works/chord/sqlite（Node、Durable Object 或测试内存驱动）。
// 能力清单：
// - SqliteDatabase（类型）：拥有事务、get/all/run/exec/close 的数据库门面。
// - SqliteExecutor（类型）：事务内可用的同一组语句执行方法。
// - SqliteValue（类型）：可作为 SQL 参数绑定的标量或字节值。
// 组合关系：SqliteStorage.commit 用 SqliteDatabase.transaction 取得 SqliteExecutor，再把 SqliteValue 绑定到语句。
// 示例：import type { SqliteDatabase } from "./database.ts"; 之后函数可写
//   function read(db: SqliteDatabase) { return db.get("SELECT 1 AS one"); } —— 这只是类型使用，导入时不会打开数据库。
// 阅读顺序：本文件没有内部实现；需要行为时转到 Chord 的 src/sqlite/database.ts 与 ./storage.ts。
export type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
