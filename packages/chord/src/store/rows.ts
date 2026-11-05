// Rows (slice 6a §5 "Values at write", §9): one compiled codec per table version between a plugin's rows and keys
// (a trust boundary, checked closed) and what the store binds and reads; `json(...)` cells serialized at staging
// (rule 8), never walked (R9), and migrated on access when read.
// 文件导读
// 所属：packages/chord/src/store（store 层，行/键编解码）。
// 职责边界：在插件行与 SQLite 存储之间做运行时校验和编解码；不生成 SQL、不决定事务。
// 上游：TableDefinition 构造 RowCodec，TableHandle/TableChanges 调用 put/key/decode；下游：sql.ts 的参数、outbox/归档的行记录、JsonColumn.read。
// 能力清单：
// - Scalar/StoredRow/EncodedRow/EncodedKey：行、键、编码结果的数据形态；
// - versionColumn/ROW_VERSION/physicalColumns/toSqlite：物理列与绑定值约定；
// - RowCodec：put 校验+编码、key 校验+编码、decode 读取；
// - Cell/encodeCell/encodeScalar/checkScalar：单元格级检查与 JSON 序列化。
// 组合顺序：put 先 #closed 查字段，再逐列 encodeCell 得参数与记录，最后补 json 版本和 $v；decode 反向还原。
// 示例：new RowCodec(definition.columns, definition.key, "notes") 后 put({ id: 1, name: "a" }, 1) 返回 { params, row, columns, id }。
// 建议阅读顺序：先看 Scalar/StoredRow/EncodedRow，再看 RowCodec 的 put/key/decode，最后看 encodeCell/checkScalar 的信任边界。

import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { Column, ColumnType } from "./columns.ts";
import { storedText } from "./text.ts";

/** A scalar cell as the store keeps it in rows, writes and operands: a well-formed string, a number or a boolean. */
export type Scalar = string | number | boolean;
// Scalar 是 store 行里能直接比较/绑定的标量；布尔在绑定前会转 0/1（见 toSqlite）。

/** A row as the outbox records it: the stored values, `opt(...)` columns absent when `NULL`. */
export type StoredRow = { readonly [column: string]: Scalar | JsonValue };
// outbox/归档保存的行形态：opt 列为 NULL 时不出现；json 列保存解析后的 JSON 值，而不是 TEXT。

/** A `put` ready for the step: its parameters in `physical` order and its record. */
export type EncodedRow = {
	readonly params: readonly SqliteValue[];
	readonly row: StoredRow;
	/** Each written `json(...)` column's version. */
	readonly columns: { readonly [column: string]: number };
	/** The row's key identity, as `EncodedKey.id`. */
	readonly id: string;
};
// put 的编码结果：params 按 physical 顺序绑定，row/columns 供 outbox 记录，id 是键的稳定身份（用于 overlay）。

/** A key ready for the store: its parameters in key order, its record and its identity within one table. */
export type EncodedKey = {
	readonly params: readonly SqliteValue[];
	readonly key: { readonly [column: string]: Scalar };
	/** `JSON.stringify` of the parameters: equal keys, equal ids. */
	readonly id: string;
};
// 键的编码结果；id = JSON.stringify(params) 只用于同一表内的事务 overlay 查找，不是跨版本持久格式。

/** The physical name of a `json(...)` column's version column, and of the row's eager-step version. */
export function versionColumn(column: string): string {
	return `${column}$v`;
}
// json 列版本列的物理名，例如 data 列对应 data$v；读写两侧用同一函数生成名字。

/** The row's eager-step version column (W11): set by `put` and eager migration steps only. */
export const ROW_VERSION = "$v";
// 整行 eager 迁移版本列，只有 put 和迁移步骤写它，普通 update 不改。

/** The physical column order of a stored row: the declared columns, each `json(...)` column's version, then `$v`. */
export function physicalColumns(columns: readonly { readonly name: string; readonly type: ColumnType }[]): string[] {
	return [
		...columns.map(({ name }) => name),
		...columns.filter(({ type }) => type === "json").map(({ name }) => versionColumn(name)),
		ROW_VERSION,
	];
}
// 物理列顺序 = 声明列、每个 json 列的版本列、$v；SQL 的 INSERT 与 RowCodec 共用这个顺序。
// 示例：columns [id:int, data:json] 得到 [id, data, data$v, $v]。

