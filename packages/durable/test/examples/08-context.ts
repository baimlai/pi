// 文件导读
// 所属：packages/durable 的 test/examples 系列第 08 个示例，演示存储转录如何推导出下一次模型请求的上下文。
// 演示内容：构造用户消息、被中止的助手消息、带两个工具调用的助手消息、乱序到达的工具结果、系统提示条目、最终回答、
//   一条编辑和一条纯展示条目；context() 展示活动条目与最终请求消息的差异；再在工具调用处分叉，观察缺失结果如何被
//   合成；最后写入 head:"self" 的摘要，观察上下文从摘要重新开始；entries() 则始终能看到完整存储历史。
// 上游入口：从 packages/durable 目录直接运行；下游调用 Harness.createConversation、Conversation.commit/fork/context/entries、
//   Tx.appendEntry 以及 pi-ai 的消息类型。没有模型请求与网络。
// 能力清单（按演示机制）：
// - assistantMessage(text, calls?, stopReason?)：构造最小 AssistantMessage；默认 stop 或 toolUse。
// - toolResultMessage(id)：构造与工具调用配对的 ToolResultMessage。
// - show(message)：按 role 收窄并渲染成可读字符串，仅用于打印。
// - appendEntry(conversationId, {kind, model})：写普通条目；model 是它对请求的贡献。
// - context()：返回 {head, entries, contributions, messages}；messages 已过滤 stop reason、应用编辑并重排工具结果。
// - 派生规则：head 开启新上下文；edits 替换/省略旧贡献；aborted/error/deferred 助手消息不发送；结果按调用顺序紧跟调用；
//   缺失结果合成错误结果；未被调用的孤立结果被丢弃；基线系统消息满足条件时移到最前。
// - fork(at)：在条目处分叉；子会话的 context() 同样为截断处的调用补齐缺失结果。
// - entries(query, limit, cursor, context)：分页读取完整历史（默认最新在前）；head/edits 不删除记录。
// 典型运行顺序：建会话 → 写用户/中止/助手调用/结果/系统/结果/回答 → 写 edit 与 note → context() 打印两视图 →
//   fork(calls.id).context() → 写 summary(head:self) → context() → entries(3) → close。
// 实际输出：
//   raw active entries: [ 'message', 'message', 'message', 'message', 'pi.system', 'message', 'message', 'edit', 'note' ]
//   request messages: [ 'system: {"cwd":"<cwd>/repo</cwd>"}', 'user: read files a and b',
//     'assistant: reading call(a) call(b)', 'result(a)', 'result(b)', 'assistant: a and b look fine' ]
//   fork messages: [ 'user: read a and b', 'assistant: reading call(a) call(b)', 'result(a) error', 'result(b) error' ]
//   after summary: summary [ 'user: Summary: a and b are fine.' ]
//   newest stored entries: [ 'summary', 'note', 'edit' ] more: true
// 阅读顺序：先看三个辅助函数了解消息形状，再看写入顺序与乱序结果，随后对照 raw active entries 与 request messages，
//   最后看 fork 的合成结果、head 摘要和 entries 分页。
// Transcript history and model context.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/08-context.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// 这些导入都带 type：只在编译期描述消息结构，运行时会被擦除。
import type { AssistantMessage, Message, StopReason, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
// Harness 只需要 models 与 registry；本示例不发起生成。
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry: createRegistry() },
	context,
);

