// Queries (decision "Query runner"; slice 6a §6, rule 17): `query(Table).where(…).orderBy(…)` as immutable data
// (the condition compiled when given, the order with the key appended as the tie-break), and the opaque cursors that
// continue a page, bound to the table, the order columns and the direction.
// 文件导读
// 所属：packages/chord/src/store（store 层，查询构建与分页游标）。
// 职责边界：构建不可变查询并编译条件/排序；不执行 SQL，不读取行。
// 上游：插件 query(self.table(Def))；下游：TableHandle.page/rows/count 用 condition/order 调 sql.ts；游标由 encode/decodeCursor 处理。
// 能力清单：
// - ColumnRefs：回调收到的列引用映射；
// - query：入口，返回空条件 Query；
// - Query：where/orderBy/order 的不可变链式 API；
// - encodeCursor/decodeCursor：base64url 游标的生成与信任边界校验。
// 组合顺序：query(table) -> where(...) 编译为 WhereNode -> orderBy(...) 限定排序 -> handle.page 读取 -> encodeCursor 续页 -> decodeCursor 校验后继续。
// 示例：const q = query(notes).where((t) => eq(t.id, 1)).orderBy((t) => t.name, "desc"); await table.page(q, 50, ctx)。
// 建议阅读顺序：先看 ColumnRefs/query/Query，再看 order 的全序规则，最后看 cursor 的编码与校验。

import { invalid } from "../data/internal.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { Columns, ColumnTypeOf, ValueOf } from "./columns.ts";
import { type ColumnRef, type Condition, compileWhere, type WhereNode } from "./expression.ts";
import { checkScalar } from "./rows.ts";
import type { Order } from "./sql.ts";
import type { TableDefinition } from "./table.ts";

/** The column references a table's callbacks get: `e.path`, `e.at`. */
export type ColumnRefs<C extends Columns> = {
	readonly [K in keyof C & string]: ColumnRef<ValueOf<C[K]>, ColumnTypeOf<C[K]>>;
};
// 映射类型把每个列名映射成带值类型/列类型的 ColumnRef；回调 (t) => eq(t.id, 1) 因此获得类型提示。

/** A query of `table`: its rows, in key order. */
// 建一个无条件的表查询；示例：query(notes).where((t) => eq(t.id, 1))。查询对象随后交给 table.page/rows。
export function query<C extends Columns, K extends readonly string[]>(table: TableDefinition<C, K>): Query<C, K> {
	return new Query(table, undefined, [], undefined);
}

/**
 * An immutable query of one table: an optional condition (several `where`s are `and`ed) and an order (`orderBy`
 * columns, one direction, the key appended unless already there).
 */
// 不可变查询：每次 where/orderBy 返回新实例，原实例不变；condition 是编译后的 WhereNode，orderBy 保存列名与方向。
export class Query<C extends Columns = Columns, K extends readonly string[] = readonly string[]> {
	readonly table: TableDefinition<C, K>;
	readonly condition: WhereNode | undefined;
	readonly #orderBy: readonly string[];
	readonly #direction: "asc" | "desc" | undefined;

	constructor(
		table: TableDefinition<C, K>,
		condition: WhereNode | undefined,
		orderBy: readonly string[],
		direction: "asc" | "desc" | undefined,
	) {
		// 构造器只保存字段，不执行 SQL；字段通过公开 getter/方法读取。
		this.table = table;
		this.condition = condition;
		this.#orderBy = orderBy;
		this.#direction = direction;
	}

