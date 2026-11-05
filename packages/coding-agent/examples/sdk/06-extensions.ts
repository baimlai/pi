/**
 * Extensions Configuration
 *
 * Extensions intercept agent events and can register custom tools.
 * They provide a unified system for extensions, custom tools, commands, and more.
 *
 * By default, extension files are discovered from:
 * - ~/.pi/agent/extensions/
 * - <cwd>/.pi/extensions/
 * - Paths specified in settings.json "extensions" array
 *
 * An extension is a TypeScript file that exports a default function:
 *   export default function (pi: ExtensionAPI) { ... }
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 06 个。上游由
 * `node examples/sdk/06-extensions.ts` 直接运行（需先构建工作区）；下游通过
 * DefaultResourceLoader 加载外部扩展文件和内联扩展工厂，再把加载器交给 createAgentSession。
 *
 * 演示什么：扩展是运行在宿主进程中的模块，默认导出函数接收 ExtensionAPI。它可以监听 Agent
 * 生命周期事件（如 agent_start、tool_call、agent_end），也可以注册自定义工具和斜杠命令。
 * 本示例同时演示两条注入途径：additionalExtensionPaths 指向磁盘上的扩展文件，
 * extensionFactories 直接提供内联工厂。文件末尾注释里有一个完整的扩展模板（不会执行）。
 * reload 会执行扩展工厂并注册其工具；prompt 触发 agent_start 时，内联扩展打印一行日志。
 * 该示例会真实调用模型，可能产生费用。
 *
 * 能力清单（按演示的机制）：
 * - 默认发现位置：~/.pi/agent/extensions、<cwd>/.pi/extensions、settings.json 的 extensions。
 * - additionalExtensionPaths：为本次加载器附加扩展文件路径（相对路径按 cwd 解析）。
 * - extensionFactories：直接传入 (pi) => void 形式的内联扩展，不经过磁盘发现。
 * - agent_start 事件：一轮 Agent 运行开始时触发，本例用来打印日志。
 * - 文件末尾注释模板：tool_call 拦截、自定义工具 registerTool、命令 registerCommand。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；reload 发现资源并执行扩展工厂。
 *   2. 提问后先看到 `[Inline Extension] Agent starting`，随后是模型回答的文字增量。
 *   3. `./my-logging-extension.ts` 与 `./my-safety-extension.ts` 是示意文件名，示例目录中
 *      并不存在；缺失来源会记录为加载诊断/错误，不会凭空创建扩展。想看外部扩展日志，需要
 *      先创建这两个文件或删掉对应路径。
 *
 * 示例（真实签名，独立扩展文件）：
 *   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
 *   export default function (pi: ExtensionAPI) {
 *     pi.on("agent_start", async () => { console.log("start"); });
 *   }
 *   只有默认导出的函数会被加载器调用；事件回调可以同步或异步。
 *
 * 建议阅读顺序：先看三个发现来源，再看 additionalExtensionPaths 与 extensionFactories 的差别，
 * 随后看 agent_start 回调，最后读末尾注释中的 tool_call/工具/命令模板。
 */

// DefaultResourceLoader 负责发现并执行扩展；getAgentDir 提供默认用户配置根；
// SessionManager 提供内存历史；createAgentSession 完成最终会话装配。
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// Extensions are discovered automatically from standard locations.
// You can also add paths via settings.json or DefaultResourceLoader options.

// 构造加载器时只保存配置；扩展文件的实际解析和工厂执行发生在 reload()。
const resourceLoader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	// 追加两个示例扩展文件路径。它们与自动发现相互独立，不会替换默认目录发现。
	additionalExtensionPaths: ["./my-logging-extension.ts", "./my-safety-extension.ts"],
	// 内联扩展数组：每个元素都是 ExtensionFactory，即接收 pi 的函数。
	extensionFactories: [
		// 工厂在 reload 时执行，这里登记一个事件监听；箭头函数参数 pi 由加载器传入。
		(pi) => {
			// "agent_start" 是字面量事件名；回调在每轮 Agent 运行开始时执行，返回 void/Promise。
			pi.on("agent_start", () => {
				console.log("[Inline Extension] Agent starting");
			});
		},
	],
});
// reload 解析所有来源、执行工厂并记录错误；内联工厂注册完成后，事件监听才生效。
await resourceLoader.reload();

// 传入已加载的扩展集合；内存历史避免写会话文件。
const { session } = await createAgentSession({
	resourceLoader,
	sessionManager: SessionManager.inMemory(),
});

// 事件订阅、提问和清理与前面示例相同；agent_start 日志来自上面的内联扩展。
try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	session.dispose();
}

// Example extension file (./my-logging-extension.ts):
// 下面是完整扩展模板，整段位于块注释中，运行本示例时不会加载或执行。
// 若要启用，需取消注释并为 Type 添加导入（例如 from "@earendil-works/pi-ai" 的扩展视图）；
// 模板中的 tool_call 返回 { block: true, reason } 可阻止工具执行，registerTool 注册自定义工具。
/*
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", async () => {
		console.log("[Extension] Agent starting");
	});

	pi.on("tool_call", async (event) => {
		console.log(\`[Extension] Tool: \${event.toolName}\`);
		// Return { block: true, reason: "..." } to block execution
		return undefined;
	});

	pi.on("agent_end", async (event) => {
		console.log(\`[Extension] Low-level run ended, \${event.messages.length} messages\`);
	});

	// Register a custom tool
	pi.registerTool({
		name: "my_tool",
		label: "My Tool",
		description: "Does something useful",
		parameters: Type.Object({
			input: Type.String(),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => ({
			content: [{ type: "text", text: \`Processed: \${params.input}\` }],
			details: {},
		}),
	});

	// Register a command
	pi.registerCommand("mycommand", {
		description: "Do something",
		handler: async (args, ctx) => {
			ctx.ui.notify(\`Command executed with: \${args}\`);
		},
	});
}
*/
