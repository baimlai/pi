// 把简化流选项转换成各API共用选项，合并采样参数并按上下文/模型上限协调回答与思考预算；本文件不发模型请求。
// 模型工具负责把请求思考档位按具体模型能力钳制。
import { clampThinkingLevel } from "../models.ts";
// type导入仅用于编译期约束，运行时擦除。
import type {
	// 聊天API协议标识类型。
	Api,
	// 带API泛型的模型元数据类型。
	Model,
	// 含off在内的模型思考档位。
	ModelThinkingLevel,
	// 任意采样参数字段字典，值unknown由具体适配器解释。
	SamplingParams,
	// 面向调用方的简化流选项。
	SimpleStreamOptions,
	// 转换后的底层共用流选项。
	StreamOptions,
	// 四档可选思考token预算类型。
	ThinkingBudgets,
	// 不含off的思考级别联合。
	ThinkingLevel,
	// 已经规范化的消息上下文结构。
	TranscriptContext,
} from "../types.ts";
// 估算器优先适用的assistant用量，再估新增消息；并非精确分词。
import { estimateContextTokens } from "../utils/estimate.ts";

// 固定预留4096 token，给计数误差/协议开销留空间。
const CONTEXT_SAFETY_TOKENS = 4096;
// OpenRouter counts the input with its own tokenizer and rejects input + max_tokens above the
// window before routing. It counted prose up to 12% above the provider's count (#10497).
// 比例余量按估算上下文的15%计算。
const CONTEXT_SAFETY_RATIO = 0.15;
// The 15% margin is kept only while it leaves at least this much output. Otherwise (a nearly full
// large window, or any small window such as a 32k local model) only the fixed margin is kept, and
// output is capped at this size so an OpenRouter overcount still fits for a while before compaction.
// 比例余量不足以留32768输出时切换到固定余量策略。
const MIN_OUTPUT_WITH_RATIO_MARGIN = 32768;
// 计算可用空间时的最低输出值为1。
const MIN_MAX_TOKENS = 1;

/** Fit maxTokens into the context window, leaving room for the input being counted higher than estimated. */
/**
 * 按当前上下文估值为输出上限留空间，返回新的maxTokens，无网络或原对象修改。
 * 先留max(4096,input的15%)，若剩余不足32768则只留4096、同时输出最多32768；例：窗口10000、估算输入3000，最多回2904。
 * 估算不是实际tokenizer，不能保证请求必不溢出；有效窗口分支最终仍取与传入maxTokens较小值，不额外校验调用方给的负数/零。
 */
export function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	// 窗口<=0时不按上下文压缩，仅把传入上限下限设1。
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	// 估整个当前上下文占用，变量input指该估值，不是只数最后一条用户文字。
	const input = estimateContextTokens(context).tokens;
	// Math.ceil向上取整比例余量，再与固定4096取较大值。
	const margin = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(input * CONTEXT_SAFETY_RATIO));
	// let保存剩余可输出空间，下面可能换策略。
	let room = model.contextWindow - input - margin;
	// 比例余量后空间少于32768才用固定余量重算。
	if (room < MIN_OUTPUT_WITH_RATIO_MARGIN) {
		// 重算只减4096，并把输出空间封顶32768，可能仍为负数。
		room = Math.min(MIN_OUTPUT_WITH_RATIO_MARGIN, model.contextWindow - input - CONTEXT_SAFETY_TOKENS);
	}
	// 可用空间先至少1，再与调用方上限取较小；未在此单独限制model.maxTokens。
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, room));
}

/**
 * 按模型基础→有效思考级别→本次请求顺序浅合并采样参数，返回新字典或undefined，无I/O。
 * 例：三层同键temperature分别1/0.8/0.5时取0.5；思考级别先按模型能力钳制，嵌套参数值不深合并，字段内容也不在此验证。
 */
export function resolveSamplingParams(
	// 模型包含通用和按档采样参数。
	model: Model<Api>,
	// 请求档位允许off，先钳制为模型支持值。
	thinkingLevel: ModelThinkingLevel,
	// 本次参数可缺省，同名键优先级最高。
	requestParams?: SamplingParams,
	// 返回字典或undefined；不是供应商响应。
): SamplingParams | undefined {
	// 按模型能力算实际档位，防止读不支持档位的专属设置。
	const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
	// 可选链在没有按档参数表时得到undefined。
	const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
	// 三层任一有真值才建立合并对象，空对象也是真值。
	return model.samplingParams || thinkingLevelParams || requestParams
		? // 对象展开浅合并，后面同名字段覆盖前面，包括明确undefined值。
			{ ...model.samplingParams, ...thinkingLevelParams, ...requestParams }
		: // 三层全缺省时保留undefined而非空对象。
			undefined;
}

/**
 * 从简化请求构造共用StreamOptions，返回新对象，不调用回调或发请求。
 * 先合并采样参数，按上下文压输出上限，其余选定字段透传；例：单独apiKey参数为非空值时优先于options.apiKey，其他供应商专属字段不在这里复制。
 */
