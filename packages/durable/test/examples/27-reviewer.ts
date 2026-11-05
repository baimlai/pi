// 文件导读
// 所属：packages/durable/test/examples 的 27-reviewer.ts，Durable 示例系列第 27 个，演示“独立审查会话”。
// 演示内容：主会话使用 big 模型但不发输入；另建一个 ownerless 审查会话，选择 small 模型、CodingTools 与 Reviewer
// 两个扩展、唯一 read 工具和独立 worktree 目录。Reviewer 的 GenerationTask onYield 钩子在回答不含结束标记时追加
// “再检查一遍”的继续输入，直到回答包含 No further findings。最后按时间正序打印审查会话的输入与发现。
// 上游入口：node 直接运行本文件；固定 faux 响应，无 API key；read 工具会真实读取临时目录中的 user.ts。
// 下游依赖：Durable 的 Harness/defineExtension/hook/GenerationTask/section/AssistantEntry/createReadTool/NodeExecutionEnv。
// 能力清单：textOf 纯函数；Reviewer 扩展与 onYield 循环；DONE 标记；临时 worktree 与夹具；两个假模型；
// createConversation 的完整 agent 配置；agent 查询；entries 分页与反序打印。
// 典型顺序：定义扩展 -> 写夹具 -> 配置 faux -> 安装扩展并打开 Harness -> 创建 root 与 reviewer ->
// 打印解析后的 agent -> 提交审查并等待循环结束 -> 打印记录 -> 清理。
// 前置条件：无需网络；不执行 git worktree，也不做真实代码审查；read 只读夹具。
// 预期输出：reviewer 的模型 small、扩展名顺序、工具名 [read]、cwd 匹配 true；随后一条初始输入、一条继续输入与两条审查发现。
// 阅读顺序：先看 textOf 与 Reviewer 的 onYield，再看 createConversation 的配置字段，最后看记录如何按正序打印。
// 演示独立审查会话的模型、角色、只读工具和回答后续查；使用固定 faux 响应，不进行真实代码审查。
// A reviewer agent next to the main one: a cheaper model, a review role and loop, read-only tools, and its own
// checkout of the project.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/27-reviewer.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// import type 只提供编译期类型，擦除后不产生运行时导入；AssistantEntry.is 才是运行时记录判别。
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
// NodeExecutionEnv 负责真实文件读取；cwd 只决定解析相对路径的目录，不是权限沙箱。
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	MemoryStorage,
	section,
} from "../../src/index.ts";
// CodingTools 提供完整编码工具；createReadTool 创建独立的只读工具实例，供 reviewer 的 tools 白名单使用。
import { CodingTools, createReadTool } from "../../src/tools/index.ts";

// 顶层步骤按 await 顺序执行，失败直接传播；假模型不会访问供应商，但 read 会读取临时夹具。
const context = BACKGROUND_CONTEXT;
// 纯函数接收 AssistantMessage，返回所有文本块拼接串，忽略工具/思考等块。
// flatMap 回调对文本返回单元素数组，对其他块返回 []；例如两个文本块 "a"/"b" 得到 "ab"。
const textOf = (message: AssistantMessage) =>
	message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

// ─── Product code: the reviewer extension ───────────────────────────────────

