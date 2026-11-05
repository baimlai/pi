// The store for adapters (slice 6b §2.1, D1, D2): what an owner outside Chord's objects (Durable's `StoreStorage`) uses
// to keep its data in the store as declared tables and engine documents: its tables declared and prepared under its
// owner name (claimed, the path `self.table` takes), rows encoded at staging and written in a step with what only the
// step knows, and its reads. Internal for adapters; apps use `openStore` and objects.
// 本文件给“宿主自己的对象之外”的适配器（如 Durable 的 StoreStorage）提供 store 访问层：
// 适配器用 owner 名义声明普通表，在提交步骤里写行，并按预编译语句读取。上游是适配器初始化与每次请求；
// 写入进入 store 的提交队列与事务，读取走传入的执行器。它不定义插件 API，应用层使用 objects 即可。
// 所属模块：packages/chord/src/store 的适配器存储接口（Durable StoreStorage 等宿主适配器使用）。
// 上下游：适配器创建 StoreOwnerTables -> declare 各表 -> prepare 建表/迁移 -> encode 行 -> put 进入 Step；
//   读取用 get/select 或预编译的 prepare/prepareGet/reader。下游依赖 TableSql、TableDefinition.rows、claims 与 table-migration。
// 结果：写入落在 store 事务中，读取返回 DecodedRow；声明冲突/命名非法为 invalid/args 或普通 Error，SQL 错误沿 Promise 传播。
// 能力清单：
// - DecodedRow：解码后的行对象。
// - StoreOwnerTables：owner 名下表的声明与统一 prepare。
// - OwnerTable：单张表的 encode/put/get/prepare/prepareFirst/prepareGet/jsonVersion/reader/select。
// 组合关系：ownerTables.declare(def) -> ownerTables.prepare(ctx) -> table.encode(row) -> table.put(step, encoded)；
//   读取侧先 prepare 缓存 SQL，再绑定 where 值调用执行器。
// 示例：const tables = new StoreOwnerTables(store, "durable", claimant);
//   const objects = tables.declare(objectDefinition); await tables.prepare(ctx); await objects.put(step, objects.encode(row));
// 阅读顺序：先 DecodedRow 与 StoreOwnerTables 的生命周期，再 OwnerTable 的 encode/put 写入路径，最后 get/select 与预编译读取。

import type { Context } from "../context/index.ts";
import { checkName } from "../contracts/internal.ts";
import type { SqliteExecutor, SqliteValue } from "../sqlite/index.ts";
import type { Claimant } from "./claims.ts";
import type { WhereNode } from "./expression.ts";
import type { EncodedRow } from "./rows.ts";
import { type Order, TableSql, tableSqlName } from "./sql.ts";
import type { Step } from "./step.ts";
import type { ChordStore } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import { prepareTables } from "./table-migration.ts";
import type { TableWrite } from "./table-writes.ts";

/** A stored row as reads decode it. */
// decode 之后的普通对象：键是列名，值已从 SQLite 存储形式还原（例如 json 列已由插件解码器转换）。
// 这是 adapter 层的返回形状，不是数据库原始行，也不是经过业务 schema 校验的领域对象。
export type DecodedRow = { readonly [column: string]: unknown };

/**
 * The tables of one owner name in a store: each declared once (its SQL name `"<owner>:<table>"` claimed for
 * `claimant`), then prepared together (created at their newest version or migrated, as `self.table`'s are).
 */
// 一个 owner 在 store 中的表集合。生命周期：declare 逐个声明并占据 SQL 名，prepare 一次性建表或迁移。
// 构造后不会自动建表；没有 prepare 就写入会因表不存在而失败。
export class StoreOwnerTables {
	readonly store: ChordStore;
	readonly owner: string;
	readonly #claimant: Claimant;
	readonly #tables: OwnerTable[] = [];

	/** `owner` is a restricted name (lowercase `[a-z0-9@/._~-]`): it becomes the first part of SQL names. */
	// 构造只保存引用并校验 owner 名，不声明表、不碰数据库；claimant 标识哪一方持有后续表名声明。
	constructor(store: ChordStore, owner: string, claimant: Claimant) {
		checkName(owner, "An owner name");
		this.store = store;
		this.owner = owner;
		this.#claimant = claimant;
	}

