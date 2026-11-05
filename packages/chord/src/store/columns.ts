// Table columns (decisions "Flat columns", "Nullable columns and the `set` form", "Restricted names"): the restricted
// subset of L1's helpers a table's `columns` take (`str int num bool`, `opt(...)` of them, `json(...)`, defaults),
// their types for rows, keys and column references, and the column descriptors and records the store keeps.
// 文件导读
// 所属：packages/chord/src/store（Chord v2 的 store 层，表声明词汇）。
// 职责边界：只把 defineTable 的 columns 声明翻译成 Column/ColumnRecord 并推导 TS 类型，不执行 SQL、不读写行。
// 上游：table.ts 的 defineTable/evolveTable 调用 describeColumns/columnRecord；下游：RowCodec 用列描述编解码，sql.ts 生成 DDL，applier 导入时重建列。
// 能力清单：
// - ColumnSchema/Columns/ColumnType：插件声明层与存储类型的类型词汇；
// - ColumnTypeOf/ValueOf/RequiredNames/DefaultedNames/RowOf/PutRowOf/OrderColumn：纯编译期推导；
// - Column/ColumnRecord：运行时列描述与持久记录；
// - COLUMN_NAME/describeColumns/checkColumnName/describeColumn/checkDefault/columnRecord：声明策略检查与转换。
// 组合顺序：defineTable 收到 columns -> describeColumns 逐列检查 -> Column[] 供 RowCodec/DDL/record 使用；错误在声明时抛普通 Error。
// 示例：const cols = describeColumns({ id: int(), note: opt(str()) }, "notes"); 返回 id、note 两个 Column（不访问数据库）。
// 建议阅读顺序：先看 Column/ColumnRecord 与 RowOf，再看 describeColumns/describeColumn 的检查，最后看 columnRecord 的持久化形态。

import type { BooleanSchema, IntegerSchema, NumberSchema, Schema, Static, StringSchema } from "../contracts/index.ts";
import { isOptional, type Optional } from "../contracts/schema.ts";
import { JsonColumn, type JsonColumnSchema } from "./json-column.ts";
import { storedText } from "./text.ts";

/** A schema a table column takes. */
export type ColumnSchema =
	| ScalarSchema
	| JsonColumnSchema<unknown>
	| Optional<ScalarSchema | JsonColumnSchema<unknown>>;
// 联合类型：列值必须是这几种之一；JsonColumnSchema<unknown> 覆盖 json(...)，Optional<...> 表示 opt(...)。
// 这些别名只在编译期存在，运行时不会被检查；真正的识别在 describeColumn 里按 schema 对象的字段做。

type ScalarSchema = StringSchema | IntegerSchema | NumberSchema | BooleanSchema;
// 内部别名，把四个标量 schema 合在一起，供 ColumnSchema 的三种写法复用；它不导出。

/** A table's `columns`: a flat record of column schemas. */
export type Columns = { readonly [name: string]: ColumnSchema };
// 字符串索引签名：任意列名映射到列 schema；对象键顺序就是声明顺序，后续 DDL/读取都沿用。

/** A column's type in the store. */
export type ColumnType = "str" | "int" | "num" | "bool" | "json";
// 列在存储层的五种类型：str/int/num/bool 对应 SQLite 标量，json 存成 TEXT（另带版本列）。

/** The store type of column schema `S`. */
export type ColumnTypeOf<S> = S extends Optional<infer I>
	? ColumnTypeOf<I>
	: S extends StringSchema
		? "str"
		: S extends IntegerSchema
			? "int"
			: S extends NumberSchema
				? "num"
				: S extends BooleanSchema
					? "bool"
					: "json";
// 条件类型：先剥掉 opt(...) 的 Optional 包装，再按 schema 的运行时判别字段 type 映射到存储类型；
// 最后的 json 是兜底，因为 JsonColumnSchema 的 schema 类型没有统一的 type 字面量。
// 例如 ColumnTypeOf<Optional<IntegerSchema>> 在编译期得到 int；运行时不执行这段推导。

/** The value type of column schema `S` (without `undefined` for an `opt(...)` one). */
export type ValueOf<S> = S extends Optional<infer I> ? ValueOf<I> : S extends Schema ? Static<S> : never;
// ValueOf 取 schema 描述的值类型：Optional 先解包，Static<S> 从 schema 的泛型得到值类型。
// 例如 ValueOf<Optional<StringSchema>> 是 string（不是 string | undefined）；行里是否可缺省由下面的映射决定。

/** The names of the columns that are not `opt(...)`. */
type RequiredNames<C extends Columns> = { [K in keyof C]: C[K] extends Optional ? never : K }[keyof C];
// 映射类型：对每个列名 K 判断其 schema 是否 Optional；不是则保留 K，是则得 never，最后用索引访问只留下保留的名字。
// 结果是一个列名联合，例如 { id: int(), note: opt(str()) } 得到 id。

