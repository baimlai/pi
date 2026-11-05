// 文件导读
// 所属：packages/durable/test/examples 的 26-plan-mode.ts，Durable 示例系列第 26 个，演示“计划模式与工具筛选”。
// 演示内容：普通模式使用内置 CodingTools；会话 configure 进入计划模式后只提供 read 与 submit_plan 两个工具，
// 模型先读 server.ts，再把计划步骤写入扩展自己的 PlanDoc；退出计划模式后恢复完整工具集。最后打印模型上下文中的
// 系统消息，观察扩展与工具的增删如何作为提示词变化记录。
// 上游入口：node 直接运行本文件；脚本化 faux 模型，无 API key；真实磁盘上创建并删除临时目录。
// 下游依赖：Durable 的 Harness/defineDoc/defineExtension/defineTool/section/createReadTool/CodingTools/NodeExecutionEnv，pi-schema 参数。
// 能力清单：PlanDoc 文档（rewindable/asOf）；submitPlan 工具；Plan 扩展；enterPlanMode/leavePlanMode 配置对象；
// read 工具工厂；faux 三步脚本；tools 查询；系统消息 diff 打印。
// 典型顺序：定义文档与工具 -> 打包扩展 -> 写临时夹具 -> 配置 faux -> 安装扩展并打开 Harness -> 查看默认工具 ->
// 进入计划模式 -> 读文件并提交计划 -> 退出并查看工具 -> 打印系统消息变化 -> 清理。
// 前置条件：无需网络；工具会真实读取临时目录中的 server.ts；示例只读取，不修改该文件。
// 预期输出：默认工具列表、计划模式下的 [read, submit_plan]、计划步骤数组、退出后的完整工具列表，以及两条 system 记录。
// 阅读顺序：先看 PlanDoc 的存储语义，再看 submitPlan 如何在事务里写文档，然后看进入/退出模式的配置对象，
// 最后看 faux 脚本与系统消息输出。
// 通过文档保存计划，并以会话配置限制工具：只读模式是本例的工具选择策略，不是操作系统权限隔离。
// Plan mode: the user switches a conversation into a read-only planning mode, the agent writes a plan into the
// extension's own document, and switching back restores the full tool set.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/26-plan-mode.ts

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
// pi-schema 的组合子：obj/arr/str 生成 JSON Schema，同时推导 execute 参数类型；Harness 在运行时据此校验。
import { arr, obj, str } from "@earendil-works/pi-schema";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";
// CodingTools 是普通模式的完整工具扩展；createReadTool 按需创建单个只读文件工具实例。
import { CodingTools, createReadTool } from "../../src/tools/index.ts";

// 所有顶层 await 顺序执行；此例没有异常清理 finally，IO/运行失败会直接拒绝模块执行。
const context = BACKGROUND_CONTEXT;

// ─── Product code: the plan extension ───────────────────────────────────────

// The current plan of a conversation. A fork keeps the plan it had at the fork entry.
// 泛型 {steps:string[]} 描述 TS 文档内容；defineDoc 声明存储策略，不是在这里运行内容校验。
const PlanDoc = defineDoc<{ steps: string[] }>({
	// 无参数判定回调总返回 false，不主动按此策略产生检查点。
	checkpointWhen: () => false,
	// 文档种类与版本用于寻址及迁移识别。
	kind: "app.plan",
	version: 1,
	// 每个会话有自己的计划文档。
	scope: "conversation",
	// 保留可回退历史，使 asOf fork 能取分叉位置的计划。
	history: "rewindable",
	// 分叉时复制分叉记录所对应的历史状态。
	fork: "asOf",
	// 无参数初值工厂每次返回独立 steps 数组；例如新会话计划从空列表开始。
	initial: () => ({ steps: [] }),
});

// 声明供模型调用的工具；参数 schema 既推导 args 的 TS 类型，也供 Harness 在执行前运行时校验。
const submitPlan = defineTool({
	name: "submit_plan",
	description: "Submit the plan as a list of steps.",
	// 参数必须含由字符串组成的 steps 数组；这不是自然语言提示词校验。
	parameters: obj({ steps: arr(str()) }),
	// 工具回调接收已校验 args、会话 API 和调用上下文，写计划后返回文本及 terminate 控制。
	// 例如 steps=["读配置"] 会保存该列表；提交失败直接抛出，不伪造成功结果。
	execute: async (args, api, callContext) => {
		// 事务回调拿到 tx，把本次计划修改作为一次提交保存；await 等提交完成。
		await api.commit(async (tx) => {
			// 取得当前会话的可变文档草稿，整体替换 steps；改变草稿由提交记录，不是 snapshot 原地修改。
			(await tx.doc(PlanDoc, api.conversationId)).steps = args.steps;
		}, callContext);
		// 返回模型可读结果；此轮所有工具都 terminate 时不再自然请求下一次回答，队列输入仍可能继续。
		return { output: [{ type: "text", text: "Plan submitted." }], control: { terminate: true } };
	},
});

