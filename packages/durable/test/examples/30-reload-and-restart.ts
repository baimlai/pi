// 文件导读
// 所属：packages/durable/test/examples 的 30-reload-and-restart.ts，Durable 示例系列第 30 个，演示“扩展热替换与重开”。
// 演示内容：versioned 扩展的 version 工具先被门闩挂住；运行中把注册表里的同名扩展从 v1 换成 v2，旧调用仍返回 v1，
// 下一次调用返回 v2。随后关闭 Harness，用同一 sqlite 文件和空注册表重开：会话仍保存扩展名 versioned，
// 但未安装代码时解析不出 version 工具；安装 v3 后工具重新出现。
// 上游入口：node 直接运行本文件；固定 faux 响应，无网络；sqlite 文件在临时目录中。
// 下游依赖：Durable 的 Harness/defineExtension/defineTool/createRegistry，Node sqlite 存储，pi-schema 参数。
// 能力清单：loadVersioned 闭包工厂；started/gate 两个同步点；lastResult 读取工具文本；热替换；
// 两轮 open；重开后 before/after install 工具查询。
// 典型顺序：定义版本化扩展 -> 配置 faux -> 首次打开并建根会话 -> 提交并等工具开始 -> 安装 v2 -> 放行 v1 ->
// 第二次调用验证 v2 -> 关闭 -> 空注册表重开 -> 查看工具 -> 安装 v3 -> 查看工具 -> 清理。
// 前置条件：无需 API key；没有真正启动第二个 OS 进程，重开只是新的 Harness 连接同一 sqlite 文件。
// 预期输出：热替换期间的调用为 v1，下一次为 v2；重开后未安装时工具列表为空，安装后为 [version]。
// 阅读顺序：先看 loadVersioned 如何用闭包捕获版本，再看门闩与热替换顺序，最后看重开前后的名字解析。
// 演示同名扩展热替换与重开恢复：进行中的回调保留旧闭包，持久配置只保存名字。
// Reload an extension while a call runs, then restart the process. Running work finishes on the code it started
// with; stored choices are names, so they survive a restart and bind to whatever code the new process installs.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/30-reload-and-restart.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// import type 只提供编译期类型；ToolResultEntry.is 才是运行时记录判别。
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import { createRegistry, defineExtension, defineTool, Harness, ToolResultEntry } from "../../src/index.ts";
// sqlite 存储让关闭后的第二轮 Harness 读取同一份任务、条目与配置；路径由临时目录拼接。
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

// 此例用 SQLite 文件模拟关闭后重开；没有真的启动第二个 OS 进程，异常向顶层传播。
const context = BACKGROUND_CONTEXT;

// Stand-in for code loaded from disk: each call builds the extension as the file currently reads.
// 无参数 void 回调初始为空操作，稍后替换为通知工具已进入执行的 Promise resolve。
let started = (): void => {};
// 初始已完成 Promise<void>；稍后替换为阻塞工具的门闩。
let gate = Promise.resolve();
// 接收版本字符串，返回同名扩展的新代码定义；闭包让 execute 记住本次 version。
// 例如 v1 调用即使注册表换成 v2，仍返回 v1；函数不加载真实文件，构造阶段无 IO。
function loadVersioned(version: string) {
	// 返回名为 versioned 的扩展对象，安装到注册表才会被解析使用。
	return defineExtension({
		name: "versioned",
		// 每个版本提供同一个 version 工具名。
		tools: [
			defineTool({
				name: "version",
				description: "Report the tool's code version",
				// 空对象 schema 说明没有必需业务参数；Harness 执行前按 schema 校验。
				parameters: obj({}),
				// 无参数异步工具回调先通知 started，再等待共享 gate，最后返回闭包版本文字；等待错误继续传播。
				execute: async () => {
					// 触发宿主已开始信号，不改变 version。
					started();
					// 等待宿主释放，制造可以安装新版本的时间窗口。
					await gate;
					// 返回定义此工具时捕获的版本，而非重新从注册表查找。
					return { output: [{ type: "text", text: version }] };
				},
			}),
		],
	});
}

