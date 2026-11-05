# Pi 中文架构导读

面向第一次接触本仓库、尚不熟悉 TypeScript 的读者。先看 [中文图解](docs/learning/pi/pi-architecture.html)，再看 [架构图源码](ARCHITECTURE_DIAGRAMS.md)；需要查具体模块时回到本文。

分析基线：提交 `5d74f40de919742b5847eb2da4b023d048987689`。覆盖全部 12 个顶层包及 4 个扩展示例工作区；核心流程通过源码核对，其余模块按公开入口和代表实现梳理。这是架构导读，不是逐函数正确性审计。

学习分支已继续添加整文件中文注释，当前范围见 [覆盖进度](docs/learning/pi/STUDY_PROGRESS.md)。注释会改变源码行号，本文对已注释入口改用文件链接和函数名定位；机器清单中的行号仍对应生成时的分析基线。

## 1. Executive Summary（先抓住两条主线）

Pi 同时包含一个终端编码助手和一组可复用的运行库。**理解 CLI，先读 coding-agent → agent → ai。** coding-agent 组织界面、配置、会话和工具；agent 执行“请求模型 → 调用工具 → 再请求模型”的循环；ai 适配模型提供商。

同仓库的 durable、chord、env 提供持久任务、跨进程对象和远程执行能力。它们组成另一组可以被应用使用的运行库。当前 CLI 没有依赖这三个包，不能把全部包画成一条必经调用链。

还有一个容易混淆的地方：CLI 的 SessionManager 用 JSONL 保存会话，Durable 有自己的 Storage、任务调度和恢复机制。两者的“会话”并非同一实现。

## 2. Repository Purpose（这个仓库解决什么问题）

这是 npm workspaces 管理的 monorepo，也就是多个相关软件包共用一个仓库。使用者可以直接运行 pi，也可以通过 SDK 在自己的应用中创建编码助手，或者单独使用 ai、agent、tui 等库。

例如“读取 README 并解释它”：模型返回 read 工具调用；Pi 在本地执行工具，把文件内容作为工具结果交回模型，再显示模型生成的解释。模型输出工具调用数据，真正的文件读取由本地工具实现。

产品边界：项目资源信任决定是否加载项目配置和扩展；它不等于操作系统层面的文件、进程或网络沙箱。外部 MCP server 也有自己的进程和认证边界。证据见 [main.ts](packages/coding-agent/src/main.ts)、[项目资源信任](packages/coding-agent/src/core/project-trust.ts)、[工具实现](packages/coding-agent/src/core/tools/index.ts)。

## 3. Audience Guide（怎样使用这份导读）

- **初学者**：先看图解第一屏，认识各包的一句话职责；再逐步播放一次请求，最后读 [TypeScript 中文注释入门](docs/learning/pi/TYPESCRIPT.md)。暂时不必读所有提供商和 Chord 设计文档。
- **维护者**：查模块表、接口清单和证据表。包依赖图回答“代码依赖谁”，运行流程图回答“这次执行调用谁”，两种箭头不要混读。
- **AI agent**：先读 [AGENTS.md](AGENTS.md) 和目标包的本地说明。改 Chord v2 时，另须完整阅读其 design、slices 和对应 slice spec；本文不能代替设计规范。

## 4. System Context（与外部系统的关系）

输入来自终端、命令行参数、管道、SDK 或 JSONL RPC。输出进入终端或标准输出，也会产生本地文件、命令进程、会话记录和外部模型请求。扩展可增加工具、命令、提供商和界面行为。

模型服务、MCP server、远端 SSH daemon 都是不同的外部连接。不是每种运行方式都会启用全部连接。数据库也不是启动 Pi CLI 的必需条件：SQLite、IndexedDB 等属于可选运行库适配器。

见 [系统图与运行流程](ARCHITECTURE_DIAGRAMS.md)。

## 5. Main Entry Points（从哪里启动）

