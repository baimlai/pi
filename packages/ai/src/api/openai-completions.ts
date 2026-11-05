// Chat Completions 真实请求适配：兼容多家服务的消息/工具/思考/缓存字段，按分片累积统一事件；工具执行和多轮循环在更外层。
// OpenAI SDK 负责发 HTTP 请求和解码 SSE；本文件把统一消息与兼容 Chat Completions 协议互转。
import OpenAI from "openai";
// 仅导入 SDK 的消息/块/流类型，运行时擦除；后续自定义字段需额外兼容类型。
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
// calculateCost 用目录价估算费用；clampThinkingLevel 选择模型可用的逻辑档位。
import { calculateCost, clampThinkingLevel } from "../models.ts";
// 统一层区分文字、思考、图片、工具调用/结果及采样配置，类型不等于远端结构校验。
import type {
	AssistantMessage,
	CacheRetention,
	ChatTemplateKwargValue,
	ImageContent,
	JsonValue,
	Message,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingTokenBudgetField,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
// 未知异常先标准化再转换为用户可显示的文字。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 本地事件通道既可逐项迭代，也能取得最终 AssistantMessage。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 超长组合工具 ID 用短哈希保留差异；它不是无碰撞或加密身份保证。
import { shortHash } from "../utils/hash.ts";
// 响应头转换成观察回调需要的普通记录。
import { headersToRecord } from "../utils/headers.ts";
// ClientIdentity 是静态类型，实际 helper 按供应商生成身份头。
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
// OpenRouter 可报告账务总费用；有效时覆盖目录估算总额，分项仍可能是估算。
import {
	applyOpenRouterReportedCost,
	isOpenRouterModel,
	type OpenRouterUsageAccounting,
} from "../utils/openrouter-cost.ts";
// 读取本次环境快照/进程环境中的配置，具体回退由 helper 决定。
import { getProviderEnvValue } from "../utils/provider-env.ts";
// 外层重试只围住初始 SDK 请求，流内已消费片段不在此重试。
import { retryProviderRequest } from "../utils/provider-retry.ts";
// 清理孤立 UTF-16 代理码元，保留能正常编码的文本。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// 每条 JSON 工具调用独享增量预览解析器，结束时另做完整对象解析。
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
// 初始系统消息和后续系统更新用不同文字渲染方式。
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
// 系统消息携带有序工具声明，工具解析与历史转换共用这些函数。
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
	type TranscriptContext,
} from "../utils/transcript.ts";
// JSON schema strict 与 grammar custom 是两种约束路径，custom 输入还要转成统一 JSON 参数增量。
import {
	appendGrammarToolInputJsonDelta,
	closeGrammarToolInputJson,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
// Copilot 的图片标记和请求发起方根据会话历史计算。
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
// 缓存键按共享规则限长，不控制实际缓存内容。
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
// 公共选项/采样/思考预算 helper 不发网络请求；预算预留一部分输出空间给答案。
import {
	buildBaseOptions,
	clampThinkingBudgetToAnswerRoom,
	resolveSamplingParams,
	thinkingBudgetForLevel,
} from "./simple-options.ts";
// 跨模型历史转换还会规范化工具 ID、补缺失工具结果、移除不适用的思考元数据。
import { transformMessages } from "./transform-messages.ts";

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
/**
 * 判断给定头记录中是否有非空指定头，返回 boolean，无状态修改。
 * 忽略大小写，排除 null 和纯空白值；例 Authorization 可匹配 authorization，但不验证 token。上方原英语说明实际描述后面的 hasToolHistory，而非本函数。
 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	// 未给头配置就返回 false，不读取模型默认头。
	if (!headers) return false;
	// 目标头名转小写，比较时不区分大小写。
	const expected = name.toLowerCase();
	// Object.entries 取自有可枚举键值，解构出头名和值。
	for (const [key, value] of Object.entries(headers)) {
		// 名字匹配、不是删除标记 null、去空白后非空就认为存在；不校验 token 内容。
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	// 没有合格头就返回 false。
	return false;
}

/**
 * 选择 SDK 必需 key：真值显式 key→授权头存在时 unused 占位→抛缺凭证错误，无环境/存储读取。
 * 例显式 headers.Authorization 已带 token 时占位只满足客户端构造；只查传入头，不查 model.headers。
 */
function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	// 非空显式 key 优先；空白串仍是真值，不在此 trim。
	if (apiKey) return apiKey;
	// 显式授权头存在时给 SDK unused 占位，稍后默认头可覆盖自动认证头；不查 model.headers。
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	// 缺认证来源就抛配置错误，实际由同步调用或 try 决定如何传递。
	throw new Error(`No API key for provider: ${provider}`);
}

/**
 * 扫描统一历史是否含工具结果或 assistant 工具调用，返回 boolean，不改历史。
 * 逐条检查并短路；例工具已经移除但历史有 toolResult，仍返回 true，让请求可补 tools:[] 兼容代理。
 */
function hasToolHistory(messages: Message[]): boolean {
	// 遍历统一会话消息，不转换也不修改它们。
	for (const msg of messages) {
		// 已有工具结果就说明历史中存在工具交互。
		if (msg.role === "toolResult") {
			// 短路返回，不再扫描后续消息。
			return true;
		}
		// 只有 assistant 角色才有需要检查的工具调用块。
		if (msg.role === "assistant") {
			// some 在遇到第一个 toolCall 时停止；不检查调用是否有对应工具声明。
			if (msg.content.some((block) => block.type === "toolCall")) {
				// 找到工具调用即可返回 true。
				return true;
			}
		}
	}
	// 全段没有结果/调用就为 false。
	return false;
}

/**
 * 按块的 type 筛出文字，返回类型谓词供 filter 缩窄 TS 类型，无副作用。
 * 例 content.filter(isTextContentBlock) 得到 TextContent[]；它只比标签，不验证任意外部对象是否真有 text。
 */
function isTextContentBlock(block: { type: string }): block is TextContent {
	// 只比较判别字段；block is TextContent 让 filter 后静态类型变窄，不验证 text 属性。
	return block.type === "text";
}

/**
 * 按标签筛思考块并为 TS 提供 ThinkingContent 类型谓词，无副作用。
 * 例 filter 后可访问 thinking，实际运行只检查 type 是否为 thinking。
 */
function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	// 按 type 筛思考块，随后可通过 ThinkingContent 类型访问 thinking。
	return block.type === "thinking";
}

/**
 * 按标签筛工具调用，返回类型谓词，不检查参数 schema 或执行工具。
 * 例含文字和 toolCall 的数组过滤后只保留调用块。
 */
function isToolCallBlock(block: { type: string }): block is ToolCall {
	// 按 type 筛工具调用；这里没有检查工具名、参数 schema 或授权。
	return block.type === "toolCall";
}

/**
 * 按标签筛图片块，返回类型谓词，不解码/验证图片。
 * 例工具结果中的 image 被筛出后可转换 data URL。
 */
function isImageContentBlock(block: { type: string }): block is ImageContent {
	// 按 type 筛图片块；不会解码或验证 base64 数据。
	return block.type === "image";
}

/**
 * 在未知 detail 输入边界排除非对象、null、数组，返回对象类型谓词，无修改。
 * 例 JSON 数组不通过，普通对象通过；不是普通对象原型或全部字段值的校验。
 */
function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	// 未知 JSON/流数据边界：要求非 null 非数组对象，允许任意对象原型，不要求普通对象。
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

/**
 * 检查 reasoning detail 的公共字段类型，返回 boolean，无修改。
 * id 可缺省/null/字符串，format 可缺省/字符串，index 可缺省/数字；例 index=0 通过，不要求非负整数。
 */
function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	// 共享字段全部满足才通过；未检查额外字段是否为 JsonValue。
	return (
		// id 可省略、为 null 或字符串，空串也允许。
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		// format 可省略或为字符串，null 不通过。
		(candidate.format === undefined || typeof candidate.format === "string") &&
		// index 可省略或为 number；不要求整数/非负/有限，NaN 也满足 typeof number。
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

/**
 * 识别远端/历史的三种 reasoning detail，返回类型谓词，无副作用，不验证加密签名真实性。
 * 先检查公共形状，再按 type 检查 summary/data/text 与 signature；例 encrypted 的 data 字符串可保留为不透明元数据。
 */
function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
	// 先排除非对象或公共字段类型不合格的远端数据。
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		// 公共形状不满足便不当作可回放 reasoning detail。
		return false;
	}
	// 判别 type 决定必须有什么负载字段。
	switch (detail.type) {
		// 摘要变体。
		case "reasoning.summary":
			// 要求 summary 是字符串，空摘要也合法。
			return typeof detail.summary === "string";
		// 加密变体。
		case "reasoning.encrypted":
			// 仅要求 data 为字符串，不解密、不验签、不要求非空。
			return typeof detail.data === "string";
		// 思考原文变体。
		case "reasoning.text":
			// 同时检查原文和可选签名类型。
			return (
				// text 必须是字符串。
				typeof detail.text === "string" &&
				// signature 可以缺省、为 null 或字符串；不验证签名真实性。
				(detail.signature === undefined || detail.signature === null || typeof detail.signature === "string")
			);
		// 未知 type 不能作为这三种联合类型使用。
		default:
			// 忽略不识别变体而不是抛错误。
			return false;
	}
}

// extends 公共请求配置并添加 Chat Completions 专有字段，接口没有运行时实例。
export interface OpenAICompletionsOptions extends StreamOptions {
	// 直接沿用 SDK 工具选择联合类型，含普通 function/custom 选择形式。
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	// 原生逻辑档位不含 off；简单入口会将 off 转成未指定。
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Token budgets per thinking level. Used when `compat.thinkingTokenBudgetField` or `compat.supportsThinkingTokenBudget` is set, or by `{ "$var": "thinking.budget" }`. */
	// 可选的分档 token 预算表，具体消费方式由模型兼容字段/模板变量决定。
	thinkingBudgets?: ThinkingBudgets;
}

// 导出消息转换附加配置的静态形状。
export interface ConvertCompletionsMessagesOptions {
	// 工具名到 grammar 输入属性的只读接口；readonly 不冻结底层 Map。
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

// 兼容代理使用的 Anthropic 风格缓存标记，不是本地缓存实现。
interface OpenAICompatCacheControl {
	// 字面量类型限定 type 必须是 ephemeral。
	type: "ephemeral";
	// ttl 可省略，实际在本文件只选择 1h 或不写。
	ttl?: string;
}

// Omit 从补全后的配置中移去下面几项，再用交叉类型把它们以可选形式加回。
type ResolvedOpenAICompletionsCompat = Omit<
	// Required 把原接口的可选属性标记移除，是编译期类型运算。
	Required<OpenAICompletionsCompat>,
	// 缓存标记格式允许仍未定义。
	| "cacheControlFormat"
	// 旧的预算布尔别名保留可选形式。
	| "supportsThinkingTokenBudget"
	// 显式预算字段名允许省略。
	| "thinkingTokenBudgetField"
	// 中途系统消息支持仍允许缺省。
	| "supportsMidConvoSystemMessages"
	// 中途工具添加支持仍允许缺省。
	| "supportsMidConvoToolAdditions"
	// vLLM 调度优先级允许缺省。
	| "vllmPriority"
	// & 将前面剩余必需属性与下面重新定义的可选属性组合。
> & {
	// 索引访问类型复用原兼容接口的缓存格式类型。
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	// 预算支持布尔别名，可缺省。
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	// 原始预算字段名类型直接复用，避免手写遗漏。
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	// 中途系统消息标记沿用原类型。
	supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
	// 中途工具添加标记沿用原类型。
	supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
	// 优先级沿用原始类型，不自行给默认值。
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
};

// 模板变量解析后只能成为 JSON 标量；undefined 用来表示省略字段。
type ResolvedChatTemplateKwargValue = string | number | boolean | null;

// 联合类型允许 system 或 developer 两种指令消息，不包括用户/工具角色。
type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

// Kimi 风格系统工具声明的本地扩展类型，SDK 标准消息类型没有这个 tools 字段。
type KimiToolSystemMessageParam = {
	// 角色必须为 system；不会因为 reasoning 模型而改成 developer。
	role: "system";
	// 声明内容使用已经转好的 SDK 工具数组。
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

// 交叉类型允许保留额外 JSON 字段；运行时检查仅覆盖下面实际使用的少数字段。
type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
	// 可选 id，null 与缺省都可能出现。
	id?: string | null;
	// 可选格式名，通常供回放时保持原供应商元数据。
	format?: string;
	// 可选索引；本文件合并相邻 detail 时不按索引分组。
	index?: number;
};

// 基础字段加上摘要变体。
type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
	// type 是判别标签，switch 可据此收窄类型。
	type: "reasoning.summary";
	// 摘要正文用 summary 字段。
	summary: string;
};

// 加密变体仍携带共同元数据。
type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
	// 固定加密标签。
	type: "reasoning.encrypted";
	// data 作为不透明文字保存，不在本地解析成思考正文。
	data: string;
};

// 带原文的思考变体。
type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
	// 固定原文标签。
	type: "reasoning.text";
	// 模型思考文字。
	text: string;
	// 可选签名随回放保留，null 允许表达供应商未给签名。
	signature?: string | null;
};

// 三种结构的判别联合，类型缩窄后可访问对应字段。
type OpenAIReasoningDetail = OpenAIReasoningSummaryDetail | OpenAIEncryptedReasoningDetail | OpenAIReasoningTextDetail;

/**
 * 尝试把历史 thinkingSignature 解析成非空 detail 数组，返回数组或 undefined，不改输入、不向外抛 JSON 错误。
 * 流程：解析 unknown→检查数组及所有项；例签名是 reasoning_content 字段名而非 JSON 时，返回 undefined 供其他回放路径处理。
 */
function parseOpenAIReasoningDetails(signature: string | undefined): OpenAIReasoningDetail[] | undefined {
	// 缺省或空串不尝试 JSON 解析。
	if (!signature) return undefined;
	// 历史签名可能不是 JSON，失败时按无结构化元数据处理。
	try {
		// JSON.parse 的值先当 unknown，不能只靠 as 宣称可信。
		const parsed = JSON.parse(signature) as unknown;
		// 必须非空数组且每项通过形状检查；任一坏项让整组不采用。
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
		// JSON 语法异常在这里吞掉，让调用方继续其他回放路径。
	} catch {
		// 返回 undefined 表示不是可用结构化 detail 数组。
		return undefined;
	}
}

/**
 * 解析旧工具调用 thoughtSignature 中的单个加密 detail，返回对象或 undefined，无修改。
 * 须已识别 encrypted 且 id/data 非空；JSON 错误被忽略。例旧存档加密签名可作为新 reasoning_details 的回退。
 */
function parseLegacyEncryptedReasoningDetail(
	// 输入来自旧存档中工具调用的 thoughtSignature 字符串。
	signature: string | undefined,
	// 结果是单个加密 detail 或 undefined，不是数组。
): OpenAIEncryptedReasoningDetail | undefined {
	// 空签名不解析。
	if (!signature) return undefined;
	// 未知旧签名格式作为兼容输入边界处理。
	try {
		// 先转 unknown，再由下方检查判别结构。
		const parsed = JSON.parse(signature) as unknown;
		// 先通过通用 detail 形状校验。
		return isOpenAIReasoningDetail(parsed) &&
			// 旧字段只接受加密变体，不接受摘要/原文变体。
			parsed.type === "reasoning.encrypted" &&
			// 还要求 id 是字符串，不允许 null/undefined。
			typeof parsed.id === "string" &&
			// 旧格式的 id 必须非空，但空白串不会被 trim。
			parsed.id.length > 0 &&
			// 加密 data 必须非空，仍不验证其实际内容。
			parsed.data.length > 0
			? // 所有条件满足才复用解析对象。
				parsed
			: // 否则不参与旧格式回放。
				undefined;
		// 语法解析失败走兼容忽略分支。
	} catch {
		// 未知旧签名不向外抛异常。
		return undefined;
	}
}

/**
 * 把新 detail 的缺少公共元数据补进目标，返回 void，会原地改 target。
 * id/index 用 ??=、format 用 ||=；例 index=0 保留，空 format 可被新值替换，不核对两个 detail 的 id 是否相同。
 */
