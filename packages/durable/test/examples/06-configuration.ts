// 文件导读
// 所属：packages/durable 的 test/examples 系列第 06 个示例，演示两层配置：会话级 Agent 选择与 Harness 级运行设置。
// 演示内容：给工具附加应用自定义元数据 snippet，用 section 把已提供工具的 snippet 渲染成提示词段；先观察默认选择，
//   再用 configure() 按名字存储模型/思考级别/工具/扩展选择，最后验证“存储的名字独立于当前代码”以及设置的实时读取。
// 上游入口：从 packages/durable 目录直接运行；下游调用 defineTool、defineExtension、section、createRegistry、
//   Harness.open、Conversation.configure、Conversation.agent、Harness.snapshot、registry.uninstall/install。
//   没有模型请求，也没有网络。
// 能力清单（按演示机制）：
// - AppTool = ToolRegistration & { snippet?: string }：用交叉类型给标准工具附加应用字段；只在编译期约束。
// - exampleTool(name, description)：构造带 snippet 的假工具；defineTool 返回原对象，再展开复制并加字段。
// - defineExtension<AppTool>({name, tools, sections})：扩展可同时包含工具和提示词段。
// - section(key, render)：render 接收 PromptInput，其中 input.agent.tools 是本次请求提供给模型的工具；默认用 <key> 包裹。
// - createRegistry<AppTool>()：注册表泛型约束工具类型；install/uninstall 立即发布快照。
// - HarnessSettings：Harness 级设置（stream/retry/toolExecution 等），每次使用重新读取，不写入存储。
// - Conversation.configure(change, context)：把 AgentChange 写入 pi.agent，每次调用一个提交；对象按名字存储。
// - Conversation.agent(context)：每次按当前存储选择、注册表快照和设置重新解析。
// 典型运行顺序：建工具/扩展/注册表 → 打开 Harness → root() → 查默认工具 → configure 三次 → uninstall/install → 改设置 → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/06-configuration.ts
// 实际输出：
//   default tools: [ 'read', 'write', 'grep' ]
//   stored: { model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' }, thinkingLevel: 'high', tools: [ 'write', 'read' ] }
//   model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' } thinking: high tools: [ 'write', 'read' ]
//   without search: [ 'read', 'write' ]
//   files uninstalled: [ 'grep' ]
//   files reinstalled: [ 'read', 'write', 'grep' ]
// 阅读顺序：先看 AppTool 如何扩展工具类型，再看三个扩展与 registry 的泛型，随后看 configure 的三种 change 形态
//   （整体替换、{remove} 增删、null 清除），最后看 settings 的 getter 如何做到“下一次请求生效”。
// Per-conversation agent choices and Harness-wide settings.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/06-configuration.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { obj, str } from "@earendil-works/pi-schema";
// type 修饰的导入只用于类型检查，运行时不存在对应绑定；其余是值导入。
import {
	AgentDoc,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	type ToolRegistration,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// Apps may attach their own metadata to tools, such as a prompt snippet.
// 交叉类型：AppTool 同时满足 ToolRegistration 的全部字段和可选的 snippet。
// snippet 用 ?: 声明为可选，读取时可能是 undefined；这只是编译期形状，运行时没有校验。
type AppTool = ToolRegistration & { readonly snippet?: string };

// 构造一个演示用工具：输入 name 与 description，返回带 snippet 的 AppTool。
// 副作用：无（defineTool 原样返回对象）；错误路径：无。生成的 execute 仍是假实现，只回显 name 与 path。
// 示例：exampleTool("read", "Read a file") 返回 { name: "read", ..., snippet: "Use read for files." }。
// 实际运行时，工具被模型调用前会按 parameters 校验 args，然后才进入 execute。
function exampleTool(name: string, description: string): AppTool {
	// defineTool 的泛型从参数 schema 推导 args 类型；这里的 name/description 是外层函数的参数。
	const tool = defineTool({
		name,
		description,
		parameters: obj({ path: str() }),
		execute: async (args) => ({ output: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
	// 对象展开复制工具的所有字段，再加 snippet；原 tool 不被修改。
	// 返回类型标注为 AppTool，编译器会检查添加的字段符合交叉类型。
	return { ...tool, snippet: `Use ${name} for files.` };
}

// 三个工具分别来自同一个工厂；它们只有名字和描述不同。
const read = exampleTool("read", "Read a file");
const write = exampleTool("write", "Write a file");
const grep = exampleTool("grep", "Search files");
// 泛型参数 <AppTool> 让扩展和后续注册表都使用带 snippet 的工具类型。
// files 扩展含 read/write，search 扩展只含 grep。
const Files = defineExtension<AppTool>({ name: "files", tools: [read, write] });
const Search = defineExtension<AppTool>({ name: "search", tools: [grep] });
// Sections see the offered tools as app tools, so one can render their snippets.
// 该扩展没有工具，只贡献一个提示词段；它默认也被选中，因此会参与每次请求的 system prompt。
// section 的第一个参数是段 key；render 的返回值默认由渲染层包成 <tool_snippets>...</tool_snippets>（tag 未设 false）。
// input.agent.tools 是本次请求已启用且提供给模型的工具；snippet 可选，join 会把 undefined 当成空串处理。
const Snippets = defineExtension<AppTool>({
	name: "snippets",
	sections: [section("tool_snippets", (input) => input.agent.tools.map((tool) => tool.snippet).join("\n"))],
});

// 注册表按安装顺序保存扩展；同名安装会原地替换，卸载按名字匹配。
const registry = createRegistry<AppTool>();
registry.install(Files);
registry.install(Search);
registry.install(Snippets);

// Settings are Harness-wide run policy, read at every use and never stored.
// A getter makes a value live, such as one backed by the app's settings file.
// timeoutMs 是普通变量；getter 每次读取 settings.stream 都返回一个新对象，因此修改 timeoutMs 后下一次解析能看到新值。
let timeoutMs = 60_000;
// HarnessSettings 的所有字段都可选；未给的字段由 resolveSettings 用内置默认值补齐。
// retry 只覆盖 maxRetries，其余重试字段沿用默认；toolExecution 为 sequential 时整轮工具串行执行。
const settings: HarnessSettings = {
	// get 语法定义访问器：读取 settings.stream 时执行函数体，而不是返回固定字段。
	get stream() {
		return { timeoutMs };
	},
	retry: { maxRetries: 5 },
	toolExecution: "sequential",
};
// settings 传入对象本身；Harness 在每次使用时重新解析，所以 getter 是“活”的。
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry, settings }, context);
// 根会话首次创建；未给 agent/init，因此不写额外选择。
const root = await harness.root(context);

// A new conversation stores no choices and follows the host: every installed
// extension, all of their tools.
// 这个无参箭头函数每次调用都重新执行 root.agent()，从而反映最新的注册表与设置，而不是缓存旧结果。
// 示例：await tools() 当前返回 ['read', 'write', 'grep']。
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
// 默认选择：三个已安装扩展全部启用，显示各自全部工具。
console.log("default tools:", await tools());

// configure() stores choices in the conversation's pi.agent document, one
// commit per call. Extensions and tools are passed as objects and stored by
// name, so a typo cannot slip in.
// 第一次 configure：模型引用与思考级别是值；tools 是精确启用列表并按给定顺序生效（write 在前）。
// 传对象而不是字符串，名称只能来自实际注册的工具；存储时会转成名字。
// 每次 configure 是一个独立提交，成功后立即可被 agent() 读到。
await root.configure(
	{
		model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		thinkingLevel: "high",
		tools: [write, read],
	},
	context,
);
// 存储值只含名字/选择，不含工具或扩展对象；这里可以看到 model、thinkingLevel 与工具名数组。
console.log("stored:", await harness.snapshot(AgentDoc, root.id, context));
// 重新解析：model 原样返回引用，thinkingLevel 为 high，工具顺序遵从存储的 [write, read]。
const agent = await root.agent(context);
console.log("model:", agent.model, "thinking:", agent.thinkingLevel, "tools:", await tools());

// Deselect an extension; `null` clears a stored field back to the host default.
// extensions 传对象表示“在宿主默认选择上增删”：remove 掉 search，其余保持默认（files、snippets）。
// tools: null 清除精确工具列表，于是回退为“所选扩展的全部工具”，结果只剩 read/write。
await root.configure({ extensions: { remove: [Search] }, tools: null }, context);
console.log("without search:", await tools());

// Stored names outlive the code. The conversation selects exactly these two
// extensions; uninstalling "files" leaves it selected, and requests just stop
// offering its tools until it is back.
// 数组形式表示精确选择且带顺序：只选 files 与 search，snippets 被排除。
await root.configure({ extensions: [Files, Search] }, context);
// uninstall 按名称移除当前安装的 files；存储里的选择仍是名字，所以 "files" 仍被选中但解析不到。
// 此时只剩 search 的 grep 可用。
registry.uninstall(Files);
console.log("files uninstalled:", await tools());
// 重新安装后，选择顺序 [Files, Search] 让 files 的工具再次排在 search 前面。
registry.install(Files);
console.log("files reinstalled:", await tools());

// Settings changes need no commit; the next request uses the new timeout.
// 只改局部变量；下一次读取 settings.stream 的 getter 会返回 120000。示例在此之后没有发起请求或打印，仅演示无需提交。
timeoutMs = 120_000;

// 关闭 Harness 与存储；settings 和注册表是应用对象，不会被持久化。
await harness.close(context);