// 把工具与计划模式提示词打包，是否启用由会话扩展选择决定。
const Plan = defineExtension({
	name: "plan",
	tools: [submitPlan],
	sections: [
		// 无参数渲染回调返回固定指令；实际禁止编辑靠下方工具筛选，而非文字本身。
		section("plan_mode", () => "You are in plan mode. Read the code, then call submit_plan. Change nothing."),
	],
});

// Plan mode is a change to the conversation's agent: select the plan extension and offer only reading and
// submitting. Clearing both returns to the host's default selection and every tool.
// 取得只读文件工具定义，此时不读任何文件。
const read = createReadTool();
// 进入配置在默认扩展上追加 Plan，并精确启用 read 与 submit_plan 两个工具。
const enterPlanMode = { extensions: { add: [Plan] }, tools: [read, submitPlan] };
// null 清除会话覆盖项，恢复宿主默认扩展选择和未过滤的工具集；undefined 才表示不修改。
const leavePlanMode = { extensions: null, tools: null };

// ─── Host setup ─────────────────────────────────────────────────────────────

// 创建真实临时目录，作为 read 工具的工作目录。
const directory = await mkdtemp(join(tmpdir(), "pi-durable-plan-"));
// 写入固定 server.ts 夹具；不是让模型修改实际项目。
await writeFile(join(directory, "server.ts"), "app.listen(3000);\n");

// 创建无网络假 provider，下面三条响应确定整个示例轨迹。
const faux = fauxProvider();
// 创建模型目录并在下一行注册 faux provider。
const models = createModels();
// 注册后 provider=faux/modelId=faux-1 可以解析。
models.setProvider(faux.provider);
// 依次让代理读文件、提交计划、退出计划后回答；固定响应不代表真实推理。
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("read", { path: "server.ts" }), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxToolCall("submit_plan", { steps: ["Read PORT from the environment", "Default to 3000"] }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("Implementing step 1."),
]);

// 创建应用扩展注册表。
const registry = createRegistry();
// 安装编码工具供普通模式使用。
registry.install(CodingTools);
// 安装 Plan 只使它可选，不代表默认激活。
registry.install(Plan);
// 在内存存储上打开 Harness；options 给出默认扩展和每次调用所建的 Node 文件环境。
const harness = await Harness.open(
	new MemoryStorage(),
	// Installed, but only CodingTools is selected by default: conversations opt into plan mode.
	// 默认只选 CodingTools；env 无参数工厂返回 directory 中的环境，可能有真实磁盘读写。
	{ models, registry, settings: { extensions: [CodingTools] }, env: () => new NodeExecutionEnv({ cwd: directory }) },
	context,
);
// 创建根会话并指定假模型。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
// 无参数异步查询返回当前解析工具名称数组；map 只提取 name，无工具执行副作用。
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
// 打印初始可用工具集。
console.log("tools:", await tools());

// 提交进入模式配置；下一次解析会采用受限工具集。
await root.configure(enterPlanMode, context);
// 显示限制是否体现在解析后的工具名单中。
console.log("plan mode tools:", await tools());
// 提交请求并等待，脚本响应实际执行 read 和 submit_plan。
await (await root.submit({ type: "input", content: "Make the port configurable." }, context)).wait(context);
// 以已提交快照读取计划；?. 在不存在文档时得到 undefined。
console.log("plan:", (await harness.snapshot(PlanDoc, root.id, context))?.steps);

// 清除覆盖项，让后续会话请求恢复普通工具集。
await root.configure(leavePlanMode, context);
// 再次列出当前工具名称。
console.log("tools again:", await tools());
// 提交新输入；脚本只回答 Implementing，不真正实现计划。
await (await root.submit({ type: "input", content: "Go ahead." }, context)).wait(context);

// The model saw each switch as a system prompt change in its transcript.
// 解构已准备的模型上下文，其中系统消息保留提示词/工具变化信息。
const { messages } = await root.context(context);
// 遍历上下文消息，下面仅输出 system 类型。
for (const message of messages) {
	// continue 跳过用户、助手及工具消息，同时让 TS 将余下分支缩窄为系统消息。
	if (message.role !== "system") continue;
	// 打印段落状态及新增/移除工具名称；两个 ?.map 在没有变更字段时返回 undefined。
	console.log("system:", {
		// A null section value removes it.
		sections: message.sections,
		added: message.toolsAdded?.map((tool) => tool.name),
		removed: message.toolsRemoved?.map((tool) => tool.name),
	});
}

// 关闭 Harness 后再删除本示例临时文件。
await harness.close(context);
// 递归移除示例目录；前面若抛错不会自动运行到这一行。
await rm(directory, { recursive: true, force: true });
