# 00 全链路：一条 query 从输入到回答

<a id="m00-outcomes"></a>
## 学完能回答

1. `pi -p "..."` 从 argv 到 `AgentSession.prompt()` 经过哪几个关键函数？每个函数交出什么对象？
2. 用户只问了一句，为什么一次 query 可能请求模型多次？哪一层决定继续？
3. 同一份用户问题在 argv、`AgentMessage`、供应商消息、JSONL 条目和 stdout 里分别长什么样？
4. `AgentSession` 与 `Agent` 的分工是什么？谁负责持久化、压缩、重试？
5. 每次模型请求前，上下文从哪里来？为什么 `Agent` 内存里的消息不是最终真源？
6. 工具调用的完整管线有哪几步？工具失败时为什么循环不崩？
7. `message_end`、`agent_end`、`agent_settled` 三个边界分别代表什么？
8. 第二轮 query 复用了哪些状态？哪些每轮重建？
9. 打印模式、交互模式、RPC 模式共享哪一段，差异在哪？

<a id="m00-recap"></a>
## 五分钟复述版

先记住一句话：用户只发了一次问题，Agent 却可能请求模型很多次；每次请求都带上“到目前为止的完整历史”。全链路的主线，就是这句话怎样从 argv 一路变成文件、工具调用、会话记录和最终回答。

不看代码时，可以按这条线复述：

```text
cli.ts
  -> main(argv)
  -> parseArgs：-p 变成 print 模式
  -> 选择或创建 SessionManager：这条 query 记到哪本日志
  -> 装配 services：设置、认证、模型目录、扩展资源
  -> createAgentSession：new Agent + new AgentSession
  -> AgentSessionRuntime：当前会话 + 可复用工厂
  -> runPrintMode / InteractiveMode / runRpcMode
  -> AgentSession.prompt(text)
  -> _startRun -> _prepareRun：用户消息 + 运行期上下文
  -> Agent.prompt(messages) -> runAgentLoop -> runLoop
  -> prepareNextTurn -> prepareRequest：从会话树投影上下文
  -> streamAssistantResponse -> streamFn -> ModelRuntime -> provider
  -> 有 toolCall：prepareToolCall -> execute -> finalize -> toolResult
  -> 再请求模型，直到没有工具、没有队列消息
  -> 每个 message_end 写 JSONL
  -> agent_end 后还可能重试/压缩/续跑
  -> agent_settled 才是这条 query 的终点
```

三个不能混的分界：

1. **模式层与核心层**：print、interactive、RPC 只是三种驱动方式，都调用同一个 `AgentSession.prompt()`。
2. **AgentSession 与 Agent**：`AgentSession` 管会话、扩展、压缩、重试和持久化；`Agent` 只管“模型 -> 工具 -> 再问模型”的循环。
3. **Agent 与 ModelRuntime**：Agent 拿到的是 `streamFn` 函数，不关心供应商；认证、路由和 HTTP 由 `ModelRuntime` 和具体 provider 完成。

这篇文档跟着一条真实命令走完整条链路：

```bash
pi -p "读取 README.md 前 20 行并总结"
```

`-p` 表示打印模式。模型看到问题后先请求 `read` 工具，拿到文件内容，再生成总结。这个例子同时覆盖了入口、会话、Agent 循环、模型访问、工具执行、持久化和输出，是后面五个模块的坐标系。

<a id="m00-map"></a>
## 先看地图

```
进程启动
  cli.ts                 setupCli(); main(process.argv.slice(2))
    |
    v
  main.ts                解析参数 -> 选 cwd/会话 -> 信任 -> 装配服务
    |                    createAgentSessionRuntime(...)
    |                         |
    |                         v
    |                    createAgentSession()
    |                         new Agent() + new AgentSession()
    |
    +-- appMode = rpc ----------> runRpcMode()
    +-- appMode = interactive --> new InteractiveMode().run()
    +-- 其他 (text/json) -------> runPrintMode()
                                      |
                                      v
                              AgentSession.prompt()
                                      |
                          _startRun() -> _prepareRun()
                                      |
                                      v
                               Agent.prompt()
                                      |
                                      v
                        runAgentLoop() -> runLoop()
                          |                    ^
                          v                    | toolResult 消息
                  streamAssistantResponse()    |
                          |                    |
                          v                    |
                  streamFn -> ModelRuntime     |
                          |                    |
                          v                    |
                  provider.streamSimple() -----+
                          |
                          v
                  assistant 文本 / toolCall
```

三条必须记住的分界线：

1. **模式层与核心层**：`print`、`interactive`、`rpc` 只是三种驱动方式，它们都调用同一个 `AgentSession.prompt()`。
2. **AgentSession 与 Agent**：`AgentSession` 管会话、扩展、压缩、重试和持久化；`Agent` 只管“模型 -> 工具 -> 再问模型”的循环。
3. **Agent 与 ModelRuntime**：Agent 拿到的是 `streamFn` 函数，不关心供应商；认证、路由和 HTTP 由 `ModelRuntime` 和具体 provider 完成。