function fillMissingCommonReasoningDetailFields(
	// 目标是可原地补充的既有 detail。
	target: OpenAIReasoningDetailBase,
	// 来源是新收到的一段已识别 detail。
	source: OpenAIReasoningDetail,
	// void 表示调用方不取返回值，副作用是修改 target。
): void {
	// ??= 仅目标 id 为 null/undefined 时补上，已有空串保留。
	target.id ??= source.id;
	// ||= 在目标 format 为假值时填充，已有空串可被覆盖。
	target.format ||= source.format;
	// 索引 0 会保留；只有 null/undefined 才填 source.index。
	target.index ??= source.index;
}

/**
 * 积累可回放 detail，原地修改数组/末项，无返回正文。
 * 只按末项类型合并连续 text 或 summary，并补公共元数据；其他浅复制 push。例 text="a" 后 text="b" 得到 ab，加密项各自保留。
 * 合并不比较 id/index，因此这是现有流兼容规则，不是按真实供应商块身份分组的保证。
 */
function appendOpenAIReasoningDetail(details: OpenAIReasoningDetail[], detail: OpenAIReasoningDetail): void {
	// 只观察最后一项，不按 id/index 搜索整个数组。
	const lastDetail = details[details.length - 1];
	// 连续两个 text 直接合并，即使它们 id/index 不同也不另分组。
	if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
		// 原地追加文字，不插换行。
		lastDetail.text += detail.text;
		// 已有非空签名优先，空值才采用新签名。
		lastDetail.signature ||= detail.signature;
		// 用来源补未具备的公共元数据。
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		// 已合并，不再 push 新项。
		return;
	}
	// 连续 summary 同样按类型合并，不比对 id/index。
	if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
		// 直接拼接摘要片段，不加分隔符。
		lastDetail.summary += detail.summary;
		// 公共元数据只补缺，不覆盖已保留字段。
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		// 合并完成提前返回。
		return;
	}
	// 其他情况浅复制为新条目；加密 detail 保持一个个离散项。
	details.push({ ...detail });
}

// as const 保留三个字面量的只读元组静态类型；不会在运行时冻结数组。
const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

// typeof 在类型位置取元组类型，[number] 取任一元素类型，得到三个字段名的联合。
type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

/**
 * 检查字符串是否是允许的三种原文 reasoning 字段名，返回类型谓词，无修改。
 * 例 reasoning_content 通过而任意工具名不通过；只有这里 includes 才是运行时白名单检查。
 */
function isOpenAICompletionsReasoningField(field: string): field is OpenAICompletionsReasoningField {
	// 运行时 includes 真正检查字段白名单；as 只是满足静态参数类型，不影响比较。
	return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

// 在 SDK assistant 消息上扩展推理字段。
type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
	// Record 为每个字段名指定 string，Partial 再使这些字段都可选。
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		// 结构化 detail 作为 JSON 数组回放，不是用户可见正文。
		reasoning_details?: JsonValue[];
	};

// SDK 文本段扩展缓存标记；交叉类型不改变现有对象布局。
type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	// 可选 cache_control 写在具体文本段上。
	cache_control?: OpenAICompatCacheControl;
};

// 工具声明同样允许兼容代理的缓存扩展字段。
type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	// 缓存标记附在最末工具声明，不是工具返回结果内容。
	cache_control?: OpenAICompatCacheControl;
};

