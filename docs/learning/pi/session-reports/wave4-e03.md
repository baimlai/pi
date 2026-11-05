# 组 e03（coding-agent extensions 示例）

状态：完成

## 完成文件

26 个文件全部完成，均为纯注释新增（`git diff --numstat` 全部为 `N 0`），原始英文文档、代码、类型、字符串、默认值与缩进未改动。

- packages/coding-agent/examples/extensions/rpc-demo.ts：完整。说明 RPC 模式下的扩展 UI 协议演示，上游 `pi --mode rpc -e ./rpc-demo.ts`，下游只调用 ExtensionAPI 与 ctx.ui；逐段解释 UI 请求/响应、事件推送与 RPC 宿主配合方式。核对 ExtensionAPI、ExtensionUIContext 的真实方法签名。
- packages/coding-agent/examples/extensions/send-user-message.ts：完整。说明 `/ask`、`/steer`、`/followup`、`/askwith` 以用户身份注入消息；解释 `pi.sendUserMessage()`、`ctx.isIdle()` 与 stream/queue 选项的时机差异。核对 `sendUserMessage` 与 `SendUserMessageOptions`。
- packages/coding-agent/examples/extensions/session-name.ts：完整。说明会话元数据命令；解释 `pi.getSessionName()`/`setSessionName()` 与参数缺省时的行为。核对签名。
- packages/coding-agent/examples/extensions/shutdown-command.ts：完整。说明 `/quit` 与 `finish_and_exit`/`deploy_and_exit` 工具；解释 `ctx.shutdown()` 的有序退出语义与工具结果返回。核对 ExtensionContext.shutdown。
- packages/coding-agent/examples/extensions/snake.ts：完整。说明会话存档驱动的终端贪吃蛇；逐段解释 Direction/Point/GameState、spawnFood、SnakeComponent 的 tick/渲染/输入、`/snake` 命令的 getEntries 反向扫描与 appendEntry 存档。核对 Component 接口、matchesKey、visibleWidth、appendEntry。
- packages/coding-agent/examples/extensions/space-invaders.ts：完整。说明太空侵略者：常量、Bullet/Alien/Shield/GameState、碰撞检测、isKeyRelease 暂停/存档/重开、渲染分区与 `/invaders` 存档恢复。核对 TUI 组件接口与键位 API。
- packages/coding-agent/examples/extensions/ssh.ts：完整。说明用 SSH 转发 read/write/edit/bash 四个内置工具到远程主机；解释 `--ssh` flag 解析、本地工具回退、四个 `registerTool` 覆盖、user_bash 与 before_agent_start 系统提示替换。核对 spawn、registerFlag/getFlag、ToolDefinition。
- packages/coding-agent/examples/extensions/status-line.ts：完整。说明页脚状态栏；解释 session_start/turn_start/turn_end 驱动的 `setStatus` 更新与主题着色。核对 setStatus 语义（undefined 清除）。
- packages/coding-agent/examples/extensions/structured-output.ts：完整。说明终止型工具结果；解释工具返回 `terminate: true` 后 Agent 循环不再追加模型请求，以及参数 schema 与 details。核对 ToolDefinition.execute 返回值与 terminate 字段。
- packages/coding-agent/examples/extensions/summarize.ts：完整。说明 `/summarize` 手动总结；解释 getBranch 读取、模型解析/鉴权检查/complete 调用、自定义 Markdown 摘要 UI 的布局。核对 modelRegistry.find/hasConfiguredAuth/complete 的真实签名。
- packages/coding-agent/examples/extensions/system-prompt-header.ts：完整。说明读取有效系统提示；解释 agent_start/session_shutdown 事件与 `ctx.getSystemPrompt()` 的调用时机。核对事件类型。
- packages/coding-agent/examples/extensions/tic-tac-toe.ts：完整。说明人机井字棋与 `executionMode: "sequential"`；逐段解释状态重建、胜负判定、ASCII/彩色棋盘渲染、消息渲染器、两个工具与回合驱动。核对 ToolExecutionMode、registerMessageRenderer、before_agent_start。
- packages/coding-agent/examples/extensions/timed-confirm.ts：完整。说明带超时的 confirm/select/signal 对话框；解释 AbortSignal 与超时竞态、notify 结果。核对 ctx.ui.confirm/select 签名。
- packages/coding-agent/examples/extensions/titlebar-spinner.ts：完整。说明终端标题动画；解释 agent_start 启动、agent_settled/session_shutdown 停止并恢复静态标题、setInterval 清理。核对 setTitle 与事件。
- packages/coding-agent/examples/extensions/todo.ts：完整。说明会话条目做状态管理；解释 todo 工具 list/add/toggle/clear、TodoListComponent 的按键与宽度处理、`/todos` 自定义列表。核对 Component、matchesKey、truncateToWidth、getBranch 条目形状。
- packages/coding-agent/examples/extensions/tool-override.ts：完整。说明以同名 `read` 覆盖内置工具；解释日志写入 getAgentDir() 下文件、参数校验与返回结构。核对 ToolDefinition 与 fs/promises。
- packages/coding-agent/examples/extensions/tools.ts：完整。说明 `/tools` 交互式启停工具；解释 enabledTools/allTools 闭包、persistState/applyTools、restoreFromBranch 的分支扫描与过滤、SettingsList 构建与 onChange。核对 getAllTools/getActiveTools/setActiveTools/appendEntry、SettingsList 构造参数与 Component 接口。注：文件头在中国导读之后保留原英文 Tools Extension 文档块。
- packages/coding-agent/examples/extensions/trigger-compact.ts：完整。说明按上下文用量触发压缩；解释 turn_end 读取 getContextUsage、阈值判断、`ctx.compact()` 的 onComplete/onError 与 `/trigger-compact` 手动路径。核对 CompactOptions。
- packages/coding-agent/examples/extensions/truncated-tool.ts：完整。说明自定义 rg 工具的输出截断；解释 execSync、truncateHead/DEFAULT_MAX_LINES/DEFAULT_MAX_BYTES/formatSize、完整输出写临时目录与 renderResult 展示。核对 truncate 模块导出与 ToolDefinition。
- packages/coding-agent/examples/extensions/widget-placement.ts：完整。说明编辑器周边挂件；解释 setWidget 的 key、内容工厂与 placement 选项、session_start 应用与清理。核对 WidgetPlacement 与 setWidget 签名。
- packages/coding-agent/examples/extensions/working-indicator.ts：完整。说明流式工作指示器；解释 setWorkingIndicator 选项、模式切换与页脚状态同步。核对真实签名。
- packages/coding-agent/examples/extensions/working-message-test.ts：完整。说明工作提示的持久性测试场景；解释 setWorkingMessage 的设置与清除时机。核对签名。
- packages/coding-agent/examples/extensions/plan-mode/index.ts：完整。说明计划模式全流程；逐段解释工具白名单、PlanModeState、`--plan` flag、工具集合切换、`/plan` 与 `/todos`、Ctrl+Alt+P、bash 拦截、上下文过滤、before_agent_start 提示注入（未插入模板字符串内部）、turn_end 进度、agent_end 提取/执行/细化、session_start 恢复。核对 ExtensionAPI 事件、setActiveTools、appendEntry、registerShortcut 与 DEFAULT_APP_KEYBINDINGS 相关键位 API。
- packages/coding-agent/examples/extensions/plan-mode/utils.ts：完整。说明纯函数模块；逐条解释 DESTRUCTIVE_PATTERNS/SAFE_PATTERNS 的子串与锚定差异、isSafeCommand 双条件、TodoItem、cleanStepText、extractTodoItems、extractDoneSteps、markCompletedSteps。核对正则行为与类型。
- packages/coding-agent/examples/extensions/subagent/agents.ts：完整。说明 Markdown 代理发现；解释 AgentScope/AgentConfig、parseToolList 两种 YAML 写法、loadAgentsFromDir 容错、findNearestProjectAgentsDir 向上查找、discoverAgents 的 Map 覆盖顺序、formatAgentList。核对 getAgentDir、CONFIG_DIR_NAME、parseFrontmatter 签名。
- packages/coding-agent/examples/extensions/subagent/index.ts：完整。说明子代理工具；逐段解释常量、formatTokens/formatUsageStats/formatToolCall、结果与 details 类型、getFinalOutput/isFailedResult/getResultOutput/截断/条目提取、mapWithConcurrencyLimit、临时提示词写入、getPiInvocation、runSingleAgent（JSON 行解析、message_end 用量累计、tool_result_end、stdout 缓冲、stderr、close/error、abort SIGTERM/SIGKILL、finally 清理）、TaskItem/ChainItem/AgentScopeSchema/SubagentParams、execute 三模式（模式计数、项目代理确认、chain 的 {previous}、parallel 占位与并发、single）、renderCall 与 renderResult 的折叠/展开分支。核对 spawn、AbortSignal、TypeBox、StringEnum、Container/Markdown/Text/Spacer 与 getMarkdownTheme。