// 审查结束的文本标记；只是字符串约定，不是结构化完成证明。
const DONE = "No further findings.";
// A role and a review loop: every answer that still has findings gets a second pass.
// 声明带角色提示词和 onYield 钩子的扩展。
const Reviewer = defineExtension({
	name: "reviewer",
	// section 的无参数回调返回审查指令；实际只读工具名单在会话设置中指定。
	sections: [section("role", () => `You review diffs. Report problems as a list. Never edit files.`)],
	// 将处理器注册到内置 GenerationTask 的生命周期。
	hooks: [
		hook(GenerationTask, {
			// 收到最终回答时提取文本：含 DONE 返回 undefined，其他情况返回继续检查的用户输入。
			// 这会延长同一 run；该回调本身不限制次数，若回答一直不含标记就可能一直继续。
			onYield: (answer) =>
				textOf(answer).includes(DONE)
					? undefined
					: { continue: `Look again for anything you missed. Say "${DONE}" when there is nothing left.` },
		}),
	],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

// The reviewer works in its own checkout, in practice a `git worktree add`.
// 这里只创建临时目录模拟 checkout，没有执行 git worktree 或复制完整项目。
const worktree = await mkdtemp(join(tmpdir(), "pi-durable-review-"));
// 写入一个故意缺少类型与空值处理的 user.ts 夹具。
await writeFile(join(worktree, "user.ts"), "export const name = (user) => user.name;\n");

// 用两个假模型 ID 模拟主代理和便宜审查模型；并未计价或调用真实模型。
const faux = fauxProvider({ models: [{ id: "big" }, { id: "small" }] });
// 创建模型目录供 Harness 解析 provider/modelId。
const models = createModels();
// 注册假 provider。
models.setProvider(faux.provider);
// 顺序安排读文件、第一条发现、带结束标记的第二条发现。
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("read", { path: "user.ts" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("1. `name` does not handle a missing user."),
	fauxAssistantMessage(`2. \`user\` has no type. ${DONE}`),
]);

// 建立应用扩展注册表。
const registry = createRegistry();
// 安装内置编码工具定义。
registry.install(CodingTools);
// 安装审查扩展，随后由审查会话显式选择。
registry.install(Reviewer);
// 打开内存 Harness；主代理默认只用 CodingTools，env 依据各会话 cwd 创建环境。
const harness = await Harness.open(
	new MemoryStorage(),
	// The main agent selects only CodingTools; the reviewer opts in.
	{
		models,
		registry,
		settings: { extensions: [CodingTools] },
		// 环境工厂接收可选 cwd，缺省用进程目录；这里只设置工具工作目录，不提供隔离边界。
		env: ({ cwd = process.cwd() }) => new NodeExecutionEnv({ cwd }),
	},
	context,
);
// 创建主会话并存储 big 模型引用；本例没有向它发送输入。
await harness.root(context, { agent: { model: { provider: "faux", modelId: "big" } } });

// Everything the reviewer is, stored on its conversation: the model, exactly these extensions in this order, only
// the read tool, and its directory. A restart keeps all of it.
// 创建独立 ownerless 会话；agent 内各字段会存为会话配置，不会复用根会话的 run。
const reviewer = await harness.createConversation(
	{
		// ownerless 表示没有任务拥有它，不等同于子任务。
		ownership: { kind: "ownerless" },
		// 此会话显式选择 small、两个有序扩展、唯一 read 工具及临时目录。
		agent: {
			model: { provider: "faux", modelId: "small" },
			extensions: [CodingTools, Reviewer],
			tools: [createReadTool()],
			cwd: worktree,
		},
	},
	context,
);
// 读取当前解析结果，用于输出实际生效的配置。
const agent = await reviewer.agent(context);
// 打印模型 ID、扩展顺序、工具名单和目录比较结果；map 回调只提取名称。
console.log(
	"reviewer:",
	agent.model?.modelId,
	agent.extensions.map((extension) => extension.name),
	agent.tools.map((tool) => tool.name),
	agent.cwd === worktree,
);

// 提交审查输入并等待；第一次回答触发钩子继续，第二次含 DONE 才结束。
await (await reviewer.submit({ type: "input", content: "Review user.ts." }, context)).wait(context);
// 默认逆序扫描最近二十条记录；示例未处理超过一页的历史。
const page = await reviewer.entries({}, 20, undefined, context);
// 展开复制数组后 reverse，避免反转 page.items 本身，以时间正序显示。
for (const entry of [...page.items].reverse()) {
	// 取记录上第一条模型消息；非模型记录可能没有它。
	const message = entry.model?.[0];
	// 可选链先排除无消息情况，仅打印用户输入。
	if (message?.role === "user") console.log(">", message.content);
	// 用记录令牌判断助手记录并忽略空文本；as AssistantMessage 只影响类型，不检查消息内容。
	if (AssistantEntry.is(entry) && textOf(message as AssistantMessage) !== "") {
		// 输出拼接后的审查文字。
		console.log("reviewer:", textOf(message as AssistantMessage));
	}
}

// 关闭 Harness 管理的任务与会话资源；之后才删除 worktree 目录。
await harness.close(context);
// 递归删除临时审查目录；示例没有 finally，异常路径不会自动执行到这里。
await rm(worktree, { recursive: true, force: true });
