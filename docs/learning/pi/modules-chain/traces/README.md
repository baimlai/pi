# 贯穿追踪：消息、工具、上下文、事件的一生

[00 全链路](../00-full-chain/README.md)按时间顺序走一次 query；这一页换一个视角：不按文件，而按四个对象从生到死的轨迹，把入口、Agent 循环、会话、模型访问、模式五个模块重新串起来。

四个对象分别是：

| 追踪 | 对象 | 起点 | 终点 | 核心问题 |
| --- | --- | --- | --- | --- |
| [T1](#trace-message) | 一条用户消息 | shell 里的 argv 字符串 | 下一轮模型请求里的 `Message` | 同一句话在每一层到底长什么样 |
| [T2](#trace-tool) | 一次工具调用 | 模型流里的 `toolCall` 内容块 | 下一轮请求里的 `toolResult` 消息 | `toolCallId` 如何把请求和结果配成对，失败又如何回到模型 |
| [T3](#trace-context) | 一份上下文 | JSONL 里的一行行记录 | 供应商收到的协议消息 | 磁盘历史、当前分支、模型可见投影、线上消息为什么不是一回事 |
| [T4](#trace-event) | 一个事件 | Agent 循环里的 `emit()` | 打印、JSON、TUI 或 RPC 的输出 | 哪些事件只是通知，哪些会落盘，什么时候才算真正空闲 |

统一用这条输入做例子：

```bash
pi -p "读取 README.md 前 20 行并总结"
```

每条追踪都按同一结构展开：一句话结论、时间线、每阶段的数据形状、源码入口、常见断点和观察方法、对应模块文档。读完后，应该能拿到四个可复用的判断：

1. 看到一段“用户输入”时，先问它在哪一层、是字符串还是消息对象。
2. 看到工具调用时，先找 `toolCallId`，再判断失败是循环异常还是工具结果。
3. 看到上下文不对时，先区分磁盘、分支、投影、线上四层，不要直接改 `Agent.messages`。
4. 看到事件时，先分清 `message_end`、`agent_end`、`agent_settled` 各证明了什么。

<a id="trace-message"></a>
## T1 一条用户消息的一生

**一句话**：用户输入不是“一句话”从头传到尾，而是在每一层被重新表示：argv 字符串、`Args.messages`、`initialMessage`、展开后的文本、`AgentMessage`、`Message[]`、`TranscriptContext`，最后才变成供应商协议里的消息。任何一层都不能和另一层混为一谈。

### 时间线

| 阶段 | 入口 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1. 进程拿到 argv | `cli.ts` | shell 参数 | `process.argv.slice(2)` |
| 2. 解析参数 | `parseArgs` | 字符串数组 | `Args.messages: string[]` 和其他开关 |
| 3. 合成初始消息 | `prepareInitialMessage` / `buildInitialMessage` | 位置参数、stdin、`@file` 文本 | `initialMessage: string \| undefined`、`initialImages` |
| 4. 模式提交 | print / interactive / rpc | `initialMessage` 或后续输入 | 调用 `session.prompt()` |
| 5. 会话预处理 | `AgentSession.prompt` | 原始文本、图片、选项 | `expandedText`，或进入 steer/followUp 队列 |
| 6. 准备运行 | `_prepareRun` | 展开后的文本、图片、扩展注入 | `AgentMessage[]` 起始批次 |
| 7. 进入 Agent | `Agent.prompt` / `runAgentLoop` | 新消息数组 | 消息事件、模型请求 |
| 8. 转成供应商消息 | `prepareRequest` / `transformContext` / `convertToLlm` / `normalizeContext` | 当前会话投影 | `TranscriptContext` |
| 9. 模型回复 | `streamAssistantResponse` | `TranscriptContext` | 流式 assistant 草稿，最终 `AssistantMessage` |
| 10. 落盘 | `message_end` 的会话处理 | 完整消息 | JSONL 里的 `SessionMessageEntry` |
| 11. 下一轮再投影 | `buildSessionProjection` | 当前分支的条目 | 下一次请求的消息数组 |

### 每阶段的数据形状

#### 1. 字符串进入 CLI

`cli.ts` 只做一件事：把 Node 的 argv 去掉前两项，交给 `main`。

```ts
main(process.argv.slice(2));
```

对例子来说，进入参数解析器的大致是：

```text
["-p", "读取 README.md 前 20 行并总结"]
```

`-p` 是打印模式开关，最后那个位置参数被解析进 `Args.messages`。这一步的产物仍然是字符串数组，不是任何“消息对象”。

源码入口：

- [cli.ts:13](../../../../../packages/coding-agent/src/cli.ts#L13 "main(process.argv.slice(2));")
- [args.ts:137](../../../../../packages/coding-agent/src/cli/args.ts#L137 "export function parseArgs(args: string[]): Args {")
- [args.ts:98](../../../../../packages/coding-agent/src/cli/args.ts#L98 "messages: string[];")

#### 2. 字符串合成 initialMessage

`main()` 先读 stdin，再把 `stdinContent` 传给 `prepareInitialMessage`；后者只处理 `@file` 并调用 `buildInitialMessage`。`buildInitialMessage` 的顺序是：

1. 有 stdin 内容，先放进去。
2. 有 `@file` 展开出的文本，再放进去。
3. 有第一个位置参数，再放进去，并把这个元素从 `parsed.messages` 中 `shift()` 掉。

```ts
initialMessage: parts.length > 0 ? parts.join("") : undefined
```

这里有几个容易读错的点：

- `initialMessage` 仍然是一个字符串，不是 `AgentMessage`。
- 各部分用空字符串拼接，没有自动加空格或换行；stdin、文件文本和用户问题会直接相连。
- `initialImages` 和文本分开返回；图片不是字符串的一部分。
- 第一个位置参数已经被消费掉，后面的 `parsed.messages` 只剩余附加消息，供打印/交互模式继续串行提交。

源码入口：

- [main.ts:379](../../../../../packages/coding-agent/src/main.ts#L379 "async function prepareInitialMessage(")
- [main.ts:1577](../../../../../packages/coding-agent/src/main.ts#L1577 "const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);")
- [initial-message.ts:37](../../../../../packages/coding-agent/src/cli/initial-message.ts#L37 "export function buildInitialMessage({")

#### 3. 模式把字符串交给会话

三种模式拿到的是同一个 `initialMessage`，但提交方式不同：

- 打印模式：[print-mode.ts:199](../../../../../packages/coding-agent/src/modes/print-mode.ts#L199 "await session.prompt(initialMessage") 提交首句；后续 `parsed.messages` 用 [print-mode.ts:204](../../../../../packages/coding-agent/src/modes/print-mode.ts#L204 "await session.prompt(message);") 串行提交。
- 交互模式：[interactive-mode.ts:2180](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2180 "await this.session.prompt(initialMessage") 提交首句；附加消息逐条提交；主循环在 [interactive-mode.ts:2216](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2216 "await this.session.prompt(userInput);") 等用户输入。
- RPC 模式：[rpc-mode.ts:638](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L638 ".prompt(command.message, {") 从 stdin JSON 命令里取 `command.message`，并带上 `images`、`streamingBehavior`、`source: "rpc"` 等选项。

注意，模式层不负责把字符串变成 `AgentMessage`。它只决定“何时、带哪些选项提交”。真正的对象构造在 `AgentSession._prepareRun`。

#### 4. AgentSession.prompt：先展开，再决定运行还是排队

`AgentSession.prompt` 是用户文本进入会话后的第一道总闸。它按顺序做这些判断：

1. 如果当前正在派发 `agent_settled`，把这次调用延迟到 settled 通知结束后，避免收尾回调里重入。
2. 默认 `expandPromptTemplates = true`；如果文本以 `/` 开头，先尝试扩展命令。命令处理成功就 `return`，这次文本不会变成普通用户消息。
3. 如果手动压缩正在进行，拒绝新 prompt，避免同时改同一份上下文。
4. 交给输入钩子 `_runInputHandlers`；钩子可以替换文本和图片。
5. 展开技能命令、提示词模板。
6. 如果会话正在流式处理：
   - 没有 `streamingBehavior` 就抛出 “Agent is already processing...”；
   - `followUp` 进入追问队列，等当前任务自然结束；
   - 其他值按 `steer` 进入插话队列，在当前工具批次结束后、下一次模型请求前投递。
7. 如果空闲，先检查模型和认证，再调用 `_startRun`。

这一阶段最重要的产物是 `expandedText`：它可能已经不是用户原话。扩展命令、输入钩子、技能、模板都可能改变文本；队列路径则意味着“这次 prompt 已经受理，但还没有变成消息”。

源码入口：

- [agent-session.ts:3590](../../../../../packages/coding-agent/src/core/agent-session.ts#L3590 "async prompt(text: string, options?: PromptOptions): Promise<void> {")
- [agent-session.ts:3605](../../../../../packages/coding-agent/src/core/agent-session.ts#L3605 "if (expandPromptTemplates && text.startsWith(\"/\")) {")
- [agent-session.ts:3629](../../../../../packages/coding-agent/src/core/agent-session.ts#L3629 "const processedInput = await this._runInputHandlers(")
- [agent-session.ts:3655](../../../../../packages/coding-agent/src/core/agent-session.ts#L3655 "expandedText = this._expandSkillCommand(expandedText);")
- [agent-session.ts:3657](../../../../../packages/coding-agent/src/core/agent-session.ts#L3657 "expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);")
- [agent-session.ts:3664](../../../../../packages/coding-agent/src/core/agent-session.ts#L3664 "if (!options?.streamingBehavior) {")
- [agent-session.ts:3938](../../../../../packages/coding-agent/src/core/agent-session.ts#L3938 "private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {")
- [agent-session.ts:3968](../../../../../packages/coding-agent/src/core/agent-session.ts#L3968 "private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {")
- [agent-session.ts:3719](../../../../../packages/coding-agent/src/core/agent-session.ts#L3719 "_startRun({ messageType:")

#### 5. _prepareRun：这里才创建 AgentMessage

`_prepareRun` 准备“这次运行开始时要送进循环的消息批次”。它先检查上一条 assistant 是否需要压缩，再执行 `before_agent_start` 扩展；扩展可以：

- 选择/修改模型和思考级别；
- 往 `result.messages` 里注入 custom 或上下文消息；
- 在提示词或工具声明变化时生成 system 补丁。

然后它构造普通用户消息：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "读取 README.md 前 20 行并总结" },
    { "type": "image", "data": "...", "mimeType": "image/png" }
  ],
  "timestamp": 1760000000000
}
```

图片块只在有图片时出现；`text` 后面还可能追加图片处理提示。之后还会按顺序追加：

- `_pendingNextTurnMessages` 里的待投递消息；
- 扩展注入的 `result.messages`；
- 必要时把 system 补丁 `unshift` 到最前面。

所以，“用户消息对象”是在会话层构造的，不是在 `Agent.prompt` 里构造的。`AgentSession` 传给 `Agent.prompt` 的已经是 `AgentMessage[]`。

源码入口：

- [agent-session.ts:3297](../../../../../packages/coding-agent/src/core/agent-session.ts#L3297 "private async _prepareRun(trigger: BeforeAgentStartTrigger): Promise<AgentMessage[]> {")
- [agent-session.ts:3249](../../../../../packages/coding-agent/src/core/agent-session.ts#L3249 "await this.agent.prompt(messages);")

#### 6. Agent 与 agent-loop：同一条输入变成两类消息

`Agent.prompt` 接受字符串、单条消息或消息数组。`normalizePromptInput` 的规则是：

- 数组：原样返回；
- 单条 `AgentMessage`：包成数组；
- 字符串：新建一条 `user` 消息。

`AgentSession` 走的是数组分支，所以这里不会再造一条 user 消息。随后 `runPromptMessages` 把新消息、历史快照、循环配置和事件回调交给 `runAgentLoop`。

在每次模型请求前，agent-loop 依次做：

```text
context.messages
  -> transformContext（可选）
  -> convertToLlm
  -> normalizeContext
  -> streamFunction
```

`transformContext` 是 AgentMessage 到 AgentMessage 的应用层变换，例如会话层隐藏某些工具声明。`convertToLlm` 才做角色映射：`bashExecution`、`custom`、`branchSummary`、`compactionSummary` 都转成 `user`，标准角色透传。`normalizeContext` 把可能存在的顶层 `systemPrompt` / `tools` 折进首条 system 消息，返回 `{ messages }`；在 agent 路径里系统提示通常已经在消息数组里，所以这一步通常不新增消息。

接着 `ModelRuntime.streamSimple` 会再做一次 `normalizeContext`，然后交给具体 provider 的 `streamSimple`。真正的线上请求体由 provider 适配器构造，`TranscriptContext` 只是供应商无关的输入，不等于 OpenAI 或 Anthropic 的原始 JSON。

源码入口：

- [agent.ts:668](../../../../../packages/agent/src/agent.ts#L668 "async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {")
- [agent.ts:738](../../../../../packages/agent/src/agent.ts#L738 "private normalizePromptInput(")
- [agent.ts:773](../../../../../packages/agent/src/agent.ts#L773 "private async runPromptMessages(")
- [agent-loop.ts:168](../../../../../packages/agent/src/agent-loop.ts#L168 "export async function runAgentLoop(")
- [agent-loop.ts:645](../../../../../packages/agent/src/agent-loop.ts#L645 "async function streamAssistantResponse(")
- [agent-loop.ts:661](../../../../../packages/agent/src/agent-loop.ts#L661 "if (config.transformContext) {")
- [agent-loop.ts:668](../../../../../packages/agent/src/agent-loop.ts#L668 "const llmMessages = await config.convertToLlm(messages);")
- [agent-loop.ts:671](../../../../../packages/agent/src/agent-loop.ts#L671 "const llmContext = normalizeContext({ messages: llmMessages });")
- [messages.ts:244](../../../../../packages/coding-agent/src/core/messages.ts#L244 "export function convertToLlm(messages: AgentMessage[]): Message[] {")
- [transcript.ts:46](../../../../../packages/ai/src/utils/transcript.ts#L46 "export function normalizeContext(context: Context): TranscriptContext {")
- [model-runtime.ts:1333](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1333 "streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {")

#### 7. 同一句话在各层的表示

| 层 | 典型值/类型 | 谁产生 |
| --- | --- | --- |
| shell argv | `"-p"`、`"读取 README.md 前 20 行并总结"` | shell |
| `Args.messages` | `string[]` | `parseArgs` |
| `initialMessage` | `string \| undefined` | `buildInitialMessage` |
| `expandedText` | `string` | `AgentSession.prompt` 及扩展/模板 |
| `AgentMessage` | `{ role: "user", content: [...], timestamp }` | `_prepareRun` |
| `AgentMessage[]` | 历史 + 起始批次 | `Agent.prompt` / agent-loop |
| `Message[]` | `system \| user \| assistant \| toolResult` | `convertToLlm` |
| `TranscriptContext` | `{ messages: Message[] }` | `normalizeContext` |
| provider wire message | 各协议自己的 JSON 结构 | provider 适配器 |

最容易犯的错误是拿 `initialMessage` 直接推断模型看到了什么。实际上模型看到的是投影后的历史，里面可能已经有模板展开、system 补丁、图片提示、压缩摘要和其他扩展消息。

#### 8. assistant 回复与落盘

模型流式返回时，agent-loop 先创建一条草稿消息，发出 `message_start`；每个增量替换草稿并发 `message_update`；流结束后发 `message_end`，这条完整 `AssistantMessage` 才进入 Agent 的 `messages`。

会话层订阅到 `message_end` 后，按角色把消息写入会话：

- `system`、`user`、`assistant`、`toolResult` 走 `appendMessage`；
- `custom` 走 `appendCustomMessageEntry`；
- 其他应用层消息（例如手动 bash 记录、压缩摘要）有自己的保存路径。

JSONL 条目的形状与消息对象不同：条目有树结构字段 `id`、`parentId` 和 ISO 时间戳，消息本身的时间戳是毫秒数。

```json
{
  "type": "message",
  "id": "entry-id",
  "parentId": "parent-entry-id",
  "timestamp": "2026-11-06T10:00:00.000Z",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "读取 README.md 前 20 行并总结" }],
    "timestamp": 1760000000000
  }
}
```

源码入口：

- [agent-session.ts:1971](../../../../../packages/coding-agent/src/core/agent-session.ts#L1971 "entryId = this.sessionManager.appendMessage(event.message);")
- [session-manager.ts:1936](../../../../../packages/coding-agent/src/core/session-manager.ts#L1936 "appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {")

#### 9. 下一轮请求

下一次模型请求不会把上一轮的 `Agent.messages` 原封不动拿去做请求体。`AgentSession._installAgentRequestProjection` 会在每次请求前用 `buildSessionProjection()` 重算模型可见历史；`prepareNextTurn` 路径在工具执行后、下一次 assistant 回答前也会刷新投影并检查压缩。

所以同一条用户消息会经历两次“出现”：

1. `_prepareRun` 创建它，作为本次运行的新消息进入循环；
2. `message_end` 把它写入会话；后续请求通过投影再把它读出来。

它不是被复制了两份，而是“新消息的对象”和“持久化后的条目”两个阶段。第一次请求前，初始消息已经经过 `message_start` / `message_end` 并被会话保存，随后 `prepareRequest` 的投影会从会话中重新取出它，而不是依赖循环里那份临时数组。

### 常见断点与观察方法

| 现象 | 先看 | 解释 |
| --- | --- | --- |
| 输入被当成命令，没有模型请求 | `_tryExecuteExtensionCommand` | `/` 开头且扩展返回 handled 时，`prompt` 直接结束 |
| 忙碌时提交抛错 | `prompt` 的 `isStreaming` 分支 | 没有 `streamingBehavior` 不允许并发运行 |
| 提交成功但模型没动 | 队列、`queue_update` | 可能进了 steer/followUp 队列，等当前回合结束 |
| `@file` 或 stdin 内容缺失/连在一起 | `buildInitialMessage` | 拼接顺序和空字符串连接规则 |
| 会话文件里有消息，模型却看不到 | T3 的投影 | 压缩、`context_edit`、分支选择都可能改变可见性 |
| JSON 里有 assistant 事件，文件里没有 | `message_end` 保存路径 | 只有完整消息结束才落盘，`message_update` 不落盘 |

观察方法：

- 用 `pi --mode json -p "..."` 看 `message_start` / `message_end`，确认用户消息的最终文本和图片块。
- 在会话 JSONL 里对照条目时间（ISO）和消息时间（毫秒），区分“条目”和“消息”。
- 断点优先下在 `AgentSession.prompt`、`_prepareRun`、`Agent.normalizePromptInput`、`prepareRequest`，分别观察“原始文本”“展开文本”“起始消息批次”“最终请求上下文”。
- 不要只看 `initialMessage` 就断定模型输入；先确认模板/技能/输入钩子是否改写了它。

### 对应模块

- 输入解析和装配：[M01 入口与配置](../01-entry-and-config/README.md#m01-walk-main)
- 低层循环和请求构造：[M02 Agent 循环](../02-agent-loop/README.md#m02-walk-prompt)
- 会话入口、扩展命令、队列：[M03 会话与上下文](../03-session-and-context/README.md#m03-multiturn)
- 模型运行时的实际分发：[M04 模型访问](../04-model-access/README.md#m04-names)
- 三种模式如何提交：[M05 模式与 TUI](../05-modes-and-tui/README.md#m05-compare)
- 全链路对应步骤：[S2](../00-full-chain/README.md#m00-s2)、[S3](../00-full-chain/README.md#m00-s3)、[S5](../00-full-chain/README.md#m00-s5)、[S6](../00-full-chain/README.md#m00-s6)

<a id="trace-tool"></a>
## T2 一次工具调用的一生

**一句话**：工具调用不是“模型调用了一个本地函数”这么简单；它是 assistant 消息里的一个 `toolCall` 内容块，被循环转成一对 `toolCall` / `toolResult` 消息。工具管线里的绝大多数失败不会抛穿循环，而是变成带 `isError: true` 的工具结果，让模型下一轮自己修正。

### 时间线

| 阶段 | 入口 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1. 模型流返回调用 | provider 流 | `toolcall_start` / `toolcall_delta` / `toolcall_end` | 草稿中的 `ToolCall` 块 |
| 2. assistant 完成 | `message_end` | 完整 `AssistantMessage` | 持久化的 assistant 消息 |
| 3. 循环筛选 | `runLoop` | `message.content` | `AgentToolCall[]` |
| 4. 选择调度 | `executeToolCalls` | 调用列表、全局/工具执行模式 | 串行或并行批次 |
| 5. 准备单次调用 | `prepareToolCall` | 调用、当前上下文、钩子 | `prepared` 或 `immediate` |
| 6. 执行 | `executePreparedToolCall` | 已校验参数、`signal`、`onUpdate` | 原始结果、错误标志、耗时 |
| 7. 后处理 | `finalizeExecutedToolCall` | 原始结果、`afterToolCall` | 最终结果 |
| 8. 发结束事件 | `emitToolExecutionEnd` | 最终结果 | `tool_execution_end` |
| 9. 包装结果消息 | `createToolResultMessage` | 最终结果 | `ToolResultMessage` |
| 10. 写入会话 | `message_end` | toolResult 消息 | JSONL 条目 |
| 11. 下一轮请求 | `runLoop` / 投影 | assistant + toolResult | 模型继续回答 |

### 每阶段的数据形状

#### 1. 模型给出的是调用声明

assistant 消息的内容数组可以同时包含文字、思考和工具调用：

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "我先读文件。" },
    {
      "type": "toolCall",
      "id": "call_abc",
      "name": "read",
      "arguments": { "path": "README.md" }
    }
  ],
  "api": "openai-responses",
  "provider": "openai",
  "model": "gpt-5",
  "usage": {
    "input": 100,
    "output": 20,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 120,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
  },
  "stopReason": "toolUse",
  "timestamp": 1760000000000
}
```

关键字段：

- `type: "toolCall"` 是内容块的判别字段，不是消息的 `role`。
- `id` 是调用 id，后面必须和 `toolResult.toolCallId` 对上。
- `name` 是模型选择的工具名，用于在本地注册表里查找实现。
- `arguments` 是 JSON 对象；类型标注为 JSON 不代表 schema 已经校验。
- `stopReason: "toolUse"` 表示模型停下来等工具，不表示工具已经执行。

#### 2. 循环只筛选 toolCall 块

`runLoop` 在 assistant 消息完成后做：

```ts
const toolCalls = message.content.filter((c) => c.type === "toolCall");
```

文字和思考块不会被执行。如果 `stopReason === "length"`，循环不会尝试执行这些调用，而是走截断失败路径，因为参数可能只写了一半。

正常路径下，`executeToolCalls` 选择调度方式：

- 全局配置是 `"sequential"`，或这一批里任一工具声明 `executionMode: "sequential"`，整批串行；
- 否则并行。

这里的“串行/并行”是工具批次调度，不是模型请求并发。同一个用户问题仍然只有一条 Agent 循环。

#### 3. 工具开始事件早于校验

无论串行还是并行，单次调用都会先发：

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc",
  "toolName": "read",
  "args": { "path": "README.md" }
}
```

这个事件只表示“开始处理这次调用”，不保证工具存在、参数合法、权限允许或文件真的被读到。真正的查找、参数适配、schema 校验和前置钩子都在之后。

#### 4. prepareToolCall：查找、适配、校验、拦截

`prepareToolCall` 返回两种结果：

- `kind: "immediate"`：已经得到最终失败/阻止结果，不再执行；
- `kind: "prepared"`：找到工具、参数通过校验、前置钩子没有阻止，可以执行。

步骤和失败分支：

1. **按名字查找工具**。用 `toolCall.name` 在 `currentContext.tools` 里找实现。找不到时返回错误结果，文字是 `Tool <name> not found`，不再参数校验。
2. **参数适配**。如果工具有 `prepareArguments`，先让它把别名/旧形状整理成正式参数。没有适配器或返回同一引用时复用原调用；否则浅复制调用并替换 `arguments`。
3. **schema 校验**。`validateToolArguments` 按工具的 schema 校验并转换参数；失败会抛出，进入 catch。
4. **前置钩子**。调用 `beforeToolCall`，传入完整 assistant 消息、原始 toolCall、已校验参数和当前上下文。会话层把这个钩子接到扩展的 `tool_call` 事件。
5. **取消检查**。钩子返回后如果 `signal.aborted`，返回 `Operation aborted`。
6. **阻止检查**。如果钩子返回 `block: true`，用 `reason` 或默认文字 `Tool execution was blocked` 形成错误结果；如果还返回 `terminate: true`，把终止提示写进结果。

prepare 阶段的任何异常（包括适配器、校验器、扩展钩子抛错）都被捕获并转成工具错误结果，不会直接把整条用户 query 抛穿。

源码入口：

- [agent-loop.ts:281](../../../../../packages/agent/src/agent-loop.ts#L281 "async function runLoop(")
- [agent-loop.ts:445](../../../../../packages/agent/src/agent-loop.ts#L445 "const toolCalls = message.content.filter((c) => c.type ===")
- [agent-loop.ts:863](../../../../../packages/agent/src/agent-loop.ts#L863 "async function executeToolCalls(")
- [agent-loop.ts:904](../../../../../packages/agent/src/agent-loop.ts#L904 "async function executeToolCallsSequential(")
- [agent-loop.ts:1005](../../../../../packages/agent/src/agent-loop.ts#L1005 "async function executeToolCallsParallel(")
- [agent-loop.ts:1196](../../../../../packages/agent/src/agent-loop.ts#L1196 "function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {")
- [agent-loop.ts:1223](../../../../../packages/agent/src/agent-loop.ts#L1223 "async function prepareToolCall(")
- [agent-session.ts:1019](../../../../../packages/coding-agent/src/core/agent-session.ts#L1019 "this.agent.beforeToolCall = (context) => this._beforeToolCall(context);")
- [agent-session.ts:1030](../../../../../packages/coding-agent/src/core/agent-session.ts#L1030 "private async _beforeToolCall(")
- [types.ts:77](../../../../../packages/agent/src/types.ts#L77 "export interface BeforeToolCallResult {")
- [types.ts:129](../../../../../packages/agent/src/types.ts#L129 "export interface BeforeToolCallContext {")

#### 5. executePreparedToolCall：真正执行

只有 `kind: "prepared"` 会进入这里。它调用：

```ts
await prepared.tool.execute(
  prepared.toolCall.id,
  prepared.args as never,
  signal,
  (partialResult) => { /* 进度回调 */ },
);
```

要点：

- `execute` 的入参是**已校验参数**，不是模型原始 JSON。
- 工具上报进度时，回调发 `tool_execution_update`，带 `toolCallId`、`toolName`、`args` 和 `partialResult`。
- 工具可以正常 resolve 但返回 `isError: true`；因此不能只看 Promise 是否 reject。
- 抛异常时，异常文本被包成错误结果，`isError: true`，并保留已测量的 `durationMs`。
- 已经发出的进度通知在最终结果前等待完成；结束后再来的 update 不再接受。

#### 6. finalizeExecutedToolCall：后处理可以改写结果

`finalizeExecutedToolCall` 调用 `afterToolCall`。会话层把它接到扩展的 `tool_result` 事件，并在之后做结果图片规范化。

合并规则是逐字段的：

- `content`、`details`、`usage`、`terminate` 有值才覆盖；
- `isError` 可以被显式改成成功或失败；
- `structuredContent` 如果被替换了 `content` 却没有一起提供，会被删除，避免结构化输出与模型可见正文不一致；
- 后置钩子自身抛错时，整个结果被替换成错误结果，不会保留原来的“成功”内容；
- 实际执行耗时 `durationMs` 保留，后处理时间不计入。

#### 7. tool_execution_end 与 toolResult 消息是两件事

`emitToolExecutionEnd` 发出：

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc",
  "toolName": "read",
  "result": {
    "content": [{ "type": "text", "text": "..." }],
    "details": {}
  },
  "isError": false,
  "durationMs": 12
}
```

然后才创建模型可见的 `ToolResultMessage`：

```json
{
  "role": "toolResult",
  "toolCallId": "call_abc",
  "toolName": "read",
  "content": [{ "type": "text", "text": "..." }],
  "details": {},
  "isError": false,
  "timestamp": 1760000000000,
  "durationMs": 12
}
```

两者的区别：

- `tool_execution_end` 是生命周期事件，不是消息，不会直接出现在模型历史里。
- `toolResult` 是真正的模型消息，通过 `message_start` / `message_end` 发布并持久化。
- 二者共享同一个 `toolCallId`，但消费方不同：UI 用工具事件展示进度，模型用 toolResult 继续推理。
- `durationMs` 只在有定义时出现；被阻止或未执行的调用可能没有耗时。

#### 8. 下一轮请求

runLoop 把本批 toolResult 加入 `currentContext.messages` 和 `newMessages`，然后：

1. 发出 `turn_end`，字段包含本回合 assistant 消息和 `toolResults`；
2. 如果这批结果没有一致要求 `terminate`，`hasMoreToolCalls` 为 true；
3. 下一回合再发 `turn_start`，重新投影上下文，向模型发出包含 assistant `toolCall` 和 toolResult 的请求。

并行批次还有一个重要顺序差异：

- `tool_execution_start` 按模型调用顺序发出，准备也是顺序做的；
- 实际执行通过 `Promise.all` 并发，`tool_execution_end` 按完成顺序发出；
- toolResult 消息在 `Promise.all` 之后按原始调用顺序统一创建和发出。

所以不要把 `tool_execution_end` 的到达顺序当成工具结果在历史里的顺序；配对和排序都以原始调用顺序与 `toolCallId` 为准。

源码入口：

- [agent-loop.ts:1417](../../../../../packages/agent/src/agent-loop.ts#L1417 "async function executePreparedToolCall(")
- [agent-loop.ts:1490](../../../../../packages/agent/src/agent-loop.ts#L1490 "async function finalizeExecutedToolCall(")
- [agent-loop.ts:1586](../../../../../packages/agent/src/agent-loop.ts#L1586 "function createErrorToolResult(message: string): AgentToolResult<any> {")
- [agent-loop.ts:1600](../../../../../packages/agent/src/agent-loop.ts#L1600 "async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {")
- [agent-loop.ts:1623](../../../../../packages/agent/src/agent-loop.ts#L1623 "function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {")
- [agent-loop.ts:1654](../../../../../packages/agent/src/agent-loop.ts#L1654 "async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {")
- [agent-loop.ts:1187](../../../../../packages/agent/src/agent-loop.ts#L1187 "function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {")
- [types.ts:513](../../../../../packages/agent/src/types.ts#L513 "export interface AgentToolResult<T = JsonValue | undefined> {")
- [types.ts:545](../../../../../packages/agent/src/types.ts#L545 "export interface AgentToolCallOutcome {")

### 失败分支

这是 T2 最需要背下来的一张表。工具失败默认是“结果”，不是“循环异常”。

| 分支 | 触发 | 模型/事件看到的结果 | `isError` | `terminate` | 是否直接结束循环 |
| --- | --- | --- | --- | --- | --- |
| 工具不存在 | 名字在已注册工具中找不到 | 文本 `Tool <name> not found` | true | 无 | 否 |
| 参数适配/校验失败 | `prepareArguments` 或 schema 校验抛错 | 抛出的错误文本 | true | 无 | 否 |
| 被前置钩子阻止 | `beforeToolCall` 返回 `block: true` | 钩子的 `reason` 或 `Tool execution was blocked` | true | 钩子可设 true | 否；只有整批结果都 true 才停止自动续轮 |
| 执行抛异常 | `tool.execute` reject | 异常的 `message` 或 `String(error)` | true | 无 | 否 |
| 后置钩子抛异常 | `afterToolCall` reject | 后置错误的文本，原结果被替换 | true | 无 | 否 |
| 输出被长度截断 | assistant 的 `stopReason === "length"` | 固定文本：`Tool call "<name>" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.` | true | 无 | 否；下一轮请模型重发完整参数 |
| 用户取消（准备后） | `signal.aborted` | `Operation aborted` | true | 无 | 不再安排后续工具；已完成的保留 |
| 并行批次取消 | 某个异步任务开始前 `signal` 已取消 | `Operation aborted` | true | 无 | 已启动工具依赖 `signal` 自行退出 |
| 空批次/部分 terminate | 结果数组为空或并非每个都 `terminate: true` | 正常结果 | 按各结果 | 不整体终止 | 否 |

补充说明：

- `shouldTerminateToolBatch` 的规则是“数组非空且每个最终结果的 `result.terminate === true`”。单个工具要求终止不够，空数组也不会因为 `every` 的数学空真而终止。
- 工具错误结果仍然会走 `message_start` / `message_end`，所以模型一定能看到一条与调用 id 配对的失败结果；这正是模型能自我修正的基础。
- 截断分支不会调用 `prepareArguments`、schema 校验或 `beforeToolCall`；它只发工具开始/结束和失败 toolResult。
- 串行批次在取消后 `break`，已完成的结果仍会返回；未轮到的调用没有事件和结果。并行批次在准备循环里遇到取消也会停止安排后面的调用。
- 嵌套工具调用（工具内部通过 `ctx.executeTool()` 再调工具）走同一个执行管线，但 `runToolCall` 不经过模型批次的事件和 toolResult 消息路径；不要期待在顶层看到它们的 `tool_execution_*`。

源码入口：

- [agent-loop.ts:809](../../../../../packages/agent/src/agent-loop.ts#L809 "async function failToolCallsFromTruncatedMessage(")
- [agent-loop.ts:1396](../../../../../packages/agent/src/agent-loop.ts#L1396 "export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {")
- [agent-session.ts:1079](../../../../../packages/coding-agent/src/core/agent-session.ts#L1079 "private async _afterToolCall(")

### 常见断点与观察方法

| 现象 | 先看 | 解释 |
| --- | --- | --- |
| 有 `tool_execution_start`，没有 end | `prepareToolCall` 或 `execute` | 可能卡在扩展钩子、参数适配或工具自身的 Promise |
| assistant 有 toolCall，历史里没有 toolResult | 取消、进程退出、批次中断 | 正常路径一定会配对；中断路径可能只留下部分结果 |
| 模型反复发同一个调用 | 上一条 toolResult 的正文和 `isError` | 参数错误、工具不存在或被阻止都可能让模型重试 |
| 工具没执行但事件成功 | `tool_execution_end.isError` 和 result | 事件成功只代表管线完成，不代表 `isError` 为 false |
| 并行结果顺序对不上 | `toolCallId` | end 事件按完成顺序，toolResult 消息按调用顺序 |
| 模型收到截断参数 | assistant 的 `stopReason` | `length` 分支不执行工具，只生成失败结果 |

观察方法：

- 用 `pi --mode json -p "..."` 同时看 `tool_execution_*` 和 toolResult 的 `message_start` / `message_end`，对照 `toolCallId`。
- 会话 JSONL 里检查 toolResult 的 `toolCallId`、`isError`、`details`、`durationMs`；不要只看正文文本。
- 断点优先下在 `prepareToolCall`、`executePreparedToolCall`、`finalizeExecutedToolCall` 和 `createToolResultMessage`。
- 如果怀疑扩展拦截，断在会话的 `_beforeToolCall` / `_afterToolCall`，确认扩展拿到的是已校验参数和当前结果。

### 对应模块

- 工具循环和事件：[M02 Agent 循环](../02-agent-loop/README.md#m02-walk-tools)
- 准备与执行细节：[M02 工具准备](../02-agent-loop/README.md#m02-walk-prepare)、[M02 工具执行](../02-agent-loop/README.md#m02-walk-execute)
- 工具事件与消息的区别：[M02 事件](../02-agent-loop/README.md#m02-events)
- 扩展 `tool_call` / `tool_result`：[M03 会话与上下文](../03-session-and-context/README.md#m03-store)
- UI 如何展示工具：[M05 交互模式](../05-modes-and-tui/README.md#m05-interactive)
- 全链路失败路径：[失败分支](../00-full-chain/README.md#m00-failure)

<a id="trace-context"></a>
## T3 一份上下文的一生

**一句话**：磁盘上的 JSONL 是追加式历史，当前分支只是其中一条从根到叶的路径，模型可见投影是在分支上再应用“最新压缩 + `context_edit`”的结果，供应商线上消息则是投影经过角色转换和协议适配后的最终形态。四者不是同一份数据，`Agent.messages` 也不是持久化真相。

### 时间线

| 阶段 | 入口 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1. 追加记录 | `SessionManager.appendMessage` / `appendCompaction` | 完整消息或压缩检查点 | JSONL 条目 |
| 2. 选当前分支 | `buildSessionPath` | 全部条目、leaf id | 根到叶的 `SessionEntry[]` |
| 3. 应用压缩 | `buildContextEntries` | 路径、最新压缩 | 压缩感知的条目顺序 |
| 4. 应用编辑 | `projectContextEntry` | 条目、该目标最新编辑 | 模型可见的 `AgentMessage[]` |
| 5. 生成投影 | `buildSessionProjection` | 路径、压缩、编辑 | `SessionProjection` |
| 6. 请求前重投影 | `prepareRequest` | 当前分支 | 本次请求的 `canonicalContext` |
| 7. 下一轮刷新 | `prepareNextTurn` | 工具后的上下文 | 重新投影并可能压缩 |
| 8. 角色转换 | `convertToLlm` | `AgentMessage[]` | `Message[]` |
| 9. 上下文规范化 | `normalizeContext` | `Message[]` | `TranscriptContext` |
| 10. 协议适配 | `ModelRuntime` / provider | `TranscriptContext` | 供应商线上请求 |

### 四层数据，不要混用

| 层 | 包含什么 | 不包含什么 | 谁构建 |
| --- | --- | --- | --- |
| 原始磁盘历史 | 所有 JSONL 行：所有分支、旧消息、压缩记录、编辑记录、设置记录 | 压缩/编辑后的可见结果 | `SessionManager` 追加 |
| 当前分支 | 从根沿 `parentId` 到当前 leaf 的一条路径 | 其他分支的对话节点 | `buildSessionPath` |
| 模型可见投影 | 最新压缩 + 保留的旧尾部 + 压缩后条目，再应用 `context_edit` | 被摘要掉的旧条目、被编辑隐藏的目标、旧压缩摘要 | `buildSessionProjection` |
| 供应商线上消息 | provider 自己的协议 JSON | 应用层 custom/bash 角色、会话树元数据 | `convertToLlm` + provider 适配 |

附加一层：`Agent.messages` 是低层循环当前使用的已完成消息数组，是工作副本，不是磁盘历史。它会被投影刷新，也可能不包含设置条目、分支结构、编辑记录等“非消息”信息。不要把“往 `Agent.messages` 里 push 一条”当成持久化。

### 每阶段的数据形状

#### 1. JSONL 是追加式树

第一行是会话头，不是对话节点：

```json
{
  "type": "session",
  "version": 3,
  "id": "session-id",
  "timestamp": "2026-11-06T10:00:00.000Z",
  "cwd": "/path/to/project"
}
```

后续每条树条目都有：

- `type`：`message`、`compaction`、`context_edit`、`branch_summary`、`model_change`、`thinking_level_change` 等；
- `id`：条目 id；
- `parentId`：父条目 id，`null` 表示根；
- `timestamp`：ISO 字符串。

普通消息条目把消息包在 `message` 字段里。压缩条目保存 `summary`、`firstKeptEntryId`、`tokensBefore`，还可以保存 `systemMessage` 作为压缩边界的系统/工具状态检查点。`context_edit` 保存 `targetId` 和 `replacement`；`replacement: null` 表示隐藏目标，`{ content: ... }` 表示只替换目标正文。

源码入口：

- [session-manager.ts:58](../../../../../packages/coding-agent/src/core/session-manager.ts#L58 "export interface SessionHeader {")
- [session-manager.ts:82](../../../../../packages/coding-agent/src/core/session-manager.ts#L82 "export interface SessionEntryBase {")
- [session-manager.ts:94](../../../../../packages/coding-agent/src/core/session-manager.ts#L94 "export interface SessionMessageEntry extends SessionEntryBase {")
- [session-manager.ts:135](../../../../../packages/coding-agent/src/core/session-manager.ts#L135 "export interface CompactionEntry<T = unknown> extends SessionEntryBase {")
- [session-manager.ts:247](../../../../../packages/coding-agent/src/core/session-manager.ts#L247 "export interface ContextEditEntry extends SessionEntryBase {")
- [session-manager.ts:258](../../../../../packages/coding-agent/src/core/session-manager.ts#L258 "export type SessionEntry =")

#### 2. 当前分支只沿 parentId 走

`buildSessionPath` 从选定 leaf 开始，沿 `parentId` 一路向根，最后反转成正序：

```text
A -> B -> C -> D
```

如果从 A 分出另一条 `A -> E`，选 D 只得到 `[A, B, C, D]`，不会混入 E。切换分支的本质是切换 leaf；JSONL 里的其他行仍然存在。

边界行为：

- `leafId === null`：明确返回空路径，不是“默认最后一条”。
- 传入的 id 找不到：回退到最后一条条目，而不是报错。
- 父节点缺失：向上走时停止，不保证检测所有环。

源码入口：

- [session-manager.ts:569](../../../../../packages/coding-agent/src/core/session-manager.ts#L569 "function buildSessionPath(")

#### 3. 压缩：最新检查点决定重放顺序

`buildContextEntries` 只在当前分支上找**最新**的压缩条目。找到后，顺序固定为：

1. 最新压缩条目本身；
2. 从 `firstKeptEntryId` 开始、到压缩条目之前的旧尾部；
3. 压缩条目之后的全部条目。

在扫描旧尾部时，`message.role === "system"` 的旧系统消息会被跳过，因为压缩条目的 `systemMessage` 已经保存了边界处的完整系统/工具状态。

具体例子，路径为：

| 条目 | 类型 | 内容 |
| --- | --- | --- |
| A | message | user: 第一个问题 |
| B | message | system: 旧系统提示 |
| C | message | user: 读取文件 |
| D | message | assistant: toolCall |
| E | message | toolResult |
| F | message | user: 继续 |
| G | compaction | `firstKeptEntryId = C`，带 `systemMessage` |
| H | message | assistant: 最终回答 |

最新压缩是 G，所以 `buildContextEntries` 返回：

```text
[G, C, D, E, F, H]
```

B 被跳过，因为它是旧 system 消息；A 被摘要替代。投影时 G 贡献 `[systemMessage, compactionSummary]`，其他消息按原角色贡献。

再叠加 `context_edit`：

- 只收集当前重放范围里的编辑；
- 同一个 `targetId` 有多次编辑时，后出现的覆盖前面的；
- 目标条目不在范围里（例如已被压缩掉、在另一分支），编辑不会凭空生效；
- 目标被 `replacement: null` 隐藏时，投影贡献 `[]`；
- 替换 assistant/toolResult 的字符串正文时，会先规范化成单个 text 块，再浅复制消息并替换 `content`。

源码入口：

- [session-manager.ts:650](../../../../../packages/coding-agent/src/core/session-manager.ts#L650 "export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {")
- [session-manager.ts:705](../../../../../packages/coding-agent/src/core/session-manager.ts#L705 "export function buildContextEntries(")
- [session-manager.ts:775](../../../../../packages/coding-agent/src/core/session-manager.ts#L775 "export function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {")

#### 4. buildSessionProjection：来源、消息、设置

`buildSessionProjection` 组合四件事：

1. 用 `buildSessionPath` 选当前分支，并从完整路径恢复 `thinkingLevel` 和 `model` 设置；
2. 用 `buildContextEntries` 得到压缩感知的条目列表；
3. 收集当前范围里每个 `targetId` 的最新 `context_edit`；
4. 把每个条目投影成零条或多条消息，保留 `sourceEntry` 来源。

输出形状：

```ts
{
  entries: { sourceEntry: SessionEntry, messages: AgentMessage[] }[],
  messages: AgentMessage[],
  thinkingLevel: ...,
  model: ...
}
```

两处容易忽略的规则：

- 最新压缩在下标 0，贡献检查点和摘要；如果保留区里还夹着更旧的压缩条目（`index > 0`），它只保留来源，不再贡献摘要，避免重复总结。
- 设置（模型、思考级别）从完整当前路径恢复，不会因为旧对话被压缩就丢失；但它们不一定是消息，不会出现在 `messages` 里。

源码入口：

- [session-manager.ts:817](../../../../../packages/coding-agent/src/core/session-manager.ts#L817 "export function buildSessionProjection(")
- [session-manager.ts:871](../../../../../packages/coding-agent/src/core/session-manager.ts#L871 "export function buildSessionContext(")
- [session-manager.ts:616](../../../../../packages/coding-agent/src/core/session-manager.ts#L616 "function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, \"thinkingLevel\" | \"model\"> {")
- [session-manager.ts:301](../../../../../packages/coding-agent/src/core/session-manager.ts#L301 "export interface SessionProjection {")

#### 5. 每次请求都必须重新投影

`_installAgentRequestProjection` 把 `Agent.prepareRequest` 包装成每次都执行的逻辑：

1. `buildSessionProjection()` 取当前有效历史；
2. 构造 `canonicalContext`：保留原上下文其他字段，把 `messages` 换成投影消息，把 `tools` 换成当前 Agent 工具快照；
3. 先调用之前的 `prepareRequest` 回调，允许外层继续改上下文/模型；
4. 如果是虚拟模型，解析物理路由；
5. 如果物理模型超过压缩阈值，执行 `_runAutoCompaction`，然后重新 `prepare()`，但不重做已经确定的路由；
6. 返回最终 `context`、`model`、`thinkingLevel`。

另外，`_installAgentNextTurnRefresh` 在工具执行后、下一次 assistant 回答前调用 `_compactBeforeNextAssistantResponse`，也会先投影、再判断阈值、必要时压缩并重新投影。这说明“请求前投影”不是只在用户发新问题时发生，而是每个模型请求都可能发生。

源码入口：

- [agent-session.ts:1270](../../../../../packages/coding-agent/src/core/agent-session.ts#L1270 "private _installAgentRequestProjection(): void {")
- [agent-session.ts:1274](../../../../../packages/coding-agent/src/core/agent-session.ts#L1274 "this.agent.prepareRequest = async (request, signal) => {")
- [agent-session.ts:1282](../../../../../packages/coding-agent/src/core/agent-session.ts#L1282 "const projection = this.sessionManager.buildSessionProjection();")
- [agent-session.ts:1288](../../../../../packages/coding-agent/src/core/agent-session.ts#L1288 "messages: projection.messages,")
- [agent-session.ts:1247](../../../../../packages/coding-agent/src/core/agent-session.ts#L1247 "private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {")
- [agent-session.ts:5137](../../../../../packages/coding-agent/src/core/agent-session.ts#L5137 "private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {")
- [agent-session.ts:5375](../../../../../packages/coding-agent/src/core/agent-session.ts#L5375 "private async _runAutoCompaction(reason: \"overflow\" | \"threshold\", willRetry: boolean): Promise<boolean> {")
- [session-manager.ts:2039](../../../../../packages/coding-agent/src/core/session-manager.ts#L2039 "appendCompaction<T = unknown>(")

#### 6. Agent.messages 为什么不能当持久化

`Agent.messages` 是当前低层运行的已完成消息数组。它的问题是：

- 它不知道 JSONL 的 `id` / `parentId`，因此无法表达分支；
- 它没有压缩检查点、`context_edit`、设置条目等非消息记录；
- 它不会自动反映磁盘变化；切换分支、外部编辑、恢复会话后，内存副本可能落后；
- 直接 push 进去不会写 JSONL，下一次投影会把它丢掉；
- 它可能只代表“当前 Agent 认为的历史”，而模型请求实际使用的是投影。

会话层在压缩、上下文编辑、分支切换等时机会调用 `_refreshFinalizedContext`：重新投影，并把 `agent.state.messages` 替换成投影消息，同时记录消息对象到来源条目 id 的映射。这样 UI/状态和请求上下文能重新对齐，但请求边界仍然以 `prepareRequest` 的投影为准。

源码入口：

- [agent-session.ts:1543](../../../../../packages/coding-agent/src/core/agent-session.ts#L1543 "private _refreshFinalizedContext(): void {")
- [agent-session.ts:1552](../../../../../packages/coding-agent/src/core/agent-session.ts#L1552 "this.agent.state.messages = projection.messages;")
- [agent-session.ts:5515](../../../../../packages/coding-agent/src/core/agent-session.ts#L5515 "this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);")
- [agent-session.ts:5519](../../../../../packages/coding-agent/src/core/agent-session.ts#L5519 "this._refreshFinalizedContext();")

#### 7. 从投影到线上消息

`convertToLlm` 做应用层到模型层的角色转换：

- `bashExecution`：转成 `user`；`excludeFromContext` 为 true 时过滤掉；
- `custom`：转成 `user`，`display: false` 不影响发送；
- `branchSummary`：转成带分支边界说明的 `user`；
- `compactionSummary`：转成带压缩边界说明的 `user`；
- `system` / `user` / `assistant` / `toolResult`：透传。

`normalizeContext` 只在存在顶层 `systemPrompt` / `tools` 时把它们折进首条 system 消息；它不会删除后续消息。之后 `ModelRuntime.streamSimple` 再次规范化，并交给物理 provider。provider 适配器负责把 `TranscriptContext` 映射成自己的协议字段。

源码入口：

- [messages.ts:244](../../../../../packages/coding-agent/src/core/messages.ts#L244 "export function convertToLlm(messages: AgentMessage[]): Message[] {")
- [transcript.ts:46](../../../../../packages/ai/src/utils/transcript.ts#L46 "export function normalizeContext(context: Context): TranscriptContext {")
- [model-runtime.ts:1333](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1333 "streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {")
- [model-runtime.ts:1374](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1374 "return prepared.provider.streamSimple(prepared.model, transcript, prepared.options as SimpleStreamOptions);")

### 常见断点与观察方法

| 现象 | 先看 | 解释 |
| --- | --- | --- |
| 文件里有很多消息，模型只看到一部分 | `buildContextEntries` | 可能被最新压缩摘要替代，或不在当前分支 |
| 模型看到重复摘要 | `buildSessionProjection` | 保留区里的旧 compression 条目应只保留来源，不贡献消息 |
| 编辑后的内容没生效 | `ContextEditEntry.targetId`、编辑顺序 | 目标可能不在投影范围，或被更晚的编辑覆盖 |
| 工具结果和 toolCall 对不上 | 分支、取消、`context_edit` | 投影只替换正文，不会自动修复配对；中断批次也可能缺结果 |
| `Agent.messages` 与请求上下文不同 | `prepareRequest` | 请求用投影；内存副本可能尚未刷新 |
| provider 拒绝请求 | `convertToLlm` / provider 适配 | 角色或内容形状可能在最后一层不被接受 |

观察方法：

- 在调试器里同时打印 `sessionManager.buildSessionProjection().messages` 和 `agent.state.messages`，逐条对照来源条目 id。
- 对比 JSONL 行数与投影条目数：前者包含所有分支和设置，后者是压缩/编辑后的当前可见范围。
- 用 `pi --mode json -p "..."` 看 `message_end` 的实际消息，再和会话文件中的 `message` 字段对照；事件形状和条目形状不同。
- 断点优先下在 `buildContextEntries`、`buildSessionProjection`、`prepareRequest`；如果怀疑压缩顺序，直接构造路径 A-H 的例子逐步跟。

### 对应模块

- 会话树与投影：[M03 会话与上下文](../03-session-and-context/README.md#m03-store)
- 多轮如何复用历史：[M03 多轮上下文](../03-session-and-context/README.md#m03-multiturn)
- 压缩与系统检查点：[M03 压缩](../03-session-and-context/README.md#m03-compaction)、[M03 系统状态](../03-session-and-context/README.md#m03-system)
- 上下文编辑：[M03 上下文编辑](../03-session-and-context/README.md#m03-context-edit)
- 模型访问和协议适配：[M04 模型访问](../04-model-access/README.md#m04-design)
- 全链路多轮与压缩：[多轮](../00-full-chain/README.md#m00-multiturn)、[压缩](../00-full-chain/README.md#m00-compaction)

<a id="trace-event"></a>
## T4 一个事件的一生

**一句话**：事件先从 Agent 循环发出，经过 `Agent.processEvents` 更新状态并按订阅顺序等待监听器；会话层先派发扩展事件，再同步通知公开订阅者，最后保存完整消息。`message_update` 不是持久化，`tool_execution_*` 不是消息，`agent_end` 也不等于整个会话已经空闲。

### 时间线

| 阶段 | 入口 | 输入 | 输出 |
| --- | --- | --- | --- |
| 1. 循环发事件 | agent-loop 的 `emit` | 事件对象 | `AgentEventSink` 调用 |
| 2. Agent 更新状态 | `Agent.processEvents` | `AgentEvent` | `streamingMessage`、`messages` 等状态变化 |
| 3. 等待监听器 | `Agent.processEvents` 的 listener 循环 | 事件、取消信号 | 按注册顺序 await |
| 4. 会话内部处理 | `_handleAgentEvent` | `AgentEvent` | 队列、嵌套用量、扩展、公开事件、持久化 |
| 5. 扩展事件 | `_emitExtensionEvent` | 适配后的扩展事件 | 扩展可替换 `message_end` 消息 |
| 6. 公开会话事件 | `_emit` | `AgentSessionEvent` | 同步调用订阅者，不 await |
| 7. 持久化 | `appendMessage` / `appendCustomMessageEntry` | 完整消息 | JSONL 条目 |
| 8. 模式消费 | print / json / interactive / rpc | `AgentSessionEvent` | 文本、JSONL、TUI 或 RPC 输出 |

### 事件分类

| 层级 | 事件 | 关键字段 | 是否直接落盘 |
| --- | --- | --- | --- |
| 运行级 | `agent_start` | 无 | 否 |
| 运行级 | `agent_end` | `messages`；会话版还有 `willRetry` | 否；消息在各自的 `message_end` 已保存 |
| 会话级 | `agent_settled` | `aborted` | 否 |
| 回合级 | `turn_start` | 无 | 否 |
| 回合级 | `turn_end` | `message`、`toolResults` | 否；包含的消息已各自保存 |
| 消息级 | `message_start` | `message` | 否 |
| 消息级 | `message_update` | `message`、`assistantMessageEvent` | 否 |
| 消息级 | `message_end` | `message` | 是；system/user/assistant/toolResult 走 `appendMessage`，custom 走专用条目 |
| 工具级 | `tool_execution_start` | `toolCallId`、`toolName`、`args` | 否 |
| 工具级 | `tool_execution_update` | `toolCallId`、`toolName`、`args`、`partialResult` | 否 |
| 工具级 | `tool_execution_end` | `toolCallId`、`toolName`、`result`、`isError`、`durationMs?` | 否；结果另由 toolResult 消息保存 |
| 会话扩展 | `queue_update` | `steering`、`followUp` | 否 |
| 会话扩展 | `compaction_start` / `compaction_end` | 原因、结果、是否取消/重试 | 压缩检查点由压缩流程单独追加 |
| 会话扩展 | `entry_appended` | `entry` | 通知某条目已经追加 |
| 会话扩展 | `auto_retry_start` / `auto_retry_end` | 尝试次数、延迟、错误 | 否 |
| 会话扩展 | `session_info_changed`、`thinking_level_changed` | 新名称/级别 | 否 |

`AgentEvent` 是低层联合类型；`AgentSessionEvent` 在此基础上：

- 把 `agent_end` 换成带 `willRetry` 的版本；
- 增加 `agent_settled`、队列、压缩、重试、会话信息等事件；
- 给嵌套工具事件加可选的 `parentToolCallId`。

### 一次“带工具”的完整事件序列

下面是一个回合里模型先调用一个工具、再给出最终回答的典型顺序：

```text
agent_start
turn_start
message_start        (user)
message_end          (user)
message_start        (assistant 草稿)
message_update       (text_delta / toolcall_delta ...)
message_end          (assistant，含 toolCall)
tool_execution_start
tool_execution_update (可选，可能多次)
tool_execution_end
message_start        (toolResult)
message_end          (toolResult)
turn_end             { message: assistant, toolResults: [toolResult] }
turn_start
message_start        (assistant 草稿)
message_update       (...)
message_end          (assistant 最终回答)
turn_end             { message: assistant, toolResults: [] }
agent_end            { messages: [...], willRetry }
agent_settled        { aborted: false }
```

`willRetry` 和 `agent_settled` 来自会话版 `AgentSessionEvent`；低层 `AgentEvent` 的 `agent_end` 只有 `messages`。

几个顺序要点：

- 用户消息的 `message_start` / `message_end` 在第一次模型请求前发出；会话层保存后，请求投影才能从会话里读到它。
- assistant 的 `message_end` 早于工具执行；此时 toolCall 已经是完整消息的一部分。
- `tool_execution_end` 早于 toolResult 的 `message_start`；工具事件和工具结果消息是两条通道。
- `turn_end` 在本回合所有工具结果消息之后发出，并携带本回合的 assistant 和 `toolResults`。
- 最终 `turn_end` 的 `toolResults` 为空；随后才是 `agent_end`。
- `agent_end` 之后可能还有重试、压缩或扩展续跑，因此还会出现新的低层运行，最后才是 `agent_settled`。

### 每阶段的数据形状

#### 1. Agent 循环的 emit 是可等待的

agent-loop 的事件出口类型是：

```ts
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

循环里大量使用 `await emit(...)`。这意味着它不只是在“广播”，还在等待接收方处理完当前事件；接收方是 `Agent.processEvents`，而 `processEvents` 又会等待所有 `Agent.subscribe` 的监听器。因此，AgentSession 的持久化处理完成之前，低层循环不会推进到下一次模型请求。

源码入口：

- [agent-loop.ts:39](../../../../../packages/agent/src/agent-loop.ts#L39 "export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;")
- [agent-loop.ts:168](../../../../../packages/agent/src/agent-loop.ts#L168 "export async function runAgentLoop(")

#### 2. processEvents：先改状态，再通知

`Agent.processEvents` 按事件类型更新自己的状态：

- `message_start` / `message_update`：把草稿放进 `state.streamingMessage`；
- `message_end`：清空草稿，把完整消息 `push` 进 `state.messages`；
- `tool_execution_start` / `tool_execution_end`：维护 `pendingToolCalls`；
- `turn_end`：记录错误信息；
- `agent_end`：清空草稿。

状态更新完成后，它按订阅顺序逐个 `await listener(event, signal)`。没有活跃运行时直接抛 `Agent listener invoked outside active run`，这是 Agent 自己的生命周期约束。

源码入口：

- [agent.ts:1026](../../../../../packages/agent/src/agent.ts#L1026 "private async processEvents(event: AgentEvent): Promise<void> {")
- [agent.ts:1048](../../../../../packages/agent/src/agent.ts#L1048 "this._state.messages.push(event.message);")
- [agent.ts:1102](../../../../../packages/agent/src/agent.ts#L1102 "for (const listener of this.listeners) {")
- [agent.ts:474](../../../../../packages/agent/src/agent.ts#L474 "subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {")

#### 3. 会话内部处理器：扩展优先，公开事件第二，持久化第三

AgentSession 在构造时用 `agent.subscribe(this._handleAgentEvent)` 接入低层事件。`_handleAgentEvent` 的主要顺序是：

1. 如果启动准备期间请求过取消，在 `agent_start` 到达时触发 `agent.abort()`；
2. 处理嵌套工具调用的用量记录；
3. 从队列快照中移除已经投递的用户文本，发 `queue_update`；
4. `await this._emitExtensionEvent(event)`：先给扩展；
5. `this._emit(...)`：再给公开订阅者；
6. 如果是 `message_end`，按角色持久化；
7. 记录消息对象到条目 id 的映射，更新最后 assistant、重试/压缩状态；
8. 如果是 `turn_end`，冲刷待处理的 custom 消息。

源码入口：

- [agent-session.ts:761](../../../../../packages/coding-agent/src/core/agent-session.ts#L761 "this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);")
- [agent-session.ts:1872](../../../../../packages/coding-agent/src/core/agent-session.ts#L1872 "private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {")
- [agent-session.ts:1935](../../../../../packages/coding-agent/src/core/agent-session.ts#L1935 "await this._emitExtensionEvent(event);")
- [agent-session.ts:1937](../../../../../packages/coding-agent/src/core/agent-session.ts#L1937 "this._emit(event.type === \"agent_end\" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);")
- [agent-session.ts:1971](../../../../../packages/coding-agent/src/core/agent-session.ts#L1971 "entryId = this.sessionManager.appendMessage(event.message);")

#### 4. 扩展可以替换 message_end

`_emitExtensionEvent` 对 `message_end` 调用扩展的 `emitMessageEnd`。如果扩展返回替换消息：

- 某些角色的 `content` 为空/null 会被规范化为 `[]`；
- 替换字段被原地复制到原消息对象上；
- 随后的公开事件和 `appendMessage` 看到的是替换后的内容。

所以 TUI 看到的最终消息和会话保存的消息可能已经被扩展改过；排查“原文和落盘不一致”时先看这一层。

源码入口：

- [agent-session.ts:2206](../../../../../packages/coding-agent/src/core/agent-session.ts#L2206 "private async _emitExtensionEvent(event: AgentEvent): Promise<void> {")

#### 5. 公开 `_emit` 是同步的，不等待异步 UI

`_emit` 只是遍历 `_eventListeners` 并调用：

```ts
private _emit(event: AgentSessionEvent): void {
  for (const l of this._eventListeners) l(event);
}
```

它没有 `await`，也没有 `try/catch`：

- 监听器如果是 async，返回的 Promise 不会被会话等待；
- UI 处理慢不会阻塞持久化或低层循环；
- 同步抛出的异常会向当前事件处理调用方传播；
- 异步拒绝需要监听器自己处理，否则可能变成未处理拒绝。

这正是“事件发射”和“事件处理完成”分离的地方。Agent 等待的是 `_handleAgentEvent`，不是每个 UI 监听器。

源码入口：

- [agent-session.ts:1746](../../../../../packages/coding-agent/src/core/agent-session.ts#L1746 "private _emit(event: AgentSessionEvent): void {")

#### 6. 持久化发生在公开事件之后、循环推进之前

`_handleAgentEvent` 的顺序是“扩展 -> 公开 `_emit` -> `appendMessage`”。因此：

- 公开监听器在 `message_end` 回调里同步去读会话文件，可能还看不到刚结束的这条消息；
- 但整个 `_handleAgentEvent` 是 async 并被 `processEvents` await，持久化完成后循环才会继续；
- 所以到下一次模型请求时，消息已经保存；
- 异步 UI 监听器本来就不会被等待，读文件的时机更不确定。

源码入口：

- [agent-session.ts:1971](../../../../../packages/coding-agent/src/core/agent-session.ts#L1971 "entryId = this.sessionManager.appendMessage(event.message);")
- [session-manager.ts:1936](../../../../../packages/coding-agent/src/core/session-manager.ts#L1936 "appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {")

#### 7. 模式如何消费事件

- **text 打印模式**：也注册 `session.subscribe`，但只在最后读取 `session.state.messages` 的最后一条 assistant 文本；不逐事件输出。错误/取消/截断在最后统一处理。
- **JSON 模式**：把每个 `AgentSessionEvent` 通过 `toJsonEvent` 转成一行 JSON。`message_update` 会去掉累计的 `message` 快照，只保留 `usage` 和 `assistantMessageEvent`，避免每个增量都重复整段文本。
- **交互模式**：`subscribeToAgent` 注册监听，`handleEvent` 按事件类型更新 TUI；它是 async 的，但会话不 await 它。
- **RPC 模式**：`session.subscribe` 把事件写入 stdout；`agent_settled` 时检查扩展是否请求关闭。

JSON 和 RPC 还额外注册了低层 `agent.subscribe(async () => await waitForRawStdoutBackpressure())`，让 Agent 在 stdout 队列积压时等待。这个等待只覆盖本地写链，不代表远端已经消费。

源码入口：

- [print-mode.ts:165](../../../../../packages/coding-agent/src/modes/print-mode.ts#L165 "unsubscribe = session.subscribe((event) => {")
- [print-mode.ts:175](../../../../../packages/coding-agent/src/modes/print-mode.ts#L175 "session.agent.subscribe(async () => {")
- [json-event.ts:82](../../../../../packages/coding-agent/src/modes/json-event.ts#L82 "export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {")
- [rpc-mode.ts:564](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L564 "unsubscribe = session.subscribe((event) => {")
- [rpc-mode.ts:574](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L574 "unsubscribeBackpressure = session.agent.subscribe(async () => {")
- [interactive-mode.ts:5936](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5936 "private subscribeToAgent(): void {")
- [interactive-mode.ts:5948](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5948 "private async handleEvent(event: AgentSessionEvent): Promise<void> {")

### 四个易混点

#### message_update 不是持久化

`message_update` 只在流式 assistant 生成期间出现。Agent 把它放进 `streamingMessage`，会话层只转发给扩展和公开订阅者，不写 JSONL。只有 `message_end` 的完整 `AssistantMessage` 才进入 `messages` 并保存。

因此：

- 看到 `message_update` 不代表这条消息已经完成；
- 看到 `message_update` 的文本也不代表模型最终会保留这段文本；
- JSON 模式还刻意去掉了累计快照，接收端必须按 `assistantMessageEvent` 的增量自行组装。

#### tool_execution_* 不是消息

`tool_execution_start` / `update` / `end` 描述工具生命周期；模型历史里真正存在的是 `ToolResultMessage`。它们通过不同的 `message_start` / `message_end` 发布和保存。

因此：

- 只监听工具事件，会看到进度和结果对象，但看不到模型实际消费的消息结构；
- 只监听消息事件，会看到 toolResult，但看不到执行进度；
- 二者用 `toolCallId` 关联，不要用到达顺序配对。

#### await emit 是背压，不是“所有人已显示”

Agent 等待 `processEvents`，`processEvents` 等待所有 Agent 订阅者；所以会话持久化和扩展处理会阻塞下一次模型请求。但 AgentSession 的公开 `_emit` 不等待 UI，JSON/RPC 的 stdout 背压监听是额外挂到低层 Agent 上的。结论：

- 背压保证的是本地处理链，不是远端用户已经看到；
- UI 慢可能让画面落后，但不会自动让会话文件落后；
- 如果自定义监听器做重活，应该自己排队或异步处理，不能假设会话会等你。

#### agent_end 不是 agent_settled

`agent_end` 是低层循环不再产生新事件，但会话层还可能在 `_startRun` 的循环里：

- 检查可重试错误并 `agent.continue()`；
- 检查压缩后恢复；
- 执行扩展的 settle 边界并要求继续；
- 冲刷待处理 bash/custom 消息。

这些都可能产生新的低层运行。只有 `_startRun` 的 `finally` 调用 `_emitAgentSettled()`，扩展和公开订阅者都收到 `agent_settled`，才表示整个会话运行收尾完成。`agent_settled` 期间提交的新 prompt 会被延迟到通知结束后，避免重入。

`agent_end` 的 `willRetry` 只是“预计是否重试”的提示，不是最终结论；判断空闲要等 `agent_settled`。

源码入口：

- [agent-session.ts:1824](../../../../../packages/coding-agent/src/core/agent-session.ts#L1824 "private async _emitAgentSettled(): Promise<void> {")
- [agent-session.ts:3205](../../../../../packages/coding-agent/src/core/agent-session.ts#L3205 "private async _startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void): Promise<void> {")
- [types.ts:647](../../../../../packages/agent/src/types.ts#L647 "export type AgentEvent =")
- [agent-session.ts:245](../../../../../packages/coding-agent/src/core/agent-session.ts#L245 "export type AgentSessionEvent =")

### 常见断点与观察方法

| 现象 | 先看 | 解释 |
| --- | --- | --- |
| TUI 有文字，会话文件没有 | `message_end` 保存时机、扩展替换 | 公开事件早于 append；异步 UI 可能提前读取 |
| 会话文件有消息，TUI 没显示 | 模式订阅、`handleEvent` | UI 监听器是 async 且不被会话 await，可能延迟或异常 |
| JSON 里 `message_update` 没有完整文本 | `toJsonEvent` | 传输版去掉了累计快照，只保留增量和 `usage` |
| 工具进度结束，模型历史没有结果 | 等 toolResult 的 `message_end` | 工具事件不是消息 |
| `agent_end` 后仍不能输入 | 等 `agent_settled` | 重试、压缩、扩展收尾可能继续运行 |
| 事件顺序和 TUI 显示不一致 | 公开 `_emit` 是同步派发、异步处理 | 监听器内部异步工作不受会话排序控制 |

观察方法：

- 用 `pi --mode json -p "..."` 逐行解析事件，先按 `type` 分类，再对照会话 JSONL。
- 在 `_handleAgentEvent`、`_emitExtensionEvent`、`_emit`、`appendMessage` 下断点，确认“扩展是否替换”“公开事件是否已经发出”“文件是否已经写入”三个不同时间点。
- 检查 `agent.state.streamingMessage`：它非空通常意味着还在流式阶段，不能当最终历史。
- 判断空闲不要看 `agent_end`，看 `agent_settled` 或 `waitForIdle` 的完成。

### 对应模块

- 低层事件和循环：[M02 事件](../02-agent-loop/README.md#m02-events)
- 会话事件、扩展与持久化：[M03 会话与上下文](../03-session-and-context/README.md#m03-store)
- TUI/JSON/RPC 消费：[M05 模式对比](../05-modes-and-tui/README.md#m05-compare)、[M05 打印模式](../05-modes-and-tui/README.md#m05-print)、[M05 RPC](../05-modes-and-tui/README.md#m05-rpc)
- 全链路收尾：[S13](../00-full-chain/README.md#m00-s13)
- 常见误解：[M05 常见误解](../05-modes-and-tui/README.md#m05-misread)

## 用四条追踪复习

不要按文件从头背。遇到一个现象，先判断它属于哪条追踪：

1. **表示层问题**：用户输入、模板展开、图片、`AgentMessage` 和线上 `Message` 是否被混为一谈？回到 T1。
2. **配对问题**：assistant 的 `toolCall.id` 和 toolResult 的 `toolCallId` 是否一致？失败是结果还是异常？回到 T2。
3. **可见性问题**：当前 leaf、最新压缩、`firstKeptEntryId`、`context_edit` 分别选中了什么？`Agent.messages` 和投影是否一致？回到 T3。
4. **时机问题**：你看到的是 `message_update`、`message_end`、`tool_execution_end`、`agent_end` 还是 `agent_settled`？它到底证明了什么？回到 T4。

一个实用的排障顺序：

```text
输入有没有变成 AgentMessage？
  -> 有没有产生模型请求？
  -> toolCall 有没有配对 toolResult？
  -> 当前投影到底包含哪些条目？
  -> 事件有没有落盘、会话有没有 settled？
```

四条追踪的交叉点：

- T1 的“下一轮”依赖 T3 的投影；T1 的 assistant 消息是 T2 的输入，也是 T4 的持久化对象。
- T2 的 toolResult 进入 T3 的历史，再由 T4 的 `message_end` 保存。
- T4 的 `message_end` 是 T1 落盘和 T2 结果落盘的共同入口；`agent_settled` 是整条链路的最终空闲信号。

## 继续阅读

- 按时间顺序走完整链路：[00 全链路](../00-full-chain/README.md)。
- 入口、参数、模式分派：[M01 入口与配置](../01-entry-and-config/README.md)。
- 循环、流式、工具管线：[M02 Agent 循环](../02-agent-loop/README.md)。
- 会话树、投影、压缩、编辑：[M03 会话与上下文](../03-session-and-context/README.md)。
- 模型路由、认证、供应商分发：[M04 模型访问](../04-model-access/README.md)。
- 打印、交互、RPC 的消费方式：[M05 模式与 TUI](../05-modes-and-tui/README.md)。
- 术语和排障入口：[GLOSSARY](../GLOSSARY.md)、[DEBUG_MAP](../DEBUG_MAP.md)。
