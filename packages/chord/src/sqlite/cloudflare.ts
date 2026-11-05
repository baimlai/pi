// 把 Cloudflare Durable Object 的 SQL storage 适配为可移植 SQLite 接口，并按 storage 隔离事务。
// 文件导读
// 所属包与模块：packages/chord/src/sqlite 的 Cloudflare 驱动，基于 Durable Object 的 ctx.storage.sql。
// 职责边界：结构类型描述 storage（不依赖 Workers 类型包）、实现 SqliteDatabase/SqliteExecutor、转换 BLOB/bigint
// 绑定值、按 storage 对象共享串行队列；不打开连接、不管理迁移。
// 上游：store 层在 Durable Object 中构造 DurableObjectSqliteDatabase(storage)。下游：调用 storage.sql.exec 与
// storage.transaction；事务句柄在回调结束后失效。
// 结果与错误流向：SQL/绑定错误以 Promise 拒绝；事务提交/回滚由平台负责；超出安全整数范围的 bigint 在绑定前
// 抛 RangeError；close 只等待队列，不关闭平台 storage。
// 能力清单：
// - DurableObjectSqliteStorage（类型）：适配器使用的最小 storage 结构。
// - DurableObjectSqliteDatabase（类）：数据库句柄，含 exec/run/runCounted/get/all/transaction/close。
// （内部）SerialQueue、storageQueues、bindValue/bind、row、执行器与事务句柄。
// 组合关系与典型调用顺序：new DurableObjectSqliteDatabase(storage) -> 共享队列 -> 普通操作排队 ->
// transaction 用 hold 占住队列 -> 平台事务包裹回调 -> 句柄失效 -> close 等待。
// 示例（真实签名）：const db = new DurableObjectSqliteDatabase(ctx.storage);
// await db.transaction(async (tx) => { await tx.run("DELETE FROM notes WHERE id = ?", id); });
// 建议阅读顺序：先 DurableObjectSqliteStorage 与 bindValue/row 的值边界，再看 SerialQueue 与 queueFor，
// 然后执行器方法，最后事务与 close。

import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";

/** Values a Durable Object SQL binding accepts and returns. */
// 此驱动边界的联合类型不含 bigint/Uint8Array，下面会转换这两种可移植绑定值。
type DurableObjectSqlValue = ArrayBuffer | string | number | null;

/**
 * The parts of a SQLite-backed Durable Object's `ctx.storage` this adapter uses, typed structurally so the package
 * needs no Workers type dependency.
 */
export type DurableObjectSqliteStorage = {
	// 结构类型只要求实际对象有这些成员；无需导入整个 Workers 类型包，也不验证对象形状。
	readonly sql: {
		// 运行 SQL 并返回游标；...bindings 收集位置绑定值。该声明本身不执行 SQL。
		exec(
			query: string,
			...bindings: DurableObjectSqlValue[]
		): {
			// done 区分“还有一行”和“迭代结束”，结束时没有 value；? 表示字段可省略。
			next():
				| { readonly done?: false; readonly value: Record<string, DurableObjectSqlValue> }
				| { readonly done: true; readonly value?: undefined };
			// 消费剩余游标行，返回字段名到 SQL 值的记录数组。
			toArray(): Record<string, DurableObjectSqlValue>[];
		};
	};
	// storage 负责回调成功提交、失败回滚；泛型 T 保留回调返回类型。
	// 示例：const n = await storage.transaction(async () => 1); 回调正常返回时提交。
	transaction<T>(closure: () => Promise<T>): Promise<T>;
};

