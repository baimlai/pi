// 文件导读
// 所属：packages/durable/test/examples 的 33-turn-limit-and-continue.ts，Durable 示例系列第 33 个，
// 演示“工具轮上限与 continue”。
// 演示内容：根会话设置 maxTurns=2；含四次工具调用的脚本在首轮只执行 step 1..2，随后以 unanswered/turn_limit 结束。
// 空闲时提交 type=continue，不新增用户消息，直接在现有上下文上继续，并获得新的轮预算；它再次执行 step 3..4
// 后仍撞上限。第三次 continue 才拿到最终回答。忙碌中的 continue 以 ConversationBusy 拒绝，从不排队。
// 最后演示对已回答上下文 continue 会以 nothing_to_answer 结束，且不发模型请求。
// 上游入口：node 直接运行本文件；固定 faux 响应，无网络。
// 下游依赖：Durable 的 Harness/defineExtension/defineTool/LiveDoc/ConversationBusy，pi-ai faux，pi-schema num/obj。
// 能力清单：step 工具与 call 脚本；maxTurns 配置；submit+wait；LiveDoc.runFailure；continue 拒绝与等待；
// 第三次 continue；记录按正序打印；空 continue。
// 典型顺序：定义工具/脚本 -> 打开 Harness -> 提交四步任务 -> 打印失败与 detail -> 提交 continue -> 忙时再试 ->
// 打印两次 continue 结果 -> 打印全部记录 -> 回答后再 continue -> 关闭。
// 前置条件：无需 API key；maxTurns 存在会话 agent 上，子会话与 fork 会继承；faux 响应按请求顺序消费。
// 预期输出：first run: unanswered turn_limit (2 turns)；second continue while busy: ConversationBusy；
// first continue: unanswered turn_limit；second continue: done (runFailure cleared)；随后四条 tool 与一条 agent 文本；
// continue after the answer: unanswered nothing_to_answer。
// 阅读顺序：先看 step/call 与 maxTurns，再看首轮的失败与 LiveDoc，随后看三次 continue 的差异，最后看记录打印。
// A per-conversation turn limit stops a long run after a number of tool rounds; a continue resumes it without a user
// message, with a fresh budget. A host learns that a run stopped from `pi.live.runFailure`.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/33-turn-limit-and-continue.ts

