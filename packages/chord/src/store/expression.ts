// The table expression language (slice 6a §6, §7; rules 10, 13, 14, 16; decision "Nullable columns and the `set`
// form"): the builders plugins write `where` and `set` with, and their compilation at staging into one data-only
// vocabulary (what the outbox and archives carry; `evaluate.ts` runs it in JavaScript, `sql.ts` renders it).

// 文件导读
// 所属：packages/chord/src/store（store 层，表条件/值表达式语言）。
// 职责边界：提供插件构造 where/set 的构建器，并在暂存时编译成纯数据节点；不执行查询、不访问数据库。
// 上游：插件用 (t) => eq(t.id, 1) 写条件、tx.put/update 传 set；compileWhere/compileSet 在写入与查询构造时调用。下游：WhereNode/ExprNode 交给 evaluate.ts（overlay）与 sql.ts（SQL）；outbox/归档保存这些节点。
// 能力清单：
// - WhereNode/ExprNode/SetNode/Comparison/Operation：编译后的数据词汇；
// - Expression/ColumnRef/Condition：插件侧的构建对象；
// - SetOf/ScalarType/Operand：类型映射；
// - eq/ne/lt/lte/gt/gte/inArray/isNull/prefix/and/or/not：条件构建器；
// - add/sub/max/min/concat/replacePrefix/coalesce/when：值表达式构建器；
// - columnRefs/compileWhere/compileSet/compileExpr/scalarColumn/operand：列引用与编译检查。
// 组合顺序：columnRefs 生成 t.xxx -> 构建器产出 Condition/Expression -> compileWhere/compileSet 检查列与值并生成节点 -> evaluate/sql 消费。
// 示例：const node = compileWhere(notes, eq(notes.refs.id, 1), "where"); 得到 { eq: ["id", 1] }，不访问数据库。
// 建议阅读顺序：WhereNode/ExprNode/SetNode -> Expression/ColumnRef/Condition -> 构建器 -> SetOf -> columnRefs/compileWhere/compileSet/compileExpr。
import type { Optional } from "../contracts/index.ts";
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { Column, Columns, ColumnType, ColumnTypeOf, ValueOf } from "./columns.ts";
import { checkScalar, encodeCell, type Scalar } from "./rows.ts";
import type { TableDefinition } from "./table.ts";

/** A compiled condition: column comparisons with checked operands, combined by `and`, `or`, `not`. */
// 编译后的条件节点：只含列名与已检查的操作数，可被 evaluate/SQL 共同解释。
export type WhereNode =
	| { readonly eq: readonly [string, Scalar] }
	| { readonly ne: readonly [string, Scalar] }
	| { readonly lt: readonly [string, Scalar] }
	| { readonly lte: readonly [string, Scalar] }
	| { readonly gt: readonly [string, Scalar] }
	| { readonly gte: readonly [string, Scalar] }
	| { readonly inArray: readonly [string, readonly Scalar[]] }
	| { readonly isNull: string }
	| { readonly prefix: readonly [string, string] }
	| { readonly and: readonly WhereNode[] }
	| { readonly or: readonly WhereNode[] }
	| { readonly not: WhereNode };

/** A compiled value expression: a literal (`null` clears), a column, a `json(...)` cell, or an operation. */
// 编译后的值表达式：标量/null/列引用/JSON 值以及各类二元运算与 when。
export type ExprNode =
	| Scalar
	| null
	| { readonly col: string }
	| { readonly json: JsonValue }
	| { readonly add: readonly [ExprNode, ExprNode] }
	| { readonly sub: readonly [ExprNode, ExprNode] }
	| { readonly max: readonly [ExprNode, ExprNode] }
	| { readonly min: readonly [ExprNode, ExprNode] }
	| { readonly concat: readonly [ExprNode, ExprNode] }
	| { readonly coalesce: readonly [ExprNode, ExprNode] }
	| { readonly replacePrefix: readonly [ExprNode, string, string] }
	| { readonly when: readonly [WhereNode, ExprNode, ExprNode] };

