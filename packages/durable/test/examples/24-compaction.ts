// 文件导读
// 所属：packages/durable/test/examples 的 24-compaction.ts，Durable 示例系列第 24 个，演示“上下文压缩”。
// 演示内容：一个 3000 token 窗口的假模型进行五轮旅行问答，越过后台阈值后自动压缩；随后在回答仍被门闩挂住时
// 手动 compact()，观察摘要先进收件箱、回答结束后再放置；最后让 provider 报“prompt is too long”，验证溢出触发压缩并重试一次。
// 上游入口：node 直接运行本文件；无需 API key，全部由 faux 路由函数响应。
// 下游依赖：Durable 的 Harness/CompactionEntry/LiveDoc/compact/settings.compaction，pi-ai 的 faux provider 与 TranscriptContext。
// 能力清单：respond 路由（摘要/溢出/普通回答）；hold 门闩；settings getter；ask 辅助；manual compaction；
// show 打印模型上下文；text 提取消息文本。
// 典型顺序：配置 tiny 模型与阈值 -> 五轮对话触发后台压缩 -> 手动 compact() 观察排队 -> 关闭后台压缩并注入溢出 ->
// 打印压缩后的上下文 -> 关闭。
// 前置条件：无网络；脚本主要耗时在每轮 200 次重复的 details 文本与压缩任务，通常数秒。
// 预期输出：每轮后的消息数、条目数、压缩摘要标记与消息首行；手动压缩的 queued/done 状态；溢出后的摘要。
// 阅读顺序：先看 respond 如何区分摘要请求、溢出与普通回答，再看阈值计算和 ask，最后看手动与溢出两种压缩路径。
// Compaction: a long trip-planning chat whose older messages are summarized so the model context stays small.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/24-compaction.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	CompactionEntry,
	type Conversation,
	createRegistry,
	Harness,
	LiveDoc,
	MemoryStorage,
} from "../../src/index.ts";

// 共享操作上下文；提交、compact、任务等待与快照都沿用它。
const context = BACKGROUND_CONTEXT;

// A fake model with a tiny 3000-token window. It answers chat messages, writes summaries when asked to summarize,
// and once rejects a request as too long, the way real providers report a context overflow.
// 一次性溢出开关；为 true 时下一次普通回答返回 provider 错误，用完后立即复位。
let overflowOnce = false;
// 摘要计数，仅用于让每份摘要文本可区分。
let summaries = 0;
// While set, the next chat answer waits for it, which keeps the conversation busy.
// 门闩变量：设置后，下一次普通回答会等待它兑现，从而让会话保持忙碌；undefined 表示不等待。
let hold: Promise<void> | undefined;
// 假模型的响应函数。输入：TranscriptContext（当前发给模型的消息与工具等）；输出：助手消息。
// 副作用：递增 summaries，消费 overflowOnce，清空 hold；错误：溢出用 stopReason error 的消息表达，不抛异常。
// 主流程：摘要请求优先 -> 一次性溢出 -> 门闩 -> 普通回答。
// 示例：五轮普通问题返回带 200 次 details 的长回答；压缩任务询问摘要时返回 Markdown 摘要。
async function respond(transcript: TranscriptContext): Promise<AssistantMessage> {
	// 首条消息通常是系统提示；可选链防止空上下文。
	const first = transcript.messages[0];
	// 三重检查识别摘要请求：角色、content 的运行时形状、提示文本。typeof 是 provider 边界的真实判断，
	// 因为消息 content 可能是字符串或内容块数组。
	if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
		summaries++;
		// 返回摘要文本；标题行与编号让 show 的输出可辨认。
		return fauxAssistantMessage(`## Goal\nPlan a week in Lisbon (summary #${summaries}).`);
	}
	// 一次性溢出分支：返回 stopReason error 的助手消息，模拟真实 provider 的上下文过长拒绝。
	if (overflowOnce) {
		overflowOnce = false;
		// 内容为空、错误信息固定；Harness 识别该错误后压缩并重试一次。
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
	}
	// 先快照再清空门闩：本次回答只等调用时的那个 Promise，后续请求不会被同一门闩再次挡住。
	const held = hold;
	hold = undefined;
	// held 为 undefined 时 await undefined 立即完成；有 Promise 时等待宿主放行。
	await held;
	// findLast 取最近一条 user 消息；可能为 undefined，text 会处理。
	const question = transcript.messages.findLast((message) => message.role === "user");
	// 构造足够长的回答，让上下文几轮后越过阈值；repeat 只重复固定片段，不做模型推理。
	return fauxAssistantMessage(`A detailed answer to "${text(question)}": ${"details ".repeat(200)}`);
}
// 注册一个 3000 token 窗口、最多输出 1000 token 的假模型；压缩阈值据此计算。
const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] });
// 预置 100 个相同响应函数，覆盖对话、摘要与溢出重试的全部请求。
faux.setResponses(Array.from({ length: 100 }, () => respond));
// 模型目录；注册 faux 后按 provider/modelId 解析。
const models = createModels();
models.setProvider(faux.provider);

