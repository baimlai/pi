// The applier (slice 6a §13, slice 6b §1.6): recorded writes applied as they were recorded, inside a backend
// transaction, checked against the store's own records (a trust boundary: archives, a replica's batches). One code
// path for import, bootstrap and batch apply, for every write kind; a recorded count the store does not reproduce
// stops applying (`Diverged`, S17).
// 本文件是“已记录写入”的唯一执行入口：不重新运行业务代码，而是按记录里的 kind、列、键和值重放 SQL。
// 上游是 import/applyBatch/初始化；结果写入当前 Step 的事务。它先对照目录与写入自身做运行时校验，再做 SQL。
// 所属模块：packages/chord/src/store 的已记录写入重放。
// 上下游：applyBatch、import/restore、bootstrap 调用 applyWrite；下游是 Step（事务内执行）、TableSql（渲染 SQL）、
//   table-writes（table/index/alter）、engine（文档记录与修订）、rows（类型转换与版本列）。
// 结果：写入当前后端事务，成功时无返回值。错误：invalid/args（记录与目录/形状不符）、Diverged（计数或 revision 不能复现）。
// 能力清单：
// - Diverged：记录无法复现时抛出的“已分叉”错误类型。
// - applyWrite：按 kind 分派并执行一条 StoreWrite。
// - applyDocument / applyCounted / liveAt / contentText / json：文档与计数写入的内部实现。
// - checkWhere / checkExpr / keyParams / setOf / versionsOf / putParams / recordOf：写入前的形状与目录校验。
// - checkTable / checkColumn / checkAlter / checkOrderColumns / checkIndex：表定义与迁移编辑的校验。
// 组合关系：checkWrite -> applyWrite -> {applyTable|applyIndex|applyAlter|applyCounted|applyDocument}；
//   每个分支先 recordOf/校验，再 step.run，计数类写入最后比较 write.count。
// 示例：await applyWrite(step, { kind: "delete", table: "notes:items", key: { id: 3 }, count: 1 }, "batch: write 0");
// 阅读顺序：先 Diverged 与 applyWrite 了解分派；再看 applyDocument/applyCounted 两条主路径；
//   最后读 checkWhere/checkExpr/putParams 等校验器，理解信任边界上的运行时检查。

import { checkName } from "../contracts/internal.ts";
import { invalid } from "../data/internal.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { TableRecord } from "./catalog.ts";
import { COLUMN_NAME, type ColumnRecord } from "./columns.ts";
import {
	type DocumentContent,
	type DocumentRecord,
	type DocumentWrite,
	insertDocument,
	insertRevision,
	type RevisionContent,
	readDocument,
	retireRecord,
	writeContent,
} from "./engine.ts";
import type { ExprNode, SetNode, WhereNode } from "./expression.ts";
import { checkScalar, ROW_VERSION, toSqlite, versionColumn } from "./rows.ts";
import { recordedPut, TableSql } from "./sql.ts";
import type { Step } from "./step.ts";
import { INDEX_NAME } from "./table.ts";
import { applyAlter, applyDropIndex, applyIndex, applyTable, type StoredKey, type TableWrite } from "./table-writes.ts";
import type { StoreWrite } from "./writes.ts";

/** A recorded write the store does not reproduce (a count, a revision): applying stops, the store diverged (S17). */
// 空类体继承 Error：只借用 instanceof 区分“数据不一致”与普通校验失败。构造消息由抛出处传入。
// 一旦出现，applyBatch 会把 store 永久标记为 diverged，而不是让副本继续静默偏离。
export class Diverged extends Error {}

