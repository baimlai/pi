// Table definitions (slice 6a §5, §9; decisions "Flat columns", "Restricted names", "Index definitions are recorded"):
// `defineTable(name, { version, columns, key, indexes? })`, checked and materialized once at declaration: its columns,
// its key, its indexes, its fingerprint and the compiled row codec its writes and reads use. A version `evolveTable`
// appends links to the one before it and to the migration between them.

// 本文件负责表声明的物化：defineTable 把插件的 { version, columns, key, indexes } 检查一次，生成列列表、
// 按名索引、主键、索引、指纹、行编解码器和条件引用，供 store 建表、校验迁移与生成 SQL。
// 上游是插件声明的 schema；下游是 table-migration（创建/迁移）、table-writes（读写）和 table-handle（查询），
// 版本链由 table-evolve.ts 追加。
//
// 能力清单（导出项）：
// - TableOptions：defineTable 的输入类型（version/columns/key/indexes）。
// - KeyOf<C, K>：由主键列名元组推导出的键对象类型，纯编译期。
// - defineTable：声明基准版本，检查并返回物化后的 TableDefinition。
// - TABLE_FORM_VERSION：指纹输入格式版本，指纹会持久化，格式变化必须换号。
// - INDEX_NAME：索引名规则 [a-z0-9_]+。
// - Evolution：上一版本定义与迁移，构成版本链的一环。
// - TableDefinition：一个版本的物化定义（列、主键、索引、指纹、行编解码器、列引用）。
// - orderColumns：校验并复制主键/索引/排序使用的列名。
// - tableFingerprint：列按名排序后的结构指纹，与声明顺序无关。
//
// 典型调用顺序：defineTable 建基准版本 → evolveTable 逐版追加 → store 激活时比较 version/fingerprint
// 决定 create/ready/migrate → 查询与写入复用 definition.rows/refs。
// 示例：const Edits = defineTable("edits", { version: 1, columns: { id: str() }, key: ["id"] });
// 建议阅读顺序：TableOptions/KeyOf → TableDefinition 字段 → 构造函数 → orderColumns → tableFingerprint。

import { checkName, hash64 } from "../contracts/internal.ts";
import {
	type Column,
	type ColumnRecord,
	type Columns,
	columnRecord,
	describeColumns,
	type OrderColumn,
} from "./columns.ts";
import { type ColumnRef, columnRefs } from "./expression.ts";
import { RowCodec } from "./rows.ts";
import type { Migration } from "./table-history.ts";

/** What `defineTable` takes. */
// TableOptions<C, K, V>：C 是 columns 对象类型，K 是主键列名组成的元组类型，V 是版本号字面量类型。
// 这些泛型只在编译期约束调用者；运行时仍会逐项检查版本、主键和索引（声明策略），因为 JavaScript 调用者可能绕过类型。
export type TableOptions<C extends Columns, K extends readonly OrderColumn<C>[], V extends number = number> = {
	/** The table's version: a positive integer, raised by every change (`evolveTable`). */
	readonly version: V;
	readonly columns: C;
	/** The primary key's columns, non-`opt` `str` or `int` ones. */
	readonly key: K;
	/** Secondary indexes by name (`[a-z0-9_]+`); each ends with the primary key. */
	readonly indexes?: { readonly [name: string]: readonly OrderColumn<C>[] };
};

/** The key of a row of a table with columns `C` and key `K`: an object with exactly the key columns. */
// KeyOf 用映射类型构造主键对象：K[number] 把主键列名元组变成列名联合类型，P 逐个取列名。
// 条件类型读取列 schema 上的 "~kind" 标记：Integer 类型得到 number，其余（str）得到 string。
// 这完全是编译期类型运算，运行时没有对应检查，也不会生成任何字段。
export type KeyOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in K[number]]: P extends keyof C
		? C[P] extends { readonly "~kind": "Integer" }
			? number
			: string
		: never;
};

/**
 * Declares a table: a base version written in full, the first of its history. Later versions come from
 * `evolveTable`; a new base starts a new history.
 */
// 声明一个表的基准版本：输入表名与选项，返回已物化的 TableDefinition；不执行 I/O。
// 泛型 const K 让数组字面量保留为元组，从而把主键列名记录成字面量类型；V 同理保留版本字面量。
// 示例：defineTable("edits", { version: 1, columns: { id: str() }, key: ["id"] })。
// 名称、版本、主键或索引不合法时同步抛 Error：这是声明阶段的开发者错误，不是运行期 ChordError。
export function defineTable<C extends Columns, const K extends readonly OrderColumn<C>[], const V extends number>(
	name: string,
	options: TableOptions<C, K, V>,
): TableDefinition<C, K, V> {
	// 构造器完成全部检查与物化；这里只做转交，不保留 options 引用以外的状态。
	return new TableDefinition(name, options);
}

/** The table form's version: the fingerprints of table definitions are persisted, so their input is versioned. */
// 指纹输入格式的版本号：指纹会写入 store，格式一旦变化必须换号，否则旧的已存指纹会与新算法静默不一致。
export const TABLE_FORM_VERSION = 1;

