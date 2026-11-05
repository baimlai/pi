// 有状态的 Agent 外壳。宿主注入模型函数和工具，本类管理历史、忙闲、取消、事件、插话/追问；真正调度在 agent-loop.ts。
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
// 低层循环负责“请求模型 → 执行工具 → 再请求”；本文件在它外面管理状态、事件监听和排队输入。
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
// 没有显式 streamFn 的旧调用方可用宿主设置的默认请求函数。
import { getDefaultStreamFn } from "./stream-fn.ts";
// 这里整组 import 只引入本包的契约类型；编译后的 JS 不保留这些类型。
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

// 重新导出队列模式类型，让从本模块导入 Agent 的应用也能拿到相同类型。
export type { QueueMode } from "./types.ts";

/**
 * 默认消息转换器，输入 Agent 消息数组，返回只含四种模型标准角色的新数组，不改原数组。
 * 流程逐条 filter；例如扩展 notification 会被过滤。产品需要把 custom 转成 user 时应传自己的 convertToLlm。
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	// filter 返回新数组，只保留模型协议直接认识的角色，默认不猜测自定义消息该怎样转换。
	return messages.filter(
		// 箭头回调对每条消息计算“要不要保留”，返回 true 的元素进入结果。
		(message) =>
			// 保留系统提示词和工具变更；|| 表示任意一个角色匹配就保留。
			message.role === "system" ||
			// 保留用户输入。
			message.role === "user" ||
			// 保留模型回答，包括其中的工具调用内容块。
			message.role === "assistant" ||
			// 保留工具结果，模型需要读取它才能完成工具后的回答。
			message.role === "toolResult",
	);
}

// 本地运行异常构造失败消息时使用的零用量；没有实际供应商 usage 就不伪造 token 费用。
const EMPTY_USAGE = {
	// 输入 token 用量尚无供应商统计，失败占位记零。
	input: 0,
	// 输出 token 用量占位。
	output: 0,
	// 缓存读取用量占位。
	cacheRead: 0,
	// 缓存写入用量占位。
	cacheWrite: 0,
	// 总 token 用量占位，不是对本地历史长度的估计。
	totalTokens: 0,
	// 费用各项占位为零，不能当成一次真实模型请求的计费报告。
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Agent 未提供模型时使用的占位元数据；它不代表一个真实可请求的供应商模型。
const DEFAULT_MODEL = {
	// 占位模型 id，宿主应在实际请求前配置真实模型。
	id: "unknown",
	// 用于展示的占位名称。
	name: "unknown",
	// 尚未确定模型 API；不能据此选择真实供应商实现。
	api: "unknown",
	// 尚未确定供应商。
	provider: "unknown",
	// 没有真实请求地址。
	baseUrl: "",
	// 占位模型不声明支持思考功能。
	reasoning: false,
	// 没有声明可接受的输入模态。
	input: [],
	// 占位价格表，不代表真实模型免费。
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// 未知上下文窗口，没有可用于真实模型预算计算的容量。
	contextWindow: 0,
	// 未知最大输出上限。
	maxTokens: 0,
	// satisfies 只检查这个对象符合模型类型；不会在运行时把占位数据补成真实模型。
} satisfies Model<any>;

// 内部状态类型：Omit 去掉对外只读的运行字段，再用交叉类型 & 加回可修改版本，方便 Agent 自己更新。
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	// 内部可修改的运行标记；外部只读接口不能给它赋值。
	isStreaming: boolean;
	// 正在生成/展示的一条消息，可不存在；它不是完整历史数组。
	streamingMessage?: AgentMessage;
	// 当前执行中工具 id 的可变集合；Set 不保存重复值。
	pendingToolCalls: Set<string>;
	// 当前错误提示，无错误时可省略。
	errorMessage?: string;
};

/** Initial state for {@link Agent}. `systemPrompt` and `tools` become the leading system message unless `messages` already starts with one. */
// Partial<T> 把初始状态字段变成可选：调用方只需提供自己要覆盖的部分。
export type AgentInitialState = Partial<
	// 这些运行中字段由 Agent 管理，不能用“恢复初始状态”伪造一个尚未建立的 activeRun。
	Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
>;

/**
 * 把可选初值组装为 Agent 内部状态，浅复制初始工具/历史，必要时补一个开头 system。
 * 返回带 getter/setter 的对象；后续赋 messages/tools 时浅复制数组，读取时直接返回当前数组。不会发模型请求。
 * 例：传 systemPrompt 与 read 工具但没有历史时，会生成系统声明；若历史首条已是 system，则不重复添加。
 */
