// 所属：packages/durable/src/tool-search，Durable harness 的 `tool_search` 扩展实现（公开入口见 ./index.ts）。
// 解决的问题：工具很多时（例如多个 MCP server），把全部声明放进每次模型请求既占上下文又拖慢首 token；延迟工具
// （ToolRegistration.deferred）默认不提供给模型，模型先用 tool_search 按 BM25 搜索，命中的工具名通过结果的
// control.addTools 写入会话 modelTools.add，下一次请求才追加它们的声明。
// 职责边界：本文件只做“构造工具/扩展、从工具注册收集搜索文本、调用 rankDocuments、生成文本与 details”；
// 不安装扩展、不执行被搜到的工具、不直接改会话状态；modelTools 的写入由 harness 消费 control.addTools 完成。
// 上游：Registry.install(createToolSearchExtension())；模型通过工具调用进入 execute。下游：pi-schema 的
// obj/str/num/opt 构造参数 schema，defineTool/defineExtension 提供类型推断，rankDocuments 做排名，
// api.agent(context) 返回 Agent（其 deferred 是尚未提供的延迟工具）。
// 错误流向：schema 校验失败由 harness 在 execute 前拒绝；execute 对空白 query 和非正整数 limit 抛 Error，
// 由工具任务转成错误结果。搜索本身不抛错，rankDocuments 对空查询返回 []。
// 能力清单：
// - TOOL_SEARCH_TOOL_NAME：固定名称 "tool_search"。
// - DEFAULT_TOOL_SEARCH_LIMIT：默认返回上限 8。
// - ToolSearchToolDetails：结果 details 类型 { loaded: string[] }，供 UI 或程序读取。
// - createToolSearchTool()：构造 ToolRegistration；execute 异步搜索并请求加载。
// - createToolSearchExtension()：把该工具包成名为 "tool-search" 的 Extension。
// - TOOL_SEARCH_DESCRIPTION / toolSearchSchema：内部固定说明与运行时参数 schema。
// - isObject/schemaText/searchText：内部辅助，把 schema 与工具说明拼成排名正文。
// 组合与典型顺序：createToolSearchTool → createToolSearchExtension → registry.install →
// 会话把 deferred 工具排除在模型工具外 → 模型调用 tool_search → execute 读取 api.agent(context).deferred →
// rankDocuments → 返回 output/details/control.addTools → harness 写入 modelTools.add。
// 示例：
//   registry.install(createToolSearchExtension());
//   // 之后模型调用 tool_search({ query: "github issue", limit: 1 }) 可能得到
//   // { output: [{ type: "text", text: "Loaded 1 tool..." }], details: { loaded: ["github_get_issue"] },
//   //   control: { addTools: ["github_get_issue"] } }
// 建议阅读顺序：先看两个常量与 schema，再看 createToolSearchTool 的声明字段，然后读 execute 主流程，
// 最后看 searchText/schemaText 如何生成正文；扩展工厂只有一行组合。
/**
 * The `tool_search` tool, a copy of the coding agent's: the model searches the deferred tools it is not offered yet,
 * and the matches are loaded with `control.addTools`, so the next request offers them. Loading writes the
 * conversation's `modelTools` (its `add`), so loaded tools stay offered on that branch, also after a compaction.
 */
// 从 pi-schema 导入运行时 schema 构造器；它们生成 JSON Schema 形状，harness 在 execute 前用它校验模型参数。
// num 数值、str 字符串、opt 标记可选、obj 对象；obj 的 { open: true } 允许未声明字段存在。
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { rankDocuments } from "../search.ts";

// 搜索工具的固定注册名和未提供 limit 时的默认结果个数。
// 名称同时出现在模型看到的 description 里；它是字符串字面量，类型被推断为 "tool_search"（字面量类型）。
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
// 默认上限 8；createToolSearchTool 的 schema 说明与 execute 都引用这个常量，避免两处数字漂移。
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** Fixed, so it does not change while deferred tools are registered, for example as MCP servers connect. */
// 工具说明是固定模板字符串：只在模块加载时用 ${TOOL_SEARCH_TOOL_NAME} 插值一次，之后不随注册表变化。
// 固定文本让工具声明保持稳定，有利于请求前缀缓存；模板字符串里的 \n 是真实换行，反引号用 \` 转义。
// 不要在模板字符串内部插入注释，否则会改变模型看到的提示词文本。
const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