/** The index name rule. */
// 索引名规则：只允许小写字母、数字和下划线；建索引和查目录时都按这个约定生成标识符。
export const INDEX_NAME = /^[a-z0-9_]+$/;

/** How a version came about: the version before it and the migration from there, for one `evolveTable`. */
// Evolution 记录一个版本如何而来：previous 是上一版定义，migration 是从上一版迁到本版的编辑与数据步骤；
// 基准版本的 evolution 为 undefined，historyOf 正是沿这条链回溯出完整历史。
export type Evolution = { readonly previous: TableDefinition; readonly migration: Migration };

/**
 * A declared table at one version: its columns in declaration order, key, indexes (declared columns; the key is
 * appended when they are rendered), the fingerprint of all of it and the row codec. `C` and `K` type its rows and keys,
 * `V` its version.
 */
// TableDefinition 是一张表在某个版本上的完整声明。C/K/V 分别给出行、主键和版本的类型，全部是编译期信息。
// 实例字段在构造时算好，之后只读使用。TypeScript 只检查声明，不阻止 JavaScript 调用者传入坏值，
// 因此构造函数里的检查属于“声明策略”信任边界。
export class TableDefinition<
	C extends Columns = Columns,
	K extends readonly string[] = readonly string[],
	V extends number = number,
> {
	// 表名（不含 owner 前缀）；store 落库时会拼成 <owner>:<table>。
	readonly name: string;
	// 正整数版本；每次 evolveTable 加一，store 用它判断建表、直接用还是迁移。
	readonly version: V;
	/** The column schemas as declared, which `evolveTable` edits into the next version's. */
	// 原始列 schema 保留下来，供 evolveTable 复制并编辑到下一版本；它不是物化后的 Column 列表。
	readonly schemas: Columns;
	// describeColumns 物化后的列数组，顺序即声明顺序，影响物理列顺序和记录顺序。
	readonly columns: readonly Column[];
	// 按列名查 Column 的 Map；与 columns 同源，供查询、写入和迁移的校验使用。
	readonly byName: ReadonlyMap<string, Column>;
	// 主键列名，经 orderColumns 校验：存在、非 opt、类型为 str 或 int、不重复。
	readonly key: readonly string[];
	// 索引名到“已声明列”的映射；渲染 SQL 时才把主键追加到末尾。
	readonly indexes: ReadonlyMap<string, readonly string[]>;
	/** `hash64` of the columns, key and indexes in `TABLE_FORM_VERSION`'s form. */
	// 列、主键和索引规范形式的 hash64；store 用它在同版本下发现定义被原地改动（历史被编辑）。
	readonly fingerprint: string;
	/** The columns as the `table` write records them. */
	// 写入目录表的纯数据形式（ColumnRecord），可 JSON.stringify 持久化，不包含运行时对象。
	readonly record: { readonly [name: string]: ColumnRecord };
	// 行编解码器：把行编码成 SQL 列值、把列值解码成行；table-writes 与 table-handle 都复用它。
	readonly rows: RowCodec;
	/** One reference per column, for the `(t) => …` callbacks of queries and writes. */
	// 每列一个 ColumnRef；回调里的 e.path 取到的就是这里的引用对象，用来构造条件或表达式。
	readonly refs: { readonly [column: string]: ColumnRef };
	/** The version before this one and the migration from it; `undefined` for a base. */
	// 上一版本与迁移；基准版本为 undefined，historyOf 沿这条链回溯出完整历史。
	readonly evolution: Evolution | undefined;
	/** Type only: the columns and key. */
	// declare 字段只存在于类型层：不会生成运行时属性，也不参与类实例布局，仅用于携带 C/K 类型。
	declare readonly "~columns"?: C;
	declare readonly "~key"?: K;

	// 物化一个版本：检查表名与版本号，物化列和按名索引，校验并复制主键/索引列，
	// 最后计算目录记录、指纹、行编解码器和条件引用。同步执行、无 I/O；任何非法声明都抛 Error。
	// 示例：new TableDefinition("edits", { version: 1, columns: { id: str() }, key: ["id"] })。
	constructor(name: string, options: TableOptions<C, K & readonly OrderColumn<C>[], V>, evolution?: Evolution) {
		// 表名规则来自 contracts；不合法时在这里失败，不会产生半成品定义。
		checkName(name, "table");
		// 解构同时给 indexes 默认值 {}：省略索引很常见，避免后续对 undefined 做分支。
		const { version, columns, key, indexes = {} } = options;
		// Declaration policy: JavaScript callers reach these checks.
		// 声明策略：版本必须是正安全整数；即使调用者绕过 TS 类型，运行时也会拦住。
		if (!Number.isSafeInteger(version) || version < 1)
			throw new Error(`${name}: version ${version} is not a positive integer`);
		this.name = name;
		this.version = version;
		// 保留原始 schema 对象引用；evolveTable 会基于它生成下一版本的列。
		this.schemas = columns;
		// 物化列描述并检查列名/默认值/json 版本等；结果顺序就是声明顺序。
		this.columns = describeColumns(columns, name);
		// Map 提供 O(1) 的列名查找；插入顺序与 columns 一致。
		this.byName = new Map(this.columns.map((column) => [column.name, column]));
		// 主键经统一校验后复制成普通数组；空主键在下一行单独拒绝。
		this.key = orderColumns(this.byName, key, `${name}: the key`);
		if (this.key.length === 0) throw new Error(`${name}: the key has no column`);
		// 每个索引先检查名字规则，再校验列；as const 让返回值被推断为 [name, columns] 元组。
		this.indexes = new Map(
			Object.entries(indexes).map(([index, columns]) => {
				if (!INDEX_NAME.test(index)) throw new Error(`${name}: index "${index}": expected [a-z0-9_]+`);
				return [index, orderColumns(this.byName, columns, `${name}: index "${index}"`)] as const;
			}),
		);
		// 目录记录是纯数据：逐列转成 ColumnRecord，键顺序与 columns 一致。
		this.record = Object.fromEntries(this.columns.map((column) => [column.name, columnRecord(column)]));
		// 指纹只覆盖记录、主键和索引；声明顺序差异会被规范化掉。
		this.fingerprint = tableFingerprint(this.record, this.key, this.indexes);
		// 预先编译行编解码器：读写热路径直接复用，避免每次重新计算物理列。
		this.rows = new RowCodec(this.columns, this.key, name);
		// 每列一个引用对象；查询与 set 回调通过它取得带类型的列句柄。
		this.refs = columnRefs(this.columns);
		this.evolution = evolution;
	}

	/** The column `name`; an unknown one throws (`what` names the use). */
	// 按名取列，供编译查询/写入/迁移时使用。找不到说明插件引用了不存在的列，直接抛 Error；
	// what 用来在错误里指出是哪个调用点（例如查询条件或 set）。这个错误属于调用方参数错误，不是存储错误。
	column(name: string, what: string): Column {
		const column = this.byName.get(name);
		if (column === undefined) throw new Error(`${this.name}: ${what}: no column "${name}"`);
		return column;
	}
}

