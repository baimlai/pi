// Table handles (slice 6a §6; decision "Query runner"): what `self.table(Def)` returns, one per attempt and table: reads
// of committed rows (`page`, `rows`, `get`, `count`) through the store's guarded reads, and what a transaction's
// writes to the table are staged with; a handle of an older version than the stored table is refused (R15, slice 7b).

// 本文件实现 TableHandle：每个 attempt/表一个句柄，提供 page/rows/get/count 四种读操作。
// 所有读取都经 store.read 的守卫（关闭/失败检查与 abort 处理），并复用 definition 编译好的 SQL 与行编解码器。
// 旧版本句柄由 assertVersion 拒绝，避免对已重命名/删除的列发 SQL；读不出的 json 单元格会使 owner 失败。
//
// 能力清单（导出项）：
// - Page<T>：一页读取结果，items 加可选 next 游标。
// - PageOptions：page 的可选参数，目前只有 after 游标。
// - Table<C, K>：对象可见的只读表接口（page/rows/get/count）。
// - TableOf<D>：从表定义类型推导出 Table<C, K>，供 self.table(Def) 的返回类型使用。
// - TableOwner：句柄归属信息（label/scope/assertLive/fail），把读错误报告给对象。
// - ROWS_PAGE：rows() 每页行数，固定 100。
// - TableHandle：Table 的实现，保存定义、预编译 SQL、store 与 owner。
//
// 组合关系：TableHandle.page 用 TableSql 生成语句 → store.read 执行 → RowCodec 解码；
// rows 反复调用 page，get/count 走各自的固定语句；所有公开读先做 owner.assertLive 与版本栅栏。
// 示例：const handle = new TableHandle(Edits, "app.store:edits", store, owner);
//       const page = await handle.page(query(Edits), 50, context);
// 建议阅读顺序：Page/PageOptions → Table → TableOf/TableOwner → TableHandle.page → rows/get/count →
// assertVersion/decode → #assertQuery。

import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { Columns, RowOf } from "./columns.ts";
import { decodeCursor, encodeCursor, type Query } from "./query.ts";
import { TableSql } from "./sql.ts";
import type { ChordStore } from "./store.ts";
import type { KeyOf, TableDefinition } from "./table.ts";

/** One page of rows (`items`, as Durable's pages) and, when more follow, the cursor to continue after it. */
// Page<T> 是一页读取结果：items 为行数组；next 是继续读取的游标，没有更多行时该字段省略。
export type Page<T> = { readonly items: T[]; readonly next?: string };

/** What `page` takes besides the query, the limit and the context. */
// PageOptions 目前只有 after：上一页返回的游标；它绑定同一张表、同一排序与方向。
export type PageOptions = {
	/** A cursor from an earlier page of the same order. */
	readonly after?: string;
};

/** A table of this object: reads of committed state, the context last. Writes go through `self.tx`. */
// Table<C, K> 是对象可见的只读表接口：C 为列类型，K 为主键类型，RowOf<C> 由列推导出行类型。
// 泛型只影响编译期；运行时入参（query、limit、cursor、key）仍由句柄与存储层检查。
export interface Table<C extends Columns, K extends readonly string[]> {
	/** Up to `limit` rows of `q` (after `options.after`), and the cursor of the next page when there is one. */
	// 读至多 limit 行；内部多取 1 行判断是否还有下一页，返回 items 和可选 next 游标。
	page(q: Query<C, K>, limit: number, context: Context, options?: PageOptions): Promise<Page<RowOf<C>>>;
	/** Every row of `q`, read a page of 100 at a time. */
	// 异步迭代全部匹配行，每页固定 ROWS_PAGE 行，自动沿 next 游标前进。
	rows(q: Query<C, K>, context: Context): AsyncIterable<RowOf<C>>;
	/** The row with `key`, `undefined` when absent. */
	// 按主键对象做点查；不存在返回 undefined；主键缺失/多余列由 RowCodec.key 校验。
	get(key: KeyOf<C, K>, context: Context): Promise<RowOf<C> | undefined>;
	/** The number of rows of `q`. */
	// 统计匹配行数；没有匹配时 count(*) 仍返回 0，句柄再用 ?? 0 兜底。
	count(q: Query<C, K>, context: Context): Promise<number>;
}

/** The handle type of table definition `D`: what `self.table(D)` returns. */
// TableOf 用条件类型从 TableDefinition 的泛型参数中提取 C/K；D 不是表定义时得到 never。
// 例如 self.table(Edits) 的返回类型就是 Table<Edits 的列类型, 其主键类型>，调用方无需手写泛型。
export type TableOf<D> = D extends TableDefinition<infer C, infer K> ? Table<C, K> : never;