/**
 * 解析缓存偏好，显式值优先、环境精确 long 次之、否则 short，无副作用。
 * 例显式 none 不会被 PI_CACHE_RETENTION=long 覆盖；实际缓存标记还看模型兼容配置。
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	// 显式 none/short/long 均优先，不会因 none 而读环境覆盖。
	if (cacheRetention) {
		// 返回显式偏好，无状态修改。
		return cacheRetention;
	}
	// 环境仅精确 long 开启长期偏好。
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		// 返回逻辑 long，实际字段仍需兼容设置支持。
		return "long";
	}
	// 其他情况默认 short。
	return "short";
}

/**
 * 发起一轮 Chat Completions 请求，同步返回事件流；输入模型、整段会话和可选原生选项，最终给统一 assistant 消息。
 * 流程：规范化→工具/缓存/思考兼容转换→payload 钩子→可选重试建立请求→逐 chunk 合并思考/文本/工具→检查终态→done/error。
 * 副作用是网络、钩子调用和本轮 output 更新；例 read 调用参数分成两片到达时先给预览，流结束再完成解析，不负责执行 read。
 * try 内异常转流失败，外层同步规范化不受其保护；只处理 choices[0]，不是多候选结果聚合器。
 */
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	// Model 泛型静态限制为 Chat Completions API，避免误传其他协议模型。
	model: Model<"openai-completions">,
	// 输入为完整有序会话，包含用户、模型、工具与系统变更。
	context: TranscriptContext,
	// 原生专有选项可省略；认证由上层传入而非这里自动登录。
	options?: OpenAICompletionsOptions,
	// 外层同步返回事件流，异步网络工作在内部推进。
): AssistantMessageEventStream => {
	// 立即创建事件通道，不等到 HTTP 建立后再返回。
	const stream = new AssistantMessageEventStream();
	// 先根据中途系统能力规范化历史；此同步步骤在内部 try/catch 之外。
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	/**
	 * 立即执行本轮异步任务，闭包捕获模型/会话/事件流；成功或 try 内失败均通过通道回传，不返回任务 Promise。
	 * 例调用方拿到流后，HTTP 与 SSE 在后台推进；HTTP 200 后仍可因后续解析/观察器异常失败。
	 */
	// 立即执行 async 闭包；它的 Promise 不向外返回，调用方通过事件流收结果。
	(async () => {
		// 这轮回答共用一个可变 output，partial 不是自动复制的历史快照。
		const output: AssistantMessage = {
			// 统一 assistant 角色。
			role: "assistant",
			// 内容块按首次出现顺序加入，文本/思考/工具会各自持续更新。
			content: [],
			// 记调用所选 API，区别供应商原始响应字段。
			api: model.api,
			// 记目录供应商，不因为兼容网关路由改变它。
			provider: model.provider,
			// 记请求模型 id；实际 responseModel 可在流中另记。
			model: model.id,
			// 用量尚未知时从零初始化。
			usage: {
				// 普通输入 token 初值。
				input: 0,
				// 输出 token 初值，包含供应商 completion_tokens 中的思考部分。
				output: 0,
				// 缓存读取 token 初值。
				cacheRead: 0,
				// 缓存写入 token 初值。
				cacheWrite: 0,
				// 总 token 初值，之后由完整 usage 重算，不对每个增量求和。
				totalTokens: 0,
				// 初始费用分项为零，不代表远端没发生消耗。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// pending 表示未取得可接受终态。
			stopReason: "pending",
			// 记录本地毫秒时间。
			timestamp: Date.now(),
		};

		// `reasoning_details` are replay metadata, not user-visible stream deltas.
		// Keep them in memory during streaming and serialize once when the block is finalized.
		// 结构化回放元数据先放私有闭包变量，避免每个片段都序列化整数组。
		let streamedReasoningDetails: OpenAIReasoningDetail[] | undefined;
		/**
		 * 把累计结构化 detail 序列化进给定思考块，返回 void，会修改块签名，不改可见 thinking 文字。
		 * 有元数据才覆盖；例结束时一次 JSON.stringify，下一轮能解析回同一组回放数据。
		 */
		const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
			// 只有真的接收过 detail 数组时才覆盖思考签名。
			if (streamedReasoningDetails !== undefined) {
				// 结束/错误时一次 JSON 序列化，使后续轮能恢复结构化元数据。
				block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
			}
		};

		// 从认证检查到流消费的失败统一转 error 事件，已发 partial 不会回滚。
		try {
			// 显式 key 优先，或显式授权头存在时用 SDK 占位 key。
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			// 能力为本地检测+模型覆盖，不是联网探测结果。
			const compat = getCompat(model);
			// 准备 grammar 工具名到单个字符串参数名的映射。
			const grammarToolInputProperties = createGrammarToolInputProperties(
				// 历史中出现过的声明用于回放，不仅当前最终活动集合。
				getDeclaredTools(normalizedContext.messages),
				// grammar 默认关闭，需模型兼容配置明确支持。
				compat.supportsOpenAIGrammarTools,
			);
			// 缓存逻辑偏好在本轮只解析这一次并传给参数构造。
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			// none 时不给自动亲和头传 sessionId；不阻止显式头/采样钩子添加自己的值。
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			// 构造 SDK 客户端；实际请求发生在后面的 create。
			const client = createClient(
				// 模型提供 URL、默认头和供应商标识。
				model,
				// 历史供 Copilot 动态头计算。
				normalizedContext,
				// 传已选 key，包括 unused 占位形式。
				apiKey,
				// 本次显式头最后覆盖此前默认头。
				options?.headers,
				// 身份配置供身份头 helper 使用。
				options?.identity,
				// 自定义 fetch 可以接管网络，离线测试用内存响应。
				options?.fetch,
				// 按缓存策略筛选后的亲和会话 id。
				cacheSessionId,
				// 同一份能力对象供客户端头策略使用。
				compat,
			);
			// 构造请求体，后面允许钩子替换整对象。
			let params = buildParams(
				// 模型决定请求 id 与能力/思考映射。
				model,
				// 完整规范化会话，不只最后一问。
				normalizedContext,
				// 调用方原生选项。
				options,
				// 参数转换使用与请求头一致的能力配置。
				compat,
				// 传已解析的缓存偏好，避免默认值分歧。
				cacheRetention,
				// 历史回放与本次工具声明共用 grammar 属性映射。
				grammarToolInputProperties,
			);
			// 发请求前等待 payload 钩子，允许原地改值或返回替代值；重试不会重复调用它。
			const nextParams = await options?.onPayload?.(params, model);
			// 只有 undefined 表示不替换，其他返回值未做运行时结构校验。
			if (nextParams !== undefined) {
				// as 只是编译期类型断言，不能把任意回调结果校验成合法 SDK 参数。
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			// 把 SDK 请求控制与模型参数体分开。
			const requestOptions = {
				// 条件展开：有信号才传，实际取消由 SDK/传输完成。
				...(options?.signal ? { signal: options.signal } : {}),
				// 显式 timeoutMs=0 也传入 SDK；此适配层不定义所有重试合计时限。
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// 禁用 SDK 自带重试，避免与外部策略叠加。
				maxRetries: 0,
			};
			// 等初始请求建立与 SDK 流包装，不是等整个模型回答结束。
			const { data: openaiStream, response } = await retryProviderRequest(
				// 工厂每次新建请求，withResponse 同时给解析流和原始 HTTP Response。
				() => client.chat.completions.create(params, requestOptions).withResponse(),
				// 以下是本地重试选项，不进入模型请求体。
				{
					// 额外重试预算，helper 缺省为 0。
					maxRetries: options?.maxRetries,
					// 限制服务器建议等待时长，未传默认 60 秒。
					maxRetryDelayMs: options?.maxRetryDelayMs,
					// 相同信号可打断退避；不重试后面的流迭代失败。
					signal: options?.signal,
				},
			);
			// 先等待 HTTP 响应观察回调；回调抛错时尚未发 start。
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			// 向调用方表示流已经建立，可以开始接收内容；不是终态。
			stream.push({ type: "start", partial: output });

			// Stream state of a tool call, kept off the content block so it never reaches partials: JSON arguments, or
			// the input of a grammar (custom) tool.
			// 判别联合把 JSON 参数解析和 custom 原文包装分成两种状态。
			type ToolCallInput =
				// readonly 只限制 TS 字段重新赋值，解析器对象本身仍可 append。
				| { readonly kind: "json"; readonly arguments: ToolCallArgumentsStream }
				// custom 分支保留参数名和可变缓冲；readonly 不冻结 buffer 内容。
				| { readonly kind: "custom"; readonly property: string; readonly buffer: GrammarToolInputJsonBuffer };
			// 一条工具调用的远端索引可晚到，input 类型也可能从 JSON 切为 custom。
			type ToolCallState = { streamIndex: number | undefined; input: ToolCallInput };
			// 本适配可能生成的统一块类型联合，不包含图片输出块。
			type StreamingBlock = TextContent | ThinkingContent | ToolCall;
			// 远端工具增量局部结构，字段可能分片晚到，as 不会运行时验证它。
			type StreamingToolCallDelta = {
				// 供应商并行调用的索引，不是 output.content 的下标。
				index?: number;
				// 调用 id 可在后续分片才出现。
				id?: string;
				// 原始 type 可缺省，实际分支主要根据 function/custom 对象判定。
				type?: string;
				// 普通工具以 JSON 字符串片段传 arguments，名称也可迟到。
				function?: { name?: string; arguments?: string };
				// custom 工具以原始字符串传 input，稍后包装进统一参数对象。
				custom?: { name?: string; input?: string };
			};

			// 同一回答始终复用一个文本块，后续文字追加到它，不每个 delta 新建块。
			let textBlock: TextContent | null = null;
			// 思考同样复用一块；无文字也可因 reasoning_details 创建。
			let thinkingBlock: ThinkingContent | null = null;
			// 单独记是否收到真值 finish_reason，区别默认 pending 与兼容 EOF 回退。
			let hasFinishReason = false;
			// 远端索引→调用块，支持并行分片交错到达。
			const toolCallBlocksByIndex = new Map<number, ToolCall>();
			// 调用 id→调用块，用于没有索引但有 id 的后续分片。
			const toolCallBlocksById = new Map<string, ToolCall>();
			// 块对象引用→私有解析状态，解析器/缓冲不放入公开 partial 内容。
			const toolCallStates = new Map<ToolCall, ToolCallState>();
			// as 仅收窄数组静态类型；blocks 和 output.content 是同一数组引用。
			const blocks = output.content as StreamingBlock[];
			/**
			 * 查公开内容数组中某个块对象的当前位置，返回下标或 -1，无修改。
			 * 例工具索引是 0，但前面已有思考块时公开 contentIndex 可能是 1。
			 */
			// 通过对象引用找公开块下标；远端 tool_calls.index 和这里下标是两回事。
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			/**
			 * 为 grammar 原文创建新的私有输入状态，返回带 kind=custom 的对象，无外部修改。
			 * 例属性 code 会把后续原始字符串包装为统一参数 {code:...} 的 JSON 增量；缓冲初始未开始/未闭合。
			 */
			const customInput = (property: string): ToolCallInput => ({
				// kind 字面量用于静态分支收窄。
				kind: "custom",
				// 对象属性简写，记录原始输入要包装到哪个参数属性。
				property,
				// buffer 保存原文和 JSON 字符串包装是否已开始/闭合的状态。
				buffer: { input: "", started: false, closed: false },
			});
			/**
			 * 结束一个已登记块，输入块引用，返回 void；会修改思考签名/工具最终参数、清私有状态并发送对应 end 事件。
			 * 文本直接结束，思考先写 detail 签名，工具按 JSON/custom 收尾；例参数预览未闭合时 finish 可能记录 argumentsError。
			 * 只表示内容/调用参数结束，不执行工具；正常 EOF 后统一调用，流中途异常不会自动给所有块补 end。
			 */
			const finishBlock = (block: StreamingBlock) => {
				// 按对象引用找到公开内容下标，而非使用工具远端索引。
				const contentIndex = getContentIndex(block);
				// 不在公开数组中的块不发结束事件。
				if (contentIndex === -1) {
					// 直接结束此 helper，不影响其他块的收尾。
					return;
				}
				// 文字块的结束只需报告已有累计文本。
				if (block.type === "text") {
					// 向统一事件通道写文字结束对象。
					stream.push({
						// text_end 表示该文本块接收结束，不是整条回答 done。
						type: "text_end",
						// 属性简写带上公开数组位置。
						contentIndex,
						// content 是块全部文字，不是最后一个增量。
						content: block.text,
						// partial 仍引用当前可变 output。
						partial: output,
					});
					// 思考块在结束前还要补结构化回放签名。
				} else if (block.type === "thinking") {
					// 只在收过 detail 时覆盖 thinkingSignature。
					applyStreamedReasoningDetails(block);
					// 推送思考块收尾事件。
					stream.push({
						// thinking_end 不代表服务器公开了完整内部推理过程。
						type: "thinking_end",
						// 报告公开思考块下标。
						contentIndex,
						// 思考可见正文可能为空，仅有加密元数据。
						content: block.thinking,
						// 附当前统一消息引用。
						partial: output,
					});
					// 工具调用在此只结束参数流，不实际运行工具。
				} else if (block.type === "toolCall") {
					// ! 是非空断言，依赖每个已建调用块都登记状态的内部约定，不加运行时检查。
					const input = toolCallStates.get(block)!.input;
					// 移除这个块的私有解析状态；索引/id 表未在此主动清空。
					toolCallStates.delete(block);
					// 判别联合按 kind 缩窄为 custom 缓冲状态。
					if (input.kind === "custom") {
						// 封闭包装参数的 JSON 字符串/对象，undefined 表示不另传完整替代原文。
						const delta = closeGrammarToolInputJson(input.buffer, input.property, undefined);
						// 有需要补发的 JSON 结尾才写增量，空串与 undefined 是不同值。
						if (delta !== undefined) {
							// 把收尾片段也按统一参数增量事件发送。
							stream.push({
								// 同样是 toolcall_delta，不新建调用块。
								type: "toolcall_delta",
								// 继续对应同一个公开块位置。
								contentIndex,
								// 例如补 JSON 结束引号/括号；这是序列化参数片段，不是新模型文字。
								delta,
								// 附当前统一消息引用。
								partial: output,
							});
						}
						// 普通 JSON 调用走完整原文解析，区别增量容错预览。
					} else {
						// 将 finish 的 arguments/argumentsError 覆盖进块；坏参数通常记错误字段而非立刻执行。
						Object.assign(block, input.arguments.finish());
					}
					// 参数收尾后发送调用块结束事件。
					stream.push({
						// toolcall_end 表示模型参数已接收完，不表示工具执行完成。
						type: "toolcall_end",
						// 公开内容块位置。
						contentIndex,
						// 带最终调用对象，其中可能包含 argumentsError。
						toolCall: block,
						// 同时带本轮当前完整 partial 引用。
						partial: output,
					});
				}
			};
			/**
			 * 取得本轮唯一文字块，第一次才创建、加入公开数组并发 text_start，返回可修改引用。
			 * 例先思考再正文时文字块下标可能是 1；后续正文分片复用该块，不新建第二块。
			 */
			const ensureTextBlock = () => {
				// 第一次非空文本才建块，后续都复用现有引用。
				if (!textBlock) {
					// 初始文本为空，后面再追加本次 delta。
					textBlock = { type: "text", text: "" };
					// 加入共享公开数组，顺序是首次建块顺序。
					blocks.push(textBlock);
					// 创建时只发一次 text_start，内容尚未追加本片段。
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				// 返回可继续修改的唯一文本块。
				return textBlock;
			};
			/**
			 * 取得本轮唯一思考块，输入初始签名，第一次才创建并发 thinking_start，返回块引用。
			 * 例只收到 reasoning_details 也创建 thinking="" 的块；已经存在时新签名入参不会覆盖旧签名，收尾的结构化 detail 可覆盖。
			 */
			const ensureThinkingBlock = (thinkingSignature: string) => {
				// 第一次思考文字或有效 detail 才创建思考块。
				if (!thinkingBlock) {
					// 建立新的思考内容对象。
					thinkingBlock = {
						// 判别标签 thinking 让 TS 识别后续 thinking 字段。
						type: "thinking",
						// 原文从空字符串开始，加密 detail 本身不填可见文字。
						thinking: "",
						// 初始签名记录原文字段名或空串；后续累计 detail 可在收尾时覆盖。
						thinkingSignature,
					};
					// 以首次出现顺序登记公开块。
					blocks.push(thinkingBlock);
					// 发一次 thinking_start，不在此发 delta。
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				// 若块已存在直接返回；不会用新入参重写已有签名。
				return thinkingBlock;
			};
			/**
			 * 将一个远端工具增量接到对应公开块，返回 {block,state}，会改索引/id 表、块字段及私有解析状态，必要时发 start。
			 * 流程：优先索引找→再 id 找→新建→补晚到索引/名称→必要时从 JSON 切 custom。
			 * 例调用 A/B 的参数交错到达按 index 保持各自解析器；缺 index 又缺 id 的分片无法保证归并。
			 * 只补空名称，不拼接名称片段；已为 custom 后名称晚到也不重新选择参数属性，均为这里现有行为。
			 */
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				// 远端数据边界沿用数字索引判断；不验证整数/非负，NaN 仍是 number。
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				// function 名优先；?? 保留空串，不因空串再尝试 custom 名。
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				// 先按索引找块；let 允许改用 id 查找或新建。
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				// 索引没找到且 id 真值时，再按 id 回退查找。
				if (!block && toolCall.id) {
					// 允许先 id 后索引到来的调用片段接回既有块。
					block = toolCallBlocksById.get(toolCall.id);
				}
				// 两种查询都没结果时创建新块；缺索引且缺 id 的重复片段无法自动归并。
				if (!block) {
					// Note: the "input" fallback here should/must not be taken.  in case the LLM makes up
					// a tool we don't knwo about, we at least have a place to stash our stuff.
					// 初建时判断该片段是否仅含 custom，而非 function。
					const customInputProperty =
						// custom 有声明用其属性名，否则放 input；两种对象都有则先走 JSON 路径。
						toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
					// 创建公开统一调用对象，不把解析器写到里面。
					block = {
						// 固定 type 为 toolCall。
						type: "toolCall",
						// id 真值则保留，否则暂记空串，后续可补。
						id: toolCall.id || "",
						// 记录当前已经知道的名称，允许为空待补。
						name,
						// 计算属性名 [customInputProperty] 把原始文本放指定键；普通 JSON 初始为空对象。
						arguments: customInputProperty !== undefined ? { [customInputProperty]: "" } : {},
					};
					// 使用块对象本身作为私有状态 Map 的键。
					toolCallStates.set(block, {
						// 保留目前可用的远端调用索引。
						streamIndex,
						// 按协议种类选择不同输入状态。
						input:
							// 有属性名才建立 custom 包装状态，空属性名也不是 undefined。
							customInputProperty !== undefined
								? // 每个 custom 调用独立缓冲，避免并行调用串文。
									customInput(customInputProperty)
								: // 普通 JSON 调用各有一个增量解析实例。
									{ kind: "json", arguments: new ToolCallArgumentsStream() },
					});
					// 索引存在时登记，0 不会被误当缺省。
					if (streamIndex !== undefined) {
						// 同索引后续分片接回同一个块。
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					// id 非空时才登记 id 映射。
					if (toolCall.id) {
						// 同 id 会覆盖旧表项，不在此验证不同调用是否错误复用了 id。
						toolCallBlocksById.set(toolCall.id, block);
					}
					// 新块仅在此加入公开内容数组一次。
					blocks.push(block);
					// 为新工具调用发开始事件。
					stream.push({
						// toolcall_start 只说明模型开始给调用，不是执行工具。
						type: "toolcall_start",
						// 计算其公开内容位置，可能不同于远端 index。
						contentIndex: getContentIndex(block),
						// 附带共享消息引用。
						partial: output,
					});
				}
				// 依赖既有/新建块总有状态的内部约定，! 不提供运行时保护。
				const state = toolCallStates.get(block)!;
				// 如果早先只有 id、现在才来索引，就补索引状态。
				if (streamIndex !== undefined && state.streamIndex === undefined) {
					// 原地记住晚到索引，不覆盖已经有的状态索引。
					state.streamIndex = streamIndex;
					// 也建立索引到块的映射供后续片段查找。
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				// 每次有非空 id 都维护映射。
				if (toolCall.id) {
					// 这里只登记映射，不改块的 id 字段；调用处会补空 id。
					toolCallBlocksById.set(toolCall.id, block);
				}
				// 仅在原名为空且新名非空时补名称，不拼接名称片段或覆盖已有名字。
				if (!block.name && name) {
					// 原地补名称。
					block.name = name;
				}
				// 后续明确变成仅 custom 且先前为 JSON 时，转换输入状态。
				if (toolCall.custom && !toolCall.function && state.input.kind !== "custom") {
					// 以已知块名查属性；未知名称默认 input，不强行宣称是已声明工具。
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					// 重置公开参数为原文空串，早先 JSON 预览不会继续使用。
					block.arguments = { [customInputProperty]: "" };
					// 换新 custom 缓冲；已经为 custom 时即使名称晚到也不重新选择属性。
					state.input = customInput(customInputProperty);
				}
				// 一起返回公开块和私有状态，供当前片段追加。
				return { block, state };
			};

			// for await 逐个等待 SDK 异步流；throw 会按迭代协议尝试结束迭代器，清理能力依 SDK。
			for await (const chunk of openaiStream) {
				// 原始 chunk 在本适配过滤/修改 output 前先交观察器并等待，抛错会终止本轮。
				await options?.onProviderStreamEvent?.(chunk, model);
				// 兼容远端数据边界的粗检查，只过滤假值/非对象；不完整验证 chunk schema。
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				// ||= 只在尚无真值 responseId 时采用 chunk.id，不检验所有 chunk 是否同 id。
				output.responseId ||= chunk.id;
				// 实际模型字符串非空且不同于目录 id 才记录路由模型。
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					// 只保留第一个非空不同模型，不随每片覆盖。
					output.responseModel ||= chunk.model;
				}
				// 顶层 usage 存在则认为它是本次累计用量。
				if (chunk.usage) {
					// 整份替换 usage，而不是每个 chunk 的 token 累加。
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				// 兼容边界确认 choices 是数组后只取第一个候选，其他候选不合并。
				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				// 只含 usage 的末尾 chunk 可无 choice，上面用量已处理再跳过内容分支。
				if (!choice) continue;

				// Fallback: some providers (e.g., Moonshot) return usage
				// in choice.usage instead of the standard chunk.usage
				// 顶层缺 usage 才尝试供应商 choice.usage 扩展；原有 any 绕过 SDK 静态缺字段。
				if (!chunk.usage && (choice as any).usage) {
					// 同样按完整累计用量解析并替换，未对这个扩展做完整 schema 验证。
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				// 只对真值 finish_reason 处理，null 不触发结束映射。
				if (choice.finish_reason) {
					// 保留供应商原始原因用于诊断。
					output.rawStopReason = choice.finish_reason;
					// 映射为统一停止原因和可选错误文字。
					const finishReasonResult = mapStopReason(choice.finish_reason);
					// 更新统一状态；即使已收到 finish_reason，仍继续消费后续 usage/chunk。
					output.stopReason = finishReasonResult.stopReason;
					// 只有映射给出真值错误才写 errorMessage，不在此清掉已有错误。
					if (finishReasonResult.errorMessage) {
						// 保留过滤/网络/未知结束码的可读原因。
						output.errorMessage = finishReasonResult.errorMessage;
					}
					// 记下确实收过结束原因，与无原因 EOF 区分。
					hasFinishReason = true;
				}

				// 有 delta 才处理思考、文本、工具内容；usage/finish_reason 已先处理。
				if (choice.delta) {
					// Handle reasoning before content: some proxies (e.g. LiteLLM) aggregate reasoning and
					// answer into one delta, and the thinking block must precede the text block.
					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints)
					// Use the first non-empty reasoning field to avoid duplication
					// (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
					// 按固定优先顺序找首个非空推理字段，避免同一思考同时以多个别名重复计入。
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					// 静态当作 unknown 字段记录访问扩展属性；as 不检查实际对象形状。
					const deltaFields = choice.delta as Record<string, unknown>;
					// null 表示本 chunk 尚未找到有效原文字段。
					let foundReasoningField: string | null = null;
					// 逐个尝试三个兼容字段名。
					for (const field of reasoningFields) {
						// 索引访问未知扩展字段值。
						const value = deltaFields[field];
						// 远端数据只有非空字符串才作为思考增量。
						if (typeof value === "string" && value.length > 0) {
							// 记录命中的第一个字段名。
							foundReasoningField = field;
							// 找到后停止搜索；其他字段即使非空也忽略。
							break;
						}
					}

					// 找到思考字段才继续。
					if (foundReasoningField) {
						// 再取该字段值，静态类型仍是 unknown。
						const delta = deltaFields[foundReasoningField];
						// 再次收窄为非空字符串才能拼接，原行为保留。
						if (typeof delta === "string" && delta.length > 0) {
							// 签名在原文协议中用来记下下轮应回填的字段名，不必是加密签名。
							const thinkingSignature =
								// opencode-go 返回 reasoning 时，回放要求用 reasoning_content。
								model.provider === "opencode-go" && foundReasoningField === "reasoning"
									? // 将这个特例的回放字段改成 reasoning_content。
										"reasoning_content"
									: // 其他情况使用当前实际命中的字段名。
										foundReasoningField;
							// 先保证有思考块，因此同片同时含正文时思考创建在正文前。
							const block = ensureThinkingBlock(thinkingSignature);
							// 原地追加当前思考文字，不插分隔符。
							block.thinking += delta;
							// 发出只含本片的可见思考增量。
							stream.push({
								// 统一事件标签 thinking_delta。
								type: "thinking_delta",
								// 使用公开块下标。
								contentIndex: getContentIndex(block),
								// delta 属性简写，值是新增文字。
								delta,
								// 附当前统一消息引用。
								partial: output,
							});
						}
					}

					// 结构化 reasoning_details 作为未知扩展字段读取，不假定 SDK 类型覆盖它。
					const reasoningDetails = (choice.delta as { reasoning_details?: unknown }).reasoning_details;
					// 只有数组才遍历；不像历史数组解析，这里会逐项忽略坏项而保留其他项。
					if (Array.isArray(reasoningDetails)) {
						// 按远端顺序处理 detail。
						for (const detail of reasoningDetails) {
							// 未知/不合法变体被跳过，不为它单独抛错。
							if (!isOpenAIReasoningDetail(detail)) continue;
							// 即使没有可见思考文字，也建立思考块承载元数据，初始签名空串。
							ensureThinkingBlock("");
							// ??= 首次有效 detail 才建累计数组，后续复用。
							streamedReasoningDetails ??= [];
							// Keep provider replay data in the existing signature slot. OpenRouter streams
							// reasoning_details as deltas: consecutive text/summary deltas are merged into
							// logical entries, while encrypted entries remain opaque and discrete.
							// 按相邻类型合并文字/摘要，离散保留加密条目；不发可见 thinking_delta。
							appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
						}
					}

					// 正文只在非 null/undefined 且非空时处理。
					if (
						// 排除服务端明确给出的 null。
						choice.delta.content !== null &&
						// 排除未提供正文的片段。
						choice.delta.content !== undefined &&
						// 空字符串不创建文本块；纯空白非空仍保留。
						choice.delta.content.length > 0
					) {
						// 首次正文才建块，之后始终复用同一文本块。
						const block = ensureTextBlock();
						// 把新增文字附到累计文本末尾。
						block.text += choice.delta.content;
						// 给消费者发一个文本增量事件。
						stream.push({
							// 统一标签 text_delta。
							type: "text_delta",
							// 公开数组中文本块的位置。
							contentIndex: getContentIndex(block),
							// 只传本片正文，不重复累计全文。
							delta: choice.delta.content,
							// partial 仍引用当前可变消息。
							partial: output,
						});
					}

					// 工具调用增量存在时逐项处理；不是执行这些工具。
					if (choice?.delta?.tool_calls) {
						// 本地扩展类型含 custom，断言本身不校验远端数组成员。
						for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
							// 按索引/id 复用或新建块，同时取得该调用私有解析状态。
							const { block, state } = ensureToolCallBlock(toolCall);
							// 原 id 为空且现在有真值 id 才补写，不覆盖已有非空 id。
							if (!block.id && toolCall.id) {
								// 更新公开调用 id。
								block.id = toolCall.id;
								// 同时让后续可用此 id 查到块。
								toolCallBlocksById.set(toolCall.id, block);
							}
							// 普通 function 名优先，再选 custom 名。
							const name = toolCall.function?.name ?? toolCall.custom?.name;
							// 仅缺名称时补值，不拼接/替换已有名。
							if (!block.name && name) {
								// 原地补公开名称。
								block.name = name;
							}

							// 只有 id/name 的片段也会发空 delta，默认从空串开始。
							let delta = "";
							// 局部引用当前协议解析状态，判别 kind 后可安全访问对应字段。
							const input = state.input;
							// 普通 JSON 原文非空且状态确为 json 时处理。
							if (toolCall.function?.arguments && input.kind === "json") {
								// 事件增量保留供应商发来的 JSON 片段原样。
								delta = toolCall.function.arguments;
								// 增量解析器给当前对象预览；容错预览不等于参数 schema 已合法。
								block.arguments = input.arguments.append(delta);
								// 前面的 JSON 条件不满足时，尝试 custom 原文且状态为 custom 的路径。
							} else if (toolCall.custom?.input && input.kind === "custom") {
								// custom 事件 delta 需要先做 JSON 字符串转义包装。
								delta =
									// helper 返回包装增量，若未产生增量用空串；它不验证 grammar 是否被满足。
									appendGrammarToolInputJsonDelta(input.buffer, input.property, toolCall.custom.input) ?? "";
								// 公开参数里放累计原文值，计算属性名由工具声明决定。
								block.arguments = { [input.property]: input.buffer.input };
							}
							// 每个工具片段均推一个参数增量事件，delta 可为空。
							stream.push({
								// 统一标签 toolcall_delta。
								type: "toolcall_delta",
								// 定位同一个公开调用块。
								contentIndex: getContentIndex(block),
								// 传 JSON 参数序列化片段，而非预览对象本身。
								delta,
								// 调用方同时可从 partial 读取当前预览。
								partial: output,
							});
						}
					}
				}
			}

			// SDK 流正常耗尽后，按首次创建顺序为所有块收尾。
			for (const block of blocks) {
				// 普通参数在这里最终解析；此时甚至尚未检查是否有有效 finish_reason。
				finishBlock(block);
			}
			// 收完仍检查取消标志，防止用户取消后报告 done。
			if (options?.signal?.aborted) {
				// 进入统一 catch，已有块结束事件不会撤回。
				throw new Error("Request was aborted");
			}

			// 当前协议映射通常不产生 aborted，这里仍保留统一状态检查。
			if (output.stopReason === "aborted") {
				// 将取消状态转入统一失败收尾。
				throw new Error("Request was aborted");
			}
			// 只有明确声明不支持 finish_reason、且确实没收到时，才允许 EOF 推断。
			if (!hasFinishReason && !compat.supportsFinishReason) {
				// 含任何工具调用则推断 toolUse，否则 stop；不验证该调用能否执行。
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			}
			// 过滤/网络/未知原因已经映射为 error 时，不报告 done。
			if (output.stopReason === "error") {
				// 保留映射错误文案，否则用固定回退。
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			// 需要 finish_reason 却缺少，或状态仍 pending，都视为不完整流。
			if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
				// 缺终态失败，即使已经收到文字或参数也不当作完整成功。
				throw new Error("Stream ended without finish_reason");
			}

			// 发送统一成功终态，reason 可为 stop/length/toolUse。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 关闭本地通道，让 for await 结束。
			stream.end();
			// 捕获请求/钩子/迭代/收尾异常；不会回滚公开部分内容。
		} catch (error) {
			// 失败也遍历已经创建的内容块。
			for (const block of output.content) {
				// 只有思考块需要补序列化回放元数据。
				if (block.type === "thinking") {
					// 保留已收 detail，不在这里补发 thinking_end 或其他未完成块结束事件。
					applyStreamedReasoningDetails(block);
				}
			}
			// 捕获时 signal 已取消就记 aborted，否则任何失败都记 error。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// 从未知抛出值提取格式化文字。
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			// Some providers via OpenRouter give additional information in this field.
			// normalizeProviderError already stringifies the parsed body (error.error)
			// into errorMessage, so only append the raw metadata when it is not already
			// present to avoid double-printing it.
			// 供应商扩展 raw 元数据通过既有 any/可选链读取，不是严格 schema 校验。
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			// 真值且字符串形式未包含在主错误时才补，减少重复；不做敏感内容脱敏。
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				// 字符串插值附加原始元数据，保留此前错误文字。
				output.errorMessage += `\n${rawMetadata}`;
			}
			// error 事件携带当前部分消息；之前可能尚未发 start，也可能已经流了很多内容。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 失败也结束事件通道。
			stream.end();
		}
		// 调用异步闭包，外层不 await 它。
	})();

	// 同步返回同一流对象，调用方可迭代或 result()。
	return stream;
};

/**
 * 把统一简单选项转为 Chat Completions 专用选项并返回真实请求事件流，会触发网络调用。
 * 先同步校验凭证来源，再公共默认值、档位钳制/off 转缺省、传预算表并委托 stream。
 * 例 reasoning:"high" 与 thinkingBudgets.high=4096 可用于预算字段；缺凭证在返回流之前同步抛错。
 */
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	// 静态 API 限定为 Chat Completions。
	model: Model<"openai-completions">,
	// 统一会话供真正 stream 做规范化/转换。
	context: TranscriptContext,
	// 跨供应商简单选项，不要求调用方认识原生 reasoningEffort。
	options?: SimpleStreamOptions,
	// 包装层同步执行，因此前置凭证/选项错误可能直接 throw。
): AssistantMessageEventStream => {
	// 仅先校验凭证来源存在，返回占位值未使用，实际流入口会再选择 key。
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	// 公共字段展开后继续补供应商专用字段。
	const base = {
		// buildBaseOptions 复制钩子/认证/上限等，并应用公共默认。
		...buildBaseOptions(model, context, options, options?.apiKey),
		// 统一工具选择继续交给原生入口。
		toolChoice: options?.toolChoice,
		// satisfies 在开发期检查对象形状，运行时不转换也不验证。
	} satisfies OpenAICompletionsOptions;
	// 有逻辑档位时按模型能力选择可支持的档位。
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	// off 转为未指定；模型若不支持 off，前一步可能选择最低可用档位。
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	// 委托真正请求函数，不维护重复的传输/流解析实现。
	return stream(model, context, {
		// 先复制公共选项。
		...base,
		// 再写转换后的原生档位。
		reasoningEffort,
		// 本次预算覆盖表继续传入，用于顶层预算字段或模板变量。
		thinkingBudgets: options?.thinkingBudgets,
		// 再次只做静态选项兼容检查。
	} satisfies OpenAICompletionsOptions);
};

/**
 * 创建 SDK 客户端并组装默认头，输入模型、历史、key 和可选配置，返回新实例，构造本身不发本次请求。
 * 合并顺序：身份→模型→Copilot 动态→条件亲和→显式请求；SDK 随后另合并自身头。
 * 例设置 sendSessionAffinityHeaders=false 会跳过自动亲和头，显式 optionsHeaders 仍可自行写同名头。
 */
function createClient(
	// 模型决定根 URL、默认头和供应商。
	model: Model<"openai-completions">,
	// 会话用于 Copilot 动态头，其他供应商并不在此转换消息。
	context: TranscriptContext,
	// 已选择的 SDK key，可以是授权头占位字符串。
	apiKey: string,
	// 本次显式头可省略，允许 null 表达删除。
	optionsHeaders?: ProviderHeaders,
	// 身份选项影响身份头，不替代显式认证。
	identity?: ClientIdentity,
	// typeof 在类型位置取全局 fetch 签名，不执行请求。
	fetch?: typeof globalThis.fetch,
	// sessionId 为可选亲和标识，不含本地历史内容。
	sessionId?: string,
	// 未传能力对象时现场从模型解析；默认参数只在参数为 undefined 时使用。
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	// 先身份头、后模型头，同名本地属性后写覆盖。
	const headers: ProviderHeaders = { ...getIdentityHeaders(model, identity), ...model.headers };
	// 精确 github-copilot 供应商才加专用动态头。
	if (model.provider === "github-copilot") {
		// 完整历史包含图像就可能启用 vision 请求头。
		const hasImages = hasCopilotVisionInput(context.messages);
		// 推导发起方等 Copilot 头。
		const copilotHeaders = buildCopilotDynamicHeaders({
			// 传完整消息，不只传最后一条。
			messages: context.messages,
			// 采用已经计算的图片标记。
			hasImages,
		});
		// 动态头覆盖身份/模型同名属性。
		Object.assign(headers, copilotHeaders);
	}

	// 非空 sessionId 且开关允许时才自动发送亲和头。
	if (sessionId && compat.sendSessionAffinityHeaders) {
		// OpenRouter 用专属形式。
		if (compat.sessionAffinityFormat === "openrouter") {
			// 仅写 x-session-id。
			headers["x-session-id"] = sessionId;
			// 所有非 OpenRouter 格式进入本分支，包括 none。
		} else {
			// openai 格式才额外写 session_id。
			if (compat.sessionAffinityFormat === "openai") {
				// 写 OpenAI 会话头，不作为模型文本。
				headers.session_id = sessionId;
			}
			// 其他非 OpenRouter 格式也会写请求标识头。
			headers["x-client-request-id"] = sessionId;
			// 并额外写 x-session-affinity；因此 format=none 本身不会让本分支不发头。
			headers["x-session-affinity"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	// 存在本次头配置才执行合并。
	if (optionsHeaders) {
		// 显式请求头最后覆盖，可用 null 交 SDK 删除自动/default 头。
		Object.assign(headers, optionsHeaders);
	}

	// 构造 SDK 实例本身不发 Chat Completions 请求。
	return new OpenAI({
		// 安装 SDK 默认生成 Bearer 认证，之后 defaultHeaders 可覆盖它。
		apiKey,
		// 用模型根 URL，不在此验证是官方或可信地址。
		baseURL: model.baseUrl,
		// 允许浏览器构造，不承诺这里能隐藏凭证。
		dangerouslyAllowBrowser: true,
		// 可替换传输，测试可用假 SDK 或内存 fetch。
		fetch,
		// SDK 还会合并平台/认证等头；当前默认头位于自动认证之后。
		defaultHeaders: headers,
	});
}

/**
 * 把完整统一会话和原生配置转成 Chat Completions 请求体，无网络；消息/约束转换错误会抛出。
 * 先选工具支持模式并转换消息→缓存/上限/工具→供应商思考格式和预算→路由→最后采样字段覆盖。
 * 例本地 qwen 模型可用 enable_thinking，OpenRouter 用 reasoning.effort；同一个逻辑 high 不代表所有协议使用相同字段。
 * 返回新请求结构，缓存标记只修改已经转换出的消息/工具；末尾采样字段和后续 payload 钩子仍能覆盖已命名参数。
 */
function buildParams(
	// 模型提供目录 id、能力、映射与默认采样配置。
	model: Model<"openai-completions">,
	// 完整会话用于消息转换与有序工具声明折叠。
	context: TranscriptContext,
	// 本次专有请求配置可省略。
	options?: OpenAICompletionsOptions,
	// 缺省时按供应商/URL 启发式补兼容值，再用模型显式配置覆盖。
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	// 缺省缓存策略按显式请求/环境/default 解析。
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env),
	// 默认创建 grammar 属性映射；ReadonlyMap 只限制静态写接口，不冻结 Map。
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		// 扫描历史所有声明供工具回放。
		getDeclaredTools(context.messages),
		// 是否启用 grammar 来自解析后的兼容设置。
		compat.supportsOpenAIGrammarTools,
	),
) {
	// 决定顶层工具与历史中途工具声明如何分工。
	const transcriptTools = resolveTranscriptTools(
		// 工具来源是有序消息里的声明/移除信息。
		context.messages,
		// 只有两个能力都精确为 true 才启用 additions。
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true
			? // 保留中途工具添加声明，不折叠到初始全部工具。
				"additions"
			: // 否则按 none 支持模式折叠历史声明。
				"none",
	);
	// 把统一消息完整转为 Chat Completions messages。
	const messages = convertMessages(model, context, compat, {
		// 历史 grammar 调用需要同一属性映射恢复原始 custom input。
		grammarToolInputProperties,
	});
	// 按 cacheControlFormat 和缓存策略决定 Anthropic 风格标记。
	const cacheControl = getCompatCacheControl(compat, cacheRetention);

	// 新建流式请求体；静态 SDK 类型不等于远端运行时校验。
	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		// 使用目录 id 作为请求模型名。
		model: model.id,
		// 发送全部转换后的消息。
		messages,
		// 请求流式响应。
		stream: true,
		// 缓存路由键由下方两个条件之一开启。
		prompt_cache_key:
			// URL 字符串包含 api.openai.com 且不是 none 时启用；不是 hostname 校验。
			(model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
			// 或者 long 且模型允许长期缓存时也启用，不限官方 URL。
			(cacheRetention === "long" && compat.supportsLongCacheRetention)
				? // 将 sessionId 按共享长度规则限制；缺值则不写有效键。
					clampOpenAIPromptCacheKey(options?.sessionId)
				: // 条件不满足时字段为 undefined，JSON 序列化通常省略它。
					undefined,
		// long 且支持长期时请求 24h，不代表服务器保证命中/保留该时长。
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};

	// 除显式 false 外都请求流中 usage。
	if (compat.supportsUsageInStreaming !== false) {
		// 让兼容服务尽量给末尾累计 token 用量；中途取消仍可能收不到它。
		params.stream_options = { include_usage: true };
	}

	// 仅宣称支持 store 字段的兼容服务才发送它。
	if (compat.supportsStore) {
		// 请求不存储 completion 对象，不是禁止服务器日志/缓存的一般保证。
		params.store = false;
	}

	// 只处理真值上限，0/NaN 被省略，负数在此不会被钳制。
	if (options?.maxTokens) {
		// 部分兼容服务仍要求旧 max_tokens 字段。
		if (compat.maxTokensField === "max_tokens") {
			// Deprecated by OpenAI, but some OpenAI-compatible providers only accept max_tokens.
			// 静态断言允许赋旧字段，不增加运行时转换/验证。
			(params as { max_tokens?: number }).max_tokens = options.maxTokens;
			// 其他服务使用较新字段。
		} else {
			// 写 max_completion_tokens，数值直接采用调用方设置。
			params.max_completion_tokens = options.maxTokens;
		}
	}

	// undefined 才省略温度，所以 0 被保留。
	if (options?.temperature !== undefined) {
		// 本地不限制温度区间，由远端决定是否接受。
		params.temperature = options.temperature;
	}

	// 有当前请求工具才正常转换声明。
	if (transcriptTools.requestTools.length > 0) {
		// convertTools 可能因不满足 strict/grammar 约束而抛错。
		params.tools = convertTools(transcriptTools.requestTools, compat);
		// ZAI 工具流开关仅在这条非空工具分支处理。
		if (compat.zaiToolStream) {
			// 供应商扩展 tool_stream 不在 SDK 类型中，既有 any 仅绕静态限制。
			(params as any).tool_stream = true;
		}
		// 无当前工具但旧历史仍有调用/结果时补空工具数组。
	} else if (hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
		// 空数组满足某些代理的结构要求，不让旧工具重新变为可调用声明。
		params.tools = [];
	}

	// 只有启用 Anthropic 风格缓存时才改转换后对象。
	if (cacheControl) {
		// 在首个指令、末个工具、最后可标记会话消息上加缓存标记。
		applyAnthropicCacheControl(messages, params.tools, cacheControl);
	}

	// 合法字符串 none 也是真值，会继续传；无值则不写 tool_choice。
	if (options?.toolChoice) {
		// 选择配置按原生类型直接传递，不执行工具。
		params.tool_choice = options.toolChoice;
	}

	// 优先级显式为 0 时也保留，因为只排除 undefined。
	if (compat.vllmPriority !== undefined) {
		// vLLM 调度 priority 扩展透传，不在这里验证队列/权限含义。
		(params as any).priority = compat.vllmPriority;
	}

	// 选择顶层思考预算字段：显式字段优先，布尔别名其次。
	const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
	// 按本次输出上限计算预算，预留答案空间；不直接修改 max token 字段。
	const thinkingBudget = resolveClampedThinkingBudget(model, options, params);

	// 格式为 zai 且目录标注有思考能力才走该分支。
	if (compat.thinkingFormat === "zai" && model.reasoning) {
		// Omit 去掉 SDK 原 reasoning_effort 限制，再以交叉类型支持供应商字符串；同一个 params 引用。
		const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
			// ZAI thinking 对象支持开/关及是否清除旧思考。
			thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
			// 允许目录映射提供供应商自己的 effort 字符串。
			reasoning_effort?: string;
		};
		// 有原生档位即启用并保留旧思考，否则发 disabled；不依赖 supportsReasoningEffort。
		zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
		// 额外 effort 只有档位存在且能力允许才发送。
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			// 取请求档位的目录映射，可能是字符串/null/undefined。
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			// 这里仅 undefined 回退；映射 null 会保留到下一步并因此省略字符串字段。
			const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
			// 只有字符串才能发为供应商 effort，null 被跳过。
			if (typeof effort === "string") {
				// 写 ZAI 原生 reasoning_effort。
				zaiParams.reasoning_effort = effort;
			}
		}
		// Qwen 普通布尔开关协议，与 chat-template 形式分开。
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		// !! 把档位真值变成 boolean；不写字符串 high 到 enable_thinking。
		(params as any).enable_thinking = !!options?.reasoningEffort;
		// 可选原生 effort 仍受能力开关限制。
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			// 此处 ?? 使 null 映射也回退请求档位，与上方 ZAI 的 undefined 判断不同。
			const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
			// 既有字符串检查保持原行为。
			if (typeof effort === "string") {
				// 把 effort 写在顶层，不写进 enable_thinking 对象。
				(params as any).reasoning_effort = effort;
			}
		}
		// Qwen 的另一种服务协议要求 chat_template_kwargs。
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		// 新建模板参数对象；这条分支不使用通用模板变量表。
		(params as any).chat_template_kwargs = {
			// 开关来自是否请求档位。
			enable_thinking: !!options?.reasoningEffort,
			// 固定请求保留历史思考，此值不受本次 off 自动改变。
			preserve_thinking: true,
		};
		// 通用 chat-template 格式按声明的模板变量生成对象。
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		// 解析字面量/启用/档位/预算变量；用已经钳制的预算。
		const chatTemplateKwargs = buildChatTemplateValues(model, options, compat.chatTemplateKwargs, thinkingBudget);
		// 所有项都被省略时不写整个模板对象。
		if (chatTemplateKwargs) {
			// 把解析后的标量记录写进 chat_template_kwargs。
			(params as any).chat_template_kwargs = chatTemplateKwargs;
		}
		// Baseten 使用 chat_template_args 名称，而不是 kwargs。
	} else if (compat.thinkingFormat === "baseten" && model.reasoning) {
		// 仅在静态类型中扩展协议字段，仍是原 params 对象。
		const basetenParams = params as Omit<typeof params, "reasoning_effort"> & {
			// 参数名映射到已解析的 JSON 标量，不包括 undefined。
			chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
			// Baseten effort 允许自定义字符串。
			reasoning_effort?: string;
		};
		// 使用模型配置的 chatTemplateArgs 模板表。
		const chatTemplateArgs = buildChatTemplateValues(model, options, compat.chatTemplateArgs, thinkingBudget);
		// 至少一项解析成功才附带 args。
		if (chatTemplateArgs) {
			// 写 chat_template_args 供应商扩展。
			basetenParams.chat_template_args = chatTemplateArgs;
		}
		// 支持 effort 时，即使没请求档位，也会尝试 off 映射。
		if (compat.supportsReasoningEffort) {
			// 读取原生请求档位，可缺省。
			const requestedEffort = options?.reasoningEffort;
			// 开时查对应档位，关时查 off；这里没有把 null 映射自动回退。
			const mappedEffort = requestedEffort ? model.thinkingLevelMap?.[requestedEffort] : model.thinkingLevelMap?.off;
			// 仅 undefined 才回退请求值，null 随后被字符串检查排除。
			const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
			// 字符串才发送，非字符串/缺省不写。
			if (typeof effort === "string") {
				// 写 Baseten 原生顶层 effort。
				basetenParams.reasoning_effort = effort;
			}
		}
		// DeepSeek 专用协议使用 thinking.type。
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		// 请求档位为真值时开启。
		if (options?.reasoningEffort) {
			// 发送 enabled，不在该对象里写具体 high/medium。
			(params as any).thinking = { type: "enabled" };
			// 未请求档位且 off 映射非 null 才显式关闭；undefined 也满足该条件。
		} else if (model.thinkingLevelMap?.off !== null) {
			// 发送 disabled；off=null 则跳过，不承诺可彻底关闭所有模型内部推理。
			(params as any).thinking = { type: "disabled" };
		}
		// 若能力支持，再补具体 effort。
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			// 字段是供应商扩展，原有断言不做校验。
			(params as any).reasoning_effort =
				// null/undefined 映射都回退逻辑档位。
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
		// OpenRouter 嵌套 reasoning 对象统一不同上游协议。
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		// OpenRouter normalizes reasoning across providers via a nested reasoning object.
		// 交叉类型给 params 添加可选 reasoning 字段，不复制数据。
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		// 有请求档位时用开启路径。
		if (options?.reasoningEffort) {
			// 构造嵌套对象。
			openRouterParams.reasoning = {
				// effort 用非空映射，否则原逻辑档位；null 也回退。
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
			// 无档位且 off 非 null 时显式表达关闭/最低档位。
		} else if (model.thinkingLevelMap?.off !== null) {
			// off 映射缺省用 none；本地没有验证服务端接受这些字符串。
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
		// Ant Ling 仅在有请求档位时走专用路径；off 不在此主动发关闭对象。
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		// 只取目录映射，不自动回退 high 等统一词。
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		// 没有字符串映射就省略该字段。
		if (typeof effort === "string") {
			// 把映射 effort 写到 reasoning 对象；as 是静态扩展声明。
			(params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
		}
		// Together 使用嵌套 enabled，并可选顶层 effort。
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		// 扩展字段类型，Omit 去掉 SDK 固定 effort 联合以容纳供应商字符串。
		const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
			// reasoning 对象带 boolean 开关。
			reasoning?: { enabled: boolean };
			// 可选字符串 effort。
			reasoning_effort?: string;
		};
		// 每次都给 enabled 的 true/false，不只在开时发送。
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		// 开启且支持 effort 才补强度字段。
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			// 映射为空值时回退统一档位。
			togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
		// 某些服务要求顶层 thinking 是字符串而不是对象。
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		// 静态声明添加可选 string 字段。
		const stringThinkingParams = params as typeof params & { thinking?: string };
		// 有档位时发送映射后的开启值。
		if (options?.reasoningEffort) {
			// null/undefined 映射回退逻辑档位。
			stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
			// 未开且 off 非 null 才写关闭/最低值。
		} else if (model.thinkingLevelMap?.off !== null) {
			// 有字符串映射则采用，未配置用 none。
			stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
		}
		// 未匹配上述专有分支时，开启且支持 effort 才使用普通 OpenAI 字段。
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// OpenAI-style reasoning_effort
		// 按映射或原逻辑词写 reasoning_effort；上面命中的专用分支不会再落到这里。
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		// 普通格式未请求档位但支持 effort 时，只尝试显式 off 映射。
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// 读取目录 off，不默认构造 none。
		const offValue = model.thinkingLevelMap?.off;
		// 必须是字符串才发送；undefined/null 都省略。
		if (typeof offValue === "string") {
			// 写具体 off 值，和 Responses 默认 none 的策略不同。
			(params as any).reasoning_effort = offValue;
		}
	}

	// Cap reasoning with a top-level budget field. Independent of thinkingFormat: the
	// same server can serve zai, qwen or chat-template models. Reasoning and the answer
	// share max_tokens here, so an uncapped reasoning phase can consume the whole
	// response and leave no answer and no tool call.
	// 顶层预算与 thinkingFormat 独立；有字段名和正预算才写。
	if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
		// 计算属性名选择 thinking_budget 等字段；不是加到同名字面量键上。
		Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
	}

	// OpenRouter provider routing preferences
	// 仅模型原始 compat 的真值路由对象触发，空对象也是真值。
	if (model.compat?.openRouterRouting) {
		// 直接透传 OpenRouter 路由偏好，不在此选实际上游或校验它可达。
		(params as any).provider = model.compat.openRouterRouting;
	}

	// Vercel AI Gateway provider routing preferences
	// Vercel 路由同样从模型原始兼容配置读取。
	if (model.compat?.vercelGatewayRouting) {
		// 局部引用路由配置，没有复制或修改该对象。
		const routing = model.compat.vercelGatewayRouting;
		// only/order 有任一真值才写；空数组也是真值。
		if (routing.only || routing.order) {
			// 新建字符串数组记录，只保留被本分支支持的两个键。
			const gatewayOptions: Record<string, string[]> = {};
			// only 真值时传允许列表，原数组引用不复制。
			if (routing.only) gatewayOptions.only = routing.only;
			// order 真值时传顺序偏好，原数组引用不复制。
			if (routing.order) gatewayOptions.order = routing.order;
			// 供应商扩展包装在 providerOptions.gateway 下。
			(params as any).providerOptions = { gateway: gatewayOptions };
		}
	}

	// Last so model and request sampling parameters override named request fields.
	// 按逻辑档位合并模型/请求采样字段；没有档位用 off。
	const samplingParams = resolveSamplingParams(model, options?.reasoningEffort ?? "off", options?.samplingParams);
	// 有合并对象才应用，空对象也可通过。
	if (samplingParams) {
		// 最后同名覆盖，甚至能重写前面 token 上限/工具/思考开关；上面的限制不是最终不可更改闸门。
		Object.assign(params, samplingParams);
	}

	// 返回新请求体，没有在本函数发请求；调用方下一步还会执行 payload 钩子。
	return params;
}

