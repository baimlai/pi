# 组 e05

状态：完成（28 个分配文件当前均含“文件导读”；其中 25 个由本组直接改写，3 个 JSON/JSONC 配置在复核期间出现外部注释写入，本组已核对，见下）

## 完成文件

共同验证：工作区 28 个分配文件合计新增 1300 行、删除 0 行；其中本组直接改写 25 个文件（新增 1279 行），另外 3 个配置（`tsconfig.json` 与两份 `wrangler.jsonc`）在复核期间由外部写入“文件导读”（各新增 7 行，共 21 行，均为注释、无删除），本组未生成这些改动但已复核内容。28 个文件当前全部含“文件导读”。21 个由本组改写的 TypeScript 文件通过 `node_modules/.bin/esbuild <files> --format=esm` 解析；`pi-test.sh`、`test.sh` 通过 `bash -n`；`git diff --check` 在本组路径范围内无输出。未运行需要模型、网络、Windows 或 Cloudflare 部署的示例，原因见“未完成或风险”。

- packages/coding-agent/examples/sdk/01-minimal.ts：完整；核对 `createAgentSession()` 的默认发现/模型选择、`session.subscribe` 的两层事件收窄、`prompt` 与 `dispose`；说明真实模型请求和默认会话落盘；esbuild 解析通过，未运行（费用/凭证）。
- packages/coding-agent/examples/sdk/02-custom-model.ts：完整；核对 `ModelRuntime.create/getModel/getAvailable`、`thinkingLevel`、内置目录与 `models.json` 两条查找路径；说明认证检查可能包含供应商自定义 I/O，不能保证查询绝不访问网络；esbuild 解析通过，未运行（无可用模型时会报错，运行会请求模型）。
- packages/coding-agent/examples/sdk/03-custom-prompt.ts：完整；核对 `DefaultResourceLoader` 的 `systemPromptOverride`、`appendSystemPromptOverride`、`reload()`，以及 `SessionManager.inMemory()`；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/04-skills.ts：完整；核对 `skillsOverride` 的过滤/追加、`Skill` 字段与 `createSyntheticSourceInfo`；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/05-tools.ts：完整；核对 `tools` 允许名单、`+name`/`-name` 修饰符与“只含修饰符才相对默认工具、混用会报错”的规则、通配符和 MCP 工具可见性；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/06-extensions.ts：完整；核对 `extensionFactories`、`ExtensionAPI.registerTool`、扩展事件拦截与 `DefaultResourceLoader.reload()`；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/07-context-files.ts：完整；核对 `agentsFilesOverride` 输入/返回形状、`getAgentsFiles()` 和 `reload()`；明确指出原英文“返回空列表可禁用”与示例实际“追加”不一致，真正禁用应返回 `{ agentsFiles: [] }`；说明 `discovered.length + 1` 会重复计数；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/08-prompt-templates.ts：完整；核对 `promptsOverride`、`PromptTemplate` 字段、`createSyntheticSourceInfo`；限定 `AgentSession.prompt` 默认展开模板，而 `sendUserMessage` 默认不展开；说明示例计数表达式重复计数；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts：完整；核对 `ModelRuntime.create({ authPath, modelsPath })`、`setRuntimeApiKey` 的进程内临时覆盖与 `await`、`SessionManager.inMemory()`；说明占位 key 不能当作真实凭证；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/10-settings.ts：完整；核对 `SettingsManager.create/inMemory/applyOverrides/getGlobalSettings/getSettings/setDefaultThinkingLevel/flush/drainErrors`；纠正 `getGlobalSettings()` 只返回用户层而非合并视图；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/11-sessions.ts：完整；核对 `SessionManager.inMemory/create/continueRecent/list/open`，说明 `create` 的文件路径是惰性创建、`continueRecent` 无历史时新建；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/12-full-control.ts：完整；核对自定义 `ResourceLoader`、`createExtensionRuntime()` 的未初始化动作桩、`getModel` from `pi-ai/compat`、显式工具名单与内存设置/历史；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/13-session-runtime.ts：完整；核对 `CreateAgentSessionRuntimeFactory`、`createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime` 与 `newSession/switchSession/dispose` 后重新绑定 `runtime.session`；esbuild 解析通过，未运行。
- packages/coding-agent/examples/sdk/14-codemode-mcp.ts：完整；核对 `createCodemodeExtension/createToolSearchExtension/createMcpExtension`、`defaultTools: ["+codemode", "+tool_search"]` 修饰符、`bindExtensions({})` 触发后台 MCP 连接、`getActiveToolNames()` 的时序差异；说明会请求真实模型；esbuild 解析通过，未运行。
- packages/coding-agent/examples/rpc-client.ts：完整；对照 `packages/coding-agent/src/modes/rpc/rpc-client.ts` 核对 `RpcClient` 构造、`onEvent` 退订、`start`、`promptAndWait` 默认 60 秒超时、`stop` 的 SIGTERM→约 1 秒→SIGKILL；说明 spawn 的是构建后的 `dist/cli.js`；esbuild 解析通过，未运行（需构建产物和真实模型）。
- packages/coding-agent/examples/rpc-extension-ui.ts：完整；核对 TUI 组件 `OutputLog/LoadingIndicator/PromptInput/SelectDialog/InputDialog`、`ProcessTerminal/TuiMainScreen`、扩展 UI 的 request/response 与 `notify/setStatus/setWidget/set_editor_text` 通知、`StringDecoder` 分块按行解析、斜杠命令与子进程退出处理；esbuild 解析通过，未运行（交互式终端 + 真实模型）。
- packages/codemode/examples/cloudflare/agent/src/index.ts：完整；核对 `Env.SESSION`/`Env.CODEMODE_SANDBOX` 绑定、`Session.runCodemode` 中的 `RemoteCodemodeSandbox`、POST-only `fetch` 与 405、HTTP 200 内 `ok:false` 的错误形状、内存计数；说明 `script_name` 才让脚本运行在独立 Worker；esbuild 解析通过，未部署。
- packages/codemode/examples/cloudflare/sandbox/src/index.ts：完整；核对 `CodemodeSandboxDurableObject as CodemodeSandbox` 重导出、仅绑定可访问、`fetch` 固定 404、Worker 名必须匹配 agent 的 `script_name`、`cpu_ms` 是每请求 CPU 额度而非墙钟超时；esbuild 解析通过，未部署。
- packages/agent/examples/mcp-codemode/main.ts：完整；核对 `createModels/setProvider/getModel`、`McpClient`+`StdioTransport`、`ANTHROPIC_API_KEY`、stdio 服务器命令参数、codemode 嵌套工具执行与真实模型费用；esbuild 解析通过，未运行（会启动外部 MCP 进程并请求付费模型）。
- packages/agent/examples/mcp-codemode/tools.ts：完整；核对 `toToolName`、`textOf`、`createMcpTools`、`createNestedToolRunner`、`CODEMODE_TOOL_NAME`、`createCodemodeTool`，以及 `runToolCall` 复用 Agent 管线、`renderDeclarations`、`obj/str`、120 秒沙箱超时；说明无独立入口、名称冲突风险和错误映射；esbuild 解析通过，未运行。
- pi-test.sh：完整；核对 `--no-env` 的逐个 `unset`、`node -p pathToFileURL` 生成 resolver file URL、`--import` 预处理器、bash 3.2 的 `${ARGS[@]+"${ARGS[@]}"}` 空数组写法、退出码透传；`bash -n` 通过，未执行（会启动源码 CLI，可能读取/写入用户配置）。
- pi-test.ps1：完整；核对参数拆分、`--no-env` 变量表（仅覆盖到 `AZURE_OPENAI_RESOURCE_NAME`，少于 .sh）、`System.Uri` 转 file URL、`& node ... @forwardArgs` 与 `$LASTEXITCODE` 传播；静态复读通过，未执行（当前为 macOS，无 Windows PowerShell）。
- pi-test.bat：完整；核对 `%~dp0`、`where` + `errorlevel` 检测、`-NoProfile -ExecutionPolicy Bypass -File`、`%*` 转发与 `exit /b %ERRORLEVEL%`；静态复读通过，未执行（当前为 macOS，无 cmd.exe）。
- test.sh：完整；核对临时根目录与所有权标记、`cleanup` 的路径/符号链接/标记三层校验、`trap - EXIT` 防递归、白名单环境变量、`env -i` 执行 `npm test`；说明 EXIT trap 无法捕获 SIGKILL；`bash -n` 通过，未执行（会运行完整的 `npm test`，本任务禁止）。
- vitest.base.ts：完整；核对 `workspaceSourcePaths` 的 `import.meta.url` 绝对路径、`as const`、alias 数组顺序、`(.+)`→`$1.ts` 通配替换、`codingAgentIndex` 故意不默认别名；确认消费方为 coding-agent/evals 的 vitest 配置；esbuild 解析通过，未运行测试。