| 入口 | 用途 | 源码依据 |
|---|---|---|
| pi 命令 | 终端产品入口 | [coding-agent/package.json](packages/coding-agent/package.json)，[cli.ts](packages/coding-agent/src/cli.ts) |
| main | 参数、资源信任、会话选择、运行模式 | [main.ts](packages/coding-agent/src/main.ts) |
| createAgentSession | 在程序中组装 AgentSession | [sdk.ts](packages/coding-agent/src/core/sdk.ts) |
| runRpcMode | 从标准输入读取 JSONL 命令，向标准输出写结果和事件 | [rpc-mode.ts](packages/coding-agent/src/modes/rpc/rpc-mode.ts) |
| pi-ai 命令 | 开发用模型认证 CLI | [ai/cli.ts](packages/ai/src/cli.ts) |
| Harness.open | 启动持久任务运行库 | [durable harness](packages/durable/src/harness/harness.ts) |
| createHttp / app 子路径 | 由其他应用组装 HTTP、认证、插件和客户端能力 | [Chord HTTP](packages/chord/src/node/http/index.ts)，[app](packages/chord/src/node/app/index.ts) |

## 6. Major Components（全部顶层包）

下表的依赖来自各包 package.json 的 dependencies。它表示发布和安装关系，包含可能只用于类型的依赖，不保证每次执行都走到该包。完整声明及源码 import 证据见 [inventory.json](docs/learning/pi/inventory.json)。

| 包 | 负责什么 | 先读这里 | 直接内部依赖 |
|---|---|---|---|
| coding-agent | 编码助手产品：CLI、会话、工具、扩展、配置、交互模式 | [main.ts](packages/coding-agent/src/main.ts)，[sdk.ts](packages/coding-agent/src/core/sdk.ts) | agent、ai、codemode、mcp、tui |
| agent | 内存状态、事件、工具调用循环、steer 与 followUp 队列 | [agent.ts](packages/agent/src/agent.ts)，[agent-loop.ts](packages/agent/src/agent-loop.ts) | ai、schema |
| ai | 消息类型、模型目录、认证、提供商与流式请求 | [index.ts](packages/ai/src/index.ts)，[models.ts](packages/ai/src/models.ts) | schema、telemetry |
| tui | 终端输入、布局、编辑器、组件和差量渲染 | [index.ts](packages/tui/src/index.ts)，[tui.ts](packages/tui/src/tui.ts) | 无 |
| codemode | 在 QuickJS WASM 中运行代码，通过注入的能力调用工具 | [index.ts](packages/codemode/src/index.ts)，[host.ts](packages/codemode/src/runtime/host.ts) | 无 |
| mcp | MCP 客户端、stdio/HTTP transport、OAuth | [index.ts](packages/mcp/src/index.ts)，[client.ts](packages/mcp/src/client.ts) | 无 |
| durable | 持久化 conversation、task、document 和可恢复调度 | [index.ts](packages/durable/src/index.ts)，[harness.ts](packages/durable/src/harness/harness.ts) | chord、ai、codemode、schema、telemetry |
| chord | 合约、对象宿主、引用、文档、store、链接，以及平台适配 | [index.ts](packages/chord/src/index.ts)，[HTTP 子入口](packages/chord/src/node/http/index.ts) | schema、telemetry |
| env | 本地和 SSH 远程执行环境，连接 Rust daemon | [index.ts](packages/env/src/index.ts)，[remote-env.ts](packages/env/src/remote-env.ts) | chord、durable |
| schema | JSON Schema 构造和运行时校验 | [index.ts](packages/schema/src/index.ts)，[validator.ts](packages/schema/src/validator.ts) | 无 |
| telemetry | trace、span、metric 契约与参考适配器 | [index.ts](packages/telemetry/src/index.ts) | 无 |
| evals | 私有评测工具、Docker harness 和报告 | [cli.ts](packages/evals/src/cli.ts)，[harness.ts](packages/evals/src/harness.ts) | 无运行依赖；开发依赖 ai、coding-agent |

顶层包之外，还有四个显式 workspace 扩展示例：with-deps、custom-provider-anthropic、custom-provider-gitlab-duo、gondolin，位于 [扩展示例目录](packages/coding-agent/examples/extensions)。root 的 apps 通配模式当前没有匹配目录。

