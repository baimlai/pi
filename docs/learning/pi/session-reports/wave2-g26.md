# 组 g26

状态：完成

## 完成文件

所有文件均已全文重读；每个文件头包含所属包/模块、职责边界、上下游、按导出的能力清单、典型调用示例与阅读顺序。`git diff --numstat` 显示仅新增注释行，删除侧为 0；`git diff -U0 | grep '^-'` 无输出。全部 10 个文件通过 `node --experimental-strip-types --check`。

- packages/durable/src/documents.ts：完整；核对 types.ts 的 token/地址/记录类型、chord 的 `Op`/`copyJson`/`JsonValue`、ids.ts 的 `idFromNumber`，以及 Session/Tx 对 `resolveAddress`/`materializeDocument*` 的调用；新增 147 行。
- packages/durable/src/entries.ts：完整；核对 types.ts 的 `Entry`/`TypedEntry`/`EntryRecord`、harness/types.ts 的 `CompactionReason`/`ToolDiagnostic`，以及 generation/tool/compaction 的写入方；新增 43 行。
- packages/durable/src/errors.ts：完整；核对 session/transaction.ts、session/session.ts、harness/submissions.ts 的抛出点与测试中的 `instanceof` 断言；新增 84 行。
- packages/durable/src/ids.ts：完整；核对 types.ts 的 `Id`/`Seq` 品牌与 storage/session 中 `idFromNumber`/`seqFromNumber` 的可信解码边界；新增 30 行。
- packages/durable/src/index.ts：完整；核对 package.json 子路径导出、各 re-export 来源模块与其公共类型；新增 69 行。
- packages/durable/src/search.ts：完整；核对 codemode/tool-search 的 `rankDocuments` 调用、BM25 常量、`Intl.Segmenter` 与分词/单数化规则；新增 112 行。
- packages/durable/src/tasks.ts：完整；核对 types.ts 的 `Task`/`TaskDefinition`、registry 安装与 scheduler 调用；新增 30 行。
- packages/durable/src/timers.ts：完整；核对 types.ts 的 `SetTimer`、Session 空闲淘汰与 Harness 休眠/唤醒调用点、Workers 探测与 `unref` 语义；新增 56 行。
- packages/durable/src/truncate.ts：完整；核对 chord/output 的 `utf8ByteLength`、tools/read.ts、tools/bash.ts、harness/tool.ts 的调用与默认上限；新增 65 行。
- packages/durable/src/types.ts：完整；核对 Session/Storage/Tx/任务/文档/提交/观察者全部类型与 session/transaction.ts、session/session.ts、harness/types.ts、storage/*.ts 的实现约束；新增 442 行。

测试命令与结果（在 `packages/durable` 下执行）：

- `node /Users/baiml/PycharmProjects/pi/node_modules/vitest/dist/cli.js --run test/types.test.ts test/env-truncate.test.ts test/search.test.ts test/session-documents.test.ts test/session-definitions.test.ts`：5 个文件、69 个测试全部通过。
- `node --experimental-strip-types --check` 逐个检查 g26 全部 10 个文件：全部通过。

## 未完成或风险

- 无已知缺口。未运行 `npm run check`、`npm run build`、全仓格式化或完整测试套件（任务明确禁止）；未执行 `git add/commit/push`；未修改覆盖清单、STUDY_PROGRESS.md、STUDY_LOG.md、SESSION_PLAN.md 或其他代理报告。