	/** Declares `definition` under the owner, claiming its SQL name (held by another: `invalid/args`). */
	// 声明一张表并返回可写入的 OwnerTable。表名由 owner 与定义名拼成；被他人占用时 claims.table 抛错。
	// 同一 owner 内重复声明同名表同样会失败，因为声明是独占的。
	declare(definition: TableDefinition): OwnerTable {
		const table = new OwnerTable(definition, tableSqlName(this.owner, definition.name));
		this.store.claims.table(table.sql.table, this.#claimant);
		this.#tables.push(table);
		return table;
	}

	/** Brings every declared table to its definition: created fresh, or migrated eagerly in their commits. */
	// 把已声明的全部表带到定义版本：新表一次创建，旧表按版本迁移。返回 Promise，出错时拒绝。
	// fence 的 admit 恒真、adopt 空实现：这些准备提交不属于某个可取消的调用方；`this.owner` 用于错误定位。
	prepare(context: Context): Promise<void> {
		const tables = this.#tables.map(({ definition, sql }) => ({ definition, table: sql.table }));
		// 字面量对象需满足 CommitFence：匿名函数忽略参数，行为分别是“总是允许”和“不做接纳”。
		const fence = { admit: () => true, adopt: () => {} };
		return prepareTables(tables, this.store, fence, this.owner, context);
	}
}

/** One declared table of an owner: its rows encoded and written in a step, its reads by key and by query. */
// 一张已声明表。构造时把定义编译成 TableSql（列、物理列序、主键），之后 encode/put/get/select 复用这份编译结果。
export class OwnerTable {
	readonly definition: TableDefinition;
	readonly sql: TableSql;

	/** 保存定义并编译 SQL 视图；不声明表名、不写数据库。definition 的属性是编译期类型，运行时行为来自 rows 编解码器。 */
	constructor(definition: TableDefinition, table: string) {
		this.definition = definition;
		this.sql = new TableSql(table, definition.columns, definition.rows.physical, definition.key);
	}

	/** `row` checked and encoded for a `put` (a trust boundary, rule 8: at staging, before the queue). */
	// 把外部行编码成存储参数。输入 unknown（调用方数据），返回 EncodedRow（row/params/columns）。
	// 这里是信任边界：在进入提交队列前完成校验与编码，避免坏数据在队列中才暴露。
	encode(row: unknown): EncodedRow {
		return this.definition.rows.put(row, this.definition.version);
	}

	/**
	 * Writes `encoded` in `step` (an upsert) and returns the `put` as recorded; `stamp` names an `int` column that takes
	 * the step's seq (Durable's `entries.commit_seq`), in the row and in the record.
	 */
	// 在给定 Step 中 upsert 一行，并返回与执行内容一致的 put 记录（用于 outbox/同步）。
	// stamp 可选：若给出某个 int 列名，就用本步骤的 seq 覆盖该列，确保行与其提交序号绑定。
	// 示例：await table.put(step, encoded, "commit_seq") 会写行，并在返回记录的 row 中带 commit_seq: step.seq。
	async put(step: Step, encoded: EncodedRow, stamp?: string): Promise<TableWrite> {
		const { version } = this.definition;
		const { table } = this.sql;
		// 无 stamp 时直接使用编码参数；有 stamp 时复制参数数组再按物理列下标替换，避免修改调用方持有的数组。
		if (stamp === undefined) {
			await step.run(this.sql.put, ...encoded.params);
			return { kind: "put", table, row: encoded.row, version, columns: encoded.columns };
		}
		const params = [...encoded.params];
		// indexOf 得到物理参数下标；stamp 不是已声明列时会得到 -1（definition 构造路径已保证列存在）。
		params[this.definition.rows.physical.indexOf(stamp)] = step.seq;
		await step.run(this.sql.put, ...params);
		// 计算属性名 `[stamp]` 把变量值作为键；记录里的行必须反映实际写入的 seq。
		return { kind: "put", table, row: { ...encoded.row, [stamp]: step.seq }, version, columns: encoded.columns };
	}

	/** The row with the key `params` (in key order), decoded. */
	// 按主键点查一行。输入执行器、按主键顺序排列的参数和上下文；返回解码行或 undefined（没有该行）。
	// `Pick<SqliteExecutor, "get">` 只要求执行器具备 get 方法，读取可来自事务外连接。
	async get(
		executor: Pick<SqliteExecutor, "get">,
		params: readonly SqliteValue[],
		context: Context,
	): Promise<DecodedRow | undefined> {
		const stored = await executor.get<{ [column: string]: SqliteValue }>(this.sql.get, ...params);
		// rows.decode 把存储值还原成外部形状；undefined 表示查询无结果，而不是解码失败。
		return stored === undefined ? undefined : this.definition.rows.decode(stored, context);
	}

