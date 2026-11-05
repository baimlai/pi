# M01 入口与装配

<a id="m01-objectives"></a>
## 学完能回答

学完这一页，应该能脱稿回答下面 8 个问题。每题后的“证据”指向文中的拆解或源码入口；先自己回答，再用页末的[自测](#m01-selfcheck)核对。

1. 从进程拿到 `argv` 到 `session.prompt()` 执行，中间按什么顺序创建对象？为什么 `argv` 不能直接交给 SDK？
   证据：[运行示例](#m01-example)、[装配顺序图](#m01-order)。
2. `parseArgs()` 之后为什么还要 `resolveAppMode()`？`Args.mode` 与 `appMode` 在哪些输入下不同？
   证据：[函数拆解一阶段 2](#m01-walk-main)、[main.ts:203](../../../../../packages/coding-agent/src/main.ts#L203 "function resolveAppMode(")。
3. 启动期的 bootstrap、startup、runtime 三个 `SettingsManager` 分别服务谁？最终会话为什么不能复用 startup 实例？
   证据：[关键概念](#m01-terms)、[关键设计 6](#m01-design)。
4. 从另一个项目恢复会话时，`cwd` 与 `sessionCwd` 为什么必须分开？services 什么时候按哪个目录重建？
   证据：[函数拆解一阶段 3](#m01-walk-main)、[关键设计 1](#m01-design)。
5. 项目信任在何时判定？print/RPC 在默认 `ask` 策略下为什么得到 `false`，这阻止了什么？
   证据：[关键设计 2](#m01-design)、[project-trust.ts:90](../../../../../packages/coding-agent/src/core/project-trust.ts#L90 "export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {")。
6. `createAgentSession()` 返回前会不会请求模型？一个工具从“定义”到“模型可见”经过哪三层？
   证据：[函数拆解三](#m01-walk-sdk)、[函数拆解四](#m01-walk-tools)。
7. `runtime.session` 为什么是 getter？`/new`、`/resume` 后模式层为什么必须重新绑定？
   证据：[函数拆解五](#m01-walk-runtime)、[agent-session-runtime.ts:170](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L170 "get session(): AgentSession {")。
8. 哪些装配错误会立刻终止进程，哪些只变成诊断或允许降级？`teardownCurrent()` 之后工厂失败能否回到旧会话？
   证据：[函数拆解一](#m01-walk-main)、[函数拆解二](#m01-walk-services)、[函数拆解五](#m01-walk-runtime)。

<a id="m01-duty"></a>
## 一句话职责

把“进程启动时的参数、目录、设置、凭证和资源”装配成一个可用的 `AgentSessionRuntime`，然后按模式把控制权交给打印、交互或 RPC 入口。

<a id="m01-plain"></a>
## 大白话总览

`pi -p "读取 README.md 前 20 行并总结"` 看起来只是一条命令，实际要先把十几个部件接起来。终端给出的只有两个东西：一个模式标记 `-p`，和一段用户文字。模型不会自己打开文件，也不会自己保存历史；这些能力分别来自工具注册表、会话存储和模型运行时。M01 的任务就是按依赖顺序把这些部件装好，再交给某个模式入口。

可以把它想成开一间工作室：

- 先确定在哪个地址开工（cwd）。
- 读墙上的规则（设置文件）。
- 判断这个地址的施工图纸是否可信（项目信任）。
- 接电、装工具柜、请供应商（services：模型运行时、认证、扩展资源）。
- 请一个包工头（`Agent`），它只负责“模型要工具就执行，再问模型”。
- 建一本工程日志（`AgentSession` + `SessionManager`），记录每条消息。
- 装一个总开关（`AgentSessionRuntime`），让前台可以随时换一条生产线。
- 最后把前台（print、interactive、RPC）叫来，由它接待第一条问题。

装配完成的标志不是“进程启动了”，而是拿到了一个 `AgentSessionRuntime`：它的 `.session` 上已经有模型、已激活工具、system 提示词、扩展运行器和 `SessionManager`，并且 `Agent` 的 `streamFn` 已经接到 `ModelRuntime`。只有这时，`session.prompt()` 才有意义。

装配顺序大致是：

1. 进程级准备：`setupCli()`，然后 `main(argv)`。
2. 一次性命令识别：auth、package、config、mcp、version、export 先处理；help、list-models 先记录意图，等扩展加载后再输出。
3. 解析参数并决定宿主模式：`parseArgs()` -> `resolveAppMode()`。
4. 选择会话和目标 cwd：`createSessionManager()`。恢复的会话可能来自另一个项目，后续服务必须按这个会话的 cwd 装配。
5. 处理项目信任：没有需要信任的资源时，按已存决定或默认允许；有资源时把决定推迟到资源加载阶段，由 `resolveProjectTrusted()` 询问扩展、持久记录或 UI。
6. 调用运行时工厂：创建目标 cwd 的 `SettingsManager`、`ModelRuntime`、`ResourceLoader`，得到 `services`。
7. 在 services 上解析模型范围和 CLI 选项，调用 `createAgentSessionFromServices()`。
8. SDK 创建 `Agent` 和 `AgentSession`，注册工具，注入 `streamFn`。
9. `createAgentSessionRuntime()` 把首次结果放进容器，并保留工厂供以后 `/new`、`/resume`、`/fork`、import 使用。
10. 按 `appMode` 进入 `runPrintMode()`、`InteractiveMode.run()` 或 `runRpcMode()`；真正调用 `session.prompt()` 的是模式层。

M01 不负责的东西也要说清楚：

| 不属于 M01 | 真正负责的地方 |
| --- | --- |
| 一次 prompt 内部的“模型 -> 工具 -> 再问模型”循环 | [M02 Agent 循环](../02-agent-loop/README.md)，从 `AgentSession.prompt()` 进入 `Agent.prompt()` 和 `runLoop()` |
| 消息历史、JSONL 持久化、上下文投影、压缩 | [M03 会话与上下文](../03-session-and-context/README.md)，核心是 `SessionManager` 和 `AgentSession` 的投影回调 |
| 供应商协议、认证刷新、HTTP、虚拟模型路由 | [M04 模型访问](../04-model-access/README.md)，入口是 `ModelRuntime.streamSimple()` |
| 输入读取、TUI 渲染、RPC 协议 | [M05 模式与 TUI](../05-modes-and-tui/README.md) |

注意边界：M01 会**构造** `AgentSession`，也会**创建** `SessionManager`、`ModelRuntime` 和工具注册表，但它不会执行一次对话。`main()` 从头到尾没有直接调用 `agent.prompt()`；首句是模式层交给 `session.prompt()` 的。

<a id="m01-terms"></a>
## 关键概念

先把这些词分开，后面读代码时不容易串线。

| 概念 | 含义 | 具体例子 |
| --- | --- | --- |
| `argv` | 操作系统传给进程的原始字符串数组，`cli.ts` 会去掉前两项 | `["-p", "读取 README.md 前 20 行并总结"]` |
| `Args` / `parsed` | `parseArgs()` 产生的结构化结果，不是模型对象 | `{ print: true, messages: ["读取..."], fileArgs: [], unknownFlags: Map(0), diagnostics: [] }` |
| `appMode` | 宿主怎么驱动会话，由参数和 TTY 共同决定 | `"print"`、`"interactive"`、`"json"`、`"rpc"` |
| `cwd` / `sessionCwd` | 进程启动目录 / 会话文件记录的有效目录，二者可能不同 | 在 `/repo` 启动，但 `--resume` 打开 `/other` 的会话，`sessionCwd=/other` |
| `services` | 绑定某个 cwd 的基础设施包，供一次会话装配使用 | `{ cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics }` |
| `SettingsManager` | 合并全局、可信项目层和临时覆盖的设置视图 | `projectTrusted: false` 时项目设置层为空 |
| `ProjectTrustStore` / `projectTrusted` | 持久化的目录信任决定，以及本次装配的布尔结果 | `trust.json` 记录 `/repo=true`；未信任时 `.pi/extensions/` 不被求值 |
| `ModelRuntime` | 模型目录、认证和供应商路由的共享运行时 | `getModel("anthropic", "claude-opus-4-8")`、`streamSimple(...)` |
| `ResourceLoader` | 发现并加载扩展、技能、提示词模板、主题、上下文文件 | `await resourceLoader.reload()` 后 `getExtensions()` |
| `SessionManager` | 会话条目树和 JSONL 持久化 | `SessionManager.create("/repo", sessionDir)` 或 `SessionManager.open(path)` |
| `Agent` | 低层循环和消息状态：模型、思考级别、工具、`streamFn` | `agent.prompt(...)` 会进入 `runLoop()` |
| `AgentSession` | 上层会话：持有 `Agent`、`SessionManager`、扩展、压缩和重试 | `session.prompt()`、`session.subscribe()`、`session.dispose()` |
| `AgentSessionRuntime` | 当前会话 + 当前 services + 可复用工厂的容器 | `runtime.session`、`runtime.newSession()`、`runtime.switchSession()` |
| `streamFn` | `Agent` 请求模型时调用的函数，不是模型实例 | SDK 注入的闭包最终调用 `modelRuntime.streamSimple()` |
| 工具注册表 | 名字到可执行 `AgentTool` 的映射，和“当前声明给模型的工具”不是一回事 | 注册了 8 个内置定义，默认只有 `read`、`bash`、`edit`、`write` 进入 `agent.state.tools` |

有三组对象特别容易混：

1. **三个 `SettingsManager` 视图**。启动早期在 [main.ts:1036](../../../../../packages/coding-agent/src/main.ts#L1036 "const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });") 创建一个只读全局层的 bootstrap 实例，用于代理设置；[main.ts:1160](../../../../../packages/coding-agent/src/main.ts#L1160 "const startupSettingsManager = SettingsManager.create(cwd, agentDir);") 创建启动 UI 和会话目录查询用的实例；真正的会话设置在工厂里按目标 cwd 和信任状态创建，也就是 [main.ts:1296](../../../../../packages/coding-agent/src/main.ts#L1296 "const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });")。前两个不是最终会话的设置。
2. **services、AgentSession、runtime**。services 是基础设施；`AgentSession` 是一代会话对象；`runtime` 是“当前这一代”的容器。语义上 runtime 存活最久，session 可以被替换，services 随新会话重建。
3. **`SessionManager`、`Agent.state.messages`、JSONL**。`SessionManager` 持有条目树；`Agent.state.messages` 是本次运行的工作副本；JSONL 是追加日志。恢复和压缩都以会话树为准，不是以 Agent 数组为准。

<a id="m01-example"></a>
## 运行示例

下面以从 argv 到 `session.prompt()` 的完整装配为例。

命令：

```bash
pi -p "读取 README.md 前 20 行并总结"
```

下面按真实调用顺序走一遍。假设当前目录是 `/repo`，用户配置目录是 `~/.pi/agent`，没有 `--model`、`--tools`、`--api-key`，也没有需要信任的项目资源。

### 1. 进程入口

[cli.ts:10](../../../../../packages/coding-agent/src/cli.ts#L10 "setupCli()") 先调用 `setupCli()`。它做的是进程级准备：

- `process.title = "pi"`。
- 写入 `PI_CODING_AGENT=true`、`AI_AGENT=pi` 环境变量。
- 把 `process.emitWarning` 换成空函数。
- 先用默认配置初始化 HTTP dispatcher。

这些动作不解析用户问题，也不请求模型。随后 [cli.ts:13](../../../../../packages/coding-agent/src/cli.ts#L13 "main(process.argv.slice(2))") 把 `process.argv.slice(2)` 交给 `main()`，所以第一个真实参数是 `"-p"`，第二个是 `"读取 README.md 前 20 行并总结"`。

### 2. 参数解析与模式判断

[main.ts:1078](../../../../../packages/coding-agent/src/main.ts#L1078 "const parsed = parseArgs(args);") 调用 `parseArgs()`。`-p` 的分支在 [args.ts:329](../../../../../packages/coding-agent/src/cli/args.ts#L329 "} else if (arg === \"--print\" || arg === \"-p\") {")：它设置 `print=true`，并把紧随其后的非选项文字放进 `messages`。所以这一轮得到：

```ts
{
  print: true,
  messages: ["读取 README.md 前 20 行并总结"],
  fileArgs: [],
  unknownFlags: Map(0) {},
  diagnostics: [],
}
```

没有 `provider`、`model`、`tools` 等字段。[main.ts:1131](../../../../../packages/coding-agent/src/main.ts#L1131 "let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);") 再结合 TTY 判断：因为 `parsed.print` 为真，`appMode` 是 `"print"`，不是 `"interactive"`。

### 3. 启动设置、会话和信任

[main.ts:1036](../../../../../packages/coding-agent/src/main.ts#L1036 "const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });") 先创建一个 `SettingsManager`，并明确传 `projectTrusted: false`。它只用于读取全局设置里的 HTTP 代理，不读取项目设置层。

接着 [main.ts:1188](../../../../../packages/coding-agent/src/main.ts#L1188 "const sessionDir =") 计算会话目录优先级：`--session-dir` -> 环境变量 `PI_CODING_AGENT_SESSION_DIR` -> 设置里的 `sessionDir`。环境变量名由 [config.ts:1007](../../../../../packages/coding-agent/src/config.ts#L1007 "export const ENV_SESSION_DIR =") 按 `APP_NAME` 生成，默认应用名是 `pi`。然后 [main.ts:1196](../../../../../packages/coding-agent/src/main.ts#L1196 "let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);") 调用 [createSessionManager:626](../../../../../packages/coding-agent/src/main.ts#L626 "export async function createSessionManager(")。这条命令没有 `--no-session`、`--fork`、`--session`、`--resume`、`--continue`、`--session-id`，所以走到默认分支：

```ts
SessionManager.create("/repo", sessionDir, { id: undefined })
```

从调用方看，它提供的是：

```ts
{
  getCwd(): "/repo",
  getSessionId(): "<生成的 id>",
  isPersisted(): true,
  // 已有条目为空；首次 user/assistant 消息前，JSONL 文件可能还没有创建
}
```

此时还没有 `Agent`，也没有 `ModelRuntime`，只有“这条命令要在哪个目录、用哪本日志”这两个决定。恢复会话时这里可能换成 `SessionManager.open(...)`，目标 cwd 也可能不是 `/repo`。

[main.ts:1238](../../../../../packages/coding-agent/src/main.ts#L1238 "const trustStore = new ProjectTrustStore(agentDir);") 创建持久信任存储。代码先检查目标 cwd 是否有需要信任的资源（`.pi` 下的扩展/设置等，或祖先目录的 `.agents/skills`）。本例假设没有受控资源，也没有保存的拒绝决定，所以工厂里会得到 `projectTrusted=true`，不会弹信任询问。

### 4. 定义工厂并创建 services

[main.ts:1264](../../../../../packages/coding-agent/src/main.ts#L1264 "const createRuntime: CreateAgentSessionRuntimeFactory = async ({") 定义了 `createRuntime`。注意这里只是定义一个异步函数，还没有执行。它之后会被首次装配调用，也会被 `/new`、`/resume`、`/fork`、import 复用。

[main.ts:1506](../../../../../packages/coding-agent/src/main.ts#L1506 "const runtime = await createAgentSessionRuntime(createRuntime, {") 调用 [createAgentSessionRuntime:711](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L711 "export async function createAgentSessionRuntime(")。这个函数先检查会话 cwd 是否存在，再执行工厂：

```ts
await createRuntime({
  cwd: sessionManager.getCwd(),   // "/repo"
  agentDir,                       // "~/.pi/agent"
  sessionManager,
  sessionStartEvent: undefined,   // 首次启动没有 new/resume/fork 事件
})
```

工厂内部第一步是创建目标 cwd 的设置管理器，然后调用 [createAgentSessionServices:218](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L218 "export async function createAgentSessionServices(")。对这条命令，它产出：

```ts
{
  cwd: "/repo",
  agentDir: "~/.pi/agent",
  modelRuntime: ModelRuntime,     // 已读取 auth.json、models.json 和模型目录缓存
  settingsManager: SettingsManager,
  resourceLoader: DefaultResourceLoader, // 已 reload，扩展和资源都已发现
  diagnostics: [],
}
```

`ModelRuntime` 创建时传入 `authPath=~/.pi/agent/auth.json`、`modelsPath=~/.pi/agent/models.json` 和一个 15 秒创建信号；`createAgentSessionServices()` 之后还会用 `refresh({ allowNetwork: false })` 刷新本地快照。这一步会读磁盘，但不会向供应商发聊天请求。

资源加载器会加载内置扩展、全局资源，以及（在 `projectTrusted=true` 时）项目里的 `.pi/extensions/`、`.pi/skills/`、`.pi/prompts/`、`.pi/themes/` 和上下文文件。扩展在加载阶段注册的供应商、虚拟模型和 CLI 参数，会在 `createAgentSessionServices()` 的后半段被消费：前两者写入 `ModelRuntime`，CLI 参数写入扩展运行时。注册失败变成 `diagnostics`，不会直接终止进程。

### 5. 解析模型和会话选项

回到工厂。[main.ts:1411](../../../../../packages/coding-agent/src/main.ts#L1411 "const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();") 读取模型范围：本例没有 `--models`，设置里也没有 `enabledModels`，所以 `scopedModels` 是空数组。随后 [buildSessionOptions:781](../../../../../packages/coding-agent/src/main.ts#L781 "function buildSessionOptions(") 返回一个几乎空的配置：

```ts
{
  options: {},
  cliThinkingFromModel: false,
  diagnostics: [],
}
```

“用哪个模型”此时还没有决定。没有 `--model`、没有范围、也没有 `--api-key`，这些字段保持 `undefined`，交给 SDK 的恢复和默认选择逻辑。

### 6. SDK 创建 Agent 和 AgentSession

[main.ts:1463](../../../../../packages/coding-agent/src/main.ts#L1463 "const created = await createAgentSessionFromServices({") 把 services、`SessionManager` 和空选项交给 [createAgentSessionFromServices:354](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L354 "export async function createAgentSessionFromServices(")，后者直接转给 [createAgentSession:285](../../../../../packages/coding-agent/src/core/sdk.ts#L285 "export async function createAgentSession(")。

在 SDK 内部，本例走这些分支：

1. `cwd` 和 `agentDir` 从 services 取得；`modelRuntime`、`settingsManager`、`resourceLoader` 直接复用，不会重新加载。
2. [sdk.ts:317](../../../../../packages/coding-agent/src/core/sdk.ts#L317 "const existingSession = sessionManager.buildSessionContext();") 从会话树投影出上下文；新会话的 `messages` 是空数组，所以 `hasExistingSession=false`。
3. `options.model` 是 `undefined`，历史里也没有模型选择，于是 [sdk.ts:357](../../../../../packages/coding-agent/src/core/sdk.ts#L357 "const result = await findInitialModel({") 调用 [findInitialModel:932](../../../../../packages/coding-agent/src/core/model-resolver.ts#L932 "export async function findInitialModel(options: {")。选择顺序是：设置里的 `defaultProvider/defaultModel`（该供应商必须有已配置认证）-> 可用模型快照里第一个本地默认候选 -> 可用快照首项。
4. 假设本机设置是 `anthropic/claude-opus-4-8` 且已登录，模型就是 `{ provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages", ... }`。如果没有任何可用模型，`model` 会是 `undefined`，`print` 模式稍后会在 [main.ts:1613](../../../../../packages/coding-agent/src/main.ts#L1613 "if (appMode !== \"interactive\" && !session.model) {") 打印 `No models available. ...`（中文意译：没有可用模型）并以 1 退出。
5. 思考级别从 `options.thinkingLevel` 开始，依次尝试历史记录、该模型的设置、全局默认，最后落到 `"medium"`，再用 `clampThinkingLevel()` 收窄到模型支持的级别。
6. 工具选择：没有 `--tools`、没有 `+name/-name` 修饰、没有排除规则，默认名单来自 `settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES`，即 `["read", "bash", "edit", "write"]`。
7. [sdk.ts:653](../../../../../packages/coding-agent/src/core/sdk.ts#L653 "const agent = new Agent({") 构造低层 `Agent`。它的初始状态是：

```ts
{
  systemPrompt: "",                 // AgentSession 稍后会重建实际提示词
  model: <选中的 Model>,
  thinkingLevel: "medium",
  tools: [],                        // AgentSession 注册工具后再填
  messages: [],                     // 新会话没有历史
}
```

8. `streamFn` 在 [sdk.ts:672](../../../../../packages/coding-agent/src/core/sdk.ts#L672 "streamFn: async (model, context, options) =>") 注入；此时只是保存闭包，不请求模型。
9. [sdk.ts:743](../../../../../packages/coding-agent/src/core/sdk.ts#L743 "const session = new AgentSession({") 构造 `AgentSession`。构造器会订阅 Agent 事件、安装请求前/回合间回调、创建扩展运行器，并构建工具运行时：8 个内置工具定义进入注册表，默认激活 `read`、`bash`、`edit`、`write`，最终 `agent.state.tools` 是这 4 个可执行工具。
10. 新会话还会把初始模型和思考级别写入 `SessionManager`，供下次恢复使用。

`createAgentSession()` 返回：

```ts
{
  session: AgentSession,
  extensionsResult: LoadExtensionsResult,
  modelFallbackMessage: undefined,
}
```

工厂再补上 `services` 和 `diagnostics`，交给 `createAgentSessionRuntime()` 包成容器。到这一步，装配完成，但对话还没有开始。

### 7. 打印模式调用 session.prompt

[main.ts:1717](../../../../../packages/coding-agent/src/main.ts#L1717 "const exitCode = await runPrintMode(runtime, {") 把 runtime、首句和剩余消息交给 [runPrintMode:50](../../../../../packages/coding-agent/src/modes/print-mode.ts#L50 "export async function runPrintMode(")。`prepareInitialMessage()` 已经从 `parsed.messages` 里取走第一句，所以 `initialMessage` 是 `"读取 README.md 前 20 行并总结"`，而后面的 `messages` 是空数组。

`runPrintMode()` 先做绑定：

- 保存 `session = runtimeHost.session`。
- 注册 `setRebindSession()`，以后 runtime 换会话时重新绑定。
- `await rebindSession()`：调用 `session.bindExtensions({ mode: "print", ... })`，订阅会话事件。`text` 模式不逐事件输出；`json` 模式才把事件写成 JSONL 到原始 stdout。

然后执行 [print-mode.ts:199](../../../../../packages/coding-agent/src/modes/print-mode.ts#L199 "await session.prompt(initialMessage, { images: initialImages });")。这是 M01 与 M02/M03 的分界点：

```
runPrintMode()
  -> session.prompt("读取 README.md 前 20 行并总结")
       -> AgentSession._startRun()
            -> Agent.prompt(...)
                 -> runLoop()
                      -> streamAssistantResponse()
                           -> streamFn
                                -> ModelRuntime.streamSimple()
```

`session.prompt()` 返回后，`runPrintMode()` 在 `text` 模式下读取 `session.state.messages` 的最后一项；仅当它是 assistant 时，才把其中的 text 块写到原始 stdout。模型如果先调用 `read` 工具，会经历“第一次请求 -> 工具执行 -> 第二次请求”，但打印模式不逐事件输出，也不打印中间轮次。最后 `finally` 里的 `runtimeHost.dispose()` 触发 `session_shutdown`（reason 为 `quit`）并释放会话。

这条命令没有走到的分支：`--model`、`--models`、`--api-key`、`--resume`、`--fork`、`--session`、信任询问、交互 TUI。它们改变的是装配输入或最后的分派入口，不改变“services -> Agent -> AgentSession -> runtime -> prompt”这条主线。

<a id="m01-position"></a>
## 在链路中的位置

### 上游

- 操作系统 / shell：执行 `pi` 或 `node dist/cli.js`。
- CLI 参数、环境变量、`~/.pi/agent/` 下的设置与认证文件。
- 项目目录中的 `.pi/` 资源（扩展、技能、模板、主题）。
- 进程入口 [cli.ts](../../../../../packages/coding-agent/src/cli.ts "cli.ts") 和 [main.ts](../../../../../packages/coding-agent/src/main.ts "main.ts")。`cli.ts` 只做进程准备；`main.ts` 负责参数、会话选择、信任和分派。模块内部的装配由 `createAgentSessionServices()`、`createAgentSession()` 和 `createAgentSessionRuntime()` 完成。

### 下游

| 入口 | 数据如何进出 |
| --- | --- |
| `runPrintMode()` / `InteractiveMode.run()` / `runRpcMode()` | 接收 `AgentSessionRuntime` 和首句，调用 `session.prompt()` |
| [M02 Agent 循环](../02-agent-loop/README.md#m02-plain) | 从 `session.prompt()` 进入 `Agent.prompt()`、`runLoop()` 和工具执行 |
| [M03 会话与上下文](../03-session-and-context/README.md) | `AgentSession` 把消息写入 `SessionManager`，请求前再投影成模型上下文 |
| [M04 模型访问](../04-model-access/README.md) | `streamFn` 调用 `ModelRuntime.streamSimple()`，由供应商适配器发出 HTTP 请求 |
| [M05 模式与 TUI](../05-modes-and-tui/README.md) | 负责输入、渲染、RPC 协议和会话替换后的重绑定 |

对应全链路：[S1 进程启动](../00-full-chain/README.md#m00-s1) -> [S2 主装配](../00-full-chain/README.md#m00-s2) -> [S3 创建会话](../00-full-chain/README.md#m00-s3) -> [S4 打印模式](../00-full-chain/README.md#m00-s4) -> [S5 会话入口](../00-full-chain/README.md#m00-s5)。

M01 的职责到模式层拿到 runtime 为止：它把对象装配好，并把控制权交给模式层；从 `session.prompt()` 开始的消息循环、工具往返、持久化和压缩不属于本模块。

<a id="m01-files"></a>
## 文件路由

| 文件 | 职责 |
| --- | --- |
| [cli.ts](../../../../../packages/coding-agent/src/cli.ts "cli.ts") | 可执行入口；只做进程级准备和转交 |
| [cli/setup.ts](../../../../../packages/coding-agent/src/cli/setup.ts "setup.ts") | CLI 进程环境初始化 |
| [cli/args.ts](../../../../../packages/coding-agent/src/cli/args.ts "args.ts") | 把 argv 解析成 `Args`；不读文件、不发请求 |
| [cli/initial-message.ts](../../../../../packages/coding-agent/src/cli/initial-message.ts "initial-message.ts") | 拼接 stdin、@file 文本和第一条 CLI 消息 |
| [main.ts](../../../../../packages/coding-agent/src/main.ts "main.ts") | 参数解析、信任、服务装配、模式分派 |
| [core/agent-session-runtime.ts](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts "agent-session-runtime.ts") | 会话宿主的生命周期：创建、替换、fork、切换、销毁 |
| [core/agent-session-services.ts](../../../../../packages/coding-agent/src/core/agent-session-services.ts "agent-session-services.ts") | 绑定目标 cwd 的服务包：模型运行时、认证、扩展资源 |
| [core/sdk.ts](../../../../../packages/coding-agent/src/core/sdk.ts "sdk.ts") | 把服务装配成 `Agent` + `AgentSession` |
| [core/agent-session.ts](../../../../../packages/coding-agent/src/core/agent-session.ts "agent-session.ts") | 会话层：事件订阅、扩展、工具注册、压缩、重试 |
| [core/tools/index.ts](../../../../../packages/coding-agent/src/core/tools/index.ts "index.ts") | 内置工具定义的工厂入口 |
| [modes/print-mode.ts](../../../../../packages/coding-agent/src/modes/print-mode.ts "print-mode.ts") | 一次性打印模式；真正调用首句 `session.prompt()` |
| [config.ts](../../../../../packages/coding-agent/src/config.ts "config.ts") | 包内资源路径解析；源码检出、npm 安装、单文件二进制都走这里 |
| [core/settings-manager.ts](../../../../../packages/coding-agent/src/core/settings-manager.ts "settings-manager.ts") | 全局/项目设置的读取、合并、持久化 |
| [core/auth-storage.ts](../../../../../packages/coding-agent/src/core/auth-storage.ts "auth-storage.ts") | `auth.json` 的凭证存储 |
| [core/project-trust.ts](../../../../../packages/coding-agent/src/core/project-trust.ts "project-trust.ts") | 项目信任规则的最终判定 |
| [core/trust-manager.ts](../../../../../packages/coding-agent/src/core/trust-manager.ts "trust-manager.ts") | 信任记录的持久化与资源检测 |

<a id="m01-routes"></a>
## 函数路由

### 进程入口与主装配

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M01.cli.setup` | `setupCli()` | [cli.ts:10](../../../../../packages/coding-agent/src/cli.ts#L10 "setupCli()") | 进程级初始化，不解析业务参数 |
| `M01.cli.main` | `main(process.argv.slice(2))` | [cli.ts:13](../../../../../packages/coding-agent/src/cli.ts#L13 "main(process.argv.slice(2))") | 把参数交给主函数 |
| `M01.main.entry` | `main` | [main.ts:980](../../../../../packages/coding-agent/src/main.ts#L980 "export async function main(") | 解析、装配、分派 |
| `M01.main.bootstrapSettings` | `bootstrapSettingsManager` | [main.ts:1036](../../../../../packages/coding-agent/src/main.ts#L1036 "const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });") | 启动早期的全局设置视图 |
| `M01.main.startupSettings` | `startupSettingsManager` | [main.ts:1160](../../../../../packages/coding-agent/src/main.ts#L1160 "const startupSettingsManager = SettingsManager.create(cwd, agentDir);") | 启动 UI 和会话目录查询 |
| `M01.main.sessionManager` | `createSessionManager` | [main.ts:626](../../../../../packages/coding-agent/src/main.ts#L626 "export async function createSessionManager(") | 按参数选择/新建历史管理器 |
| `M01.main.trust` | `new ProjectTrustStore` | [main.ts:1238](../../../../../packages/coding-agent/src/main.ts#L1238 "const trustStore = new ProjectTrustStore(agentDir);") | 创建信任持久化存储 |
| `M01.main.factory` | `createRuntime` | [main.ts:1264](../../../../../packages/coding-agent/src/main.ts#L1264 "const createRuntime: CreateAgentSessionRuntimeFactory = async ({") | 可复用的会话工厂 |
| `M01.main.runtimeSettings` | `runtimeSettingsManager` | [main.ts:1296](../../../../../packages/coding-agent/src/main.ts#L1296 "const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });") | 目标 cwd 的最终设置 |
| `M01.main.services` | `createAgentSessionServices` | [main.ts:1298](../../../../../packages/coding-agent/src/main.ts#L1298 "createAgentSessionServices({") | 为本次装配创建目标 cwd 的服务 |
| `M01.main.modelScope` | `resolveModelScope` | [main.ts:1417](../../../../../packages/coding-agent/src/main.ts#L1417 "await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })") | 解析模型范围 |
| `M01.main.options` | `buildSessionOptions` | [main.ts:781](../../../../../packages/coding-agent/src/main.ts#L781 "function buildSessionOptions(") | CLI 参数 -> SDK 选项 |
| `M01.main.apiKey` | `setRuntimeApiKey` | [main.ts:1458](../../../../../packages/coding-agent/src/main.ts#L1458 "await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);") | 只影响当前进程的 key |
| `M01.main.fromServices` | `createAgentSessionFromServices` | [main.ts:1463](../../../../../packages/coding-agent/src/main.ts#L1463 "const created = await createAgentSessionFromServices({") | 从 services 创建会话 |
| `M01.main.runtime` | `createAgentSessionRuntime` | [main.ts:1506](../../../../../packages/coding-agent/src/main.ts#L1506 "createAgentSessionRuntime(createRuntime") | 包住会话工厂，支持运行中替换会话 |
| `M01.main.print` | `runPrintMode` | [main.ts:1717](../../../../../packages/coding-agent/src/main.ts#L1717 "runPrintMode(runtime") | text/json 模式 |
| `M01.main.interactive` | `new InteractiveMode` | [main.ts:1656](../../../../../packages/coding-agent/src/main.ts#L1656 "new InteractiveMode(runtime") | 构造交互控制器 |
| `M01.main.run` | `interactiveMode.run()` | [main.ts:1711](../../../../../packages/coding-agent/src/main.ts#L1711 "interactiveMode.run()") | 进入交互事件循环 |
| `M01.main.rpc` | `runRpcMode` | [main.ts:1652](../../../../../packages/coding-agent/src/main.ts#L1652 "await runRpcMode(runtime)") | stdin JSON 命令模式 |

### 服务装配

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M01.services.create` | `createAgentSessionServices` | [agent-session-services.ts:218](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L218 "export async function createAgentSessionServices(") | 模型运行时、认证、资源加载器 |
| `M01.services.runtime` | `ModelRuntime.create` | [agent-session-services.ts:232](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L232 "(await ModelRuntime.create({") | 创建模型/认证运行时 |
| `M01.services.loader` | `new DefaultResourceLoader` | [agent-session-services.ts:243](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L243 "const resourceLoader = new DefaultResourceLoader({") | 创建资源加载器 |
| `M01.services.reload` | `resourceLoader.reload` | [agent-session-services.ts:254](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L254 "await resourceLoader.reload(options.resourceLoaderReloadOptions);") | 真正加载扩展和资源 |
| `M01.services.flags` | `applyExtensionFlagValues` | [agent-session-services.ts:131](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L131 "function applyExtensionFlagValues(") | 把扩展 CLI 参数写入扩展运行时 |
| `M01.services.fromServices` | `createAgentSessionFromServices` | [agent-session-services.ts:354](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L354 "export async function createAgentSessionFromServices(") | 服务就绪后创建会话 |

### SDK 装配

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M01.sdk.create` | `createAgentSession` | [sdk.ts:285](../../../../../packages/coding-agent/src/core/sdk.ts#L285 "export async function createAgentSession(") | 服务 -> 可用会话 |
| `M01.sdk.model` | `findInitialModel` | [sdk.ts:357](../../../../../packages/coding-agent/src/core/sdk.ts#L357 "const result = await findInitialModel({") | 恢复失败后的默认模型选择 |
| `M01.sdk.tools` | `defaultToolNames` | [sdk.ts:433](../../../../../packages/coding-agent/src/core/sdk.ts#L433 "const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES);") | 默认工具名单 |
| `M01.sdk.agent` | `new Agent` | [sdk.ts:653](../../../../../packages/coding-agent/src/core/sdk.ts#L653 "const agent = new Agent({") | 低层循环与消息状态 |
| `M01.sdk.initialState` | `initialState` | [sdk.ts:655](../../../../../packages/coding-agent/src/core/sdk.ts#L655 "initialState: {") | Agent 的初始模型、工具和历史 |
| `M01.sdk.streamFn` | `streamFn` | [sdk.ts:672](../../../../../packages/coding-agent/src/core/sdk.ts#L672 "streamFn: async (model, context, options)") | 把模型请求转给 `ModelRuntime` |
| `M01.sdk.requestOptions` | `buildRequestOptions` | [sdk.ts:537](../../../../../packages/coding-agent/src/core/sdk.ts#L537 "const buildRequestOptions = (options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions => {") | 每次请求合并超时、重试、请求头 |
| `M01.sdk.session` | `new AgentSession` | [sdk.ts:743](../../../../../packages/coding-agent/src/core/sdk.ts#L743 "const session = new AgentSession({") | 会话、扩展、持久化、压缩 |

### 会话容器生命周期

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M01.runtime.create` | `createAgentSessionRuntime` | [agent-session-runtime.ts:711](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L711 "export async function createAgentSessionRuntime(") | 首次装配并保存工厂 |
| `M01.runtime.class` | `AgentSessionRuntime` | [agent-session-runtime.ts:120](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L120 "export class AgentSessionRuntime {") | 当前会话 + services + 工厂 |
| `M01.runtime.new` | `newSession` | [agent-session-runtime.ts:381](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L381 "async newSession(options?: {") | 新建会话并替换当前会话 |
| `M01.runtime.switch` | `switchSession` | [agent-session-runtime.ts:327](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L327 "async switchSession(") | 恢复指定 JSONL |
| `M01.runtime.fork` | `fork` | [agent-session-runtime.ts:446](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L446 "async fork(") | 从历史条目分叉 |
| `M01.runtime.teardown` | `teardownCurrent` | [agent-session-runtime.ts:277](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L277 "private async teardownCurrent(") | 中止并释放旧会话 |
| `M01.runtime.apply` | `apply` | [agent-session-runtime.ts:299](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L299 "private apply(result: CreateAgentSessionRuntimeResult): void {") | 替换会话/services/诊断 |

### 工具注册

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M01.session.ctor` | `AgentSession` 构造器 | [agent-session.ts:710](../../../../../packages/coding-agent/src/core/agent-session.ts#L710 "constructor(config: AgentSessionConfig) {") | 订阅事件、安装钩子、构建工具 |
| `M01.session.subscribe` | `agent.subscribe` | [agent-session.ts:761](../../../../../packages/coding-agent/src/core/agent-session.ts#L761 "this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);") | 把 Agent 事件接入会话持久化 |
| `M01.session.buildRuntime` | `_buildRuntime` | [agent-session.ts:6273](../../../../../packages/coding-agent/src/core/agent-session.ts#L6273 "private _buildRuntime(options: {") | 创建基础定义和扩展运行器 |
| `M01.session.baseTools` | `createAllToolDefinitions` | [agent-session.ts:6301](../../../../../packages/coding-agent/src/core/agent-session.ts#L6301 "createAllToolDefinitions(this._cwd, {") | 8 个内置工具定义 |
| `M01.session.registry` | `_refreshToolRegistry` | [agent-session.ts:6081](../../../../../packages/coding-agent/src/core/agent-session.ts#L6081 "private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {") | 合并内置、扩展、SDK 工具 |
| `M01.session.active` | `_setActiveTools` | [agent-session.ts:2640](../../../../../packages/coding-agent/src/core/agent-session.ts#L2640 "private _setActiveTools(toolNames: string[]): void {") | 应用激活集合 |
| `M01.session.loadout` | `_applyToolLoadout` | [agent-session.ts:2723](../../../../../packages/coding-agent/src/core/agent-session.ts#L2723 "private _applyToolLoadout(toolNames: string[]): AgentTool[] {") | 过滤并声明给模型 |
| `M01.session.agentTools` | `agent.state.tools` | [agent-session.ts:2804](../../../../../packages/coding-agent/src/core/agent-session.ts#L2804 "this.agent.state.tools = declared;") | 当前声明的可执行工具 |

### 模式入口

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M01.print.run` | `runPrintMode` | [print-mode.ts:50](../../../../../packages/coding-agent/src/modes/print-mode.ts#L50 "export async function runPrintMode(") | 一次性执行并输出 |
| `M01.print.prompt` | `session.prompt` | [print-mode.ts:199](../../../../../packages/coding-agent/src/modes/print-mode.ts#L199 "await session.prompt(initialMessage, { images: initialImages });") | 提交首句 |

### 设置、认证、资源路径

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M01.settings.create` | `SettingsManager.create` | [settings-manager.ts:469](../../../../../packages/coding-agent/src/core/settings-manager.ts#L469 "static create(") | 按 cwd 和信任状态创建设置 |
| `M01.settings.class` | `SettingsManager` | [settings-manager.ts:404](../../../../../packages/coding-agent/src/core/settings-manager.ts#L404 "export class SettingsManager") | 全局/项目设置合并 |
| `M01.settings.compaction` | `getCompactionSettings` | [settings-manager.ts:1410](../../../../../packages/coding-agent/src/core/settings-manager.ts#L1410 "getCompactionSettings(") | 读取压缩阈值等设置 |
| `M01.auth.class` | `AuthStorage` | [auth-storage.ts:549](../../../../../packages/coding-agent/src/core/auth-storage.ts#L549 "export class AuthStorage") | 凭证存储 |
| `M01.auth.create` | `AuthStorage.create` | [auth-storage.ts:584](../../../../../packages/coding-agent/src/core/auth-storage.ts#L584 "static create(authPath") | 打开 `auth.json` |
| `M01.config.packageDir` | `getPackageDir` | [config.ts:715](../../../../../packages/coding-agent/src/config.ts#L715 "export function getPackageDir(") | 定位包根目录 |
| `M01.config.themesDir` | `getThemesDir` | [config.ts:743](../../../../../packages/coding-agent/src/config.ts#L743 "export function getThemesDir(") | 定位内置主题 |
| `M01.config.docs` | `getDocsPath` | [config.ts:796](../../../../../packages/coding-agent/src/config.ts#L796 "export function getDocsPath(") | 定位包内文档 |

<a id="m01-walk-main"></a>
## 函数拆解一：main() 的五个阶段

[main.ts:980](../../../../../packages/coding-agent/src/main.ts#L980 "export async function main(") 的签名是 `main(args: string[], options?: MainOptions)`。输入是已经去掉 Node 路径和脚本路径的 argv；输出是 `Promise<void>`，没有业务返回值；副作用包括读写设置/会话、加载扩展、启动 TUI 或打印结果。

它不是一个从头到尾线性执行的函数，而是五个阶段，中间穿插会直接结束进程的一次性命令。

### 阶段 1：进程级准备和一次性命令

入口先重置计时、注册主题 JSON 校验器、合并内置扩展和宿主扩展工厂，并处理离线开关。然后依次尝试：

1. `runAuthCommand(args)`：`auth` 子命令。成功或失败都返回 `true`，`main()` 直接结束，不会进入聊天装配。
2. Windows 自更新隔离目录清理。
3. `cleanupManagedInstall()`。
4. 读取 `process.cwd()`；目录不存在时打印错误并 `process.exit(1)`。
5. `getAgentDir()`，创建 bootstrap 设置，应用全局 HTTP 代理，配置 dispatcher。
6. `handlePackageCommand()`、`handleConfigCommand()`、`mcp` 子命令。它们各自处理自己的参数，处理完就返回或退出。
7. `parseArgs(args)`。
8. `--version`、`--export` 等不需要会话的只读命令；`--help`、`--list-models` 先记下，等扩展加载后再输出。

这些命令放在参数解析和信任流程之前，是因为它们不需要 `Agent`、不需要模型目录，也不应该因为项目里有一个坏扩展就启动失败。`help` 和 `list-models` 是例外：它们会在扩展加载之后才输出，这样能列出扩展注册的额外参数和模型。见 [main.ts:1533](../../../../../packages/coding-agent/src/main.ts#L1533 "if (parsed.help) {")。

### 阶段 2：解析参数、决定模式、接管 stdout

`parseArgs()` 的产物是 `Args`。如果 `diagnostics` 里有 `error`，`main()` 在 [main.ts:1089](../../../../../packages/coding-agent/src/main.ts#L1089 "if (parsed.diagnostics.some((d) => d.type === \"error\")) {") 退出；warning 只打印，不阻止启动。

接着 [resolveAppMode:203](../../../../../packages/coding-agent/src/main.ts#L203 "function resolveAppMode(") 决定 `appMode`：

```ts
if (parsed.mode === "rpc") return "rpc";
if (parsed.mode === "json") return "json";
if (parsed.print || !stdinIsTTY || !stdoutIsTTY) return "print";
return "interactive";
```

所以 `appMode` 不等于 `Args.mode`。`Args.mode` 只有 `text`、`json`、`rpc` 三种；`appMode` 还包含 `interactive`，并且会受 TTY 影响。重定向 stdout 到文件时，即使没有 `-p`，也会变成打印模式。

非交互模式会调用 `takeOverStdout()`：普通 `process.stdout.write` 和 `console.log` 被转到 stderr，真正的协议/结果由 `writeRawStdout()` 写到原始 stdout。这样扩展日志、诊断信息不会污染 JSON 或最终回答。`help` 和 `list-models` 这类人类可读输出是例外，不接管 stdout。

### 阶段 3：选择会话、计算信任

`sessionDir` 的优先级是 `--session-dir` -> `PI_CODING_AGENT_SESSION_DIR` -> 启动设置。然后 `createSessionManager()` 按参数选择：

- `--no-session`、`--help`、`--list-models`：内存管理器。
- `--fork`：先解析源，再 `SessionManager.forkFrom()` 复制到当前项目。
- `--session`：路径或 id 前缀；跨项目会话会询问是否 fork 到当前目录。
- `--resume`：打开交互选择器。
- `--continue`：当前项目最近的会话。
- `--session-id`：先找同 id 会话，找不到就新建并给出警告。
- 默认：`SessionManager.create(cwd, sessionDir)`。

会话选中后，`sessionCwd` 可能不是进程启动目录。后续的模型目录、设置和资源都必须按 `sessionCwd` 装配，不能继续用 `/repo` 的缓存。

信任处理是延迟的。`main()` 先创建 `ProjectTrustStore`，并在 [main.ts:1284](../../../../../packages/coding-agent/src/main.ts#L1284 "const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);") 检查目标目录是否有需要信任的资源。只有“没有显式覆盖、进程缓存里没有决定、且确实有受控资源”时，才在工厂里把 `resolveProjectTrust` 回调交给资源加载器；否则直接使用缓存、CLI 覆盖、持久记录或“无资源则允许”的默认值。

真正判定在 [resolveProjectTrusted:90](../../../../../packages/coding-agent/src/core/project-trust.ts#L90 "export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {")：显式覆盖最大；没有受控资源时查持久记录，默认允许；有资源时先让扩展处理 `project_trust` 事件，再查持久记录，再看 `defaultProjectTrust`（`ask`/`always`/`never`），最后才问 UI。**没有 UI 且策略是 `ask` 时结果是 `false`**，所以 print/RPC 在未信任项目里不会加载项目扩展。这不是界面提示，而是实际的安全边界。

### 阶段 4：定义工厂，首次装配

[main.ts:1264](../../../../../packages/coding-agent/src/main.ts#L1264 "const createRuntime: CreateAgentSessionRuntimeFactory = async ({") 定义的工厂捕获了启动期固定的输入：`agentDir`、CLI 路径（扩展、技能、提示词、主题都已经按启动 cwd 绝对化）、`extensionFactories`、解析后的 `parsed`、`trustStore`、`projectTrustByCwd` 等。它接收每次装配的目标 `cwd`、`agentDir`、`sessionManager`、`sessionStartEvent`、`projectTrustContext`，返回 `CreateAgentSessionRuntimeResult`。

工厂内部顺序：

1. 判断首次还是替换（`sessionStartEvent === undefined`）。
2. 计算 `projectTrusted`，创建目标 cwd 的设置管理器。
3. 调用 `createAgentSessionServices()`。
4. 从 `services` 取 `settingsManager`、`modelRuntime`、`resourceLoader`。
5. 聚合诊断：信任扩展警告、services 诊断、设置诊断、扩展加载错误。
6. 读取模型范围，`resolveModelScope()` 解析候选。
7. `buildSessionOptions()` 把 CLI 选项翻译成 SDK 选项。
8. 如果有 `--api-key`，调用 `modelRuntime.setRuntimeApiKey()`。它只写运行时凭证覆盖层，不写 `auth.json`。
9. 调用 `createAgentSessionFromServices()`。
10. 如果 CLI 显式给了思考级别或模型后缀给了级别，调用 `session.setThinkingLevel()` 应用。
11. 返回 `{ ...created, services, diagnostics }`。

首次装配由 [main.ts:1506](../../../../../packages/coding-agent/src/main.ts#L1506 "const runtime = await createAgentSessionRuntime(createRuntime, {") 触发。之后 `runtime` 持有工厂，扩展命令要求 `/new`、`/resume`、`/fork` 时再调用同一个工厂，因此目标 cwd 可以变化。

### 阶段 5：诊断、首句和模式分派

首次运行时返回后，`main()` 从容器取 `services`、`session`、`modelFallbackMessage`，把终端能力覆盖、代理和 HTTP 超时应用到当前设置，然后合并启动诊断和运行时诊断。

- `help`：打印扩展参数后 `process.exit(0)`。
- `list-models`：列出模型后 `process.exit(0)`。
- 非 RPC 模式读取管道 stdin；如果读到了内容且模式还是 `interactive`，降级为 `print`。
- `prepareInitialMessage()` 读取 `@file`，并把第一句从 `parsed.messages` 里取走。
- `initTheme()` 初始化主题。
- 非交互模式或存在运行时错误时打印诊断；运行时 `error` 会以 1 退出。
- 非交互模式没有模型时以 1 退出。
- 最后：

```ts
if (appMode === "rpc") await runRpcMode(runtime);
else if (appMode === "interactive") await new InteractiveMode(runtime, {...}).run();
else await runPrintMode(runtime, {...});
```

`main()` 本身不调用 `session.prompt()`。它把 runtime 和首句交给模式层，由模式层决定什么时候、以什么方式提交。

<a id="m01-walk-services"></a>
## 函数拆解二：createAgentSessionServices()

[agent-session-services.ts:218](../../../../../packages/coding-agent/src/core/agent-session-services.ts#L218 "export async function createAgentSessionServices(") 的职责是：为**一个有效 cwd** 准备模型、设置和资源，但**不创建** `AgentSession`。

输入是一个对象：

```ts
{
  cwd,                          // 目标会话目录
  agentDir?,                    // 用户配置根目录
  settingsManager?,             // 可复用已创建的设置
  modelRuntime?,                // 可复用已创建的模型运行时
  modelRuntimeSignal?,          // 只用于创建 ModelRuntime 的取消信号
  extensionFlagValues?,         // CLI 未识别的扩展参数
  resourceLoaderOptions?,       // 扩展、技能、提示词、主题的发现选项
  resourceLoaderReloadOptions?, // 资源加载阶段的信任回调等
}
```

输出是 `AgentSessionServices`：

```ts
{
  cwd: string,
  agentDir: string,
  modelRuntime: ModelRuntime,
  settingsManager: SettingsManager,
  resourceLoader: ResourceLoader,
  diagnostics: AgentSessionRuntimeDiagnostic[],
}
```

内部步骤：

1. `resolvePath()` 规范化 `cwd` 和 `agentDir`。`agentDir` 省略时用 `getAgentDir()`。
2. 如果没有传入 `modelRuntime`，调用 `ModelRuntime.create({ authPath: agentDir/auth.json, modelsPath: agentDir/models.json, signal })`。这会读取认证、模型配置和目录缓存，但不发聊天请求。
3. 如果没有传入 `settingsManager`，调用 `SettingsManager.create(cwd, agentDir)`；CLI 路径会传入已经按信任状态创建的实例。
4. 创建 `DefaultResourceLoader`，把 `cwd`、`agentDir`、`settingsManager` 和额外资源选项放进去。
5. `await resourceLoader.reload(reloadOptions)`。这一步才真正发现扩展、技能、提示词模板、主题和上下文文件；如果传了 `resolveProjectTrust`，它也在 reload 内部被调用。
6. 消费扩展注册队列：
   - `pendingProviderRegistrations` -> `modelRuntime.registerProvider()`。
   - `pendingNativeProviderRegistrations` -> `modelRuntime.registerNativeProvider()`。
   - `pendingVirtualModelRegistrations` -> `modelRuntime.registerVirtualModel()`。
   每一项单独 `try/catch`，失败只记诊断，不阻断其他注册。
7. `await modelRuntime.refresh({ allowNetwork: false })`，把本地认证、模型配置和扩展注册同步到可用快照。这里明确不联网。
8. `applyExtensionFlagValues()` 校验扩展 CLI 参数；未知参数和缺值参数变成 `error` 诊断。
9. 返回 services 和诊断。函数本身不打印诊断，也不退出。

为什么必须先建 `ModelRuntime` 再加载资源？因为扩展可以注册供应商、原生 Provider 和虚拟模型；这些注册会改变“有哪些模型可选”。如果先解析 `--model` 再加载扩展，模型可能找不到。反过来说，`ModelRuntime` 的创建和 `ResourceLoader` 的 reload 都不应该启动对话，所以这个阶段可以安全地做大量磁盘读取。

注意：`modelRuntimeSignal` 只覆盖 `ModelRuntime.create()` 这一段，不是整个资源加载的超时。扩展加载可能执行用户代码，耗时不受这个信号限制。

<a id="m01-walk-sdk"></a>
## 函数拆解三：createAgentSession()

[createAgentSession:285](../../../../../packages/coding-agent/src/core/sdk.ts#L285 "export async function createAgentSession(") 是 SDK 的装配入口。它的输入是 `CreateAgentSessionOptions`，输出是 `{ session, extensionsResult, modelFallbackMessage }`。它不发送任何模型请求。

### 输入与默认值

输入里的每一组字段都可能被上层显式指定，也可能交给 SDK 补默认：

| 输入 | 省略时 |
| --- | --- |
| `cwd` | 取 `sessionManager.getCwd()`，再退到 `process.cwd()` |
| `agentDir` | `getAgentDir()`，默认 `~/.pi/agent` |
| `modelRuntime` | 用 `authPath`/`modelsPath` 新建 |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` |
| `sessionManager` | `SessionManager.create(cwd, defaultSessionDir)` |
| `resourceLoader` | 新建 `DefaultResourceLoader` 并 `reload()` |
| `model` | 尝试从历史恢复，再走 `findInitialModel()` |
| `thinkingLevel` | 历史 -> 模型专属设置 -> 全局默认 -> `"medium"`，最后按模型能力 clamp |
| `tools` / `excludeTools` / `noTools` | 使用设置里的 `defaultTools`，再退到 `read/bash/edit/write` |
| `customTools` | 空数组 |
| `sessionStartEvent` | 会话层补 `{ type: "session_start", reason: "startup" }` |

### 内部步骤

1. **确定目录和共享对象**。`cwd` 和 `agentDir` 规范化；如果上层传了 `modelRuntime`、`settingsManager`、`resourceLoader`、`sessionManager`，直接复用。CLI 路径会传齐这些对象，所以 SDK 不会重复加载。
2. **读取已有会话**。`sessionManager.buildSessionContext()` 从会话树投影出 `messages` 和 `thinkingLevel`；`hasExistingSession` 只看投影后的消息数。不是“JSONL 文件存在”就算有会话。
3. **恢复模型**。`getBranchSelection()` 从当前分支的 `model_change` 条目恢复选择；只有模型仍存在且供应商有已配置认证时才采用。找不到时记录 `modelFallbackMessage`，继续走默认选择。
4. **默认模型**。`findInitialModel()` 接收的 `scopedModels` 在 SDK 里固定是空数组，范围首项已由上游 `buildSessionOptions()` 写成 `options.model`；因此这里实际顺序是：设置里的默认模型（需有认证）-> 可用快照中的本地默认候选 -> 可用快照首项。CLI 的 `--model` 如果已经解析成 `options.model`，根本不会进这个分支。
5. **思考级别**。显式 `options.thinkingLevel` 优先；否则历史里有 `thinking_level_change` 就用历史值，没有就用设置默认或 `"medium"`。最后 `clampThinkingLevel(model, level)` 把级别收窄到模型支持的范围。
6. **工具选择**。先校验 `tools` 列表不能混用“白名单”和“+name/-name 修饰项”；然后计算默认名单、显式允许名单、排除匹配器和初始激活名单。
7. **消息转换包装**。`convertToLlmWithBlockImages()` 先调用 `convertToLlm()`，再根据当前 `blockImages` 设置把图片替换成文字占位。每次转换都重新读设置，所以会话中途改设置会生效。
8. **请求辅助对象**。`CacheWarmer`、`buildRequestOptions()`、`cacheContextIsCurrent()`、扩展请求钩子都在这里创建；它们只是闭包，不会立即发请求。
9. **构造 Agent**。`new Agent({ initialState, convertToLlm, streamFn, ... })`。初始 `tools` 是空数组，`systemPrompt` 是空字符串；真正的工具和提示词由 `AgentSession` 构造器补上。
10. **标记流函数**。`markRuntimeStreamFunction(agent.streamFunction, modelRuntime)` 告诉摘要/压缩路径：这个 stream 函数自己会解析认证，不要再预解析 OAuth 凭证。
11. **写初始元数据**。新会话追加 `model_change` 和 `thinking_level_change`；已有会话缺 `thinking_level_change` 时补一条。这样下次恢复能拿到同样的选择。
12. **构造 AgentSession**。把 `agent`、`sessionManager`、`settingsManager`、`cwd`、`resourceLoader`、`modelRuntime`、工具配置、扩展引用和 `sessionStartEvent` 交给 `AgentSession`。构造器订阅事件、安装钩子、注册工具；这一步仍然不发请求。
13. **返回**。`extensionsResult` 供 UI 绑定扩展；`modelFallbackMessage` 只是提示文字，不是已打印的警告。

关键点：`createAgentSession()` 的“创建”是对象装配，不是执行。`session.prompt()` 之前，模型一次都没有被调用。

<a id="m01-walk-tools"></a>
## 函数拆解四：工具注册、激活与 streamFn 注入

### 工具的三层结构

读工具代码时最容易把三个集合混成一个：

| 集合 | 存在位置 | 含义 |
| --- | --- | --- |
| 定义（definition） | `AgentSession._toolDefinitions` | 工具的元数据：名字、描述、参数 schema、渲染器、暴露策略 |
| 注册表（registry） | `AgentSession._toolRegistry` | 名字到可执行 `AgentTool` 的映射；扩展和 SDK 工具也在这里 |
| 激活声明（declared） | `agent.state.tools` | 当前真正声明给模型的工具数组；模型只能看到这一层 |

“注册了”不等于“模型能用”。默认情况下注册表里有 8 个内置工具，但只有 4 个进入 `agent.state.tools`。

### 从 SDK 到 AgentSession

SDK 在 [sdk.ts:429](../../../../../packages/coding-agent/src/core/sdk.ts#L429 "const toolListError = options.tools ? getToolListError(options.tools) : undefined;") 之后计算初始名单：

- `defaultToolNames`：`noTools` 为真时是空数组；否则是设置里的 `defaultTools`，再退到 `DEFAULT_TOOL_NAMES`（`read`、`bash`、`edit`、`write`）。
- `toolModifiers`：如果 `tools` 全是 `+name`/`-name`，就把它当作对默认名单的增删；否则 `tools` 是显式允许名单。
- `allowedToolNames`：显式允许名单，或 `noTools: "all"` 时的空名单；其他情况是 `undefined`。
- `excludedToolNames`：`--exclude-tools` 的匹配规则。
- `initialActiveToolNames`：默认名单或允许名单经过排除过滤后的结果。

这些字段通过 `AgentSession` 构造参数传入。构造器在 [agent-session.ts:778](../../../../../packages/coding-agent/src/core/agent-session.ts#L778 "activeToolNames: this._initialActiveToolNames,") 调用 `_buildRuntime()`。

### `_buildRuntime()`：创建定义和扩展运行器

[agent-session.ts:6273](../../../../../packages/coding-agent/src/core/agent-session.ts#L6273 "private _buildRuntime(options: {") 做这些事：

1. 从设置读取 `autoResizeImages`、`shellCommandPrefix`、`shellPath`。
2. 如果没有 `baseToolsOverride`，调用 [createAllToolDefinitions:362](../../../../../packages/coding-agent/src/core/tools/index.ts#L362 "export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {")，创建 8 个定义：`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`。注意 `powershell` 也会被创建，但在非 Windows 平台通常不激活。
3. 把定义存进 `_baseToolDefinitions`。
4. 从 `resourceLoader.getExtensions()` 取得扩展结果，把扩展共享的 `flagValues` 恢复到扩展 runtime，然后创建新的 `ExtensionRunner`。
5. 绑定扩展的核心能力（工具注册、命令、事件等）。
6. 调用 `_refreshToolRegistry()`，传入初始激活名单和“是否包含所有扩展工具”的选项。

如果 SDK 传了 `baseToolsOverride`，基础定义会从覆盖表生成；这允许嵌入方替换 `read`、`bash` 等实现，而不改会话逻辑。

### `_refreshToolRegistry()`：合并、过滤、包装

[agent-session.ts:6081](../../../../../packages/coding-agent/src/core/agent-session.ts#L6081 "private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {") 的顺序是：

1. 记录旧注册表中“注册即默认激活”的工具，以及旧激活顺序。
2. 取扩展注册工具（跨扩展同名时 runner 保留第一个）和 SDK `customTools`，用允许/排除规则过滤。
3. 建立 `definitionRegistry`：先放基础定义，再放扩展/SDK 定义。同名时后者覆盖前者。
4. 从定义生成提示词摘要（`promptSnippet`）和规则（`promptGuidelines`）。
5. 把定义包装成可执行 `AgentTool`：基础工具和扩展工具都经过 `wrapRegisteredTools()`，执行时能拿到当前扩展上下文。
6. 建立新的 `_toolRegistry`：先放基础实现，再用自定义实现覆盖同名项。
7. 计算 `nextActiveToolNames`：
   - 调用方显式给了激活名单就复制它；
   - 否则保留旧激活集合；
   - 有允许列表时，把匹配且可声明的工具加入；
   - 首次构建且 `includeAllExtensionTools` 为真时，把默认激活的扩展工具加入；
   - 普通刷新只加入“本次新出现的默认激活工具”；
   - 最后补上待恢复的 `_pendingToolNames`。
8. 去重后调用 `_setActiveTools()`。

### `_setActiveTools()` 与 `_applyToolLoadout()`

[agent-session.ts:2640](../../../../../packages/coding-agent/src/core/agent-session.ts#L2640 "private _setActiveTools(toolNames: string[]): void {") 除了清理已成功激活的 pending 名称，核心是两件事：调用 `_applyToolLoadout()` 得到实际工具数组，然后用这些工具名重建基础 system 提示词。

[agent-session.ts:2723](../../../../../packages/coding-agent/src/core/agent-session.ts#L2723 "private _applyToolLoadout(toolNames: string[]): AgentTool[] {") 负责最终筛选：

- 保留旧激活顺序，新工具追加到末尾。这样只是重新排序同名工具不会改变提示词。
- 只从 `_toolRegistry` 里取已注册的实现。
- `hidden` 暴露级别的工具不进入 `agent.state.tools`。
- 未点名但被允许列表保留的 MCP 工具，只有暴露级别不是 `direct` 且 `tool_search` 已注册时才可激活。
- 运行每个工具的 `prepareLoadout` 钩子；钩子可以改描述或隐藏声明。单个钩子失败只报扩展错误，不阻断整个装载。
- 最后在 [agent-session.ts:2804](../../../../../packages/coding-agent/src/core/agent-session.ts#L2804 "this.agent.state.tools = declared;") 把结果写到 `agent.state.tools`。

以 `pi -p "..."` 为例，最终状态是：

```ts
_toolDefinitions: Map { read, bash, powershell, edit, write, grep, find, ls }
_toolRegistry:    Map { read, bash, powershell, edit, write, grep, find, ls }
agent.state.tools: [read, bash, edit, write]
```

模型看到的是 `agent.state.tools`，所以它不会知道 `grep`、`find`、`ls` 也存在。想启用它们，可以用 `--tools read,grep`，或在设置里调整 `defaultTools`，或用 `--tools +grep` 这类修饰项。

### `streamFn` 注入

[Agent 构造器:653](../../../../../packages/coding-agent/src/core/sdk.ts#L653 "const agent = new Agent({") 接收的 `streamFn` 是一个闭包，不是供应商对象。它只在 `Agent` 循环真正请求模型时执行：

1. `buildRequestOptions(options)` 合并本次调用参数和实时设置：超时、WebSocket 连接超时、重试次数、重试等待上限、客户端身份、扩展请求头钩子。每次请求都重新读取设置，所以会话中途修改设置会生效。
2. 如果 `options.sessionId === sessionManager.getSessionId()`，调用 `cacheWarmer.start(...)` 登记缓存保温目标。如果请求带的 sessionId 不是当前会话（例如摘要、压缩路径），这个条件为假，不会替换本会话的保温目标。
3. 返回 `modelRuntime.streamSimple(model, context, requestOptions)`。认证、虚拟模型路由、baseURL、headers 和真正的供应商调用都在 `ModelRuntime` 里，属于 [M04](../04-model-access/README.md)。

`markRuntimeStreamFunction(agent.streamFunction, modelRuntime)` 是一个标记：会话层知道这个流函数会自行解析认证，所以摘要请求不需要提前 `getAuth()`。这里的 `agent.streamFunction` 是同一个闭包，不是新函数。

`Agent` 循环看到的只有一个函数：给定 `model`、`context`、`options`，返回一个异步流。它不知道 API Key、OAuth、HTTP 或供应商协议。这种拆分让 M02 可以只处理消息和工具，把网络细节留给 M04。

<a id="m01-walk-runtime"></a>
## 函数拆解五：createAgentSessionRuntime() 与 AgentSessionRuntime

[createAgentSessionRuntime:711](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L711 "export async function createAgentSessionRuntime(") 是首次装配的协调者：

```ts
export async function createAgentSessionRuntime(createRuntime, options) {
  assertSessionCwdExists(options.sessionManager, options.cwd);
  const result = await createRuntime(options);
  return new AgentSessionRuntime(
    result.session,
    result.services,
    createRuntime,
    result.diagnostics,
    result.modelFallbackMessage,
  );
}
```

它只做三件事：

1. 检查会话 cwd 是否存在。
2. 调用工厂一次，拿到 `{ session, services, extensionsResult, diagnostics, modelFallbackMessage }`。
3. 构造容器，并把工厂引用保存进去。

它本身不创建 `Agent`、不加载资源、不发请求。首次装配的全部工作都在工厂里。

[AgentSessionRuntime:120](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L120 "export class AgentSessionRuntime {") 持有：

- `_session`：当前 `AgentSession`。
- `_services`：当前 cwd 的 services。
- `createRuntime`：以后重建会话的工厂。
- `_diagnostics`、`_modelFallbackMessage`。
- 可选的 `rebindSession` 和 `beforeSessionInvalidate` 回调。

它的 getter `session`、`services`、`cwd`、`diagnostics`、`modelFallbackMessage` 都返回当前值，不复制对象。模式层每次需要会话时应该通过 runtime 取，而不是长期保存第一次拿到的 `AgentSession`。

替换流程以 `newSession()` 为例：

1. 调用扩展的 `session_before_switch`（reason 为 `new`）；扩展可以取消。
2. 用当前会话的持久化模式创建新的 `SessionManager`：落盘会话继续落盘，内存会话继续内存。
3. `teardownCurrent("new", newSessionFile)`：
   - `await session.abort()`，让正在执行的回合和工具结果先收尾；
   - 发 `session_shutdown` 事件；
   - 调用宿主同步清理钩子；
   - `session.dispose()`。
4. `await createRuntime({ cwd, agentDir, sessionManager, sessionStartEvent })`，按新会话重新装配 services 和 `AgentSession`。
5. `finishSessionReplacement()`：先 `rebindSession()` 让 UI 订阅新会话，再执行调用方的 `withSession(ctx)`。

`switchSession()`、`fork()`、`importFromJsonl()` 的顺序相同：先让扩展有机会取消，再准备目标 `SessionManager`，再拆旧建新，最后重绑宿主。`apply()` 在 [agent-session-runtime.ts:299](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L299 "private apply(result: CreateAgentSessionRuntimeResult): void {") 一次性替换 session、services、diagnostics 和 fallback message。

这里有一个需要知道的失败语义：`teardownCurrent()` 一旦执行，旧会话已经被 `dispose()`。如果之后工厂抛错，错误会传给调用方，旧会话不会自动恢复。扩展和 UI 要在调用前处理错误，不能假设 runtime 会自动回滚。

模式层如何使用 runtime：

- `runPrintMode()` 保存 `runtimeHost.session`，并注册 `setRebindSession()`；会话替换后重新 `bindExtensions()` 和 `subscribe()`。
- `InteractiveMode` 持有 runtime，构造时只保存启动数据，`run()` 才初始化 TUI。
- `runRpcMode()` 直接接收 runtime，从 stdin 读命令。

这就是为什么 `AgentSessionRuntime` 要存在：模式层需要一个稳定的句柄，而底层会话可以在运行中被扩展命令替换。

<a id="m01-order"></a>
## 装配顺序图

下表把这条命令的每一步、输入和产出放在一起。行号是入口，不是整段逻辑的范围。

| 阶段 | 调用 | 主要输入 | 产出对象 | 下一步 |
| --- | --- | --- | --- | --- |
| 0 | 操作系统执行 `pi` | shell 参数 | `process.argv` | `cli.ts` |
| 1 | `setupCli()` | 无 | 进程环境、HTTP dispatcher | `main()` |
| 2 | `main(args)` | `["-p", "读取..."]` | 启动计时、扩展工厂列表、离线开关 | 一次性命令 |
| 3 | `runAuthCommand` / Windows 清理 / `cleanupManagedInstall` / 读取 cwd | 原始 args | 进程环境；命中命令则结束 | 启动设置 |
| 4 | `SettingsManager.create(..., projectTrusted:false)` + 代理 + `handlePackageCommand` / `handleConfigCommand` / `mcp` | cwd、agentDir | bootstrap 设置、HTTP dispatcher；命中命令则结束 | `parseArgs()` |
| 5 | `parseArgs()` | argv | `Args` | 模式判断 |
| 6 | `resolveAppMode()` | `Args` + TTY | `appMode`、stdout 接管 | 会话选择 |
| 7 | `createSessionManager()` | `Args`、cwd、sessionDir | `SessionManager` | 信任检查 |
| 8 | `ProjectTrustStore` + `hasTrustRequiringProjectResources()` | `sessionCwd` | 信任存储、待定信任状态 | 工厂定义 |
| 9 | `createRuntime`（定义） | 启动期固定输入 | 异步工厂函数 | `createAgentSessionRuntime()` |
| 10 | `createAgentSessionRuntime()` | 工厂、cwd、agentDir、sessionManager | 首次工厂结果 + 容器 | 工厂内部 |
| 11 | `createAgentSessionServices()` | 目标 cwd、agentDir、信任状态 | `AgentSessionServices` | 模型/选项解析 |
| 12 | `resolveModelScope()` + `buildSessionOptions()` | services、`Args` | `CreateAgentSessionOptions` | 会话创建 |
| 13 | `createAgentSessionFromServices()` | services、sessionManager、选项 | 转发给 SDK | `createAgentSession()` |
| 14 | `createAgentSession()` | SDK 选项 | `Agent` + `AgentSession` | runtime 容器 |
| 15 | `new AgentSessionRuntime()` | session、services、工厂 | `AgentSessionRuntime` | 模式分派 |
| 16 | `runPrintMode()` / `InteractiveMode.run()` / `runRpcMode()` | runtime、首句 | 模式状态 | `session.prompt()` |
| 17 | `session.prompt()` | 首句文字/图片 | 一次 run | M02/M03 |

把关键调用压成一条链：

```
cli.ts:13  main(["-p", "读取 README.md 前 20 行并总结"])
  main.ts:1036  bootstrap SettingsManager (projectTrusted:false)
  main.ts:1078  parseArgs -> Args
  main.ts:1131  resolveAppMode -> "print"
  main.ts:1196  createSessionManager -> SessionManager
  main.ts:1264  createRuntime (定义)
  main.ts:1506  createAgentSessionRuntime(createRuntime, {...})
    agent-session-runtime.ts:730  createRuntime({cwd, agentDir, sessionManager})
      main.ts:1298  createAgentSessionServices -> services
      main.ts:1463  createAgentSessionFromServices -> createAgentSession
        sdk.ts:653  new Agent({...})
        sdk.ts:743  new AgentSession({...})
    agent-session-runtime.ts:732  new AgentSessionRuntime(...)
  main.ts:1717  runPrintMode(runtime, {...})
    print-mode.ts:199  session.prompt(initialMessage)
```

<a id="m01-design"></a>
## 关键设计

### 1. 两层装配：services 与 runtime

services 是“当前这次装配对应的 cwd 基础设施包”：模型运行时、设置、资源加载器和诊断。runtime 是“当前这一代会话的容器”，持有 session、services 和工厂。

每次调用工厂（首次、`/new`、`/resume`、`/fork`、import）都会为目标 cwd 重新创建 services。这样切换目录时，模型目录、设置、扩展和项目资源不会错误地沿用旧目录。runtime 的价值不是“只加载一次”，而是“会话可以替换，模式层仍持有同一个句柄”。

### 2. 信任边界在加载项目资源之前

项目里的 `.pi/extensions/`、`.pi/skills/` 可以执行代码。`main()` 先创建 `ProjectTrustStore`，判断当前 cwd 是否有需要信任的资源；未信任时用 `SettingsManager.create(cwd, agentDir, { projectTrusted: false })` 读取设置，只加载全局资源。

有受控资源且没有现成决定时，信任解析被交给 `resourceLoader.reload()` 的回调。`resolveProjectTrusted()` 的顺序是：CLI 覆盖 -> 无资源时的已存决定/默认允许 -> 扩展 `project_trust` 事件 -> 已存决定 -> 默认策略 -> UI。回调返回后，`reload()` 调用 `settingsManager.setProjectTrusted()` 并重新读取设置：返回 `true` 才继续加载项目资源，返回 `false` 则跳过。print/RPC 没有交互 UI，默认 `ask` 会返回 `false`，所以未信任项目不会执行项目扩展。

这不是“界面提示”，而是实际的安全边界：未信任时项目扩展不会被求值。

### 3. 模式只决定驱动方式

`print`、`interactive`、`rpc` 都拿到同一个 `runtime`，都调用 `session.prompt()`。模式层的差异只在：

- 输入从哪来（argv、编辑器、stdin JSON）。
- 输出到哪去（最终文本、TUI、JSON 事件）。
- 生命周期（一次执行 vs 常驻）。

会话装配不接收 `appMode`，也不按模式分支。新增一种前端时，只需要实现“读输入、订阅事件、写输出”，并在替换会话后重新绑定。

### 4. `config.ts` 是资源路径的唯一入口

`packages/coding-agent` 可能从源码运行、从 npm 安装、或打包成单文件二进制。三种情况下 `__dirname` 的含义不同。`config.ts` 的 helper 统一处理这些差异，所以其他文件不直接拼包内资源路径。`getPackageDir()`、`getThemesDir()`、`getDocsPath()` 都是这个策略的一部分。

### 5. `--api-key` 不落盘

命令行传入的 key 通过 `modelRuntime.setRuntimeApiKey()` 设置，只影响当前进程；不会写进 `auth.json`。这样临时 key 不会留在磁盘上，也不会覆盖用户已保存的登录。

### 6. 启动期有三个设置视图

- bootstrap：`projectTrusted: false`，只用于代理等进程级配置。
- startup：启动 cwd 的设置，用于首次设置、`--use-theme` 启动覆盖、会话选择器、sessionDir 查询和启动期信任提示。它没有显式传 `projectTrusted`，按 `SettingsManager.create()` 的默认值会加载项目设置层；这是启动期决策所需，最终会话不会复用它。最终 `initTheme()` 读的是 runtime 设置。
- runtime：目标会话 cwd 的设置，带最终信任状态，交给 services 和 `AgentSession`。

把三者混成一个会导致两个问题：在信任决定之前把启动视图当最终视图使用；或者恢复跨项目会话后仍使用启动目录的设置。

### 7. 工具“注册”和“激活”分开

基础定义有 8 个，但默认只有 4 个进入 `agent.state.tools`。扩展注册的工具、MCP 工具、SDK 自定义工具也一样：先进入注册表，再按允许/排除规则、暴露策略和激活名单决定是否声明给模型。这样 `tool_search`、codemode 和扩展内部调用可以使用未声明的工具，而模型上下文不会被全部工具撑大。

### 8. stdout 是协议通道

非交互模式会接管 stdout：普通日志和 `console.log` 转到 stderr，结果和 JSON 事件通过 `writeRawStdout()` 写原始 stdout。这样扩展的调试输出不会破坏 JSONL，也不会混进最终回答。`main()` 在 `runPrintMode()` 返回后调用 `restoreStdout()`；`runPrintMode()` 的 `finally` 负责等待原始写队列排空。

<a id="m01-selfcheck"></a>
## 自测

先遮住答案回答，再对照。每题给出答案和可复查的章节/源码位置。

1. **首次装配要经过哪些关键对象？为什么不能把 `argv` 直接交给 SDK？**
   答案：`setupCli()` -> `main()` -> `parseArgs()` -> `resolveAppMode()` -> `createSessionManager()` -> 信任准备 -> 定义工厂 -> `SettingsManager.create()` -> `createAgentSessionServices()` -> `resolveModelScope()` / `buildSessionOptions()` -> `createAgentSessionFromServices()` -> `createAgentSession()` 构造 `Agent` 和 `AgentSession` -> `AgentSessionRuntime` -> 模式层 -> `session.prompt()`。`argv` 只是字符串；SDK 需要已经确定的参数、目标 cwd、`SessionManager`、`SettingsManager`、`ModelRuntime`、`ResourceLoader` 以及模型和工具选项，一次性命令还要在装配前短路。
   位置：[运行示例](#m01-example)、[装配顺序图](#m01-order)、[函数拆解一](#m01-walk-main)。

2. **`Args.mode` 和 `appMode` 有什么区别？**
   答案：`Args.mode` 只有 `text`、`json`、`rpc` 三种；`appMode` 有 `print`、`interactive`、`json`、`rpc`。`resolveAppMode()` 先处理显式 `rpc`/`json`，否则 `-p`、stdin 非 TTY 或 stdout 非 TTY 都走 `print`，剩下才是 `interactive`。所以 `pi --mode json` 是 `json`，而 `pi < input.txt` 即使没有 `-p` 也会变成 `print`。
   位置：[函数拆解一阶段 2](#m01-walk-main)、[main.ts:203](../../../../../packages/coding-agent/src/main.ts#L203 "function resolveAppMode(")。

3. **三个 `SettingsManager` 视图分别服务谁？为什么最终会话不能复用 startup 实例？**
   答案：bootstrap 在 [main.ts:1036](../../../../../packages/coding-agent/src/main.ts#L1036 "const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });") 创建，`projectTrusted:false`，只读全局层，用于代理和 dispatcher 等进程级配置；startup 在 [main.ts:1160](../../../../../packages/coding-agent/src/main.ts#L1160 "const startupSettingsManager = SettingsManager.create(cwd, agentDir);") 创建，服务启动 cwd，未显式传信任时 `SettingsManager.create()` 默认 `projectTrusted=true`，用于首次设置、`--use-theme` 启动覆盖、会话选择器、`sessionDir` 查询和启动期信任提示；最终 `initTheme()` 仍读 runtime 设置。runtime 在 [main.ts:1296](../../../../../packages/coding-agent/src/main.ts#L1296 "const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });") 创建，绑定目标会话 cwd 和本次信任状态，交给 services 和 `AgentSession`。信任被推迟时 runtime 先以 `false` 创建，资源加载器回调后再 `setProjectTrusted()` 并重新读取设置。不能复用 startup，因为恢复的会话 cwd 可能不是启动目录，而且 startup 创建时信任尚未定案。
   位置：[关键概念](#m01-terms)、[关键设计 6](#m01-design)。

4. **`cwd` 和 `sessionCwd` 为什么要分开？services 何时按哪个目录重建？**
   答案：`cwd` 是进程启动目录；`sessionCwd` 是 `SessionManager` 从 `--session`、`--resume` 等选择中恢复出的有效目录。`main()` 先调用 `getMissingSessionCwdIssue()`：交互模式可以让用户选择继续用当前目录，非交互模式直接退出 1。随后 `createAgentSessionRuntime()` 把 `sessionManager.getCwd()` 交给工厂，工厂按这个目录创建设置和 services。首次装配、`/new`、`/resume`、`/fork`、import 都会重新调用工厂，所以 services 按当次目标 cwd 重建，不会沿用启动目录的模型目录、设置或项目资源。
   位置：[函数拆解一阶段 3/4](#m01-walk-main)、[关键设计 1](#m01-design)。

5. **项目信任在什么时候判定？print/RPC 的默认 `ask` 为什么得到 `false`？**
   答案：信任在加载项目扩展、技能等受控资源之前判定。没有显式覆盖、没有进程缓存且存在受控资源时，`resourceLoader.reload()` 先加载信任扩展，再调用 `resolveProjectTrust`。`resolveProjectTrusted()` 的顺序是 CLI 覆盖 -> 扩展的 `project_trust` 事件 -> 已存决定 -> 默认策略 -> UI。print/RPC 没有交互 UI，默认 `ask` 返回 `false`。回调结果会写回 `SettingsManager`：`true` 才继续加载项目资源，`false` 跳过。因此未信任项目的扩展不会被执行，项目设置也不会进入视图。
   位置：[关键设计 2](#m01-design)、[project-trust.ts:90](../../../../../packages/coding-agent/src/core/project-trust.ts#L90 "export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {")、[core/resource-loader.ts](../../../../../packages/coding-agent/src/core/resource-loader.ts "resource-loader.ts")。

6. **`createAgentSession()` 返回前会请求模型吗？工具从定义到模型可见经过哪几层？**
   答案：不会，模型请求次数是 0；第一次请求发生在 `session.prompt()` 之后。工具分三层：`_toolDefinitions` 保存全部定义（默认 8 个内置工具），`_toolRegistry` 保存名字到可执行 `AgentTool` 的映射（含扩展和 SDK 工具），`agent.state.tools` 是当前声明给模型的激活集合（默认 `read`、`bash`、`edit`、`write`）。`getAllTools()` 读定义层，`getActiveToolNames()` 读激活层；注册了不等于模型能看到。
   位置：[函数拆解三](#m01-walk-sdk)、[函数拆解四](#m01-walk-tools)。

7. **`runtime.session` 为什么是 getter？替换会话后为什么必须重新绑定？**
   答案：getter 每次返回容器当前的 `_session`；`newSession()`、`switchSession()`、`fork()`、import 会先 teardown 旧会话（`abort`、`session_shutdown`、`dispose`），再调用工厂，最后由 `apply()` 一次性替换 session、services、诊断和 fallback。模式层的事件订阅和扩展绑定挂在具体 `AgentSession` 上，替换后必须通过 `setRebindSession` 重新绑定；print 模式会重新 `bindExtensions`/`subscribe`，交互模式会重画并重绑。继续使用旧引用会错过新会话事件，甚至操作已 dispose 的会话。
   位置：[函数拆解五](#m01-walk-runtime)、[agent-session-runtime.ts:170](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L170 "get session(): AgentSession {")。

8. **哪些装配错误会终止进程，哪些只变成诊断？替换失败能回滚吗？**
   答案：参数 `diagnostics` 有 `error` 时，`parseArgs()` 之后直接退出 1；恢复会话目录缺失时，交互模式询问 Continue/Cancel，非交互模式退出 1，运行时内部还会在工厂前抛 `MissingSessionCwdError`；非交互模式没有模型时退出 1，交互模式允许进入 UI 继续配置；扩展或供应商注册失败逐项变成诊断，不阻断其他注册，但最终存在 error 诊断时 `main()` 仍会退出 1。替换会话是先 teardown 再工厂，工厂失败时旧会话已经被 dispose，没有自动回滚。
   位置：[函数拆解一阶段 1/2/5](#m01-walk-main)、[函数拆解二](#m01-walk-services)、[函数拆解五](#m01-walk-runtime)、[main.ts:1089](../../../../../packages/coding-agent/src/main.ts#L1089 "if (parsed.diagnostics.some((d) => d.type === \"error\")) {")、[main.ts:1613](../../../../../packages/coding-agent/src/main.ts#L1613 "if (appMode !== \"interactive\" && !session.model) {")、[agent-session-runtime.ts:728](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L728 "assertSessionCwdExists(options.sessionManager, options.cwd);")。

<a id="m01-exercises"></a>
## 练习

下面四项都用本地测试、进程输出或源码阅读验证，不需要真实供应商认证。只有练习 1 末尾的可选命令会发真实请求，已单独标注。

### 练习 1：确认 `--mode json` 的 stdout 是协议通道

目标：看清普通日志和机器输出为什么必须分开。

在 `packages/coding-agent` 目录运行：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/stdout-cleanliness.test.ts -t "keeps stdout empty for --mode json --help"
```

再运行同一文件的另一个用例：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/stdout-cleanliness.test.ts -t "prints plain --help to stdout when stdout is redirected"
```

第一条用例断言 `stdout === ""`，stderr 同时包含启动日志和 `Usage:`；第二条用例断言 `Usage:` 在 stdout。两条命令都不启动模型。

对应源码：`--mode json --help` 的 `appMode` 是 `json`，不属于“没有 `-p`、没有 `--mode` 的 `--help`/`--list-models`”这个例外，所以非交互模式调用 `takeOverStdout()`，普通写入去 stderr，机器结果由 `writeRawStdout()` 写原始 stdout。单独 `--help` 则保留 stdout 输出。见[关键设计 8](#m01-design) 和 [main.ts](../../../../../packages/coding-agent/src/main.ts "main.ts")。

可选：把命令换成 `pi --mode json -p "只回复 ok"`。这会向模型发真实请求，需要已配置认证，可能产生费用，不是本练习的必做项。

### 练习 2：恢复会话时，运行时 cwd 来自会话而不是启动目录

运行：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/session-cwd.test.ts
```

这个文件用 `writeSessionFile()` 写入只有会话头的 JSONL，字段是 `type: "session"`、`version: 3`、`id`、`timestamp` 和 `cwd`。对照三个用例：

- 头里的 cwd 已被删除时，`getMissingSessionCwdIssue()` 返回原 cwd 和 fallback cwd。
- `SessionManager.open(file, undefined, fallback)` 显式覆盖有效 cwd 后，`getCwd()` 返回 fallback。
- 缺目录且没有覆盖时，`createAgentSessionRuntime()` 在调用工厂前抛 `MissingSessionCwdError`，测试里的 `createRuntimeCalled` 仍为 `false`。

回到 `main()`：交互模式下用户选择 Continue 才会用当前目录重新打开同一日志，Cancel 退出 0；print、JSON 和 RPC 没有这个选择器，直接输出错误并退出 1，不会悄悄改用当前目录。目录存在时，`main()` 把 `sessionManager.getCwd()` 传给 `createAgentSessionRuntime()`，工厂按它创建设置和 services。运行时内部还有 [agent-session-runtime.ts:728](../../../../../packages/coding-agent/src/core/agent-session-runtime.ts#L728 "assertSessionCwdExists(options.sessionManager, options.cwd);") 作为第二道检查。源码测试见 [session-cwd.test.ts](../../../../../packages/coding-agent/test/session-cwd.test.ts "session-cwd.test.ts")。

### 练习 3：注册表里有工具，模型不一定看得到

运行三个用例：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/default-tools-setting.test.ts -t "uses the configured list as the initial built-in selection"
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/default-tools-setting.test.ts -t "applies through service-based session creation"
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/default-tools-setting.test.ts -t "activates an inactive extension tool with +name"
```

观察断言：

- 第一个用例的 `getAllTools()` 有 8 个内置工具，`getActiveToolNames()` 只有配置的 `grep`、`find`。
- 第二个用例通过 services 创建会话，激活名单只有 `ls`，但注册表仍有 8 个内置定义。
- 第三个用例里扩展工具默认不激活，配置 `+inactive_tool` 后才进入激活名单。

把三个集合对上：`_toolDefinitions` 对应 `getAllTools()`，`_toolRegistry` 是可执行实现表，`agent.state.tools` 对应 `getActiveToolNames()` 和模型真正看到的声明。注册不等于激活。源码测试见 [default-tools-setting.test.ts](../../../../../packages/coding-agent/test/default-tools-setting.test.ts "default-tools-setting.test.ts")。

### 练习 4：同一个 runtime 句柄里替换会话

启动交互模式：

```bash
pi --no-session
```

依次输入 `/session`、`/new`、`/session`、`/quit`。不要输入普通问题，所以不会请求模型，也不需要认证。

观察：`/new` 后显示 `New session started`，第二次 `/session` 的 ID 和第一次不同，但进程仍持有同一个 runtime。交互模式在 `setRebindSession()` 里重新绑定新会话；`runtime.session` 是 getter，替换后返回新对象。旧会话已经在 teardown 中 `abort` 并 `dispose`。

可选的深入验证使用 faux provider，不需要真实 key：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/agent-session-runtime.test.ts -t "updates the runtime session cwd on cross-cwd session replacement"
```

该用例从一个目录的 runtime 切换到另一个目录的会话，断言 `runtime.session.sessionManager.getCwd()` 和 `runtime.cwd` 都变成第二个目录。它说明替换的不只是 session，services 也随目标 cwd 重建。如果测试入口提示缺少构建产物，先在仓库根目录执行 `npm run build` 再重试。测试见 [agent-session-runtime.test.ts](../../../../../packages/coding-agent/test/suite/agent-session-runtime.test.ts "agent-session-runtime.test.ts")。

<a id="m01-misread"></a>
## 常见误解

- **“`-p` 是打印提示词”**：不是。`-p` 是 print mode，表示一次性执行并输出最终结果；提示词来自紧跟其后的位置参数。最终文本通常来自最后一次模型请求，不是第一次带 `toolCall` 的回答。
- **“`main()` 直接 `new AgentSession()`”**：不是。`main()` 定义工厂，`createAgentSessionRuntime()` 调用工厂，工厂再调用 `createAgentSessionFromServices()`，最后才到 SDK 的 `createAgentSession()`。
- **“`createAgentSession()` 会发请求”**：不会。它只装配 `Agent` 和 `AgentSession`；第一次模型请求发生在 `session.prompt()` 之后。
- **“`AgentSession` 就是低层循环”**：不是。循环在 `Agent`/`agent-loop.ts`；`AgentSession` 负责会话、扩展、持久化、压缩和重试，它调用 `Agent.prompt()`。
- **“`services` 每个 cwd 只加载一次”**：代码里每次调用工厂都会重建 services。runtime 可以让会话替换，但 services 是随新会话重新装配的；目标 cwd 变了更必须重建。
- **“`runtime.session` 是一个固定引用”**：它是 getter。`/new`、`/resume`、`/fork` 后指向新对象；模式层必须通过 `rebindSession` 重新订阅，不能一直用旧 `session`。
- **“工具创建了就会给模型”**：不是。定义、注册表、`agent.state.tools` 是三层；默认只声明 `read`、`bash`、`edit`、`write`。
- **“`--api-key` 会保存”**：不会，只在当前 `ModelRuntime` 的运行时覆盖层生效。
- **“设置加载一次就固定”**：启动期有 bootstrap、startup、runtime 三个视图；`reload()`、信任状态变化和会话切换都会重新创建或刷新设置。
- **“`appMode` 就是 `Args.mode`”**：不是。`Args.mode` 只有 `text`、`json`、`rpc`；`appMode` 还包含 `interactive`，并且会被 TTY 和管道输入影响。
- **“`createAgentSessionRuntime()` 自己创建会话”**：不是。它只检查 cwd、调用传入的工厂、把结果放进容器；实际创建在工厂里。
- **“非交互模式下 `console.log` 就是结果”**：不是。stdout 已被接管，普通输出会去 stderr；结果通过原始 stdout 写。

<a id="m01-next"></a>
## 继续阅读

- 下一站：[M02 Agent 循环](../02-agent-loop/README.md)，看 `AgentSession.prompt()` 如何进入低层循环；可以先读[大白话总览](../02-agent-loop/README.md#m02-plain)。
- 会话从哪里恢复、上下文如何投影：[M03 会话与上下文](../03-session-and-context/README.md)。
- 模型和认证如何解析：[M04 模型访问](../04-model-access/README.md)。
- 三种模式的具体实现：[M05 模式与 TUI](../05-modes-and-tui/README.md)。
- 回到全链路：[S1 进程启动](../00-full-chain/README.md#m00-s1)、[S2 主装配](../00-full-chain/README.md#m00-s2)、[S3 创建会话](../00-full-chain/README.md#m00-s3)。
- 想看首句如何进入运行：[S4 打印模式](../00-full-chain/README.md#m00-s4)、[S5 会话入口](../00-full-chain/README.md#m00-s5)。