// BACKGROUND_CONTEXT 是不带取消信号的根上下文；所有提交、等待与快照读取都用它。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { num, obj } from "@earendil-works/pi-schema";
import {
	ConversationBusy,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// 声明 step 工具：每个调用完成一步工作并返回一段文本。
// 参数 schema 是 obj({ n: num() })；模型给出的参数在进入 execute 前经过运行时校验，并推断为 number。
// 例：工具调用 step({ n: 2 }) 的 execute 返回文本 "step 2 done"。
const step = defineTool({
	name: "step",
	description: "Do one step of the work",
	// num() 是 pi-schema 的数字参数；这是模型输入进入工具前的信任边界，非法参数不会到达 execute。
	parameters: obj({ n: num() }),
	// 工具结果是文本块数组；这段文本会作为 toolResult 进入模型上下文，后面的打印会读取它。
	execute: async (args) => ({ output: [{ type: "text", text: `step ${args.n} done` }] }),
});
// 辅助函数生成一条“调用 step”的假助手消息；stopReason 为 toolUse，表示这一轮以工具调用结束而不是最终回答。
const call = (n: number) => fauxAssistantMessage(fauxToolCall("step", { n }), { stopReason: "toolUse" });

// faux provider 默认模型 id 为 faux-1；所有响应来自下面的脚本，不访问网络。
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// Four steps, then the answer. Two tool rounds per run are allowed.
// 脚本共五条：四次工具调用后一条最终回答。maxTurns=2 时，前两次属于首轮，第三次与第四次属于第一次 continue，
// 最终回答留给第二次 continue；faux 按请求顺序消费，不会按 run 重置。
faux.setResponses([call(1), call(2), call(3), call(4), fauxAssistantMessage("All four steps are done.")]);

const registry = createRegistry();
// 最小扩展只声明 step 工具；安装后默认 settings 会选用注册表里的全部扩展。
registry.install(defineExtension({ name: "steps", tools: [step] }));
// 内存存储保证示例自包含；打开 Harness 后，提交会启动生成任务并按需调度。
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// Stored on the conversation, like its model: children and forks inherit it.
// maxTurns=2 写入会话的 agent 配置（pi.agent），与模型一样持久化，子会话与 fork 会继承；
// 它限制单次运行的工具轮数，达到上限的那轮仍执行工具，然后以 unanswered/turn_limit 结束。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, maxTurns: 2 } });

// submit 返回句柄，wait 等到输入结算；首轮执行 step 1、step 2 后撞上轮上限，因此结算是 unanswered 而不是 done。
const first = await (await root.submit({ type: "input", content: "Do the four steps." }, context)).wait(context);
// pi.live 的 runFailure 记录最近一次失败运行的原因与诊断；? 在快照或字段缺失时给出 undefined。
const failure = (await harness.snapshot(LiveDoc, root.id, context))?.runFailure;
// first.reason 来自提交结算，failure.detail 来自 LiveDoc；turn_limit 的 detail 形如 "2 turns"，说明实际工具轮数。
console.log("first run:", first.status, first.reason, `(${failure?.detail})`);

// An idle conversation runs a continue on the context as it is, the round's results last, with a fresh budget.
// continue 不新增用户消息，直接在现有上下文（最后是工具结果）上继续，并获得新的 maxTurns 预算；
// 它只在空闲时可用，忙碌时以 ConversationBusy 拒绝且从不排队。
const resumed = await root.submit({ type: "continue" }, context);
// It never queues: while that run works, another continue is refused.
// 紧接着在 continue 运行期间再提交一次 continue，用 try/catch 观察拒绝。
try {
	// 这次提交预期抛 ConversationBusy；它不会进入队列，因此不会影响正在运行的 continue。
	await root.submit({ type: "continue" }, context);
} catch (error) {
	// catch 参数在严格模式下是 unknown，不能假定它是 Error；instanceof 是运行时判别：
	// 只吞掉预期的 ConversationBusy，其他错误继续向外抛，避免掩盖真实故障。
	if (!(error instanceof ConversationBusy)) throw error;
	// 确认拒绝路径后继续等待第一次 continue 的结算。
	console.log("second continue while busy: ConversationBusy");
}
// 第一次 continue 执行 step 3、step 4，再次达到 maxTurns=2，所以仍未得到回答；wait 返回同样的失败结算。
const second = await resumed.wait(context);
// status 为 done 时没有 reason 字段，因此三元表达式只在未回答时读取 reason。
console.log("first continue:", second.status, second.status === "done" ? "" : second.reason);
// 第二次 continue 的上下文最后是工具结果，仍有可回答的内容；新预算下 faux 返回最终回答，因此结算为 done。
const third = await (await root.submit({ type: "continue" }, context)).wait(context);
// 成功运行后再读 pi.live：新运行开始时清除上一次的 runFailure，成功后它保持 undefined。
const live = await harness.snapshot(LiveDoc, root.id, context);
// 用 runFailure 是否存在判断失败信息是否已清除；可选链让快照缺失时也能安全比较。
console.log("second continue:", third.status, live?.runFailure === undefined ? "(runFailure cleared)" : "");

// 按时间顺序读取全部记录：一条用户消息、四条工具结果、一条最终助手文本；continue 本身不产生用户条目。
const page = await root.entries({ order: "ascending" }, 100, undefined, context);
for (const entry of page.items) {
	// 每条记录取第一条模型消息；没有模型消息的记录（例如纯显示条目）得到 undefined。
	const message = entry.model?.[0];
	// 只有最初的 input 提交产生用户消息；continue 不会新增。
	if (message?.role === "user") console.log(">", message.content);
	// 工具结果消息的 content 是内容块数组；[0]?. 处理空 content，三元表达式在编译期收窄块类型，
	// 运行时只检查 type 字符串；这里取第一个块并确认是文本，再打印。
	if (message?.role === "toolResult")
		console.log("  tool:", message.content[0]?.type === "text" ? message.content[0].text : "");
	// 只打印最终回答：工具调用轮的消息 stopReason 是 toolUse，会被这个条件排除。
	if (message?.role === "assistant" && message.stopReason === "stop") {
		// 把文本块映射为单元素数组、其他块映射为空数组，再合并；最终回答只有文本块。
		console.log("agent:", message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
	}
}
// A continue after an answer has nothing to answer: it ends without a model request.
// 对已回答的上下文再 continue：没有可回答的内容，运行不发模型请求，直接以 unanswered/nothing_to_answer 结束。
const after = await (await root.submit({ type: "continue" }, context)).wait(context);
// 这是第三种 continue 结果：不是忙碌拒绝，也不是轮上限，而是上下文已无待回答内容。
console.log("continue after the answer:", after.status, after.reason);
// 关闭 Harness 管理的会话、任务与调度；MemoryStorage 随进程结束丢弃。
await harness.close(context);