export function buildBaseOptions(
	// 当前模型决定默认上限和采样配置。
	model: Model<Api>,
	// 当前完整上下文用于预算估算。
	context: TranscriptContext,
	// 可省略简化选项，不就地修改它。
	options?: SimpleStreamOptions,
	// 可选显式解析好的key，非空时优先。
	apiKey?: string,
	// 返回共用StreamOptions对象，非Promise。
): StreamOptions {
	// 未请求reasoning时用off取对应采样档位。
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	// 仅构造并返回选定字段对象。
	return {
		// 通用temperature原样透传，与samplingParams中的同名键仍是两个字段。
		temperature: options?.temperature,
		// 保存刚合并的参数字典。
		samplingParams,
		// 显式maxTokens优先，缺省用模型上限，再按上下文空间钳制。
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		// 透传取消signal，不创建控制器。
		signal: options?.signal,
		// 遥测上下文原引用透传。
		telemetry: options?.telemetry,
		// ||表示空显式key也会回退options.apiKey。
		apiKey: apiKey || options?.apiKey,
		// 自定义fetch原样交后续请求实现。
		fetch: options?.fetch,
		// 传输偏好不在这里建立SSE/WebSocket。
		transport: options?.transport,
		// 缓存保留偏好，是否采用由适配器决定。
		cacheRetention: options?.cacheRetention,
		// 会话id可用于供应商缓存/路由。
		sessionId: options?.sessionId,
		// 额外请求头只透传，不在此合并或发送。
		headers: options?.headers,
		// 客户端归因/User-Agent身份配置原样透传。
		identity: options?.identity,
		// 请求正文钩子引用，此处不调用。
		onPayload: options?.onPayload,
		// 响应元数据钩子引用，此处不调用。
		onResponse: options?.onResponse,
		// 供应商原始流事件钩子引用。
		onProviderStreamEvent: options?.onProviderStreamEvent,
		// 请求超时配置，不在此启动timer。
		timeoutMs: options?.timeoutMs,
		// WebSocket连接超时配置。
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		// 供应商请求重试次数配置。
		maxRetries: options?.maxRetries,
		// 服务端要求等待时的允许上限。
		maxRetryDelayMs: options?.maxRetryDelayMs,
		// 请求元数据字典引用。
		metadata: options?.metadata,
		// 请求环境覆盖，不修改process.env。
		env: options?.env,
	};
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
// 回答空间预留目标为1024；实际保证取决于何时调用钳制和总上限是否足够。
export const MIN_ANSWER_TOKENS = 1024;

// 默认四档思考预算，ThinkingBudgets只作编译期约束。
export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	// minimal档1024 token。
	minimal: 1024,
	// low档2048 token。
	low: 2048,
	// medium档8192 token。
	medium: 8192,
	// high档16384 token，xhigh/max后面也映射这里。
	high: 16384,
};

/**
 * 把xhigh/max映射为high，其余级别或undefined原样返回，无副作用。
 * Exclude<...>在编译期从返回联合移除两个档位；例：用于只有四档token预算的供应商，不是针对具体模型重新查能力。
 */
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	// 条件命中两种高级别时返回high，其他包括undefined直接保留。
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/**
 * 合并默认和自定义四档思考预算，再将xhigh/max归high并按档读取，返回number。
 * 例：customBudgets.high=20000覆盖默认16384；!仅消除编译期缺省分支，不做运行时校验，显式undefined覆盖默认字段的外部输入仍可能返回undefined。
 */
export function thinkingBudgetForLevel(reasoningLevel: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	// 浅复制默认表后覆盖自定义字段，不验证值是否正数/有限。
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	// 输入类型不含undefined，!向编译器表明此处结果有值，不生成检查。
	const level = clampReasoning(reasoningLevel)!;
	// 按归并后的四档取预算；!不补默认、不把缺失值转换为数字。
	return budgets[level]!;
}

/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
/**
 * 把思考预算限制到ceiling减1024后的非负空间，返回较小值，不改输入。
 * 例：ceiling=2000、thinking=1800得到976；ceiling<1024只能把正常非负思考预算压成0，不能凭空保证仍有1024回答空间，也不校验负预算。
 */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	// ceiling减1024后至少为0，再取思考预算与该空间的较小值。
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

/**
 * 协调回答基准上限、模型上限和思考预算，返回两者数值，不发请求。
 * 未给base直接用模型上限；给base则把思考预算加上后受模型上限限制。只有maxTokens<=thinkingBudget才调用留回答空间的钳制。
 * 例：base=2000、thinking=2048、model=10000时总上限4048；总上限2000、thinking=1024时本函数不再钳制，不能泛称所有分支都预留1024。
 */
export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	// undefined表示调用方没有显式回答基准上限；不是0。
	baseMaxTokens: number | undefined,
	// 模型允许的总输出上限。
	modelMaxTokens: number,
	// 所需思考档位，不含off。
	reasoningLevel: ThinkingLevel,
	// 可选覆盖默认四档思考预算。
	customBudgets?: ThinkingBudgets,
	// 内联返回类型说明两个数值字段，不改变运行值。
): { maxTokens: number; thinkingBudget: number } {
	// 先按档读取预算，let允许后续缩小。
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	// 计算本次总输出上限，思考与正文共享它。
	const maxTokens =
		// 未给base直接用模型上限；已给则先加思考预算再取模型上限。
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	// 只在总上限不超过思考预算时调整，其他情况不会自动再留1024。
	if (maxTokens <= thinkingBudget) {
		// 压缩思考预算以在当前总上限内尽可能留回答空间。
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	// 属性简写返回总上限与最终思考预算。
	return { maxTokens, thinkingBudget };
}
