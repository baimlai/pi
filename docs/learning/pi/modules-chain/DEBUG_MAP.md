# pi 排障地图

这是“现象 -> 最可能层 -> 证据 -> 函数”的排障页，不是已知 bug 清单。先按症状定位层，再收集能互相印证的证据；不要看到一条日志就直接改代码。

<a id="debug-how"></a>
## 怎么用这张图

1. 在下面的症状索引里找最接近的现象。
2. 先看“最可能层”，用事件流或会话 JSONL 判断问题发生在哪一段。
3. 只有前两层仍不能区分时，再按“位置”里的函数打断点或读源码。
4. 最后用最小复现固定问题，再决定改哪里。

同一个现象可能跨两层。例如“模型没回复”可能是入口没有启动 run，也可能是请求已经发出但认证失败；这两件事的证据完全不同。

<a id="debug-layers"></a>
## 三层观察法

| 层 | 怎么看 | 能看到 | 看不到 |
| --- | --- | --- | --- |
| 事件流 | JSON 模式或 RPC 模式收集会话事件 | 事件顺序、`agent_start`/`agent_end`、消息开始/更新/结束、工具生命周期、压缩和重试事件、`agent_settled` | 供应商原始 HTTP/SSE、扩展在 `prepareRequest` 内部对上下文的改写、会话树分支、投影后的完整请求 |
| 会话 JSONL | 打开当前会话文件，逐行看 `id`/`parentId`/`type` | 已持久化的条目树、叶子路径、压缩检查点、`context_edit`、模型/思考档位变化 | `message_update` 的流式增量、请求还没到 `message_end` 就失败的内容、投影之后的最终上下文、内存会话或 `--no-session` 的内容 |
| 源码断点与路由 | 在关键函数打断点、读调用链、检查对象字段 | 精确的投影消息、模型选择、工具装载、认证准备、虚拟路由结果 | 真实网络响应、远端 UI 是否消费、断点改变后的时序；不能替代运行时事件 |

### 1. 事件流

用 JSON 模式跑同一条输入，把协议输出和错误输出分开：

```bash
pi --mode json --session-dir /tmp/pi-debug-sessions \
  -p "读取 README.md 前 20 行并总结" \
  > /tmp/pi-events.jsonl 2> /tmp/pi-debug.err
```

第一行通常是会话头，后面是一行一个会话事件。重点看：

- 有没有 `agent_start`、`turn_start`，判断低层 run 是否启动。
- 有没有 assistant 的 `message_start`/`message_end`，以及 `message_end` 里的 `stopReason`、`errorMessage`、`provider`、`model`。
- 有没有 `tool_execution_start`/`tool_execution_end`，以及是否随后出现 toolResult 的 `message_start`/`message_end`。
- 有没有 `compaction_start`/`compaction_end`、`auto_retry_start`/`auto_retry_end`。
- 最后有没有 `agent_settled`，而不是只看 `agent_end`。

JSON 传输会去掉 `message_update` 里的累计 `partial` 快照，只保留增量和用量。需要完整草稿时，不要假设 JSON 里每条更新都带整段消息；`message_end` 才是权威内容。

RPC 模式也输出 JSONL，但它面向长连接客户端。排查 RPC 时，客户端和宿主应分别捕获 stdout 与 stderr，不要只看终端混在一起的内容。

### 2. 会话 JSONL

默认会话目录按 cwd 编码后放在 `~/.pi/agent/sessions/` 下，文件名以 `.jsonl` 结尾；也可以用 `--session-dir` 指定目录。打开后先看：

- 第一行是不是会话头。
- 当前叶子对应哪条 `id`，沿 `parentId` 能否走到根。
- 有没有 `compaction`、`context_edit`、`model_change` 等非 message 条目。
- 工具结果的 `toolCallId` 是否和 assistant 里的 toolCall 配对。

JSONL 是追加日志，不是最终投影。看到旧消息还在文件里，不一定表示模型还能看到它；反过来，模型看到摘要，也不表示原始消息被删除了。

### 3. 源码断点与路由

优先在这些位置观察：