/** The names of the columns with a declared default. */
type DefaultedNames<C extends Columns> = {
	[K in keyof C]: C[K] extends { readonly default: unknown } ? K : never;
}[keyof C];
// 同样的映射技巧：只保留声明了 default 字段的列名。default 不是 schema 类型参数的一部分，
// 因此用结构条件 `C[K] extends { readonly default: unknown }` 检测。

/** A row as reads return it: every non-`opt` column, the `opt(...)` ones when not `NULL`. */
export type RowOf<C extends Columns> = { [K in RequiredNames<C>]: ValueOf<C[K]> } & {
	[K in Exclude<keyof C, RequiredNames<C>>]?: ValueOf<C[K]>;
};
// RowOf 是两个映射类型的交叉：必填列来自 RequiredNames，其余列变成可选属性（?）。
// ? 只影响 TS 使用方；数据库里 NULL 的 opt(...) 列在读取时根本不会出现在对象中（见 RowCodec.decode）。

/** A row as `put` takes it: as read, the columns with a default may be left out (rule 15). */
export type PutRowOf<C extends Columns> = { [K in Exclude<RequiredNames<C>, DefaultedNames<C>>]: ValueOf<C[K]> } & {
	[K in Exclude<keyof C, Exclude<RequiredNames<C>, DefaultedNames<C>>>]?: ValueOf<C[K]>;
};
// PutRowOf 把「有默认值的必填列」从必填集合里去掉：put 可以省略它们，由 RowCodec.put 填入默认值。

/** The columns a key, an index or an `orderBy` may use: non-`opt` `str` or `int`. */
export type OrderColumn<C extends Columns> = {
	[K in keyof C]: C[K] extends Optional ? never : C[K] extends StringSchema | IntegerSchema ? K : never;
}[keyof C] &
	string;
// OrderColumn 限制键、索引和 orderBy 只能用非 opt 的 str()/int() 列；末尾 & string 让结果可当字符串键使用。

/** A column of the store: its name, type, nullability and default; a `json(...)` one with its definition. */
export type Column =
	| {
			readonly name: string;
			readonly type: "str" | "int" | "num" | "bool";
			readonly optional: boolean;
			readonly default: string | number | boolean | undefined;
	  }
	| { readonly name: string; readonly type: "json"; readonly optional: boolean; readonly json: JsonColumn };
// Column 有两种形态：标量列带 default，json 列带 JsonColumn 实例（版本、指纹、迁移函数都在里面）。
// isOptional 已把 opt(...) 解包成 optional 布尔；这里是 store 内部描述，不是插件直接构造的值。

/** A column as the `table` write records it (slice 6a §5): what a replica needs without the plugin's code. */
export type ColumnRecord = {
	readonly type: ColumnType;
	readonly optional?: true;
	readonly default?: string | number | boolean;
	/** A `json(...)` column's version and schema fingerprint. */
	readonly version?: number;
	readonly fingerprint?: string;
};
// ColumnRecord 是写进 chord_tables 的持久形态：optional 用字面量 true 表示「有」，
// version/fingerprint 只属于 json(...) 列；回放/导入只凭这些字段就能重建列，不需要插件代码。

/** The column name rule (decision "Restricted names"). */
export const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 列名规则：ASCII 字母或下划线开头，后续字母/数字/下划线；限定 ASCII 也让 SQL 引号和大小写比较可控。
// 它在声明（describeColumns）与导入（applier.checkTable）两个边界各检查一次。

/**
 * The columns of `columns` in declaration order, checked (declaration policy: JavaScript callers reach it): names
 * `[A-Za-z_][A-Za-z0-9_]*` without two equal ignoring ASCII case, only the helpers' types, no bounds or patterns (a
 * bulk `set` could not keep them), a default of the column's type and not on an `opt(...)` column.
 */
// 把 columns 按声明顺序转成 Column[]；先查列名与大小写冲突，再逐列解析类型和默认值。
// 输入来自插件声明（声明策略边界，JS 调用者也走这里），出错抛普通 Error，不执行 SQL。
// 示例：describeColumns({ id: int(), note: opt(str()) }, notes) 返回两个 Column，顺序为 id、note。
export function describeColumns(columns: Columns, table: string): Column[] {
	const seen = new Set<string>();
	// 小写列名集合：SQLite 标识符大小写不敏感，两列只差大小写会在 DDL 中撞名。
	// Object.entries 保留对象插入顺序；map 对每列返回描述对象。
	return Object.entries(columns).map(([name, schema]) => {
		checkColumnName(name, table);
		// 名称规则是声明策略，必须在这里显式检查，因为 TS 的 Columns 类型不限制字符串内容。
		const folded = name.toLowerCase();
		// 只用于冲突比较，不写回列名。
		if (seen.has(folded)) throw new Error(`${table}: column "${name}" differs from another only in case`);
		// 发现重复立即失败，避免后续生成两张同名列或静默覆盖。
		seen.add(folded);
		// 记录本次已见的小写形式。
		// describeColumn 负责类型、可空性和默认值的其余检查。
		return describeColumn(name, schema, `${table}: column "${name}"`);
	});
}

