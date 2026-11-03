import {
	type ClientIdentity,
	createInitialSystemMessage,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingBudgets,
	type Transport,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	FinishTurn,
	PrepareNextTurnContext,
	PrepareRequest,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) =>
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

/** Initial state for {@link Agent}. `systemPrompt` and `tools` become the leading system message unless `messages` already starts with one. */
export type AgentInitialState = Partial<
	Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
>;

function createMutableAgentState(initialState?: AgentInitialState): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];
	const initialMessage = createInitialSystemMessage(initialState?.systemPrompt, tools.map(toToolDeclaration));
	if (messages[0]?.role !== "system" && initialMessage) messages.unshift(initialMessage);

	return {
		get systemPrompt() {
			return getCurrentSystemPrompt(messages);
		},
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: AgentInitialState;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	finishTurn?: FinishTurn;
	prepareRequest?: PrepareRequest;
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
	/**
	 * How requests identify the app to providers, merged field by field over `DEFAULT_AGENT_IDENTITY`
	 * (`{ attribution: PI_ATTRIBUTION }`). Pass `{ attribution: null }` to send no attribution headers.
	 */
	identity?: ClientIdentity;
}

class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	peek(): AgentMessage[] {
		if (this.mode === "all") return this.messages.slice();
		const first = this.messages[0];
		return first ? [first] : [];
	}

	drain(): AgentMessage[] {
		const drained = this.peek();
		this.messages = this.messages.slice(drained.length);
		return drained;
	}

	clear(): void {
		this.messages = [];
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFunction: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public finishTurn?: FinishTurn;
	public prepareRequest?: PrepareRequest;
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	private activeRun?: ActiveRun;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;
	/** Request identity forwarded to the stream function, over `DEFAULT_AGENT_IDENTITY`. */
	public identity?: ClientIdentity;

	// 中文导读：Agent 负责运行状态、消息队列和事件；构造时保存回调，尚未调用模型。
	constructor(options: AgentOptions) {
		// Older compiled consumers may omit options or streamFn even though the current API requires them.
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		// 创建状态：已有历史、选中模型、思考级别和工具；不会凭空从模型服务器读取聊天记录。
		this._state = createMutableAgentState(runtimeOptions.initialState);
		// 保存消息转换函数；SDK 传来的版本认识 coding-agent 的自定义消息。
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		// 保存请求前变换历史的回调，真正请求时才执行。
		this.transformContext = runtimeOptions.transformContext;
		// 关键依赖注入：Agent 不绑定某个供应商，用外部传入的函数请求模型；测试可以替换为 faux。
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		this.getApiKey = runtimeOptions.getApiKey;
		this.onPayload = runtimeOptions.onPayload;
		this.onResponse = runtimeOptions.onResponse;
		this.onProviderStreamEvent = runtimeOptions.onProviderStreamEvent;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.finishTurn = runtimeOptions.finishTurn;
		this.prepareRequest = runtimeOptions.prepareRequest;
		this.prepareNextTurn = runtimeOptions.prepareNextTurn;
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		this.sessionId = runtimeOptions.sessionId;
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		this.transport = runtimeOptions.transport ?? "auto";
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		// 默认并行执行同一回答中的工具；具体工具要求串行时，低层循环会改走串行分支。
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
		this.identity = runtimeOptions.identity;
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	// 注册事件监听器，返回取消订阅的函数。AgentSession 在构造时订阅，用来保存消息。
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		// Set 保存监听函数，重复添加同一个函数不会多一份。
		this.listeners.add(listener);
		// 这里返回函数，不是立即删除；调用返回值 unsubscribe() 时才取消订阅。
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Preview the messages selected for the next turn without consuming them. */
	peekQueuedMessages(): AgentMessage[] {
		const steering = this.steeringQueue.peek();
		return steering.length > 0 ? steering : this.followUpQueue.peek();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear conversation state and queues while retaining the replayed prompt/tool baseline. */
	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		const baseline = getCurrentSystemMessage(this._state.messages);
		this._state.messages = baseline ? [baseline] : [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	// 函数重载之一：允许传单条消息或消息数组；这行只有类型签名，没有运行体。
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	// 另一个重载：允许字符串加可选图片。? 表示参数可不传；Promise<void> 表示等完成，不直接返回回答文本。
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	// 中文主线 3：Agent 的统一提问入口。上面的多个签名，最终都由这一个函数体处理。
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		// 同一个 Agent 不允许两个运行同时改历史；正在工作时应使用 steer/followUp 排队。
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		// 将多种输入统一成消息数组。例如字符串“你好”会变成 role:user 的消息。
		const messages = this.normalizePromptInput(input, images);
		// 等到模型/工具循环和低层运行清理完成；不是拿到第一段文字就返回。
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	// 继续已有上下文，不添加新的普通用户问题；会话的重试或排队续跑会用到它。
	async continue(): Promise<void> {
		// 同一个 Agent 不允许两个运行同时改历史；正在工作时应使用 steer/followUp 排队。
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		// 取历史最后一条，决定还能不能直接请求模型。
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		// 没有对话，或只有 system 配置时，没什么可以继续回答的。
		if (!lastMessage || this._state.messages.every((message) => message.role === "system")) {
			throw new Error("No messages to continue from");
		}

		// 最后已经是完整模型回答时，不能无条件再请求一次，先找有没有排队的用户消息。
		if (lastMessage.role === "assistant") {
			// 取走插话队列本次应投递的部分。drain 会消费，peek 只预览。
			const queuedSteering = this.steeringQueue.drain();
			// 先处理插话，优先级高于等待任务自然结束后的 follow-up。
			if (queuedSteering.length > 0) {
				// 插话已经在这里取了一次，进入循环后别再取一次，保证 one-at-a-time 模式。
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			// 没有插话时再取 follow-up，例如“当前任务完成后做一次总结”。
			const queuedFollowUps = this.followUpQueue.drain();
			// 只有确实有排队问题时，才从 assistant 结尾接上一句新输入。
			if (queuedFollowUps.length > 0) {
				// 排队追问使用同一份历史，进入一个新的低层运行。
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			// 没有新输入却想从 assistant 末尾硬续，会在这里拒绝。
			throw new Error("Cannot continue from message role: assistant");
		}

		// 最后是 user/toolResult 等可继续输入时，直接用现有上下文运行，不再重复追加问题。
		await this.runContinuation();
	}

	// 统一入口参数的形状；这是合法联合类型的分支处理，不是在模型返回边界做 schema 校验。
	private normalizePromptInput(
		// 竖线 | 表示三种合法输入之一；具体分支通过 Array.isArray/typeof 收窄类型。
		input: string | AgentMessage | AgentMessage[],
		// 可选图片数组；没有图片时参数可以省略。
		images?: ImageContent[],
		// 这个同步函数最终返回消息数组，没有 Promise，也不会请求模型。
	): AgentMessage[] {
		// 输入已是数组时直接使用，例如会话层传入 system 补丁和 user 两条消息。
		if (Array.isArray(input)) {
			// 已经是期望形状，直接返回；不会给已有消息再包一层 user。
			return input;
		}

		// 排除数组后，这里若不是字符串，就只能是单个 AgentMessage。
		if (typeof input !== "string") {
			// 单条消息外包一层数组，保证下游只处理一种形状。
			return [input];
		}

		// Array<T> 与 T[] 都是数组类型；内容块可以是文字或图片，先放入文字。
		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		// 确实传了图片且非空，才追加到内容块中。
		if (images && images.length > 0) {
			// 将每张图片逐个加入 content，而不是把整个数组作为一张“图片”。
			content.push(...images);
		}
		// 统一输出带角色、内容、时间戳的用户消息数组。
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	// 把“本次新消息”交给低层循环；外面包运行状态和取消信号的生命周期。
	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		// 传入一个 async 回调；runWithLifecycle 建好取消控制器和状态后，才执行这个回调。
		await this.runWithLifecycle(async (signal) => {
			// 调用 agent-loop.ts 的 Promise 版本入口。注意这里没有经过名字相似的 agentLoop() 流包装器。
			await runAgentLoop(
				// 这次新加入的消息；旧历史通过后面的 context 快照单独提供。
				messages,
				// 拿当前已完成历史和工具的顶层数组快照，作为此次循环起点。
				this.createContextSnapshot(),
				// 组合模型、回调、队列读取函数等循环配置。
				this.createLoopConfig(options),
				// 把事件送回 Agent：先更新自身状态，再通知订阅者；AgentSession 正是其中一个订阅者。
				(event) => this.processEvents(event),
				// 把当前运行的取消信号传给循环、供应商请求和工具。
				signal,
				// 传递之前注入的模型请求函数；此处是传函数，尚不是调用函数。
				this.streamFunction,
			);
		});
	}

	// 继续已有消息的入口，与新 prompt 走相同的生命周期，但不再追加一条用户消息。
	private async runContinuation(): Promise<void> {
		// 传入一个 async 回调；runWithLifecycle 建好取消控制器和状态后，才执行这个回调。
		await this.runWithLifecycle(async (signal) => {
			// 调用低层 continue 入口，用已有的 user/toolResult 结尾上下文继续生成。
			await runAgentLoopContinue(
				// 拿当前已完成历史和工具的顶层数组快照，作为此次循环起点。
				this.createContextSnapshot(),
				// 继续运行也要带相同的模型、事件、工具钩子与队列配置。
				this.createLoopConfig(),
				// 把事件送回 Agent：先更新自身状态，再通知订阅者；AgentSession 正是其中一个订阅者。
				(event) => this.processEvents(event),
				// 把当前运行的取消信号传给循环、供应商请求和工具。
				signal,
				// 传递之前注入的模型请求函数；此处是传函数，尚不是调用函数。
				this.streamFunction,
			);
		});
	}

	// 创建上下文快照，避免局部循环与 Agent 状态共享同一个顶层数组。
	private createContextSnapshot(): AgentContext {
		return {
			// slice() 浅复制数组；消息对象本身没有深复制。第二次 prompt 会从这里带上第一次的对话。
			messages: this._state.messages.slice(),
			// 工具对象也只浅复制数组；execute 等函数仍是原工具的实现。
			tools: this._state.tools.slice(),
		};
	}

	// 将 Agent 上的状态/回调组装成低层循环配置。= {} 表示调用时可省略 options。
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		// 保存一次性标记：插话若已在 continue 中取过，第一次队列读取应跳过。
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			// 传入当前模型对象；模型不是历史记忆容器，历史由 messages 明确提供。
			model: this._state.model,
			// 三元表达式：思考级别为 off 时传 undefined，否则传实际级别。
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			onProviderStreamEvent: this.onProviderStreamEvent,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			identity: this.identity,
			toolExecution: this.toolExecution,
			// 透传工具前置回调；AgentSession 会用它接扩展的 tool_call 事件。
			beforeToolCall: this.beforeToolCall,
			// 透传工具后置回调；会话层用它处理结果替换、图片等。
			afterToolCall: this.afterToolCall,
			// 一轮模型及工具执行完成后调用的决策函数。
			finishTurn: this.finishTurn,
			// 每次模型请求前执行的回调，不仅第一次用户提问会执行。
			prepareRequest: this.prepareRequest,
			// 下一回合准备：优先调用有回合上下文的版本，否则用旧的无上下文回调。
			prepareNextTurn:
				// 至少存在一个准备函数时才创建下面的代理回调。
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? // 把准备函数包装为低层需要的 async 函数，在执行时再读取当前取消信号。
						async (context) => {
							// 有新版回调就把上一回合详情也传进去。
							if (this.prepareNextTurnWithContext) {
								// 进入会话层安装的准备回调；可能检查压缩、刷新 system 提示词和工具。
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							// 没有新版回调时，调用可选的旧接口；?.() 表示不存在就跳过。
							return await this.prepareNextTurn?.(this.signal);
						}
					: // 条件不成立时字段值是 undefined，低层循环会跳过这个可选能力。
						undefined,
			// 透传“Agent 消息 → 模型消息”的转换函数，实际请求边界才执行。
			convertToLlm: this.convertToLlm,
			// 透传上下文变换，通常连接扩展 context 事件和请求投影。
			transformContext: this.transformContext,
			// 透传按供应商取凭证的回调；生产 SDK 还会由 ModelRuntime 处理认证。
			getApiKey: this.getApiKey,
			// 低层循环要取插话时调用此函数，队列不需要每行生成文字时都检查。
			getSteeringMessages: async () => {
				// 如果进入前已经消费过插话，本次返回空数组避免多取。
				if (skipInitialSteeringPoll) {
					// 只跳过一次，后面的回合仍要正常接收新插话。
					skipInitialSteeringPoll = false;
					// 这次没有可投递消息，低层按当前上下文继续。
					return [];
				}
				// 取出并消费本次要投递的插话；一次一条还是全取由队列 mode 决定。
				return this.steeringQueue.drain();
			},
			// follow-up 使用独立队列，只在低层即将自然停止时读取。
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	// 管理一次低层运行的开始、异常、取消和清理。executor 是上面传来的循环执行函数。
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		// 同一个 Agent 不允许两个运行同时改历史；正在工作时应使用 steer/followUp 排队。
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		// 建立取消控制器：控制器负责发出取消，signal 供下层观察。
		const abortController = new AbortController();
		// 先给变量一个空函数，下面创建 Promise 时会换成真正的完成通知函数。
		let resolvePromise = () => {};
		// 创建“等本次运行结束”的 Promise，waitForIdle() 会等待它。
		const promise = new Promise<void>((resolve) => {
			// 把 resolve 保存出来，finishRun 时调用，通知等待者运行已完成。
			resolvePromise = resolve;
		});
		// 记录当前运行；其他 prompt 看到它就知道现在忙，abort() 也通过它发取消。
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		// 标记低层 Agent 正在运行；不只网络输出文字时才算忙，执行工具期间也算。
		this._state.isStreaming = true;
		// 清空上一条流式草稿；完整历史在 messages 中，不会在这里清掉。
		this._state.streamingMessage = undefined;
		// 新运行开始时清掉旧错误提示，避免成功的新回答仍显示上一次错误。
		this._state.errorMessage = undefined;

		try {
			// 现在才真正执行模型/工具循环，并将取消信号传进去。
			await executor(abortController.signal);
			// 捕获循环直接抛出的异常，统一转换为消息和生命周期事件。
		} catch (error) {
			// 用取消状态区分 aborted 与 error；错误也会通过消息事件进入会话历史。
			await this.handleRunFailure(error, abortController.signal.aborted);
			// 无论成功、失败还是取消，都会执行这里的收尾。
		} finally {
			// 清除低层忙碌状态并完成 waitForIdle 的 Promise；会话层可能还要重试/压缩。
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	// 低层运行真正转为空闲的位置，比 agent_end 事件的发出时刻更晚。
	private finishRun(): void {
		// 低层 Agent 不再忙；这与 AgentSession 管理的更外层运行状态不同。
		this._state.isStreaming = false;
		// 清空上一条流式草稿；完整历史在 messages 中，不会在这里清掉。
		this._state.streamingMessage = undefined;
		// 清空仍在执行工具的 id 集合；Set<string> 表示不重复的字符串集合。
		this._state.pendingToolCalls = new Set<string>();
		// 通知等待本次运行的调用方；?. 允许没有 activeRun 时跳过。
		this.activeRun?.resolve();
		// 释放当前运行引用，下一次普通 prompt 才能进入。
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	// 中文主线：所有循环事件先在这里更新 Agent 状态，再传给会话层保存/扩展和 UI。
	private async processEvents(event: AgentEvent): Promise<void> {
		// 按带标签的联合类型分支；type 为 message_end 时，TS 知道有 message 字段。
		switch (event.type) {
			// 某条消息开始，例如 user、assistant 或 toolResult。
			case "message_start":
				// 保存当前正在展示的消息草稿；不在这里把每个片段追加成新历史。
				this._state.streamingMessage = event.message;
				// 退出 switch 当前分支，不会退出外面的 Agent 运行。
				break;

			// 流式草稿更新，完整消息仍要等 message_end。
			case "message_update":
				// 保存当前正在展示的消息草稿；不在这里把每个片段追加成新历史。
				this._state.streamingMessage = event.message;
				// 退出 switch 当前分支，不会退出外面的 Agent 运行。
				break;

			// 这条消息已完整，进入正式历史。
			case "message_end":
				// 清空上一条流式草稿；完整历史在 messages 中，不会在这里清掉。
				this._state.streamingMessage = undefined;
				// 把完整消息追加到 Agent 内存历史；会话层随后还会把它记入 SessionManager。
				this._state.messages.push(event.message);
				// 退出 switch 当前分支，不会退出外面的 Agent 运行。
				break;

			// 工具管线开始；花括号给这个 case 单独的变量作用域。
			case "tool_execution_start": {
				// 复制当前工具 id 集合，再做增删，随后替换状态中的集合。
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				// 标记这个调用正在处理，例如 read-decision。
				pendingToolCalls.add(event.toolCallId);
				// 更新对外可见的执行中工具集合。
				this._state.pendingToolCalls = pendingToolCalls;
				// 退出 switch 当前分支，不会退出外面的 Agent 运行。
				break;
			}

			// 某个工具处理结束，可能成功，也可能校验失败或被阻止。
			case "tool_execution_end": {
				// 复制当前工具 id 集合，再做增删，随后替换状态中的集合。
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				// 从执行中集合删除该调用，不会删除消息历史中的 toolResult。
				pendingToolCalls.delete(event.toolCallId);
				// 更新对外可见的执行中工具集合。
				this._state.pendingToolCalls = pendingToolCalls;
				// 退出 switch 当前分支，不会退出外面的 Agent 运行。
				break;
			}

			// 当前一次模型回答及其工具执行结束，不一定是整个 query 结束。
			case "turn_end":
				// assistant 带错误信息时，同步到 Agent 的错误状态供外层显示。
				if (event.message.role === "assistant" && event.message.errorMessage) {
					// 保存可读错误文字；重试策略仍由会话层决定。
					this._state.errorMessage = event.message.errorMessage;
				}
				// 退出 switch 当前分支，不会退出外面的 Agent 运行。
				break;

			// 低层循环准备结束，后面仍要等待监听器并执行 finishRun。
			case "agent_end":
				// 清空上一条流式草稿；完整历史在 messages 中，不会在这里清掉。
				this._state.streamingMessage = undefined;
				// 退出 switch 当前分支，不会退出外面的 Agent 运行。
				break;
		}

		// 事件监听器也接收当前取消信号，长耗时监听可以响应用户取消。
		const signal = this.activeRun?.abortController.signal;
		// 这里检查生命周期约束：事件处理必须发生在 activeRun 内。
		if (!signal) {
			// 违反 Agent 自己的运行约束时直接报错，避免事件在没有所属运行时传播。
			throw new Error("Agent listener invoked outside active run");
		}
		// 按订阅顺序逐个调用监听器；AgentSession 的保存处理也在这条路径上。
		for (const listener of this.listeners) {
			// 等待异步监听器完成，所以 message_end 处理完之前不会开始下一次模型请求。
			await listener(event, signal);
		}
	}
}