/** Applies `write` in `step`; a write the records refuse throws `invalid/args`, one they do not reproduce `Diverged`. */
// 按 kind 分派一条写入。输入当前提交步骤、已通过外层 schema 的写入和位置描述；无成功返回值。
// 失败分两类：记录/参数不合法（invalid/args）与重放结果不一致（Diverged）。SQL 本身的错误由驱动 Promise 传播。
// 示例：applyWrite(step, { kind: "delete", table: "notes:items", key: { id: 3 }, count: 1 }, "batch: write 0")。
export async function applyWrite(step: Step, write: StoreWrite, what: string): Promise<void> {
	// switch 对可辨识联合按 kind 收窄；default 分支只剩文档写入。
	switch (write.kind) {
		case "table":
			checkTable(write, what);
			await applyTable(step, write);
			return;
		case "index":
			checkIndex(recordOf(step, write.table, what), write, what);
			await applyIndex(step, write);
			return;
		case "dropIndex":
			if (!Object.hasOwn(recordOf(step, write.table, what).indexes, write.name)) {
				throw invalid("args", `${what}: no index ${JSON.stringify(write.name)}`);
			}
			await applyDropIndex(step, write);
			return;
		case "alter":
			checkAlter(recordOf(step, write.table, what), write, what);
			await applyAlter(step, write);
			return;
		case "put": {
			// put 是 upsert：从目录记录重建整行 SQL，再把编码后的参数按物理列顺序传入。
			const record = recordOf(step, write.table, what);
			const { sql, physical } = recordedPut(write.table, record.columns);
			// `...` 展开参数数组；putParams 已按 physical 顺序检查并转换值。
			await step.run(sql, ...putParams(record, write, physical, what));
			return;
		}
		case "update":
		case "delete":
		case "updateWhere":
		case "deleteWhere":
			return applyCounted(step, write, what);
		default:
			// 表写入分支已全部列出；default 在这里等价于文档写入，利用联合类型的剩余分支收窄。
			return applyDocument(step, write, what);
	}
}

/** Applies a document write: a creation, a change or a retirement on its recorded revision, an archive's revision. */
// 文档写入分支：创建、归档修订、按 revision 修改、按 revision 退休。输入步骤、文档写入和位置描述；无返回值。
// 修改/退休会先读当前记录并核对 revision，不匹配视为分叉；创建和修订直接交给 engine 的插入函数。
async function applyDocument(step: Step, write: DocumentWrite, what: string): Promise<void> {
	switch (write.kind) {
		case "document.create":
			// base 可省：归档不带历史时只有记录本身；有 base 时序列化其 value 写入首个修订。
			await insertDocument(step, write.record, write.base === undefined ? undefined : json(write.base.value, what));
			return;
		case "document.revision": {
			// 该分支只出现在归档中：它保存文档的某条历史修订，而不是按 revision 修改活动内容。
			const { content } = write;
			await insertRevision(step, write.id, write.seq, content.kind, content.version, contentText(content, what));
			return;
		}
		case "document.change": {
			// change 只能作用于仍存活且正好停在该 revision 的文档；否则同一批数据的顺序或内容已不同。
			const record = await liveAt(step, write.id, write.revision, what);
			const { content } = write;
			const text = contentText(content, what);
			await writeContent(step, write.id, record.history, write.revision, content, text);
			return;
		}
		case "document.retire":
			await retireRecord(step, await liveAt(step, write.id, write.revision, what));
			return;
	}
}

/** A content's stored text: a base's value or a delta's ops, checked as JSON. */
// 取文档内容要写入单元格的文本：base 序列化 value，delta 序列化 ops。返回 JSON 字符串；不可编码时抛 invalid/args。
// `content.kind` 是判别字段，三元表达式在联合类型上收窄出对应字段。
function contentText(content: DocumentContent | RevisionContent, what: string): string {
	return json(content.kind === "base" ? content.value : content.ops, what);
}

/** The live record `id` at `revision`; another revision, or none, is a divergence. */
// 读取指定文档并校验它仍存活、revision 一致。返回记录；不存在、已退休或 revision 不同都抛 Diverged。
// 这是“重放输入”与“本地实际状态”的对照点，不修改数据。
async function liveAt(step: Step, id: number, revision: number, what: string): Promise<DocumentRecord> {
	const record = await readDocument(step, id);
	if (record === undefined || record.retiredAt !== undefined || record.revision !== revision) {
		throw new Diverged(`${what}: document ${id} is not live at revision ${revision}`);
	}
	return record;
}