### coding-agent 的内部职责

main 负责启动和模式选择；services 组装与工作目录绑定的设置、资源和模型服务；SDK 创建 Agent 和 AgentSession；AgentSession 协调提示词、扩展、上下文、重试和压缩；SessionManager 保存会话记录并计算当前分支的模型上下文；ModelRuntime 提供模型选择、认证和请求路由。

InteractiveMode、print 和 RPC 消费同一套运行时和 session。TUI 负责终端显示，不负责模型是否继续调用工具的判断。

### ai 的新旧接口边界

ai 根入口明确是无注册副作用的 core。新模型体系用 Models 组合多个 Provider；Provider 提供认证、目录与流式请求实现，createProvider 可按 model.api 选择 API 实现。coding-agent 的 ModelRuntime 实现 Models 接口，并注入 Agent 的 streamFn。

compat 子入口另有全局注册器和旧式便捷函数。当前 coding-agent 仍导入部分 compat API；不要把 compat 的全局注册行为解释成整个 ai 根入口的行为。证据：[models.ts](packages/ai/src/models.ts)、[compat.ts](packages/ai/src/compat.ts)、[model-runtime.ts](packages/coding-agent/src/core/model-runtime.ts)。

### Durable、Chord、Env 的边界

Durable 的 Harness 组合 Storage、任务 registry、Models 和可选 ExecutionEnv。GenerationTask 请求模型，ToolTask 执行工具，CompactionTask 压缩上下文，TaskScheduler 协调任务。StoreStorage 是其连接 Chord Store 的一种适配；不能把所有 Storage 都画成 Chord SQLite。

Chord 用合约描述可访问的行为，宿主管理实现对象的生命周期，引用和链接连接调用方与对象；文档、作业（jobs）和 store 管理状态。plugins、HTTP、workers、web、React 和 TUI 由不同子路径提供。旧版实现仍通过 old 子路径导出。

Env 实现 Durable 定义的 ExecutionEnv。RemoteExecutionEnv 经连接向远端 Rust daemon 请求文件和命令操作。本次未验证远程部署、断线恢复或云平台运行。

## 7. Data and Control Flow（一次消息如何流转）

以下是正常工具调用路径；扩展可以拦截、改写或处理输入。

1. cli.ts 先 setupCli，再把命令行参数交给 main。main 选择或创建会话，确定工作目录和项目资源信任。
2. services 创建 SettingsManager、ModelRuntime、DefaultResourceLoader；加载扩展、skills、提示词模板和主题。SDK 创建 AgentSession 与 Agent。
3. 交互模式、print 或 RPC 调用 AgentSession.prompt。它处理扩展命令、输入 hooks、skill/template 展开；如果当前忙，则按指定策略排队。
4. AgentSession 准备上下文、模型认证、系统提示词和工具，再调用 agent.prompt。
5. agent-loop 先应用上下文变换，将 AgentMessage 转成模型 Message，通过注入的 streamFn 发起流式请求。SDK 的 streamFn 委托 ModelRuntime。
6. 模型返回的文本增量变成 message_update 事件；若响应包含 toolCall，则先查找工具、校验参数，再经过 beforeToolCall、execute、afterToolCall。
7. 工具结果作为 toolResult 加入上下文。循环根据工具调用、排队消息和 finishTurn 决策继续请求，直至结束。不是一次用户输入只发一次模型请求。
8. AgentSession 订阅事件；普通 message_end 消息交给 SessionManager.appendMessage。UI/print/RPC 也收到相应事件。持久化还受会话模式和 flush 策略影响，不能把每次流增量都理解成一次磁盘写入。
9. AgentSession 处理重试、压缩和收尾；agent_settled 表示 session 层也完成了这一轮处理。

### 完整历史和模型上下文不同

JSONL 表示一行一个 JSON 记录。SessionManager 维护内存条目和分支，持久会话再按策略写入文件；恢复时从文件加载。它根据内存记录中的当前分支、压缩条目和 context_edit 计算投影，即“这次模型实际能看到的消息”，不是每次模型请求都重新读磁盘。

