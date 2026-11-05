# 组 e07

状态：完成

## 完成文件

所有示例均在 `packages/durable` 下执行
`env -u OPENAI_API_KEY node --conditions=source --experimental-strip-types test/examples/<file>.ts`，
退出码均为 0；输出与文件头导读核对一致。

- packages/durable/test/examples/19-inbox.ts：完整；核对 `Conversation.submit` 的 `whenBusy` 默认 followUp 与 steer/reject 及 `type: "write"`、`Submission.abort`、`InboxDoc` 快照、`entries` 顺序；输出 rejected/withdraw/inbox/first/follow-up/steer/note/withdrawn 与最终 transcript。
- packages/durable/test/examples/20-late-join.ts：完整；核对 `defineExtension`/`defineTool` 的流式工具、`root.watch(context)` 首帧、`LiveDoc` 中 run 的生命周期、`waitForIdle`；输出 view entries、工具槽位与逐次增长的回答，最终 entries 与导读一致。
- packages/durable/test/examples/21-subagent-foreground.ts：完整；核对 `defineTool` 的 `replay: "safe"`、`ToolExecutionApi.commit/conversation/details`、`tx.scanConversations({ ownerTaskId })`、`configure` 的 `extensions.remove`、`Submission.wait` 收窄、watch 读取 `pi.live` 工具 details；输出父工具调用、缩进子代理回答与父回答。
- packages/durable/test/examples/22-subagent-background.ts：完整；核对 `defineDoc` Subagents、Anchor/Reporter 的 `background` 与 ownership、`runtime.conversation/commit`、`whenBusy` followUp/steer、requestId 去重、`openNodeSqliteStorage` 重开、`LiveDoc.run`；输出 spawn/send/stop/status 及重启后 `reader: Moby Dick.`。
- packages/durable/test/examples/23-child-tasks.ts：完整；核对 Payment/Checkout 的 `defineTask`、`tx.createTask` 的 task ownership、`waiting` 的 checkpoint/on/policy failFast、`runtime.sleepUntil`、`runtime.outcomes`、`abortTask`/`watchTaskGraph`、sqlite 重开；输出三种场景的付款状态、任务树与 checkout 结果。
- packages/durable/test/examples/24-compaction.ts：完整；核对 faux `models` 的 contextWindow/maxTokens、`settings.compaction` getter、`LiveDoc.compactions`、`root.compact`、`Submission.status/placement`、`CompactionEntry.is`、`conversation.context/entries`；输出五轮阈值压缩、手动压缩 queued->done 与 overflow 摘要。
- packages/durable/test/examples/25-coding-agent.ts：完整；核对 `CodingTools`、`section` 的 tag:false 与 input.env.cwd、`HarnessSettings` getter、env 工厂、工具结果条目读取、`configure({ cwd })`；输出两行 bash pwd（workspace 与 workspace/app）。终检删除了起草期重复注释后已重跑。
- packages/durable/test/examples/26-plan-mode.ts：完整；核对 `defineDoc` 的 history rewindable/fork asOf、`defineTool` 的 `control.terminate`、extensions add/null、tools 白名单/null、`agent()` 解析、system 消息的 sections/toolsAdded/toolsRemoved；输出默认工具、[read, submit_plan]、计划数组、恢复后的工具与两条 system 记录。
- packages/durable/test/examples/27-reviewer.ts：完整；核对 `createConversation` 的 ownerless 与完整 agent 配置、GenerationTask `onYield` 的 continue、`createReadTool`、entries 正序打印；输出 reviewer: small/coding-tools+reviewer/[read]/true 与两轮审查。终检合并重复注释后已重跑。
- packages/durable/test/examples/28-sandbox-per-conversation.ts：完整；核对 `defineDoc` 的 fork initial、env 异步工厂的 `read.snapshot`、`createConversation` 的 init(tx, id)、`NodeExecutionEnv` 的 cwd、真实 `readFile`；输出 alice/bob 各自目录中的 note.txt 内容。
- packages/durable/test/examples/29-tool-override.ts：完整；核对 `createBashTool({ commandPrefix })` 的同名替换、`wrapTool` 在最终胜出定义上构造包装、try/finally 计时、`extensions.add`；输出 plain 空 VIRTUAL_ENV、python 为 .venv、timed bash calls 2。终检合并重复注释后已重跑。
- packages/durable/test/examples/30-reload-and-restart.ts：完整；核对同名扩展热替换发布新快照、门闩保证在途调用使用旧闭包、`openNodeSqliteStorage` 重开、扩展选择只持久化名字并在安装后重新解析；输出 v1/v2、重开前 []、安装后 [version]。终检合并重复注释后已重跑。
- packages/durable/test/examples/31-transcript.ts：完整；核对 `ConversationTranscript` 的构造与 `resume`、`root.watch(ctx, { min, max })`、`start` 串行投递、窗口裁剪与 gap 填充；输出 attach/live/load earlier/resume after 40 missed/fill gap/resume after 3 missed 各行。
- packages/durable/test/examples/32-tests-after-edits.ts：完整；核对 `runEndTask` 钩子的 afterRun、RunTests 任务、`conversation.submit(tx, { whenBusy: "followUp", requestId })`、`LiveDoc.run.afterRun`、`ToolResultEntry`、entries 正序；输出两次测试尝试、排队输入与最终测试通过。
- packages/durable/test/examples/33-turn-limit-and-continue.ts：完整；核对 `maxTurns`、`submit({ type: "continue" })`、`ConversationBusy`、`LiveDoc.runFailure`、entries 正序；输出 turn_limit、忙碌拒绝、空继续与四步完成。
- packages/durable/test/examples/34-submit-in-commit.ts：完整；核对 `defineDoc` Visitors、`harness.commit(tx)` 内 `tx.doc` 与 `root.submit(tx, ...)`、whenBusy steer 与 whenIdle reject、requestId 去重、snapshot；输出 ana/bob 状态、两条输入与 recorded 文档值。
- packages/durable/test/examples/35-durable-on-the-store.ts：完整；核对 `StoreStorage.open(owner)`、`self.table`/`self.open`/`self.tx`、`store.lastSeq`/`store.export`、Harness 重开后 `scanEntries`；输出 seqs taken、manifest、按 owner/kind 的 parts 与重开后的条目，与导读一致。
- packages/durable/test/examples/36-durable-views.ts：完整；核对 `local`/`defineFacet`/`method`/`self.open`/`self.follow`/`self.derive`、`observeConversation(min: 50)`、`observeTaskGraph`、summary.watch 的 delta ops、host/store 关闭顺序；输出三行与导读逐字一致。
- packages/durable/test/examples/37-harness-registry.ts：完整；核对 `defineRegistry`、`serve` compose、`self.registry`/`self.retryOn`/`self.contribute`/`self.follow`、`registryReader`、snapshotOf 的冲突 report、hold 与 retry；输出 registry_conflict、activation_failed、greet/transcript、关闭后的 failed 与重试后的 live，与导读一致。

## 未修改的数据/配置文件

- 本组无。未修改 `study-coverage.json`、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md`、任何 `.json` 配置或其他代理的报告。

## 未完成或风险

- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化、git 写操作或 npm install；注释的语法与位置仅由 `node --experimental-strip-types` 实际执行验证，未经过类型检查器。
- 19 个示例全部在未设置 `OPENAI_API_KEY` 的离线分支运行；真实 OpenAI 分支（21、22）以及真实费用路径未执行。
- 25、27、29、30 在终检时删除了起草阶段重复的中文注释行；删除内容均为本组添加的注释，原代码行未改动。最终 diff 为 25: 20/3、27: 19/2、29: 19/2、30: 19/3，其余 15 个文件为纯新增。
- 示例都是打印型脚本，没有断言；结论来自逐行阅读与实际输出核对，不是测试套件验证。
- 22 含真实定时器与慢速流式回答，离线运行需数秒；固定 50ms 的打印等待在慢机器上可能不足，文件内已注明。
