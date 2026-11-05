// StoreStorage's reads as the store's queries (slice 6b D2, §2.4), compiled once from the store's query vocabulary
// into SQL over the declared tables: no SQL is rendered per call, and a read selects only the record cell (by id, an
// entry's commit seq too; each column returned costs) and parses one JSON text per record, as `SqliteStorage`'s do.

// 文件导读

// 所属：packages/durable/src/storage/store 的读取层，把 StoreStorage 的读请求编译成 Chord store 的 SQL。

// 职责边界：为每张表预编译“按 id 读取”和常见“条件 + 排序”语句，调用时只绑定值；只选 record 单元格

//   （entry 额外选 commit_seq），解析一列 JSON，不做业务校验。它不执行事务，执行器由外部传入。

// 上下游：storage.ts 创建 StorageQueries 并在受保护读中使用；表的列/主键声明来自 tables.ts 与 Chord。

// 结果与错误：返回 RecordRow 或记录数组；SQL/执行错误由执行器 Promise 传播，JSON 解析错误也直接抛出。

// 能力清单：

// - Condition（类型）：[列名, 比较符, 绑定值]，调用点固定条件顺序。

// - TableQueries（类）：byId/select/first/record/records，内部缓存每种查询形状。

// - StorageQueries（类型）：五张表的查询句柄 + latestHead 的两条语句。

// - storageQueries(tables)：根据已声明表创建全部查询。

// 组合顺序：storageQueries(commitTables) -> TableQueries 构造时编译点查 -> select/first 按条件形状惰性编译。

// 示例：const queries = storageQueries(tables);

//   const rows = await queries.tasks.select(executor, [["status", "eq", "running"]], "ascending", 10);

// 阅读顺序：RecordRow/Condition -> TableQueries 构造与形状缓存 -> byId/select/first/record -> storageQueries。

// Chord store 的查询词汇与预编译辅助；Order 决定 SQL ORDER BY，WhereNode 是条件树。
import type { Order, OwnerTable, WhereNode } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import type { CommitTables } from "./commit.ts";

// 查询结果的行形状：record 是 JSON 文本；record$v 是 json 列版本（仅列版本 > 1 时选）；
// commit_seq 只对 entries 表多选一列。
/**
 * A stored row as a query selects it: the record cell, its version (selected only once the column has versions past
 * 1), and an entry's commit seq.
 */
type RecordRow = { readonly record: string; readonly record$v?: number; readonly commit_seq?: number };

// 每个条件带着比较符和值；SQL 形状只由列名与比较符决定，值每次调用重新绑定。
/** One condition of a read: a column, how it compares, its value; a call site keeps one order of them. */
export type Condition = readonly [string, "eq" | "gt" | "lt" | "gte" | "lte", SqliteValue];

// 两种固定排序：按主键 id 升序/降序；Limit 由查询方法另行渲染。
const ASCENDING: Order = { columns: ["id"], direction: "asc" };
const DESCENDING: Order = { columns: ["id"], direction: "desc" };

// 只读 id 的列清单，用于 latestHead 的两条语句。
/** The columns of a read of ids only. */
const ID = ["id"];

// 占位值只用于渲染 SQL 形状；真正绑定的值在 select/first 调用时传入。
/** A placeholder value: a query's shape binds its values at each call. */
const ANY = 0;

/**
 * One table's compiled reads: by id (with the `byIdExtra` columns), and by shape (conditions in binding order, an
 * order; the record only), each shape compiled at its first use.
 // 一张表的预编译读取集合；形状缓存以“方向 + 条件列/比较符”为键。
 */
export class TableQueries {
	// json 列版本 > 1 时需要额外选版本列并调用 reader 解码；版本 1 可直接 JSON.parse。
	readonly #table: OwnerTable;
	// #byId 是构造时编译好的按主键点查；byIdExtra 允许 entries 多选 commit_seq。
	// #columns 是查询应返回的列清单，record 总是在第一列。
	/** The record column's read of a cell at a version past 1; `undefined` while the column is at version 1. */
	readonly #versioned: ((text: string, version: number, context: Context) => unknown) | undefined;
	readonly #byId: string;
	readonly #shapes = new Map<string, string>();
	readonly #columns: readonly string[];

	// 构造：读取 record 列版本，决定是否需要版本列和 reader；然后编译并缓存按 id 点查。
	constructor(table: OwnerTable, byIdExtra: readonly string[] = []) {
		this.#table = table;
		// jsonVersion 读取声明中的版本；> 1 才需要迁移读取。
		const versioned = table.jsonVersion("record") > 1;
		// reader 返回解码函数，参数是单元格文本、版本和 Context。
		this.#versioned = versioned ? table.reader("record") : undefined;
		// 版本 > 1 时同时选 record 和 record$v；row.record$v! 在 record() 中使用。
		this.#columns = versioned ? ["record", "record$v"] : ["record"];
		// prepareGet 按主键绑定顺序生成 SELECT ... WHERE id = ?；额外列追加在 record 后。
		this.#byId = table.prepareGet([...this.#columns, ...byIdExtra]);
	}

