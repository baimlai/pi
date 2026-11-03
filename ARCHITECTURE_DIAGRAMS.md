# Architecture Diagrams

Pi 中文架构图。基线：`5d74f40de919742b5847eb2da4b023d048987689`。可视化阅读入口：[中文图解](docs/learning/pi/pi-architecture.html)。

先区分三种箭头：**依赖**表示 package.json 的安装声明；**调用**表示已核对的源码调用；**事件**表示结果通知。包依赖不等于每次请求都会执行。

## 一、系统总览

目的：认识 CLI 产品和应用运行库两条分支。置信度：高。省略细部基础依赖，完整声明见第二图。

```mermaid
flowchart TB
  user[终端用户] -->|输入任务| cli[coding-agent 编码助手]
  host[宿主程序] -->|SDK 或 JSONL RPC| cli
  cli -->|创建并驱动| agent[agent 工具循环]
  agent -->|注入的 streamFn| ai[ai 模型接入]
  ai -->|网络请求| provider[外部模型服务]
  cli -->|事件驱动显示| tui[tui 终端界面]
  cli -->|保存记录| history[本地 JSONL 会话]
  cli -->|扩展接入| integration[codemode 与 MCP 客户端]
  app[其他应用] -->|组装| runtime[durable / chord / env]
  runtime -->|Durable 模型请求| ai
```

依据：CLI 入口与模式见 [main.ts](packages/coding-agent/src/main.ts)；创建循环见 [sdk.ts](packages/coding-agent/src/core/sdk.ts)；事件持久化见 [agent-session.ts](packages/coding-agent/src/core/agent-session.ts)；Durable 请求模型见 [generation.ts](packages/durable/src/harness/generation.ts)。最后一组不表示 CLI 默认启用这些运行库。

## 二、全部顶层包的直接依赖

目的：覆盖全部顶层包。实线箭头均为 dependencies，虚线为 devDependencies；这张图不表示运行次序。置信度：高。

```mermaid
flowchart TB
  ca[coding-agent] -->|依赖| ag[agent]
  ca -->|依赖| ai[ai]
  ca -->|依赖| cm[codemode]
  ca -->|依赖| mc[mcp]
  ca -->|依赖| tu[tui]
  ag -->|依赖| ai
  ag -->|类型引用| sc[schema]
  ai -->|依赖| sc
  ai -->|依赖| te[telemetry]
  en[env] -->|依赖| du[durable]
  en -->|依赖| ch[chord]
  du -->|依赖| ch
  du -->|依赖| ai
  du -->|依赖| cm
  du -->|依赖| sc
  du -->|依赖| te
  ch -->|依赖| sc
  ch -->|依赖| te
  ev[evals 私有评测] -.开发依赖.-> ca
  ev -.开发依赖.-> ai
```

依据：全部 12 个顶层包 manifest，机器清单见 [inventory.json](docs/learning/pi/inventory.json)。agent 对 schema 的直接源码 import 是类型引用；类型在运行时被擦除，参数校验实际经 ai/utils/validation 进入 schema。四个嵌套扩展示例 workspace 单独列在 [SUMMARY](docs/learning/pi/SUMMARY.md)，没有混入产品包图。

## 三、启动时如何组装

目的：找出“谁创建谁”。置信度：高。省略管理命令、首次设置和错误分支。

```mermaid
flowchart TD
  cli[cli.ts] -->|setupCli 后调用| main[main]
  main -->|选择或创建| sm[SessionManager]
  main -->|创建运行时| runtime[createAgentSessionRuntime]
  runtime -->|调用工厂| services[createAgentSessionServices]
  services -->|组装| resources[设置 / 模型 / 资源加载器]
  runtime -->|调用| bridge[createAgentSessionFromServices]
  bridge -->|委托| sdk[createAgentSession]
  sdk -->|创建| agent[Agent]
  sdk -->|封装| session[AgentSession]
  sm -->|提供历史| sdk
  resources -->|注入| sdk
  main -->|按模式选择| mode[InteractiveMode / print / RPC]
  mode -->|使用| session
```