/** A scalar as SQLite binds it: booleans as 0 and 1. */
export function toSqlite(scalar: Scalar): string | number {
	return scalar === true ? 1 : scalar === false ? 0 : scalar;
}
// SQLite 没有布尔类型；true/false 绑定为 1/0，其余标量原样返回。

/**
 * A table version's codec: `put` rows and keys checked and encoded, stored rows decoded. `physical` is the column
 * order of an encoded row (`physicalColumns`).
 */
// 一个表版本的编解码器：columns/key 来自表定义，physical 是编码后的列顺序。
// 构造时只准备映射，无 I/O；put/key 对未知字段、类型不符会抛 invalid/args（信任边界）。
export class RowCodec {
	readonly physical: readonly string[];
	readonly #columns: readonly Column[];
	readonly #key: readonly Column[];
	readonly #json: readonly Extract<Column, { readonly type: "json" }>[];
	readonly #names: ReadonlySet<string>;
	readonly #keyNames: ReadonlySet<string>;
	/** The positions of the key columns in `physical`. */
	readonly #keyPositions: readonly number[];
	readonly #table: string;

	constructor(columns: readonly Column[], key: readonly string[], table: string) {
		this.#columns = columns;
		this.#key = key.map((name) => columns.find((column) => column.name === name)!);
		// 键列按名字找到 Column；key 已在声明时验证存在，因此这里的 ! 只是类型收窄。
		this.#json = columns.filter(
			(column): column is Extract<Column, { readonly type: "json" }> => column.type === "json",
		);
		// json 列单独缓存：编码时每个存在的 json 列都要补一个版本参数。
		this.#names = new Set(columns.map(({ name }) => name));
		this.#keyNames = new Set(key);
		this.#keyPositions = key.map((name) => columns.findIndex((column) => column.name === name));
		// 名字集合用于 #closed 的未知字段检查；键位置用于从 params 取键生成 id。
		this.#table = table;
		// physical 与 physicalColumns 的顺序一致，供 sql.put 的占位符使用。
		this.physical = physicalColumns(columns);
	}

	/**
	 * Checks and encodes a `put` row of table version `version` (a trust boundary): a plain object with every
	 * non-`opt` column (a defaulted one filled in) and no other field; `invalid/args` otherwise.
	 */
	// 校验并编码 put 行：封闭对象、必填列（可补 default）、不支持未知字段。
	// 输入是插件传入的 unknown 行与表版本；输出 EncodedRow；错误 invalid/args，无 I/O。
	// 示例：put({ id: 1, name: a }) 得到 params、outbox 行 { id: 1, name: a }、空 columns 和键身份。
	put(row: unknown, version: number): EncodedRow {
		const what = `${this.#table}: put`;
		// 错误前缀固定为表名: put，后面再拼具体列。
		const fields = this.#closed(row, this.#names, what);
		// #closed 先拒绝非对象和未知字段，这是插件值进入 store 的信任边界。
		const params: SqliteValue[] = [];
		const stored: { [column: string]: Scalar | JsonValue } = {};
		const versions: { [column: string]: number } = {};
		// 三个容器同步推进：SQL 参数、outbox 行、每列 json 版本。
		for (const column of this.#columns) {
			// 按声明顺序遍历；缺字段的标量列先尝试默认值。
			let value = fields[column.name];
			if (value === undefined && column.type !== "json") value = column.default;
			// 只有非 json 列填默认值；json 列的 undefined 表示未提供（列自身可能是 opt）。
			// 缺值且非 opt => 错误；opt 列绑定 NULL 且不出现在 stored 里，continue 跳过编码。
			if (value === undefined) {
				if (!column.optional) throw invalid("args", `${what}: column "${column.name}" is missing`);
				params.push(null);
				continue;
			}
			const cell = encodeCell(column, value, `${what}: column "${column.name}"`);
			// encodeCell 负责标量检查或 JSON 序列化，并同时给出参数与记录值。
			// 参数与记录保持同一顺序。
			params.push(cell.param);
			stored[column.name] = cell.stored;
		}
		for (const column of this.#json) {
			const present = Object.hasOwn(stored, column.name);
			if (present) versions[column.name] = column.json.version;
			params.push(present ? column.json.version : null);
		}
		// 第二遍补 json 版本列；未提供的 json 列版本写 NULL（其值列也是 NULL）。
		params.push(version);
		// 每行的 eager 版本列来自调用者（put 时是定义版本）。
		const id = JSON.stringify(this.#keyPositions.map((position) => params[position]));
		// 键身份从参数里的键位置取，避免重新编码键；JSON 数组保证类型区分。
		// 返回编码结果，调用者把它交给 stagePut 与 overlay。
		return { params, row: stored, columns: versions, id };
	}

	/** Checks and encodes a key (a trust boundary): an object with exactly the key columns; `invalid/args` otherwise. */
	// 校验并编码键对象：必须恰好包含键列；输入 unknown、输出 EncodedKey；错误 invalid/args。
	// 示例：key({ id: 1 }, delete) 得到 params [1]、key { id: 1 }、id [1]。
	key(key: unknown, what: string): EncodedKey {
		const fields = this.#closed(key, this.#keyNames, `${this.#table}: ${what}: the key`);
		// 与行一样做封闭对象检查，但允许的字段集合是 keyNames。
		const params: SqliteValue[] = [];
		const stored: { [column: string]: Scalar } = {};
		for (const column of this.#key) {
			// 按 key 顺序遍历；params 顺序必须与 SQL 的 WHERE 列顺序一致。
			const value = fields[column.name];
			const where = `${this.#table}: ${what}: key column "${column.name}"`;
			if (value === undefined) throw invalid("args", `${where} is missing`);
			// 键列不允许 undefined；可空键在表声明时已被排除。
			const cell = encodeScalar(column, value, where);
			// encodeScalar 拒绝 json 列并做类型检查，返回 SQLite 绑定值。
			params.push(cell);
			stored[column.name] = cell;
		}
		// id 用参数数组的 JSON 表示，用作事务 overlay 的 Map 键。
		return { params, key: stored, id: JSON.stringify(params) };
	}

	/**
	 * A stored row as reads return it: booleans from 0 and 1, `opt(...)` columns absent when `NULL`, `json(...)` cells
	 * parsed and migrated on access (a cell the code cannot read throws, see `JsonColumn.read`).
	 */
	// 把存储行转成插件可见行：bool 从 0/1 还原、NULL 的 opt 列省略、json 按版本迁移。
	// 输入是 SQLite 返回的行与 context；输出普通对象；读不懂的 json 单元格会抛错（见 JsonColumn.read）。
	decode(stored: { readonly [column: string]: SqliteValue }, context: Context): { [column: string]: unknown } {
		const row: { [column: string]: unknown } = {};
		for (const column of this.#columns) {
			const value = stored[column.name];
			// SQLite 返回 null 表示 NULL；缺列也按 NULL 处理（查询可能只选部分列时不应该走到这里）。
			if (value === null || value === undefined) continue;
			// bool 从 INTEGER 0/1 还原；json 按配套版本列迁移；标量原样返回。
			if (column.type === "bool") row[column.name] = value === 1;
			else if (column.type === "json") {
				// 读取配套的版本列，交给 JsonColumn.read 迁移与校验。
				const version = stored[versionColumn(column.name)] as number;
				row[column.name] = column.json.read(value as string, version, `${this.#table}.${column.name}`, context);
			} else row[column.name] = value;
		}
		return row;
	}

	/** `value`'s own fields when it is a plain object with only fields of `names`; `invalid/args` otherwise. */
	// 校验 value 是普通对象且字段都在 names 中；返回同一对象，不复制、不冻结。
	// 这是插件值边界：typeof/Array.isArray/字段遍历都是运行时检查。
	#closed(value: unknown, names: ReadonlySet<string>, what: string): { readonly [field: string]: unknown } {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			// Array.isArray 排除数组；typeof null 也是 object，因此 null 必须单独排除。
			throw invalid("args", `${what}: expected an object`);
		}
		for (const field of Object.keys(value)) {
			// 任何未知字段都拒绝，避免拼写错误被静默忽略。
			if (!names.has(field)) throw invalid("args", `${what}: unknown column "${field}"`);
		}
		// Checked above: a plain object with known fields.
		// 上方检查已证明形状；as 只是为了给 TS 一个可索引类型。
		return value as { readonly [field: string]: unknown };
	}
}

