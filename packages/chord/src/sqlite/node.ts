// 把 Node 的同步 SQLite 接口包装为可等待的串行操作，并隔离事务和管理预编译语句缓存。
// 文件导读
// 所属包与模块：packages/chord/src/sqlite 的 Node 驱动，基于 node:sqlite（DatabaseSync）。
// 职责边界：实现 SqliteDatabase/SqliteExecutor，把同步 API 包成 Promise、串行化操作、管理事务句柄寿命和
// 预编译语句缓存；不做 SQL 生成、不做迁移、不校验查询结果形状。
// 上游：store 层在 Node 运行时调用 openNodeSqliteDatabase(path, options)。下游：Node DatabaseSync 执行 SQL；
// 事务回调收到 NodeSqliteTransaction，数据库方法收到 NodeSqliteDatabase。
// 结果与错误流向：SQL/绑定错误转成 Promise 拒绝；事务失败先回滚再抛原错误，回滚也失败抛 AggregateError；
// close 即使 checkpoint 失败也会关闭连接。
// 能力清单：
// - NodeSqliteDatabaseOptions（类型）：WAL 自动 checkpoint 页数与 busy timeout 选项。
// - openNodeSqliteDatabase（函数）：创建目录、打开连接、设置 PRAGMA，返回适配器。
// - NodeSqliteDatabase（类）：数据库句柄，提供 exec/run/runCounted/get/all/transaction/close。
// （内部）SerialOperationQueue、NodeSqliteExecutor、NodeSqliteTransaction、statement 缓存。
// 组合关系与典型调用顺序：openNodeSqliteDatabase -> 执行操作（空闲立即执行，忙时排队）-> transaction 占队列
// -> 回调使用事务句柄 -> 提交/回滚 -> close 等队列后 checkpoint 并关闭。
// 示例（真实签名）：const db = await openNodeSqliteDatabase("/tmp/app.db", { busyTimeoutMs: 5000 });
// const rows = await db.all<{ id: string }>("SELECT id FROM notes");
// 建议阅读顺序：先 NodeSqliteDatabaseOptions 与 openNodeSqliteDatabase，再看 SerialOperationQueue 的排队规则，
// 然后 NodeSqliteExecutor 的 SQL 方法与语句缓存，接着 transaction，最后 close。

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";

