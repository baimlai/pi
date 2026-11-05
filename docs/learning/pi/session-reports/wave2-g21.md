# 组 g21
状态：完成

## 完成文件

- packages/durable/src/harness/partial-changes.ts：完整。核对的实际 callee/类型：pi-ai 的 `AssistantMessageEvent`/`ToolCall`/`AssistantMessage`、`StreamingJsonParser`/`JsonChange`、Chord delta 的 `appendText`/`Draft`、`assignJson`/`AssignPlan`、`LiveState`。运行：`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness-partial-changes.test.ts`，通过。
- packages/durable/src/harness/prompt.ts：完整。核对：`SystemEntry`、`ContextView`/`PromptInput`/`PromptSection`、pi-ai 的 `Message`/`SystemMessage`/`Tool`/`ToolReference`、`declarationsEqual`/`getCurrentTools`/`toToolDeclaration`。运行同组测试命令中的 `test/harness-prompt.test.ts`，通过。
- packages/durable/src/harness/provider.ts：完整。核对：`defineDoc`/`ProviderDoc`、`TaskRuntime`、`Context`、`uuidv7`，并确认 generation/compaction 的调用位置。`test/provider-session-cache-e2e.test.ts` 未运行：需要真实 provider 凭证/付费 token，按仓库规则跳过；`test/harness-compaction.test.ts` 只读 ProviderDoc，不覆盖 `ensureProviderSessionId` 的迁移写入路径。
- packages/durable/src/harness/registry-reader.ts：完整。核对：Chord `RegistryValue.value`/`observe`、`Context`、`RegistryReader`/`RegistrySnapshot`/`ToolRegistration`。运行 `test/harness-registry-reader.test.ts`，通过。
- packages/durable/src/harness/registry.ts：完整。核对：`INSTRUCTIONS_KEY`、`CompactionTask`/`GenerationTask`/`ToolTask`、`SectionKey` 正则、`Registry`/`RegistrySnapshot`/`Extension`/`AnyTask`。运行 `test/harness-registry.test.ts`，通过。
- packages/durable/src/harness/scheduler.ts：完整。核对：`SessionImpl` 的 `commitInternal`/`commitWith`/`readOnLine`/`touch`/`knownLatestEntryId`、`Transaction`、`Storage`、`RegistryReader`/`RegistrySnapshot`、Chord context 的 `awaitWithContext`/`withAbortSignal`/`withoutAbortSignal`/`withTelemetry`、telemetry span/metrics、`TaskDefinition` 的 `phases`/`abort`/`migrate`、`Waiters`/`scanAll`/`readContextFrom` 等。运行：scheduler 索引/保留 3 个测试 43 项通过；lifecycle/run-failure/cancellation-barrier/sleep 4 个测试 36 项通过。

## 验证

- 语法门禁（协调者要求）：`node_modules/.bin/esbuild packages/durable/src/harness/scheduler.ts --format=esm --log-level=warning > /dev/null`，结果 `esbuild OK`。
- 六个文件逐一 esbuild 解析，全部 `OK`。
- 回归验证“只插入了注释”：对每个文件用 esbuild `--minify` 比较 `git show HEAD:<file>` 与工作区版本，六个文件输出全部 `IDENTICAL`；说明注释没有进入字符串/模板，也没有改变代码语义。
- `git diff --numstat`：`95 0`、`97 0`、`46 0`、`39 0`、`93 0`、`1058 0`，六个文件均 0 删除行；新增行过滤后全部为 `//`/块注释/空行。
- 已修复 scheduler.ts 的 esbuild 解析失败：此前插入注释时误重复了一行 `for (const change of publication.changes) {`，删除重复行后恢复原代码；最终 minified 输出与 HEAD 完全一致。
- 未运行 `npm run check`、`npm run build` 或全仓格式化：任务说明明确禁止，且仓库规则要求 Durable 全量测试需要 dist；本组测试直接从源码运行，未触发构建。

## 未完成或风险

- provider.ts：`test/provider-session-cache-e2e.test.ts` 需要真实 provider 凭证与付费调用，未运行；其余文件无已知缺口。
- scheduler.ts：未运行全部 Durable 测试矩阵，只运行了与本文件直接相关的 7 个测试文件；其余依赖 dist 的 workerd/全量套件按任务限制未运行。
