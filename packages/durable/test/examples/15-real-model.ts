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