	/** The row with `id`, `undefined` when absent. */
	// 按 id 读取一行；executor.get 无结果返回 undefined。
	byId(executor: Pick<SqliteExecutor, "get">, id: number): Promise<RecordRow | undefined> {
		return executor.get<RecordRow>(this.#byId, id);
	}

	/** Up to `limit` rows whose `conditions` hold, by id in `direction`. */
	// 按条件读取多行：SQL 形状由条件列/比较符与方向决定，绑定值按条件顺序展开，最后绑定 limit。
	// conditions.map 只取三元组的第三个元素（值），列名和比较符已进入缓存的 SQL。
	select(
		executor: Pick<SqliteExecutor, "all">,
		conditions: readonly Condition[],
		direction: "ascending" | "descending",
		limit: number,
	): Promise<RecordRow[]> {
		const sql = this.#shape(conditions, direction, "many");
		return executor.all<RecordRow>(sql, ...conditions.map(([, , value]) => value), limit);
	}

	/** The first row whose `conditions` hold, by id in `direction`; `undefined` when none does. */
	// 只取第一个匹配行；prepareFirst 把 LIMIT 写成字面量 1，避免每次多绑一个参数。
	first(
		executor: Pick<SqliteExecutor, "get">,
		conditions: readonly Condition[],
		direction: "ascending" | "descending",
	): Promise<RecordRow | undefined> {
		const sql = this.#shape(conditions, direction, "first");
		return executor.get<RecordRow>(sql, ...conditions.map(([, , value]) => value));
	}

	// 把一行解析成记录：版本 1 直接 JSON.parse；更高版本交给 reader 迁移。
	// row.record$v! 只在该版本列被选中时使用，构造时已保证两者一致。
	/** A row's record, read as its column's (version checked, migrated on access). */
	record<T>(row: RecordRow, context: Context): T {
		const versioned = this.#versioned;
		// The cell holds a record of this table the storage wrote; at version 1 it is that JSON (`OwnerTable.reader`).
		return (versioned === undefined ? JSON.parse(row.record) : versioned(row.record, row.record$v!, context)) as T;
	}

	// 批量解析：版本 1 的循环只有 JSON.parse；版本化列共用同一个 reader，每行检查一次版本。
	/** Appends the records of `rows` to `into`, in order, each read as `record` reads it (one check per call). */
	records<T>(rows: readonly RecordRow[], into: T[], context: Context): void {
		const versioned = this.#versioned;
		if (versioned === undefined) {
			for (const row of rows) into.push(JSON.parse(row.record) as T);
			return;
		}
		for (const row of rows) into.push(versioned(row.record, row.record$v!, context) as T);
	}

	// 查询形状缓存键：行数模式 + 方向 + 每个条件的列与比较符。值不进入键，因此同形状可复用。
	/** The compiled read of a shape: its conditions' columns and comparisons, the direction, one row or many. */
	#shape(conditions: readonly Condition[], direction: "ascending" | "descending", rows: "first" | "many"): string {
		let key = `${rows} ${direction}`;
		for (const [column, condition] of conditions) key += ` ${column} ${condition}`;
		let sql = this.#shapes.get(key);
		if (sql !== undefined) return sql;
		// 把 Condition 三元组转成 Chord 的 WhereNode；值固定为占位 ANY，实际值在调用时绑定。
		// as unknown as WhereNode 是因为对象字面量的键取决于运行时比较符，TS 无法在这里表达动态键。
		// One comparison per condition: the vocabulary's node of that name, its value a placeholder.
		const nodes = conditions.map(([column, condition]) => ({ [condition]: [column, ANY] }) as unknown as WhereNode);
		// 无条件是 undefined（不加 WHERE）；多个条件用 { and: [...] } 组合。
		const where: WhereNode | undefined = nodes.length === 0 ? undefined : { and: nodes };
		const order = direction === "ascending" ? ASCENDING : DESCENDING;
		// first 用 prepareFirst，many 用 prepare；两者只差 LIMIT 的渲染方式。
		sql =
			rows === "first"
				? this.#table.prepareFirst(this.#columns, where, order)
				: this.#table.prepare(this.#columns, where, order);
		this.#shapes.set(key, sql);
		return sql;
	}
}

// 五张表各自的查询句柄，外加最新 head 的两条固定语句。
/** The compiled reads of the storage's tables. */
export type StorageQueries = {
	readonly conversations: TableQueries;
	readonly entries: TableQueries;
	/** The id of a conversation's newest entry with a head marker: any, or at or before an id (bound second). */
	readonly latestHead: { readonly any: string; readonly atOrBefore: string };
	readonly tasks: TableQueries;
	readonly submissions: TableQueries;
};

// 根据已声明的表创建查询：entries 需要 commit_seq，entryHeads 只用于两条 head 语句。
/** The reads of `tables`. */
export function storageQueries(tables: CommitTables): StorageQueries {
	const heads = tables.entryHeads;
	return {
		conversations: new TableQueries(tables.conversations),
		// entries 的按 id 点查会多选 commit_seq，供 Storage.entry 返回提交序号。
		entries: new TableQueries(tables.entries, ["commit_seq"]),
		// latestHead.any 只按 conversation_id 过滤；atOrBefore 再限制 id <= 上界。
		// 两者都按 id 降序取第一条，即“最新”。
		latestHead: {
			any: heads.prepareFirst(ID, { eq: ["conversation_id", ANY] }, DESCENDING),
			atOrBefore: heads.prepareFirst(
				ID,
				{ and: [{ eq: ["conversation_id", ANY] }, { lte: ["id", ANY] }] },
				DESCENDING,
			),
		},
		tasks: new TableQueries(tables.tasks),
		submissions: new TableQueries(tables.submissions),
	};
}
