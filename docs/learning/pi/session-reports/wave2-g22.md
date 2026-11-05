# 组 g22

状态：完成

## 完成文件

所有文件均只新增中文注释行；`git diff --numstat` 对每个文件均为 `新增 0 删除`，原有代码行未改动。所有文件通过 `node --experimental-strip-types --check` 语法解析。

- packages/durable/src/storage/sqlite/cloudflare.ts：完整；核对 Chord `DurableObjectSqliteDatabase`、`DurableObjectSqliteStorage` 与 `SqliteStorage.open`；新增 20 行。
- packages/durable/src/storage/sqlite/database.ts：完整；核对 Chord `sqlite` 的 `SqliteDatabase`/`SqliteExecutor`/`SqliteValue` 类型导出；新增 15 行。
- packages/durable/src/storage/sqlite/index.ts：完整；核对 migrations.ts、storage.ts 的导出与 package.json 子路径；新增 20 行。
- packages/durable/src/storage/sqlite/migrations.ts：完整；核对 Chord `applySqliteMigrations` 的版本账本/单事务行为与 schema.ts 的标识符；新增 56 行。
- packages/durable/src/storage/sqlite/node.ts：完整；核对 `openNodeSqliteDatabase`、`validateSqliteSchemaPrefix` 与 `SqliteStorage.open`；新增 22 行。
- packages/durable/src/storage/sqlite/schema.ts：完整；核对 Chord 前缀校验与迁移、运行时表名的共用方式；新增 31 行。
- packages/durable/src/storage/sqlite/storage.ts：完整；核对 commit 的事务/检查/写入结构、fork 链读取、文档 base+delta 物化及 Chord `apply`；新增 246 行。
- packages/durable/src/storage/store/commit.ts：完整；核对 Chord `SeriesCommit`/`StagedWrite`、`OwnerTable`、文档引擎 `insertDocument`/`writeContent`/`retireRecord` 与 `documents.ts` 映射；新增 119 行。
- packages/durable/src/storage/store/documents.ts：完整；核对 `readDocumentEntry`/`loadContent`、`DocumentCreate`/`DocumentContent` 与 namespace/address 映射；新增 88 行。
- packages/durable/src/storage/store/index.ts：完整；核对 `StoreStorage.open` 与 package.json 子路径；新增 13 行。
- packages/durable/src/storage/store/queries.ts：完整；核对 Chord `prepare`/`prepareFirst`/`prepareGet`/`reader`/`jsonVersion` 与 tables.ts 列声明；新增 63 行。
- packages/durable/src/storage/store/storage.ts：完整；核对 `StoreOwnerTables`、`commitSeries`、受保护读 `read`/`readTransaction`、`scanStart`/`nextCursor` 与 `readAt`；新增 164 行。
- packages/durable/src/storage/store/tables.ts：完整；核对 `defineTable`/`int`/`str`/`json` 与 indexed 字符串编码在读取端的一致性；新增 39 行。
- packages/durable/src/storage/jsonl/index.ts：完整；核对 `JsonlStorage`、两类错误与子路径导出；新增 15 行。
- packages/durable/src/storage/jsonl/node.ts：完整；核对 `NodeExecutionEnv` 的 `FileSystem` 能力与 `JsonlStorage.open`；新增 17 行。
- packages/durable/src/storage/jsonl/storage.ts：完整；核对 `MemoryStorage.prepareCommit/apply`、`FileSystem` 的 append/flush/truncate/rename/list/remove、sidecar 标记恢复与回收、poisoned 语义；新增 227 行。

测试命令与结果（均在 `packages/durable` 下执行）：

- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/jsonl-storage.test.ts`：1 个文件、107 个测试通过。
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/sqlite-migrations.test.ts test/sqlite-storage.test.ts`：2 个文件、87 个测试通过。
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/sqlite-cloudflare.test.ts test/sqlite-facade.test.ts`：2 个文件、42 个测试通过。
- `node --experimental-strip-types --check` 逐个检查 g22 全部 16 个文件：全部通过。

## 未完成或风险

- packages/durable/test/store-storage.test.ts、packages/durable/test/store-storage-commit.test.ts：尝试运行但测试文件加载失败，0 个测试执行；Vite/Oxc 在 `packages/durable/src/harness/scheduler.ts:1269` 报 `Expected 'in' but found '('`。该文件不属于组 g22，当前由其他并行代理修改；同一文件用 Node `--experimental-strip-types --check` 可解析，g22 的 store 文件也全部可解析。未对 StoreStorage 测试结果作成功声明。待 scheduler.ts 的并行修改完成且该变换错误消失后，应重跑这两个测试。
- 未运行 `npm run check`、`npm run build`、全仓格式化或完整测试套件（任务明确禁止）。
- 未修改覆盖清单、STUDY_PROGRESS.md、STUDY_LOG.md、SESSION_PLAN.md 或其他代理报告。