/** A compiled `set`: the new value of each changed column, every right side evaluated against the row before. */
// set 的编译结果：列名到表达式；所有右侧都基于更新前的行求值。
export type SetNode = { readonly [column: string]: ExprNode };

/** The comparison operators of a `WhereNode`. */
// 六个比较运算符；compileWhere 的默认分支据此生成单键节点。
export type Comparison = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

/** The operations of an `ExprNode`. */
// 值表达式运算名（Expression.op 的另一半是列引用 "col"）。
export type Operation = "add" | "sub" | "max" | "min" | "concat" | "coalesce" | "replacePrefix" | "when";

/** A value expression as a plugin builds it: `T` is its value, `K` its column type. Compiled when staged. */
// 插件的值表达式基类：op 与参数数组在暂存时由 compileExpr 翻译成 ExprNode。
// 泛型 T/K 只在类型层存在（~value/~type 是 declare 标记），运行时不携带列类型信息。
// 示例：add(t.a, 1) 返回 Expression("add", [ColumnRef, 1])，此时尚未检查列类型。
export class Expression<T = unknown, K extends ColumnType = ColumnType> {
	// 运算名或 "col"；运行时可读，编译时据此分派。
	readonly op: Operation | "col";
	// 未编译参数；可能是列引用、字面量或嵌套 Expression。
	readonly args: readonly unknown[];
	/** Type only. */
	// declare 字段只在类型层存在，编译后擦除；让 T 参与推断。
	declare readonly "~value"?: T;
	// 同上，保存列类型 K（str/int/num/bool/json），不占运行时内存。
	declare readonly "~type"?: K;

	// 只保存两个字段；参数检查发生在 compileExpr。
	constructor(op: Operation | "col", args: readonly unknown[]) {
		this.op = op;
		this.args = args;
	}
}

/** A reference to a column of the row, as `(t) => …` callbacks get them. */
// 对表列的引用；column 是列名，args 中重复保存同一名字以便统一处理。
// 例如 columnRefs(columns).id 是一个 ColumnRef，传给 eq 后由 scalarColumn 检查。
export class ColumnRef<T = unknown, K extends ColumnType = ColumnType> extends Expression<T, K> {
	// 列名；scalarColumn 用它到 table.byName 查真实列。
	readonly column: string;

	// 以 "col" 运算注册自身；类型参数仍只用于编译期。
	constructor(column: string) {
		super("col", [column]);
		this.column = column;
	}
}

/** A condition as a plugin builds it; compiled when staged or run. */
// 插件构造的条件基类：op 与未编译参数；暂存/查询时由 compileWhere 转成 WhereNode。
export class Condition {
	// 条件运算符；and/or/not 可嵌套。
	readonly op: Comparison | "inArray" | "isNull" | "prefix" | "and" | "or" | "not";
	// 未编译参数数组；列引用与值都在这里。
	readonly args: readonly unknown[];

	// 只保存字段，不做校验；校验在 compileWhere。
	constructor(op: Condition["op"], args: readonly unknown[]) {
		this.op = op;
		this.args = args;
	}
}

/**
 * A `set` of a table with columns `C` and key `K`: new values of non-key columns, each a value or an expression of
 * the column's type; `undefined` clears an `opt(...)` column.
 */
// set 的类型映射：排除键列，每列接受值或同类型表达式；opt 列还允许 undefined（清除）。
// 这只是编译期约束，运行时仍由 compileSet 检查列存在与值类型。
export type SetOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in Exclude<keyof C & string, K[number]>]?: C[P] extends Optional
		? ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>> | undefined
		: ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>>;
};

/** A scalar column type. */
// 可比较/可参与算术的列类型，排除 json。
type ScalarType = Exclude<ColumnType, "json">;

/** An operand of type `T` and column type `K`: an expression or a plain value. */
// 操作数可以是表达式或同类型普通值。
type Operand<T, K extends ColumnType> = Expression<T, K> | T;

/** The column equals `value` (`NULL` never matches). */
// 相等比较；NULL 永不命中。示例：eq(t.id, 1) 得到 Condition("eq", [t.id, 1])。
export function eq<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("eq", [column, value]);
}

