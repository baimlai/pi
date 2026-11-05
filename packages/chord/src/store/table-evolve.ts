// `evolveTable(previous, (t) => t…)` (slice 6a §9; decision "Second spec review: the majority"): the next version of a
// table from the edits of one migration. The editor's types order the edits (`rename`, `add` and `json` before the
// data step, `drop`, `index` and `dropIndex` after it) and track the columns and key through the chain; at runtime one
// editor records the edits, checks each as it is made, and materializes the new version at the end.

// 本文件实现 evolveTable：从上一版本和一次迁移编辑生成下一版本。编辑器接口在类型层排定编辑顺序
// （rename/add/json 必须在数据步骤前，drop/index/dropIndex 之后），并在链式调用中追踪列与主键；
// 运行时只有一个 Editor 记录、逐项检查并最终物化新版本。
// 上游是 defineTable 或上一版 evolveTable；下游是 TableDefinition.evolution 与 table-migration。
//
// 能力清单（导出项）：
// - TableTailEditor：数据步骤之后的编辑器接口（drop/index/dropIndex），类型携带当前 C/K。
// - TableEditor：完整编辑器接口，额外提供 rename/add/json/rows/update。
// - AddedColumn：add 接受的列类型，必须 opt(...) 或带 default。
// - PatchOf：rows patch 的返回类型，只含非主键列的可选字段。
// - evolveTable：运行编辑回调，物化并指纹化 next version，返回新的 TableDefinition。
// 非导出：Editor（运行时状态与逐项检查）、Next/Renamed/With/Without/JsonNames/WithJson（类型工具）。
//
// 组合关系：编辑器在类型层排定顺序（rename/add/json → 数据步骤 → drop/index/dropIndex），
// 每次编辑返回携带新类型的自身；finish 把 before/step/after 组成 Migration 并链接 previous。
// 示例：evolveTable(V1, (t) => t.add("dir", str({ default: "" })))。
// 建议阅读顺序：TableTailEditor/TableEditor → AddedColumn/PatchOf → evolveTable → Editor → 末尾类型工具。

import { opt } from "../contracts/index.ts";
import { editWith, type Increment } from "../contracts/internal.ts";
import { isOptional, type Optional } from "../contracts/schema.ts";
import {
	type ColumnSchema,
	type Columns,
	type ColumnTypeOf,
	checkColumnName,
	columnRecord,
	describeColumns,
	type OrderColumn,
	type RowOf,
	type ValueOf,
} from "./columns.ts";
import { type Condition, compileSet, compileWhere, type SetOf } from "./expression.ts";
import type { ColumnRefs } from "./query.ts";
import { INDEX_NAME, orderColumns, TableDefinition, type TableOptions } from "./table.ts";
import type { DataStep, TableEdit } from "./table-history.ts";

/** The edits after the data step: `drop`, `index` and `dropIndex`; `C` and `K` are the columns and key so far. */
// TableTailEditor<C, K> 是数据步骤之后的编辑器：只有 drop/index/dropIndex；方法返回自身子类型，
// 使链式调用继续携带更新后的 C/K。~columns/~key 是纯类型字段，供 evolveTable 推断最终定义。
export interface TableTailEditor<C extends Columns, K extends readonly string[]> {
	/** Drops a non-key column; its indexes are dropped first, in the same commit. */
	// 删除非主键列；若索引包含该列，会先记录 dropIndex，保证 DDL 顺序合法。Without<C,N> 在类型层移除该列。
	drop<N extends Exclude<keyof C & string, K[number]>>(name: N): TableTailEditor<Without<C, N>, K>;
	/** Adds an index (`[a-z0-9_]+`) over non-`opt` `str` or `int` columns; it ends with the key. */
	// 新增索引，名字必须匹配 [a-z0-9_]+，列必须是当前表的非 opt str/int；C/K 不变。
	index(name: string, columns: readonly OrderColumn<C>[]): TableTailEditor<C, K>;
	/** Drops an index. */
	// 删除索引；C/K 不变。
	dropIndex(name: string): TableTailEditor<C, K>;
	/** Type only: the columns and key so far. */
	readonly "~columns"?: C;
	readonly "~key"?: K;
}

