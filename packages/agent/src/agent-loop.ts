// 调度模型与工具的低层循环：输入消息/上下文/回调，输出 Agent 事件与新增历史。宿主负责持久化和 UI，本文件负责回合、工具、插话与追问的顺序。
/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

// 引入 pi-ai 的统一模型协议、流队列、system/工具声明重放和参数校验；本文件不硬编码具体模型供应商。
import {
	type AssistantMessage,
	type ClientIdentity,
	EventStream,
	getCurrentTools,
	getToolStateChanges,
	mergeClientIdentity,
	normalizeContext,
	PI_ATTRIBUTION,
	type SystemMessage,
	type ToolResultMessage,
	type ToolStateChanges,
	toToolDeclaration,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
// Agent 的消息、上下文、配置和工具等契约仅用于 TS 类型检查。
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

// emit 是事件接收函数。例如收到 message_end 后，会话层会保存这条完整消息；允许同步返回，也允许返回 Promise。
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Request identity of agent loops: pi-ai's defaults with provider attribution to pi. `AgentLoopConfig.identity`
 * overrides it field by field.
 */
// 默认把模型请求归因到 Pi；调用方 identity 可按字段覆盖，和供应商认证不是一回事。
export const DEFAULT_AGENT_IDENTITY: ClientIdentity = { attribution: PI_ATTRIBUTION };

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
/**
 * 启动带新输入的低层循环，立即返回 EventStream；调用方可逐条迭代 AgentEvent，并从 result() 取新增消息数组。
 * 输入包含新消息、旧上下文、配置、取消和模型函数；内部启动 runAgentLoop 并转发事件，不创建有状态 Agent。
 * 例：自己管理历史的宿主可 for await 读取事件，最后把新增消息并入自己的会话。
 */
export function agentLoop(
	// 本次新增的起始消息，可能包含 system 更新、用户问题和扩展上下文；不包含全部旧历史。
	prompts: AgentMessage[],
	// 已有历史与当前可执行工具。循环会基于它准备模型请求，不把 execute 直接发送给模型。
	context: AgentContext,
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 宿主注入的模型请求函数，可为真实供应商、代理或测试 faux。
	streamFn: StreamFn,
	// 返回“逐条 AgentEvent + 最终新增消息数组”的双层流，不直接等所有工作完成。
): EventStream<AgentEvent, AgentMessage[]> {
	// 为外部消费者建事件队列；内部 Promise 运行期间不断向它 push。
	const stream = createAgentStream();

	// 启动 Promise 版本循环并刻意不在当前同步函数等待；void 表达不使用 Promise 值，不是取消任务。
	void runAgentLoop(
		// 传入本次新增输入，低层会先发布这些消息的开始/结束。
		prompts,
		// 传入已有上下文，模型看到的是这份历史加新增消息。
		context,
		// 沿用本次模型/工具/钩子配置，调度策略不藏在流包装器中。
		config,
		// 这个回调充当事件出口，低层每 emit 一条就在外部队列追加一条。
		async (event) => {
			// 把事件交给 EventStream 消费者；事件本身不等于已经打印到终端。
			stream.push(event);
		},
		// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
		signal,
		// 透传模型函数引用，此处不立即调用它。
		streamFn,
		// Promise 正常完成后拿到本次新增消息；当前包装器没有在这里添加独立 catch。
	).then((messages) => {
		// 关闭队列并给出最终消息数组，已入队事件仍可继续读完。
		stream.end(messages);
	});

	// 立刻返回可迭代队列，调用方可用 for await 边生成边读。
	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
/**
 * 继续已有上下文的流式入口，不追加新用户问题。先拒绝空历史/assistant 结尾，再启动 Promise 入口并桥接事件。
 * 输入是现有上下文与配置，返回 EventStream；循环会生成消息/执行工具。例：历史尾部已有 toolResult 时继续等待模型解释。
 */
export function agentLoopContinue(
	// 已有历史与当前可执行工具。循环会基于它准备模型请求，不把 execute 直接发送给模型。
	context: AgentContext,
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 宿主注入的模型请求函数，可为真实供应商、代理或测试 faux。
	streamFn: StreamFn,
	// 返回“逐条 AgentEvent + 最终新增消息数组”的双层流，不直接等所有工作完成。
): EventStream<AgentEvent, AgentMessage[]> {
	// continue 没有任何历史时无法知道该回答什么，先拒绝空上下文。
	if (context.messages.length === 0) {
		// 同步包装入口直接抛错；async 入口则以拒绝 Promise 报错，宿主负责生命周期处理。
		throw new Error("Cannot continue: no messages in context");
	}

	// 现成 assistant 结尾不能直接续问；需要先有用户输入/工具结果等可继续上下文。
	if (context.messages[context.messages.length - 1].role === "assistant") {
		// 拒绝把已完成模型回答当成新输入，避免供应商不接受的消息顺序。
		throw new Error("Cannot continue from message role: assistant");
	}

	// 为外部消费者建事件队列；内部 Promise 运行期间不断向它 push。
	const stream = createAgentStream();

	// 继续已有历史的 Promise 入口；包装成与新 prompt 相同的事件流形状，不追加原问题。
	void runAgentLoopContinue(
		// 传入已有上下文，模型看到的是这份历史加新增消息。
		context,
		// 沿用本次模型/工具/钩子配置，调度策略不藏在流包装器中。
		config,
		// 这个回调充当事件出口，低层每 emit 一条就在外部队列追加一条。
		async (event) => {
			// 把事件交给 EventStream 消费者；事件本身不等于已经打印到终端。
			stream.push(event);
		},
		// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
		signal,
		// 透传模型函数引用，此处不立即调用它。
		streamFn,
		// Promise 正常完成后拿到本次新增消息；当前包装器没有在这里添加独立 catch。
	).then((messages) => {
		// 关闭队列并给出最终消息数组，已入队事件仍可继续读完。
		stream.end(messages);
	});

	// 立刻返回可迭代队列，调用方可用 for await 边生成边读。
	return stream;
}

// 低层循环入口。接收这次新消息和已有历史；一次调用可能向模型请求很多次。
/**
 * 带新输入的 Promise 入口：声明工具变化、建立本次局部上下文、发起始消息事件，再运行共享循环。
 * 返回本次新增消息；emit 的异步副作用会被等待。例：一个用户输入最终新增 user、带 read 调用的 assistant、toolResult、最终 assistant。
 */
export async function runAgentLoop(
	// 本次新增的起始消息，可能包含 system 更新、用户问题和扩展上下文；不包含全部旧历史。
	prompts: AgentMessage[],
	// 已有历史与当前可执行工具。循环会基于它准备模型请求，不把 execute 直接发送给模型。
	context: AgentContext,
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 宿主注入的模型请求函数，可为真实供应商、代理或测试 faux。
	streamFn: StreamFn,
	// 异步入口等到整个低层循环完成，返回新增消息数组，不是返回每段文字的数组。
): Promise<AgentMessage[]> {
	// 先让工具声明与实际工具一致。例如运行时有 read，就要在 system 消息中告诉模型 read 的参数格式。
	const initialMessages = declareToolChanges(context, prompts);
	// 只收集本次运行产生的消息；AgentMessage[] 是消息数组，... 在这里把数组元素展开。
	const newMessages: AgentMessage[] = [...initialMessages];
	// 建立本次循环使用的上下文对象。它既含历史消息，也含真正可执行的工具函数。
	const currentContext: AgentContext = {
		// 对象展开：先带上原上下文的字段，后面同名字段会覆盖这里的值。
		...context,
		// 发送时需要“旧历史 + 新问题”，而不是只把用户最后一句话发给模型。
		messages: [...context.messages, ...initialMessages],
	};

	// 通知订阅者：开始一次 Agent 运行。await 会等订阅者处理完，才继续向下执行。
	await emit({ type: "agent_start" });
	// 开始一个模型回合：一次模型回答加上它要求执行的工具，算作这里的一轮 turn。
	await emit({ type: "turn_start" });
	// 逐条发布起始消息，例如 system 补丁和用户问题；for...of 直接遍历数组里的值。
	for (const message of initialMessages) {
		// 告诉外部这条消息开始了；message 是 message: message 的简写。
		await emit({ type: "message_start", message });
		// 完整消息就绪。Agent 更新历史，会话层处理保存；流式的中间片段不会逐片写成完整消息。
		await emit({ type: "message_end", message });
	}

	// 进入真正的模型/工具循环；?? 表示左边为 null 或 undefined 时才采用右边的默认值。
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	// 返回这次运行新增的消息；已有历史不重复返回。Agent.prompt() 对外仍返回 Promise<void>。
	return newMessages;
}

/**
 * 基于已有输入续跑，不重复追加已有消息；校验可续跑的历史后发运行/回合开始事件，进入同一个 runLoop。
 * 返回新生成消息数组；浅复制上下文对象但沿用 messages 数组，传入上下文可能被追加消息。例：重试前已有 user 时只再生成回复。
 */
export async function runAgentLoopContinue(
	// 已有历史与当前可执行工具。循环会基于它准备模型请求，不把 execute 直接发送给模型。
	context: AgentContext,
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 宿主注入的模型请求函数，可为真实供应商、代理或测试 faux。
	streamFn: StreamFn,
	// 异步入口等到整个低层循环完成，返回新增消息数组，不是返回每段文字的数组。
): Promise<AgentMessage[]> {
	// continue 没有任何历史时无法知道该回答什么，先拒绝空上下文。
	if (context.messages.length === 0) {
		// 同步包装入口直接抛错；async 入口则以拒绝 Promise 报错，宿主负责生命周期处理。
		throw new Error("Cannot continue: no messages in context");
	}

	// 现成 assistant 结尾不能直接续问；需要先有用户输入/工具结果等可继续上下文。
	if (context.messages[context.messages.length - 1].role === "assistant") {
		// 拒绝把已完成模型回答当成新输入，避免供应商不接受的消息顺序。
		throw new Error("Cannot continue from message role: assistant");
	}

	// continue 不把已有用户/工具消息重复计入新增列表，后续新生成的消息才追加。
	const newMessages: AgentMessage[] = [];
	// 浅复制上下文对象；这里没有新建 messages 数组，所以底层仍沿用给定消息数组。
	const currentContext: AgentContext = { ...context };

	// 通知订阅者：开始一次 Agent 运行。await 会等订阅者处理完，才继续向下执行。
	await emit({ type: "agent_start" });
	// 开始一个模型回合：一次模型回答加上它要求执行的工具，算作这里的一轮 turn。
	await emit({ type: "turn_start" });

	// 进入真正的模型/工具循环；?? 表示左边为 null 或 undefined 时才采用右边的默认值。
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	// 返回这次运行新增的消息；已有历史不重复返回。Agent.prompt() 对外仍返回 Promise<void>。
	return newMessages;
}

/**
 * 创建 Agent 事件队列，以 agent_end 识别结束，并把 event.messages 作为最终结果；无网络或工具副作用。
 * 例：先 push message_update 可被逐片迭代，最后 push agent_end 后 result() 得到本轮新增消息数组。
 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	// 泛型的第一项是中间事件，第二项是最终 result 的类型；构造器下面两个回调识别终点和取结果。
	return new EventStream<AgentEvent, AgentMessage[]>(
		// 遇到 agent_end 就视为正常流终止事件。
		(event: AgentEvent) => event.type === "agent_end",
		// 终止时取该事件的新增消息数组；其他事件若走到取值函数则返回空数组。
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
// 循环调度器。例：问“读文件”→模型给 read 调用→执行 read→把结果交回模型→模型回答。
/**
 * 共享调度器：内层处理模型、工具、插话；外层处理自然结束后的追问或明确继续决定，直到结束/取消/错误。
 * 输入是可替换上下文/配置、新增消息数组与事件出口；副作用包括请求模型、执行工具、追加消息和等待钩子，不直接写磁盘。
 * 例：read 完成后自动再问模型，随后用户排队的“总结三点”可在任务自然停下前作为追问继续。
 */
async function runLoop(
	// 循环起点的历史/工具快照；后续可由准备钩子替换为新的上下文。
	initialContext: AgentContext,
	// 由调用者持有的新增消息列表，本循环会 push；所以没有必要另返回一份相同数组。
	newMessages: AgentMessage[],
	// 初始配置；模型和思考级别允许在请求边界更新。
	initialConfig: AgentLoopConfig,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 实际模型函数，上层已经解析显式传入值或兼容默认函数。
	streamFunction: StreamFn,
	// 本异步函数以更新消息/事件为主要结果，不直接返回业务文本；void 不表示“没有副作用”。
): Promise<void> {
	// 保存当前上下文；let 允许稍后用压缩或扩展产生的新上下文替换它。
	let currentContext = initialContext;
	// 保留当前配置；下一回合可能改变模型、思考级别等，所以这里用 let。
	let config = initialConfig;
	// 上一回合的结果；第一轮还没有，所以类型允许 undefined。竖线 | 表示“二者之一”。
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	// 记录扩展是否明确要求再走一轮，即使模型没有调用工具、用户也没有排队消息。
	let explicitContinuation = false;
	// Check for steering messages at start (user may have typed while waiting)
	// 先取插话队列。?.() 表示回调存在才调用；没有消息就用空数组。不会打断正在输出的一半工具参数。
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	// 外层循环：自然结束前还要看 follow-up 队列，有追问就接着处理。退出靠后面的 break/return。
	while (true) {
		// 先设为 true，让内层至少请求一次模型；之后由工具执行结果决定是否继续。
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		// 有工具后续，或有用户插话，就继续请求模型。一次用户 query 可以在这里转很多圈。
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			// 准备放下一轮额外注入的消息，例如更新后的 system 提示词补丁。
			let preparedMessages: AgentMessage[] = [];
			// 第一回合跳过；后续回合才能根据上一回合做刷新、压缩等准备。
			if (lastCompletedTurn) {
				// 调用会话层安装的回调；这条看似普通的函数调用可能触发上下文压缩、工具列表刷新。
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				// 回调可以不返回更新；只有确实返回新快照时才替换相应字段。
				if (nextTurnSnapshot) {
					// 有新上下文就用新的，例如压缩后的“摘要 + 近期原文”；否则沿用原历史。
					currentContext = nextTurnSnapshot.context ?? currentContext;
					// 取下一轮需要追加的新消息；没有就保持空数组。
					preparedMessages = nextTurnSnapshot.messages ?? [];
					// 创建更新后的配置对象；保留其余选项，只覆盖这次明确改变的字段。
					config = {
						// 沿用原配置；这是浅层展开，不会递归复制消息或工具。
						...config,
						// 回调有指定模型就切换本轮使用的模型，否则维持原选择。
						model: nextTurnSnapshot.model ?? config.model,
						// 下面的条件表达式决定本次请求的思考级别。
						reasoning:
							// 没提供思考级别意味着保持原设置，而不是自动关闭思考。
							nextTurnSnapshot.thinkingLevel === undefined
								? // 条件为真时保留已有思考设置；? 和后面的 : 是三元表达式的两条分支。
									config.reasoning
								: // 明确设置为 off 才走关闭思考的分支。
									nextTurnSnapshot.thinkingLevel === "off"
									? // 这里用 undefined 表示不向下传思考级别，交由下层默认处理。
										undefined
									: // 否则采用回调给出的具体思考级别，例如 high。
										nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				// 只有之前没取到插话才再取一次，避免 one-at-a-time 模式一次误取两条。
				if (pendingMessages.length === 0) {
					// 检查用户是否在准备/压缩期间又输入了消息；也用于一轮工具执行后的插话检查。
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				// 开始一个模型回合：一次模型回答加上它要求执行的工具，算作这里的一轮 turn。
				await emit({ type: "turn_start" });
			}

			// Process prepared and queued messages before the next assistant response.
			// 把准备消息与插话合并，并补齐工具变动声明，再逐条发布和加入上下文。
			for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
				// 告诉外部这条消息开始了；message 是 message: message 的简写。
				await emit({ type: "message_start", message });
				// 完整消息就绪。Agent 更新历史，会话层处理保存；流式的中间片段不会逐片写成完整消息。
				await emit({ type: "message_end", message });
				// 给下一次模型请求追加这条消息。push 会修改当前数组。
				currentContext.messages.push(message);
				// 同时记入这次运行的新增消息列表，供 agent_end 等事件使用。
				newMessages.push(message);
			}
			// 这一批排队消息已经消费完，清空本轮局部列表，防止重复发送。
			pendingMessages = [];

			// 每次请求前最后刷新一次请求快照。会话层在这里从会话记录投影出当前真正应发送的历史。
			const requestUpdate = await config.prepareRequest?.(
				{
					// 把当前消息和工具传给回调；context 指当前请求上下文，不是单独一段 system 字符串。
					context: currentContext,
					// 当前准备使用的模型对象，包括 provider、id、上下文窗口等元数据。
					model: config.model,
					// 把没有设置的 reasoning 显式表示为 off，方便会话层统一处理。
					thinkingLevel: config.reasoning ?? "off",
				},
				// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
				signal,
			);
			// 回调确实提供请求更新时才应用；普通回调允许返回 undefined。
			if (requestUpdate) {
				// 使用最终请求上下文；这一步不会自动把原始会话日志删掉。
				currentContext = requestUpdate.context ?? currentContext;
				// 创建更新后的配置对象；保留其余选项，只覆盖这次明确改变的字段。
				config = {
					// 沿用原配置；这是浅层展开，不会递归复制消息或工具。
					...config,
					// 本次请求可能被路由到另一物理模型，配置随之更新。
					model: requestUpdate.model ?? config.model,
					// 下面的条件表达式决定本次请求的思考级别。
					reasoning:
						// 未指定新的思考级别时保持原值。
						requestUpdate.thinkingLevel === undefined
							? // 条件为真时保留已有思考设置；? 和后面的 : 是三元表达式的两条分支。
								config.reasoning
							: // 区分“没改设置”和“明确关闭”，两者不能混成一种情况。
								requestUpdate.thinkingLevel === "off"
								? // 这里用 undefined 表示不向下传思考级别，交由下层默认处理。
									undefined
								: // 采用请求回调给出的新思考级别。
									requestUpdate.thinkingLevel,
				};
			}

			// Stream assistant response
			// 真正请求模型并读完流；返回一条完整 assistant 消息，可能是文字，也可能带 toolCall。
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			// 同时记入这次运行的新增消息列表，供 agent_end 等事件使用。
			newMessages.push(message);

			// 模型报错或用户取消时结束当前低层运行；外层 AgentSession 仍可能按策略重试。
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				// 组装刚结束的回合快照，供 finishTurn 和下一回合准备函数使用。
				lastCompletedTurn = {
					// 对象字段简写：把当前 message 变量放进同名字段。这里是一条消息，不是整段对话。
					message,
					// 失败回合没有在这条路径执行工具，结果列表为空。
					toolResults: [],
					// 把当前消息和工具传给回调；context 指当前请求上下文，不是单独一段 system 字符串。
					context: currentContext,
					// 当前运行新增消息的集合，包含用户输入、模型输出和工具结果。
					newMessages,
				};
				// 即使报错，也给回合结束回调一次收尾机会。
				await config.finishTurn?.(lastCompletedTurn, signal);
				// 发布失败回合结束事件；这一回合没有执行出的工具结果。
				await emit({ type: "turn_end", message, toolResults: [] });
				// 低层循环不再产生新事件。注意：会话的重试、压缩和 agent_settled 仍可能在后面。
				await emit({ type: "agent_end", messages: newMessages });
				// 结束当前函数，已发布的消息/事件仍然存在；不会回滚此前工具副作用。
				return;
			}

			// Check for tool calls
			// 从内容块中挑出工具请求，例如 {name:"read", arguments:{path:"decision.txt"}}；普通文字不执行。
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			// 准备收集这一回合的工具结果消息，随后交给下一次模型请求。
			const toolResults: ToolResultMessage[] = [];
			// 先假设本轮结束；发现并处理工具调用后才决定要不要再请求模型。
			hasMoreToolCalls = false;
			// 模型确实请求了工具才进入执行分支；模型只输出文字时跳过。
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				// 一条 assistant 消息可以包含多次工具调用，这里统一得到整批结果。
				const executedToolBatch =
					// 如果输出因长度限制被截断，工具参数可能只写了一半，不能直接执行。
					message.stopReason === "length"
						? // 给这些工具调用生成失败结果，让模型有机会重新提供完整参数。
							await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: // 正常情况进入工具管线：查找工具、校验参数、前置钩子、执行、后置钩子。
							await executeToolCalls(currentContext, message, config, signal, emit);
				// 把整批结果逐条放入 toolResults；这里 ... 展开数组，不会再嵌套一层数组。
				toolResults.push(...executedToolBatch.messages);
				// 只要这批工具没有一致要求终止，就再请求模型，让模型读取结果后继续回答。
				hasMoreToolCalls = !executedToolBatch.terminate;

				// 遍历已经执行完的工具结果；结果顺序与模型发出的调用顺序对应。
				for (const result of toolResults) {
					// 把 read 读到的内容加入模型上下文；下一次请求才能“看见文件”。
					currentContext.messages.push(result);
					// 这也是本次运行新增的消息，所以同步加入返回/结束事件使用的列表。
					newMessages.push(result);
				}
			}

			// 组装刚结束的回合快照，供 finishTurn 和下一回合准备函数使用。
			lastCompletedTurn = {
				// 对象字段简写：把当前 message 变量放进同名字段。这里是一条消息，不是整段对话。
				message,
				// 把本回合全部工具结果放入快照或事件；没调用工具时就是空数组。
				toolResults,
				// 把当前消息和工具传给回调；context 指当前请求上下文，不是单独一段 system 字符串。
				context: currentContext,
				// 当前运行新增消息的集合，包含用户输入、模型输出和工具结果。
				newMessages,
			};
			// 回合结束后听取外部决策，例如扩展要求 end，或要求再走一轮 continue。
			const decision = await config.finishTurn?.(lastCompletedTurn, signal);
			// 这一轮模型输出与其工具执行都完成了；这不同于整个用户 query 完成。
			await emit({ type: "turn_end", message, toolResults });

			// 外部明确要求停止时结束；?. 使没有决策时读取 action 也安全。
			if (decision?.action === "end") {
				// 低层循环不再产生新事件。注意：会话的重试、压缩和 agent_settled 仍可能在后面。
				await emit({ type: "agent_end", messages: newMessages });
				// 结束当前函数，已发布的消息/事件仍然存在；不会回滚此前工具副作用。
				return;
			}

			// 记录扩展的继续要求；随后有自然的工具/插话后续时就不再额外补一轮。
			explicitContinuation = decision?.action === "continue";
			// 检查用户是否在准备/压缩期间又输入了消息；也用于一轮工具执行后的插话检查。
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			// 已经因工具或插话要继续了，就不用再单独兑现一次额外 continuation。
			if (hasMoreToolCalls || pendingMessages.length > 0) {
				// 清掉额外继续标记，避免为同一次继续要求多请求一次模型。
				explicitContinuation = false;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		// 内层自然停止后才取 follow-up；例如用户说“做完当前任务再总结”。
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		// 有排队追问，就回到外层循环，让它成为下一次请求的输入。
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			// 清掉额外继续标记，避免为同一次继续要求多请求一次模型。
			explicitContinuation = false;
			// 把 follow-up 转成下一轮待处理消息，复用同一套消息发布逻辑。
			pendingMessages = followUpMessages;
			// 跳到当前循环的下一轮；不会递归调用用户的 prompt()。
			continue;
		}

		// No natural request was selected, so fulfill the continuation decision with one context-only turn.
		// 没有工具/插话/追问，但扩展明确要求继续时，再用现有上下文走一轮。
		if (explicitContinuation) {
			// 清掉额外继续标记，避免为同一次继续要求多请求一次模型。
			explicitContinuation = false;
			// 跳到当前循环的下一轮；不会递归调用用户的 prompt()。
			continue;
		}

		// No more messages, exit
		// 没有工具、插话、追问或显式继续要求，退出外层 while，随后发布 agent_end。
		break;
	}

	// 低层循环不再产生新事件。注意：会话的重试、压缩和 agent_settled 仍可能在后面。
	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Declare tool loadout changes to the model.
 *
 * `context.tools` is what the runtime can execute; the transcript's system messages declare
 * what the model may call. Before each request the difference becomes `toolsAdded` and
 * `toolsRemoved` on a system message. When a pending system message exists, its tool fields
 * are treated as intent and replaced with the delta between the committed transcript and
 * the executable set, so replay always yields exactly `context.tools`. Otherwise a new
 * system message is inserted before the first non-system pending message.
 */
/**
 * 比较历史中声明的工具与当前实际可执行工具，生成 toolsAdded/toolsRemoved，合进待发 system 或插入新 system。
 * 返回待发消息数组，复用未变化对象；不执行工具。例：原来只有 read，运行时启用 bash，下一次请求先声明 bash 新增。
 */
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	// 找本次新消息里最后一条 system，优先把工具差异合进去，避免多造一条系统消息。
	let systemIndex = -1;
	// 从后往前找，i-- 每次减一。
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		// role 是消息角色，此处只找系统配置。
		if (pendingMessages[i].role === "system") {
			// 保存下标，后面只替换这个位置的消息。
			systemIndex = i;
			// 找到后立即结束扫描。
			break;
		}
	}
	// 未找到时下标是 -1，取值得到 undefined；找到时角色已在上面确认。
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	// 先移除待发 system 自己携带的工具变化，按实际可执行工具重新计算。
	const baseline = pending
		? // 有待发 system 时逐条映射，下面只在 systemIndex 对应位置替换工具字段。
			pendingMessages.map((message, index) =>
				// 三元表达式：目标 system 去掉旧工具变化，其他消息对象直接复用。
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: // 没有待发 system 时沿用新消息数组作为基线。
			pendingMessages;
	// 比较“历史声明了什么工具”与“当前真能执行什么工具”，得到新增和移除列表。
	const changes = getToolStateChanges(
		// 重放旧历史和本次消息，取得模型已被告知的工具。
		getCurrentTools([...context.messages, ...baseline]),
		// 模型只接收工具声明，不接收本机 execute 函数。
		(context.tools ?? []).map(toToolDeclaration),
	);
	// 新增和移除都为空，才算没有变化。
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	// 有现成的 system，就把工具差异写回原位置。
	if (pending) {
		// Keep the caller's message object when it already declares no tool changes.
		// 确实无需改变时，复用原对象/数组。
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return pendingMessages;
		// map 返回新数组，只替换目标 system，其他消息对象仍复用。
		return baseline.map((message, index) => (index === systemIndex ? withToolChanges(pending, changes) : message));
	}
	// 没有 system 且工具未变，直接保持原消息。
	if (unchanged) return pendingMessages;
	// 工具变了就补 system；正文为空，变更在 toolsAdded/toolsRemoved 字段中。
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	// 工具声明应放在本次第一条用户/其他非系统消息前面。
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	// 若全是 system，就追加在这一批末尾。
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	// 用数组展开拼成“前半段 + 工具更新 + 后半段”。
	return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

// 表示“不增加也不移除工具”的差异对象，用于计算待发 system 的基线。
const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
/**
 * 复制 system 消息并替换工具差异字段，空数组省略对应字段；不改原消息、不发送请求。
 * 第二参数是对象解构。例：移除旧 toolsAdded，再放入本次新声明，content/sections/timestamp 保持。
 */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	// 取走旧工具字段，...rest 留住正文、提示词章节、时间等其他字段。
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	// 返回新的 system 对象，保留非工具字段，下面只条件添加非空工具差异。
	return {
		// 保留非工具字段。
		...rest,
		// 有新增才生成该字段；空数组时展开空对象。
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		// 移除工具同理，避免保存无意义的空变更。
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
// 模型调用边界。先整理消息，再调用注入的 streamFn，最后把零碎流事件拼成完整回答。
/**
 * 模型调用边界：先变换/转换消息，规范化上下文并解析凭证，再调用注入模型函数，消费流并发布消息事件。
 * 返回一条完整 assistant，可能带 toolCall；会追加/替换上下文里的草稿并等待 emit，工具执行不在这里发生。
 * 例：先收到“使用”，后收到“ TypeScript”，外部见多次 message_update，最终历史只放一条完整消息。
 */
async function streamAssistantResponse(
	// 已有历史与当前可执行工具。循环会基于它准备模型请求，不把 execute 直接发送给模型。
	context: AgentContext,
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 实际模型函数，上层已经解析显式传入值或兼容默认函数。
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	// 先取 Agent 消息历史；里面可能有扩展自定义消息，尚不能直接发给供应商。
	let messages = context.messages;
	// 如果安装了上下文变换回调，先让它处理消息，例如过滤请求中的工具声明。
	if (config.transformContext) {
		// 等待扩展/会话投影完成；本函数不会据此自动改写原始历史日志。
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	// 转成模型接口认识的消息类型，例如把 custom 消息转换成 user。它不是发 HTTP 请求。
	const llmMessages = await config.convertToLlm(messages);

	// 整理出规范的模型上下文，供不同供应商使用；仍未开始网络请求。
	const llmContext = normalizeContext({ messages: llmMessages });

	// Resolve API key (important for expiring tokens)
	// 在真正请求前解析凭证；过期令牌可能需要刷新，不能永久固定为初始化时的值。
	const resolvedApiKey =
		// 优先调用 getApiKey 回调；没有有效返回值时退回显式 apiKey。
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// 调用注入的模型函数。生产 SDK 注入的函数在 sdk.ts，随后进入 ModelRuntime；离线示例注入 faux。
	const response = await streamFunction(config.model, llmContext, {
		// 沿用原配置；这是浅层展开，不会递归复制消息或工具。
		...config,
		// 传入刚解析的认证凭证；该值只供请求函数使用，不应写入日志。
		apiKey: resolvedApiKey,
		// 合并请求身份信息，用于供应商归因等请求元数据，不是聊天历史。
		identity: mergeClientIdentity(DEFAULT_AGENT_IDENTITY, config.identity),
		// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
		signal,
	});
	// Record the requested level, whichever stream function answered.
	// 定义一个稍后才调用的 async 函数：等待最终消息，再记录本次请求的思考级别。定义函数本身不会立即调用它。
	const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

	// 当前流式回答草稿，尚未收到 start 时是 null。
	let partialMessage: AssistantMessage | null = null;
	// 标记草稿是否已经放进上下文；最终消息需要替换它，不能再重复追加。
	let addedPartial = false;

	// 异步迭代模型流：每来一小块就处理一小块，例如先收到“项目”，再收到“采用 TypeScript”。
	for await (const event of response) {
		// 按事件的 type 分派；TypeScript 会据此知道这个分支有哪些字段。
		switch (event.type) {
			// 模型开始生成这一条 assistant 消息。
			case "start":
				// 取得目前累计的完整草稿；partial 不只是这次新增的几个字符。
				partialMessage = event.partial;
				// 给正在生成的回答占一个历史位置，后续增量更新这个位置。
				context.messages.push(partialMessage);
				// 记住已经占位，最终完成时应替换，而非再 append 一条重复消息。
				addedPartial = true;
				// 向 Agent/UI 发布消息开始事件；浅拷贝草稿对象作为事件内容。
				await emit({ type: "message_start", message: { ...partialMessage } });
				// 本次 start/增量事件已经处理，退出 switch 继续读取下一个流事件；不会在这里执行工具。
				break;

			// 文字块开始；这些相邻 case 共用下面同一段更新逻辑。
			case "text_start":
			// 文字增量到达；delta 是新增片段，event.partial 是累计后的草稿。
			case "text_delta":
			// 当前文字块结束；整个 assistant 消息仍可能有其他内容块。
			case "text_end":
			// 模型思考块开始；是否能看到它取决于供应商与模型。
			case "thinking_start":
			// 思考内容的增量事件；同样更新草稿并通知订阅者。
			case "thinking_delta":
			// 当前思考块结束；不等于 Agent 工作结束。
			case "thinking_end":
			// 模型开始生成工具调用；此时参数可能尚不完整，不能马上执行工具。
			case "toolcall_start":
			// 工具名/参数的流片段到达，先更新展示，不在这里执行 read。
			case "toolcall_delta":
			// 某个工具调用块结束；要等完整 assistant 消息完成后统一进入工具管线。
			case "toolcall_end":
				// 只有已经建立草稿时才更新；正常流从 start 开始。
				if (partialMessage) {
					// 取得目前累计的完整草稿；partial 不只是这次新增的几个字符。
					partialMessage = event.partial;
					// 替换草稿所在的最后一个位置，避免把每个文字片段都变成独立历史消息。
					context.messages[context.messages.length - 1] = partialMessage;
					// 异步发布事件；先让 Agent 状态和订阅者处理完，再推进当前流程。
					await emit({
						// 这是流式更新事件，通常供 UI 实时展示，不表示完整消息已经保存。
						type: "message_update",
						// 附带供应商无关的原始增量事件，例如 text_delta。
						assistantMessageEvent: event,
						// 同时附上当前累计草稿，订阅者无需自己重新拼接所有字符。
						message: { ...partialMessage },
					});
				}
				// 本次 start/增量事件已经处理，退出 switch 继续读取下一个流事件；不会在这里执行工具。
				break;

			// 供应商正常结束这一条消息。
			case "done":
			// 供应商用错误事件结束；仍通过最终 AssistantMessage 表达错误和 usage。
			case "error": {
				// 取得最终 assistant 消息，包含文本/工具调用、停止原因、token 用量等。
				const finalMessage = await result();
				// 有草稿占位时替换它；否则需要直接追加最终消息。
				if (addedPartial) {
					// 用完整结果替掉草稿，保留相同历史位置。
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					// 没有流式占位的路径直接追加完整消息。
					context.messages.push(finalMessage);
				}
				// ! 表示取反：此前没发布过 start，就在发布 end 前补上 start。
				if (!addedPartial) {
					// 为没有草稿的路径补消息开始事件，保持外部观察到的生命周期完整。
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				// 完整回答交给 Agent 和会话层；会话层在此事件处理中保存 assistant 消息。
				await emit({ type: "message_end", message: finalMessage });
				// 把这一条完整回答还给 runLoop；runLoop 再判断其中有没有工具请求。
				return finalMessage;
			}
		}
	}

	// 取得最终 assistant 消息，包含文本/工具调用、停止原因、token 用量等。
	const finalMessage = await result();
	// 有草稿占位时替换它；否则需要直接追加最终消息。
	if (addedPartial) {
		// 用完整结果替掉草稿，保留相同历史位置。
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		// 没有流式占位的路径直接追加完整消息。
		context.messages.push(finalMessage);
		// 为没有草稿的路径补消息开始事件，保持外部观察到的生命周期完整。
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	// 完整回答交给 Agent 和会话层；会话层在此事件处理中保存 assistant 消息。
	await emit({ type: "message_end", message: finalMessage });
	// 把这一条完整回答还给 runLoop；runLoop 再判断其中有没有工具请求。
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
/**
 * 模型输出被 token 上限截断时，把本条所有工具调用转换为失败结果，完全不执行这些可能缺参数的调用。
 * 返回结果消息批次并发布配对事件，terminate:false 允许模型修正重发。例：只生成了一半 edit 参数时不能贸然写文件。
 */
async function failToolCallsFromTruncatedMessage(
	// 模型这一条 assistant 回答中的所有工具请求，按内容块出现顺序排列。
	toolCalls: AgentToolCall[],
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 返回本批的工具结果消息与是否终止自动续轮；不是只返回工具正文。
): Promise<ExecutedToolCallBatch> {
	// 收集本批将写入模型对话的 toolResult 消息。
	const messages: ToolResultMessage[] = [];
	// 按模型给出的顺序遍历调用；例如 read(a.txt)、read(b.txt)。
	for (const toolCall of toolCalls) {
		// 异步发布事件；先让 Agent 状态和订阅者处理完，再推进当前流程。
		await emit({
			// 发布被截断调用的工具开始事件以保持生命周期配对；这条分支随后直接生成失败结果，不执行工具。
			type: "tool_execution_start",
			// 调用的唯一 id；结果必须带同一 id，模型才能把请求与结果配对。
			toolCallId: toolCall.id,
			// 工具名字，例如 read；它用来查找已经注册的本地实现。
			toolName: toolCall.name,
			// 保留可能被截断的原始参数供事件展示；此分支不会继续参数校验或执行。
			args: toolCall.arguments,
		});
		// 为未执行的调用构造最终失败结果，仍保留原调用以维持请求/结果配对。
		const finalized: FinalizedToolCallOutcome = {
			// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
			toolCall,
			// 生成模型可见错误文字；截断调用不会进入 execute 或参数前置钩子。
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
			isError: true,
		};
		// 发布工具执行结束事件；它和写入模型历史的 toolResult 消息是两件事。
		await emitToolExecutionEnd(finalized, emit);
		// 把执行结果包装成 role:toolResult 的对话消息，不再是任意工具返回对象。
		const toolResultMessage = createToolResultMessage(finalized);
		// 发布工具结果的 message_start/end；会话订阅者在 end 处理中保存它。
		await emitToolResultMessage(toolResultMessage, emit);
		// 将结果加入本批返回值；runLoop 之后也会把它追加到请求上下文。
		messages.push(toolResultMessage);
	}
	// 让模型有机会下一轮重发完整调用，而不是因这批被截断的参数永久终止。
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
// 工具分发入口。模型给的是调用声明，执行哪些本地函数由 Pi 在这里决定。
/**
 * 从完整 assistant 取出工具调用并选择串行/并行策略，返回本批结果消息和终止决定。
 * 全局 sequential 或任一工具要求 sequential 都走串行；否则顺序准备、并行执行。例：多个只读调用可并行，需顺序的工具改变整批策略。
 */
async function executeToolCalls(
	// 当前回合消息与可执行工具，提供给查工具和钩子判断。
	currentContext: AgentContext,
	// 发出本批工具调用的完整 assistant 消息，不是草稿片段。
	assistantMessage: AssistantMessage,
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 返回本批的工具结果消息与是否终止自动续轮；不是只返回工具正文。
): Promise<ExecutedToolCallBatch> {
	// 只拿工具调用块；同一条回答中的解释文字不会当作代码执行。
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	// 只要本批任意一个工具要求串行，这整批就按串行策略执行。
	const hasSequentialToolCall = toolCalls.some(
		// 按工具名查实现，再看 executionMode。例如有依赖顺序的工具不能随意并发。
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	// 全局设置要求串行，或有工具要求串行时，走逐个等待的分支。
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		// 串行：完成第一个工具及后处理后，再准备/执行下一个。
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	// 默认并行：先顺序做前置检查，再并发执行，最后按原始调用顺序收集结果。
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

// 工具批次结果的内部类型：把多条结果和批次调度决定放一起。
type ExecutedToolCallBatch = {
	// 每个已安排调用对应一条结果消息，后面会追加到下一次模型请求上下文。
	messages: ToolResultMessage[];
	// true 表示本批一致要求结束；false 允许模型拿结果后再继续。
	terminate: boolean;
};

/**
 * 按模型给的顺序逐个准备、执行、后处理、发工具结束及结果消息；前一个完整收尾后才开始下一个。
 * 返回按顺序的结果批次；取消后不再安排后续调用。例：第一个工具失败仍可把失败结果配对发出，是否整体结束看批次规则。
 */
async function executeToolCallsSequential(
	// 当前回合消息与可执行工具，提供给查工具和钩子判断。
	currentContext: AgentContext,
	// 发出本批工具调用的完整 assistant 消息，不是草稿片段。
	assistantMessage: AssistantMessage,
	// 模型这一条 assistant 回答中的所有工具请求，按内容块出现顺序排列。
	toolCalls: AgentToolCall[],
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 返回本批的工具结果消息与是否终止自动续轮；不是只返回工具正文。
): Promise<ExecutedToolCallBatch> {
	// 按执行顺序收集最终结果，之后判断是不是每个调用都要求 terminate。
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	// 收集本批将写入模型对话的 toolResult 消息。
	const messages: ToolResultMessage[] = [];

	// 按模型给出的顺序遍历调用；例如 read(a.txt)、read(b.txt)。
	for (const toolCall of toolCalls) {
		// 异步发布事件；先让 Agent 状态和订阅者处理完，再推进当前流程。
		await emit({
			// 通知外部工具管线开始；参数校验或权限钩子仍可能让这次调用直接失败。
			type: "tool_execution_start",
			// 调用的唯一 id；结果必须带同一 id，模型才能把请求与结果配对。
			toolCallId: toolCall.id,
			// 工具名字，例如 read；它用来查找已经注册的本地实现。
			toolName: toolCall.name,
			// 模型发来的原始参数，例如 {path:"decision.txt"}；后面还要校验。
			args: toolCall.arguments,
		});

		// 先查工具、准备参数、按 schema 校验，再跑 beforeToolCall；此处尚未真正读文件。
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		// 两条准备分支都会给出最终结果：立即失败，或真正执行并后处理；let 允许分支赋值。
		let finalized: FinalizedToolCallOutcome;
		// kind 是联合类型的分辨字段；immediate 表示已有最终失败/阻止结果，跳过实际执行。
		if (preparation.kind === "immediate") {
			// 准备阶段已有结果时直接包装，不再调用工具执行函数。
			finalized = {
				// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
				toolCall,
				// 直接采用准备阶段产生的结果，例如“工具不存在”或“调用被阻止”。
				result: preparation.result,
				// 带上失败标志；模型收到错误结果后可以修改参数再试。
				isError: preparation.isError,
			};
		} else {
			// 真正调用 tool.execute()；read 会在这里进入 read.ts 的文件读取逻辑。
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			// 等待后置钩子和结果合并结束后，才发布工具结束事件。
			finalized = await finalizeExecutedToolCall(
				// 传入本轮上下文，让工具钩子能看到当前对话与工具集合。
				currentContext,
				// 发起这些工具调用的那条 assistant 消息。
				assistantMessage,
				// 经过校验的工具、参数以及原始调用信息。
				preparation,
				// 执行得到的内容、错误标志和耗时。
				executed,
				// 沿用本次模型/工具/钩子配置，调度策略不藏在流包装器中。
				config,
				// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
				signal,
			);
		}

		// 发布工具执行结束事件；它和写入模型历史的 toolResult 消息是两件事。
		await emitToolExecutionEnd(finalized, emit);
		// 把执行结果包装成 role:toolResult 的对话消息，不再是任意工具返回对象。
		const toolResultMessage = createToolResultMessage(finalized);
		// 发布工具结果的 message_start/end；会话订阅者在 end 处理中保存它。
		await emitToolResultMessage(toolResultMessage, emit);
		// 把已经完成的调用结果放入列表，保持与原始工具调用相同的排列顺序。
		finalizedCalls.push(finalized);
		// 将结果加入本批返回值；runLoop 之后也会把它追加到请求上下文。
		messages.push(toolResultMessage);

		// 用户取消后停止继续安排工具；?. 允许调用方没有传入取消信号。
		if (signal?.aborted) {
			// 取消已发生，退出当前 for，不再继续安排后面的工具调用；已完成结果仍保留。
			break;
		}
	}

	// 交回按串行顺序收集的结果与批次终止决定；runLoop 会继续把这些结果加入模型上下文。
	return {
		// 把本批按原始调用顺序收集的工具消息交给外层 runLoop。
		messages,
		// 串行批次也遵守“非空且每个最终结果都要求终止”规则，单个工具要求终止不够。
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

// 默认的并行工具批次。即使本例只有一个 read，也会经过这个函数。
/**
 * 先按顺序做参数/策略准备，保存允许执行的异步任务，再一起启动；工具结束事件可按完成速度发，结果消息按原调用顺序发。
 * 返回工具结果批次；会等待工具和后置钩子。例：read(a) 比 read(b) 慢，也不会把 a/b 的 toolResult 历史顺序交换。
 */
async function executeToolCallsParallel(
	// 当前回合消息与可执行工具，提供给查工具和钩子判断。
	currentContext: AgentContext,
	// 发出本批工具调用的完整 assistant 消息，不是草稿片段。
	assistantMessage: AssistantMessage,
	// 模型这一条 assistant 回答中的所有工具请求，按内容块出现顺序排列。
	toolCalls: AgentToolCall[],
	// 模型、消息转换、工具钩子、回合调度和队列读取函数的配置。
	config: AgentLoopConfig,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 事件出口函数，允许返回 Promise；await 它能确保上层状态/保存完成才继续下一步。
	emit: AgentEventSink,
	// 返回本批的工具结果消息与是否终止自动续轮；不是只返回工具正文。
): Promise<ExecutedToolCallBatch> {
	// 列表中可以是已完成的结果，也可以是稍后才启动的异步函数；类型用联合类型表达两种情况。
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	// 按模型给出的顺序遍历调用；例如 read(a.txt)、read(b.txt)。
	for (const toolCall of toolCalls) {
		// 异步发布事件；先让 Agent 状态和订阅者处理完，再推进当前流程。
		await emit({
			// 通知外部工具管线开始；参数校验或权限钩子仍可能让这次调用直接失败。
			type: "tool_execution_start",
			// 调用的唯一 id；结果必须带同一 id，模型才能把请求与结果配对。
			toolCallId: toolCall.id,
			// 工具名字，例如 read；它用来查找已经注册的本地实现。
			toolName: toolCall.name,
			// 模型发来的原始参数，例如 {path:"decision.txt"}；后面还要校验。
			args: toolCall.arguments,
		});

		// 先查工具、准备参数、按 schema 校验，再跑 beforeToolCall；此处尚未真正读文件。
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		// kind 是联合类型的分辨字段；immediate 表示已有最终失败/阻止结果，跳过实际执行。
		if (preparation.kind === "immediate") {
			// 组装本次调用的最终结果对象，供事件和 toolResult 消息共用。
			const finalized = {
				// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
				toolCall,
				// 直接采用准备阶段产生的结果，例如“工具不存在”或“调用被阻止”。
				result: preparation.result,
				// 带上失败标志；模型收到错误结果后可以修改参数再试。
				isError: preparation.isError,
				// satisfies 只在类型检查时确认对象符合要求；运行时不会额外生成检查代码。
			} satisfies FinalizedToolCallOutcome;
			// 发布工具执行结束事件；它和写入模型历史的 toolResult 消息是两件事。
			await emitToolExecutionEnd(finalized, emit);
			// 把已经完成的调用结果放入列表，保持与原始工具调用相同的排列顺序。
			finalizedCalls.push(finalized);
			// 用户取消后停止继续安排工具；?. 允许调用方没有传入取消信号。
			if (signal?.aborted) {
				// 取消已发生，退出当前 for，不再继续安排后面的工具调用；已完成结果仍保留。
				break;
			}
			// 跳到当前循环的下一轮；不会递归调用用户的 prompt()。
			continue;
		}

		// 先存一个 async 函数，还没有运行它；后面 Promise.all 才会一起启动这些任务。
		finalizedCalls.push(async () => {
			// 用户取消后停止继续安排工具；?. 允许调用方没有传入取消信号。
			if (signal?.aborted) {
				// 组装本次调用的最终结果对象，供事件和 toolResult 消息共用。
				const finalized = {
					// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
					toolCall,
					// 取消也变成工具错误结果，让调用/结果的对应关系有明确终点。
					result: createErrorToolResult("Operation aborted"),
					// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
					isError: true,
					// satisfies 只在类型检查时确认对象符合要求；运行时不会额外生成检查代码。
				} satisfies FinalizedToolCallOutcome;
				// 发布工具执行结束事件；它和写入模型历史的 toolResult 消息是两件事。
				await emitToolExecutionEnd(finalized, emit);
				// 把已经收尾的单次工具结果返回给批次收集器。
				return finalized;
			}
			// 真正调用 tool.execute()；read 会在这里进入 read.ts 的文件读取逻辑。
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			// 执行完还要跑 afterToolCall；扩展可能修改结果，图片也会在会话钩子里归一化。
			const finalized = await finalizeExecutedToolCall(
				// 传入本轮上下文，让工具钩子能看到当前对话与工具集合。
				currentContext,
				// 发起这些工具调用的那条 assistant 消息。
				assistantMessage,
				// 经过校验的工具、参数以及原始调用信息。
				preparation,
				// 执行得到的内容、错误标志和耗时。
				executed,
				// 沿用本次模型/工具/钩子配置，调度策略不藏在流包装器中。
				config,
				// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
				signal,
			);
			// 发布工具执行结束事件；它和写入模型历史的 toolResult 消息是两件事。
			await emitToolExecutionEnd(finalized, emit);
			// 把已经收尾的单次工具结果返回给批次收集器。
			return finalized;
		});
		// 用户取消后停止继续安排工具；?. 允许调用方没有传入取消信号。
		if (signal?.aborted) {
			// 取消已发生，退出当前 for，不再继续安排后面的工具调用；已完成结果仍保留。
			break;
		}
	}

	// 并发启动并等待任务；Promise.all 返回结果的顺序跟输入一致，不按谁先跑完排序。
	const orderedFinalizedCalls = await Promise.all(
		// 函数项现在才执行；已经完成的对象转成已完成 Promise，统一交给 Promise.all。
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	// 收集本批将写入模型对话的 toolResult 消息。
	const messages: ToolResultMessage[] = [];
	// 工具可能并行完成，但这里按模型调用顺序逐条生成结果消息。
	for (const finalized of orderedFinalizedCalls) {
		// 把执行结果包装成 role:toolResult 的对话消息，不再是任意工具返回对象。
		const toolResultMessage = createToolResultMessage(finalized);
		// 发布工具结果的 message_start/end；会话订阅者在 end 处理中保存它。
		await emitToolResultMessage(toolResultMessage, emit);
		// 将结果加入本批返回值；runLoop 之后也会把它追加到请求上下文。
		messages.push(toolResultMessage);
	}

	// 交回按模型调用顺序排列的结果与终止决定；各工具完成快慢不会改变消息排列。
	return {
		// 把本批按原始调用顺序收集的工具消息交给外层 runLoop。
		messages,
		// 只有本批非空且每个结果都要求 terminate，才终止工具后的自动续轮。
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

// 联合类型的可执行分支：准备成功才有 tool 和已校验 args。
type PreparedToolCall = {
	// 字面量标签让 TS 在 if(kind === "prepared") 后知道可安全访问 tool。
	kind: "prepared";
	// 保留模型原始 id/name/arguments，便于事件和结果配对。
	toolCall: AgentToolCall;
	// 在注册列表找到的本地工具实现，里面的 execute 才真正干活。
	tool: AgentTool<any>;
	// 通用执行器不知道具体 schema 的静态参数形状；运行时已在准备阶段校验。
	args: unknown;
};

// 另一联合类型分支：找不到工具、参数错误、被策略阻止或取消时已有最终结果。
type ImmediateToolCallOutcome = {
	// 标签表示立即结果，没有可执行 tool，调用方不能再去执行。
	kind: "immediate";
	// 工具内容、详情和可选结构化输出；现有 any 兼容各种工具详情类型。
	result: AgentToolResult<any>;
	// 是否作为错误结果交给模型；与 Promise 是否成功 resolve 是两个维度。
	isError: boolean;
};

// 真实执行阶段的结果，还未经过 afterToolCall 最终覆盖。
type ExecutedToolCallOutcome = {
	// 工具内容、详情和可选结构化输出；现有 any 兼容各种工具详情类型。
	result: AgentToolResult<any>;
	// 是否作为错误结果交给模型；与 Promise 是否成功 resolve 是两个维度。
	isError: boolean;
	// 用单调时钟测得的 execute 阶段耗时，单位毫秒。
	durationMs: number;
};

// 内部名字复用对外结果结构，没有另生成一种运行时包装类。
type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link AgentLoopConfig}. */
// Pick 只选前后工具钩子，允许嵌套工具调用复用这条管线而不需要整个循环配置。
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">;

// 进度接收函数可以同步处理，也可以异步处理；执行器会等待已经接收的更新任务。
type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

// 并行批次列表可存已完成对象，也可存稍后才运行的异步函数；写入函数并不会立即启动工具。
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * 纯判断：批次非空且每个最终结果都显式 terminate:true 才返回 true，不修改结果。
 * 例：[true,true] 结束，[true,undefined] 不结束，[] 也不结束，避免空集合 every 为 true 产生误判。
 */
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	// 先排除空批次，再要求 every 一致为 true。例：两工具只有一个 terminate:true，仍不整体终止。
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

/**
 * 可选地先调用工具的输入适配器；没适配器或返回同一参数引用则复用原调用，否则浅复制调用并替换 arguments。
 * 本函数不做 schema 验证，失败抛给外层准备函数。例：把工具支持的旧参数别名整理成正式字段。
 */
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	// 工具没有输入适配器时保留模型的原始参数，后面仍会做 schema 验证。
	if (!tool.prepareArguments) {
		// 原对象无需改变就复用，避免制造内容相同的新调用对象。
		return toolCall;
	}
	// 同步调用工具自己的参数整理函数；如它抛错，prepareToolCall 的 catch 会形成工具失败结果。
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	// 适配器返回相同参数引用表示不需重新包装工具调用。
	if (preparedArguments === toolCall.arguments) {
		// 原对象无需改变就复用，避免制造内容相同的新调用对象。
		return toolCall;
	}
	// 创建替换参数后的新调用对象；不会改变原 toolCall 的 id/name，也不会在这里执行工具。
	return {
		// 保留调用 id/name 等其他字段，下面只替换 arguments。
		...toolCall,
		// as 是适配异构工具参数的静态断言，不做 JSON 校验；正式验证紧接着在 prepareToolCall 执行。
		arguments: preparedArguments as Record<string, any>,
	};
}

// 工具执行前的关口。模型输出属于外部输入，TypeScript 类型不能替代这里的参数校验。
/**
 * 单次调用前置管线：按名字找工具 → 可选参数适配 → schema 校验 → beforeToolCall → 取消检查。
 * 返回带 kind 标签的可执行调用或立即失败结果；不执行工具。例：read 的 path 不是字符串时返回错误结果，让模型修正。
 */
async function prepareToolCall(
	// 当前回合消息与可执行工具，提供给查工具和钩子判断。
	currentContext: AgentContext,
	// 发出本批工具调用的完整 assistant 消息，不是草稿片段。
	assistantMessage: AssistantMessage,
	// 当前单次工具调用的 id/name/arguments；不同于整条含多个调用的 assistantMessage。
	toolCall: AgentToolCall,
	// 只需要工具前置与后置策略，不需要完整模型配置。
	config: ToolCallHooks,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 可显式给出查找范围；默认用当前工具，没工具则空列表。readonly 限制本函数不能修改输入数组。
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	// 在可用工具中按 name 找实现。模型不能凭空发明一个名字就获得任意本地能力。
	const tool = tools.find((t) => t.name === toolCall.name);
	// 没有对应工具，就给模型返回“工具不存在”，不执行任何文件操作。
	if (!tool) {
		// 用 kind 标记本准备分支的结果；调用方据此区分立即返回与允许执行，不靠猜测字段形状。
		return {
			// 标记这条调用已经得出结果，调用方不应继续执行工具。
			kind: "immediate",
			// 把找不到工具的原因变成文字，下一轮模型就能看到失败原因。
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
			isError: true,
		};
	}

	// 捕获参数适配、schema 校验和前置钩子的异常，转换成 immediate 失败结果；真正 execute 不在本段。
	try {
		// 工具可先兼容/整理输入形状，例如把别名参数转成正式参数名；不是所有工具都有这步。
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		// 按工具的 schema 校验和转换参数。例如 read 的 path 必须是字符串；失败会进入 catch。
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		// 如果安装了工具前置钩子，允许扩展在真正执行前阻止本次调用。
		if (config.beforeToolCall) {
			// 等待前置钩子决定，例如权限扩展拒绝读取某个文件。
			const beforeResult = await config.beforeToolCall(
				{
					// 发起这些工具调用的那条 assistant 消息。
					assistantMessage,
					// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
					toolCall,
					// 交给钩子/执行器的是已校验参数，不是未经校验的原始 JSON。
					args: validatedArgs,
					// 把当前消息和工具传给回调；context 指当前请求上下文，不是单独一段 system 字符串。
					context: currentContext,
				},
				// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
				signal,
			);
			// 用户取消后停止继续安排工具；?. 允许调用方没有传入取消信号。
			if (signal?.aborted) {
				// 用 kind 标记本准备分支的结果；调用方据此区分立即返回与允许执行，不靠猜测字段形状。
				return {
					// 标记这条调用已经得出结果，调用方不应继续执行工具。
					kind: "immediate",
					// 取消也变成工具错误结果，让调用/结果的对应关系有明确终点。
					result: createErrorToolResult("Operation aborted"),
					// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
					isError: true,
				};
			}
			// 扩展要求阻止时，直接形成失败结果，read.execute 不会被调用。
			if (beforeResult?.block) {
				// 优先把扩展提供的阻止原因告诉模型，没有原因则使用默认文字。
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				// 有的阻止还明确要求停止自动后续请求，额外记录 terminate。
				if (beforeResult.terminate === true) {
					// 把终止要求写到结果；批次是否整体终止由所有调用结果共同决定。
					result.terminate = true;
				}
				// 用 kind 标记本准备分支的结果；调用方据此区分立即返回与允许执行，不靠猜测字段形状。
				return {
					// 标记这条调用已经得出结果，调用方不应继续执行工具。
					kind: "immediate",
					// 携带工具返回的内容/详情等；注意它与 role:toolResult 的消息包装不同。
					result,
					// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
					isError: true,
				};
			}
		}
		// 用户取消后停止继续安排工具；?. 允许调用方没有传入取消信号。
		if (signal?.aborted) {
			// 用 kind 标记本准备分支的结果；调用方据此区分立即返回与允许执行，不靠猜测字段形状。
			return {
				// 标记这条调用已经得出结果，调用方不应继续执行工具。
				kind: "immediate",
				// 取消也变成工具错误结果，让调用/结果的对应关系有明确终点。
				result: createErrorToolResult("Operation aborted"),
				// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
				isError: true,
			};
		}
		// 用 kind 标记本准备分支的结果；调用方据此区分立即返回与允许执行，不靠猜测字段形状。
		return {
			// 另一种联合类型分支：工具已找到、参数校验通过，可以进入实际执行。
			kind: "prepared",
			// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
			toolCall,
			// 带上查到的工具对象，其中 execute 才是实际工作的本地函数。
			tool,
			// 交给钩子/执行器的是已校验参数，不是未经校验的原始 JSON。
			args: validatedArgs,
		};
		// 捕获本阶段抛出的异常，把它转为工具结果；具体是否重试由后续模型/会话策略决定。
	} catch (error) {
		// 用 kind 标记本准备分支的结果；调用方据此区分立即返回与允许执行，不靠猜测字段形状。
		return {
			// 标记这条调用已经得出结果，调用方不应继续执行工具。
			kind: "immediate",
			// 异常可能不是 Error；在这个外部错误边界统一取出可读文字。
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
			isError: true,
		};
	}
}

/**
 * 创建单工具的进度转发函数，闭包保存 id/name/原参数；调用返回函数时才发 tool_execution_update。
 * 不发最终消息、不执行工具。例：bash 上报一段 stdout，UI 可按 id 把它归到正确工具。
 */
function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	// 返回一段稍后调用的函数：工具上报进度时补齐工具 id/name 并交给事件出口。
	return (partialResult) =>
		emit({
			// 这是工具进度事件，不是模型文字的 message_update。
			type: "tool_execution_update",
			// 调用的唯一 id；结果必须带同一 id，模型才能把请求与结果配对。
			toolCallId: toolCall.id,
			// 工具名字，例如 read；它用来查找已经注册的本地实现。
			toolName: toolCall.name,
			// 展示当初模型发来的参数；这是执行中的进度事件，校验已在执行前完成。
			args: toolCall.arguments,
			// 把本次进度结果交给订阅者，不在这里追加为最终 toolResult 消息。
			partialResult,
		});
}

/** Options for {@link runToolCall}. */
// 嵌套/程序化单工具调用选项，继承相同前后钩子，确保不能绕过统一检查路径。
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	// 明确可查找的工具集合，不能按任意名字执行未授权注册的函数。
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	// 提供“是谁发起调用”的模型消息，钩子使用同一上下文协议。
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	// 给钩子看的当前运行上下文。
	context: AgentContext;
	// 可选取消信号，执行与钩子都沿用它。
	signal?: AbortSignal;
	// 可选工具进度回调，不自动发布完整 Agent 消息事件。
	onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
/**
 * 程序化/嵌套调用复用同一工具管线：准备、校验、前置钩子、执行、后置钩子；不自行发 Agent 事件或追加历史。
 * 返回最终结果，普通工具失败转成 isError:true。例：外层工具通过 ctx 调另一个工具，也不应绕过策略钩子。
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	// 对象解构取出常用字段；保持原对象引用，不深复制历史。
	const { assistantMessage, context, signal } = options;
	// 同模型工具调用一样先适配参数、schema 校验和 beforeToolCall；显式使用 options.tools 范围。
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
	// kind 是联合类型的分辨字段；immediate 表示已有最终失败/阻止结果，跳过实际执行。
	if (preparation.kind === "immediate") {
		// 准备阶段已失败/阻止就直接返回结果，不执行工具也不发消息事件。
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	// 真正调用工具；没进度回调时用空函数，仍沿用统一的执行/异常处理。
	const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
	// 再走 afterToolCall 并返回最终结果；此入口不修改消息数组，也不自行发 Agent 生命周期事件。
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

// 实际执行单个工具。核心就是 await prepared.tool.execute(...)。
/**
 * 真正调用准备好的 tool.execute，接收进度并等待已经发出的进度接收任务，测量 execute 耗时。
 * 返回原始执行结果、错误标志和耗时；工具抛错转换成错误内容，结束后不再接收迟到更新。例：read 在这里进入文件 API。
 */
async function executePreparedToolCall(
	// 只有准备成功分支能传进来，包含可执行工具和已校验参数。
	prepared: PreparedToolCall,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 执行期间的进度出口，接收器可以异步，收尾前要等已发更新完成。
	onUpdate: ToolUpdateSink,
	// 返回执行内容/错误标志/耗时；后置钩子随后还可能覆盖它。
): Promise<ExecutedToolCallOutcome> {
	// 保存执行期间发布的增量结果任务，结束前要等这些通知处理完。
	const updateEvents: Promise<void>[] = [];
	// 只在工具执行期间接受进度更新，结束后迟到的更新不再加入。
	let acceptingUpdates = true;
	// 记录开始时间，只用于计算工具耗时，不是模型 token 用量。
	const startedAt = performance.now();
	// 箭头函数：调用时计算经过的毫秒数，Math.round 将结果四舍五入。
	const elapsed = () => Math.round(performance.now() - startedAt);

	// 覆盖实际 execute 及进度收尾；工具抛错时转成统一失败结果，finally 仍会关闭进度入口。
	try {
		// 真正跨进具体工具实现。例如工具名为 read，就进入 createReadToolDefinition 返回的 execute。
		const result = await prepared.tool.execute(
			// 把调用 id 交给工具，便于进度事件或嵌套调用关联。
			prepared.toolCall.id,
			// 运行时参数已由 schema 校验；这里的类型断言处理异构工具签名，不会把值转换成另一种东西。
			prepared.args as never,
			// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
			signal,
			// 把函数当参数传给工具：工具需要报告进度时再调用这个回调。
			(partialResult) => {
				// 工具结束后来的进度不再接受，避免生命周期结束后继续出现更新。
				if (!acceptingUpdates) return;
				// 同步/异步的更新回调都统一包装成 Promise，结束时一起等完。
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			},
		);
		// 计算这次工具执行本身耗时，之后等待事件监听器的时间不加进这里。
		const durationMs = elapsed();
		// 工具已经完成或失败，关闭本次调用的增量结果入口。
		acceptingUpdates = false;
		// 确保执行中已发出的进度通知处理完，再发布最终结果。
		await Promise.all(updateEvents);
		// 成功 resolve 也可能返回 isError:true，所以不能只看有没有抛异常。
		return { result, isError: result.isError === true, durationMs };
		// 捕获本阶段抛出的异常，把它转为工具结果；具体是否重试由后续模型/会话策略决定。
	} catch (error) {
		// 计算这次工具执行本身耗时，之后等待事件监听器的时间不加进这里。
		const durationMs = elapsed();
		// 工具已经完成或失败，关闭本次调用的增量结果入口。
		acceptingUpdates = false;
		// 确保执行中已发出的进度通知处理完，再发布最终结果。
		await Promise.all(updateEvents);
		// 把本次执行异常包装成失败内容，并附已测量耗时；外层仍能正常配对工具结果。
		return {
			// 异常可能不是 Error；在这个外部错误边界统一取出可读文字。
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
			isError: true,
			// 在结果里记录耗时，供工具事件或最终消息展示使用。
			durationMs,
		};
		// 无论成功、异常还是 return，finally 都会执行清理逻辑。
	} finally {
		// 工具已经完成或失败，关闭本次调用的增量结果入口。
		acceptingUpdates = false;
	}
}

// 执行后的统一收尾，允许 afterToolCall 修改给模型看的结果。
/**
 * 将执行结果交给 afterToolCall，逐字段合并覆盖并处理 structuredContent 与 content 的一致性，返回最终结果。
 * 后置钩子失败也作为工具错误，不再发给模型原来的成功结果。例：扩展替换了正文却未提供结构化内容时删掉旧结构化值。
 */
async function finalizeExecutedToolCall(
	// 当前回合消息与可执行工具，提供给查工具和钩子判断。
	currentContext: AgentContext,
	// 发出本批工具调用的完整 assistant 消息，不是草稿片段。
	assistantMessage: AssistantMessage,
	// 只有准备成功分支能传进来，包含可执行工具和已校验参数。
	prepared: PreparedToolCall,
	// 真实工具执行阶段返回的内容和耗时。
	executed: ExecutedToolCallOutcome,
	// 只需要工具前置与后置策略，不需要完整模型配置。
	config: ToolCallHooks,
	// 整次运行的取消信号；允许缺省，网络/工具/钩子需要配合检查。
	signal: AbortSignal | undefined,
	// 等待后置钩子完成后返回最终单工具结果，供事件与 toolResult 消息共用。
): Promise<FinalizedToolCallOutcome> {
	// 先用工具原始结果，后置钩子有覆盖时再替换。
	let result = executed.result;
	// 保留失败标志；后置钩子也可以调整它。
	let isError = executed.isError;

	// 会话层默认安装了这个钩子，用于扩展 tool_result 和图片处理等。
	if (config.afterToolCall) {
		// 后置扩展可能异步失败；在这个边界将它转成工具错误，避免把未完成的覆盖当成功。
		try {
			// 等待后置处理完成，再确定最终工具结果；模型还没有收到这份结果。
			const afterResult = await config.afterToolCall(
				{
					// 发起这些工具调用的那条 assistant 消息。
					assistantMessage,
					// 将这份结果与原始模型调用关联，保证 id、工具名可追踪。
					toolCall: prepared.toolCall,
					// 钩子可同时看到经过校验的输入，便于结合输入解释或修改输出。
					args: prepared.args,
					// 携带工具返回的内容/详情等；注意它与 role:toolResult 的消息包装不同。
					result,
					// 携带当前的错误标志，而不是重新从文字内容猜测是否失败。
					isError,
					// 把当前消息和工具传给回调；context 指当前请求上下文，不是单独一段 system 字符串。
					context: currentContext,
				},
				// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
				signal,
			);
			// 钩子返回 undefined 时保持原结果；有返回值才逐字段应用覆盖。
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				// 结构化结果要与模型看到的 content 保持一致，不能保留已经失效的旧结构化内容。
				const structuredContent =
					// 钩子只换了 content 却没给配套结构化内容时，丢弃旧结构化内容；否则保留或使用新的。
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				// 合成最终工具结果，下面没被覆盖的字段仍沿用原值。
				result = {
					// 先保留原工具结果中的其他字段。
					...result,
					// 优先采用钩子修改后的模型可见内容。
					content: afterResult.content ?? result.content,
					// details 通常供 UI/扩展使用，与模型看到的 content 分开。
					details: afterResult.details ?? result.details,
					// 工具可以上报自身使用量；没有新值时沿用原来的。
					usage: afterResult.usage ?? result.usage,
					// 合并终止自动续轮的要求；false 是明确值，不会被 ?? 当作缺失。
					terminate: afterResult.terminate ?? result.terminate,
				};
				// 确实没有有效结构化结果时删除该字段，避免下游读到不匹配的数据。
				if (structuredContent === undefined) delete result.structuredContent;
				// 有有效值就写回最终结果。
				else result.structuredContent = structuredContent;
				// 钩子可以显式将失败改成成功，或反过来；未提供时保留旧标志。
				isError = afterResult.isError ?? isError;
			}
			// 捕获本阶段抛出的异常，把它转为工具结果；具体是否重试由后续模型/会话策略决定。
		} catch (error) {
			// 后置钩子本身失败，也作为工具错误内容交给模型，而不伪装成成功结果。
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			// 标记这一工具结果失败，供后续模型和事件订阅者读取。
			isError = true;
		}
	}

	// 返回后置钩子处理后的最终内容、错误标志和原执行耗时，供事件与消息包装共用。
	return {
		// 将这份结果与原始模型调用关联，保证 id、工具名可追踪。
		toolCall: prepared.toolCall,
		// 携带工具返回的内容/详情等；注意它与 role:toolResult 的消息包装不同。
		result,
		// 携带当前的错误标志，而不是重新从文字内容猜测是否失败。
		isError,
		// 沿用实际工具执行耗时，后置钩子的处理时间不重写此值。
		durationMs: executed.durationMs,
	};
}

/**
 * 把可读错误文字包装成工具结果的 content/details 形状，无外部副作用；isError 由调用管线另外携带。
 * 例：找不到 read 时正文写“工具不存在”，上层再包装 role:toolResult 并标记错误。
 */
function createErrorToolResult(message: string): AgentToolResult<any> {
	// 错误结果保留统一 content/details 形状；错误标志由外面的调用结果对象携带。
	return {
		// 错误原因也放在模型可读文字块里，让下一次模型有机会修正参数或选择其他方案。
		content: [{ type: "text", text: message }],
		// 通用错误没有特定工具的结构化详情，用空对象占位。
		details: {},
	};
}

/**
 * 把单工具最终结果发布为 tool_execution_end，等待订阅者处理；并不在这里创建模型 toolResult 消息。
 * 输入最终调用结果和事件出口，返回完成 Promise。例：UI 收到耗时后结束工具运行指示。
 */
async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	// 异步发布事件；先让 Agent 状态和订阅者处理完，再推进当前流程。
	await emit({
		// 工具执行生命周期结束；模型实际读取内容还要等后面的 toolResult 消息。
		type: "tool_execution_end",
		// 沿用模型发起调用的 id，例如 read-decision。
		toolCallId: finalized.toolCall.id,
		// 记录 read 等工具名，便于模型、会话回放和 UI 识别来源。
		toolName: finalized.toolCall.name,
		// 把最终内容和详情提供给事件订阅者。
		result: finalized.result,
		// 给事件订阅者报告成功或失败；模型读取结果要等后面的 toolResult 消息。
		isError: finalized.isError,
		// 条件对象展开：有耗时才添加 durationMs 字段，没有就展开空对象。
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
	});
}

// 把工具对象包装成模型历史消息；toolCall 与 toolResult 必须通过 id 配对。
/**
 * 把工具结果包装成模型历史消息，写入 role、配对调用 id、工具名、内容/详情/用量/错误与可选耗时。
 * 不发事件、不直接写历史。例：模型发 id=read-1，返回消息仍用 read-1，模型才能把内容对应到那次调用。
 */
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	// 创建独立的 toolResult 历史消息；函数只负责包装，发布和追加由调用者负责。
	return {
		// 消息角色明确为工具结果；不是用户说的话，也不是模型回答。
		role: "toolResult",
		// 沿用模型发起调用的 id，例如 read-decision。
		toolCallId: finalized.toolCall.id,
		// 记录 read 等工具名，便于模型、会话回放和 UI 识别来源。
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		// 外部 JS 工具可能漏掉 content，在这个返回边界归一化为空数组。
		content: finalized.result.content ?? [],
		// 附上展示或程序读取的详情；最终供应商是否接收该字段由消息转换决定。
		details: finalized.result.details,
		// 记录工具上报的使用量，不冒充 assistant 的模型用量。
		usage: finalized.result.usage,
		// 让模型知道这是成功内容还是错误说明。
		isError: finalized.isError,
		// 条件对象展开：有耗时才添加 durationMs 字段，没有就展开空对象。
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
		// 记录消息产生的毫秒时间戳，例如用于会话顺序和统计。
		timestamp: Date.now(),
	};
}

// 工具结果也走统一消息事件；不要误以为只有 assistant 文字才写入会话。
/**
 * 顺序发布工具结果消息的 start/end，并等接收器处理完；外层会话可在 message_end 保存完整结果。
 * 例如 read 返回正文后，下一次模型请求要等这条结果的事件处理完成，避免请求上下文漏掉它。
 */
async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	// 通知工具结果这条消息开始，和工具执行开始事件不是同一个事件。
	await emit({ type: "message_start", message: toolResultMessage });
	// 通知工具结果完整就绪；等待会话保存处理完成后才继续下一次模型请求。
	await emit({ type: "message_end", message: toolResultMessage });
}
