// Responses 真实请求入口：转换统一会话、处理缓存/思考兼容和 SDK 请求，再用共享事件解析器生成统一回答。
// 普通 OpenAI SDK 客户端；同一协议适配也服务支持 Responses 的其他供应商。
import OpenAI from "openai";
// 仅导入 SDK 流式请求类型，编译后擦除，不会在此执行网络动作。
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
// 统一思考档位按模型声明能力钳制。
import { clampThinkingLevel } from "../models.ts";
// 本组类型描述统一消息、能力、选项与费用；不执行服务器返回值校验。
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
// 共享错误解析保留结构化错误正文，再组合可显示文字。
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
// 调用方用事件流接收 partial/done/error，或调用 result() 取最终消息。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 响应观察回调接收普通对象形式的头。
import { headersToRecord } from "../utils/headers.ts";
// ClientIdentity 仅作静态类型，getIdentityHeaders 实际生成身份头。
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
// 环境值可受本次 options.env 覆盖，具体回退由 helper 处理。
import { getProviderEnvValue } from "../utils/provider-env.ts";
// 只重试初始请求，不在这里重放已经开始消费的响应流。
import { retryProviderRequest } from "../utils/provider-retry.ts";
// 有序系统消息同时承载指令与工具增减，转换和工具折叠必须一致。
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
// 把 grammar 工具名映射到统一参数对象中的字符串属性。
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
// Copilot 的图片与发起方动态头按完整历史计算。
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
// 缓存路由键长度由共享函数限制，不验证实际命中。
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
// 共享适配负责历史/工具转换及逐个 Responses 事件的累积。
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
	processResponsesStream,
} from "./openai-responses-shared.ts";
// 标准选项含默认 token 上限；采样配置在请求体组装末尾覆盖同名字段。
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

// 目标供应商名在此集合中时，共享转换器跨模型回放可保留复合工具 ID 形式，不是服务端认证白名单。
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
// 显式传输出上限时至少写 16，避免该 API 的过小上限拒绝。
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
// 匹配订阅限额错误后给用户的查看入口；此常量不自动打开浏览器。
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
// 工作区个人用量上限提示是固定文案，下一行保留原文字符串。
const CHATGPT_WORKSPACE_LIMIT_HINT =
	"You've reached your ChatGPT workspace's usage limit. Ask your workspace admin to increase it at admin.openai.com → Workspace → Usage limits.";
// Fixed reasoning.effort while configuration_update items carry the thinking level.
// 当实际档位放入历史 configuration_update 时，请求的 reasoning.effort 固定用 medium。
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";

/**
 * OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
 * is a Sign in with ChatGPT access token.
 */
/**
 * 根据模型和 key 的字符串形式选择 ChatGPT 登录兼容分支，返回 boolean，不查询认证服务或修改状态。
 * 只有 provider=openai、URL 精确为官方 v1、key 已定义且不是 sk- 前缀才匹配；例 gateway-key 在其他代理 URL 不匹配。
 * 这是本地启发式；空串可满足此函数条件，但外层凭证存在性另行检查。
 */
function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	// 以下四项全部满足才使用登录令牌兼容分支；这只是本地字符串启发式。
	return (
		// 供应商名必须恰为 openai，不匹配别名。
		model.provider === "openai" &&
		// 根地址必须完全相等，额外尾斜杠或其他代理地址都不匹配。
		model.baseUrl === "https://api.openai.com/v1" &&
		// 只排除 undefined；单独调用该判断时空串也可通过这一项。
		apiKey !== undefined &&
		// 非 sk- 前缀即按该分支处理，不验证令牌签名、来源或有效期。
		!apiKey.startsWith("sk-")
	);
}

/**
 * 检查给定头记录是否含非空指定头，返回 boolean，无副作用。
 * 流程：不区分大小写找名字→排除 null/纯空白值；例 Authorization:" Bearer x " 可匹配 authorization，但不会验证 token。
 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	// 没有头配置就没有候选；参数类型中的 | undefined 允许显式传入 undefined。
	if (!headers) return false;
	// 把目标头名转小写，做不区分大小写的比较。
	const expected = name.toLowerCase();
	// Object.entries 迭代键值对，数组解构分别取头名和值。
	for (const [key, value] of Object.entries(headers)) {
		// 同名且不是删除标记 null、去空白后非空才算存在，不改原始值。
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	// 所有候选都不满足就返回 false。
	return false;
}

/**
 * 选择 SDK 必需的 key 字符串：真值显式 key 优先，否则显式授权头存在则用 unused 占位，都没有就抛错。
 * 不读取模型头/环境/凭证存储；例 headers.Authorization 已带 Bearer 时，可由默认头覆盖 SDK 的占位认证头。
 */