// obj/str/num/opt 构造运行时参数 schema；opt 使 limit 可以不传。
// open:true 允许其他键存在；非空查询和正整数上限由 execute 另行检查。
// 类型层面：obj 返回的对象 schema 让 defineTool 推断 ToolArgs；execute 解构出的 query 是 string，
// limit 是 number | undefined（因为包了 opt）。这些类型来自编译期推断，运行时仍由 harness 按 schema 校验。
const toolSearchSchema = obj(
	{
		query: str({ description: "Search query for deferred tools." }),
		limit: opt(num({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` })),
	},
	{ open: true },
);

/** `tool_search` result details: the tools it loaded. */
// details 是给 UI 或程序读取的结构化通道，不进入模型文本；loaded 按排名顺序保存工具名。
// 这里没有 readonly 数组，调用方在类型上可以修改它；运行时也不校验内容。
export type ToolSearchToolDetails = { loaded: string[] };

// 函数说明：isObject 接收 unknown（来自 schema 的任意节点），返回 boolean；为 true 时类型谓词把调用方的
// value 收窄为 Record<string, unknown>，之后才能安全读取 description/properties/items 等键。
// 纯判断、无副作用、不验证 schema 语义。示例：isObject({}) 为 true；isObject(null)、isObject([]) 为 false。
/** 判断未知 schema 子节点是否为非数组对象；例 {} 为真、null 为假。纯判断，不验证完整 schema。 */
function isObject(value: unknown): value is Record<string, unknown> {
	// value is ... 是类型谓词：结果为真时让 TS 允许按键读取，运行时只检查下面三个条件。
	// typeof null 也是 "object"，所以必须单独排除 null；数组同样通过 typeof 检查，用 Array.isArray 排除，
	// 避免把数组下标当作 schema 键递归。三个检查都是真实运行时判断，因为输入类型是 unknown。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
// 函数说明：schemaText 递归遍历一个 JSON Schema 形状的对象，把 description 文本、属性名和数组/联合分支
// 追加到 parts；没有返回值。输入 schema 是 unknown，函数用 isObject 逐层收窄；无外部副作用。
// 它不验证 schema 是否合法，也不检测循环引用；调用方传入注册表里的工具参数声明。
// 示例：{ description: "Path", properties: { path: { description: "File path" } } } 会依次追加
// "Path"、"path"、"File path"。
/** 从未知 schema 收集描述和字段名，原地追加 parts，无返回值。例 properties.path 会收集 path；不验证参数。 */
function schemaText(schema: unknown, parts: string[]): void {
	// schema 是外部声明数据，先排除不能按键访问的值。
	if (!isObject(schema)) return;
	// 只有字符串描述可加入搜索正文。
	// typeof 判断是运行时检查：description 在 unknown 对象上可能是任意值，只有 string 才可直接 push。
	if (typeof schema.description === "string") parts.push(schema.description);
	// properties 的键本身也可被查询词命中。
	// isObject 收窄后 Object.entries 返回 [键, 值] 元组；值仍是 unknown，交给递归继续判断。
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			// 先记属性名，再递归该属性的 schema。
			parts.push(name);
			schemaText(property, parts);
		}
	}
	// 遍历数组元素的 schema；缺省的 undefined 会由函数开头直接忽略。
	schemaText(schema.items, parts);
	// 这些联合/交叉约束的每个候选分支也贡献搜索文字。
	// 字符串数组的推断类型是 string[]，key 用于索引 schema 的任意键；索引结果是 unknown。
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		// 仅当声明给的是数组才遍历；不尝试修正无效 schema。
		// Array.isArray 是运行时检查，同时把 variants 收窄为 any[]，variant 再作为 unknown 递归。
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/** Search text of a tool: its description and its parameters' names and descriptions; the ranker reads the name. */
// 函数说明：searchText 输入一个工具注册，返回用于 BM25 的正文；正文由 description 加上参数 schema 的
// 描述/字段名组成，不包含工具名（rankDocuments 把 name 当独立字段，权重更高）。
// 纯函数：只创建局部数组，不执行工具、不读文件、无副作用；工具没有描述时仍可能返回参数文本或空串。
// 示例：描述为 "Read a file"、参数含 path 的工具，正文类似 "Read a file path File path"。
/** 输入工具注册，拼成搜索正文并返回字符串；例描述和 path 字段都参与搜索。只建本地数组，无工具执行。 */
function searchText(tool: ToolRegistration): string {
	// 从工具整体说明开始，随后补参数名及其说明。
	// parts 的类型由第一个元素推断为 string[]；schemaText 会原地追加。
	const parts = [tool.description];
	schemaText(tool.parameters, parts);
	// 删除纯空白片段后用空格连接；工具名由 rankDocuments 单独计算权重。
	// filter 的回调返回 boolean，返回 true 的片段保留；trim 不修改原字符串。
	return parts.filter((part) => part.trim() !== "").join(" ");
}

// 函数说明：createToolSearchTool 没有参数，返回一个 ToolRegistration；构造时只组装声明，不访问注册表、
// 不搜索、不执行任何工具。返回类型由 defineTool 的泛型推断，execute 的参数类型与 schema 关联。
// 主流程：defineTool({ name, description, parameters, callers, replay, execute }) → 原样返回对象。
// 错误：构造阶段不抛错；execute 内的错误在每次调用时产生。
// 示例：const tool = createToolSearchTool(); registry.install(defineExtension({ name: "mine", tools: [tool] }));
/** 构造供模型调用的搜索工具；不立即搜索。执行时读 deferred、排名并请求下轮添加，非法查询/上限抛错。
 * 例 query:"github issue",limit:1 可返回一个匹配工具名；具体匹配由当前 agent 的延迟工具决定。
 */
export function createToolSearchTool() {
	// defineTool 保留注册声明，实际运行由 Harness 的工具任务负责。
	return defineTool({
		// name 是注册与调用时的唯一标识；description 是模型看到的固定说明。
		name: TOOL_SEARCH_TOOL_NAME,
		description: TOOL_SEARCH_DESCRIPTION,
		// parameters 交给 harness 做运行时校验，并决定 execute 的 args 静态类型。
		parameters: toolSearchSchema,
		// Searching changes what the model is offered; scripts have their own `searchTools()`.
		// callers 只含 "model"：其他工具/脚本不能通过 executeTool 调用它；代码模式另有 searchTools()。
		callers: ["model"],
		// 恢复时允许重新执行搜索；它只改变工具可见性，不调用被搜到的工具。
		// replay: "safe" 表示中断后重跑不会产生外部副作用；默认是 "unsafe"。
		replay: "safe",
		// 解构已按 schema 校验的参数；这里补 schema 未表达的非空/正整数约束。
		// execute 的输入：query 字符串、limit 可省略；api 提供 agent(context) 等调用期能力，context 是 Chord 上下文。
		// 输出：ToolExecutionResult，含 output（给模型）、details（给 UI/程序）、可选 control.addTools。
		// 错误：空白 query 或非正整数 limit 抛 Error，由 harness 转成工具错误结果；搜索本身不抛错。
		// 主流程：校验参数 → 取 deferred 工具 → 生成文档 → BM25 排名 → 组装文本/details/control。
		// 示例（内部）：execute({ query: "github issue", limit: 1 }, api, context)
		async execute({ query, limit }, api, context) {
			// trim 只用于检查，传给排名器的仍是原 query。
			// 这里允许首尾空白但拒绝纯空白；错误文本固定，作为模型/调用方可见的提示。
			if (query.trim() === "") throw new Error("query must not be empty");
			// ?? 仅给缺省值使用默认上限，0 不会被默认值覆盖。
			// Number.isInteger 是运行时检查：schema 只保证是 number，不排除小数、NaN 或 -1。
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			// agent 异步解析当前对话配置；deferred 是尚未向模型展示的工具。
			// api.agent(context) 返回 Promise<Agent>；解构出的 deferred 是该会话当前启用但未提供的延迟工具。
			const candidates = (await api.agent(context)).deferred;
			// map 只抽取排名所需的名称和正文，不执行工具。
			// 返回对象形状满足 search.ts 的 SearchDocument 的 name/text 字段（namespaceText 可选，这里省略）。
			const documents = candidates.map((tool) => ({ name: tool.name, text: searchText(tool) }));
			// 返回最多 max 个工具名，按排名顺序排列。
			// rankDocuments 是纯排名函数：空查询、空文档或 limit<=0 时返回 []，不会抛错。
			const loaded = rankDocuments(query, documents, max);
			// 无匹配返回提示；有匹配则列出名称和说明第一行。
			// 整个表达式是一个三元；else 分支是模板字符串，内嵌 map(...).join("\n") 的结果。
			// 复数处理：数量为 1 时 tool，否则 tools；这是模型可见文本的一部分，不能随意改动。
			const text =
				loaded.length === 0
					? "No matching tools found."
					: `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}. They are available from your next call:\n${loaded
							.map((name) => {
								// ?. 与 ?? 让找不到说明时使用空串；此处不触发任何工具调用。
								// find 按名称回查候选；?.description 在 undefined 时短路，?? 提供空串兜底。
								const description = candidates.find((tool) => tool.name === name)?.description ?? "";
								// split(/\r?\n/) 同时处理 CRLF 与 LF；[0] 取第一行，trim 去掉首尾空白。
								return `- ${name}: ${description.trim().split(/\r?\n/)[0]}`;
							})
							.join("\n")}`;
			// details 供界面或调用方读取结构化的加载名称。
			// 类型注解显式写出 ToolSearchToolDetails，确保 details 通道的形状受接口约束。
			const details: ToolSearchToolDetails = { loaded };
			// 返回值只填三个通道：output 给模型、details 给 UI/程序、control 给 harness。
			// 未设置 isError，表示本次调用成功（即使没有匹配，也只是文本提示，不是错误）。
			return {
				// 文本输出交给模型，control 交给 Harness 持久化 modelTools.add。
				// output 的元素类型是 ToolResultMessage["content"] 的成员；text 项会被序列化进对话记录。
				output: [{ type: "text", text }],
				details,
				// 对象展开条件省略字段；没有匹配就不改变下一轮可见工具。
				// control.addTools 只写名称；harness 会去重追加到 modelTools.add。未注册或非延迟名称仍可写入，
				// 但计算下一轮提供列表时没有效果。
				...(loaded.length === 0 ? {} : { control: { addTools: loaded } }),
			};
		},
	});
}

/** The `tool_search` extension: install it and select it where the model should find deferred tools. */
// 函数说明：createToolSearchExtension 无参数，返回一个 Extension；扩展名为 "tool-search"，只包含一个工具。
// 无外部副作用：不 install、不搜索、不读写会话；调用方必须自己 registry.install(...) 并让会话选中该扩展。
// 每次调用都会新建工具对象；扩展名相同则 install 时会替换同名扩展（Registry 行为）。
// 示例：registry.install(createToolSearchExtension());
/** 返回包含一个搜索工具的扩展；调用方仍须安装并选中它。无参数/外部副作用，例 registry.install(createToolSearchExtension())。 */
export function createToolSearchExtension() {
	// 只组合定义，构造时不搜索、不修改对话。
	// defineExtension 是恒等函数，仅帮助 TypeScript 推断工具类型；数组中的工具由 Registry 安装后生效。
	return defineExtension({ name: "tool-search", tools: [createToolSearchTool()] });
}