// Entries are immutable. `model` holds the messages an entry contributes to
// the next model request; `data` is for the app only. context() turns the
// stored transcript into those request messages:
//   - an entry with `head` starts a new context; older entries stay stored,
//   - `edits` replace or omit what an earlier entry contributes,
//   - aborted, error, and deferred assistant messages are not sent,
//   - tool results are sent right after their call, in call order,
//   - a call without a result gets a synthesized error result.
// 构造一个演示用的 AssistantMessage。输入 text 是正文；calls 是工具调用 ID 列表；stopReason 可覆盖默认停止原因。
// 输出是结构完整的 AssistantMessage（含 api/provider/model/usage）；无副作用、无错误路径。
// 主要流程：正文先放 text 块，再用 calls.map 生成 toolCall 块；stopReason 缺省时按是否有调用选择 toolUse 或 stop。
// 示例：assistantMessage("reading", ["a", "b"]) 得到两个工具调用且 stopReason=toolUse；
//   assistantMessage("done") 得到 stopReason=stop；真实运行时这里只是数据，不会真的调用工具。
function assistantMessage(text: string, calls: readonly string[] = [], stopReason?: StopReason): AssistantMessage {
	return {
		role: "assistant",
		// 内容块数组：TextContent 与 ToolCall 可交错；先放文字，再展开所有 toolCall。
		content: [
			{ type: "text", text },
			// map 的回调用 `as const` 把 type 收窄为字面量 "toolCall"，否则数组元素会被推断为 string。
			// arguments 是 JSON 对象；示例给空对象，真实调用应携带参数。
			...calls.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		// api/provider/model 在真实消息里来自 provider；示例用固定标签，不参与解析。
		api: "example",
		provider: "example",
		model: "example",
		// usage 是 token 与费用统计；这里全为 0，但字段必须完整。
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// ?? 只在 undefined/null 时采用右侧；三元表达式再根据调用数量决定 toolUse 或 stop。
		stopReason: stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
		// 固定时间戳让输出可复现；真实消息使用毫秒时间。
		timestamp: 2,
	};
}

// 构造一个与工具调用配对的 ToolResultMessage。输入 id 是 toolCallId；输出可直接进入条目 model。
// 无副作用；真实工具结果应带实际输出或 isError=true，这里固定成功文本 "file <id>"。
// 示例：toolResultMessage("a") 返回 { role:"toolResult", toolCallId:"a", toolName:"read", ... }。
function toolResultMessage(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		// toolCallId 必须与助手消息里的 ToolCall.id 相同，排序逻辑据此配对。
		toolCallId: id,
		// toolName 是调用时的工具名，用于结果展示与诊断。
		toolName: "read",
		content: [{ type: "text", text: `file ${id}` }],
		isError: false,
		timestamp: 3,
	};
}

// 把任意 Message 渲染成一行文本，仅供控制台打印。输入联合类型 Message，输出 string。
// 无副作用；没有 default 分支，因为四种 role 已覆盖整个联合，TypeScript 会检查返回路径。
// switch 对 role 判别字段收窄，每个 case 内可以访问该角色的专有字段。
// 示例：show({ role:"toolResult", ..., isError:true }) 返回 "result(a) error"。
function show(message: Message): string {
	switch (message.role) {
		case "user":
			// UserMessage.content 是 string | (TextContent|ImageContent)[]；示例消息都是 string。
			// as string 是编译期断言，不做运行时转换；数组内容会按普通对象拼接。
			return `user: ${message.content as string}`;
		case "system":
			// sections 可选；JSON.stringify(undefined) 返回 undefined，模板中显示为 "undefined"。
			return `system: ${JSON.stringify(message.sections)}`;
		case "assistant":
			// 逐块渲染：text 取正文，toolCall 显示 call(id)，其余类型（如 thinking）显示空串；最后用空格连接。
			return `assistant: ${message.content
				.map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `call(${part.id})` : ""))
				.join(" ")}`;
		case "toolResult":
			// 错误结果追加 " error"；工具结果本身也可能带文本内容，但这里只显示配对 ID。
			return `result(${message.toolCallId})${message.isError ? " error" : ""}`;
	}
}

// 创建无主会话；后面所有写入都通过这个句柄。
const transcript = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
// say 是演示用写入函数：输入条目 kind 与任意多条 Message，输出 appendEntry 的记录。
// 副作用：每次调用提交一个条目；无错误处理，提交失败会拒绝返回的 Promise。
// 示例：await say("message", userMessage) 写入一条无 data、带一条模型消息的条目。
// 这里使用非类型化 overload（kind 字符串），因此 data/model 不做 token 级别的编译期约束。
const say = (kind: string, ...model: Message[]) =>
	transcript.commit((tx) => tx.appendEntry(transcript.id, { kind, model }), context);

