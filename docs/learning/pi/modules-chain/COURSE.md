# pi 模块课程：从一次 query 到可维护的调用链

这是一套讲师可以直接照着讲、自学的人可以按路径走的课程。它不替代模块文档，只回答三个问题：先学什么、每一讲练什么、学到什么程度算会了。模块文档负责函数细节和源码路由；本课程负责顺序、练习、自测和验收。

<a id="course-audience"></a>
## 这门课面向谁

- 已经能读 TypeScript，想从 pi 的使用者变成维护者的人。
- 需要修改工具、系统提示、会话与压缩、模型接入、TUI 或 RPC 的工程师。
- 被一个具体现象卡住，需要先判断“该看哪一层”的排障者。
- 准备 review pi 的核心改动，需要理解调用链和不变量的 reviewer。

不适合只想学提示词写法、安装使用或产品功能的人。本课程几乎不讨论“怎样让模型回答得更好”，只讨论“一次回答在代码里怎样发生”。

<a id="course-outcomes"></a>
## 学完能做到什么

1. 画出一次 query 从 argv 到 provider 请求、工具结果、JSONL 和最终输出的完整链路，并说出每一层的数据形状。
2. 解释三条边界：模式层与核心层、`AgentSession` 与 `Agent`、`Agent` 与 `ModelRuntime`。
3. 在源码中定位入口、循环、会话投影、压缩、模型流和三种模式的入口函数，不靠猜文件名。
4. 用现有测试、会话 JSONL、事件流和 `rg` 验证自己的理解，而不是只读文档。
5. 完成一个小改动，并让类型检查、相关测试和文档路由校验通过。

<a id="course-prereqs"></a>
## 前置知识

- TypeScript：可辨识联合、泛型、`async`/`await`、`Promise`、`AbortController`、`for await`。不需要会写复杂类型体操，但要能读懂联合类型和类型收窄。
- Node.js：ESM 导入、CLI 参数、stdin/stdout、JSONL、基本的流式输出概念。
- Agent 基本概念：模型可以返回工具调用，工具在本地执行，结果要作为新消息再交给模型。不需要了解任何供应商 SDK 的细节。
- 工具：`rg`、`git diff`、IDE 的“跳转到符号/行”。会用 `node` 运行仓库脚本即可。

如果 TypeScript 读起来吃力，先补 `docs/learning/pi/TYPESCRIPT.md`。如果只想先看一条完整链路，读 `docs/learning/pi/QUERY_CALL_CHAIN.md`，再回到本课程。

<a id="course-time"></a>
## 时间预算

以下时间都是估算，按“边读边停下来查源码”的节奏计算，不按速读计算。

| 学习方式 | 预计时间 | 说明 |
| --- | --- | --- |
| 完整走一遍六讲 | 10-14 小时 | 读必读章节、做讲内观察、完成自测 |
| 加上全部动手实验 | 14-18 小时 | 需要模型认证的命令可能另计等待时间 |
| 快速建立全局观 | 2-3 小时 | 只走 00、traces 和模块的大白话/运行示例 |
| 核心开发 | 1-2 天 | 00 + 01/02/03 + 核心实验 |
| 深度维护 | 3-5 天 | 全部模块 + 04/05 + 源码拆解 + 全部实验和自测 |

“天”按每天 4-6 小时专注时间计算。不要用“读完文档”当完成标准，用每讲末尾的验收标准。

<a id="course-map"></a>
## 课程地图

### 六讲一览

| 讲 | 主题 | 主文档 | 预计时间 | 完成后应能 |
| --- | --- | --- | --- | --- |
| 1 | 全局地图：一次 query 的完整链路 | [00 全链路](00-full-chain/README.md) + [traces](traces/README.md) | 1-1.5 小时 | 画出全链路，解释三条边界和消息生命周期 |
| 2 | 入口与装配 | [01 入口与装配](01-entry-and-config/README.md) | 1-1.5 小时 | 说明参数、信任、服务、会话和模式如何组装 |
| 3 | Agent 循环与工具 | [02 Agent 循环](02-agent-loop/README.md) | 2.5-3.5 小时 | 解释一次 prompt 如何变成多次请求和工具往返 |
| 4 | 会话、上下文与压缩 | [03 会话与上下文](03-session-and-context/README.md) | 2-3 小时 | 解释 JSONL 树、请求投影、压缩和 `context_edit` |
| 5 | 模型访问与流式事件 | [04 模型访问](04-model-access/README.md) | 1.5-2 小时 | 解释模型 ID 到 provider 请求、事件流的全过程 |
| 6 | 模式、TUI 与 RPC | [05 模式与 TUI](05-modes-and-tui/README.md) | 1.5-2 小时 | 解释三种前端如何驱动同一个会话 |

### 讲与讲之间

第 1 讲建立坐标系；第 2 讲说明这些对象是谁创建的；第 3 讲是链路的核心；第 4 讲解释模型每一轮到底看到什么；第 5 讲把 `streamFn` 之后的供应商细节补齐；第 6 讲回到使用者能看到的三个前端。

顺序不建议打乱。第 3 讲依赖第 2 讲的对象装配，第 4 讲依赖第 3 讲的事件边界，第 6 讲依赖第 4 讲的会话事件。第 5 讲可以在第 3 讲之后随时插入；如果你只维护工具或会话，第 5 讲可以最后读。

<a id="course-lecture-1"></a>
## 第 1 讲：全局地图，一条 query 的完整链路

这一讲不要求记住函数名，只要求建立坐标系。后面五讲都在这个坐标系里加细节。

**先修**：能读 TypeScript 和 CLI 命令；不需要读过 pi 源码。

**预计时间**：1-1.5 小时（估算）。

**学习目标**

- 能不看文档画出 `argv -> CLI -> main -> AgentSession.prompt -> Agent.prompt -> runLoop -> streamFn -> provider -> toolResult -> JSONL -> output` 的主链。
- 能区分 run、turn、request、event 四个词，并各举一个例子。
- 能指出模式层/核心层、`AgentSession`/`Agent`、`Agent`/`ModelRuntime` 三条边界。
- 能解释 `message_end` 与 `message_update`、`agent_end` 与 `agent_settled` 的区别。

**必读**

