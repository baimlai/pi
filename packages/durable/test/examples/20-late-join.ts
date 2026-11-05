// 文件导读
// 所属：packages/durable/test/examples 的 20-late-join.ts，Durable 示例系列第 20 个，演示“迟到订阅”。
// 演示内容：run 已经执行到工具中段（每 100ms 输出一行）时，新客户端才 watch()；它先拿到当前视图（含运行中工具输出），
// 随后只收到此后的变更，包括逐步流式的助手回答；run 结束后打印最终条目种类并停止监听。
// 上游入口：node 直接运行本文件；顶层 await 顺序执行，异常直接传播。
// 下游依赖：Durable 的 Harness/watch/ConversationView/LiveDoc，pi-ai 的 faux provider（tokensPerSecond 模拟流式）。
// 能力清单（无导出）：pause 辅助；count 工具每 100ms api.output；faux 两步响应；打开 Harness/根会话；
// 中途 watch；读取 view.value.entries 与 docs["pi.live"]；start 回调区分工具输出与助手文本；wait/stop/close。
// 典型顺序：安装 count 扩展 -> 提交请求 -> 等 500ms 后 watch -> 打印初始视图 -> start 监听 -> 等待提交与空闲 -> stop/close。
// 前置条件：无需 API key；工具里的暂停是真实 setTimeout，因此脚本会运行数秒。
// 预期输出：view entries、初始 tool slot、逐步的 view output now 与 view answer now、结束时的 entries。
// 阅读顺序：先看 count 工具与 faux 流式设置，再看迟到 watch 的初始值与回调过滤。
// Late join: a client attaches while a run is already underway. It gets the current state first, the conversation
// view, and then only what changes after that.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/20-late-join.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type LiveState,
	MemoryStorage,
} from "../../src/index.ts";

// 共享操作上下文；不设置取消信号，watch、提交和等待都沿用它。
const context = BACKGROUND_CONTEXT;
// pause 返回一个 ms 毫秒后兑现的 Promise<void>；这里用它模拟工具执行耗时，并留出迟到订阅的时间窗。
// 这是真实定时器，不是 Harness 的持久睡眠；进程退出时未触发的定时器会丢失。
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A tool that prints a line every 100 ms, then a slowly streamed answer.
// 创建注册表；随后安装 count 工具扩展。
const registry = createRegistry();
// defineExtension 只声明扩展结构；安装后该会话默认选中它（settings 未指定 extensions 时全选）。
registry.install(
	defineExtension({
		name: "count",
		tools: [
			// 定义模型可调用的 count 工具；parameters 用 pi-schema 的 obj({}) 表示无参数。
			defineTool({
				name: "count",
				// description 会出现在提供给模型的工具声明中。
				description: "Counts to ten",
				parameters: obj({}),
				// execute 接收已校验参数与 ToolExecutionApi；这里不需要参数，用下划线前缀表示故意不使用。
				execute: async (_args, api) => {
					// 循环十次，每次把一行运行中输出写进 pi.live，并等待 100ms。
					for (let n = 1; n <= 10; n++) {
						// api.output 流式追加工具运行结果（UI/watch 可见）；execute 未返回 output 时，这些文本最终成为工具结果。
						api.output(`${n}\n`);
						// 真实等待 100ms；期间 Harness 可以提交进度并让 watch 看到新输出。
						await pause(100);
					}
					// 返回空对象表示没有额外 output/details；保留的运行中输出被当作最终结果。
					return {};
				},
			}),
		],
	}),
);
// faux 按每秒 40 个、每个 1 字符的节奏流式输出，模拟慢速真实模型；不访问网络。
const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } });
// 第一步请求 count 工具（stopReason toolUse 让 Harness 执行工具），第二步给流式文本回答。
faux.setResponses([
	// 工具调用块带固定 id；参数是空对象，因为 count 没有参数。
	fauxAssistantMessage([fauxToolCall("count", {}, { id: "call-1" })], { stopReason: "toolUse" }),
	// 普通助手回答；faux 会按 tokensPerSecond 逐步产生 partial 文本。
	fauxAssistantMessage([fauxText("Counted to ten, and this answer streams slowly.")]),
]);
// 创建模型目录。
const models = createModels();
// 注册 faux provider，供 agent 的 provider/modelId 解析。
models.setProvider(faux.provider);
// 在内存存储上打开 Harness；会话与任务状态只在本进程内。
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// 创建根会话并选择 faux-1 模型。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// 持久接纳输入并启动 run；返回的 Submission 用于稍后等待结算。
const submission = await root.submit({ type: "input", content: "Count to ten, then tell me." }, context);
// Join while the tool is halfway through.
// 等 500ms 再订阅：此时 run 已进行到工具输出中段。
await pause(500);