例如历史很长时，Pi 写入压缩摘要，保留部分最近消息，再建立新的模型上下文；原始会话记录仍保留。重试也可以用 context_edit 从上下文中忽略失败尝试，而非删除原始历史。

### 工具和扩展接口

普通工具工厂包括 read、bash、powershell、edit、write、grep、find、ls。createCodingTools 默认组合 read/bash/edit/write，最终启用集合还受设置、工具选项和扩展影响。

内置扩展包含 llama.cpp、codemode、tool-search、MCP。MCP 扩展连接外部 server，将其能力接入工具和资源系统；mcp 包本身是客户端库。详见 [接口清单](docs/learning/pi/INTERFACES.md)。

## 8. Runtime, Configuration, and Deployment（运行与配置）

主代码使用 TypeScript、ESM 和 Node。声明的最低 Node 版本是 22.19，仓库开发依赖的 TypeScript 版本是 7.0.2；具体以 [package.json](package.json) 和 [基础 TS 配置](tsconfig.base.json) 为准。Rust daemon、TUI 平台原生辅助模块和 QuickJS WASM 属于各自边界，不代表所有源码都由 Node 执行。

默认全局配置位于 ~/.pi/agent，可用 PI_CODING_AGENT_DIR 覆盖；包含 auth.json、models.json、settings.json 和 sessions。项目设置位于 .pi/settings.json。提供商可使用 API key 或支持的认证方式；按选中的提供商配置，不需要同时配置全部服务。只查变量名和配置结构，不读取真实凭据。

常用开发命令：

```sh
npm install --ignore-scripts
npm run build
npm run build:offline
./pi-test.sh
```

build 会刷新模型数据并构建 workspace；build:offline 使用已准备的模型数据，不能凭空补齐缺失数据。构建顺序由依赖和构建产物需求决定，不是运行时调用顺序。

产品可通过 npm 包、独立二进制或 Nix 使用。evals 的 Dockerfile 用于评测环境；它不是所有用户必须采用的部署方式。参考 [构建配置](package.json)、[二进制构建脚本](scripts/build-binaries.sh)、[Nix 配置](nix/package.nix)。

## 9. Testing and Verification（怎样验证）

多数包使用 Vitest；TUI 使用 Node 自带测试运行器。coding-agent 的 suite harness 使用 faux provider 模拟模型，避免真实 API 和付费 token。

修改代码后按 AGENTS 运行 npm run check。注意它包含 Biome --write，会修改格式，不是纯只读检查。需要加载 dist 的测试先构建。全仓库非真实模型测试使用根目录 test.sh；不要自行运行 npm test 或全量 Vitest。

单个测试从所属包目录运行，例如：

```sh
# 在 packages/agent 中：验证工具循环。
node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts

# 在 packages/coding-agent 中：验证 JSONL RPC。
node ../../node_modules/vitest/dist/cli.js --run test/rpc-jsonl.test.ts
```

最初架构整理验证了文档结构、链接、清单一致性及页面渲染，见 [验证记录](docs/learning/pi/VERIFICATION.md)。后续源码注释另做语法树、执行代码和指定离线测试检查，实际批次结果见 [学习日志](docs/learning/pi/STUDY_LOG.md)。

## 10. How to Navigate the Codebase（新手阅读顺序）

| 顺序 | 阅读目标 | 应该能回答的问题 |
|---|---|---|
| 第一站 | [cli.ts](packages/coding-agent/src/cli.ts) | import、函数调用和命令行参数怎么连接？ |
| 第二站 | [main.ts](packages/coding-agent/src/main.ts) 的 main 和 resolveAppMode | 为什么有交互、print、JSON、RPC 几种模式？ |
| 第三站 | [sdk.ts](packages/coding-agent/src/core/sdk.ts) | 谁创建 Agent 和 AgentSession，依赖怎样注入？ |
| 第四站 | [agent.ts](packages/agent/src/agent.ts) 与 [agent-loop.ts](packages/agent/src/agent-loop.ts) | 为什么工具执行完还要请求模型？ |
| 第五站 | [ai/models.ts](packages/ai/src/models.ts) 与一个 provider | 统一接口怎样接到不同模型服务？ |
| 第六站 | [AgentSession](packages/coding-agent/src/core/agent-session.ts) 与 [SessionManager](packages/coding-agent/src/core/session-manager.ts) | 历史保存、当前上下文、重试和压缩如何协调？ |
| 第七站 | [TUI 入口](packages/tui/src/index.ts) 与 [扩展示例](packages/coding-agent/examples/extensions) | 显示和扩展能力怎样接入？ |
| 进阶分支 | durable → chord → env | 持久任务和跨进程应用运行库解决什么额外问题？ |

