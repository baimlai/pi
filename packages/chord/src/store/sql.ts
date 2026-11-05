// SQL of declared tables (slice 6a §5, §6, §7): the DDL a table definition renders, and the statements of its reads
// and writes, generated from the compiled vocabulary with every value bound and every identifier quoted. Names were
// checked at declaration (and at import), so no `"` occurs in them and quoting is always safe.

// 文件导读
// 所属：packages/chord/src/store（store 层，声明表的 SQL 渲染）。
// 职责边界：把表定义与编译后的 WhereNode/SetNode/Order 渲染成带绑定参数的 SQL；不执行 SQL，不决定事务。
// 上游：TableDefinition/RowCodec 提供列与物理顺序，表句柄构造 TableSql。下游：Step/executor 执行返回的 Statement；DDL 用于建表/迁移，SQL 与 evaluate.ts 必须语义一致。
// 能力清单：
// - Statement/Order：语句+参数、排序描述；
// - quote/tableSqlName：标识符与 SQL 表名；
// - createTableSql/columnSql/literal：声明表的 DDL；
// - recordedPut/putSql：整行 INSERT OR REPLACE；
// - createIndexSql/dropIndexSql：索引 DDL；
// - TableSql：一个表版本的固定语句与按条件生成的语句；
// - setSql/exprSql/whereSql/COMPARISONS：编译词汇的渲染。
// 组合顺序：声明时 createTableSql/createIndexSql；表句柄构造 TableSql；读写时 update/select/count -> whereSql/setSql -> Statement -> executor。
// 示例：select(undefined, { columns: ["id"], direction: "asc" }, undefined, 50) 返回 { sql: "SELECT ... ORDER BY "id" ASC LIMIT ?", params: [50] }。
// 建议阅读顺序：Statement/Order -> quote/tableSqlName -> DDL 函数 -> TableSql -> setSql/exprSql -> whereSql。
import type { SqliteValue } from "../sqlite/index.ts";
import type { Column, ColumnRecord } from "./columns.ts";
import type { ExprNode, SetNode, WhereNode } from "./expression.ts";
import { physicalColumns, ROW_VERSION, toSqlite, versionColumn } from "./rows.ts";
import { prefixUpperBound } from "./text.ts";

/** A statement and its parameters. */
// 一条语句与其绑定参数；调用者按占位符顺序传参，不做字符串插值。
export type Statement = { readonly sql: string; readonly params: SqliteValue[] };

/** An order of rows: the order columns (the key appended as the tie-break) and one direction. */
// 排序描述；列里已包含键列，保证分页顺序是全序。
export type Order = { readonly columns: readonly string[]; readonly direction: "asc" | "desc" };

/** A quoted SQL identifier. */
// 用双引号包住标识符；列名已在声明/导入时限制为 ASCII，无需再转义引号。
export function quote(name: string): string {
	return `"${name}"`;
}

/** The SQL name of an owner's table: `<owner>:<table>` (R2), injective since neither part contains `:`. */
// owner 与 table 都不含冒号（声明规则），拼接结果唯一；同名对象因此各有一张 SQL 表。
export function tableSqlName(owner: string, table: string): string {
	return `${owner}:${table}`;
}

/**
 * `CREATE TABLE` for `columns` (as recorded) and `key`: `STRICT`, the key as primary key (`WITHOUT ROWID`, except
 * for a single `int` key, which becomes the rowid: the fastest point lookups, and rows of any size), an `int`
 * column checked within ±(2^53 - 1) (rule 10), a `bool` one within 0 and 1, a `json(...)` one as `TEXT` with its
 * version column, and the row's `$v`.
 */