// The view holds the newest entries and the documents, including the running tool's output and, later, the answer
// being streamed.
// watch 返回当前结构视图与后续 WatchCall 流；value 是附着那一刻的已提交状态。
// 默认窗口是最近 50 条条目，之后的新条目追加，超过 100 条时成批丢弃最旧的一段。
const view = await root.watch(context);
// docs 以字符串键保存 JSON；as LiveState 只是编译期断言，运行时不会校验形状。
const live = view.value.docs["pi.live"] as LiveState;
console.log(
	"view entries:",
	// 初始值里的条目窗口；map 只取 kind，便于观察已经提交了哪些记录。
	view.value.entries.map((entry) => entry.kind),
);
// 可选链读取第一个工具槽位；JSON.stringify 把运行中输出转成带引号的字符串，便于看清新行。
console.log("view tool slot:", live.tools?.[0]?.status, JSON.stringify(live.tools?.[0]?.output));
// 记录上一次打印的助手文本，避免同一个 partial 片段重复输出。
let shown = "";
// start 逐条交付 WatchCall；回调是异步的，但 Harness 会等它返回后再交付下一帧。
view.start(async (call) => {
	// WatchCall 是以 kind 区分的联合；Durable 的 watch 不会发 failed 帧，这里提前返回即可把类型收窄为 value 分支。
	if (call.kind !== "value") return;
	// 解构取本次变更后的完整视图；ops 在该帧里也可见，本例不处理增量。
	const { value } = call;
	// 每次提交都重新读 pi.live；与初始 view 一样，as 不做运行时检查。
	const state = value.docs["pi.live"] as LiveState;
	// 工具槽位按调用顺序排列；第一个就是 count。
	const slot = state.tools?.[0];
	// 只在工具仍 running 时打印最新输出；status 收窄后 output 才属于该分支语义。
	if (slot?.status === "running") console.log("view output now:", JSON.stringify(slot.output));
	// 可选链穿过 generation/message/content；find 找第一个文本块，?? 在缺失或 undefined 时回退空串。
	const partial = state.generation?.message?.content.find((block) => block.type === "text")?.text ?? "";
	// 只在文本增长（与上次不同）且非空时打印，避免重复帧；这是本示例的展示去重，不是 Durable 的语义。
	if (partial !== shown && partial !== "") console.log("view answer now:", JSON.stringify(partial));
	// 记住本次文本，供下一帧比较。
	shown = partial;
	// run 存在表示会话忙碌；变为 undefined 说明本次 run 已结束，打印结算后的完整条目窗口。
	if (state.run === undefined)
		console.log(
			"view entries:",
			value.entries.map((entry) => entry.kind),
		);
});

// 等这份输入被回答（done）或失败（unanswered）；afterRun 任务可能仍在进行。
await submission.wait(context);
// 等当前 run 以及它创建的 afterRun 等普通工作全部空闲。
await harness.waitForIdle(context);
// 让出一次事件循环，给 watch 回调最后一次打印机会。
await pause(0);
// 停止 watch；此后不再收到变更帧。
await view.stop();
// 关闭 Harness 与存储；本例没有 finally，异常路径会跳过清理。
await harness.close(context);
