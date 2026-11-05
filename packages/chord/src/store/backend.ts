// Store backends (slice 6a §2): what a store runs on. One kind today, any `SqliteDatabase` (Node through
// `chord/sqlite/node`, Durable Objects through `chord/sqlite/cloudflare`); its interface is internal to the store.
// 本文件把具体 SQLite 驱动包装成 store 可接收的 Backend；上游是 openStore/importStore，结果只是持有 db 的包装对象。
// 它不打开连接、不建表，也不负责关闭；句柄的所有权随构造转移给接收它的 store。
// 所属模块：packages/chord/src/store 的存储后端包装。
// 上下游：openStore/importStore 接收 Backend；下游是 store 的 SQL 执行。sqliteBackend 是唯一构造入口。
// 结果：包装对象本身不打开/关闭连接；错误来自后续 SQL 执行，不来自构造。
// 能力清单：
// - Backend：持有 db 的类，只有一个 db 字段。
// - sqliteBackend(db)：把任意 SqliteDatabase 包成 Backend。
// 组合关系：sqliteBackend(nodeDatabase) -> openStore({ backend, ... }) -> store 通过 backend.db 执行 SQL。
// 示例：const store = await openStore(sqliteBackend(db), ctx); // 之后 db 的所有权归 store
// 阅读顺序：先 Backend 字段，再看 sqliteBackend 的一行构造。

import type { SqliteDatabase } from "../sqlite/index.ts";

// import type 只给 TypeScript 提供类型，运行时不会为了这一行加载 SQLite 驱动。

/** A backend for `openStore` and `importStore`: opaque to apps, owned by the store once given to it. */
// 应用可见的“后端”只是这一层包装：store 依赖它的 db 执行 SQL，但应用不应再直接使用同一个库做并发写入。
// SqliteDatabase 是项目自己的驱动抽象，不同运行时的实现满足同一接口。
export class Backend {
	/** The database the store runs its SQL on. */
	readonly db: SqliteDatabase;

	/** 保存已有数据库句柄，不打开新连接；例如 new Backend(db) 与调用前共享同一个 db，关闭责任交给接收它的 store。 */
	constructor(db: SqliteDatabase) {
		// readonly 限制 TypeScript 调用者重新赋值字段，不会冻结 db，也不会在此处校验驱动实现。
		this.db = db;
	}
}

/** A backend over a SQLite database (`openNodeSqliteDatabase(path)`, a Durable Object's storage, `:memory:` in tests). */
/** 把已打开的 SQLite 数据库包装为 store 的后端并返回；只分配包装对象，不建表、不执行 SQL，例如 openStore(sqliteBackend(db), ctx)。 */
export function sqliteBackend(db: SqliteDatabase): Backend {
	// 具体数据库来自调用者，因此内存库和文件库沿用相同的包装路径。
	return new Backend(db);
}
