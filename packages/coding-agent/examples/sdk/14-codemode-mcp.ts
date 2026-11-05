/**
 * Codemode, Tool Search, and MCP
 *
 * The CLI loads `codemode`, `tool_search`, and MCP as built-in extensions. SDK sessions add
 * them to the resource loader's extension factories.
 *
 * `codemode` and `tool_search` are registered inactive. Enable them through the `defaultTools` setting
 * (`tools` would also restrict the session to the named tools, which hides MCP tools), or let the
 * MCP extension activate them: `codemode` for servers with `codemode` exposure, `tool_search` for
 * servers with `deferred` exposure.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 14 个。上游由
 * `node examples/sdk/14-codemode-mcp.ts` 直接运行（需先构建工作区）；下游把三个扩展工厂
 * （codemode、tool_search、MCP）注入 DefaultResourceLoader，再装配会话并绑定扩展。
 *
 * 演示什么：CLI 默认加载的三个内置扩展，在 SDK 中需要手动加入 extensionFactories。
 * codemode 把工具调用写成 JavaScript 脚本，tool_search 按需搜索工具，MCP 扩展读取 agentDir
 * 与受信项目里的 mcp.json 并把服务器工具暴露给模型。codemode/tool_search 注册时默认不激活；
 * 本示例用 defaultTools 的 +name 修饰把它们加到默认工具上，而不是用 tools 白名单替换默认集
 * （白名单会隐藏 MCP 工具）。MCP 扩展也可能按服务器 exposure 自动激活它们。运行会连接
 * mcp.json 配置的外部服务器并调用真实模型，可能产生费用和外部进程副作用。
 *
 * 能力清单（按调用顺序）：
 * - createCodemodeExtension({ mode: "on" })：注册 codemode 工具并强制开启模式。
 * - createToolSearchExtension()：注册工具搜索扩展（默认不激活）。
 * - createMcpExtension()：读取 mcp.json，连接服务器并注册 MCP 工具。
 * - resourceLoader.reload()：执行扩展工厂，完成工具注册。
 * - settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] })：在默认工具上增补。
 * - session.bindExtensions({})：发出 session_start，触发 MCP 后台连接。
 * - getActiveToolNames()：读取当前激活的工具名；MCP 工具可能尚未连接完成。
 * - session.prompt：让模型用 codemode 编写脚本完成任务。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；reload 执行扩展工厂，没有 mcp.json 时只是没有 MCP 服务器。
 *   2. bindExtensions 发出 session_start；打印当前激活工具名，随后 MCP 连接可能在后台继续。
 *   3. 模型回答以增量写到 stdout；脚本结束时 dispose 当前会话。
 *
 * 示例（真实签名）：
 *   const loader = new DefaultResourceLoader({
 *     cwd, agentDir: getAgentDir(),
 *     extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension()],
 *   });
 *   await loader.reload();
 *   三个工厂都返回 ExtensionFactory，真正的注册动作发生在 reload/扩展加载阶段。
 *
 * 建议阅读顺序：先看三个扩展工厂的职责，再看 defaultTools 的 +name 语义，随后看
 * bindExtensions 与 getActiveToolNames 的时序，最后看 prompt。
 */

// 三个扩展工厂都是运行值；DefaultResourceLoader 负责执行它们，Settings/SessionManager 提供覆盖与历史。
import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// 项目基准目录，用于资源发现和工具的相对路径。
const cwd = process.cwd();

// 默认加载器 + 显式扩展工厂；工厂函数此时只是保存配置，reload 时才执行注册。
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir: getAgentDir(),
	extensionFactories: [
		// mode:"on" 覆盖设置里的模式，强制 codemode 可用。
		createCodemodeExtension({ mode: "on" }),
		// 无参数：注册 tool_search，但默认不激活，需要 defaultTools 或 MCP 暴露策略开启。
		createToolSearchExtension(),
		// Reads mcp.json from the agent directory and the trusted project, like the CLI.
		// 无参数：读取 agentDir/mcp.json 与受信项目的 mcp.json，连接配置的服务器。
		createMcpExtension(),
	],
});
// 执行扩展工厂和资源发现；工具注册在这一步完成。
await resourceLoader.reload();

// 读取当前项目/用户设置；applyOverrides 只改有效视图，不写 settings.json。
const settingsManager = SettingsManager.create(cwd);
// `+name` adds to the configured default tools instead of replacing them.
// 只用修饰项时，从默认工具集（或已配置的 defaultTools）上增补；普通名字列表则会替换默认集。
settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });

// 用带扩展的加载器、覆盖后的设置和内存历史装配会话；此时还没有连接 MCP。
const { session } = await createAgentSession({
	resourceLoader,
	settingsManager,
	sessionManager: SessionManager.inMemory(),
});

try {
	// Emits session_start, which connects the MCP servers in the background.
	// 绑定扩展会发出 session_start；MCP 扩展在该事件中启动连接，但函数返回不保证全部连接完成。
	await session.bindExtensions({});
	// 打印此刻激活的工具名；后台 MCP 工具可能晚于这一行出现。
	console.log("Active tools:", session.getActiveToolNames().join(", "));
	// 订阅文字增量；工具事件不在此展示。
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	// 发出真实模型请求；模型可能使用 codemode 脚本调用 read/grep 等工具完成任务。
	await session.prompt("Use codemode to count the TypeScript files in src/ and list the three largest.");
	console.log();
} finally {
	// 释放会话及其扩展资源；外部 MCP 服务器进程是否关闭由扩展清理逻辑决定。
	session.dispose();
}
