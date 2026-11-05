// 文件导读
// 所属：packages/durable 的 test/examples 系列第 05 个示例，演示 Harness 的最小打开方式：注册扩展、创建根会话、解析 agent。
// 演示内容：定义一个假的 read 工具，装进 files 扩展并注册；用 MemoryStorage 打开 Harness；首次调用 root() 时在建会话的
//   同一提交里应用 thinkingLevel:"low" 并写入 Notes；随后读取存储的 AgentDoc（只含选择），再通过 root.agent() 把它
//   解析成具体的扩展与工具对象。示例不调用模型，也不执行工具。
// 上游入口：从 packages/durable 目录直接运行；下游调用 pi-ai 的 createModels、pi-schema 的 obj/str、Harness.open、
//   Harness.root、Harness.snapshot、Conversation.agent。没有网络请求。
// 能力清单（按演示机制）：
// - defineTool<TParameters, TDetails>({...})：声明工具并原样返回；parameters 是 schema，execute 的 args 在编译期由它推导，
//   运行时由 Harness 在工具调用边界用 validateToolArguments 校验。
// - defineExtension({name, tools})：把工具、section、钩子、包装器、任务归到一个命名扩展。
// - createRegistry()/registry.install(ext)：应用持有的注册表；安装即发布新快照，同名再装会原地替换。
// - Harness.open(storage, {models, registry}, context)：在存储上打开 Harness；models 用于生成/压缩/钩子，本示例不触发。
// - Harness.root(context, {agent, init})：根会话固定 ID 1；仅首次调用创建，agent 与 init 在该创建提交内生效。
// - Harness.snapshot(token, id, context)：读取文档；AgentDoc 存的是选择（名字），不是解析后的对象。
// - Conversation.agent(context)：把存储的选择、当前注册表快照与宿主设置解析为 Agent（model/thinkingLevel/extensions/tools 等）。
// 典型运行顺序：定义工具/扩展 → 建注册表并安装 → Harness.open → root() 创建并初始化 → 读 Notes/AgentDoc → root.agent() → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/05-harness.ts
// 实际输出：
//   root: 1 { text: 'root notes' }
//   stored agent: { thinkingLevel: 'low' }
//   resolved: low [ 'files' ] [ 'read' ]
// 阅读顺序：先看 defineTool/defineExtension 的分工，再看 Harness.open 的必需选项，随后看 root() 首次创建与后续忽略选项的语义，
//   最后对比 AgentDoc（存储值）和 root.agent()（解析值）。
// Open a Harness with a registry of extensions.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/05-harness.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// pi-ai 的 models 入口提供 Models 对象；createModels() 创建默认模型目录访问，本身不发起请求。
import { createModels } from "@earendil-works/pi-ai/models";
// pi-schema 的 obj/str 构造参数 schema：obj 描述对象，str 描述字符串字段。
import { obj, str } from "@earendil-works/pi-schema";
// AgentDoc 是内置 pi.agent 文档令牌；Harness、createRegistry、defineExtension、defineTool 都从包根导出。
import {
	AgentDoc,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "../../src/index.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;

// A Harness is a Session plus conversation handles and durable tasks. Extension
// code (tools, prompt sections, hooks, tasks) comes in named extensions
// installed in a registry the application owns. Nothing in the registry is
// saved; it is this process's code.
// 下面这个 read 工具是假实现：它不读文件，只回显路径，便于示例在无文件系统依赖时展示工具注册。
// 函数签名为 execute(args, api, context) → Promise<ToolExecutionResult>；args 已在调用边界按 parameters 校验，
// api 提供提交/读取/嵌套调用等能力（本示例不用），context 用于取消。
// 示例：execute({ path: "a.txt" }, api, context) 返回 { output: [{ type: "text", text: "contents of a.txt" }] }。
// 错误路径：本实现不抛错；真实工具应在失败时抛错或返回 error 结果，由 Harness 转成工具结果。
const read = defineTool({
	name: "read",
	description: "Read a file",
	// obj({ path: str() }) 是运行时 schema，同时让 TypeScript 推导出 args 类型为 { path: string }。
	// 模型传入的参数不受类型系统保护，因此 Harness 执行前会做运行时校验。
	parameters: obj({ path: str() }),
	execute: async (args) => ({ output: [{ type: "text", text: `contents of ${args.path}` }] }),
});
// 扩展是注册单位：名字用于选择和替换，tools 列出该扩展启用的工具。
// defineExtension 只返回带类型的普通对象，不做运行时校验或复制。
const Files = defineExtension({ name: "files", tools: [read] });
// 注册表包含内置任务；install 立即发布快照，正在运行的 Harness 会看到新快照。
// 注册表只存在于本进程，不写入存储；重启后宿主需要重新安装同样的扩展。
const registry = createRegistry();
registry.install(Files);

// `models` is pi-ai's model access; generation calls models through it.
// Harness.open 的 options 至少需要 models 与 registry；models 可传对象或返回对象的函数。
// open 还会检查注册表是否包含全部内置任务，缺失会直接抛错。
// 本示例只读文档、不 submit，因此不会向任何 provider 发请求。
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);

// 会话级 Notes 文档定义；root 的 init 会写入它。
const Notes = defineDoc<{ text: string }>({
	checkpointWhen: () => false,
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

// The root conversation always has ID 1. The first root() call creates it,
// its built-in documents, the `agent` choices, and whatever `init` writes, all
// in one commit. Later calls, including after a restart, return it and ignore
// both options.
// root(context, { agent?, init? })：agent 是在创建提交里应用的 AgentChange（这里是 thinkingLevel），
// init 是 (tx, rootId) => void | Promise<void>，只能通过事务读写文档；表读取会抛 ReadAfterWrite。
// 首次调用创建根会话；如果存储里已存在 ID 1 的根会话，直接返回它，agent 与 init 都不再执行。
const root = await harness.root(context, {
	agent: { thinkingLevel: "low" },
	init: async (tx, rootId) => {
		(await tx.doc(Notes, rootId)).text = "root notes";
	},
});
// 读取 init 写入的 Notes；root.id 为 1，证明根会话使用保留 ID。
console.log("root:", root.id, await harness.snapshot(Notes, root.id, context));
// The stored choices are names; agent() resolves them against the registry.
// AgentDoc 里只有会话持久化的选择；未设置的 extensions/tools 不会写成对象，因此这里只有 thinkingLevel。
console.log("stored agent:", await harness.snapshot(AgentDoc, root.id, context));
// root.agent(context) 返回解析后的 Agent：extensions 是扩展对象数组，tools 是本次请求会提供给模型的工具数组。
// 未设置 extensions 时选择全部已安装扩展；未设置 tools 时启用这些扩展的全部工具。
// map 对两个数组分别取名，输出 ['files'] 与 ['read']。
const agent = await root.agent(context);
console.log(
	"resolved:",
	agent.thinkingLevel,
	agent.extensions.map((extension) => extension.name),
	agent.tools.map((tool) => tool.name),
);

// 关闭 Harness：关闭底层 Session 与存储；注册表仍由应用持有，不受影响。
await harness.close(context);