/** The editor `evolveTable`'s edit gets: every edit; the column edits only before the data step. */
// TableEditor<C, K> 继承 TableTailEditor，并加入只能在数据步骤之前做的 rename/add/json 与数据步骤本身。
// 每次编辑的返回类型都会变化（Renamed/With/WithJson），因此 TypeScript 会拒绝顺序错误或引用已删除列的调用。
export interface TableEditor<C extends Columns, K extends readonly string[]> extends TableTailEditor<C, K> {
	/** Renames a column; the key, the indexes and a `json(...)` column's version column follow. */
	// 重命名列：类型层用 Renamed 替换 C 的键、RenamedKey 替换主键中的名字；运行时同步索引与 json 版本列。
	rename<F extends keyof C & string, T extends string>(
		from: F,
		to: T,
	): TableEditor<Renamed<C, F, T>, RenamedKey<K, F, T>>;
	/** Adds a column: `opt(...)`, or a scalar one with a `default` (existing rows get it). */
	// 加列：类型层 With 把新列并入 C；S 被 AddedColumn 限制为 opt(...) 或带 default，保证旧行有值。
	add<N extends string, S extends AddedColumn>(name: N, column: S): TableEditor<With<C, N, S>, K>;
	/** A `json(...)` column's new version (its nullability kept): no DDL, no data step, cells migrate on access. */
	// 修改已有 json(...) 列的定义：N 被 JsonNames<C> 限制为 json 列名；WithJson 保留原可空性。
	json<N extends JsonNames<C>, S extends ColumnSchema>(name: N, column: S): TableEditor<WithJson<C, N, S>, K>;
	/**
	 * The data step: `patch` gets each row as the columns stand here and returns new values of non-key columns (`{}`
	 * stamps the row only); synchronous and pure, run in chunks of 100 in key order.
	 */
	// 数据步骤：patch 以当前列（RowOf<C>）为输入，返回非主键列的新值（PatchOf）；同步纯函数，按主键每 100 行执行。
	rows(patch: (row: RowOf<C>) => PatchOf<C, K>): TableTailEditor<C, K>;
	/** The data step as one `updateWhere` over the rows not migrated yet. */
	// 另一种数据步骤：把 where/set 编译成一条 updateWhere；where 可省略，set 可用回调按列引用构造。
	update(step: {
		readonly where?: (row: ColumnRefs<C>) => Condition;
		readonly set: SetOf<C, K> | ((row: ColumnRefs<C>) => SetOf<C, K>);
	}): TableTailEditor<C, K>;
}

/** A column `add` takes: `opt(...)` or one with a `default`. */
// AddedColumn = ColumnSchema & (Optional | { default: unknown })：编译期要求新增列要么是 opt(...)，要么有默认值；
// 运行时 add 还会再检查一次（JavaScript 调用者可能绕过类型）。
export type AddedColumn = ColumnSchema & (Optional | { readonly default: unknown });

/** A `rows` patch: new values of non-key columns; `undefined` clears an `opt(...)` one. */
// PatchOf 是 rows patch 的返回类型：键为非主键列的可选字段，值取该列的 ValueOf。
// 可选字段表示 patch 不必返回所有列；undefined 在运行时用于清空 opt 列。
export type PatchOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in Exclude<keyof C & string, K[number]>]?: ValueOf<C[P]>;
};

// 映射类型 + 键重映射（as）：P 是原列名，等于 F 时新键为 T，否则保持；值类型 C[P] 不变。纯类型运算。
type Renamed<C extends Columns, F extends keyof C, T extends string> = {
	readonly [P in keyof C as P extends F ? T : P]: C[P];
};

// 在主键元组上逐个映射：K[I] 等于 F 时改成 T，否则保留；用于让主键类型跟随 rename。
type RenamedKey<K extends readonly string[], F, T extends string> = {
	readonly [I in keyof K]: K[I] extends F ? T : K[I];
};

// 把新列 N 并入 C：键集合为 keyof C | N；P extends N 时取 S，否则从 C 取原 schema（P & keyof C 收窄）。
// 交叉类型让索引访问合法，同时避免把 N 误当旧列。
type With<C extends Columns, N extends string, S extends ColumnSchema> = {
	readonly [P in keyof C | N]: P extends N ? S : C[P & keyof C];
};

// 从 C 中排除键 N；用于 drop 后让类型层不再允许引用该列。Exclude 是编译期联合差集。
type Without<C extends Columns, N extends keyof C> = { readonly [P in Exclude<keyof C, N>]: C[P] };

