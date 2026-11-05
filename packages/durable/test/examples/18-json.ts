// 文件导读
// 所属：packages/durable 的 test/examples 系列第 18 个示例，演示像 `pi --mode json` 一样把一次运行输出为 JSON Lines。
// 演示内容：解析 --state/--storage 与 prompt；按 sqlite/jsonl/memory 建存储；有 OPENAI_API_KEY 时用真实 OpenAI，
//   否则用 faux（先 bash ls，再固定回答）；在提交前挂 Conversation.watch，分别以 ops（原始变更帧）或 state
//   （渲染器所需的增量条目 + 当前 pi.live）逐行输出；等待提交与空闲后停止 watch、关闭并打印存储位置。
// 上游入口：从命令行直接运行；下游调用 Conversation.watch、WatchHandle.start/stop、Harness.open/root/submit/waitForIdle、
//   openNodeSqliteStorage/openNodeJsonlStorage、NodeExecutionEnv 与 coding 工具扩展。有 key 时联网并计费；
//   无 key 时只执行本地 bash ls。
// 能力清单（按演示机制）：
// - args 解析：--state 切换模式；--storage 后跟 sqlite/jsonl/memory；prompt 是第一个非 flag 且非存储值的参数。
// - 存储选择：sqlite 写临时数据库文件；jsonl 写临时目录；memory 不留文件。前两者不自动删除，路径最后写到 stderr。
// - print(value)：把任意值 JSON.stringify 成一行写到 stdout；返回 void，不处理序列化失败。
// - Conversation.watch(context)：返回 WatchHandle<ConversationView>；value 含 conversation、entries、docs。
// - ops 模式：先输出完整 view，之后每个 value 帧输出该帧的 ops 数组（文档与条目变更）。
// - state 模式：先输出当前 entries 与 docs["pi.live"]；之后每次只输出新增条目（id > newest）与当前 live。
// - submit/wait/waitForIdle：等待本次提交结算并等普通任务范围空闲；setTimeout 0 再让最后一帧送达监听器。
// - WatchHandle.stop()：停止投递后关闭 Harness；stderr 输出存储路径。
// 典型运行顺序：解析参数 → 建存储 → 选 provider → 注册扩展 → open/root → watch → submit → wait → waitForIdle →
//   等待一帧 → stop → close → 打印位置。
// 示例（真实命令行）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/18-json.ts --state "What is in this directory?"
//   node --conditions=source --experimental-strip-types test/examples/18-json.ts --storage memory "..."
// 实际输出（stdout 每行一个 JSON；以下为结构示意，ID/时间戳/工具输出每次不同）：
//   ops:   {"view":{"conversation":{"id":1},"entries":[],"docs":{...}}}
//          {"ops":[["s",["docs","pi.live","run"],{...}],["p",["entries"],0,0,[{...}]]]}
//          ... 每个提交一帧
//   state: {"entries":[],"live":{}}
//          {"entries":[{"kind":"pi.user",...}],"live":{"run":{...}}}
//          {"entries":[...],"live":{"run":{...},"generation":{...}}}
//          ... 每帧只含新增条目与最新 live
//   stderr: sqlite storage: /tmp/pi-durable-json-<毫秒>.sqlite（jsonl 为目录；memory 无此行）
// 阅读顺序：先看参数解析与存储分支，再看 ops/state 两个监听器的增量算法（newest、filter、条件展开），
//   随后看 watch 为何在 submit 之前挂接，最后看 waitForIdle 与 setTimeout 0 的收尾。
// 前置条件：无 key 时需要本地 bash；sqlite/jsonl 会留下临时文件或目录。未知 --storage 会在打开前抛错；
//   没有 finally，运行中出错时可能跳过 stop/close 与路径输出。
// JSON mode: stream one prompt's run as JSON lines, like `pi --mode json`. Two modes, both of the ConversationView:
//   --ops (default): the raw frames, starting with the view itself; each later line holds the ops of the commits since.
//   --state: per call, the entries appended since the previous one and the current `pi.live`, state a renderer draws.
// --storage sqlite (default) | jsonl | memory: sqlite writes a temporary database file, jsonl a temporary directory;
// neither is deleted, and the path is printed to stderr at the end.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/18-json.ts --state "What is in this directory?"
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { NodeExecutionEnv } from "../../src/env/node.ts";
// Storage 是 type-only；其余是值导入。
import { createRegistry, defineExtension, Harness, MemoryStorage, type Storage, section } from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;
// 去掉 node 与脚本路径，只保留用户参数。
const args = process.argv.slice(2);
// --state 优先于默认 ops；--ops 没有专门处理，只是不匹配 --state。
const mode = args.includes("--state") ? "state" : "ops";
// --storage 的位置；< 0 表示未提供，使用默认 sqlite。
const storageIndex = args.indexOf("--storage");
// 取 --storage 的下一个参数作为类型；缺失时为 undefined，最终走未知存储分支。
const storageKind = storageIndex < 0 ? "sqlite" : args[storageIndex + 1];
// prompt 是第一个不以 -- 开头、且不是 --storage 取值的参数；都不满足时用默认问题。
// find 回调的 index 是 args 中的下标；storageIndex < 0 时无需排除存储值。
const prompt =
	args.find((arg, index) => !arg.startsWith("--") && (storageIndex < 0 || index !== storageIndex + 1)) ??
	"What is in this directory?";