	/** This query with `fn`'s condition too. */
	where(fn: (row: ColumnRefs<C>) => Condition): Query<C, K> {
		// 把回调产生的 Condition 编译成 WhereNode；已有条件用 and 合并；编译失败 invalid/args。
		// 示例：query(notes).where((t) => eq(t.id, 1)).where((t) => gte(t.n, 2)) 得到 and[eq, gte]。
		// The refs are the table's columns, typed by `C`.
		const compiled = compileWhere(this.table, fn(this.table.refs as ColumnRefs<C>), "where");
		// 回调收到 table.refs（列引用对象）；compileWhere 会重新检查列与值。
		const condition = this.condition === undefined ? compiled : { and: [this.condition, compiled] };
		// 多次 where 用逻辑 and 合并，保持调用顺序。
		// 返回新 Query，不修改 this。
		return new Query(this.table, condition, this.#orderBy, this.#direction);
	}

	/**
	 * This query ordered by `fn`'s column next (a non-`opt` `str` or `int` one), in `direction`: one direction per
	 * query, no column twice (`invalid/args`).
	 */
	// 追加排序列并检查方向唯一；orderBy 列必须是非 opt 的 str()/int()，不能重复。
	// 示例：query(notes).orderBy((t) => t.name, desc) 按 name 降序，键列自动补作 tie-break。
	orderBy(
		fn: (row: ColumnRefs<C>) => ColumnRef<unknown, "str" | "int">,
		direction: "asc" | "desc" = "asc",
	): Query<C, K> {
		const table = this.table;
		// The refs are `C`'s columns; what the plugin's callback returns is checked below.
		const ref = fn(table.refs as ColumnRefs<C>) as ColumnRef | undefined;
		// 回调结果在类型上是 ColumnRef，但运行时可能来自 JS；下面按 table.byName 重新验证。
		const column = table.byName.get(ref?.column ?? "");
		if (column === undefined || column.optional || (column.type !== "str" && column.type !== "int")) {
			// 只接受存在的非 opt str/int 列。
			throw invalid("args", `${table.name}: orderBy: expected a non-opt str() or int() column`);
		}
		// 同一列不能重复排序。
		if (this.#orderBy.includes(column.name)) throw invalid("args", `${table.name}: orderBy: "${column.name}" twice`);
		if (this.#direction !== undefined && this.#direction !== direction) {
			// 一个查询只能有一个方向，避免混排产生歧义。
			throw invalid("args", `${table.name}: orderBy: one direction per query`);
		}
		// 记录列名与方向；键列在 order getter 里补作 tie-break。
		return new Query(table, this.condition, [...this.#orderBy, column.name], direction);
	}

	/** The order of its rows: the `orderBy` columns, then the key columns not among them. */
	get order(): Order {
		const columns = [...this.#orderBy, ...this.table.key.filter((column) => !this.#orderBy.includes(column))];
		// order 的列 = 显式 orderBy 列 + 尚未出现的键列，保证分页顺序是全序。
		// 未指定方向默认 asc。
		return { columns, direction: this.#direction ?? "asc" };
	}
}

/** The cursor of the position after a row with the order values `values` in the table named `table` (its SQL name). */
// 把某行的排序值编码成不透明游标：JSON {t:表名,o:排序列,d:方向,v:值} 后 base64url。
// 输入是 SQL 表名、order 与值数组；输出字符串；无 I/O，不检查值是否属于该行。
export function encodeCursor(table: string, order: Order, values: readonly SqliteValue[]): string {
	const json = JSON.stringify({ t: table, o: order.columns, d: order.direction, v: values });
	// 表名用 SQL 名，防止同定义的另一对象表复用游标。
	// TextEncoder 得到 UTF-8 字节，再逐字节转 Latin-1 字符串供 btoa；URL 安全字符替换并去掉填充。
	let binary = "";
	for (const byte of new TextEncoder().encode(json)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The order values of `cursor` (a trust boundary: an app hands it back): one made for `table`'s `order` (any
 * condition) in the table named `sqlName` (another object's table of the same definition is another table), each value
 * of its column's type; `invalid/args` otherwise.
 */
// 校验并解码应用交回的游标；只有与当前表 SQL 名、排序列和方向完全一致的游标才接受。
// 这是信任边界：输入 unknown；每个值按列类型重新校验；任何不符抛 invalid/args。
// 示例：decodeCursor(notesDef, notes, order, encodeCursor(...)) 返回原排序值数组。
export function decodeCursor(table: TableDefinition, sqlName: string, order: Order, cursor: unknown): SqliteValue[] {
	const refuse = (): never => {
		throw invalid("args", `${table.name}: the cursor is not one of this table's order`);
	};
	// refuse 立即抛 invalid/args；返回 never 让控制流分析知道后续不可达。
	if (typeof cursor !== "string") return refuse();
	// 非字符串直接拒绝。
	let decoded: unknown;
	try {
		// 补回 base64 填充/字符；fatal TextDecoder 拒绝非法 UTF-8。
		const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
		decoded = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
		);
	} catch {
		// 任何解码或 JSON 解析错误统一拒绝，不泄漏底层异常。
		return refuse();
	}
	// Wire input: every field is checked below.
	// decoded 可能是任意 JSON；先断言为对象再逐字段检查，这是信任边界。
	const { t, o, d, v } = (decoded ?? {}) as { t?: unknown; o?: unknown; d?: unknown; v?: unknown };
	// 表名/方向/排序列必须匹配；JSON.stringify 比较列数组，简单且对顺序敏感。
	if (t !== sqlName || d !== order.direction || JSON.stringify(o) !== JSON.stringify(order.columns)) refuse();
	// 值数量必须与排序列一致。
	if (!Array.isArray(v) || v.length !== order.columns.length) return refuse();
	// 每个值按对应列类型 checkScalar；列类型在构建查询时已限制为 str/int。
	return order.columns.map((name, index) => {
		const column = table.byName.get(name)!;
		// Order columns are non-opt `str` or `int` (checked when the query was built).
		return checkScalar(column.type as "str" | "int", v[index], `${table.name}: cursor`) as string | number;
	});
}