/**
 * 选择兼容服务使用的顶层思考预算字段名，返回字符串联合或 undefined，无副作用。
 * 显式 thinkingTokenBudgetField 优先，否则 supportsThinkingTokenBudget=true 用 thinking_token_budget；例显式 thinking_budget 覆盖布尔别名。
 */
function resolveThinkingTokenBudgetField(
	// Pick 只要求预算选择相关两项，不需要整个兼容接口。
	compat: Pick<OpenAICompletionsCompat, "thinkingTokenBudgetField" | "supportsThinkingTokenBudget">,
	// 返回允许的字段名联合或 undefined。
): ThinkingTokenBudgetField | undefined {
	// 显式字段名真值时优先，不受布尔别名开关影响。
	if (compat.thinkingTokenBudgetField) return compat.thinkingTokenBudgetField;
	// 旧布尔别名开启时使用默认 thinking_token_budget。
	if (compat.supportsThinkingTokenBudget) return "thinking_token_budget";
	// 两者都没有则不发送顶层预算字段。
	return undefined;
}

/**
 * 计算可发给服务的正思考预算，输入模型、选项与已构造的输出上限，返回 number 或 undefined，不改参数。
 * 须有请求档位且模型 reasoning；候选预算按档位/覆盖取值，再按上限预留答案空间。例上限 4096、候选 8192 会钳制到共享规则允许值。
 */