function createMutableAgentState(initialState?: AgentInitialState): MutableAgentState {
	// 初始工具数组浅复制；?? 在没有初值时创建空列表，工具对象和 execute 函数本身不深复制。
	let tools = initialState?.tools?.slice() ?? [];
	// 初始完整历史同样只复制顶层数组，防止外部数组 push 直接改变这里的列表。
	let messages = initialState?.messages?.slice() ?? [];
	// 把可选初始提示词和工具声明合成 system 消息；工具只传声明，不把本地 execute 发给模型。
	const initialMessage = createInitialSystemMessage(initialState?.systemPrompt, tools.map(toToolDeclaration));
	// 没有现成开头 system 且确有初始消息时才前插，避免重复添加；unshift 在数组头部插入。
	if (messages[0]?.role !== "system" && initialMessage) messages.unshift(initialMessage);

	// 返回构造出的状态对象；getter/setter 会闭包引用上面的 tools/messages，而不是各留一份不同历史。
	return {
		// getter：读取 state.systemPrompt 时运行此段代码，动态从历史重放当前有效提示词。
		get systemPrompt() {
			// 根据 system 消息及章节补丁计算提示词，避免另存字符串与历史不一致。
			return getCurrentSystemPrompt(messages);
		},
		// 优先使用传入模型，未配置时使用未知模型占位。
		model: initialState?.model ?? DEFAULT_MODEL,
		// 低层 Agent 缺省关闭思考；产品 SDK 可以显式传自己的默认级别。
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		// 读取工具属性时返回当前工具数组，赋新值时则走下面的 setter。
		get tools() {
			// 返回闭包中的当前工具列表，不在每次读取时复制。
			return tools;
		},
		// 赋 state.tools = ... 会调用 setter；参数类型是工具数组。
		set tools(nextTools: AgentTool<any>[]) {
			// 赋值时浅复制数组，调用者后来改变原数组不会改变当前工具列表。
			tools = nextTools.slice();
		},
		// 消息历史也通过访问器管理，读取不复制，整数组赋值时复制。
		get messages() {
			// 返回当前历史数组，因此 Agent 的 push 会实实在在改变这份内存状态。
			return messages;
		},
		// 替换历史时进入 setter，例如会话投影刷新上下文时。
		set messages(nextMessages: AgentMessage[]) {
			// 仅复制顶层数组；消息对象引用仍保持，事件与会话记录可以关联同一消息。
			messages = nextMessages.slice();
		},
		// 新建状态先空闲，尚未建立低层运行。
		isStreaming: false,
		// 尚无正在生成的草稿。
		streamingMessage: undefined,
		// 空的执行中工具 id 集合，<string> 约束元素类型。
		pendingToolCalls: new Set<string>(),
		// 新状态没有旧错误提示。
		errorMessage: undefined,
	};
}

