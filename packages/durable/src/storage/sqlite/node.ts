// 把 Node 的 SQLite 连接和 Durable 存储初始化组合成一个入口。
// 文件导读
// 所属：packages/durable/src/storage/sqlite 的 Node 平台入口（包导出子路径 ./storage/sqlite/node）。
// 职责边界：处理“文件路径 + 连接选项 + 表前缀”，校验前缀后打开 node:sqlite 连接，再交给 SqliteStorage.open；
//   不实现迁移 SQL，也不管理连接之外的进程资源。
// 上下游：脚本、测试和本地 Harness 调用 openNodeSqliteStorage；下游是 Chord 的 openNodeSqliteDatabase 与
//   本目录的 SqliteStorage。返回值是迁移完成的存储，连接由该存储持有并在 close() 时关闭。
// 能力清单：
// - NodeSqliteDatabase / NodeSqliteDatabaseOptions / openNodeSqliteDatabase（转导出）：Chord 的 Node 驱动。
// - NodeSqliteStorageOptions：连接选项与 Durable 存储选项的交叉类型。
// - openNodeSqliteStorage(path, options?)：打开或创建文件型存储。
// 组合顺序：拆分 prefix -> validateSqliteSchemaPrefix -> openNodeSqliteDatabase -> SqliteStorage.open。
// 示例：const storage = await openNodeSqliteStorage("./session.sqlite", { prefix: "pi_" });
//   ":memory:" 可用于临时存储；文件路径相对调用进程的当前工作目录。
// 阅读顺序：先看函数体三步，再看 ./storage.ts 的 open；驱动细节转到 Chord 的 sqlite/node.ts。
import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import { type NodeSqliteDatabaseOptions, openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { SqliteStorage, type SqliteStorageOptions } from "./storage.ts";

export {
	NodeSqliteDatabase,
	type NodeSqliteDatabaseOptions,
	openNodeSqliteDatabase,
} from "@earendil-works/chord/sqlite/node";

/** Node SQLite connection settings plus durable storage options. */
// & 是交叉类型：同一个配置对象同时允许数据库连接配置和存储表名前缀。
export type NodeSqliteStorageOptions = NodeSqliteDatabaseOptions & SqliteStorageOptions;

/** Open or create file-backed durable storage using Node's built-in SQLite, optionally under a table prefix. */
// path 为数据库文件路径（也可为 :memory:），options 缺省为空；返回完成迁移的存储 Promise。
// 先校验 prefix，再打开 Node 连接并交给 SqliteStorage.open；会创建目录/文件和表，错误向上传播。
// 例：openNodeSqliteStorage("./session.sqlite", {prefix: "pi_"}) 使用 pi_ 开头的 Durable 表。
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	// 对象剩余属性 ... 把 prefix 排除在数据库选项之外，避免传给 Node 驱动。
	const { prefix, ...databaseOptions } = options;
	// 在打开文件之前拒绝不合法的 SQL 标识符前缀。
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	// 内层 await 等连接配置完毕；外层返回存储的初始化 Promise，调用方继续 await 它。
	return SqliteStorage.open(await openNodeSqliteDatabase(path, databaseOptions), { prefix });
}
