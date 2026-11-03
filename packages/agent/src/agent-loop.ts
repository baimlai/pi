/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

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

// 中文导读：emit 是事件接收函数。例如收到 message_end 后，会话层会保存这条完整消息；允许同步返回，也允许返回 Promise。
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Request identity of agent loops: pi-ai's defaults with provider attribution to pi. `AgentLoopConfig.identity`
 * overrides it field by field.
 */
export const DEFAULT_AGENT_IDENTITY: ClientIdentity = { attribution: PI_ATTRIBUTION };

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

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
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		// 把取消信号继续传到下层；用户取消后，模型请求或工具可以停止工作。
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

// 中文主线 4：低层循环入口。接收这次新消息和已有历史；一次调用可能向模型请求很多次。
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
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

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
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

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
// 中文主线 5：循环调度器。例：问“读文件”→模型给 read 调用→执行 read→把结果交回模型→模型回答。
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
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
		? pendingMessages.map((message, index) =>
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: pendingMessages;
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

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** Copy a system message with its tool fields replaced by `changes`; empty lists omit the field. */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	// 取走旧工具字段，...rest 留住正文、提示词章节、时间等其他字段。
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
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
// 中文主线 6：模型调用边界。先整理消息，再调用注入的 streamFn，最后把零碎流事件拼成完整回答。
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
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
		// 传入刚解析的凭证；学习时不要打印真实 key。
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
					// 走上面条件不成立的分支；结合相邻 if 看这里处理的另一种情况。
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
		// 走上面条件不成立的分支；结合相邻 if 看这里处理的另一种情况。
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
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
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
		const finalized: FinalizedToolCallOutcome = {
			// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
			toolCall,
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
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
// 中文主线 7：工具分发入口。模型给的是调用声明，执行哪些本地函数由 Pi 在这里决定。
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
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

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
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
		let finalized: FinalizedToolCallOutcome;
		// kind 是联合类型的分辨字段；immediate 表示已有最终失败/阻止结果，跳过实际执行。
		if (preparation.kind === "immediate") {
			finalized = {
				// 保留原始调用信息，包括 id/name/arguments，方便与工具结果关联。
				toolCall,
				// 直接采用准备阶段产生的结果，例如“工具不存在”或“调用被阻止”。
				result: preparation.result,
				// 带上失败标志；模型收到错误结果后可以修改参数再试。
				isError: preparation.isError,
			};
			// 走上面条件不成立的分支；结合相邻 if 看这里处理的另一种情况。
		} else {
			// 真正调用 tool.execute()；read 会在这里进入 read.ts 的文件读取逻辑。
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			finalized = await finalizeExecutedToolCall(
				// 传入本轮上下文，让工具钩子能看到当前对话与工具集合。
				currentContext,
				// 发起这些工具调用的那条 assistant 消息。
				assistantMessage,
				// 经过校验的工具、参数以及原始调用信息。
				preparation,
				// 执行得到的内容、错误标志和耗时。
				executed,
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
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

// 中文主线 8：默认的并行工具批次。即使本例只有一个 read，也会经过这个函数。
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
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

	return {
		messages,
		// 只有本批非空且每个结果都要求 terminate，才终止工具后的自动续轮。
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	durationMs: number;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

// 中文主线 9：工具执行前的关口。模型输出属于外部输入，TypeScript 类型不能替代这里的参数校验。
async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	// 在可用工具中按 name 找实现。模型不能凭空发明一个名字就获得任意本地能力。
	const tool = tools.find((t) => t.name === toolCall.name);
	// 没有对应工具，就给模型返回“工具不存在”，不执行任何文件操作。
	if (!tool) {
		return {
			// 标记这条调用已经得出结果，调用方不应继续执行工具。
			kind: "immediate",
			// 把找不到工具的原因变成文字，下一轮模型就能看到失败原因。
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
			isError: true,
		};
	}

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
			return {
				// 标记这条调用已经得出结果，调用方不应继续执行工具。
				kind: "immediate",
				// 取消也变成工具错误结果，让调用/结果的对应关系有明确终点。
				result: createErrorToolResult("Operation aborted"),
				// 本次调用失败或被阻止；这是给模型看的结果标志，不会自动抛出整条用户 query。
				isError: true,
			};
		}
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

function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			// 调用的唯一 id；结果必须带同一 id，模型才能把请求与结果配对。
			toolCallId: toolCall.id,
			// 工具名字，例如 read；它用来查找已经注册的本地实现。
			toolName: toolCall.name,
			// 展示当初模型发来的参数；这是执行中的进度事件，校验已在执行前完成。
			args: toolCall.arguments,
			partialResult,
		});
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: AgentContext;
	signal?: AbortSignal;
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
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
	// kind 是联合类型的分辨字段；immediate 表示已有最终失败/阻止结果，跳过实际执行。
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

// 中文主线 10：实际执行单个工具。核心就是 await prepared.tool.execute(...)。
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	// 保存执行期间发布的增量结果任务，结束前要等这些通知处理完。
	const updateEvents: Promise<void>[] = [];
	// 只在工具执行期间接受进度更新，结束后迟到的更新不再加入。
	let acceptingUpdates = true;
	// 记录开始时间，只用于计算工具耗时，不是模型 token 用量。
	const startedAt = performance.now();
	// 箭头函数：调用时计算经过的毫秒数，Math.round 将结果四舍五入。
	const elapsed = () => Math.round(performance.now() - startedAt);

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

// 中文主线 11：执行后的统一收尾，允许 afterToolCall 修改给模型看的结果。
async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	// 先用工具原始结果，后置钩子有覆盖时再替换。
	let result = executed.result;
	// 保留失败标志；后置钩子也可以调整它。
	let isError = executed.isError;

	// 会话层默认安装了这个钩子，用于扩展 tool_result 和图片处理等。
	if (config.afterToolCall) {
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

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	// 异步发布事件；先让 Agent 状态和订阅者处理完，再推进当前流程。
	await emit({
		type: "tool_execution_end",
		// 沿用模型发起调用的 id，例如 read-decision。
		toolCallId: finalized.toolCall.id,
		// 记录 read 等工具名，便于模型、会话回放和 UI 识别来源。
		toolName: finalized.toolCall.name,
		result: finalized.result,
		// 给事件订阅者报告成功或失败；模型读取结果要等后面的 toolResult 消息。
		isError: finalized.isError,
		// 条件对象展开：有耗时才添加 durationMs 字段，没有就展开空对象。
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
	});
}

// 中文主线 12：把工具对象包装成模型历史消息；toolCall 与 toolResult 必须通过 id 配对。
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
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

// 中文主线 13：工具结果也走统一消息事件；不要误以为只有 assistant 文字才写入会话。
async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	// 通知工具结果这条消息开始，和工具执行开始事件不是同一个事件。
	await emit({ type: "message_start", message: toolResultMessage });
	// 通知工具结果完整就绪；等待会话保存处理完成后才继续下一次模型请求。
	await emit({ type: "message_end", message: toolResultMessage });
}