/** `value` serialized; one `JSON.stringify` cannot encode is refused. */
// 把值序列化为 JSON 文本。返回 string；循环引用等让 JSON.stringify 抛错，或返回 undefined（如函数）时抛 invalid/args。
// 这里只保证“可编码”，不校验业务 schema。
function json(value: unknown, what: string): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw invalid("args", `${what}: not JSON (${String(error)})`);
	}
	if (text === undefined) throw invalid("args", `${what}: not JSON`);
	return text;
}

/**
 * Applies a counted table write: its statement rendered from the record's columns and the recorded `key`, `where` and
 * `set` (checked: only recorded columns, well-formed nodes), and its count compared with the recorded one.
 */
// 执行 update/delete/updateWhere/deleteWhere 四类计数写入。输入步骤、写入和位置；无返回。
// 先从目录重建 TableSql，再分别校验 key 或 where，执行并比较受影响行数；不一致抛 Diverged。
// `Extract<TableWrite, { kind: ... }>` 把参数类型精确限制为这四种，调用处无需再断言。
async function applyCounted(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "update" | "delete" | "updateWhere" | "deleteWhere" }>,
	what: string,
): Promise<void> {
	const record = recordOf(step, write.table, what);
	// 从目录记录重建列类型视图；此处渲染的语句用不到索引，所以索引参数传空数组。
	const columns = Object.entries(record.columns).map(([name, column]) => ({ name, type: column.type }));
	const sql = new TableSql(write.table, columns, [], record.key);
	let statement: { readonly sql: string; readonly params: SqliteValue[] };
	// 四种写入共用一次执行与计数比较，只为各自生成 SQL 与参数。
	switch (write.kind) {
		case "update":
			statement = sql.update(
				setOf(record, write, what),
				keyParams(record, write.key, what),
				versionsOf(record, write, what),
			);
			break;
		case "delete":
			statement = { sql: sql.delete, params: keyParams(record, write.key, what) };
			break;
		case "updateWhere":
			// where 来自记录，必须先校验节点与列引用，才能安全拼进 SQL 片段。
			checkWhere(record, write.where, what);
			statement = sql.updateWhere(write.where, setOf(record, write, what), versionsOf(record, write, what));
			break;
		case "deleteWhere":
			checkWhere(record, write.where, what);
			statement = sql.deleteWhere(write.where);
			break;
	}
	// runCounted 返回实际受影响行数；只有精确相等才算复现，少于或多于都说明两边状态不同。
	const count = await step.runCounted(statement.sql, ...statement.params);
	if (count !== write.count) throw new Diverged(`${what}: changed ${count} rows, recorded ${write.count}`);
}

/** The recorded key as parameters in key order: exactly the key columns, each of its type. */
// 按目录中的主键顺序生成参数数组。输入表记录、键对象和位置；返回 SqliteValue[]，缺列、多列或类型不符时抛 invalid/args。
// 键对象用 Record 保存，但列顺序由 record.key 决定，不能依赖 Object.keys 的顺序。
function keyParams(record: TableRecord, key: StoredKey, what: string): SqliteValue[] {
	if (Object.keys(key).length !== record.key.length) throw invalid("args", `${what}: not a key of ${record.table}`);
	return record.key.map((name) => {
		if (!Object.hasOwn(key, name)) throw invalid("args", `${what}: key column ${JSON.stringify(name)} is missing`);
		return toSqlite(checkScalar(scalarType(record.columns[name]!), key[name], `${what}: key`));
	});
}