<a id="m00-data"></a>
## 同一份问题在每一层长什么样

这条命令从终端到文件，用户问题会被反复“换壳”。字段名和形状对不上时，先回到这张表：

| 层 | 形态 | 这条命令的简化实例 |
| --- | --- | --- |
| shell argv | 字符串数组 | `["-p", "读取 README.md 前 20 行并总结"]` |
| `parseArgs` | `Args` 结构 | `{ print: true, messages: ["读取 README.md 前 20 行并总结"], ... }` |
| `AgentMessage` | 带内容块的消息 | `{ role: "user", content: [{ type: "text", text: "读取 README.md 前 20 行并总结" }], timestamp: 1760000000000 }` |
| 会话条目 | JSONL 行，带树指针 | `{ type: "message", id: "a1", parentId: null, timestamp: "...", message: { ... } }` |
| 请求前投影 | system + 历史消息 | `[system(提示词与工具声明), user, assistant(toolCall), toolResult]` |
| 供应商消息 | `Message[]`，工具另由 system 轨迹重放 | 与投影后的消息同形，但只保留供应商协议认识的字段 |
| assistant 工具请求 | 内容块 | `{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md", limit: 20 } }` |
| 工具结果 | `toolResult` 消息 | `{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [...], isError: false }` |
| 最终回答 | assistant 文本块 | `{ role: "assistant", content: [{ type: "text", text: "README 前 20 行..." }], stopReason: "stop" }` |
| stdout | 纯文本 | 第二次请求的 assistant 文本 |

两个容易漏掉的点：

- 供应商看到的**工具声明**不是 `AgentTool.execute` 函数，而是消息轨迹里的 system 补丁。`declareToolChanges` 把“哪些工具可用”写成 `toolsAdded` / `toolsRemoved`，provider 再按顺序重放出当前工具集合。模型永远看不到本地执行函数。
- JSONL 里存的是**完整消息**，不是每次 `message_update` 的增量。流式期间 UI 收到很多增量，落盘只发生在 `message_end`。

<a id="m00-s1"></a>
## S1 进程启动：cli.ts