- [00 全链路](00-full-chain/README.md) 全文，先读“先看地图”，再按 S1 到 S13 顺序读。
- 重点锚点：[地图](00-full-chain/README.md#m00-map)、[S1 进程启动](00-full-chain/README.md#m00-s1)、[S3 创建 Agent 和 AgentSession](00-full-chain/README.md#m00-s3)、[S5 会话入口](00-full-chain/README.md#m00-s5)、[S7 低层 Agent](00-full-chain/README.md#m00-s7)、[S8 主循环](00-full-chain/README.md#m00-s8)、[S11 工具往返](00-full-chain/README.md#m00-s11)、[S12 持久化](00-full-chain/README.md#m00-s12)、[S13 收尾](00-full-chain/README.md#m00-s13)。
- 选读：[交互模式](00-full-chain/README.md#m00-interactive)、[多轮](00-full-chain/README.md#m00-multiturn)、[压缩](00-full-chain/README.md#m00-compaction)。
- [traces](traces/README.md) 提供四条贯穿追踪：一条消息、一次工具调用、一份上下文、一个事件。先读“一条消息”和“一次工具调用”，它们会把 00 的时间顺序换成数据视角。

**核心问题**

1. 用户只问了一次，为什么模型可能被请求多次？
2. 一条完整消息在哪个事件落盘？`message_update` 为什么不能直接当历史？
3. `agent_end` 之后为什么还可能有重试、压缩或扩展续跑？
4. 多轮对话里，哪些状态跨轮保留，哪些每次请求都重建？

**跟着做**

1. 先不要跑真实模型。运行一次离线全链路测试，观察第一问的“两次模型请求、一次工具执行、四条新增消息”，再看第二问如何复用历史：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/query-call-chain-learning.test.ts
```

预期：测试通过；测试内的 faux provider 被调用 3 次（第一问两次、第二问一次），用户消息 2 条，助手消息 3 条，`agent_settled` 2 次。这个测试不访问模型服务。

2. 打开 `00-full-chain/README.md` 的 S8 和 S11，对照测试里的断言：第一次请求前上下文只有 user；第二次请求前多了 assistant(toolCall) 和 toolResult；第二问在第一问的完整历史之后继续。

3. 合上文档，在一张纸上画主链。每个箭头旁写“谁调用、输入是什么、输出是什么”。画完再对照 [地图](00-full-chain/README.md#m00-map)。

**观察点**

- 主链里 `AgentSession` 和 `Agent` 不是同一个东西：前者管会话、扩展、压缩、重试和持久化；后者只管“模型 -> 工具 -> 再问模型”的循环。
- `streamFn` 是注入给 `Agent` 的函数，不是供应商对象；`Agent` 不知道 API Key、HTTP 或 JSONL。
- 打印模式只在消息数组最后一项是 assistant 时输出它的 text 块；工具调用块不会当正文输出。

**自测**

1. 一次 `Agent.prompt()` 为什么可能产生多次模型请求？
   答案要点：模型只能返回消息，不能自己打开文件；工具在本地执行后，结果必须作为新消息再次发给模型，直到没有工具调用且没有队列消息。

2. 三条边界分别是什么？
   答案要点：模式层只决定输入/输出/生命周期，核心层统一调用 `AgentSession.prompt()`；`AgentSession` 管会话状态和持久化，`Agent` 管低层工具循环；`Agent` 通过 `streamFn` 访问模型，不直接依赖 `ModelRuntime` 或供应商。

3. `message_end` 和 `message_update` 哪个会写 JSONL？
   答案要点：`message_end`。`message_update` 是流式增量，只用于 UI 和事件；完整消息落盘发生在 `message_end`。

4. `agent_end` 和 `agent_settled` 有什么区别？
   答案要点：`agent_end` 表示低层循环不再产生事件；之后会话层还可能重试、压缩恢复或消费扩展排入的消息，`agent_settled` 才是整条 query 真正结束。

**验收标准**

- 解释：能用自己的话说明“一次 prompt 变成多次模型请求”的原因，不背函数名。
- 定位：能在 00 文档中指出 S5、S8、S11、S12 分别对应哪一层，并说出对应源码文件。
- 实验：离线全链路测试通过，并能解释测试里 3 次 faux 调用和 2 次 `agent_settled` 的来源。

<a id="course-lecture-2"></a>
## 第 2 讲：入口与装配

入口层不产生回答，但它决定后面所有对象是否可用。这一讲的重点不是 CLI 参数表，而是“谁在什么时候创建了什么”。

**先修**：第 1 讲；了解 Node CLI 和环境变量的基本用法。

**预计时间**：1-1.5 小时（估算）。

**学习目标**

- 能说明 `cli.ts`、`main.ts`、`sdk.ts` 三者的分工。
- 能按顺序列出一次启动的装配步骤：参数、cwd、信任、设置、认证、模型目录、扩展资源、`services`、`runtime`、模式分派。
- 能解释 `services` 与 `runtime` 为什么要分开，以及 `runtime.session` 为什么总是指向当前会话。
- 能指出 `Agent` 的构造位置和 `streamFn` 的注入位置。

**必读**

- [01 入口与装配](01-entry-and-config/README.md) 全文。
- 重点锚点：[一句话职责](01-entry-and-config/README.md#m01-duty)、[运行示例](01-entry-and-config/README.md#m01-example)、[函数路由](01-entry-and-config/README.md#m01-routes)、[关键设计](01-entry-and-config/README.md#m01-design)、[常见误解](01-entry-and-config/README.md#m01-misread)。
- 回到全链路：[S1](00-full-chain/README.md#m00-s1)、[S2](00-full-chain/README.md#m00-s2)、[S3](00-full-chain/README.md#m00-s3)。

**核心问题**

1. 既然 `main()` 做了几乎所有事，为什么还要保留很薄的 `cli.ts`？
2. `services` 和 `runtime` 各自保存什么？为什么扩展在运行中换会话时不需要重新加载模型目录和认证？
3. 项目信任为什么必须在加载 `.pi/extensions/` 和 `.pi/skills/` 之前决定？
4. `Agent` 从哪里拿到模型函数？它知道供应商、API Key 和 JSONL 吗？
5. `--api-key` 会写入 `auth.json` 吗？

**跟着做**

1. 运行帮助，确认本课程的 CLI 命令都来自真实参数：

```bash
pi --help
```

如果从源码仓库运行，先 `npm run build`，再用 `node packages/coding-agent/dist/bundle/cli.js --help` 替代。帮助里的 `--mode`、`--print`、`--session-dir` 是本课程会用到的参数。

2. 用 `rg` 找到装配链上的关键符号，不要依赖固定行号：

```bash
rg -n 'createAgentSessionServices|createAgentSessionRuntime|createAgentSession\(|new Agent\(|new AgentSession\(|streamFn:' \
  packages/coding-agent/src/main.ts packages/coding-agent/src/core/sdk.ts
```

预期：能看到 `main.ts` 里的服务、runtime、会话工厂，以及 `sdk.ts` 里 `new Agent`、`streamFn`、`new AgentSession`。行号会漂移，符号名不会。

3. 找到信任边界：

```bash
rg -n 'projectTrusted|resolveProjectTrusted|ProjectTrustStore' packages/coding-agent/src/main.ts
```

观察：未信任时用受限设置创建资源加载器；信任决定发生在项目扩展求值之前。这不是 UI 提示，而是安全边界。

**观察点**

- `main()` 是装配器，不是交互模式。`new InteractiveMode()` 只保存 runtime；`run()` 才初始化 TUI 并进入循环。
- `services` 是每个 cwd 共享的重资源；`runtime` 是可替换会话的轻容器。扩展命令可以换会话，但不需要重建模型目录和认证。
- `streamFn` 在 `sdk.ts` 构造 `Agent` 时注入；生产路径把它转到 `ModelRuntime`，测试路径可以注入 faux provider。
- `--api-key` 通过 `setRuntimeApiKey()` 只影响当前进程，不写 `auth.json`。

**自测**

1. `cli.ts` 和 `main.ts` 的分工是什么？
   答案要点：`cli.ts` 只做进程级准备并把去掉 `node` 和脚本路径的参数交给 `main()`；真正的参数解析、信任、装配和模式分派都在 `main.ts`。

2. `services` 和 `runtime` 的区别是什么？
   答案要点：`services` 持有每个 cwd 共享的模型运行时、认证、扩展资源加载器；`runtime` 持有创建/替换会话的工厂和当前会话，支持运行中换会话。

3. 为什么信任判断要放在加载项目资源之前？
   答案要点：项目扩展和技能可以执行代码；未信任时只加载全局资源，避免在用户确认前求值项目代码。

4. `Agent` 的 `streamFn` 在哪里注入？
   答案要点：`packages/coding-agent/src/core/sdk.ts` 构造 `Agent` 时注入；生产环境闭包调用 `ModelRuntime.streamSimple()`。

5. `--api-key` 会覆盖已保存的登录吗？
   答案要点：不会写入磁盘，只在当前进程覆盖运行期 key；进程结束后失效。

**验收标准**

- 解释：能不看文档复述一次启动的装配顺序，并说明每一步产出什么对象。
- 定位：能指出 `main`、`createAgentSessionServices`、`createAgentSessionRuntime`、`new Agent`、`new AgentSession`、`streamFn` 所在文件和符号。
- 实验：能运行 `--help`，并把 `--mode`、`--print`、`--session-dir` 与后续实验对应起来；能解释信任边界为什么是安全边界。

<a id="course-lecture-3"></a>
## 第 3 讲：Agent 循环与工具

这是全课的重心，也是 02 文档最厚的一讲。不要从 `agent-loop.ts` 第一行开始读。先记住 run、turn、request、event，再沿一次工具往返读；函数细节放在第二遍。

**先修**：第 1、2 讲；能读 `async`/`await` 和 `AbortController`。

**预计时间**：2.5-3.5 小时（估算）。

**学习目标**

- 能沿着 `Agent.prompt -> runPromptMessages -> runAgentLoop -> runLoop -> streamAssistantResponse -> executeToolCalls` 走完一次工具往返。
- 能解释 `runLoop` 的内层和外层各自解决什么问题。
- 能说明流式草稿为什么只占一个历史位置，以及 `message_end` 为什么是持久化边界。
- 能说明工具不存在、参数不合法、输出被截断、工具抛异常时，循环分别怎样继续。
- 能说出并行工具的结果为什么按原始调用顺序收集，以及整批串行的触发条件。

**必读**

- [02 Agent 循环与工具](02-agent-loop/README.md) 全文，按“大白话总览 -> 四个概念 -> 运行示例 -> 函数拆解 -> 事件序列 -> 关键设计 -> 常见误解”的顺序读。
- 重点锚点：[大白话总览](02-agent-loop/README.md#m02-plain)、[四个容易混的概念](02-agent-loop/README.md#m02-terms)、[运行示例](02-agent-loop/README.md#m02-example)、[Agent.prompt 到 runWithLifecycle](02-agent-loop/README.md#m02-walk-prompt)、[runLoop 的两层循环](02-agent-loop/README.md#m02-walk-loop)、[streamAssistantResponse](02-agent-loop/README.md#m02-walk-stream)、[executeToolCalls](02-agent-loop/README.md#m02-walk-tools)、[prepareToolCall](02-agent-loop/README.md#m02-walk-prepare)、[事件序列](02-agent-loop/README.md#m02-events)、[数据变化](02-agent-loop/README.md#m02-data)。
- 回到全链路：[S7](00-full-chain/README.md#m00-s7) 到 [S11](00-full-chain/README.md#m00-s11)。

**核心问题**

1. 为什么需要两层循环？插话（steering）和追问（follow-up）分别在哪一层被消费？
2. 流式期间收到很多 `text_delta`，为什么 Agent 历史里只有一条 assistant 消息？
3. 模型返回 `toolCall` 时，工具已经执行了吗？真正执行发生在哪个事件之后？
4. 工具不存在、参数不合法、输出被截断时，为什么循环不直接抛异常？
5. 并行工具的结果按什么顺序收集？为什么不能按完成顺序？

**跟着做**

1. 运行离线全链路测试，先看行为，再读函数：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/query-call-chain-learning.test.ts
```

打开 `packages/coding-agent/test/suite/query-call-chain-learning.test.ts`。重点看三个 faux 响应：第一次请求只看到 user；第二次请求看到 user、assistant(toolCall)、toolResult；第三次请求是第二句用户问题，仍能看到第一轮的工具结果。

2. 用 `rg` 验证调用链：

```bash
rg -n 'async prompt\(|runPromptMessages|runAgentLoop|runLoop|streamAssistantResponse|executeToolCalls' \
  packages/agent/src/agent.ts packages/agent/src/agent-loop.ts
```

预期：`Agent.prompt`、`runPromptMessages`、`runAgentLoop`、`runLoop`、`streamAssistantResponse`、`executeToolCalls` 都在；行号是快照，符号是稳定入口。

3. 读 `runLoop` 时在纸上写四个可变状态：`currentContext`、`config`、`lastCompletedTurn`、`explicitContinuation`。每读一段，标出这一段改了哪个状态、通过什么事件写回历史。

4. 合上 02 文档，写出一次带工具调用的事件序列，从 `agent_start` 到 `agent_end`。写完后对照 [事件序列](02-agent-loop/README.md#m02-events)。

**观察点**

- `runLoop` 的内层处理“模型要求工具”和“工具批次后插入的插话”；外层处理“模型本来要停止，但用户又排了追问”。
- `streamAssistantResponse` 在 `start` 时把草稿放进历史；之后每个 delta 替换最后一个元素；`done` 或 `error` 时替换成最终消息。历史不会变成几百条片段。
- 工具在 `message_end` 之后、由 `runLoop` 单独调度。工具失败、工具不存在、参数错误、输出截断，最终都会变成 `isError: true` 的 `toolResult` 消息。
- 并行执行只并行 `execute`，准备阶段（查找、校验、前置钩子）仍然串行，且结果按模型给出的调用顺序收集。
- `agent_end` 只表示低层循环不再产生事件。会话层之后还可能重试、压缩和续跑。

**自测**

1. run、turn、request、event 分别是什么？
   答案要点：run 是一次 `Agent.prompt()` 或 `Agent.continue()`；turn 是一次模型回答加上它要求的工具执行；request 是真正调用一次供应商；event 是 Agent 对外发布的进度通知。

2. 为什么流式草稿只占一个历史位置？
   答案要点：`start` 把草稿 push 进历史，delta 只替换最后一个元素，`done`/`error` 用最终消息替换草稿。这样 UI 可以逐字渲染，历史里仍只有一条完整 assistant 消息。

3. 工具不存在或参数不合法时会发生什么？
   答案要点：`prepareToolCall` 返回立即结果，包装成 `isError: true` 的 `toolResult` 消息；循环继续，模型看到错误后可以修正或换工具。

4. 输出被截断（`stopReason: "length"`）时为什么不执行工具？
   答案要点：工具参数可能只写了一半，执行半截参数会产生错误副作用；循环为每个调用生成失败结果，让模型重试。

5. 并行工具的结果为什么按原始调用顺序收集？
   答案要点：`toolResult` 靠 `toolCallId` 与 `toolCall` 配对；按原始顺序收集能保证配对稳定，模型看到的顺序与它发出的顺序一致。

**验收标准**

- 解释：能用自己的话讲清“一次用户输入为什么变成两次模型请求”，以及两层循环各自处理什么。
- 定位：能指出 `Agent.prompt`、`runPromptMessages`、`runAgentLoop`、`runLoop`、`streamAssistantResponse`、`executeToolCalls`、`prepareToolCall` 所在文件和职责。
- 实验：离线全链路测试通过；能从测试断言解释 3 次 faux 调用、1 次工具结果、2 条用户消息和 3 条助手消息的来源；能写出带工具调用的事件序列。

<a id="course-lecture-4"></a>
## 第 4 讲：会话、上下文与压缩

会话层解决的是“模型这一轮到底看到什么”。它不是把 `messages` 简单写进文件，而是维护一棵只追加的条目树，再在每次请求前投影出模型可见的上下文。

**先修**：第 3 讲，尤其要理解 `message_end` 和 `prepareRequest`。

**预计时间**：2-3 小时（估算）。

**学习目标**

- 能解释 JSONL 为什么是条目树而不是聊天数组，`id`、`parentId`、`leafId` 各起什么作用。
- 能按顺序说出 `buildSessionProjection()` 的步骤：找当前分支、找最新压缩检查点、排序条目、应用 `context_edit`、生成消息。
- 能解释“Agent 内存里的消息是工作副本，每次请求以会话投影为准”的原因。
- 能说明压缩检查点、`firstKeptEntryId`、`context_edit` 对模型视图和原始文件的不同影响。
- 能列出多轮对话中哪些状态跨轮保留、哪些每次重建。

**必读**

- [03 会话、上下文与压缩](03-session-and-context/README.md) 全文。
- 重点锚点：[运行示例](03-session-and-context/README.md#m03-example)、[会话文件与条目树](03-session-and-context/README.md#m03-store)、[多轮如何复用历史](03-session-and-context/README.md#m03-multiturn)、[压缩](03-session-and-context/README.md#m03-compaction)、[系统提示](03-session-and-context/README.md#m03-system)、[context_edit](03-session-and-context/README.md#m03-context-edit)、[常见误解](03-session-and-context/README.md#m03-misread)。
- 回到全链路：[S5](00-full-chain/README.md#m00-s5)、[S6](00-full-chain/README.md#m00-s6)、[S12](00-full-chain/README.md#m00-s12)、[多轮](00-full-chain/README.md#m00-multiturn)、[压缩](00-full-chain/README.md#m00-compaction)。

**核心问题**

1. 为什么 JSONL 只追加、不修改旧行？`parentId` 怎样表达分支？
2. 为什么每次模型请求前都要重新投影？只在启动时投影一次会坏在哪？
3. 压缩会删除旧消息吗？`firstKeptEntryId` 决定什么？
4. `context_edit` 改的是原始历史还是模型视图？同一条消息被编辑多次时哪一次生效？
5. 多轮对话里，哪些状态来自会话树，哪些每轮重新计算？

**跟着做**

1. 运行 `context_edit` 测试，先看“存储”和“投影”的差异：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/session-context-edit.test.ts
```

打开 `packages/coding-agent/test/session-context-edit.test.ts`。重点看四组断言：`getBranch()` 里仍有 3 条 message 条目（另有 2 条 `context_edit` 条目），但 `buildSessionProjection().messages` 只剩 user；原始条目仍保留原内容；同一目标多次编辑时最后一条生效；切换分支后编辑不再生效。

2. 生成一份真实会话 JSONL，观察条目字段：

```bash
SESSION_DIR=$(mktemp -d /tmp/pi-course-session.XXXXXX)
pi --session-dir "$SESSION_DIR" -p "读取 README.md 前 20 行并总结"
find "$SESSION_DIR" -maxdepth 1 -name '*.jsonl' -print
rg -n '"toolCall"|"toolResult"|"parentId"' "$SESSION_DIR"/*.jsonl
```

预期：能看到 `session` 头、用户消息、带 `toolCall` 的 assistant、对应的 `toolResult`、最终 assistant；每条消息有 `id` 和 `parentId`；只有完整消息，没有 `message_update`。如果本机未配置模型，跳过这一步，用实验 3 的离线测试替代。

3. 用 `rg` 找到投影和压缩的入口：

```bash
rg -n 'buildSessionProjection|buildContextEntries|projectContextEntry|shouldCompact|generateSummary' \
  packages/coding-agent/src/core/session-manager.ts packages/coding-agent/src/core/compaction/compaction.ts
```

4. 画两幅图：左边是 JSONL 条目树，右边是当前叶子的投影结果。标出压缩检查点、保留的原文尾巴、被 `context_edit` 隐藏的消息。

**观察点**

- 原始 JSONL 是审计记录，永不因压缩或编辑而删除；模型看到的只是投影。
- `buildSessionProjection()` 从当前叶子沿 `parentId` 走到根，找到最新压缩检查点，再按 `firstKeptEntryId` 保留原文尾巴。
- `context_edit` 的 `null` 表示对模型隐藏，内容对象表示替换；同一目标在当前范围内最后一条编辑生效。
- 系统提示不是固定字符串：工具声明、项目上下文、扩展规则和模式信息都会影响它；工具或扩展变化时会重建。
- `agent_end` 之后还有重试、压缩恢复和 `agent_before_settle`，真正的结束信号是 `agent_settled`。

**自测**

1. JSONL 是线性聊天记录吗？
   答案要点：不是。它是只追加的条目树，`parentId` 决定分支；直接按文件顺序读会忽略分支和压缩。

2. 为什么每次请求前都要重新投影？
   答案要点：Agent 内存里的消息是工作副本；压缩刚写入检查点、扩展刚添加 `context_edit`、另一个入口刚切换分支时，只有重新投影才能让下一次请求立即反映这些变化。

3. 压缩会删除旧消息吗？
   答案要点：不会。它写入 `compaction` 条目，保存摘要和 `firstKeptEntryId`；投影用摘要替代更早历史，原始 JSONL 仍保留。

4. `context_edit` 影响什么？
   答案要点：只影响模型投影。`null` 隐藏目标消息，内容对象替换目标消息的 content；原始条目不变；同一目标最后一条编辑生效。

5. 多轮里哪些状态跨轮保留？
   答案要点：消息历史/会话树、系统提示、模型和思考级别、工具注册、压缩摘要保留；请求上下文和 API Key 每次请求重建或重新解析。

**验收标准**

- 解释：能用自己的话说明“存储的历史”和“模型看到的历史”为什么可以不同。
- 定位：能指出 `SessionManager.appendMessage`、`buildSessionProjection`、`buildContextEntries`、`projectContextEntry`、`shouldCompact`、`generateSummary` 所在文件和职责。
- 实验：`context_edit` 测试通过；能解释 `getBranch()` 与 `buildSessionProjection()` 的差异；能从真实 JSONL 或测试夹具中找出 `parentId` 链和一条工具结果。

<a id="course-lecture-5"></a>
## 第 5 讲：模型访问与流式事件

到这一层，Agent 已经不再出现。输入是统一消息和模型描述，输出是统一事件流；供应商协议、认证、HTTP 和 SSE 都在这一层被吸收。

**先修**：第 3 讲，尤其要理解 `streamAssistantResponse` 怎样消费事件；了解 HTTP/SSE 的基本概念。

**预计时间**：1.5-2 小时（估算）。

**学习目标**

- 能区分 provider、api、model id 三个名字，并说明各自决定什么。
- 能解释 `streamSimple` 为什么同步返回事件流，认证和网络请求在哪里异步建立。
- 能说明认证为什么每次请求前解析，以及跨供应商路由时为什么要丢弃原供应商的凭证。
- 能列出统一事件协议的主要事件，并说明 `toolcall_delta` 为什么不能直接 `JSON.parse`。
- 能说明请求错误为什么通常变成 `error` 事件，而不是抛到 Agent 循环外。

**必读**

- [04 模型访问](04-model-access/README.md) 全文。
- 重点锚点：[运行示例](04-model-access/README.md#m04-example)、[三个名字不要混](04-model-access/README.md#m04-names)、[关键设计](04-model-access/README.md#m04-design)、[常见误解](04-model-access/README.md#m04-misread)。
- 回到全链路：[S9](00-full-chain/README.md#m00-s9)、[S10](00-full-chain/README.md#m00-s10)。
- 回到循环：[streamAssistantResponse](02-agent-loop/README.md#m02-walk-stream)。

**核心问题**

1. provider 和 api 有什么区别？为什么一个 provider 可以实现多种 api？
2. `streamSimple` 为什么不是 `async` 函数？调用方什么时候才真正等待网络？
3. 认证为什么不在构造 `ModelRuntime` 时固定？哪些情况会让凭证在运行中变化？
4. 跨供应商路由时，为什么不能把原供应商的 API Key 和 headers 带过去？
5. `toolcall_delta` 为什么不能直接解析成参数对象？完整参数在哪里出现？

**跟着做**

1. 运行 faux provider 测试，先看统一事件流的最小实现：

```bash
(cd packages/ai && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/faux-provider.test.ts)
```

打开 `packages/ai/test/faux-provider.test.ts`。重点看 `registerFauxProvider`、`setResponses`、`stream`、`complete`：它替换的是 provider/网络层，不是 Agent 循环。

2. 用 `rg` 找到运行时入口和供应商入口：

```bash
rg -n 'streamSimple|prepareRequest|resolveModel|lazyStream|provider\.streamSimple' \
  packages/coding-agent/src/core/model-runtime.ts packages/ai/src/api/lazy.ts
```

预期：`ModelRuntime.streamSimple` 负责归一化、虚拟模型路由和请求准备；`lazyStream` 同步返回流、异步建立请求；`prepareRequest` 解析认证、baseURL、headers 和 env。

3. 读 `packages/ai/src/types.ts` 里的 `AssistantMessageEvent`，对照 04 文档的事件表。然后选一条 `text_delta`，从 provider 实现追到 `streamAssistantResponse` 的 `message_update`。

4. 打开 `packages/coding-agent/test/suite/harness.ts`，找到 `streamFn: streamSimple`。说明它替换了哪一层：Agent、AgentSession、工具和持久化仍然是真的，只有模型调用被脚本化。

**观察点**

- provider 是公司/网关身份和凭证来源；api 是请求/响应协议；model id 是具体模型和上下文窗口。三者不是同义词。
- `streamSimple` 同步返回 `AssistantMessageEventStream`；`lazyStream` 在流对象创建时就立即启动异步 setup（认证、模块加载等），不等消费者开始迭代。setup 或转发失败会变成 `error` 事件。
- 认证每次请求前解析，支持 OAuth 刷新、运行期 `--api-key`、路由切换和代理变化。
- 跨供应商路由会丢弃原供应商的 `apiKey`、`headers`、`env`，让目标供应商重新解析自己的凭证。
- `toolcall_delta` 只是 JSON 参数字符串片段，不保证每个片段可独立解析；完整参数在 `toolcall_end` 或最终消息里。

**自测**

1. provider、api、model id 分别决定什么？
   答案要点：provider 决定公司/网关和凭证；api 决定请求/响应协议；model id 决定具体模型和上下文窗口。

2. `streamSimple` 为什么同步返回？
   答案要点：它立即返回事件流，同时在创建流时启动 `lazyStream` 的异步 setup；调用方可以立刻 `for await`，setup 或转发错误会变成 `error` 事件。

3. 认证在什么时候解析？为什么不能只解析一次？
   答案要点：每次请求前由 `prepareRequest` 解析；OAuth token 可能过期，运行期 key 可能变化，路由器可能切换 provider，代理和环境变量也可能变化。

4. 跨供应商路由时凭证怎么处理？
   答案要点：丢弃原供应商的 `apiKey`、`headers`、`env`，让目标供应商重新解析自己的凭证；否则会把 A 公司的 key 发给 B 公司。

5. `toolcall_delta` 可以直接 `JSON.parse` 吗？
   答案要点：不能。它只是参数文本片段，完整参数在 `toolcall_end` 或最终消息里。

**验收标准**

- 解释：能画出 `streamFn -> ModelRuntime.streamSimple -> prepareRequest -> provider.streamSimple -> AssistantMessageEventStream` 的路径，并说明每一步做什么。
- 定位：能指出 `ModelRuntime.streamSimple`、`prepareRequest`、`resolveModel`、`lazyStream`、`AssistantMessageEvent` 所在文件和职责。
- 实验：faux provider 测试通过；能说明 `registerFauxProvider` 和 `harness.ts` 各自替换了哪一层；能列出统一事件协议的主要事件。

<a id="course-lecture-6"></a>
## 第 6 讲：模式、TUI 与 RPC

三种模式不是三套对话系统，而是三种输入/输出适配器。它们都调用同一个 `AgentSession.prompt()`，都消费同一套会话事件；差别只在输入从哪来、输出到哪去、进程生命周期有多长。

**先修**：第 2 讲（模式分派）和第 4 讲（会话事件）。

**预计时间**：1.5-2 小时（估算）。

**学习目标**

- 能比较 text、json、interactive、rpc 四种输出的输入、输出、生命周期和适用场景。
- 能解释 `runPrintMode` 在 text 和 json 下分别做什么，以及 text 为什么只读取消息数组最后一项、且仅当它是 assistant 时打印 text 块。
- 能说明交互模式如何把 `AgentSessionEvent` 映射到 TUI 组件，以及为什么 TUI 没有独立的对话逻辑。
- 能解释流式期间的输入为什么走 `steer`/`followUp` 队列，而不是新开一轮。
- 能说明 RPC 为什么接管 stdout，以及它如何复用同一个会话。

**必读**

- [05 模式与 TUI](05-modes-and-tui/README.md) 全文。
- 重点锚点：[运行示例](05-modes-and-tui/README.md#m05-example)、[三种模式对比](05-modes-and-tui/README.md#m05-compare)、[打印模式](05-modes-and-tui/README.md#m05-print)、[交互模式](05-modes-and-tui/README.md#m05-interactive)、[RPC 模式](05-modes-and-tui/README.md#m05-rpc)、[常见误解](05-modes-and-tui/README.md#m05-misread)。
- 回到全链路：[S4](00-full-chain/README.md#m00-s4)、[S13](00-full-chain/README.md#m00-s13)、[交互模式](00-full-chain/README.md#m00-interactive)。

**核心问题**

1. text 和 json 都由 `runPrintMode` 实现，它们的输出有什么本质区别？
2. 交互模式为什么不需要自己的对话循环？它订阅哪些事件、更新哪些组件？
3. 流式期间用户再次提交文字，消息去了哪里？`steer` 和 `followUp` 的插入时机有什么不同？
4. 为什么 `agent_end` 后 TUI 还不能立刻回到空闲？
5. RPC 为什么必须接管 stdout？它和交互模式共享什么、不共享什么？

**跟着做**

1. 用同一个问题对比 text 和 JSON 输出：

```bash
pi -p "用一句话说明 README.md 的主题"
pi --mode json -p "用一句话说明 README.md 的主题" > /tmp/pi-events.jsonl
head -5 /tmp/pi-events.jsonl
```

注意：当前 CLI 没有顶层 `--json` 参数；JSON 输出用 `--mode json`，以 `pi --help` 为准。`-p` 在这里是显式的非交互意图；`--mode json` 已足以进入 JSON 打印流程。预期：text 只输出最终 assistant 文本；JSON 第一行是会话头，之后是事件 JSONL，包含 `message_start`、`message_update`、`message_end` 等。

2. 统计事件类型，确认 JSON 模式输出的是同一套会话事件：

```bash
rg -o '"type":"[^"]+"' /tmp/pi-events.jsonl | sort | uniq -c
```

预期：能看到 `session`、`agent_start`、`turn_start`、`message_start`、`message_update`、`message_end`、`turn_end`、`agent_end`、`agent_settled` 等类型。没有工具调用时不会出现 `tool_execution_*`。

3. 用 `rg` 找到三个模式入口和事件处理：

```bash
rg -n 'runPrintMode|runRpcMode|InteractiveMode|handleEvent|subscribeToAgent|streamingBehavior' \
  packages/coding-agent/src/modes packages/coding-agent/src/main.ts
```

4. 打开 `packages/coding-agent/src/modes/print-mode.ts`，找到 text 分支读取消息数组最后一项、并且只在它是 assistant 时打印的代码；再打开交互模式的 `handleEvent`，对照 05 文档的事件表。

**观察点**

- text 模式只在所有 prompt 结束后取 `session.state.messages` 的最后一项；仅当它是 assistant 时打印其中的 text 块。末项不是 assistant 时不输出正文，中间轮次的工具调用、思考和早期 assistant 文本也从不作为正文输出。
- json 模式订阅会话事件并逐行序列化；它还监听 stdout 背压，避免事件产生速度超过输出速度。
- 交互模式的主循环只有“等待输入 -> `session.prompt()` -> 显示错误”；消息、工具、状态行的更新都来自会话事件。
- 流式期间提交文字走 `steer`，在当前工具批次结束后、下一次模型请求前插入；`followUp` 在本轮自然停止时插入。
- RPC 接管 stdout，从 stdin 逐行读 JSON 命令，响应和事件都以 JSONL 写出；会话替换后重新订阅。

**自测**

1. text 模式打印什么？
   答案要点：读取消息数组最后一项，仅当它是 assistant 时打印其中的 text 块；末项不是 assistant 就不输出正文。中间轮次的工具调用、思考和早期文本不打印。错误/取消写 stderr 并返回 1。

2. json 模式输出什么？
   答案要点：会话事件 JSONL，先输出会话头，再逐行输出 `AgentSessionEvent`；`message_update` 会去掉累积的 partial 快照，只保留增量和用量。

3. 流式期间输入会开新会话吗？
   答案要点：不会。它进入 `steer` 或 `followUp` 队列，由当前运行在安全边界消费；队列消息不是新的 `prompt()`。

4. 为什么 `agent_end` 后 TUI 还要等 `agent_settled`？
   答案要点：`agent_end` 后还可能重试、压缩恢复和扩展收尾；`agent_settled` 才是整条 query 真正结束，TUI 这时才回到空闲。

5. RPC 为什么要接管 stdout？
   答案要点：防止普通 `console.log` 污染 JSONL 协议；RPC 用 stdout 写响应和事件，用 stdin 读命令。

**验收标准**

- 解释：能用自己的话比较 text、json、interactive、rpc 的输入、输出和生命周期，并说明它们共享同一个 `AgentSession`。
- 定位：能指出 `runPrintMode`、`runRpcMode`、`InteractiveMode.run`、`subscribeToAgent`、`handleEvent` 所在文件和职责。
- 实验：能跑 text 与 JSON 两种输出并解释差异；能从 JSONL 中列出主要事件类型；能说明 `steer`/`followUp` 的插入时机。

<a id="course-paths"></a>
## 三种学习路径

三条路径不是三个难度等级，而是三个使用场景。先选交付物，再决定读多深。

| 路径 | 时间（估算） | 阅读 | 实验 | 交付物 |
| --- | --- | --- | --- | --- |
| 快速建立全局观 | 2-3 小时 | 00 + traces + 每模块的大白话/运行示例 | 实验 1、3 | 一页链路图 + 三条边界说明 |
| 核心开发 | 1-2 天 | 00 + 01/02/03 全文 | 实验 1、2、3、4、6、7、10 | 能定位并解释一个工具/会话问题，能跑相关测试 |
| 深度维护 | 3-5 天 | 全部六讲 + 04/05 + DEBUG_MAP | 全部实验 + 全部自测 | 一个小改动 + 测试 + 路由校验通过 |

<a id="course-path-quick"></a>
### 快速建立全局观（2-3 小时）

适合第一次接触 pi、需要快速判断改动属于哪一层的人。

1. 读 [00 全链路](00-full-chain/README.md) 的地图、S1、S3、S5、S8、S11、S12、S13。
2. 读 [traces](traces/README.md) 的“一条消息”和“一次工具调用”。
3. 进入 01-05 每篇 README，只读开头的职责说明、“大白话总览”和“运行示例”；不读函数路由和函数拆解。
4. 做实验 1 和实验 3。没有模型认证时只做实验 3。
5. 合上文档，画一页链路图，写三句话解释三条边界。

完成标准：别人问“这条消息为什么又请求了一次模型”，你能指出是工具往返，而不是 UI 或 provider 重试。

<a id="course-path-core"></a>
### 核心开发（1-2 天）

适合要改工具、系统提示、会话行为或调试一次具体运行的人。

1. 完整读第 1、2、3、4 讲及其必读章节。
2. 做实验 1、2、3、4、6、7、10。实验 2 需要模型认证；没有认证时用实验 3 的 JSONL 断言替代。
3. 精读 02 的函数拆解一至八，以及 03 的“会话文件与条目树”“压缩”“context_edit”。
4. 选一个你关心的现象，用 `rg` 从现象追到函数，写出“入口 -> 状态 -> 数据形状 -> 副作用 -> 失败分支”。
5. 跑相关单测：`query-call-chain-learning.test.ts`、`session-context-edit.test.ts`、`faux-provider.test.ts`。

完成标准：能独立解释一次工具往返和一次上下文投影；能指出修改应该落在哪一层，而不是把所有问题都归到 Agent 循环。

<a id="course-path-deep"></a>
### 深度维护（3-5 天）

适合要长期维护这套代码、review 核心改动或修改文档体系的人。

1. 完整读六讲，包括第 5、6 讲的必读章节和 02/03 的全部函数拆解。
2. 做全部十个实验，并完成每讲自测。自测不要只选“是/否”，要写出失败分支和数据变化。
3. 读 [DEBUG_MAP.md](DEBUG_MAP.md)，按“现象 -> 层 -> 数据 -> 函数”走一遍；把课程里的问题记到术语表或排障地图。
4. 选一个未收录的函数，给对应模块补一条路由，运行 `build.mjs --check`，必要时用 `--fix` 修正行号，检查 diff 只包含你的改动。
5. 做一个小改动，至少覆盖一条失败路径；运行 `npm run check` 和相关单测；如果改了文档路由，再跑 `build.mjs --check`。

完成标准：能指出一个改动会经过哪些层、会改哪些数据、会在哪里失败；能验证文档路由和源码链接没有漂移；能把自己的解释写成可复用的排障条目。

<a id="course-method"></a>
## 每讲怎么学

不要一上来逐行读。逐行读会让人记住局部语句，却不知道当前函数在整条链路的哪一段。按下面的循环走：

1. **预测**：看模块职责、函数名和调用点，先写下你猜的输入、输出和失败分支。
2. **读源码**：读模块文档后，打开入口函数和它直接调用的关键子函数。第一遍只建立调用链，不追每个分支。
3. **跑或观察**：用测试、JSONL、事件流或 `rg` 验证预测。预测错了，记录错在哪一层。
4. **复述**：不看文档，用“输入 -> 步骤 -> 状态变化 -> 输出 -> 失败分支”讲一遍。讲不下去的地方就是没懂的地方。
5. **做练习**：完成本讲的“跟着做”或实验清单中的一项，用可观察结果验证。
6. **记录问题**：把问题写成“现象 + 我以为是 + 实际是 + 源码位置 + 下一个实验”，不要只写“这里不懂”。

### 先建立调用链和数据结构

每一讲至少记录下面五项。可以手写，也可以用一个固定表格：

| 项目 | 记录什么 |
| --- | --- |
| 入口 | 谁调用它，参数是什么，返回什么 |
| 状态 | 哪个对象持有状态，什么时候修改 |
| 数据形状 | 类型/字段在哪一层变化，哪里发生转换 |
| 副作用 | 写 JSONL、发事件、发 HTTP、改终端 |
| 失败 | 错误变成消息、事件，还是异常 |

以 `runLoop` 为例：入口是 `runAgentLoop`/`runAgentLoopContinue`，状态是 `currentContext`、`config`、`lastCompletedTurn`、`explicitContinuation`，数据形状在 `streamAssistantResponse` 里从 Agent 消息变成供应商消息，副作用是发事件和调用工具，失败分支是 `stopReason: "error"`/`"aborted"` 或工具错误结果。

### 读源码的顺序

1. 模块的一句话职责和大白话总览。
2. 运行示例：具体输入、具体对象、具体事件。
3. 入口函数和调用链。
4. 数据结构：消息、上下文、条目、事件、流。
5. 函数拆解和失败分支。
6. 常见误解和设计取舍。

第一遍不要追每个工具实现、每个 provider 协议分支、每个 TUI 组件。它们只在你要改对应层时才需要。

### 复述模板

“输入是……；经过……；状态在……被修改；输出是……；如果……失败，会变成……，由……处理。”

能用这个模板讲清一个函数，比记住它的行号更有用。

<a id="course-labs"></a>
## 动手实验清单

以下实验至少完成 8 个。每个实验都给出目标、入口、预期观察和对应模块。命令中的 `pi` 指已安装的 CLI；从源码仓库运行时，先 `npm run build`，再用 `node packages/coding-agent/dist/bundle/cli.js` 替代 `pi`。测试类实验通过 Vitest 的源码别名运行，不要求先构建 CLI。

需要模型认证的实验（1、2、10）如果没有配置认证，直接跳过，用实验 3 的离线测试替代；不要为了上课购买 token。

<a id="course-lab-1"></a>
### 实验 1：对比 text 与 JSON 输出

- **目标**：看清模式层对同一会话的不同输出方式。
- **命令**：

```bash
pi -p "用一句话说明 README.md 的主题"
pi --mode json -p "用一句话说明 README.md 的主题" > /tmp/pi-events.jsonl
head -5 /tmp/pi-events.jsonl
```

- **预期观察**：text 只有最终 assistant 文本；JSON 第一行是会话头，之后是事件 JSONL，包含 `message_start`、`message_update`、`message_end` 等。当前 CLI 没有顶层 `--json`，JSON 输出必须用 `--mode json`。
- **对应模块**：第 6 讲、第 1 讲；05 的打印模式、00 的 S4/S13。

<a id="course-lab-2"></a>
### 实验 2：找到一次工具调用对应的 JSONL 条目

- **目标**：把 `message_end` 的持久化边界落到磁盘上的具体行。
- **命令**：

```bash
SESSION_DIR=$(mktemp -d /tmp/pi-course-session.XXXXXX)
pi --session-dir "$SESSION_DIR" -p "读取 README.md 前 20 行并总结"
find "$SESSION_DIR" -maxdepth 1 -name '*.jsonl' -print
rg -n '"toolCall"|"toolResult"|"parentId"' "$SESSION_DIR"/*.jsonl
```

- **预期观察**：一条 session 头、user 消息、带 `toolCall` 的 assistant、匹配 `toolCallId` 的 `toolResult`、最终 assistant。每条消息有 `id` 和 `parentId`；没有 `message_update` 片段。工具调用和结果各占一条完整消息。
- **对应模块**：第 3、4 讲；02 的 S11、03 的 S12。

<a id="course-lab-3"></a>
### 实验 3：跑离线全链路测试

- **目标**：不访问模型服务，观察一次工具往返和跨轮历史。
- **命令**：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/query-call-chain-learning.test.ts
```

- **预期观察**：测试通过；faux provider 调用 3 次，用户消息 2 条，助手消息 3 条，`agent_settled` 2 次。第一次请求只看到 user；第二次请求看到 user、assistant(toolCall)、toolResult；第二问复用第一问的历史。
- **对应模块**：第 1、3、4 讲；00 的 S7-S12。

<a id="course-lab-4"></a>
### 实验 4：用 `rg` 找出 `AgentSession.prompt` 到 `Agent.prompt` 的调用点

- **目标**：验证调用链不是文档编出来的。
- **命令**：

```bash
rg -n 'async prompt\(|_startRun|this\.agent\.prompt|runAgentLoop|runLoop' \
  packages/coding-agent/src/core/agent-session.ts packages/agent/src/agent.ts packages/agent/src/agent-loop.ts
```

- **预期观察**：`AgentSession.prompt` 是会话入口；`_startRun` 里调用 `this.agent.prompt(messages)`；`Agent.prompt` 进入 `runPromptMessages`，最终调用 `runAgentLoop`/`runLoop`。行号会漂移，符号名稳定。
- **对应模块**：第 1、3 讲；00 的 S5-S8。

<a id="course-lab-5"></a>
### 实验 5：找一个 faux provider 例子并说明它替换了哪一层

- **目标**：理解测试接缝和真实运行路径的差异。
- **命令**：

```bash
rg -n 'registerFauxProvider|setResponses|streamFn: streamSimple|complete\(|stream\(' \
  packages/ai/test/faux-provider.test.ts packages/coding-agent/test/suite/harness.ts
```

- **预期观察**：`packages/ai/test/faux-provider.test.ts` 直接调用 `stream`/`complete`，替换 provider/网络层；`packages/coding-agent/test/suite/harness.ts` 把 faux 的 `streamSimple` 作为 `Agent` 的 `streamFn` 注入，Agent、AgentSession、工具、消息转换和持久化仍然是真的。它替换的是模型访问层，不是 Agent 循环或会话层。
- **对应模块**：第 3、5 讲；04 的 faux provider、02 的 `streamAssistantResponse`。

<a id="course-lab-6"></a>
### 实验 6：画出一条消息从 argv 到 provider 的表示变化

- **目标**：看清每一层的数据形状，而不是只记函数名。
- **入口**：按顺序读这些位置，自己画表：

```text
packages/coding-agent/src/cli/args.ts          parseArgs: string[] -> Args.messages
packages/coding-agent/src/modes/print-mode.ts  runPrintMode: string -> session.prompt
packages/coding-agent/src/core/agent-session.ts _prepareRun/_startRun: AgentMessage[]
packages/agent/src/agent.ts                    Agent.prompt: normalizePromptInput
packages/coding-agent/src/core/messages.ts     convertToLlm: AgentMessage[] -> Message[]
packages/ai/src/utils/transcript.ts            normalizeContext: Context -> TranscriptContext
packages/ai/src/api/anthropic-messages.ts      streamSimple: 请求体 -> AssistantMessageEventStream
```

- **预期观察**：至少标出六个阶段：argv 字符串、`Args.messages`、`AgentMessage`（含 content 块）、供应商 `Message`/transcript、provider 请求体、统一的 `AssistantMessageEventStream`。标出 `toolCall` 和 `toolResult` 在这条链上的位置，以及 `content` 从字符串变成内容块的地方。
- **对应模块**：第 2、3、5 讲；01、02、04。

<a id="course-lab-7"></a>
### 实验 7：解释一次 `context_edit` 前后投影的差异

- **目标**：区分“原始历史”和“模型可见上下文”。
- **命令**：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/session-context-edit.test.ts
```

- **预期观察**：`getBranch()` 仍包含被编辑的消息；`buildSessionProjection()` 会隐藏或替换目标；原始条目内容不变；同一目标最后一条编辑生效；切换分支后编辑不再生效。重点看测试名 `omits a target only from model projection`、`replaces only content and lets the latest edit win`、`keeps edits branch-relative`。
- **对应模块**：第 4 讲；03 的 `context_edit` 和“会话文件与条目树”。

<a id="course-lab-8"></a>
### 实验 8：验证文档路由

- **目标**：知道模块文档里的源码链接是怎么校验的。
- **命令**：

```bash
node docs/learning/pi/modules-chain/build.mjs --check
```

- **预期观察**：脚本检查文件是否存在、`#L` 行号是否越界、标题锚点能否在源码中找到。配套页面（traces、GLOSSARY、DEBUG_MAP）都已加入 `PAGES`，正常情况下应没有 error。warning 表示标题锚点在源码中有多处匹配，`--fix` 会取最近一处，不代表链接错误。
- **对应模块**：课程维护；GUIDE.md。

<a id="course-lab-9"></a>
### 实验 9：给一个模块补一条路由并让校验通过

- **目标**：练习稳定路由 ID、可搜索标题锚点和行号校验。
- **步骤**：
  1. 选一个尚未收录的函数，例如 `SessionManager.appendContextEdit`。
  2. 在对应模块 README 的函数路由表加一行，ID 用 `M03.store.edit`，符号写 `SessionManager.appendContextEdit`，链接标题写一个在源码中唯一出现的字面量。
  3. 运行 `node docs/learning/pi/modules-chain/build.mjs --check`。
  4. 行号不准时运行 `--fix`，再检查 `git diff` 只改了行号和你的新行；不要手工批量加减行号。
- **预期观察**：`--check` 通过；`--fix` 只修正行号；diff 不包含其他模块的无关改动。注意：模块文档可能正由其他人加厚，练习应在你自己的分支或副本上做，不要覆盖别人的改动。
- **对应模块**：GUIDE.md、任一模块；第 1-6 讲。

<a id="course-lab-10"></a>
### 实验 10：观察同一个事件如何进入三种模式

- **目标**：确认 text、json、TUI 消费的是同一套会话事件，只是输出方式不同。
- **命令**：

```bash
pi --mode json -p "用一句话回答：1+1 等于几" > /tmp/pi-events.jsonl
rg -o '"type":"[^"]+"' /tmp/pi-events.jsonl | sort | uniq -c
```

- **预期观察**：事件类型包括 `session`、`agent_start`、`turn_start`、`message_start`、`message_update`、`message_end`、`turn_end`、`agent_end`、`agent_settled`。text 模式不在事件上逐条输出，只在最后打印 assistant 文本；TUI 把同类事件映射到消息组件、工具行和状态行。
- **对应模块**：第 6 讲；05 的打印模式、交互模式和事件表。

<a id="course-maintenance"></a>
## 课程维护

这套材料会随源码和模块文档变化。维护时遵守以下规则：

- **新增页面**：在 `build.mjs` 顶部的 `PAGES` 数组加入 `{ id, file, title, short, group }`，并同步 `README.md` 的材料地图。只写 Markdown，不手改 `index.html`；网页由生成器产出。
- **新增或修改路由**：路由 ID 形如 `M0X.<机制>.<动作>`，一经使用不重命名。链接标题必须是目标源码中可搜索的字面量；行号漂移时先跑 `--check`，再跑 `--fix`，并检查 diff。
- **锚点**：模块文档使用显式 `<a id="m0x-..."></a>`；本课程使用 `course-...`。不要依赖中文标题自动生成的 slug，不同渲染器的结果可能不一致。
- **链接范围**：课程链接只指向模块 README 和已稳定的锚点，不深链到正在加厚的小节。新增内容优先写进模块 README，课程只引用入口和稳定锚点。
- **并发编辑**：模块文档可能由多个作者同时加厚。课程不复制大段函数细节，避免与模块文档产生两份真源；发现模块结构变化时，更新课程的阅读顺序和链接，不重写模块内容。
- **校验顺序**：`node docs/learning/pi/modules-chain/build.mjs --check`，再 `node docs/learning/pi/modules-chain/build.mjs`，最后检查 `git status --short docs/learning/pi/modules-chain`。`--fix` 会改 Markdown，运行后必须单独看 diff。
- **课程自身**：`COURSE.md` 已加入 `build.mjs` 的 `PAGES`，`--check` 会校验课程里的相对链接和源码链接。移动或重命名课程文件时，必须同步 `PAGES`、`README.md` 的材料地图和课程内链接。新增配套页面时，也要把页面加入 `PAGES`，否则校验会报告缺失文件。

维护细则见 [GUIDE.md](GUIDE.md)。仓库内的维护 Skill 是 [learning-courseware](../../../../.pi/skills/learning-courseware.md)。

<a id="course-companions"></a>
## 配套页面说明

本课程与以下页面配套。它们属于同一套学习材料，不是外部参考：

- [traces/README.md](traces/README.md)：四条贯穿追踪，按“一条消息、一次工具调用、一份上下文、一个事件”的一生组织。
- [GLOSSARY.md](GLOSSARY.md)：术语表，统一 provider、api、turn、request、projection、compaction 等叫法。
- [DEBUG_MAP.md](DEBUG_MAP.md)：排障地图，按“现象 -> 层 -> 数据 -> 函数”定位问题。
- [.pi/skills/learning-courseware.md](../../../../.pi/skills/learning-courseware.md)：维护这套课程材料的 Skill。

这些页面都已加入 `build.mjs` 的 `PAGES`，`--check` 会一起校验它们的相对链接和源码链接。课程正文只依赖模块 README 和稳定锚点；模块内部小节调整时，以锚点和标题为准。