/** Runs synchronous operations immediately when idle and holds queued calls behind a transaction. */
class SerialQueue {
	// tail 是不传播业务失败的排队屏障；pending 只跟踪经 enqueue 进入的项。
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	// 空闲时立即调用 operation 并统一返回 Promise，忙时排队；同步错误变为拒绝。
	// 例如普通 SQL 在空闲时当场运行；此函数的空闲路径不占队列，事务须使用 hold。
	run<T>(operation: () => T | Promise<T>): Promise<T> {
		// 已有事务或等待者，必须排到它们后面。
		if (this.pending > 0) return this.enqueue(operation);
		try {
			// 先调用再包装；Cloudflare SQL 的同步阶段在此执行。
			return Promise.resolve(operation());
		} catch (error) {
			// 对外仍统一用异步拒绝表达调用错误。
			return Promise.reject(error);
		}
	}

	// 强制把 operation 放进队列，即使空闲也占位到 Promise 结束。
	// 用于事务：例如回调中 await 时，其他普通 SQL 不能越过当前事务；结果/错误原样返回。
	hold<T>(operation: () => Promise<T>): Promise<T> {
		return this.enqueue(operation);
	}

	// 在当前 tail 后启动 operation，清理计数，并创建不会因业务失败而拒绝的新 tail。
	// 例如第一个事务失败时第二个仍执行；调用方拿到的 result 仍保留第一项错误。
	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		// 先占位，后来的操作立刻能看到队列忙。
		this.pending++;
		// then 等前项结束再调用；finally 在成功失败两种情况下释放计数。
		const result = this.tail.then(operation).finally(() => {
			this.pending--;
		});
		// 空回调都返回 undefined，把成功/失败统一为成功屏障，不污染后续项。
		this.tail = result.then(
			() => {},
			() => {},
		);
		// 返回业务自己的结果，不返回吞掉错误的 tail。
		return result;
	}
}

// WeakMap 按底层 storage 对象共享队列；键被回收时不会单靠此表保活 storage。
const storageQueues = new WeakMap<DurableObjectSqliteStorage, SerialQueue>();

// 输入 storage，取得已有队列或首次建立一个；不执行 SQL。
// 例如两个适配器包着同一个 storage，会在同一队列上等待事务，而不是各排各的。
function queueFor(storage: DurableObjectSqliteStorage): SerialQueue {
	// 对象身份是键，相同内容的另一个 storage 对象并不共享队列。
	let queue = storageQueues.get(storage);
	// 只在第一次遇到该对象时分配。
	if (queue === undefined) {
		queue = new SerialQueue();
		// 保存以供该 storage 的后续适配器复用。
		storageQueues.set(storage, queue);
	}
	return queue;
}

/** Durable Object SQL binds numbers as doubles: a `bigint` outside the safe integer range would lose precision. */
// 将一个可移植绑定值变成 DO SQL 支持的值；字节复制成独立 ArrayBuffer，bigint 检查精度后转 number。
// 例如 3n 变成 3，超出安全整数范围抛 RangeError；这是驱动值表示边界，而非检查调用方形状。
function bindValue(value: SqliteValue): DurableObjectSqlValue {
	// slice 只复制 Uint8Array 覆盖的字节，避免把其底层 buffer 的其他片段一起绑定。
	if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer;
	// 联合类型里其余 null/number/string 已被 DO SQL 接受，原样交还。
	if (typeof value !== "bigint") return value;
	// DO 用 double 存数字；拒绝不能精确转换的 bigint，防止悄悄舍入。
	if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`Durable Object SQL cannot bind ${value} without losing precision`);
	}
	// 安全范围内的 bigint 可无损转换。
	return Number(value);
}

// 逐个转换位置参数，返回新数组；例如 [1n, bytes] 对应 [1, ArrayBuffer]。
// map 的回调是上面的 bindValue，任一 bigint 失败会让整个绑定过程抛错，SQL 尚未执行。
const bind = (params: readonly SqliteValue[]): DurableObjectSqlValue[] => params.map(bindValue);