// 生成声明表的 CREATE TABLE：STRICT、主键、类型约束、json 版本列与整行版本列。
// 输入是 SQL 表名、持久列记录与键列；输出 DDL 文本；无 I/O。
// 示例：createTableSql("o:notes", { id: { type: "int" } }, ["id"]) 的表键是 id，且 README 的 rowid 优化生效。
export function createTableSql(
	table: string,
	columns: { readonly [name: string]: ColumnRecord },
	key: readonly string[],
): string {
	// 每列渲染一条或多条定义；json 列会额外生成版本列。
	const definitions = Object.entries(columns).flatMap(([name, column]) => columnSql(name, column));
	// 整行 eager 迁移版本列，所有声明表都有。
	definitions.push(`${quote(ROW_VERSION)} INTEGER NOT NULL`);
	// 主键列顺序与声明键一致，读写条件也按这个顺序。
	definitions.push(`PRIMARY KEY (${key.map(quote).join(", ")})`);
	// 单个 int 键可直接作为 rowid，省一次索引；其它键必须 WITHOUT ROWID。
	const rowid = key.length === 1 && columns[key[0]!]!.type === "int";
	return `CREATE TABLE ${quote(table)} (${definitions.join(", ")}) STRICT${rowid ? "" : ", WITHOUT ROWID"}`;
}

// 安全整数上界；DDL 用它生成 int 列的 CHECK。
const SAFE = Number.MAX_SAFE_INTEGER;

/** The definitions of one column: itself, and a `json(...)` column's version column. */
// 渲染单列定义（json 列返回两行）；输入列名与持久记录，输出 DDL 片段；无 I/O。
export function columnSql(name: string, column: ColumnRecord): string[] {
	// NOT NULL 与 DEFAULT 只能是 DDL 文本，不能绑定参数；default 已在声明期检查。
	const nullability = column.optional ? "" : " NOT NULL";
	// 只有声明了默认值才写 DEFAULT。
	const defaulted = column.default === undefined ? "" : ` DEFAULT ${literal(column.default)}`;
	const id = quote(name);
	// 每种存储类型映射到 SQLite 类型与范围约束。
	switch (column.type) {
		case "str":
			return [`${id} TEXT${nullability}${defaulted}`];
		// int 用 CHECK 锁在安全整数范围；bool 用 CHECK 限于 0/1；json 存 TEXT 加版本列。
		case "int":
			return [`${id} INTEGER${nullability}${defaulted} CHECK (${id} BETWEEN ${-SAFE} AND ${SAFE})`];
		case "num":
			return [`${id} REAL${nullability}${defaulted}`];
		case "bool":
			return [`${id} INTEGER${nullability}${defaulted} CHECK (${id} IN (0, 1))`];
		case "json":
			return [`${id} TEXT${nullability}`, `${quote(versionColumn(name))} INTEGER${nullability}`];
	}
}

/** A default as a SQL literal: declaration data (checked), which DDL cannot bind. */
// 把声明期默认值渲染成 SQL 字面量：字符串单引号加倍，布尔转 1/0，数字转文本。
function literal(value: string | number | boolean): string {
	if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
	return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}

/**
 * The physical columns of a recorded table in the order `RowCodec.physical` uses (`physicalColumns`), and its
 * whole-row `INSERT OR REPLACE` over them.
 */
// 从持久列记录重建物理列顺序，并生成整行 INSERT OR REPLACE；输入表名与列记录，输出列序与 SQL。
export function recordedPut(
	table: string,
	columns: { readonly [name: string]: ColumnRecord },
): { readonly physical: readonly string[]; readonly sql: string } {
	// 用与 RowCodec 相同的 physicalColumns，保证参数顺序一致。
	const physical = physicalColumns(Object.entries(columns).map(([name, { type }]) => ({ name, type })));
	return { physical, sql: putSql(table, physical) };
}

/** `INSERT OR REPLACE` of a whole row over `physical` (`put` is an upsert). */
// 所有值都是 ? 占位符，执行时绑定；put 是 upsert。
function putSql(table: string, physical: readonly string[]): string {
	return `INSERT OR REPLACE INTO ${quote(table)} (${physical.map(quote).join(", ")}) VALUES (${physical.map(() => "?").join(", ")})`;
}

/** `CREATE INDEX` named `<table>:<index>` over `columns`, the key appended (every index ends with it). */
// 创建名为 <table>:<index> 的索引；索引列后自动追加尚未出现的键列，保证全序。
export function createIndexSql(
	table: string,
	index: string,
	columns: readonly string[],
	key: readonly string[],
): string {
	// 去重追加键列：索引列序是确定的。
	const all = [...columns, ...key.filter((column) => !columns.includes(column))];
	return `CREATE INDEX ${quote(`${table}:${index}`)} ON ${quote(table)} (${all.map(quote).join(", ")})`;
}

