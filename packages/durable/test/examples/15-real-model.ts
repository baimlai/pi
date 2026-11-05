// 文件导读
// 所属：packages/durable 的 test/examples 系列第 15 个示例，演示真实 OpenAI 模型的流式回答与 LiveDoc 观察。
// 演示内容：仅在 OPENAI_API_KEY 存在时注册 openai provider，用 faux 之外的工厂读取环境认证；创建根会话并选择真实模型；
//   观察内置 pi.live 文档，把 generation 已提交的文本增量按前缀去重写到 stdout；提交写诗请求并等待结算；最后从最终
//   AssistantEntry 补齐可能未作为 partial 提交的尾部文本。
// 上游入口：从 packages/durable 目录手动运行；下游调用 openaiProvider、createModels.setProvider、Harness.open/root、
//   Harness.watchDoc(LiveDoc)、WatchHandle.start/stop、Conversation.submit、Submission.wait、Conversation.commit/tx.entry。
//   会产生真实网络请求与费用；异常直接传播，且没有 finally，失败时不保证关闭 Harness。
// 能力清单（按演示机制）：
// - process.env.OPENAI_API_KEY：只判断是否为 undefined；空字符串仍进入真实分支，认证错误可能发生。
// - openaiProvider()：读取环境变量并注册 openai provider；模型请求由 Harness 统一发起。
// - LiveDoc：内置实时文档；生成期间按节流提交部分文本，watch 只看到已提交值，不是每个网络分片。
// - watchDoc/start/stop：观察回调接收 value/failed 帧；本示例只处理 value，并在最终读取前 stop。
// - printText：保存已打印前缀，只输出新后缀；文本变短或前缀变化时忽略，属于显示策略而非数据校验。
// - submit(...).wait(context)：受理输入并等待 done/unanswered；未回答时打印 reason/detail，不设置非零退出码。
// - AssistantEntry 读取：从最终条目取首个文本块，补齐节流窗口可能遗漏的结尾。
// 典型运行顺序：检查环境变量 → 注册 provider 与扩展 → open → root(agent=openai/gpt-6-sol, high) → watchDoc(LiveDoc) →
//   start 观察 → resume → submit 写诗请求 → wait → stop → 从 AssistantEntry 补尾部 → close。
// 示例（真实命令行；会联网并计费）：
//   cd packages/durable
//   OPENAI_API_KEY=sk-... node --conditions=source --experimental-strip-types test/examples/15-real-model.ts
// 无变量时实际输出：skipped: OPENAI_API_KEY is not set
// 有变量时输出以 "answer: " 开头、随后是流式文本，最后换行；具体内容取决于模型响应，本注释未运行该分支。
// 阅读顺序：先看环境变量分支与 openaiProvider，再看 LiveDoc 观察回调里的可选链与类型收窄，随后看 printText 的前缀去重，
//   最后看结算后从 AssistantEntry 补尾部。
// 前置条件：有效的 OPENAI_API_KEY、可访问 OpenAI 的网络与账户额度；示例没有超时/重试配置，错误会直接拒绝。
// 这是手动示例，没有配套自动化测试；可对照 04-watches.ts（watch 语义）与 13-chat.ts（faux 版本）。
// 真实网络示例：仅在环境变量存在时注册 OpenAI、生成诗歌并跟踪已提交的文本增量。
// 这里只说明代码，不运行它；缺 key 才跳过，空字符串仍会进入 else，认证错误仍可能发生。
// A real model: stream an answer from OpenAI.
// Run from packages/durable (needs OPENAI_API_KEY):
//   node --conditions=source --experimental-strip-types test/examples/15-real-model.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	LiveDoc,
	MemoryStorage,
	section,
} from "../../src/index.ts";

// 把共享上下文用于会话读写、观察和关闭。
const context = BACKGROUND_CONTEXT;