function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	// 真值 key 优先，包括非空但只有空白的字符串；这里不 trim key。
	if (apiKey) return apiKey;
	// 缺 key 但显式头已含授权时给 SDK 占位 key；只检查传入 headers，不检查 model.headers。
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	// 两种来源都没有时同步抛配置错误，由实际调用位置决定是否转流错误。
	throw new Error(`No API key for provider: ${provider}`);
}

/**
 * 按供应商名或 URL 子串选 OpenRouter/OpenAI 亲和头格式，返回字符串，不访问网络。
 * Pick 仅要求两个字段；例自定义 provider 但 URL 含 openrouter.ai 也选 openrouter，这不是 hostname 信任校验。
 */
function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	// 供应商名或 URL 子串命中 OpenRouter 就用其头格式，不解析 hostname 或验证域名归属。
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
/**
 * 解析缓存偏好并返回 none/short/long，不改变环境。
 * 显式值优先，再看 PI_CACHE_RETENTION 是否精确为 long，最后默认 short；例显式 none 覆盖环境 long。
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	// 显式 none/short/long 都是真值，优先于环境配置。
	if (cacheRetention) {
		// 直接保留显式选择，不将 none 当成缺省。
		return cacheRetention;
	}
	// 只有环境文字精确等于 long 才改变默认。
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		// 返回逻辑长期缓存偏好，具体协议字段还由能力决定。
		return "long";
	}
	// 未指定且无 long 环境提示时默认 short。
	return "short";
}

/**
 * 把模型可选兼容字段补为完整本地配置，返回新对象，不探测远端能力或改模型。
 * 每项用 ?? 保留显式 false；例 supportsStrictMode 未设时为 false，supportsMaxOutputTokens 未设时为 true。
 */
function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	// 新建已补默认值的兼容对象；Required 只移除静态可选标记。
	return {
		// developer 指令角色默认支持，具体使用由共享消息转换控制。
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		// 中途系统消息默认不启用专门保留策略。
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		// 显式头格式优先，未设时按供应商名/URL 启发式选择。
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		// 默认允许长期缓存字段，但仍不保证远端接受或实际保留时长。
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		// 本适配 strict 默认 false，不能把“兼容 OpenAI”直接当作支持 strict。
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		// grammar custom 工具默认关闭。
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		// additional_tools 形式的中途声明默认关闭。
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		// 工具搜索专用能力默认关闭。
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		// 新的 prompt_cache_options 形式默认关闭。
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		// max_output_tokens 字段默认允许，但登录分支还会省略。
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		// configuration_update 承载思考档位的能力默认关闭。
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false,
	};
}

/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
/**
 * 决定当前思考档位是否用 configuration_update 表达，返回映射字符串或 undefined，无状态修改。
 * 须支持中途档位、显式请求 reasoningEffort 且不匹配 ChatGPT 登录；例 high 映射成 deep 后返回 deep。
 * 本函数不检查 model.reasoning；调用方另在请求字段组装时判断模型思考能力，null 映射由 ?? 回退。
 */
function getConfigurationUpdateEffort(
	// 模型提供 API 与档位映射，并用于登录兼容判断。
	model: Model<"openai-responses">,
	// 选项位置不可省略但值可为 undefined。
	options: OpenAIResponsesOptions | undefined,
	// 使用已解析默认值的能力对象，避免在此重复猜默认。
	compat: Required<OpenAIResponsesCompat>,
	// 返回供应商档位字符串或 undefined；不修改模型/历史。
): string | undefined {
	// 任一排除条件成立就不产生 configuration_update 档位。
	if (
		// 服务端能力未明确启用时走普通 reasoning.effort。
		!compat.supportsMidConvoEffort ||
		// 没有显式 reasoningEffort 时不做中途档位声明，即使设置了 summary。
		!options?.reasoningEffort ||
		// Sign in with ChatGPT rejects configuration_update items.
		// 按本地登录令牌启发式排除该协议项。
		isChatGPTSignIn(model, options.apiKey)
	) {
		// undefined 让调用方不写 providerThinkingLevel，也不传当前档位更新。
		return undefined;
	}
	// 映射存在且非 null/undefined 才使用，否则回退原始档位；不额外检查 model.reasoning。
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}

/**
 * 为旧缓存协议选择 retention，输入能力和缓存偏好，返回 24h 或 undefined，无副作用。
 * 只有 long、支持长期缓存且未启用新模式才写 24h；例新显式缓存模式启用时此字段省略，由另一 helper 决定 ttl。
 */
