# M02 Agent 循环与工具执行

<a id="m02-outcomes"></a>
## 学完能回答

读完这一篇，应该能不用翻源码地回答下面这些问题；每题都指向本篇对应章节或源码位置。

1. 用户只问了一句，为什么 `agent.prompt()` 内部可能请求模型多次？`run`、`turn`、`request`、`event` 分别指什么，谁决定还要不要再请求一次？
2. 第一次请求和第二次请求之间，上下文多了哪些消息？模型为什么必须重新收到整段历史？
3. 工具在哪个事件之后才真正执行？工具不存在、参数不合法、钩子阻止时，是抛异常还是生成消息？
4. 并行执行工具时，结果按什么顺序交给模型？为什么不是按完成顺序？
5. 一个工具结果带 `terminate: true` 时，整批工具在什么条件下才会阻止下一次模型请求？
6. `stopReason` 为 `"length"` 时，为什么一个工具都不执行？
7. `agent_end` 为什么不是会话结束？之后还可能发生什么？
8. `beforeToolCall`、`afterToolCall`、`prepareNextTurn`、`prepareRequest`、`finishTurn` 分别插在循环的哪一步？

<a id="m02-duty"></a>
## 一句话职责

执行“请求模型 -> 模型要求工具 -> 执行工具 -> 把结果交回模型”的循环，直到模型不再调用工具；必要时再检查插话（steering）和追问（follow-up）队列。

<a id="m02-plain"></a>
## 大白话总览

很多人第一次读这段代码时会以为：`agent.prompt("读一下 README")` 就是“发一次请求，拿一段回答”。实际不是。模型一次只能返回一段消息，它没有能力自己打开文件。要完成“读文件再总结”，必须发生至少两次模型请求：

1. 第一次请求：把用户问题发给模型。模型回答“我要调用 read”，参数是 `path=README.md`。
2. 程序在本地执行 `read`，把文件内容变成一条工具结果消息。
3. 第二次请求：把“用户问题 + 模型上次的回答 + 文件内容”一起发给模型。模型这次才写出总结。

M02 就是负责把这三步串起来的那层。它的核心不是“调用模型”，而是决定什么时候再调用一次模型。

可以用一个更直白的类比：`Agent` 像包工头，模型像只会下指令的设计师，工具像仓库里的工人。

- 设计师说“给我 README 的内容”，包工头让工人去取。
- 工人把材料拿回来，包工头把材料连同设计师上一句话一起递回去。
- 设计师看到材料，才能继续画图。
- 只有设计师不再要材料，包工头才收工。

M02 不负责把对话写进 JSONL，不负责重试 429，也不负责上下文压缩。那些是 [M03 会话与上下文](../03-session-and-context/README.md) 的职责。M02 只负责一次低层运行内部的“模型 <-> 工具”往返。

<a id="m02-terms"></a>
## 关键概念：四个容易混的词

读循环代码前先把这四个词分开，否则后面会一直绕：

| 概念 | 含义 | 例子 |
| --- | --- | --- |
| run（运行） | 一次 `Agent.prompt()` 或 `Agent.continue()` 从开始到结束 | 用户问一句，内部请求两次模型，仍是一次 run |
| turn（回合） | 一次模型回答加上它要求的工具执行 | 第一次回答带 `read` 调用，执行完算一个 turn |
| request（请求） | 真正调用一次模型供应商 | 循环里 `streamAssistantResponse` 执行一次 |
| event（事件） | Agent 对外发布的进度通知 | `turn_start`、`message_update`、`tool_execution_end` |

一次 run 可以有多个 turn，一个 turn 通常对应一次 request，但一个 turn 里可能并行执行多个工具。**run 结束不等于模型回答了一次，而是循环判定没有后续了。**

<a id="m02-position"></a>
## 在链路中的位置

### 上游

- [M03 会话与上下文](../03-session-and-context/README.md)：`AgentSession._startRun()` 调用 `agent.prompt()`；会话还安装 `prepareRequest` / `prepareNextTurn` 回调。
- [M01 入口与装配](../01-entry-and-config/README.md)：SDK 构造 `Agent` 并注入 `streamFn`。

### 下游

- [M04 模型访问](../04-model-access/README.md)：`streamFn` 进入 `ModelRuntime.streamSimple()`。
- 工具实现：`read`、`bash`、`edit`、`write` 等；工具只是带 `execute` 的对象，循环不关心它内部做什么。

