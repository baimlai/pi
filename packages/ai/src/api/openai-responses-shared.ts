// OpenAI/Azure/Codex共用的Responses适配层：把消息/工具历史转成请求条目，把供应商事件按输出索引组装成Pi内容块；网络与最终流收尾由调用方负责。
// 只导入SDK命名空间类型，下方OpenAI.Responses.ResponseStatus用它表达联合，不在此创建客户端。
import type OpenAI from "openai";
// Responses请求/响应/事件均用已安装SDK的类型契约，不自动执行运行时校验。
import type {
	// Tool在导入处重命名为OpenAITool，和Pi工具声明区分。
	Tool as OpenAITool,
	// 对话中途思考配置更新条目类型。
	ResponseConfigurationUpdateItemParam,
	// 流式请求类型，此处提取service_tier字段。
	ResponseCreateParamsStreaming,
	// Responses输入是多种消息/工具/配置条目的数组。
	ResponseInput,
	// 用户消息中的输入内容块联合。
	ResponseInputContent,
	// 图片输入块形状。
	ResponseInputImage,
	// 单个输入条目的联合，供satisfies检查构造。
	ResponseInputItem,
	// 文字输入块形状。
	ResponseInputText,
	// 各种输出条目联合，不是每类都在本适配器创建内容块。
	ResponseOutputItem,
	// assistant输出文字消息类型。
	ResponseOutputMessage,
	// 可重放的完整reasoning条目。
	ResponseReasoningItem,
	// SDK流事件的type标签联合。
	ResponseStreamEvent,
	// 客户端工具搜索结果条目类型。
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
// 根据目录单价原地计算Usage.cost，不请求供应商账单。
import { calculateCost } from "../models.ts";
// 以下均是Pi内部类型，Api泛型维持具体适配目标。
import type {
	// 聊天API标识联合。
	Api,
	// 要组装或重放的完整assistant消息。
	AssistantMessage,
	// 图片工具结果内容块。
	ImageContent,
	// 目录模型能力/价格/兼容配置。
	Model,
	// 统一停止状态。
	StopReason,
	// 从公共选项取观察钩子类型。
	StreamOptions,
	// system正文/工具变化的轨迹条目。
	SystemMessage,
	// 文字内容块及其可选签名。
	TextContent,
	// 带v/id/phase的本地文字签名结构。
	TextSignatureV1,
	// 思考块与可重放签名。
	ThinkingContent,
	// 工具声明，不是执行函数。
	Tool,
	// 工具调用及参数/可选namespace。
	ToolCall,
	// 已规范化的消息轨迹上下文。
	TranscriptContext,
	// 输入/输出/缓存token及费用对象。
	Usage,
} from "../types.ts";
// 本函数接收已有事件流，只需类型，不自行构造流。
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 确定性短散列用来缩短长id，可能碰撞，不是安全证明。
import { shortHash } from "../utils/hash.ts";
// 清除孤立代理码元，普通Unicode文字保持；不做内容脱敏。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// 每条function_call独享参数原文/增量预览/最终完整解析。
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
// 首条system渲染当前规则，中途system渲染补丁形式。
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
// 按传输能力解析system及工具历史，type关键字只导入工具支持联合类型。
import { resolveTranscript, resolveTranscriptTools, type TranscriptToolSupport } from "../utils/transcript.ts";
// 复用grammar字符串缓冲、工具输入取值和JSON schema约束协商，避免各Responses传输另写规则。
import {
	// 把原始grammar文字增量转成工具JSON参数增量。
	appendGrammarToolInputJsonDelta,
	// 补最终输入后封口JSON参数文字。
	closeGrammarToolInputJson,
	// 仅在槽内保存的grammar缓冲类型。
	type GrammarToolInputJsonBuffer,
	// 从工具参数对象取配置的grammar文字承载字段，缺失或非字符串可抛，不拒绝其他字段。
	getGrammarToolInput,
	// 按严格模式取得转换后的schema或原声明。
	getJsonSchemaToolParameters,
	// 协商grammar格式与目标协议能力。
	resolveGrammarConstrainedSampling,
	// 协商JSON schema strict约束。
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
// 跨模型处理思考/签名/id并补齐缺失工具结果；不等于完整wire验证。
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

/**
 * 把Responses文字条目的id和可选phase编码成带v:1的签名字符串，返回JSON，不修改消息。
 * 例：id="msg_1"、phase="commentary"得到可在下轮恢复阶段的JSON；这是本地元数据编码，不是加密签名/身份认证。
 */
function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	// 新建版本1签名载荷，id是Responses message条目标识。
	const payload: TextSignatureV1 = { v: 1, id };
	// phase有值才附字段；这里只允许commentary/final_answer的类型约定。
	if (phase) payload.phase = phase;
	// JSON.stringify返回可持久化字符串，不做加密。
	return JSON.stringify(payload);
}

/**
 * 解析持久化文字签名，返回id/可选合法phase；空签名返回undefined，旧纯字符串继续作为id使用。
 * 例：v:1且phase=final_answer可恢复阶段；JSON损坏、版本不符或id非字符串都会回退把整段原文当id，不是抛错或完整schema校验。
 */
function parseTextSignature(
	// 签名可缺失；问号出现在返回phase表示可以不带阶段。
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	// undefined或空串都视为没有签名。
	if (!signature) return undefined;
	// 只有以左大括号开头才尝试版本JSON，前导空白会走旧纯字符串规则。
	if (signature.startsWith("{")) {
		// 解析异常在本函数内吞掉以继续旧格式兼容。
		try {
			// Partial只把各字段改为可选，as不检查外部JSON字段。
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			// 真正检查版本为1且id是字符串，未要求id非空或规定前缀。
			if (parsed.v === 1 && typeof parsed.id === "string") {
				// phase只接受这两个真实字符串值。
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					// 保留合法id及phase。
					return { id: parsed.id, phase: parsed.phase };
				}
				// phase不受支持时仅返回id，不拒绝整个签名。
				return { id: parsed.id };
			}
			// 损坏JSON等异常落入兼容后备，不向外抛原解析错。
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	// 非版本JSON/解析失败/字段不符时，把原始整个签名字串当旧id。
	return { id: signature };
}

// Array<A|B>表示每个数组项可以是文字或图片，和A[]|B[]含义不同。
type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

/**
 * 把工具结果转换为Responses输出：无可发送图片时返回文字/占位符，有图片能力时返回文字与图片数组；无I/O、不验证图片内容。
 * 例：只有图片但目标不支持image，结果为"(see attached image)"占位而未附图片；无文字无图片得到"(no tool output)"，纯空白也算无文字。
 */
function convertToolResultOutput<TApi extends Api>(
	// TApi extends Api维持模型API关联，不让此辅助函数只接受OpenAI模型。
	model: Model<TApi>,
	// readonly约束通过此参数不能push/重排内容数组，运行时未冻结。
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	// 先从全部内容中收集文字，图片稍后独立处理，因此会将文字汇总到图片之前。
	const textResult = content
		// 类型谓词让过滤后数组可安全读.text。
		.filter((c): c is TextContent => c.type === "text")
		// 从文字块取原文。
		.map((c) => c.text)
		// 多个文字块以换行连接，不按原块位置穿插图片。
		.join("\n");
	// 收集原图片块引用，不复制/解码图片。
	const images = content.filter((c): c is ImageContent => c.type === "image");
	// trim只决定是否有正文，实际非空正文不会被trim后发送。
	const hasText = textResult.trim().length > 0;

	// 无图片或模型不支持图片，返回普通字符串而非多模态数组。
	if (images.length === 0 || !model.input.includes("image")) {
		// 优先有意义正文；只有不可发送图片时用图片占位，否则空输出占位，再清孤立代理码元。
		return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	}

	// 多模态结果建立新的数组。
	const output: ToolResultOutputContent = [];
	// 有非空白文字才加文字项。
	if (hasText) {
		// 把合并的文字放首项。
		output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	// 图片按原图片顺序追加，文字/图片原本交错位置不会保留。
	for (const image of images) {
		// 每张图片新建输入项。
		output.push({
			// Responses图片输入标签。
			type: "input_image",
			// 图片细节交服务端auto决定。
			detail: "auto",
			// 拼data URL，不上传文件、不校验MIME/base64。
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	// 返回含至少一张图片的输入数组。
	return output;
}

// 流处理器可选策略接口，调用方提供的回调会实际执行并可能抛错。
export interface OpenAIResponsesStreamOptions {
	// 索引访问类型复用公共原始事件观察钩子；下面每条先await。
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	// 请求侧service tier后备，不能把它当终态实际tier。
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	// 工具名→唯一文字输入属性名，ReadonlyMap只限制TS写入，未运行时冻结。
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	// 可选tier解析函数，仅在applyServiceTierPricing存在时才会用。
	resolveServiceTier?: (
		// 终态响应声称的tier，可缺失。
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		// 原请求tier，可缺失，提供后备。
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		// 函数可返回缺省tier，定价回调继续自行处理。
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	// 可选费用调整回调，可原地修改usage，不自动返回新Usage。
	applyServiceTierPricing?: (
		// 已经按目录算过费用的Usage对象。
		usage: Usage,
		// 选出的服务等级或undefined。
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		// 返回void不等于回调不会抛错。
	) => void;
}

// 控制历史转换的能力/格式选项；接口不检查远端服务真的实现这些能力。
export interface ConvertResponsesMessagesOptions {
	// 默认true；false只省首条system正文，不必然省掉它的工具声明。
	includeSystemPrompt?: boolean;
	// grammar工具名字到输入字段，决定call/output使用custom还是function协议。
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	/** Whether later system messages are sent in place; otherwise they are folded into the leading prompt. */
	// 是否保持中途system，缺省按不支持而折叠。
	supportsMidConvoSystemMessages?: boolean;
	// 是否能用additional_tools表达原位增加/重定义。
	supportsAdditionalTools?: boolean;
	// 是否能用客户端tool_search表达新增。
	supportsToolSearch?: boolean;
	// 本次历史工具声明转换共用的strict/grammar选项。
	toolOptions?: ConvertResponsesToolsOptions;
	/**
	 * Effort for the reply being generated. When set, the thinking level is sent as
	 * configuration_update items instead of a changing reasoning.effort, which would invalidate the
	 * prompt cache. Each item sets the effort from that point on: one goes before every earlier
	 * reply with the level recorded on it (`providerThinkingLevel`), and one with this effort goes
	 * at the end. Earlier input therefore never changes. OpenAI documents the item before user
	 * messages only. After tool results it was verified on gpt-6-luna (October 2026) to be accepted
	 * and to apply to the next reply.
	 */
	// 任意string通过SDK努力档位断言写入更新；不在此验证。历史只回放同模型有记录的档位，末尾总加本次配置。
	configurationUpdateEffort?: string;
}

// 工具声明生成选项，区别默认strict值与目标是否支持strict字段。
export interface ConvertResponsesToolsOptions {
	// undefined→false，显式null保留为SDK可空值。
	strict?: boolean | null;
	// 缺省true，false会省strict字段；不自行探测服务。
	supportsStrictMode?: boolean;
	// 缺省false，支持时才使用OpenAI custom grammar工具。
	supportsOpenAIGrammarTools?: boolean;
	// 作为工具搜索结果时加defer_loading:true，而非改变真实工具执行时机。
	toolSearchResult?: boolean;
}

// =============================================================================
// Message conversion
// =============================================================================

/**
 * How a Responses transport expresses tool changes.
 *
 * `additional_tools` items accumulate: a later item adds tools and replaces same-name
 * definitions from earlier items, but it cannot replace a top-level tool and cannot remove any
 * tool (verified with strict schemas on the OpenAI, Codex, and Copilot backends, October 2026).
 * Like Codex, every tool is therefore declared in `additional_tools` items, starting with one
 * at the head of the input, and removals are announced as text. Synthetic tool search can
 * only add tools. Without mid-conversation system messages there is nothing to anchor.
 */
/**
 * 按传输能力选工具历史表达模式，返回changes/additions/none，不发请求或检查远端。
 * 例：同时支持中途system和additional_tools选changes，否则支持tool_search选additions；仅声明additional_tools但不支持中途system仍不会选changes。
 */
export function getResponsesToolSupport(options: {
	// 支持在中途system位置锚定变化。
	supportsMidConvoSystemMessages?: boolean;
	// 支持原位additional_tools声明。
	supportsAdditionalTools?: boolean;
	// 支持客户端工具搜索的新增记录。
	supportsToolSearch?: boolean;
}): TranscriptToolSupport {
	// 两项都真才用可重定义的changes模式，删除仍只能文字提醒。
	if (options.supportsMidConvoSystemMessages && options.supportsAdditionalTools) return "changes";
	// 否则支持搜索就additions，不支持则none；不在此折叠消息。
	return options.supportsToolSearch ? "additions" : "none";
}

/**
 * Precedes every additional_tools item after the first. Without it, models read the latest item as
 * the complete tool set once a removal was announced; Codex precedes its incremental tool batches
 * with the same guidance. Restating the tools that are still unavailable keeps smaller models
 * (gpt-5.6-luna, gpt-6-luna) from calling them again after later loads (verified October 2026).
 */
/**
 * 生成后续增量工具声明前的说明文字，并列出仍被移除的工具；返回新字串，不修改集合。
 * 例：unavailable有read时追加Still unavailable: read；只是自然语言提示，不能在服务端撤销已经声明的工具或保证模型不误调用。
 */
function renderIncrementalToolsNotice(unavailable: ReadonlySet<string>): string {
	// 固定增量说明保留原英文提示内容，下一行是字符串值，不插入注释到它内部。
	const notice =
		// 这段指令强调旧工具仍保留、同名声明替换，是发给模型的普通文字。
		"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.";
	// 有不可用名才追加名单，Set展开按插入顺序join，不清空集合。
	return unavailable.size > 0 ? `${notice}\nStill unavailable: ${[...unavailable].join(", ")}.` : notice;
}

/**
 * 把移除工具名数组渲染为提示模型不要调用的文字，无I/O、不修改数组。
 * 例：["read","write"]变两行项目；名称原样插入，没有在此转义/验证，也不执行真正的工具权限撤销。
 */
function renderToolRemovalNotice(names: readonly string[]): string {
	// 只读数组map渲染每个名字再换行拼接；模板内容保持原样，没有实际执行工具操作。
	return `The following tools are no longer available. Do not call them:\n${names.map((name) => `- ${name}`).join("\n")}`;
}

/**
 * 将规范轨迹转换成Responses输入数组：按能力折叠system、转换历史身份/id、插入工具增删声明与思考配置，再转换文字/图片/工具结果；不发请求。
 * 例：同模型带providerThinkingLevel=high的历史回复前可插configuration_update(high)，末尾再追加本次low，保持早期输入稳定；这不保证所有供应商都能接受，能力由调用方选择。
 * 会新建传输结构，部分reasoning对象由签名JSON恢复；无签名thinking不发，签名JSON坏时可直接抛错。工具搜索是本地合成已完成记录，并非这里真的搜索/加载工具。
 * allowedToolCallProviders控制跨模型id处理，不是访问权限；namespace只同provider/api/model保留。普通工具参数用JSON.stringify，循环对象等仍可抛。
 */
export function convertResponsesMessages<TApi extends Api>(
	// 目标模型决定能力、身份与价格元数据，此函数不做认证。
	model: Model<TApi>,
	// 规范输入轨迹，没有旧顶层systemPrompt/tools需要兼容。
	context: TranscriptContext,
	// 允许保留Responses复合id的目标供应商集合，ReadonlySet仅编译期只读。
	allowedToolCallProviders: ReadonlySet<string>,
	// 可选能力与格式设置，不修改原options。
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	// 支持中途system时复用原轨迹，否则把system规则/工具折到首条。
	const normalizedContext = resolveTranscript(context, options?.supportsMidConvoSystemMessages);
	// 新建最终Responses条目数组，后续闭包向它push。
	const messages: ResponseInput = [];

	/**
	 * 清洗一段工具标识：非法字符替换下划线、最多64码元、去尾下划线，返回新串。
	 * 例：a.b__→a_b；全非法输入可能变空，不保证唯一或合法非空，不对原对象赋值。
	 */
	const normalizeIdPart = (part: string): string => {
		// 全局替换允许字符以外的码元为下划线。
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		// 超过64码元才截断，普通短id不另加散列。
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		// 再去尾部连续下划线；可能从全下划线变空串，也可能与其他id碰撞。
		return normalized.replace(/_+$/, "");
	};

	/**
	 * 为外来Responses item id生成fc_加确定性短散列，返回短串，无状态。
	 * 例：同原itemId总得同结果，但shortHash不是密码学散列且可能碰撞；不据此证明同一次工具调用。
	 */
	const buildForeignResponsesItemId = (itemId: string): string => {
		// 外来item部分使用fc_加shortHash，不把原id全文截断造成相同前缀。
		const normalized = `fc_${shortHash(itemId)}`;
		// 仍保留最长64位保护，函数不额外建缓存。
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	/**
	 * 供transformMessages在跨模型历史中统一工具复合id；输入id、目标模型占位参数和原assistant，返回新id。
	 * 例：允许目标保留复合形式时call|foreignItem保留两段，跨provider/api的item段改为fc_散列；不允许时整个id当一段清洗。同provider/api换模型与跨API不同，后续回放还可能丢item id。
	 */
	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		// 目标不在允许集合时，连同|一起按普通字符清洗，不保留复合两段结构。
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		// 没有分隔符时也只清洗单段。
		if (!id.includes("|")) return normalizeIdPart(id);
		// 数组解构只取split后前两段，后面额外|片段不在变量中保留。
		const [callId, itemId] = id.split("|");
		// 调用id部分走清洗/截长/去尾下划线。
		const normalizedCallId = normalizeIdPart(callId);
		// 这里外来判断只比较provider/api，不比较model id。
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		// 跨provider/api的item用散列，否则清洗原item；let因后面补前缀可再赋值。
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		// 普通函数item需要fc_前缀，不只看是否以fc字母开头。
		if (!normalizedItemId.startsWith("fc_")) {
			// 缺前缀时补上再走长度限制，可能截掉尾部。
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		// 重新拼call|item，后续工具结果只用call部分。
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	// 统一历史转换先过滤失败/取消回复和跨模型thinking、处理签名/id，再补缺失结果。
	const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId);
	// 没有选项按空对象能力解析，结果通常none。
	const toolSupport = getResponsesToolSupport(options ?? {});
	// 基于normalized原轨迹计算哪些system工具变化已折进顶层；不直接使用transformed消息求索引。
	const transcriptTools = resolveTranscriptTools(normalizedContext.messages, toolSupport);
	// 是否已经发过additional_tools，本次转换局部状态而非跨请求全局变量。
	let declaredAdditionalTools = false;
	/** Tools announced as removed and not declared again since. */
	// 记录宣布移除后尚未重新声明的名字，供后续增量提示重申。
	const unavailableTools = new Set<string>();
	/**
	 * 把一条system里的toolsAdded转换为additional_tools或合成tool_search往返，原地追加到本次messages并更新声明/不可用集合。
	 * 例：再次添加read先从unavailable删read，再给后续工具批次写增量提示；没有新增就返回，不代表处理了本条toolsRemoved。
	 */
	const appendSystemToolAdditions = (message: SystemMessage, seed: string): void => {
		// 没有toolsAdded时用空数组；不在此自动取完整当前工具集。
		const tools = message.toolsAdded ?? [];
		// 重声明就从不可用集合去掉，即使之后未发实际变更也先更新本地集合。
		for (const tool of tools) unavailableTools.delete(tool.name);
		// 零新增直接返回，不产生空批次。
		if (tools.length === 0) return;
		// changes模式每个system的工具批次都原位发。
		if (toolSupport === "changes") {
			// 首批不用前置增量说明，之后每批都加。
			if (declaredAdditionalTools) {
				// 用当前instructionRole写提示；函数调用时外层角色const已初始化，闭包定义时尚不读取。
				messages.push({ role: instructionRole, content: renderIncrementalToolsNotice(unavailableTools) });
			}
			// 之后的批次要带增量说明，不按工具数重新置false。
			declaredAdditionalTools = true;
			// 追加实际原位工具声明条目。
			messages.push({
				// additional_tools是SDK输入条目标签。
				type: "additional_tools",
				// 此条目固定developer，与普通instructionRole的可变system/developer规则分开。
				role: "developer",
				// 声明格式/strict/grammar都委托统一工具转换。
				tools: convertResponsesTools(tools, options?.toolOptions),
				// satisfies检查此对象属于SDK联合，不产生校验/转换。
			} satisfies ResponseInputItem);
			// changes已处理完成，不再合成搜索记录。
			return;
		}
		// none模式不往输入追加工具变更，顶层工具由调用方另设。
		if (toolSupport !== "additions") return;
		// 取本次新增工具名列表，保留原顺序。
		const names = tools.map((tool) => tool.name);
		// 以system位置seed与名字生成可复现的合成call id；散列不保证绝对唯一。
		const callId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
		// 合成本地工具搜索调用，未真正向搜索器发请求。
		messages.push({
			// 工具搜索调用标签。
			type: "tool_search_call",
			// 和下一输出共用关联id。
			call_id: callId,
			// 声明该搜索由客户端执行。
			execution: "client",
			// 该历史记录直接标completed。
			status: "completed",
			// 查询文字按空格拼名，limit等于工具数量；只是合成上下文参数。
			arguments: { query: names.join(" "), limit: names.length },
			// 检查SDK条目类型，编译后不留下satisfies表达式。
		} satisfies ResponseInputItem);
		// 紧随搜索调用写对应结果。
		messages.push({
			// 搜索结果标签。
			type: "tool_search_output",
			// 沿用合成call id配对。
			call_id: callId,
			// 执行方仍为client。
			execution: "client",
			// 结果也标completed。
			status: "completed",
			// 复制toolOptions后强制toolSearchResult:true，使每个返回工具标延期发现；不修改原选项。
			tools: convertResponsesTools(tools, { ...options?.toolOptions, toolSearchResult: true }),
			// 检查搜索输出形状，不执行运行校验。
		} satisfies ResponseToolSearchOutputItemParam);
	};
	// ??只对null/undefined回退true；显式false只影响首条system正文路径。
	const includeInitialSystemMessage = options?.includeSystemPrompt ?? true;
	/**
	 * 向本次请求输入追加一个configuration_update，返回void，不更改历史消息。
	 * 例：effort="high"放入reasoning.effort；类型断言只适配SDK枚举，不校验任意字符串值，后续请求仍可能被服务端拒绝。
	 */
	const pushConfigurationUpdate = (effort: string): void => {
		// 配置变更是输入中的单独条目，不修改顶层reasoning参数。
		messages.push({
			// 配置更新标签。
			type: "configuration_update",
			// NonNullable去除SDK effort类型空值；as把任意string按该类型看待，不校验服务支持。
			reasoning: { effort: effort as NonNullable<ResponseConfigurationUpdateItemParam.Reasoning["effort"]> },
			// satisfies只在开发期验证对象字段与SDK声明兼容。
		} satisfies ResponseConfigurationUpdateItemParam);
	};
	// 把模型compat看成仅含developer支持的小视图，断言不删其他属性或验证真实形状。
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	// reasoning真且未显式禁developer才选developer，否则system，不按provider名硬编码。
	const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";

	// 用于fallback文字id/工具批次seed的索引，首条system不计数。
	let msgIndex = 0;
	// 记录遍历是否真在第一条；与msgIndex的用途不同。
	let sourceIndex = 0;
	// 只累计system子序列的位置，用来对齐工具折叠前缀。
	let systemIndex = 0;
	// 遍历transformMessages返回的序列，忽略其已经剔除的历史。
	for (const msg of transformedMessages) {
		// 后置++先用旧值比较0再加一，因此只有物理首项且role=system才是真头部。
		const isLeadingSystemMessage = sourceIndex++ === 0 && msg.role === "system";
		// system处理规则正文与工具变化，正文可能被跳过但工具仍先处理。
		if (msg.role === "system") {
			// transformMessages keeps system messages in order, so their position matches the transcript.
			// 后置++按system序号判断是否超出已折叠前缀，不能用普通消息下标替代。
			const anchorsToolChanges = systemIndex++ >= transcriptTools.foldedSystemMessages;
			// 需原位表达时先追加toolsAdded，早于本条删除提示；seed用当前msgIndex。
			if (anchorsToolChanges) appendSystemToolAdditions(msg, `system:${msgIndex}`);
			// 只跳过“首条且显式不含system正文”的情况，中途system仍处理。
			if (!isLeadingSystemMessage || includeInitialSystemMessage) {
				// 首条渲染完整提示词章节，中途渲染更新；先放一个文字片段。
				const parts = [isLeadingSystemMessage ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg)];
				// 只有未折入顶层的工具变化才在消息正文中提醒删除。
				if (anchorsToolChanges) {
					// A redefinition is a removal plus an addition of the same name; only true removals are announced.
					// 本条新增工具名集合用于识别同名重定义。
					const added = new Set((msg.toolsAdded ?? []).map((tool) => tool.name));
					// 移除列表去掉本条又新增的名字，只剩真正不可用的工具。
					const removed = (msg.toolsRemoved ?? []).map((tool) => tool.name).filter((name) => !added.has(name));
					// 有真实删除才追加自然语言删除提示，不发送wire撤销指令。
					if (removed.length > 0) parts.push(renderToolRemovalNotice(removed));
					// Recorded after this message's additions, whose notice precedes this removal notice.
					// 在这次新增批次提示之后记录删除，供下一批增量声明重申。
					for (const name of removed) unavailableTools.add(name);
				}
				// 过滤空片段后以空行拼接，长度非零但只含空格的字符串仍保留。
				const text = parts.filter((part) => part.length > 0).join("\n\n");
				// 仅空长度才省整条system文字。
				if (text.length > 0) {
					// 按已选instructionRole发送清孤立代理后的正文。
					messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
				}
			}
			// user消息转换保留普通文字/图片结构，不含历史工具权限判断。
		} else if (msg.role === "user") {
			// 合法content联合以typeof分为字符串或块数组。
			if (typeof msg.content === "string") {
				// 字符串user包装成输入内容数组。
				messages.push({
					// 角色仍为user。
					role: "user",
					// 普通文字转input_text并清孤立代理码元，空串也保留。
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
				// 结构化用户块逐项转换，空数组稍后跳过。
			} else {
				/**
				 * 把一条user的文字/图片块映射为Responses输入块，返回新对象，原顺序不变。
				 * 例：图片用data URL而非上传文件；satisfies仅检查开发期对象形状，不校验base64/MIME，也不探测模型图片能力。
				 */
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					// type标签把item收窄成文字或图片。
					if (item.type === "text") {
						// 文字块新建SDK对象。
						return {
							// 输入文字标签不同于assistant的output_text。
							type: "input_text",
							// 清理孤立代理码元，不删正常正文。
							text: sanitizeSurrogates(item.text),
							// satisfies检查构造，返回值保留更具体字面量类型。
						} satisfies ResponseInputText;
					}
					// 非文字的合法用户块为图片。
					return {
						// 图片输入标签。
						type: "input_image",
						// 交服务端auto选择细节级别。
						detail: "auto",
						// 直接拼内嵌base64 data URL，不校验编码。
						image_url: `data:${item.mimeType};base64,${item.data}`,
						// 检查SDK图片字段形状，未检测模型是否支持image。
					} satisfies ResponseInputImage;
				});
				// 空块数组跳过整条消息，此continue也跳过后面的msgIndex递增。
				if (content.length === 0) continue;
				// 将转换的用户消息追加到最终输入。
				messages.push({
					// 保留user角色。
					role: "user",
					// 属性简写放转换好的块数组。
					content,
				});
			}
			// assistant可能展开成多个SDK输出条目，不必与一条消息一对一。
		} else if (msg.role === "assistant") {
			// 先在局部数组收集本条回复的所有可回放条目。
			const output: ResponseInput = [];
			// 原断言不改变对象；role标签已经识别assistant。
			const assistantMsg = msg as AssistantMessage;
			// 记录供应商及API相同，不单凭供应商名判断。
			const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			// 同provider/api且同模型才称同模型，控制namespace与思考档位回放。
			const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
			// 同provider/api但换了模型时，单独处理item配对身份。
			const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
			// 同一assistant内多个文字块需不同fallback id后缀。
			let textBlockIndex = 0;

			// 按原内容块顺序生成reasoning/message/call条目。
			for (const block of msg.content) {
				// 思考块只有可用持久化签名时发送SDK reasoning条目。
				if (block.type === "thinking") {
					// 只有真值签名才JSON.parse，普通可见thinking文字不直接发送。
					if (block.thinkingSignature) {
						// 直接解析签名JSON且无本地catch；as不校验ResponseReasoningItem，坏JSON可抛。
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						// 将恢复对象原样作为输入条目，不重建其摘要/密文。
						output.push(reasoningItem);
					}
					// 文字块恢复id/阶段，正文按output_text发送。
				} else if (block.type === "text") {
					// 原类型断言只是协调已有文字块类型。
					const textBlock = block as TextContent;
					// 解析版本化或旧纯id签名；无签名则用fallback。
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					// 先形成当前块默认id。
					const fallbackMessageId =
						// 首文字块用msg_pi_索引，后续块追加本条文字块下标。
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					// 计数在拿到当前fallback后递增。
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					// let因为缺省/超长时需要更换id。
					let msgId = parsedSignature?.id;
					// 签名无id或空id时回退，空串也视为缺失。
					if (!msgId) {
						// 使用当前消息/文字块索引构造的fallback。
						msgId = fallbackMessageId;
						// 长id按字符串UTF-16码元长度判断，不算UTF-8字节。
					} else if (msgId.length > 64) {
						// 超长id改为msg_加短散列，仍可能碰撞。
						msgId = `msg_${shortHash(msgId)}`;
					}
					// 每个文字块生成独立已完成assistant message条目。
					output.push({
						// 输出消息条目标签。
						type: "message",
						// 回放角色为assistant。
						role: "assistant",
						// 文字清孤立代理，annotations置新空数组，没有回放原引用注释。
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						// 历史回放条目状态标completed。
						status: "completed",
						// 使用原短id或生成的替代id。
						id: msgId,
						// 合法阶段才有值，undefined在实际JSON编码时可省略。
						phase: parsedSignature?.phase,
						// SDK对象形状由satisfies开发期检查。
					} satisfies ResponseOutputMessage);
					// 工具调用按grammar能力选custom或function回放。
				} else if (block.type === "toolCall") {
					// 将已收窄块按ToolCall接口使用，未创建副本。
					const toolCall = block as ToolCall;
					// 复合工具id只取call和item前两段；缺分隔符item可undefined。
					const [callId, itemIdRaw] = toolCall.id.split("|");
					// 按工具名读取grammar唯一文字属性；存在空串也仍算有配置。
					const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
					// itemId可能缺失且后续会按目标/类型条件删除。
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which item IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					// Also drop ids that do not match the replayed item type: function_call ids must be fc_*
					// and custom_tool_call ids must be ctc_*. Foreign tool call ids are normalized to fc_*, and
					// a call can switch between the two types when grammar tool support differs.
					// function条目要求fc_，custom条目要求ctc_；这不是所有id通用同一前缀。
					const itemIdPrefix = customInputProperty === undefined ? "fc_" : "ctc_";
					// 同provider/api换模型，或item前缀不匹配当前回放类型，都省item id。
					if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
						// 只清局部itemId，不改已存ToolCall.id或call_id。
						itemId = undefined;
					}

					// 判断是undefined而非真值，已配置grammar属性即走custom。
					if (customInputProperty !== undefined) {
						// 追加custom_tool_call输入条目。
						output.push({
							// custom调用标签。
							type: "custom_tool_call",
							// 可省略的服务器item身份，和call_id分开。
							id: itemId,
							// 工具结果关联用调用id部分。
							call_id: callId,
							// 工具公开名称。
							name: toolCall.name,
							// 取grammar原始文字后清孤立代理码元。
							input: sanitizeSurrogates(
								// 取值helper只要求指定承载属性是字符串，不禁止其他参数字段；这里回放时只使用该字符串。
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
							// 仅同provider/api/model且namespace存在才保留，不声称重放跨模型动态命名空间。
							...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
							// 检查属于SDK输出条目联合。
						} satisfies ResponseOutputItem);
						// 没有grammar属性配置，使用普通function_call。
					} else {
						// 追加普通函数调用条目。
						output.push({
							// 函数调用标签。
							type: "function_call",
							// 可省略的item id。
							id: itemId,
							// 结果关联call id。
							call_id: callId,
							// 工具名保持不变。
							name: toolCall.name,
							// 参数编码为JSON字符串，循环引用/BigInt等不可编码数据可抛。
							arguments: JSON.stringify(toolCall.arguments),
							// 普通函数的namespace也只有同模型保留，条件与custom一致。
							...(isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {}),
						});
					}
				}
			}
			// 本回复无可发送内容就跳过；这个continue不递增msgIndex，不插历史配置更新。
			if (output.length === 0) continue;
			// 以下三项全满足才为历史回复插档位更新。
			if (
				// 本次调用启用了配置更新方式，空串也算显式值。
				options?.configurationUpdateEffort !== undefined &&
				// 历史必须同供应商、API、模型。
				isSameModel &&
				// 该历史回复确实记录providerThinkingLevel，不能从当前默认倒推旧档位。
				msg.providerThinkingLevel !== undefined
			) {
				// 放在这条历史回复的所有输出条目之前，不按每个文字块重复插。
				pushConfigurationUpdate(msg.providerThinkingLevel);
			}
			// 展开本条回复的全部条目到最终输入，顺序不变。
			messages.push(...output);
			// 工具结果按当前grammar配置决定对应输出种类。
		} else if (msg.role === "toolResult") {
			// 只取复合id的call部分供结果配对。
			const [callId] = msg.toolCallId.split("|");
			// 文字/图片工具结果按目标图片能力转换，无图片时可为占位字串。
			const output = convertToolResultOutput(model, msg.content);

			// 此处分支查Map.has，与call路径get!==undefined的契约依赖正常Map值类型一致。
			if (options?.grammarToolInputProperties?.has(msg.toolName)) {
				// grammar结果用custom输出条目。
				messages.push({
					// custom工具结果标签。
					type: "custom_tool_call_output",
					// 关联调用id而非item id。
					call_id: callId,
					// 结果可为字符串或文字/图片数组。
					output,
				});
				// 其他工具结果走普通function输出。
			} else {
				// 追加函数结果条目。
				messages.push({
					// 普通函数结果标签。
					type: "function_call_output",
					// 关联call id。
					call_id: callId,
					// 沿用已转换的结果值。
					output,
				});
			}
		}
		// 首条system不计消息id索引；上面continue的空消息也不会走到这一行递增。
		if (!isLeadingSystemMessage) msgIndex++;
	}
	// 本次档位只要显式给出，就在全部历史/工具结果后追加一次，即使没有历史回复。
	if (options?.configurationUpdateEffort !== undefined) pushConfigurationUpdate(options.configurationUpdateEffort);

	// 返回输入数组，顶层tools/reasoning等请求字段由调用方设置。
	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

/**
 * 把工具声明数组映射为Responses工具：优先可用grammar自定义工具，否则function+schema/strict；返回新数组，不执行工具或验证调用参数。
 * 例：Lark变体且支持grammar时生成custom工具；不支持grammar就回退普通function。JSON schema的require不支持可抛、prefer可回退，这两个模式不用于grammar。
 * strict缺省false，显式null保留；supportsStrictMode=false仅省略strict字段，不等于此函数会忽略一切schema转换。
 */
export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	// 仅undefined用false，显式null允许继续作为默认strict。
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	// 目标是否接受strict字段，缺省true。
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	// 是否支持OpenAI custom grammar，缺省false。
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	/**
	 * 转换一个工具声明并返回SDK工具对象；先协商grammar，成功则提前返回custom，否则解析JSON schema strict。
	 * 例：toolSearchResult=true把结果项标defer_loading；这些是声明元数据，不是在此延期执行已生成的工具调用。
	 */
	return tools.map((tool) => {
		// 目标支持grammar时检查变体与承载字段，坏配置可抛；不支持时直接回退，没有grammar专属require/prefer模式。
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		// 协商得到grammar时提前用custom工具，不再运行JSON strict分支。
		if (grammar) {
			// 创建自定义工具声明。
			return {
				// 工具类型custom，模型给的输入是单段文字。
				type: "custom",
				// 原工具名。
				name: tool.name,
				// 原用途说明。
				description: tool.description,
				// format约束说明使用语法格式。
				format: {
					// grammar格式标签。
					type: "grammar",
					// 选择出的lark或regex等受支持语法名，实际支持由helper检查。
					syntax: grammar.format,
					// 原语法定义文本，不在这里本地编译验证或改写。
					definition: grammar.definition,
				},
				// 当结果来自工具搜索时标defer_loading，否则不附字段。
				...(options?.toolSearchResult ? { defer_loading: true } : {}),
				// 检查SDK工具联合形状，不会真正校验生成内容符合语法。
			} satisfies OpenAITool;
		}

		// 没有使用grammar时才解析JSON schema严格要求。
		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		// 工具严格约束解析成功的true优先，undefined才回退调用级默认strict（可false/null）。
		const strict = constrainedStrict ?? defaultStrict;
		// Extract从SDK联合取function项，Omit暂移除必需strict，再用交叉类型改成可选方便按能力省略。
		const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			// strict?复用SDK字段类型boolean|null，仅为构造时的类型协调。
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
			// 交叉类型注解后的真实对象从这里开始。
		} = {
			// 普通函数工具类型。
			type: "function",
			// 原工具名。
			name: tool.name,
			// 用途描述。
			description: tool.description,
			// strict===true才收窄schema；断言只声明普通对象形状，不在此验证生成参数。
			parameters: getJsonSchemaToolParameters(tool, strict === true) as Record<string, unknown>,
			// 搜索结果才附defer_loading:true。
			...(options?.toolSearchResult ? { defer_loading: true } : {}),
		};
		// 只有目标声明支持strict字段才在对象里写它。
		if (supportsStrictMode) {
			// 可写入true/false/null；省字段与strict:false不是同一对象形状。
			functionTool.strict = strict;
		}
		// 用原断言返回完整工具联合，不自动补SDK类型所需而目标不支持的字段。
		return functionTool as OpenAITool;
	});
}

// =============================================================================
// Stream processing
// =============================================================================

/**
 * Stream state of a tool call, kept in its output slot and never on the content block, so it never reaches partials:
 * the JSON arguments of a function call, or the input of a custom (grammar) tool call.
 */
// 私有工具输入状态的带kind联合，和公开ToolCall分开；解析器/缓冲状态不进入partial，custom的原始文字仍正常放在公开arguments中。
type ToolCallInput =
	// json分支持有每调用专属解析器；readonly仅限制TS改引用，解析器自身仍可变。
	| { readonly kind: "json"; readonly arguments: ToolCallArgumentsStream }
	// custom分支将原始输入包装成单字符串属性JSON。
	| {
			// 固定kind标签供分支收窄。
			readonly kind: "custom";
			// 唯一字符串参数的属性名，readonly不冻结字符串之外的状态。
			readonly property: string;
			// 可变grammar缓冲引用，本字段readonly不阻止修改buffer.input。
			readonly buffer: GrammarToolInputJsonBuffer;
			/** JSON text of the item's initial input, sent with the first delta. */
			// 尚未通过delta事件发出的初始JSON前缀，可变字符串。
			unsent: string;
	  };

// 供应商输出索引对应的槽联合，每个槽记公开块及其Pi contentIndex。
type ResponsesOutputSlot =
	// 思考槽的block与output.content中同一对象。
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	// 文字槽累积text。
	| { type: "text"; block: TextContent; contentIndex: number }
	// 工具槽额外持有私有参数状态，公开block不挂解析器。
	| { type: "toolCall"; block: ToolCall; contentIndex: number; input: ToolCallInput };

// Extract编译期提取toolCall槽，便于push工具增量时不重复断言。
type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

/**
 * 消费Responses异步事件，原地组装传入assistant并向stream发start/delta/end块事件；返回Promise<void>，不负责发整条回答的done/error或结束stream。
 * 输入output应由上层初始化；按output_index保存各块独立状态，参数解析器不塞进公开partial，终态时补id/用量/费用/停止原因。例：两个工具索引0/1交错增量，分别进入各自槽位。
 * 缺槽增量忽略，output_item.done可补建槽；重复added可覆盖同索引，缺索引/错误索引并非完整协议校验。流无终态、显式failed/error、最终toolUse仍有未完成调用会拒绝；此前修改与已发事件不回滚。
 * raw观察钩子每条先await，抛错会中断；终态事件到来不立刻break，仍消费后续事件直到源结束。本函数不直接调用网络abort；循环体抛错等提前退出时，for await按协议调用源的return（若有），实际清理由源实现决定。
 */
export async function processResponsesStream<TApi extends Api>(
	// SDK异步事件源，for await按事件产出顺序消费。
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	// 调用方初始化的可变assistant对象，函数持续原地更新。
	output: AssistantMessage,
	// 传入事件流只发布内容块事件；完整done/error由上层负责。
	stream: AssistantMessageEventStream,
	// 模型用于观察钩子身份和目录费用计算，不用于重新创建HTTP流。
	model: Model<TApi>,
	// 可选原始事件钩子、tier策略和grammar属性映射。
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	// 区分正常收到终态与提前EOF，初始false。
	let sawTerminalResponseEvent = false;
	// 以供应商output_index为键，不以item.id或Pi内容索引为键。
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	// Tool calls whose output_item.done has not arrived yet.
	// 保存仍等output_item.done的工具对象身份，即便索引后来被覆盖也仍记得旧对象。
	const unfinishedToolCalls = new Set<ToolCall>();
	// 以reasoning item id找已经结束的块，供终态补密文。
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	/**
	 * 看到message.phase=final_answer时暂设stop，返回void；例：块start可先展示最终回答阶段，之后incomplete终态仍能覆盖成length/error，不是最终完成保证。
	 */
	const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
		// 仅message且phase=final_answer才暂设stop，其他条目不改。
		if (item.type === "message" && item.phase === "final_answer") {
			// 阶段提示可先呈现为stop，但仍必须等终态检查，不代表已结算。
			output.stopReason = "stop";
		}
	};
	/**
	 * 按供应商output_index读取指定类型槽，无匹配返回undefined，不新建或修改状态。
	 * 例：索引0是text而请求thinking则undefined；Extract/泛型让TS返回对应block类型，运行时只比type，未校验索引范围。
	 */
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		// 供应商输出索引，正常类型为number，未在此检查范围/存在。
		outputIndex: number,
		// 请求的槽类型字面量，泛型TType随它推导。
		type: TType,
		// Extract返回对应窄分支或undefined，类型工具运行时不存在。
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		// Map.get按索引读取，未找到返回undefined。
		const slot = outputSlots.get(outputIndex);
		// 运行时只对type标签做等值比较，断言让TS保留泛型关联；不验证block内部形状。
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	/**
	 * 把存在的JSON参数增量发到工具槽对应的contentIndex，不修改参数；undefined跳过，空串仍可发。
	 * 例：custom输入封口形成一段JSON后用同一工具事件通道；partial引用当前output，不是当时快照副本。
	 */
	const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
		// undefined代表没有可发送片段；空串不在这里跳过。
		if (delta === undefined) return;
		// 向流追加一条工具参数增量事件。
		stream.push({
			// Pi工具增量事件标签。
			type: "toolcall_delta",
			// 使用公开content数组下标，与供应商output_index不是同一个数值空间。
			contentIndex: slot.contentIndex,
			// 属性简写发送输入delta原值。
			delta,
			// 同一output对象引用，未复制过去快照。
			partial: output,
		});
	};
	/**
	 * 按reasoning/message/function_call/custom_tool_call建立独立块与槽，追加output并发块开始事件，返回槽；其他item返回undefined。
	 * 例：function_call持有私有参数解析器，公开ToolCall只存参数预览；custom用配置属性名或input。重复同outputIndex会覆盖Map条目，但已追加content不会自动删除。
	 */
	const createSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		// 只对reasoning等受支持类型创建槽。
		if (item.type === "reasoning") {
			// 建立空思考块，忽略added里尚未稳定的内容/密文。
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			// 块进入公开assistant内容数组。
			output.content.push(block);
			// 记录该块的私有槽。
			const slot = {
				// 槽类型thinking。
				type: "thinking",
				// 复用同一思考块引用。
				block,
				// append后最后一项是该块的公开下标。
				contentIndex: output.content.length - 1,
				// satisfies让槽保持字面量类型并检查联合契约。
			} satisfies ResponsesOutputSlot;
			// 保存/覆盖供应商索引对应槽，旧content块并不自动删除。
			outputSlots.set(outputIndex, slot);
			// 先发开始事件，partial指向同一output。
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			// 返回新槽给后续done等路径复用。
			return slot;
		}
		// message条目建立文字槽，多个SDK内容部分最终合成一个Pi text块。
		if (item.type === "message") {
			// added阶段已有final_answer标记也能更新暂时stopReason。
			applyMessagePhaseStopReason(item);
			// 初始text为空，内容由delta/done填入。
			const block: TextContent = { type: "text", text: "" };
			// 公开内容数组追加文字块。
			output.content.push(block);
			// 记录类型、块与公开下标，satisfies不产生运行转换。
			const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
			// 以当前供应商索引登记。
			outputSlots.set(outputIndex, slot);
			// 发布文字开始事件。
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			// 返回文字槽。
			return slot;
		}
		// 普通函数调用维护JSON参数流。
		if (item.type === "function_call") {
			// 每次新调用单独创建解析器，避免交错参数串线。
			const args = new ToolCallArgumentsStream();
			// 建立公开ToolCall，不挂解析器或累计原始JSON。
			const block: ToolCall = {
				// 统一工具调用内容块标签。
				type: "toolCall",
				// 复合id把供应商call_id与item.id拼接，供后续回放分开使用。
				id: `${item.call_id}|${item.id}`,
				// 工具名原样保留。
				name: item.name,
				// added内已有非空参数则先append得到预览，否则空对象；此处尚未最终解析确认。
				arguments: item.arguments ? args.append(item.arguments) : {},
				// namespace只要不是undefined就保留，不按真值忽略空串。
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
			};
			// 追加公开工具块。
			output.content.push(block);
			// 登记为未完成，只有对应done分支才删除此对象。
			unfinishedToolCalls.add(block);
			// 建立工具槽同时保存私有输入状态。
			const slot = {
				// 槽类型toolCall。
				type: "toolCall",
				// 指向公开ToolCall。
				block,
				// 该调用在Pi内容中的下标。
				contentIndex: output.content.length - 1,
				// kind=json时arguments指向解析器，与block.arguments公开预览不同。
				input: { kind: "json", arguments: args },
				// satisfies检查槽构造。
			} satisfies ResponsesOutputSlot;
			// 按供应商索引保存，未额外按item.id核验唯一性。
			outputSlots.set(outputIndex, slot);
			// 发布工具开始事件，不单独为added内初始参数发delta。
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			// 返回普通函数槽。
			return slot;
		}
		// grammar工具调用使用原始字符串输入，仍映射成Pi ToolCall。
		if (item.type === "custom_tool_call") {
			// 优先Map属性名，缺省input；??保留空串属性名。
			const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
			// 初始custom输入取真值，否则空串。
			const input = item.input || "";
			// 新建公开工具块。
			const block: ToolCall = {
				// 公开类型仍为toolCall，不暴露custom协议差异。
				type: "toolCall",
				// 仍以call|item复合标识存储。
				id: `${item.call_id}|${item.id}`,
				// 原工具名。
				name: item.name,
				// 计算属性名[inputProperty]在运行时创建唯一参数键。
				arguments: { [inputProperty]: input },
				// 已有namespace可保存到历史。
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
			};
			// 将块追加公开内容。
			output.content.push(block);
			// custom也要等output_item.done才从未完成集合删除。
			unfinishedToolCalls.add(block);
			// 新建toolCall槽。
			const slot = {
				// 槽类型toolCall。
				type: "toolCall",
				// 公开块引用。
				block,
				// Pi content下标。
				contentIndex: output.content.length - 1,
				// 私有customInput缓冲会保存初始JSON前缀，等后续delta/封口才发送。
				input: customInput(inputProperty, input),
				// 联合类型检查，input的kind用来和json分流。
			} satisfies ResponsesOutputSlot;
			// 登记供应商输出索引。
			outputSlots.set(outputIndex, slot);
			// 发工具开始事件，此时参数预览已有初始input。
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			// 返回custom槽。
			return slot;
		}
		// 搜索/音频/其他尚不支持条目不创建Pi块，但原始事件观察器仍可收到事件。
		return undefined;
	};
	/**
	 * 复用现有索引槽或从done条目补建，返回可空槽；例：漏发added但有done时仍可创建并随后结束。
	 * 只看索引，不额外检查现有槽类型是否与item一致；后续分支会检查标签，不能解释为按item.id自动修复错位。
	 */
	const getOrCreateSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		// ??只在索引无槽时补建，已有不同类型槽也直接返回，不按item.id重配。
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	// Azure OpenAI can omit reasoning.encrypted_content from response.output_item.done
	// and provide it only in response.completed.response.output. Backfill the
	// persisted reasoning signature from the terminal response to keep store:false
	// multi-turn replay stateless. See https://github.com/earendil-works/pi/issues/6409.
	/**
	 * 用终态response.output为此前已经结束并登记的reasoning块补encrypted_content，原地更新其序列化签名，无新增块/事件。
	 * 例：Azure的output_item.done缺密文，completed才有密文时补上；已有非空密文不覆盖，没有已保存签名的块也不补建，坏签名JSON可抛。
	 */
	const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
		// 遍历终态响应所有output条目。
		for (const item of responseOutput) {
			// 仅带真值密文的reasoning条目值得补齐。
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			// 必须此前在reasoning done分支按同item id登记过。
			const block = reasoningBlocksById.get(item.id);
			// 没有对应块或保存签名就跳过，不从终态重建完整思考块。
			if (!block?.thinkingSignature) continue;

			// 取已有签名JSON恢复保存条目；这里只断言类型，不catch损坏JSON。
			const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			// 已有真值密文保留，不让终态密文覆盖。
			if (storedItem.encrypted_content) continue;
			// 替换block的序列化签名字符串。
			block.thinkingSignature = JSON.stringify({
				// 保留旧签名条目的其他字段/摘要。
				...storedItem,
				// 只补终态提供的encrypted_content。
				encrypted_content: item.encrypted_content,
			});
		}
	};
	/**
	 * 处理completed/incomplete的权威结算：记终态、补签名、更新id/用量、计算目录费用与可选tier费率，再映射停止原因；原地改output，不发整条done事件。
	 * 例：input_tokens20含cacheRead2/cacheWrite3，普通input=15；max_output_tokens→length；只有正常stop且含工具才转toolUse。缺usage仍对已有output.usage重算费用，不保证供应商账单准确。
	 */
	const finalizeResponse = (
		// Extract取两个终态事件再索引response字段，避免重复手写SDK响应形状。
		response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	): void => {
		// 先标记收到终态，后续钩子/计算若抛错仍会拒绝本函数。
		sawTerminalResponseEvent = true;
		// response.output缺省时用空数组；补密文不补未完成工具done。
		backfillReasoningSignatures(response.output ?? []);
		// 响应id非空才覆盖先前created记录。
		if (response?.id) {
			// 在公开assistant保存responseId。
			output.responseId = response.id;
		}
		// 有usage才整体替换计数，否则沿用已有Usage对象。
		if (response?.usage) {
			// 兼容某些后端额外cache_write_tokens；as不验证响应数据。
			const inputDetails = response.usage.input_tokens_details as
				// 声明两个可选缓存计数字段。
					| { cached_tokens?: number; cache_write_tokens?: number }
					// input details可缺省。
					| undefined;
			// 缺值/0/NaN等假值按0；不在此检查是否负数。
			const cachedTokens = inputDetails?.cached_tokens || 0;
			// 缓存写入字段同样采用||0后备。
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			// 新建统一用量对象，避免把SDK形状直接存历史。
			output.usage = {
				// OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
				// SDK输入总数含缓存读/写，减两者并钳制普通input不小于0；未对其他计数字段做同样钳制。
				input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
				// 输出token缺值时0。
				output: response.usage.output_tokens || 0,
				// 缓存读取计数单列。
				cacheRead: cachedTokens,
				// 缓存写入计数单列。
				cacheWrite: cacheWriteTokens,
				// reasoning计数是输出token内的附加维度，不在下面totalTokens里再额外相加。
				reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
				// 沿用SDK总数，不通过前面字段重算一致性。
				totalTokens: response.usage.total_tokens || 0,
				// 先建全零费用，下一步按模型目录价原地填。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		// 无论本次是否提供usage，都对当前output.usage重算目录费用。
		calculateCost(model, output.usage);
		// 只有配置费用调整回调才做tier选择/调整。
		if (options?.applyServiceTierPricing) {
			// 提供自定义解析器则由它决定最终tier。
			const serviceTier = options.resolveServiceTier
				? // 两个候选都传给解析器，返回可undefined。
					options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: // 否则终态非null/undefined tier优先，再回请求tier。
					(response?.service_tier ?? options.serviceTier);
			// 回调原地处理Usage，若抛错本函数拒绝，无隔离/回滚。
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		// Map status to stop reason. For incomplete responses, retain the provider's
		// specific reason so max-output truncation and content filtering stay distinct.
		// 从响应状态取统一停止语义，不只看最后一个message phase。
		const status = response?.status;
		// 兼容后端未在SDK严格类型中列出的细分reason，声明unknown以做实际检查。
		const incompleteDetails = response?.incomplete_details as { reason?: unknown } | null | undefined;
		// 只有真实string reason才采用，不把任意对象转提示。
		const incompleteReason = typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
		// 非空reason附到status后形成原始停止原因，否则仅status。
		output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
		// 按终态status+reason映射，未支持status可抛。
		const mappedStop = mapStopReason(status, incompleteReason);
		// 权威终态覆盖前面phase设置的临时状态。
		output.stopReason = mappedStop.stopReason;
		// 没有新错误文字就删旧errorMessage属性，不赋undefined伪装不存在。
		if (mappedStop.errorMessage === undefined) delete output.errorMessage;
		// 有映射错误说明则写入。
		else output.errorMessage = mappedStop.errorMessage;
		// 只有mapped为stop且公开内容含工具调用才转toolUse，length/error不改工具状态。
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			// 告诉上层需要执行已完成工具调用，后面还有未完成调用检查。
			output.stopReason = "toolUse";
		}
	};

	// 逐条等待源事件；本循环不会在completed后自动break。
	for await (const event of openaiStream) {
		// 先await原始事件钩子，再处理事件；钩子异常可中断消费，并能观察未支持条目。
		await options?.onProviderStreamEvent?.(event, model);
		// 响应创建事件尽早记录供应商response id。
		if (event.type === "response.created") {
			// 直接写事件response.id，未额外验证其格式。
			output.responseId = event.response.id;
			// 新增输出条目尝试建对应槽。
		} else if (event.type === "response.output_item.added") {
			// 这里只按output_index路由，未检查added重复或索引连续。
			createSlot(event.output_index, event.item);
			// 思考摘要文字增量。
		} else if (event.type === "response.reasoning_summary_text.delta") {
			// 只取相同索引的thinking槽。
			const slot = getSlot(event.output_index, "thinking");
			// 无槽/类型不符就忽略本条增量，不补建。
			if (!slot) continue;
			// 原地追加到思考文字。
			slot.block.thinking += event.delta;
			// 同时向公开流发相同增量。
			stream.push({
				// 思考增量标签。
				type: "thinking_delta",
				// 使用槽记录的Pi内容下标。
				contentIndex: slot.contentIndex,
				// 原SDK摘要增量。
				delta: event.delta,
				// 共享output引用。
				partial: output,
			});
			// 摘要段落完成不结束整个reasoning条目。
		} else if (event.type === "response.reasoning_summary_part.done") {
			// 仍按索引找thinking槽。
			const slot = getSlot(event.output_index, "thinking");
			// 缺槽即跳过段落分隔。
			if (!slot) continue;
			// 摘要段结束追加两个换行，供后续摘要段继续。
			slot.block.thinking += "\n\n";
			// 同步发送这次人为追加的段落分隔增量。
			stream.push({
				// 仍是thinking_delta，不是thinking_end。
				type: "thinking_delta",
				// 对应Pi思考块下标。
				contentIndex: slot.contentIndex,
				// 增量内容是固定两个换行。
				delta: "\n\n",
				// 共享当前output。
				partial: output,
			});
			// 完整思考正文的增量也走thinking块。
		} else if (event.type === "response.reasoning_text.delta") {
			// 按索引与类型定位。
			const slot = getSlot(event.output_index, "thinking");
			// 未建思考槽则跳过，不把增量当普通text。
			if (!slot) continue;
			// 原地累积思考正文。
			slot.block.thinking += event.delta;
			// 发思考增量事件。
			stream.push({
				// 思考delta标签。
				type: "thinking_delta",
				// 公开内容下标。
				contentIndex: slot.contentIndex,
				// 沿用供应商文字增量。
				delta: event.delta,
				// partial仍是同一对象。
				partial: output,
			});
			// 普通回答文字增量。
		} else if (event.type === "response.output_text.delta") {
			// 按供应商索引找text槽。
			const slot = getSlot(event.output_index, "text");
			// 无匹配槽忽略。
			if (!slot) continue;
			// 更新公开文字块。
			slot.block.text += event.delta;
			// 发公开文字delta。
			stream.push({
				// 文字增量标签。
				type: "text_delta",
				// 槽记录的contentIndex。
				contentIndex: slot.contentIndex,
				// 供应商原delta字串。
				delta: event.delta,
				// 当前assistant原引用。
				partial: output,
			});
			// 拒绝回答文字也呈现在text块中，不在这里单独改error状态。
		} else if (event.type === "response.refusal.delta") {
			// 拒绝增量要求已有text槽。
			const slot = getSlot(event.output_index, "text");
			// 无槽直接跳过。
			if (!slot) continue;
			// 把拒绝文字追加到同一可见正文。
			slot.block.text += event.delta;
			// 按普通text_delta向外发送。
			stream.push({
				// 文字增量事件标签。
				type: "text_delta",
				// 该text块公开下标。
				contentIndex: slot.contentIndex,
				// 拒绝文字delta原值。
				delta: event.delta,
				// 共享output。
				partial: output,
			});
			// 普通函数参数JSON增量。
		} else if (event.type === "response.function_call_arguments.delta") {
			// 按输出索引取toolCall槽。
			const slot = getSlot(event.output_index, "toolCall");
			// 必须确实是json参数状态，custom或缺槽忽略。
			if (slot?.input.kind !== "json") continue;
			// 解析器累积新JSON并返回当前对象预览，整体替换公开arguments引用。
			slot.block.arguments = slot.input.arguments.append(event.delta);
			// 同时发原始JSON字串增量，未重复序列化预览对象。
			pushToolCallDelta(slot, event.delta);
			// 参数全文done与条目done是不同事件，此处尚不认为工具完成。
		} else if (event.type === "response.function_call_arguments.done") {
			// 定位现有工具槽。
			const slot = getSlot(event.output_index, "toolCall");
			// 非json槽不处理这个全文事件。
			if (slot?.input.kind !== "json") continue;
			// 接受供应商完整参数文本：续旧前缀可补差量，否则重置解析预览。
			const replaced = slot.input.arguments.replace(event.arguments);
			// 公开参数换成全文对应的预览对象。
			slot.block.arguments = replaced.arguments;
			// 只有非空可追加后缀才发delta；非前缀替换的delta=undefined，最终toolcall_end仍给权威完整对象。
			if (replaced.delta) pushToolCallDelta(slot, replaced.delta);
			// custom原始字符串输入的增量。
		} else if (event.type === "response.custom_tool_call_input.delta") {
			// 定位toolCall槽。
			const slot = getSlot(event.output_index, "toolCall");
			// 必须是custom输入状态。
			if (slot?.input.kind !== "custom") continue;
			// 更新原始缓冲/公开参数并发送对应转义JSON增量，不把原文字直接当JSON。
			pushToolCallDelta(slot, appendCustomInput(slot.block, slot.input, event.delta));
			// custom输入全文done先封口字符串缓冲，但未从未完成工具集合移除。
		} else if (event.type === "response.custom_tool_call_input.done") {
			// 按索引找工具槽。
			const slot = getSlot(event.output_index, "toolCall");
			// 不是custom就忽略。
			if (slot?.input.kind !== "custom") continue;
			// 用完整输入补后缀封口，矛盾前缀可抛；helper可返回undefined不发增量。
			pushToolCallDelta(slot, closeCustomInput(slot.block, slot.input, event.input));
			// 整个输出条目done才发块end并释放对应槽。
		} else if (event.type === "response.output_item.done") {
			// 局部item取终态条目，不沿用added时不完整对象。
			const item = event.item;
			// done中的final_answer也可更新暂时stop。
			applyMessagePhaseStopReason(item);
			// 漏added可在done时补建，但已有同索引异类型槽不自动更换。
			const slot = getOrCreateSlot(event.output_index, item);

			// reasoning条目与槽类型同时匹配才结算思考。
			if (item.type === "reasoning" && slot?.type === "thinking") {
				// 优先把done摘要各段用空行拼接，空/缺省回空串。
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				// 没有可用摘要时可取完整思考正文各段。
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				// 摘要非空优先，其次正文，否则保留此前delta累积，不用空done抹掉已有思考。
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				// 整个reasoning条目编码到签名，含可回放密文/摘要，不仅存visible thinking。
				slot.block.thinkingSignature = JSON.stringify(item);
				// 按item id记块，供completed/incomplete再补密文。
				reasoningBlocksById.set(item.id, slot.block);
				// 发思考块完成事件。
				stream.push({
					// thinking_end只结束此内容块，不结束整条assistant。
					type: "thinking_end",
					// 公开块下标。
					contentIndex: slot.contentIndex,
					// 最终思考文字。
					content: slot.block.thinking,
					// 共享已更新output。
					partial: output,
				});
				// 释放供应商输出索引槽，公开内容和reasoning按id索引仍留存。
				outputSlots.delete(event.output_index);
				// message条目与text槽匹配时结算可见文字。
			} else if (item.type === "message" && slot?.type === "text") {
				// done中的output_text/refusal依序无分隔拼接，空/缺省会覆盖成空串，不像thinking保留旧delta。
				slot.block.text = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				// 把item id及可选phase存入版本化本地文字签名；null phase转undefined省略。
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				// 发布文字块完成。
				stream.push({
					// text_end标签。
					type: "text_end",
					// 公开块下标。
					contentIndex: slot.contentIndex,
					// 权威完成文字。
					content: slot.block.text,
					// 共享output。
					partial: output,
				});
				// 删除此输出索引槽。
				outputSlots.delete(event.output_index);
				// 普通函数条目、工具槽及json状态三者必须匹配。
			} else if (item.type === "function_call" && slot?.type === "toolCall" && slot.input.kind === "json") {
				// 非空最终参数文本先替换解析器全文；空串则保留已有累计文本。
				if (item.arguments) slot.input.arguments.replace(item.arguments);
				// 最终解析返回arguments及可能argumentsError，Object.assign原地写公开块；schema字段验证仍由工具执行层完成。
				Object.assign(slot.block, slot.input.arguments.finish());
				// done才出现的namespace也补进块，不把缺省值覆盖已有namespace。
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				// 此对象已收到完成条目，从未完成集合删掉。
				unfinishedToolCalls.delete(slot.block);
				// 发工具调用完成事件。
				stream.push({
					// toolcall_end不等于工具实际执行完，只代表模型调用参数已经组装完。
					type: "toolcall_end",
					// 公开调用块下标。
					contentIndex: slot.contentIndex,
					// 直接传同一ToolCall对象。
					toolCall: slot.block,
					// partial共享最终assistant。
					partial: output,
				});
				// 私有索引槽可释放；工具块继续存在公开内容中。
				outputSlots.delete(event.output_index);
				// custom条目必须配custom工具槽。
			} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.input.kind === "custom") {
				// 封口最终输入并发尚未发完的JSON增量；若前面input.done已一致封口则不重复发。
				pushToolCallDelta(slot, closeCustomInput(slot.block, slot.input, item.input));
				// 补done才返回的namespace。
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				// 此custom工具调用也从未完成集合删除。
				unfinishedToolCalls.delete(slot.block);
				// 发布工具块完成事件。
				stream.push({
					// 工具调用结束标签。
					type: "toolcall_end",
					// 公开调用块下标。
					contentIndex: slot.contentIndex,
					// 同一公开工具调用对象。
					toolCall: slot.block,
					// 共享output引用。
					partial: output,
				});
				// 删除对应索引私有槽。
				outputSlots.delete(event.output_index);
			}
			// 两种可正常结算的终态都走finalizeResponse。
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			// 只更新output，不发done、不中断for await，后续源事件仍可被处理。
			finalizeResponse(event.response);
			// SDK显式error事件立即拒绝。
		} else if (event.type === "error") {
			// 模板字串含固定前缀所以总非空，||后的Unknown error实际上不会因message缺省被选中。
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
			// failed是终态但以异常向上层交失败，不走普通用量结算。
		} else if (event.type === "response.failed") {
			// 先记已见终态，实际随后立即throw。
			sawTerminalResponseEvent = true;
			// 保留供应商raw状态。
			output.rawStopReason = event.response?.status;
			// 优先取结构化错误。
			const error = event.response?.error;
			// 没有错误时再尝试incomplete details。
			const details = event.response?.incomplete_details;
			// 依存在的错误来源选择可显示说明。
			const msg = error
				? // 错误code/message各有假值后备。
					`${error.code || "unknown"}: ${error.message || "no message"}`
				: // 没有error对象则看details.reason。
					details?.reason
					? // 有reason时加incomplete前缀。
						`incomplete: ${details.reason}`
					: // 所有详情缺省才用固定Unknown说明。
						"Unknown error (no error details in response)";
			// 抛给上层流包装器，已修改output与之前事件不回滚。
			throw new Error(msg);
		}
	}
	// 源自然结束后仍没见终态视为提前EOF。
	if (!sawTerminalResponseEvent) {
		// 拒绝未完整结束的响应，而非把现有部分内容当成功。
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
	// The agent runs every tool call in the final message. Refuse to hand over calls whose
	// output_item.done never arrived: their arguments may be cut off or mixed up, e.g. when a
	// non-compliant server omits output_index.
	// 只有最终要执行工具时才检查未完成调用，length/error不会在此额外抛同一工具缺done异常。
	if (output.stopReason === "toolUse") {
		// 按对象身份遍历剩余调用，不仅检查当前Map槽。
		for (const toolCall of unfinishedToolCalls) {
			// 任何一条未完成就拒绝整个处理Promise，避免把截断/串线参数当可执行调用。
			throw new Error(
				// 错误标明首个未完成调用的名字与复合id。
				`OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`,
			);
		}
	}
}

// Extract复用工具输入联合的custom分支，类型别名不创建缓冲。
type CustomInput = Extract<ToolCallInput, { kind: "custom" }>;

/** Stream state of a custom tool call that starts with `initialInput`. */
/**
 * 建立自定义grammar工具输入的私有缓冲状态，返回CustomInput；初始输入会更新buffer并把对应JSON前缀暂存在unsent中。
 * 例：property="input"且初始"hi"时，公开参数可先有{input:"hi"}预览，稍后第一次delta/封口才把未发前缀一起交出去；不单独发流事件。
 */
function customInput(property: string, initialInput: string): CustomInput {
	// 新缓冲记录原始输入、JSON是否开始/关闭，均是本调用独立可变状态。
	const buffer = { input: "", started: false, closed: false };
	// 返回完整custom私有状态对象。
	return {
		// 固定kind区分json解析器分支。
		kind: "custom",
		// 保存唯一参数名，属性简写。
		property,
		// 保存同一可变buffer引用。
		buffer,
		// 追加初始原文并生成JSON前缀，暂存在unsent；undefined用空串表示没未发内容。
		unsent: appendGrammarToolInputJsonDelta(buffer, property, initialInput) ?? "",
	};
}

/** Append to a streaming custom tool input; returns the matching piece of its JSON arguments text. */
/**
 * 追加custom原始文字，再同步公开ToolCall.arguments并返回待发JSON参数增量；会修改block/input，不自己push事件。
 * 例：输入引号时JSON增量经过转义；已封口后追加非空片段由缓冲器抛错，不在这里吞掉。
 */
function appendCustomInput(block: ToolCall, input: CustomInput, delta: string): string | undefined {
	// 参数求值先更新grammar缓冲，再同步block与合并初始前缀；不在此直接发流事件。
	return sendCustomInput(block, input, appendGrammarToolInputJsonDelta(input.buffer, input.property, delta));
}

/** Close a custom tool input with the provider's complete input, if it sent one. */
/**
 * 按供应商完整custom输入封口缓冲，更新公开arguments并返回剩余JSON增量；不自己结束流。
 * 例：最终文本延续已有前缀则补缺失后缀并加闭引号/括号；最终值与已有前缀矛盾会抛，重复一致封口不重复输出。
 */
function closeCustomInput(block: ToolCall, input: CustomInput, finalInput: string | undefined): string | undefined {
	// 先封口缓冲，可能补最终后缀/抛前缀矛盾，再交send同步公开参数和输出增量。
	return sendCustomInput(block, input, closeGrammarToolInputJson(input.buffer, input.property, finalInput));
}

/**
 * 将当前custom缓冲同步到公开参数对象，并把尚未发送的初始JSON前缀拼进本次增量，返回字串/undefined。
 * 例：unsent="{..."与本次delta一起只发一次，随后清空unsent；会整体替换block.arguments对象，不修改工具名/id。
 */
function sendCustomInput(block: ToolCall, input: CustomInput, jsonDelta: string | undefined): string | undefined {
	// 每次建立只含该属性的新arguments对象，原值是buffer.input累计原始文字。
	block.arguments = { [input.property]: input.buffer.input };
	// 没有初始未发前缀时直接返回本次增量，包括undefined或空串。
	if (input.unsent === "") return jsonDelta;
	// 尚有未发前缀就与本次delta拼接，缺delta当空串。
	const sent = input.unsent + (jsonDelta ?? "");
	// 清未发状态，后续调用不会重复发同一初始片段。
	input.unsent = "";
	// 返回刚合并的参数JSON增量。
	return sent;
}

/**
 * 把Responses终态status与incomplete细分原因映射为Pi状态和可选错误文字，不修改output。
 * 例：incomplete.max_output_tokens→length，content_filter→error+原因；缺status、in_progress/queued按原实现视为stop，不能把它解释为远端任务确已完成。新未知status经never检查并在运行时抛错。
 */
function mapStopReason(
	// SDK响应状态可缺失；命名空间来自纯类型OpenAI导入。
	status: OpenAI.Responses.ResponseStatus | undefined,
	// 不完整响应的供应商细分原因。
	incompleteReason?: string,
	// 返回带stopReason的结果，errorMessage可省略。
): { stopReason: StopReason; errorMessage?: string } {
	// 缺省/空状态按原实现返回stop，不是远端完成证明。
	if (!status) return { stopReason: "stop" };
	// 按明确status分流。
	switch (status) {
		// completed正常结束。
		case "completed":
			// 统一正常stop。
			return { stopReason: "stop" };
		// incomplete还要区分是否输出长度上限。
		case "incomplete":
			// 只有max_output_tokens视为可见长度截断。
			if (incompleteReason === "max_output_tokens") {
				// 返回length，无额外错误文字。
				return { stopReason: "length" };
			}
			// 其他incomplete都构造error结果。
			return {
				// 统一失败状态。
				stopReason: "error",
				// 有非空细分原因时展示它。
				errorMessage: incompleteReason
					? // 保留供应商原因字串，不重新解释其业务含义。
						`Response incomplete: ${incompleteReason}`
					: // 无reason也给明确错误提示。
						"Response incomplete without a provider reason",
			};
		// 供应商failed状态。
		case "failed":
		// 供应商cancelled状态也按error，不在这里转Pi aborted。
		case "cancelled":
			// 不附错误文字，调用方finalize会删除已有errorMessage。
			return { stopReason: "error" };
		// These two are wonky ...
		// SDK允许in_progress；当前既有映射仍当stop。
		case "in_progress":
		// queued同样走该兼容分支，不能解读成后台任务已执行。
		case "queued":
			// 返回stop，原英语wonky保留提醒这是既有特殊映射。
			return { stopReason: "stop" };
		// 未覆盖的新状态进入后备块。
		default: {
			// never让SDK新增联合值时TS能提示此switch需更新，编译后无校验代码。
			const _exhaustive: never = status;
			// 真实运行未知状态在此抛错。
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
