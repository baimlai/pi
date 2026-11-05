// 为压缩/上下文管理估算 token：优先使用仍适用的模型 usage，再估后续新消息；字符比例和图片常数只是近似，不是 tokenizer。
// 消息与用量的开发期类型，便于按 role/type 分支准确访问字段。
import type { AssistantMessage, ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
// 系统消息可能有 sections，需要先渲染成实际文字才能估算。
import { getSystemMessageText } from "./text.ts";

// 估算结果同时保留总数、usage 基线、尾部估算与基线下标，方便调用方判断可信来源。
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	// 估计当前整个请求上下文占用的 token 总数。
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	// 最近一条适用 assistant usage 给出的已知基线；没有时为 0。
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	// 基线之后新增消息的估算；没找到基线时就是整段估算。
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	// 基线来自消息数组的哪个位置；null 表示完全没有可用 usage。
	lastUsageIndex: number | null;
}

// 每 3.5 个字符粗估一个 token；不同语言/模型可能明显不同，不能据此推导精确计费。
const CHARS_PER_TOKEN = 3.5;
// 每张图片先按固定字符等价量估算，不分析尺寸、细节级别或供应商真实图片算法。
const ESTIMATED_IMAGE_CHARS = 4800;

// 用途：从 usage 取上下文规模。优先 totalTokens 非零值，否则相加输入/输出/缓存读写；例 totalTokens=0 时仍能从分项恢复粗略总数。
export function calculateContextTokens(usage: Usage): number {
	// || 把 0 也当回退条件；这里与只处理 null/undefined 的 ?? 不同。
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

// 用途：估算工具参数/schema 的文本大小，无法 JSON 序列化时用占位符。例循环对象得到 [unserializable]；这个内部版本不用于实际发送请求。
function safeJsonStringify(value: unknown): string {
	try {
		// JSON.stringify(undefined) 会返回 undefined，用可计数字符的文字兜底。
		return JSON.stringify(value) ?? "undefined";
		// 循环引用等情况会抛错，这里只为了估算而吞掉异常。
	} catch {
		// 返回固定占位，保持估算流程可继续，不承诺异常对象的真实大小。
		return "[unserializable]";
	}
}

// 用途：把文字/图片内容转换为估算字符量。例一段 35 字加一张图得到 35+4800；纯字符串直接取长度，无外部副作用。
function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	// 合法联合类型分支：字符串长度按 UTF-16 码元计，不是字节数。
	if (typeof content === "string") return content.length;

	// 累加文字字符数与图片的固定估算量。
	let chars = 0;
	// 内容数组只允许文字/图片，因此非 text 分支就是图片；三元表达式选择不同代价。
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	// 返回字符等价总量，尚未除以每 token 字符比例。
	return chars;
}