/** A recorded `set` with the migration stamp `$v` when it carries one; key columns never change (rule 13). */
// 校验并返回 SET 表达式。输入表记录、update/updateWhere 写入和位置；返回 SetNode。
// 规则：set 必须非空、只能写非主键的已记录列、每个值表达式都合法；带 version 时追加行版本列。
function setOf(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "update" | "updateWhere" }>,
	what: string,
): SetNode {
	const { set } = write;
	// typeof null 也是 "object"，所以必须单独排除 null；空对象没有可更新的列。
	if (typeof set !== "object" || set === null || Object.keys(set).length === 0) {
		throw invalid("args", `${what}: an empty or malformed set`);
	}
	for (const [column, node] of Object.entries(set)) {
		if (!Object.hasOwn(record.columns, column) || record.key.includes(column)) {
			throw invalid("args", `${what}: set writes ${JSON.stringify(column)}, no non-key column`);
		}
		checkExpr(record, node, what);
	}
	// 计算属性名 `[ROW_VERSION]` 让常量列名参与对象字面量；展开 `...set` 保留原有列后再追加版本列。
	return write.version === undefined ? set : { ...set, [ROW_VERSION]: write.version };
}

/** The `json(...)` versions a `set` stamps: the recorded ones, of `json(...)` columns it sets, up to theirs. */
// 收集本次 update 需要为 json(...) 单元格写入的版本号。返回 Map<列名, 版本>；版本缺失、越界时抛 invalid/args。
// 只为“被 set 的 json 列”产生条目；普通列和未触碰的列不会出现在结果中。
function versionsOf(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "update" | "updateWhere" }>,
	what: string,
): Map<string, number> {
	const versions = new Map<string, number>();
	for (const [name, column] of Object.entries(record.columns)) {
		if (column.type !== "json" || !Object.hasOwn(write.set, name)) continue;
		// A clear stamps `NULL` whatever the version; a value stamps its recorded version.
		// `??` 只在左侧为 undefined/null 时取右值；`column.version!` 的非空断言依赖 checkColumn 的约定：json 列必有版本。
		const version = write.columns[name] ?? column.version!;
		if (!Number.isSafeInteger(version) || version < 1 || version > column.version!) {
			throw invalid("args", `${what}: no readable version for ${JSON.stringify(name)}`);
		}
		versions.set(name, version);
	}
	return versions;
}

/** A scalar column's type; `json(...)` columns are not scalars. */
// 返回用于值校验的标量类型。json 列没有标量类型，这里以 "str" 占位；调用方只会在需要 JSON 文本/键的路径上使用它。
function scalarType(column: ColumnRecord): "str" | "int" | "num" | "bool" {
	return column.type === "json" ? "str" : column.type;
}

// `as const` 让数组元素成为字面量联合，而不是宽泛的 string；后面用 includes 时再显式放宽成 readonly string[]。
const COMPARISONS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;

/** A recorded condition: well-formed nodes over recorded scalar columns (and the row's `$v`). */
// 校验 where 条件节点。输入表记录、unknown 节点和位置；成功时返回 void，失败抛 invalid/args。
// `asserts node is WhereNode` 是断言签名：函数正常返回后，编译器把调用处的 node 收窄为 WhereNode；运行时行为仍是上面的校验。
// 示例：checkWhere(record, { eq: ["id", 3] }, "batch") 通过；{ eq: ["id", 3, 4] } 被拒绝。
function checkWhere(record: TableRecord, node: unknown, what: string): asserts node is WhereNode {
	const refuse = (): never => {
		throw invalid("args", `${what}: a malformed condition`);
	};
	// 每个节点必须是恰有一个键的对象；多键无法确定是 and 还是比较，直接拒绝。
	if (typeof node !== "object" || node === null || Object.keys(node).length !== 1) return refuse();
	// 解构数组元组：entries 的第一项恰好就是 [[op, operand]]，as 断言只为告诉 TS 取出的形状。
	const [[op, operand]] = Object.entries(node) as [[string, unknown]];
	// 列名检查：$v 是内部行版本列，允许出现；其余必须是已记录的标量列，json 列不可比较。
	const column = (name: unknown): void => {
		if (name === ROW_VERSION) return;
		if (typeof name !== "string" || record.columns[name] === undefined || record.columns[name]!.type === "json") {
			refuse();
		}
	};
	// and/or 递归校验每个子条件；not 只有一个子条件；其余按操作符形状检查。
	if (op === "and" || op === "or") {
		if (!Array.isArray(operand)) return refuse();
		for (const each of operand) checkWhere(record, each, what);
	} else if (op === "not") checkWhere(record, operand, what);
	else if (op === "isNull") column(operand);
	else if (op === "inArray" || op === "prefix" || (COMPARISONS as readonly string[]).includes(op)) {
		if (!Array.isArray(operand) || operand.length !== 2) return refuse();
		column(operand[0]);
		const values = op === "inArray" ? operand[1] : [operand[1]];
		if (!Array.isArray(values)) return refuse();
		for (const value of values) if (!isScalar(value) || (op === "prefix" && typeof value !== "string")) refuse();
	} else refuse();
}