/** The column differs from `value` (`NULL` never matches). */
// 不等比较；NULL 永不命中。
export function ne<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("ne", [column, value]);
}

/** The column is below `value`. */
// 小于比较；类型由 ColumnRef 与值共同约束。
export function lt<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("lt", [column, value]);
}

/** The column is at most `value`. */
// 小于等于比较。
export function lte<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("lte", [column, value]);
}

/** The column is above `value`. */
// 大于比较。
export function gt<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("gt", [column, value]);
}

/** The column is at least `value`. */
// 大于等于比较。
export function gte<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("gte", [column, value]);
}

/** The column equals one of `values` (`[]` matches nothing). */
// 列等于数组中任一值；空数组不命中任何行。
export function inArray<T extends Scalar>(column: ColumnRef<T, ScalarType>, values: readonly T[]): Condition {
	return new Condition("inArray", [column, values]);
}

/** The column is `NULL` (an `opt(...)` column without a value). */
// 判断 opt(...) 列是否为 NULL；不接受右值。
export function isNull(column: ColumnRef<unknown, ScalarType>): Condition {
	return new Condition("isNull", [column]);
}

/** The text column starts with `prefix`, compared by code point (`""` matches every value). */
// 字符串前缀匹配；按码点比较，空串匹配所有非 NULL 值。
export function prefix(column: ColumnRef<string, "str">, prefix: string): Condition {
	return new Condition("prefix", [column, prefix]);
}

/** Every condition holds (`and()` always does). */
// 逻辑与；无参数时恒真（由求值器/SQL 的空数组语义决定）。
export function and(...conditions: Condition[]): Condition {
	return new Condition("and", conditions);
}

/** Some condition holds (`or()` never does). */
// 逻辑或；无参数时恒假。
export function or(...conditions: Condition[]): Condition {
	return new Condition("or", conditions);
}

/** The condition does not hold (`NULL` stays `NULL`: it never matches). */
// 逻辑非；NULL 仍为 NULL，因此不命中。
export function not(condition: Condition): Condition {
	return new Condition("not", [condition]);
}

/** `a + b` over integers; a result outside ±(2^53 - 1) fails (rule 10). */
// 整数加法；结果越界 ±(2^53-1) 时由求值/CHECK 拒绝。
export function add(a: Operand<number, "int">, b: Operand<number, "int">): Expression<number, "int"> {
	return new Expression("add", [a, b]);
}

/** `a - b` over integers; a result outside ±(2^53 - 1) fails (rule 10). */
// 整数减法；与 add 共用安全整数检查。
export function sub(a: Operand<number, "int">, b: Operand<number, "int">): Expression<number, "int"> {
	return new Expression("sub", [a, b]);
}

/** The larger of `a` and b` (`int` or `num`). */
// 取较大值；int/num 均可用。
export function max<K extends "int" | "num">(a: Operand<number, K>, b: Operand<number, K>): Expression<number, K> {
	return new Expression("max", [a, b]);
}

/** The smaller of `a` and `b` (`int` or `num`). */
// 取较小值；int/num 均可用。
export function min<K extends "int" | "num">(a: Operand<number, K>, b: Operand<number, K>): Expression<number, K> {
	return new Expression("min", [a, b]);
}

/** `a` followed by `b`. */
// 字符串拼接；任一侧 NULL 结果为 NULL。
export function concat(a: Operand<string, "str">, b: Operand<string, "str">): Expression<string, "str"> {
	return new Expression("concat", [a, b]);
}

/** `value` with its prefix `from` replaced by `to`; a value without the prefix stays as it is. */
// 仅当值以 from 开头时替换为 to；否则原样返回。
export function replacePrefix(value: Operand<string, "str">, from: string, to: string): Expression<string, "str"> {
	return new Expression("replacePrefix", [value, from, to]);
}