大文件先按这个问题顺序进入，再完整阅读目标文件。每次读一个机制，配一个具体输入输出例子。[TypeScript 注释课](docs/learning/pi/TYPESCRIPT.md) 使用真实源码的短片段逐步解释语法。

## 11. Safe Change Guide for Humans and AI Agents（修改边界）

AI agent 和人都应先读目标文件全文及本地规范。修改模式选择先定位 main，修改工具循环定位 agent-loop，修改单个工具定位对应工厂，修改模型接入定位 ai 的 provider/API 边界；不要因为同仓库还有 Durable 就把 CLI 会话实现替换成它。

模型生成文件 models.generated.ts 由 catalog 生成，编辑定义后再生成；providers/data 是被忽略的生成数据。不要修改发布过的 changelog 章节、批量格式化无关文件或提交其他会话的改动。未获用户指令不提交代码。

Chord v2 开发和评审须按 AGENTS 完整阅读 design、slices、目标 slice，并执行规定检查与测试；本文对其仅作架构定位。涉及有意存在的功能或代码删除，先取得用户确认。

## 12. Assumptions and Items Needing Human Validation（范围与待确认）

本次高置信度结论来自 manifest、公开入口和关键实现。源码静态路径不能证明远端凭据有效、特定 provider 可达、SSH daemon 可部署或所有取消/恢复分支都通过测试；这些需要独立运行验证。

### Validation notes

- root README 的包表列出 7 个包，实际有 12 个顶层包，本文按实际 workspace 补齐。
- README 的供应链段落称内部依赖使用版本范围；当前 manifest 中内部版本为精确的 1.5.0。文档以当前 manifest 为准。
- root 的 apps 通配模式没有匹配目录；没有据此虚构应用层。
- agent 声明依赖 schema，但直接源码引用是 import type，运行时被擦除。工具校验的实际路径经 ai 的 validation 到 schema。
- Chord 设计文档中的目标集成示例不作为 CLI 已实现组件。没有完整评审 Chord v2 设计及 slice 实现。
- 公开 API 附录是声明级静态文本索引，覆盖公开子路径及递归星号导出；不展开对象成员、动态扩展和第三方包内部导出，也不替代 TypeScript 编译器的符号解析。

## 13. Suggested Architecture Improvements（可选的后续改进）

这里只列文档与验证方面的小改进，未实施生产代码改动。Category 为分类；后四列分别是开发理由、维护理由、工作量、风险及优先级。

| Category | Recommendation | Evidence | Senior Developer Rationale | Manager Rationale | Effort | Risk | Priority |
|---|---|---|---|---|---|---|---|
| Documentation/context | 更新 root README 的包表和内部依赖版本措辞 | README.md 与各 package.json | 使入口文档和实际边界一致 | 减少新人误读 | S | Low | P1 |
| Documentation/context | 升级版本时刷新本导读中的关系和基线 | 本文证据表、inventory.json 的 import 记录 | 避免图中关系脱离源码 | 维持学习资料可信度 | S | Low | P1 |
| Verification/guardrail | 为架构文档增加工作区覆盖和本地链接检查 | 本次清单及现有 check:entry-graphs | 检查文档与入口的一致性，具体行为仍交给测试 | 降低维护资料的成本 | S | Low | P2 |

## 14. Glossary（先认识这些词）

