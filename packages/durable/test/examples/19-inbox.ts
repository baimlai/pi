// 文件导读
// 所属：packages/durable/test/examples 的 19-inbox.ts，Durable 示例系列第 19 个，演示“忙碌会话的收件箱”。
// 演示内容：第一个回答被脚本门闩挂住，会话保持忙碌；此间提交普通 follow-up、steer、纯 write 和稍后撤回的输入，
// 再用 whenBusy: "reject" 看拒绝异常；释放后观察边界放置顺序与最终 transcript。
// 上游入口：直接运行本文件（命令见下方英文注释），顶层 await 顺序执行；没有测试框架、不断言退出码。
// 下游依赖：@earendil-works/pi-durable 的 Harness/MemoryStorage/InboxDoc/Submission，pi-ai 的 faux provider。
// 能力清单（本文件无导出，按演示步骤）：慢响应门闩；打开 Harness；四类忙碌提交；拒绝与撤回；读取 InboxDoc；
// 逐个 Submission.wait；读取 transcript 条目种类。
// 典型顺序：建 faux 响应 -> 打开内存 Harness -> 提交首个问题 -> 提交 follow-up/steer/write/withdrawn ->
// 尝试拒绝提交 -> 打印 inbox -> 放行 -> 逐个等待 -> 打印 transcript -> 关闭。
// 前置条件与输出：无需 API key 或网络；stdout 依次出现 rejected、withdraw、inbox、各项结算状态和 transcript。
// 预期行为：follow-up 与 steer 在下一轮一起被回答；withdrawn 结算为 unanswered/aborted；纯写不等待模型。
// 阅读顺序：先看门闩与 faux 队列，再看忙碌提交与拒绝/撤回，最后看边界放置和 wait 结果。
// The inbox: what happens to submissions while a conversation is busy.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/19-inbox.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, InboxDoc, MemoryStorage, type Submission } from "../../src/index.ts";

// BACKGROUND_CONTEXT 来自 chord，是不携带取消信号的共享上下文；存储、提交与等待都复用它。
const context = BACKGROUND_CONTEXT;

// The first answer waits until we let it go, so the conversation stays busy while we submit more.
// release 先声明、稍后由 Promise 执行器赋值；末尾的 ! 是明确赋值断言，告诉 TS 读取前一定已赋值。
let release!: () => void;
// held 是手动放行的 Promise<void>；执行器同步运行，把 resolve 保存到 release，调用 release() 才会兑现。
const held = new Promise<void>((resolve) => {
	release = resolve;
});
// slow 是 faux 的一步响应函数；FauxResponseStep 允许返回 Promise，因此可以先等门闩再给回答。
const slow: FauxResponseStep = async () => {
	// 等待宿主 release()；在此之前第一个 run 一直占着会话，后续提交只能排队或按策略拒绝。
	await held;
	// 门闩兑现后返回固定助手消息；内容由脚本决定，不是模型推理结果。
	return fauxAssistantMessage("Answer to the first question.");
};
// 创建脚本化假 provider；它不会发起网络请求。
const faux = fauxProvider();
// 响应队列：第一步等门闩，第二步一次性回答 follow-up 与 steer 合并后的下一轮。
faux.setResponses([slow, fauxAssistantMessage("Answer to the follow-up and the steer.")]);
// 模型目录按 provider/modelId 查找模型；这里只注册 faux。
const models = createModels();
// 注册 provider 后，agent 里的 { provider: "faux", modelId: "faux-1" } 才能解析。
models.setProvider(faux.provider);

// Settings apply to every conversation: place every queued follow-up at once instead of one per run.
// 打开 Harness：MemoryStorage 只存在本进程内；settings 是宿主级运行策略，对所有会话生效。
const harness = await Harness.open(
	new MemoryStorage(),
	// followUpMode: "all" 让一次边界把所有排队 follow-up 一起放进下一轮，而不是每轮只放一个。
	// createRegistry() 已含内置 generation/tool/compaction 任务；这里没有安装额外扩展。
	{ models, registry: createRegistry(), settings: { followUpMode: "all" } },
	context,
);
// 首次调用 root() 创建根会话；agent.model 被持久保存为名字，之后每次请求再解析。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// submit 先持久接纳输入并返回 Submission；此时 run 已开始，但答案被门闩挡住。
const first = await root.submit({ type: "input", content: "First question" }, context);

// While busy, input queues as a follow-up (the default) or a steer, and writes queue too.
// 会话忙碌且未指定 whenBusy 时，输入默认作为 follow-up 排队。
const followUp = await root.submit({ type: "input", content: "A follow-up" }, context);
// whenBusy: "steer" 让输入在当前工具轮之后加入正在进行的 run，而不是等它结束。
const steer = await root.submit({ type: "input", content: "A steer", whenBusy: "steer" }, context);
// type: "write" 只追加一条不改变模型上下文的自定义条目，因此即使在 run 中也立即放置。
const note = await root.submit({ type: "write", entry: { kind: "app.note", data: "noted while busy" } }, context);
// 这份输入先排队，稍后在边界放置前被 abort 撤回。
const withdrawn = await root.submit({ type: "input", content: "Never mind" }, context);
// whenBusy: "reject" refuses instead of queueing.
// whenBusy: "reject" 在忙碌时抛 ConversationBusy；catch 只用于展示错误消息，这次提交没有写入任何状态。
await root.submit({ type: "input", content: "Now or never", whenBusy: "reject" }, context).catch((error: Error) => {
	// 打印拒绝原因；此分支只处理展示，不重新抛出。
	console.log("rejected:", error.message);
});
// A queued submission can be withdrawn until a boundary places it.
// abort() 在输入仍排队时返回 "aborted"；若已越过边界则返回 "already_placed"，已结算则返回 "settled"。
console.log("withdraw:", await withdrawn.abort(context));

// snapshot 读取已提交的 InboxDoc；?. 在文档缺失时安全跳过。下面的 map 把排队项显示为 "id mode"。
const inbox = await harness.snapshot(InboxDoc, root.id, context);
console.log(
	"inbox:",
	inbox?.items.map((item) => `${item.id} ${item.mode}`),
);

// The first answer ends the run at a final boundary: the write is placed first, then the steer and the
// follow-up, which start the next run together.
// 放行第一个回答，run 进入最终边界；排队的 write、steer、follow-up 按规则放置。
release();
// 辅助函数：等待一份提交结算并打印状态；unanswered 时额外打印原因。
// 示例：status("first", first) 会在第一个 run 结算后打印 first: done。
const status = async (name: string, submission: Submission) => {
	// wait 只等这份提交自身，不等整个 Harness 空闲；取消 context 只会取消等待，不取消已经接纳的工作。
	const record = await submission.wait(context);
	// 三元表达式在收窄为 unanswered 后读取 reason；done 分支不需要原因。
	console.log(`${name}:`, record.status, record.status === "unanswered" ? record.reason : "");
};
// 逐个等待；first 已 done，其余排队项在同一轮或下一轮结算。
await status("first", first);
await status("follow-up", followUp);
await status("steer", steer);
await status("note", note);
await status("withdrawn", withdrawn);

// 读取最多 20 条记录，默认最新在前；{} 表示不加筛选，undefined 表示没有翻页游标。
// 下面用展开复制后 reverse 得到时间正序，只打印条目种类。
const page = await root.entries({}, 20, undefined, context);
console.log(
	"transcript:",
	[...page.items].reverse().map((entry) => entry.kind),
);
// 等待调度器停止并关闭存储；前面没有 try/finally，异常路径不会执行到这里。
await harness.close(context);
