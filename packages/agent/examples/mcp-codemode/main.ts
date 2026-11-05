/**
 * An Agent with the tools of an MCP server plus a codemode tool that calls them from JavaScript.
 *
 *   ANTHROPIC_API_KEY=... node packages/agent/examples/mcp-codemode/main.ts \
 *     npx -y @modelcontextprotocol/server-filesystem .
 *
 * The arguments are the command that starts a stdio MCP server.
 */

// 这是会真正请求模型和启动外部MCP命令的手工示例：命令行提供服务启动方式，模块顶层直接执行整个流程。
// 例如原英文命令会通过npx启动文件系统服务器；这里仅解释用法，不在学习注释验证时运行，也不把工作目录权限限制在沙箱内。

import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { createCodemodeTool, createMcpTools, createNestedToolRunner } from "./tools.ts";

// 去掉Node和脚本路径；数组解构取第一项为命令，...args收集其余参数，不自行解析参数里的空格。
const [command, ...args] = process.argv.slice(2);
// 运行时检查命令是否缺失/空串；string[]的TS声明不能保证用户确实提供了第一项。
if (!command) {
	// 打印调用格式到标准错误。
	console.error("Usage: main.ts <mcp server command> [args...]");
	// 状态1立即退出，后面尚未建立模型集合或MCP连接。
	process.exit(1);
}

// 创建独立模型集合；构造本身不向服务发请求。
const models = createModels();
// 把Anthropic实现和它的模型定义加入该集合，认证由provider在请求时处理。
models.setProvider(anthropicProvider());
// 在集合里按provider和模型ID查元数据，可能找不到，并不立即调用模型。
const model = models.getModel("anthropic", "claude-sonnet-4-6");
// 缺模型时同步抛错；成功后TS也能知道下方model不是undefined。
if (!model) throw new Error("Model not found");

// 客户端名称/版本用于MCP握手，不是外部服务版本。
const client = new McpClient({ name: "pi-agent-example", version: "1.0.0" });
// 顶层await允许ES模块直接等待连接；StdioTransport启动用户提供的命令，经标准输入/输出握手，失败在进入try前传播。
await client.connect(new StdioTransport({ command, args }));

// try包住连接成功后的Agent流程；内部失败也会进入finally关闭连接。
try {
	// 构造Agent保存状态及流函数；构造本身不发prompt请求。
	const agent = new Agent({
		// 用属性简写放入刚查到的model，其余运行状态由Agent填默认值。
		initialState: { systemPrompt: "You are a helpful assistant.", model },
		// bind固定Models实例为this，否则把实例方法直接传出可能失去其集合上下文。
		streamFn: models.streamSimple.bind(models),
	});
	// 通过真实MCP连接列工具并适配成AgentTool，mcp是模型可见名称的前缀。
	const mcpTools = await createMcpTools(client, "mcp");
	// The model can call the MCP tools directly or batch them in one codemode script.
	// 展开原工具再追加codemode；nested runner让脚本内部调用仍经过Agent的参数校验和前后钩子。
	agent.state.tools = [...mcpTools, createCodemodeTool(mcpTools, createNestedToolRunner(agent))];

	// 注册事件展示回调，收到文字增量就写stdout、工具开始则打印名称；回调不返回文本给模型，返回的退订函数在本例未保存。
	agent.subscribe((event) => {
		// &&短路先用message_update标签收窄事件，再判断内部是否为文字增量；思考/图片等不会进入此分支。
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			// write不自动换行，逐块连接模型输出。
			process.stdout.write(event.assistantMessageEvent.delta);
			// 其余事件只显示工具开始；嵌套runToolCall本身不会额外发布完整Agent事件。
		} else if (event.type === "tool_execution_start") {
			// 模板里的换行先另起一行，再显示模型可见工具名。
			console.log(`\n[${event.toolName}]`);
		}
	});
	// 真正向Anthropic发出问题并等待模型/工具循环；提示词要求使用codemode，不保证模型一定遵从。
	await agent.prompt("Use codemode to list what the MCP tools can do, then summarize it in two sentences.");
	// 正常完成时补一个换行。
	console.log();
} finally {
	// await主动关闭MCP传输；关闭本身也可能失败，且不会撤销工具已做的文件等副作用。
	await client.close();
}