function resolveClampedThinkingBudget(
	// 模型 maxTokens 是未显式设置请求上限时的兜底。
	model: Model<"openai-completions">,
	// 选项提供逻辑档位与分档预算覆盖。
	options: OpenAICompletionsOptions | undefined,
	// 局部结构只需要两个候选上限字段，可为空值。
	params: { max_tokens?: number | null; max_completion_tokens?: number | null },
	// 正预算返回 number，否则 undefined 表示省略。
): number | undefined {
	// 未请求档位或模型不标注 reasoning 时不产生预算。
	if (!options?.reasoningEffort || !model.reasoning) return undefined;
	// max_tokens 优先于 max_completion_tokens，再回退模型上限；?? 保留 0。
	const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
	// 用共享规则把思考预算压到输出上限内并预留答案空间。
	const budget = clampThinkingBudgetToAnswerRoom(
		// 根据逻辑档位和用户覆盖选候选预算，xhigh/max 按 helper 规则处理。
		thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
		// 传选出的输出上限，预算不独占整份上限。
		ceiling,
	);
	// 只有 >0 才返回；不是正数时省略预算字段/变量。
	return budget > 0 ? budget : undefined;
}

/**
 * 解析一组 chat template 参数，返回有字段的新记录或 undefined，不修改模板表。
 * 逐键调用变量解析器，只滤 undefined，保留 false/0/null；例 enable_thinking 变量在 off 时可得到 false，而缺预算项被省略。
 */
function buildChatTemplateValues(
	// 模型提供档位字符串映射。
	model: Model<"openai-completions">,
	// 原生选项决定当前是否请求思考。
	options: OpenAICompletionsOptions | undefined,
	// Record 描述任意参数名对应一个标量或变量描述对象。
	values: Record<string, ChatTemplateKwargValue>,
	// 可选的已钳制预算，预算缺失时对应变量可被省略。
	thinkingBudget?: number,
	// 结果要么是有字段的标量记录，要么 undefined；不产生空模板对象。
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	// 新建结果，不直接把模板配置对象改成解析值。
	const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};

	// Object.entries 枚举模板表自有可枚举键值。
	for (const [key, value] of Object.entries(values)) {
		// 每个值独立解析，可返回 undefined 请求省略。
		const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
		// false/0/null 都会保留，只有 undefined 被排除。
		if (resolved !== undefined) {
			// 用原参数名写入结果；普通属性赋值不是全面特殊键规范化。
			resolvedValues[key] = resolved;
		}
	}

	// 至少有一个结果键才返回对象，否则整体省略。
	return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

/**
 * 解析一个模板字面量或变量，返回 JSON 标量或 undefined，无状态修改。
 * 标量原样；变量先看 omitWhenOff，再解析 enabled/budget，剩余按档位映射；例 off 映射为 null 时档位变量省略，而字面量 null 仍保留。
 */
function resolveChatTemplateKwargValue(
	// 模型仅用于档位映射，不探测实际推理行为。
	model: Model<"openai-completions">,
	// 当前请求选项可缺省。
	options: OpenAICompletionsOptions | undefined,
	// 输入可能是原样标量，也可能是 $var 描述对象。
	value: ChatTemplateKwargValue,
	// 已钳制预算由外部计算，不在这里再计算一次。
	thinkingBudget?: number,
	// 返回标量或省略标记 undefined。
): ResolvedChatTemplateKwargValue | undefined {
	// 原有 typeof 在已声明联合中区分标量与变量对象；null 虽 typeof object 仍单独视为标量。
	if (typeof value !== "object" || value === null) {
		// 直接保留字面量，包括 null/false/0，不按 omitWhenOff 处理。
		return value;
	}

	// 原生 reasoningEffort 非空即认为“开”。
	const reasoningEffort = options?.reasoningEffort;
	// 变量声明 omitWhenOff 且没请求档位时先省略。
	if (!reasoningEffort && value.omitWhenOff) {
		// undefined 由外层过滤，不写入模板参数。
		return undefined;
	}
	// thinking.enabled 变量返回布尔开关。
	if (value.$var === "thinking.enabled") {
		// !! 把可选字符串变成 true/false。
		return !!reasoningEffort;
	}
	// thinking.budget 使用外层算好的数字。
	if (value.$var === "thinking.budget") {
		// 没有可用预算时返回 undefined，不伪造 0。
		return thinkingBudget;
	}

	// 剩余变量按类型约定是档位变量：开查当前映射、关查 off 映射。
	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	// 映射未定义回退请求值；映射是字符串采用；null 则省略，不把 null 当映射文字。
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}

/**
 * 按兼容格式和缓存偏好生成 Anthropic 风格控制对象，不创建实际缓存，无状态修改。
 * 非 anthropic 或 none 返回 undefined；其余 ephemeral，long 且支持长期时再加 ttl:1h。例 short 只有 type 字段。
 */
function getCompatCacheControl(
	// 能力对象指定缓存标记格式与长期支持。
	compat: ResolvedOpenAICompletionsCompat,
	// 缓存策略为 none/short/long。
	cacheRetention: CacheRetention,
	// 结果是兼容标记对象或 undefined，不是真正缓存句柄。
): OpenAICompatCacheControl | undefined {
	// 仅 Anthropic 风格且非 none 才创建标记。
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		// 其他协议/禁用缓存不写该扩展。
		return undefined;
	}

	// long 且支持长期则请求 1h，否则不带 ttl 使用服务默认。
	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	// 条件展开只在 ttl 存在时带字段，始终包含 type:ephemeral。
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