/** Who owns a table handle: its object (whose transactions alone write it), liveness check and live failure. */
// TableOwner 描述句柄的归属：label 用于错误信息，scope 防止其他对象的事务写这张表，
// assertLive 在对象结束后抛 released，fail 把无法解码的行报告给对象（broken）。
export type TableOwner = {
	readonly label: string;
	/** The object's documents: a transaction of another object refuses the handle. */
	readonly scope: object;
	/** Throws `released` once the object ended. */
	assertLive(): void;
	/** A row the code cannot read (a `json(...)` cell, slice 6a §9) fails the owner `broken` (§1.4). */
	fail(error: ChordError): void;
};

/** The rows `rows()` reads per page (rule 17). */
// rows() 每次读取的行数；固定小页限制单次内存与 SQL 参数规模（rule 17）。
export const ROWS_PAGE = 100;

/** A table handle: the definition the attempt declared, the table's SQL name and statements, the store. */
// TableHandle 实现 Table：保存定义、按 SQL 名预编译的语句、store 与 owner。构造时只编译 SQL，不访问数据库。
export class TableHandle implements Table<Columns, readonly string[]> {
	readonly definition: TableDefinition;
	readonly sql: TableSql;
	readonly store: ChordStore;
	readonly owner: TableOwner;

	// 为一个已确定的表版本建立句柄：sqlName 是 <owner>:<table>，definition 提供列/键/物理列。
	// new TableSql 预先渲染固定语句；不执行查询。
	// 示例：new TableHandle(Edits, "app.store:edits", store, owner)。
	constructor(definition: TableDefinition, sqlName: string, store: ChordStore, owner: TableOwner) {
		this.definition = definition;
		// TableSql 需要 SQL 名、列、物理列与主键；同一句柄的所有读取复用这些字符串。
		this.sql = new TableSql(sqlName, definition.columns, definition.rows.physical, definition.key);
		this.store = store;
		this.owner = owner;
	}

	// 读取 q 的一页：limit 必须为正安全整数；options.after 是上一页游标，解码出排序值后从该位置之后继续。
	// 返回 items 与可选 next。流程：存活/版本/查询归属检查 → 解码游标 → 生成 SELECT（多取 1 行）→
	// store.read → 截断并解码 → 用最后一行编码下一页游标。所有检查错误都在访问后端前抛出。
	async page(q: Query, limit: number, context: Context, options: PageOptions = {}): Promise<Page<RowOf<Columns>>> {
		// 对象已结束则抛 released，避免继续使用失效句柄。
		this.owner.assertLive();
		// 旧句柄在 store 迁移后不可再读，防止引用已不存在的列。
		this.assertVersion();
		// 只允许本定义产生的查询，避免表名/列不匹配。
		this.#assertQuery(q);
		// 分页大小来自插件：必须为正安全整数，否则 SQL LIMIT 会得到意外的 0、小数或溢出。
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw invalid("args", `${this.definition.name}: limit is a positive integer`);
		// Query.order 不可变，构造时已把主键追加为兜底排序列。
		const order = q.order;
		// 游标是不透明字符串，decodeCursor 在信任边界校验并还原为排序值数组；不属于本表/本顺序时抛 invalid/args。
		const after =
			options.after === undefined ? undefined : decodeCursor(this.definition, this.sql.table, order, options.after);
		// limit + 1：多取一行只用于判断是否存在下一页，不返回给调用者。
		const statement = this.sql.select(q.condition, order, after, limit + 1);
		// 读取经过 store 的守卫：store 关闭/失败时拒绝；SQL 错误按存储失败传播。
		const stored = await this.store.read(
			(executor) => executor.all<{ [column: string]: SqliteValue }>(statement.sql, ...statement.params),
			context,
		);
		// 行数超过 limit 说明还有下一页。
		const more = stored.length > limit;
		// 就地截断多取的探测行；数组随后只用于返回项和末行游标。
		if (more) stored.length = limit;
		// 每行按定义解码；无法读取的单元格会失败 owner 并抛出。
		const items = stored.map((row) => this.decode(row, context));
		if (!more) return { items };
		// 取本页最后一行的排序列值作为下一页起点；limit >= 1 且截断后长度等于 limit，保证存在。
		const last = stored[limit - 1]!;
		return {
			items,
			// 游标携带表 SQL 名、排序、方向与值，后续请求据此校验并定位。
			next: encodeCursor(
				this.sql.table,
				order,
				order.columns.map((column) => last[column]!),
			),
		};
	}

