// 演示会话 cwd 与动态设置：假模型按脚本请求工具，但 bash 的 pwd 和临时目录操作是真实宿主 IO。
// A small coding agent: the built-in coding tools, a prompt that knows the working directory, settings backed by the
// app's settings file, and an environment that follows the conversation's directory.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/25-coding-agent.ts
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	ToolResultEntry,
} from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

// 本示例顶层按顺序执行；await 等待异步完成，失败会向模块调用者传播，没有 try/finally 兜底清理。
// BACKGROUND_CONTEXT 是传递给读写和任务操作的上下文，不是对文件系统的沙箱限制。
const context = BACKGROUND_CONTEXT;
// 在系统临时目录创建独立项目路径；这里是真实磁盘目录，不是 MemoryStorage 中的文档。
const workspace = await mkdtemp(join(tmpdir(), "pi-durable-agent-"));
// 创建下一次切换工作目录要使用的 app 子目录。
await mkdir(join(workspace, "app"));

// The app's own prompt, next to the coding tools.
// 声明 coding 扩展；defineExtension 主要提供 TS 类型约束，安装步骤在后面。
const Coding = defineExtension({
	// 扩展的稳定名字用于会话选择和后续代码替换。
	name: "coding",
	// 请求准备时按顺序渲染这两段系统提示词；这些函数不调用模型。
	sections: [
		// 无参数回调返回固定角色说明；tag:false 让它不包裹 XML 风格段落标签。
		section("preamble", () => "You are a coding agent. Use the tools to inspect the project.", { tag: false }),
		// input 是本次请求的 PromptInput；?. 在没有执行环境时返回 undefined，这一段就不显示。
		section("cwd", (input) => input.env?.cwd),
	],
});
// 创建应用持有的注册表；内置 generation/tool/compaction 任务已经存在。
const registry = createRegistry();
// 安装内置读写、编辑、shell 等工具扩展，尚未执行任何工具。
registry.install(CodingTools);
// 把提示词扩展加入注册表，默认选择可包含它。
registry.install(Coding);

// Settings the user edits while the agent runs, like a settings.json the app watches. The getters make every
// Harness read see the current file; nothing is copied or stored.
// 用普通可变对象模拟应用持续更新的设置文件；示例没有监听真实 settings.json。
const userSettings = { parallelTools: true, maxRetries: 3 };
// : HarnessSettings 只在开发时检查字段类型，不会运行时读取设置文件。
const settings: HarnessSettings = {
	// getter 在每次读取时计算当前工具执行方式；无参数，返回并行或顺序字符串，无额外 IO。
	// 例如 parallelTools 改成 false 后，下一次读取返回 sequential。
	get toolExecution() {
		// 三元表达式根据最新设置选择两种已定义的模式。
		return userSettings.parallelTools ? "parallel" : "sequential";
	},
	// getter 无参数，返回当前重试次数对象；每次访问都构造新对象，不会启动重试。
	get retry() {
		// 只提供 maxRetries 覆盖项，其余重试设置由 Harness 解析默认值。
		return { maxRetries: userSettings.maxRetries };
	},
};

// The Harness calls this for every tool call and request with the conversation's `cwd`, so changing a conversation's
// directory needs no restart.
// 环境工厂接收含可选 cwd 的只读参数，返回 NodeExecutionEnv；解构默认值在 cwd 为 undefined 时使用 workspace。
// 例如 cwd=workspace/app 时，后续工具在该目录操作；构造失败向调用者传播，不自动切换进程 cwd。
const env = ({ cwd = workspace }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });

// 使用本地脚本化 provider，不访问真实模型；工具仍可能执行真实 shell。
const faux = fauxProvider();
// 创建供 Harness 按 provider/modelId 查找模型的目录。
const models = createModels();
// 把 faux provider 注册进模型目录。
models.setProvider(faux.provider);
// 无参数工厂返回一条调用 bash/pwd 的假助手消息，不执行 pwd；stopReason 告诉 Harness 要执行工具。
const pwd = () => fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
// 顺序安排两次工具调用和两次回答；这些固定文字不证明模型会自主决定相同操作。
faux.setResponses([pwd(), fauxAssistantMessage("Done."), pwd(), fauxAssistantMessage("Done.")]);

// 用内存会话存储打开 Harness；传入模型目录、扩展、动态设置和环境工厂。
const harness = await Harness.open(new MemoryStorage(), { models, registry, settings, env }, context);
// 创建或取得根会话，并保存假模型引用和初始工作目录。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace } });

// 无参数异步辅助函数读取最近十条记录，取第一个工具结果并返回拼接后的文本。
// 它依赖此例确实产生结果；as ToolResultMessage 只是 TS 断言，没有运行时校验，缺失结果会抛错。
const lastBashOutput = async () => {
	// 默认逆序扫描最近十条；undefined 表示不用翻页游标。
	const page = await root.entries({}, 10, undefined, context);
	// find 回调用 Entry 类型令牌判断记录类别；?. 允许查找失败，末尾断言不会补出数据。
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	// map 回调保留并 trim 文本块，其他块变空字符串；join 合并为一个输出字符串。
	return result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
};

// 先持久接纳输入取得 Submission，再等待该输入完成；假消息驱动的 bash 会真实执行 pwd。
await (await root.submit({ type: "input", content: "Where are we?" }, context)).wait(context);
// 读取刚完成的 shell 结果并打印到 stdout。
console.log("bash ran in:", await lastBashOutput());

// The user switches the project directory and turns off parallel tools. Both apply from the next use.
// 只修改该会话保存的 cwd；后续环境创建会看到新目录。
await root.configure({ cwd: join(workspace, "app") }, context);
// 修改宿主设置对象；无需重建 Harness，getter 下一次读取时生效。
userSettings.parallelTools = false;
// 再次提交并等待；这一次环境工厂取 app 目录，顺序模式也已生效。
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("bash ran in:", await lastBashOutput());

// 等待关闭 Harness 与所管理任务，之后才删除项目目录。
await harness.close(context);
// 递归删除本示例创建的临时目录；force 允许路径已经不存在。
await rm(workspace, { recursive: true, force: true });
