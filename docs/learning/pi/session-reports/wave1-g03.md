# 组 g03

状态：完成

## 完成文件

所有文件只新增注释行。`git diff --numstat -- <19 个文件>` 的删除列均为 0；`git diff -U0` 的删除侧没有非注释行。共同验证命令：`cd packages/chord && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/store/*.test.ts`，结果 28 个测试文件、262 个测试全部通过（1.10s）。另用 esbuild 逐文件解析，19 个文件均通过。

- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/claims.ts：完整；核对 Claims/Claimant、held/table/documents/assertTable/assertDocuments/lock/release/#claim/#assert 与 invalid，及 store.ts/adapter.ts 的调用路径；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/columns.ts：完整；核对 ColumnSchema/Optional/Schema/Columns/ColumnType/ValueOf/RowOf/PutRowOf/OrderColumn/Column/ColumnRecord、describeColumns/checkColumnName/columnRecord/checkDefault，以及 storedText 与安全整数/有限数检查；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/engine.ts：完整；核对 DocumentAddress/DocumentHistory/DocumentRecord/DocumentContent/DocumentRevision/DocumentWrite/StoredDocument/DocumentPoint/DocumentEntry/DocumentScope，createDocument/insertDocument/changeDocument/writeContent/retireDocument/retireRecord/insertRevision/readDocument/findDocument/readDocumentEntry/findDocumentEntry/loadDocument/loadContent/listDocumentKeys/listDocuments/listDocumentEntries/listRecords/listRevisions，以及 Step/IdAllocator/StagedWrite/SqliteExecutor；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/evaluate.ts：完整；核对 EvaluatedRow、matches/compareScalar/applySet，WhereNode/SetNode/ExprNode/Scalar 与代码点文本比较；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/export.ts：完整；核对 EXPORT_PAGE、StoreExport 的 next/return/#hold/#end/#assertOpen，parts/puts/putOf/documents/revisions/aborted，以及 ChordStore.take/read/lastSeq/tables、listRecords/listRevisions、recordedPut/quote、ROW_VERSION/versionColumn、awaitWithContext；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/expression.ts：完整；核对 Expression/ColumnRef/Condition/WhereNode/ExprNode/SetNode/Comparison/Operation/SetOf、eq/ne/lt/lte/gt/gte/inArray/isNull/prefix/and/or 及算术构造器，compileWhere/compileExpr/compileSet，checkScalar/storedText；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/import.ts：完整；核对 importStore/ArchiveImport/inTransaction/Place/each，checkPart/applyWrite/applyStoreSchema/readCatalog/writeCatalog/Step/IdAllocator，ArchivePart/ArchiveManifest/MetaRow；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/index.ts：完整；核对全部 export/export type 转发目标（archive/backend/columns/expression/query/json-column/jsonl/import/outbox/step/store/table/text），确认无运行时代码；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/json-column.ts：完整；核对 json/JsonColumnOptions/JsonColumnSchema/JsonColumn，Schema/Static/指纹、read/migrate/encode 与 unavailable 错误；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/jsonl.ts：完整；核对 CHUNK、encodeJsonl/decodeJsonl、ArchivePart、invalid，以及 TextEncoder/TextDecoder 与 JSON 解析；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/outbox.ts：完整；核对 OUTBOX_FORMAT、OutboxCommit、Outbox 的 floor/read/trim/#queued/#read/#trim 与 StoreWrite；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/query.ts：完整；核对 query/Query/ColumnRefs/encodeCursor/decodeCursor，compileWhere、ColumnRef、TableDefinition、Order、SqliteValue，及 btoa/atob 的 URL 安全编码；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/refusal.ts：完整；核对 Refusal/refusalOf、ChordError，以及驱动 errcode 275 与 Cloudflare 消息识别；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/rows.ts：完整；核对 Scalar/StoredRow/EncodedRow/EncodedKey/versionColumn/ROW_VERSION/physicalColumns/toSqlite/RowCodec/encodeCell/checkScalar，Column/ColumnType、storedText、JsonColumn；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/schema.ts：完整；核对 TABLES/STORE_SCHEMA/MetaRow/applyStoreSchema、MIGRATIONS 与 SqliteDatabase；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/sql.ts：完整；核对 Statement/Order/quote/tableSqlName/createTableSql/columnSql/recordedPut/createIndexSql/dropIndexSql/TableSql/whereSql、ColumnRecord/WhereNode/Scalar；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/step.ts：完整；核对 WriteOrder/StagedWrite/Step 的 run/runCounted/get/all、SqliteExecutor/IdAllocator/TableRecord；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/store.ts：完整；核对 Store/StoreOptions/openStore/CommitFence/SeriesCommit/SeriesResult/Series/SeriesProgress/Attachment/Replayed/ChordStore，Backend/Context/Step/Outbox/Claims，commit/commitSeries/read/maintain/close/replay/#series/#write 等路径；store 全量测试通过。
- /Users/baiml/PycharmProjects/pi/packages/chord/src/store/table-changes.ts：完整；核对 TableChanges/KeyWrite，applySet/compileSet/compileWhere、TableHandle、table-writes 的 stage* 与 RowCodec 编码；store 全量测试通过。

## 未完成或风险

- 按任务约束未运行 `npm run check`、`npm run build`、全仓格式化、完整 Vitest 套件与 e2e；因此 typecheck、lint 与跨包集成未在本轮验证。
- 注释不影响运行时；本轮的语义核对依赖逐文件源码阅读、callee/类型核对、esbuild 解析与 store 测试。测试不能证明注释文字本身正确。
- schema.ts 中最后一个表定义的说明位于其模板字符串之后、数组 `],` 之前；它解释 outbox 表而非闭括号，保留以匹配该文件逐条 SQL 后置说明的既有写法。
- 未发现未完成的注释缺口。
