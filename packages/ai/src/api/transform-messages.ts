// 模型请求前的历史适配：处理不支持图片/跨模型思考与签名、规范工具id、补缺失工具结果并挪动夹在工具配对内的system；不改持久会话。
// 消息/模型类型只参与编译，role/type分支用于后续字段收窄。
import type {
	// API协议id类型。
	Api,
	// assistant消息及来源模型信息。
	AssistantMessage,
	// 图片内容块形状。
	ImageContent,
	// system/user/assistant/toolResult联合。
	Message,
	// 带API泛型的目标模型类型。
	Model,
	// 纯文本块形状。
	TextContent,
	// 工具调用块形状。
	ToolCall,
	// 工具结果消息形状。
	ToolResultMessage,
} from "../types.ts";

// 纯文本模型收到用户图片时的固定替代文字。
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
// 纯文本模型收到工具图片时的另一固定说明。
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
// 错误工具结果拆图后，在原位置留下的固定提示。
const ERROR_TOOL_IMAGE_PLACEHOLDER = "(image attached after the tool results)";

/** An error tool result split into a text-only result and the images to send after the tool results. */
// 拆图返回数据，不是实际已发送消息。
export interface SplitErrorToolResult {
	/** The result content with each run of images replaced by a note. */
	// 每段连续图替换后仅剩文本块数组。
	content: TextContent[];
	/** Text naming the tool call, to send before `images`. */
	// 指明这些图来自哪个调用，供外层放图前展示。
	caption: string;
	// 收集原ImageContent块引用，未重新编码。
	images: ImageContent[];
}

/**
 * Split the images out of an error tool result, for APIs that reject images in error results
 * (Anthropic, and Claude on Bedrock). Send the returned content as the tool result and the caption and
 * images after all tool results of the turn, in the same user message. Returns undefined for results
 * that need no split (#10794).
 */
/**
 * 仅对含图片的错误工具结果拆图，返回纯文字结果、说明caption与原图片数组；无需拆分时undefined。
 * 例：[文字,图,图]变[文字,占位]并收集两图；本函数不真的插入后续user消息，调用适配器要在本轮所有工具结果之后安排caption/images，不修改msg。
 */
export function splitErrorToolResultImages(msg: ToolResultMessage): SplitErrorToolResult | undefined {
	// 非错误结果不需要此兼容拆分。
	if (!msg.isError) return undefined;
	// filter的类型谓词使images推断为ImageContent[]，保留图片原顺序。
	const images = msg.content.filter((block): block is ImageContent => block.type === "image");
	// 错误但没图片也不拆分。
	if (images.length === 0) return undefined;
	// 有图才组装返回对象。
	return {
		// 原结果中的每段图片换占位，不把完整图片数据放结果正文。
		content: replaceImagesWithPlaceholder(msg.content, ERROR_TOOL_IMAGE_PLACEHOLDER),
		// caption注明toolCallId与toolName，方便模型理解后续图的来源。
		caption: `Images from the error result of tool call ${msg.toolCallId} (${msg.toolName}):`,
		// 属性简写返回图数组。
		images,
	};
}

/**
 * 把连续图片段换成一个指定文字占位，返回纯TextContent新数组，不改原块。
 * 例：[图,图,文字A,图]→[占位,A,占位]；若原文字恰等于占位，也被当作相邻占位以避免再添一条，其他文字对象原引用保留。
 */
function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	// 新建纯文字结果数组，未修改输入content。
	const result: TextContent[] = [];
	// 跟踪前一输出是否已经相当于占位，避免连续重复。
	let previousWasPlaceholder = false;

	// 按原块顺序处理，保留文本相对顺序。
	for (const block of content) {
		// 图片不进入返回数组，改成文字占位。
		if (block.type === "image") {
			// 只有前一位置不是占位才创建一条新说明。
			if (!previousWasPlaceholder) {
				// 构造TextContent块，正文为调用方传入placeholder。
				result.push({ type: "text", text: placeholder });
			}
			// 当前图片之后也视为已写占位。
			previousWasPlaceholder = true;
			// 跳过后面的文字处理，继续下一块。
			continue;
		}

		// 非图片分支已收窄为TextContent，复用原对象。
		result.push(block);
		// 原文本若与占位完全相等，也抑制其后图片再次追加说明。
		previousWasPlaceholder = block.text === placeholder;
	}

	// 返回新数组，非深复制文本块。
	return result;
}