## 未修改的数据/配置文件

以下 3 个文件本组自身没有修改；复核期间它们被并发写入“文件导读”（仅新增注释，0 删除），当前内容已核对。

- packages/coding-agent/examples/tsconfig.json：TypeScript 配置文件，extends 根 `tsconfig.json`，用 `paths` 把示例导入映射到工作区源码（`@earendil-works/pi-ai` 指向 extension view），`include` 覆盖 `extensions/**/*`、声明文件和 subagent 回归测试。由根 `npm run check` 中的 `tsc --noEmit -p packages/coding-agent/examples/tsconfig.json` 读取。任务明确把 `tsconfig.json` 列为禁止改写，因此本组未加中文注释；复核时外部已加入 7 行文件导读。
- packages/codemode/examples/cloudflare/agent/wrangler.jsonc：Wrangler 部署配置，读取方为 `wrangler deploy`；定义 Worker 名称/入口/兼容日期、`SESSION` 与 `CODEMODE_SANDBOX` Durable Object 绑定、`script_name: pi-codemode-sandbox` 和 v1 迁移。它是 JSONC，文件内已有中文行注释（提交 `512bfbe1b`），复核时外部又加入 7 行文件导读；本组按“JSON/JSONC 配置不改写”的规则未修改。其与源码的分工也写在同目录 `src/index.ts` 文件头。
- packages/codemode/examples/cloudflare/sandbox/wrangler.jsonc：Wrangler 部署配置，读取方为 `wrangler deploy`；定义沙箱 Worker 名称（必须与 agent 的 `script_name` 一致）、入口、关闭 `workers_dev`/`preview_urls`、v1 迁移和 `cpu_ms: 60000`。已有中文行注释，复核时外部又加入 7 行文件导读；本组未修改。用途也写在同目录 `src/index.ts` 文件头。