// 第一条用户消息；记录 question 供后面的 edit 定位。
const question = await say("message", { role: "user", content: "read a and b", timestamp: 1 });
// 被中止的助手消息仍会存储，但 aborted 属于被排除的停止原因，不会进入请求上下文。
await say("message", assistantMessage("I crashed", [], "aborted")); // stored, never sent
// 带两个工具调用的助手消息；默认 stopReason 为 toolUse，记录 calls 供 fork 使用。
const calls = await say("message", assistantMessage("reading", ["a", "b"]));
// 结果 b 先到；存储顺序与调用顺序不同，context() 会重排。
await say("message", toolResultMessage("b")); // results finish out of order
// 系统提示条目：kind 为内置的 pi.system；正文为空，sections.cwd 提供工作目录段。
await say("pi.system", { role: "system", content: "", sections: { cwd: "<cwd>/repo</cwd>" }, timestamp: 4 });
// 结果 a 后到。
await say("message", toolResultMessage("a"));
// 最终回答；没有工具调用，stopReason 默认 stop。
await say("message", assistantMessage("a and b look fine"));
// 编辑条目：edits 数组指向 question 的 ID，action:"replace" 用新用户消息替换其贡献。
// 同一目标有多次编辑时只有最后一次生效；编辑不修改原条目，只改变上下文推导结果。
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "edit",
			data: "user fixed a typo",
			edits: [
				{
					target: question.id,
					action: "replace",
					messages: [{ role: "user", content: "read files a and b", timestamp: 1 }],
				},
			],
		}),
	context,
);
// 纯展示条目：只有 kind 与 data，没有 model，因此对请求上下文零贡献，但仍保存在转录里。
await transcript.commit((tx) => tx.appendEntry(transcript.id, { kind: "note", data: "display only" }), context);

// context() 读取已提交状态并推导视图；这里把返回的 view 变量留到 summary 之后再复用。
let view = await transcript.context(context);
// entries 是活动条目（包含没有 model 的 edit/note）；它们都存在，只是贡献可能为空。
console.log(
	"raw active entries:",
	view.entries.map((entry) => entry.kind),
);
// messages 是最终请求上下文：系统基线被提前，编辑已应用，aborted 消息被排除，结果按 a、b 排序。
console.log("request messages:", view.messages.map(show));

// A fork at the tool call has no results yet; context() fills them in.
// 在 calls 条目处分叉：范围到此为止，两个调用都没有结果，orderToolResults 会各合成一条错误结果。
// 分叉点早于 edit、summary 与最终回答，所以这些都不出现。
const cut = await transcript.fork(calls.id, { ownership: { kind: "ownerless" } }, context);
console.log("fork messages:", (await cut.context(context)).messages.map(show));

// A headed summary replaces everything before the entry it points at.
// "self" points the head at the summary entry itself.
// 追加带 head:"self" 的摘要条目：head 指向自身，活动上下文从这条摘要重新开始；旧条目仍在存储中。
// model 提供摘要对应的用户消息，因此摘要后只有这一条消息。
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "summary",
			head: "self",
			model: [{ role: "user", content: "Summary: a and b are fine.", timestamp: 5 }],
		}),
	context,
);
// 重新读取：head 是 summary 条目，messages 只剩摘要消息。
view = await transcript.context(context);
// head 可能为 undefined，?. 安全访问 kind。
console.log("after summary:", view.head?.kind, view.messages.map(show));

// entries() pages the stored transcript, newest first, including inherited
// parent entries. Nothing is ever deleted by heads or edits.
// entries(query, limit, cursor, context)：query 不含 conversationId（句柄已绑定），limit=3，cursor undefined 从最新开始。
// 返回 Page<EntryRecord, Cursor>；next 为 undefined 表示没有更多，否则是下一页游标。
const history = await transcript.entries({}, 3, undefined, context);
// items 是最新三条：summary、note、edit；历史仍完整，head 与 edits 只影响上下文推导。
console.log(
	"newest stored entries:",
	history.items.map((entry) => entry.kind),
	"more:",
	history.next !== undefined,
);

// 关闭 Harness 与存储。
await harness.close(context);