// 先逐列判断：列类型为 "json" 则保留列名 P，否则得到 never；再用 [keyof C] 索引取出联合，
// 最后 & string 去掉可能的 symbol/number 键。结果是“所有 json 列名”的联合类型，仅编译期存在。
type JsonNames<C extends Columns> = { [P in keyof C]: ColumnTypeOf<C[P]> extends "json" ? P : never }[keyof C] & string;

// json 编辑只换列的 schema，但保留原列的可空性：旧列是 Optional 时给新 schema 再包一层 opt(...)；
// Exclude<S, Optional> 防止重复包装。类型层保证“json(...) 列的可空性不变”。
type WithJson<C extends Columns, N extends keyof C & string, S extends ColumnSchema> = With<
	C,
	N,
	C[N] extends Optional ? Optional<Exclude<S, Optional>> : S
>;

/** `V + 1` for a literal version (contracts' `Increment<N>`); `number` stays `number`. */
// 计算版本字面量 +1：number extends V 表示 V 不是字面量（而是宽泛 number），结果保持 number；
// 否则把 V 转成字符串模板，交给 contracts 的 Increment 做字符串数字加一，再 infer 回 number。
// 推断失败时退化为 number。纯类型运算，不产生运行时操作。
type Next<V extends number> = number extends V
	? number
	: `${Increment<`${V}`>}` extends `${infer N extends number}`
		? N
		: number;

/**
 * Appends the next version (`previous.version + 1`) with the edits `edit` makes; `edit` must return the editor it was
 * given. Every version is materialized and fingerprinted here; the object serves the newest, and its activation
 * migrates a store at an older version through each one.
 */
// 生成表的下一个版本：输入上一版本 previous 与编辑回调 edit，返回新 TableDefinition；不执行 SQL。
// 泛型 E 捕获回调返回的编辑器类型，从它的 ~columns/~key 提取最终列与主键，Next<V> 计算版本字面量。
// edit 必须返回传给它的同一个编辑器（editWith 在运行时检查）；任何不合法编辑都在这里同步抛 Error。
// 示例：evolveTable(V1, (t) => t.add("dir", str({ default: "" }))) 得到 version 2 的定义。
export function evolveTable<
	C extends Columns,
	K extends readonly string[],
	V extends number,
	E extends { readonly "~columns"?: Columns; readonly "~key"?: readonly string[] },
>(
	previous: TableDefinition<C, K, V>,
	edit: (t: TableEditor<C, K>) => E,
): TableDefinition<NonNullable<E["~columns"]>, NonNullable<E["~key"]>, Next<V>> {
	// The runtime editor works on untyped definitions; the types live in the editor interfaces.
	// 运行时编辑器按无类型定义工作；详细的泛型追踪只存在于编辑器接口，避免实现里到处写类型体操。
	const editor = new Editor(previous as unknown as TableDefinition);
	// The editor interfaces track the edits in the types; at runtime every edit returns the same editor.
	// editWith 调用回调并确认返回值就是传入的编辑器；as unknown as 是类型擦除边界上的必要断言。
	editWith(editor as unknown as TableEditor<C, K>, edit, `${previous.name}: evolveTable`);
	// finish 返回运行时定义；这里再断言成由 E/Next<V> 计算出的精确类型，供后续声明链使用。
	return editor.finish() as unknown as TableDefinition<NonNullable<E["~columns"]>, NonNullable<E["~key"]>, Next<V>>;
}

/**
 * The editor at runtime: the columns, key and indexes as the edits leave them, the edits before and after the data
 * step, and the step. Each edit is checked as it is made (declaration policy: JavaScript callers reach the checks).
 */
// Editor 是编辑器的运行时实现：维护列、主键、索引的当前状态，记录 before/after 编辑和可选数据步骤。
// 每个编辑即时检查（声明策略：JavaScript 调用者也会到达这些检查）；finish 时一次性物化并计算指纹。
class Editor {
	// 保存上一版本和错误信息前缀（表名 + 新版本号），便于定位声明错误。
	readonly #previous: TableDefinition;
	readonly #what: string;
	// 当前列 schema 的可变副本；rename/add/json/drop 都改它。
	#schemas: { [name: string]: ColumnSchema };
	// 主键列名副本；rename 会同步替换。
	#key: string[];
	// 索引名到列名的副本；rename/drop/index/dropIndex 维护它。
	readonly #indexes: Map<string, readonly string[]>;
	/** `before` until the data step or the first `drop`, `index` or `dropIndex`. */
	// 阶段标记：数据步骤或第一个 after 编辑后变为 "after"，之后拒绝 rename/add/json。
	#phase: "before" | "after" = "before";
	// 迁移的三部分：数据步骤前的编辑、可选步骤、步骤后的编辑。
	readonly #before: TableEdit[] = [];
	#step: DataStep | undefined;
	readonly #after: TableEdit[] = [];

