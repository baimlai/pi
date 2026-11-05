# 组 g20

状态：完成

## 完成文件

- packages/durable/src/harness/agent.ts：完整；全文阅读并核对 `harness/types.ts` 的 `ToolRegistration`/`Extension`/`HookRegistration`/`HooksOf`/`PromptSection`/`RunEndTask`/`Wrap`、`documents.ts` 的 `defineDoc`、`Conversation.configure/addTools` 调用点、`resolveAgent` 的包装与失败隔离、`generation.ts` 的 `agentHooks` 调用。已扩写文件导读（职责边界、上游/下游、能力清单、组合顺序、签名示例、阅读顺序），并逐行注释默认策略、设置解析、工具过滤、扩展选择、包装器错误处理与报告路径。
- packages/durable/src/harness/compaction.ts：完整；核对 `ContextView`/`selectCut`/`summarizedMessages`/`estimateContext`、`TaskRuntime`/`NextTaskState`、pi-ai `completeSimple` 与 `SimpleStreamOptions`、`CompactionEntry`、`placeSummary` 的阻塞/会话拥有两种放置方式、`generation.ts` 的 `createCompaction` 调用点。逐行注释 select/summarize/retry/abort 相位、重试退避、摘要文本分类、工具结果序列化与截断；已修正文件头示例的 `owner: TaskId` 参数。
- packages/durable/src/harness/context.ts：完整；核对 `SessionImpl.readOnLine`、`Storage.entry/scanEntries`、`EntryRecord`/`ContextEdit`/`ContextView`、`AssistantMessage` 与 `Message`、`orderToolResults`、`freezeJson` 深冻结与 `ContextRange` 缓存不变量。逐行注释边界捕获、head/tail 缓存延展、编辑应用、基线系统消息、settled/open 工具结果排序、缺失结果合成与分页扫描。
- packages/durable/src/harness/define.ts：完整；核对 `harness/types.ts` 的 `Extension`/`ToolRegistration`/`PromptSection`/`HookRegistration`/`HooksOf`/`RunEndTask`/`Wrap`、`Task` 泛型、`Registry.install`/`resolveAgent`/`generation` 的 afterRun 使用。说明各恒等函数与工厂只作用于编译期、原样保留引用；文件头包含安装与解析的典型顺序及签名示例。
- packages/durable/src/harness/generation.ts：完整；核对 `TaskRuntime`/`NextTaskState`/`TaskOutcome`、pi-ai `streamSimple`/`streamDeferred`/`DeferredHandle`、`ToolTask` 创建与 unoffered 路径、`CompactionTask`、`inbox.applyBoundary/prepareBoundary`、`live.endRun/holdRun`、`PartialChanges` 与 `PROGRESS_COMMIT`。逐行注释七个相位、重试/轮询分类、阈值/溢出压缩、工具轮、afterRun/drain、续写交棒、流式节流、失败与切断清理；核对 `holdRun` 的 `first` 回退与 `run.first` 语义一致。
- packages/durable/src/harness/harness.ts：完整；核对 `SessionImpl`/`HarnessOptions`/`Conversation` 接口、`TaskScheduler` 注入选项、`Submissions`、`TaskGraphView`、`ConversationViews`、`boundConversation`、`safeReport`/`safeNow`、`openTasks` 恢复路径及内置任务校验。逐行注释根/独立/分叉三种创建路径、文档初始化、报告与时钟容错、调用绑定、调度器索引测试钩子；已修正 `TaskScheduler` 选项注释与属性的一一对应。
- packages/durable/src/harness/inbox.ts：完整；核对 `defineDoc`/`InboxDoc`、`Tx.appendEntry/placeSubmission/settleSubmission/latestHeadMarker`、`EntryDraft`/`InputEntry`/`QueueMode`/`Settings`、`applyBoundary` 的选择与删除顺序、`withdrawQueuedInputs` 的取消路径。逐行注释队列形状、steer/followUp/write 放置、reset 提升 final、stale head、显示条目立即追加与过期项结算；已修正 `InboxItem` 字段注释错位。
- packages/durable/src/harness/json.ts：完整；核对 `@earendil-works/chord/delta` 的 `Draft`/`appendText`、`@earendil-works/chord/json` 的 `JsonValue`/`JsonRepresentation`/`JsonObject`，以及 `PartialChanges` 的调用形状。逐行注释 keep/对象逐叶合并/数组复用/字符串追加/严格赋值五段路径、`__proto__` 防护与类型断言边界；文件头示例已改为 `assignJson(generation, "message", ...)`。
- packages/durable/src/harness/live.ts：完整；核对 `Draft`、`defineDoc` 的迁移/检查点语义、`RunFailureReason`/`LiveState`/`RunEnd`、`settleSchedulerOutcome` 与 `generation`/`compaction`/tool 清理调用点。逐行注释运行失败原因、槽位二分查找、嵌套槽位级联删除、压缩状态增删、延迟持久化与 abort/restart_limit 分类；已将示例中的字面量答案改为 `EntryId` 变量。

九个文件头均已扩写为详细导读，包含所属包/模块、职责边界、上游入口与下游依赖、按导出项列出的能力清单、组合关系与典型调用顺序、符合真实签名的示例、建议阅读顺序；源码行内注释覆盖条件、回调、异步、变更与错误路径，未改动任何原有代码行。

测试命令（在 `packages/durable` 下执行）：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness-inbox.test.ts test/harness-context.test.ts test/harness-context-range.test.ts test/harness-compaction.test.ts test/harness-live-deltas.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness-generation.test.ts test/harness-after-run.test.ts test/harness-partial-changes.test.ts test/harness-turn-limit.test.ts test/harness-run-failure.test.ts test/harness-deferred-progress.test.ts test/harness-view-run.test.ts test/harness-lifecycle.test.ts test/harness-json.test.ts
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness-tools.test.ts test/harness-tool-hooks.test.ts test/harness-cancellation-barrier.test.ts test/harness-host-inputs.test.ts test/harness-submissions.test.ts
```

结果：三组共 19 个测试文件、377 项测试全部通过。所有九个文件仅新增注释；`git diff --numstat` 删除列均为 0：

```text
146	0	packages/durable/src/harness/agent.ts
194	0	packages/durable/src/harness/compaction.ts
154	0	packages/durable/src/harness/context.ts
58	0	packages/durable/src/harness/define.ts
484	0	packages/durable/src/harness/generation.ts
220	0	packages/durable/src/harness/harness.ts
79	0	packages/durable/src/harness/inbox.ts
47	0	packages/durable/src/harness/json.ts
120	0	packages/durable/src/harness/live.ts
```

另外用 esbuild 对九个文件逐一做 TypeScript 解析检查，全部通过；自定义检查脚本确认新增行均以 `//` 开头且不位于块注释、字符串、模板字符串或 `${}` 表达式内。`git diff --check` 无空白错误。

## 未完成或风险

- 九个目标文件没有剩余缺口。按任务限制未运行 `npm run check`、`npm run build` 和全仓测试，因此没有仓库级类型检查结果；上述 Vitest 测试为直接相关测试集。
- 首轮测试曾因其他并行组尚未完成的 `packages/durable/src/harness/scheduler.ts` 出现短暂解析错误而中断；该文件完成后重跑全部通过，本组未修改该文件。