依据：[cli.ts](packages/coding-agent/src/cli.ts)、[main.ts](packages/coding-agent/src/main.ts)、[services](packages/coding-agent/src/core/agent-session-services.ts)、[SDK](packages/coding-agent/src/core/sdk.ts)。服务创建时使用已经确定的会话工作目录，以避免恢复会话后仍沿用另一个目录的配置和资源。

## 四、一次读取文件任务的时序

目的：解释一次输入为何可产生多次模型请求。置信度：高。read 是所选工具已启用时的示例；扩展可能改写或接管输入。

```mermaid
sequenceDiagram
  participant UI as 交互 / print / RPC
  participant S as AgentSession
  participant A as Agent / agent-loop
  participant M as ModelRuntime / ai
  participant T as read 工具
  participant P as SessionManager
  UI->>S: prompt 读取 README
  S->>S: hooks、模板、模型与上下文准备
  S->>A: agent.prompt(messages)
  A->>M: streamFn 请求模型
  M-->>A: toolCall(read, path)
  A->>A: 校验参数并应用工具 hooks
  A->>T: execute
  T-->>A: 文件内容或错误
  A->>A: 追加 toolResult
  A-->>S: message_end 等事件
  S->>P: appendMessage
  A->>M: 携带工具结果再次请求
  M-->>A: 最终解释的流式结果
  A-->>S: message_update / message_end / agent_end
  S-->>UI: 事件与最终收尾
```

依据：[AgentSession.prompt / _startRun](packages/coding-agent/src/core/agent-session.ts)、[runLoop / executeToolCalls](packages/agent/src/agent-loop.ts)、[read](packages/coding-agent/src/core/tools/read.ts)。message_end 的持久化适用于普通消息；特殊条目有自己的处理路径。图中只展开一组事件，不表示用户消息和最终模型消息不保存。

## 五、会话记录怎样变成模型上下文

目的：区分磁盘历史和模型看到的消息。置信度：高。

```mermaid
flowchart LR
  event[message_end] -->|追加普通消息| sm[SessionManager]
  sm -->|追加内存记录| entries[内存条目与分支]
  entries -->|持久会话按策略写入| log[JSONL 文件]
  log -.恢复时加载.-> sm
  entries -->|读取当前分支| projection[buildSessionProjection]
  edit[context_edit] -->|调整可见内容| projection
  compact[compaction 摘要条目] -->|缩短上下文| projection
  projection -->|得到本次消息| agent[Agent 请求上下文]
  agent -->|变换并转换消息类型| model[模型请求]
```

依据：[session-manager.ts](packages/coding-agent/src/core/session-manager.ts)、[AgentSession 的请求投影与压缩](packages/coding-agent/src/core/agent-session.ts)。投影从 SessionManager 的内存条目构建，不是每次请求重新读 JSONL。inMemory 会话不写磁盘。压缩改变后续请求上下文，不等于删除全部原始记录。

## 六、模型接入的内部展开

目的：理解 Models、Provider、API 实现的职责。置信度：高。每个提供商的认证、请求和惰性加载细节不同。

```mermaid
flowchart TB
  sdk[SDK 注入 streamFn] -->|委托| mr[ModelRuntime]
  mr -->|组合目录与认证| models[createModels / Models]
  mr -->|准备请求并委托| provider[Provider.streamSimple]
  models -->|管理| provider
  provider -->|按 model.api 分发| api[API wrapper 与网络实现]
  api -->|请求| external[外部模型服务]
  external -->|流式响应| events[统一 AssistantMessageEventStream]
  events -->|供循环消费| agent[agent-loop]
```

依据：[model-runtime.ts](packages/coding-agent/src/core/model-runtime.ts)、[models.ts](packages/ai/src/models.ts)、[OpenAI provider 示例](packages/ai/src/providers/openai.ts)。旧全局注册器属于 [compat.ts](packages/ai/src/compat.ts)，没有把它画成新根入口必须经过的节点。

