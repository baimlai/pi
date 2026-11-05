// 文件导读
// 所属：packages/durable 的 test/examples 系列第 17 个示例，演示类似 `pi -p` 的打印模式：提交一个 prompt，只打印回答。
// 演示内容：从 process.argv 读取 prompt（缺省用固定问题）；有 OPENAI_API_KEY 时注册真实 OpenAI，否则用 faux 脚本
//   （先调用 bash ls，再返回固定回答）；安装含 read/bash 工具与 preamble 段的 coding 扩展；等待自己的 Submission
//   结算而不是全局空闲；成功时把 AssistantEntry 的文本块拼接输出，未回答时写 stderr 并设置退出码 1。
// 上游入口：从命令行直接运行；下游调用 openaiProvider/fauxProvider、createReadTool/createBashTool、defineExtension/
//   section、NodeExecutionEnv、Harness.open/root、Conversation.submit、Submission.wait、Conversation.commit/tx.entry。
//   有 key 时产生真实网络请求与费用；无 key 时只执行本地 bash ls，不联网。
// 能力清单（按演示机制）：
// - process.argv[2] ?? 默认值：命令行第一个参数作为用户输入；?? 只在 undefined/null 时回退。
// - provider 选择：OPENAI_API_KEY !== undefined 用真实 OpenAI；否则 faux 并排队两条响应（ls 工具调用 + 最终文本）。
// - createReadTool()/createBashTool()：构造工具实例；工具通过 Harness 的 ExecutionEnv 访问文件与进程。
// - section("preamble", ..., {tag:false})：固定系统提示段，原样发送。
// - NodeExecutionEnv + env: () => env：所有调用共用同一个以 process.cwd() 为根的环境。
// - submit(...).wait(context)：只等本次输入结算，不等其他会话或后台任务。
// - AssistantEntry + content.flatMap：读取最终回答，只收集 text 块并拼接。
// - process.exitCode = 1：未回答时标记失败，不立即终止进程；close 仍会执行。
// 典型运行顺序：读 argv → 选 provider/模型 → 注册扩展 → 建环境 → open/root → submit → wait → 打印回答或错误 → close。
// 示例（真实命令行）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/17-print.ts "What is in this directory?"
// 无 key 时实际输出：
//   This directory holds the durable package sources, tests, and docs.
// 有 key 时回答由真实模型生成，内容与耗时不定；认证失败等错误会让上面的 await 拒绝。
// 阅读顺序：先看 argv 与 provider 分支，再看工具扩展与 env 工厂，随后看 submit/wait 与终态判断，最后看文本拼接和退出码。
// 前置条件：无 key 时依赖本地 bash 执行 ls；有 key 时需要网络与额度。MemoryStorage 不持久化。
// Print mode: submit one prompt and print its answer, like `pi -p`. The host awaits its own Submission, not global
// idle. Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/17-print.ts "What is in this directory?"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// AssistantMessage 是 type-only 导入，用于把 AssistantEntry 的首条消息断言成已知形状。
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { AssistantEntry, createRegistry, defineExtension, Harness, MemoryStorage, section } from "../../src/index.ts";
// 工具工厂直接返回可注册的工具对象；本示例只需要 read 与 bash。
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;
// argv[0] 是 node，argv[1] 是脚本路径，argv[2] 才是用户 prompt；?? 只在缺省时使用默认问题。
const prompt = process.argv[2] ?? "What is in this directory?";

const models = createModels();
// model 是 let：没有 key 时会改成 faux-1；有 key 时保持 openai/gpt-6-sol。
let model = { provider: "openai", modelId: "gpt-6-sol" };
// 注意只判断 undefined：空字符串也会进入真实分支，随后由 provider 报认证错误。
if (process.env.OPENAI_API_KEY !== undefined) {
	// openaiProvider 读取环境变量中的 key；真实生成会访问网络并计费。
	models.setProvider(openaiProvider());
} else {
	// 脚本化 provider：第一次响应要求调用 bash ls，第二次响应给最终文本。
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	// 这里把 model 重新赋值为 faux-1，后面的 root 使用它。
	model = { provider: "faux", modelId: "faux-1" };
	faux.setResponses([
		// 单个工具调用的助手消息；stopReason toolUse 让生成继续执行工具。
		fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "call-1" })], { stopReason: "toolUse" }),
		// 工具结果返回后的最终回答。
		fauxAssistantMessage([fauxText("This directory holds the durable package sources, tests, and docs.")]),
	]);
}

const registry = createRegistry();
// coding 扩展：两个工具 + 一个不包标签的 preamble 段。
// createReadTool()/createBashTool() 在这里创建设备无关的工具对象，真正执行时才通过环境访问文件/进程。
registry.install(
	defineExtension({
		name: "coding",
		tools: [createReadTool(), createBashTool()],
		sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
	}),
);
// env 是一个具体 NodeExecutionEnv；工厂每次返回同一个实例。所有工具调用都以 process.cwd() 为根。
// 与 16 不同，这里不读取 agent 的 cwd，因此 root 也不需要设置 cwd。
const env = new NodeExecutionEnv({ cwd: process.cwd() });
// HarnessOptions.env 接受同步函数；本示例不按调用构建新环境。
const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, context);
// 根会话使用上面选定的模型；没有其他 agent 选择。
const root = await harness.root(context, { agent: { model } });

// submit 只负责受理并返回 Submission；wait 才等待本次输入成为 done/unanswered。
const submission = await root.submit({ type: "input", content: prompt }, context);
const settled = await submission.wait(context);
// 两个判别字段都匹配时，settled.answer 才是回答条目的 EntryId。
if (settled.status === "done" && settled.type === "input") {
	// 按 AssistantEntry 类型读取条目；tx.entry 不存在时返回 undefined。
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	// model 首元素应为助手消息；as 是编译期断言，不做运行时校验。
	const answer = entry?.model?.[0] as AssistantMessage;
	// flatMap 只为 text 块产出字符串，其他内容块产出空数组；join("") 拼成最终文本。
	console.log(answer.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join(""));
} else {
	// 未回答：unanswered 分支有 reason；其他终态直接打印 status。写到 stderr，并设置非零退出码。
	console.error(`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
	process.exitCode = 1;
}
// 正常关闭 Harness 与存储；即使设置 exitCode，这一行仍会执行。
await harness.close(context);
