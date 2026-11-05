// 最小聊天脚本：注册预设模型和提示词，提交一个问题，再读取其回答与记录。
// 顶层 await 按顺序等待异步操作；没有 catch，存储/提交等异常会使脚本失败。这里只演示 faux，不访问真实模型。
// A chat turn.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/13-chat.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, Harness, MemoryStorage, section } from "../../src/index.ts";

// 共享操作上下文，传给存储、会话和等待操作；它不额外设置本次调用的取消信号。
const context = BACKGROUND_CONTEXT;

// The faux provider stands in for a real model (see 15-real-model.ts).
// 创建内存假模型；响应内容由下面的队列决定，不会根据问题推理。
const faux = fauxProvider();
// 创建这个 Harness 使用的模型集合。
const models = createModels();
// 把 faux 的提供方和模型注册进去，供 provider/modelId 查找。
models.setProvider(faux.provider);
// 排队一个固定助手回答；例如这个问题会得到 Paris.，这不是对任意首都问题的实现。
faux.setResponses([fauxAssistantMessage("Paris.")]);

// 建立含内置任务的扩展注册表。
const registry = createRegistry();
// 安装 terse 扩展。defineExtension 只帮助 TypeScript 检查结构，实际提示词由生成任务渲染。
registry.install(
	defineExtension({
		// 扩展的唯一名称。
		name: "terse",
		// 无参回调每次渲染都返回固定要求；tag:false 不加 <preamble> 标签。预设回答并不会被这段要求约束。
		sections: [section("preamble", () => "You answer in one word.", { tag: false })],
	}),
);
// 打开只存在于本进程内的存储与任务调度器；重启脚本不会保留会话。
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// 取得根会话并在首次创建时选择 faux-1 模型。
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// submit() durably admits user input and returns a Submission. The built-in
// pi.generation task prepares the system prompt from the agent's sections,
// calls the model, and appends the answer; wait() resolves once the input is
// answered or has failed.
// 提交输入并取得 Submission 句柄；此 await 等受理，不等回答写完。
const capital = await root.submit({ type: "input", content: "Capital of France?" }, context);
// 等待这份输入成为 done 或 unanswered；只等它自身，不等整个 Harness 空闲。
const answered = await capital.wait(context);
// 两个判别字段共同缩小联合类型，只有已答输入才有 answer 条目 ID。
if (answered.status === "done" && answered.type === "input") {
	// 在会话事务里按类型和 ID 查回答；回调返回读取 Promise，外层 await 取得条目或 undefined。
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, answered.answer), context);
	// 可选链遇到缺失值返回 undefined，[0] 只看该条目的首条模型消息。
	const reply = entry?.model?.[0];
	// 只有首条消息是 assistant 才打印内容，否则打印原值；失败分支在此示例中没有额外输出。
	console.log("answer:", reply?.role === "assistant" ? reply.content : reply);
}

// The transcript holds the user input, the positional system prompt, and the answer.
// 按默认逆序最多读取十个条目；{} 不加筛选，undefined 表示没有翻页游标。
const transcript = await root.entries({}, 10, undefined, context);
// 打印条目种类：先用展开创建数组再 reverse，不反转原分页数组；map 只提取 kind。
console.log(
	"transcript:",
	[...transcript.items].reverse().map((entry) => entry.kind),
);
// 停止调度并关闭存储；本例没有 finally，前面的异常会跳过这里。
await harness.close(context);