/** `a` unless it is `NULL`, else `b`. */
// 第一个参数为 NULL 时用第二个；两项都类型一致。
export function coalesce<T, K extends ScalarType>(a: Expression<T, K>, b: Operand<T, K>): Expression<T, K> {
	return new Expression("coalesce", [a, b]);
}

/** `a` where `condition` holds for the row, else `b`. */
// 条件成立取 a，否则取 b；只求值被选中的分支。
export function when<T, K extends ScalarType>(
	condition: Condition,
	a: Operand<T, K>,
	b: Operand<T, K>,
): Expression<T, K> {
	return new Expression("when", [condition, a, b]);
}

/** One `ColumnRef` per column of `definition`, for its `(t) => …` callbacks. */
// 为每个声明列创建一个 ColumnRef，供 where/orderBy 等回调使用；不访问数据库。
// 示例：columnRefs(columns).id 是一个 ColumnRef；TableDefinition.refs 就是这么构造的。
export function columnRefs(columns: readonly Column[]): { readonly [column: string]: ColumnRef } {
	return Object.fromEntries(columns.map(({ name }) => [name, new ColumnRef(name)]));
}

/**
 * Compiles a plugin's condition over `table`'s columns (a trust boundary: plugin values): known scalar columns,
 * operands of their type made storable (`invalid/args` otherwise, `undefined` included: ask with `isNull`, rule 16).
 */
// 编译插件条件：要求 Condition，递归检查列引用与操作数，输出纯数据 WhereNode。
// 输入是表定义、unknown 条件与定位文本；错误 invalid/args；无 I/O。
// 示例：compileWhere(notes, eq(notes.refs.id, 1), "where") 得到 { eq: ["id", 1] }。
export function compileWhere(table: TableDefinition, condition: unknown, what: string): WhereNode {
	// 信任边界：插件可能传任意值，先确认是 Condition 对象。
	if (!(condition instanceof Condition)) throw invalid("args", `${table.name}: ${what}: expected a condition`);
	const { op, args } = condition;
	// 按条件运算符分派；and/or 递归到子条件。
	switch (op) {
		// and/or 的每个子条件都递归编译；空数组语义交给求值器与 SQL。
		case "and":
		case "or": {
			const nodes = args.map((each) => compileWhere(table, each, what));
			return op === "and" ? { and: nodes } : { or: nodes };
		}
		// not 只递归一个子条件。
		case "not":
			return { not: compileWhere(table, args[0], what) };
		// isNull 只取列引用，不取右值。
		case "isNull":
			return { isNull: scalarColumn(table, args[0], what).name };
		// prefix 只允许 str 列，前缀本身也按 str 检查。
		case "prefix": {
			const column = scalarColumn(table, args[0], what);
			if (column.type !== "str") throw invalid("args", `${table.name}: ${what}: prefix needs a str() column`);
			return { prefix: [column.name, operand(column, args[1], what) as string] };
		}
		// inArray 的第二个参数必须是数组，每个元素按列类型检查。
		case "inArray": {
			const column = scalarColumn(table, args[0], what);
			const values = args[1];
			if (!Array.isArray(values)) throw invalid("args", `${table.name}: ${what}: inArray needs an array`);
			return { inArray: [column.name, values.map((value) => operand(column, value, what))] };
		}
		// 其余 op 是六个比较之一，生成 { [op]: [列名, 值] } 的单键节点。
		default: {
			const column = scalarColumn(table, args[0], what);
			// One of the six comparisons: the node's shape is `{ [op]: [column, value] }`.
			return { [op]: [column.name, operand(column, args[1], what)] as const } as WhereNode;
		}
	}
}

/**
 * Compiles a plugin's `set` (plain values or a callback's result) for `table` (a trust boundary): known non-key
 * columns (rule 13), at least one (rule 14), `undefined` clearing an `opt(...)` column as the explicit `null` (a
 * `null` value is a `json(...)` cell's JSON `null`, refused for other columns), an
 * expression whose result may be `NULL` only for an `opt(...)` column; integer arithmetic only on `int` columns.
 */
