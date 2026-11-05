// Table writes (slice 6a §5, §7, §9; S17; decisions "Writes carry their versions", "Index definitions are recorded"):
// the recorded form of every table write, the staged writes a transaction or an activation hands the commit step
// (their SQL rendered at staging, rule 8), and the appliers of the schema writes, which render DDL from the record.

// 本文件定义表写的记录形式（TableWrite 联合）、把事务/激活的写入暂存为 StagedWrite（SQL 在暂存时渲染，rule 8），
// 以及架构写的 applier（根据记录渲染 DDL 并更新 step 的目录）。记录随后进入 outbox 与归档，供副本重放。
// 上游是 TableChanges 与迁移计划；下游是 store 的提交步骤和归档导入的 applier。
//
// 能力清单（导出项）：
// - TableWrite：所有表写的记录联合（table/index/dropIndex/alter 与 put/update/delete/updateWhere/deleteWhere）。
// - StoredKey：写入记录的键（列名到已编码标量）。
// - ColumnVersions：一次写涉及的 json(...) 列版本，按列名。
// - TableDefinitionWrite：TableWrite 中 table 变体的精确类型。
// - jsonVersions / recordedVersions：计算 set 中 json 列要打/要记录的版本。
// - stageTable/stageIndex/stageEdit：架构写的暂存形式（提交时执行 DDL 并产生记录）。
// - stagePut/stageUpdate/stageDelete/stageUpdateWhere/stageDeleteWhere：行写的暂存形式。
// - applyTable/applyIndex/applyDropIndex/applyAlter：applier，执行 DDL 并同步 step 的目录记录。
// 非导出：counted（行写的共同实现）与 recorded（取当前目录记录，缺失即失败）。
//
// 组合关系：编译好的 Statement/编码行 → stage* 包装成 StagedWrite（order "write"）；
// 提交步骤调用其 apply，执行 SQL 或 DDL、更新目录，并返回 TableWrite 供 outbox/归档；
// 归档重放直接调用同一个 applier，保证记录与执行一致。
// 示例：const staged = stageUpdate(statement, "app.store:edits", { id: "e001" }, set, columns);
// 建议阅读顺序：TableWrite → StoredKey/ColumnVersions → jsonVersions/recordedVersions → stage* → counted →
// applyTable/applyIndex/applyDropIndex/applyAlter → recorded。

import type { TableRecord } from "./catalog.ts";
import type { ColumnRecord } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import type { EncodedRow, Scalar, StoredRow } from "./rows.ts";
import { versionColumn } from "./rows.ts";
import { columnSql, createIndexSql, createTableSql, dropIndexSql, quote, type Statement } from "./sql.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { TableDefinition } from "./table.ts";
import type { AlterEdit, TableEdit } from "./table-history.ts";

/** A key as writes record it: the key columns' stored values. */
// 写入记录的键：列名到已存储标量值；例如 { id: "e001" }。值已编码为 SQLite 可绑定类型。
export type StoredKey = { readonly [column: string]: Scalar };

/** `json(...)` columns' versions written by a write, by column. */
// 一次写入涉及的 json(...) 列版本，按列名记录；副本重放时据此给单元格打上正确版本。
export type ColumnVersions = { readonly [column: string]: number };