/** A row as returned, with `BLOB` columns converted to `Uint8Array` in place; no other copy is made. */
// 输入驱动给出的行，原地把 ArrayBuffer 列改成字节视图并返回为 T；不检查其他列是否符合 T。
// 例如 {data: buffer} 变为 {data: new Uint8Array(buffer)}，共享同一字节，不再复制整行。
function row<T>(row: Record<string, DurableObjectSqlValue>): T {
	// 遍历驱动返回的字段，逐列检查跨驱动的 BLOB 表示。
	for (const key in row) {
		// 保存当前字段值以便类型收窄。
		const value = row[key];
		// as 允许把列类型改为 Uint8Array；它不会在运行时转换整行或验证 T。
		if (value instanceof ArrayBuffer) (row as Record<string, unknown>)[key] = new Uint8Array(value);
	}
	// 断言只给 TypeScript 提供查询结果类型，返回的仍是传入对象。
	return row as T;
}

/** Executes SQL through `ctx.storage.sql`, which has no separate prepare step. */
class DurableObjectSqliteExecutor implements SqliteExecutor {
	protected readonly storage: DurableObjectSqliteStorage;

	// 保存底层 storage；不创建连接/事务，不检查结构。例如数据库和事务句柄都复用它。
	constructor(storage: DurableObjectSqliteStorage) {
		this.storage = storage;
	}

	// 检查句柄后执行无绑定 SQL（可有多条），无结果；例如 CREATE TABLE 会真实改库。
	// async 把同步驱动异常转为拒绝；数据库子类另负责排队。
	async exec(sql: string): Promise<void> {
		// 事务子类在 check 中拒绝已过期句柄，基础实现为空。
		this.check();
		// 消费执行动作，忽略返回游标。
		this.storage.sql.exec(sql);
	}

	// 输入单条 SQL 和位置值，转换绑定后执行，忽略结果；例如 DELETE ... WHERE id=?。
	// 可能改变数据库；值转换或 SQL 错误由 Promise 拒绝返回。
	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.check();
		// 展开转换后的数组，让每个元素占一个 SQL 位置参数。
		this.storage.sql.exec(sql, ...bind(params));
	}

	// 执行写入后紧接 SELECT changes() 读直接受影响行数；例如删两行返回 2。
	// 不用游标 rowsWritten（含索引计费写入）；多执行一条 SQL，错误沿 Promise 拒绝。
	async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		this.check();
		this.storage.sql.exec(sql, ...bind(params));
		// The cursor's `rowsWritten` is a billing count that includes index writes; SQLite's own count is exact.
		// 两次 exec 之间没有 await，所以当前同步阶段不会让另一条操作插进来覆盖 changes()。
		const counted = this.storage.sql.exec("SELECT changes() AS changes").next();
		// 游标没有行时给 0，否则取别名列并转 number。
		return counted.done ? 0 : Number(counted.value.changes);
	}

	// 查询第一行并转换 BLOB，无行返回 undefined；例如 get<{id:string}>(...)。
	// T 只是预期结果类型，不校验 SQL 返回形状；绑定或执行失败拒绝。
	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.check();
		// 只消费游标第一项。
		const result = this.storage.sql.exec(sql, ...bind(params)).next();
		// done 分支让 TypeScript 知道另一个分支的 value 一定存在。
		return result.done ? undefined : row<T>(result.value);
	}

	// 查询所有行，逐行转换 BLOB 返回 T[]；空结果是 []，SQL/绑定错误拒绝。
	// 例如 all<{data:Uint8Array}>(...) 中 T 不会成为运行时校验器。
	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.check();
		// 链式调用依次执行查询、消费全部行、把每行交给 row；map 创建结果数组。
		return this.storage.sql
			.exec(sql, ...bind(params))
			.toArray()
			.map((value) => row<T>(value));
	}

	/** Throws when this handle may no longer run SQL. */
	// 基类无生命周期限制，所以检查为空；事务子类覆写它。无输入/结果/副作用。
	protected check(): void {}
}

