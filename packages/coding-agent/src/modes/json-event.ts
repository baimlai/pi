// 把会话内存事件转换为JSON/RPC传输事件：流式更新去掉不断变大的partial快照，保留增量、用量和工具标识。
// Usage只用于返回对象类型，实际数据直接来自当前事件message.usage。
import type { Usage } from "@earendil-works/pi-ai";
// 会话事件的带type联合供Extract/Exclude进行编译期筛选；这些类型工具不执行运行时过滤。
import type { AgentSessionEvent } from "../core/agent-session.ts";

// 分配式条件类型：对联合的每一项判断是否有必需partial字段，有则用Omit移除；不含它的项保持原类型。
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

// toolcall_start去掉partial后额外携带id/toolName，便于接收端在不拿整份快照时开始组装工具调用。
type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? // &交叉类型在去快照的事件上增加两个必填字符串字段。
		WithoutPartial<T> & { id: string; toolName: string }
	: // 其他事件只去掉累积partial，不增加工具名/id。
		WithoutPartial<T>;

// Extract按结构从整个会话事件联合中提取message_update那一项。
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
// 传输版更新不再带完整message，只带累积usage和已经去快照的assistant增量事件。
type JsonMessageUpdateEvent = {
	// 保留事件标签，让接收方按type分支处理。
	type: "message_update";
	// 每次更新仍可携带固定字段形状的累积用量，不在此重算token/费用。
	usage: Usage;
	// 索引访问类型取得原增量联合，再用上面的条件类型转换每一项。
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

/** Session event shape emitted by the JSON and RPC stdout protocols. */
// Exclude移除原message_update，再与新的更新类型作联合；开始/结束等其他事件保持原契约。
export type JsonAgentSessionEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | JsonMessageUpdateEvent;

/**
 * 转换一条assistant流事件，移除partial；toolcall_start从快照对应块提取工具id/name。
 * 例：工具开始事件里partial很大，传输版仍只保留增量字段和目标工具标识。目标索引不是toolCall时抛错，未做深复制或JSON编码。
 */
function toJsonAssistantMessageEvent(
	// 参数是会话更新里assistantMessageEvent的具体联合类型。
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	// 先处理必须从partial快照取额外标识的特例。
	if (event.type === "toolcall_start") {
		// contentIndex指出本次开始的工具块，而非工具在注册表的索引。
		const toolCall = event.partial.content[event.contentIndex];
		// 原实现检查该块确为工具调用，避免直接从其他内容块读取id/name。
		if (toolCall?.type !== "toolCall") {
			// 不把不一致事件静默降级为空工具标识，异常交调用方处理。
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		// 对象剩余解构：partial改名为未使用的_partial，其余字段复制到deltaEvent。
		const { partial: _partial, ...deltaEvent } = event;
		// 在去快照的浅复制上追加工具标识；不序列化参数或运行工具。
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}

	// 对不带partial的事件可原样返回，不为每个小事件都创建新对象。
	if (!("partial" in event)) {
		return event;
	}

	// 其他带快照的增量只删partial；嵌套对象仍共享引用，不是JSON深克隆。
	const { partial: _partial, ...deltaEvent } = event;
	// 返回值类型体现该字段已经被移除。
	return deltaEvent;
}

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage,
 * tool-call ids, and tool names remain available because their size is constant.
 */
// 第一个重载让传入已知message_update时，TS准确知道返回JsonMessageUpdateEvent。
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
// 第二个重载接受整个会话事件联合，返回整个传输事件联合；签名本身没有函数体。
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
/**
 * 把会话事件转换成stdout协议形状：普通事件原样返回，message_update构造去累积快照的新事件。
 * 例：text_delta里不再重复传整段已生成回复，message_end仍保留最终权威消息；接收端要按增量组装。
 * 这里只转换数据，不JSON.stringify/写stdout；非assistant的message_update按当前实现抛错。
 */
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	// 只有更新事件需要瘦身，其他事件保持引用和完整内容。
	if (event.type !== "message_update") {
		return event;
	}
	// message_update的message仍是消息联合，原实现要求此协议路径必须是assistant。
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	// 新建小顶层对象，避免把event.message或event的其他字段整包展开进传输版。
	return {
		// 保留message_update标签。
		type: "message_update",
		// 传当前用量引用，真实JSON字节编码发生在外层。
		usage: event.message.usage,
		// 转换具体的文本/思考/工具调用增量。
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}