/**
 * 给已转换请求设置三个缓存断点，输入消息、可选工具与标记，返回 void，会原地修改这些新协议对象。
 * 依次首个指令、最后工具、最后能标记的会话消息；例最后一条是工具结果文字，则会话断点落到该结果，不一定是用户消息。
 */
function applyAnthropicCacheControl(
	// 这些是已经转换出的 SDK 消息，函数会原地改它们。
	messages: ChatCompletionMessageParam[],
	// 工具可能省略，不为加标记而创建新工具数组。
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	// 多个标记位置共享同一个配置对象引用。
	cacheControl: OpenAICompatCacheControl,
	// void 表示通过原地修改传递结果。
): void {
	// 首个 system/developer 消息尝试加标记。
	addCacheControlToSystemPrompt(messages, cacheControl);
	// 最后一个工具声明直接加标记。
	addCacheControlToLastTool(tools, cacheControl);
	// 逆序找最后一条能放文本标记的 user/assistant/tool 消息。
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

/**
 * 从前往后找到首个 system/developer 并尝试标记，返回 void，可能改其 content。
 * 遇首个指令就停止，即使该条没有可标记文字也不试第二条；例首个系统内容是非空字符串会变成带标记文本段数组。
 */
function addCacheControlToSystemPrompt(
	// 输入有序协议消息数组，不包含额外的旧 context.systemPrompt 字段。
	messages: ChatCompletionMessageParam[],
	// 同一缓存控制配置对象。
	cacheControl: OpenAICompatCacheControl,
	// 不返回是否成功；下面遇首个指令即返回。
): void {
	// 从头找指令消息。
	for (const message of messages) {
		// system 或 developer 均算指令，不选普通 user。
		if (message.role === "system" || message.role === "developer") {
			// 尝试在首个指令内容中加标记；内部可返回 false，这里不读取结果。
			addCacheControlToInstructionMessage(message, cacheControl);
			// 即使首个指令没可标记文本也停止，不继续找下一条指令。
			return;
		}
	}
}

/**
 * 从后往前找最近可加文本缓存标记的 user/assistant/tool 消息，返回 void，会改一条候选正文。
 * 空/无文本候选继续往前，成功即停；例最后 assistant 只含工具调用时可标记前一条用户文字。
 */
function addCacheControlToLastConversationMessage(
	// 从完整已转换会话逆序找缓存断点。
	messages: ChatCompletionMessageParam[],
	// 要附加的缓存配置。
	cacheControl: OpenAICompatCacheControl,
): void {
	// let 索引从最后一条倒数到 0，i-- 每次减一。
	for (let i = messages.length - 1; i >= 0; i--) {
		// 按索引取协议消息。
		const message = messages[i];
		// 仅会话/工具角色候选，跳过 system/developer。
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			// 底层实际加成功才停止，空内容消息会继续往前找。
			if (addCacheControlToMessage(message, cacheControl)) {
				// 已找到最近可标记文字，结束搜索。
				return;
			}
		}
	}
}

/**
 * 给最后一个工具声明加顶层 cache_control，返回 void，会原地改声明对象。
 * 无数组/空数组直接结束；例两工具 read/write 只给 write 声明加标记，不改变参数 schema。
 */
function addCacheControlToLastTool(
	// 可省略工具数组；类型来自 SDK 工具联合。
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	// 共享缓存标记配置。
	cacheControl: OpenAICompatCacheControl,
): void {
	// 不存在或空数组都没有最后工具。
	if (!tools || tools.length === 0) {
		// 直接结束，无任何对象修改。
		return;
	}

	// 取最后声明并静态扩展为可含 cache_control 的类型。
	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	// 在工具声明顶层加字段，不修改其 function.parameters。
	lastTool.cache_control = cacheControl;
}

/**
 * 为指令消息委托统一文本缓存标记，返回 boolean，会按需要改变 message.content。
 * 例 system 的字符串正文转成一个带标记的 text 段；没有可标记文本则 false。
 */
function addCacheControlToInstructionMessage(
	// 只接受 system/developer 类型，不接受普通消息角色。
	message: ChatCompletionInstructionMessageParam,
	// 共享标记对象。
	cacheControl: OpenAICompatCacheControl,
	// 返回 boolean 表示是否实际标记。
): boolean {
	// 委托统一文本内容处理，可能将字符串内容改为文本段数组。
	return addCacheControlToTextContent(message, cacheControl);
}

/**
 * 只允许 user/assistant/tool 角色走文本缓存标记，返回成功标志，会修改合格消息。
 * 例 system 传入该 helper 返回 false，指令由另一个入口处理；只含图片的用户消息也可能 false。
 */
function addCacheControlToMessage(
	// 任意 SDK 消息先由角色分支筛选。
	message: ChatCompletionMessageParam,
	// 共享标记对象。
	cacheControl: OpenAICompatCacheControl,
	// 非会话角色直接返回 false。
): boolean {
	// 按角色收窄后才能传给只支持这些正文类型的底层 helper。
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
		// 底层原地修改并返回是否成功。
		return addCacheControlToTextContent(message, cacheControl);
	}
	// system/developer 等不在此 helper 处理，另有指令入口。
	return false;
}

/**
 * 给正文最后一个文本段挂缓存标记，返回是否成功，会原地改消息/段。
 * 非空字符串先转 text 数组；数组倒序找 type=text；其他/无文本 false。例 [text,image] 标记 text，图片顺序不变。
 */
function addCacheControlToTextContent(
	// 参数是下列四类消息联合，均有可处理的正文。
	message: // 允许指令角色。
		| ChatCompletionInstructionMessageParam
		// 允许 assistant，包括正文 null 的工具调用消息。
		| ChatCompletionAssistantMessageParam
		// 允许工具文字结果。
		| ChatCompletionToolMessageParam
		// Extract 从联合中挑 role=user 的成员，是编译期筛类型。
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	// 要写的缓存配置。
	cacheControl: OpenAICompatCacheControl,
	// 返回是否实际写入，供逆序搜索决定停不停。
): boolean {
	// 先取当前正文引用或字符串值。
	const content = message.content;
	// 字符串与数组内容需要不同处理。
	if (typeof content === "string") {
		// 完全空字符串不创造无意义文本块；纯空白非空仍可标记。
		if (content.length === 0) {
			// 没有修改，返回失败供上层继续搜索。
			return false;
		}
		// 将正文字符串转换为单个文本段数组，以便段上挂 cache_control。
		message.content = [
			// 数组只含这个新建文本段。
			{
				// SDK 文本段判别标签。
				type: "text",
				// 保留原字符串内容，不 trim/改写。
				text: content,
				// 缓存扩展写在段上。
				cache_control: cacheControl,
			},
			// as 允许 SDK 标准类型之外的兼容字段，不对运行时数组转换。
		] as ChatCompletionTextPartWithCacheControl[];
		// 该消息已成功标记。
		return true;
	}

	// null/undefined 等非数组内容没有可遍历文本段。
	if (!Array.isArray(content)) {
		// 不修改此消息，允许外层继续往前找。
		return false;
	}

	// 从末尾找最后一段文本，不要求它是整个内容数组最后元素。
	for (let i = content.length - 1; i >= 0; i--) {
		// 取得一段，可能是图片/拒绝等非文字类型。
		const part = content[i];
		// 仅 text 段可加此标记；数组内空 text 段也会被接受。
		if (part?.type === "text") {
			// 静态扩展段类型以允许 cache_control 字段。
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			// 原地加或覆盖文本段的标记。
			textPart.cache_control = cacheControl;
			// 成功后不再往前遍历其他文本段。
			return true;
		}
	}

	// 没有文本段则返回 false，不移动图片也不创建占位文字。
	return false;
}

/**
 * 把完整统一会话转换为 Chat Completions 消息数组，无网络，转换/签名/grammar 输入错误按各分支处理。
 * 流程：规范化→跨模型工具/思考修正→工具声明折叠→按角色转文字/图像/调用/结果→必要时补协议桥接消息。
 * 例连续工具结果中的图片集中放到一条后续 user 图像消息；工具调用只序列化参数，不执行工具，也不校验工具授权。
 * 新建协议消息；转换器会对历史作必要副本，部分参数/schema 值仍按 helper 的原引用约定复用，不宣称深拷贝。
 */
