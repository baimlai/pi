// 演示同名工具覆盖与后置包装：使用最小激活脚本和假模型，命令执行仍有真实副作用。
// Replace a tool for some conversations, and decorate whichever tool wins: a bash that runs inside a Python
// virtualenv, and a wrapper that times every bash call.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/29-tool-override.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	ToolResultEntry,
	wrapTool,
} from "../../src/index.ts";
import { CodingTools, createBashTool } from "../../src/tools/index.ts";

// 顶层 await 顺序执行；假模型无网络，bash 和临时激活脚本仍是真实宿主操作。
const context = BACKGROUND_CONTEXT;

// ─── Product code ───────────────────────────────────────────────────────────

// A bash with the same name: where selected after CodingTools, it replaces CodingTools' bash in place.
// 声明同名 bash 覆盖扩展；选在 CodingTools 之后时，名称相同的后者替换前者。
const Venv = defineExtension({
	name: "venv",
	// commandPrefix 在每条 bash 命令前追加 source；这里只创建定义，不启动 shell。
	tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
});

// Wraps the bash that won, whichever it is. Wrappers never capture a base tool, so reloading either bash keeps it.
// number[] 约束累计毫秒数数组；它只在本进程中保存，不随 MemoryStorage 持久化。
const timings: number[] = [];
// 声明只包装工具、不提供替代 bash 的计时扩展。
const Timing = defineExtension({
	name: "timing",
	wraps: [
		// 包装工厂接收最终胜出的 bash，返回保留原字段的新定义；对象展开 ...bash 复制工具字段。
		// wrapTool 仅按 name 定位，故无论 Venv 是否胜出都计时，未执行底层工具。
		wrapTool(createBashTool(), (bash) => ({
			...bash,
			// 执行回调接收原 args/api/context，返回底层结果；失败继续抛出，但 finally 仍记耗时。
			execute: async (args, api, callContext) => {
				// Date.now 记录墙钟毫秒，不是 CPU 时间或单调性能计时。
				const start = Date.now();
				// try/finally 保证成功与异常都走计时收尾。
				try {
					// await 使计时覆盖整个异步调用，返回值原样传递给 Harness。
					return await bash.execute(args, api, callContext);
					// 底层调用落定后执行，无论返回或抛错。
				} finally {
					// 把当前墙钟与开始的差追加到共享统计数组，不改工具结果。
					timings.push(Date.now() - start);
				}
			},
		})),
	],
});

// ─── Host setup ─────────────────────────────────────────────────────────────

// 创建本例真实临时项目。
const project = await mkdtemp(join(tmpdir(), "pi-durable-venv-"));
// 递归建立 .venv/bin；此例没有创建真正的 Python 虚拟环境。
await mkdir(join(project, ".venv/bin"), { recursive: true });
// 写最小 activate 脚本，只设置 VIRTUAL_ENV 环境变量。
await writeFile(join(project, ".venv/bin/activate"), `export VIRTUAL_ENV="${project}/.venv"\n`);

// 创建假 provider。
const faux = fauxProvider();
// 建立模型目录。
const models = createModels();
// 注册假 provider。
models.setProvider(faux.provider);
// 无参数工厂返回 echo 探针工具消息；其中 $VIRTUAL_ENV 在工具真正运行的 shell 中展开。
const probe = () =>
	fauxAssistantMessage(fauxToolCall("bash", { command: "echo venv: $VIRTUAL_ENV" }), {
		stopReason: "toolUse",
	});
// 安排普通会话与附加 Venv 的会话各运行一次探针。
faux.setResponses([probe(), fauxAssistantMessage("Done."), probe(), fauxAssistantMessage("Done.")]);

// 建立应用注册表。
const registry = createRegistry();
// 安装基础工具集。
registry.install(CodingTools);
// 安装计时包装。
registry.install(Timing);
// 只安装虚拟环境扩展，是否选用仍由会话决定。
registry.install(Venv);
// 打开内存 Harness，默认只选 CodingTools+Timing；env 工厂始终给 project 目录。
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		// Venv is installed but not selected by default.
		settings: { extensions: [CodingTools, Timing] },
		// 无参数工厂每次构造 Node 环境，不执行激活脚本；脚本由 bash 前缀执行。
		env: () => new NodeExecutionEnv({ cwd: project }),
	},
	context,
);
// 共享假模型引用，用于两个独立会话。
const model = { provider: "faux", modelId: "faux-1" };
// 根会话沿用默认扩展选择。
const plain = await harness.root(context, { agent: { model } });
// 新 ownerless 会话在默认集末尾追加 Venv，同名 bash 因此被替换。
const python = await harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { model, extensions: { add: [Venv] } } },
	context,
);

// 接收一个 Conversation，提交探针并等待，读取最新工具文本，返回字符串；调用会真实执行 shell。
// 例如普通会话环境变量为空，python 会话带项目 .venv；as 断言不校验结果存在，缺失时会抛错。
async function probeBash(conversation: Conversation): Promise<string> {
	// 外层 await 等输入运行落定，内层 await 等输入接纳。
	await (await conversation.submit({ type: "input", content: "Which venv?" }, context)).wait(context);
	// 默认逆序取十条记录，不请求第二页。
	const page = await conversation.entries({}, 10, undefined, context);
	// find 回调定位工具结果记录，?. 取首条消息；as 仅改变 TS 看法。
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	// 逐块保留 trim 后文本，忽略其他类型块，再拼接。
	return result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
}

// 运行普通会话并打印 shell 环境变量探针。
console.log("plain conversation:", await probeBash(plain));
// 运行带覆盖工具的会话；replace 只将输出中的临时绝对路径替换为演示占位文字。
console.log("python conversation:", (await probeBash(python)).replace(project, "<project>"));
// 打印包装器实际记录次数，不在此断言耗时值。
console.log("timed bash calls:", timings.length);

// 关闭 Harness。
await harness.close(context);
// 删除真实临时目录；本例无 finally，失败时不保证运行到这里。
await rm(project, { recursive: true, force: true });