// 编译插件的 set：检查对象、非键列、至少一项，并把值/表达式转成 ExprNode。
// 输入是表定义、unknown set 与定位文本；输出列名到节点的映射；错误 invalid/args。
// 示例：compileSet(notes, { n: 2 }, "set") 得到 { n: 2 }；键列、未知列、空 set 都拒绝。
export function compileSet(table: TableDefinition, set: unknown, what: string): SetNode {
	// set 是插件对象（信任边界）：拒绝 null 与数组。
	if (typeof set !== "object" || set === null || Array.isArray(set)) {
		throw invalid("args", `${table.name}: ${what}: expected an object of column values`);
	}
	// 取自有字段；后面的空集与逐列检查都基于它。
	const entries = Object.entries(set);
	// 至少改一列（rule 14）。
	if (entries.length === 0) throw invalid("args", `${table.name}: ${what}: the set is empty`);
	const node: { [column: string]: ExprNode } = {};
	// 逐列检查：列必须存在且不能是键列。
	for (const [name, value] of entries) {
		const column = table.byName.get(name);
		// 未知列直接拒绝，避免拼写错误被静默忽略。
		if (column === undefined) throw invalid("args", `${table.name}: ${what}: no column "${name}"`);
		// 键列不能改；要换键请 delete + put。
		if (table.key.includes(name)) {
			throw invalid("args", `${table.name}: ${what}: key column "${name}" cannot change (delete and put)`);
		}
		const where = `${what}: column "${name}"`;
		// undefined 表示清除 opt(...) 列，编译成显式 null 节点。
		if (value === undefined) {
			if (!column.optional) throw invalid("args", `${table.name}: ${where} is not opt(...) and cannot be cleared`);
			node[name] = null;
		} else if (value === null && column.type !== "json") {
			// 标量列没有显式 null；只有 json 列允许 JSON null。
			// A row never holds an explicit `null` (decision "Nullable columns and the set form"); a JSON `null` is a value.
			throw invalid("args", `${table.name}: ${where}: null is no ${column.type} value (undefined clears)`);
		} else if (value instanceof Expression) {
			// 表达式：json 列不接受；编译后若可能为 NULL，列必须是 opt(...)。
			// JSON 单元格不可比较/排序，只支持 isNull 与 set。
			if (column.type === "json")
				throw invalid("args", `${table.name}: ${where}: json(...) columns take plain values`);
			const compiled = compileExpr(table, value, column.type, where);
			if (compiled.nullable && !column.optional) {
				throw invalid("args", `${table.name}: ${where}: the expression may be NULL; the column is not opt(...)`);
			}
			node[name] = compiled.node;
		} else if (column.type === "json") {
			// JSON 值在这里只序列化一次，stored 结果进入节点。
			node[name] = { json: encodeCell(column, value, `${table.name}: ${where}`).stored };
			// 标量值按列类型检查后成为字面量节点。
		} else node[name] = checkScalar(column.type, value, `${table.name}: ${where}`);
	}
	return node;
}

/** A compiled expression and whether its result may be `NULL`. */
// compileExpr 的结果：节点 + 是否可能为 NULL（供 compileSet 检查 opt）。
type Compiled = { readonly node: ExprNode; readonly nullable: boolean };

