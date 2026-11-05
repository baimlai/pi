# 组 g19

状态：完成

## 完成文件

- `packages/durable/src/harness/submissions.ts`：完整。核对了 `SessionImpl.followCommits/readOnLine/subscribeClose`、`startRun`、`InboxDoc` 与 `Tx/SubmissionRecord` 类型；`git diff --numstat` 为 178/0，esbuild 解析通过。运行 `test/harness-submissions.test.ts`（与以下三文件同批）：4 文件 56 测试通过。
- `packages/durable/src/harness/task-graph.ts`：完整。核对了 live 状态集合、`TaskRecord`、scheduler 的 `blockedReason/subscribeBlocked`、`applyImmutable` 与 `closeEnds/closeEndOf`；244/0，esbuild 通过。运行 `test/harness-task-graph.test.ts`：同批 56 测试通过。
- `packages/durable/src/harness/telemetry.ts`：完整。核对了 `defineTelemetrySchema` 对 span/event/metric 的推导、Submissions 与 Scheduler 的 span 名和属性调用点；53/0，esbuild 通过。运行 `test/harness-telemetry.test.ts` 与 `test/spec-usage.test.ts`：2 文件 27 测试通过。
- `packages/durable/src/harness/tool.ts`：完整。核对了 `live.ts` 的 `PROGRESS_COMMIT`、cutOff/cutOffCount、嵌套槽位与清理路径，`TaskRuntime`、`NestedCallDoc`、`recordUsage` 及工具结果条目写入；245/0，esbuild 通过；已确认无 `? //` / `: //` 形式、三元表达式原行与缩进未变。运行 `test/harness-tools.test.ts` 与 `test/harness-tool-hooks.test.ts`：2 文件 60 测试通过。
- `packages/durable/src/harness/transcript.ts`：完整。核对了 `ConversationView`、`Conversation.entries()` 的查询形状、`#cover/#subtract/#build` 的空洞合并逻辑；179/0，esbuild 通过。运行 `test/conversation-transcript.test.ts`：同批 56 测试通过。
- `packages/durable/src/harness/types.ts`：完整。核对了 pi-ai 的 `Model/Tool/Message/Usage`、核心 `Tx/Entry/Session` 类型，以及 `ToolExecutionApi`、`Harness`、三组 hooks 与实现文件的实际用法；347/0，esbuild 通过。运行 `test/types.test.ts`：3 测试通过。
- `packages/durable/src/harness/usage.ts`：完整。核对了 `Usage` 字段、`Draft`、`copyJson`、`UsageDoc` 的 conversation/latest/initial 作用域语义及 generation/tool/compaction 调用点；53/0，esbuild 通过。`test/spec-usage.test.ts` 通过。
- `packages/durable/src/harness/util.ts`：完整。核对了 `Waiters` 在 Submissions 中的使用、`scanAll` 的 `Page/Cursor` 形状、`closedError` 的 `SessionFailed` cause、`conversationEntries` 的 `EntryQuery` 投影；85/0，esbuild 通过。由同批 harness 测试间接覆盖。
- `packages/durable/src/harness/view.ts`：完整。核对了 `followCommits` 的 stored/memory 提交、`conversationDocumentOnLine`、`scanEntries` 分页、`Watch/WatchCall` 与 `closeEnds/closeEndOf`；238/0，esbuild 通过。运行 `test/harness-view.test.ts`：同批 56 测试通过。

汇总验证：

- 九个文件 `git diff --numstat` 删除行均为 0，`git diff | grep '^-[^-]'` 计数为 0，确认只新增整行注释。
- 九个文件均通过 `node_modules/.bin/esbuild <file> --format=esm --outfile=/tmp/...` 解析。
- 共运行 9 个测试文件、146 个测试，全部通过：`harness-task-graph`、`harness-view`、`harness-submissions`、`conversation-transcript`、`spec-usage`、`harness-telemetry`、`harness-tools`、`harness-tool-hooks`、`types`（其中前四个同批执行）。

## 未完成或风险

- 按任务约束未运行 `npm run check`、`npm run build` 与全量测试；因此未做独立类型检查，仅以 esbuild 解析和上述定向测试验证注释未破坏语法与相关行为。
- `util.ts` 的 `Waiters/scanAll` 无单文件测试，只能由 Submissions、TaskGraph 等上层测试间接覆盖；未发现行为风险。
- `tool.ts` 的崩溃恢复/嵌套调用路径仅运行了 tools 与 tool-hooks 测试，未运行 recovery 专项测试（避免与并行代理的测试进程重叠）；注释核对已对照 `live.ts` 与 `scheduler.ts` 源码。
