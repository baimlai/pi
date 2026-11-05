/**
 * Adapters that give a pi-agent-core `Agent` MCP tools and a codemode tool, using
 * `@earendil-works/pi-mcp` and `@earendil-works/pi-codemode`. See main.ts for how they fit together.
 */

// 本文件在Agent、MCP远程工具与QuickJS脚本之间适配数据；只创建适配器时不请求模型，调用execute才可能执行远端副作用。

import {
	type Agent,
	type AgentTool,
	type AgentToolCallOutcome,
	type AgentToolResult,
	runToolCall,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeJsonSchema,
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { type McpClient, toLlmContent } from "@earendil-works/pi-mcp";
import { obj, str } from "@earendil-works/pi-schema";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
// 接前缀和原工具名，返回加前缀、替换非法字符、截断后的字符串；无I/O。例前缀mcp、名read.file得到mcp_read_file。
// 此处不检查改名后的碰撞：两个原名经替换或截断后可能相同，不能把规范化当作唯一ID分配。
function toToolName(prefix: string, name: string): string {
	// 正则g替换全部不在允许字符集中的字符；slice保留前64个UTF-16码元，这里替换后只剩ASCII。
	return `${prefix}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

// 接工具结果，按原顺序提取text块，用换行拼成字符串；无文本则空串，不改原数组，也不包含图片/结构化结果。例两块a、b得到a换行b。
// AgentToolResult<unknown>表示details类型未知；content仍有明确块联合，不需通过unknown形状检查才能读取它。
function textOf(result: AgentToolResult<unknown>): string {
	// 从结果内容开始一条数组处理链，最后返回字符串而非Promise。
	// block is TextContent是类型谓词：运行时检查type标签，开发时让后续map知道每块都有text。
	// 单表达式箭头隐式返回每个文本块的正文，产生新数组。
	// 块间插入换行；不会清除正文原有换行或首尾空白。
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * One `AgentTool` per tool of a connected MCP server, named `<prefix>_<tool>`. Tools with an MCP
 * output schema declare it as `outputSchema` and return `structuredContent`, which codemode scripts
 * receive instead of the text.
 */
// 从已连接的client列出服务器工具并返回AgentTool数组Promise；prefix用于模型可见改名，execute闭包保留原名给MCP。
// 例如远端read.file变mcp_read_file，模型调用后仍发tools/call的read.file。这里只列工具；调用/取消/进度在之后execute时发生。
// 列表/协议错误会拒绝；工具isError结果通常正常返回并标错。as只适配静态类型，MCP客户端不按输入/输出schema做完整业务验证。
export async function createMcpTools(client: McpClient, prefix: string): Promise<AgentTool[]> {
	// 等待全部分页工具列表；连接失败或列表浅层检查失败会使本函数拒绝，不返回部分数组。
	const tools = await client.listTools();
	// map为每个声明新建AgentTool，箭头后的圆括号表示返回对象，不是函数体代码块。
	return tools.map(
		// : AgentTool约束返回对象的开发期形状，不在运行时创建验证器。
		(tool): AgentTool => ({
			// 模型按规范化名称调用，但后面的MCP请求仍使用原tool.name。
			name: toToolName(prefix, tool.name),
			// ??只在null/undefined时回退，保留显式空标题。
			label: tool.title ?? tool.name,
			// 优先原说明，其次标题，最后拼默认说明；不修改服务器对象。
			description: tool.description ?? tool.title ?? `MCP tool ${tool.name}`,
			// Providers require an object schema, and some reject one without `properties`.
			// 浅复制输入schema后固定根type并补properties；这不等于检查schema内的每条规则都受模型服务支持。
			parameters: {
				// 保留远端其余schema键/嵌套引用。
				...tool.inputSchema,
				// 后写字段覆盖远端根type，符合这里对象参数的约定。
				type: "object",
				// 缺属性表时补空对象，已有表仍用原引用。
				properties: tool.inputSchema.properties ?? {},
			},
			// 输出schema提供给程序/声明生成；此赋值自身不验证实际远端结果。
			outputSchema: tool.outputSchema,
			// 真正执行回调：忽略外层调用ID，传params/取消信号到MCP，进度可转成部分结果，最终返回内容与错误标记。
			execute: async (_toolCallId, params, signal, onUpdate) => {
				// as Record仅让TS把未知schema参数看成键值对象，不转换/校验；正常Agent调用会先经过自己的schema管线。
				const result = await client.callTool(tool.name, params as Record<string, unknown>, {
					// 将合作式取消请求传给客户端；不能保证远端已做副作用被回滚。
					signal,
					// 每次MCP进度通知生成一块文本并尝试上报，不作为最终工具结果追加。
					onProgress: (progress) => {
						// 有message就用它，否则显示数值progress；空message不会触发??回退。
						const text = progress.message ?? `Progress ${progress.progress}`;
						// ?.只在订阅者存在时调用，details明确undefined；这里没有自行await任何更新工作。
						onUpdate?.({ content: [{ type: "text", text }], details: undefined });
					},
				});
				// 把MCP内容转文字/图片，不支持的块生成占位；无块但有结构化结果时生成其JSON文字。
				const content = toLlmContent(result);
				// 远端报告失败却没有任何可显示内容时补一条默认错误；转换已有占位或结构化JSON就不会补。
				if (result.isError && content.length === 0) {
					// push只改本次转换的新数组。
					content.push({ type: "text", text: `MCP tool ${tool.name} failed` });
				}
				// 返回AgentToolResult；不把失败结果当作抛出的协议异常处理。
				return {
					// 模型可见的转换后内容。
					content,
					// 本例不另保存UI详情。
					details: undefined,
					// MCP的unknown结构化数据断言成JSON值，仅改类型，无法保证外部内容符合JSON/输出schema。
					structuredContent: result.structuredContent as JsonValue | undefined,
					// MCP reports tool failures in the result instead of as a protocol error.
					// 只有严格true才是失败；未提供字段在此变false。
					isError: result.isError === true,
				};
			},
		}),
	);
}

/**
 * Run a tool call on behalf of another tool through the agent's pipeline: argument validation and
 * the agent's `beforeToolCall`/`afterToolCall` hooks apply as for calls the model makes. Calling
 * `tool.execute()` directly also works when the agent has no hooks.
 */
// 接Agent返回异步调用闭包；每次按最新state找最近assistant和当前工具，经runToolCall执行并返回最终outcome。
// 例如脚本请求mcp_read时分配nested-1；下次nested-2。计数属于这个闭包，不是全局ID，也不自动向Agent消息/事件添加嵌套结果。
// 没有assistant会同步throw；参数错误、阻止或工具失败通常由runToolCall转isError:true，钩子和远端执行仍可能有副作用。
export function createNestedToolRunner(
	// agent对象保持原引用，后续替换其tools/messages会影响之后的嵌套调用。
	agent: Agent,
	// 返回类型是函数：三个参数分别为名称、未知参数、必填取消信号，调用得到outcome的Promise，不是本函数现在就执行工具。
): (name: string, args: unknown, signal: AbortSignal) => Promise<AgentToolCallOutcome> {
	// 可重赋计数器由返回闭包捕获，首次调用从1开始。
	let nextId = 1;
	// 此箭头不是async；缺assistant时直接抛错，成功路径直接返回runToolCall的Promise。
	return (name, args, signal) => {
		// findLast从末尾查第一条assistant；不是强制最后一条消息本身必须是assistant。
		const assistantMessage = agent.state.messages.findLast((message) => message.role === "assistant");
		// ?.允许查不到，显式标签判断同时使后续TS收窄为AssistantMessage。
		if (assistantMessage?.role !== "assistant") throw new Error("Nested tool calls need an assistant message");
		// 在本次调用开始时取工具数组引用，不在闭包创建时冻结它。
		const tools = agent.state.tools;
		// 同一工具管线完成参数准备/验证、前钩子、execute和后钩子；它本身不追加消息或发完整Agent事件。
		return runToolCall(
			// 后缀++先取旧值再递增；args仅在null/undefined时补{}，as JsonObject不证明任意unknown是对象。
			{ type: "toolCall", id: `nested-${nextId++}`, name, arguments: (args ?? {}) as JsonObject },
			{
				// 明确把查工具范围限定为本次取到的工具数组。
				tools,
				// 钩子用这条已有assistant作为发起消息，不创建合成assistant历史。
				assistantMessage,
				// 消息与工具仍共享Agent当前引用；runToolCall不负责保存嵌套调用结果。
				context: { messages: agent.state.messages, tools },
				// 复用Agent前置钩子，可阻止调用。
				beforeToolCall: agent.beforeToolCall,
				// 复用后置钩子，可覆盖最终内容、结构化结果和错误状态。
				afterToolCall: agent.afterToolCall,
				// 同一取消信号继续传到钩子和工具。
				signal,
			},
		);
	};
}

// 对外导出本例codemode固定名称，下面过滤同名工具以免脚本递归进入它。
export const CODEMODE_TOOL_NAME = "codemode";

// 模块加载时创建参数schema：code必填字符串，不在这里编译或执行它。
const codemodeParameters = obj(
	// 描述文字说明code是异步函数体；str仅校验字符串，不校验JS语法或工具授权。
	{ code: str({ description: "JavaScript source. Top-level await and return work." }) },
	// Open, as the tool accepted extra arguments before it moved from TypeBox.
	// 开放对象允许额外字段；本例execute只使用code。
	{ open: true },
);

/**
 * A tool that runs model-written JavaScript in the codemode sandbox, where `tools.<name>(args)`
 * calls `tools`. Nested results stay out of the model context; only the script's output and
 * return value come back.
 */
// 接工具只读数组和调用管线，返回codemode的AgentTool；先生成脚本工具包装和声明，执行时才新建沙箱、跑code、拼结果并关闭。
// 例如code为return await tools.mcp_count({})时，只把脚本输出/返回值交外层Agent，内部工具结果不单独入消息历史。
// readonly只是TS禁止经该数组增删，工具对象仍共享。脚本失败通常变isError；沙箱构造、执行入口或close异常仍可使execute拒绝，工具副作用不会回滚。
export function createCodemodeTool(
	// 不保留codemode同名项，其余在本次工厂调用时快照到包装数组。
	tools: readonly AgentTool[],
	// 宿主提供三参数异步函数；unknown要求实际参数经管线验证，不靠CodemodeJsonSchema的展示声明保证。
	runTool: (name: string, args: unknown, signal: AbortSignal) => Promise<AgentToolCallOutcome>,
	// typeof取得schema类型，让AgentTool泛型推导execute的params包含code:string。
): AgentTool<typeof codemodeParameters> {
	// filter创建新数组，不从原tools移除任何项；按名称排除所有同名codemode工具。
	const callable = tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
	// 把每个AgentTool投影为沙箱能力；map中的对象圆括号使箭头隐式返回对象。
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		// 保留模型可见名字，脚本层还会按codemode标识符规则生成可调用名称。
		name: tool.name,
		// 描述用于ALL_TOOLS与生成的声明，不在此执行。
		description: tool.description,
		// 断言schema为codemode展示类型；沙箱不会按它验证参数，真正校验靠runTool。
		inputSchema: tool.parameters as CodemodeJsonSchema,
		// What the script receives: the structured result if the tool declares one, else its text.
		// 有输出schema就展示它，缺失时宣告返回字符串；as不会验证真实输出。
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
		// 脚本调用后的异步回调，第二参数解构本次调用的取消信号；优先返回已声明的结构化值，否则提文本/抛失败。
		execute: async (args, { signal }) => {
			// 等待宿主管线的最终结果，包含前后钩子的修改。
			const outcome = await runTool(tool.name, args, signal);
			// 既有schema又有非undefined结构化值才走此路径；null、false、0都可返回，而且此分支先于下方isError检查。
			if (tool.outputSchema && outcome.result.structuredContent !== undefined) {
				// 即便outcome.isError为true，只要满足上述条件，本例仍直接返回结构化值；不在这里抛异常。
				return outcome.result.structuredContent;
			}
			// 没选结构化路径时只提text块，图片被省略。
			const text = textOf(outcome.result);
			// 失败转成脚本可见Error，空正文用默认消息；脚本可try/catch，因此一次工具失败不必然让整个脚本失败。
			if (outcome.isError) throw new Error(text || `Tool ${tool.name} failed`);
			// 成功则向脚本返回拼接后的文字，可能为空串。
			return text;
		},
	}));

	// 只返回工具定义，构造沙箱留到execute，避免仅注册工具就启动worker。
	return {
		// 工具调用名，与上面过滤的名称一致。
		name: CODEMODE_TOOL_NAME,
		// 供UI显示的标题。
		label: "Codemode",
		// 下方字符串数组是模型实际看到的说明，学习注释放在数组项之间，保留其原文本。
		description: [
			"Run JavaScript that calls other tools, to chain calls, run them in parallel, or filter large results.",
			"The code is the body of an async function. There is no Node, file system, network, or timers.",
			"Call tools as `await tools.<name>(args)`. Output with `text(value)` or `console.log()`, or `return` a value.",
			"Only the output and the return value reach you, not the results of the tool calls.",
			"",
			"```ts",
			// 把工具schema渲染成TS说明字符串；只作提示，不在运行时替脚本做TypeScript检查。
			renderDeclarations({ tools: sandboxTools }),
			"```",
			// join为各说明段插入换行，包含围栏内声明。
		].join("\n"),
		// 外层Agent用这个schema检查传入code，而非检查code内部调用参数。
		parameters: codemodeParameters,
		// 执行回调忽略工具ID/进度：每次创建新沙箱，传取消信号，合并输出与return值，并始终请求关闭。
		execute: async (_toolCallId, params, signal) => {
			// 120_000是120秒默认执行期限；构造时配置工具，真正execute才启动QuickJS worker，不代表整个远端副作用都能强制中断。
			const sandbox = new CodemodeSandbox({ tools: sandboxTools, timeoutMs: 120_000 });
			// try覆盖执行和结果拼装，构造沙箱在try外；finally也会在执行入口抛错时运行。
			try {
				// code作为异步函数体运行，signal合作式取消；脚本异常通常返回ok:false，入口错误仍可能拒绝/抛出。
				const result = await sandbox.execute(params.code, { signal });
				// Items from text(), console.*, and image(), in order. They have pi-ai's content shapes.
				// 联合类型数组可含文字或图片，展开浅复制输出容器，后面追加return值不改result.output。
				const content: (TextContent | ImageContent)[] = [...result.output];
				// 仅成功且return不是undefined才展示返回值；null/false/0仍会进入。
				if (result.ok && result.value !== undefined) {
					// typeof在unknown边界收窄字符串，其他值用JSON编码；这不是输出schema验证，编码异常会向外传播。
					const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
					// 追加一块文本，已有脚本输出仍在前面；return不会自动被沙箱加入output。
					content.push({ type: "text", text: value });
				}
				// ok字面量是判别字段，此分支TS允许读取error，失败前已产生的输出也会保留。
				if (!result.ok) {
					// 优先错误stack，缺失时用message，作为普通工具错误文字交模型。
					content.push({ type: "text", text: `Script failed: ${result.error.stack ?? result.error.message}` });
				}
				// details只存工具调用摘要，模型正文用content；脚本失败映射为工具isError，脚本storeWrites没有在本例持久化。
				return { content, details: { calls: result.calls }, isError: !result.ok };
			} finally {
				// 请求关闭沙箱的运行；close完成不等于所有底层worker已退出，也不会回滚已执行工具的副作用，关闭拒绝可覆盖原结果。
				await sandbox.close();
			}
		},
	};
}