/** Node SQLite connection settings for a database file. */
export type NodeSqliteDatabaseOptions = {
	// ? 表示可以省略；readonly 是开发期只读约束，不会冻结传入的 options。
	/** SQLite WAL auto-checkpoint threshold. SQLite and this adapter default to 1,000 pages; 0 disables it. */
	readonly walAutoCheckpointPages?: number;
	/** Time SQLite waits for a competing file lock. SQLite defaults to 0; this adapter defaults to 5,000 ms. */
	readonly busyTimeoutMs?: number;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// 所有同一事务的句柄共享这个开关；回调结束后即使保存了句柄，也不能继续执行 SQL。
type TransactionScope = { active: boolean };

// 不接收或返回有用值；用作 Promise 成功/失败回调，保证内部队列屏障总能完成。
// 例如失败操作的返回 Promise 仍会拒绝，但 tail 不会把该失败传染给下一操作。
const ignore = (): void => {};

/**
 * Runs operations in call order. An operation starts immediately when nothing is running or waiting;
 * otherwise it waits for everything before it. An asynchronous operation holds the queue until it settles.
 */
class SerialOperationQueue {
	// tail 只表示前面排队工作已结束；pending 计算正在异步执行或已排队的操作数。
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	// 输入同步操作，返回其结果的 Promise；空闲立即执行，忙时排到队尾。
	// 例如空闲时 run(() => 3) 当场计算 3；同步异常转为拒绝，队列本身不记录这个瞬时操作。
	run<T>(operation: () => T): Promise<T> {
		// 已有事务/排队项时不可插队。
		if (this.pending > 0) return this.enqueue(operation);
		try {
			// 同步调用发生在 Promise.resolve 之前，所以外层 try 能捕获调用时的异常。
			return Promise.resolve(operation());
		} catch (error) {
			// 对外统一以 Promise 拒绝交付错误。
			return Promise.reject(error);
		}
	}

	// 输入会跨 await 的操作（这里是事务），返回原结果并在结束时释放队列。
	// 先设屏障再调用 operation，避免其同步阶段发起的外部数据库操作抢先执行。
	// 例如事务等待回调期间，其他 run 均等待它提交/回滚；失败仍通过返回 Promise 传给调用方。
	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		// 从调用前开始占队列，覆盖 operation 的同步阶段。
		this.pending++;
		// Publish the barrier before the operation starts, so calls it makes synchronously wait behind it.
		// 解构时把 promise/resolve 重命名；屏障无业务返回值，所以泛型是 void。
		const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
		// 后来的 enqueue 订阅这个屏障，不能越过当前异步操作。
		this.tail = barrier;
		// let 允许 try/catch 两条路径分别赋值，类型保证后续得到 Promise<T>。
		let started: Promise<T>;
		try {
			// 启动业务操作，不在此等待；finally 负责等它完成后放行。
			started = operation();
		} catch (error) {
			// 即使 operation 在返回 Promise 前抛错，也仍经过下面的统一清理。
			started = Promise.reject(error);
		}
		// finally 不改变正常结果/原异常；它只归还占位并唤醒排队项。
		return started.finally(() => {
			// 已结束一个异步操作。
			this.pending--;
			// 让屏障成功完成，即使业务失败也让队列继续。
			releaseBarrier();
		});
	}

	// 将同步或异步 operation 接到 tail 后，返回自己的 Promise；失败不阻断下一项。
	// 例如队列中有事务时，查询先等待它结束，再执行查询；pending 在 release 中减回去。
	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		// 记录一个等待者。
		this.pending++;
		// then 在屏障完成后调用操作，并自动吸收其 Promise；release 安装清理和新屏障。
		return this.release(this.tail.then(operation));
	}

	// 给已接入队列的 operation 装清理，更新不传播失败的 tail，返回保留结果/错误的 settled。
	// 例如某查询拒绝时，调用方收到拒绝，下一条查询仍能运行；不执行 SQL。
	private release<T>(operation: Promise<T>): Promise<T> {
		// 无论成功失败都减少 pending。
		const settled = operation.finally(() => {
			this.pending--;
		});
		// 两个回调分别处理成功与失败，都把队列尾转为成功的 void Promise。
		this.tail = settled.then(ignore, ignore);
		// 业务调用方拿的仍是自己的结果，错误不会被内部屏障吞掉。
		return settled;
	}
}

/** How many prepared statements one connection keeps. */
const STATEMENT_CACHE_LIMIT = 256;

/**
 * Executes SQL on one connection. Prepared statements are cached per connection by SQL text, so the
 * database and its transaction handles share them across transactions. The cache keeps the
 * `STATEMENT_CACHE_LIMIT` most recently used statements, so callers generating SQL of unbounded shapes
 * cannot grow it without bound.
 */
abstract class NodeSqliteExecutor implements SqliteExecutor {
	// protected 让子类访问；readonly 仅禁止更换字段引用，Map 内容仍会增删。
	protected readonly database: DatabaseSync;
	protected readonly statements: Map<string, StatementSync>;

	// 保存连接及共享语句缓存；例如数据库句柄和同连接事务句柄复用同一个 Map。
	// 构造不执行 SQL，也不复制或校验调用方提供的 Node 对象。
	constructor(database: DatabaseSync, statements: Map<string, StatementSync>) {
		this.database = database;
		this.statements = statements;
	}

	// 输入可含多条语句的 SQL，无绑定/返回行；通过子类的调度规则执行，SQL 错误拒绝。
	// 例如 exec("CREATE TABLE notes(id TEXT)") 会改变数据库结构。
	exec(sql: string): Promise<void> {
		// 箭头回调保留 this，由子类决定立即执行还是等待队列。
		return this.runOperation(() => {
			// Node exec 是同步调用；这里把异常交给 runOperation 转为 Promise 拒绝。
			this.database.exec(sql);
		});
	}