/** `DROP INDEX` of `<table>:<index>`. */
// 删除同名索引；只拼接受过声明的标识符。
export function dropIndexSql(table: string, index: string): string {
	return `DROP INDEX ${quote(`${table}:${index}`)}`;
}

/**
 * The statements of one table at one version, rendered once per table handle: the fixed ones as texts, the ones
 * over compiled conditions and `set`s on demand.
 */
// 一个表版本的 SQL 视图：固定语句在构造时渲染一次，条件语句按调用参数生成。
// 表句柄持有一个实例；它不执行 SQL，只提供 Statement。
export class TableSql {
	// SQL 表名（含 owner 前缀）。
	readonly table: string;
	/** The columns a read selects: the declared ones and each `json(...)` column's version. */
	// 读取列列表：声明列 + 每个 json 列的版本列。
	readonly #select: string;
	// 主键等值条件，按声明键顺序生成。
	readonly #byKey: string;
	/** `INSERT OR REPLACE` of a whole row, in `RowCodec.physical`'s order (`put` is an upsert). */
	// 固定语句构造时生成一次，避免每次读写重复拼接。
	readonly put: string;
	// 按主键读取整行。
	readonly get: string;
	// 按主键删除。
	readonly delete: string;

	// 保存表名并预渲染 put/get/delete 与列列表；不做 I/O。
	constructor(
		table: string,
		columns: readonly Pick<Column, "name" | "type">[],
		physical: readonly string[],
		key: readonly string[],
	) {
		// 带引号的表名在下面各语句中复用。
		this.table = table;
		// 预先引用表名，减少重复调用。
		const id = quote(table);
		// 声明列 + json 版本列，顺序与 RowCodec.decode 的读取假设一致。
		this.#select = [
			...columns.map(({ name }) => quote(name)),
			...columns.filter(({ type }) => type === "json").map(({ name }) => quote(versionColumn(name))),
		].join(", ");
		// 键条件用 AND 连接；参数顺序就是键列顺序。
		this.#byKey = key.map((column) => `${quote(column)} = ?`).join(" AND ");
		// put 使用 RowCodec.physical 的顺序，参数由调用者按同一顺序绑定。
		this.put = putSql(table, physical);
		this.get = `SELECT ${this.#select} FROM ${id} WHERE ${this.#byKey}`;
		this.delete = `DELETE FROM ${id} WHERE ${this.#byKey}`;
	}

	/** `SELECT` of `columns` of one row by key: a point lookup, without the `ORDER BY` and `LIMIT` of a page. */
	// 按主键只取指定列的 SELECT；调用者负责给出已检查的列名。
	getColumns(columns: readonly string[]): string {
		return `SELECT ${columns.map(quote).join(", ")} FROM ${quote(this.table)} WHERE ${this.#byKey}`;
	}

	/** `UPDATE` of one row by key; `versions` gives each `json(...)` column's version to stamp. */
	// 按主键更新一行；json 列写入时同时更新版本列，参数顺序先 SET 后 WHERE。
	update(set: SetNode, key: readonly SqliteValue[], versions: ReadonlyMap<string, number>): Statement {
		const params: SqliteValue[] = [];
		const assignments = setSql(set, versions, params);
		params.push(...key);
		return { sql: `UPDATE ${quote(this.table)} SET ${assignments} WHERE ${this.#byKey}`, params };
	}

	/** `UPDATE` of every row matching `where`. */
	// 更新所有匹配行；SET 参数在前，WHERE 参数在后。
	updateWhere(where: WhereNode, set: SetNode, versions: ReadonlyMap<string, number>): Statement {
		const params: SqliteValue[] = [];
		const assignments = setSql(set, versions, params);
		const condition = whereSql(where, params);
		return { sql: `UPDATE ${quote(this.table)} SET ${assignments} WHERE ${condition}`, params };
	}

	/** `DELETE` of every row matching `where`. */
	// 删除所有匹配行；只有 WHERE 参数。
	deleteWhere(where: WhereNode): Statement {
		const params: SqliteValue[] = [];
		return { sql: `DELETE FROM ${quote(this.table)} WHERE ${whereSql(where, params)}`, params };
	}

	/**
	 * A page: rows matching `where` in `order`, after the order values `after` (row-value comparison; the key in the
	 * order makes it total), at most `limit` (bound); every column, or only `columns`.
	 */
	// 生成一页查询：可选条件 + 游标后的行值比较 + 排序 + LIMIT，全部值绑定。
	// 输入 where/order/after/limit/可选列；输出 Statement；不执行。
	// 示例：after=[1] 表示取排序值在 (1) 之后的行；direction 决定 > 还是 <。
	select(
		where: WhereNode | undefined,
		order: Order,
		after: readonly SqliteValue[] | undefined,
		limit: number,
		columns?: readonly string[],
	): Statement {
		// 参数按 SQL 中 ? 出现的顺序推入。
		const params: SqliteValue[] = [];
		const conditions: string[] = [];
		// 可选条件与游标条件用 AND 组合。
		if (where !== undefined) conditions.push(whereSql(where, params));
		// 行值比较实现续页；键在 order 中使比较成为全序。
		if (after !== undefined) {
			const columns = order.columns.map(quote).join(", ");
			conditions.push(`(${columns}) ${order.direction === "asc" ? ">" : "<"} (${after.map(() => "?").join(", ")})`);
			params.push(...after);
		}
		// 没有条件时不生成 WHERE。
		const filter = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
		// 所有排序列共用一个方向。
		const direction = order.direction === "asc" ? "ASC" : "DESC";
		// ORDER BY 与游标比较使用同一列序。
		const sorting = order.columns.map((column) => `${quote(column)} ${direction}`).join(", ");
		// LIMIT 也绑定参数，避免拼接数字。
		params.push(limit);
		// 默认整行列；指定列时只选调用者给的列。
		const select = columns === undefined ? this.#select : columns.map(quote).join(", ");
		return { sql: `SELECT ${select} FROM ${quote(this.table)}${filter} ORDER BY ${sorting} LIMIT ?`, params };
	}

	/** `count(*)` of the rows matching `where`. */
	// count(*) 查询；where 为空时统计全表。
	count(where: WhereNode | undefined): Statement {
		const params: SqliteValue[] = [];
		// count 只需要 WHERE，不需要排序或 LIMIT。
		const filter = where === undefined ? "" : ` WHERE ${whereSql(where, params)}`;
		return { sql: `SELECT count(*) AS count FROM ${quote(this.table)}${filter}`, params };
	}
}