/**
 * Checks `names` as key, index or order columns of a table whose columns are `byName`: existing, non-`opt` `str` or
 * `int`, no column twice (declaration policy: JavaScript callers reach it); `what` names the use in errors.
 */
// 校验并复制一组成员列名，供主键、索引和查询排序共用：列必须存在、非 opt、类型为 str 或 int、不得重复。
// 这些是声明策略的运行时检查（JavaScript 调用者也可能进来）；返回新数组，避免调用者随后修改内部状态。
// 示例：orderColumns(byName, ["id"], "edits: the key") 返回 ["id"] 的副本。
export function orderColumns(
	byName: ReadonlyMap<string, Column>,
	names: readonly string[],
	what: string,
): readonly string[] {
	// Array.isArray 是运行时检查：TS 的 readonly string[] 不保证 JavaScript 调用者真的传数组。
	if (!Array.isArray(names)) throw new Error(`${what}: expected an array of column names`);
	// 用 Set 去重后比较长度，O(n) 发现重复列；重复列会让 SQL 生成歧义。
	if (new Set(names).size !== names.length) throw new Error(`${what}: a column occurs twice`);
	for (const name of names) {
		const column = byName.get(name);
		if (column === undefined) throw new Error(`${what}: no column "${name}"`);
		// 排序列参与 SQL 比较/索引：opt 会引入 NULL 排序歧义，json 等类型不可排序，故只允许 str 或 int。
		if (column.optional || (column.type !== "str" && column.type !== "int")) {
			throw new Error(`${what}: column "${name}" is not a non-opt str() or int() column`);
		}
	}
	// 返回副本而不是原数组：调用者传入的数组之后如何变化都不影响已物化的定义。
	return [...names];
}

/** The fingerprint of a table's columns, key and indexes; column and index names sorted (their order is no change). */
// 计算表的规范指纹：列按名排序、索引按名排序后再序列化，因此声明顺序不同但结构相同会得到同一指纹；
// 主键保持顺序（键顺序影响 SQL 的比较和索引），hash64 的输入带 TABLE_FORM_VERSION。
// 示例：两个 columns 键顺序相反、内容相同的 defineTable 调用会得到相同 fingerprint。
export function tableFingerprint(
	columns: { readonly [name: string]: ColumnRecord },
	key: readonly string[],
	indexes: ReadonlyMap<string, readonly string[]>,
): string {
	// value 是规范化后的结构：columns/indexes 已排序，key 原样保留其顺序。
	const value = { columns: sorted(Object.entries(columns)), key, indexes: sorted([...indexes]) };
	// JSON.stringify 的键顺序由构造 value 时确定；hash64 让指纹短且稳定。
	return hash64(JSON.stringify({ tableFormVersion: TABLE_FORM_VERSION, value }));
}

// 把 [name, value] 条目按名排序并还原成对象；对象自身的键顺序不影响 JSON.stringify 的结果顺序。
function sorted<T>(entries: [string, T][]): { [name: string]: T } {
	// 手工比较字符串而不是 localeCompare，保证排序与运行环境的 locale 无关。
	return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