/** The table writes as the outbox and archives record them. */
// TableWrite 是表写入的完整词汇。table/index/dropIndex/alter 改结构（DDL 与目录）；
// put/update/delete/updateWhere/deleteWhere 改行，并记录影响行数 count 与 json 列版本 columns。
// 这些对象会被 JSON 序列化进 outbox/归档；类型只描述代码构造的形状，从归档读入时仍需 applier 在信任边界校验。
export type TableWrite =
	// 表的完整记录：版本、状态（ready/migrating）、列、主键、指纹；用于建表或替换目录记录。
	| {
			readonly kind: "table";
			readonly table: string;
			readonly version: number;
			readonly state: "ready" | "migrating";
			readonly columns: { readonly [name: string]: ColumnRecord };
			readonly key: readonly string[];
			readonly fingerprint: string;
	  }
	// 新增索引：名字与声明列；主键在渲染 SQL 时追加。
	| { readonly kind: "index"; readonly table: string; readonly name: string; readonly columns: readonly string[] }
	// 删除索引。
	| { readonly kind: "dropIndex"; readonly table: string; readonly name: string }
	/** A column edit of the migration to `version`; DDL rendered from it. */
	// 迁移的一步结构编辑；version 是目标表版本，edit 决定具体 DDL。
	| { readonly kind: "alter"; readonly table: string; readonly version: number; readonly edit: AlterEdit }
	// 整行 upsert：row 是编码后的行（含 json 版本列），version 是写入时的表版本。
	| {
			readonly kind: "put";
			readonly table: string;
			readonly row: StoredRow;
			/** The row's eager-step version (the table's version at the `put`). */
			readonly version: number;
			readonly columns: ColumnVersions;
	  }
	// 按键更新：set 为编译后的赋值，count 为受影响行数；迁移的 rows 步骤还带 version 以标记行的 $v。
	| {
			readonly kind: "update";
			readonly table: string;
			readonly key: StoredKey;
			readonly set: SetNode;
			readonly columns: ColumnVersions;
			readonly count: number;
			/** A migration's data step: the version it stamps as the row's `$v` (a plugin's `update` never does). */
			readonly version?: number;
	  }
	// 按键删除；count 为实际删除行数（0 表示键不存在）。
	| { readonly kind: "delete"; readonly table: string; readonly key: StoredKey; readonly count: number }
	// 条件批量更新；where/set 已编译，count 用于副本一致性检查。
	| {
			readonly kind: "updateWhere";
			readonly table: string;
			readonly where: WhereNode;
			readonly set: SetNode;
			readonly columns: ColumnVersions;
			readonly count: number;
			/** A migration's `update` step: the version it stamps as the rows' `$v`. */
			readonly version?: number;
	  }
	// 条件批量删除。
	| { readonly kind: "deleteWhere"; readonly table: string; readonly where: WhereNode; readonly count: number };

/** The versions of the `json(...)` columns of `definition` that `set` writes, which its statement stamps. */
// 收集 set 写到的 json(...) 列及其定义版本；只有 set 中出现的列需要打版本。
// definition.byName.get(name)! 的非空断言由 compileSet 保证：set 只能包含已知列。
export function jsonVersions(definition: TableDefinition, set: SetNode): ReadonlyMap<string, number> {
	const versions = new Map<string, number>();
	for (const name of Object.keys(set)) {
		const column = definition.byName.get(name)!;
		if (column.type === "json") versions.set(name, column.json.version);
	}
	return versions;
}

/** The `columns` a write records: the versions of the `json(...)` columns it sets to a value (a clear has none). */
// 把“要打版本的列”转成写入记录的 columns：只保留本次真正赋值的 json 列（set[column] !== null）。
// 清空 opt json 列时版本列写 NULL，副本不需要迁移版本，因此不记录。
export function recordedVersions(set: SetNode, versions: ReadonlyMap<string, number>): ColumnVersions {
	const columns: { [column: string]: number } = {};
	for (const [column, version] of versions) if (set[column] !== null) columns[column] = version;
	return columns;
}

/** The `table` write. */
// Extract<TableWrite, { kind: "table" }> 从联合中取出 table 变体的精确类型；仅编译期。
export type TableDefinitionWrite = Extract<TableWrite, { readonly kind: "table" }>;

/** Stages a `table` write: the table created when the store does not have it yet, its record replaced otherwise. */
// 暂存 table 写：apply 在提交步骤内调用 applyTable，并把返回的写记录交给 outbox。
// order "write" 表示它在 retire/create 之后执行；暂存阶段不碰数据库。
export function stageTable(write: TableDefinitionWrite): StagedWrite {
	return { order: "write", apply: async (step) => [await applyTable(step, write)] };
}

/** Stages an `index` write. */
// 暂存 index 写；实际 CREATE INDEX 在提交步骤内由 applyIndex 执行。
export function stageIndex(write: Extract<TableWrite, { readonly kind: "index" }>): StagedWrite {
	return { order: "write", apply: async (step) => [await applyIndex(step, write)] };
}

/** Stages one edit of the migration of `table` to `version` as its `alter`, `index` or `dropIndex` write. */
// 把一次迁移编辑转成对应的暂存写：index/dropIndex 有专用写；其余（rename/add/drop/json）合并为 alter 写，
// 携带迁移目标版本。返回的闭包在提交时执行相应 applier；不会在暂存阶段执行 SQL。
export function stageEdit(table: string, version: number, edit: TableEdit): StagedWrite {
	switch (edit.kind) {
		// index 编辑直接复用 index 写。
		case "index":
			return stageIndex({ kind: "index", table, name: edit.name, columns: edit.columns });
		// dropIndex 需要自己的 applier；as const 让对象字面量保持精确的 kind 类型。
		case "dropIndex": {
			const write = { kind: "dropIndex", table, name: edit.name } as const;
			return { order: "write", apply: async (step) => [await applyDropIndex(step, write)] };
		}
		// rename/add/drop/json 都进入同一条 alter 记录，由 applyAlter 分派。
		default: {
			const write = { kind: "alter", table, version, edit } as const;
			return { order: "write", apply: async (step) => [await applyAlter(step, write)] };
		}
	}
}