- `AgentSession` 的 `prepareRequest` 包装：看本次 `projection.messages`、`model`、`thinkingLevel`；虚拟路由结果要到 `ModelRuntime.prepareRequest` 里看。
- `agent-loop.ts` 的 `streamAssistantResponse`：看 `llmMessages`、规范化后的 `llmContext`、实际调用的 `streamFunction`。
- `ModelRuntime.prepareRequest` 与 `resolveModel`：看 provider 解析、认证、baseURL、headers、物理模型路由。
- `SessionManager.buildContextEntries` 与 `projectContextEntry`：看压缩边界和 `context_edit` 是否作用在当前分支。
- `agent-loop.ts` 的 `prepareToolCall` 和并行/串行执行函数：看工具查找、参数校验、阻止和结果排序。
- `AgentSession._handleAgentEvent`：看 `message_end` 的持久化、扩展替换和 `turn_end` 边界。

断点能看到精确对象，但会改变时序；它不能证明供应商真的收到了某个请求，也不能证明远端 UI 已经显示。

<a id="debug-min-repro"></a>
## 最小复现

优先用 `packages/coding-agent/test/suite/harness.ts` 和 faux provider。它注册假模型、使用内存设置/认证，默认会话也是内存会话；不会访问真实供应商、真实 key 或网络。

```ts
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness } from "./harness.ts";

const harness = await createHarness();
try {
  // 脚本化模型回复，不访问真实 API。
  harness.setResponses([fauxAssistantMessage("ok")]);

  await harness.session.prompt("hi");

  const ends = harness.eventsOfType("agent_end");
  const settled = harness.eventsOfType("agent_settled");
  // 在这里断言事件顺序、消息内容或 toolResult 配对。
  console.log(ends.length, settled.length);
} finally {
  // 释放会话、注销 faux provider、删除临时目录。
  harness.cleanup();
}
```

要点：

- 用 `setResponses()`/`appendResponses()` 控制模型输出；要工具调用就用 `fauxAssistantMessage(fauxToolCall(...), { stopReason: "toolUse" })`。
- 用 `eventsOfType("agent_end")`、`eventsOfType("agent_settled")` 等按类型取事件，不靠终端文本判断。
- 要复现认证失败，可传 `withConfiguredAuth: false`；不要用真实 key 制造失败。
- 要复现持久化/恢复，给 harness 传一个落盘的 `SessionManager`，而不是默认的内存会话。
- 要复现 UI 或 RPC 的传输问题，保留对应模式并分别捕获 stdout/stderr；仍然不要调用真实付费接口。

从仓库根目录跑全部非 e2e 测试：

```bash
./test.sh
```

脚本不接受参数。它会在隔离的临时 HOME/TMPDIR/npm 缓存中运行，清空大部分环境变量，适合作整体回归，不适合快速迭代。