// storage 在三个分支中恰好赋值一次；location 仅 sqlite/jsonl 设置，用于最后打印。
let storage: Storage;
let location: string | undefined;
if (storageKind === "sqlite") {
	// 用毫秒时间戳生成临时数据库文件名；文件不会自动删除。
	location = join(tmpdir(), `pi-durable-json-${Date.now()}.sqlite`);
	// 该入口只需要路径；context 省略（内部使用无取消的上下文）。
	storage = await openNodeSqliteStorage(location);
} else if (storageKind === "jsonl") {
	// JSONL 需要一个目录；mkdtemp 创建唯一目录。
	location = await mkdtemp(join(tmpdir(), "pi-durable-json-"));
	storage = await openNodeJsonlStorage(location, context);
} else if (storageKind === "memory") {
	// 内存存储不产生位置，结束时 stderr 不打印路径。
	storage = new MemoryStorage();
} else {
	// 未知类型在创建 Harness 前失败；错误使顶层 await 拒绝。
	throw new Error(`Unknown --storage ${storageKind}; use sqlite, jsonl, or memory`);
}
// print 接收 unknown，输出一行 JSON 到 stdout；void 丢弃 write 的返回值，函数本身返回 void。
// 无错误处理：含循环引用的值会让 JSON.stringify 抛错。
const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);

const models = createModels();
// 默认模型是真实 OpenAI；无 key 时替换为 faux。
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	// 有 key 就使用真实 provider；网络/认证错误会在生成时暴露。
	models.setProvider(openaiProvider());
} else {
	// tokensPerSecond:200 让 faux 的分片按时间推进，产生可观察的流式 live 更新。
	const faux = fauxProvider({ tokensPerSecond: 200 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	faux.setResponses([
		// 第一轮请求 bash ls；第二轮给出固定最终回答。
		fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("This directory holds the durable package sources, tests, and docs.")]),
	]);
}

const registry = createRegistry();
// coding 扩展提供 read/bash 工具和固定 preamble；工具通过共享环境访问进程与文件。
registry.install(
	defineExtension({
		name: "coding",
		tools: [createReadTool(), createBashTool()],
		sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
	}),
);
// 所有调用共用同一个以 process.cwd() 为根的环境；env 工厂同步返回它。
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const harness = await Harness.open(storage, { models, registry, env: () => env }, context);
const root = await harness.root(context, { agent: { model } });

// Attach before submitting, so the watch covers the whole run.
// root.watch 返回 WatchHandle<ConversationView>；先挂接再提交，首帧之后的变化都不会漏。
const watch = await root.watch(context);
// ops 模式：原始帧。先打印获取 watch 时的完整视图，再打印每个提交产生的 ops。
if (mode === "ops") {
	print({ view: watch.value });
	// start 安装唯一监听器；回调异步串行执行。非 value 帧（理论上 Durable 不发 failed）不会进入打印。
	watch.start(async (call) => {
		// kind 判别收窄后才能访问 call.ops。
		if (call.kind === "value") print({ ops: call.ops });
	});
} else {
	// state 模式：记录已见的最新条目 ID；at(-1) 取数组最后一项，?. 防止空数组，?? 0 用作初始下界。
	let newest = watch.value.entries.at(-1)?.id ?? 0;
	// 首帧输出当前条目与 live 文档；docs 是视图里的文档映射，按字符串键取值。
	print({ entries: watch.value.entries, live: watch.value.docs["pi.live"] });
	// 后续每帧只输出渲染器需要的“新增条目 + 最新 live”；live 是完整当前值，不是增量。
	watch.start(async (call) => {
		// 忽略非 value 帧；Durable 的失败通常以终止 watch 表示。
		if (call.kind !== "value") return;
		const { value } = call;
		// 过滤出比上次最新 ID 更大的条目；条目 ID 单调递增，因此可直接比较。
		const entries = value.entries.filter((entry) => entry.id > newest);
		// 更新 newest；空数组时保留旧值。at(-1) 仍是最后一项。
		newest = value.entries.at(-1)?.id ?? newest;
		// 条件展开：没有新增条目时省略 entries 字段，只输出 live。
		print({ ...(entries.length === 0 ? {} : { entries }), live: value.docs["pi.live"] });
	});
}

// 提交输入并等待本次提交结算；watch 从挂接起持续接收提交产生的变更。
const submission = await root.submit({ type: "input", content: prompt }, context);
await submission.wait(context);
// waitForIdle 等待普通（非后台）任务范围空闲；后台任务不在等待范围内（本示例没有后台任务，主要用于收尾语义）。
await harness.waitForIdle(context);
// Let the last batch reach the listener before stopping.
// setTimeout 0 让出到宏任务，给 watch 的微任务投递一次机会；否则 stop 可能抢在最后一帧回调之前。
await new Promise((resolve) => setTimeout(resolve, 0));
await watch.stop();
await harness.close(context);
// 先 stop 再 close：close 也会以 ended 结束 watch，但显式停止让最后一批输出与收尾顺序更清楚。
// 只有 sqlite/jsonl 有 location；写到 stderr，保持 stdout 是纯 JSON Lines。
if (location !== undefined) console.error(`${storageKind} storage: ${location}`);