/** Stages a `put` of an encoded row with its `INSERT OR REPLACE` (an upsert: the whole row replaced). */
// 暂存整行 upsert：row 已由 RowCodec 编码（row.row 为列值、params 为绑定参数），sql 是预渲染的 INSERT OR REPLACE。
// 提交时执行 SQL 并返回 put 记录；columns 记录行中 json 列的版本。
export function stagePut(sql: string, table: string, row: EncodedRow, version: number): StagedWrite {
	const write: TableWrite = { kind: "put", table, row: row.row, version, columns: row.columns };
	return {
		order: "write",
		apply: async (step) => {
			// 参数按占位符顺序展开；put 是 upsert，整行覆盖。
			await step.run(sql, ...row.params);
			return [write];
		},
	};
}

/**
 * Stages an `update` of one row by key; its count (0 for an absent key) is recorded, and `version` when the statement stamps
 * the row's `$v` (a migration's `rows` step).
 */
// 暂存按键 update：statement 已渲染；counted 执行并记录受影响行数。
// version 仅在迁移的 rows 步骤传入，用于把行的 $v 标记为目标版本；插件 update 不传。
export function stageUpdate(
	statement: Statement,
	table: string,
	key: StoredKey,
	set: SetNode,
	columns: ColumnVersions,
	version?: number,
): StagedWrite {
	// 用条件展开构造可选 version 字段，避免在记录里留下 undefined。
	const stamped = version === undefined ? {} : { version };
	return counted(statement, (count) => ({ kind: "update", table, key, set, columns, count, ...stamped }));
}

/** Stages a `delete` of one row by key; its count is recorded. */
// 暂存按键 delete；counted 记录实际删除行数，重放时用于校验。
export function stageDelete(statement: Statement, table: string, key: StoredKey): StagedWrite {
	return counted(statement, (count) => ({ kind: "delete", table, key, count }));
}

/**
 * Stages an `updateWhere`: one statement, its count recorded (a replica affecting another count stops, S17), and `version`
 * when it stamps the rows' `$v` (a migration's `update` step).
 */
// 暂存条件批量 update；count 记录影响行数，副本重放时若行数不同会停止（S17）。
// version 同样只在迁移的 update 步骤出现。
export function stageUpdateWhere(
	statement: Statement,
	table: string,
	where: WhereNode,
	set: SetNode,
	columns: ColumnVersions,
	version?: number,
): StagedWrite {
	const stamped = version === undefined ? {} : { version };
	return counted(statement, (count) => ({ kind: "updateWhere", table, where, set, columns, count, ...stamped }));
}

/** Stages a `deleteWhere`: one statement, its count recorded. */
// 暂存条件批量 delete；记录影响行数。
export function stageDeleteWhere(statement: Statement, table: string, where: WhereNode): StagedWrite {
	return counted(statement, (count) => ({ kind: "deleteWhere", table, where, count }));
}

// 共同实现：暂存一个执行 runCounted 的写，把受影响行数交给 record 构造最终记录。
// order 固定为 "write"；apply 只在提交步骤内运行，此时 SQL 与参数已确定。
function counted(statement: Statement, record: (count: number) => TableWrite): StagedWrite {
	return {
		order: "write",
		apply: async (step) => [record(await step.runCounted(statement.sql, ...statement.params))],
	};
}

/** Applies a `table` write: `CREATE TABLE` when the store does not have the table yet, then its record. */
// 应用 table 写：store 没有该表时先 CREATE TABLE（列、键、STRICT），随后把记录放入 step.tables，
// 由提交成功后的 catalog 接管。已有表时保留其索引（索引由单独的 index 写维护）。返回原 write 供 outbox 记录。
export async function applyTable(step: Step, write: TableDefinitionWrite): Promise<TableWrite> {
	const existing = step.table(write.table);
	// 仅首次建表时发 DDL；迁移时 existing 已存在，不再 CREATE。
	if (existing === undefined) await step.run(createTableSql(write.table, write.columns, write.key));
	const { table, version, state, columns, key, fingerprint } = write;
	// 保留已有索引；新建表时 existing 为 undefined，索引为空对象。
	step.tables.set(table, { table, version, state, columns, key, fingerprint, indexes: existing?.indexes ?? {} });
	return write;
}

