// 文件导读
// 所属：packages/durable 的 test/examples 系列第 10 个示例，演示扩展如何拥有自己的会话级文档并在提示词段中读取它。
// 演示内容：定义 Todos 文档；todo 工具把条目写进该文档；todos section 在每次请求准备时读取文档并渲染成提示词段。
//   用 faux provider 驱动两次提交：第一次让模型调用 todo 工具（写入 "fix the build"），第二次只问 "What is next?"。
//   最后打印 Todos 文档与转录中的 system 消息，观察 section 文本和 toolsAdded 如何随请求变化。
// 上游入口：从 packages/durable 目录直接运行；下游调用 defineDoc、defineTool、defineExtension、section、createRegistry、
//   Harness.open/root、Conversation.submit/context、ToolExecutionApi.commit、DocumentReader.snapshot。
//   使用 faux provider，没有网络请求，也不产生费用。
// 能力清单（按演示机制）：
// - defineDoc：会话级可回看文档，fork:"asOf" 让分叉继承分叉点的待办。
// - defineTool 的 execute(args, api, callContext)：args 已校验；api.commit 在工具任务里提交文档写入。
// - section(key, render)：每次请求准备时运行；返回 undefined 表示本段不出现，返回文本则默认包成 <key>...</key>。
// - PromptInput.read：已提交文档的只读入口；snapshot 不存在时返回 undefined。
// - fauxProvider/fauxAssistantMessage/fauxToolCall：脚本化模型响应，按 setResponses 顺序消费。
// - Conversation.submit(...).wait(context)：提交输入并等待运行结算；第一次提交会因工具调用触发两轮生成。
// - Conversation.context()：读取最终请求消息；system 消息只包含本次实际新增的 sections/toolsAdded 差异。
// 典型运行顺序：定义 Todos/扩展 → 注册 faux provider → 打开 Harness → root(agent=faux-1) → 排三条响应 →
//   提交 “Remember...” 并等待 → 打印 Todos → 再提交 “What is next?” → 打印 system 消息 → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/10-extension-state.ts
// 实际输出：
//   todos: { items: [ 'fix the build' ] }
//   system messages: [
//     { sections: undefined, toolsAdded: [ 'todo' ] },
//     {
//       sections: { todos: '<todos>\nfix the build\n</todos>' },
//       toolsAdded: undefined
//     }
//   ]
// 阅读顺序：先看 Todos 的 scope/history/fork，再看工具 execute 里的提交，随后看 section 的缺失文档处理，
//   最后对照两条 system 消息理解“只发送变化”的提示词更新。
// An extension that keeps its own per-conversation document.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/10-extension-state.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
// faux provider 提供确定性的脚本响应，避免真实模型调用。
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A todo list per conversation. Rewindable with `asOf`, so a fork starts with
// the todos its parent had at the fork entry.
// 会话级文档：每个会话一份；可回看历史，分叉时复制分叉条目时刻的值。
// checkpointWhen 恒 false 表示普通变更只存增量，不额外存完整检查点。
const Todos = defineDoc<{ items: string[] }>({
	checkpointWhen: () => false,
	kind: "example.todos",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: [] }),
});