// 阈值计算：请求等待压缩的阻塞点是 contextWindow - reserveTokens；后台压缩在再低 backgroundTokens 处开始。
// 本例即 2000 与 1200。
// Generation blocks to compact above 3000 - 1000 = 2000 tokens and starts a background compaction above 2000 - 800.
// Settings are read at every use, so the getter makes `backgroundTokens` live.
// 用 let 保存后台阈值距离，第三个场景改成 0 以关闭后台压缩。
let backgroundTokens = 800;
// 宿主设置对象；settings 中的 compaction 是 getter，每次读取都重新求值。
const settings = {
	// JavaScript getter：访问 settings.compaction 时调用并返回新对象；Durable 每次使用设置都会读取，
	// 因此闭包变量 backgroundTokens 的修改立即生效。
	get compaction() {
		// reserveTokens 给输出预留空间；keepRecentTokens 大致保留多少最近上下文不压缩；backgroundTokens 控制提前量。
		// 属性简写 backgroundTokens 等价于 backgroundTokens: backgroundTokens。
		return { reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens };
	},
};
// 在内存存储上打开 Harness；内置任务（含 CompactionTask）来自 createRegistry()。
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings }, context);
// 创建根会话并选择 tiny 模型；model 只持久化 provider/modelId 名字。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "tiny" } } });

// 问一轮并等所有由该轮启动的后台压缩结束，然后打印上下文。
// 输入：问题文本；输出：无。副作用：提交、等待、可能等待压缩任务；错误：提交失败会抛出。
// 示例：ask("Nightlife?") 打印回答后的上下文。
async function ask(question: string): Promise<void> {
	// 持久接纳输入并启动 run；返回的 Submission 用于等待。
	const submission = await root.submit({ type: "input", content: question }, context);
	// 等这份输入结算；done 表示已回答，unanswered 带 reason。
	const record = await submission.wait(context);
	// Let a background compaction started by this turn finish, so its summary shows below.
	// 读取 LiveDoc 中正在运行的压缩任务列表；没有时回退空数组。
	const running = (await harness.snapshot(LiveDoc, root.id, context))?.compactions ?? [];
	// 解构每项的 taskId 并逐个等待；这样后台压缩的摘要已经放置，show 才能看到。
	for (const { taskId } of running) await harness.waitForTask(taskId, context);
	// 标签区分已回答与失败原因；三元在 status 收窄后读取 reason。
	await show(root, `after "${question}" (${record.status === "done" ? "answered" : record.reason})`);
}

// 场景 1：连续五轮长回答。上下文越过后台阈值后，压缩与对话并行；会话空闲时摘要立即放置，否则等下一轮边界。
// 1. A long chat: once the context crosses the background threshold, a compaction runs while the chat goes on, and
// its summary lands at once when the conversation is idle, otherwise at the next turn boundary.
// for-of 顺序执行，保证每轮观察到上一轮的压缩结果。
for (const question of [
	"Where should we stay?",
	"What should we eat?",
	"Which day trips?",
	"Any museums?",
	"Nightlife?",
]) {
	await ask(question);
}