/**
 * 目标模型无image输入能力时，把用户数组内容和工具结果中的图换文字，返回消息数组。
 * 模型支持图则直接返回输入数组；否则浅复制相应消息，其余复用。例：切到纯文本模型仍保留“图片省略”说明，不下载或解码图片。泛型TApi绑定模型API，不做运行时验证。
 */
function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	// input能力数组包含image就无需降级。
	if (model.input.includes("image")) {
		// 直接返回同一数组引用。
		return messages;
	}

	// 无视觉能力时map逐条得到新数组。
	return messages.map((msg) => {
		// 用户纯字符串不用检查块，数组分支才可能有图。
		if (msg.role === "user" && Array.isArray(msg.content)) {
			// 浅复制用户消息，替换其content引用。
			return {
				// 保留时间戳等原消息字段。
				...msg,
				// 用用户图片专用占位替图，纯文字块仍保留。
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		// 工具结果content类型为块数组，可直接转换。
		if (msg.role === "toolResult") {
			// 为工具结果建浅副本。
			return {
				// 保留调用id、错误标记等原字段。
				...msg,
				// 用工具图片专用占位，不与用户说明混同。
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		// system/assistant等原样复用，不深复制。
		return msg;
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
/**
 * 为目标模型构建可重放消息数组，返回新结果，不写会话；大多数未变消息/块仍复用原引用。
 * 先补无类型边界的null内容、降级图片，再按provider/api/id判断同模型，跨模型去思考及签名、可选回调改工具id；第二遍跳过error/aborted assistant，按边界补缺工具结果。
 * 例：外来call_1|x可由回调改call_1_x，其后结果同步改id，尾部缺结果会补isError的No result provided。这里只补缺失调用的结果，不删除所有无调用结果或去重已有结果，不保证任意坏历史都能修成合法协议。
 */
export function transformMessages<TApi extends Api>(
	// 待重放消息序列，顺序决定id映射何时可供结果使用。
	messages: Message[],
	// 目标模型，其provider/api/id及输入能力决定转换。
	model: Model<TApi>,
	// 可选调用方id规范化函数，仅跨模型调用；传原id、目标和来源assistant。
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	// 同步返回消息数组；回调抛错仍向外传播。
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	// Map记录原调用id到新id，供后续toolResult同步替换。
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	// ==null同时命中null/undefined，针对无类型历史入口；只浅复制需补[]的消息。
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	// 先依据目标视觉能力降级图片，再处理模型来源。
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	// 第一遍处理内容和id，不在此补工具结果。
	const transformed = imageAwareMessages.map((msg) => {
		// System and user messages pass through unchanged
		// 已经过内容补空/图片降级的system与user不再改。
		if (msg.role === "system" || msg.role === "user") {
			// 保留当前消息引用。
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		// 工具结果只需按已建立映射调整id。
		if (msg.role === "toolResult") {
			// 只查之前出现的调用映射，不向后搜索。
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			// 映射值非空且有变化才创建副本。
			if (normalizedId && normalizedId !== msg.toolCallId) {
				// 浅复制结果并替toolCallId，保持与调用配对。
				return { ...msg, toolCallId: normalizedId };
			}
			// 无映射或没变化原样复用。
			return msg;
		}

		// Assistant messages need transformation check
		// assistant内容需要按来源模型逐块处理。
		if (msg.role === "assistant") {
			// as沿用已确定角色的assistant类型，不转换运行数据。
			const assistantMsg = msg as AssistantMessage;
			// “同模型”要求下面三个字段都相等。
			const isSameModel =
				// 供应商必须相同。
				assistantMsg.provider === model.provider &&
				// API协议也必须相同，不能只比较provider。
				assistantMsg.api === model.api &&
				// 模型id同样必须相同。
				assistantMsg.model === model.id;

			// flatMap用[]删除块，用对象保留一个块，组合成新content数组。
			const transformedContent = assistantMsg.content.flatMap((block) => {
				// 思考块单独走模型来源规则。
				if (block.type === "thinking") {
					// Thinking from another model is dropped. Signatures and encrypted reasoning are
					// only valid for the model that produced them, and sending readable thinking as
					// plain text makes the new model treat it as part of the visible reply.
					// 跨模型思考全部丢弃，不转成可见text。
					if (!isSameModel) return [];
					// Keep redacted and signed blocks even if the thinking text is empty
					// (OpenAI encrypted reasoning); they are needed for replay.
					// 同模型的redacted或带thinkingSignature块即使无文字也保留。
					if (block.redacted || block.thinkingSignature) return block;
					// 无上述保留标记、又空/全空白的思考块删除。
					if (!block.thinking || block.thinking.trim() === "") return [];
					// 其余同模型可读思考块原样保留。
					return block;
				}

				// 普通文字块跨模型时重建最小字段对象。
				if (block.type === "text") {
					// 同模型原样保留块的额外元数据。
					if (isSameModel) return block;
					// 跨模型仅保留type/text，去其他来源元数据。
					return {
						// as const保留text字面量类型，编译后无额外动作。
						type: "text" as const,
						// 正文文字保持原值。
						text: block.text,
					};
				}

				// 工具调用可能需要去来源签名、规范id。
				if (block.type === "toolCall") {
					// 断言为ToolCall类型，不实际验证参数schema。
					const toolCall = block as ToolCall;
					// 默认沿用原块，let允许按需替副本。
					let normalizedToolCall: ToolCall = toolCall;

					// 仅跨模型且thoughtSignature为真值时去该字段。
					if (!isSameModel && toolCall.thoughtSignature) {
						// 先浅复制，避免删除原历史工具块字段。
						normalizedToolCall = { ...toolCall };
						// delete实际删副本的签名，as仅使该可选属性可访问。
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					// 仅跨模型且调用方提供id回调才调用它。
					if (!isSameModel && normalizeToolCallId) {
						// 回调可按目标协议和来源选择id规则；本函数本身不硬编码64字符规则。
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						// 回调结果确实变化才记录映射/建副本。
						if (normalizedId !== toolCall.id) {
							// 后续同原id结果会查到该新值；重复原id后写覆盖前写。
							toolCallIdMap.set(toolCall.id, normalizedId);
							// 在可能已去签名的副本上替换id。
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					// 返回最终工具调用块，可能仍为原引用。
					return normalizedToolCall;
				}

				// 其他块沿用原值；这条兜底不新增内容类型支持。
				return block;
			});

			// assistant消息总会建浅副本以装新content数组。
			return {
				// 保留provider/api/model/usage等原消息元数据，不改成目标模型身份。
				...assistantMsg,
				// 替换为本次逐块转换后的内容。
				content: transformedContent,
			};
		}
		// 沿用其他消息，保持既有兜底分支。
		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	// 第二遍的最终输出数组。
	const result: Message[] = [];
	// 暂存最近有效assistant的工具调用，等待边界判断是否缺结果。
	let pendingToolCalls: ToolCall[] = [];
	// Set记录已见结果的id，不删除/去重实际结果消息。
	let existingToolResultIds = new Set<string>();
	// System messages are transparent to tool-call accounting: one that lands between a tool
	// call and its results is held back and emitted after the results (synthetic ones
	// included), so it never causes a duplicate result for a call that is answered later.
	// 夹在工具流中的system暂存到本批结果之后。
	const heldSystemMessages: Message[] = [];
	/**
	 * 结束当前工具配对批次：给缺结果的调用补错误结果、重置跟踪，再输出暂存system，无返回。
	 * 闭包就地修改本次result/队列，不执行真实工具；例：assistant调用read→system→read结果时，system延到结果后，避免system提前截断配对而补重复结果。
	 */
	const closePendingToolCalls = () => {
		// 有当前工具批次才检查缺口。
		if (pendingToolCalls.length > 0) {
			// 按assistant原调用顺序查每一个调用。
			for (const tc of pendingToolCalls) {
				// 本批没见到匹配结果才补一个。
				if (!existingToolResultIds.has(tc.id)) {
					// 追加合成消息，不执行真实工具。
					result.push({
						// 角色标为toolResult供供应商重放。
						role: "toolResult",
						// 使用规范化后的调用id。
						toolCallId: tc.id,
						// 沿用调用工具名。
						toolName: tc.name,
						// 固定说明没有提供结果，不伪造业务输出。
						content: [{ type: "text", text: "No result provided" }],
						// isError=true表示缺结果故障。
						isError: true,
						// 合成时记录本地当前毫秒时间。
						timestamp: Date.now(),
						// 断言消息类型，不做运行时转换。
					} as ToolResultMessage);
				}
			}
			// 关闭批次后清调用跟踪。
			pendingToolCalls = [];
			// 结果id集合也换成空Set。
			existingToolResultIds = new Set();
		}
		// 工具真实/合成结果之后再输出被暂存的system。
		result.push(...heldSystemMessages);
		// 清空同一暂存数组，避免下个边界重复输出。
		heldSystemMessages.length = 0;
	};

	// 第二遍按转换后消息顺序扫描，未重排用户/assistant相互顺序。
	for (let i = 0; i < transformed.length; i++) {
		// 读取当前消息。
		const msg = transformed[i];

		// 每个新assistant都是上批工具流的结束边界。
		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			// 先给上一批缺结果调用补齐，并释放暂存system。
			closePendingToolCalls();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			// 沿用assistant类型断言，不改变消息对象。
			const assistantMsg = msg as AssistantMessage;
			// error/aborted的assistant整体不重放。
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				// 跳过这条回复，不为它新建pending调用；本函数仍可能保留后面独立出现的toolResult。
				continue;
			}

			// Track tool calls from this assistant message
			// 从有效assistant提工具调用块，不数文字/思考。
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			// 确有调用才建立新的待配对批次。
			if (toolCalls.length > 0) {
				// 记录这一回复的全部调用。
				pendingToolCalls = toolCalls;
				// 新批次重新统计已出现结果id。
				existingToolResultIds = new Set();
			}

			// 有效assistant先加入结果，再接后续真实结果。
			result.push(msg);
			// 工具结果分支保留实际消息。
		} else if (msg.role === "toolResult") {
			// 记录id，Set只参与缺口判断。
			existingToolResultIds.add(msg.toolCallId);
			// 已有重复结果也照原样追加，不在此去重。
			result.push(msg);
			// system不会结束工具批次。
		} else if (msg.role === "system") {
			// 仍有pending调用时先暂存system，即便这些调用结果已全部出现也等边界再放。
			if (pendingToolCalls.length > 0) {
				// 保持多条暂存system的原相对顺序。
				heldSystemMessages.push(msg);
				// 没工具批次时可直接输出system。
			} else {
				// 原样加入结果。
				result.push(msg);
			}
			// user开启新用户回合，必须关闭上一工具批次。
		} else if (msg.role === "user") {
			// A new user turn interrupts tool flow - insert synthetic results for orphaned calls
			// 先补缺结果/释放system，不把它们放新用户之后。
			closePendingToolCalls();
			// 再加入当前user。
			result.push(msg);
			// 保留原有兜底分支，不修改未知其他角色。
		} else {
			// 原样追加此消息。
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	// 末尾也关闭工具批次，处理尾部悬空调用并释放system。
	closePendingToolCalls();

	// 返回本次重放数组；原持久历史未被替换。
	return result;
}