/** A checked cell: what is bound and what is recorded. */
type Cell = { readonly param: SqliteValue; readonly stored: Scalar | JsonValue };
// 一个已检查单元格：param 交给 SQLite 绑定，stored 交给 outbox/归档。

/** Checks and encodes a value of `column`; a `json(...)` value is serialized, not walked (R9). */
// 编码一个单元格：标量走 checkScalar + toSqlite；json 只做一次 JSON.stringify，不遍历内容（R9）。
// 输入 column/value/what，输出 Cell；无法序列化的值抛 invalid/args。
export function encodeCell(column: Column, value: unknown, what: string): Cell {
	if (column.type !== "json") {
		// 标量分支：检查后直接绑定，stored 是同一个标量。
		const stored = checkScalar(column.type, value, what);
		return { param: toSqlite(stored), stored };
	}
	// JSON 列的值类型是 unknown：任何可序列化 JSON 值都允许。
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw invalid("args", `${what}: not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	// JSON.stringify 可能因循环引用或 BigInt 抛错，这里转成 invalid/args 并保留原因。
	if (text === undefined) throw invalid("args", `${what}: not JSON`);
	// undefined 表示函数/undefined 等无法序列化的值。
	// `JSON.stringify` accepted it; the recorded value is the one serialized. It is kept, not copied or parsed back:
	// same-host values are immutable by convention, so the outbox serializing it again in the step records this text
	// (a plugin mutating a value after `tx.put` breaks that convention, as for any other value it hands over).
	// 上面注释解释了为什么不复制：param 是文本，stored 是原值；outbox 序列化时再次生成同一文本。
	// 若插件在 put 后修改原对象，会破坏 same-host 值不可变约定（与其它写入值相同）。
	return { param: text, stored: value as JsonValue };
}

/** Checks a scalar value of `column` and returns what is bound (booleans as 0 and 1). */
// 检查标量值并返回 SQLite 绑定值（布尔转 0/1）；json 列在这里被拒绝。
// 输入 column/value/what；输出 string|number；错误 invalid/args。
function encodeScalar(column: Column, value: unknown, what: string): string | number {
	if (column.type === "json") throw invalid("args", `${what}: a json(...) column has no scalar value`);
	// 条件编译阶段已保证不是 json 列；这里仍防御性地拒绝，因为函数是导出的信任边界。
	return toSqlite(checkScalar(column.type, value, what));
}

/**
 * A value of a scalar column type as the store keeps it (a trust boundary): `str` well-formed without NUL, `int` a
 * safe integer, `num` finite, `bool` a boolean; `invalid/args` otherwise.
 */
// 按标量类型检查值并返回可存储值；str 用 storedText 规范化并拒绝 NUL。
// 这是导入/写入的信任边界：类型注解不会阻止 JS 调用者传错类型；错误 invalid/args。
// 示例：checkScalar(int, 3, what) 返回 3；checkScalar(int, 3.5, what) 抛错。
export function checkScalar(type: "str" | "int" | "num" | "bool", value: unknown, what: string): Scalar {
	switch (type) {
		case "str":
			if (typeof value === "string") return storedText(value, what);
			// str 分支顺便修复孤立代理项并拒绝 NUL，与 storedText 的存储规则一致。
			break;
		case "int":
			if (Number.isSafeInteger(value)) return value as number;
			// int 只接受安全整数，保证 SQLite INTEGER 与 JS number 精确往返。
			break;
		case "num":
			if (typeof value === "number" && Number.isFinite(value)) return value;
			// num 要求有限数，排除 NaN/Infinity。
			break;
		case "bool":
			if (typeof value === "boolean") return value;
			// bool 严格布尔，不接受 0/1 数字。
			break;
	}
	// 所有分支失败后统一抛错；JSON.stringify(undefined) 返回 undefined，用 String 兜底显示。
	throw invalid("args", `${what}: ${JSON.stringify(value) ?? String(value)} is not a ${type} value`);
}
