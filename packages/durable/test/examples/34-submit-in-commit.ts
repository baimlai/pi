// 文件导读
// 所属：packages/durable/test/examples 的 34-submit-in-commit.ts，Durable 示例系列第 34 个，
// 演示“在宿主提交内接纳输入”。
// 演示内容：根会话运行一个会阻塞的 build 工具；宿主在同一个 commit 里检查访客文档、用
// root.submit(tx, draft) 接纳访客消息，再把消息写入文档。消息设置 whenBusy=steer、whenIdle=reject：
// 忙时并入当前 run，空闲时以 ConversationIdle 拒绝且不写任何东西。Bob 被宿主自己的 muted 检查拒绝。
// 上游入口：node 直接运行本文件；固定 faux 响应，无网络；build 工具用 Promise 门闩一直等到 release()。
// 下游依赖：Durable 的 Harness/defineDoc/defineExtension/defineTool/ConversationIdle，pi-ai faux，pi-schema obj。
// 能力清单：Visitors 会话文档；working 门闩与 build 工具；两条 faux 响应；muted 初始化；
// message 宿主函数；空闲拒绝、忙碌 steer、muted 拒绝三条路径；release 后等待与打印；文档快照。
// 典型顺序：定义文档与工具 -> 配置 faux -> 打开 Harness 并建根会话 -> 写入 muted -> 空闲消息被拒 ->
// 启动 build run -> 忙碌消息 steer -> muted 消息被拒 -> 放行 build -> 等 run 与空闲 -> 打印记录与 sent 数组。
// 前置条件：无需 API key；build 工具真的会等待，release 前 run 保持忙碌；事务内只能经 tx 读写。
// 预期输出：ana 的空闲消息被拒；ana 的忙碌消息被接纳并返回 submission ID；bob 被 muted 拒绝；
// 记录中有 Build the project 与 ana 的 steer 两条用户消息，以及最终回答；Visitors.sent 只含 ana 那一条。
// 阅读顺序：先看 Visitors 与 build 门闩，再看 message 的三步提交，最后看三条路径的输出与文档快照。
// A host lets people message an agent while it works: a message must join the current run as a steer and never start a
// run of its own. `submit(tx, draft)` admits it inside the host's own commit, together with the host's check and its own
// state; `whenIdle: "reject"` refuses it when no run is working.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/34-submit-in-commit.ts

