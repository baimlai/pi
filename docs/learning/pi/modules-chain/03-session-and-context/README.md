# M03 会话、上下文与压缩

<a id="m03-outcomes"></a>
## 学完能回答

读完这一篇，应该能不用翻源码地回答下面这些问题；每题都指向本篇对应章节或源码位置。

1. `Agent.messages` 为什么不能直接当会话文件？JSONL 条目树、当前分支、模型投影和 Agent 工作副本各回答什么问题？
2. `appendMessage()` 如何分配 `id` 和 `parentId`？第一次真正创建 JSONL 文件发生在哪一步，为什么不是打开 pi 就创建？
3. `branch()` 为什么能让文件里同时存在旧分支和新分支？恢复会话时 `leafId` 如何确定？
4. `buildContextEntries()` 如何从当前路径得到“最新压缩 + 保留尾部 + 压缩后条目”？`firstKeptEntryId` 找不到或等于压缩条目自身时分别怎样？
5. 一次 `context_edit` 如何只改变模型视图而不改写旧 JSONL 行？同一目标有多条编辑时哪一条生效？
6. 压缩检查点为什么必须保存 `systemMessage`？压缩后旧 system 消息为什么不会重复发送？
7. `_handleAgentEvent()` 为什么先让扩展处理、再发公开事件、最后持久化？哪些角色会在 `message_end` 生成条目？
8. `agent_end`、`agent_before_settle` 和 `agent_settled` 各表示什么？`_startRun()` 在 `agent_end` 之后还可能做什么？

<a id="m03-duty"></a>
## 一句话职责

保存对话的完整历史（JSONL + 内存树），在每次模型请求前把“当前分支 + 压缩检查点 + 上下文编辑”投影成模型可见的消息，并在上下文过大时生成摘要。

<a id="m03-plain"></a>
## 大白话总览：为什么不能把 `Agent.messages` 当会话文件

一次提问在低层 Agent 里会经历这样的消息数组：

```text
[user]
[user, assistant(toolCall)]
[user, assistant(toolCall), toolResult]
[user, assistant(toolCall), toolResult, assistant]
```

这个数组一直在变：assistant 在流式生成时还只是草稿，工具执行后才补上 toolResult，压缩可能换掉很早的前缀，`context_edit` 可能让某条旧消息从模型视野里消失，重试还可能把失败的一轮整体隐去。所以 `Agent.state.messages` 只是“低层循环此刻手里的工作副本”，不是可靠的历史记录。

如果每次都把这个数组整体重写到一个 JSON 文件，会遇到几个直接问题：

- 写到一半崩溃会破坏已有历史，无法只追加一行；
- 旧消息被覆盖后无法审计，也无法回到旧节点开新分支；
- 被 `context_edit` 隐藏的内容、被压缩的原文都需要保留，而模型不应该再看到它们；
- UI、导出、恢复会话和模型请求需要的历史视图并不完全相同。

因此会话层采用“两个真相”的分工：

| 层 | 存在哪里 | 回答的问题 | 本文示例 |
| --- | --- | --- | --- |
| 原始条目树 | JSONL 文件与 `SessionManager.fileEntries` / `byId` | 历史上实际写入了什么，包括所有分支、旧内容、编辑和压缩 | `a1` 到 `a8` 全部保留 |
| 当前分支 | `leafId` 沿 `parentId` 回溯 | 这次对话沿着哪条路径走到当前叶子 | `a1 -> a2 -> ... -> a8` |
| 模型投影 | `buildSessionProjection()` 的返回值 | 这次请求模型能看到哪些消息、按什么顺序 | `a5` 本身不出现，`a4` 被替换 |
| Agent 工作副本 | `agent.state.messages` | 低层循环此刻正在使用哪些消息 | 每次请求前被投影覆盖 |

运行期间，内存里的 `SessionManager` 是权威；磁盘 JSONL 只追加，作为恢复和审计来源。投影只遍历内存树，不读磁盘。恢复会话时才从 JSONL 重建条目树、索引和叶子。

本模块不负责：供应商流解析和 HTTP 请求（M02/M04）、工具实现与执行（M02）、终端渲染（M05）、扩展自己的业务规则。它负责的是条目格式、树与分支、投影、压缩的编排和持久化时机。

<a id="m03-terms"></a>
## 关键概念

| 概念 | 含义 | 具体例子 |
| --- | --- | --- |
| entry（条目） | 会话文件中的一条记录，也是树上的一个节点 | `{"type":"message","id":"a3","parentId":"a2",...}` |
| header（会话头） | JSONL 第一行，标识整份会话，不是树节点 | `{"type":"session","version":3,"id":"s-7f3a...","cwd":"/repo"}` |
| `id` | 条目 id，在当前文件内由随机 UUID 前 8 位生成，冲突时重试 | `a3`、`c1` |
| `parentId` | 父条目 id；根条目为 `null` | `a4.parentId === "a3"` |
| root / leaf | 根是没有父节点的条目；leaf 是当前游标 `leafId` 指向的节点 | 追加结束后 `leafId === "a8"` |
| branch（分支） | 从根沿 `parentId` 到某个叶子的路径 | `a1 -> a2 -> ... -> a8`，不包含兄弟节点 |
| `fileEntries` | 内存中的全部条目，包含所有分支，不等于当前分支 | 旧分支的 `b7` 仍在数组里，但不在当前路径上 |
| `byId` | 条目 id 到条目对象的索引 | `byId.get("a4")` 直接取到工具结果条目 |
| `appendMessage` | 给消息分配 id、以当前 leaf 为父节点追加，并推进 leaf | 返回新条目 id `a3`，此后 `leafId === "a3"` |
| path（路径） | `buildSessionPath()` 产出的根到叶原始条目数组 | `[a1,a2,a3,a4,a5]` |
| contextEntries | 压缩感知后的重放条目顺序，仍可能包含不贡献消息的条目 | `[c1,a5,a6,a7]` |
| projection（投影） | 把当前分支转换成模型消息的完整结果 | `{ entries, messages, thinkingLevel, model }` |
| projected entry | 投影中的一项，保存 `sourceEntry` 与它贡献的 `messages` | 来源 `a5`（`context_edit`），贡献 `[]` |
| `context_edit` | 追加式编辑：指向旧条目，替换它的 `content` 或隐藏它 | `targetId:"a4"`，替换为一段短说明 |
| `compaction` | 压缩检查点，保存摘要、原文保留起点和系统状态快照 | `summary:"..."`、`firstKeptEntryId:"a5"` |
| `systemMessage` | 压缩边界处的完整系统提示与工具状态快照 | 投影时作为首条 system 重放 |
| `custom` | 扩展私有状态，持久化但不进入模型上下文 | 插件计数器、缓存索引 |
| `custom_message` | 扩展上下文消息，进入模型上下文；`display` 只控制 UI | `customType:"task-note"`，`display:false` 仍会发给模型 |
| `branch_summary` | 离开旧分支时生成的摘要，挂在目标路径上 | `parentId` 指向新分支节点，`fromId` 记录旧叶子 |
| `model_change` / `thinking_level_change` | 模型与思考级别的状态条目，不产生对话消息 | 恢复会话时按路径最后一条生效 |
| `entry.id` vs `toolCallId` vs session id | 三个不同命名空间：树上节点、模型工具协议、整份文件 | `a3`、`call_01`、`s-7f3a...` |

<a id="m03-position"></a>
## 在链路中的位置

### 上游

- [M05 模式与 TUI](../05-modes-and-tui/README.md)：用户输入进入 `AgentSession.prompt()`。
- [M02 Agent 循环](../02-agent-loop/README.md)：Agent 事件通过订阅进入 `_handleAgentEvent()`；低层循环的请求边界会调用会话安装的投影回调。
- [M01 入口与装配](../01-entry-and-config/README.md)：创建或恢复 `SessionManager`，把已有消息装入 `Agent`。

### 下游

- `Agent.prompt()` / `agent.continue()`：会话把准备好的消息交给低层循环。
- [M04 模型访问](../04-model-access/README.md)：压缩摘要本身也是一次模型请求。
- 磁盘：`~/.pi/agent/sessions/--<cwd>--/<session>.jsonl`。