| 术语 | 中文解释 | 代码位置 |
|---|---|---|
| workspace | 同仓库内由包管理器识别的独立包 | package.json |
| provider | 模型服务提供商的认证、目录和请求能力 | ai/src/models.ts |
| stream | 持续产生结果的异步数据流，文字可逐段到达 | ai/src/utils/event-stream.ts |
| toolCall / toolResult | 模型提出的工具调用 / 本地执行后的结果消息 | ai/src/types.ts |
| Agent | 保存内存状态并执行工具循环的对象 | agent/src/agent.ts |
| AgentSession | 编码助手的会话协调层 | coding-agent/src/core/agent-session.ts |
| projection | 根据历史记录计算本次应使用的模型上下文 | coding-agent/src/core/session-manager.ts |
| compaction | 生成摘要并缩短后续模型上下文 | coding-agent/src/core/compaction |
| steer / followUp | 当前运行中插入消息 / 自然结束后再处理的消息 | agent/src/agent.ts |
| JSONL RPC | 一行一个 JSON，通过标准输入输出交换命令和事件 | coding-agent/src/modes/rpc |
| schema | 描述数据形状并用于运行时校验的规则 | schema/src/index.ts |
| contract / host / reference | 合约 / 管理对象的宿主 / 访问对象的引用 | chord/src/index.ts |
| Storage / TaskScheduler | 持久状态适配器 / 调度持久任务的执行器 | durable/src/index.ts |

表中位置省略了公共前缀 packages，实际文件链接见模块表。

## 15. Appendix: Evidence Map（关键结论的源码依据）

| 结论 | 证据 | 置信度 |
|---|---|---|
| 源码 CLI 入口先 setup，再 main | [cli.ts](packages/coding-agent/src/cli.ts) 的 `setupCli()` 与 `main()` 调用 | 高 |
| 模式由显式 mode、print 和 TTY 状态选择 | [main.ts](packages/coding-agent/src/main.ts) 的 `resolveAppMode()` | 高 |
| services 再进入 SDK 创建 session | [agent-session-services.ts](packages/coding-agent/src/core/agent-session-services.ts) 的 `createAgentSessionFromServices()` | 高 |
| SDK 组装 Agent 并注入 ModelRuntime 请求函数 | [sdk.ts](packages/coding-agent/src/core/sdk.ts) 的 `createAgentSession()` | 高 |
| session.prompt 最终启动 agent.prompt | [agent-session.ts](packages/coding-agent/src/core/agent-session.ts) 的 `prompt()`、`_startRun()`、`_prepareRun()` | 高 |
| 工具结果加入上下文并继续循环 | [agent-loop.ts](packages/agent/src/agent-loop.ts) 的 `runLoop()`、`executeToolCalls()` | 高 |
| 工具参数经过 schema 校验 | [agent-loop.ts](packages/agent/src/agent-loop.ts) 的 `prepareToolCallArguments()` 与 [validation.ts](packages/ai/src/utils/validation.ts) 的 `validateToolArguments()` | 高 |
| 事件由 session 接收并追加消息记录 | [agent-session.ts](packages/coding-agent/src/core/agent-session.ts) 的 `_handleAgentEvent()` 与 `appendMessage()` 调用 | 高 |
| 模型上下文从历史投影生成 | [session-manager.ts](packages/coding-agent/src/core/session-manager.ts) 的 `buildSessionProjection()` | 高 |
| 新 ai API 由 Models/Provider 组合 | `packages/ai/src/models.ts:158`、同文件 1028/1077 行 | 高 |
| Durable 模型请求与任务调度 | `packages/durable/src/harness/generation.ts:742`、`packages/durable/src/harness/harness.ts:252` | 高 |
| Durable StoreStorage 连接 Chord Store | `packages/durable/src/storage/store/storage.ts:93` | 高 |
| Env 实现 ExecutionEnv | `packages/env/src/remote-env.ts:354` | 高 |
| 全部包依赖来自 manifest | `docs/learning/pi/inventory.json`，含 manifest 与源码 import 证据 | 高 |

公开导出索引见 [public-api.tsv](docs/learning/pi/public-api.tsv)；CLI、RPC 和条件启用的 HTTP 接口见 [接口附录](docs/learning/pi/INTERFACES.md)。