/** Options for constructing an {@link Agent}. */
// 构造 Agent 的配置契约；很多选项是“保存回调供之后执行”，不是构造时立即发请求。
export interface AgentOptions {
	// 可恢复模型、历史、工具等初值，不包含正在运行的网络任务。
	initialState?: AgentInitialState;
	// 可同步或异步转换应用消息；例如把 custom 笔记转成 user，默认只保留标准角色。
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	// 可选异步上下文变换，在消息转换前执行，可用于裁剪或注入材料。
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	// 真正请求模型的函数，类型是必填；构造时仅保存引用。
	streamFn: StreamFn;
	// 每次请求前按供应商取凭证，允许同步/异步及取不到返回 undefined。
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	// 复用 pi-ai 的请求体回调类型；索引访问类型避免重复定义。
	onPayload?: SimpleStreamOptions["onPayload"];
	// 模型请求收到 HTTP 响应头时的观察/处理回调，不等于最终模型消息。
	onResponse?: SimpleStreamOptions["onResponse"];
	// 观察供应商原始流事件，区别于 Agent 自己的 message_update。
	onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
	// 参数已校验后执行的前置钩子，可返回 block:true 阻止真正执行工具。
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	// 工具执行后改写可见结果的钩子，未返回覆盖就保持原值。
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	// 当前模型回答及工具结果完成后的调度决策，允许要求继续或结束。
	finishTurn?: FinishTurn;
	// 每次普通模型请求前运行，包含第一轮，可以替换上下文或本次模型。
	prepareRequest?: PrepareRequest;
	// 旧式的下一回合准备回调，只接收取消信号；新版还接收上一回合上下文。
	prepareNextTurn?: (
		// 可选取消信号：类型里的 ? 表示可不传，不会自动实现取消，具体回调必须响应它。
		signal?: AbortSignal,
		// 这个联合返回类型同时接受同步/异步回调；undefined 表示不替换状态。
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	// 新版回合间准备回调，拿到上一回合快照后可压缩/更新上下文。
	prepareNextTurnWithContext?: (
		// 上一回合的 assistant、工具结果、上下文和本轮新增消息。
		context: PrepareNextTurnContext,
		// 可选取消信号：类型里的 ? 表示可不传，不会自动实现取消，具体回调必须响应它。
		signal?: AbortSignal,
		// 这个联合返回类型同时接受同步/异步回调；undefined 表示不替换状态。
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	// 插话队列每次取一条还是全部取；与工具执行并行策略无关。
	steeringMode?: QueueMode;
	// 等待自然结束后处理的追问队列，也可配置每次取一条或全取。
	followUpMode?: QueueMode;
	// 可选会话标识，透传供应商以支持相关缓存/跟踪；历史仍来自 messages。
	sessionId?: string;
	// 各思考级别的 token 预算，交给请求函数解释。
	thinkingBudgets?: ThinkingBudgets;
	// 模型供应商传输偏好，例如自动选择；不是 Agent 自己启动一个网络服务。
	transport?: Transport;
	// 允许供应商重试的最长等待提示，具体重试由请求函数/供应商处理。
	maxRetryDelayMs?: number;
	// 整批工具串行或并行；默认并行，但单个工具可以要求串行。
	toolExecution?: ToolExecutionMode;
	/**
	 * How requests identify the app to providers, merged field by field over `DEFAULT_AGENT_IDENTITY`
	 * (`{ attribution: PI_ATTRIBUTION }`). Pass `{ attribution: null }` to send no attribution headers.
	 */
	// 请求归因等客户端身份元数据，区别于模型认证凭证。
	identity?: ClientIdentity;
}

// Agent 内部的先入先出消息队列；只管理列表，什么时候读取由低层循环决定。
class PendingMessageQueue {
	// private 限制 TS 使用者访问队列内部；消息数组初始为空。
	private messages: AgentMessage[] = [];
	// 队列投递模式，对 Agent 的模式访问器开放；public 表示公开成员。
	public mode: QueueMode;

	/**
	 * 创建一个消息队列，输入 all 或 one-at-a-time，保存模式，初始没有消息；例如插话队列默认一次取一条。
	 */
	constructor(mode: QueueMode) {
		// 保存本队列每次取全部还是取一条的配置。
		this.mode = mode;
	}

	/**
	 * 把一条已构造消息追加到队尾，无返回值；副作用只有排队，不启动/中断模型。例：先入 A 再入 B，读取时先得到 A。
	 */
	enqueue(message: AgentMessage): void {
		// 追加到队尾，先到的消息仍排列在前。
		this.messages.push(message);
	}

	/**
	 * 无输入，返回是否还有待投递消息，不消费队列；例：两条消息等待时为 true。
	 */
	hasItems(): boolean {
		// 只问有没有排队消息，不消费它们。
		return this.messages.length > 0;
	}

	/**
	 * 按 mode 预览下一批，返回消息数组，保留原队列；例：队列 A/B 在 one-at-a-time 下返回 [A]。
	 */
	peek(): AgentMessage[] {
		// all 模式预览全队列，复制顶层数组，不清空原队列。
		if (this.mode === "all") return this.messages.slice();
		// one-at-a-time 模式只看队头；空队列取到 undefined。
		const first = this.messages[0];
		// 有队头则包成单元素数组，没有则返回空数组，统一返回形状。
		return first ? [first] : [];
	}

	/**
	 * 按 mode 取出并消费下一批消息，返回本次取到的数组；例：A/B 先取 [A] 后队列仅剩 B。
	 */
	drain(): AgentMessage[] {
		// 先按模式选出本次应投递的消息，复用 peek 的取数规则。
		const drained = this.peek();
		// 去掉刚选中的前缀；原有后续消息保留给下一回合。
		this.messages = this.messages.slice(drained.length);
		// 返回已消费的那一批；与 peek 最大区别是队列内容已减少。
		return drained;
	}

	/**
	 * 清空尚未投递的队列，无参数/返回值；只改队列，不从模型历史删除已投递消息。
	 */
	clear(): void {
		// 整体替换为空队列，之前的排队消息不再被下一次 drain 投递。
		this.messages = [];
	}
}

// 当前低层运行的句柄；Promise 用于等待，resolve 用于完成，AbortController 用于发取消。
type ActiveRun = {
	// 运行和被 await 的事件监听器结束后才完成，不直接承载模型文本。
	promise: Promise<void>;
	// 无参数的完成通知函数，finishRun 调用它唤醒 waitForIdle。
	resolve: () => void;
	// 当前运行拥有的取消控制器，下层只拿它的 signal。
	abortController: AbortController;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	// 内部可变状态；外部通过 state 的只读接口读取部分字段。
	private _state: MutableAgentState;
	// readonly 限制替换 Set 引用，仍允许 add/delete；每个监听器可同步或返回 Promise。
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	// 处理中途插话的独立队列，通常在一个完整模型/工具回合后读取。
	private readonly steeringQueue: PendingMessageQueue;
	// 自然停下前才读取的追问队列，与插话分开保证投递时机。
	private readonly followUpQueue: PendingMessageQueue;

	// 对外可替换的应用消息转换器，当前回合创建配置时引用它。
	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	// 可选上下文加工函数，不承诺自动持久化加工后的结果。
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	// 已注入的模型请求函数；Agent 核心不直接依赖某个供应商目录。
	public streamFunction: StreamFn;
	// 本轮请求凭证解析回调，适合短期有效令牌。
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	// 实际供应商请求体钩子，传给 streamFunction。
	public onPayload?: SimpleStreamOptions["onPayload"];
	// 供应商 HTTP 响应头钩子。
	public onResponse?: SimpleStreamOptions["onResponse"];
	// 供应商原始流事件钩子，与 Agent 事件订阅器不是同一个接口。
	public onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
	// 工具执行前的拦截函数，下面参数为已校验工具调用上下文和取消信号。
	public beforeToolCall?: (
		// 包含原 assistant、原始 toolCall、已校验 args 和当前上下文。
		context: BeforeToolCallContext,
		// 可选取消信号：类型里的 ? 表示可不传，不会自动实现取消，具体回调必须响应它。
		signal?: AbortSignal,
		// 异步返回阻止/终止等决定，undefined 表示没有阻止要求。
	) => Promise<BeforeToolCallResult | undefined>;
	// 工具结束后的覆盖函数，可以修改 content/details/isError 等字段。
	public afterToolCall?: (
		// 工具结果已经存在，此上下文额外含 result 与 isError。
		context: AfterToolCallContext,
		// 可选取消信号：类型里的 ? 表示可不传，不会自动实现取消，具体回调必须响应它。
		signal?: AbortSignal,
		// 返回部分覆盖字段，不会对嵌套对象深合并。
	) => Promise<AfterToolCallResult | undefined>;
	// 整轮工具结果齐备后的继续/结束决定。
	public finishTurn?: FinishTurn;
	// 每次模型请求前的快照/路由更新回调。
	public prepareRequest?: PrepareRequest;
	// 兼容的无上一回合上下文的准备函数；新版优先级更高。
	public prepareNextTurn?: (
		// 可选取消信号：类型里的 ? 表示可不传，不会自动实现取消，具体回调必须响应它。
		signal?: AbortSignal,
		// 这个联合返回类型同时接受同步/异步回调；undefined 表示不替换状态。
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	// 带上一轮结果的准备函数，会话层用来接压缩与规则刷新。
	public prepareNextTurnWithContext?: (
		// 上一回合的 assistant、工具结果、上下文和本轮新增消息。
		context: PrepareNextTurnContext,
		// 可选取消信号：类型里的 ? 表示可不传，不会自动实现取消，具体回调必须响应它。
		signal?: AbortSignal,
		// 这个联合返回类型同时接受同步/异步回调；undefined 表示不替换状态。
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	// 有值表示低层仍在运行或等待监听器完成；未运行时为 undefined。
	private activeRun?: ActiveRun;
	/** Session identifier forwarded to providers for cache-aware backends. */
	// 向模型请求透传的会话标识。
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	// 模型思考预算，由宿主设置并透传。
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	// 实际保存的传输偏好，构造时缺省 auto。
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	// 可选供应商重试等待上限。
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	// 本 Agent 的默认批次工具策略，构造时缺省 parallel。
	public toolExecution: ToolExecutionMode;
	/** Request identity forwarded to the stream function, over `DEFAULT_AGENT_IDENTITY`. */
	// 客户端归因信息，合并规则由请求边界处理。
	public identity?: ClientIdentity;

	// Agent 负责运行状态、消息队列和事件；构造时保存回调，尚未调用模型。
	/**
	 * 按配置创建有状态 Agent，保存模型函数/钩子并初始化两种队列，不调用模型。
	 * 输入是 options；副作用限于本实例状态。例：new Agent({streamFn, initialState:{model}}) 仅装配，之后 prompt 才运行。
	 * 当前签名要求 streamFn；旧调用方省略它会读取默认函数，默认也没配置时会在构造阶段抛错。
	 */
	constructor(options: AgentOptions) {
		// Older compiled consumers may omit options or streamFn even though the current API requires them.
		// 当前类型要求 options/streamFn，但旧编译产物可能省略；Partial 让兼容兜底读字段时允许 undefined。
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		// 创建状态：已有历史、选中模型、思考级别和工具；不会凭空从模型服务器读取聊天记录。
		this._state = createMutableAgentState(runtimeOptions.initialState);
		// 保存消息转换函数；SDK 传来的版本认识 coding-agent 的自定义消息。
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		// 保存请求前变换历史的回调，真正请求时才执行。
		this.transformContext = runtimeOptions.transformContext;
		// 关键依赖注入：Agent 不绑定某个供应商，用外部传入的函数请求模型；测试可以替换为 faux。
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		// 保存每次请求前解析凭证的回调，暂不执行。
		this.getApiKey = runtimeOptions.getApiKey;
		// 保存供应商请求体钩子，生成请求时再调用。
		this.onPayload = runtimeOptions.onPayload;
		// 保存供应商响应头钩子。
		this.onResponse = runtimeOptions.onResponse;
		// 保存供应商原始流钩子。
		this.onProviderStreamEvent = runtimeOptions.onProviderStreamEvent;
		// 保存前置工具策略，例如阻止一次调用。
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		// 保存工具结果加工函数。
		this.afterToolCall = runtimeOptions.afterToolCall;
		// 保存回合结束时的调度决定。
		this.finishTurn = runtimeOptions.finishTurn;
		// 保存每次模型请求之前的更新函数。
		this.prepareRequest = runtimeOptions.prepareRequest;
		// 保存旧版回合间准备接口。
		this.prepareNextTurn = runtimeOptions.prepareNextTurn;
		// 保存新版准备接口，实际运行时优先用它。
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		// 新建插话队列，默认一次投递一条，避免一口气消耗多句插话。
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		// 追问队列独立保存，同样默认每次一条。
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		// 缓存/跟踪用会话标识，缺省则不强行生成。
		this.sessionId = runtimeOptions.sessionId;
		// 把宿主设定的思考预算保存下来。
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		// 没指定传输时交给供应商自动选择。
		this.transport = runtimeOptions.transport ?? "auto";
		// 保存可选的供应商退避等待上限。
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		// 默认并行执行同一回答中的工具；具体工具要求串行时，低层循环会改走串行分支。
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
		// 保存请求归因元数据，不在构造时发任何归因请求。
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
	/**
	 * 注册一个同步/异步事件监听器，返回取消订阅函数；内部按注册顺序等待它们。
	 * 例：const off = agent.subscribe(e => ...)，off() 取消未来通知；已有正在执行的回调不会被倒退撤销。
	 */
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
	/**
	 * 读取 agent.state 时返回当前公开状态，无参数、不复制历史；例如 state.messages 可查看完整消息，运行标记对外只读。
	 */
	get state(): AgentState {
		// 返回当前状态对象本身，不复制整段历史；外部应遵守公开接口的 readonly 约束。
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	/**
	 * 赋 agent.steeringMode 时修改插话队列投递方式；例如设 all 后下次 drain 取出全部插话，不立即投递。
	 */
	set steeringMode(mode: QueueMode) {
		// 立即改变之后插话 drain 的批量规则，不主动消费现有队列。
		this.steeringQueue.mode = mode;
	}

	/**
	 * 读取当前插话队列模式，不消费消息；例如得到 one-at-a-time。
	 */
	get steeringMode(): QueueMode {
		// 读取插话队列当前投递模式。
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	/**
	 * 修改追问队列的批次规则，不改变其“自然停止前才读取”的时机；例如 all 一次投递全部追问。
	 */
	set followUpMode(mode: QueueMode) {
		// 修改追问队列之后的投递模式，不改变消息先后。
		this.followUpQueue.mode = mode;
	}

	/**
	 * 读取当前追问队列模式，无状态修改；例如 one-at-a-time。
	 */
	get followUpMode(): QueueMode {
		// 读取追问队列模式。
		return this.followUpQueue.mode;
	}

	/** Queue a message to be injected after the current assistant turn finishes. */
	/**
	 * 把一条消息排进插话队列，等当前模型及工具回合完成后投递，不立刻打断半条输出。
	 * 例：Agent 正读文件时排入“先解释错误”，当前批工具仍会按循环规则处理，再将插话交给下一次模型请求。
	 */
	steer(message: AgentMessage): void {
		// 只入队，不取消正在输出的模型，也不跳过当前回合的工具。
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop. */
	/**
	 * 排入等任务自然停下才处理的后续消息；无返回值，保留现有运行。例：当前分析结束后再做“总结三点”。
	 */
	followUp(message: AgentMessage): void {
		// 只入队；模型/工具自然结束后低层循环才来取它。
		this.followUpQueue.enqueue(message);
	}

	/** Remove all queued steering messages. */
	/**
	 * 清空未投递插话，无输入/返回值；用于用户撤回排队输入，不会删掉已发送给模型的消息。
	 */
	clearSteeringQueue(): void {
		// 丢弃尚未投递的插话，不删除已写入历史的用户消息。
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	/**
	 * 清空尚未投递的后续追问；副作用只在队列，例如取消“任务完成后再总结”的安排。
	 */
	clearFollowUpQueue(): void {
		// 丢弃尚未投递的追问。
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	/**
	 * 组合清理插话和追问两条队列，不中止当前模型/工具；无参数、无返回值。
	 */
	clearAllQueues(): void {
		// 清理插话队列；reset/clearAllQueues 组合使用同一公开动作。
		this.clearSteeringQueue();
		// 清理追问队列，不直接影响网络请求。
		this.clearFollowUpQueue();
	}

	/** Returns true when either queue still contains pending messages. */
	/**
	 * 查询两队列是否任意非空，不消费消息；外层会话据此决定自然结束后还需不需要继续。
	 */
	hasQueuedMessages(): boolean {
		// 任一队列非空就返回 true；|| 的右侧只在左侧为 false 时读取。
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Preview the messages selected for the next turn without consuming them. */
	/**
	 * 预览优先应投递的一批，插话优先，没有插话再取追问；不同时合并两个队列。例：A 插话和 B 追问并存时预览 A。
	 */
	peekQueuedMessages(): AgentMessage[] {
		// 先预览插话，因为它比自然结束后的追问优先。
		const steering = this.steeringQueue.peek();
		// 有插话就只预览插话，否则预览 follow-up；均不会从队列删除消息。
		return steering.length > 0 ? steering : this.followUpQueue.peek();
	}

	/** Active abort signal for the current run, if any. */
	/**
	 * 返回当前低层运行的取消信号，空闲时 undefined；工具/扩展可读取它，不能通过 signal 自己发取消。
	 */
	get signal(): AbortSignal | undefined {
		// 有正在运行的任务才返回取消信号；?. 避免未运行时访问 undefined 的属性。
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	/**
	 * 若有运行则向其 AbortController 发取消，无返回值；不会在这里等待真正空闲。例：abort() 后再 await waitForIdle() 等收尾。
	 */
	abort(): void {
		// 发出取消信号；它依赖请求函数、工具和监听器配合，不会凭空杀掉所有 JavaScript 工作。
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	/**
	 * 返回当前运行的完成 Promise，空闲时立即完成；包括 agent_end 的异步监听器执行时间，不直接返回回答文字。
	 */
	waitForIdle(): Promise<void> {
		// 正在运行就等其完成，否则返回一个已完成 Promise，保证调用方总能 await。
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear conversation state and queues while retaining the replayed prompt/tool baseline. */
	/**
	 * 只在空闲时清空对话与队列，同时保留从历史重放的 system/工具声明基础；忙碌时抛错。
	 * 例：旧历史为 system/user/assistant，reset 后只剩有效 system。它不负责删除外层 SessionManager 的磁盘日志。
	 */
	reset(): void {
		// 当前运行还可能追加消息，此时不能把历史清空，否则调用/结果配对和事件顺序会被破坏。
		if (this.activeRun) {
			// 直接拒绝 reset，不在这里偷偷取消一个正在执行且可能有副作用的工具。
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		// 从完整历史重放当前 system 规则/工具声明，用作清空对话后的基础。
		const baseline = getCurrentSystemMessage(this._state.messages);
		// reset 只保留重放后的 system，用户/模型/工具历史清空；setter 会浅复制这个数组。
		this._state.messages = baseline ? [baseline] : [];
		// 低层 Agent 状态恢复为空闲；AgentSession 的更外层工作状态独立管理。
		this._state.isStreaming = false;
		// 不再显示当前草稿；它不负责删除 messages 中的已完成消息。
		this._state.streamingMessage = undefined;
		// 用新的空 Set 表示没有执行中工具；不能保留上次运行的调用 id。
		this._state.pendingToolCalls = new Set<string>();
		// 清掉旧错误提示，避免影响之后的新运行。
		this._state.errorMessage = undefined;
		// 清理追问队列，不直接影响网络请求。
		this.clearFollowUpQueue();
		// 清理插话队列；reset/clearAllQueues 组合使用同一公开动作。
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	// 函数重载之一：允许传单条消息或消息数组；这行只有类型签名，没有运行体。
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	// 另一个重载：允许字符串加可选图片。? 表示参数可不传；Promise<void> 表示等完成，不直接返回回答文本。
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	// Agent 的统一提问入口。上面的多个签名，最终都由这一个函数体处理。
	/**
	 * 接受新问题并等低层工具循环完整结束，输入可为字符串、单消息或消息数组，可另附图片。
	 * 流程：拒绝并发运行 → 归一化输入 → 初始化生命周期 → 请求模型与工具循环 → 收尾。副作用是更新历史、状态和事件。
	 * 例：await agent.prompt("读取 a.txt") 可内部多次请求模型；回答在 state.messages/事件里，返回值为 void。
	 */
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		// 同一个 Agent 不允许两个运行同时改历史；正在工作时应使用 steer/followUp 排队。
		if (this.activeRun) {
			// 把并发提问错误交给调用方；需要插话/追问时应使用下方明确的排队接口。
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
	/**
	 * 在不重复追加原问题的前提下继续已有上下文；不允许空历史或仅 system 的历史。
	 * 若末尾已是 assistant，必须先有排队消息作为新输入；否则末尾为 user/toolResult 等可直接续跑。例：模型失败后外层修正上下文再 continue。
	 */
	async continue(): Promise<void> {
		// 同一个 Agent 不允许两个运行同时改历史；正在工作时应使用 steer/followUp 排队。
		if (this.activeRun) {
			// 不能并发再启动一个 continuation，原来的运行及其监听器尚未结束。
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		// 取历史最后一条，决定还能不能直接请求模型。
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		// 没有对话，或只有 system 配置时，没什么可以继续回答的。
		if (!lastMessage || this._state.messages.every((message) => message.role === "system")) {
			// system 只描述规则/工具，还没有用户输入或工具结果可供模型继续回答。
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
				// 这次继续要求已由插话运行满足，不再同时取 follow-up 或补一次空续轮。
				return;
			}

			// 没有插话时再取 follow-up，例如“当前任务完成后做一次总结”。
			const queuedFollowUps = this.followUpQueue.drain();
			// 只有确实有排队问题时，才从 assistant 结尾接上一句新输入。
			if (queuedFollowUps.length > 0) {
				// 排队追问使用同一份历史，进入一个新的低层运行。
				await this.runPromptMessages(queuedFollowUps);
				// 排队追问已作为新输入执行完成，不再使用旧 assistant 结尾继续。
				return;
			}

			// 没有新输入却想从 assistant 末尾硬续，会在这里拒绝。
			throw new Error("Cannot continue from message role: assistant");
		}

		// 最后是 user/toolResult 等可继续输入时，直接用现有上下文运行，不再重复追加问题。
		await this.runContinuation();
	}

	// 统一入口参数的形状；这是合法联合类型的分支处理，不是在模型返回边界做 schema 校验。
	/**
	 * 纯输入形状归一化，返回消息数组，不请求模型；数组原样返回，单条包数组，字符串新建 user。
	 * 例："你好" 变为 [{role:"user", content:[{type:"text", text:"你好"}], timestamp:...}]。传数组时单独 images 不再合入。
	 */
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
	/**
	 * 把本次新消息、已有历史快照、模型/工具配置和事件回调接进低层 runAgentLoop。
	 * 它等待 runWithLifecycle 完成，副作用由循环发事件写入状态。例：一条用户消息可返回模型工具调用及最终回答多条消息。
	 */
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
	/**
	 * 用已有对话继续一次低层运行，不发新的 prompt 消息事件；生命周期与新 prompt 相同。例：当前尾部已是工具结果时继续请求模型。
	 */
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
	/**
	 * 取当前历史和可执行工具的浅层数组快照，无外部副作用；不会复制每个消息对象或函数。例：第二次 prompt 会在这里带上第一次历史。
	 */
	private createContextSnapshot(): AgentContext {
		// 快照只含普通数组字段，不使用初始化状态里的 getter/setter；消息与工具对象仍复用。
		return {
			// slice() 浅复制数组；消息对象本身没有深复制。第二次 prompt 会从这里带上第一次的对话。
			messages: this._state.messages.slice(),
			// 工具对象也只浅复制数组；execute 等函数仍是原工具的实现。
			tools: this._state.tools.slice(),
		};
	}

	// 将 Agent 上的状态/回调组装成低层循环配置。= {} 表示调用时可省略 options。
	/**
	 * 组装一次低层运行所需配置，把模型选项、生命周期钩子与队列读取函数交给 runLoop。
	 * 返回新配置对象；闭包中的 skipInitialSteeringPoll 只影响第一次插话读取。例：continue 已取过一条插话时避免再次多取。
	 */
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		// 保存一次性标记：插话若已在 continue 中取过，第一次队列读取应跳过。
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		// 返回本次循环配置；下面的队列回调会闭包引用一次性标记及本实例，不立即消费消息。
		return {
			// 传入当前模型对象；模型不是历史记忆容器，历史由 messages 明确提供。
			model: this._state.model,
			// 三元表达式：思考级别为 off 时传 undefined，否则传实际级别。
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			// 把会话标识透传给模型请求函数，区别于消息数组本身。
			sessionId: this.sessionId,
			// 供应商请求体钩子通过循环配置继续传下去。
			onPayload: this.onPayload,
			// 供应商响应头钩子同样透传。
			onResponse: this.onResponse,
			// 供应商原始流钩子透传，不取代 Agent.subscribe。
			onProviderStreamEvent: this.onProviderStreamEvent,
			// 模型协议的传输偏好，不改变工具是本地执行还是远程执行。
			transport: this.transport,
			// 传下去的思考预算，由具体模型请求函数使用。
			thinkingBudgets: this.thinkingBudgets,
			// 传递供应商重试等待限制。
			maxRetryDelayMs: this.maxRetryDelayMs,
			// 归因等请求元数据，稍后会和 Agent 默认身份合并。
			identity: this.identity,
			// 低层 executeToolCalls 据此选择串行/并行。
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
	/**
	 * 给实际循环包一层统一生命周期，创建 activeRun/取消信号，标记忙碌，捕获异常，最后清理。
	 * 输入为异步执行回调；无回答返回值。例：executor 抛网络异常时生成失败消息事件，而 finally 仍会执行 finishRun。
	 */
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		// 同一个 Agent 不允许两个运行同时改历史；正在工作时应使用 steer/followUp 排队。
		if (this.activeRun) {
			// 这是内部生命周期入口的同一并发约束，防止其他路径绕过公开 prompt 的检查。
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

		// 执行、异常消息化和最终清理放在同一 try/catch/finally，任何路径都要释放忙碌状态。
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

	/**
	 * 将执行器直接抛出的异常转换成 assistant 失败消息，并依次发布消息开始/结束、回合结束、运行结束。
	 * 输入 unknown 异常和取消标记；副作用是更新历史并等待监听器。例：用户取消对应 aborted，其他异常对应 error，usage 用零占位。
	 */
	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		// 把异常包装成一条 assistant 失败消息，保持事件订阅者和历史能够观察到终点。
		const failureMessage = {
			// 运行失败以模型消息形状表达，内容可以为空，原因另存在 errorMessage。
			role: "assistant",
			// 放一个空文字块，实际错误说明不混进普通成功回答正文。
			content: [{ type: "text", text: "" }],
			// 沿用当前模型的 API 元数据，便于错误记录定位请求。
			api: this._state.model.api,
			// 记录失败对应的供应商。
			provider: this._state.model.provider,
			// 记录失败对应的模型 id。
			model: this._state.model.id,
			// 本地异常没有可靠供应商用量，用明确的零占位而不是猜测费用。
			usage: EMPTY_USAGE,
			// 三元表达式区分用户取消和一般错误，两者不能都标成正常 stop。
			stopReason: aborted ? "aborted" : "error",
			// 捕获值是 unknown，必须先确认 Error 才能读 message，其他抛出值转成文字。
			errorMessage: error instanceof Error ? error.message : String(error),
			// 记录生成这条错误消息的毫秒时间。
			timestamp: Date.now(),
			// 开发时确认对象符合消息联合；satisfies 不会在运行时校验或修正它。
		} satisfies AgentMessage;
		// 先发布这条失败消息的开始，让监听器仍能观察完整消息生命周期。
		await this.processEvents({ type: "message_start", message: failureMessage });
		// 再发布结束，processEvents 将失败消息写入 Agent 历史，订阅者可继续保存。
		await this.processEvents({ type: "message_end", message: failureMessage });
		// 失败路径没有这次执行出的工具结果，回合结果列表为空。
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		// 低层不再产新事件；之后 finally 的 finishRun 才清掉 activeRun 并唤醒 idle 等待者。
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	// 低层运行真正转为空闲的位置，比 agent_end 事件的发出时刻更晚。
	/**
	 * 清低层流状态与执行中工具，完成 idle 等待 Promise，并释放 activeRun；不删除完整历史。
	 * 无输入/返回值。例：agent_end 监听器 await 完后才到这里，下一次普通 prompt 随后可进入。
	 */
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
	// 所有循环事件先在这里更新 Agent 状态，再传给会话层保存/扩展和 UI。
	/**
	 * 一个事件先更新 Agent 内存状态，再按订阅顺序等待所有监听器；不在此直接写 JSONL。
	 * 例：message_end 先追加完整消息，随后 AgentSession 监听器再保存；订阅者全部完成才让低层循环推进。
	 */
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