const OPERATIONS = ["add", "sub", "max", "min", "concat", "coalesce"] as const;

/** A recorded expression: scalars, `null`, JSON literals, recorded columns and the vocabulary's operations. */
// 校验 SET/表达式节点。输入表记录、unknown 节点和位置；成功返回 void，失败抛 invalid/args。
// 断言签名让调用处把 node 收窄为 ExprNode；标量和 null 直接通过，对象节点按操作符递归检查。
function checkExpr(record: TableRecord, node: unknown, what: string): asserts node is ExprNode {
	if (node === null || isScalar(node)) return;
	const refuse = (): never => {
		throw invalid("args", `${what}: a malformed expression`);
	};
	if (typeof node !== "object" || Object.keys(node).length !== 1) return refuse();
	const [[op, operand]] = Object.entries(node) as [[string, unknown]];
	if (op === "col") {
		// col 只允许引用已记录的列；主键列也可用于计算，但写入目标列的限制在 setOf 里。
		if (typeof operand !== "string" || !Object.hasOwn(record.columns, operand)) refuse();
		return;
	}
	// `{ json: ... }` 表示一个 JSON 字面量，内容不做更细的结构限制。
	if (op === "json") return;
	if (!Array.isArray(operand)) return refuse();
	if ((OPERATIONS as readonly string[]).includes(op) && operand.length === 2) {
		for (const each of operand) checkExpr(record, each, what);
	} else if (op === "replacePrefix" && operand.length === 3) {
		checkExpr(record, operand[0], what);
		if (typeof operand[1] !== "string" || typeof operand[2] !== "string") refuse();
	} else if (op === "when" && operand.length === 3) {
		checkWhere(record, operand[0], what);
		checkExpr(record, operand[1], what);
		checkExpr(record, operand[2], what);
	} else refuse();
}

function isScalar(value: unknown): boolean {
	// 有限数字才算标量：NaN/Infinity 不能安全写入 SQLite 的数值列。
	return (
		typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
	);
}

/** A recorded table's SQL name (two names joined by `:`, R2), columns, key and json versions, by the name rules. */
// 校验 table 写入的定义。输入写入和位置；无返回，违反命名/列/主键规则时抛 invalid/args。
// 表名必须是 owner:table；列名符合 COLUMN_NAME 且大小写折叠后唯一；主键非空且每列可用于排序。
function checkTable(write: Extract<TableWrite, { readonly kind: "table" }>, what: string): void {
	const parts = write.table.split(":");
	if (parts.length !== 2) throw invalid("args", `${what}: table ${JSON.stringify(write.table)}: not owner:table`);
	try {
		// checkName 是契约层的命名规则；这里把普通 Error 转成带位置的 invalid/args。
		for (const part of parts) checkName(part, `${what}: table name part`);
	} catch (error) {
		// `checkName` throws plain Errors.
		// as Error 断言构造的原因是 checkName 的文档保证它只抛 Error；此处只为读取 message。
		throw invalid("args", (error as Error).message);
	}
	// Set 按大小写折叠记录已见列名，避免同一表出现仅大小写不同的两列。
	const folded = new Set<string>();
	for (const [name, column] of Object.entries(write.columns)) {
		const where = `${what}: column ${JSON.stringify(name)}`;
		if (!COLUMN_NAME.test(name) || folded.has(name.toLowerCase()))
			throw invalid("args", `${where}: not a column name`);
		folded.add(name.toLowerCase());
		checkColumn(column, where);
	}
	if (write.key.length === 0) throw invalid("args", `${what}: the key has no column`);
	checkOrderColumns(write.columns, write.key, `${what}: the key`);
}