// 递归编译一个值表达式，目标列类型为 type；返回节点及可空性。
// 输入是表定义、unknown 值与目标类型；错误 invalid/args；无 I/O。
// 示例：compileExpr(table, add(t.n, 1), "int", "set: n") 得到 { node: { add: [...] }, nullable: false }。
function compileExpr(table: TableDefinition, value: unknown, type: ScalarType, what: string): Compiled {
	// 非表达式：null/undefined 得 NULL 节点，其余按目标列类型检查。
	if (!(value instanceof Expression)) {
		if (value === undefined || value === null) return { node: null, nullable: true };
		return { node: checkScalar(type, value, `${table.name}: ${what}`), nullable: false };
	}
	const { op, args } = value;
	// 统一错误前缀的小工具；返回 never，便于在 ?? 右侧使用。
	const refuse = (message: string): never => {
		throw invalid("args", `${table.name}: ${what}: ${message}`);
	};
	// 按运算名分派；每种运算都检查结果类型与 NULL 传播。
	switch (op) {
		// 列引用必须存在且类型与目标列一致；可空性来自列本身。
		case "col": {
			const column = table.byName.get(args[0] as string) ?? refuse(`no column "${String(args[0])}"`);
			if (column.type !== type) refuse(`column "${column.name}" is ${column.type}, not ${type}`);
			return { node: { col: column.name }, nullable: column.optional };
		}
		// concat 仅 str；add/sub 仅 int；max/min 允许 int/num。
		case "add":
		case "sub":
		case "max":
		case "min":
		case "concat": {
			const types: readonly ScalarType[] =
				op === "concat" ? ["str"] : op === "add" || op === "sub" ? ["int"] : ["int", "num"];
			if (!types.includes(type)) refuse(`${op} gives ${types.join(" or ")}, the column is ${type}`);
			// 两个操作数都按目标类型递归编译；任一可空则结果可空。
			const [a, b] = [compileExpr(table, args[0], type, what), compileExpr(table, args[1], type, what)];
			// The operation's shape is `{ [op]: [a, b] }`.
			return { node: { [op]: [a.node, b.node] } as ExprNode, nullable: a.nullable || b.nullable };
		}
		// coalesce 只有两项都可空时结果才可空。
		case "coalesce": {
			const [a, b] = [compileExpr(table, args[0], type, what), compileExpr(table, args[1], type, what)];
			return { node: { coalesce: [a.node, b.node] }, nullable: a.nullable && b.nullable };
		}
		// from/to 只接受 str；主体保持自身可空性。
		case "replacePrefix": {
			if (type !== "str") refuse(`replacePrefix gives str, the column is ${type}`);
			const subject = compileExpr(table, args[0], type, what);
			const [from, to] = [args[1], args[2]].map(
				(each) => checkScalar("str", each, `${table.name}: ${what}`) as string,
			);
			return { node: { replacePrefix: [subject.node, from!, to!] }, nullable: subject.nullable };
		}
		// 条件走 compileWhere；两个分支任一可空则结果可空。
		case "when": {
			const condition = compileWhere(table, args[0], what);
			const [a, b] = [compileExpr(table, args[1], type, what), compileExpr(table, args[2], type, what)];
			return { node: { when: [condition, a.node, b.node] }, nullable: a.nullable || b.nullable };
		}
	}
}

/** The column a condition compares: a reference to a known scalar column. */
// 条件是列引用且指向已知标量列；json 列不能用于查询。
// 输入是表定义、unknown 引用与定位文本；返回 Column；错误 invalid/args。
function scalarColumn(table: TableDefinition, ref: unknown, what: string): Column {
	// 信任边界：回调可能返回任意值，先确认是 ColumnRef。
	if (!(ref instanceof ColumnRef)) throw invalid("args", `${table.name}: ${what}: expected a column reference`);
	// 按列名查表定义；名字不存在则拒绝。
	const column = table.byName.get(ref.column);
	if (column === undefined) throw invalid("args", `${table.name}: ${what}: no column "${ref.column}"`);
	if (column.type === "json")
		throw invalid("args", `${table.name}: ${what}: json(...) column "${ref.column}" is not queryable`);
	return column;
}

/** An operand compared with `column`, made storable; `undefined` and `null` are refused (rule 16). */
// 比较右值按列类型检查并转成可存储标量；undefined/null 拒绝，提示改用 isNull。
// 返回 string|number|boolean；错误 invalid/args；无 I/O。
function operand(column: Column, value: unknown, what: string): Scalar {
	// 与 NULL 比较没有意义（结果恒为未知），要求显式 isNull。
	if (value === undefined || value === null) {
		throw invalid("args", `${what}: column "${column.name}" compared with ${String(value)}; ask with isNull`);
	}
	// `scalarColumn` refused json columns.
	// scalarColumn 已排除 json，因此这里的断言安全。
	return checkScalar(column.type as ScalarType, value, `${what}: column "${column.name}"`);
}