只跑一个测试文件时，从 `packages/coding-agent` 目录执行：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/suite/agent-session-queue.test.ts
```

把路径换成你自己的测试文件。不要在复现里依赖真实供应商、真实网络或付费 token。

<a id="debug-index"></a>
## 症状索引

| 症状 | 先看层 | 锚点 |
| --- | --- | --- |
| 没有发出模型请求 | 入口/会话准备 | [查看](#debug-no-request) |
| 模型回复了但工具没执行 | Agent 工具管线 | [查看](#debug-tool-not-run) |
| 工具执行了但下一回合看不到结果 | 会话持久化/投影 | [查看](#debug-tool-result-missing) |
| 会话文件没有消息或重启后历史丢失 | 会话持久化 | [查看](#debug-no-session-messages) |
| 压缩后的旧消息又出现 | 会话分支/压缩投影 | [查看](#debug-old-compaction) |
| `context_edit` 后模型仍看到旧内容 | 投影/上下文编辑 | [查看](#debug-context-edit-stale) |
| 压缩后请求仍超上下文窗口 | 压缩/请求预算 | [查看](#debug-over-window-after-compaction) |
| 流式文本或最终消息重复 | 事件消费/渲染 | [查看](#debug-stream-duplicate) |
| 取消后界面仍卡在处理中 | 会话收尾/UI | [查看](#debug-stuck-busy) |
| 认证失败或供应商路由异常 | 模型访问/认证 | [查看](#debug-auth-routing) |
| 并行工具结果顺序或 toolCallId 异常 | Agent 工具批次 | [查看](#debug-tool-order) |
| RPC stdout 混入普通日志 | 模式/输出协议 | [查看](#debug-rpc-stdout) |
| 扩展钩子没有触发 | 扩展绑定/事件 | [查看](#debug-extension-hooks) |
| 同一 prompt 在 text/json/interactive 表现不同 | 模式/入口 | [查看](#debug-mode-difference) |

<a id="debug-no-request"></a>
## 1. 没有发出模型请求

**症状**：运行后没有 assistant 回复，只有用户消息；或者看起来“什么都没发生”。

**最可能层**：入口与会话准备（命令解析、扩展命令、`before_agent_start`、认证检查、压缩），也可能是请求前钩子卡住。

**证据**：

- JSON 事件里没有 `agent_start`：低层 run 还没开始。先查命令是否被扩展命令接管、输入是否为空、`_prepareRun` 是否在启动前失败。
- 有 `agent_start`、`turn_start`，但没有 assistant 的 `message_start`/`message_end`：低层已启动，卡在 `prepareRequest`、认证、压缩或流建立阶段。
- assistant 的 `message_end` 已经是 `stopReason: "error"` 或 `"aborted"`：请求路径已经走到，失败发生在前或流内，不属于“没发请求”；读 `errorMessage`、`provider`、`model`。
- stderr 有错误但 stdout 没有 assistant 事件：错误可能在打印/模式的启动路径被捕获。

**位置**：[main.ts](../../../../packages/coding-agent/src/main.ts) 的 `resolveAppMode`；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_startRun`、`_prepareRun`；[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) 的 `streamAssistantResponse`；[model-runtime.ts](../../../../packages/coding-agent/src/core/model-runtime.ts) 的 `prepareRequest`。命令用 `pi --mode json -p "..."`，分别保存 stdout 和 stderr。

**下一步**：先区分“没有 run”和“run 了但请求失败”。没有 `agent_start` 查入口和准备；有 `agent_start` 查请求投影、认证和供应商 setup；有错误 assistant 消息则按 `stopReason`/`errorMessage` 继续。

**相关模块**：[M01 入口与装配](01-entry-and-config/README.md)、[M03 会话与上下文](03-session-and-context/README.md)、[M04 模型访问](04-model-access/README.md)、[M02 Agent 循环](02-agent-loop/README.md)。

<a id="debug-tool-not-run"></a>
## 2. 模型回复了但工具没执行

**症状**：assistant 消息里有 `toolCall`，但文件没被读、命令没跑，或者只得到一条错误结果。

**最可能层**：Agent 工具管线（查找、参数校验、前置钩子、截断处理），不是模型访问层。

**证据**：

- assistant 的 `message_end` 带 `toolCall`，先检查 `stopReason` 是否为 `toolUse`。如果 `stopReason` 是 `error`/`aborted`，循环可能在工具批次前就结束了。
- `tool_execution_start` 之后出现 `tool_execution_end`，但没有真正的工具副作用：常见原因是未知工具、参数校验失败、`beforeToolCall`/扩展 `tool_call` 阻止，或输出被 `length` 截断。阻止路径仍会发开始/结束事件，但不会调用 `execute()`。
- 没有 `tool_execution_start`：说明工具批次根本没进入，优先回看 assistant 的 `stopReason` 和循环退出条件。
- 不要只用“有没有 `tool_execution_update`”判断是否执行；工具可以完全不发中间更新。