/** Applies an `index` write: `CREATE INDEX` and the record's index. */
// 应用 index 写：先取当前目录记录（不存在则失败），执行 CREATE INDEX，再把新索引并入记录。
// 主键由 createIndexSql 追加到索引列末尾；返回 write。
export async function applyIndex(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "index" }>,
): Promise<TableWrite> {
	const existing = recorded(step, write.table);
	await step.run(createIndexSql(write.table, write.name, write.columns, existing.key));
	// 展开复制索引对象，只有新索引变化；不修改 existing 本身。
	step.tables.set(write.table, { ...existing, indexes: { ...existing.indexes, [write.name]: write.columns } });
	return write;
}

/** Applies a `dropIndex` write: `DROP INDEX` and the record without it. */
// 应用 dropIndex 写：执行 DROP INDEX，并用 rest 解构从目录记录中移除该索引。
export async function applyDropIndex(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "dropIndex" }>,
): Promise<TableWrite> {
	const existing = recorded(step, write.table);
	await step.run(dropIndexSql(write.table, write.name));
	const { [write.name]: _dropped, ...indexes } = existing.indexes;
	step.tables.set(write.table, { ...existing, indexes });
	return write;
}

/** Applies an `alter` write: its DDL (a `json(...)` column's version column follows it) and the record's change. */
// 应用 alter 写：按 edit.kind 生成 DDL 并同步 step.tables 中的目录记录。
// rename 同时处理 json 版本列、主键和索引；add 用 columnSql（可能产生列 + 版本列两条 DDL）；
// drop 同时删 json 版本列；json 只改记录，不重建数据。
export async function applyAlter(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "alter" }>,
): Promise<TableWrite> {
	const existing = recorded(step, write.table);
	const { edit } = write;
	// 标识符引用一次，DDL 里复用；表名已在声明/导入时检查，不含引号。
	const id = quote(write.table);
	switch (edit.kind) {
		case "rename": {
			// json 列的版本列 <name>$v 必须跟着改名，否则读取会找不到版本。
			const json = existing.columns[edit.from]?.type === "json";
			await step.run(`ALTER TABLE ${id} RENAME COLUMN ${quote(edit.from)} TO ${quote(edit.to)}`);
			if (json) {
				const [from, to] = [versionColumn(edit.from), versionColumn(edit.to)];
				await step.run(`ALTER TABLE ${id} RENAME COLUMN ${quote(from)} TO ${quote(to)}`);
			}
			// 局部函数同步重写主键和索引中的列名。
			const rename = (column: string): string => (column === edit.from ? edit.to : column);
			const columns = Object.entries(existing.columns).map(([name, column]) => [rename(name), column] as const);
			const indexes = Object.entries(existing.indexes).map(([name, on]) => [name, on.map(rename)] as const);
			step.tables.set(write.table, {
				...existing,
				columns: Object.fromEntries(columns),
				key: existing.key.map(rename),
				indexes: Object.fromEntries(indexes),
			});
			break;
		}
		case "add":
			// columnSql 对 json 列返回两条定义（值列 + 版本列），逐条 ADD COLUMN。
			for (const definition of columnSql(edit.name, edit.column)) {
				await step.run(`ALTER TABLE ${id} ADD COLUMN ${definition}`);
			}
			step.tables.set(write.table, { ...existing, columns: { ...existing.columns, [edit.name]: edit.column } });
			break;
		case "drop": {
			// json 列删除时先删值列，再删对应的版本列。
			const json = existing.columns[edit.name]?.type === "json";
			await step.run(`ALTER TABLE ${id} DROP COLUMN ${quote(edit.name)}`);
			if (json) await step.run(`ALTER TABLE ${id} DROP COLUMN ${quote(versionColumn(edit.name))}`);
			const { [edit.name]: _dropped, ...columns } = existing.columns;
			step.tables.set(write.table, { ...existing, columns });
			break;
		}
		case "json":
			// 只替换目录中的 ColumnRecord；已有单元格保持原版本，读取时再迁移。
			step.tables.set(write.table, { ...existing, columns: { ...existing.columns, [edit.name]: edit.column } });
			break;
	}
	return write;
}

/** The record of `table` in `step`; a write for a table the store does not have fails the step. */
// 取 step 视角下的表记录（优先本次步骤的更改）。找不到说明存在悬空写入，属于内存/磁盘不一致；
// 这里抛普通 Error，让提交步骤失败（D4）而不是继续生成错误 DDL。
function recorded(step: Step, table: string): TableRecord {
	const record = step.table(table);
	// Memory and disk disagree: the step fails, which stops the store.
	if (record === undefined) throw new Error(`table ${table}: not in the store`);
	return record;
}
