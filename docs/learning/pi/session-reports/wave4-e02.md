# 组 e02（coding-agent extensions 示例）

状态：完成

## 完成文件

24 个文件全部完成，均为纯注释新增：`git diff --numstat -- $(cat /tmp/pi-groups/e02.txt)` 合计 1383 行新增、0 行删除，逐个文件均为 `N 0`。原始英文文档、代码、类型、字符串、默认值与缩进未改动；模板字符串内容未插入注释。

- packages/coding-agent/examples/extensions/input-transform-streaming.ts：完整。说明 `input` 事件与 `event.streamingBehavior`，steer 纠正时跳过 `pi.exec("git", ["diff", "--stat"])`，以及 `continue`/`transform` 返回值。核对 `InputEvent`、`InputEventResult`、`ExecResult` 与 `pi.exec` 签名。`test/input-transform-streaming-example.test.ts` 通过。
- packages/coding-agent/examples/extensions/input-transform.ts：完整。说明输入链的三种结果 `continue`/`transform`/`handled`，`?quick` 改写、`ping` 即时回复、`time` 即时时间，以及 `source` 检查。核对 `InputEventResult` 联合与 `ctx.ui.notify` 语义。无独立测试；未实际运行（交互输入示例）。
- packages/coding-agent/examples/extensions/interactive-shell.ts：完整。说明 `user_bash` 拦截用户 `!` 命令、`DEFAULT_INTERACTIVE_COMMANDS` 前缀匹配（含管道后的命令）、`INTERACTIVE_COMMANDS`/`INTERACTIVE_EXCLUDE` 环境变量、`tui.stop()`/`tui.start()` 与 `spawnSync($SHELL, ["-c", ...])` 的终端借出流程。核对 `BashResult` 与 `ctx.ui.custom` 的 `done` 用法。未运行（需要 vim/htop 等真实交互程序）。
- packages/coding-agent/examples/extensions/jev-router.ts：完整。说明虚拟模型 `jev/auto` 的注册、`JevState` 阶段状态、分类器选择 Sol/Terra、首次成功 edit/write 后切 Luna、`modelRegistry.find/findOfType/classify` 与思考级别透传。核对 `ModelRouteRequest`、`ModelRoute`、`registerVirtualModel` 与状态持久化。`test/jev-router-example.test.ts` 通过。
- packages/coding-agent/examples/extensions/mac-system-theme.ts：完整。说明 `osascript` 查询 macOS 深色模式、`ctx.ui.setTheme` 切换、2 秒轮询与 `session_shutdown` 清理 `setInterval`。核对事件生命周期与 `setTheme` 签名。未运行（会实际切换主题并要求系统自动化权限）。
- packages/coding-agent/examples/extensions/message-renderer.ts：完整。说明 `registerMessageRenderer` 的 `customType` 匹配、`info`/`warn`/`error` 着色、展开时显示时间，以及 `/status` 用 `pi.sendMessage` 写入带 `display: true` 的自定义消息。核对 `CustomMessage` 与 `renderer` 参数。未运行（交互 UI）。
- packages/coding-agent/examples/extensions/minimal-mode.ts：完整。说明用 `registerTool` 覆盖七个内置工具的 `renderCall`/`renderResult`，折叠时隐藏输出或只显示计数、`ctrl+o` 展开；不改变工具执行结果。核对 `create*ToolDefinition(cwd)` 与 `Text` 组件。`test/tool-renderer-examples.test.ts` 通过。
- packages/coding-agent/examples/extensions/modal-editor.ts：完整。说明 `ctx.ui.setEditorComponent`、`CustomEditor` 子类、`NORMAL_KEYS` 转义序列映射、插入/Normal 模式切换与 `render` 模式标识。核对 `matchesKey`、`visibleWidth`、`truncateToWidth`（含 `pad` 参数语义）。未运行（交互 UI）。
- packages/coding-agent/examples/extensions/model-status.ts：完整。说明 `model_select` 事件的 `model`/`previousModel`/`source`、`restore` 时跳过通知、`setStatus("model", ...)` 替换页脚片段与 `console.log` 副作用。核对事件处理器返回类型为 `void`。未运行（需要切换模型）。
- packages/coding-agent/examples/extensions/notify.ts：完整。说明 `agent_settled` 触发时机、OSC 777、Kitty OSC 99、WSL PowerShell toast 三种路径及环境变量选择；通知尽力而为、不检查结果。核对 `process.stdout` 写入与 `spawn` 用法。未运行（依赖终端协议与 Windows/WSL）。
- packages/coding-agent/examples/extensions/overlay-qa-tests.ts：完整。说明 13 个 `/overlay-*` 命令、`ctx.ui.custom` 的 `overlay`/`overlayOptions`、锚点/边距/堆叠/百分比/maxHeight/`visible` 回调、`OverlayHandle` 显隐、焦点循环、`nonCapturing`、流式输出与 `truncateToWidth` 的 `pad` 第四参数。核对 `OverlayHandle`、`Component`/`Focusable`、`truncateToWidth` 真实签名。未运行（手动 TUI QA 示例，需逐命令操作）。
- packages/coding-agent/examples/extensions/overlay-test.ts：完整。说明浮层合成、固定 70 列布局、`CURSOR_MARKER` 与 `renderFakeCursor`、`visibleWidth` 宽字符对齐、行内编辑器（Search/Run）与 Enter/Esc 结果。核对 `Focusable` 与光标标记语义。未运行（交互 UI）。
- packages/coding-agent/examples/extensions/permission-gate.ts：完整。说明 `tool_call` 拦截、三个危险 bash 正则、非交互模式直接阻止、交互模式 `ctx.ui.select` 确认与 `{ block: true, reason }` 返回；明确它只看命令字符串、不是沙箱。核对工具调用前置事件与阻塞结果。未运行（交互确认）。
- packages/coding-agent/examples/extensions/pirate.ts：完整。说明模块内 `pirateMode` 开关、`/pirate` 切换，以及 `before_agent_start` 返回 `{ systemPrompt }` 会替换整份系统提示而非自动追加。核对返回值语义。未运行（需要模型调用）。
- packages/coding-agent/examples/extensions/preset.ts：完整。说明 `~/.pi/agent/presets.json` 与 `<cwd>/.pi/presets.json` 的读取/合并（项目覆盖全局）、`applyPreset` 的 `setModel`/`setThinkingLevel`/`setActiveTools`、`setModel` 返回 false 或抛错的差异、`appendEntry` 恢复预设名、`before_agent_start` 注入 instructions。核对相关签名与异常路径。未运行（需要预设文件与模型调用）。
- packages/coding-agent/examples/extensions/project-trust.ts：完整。说明 `project_trust` 的三态返回 `trusted: "yes" | "no" | "undecided"`、可选的 `remember`、非交互分支与 `session_start` 提示；`loadCount` 是模块加载次数而非事件次数。核对事件结果联合。未运行（需要项目资源与信任流程）。
- packages/coding-agent/examples/extensions/prompt-customizer.ts：完整。说明 `before_agent_start` 中直接修改 `systemPromptOptions.sections.tool_guidance`、按 `selectedTools`/`skills` 生成规则、无匹配时删除该段，以及宿主统一渲染而不是由扩展替换整份提示。核对 `NormalizedBuildSystemPromptOptions`。未运行（需要模型调用）。
- packages/coding-agent/examples/extensions/protected-paths.ts：完整。说明 `tool_call` 中对 `write`/`edit` 的 `path` 做子串匹配（`.env`、`.git/`、`node_modules/`）、`ctx.ui.notify` 与 `{ block: true, reason }`；明确不解析真实路径/符号链接。核对事件字段。未运行（交互调用）。
- packages/coding-agent/examples/extensions/provider-payload.ts：完整。说明 `before_provider_request`/`after_provider_response` 两个观察钩子、`appendFileSync` 写 `<cwd>/.pi/provider-payload.log`、不创建目录、异常向外传播，以及日志可能包含完整对话和敏感数据。核对事件字段与文件副作用。未运行（会写日志并需要真实请求）。
- packages/coding-agent/examples/extensions/qna.ts：完整。说明 `/qna` 从当前分支反向查找最后一条 `stopReason === "stop"` 的 assistant 文本、`BorderedLoader` 可取消等待、`modelRegistry.complete` 带 `signal`、提取结果写入 `setEditorText`，以及 `null` 同时表示取消与失败。核对 `getBranch`、`UserMessage`、`complete` 签名。未运行（会产生模型调用）。
- packages/coding-agent/examples/extensions/question.ts：完整。说明 `question` 工具的 typebox schema、`executionMode: "sequential"`、非 TUI/空选项拒绝、选项列表与自由输入的 UI 状态机、`details` 断言与 `renderCall`/`renderResult`。核对 `ToolDefinition`、`execute` 参数与 `Editor`/`wrapTextWithAnsi`。未运行（交互 UI）。
- packages/coding-agent/examples/extensions/questionnaire.ts：完整。说明多问题分页、Submit 页、`allowOther` 占位项、自由输入、`details` 与结果渲染；文件头明确答案只在本轮工具结果/界面中使用，不额外发送到模型。核对 schema、`ctx.ui.custom` 与按键分支。未运行（交互 UI）。示例自身在 `options=[]` 且 `allowOther=false` 时存在 `undefined.isOther` 的 TypeError（注释已指出，未改行为）。
- packages/coding-agent/examples/extensions/rainbow-editor.ts：完整。说明 `CustomEditor` 子类对 `ultrathink` 的检测、24 位真彩色 ANSI 着色、60ms 动画帧与 `requestRender`、`render` 后处理以及 `getText` 仍为纯文本。核对定时器生命周期与 `visibleWidth`。未运行（交互 UI）。
- packages/coding-agent/examples/extensions/reload-runtime.ts：完整。说明 `/reload-runtime` 命令的 `ctx.reload()`、`reload_runtime` 工具因无命令上下文且运行中不能重载而返回 `terminate`、`agent_settled` 后通过 `pi.sendUserMessage("/reload-runtime", { expandPromptTemplates: true })` 触发重载，以及重载使旧扩展实例失效。核对 `ExtensionCommandContext.reload`、`terminate` 语义与 `sendUserMessage` 选项。未运行（重载会替换扩展运行时，需要交互会话）。