// The tool writes the document; the section shows it to the model before every
// request. Nothing needs to create it up front: tx.doc() creates it on first
// write, and the section treats a missing document as an empty list.
// Todo 扩展同时包含工具和提示词段；两者共享同一个 Todos 文档令牌。
const Todo = defineExtension({
	name: "todo",
	tools: [
		defineTool({
			name: "todo",
			description: "Add an item to your todo list",
			parameters: obj({ item: str() }),
			// execute 是工具调用入口：输入 args（模型参数，已按 schema 校验）、api（本次调用的提交/读取/嵌套调用能力）
			// 与 callContext（取消上下文）。输出 ToolExecutionResult；本实现返回一条文本。
			// 主要流程：先在工具任务里提交待办写入，再把成功文本返回给模型；提交失败会让本次调用失败。
			// 示例：模型调用 todo({item:"fix the build"}) 后，文档变为 {items:["fix the build"]}，模型收到 "added fix the build"。
			execute: async (args, api, callContext) => {
				// api.commit 以本次工具任务为边界提交；回调内的 tx 与生成任务的事务相互独立。
				// tx.doc 首次使用会按 initial 创建文档，因此不需要提前初始化。
				await api.commit(async (tx) => {
					// push 修改 Draft；提交结束时把数组变化保存为文档增量。
					(await tx.doc(Todos, api.conversationId)).items.push(args.item);
				}, callContext);
				// 返回值进入 transcript 的工具结果；output 数组可含多种内容块。
				return { output: [{ type: "text", text: `added ${args.item}` }] };
			},
		}),
	],
	sections: [
		// section 的 render 在每次准备模型请求时运行：输入 PromptInput（含 conversationId、agent、read 等）
		// 与 renderContext。输出 string 或 undefined；无写入副作用，读取失败会让请求准备失败。
		// 示例：文档为 {items:["fix the build"]} 时返回 "fix the build"，渲染层再包成 <todos>...</todos>。
		section("todos", async (input, renderContext) => {
			// input.read.snapshot 只读已提交值；文档尚未创建时返回 undefined。
			const todos = await input.read.snapshot(Todos, input.conversationId, renderContext);
			// 缺失或空列表都返回 undefined，表示本段不出现；否则把条目按行连接。
			return todos === undefined || todos.items.length === 0 ? undefined : todos.items.join("\n");
		}),
	],
});

// faux 是脚本化 provider：记录 setResponses 的队列，并按生成轮次依次返回。
const faux = fauxProvider();
const models = createModels();
// setProvider 按 provider id 注册；root 的 agent.model.provider 必须与 "faux" 匹配。
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(Todo);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// root 首次创建时把模型选择写入 AgentDoc；模型 ID faux-1 由 faux provider 提供。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// 三条响应按顺序消费：第一条触发工具调用，工具结果回来后第二轮生成消费第二条；
// 第二次提交消费第三条。若响应数量不足，faux provider 会报错而不是访问网络。
faux.setResponses([
	// fauxToolCall("todo", {item}) 构造一个 ToolCall 内容块；stopReason:"toolUse" 表示模型要求执行工具。
	fauxAssistantMessage(fauxToolCall("todo", { item: "fix the build" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("Noted."),
	fauxAssistantMessage("Working on it."),
]);
// submit 先持久化用户输入，再启动生成；wait 等到提交结算（本轮所有生成与工具调用完成）。
// 第一次生成时文档为空，section 无文本；工具写入后第二轮生成才会带上新 section。
await (await root.submit({ type: "input", content: "Remember to fix the build." }, context)).wait(context);
// 工具提交已写入文档，因此这里是 {items:["fix the build"]}。
console.log("todos:", await harness.snapshot(Todos, root.id, context));

// The next request's system prompt carries the list. The first system message
// only announced the todo tool; no section had text yet.
// 第二次提交只问问题，不触发工具；此时 section 文本与已生效内容相同，因此不会新增 system 消息。
await (await root.submit({ type: "input", content: "What is next?" }, context)).wait(context);
// root.context 返回最终请求消息视图；这里只挑出 system 消息观察增量。
const { messages } = await root.context(context);
// flatMap：system 消息映射为一个摘要对象，其他角色映射为空数组并被展平丢弃。
// toolsAdded 可选，?.map 只在有值时取工具名。
console.log(
	"system messages:",
	messages.flatMap((message) =>
		message.role === "system"
			? [{ sections: message.sections, toolsAdded: message.toolsAdded?.map((tool) => tool.name) }]
			: [],
	),
);

// 关闭 Harness；faux provider 与文档都只存在于本进程。
await harness.close(context);