// 用途：单段文字粗估 token。例 35 个字符约为 10 token，使用向上取整避免小片段算成零。
export function estimateTextTokens(text: string): number {
	// Math.ceil 向上取整；这是简单比例估计，不是真正的模型分词。
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// 用途：将文字/图片合计字符等价量换算成 token。例图片常数 4800 除 3.5 后取整；不读取图片内容。
export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	// 复用统一内容计数逻辑，然后只做一次比例换算。
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

// 用途：按角色估一条消息，系统消息包括工具变更，assistant 包括思考和工具参数。例 read 工具调用不仅计算工具名字，也计 JSON 参数；不计所有供应商协议开销。
export function estimateMessageTokens(message: Message): number {
	// 累加文字字符数与图片的固定估算量。
	let chars = 0;

	// 系统消息需要额外计入提示词章节和工具声明，不能只看 content。
	if (message.role === "system") {
		return (
			// 把 system 正文/sections 渲染后估文字。
			estimateTextTokens(getSystemMessageText(message)) +
			// 新增工具的描述和参数 schema 也会进入请求，单独估算。
			estimateToolsTokens(message.toolsAdded) +
			// 移除工具引用也属于传给模型的状态变化。
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	// 用户输入可有图片，使用统一文字/图片估算。
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	// 工具返回也可能带图片，不能一律当纯文本。
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	// 排除上面三类角色后，TS 知道这里处理 assistant 的内容块。
	for (const block of message.content) {
		// 普通回答文字按 text 长度估算。
		if (block.type === "text") {
			// 累加当前回答文字；+= 在原数值上增加。
			chars += block.text.length;
			// 思考块有自己的 thinking 字段，并非 text 字段。
		} else if (block.type === "thinking") {
			// 思考也会占模型上下文，纳入估算。
			chars += block.thinking.length;
		} else {
			// 剩余合法内容块为工具调用，统计名字与参数 JSON 大小。
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	// assistant 的各块字符量累加后统一换算。
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

// 用途：找到最后一条仍可代表当前前缀的有效 usage。例旧回复之后插入较新时间戳摘要，旧 usage 不再作基线；返回用量和下标，不修改历史。
function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	// 记录之前消息中最新时间；负无穷使第一条正常时间戳自然可用。
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	// 尚未找到有效基线时为 undefined，找到后会被更新的有效回复覆盖。
	let usageInfo: { usage: Usage; index: number } | undefined;

	// 按消息顺序扫描，而不是直接取最后 assistant 就结束。
	for (let i = 0; i < messages.length; i++) {
		// 读取当前位置消息，后面判断角色及前缀时间。
		const message = messages[i];
		// 只有模型回答的 usage 可以提供供应商计数基线。
		if (message.role === "assistant") {
			// 这里角色已确认；原有断言为后续访问提供明确类型，不执行转换。
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			// 如果之前已有时间更晚的前缀消息，这条回复的旧计数就不能描述它。
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				// 必须对应当前前缀，才能继续检查是否为有效回复。
				usageAppliesToPrefix &&
				// 取消回复不作为可靠 usage 基线。
				assistant.stopReason !== "aborted" &&
				// 错误回复也排除，避免零用量或不完整计数干扰。
				assistant.stopReason !== "error" &&
				// 用量必须大于零；全零 usage 等同没有可用供应商计数。
				calculateContextTokens(assistant.usage) > 0
			) {
				// 保存目前最新合格基线，循环后可能被更晚合格回复替换。
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		// 无论消息角色，都更新当前前缀中见过的最新时间。
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	// 返回最后一条合格基线，或没有找到时的 undefined。
	return usageInfo;
}

// 用途：估整段上下文，兼容规范 context 或只读消息数组。例最后有效回复 usage=1000，之后用户新消息估20，则当前估1020；若无有效基线则逐条全估。
export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	// in 判断联合类型形状，取出消息数组；这不是模型返回 schema 校验。
	const messages = "messages" in context ? context.messages : context;
	// 先找仍适用于当前前缀的供应商 usage。
	const usageInfo = getLastAssistantUsageInfo(messages);
	// 有可靠基线时，旧历史无需重复按字符估算。
	if (usageInfo) {
		// 把供应商 usage 归一成总量。
		const usageTokens = calculateContextTokens(usageInfo.usage);
		// 只累计基线回复之后新增的消息。
		let trailingTokens = 0;
		// 从基线下一条开始，不把基线内已计的历史重复相加。
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			// 新增用户输入、工具结果等都按消息规则估算。
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		// 既给总数也给来源明细，让压缩协调层知道是基线加尾部。
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	// 无基线时开始全量字符估算。
	let tokens = 0;
	// 遍历所有消息，把各自的估值相加。
	for (const message of messages) tokens += estimateMessageTokens(message);
	// null 明确表示没有来源下标，全部 token 都来自估算。
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

// 用途：把工具声明/引用 JSON 序列化后估 token。例复杂 parameters schema 也计入；不调用工具，空列表计0。
function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	// 没有工具变化就没有这部分声明文字开销。
	if (!tools || tools.length === 0) return 0;
	// 先序列化为文字，再用同一字符比例估算。
	return estimateTextTokens(safeJsonStringify(tools));
}