验证：

- `git diff --numstat -- $(cat /tmp/pi-groups/e02.txt)`：24 个文件，1383 行新增、0 行删除；每个文件单独为 `N 0`，无原始行出现在删除侧。
- 24 个文件逐个用本地 esbuild 做 TS 语法转换（`--loader:.ts=ts`）：全部通过。
- 对 HEAD 版本与当前版本分别执行 `esbuild --format=esm --minify`，24 个文件的压缩产物逐字节相同：证明只增加了注释/空白，代码语义与模板字符串内容均未改变。
- 直接引用本组文件的三组 vitest 用例通过：`test/jev-router-example.test.ts`、`test/input-transform-streaming-example.test.ts`、`test/tool-renderer-examples.test.ts`，共 3 个文件、11 个测试。
- 24 个文件均确认含“文件导读”、能力清单、运行/典型顺序、真实签名示例与阅读顺序；原英文文档块保留。
- 未运行 `npm run check`、`npm run build`、仓库级格式化，也未执行任何 `git add/commit/push` 或 `npm install`（任务说明禁止）。

## 未修改的数据/配置文件

- 本组分配文件全部是 `.ts` 示例，没有 JSON、YAML、`package.json`、`tsconfig.json` 或其他配置文件；未修改任何数据/配置文件。
- `preset.ts` 运行时读取 `~/.pi/agent/presets.json` 与 `<cwd>/.pi/presets.json`，本组未创建或修改这些文件；缺失/非法配置的行为已在注释中说明。
- `provider-payload.ts` 运行时会写 `<cwd>/.pi/provider-payload.log`，本次注释过程未执行该示例，未产生该文件。
- 其他运行时输入：`jev-router.ts` 需要 `TYPESAFE_API_KEY` 与 OpenAI Codex 登录；`interactive-shell.ts` 读取 `INTERACTIVE_COMMANDS`/`INTERACTIVE_EXCLUDE`；`notify.ts` 依赖终端/`WSL_DISTRO_NAME` 等环境。均只读，未修改。
- 未修改 `docs/learning/pi/study-coverage.json`、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md`、其他组文件或报告。

## 未完成或风险

- 未实际运行交互式 TUI 示例：overlay-qa-tests、overlay-test、question、questionnaire、modal-editor、rainbow-editor、message-renderer、interactive-shell 等需要真实终端、逐键操作或交互式子进程，无法在离线批处理中验证运行时输出。
- 未运行会产生模型调用或费用的示例：qna、question、questionnaire、preset、pirate、prompt-customizer、jev-router、reload-runtime 的端到端路径。jev-router 的专用测试用 faux provider 覆盖了路由逻辑并通过；其余没有等价自动化入口。
- mac-system-theme 会实际切换 pi 主题并调用 macOS System Events；notify 依赖具体终端协议；provider-payload 会写项目日志。均只做静态核对，未执行。
- questionnaire 示例自身存在空选项 TypeError（`options=[]` 且 `allowOther=false`）；按“只加注释、不改行为”的要求仅记录，未修复。
- 未做 TypeScript 类型检查（任务禁止 `npm run check`），因此不能声称类型层面无误；纯注释新增不改变类型，且压缩产物逐字节一致，降低了语义风险。esbuild 也不会把模板字面量内部的 `//` 当注释，已用压缩产物对比确认模板内容未变。
- overlay-qa-tests.ts 篇幅大（约 1700 行），注释依据完整 diff 与关键组件实现核对；没有自动化测试覆盖该手动 QA 示例。
- 注释增加了行号；未发现仓库测试按行号引用这些示例（测试均按路径/import 加载）。若外部文档引用固定行号，需要后续同步。