function getPromptCacheRetention(
	// 能力对象决定使用旧 retention 还是新显式缓存模式。
	compat: Required<OpenAIResponsesCompat>,
	// 逻辑缓存选择来自显式选项或环境默认。
	cacheRetention: CacheRetention,
	// 返回类型是单个字符串字面量或 undefined，不能返回任意时长。
): "24h" | undefined {
	// 仅 long、允许长期缓存、且不用显式新模式时发送旧式 retention。
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? // 满足条件请求 24h；这是请求偏好，不是命中或收费保证。
			"24h"
		: // 其他情况省略旧字段，避免与新模式并发发送。
			undefined;
}

/**
 * 构造新 prompt_cache_options，返回新对象或 undefined，不实际创建/清除缓存。
 * 先要求显式模式支持：none→mode explicit，long 且支持长期→ttl 30m，其他省略；例 short 保留服务端默认。
 */
function getPromptCacheOptions(
	// 新缓存协议必须由兼容设置明确支持。
	compat: Required<OpenAIResponsesCompat>,
	// 同一逻辑缓存选择可对应不同供应商字段。
	cacheRetention: CacheRetention,
	// 索引访问类型直接复用 SDK 的 prompt_cache_options 静态形状。
): ResponseCreateParamsStreaming["prompt_cache_options"] {
	// 不支持新模式就省略整个对象。
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	// none 在该协议中写 mode:explicit；不是发送 ttl:0，也不是本地清除缓存。
	if (cacheRetention === "none") return { mode: "explicit" };
	// long 且允许长期缓存时，新模式使用 30m，区别旧模式的 24h。
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	// 其他选择不加覆盖，让服务端使用默认策略。
	return undefined;
}