/** The assignments of `set`; a written `json(...)` column also stamps its version (a clear stamps `NULL`). */
// 渲染 SET 赋值列表；json 列写入时额外绑定版本参数。
function setSql(set: SetNode, versions: ReadonlyMap<string, number>, params: SqliteValue[]): string {
	const assignments: string[] = [];
	// 每列一个 assignment；列名已由 compileSet 检查。
	for (const [column, node] of Object.entries(set)) {
		assignments.push(`${quote(column)} = ${exprSql(node, params)}`);
		// versions 只含被写入的 json 列；清除（null 节点）时版本写 NULL。
		const version = versions.get(column);
		if (version !== undefined) {
			assignments.push(`${quote(versionColumn(column))} = ?`);
			params.push(node === null ? null : version);
		}
	}
	return assignments.join(", ");
}

// 递归渲染值表达式；字面量进入 params，返回 ? 或 SQL 表达式片段。
// 例如 { col: "n" } -> "n"，标量 2 -> "?" 并追加 2。
function exprSql(node: ExprNode, params: SqliteValue[]): string {
	// null 节点渲染为 SQL NULL。
	if (node === null) return "NULL";
	// 标量字面量绑定参数，不拼进 SQL 文本。
	if (typeof node !== "object") {
		params.push(toSqlite(node));
		return "?";
	}
	// 列引用只引用 compileSet 已检查的列名。
	if ("col" in node) return quote(node.col);
	// JSON 在暂存时已序列化一次；这里只绑定文本。
	if ("json" in node) {
		// Serialized once at staging already (rule 8): this cannot throw.
		params.push(JSON.stringify(node.json));
		return "?";
	}
	// when 渲染为 CASE WHEN。
	if ("when" in node) {
		const [condition, a, b] = node.when;
		return `(CASE WHEN ${whereSql(condition, params)} THEN ${exprSql(a, params)} ELSE ${exprSql(b, params)} END)`;
	}
	// replacePrefix 展开为 CASE + substr；参数顺序必须与 ? 出现顺序一致。
	if ("replacePrefix" in node) {
		const [subject, from, to] = node.replacePrefix;
		const length = [...from].length;
		// SQLite's `substr` counts characters of UTF-8 text: code points, as the prefix's length does.
		// Parameters in the order their `?` occur in the text.
		// substr 按码点计数；from 的长度用展开运算符取码点数。
		const value = exprSql(subject, params);
		// 第一组参数：长度、from、to，对应下面的三个 ?。
		params.push(length, from, to);
		const rest = exprSql(subject, params);
		// 第二组：substr 的起始位置（1 基）。
		params.push(length + 1);
		const unchanged = exprSql(subject, params);
		return `(CASE WHEN substr(${value}, 1, ?) = ? THEN ? || substr(${rest}, ?) ELSE ${unchanged} END)`;
	}
	// coalesce 直接映射到 SQLite 的 coalesce()。
	if ("coalesce" in node)
		return `coalesce(${exprSql(node.coalesce[0], params)}, ${exprSql(node.coalesce[1], params)})`;
	// 其余二元运算直接映射到 SQLite 运算符/函数。
	if ("add" in node) return `(${exprSql(node.add[0], params)} + ${exprSql(node.add[1], params)})`;
	if ("sub" in node) return `(${exprSql(node.sub[0], params)} - ${exprSql(node.sub[1], params)})`;
	if ("max" in node) return `max(${exprSql(node.max[0], params)}, ${exprSql(node.max[1], params)})`;
	if ("min" in node) return `min(${exprSql(node.min[0], params)}, ${exprSql(node.min[1], params)})`;
	return `(${exprSql(node.concat[0], params)} || ${exprSql(node.concat[1], params)})`;
}