	/**
	 * A read compiled once (the store's query vocabulary rendered to SQL): `columns` of the rows `where` matches in
	 * `order`. The values in `where` only shape it: each is a `?` the caller binds in the order the conditions take
	 * them, then the limit. Adapters keep their fixed reads so: no SQL is rendered per call.
	 */
	// 预编译一条查询，只返回 SQL 文本；where 中的值会变成 `?`，调用时按条件顺序再绑定，最后绑定 limit。
	// limit 传 0 表示不限制（由 select 的约定决定）；不返回参数，因为这里只缓存语句形状。
	prepare(columns: readonly string[], where: WhereNode | undefined, order: Order): string {
		return this.sql.select(where, order, undefined, 0, columns).sql;
	}

	/** `prepare` for the first row only: the limit is a literal `1` (a bound one costs SQLite a plan step per call). */
	// 与 prepare 相同，但把末尾的 `LIMIT ?` 替换为字面量 `LIMIT 1`，避免每次绑定参数。只应匹配到结尾这一处。
	prepareFirst(columns: readonly string[], where: WhereNode | undefined, order: Order): string {
		return this.sql.select(where, order, undefined, 1, columns).sql.replace(/LIMIT \?$/, "LIMIT 1");
	}

	/**
	 * The version of `json(...)` column `column`: at 1 every stored cell is at 1 (none is older, a newer one fails the
	 * owner when its table is prepared), so a read may leave the version column out.
	 */
	// 返回某个 json 列的当前版本号。输入列名；列不存在或不是 json 类型时抛普通 Error（这是适配器声明错误）。
	// 版本为 1 时读取无需版本列，调用方可用它决定是否选取隐藏版本列。
	jsonVersion(column: string): number {
		const found = this.definition.column(column, "jsonVersion");
		if (found.type !== "json") throw new Error(`${this.definition.name}: column "${column}" is no json(...) column`);
		return found.json.version;
	}

	/** A point lookup compiled once: `columns` of the row whose key the caller binds, in key order. */
	// 预编译按主键读取指定列的点查语句，返回 SQL。调用方按主键顺序绑定参数；列顺序即返回结果顺序。
	prepareGet(columns: readonly string[]): string {
		return this.sql.getColumns(columns);
	}

	/**
	 * The read of `json(...)` column `column`'s stored cells (`text` written at `version`, migrated on access), made
	 * once: an adapter selecting the cell itself reads it so.
	 */
	// 返回读取某个 json 单元格的解码函数。输入列名；返回 (text, version, context) => unknown。
	// 版本 1 时无需迁移，直接 JSON.parse；更高版本交给插件解码器 found.json.read，并把表.列作为错误位置。
	reader(column: string): (text: string, version: number, context: Context) => unknown {
		const found = this.definition.column(column, "reader");
		if (found.type !== "json") throw new Error(`${this.definition.name}: column "${column}" is no json(...) column`);
		// At version 1 a cell is the JSON it was written as: no version to compare, nothing to migrate.
		// 版本 1 的返回值忽略 version 与 context 参数，保持与高版本相同的函数签名。
		if (found.json.version === 1) return (text) => JSON.parse(text) as unknown;
		const what = `${this.sql.table}.${column}`;
		return (text, version, context) => found.json.read(text, version, what, context);
	}

	/** Up to `limit` rows matching `where` in `order`, decoded. */
	// 查询多行并逐行解码。输入执行器、where、排序、limit 和上下文；返回 DecodedRow[]。
	// SQL 与参数由 TableSql 现场渲染（适配器常用 prepare 缓存固定查询）；错误由执行器 Promise 传播。
	async select(
		executor: Pick<SqliteExecutor, "all">,
		where: WhereNode | undefined,
		order: Order,
		limit: number,
		context: Context,
	): Promise<DecodedRow[]> {
		const statement = this.sql.select(where, order, undefined, limit);
		const stored = await executor.all<{ [column: string]: SqliteValue }>(statement.sql, ...statement.params);
		// map 对每行独立解码；没有行时返回空数组，而不是 undefined。
		return stored.map((row) => this.definition.rows.decode(row, context));
	}
}