对应全链路：[S5 会话入口](../00-full-chain/README.md#m00-s5)、[S6 运行准备](../00-full-chain/README.md#m00-s6)、[S8 主循环](../00-full-chain/README.md#m00-s8)、[S11 工具往返](../00-full-chain/README.md#m00-s11)、[S12 持久化](../00-full-chain/README.md#m00-s12)、[S13 收尾](../00-full-chain/README.md#m00-s13)、[多轮](../00-full-chain/README.md#m00-multiturn)、[压缩](../00-full-chain/README.md#m00-compaction)、[失败与重试](../00-full-chain/README.md#m00-failure)。

低层循环如何消费这些消息，见 M02 的 [runLoop](../02-agent-loop/README.md#m02-walk-loop)、[事件序列](../02-agent-loop/README.md#m02-events) 和 [数据变化](../02-agent-loop/README.md#m02-data)。

<a id="m03-example"></a>
## 运行示例：两轮对话、一个工具结果和一次 `context_edit`

场景：

```text
用户：读取 README.md 前 20 行并总结
助手：调用 read 工具
工具：返回 README 前 20 行
扩展：在 turn_end 把这条工具结果替换成一句短说明
助手：README 介绍了项目结构 ...
用户：那第 21 到 40 行呢？
助手：第 21 到 40 行是 ...
```

为了让树结构容易读，下面用短 id。真实 id 是 8 位随机十六进制字符串；时间戳和长文本也做了缩写。

### 实际追加的 JSONL

新会话创建时，`model_change` 和 `thinking_level_change` 先进入内存。第一次用户消息到达时才创建文件，并把这些设置条目一起写出：

```jsonl
{"type":"session","version":3,"id":"s-7f3a","timestamp":"2026-11-06T09:00:00.000Z","cwd":"/repo"}
{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-11-06T09:00:00.100Z","provider":"anthropic","modelId":"claude-sonnet-4-5"}
{"type":"thinking_level_change","id":"t1","parentId":"m1","timestamp":"2026-11-06T09:00:00.101Z","thinkingLevel":"off"}
{"type":"message","id":"a1","parentId":"t1","timestamp":"2026-11-06T09:00:01.000Z","message":{"role":"system","content":"","sections":{"identity":"你是 pi ...","style":"..."},"toolsAdded":[{"name":"read","description":"读取文件","parameters":{"type":"object"}}],"timestamp":1762419601000}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-11-06T09:00:01.010Z","message":{"role":"user","content":[{"type":"text","text":"读取 README.md 前 20 行并总结"}],"timestamp":1762419601010}}
```

工具回合继续追加：

```jsonl
{"type":"message","id":"a3","parentId":"a2","timestamp":"2026-11-06T09:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_01","name":"read","arguments":{"path":"README.md","limit":20}}],"provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"toolUse","timestamp":1762419602000}}
{"type":"message","id":"a4","parentId":"a3","timestamp":"2026-11-06T09:00:02.050Z","message":{"role":"toolResult","toolCallId":"call_01","toolName":"read","content":[{"type":"text","text":"# pi\nREADME 的原始长内容 ..."}],"isError":false,"timestamp":1762419602050}}
{"type":"context_edit","id":"a5","parentId":"a4","timestamp":"2026-11-06T09:00:02.100Z","targetId":"a4","replacement":{"content":[{"type":"text","text":"[旧工具结果已折叠] README 说明项目结构，共 20 行"}]}}
{"type":"message","id":"a6","parentId":"a5","timestamp":"2026-11-06T09:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"README 介绍了项目结构 ..."}],"provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"stop","timestamp":1762419603000}}
```

第二轮：

```jsonl
{"type":"message","id":"a7","parentId":"a6","timestamp":"2026-11-06T09:00:10.000Z","message":{"role":"user","content":[{"type":"text","text":"那第 21 到 40 行呢？"}],"timestamp":1762419610000}}
{"type":"message","id":"a8","parentId":"a7","timestamp":"2026-11-06T09:00:11.000Z","message":{"role":"assistant","content":[{"type":"text","text":"第 21 到 40 行是 ..."}],"provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"stop","timestamp":1762419611000}}
```

注意几个事实：

- `a5` 不是消息，而是一条编辑记录；它不直接贡献模型消息，但仍然占据树上的一个节点，并推进 leaf。
- `a4` 的原始长内容仍在文件里，`a5` 只影响之后的投影。
- `a1` 的 `content` 为空、正文在 `sections` 里，是因为系统提示以“章节补丁 + 工具声明”的形式保存。请求重放时，支持中途 system 消息的协议先渲染首条 system，再逐条渲染后续补丁；不支持这种协议的路径才用 `collapseSystemMessages()` 把全部补丁合并成一条首 system 消息。
- `m1`、`t1` 和 `a1` 在 `a2` 到来前只在内存里；`a2` 是第一条 user/assistant 消息，触发第一次真正建文件，所以前五行一次写出。之后通常每追加一个条目只写一行。

### 当前分支与 leaf

```text
a1 system
└─ a2 user
   └─ a3 assistant(toolCall call_01)
      └─ a4 toolResult(call_01)
         └─ a5 context_edit(target=a4)
            └─ a6 assistant(总结)
               └─ a7 user
                  └─ a8 assistant
leaf = a8
```

`a5` 的 `parentId` 是 `a4`，所以它位于主路径上；它的 `targetId` 是 `a4`，所以投影时编辑的是更早的工具结果。一个条目可以“自己是新节点，但指向旧目标”。

### 工具结果之后、下一次请求之前

扩展在 `turn_end` 提交 `context_edit` 后，下一次 assistant 请求的投影过程是：

1. `buildSessionPath()` 从 `leaf` 回溯到根，得到 `[a1,a2,a3,a4,a5]`。
2. `buildContextEntries()` 没有发现压缩，原样返回这条路径。
3. `buildSessionProjection()` 收集编辑：`targetId=a4` 的最新编辑是 `a5`。
4. `projectContextEntry(a5, undefined)` 返回 `[]`；`projectContextEntry(a4, a5)` 返回替换后的消息。
5. 投影消息为 `[a1, a2, a3, a4']`，其中 `a4'` 的 `content` 是短说明，`toolCallId` 仍是 `call_01`。

| 来源条目 | 投影贡献 | 说明 |
| --- | --- | --- |
| `a1` system | 一条 system | 章节和工具声明由系统提示重放 |
| `a2` user | 一条 user | 原问题 |
| `a3` assistant | 一条 assistant | 含 `toolCall call_01` |
| `a4` toolResult | 一条替换后的 toolResult | 编辑来自 `a5`，`content` 被替换 |
| `a5` context_edit | 无 | 编辑本身不进入消息数组 |

第二轮结束后，最终投影是：

```text
[a1 system, a2 user, a3 assistant(toolCall), a4' toolResult, a6 assistant, a7 user, a8 assistant]
```

`a5` 仍然不出现。原始 JSONL 中 `a1` 到 `a8` 一行不少；差异只存在于投影。

### 如果只隐藏工具结果会怎样

如果把 `a5` 的 `replacement` 改成 `null`，`a4` 会从投影中完全消失，但 `a3` 里的 `toolCall call_01` 仍在。供应商通常要求每个 toolCall 都有对应的 toolResult，这种“孤立 toolCall”可能让下一次请求被拒绝。需要同时隐藏调用和结果时，pi 使用 `_omitRecoveryAttempt()` 成组追加 `context_edit`，而不是只隐藏其中一边。

<a id="m03-files"></a>
## 文件路由

| 文件 | 职责 |
| --- | --- |
| [agent-session.ts](../../../../../packages/coding-agent/src/core/agent-session.ts "agent-session.ts") | 会话门面：prompt、扩展、事件、持久化、重试、压缩触发 |
| [session-manager.ts](../../../../../packages/coding-agent/src/core/session-manager.ts "session-manager.ts") | JSONL 读写、条目树、上下文投影 |
| [compaction/compaction.ts](../../../../../packages/coding-agent/src/core/compaction/compaction.ts "compaction.ts") | 阈值判断、摘要生成、压缩条目 |
| [compaction/branch-summarization.ts](../../../../../packages/coding-agent/src/core/compaction/branch-summarization.ts "branch-summarization.ts") | 切换分支时总结离开的分支 |
| [messages.ts](../../../../../packages/coding-agent/src/core/messages.ts "messages.ts") | `AgentMessage` -> 供应商消息的转换 |
| [session-export.ts](../../../../../packages/coding-agent/src/core/session-export.ts "session-export.ts") | 会话导出 |
| [core/extensions/runner.ts](../../../../../packages/coding-agent/src/core/extensions/runner.ts "runner.ts") | `before_agent_start`、`agent_end`、`agent_before_settle` 等会话钩子 |
| [packages/ai/src/utils/transcript.ts](../../../../../packages/ai/src/utils/transcript.ts "transcript.ts") | 重放 system 消息，得到当前完整提示词和工具状态 |

<a id="m03-routes"></a>
## 函数路由

### 会话运行

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M03.session.prompt` | `AgentSession.prompt` | [agent-session.ts:3590](../../../../../packages/coding-agent/src/core/agent-session.ts#L3590 "async prompt(text: string") | 空闲运行或忙碌排队 |
| `M03.session.startRun` | `_startRun` | [agent-session.ts:3205](../../../../../packages/coding-agent/src/core/agent-session.ts#L3205 "_startRun(trigger") | 一次运行的完整生命周期 |
| `M03.session.prepareRun` | `_prepareRun` | [agent-session.ts:3297](../../../../../packages/coding-agent/src/core/agent-session.ts#L3297 "_prepareRun(trigger") | 压缩检查、扩展钩子、起始消息 |
| `M03.session.postRun` | `_handlePostAgentRun` | [agent-session.ts:3388](../../../../../packages/coding-agent/src/core/agent-session.ts#L3388 "_handlePostAgentRun()") | 重试、压缩恢复、队列检查 |
| `M03.session.event` | `_handleAgentEvent` | [agent-session.ts:1872](../../../../../packages/coding-agent/src/core/agent-session.ts#L1872 "_handleAgentEvent = async") | 扩展 -> 公开事件 -> 持久化 |
| `M03.session.appendCall` | `appendMessage` | [agent-session.ts:1971](../../../../../packages/coding-agent/src/core/agent-session.ts#L1971 "sessionManager.appendMessage(event.message)") | 完整消息的落盘调用点 |
| `M03.session.requestProjection` | `agent.prepareRequest` | [agent-session.ts:1274](../../../../../packages/coding-agent/src/core/agent-session.ts#L1274 "this.agent.prepareRequest = async") | 每次请求前替换为会话投影 |
| `M03.session.nextTurn` | `prepareNextTurnWithContext` | [agent-session.ts:1484](../../../../../packages/coding-agent/src/core/agent-session.ts#L1484 "this.agent.prepareNextTurnWithContext = async") | 轮间刷新上下文、模型、工具 |
| `M03.session.compactBeforeResponse` | `_compactBeforeNextAssistantResponse` | [agent-session.ts:1247](../../../../../packages/coding-agent/src/core/agent-session.ts#L1247 "_compactBeforeNextAssistantResponse(context: AgentContext)") | 工具结果之后、下一次回答前的压缩检查 |
| `M03.session.turnBoundary` | `_dispatchTurnEndBoundary` | [agent-session.ts:1373](../../../../../packages/coding-agent/src/core/agent-session.ts#L1373 "private async _dispatchTurnEndBoundary(") | 提交 `turn_end` 扩展草稿与编辑 |
| `M03.session.refreshContext` | `_refreshFinalizedContext` | [agent-session.ts:1543](../../../../../packages/coding-agent/src/core/agent-session.ts#L1543 "private _refreshFinalizedContext(): void") | 用投影替换 Agent 工作副本并登记来源 |
| `M03.session.beforeSettle` | `_runBeforeSettleBoundary` | [agent-session.ts:3454](../../../../../packages/coding-agent/src/core/agent-session.ts#L3454 "private async _runBeforeSettleBoundary()") | 收尾边界、提交草稿、判断是否继续 |
| `M03.session.settled` | `_emitAgentSettled` | [agent-session.ts:1824](../../../../../packages/coding-agent/src/core/agent-session.ts#L1824 "private async _emitAgentSettled()") | 结束忙碌、发布 `agent_settled`、处理延迟任务 |
| `M03.session.sourceId` | `_findPersistedMessageEntryId` | [agent-session.ts:2053](../../../../../packages/coding-agent/src/core/agent-session.ts#L2053 "private _findPersistedMessageEntryId(message: AgentMessage)") | 从工作消息追溯到树上的来源条目 |

### 存储与投影

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M03.store.append` | `SessionManager.appendMessage` | [session-manager.ts:1936](../../../../../packages/coding-agent/src/core/session-manager.ts#L1936 "appendMessage(message: Message") | 分配 id/parentId 并追加 JSONL |
| `M03.store.projection` | `buildSessionProjection` | [session-manager.ts:817](../../../../../packages/coding-agent/src/core/session-manager.ts#L817 "export function buildSessionProjection(") | 分支 + 压缩 + 编辑 -> 消息 |
| `M03.store.entries` | `buildContextEntries` | [session-manager.ts:705](../../../../../packages/coding-agent/src/core/session-manager.ts#L705 "export function buildContextEntries(") | 选出压缩检查点与保留原文 |
| `M03.store.projectEntry` | `projectContextEntry` | [session-manager.ts:775](../../../../../packages/coding-agent/src/core/session-manager.ts#L775 "export function projectContextEntry(") | 应用单条 `context_edit` |
| `M03.store.context` | `buildSessionContext` | [session-manager.ts:871](../../../../../packages/coding-agent/src/core/session-manager.ts#L871 "export function buildSessionContext(") | 只要消息和设置的简化包装 |
| `M03.store.method` | `SessionManager.buildSessionContext` | [session-manager.ts:2434](../../../../../packages/coding-agent/src/core/session-manager.ts#L2434 "buildSessionContext()") | 实例方法，读当前分支 |
| `M03.store.path` | `buildSessionPath` | [session-manager.ts:569](../../../../../packages/coding-agent/src/core/session-manager.ts#L569 "function buildSessionPath(") | 从叶子沿 `parentId` 取根到叶路径 |
| `M03.store.entryMessages` | `sessionEntryToContextMessages` | [session-manager.ts:650](../../../../../packages/coding-agent/src/core/session-manager.ts#L650 "export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {") | 单条条目到零或多条消息 |
| `M03.store.persist` | `SessionManager._persist` | [session-manager.ts:1871](../../../../../packages/coding-agent/src/core/session-manager.ts#L1871 "_persist(entry: SessionEntry): void {") | 首次建文件，之后逐行追加 |
| `M03.store.appendCompaction` | `SessionManager.appendCompaction` | [session-manager.ts:2039](../../../../../packages/coding-agent/src/core/session-manager.ts#L2039 "appendCompaction<T = unknown>(") | 保存摘要与系统检查点 |
| `M03.store.appendEdit` | `SessionManager.appendContextEdit` | [session-manager.ts:2211](../../../../../packages/coding-agent/src/core/session-manager.ts#L2211 "appendContextEdit(targetId: string") | 追加内容替换或隐藏记录 |
| `M03.store.getBranch` | `SessionManager.getBranch` | [session-manager.ts:2390](../../../../../packages/coding-agent/src/core/session-manager.ts#L2390 "getBranch(fromId?: string): SessionEntry[] {") | 实例方法，返回指定叶子的原始路径 |
| `M03.store.branchMove` | `SessionManager.branch` | [session-manager.ts:2554](../../../../../packages/coding-agent/src/core/session-manager.ts#L2554 "branch(branchFromId: string): void {") | 只移动 leaf，不写历史 |
| `M03.store.branchSummary` | `SessionManager.branchWithSummary` | [session-manager.ts:2584](../../../../../packages/coding-agent/src/core/session-manager.ts#L2584 "branchWithSummary(") | 移动 leaf 并追加旧分支摘要 |
| `M03.store.createBranched` | `SessionManager.createBranchedSession` | [session-manager.ts:2640](../../../../../packages/coding-agent/src/core/session-manager.ts#L2640 "createBranchedSession(leafId: string") | 把一条路径抽成新会话文件 |
| `M03.store.load` | `loadEntriesFromFile` | [session-manager.ts:954](../../../../../packages/coding-agent/src/core/session-manager.ts#L954 "export function loadEntriesFromFile(") | 从磁盘读取并解析 JSONL |

### 系统提示

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M03.prompt.system` | `get systemPrompt` | [agent-session.ts:2538](../../../../../packages/coding-agent/src/core/agent-session.ts#L2538 "get systemPrompt()") | 当前系统提示 |
| `M03.prompt.rebuild` | `_rebuildSystemPrompt` | [agent-session.ts:2956](../../../../../packages/coding-agent/src/core/agent-session.ts#L2956 "_rebuildSystemPrompt(toolNames") | 工具或扩展变化后重建 |
| `M03.prompt.loadout` | `_preparePromptAndToolLoadout` | [agent-session.ts:3018](../../../../../packages/coding-agent/src/core/agent-session.ts#L3018 "private _preparePromptAndToolLoadout(") | 应用工具集合并生成章节补丁 |
| `M03.prompt.replay` | `getCurrentSystemMessage` | [transcript.ts:108](../../../../../packages/ai/src/utils/transcript.ts#L108 "export function getCurrentSystemMessage(") | 重放所有 system 消息，得到当前提示词与工具 |
| `M03.prompt.convert` | `convertToLlm` | [messages.ts:244](../../../../../packages/coding-agent/src/core/messages.ts#L244 "export function convertToLlm(messages: AgentMessage[])") | 应用层消息转供应商消息 |

### 压缩

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M03.compact.should` | `shouldCompact` | [compaction.ts:387](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L387 "export function shouldCompact(") | 按 token 用量和窗口判断 |
| `M03.compact.check` | `_checkCompaction` | [agent-session.ts:5137](../../../../../packages/coding-agent/src/core/agent-session.ts#L5137 "_checkCompaction(assistantMessage") | 选择 overflow / threshold 原因 |
| `M03.compact.auto` | `_runAutoCompaction` | [agent-session.ts:5375](../../../../../packages/coding-agent/src/core/agent-session.ts#L5375 "_runAutoCompaction(reason") | 执行压缩并用结果继续 |
| `M03.compact.summary` | `generateSummary` | [compaction.ts:931](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L931 "export async function generateSummary(") | 生成对话摘要 |
| `M03.compact.branch` | `generateBranchSummary` | [branch-summarization.ts:417](../../../../../packages/coding-agent/src/core/compaction/branch-summarization.ts#L417 "export async function generateBranchSummary(") | 分支切换摘要 |
| `M03.compact.prepare` | `prepareCompaction` | [compaction.ts:1277](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L1277 "export function prepareCompaction(") | 选切点、整理待摘要材料，不发请求 |
| `M03.compact.run` | `compact` | [compaction.ts:1417](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L1417 "export async function compact(") | 调用模型生成摘要，不修改会话 |
| `M03.compact.estimate` | `estimateProjectedContextTokens` | [compaction.ts:322](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L322 "export function estimateProjectedContextTokens(") | 投影感知的 token 估算 |

<a id="m03-store"></a>
## 会话文件与条目树

### JSONL 只有追加

`SessionManager.appendMessage()` 分配 `id` 和 `parentId`，然后把一行 JSON 追加到文件。它不修改旧行，也不删除旧行。简化后的条目：

```jsonl
{"type":"session","version":3,"id":"s1","timestamp":"...","cwd":"/repo"}
{"type":"message","id":"a1","parentId":null,"timestamp":"...","message":{"role":"user",...}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"...","message":{"role":"assistant",...}}
{"type":"message","id":"a3","parentId":"a2","timestamp":"...","message":{"role":"toolResult",...}}
{"type":"compaction","id":"a4","parentId":"a3","timestamp":"...","summary":"...","firstKeptEntryId":"a2"}
{"type":"message","id":"a5","parentId":"a4","timestamp":"...","message":{"role":"user",...}}
```

`parentId` 形成一棵树。新消息通常接在当前叶子后面；fork 或回到旧消息时，新条目接到旧节点后面，形成新分支。

`type` 不只 `message`。常见条目对上下文的贡献如下：

| `type` | 是否进入模型消息 | 说明 |
| --- | --- | --- |
| `message` | 是 | `system`、`user`、`assistant`、`toolResult` 原样贡献 |
| `custom_message` | 是 | 包装成 `custom`，再由 `convertToLlm()` 转成 user |
| `branch_summary` | 是（摘要非空时） | 包装成 `branchSummary`，转成 user |
| `compaction` | 是 | 贡献系统检查点（可选）和 `compactionSummary` |
| `context_edit` | 否 | 只影响目标条目的投影 |
| `custom` | 否 | 扩展私有状态，不注入模型 |
| `model_change` / `thinking_level_change` | 否 | 恢复模型与思考级别 |
| `label` / `session_info` / `usage` | 否 | 标签、标题、账务等元数据 |

### 内存树不是文件顺序

`SessionManager` 在内存里维护 `fileEntries`（全部条目）、`byId`（id 索引）和 `leafId`（当前游标）。文件顺序是“写入顺序”，不是“当前对话顺序”：

- `branch()` 只把 `leafId` 移到旧节点；下一次追加才写出新分支。
- 文件里可能先有 `a1 -> a2 -> a3`，再有 `a1 -> a4`；当前分支取决于 `leafId`，不是最后一行的简单倒推。
- 恢复会话时，`_buildIndex()` 把文件最后一条条目设为叶子；这不等同于之前某次内存里的 `branch()` 位置，除非之后又追加了条目。

### 原始文件 vs 模型视图

| 问题 | 原始 JSONL / `fileEntries` | 投影 `buildSessionProjection()` |
| --- | --- | --- |
| 包含哪些分支 | 所有分支 | 仅当前 root-to-leaf 路径 |
| 旧消息是否还在 | 是 | 可能被压缩边界排除 |
| 被编辑的消息 | 原始内容仍在 | `content` 被替换或整条隐藏 |
| 旧系统消息 | 都在 | 压缩后用检查点替代，保留区跳过 |
| 摘要 | 是独立条目 | 变成 `systemMessage`（若有）+ `compactionSummary` |
| 是否读磁盘 | 是恢复来源 | 否，纯内存计算 |

<a id="m03-walk-prompt"></a>
## 函数拆解一：`AgentSession.prompt()` 到 `_startRun()`

[prompt:3590](../../../../../packages/coding-agent/src/core/agent-session.ts#L3590 "async prompt(text: string") 做的是“接收一次输入并决定它如何进入运行”，不是直接发模型请求。顺序如下：

1. **settled 重入保护**：如果当前正在派发 `agent_settled`，把这次 `prompt()` 包装成延迟动作，等通知结束后再执行，避免在收尾回调里重入。
2. **扩展命令**：文字以 `/` 开头且允许模板展开时，先执行扩展命令。命令可以自己通过 `pi.sendMessage()` 管理 LLM 交互；处理成功或抛错都算“已处理”，不再把原文字发给模型。
3. **手动压缩保护**：手动压缩的 `_compactionAbortController` 存在时直接报错，避免同时改上下文。
4. **input 扩展**：在技能/模板展开之前运行 `_runInputHandlers()`。扩展可以 `handled` 掉输入，也可以改写文字或图片。来源（interactive/rpc/...）和忙碌时的 `streamingBehavior` 会一起传入。
5. **技能与模板**：按顺序展开 `/skill:name` 和提示词模板，得到最终文字。
6. **忙碌排队**：`isStreaming` 为真时不再启动第二条运行：
   - 没有 `streamingBehavior` 直接报错；
   - `followUp` 进入追问队列，等当前任务自然结束；
   - 其他值按 `steer` 进入插话队列，在当前模型/工具回合结束后、下一次请求前投递。
   两条路径都只回报 `"queued"`，不等待模型回答。
7. **空闲校验**：没有模型时报 `formatNoModelSelectedMessage()`；没有配置认证时区分 OAuth 和 API key 给出不同错误。
8. **启动**：调用 `_startRun({messageType:"user", prompt: expandedText, images: currentImages}, () => preflightResult?.("started"))`。`preflightResult` 只是派发状态通知（`handled` / `queued` / `started`），不是回答内容。

为什么扩展命令在忙碌判断之前？因为它可能完全不请求模型；例如 `/status` 只读状态，即使当前正在生成也应该立即执行。

<a id="m03-walk-prepare"></a>
## 函数拆解二：`_prepareRun()` 组装起始消息

[_prepareRun:3297](../../../../../packages/coding-agent/src/core/agent-session.ts#L3297 "_prepareRun(trigger") 返回 `AgentMessage[]`，还没有发模型请求。它按顺序做这些事：

1. **发送前压缩检查**：从 Agent 工作副本里找最后一条 assistant（包括取消或失败的回复），调用 `_checkCompaction(lastAssistant, false)`。这里的 `false` 表示把取消的回复也纳入检查；压缩可能先写入检查点，但这里不会调用 `agent.continue()` 去续跑旧问题。
2. **`before_agent_start` 扩展**：扩展可以注入消息、修改系统提示选项、切换模型或工具。返回的 `systemPromptOptions` 是后续提示词和工具装载的基础。
3. **协调工具选择**：比较扩展处理前后的 `selectedTools`。只有扩展明确改了列表，才采用扩展的列表；否则以实时 `getActiveToolNames()` 为准。这样扩展在钩子里调用 `setActiveTools()` 不会被旧配置覆盖。
4. **构造起始消息**：
   - 自定义触发：直接放入 `trigger.message`；
   - 用户触发：在扩展选完模型后调用 `_normalizePromptImages(trigger.images)`，按最终模型的图片限制处理图片；图片处理提示会用空行追加到用户文字后面；消息内容为 `[text, ...images]`。
5. **消费 `nextTurn` 队列**：把 `_pendingNextTurnMessages` 追加到起始消息后面并清空，保证只注入一次。
6. **加入扩展上下文**：`before_agent_start` 返回的每条消息包装成 `role:"custom"`，保留 `customType`、`content`、`display`、`details` 和时间戳。`content` 缺失时归一化为 `[]`，因为这是扩展输入的信任边界。
7. **生成系统补丁**：`_preparePromptAndToolLoadout(result.systemPromptOptions)` 应用工具装载、同步隐藏声明，并把新章节与当前消息里重放出的旧章节做 diff。只有变化时才返回 `{role:"system", content:"", sections, timestamp}`。
8. **保存运行选项**：`_runSystemPromptOptions` 留给同一次运行后续的内部轮次使用。
9. **系统补丁放最前**：有补丁就 `unshift` 到消息批次头部，然后返回。

最终一次起始批次的形状通常是：

```text
[system 补丁(可选), user/custom 起始消息, ...nextTurn 消息, ...扩展上下文消息]
```

这里没有任何模型返回；真正的请求在 `_startRun()` 调用 `agent.prompt(messages)` 之后才发生。

<a id="m03-walk-start"></a>
## 函数拆解三：`_startRun()` 的生命周期

[_startRun:3205](../../../../../packages/coding-agent/src/core/agent-session.ts#L3205 "_startRun(trigger") 比低层 Agent 循环更外层，负责“一次 query”的完整生命周期。

1. **先标忙**：`_isAgentRunActive = true`，清空取消标记。必须早于 `_prepareRun()`，这样 `before_agent_start` 执行期间用户再输入时，`prompt()` 会走排队而不是启动第二条运行。
2. **准备消息**：`_prepareRun(trigger)`。如果准备失败，恢复空闲、冲刷暂存的 bash/custom 消息、唤醒 `waitForIdle()` 等待者，然后把错误继续抛出。
3. **准备成功后**：冲刷暂存消息；调用 `onStarted?.()`；清空上一轮的 `_failedResponse`；必要时 `_recordSelection()` 把模型选择写入分支；清空未注册的 `_pendingToolNames`。
4. **进入低层循环**：`await this.agent.prompt(messages)`。这一句内部可能请求模型多次（工具往返）。
5. **低层结束后协调续跑**：
   - `_handlePostAgentRun()` 返回 `true`：检查是否取消，然后 `agent.continue()`；
   - 返回 `false`：再执行 `_runBeforeSettleBoundary()`（`agent_before_settle` 扩展边界）；如果它要求继续，才 `agent.continue()`；
   - 每一轮都重新检查取消标记。
6. **`finally` 清理**：补齐取消的重试通知，清空 `_failedResponse` 和 `_runSystemPromptOptions`，冲刷暂存消息，最后 `await _emitAgentSettled()`。

`_handlePostAgentRun()` 的检查顺序很重要：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 已请求取消 | 结束，不再续跑 |
| 2 | 没有最后 assistant | 只有低层队列有消息时才继续 |
| 3 | 可重试错误且 `_prepareRetry()` 成功 | 保存失败回复供虚拟路由使用，返回继续 |
| 4 | 重试次数用尽但仍是 error | 发出最终 `auto_retry_end`，清计数 |
| 5 | `_checkCompaction()` 触发 overflow 恢复 | 压缩后决定是否继续 |
| 6 | 仍有排队消息 | 继续消费队列 |

`agent_end` 只表示低层这一轮结束；重试、压缩恢复、`agent_before_settle` 和 `agent_settled` 都在它之后。真正的“本次 query 结束”看 [_emitAgentSettled:1824](../../../../../packages/coding-agent/src/core/agent-session.ts#L1824 "private async _emitAgentSettled()")。

<a id="m03-walk-events"></a>
## 函数拆解四：`_handleAgentEvent()` 为什么先扩展、后持久化

[_handleAgentEvent:1872](../../../../../packages/coding-agent/src/core/agent-session.ts#L1872 "_handleAgentEvent = async") 处理低层 Agent 的每个事件。关键顺序如下：

1. **启动期间取消**：`agent_start` 到达时如果已经请求取消，调用 `agent.abort()`，让首个请求前就观察取消。
2. **嵌套工具用量**：如果工具通过 `ctx.executeTool()` 调用了其他工具，在父 `toolResult` 的 `message_start` 把嵌套调用和用量挂到结果消息上；`agent_end` 清理未消费记录。
3. **用户消息出队**：收到 `message_start` 且角色为 `user` 时，先从 steering 队列移除同文消息，再尝试 followUp 队列；移除后立即发 `_emitQueueUpdate()`，保证 UI 先看到队列变短，再看到消息事件。用 `contentText()` 把文字块拼成一个字符串后精确匹配；拼接结果为空（例如纯图片消息或空消息）时跳过这个查找，带文字的图片消息仍会匹配。
4. **扩展事件**：`await this._emitExtensionEvent(event)`。如果扩展在 `message_end` 修改或替换消息，`_replaceMessageInPlace()` 会保持消息对象身份，使 Agent 状态、事件和稍后的持久化看到同一份内容。
5. **公开事件**：`_emit()` 通知 UI/RPC。`agent_end` 会额外带 `willRetry` 预告，但它仍早于下面的 `appendMessage()`。
6. **持久化，仅 `message_end`**：
   - `custom` -> `appendCustomMessageEntry()`，保存为 `custom_message` 条目；
   - `system` / `user` / `assistant` / `toolResult` -> `appendMessage()`；
   - 记录 `message -> entryId` 的弱映射，供 `context_edit` 和边界草稿定位来源；
   - assistant 消息还更新 `_lastAssistantMessage`、重试计数和溢出恢复标记。
   - 其他角色（`bashExecution`、`compactionSummary`、`branchSummary`）由各自的专用路径保存，不在这里走普通消息条目。
7. **`turn_end` 冲刷**：assistant 和它要求的全部工具结果都已保存，此时才把等待安全边界的 custom 消息写入，避免夹在 toolCall 和 toolResult 之间。

为什么扩展必须在持久化之前？因为持久化保存的是事件里的 `event.message` 对象；扩展在 `message_end` 替换内容后，JSONL 应该记录替换后的结果，而不是旧草稿。反过来，公开监听器在 `appendMessage()` 之前收到事件，所以 UI 可能先渲染、磁盘随后写入；但事件派发是串行等待的，下一次请求前条目已经进入会话。

`message_update` 的逐字流不会各存一条；只有完整 `message_end` 才生成条目。

<a id="m03-walk-request-projection"></a>
## 函数拆解五：`_installAgentRequestProjection()` 每次请求都重投影

[_installAgentRequestProjection:1270](../../../../../packages/coding-agent/src/core/agent-session.ts#L1270 "private _installAgentRequestProjection(): void") 只安装一次，但它替换的 `agent.prepareRequest` 会在每次模型请求前执行。核心步骤：

1. 保存并调用之前的 `prepareRequest`，不覆盖宿主已有逻辑。
2. 取出一次性的 `_failedResponse`，供虚拟路由判断是否处于重试；取完立刻清空，避免下一次正常请求沿用失败状态。
3. 重新构建规范上下文：

```text
projection = sessionManager.buildSessionProjection()
canonicalContext = {
  ...request.context,
  messages: projection.messages,
  tools: agent.state.tools.slice()
}
```

4. 用 `canonicalContext`、当前模型和当前思考级别调用之前的回调；如果它返回新的 `context` / `model` / `thinkingLevel`，采用返回值。
5. 非虚拟模型直接返回。
6. 虚拟模型（如自动路由）需要额外处理：
   - 找最后一条 assistant，判断最后 assistant 之后是否还有真正的 `user` 消息；这决定路由原因是 `user` 还是 `continuation`，失败重试时为 `retry`；
   - 从当前分支读取该虚拟选择的路由状态；
   - `resolveModel()` 返回本次物理模型、思考级别和新状态；
   - 路由状态变化时追加 `VIRTUAL_MODEL_STATE_ENTRY` 的 custom 条目；它只保存路由状态，不贡献模型消息；
   - 用物理模型的 `contextWindow` 重新做阈值检查；超限就压缩，然后重新 `prepare()` 一次，但不再重做已确定的路由。

为什么不在启动时投影一次？因为运行期间会话可能被独立修改：

- 压缩刚写入新检查点；
- 扩展刚追加 `context_edit`；
- 另一个入口切换了分支；
- 工具装载或隐藏声明发生变化；
- 上一轮的工具结果刚保存，而 Agent 工作副本还未来得及更新。

投影成本是遍历当前分支和转换消息；它不读磁盘，也不调用模型。

<a id="m03-walk-next-turn"></a>
## 函数拆解六：`_installAgentNextTurnRefresh()` 的轮间刷新

[_installAgentNextTurnRefresh:1472](../../../../../packages/coding-agent/src/core/agent-session.ts#L1472 "private _installAgentNextTurnRefresh(): void") 包装 `prepareNextTurnWithContext`。这里的“轮间”指：**当前 assistant 回合的工具结果已经保存，下一次 assistant 请求之前**，不是两个用户问题之间。

每次回调做这些事：

1. `_compactBeforeNextAssistantResponse(turn.context)` 先刷新投影：
   - 构建 `buildSessionProjection()`；
   - 没有模型、虚拟模型或未超阈值时，只把 `messages` 替换成投影；
   - 超阈值时执行 `_runAutoCompaction("threshold", false)`，再重新投影；
   - 虚拟模型暂不在这里判断，因为真实物理模型要到 `prepareRequest` 路由后才知道。
2. 调用之前的 `prepareNextTurnWithContext`（或兼容旧 `prepareNextTurn`），保留已有行为。
3. 采用之前回调替换后的上下文；没有替换就用刚准备好的上下文。
4. 规范化下一轮提示词选项：本次运行的选项优先，否则用基础配置；`selectedTools` 取实时激活集合；基础与本次的 `toolSnippets`、`toolGuidelines` 合并。
5. `_preparePromptAndToolLoadout(options, nextContext.messages)` 与投影后的消息做章节 diff；只有变化才产生 system 补丁。
6. 返回新的上下文、工具实现副本、可选的 system 补丁、当前模型和思考级别。

工具可能在执行过程中注册或启用新工具，所以下一轮必须重新读取实时工具集合，并把声明变化通过 system 补丁告诉模型。这个回调和 `prepareRequest` 的分工是：前者在“回合边界”准备消息和提示词，后者在“每次实际请求”前保证历史和路由最新。

<a id="m03-walk-store"></a>
## 函数拆解七：`SessionManager` 的追加、路径与投影

### `appendMessage()`：先内存，再磁盘

[appendMessage:1936](../../../../../packages/coding-agent/src/core/session-manager.ts#L1936 "appendMessage(message: Message") 的输入是一条完整消息，返回新条目 id：

1. 生成 `id = generateId(this.byId)`：取随机 UUID 前 8 位，冲突时重试，极端情况下返回完整 UUID。
2. `parentId = this.leafId`，`timestamp` 用 ISO 字符串，`message` 原样保存。
3. `_appendEntry(entry)`：先把条目 push 到 `fileEntries`、写入 `byId`、把 `leafId` 指向新条目，再调用 `_persist()`。
4. 如果 `_persist()` 抛错，回滚：pop 最后一条、从 `byId` 删除、恢复旧 `leafId`，然后重新抛出。这样后续条目不会挂到一个没有成功写出的父节点上。

[_persist:1871](../../../../../packages/coding-agent/src/core/session-manager.ts#L1871 "_persist(entry: SessionEntry): void {") 的首次写出规则很关键：

```text
新会话：header + model_change + thinking_level_change 只在内存
追加 system：仍然没有 user/assistant，不建文件
追加第一条 user：_hasConversation() 为真，wx 打开文件，一次写出全部已记录行
后续追加：appendFileSync 只写当前一行
```

`wx` 表示只新建、不覆盖已存在文件。`flushed` 标记首次写出是否完成。这样只打开 pi 又退出不会留下空文件；首条用户消息一保存就会连同设置一起写出，因此即使这一轮模型请求失败或没有回复，用户请求也仍在文件中（#10000）。注意这只是写入时点，不是磁盘事务：`_persist()` 抛错时 `_appendEntry()` 会回滚内存追加，但已经创建的文件可能留下部分行。

### `buildSessionPath()`：只看父子链

[buildSessionPath:569](../../../../../packages/coding-agent/src/core/session-manager.ts#L569 "function buildSessionPath(") 的输入是全部条目、可选 `leafId` 和可选索引，输出根到叶的原始条目数组：

1. `leafId === null` 返回 `[]`，表示“根之前”。
2. 给了 id 就查 `byId`；查不到时回退到最后一条条目。
3. 从叶子沿 `parentId` 向上收集，直到根或缺失父节点。
4. `reverse()` 成正序返回。

它不应用压缩、不应用 `context_edit`、不复制条目对象。例如 `A -> B -> C` 和 `A -> D -> E` 两条分支，选 `C` 只返回 `[A,B,C]`，不会混入 `D/E`。

### `buildContextEntries()`：压缩感知的重放顺序

[buildContextEntries:705](../../../../../packages/coding-agent/src/core/session-manager.ts#L705 "export function buildContextEntries(") 在路径基础上做三件事：

1. 找路径上**最新**的 `compaction` 条目。
2. 没有压缩就返回整条路径。
3. 有压缩时返回：

```text
[最新 compaction] + [firstKeptEntryId 到 compaction 之前的旧条目] + [compaction 之后的条目]
```

扫描旧尾部时会跳过 `message` 角色的 `system`，因为压缩条目的 `systemMessage` 已经保存了边界处的完整系统状态。若 `firstKeptEntryId` 在路径中找不到，就不保留旧尾部；`firstKeptEntryId` 等于压缩条目自身时表示“不保留压缩之前的原文”。

这个函数返回的数组仍可能包含 `context_edit`、设置条目或旧压缩条目；它们要等下一步投影才决定是否贡献消息。

### `projectContextEntry()`：单条目到消息

[projectContextEntry:775](../../../../../packages/coding-agent/src/core/session-manager.ts#L775 "export function projectContextEntry(") 先调用 `sessionEntryToContextMessages(entry)`：

| 条目类型 | 初始贡献 |
| --- | --- |
| `message` | 一条原消息；旧文件缺 `content` 时在此补空值 |
| `custom_message` | 一条 `custom` 消息 |
| `branch_summary` | 摘要非空时一条 `branchSummary` |
| `compaction` | `systemMessage`（若有）+ 一条 `compactionSummary` |
| 其他 | `[]` |

然后应用该目标的最新编辑：

- 没有编辑：原样返回初始消息；
- `replacement === null`：返回 `[]`，隐藏该条目；
- 非空替换：只替换 `content`，保留角色、`toolCallId`、时间等字段；如果目标是 assistant/toolResult 且新内容是字符串，先包装成 `[{type:"text",text:"..."}]`。
- 只有 `user`、`assistant`、`toolResult`、`custom` 会被替换；system 和摘要不会被内容替换影响。

投影可能返回原消息对象（无编辑时），也可能返回浅复制（替换时）；它不是深拷贝。

### `buildSessionProjection()`：合成为最终视图

[buildSessionProjection:817](../../../../../packages/coding-agent/src/core/session-manager.ts#L817 "export function buildSessionProjection(") 的完整流程：

1. `buildSessionPath()` 得到当前路径。
2. `getSessionContextSettings()` 从路径重放 `thinking_level_change`、`model_change` 和 assistant 消息里的 `provider/model`，后面的记录覆盖前面的。
3. `buildContextEntries()` 得到压缩后的重放范围。
4. 遍历范围内所有 `context_edit`，按 `targetId` 保存**最后一条**编辑。
5. 逐个条目生成 `{sourceEntry, messages}`：
   - 下标 0 的压缩条目正常贡献检查点和摘要；
   - 保留区里更旧的压缩条目（下标 > 0）强制贡献 `[]`，避免重复摘要；
   - 其他条目应用步骤 4 的编辑。
6. `flatMap` 摊平所有 `messages`，返回 `{entries, messages, thinkingLevel, model}`。

[buildSessionContext:871](../../../../../packages/coding-agent/src/core/session-manager.ts#L871 "export function buildSessionContext(") 只是去掉 `entries` 来源映射，返回 `{messages, thinkingLevel, model}`。

### 分支操作：移动游标与抽取路径

- [branch:2554](../../../../../packages/coding-agent/src/core/session-manager.ts#L2554 "branch(branchFromId: string): void {") 只做一件事：检查目标存在，然后把 `leafId` 指向它。它不写 JSONL，不删除旧分支；下一次 `appendMessage()` 会把新条目挂在目标后面。
- `resetLeaf()` 把 `leafId` 设为 `null`，下一次追加形成新根。
- [branchWithSummary:2584](../../../../../packages/coding-agent/src/core/session-manager.ts#L2584 "branchWithSummary(") 先记住旧叶子为 `fromId`，把 `leafId` 移到目标，然后追加 `branch_summary`。摘要条目的 `parentId` 是目标路径，`fromId` 才是离开的位置；它不会立即请求模型生成摘要。
- [createBranchedSession:2640](../../../../../packages/coding-agent/src/core/session-manager.ts#L2640 "createBranchedSession(leafId: string") 把一条 root-to-leaf 路径抽成新文件：跳过 label 条目并重连父链，修正压缩的 `firstKeptEntryId`，生成新的会话头和新文件，保留被抽取条目的 id。原文件不变。

<a id="m03-multiturn"></a>
## 多轮如何复用历史

| 问题 | 答案 |
| --- | --- |
| 第二轮会重新读 JSONL 吗 | 不会。`SessionManager` 在内存中维护条目树，磁盘只追加 |
| 第一轮的工具结果还会发送吗 | 会，除非被压缩或 `context_edit` 隐藏 |
| 每轮都会重建系统提示吗 | 以 system 消息增量保存；读取时重放，选项或工具变化时只发 diff 补丁 |
| 模型选择跨轮保留吗 | 会，作为 `model_change` 条目保存在当前分支；assistant 消息的 provider/model 也参与恢复 |
| 思考级别跨轮保留吗 | 会，作为 `thinking_level_change` 条目 |
| 压缩后还能看到旧消息吗 | 模型看不到；JSONL 和导出仍保留 |
| 忙碌时输入会新开一轮吗 | 不会；`steer` / `followUp` 进入内存队列，等低层循环投递后才会成为新的 user 条目 |
| 第二轮开始时 `Agent.messages` 是什么 | 每次请求前由 `buildSessionProjection()` 刷新；通常是压缩后的投影，不是原始文件 |

一次空闲的第二轮通常只追加一条 user 条目（以及模型随后产生的 assistant）。它不会重发旧的 user 问题，也不会重新创建压缩摘要；这些状态已经在当前分支上。

<a id="m03-compaction"></a>
## 压缩

### 何时触发

| 触发点 | 调用 | 场景 |
| --- | --- | --- |
| 新 prompt 之前 | `_prepareRun()` -> `_checkCompaction(lastAssistant, false)` | 上次取消或失败，但上下文已经很大 |
| 工具结果之后、下一次 assistant 请求前 | `_compactBeforeNextAssistantResponse()` | 大工具结果把上下文推过阈值 |
| 低层运行结束后 | `_handlePostAgentRun()` -> `_checkCompaction(message)` | 本次回答完成或溢出，需要整理/恢复 |
| 手动压缩 | `AgentSession.compact()` | 用户显式要求，不走自动触发 |

[shouldCompact:387](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L387 "export function shouldCompact(") 的阈值公式是：

```text
contextTokens > contextWindow - reserveTokens
```

严格大于才触发。例如窗口 100、预留 20，81 触发，80 不触发。

### 三种原因

[_checkCompaction:5137](../../../../../packages/coding-agent/src/core/agent-session.ts#L5137 "_checkCompaction(assistantMessage") 先过滤禁用、取消、与当前模型不匹配、以及早于最新压缩边界的旧回复，然后区分：

1. **显式上下文溢出**：`stopReason === "error"` 且错误信息表明超出上下文。
2. **可恢复的长度截断**：输出因长度停止，但还没达到模型原本的 `maxTokens`；压缩后可以重试。
3. **阈值压缩**：正常完成，但用量超过窗口减预留量；只整理上下文，不重试已完成的回答。

溢出恢复有次数限制。恢复前会调用 `_omitRecoveryAttempt()`，把失败 assistant 和它配对的 toolResult 用 `replacement:null` 的 `context_edit` 成组隐去，避免重试时留下孤立工具调用；`_refreshFinalizedContext()` 立刻让 Agent 工作副本同步。

### 准备与执行是分开的

[prepareCompaction:1277](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L1277 "export function prepareCompaction(") 是纯准备：

- 如果分支最后一条已经是 `compaction`，直接返回 `undefined`，避免连续压同一个检查点；
- 从 `buildSessionProjection()` 取模型可见消息，继承上一条有效压缩的摘要；
- 用 `estimateProjectedContextTokens()` 估算当前大小，并避免采用被后续编辑/压缩淘汰的旧 usage；
- `findProjectedCutPoint()` 按 `keepRecentTokens` 选择保留起点，尊重隐藏编辑和工具调用配对；
- 可能把当前轮切成两半：前半段进入 `turnPrefixMessages` 单独摘要，后半段原文保留；
- 返回 `{firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings}`，不发模型请求。

[compact:1417](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L1417 "export async function compact(") 执行这个计划：通常调用一次摘要模型，切半轮时可能分别生成历史摘要和轮前缀摘要，最后返回 `CompactionResult`。它**不修改 SessionManager**，也不删除 JSONL；只有上层校验成功后，才追加压缩条目。

### 写入检查点

[_runAutoCompaction:5375](../../../../../packages/coding-agent/src/core/agent-session.ts#L5375 "_runAutoCompaction(reason") 的职责：

1. 取当前分支，调用 `prepareCompaction()`；没有可压内容就返回 `false`。
2. 发出 `compaction_start`，给扩展 `session_before_compact` 机会取消或提供自定义摘要。
3. 没有扩展结果时调用内置 `compact()` 生成摘要。
4. `appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage)`。
5. `_refreshFinalizedContext()` 让 Agent 工作副本立即看到新投影。
6. 发出 `compaction_end`，并把摘要用量/错误通知给 UI 和扩展。

`appendCompaction()` 会调用 `getCurrentSystemMessage(this.buildSessionProjection().messages)`，把边界处的完整系统提示和工具状态折叠进 `systemMessage`，这样压缩后不必靠自然语言摘要重建系统规则。

压缩失败时不会写入半成品摘要条目；自动路径捕获错误并返回 `false`，由调用方决定是否继续处理队列或结束。

<a id="m03-compaction-order"></a>
## 压缩后的消息顺序

假设当前路径是：

```text
a1 system
└─ a2 user
   └─ a3 assistant(toolCall)
      └─ a4 toolResult
         └─ a5 assistant
            └─ a6 user
               └─ a7 assistant
                  └─ c1 compaction(firstKeptEntryId=a5, systemMessage=...)
                     └─ a8 user
                        └─ a9 assistant
```

`buildContextEntries()` 的结果是：

```text
[c1, a5, a6, a7, a8, a9]
```

`buildSessionProjection()` 按这个顺序生成消息：

| 重放条目 | 投影消息 | 来源 |
| --- | --- | --- |
| `c1` | 一条 system 检查点 | `c1.systemMessage` |
| `c1` | 一条 `compactionSummary` | `c1.summary` |
| `a5` | 一条 assistant | 保留的近期原文 |
| `a6` | 一条 user | 保留的近期原文 |
| `a7` | 一条 assistant | 保留的近期原文 |
| `a8` | 一条 user | 压缩之后的新条目 |
| `a9` | 一条 assistant | 压缩之后的新条目 |

最终发送前，`convertToLlm()` 会把 `compactionSummary` 转成带“之前对话已压缩”说明的 user 消息；系统检查点仍是 system。因此模型看到的形状大致是：

```text
system(当前完整提示词 + 工具)
user(压缩摘要)
assistant(a5)
user(a6)
assistant(a7)
user(a8)
assistant(a9)
```

### 为什么旧系统消息不会重复

三层机制共同保证这一点：

1. `a1` 在 `firstKeptEntryId=a5` 之前，属于被摘要替代的前缀，根本不在重放范围。
2. 即使保留区间里存在旧的 system 消息，`buildContextEntries()` 也会跳过它们；系统状态统一由 `c1.systemMessage` 提供。
3. `c1` 之后新追加的 system 补丁不受这个跳过规则影响，仍会正常重放；支持中途 system 消息的协议逐条渲染这些补丁，折叠路径才由 `collapseSystemMessages()` 把它们合并进首条 system 消息。

所以“最新检查点的完整系统状态 + 检查点之后的系统增量”就是当前系统提示，不会把压缩前的旧规则再发一遍。

### 几个边界

- **保留区里的旧压缩条目**：如果 `firstKeptEntryId` 落在更早的压缩条目之后，`buildContextEntries()` 可能把它带进范围；`buildSessionProjection()` 对下标大于 0 的压缩条目强制贡献 `[]`，避免重复摘要。
- **`firstKeptEntryId` 等于压缩条目自身**：表示不保留压缩前原文。投影只有检查点和摘要，然后接压缩之后的新条目。
- **切半轮**：`prepareCompaction()` 可能保留从 assistant 开始的后半轮，而把同一轮前面的 user 请求放进 `turnPrefixMessages` 摘要；这样保留区间从 assistant 开始，工具调用/结果配对仍然完整。
- **原始历史不变**：`c1` 是追加的；`a2`、`a3`、`a4` 等旧行仍在 JSONL 和导出里，只是不再是模型投影的一部分。

<a id="m03-system"></a>
## 系统提示

系统提示不是一条固定字符串，而是由多条 system 消息重放出来的状态。典型组成：

- 基础行为规则；
- 当前工具声明（名称、描述、参数 schema）；
- 项目上下文（如 `AGENTS.md`）；
- 扩展注入的规则；
- 当前模式/环境信息。

### 重放：`getCurrentSystemMessage()`

[getCurrentSystemMessage:108](../../../../../packages/ai/src/utils/transcript.ts#L108 "export function getCurrentSystemMessage(") 按因果顺序遍历所有 system 消息：

- 非空 `content` 依次追加，用空行连接；
- `sections` 按名字覆盖；值为 `null` 表示删除该章节；
- `toolsAdded` / `toolsRemoved` 由 `getCurrentTools()` 解析成当前工具集合；
- 时间戳取第一条 system 的时间。

它用于“以会话消息为准”的读取：`_preparePromptAndToolLoadout()` 用它得到旧章节做 diff，压缩检查点用它折叠完整系统状态，强制提示词投影用它取最终工具声明。它和 [get systemPrompt:2538](../../../../../packages/coding-agent/src/core/agent-session.ts#L2538 "get systemPrompt()") 不是同一条路径：后者用当前运行或基础提示词选项调用 `buildSystemPrompt()` 渲染字符串，包含尚未发送给模型的改动；需要知道“历史里实际声明了什么”时用前者。

### 增量：`_preparePromptAndToolLoadout()`

[_preparePromptAndToolLoadout:3018](../../../../../packages/coding-agent/src/core/agent-session.ts#L3018 "private _preparePromptAndToolLoadout(") 不会每轮重写整段提示词。它：

1. 应用工具装载和 `prepareLoadout` 钩子，更新实际可激活工具；
2. 同步隐藏声明集合；
3. 用 `diffSystemPromptSections()` 比较“从现有消息重放出的旧章节”和“新选项生成的章节”；
4. 只有差异才返回 `{role:"system", content:"", sections, timestamp}`；没有差异返回 `undefined`。

补丁可能包含新增章节、修改章节和 `null`（删除章节）。空 `content` 不是因为系统提示为空，而是因为正文由 `sections` 增量表达。

### 工具声明如何进入 system

低层循环的 `declareToolChanges()`（M02）会比较“历史已声明的工具”和“当前可执行工具”，把 `toolsAdded` / `toolsRemoved` 合并进本次批次里最后一条 system，或者在没有 system 时插入一条。这样工具声明和工具实现不会脱节。

[_rebuildSystemPrompt:2956](../../../../../packages/coding-agent/src/core/agent-session.ts#L2956 "_rebuildSystemPrompt(toolNames") 负责在工具或扩展变化后重建基础提示词；它产生的新章节最终仍以上述补丁形式进入会话。

### 强提示与隐藏声明

- `before_agent_start` 如果返回完整 `systemPrompt` 文本，pi 通过请求级投影把这段文本放在首条 system，会话树仍保存结构化章节，避免历史里出现两份互相矛盾的提示词。
- `prepareLoadout` 隐藏的工具声明会在每次请求的 `transformContext` 中过滤，不修改持久化条目；这样本地仍可调用，模型却看不到声明。

### 压缩时保存完整状态

`appendCompaction()` 用 `getCurrentSystemMessage()` 把当前所有 system 消息折叠成一条 `systemMessage` 存进压缩条目。压缩后的旧系统消息被跳过，新系统补丁仍按正常路径追加；这就是“旧规则不重复、新规则仍生效”的原因。

<a id="m03-context-edit"></a>
## `context_edit`：不改原始历史，只改模型视图

### 记录形状

`context_edit` 是一条独立条目：

```json
{
  "type": "context_edit",
  "id": "a5",
  "parentId": "a4",
  "timestamp": "...",
  "targetId": "a4",
  "replacement": {
    "content": [{ "type": "text", "text": "短说明" }]
  }
}
```

`replacement` 只有两种合法形态：

- `null`：隐藏目标；
- 含 `content` 的对象：`content` 可以是字符串或内容块数组。

[appendContextEdit:2211](../../../../../packages/coding-agent/src/core/session-manager.ts#L2211 "appendContextEdit(targetId: string") 在写入前检查：目标存在、目标在当前分支上、目标是 `user`/`assistant`/`toolResult` 或 `custom_message`。assistant/toolResult 的字符串替换会被规范化成单个 text 块。它不自动检查工具调用/结果配对，调用者要保证整体上下文合法。

### 投影规则

- 同一目标在当前重放范围内有多条编辑时，最后一条生效。
- 编辑本身贡献 `[]`，但会推进 leaf；后续消息的 `parentId` 指向编辑条目。
- 没有编辑的消息复用原对象；有替换时浅复制并覆盖 `content`，角色、`toolCallId`、时间等保留。
- 目标被 `null` 隐藏后，原始条目仍在 JSONL 和树中，导出仍能看到。

### 与压缩的区别

| 操作 | 作用范围 | 结果 |
| --- | --- | --- |
| `context_edit` | 单条目标消息 | 替换该消息内容或隐藏它 |
| `compaction` | 一段旧历史 | 用摘要 + 保留尾部替代，并移动重放边界 |

`context_edit` 适合“这条工具结果太大，但我不想丢审计记录”；`compaction` 适合“早期很多轮已经完成，只需要摘要”。

### 工具配对风险

只隐藏 toolResult 会留下一个没有结果的 toolCall，供应商可能拒绝请求。需要隐藏失败尝试时，`_omitRecoveryAttempt()` 会：

1. 从失败 assistant 中收集所有 `toolCall.id`；
2. 在它之后、下一条 assistant 之前找配对的 toolResult；
3. 对 assistant 和所有配对结果分别追加 `replacement:null` 的编辑；
4. 调用 `_refreshFinalizedContext()` 立即刷新 Agent 工作副本。

如果某个仍在投影中的目标找不到来源条目，它会抛错而不是部分提交，避免悄悄拆散调用/结果。

<a id="m03-selfcheck"></a>
## 自测

先自己回答，再对照下面的答案。答案只给结论和源码位置，推理过程在本篇对应章节。

### 1. 为什么不能把 `Agent.messages` 当会话文件？

`Agent.messages` 是低层循环此刻的工作副本：流式生成时是草稿，工具执行后才补结果，重试和压缩还会替换或隐藏消息。它不保存旧分支、被编辑前的原文和压缩边界。JSONL 条目树保存“实际写入过什么”，当前分支由 `leafId` 沿 `parentId` 回溯，模型投影由 `buildSessionProjection()` 从内存树计算，工作副本每次请求前被投影覆盖。见 [大白话总览](#m03-plain) 和 [原始文件 vs 模型视图](#m03-store)。

### 2. `appendMessage()` 如何分配 id、parentId，什么时候第一次写文件？

[appendMessage:1936](../../../../../packages/coding-agent/src/core/session-manager.ts#L1936 "appendMessage(message: Message") 用 `generateId(this.byId)` 生成短 id，把 `parentId` 设为当前 `leafId`，然后交给 `_appendEntry()` 更新内存并持久化。[_persist:1871](../../../../../packages/coding-agent/src/core/session-manager.ts#L1871 "_persist(entry: SessionEntry): void {") 只在 [_hasConversation:1861](../../../../../packages/coding-agent/src/core/session-manager.ts#L1861 "private _hasConversation(): boolean {") 为真时首次创建文件；设置条目单独存在时留在内存，首条 user 或 assistant 消息到来才一次写出 header、设置和这条消息。见 [函数拆解七](#m03-walk-store)。

### 3. `branch()` 为什么让文件里同时有旧分支和新分支？恢复时 leaf 怎么定？

[branch:2554](../../../../../packages/coding-agent/src/core/session-manager.ts#L2554 "branch(branchFromId: string): void {") 只把内存游标 `leafId` 指向旧节点，不删除任何条目，也不立即写文件；下一次追加的新条目把 `parentId` 指回该节点，于是文件中同时保留旧分支和新分支。恢复会话时 [_buildIndex:1758](../../../../../packages/coding-agent/src/core/session-manager.ts#L1758 "private _buildIndex(): void {") 顺序扫描文件，把最后一条条目设为叶子，而不是恢复之前内存里的分支位置。见 [内存树不是文件顺序](#m03-store)。

### 4. `buildContextEntries()` 如何选择重放范围？`firstKeptEntryId` 特殊值呢？

[buildContextEntries:705](../../../../../packages/coding-agent/src/core/session-manager.ts#L705 "export function buildContextEntries(") 先在当前路径上找最新 `compaction`：没有就返回整条路径；有就返回“最新压缩条目 + 从 `firstKeptEntryId` 到压缩前的旧尾巴 + 压缩之后的条目”，并跳过保留区里的旧 system 消息。`firstKeptEntryId` 在路径中找不到时不保留旧尾部；等于压缩条目自身时也不保留压缩前原文。见 [压缩后的消息顺序](#m03-compaction-order)。

### 5. `context_edit` 如何只改模型视图？多条编辑哪条生效？

[appendContextEdit:2211](../../../../../packages/coding-agent/src/core/session-manager.ts#L2211 "appendContextEdit(targetId: string") 追加一条带 `targetId` 和 `replacement` 的独立条目，不覆盖目标条目。投影时 [projectContextEntry:775](../../../../../packages/coding-agent/src/core/session-manager.ts#L775 "export function projectContextEntry(") 对目标应用编辑：`null` 返回空数组（隐藏），非空只替换 `content`，保留角色、`toolCallId` 等字段。同一目标有多条编辑时，`buildSessionProjection()` 的 `Map.set` 后写覆盖前写，最后一条生效。见 [`context_edit`](#m03-context-edit)。

### 6. 压缩检查点为什么保存 `systemMessage`？旧 system 为什么不会重复？

[appendCompaction:2039](../../../../../packages/coding-agent/src/core/session-manager.ts#L2039 "appendCompaction<T = unknown>(") 在写入检查点前调用 [getCurrentSystemMessage:108](../../../../../packages/ai/src/utils/transcript.ts#L108 "export function getCurrentSystemMessage(")，把当前所有 system 消息折叠成一份完整系统状态（若有）存进 `systemMessage`。压缩后 `buildContextEntries()` 跳过保留区里的旧 system，投影用检查点提供完整状态；压缩之后新追加的 system 补丁仍会正常重放。三层机制见 [为什么旧系统消息不会重复](#m03-compaction-order)。

### 7. `_handleAgentEvent()` 的顺序为什么是扩展、公开事件、持久化？

[_handleAgentEvent:1872](../../../../../packages/coding-agent/src/core/agent-session.ts#L1872 "_handleAgentEvent = async") 先 `await _emitExtensionEvent()`，因为扩展在 `message_end` 可以替换 `event.message`，持久化必须保存替换后的内容；然后 `_emit()` 通知 UI/RPC，此时条目还没落盘；最后只在 `message_end` 持久化。`custom` 走 `appendCustomMessageEntry()`，`system`/`user`/`assistant`/`toolResult` 走 `appendMessage()`；`bashExecution`、`compactionSummary`、`branchSummary` 由各自的专用路径保存。见 [函数拆解四](#m03-walk-events)。

### 8. `agent_end`、`agent_before_settle`、`agent_settled` 有什么区别？

`agent_end` 只表示低层循环这一轮结束。之后 `_handlePostAgentRun()` 还可能重试可重试错误、执行压缩恢复或消费队列；再经过 `_runBeforeSettleBoundary()` 的 `agent_before_settle` 扩展边界；最后 `_emitAgentSettled()` 发出 `agent_settled`，才是本次 query 的真正结束。测试 [agent-session-retry-events.test.ts:269](../../../../../packages/coding-agent/test/suite/agent-session-retry-events.test.ts#L269 "emits the expected event order for a single prompt") 断言了单轮事件顺序以 `agent_end`、`agent_settled` 收尾。见 [函数拆解三](#m03-walk-start)。

<a id="m03-exercises"></a>
## 练习

练习都用内存会话或纯函数单元测试，不需要真实 API key，也不产生付费调用。改完记得还原临时改动。命令都从 `packages/coding-agent` 目录运行。

1. **查看条目树**。打开 [tree-traversal.test.ts:10](../../../../../packages/coding-agent/test/session-manager/tree-traversal.test.ts#L10 "appendMessage creates entry with correct parentId chain")，在断言前临时打印 `session.getEntries()`，然后追加 `session.branch(id1)` 和一条新消息，观察新条目的 `parentId` 指回 `id1`，而旧分支条目仍在数组中。运行：
   ```bash
   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/session-manager/tree-traversal.test.ts -t "appendMessage creates entry with correct parentId chain"
   ```
   预期：`getEntries()` 同时包含两条分支，`getBranch()` 只返回当前 `leafId` 的路径。对照 [内存树不是文件顺序](#m03-store)。

2. **对比原始历史与投影**。打开 [session-context-edit.test.ts:37](../../../../../packages/coding-agent/test/session-context-edit.test.ts#L37 "omits a target only from model projection")，在两次 `appendContextEdit` 之后打印 `session.getBranch()` 和 `session.buildSessionProjection().messages`。运行：
   ```bash
   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/session-context-edit.test.ts -t "omits a target only from model projection"
   ```
   预期：原始分支仍有 user、assistant、toolResult 三条消息，投影只剩 user；`session.getEntry(resultId).message` 仍是原始工具结果对象。对照 [`context_edit`](#m03-context-edit)。

3. **做一次 `context_edit`**。打开 [session-context-edit.test.ts:59](../../../../../packages/coding-agent/test/session-context-edit.test.ts#L59 "replaces only content and lets the latest edit win")，先注释掉最后一条 `appendContextEdit`，观察投影变成隐藏；再恢复它，确认最后一条替换生效。运行：
   ```bash
   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/session-context-edit.test.ts -t "replaces only content and lets the latest edit win"
   ```
   预期：同一目标的三条编辑按追加顺序保存，投影只采用最后一条；目标 assistant 的原始文本始终是 `"original"`，`usage` 等元数据也保留。

4. **压缩一次**。打开 [build-context.test.ts:127](../../../../../packages/coding-agent/test/session-manager/build-context.test.ts#L127 "includes summary before kept messages")，把 `compaction("5", "4", ..., "3")` 的 `firstKeptEntryId` 依次改成 `"5"`（压缩条目自身）、`"1"` 和不存在的 `"missing"`，同步调整断言或改成打印 `buildContextEntries(entries).map((entry) => entry.id)` 与 `buildSessionContext(entries).messages`。运行：
   ```bash
   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/session-manager/build-context.test.ts -t "includes summary before kept messages"
   ```
   预期：`"5"` 时不保留压缩前原文；`"1"` 时从第一条开始保留；`"missing"` 时不保留旧尾部。对照 [压缩后的消息顺序](#m03-compaction-order)。

<a id="m03-misread"></a>
## 常见误解

- **“JSONL 是聊天记录数组”**：它是条目树，`parentId` 决定分支；直接按文件顺序读会忽略分支和压缩。
- **“文件最后一行就是当前对话结尾”**：运行中 `leafId` 是内存游标；`branch()` 移动它但不写文件。恢复会话时才会把最后一条文件条目设为叶子。
- **“压缩会删除旧消息”**：不会。只追加检查点，原始条目保留；模型投影跳过它们。
- **“上下文就是 Agent 里的 messages”**：Agent 里是工作副本；每次请求由 `buildSessionProjection()` 刷新。
- **“多轮会重新读文件”**：不会。内存树是权威，磁盘只追加。
- **“系统提示只生成一次”**：工具、扩展、模型变化时会重建或产生章节补丁；读取时还要重放所有 system 消息。
- **“`agent_end` 后会话就结束了”**：还要经过重试、压缩恢复和 `agent_before_settle`，最后才是 `agent_settled`。
- **“`context_edit` 会改写旧 JSONL 行”**：不会。它追加一条编辑条目，投影时应用。
- **“隐藏 toolResult 一定安全”**：不一定；只隐藏结果可能留下孤立 toolCall，需要和调用一起隐藏。
- **“`firstKeptEntryId` 会删掉前面的历史”**：它只决定压缩后从哪里开始保留原文；原始条目仍在。
- **“entry id、toolCall id、session id 是一回事”**：它们分别是树节点、模型工具协议和整份文件的标识。
- **“压缩摘要是一条 assistant 消息”**：它是 `compaction` 条目；投影先生成 `compactionSummary`，再由 `convertToLlm()` 转成 user 消息。

<a id="m03-next"></a>
## 继续阅读

- 本模块的函数细节：[prompt 到 startRun](#m03-walk-prompt)、[prepareRun](#m03-walk-prepare)、[事件处理](#m03-walk-events)、[请求投影](#m03-walk-request-projection)、[SessionManager 投影](#m03-walk-store)。
- 循环如何消费投影后的上下文：[M02 Agent 循环](../02-agent-loop/README.md)，重点看 [runLoop](../02-agent-loop/README.md#m02-walk-loop)、[事件序列](../02-agent-loop/README.md#m02-events)、[数据变化](../02-agent-loop/README.md#m02-data)。
- 摘要请求如何访问模型：[M04 模型访问](../04-model-access/README.md)。
- 会话如何被创建和恢复：[M01 入口与装配](../01-entry-and-config/README.md)。
- 回到全链路：[S5 会话入口](../00-full-chain/README.md#m00-s5)、[S6 运行准备](../00-full-chain/README.md#m00-s6)、[S11 工具往返](../00-full-chain/README.md#m00-s11)、[S12 持久化](../00-full-chain/README.md#m00-s12)、[多轮](../00-full-chain/README.md#m00-multiturn)、[压缩](../00-full-chain/README.md#m00-compaction)。