	// 执行一个带位置绑定的写语句，不返回行数；例如 run("DELETE FROM notes WHERE id=?", "n1")。
	// ...params 收集剩余参数为数组，下层展开给 Node；错误由返回 Promise 报告。
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			// 按 SQL 文本获取/准备语句，再把绑定参数逐个传入，忽略写入结果。
			this.statement(sql).run(...params);
		});
	}

	// 与 run 相同，但返回 Node 给出的直接变化行数；例如更新一行得到 1。
	// Number 把 Node 可能返回的 bigint 统一为接口 number；无额外 SELECT。
	runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		return this.runOperation(() => Number(this.statement(sql).run(...params).changes));
	}

	// 查第一行或 undefined；例如 get<{id:string}>("SELECT id FROM notes")。
	// as 是开发期断言，不检查实际列的名字/类型；执行及 SQL 错误沿 Promise 返回。
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => this.statement(sql).get(...params) as T | undefined);
	}

	// 查询全部行，空结果为 []；例如 all<{id:string}>(...) 返回行数组。
	// 泛型只描述预期类型，不做运行时行校验；此处不复制 Node 返回数组。
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement(sql).all(...params) as T[]);
	}

	// abstract 要求具体子类实现：数据库走队列，事务句柄先检查 active 再立即执行。
	protected abstract runOperation<T>(operation: () => T): Promise<T>;

	// 按 SQL 获取预编译语句，未命中则 prepare 并插入缓存；缓存超过 256 删除最早键。
	// 例如相同 SQL 配不同绑定只准备一次；缓存较小时不刷新顺序，所以不声称始终严格 LRU。
	// prepare 的错误向调用方抛出；这里只管理 Map，不执行绑定语句。
	private statement(sql: string): StatementSync {
		// 局部变量仍引用原 Map，不复制缓存。
		const statements = this.statements;
		// 命中已有语句则复用。
		let statement = statements.get(sql);
		if (statement !== undefined) {
			// Recency matters only once evictions come near: a small cache keeps one lookup per statement.
			// 超过半容量才通过删后重插刷新顺序；这是减少小缓存命中成本的既定策略。
			if (statements.size > STATEMENT_CACHE_LIMIT / 2) {
				statements.delete(sql);
				statements.set(sql, statement);
			}
			// 已找到的语句直接返回。
			return statement;
		}
		// 新 SQL 在连接上编译；SQL 无效时此处抛错且不会插入缓存。
		statement = this.database.prepare(sql);
		// 保存以便数据库和事务句柄后续复用。
		statements.set(sql, statement);
		// A Map iterates in insertion order: its first key is the least recently used statement.
		// Map 的首键最早插入；! 是非空断言（此时 size 已超过上限），并非运行时检查。
		if (statements.size > STATEMENT_CACHE_LIMIT) statements.delete(statements.keys().next().value!);
		return statement;
	}
}

class NodeSqliteTransaction extends NodeSqliteExecutor {
	private readonly scope: TransactionScope;

	// 用数据库的同一连接和缓存构造事务句柄，并保存其活动开关；不创建第二连接。
	// 例如一次 transaction 回调收到的就是此句柄，构造本身无 SQL 副作用。
	constructor(database: DatabaseSync, statements: Map<string, StatementSync>, scope: TransactionScope) {
		// super 调用基类构造，必须在子类使用 this 之前执行。
		super(database, statements);
		this.scope = scope;
	}

	// 检查事务句柄寿命后立即执行 operation；async 把结果/同步异常包装为 Promise。
	// 例如回调结束后再 tx.run 会拒绝；无需排数据库队列，当前事务已经占着它。
	protected async runOperation<T>(operation: () => T): Promise<T> {
		// 这是句柄生命周期检查，不是对 TypeScript 已知类型做形状防御。
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		// 当前事务内 SQL 连续执行，不等待外部操作。
		return operation();
	}
}

/** `SqliteDatabase` adapter backed by Node's built-in `node:sqlite`. */
export class NodeSqliteDatabase extends NodeSqliteExecutor implements SqliteDatabase {
	// 每连接一个队列和关闭标记；字段初始化发生在构造时。
	private readonly access = new SerialOperationQueue();
	private closed = false;

	// 接管已有的 Node 连接，并创建专属语句缓存；例如 new NodeSqliteDatabase(rawDb)。
	// 不改 PRAGMA，配置由 openNodeSqliteDatabase 完成。
	constructor(database: DatabaseSync) {
		super(database, new Map());
	}