**位置**：[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) 的 `prepareToolCall`、`executeToolCalls`、`executeToolCallsSequential`、`executeToolCallsParallel`；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_beforeToolCall`。事件流里看 toolResult 的 `content` 和 `isError`。

**下一步**：读 toolResult 的错误文字，判断是“未注册/参数错误/被阻止/被截断”；再查扩展 `tool_call` 处理器和实际激活的工具装载。如果工具确实执行了但没有副作用，检查工具实现和传入参数，而不是循环。

**相关模块**：[M02 工具执行](02-agent-loop/README.md#m02-walk-tools)、[M05 事件到界面](05-modes-and-tui/README.md#m05-interactive)。

<a id="debug-tool-result-missing"></a>
## 3. 工具执行了但下一回合看不到结果

**症状**：工具确实产生了输出，下一轮模型却像没看到，或者重复发起同一个调用。

**最可能层**：toolResult 消息的生成/持久化，或下一请求的会话投影。

**证据**：

- 事件流里 `tool_execution_end` 后应出现 toolResult 的 `message_start`/`message_end`。并行批次要等本批全部完成后才按源顺序发结果消息，不要因为前一个工具结束就断定结果丢了。
- 会话 JSONL 里应有一条 `role: "toolResult"` 的 message 条目，且 `toolCallId` 与 assistant 的 toolCall 相同。没有条目，查持久化/取消；有条目但模型看不到，查投影。
- 投影层可能因为 `compaction` 把结果归入摘要，或因为 `context_edit` 隐藏/替换了它；也可能当前叶子在另一条分支上。
- `toolCallId` 不匹配会让配对失效，模型可能把结果当成另一条调用的内容。

**位置**：[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) 的结果消息生成与并行排序；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_handleAgentEvent` 和 `message_end` 保存；[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) 的 `buildContextEntries`、`projectContextEntry`、`buildSessionProjection`。

**下一步**：先用 `toolCallId` 在事件流和 JSONL 里配对，再检查最新 `compaction` 的 `firstKeptEntryId` 和当前路径上的 `context_edit`。如果 JSONL 没有结果条目，问题在持久化前；如果有但投影没有，问题在投影边界。