	// 异步生成器读取全部匹配行：循环调用 page(q, 100)，用 yield* 逐行产出，再用 next 继续。
	// 示例：for await (const row of table.rows(query(Edits), context)) { ... }。
	async *rows(q: Query, context: Context): AsyncIterable<RowOf<Columns>> {
		let after: string | undefined;
		do {
			// 第一次不带 after；之后传上一页的 next 游标。
			const page = await this.page(q, ROWS_PAGE, context, after === undefined ? {} : { after });
			// yield* 把一页行逐个交给调用者，而不是把整个数组当成一个值。
			yield* page.items;
			after = page.next;
		} while (after !== undefined);
	}

	// 按主键做点查：RowCodec.key 校验 key 恰好包含主键列并编码为参数；不存在返回 undefined。
	// 示例：await table.get({ id: "e001" }, context)。
	async get(key: unknown, context: Context): Promise<RowOf<Columns> | undefined> {
		this.owner.assertLive();
		this.assertVersion();
		// key("get") 同时完成运行时校验（缺列/多列/类型）与参数编码。
		const encoded = this.definition.rows.key(key, "get");
		const stored = await this.store.read(
			(executor) => executor.get<{ [column: string]: SqliteValue }>(this.sql.get, ...encoded.params),
			context,
		);
		// 没有行返回 undefined；有行则解码，解码失败会失败 owner。
		return stored === undefined ? undefined : this.decode(stored, context);
	}

	// 统计 q 匹配的行数：只生成 count(*) 语句，不读取行；结果为空时按 0 处理。
	async count(q: Query, context: Context): Promise<number> {
		this.owner.assertLive();
		this.assertVersion();
		this.#assertQuery(q);
		const statement = this.sql.count(q.condition);
		const row = await this.store.read(
			(executor) => executor.get<{ readonly count: number }>(statement.sql, ...statement.params),
			context,
		);
		// count(*) 正常总返回一行；?. 与 ?? 只是防止读取器返回空。
		return row?.count ?? 0;
	}

	/**
	 * The version fence of old table handles (R15, slice 7b §5): once the store's table is at a newer version than this
	 * handle's definition (a reload's new code migrated it), old code reads and writes it no more (`released/version`),
	 * so it never issues SQL for a dropped column.
	 */
	// 版本栅栏：store 中记录的（或正在迁移到的）表版本高于本句柄定义时，抛 released/version。
	// 这样旧代码不会向已重命名/删除的列发 SQL；store 还没有记录（表尚未创建）时放行。
	assertVersion(): void {
		const stored = this.store.tableVersion(this.sql.table);
		if (stored === undefined || stored <= this.definition.version) return;
		const { name, version } = this.definition;
		const message = `${this.owner.label}: table "${name}" of version ${version}; the store has version ${stored}`;
		throw new ChordError({ code: "released", reason: "version", message });
	}

	/** A stored row as reads return it; one the code cannot read fails the owner and throws. */
	// 把存储行解码为定义对应的行对象；解码失败时统一成 ChordError，先 owner.fail 标记对象 broken，再抛出。
	// 数据本身不修改；失败通常是 json 单元格版本过新、缺少迁移或迁移结果不合法。
	decode(stored: { readonly [column: string]: SqliteValue }, context: Context): RowOf<Columns> {
		try {
			// The codec decodes by the definition's columns: a row of them.
			// RowCodec 按定义列解码；as RowOf<Columns> 只是编译期收窄，运行时不再校验形状。
			return this.definition.rows.decode(stored, context) as RowOf<Columns>;
		} catch (error) {
			// 已是 ChordError 就保留 code/reason；否则包装成 unavailable，并保留原始 cause。
			const failure =
				error instanceof ChordError
					? error
					: new ChordError({ code: "unavailable", message: String(error) }, { cause: error });
			this.owner.fail(failure);
			throw failure;
		}
	}

	/** A query of another table is refused (`invalid/args`). */
	// 校验查询属于本句柄的定义：Query 由 query(Def) 产生，拿错表的查询在生成 SQL 前被拒绝（invalid/args）。
	// 比较的是定义对象身份而不是表名，因此同名的不同定义也不能混用。
	#assertQuery(q: Query): void {
		if (q.table !== this.definition) {
			throw invalid(
				"args",
				`${this.owner.label}: a query of table "${q.table.name}" run on "${this.definition.name}"`,
			);
		}
	}
}