	// 从上一版本复制可变的 schemas/key/indexes；不物化新定义，也不执行 I/O。
	constructor(previous: TableDefinition) {
		this.#previous = previous;
		this.#what = `${previous.name} version ${previous.version + 1}`;
		// 浅拷贝 schema 对象：编辑只替换/增加键，不修改上一版本的 schema 对象。
		this.#schemas = { ...previous.schemas };
		this.#key = [...previous.key];
		this.#indexes = new Map(previous.indexes);
	}

	// 重命名列 from→to：只能在数据步骤前；from 必须存在，to 必须符合列名规则且不与现有列冲突（大小写折叠后）。
	// 同时重写 schemas 键、key 与所有索引列，并记录 before 编辑；返回 this 以继续链式调用。
	rename(from: string, to: string): this {
		this.#assertBefore("rename");
		this.#assertColumn(from, "rename");
		// Checked here, not by the final definition: a later edit may rename it again, but this one runs as DDL.
		// 立即检查新名字，而不是等最终定义：后续还可能再改名，但本次 rename 会作为 DDL 立即执行。
		checkColumnName(to, `${this.#what}: rename`);
		this.#assertNewName(to, "rename", from);
		// 局部函数统一替换列名，避免在 schemas/key/indexes 三处重复 === 判断。
		const rename = (column: string): string => (column === from ? to : column);
		// 键重映射保留列顺序与 schema 引用；map 生成新的 [name, schema] 对。
		this.#schemas = Object.fromEntries(Object.entries(this.#schemas).map(([name, schema]) => [rename(name), schema]));
		this.#key = this.#key.map(rename);
		for (const [name, columns] of this.#indexes) this.#indexes.set(name, columns.map(rename));
		this.#before.push({ kind: "rename", from, to });
		return this;
	}

	// 新增列：只能在数据步骤前；名字不得与现有列冲突；列必须 opt(...) 或带 default，保证已有行能填充。
	// 记录 add 编辑（ColumnRecord）并更新 schemas；返回 this。
	add(name: string, column: ColumnSchema): this {
		this.#assertBefore("add");
		this.#assertNewName(name, "add");
		// 用 describeColumns 复用与 defineTable 相同的列校验；这里只取第一列。
		const [described] = describeColumns({ [name]: column }, `${this.#what}: add`);
		// 非 optional 且没有 default 的新列无法给旧行赋值（json 同样如此），声明阶段拒绝。
		if (!described!.optional && (described!.type === "json" || described!.default === undefined)) {
			throw new Error(`${this.#what}: add: column "${name}" needs opt(...) or a default (existing rows get it)`);
		}
		this.#schemas[name] = column;
		// 目录/迁移记录只保存纯数据 ColumnRecord。
		this.#before.push({ kind: "add", name, column: columnRecord(described!) });
		return this;
	}

	// 修改现有 json(...) 列的定义：列必须已是 json 列；传 json(...) 本身，可空性由旧列决定。
	// 新版本不得回退；同版本必须同指纹（否则单元格无法判断该用哪个 schema）；记录 json 编辑。
	json(name: string, column: ColumnSchema): this {
		this.#assertBefore("json");
		// 先物化现有列，读取其 json 版本/指纹与 optional 标记。
		const existing = describeColumns({ [name]: this.#assertColumn(name, "json") }, this.#what)[0]!;
		if (existing.type !== "json") throw new Error(`${this.#what}: json: column "${name}" is not a json(...) column`);
		// 签名允许 ColumnSchema，但这里要求传未包 opt 的 json(...)；可空性跟随旧列。
		if (isOptional(column)) {
			throw new Error(`${this.#what}: json: pass json(...) itself; the column keeps its nullability`);
		}
		// 保留原来的可空性：旧列 optional 时把新 schema 包成 opt(...)。
		const schema = existing.optional ? opt(column) : column;
		// 再物化一次，得到新版本的 json 定义与最终 ColumnRecord。
		const described = describeColumns({ [name]: schema }, `${this.#what}: json`)[0]!;
		if (described.type !== "json") throw new Error(`${this.#what}: json: expected a json(...) column`);
		const [before, after] = [existing.json, described.json];
		// D9 across table versions: a cell's version says which schema it was written with.
		// 单元格版本记录它按哪个 schema 写入；版本回退或同版本换 schema 都会让旧数据无法解释。
		if (after.version < before.version) {
			throw new Error(`${this.#what}: json: column "${name}" goes back from version ${before.version}`);
		}
		if (after.version === before.version && after.fingerprint !== before.fingerprint) {
			throw new Error(
				`${this.#what}: json: column "${name}" changes its schema at version ${before.version} (raise its version)`,
			);
		}
		this.#schemas[name] = schema;
		this.#before.push({ kind: "json", name, column: columnRecord(described) });
		return this;
	}

	// 记录 rows 数据步骤：patch 必须是函数；#current() 物化“步骤时的列形态”作为 table，供迁移读取。
	// 之后的编辑进入 after 阶段；返回 TableTailEditor（运行时仍是 this）。
	rows(patch: (row: { readonly [column: string]: unknown }) => unknown): this {
		this.#assertBefore("rows");
		// 运行时检查回调类型，防止 JavaScript 调用者传入非函数。
		if (typeof patch !== "function") throw new Error(`${this.#what}: rows: expected a function`);
		this.#step = { kind: "rows", table: this.#current(), patch };
		this.#phase = "after";
		return this;
	}

	// 记录 update 数据步骤：可选 where 与 set 可以是回调（收到列引用）或已构造的值；
	// where 编译为 WhereNode，set 编译为 SetNode。编译发生在声明时，错误会立即抛出，而不是等到迁移执行。
	update(step: { readonly where?: unknown; readonly set: unknown }): this {
		this.#assertBefore("update");
		const table = this.#current();
		const what = `version ${table.version} update`;
		// 函数形式在这里立即调用，传入 table.refs；非函数则视为已构造的 Condition/SetOf。
		const where = typeof step.where === "function" ? step.where(table.refs) : step.where;
		const set = typeof step.set === "function" ? step.set(table.refs) : step.set;
		this.#step = {
			kind: "update",
			table,
			// compileWhere 校验列引用与操作数类型；compileSet 校验非键列、空 set、undefined 清空等规则。
			where: where === undefined ? undefined : compileWhere(table, where, what),
			set: compileSet(table, set, what),
		};
		this.#phase = "after";
		return this;
	}

	// 删除列：只能在 after 阶段；必须是现有非主键列。包含该列的索引先记录 dropIndex，再从 schemas 删除该列。
	// 返回 this；类型层已用 Without 表示该列不复存在。
	drop(name: string): this {
		this.#phase = "after";
		this.#assertColumn(name, "drop");
		if (this.#key.includes(name)) throw new Error(`${this.#what}: drop: "${name}" is a key column`);
		// 索引列引用被删列会阻止 DROP COLUMN，因此先删索引，并把 dropIndex 记在 drop 之前。
		for (const [index, columns] of this.#indexes) {
			if (!columns.includes(name)) continue;
			this.#indexes.delete(index);
			this.#after.push({ kind: "dropIndex", name: index });
		}
		// 对象解构的 rest 语法排除 name 键，得到新对象；_dropped 只是占位变量。
		const { [name]: _dropped, ...schemas } = this.#schemas;
		this.#schemas = schemas;
		this.#after.push({ kind: "drop", name });
		return this;
	}

	// 新增索引：只能在 after 阶段；名字符合 INDEX_NAME 且未存在；索引列按“当前编辑点”的列校验。
	// 记录 index 编辑；返回 this。
	index(name: string, columns: readonly string[]): this {
		this.#phase = "after";
		const what = `${this.#what}: index "${name}"`;
		if (!INDEX_NAME.test(name)) throw new Error(`${what}: expected [a-z0-9_]+`);
		if (this.#indexes.has(name)) throw new Error(`${what} exists`);
		// Checked against the columns at this edit: the migration creates the index here, whatever later edits do.
		// 只按本次编辑点的列校验：后续 drop 不会追溯撤销这里已经合法创建的索引。
		const byName = new Map(describeColumns(this.#schemas, this.#what).map((column) => [column.name, column]));
		const checked = orderColumns(byName, columns, what);
		this.#indexes.set(name, checked);
		this.#after.push({ kind: "index", name, columns: checked });
		return this;
	}

	// 删除索引：只能在 after 阶段；必须存在。Map.delete 返回 false 表示不存在，直接报错。
	dropIndex(name: string): this {
		this.#phase = "after";
		if (!this.#indexes.delete(name)) throw new Error(`${this.#what}: dropIndex: no index "${name}"`);
		this.#after.push({ kind: "dropIndex", name });
		return this;
	}

	/** The new version, materialized and fingerprinted, linked to the previous one and the migration from it. */
	// 结束编辑：把三部分组成 Migration，用新版本号、最终列/键/索引物化 TableDefinition，
	// 并通过 evolution 链接上一版本；目录指纹在这里计算。
	finish(): TableDefinition {
		const migration = { before: this.#before, step: this.#step, after: this.#after };
		return new TableDefinition(this.#previous.name, this.#options(), { previous: this.#previous, migration });
	}

	/** The table as the edits so far leave it, at the new version: what a data step reads and writes. */
	// 按目前编辑结果物化一个“临时定义”，供数据步骤读取列和引用；它不是最终版本，不带 evolution。
	// 例如 rows 的 patch 通过它拿到列名/键，update 通过它的 refs 编译表达式。
	#current(): TableDefinition {
		return new TableDefinition(this.#previous.name, this.#options());
	}

	// 组装构造新版本所需的 TableOptions：版本 +1，复制 schemas/key/indexes，避免后续修改影响已物化定义。
	// 返回类型断言是必要的：这里用宽泛的 Columns/never[] 构造，最终由 evolveTable 断言为精确类型。
	#options(): TableOptions<Columns, readonly never[]> {
		const version = this.#previous.version + 1;
		const options = {
			version,
			columns: { ...this.#schemas },
			key: [...this.#key],
			indexes: Object.fromEntries(this.#indexes),
		};
		// The key and indexes are names the edits kept; the constructor checks them as it checks a base's.
		// 主键与索引名字都由编辑维护；构造器会像检查基准定义一样再次检查。
		return options as unknown as TableOptions<Columns, readonly never[]>;
	}

	// 编辑顺序策略：一旦进入 after 阶段（数据步骤或 drop/index/dropIndex），rename/add/json 就不可再用。
	// 原因：before 编辑会成为迁移开头的 DDL，而 after 编辑发生在数据步骤之后，顺序颠倒会引用错误列。
	#assertBefore(edit: string): void {
		if (this.#phase === "after") {
			throw new Error(`${this.#what}: ${edit} comes before the data step and before drop, index and dropIndex`);
		}
	}

	/**
	 * `name` names no column yet, also ignoring ASCII case (SQLite's column names do): checked per edit, since a later
	 * `drop` cannot take back an `add` the migration runs first. A rename may change only the case of `from`.
	 */
	// 检查新列名尚未存在，并按 ASCII 大小写折叠比较：SQLite 列名大小写不敏感，Foo 与 foo 视为冲突。
	// from 是 rename 的旧名，允许只改大小写；每次编辑都检查，因为后面 drop 无法撤销更早执行的 add。
	#assertNewName(name: string, edit: string, from?: string): void {
		const folded = foldAscii(name);
		for (const existing of Object.keys(this.#schemas)) {
			if (existing !== from && foldAscii(existing) === folded) {
				throw new Error(
					`${this.#what}: ${edit}: column "${existing}" exists (names differing only in case collide)`,
				);
			}
		}
	}

	// 断言列存在并返回其 schema；Object.hasOwn 只查自有属性，避免原型链上的同名键被误认。
	#assertColumn(name: string, edit: string): ColumnSchema {
		if (!Object.hasOwn(this.#schemas, name)) throw new Error(`${this.#what}: ${edit}: no column "${name}"`);
		return this.#schemas[name]!;
	}
}

/** `name` with ASCII letters lowercased and nothing else changed, as SQLite folds identifiers. */
// 按 SQLite 标识符规则只折叠 ASCII 大写字母，其他字符（包括 Unicode）保持不变；
// 例如 "Foo" → "foo"，而全角字母不折叠。
function foldAscii(name: string): string {
	return name.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}
