# M05 模式与 TUI

<a id="m05-goals"></a>
## 学完能回答

- 为什么单独写 `--mode text` 不保证进入一次性打印？`AppMode` 的四个值和实际判断顺序是什么？见 [大白话总览](#m05-plain) 与 [main.ts:203](../../../../../packages/coding-agent/src/main.ts#L203 "function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {")。
- text 和 json 的 stdout、退出码、完成信号各有什么差异？为什么模型的 `error` 事件不必然让 json 模式返回非零？见 [打印模式](#m05-print) 与 [runPrintMode 逐步走](#m05-walk-print)。
- 交互模式为什么先 `ui.start()` 再绑定扩展？为什么先渲染历史，再由 `run()` 发送命令行初始消息？见 [init 按代码顺序](#m05-walk-interactive) 与 [run 按代码顺序](#m05-walk-run)。
- `getUserInput()` 不读 stdin，为什么界面在等待输入时仍然响应快捷键和滚动？它的 Promise 由谁 resolve？见 [getUserInput 怎么等](#m05-walk-input)。
- JSON/RPC 里的 `message_update` 为什么通常不带 `partial`？哪两种子事件是例外？见 [json 的 JSONL](#m05-example-json) 与 [json-event.ts:82](../../../../../packages/coding-agent/src/modes/json-event.ts#L82 "export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {")。
- `turn_end`、`agent_end`、`agent_settled` 各代表什么？为什么交互界面没有针对 `turn_end` 的专门分支？见 [事件 -> 界面](#m05-event-map)。
- RPC 的 `prompt` 成功响应为什么不等于回答完成？为什么响应顺序不能按 stdin 的写入顺序推断？见 [一次 prompt 的完整顺序](#m05-walk-rpc) 与 [多行并发和顺序](#m05-rpc-concurrency)。
- RPC 在 `new_session` 或 `fork` 之后如何保证事件来自新会话？为什么可能观察到两次扩展绑定？见 [会话替换后的重新订阅](#m05-rpc-rebind)。

<a id="m05-duty"></a>
## 一句话职责

用三种不同的前端驱动同一个 `AgentSession`：打印模式输出最终文本或 JSON 事件，交互模式提供常驻终端界面，RPC 模式从 stdin 接收 JSON 命令并输出 JSONL 事件。

这里的“三种”指运行形态：一次性打印、常驻 TUI、常驻 RPC。打印形态内部又分 `text` 和 `json` 两种输出格式，所以 `AppMode` 实际有四个字符串值：`interactive`、`print`、`json`、`rpc`。

<a id="m05-position"></a>
## 在链路中的位置

### 上游

- [M01 入口与装配](../01-entry-and-config/README.md)：`main()` 创建 `runtime` 后按 `appMode` 分派。
- 模式选择本身在 [main.ts:203](../../../../../packages/coding-agent/src/main.ts#L203 "function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {")，调用点在 [main.ts:1131](../../../../../packages/coding-agent/src/main.ts#L1131 "let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);")。
- 终端、stdin/stdout、编辑器扩展。
- 非交互模式在 [main.ts:1137](../../../../../packages/coding-agent/src/main.ts#L1137 "takeOverStdout();") 接管 stdout，普通 `console.log` 会改走 stderr，协议输出则使用 `writeRawStdout`。普通帮助或模型列表命令是例外，不接管。

### 下游

- [M03 会话与上下文](../03-session-and-context/README.md)：调用 `session.prompt()`、`session.subscribe()`、`session.bindExtensions()`。
- [M02 Agent 循环](../02-agent-loop/README.md)：通过会话事件间接观察循环。
- 渲染组件：聊天视口、编辑器、状态行、工具展示。

事件链的中间点是 [agent-session.ts:1872](../../../../../packages/coding-agent/src/core/agent-session.ts#L1872 "private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {")：低层 Agent 的事件先经过会话层，再由 [agent-session.ts:1746](../../../../../packages/coding-agent/src/core/agent-session.ts#L1746 "private _emit(event: AgentSessionEvent): void {") 同步分发给公开订阅者。模式层只消费这些事件，不生产模型事件。

对应全链路：[S2 模式分派](../00-full-chain/README.md#m00-s2)、[S4 打印模式](../00-full-chain/README.md#m00-s4)、[S13 收尾](../00-full-chain/README.md#m00-s13)、[交互模式](../00-full-chain/README.md#m00-interactive)。

<a id="m05-plain"></a>
## 大白话总览

把 `AgentSession` 想成后厨：模型请求、工具执行、消息持久化都在后厨完成。本模块是三种取餐口：

- `text` / `json` 是打包带走：下单一次，做完就关店。
- `interactive` 是堂食：界面常驻，反复下单，边做边看。
- `rpc` 是给另一个程序用的取餐窗口：对方用一行行 JSON 下单，店里用一行行 JSON 回报事件。

取餐口不改变菜怎么做，只改变怎么下单、怎么把结果交出去。

| 问题 | 负责者 |
| --- | --- |
| 保存对话、恢复会话、生成上下文 | `AgentSession` 和 `SessionManager`，见 [M03](../03-session-and-context/README.md) |
| 调用模型、执行工具、产生流式事件 | Agent 循环和工具管线，见 [M02](../02-agent-loop/README.md) |
| 选择 `interactive` / `print` / `json` / `rpc` | `main.ts` 的 `resolveAppMode` |
| 执行一次性 text/json | `runPrintMode` |
| 创建、启动、驱动 TUI | `InteractiveMode` 的构造器、`init()`、`run()` |
| 执行 RPC 命令循环 | `runRpcMode` |
| 把事件画成组件或写成 JSONL | 本模块的监听器和渲染组件 |

一次空闲输入的完整路径如下：

1. 用户在编辑器按 Enter，[setupEditorSubmitHandler:5584](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5584 "private setupEditorSubmitHandler(): void {") 判断当前不在流式输出，也没有在压缩。
2. 提交处理器调用 `onInputCallback`，或者把文字放进 `pendingUserInputs`。
3. [run:2042](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2042 "async run(): Promise<void>") 的主循环从 `getUserInput()` 拿到文字，调用 `session.prompt(userInput)`，位置在 [interactive-mode.ts:2216](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2216 "await this.session.prompt(userInput)")。
4. `AgentSession` 跑扩展预检、组装上下文，交给 Agent 循环；这一步不在 M05。
5. Agent 每产生一个事件，`_handleAgentEvent` 先让扩展处理，再调用 `_emit` 通知公开订阅者，然后在 `message_end` 时持久化消息。
6. 交互模式把事件映射成组件更新；JSON/RPC 把事件写成一行 JSON；text 模式不逐事件输出，只在最后取消息数组最后一项，并且仅当它是 assistant 时打印。

注意第 5 步的顺序：公开监听器先收到 `message_end`，消息随后才写入会话。界面看到“消息结束”时，磁盘写入通常紧接着发生，但事件本身不代表已经落盘。

模式选择的顺序是固定的：

| 判断顺序 | 条件 | `appMode` |
| --- | --- | --- |
| 1 | `--mode rpc` | `rpc` |
| 2 | `--mode json` | `json` |
| 3 | `-p`，或 stdin/stdout 不是 TTY | `print` |
| 4 | 以上都不满足 | `interactive` |

显式 `--mode json` 优先于管道推断；`-p` 和管道只决定是否走一次性打印。打印路径最终由 `toPrintOutputMode` 把非 json 的情况映射成 `text`。因此要一次性文本输出，用 `-p`，不要只写 `--mode text`。

本模块不负责这些事：

- 不实现模型调用、重试、工具执行或上下文压缩。
- 不决定 system prompt、工具列表、技能和模板如何组装。
- 不把消息写进会话文件；它只消费 `message_end` 等事件。
- 不把 TUI 当 Agent。关掉界面、切换渲染器、滚动聊天，都不会改变会话内容。
- RPC 不是 HTTP 服务，也不监听网络端口；它只读写当前进程的 stdin/stdout。

<a id="m05-terms"></a>
## 关键概念

| 概念 | 含义 | 具体例子 |
| --- | --- | --- |
| `AppMode` | 宿主运行模式的字符串联合 | `pi --mode json -p "..."` 得到 `json`；`pi | cat` 因为 stdout 不是 TTY 得到 `print` |
| print / text | 一次性执行，最终只输出消息数组最后一项（仅当它是 assistant）的 text 块 | `pi -p "读取 README.md 前 20 行并总结"` |
| json | 一次性执行，但 stdout 是事件 JSONL | `pi --mode json -p "..."` 第一行是会话头，之后一行一个事件 |
| interactive | 常驻终端界面，反复输入 | 直接运行 `pi`，出现页头、编辑器、页脚 |
| rpc | 常驻协议模式，stdin 收命令，stdout 写响应和事件 | `pi --mode rpc`，客户端发送 `{"id":"req-1","type":"prompt","message":"..."}` |
| `AgentEvent` | 低层 Agent 发出的事件，见 [agent/src/types.ts:647](../../../../../packages/agent/src/types.ts#L647 "export type AgentEvent =") | `agent_start`、`turn_start`、`message_update`、`tool_execution_end` |
| `AgentSessionEvent` | 在低层事件之外补上会话层事件的公开联合，见 [agent-session.ts:245](../../../../../packages/coding-agent/src/core/agent-session.ts#L245 "export type AgentSessionEvent =") | `agent_settled`、`queue_update`、`compaction_start`、`entry_appended` |
| TUI | 终端组件树和输入输出的总称 | `CustomEditor`、聊天容器、页脚都挂在一棵 TUI 组件树上 |
| 主屏 | `regular` 模式使用的普通终端屏幕，内容留在 scrollback | 退出 `pi` 后，刚才的聊天仍能在终端历史里向上翻到 |
| 备用屏 | `fullscreen` 模式使用的 alternate screen，退出时恢复进入前的屏幕 | 全屏会话按退出后，shell 里不会多出一整段聊天记录 |
| 输入编辑器 | `CustomEditor`，负责文字编辑、补全、历史、快捷键分派 | 输入 `/` 出现命令补全；按 Enter 触发 `onSubmit` |
| 状态行 | 页脚加上编辑器边框里的工作指示器，不是单个组件 | 页脚显示 `~/pi (main) ↑12k ↓1.4k 18.4%/200k (auto) claude-sonnet-4-5 high`；边框里显示 working、retry 或 compaction |
| steering | 当前回答还没结束时插入的输入，插在当前工具批次之后、下一次模型请求之前 | 用户输入“改用表格”，当前工具跑完后模型看到这条插话 |
| followUp | 当前运行自然结束后再处理的输入 | 用户按 Alt+Enter 输入“完成后总结”，当前 run 停止后才开始处理 |
| backpressure | 等本地 stdout 写队列追上，避免事件无限堆积 | 下游读得很慢时，JSON/RPC 模式在事件之间等待，而不是把整轮流缓存在内存 |
| 扩展绑定 | 把扩展命令、UI 上下文、退出和错误处理器接到当前会话 | `bindExtensions({ mode: "rpc", uiContext, ... })`；print/json 绑定的是非交互模式 |
| 会话替换 | 扩展或 RPC 命令新建、切换、分叉会话后，模式层重新订阅新会话 | RPC 的 `new_session` 成功后调用 `rebindSession`，`runtimeHost.session` 变成新对象 |

<a id="m05-example"></a>
## 运行示例

同一个问题，用四种方式驱动：

```bash
# 打印模式：执行一次，输出最终文本
pi -p "读取 README.md 前 20 行并总结"

# JSON 模式：执行一次，输出事件流
pi --mode json -p "读取 README.md 前 20 行并总结"

# 交互模式：常驻，多轮
pi
> 读取 README.md 前 20 行并总结

# RPC 模式：常驻，从 stdin 读 JSON 命令
pi --mode rpc
```

下面的回答内容、时间戳、ID 和 token 数是示例值；字段名来自源码类型。实际运行时模型和用量会不同，但协议外形不变。

<a id="m05-example-text"></a>
### text 的最终输出

```text
README.md 的前 20 行主要介绍了项目定位、安装方式和基本用法。

- 项目通过 npm 安装。
- 主要入口是 pi 命令。
- 更多配置见 docs。
```

text 模式在全部 prompt 结束后读取 `session.state.messages` 的最后一条。只有最后一条是 assistant 时，才遍历它的 text 块并逐个写到 stdout。工具调用、thinking、早期轮次的 assistant 文本都不会出现在这里。

<a id="m05-example-json"></a>
### json 的 JSONL

第一行是会话头，不是事件：

```json
{"type":"session","version":3,"id":"0192f1c4-7d2a-7c3b-9e10-123456789abc","timestamp":"2026-11-06T08:00:00.000Z","cwd":"/Users/baiml/PycharmProjects/pi"}
```

之后每个事件一行：

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"读取 README.md 前 20 行并总结"}],"timestamp":1762416000000}}
{"type":"message_update","usage":{"input":120,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":122,"cost":{"input":0.00036,"output":0.00003,"cacheRead":0,"cacheWrite":0,"total":0.00039}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"README"}}
{"type":"message_update","usage":{"input":140,"output":18,"cacheRead":0,"cacheWrite":0,"totalTokens":158,"cost":{"input":0.00042,"output":0.00027,"cacheRead":0,"cacheWrite":0,"total":0.00069}},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_01","toolName":"read"}}
{"type":"tool_execution_start","toolCallId":"call_01","toolName":"read","args":{"path":"README.md","limit":20}}
{"type":"tool_execution_end","toolCallId":"call_01","toolName":"read","result":{"content":[{"type":"text","text":"1\t# pi\n..."}],"details":{}},"isError":false,"durationMs":12}
{"type":"agent_settled","aborted":false}
```

观察这几行：

- `message_start` 和 `message_end` 携带完整 `message`；`message_update` 默认只带累计 `usage` 和本次 `assistantMessageEvent`，不带越来越大的 `partial` 快照。
- `toolcall_start` 原本没有工具 id 和名字，转换时会从 `partial.content[contentIndex]` 取出 `id` 和 `toolName` 补上。因此这一行能直接开始组装工具调用，不必等完整消息。
- `tool_execution_start` 的 `args` 和 `tool_execution_end` 的 `result` 是工具层数据；`result` 是 `{ content, details }`，不是完整的 `toolResult` 消息。
- `agent_end` 也在协议里，但它的会话版字段是 `messages` 和 `willRetry`；真正表示“会话已结算、可以空闲”的是 `agent_settled`。

`message_update` 里的 `done` 和 `error` 是特例：`toJsonEvent` 仍会重建顶层对象、丢掉顶层 `message`，但内层 `assistantMessageEvent` 不带 `partial`，所以原样保留。`done` 的内层事件带最终 `message`，`error` 的内层事件带 `error`。不要笼统地说“所有 `message_update` 都没有完整消息”。

<a id="m05-example-interactive"></a>
### interactive 的屏幕变化

用户提交后，界面按事件依次变化：

1. `message_start`（user）：用户消息立即出现在聊天区，等待区里的同一条文字被移除。
2. `message_start`（assistant）：创建流式助手组件，内容是空的或只有初始片段。
3. `message_update`（text_delta）：同一个助手组件不断更新，看起来是逐字出现。
4. `message_update`（toolcall_start）：创建一个工具行，例如 `read README.md`。这时工具还没执行，只是模型已经生成了调用。
5. `tool_execution_start` / `tool_execution_update` / `tool_execution_end`：工具行进入执行中、显示进度、最后显示结果或错误。
6. `message_start` / `message_update`（第二轮 assistant）：工具结果回到模型后，助手继续输出总结。
7. `message_end`：最终消息固定下来，页脚失效并等待下一次读取。
8. `agent_end`：结束工作指示器和本轮低层运行显示。
9. `agent_settled`：检查是否有退出请求；没有的话，界面真正回到可以接受下一条空闲输入的状态。

工具行在第 4 步出现，早于第 5 步的执行事件。看到工具行不代表工具已经开始跑。

<a id="m05-example-rpc"></a>
### rpc 的请求与响应

启动：

```bash
pi --mode rpc
```

客户端向 stdin 写一行：

```json
{"id":"req-1","type":"prompt","message":"读取 README.md 前 20 行并总结"}
```

stdout 先出现受理响应，随后是事件：

```json
{"id":"req-1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"读取 README.md 前 20 行并总结"}],"timestamp":1762416000000}}
{"type":"message_update","usage":{"input":120,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":122,"cost":{"input":0.00036,"output":0.00003,"cacheRead":0,"cacheWrite":0,"total":0.00039}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"README"}}
{"type":"agent_settled","aborted":false}
```

运行中再发一条插话：

```json
{"id":"req-2","type":"steer","message":"只保留三条结论"}
```

对应响应：

```json
{"id":"req-2","type":"response","command":"steer","success":true,"data":{"disposition":"queued"}}
```

`disposition` 可能是 `started`、`queued` 或 `handled`。`handled` 表示扩展命令或输入钩子已经消费了这条输入，不一定会开始新的 Agent run。

RPC 不输出会话头。客户端如果需要会话 id、模型、是否正在流式、队列长度等信息，发 `get_state` 命令，读 `RpcSessionState`。`prompt` 的成功响应只表示输入已被受理，不表示回答已经完成；完成与否要看后续事件和 `agent_settled`。

<a id="m05-files"></a>
## 文件路由

| 文件 | 职责 |
| --- | --- |
| [modes/print-mode.ts](../../../../../packages/coding-agent/src/modes/print-mode.ts "print-mode.ts") | text/json 一次性执行 |
| [modes/json-event.ts](../../../../../packages/coding-agent/src/modes/json-event.ts "json-event.ts") | 会话事件 -> JSON 记录 |
| [modes/rpc/rpc-mode.ts](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts "rpc-mode.ts") | stdin 命令循环、stdout 响应 |
| [modes/rpc/rpc-types.ts](../../../../../packages/coding-agent/src/modes/rpc/rpc-types.ts "rpc-types.ts") | RPC 命令/响应类型 |
| [modes/interactive/interactive-mode.ts](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts "interactive-mode.ts") | 交互主控制器：初始化、输入、事件、命令 |
| [modes/interactive/tui-renderer.ts](../../../../../packages/coding-agent/src/modes/interactive/tui-renderer.ts "tui-renderer.ts") | 主屏/备用屏、终端适配 |
| [modes/interactive/chat-viewport.ts](../../../../../packages/coding-agent/src/modes/interactive/chat-viewport.ts "chat-viewport.ts") | 聊天区域滚动与渲染 |
| [modes/interactive/components/custom-editor.ts](../../../../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts "custom-editor.ts") | 输入编辑器 |
| [modes/interactive/program-status-reporter.ts](../../../../../packages/coding-agent/src/modes/interactive/program-status-reporter.ts "program-status-reporter.ts") | 把运行、错误、压缩状态上报给终端 |
| [core/keybindings.ts](../../../../../packages/coding-agent/src/core/keybindings.ts "keybindings.ts") | 可配置快捷键 |
| [core/output-guard.ts](../../../../../packages/coding-agent/src/core/output-guard.ts "output-guard.ts") | 原始 stdout 写入、接管与背压等待 |
| [modes/interactive/theme/theme.ts](../../../../../packages/coding-agent/src/modes/interactive/theme/theme.ts "theme.ts") | 主题与颜色 |

<a id="m05-routes"></a>
## 函数路由

### 打印与 JSON

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M05.print.run` | `runPrintMode` | [print-mode.ts:50](../../../../../packages/coding-agent/src/modes/print-mode.ts#L50 "export async function runPrintMode(") | 绑定扩展、提交输入、输出结果 |
| `M05.print.rebind` | `rebindSession` | [print-mode.ts:115](../../../../../packages/coding-agent/src/modes/print-mode.ts#L115 "const rebindSession = async (): Promise<void> => {") | 会话替换后重新绑定扩展和订阅 |
| `M05.print.subscribe` | `session.subscribe` | [print-mode.ts:165](../../../../../packages/coding-agent/src/modes/print-mode.ts#L165 "session.subscribe((event)") | JSON 模式写事件；text 模式不逐事件输出 |
| `M05.print.backpressure` | `session.agent.subscribe` | [print-mode.ts:175](../../../../../packages/coding-agent/src/modes/print-mode.ts#L175 "session.agent.subscribe(async () => {") | 低层事件后等待 stdout 写队列 |
| `M05.print.header` | `getHeader` | [print-mode.ts:186](../../../../../packages/coding-agent/src/modes/print-mode.ts#L186 "const header = session.sessionManager.getHeader();") | JSON 第一行写会话头 |
| `M05.print.prompt` | `session.prompt` | [print-mode.ts:199](../../../../../packages/coding-agent/src/modes/print-mode.ts#L199 "await session.prompt(initialMessage") | 提交首句 |
| `M05.print.more` | `session.prompt` | [print-mode.ts:204](../../../../../packages/coding-agent/src/modes/print-mode.ts#L204 "await session.prompt(message)") | 串行提交后续消息 |
| `M05.print.final` | `lastMessage` | [print-mode.ts:211](../../../../../packages/coding-agent/src/modes/print-mode.ts#L211 "const lastMessage = state.messages[state.messages.length - 1];") | text 模式取最后一条消息 |
| `M05.json.event` | `toJsonEvent` | [json-event.ts:82](../../../../../packages/coding-agent/src/modes/json-event.ts#L82 "export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {") | 会话事件转传输形状 |

### 交互模式

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M05.interactive.run` | `InteractiveMode.run` | [interactive-mode.ts:2042](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2042 "async run(): Promise<void>") | 初始化、首句、主循环 |
| `M05.interactive.init` | `InteractiveMode.init` | [interactive-mode.ts:1713](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1713 "async init(): Promise<void>") | 启动 TUI、绑定扩展、准备渲染 |
| `M05.interactive.rebind` | `rebindCurrentSession` | [interactive-mode.ts:3768](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3768 "private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {") | 会话替换后重画、重绑、重订阅 |
| `M05.interactive.submit` | `setupEditorSubmitHandler` | [interactive-mode.ts:5584](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5584 "private setupEditorSubmitHandler(): void {") | 编辑器提交分派：命令、Bash、压缩、steer、空闲输入 |
| `M05.interactive.input` | `getUserInput` | [interactive-mode.ts:7459](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7459 "async getUserInput(): Promise<string>") | 等待用户提交 |
| `M05.interactive.prompt` | `session.prompt` | [interactive-mode.ts:2216](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2216 "await this.session.prompt(userInput)") | 主循环提交 |
| `M05.interactive.subscribe` | `subscribeToAgent` | [interactive-mode.ts:5936](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5936 "private subscribeToAgent()") | 订阅会话事件 |
| `M05.interactive.event` | `handleEvent` | [interactive-mode.ts:5948](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5948 "private async handleEvent(event: AgentSessionEvent)") | 事件 -> 组件更新 |
| `M05.interactive.steer` | `session.prompt(steer)` | [interactive-mode.ts:5906](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5906 "streamingBehavior: \"steer\"") | 流式期间插话 |
| `M05.interactive.followup` | `session.prompt(followUp)` | [interactive-mode.ts:7850](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7850 "streamingBehavior: \"followUp\"") | 本轮结束后追问 |
| `M05.interactive.followupHandler` | `handleFollowUp` | [interactive-mode.ts:7816](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7816 "private async handleFollowUp(): Promise<void> {") | Alt+Enter 的追问处理入口 |

### RPC 与 TUI 基础设施

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M05.rpc.run` | `runRpcMode` | [rpc-mode.ts:69](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L69 "export async function runRpcMode(") | stdin 命令循环 |
| `M05.rpc.rebind` | `rebindSession` | [rpc-mode.ts:498](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L498 "const rebindSession = async (): Promise<void> => {") | 会话替换后重绑扩展和订阅 |
| `M05.rpc.command` | `handleCommand` | [rpc-mode.ts:619](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L619 "const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {") | RPC 命令分派 |
| `M05.rpc.input` | `handleInputLine` | [rpc-mode.ts:1196](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L1196 "const handleInputLine = async (line: string) => {") | 一行 stdin 的解析、处理、响应 |
| `M05.tui.create` | `createInteractiveTui` | [tui-renderer.ts:41](../../../../../packages/coding-agent/src/modes/interactive/tui-renderer.ts#L41 "export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {") | 按模式创建主屏/备用屏 |
| `M05.tui.reference` | `createInteractiveTuiReference` | [tui-renderer.ts:95](../../../../../packages/coding-agent/src/modes/interactive/tui-renderer.ts#L95 "export function createInteractiveTuiReference(getTui: () => TUI): TUI {") | 渲染器替换后组件仍可用的稳定代理 |
| `M05.tui.viewport` | `createChatViewport` | [chat-viewport.ts:39](../../../../../packages/coding-agent/src/modes/interactive/chat-viewport.ts#L39 "export function createChatViewport(options: ChatViewportOptions): ChatViewport {") | 聊天滚动区加底部输入 dock |
| `M05.tui.editor` | `CustomEditor` | [custom-editor.ts:20](../../../../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L20 "export class CustomEditor extends Editor") | 输入、补全、历史 |
| `M05.tui.input` | `CustomEditor.handleInput` | [custom-editor.ts:147](../../../../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L147 "handleInput(data: string): void {") | 输入按键的分派顺序 |
| `M05.keys` | `KEYBINDINGS` | [keybindings.ts:228](../../../../../packages/coding-agent/src/core/keybindings.ts#L228 "export const KEYBINDINGS") | 默认快捷键定义 |
| `M05.keys.load` | `KeybindingsManager.create` | [keybindings.ts:428](../../../../../packages/coding-agent/src/core/keybindings.ts#L428 "static create(agentDir: string = getAgentDir()): KeybindingsManager {") | 读取用户快捷键配置 |

### 输出保护与背压

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M05.output.takeover` | `takeOverStdout` | [output-guard.ts:84](../../../../../packages/coding-agent/src/core/output-guard.ts#L84 "export function takeOverStdout(): void {") | 普通 stdout 改走 stderr，保留原始 stdout |
| `M05.output.write` | `writeRawStdout` | [output-guard.ts:150](../../../../../packages/coding-agent/src/core/output-guard.ts#L150 "export function writeRawStdout(text: string): void {") | 把协议文字排进串行写链 |
| `M05.output.backpressure` | `waitForRawStdoutBackpressure` | [output-guard.ts:167](../../../../../packages/coding-agent/src/core/output-guard.ts#L167 "export async function waitForRawStdoutBackpressure(): Promise<void> {") | 等写链追上当前尾部 |
| `M05.output.flush` | `flushRawStdout` | [output-guard.ts:184](../../../../../packages/coding-agent/src/core/output-guard.ts#L184 "export async function flushRawStdout(): Promise<void> {") | 退出前排空已排队输出 |

<a id="m05-compare"></a>
## 三种模式对比

| 维度 | text | json | interactive | rpc |
| --- | --- | --- | --- | --- |
| 输入 | argv | argv | 编辑器 | stdin JSON 命令 |
| 输出 | 最终 assistant 文本 | 会话事件 JSONL | TUI | 响应/事件 JSONL |
| 生命周期 | 一次执行后退出 | 一次执行后退出 | 常驻 | 常驻 |
| 多轮 | 命令行多条消息串行 | 同 text | 主循环 | 命令驱动 |
| 工具展示 | 不展示，只在最终文本里体现 | 事件里有 | 组件展示 | 事件里有 |
| 适用 | 脚本、CI | 集成、日志 | 人机交互 | 编辑器/IDE 插件 |

`text` 和 `json` 都由 `runPrintMode` 实现，靠 `mode` 参数区分。`rpc` 和 `interactive` 是独立入口。

再补几行实现层差异：

| 维度 | text | json | interactive | rpc |
| --- | --- | --- | --- | --- |
| stdout 首行 | 结束时才写正文 | 会话头 | 无协议输出 | 无会话头，首行是响应或事件 |
| stdout 保护 | `main` 接管普通 stdout | 同 text | 不接管 | `main` 接管，`runRpcMode` 再调用一次（幂等） |
| 背压 | 无 | Agent 事件后等待写队列 | 无 stdout 背压，渲染帧合并 | 始终等待写队列 |
| 完成信号 | 进程退出码 | 进程退出码 | `agent_settled` 加主循环 | 受理响应加事件，最终看 `agent_settled` |

<a id="m05-print"></a>
## 打印模式

`runPrintMode` 同时实现 text 和 json。进入函数前，`main` 已经对非交互模式调用过 `takeOverStdout`；因此普通日志写到 stderr，最终正文或 JSON 事件通过 `writeRawStdout` 写原始 stdout，不会被日志污染。

<a id="m05-print-text"></a>
### text

`runPrintMode` 在最后一条 prompt 结束后读取 `session.state.messages` 的最后一条：

```ts
const lastMessage = state.messages[state.messages.length - 1];
if (lastMessage?.role === "assistant") {
  for (const content of lastMessage.content) {
    if (content.type === "text") writeRawStdout(`${content.text}\n`);
  }
}
```

它只读取消息数组最后一项，并且只有该项是 assistant 时才打印 text 块；中间轮次的工具调用、思考或早期 assistant 文本不会作为正文输出。

| 情况 | 输出 | 退出码 |
| --- | --- | --- |
| 最后一项是 assistant 且正常结束 | 所有 text 块，每块后加换行 | 0 |
| 最后一项是 assistant，`stopReason` 是 `error` 或 `aborted` | stderr 写 `errorMessage` 或 `Request <stopReason>` | 1 |
| 最后一项是 assistant，`stopReason` 是 `length` | 先打印已有 text，再在 stderr 说明截断 | 1 |
| 最后一项不是 assistant（例如停在 toolResult） | 不输出正文 | 0 |
| 任一 `session.prompt` 抛出 | stderr 写错误文字，后续消息不再发送 | 1 |

“退出码 0”只表示这个函数没有走到上面的失败分支，不保证模型完成了用户任务。

<a id="m05-print-json"></a>
### json

JSON 模式在 [print-mode.ts:165](../../../../../packages/coding-agent/src/modes/print-mode.ts#L165 "session.subscribe((event)") 订阅会话事件，把每个事件转换成一行 JSON。它在绑定扩展和订阅之前先写会话头，所以第一行一定是头，而不是某个事件。

它还监听 stdout 背压：Agent 产生事件太快而 stdout 写不出去时，等待写队列，避免内存无限增长。

JSON 模式适合被其他程序解析，不适合人读。它不会因为最后一条 assistant 的 `stopReason` 是 `error` 或 `length` 就修改退出码；模型错误本身已经作为事件发出。只有 `session.prompt` 抛出或外层 catch 捕获异常时，函数才返回 1。

<a id="m05-walk-print"></a>
### runPrintMode 逐步走

1. 解构 `mode`、`messages`（默认空数组）、`initialMessage`、`initialImages`，记录 `exitCode = 0`，并保存 `session = runtimeHost.session`。
2. 注册 SIGTERM 和非 Windows 的 SIGHUP 处理器；注册 `runtimeHost.setRebindSession`，让扩展触发会话替换时能重新绑定。
3. 如果是 json，先通过 `session.sessionManager.getHeader()` 取会话头并写一行；没有头就不伪造。
4. 调用 `rebindSession`：读取宿主当前会话，`bindExtensions` 绑定扩展，扩展模式为 `"json"` 或 `"print"`，命令动作接回宿主；然后退掉旧订阅，订阅新的公开会话事件；json 还额外订阅低层 Agent 事件来等待 stdout 背压。
5. 如果 `initialMessage` 非空，提交它并附带 `initialImages`。空字符串会被跳过，图片也不会单独发送。
6. 依次 `await session.prompt(message)` 处理 `messages`。前一条完整结束后才发下一条；如果某一条抛出，循环终止，后面的消息不再发送。
7. text 模式读取最后一条消息并输出；json 模式的输出已经在事件到达时逐行写完，不需要再打印最终文本。
8. 返回退出码。`finally` 移除信号处理器、调用 `disposeRuntime()`（退订阅并销毁运行时），最后 `flushRawStdout()` 排空写链。

`rebindSession` 在绑定扩展成功后才退旧订阅。绑定失败时函数会拒绝，外层 catch 返回 1，finally 仍会销毁运行时。

<a id="m05-walk-backpressure"></a>
### JSON 模式背压

`writeRawStdout` 本身不等待写完。它把每个写入块追加到一条 Promise 链上，然后立刻返回：

```ts
rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
```

如果只调用它，模型事件产生得比管道消费得快，未写出的字符串就会在内存里排队。

`waitForRawStdoutBackpressure` 的做法是：记下当前链尾，等待它完成；完成后再比较链尾是否还是同一个 Promise。如果等待期间又有新写入接到链上，就继续等新的链尾，直到不再变化。

JSON 模式把这个等待挂到低层 Agent 上，而不是公开会话事件上：

```ts
session.agent.subscribe(async () => {
  await waitForRawStdoutBackpressure();
});
```

Agent 的监听器是逐个 `await` 的，见 [agent.ts:1104](../../../../../packages/agent/src/agent.ts#L1104 "await listener(event, signal);")。因此每个低层事件处理完后，Agent 会等 stdout 写队列追上，再继续产生下一个事件。公开会话事件的 `_emit` 不等待异步监听器；如果只订阅 `session.subscribe`，这个背压不会作用到 Agent 循环。

它约束的是本地 stdout 队列，不是远端客户端已经消费完。等待返回只说明写入回调完成，不说明对方已经解析或显示。

RPC 模式也会挂同样的背压监听，而且不区分模式；JSON 只在 `mode === "json"` 时挂。text 模式不逐事件输出，所以不需要。

<a id="m05-interactive"></a>
## 交互模式

交互模式是常驻前端。构造器创建渲染器和组件，`init()` 完成布局、扩展绑定和订阅，`run()` 显示启动诊断、发送命令行初始消息，然后进入无限输入循环。

<a id="m05-interactive-start"></a>
### 启动

[InteractiveMode.run:2042](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2042 "async run(): Promise<void>") 先调用 `init()`：

- 创建主屏或备用屏 TUI。
- 绑定扩展，注册命令、快捷键、UI 组件。
- 订阅会话事件。
- 显示启动诊断、恢复提示、模型信息。

更准确地说，TUI 对象在构造器里创建，`init()` 才把它挂载并启动；扩展绑定发生在 `ui.start()` 之后，这样扩展的 `session_start` 处理器可以弹交互对话框。启动诊断不在 `init()` 里显示，而是在 `run()` 里。

<a id="m05-walk-interactive"></a>
#### init 按代码顺序

1. 如果 `isInitialized` 已经为真，直接返回；这里不是共享的“初始化完成 Promise”。
2. `registerSignalHandlers()` 安装信号和终端错误处理。
3. 读取 changelog 和扩展更新提示。
4. 非全屏模式把模型范围提示直接写到 stdout；全屏模式留到页头，避免退出后文字留在 shell 屏幕。
5. `renderWidgets()` 准备插件区域，`createChatViewport()` 创建聊天滚动区和底部 dock。
6. 把页头、资源、聊天、待发送消息、状态、编辑器、插件槽、页脚挂到渲染器；安装启动阶段的最小处理器：`app.clear`、`app.exit`、启动期提交、编辑器焦点。
7. `ui.start()` 进入终端输入/渲染生命周期，随后 `isInitialized = true`，上报程序状态，并在后台准备 PNG 转码器。
8. 应用主题并等待终端颜色查询；页头和启动提示的颜色在这之后才固定。
9. 构建页头或空占位；全屏模式在这里显示模型范围提示；请求第一帧。
10. 并行准备 `fd` 和 `rg`，保存 `fd` 路径。
11. 安装完整快捷键和正式提交处理器。
12. `await rebindCurrentSession()`：退旧订阅、应用设置、绑定扩展、订阅新会话、更新供应商数量/边框/标题。
13. `renderInitialMessages()` 渲染已有会话历史；然后注册主题监听、Git 分支监听，更新供应商计数，`renderNow()` 刷新首帧。
14. 后台加载高亮语法，完成后失效缓存并请求重绘。

`init()` 里先启动 TUI，再绑定扩展；先渲染历史，再让 `run()` 发送命令行初始消息。这两个顺序都是有意的。

<a id="m05-walk-run"></a>
#### run 按代码顺序

1. `await init()`。
2. 如果没设置 `PI_OFFLINE`，后台刷新模型目录，15 秒后取消等待；同时后台检查新版本、扩展包更新、tmux 键盘配置。这些都不阻塞主循环。
3. 解构启动选项：迁移过的供应商、启动诊断、模型回退说明、首条消息、首条图片、后续消息。
4. 按顺序显示启动诊断：error 用错误样式，warning 用警告样式，其余用普通状态。
5. 显示供应商迁移、`models.json` 错误、模型回退、上次崩溃提示，并后台检查 Anthropic 认证提示。
6. 如果 `initialMessage` 非空，`await this.session.prompt(initialMessage, { images: initialImages })`；失败只显示错误，不终止启动。
7. 遍历 `initialMessages`，每条单独 `try/catch` 并 `await`；一条失败不会阻止后面的消息。
8. 进入 `while (true)`：等 `getUserInput()`，在 `try` 里 `await this.session.prompt(userInput)`；失败调用 `showError`，然后继续等下一条。

主循环没有退出条件。退出由 Ctrl+C 双击、Ctrl+D、斜杠命令或信号处理器走单独的 shutdown 路径。

<a id="m05-interactive-loop"></a>
### 主循环

```ts
while (true) {
  const userInput = await this.getUserInput();
  try {
    await this.session.prompt(userInput);
  } catch (error) {
    this.showError(errorMessage);
  }
}
```

[getUserInput:7459](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7459 "async getUserInput(): Promise<string>") 返回 Promise：用户按 Enter 时 resolve，编辑器清空，控制权交给 `session.prompt()`。等待输入期间，TUI 仍然可以处理快捷键、滚动、扩展 UI。

这里有一个容易看错的点：主循环的 `session.prompt` 只处理**空闲时**的普通输入。流式期间的插话和追问在提交处理器里就已经送进 `AgentSession` 的队列，不会流到这里的下一轮循环。

<a id="m05-walk-input"></a>
#### getUserInput 怎么等

`getUserInput` 不读 stdin，也不轮询键盘。它的逻辑只有两步：

1. 先 `shift` 本地 `pendingUserInputs`；有排队文字就立刻返回。
2. 队列为空时创建一个 Promise，把 `onInputCallback` 设为唯一的等待回调。回调触发时先清空这个槽，再 `resolve(text)`。

编辑器提交处理器在空闲路径里看到 `onInputCallback` 就直接调用它；如果主循环还没来得及挂回调，就把文字推进 `pendingUserInputs`，下一轮再取。

TUI 仍然响应的原因是：终端已经进入 raw 模式，[tui.ts:1547](../../../../../packages/tui/src/tui.ts#L1547 "this.terminal.start(") 把终端输入接到 TUI 的输入处理链，[terminal.ts:328](../../../../../packages/tui/src/terminal.ts#L328 "this.inputHandler = onInput;") 保存输入回调。主循环只是在等一个 Promise，JavaScript 事件循环没有被占住；按键、滚动、重绘照常由终端回调驱动。

这个设计只有一个等待回调槽，不是通用的多消费者队列。主循环串行调用 `getUserInput`，所以够用；如果同时有多个调用者在队列为空时等待，后一个会覆盖前一个的回调，前一个 Promise 不会被唤醒。代码里没有并发调用它的路径。

<a id="m05-interactive-events"></a>
### 事件 -> 界面

<a id="m05-event-map"></a>
[subscribeToAgent:5936](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5936 "private subscribeToAgent()") 注册监听；[handleEvent:5948](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5948 "private async handleEvent(event: AgentSessionEvent)") 按事件类型更新组件：

```ts
this.unsubscribe = this.session.subscribe(async (event) => {
  await this.handleEvent(event);
});
```

`handleEvent` 每收到一个事件，先确保界面已初始化，然后让页脚缓存失效，把事件交给 `programStatus.handleEvent`，最后按 `event.type` 进入具体分支。

`handleEvent` 是异步的，但 `_emit` 不等待它。`_emit` 同步调用监听器，拿到一个 Promise 就继续往下走；`_handleAgentEvent` 在 `_emit` 之后继续做持久化。因此：

- UI 处理慢不会阻塞会话持久化，也不会让 Agent 循环等 UI。
- `handleEvent` 内部的异常会变成被丢弃的 Promise 拒绝；`_emit` 没有 catch，也不会把它回传给 Agent。
- 如果 `handleEvent` 在某个分支 `await` 了较慢的操作，后续事件可以先开始处理，事件之间没有串行队列。绝大多数分支是同步更新组件，只有初始化、`agent_settled` 等少数分支会 `await`。

下表按事件类型列出四种模式的去向。text 列统一写“不逐事件输出”，因为它虽然注册了订阅，但回调只在 json 时写 stdout；最终文本要等全部 prompt 结束。

**低层 Agent 事件**

| 事件 | text | json | interactive | rpc |
| --- | --- | --- | --- | --- |
| `agent_start` | 不逐事件输出 | 一行原事件 | 清空待工具索引，恢复普通 Escape 处理器；状态上报器进入 working | 一行原事件 |
| `turn_start` | 不逐事件输出 | 一行原事件 | 按设置打开终端进度；显示或清除 working 指示器；请求重绘 | 一行原事件 |
| `message_start`（user） | 不逐事件输出 | 一行完整消息 | 添加用户消息组件，更新待发送区 | 一行完整消息 |
| `message_start`（assistant） | 不逐事件输出 | 一行完整消息 | 创建 `AssistantMessageComponent`，保存流式消息引用 | 一行完整消息 |
| `message_update`（文本/思考） | 不逐事件输出 | 一行瘦身事件：`usage` 加 `assistantMessageEvent` | 更新同一个流式组件 | 同 json |
| `message_update`（toolcall_start） | 不逐事件输出 | 瘦身事件，额外带 `id` 和 `toolName` | 按工具调用 id 新建工具行；此时还没执行 | 同 json |
| `message_end` | 不逐事件输出，结束时只取最后一条 | 一行完整消息 | 固定助手内容；用户消息直接跳过；错误/取消时标记待工具失败；清空流式引用 | 一行完整消息 |
| `tool_execution_start` | 不逐事件输出 | 一行原事件 | 跳过带 `parentToolCallId` 的嵌套调用；复用或新建工具行；标记开始执行 | 一行原事件 |
| `tool_execution_update` | 不逐事件输出 | 一行原事件 | 按 `toolCallId` 更新已有工具行的部分结果 | 一行原事件 |
| `tool_execution_end` | 不逐事件输出 | 一行原事件 | 写入最终结果、`isError`、`durationMs`，删除待工具索引 | 一行原事件 |
| `turn_end` | 不逐事件输出 | 一行原事件 | 没有专门分支，不直接改界面 | 一行原事件 |

**会话层事件**

| 事件 | text | json | interactive | rpc |
| --- | --- | --- | --- | --- |
| `agent_end` | 不逐事件输出 | 一行会话版事件，带 `messages` 和 `willRetry` | 关闭终端进度，清 working 指示器，移除残留流式组件，清空待工具索引 | 一行会话版事件 |
| `agent_settled` | 不逐事件输出 | 一行原事件 | `await checkShutdownRequested()`；没有退出请求就完成空闲结算 | 一行原事件，并触发关闭检查 |
| `queue_update` | 不逐事件输出 | 一行原事件 | 重建待发送消息显示 | 一行原事件 |
| `entry_appended` | 不逐事件输出 | 一行原事件 | 只处理 custom、cache_warm、display 的 custom_message 和特定压缩检查点；普通消息不重画 | 一行原事件 |
| `session_info_changed` | 不逐事件输出 | 一行原事件 | 更新终端标题和页脚 | 一行原事件 |
| `thinking_level_changed` | 不逐事件输出 | 一行原事件 | 页脚失效，更新编辑器边框颜色 | 一行原事件 |
| `compaction_start` | 不逐事件输出 | 一行原事件 | 显示压缩指示器，临时把 Escape 改为取消压缩 | 一行原事件 |
| `compaction_end` | 不逐事件输出 | 一行原事件 | 恢复 Escape；按取消、结果、错误更新聊天和状态 | 一行原事件 |
| `auto_retry_start` / `auto_retry_end` | 不逐事件输出 | 一行原事件 | 显示或清理普通重试状态，临时改 Escape 为取消重试 | 一行原事件 |
| `summarization_retry_scheduled` / `_attempt_start` / `_finished` | 不逐事件输出 | 一行原事件 | 更新摘要重试指示器和状态 | 一行原事件 |
| `bash_execution_update` | 不逐事件输出 | 一行原事件 | 忽略；Bash 的增量由执行回调直接渲染 | 一行原事件 |

几个容易混淆的对应关系：

- `message_update` 的 `toolcall_start` 建工具行，`tool_execution_start` 才表示工具开始执行。
- `message_end` 之后 Agent 还可能执行刚生成的工具，所以它不是本轮结束。
- `agent_end` 之后还可能重试、压缩或恢复，所以它不是会话空闲；`agent_settled` 才是。
- `entry_appended` 可能和已经发过的消息事件内容重叠；交互界面只对少数条目类型单独渲染，JSON/RPC 客户端需要自己决定是否按条目去重。

<a id="m05-interactive-streaming"></a>
### 流式期间输入

提交处理器按固定顺序分流：内置斜杠命令、Bash、压缩中、流式中、空闲。

- 用户在当前回答还没结束时提交文字：按 `steer` 发送，[interactive-mode.ts:5906](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5906 "streamingBehavior: \"steer\"")。消息在当前工具批次结束后、下一次模型请求前插入。
- 用户希望“当前任务完成后再处理”：按 `followUp` 发送，[interactive-mode.ts:7850](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7850 "streamingBehavior: \"followUp\"")。消息在本轮自然停止时插入，之后作为下一轮输入处理。
- 空闲时提交：普通 `session.prompt()`，开始新一轮。
- 压缩中提交：扩展命令立即执行；普通文字按 `steer` 或 `followUp` 的意图放进 UI 的压缩队列，等压缩结束后的恢复流程再派发。

具体的插话路径在提交处理器里，不在主循环里。主循环此时还停在原来的 `await this.session.prompt(userInput)` 上；插话由 `AgentSession` 在当前 run 内消费，所以不会出现“主循环又开了一轮”的并发。

一个典型顺序：用户先输入“总结这个模块”，模型开始调用工具；用户输入“改用表格”并按 Enter，这是 steer；用户再按 Alt+Enter 输入“完成后给出三点结论”，这是 followUp。当前工具批次结束后，模型先看到“改用表格”；当前 run 自然停止后，followUp 才作为下一轮输入进入模型。

<a id="m05-interactive-keys"></a>
### 快捷键与命令

- 快捷键定义在 [keybindings.ts:228](../../../../../packages/coding-agent/src/core/keybindings.ts#L228 "export const KEYBINDINGS")，可通过设置覆盖；代码里不硬编码 `ctrl+x` 判断。
- [KeybindingsManager.create:428](../../../../../packages/coding-agent/src/core/keybindings.ts#L428 "static create(agentDir: string = getAgentDir()): KeybindingsManager {") 读取 `<agentDir>/keybindings.json`，迁移旧动作名，过滤掉不符合 schema 的值，再和默认表合并。
- `CustomEditor` 只按动作名匹配输入，例如 `app.interrupt`、`app.message.followUp`、`app.message.dequeue`；具体按键由当前配置决定。
- 斜杠命令来自扩展、技能和内置命令；输入 `/` 时编辑器显示补全。
- `!` 前缀进入 Bash 模式，执行 shell 命令并把结果作为上下文；`!!` 执行但不把结果加入模型上下文。
- Bash 正在运行时再次提交 Bash 命令会被拒绝，并把原文放回编辑器；这不是通用的“所有工具都忙”检查。

<a id="m05-interactive-tui"></a>
### TUI 结构

<a id="m05-walk-tui"></a>
[createInteractiveTui:41](../../../../../packages/coding-agent/src/modes/interactive/tui-renderer.ts#L41 "export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {") 按 `tuiMode` 选择：

- `regular`：主屏，输出留在终端滚动历史里。
- `fullscreen`：备用屏，适合长时间会话和复杂布局。

聊天区域由 `chat-viewport.ts` 管理滚动；编辑器由 `CustomEditor` 处理输入、补全和历史；状态行显示模型、token、工具状态。主题通过 `theme.ts` 的代理读取，切换主题不需要重建组件。

这段是概览，下面把几个容易混的部分拆开。

#### 主屏和备用屏

`createInteractiveTui` 先确定终端适配器，再按 `tuiMode` 构造：

- `regular` 返回 `TuiMainScreen`，没有全屏搜索、选区复制、跳到底部提示等额外配置。
- `fullscreen` 返回 `TuiAltScreen`，额外接上搜索高亮样式、`tui.altScreen.bottom` 提示、打开链接、右键粘贴、选中复制、滚轮行数等选项。

两者在 `init()` 里都只是“创建并挂载”，真正启动仍是 `ui.start()`。全屏模式的启动提示不走 `console.log`，因为备用屏退出后那段文字会落到普通 shell 屏幕上；它把提示放进页头。

#### ChatViewport 如何分配高度

`createChatViewport` 返回 `{ transcript, root }`：

- `transcript` 是 `ScrollView`，内容为整个文档区域，配置 `follow: "end"`、`primary: true`、`overscroll: "chain"`。新消息到来时默认跟到底部；用户向上滚动后可以暂停跟随。
- `root` 是竖向 `VStack`：上方 transcript 占剩余空间（`basis: 0`、`grow: 1`、`minSize: 1`），下方 dock 按自然高度（`basis: "auto"`）并可收缩。
- dock 里从上到下是待发送消息、状态、输入框上方插件、编辑器、输入框下方插件、页脚。除编辑器最小 3 行外，其余区域都可以收缩到 0。

所以终端很矮时，先被压缩的是待发送区和状态区，编辑器尽量保留 3 行；页脚也可能被压到看不见。

#### CustomEditor 的输入分派

`CustomEditor` 继承 `Editor`，在父类的文字编辑、补全和历史之上加应用快捷键：

1. 扩展注册的快捷键最先处理，返回真值就消费输入。
2. 补全菜单打开时，`tui.select.pageUp` / `pageDown` 优先翻页，这样即使用户把 Ctrl+V 绑定成粘贴图片，也不会在菜单里误触。
3. 图片粘贴动作优先于其他应用动作。
4. `app.interrupt` 在补全菜单关闭时交给 `onEscape` 或注册处理器；菜单打开时交给父编辑器处理取消。
5. `app.exit` 只在编辑器完全为空时触发；只有空格不算空。
6. 显式历史绑定优先于其他应用动作，所以把 Ctrl+P 绑成历史上一项时，不会同时切模型。
7. 其余应用动作按注册顺序匹配，第一个匹配者执行。
8. 剩下的输入交给父 `Editor`，由它处理字符、删除、补全、历史和提交。

#### 快捷键如何合并

`KEYBINDINGS` 先展开 TUI 的默认表，再覆盖少量 TUI 动作，最后展开 `APP_KEYBINDINGS`。`KeybindingsManager` 在构造时把用户覆盖合并进这张表；读写配置都在 [keybindings.ts:416](../../../../../packages/coding-agent/src/core/keybindings.ts#L416 "export class KeybindingsManager extends TuiKeybindingsManager {") 这一层完成。窗口标题、页头提示、编辑器边框里的状态提示都通过同一个管理器取按键文字，所以改配置后显示和行为一致。

#### 状态行由两部分组成

- 页脚 `FooterComponent` 显示 cwd、Git 分支、会话名，token 统计 `↑输入 ↓输出 R缓存读 W缓存写 CH命中率`，上下文占比/窗口/`(auto)`，费用，以及模型和思考级别。
- 编辑器边框里的工作指示器显示 working、retry、compaction 等瞬时状态；工具执行状态在各自的工具行里，不在页脚。

因此“状态行显示工具状态”只说对了一部分：工具结果属于工具行，页脚更多是会话和模型统计。

<a id="m05-rpc"></a>
## RPC 模式

[runRpcMode:69](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L69 "export async function runRpcMode(") 面向编辑器/IDE：

1. `takeOverStdout()`，防止普通 `console.log` 污染协议。
2. 从 stdin 逐行读 JSON 命令。
3. 命令可以驱动 prompt、abort、new session、fork、switch、扩展 UI 等。
4. 响应和会话事件都以 JSONL 写到 stdout。
5. 会话替换后重新订阅，`runtime.session` 始终是当前会话。

RPC 不渲染 TUI，但复用同一套 `AgentSession` 和扩展绑定。它适合作为 LSP/IDE 插件的后端。

<a id="m05-rpc-startup"></a>
### 启动和协议外形

`main` 在进入 `runRpcMode` 前已经调用过 `takeOverStdout`；`runRpcMode` 第一行再调用一次，是幂等的。普通 stdout 被导向 stderr，只有 `writeRawStdout` 写出的协议行进入原始 stdout。

启动顺序是：

1. 刷新会话引用，准备订阅和背压的取消函数。
2. 定义 `output`、`success`、`error`，所有协议行都经过 `serializeJsonLine` 加一个换行。
3. 注册宿主的 `setRebindSession`，然后立即 `await rebindSession()` 完成首次绑定。
4. 注册 SIGTERM/SIGHUP 处理。
5. 注册 stdin 的 `end` 监听和 JSONL 行读取器。
6. 返回一个永不 resolve 的 Promise，让进程保持运行；实际退出走 `process.exit`。

首次绑定在信号处理之前完成。绑定失败时函数可以拒绝，而且此时还没有安装信号监听。

协议里有两类输出：

- **响应**：有 `id`、`type: "response"`、`command`、`success`，成功时可能有 `data`，失败时有 `error`。客户端用 `id` 关联请求。
- **事件**：没有请求 `id`，是 `AgentSessionEvent` 经 `toJsonEvent` 转换后的形状。`message_update` 会瘦身，其余事件基本原样。

RPC 不写会话头。客户端要拿会话信息，使用 `get_state`；它返回 `RpcSessionState`，包含模型、思考级别、是否流式、是否压缩、会话文件、消息数和待处理消息数等。

<a id="m05-walk-rpc"></a>
### 一次 prompt 的完整顺序

1. 客户端写一行 `prompt` 命令。
2. `handleCommand` 立即启动 `session.prompt`，但**不 await 整轮运行**。
3. `session.prompt` 的 `preflightResult` 回调触发时，RPC 输出唯一的受理响应，`data.disposition` 表示 `started`、`queued` 或 `handled`。
4. 预检成功后，模型运行产生的事件经会话订阅写成 JSONL。
5. 如果预检前就失败，`prompt` 的 Promise 拒绝，RPC 输出 `success: false` 响应；预检成功后发生的模型错误不会重复发一条失败响应，而是作为 assistant 的 `error` 事件出现。
6. 运行结束，`agent_settled` 事件到达；订阅回调顺手检查扩展是否请求过关闭。

因此，`prompt` 的响应语义是“输入已受理”，不是“回答已完成”。客户端要等 `agent_settled`，或者观察 assistant 的 `message_end` 和后续工具事件。

`steer` 和 `follow_up` 是独立命令。它们 `await session.steer/followUp`，返回实际 `disposition`；这个值可能是 `handled`，表示输入钩子消费了这条输入，也可能只是 `queued`。

<a id="m05-rpc-dispatch"></a>
### 命令怎么分派

`handleCommand` 是一个按 `command.type` 的 `switch`：

- `prompt` 特例自己异步输出响应并返回 `undefined`，外层不再重复输出。
- `steer`、`follow_up`、`abort`、`clear_queue` 直接调用会话方法，返回有 `data` 或无 `data` 的成功响应。
- 模型、思考级别、压缩、重试、Bash、导出、树导航、统计等命令调用对应会话方法。
- `new_session`、`switch_session`、`fork`、`clone` 在宿主返回未取消后，主动调用 `rebindSession`。
- 未知 `type` 落到默认分支，返回 `success: false`。

`handleInputLine` 先做 `JSON.parse`。语法错误时返回一个 `command: "parse"` 的失败响应，id 是 `undefined`，因为此时拿不到原请求 id。之后它检查 `extension_ui_response`：这是扩展对话框的回复，按 UUID 找到等待中的 Promise 就 resolve，不生成普通命令响应。其余输入才按 `RpcCommand` 进入 `handleCommand`。

<a id="m05-rpc-concurrency"></a>
### 多行并发和顺序

stdin 的读取回调是：

```ts
void handleInputLine(line);
```

每一行独立启动，没有全局串行队列。好处是 `prompt` 还在跑时客户端可以发 `abort`、`steer` 或 `get_state`；代价是：

- 响应的完成顺序不保证等于输入顺序。客户端必须用 `id` 关联，不能假设“第 2 行的响应一定在第 1 行之后”。
- 事件、响应和其他事件可以交错。`writeRawStdout` 只保证单行写入按链顺序执行，不保证逻辑处理顺序。
- 如果某一行是坏 JSON，它会得到自己的 `parse` 失败响应，其他行继续处理。

<a id="m05-rpc-rebind"></a>
### 会话替换后的重新订阅

`rebindSession` 每次都重新读取 `runtimeHost.session`，然后：

1. `bindExtensions`：传入 RPC 的 `uiContext`、`mode: "rpc"`、命令动作、`shutdownHandler` 和 `onError`。扩展错误写成 `extension_error` 事件，不冒充命令响应。
2. 退掉旧会话的公开事件订阅和低层 Agent 背压订阅。
3. 订阅新会话的公开事件：每条经 `toJsonEvent` 输出；`agent_settled` 时异步检查关闭请求。
4. 给新会话的低层 Agent 挂 stdout 背压监听。

当前实现里，成功的 `new_session`/`switch_session`/`fork`/`clone` 路径可能绑定两次：宿主完成会话替换时会调用已注册的重绑定，RPC 命令分支在未取消时又显式调用一次 `rebindSession`。因此扩展绑定和 `session_start`/资源发现钩子通常会执行两次。这是代码现状，不是协议承诺；看日志时不要因为看到两次扩展启动就判定扩展重复加载。

<a id="m05-rpc-shutdown"></a>
### 关闭

三种关闭入口：

- stdin `end`：调用 `shutdown()`，正常退出码 0，并 flush 已排队输出。
- SIGTERM / SIGHUP：SIGTERM 退出码 143，SIGHUP 退出码 129；SIGTERM 路径跳过 flush。
- 扩展请求关闭：`shutdownHandler` 只设置标志，之后在命令处理结束或 `agent_settled` 时由 `checkShutdownRequested()` 执行关闭。

`shutdown()` 会移除信号监听、退订阅、销毁宿主、卸载输入监听、暂停 stdin，然后 `process.exit`。它不等待正在执行的模型请求或工具结束，也不会遍历所有待决的扩展 UI Promise 逐个 reject。因此 stdin 关闭表示“服务端结束”，不是“暂时没有新命令”。

<a id="m05-selfcheck"></a>
## 自测

1. **在 TTY 上只运行 `pi --mode text`（不传 `-p`），会进入哪个模式？**
   答：`interactive`。`--mode text` 不在 `resolveAppMode` 的显式分支里，不会让函数返回打印模式；只有 `-p` 或 stdin/stdout 非 TTY 才返回 `print`，随后 `toPrintOutputMode` 再把 `print` 映射成 `text`。证据：[main.ts:203](../../../../../packages/coding-agent/src/main.ts#L203 "function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {")、[main.ts:225](../../../../../packages/coding-agent/src/main.ts#L225 "function toPrintOutputMode(appMode: AppMode): Exclude<Mode, \"rpc\"> {")。

2. **为什么 text 模式看不到工具调用行，而 json 模式能看到？**
   答：text 模式只在全部 prompt 结束后读取最后一条 assistant 的 text 块；工具调用和中间轮次不在最终消息里。json 模式订阅每个会话事件并逐行写出，`tool_execution_start/update/end` 都在其中。证据：[print-mode.ts:211](../../../../../packages/coding-agent/src/modes/print-mode.ts#L211 "const lastMessage = state.messages[state.messages.length - 1];")、[print-mode.ts:165](../../../../../packages/coding-agent/src/modes/print-mode.ts#L165 "session.subscribe((event)")。

3. **同一个提示词，什么情况下 text 和 json 的退出码不同？**
   答：最后一条 assistant 的 `stopReason` 是 `error`、`aborted` 或 `length` 时，text 会把退出码设为 1；json 不检查最终 `stopReason`，只有 `session.prompt` 抛出或外层 catch 才返回 1。因此模型报错的 json 运行仍可能以 0 退出。证据：[print-mode.ts:218](../../../../../packages/coding-agent/src/modes/print-mode.ts#L218 "if (assistantMsg.stopReason === \"error\" || assistantMsg.stopReason === \"aborted\") {")、[print-mode.ts:231](../../../../../packages/coding-agent/src/modes/print-mode.ts#L231 "if (assistantMsg.stopReason === \"length\") {")、[print-mode.ts:241](../../../../../packages/coding-agent/src/modes/print-mode.ts#L241 "} catch (error: unknown) {")。

4. **交互模式为什么先 `ui.start()`，之后才 `await this.rebindCurrentSession()`？**
   答：因为扩展的 `session_start` 处理器可能要弹交互对话框，终端输入循环和渲染生命周期必须先就绪；源码注释明确写了这一点。绑定、订阅和首屏刷新都在启动之后。证据：[interactive-mode.ts:1793](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1793 "// Start the UI before initializing extensions so session_start handlers can use interactive dialogs")（之后才到 [interactive-mode.ts:1972](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1972 "await this.rebindCurrentSession();")）。

5. **`message_update` 里哪种事件可能带完整 `message`？**
   答：`done` 和 `error`。`toJsonEvent` 对所有 `message_update` 都重建顶层对象，丢弃顶层 `message`；但内层 `assistantMessageEvent` 只有带 `partial` 时才瘦身，`done`/`error` 没有 `partial`，所以内层事件原样保留：`done` 里有最终 `message`，`error` 里有失败 `error`。证据：[json-event.ts:82](../../../../../packages/coding-agent/src/modes/json-event.ts#L82 "export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {")、[json 的 JSONL](#m05-example-json)。

6. **`agent_end` 已经出现，为什么 TUI 还不能接受下一条输入？**
   答：`agent_end` 是一次低层 run 的结束，之后还可能自动重试、压缩和扩展收尾；`agent_settled` 才是最终结算。交互模式在 `agent_settled` 分支里调用 `checkShutdownRequested()` 并完成空闲结算。证据：[interactive-mode.ts:6382](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6382 "case \"agent_end\":")、[interactive-mode.ts:6408](../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6408 "case \"agent_settled\":")。

7. **RPC 客户端发出 `prompt` 后，应该用什么判断回答完成？**
   答：`prompt` 的响应只表示输入已受理，`disposition` 可能是 `started`、`queued` 或 `handled`；完成要看后续事件，最终以 `agent_settled` 作为会话空闲信号，中间可以观察 `message_end` 和工具事件。证据：[rpc-mode.ts:630](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L630 "case \"prompt\": {")、[rpc-mode.ts:564](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L564 "unsubscribe = session.subscribe((event) => {")。

8. **两条 RPC 命令背靠背写进 stdin，为什么第二条的响应可能先到？**
   答：JSONL 读取器对每一行执行 `void handleInputLine(line)`，没有跨行串行化；各命令独立异步执行，响应顺序不保证，客户端必须用 `id` 关联。证据：[rpc-mode.ts:1303](../../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L1303 "void handleInputLine(line);")、[多行并发和顺序](#m05-rpc-concurrency)。

9. **主屏和备用屏的区别是什么？**
   答：`regular` 返回 `TuiMainScreen`，内容留在终端 scrollback；`fullscreen` 返回 `TuiAltScreen`，退出时恢复进入前的屏幕，并额外提供搜索、选区复制、跳到底部等能力。证据：[tui-renderer.ts:45](../../../../../packages/coding-agent/src/modes/interactive/tui-renderer.ts#L45 "if (options.tuiMode === \"fullscreen\") {")、[tui-renderer.ts:90](../../../../../packages/coding-agent/src/modes/interactive/tui-renderer.ts#L90 "return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);")。

<a id="m05-exercises"></a>
## 练习

1. **text 与 json 对照。** 用同一句会触发一次工具调用的问题分别运行 `pi -p "读取 README.md 前 5 行"` 和 `pi --mode json -p "读取 README.md 前 5 行"`，把 JSONL 事件按 [事件 -> 界面](#m05-event-map) 归类，并指出 text 的最终正文来自哪一条消息。这个练习需要真实模型认证。离线替代：给 `toJsonEvent` 写一个临时单测，构造带 `partial` 的 `toolcall_start` 和不带 `partial` 的 `done`，断言前者的内层事件有 `id`/`toolName`、后者的内层 `assistantMessageEvent.message` 保留最终消息，同时顶层 `message` 已被移除。

2. **RPC 一行命令。** 运行 `printf '%s\n' '{"id":"probe","type":"get_state"}' | pi --mode rpc`，观察响应里的成功标志和 `RpcSessionState` 字段；再把同一行改成坏 JSON，确认收到 `command: "parse"` 的失败响应。`get_state` 不调用模型，但进程启动仍可能要求已配置的认证。完全离线时，改读 [rpc-types.ts:147](../../../../../packages/coding-agent/src/modes/rpc/rpc-types.ts#L147 "export interface RpcSessionState {") 和 [RPC 命令分派](#m05-rpc-dispatch)。

3. **steer 与 followUp。** 启动交互模式，让模型执行一个会调用多个工具的任务；在流式期间分别用 Enter 和 Alt+Enter 提交一句话，观察哪条在下一轮模型请求前被消费、哪条等到当前 run 结束。这个练习需要真实模型认证。离线替代：在 `packages/coding-agent/test/suite/harness.ts` 的 faux provider 会话里调用 `session.steer()` 和 `session.followUp()`，断言 `queue_update` 事件里的 `steering` / `followUp` 数组变化。

4. **事件映射核对。** 用一次带工具调用的交互会话记录事件到达顺序，对照 [事件 -> 界面](#m05-event-map) 标出每个事件改了哪个组件，并找出没有专门分支的事件（例如 `turn_end`）。这个练习需要真实模型认证。离线替代：用 faux provider 回放一组合成会话事件，只观察组件状态和事件表，不调用真实模型。

<a id="m05-misread"></a>
## 常见误解

- **“交互模式有独立的对话逻辑”**：没有。它只负责输入、事件渲染和命令；对话逻辑在 `AgentSession`。
- **“打印模式会打印每一轮 assistant 文本”**：text 模式只打印最后一条 assistant 的 text 块。工具调用、thinking 和中间轮次不会出现在最终 stdout。
- **“JSON 模式的事件和 TUI 看到的不一样”**：同一套 `AgentSessionEvent`，只是序列化方式不同。JSON/RPC 额外把 `message_update` 的累积 `partial` 去掉，并给 `toolcall_start` 补上 id 和工具名。
- **“所有 `message_update` 都不带完整消息”**：不成立。`text_delta`、`toolcall_delta` 等带 `partial` 的增量会被瘦身；`done` 和 `error` 没有 `partial`，内层 `assistantMessageEvent` 原样保留，分别带最终 `message` 和失败 `error`。
- **“流式期间输入会开新会话”**：不会。它进入 steer/follow-up 队列，由当前运行消费。主循环仍然停在原来的 `session.prompt` 上。
- **“`agent_end` 后 TUI 就空闲了”**：还要等 `agent_settled`，因为重试、压缩和扩展收尾可能继续。
- **“RPC 的 `prompt` 响应表示回答完成”**：响应只表示受理。完成要看事件和 `agent_settled`。
- **“RPC 会按 stdin 顺序串行执行命令”**：不会。每行独立 `void handleInputLine(line)`，响应顺序不保证；`id` 是唯一的关联方式。
- **“退出码 0 表示模型完成了任务”**：text 模式只根据最后一条 assistant 的停止原因和 prompt 是否抛出设置退出码；json 模式甚至不会因为模型 `error` 事件改退出码。
- **“`getUserInput` 在读键盘”**：它只等编辑器提交或本地 FIFO。终端输入由 TUI 的 raw mode 和输入回调处理，所以等待期间界面仍然响应。
- **“全屏只是把界面画得更大”**：备用屏有独立的生命周期、选区/搜索/跳到底部行为，退出时恢复原屏幕；普通主屏则把内容留在 scrollback。
- **“状态行就是工具状态”**：页脚显示会话和模型统计；工具状态在工具行，working/retry/compaction 在编辑器边框的指示器里。

<a id="m05-next"></a>
## 继续阅读

- 会话事件从哪来：[M03 会话与上下文](../03-session-and-context/README.md)，重点看 [存储与投影](../03-session-and-context/README.md#m03-store)、[多轮](../03-session-and-context/README.md#m03-multiturn)、[压缩](../03-session-and-context/README.md#m03-compaction)。
- 低层循环如何产生工具事件：[M02 Agent 循环](../02-agent-loop/README.md)，重点看 [事件表](../02-agent-loop/README.md#m02-events)、[主循环](../02-agent-loop/README.md#m02-walk-loop)、[流式输出](../02-agent-loop/README.md#m02-walk-stream)。
- 模式如何被选择：[M01 入口与装配](../01-entry-and-config/README.md)。
- 回到全链路：[S4 打印模式](../00-full-chain/README.md#m00-s4)、[交互模式](../00-full-chain/README.md#m00-interactive)、[S13 收尾](../00-full-chain/README.md#m00-s13)。