[cli.ts:13](../../../../../packages/coding-agent/src/cli.ts#L13 "main(process.argv.slice(2))") 先调用 `setupCli()`，再把去掉 `node` 和脚本路径的参数交给 `main()`。

`setupCli()` 做进程级准备（环境变量、终端能力等），不解析业务参数。真正的参数解析在 `main.ts`。这样 CLI 入口保持很薄，测试和嵌入式调用可以直接调用 `main(args)`。

<a id="m00-s2"></a>
## S2 主装配：main()

[main.ts:980](../../../../../packages/coding-agent/src/main.ts#L980 "export async function main(") 是装配中心。对这条命令，它依次做：

1. 解析 `-p`、模型、工具、cwd 等参数。
2. 确定会话：新建还是从 `~/.pi/agent/sessions/` 恢复。
3. 处理项目信任（首次进入某个目录时的确认）。
4. 加载设置、认证、模型目录和扩展资源，组装 `services`。
5. 用 [createAgentSessionRuntime](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts "createAgentSessionRuntime") 包住“创建会话”的工厂，得到 `runtime`。

工厂里调用 [createAgentSessionFromServices:1463](../../../../../packages/coding-agent/src/main.ts#L1463 "createAgentSessionFromServices({")，它最终进入 SDK 的 `createAgentSession()`。`runtime` 的意义是：扩展或命令可以在运行中换会话，模式层始终通过 `runtime.session` 拿当前会话。

装配完成后按模式分派：

| 模式 | 入口 | 特点 |
| --- | --- | --- |
| `rpc` | [main.ts:1652](../../../../../packages/coding-agent/src/main.ts#L1652 "await runRpcMode(runtime)") | 从 stdin 读 JSON 命令，不启动 TUI |
| `interactive` | [main.ts:1656](../../../../../packages/coding-agent/src/main.ts#L1656 "new InteractiveMode(runtime") / [run:1711](../../../../../packages/coding-agent/src/main.ts#L1711 "interactiveMode.run()") | 持久终端界面，多轮输入 |
| 其他（text/json） | [main.ts:1717](../../../../../packages/coding-agent/src/main.ts#L1717 "runPrintMode(runtime") | 一次性执行，输出最终文本或 JSON 事件 |

<a id="m00-s3"></a>
## S3 创建 Agent 和 AgentSession：sdk.ts

[createAgentSession:285](../../../../../packages/coding-agent/src/core/sdk.ts#L285 "export async function createAgentSession(") 负责把“服务”变成“可用的会话”：

1. 恢复或选择模型、思考级别。
2. 解析工具允许名单，注册内置工具和扩展工具。
3. 构造低层 Agent：[sdk.ts:653](../../../../../packages/coding-agent/src/core/sdk.ts#L653 "const agent = new Agent({")。
4. 注入模型函数：[sdk.ts:672](../../../../../packages/coding-agent/src/core/sdk.ts#L672 "streamFn: async (model, context, options)")。这个闭包把调用转给 `ModelRuntime`。
5. 构造上层会话：[sdk.ts:743](../../../../../packages/coding-agent/src/core/sdk.ts#L743 "const session = new AgentSession({")。

关键点：`Agent` 不知道供应商、API Key、JSONL 文件；它只持有消息数组、工具列表和一个 `streamFn`。`AgentSession` 在构造时向 `agent` 订阅事件，[agent-session.ts:761](../../../../../packages/coding-agent/src/core/agent-session.ts#L761 "this._unsubscribeAgent = this.agent.subscribe")，从此每个完整消息的结束都会进入会话的持久化路径。

<a id="m00-s4"></a>
## S4 进入打印模式：runPrintMode()

[runPrintMode:50](../../../../../packages/coding-agent/src/modes/print-mode.ts#L50 "export async function runPrintMode(") 做三件事：

1. 绑定扩展，订阅会话事件。`text` 模式不逐事件打印；`json` 模式把事件写成 JSONL。
2. 提交首句：[print-mode.ts:199](../../../../../packages/coding-agent/src/modes/print-mode.ts#L199 "await session.prompt(initialMessage")。
3. 如果命令行还有后续消息，按顺序逐条 `await session.prompt(message)`。

`text` 模式在所有 prompt 结束后才取 `session.state.messages` 的最后一条，打印其中的 text 块。模型报错或输出被截断时写 stderr 并返回退出码 1。

<a id="m00-s5"></a>
## S5 会话入口：AgentSession.prompt()

[prompt:3590](../../../../../packages/coding-agent/src/core/agent-session.ts#L3590 "async prompt(text: string") 是核心层的公开入口。它先判断会话是否正在运行：

- 空闲：校验模型和认证，然后进入 `_startRun()`。
- 忙碌：必须带 `streamingBehavior`（`steer` 或 `followUp`），消息进入队列，由当前运行在安全边界消费。

对打印模式的首句，走空闲路径，最终在 [agent-session.ts:3719](../../../../../packages/coding-agent/src/core/agent-session.ts#L3719 "this._startRun({ messageType:") 调用 `_startRun`。

<a id="m00-s6"></a>
## S6 运行准备：_startRun() 与 _prepareRun()

[_startRun:3205](../../../../../packages/coding-agent/src/core/agent-session.ts#L3205 "_startRun(trigger") 管理一次运行的完整生命周期：

1. 标记忙碌，防止并发 prompt。
2. 调用 [_prepareRun:3297](../../../../../packages/coding-agent/src/core/agent-session.ts#L3297 "_prepareRun(trigger") 生成起始消息。
3. 调用 `agent.prompt(messages)`，等待低层循环结束。
4. 进入收尾循环：重试、压缩恢复、排队消息，必要时 `agent.continue()`。
5. `finally` 中发布 `agent_settled`，表示这条 query 真正结束。

`_prepareRun` 在真正请求模型前做这些事：

- 找到上一条 assistant 消息，必要时先检查压缩。
- 运行扩展的 `before_agent_start`，允许注入上下文、改系统提示、切模型、改工具。
- 处理图片、`nextTurn` 队列和扩展消息。
- 如果系统提示有变化，先插入一条 system 补丁消息。

注意：这一步还没有发模型请求。它只是把“用户输入 + 运行期上下文”整理成消息批次。

<a id="m00-s7"></a>
## S7 低层 Agent：Agent.prompt()

[Agent.prompt:668](../../../../../packages/agent/src/agent.ts#L668 "async prompt(input: string") 接收字符串或消息数组，统一成 `AgentMessage[]`，然后进入 [runPromptMessages:773](../../../../../packages/agent/src/agent.ts#L773 "runPromptMessages(")。

`runPromptMessages` 通过 `runWithLifecycle` 建好取消信号，再调用 [runAgentLoop:168](../../../../../packages/agent/src/agent-loop.ts#L168 "runAgentLoop(")。旧历史不在参数里重复传，Agent 用当前状态做一次快照带入循环。

<a id="m00-s8"></a>
## S8 主循环：runLoop()

[runLoop:281](../../../../../packages/agent/src/agent-loop.ts#L281 "runLoop(") 是“一次 prompt 可能变成多次模型请求”的地方。它的骨架是两层循环：

- **内层**：`while (hasMoreToolCalls || pendingMessages.length > 0)`。模型要求工具，就执行工具，再请求模型。
- **外层**：内层结束后检查 follow-up 队列；有追问就继续，没有就发 `agent_end` 退出。

每一轮模型请求前，`runLoop` 调用 `config.prepareRequest`。`AgentSession` 安装了这个回调，它在 [agent-session.ts:1274](../../../../../packages/coding-agent/src/core/agent-session.ts#L1274 "this.agent.prepareRequest = async") 把请求上下文替换成 `sessionManager.buildSessionProjection()` 的结果。也就是说：**Agent 内存里的消息只是工作副本，每次请求都以会话树投影为准**。这让压缩、`context_edit`、分支切换能在下一次请求立即生效，而不需要改 Agent 的历史。

<a id="m00-s9"></a>
## S9 请求模型：streamAssistantResponse()

[streamAssistantResponse:645](../../../../../packages/agent/src/agent-loop.ts#L645 "streamAssistantResponse(") 把 Agent 消息转成供应商消息：

1. `transformContext`：扩展可以过滤或改写请求消息。
2. `convertToLlm`：把自定义消息转成模型认识的角色。
3. `normalizeContext`：把消息规范成 `{ messages }`。这里不传顶层 `systemPrompt` / `tools`，因为提示词和工具声明已经在消息轨迹里；该函数只在调用方传了这两个顶层字段时，才把它们折成首条 system 消息。
4. 解析 API Key（可能刷新过期令牌）。
5. 调用 [streamFunction:680](../../../../../packages/agent/src/agent-loop.ts#L680 "await streamFunction(")。

返回的是一个异步事件流。`streamAssistantResponse` 处理这些事件：

| 事件 | 处理 |
| --- | --- |
| `start` | 把草稿消息放进上下文，发 `message_start` |
| `text_delta` / `thinking_delta` / `toolcall_delta` | 更新草稿，发 `message_update` |
| `done` / `error` | 用最终消息替换草稿，发 `message_end`，返回完整 `AssistantMessage` |

草稿始终占据同一个历史位置，不会把每个 delta 当成一条新消息。`message_end` 才是持久化边界。

<a id="m00-s10"></a>
## S10 模型访问：streamFn -> ModelRuntime -> provider

SDK 注入的 `streamFn` 调用 [ModelRuntime.streamSimple:1333](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1333 "streamSimple(model: Model<Api>")。它做三件事：

1. `normalizeContext`，让路由和 provider 看到同一种上下文。
2. 如果是虚拟模型，先 `resolveModel` 选真实模型；跨供应商时丢掉原供应商的凭证。
3. `prepareRequest` 完成认证、baseURL、headers、env，然后调用 [provider.streamSimple:1374](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1374 "prepared.provider.streamSimple(")。

provider 的实现例如 [anthropic-messages.ts:1633](../../../../../packages/ai/src/api/anthropic-messages.ts#L1633 "export const streamSimple: StreamFunction")。它把统一上下文翻译成供应商协议，返回 `AssistantMessageEventStream`。Agent 只消费统一事件，不解析 HTTP 或 SSE。

<a id="m00-s11"></a>
## S11 工具往返：一次 prompt 变成两次模型请求

假设模型第一次回答是：

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "toolCall",
      "id": "call_1",
      "name": "read",
      "arguments": { "path": "README.md", "limit": 20 }
    }
  ],
  "stopReason": "toolUse"
}
```

`runLoop` 从 `content` 里筛出 `toolCall`，进入 [executeToolCalls:863](../../../../../packages/agent/src/agent-loop.ts#L863 "executeToolCalls(")：

1. [prepareToolCall:1223](../../../../../packages/agent/src/agent-loop.ts#L1223 "prepareToolCall(") 查工具、按 schema 校验参数、跑 `beforeToolCall` 钩子。
2. [executePreparedToolCall:1417](../../../../../packages/agent/src/agent-loop.ts#L1417 "executePreparedToolCall(") 调用 [prepared.tool.execute:1438](../../../../../packages/agent/src/agent-loop.ts#L1438 "prepared.tool.execute(")；`read` 的实现入口在 [read.ts:167](../../../../../packages/coding-agent/src/core/tools/read.ts#L167 "async execute(")。
3. [finalizeExecutedToolCall:1490](../../../../../packages/agent/src/agent-loop.ts#L1490 "finalizeExecutedToolCall(") 跑 `afterToolCall`，合并结果。
4. [createToolResultMessage:1623](../../../../../packages/agent/src/agent-loop.ts#L1623 "createToolResultMessage(") 把结果包装成 `role: "toolResult"` 的消息，发 `message_start` / `message_end`。
5. 结果追加到上下文，`hasMoreToolCalls = true`，内层循环再请求一次模型。

程序化或嵌套工具调用走另一个入口 [runToolCall:1396](../../../../../packages/agent/src/agent-loop.ts#L1396 "export async function runToolCall(")，它复用同一套准备、执行和后置钩子，但不发 Agent 事件、不追加历史。

工具结果消息长这样：

```json
{
  "role": "toolResult",
  "toolCallId": "call_1",
  "toolName": "read",
  "content": [{ "type": "text", "text": "1  # pi\n2  ..." }],
  "isError": false,
  "timestamp": 1760000000000
}
```

模型第二次请求看到的是：用户问题、带 `toolCall` 的 assistant 消息、对应的 `toolResult`。这次它不再调用工具，直接输出总结文本，`stopReason` 为 `stop`。`runLoop` 发现没有工具调用，发 `turn_end`，检查队列后发 `agent_end`。

控制台看到的最终文本来自第二次请求，不是第一次。第一次的 `toolCall` 块在打印模式里不会被当作正文输出。

### 工具管线的四段

`executeToolCalls` 不是直接调用 `tool.execute`。一次工具调用要经过四段，每段都可能把调用变成一条错误结果：

| 阶段 | 入口 | 做什么 | 失败时 |
| --- | --- | --- | --- |
| 准备 | [prepareToolCall:1223](../../../../../packages/agent/src/agent-loop.ts#L1223 "prepareToolCall(") | 按名字找工具、整理参数、按 schema 校验、跑 `beforeToolCall` | 返回 `{ kind: "immediate", result, isError }`，不执行 |
| 执行 | [executePreparedToolCall:1417](../../../../../packages/agent/src/agent-loop.ts#L1417 "executePreparedToolCall(") | 调用 `tool.execute(id, args, signal, onUpdate)`，收集进度和耗时 | 异常转成 `isError: true` 的结果 |
| 收尾 | [finalizeExecutedToolCall:1490](../../../../../packages/agent/src/agent-loop.ts#L1490 "finalizeExecutedToolCall(") | 跑 `afterToolCall`，允许改内容、详情、用量、终止标志 | 钩子异常转成错误结果 |
| 包装 | [createToolResultMessage:1623](../../../../../packages/agent/src/agent-loop.ts#L1623 "createToolResultMessage(") | 生成 `role: "toolResult"` 的消息 | 没有额外失败分支 |

准备阶段还会遇到“模型幻觉出一个不存在的工具”。这里不会抛异常，而是返回 `Tool <name> not found` 的错误结果，让模型自己修正。工具不存在、参数 JSON 解析失败、schema 校验失败、前置钩子阻止，最终都是同一种形状：`toolResult` + `isError: true`。

收尾阶段的 `afterToolCall` 可以覆盖 `content`、`details`、`usage`、`terminate` 和 `isError`。如果它改了 `content` 却没有给新的 `structuredContent`，旧的 `structuredContent` 会被删除，避免模型看到的内容和结构化数据互相矛盾。

### 并行、串行与 terminate

- 准备阶段按模型给出的调用顺序**串行**执行，因为参数校验和前置钩子可能有顺序依赖。
- 执行阶段默认**并发**；只要全局配置是 `"sequential"`，或者任意一个工具声明 `executionMode: "sequential"`，整批都退化为串行。
- 并发执行的结果按**原始调用顺序**收集，不按完成顺序。`toolCallId` 配对和模型看到的顺序因此保持稳定。
- 整批是否阻止下一次模型请求，只看一个条件：批次非空，且**每一个**最终结果都带 `terminate: true`。空批次、混合批次都不算终止。
- 如果输出因 token 上限被截断（`stopReason === "length"`），工具参数可能只写了一半。此时一个工具都不执行，直接为每个调用生成错误结果。

<a id="m00-events"></a>
## 一次完整运行的事件序列

把上面的步骤按事件展开，带工具往返的一次 query 大致是：

```text
agent_start
turn_start
message_start(user)
message_end(user)
message_start(assistant 草稿)
message_update(delta) ...
message_end(assistant, toolCall)
tool_execution_start(call_1)
tool_execution_update(progress) ...
tool_execution_end(call_1, isError=false)
message_start(toolResult)
message_end(toolResult)
turn_end(assistant, [toolResult])
turn_start
message_start(assistant 草稿)
message_update(delta) ...
message_end(assistant, 最终文本)
turn_end(assistant, [])
agent_end
agent_settled
```

三个边界要分开：

- `message_end`：一条**完整消息**结束。`AgentSession` 在这里把消息写进会话；这是持久化边界。
- `agent_end`：低层 Agent 循环不再产生事件。之后会话层还可能重试、压缩、`agent.continue()`。
- `agent_settled`：这条 query 真正结束，重试、压缩和扩展续跑都已收尾。

`message_update` 只是流式增量，不落盘；`tool_execution_*` 是工具生命周期，不是消息。UI 可以把它们画成工具行，但会话历史里只有工具结果消息。

<a id="m00-s12"></a>
## S12 持久化：每个完整消息一条记录

`AgentSession` 在 [_handleAgentEvent:1872](../../../../../packages/coding-agent/src/core/agent-session.ts#L1872 "_handleAgentEvent = async") 处理低层事件。顺序是：

1. 先把事件交给扩展（扩展可以替换消息内容）。
2. 再通知公开订阅者（UI、打印模式、RPC）。
3. 如果是 `message_end`，写入会话：[appendMessage:1971](../../../../../packages/coding-agent/src/core/agent-session.ts#L1971 "sessionManager.appendMessage(event.message)")。

[SessionManager.appendMessage:1936](../../../../../packages/coding-agent/src/core/session-manager.ts#L1936 "appendMessage(message: Message") 给消息分配 `id`、记录 `parentId` 和时间戳，然后追加到 JSONL。一个简化后的会话文件：

```jsonl
{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"/repo"}
{"type":"message","id":"a1","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"读取 README.md 前 20 行并总结"}]}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"...","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"README.md","limit":20}}],"stopReason":"toolUse"}}
{"type":"message","id":"a3","parentId":"a2","timestamp":"...","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[...],"isError":false}}
{"type":"message","id":"a4","parentId":"a3","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"README 的前 20 行介绍了..."}],"stopReason":"stop"}}
```

`parentId` 把消息串成树，而不是一条线性数组。分支、fork、回到旧节点都靠它。恢复会话时，[buildSessionProjection:817](../../../../../packages/coding-agent/src/core/session-manager.ts#L817 "export function buildSessionProjection(") 从当前叶子沿父链走到根，选出这条分支；[buildContextEntries:705](../../../../../packages/coding-agent/src/core/session-manager.ts#L705 "export function buildContextEntries(") 再应用最新压缩检查点，决定哪些旧消息由摘要替代。

<a id="m00-s13"></a>
## S13 打印输出与收尾

`session.prompt()` 返回后，`runPrintMode` 读取 `session.state.messages` 的最后一项；仅当它是 assistant 时打印其中 text 块并决定退出码。末项不是 assistant 时不输出正文。此时会话已经写完 JSONL，进程可以退出。

`_startRun` 的收尾循环在 `agent.prompt()` 返回后还会做：

- 可重试错误（限流、网络）：等待后 `agent.continue()`，不重新追加用户问题。
- 上下文溢出或达到阈值：触发压缩，写入压缩条目，再继续。
- 扩展或队列要求继续：`agent.continue()` 消费新消息。
- 用户取消：跳过重试和压缩，进入 `finally`。

最后发布 `agent_settled`。判断“这条 query 是否真正结束”应该看它，而不是看 `agent_end`：`agent_end` 之后还可能有重试、压缩和扩展续跑。

<a id="m00-interactive"></a>
## 交互模式的一条 query 有什么不同

交互模式走同一个 `AgentSession.prompt()`，差别只在输入和输出：

1. [InteractiveMode.run:2042](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2042 "async run(): Promise<void>") 初始化 TUI、扩展和渲染器。
2. 主循环在 [interactive-mode.ts:2212](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2212 "const userInput = await this.getUserInput()") 等待输入；[getUserInput:7459](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7459 "async getUserInput(): Promise<string>") 返回一个 Promise，用户提交时才 resolve。
3. 拿到文字后调用 [session.prompt:2216](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2216 "await this.session.prompt(userInput)")。
4. 会话事件被 TUI 订阅，流式更新到屏幕；工具调用、思考、状态行都来自同一套 `message_start` / `message_update` / `message_end` / `tool_execution_*` 事件。
5. 流式期间再输入，走 `steer`；运行结束后再输入，走下一轮普通 prompt 或 `followUp`。

打印模式是“提交一次，等结束，打印”，交互模式是“常驻会话，事件驱动渲染”。核心层没有为 TUI 开特殊路径。

<a id="m00-multiturn"></a>
## 多轮对话：哪些状态跨轮保留

第二轮用户输入 `那第 21 到 40 行呢？` 时，`session.prompt()` 再次进入 `_prepareRun`。跨轮保留的状态：

| 状态 | 存放位置 | 说明 |
| --- | --- | --- |
| 消息历史 | `SessionManager` 的条目树 + JSONL | `Agent` 中只是工作副本，每次请求由投影刷新 |
| 系统提示 | `AgentSession` 的 system prompt 状态 | 工具或扩展变化时重建 |
| 模型/思考级别 | 会话条目中的选择记录 | 恢复会话时继续使用 |
| 工具注册 | `Agent.state.tools` + 系统提示声明 | 扩展可以在轮间增删 |
| 压缩摘要 | compaction 条目 | 下一轮投影自动使用 |

每轮重新计算的状态：

- 请求上下文（`buildSessionProjection`）。
- 系统提示补丁（`_prepareRun` / `prepareNextTurn`）。
- 可用工具声明（工具变化时）。
- API Key（`streamAssistantResponse` 每次请求前解析，支持刷新）。

多轮不会重新读取整个 JSONL 文件；`SessionManager` 在内存中维护条目树，JSONL 只是追加日志。`buildSessionProjection` 每次从内存树投影。

<a id="m00-compaction"></a>
## 压缩发生在哪

压缩不是每轮都跑。触发点有两类：

1. **请求前**：`_prepareRun` 发现上一条 assistant 消息的用量接近上下文窗口，调用 [_checkCompaction:5137](../../../../../packages/coding-agent/src/core/agent-session.ts#L5137 "_checkCompaction(assistantMessage")。
2. **请求后**：`_handlePostAgentRun` 在模型报错、输出截断或超过阈值时检查压缩。

判断阈值用 [shouldCompact:387](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L387 "export function shouldCompact(")。真正生成摘要用 [generateSummary:931](../../../../../packages/coding-agent/src/core/compaction/compaction.ts#L931 "export async function generateSummary(")，分支摘要用 [generateBranchSummary:417](../../../../../packages/coding-agent/src/core/compaction/branch-summarization.ts#L417 "export async function generateBranchSummary(")。

压缩条目保存“摘要 + 从哪条消息开始保留原文”。下一次投影用摘要替代更早的历史，同时保留最近的原文尾巴。原始 JSONL 不删除，所以回看和导出仍然能看到完整记录。

<a id="m00-failure"></a>
## 失败、取消、重试

| 情况 | 发生位置 | 行为 |
| --- | --- | --- |
| 模型返回可重试错误 | `_handlePostAgentRun` -> `_prepareRetry` | 等待后 `agent.continue()`，保留原用户问题 |
| 上下文溢出 | `_checkCompaction` -> `_runAutoCompaction("overflow")` | 压缩后继续；必要时重试失败请求 |
| 用户 Ctrl+C | `AgentSession.abort()` | 低层 `stopReason = "aborted"`，跳过重试和压缩 |
| 工具参数被截断 | `runLoop` 检测 `stopReason === "length"` | 不执行工具，给每个调用生成失败结果，让模型重试 |
| 工具不存在/参数不合法 | `prepareToolCall` | 生成 `isError` 的工具结果，循环继续 |

核心原则：错误尽量变成消息，而不是直接抛到进程外。模型看到工具错误后可以修正；UI 看到错误消息可以展示；会话仍然完整落盘。

<a id="m00-selfcheck"></a>
## 自测

先自己回答，再对照答案和源码位置。

### 1. `pi -p "..."` 从 argv 到 `session.prompt()` 经过哪些关键函数？

`setupCli()` -> `main(argv)` -> `parseArgs()` 得到 `print=true` -> `createSessionManager()` 选定会话和 cwd -> 运行时工厂装配 `SettingsManager`、`ModelRuntime`、`ResourceLoader` -> `createAgentSession()` 构造 `Agent` 和 `AgentSession` -> `createAgentSessionRuntime()` 包住当前会话 -> `runPrintMode()` 调用 `session.prompt()`。见 [S1](#m00-s1) 到 [S5](#m00-s5)。

### 2. 一次 query 为什么可能请求模型多次？

`runLoop` 的内层循环在 assistant 消息带 `toolCall` 时执行工具，把 `toolResult` 放回上下文，然后继续下一次请求。没有工具调用、没有排队消息、`finishTurn` 也不要求继续时，循环才退出。见 [S8](#m00-s8) 和 [S11](#m00-s11)。

### 3. 同一份问题在各层的形态是什么？

argv 是字符串数组；`parseArgs` 是结构化 `Args`；进入会话后是带内容块的 `AgentMessage`；落盘时是带 `id` / `parentId` 的 JSONL 条目；请求前投影成 system + 历史消息；provider 看到的是供应商协议的 `Message[]`；工具结果是 `role: "toolResult"`；最终 stdout 只有 assistant 文本。完整对照见 [同一份问题在每一层长什么样](#m00-data)。

### 4. `AgentSession` 与 `Agent` 的分工是什么？

`Agent` 只负责低层循环：消息状态、`prompt` / `continue`、工具执行、事件发布。`AgentSession` 负责会话级能力：持久化、扩展、压缩、重试、队列和 `agent_settled`。`Agent` 不碰 JSONL，`AgentSession` 不实现模型循环。见 [S3](#m00-s3) 和 [S6](#m00-s6)。

### 5. 每次请求前，上下文从哪里来？

从 `SessionManager` 的会话树投影而来。`AgentSession` 安装的 `prepareRequest` 在每次请求前调用 `buildSessionProjection()`，把投影结果替换进 `currentContext`。`Agent` 内存里的消息只是工作副本，所以压缩、`context_edit` 和分支切换能在下一次请求立即生效。见 [S8](#m00-s8)。

### 6. 工具调用的完整管线有哪几步？失败时为什么循环不崩？

准备（查找、参数、schema、`beforeToolCall`）-> 执行（`tool.execute`、进度、耗时）-> 收尾（`afterToolCall`）-> 包装成 `toolResult`。任何一步失败都变成 `isError: true` 的消息，而不是抛异常；模型看到错误后可以修正参数或换工具。见 [S11](#m00-s11) 和 [工具管线的四段](#m00-s11)。

### 7. `message_end`、`agent_end`、`agent_settled` 分别代表什么？

`message_end` 是一条完整消息结束，也是持久化边界；`agent_end` 是低层循环不再产生事件，之后还可能有重试、压缩、续跑；`agent_settled` 才是这条 query 真正结束。见 [事件序列](#m00-events)。

### 8. 第二轮 query 复用了哪些状态？

复用消息历史（会话树 + JSONL）、系统提示、模型/思考级别、工具注册和压缩摘要。每轮重建的是请求上下文（投影）、系统提示补丁、工具声明和 API Key。见 [多轮对话](#m00-multiturn)。

### 9. 三种模式共享哪一段？

共享 `AgentSession.prompt()` 及其下面的全部核心层。差异只在输入和输出：打印模式提交一次、收集结果、打印文本或 JSON 事件；交互模式常驻 TUI，按事件流式渲染；RPC 模式从 stdin 读 JSON 命令。见 [S4](#m00-s4)、[交互模式](#m00-interactive) 和 [S2](#m00-s2)。

<a id="m00-exercises"></a>
## 练习

1. **看真实事件流**。有可用认证时运行：
   ```bash
   pi --mode json -p "读取 README.md 前 20 行并总结"
   ```
   观察 `message_start`、`message_update`、`message_end`、`tool_execution_*`、`agent_end`、`agent_settled` 的顺序。注意打印 JSON 事件用的是 `--mode json`，不是 `pi --json`；后者不是这个仓库的参数。
2. **对照 JSONL**。跑完上一条命令后，找到最新的会话文件并查看：
   ```bash
   find ~/.pi/agent/sessions -name '*.jsonl' -print0 | xargs -0 ls -t | head -1
   ```
   如果设置了 `PI_CODING_AGENT_DIR`，配置和会话根目录会改到该路径下，把 `~/.pi` 换成实际目录。确认每次 `message_end` 对应一行 `type: "message"`，`parentId` 把 user、assistant(toolCall)、toolResult、assistant(text) 串成一条链。`message_update` 不会单独占一行。
3. **数请求次数**。打开 [agent-loop.test.ts:516](../../../../../packages/agent/test/agent-loop.test.ts#L516 "should handle tool calls and results")，在 mock `streamFn` 里临时打印计数，运行该测试，确认一次 `agentLoop` 调用了两次模型函数。这个测试不依赖真实 API key。
4. **读一次投影**。用 `rg -n "prepareRequest|buildSessionProjection"` 找到 `AgentSession` 安装回调和 `SessionManager` 实现投影的位置，画出“会话树 -> 投影消息 -> 请求上下文”的三步数据流，再和 [同一份问题在每一层长什么样](#m00-data) 对照。
5. **制造工具失败**。在 `packages/agent` 的测试里让一个工具的 `execute` 抛错，观察它变成 `toolResult` 而不是 Promise reject；再调用 `agent.abort()`，比较工具错误和用户取消在事件序列上的差别。

<a id="m00-misread"></a>
## 常见误解

- **“`-p` 表示只请求一次模型”**：`-p` 是打印模式，不是请求次数。一次打印模式 query 仍可能包含多次模型请求。
- **“`agent_end` 就是 query 结束”**：它只是低层循环结束。重试、压缩和扩展续跑发生在它之后，真正结束看 `agent_settled`。
- **“`Agent.state.messages` 是会话真源”**：它只是工作副本。请求上下文从会话树投影，JSONL 才是持久记录。
- **“工具报错会 reject `session.prompt()`”**：工具错误（包括 `execute` 抛错）变成 `toolResult` 消息，循环继续。但事件出口、扩展钩子或配置回调抛出的异常不会被工具管线吞掉，可能结束低层运行；取消和无法恢复的模型流错误也会结束运行。
- **“模型能看到工具的 `execute` 函数”**：看不到。模型只看到 system 轨迹里的工具声明；`execute` 只在本地工具管线里使用。
- **“打印 JSON 事件用 `pi --json`”**：这个仓库没有顶层 `--json`。用 `pi --mode json -p "..."`。
- **“恢复会话一定使用当前目录”**：会话文件记录的 cwd 可能不同于进程启动目录；恢复时服务和工具要按会话 cwd 装配。
- **“两个 `prepareRequest` 是同一个函数”**：`AgentLoopConfig.prepareRequest` 在 `runLoop` 每次请求前调用，负责会话投影和虚拟模型路由；`ModelRuntime.prepareRequest` 在 `streamSimple` 内部调用，负责 provider、认证、baseURL、headers、env。同名但不同层。

<a id="m00-modules"></a>
## 模块对照表

| 步骤 | 模块 | 继续读 |
| --- | --- | --- |
| S1-S3 | 入口与装配 | [01-entry-and-config](../01-entry-and-config/README.md) |
| S7-S11 | Agent 循环与工具 | [02-agent-loop](../02-agent-loop/README.md) |
| S6、S12、多轮、压缩 | 会话与上下文 | [03-session-and-context](../03-session-and-context/README.md) |
| S9-S10 | 模型访问 | [04-model-access](../04-model-access/README.md) |
| S4、S13、交互模式 | 模式与 TUI | [05-modes-and-tui](../05-modes-and-tui/README.md) |

下一步建议：先读 [02 Agent 循环](../02-agent-loop/README.md)，因为它是“一次 prompt 为什么能变成多次模型请求”的核心；再读 [03 会话与上下文](../03-session-and-context/README.md)，理解消息如何跨轮保存和投影。