function checkColumn(column: ColumnRecord, what: string): void {
	// json 列必须且只能带 version/fingerprint；其他列两项都必须缺失，三者等价关系用两个 !== 同时检查。
	const json = column.type === "json";
	if (json !== (column.version !== undefined) || json !== (column.fingerprint !== undefined)) {
		throw invalid("args", `${what}: a json(...) column has a version and a fingerprint, no other column has`);
	}
	if (column.default === undefined) return;
	// 有默认值的列必须是非可选标量：json 列的内容版本无法为默认值凭空确定，可选列缺失时根本不写默认值。
	if (json || column.optional) throw invalid("args", `${what}: only a non-opt scalar column has a default`);
	checkScalar(column.type, column.default, `${what}: the default`);
}

/** A recorded column edit of `record`'s next version or its own (the edits after a data step). */
// 校验 alter 写入。输入当前目录记录、alter 写入和位置；无返回，编辑不合法时抛 invalid/args。
// 版本只允许“自身（同一数据步之后）”或“下一个版本”；随后按 rename/add/drop/json 分别检查条件。
function checkAlter(record: TableRecord, write: Extract<TableWrite, { readonly kind: "alter" }>, what: string): void {
	if (write.version !== record.version && write.version !== record.version + 1) {
		throw invalid("args", `${what}: an edit of version ${write.version} on version ${record.version}`);
	}
	const { edit } = write;
	// has：源列存在；fresh：新名字符合命名且不与已有列大小写相同；indexed：列被主键或索引引用。
	const has = (name: string): boolean => Object.hasOwn(record.columns, name);
	const fresh = (name: string): boolean =>
		COLUMN_NAME.test(name) && !Object.keys(record.columns).some((each) => each.toLowerCase() === name.toLowerCase());
	const indexed = (name: string): boolean =>
		record.key.includes(name) || Object.values(record.indexes).some((columns) => columns.includes(name));
	// 三元表达式链按 edit.kind 收窄联合；每个分支只访问该 kind 存在的字段。
	const valid =
		edit.kind === "rename"
			? has(edit.from) && fresh(edit.to)
			: edit.kind === "add"
				? fresh(edit.name) && (edit.column.optional === true || edit.column.default !== undefined)
				: edit.kind === "drop"
					? has(edit.name) && !indexed(edit.name)
					: has(edit.name) && record.columns[edit.name]!.type === "json" && edit.column.type === "json";
	if (!valid) throw invalid("args", `${what}: an ${edit.kind} edit the table cannot take`);
	// add 与 json 都携带新的 ColumnRecord，需要复用列本身的约束检查。
	if (edit.kind === "add" || edit.kind === "json")
		checkColumn(edit.column, `${what}: column ${JSON.stringify(edit.name)}`);
}

/** `names` are distinct, recorded, non-`opt` `str` or `int` columns. */
// 校验一组排序列（主键或索引列）。输入列记录表、名称数组和位置；无返回，重复、未记录、可选或类型不符时抛 invalid/args。
function checkOrderColumns(
	columns: { readonly [name: string]: ColumnRecord },
	names: readonly string[],
	what: string,
): void {
	if (new Set(names).size !== names.length) throw invalid("args", `${what}: a column occurs twice`);
	for (const name of names) {
		const column = Object.hasOwn(columns, name) ? columns[name] : undefined;
		if (column === undefined || column.optional || (column.type !== "str" && column.type !== "int")) {
			throw invalid("args", `${what}: ${JSON.stringify(name)} is not a non-opt str or int column`);
		}
	}
}

function checkIndex(record: TableRecord, write: Extract<TableWrite, { readonly kind: "index" }>, what: string): void {
	// 索引名必须合法且尚未存在；已存在应使用 dropIndex 后再建，不能静默覆盖。
	if (!INDEX_NAME.test(write.name) || Object.hasOwn(record.indexes, write.name)) {
		throw invalid("args", `${what}: index ${JSON.stringify(write.name)}: not a new index name`);
	}
	checkOrderColumns(record.columns, write.columns, `${what}: index ${write.name}`);
}