## 未完成或风险

- 运行验证限制：SDK 示例 01/02/03/06/09/12/14、`rpc-client.ts`、`rpc-extension-ui.ts`、agent 的 `mcp-codemode` 示例会请求真实模型并产生费用；RPC 示例还要求先构建出 `dist/cli.js`，`rpc-extension-ui.ts` 需要交互式终端。因此只做了静态解析和签名核对，没有声称运行通过。
- Cloudflare 示例需要 Wrangler 登录、部署两个 Worker 并具备 Durable Objects 配额；未部署，只核对了源码与配置绑定关系。
- `pi-test.ps1`、`pi-test.bat` 无法在 macOS 执行；只做了全文复读。两者以 UTF-8 无 BOM 保存，Windows PowerShell 5.1 可能把中文注释显示为乱码（注释不参与执行，PowerShell 7 可正确读取），未在 Windows 上验证。
- `test.sh` 未执行：它会运行完整 `npm test`，与本任务“不运行全量测试”的约束冲突；只验证了 `bash -n`。
- `vitest.base.ts` 未单独跑测试；它是配置模块，已用 esbuild 解析，并核对了三个消费方配置。
- 并发写入：复核期间 3 个配置（`tsconfig.json`、两份 `wrangler.jsonc`）出现外部注释改动。按并行工作规则，本组未回退或重写这些文件，只在报告中记录当前状态；本组自身新增行统计仍按 25 个文件计算。
- 仓库范围内 `git diff --check` 目前会被其他并行代理尚未收尾的文件（如 `scripts/cost.ts` 等 EOF 空行）影响；本组路径范围的检查是干净的。未执行 `git add/commit/push`。
- 注释过程中修正了几处容易误导的说明：07 的“禁用上下文文件”、07/08 的发现数量重复计数、10 的 `getGlobalSettings()` 用户层语义、08 的 `prompt`/`sendUserMessage` 模板展开差异、RPC 的超时与停止行为。没有修改任何原有代码行、字符串、默认值或类型。
