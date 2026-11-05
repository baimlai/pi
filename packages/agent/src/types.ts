// 定义 Agent 的公开契约：模型请求回调、消息、工具、状态、事件与回合调度。这里的 type/interface 主要在编译时生效，真正执行请沿 agent.ts 和 agent-loop.ts 阅读。
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
	JsonValue,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
// Static 把 schema 类型映射成工具参数的 TS 类型；它本身不是运行时参数校验器。
import type { Static } from "@earendil-works/pi-schema";

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * The loop passes a normalized transcript: the system prompt and tool
 * declarations are carried by the transcript's system messages, never by
 * `context.systemPrompt` or `context.tools`.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
// 模型请求函数类型。外部传进实现，Agent 核心只按这份签名调用；下面是参数及返回值，不是一次真实请求。
export type StreamFn = (
	// 输入模型元数据，Api 表示支持的协议联合；不是已经建立的网络连接。
	model: Model<Api>,
	// 输入规范化历史，system 规则和工具声明都放在消息中；不用另传 context.tools 来声明模型工具。
	context: TranscriptContext,
	// 可选生成参数、凭证、取消信号及请求回调。? 表示调用方可省略整个参数。
	options?: SimpleStreamOptions,
	// 箭头右边是返回类型：立即给事件流，或等待后给事件流；完整消息仍从流的 result() 获得。
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
// 字面量联合：只允许两个字符串。sequential 逐个完成；parallel 顺序做前置检查后并发执行，结果消息仍按调用顺序发布。
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
// 每次消费队列可全取或只取最早一条；这决定消息投递数量，不决定工具是否并发。
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
// 类型拆解：先取 content 数组元素联合，再用 Extract 只保留 type:toolCall。例：文字块不会被当作工具调用。
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
// 工具前置钩子的返回值：可不阻止、阻止、附原因，或阻止后要求终止。普通对象，并非 Error 实例。
export interface BeforeToolCallResult {
	// true 才阻止执行；未提供表示没有阻止要求。模型仍会收到一条对应的错误工具结果。
	block?: boolean;
	// 阻止原因，例如“当前路径不允许读取”；没给时循环使用默认说明。
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	// 停止本批工具后自动续轮的提示；只有本批非空且所有最终结果都为 true 才整体终止。
	terminate?: boolean;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `usage`: if provided, replaces the tool result usage
 * - `terminate`: if provided, replaces the early-termination hint
 * - `structuredContent`: if provided, replaces the structured content. If `content` is provided
 *   without it, the structured content is dropped, because it may no longer match the content.
 *   Return it along with `content` to keep it.
 *
 * Other omitted fields keep the original executed tool result values.
 * There is no deep merge for `content`, `details`, or `usage`.
 */
// 工具后置钩子的部分覆盖值：只替换提供了的字段，不对 content/details/usage 做深层合并。
export interface AfterToolCallResult {
	// 覆盖模型可见内容整数组，元素可为文字或图片；数组里再嵌套数组不符合此类型。
	content?: (TextContent | ImageContent)[];
	// 任意结构的附加详情，unknown 要先收窄类型才能访问字段，避免把它当成已知格式。
	details?: unknown;
	// 面向程序的 JSON 输出，不直接发模型；若只替换 content 不给它，旧结构化输出可能被丢弃以免不一致。
	structuredContent?: JsonValue;
	// 可明确覆盖工具成功/失败标志，false 与“没传”不同；代码用 ?? 合并，能保留显式 false。
	isError?: boolean;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	// 工具自己产生的用量，可用于统计；不是主模型这次输入上下文 token 的替代值。
	usage?: Usage;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	// 停止本批工具后自动续轮的提示；只有本批非空且所有最终结果都为 true 才整体终止。
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
// 执行前提供给钩子的上下文；参数 schema 校验已完成，真正工具函数尚未执行。
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	// 发起这次调用的模型消息；可能一条消息里包含多个工具调用。
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	// 原始调用内容块，包含 id/name/arguments；id 用来与后面的工具结果配对。
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	// 已通过目标工具 schema 校验的参数值；通用钩子不知道具体工具结构，所以静态类型仍是 unknown。
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	// 当前运行的消息历史和可执行工具；外部钩子可据此做决策。
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
// 工具执行完成、发布最终工具事件之前传入的上下文，比前置钩子额外多 result/isError。
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	// 发起这次调用的模型消息；可能一条消息里包含多个工具调用。
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	// 原始调用内容块，包含 id/name/arguments；id 用来与后面的工具结果配对。
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	// 已通过目标工具 schema 校验的参数值；通用钩子不知道具体工具结构，所以静态类型仍是 unknown。
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	// 工具内容及详情的统一形状；现有 any 兼容不同工具各自的 details 类型，调用方仍应按实际工具解读。
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	// 必填成功/失败标志；工具抛异常或被阻止通常会得到 true。
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	// 当前运行的消息历史和可执行工具；外部钩子可据此做决策。
	context: AgentContext;
}

/** Context passed to completed-turn callbacks. */
// 一个已完成模型回合的快照：一条 assistant 加它请求的全部工具结果，供结束/准备回调读取。
export interface AgentTurnContext {
	/** The assistant message that completed the turn. */
	// 刚完成的模型消息，可能是最终文字，也可能带工具调用。
	message: AssistantMessage;
	/** Tool result messages emitted for the completed turn. */
	// 这条模型消息要求的已完成工具结果；没有工具调用时是空数组。
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	// 当前运行的消息历史和可执行工具；外部钩子可据此做决策。
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	// 仅本次低层运行新增的消息。新 prompt 包含起始输入，continue 不重复包含已有历史。
	newMessages: AgentMessage[];
}

/** Decision returned by {@link FinishTurn}. Returning undefined preserves normal scheduling. */
// 带标签联合：回合决策只能是 continue 或 end。新增 action 时调用方的分支也应重新检查。
export type AgentTurnDecision = { action: "continue" } | { action: "end" };

/**
 * Called after a completed assistant turn and all of its tool-result messages, but before `turn_end`.
 * On a normal turn, `{ action: "continue" }` ensures one next provider request. Tool-result, steering, or
 * follow-up scheduling can satisfy that request and adds no extra request; otherwise the loop continues once
 * with the current context. Error and aborted responses remain hard exits.
 */
// 回合完成钩子类型，在模型及工具结果都发布后、turn_end 前调用；错误/取消仍是低层硬退出。
export type FinishTurn = (
	// 拿到本轮结果与历史，可据此要求再生成一次，或立即结束。
	turn: AgentTurnContext,
	// 可选取消信号；异步钩子需要自己响应它，类型声明不会自动中断 await。
	signal?: AbortSignal,
	// 允许同步或异步决策，也可不返回以保留正常调度；正常工具续轮可满足 continue，不额外多发一次。
) => AgentTurnDecision | void | Promise<AgentTurnDecision | undefined> | Promise<void>;

/** Replacement runtime state used by the agent loop before starting another provider request. */
// 请求前/下一回合准备回调可以返回的局部替换状态；未给字段通常沿用现值。
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	// 可整体替换下一次请求使用的上下文，例如压缩后的摘要加近期消息。
	context?: AgentContext;
	/** Messages to append before the next provider request, with normal lifecycle events. */
	// 可追加的新消息，会正常发布 message_start/end；与 context 整体替换不是同一种操作。
	messages?: AgentMessage[];
	/** Model for the next provider request. */
	// 可指定下一次/当前准备中的物理模型，工具执行途中切模型也能在请求边界生效。
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	// 可替换思考级别；undefined 通常表示不变，off 表示明确关闭。
	thinkingLevel?: ThinkingLevel;
}

/** Runtime state available immediately before a conversational provider request. */
// 每次模型请求前可见的运行状态，包含第一轮；与仅后续回合才触发的 prepareNextTurn 不同。
export interface PrepareRequestContext {
	// 当前运行的消息历史和可执行工具；外部钩子可据此做决策。
	context: AgentContext;
	// 本次选中的模型元数据；泛型标示协议类型，现有 any 允许通用运行器接纳不同协议。
	model: Model<any>;
	// 当前请求的统一思考级别，类型将可用字符串限制在下面的联合中。
	thinkingLevel: ThinkingLevel;
}

/** Replacement runtime state for the provider request being prepared. */
// Omit 从准备状态里去掉 messages：prepareRequest 负责替换请求快照，不在这里额外发新消息事件。
export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

/**
 * Called immediately before every conversational provider request, including the first.
 * Pending messages have already been appended and emitted when this callback runs.
 */
// 每次请求前的同步/异步回调签名，调用时待发消息已经追加和发出事件。
export type PrepareRequest = (
	// 当前上下文、模型、思考级别组成的请求快照。
	request: PrepareRequestContext,
	// 可选取消信号；异步钩子需要自己响应它，类型声明不会自动中断 await。
	signal?: AbortSignal,
	// 可返回替换字段，也可没有更新；Promise 说明允许等待认证以外的准备、路由等工作。
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

// 空接口继承上一回合快照结构，用独立名字表达“下一回合准备”的语义；没有新增运行时代码。
export interface PrepareNextTurnContext extends AgentTurnContext {}

// 低层循环配置继承模型请求选项，再增加消息转换、工具钩子、队列读取和回合调度等能力。
export interface AgentLoopConfig extends SimpleStreamOptions {
	// 本次选中的模型元数据；泛型标示协议类型，现有 any 允许通用运行器接纳不同协议。
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a SystemMessage, UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	// 必填转换函数：把应用消息转成模型标准消息数组，或过滤仅供 UI 的消息；转换不等于调用模型。
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	// 在 convertToLlm 前加工 Agent 消息，例如裁剪旧历史；缺省保持原数组。失败契约要求用安全兜底，避免破坏正常事件序列。
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	// 按供应商动态取凭证，适合会过期的 OAuth；取不到返回 undefined，让请求选项继续决定是否可用。
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after the assistant message and all tool-result messages have been emitted, immediately before `turn_end`.
	 * `{ action: "end" }` ends the run without polling queues or preparing another request.
	 * On a normal turn, `{ action: "continue" }` ensures one next provider request. Tool-result, steering, or
	 * follow-up scheduling can satisfy that request and adds no extra request; otherwise the loop continues once
	 * with the current context. Returning undefined preserves normal scheduling. Error and aborted responses remain
	 * hard exits.
	 */
	// 模型和本批工具结束后决定 continue/end；未提供就沿用正常工具/队列调度。
	finishTurn?: FinishTurn;

	/**
	 * Called immediately before every conversational provider request, including the first.
	 * Pending messages have already been appended. The returned context, model, and thinking level
	 * replace the runtime values for this and later requests in the run. This hook does not poll queues.
	 */
	// 包含首轮在内，每次请求前可以替换上下文/模型/思考级别，本钩子不读取队列。
	prepareRequest?: PrepareRequest;

	/**
	 * Called after `turn_end` when the loop will continue, immediately before the next turn starts.
	 * Return replacement context/model/thinking state or messages to append to affect that turn.
	 * Return undefined to keep using the current context/config.
	 */
	// 只有循环确认要进入后续回合时才调用，早于下一次 turn_start，可刷新规则或加入消息。
	prepareNextTurn?: (
		// 上一回合已完成的信息，含模型回复、全部工具结果与本次新增消息。
		context: PrepareNextTurnContext,
		// 允许同步/异步准备，返回 undefined 保持现有状态；返回 messages 会正常追加并发布生命周期事件。
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `finishTurn` ends the run.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	// 读取并消费本次插话队列的异步回调；当前模型和工具完整完成后，下一次模型请求前投递。
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	// 模型没工具也没插话、准备自然停止时才读追问，返回非空数组就接着工作。
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	// 配置本批工具执行默认策略，parallel 不意味着前置权限钩子也会并行。
	toolExecution?: ToolExecutionMode;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * A blocked result can also set `terminate: true` to participate in the batch early-termination rule.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	// 参数校验后、真正 execute 前的异步拦截；例如拒绝某路径并把原因返回给模型。
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `usage` replaces the tool result usage
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	// 工具完成、结束事件与结果消息发布前处理返回值；只返回要覆盖的字段即可。
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata from @earendil-works/pi-ai to detect support for a concrete model.
 */
// 应用统一的思考级别联合；类型允许某个值不代表所有模型都支持，具体模型能力还需看元数据并限制。
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
// 扩展插槽：默认是空接口，宿主可用同模块名的 declare module 为它增加“名字 → 自定义消息类型”映射。
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
// Message 是标准模型消息；keyof 取扩展接口全部键，再用索引取值联合。未扩展时该部分为 never，只剩标准消息。
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
// Agent 对外公开的状态形状，运行字段多为 readonly；模型、工具和历史可按接口规则更新。
export interface AgentState {
	/**
	 * Current system prompt, replayed from the transcript's system messages.
	 *
	 * Read-only: to change the prompt, append a system message with `content` or `sections`.
	 * In `initialState`, this seeds the leading system message.
	 */
	// 只读的当前有效提示词，从 system 历史重放；要改提示词应追加/投影 system 消息，不直接赋这字段。
	readonly systemPrompt: string;
	/** Active model used for future turns. */
	// 本次选中的模型元数据；泛型标示协议类型，现有 any 允许通用运行器接纳不同协议。
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	// 当前请求的统一思考级别，类型将可用字符串限制在下面的联合中。
	thinkingLevel: ThinkingLevel;
	/**
	 * Executable tools. Assigning a new array copies the top-level array.
	 *
	 * Differences from the tools declared in the transcript are announced to the model
	 * with a system message before the next request.
	 */
	// 属性 setter 的类型声明：给 state.tools 赋数组时，具体实现会浅复制顶层数组。
	set tools(tools: AgentTool<any>[]);
	// getter 返回当前可执行工具列表；工具声明的变化会由循环写成 system 增量告知模型。
	get tools(): AgentTool<any>[];
	/**
	 * Conversation transcript. Assigning a new array copies the top-level array.
	 *
	 * System messages in the transcript carry the prompt and tool declarations.
	 */
	// 替换整个历史数组时走 setter，具体 Agent 实现会浅复制它。
	set messages(messages: AgentMessage[]);
	// 读取已完成对话历史；system 消息也在其中，不能只按 user/assistant 理解所有元素。
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	// 低层正在处理 prompt/continue 的标记，执行工具和等待 agent_end 异步监听器时仍为 true。
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	// 当前草稿/正在展示消息，可没有；别把它当作已经完成并保存的最后一条。
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	// 公开只读的执行中工具 id 集合；ReadonlySet 约束 TS 调用者不能 add/delete。
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	// 最近一次失败/取消的可读提示，无错误时缺省。
	readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
// 工具结果的泛型：T 描述 details，缺省为 JSON 或 undefined；结果内容和附加详情是两层信息。
export interface AgentToolResult<T = JsonValue | undefined> {
	/** Text or image content returned to the model. */
	// 发给模型的文字/图片内容块；例：read 把文件文字放这里，模型下一次请求才看得到。
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	// 供日志/UI/程序处理的详情类型由 T 决定，不自动成为模型正文。
	details: T;
	/**
	 * Machine-readable result matching the tool's `outputSchema`, for programmatic callers. Not sent
	 * to the model; `content` remains the model-facing result.
	 */
	// 面向程序的 JSON 输出，不直接发模型；若只替换 content 不给它，旧结构化输出可能被丢弃以免不一致。
	structuredContent?: JsonValue;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	// 工具自己产生的用量，可用于统计；不是主模型这次输入上下文 token 的替代值。
	usage?: Usage;
	/**
	 * Report a failure without throwing. The model sees `content` as an error result, like a thrown
	 * error, but `details` and `structuredContent` are kept for the UI and programmatic callers.
	 */
	// 可明确覆盖工具成功/失败标志，false 与“没传”不同；代码用 ?? 合并，能保留显式 false。
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	// 停止本批工具后自动续轮的提示；只有本批非空且所有最终结果都为 true 才整体终止。
	terminate?: boolean;
}

/** Final outcome of a tool call after hooks ran. */
// 完整工具管线完成后的单次结果，包含原始调用、钩子处理后的结果、错误标志和可选耗时。
export interface AgentToolCallOutcome {
	// 原始调用内容块，包含 id/name/arguments；id 用来与后面的工具结果配对。
	toolCall: AgentToolCall;
	// 工具内容及详情的统一形状；现有 any 兼容不同工具各自的 details 类型，调用方仍应按实际工具解读。
	result: AgentToolResult<any>;
	// 必填成功/失败标志；工具抛异常或被阻止通常会得到 true。
	isError: boolean;
	/** Milliseconds `execute()` took, measured with a monotonic clock; absent when the tool did not run. */
	// 工具 execute 耗时，单位毫秒；没真正执行工具时可以缺省，不能用零伪装实际测量。
	durationMs?: number;
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
// 工具报告进度的回调签名，T 同样描述 details；只在本次 execute 活跃期间接受更新。
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/**
 * The arguments type of a tool with parameter schema `TParameters`: pi-schema's `Static<TParameters>` (the builders'
 * type, TypeBox's for the common TypeBox kinds, else `unknown`), and `any` for `AgentTool<any>`.
 */
// 条件类型：若 schema 参数本身是 any 就保留 any，否则用 Static 推导参数结构；这不会在运行时替代 schema 校验。
export type AgentToolParams<TParameters> = IsAny<TParameters> extends true ? any : Static<TParameters>;

// `0 extends 1 & T` is resolved too early for a `T` constrained to `object`; this form waits for the argument.
// 纯类型运算检测 any；内层条件对 any 产生两种可能，外层看 boolean 能否被接纳。unknown/never 等不应被一律当 any。
type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false;

/**
 * Tool definition used by the agent runtime. `parameters` is any JSON Schema object; see {@link AgentToolParams} for
 * the type `execute` receives.
 */
// 泛型工具接口继承模型工具声明：TParameters 为 schema 类型，TDetails 为附加详情类型；只描述结构，不创建工具实例。
export interface AgentTool<TParameters extends object = object, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	// 供 UI 展示的人类名称；匹配调用用的是继承来的 name。
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	// 可选输入兼容函数，先整理模型原始参数，再进入正式 schema 校验。例：处理一个别名字段。
	prepareArguments?: (args: unknown) => AgentToolParams<TParameters>;
	/**
	 * JSON Schema of `structuredContent` in successful results. Tools that declare it should always
	 * set `structuredContent`.
	 */
	// 描述成功时 structuredContent 的 JSON Schema，供程序化调用者解释结果，不是 input parameters。
	outputSchema?: object;
	/**
	 * Execute the tool call. Throw on failure, or return a result with `isError: true`; do not only
	 * describe the failure in `content`.
	 */
	// 真正工作的工具函数签名；执行失败可抛异常或返回 isError:true，不能只在成功内容里写“失败”却漏标志。
	execute: (
		// 本次模型工具调用 id，结果必须与它配对；不是工具名字。
		toolCallId: string,
		// 从输入 schema 推导的参数类型，实际调用前低层循环还会做运行时验证。
		params: AgentToolParams<TParameters>,
		// 可选取消信号；异步钩子需要自己响应它，类型声明不会自动中断 await。
		signal?: AbortSignal,
		// 可选的执行进度回调，例如长命令输出；不能用它把一次工具调用伪装成多条最终结果。
		onUpdate?: AgentToolUpdateCallback<TDetails>,
		// 工具异步返回统一结果；TDetails 将 execute 返回的 details 与工具声明保持类型关联。
	) => Promise<AgentToolResult<TDetails>>;
	/** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
	// 对“持久意图已记录但结果未知”的副作用给恢复策略提示；不是 low-level agent-loop 自动重放所有工具的开关。
	replay?: "never" | "safe";
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	// 单工具的执行策略要求；本批任意工具要求 sequential 时，整批走串行管线。
	executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
// 低层循环的上下文快照：消息给模型看，工具对象供运行器实际执行，两者用途不同。
export interface AgentContext {
	/** Transcript visible to the model. */
	// 当前对话消息数组，包含 system、用户、assistant、工具结果以及应用扩展消息。
	messages: AgentMessage[];
	/** Tools available for execution in this run. */
	// 可执行工具列表，缺省相当于没有工具；不会把 execute 函数直接放进模型请求 JSON。
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
// 按 type 分辨的事件联合；switch(event.type) 能让 TS 知道该分支有哪些字段，类型本身不发布事件。
export type AgentEvent =
	// Agent lifecycle
	// 一次低层运行开始；一个用户 query 可能因上层恢复产生多次低层运行。
	| { type: "agent_start" }
	// 低层不再产新循环事件，携带本次新增消息；还要等监听器及 finishRun 才真正空闲。
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	// 一个模型回合开始，回合包括一次 assistant 回复和它引发的一批工具。
	| { type: "turn_start" }
	// 本轮模型与工具完成，不一定是整个用户任务完成；可能还要把工具结果交给模型再问一次。
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for system, user, assistant, and toolResult messages
	// 某条 system/user/assistant/toolResult 消息开始；用户/工具结果通常很快就接 message_end。
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	// 仅 assistant 流式更新：同时提供累计草稿和本次模型增量事件。
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	// 完整消息结束，Agent 把它追加到内存历史，外层会话订阅者可进一步保存。
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	// 工具管线开始，仍可能在参数校验或前置策略处被拒绝，不代表文件已经读取。
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	// 工具执行中上报进度，和模型文字增量是不同事件种类。
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| {
			// 工具管线结束，后面还会把结果包装成独立 toolResult 消息。
			type: "tool_execution_end";
			// 模型发出的调用 id，用于 UI 跟踪和调用/结果配对。
			toolCallId: string;
			// 执行目标工具名，例如 read、bash。
			toolName: string;
			// 现有事件接口兼容各工具的结果类型；具体消费方仍需知道该工具结果格式。
			result: any;
			// 必填成功/失败标志；工具抛异常或被阻止通常会得到 true。
			isError: boolean;
			/** Milliseconds `execute()` took, measured with a monotonic clock; absent when the tool did not run. */
			// 工具 execute 耗时，单位毫秒；没真正执行工具时可以缺省，不能用零伪装实际测量。
			durationMs?: number;
	  };
