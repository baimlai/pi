# Pi 接口与边界清单

这份清单区分“调用 Pi 的入口”和“Pi 调用外部能力的出口”。包级公开路径和声明索引见 [inventory.json](inventory.json)、[public-api.tsv](public-api.tsv)。源码链接指向当前检出的文件。

## CLI 和 SDK

| 入口 | 行为 | 实现 |
|---|---|---|
| pi 与位置参数、@file | 创建或恢复 session 并运行 | [main](../../../packages/coding-agent/src/main.ts)，[参数解析](../../../packages/coding-agent/src/cli/args.ts) |
| 默认交互模式 | 终端输入、流式显示、命令和 UI | [InteractiveMode](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) |
| -p / --print；--mode json | 一次性文本或 JSON 事件输出 | [runPrintMode](../../../packages/coding-agent/src/modes/print-mode.ts) |
| --mode rpc | stdin/stdout JSONL 控制与事件 | [runRpcMode](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) |
| install/remove/uninstall/update/list | 包安装、移除、更新和列表 | [handlePackageCommand](../../../packages/coding-agent/src/package-manager-cli.ts) |
| config | 配置资源选择 | [handleConfigCommand](../../../packages/coding-agent/src/package-manager-cli.ts) |
| auth check/print-api-key/print-bearer-token | 检查认证或提供凭据 | [auth-command](../../../packages/coding-agent/src/cli/auth-command.ts)，[main](../../../packages/coding-agent/src/main.ts) |
| mcp add/remove/list/login/logout | 配置和认证 MCP server | [MCP CLI](../../../packages/coding-agent/src/extensions/mcp/cli.ts) |
| createAgentSession | 在自己的程序中创建 session | [SDK](../../../packages/coding-agent/src/core/sdk.ts) |
| pi-ai login / list | 开发用提供商认证 CLI | [ai CLI](../../../packages/ai/src/cli.ts) |

常用 flags 按用途分组：模型 provider/model/models/thinking；会话 continue/resume/session/session-id/fork/session-dir/no-session/name；工具 tools/exclude-tools/no-tools/no-builtin-tools；资源 extension/skill/prompt-template/theme 及各自禁用项；运行 offline/mode/print/export/list-models/help/version。完整参数及扩展 flag 处理以 args.ts 为准。

approve/no-approve 控制项目资源信任，不应理解为操作系统工具权限沙箱。CLI 启动不需要 HTTP 登录，但模型调用需要相应认证。

## RPC 的全部命令

命令由 [RpcCommand 联合类型](../../../packages/coding-agent/src/modes/rpc/rpc-types.ts) 定义，[rpc-mode.ts](../../../packages/coding-agent/src/modes/rpc/rpc-mode.ts) 的 handleCommand 分派。

| 类别 | 命令 |
|---|---|
| 输入与队列 | prompt、steer、follow_up、abort、clear_queue |
| 会话 | new_session、switch_session、fork、clone、set_session_name |
| 模型 | set_model、cycle_model、get_available_models |
| 思考级别 | set_thinking_level、cycle_thinking_level、get_available_thinking_levels |
| 排队策略 | set_steering_mode、set_follow_up_mode |
| 压缩与重试 | compact、set_auto_compaction、set_auto_retry、abort_retry |
| Shell | bash、abort_bash |
| 查询与导出 | get_state、get_session_stats、export_html、get_fork_messages、get_entries、get_tree、get_last_assistant_text、get_messages、get_commands |

请求是一行 JSON，例如：

```json
{"id":"request-1","type":"prompt","message":"读取 README.md 并解释它"}
```

输出包括 response、AgentSessionEvent、extension_error 和 extension_ui_request。扩展 UI 请求可支持 select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set_editor_text，客户端用 extension_ui_response 回应；并不是所有自定义 TUI 组件都能在 RPC 中显示。

基础事件有 agent_start/end、turn_start/end、message_start/update/end、tool_execution_start/update/end。session 另外提供队列、条目、压缩、自动重试和 agent_settled 等事件，详见 [AgentSessionEvent](../../../packages/coding-agent/src/core/agent-session.ts)。本地标准输入输出没有额外的协议认证层。

## 普通工具和扩展工具