// BACKGROUND_CONTEXT 是不带取消信号的根上下文；所有提交、等待与快照读取都用它。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj } from "@earendil-works/pi-schema";
import {
	// ConversationIdle 是空闲拒绝时抛出的错误类；message 用它区分“现在没人工作”与其他失败。
	ConversationIdle,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// The host's own state: who may message this conversation, and what they sent.
// 声明会话文档 Visitors：muted 是禁言名单，sent 记录成功接纳的消息。
// defineDoc 的泛型给出值的形状；kind/version 决定持久身份，scope/history/fork 决定生命周期与分叉语义。
// 初始值在文档首次创建时写入；checkpointWhen 决定普通变更是否存完整 base。
const Visitors = defineDoc<{ muted: string[]; sent: { from: string; text: string }[] }>({
	// kind 是持久化种类名，也是公开协议的一部分；改名等于换一种文档，旧记录不会自动匹配。
	kind: "app.visitors",
	// version 描述值形状；以后改变形状时递增，并提供 migrate 把旧值转成新形状。
	version: 1,
	// 会话文档随会话创建与删除；同一会话内按 kind 只有一份。
	scope: "conversation",
	// 只保留当前值，不保留可按条目回看的历史；因此不能对它做 snapshotAsOf。
	history: "latest",
	// 分叉时从定义的 initial 值开始，而不是复制源会话的当前值；适合每个会话独立的访客状态。
	fork: "initial",
	// 首次创建时调用；返回值必须是纯 JSON 对象，两个数组随后由提交内的 Draft 修改。
	initial: () => ({ muted: [], sent: [] }),
	// 普通变更永不存完整 base，只追加 delta；初始 base 仍会创建。这样写入便宜，但增量链会变长。
	checkpointWhen: () => false,
});

// A tool that waits until released, so messages arrive while the run works.
// 明确赋值断言：release 会在 Promise 构造器里同步赋值，但 TypeScript 无法跨回调证明，因此这里用 !。
let release!: () => void;
// 一个永不自动完成的门闩：只有调用 release() 才 resolve，用来把 build 工具（以及整个 run）卡在忙碌状态。
const working = new Promise<void>((resolve) => {
	// Promise 构造器同步执行，所以这一行在 working 创建时立刻运行；外部随后可调用 release()。
	release = resolve;
});
// 声明 build 工具：它等待门闩，示例借此让宿主有机会在 run 进行中提交消息。
const build = defineTool({
	name: "build",
	description: "Build the project",
	// 空对象 schema 表示没有参数；模型传来的参数仍会经过运行时校验，execute 不接收任何字段。
	parameters: obj({}),
	// execute 挂起直到 working resolve；工具任务保持运行，因此会话处于忙碌，steer 才有意义。
	execute: async () => {
		// 等待期间 run 不会结束；这不是 sleep，而是真实的 Promise 挂起，不会占用事件循环。
		await working;
		// 门闩放行后返回文本结果；这次工具结果会进入下一轮模型请求。
		return { output: [{ type: "text", text: "built" }] };
	},
});

// faux provider 默认模型 id 为 faux-1，响应来自下面的两条脚本，不访问网络。
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// 第一条让模型调用 build，第二条是 build 完成后、看到 steer 输入时的最终回答。
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("build", {}), { stopReason: "toolUse" }),
	fauxAssistantMessage("Built, and I added the test Ana asked for."),
]);
// 注册表持有 build 扩展；默认 settings 会选用全部已安装扩展。
const registry = createRegistry();
registry.install(defineExtension({ name: "build", tools: [build] }));
// 内存存储让示例自包含；打开 Harness 后输入提交会启动生成与工具任务。
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// 根会话显式选择 faux-1；没有 maxTurns 等其他配置，使用默认值。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
// 初始化宿主文档：在一个提交里读出 Draft 并修改，提交成功后 muted 才对后续读取可见。
await root.commit(async (tx) => {
	// tx.doc 返回 Chord 的 Draft：对 .muted 的 push 会被记录成文档 op，不需要手工构造新对象。
	// Draft 只在本次事务内有效，提交后不要继续持有或修改它。
	(await tx.doc(Visitors, root.id)).muted.push("bob");
}, context);

