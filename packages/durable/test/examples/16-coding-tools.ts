// 文件导读
// 所属：packages/durable 的 test/examples 系列第 16 个示例，演示 coding 工具在 JSONL 存储上完成一轮工具调用。
// 演示内容：把 notes.txt 放进临时目录；faux 模型依次请求 read、edit、两次 bash（第二次 cat 一个可选的大文件），
//   最后给出回答；Timing 扩展通过 ToolTask 钩子给第二次 bash 计时；结束后按时间顺序打印条目与工具结果文本，
//   再从 AssistantEntry 读取最终回答，并确认文件已被编辑。
// 上游入口：从 packages/durable 目录直接运行；下游调用 fauxProvider/fauxToolCall、CodingTools、hook(ToolTask)、
//   openNodeJsonlStorage、NodeExecutionEnv、Harness.open/root/submit/wait/entries/commit、ToolResultEntry.is。
//   使用本地文件与进程（bash），没有模型网络请求；会创建临时目录并故意保留，输出最后打印其路径。
// 能力清单（按演示机制）：
// - toolCall(name, args, id)：拼一条带单个工具调用的 AssistantMessage，stopReason=toolUse。
// - CodingTools：内置 read/write/edit/bash 扩展；工具只通过 Harness 为每次调用构建的 ExecutionEnv 访问文件/进程。
// - hook(ToolTask, {beforeTool, afterTool})：在每次工具调用前后运行；isBigCat 只对 cat /tmp/1gb.txt 计时。
// - openNodeJsonlStorage(directory, context)：把会话与文档写成 JSONL，目录在关闭后保留。
// - HarnessOptions.env：按会话 agent 的 cwd 构建 NodeExecutionEnv；相对路径解析到该目录。
// - submit(...).wait：一次运行中工具调用是生成任务拥有的 pi.tool 子任务；生成等待它们后继续下一轮。
// - ToolResultEntry/ToolResultMessage：工具结果条目携带处理后的文本；失败命令也作为结果返回，不中断整轮。
// 典型运行顺序：建临时目录/notes.txt → 排五条 faux 响应 → 定义 hooks/注册 → 打开 JSONL 存储与 Harness → root(cwd=目录) →
//   提交编辑请求并等待 → 打印状态/条目/回答/文件 → close → 打印存储目录。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/16-coding-tools.ts
// 实际输出（耗时与临时目录名每次不同；若 /tmp/1gb.txt 不存在，该 bash 结果是错误文本）：
//   cat /tmp/1gb.txt took 4 ms
//   status: done
//   pi.user
//   pi.system
//   pi.assistant
//   pi.tool-result read: "hello world\n"
//   pi.assistant
//   pi.tool-result edit: "Successfully replaced 1 block(s) in notes.txt."
//   pi.assistant
//   pi.tool-result bash: "hello durable\n"
//   pi.assistant
//   pi.tool-result bash: "cat: /tmp/1gb.txt: No such file or directory\n<harness>\n[error] Command exited with code 1\n</harness>"
//   pi.assistant
//   answer: [ { type: 'text', text: 'The file now greets durable.' } ]
//   file: "hello durable\n"
//   storage: /var/.../pi-durable-example-...
// 阅读顺序：先看 toolCall 与五条脚本响应，再看 hook 和 isBigCat，随后看 CodingTools/env 的接线，最后看条目打印与最终回答读取。
// 前置条件：本地可执行 bash；/tmp/1gb.txt 可选。示例无 try/finally，失败时临时目录仍会保留。
// A coding-agent tool turn on JSONL storage: the model reads, edits, and runs commands, then answers. A hook times a
// `cat` of /tmp/1gb.txt (create it first to measure; without it that call ends in an error result). The storage
// directory is left behind for inspection.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/16-coding-tools.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// ToolResultMessage 仅用于把工具结果条目的首条消息收窄成已知形状。
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	hook,
	ToolResultEntry,
	ToolTask,
} from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
// BashToolInput 是 type-only 导入；CodingTools 是值导入，包含 read/write/edit/bash 四个工具。
import { type BashToolInput, CodingTools } from "../../src/tools/index.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;
// 临时目录同时存放 notes.txt 与 JSONL 存储文件；示例结束不删除。
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
// 初始文件内容；后续 edit 会把 world 换成 durable。
await writeFile(join(directory, "notes.txt"), "hello world\n");

// The faux provider plays the model: four tool-calling answers, then a final answer.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// toolCall 构造“单个工具调用”的助手消息。输入 name、args、id；输出 AssistantMessage，stopReason 固定 toolUse。
// Parameters<typeof fauxToolCall>[1] 从 fauxToolCall 的函数类型中取第二个参数类型，避免手写 args 形状。
// 无副作用；错误路径：参数不符合 fauxToolCall 的期望时由 TS 在编译期报错，运行时仍是普通对象。
// 示例：toolCall("read", { path: "notes.txt" }, "r") 生成一个名为 read、调用 ID 为 r 的助手消息。
const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
	fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