| 普通工具 | 职责 | 定义 |
|---|---|---|
| read | 读取文件 | [read.ts](../../../packages/coding-agent/src/core/tools/read.ts) |
| bash | 执行 shell 命令 | [bash.ts](../../../packages/coding-agent/src/core/tools/bash.ts) |
| powershell | 执行 PowerShell 命令 | [powershell.ts](../../../packages/coding-agent/src/core/tools/powershell.ts) |
| edit | 定位并替换文件内容 | [edit.ts](../../../packages/coding-agent/src/core/tools/edit.ts) |
| write | 写入文件 | [write.ts](../../../packages/coding-agent/src/core/tools/write.ts) |
| grep | 搜索文件内容 | [grep.ts](../../../packages/coding-agent/src/core/tools/grep.ts) |
| find | 查找文件 | [find.ts](../../../packages/coding-agent/src/core/tools/find.ts) |
| ls | 列出目录 | [ls.ts](../../../packages/coding-agent/src/core/tools/ls.ts) |

createCodingTools 默认组合 read/bash/edit/write，createReadOnlyTools 组合 read/grep/find/ls；这是工厂组合，不等于每个用户最终启用的工具集合。

内置扩展入口见 [extensions/index.ts](../../../packages/coding-agent/src/extensions/index.ts)：llama.cpp、codemode、tool-search、MCP。codemode 的 code 参数承载待执行代码；tool_search 搜索 deferred 工具；MCP 注册动态 mcp__ 工具和 list_mcp_resources、list_mcp_resource_templates、read_mcp_resource。ask_question 只在 help 示例中出现，未据此列为已实现内置工具。

[ExtensionAPI](../../../packages/coding-agent/src/core/extensions/types.ts) 包含事件订阅、工具/命令/快捷键/flag/渲染器注册、消息与条目追加、模型与 provider 注册、工具启用集合、MCP server 注册等接口。动态注册能力的数量依赖加载的扩展和外部 server，不能用仓库中的固定列表穷尽。

## MCP 是向外接工具的客户端

[McpClient](../../../packages/mcp/src/client.ts) 提供 connect、request、notify、listTools、callTool、listResources、listResourceTemplates、readResource、ping、close，以及通知和反向请求处理。

支持 stdio 和 Streamable HTTP。HTTP transport 可接 AuthProvider/OAuth。OAuth 有临时 loopback callback listener，默认路径 /callback，包含 state 校验；它不是 Pi 常驻业务 Web 服务。实现见 [callback.ts](../../../packages/mcp/src/oauth/callback.ts)。

## Chord HTTP 由应用选择启用

[createHttp](../../../packages/chord/src/node/http/http.ts) 组合路由、认证、WebSocket 链接和 Node listener。业务路由由 HttpContribution 贡献；默认路由要求 principal，public 和 crossSite 有不同规则。链接路径可配置，不能据示例猜一个固定 WebSocket URL。

app kit 自带以下路由，**仅在应用启用对应 facet 后存在，不是 Pi CLI 默认监听的端点**：

| 方法与路径 | 认证或条件 | 定义 |
|---|---|---|
| POST /_chord/login | public，临时身份登录 | [ephemeral.ts](../../../packages/chord/src/node/app/ephemeral.ts) |
| POST /_chord/invites | owner | [invite.ts](../../../packages/chord/src/node/app/invite.ts) |
| GET /_chord/invite | public 页面 | 同上 |
| POST /_chord/invite | public，加一次性 token | 同上 |
| GET /_chord/owner | public 页面 | [owner.ts](../../../packages/chord/src/node/app/owner.ts) |
| POST /_chord/owner | public，加一次性 owner token | 同上 |
| POST /_chord/pair | public，受配对规则限制 | [pairing.ts](../../../packages/chord/src/node/app/pairing.ts) |
| POST /_chord/pair/poll | public，加 poll secret | 同上 |
| GET /_chord/pair/:code | owner | 同上 |
| POST /_chord/pair/:code | owner | 同上 |

客户端 surface 还提供资源路由：

- Web：GET /_chord/web/:file、/_chord/web/plugin/:file、/_chord/web/assets/:file、/_chord/web/base，以及可配置页面路径；base public，其余受 options.public 影响。见 [web.ts](../../../packages/chord/src/node/surfaces/web.ts)。
- TUI：GET /_chord/tui/start、/_chord/tui/base、/_chord/tui/:file、/_chord/tui/plugin/:file；base public，其他要求 principal。见 [tui.ts](../../../packages/chord/src/node/surfaces/tui.ts)。

这里列出仓库内置的条件路由和动态路由边界；应用自己的插件路由、配置页面路径、WebSocket 路径以及第三方扩展必须在目标应用中继续盘点。
