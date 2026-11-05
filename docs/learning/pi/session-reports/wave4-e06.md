# 组 e06

状态：完成

## 完成文件

- packages/durable/test/examples/00-conversation.ts：完整；核对 createSession、MemoryStorage、Session.commit、Tx.createConversation、Session.close；运行 `node --conditions=source --experimental-strip-types test/examples/00-conversation.ts`，输出 `standalone conversation: { id: 2 }`。
- packages/durable/test/examples/01-documents.ts：完整；核对 defineDoc 的 scope/history/fork/checkpointWhen、Tx.doc 的 Draft、snapshot 与 snapshotAsOf；运行同一命令，输出 latest/first/second 三个值，分别为 after goodbye/after hello/after goodbye。
- packages/durable/test/examples/02-forks.ts：完整；核对 Tx.forkConversation(parentId, at, ownership)、scanEntries 分页、fork:"asOf"；运行后输出分叉转录 `[ 'hello' ]`、分叉文档和父子独立编辑结果。
- packages/durable/test/examples/03-owned-conversations.ts：完整；核对 defineTask 泛型/phases、Tx.createTask 的 ownership/conversationId/background、Task 拥有的 Tx.createConversation、AgentRegistry 快照；运行后输出 supervisor task 3、child owner `{ conversationId: 2, taskId: 3 }` 和 registry。
- packages/durable/test/examples/04-watches.ts：完整；核对 Session.watchDoc 返回 DocumentWatch 或 undefined、WatchHandle.value/start/stop、WatchCall 的 value/failed 判别、忙时折叠与 10,000 op 上限；运行后输出两帧和 `listener calls: 2`。
- packages/durable/test/examples/05-harness.ts：完整；核对 defineTool 的 schema 推导与运行时校验边界、defineExtension、registry.install、Harness.open/root 的创建语义、AgentDoc 存储选择、Conversation.agent 解析；运行后输出 root 1、stored agent `{ thinkingLevel: 'low' }`、resolved low/files/read。
- packages/durable/test/examples/06-configuration.ts：完整；核对 AppTool 交叉类型、HarnessSettings 的 getter 实时读取、configure 的替换/{remove}/null、registry.uninstall/install；运行后输出 default/stored/model/without search/uninstalled/reinstalled 六组结果，与文件头一致。
- packages/durable/test/examples/07-harness-conversations.ts：完整；核对 defineEntry 的运行时 kind 校验、token.is 只按 kind 收窄、Conversation.commit 绑定会话时 createTask 默认归属、createConversation、fork 继承 AgentDoc 的 asOf、conversation() 可能返回 undefined；运行后输出 typed entry true、minimal、high、lookup true。
- packages/durable/test/examples/08-context.ts：完整；核对 ContextView 的 head/entries/contributions/messages、逐目标最新编辑生效、EXCLUDED_STOP_REASONS、工具结果按调用顺序重排、缺失结果合成错误、孤立结果丢弃、head:"self"、entries 分页；运行输出 raw/request/fork/after summary/newest 五组视图，与文件头一致。
- packages/durable/test/examples/09-registry-reload.ts：完整；核对同名 install 原地替换并一次发布、uninstall 按名称、wrapTool 仅在包装扩展被选中时应用、TaskRuntime.registry 的阶段快照；运行输出 reload/audit/uninstall 三组工具描述。
- packages/durable/test/examples/10-extension-state.ts：完整；核对 Todos 的 scope/history/fork、defineTool.execute(args, api, callContext)、api.commit 与 api.conversationId、section 的 input.read.snapshot、faux 队列；运行输出 `todos: { items: [ 'fix the build' ] }` 和两条 system 消息，第二条含 `<todos>` 段。
- packages/durable/test/examples/11-tasks.ts：完整；核对 defineTask 的 S/R 泛型、阶段必须 runtime.commit、NextTaskState、abort、createTask 省略 conversationId、waitForTask 的返回类型；运行输出 `{ status: 'completed', result: { receipt: 500 } }`。
- packages/durable/test/examples/12-recovery.ts：完整；核对 SQLite 重开、runtime.memo 的首写者胜与单/双参数形式、sleepUntil 落库语义、getTask 只读、waitForTask 隐式恢复、close 将中断任务写回 pending；运行输出 tick 1-2、pending checkpoint n=2、tick 3-5、completed `counted to 5`。
- packages/durable/test/examples/13-chat.ts：完整；原有行注释保留，新增文件导读；核对 faux provider、section(tag:false)、submit 与 wait 两阶段、tx.entry 读取 AssistantEntry、entries 逆序；运行输出 answer `Paris.` 和 transcript `[ 'pi.user', 'pi.system', 'pi.assistant' ]`。
- packages/durable/test/examples/14-system-prompt.ts：完整；原有行注释保留，新增文件导读；核对 section 的 tag:false、wrapSection 按 key 包装、env({cwd})、SystemEntry.is、configure 修改 cwd 后只追加变化段；运行输出 root/subagent 提示词和 cwd 修改后的两条 system 消息，与文件头一致。
- packages/durable/test/examples/15-real-model.ts：完整；原有行注释保留，新增文件导读；核对 OPENAI_API_KEY 只判断 undefined、openaiProvider、LiveDoc 观察、printText 前缀去重、AssistantEntry 补尾部；未运行（需要真实 API key、网络与费用）。
- packages/durable/test/examples/16-coding-tools.ts：完整；核对 fauxToolCall 参数类型、CodingTools、ToolTask 的 beforeTool/afterTool 在参数校验后执行、ToolResultEntry.is、JSONL 存储、env(target) 按 agent cwd 构建；运行输出 read/edit/bash 结果、最终回答、`file: "hello durable\n"` 和保留的临时存储目录。
- packages/durable/test/examples/17-print.ts：完整；核对 process.argv[2] 回退、provider 选择（空字符串仍走真实分支）、工具扩展、submit/wait、settled 判别收窄、AssistantEntry 与 flatMap 拼接、exitCode 1；运行输出 `This directory holds the durable package sources, tests, and docs.`。
- packages/durable/test/examples/18-json.ts：完整；核对参数解析与 storage 三选一、print 的 JSONL 输出、Conversation.watch 返回 ConversationWatch、WatchCall.value/ops、state 模式的 newest 过滤与条件展开、waitForIdle 不等待后台任务、stop/close 与 stderr 路径；运行 ops 模式（memory）和 state 模式（默认 sqlite），分别得到 view/ops 与 entries/live 的 JSONL；注释后再次运行 memory 的 ops 模式成功。

## 未修改的数据/配置文件

- 本组无。未修改 `study-coverage.json`、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md`、任何 `.json` 配置或其他代理的报告。

## 未完成或风险

- packages/durable/test/examples/15-real-model.ts：未运行。需要有效的 OPENAI_API_KEY、网络与账户额度；本次只做了全文阅读和静态核对，文件头中的流式输出形态与 skip 分支来自代码，不是本次实测。
- 所有示例都是打印型脚本，没有断言；本次通过逐行检查实际输出验证，没有运行测试套件。
- 按任务要求未运行 `npm run check`、`npm run build`、全仓格式化、git 写操作或 npm install；18/19 个示例已直接执行，语法与注释位置由运行验证，15 仅静态核对。
- 16 和 18 会按设计留下临时存储（16 的 JSONL 目录、18 的 sqlite 文件或 JSONL 目录），本次未清理；18 的 memory 模式不产生位置。
- 示例普遍没有 try/finally；运行中出错时可能跳过 close 和临时目录清理，文件头已注明该行为。