// 编译词汇到 SQL 比较符的固定映射；as const 保留键联合供类型收窄。
const COMPARISONS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/** A condition with its operands bound; SQL's `NULL` rules are the vocabulary's. */
// 递归渲染条件；值推入 params，返回 SQL 片段；不执行。
// 语义必须与 evaluate.ts 的三值逻辑一致：NULL 比较不命中，空 and 为真、空 or 为假。
export function whereSql(node: WhereNode, params: SqliteValue[]): string {
	// 空 and 渲染为 1（恒真），与求值器一致。
	if ("and" in node)
		return node.and.length === 0 ? "1" : `(${node.and.map((each) => whereSql(each, params)).join(" AND ")})`;
	// 空 or 渲染为 0（恒假）。
	if ("or" in node)
		return node.or.length === 0 ? "0" : `(${node.or.map((each) => whereSql(each, params)).join(" OR ")})`;
	// not 保留三值：NULL 取反仍为 NULL。
	if ("not" in node) return `(NOT ${whereSql(node.not, params)})`;
	// isNull 只判断列是否 NULL。
	if ("isNull" in node) return `${quote(node.isNull)} IS NULL`;
	// 数组编码为 JSON 一次绑定，再用 json_each 展开，避免动态占位符数量。
	if ("inArray" in node) {
		const [column, values] = node.inArray;
		params.push(JSON.stringify(values.map(toSqlite)));
		return `${quote(column)} IN (SELECT value FROM json_each(?))`;
	}
	// 前缀范围查询 [prefix, upperBound)；没有有限上界时只做 >=。
	if ("prefix" in node) {
		const [column, prefix] = node.prefix;
		const upper = prefixUpperBound(prefix);
		params.push(prefix);
		// 全最大码点前缀没有上界，只需下界。
		if (upper === undefined) return `${quote(column)} >= ?`;
		params.push(upper);
		return `(${quote(column)} >= ? AND ${quote(column)} < ?)`;
	}
	// The remaining nodes are the comparisons, one entry each; `Object.entries` loses that.
	// 剩余是比较节点；每节点恰有一个键，解构出运算符、列与值。
	const [op, [column, value]] = Object.entries(node)[0] as [
		keyof typeof COMPARISONS,
		readonly [string, string | number | boolean],
	];
	// 比较值先转 SQLite 标量（布尔 0/1）再绑定。
	params.push(toSqlite(value));
	return `${quote(column)} ${COMPARISONS[op]} ?`;
}