// 场景 2：用门闩让回答保持进行中，再调用 compact()。摘要先做好并进入收件箱，等回答结束后的边界放置。
// 2. A manual compaction while an answer is still being written. The summary is ready first, waits in the inbox,
// and is placed right after the answer.
// finishAnswer 由 Promise 执行器稍后赋值；! 是明确赋值断言。
let finishAnswer!: () => void;
// 创建门闩并保存 resolve；执行器同步运行，把函数赋给 finishAnswer。
hold = new Promise((resolve) => {
	finishAnswer = resolve;
});
// 提交后不等待；下一次模型请求会卡在门闩上，会话保持忙碌。
const busy = await root.submit({ type: "input", content: "How do we get around?" }, context);
// 手动压缩，附带保留酒店候选的指示；返回压缩任务 ID，而不是摘要本身。
const manual = await root.compact("Keep the hotel shortlist", context);
// 等压缩任务进入终态；解构出 state。
const { state } = await harness.waitForTask(manual, context);
// completed 结果里的 submissionId 指向放置摘要的内部提交；失败或中止时为 undefined。
const placement = state.outcome.status === "completed" ? state.outcome.result.submissionId : undefined;
// 按 ID 取回提交句柄；两个 ! 都是非空断言，分别用于 id 与返回值。
const summary = (await harness.submission(placement!, context))!;
// 此时回答仍被门闩挡住，摘要尚未放置，status 预计是 queued 或 placed 之一；日志用于观察。
console.log("\nmanual compaction finished; its summary is", (await summary.status(context)).status);
// 放行回答；run 结束后边界会放置摘要提交。
finishAnswer();
// 等原回答结算。
await busy.wait(context);
// 等摘要提交结算并打印最终状态；正常为 done。
console.log("after the answer, the summary is", (await summary.wait(context)).status);
// 打印压缩后的模型上下文，首条通常是压缩条目。
await show(root, "after compact()");

// 场景 3：关闭后台压缩，注入一次 provider 溢出错误；generation 会压缩一次并重试同一请求。
// 3. The provider rejects a request as too long: generation compacts and retries it once. Background compaction is
// turned off so the summary below is the overflow one.
// 0 表示禁用后台压缩；阻塞阈值与手动压缩仍有效。
backgroundTokens = 0;
// 先正常问一轮；可能因超过阻塞阈值而等待压缩。
await ask("What should we pack?");
// 让下一次普通回答返回一次错误；重试会被脚本正常回答。
overflowOnce = true;
// 这一轮的首次请求被拒绝，Harness 压缩后重试；ask 等待由该轮启动的压缩任务。
await ask("Summarize the plan for my partner");

// 关闭 Harness 与内存存储；此后不能再用 root 提交。
await harness.close(context);

// 打印模型上下文。输入：会话与标签；输出：无。副作用：读取 context 与 entries 并打印。
// 示例：show(root, "after compact()") 显示摘要后的消息列表与存储条目数。
/** Print the model context: one line per message, and the number of stored entries behind it. */
async function show(conversation: Conversation, label: string): Promise<void> {
	// context() 返回模型实际看到的消息与 head 条目；压缩只影响这个视图，不改写存储中的旧条目。
	const view = await conversation.context(context);
	// 取最多 1000 条存储条目并计数；{} 无筛选，undefined 表示无游标。示例规模不会分页。
	const stored = (await conversation.entries({}, 1000, undefined, context)).items.length;
	// 对比模型上下文长度与存储条目数，直观显示压缩效果。
	console.log(`\n${label}: ${view.messages.length} messages in context, ${stored} entries stored`);
	// CompactionEntry.is 是运行时判别函数：head 是压缩条目时收窄类型并读取触发原因（manual/threshold/overflow）。
	const reason = CompactionEntry.is(view.head) ? view.head.data.reason : undefined;
	// 只有压缩条目作为 head 时才打印原因。
	if (reason !== undefined) console.log(`  (${reason} compaction summary first)`);
	// 逐条打印模型可见消息；padEnd 对齐角色列，系统提示只显示占位符，其他消息截取前 70 个字符。
	for (const message of view.messages) {
		console.log(
			`  ${message.role.padEnd(9)} ${message.role === "system" ? "(system prompt)" : text(message).slice(0, 70)}`,
		);
	}
}

// 提取消息的可读文本。输入：Message 或 undefined；输出：字符串。
// 副作用：无。示例：text(undefined) 返回 ""；字符串 content 原样返回。
function text(message: Message | undefined): string {
	// 缺失消息与系统提示都不展示；|| 收窄后后续分支不再有 system。
	if (message === undefined || message.role === "system") return "";
	// content 的运行时形状可能是字符串；typeof 检查后直接返回。
	if (typeof message.content === "string") return message.content;
	// 内容块数组只取第一个文本块；find 可能返回 undefined。
	const block = message.content.find((content) => content.type === "text");
	// 可选链与条件表达式处理缺失；replaceAll 把换行替换成空格，保证一行输出。
	return block?.type === "text" ? block.text.replaceAll("\n", " ") : "";
}
