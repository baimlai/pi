// 可移植 SQLite 入口：导出驱动契约、迁移历史和存储本体，Node/Cloudflare 的打开入口另有子路径。
// type 导出只参与 TS 检查；这里没有直接打开连接，迁移模块加载时只构造 SQL 字符串。
// 文件导读
// 所属：packages/durable/src/storage/sqlite 的包入口（导出子路径 ./storage/sqlite）。
// 职责边界：汇总“与平台无关”的 SQLite 部件；本文件自身不打开连接、不执行 SQL。平台打开入口分别在
//   ./node.ts 与 ./cloudflare.ts，避免浏览器/Workers 构建意外引入 Node 驱动。
// 上下游：Session/Harness 或测试从上层的打开函数拿到 SqliteStorage；需要迁移工具或类型时从本入口导入。
// 能力清单：
// - SqliteDatabase / SqliteExecutor / SqliteValue（类型，转导出）：驱动契约。
// - SqliteMigration（类型）：{ version, statements } 形式的迁移描述。
// - SQLITE_MIGRATIONS：默认表名下的完整有序迁移历史。
// - CURRENT_SQLITE_SCHEMA_VERSION：迁移历史最后一个版本号。
// - applySqliteMigrations：对给定数据库应用默认迁移。
// - SqliteStorage / SqliteStorageOptions：存储实现与表前缀选项。
// 组合顺序：open<平台>SqliteDatabase -> SqliteStorage.open(db, options) -> 交给 Session；
//   也可单独调用 applySqliteMigrations 验证迁移。
// 示例：import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
//   读取版本常量只是导入模块，不会连接数据库。
// 阅读顺序：先看 ./schema.ts 的名字生成，再看 ./migrations.ts 的 SQL 历史，最后看 ./storage.ts 的读写实现；
//   平台入口放最后。
export type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
export {
	applySqliteMigrations,
	CURRENT_SQLITE_SCHEMA_VERSION,
	SQLITE_MIGRATIONS,
	type SqliteMigration,
} from "./migrations.ts";
export { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";
