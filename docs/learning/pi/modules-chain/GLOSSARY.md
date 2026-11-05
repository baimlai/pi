# pi 术语表

这是按主题查词的速查页，不按源码文件组织。每条给出中文叫法、代码名、直白解释、一个具体例子，以及模块锚点或源码文件。源码链接只到文件，不锁行号，避免代码移动后失效。

<a id="glossary-confusions"></a>
## 先看：五组最容易混的词

| 组 | 各自是什么 | 一句话区分 | 例子 |
| --- | --- | --- | --- |
| run / turn / request | 一次低层运行 / 一次模型回答加工具执行 / 一次供应商请求 | run 是最外层生命周期；turn 是循环里的一轮；request 是真正的一次网络调用 | 用户问一句，模型先调用 read，再总结：1 个 run、2 个 turn、2 个 request |
| entry / message / projection | JSONL 条目树节点 / 带 role 和 content 的消息对象 / 从当前分支重放出的模型视图 | entry 是存下来的记录；message 是负载；projection 是模型实际看到的视图 | JSONL 里有一条 `message` 条目，投影后可能因压缩或 `context_edit` 不再出现 |
| agent_end / agent_settled | 低层 Agent 运行结束 / 整个会话最终稳定 | `agent_end` 后还可能有重试、压缩和扩展收尾；`agent_settled` 才是真正的空闲边界 | `agent_end.willRetry` 为真，随后自动重试，最后才发 `agent_settled` |
| steering / followUp | 插话队列 / 追问队列 | steering 在下一个可插入点进入当前运行；followUp 在循环本来要停止时把运行继续下去 | 工具执行中发“也检查 B”用 steer；任务完成后发“再总结”用 followUp |
| Agent.state.messages / context snapshot / newMessages / session projection | Agent 完整工作副本 / 传给低层循环的数组浅拷贝 / 本次运行新增的消息 / 从会话树重放的模型上下文 | 四个数组都可能叫“消息”，但来源和范围不同 | `agent_end.messages` 是 newMessages，不是完整历史；下一次请求用的是 projection |

<a id="glossary-run-loop"></a>
## 运行与循环

