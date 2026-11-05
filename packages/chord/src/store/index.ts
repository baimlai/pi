// The store for apps: opening it over a backend, tables with their queries, writes and migrations, export and
// import of archives (with their JSONL encoding), the outbox, text order.

// 文件导读
// 所属：packages/chord/src/store（store 层的公共出口，经 packages/chord/src/index.ts 再导出）。
// 职责边界：只做 export/export type 转发，没有运行时代码；不打开数据库、不校验数据、不改变任何行为。
// 上游：应用从 @earendil-works/chord 导入本文件转发的符号；下游：各实现文件（backend/store/table/expression/query/import/outbox/archive/text 等）。
// 能力清单：
// - Backend/sqliteBackend/openStore/Store/StoreOptions：打开 store；
// - defineTable/evolveTable/Table/TableOf/Page：声明表与读写句柄；
// - Columns/RowOf/PutRowOf/KeyOf/PatchOf：表行与演化的类型；
// - query/Query/ColumnRefs/Condition/Expression/SetOf 及 eq/and/add/...：查询与表达式词汇；
// - json/JsonColumnOptions/JsonColumnSchema：JSON 列；
// - encodeJsonl/decodeJsonl、ArchiveManifest/ArchivePart、importStore：归档与导入；
// - Outbox/OutboxCommit、StoreWrite、compareText：outbox 记录、写入词汇与文本顺序。
// 组合顺序：应用先 openStore(sqliteBackend(db), ctx) 得到 Store，再 defineTable/evolveTable 声明表，之后用 query/表达式构造条件并从 Table 句柄读写；归档走 export -> encodeJsonl、decodeJsonl -> importStore。
// 示例：import { openStore, sqliteBackend } from "@earendil-works/chord"; 仅得到符号，仍须由应用传入已打开的 SQLite 数据库并调用 openStore。
// 建议阅读顺序：backend/store -> table/columns -> expression/query -> table-handle -> json -> archive/jsonl/import -> outbox/writes -> text。

export type { ArchiveManifest, ArchivePart } from "./archive.ts";
export { type Backend, sqliteBackend } from "./backend.ts";
export type { Columns, PutRowOf, RowOf } from "./columns.ts";
export {
	add,
	and,
	type ColumnRef,
	type Condition,
	coalesce,
	concat,
	type Expression,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	max,
	min,
	ne,
	not,
	or,
	prefix,
	replacePrefix,
	type SetOf,
	sub,
	when,
} from "./expression.ts";
export { importStore } from "./import.ts";
export { type JsonColumnOptions, type JsonColumnSchema, json } from "./json-column.ts";
export { decodeJsonl, encodeJsonl } from "./jsonl.ts";
export type { Outbox, OutboxCommit } from "./outbox.ts";
export { type ColumnRefs, type Query, query } from "./query.ts";
export { openStore, type Store, type StoreOptions } from "./store.ts";
export { defineTable, type KeyOf, type TableDefinition, type TableOptions } from "./table.ts";
export {
	type AddedColumn,
	evolveTable,
	type PatchOf,
	type TableEditor,
	type TableTailEditor,
} from "./table-evolve.ts";
export type { Page, PageOptions, Table, TableOf } from "./table-handle.ts";
export { compareText } from "./text.ts";
export type { StoreWrite } from "./writes.ts";