/** The record of `table` in `step`; a write for a table not recorded is refused. */
// 从当前 Step 的目录视图取表记录。返回 TableRecord；表未记录（或已被删除）时抛 invalid/args。
// 这里包含同一提交中前序写入对目录的改动，所以同批先 table 后 put 能看到新表。
function recordOf(step: Step, table: string, what: string): TableRecord {
	const record = step.table(table);
	if (record === undefined) throw invalid("args", `${what}: table ${JSON.stringify(table)} is not recorded`);
	return record;
}

/**
 * The parameters of a `put` in `physical` order, checked against the recorded columns: every non-`opt` column, no
 * other field, values of their types, `json(...)` cells as JSON (no plugin code runs) with a version up to the
 * column's, and `version` up to the table's.
 */
// 生成 put 的物理列参数数组，并完成行级校验：未知字段、非 json 列的版本记录、表版本越界、必填缺失、类型不符、JSON 版本失效。
// 返回按 physical 顺序排列的 SqliteValue[]；任何问题抛 invalid/args。该函数不运行业务插件代码，只做存储层检查。
function putParams(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "put" }>,
	physical: readonly string[],
	what: string,
): SqliteValue[] {
	const { row, columns: versions, version } = write;
	// 第一遍：行里不能出现目录未记录的列。
	for (const field of Object.keys(row)) {
		if (!Object.hasOwn(record.columns, field))
			throw invalid("args", `${what}: unknown column ${JSON.stringify(field)}`);
	}
	// 第二遍：版本记录只能指向本行中的 json 单元格；普通列不需要也无法携带内容版本。
	for (const field of Object.keys(versions)) {
		if (record.columns[field]?.type !== "json" || !Object.hasOwn(row, field)) {
			throw invalid(
				"args",
				`${what}: a version for ${JSON.stringify(field)}, which is no json(...) cell of the row`,
			);
		}
	}
	if (version > record.version) {
		// 行版本高于表定义版本说明记录来自更晚的 schema，本地代码无法正确解释它。
		throw invalid("args", `${what}: version ${version} is newer than the table's version ${record.version}`);
	}
	// cells 以逻辑列名为键；最后再按 physical 顺序取值，兼容 SQLite 的物理列序。
	const cells = new Map<string, SqliteValue>();
	for (const [name, column] of Object.entries(record.columns)) {
		const where = `${what}: column ${JSON.stringify(name)}`;
		const value = row[name];
		// A row has no explicit `null`: an absent field is `NULL`; a `json(...)` cell's `null` is the JSON value.
		// json 列把显式 null 当作 JSON 值，所以只用 hasOwn 判断缺失；普通列则把 undefined 视作缺失。
		if (column.type === "json" ? !Object.hasOwn(row, name) : value === undefined) {
			// 可选列缺失写 NULL；必填列缺失说明记录不完整。
			if (!column.optional) throw invalid("args", `${where} is missing`);
			cells.set(name, null);
			continue;
		}
		if (column.type !== "json") {
			// checkScalar 做类型检查（信任边界上的值来自记录），toSqlite 再转成驱动可绑定的底层值。
			cells.set(name, toSqlite(checkScalar(column.type, value, where)));
			continue;
		}
		const version = versions[name];
		// json 列的值必须带有可读版本，且不能超过列当前版本；版本缺失视为记录损坏。
		if (version === undefined || version > column.version!) throw invalid("args", `${where}: no readable version`);
		// json 列存文本，同时把版本写入隐藏的版本列（versionColumn(name) 生成列名）。
		cells.set(name, json(value, where));
		cells.set(versionColumn(name), version);
	}
	// 按物理列顺序输出；行版本列取自写入的 version，其余缺失单元格写 NULL。
	return physical.map((name) => (name === ROW_VERSION ? version : (cells.get(name) ?? null)));
}