| 术语 | 代码名 | 直白解释 | 具体例子 | 去哪看 |
| --- | --- | --- | --- | --- |
| 运行 | `run` | 一次 `Agent.prompt()` 或 `Agent.continue()` 驱动的低层生命周期，从 `agent_start` 到 `agent_end`，可以包含多个回合和多次模型请求 | 用户问一句，模型先调用 `read`，再基于结果总结；这仍是一次 run | [M02 四个容易混的概念](02-agent-loop/README.md#m02-terms)、[agent.ts](../../../../packages/agent/src/agent.ts) |
| 回合 | `turn` | 一次 assistant 回答以及这条回答要求的工具执行；循环在 `turn_start` 和 `turn_end` 之间处理 | 第一次回答带 `read` 调用并执行完，是一个 turn；第二次回答给出总结，是下一个 turn | [M02 四个容易混的概念](02-agent-loop/README.md#m02-terms) |
| 模型请求 | `request` | 真正调用一次模型供应商；低层循环里通常由一次 `streamAssistantResponse` 发起 | 带工具的一次 query 通常有两次 request：一次拿到 toolCall，一次拿到最终文本 | [M02 四个容易混的概念](02-agent-loop/README.md#m02-terms)、[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) |
| 事件 | `event` | Agent 或 AgentSession 对外发布的进度通知；它是观察接口，不是持久化记录 | `tool_execution_start` 表示工具管线开始，不代表工具函数一定已经执行 | [M02 事件序列](02-agent-loop/README.md#m02-events)、[types.ts](../../../../packages/agent/src/types.ts) |
| 活动运行 | `activeRun` | Agent 当前低层运行的句柄，包含等待 Promise、完成函数和 AbortController；同一时刻最多一个 | `agent.prompt()` 在已有 `activeRun` 时拒绝并发；`waitForIdle()` 等的是这个 Promise | [agent.ts](../../../../packages/agent/src/agent.ts) |
| 本次新增消息 | `newMessages` | 本次低层运行产生的消息数组，只覆盖这次 run，不是完整对话历史 | `agent_end.messages` 里有本次 run 的 user、assistant、toolResult，没有更早历史 | [M02 数据变化](02-agent-loop/README.md#m02-data) |
| 上下文快照 | `context snapshot` | Agent 传给低层循环的浅拷贝上下文；`messages` 和 `tools` 数组被复制，消息对象本身共享 | 循环运行期间往 `Agent.state.messages` 追加消息，不会自动改变已经传入的快照数组 | [M02 数据变化](02-agent-loop/README.md#m02-data)、[agent.ts](../../../../packages/agent/src/agent.ts) |
| 停止原因 | `stopReason` | assistant 消息的结束状态；常见值有 `pending`、`stop`、`length`、`toolUse`、`error`、`aborted`、`deferred` | `toolUse` 表示要执行工具；`length` 表示输出被截断；`error`/`aborted` 会让低层循环结束 | [M04 统一事件协议](04-model-access/README.md#m04-design)、[types.ts](../../../../packages/ai/src/types.ts) |
| 运行开始事件 | `agent_start` | 低层运行开始时发布的事件，早于第一次模型请求 | 在 `before_agent_start` 期间请求取消，`agent_start` 到达时会触发 abort，赶在首个请求前停止 | [M02 事件序列](02-agent-loop/README.md#m02-events)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 回合开始事件 | `turn_start` | 每个回合开始、发起该回合请求前发布的事件 | 带工具的一次 query 会看到两个 `turn_start` | [M02 事件序列](02-agent-loop/README.md#m02-events) |
| 回合结束事件 | `turn_end` | 一个 assistant 回答及其配对工具结果都收齐后发布；携带该 assistant 和本批 `toolResults` | 会话层在 `message_end` 保存消息，在 `turn_end` 之后才插入专属上下文消息，避免拆散 toolCall 与 toolResult | [M02 事件序列](02-agent-loop/README.md#m02-events)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |

<a id="glossary-message-tool"></a>
## 消息与工具

| 术语 | 代码名 | 直白解释 | 具体例子 | 去哪看 |
| --- | --- | --- | --- | --- |
| 代理消息 | `AgentMessage` | Agent 内部使用的消息联合，包含标准消息和扩展自定义角色；不是供应商最终的 wire 格式 | 扩展产生一条 `custom` 消息，进入 Agent 历史后再由 `convertToLlm` 转成供应商能接收的消息 | [M01 三组对象](01-entry-and-config/README.md#m01-example)、[types.ts](../../../../packages/agent/src/types.ts) |
| 助手消息 | `AssistantMessage` | `role: "assistant"` 的完整消息，包含内容块、供应商/模型/API、用量和停止原因 | 一条 `toolUse` 的 assistant 消息里有文字块和 `toolCall` 块；最终消息还会记录实际 provider 与 model | [M04 运行示例](04-model-access/README.md#m04-example)、[types.ts](../../../../packages/ai/src/types.ts) |
| 工具调用 | `ToolCall` | assistant 内容里的工具调用块，带唯一 id、工具名和参数；流式过程中参数可能还不完整 | `{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }` | [M02 运行示例](02-agent-loop/README.md#m02-example)、[types.ts](../../../../packages/agent/src/types.ts) |
| 工具结果消息 | `ToolResultMessage` | `role: "toolResult"` 的消息，用 `toolCallId` 与一次工具调用配对，携带内容、错误标志、详情和用量 | `{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [...], isError: false }` | [M02 运行示例](02-agent-loop/README.md#m02-example)、[types.ts](../../../../packages/ai/src/types.ts) |
| 工具调用 ID | `toolCallId` | 把一次工具调用和它的结果关联起来的稳定 id；模型和投影都靠它配对 | assistant 里是 `call_1`，对应工具结果的 `toolCallId` 也必须是 `call_1`；并行完成顺序不影响这个配对 | [M02 运行示例](02-agent-loop/README.md#m02-example)、[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) |
| 工具执行开始事件 | `tool_execution_start` | 工具管线开始时发布，早于查找工具、参数校验和前置钩子；它不等于工具函数已经运行 | 参数非法或被 `beforeToolCall` 阻止时，仍可能先看到这个事件，随后直接得到错误结果 | [M02 工具执行](02-agent-loop/README.md#m02-walk-tools)、[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) |
| 工具执行更新事件 | `tool_execution_update` | 工具执行期间的中间进度或部分结果；不是最终结果，工具也可以完全不发 | `bash` 执行中持续输出片段；最终结果仍以 `tool_execution_end` 和 toolResult 消息为准 | [M02 事件序列](02-agent-loop/README.md#m02-events) |
| 工具执行结束事件 | `tool_execution_end` | 一次工具调用完成最终化后发布，可能是成功、失败、被阻止或截断；与 toolResult 消息不是同一个东西 | 并行批次中多个工具的结束事件按实际完成顺序出现，但结果消息随后按 assistant 源顺序发出 | [M02 事件序列](02-agent-loop/README.md#m02-events)、[types.ts](../../../../packages/agent/src/types.ts) |
| 消息开始事件 | `message_start` | 一条完整消息生命周期的开始；assistant 通常先给草稿，toolResult 也会先开始再结束 | 流式回答先有 `message_start`，后续 `message_update` 更新同一位置 | [M02 事件序列](02-agent-loop/README.md#m02-events) |
| 消息更新事件 | `message_update` | 流式增量；会话事件带累计草稿，JSON 传输会去掉累计 `partial`，只留增量和用量 | JSON 客户端看到 `assistantMessageEvent`，需要自己按增量拼接；`message_end` 才是权威完整消息 | [M05 JSON 模式](05-modes-and-tui/README.md#m05-print)、[json-event.ts](../../../../packages/coding-agent/src/modes/json-event.ts) |
| 消息结束事件 | `message_end` | 一条消息完成，内容固定；会话层在这里保存消息，扩展也可以在这里替换内容 | 一个带工具的 run 在 JSONL 里通常只有 user、assistant、toolResult、assistant 四条消息条目，而不是每个 delta 一条 | [M02 事件序列](02-agent-loop/README.md#m02-events)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |

<a id="glossary-session-context"></a>
## 会话与上下文

| 术语 | 代码名 | 直白解释 | 具体例子 | 去哪看 |
| --- | --- | --- | --- | --- |
| 会话条目 | `entry` | JSONL 里的一个树节点，带 `type`、`id`、`parentId` 和时间戳；消息只是其中一种 | `{ "type": "message", "id": "a2", "parentId": "a1", "message": {...} }` | [M03 会话文件与条目树](03-session-and-context/README.md#m03-store)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 叶子 | `leaf` | 当前选中的分支末端；新条目默认接在叶子上，投影从叶子沿 `parentId` 回溯到根 | 打开一个旧会话后选中另一条分支，叶子变化，下一次投影就会走另一条路径 | [M03 会话文件与条目树](03-session-and-context/README.md#m03-store)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 分支 | `branch` | 从根到某个叶子的一条路径；同一份 JSONL 可以包含多条分支 | fork 或回到旧节点继续，新条目接在旧节点后面形成新分支，旧分支仍然保留 | [M03 会话文件与条目树](03-session-and-context/README.md#m03-store)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| JSONL 会话文件 | `JSONL` | 每行一个 JSON 对象的追加文件；第一条通常是会话头，后面是条目；追加不会改写旧行 | 一次 run 可能追加 user、assistant(toolCall)、toolResult、assistant(text) 四行 message 条目 | [M03 会话文件与条目树](03-session-and-context/README.md#m03-store) |
| 会话投影 | `projection` | 从当前叶子路径选出有效条目，应用最新压缩和 `context_edit` 后得到的模型可见消息与设置 | 原始 JSONL 仍保留全部历史，但模型只收到摘要、保留的近期原文和之后的条目 | [M03 投影不是过滤整个文件](03-session-and-context/README.md#m03-store)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 压缩 | `compaction` | 写入一个摘要检查点，用摘要替代更早的历史；原始条目不删除，最新检查点决定重放边界 | `compaction` 条目保存摘要和 `firstKeptEntryId`，之后从该 id 开始保留原文 | [M03 压缩](03-session-and-context/README.md#m03-compaction)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 保留起点 | `firstKeptEntryId` | 压缩条目里的稳定条目 id，指定从哪条原始消息开始继续保留；不是数组下标或时间戳 | `firstKeptEntryId: "a6"` 表示 a6 及之后的旧尾部继续进入投影，更早的由摘要替代 | [M03 压缩](03-session-and-context/README.md#m03-compaction)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 上下文编辑 | `context_edit` | 指向另一个条目的编辑条目，可以替换该条目的 content，或用 `null` 让它对模型隐藏；只改投影，不改原始历史 | 旧工具输出太大时，写一条 `context_edit` 隐藏它，JSONL 里原 toolResult 仍在 | [M03 context_edit](03-session-and-context/README.md#m03-context-edit)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 分支摘要 | `branch summary` | 离开一条分支时为这条分支生成的摘要条目，用于切换后保留“另一边做过什么”；与 compaction 是不同条目 | 从旧节点 fork 到新方向时，原分支可以生成 `branch_summary`，新路径上下文不必重新解释 | [M03 压缩](03-session-and-context/README.md#m03-compaction)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 会话管理器 | `SessionManager` | 持有内存条目树和 JSONL 持久化；负责分配 id、维护叶子和构建投影，不调用模型 | `appendMessage()` 追加消息条目并更新叶子；`buildSessionProjection()` 生成当前视图 | [M03 会话文件与条目树](03-session-and-context/README.md#m03-store)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 会话 | `AgentSession` | 上层会话对象，持有 Agent、SessionManager、扩展、压缩和重试；负责 `prompt()`、事件分发和持久化 | 打印（含 JSON）、交互和 RPC 都由同一个 `session.prompt()` 驱动；低层 Agent 结束后，会话层还可能重试或压缩 | [M01 三组对象](01-entry-and-config/README.md#m01-example)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 系统提示补丁 | `system prompt patch` | 用一条 `system` 消息携带提示词章节差异或工具声明变化，下一次请求重放时合并；不是重写整段历史 | 规则章节变化时生成带 `sections` 的 system 消息；工具集合变化时由循环生成 `toolsAdded`/`toolsRemoved` | [M03 系统提示](03-session-and-context/README.md#m03-system)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 工具装载 | `tool loadout` | 当前激活并声明给模型的工具集合；可执行实现仍在本地工具表里，声明集合可以更小 | 注册了多个工具，但只激活 `read`、`bash`；扩展还可以隐藏某些声明，模型看不到它们 | [M03 系统提示](03-session-and-context/README.md#m03-system)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |

<a id="glossary-model-access"></a>
## 模型访问

| 术语 | 代码名 | 直白解释 | 具体例子 | 去哪看 |
| --- | --- | --- | --- | --- |
| 流函数 | `streamFn` | Agent 注入的模型请求函数；契约要求请求失败不抛异常或拒绝，而是把失败编码进返回流和最终 assistant 消息 | SDK 注入的闭包最终调用 `ModelRuntime.streamSimple()`；离线测试可注入 faux 实现 | [M02 钩子](02-agent-loop/README.md#m02-hooks)、[types.ts](../../../../packages/agent/src/types.ts) |
| 模型运行时 | `ModelRuntime` | 模型门面：模型注册表、认证、虚拟路由和请求装配；入口包括 `stream`、`streamSimple`、`completeSimple` | `streamSimple()` 先规范化上下文，虚拟模型先路由，再调用 `prepareRequest` 和供应商流 | [M04 函数路由](04-model-access/README.md#m04-routes)、[model-runtime.ts](../../../../packages/coding-agent/src/core/model-runtime.ts) |
| 供应商 | `provider` | 凭证和网关身份，决定用哪份认证、baseURL、代理和请求头；不是协议名 | `anthropic` 是 provider；换 provider 可能同时换凭证和目标地址 | [M04 三个名字](04-model-access/README.md#m04-names)、[model-runtime.ts](../../../../packages/coding-agent/src/core/model-runtime.ts) |
| API 协议 | `api` | 请求和响应协议，例如 Anthropic Messages 或 OpenAI Responses；一个 provider 可以实现多种 API | 兼容 OpenAI 协议的网关也可以使用 `openai-responses` 风格的 API | [M04 三个名字](04-model-access/README.md#m04-names)、[types.ts](../../../../packages/ai/src/types.ts) |
| 模型 ID | `model id` | 具体模型标识，带上下文窗口、输出上限、价格和能力信息；与 provider、api 三者不同 | 同一个 provider 下可以有多个 model id，上下文窗口可能相差很大 | [M04 三个名字](04-model-access/README.md#m04-names)、[types.ts](../../../../packages/ai/src/types.ts) |
| 虚拟模型 | `virtual model` | 目录里的一个选择项，不是直接发请求的物理模型；请求前由路由器解析成物理模型和思考档位 | 选中一个虚拟入口，`resolveModel()` 返回真实 provider/model；跨供应商时原供应商的 key、headers、env 不会被带过去 | [M04 虚拟模型与路由](04-model-access/README.md#m04-design)、[model-runtime.ts](../../../../packages/coding-agent/src/core/model-runtime.ts) |
| 思考档位 | `thinking` / `reasoning` | 请求给模型的思考预算档位；不是所有模型支持全部档位，路由器还可能把档位收窄到目标模型支持的范围 | `off`、`low`、`high` 等；Agent 在传 `off` 时会转成不指定 reasoning | [M04 运行示例](04-model-access/README.md#m04-example)、[types.ts](../../../../packages/agent/src/types.ts) |
| 上下文规范化 | `normalizeContext` | 把顶层 `systemPrompt` 和 `tools` 折成首条 system 消息，得到供应商请求使用的消息轨迹；不做摘要或截断 | `{ systemPrompt: "规则", messages: [user] }` 变成 `[system, user]` | [M04 运行示例](04-model-access/README.md#m04-example)、[transcript.ts](../../../../packages/ai/src/utils/transcript.ts) |
| 惰性流 | `lazyStream` | 同步返回一个事件流，同时立即启动异步 setup；认证或请求准备失败通常变成流内 error 事件和错误 assistant 消息 | `streamSimple()` 调用后马上拿到流；认证失败时最终消息 `stopReason: "error"`，调用方仍然按流消费 | [M04 同步返回流](04-model-access/README.md#m04-design)、[lazy.ts](../../../../packages/ai/src/api/lazy.ts) |
| 上下文溢出 | `context overflow` | 请求内容超过模型窗口导致失败；会话层可以压缩后重试，压缩原因记为 `overflow` | 长工具结果累积后请求报错，产生 `compaction_start { reason: "overflow" }`，再尝试恢复 | [M03 压缩](03-session-and-context/README.md#m03-compaction)、[compaction.ts](../../../../packages/coding-agent/src/core/compaction/compaction.ts) |
| 自动重试 | `retry` | 对可重试错误按退避策略再次请求；有 `auto_retry_start` / `auto_retry_end` 事件，与压缩摘要重试是两套流程 | 一次可重试的限流错误（如 429）后等待并重试，UI 可以先看到“还会重试”的 `agent_end.willRetry` | [M05 事件到界面](05-modes-and-tui/README.md#m05-interactive)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |

<a id="glossary-modes-events"></a>
## 模式与事件

| 术语 | 代码名 | 直白解释 | 具体例子 | 去哪看 |
| --- | --- | --- | --- | --- |
| 应用模式 | `appMode` | 宿主怎样驱动会话，类型是 `interactive`、`print`、`json`、`rpc`；由显式参数和 TTY 状态决定 | `--mode rpc` 优先；`--mode json` 走 JSON；`-p` 或 stdin/stdout 非 TTY 走打印；否则交互 | [M01 参数与模式](01-entry-and-config/README.md#m01-example)、[main.ts](../../../../packages/coding-agent/src/main.ts) |
| 打印模式 | `print` | 一次性执行，text 输出只打印最终 assistant 文本；错误写 stderr 并返回失败退出码 | `pi -p "读取 README.md 前 20 行并总结"` 只输出最后回答的 text 块 | [M05 打印模式](05-modes-and-tui/README.md#m05-print)、[print-mode.ts](../../../../packages/coding-agent/src/modes/print-mode.ts) |
| JSON 模式 | `json` | 一次性执行，输出会话头和多行会话事件 JSONL；事件经过 `toJsonEvent` 转换 | `pi --mode json -p "..."` 的第一行是会话头，后面是 `agent_start`、`message_end` 等事件 | [M05 打印模式](05-modes-and-tui/README.md#m05-print)、[print-mode.ts](../../../../packages/coding-agent/src/modes/print-mode.ts) |
| 交互模式 | `interactive` | 常驻终端界面，编辑器输入，多轮对话，支持流式期间 steer/followUp | 直接运行 `pi`，输入问题；工具行和助手文字随事件更新 | [M05 交互模式](05-modes-and-tui/README.md#m05-interactive)、[interactive-mode.ts](../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) |
| RPC 模式 | `rpc` | 从 stdin 读 JSON 命令，向 stdout 写 JSONL 响应和事件；供编辑器或宿主程序驱动 | 客户端发送 `{"type":"prompt","message":"读取 README.md"}`，再读取响应与事件 | [M05 RPC 模式](05-modes-and-tui/README.md#m05-rpc)、[rpc-mode.ts](../../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) |
| 终端界面 | `TUI` | 交互模式使用的终端渲染层，包括聊天区、编辑器、状态行和主题；它不是第四种 appMode | `interactive` 使用 TUI；`print`、`json`、`rpc` 不渲染 TUI | [M05 TUI 结构](05-modes-and-tui/README.md#m05-interactive)、[tui-renderer.ts](../../../../packages/coding-agent/src/modes/interactive/tui-renderer.ts) |
| 输出背压 | `backpressure` | 把协议 stdout 写入串成队列，并等待队列不再增长；只保证本地写队列，不证明远端已经消费 | JSON 模式订阅 Agent 事件并调用 `waitForRawStdoutBackpressure()`，防止事件产生速度远超 stdout 写入 | [M05 打印模式](05-modes-and-tui/README.md#m05-print)、[output-guard.ts](../../../../packages/coding-agent/src/core/output-guard.ts) |
| 插话 | `steering` | 当前 run 还在进行时排入的文字；在工具批次结束后、下一次模型请求前插入 | 工具执行中发送“也检查 B”，模型在下一次请求看到它 | [M05 流式期间输入](05-modes-and-tui/README.md#m05-interactive)、[types.ts](../../../../packages/agent/src/types.ts) |
| 追问 | `followUp` | 当前 run 本来要停止时再消费的文字，让循环继续；不会在当前工具批次中途插入 | 任务完成后发送“再总结成三点”，模型在新回合处理 | [M05 流式期间输入](05-modes-and-tui/README.md#m05-interactive)、[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) |
| 低层结束事件 | `agent_end` | 一次低层 Agent 运行结束；会话事件版本还带 `willRetry`，表示是否预计继续重试 | 一次可重试的限流失败后可能先出现 `agent_end.willRetry: true`，之后重试，不能把它当最终空闲 | [M02 事件序列](02-agent-loop/README.md#m02-events)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 会话稳定结束 | `agent_settled` | 整个会话最终收尾事件，在重试、压缩、续跑和扩展收尾之后发布，带 `aborted`；这是真正的空闲边界 | UI 检查 `agent_settled` 才能退出等待；`waitForIdle()` 也等到会话稳定 | [M05 事件到界面](05-modes-and-tui/README.md#m05-interactive)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 流式投递选项 | `streamingBehavior` | 会话正在运行时调用 `prompt()` 必须指定 `steer` 或 `followUp`，否则报“已在处理”错误 | 交互模式流式输入用 `streamingBehavior: "steer"`；希望本轮结束后处理则用 `"followUp"` | [M05 流式期间输入](05-modes-and-tui/README.md#m05-interactive)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |

<a id="glossary-extension-config"></a>
## 扩展与配置

| 术语 | 代码名 | 直白解释 | 具体例子 | 去哪看 |
| --- | --- | --- | --- | --- |
| 扩展 | `extension` | 通过资源加载器装入的代码，可以注册工具、命令、事件处理、快捷键和 UI；按会话绑定 | 扩展注册一个 `tool_call` 处理器，在工具执行前检查路径并决定是否阻止 | [M01 扩展与资源](01-entry-and-config/README.md#m01-design)、[types.ts](../../../../packages/coding-agent/src/core/extensions/types.ts) |
| 工具调用前钩子 | `beforeToolCall` | Agent 层钩子，在工具查找和参数校验之后、真正执行之前运行；可以阻止、给原因或要求终止 | 扩展对应的 `tool_call` 事件返回 `block: true`，Agent 生成错误 toolResult，不调用工具函数 | [M02 钩子](02-agent-loop/README.md#m02-hooks)、[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) |
| 工具调用后钩子 | `afterToolCall` | Agent 层钩子，在工具函数执行后、`tool_execution_end` 和 toolResult 消息之前运行；可以逐字段覆盖结果 | 扩展修改工具结果的 content 或 isError，最终 JSONL 保存修改后的结果 | [M02 钩子](02-agent-loop/README.md#m02-hooks)、[agent-loop.ts](../../../../packages/agent/src/agent-loop.ts) |
| 请求前钩子 | `prepareRequest` | Agent 层钩子，每次模型请求前运行，包括第一次；可以替换 context、model 和思考档位 | AgentSession 在这里用 `buildSessionProjection()` 重建上下文，保证压缩和 `context_edit` 在下一次请求生效 | [M03 为什么每次请求都投影](03-session-and-context/README.md#m03-store)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 下一回合钩子 | `prepareNextTurn` | 在 `turn_end` 之后、且循环继续时运行；可以替换下一回合的 context、model、思考档位并提供额外消息 | AgentSession 在这里检查压缩、刷新工具声明，并把 system 提示补丁放进下一回合 | [M02 钩子](02-agent-loop/README.md#m02-hooks)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 回合收尾钩子 | `finishTurn` | 在 assistant 消息和全部工具结果之后、`turn_end` 之前运行；返回 `continue`、`end` 或 `undefined` 决定是否继续 | 扩展要求继续时返回 `{ action: "continue" }`；没有决定则让循环按队列和默认规则停止 | [M02 钩子](02-agent-loop/README.md#m02-hooks)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 扩展事件 | `extension event` | 先发给扩展、再发给公开订阅者的会话事件；扩展可以替换消息、工具结果或回合边界决定 | `message_end` 处理器替换 assistant 内容，替换结果随后被会话层保存 | [M03 事件持久化](03-session-and-context/README.md#m03-store)、[agent-session.ts](../../../../packages/coding-agent/src/core/agent-session.ts) |
| 设置 | `settings` | 合并全局、受信任项目层和运行期覆盖的设置视图；驱动重试、压缩、队列模式、TUI 等 | 默认 `steeringMode` 和 `followUpMode` 都是 `one-at-a-time`；项目未受信任时项目设置层为空 | [M01 参数与装配](01-entry-and-config/README.md#m01-example)、[settings-manager.ts](../../../../packages/coding-agent/src/core/settings-manager.ts) |
| 项目信任 | `project trust` | 是否加载项目级设置、扩展和其他资源；未信任时只使用更安全的基础层 | 目录未受信任时，`.pi/extensions/` 不被求值，扩展钩子自然不会触发 | [M01 信任边界](01-entry-and-config/README.md#m01-example)、[project-trust.ts](../../../../packages/coding-agent/src/core/project-trust.ts) |
| 自定义消息 | `custom message` | 扩展产生的 `custom` 角色消息，持久化为 `custom_message` 条目；进入模型前由 `convertToLlm` 转换 | 扩展插入一条上下文提示；`display` 只控制界面是否展示，不决定是否进入投影 | [M03 条目类型](03-session-and-context/README.md#m03-store)、[session-manager.ts](../../../../packages/coding-agent/src/core/session-manager.ts) |
| 工具声明差异 | `toolsAdded` / `toolsRemoved` | `system` 消息里的工具增删声明；重放这些 system 消息可以还原当前工具集合，不包含可执行函数 | 回合中启用新工具，下一回合的 system 消息带 `toolsAdded`；模型看到声明，执行实现仍在本地表里 | [M02 工具执行](02-agent-loop/README.md#m02-walk-tools)、[transcript.ts](../../../../packages/ai/src/utils/transcript.ts) |