// Production code passes a Models collection with real providers; the Harness
// never talks to a provider any other way. openaiProvider() reads
// OPENAI_API_KEY from the environment. While the answer streams, generation
// commits throttled partials to the conversation's pi.live document. Watching
// that document streams the answer; the watch sees only committed values.
// Node 环境变量是 string|undefined；这只检查变量是否存在，不校验密钥有效性。
if (process.env.OPENAI_API_KEY === undefined) {
	// 缺变量只输出跳过信息，没有创建 Harness。
	console.log("skipped: OPENAI_API_KEY is not set");
} else {
	// 创建此次运行使用的模型集合。
	const models = createModels();
	// 注册真实提供方，后续生成会读取认证并访问服务。
	models.setProvider(openaiProvider());
	// 创建含内置任务的注册表。
	const registry = createRegistry();
	// 安装 concise 扩展，让系统提示词参与请求准备。
	registry.install(
		defineExtension({
			name: "concise",
			// 无参回调产生固定文本，不加 XML 风格标签；它不保证真实模型一定简洁。
			sections: [section("preamble", () => "You are a concise assistant.", { tag: false })],
		}),
	);
	// 打开内存会话，关闭后不留下可恢复记录。
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	// 取得根会话，在首次创建时选择下面的真实模型和思考级别。
	const root = await harness.root(context, {
		// 模型 ID 和 high 是请求配置，本例没有探测服务端是否可用。
		agent: { model: { provider: "openai", modelId: "gpt-6-sol" }, thinkingLevel: "high" },
	});
	// 观察根的 pi.live 文档；末尾 ! 仅告诉 TypeScript 假定存在，不在运行时检查。
	const liveWatch = (await harness.watchDoc(LiveDoc, root.id, context))!;
	// Print only what each committed partial adds to the text printed so far.
	// 保存已输出前缀，避免每次提交的完整 partial 重复显示。
	let printed = "";
	// 输入当前累计文本，只把它在 printed 之后的后缀写到 stdout，并更新闭包状态。
	// 例如先 Paris 再 Paris. 只追加句点；不接受变短或改写前缀的文本，写入错误向外抛。
	const printText = (text: string): void => {
		// 长度不增长或前缀已变化就忽略；这是显示策略，不是提供方数据校验。
		if (text.length <= printed.length || !text.startsWith(printed)) return;
		// 从已打印长度截取新后缀；stdout.write 的背压返回值在这个小例子里未处理。
		process.stdout.write(text.slice(printed.length));
		// 更新累计前缀，供下一次回调比较。
		printed = text;
	};
	// 登记异步观察回调；输入是文档观察事件，返回 Promise<void>，只对值事件输出。
	// 观察到的是提交后的状态，不是每一个模型网络分片；回调异常由观察机制报告。
	liveWatch.start(async (call) => {
		// 忽略非值事件，同时通过 kind 缩小联合类型。
		if (call.kind !== "value") return;
		// 解构此次已提交文档值。
		const { value } = call;
		// 可选链沿生成中消息查首个 text 块；没有生成或没有文本时为 undefined。
		const block = value?.generation?.message?.content.find((content) => content.type === "text");
		// 进一步缩小块类型后读取 text；这里只显示首个文本块。
		if (block?.type === "text") printText(block.text);
	});
	// 显式启用调度；后面的 submit/wait 本来也会请求进展。
	harness.resume();
	// 先打印回答前缀，不换行。
	process.stdout.write("answer: ");
	// 提交真实输入，返回受理句柄而非诗歌文本。
	const poem = await root.submit({ type: "input", content: "Write a long poem" }, context);
	// 等这份输入被回答或以 unanswered 结束；网络/存储异常也可让等待拒绝。
	const settledPoem = await poem.wait(context);
	// 停止监听后，再从最终条目补显示未进入节流 partial 的内容。
	await liveWatch.stop();
	// 只有已回答输入含 answer ID，后续才能查询回答。
	if (settledPoem.status === "done" && settledPoem.type === "input") {
		// The last throttle window may not have been committed as a partial; the answer entry has the rest.
		// 事务回调按 AssistantEntry 类型读取最终回答；它不再次生成。
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settledPoem.answer), context);
		// 只看首条模型消息，缺失时保留 undefined。
		const message = entry?.model?.[0];
		// 仅对 assistant 内容寻找首个 text 块；其他角色得到 undefined。
		const block =
			message?.role === "assistant" ? message.content.find((content) => content.type === "text") : undefined;
		// 复用前缀去重逻辑补齐尾部。
		if (block?.type === "text") printText(block.text);
		// 正常回答结束后换行。
		process.stdout.write("\n");
	} else {
		// 未回答则打印原因和细节；这里没有另设非零退出码。
		console.log("unanswered:", settledPoem.reason, settledPoem.detail);
	}
	// 关闭调度与存储；本例没有 finally，异常中断时不保证执行到此。
	await harness.close(context);
}