// 宿主函数 message：检查访客、接纳输入、记录消息，三件事在同一个提交里完成。
// 输入 from/text/requestId；输出一段说明字符串；副作用是可能写提交与文档，失败时全部不生效。
// 流程：harness.commit 开启事务 -> tx.doc 读取 Visitors -> 检查 muted -> root.submit(tx, ...) 接纳 ->
// visitors.sent.push 记录 -> 返回 submission ID。ConversationIdle 被转成友好文本，其他错误继续抛。
// 例：await message("ana", "Add a test.", "ana-1") 在空闲时得到 "ana: the agent isn't working now"。
/** A visitor's message: checked, admitted as a steer of the current run, and recorded, in one commit or not at all. */
// requestId 由调用方给出，用于会话内去重；相同键重复提交不会创建第二条输入。
async function message(from: string, text: string, requestId: string): Promise<string> {
	// try 包住整个提交：空闲拒绝发生在提交内部，需要转换成可打印的结果，而不是让示例崩溃。
	try {
		// harness.commit 在 Session 变更线上运行一个原子事务；回调只能通过 tx 读取当前提交能看到的状态。
		// 返回 Promise：回调结果在提交存储并发布后才解析。
		return await harness.commit(async (tx) => {
			// 事务内读取文档 Draft，而不是调用 harness.snapshot；后者会排队等待当前事务，造成死锁。
			const visitors = await tx.doc(Visitors, root.id);
			// 宿主自己的检查先于接纳：被禁言时直接返回，不创建提交、不写文档，事务中没有任何变更。
			if (visitors.muted.includes(from)) return `${from} is muted`;
			// Before the commit's own table writes; document writes may come before or after.
			// 在调用方事务内接纳输入，返回 SubmissionId；审批与本次提交同生共死，提交失败则输入不存在。
			// 它必须排在本次提交的第一条表写入之前，文档写入则可在它前后。
			const id = await root.submit(tx, {
				type: "input",
				// 用户消息内容带上来源；这条文本会作为 user message 进入模型上下文。
				content: `${from}: ${text}`,
				// 忙时作为 steer 插入当前 run，而不是排队等下一轮；当前 run 在工具边界后会看到这条输入。
				whenBusy: "steer",
				// 空闲时以 ConversationIdle 拒绝，且不写任何东西；这样消息永远不会自行启动一个 run。
				whenIdle: "reject",
				// 把调用方的去重键传给接纳记录；同一会话内重复的 requestId 会复用已有提交。
				requestId,
			});
			// 文档写入放在接纳之后：它属于同一提交，提交成功时消息与记录一起可见，失败时一起消失。
			visitors.sent.push({ from, text });
			// 提交回调的返回值原样成为 harness.commit 的结果；这里用它展示接纳到的提交 ID。
			return `${from}'s message is submission ${id}`;
		}, context);
	} catch (error) {
		// catch 参数是 unknown，先做运行时判别再访问错误类型；这里只把预期的空闲拒绝转成文本，
		// 其他错误重新抛出，避免掩盖真正的提交失败。
		if (error instanceof ConversationIdle) return `${from}: the agent isn't working now`;
		throw error;
	}
}

// 第一次调用时还没有 run：whenIdle=reject 抛 ConversationIdle，文档也不会记录这次消息。
console.log(await message("ana", "Add a test for the build.", "ana-1")); // idle: refused, nothing written
// 这次 input 在空闲时启动 run；模型请求 build 工具，工具卡在 working 上，run 保持忙碌。
const run = await root.submit({ type: "input", content: "Build the project." }, context);
// run 忙碌，whenBusy=steer 生效：消息并入当前 run，同时写入 Visitors.sent；requestId 与第一次不同。
console.log(await message("ana", "Add a test for the build.", "ana-2")); // busy: joins the run as a steer
// bob 在 muted 中，宿主函数在接纳前返回；这次提交没有提交记录，也没有文档变化。
console.log(await message("bob", "Delete everything.", "bob-1")); // the host's own check refuses it
// 放行 build 工具：工具返回结果，生成任务继续；已经在当前 run 中的 steer 输入会在下一轮请求里被模型看到。
release();
// 等待最初那条 input 结算；steer 不创建新的 run，它属于同一个运行。
await run.wait(context);
// run 结算后仍可能有任务或提交在收尾，这里等普通所有权范围完全空闲，便于稳定打印。
await root.waitForIdle(context);

// 按时间顺序读取记录，用来验证只有两条用户消息进入了 transcript。
const page = await root.entries({ order: "ascending" }, 100, undefined, context);
for (const entry of page.items) {
	// 与 message 函数同名的局部变量遮蔽了外层函数；这里只用于读取记录中的模型消息。
	const message = entry.model?.[0];
	// 打印用户消息：Build the project 与 ana 的 steer；被拒绝的两次消息不会出现。
	if (message?.role === "user") console.log(">", message.content);
	// 只打印最终回答；工具调用轮的助手消息 stopReason 是 toolUse，被排除。
	if (message?.role === "assistant" && message.stopReason === "stop") {
		// 把文本块拼成一段；最终回答提到 Ana 的测试，说明 steer 输入确实进入了模型上下文。
		console.log("agent:", message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
	}
}
// 读取已提交文档快照：只有 ana 的忙碌消息被记录；空闲拒绝与 muted 拒绝都没有写文档。
console.log("recorded:", (await harness.snapshot(Visitors, root.id, context))?.sent);
// 关闭 Harness 管理的会话、任务与调度；内存存储随进程结束丢弃。
await harness.close(context);