验证：

- `git diff --numstat -- $(cat /tmp/pi-groups/e03.txt)`：26 个文件，合计 1767 行新增、0 行删除；逐个检查新增内容均为中文注释或空行，未改动原始代码行。早期一次误改 `makeDetails` 参数类型已在同一会话内还原，最终 diff 无删除行可证。
- 对 26 个文件逐个运行本地 esbuild 语法转换（`node_modules/.bin/esbuild <file> --loader:.ts=ts --outfile=/tmp/...`）：全部通过，无语法错误。
- 每个文件均确认含“文件导读”中文头，且原英文文档块保留。
- 未运行 `npm run check`、`npm run build`、仓库级格式化或任何测试（任务说明禁止）；也未执行这些示例，因为它们需要 pi 运行时、TUI 或真实模型调用与费用。

## 未修改的数据/配置文件

- 本组分配文件全部是 `.ts` 源码示例，没有 JSON、YAML 或配置文件；未修改任何数据/配置文件。
- 未修改 docs/learning/pi/study-coverage.json、STUDY_PROGRESS.md、STUDY_LOG.md、SESSION_PLAN.md，也未修改其他组的文件或报告。
- subagent 示例的代理定义是 Markdown 文件，运行时才读取；本组未新增或修改这些定义文件。

## 未完成或风险

- 仅做了语法级检查（esbuild transform），未做 TypeScript 类型检查；`npm run check` 按任务要求未运行，因此不能声称类型无误。注释为纯新增，理论上不影响类型，但新增注释若位于表达式链中间仍可能影响 ASI 等极端语法；esbuild 解析通过降低了该风险。
- 未实际运行任何示例：大部分需要交互式 TUI，subagent/summarize/trigger-compact 等会产生真实模型调用与费用；无法在离线环境验证运行时输出。
- 注释增加了行号，若文档或测试引用这些示例的固定行号会失配；已检索本组文件未发现自引用固定行号，仓库测试也未引用这些示例文本。
- 模板字符串内部未插入注释；这一点为人工核对（esbuild 不会把模板内部的 `//` 当注释，因此语法检查无法覆盖），已逐文件检查编辑位置在模板之外。