// 五条响应按生成轮次消费：前四条各触发一次工具调用，最后一条结束运行。
faux.setResponses([
	// read 读取 notes.txt；相对路径由工具的 ExecutionEnv 按会话 cwd 解析。
	toolCall("read", { path: "notes.txt" }, "r"),
	// edit 把 oldText 替换为 newText；edits 数组可含多个替换块。
	toolCall("edit", { path: "notes.txt", edits: [{ oldText: "world", newText: "durable" }] }, "e"),
	// bash 执行 cat notes.txt，读取编辑后的内容。
	toolCall("bash", { command: "cat notes.txt" }, "b"),
	// 第二个 bash 读取可选的大文件；不存在时命令以非零码结束，结果仍是错误工具结果。
	toolCall("bash", { command: "cat /tmp/1gb.txt" }, "c"),
	// 最终回答；没有工具调用，generation 结束并结算提交。
	fauxAssistantMessage([fauxText("The file now greets durable.")]),
]);

// Hooks see every call before and after execution; these time the big `cat`.
// isBigCat 判断一次调用是否是 bash 且命令包含 "1gb.txt"。输入是钩子给出的 {name, arguments}，输出 boolean。
// arguments 在钩子类型里是 unknown，因此用 as BashToolInput 断言；bash 参数已由工具 schema 校验过 command。
// 无副作用；示例只用于计时过滤。
// 示例：isBigCat({ name:"bash", arguments:{ command:"cat /tmp/1gb.txt" } }) 返回 true。
const isBigCat = (call: { name: string; arguments: unknown }) =>
	call.name === "bash" && (call.arguments as BashToolInput).command.includes("1gb.txt");
// start 保存 beforeTool 记录的时间戳；模块级变量在两次钩子之间共享。
let start = 0;
// Timing 扩展只包含 ToolTask 钩子；安装并被选中后，每次工具调用都会触发这些处理器。
// hook 的第一个参数是任务定义（按名称匹配），第二个参数是部分钩子实现。
const Timing = defineExtension({
	name: "timing",
	hooks: [
		hook(ToolTask, {
			// beforeTool 在参数校验后、工具执行前运行；输入工具调用，返回 undefined 表示不改动调用。
			// 只有大文件 cat 会重置 start；其他调用不改变计时状态。
			beforeTool: (call) => {
				if (isBigCat(call)) start = Date.now();
				return undefined;
			},
			// afterTool 在工具结束后运行（成功或失败都算）；这里打印从 beforeTool 到现在的毫秒差。
			// Date.now() 使用墙上时钟，适合演示，不是精确基准。
			afterTool: (call) => {
				if (isBigCat(call)) console.log(`cat /tmp/1gb.txt took ${Date.now() - start} ms`);
				return undefined;
			},
		}),
	],
});
const registry = createRegistry();
// CodingTools brings read, write, edit, and bash. Tools reach files and processes only through the environment the
// Harness builds for each call.
// 安装 CodingTools（工具）与 Timing（钩子）；两者都默认被会话选中。
registry.install(CodingTools);
registry.install(Timing);

// The environment is built per use and follows the conversation's agent `cwd`.
// JSONL 存储在 directory 下写文件；返回的 Storage 交给 Harness 管理生命周期。
const storage = await openNodeJsonlStorage(directory, context);
// env 工厂每次按 EnvTarget 构建真实 Node 环境；target.cwd 来自会话 agent 的 cwd，缺省回退进程 cwd。
const harness = await Harness.open(
	storage,
	{ models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }) },
	context,
);
// root 选择 faux 模型并把 cwd 设为临时目录；read/edit/bash 的相对路径都基于这里。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });

// Each tool call runs as a durable pi.tool task owned by the generation, which waits for them and continues the run with the next generation.
// 提交编辑请求；wait 等整轮运行结束，包括所有工具调用与后续生成，而不是只等输入受理。
const settled = await (await root.submit({ type: "input", content: "Greet durable instead." }, context)).wait(context);
// done 表示已被回答；unanswered 会带 reason。
console.log("status:", settled.status);
// 读取最近 20 条条目；默认最新在前，下面复制后反转成时间顺序。
const transcript = await root.entries({}, 20, undefined, context);
// for...of 遍历复制并反转后的数组，不修改分页结果本身。
for (const entry of [...transcript.items].reverse()) {
	// ToolResultEntry.is 按 kind 收窄；非工具结果只打印种类（用户、系统、助手）。
	if (!ToolResultEntry.is(entry)) {
		console.log(entry.kind);
		continue;
	}
	// model 对工具结果条目应为 [ToolResultMessage]；! 断言非空，as 断言元素类型（二者都不做运行时检查）。
	const result = entry.model![0] as ToolResultMessage;
	// content 可能含多种块；这里只拼接 text 块，其他类型当空串。
	const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
	// 超过 200 字符截断并加省略号，避免大文件输出刷屏；JSON.stringify 转义换行。
	console.log(
		`${entry.kind} ${result.toolName}:`,
		JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text),
	);
}
// 只有已答输入才有 answer 条目 ID；读取最终 AssistantEntry 并打印模型消息内容。
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = answer?.model?.[0];
	console.log("answer:", message?.role === "assistant" ? message.content : message);
}
// 直接读取被 edit 修改后的文件，确认工具确实通过 ExecutionEnv 写入了临时目录。
console.log("file:", JSON.stringify(await readFile(join(directory, "notes.txt"), "utf8")));
// 关闭 Harness 与 JSONL 存储；目录和其中的文件保留。
await harness.close(context);
// 最后打印存储目录，便于手动检查 JSONL 记录。
console.log("storage:", directory);