对应全链路：[S7](../00-full-chain/README.md#m00-s7) 到 [S11](../00-full-chain/README.md#m00-s11)。

<a id="m02-example"></a>
## 运行示例：一条消息怎样变成两次请求

输入：`读取 README.md 前 20 行并总结`

假设会话里此前没有历史。下面的表只看“模型这次请求能看到的消息”，省略 system 提示词。

**第一次请求前**，上下文是：

```text
[user] 读取 README.md 前 20 行并总结
```

第一次模型响应（简化）：

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "我先读取文件。" },
    { "type": "toolCall", "id": "call_1", "name": "read", "arguments": { "path": "README.md", "limit": 20 } }
  ],
  "stopReason": "toolUse"
}
```

循环看到 `toolCall`，执行 `read`，生成：

```json
{
  "role": "toolResult",
  "toolCallId": "call_1",
  "toolName": "read",
  "content": [{ "type": "text", "text": "1  # pi\n..." }],
  "isError": false
}
```

**第二次请求前**，上下文变成：

```text
[user]      读取 README.md 前 20 行并总结
[assistant] 我先读取文件。 + toolCall(call_1, read)
[toolResult] call_1 -> README 内容
```

第二次模型响应：

```json
{
  "role": "assistant",
  "content": [{ "type": "text", "text": "README 前 20 行主要介绍了..." }],
  "stopReason": "stop"
}
```

这次没有 `toolCall`，`hasMoreToolCalls` 为 `false`，也没有插话或追问，循环退出。一次 `Agent.prompt()` 返回，但内部发生了两次模型请求、一次工具执行、四条新消息：本次 user、带 `toolCall` 的 assistant、`toolResult`、最终 assistant。`newMessages` 包含本次运行新加入的历史，不只是模型回复。

关键点：**第二次请求不是把用户问题再发一遍，而是把“用户问题 + 第一次回答 + 工具结果”整段历史再发一遍。** 模型没有跨请求记忆，它靠这段历史理解上下文。

<a id="m02-files"></a>
## 文件路由

| 文件 | 职责 |
| --- | --- |
| [agent.ts](../../../../../packages/agent/src/agent.ts "agent.ts") | 对外 `Agent` 类：消息状态、`prompt` / `continue`、队列、生命周期 |
| [agent-loop.ts](../../../../../packages/agent/src/agent-loop.ts "agent-loop.ts") | 无状态循环实现：请求模型、执行工具、发事件 |
| [types.ts](../../../../../packages/agent/src/types.ts "types.ts") | `AgentMessage`、`AgentEvent`、`AgentTool`、`StreamFn` 等类型 |
| [core/tools/read.ts](../../../../../packages/coding-agent/src/core/tools/read.ts "read.ts") | `read` 工具的实现 |
| [core/tools/bash.ts](../../../../../packages/coding-agent/src/core/tools/bash.ts "bash.ts") | shell 工具的通用实现 |
| [core/tools/edit.ts](../../../../../packages/coding-agent/src/core/tools/edit.ts "edit.ts") | 文件编辑工具 |
| [core/tools/write.ts](../../../../../packages/coding-agent/src/core/tools/write.ts "write.ts") | 文件写入工具 |
| [core/extensions/runner.ts](../../../../../packages/coding-agent/src/core/extensions/runner.ts "runner.ts") | 扩展钩子如何插入工具准备/收尾 |

这两个文件的边界值得记住：

- `agent.ts` 有状态。它持有消息数组、工具列表、队列、当前运行和取消控制器。
- `agent-loop.ts` 基本无状态。它接收上下文、配置、事件函数，执行完就返回；不直接写会话文件。

所以同一个 `Agent` 可以连续调用多次循环，而循环本身不累积状态。状态归 `Agent`，持久化归 `AgentSession`，请求归 `ModelRuntime`。

<a id="m02-routes"></a>
## 函数路由

### Agent 入口与生命周期

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M02.agent.prompt` | `Agent.prompt` | [agent.ts:668](../../../../../packages/agent/src/agent.ts#L668 "async prompt(input: string") | 新输入的统一入口 |
| `M02.agent.continue` | `Agent.continue` | [agent.ts:688](../../../../../packages/agent/src/agent.ts#L688 "async continue(") | 不追加新问题，从现有历史继续 |
| `M02.agent.normalize` | `normalizePromptInput` | [agent.ts:738](../../../../../packages/agent/src/agent.ts#L738 "normalizePromptInput(") | 字符串/单消息/数组归一化为消息数组 |
| `M02.agent.runPromptMessages` | `runPromptMessages` | [agent.ts:773](../../../../../packages/agent/src/agent.ts#L773 "runPromptMessages(") | 包生命周期并调用循环 |
| `M02.agent.runContinuation` | `runContinuation` | [agent.ts:801](../../../../../packages/agent/src/agent.ts#L801 "runContinuation(") | 直接续跑已有上下文 |
| `M02.agent.snapshot` | `createContextSnapshot` | [agent.ts:824](../../../../../packages/agent/src/agent.ts#L824 "createContextSnapshot(") | 复制消息与工具数组，形成运行起点 |
| `M02.agent.loopConfig` | `createLoopConfig` | [agent.ts:839](../../../../../packages/agent/src/agent.ts#L839 "createLoopConfig(") | 把 Agent 状态与队列适配成循环配置 |
| `M02.agent.lifecycle` | `runWithLifecycle` | [agent.ts:918](../../../../../packages/agent/src/agent.ts#L918 "runWithLifecycle(") | 取消信号、活动运行状态、异常收尾 |
| `M02.agent.failure` | `handleRunFailure` | [agent.ts:963](../../../../../packages/agent/src/agent.ts#L963 "handleRunFailure(") | 把异常变成 `stopReason: error/aborted` 的 assistant 消息 |
| `M02.agent.finish` | `finishRun` | [agent.ts:1001](../../../../../packages/agent/src/agent.ts#L1001 "finishRun(") | 清忙碌状态、唤醒 idle 等待者 |

### 循环

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M02.loop.entry` | `runAgentLoop` | [agent-loop.ts:168](../../../../../packages/agent/src/agent-loop.ts#L168 "runAgentLoop(") | 带新输入的入口 |
| `M02.loop.continue` | `runAgentLoopContinue` | [agent-loop.ts:217](../../../../../packages/agent/src/agent-loop.ts#L217 "runAgentLoopContinue(") | 从已有历史续跑 |
| `M02.loop.run` | `runLoop` | [agent-loop.ts:281](../../../../../packages/agent/src/agent-loop.ts#L281 "runLoop(") | 两层循环：工具 + 追问 |
| `M02.loop.declareTools` | `declareToolChanges` | [agent-loop.ts:559](../../../../../packages/agent/src/agent-loop.ts#L559 "declareToolChanges(") | 把工具增减写成 system 差分消息 |
| `M02.loop.stream` | `streamAssistantResponse` | [agent-loop.ts:645](../../../../../packages/agent/src/agent-loop.ts#L645 "streamAssistantResponse(") | 转消息、调模型、消费流事件 |
| `M02.loop.streamFunction` | `streamFunction` | [agent-loop.ts:680](../../../../../packages/agent/src/agent-loop.ts#L680 "await streamFunction(") | 注入的模型函数调用点 |

### 工具管线

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M02.loop.tools` | `executeToolCalls` | [agent-loop.ts:863](../../../../../packages/agent/src/agent-loop.ts#L863 "executeToolCalls(") | 选择串行/并行并调度整批工具 |
| `M02.loop.sequential` | `executeToolCallsSequential` | [agent-loop.ts:904](../../../../../packages/agent/src/agent-loop.ts#L904 "executeToolCallsSequential(") | 逐个执行，前一个收尾后再下一个 |
| `M02.loop.parallel` | `executeToolCallsParallel` | [agent-loop.ts:1005](../../../../../packages/agent/src/agent-loop.ts#L1005 "executeToolCallsParallel(") | 先检查再并发，按原顺序收集结果 |
| `M02.loop.prepare` | `prepareToolCall` | [agent-loop.ts:1223](../../../../../packages/agent/src/agent-loop.ts#L1223 "prepareToolCall(") | 查工具、校验参数、跑前置钩子 |
| `M02.loop.toolCall` | `runToolCall` | [agent-loop.ts:1396](../../../../../packages/agent/src/agent-loop.ts#L1396 "export async function runToolCall(") | 程序化/嵌套调用的完整管线入口；不在 `executeToolCalls` 批处理里 |
| `M02.loop.toolExecute` | `tool.execute` | [agent-loop.ts:1438](../../../../../packages/agent/src/agent-loop.ts#L1438 "prepared.tool.execute(") | 真正进入工具实现 |
| `M02.loop.finalize` | `finalizeExecutedToolCall` | [agent-loop.ts:1490](../../../../../packages/agent/src/agent-loop.ts#L1490 "finalizeExecutedToolCall(") | 后置钩子、结果合并、时机统计 |
| `M02.loop.resultMessage` | `createToolResultMessage` | [agent-loop.ts:1623](../../../../../packages/agent/src/agent-loop.ts#L1623 "createToolResultMessage(") | 把执行结果变成 `role: toolResult` 消息 |
| `M02.loop.truncated` | `failToolCallsFromTruncatedMessage` | [agent-loop.ts:809](../../../../../packages/agent/src/agent-loop.ts#L809 "failToolCallsFromTruncatedMessage(") | 输出被截断时不执行半截参数 |

### 内置工具

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M02.tool.read` | `read.execute` | [read.ts:167](../../../../../packages/coding-agent/src/core/tools/read.ts#L167 "async execute(") | 读文件、分页、图片 |
| `M02.tool.bash` | `bash.execute` | [bash.ts:461](../../../../../packages/coding-agent/src/core/tools/bash.ts#L461 "async execute(") | 启动 shell、流式输出、退出码 |

<a id="m02-walk-prompt"></a>
## 函数拆解一：Agent.prompt 到 runWithLifecycle

[Agent.prompt:668](../../../../../packages/agent/src/agent.ts#L668 "async prompt(input: string") 做四件事，顺序不能换：

1. 检查 `this.activeRun`。已经有运行在改历史时，直接抛错，要求调用方改用 `steer()` / `followUp()`。这个检查不是可选的防御代码，而是保证同一个消息数组不会被两个异步循环同时 `push`。
2. 调用 `normalizePromptInput`。它把三种合法输入统一成 `AgentMessage[]`：
   - 数组：原样返回，因为会话层经常一次传入“system 补丁 + 用户消息”。
   - 单条消息：包成数组。
   - 字符串：变成 `{ role: "user", content: [{ type: "text", text }], timestamp }`，有图片就追加图片块。
3. 调用 `runPromptMessages(messages)`。从这里开始进入“运行”生命周期。
4. 等到整个循环结束才返回，返回类型是 `Promise<void>`。回答不通过返回值给调用方，而是通过 `state.messages` 和事件给。

接着看 [runPromptMessages:773](../../../../../packages/agent/src/agent.ts#L773 "runPromptMessages(")。它只做一层包装：

```ts
await this.runWithLifecycle(async (signal) => {
  await runAgentLoop(
    messages,
    this.createContextSnapshot(),
    this.createLoopConfig(),
    (event) => this.processEvents(event),
    signal,
    this.streamFunction,
  );
});
```

三个子函数各管一件事：

- [createContextSnapshot:824](../../../../../packages/agent/src/agent.ts#L824 "createContextSnapshot(")：用 `slice()` 复制 `messages` 和 `tools` 两个顶层数组。消息对象和工具对象本身不复制。这样循环里 `currentContext.messages.push(...)` 不会直接改到 `Agent._state.messages` 这个数组；但循环通过事件把新消息写回 Agent 状态。
- [createLoopConfig:839](../../../../../packages/agent/src/agent.ts#L839 "createLoopConfig(")：把模型、思考级别、钩子、队列读取函数打包给循环。这里有一个容易忽略的细节：`reasoning: "off"` 被转成 `undefined`，因为下游用 `undefined` 表示“不传思考参数”，而字符串 `"off"` 不是同一个意思。
- `processEvents`：循环每产生一个事件，先更新 Agent 自己的状态，再通知订阅者并等待它们完成。`streamAssistantResponse` 里所有 `emit(...)` 都是 `await` 的，所以会话层保存消息是串行发生，不会出现“下一次请求已经发出，上一条工具结果还没落盘”。

[runWithLifecycle:918](../../../../../packages/agent/src/agent.ts#L918 "runWithLifecycle(") 是错误和取消的统一出口：

1. 再检查一次 `activeRun`，防止绕过 `prompt()` 的内部调用路径并发进入。
2. 创建 `AbortController`，把 `signal` 传给循环；`agent.abort()` 最终就是调它的 `abort()`。
3. 创建 `activeRun = { promise, resolve, abortController }`，并把 `state.isStreaming = true`。注意：工具执行期间也算 streaming，不是只有文字在流式输出时才算忙。
4. 执行 `executor(signal)`。如果循环直接抛异常（不是模型返回错误消息，而是代码异常），进入 `handleRunFailure`。
5. 无论成功、失败、取消，`finally` 都调用 `finishRun()`：清 `isStreaming`、清流式草稿、清 `pendingToolCalls`、resolve idle Promise、清 `activeRun`。

[handleRunFailure:963](../../../../../packages/agent/src/agent.ts#L963 "handleRunFailure(") 的设计值得单独说。它不把异常直接抛给调用方，而是伪造一条 assistant 消息：

```json
{
  "role": "assistant",
  "content": [{ "type": "text", "text": "" }],
  "stopReason": "aborted",
  "errorMessage": "The operation was aborted",
  "usage": { ... 全零 ... }
}
```

然后依次发 `message_start`、`message_end`、`turn_end`、`agent_end`。这样无论成功还是失败，订阅者看到的事件序列形状一致，会话层也能把失败消息写进历史。区别只在 `stopReason` 和 `errorMessage`。

这也解释了一个常见疑问：为什么用户取消后，历史里会多一条空 assistant 消息？因为取消需要有一个可观察的终点，而不是让循环凭空消失。

<a id="m02-walk-continue"></a>
## 函数拆解二：Agent.continue 与队列

[Agent.continue:688](../../../../../packages/agent/src/agent.ts#L688 "async continue(") 用在“不再追加新用户问题，但从现有历史继续”的场景，例如重试、压缩后恢复、扩展要求续跑。

它的分支顺序是：

1. 有 `activeRun` 就拒绝。
2. 历史为空，或者只有 system 消息，拒绝：没有可回答的输入。
3. 最后一条是 assistant：
   - 先 `steeringQueue.drain()`。有插话，就带着插话跑一次新循环，并传 `skipInitialSteeringPoll: true`，因为这条插话已经在 `continue()` 里取过了，循环开始时不能再取一次。
   - 没有插话，再 `followUpQueue.drain()`。有追问，就带着追问跑。
   - 两个队列都空，抛 `Cannot continue from message role: assistant`。不能对一条已经完成的 assistant 回答无条件再请求一次，否则模型会重复上一轮。
4. 最后一条是 user、toolResult 等：调用 `runContinuation()`，直接把当前历史交给 `runAgentLoopContinue`，不追加任何消息。

`skipInitialSteeringPoll` 是一次性布尔量，定义在 `createLoopConfig` 的闭包里。第一次 `getSteeringMessages()` 返回空并把它置回 false，之后恢复正常读取。这个机制解决的是“一条插话被消费两次”的竞态，不是普通的开关选项。

<a id="m02-walk-entries"></a>
## 函数拆解三：runAgentLoop 与 runAgentLoopContinue

[runAgentLoop:168](../../../../../packages/agent/src/agent-loop.ts#L168 "runAgentLoop(") 是“带新输入”的入口，`runAgentLoopContinue:217` 是“只从已有历史继续”的入口。两者最终都调用 `runLoop`，区别只在开头：

- `runAgentLoop(prompts, context, config, ...)` 先对本次新消息调用 `declareToolChanges`，可能插入一条工具声明 system 消息；再把“旧历史 + 新消息”拼成 `currentContext`。然后依次发 `agent_start`、`turn_start`，逐条发布新消息的 `message_start` / `message_end`，最后进入 `runLoop`。
- `runAgentLoopContinue(context, config, ...)` 不追加消息。它检查上下文非空、最后一条不是 assistant，因为对一条已完成的 assistant 回答再请求一次只会得到重复内容；然后发 `agent_start`、`turn_start`，直接进入 `runLoop`。

`runAgentLoop` 的初始消息发布顺序很重要：先发 `agent_start`、`turn_start`，再逐条发新消息的 `message_start` / `message_end`，所以订阅者看到用户消息时，回合已经开始。`runAgentLoopContinue` 没有初始消息可发，它进入 `runLoop` 后，第一批“待发消息”可能来自插话或 `prepareNextTurn`。

两者都返回本次新增消息数组；`Agent.runPromptMessages` 不直接使用返回值，因为消息已经通过事件写回 `Agent.state`。

<a id="m02-walk-loop"></a>
## 函数拆解四：runLoop 的两层循环

[runLoop:281](../../../../../packages/agent/src/agent-loop.ts#L281 "runLoop(") 是整个模块的核心。它维护四个可变状态：

| 变量 | 作用 |
| --- | --- |
| `currentContext` | 当前模型请求能看到的历史和工具；可被 `prepareNextTurn` / `prepareRequest` 替换 |
| `config` | 当前模型、思考级别和钩子；同样可在请求边界更新 |
| `lastCompletedTurn` | 上一回合的 `{ message, toolResults, context, newMessages }`，供下一回合准备回调使用 |
| `explicitContinuation` | 扩展是否明确要求“即使没有工具、没有队列消息，也再走一轮” |

外层 `while (true)` 管“自然停止后的追问”，内层 `while (hasMoreToolCalls || pendingMessages.length > 0)` 管“工具和插话”。把两层分开的原因是：追问必须等当前任务真的停下来才能处理，而插话可以在工具批次结束后立刻插入。

一次内层迭代的顺序：

1. 如果 `lastCompletedTurn` 存在，调用 `prepareNextTurn`。会话层在这里刷新 system 提示词、重新声明工具，并对普通物理模型做阈值压缩；虚拟模型要等 `prepareRequest` 路由到具体物理模型后再检查。它可能替换 `currentContext`、`config.model`、`config.reasoning`，并返回 `preparedMessages`。
2. 如果 `lastCompletedTurn` 存在，在准备钩子之后发 `turn_start`。第一轮的 `turn_start` 已经由 `runAgentLoop` / `runAgentLoopContinue` 在进入循环前发过，所以这里不再重复。
3. 把 `preparedMessages` 和 `pendingMessages` 合并，交给 [declareToolChanges:559](../../../../../packages/agent/src/agent-loop.ts#L559 "declareToolChanges(")。这个函数比较“历史里已经声明的工具”和“当前 `context.tools` 真能执行的工具”，生成 `toolsAdded` / `toolsRemoved`，写进 system 消息。模型只能看到工具声明，看不到本地 `execute` 函数，所以工具增减必须通过消息告诉它。
4. 对每条待发消息依次 `message_start` -> `message_end` -> `currentContext.messages.push(message)` -> `newMessages.push(message)`。工具结果、插话、system 补丁都走这一条路径，没有特殊旁路。
5. 调用 `prepareRequest`。会话层在这里从 SessionManager 重新投影上下文；虚拟模型在这里完成路由，并按路由后的物理模型容量补做阈值压缩（普通模型的阈值压缩已在第 1 步的 `prepareNextTurn` 检查）。它返回的新 `context` / `model` / `thinkingLevel` 会覆盖当前值。
6. 调用 [streamAssistantResponse:645](../../../../../packages/agent/src/agent-loop.ts#L645 "streamAssistantResponse(")，拿到一条完整 assistant 消息。
7. 如果 `stopReason` 是 `"error"` 或 `"aborted"`：构造 `lastCompletedTurn`，调用 `finishTurn`，发 `turn_end`、`agent_end`，直接 `return`。注意这里没有工具结果。
8. 从 assistant 的 `content` 里筛出 `type === "toolCall"` 的块。没有就跳过工具分支。
9. 有工具调用时：
   - `stopReason === "length"`：输出被 token 上限截断，工具参数可能只写了一半。调用 [failToolCallsFromTruncatedMessage:809](../../../../../packages/agent/src/agent-loop.ts#L809 "failToolCallsFromTruncatedMessage(")，为每个调用生成 `isError: true` 的结果，一个都不执行。
   - 否则调用 `executeToolCalls`。整批结果放进 `toolResults`，逐条 push 进 `currentContext.messages` 和 `newMessages`。
   - `hasMoreToolCalls = !executedToolBatch.terminate`。默认继续；如果某个工具显式要求终止，才停止。
10. 构造 `lastCompletedTurn`，调用 `finishTurn`。返回 `{ action: "end" }` 就发 `agent_end` 并返回；返回 `{ action: "continue" }` 只设置 `explicitContinuation`。
11. 再读一次插话队列。如果 `hasMoreToolCalls` 或 `pendingMessages` 非空，内层继续，同时把 `explicitContinuation` 清掉，避免为同一个继续请求多跑一轮。
12. 内层结束后，读 follow-up 队列。有追问就设成 `pendingMessages` 并 `continue` 外层。
13. 没有追问但有 `explicitContinuation`，再走一轮“只有上下文、没有新消息”的请求。
14. 都没有，`break` 外层，发 `agent_end`。

`finishTurn` 的 `continue` 和 `agent.continue()` 不是一回事：前者是循环内部的“再走一轮”，后者是外部再次启动一次 run。循环内处理可以复用 `currentContext` 和 `config`，不必重新准备输入。

<a id="m02-walk-stream"></a>
## 函数拆解五：streamAssistantResponse 如何把流拼成一条消息

[streamAssistantResponse:645](../../../../../packages/agent/src/agent-loop.ts#L645 "streamAssistantResponse(") 是 Agent 消息和供应商消息之间的边界。它按固定顺序做六件事：

1. `transformContext(messages, signal)`：可选，扩展可以在这里过滤或改写上下文。
2. `convertToLlm(messages)`：把 coding-agent 的 `custom` 等消息转换成供应商能接受的 `Message`。例如扩展注入的上下文可能被转成 user 消息。
3. `normalizeContext({ messages: llmMessages })`：规范化出供应商函数接受的 `{ messages }`。它只在调用方传入顶层 `systemPrompt` / `tools` 时，把二者折成首条 system 消息；这里没有传，因为 system 提示词和工具声明已经由 `declareToolChanges` 写在消息数组里。它不合并角色，也不转换图片。
4. 解析 API key：先 `getApiKey(provider)`，没有再用 `config.apiKey`。每次请求都解析，因为 OAuth token 可能过期。
5. 调用 `streamFunction(model, llmContext, { ...config, apiKey, identity, signal })`。生产环境里这个函数来自 `sdk.ts`，最终进入 `ModelRuntime.streamSimple()`；测试里可以注入 faux provider。
6. 消费返回的异步流。

流事件的处理分三类：

- `start`：拿到 `event.partial`，把它 push 进 `context.messages`，记 `addedPartial = true`，发 `message_start`。这条草稿从此占据历史里的一个位置。
- `text_*` / `thinking_*` / `toolcall_*`：用 `event.partial` 替换最后一个历史元素（不是追加），然后发 `message_update`。所以无论收到多少个 delta，历史里始终只有一条 assistant 消息。
- `done` / `error`：调用 `result()` 等最终消息。`result()` 是 `Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" })`，把本次请求的思考级别记到消息上。有草稿就替换，没有就 push；没有发过 `message_start` 的路径补发一次；最后发 `message_end` 并返回。

`done` 和 `error` 都会返回一条 `AssistantMessage`。供应商错误不是抛异常，而是 `stopReason: "error"` 的消息；用户取消是 `"aborted"`。这两种由 `runLoop` 识别后结束低层运行，交给会话层决定是否重试。

工具调用参数在流式期间可能还是不完整 JSON。`toolcall_delta` 只更新展示，不执行工具；真正的参数校验和执发生在 `message_end` 之后的工具管线里。

<a id="m02-walk-tools"></a>
## 函数拆解六：executeToolCalls 的串行与并行

[executeToolCalls:863](../../../../../packages/agent/src/agent-loop.ts#L863 "executeToolCalls(") 先做一个整批决策：

```ts
const sequential =
  config.toolExecution === "sequential" ||
  toolCalls.some((call) => findTool(call.name)?.executionMode === "sequential");
```

只要全局配置要求串行，或者这批里任意一个工具声明 `executionMode: "sequential"`，整批都走串行。为什么不是“每个工具自己决定”？因为工具有依赖时，顺序必须由批次统一保证。例如 `edit` 可能声明串行，如果它前面的 `read` 被并行执行，`edit` 仍可能读到旧内容。整批串行是最保守也最容易推理的选择。

[executeToolCallsSequential:904](../../../../../packages/agent/src/agent-loop.ts#L904 "executeToolCallsSequential(") 对每个调用依次做：

1. 发 `tool_execution_start`。
2. `prepareToolCall`：找工具、解析参数、校验、跑 `beforeToolCall`。
3. 如果准备阶段已经得到“立即结果”（工具不存在、参数错误、被钩子阻止），直接发 `tool_execution_end`，不执行 `execute`。
4. 否则 `executePreparedToolCall` -> `finalizeExecutedToolCall` -> 发 `tool_execution_end`。
5. 把最终结果包装成 `toolResult` 消息，收集起来。
6. 每个调用之间检查 `signal.aborted`；已经取消就不再调度后续调用。

[executeToolCallsParallel:1005](../../../../../packages/agent/src/agent-loop.ts#L1005 "executeToolCallsParallel(") 的顺序不同：

1. 先按模型给出的顺序逐个 `prepareToolCall`。这一步是串行的，因为参数校验和前置钩子可能有顺序依赖。
2. 准备阶段就失败的调用立即发事件、生成结果。
3. 准备成功的调用被包成异步 thunk，放进数组。
4. `Promise.all(thunks)` 并发执行。
5. 结果按**原始调用顺序**放回数组，不是按完成顺序。这样 `toolResult` 和 `toolCall` 的 id 配对稳定，模型看到的顺序和它发出的顺序一致。
6. 如果执行前已经取消，为**已经安排进本批**、但还没开始的调用生成 `Operation aborted` 错误结果，而不是让它们静默消失。取消若发生在准备循环中，循环会停止安排后续调用；那些调用不会进入本批结果。

并行只并行 `execute`，不并行“准备”。这个拆分很重要：准备阶段要改共享状态（例如激活工具、记录调用），执行阶段才是真正的 I/O。

整批是否终止也有明确规则：只有批次非空，且**每一个**结果都带 `terminate: true`，`executedToolBatch.terminate` 才为 true。空批次不算终止，`[true, undefined]` 也不算。这样单个工具不能替其他工具做决定，避免一次误标导致后续工具结果丢失。

<a id="m02-walk-prepare"></a>
## 函数拆解七：prepareToolCall 的四个检查

[prepareToolCall:1223](../../../../../packages/agent/src/agent-loop.ts#L1223 "prepareToolCall(") 返回两种结果之一：

- `{ kind: "immediate", result, isError }`：不用执行 `execute`，直接把结果交给模型。
- `{ kind: "prepared", tool, args, toolCall }`：可以进入执行阶段。

它按顺序检查：

1. **工具是否存在**。在 `tools` 数组里按名字查找，找不到就立即返回 `Tool <name> not found`。模型可能幻觉出一个不存在的工具，这里必须变成错误结果，而不是抛异常。
2. **参数能否适配**。`prepareToolCallArguments` 只调用工具可选的 `tool.prepareArguments`；它不解析模型返回的 JSON。JSON 解析失败由 provider 记在 `argumentsError`，随后在 schema 校验时被拒绝。
3. **参数是否符合 schema**。`validateToolArguments` 校验必填字段、类型、枚举等。校验失败返回可读的错误说明，模型可以据此修正。
4. **前置钩子是否允许**。`beforeToolCall` 返回 `{ block: true, reason }` 时阻止调用，结果变成错误 `toolResult`，不是异常。阻止结果还可以带 `terminate: true`，但只有整批每个最终结果都带它时才会停止自动续轮；非阻止的结果不会带 `terminate`。这个钩子不能改写参数，参数适配只由工具自己的 `prepareArguments` 完成。

任何一步抛异常，都会被 `catch` 转成错误结果。所以工具管线对模型是“永远有结果”，对调用方是“永远不因单个工具失败而炸掉整个循环”。

<a id="m02-walk-execute"></a>
## 函数拆解八：executePreparedToolCall 与 finalizeExecutedToolCall

[executePreparedToolCall:1417](../../../../../packages/agent/src/agent-loop.ts#L1417 "executePreparedToolCall(") 只负责“真正调用工具并计时”：

1. 记录开始时间。
2. 调用 `prepared.tool.execute(id, args, signal, onUpdate)`。第四个参数是进度回调，工具可以通过它发 `tool_execution_update`。
3. 等待工具返回，计算 `durationMs`。
4. 如果工具抛异常，转成 `isError: true` 的结果，错误文字放进 content。异常不会穿出这个函数。
5. `finally` 里停止接受后续 update，避免工具结束后还有迟到的进度事件。

[finalizeExecutedToolCall:1490](../../../../../packages/agent/src/agent-loop.ts#L1490 "finalizeExecutedToolCall(") 在工具返回之后、消息包装之前运行，主要处理 `afterToolCall` 钩子：

- 钩子可以改 `content`、`details`、`usage`、`terminate`，也可以把 `isError` 从 true 改成 false 或反过来。
- 如果钩子只改了 `content` 却没给新的 `structuredContent`，旧的 `structuredContent` 会被删除。原因是结构化内容必须和模型看到的内容一致；保留旧结构会产生自相矛盾的结果。
- 钩子自己抛异常时，整个结果变成 `isError: true`，错误文字是钩子的异常信息。这比让钩子异常穿透循环更安全。
- `durationMs` 只记录真实工具执行时间，不把后置钩子的耗时算进去。

最后 [createToolResultMessage:1623](../../../../../packages/agent/src/agent-loop.ts#L1623 "createToolResultMessage(") 把结果包装成历史消息：

```json
{
  "role": "toolResult",
  "toolCallId": "call_1",
  "toolName": "read",
  "content": [{ "type": "text", "text": "..." }],
  "details": {},
  "isError": false,
  "timestamp": 1730000000000
}
```

`toolCallId` 是配对的唯一依据。模型下一轮请求看到 `toolResult` 时，靠这个 id 知道它对应自己哪一次调用。如果 id 丢了或重复，模型无法正确关联。

<a id="m02-events"></a>
## 事件序列

一次带工具调用的运行，事件大致是：

```
agent_start
turn_start
message_start(user)
message_end(user)
message_start(assistant 草稿)
message_update(delta) ...
message_end(assistant, toolCall)
tool_execution_start(call_1)
tool_execution_update(progress) ...
tool_execution_end(call_1)
message_start(toolResult)
message_end(toolResult)
turn_end(assistant, toolResults)
turn_start
message_start(assistant 草稿)
message_update(delta) ...
message_end(assistant, 最终文本)
turn_end(assistant, [])
agent_end
```

`message_start` / `message_end` 是完整消息的边界；`message_update` 是流式增量。`tool_execution_*` 是工具生命周期，不是消息。会话层只在 `message_end` 落盘，所以 UI 看到很多 `message_update`，JSONL 里只有四条消息。

事件的 `await` 语义也值得注意：`emit` 返回 Promise，循环会等它完成再继续。这意味着：

- `Agent.processEvents` 按订阅顺序 `await` 每个监听器；会话层的 `_handleAgentEvent` 就是其中一个，所以持久化完成前循环不会请求下一次。
- 这些监听器处理慢会拖慢循环，这是有意的背压，不是 bug。注意范围：这里指 `Agent.subscribe` 的监听器；`AgentSession` 再转发给 UI 的公开监听器是同步调用、不 `await`，不会阻塞循环。
- 如果 Agent 监听器抛异常，异常会传回循环，最终由 `runWithLifecycle` 转成失败消息。

<a id="m02-data"></a>
## 数据变化：历史数组在每个阶段长什么样

用上面的读文件例子，`newMessages` 和 `currentContext.messages` 的变化是：

| 阶段 | `currentContext.messages` 新增 | `newMessages` 新增 |
| --- | --- | --- |
| `runAgentLoop` 发布初始用户消息 | `user` | `user` |
| 第一次 `streamAssistantResponse` | `assistant(toolCall)` | `assistant(toolCall)` |
| `executeToolCalls` 完成 | `toolResult(call_1)` | `toolResult(call_1)` |
| 第二次 `streamAssistantResponse` | `assistant(text)` | `assistant(text)` |

`agent_end` 的 `messages` 是 `newMessages`，只包含本次 run 新增的消息，不是完整历史。完整历史在 `Agent.state.messages` 和会话投影里。这两个概念经常被混在一起：

- `newMessages`：本次运行产生了什么，用于事件和增量统计。
- `state.messages`：Agent 当前持有的完整历史，下一次 `prompt` 的快照来源。
- 会话投影：从 JSONL 树重放出来的模型上下文，可能已经过压缩和编辑。

<a id="m02-hooks"></a>
## 扩展钩子插在哪

| 钩子 | 调用位置 | 能做什么 |
| --- | --- | --- |
| `beforeToolCall` | `prepareToolCall` | 阻止调用并附原因；可在阻止时要求本批结束后终止 |
| `afterToolCall` | `finalizeExecutedToolCall` | 改写结果、附加内容、调整错误标志 |
| `prepareNextTurn` | `runLoop` 每回合开始前 | 压缩上下文、刷新工具和 system 提示词 |
| `prepareRequest` | 每次模型请求前 | 从会话投影重建上下文、虚拟模型路由 |
| `finishTurn` | 每回合工具执行后 | 返回 `end` 或 `continue`，决定是否再走一轮 |

这些钩子让扩展不需要修改循环本身。代价是循环的正确性依赖钩子的契约：例如 `prepareRequest` 返回的 context 必须仍然满足消息配对规则，`afterToolCall` 不能返回与 content 冲突的结构化内容。

<a id="m02-design"></a>
## 关键设计

### 1. 为什么是两层循环

内层处理“模型要求工具”：

```
while (hasMoreToolCalls || pendingMessages.length > 0) { ... }
```

外层处理“模型已经给出最终回答，但用户又排了追问”：

```
while (true) {
  inner loop
  followUps = getFollowUpMessages()
  if (followUps) { pendingMessages = followUps; continue; }
  break;
}
```

插话（steering）在当前工具批次结束后、下一次模型请求前插入；追问（follow-up）在模型本来要停止时插入。两者都不是“再调用一次 `prompt()`”，所以不会重复追加用户问题。

### 2. 流式草稿只占一个历史位置

`streamAssistantResponse` 收到 `start` 时把草稿放进 `context.messages`；之后每个 delta 都替换最后一个元素；`done` 时用最终消息替换草稿。这样 UI 可以逐字渲染，而 Agent 历史不会变成几百条片段。

### 3. 工具结果永远是消息

工具失败、工具不存在、参数不合法、输出被截断，最终都会变成 `isError: true` 的 `toolResult` 消息。模型看到错误后可以修正参数或换工具。只有供应商错误和用户取消会让 `stopReason` 变成 `error` / `aborted`，从而结束低层循环。

例外：如果 assistant 消息因为 token 上限被截断（`stopReason === "length"`），工具参数可能只写了一半，这时不执行任何调用，直接为每个调用生成失败结果。

### 4. 串行与并行

默认并行：先按模型给出的顺序做查找、校验和前置钩子，再并发执行，最后按原始顺序收集结果。只要全局配置要求串行，或任意一个工具声明 `executionMode: "sequential"`，整批就走串行。

整批串行不是“每个工具自己决定”，因为工具有依赖时，顺序必须由批次统一保证。

### 5. 扩展钩子插在哪

- `beforeToolCall`：在 `prepareToolCall` 里，可以阻止调用、给出阻止原因；阻止时可附带本批终止要求。它不改写参数。
- `afterToolCall`：在 `finalizeExecutedToolCall` 里，可以改写结果或附加内容。
- `prepareNextTurn` / `prepareRequest`：由 `AgentSession` 安装，分别在一轮结束和每次模型请求前刷新上下文、模型、工具。
- `finishTurn`：一轮结束后，扩展可以要求 `end` 或 `continue`。

这些钩子让扩展不需要修改循环本身。

### 6. 为什么 `agent_end` 不是结束

`agent_end` 只表示低层循环不再产生事件。之后 `AgentSession` 还可能：

- 等待后重试可重试错误；
- 压缩上下文并恢复失败请求；
- 消费 `agent_end` 回调新排入的消息；
- 执行 `agent_before_settle` 扩展边界。

真正的结束信号是 `agent_settled`。

<a id="m02-selfcheck"></a>
## 自测

先自己回答，再对照下面的答案。答案只给结论和源码位置，推理过程在本篇对应章节。

### 1. 为什么一次 `agent.prompt()` 可能请求模型多次？

用户消息只是循环的起点。`runLoop` 每请求一次模型，就检查返回的 assistant 消息里有没有 `toolCall` 块；有就执行工具，把 `toolResult` 放回上下文，然后让内层循环继续，下一次请求自然带着完整历史。没有工具、没有排队消息、`finishTurn` 也不要求继续时，循环才退出。入口见 [runLoop:281](../../../../../packages/agent/src/agent-loop.ts#L281 "runLoop(")。

### 2. `run`、`turn`、`request`、`event` 的区别是什么？

`run` 是一次 `Agent.prompt()` / `Agent.continue()`；`turn` 是一次 assistant 回答加上它要求的工具执行；`request` 是一次真正的模型调用；`event` 是循环对外发布的进度通知。一次 run 可以有多个 turn，一个 turn 通常对应一次 request，但可以并行执行多个工具。见 [关键概念](#m02-terms)。

### 3. 第二次请求前，上下文多了哪两条消息？

多了 `assistant(toolCall)` 和 `toolResult`。第二次请求发送的是“原 user 消息 + 第一次 assistant 回答 + 工具结果”，不是只发工具结果，也不是重发用户问题。模型没有跨请求记忆，只能靠这段历史理解上下文。见 [运行示例](#m02-example)。

### 4. 工具在哪个事件之后执行？失败会抛异常吗？

工具在 assistant 的 `message_end` 之后、由 `runLoop` 从 `content` 中筛出 `toolCall` 再调度。工具不存在、参数解析失败、schema 校验失败、`beforeToolCall` 阻止，都会在 [prepareToolCall:1223](../../../../../packages/agent/src/agent-loop.ts#L1223 "prepareToolCall(") 变成 `isError: true` 的 `toolResult`，循环继续，不向调用方抛异常；工具 `execute` 自己的抛错也会被转成错误结果。但事件出口、扩展钩子（如 `prepareNextTurn` / `prepareRequest` / `finishTurn`）或配置回调抛出的异常不会被这条工具管线吞掉，可能直接结束低层运行；取消和无法恢复的模型流错误也会结束运行。

### 5. 并行工具的结果按什么顺序交给模型？

按模型给出的原始调用顺序。准备阶段本来就串行地按这个顺序做；执行阶段并发，但 `Promise.all` 之后按索引放回结果数组。完成顺序只影响 `tool_execution_end` 事件的先后，不影响历史里的消息顺序。测试 [agent-loop.test.ts:1127](../../../../../packages/agent/test/agent-loop.test.ts#L1127 "should emit tool_execution_end in completion order but persist tool results in source order") 同时断言了这两个顺序。

### 6. `terminate: true` 在什么条件下阻止下一次模型请求？

批次非空，且**每一个**最终工具结果都带 `terminate === true`。空批次不算终止，混合批次也不算；单个工具不能替其他工具决定。测试见 [agent-loop.test.ts:2946](../../../../../packages/agent/test/agent-loop.test.ts#L2946 "should stop after a tool batch when every tool result sets terminate=true")。

### 7. 为什么 `stopReason: "length"` 时一个工具都不执行？

输出被 token 上限截断，`toolCall` 的参数 JSON 可能只写了一半。执行半截参数可能读错文件、写错位置，所以 [failToolCallsFromTruncatedMessage:809](../../../../../packages/agent/src/agent-loop.ts#L809 "failToolCallsFromTruncatedMessage(") 直接为每个调用生成 `isError: true` 的结果，不进入 `execute`。测试见 [agent-loop.test.ts:775](../../../../../packages/agent/test/agent-loop.test.ts#L775 "should not execute tool calls from a length-truncated assistant message")。

### 8. 为什么 `agent_end` 不是会话结束？

`agent_end` 只表示低层循环不再产生事件。之后 `AgentSession` 还可能等待后重试可重试错误、压缩上下文并恢复失败请求、消费在 `agent_end` 回调里新排入的消息、执行 `agent_before_settle` 扩展边界。真正的结束信号是 `agent_settled`。见 [关键设计第 6 条](#m02-design)。

### 9. 五个扩展钩子分别插在哪？

| 钩子 | 插入点 | 作用 |
| --- | --- | --- |
| `beforeToolCall` | `prepareToolCall` | 阻止调用并给出原因；可附带本批终止要求 |
| `afterToolCall` | `finalizeExecutedToolCall` | 改写结果、附加内容、调整错误标志 |
| `prepareNextTurn` | `runLoop` 每回合开始前 | 压缩上下文、刷新工具和 system 提示词 |
| `prepareRequest` | 每次模型请求前 | 从会话投影重建上下文、虚拟模型路由 |
| `finishTurn` | 工具批次之后、`turn_end` 之前 | 返回 `end` 或 `continue` |

`finishTurn` 的位置有测试断言：[agent-loop.test.ts:1857](../../../../../packages/agent/test/agent-loop.test.ts#L1857 "runs finishTurn after tool-result messages and before turn_end")。

<a id="m02-exercises"></a>
## 练习

练习都用仓库自带的 faux provider 和单元测试，不需要真实 API key，也不产生付费调用。改完记得还原临时改动。

1. **数请求次数**。打开 [agent-loop.test.ts:516](../../../../../packages/agent/test/agent-loop.test.ts#L516 "should handle tool calls and results")，在 `streamFn` 或 faux provider 被调用的位置临时加一条 `console.log("request")`，从 `packages/agent` 目录运行：
   ```bash
   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts -t "should handle tool calls and results"
   ```
   预期看到两次请求，而不是一次。再把第一次 mock 响应改成普通文本、不带 `toolCall`，观察请求次数变成一次。

2. **打印事件序列**。在同一个测试里把收集到的 `events` 映射成 `events.map((e) => e.type)` 并打印，对照 [事件序列](#m02-events)。重点确认：`tool_execution_*` 在 `message_end(assistant)` 之后、下一条 `message_start(toolResult)` 之前；`message_update` 很多，但最终历史里只有一条 assistant 消息。

3. **把并行改成串行**。把测试配置里的 `toolExecution: "parallel"` 临时改成 `"sequential"`，重跑第 1 题里的测试。观察 `tool_execution_end` 的顺序是否变得和调用顺序一致，以及总耗时是否变长。再给其中一个工具加 `executionMode: "sequential"`，确认即使全局配置是 `parallel`，整批也会退化为串行。对应测试见 [agent-loop.test.ts:1456](../../../../../packages/agent/test/agent-loop.test.ts#L1456 "should force sequential execution when a tool has executionMode=sequential even with default parallel config")。

4. **制造一次工具失败**。在测试里让某个工具 `execute` 抛 `new Error("boom")`，观察最终消息是 `role: "toolResult"`、`isError: true`，并且循环继续请求模型，而不是 Promise reject。然后用 `agent.abort()` 取消，比较 `stopReason: "aborted"` 和工具错误这两种失败在事件序列上的差别。

5. **画数据流**。不看本篇的表格，自己画出“用户消息 -> assistant(toolCall) -> toolResult -> assistant(text)”四个阶段中 `currentContext.messages`、`newMessages`、`Agent.state.messages` 三者各自的内容，再和 [数据变化](#m02-data) 对照。

<a id="m02-misread"></a>
## 常见误解

- **“assistant 消息里有 toolCall，工具就已经执行了”**：没有。工具在 `message_end` 之后、由 `runLoop` 单独调度。
- **“每个 `message_update` 都会写 JSONL”**：不会。只有 `message_end` 的完整消息会落盘。
- **“工具报错会抛异常终止循环”**：不会。工具错误变成 `toolResult`，循环继续，模型决定下一步。
- **“`agent.prompt()` 只请求一次模型”**：它等待整个循环；一次调用可以请求很多次。
- **“并行工具的结果顺序是完成顺序”**：不是。结果按模型给出的调用顺序收集，保证 `toolCallId` 配对稳定。
- **“`stopReason: toolUse` 就一定会继续”**：循环看的是 assistant 消息里实际有没有 `toolCall` 块；`stopReason` 只是供应商给的提示，不能替代内容检查。
- **“失败消息是异常抛给了调用方”**：大多数运行期错误被包装成 assistant 消息，调用方看到的是事件和历史，不是一个被拒绝的 Promise。
- **“`prepareRequest` 只有一个”**：循环配置里的 `AgentLoopConfig.prepareRequest` 由 `AgentSession` 安装，负责会话投影和虚拟模型路由；`ModelRuntime.prepareRequest` 负责 provider、认证、baseURL、headers、env。两者同名但不在同一层，前者在 `runLoop` 请求前调用，后者在 `streamSimple` 内部调用。

<a id="m02-next"></a>
## 继续阅读

- 上下文从哪里来、压缩如何改变它：[M03 会话与上下文](../03-session-and-context/README.md)。
- `streamFn` 后面发生了什么：[M04 模型访问](../04-model-access/README.md)。
- 事件如何被 TUI 渲染：[M05 模式与 TUI](../05-modes-and-tui/README.md)。
- 回到全链路：[S8 主循环](../00-full-chain/README.md#m00-s8)、[S11 工具往返](../00-full-chain/README.md#m00-s11)。