// 创建本地假 provider。
const faux = fauxProvider();
// 创建模型目录。
const models = createModels();
// 登记 faux 模型。
models.setProvider(faux.provider);
// 无参数纯消息工厂返回调用 version 的助手消息，不在这里执行。
const callVersion = () => fauxAssistantMessage(fauxToolCall("version", {}), { stopReason: "toolUse" });
// 准备两次 version 调用及最终回答，不请求真实模型。
faux.setResponses([callVersion(), fauxAssistantMessage("Done."), callVersion(), fauxAssistantMessage("Done.")]);

// 创建存放真实 SQLite 文件的临时目录。
const directory = await mkdtemp(join(tmpdir(), "pi-durable-reload-"));
// 异步工厂接收注册表，返回打开同一路径的 Harness；ReturnType<typeof createRegistry> 在 TS 中提取工厂返回类型。
// 每次新建 SQLite 连接，但共用 models；IO/打开失败直接拒绝 Promise。
const open = async (registry: ReturnType<typeof createRegistry>) =>
	Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, context);

// First process.
// 首轮创建注册表；let 允许模拟重启时替换整个对象。
// 用新注册表模拟新进程尚未加载任何应用扩展。
let registry = createRegistry();
// 安装 v1 实现。
registry.install(loadVersioned("v1"));
// 第一次打开 Harness，连接临时数据库；下面第二轮会用同一路径重开，
// 从而观察持久配置与注册表代码的分离。
let harness = await open(registry);
// 创建根会话；扩展对象在 configure 流程中被保存为名字，不保存闭包代码。
let root = await harness.root(context, {
	// Selected by name. The name is what is stored, never the code.
	agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [loadVersioned("v1")] },
});
// 无参数异步查询读最近工具文本；捕获可重新赋值的 root，因此重开后也指向当前会话。
// 缺少结果时 as ToolResultMessage 不会运行时保护，访问 content 会抛错。
const lastResult = async () => {
	// 读取最近十条，默认逆序。
	const page = await root.entries({}, 10, undefined, context);
	// find 回调用类型令牌找到工具记录，并取其首条模型消息。
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	// 回调只取文本块，不 trim，按顺序拼接后返回。
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

// The file changes while a call runs: the running call finishes on v1, the next call uses v2.
// 门闩释放函数先为空，下面 Promise 构造时马上赋为 resolve。
let release = (): void => {};
// 创建待完成门闩；executor 同步运行，没有延时才赋值的问题。
gate = new Promise((resolve) => {
	// 保存 resolve，调用 release() 会让工具的 await gate 继续。
	release = resolve;
});
// 另建开始信号，泛型 void 说明 resolve 不需要结果值。
const running = new Promise<void>((resolve) => {
	// 保存通知回调，execute 开始时调用它。
	started = resolve;
});
// 提交首次输入并取得句柄，此时工具仍被 gate 挂起。
const submission = await root.submit({ type: "input", content: "Which version?" }, context);
// 等待确认 v1 工具进入执行，再进行热替换。
await running;
// 同名安装发布新快照；已经执行的 v1 函数不被中途替换。
registry.install(loadVersioned("v2"));
// 释放 v1 等待，允许其返回捕获的 v1。
release();
// 等待第一次输入完成，确保可读取结果。
await submission.wait(context);
// 输出热替换期间那次调用的版本。
console.log("call running during the reload:", await lastResult());
// 第二次输入重新解析工具，故会用 v2；gate 已释放，不再阻塞。
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
// 打印后续调用结果。
console.log("next call:", await lastResult());
// 关闭第一轮 Harness/SQLite，保留数据库文件供重开。
await harness.close(context);

// Second process: the conversation still selects "versioned", but this process has not installed it yet.
registry = createRegistry();
harness = await open(registry);
// 取得已存在根会话，没有覆盖其之前保存的扩展选择。
root = await harness.root(context);
// 无参数异步查询返回当前解析工具名称数组；缺失的注册表名字会被解析时跳过。
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
// 展示只保存名字但尚未安装代码时没有 version 工具。
console.log("after restart, before install:", await tools());
// 发布 v3 定义，使原来保存的 versioned 名字重新可解析。
registry.install(loadVersioned("v3"));
// 无需再 configure 即可看到 version 工具；本例此处未再次执行它。
console.log("after install:", await tools());

await harness.close(context);
// 删除 SQLite 临时目录；示例没有 finally，前面失败时不会自动清理。
await rm(directory, { recursive: true, force: true });