/** Throws unless `name` follows the column name rule (declaration policy); `what` names the table or the edit. */
// 校验一个列名（或迁移中的列编辑名）；what 用于错误定位。
// 例如 checkColumnName(id, notes) 通过，1x 抛错；这是声明策略检查，不访问数据库。
export function checkColumnName(name: string, what: string): void {
	// test 返回布尔值；错误文本带上期望的字符集，方便插件作者修正。
	if (!COLUMN_NAME.test(name)) throw new Error(`${what}: column "${name}": expected [A-Za-z_][A-Za-z0-9_]*`);
}

const SCALAR_TYPES: { readonly [type: string]: "str" | "int" | "num" | "bool" } = {
	string: "str",
	integer: "int",
	number: "num",
	boolean: "bool",
};
// schema 对象的运行时 type 字段到 store 类型的映射；键值来自 contracts 的 helper，不是 TS 类型名。
// 例如 str() 的 type 是 string，映射后存为 str。

// 把单个列 schema 解析成 Column：识别 opt/json，读取标量类型与 default，并拒绝不支持的结构。
// 输入是列名、schema 和错误定位文本；输出 Column；无 I/O；不认识的结构或非法 default 抛 Error。
// 示例：describeColumn(n, int({ default: 0 }), notes: column n) 得到 { name: n, type: int, optional: false, default: 0 }。
function describeColumn(name: string, column: ColumnSchema, what: string): Column {
	const optional = isOptional(column);
	// opt(...) 是 Optional 包装，解包后才能看到内层 schema。
	// Declaration policy: a JavaScript caller may pass any schema, so its fields are read as unknown data.
	const fields = (optional ? column.schema : column) as { readonly [key: string]: unknown };
	// 声明策略边界：读插件对象的字段前先当作 unknown 数据；as 不改变运行时值。
	const json = fields.json;
	// JSON 列以 JsonColumn 实例为标记；json() 构造时已快照 schema 并校验版本。
	if (json instanceof JsonColumn) return { name, type: "json", optional, json };
	// 命中后直接返回，不再把 JsonColumn 当成标量 schema 检查 type/default。
	const type = SCALAR_TYPES[String(fields.type)];
	if (type === undefined) throw new Error(`${what}: expected str(), int(), num(), bool(), opt(...) or json(...)`);
	// 不认识的 helper（例如嵌套 opt、带 bounds 的 str）在这里被拒绝，保证表列词汇受限。
	for (const key of Object.keys(fields)) {
		// 只允许 type 与 default：像 bounds/pattern 这类约束在 bulk set 表达式下无法维持，因此不进入表列。
		if (key !== "type" && key !== "default") throw new Error(`${what}: "${key}" is not supported in a table column`);
	}
	const value = fields.default;
	if (value !== undefined) {
		// undefined 表示没有默认值；有值时必须与列类型匹配，且不能出现在 opt(...) 列上。
		if (optional) throw new Error(`${what}: an opt(...) column has no default`);
		checkDefault(type, value, what);
	}
	// checkDefault 是运行时验证；返回对象里的 as 只是把 unknown 收窄为可存储标量。
	return { name, type, optional, default: value as string | number | boolean | undefined };
}

// 校验声明期 default 的运行时形状；输入是存储类型、unknown 值和错误定位文本，无输出；非法值抛普通 Error。
// 示例：checkDefault("int", 3, "notes: column n") 通过；checkDefault("int", 3.5, ...) 抛错。
function checkDefault(type: "str" | "int" | "num" | "bool", value: unknown, what: string): void {
	// 按存储类型验证：str 还需 storedText 规范形，int 为安全整数，num 有限，bool 严格布尔。
	const valid =
		type === "str"
			? typeof value === "string" && storedText(value, what) === value
			: type === "int"
				? Number.isSafeInteger(value)
				: type === "num"
					? typeof value === "number" && Number.isFinite(value)
					: typeof value === "boolean";
	// 非法值统一抛普通 Error；what 指出列名。
	if (!valid) throw new Error(`${what}: the default ${JSON.stringify(value)} is not a ${type} value`);
}

/** The record of `column` in the `table` write. */
// 把 Column 压成持久记录；optional 只在为 true 时写入字段，json 列额外带版本与指纹。
// 示例：columnRecord({name:n,type:int,optional:false,default:2}) => { type:int, default:2 }。
export function columnRecord(column: Column): ColumnRecord {
	const optional = column.optional ? { optional: true as const } : {};
	// 三元 + 展开：optional 为 true 时加入 { optional: true }，否则什么都不加。
	if (column.type === "json") {
		// json 列不写 default（构造时已禁止），只写可空性、版本和 schema 指纹。
		return { type: "json", ...optional, version: column.json.version, fingerprint: column.json.fingerprint };
	}
	// 标量列只在声明了默认值时写 default，保持记录最小。
	return { type: column.type, ...optional, ...(column.default === undefined ? {} : { default: column.default }) };
}