/** The handle a transaction callback receives; invalid once the callback settles. */
class DurableObjectSqliteTransaction extends DurableObjectSqliteExecutor {
	// 这是运行时句柄寿命；storage.transaction 回调退出后关闭。
	active = true;

	// override 表明替换基类 check；过期时抛错，否则 void。例如保存 tx 后延迟使用会失败。
	protected override check(): void {
		if (!this.active) throw new Error("SQLite transaction handle is no longer active");
	}
}

/**
 * `SqliteDatabase` adapter for the SQLite storage of a Cloudflare Durable Object. Adapters given the same storage
 * object share a queue; direct calls to the underlying storage bypass it. Integers are JavaScript numbers; binding a
 * `bigint` outside the safe integer range throws.
 */
export class DurableObjectSqliteDatabase extends DurableObjectSqliteExecutor implements SqliteDatabase {
	private readonly queue: SerialQueue;

	// 保存底层 storage 并取得其共享队列；构造不发 SQL，例如两实例包同一 storage 时串行。
	constructor(storage: DurableObjectSqliteStorage) {
		super(storage);
		// 不为每个适配器建独立队列，否则同一 storage 的事务会被其他实例插入。
		this.queue = queueFor(storage);
	}

	// 对外 exec 先排队再调用基类；例如事务运行时 CREATE TABLE 等它结束，错误仍交给调用方。
	override exec(sql: string): Promise<void> {
		return this.queue.run(() => super.exec(sql));
	}

	// 带绑定的写操作同样经过共享队列；回调调用 super，避免再次进入自身而重复排队。
	// 例如 run("DELETE ... WHERE id=?", id) 在轮到时才执行，返回无值 Promise。
	override run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.queue.run(() => super.run(sql, ...params));
	}

	// 把写入及紧随的 changes() 查询作为一个排队操作，返回其直接影响行数或错误。
	// 例如在其他事务后更新一行得到 1。
	override runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		return this.queue.run(() => super.runCounted(sql, ...params));
	}

	// 排队查询第一行；<T> 传给基类保留调用方声明类型，无行得到 undefined，不新增校验。
	// 例如事务外 get 会等当前事务提交后读取。
	override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.queue.run(() => super.get<T>(sql, ...params));
	}

	// 排队执行基类全行查询，返回转换 BLOB 后的数组；SQL 错误不会阻断后续队列。
	// 例如事务后 all 读取其已提交结果。
	override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.queue.run(() => super.all<T>(sql, ...params));
	}

	/** `ctx.storage.transaction()` commits when the callback resolves and rolls back when it rejects. */
	// 输入异步回调，强制占队列直到 storage 事务结束；返回回调结果 T 或其拒绝。
	// 在 finally 中使句柄失效，提交/回滚由 DO storage 实现，不由此处发 BEGIN/COMMIT。
	// 例如 transaction(async tx => { await tx.run(...); return 1; }) 提交后得到 1。
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		// hold 即使当前空闲也先占位，其他适配器的操作会看到同一个屏障。
		return this.queue.hold(() =>
			// 把用户回调包进平台提供的真实事务。
			this.storage.transaction(async () => {
				// 新句柄直接使用底层 storage，不再走外部队列，避免等自己。
				const transaction = new DurableObjectSqliteTransaction(this.storage);
				try {
					// 必须 await 后再 finally，否则句柄会在用户异步工作结束前失效。
					return await callback(transaction);
				} finally {
					// 成功、失败都不允许回调外继续使用旧句柄。
					transaction.active = false;
				}
			}),
		);
	}

	/** Waits for queued work. The Durable Object owns its storage, so nothing else closes. */
	// 等待此前排队操作，返回 void；不关闭平台 storage，也不永久封禁后续操作。
	// 例如 await db.close() 在这里是一个排队空操作，没有 Node 那样的文件资源清理。
	close(): Promise<void> {
		return this.queue.run(() => {});
	}
}
