// The commit step's working state (slice 6a §3, slice 6b §1.3) and the shape every write takes into it: a write staged
// before the queue (serialized, rule 8), applied inside the step, returning the writes it recorded.

// 文件导读
// 所属：packages/chord/src/store（store 层，提交步骤工作区）。
// 职责边界：保存一次提交内的事务句柄、seq、ID 分配器与目录快照，并提供计数 SQL 方法；不开始或提交事务。
// 上游：ChordStore 每次提交构造 Step；StagedWrite.apply(step) 在其中执行 SQL。下游：写入返回 StoreWrite 供 outbox 记录，tables 在提交成功后并入 store 目录，statements 计入 telemetry。
// 能力清单：
// - WriteOrder/StagedWrite：写入阶段（retire/create/write）与 apply 契约；
// - Step：工作区，含 executor/seq/ids/created/tables/statements 字段；
// - table：读取本步骤内最新的表定义；
// - run/runCounted/get/all：计数并转发到事务执行器。
// 组合顺序：new Step(executor,seq,ids,catalog) -> 按阶段调用 stagedWrite.apply(step) -> apply 内用 run/get/all 执行并返回 StoreWrite[] -> 提交成功后 store 接纳 tables。
// 示例：const step = new Step(exec, 7, ids, catalog); await step.run("DELETE ... WHERE id = ?", 4); step.statements 为 1。
// 建议阅读顺序：WriteOrder/StagedWrite -> Step 字段与构造 -> table -> 四个执行方法。

import type { SqliteExecutor, SqliteValue } from "../sqlite/index.ts";
import type { IdAllocator } from "./allocator.ts";
import type { TableRecord } from "./catalog.ts";
import type { StoreWrite } from "./writes.ts";

/**
 * Where a staged write goes in its commit: retirements, creations, then everything else, each phase in staging order.
 * A retirement frees a live address before a creation takes it (the partial unique index); an adapter's composite
 * write orders its own parts inside `write`.
 */
export type WriteOrder = "retire" | "create" | "write";

// 这三个字符串是提交队列用于排序的标签，不是 SQL 指令；先退役才能让同一地址的新文档通过唯一索引。

/** A write staged for the commit step: its order and what it does there, returning the writes as recorded. */
export type StagedWrite = {
	readonly order: WriteOrder;
	/**
	 * Applies the write inside the step's backend transaction; resolves with the writes as the outbox records them, in
	 * the order applied, with what only the step knows resolved (its seq, a record's revision).
	 */
	apply(step: Step): Promise<readonly StoreWrite[]>;
};

// 方法签名只描述契约：apply 在已有事务内完成 I/O，返回已解析 ID/序号等字段的记录供 outbox 保存；
// readonly 数组限制 TS 调用者修改，不能让函数自动执行，也不能验证归档读来的写入。

/**
 * One commit step: its backend transaction, its seq, the store's id allocator (D3: ids are taken from it as the
 * writes apply, never copied), the ids of the documents it created, the table records it changed (the store's catalog
 * takes them after `COMMIT`) and the statements it ran (`chord.store.statements`). Its reads are the step reader of
 * adapters: they see the step's own writes.
 */
export class Step {
	readonly executor: SqliteExecutor;
	readonly seq: number;
	readonly ids: IdAllocator;
	/** The ids of the commit's created documents, in the order of their writes. */
	readonly created: number[] = [];
	/** The table records this step changed, by SQL name. */
	readonly tables = new Map<string, TableRecord>();
	readonly #catalog: ReadonlyMap<string, TableRecord>;
	// statements 是本步骤发起的 SQL 操作数，不等于底层驱动真正执行的全部内部语句数。
	statements = 0;

	// 组装一次提交的工作上下文：保存事务执行器、seq、共享 ID 分配器及已提交目录，不执行 SQL；例如新建 Step 后 created/tables 为空，后续写入逐项填充。
	constructor(executor: SqliteExecutor, seq: number, ids: IdAllocator, catalog: ReadonlyMap<string, TableRecord>) {
		// 保存事务句柄；本步骤的所有 SQL 都必须使用它，避免在事务中等待数据库本体而互相阻塞。
		this.executor = executor;
		// seq 已由 store 决定；Step 不自行递增 store 的提交序号。
		this.seq = seq;
		// 保留共享分配器对象，因此步骤内取号和其他同步 mint 使用同一水位。
		this.ids = ids;
		// 旧目录按只读约定引用；步骤中的更改另外写入 this.tables，提交成功后才由 store 接纳。
		this.#catalog = catalog;
	}

	/** The record of table `name` as this step leaves it so far. */
	// 查看本次步骤最新表定义，优先查步骤更改，再查已提交目录；例如先增加列后，同一步骤后续写入会看到新列。未找到返回 undefined，无 I/O。
	table(name: string): TableRecord | undefined {
		// ?? 只在前者是 null/undefined 时取后者，不会因空字符串或其他假值而回退。
		return this.tables.get(name) ?? this.#catalog.get(name);
	}

	/** Runs one statement. */
	// 记一次语句调用并在当前 SQL 事务中执行，参数通过剩余参数转发；例如 run("DELETE … WHERE id=?", 4)。返回驱动 Promise，失败也已计入调用数。
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		// ++ 在调用驱动前计数，表示尝试发起的语句，拒绝时不撤销这个数。
		this.statements++;
		// ...params 在调用处把数组摊为位置参数；不把值拼进 SQL 文本。
		return this.executor.run(sql, ...params);
	}

	/** Runs one statement and resolves with the rows it changed. */
	// 执行需要受影响行数的写语句并计数；例如按 revision 条件更新文档后返回 1 或 0，让调用者检查冲突。驱动错误通过返回 Promise 传播，不在此转换。
	runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		// 这里只计一次 facade 调用，某驱动为获取 changes() 额外做的工作不在本计数中展开。
		this.statements++;
		// 直接转发结果；Step 不自行判断期望行数。
		return this.executor.runCounted(sql, ...params);
	}

	/** Runs one query for its first row. */
	// 计数并读取第一行，缺少行时返回 undefined；例如 get<{id:number}>(sql) 的泛型只给 TS 描述行类型，不做数据校验。查询在事务中可看到本步骤先前的写入。
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		// T extends object 限制声明的行类型是对象；这里只推进语句计数。
		this.statements++;
		// 将同一个泛型 T 传给执行器，避免丢掉调用者的行字段类型。
		return this.executor.get<T>(sql, ...params);
	}

	/** Runs one query. */
	// 计数并读取全部匹配行，空结果为 []；例如读取一页迁移记录，返回 T[]。无额外复制/校验，SQL 或驱动错误按 Promise 拒绝交回调用者。
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		// 一个 all 调用计一次，与返回多少行无关。
		this.statements++;
		// 执行器负责绑定和构造行数组，Step 不在结果上再做遍历。
		return this.executor.all<T>(sql, ...params);
	}
}