## 七、扩展、MCP 与终端显示

目的：定位扩展点，区分模型工具、外部工具服务和 UI。置信度：高。

```mermaid
flowchart TB
  loader[DefaultResourceLoader] -->|发现并加载| ext[扩展及 ExtensionRunner]
  ext -->|注册工具和 hooks| session[AgentSession]
  ext -->|注册命令及渲染器| modes[运行模式]
  session -->|驱动| loop[agent-loop]
  loop -->|执行| local[read / bash / edit / write 等]
  loop -->|执行扩展工具| code[codemode]
  loop -->|执行桥接工具| mcp[MCP 扩展与客户端]
  mcp -->|stdio 或 Streamable HTTP| server[外部 MCP server]
  session -->|事件| modes
  modes -->|交互模式渲染| tui[tui]
  modes -->|print / JSON / RPC| stdout[标准输出]
```

依据：[扩展 API](packages/coding-agent/src/core/extensions/types.ts)、[内置扩展入口](packages/coding-agent/src/extensions/index.ts)、[MCP 客户端](packages/mcp/src/client.ts)、[运行模式](packages/coding-agent/src/modes/index.ts)。可用工具不等于全部启用；RPC 自定义 UI 的支持范围也不同于 TUI。

## 八、Durable 与 Chord 的进阶分支

目的：解释另一组运行库，避免混入 CLI SessionManager。置信度：高。存储适配、ExecutionEnv 和 Chord 集成由应用选择。

```mermaid
flowchart TB
  app[其他应用] -->|组装并打开| harness[Harness.open]
  harness -->|提交输入| inbox[Submissions / Inbox]
  inbox -->|唤醒| scheduler[TaskScheduler]
  scheduler -->|运行| generation[GenerationTask]
  scheduler -->|运行| compact[CompactionTask]
  generation -->|请求| models[pi-ai Models]
  generation -->|创建| tool[ToolTask]
  scheduler -->|提交任务状态| transaction[Session / Transaction]
  transaction -->|持久提交| storage[Storage 适配器]
  storage -->|可选 StoreStorage| store[Chord Store]
  harness -->|可选 ExecutionEnv| env[本地 / SSH RemoteExecutionEnv]
  env -->|远程操作| daemon[Rust daemon]
```

依据：[harness](packages/durable/src/harness/harness.ts)、[任务 registry](packages/durable/src/harness/registry.ts)、[StoreStorage](packages/durable/src/storage/store/storage.ts)、[RemoteExecutionEnv](packages/env/src/remote-env.ts)。这张图没有声称 Chord 设计文档中的目标集成示例已经接入 CLI，也没有验证远程端到端运行。

## 九、运行产物与阅读路线

置信度：高。构建图表示产生可执行产物，阅读图表示教学顺序，两者都不是用户请求时序。

```mermaid
flowchart LR
  source[TypeScript 源码与资源] -->|build| dist[dist 与 CLI bundle]
  dist -->|npm 或 Nix 使用| node[Node 进程]
  dist -->|Bun compile| binary[独立二进制]
  node -->|按配置请求| model[模型服务]
  binary -->|按配置请求| model
```

依据：[根构建脚本](package.json)、[coding-agent 构建脚本](packages/coding-agent/package.json)、[Nix](nix/package.nix)。evals Docker 是评测环境，未画成 CLI 必需服务。

```mermaid
flowchart LR
  map[先看仓库总览] -->|找入口| cli[cli.ts / main]
  cli -->|看组装| sdk[sdk.ts]
  sdk -->|追工具循环| loop[agent / agent-loop]
  loop -->|看模型边界| ai[ai Models / Provider]
  ai -->|回到产品能力| session[AgentSession / SessionManager]
  session -->|再扩展| extra[TUI / extensions / Durable 分支]
```

阅读时配合 [TypeScript 中文注释](docs/learning/pi/TYPESCRIPT.md)，不要一开始就顺目录通读所有提供商、平台适配和旧版 Chord。