	// 输入只使用事务句柄的异步回调；BEGIN IMMEDIATE 后等待回调，再提交并返回 T。
	// 失败先失效句柄再回滚，回滚也失败则用 AggregateError 保留两个错误。
	// 例如 transaction(async tx => { await tx.run(...); return 1; }) 提交后得到 1；会改库并占队列。
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		// 整个异步事务占用队列，外部查询、关闭和其他事务都等它完成。
		return this.access.runAsync(async () => {
			// 立即取得写事务；BEGIN 失败在 try 之外，不尝试回滚一个未开始的事务。
			this.database.exec("BEGIN IMMEDIATE");
			// 本事务所有操作共享 active，结束后不再允许通过旧句柄执行。
			const scope = { active: true };
			try {
				// 只等待回调返回的 Promise；调用方必须等待自己发起的事务工作。
				const result = await callback(new NodeSqliteTransaction(this.database, this.statements, scope));
				// 提交前就关掉句柄，防止回调外继续使用。
				scope.active = false;
				// 提交同步成功后才把回调结果交还调用方。
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				// 回调或 COMMIT 抛错都先让句柄失效。
				scope.active = false;
				try {
					// 回滚成功才可以按原错误报告“事务没有提交”。
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					// 回滚失败时结果不确定，合并两次异常，不能伪装成已安全回滚。
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				// 回滚成功，保留原异常对象。
				throw error;
			}
		});
	}

	// 等前面的事务后清缓存、尝试截断 WAL，最后始终关闭连接；重复 close 无操作。
	// 例如 await db.close() 释放文件；checkpoint 抛错仍会 close，错误保持拒绝。
	close(): Promise<void> {
		return this.access.run(() => {
			// 只在本次真正关闭前执行一次清理。
			if (this.closed) return;
			// 先标记关闭，后续 close 不重试连接关闭流程。
			this.closed = true;
			// 去掉预编译语句引用。
			this.statements.clear();
			try {
				// 把 WAL 合并回主文件并尝试截断日志，属于真实数据库 I/O。
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				// finally 确保 checkpoint 失败也释放 Node 连接。
				this.database.close();
			}
		});
	}

	// 给基类 SQL 方法提供连接队列：空闲当场执行，事务运行时等待，不另做 SQL 检查。
	// 例如事务外 get 由这里排队，返回值或错误原样交给调用方。
	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

/** Open and configure a Node-backed SQLite database facade. */
// 输入路径和可省略选项，创建目录/连接后依次设置 WAL、NORMAL 同步和自动 checkpoint。
// 返回可用适配器；配置失败先尝试关闭再抛原错误。例如 ":memory:" 不创建目录。
// 有文件系统与数据库副作用；默认等待锁 5000ms、WAL 每1000页自动 checkpoint，不做额外类型校验。
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteDatabaseOptions = {},
): Promise<NodeSqliteDatabase> {
	// ?? 只在 null/undefined 时选默认值，显式 0（关闭自动 checkpoint）会保留。
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	// 选锁竞争等待时间，传给 Node DatabaseSync 构造器。
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	// 文件数据库递归创建父目录；内存库没有真实路径。
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	// Node 打开/创建数据库；这里抛错发生在 adapter 创建之前。
	const database = new DatabaseSync(path, { timeout });
	// 适配器复用刚打开的同一连接。
	const adapter = new NodeSqliteDatabase(database);
	try {
		// 按顺序设置日志模式；内存数据库实际支持的模式由 SQLite 决定。
		await adapter.exec("PRAGMA journal_mode = WAL");
		// NORMAL 是 WAL 下的同步策略，降低每次提交的同步成本。
		await adapter.exec("PRAGMA synchronous = NORMAL");
		// PRAGMA 的页阈值来自选项；此处没有新增参数合法性验证。
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		// 只有所有配置成功后返回。
		return adapter;
	} catch (error) {
		try {
			// 设置失败尝试回收连接；关闭失败不会取代配置失败。
			await adapter.close();
		} catch {
			// Preserve the configuration failure.
		}
		// 把最初配置错误传回调用方。
		throw error;
	}
}