export function convertMessages(
	// 目标模型决定消息角色、工具 ID 与图片能力等转换策略。
	model: Model<"openai-completions">,
	// 完整统一会话；内部还会规范化一次以支持直接调用这个导出函数。
	context: TranscriptContext,
	// 调用方需传解析后的兼容设置，不在此自动检测所有默认值。
	compat: ResolvedOpenAICompletionsCompat,
	// 可选 grammar 属性映射供 custom 历史调用转换。
	options?: ConvertCompletionsMessagesOptions,
	// 输出新 SDK 消息数组，不在此发请求。
): ChatCompletionMessageParam[] {
	// 按中途系统能力规范化/折叠输入，不直接修改原消息数组。
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	// 建立结果列表，后面通过 push 按顺序添加。
	const params: ChatCompletionMessageParam[] = [];

	/**
	 * 把工具 id 调整为目标协议可用形态，返回字符串，无状态修改；transformMessages 只在跨模型调用归一化时使用此回调。
	 * 复合 call|item 清理并组合，超过 40 时保留前缀加短哈希；无管道且目标 provider=openai 才截 40。
	 * 例 call|itemA 与 call|itemB 可保留 item 差异；清理/截断/短哈希都不是绝对无碰撞保证。
	 */
	const normalizeToolCallId = (id: string): string => {
		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, openai-codex, opencode
		// Extract just the call_id part and normalize it
		// Multiple tool calls in the same turn can share call_id but differ by item_id.
		// Preserve item-level uniqueness when replaying into Chat Completions, which
		// requires distinct tool call ids.
		// 复合 ID 含管道符时，不管目标 provider 是谁都走组合规范化。
		if (id.includes("|")) {
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			// 只取首个管道分隔位置，其余管道留在 item 部分随后被替换。
			const separatorIndex = id.indexOf("|");
			// 调用部分将允许集以外的每个字符替为下划线。
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			// 项目部分同样清理，保留用于区别同 callId 的多个 item。
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			// item 非空时拼 call_item，否则仅保留 call；清理可能有碰撞，不承诺绝对唯一。
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			// 40 个字符以内直接使用组合值。
			if (combinedId.length <= 40) {
				// 短组合不再哈希。
				return combinedId;
			}
			// 超长时对原始 id 哈希并截前 8 位，不是对清理后的字符串哈希。
			const hash = shortHash(id).slice(0, 8);
			// 给哈希和下划线预留长度，截取 call 前缀；call 为空时 slice 仍可为空。
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			// 组合短前缀和原始 ID 哈希，长度不超过此路径的 40 字符目标。
			return `${prefix}_${hash}`;
		}

		// 无管道时只有 provider 精确 openai 才截 40；不清理其他字符。
		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		// 其他供应商的普通 id 原样保留，不套通用 40 字符限制。
		return id;
	};

	// 跨模型时回调规范化调用 id，并同步对应结果；同 provider/api/id 的调用不会执行该回调。
	const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeToolCallId(id));
	// 再次解析工具声明，以同一折叠计数决定哪些系统工具新增还要单独发。
	const transcriptTools = resolveTranscriptTools(
		// 这里用规范化历史，system 顺序与 transform 后保持一致。
		normalizedContext.messages,
		// 两项能力都必须精确 true 才保留新增工具协议。
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true
			? // additions 模式把后续新增工具放历史项。
				"additions"
			: // none 模式由共享 helper 折叠声明，不要求服务支持中途新增协议。
				"none",
	);
	// 目录 reasoning 且支持 developer 才选 developer，否则 system；不按调用方是否开启思考判断。
	const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";

	// 追踪逻辑上一角色供工具结果桥接判断，不总是结果数组最后一个真实 SDK 角色。
	let lastRole: string | null = null;
	// 单独统计 system 消息序号，区别所有消息的循环索引 i。
	let systemIndex = 0;

	// 按处理后的顺序扫描；工具结果分支会一次消耗一批并调整 i。
	for (let i = 0; i < transformedMessages.length; i++) {
		// 取得当前角色联合，后续按 role 收窄内容类型。
		const msg = transformedMessages[i];
		// Some providers don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		// 兼容开关要求且上个逻辑角色为工具结果、当前为用户时，插合成 assistant。
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			// 新增桥接协议消息，不写入用户持久会话。
			params.push({
				// 桥接角色为 assistant。
				role: "assistant",
				// 使用固定说明文字，不声称实际执行了新业务操作。
				content: "I have processed the tool results.",
			});
		}

		// 系统声明与指令需要分别转换。
		if (msg.role === "system") {
			// transformMessages keeps system messages in order, so their position matches the transcript.
			// systemIndex++ 先取旧序号比较再加一；折叠范围内的工具新增已由顶层覆盖，不重复发。
			const addedTools = systemIndex++ >= transcriptTools.foldedSystemMessages ? (msg.toolsAdded ?? []) : [];
			// 保留下来的新增工具非空时加专用系统工具消息。
			if (addedTools.length > 0) {
				// 构造 Kimi 风格扩展，SDK 标准消息类型没有这个 tools 字段。
				const kimiToolMessage: KimiToolSystemMessageParam = {
					// 该声明消息始终 system，不使用 instructionRole。
					role: "system",
					// 新增工具也按相同 strict/grammar 能力转换。
					tools: convertTools(addedTools, compat),
				};
				// 经过 unknown 再断言只解决静态不兼容，不验证服务器支持此扩展。
				params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
			}
			// 只有整个转换数组 i=0 时用初始系统文字，后续系统一律渲染为更新，不按 systemIndex=0 判断。
			const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			// 空指令文字不创建额外消息，但前面的工具声明仍可能已加入。
			if (text.length > 0) {
				// 清理孤立代理码元后按 instructionRole 发指令。
				params.push({ role: instructionRole, content: sanitizeSurrogates(text) });
			}
			// 用户正文有字符串/块数组两种形式。
		} else if (msg.role === "user") {
			// typeof 在联合类型中区分正文形式，原行为保留。
			if (typeof msg.content === "string") {
				// 字符串直接构造一条 user 消息，空串也会保留。
				params.push({
					// 统一用户角色映射为 user。
					role: "user",
					// 只清理 Unicode 孤立代理，不 trim 或摘要化用户内容。
					content: sanitizeSurrogates(msg.content),
				});
				// 块数组路径分别转换文字和图片。
			} else {
				// 数组结果使用 SDK 正文块联合类型。
				const content: ChatCompletionContentPart[] = msg.content
					// 只丢完全空的文字块，纯空白文字和图片保留。
					.filter((item) => item.type !== "text" || item.text.length > 0)
					/**
					 * 将一个用户文字/图片块变成 SDK 正文块，返回新对象，无网络。
					 * 文字清理代理码元，图片直接拼 data URL；例 image/png 的已有 base64 不再解码或重压缩。
					 */
					// map 回调声明每个返回值都符合 SDK 内容块联合。
					.map((item): ChatCompletionContentPart => {
						// type=text 收窄为统一文字块。
						if (item.type === "text") {
							// 创建协议文本段。
							return {
								// 协议标签 text。
								type: "text",
								// 文字清理后保留原内容顺序。
								text: sanitizeSurrogates(item.text),
								// satisfies 检查文字段静态形状，不改变返回对象。
							} satisfies ChatCompletionContentPartText;
							// 该联合剩余为图片；无视觉模型已在 transformMessages 中换占位文字。
						} else {
							// 创建协议图片段。
							return {
								// SDK 使用 image_url，而非统一 image 标签。
								type: "image_url",
								// 图片源放在嵌套 image_url 对象。
								image_url: {
									// 把已有 mime/base64 直接拼成 data URL，不下载、解码或验证图片。
									url: `data:${item.mimeType};base64,${item.data}`,
								},
								// 静态检查图片段形状，不验证 MIME 或数据。
							} satisfies ChatCompletionContentPartImage;
						}
					});
				// 过滤后数组为空就跳过此消息，也不会更新后面的 lastRole。
				if (content.length === 0) continue;
				// 剩余块一次作为同一 user 消息发送。
				params.push({
					// 保留用户角色。
					role: "user",
					// 属性简写传转换后的内容数组。
					content,
				});
			}
			// assistant 需要区分可见文本、思考回放与工具调用。
		} else if (msg.role === "assistant") {
			// Some providers don't accept null content, use empty string instead
			// 先建带扩展推理字段的协议消息，后面按内容补充。
			const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
				// 保留 assistant 角色，不把历史工具调用当新请求指令。
				role: "assistant",
				// 沿用该兼容开关决定空正文用空串还是 null；并非所有供应商都接受两者。
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			// 准备保留非空白的可见文字块。
			const assistantTextParts = msg.content
				// 类型谓词将内容收窄为 TextContent。
				.filter(isTextContentBlock)
				// 只用 trim 判断是否全空白，后面实际保存的文字不 trim。
				.filter((block) => block.text.trim().length > 0)
				// 转换成 SDK 文字段数组，供需要把思考转正文的分支使用。
				.map(
					// 箭头回调逐个接收文字块。
					(block) =>
						// 括号让箭头体返回对象字面量，避免被当成语句块。
						({
							// 协议标签 text。
							type: "text",
							// 保留正文，仅清理孤立代理码元。
							text: sanitizeSurrogates(block.text),
							// satisfies 静态检查每个文字段。
						}) satisfies ChatCompletionContentPartText,
				);
			// 普通正文将各块无分隔拼成字符串，不自动加换行。
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			// 收集所有思考块；跨模型不适用思考在前面 transform 已移除。
			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			// 收集所有工具调用，保持原顺序。
			const toolCalls = msg.content.filter(isToolCallBlock);
			// 尝试从思考签名取结构化 detail 数组。
			const signedReasoningDetails = thinkingBlocks
				// 每块独立解析；字段名式签名会返回 undefined。
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				// 只采用第一组有效数组，不合并多块的多个有效数组。
				.find((details) => details !== undefined);
			// 旧工具签名只作没有新数组时的后备来源。
			const legacyReasoningDetails = toolCalls
				// 逐调用解析旧单个加密 detail。
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				// 类型谓词过滤 undefined，静态结果成为加密 detail 数组。
				.filter((detail): detail is OpenAIEncryptedReasoningDetail => detail !== undefined);
			// 优先新格式，没有时才考虑非空旧集合。
			const preservedReasoningDetails =
				// ?? 不会把有效新数组与旧集合叠加，避免重复回放。
				signedReasoningDetails ?? (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);

			// 可见思考只保留非全空白块；签名专用空思考仍可通过上面元数据路径回放。
			const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
			// 有可读思考才决定是转正文还是原生推理字段。
			if (nonEmptyThinkingBlocks.length > 0) {
				// 某些兼容服务要求把思考作为可见普通文本回放。
				if (compat.requiresThinkingAsText) {
					// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
					// 拼接所有保留下来的思考文字。
					const thinkingText = nonEmptyThinkingBlocks
						// 每段先清理孤立代理码元。
						.map((block) => sanitizeSurrogates(block.thinking))
						// 思考块之间加两个换行，区别普通回答块的无分隔拼接。
						.join("\n\n");
					// 思考文字段放在可见回答段之前，不加额外标签；此分支采用内容数组。
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
					// 不要求思考转正文时，正文和思考元数据分开放。
				} else {
					// Always send assistant content as a plain string (OpenAI Chat Completions
					// API standard format). Sending as an array of {type:"text", text:"..."}
					// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
					// NVIDIA NIM) to mirror the content-block structure literally in their
					// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
					// 有可见回答才覆盖初始空正文。
					if (assistantText.length > 0) {
						// 普通正文用字符串，避免兼容模型照抄块数组结构。
						assistantMsg.content = assistantText;
					}

					// reasoning_details is the structured alternative to a raw reasoning field.
					// 有结构化 reasoning_details 就不再发原文 reasoning 字段，避免重复。
					if (!preservedReasoningDetails) {
						// Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
						// 只取首个非空思考块签名决定原文字段名。
						let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
						// opencode-go 旧 reasoning 名称需要转回 reasoning_content。
						if (model.provider === "opencode-go" && signature === "reasoning") {
							// 仅改本地变量，不修改历史块签名。
							signature = "reasoning_content";
						}
						// 签名必须是允许字段名之一，任意 JSON 签名不能作为对象键透传。
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							// 按确定字段名写所有思考原文，块间单换行；这条路径没有调用 sanitizeSurrogates。
							assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
				// 无可读思考但有回答正文时，仍发普通字符串。
			} else if (assistantText.length > 0) {
				// Always send assistant content as a plain string (OpenAI Chat Completions
				// API standard format). Sending as an array of {type:"text", text:"..."}
				// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
				// NVIDIA NIM) to mirror the content-block structure literally in their
				// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
				// 采用已经清理过的 assistantText。
				assistantMsg.content = assistantText;
			}

			// 有工具调用时增加 tool_calls，即使没有正文也可保留这条 assistant。
			if (toolCalls.length > 0) {
				/**
				 * 把历史统一调用变成 SDK custom/function 调用，返回新对象，不执行工具。
				 * 有 grammar 属性映射则取字符串原文，否则 JSON.stringify 参数对象；例 {code:"a"} 在 custom 声明下回放成 input="a"。
				 */
				// 逐调用选择 custom 或 function；返回类型是 SDK 工具调用联合。
				assistantMsg.tool_calls = toolCalls.map((tc): ChatCompletionMessageToolCall => {
					// 按当前声明映射决定是否以 grammar custom 格式回放。
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					// 属性名只要不是 undefined 即存在，空属性名也通过。
					if (customInputProperty !== undefined) {
						// custom 分支返回 SDK 调用对象。
						return {
							// 使用已经按需要规范化的调用 id。
							id: tc.id,
							// 协议标签 custom。
							type: "custom",
							// custom 负载独立于普通 function.arguments。
							custom: {
								// 工具名直接采用历史名称。
								name: tc.name,
								// 从指定参数读取字符串原文再清理 Unicode；缺失/非字符串会由 helper 抛错，不验证 grammar 本身。
								input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
							},
						};
					}
					// 其他工具按普通 JSON function 调用回放。
					return {
						// 保留对应结果配对使用的 id。
						id: tc.id,
						// 协议标签 function。
						type: "function",
						// 函数调用负载对象。
						function: {
							// 历史工具名。
							name: tc.name,
							// 把统一参数对象完整序列化成字符串，不使用流预览或 argumentsError 原文替代。
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			}
			// 找到结构化元数据就继续附加，不取决于是否有可读思考文字。
			if (preservedReasoningDetails) {
				// 新/旧格式选择结果原样进入 reasoning_details。
				assistantMsg.reasoning_details = preservedReasoningDetails;
			}
			// 某些 reasoning 服务要求每条 assistant 明确带 reasoning_content。
			if (
				// 本地兼容配置必须开启此要求。
				compat.requiresReasoningContentOnAssistantMessages &&
				// 同时目录模型必须标注 reasoning。
				model.reasoning &&
				// 只有该字段尚未赋值时才补，不覆盖已经回放的原文。
				assistantMsg.reasoning_content === undefined
			) {
				// 补空字符串；不能让纯元数据/纯思考消息自动通过下方正文检查。
				assistantMsg.reasoning_content = "";
			}
			// Skip assistant messages that have no content and no tool calls.
			// Some providers require "either content or tool_calls, but not none".
			// Other providers also don't accept empty assistant messages.
			// This handles aborted assistant responses that got no content.
			// 取最终正文用于是否保留这条 assistant 的判断。
			const content = assistantMsg.content;
			// 这里只数正文，不数 reasoning_content/reasoning_details。
			const hasContent =
				// 排除 null。
				content !== null &&
				// 排除 undefined。
				content !== undefined &&
				// 字符串看字符数、数组看元素数，两支当前都是 length>0。
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			// 没正文且没 tool_calls 就丢弃，即使已有思考元数据也不单独保留。
			if (!hasContent && !assistantMsg.tool_calls) {
				// 跳过该消息，也不执行末尾 lastRole 更新。
				continue;
			}
			// 有效 assistant 加入结果列表。
			params.push(assistantMsg);
			// 工具结果要把连续一批文字结果先发送，再把图片合成后续用户消息。
		} else if (msg.role === "toolResult") {
			// 新数组只暂存这一批工具结果中的图片 URL 段。
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			// j 从当前 i 开始扫描，稍后让外层跳过整批。
			let j = i;

			// for 的初始化已在外面，条件只跨连续 toolResult，不跨 system/user/assistant。
			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				// role 条件已确认，断言为工具结果类型，不新增运行时验证。
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				// 把一条结果的所有文字段合并。
				const textResult = toolMsg.content
					// 仅取文字块。
					.filter(isTextContentBlock)
					// 提取文字原值。
					.map((block) => block.text)
					// 块间加单换行，保留非全空白正文里的原空白。
					.join("\n");
				// 另记是否有任何图片，与目标模型是否支持图是不同判断。
				const hasImages = toolMsg.content.some((c) => c.type === "image");

				// Always send tool result with text (or placeholder if only images)
				// 全空白视作没有结果文字。
				const hasText = textResult.trim().length > 0;
				// 有文字用原文，否则有图用 attached 占位，无任何输出用 no tool output。
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				// Some providers require the 'name' field in tool results
				// 每个工具结果至少发送一条 tool 文字消息。
				const toolResultMsg: ChatCompletionToolMessageParam = {
					// 统一 toolResult 对应协议 tool 角色。
					role: "tool",
					// 清理合并文本或占位中的孤立代理码元。
					content: sanitizeSurrogates(toolResultText),
					// 关联已经规范化后的 toolCallId。
					tool_call_id: toolMsg.toolCallId,
				};
				// 仅兼容开关要求且工具名真值时附扩展 name。
				if (compat.requiresToolResultName && toolMsg.toolName) {
					// 原有 any 允许 SDK 类型之外的 name 字段，不验证实际名字存在于当前工具表。
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				// 先把这条 tool 结果加入，确保所有配对结果都在图像 user 消息之前。
				params.push(toolResultMsg);

				// 还需目标模型声明 image 输入能力才发送图片；无能力时 transform 通常已替图为文字。
				if (hasImages && model.input.includes("image")) {
					// 按原结果内容顺序收集图片。
					for (const block of toolMsg.content) {
						// 类型谓词只比 type，不验证图片数据。
						if (isImageContentBlock(block)) {
							// 图片暂存，尚未在这里 push 到 params。
							imageBlocks.push({
								// 图片段标签 image_url。
								type: "image_url",
								// 嵌套图片源对象。
								image_url: {
									// 已有 mime/base64 直接构造 data URL，不重编码。
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			// j 指向批次后首条非工具结果；设 i=j-1，外层 i++ 后恰好继续下一条。
			i = j - 1;

			// 这一批确有可发送图片才建额外用户消息。
			if (imageBlocks.length > 0) {
				// 兼容服务不能 tool→user 时先补 assistant 桥接。
				if (compat.requiresAssistantAfterToolResult) {
					// 新建临时协议桥接消息，不持久化到原会话。
					params.push({
						// 桥接角色 assistant。
						role: "assistant",
						// 固定说明文字，不是重新执行工具的真实输出。
						content: "I have processed the tool results.",
					});
				}

				// 把一批结果的图片合在同一条用户消息里。
				params.push({
					// 图片以 user 身份发送，因为此协议 tool 结果正文不直接放这些图片。
					role: "user",
					// 正文数组先说明来源，再列图片。
					content: [
						// 第一项是新建说明文字段。
						{
							// 说明标签 text。
							type: "text",
							// 固定来源文字，不把每张图片和各自工具 id 单独关联。
							text: "Attached image(s) from tool result:",
						},
						// 数组展开按收集顺序追加这一批全部图片。
						...imageBlocks,
					],
				});
				// 逻辑上一角色设 user，避免后面再为同一工具结果重复桥接。
				lastRole = "user";
				// 无可发送图片时最后输出就是工具结果批次。
			} else {
				// 用统一逻辑角色名 toolResult，供下一 user 的桥接条件判断。
				lastRole = "toolResult";
			}

			// 批次已自行维护 i/lastRole，跳过循环底部公共角色更新。
			continue;
		}

		// 其他正常输出消息以当前统一角色更新状态；被 continue 的空消息不会更新。
		lastRole = msg.role;
	}

	// 返回按协议需要插入桥接/图像后的新数组，不发网络请求。
	return params;
}

/**
 * 转换统一工具声明为 SDK 工具数组，无网络/执行，不改原工具顶层结构；约束无法满足时 helper 可抛错。
 * 每工具先 grammar custom，否则 function schema/strict；例显式要求 strict 但 provider 不支持时会在 resolver 拒绝，而 prefer 可以降级。
 * strict 字段仅在兼容能力允许时发送；默认并不因为服务兼容 OpenAI 就自动 strict=true。
 */
function convertTools(
	// 统一工具声明数组，映射时不执行任何工具。
	tools: Tool[],
	// 解析后的能力决定 custom grammar 或 function strict 字段。
	compat: ResolvedOpenAICompletionsCompat,
	// 输出 SDK 工具声明数组。
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	/**
	 * 转换一项声明，优先 grammar，再走 JSON schema strict，返回新的 SDK 工具对象。
	 * 例有可用 Lark 约束时生成 custom.format.grammar，否则普通 function.parameters；不验证模型实际生成文本满足语法。
	 */
	// 每项创建新的声明结构，不修改原工具顶层对象。
	return tools.map((tool) => {
		// 先尝试 grammar；能力不支持时 helper 返回 undefined，支持但声明不合格可能抛错。
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		// 找到可用 grammar 时优先走 custom 路径，不再生成 function schema。
		if (grammar) {
			// 创建 custom 工具声明。
			return {
				// 协议标签 custom。
				type: "custom",
				// custom 工具配置对象。
				custom: {
					// 沿用工具名。
					name: tool.name,
					// 沿用说明文字，不翻译或改变提示词。
					description: tool.description,
					// 指定原始输入约束格式。
					format: {
						// 外层 format 标签 grammar。
						type: "grammar",
						// 内层 grammar 负载。
						grammar: {
							// 共享 resolver 已选定 lark/regex 等格式。
							syntax: grammar.format,
							// 语法定义文字原样透传，不在此执行语法验证。
							definition: grammar.definition,
						},
					},
				},
			};
		}

		// 无 grammar 则解析 JSON schema strict；require 不可满足可能抛错，prefer 可降级。
		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		// 创建普通函数工具声明。
		return {
			// 协议标签 function。
			type: "function",
			// 函数信息容器。
			function: {
				// 沿用名称。
				name: tool.name,
				// 沿用描述，保留原始工具提示内容。
				description: tool.description,
				// 按 strict 选择/转换 schema，断言只方便赋 SDK 参数类型，不校验运行时输入。
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				// Only include strict if provider supports it. Some reject unknown fields.
				// 仅能力非 false 时带 strict，未请求 strict 时显式 false；不支持则整个字段省略。
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		};
	});
}

/**
 * 把供应商累计 usage 转成统一计数和费用，返回新对象，不发网络，不改 rawUsage。
 * 按三个位置优先取缓存命中，单列写入，从提示总量扣读/写并下限 0；输出已含 reasoning，再计算目录价及可用 OpenRouter 总账务。
 * 例 prompt=100、cacheRead=20、cacheWrite=10、completion=5 时 input=70,total=105；思考只是 output 的明细，不额外加总。
 * 这里不是完整远端 schema/数值验证，部分不合理值仍按既有算式流转；OpenRouter 总费用可来自报告而分项仍为目录估算。
 */
function parseChunkUsage(
	// OpenRouter adds billing fields to streamed usage at runtime,
	// although the OpenAI SDK does not type those fields.
	// 远端累计 usage 的局部结构，SDK 未覆盖的账务字段稍后另处理，非完整运行时验证。
	rawUsage: {
		// 总提示 token，可能包含缓存读取/写入部分。
		prompt_tokens?: number;
		// 输出 token，按供应商语义通常已含思考 token。
		completion_tokens?: number;
		// Kimi 等服务把缓存命中放顶层 cached_tokens。
		cached_tokens?: number;
		// DeepSeek 风格的顶层缓存命中别名。
		prompt_cache_hit_tokens?: number;
		// OpenAI 风格嵌套命中字段，兼容代理还可能给独立写入字段。
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		// 输出明细中的思考 token 只是输出子集，不再额外加到总数。
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	// 模型提供目录价格和 OpenRouter 识别所需字段。
	model: Model<"openai-completions">,
	// 索引访问类型复用统一消息 usage 形状。
): AssistantMessage["usage"] {
	// || 让缺省/0/NaN 回退 0，负数是真值会保留；不进行全面数值校验。
	const promptTokens = rawUsage.prompt_tokens || 0;
	// 缓存读取按下面优先级选择一个来源，不把多个别名相加。
	const cacheReadTokens =
		// 嵌套命中优先→DeepSeek 别名→顶层命中→0；?? 保留明确 0。
		rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
	// 缓存写入缺省为 0，与读取数单独记账。
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	// Follow documented OpenAI/OpenRouter semantics: cached_tokens is cache-read
	// tokens (hits). Providers disagree on placement: OpenAI/OpenRouter use
	// prompt_tokens_details.cached_tokens, DeepSeek uses prompt_cache_hit_tokens,
	// and Kimi documents top-level usage.cached_tokens on the final usage chunk.
	// OpenAI does not document or emit cache_write_tokens, but
	// OpenRouter-compatible providers can include it as a separate write count.
	// OpenRouter's own provider/tests affirm the separate mapping:
	// https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
	// Do not subtract writes from cached_tokens, otherwise spec-compliant
	// providers are under-reported. DS4 mirrors this contract too:
	// https://github.com/antirez/ds4/pull/29
	// 普通输入从总提示减缓存读/写后下限为 0，不把写入再从命中数扣一次。
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI completion_tokens already includes reasoning_tokens.
	// completion_tokens 已包含 reasoning，不额外再相加。
	const outputTokens = rawUsage.completion_tokens || 0;
	// 创建统一用量对象，尚无费用估算。
	const usage: AssistantMessage["usage"] = {
		// 普通未缓存输入数。
		input,
		// 输出总量。
		output: outputTokens,
		// 独立缓存读取量。
		cacheRead: cacheReadTokens,
		// 独立缓存写入量。
		cacheWrite: cacheWriteTokens,
		// 思考作为输出的一个明细维度，缺省 0。
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		// 从分类后的四项重算总 token，不直接采用远端 total_tokens。
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		// 先初始化估算费用各项。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// 按模型目录单价原地填写费用；不请求价格接口。
	calculateCost(model, usage);
	// 供应商名或 URL 子串识别为 OpenRouter 时尝试采用报告账务。
	if (isOpenRouterModel(model)) {
		// 静态扩展看到账务字段，helper 会验证自己使用的费用数；有效总额可覆盖估算，分项可能不随之重算。
		applyOpenRouterReportedCost(usage, rawUsage as typeof rawUsage & OpenRouterUsageAccounting);
	}
	// 返回完整新 usage 供调用方整份替换当前用量。
	return usage;
}

/**
 * 将原生 finish_reason 转为统一 stopReason 和可选错误，纯函数，无网络/修改。
 * stop/end→stop，length→length，function_call/tool_calls→toolUse，过滤/网络/未知码→error；例 content_filter 不会被当正常完成。
 * null 单独调用映射为 stop，但流循环只在原原因真值时调用它，所以缺终态仍由外层规则判断。
 */
function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	// 返回统一停止原因。
	stopReason: StopReason;
	// 某些原因同时带可读错误，正常情况可省略。
	errorMessage?: string;
} {
	// helper 单独接收 null 时返回 stop；实际调用处只在 finish_reason 真值时调用。
	if (reason === null) return { stopReason: "stop" };
	// switch 兼容 SDK 固定原因及其他服务的扩展字符串。
	switch (reason) {
		// 标准自然结束标签。
		case "stop":
		// 兼容服务 end 与 stop 共用自然结束映射。
		case "end":
			// 返回 stop 不代表整个 Agent 工具循环不再继续。
			return { stopReason: "stop" };
		// 达到输出长度限制。
		case "length":
			// 统一 length，调用方能区分被截断与正常结束。
			return { stopReason: "length" };
		// 旧 function_call 标签仍兼容。
		case "function_call":
		// 新 tool_calls 标签和旧标签同样需要上层工具执行。
		case "tool_calls":
			// 返回 toolUse，只表示模型提出调用。
			return { stopReason: "toolUse" };
		// 内容过滤当作错误，不显示为正常 stop。
		case "content_filter":
			// 返回固定过滤原因文字。
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		// 兼容服务 network_error 扩展结束码。
		case "network_error":
			// 返回网络结束错误，不在这里重试流。
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		// 不认识的任何字符串默认失败，而不是静默 stop。
		default:
			// 构造含未知原码的错误结果。
			return {
				// 统一 error 状态。
				stopReason: "error",
				// 附原始供应商原因用于诊断。
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * Auto-detect compatibility settings from provider name and baseUrl.
 * Used as the base when model.compat is not set; explicit model.compat
 * entries override these detected values.
 */
/**
 * 按 provider 与 baseUrl 的字符串启发式构造兼容默认值，返回新对象，不联网探测或确认服务归属。
 * 先分类供应商→分别选 store/developer/effort/token 字段→思考协议→缓存与工具能力；例 URL 含 deepseek.com 会选旧 max_tokens 和 DeepSeek thinking 格式。
 * 各检测集合并不等价，OpenRouter Anthropic 缓存标记还要求精确 provider 名；显式模型配置稍后可覆盖这些默认。
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	// 取供应商名；精确字符串比较通常区分大小写。
	const provider = model.provider;
	// 取原始 URL 字符串，多数判断用 includes，不解析 hostname。
	const baseUrl = model.baseUrl;

	// ZAI 兼容由几种供应商名/域名字串启发式识别。
	const isZai =
		// 国际供应商 id。
		provider === "zai" ||
		// 国内 coding 供应商 id。
		provider === "zai-coding-cn" ||
		// URL 含 api.z.ai 时也可识别自定义供应商。
		baseUrl.includes("api.z.ai") ||
		// 另一 ZAI 域名候选，任何命中即可，不校验域名归属。
		baseUrl.includes("open.bigmodel.cn");
	// Together 同样检查供应商名及 URL 字符串。
	const isTogether =
		// 两个域名别名都按 Together 协议默认值。
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	// Moonshot 国际/国内名或域名字串匹配，不依赖模型 id。
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	// OpenRouter 可由供应商名或 URL 子串识别。
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	// Cloudflare Workers AI 检测，不是严格 URL/账户验证。
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	// Cloudflare Gateway 单独分类，后续有不同字段兼容规则。
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	// NVIDIA 的兼容接口按供应商名/根 URL 识别。
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	// Ant Ling 的协议分类。
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	// Cerebras 的协议分类。
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	// DeepSeek 是这里少数先把 URL 小写的检测，其余多数直接 includes。
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	// 汇总默认不使用标准 store/developer 等字段的服务集合，不是逐项实时能力探测。
	const isNonStandard =
		// NVIDIA 归入非标准集合。
		isNvidia ||
		// Cerebras 同样归入。
		isCerebras ||
		// xai 供应商名归入。
		provider === "xai" ||
		// xai URL 别名同样归入。
		baseUrl.includes("api.x.ai") ||
		// Together 归入。
		isTogether ||
		// Chutes 由 URL 子串归入。
		baseUrl.includes("chutes.ai") ||
		// DeepSeek 归入。
		isDeepSeek ||
		// ZAI 归入。
		isZai ||
		// Moonshot 归入。
		isMoonshot ||
		// opencode 供应商名归入，opencode-go 不按此名字项匹配但可能按 URL 命中。
		provider === "opencode" ||
		// 任何含 opencode.ai 的根 URL 都归入。
		baseUrl.includes("opencode.ai") ||
		// Cloudflare Workers AI 归入。
		isCloudflareWorkersAI ||
		// Cloudflare Gateway 归入。
		isCloudflareAiGateway ||
		// Ant Ling 归入；|| 在任一真值后短路。
		isAntLing;

	// 独立选择旧 max_tokens 字段的集合，与 isNonStandard 并不完全相同。
	const useMaxTokens =
		// Chutes 使用旧字段。
		baseUrl.includes("chutes.ai") ||
		// DeepSeek 使用旧字段。
		isDeepSeek ||
		// Moonshot 使用旧字段。
		isMoonshot ||
		// Cloudflare Gateway 使用旧字段，Workers AI 不由这一项覆盖。
		isCloudflareAiGateway ||
		// Together 使用旧字段。
		isTogether ||
		// NVIDIA 使用旧字段。
		isNvidia ||
		// Ant Ling 使用旧字段。
		isAntLing ||
		// ZAI 使用旧字段；没列入的服务默认较新字段。
		isZai;

	// Grok 标记用于不默认发送 OpenAI effort。
	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	// OpenRouter 中仅部分模型名前缀默认允许 developer。
	const isOpenRouterDeveloperRoleModel =
		// 需先识别 OpenRouter，且 id 以 anthropic/ 或 openai/ 开头。
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	// 缓存标记检测更严格：provider 必须精确 openrouter 且 Anthropic 前缀，只有 URL 命中不会自动启用。
	const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

	// 返回一套新默认对象，模型显式覆盖在 getCompat 中再应用。
	return {
		// 非标准集合之外默认允许发送 store:false。
		supportsStore: !isNonStandard,
		// OpenRouter 特定前缀允许 developer；其他非标准或普通 OpenRouter 模型默认不允许。
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		// 默认允许原生 effort 的范围是下面排除集合的补集。
		supportsReasoningEffort:
			// 这七类默认关 effort；不代表这些服务完全没有思考功能，可能有专用 thinking 格式。
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		// 默认请求流中累计用量。
		supportsUsageInStreaming: true,
		// 默认要求流给出有效 finish_reason，缺失按不完整回答失败。
		supportsFinishReason: true,
		// 根据独立集合选旧或新 token 上限字段。
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		// 默认不在 tool 结果附供应商扩展 name。
		requiresToolResultName: false,
		// 默认无需工具结果到用户之间的合成 assistant 桥。
		requiresAssistantAfterToolResult: false,
		// 默认不把思考转成可见回答文字。
		requiresThinkingAsText: false,
		// DeepSeek 默认要求 assistant 带 reasoning_content，即使是空串。
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		// 思考格式按下面优先链选择，先命中的类别胜出。
		thinkingFormat: isDeepSeek
			? // DeepSeek 优先。
				"deepseek"
			: // 否则检查 ZAI。
				isZai
				? // 命中用 zai。
					"zai"
				: // 否则检查 Together。
					isTogether
					? // 命中用 together。
						"together"
					: // 否则检查 Ant Ling。
						isAntLing
						? // 命中用 ant-ling。
							"ant-ling"
						: // 否则检查 OpenRouter。
							isOpenRouter
							? // 命中用 openrouter。
								"openrouter"
							: // 其余默认普通 openai 格式；qwen 等专用格式需显式 compat 覆盖。
								"openai",
		// 默认无 OpenRouter 路由偏好，不在此实际选上游。
		openRouterRouting: {},
		// 默认无 Vercel 路由偏好。
		vercelGatewayRouting: {},
		// 默认通用 kwargs 模板为空，不生成额外模板字段。
		chatTemplateKwargs: {},
		// 默认 Baseten args 模板为空。
		chatTemplateArgs: {},
		// 默认不发送 ZAI tool_stream 扩展。
		zaiToolStream: false,
		// 默认不启用旧思考预算布尔别名。
		supportsThinkingTokenBudget: false,
		// 默认无显式预算字段名。
		thinkingTokenBudgetField: undefined,
		// OpenAI compatibility alone does not imply strict JSON-schema tool support.
		// 兼容 OpenAI 不自动推定有 strict schema 能力，默认 false。
		supportsStrictMode: false,
		// 同样默认不开 grammar custom 工具。
		supportsOpenAIGrammarTools: false,
		// 默认不保留中途系统协议能力。
		supportsMidConvoSystemMessages: false,
		// 默认不启用中途工具添加协议。
		supportsMidConvoToolAdditions: false,
		// 采用前面单独算出的缓存标记格式，可能 undefined。
		cacheControlFormat,
		// 只有识别成 OpenRouter 才默认发送自动亲和头。
		sendSessionAffinityHeaders: isOpenRouter,
		// 选择亲和格式，与是否自动发送的开关分开。
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		// 长期缓存默认在下面几类之外启用；! 对整个括号结果取反。
		supportsLongCacheRetention: !(
			// Together 默认不支持长期字段。
			(
				isTogether ||
				// Workers AI 默认不支持。
				isCloudflareWorkersAI ||
				// Gateway 默认不支持。
				isCloudflareAiGateway ||
				// NVIDIA 默认不支持。
				isNvidia ||
				// Ant Ling 默认不支持；其他不在此集合的服务默认 true。
				isAntLing
			)
		),
	};
}

/**
 * Get resolved compatibility settings for a model.
 * Auto-detects from provider/URL then overrides with explicit model.compat.
 */
/**
 * 把自动检测值与模型显式 compat 逐项合并，返回本次解析配置，不改模型也不做远端校验。
 * 没配置直接返回检测；有配置每项以 ?? 保留显式 false，再补默认；例 supportsFinishReason=false 使 EOF 可按内容推断终态。
 * 路由/模板对象可能复用配置引用，返回的新顶层对象不是深拷贝或冻结快照。
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	// 每次调用重新从供应商/URL 推导，不缓存或请求服务端。
	const detected = detectCompat(model);
	// 模型没有任何 compat 对象时直接返回检测对象。
	if (!model.compat) return detected;

	// 有 compat 时逐字段合并，不用整个对象简单替换所有默认。
	return {
		// 显式 supportsStore=false 由 ?? 保留。
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		// developer 支持可覆盖自动检测。
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		// effort 支持可独立于 thinkingFormat 覆盖。
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		// usage 流字段可显式关闭。
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		// 可声明无 finish_reason 时允许 EOF 推断。
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		// 显式指定服务实际需要的 token 字段。
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		// 工具结果扩展 name 策略。
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		// 工具结果后是否需桥接的策略跨两行取值。
		requiresAssistantAfterToolResult:
			// 显式 false 不会被检测值覆盖。
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		// 是否将思考回放成可见文字。
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		// assistant 是否必须带 reasoning_content。
		requiresReasoningContentOnAssistantMessages:
			// 有显式值优先，缺值才回退下一行。
			model.compat.requiresReasoningContentOnAssistantMessages ??
			// 检测值目前主要随 DeepSeek 分类启用。
			detected.requiresReasoningContentOnAssistantMessages,
		// 专有思考协议格式可覆盖检测结果。
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		// OpenRouter 路由未设时直接新空对象，而不是检测对象引用。
		openRouterRouting: model.compat.openRouterRouting ?? {},
		// Vercel 路由策略用显式值或检测默认。
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		// 通用 kwargs 模板采用显式表或默认空表。
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		// Baseten args 模板采用显式表或默认空表。
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		// ZAI tool_stream 可显式覆盖。
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		// 旧预算布尔别名可覆盖默认关闭。
		supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		// 显式预算字段名优先，未设通常 undefined。
		thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		// strict schema 支持可明确打开，默认检测 false。
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		// grammar 支持独立配置，不能由 strict 代替。
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		// 中途系统消息能力跨两行选择。
		supportsMidConvoSystemMessages:
			// 显式值优先，undefined/null 才回退检测值。
			model.compat.supportsMidConvoSystemMessages ?? detected.supportsMidConvoSystemMessages,
		// 中途工具添加能力独立选择。
		supportsMidConvoToolAdditions:
			// 同样用 ?? 保留显式 false。
			model.compat.supportsMidConvoToolAdditions ?? detected.supportsMidConvoToolAdditions,
		// 缓存标记格式用显式配置，否则保留 OpenRouter Anthropic 的检测结果。
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		// 自动亲和头总开关可覆盖检测。
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		// 亲和格式可独立覆盖；none 仍可能进入非 OpenRouter 请求标识分支。
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		// 长期缓存能力显式 false 会关闭自动长期字段。
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
		// vLLM 优先级直接取模型配置，没有检测默认，0 可保留。
		vllmPriority: model.compat.vllmPriority,
	};
}