**相关模块**：[M02 工具执行](02-agent-loop/README.md#m02-walk-tools)、[M03 会话文件与条目树](03-session-and-context/README.md#m03-store)。

<a id="debug-no-session-messages"></a>
## 4. 会话文件没有消息或重启后历史丢失

**症状**：运行结束找不到 `.jsonl`，或文件只有会话头，或重启后看不到刚才的对话。

**最可能层**：会话持久化与会话选择，不是模型层。

**证据**：

- 使用 `--no-session` 或 `SessionManager.inMemory()` 时本来就不会写文件；这是设计行为，不是丢数据。
- 默认会话目录按 cwd 编码。换了启动目录，可能打开的是另一个目录下的会话；`--session-dir` 可以固定目录。
- 文件存在但只有第一行会话头：可能没有走到任何 `message_end`，或持久化被关闭；回到事件流看 run 是否开始、是否在准备阶段失败。
- 文件里有 message 条目但恢复后看不到：检查当前叶子和 `parentId` 路径，确认打开的是同一条分支；`--session <path>` 可以显式打开某个文件。
- `--session-id` 选择的是当前目录范围内的会话 id，不等于文件路径；两者不要混用。

**位置**：[args.ts](../../../../packages/coding-agent/src/cli/args.ts) 的 `--no-session`、`--session`、`--session-id`、`--session-dir`；[main.ts](../../../../packages/coding-agent/src/main.ts) 的 `createSessionManager`；[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) 的 `appendMessage` 与文件写入。

**下一步**：用 `--session-dir /tmp/pi-debug-sessions` 重新跑一次，明确知道文件落在哪里；检查会话头和 message 条目；恢复时用显式 `--session` 路径排除“打开了另一个会话”的可能。

**相关模块**：[M01 参数与装配](01-entry-and-config/README.md#m01-example)、[M03 会话文件与条目树](03-session-and-context/README.md#m03-store)。

<a id="debug-old-compaction"></a>
## 5. 压缩后的旧消息又出现

**症状**：已经压缩过的旧对话又进入模型上下文，或者模型仍然知道很早以前的内容。

**最可能层**：当前分支选择和压缩投影，不是压缩算法本身。

**证据**：

- `buildContextEntries` 只沿当前叶子的 `parentId` 路径找“最新压缩”。如果叶子在压缩条目之前，或者切到了另一条没有该压缩的分支，旧历史会按该分支重新出现。
- 最新 `compaction` 的 `firstKeptEntryId` 决定保留哪一段原文。边界指得早，旧消息本来就会保留，不是“又出现”。
- 如果模型只是从摘要里知道旧事实，那是摘要内容，不是原始消息重新进入投影；`context_edit` 不会改写摘要。
- 保留区内更旧的 `compaction` 条目只作为来源存在，通常不重复贡献摘要；当前生效的是路径上最新的检查点。

**位置**：[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) 的 `buildContextEntries`、`buildSessionProjection`；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `prepareRequest` 投影。

**下一步**：先确认当前叶子、路径和最新 `compaction` 条目，再确认 `firstKeptEntryId`。如果切错了分支，先修正叶子；如果确实要缩短保留尾部，用新的压缩/摘要策略，不要手改旧 JSONL。

**相关模块**：[M03 会话文件与条目树](03-session-and-context/README.md#m03-store)、[M03 压缩](03-session-and-context/README.md#m03-compaction)。

<a id="debug-context-edit-stale"></a>
## 6. `context_edit` 后模型仍看到旧内容

**症状**：已经写入 `context_edit`，下一轮模型还是按被替换或被隐藏的旧内容回答。

**最可能层**：上下文投影，尤其是编辑目标、当前范围或请求时机。

**证据**：

- 检查 `context_edit.targetId` 是否指向当前分支、当前重放范围内的条目；另一条分支上的目标不会生效。
- 同一目标有多条编辑时，当前范围内最后一条生效；`replacement: null` 是隐藏，普通内容只替换 `content`。
- `context_edit` 只改模型投影，不改原始 JSONL，也不改 `details` 等元数据；如果旧内容在摘要里，编辑原条目不等于改摘要。
- system 消息不是这里的可替换目标；状态/摘要类内容也不会被它改写。
- 编辑发生在请求准备之后时，当前 in-flight 请求不会变；下一次请求才会重新投影。

**位置**：[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) 的 `projectContextEntry`、`buildSessionProjection`；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_installAgentRequestProjection` 和其中的 `prepareRequest` 包装。

**下一步**：用目标 id 在 JSONL 和投影里对上条目；确认请求确实发生在编辑之后；确认旧内容不是来自压缩摘要。若编辑后仍破坏 toolCall/toolResult 配对，先恢复配对再重试。

**相关模块**：[M03 context_edit](03-session-and-context/README.md#m03-context-edit)、[M03 为什么每次请求都投影](03-session-and-context/README.md#m03-store)。

<a id="debug-over-window-after-compaction"></a>
## 7. 压缩后请求仍超上下文窗口

**症状**：已经出现压缩完成事件或摘要条目，下一次请求仍因上下文超限失败。

**最可能层**：压缩保留范围、系统提示/工具声明体积，或目标模型的真实窗口。

**证据**：

- 事件流先看 `compaction_start`/`compaction_end` 的 `reason`（`manual`、`threshold`、`overflow`）和结果；没有压缩事件，说明阈值没触发或被跳过，不一定是压缩失败。
- 最新 `compaction` 的 `firstKeptEntryId` 保留的原文尾部可能仍然太大；摘要本身也可能很长。
- system 提示、工具声明、项目上下文和扩展注入内容都算请求预算；只压缩消息不一定够。
- 虚拟模型要按路由后的物理模型容量检查；路由前用虚拟入口的泛化容量判断可能不准。`model.contextWindow <= 0` 时不会做阈值判断。
- 压缩用估算决定是否触发，估算与实际供应商 token 计数可能不同；检查 assistant 的 `usage` 和错误信息。

**位置**：[compaction.ts](../../../../packages/coding-agent/src/core/compaction/compaction.ts) 的 `shouldCompact`、`generateSummary`；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_exceedsCompactionThreshold`、`_compactBeforeNextAssistantResponse`、`_runAutoCompaction`；[model-runtime.ts](../../../../packages/coding-agent/src/core/model-runtime.ts) 的 `resolveModel`。

**下一步**：确认压缩是否真的完成；检查保留尾部和 system/tool 体积；确认物理模型和窗口；必要时减少工具声明、缩短保留尾部或换更大窗口的模型。不要只看“有 compaction 条目”就认定请求一定变小。

**相关模块**：[M03 压缩](03-session-and-context/README.md#m03-compaction)、[M04 虚拟模型与路由](04-model-access/README.md#m04-design)。

<a id="debug-stream-duplicate"></a>
## 8. 流式文本或最终消息重复

**症状**：界面上同一段文字出现两次，或者 JSON 客户端收到重复的最终消息。

**最可能层**：事件消费与渲染；如果 JSONL 也重复，才优先怀疑持久化/扩展。

**证据**：

- 正常 assistant 流是 `message_start`（草稿）-> 多次 `message_update`（增量/累计快照）-> `message_end`（权威完整消息）。JSON 传输会去掉 `message_update` 里的累计 `partial`，客户端应按增量拼接，并在 `message_end` 替换成完整内容，而不是再追加一条。
- TUI 应在同一个消息组件上更新；如果 `message_start` 每次都被当成新组件，或重复订阅了会话事件，就会重复渲染。
- 会话 JSONL 正常只在 `message_end` 保存一条 message 条目。如果 JSONL 里真的有两条相同 assistant 消息，检查扩展是否替换/重复触发、是否重复订阅、或是否有两个会话在写同一文件。
- `toolcall_start` 在 JSON 传输里带 `id`/`toolName`，但 `toolcall_delta` 仍只是参数片段，不能把每个 delta 当成完整消息。

**位置**：[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) 的 `streamAssistantResponse`；[json-event.ts](../../../../packages/coding-agent/src/modes/json-event.ts) 的 `toJsonEvent`；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_handleAgentEvent` 和 `message_end` 保存；[interactive-mode.ts](../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) 的 `handleEvent`。

**下一步**：先数 `message_start` 和 `message_end`，判断是事件本身重复还是渲染重复；再检查 JSONL 条目数。渲染问题在客户端/UI，持久化重复才回到会话层。

**相关模块**：[M02 事件序列](02-agent-loop/README.md#m02-events)、[M05 事件到界面](05-modes-and-tui/README.md#m05-interactive)。

<a id="debug-stuck-busy"></a>
## 9. 取消后界面仍卡在处理中

**症状**：已经按取消或回答看起来结束，界面一直显示工作中，`prompt()` 也不返回。

**最可能层**：会话收尾（重试、压缩、扩展 settle）或 UI 事件处理，不是低层流本身。

**证据**：

- 有 `agent_end` 但没有 `agent_settled`：低层 run 结束了，但会话还在重试、压缩、续跑或等待扩展 settle；`agent_end.willRetry` 为真时尤其要等后续。
- 有 `agent_settled { aborted: true }` 但界面仍忙：会话已经稳定，问题在 UI 没处理或没清理本地状态。
- 完全没有事件：可能卡在准备阶段、扩展的 settle 处理器，或压缩/摘要在等待模型；检查 stderr 的扩展错误和压缩事件。
- `Agent.waitForIdle()` 等的是低层 activeRun；`AgentSession.waitForIdle()` 等的是整个会话稳定。两者不能混用。

**位置**：[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_emitAgentSettled`、`abort`、`waitForIdle`；[agent.ts](../../../../packages/agent/src/agent.ts) 的 `finishRun`；[interactive-mode.ts](../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) 的 `handleEvent`。

**下一步**：先看事件流有没有 `agent_settled`。没有就查压缩、重试和扩展 settle；有就查 UI 的事件处理和忙碌标志。不要在 `agent_end` 就宣布空闲。

**相关模块**：[M02 生命周期](02-agent-loop/README.md#m02-events)、[M03 收尾](03-session-and-context/README.md#m03-misread)、[M05 交互模式](05-modes-and-tui/README.md#m05-interactive)。

<a id="debug-auth-routing"></a>
## 10. 认证失败或供应商路由异常

**症状**：请求报未配置认证、未知供应商，或者明显选的是 A，最后请求却到了 B。

**最可能层**：ModelRuntime 的认证/路由，或入口的模型选择。

**证据**：

- assistant 最终消息的 `provider`、`model`、`api` 是实际请求目标；`stopReason: "error"` 时读 `errorMessage`，例如未知 provider 或未配置认证。
- 虚拟模型会在请求前路由到物理模型；跨供应商路由会故意丢掉原供应商的 `apiKey`、`headers`、`env`，目标供应商必须能自己解析认证。
- 会话中的虚拟路由状态、`model_change` 条目和当前模型选择可以帮助判断是“选错了”还是“路由到了别处”。
- `--provider`、`--model` 控制选择；`--api-key` 只覆盖当前进程，不写持久凭证。不要把真实 key 打进日志或排障输出。

**位置**：[model-runtime.ts](../../../../packages/coding-agent/src/core/model-runtime.ts) 的 `prepareRequest`、`resolveModel`、`setRuntimeApiKey`；[auth-storage.ts](../../../../packages/coding-agent/src/core/auth-storage.ts)；[args.ts](../../../../packages/coding-agent/src/cli/args.ts) 的模型与 key 参数；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的虚拟模型分支。

**下一步**：先区分认证失败和路由错误。认证失败查目标 provider 的凭证来源；路由异常查虚拟模型回调和物理目标。需要控制变量时显式指定物理 `--provider`/`--model`，再比较结果。

**相关模块**：[M04 三个名字](04-model-access/README.md#m04-names)、[M04 认证与路由](04-model-access/README.md#m04-design)、[M01 入口与装配](01-entry-and-config/README.md)。

<a id="debug-tool-order"></a>
## 11. 并行工具结果顺序或 toolCallId 异常

**症状**：并行工具的结果顺序看起来和完成顺序不一致，或者某个结果对不上原来的工具调用。

**最可能层**：Agent 工具批次的并行执行与结果消息排序。

**证据**：

- 并行批次会先按源顺序做准备，再并发执行；`tool_execution_end` 按实际完成顺序发布，toolResult 消息则在本批全部完成后按 assistant 源顺序发布。结束事件乱序是设计行为，消息乱序才是问题。
- 用 `toolCallId` 配对，不要用 `tool_execution_end` 的先后位置推断结果属于哪个调用。
- 被阻止、参数失败或 `length` 截断的调用仍可能有开始/结束事件，但不会执行工具；它们的结果仍应带原调用 id。
- 如果 toolResult 的 id 在 assistant 的 toolCall 中找不到，检查持久化或结果构造是否拿错了调用 id；扩展的 `tool_result`/`afterToolCall` 能改内容、详情、错误标志等，但不能改 id。

**位置**：[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) 的 `executeToolCallsParallel`、`executeToolCallsSequential`、`createToolResultMessage`；[types.ts](../../../../packages/agent/src/types.ts) 对 `ToolExecutionMode` 的说明。

**下一步**：先按 id 重建配对表，再比较 `tool_execution_end` 顺序和 JSONL 里 toolResult 的源顺序。结束事件按完成时间、结果消息按源顺序，这是两个不同的观察维度。

**相关模块**：[M02 工具执行](02-agent-loop/README.md#m02-walk-tools)、[M02 事件序列](02-agent-loop/README.md#m02-events)。

<a id="debug-rpc-stdout"></a>
## 12. RPC stdout 混入普通日志

**症状**：RPC 客户端解析 stdout 失败，发现 JSON 之外还有普通日志、扩展输出或子进程输出。

**最可能层**：模式与输出协议，不是会话逻辑。

**证据**：

- RPC 启动时会接管 stdout，普通 stdout 写入被转到 stderr；协议输出走单独的原始 stdout 队列。因此先确认污染行来自 stderr 混读、直接写文件描述符，还是子进程继承了 stdout。
- 逐行解析 stdout；非 JSON 行就是协议污染。不要把 stdout 和 stderr 合并后再判断。
- 扩展的 `console.log`、子进程默认 stdout、或直接写 fd 1 的代码都可能绕过重定向。
- JSON 打印模式也使用原始 stdout 输出事件，但它不是 RPC 的命令协议；不要把两者混用。

**位置**：[rpc-mode.ts](../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) 的 `takeOverStdout`；[output-guard.ts](../../../../packages/coding-agent/src/core/output-guard.ts) 的 `takeOverStdout`、`writeRawStdout`、`waitForRawStdoutBackpressure`；[print-mode.ts](../../../../packages/coding-agent/src/modes/print-mode.ts) 的 JSON 输出。

**下一步**：分别捕获 stdout/stderr，按行 JSON.parse；检查扩展和子进程的 stdio 配置；普通日志改走 stderr，协议输出只由模式层写。

**相关模块**：[M05 RPC 模式](05-modes-and-tui/README.md#m05-rpc)、[M05 打印模式](05-modes-and-tui/README.md#m05-print)。

<a id="debug-extension-hooks"></a>
## 13. 扩展钩子没有触发

**症状**：扩展注册的工具、命令或事件处理器没有执行，或者工具没有被拦截。

**最可能层**：扩展加载/信任、会话绑定，或事件名不匹配。

**证据**：

- 项目未受信任时，项目级扩展不会被求值；先确认扩展是否真的加载。
- 当前会话是否调用了 `bindExtensions`；切换到新会话后是否重新绑定。只在旧会话上注册的订阅不会跟着新会话走。
- 扩展 API 的工具事件名是 `tool_call` 和 `tool_result`；`beforeToolCall`、`afterToolCall`、`prepareRequest`、`prepareNextTurn`、`finishTurn` 是 Agent 层钩子名，不要拿它们去注册扩展事件。
- 事件已经发生后再注册处理器，不会补发历史事件。
- stderr 里的扩展错误（例如 `Extension error (path): ...`）说明加载或处理器执行失败；不要只看 stdout。

**位置**：[extensions/types.ts](../../../../packages/coding-agent/src/core/extensions/types.ts) 的 `ExtensionAPI.on` 重载；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `_emitExtensionEvent` 和 `bindExtensions`；[print-mode.ts](../../../../packages/coding-agent/src/modes/print-mode.ts) 的 `rebindSession`；[interactive-mode.ts](../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) 的绑定流程；[project-trust.ts](../../../../packages/coding-agent/src/core/project-trust.ts)。

**下一步**：确认扩展加载和项目信任，确认 `bindExtensions` 发生在事件之前，确认事件名和注册时机，最后看 stderr 的扩展错误。要在 Agent 层拦截工具，应使用 Agent 钩子或对应的扩展工具事件，不要混用名字。

**相关模块**：[M01 信任与扩展](01-entry-and-config/README.md)、[M03 事件持久化](03-session-and-context/README.md#m03-store)、[M05 模式绑定](05-modes-and-tui/README.md)。

<a id="debug-mode-difference"></a>
## 14. 同一 prompt 在 text/json/interactive 表现不同

**症状**：同一条输入在打印、JSON、交互或 RPC 下输出、工具展示或结束状态不一样。

**最可能层**：入口的模式选择和前端输出层，不一定是模型行为不同。

**证据**：

- 模式解析优先顺序是：`--mode rpc`、`--mode json`、`-p` 或 stdin/stdout 非 TTY 走打印，其余走交互。管道输入会把原本的交互启动变成打印，这是常见差异来源。
- text 只打印最后一条 assistant 的 text 块；JSON 输出所有会话事件；interactive 实时渲染事件并支持流式 steer/followUp；RPC 走命令/响应协议。底层都可以调用同一个 `AgentSession.prompt()`。
- 输出格式、stderr、退出码、工具展示和取消交互不同，不代表模型上下文不同；要比较模型行为，应该比较 JSON 事件和会话 JSONL/投影。
- 交互模式下流式输入必须带 `streamingBehavior`；打印模式没有这个交互层。

**位置**：[main.ts](../../../../packages/coding-agent/src/main.ts) 的 `resolveAppMode`；[print-mode.ts](../../../../packages/coding-agent/src/modes/print-mode.ts)；[interactive-mode.ts](../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts)；[rpc-mode.ts](../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts)；[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) 的 `streamingBehavior` 分支。

**下一步**：需要可比较的规范观察时，先用 `pi --mode json -p "..."` 固化事件流；确认 TTY 和 `-p` 没有改变模式；再比较会话 JSONL、模型选择和投影。不要直接拿 text 的最终文本和 TUI 的实时渲染做逐字比较。

**相关模块**：[M05 三种模式对比](05-modes-and-tui/README.md#m05-compare)、[M01 参数与模式](01-entry-and-config/README.md#m01-example)、[M03 投影](03-session-and-context/README.md#m03-store)。