// OpenAI Responses-specific options
// extends 合并公共流选项，接口只在开发期检查，不产生类实例。
export interface OpenAIResponsesOptions extends StreamOptions {
	// 原生请求档位不含 off；统一 off 在 streamSimple 中转为 undefined。
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	// 摘要风格允许 null，但请求开启思考后会用 auto 兜底。
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	// 服务等级类型沿用 SDK，最终可能由响应实际等级覆盖计价选择。
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	// 工具选择沿用 Responses SDK 的完整联合类型。
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
/**
 * 发起一轮真实 Responses 调用，同步返回事件流；输入模型、完整会话及可选配置，最终输出统一 AssistantMessage。
 * 规范化历史→补兼容值→选择凭证/头→组装请求和钩子→可选重试建立连接→共享解析流→done/error 并关闭。
 * 会发送网络请求、修改本轮 output、调用用户钩子；例模型回复 read 调用时只输出 toolCall，执行及后续轮由 Agent 接手。
 * try 内异常转事件；同步规范化与异步闭包 try 前步骤不受这个 catch 保护，部分消息不会回滚。
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	// 泛型约束此入口只接收 openai-responses 模型。
	model: Model<"openai-responses">,
	// 输入是完整有序会话，并不只包含最后一个用户问题。
	context: TranscriptContext,
	// 可选配置包括显式凭证、取消、请求钩子与采样参数。
	options?: OpenAIResponsesOptions,
	// 同步箭头函数返回事件流；内部异步闭包推进网络任务。
): AssistantMessageEventStream => {
	// 先分配本次输出通道，调用者可以立即拿到它。
	const stream = new AssistantMessageEventStream();
	// 先规范化历史；这个同步步骤在下方异步 try/catch 之外。
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	// Start async processing
	/**
	 * 立即启动本轮异步工作，捕获外层模型/会话/通道；不把内部任务 Promise 返回给调用方。
	 * 成功写 done，try 内失败写 error；例 HTTP 已成功但事件观察器抛错，仍会得到失败消息。
	 */
	// 立即启动异步任务，其 Promise 没有返回给调用者；结果走事件通道。
	(async () => {
		// 为这次调用解析所有本地兼容默认值。
		const compat = getCompat(model);
		// 决定是否把实际档位放 configuration_update；该步骤也在下面 try 之前。
		const configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);
		// 本轮使用一个可变 output，后续 partial 与最终消息都引用它。
		const output: AssistantMessage = {
			// 统一输出角色是 assistant。
			role: "assistant",
			// 内容块随流到来逐项添加，不提前构造假文本。
			content: [],
			// as Api 只扩大静态 API 类型，不转换字符串。
			api: model.api as Api,
			// 保留请求所选供应商名。
			provider: model.provider,
			// 保留目录模型 id，实际返回模型若不同由共享解析器另记录。
			model: model.id,
			// 条件展开仅在档位存在时记录 providerThinkingLevel，供后续同模型历史回放。
			...(configurationUpdateEffort === undefined ? {} : { providerThinkingLevel: configurationUpdateEffort }),
			// 用量初始为零，最终由响应事件更新。
			usage: {
				// 普通输入 token 初始值，缓存读写独立统计。
				input: 0,
				// 输出 token 初始值。
				output: 0,
				// 缓存命中 token 初始值。
				cacheRead: 0,
				// 缓存写入 token 初始值。
				cacheWrite: 0,
				// 总 token 初始值，不代表服务器尚未做任何工作。
				totalTokens: 0,
				// 费用分项初始值，后续目录估算和等级倍率都不等同最终账单。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// pending 表示尚无可接受的完成状态。
			stopReason: "pending",
			// 记录本地毫秒时间，不直接采用远端创建时间。
			timestamp: Date.now(),
		};

		// 建立请求、钩子、流解析中的异常在此转换成统一失败事件。
		try {
			// Create OpenAI client
			// 读取显式 key 或显式授权头占位；实际凭证解析由更外层负责。
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			// 缓存逻辑策略为选项优先、环境 long 次之、默认 short。
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			// none 时不传自动亲和会话 id，但请求头/采样钩子仍可自行提供字段。
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			// 为历史及本轮 grammar 工具输入准备属性映射。
			const grammarToolInputProperties = createGrammarToolInputProperties(
				// 扫描历史出现过的声明，而非只看最后活动集合。
				getDeclaredTools(normalizedContext.messages),
				// 只在兼容设置明确支持时识别 grammar 约束。
				compat.supportsOpenAIGrammarTools,
			);
			// 组装 SDK 客户端和默认头，实际请求在下面 create 时发起。
			const client = createClient(
				// 模型提供根 URL、供应商和默认头。
				model,
				// 完整历史用于 Copilot 图像/发起方头推导。
				normalizedContext,
				// 经过本地选择的 SDK key，可能是授权头场景的 unused 占位符。
				apiKey,
				// 本次请求显式头最后覆盖模型/动态默认头。
				options?.headers,
				// 身份选项只影响身份头构造，不自动提供认证凭证。
				options?.identity,
				// 可选自定义 fetch 使测试/代理能够接管传输。
				options?.fetch,
				// 经过缓存策略筛选的 sessionId，只控制本适配自动亲和头。
				cacheSessionId,
			);
			// 组装流式请求参数，let 允许下一步替换整对象。
			let params = buildParams(
				// 模型含 ID、输入能力和思考映射。
				model,
				// 传已经规范化的会话供消息与工具转换。
				normalizedContext,
				// 原生请求选项决定 token、摘要、等级等字段。
				options,
				// 使用同一组已解析兼容设置。
				compat,
				// 历史 custom 调用与声明共享原始输入属性映射。
				grammarToolInputProperties,
				// 如适用，把当前实际档位追加为 configuration_update。
				configurationUpdateEffort,
			);
			// 先等 payload 钩子，允许原地修改或返回替代参数；只调用一次，不随重试再次执行。
			const nextParams = await options?.onPayload?.(params, model);
			// 只用 undefined 表示不替换；没有额外协议形状校验。
			if (nextParams !== undefined) {
				// 类型断言只是静态声明，无法把不合法回调返回值变成有效请求。
				params = nextParams as ResponseCreateParamsStreaming;
			}
			// SDK 请求控制独立于发给模型的参数对象。
			const requestOptions = {
				// 有取消信号才传 signal；实际中断依 SDK/传输实现。
				...(options?.signal ? { signal: options.signal } : {}),
				// 显式 timeoutMs=0 也传入 SDK；本层不定义所有重试加起来的总期限。
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// 关闭 SDK 自带重试，只让外层可取消策略决定重试。
				maxRetries: 0,
			};
			// 等待请求建立和 SDK 流对象，同时保留原始 HTTP 响应。
			const { data: openaiStream, response } = await retryProviderRequest(
				// 每轮工厂创建新请求；withResponse 返回解析流，不等待流迭代完。
				() => client.responses.create(params, requestOptions).withResponse(),
				// 以下对象是本地重试策略，不是 Responses 请求体。
				{
					// 额外重试数默认由 helper 取 0。
					maxRetries: options?.maxRetries,
					// 服务器建议等待超过上限就失败，未配置时 helper 采用 60 秒。
					maxRetryDelayMs: options?.maxRetryDelayMs,
					// 同一信号可打断退避；这层不重试后面流消费错误。
					signal: options?.signal,
				},
			);
			// HTTP 成功后先调用并等待响应钩子；它失败时尚未向调用方发 start。
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			// 开始事件只表示响应流可以开始处理，不表示回答完成。
			stream.push({ type: "start", partial: output });

			// 共享处理器消费全部 SDK 事件，更新 output 与块级事件；成功 done 在后面统一发。
			await processResponsesStream(openaiStream, output, stream, model, {
				// 每个远端事件先传原始事件钩子并等待，异常会中断处理。
				onProviderStreamEvent: options?.onProviderStreamEvent,
				// 传入请求等级作为没有响应实际等级时的计价候选。
				serviceTier: options?.serviceTier,
				// 将 custom 输入原文恢复为统一工具参数对象。
				grammarToolInputProperties,
				/**
				 * 在共享处理器给出用量与选中等级后，使用闭包中的模型调整估算价；返回值不使用，原地修改 usage。
				 * 例 flex 选择 0.5 倍；不改 token 数，也不查询实时账单。
				 */
				// 闭包捕获本次 model，把共享计算的 usage 按选中等级原地调整估算价。
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			// 处理完流后再看取消标志；已收到部分内容不会因此回滚。
			if (options?.signal?.aborted) {
				// 进入统一 catch，再按当前信号分类为 aborted。
				throw new Error("Request was aborted");
			}

			// 没有终态时不能凭 EOF 判本轮成功。
			if (output.stopReason === "pending") {
				// 抛出缺停止原因错误，保留已经积累的消息。
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			// 共享解析结果已经错误或取消时转统一失败分支。
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				// 保留其错误文字，空串/缺值时用固定回退。
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// 发送成功终态，reason 可为 stop/length/toolUse 等；不负责执行工具。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 关闭本地事件通道，结束消费者的异步迭代。
			stream.end();
			// 捕获上述 try 内异常，不涵盖外层同步规范化或闭包 try 前步骤。
		} catch (error) {
			// 只依据捕获当时 signal.aborted 决定 aborted，否则为 error。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			// 把未知错误转可显示文字，先标准化再加供应商回退标题。
			const errorMessage = formatProviderError(
				// 提取 SDK 状态、正文等已有错误信息。
				normalizeProviderError(error),
				// 供应商为 openai 时显示 OpenAI，否则用实际 provider；字符串插值不发请求。
				`${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
			);
			// Sign in with ChatGPT shares the subscription's usage limit with other apps.
			// On ChatGPT Business plans, the workspace admin also sets a per-user limit.
			// 按格式化文字包含特定代码来追加订阅提示，不重新核验账户实际限额。
			if (errorMessage.includes("subscription_sharing_usage_limit_exceeded")) {
				// 保留原错误，并附使用量页面链接。
				output.errorMessage = `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`;
				// 工作区个人上限代码走管理员提示分支。
			} else if (errorMessage.includes("subscription_sharing_workplace_individual_usage_limit_exceeded")) {
				// 拼接固定工作区提示，不执行配置修改或通知管理员。
				output.errorMessage = `${errorMessage}\n${CHATGPT_WORKSPACE_LIMIT_HINT}`;
				// 未匹配已知代码时不附额外提示。
			} else {
				// 原样采用整理后的错误文字。
				output.errorMessage = errorMessage;
			}
			// 通过 error 事件返回当前部分消息；此前 start/块事件可能已经发出。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 失败也关闭通道，避免消费者一直等后续事件。
			stream.end();
		}
		// 立即调用闭包，外层不等待这份 Promise。
	})();

	// 同步返回同一事件通道。
	return stream;
};

/**
 * 把统一简单选项转换成本适配原生配置并启动相同请求，返回同一事件流。
 * 同步检查凭证存在→公共默认值→按模型钳制思考→off 转 undefined→stream；前置失败可同步抛错。
 * 例 reasoning:"high" 可能钳制到模型最高支持档位，toolChoice:"none" 会继续传给原生入口。
 */
export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	// 模型静态限制为 Responses API。
	model: Model<"openai-responses">,
	// 统一输入会话交实际流入口处理。
	context: TranscriptContext,
	// 使用跨供应商简单选项，无需调用方直接指定 reasoningEffort。
	options?: SimpleStreamOptions,
	// 此包装层不是 async，缺认证等前置错误可以同步抛出。
): AssistantMessageEventStream => {
	// 仅校验存在可用 key/显式授权头；忽略占位返回值，真实 stream 会再选择一次。
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	// 组装满足原生选项接口的普通对象。
	const base = {
		// 复制通用配置/defaults，后面的字段可覆盖展开结果。
		...buildBaseOptions(model, context, options, options?.apiKey),
		// 继续传递统一工具选择策略。
		toolChoice: options?.toolChoice,
		// satisfies 仅让 TS 验证兼容性，不对运行时值加校验器。
	} satisfies OpenAIResponsesOptions;
	// 若给定逻辑思考档位，按模型可用档位限制；undefined 不做钳制。
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	// 统一 off 在原生入口用 undefined 表达，其他档位保留。
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	// 委托同一真实请求实现，返回它的事件流。
	return stream(model, context, {
		// 先复制公共选项。
		...base,
		// 覆盖转换后的原生档位。
		reasoningEffort,
		// 静态确认选项兼容原生接口，运行时仍是这个普通对象。
	} satisfies OpenAIResponsesOptions);
};

/**
 * 创建一个 OpenAI SDK 客户端，输入模型、会话、已选 key 与头/身份/fetch/会话 id，返回新实例，不在此发 Responses 请求。
 * 头合并：身份→模型→Copilot 动态→会话亲和→显式请求；配置错误由构造器向外抛。
 * 例 optionsHeaders.Authorization 可覆盖 SDK 自动 Bearer 头；sessionAffinityFormat=none 仍会有非 OpenRouter 分支的 x-client-request-id。
 */
function createClient(
	// 模型决定根地址、供应商和默认请求头。
	model: Model<"openai-responses">,
	// 会话用于推导 Copilot 动态头。
	context: TranscriptContext,
	// 已经选择的 SDK key，实际可能由自定义授权头覆盖。
	apiKey: string,
	// 可省略的本次显式头，ProviderHeaders 允许 null 表达删除。
	optionsHeaders?: ProviderHeaders,
	// 身份字段供 getIdentityHeaders 使用。
	identity?: ClientIdentity,
	// typeof globalThis.fetch 在类型位置取标准 fetch 的函数签名，不会调用 fetch。
	fetch?: typeof globalThis.fetch,
	// 非空会话 id 才自动设置亲和头；不是本地缓存内容。
	sessionId?: string,
) {
	// 重新取得此模型兼容默认值。
	const compat = getCompat(model);
	// 对象展开按身份→模型顺序，同名本地属性后者覆盖前者。
	const headers: ProviderHeaders = { ...getIdentityHeaders(model, identity), ...model.headers };
	// 只有供应商名精确匹配 github-copilot 才注入 Copilot 动态头。
	if (model.provider === "github-copilot") {
		// 扫描完整历史中用户/工具图片，不仅最后一条消息。
		const hasImages = hasCopilotVisionInput(context.messages);
		// 用最后消息角色和图像存在性生成发起方等动态头。
		const copilotHeaders = buildCopilotDynamicHeaders({
			// 传完整消息序列给动态头 helper。
			messages: context.messages,
			// 图像标志使用上一步扫描结果。
			hasImages,
		});
		// 动态头再覆盖身份/模型同名头。
		Object.assign(headers, copilotHeaders);
	}

	// 空串会话 id 不添加自动亲和头。
	if (sessionId) {
		// OpenRouter 使用单独的头格式。
		if (compat.sessionAffinityFormat === "openrouter") {
			// 写 x-session-id；不用这里的 OpenAI session_id 分支。
			headers["x-session-id"] = sessionId;
			// 所有非 OpenRouter 格式进入此分支，包括 none 格式。
		} else {
			// 只有格式明确为 openai 才额外写 session_id。
			if (compat.sessionAffinityFormat === "openai") {
				// 这是传输头，不把 sessionId 写进模型消息。
				headers.session_id = sessionId;
			}
			// 非 OpenRouter 时都会写此请求标识头，包括 sessionAffinityFormat=none。
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	// 有本次头配置才合并；空对象也是真值。
	if (optionsHeaders) {
		// 选项最后写，可覆盖或以 null 删除先前头；SDK 之后还会合并其自动头。
		Object.assign(headers, optionsHeaders);
	}

	// 创建新 SDK 客户端；构造本身不执行 Responses 请求。
	return new OpenAI({
		// 静态 key 用作 SDK 默认认证；自定义默认头在安装 SDK 的合并序列中可覆盖认证头。
		apiKey,
		// 根路径用模型 baseUrl，SDK 追加 responses。
		baseURL: model.baseUrl,
		// 允许在浏览器环境构造，不代表这里提供凭证保密保证。
		dangerouslyAllowBrowser: true,
		// 传输可由调用方替换，离线测试可以只返回内存 Response。
		fetch,
		// 默认头覆盖 SDK 自动认证头后，SDK 仍可能做自己的验证/后续合并。
		defaultHeaders: headers,
	});
}

/**
 * 将完整历史和请求配置转换为 Responses 流式参数，不发网络请求；消息/工具/约束转换失败会抛错。
 * 流程：工具变更支持→输入项→缓存/上限/温度/等级/工具→思考→最后自定义采样覆盖。
 * 例 ChatGPT 登录启发式匹配时省略 max_output_tokens/temperature/缓存选项，但最后的采样覆盖和后续 payload 钩子仍能改变它们。
 */
function buildParams(
	// 模型含目录 ID、输入能力、思考映射等。
	model: Model<"openai-responses">,
	// 历史会话用于工具变更决策和协议输入转换。
	context: TranscriptContext,
	// 请求专属选项允许值为 undefined。
	options: OpenAIResponsesOptions | undefined,
	// Required 表示这里已解析缺省字段，静态类型不等同远端能力探测。
	compat: Required<OpenAIResponsesCompat>,
	// 只读接口保护此函数不通过 Map API 修改映射，不冻结底层对象。
	grammarToolInputProperties: ReadonlyMap<string, string>,
	// 如适用，供历史配置更新使用的当前实际档位。
	configurationUpdateEffort: string | undefined,
) {
	// 用兼容能力选择请求工具与中途声明模式。
	const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport(compat));
	// 转换全部历史输入；集合仅影响跨来源工具 ID 转换。
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		// custom 工具输入按声明中的字符串属性反向展开。
		grammarToolInputProperties,
		// 保持或折叠中途系统消息按同一能力选择。
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		// 控制历史 additional_tools 声明支持。
		supportsAdditionalTools: compat.supportsAdditionalTools,
		// 控制工具搜索声明支持。
		supportsToolSearch: compat.supportsToolSearch,
		// 历史新增工具和顶层工具使用同样的约束选项。
		toolOptions: {
			// 是否支持 JSON strict；不会在本层执行工具参数 schema 校验。
			supportsStrictMode: compat.supportsStrictMode,
			// grammar 工具须独立显式支持。
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
		// 有当前档位时，共享转换器可回放同模型历史档位并追加当前 configuration_update。
		configurationUpdateEffort,
	});

	// 缓存偏好在组装参数时再解析一次，仍按显式配置/环境/default 优先级。
	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	// Sign in with ChatGPT rejects these request fields.
	// 仅按 provider/baseUrl/key 字符串启发式省略登录不支持字段，非真实令牌验证。
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	// 新建 SDK 流式请求体，类型标注不做运行时验证。
	const params: ResponseCreateParamsStreaming = {
		// 发目录模型 id，不用响应中的实际路由模型覆盖。
		model: model.id,
		// 完整转换后的输入项数组。
		input: messages,
		// 要求流式返回。
		stream: true,
		// none 时省略自动缓存键，否则会话 id 经长度限制后作为路由键。
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		// 登录兼容分支省略旧缓存时长字段，其他情况按能力及 long 策略选择。
		prompt_cache_retention: omitUnsupportedFields ? undefined : getPromptCacheRetention(compat, cacheRetention),
		// 登录分支也省略新缓存选项；新旧协议不会在这里同时启用。
		prompt_cache_options: omitUnsupportedFields ? undefined : getPromptCacheOptions(compat, cacheRetention),
		// 请求关闭 Responses 对象存储，不承诺关闭日志/缓存等所有服务端持久化。
		store: false,
	};

	// 上限要真值、能力允许、且非登录兼容分支才在此设置。
	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
		// 至少取 16；负数也被提到 16，而 0/NaN 被前面的真值判断省略。
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	// 显式 0 温度保留，但登录分支在此省略。
	if (options?.temperature !== undefined && !omitUnsupportedFields) {
		// 原样赋值温度，本地不验证服务端数值区间。
		params.temperature = options?.temperature;
	}

	// 服务等级不为 undefined 就传，未在这里排除登录场景。
	if (options?.serviceTier !== undefined) {
		// 写请求等级，不保证响应实际等级相同。
		params.service_tier = options.serviceTier;
	}

	// 当前顶层请求工具非空才加 tools。
	if (transcriptTools.requestTools.length > 0) {
		// 将工具转成 function/custom 声明，约束配置不可满足时可能抛错。
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			// 使用同一 JSON strict 能力。
			supportsStrictMode: compat.supportsStrictMode,
			// 使用同一 grammar 能力。
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	// 只检查 undefined，不要求工具数组存在才允许 tool_choice。
	if (options?.toolChoice !== undefined) {
		// 原样保留工具选择配置，实际是否接受由远端决定。
		params.tool_choice = options.toolChoice;
	}

	// 档位优先；没有显式档位但指定真值摘要风格时，用 medium 开启思考。
	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	// 仅对目录标注 reasoning 的模型构造下面的思考字段。
	if (model.reasoning) {
		// 存在档位时走开启分支。
		if (reasoningEffort) {
			// 显式请求的档位需要查映射。
			const requestedEffort = options?.reasoningEffort
				? // 映射为空值时 ?? 回退逻辑档位，不能用 null 在这里关闭该显式请求。
					(model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: // 摘要隐式开启的 medium 直接采用，不走该档位映射。
					reasoningEffort;
			// 若当前档位通过 configuration_update 表达，则 reasoning.effort 固定 medium；否则用请求映射档位。
			const effort = configurationUpdateEffort === undefined ? requestedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT;
			// 构造 SDK reasoning 嵌套对象。
			params.reasoning = {
				// NonNullable 去掉可选空类型，再提取 effort；as 不是远端可接受值的验证。
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				// 摘要 null/空值在此回退 auto，因而不是发送 null 关闭摘要。
				summary: options?.reasoningSummary || "auto",
			};
			// 请求加密思考元数据以便回放，不在本地解密它。
			params.include = ["reasoning.encrypted_content"];
			// 没开思考时，Copilot 不显式发送 off；其他供应商仅在 off 映射不是 null 时发送。
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			// 构造关闭/最低档位请求。
			params.reasoning = {
				// 有 off 字符串用映射，否则 none；仍仅为协议请求，不保证模型内部完全不思考。
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		// xai reasoning 模型始终请求 encrypted_content，即使没走上面开启分支。
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	// Last so model and request sampling parameters override named request fields.
	// 采样配置按请求逻辑档位合并，缺省用 off，不按可能固定为 medium 的 reasoning.effort 选择。
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	// 存在合并对象才写入。
	if (samplingParams) {
		// 最后覆盖同名字段；采样或后续 payload 钩子可重新加入前面省略的字段。
		Object.assign(params, samplingParams);
	}

	// 交回普通请求对象，不修改原会话，不在此创建网络连接。
	return params;
}

/**
 * 按模型 id 与服务等级返回本地计价倍率，没有网络或修改；这是仓库当前估算规则，不是实时价格表。
 * 例 flex=0.5；priority/fast 对 gpt-5.5 精确 id 用 2.5，其他模型用 2；其余等级为 1。
 */
function getServiceTierCostMultiplier(
	// Pick 只要求模型 id，函数不需要完整模型对象。
	model: Pick<Model<"openai-responses">, "id">,
	// 等级类型直接来自 SDK；允许 undefined 用默认倍率。
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	// 返回本地估算倍率 number，不查询实时价格。
): number {
	// 按实际传入等级选择倍率。
	switch (serviceTier) {
		// flex 分支。
		case "flex":
			// 当前实现把目录估算费用减半。
			return 0.5;
		// priority 与下面 fast 共用同一计算逻辑。
		case "priority":
		// fast 走优先等级倍率。
		case "fast":
			// 只有 id 精确为 gpt-5.5 时取 2.5，别名/其他模型均取 2。
			return model.id === "gpt-5.5" ? 2.5 : 2;
		// 其他等级，包括 auto/default/scale/undefined，均走这里。
		default:
			// 倍率 1 表示不调整目录估算。
			return 1;
	}
}

/**
 * 按服务等级原地调整 usage.cost，输入用量、等级和模型 id，无返回正文，无网络。
 * 先取倍率，非 1 才乘四个费用分项再重算总价，不改 token 数；例原四项总额 0.01、flex 后估算为 0.005。
 */
function applyServiceTierPricing(
	// 传入共享解析器已计算好的用量对象，函数会原地改费用。
	usage: Usage,
	// 响应实际等级或请求回退等级，由共享调用方决定。
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	// 只需要模型 id 来判断特殊倍率。
	model: Pick<Model<"openai-responses">, "id">,
) {
	// 先确定本地倍率，不执行网络请求。
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	// 倍率为 1 就保持所有费用字段原样，避免不必要重算。
	if (multiplier === 1) return;

	// *= 原地更新普通输入费用，不改输入 token 数。
	usage.cost.input *= multiplier;
	// 同样调整输出费用，不额外重复加思考 token。
	usage.cost.output *= multiplier;
	// 缓存读取费用也按相同倍率调整。
	usage.cost.cacheRead *= multiplier;
	// 缓存写入费用也按相同倍率调整。
	usage.cost.cacheWrite *= multiplier;
	// 用调整后的四项重算 total，属于本地估算，不承诺与最终账单完全相等。
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
