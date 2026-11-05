// 统一请求、消息、用量、工具与模型的 TypeScript 契约；这里主要是类型声明，运行时不会自动验证 JSON 或发请求。
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
// 以下 import type 都会擦除；从 API 文件借用精确参数类型，不因此装载其 SDK/网络实现。
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
// 兼容选项由协议 schema 定义；后面条件类型按模型 API 选择对应形状。
import type {
	AnthropicMessagesCompat,
	BedrockCompat,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	SystemOneCompat,
} from "./providers/compat-schema.ts";
// 目录 schema 提供价格、模态、缓存与思考级别类型，不在此重新定义运行时 schema。
import type {
	CacheRetention,
	ModelCost,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./providers/model-schema.ts";
// 诊断/事件流/身份类型给统一消息与请求选项引用。
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";
import type { ClientIdentity } from "./utils/identity.ts";

// export type 仅转导出兼容类型，外部调用者无需知道 schema 内部路径。
export type {
	AnthropicAllowedFallbackModel,
	AnthropicMessagesCompat,
	BedrockCompat,
	ChatTemplateKwargValue,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	OpenRouterRouting,
	SessionAffinityFormat,
	SystemOneCompat,
	ThinkingTokenBudgetField,
	VercelGatewayRouting,
} from "./providers/compat-schema.ts";
// 模型元数据类型转导出；例如 ModelCostRates 为每百万 token 的单价，而非一次请求费用。
export type {
	CacheRetention,
	ModelCost,
	ModelCostRates,
	ModelCostTier,
	ModelImageInputLimits,
	ModelImageResizeOptions,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./providers/model-schema.ts";
// 对外公开流类的类型引用，本行不导入运行时构造器。
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

// 已知聊天协议字符串联合，每行是一个协议 id；它们区别于供应商 id，同供应商可支持多个协议。
export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

// KnownApi 提供编辑器提示，string & {} 仍允许自定义协议字符串；不是只限内置十项，也不是运行时枚举。
export type Api = KnownApi | (string & {});

// 当前已知图片生成协议，不等同于聊天模型支持图片输入。
export type KnownImageApi = "openrouter-images";

// 图片 API 同样保留自定义字符串扩展点。
export type ImageApi = KnownImageApi | (string & {});

// 分类协议有独立联合；以下分别对应专门的结构化分类实现，不是普通聊天别名。
export type KnownClassifierApi =
	| "typesafe-system-one"
	| "cloudflare-workers-ai-system-one"
	| "llama-cpp-classify"
	| "openai-decisions";

// 已知或自定义分类 API 字符串。
export type ClassifierApi = KnownClassifierApi | (string & {});

// 内置供应商 id 联合，下面每行是可识别名字；类型声明不自动创建或注册这些 Provider。
export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure"
	| "openai-codex"
	| "radius"
	| "typesafe"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "baseten"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "meta"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
// 公开供应商 id 还接受任意字符串，允许本地/扩展供应商；KnownProvider 并不是运行时白名单。
export type ProviderId = KnownProvider | string;

// 通用工具选择只表达自动选择或禁用，具体适配器行为见请求实现。
export type ToolChoice = "auto" | "none";
// 任意抽样参数字典，unknown 要由接收适配器解释；不是无条件校验或所有供应商都会支持。
export type SamplingParams = Record<string, unknown>;
// 按思考级别索引参数覆盖；Partial 让每个级别都可省略，不需填满整个 Record。
export type SamplingParamsByThinkingLevel = Partial<Record<ModelThinkingLevel, SamplingParams>>;
/** Token budgets for each thinking level (token-based providers only) */
// 按 token 预算控制思考的供应商可使用这些档位，接口不检查是否为正数或该供应商是否采用。
export interface ThinkingBudgets {
	// minimal 档的可选思考 token 预算。
	minimal?: number;
	// low 档预算。
	low?: number;
	// medium 档预算。
	medium?: number;
	// high 档预算；这里没有 xhigh/max 字段，不能自行增补运行时行为。
	high?: number;
}

// Base options all providers share
// 传输偏好字符串联合；是否支持 WebSocket/缓存形式由供应商决定，类型本身不建立连接。
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
// 请求专用环境覆盖字典，优先级的实际实现由认证/适配器处理，不会自动改 process.env。
export type ProviderEnv = Record<string, string>;
// null 是抑制默认请求头的删除标记，区别于字符串 "null"；普通值为字符串。
export type ProviderHeaders = Record<string, string | null>;
// typeof 在类型位置复用全局 fetch 函数签名，不在声明时发请求。
export type FetchFunction = typeof globalThis.fetch;

// 提供给 onResponse 的精简 HTTP 响应信息，不是含正文流的标准 Response 对象。
export interface ProviderResponse {
	// HTTP 状态码，如 200/429；number 类型不自行保证范围。
	status: number;
	// 收到的响应头字典，不含 ProviderHeaders 的 null 删除标记。
	headers: Record<string, string>;
}

/** Authentication, HTTP transport, and lifecycle callbacks shared by provider requests. */
// 所有模型请求共用的认证/HTTP/生命周期选项；TModel 让回调看到实际模型类型，默认聊天。
export interface ProviderRequestOptions<TModel = Model<Api>> {
	// 可选取消信号，任务需合作观察；并不强制终止任意 JS 回调。
	signal?: AbortSignal;
	/** Explicit parent span for telemetry produced by this logical request. */
	// 逻辑请求显式父遥测 span，不是对话消息，也不自动上传正文。
	telemetry?: TelemetrySpan;
	// 本次显式 key，通常优先于存储解析；不在类型声明处保存。
	apiKey?: string;
	/**
	 * Optional fetch implementation for provider HTTP requests.
	 * Defaults to `globalThis.fetch`. Provider adapters that cannot inject a custom implementation may reject it.
	 * This does not affect WebSocket transports.
	 */
	// 自定义 HTTP fetch，实现不支持注入时可拒绝；不改变 WebSocket 的实现。
	fetch?: FetchFunction;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * proxy variables.
	 */
	// 供应商作用域环境覆盖，如区域/代理/端点变量；不等于替换整个宿主环境。
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	// payload 为 unknown 的请求边界，可同步/异步返回替代载荷，undefined 表示保留；模型泛型供回调定位。
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	// 响应头到达后的同步/异步通知，返回值不作为新响应，具体时机由适配器实现。
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; caller values override default headers.
	 * On AWS Bedrock these are injected via a Smithy `build`-step middleware so
	 * they are covered by SigV4 signing; reserved headers (`x-amz-*`,
	 * `authorization`, `host`) are silently ignored to preserve SigV4 / bearer auth.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	// 默认头与调用头合并；null 抑制默认；Bedrock 的保留头不允许任意覆盖，详见原文。
	headers?: ProviderHeaders;
	/**
	 * How the request identifies the calling app: `User-Agent` and provider attribution headers.
	 * Absent fields use pi-ai's defaults: a detailed `User-Agent` and no attribution.
	 */
	// 应用身份字段如 User-Agent/归因头；未提供项用库默认，实际拼接在请求路径。
	identity?: ClientIdentity;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	// HTTP 超时毫秒，仅支持该配置的 SDK/适配器生效，不是全局会话截止时间。
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	// 客户端/SDK 级重试次数，与 coding-agent 外层普通回答重试是不同层次。
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	// 允许等待的服务端重试延迟上限，缺省 60 秒、0 禁上限；过长由上层可见错误处理。
	maxRetryDelayMs?: number;
}

// extends 继承请求公共字段，再增加聊天流特有选项；这里重声明 onResponse 为聊天模型签名。
export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	// 响应正文被消费前的通知，回调可异步；不是每个 token 的回调。
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional observer for each parsed provider stream event before Pi normalization.
	 * Event data is adapter-owned and must be treated as read-only.
	 * Adapter support is explicit; unsupported adapters do not invoke it.
	 */
	// 观察适配器解析后的原生流事件，data 不承诺结构；契约按只读使用，未支持适配器不会调用。
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	// 聊天抽样温度，number 类型不限定供应商合法范围。
	temperature?: number;
	/**
	 * Arbitrary sampling parameters merged into the request body as-is, after the named request
	 * fields, so keys here override them. Lets custom OpenAI-compatible servers (llama.cpp, vLLM,
	 * SGLang, ...) receive parameters pi does not model, e.g. `top_p`, `top_k`, `min_p`,
	 * `repetition_penalty`. Merged over `Model.samplingParams` per key. Only applied by
	 * OpenAI-compatible adapters (completions, responses, Azure responses); other APIs ignore it.
	 */
	// OpenAI 兼容适配器按键合并抽样参数，本次覆盖模型默认；其他协议可忽略它。
	samplingParams?: SamplingParams;
	// 希望最多输出的 token 数，不等同上下文窗口或实际用量。
	maxTokens?: number;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	// 可选传输偏好，不支持该选项的供应商忽略。
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	// 提示词缓存保留偏好，具体缓存是否命中由供应商决定；不是压缩历史。
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	// 支持会话感知的供应商可用来路由/缓存；没有它不等于绝对不会缓存。
	sessionId?: string;
	/**
	 * WebSocket connect timeout in milliseconds for providers that support
	 * WebSocket transports. This covers the connection/open handshake only;
	 * stream idleness after connection uses timeoutMs.
	 */
	// 仅 WebSocket 连接握手超时，建立后的空闲超时仍用 timeoutMs。
	websocketConnectTimeoutMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	// 可选供应商元数据，unknown 值需按协议解释，未知键可忽略。
	metadata?: Record<string, unknown>;
}

// 交叉类型在公共 StreamOptions 基础上允许其他字符串键的未知值，用于无类型调度形状。
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

// 延迟结果获取选项继承同样认证/HTTP字段，不等同初始生成的 StreamOptions。
export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * Maximum provider long-poll duration in milliseconds.
	 * Defaults to 0, which performs one status check.
	 */
	// 供应商一次长轮询的最长等待毫秒，默认 0 只查一次；不是整个后台任务总时长。
	wait?: number;
}

/** Request options for best-effort deferred-response cancellation. */
// 取消延迟任务只复用公共请求字段，取消是 best-effort，不保证远端一定已停止。
export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

/**
 * Maps known APIs to their full provider-specific stream option types.
 * Type-only imports from API implementation modules are erased at emit, so
 * this is tree-shake safe.
 */
// 协议名到具体请求选项类型的映射；下面键与接口名一一关联，供索引访问类型使用。
export interface ApiOptionsMap {
	// Anthropic 协议选项形状。
	"anthropic-messages": AnthropicOptions;
	// OpenAI Completions 选项。
	"openai-completions": OpenAICompletionsOptions;
	// OpenAI Responses 选项。
	"openai-responses": OpenAIResponsesOptions;
	// Codex Responses 特有选项。
	"openai-codex-responses": OpenAICodexResponsesOptions;
	// Azure Responses 选项。
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	// Google Generative AI 选项。
	"google-generative-ai": GoogleOptions;
	// Google Vertex 选项。
	"google-vertex": GoogleVertexOptions;
	// Mistral Conversations 选项。
	"mistral-conversations": MistralOptions;
	// Bedrock Converse Stream 选项。
	"bedrock-converse-stream": BedrockOptions;
	// pi-messages 选项。
	"pi-messages": PiMessagesOptions;
}

/**
 * Full stream options for an API. Known APIs resolve to their concrete option
 * type; custom API strings fall back to the generic shape.
 */
// 条件类型：TApi 在已知键中则取精确 ApiOptionsMap[TApi]，自定义协议用通用形状；不会生成运行时分支。
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? // 索引访问类型取当前协议的选项，例如 "anthropic-messages" 对应 AnthropicOptions。
		ApiOptionsMap[TApi]
	: // 未知协议保留通用聊天选项并允许额外字段，不自动验证供应商是否支持它们。
		StreamOptions & Record<string, unknown>;

/**
 * The uniform stream contract of an API implementation module: every module
 * under `src/api/` exports `stream` and `streamSimple`; capable modules may also
 * export deferred-response methods. Lazy wrappers (`lazyApi()`) and provider
 * factories pass these around as values. This is the untyped dispatch shape;
 * per-API option typing lives on the implementation modules themselves and on
 * `Provider.stream()` via `ApiStreamOptions`.
 */
// API 实现对象的统一能力契约；这里是签名，认证装配由 Models/Provider 等上层协调。
export interface ProviderStreams {
	// 专属流入口接规范上下文，同步返回异步可迭代事件流，完整结果由 result() 等待。
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	// 统一参数流入口，如 reasoning 而非供应商原生 effort 字段。
	streamSimple(
		// 聊天模型元数据，不是 Provider 实现。
		model: Model<Api>,
		// 已规范化的上下文，system 规则/工具存于消息里。
		context: TranscriptContext,
		// 统一可选请求参数。
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	// 可选延迟结果获取流；? 表示该对象可以不提供方法。
	fetchDeferred?(
		// 句柄对应模型，调用者应选择匹配的供应商实现。
		model: Model<Api>,
		// 上次后台请求的可保存句柄。
		handle: DeferredHandle,
		// 本次获取/轮询参数。
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	// 可选取消方法返回 Promise<void>；接口不存在时上层应给能力错误，不伪装成功。
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}

/**
 * The uniform contract of an image-generation API implementation module:
 * every image API module under `src/api/` exports exactly `generateImages`,
 * so the module itself satisfies this interface. Lazy wrappers and
 * `createProvider({ images })` pass these around as values.
 */
// 专用图片生成实现契约，与支持 image 输入的聊天实现不同。
export interface ProviderImages {
	// 异步返回 AssistantImages，不返回聊天 token 事件流。
	generateImages(
		// 专用 ImageModel，API 泛型为图片 API。
		model: ImageModel<ImageApi>,
		// 图片生成输入内容块列表。
		context: ImagesContext,
		// 图片请求的公共/协议选项。
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/** The uniform contract implemented by classifier API modules. */
// 结构化分类实现契约，供 createProvider 的 classifiers 映射使用。
export interface ProviderClassifier {
	// classify 根据状态和问题产生类型化答案。
	classify(
		// 专用分类模型，不能按聊天模型使用。
		model: ClassifierModel<ClassifierApi>,
		// 含 state/questions 与可选图片的输入。
		context: ClassifierContext,
		// 分类温度/请求公共选项。
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}

// 分类请求继承公共 HTTP/认证选项，但回调模型为分类模型。
export interface ClassifierOptions extends ProviderRequestOptions<ClassifierModel<ClassifierApi>> {
	/**
	 * Divides the answer logits by this value before they are normalized into probabilities.
	 * Values above 1 soften the distribution; values below 1 sharpen it. Must be positive.
	 * APIs that cannot apply it ignore it.
	 */
	// 答案 logits 的温度缩放，必须正值是接口契约，number 声明本身不做校验；不支持适配器可忽略。
	temperature?: number;
}

// 图片生成请求继承公共选项，回调看到图片模型。
export interface ImagesOptions extends ProviderRequestOptions<ImageModel<ImageApi>> {
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	// 图片 API 可识别的元数据，不承诺所有键被服务端采用。
	metadata?: Record<string, unknown>;
}

// 图片公共参数与额外未知键交叉，供无类型供应商调度使用。
export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
// 统一聊天选项继承 StreamOptions，再增加推理/工具选择/延迟请求等公共表达。
export interface SimpleStreamOptions extends StreamOptions {
	/** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */
	// 自动工具选择或禁用，不代表可在这里直接指定任意一个工具名。
	toolChoice?: ToolChoice;
	// 统一思考级别，具体请求参数由模型能力映射。
	reasoning?: ThinkingLevel;
	/** Ask a capable provider to return a durable handle and continue the request asynchronously. */
	// true 请求异步后台模式，也可给 15m/1h/24h 窗口对象；供应商须支持才有效。
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	/** Custom token budgets for thinking levels (token-based providers only) */
	// token 型思考预算可选覆盖，不是普通输出 maxTokens。
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Receives a normalized transcript: the system prompt and tools live in the
//   leading system message, never on the context itself.
// - Must return an AssistantMessageEventStream.
// - Direct streamSimple() calls may throw synchronously when request auth is
//   missing. Once a stream is returned, request/model/runtime failures should
//   be encoded in that stream.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
// 泛型函数类型：API 与参数形状关联；直接 API 可能同步缺认证抛错，返回流后的错误应按流协议表达。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	// 保留具体协议 TApi 的模型。
	model: Model<TApi>,
	// 已规范上下文，不用顶层 systemPrompt/tools。
	context: TranscriptContext,
	// TOptions 约束继承 StreamOptions，可保留实现特有字段。
	options?: TOptions,
	// 返回流对象而非 Promise；迭代/最终结果仍异步。
) => AssistantMessageEventStream;

// 图片生成函数类型，返回完整结果 Promise，而不是聊天流。
export type ImagesFunction<TOptions extends ImagesOptions = ImagesOptions> = (
	// 专用图片模型。
	model: ImageModel<ImageApi>,
	// 生成输入，包括文字或参考图块。
	context: ImagesContext,
	// 泛型保留图片实现特有可选参数。
	options?: TOptions,
	// Promise 完成后仍需检查结果 stopReason，不把完成当成功。
) => Promise<AssistantImages>;

// 分类函数类型，泛型只负责参数契约，不在声明时执行模型。
export type ClassifierFunction<TOptions extends ClassifierOptions = ClassifierOptions> = (
	// 专用分类模型。
	model: ClassifierModel<ClassifierApi>,
	// 状态/问题输入。
	context: ClassifierContext,
	// 具体分类实现的可选选项。
	options?: TOptions,
	// 返回分类结果 Promise，可含失败状态。
) => Promise<ClassifierResult>;

// 文字签名的一种版本化元数据结构，可序列化进 textSignature，不是正文文本。
export interface TextSignatureV1 {
	// 版本字面量必须为 1，帮助未来区分格式。
	v: 1;
	// 供应商消息标识。
	id: string;
	// 可选阶段为 commentary 或 final_answer；没有字段不强制推断阶段。
	phase?: "commentary" | "final_answer";
}

// 文字内容块的接口，type 字面量是联合类型分辨字段。
export interface TextContent {
	// 明确该块是普通文字。
	type: "text";
	// 实际文字正文，允许空字符串。
	text: string;
	// 可选供应商签名/元信息字符串，可能为旧 id 或 TextSignatureV1 的 JSON；不能当普通正文拼接。
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

// 思考内容块与普通文字分开，回放还可能需要不透明签名。
export interface ThinkingContent {
	// 块种类为 thinking。
	type: "thinking";
	// 可显示/记录的思考文字；不推断它等同模型全部内部计算。
	thinking: string;
	// 供应商原生回放数据，按不透明值保留，不自行拆解或修改。
	thinkingSignature?: string; // Provider-specific opaque or serialized reasoning replay data
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	// true 标记正文被服务端遮蔽，回放数据可能只在签名里；不意味着这里执行了过滤。
	redacted?: boolean;
}

// 内联图片块：base64 数据加 MIME，不是图片 URL 或本地文件路径。
export interface ImageContent {
	// 块种类为 image。
	type: "image";
	// 图片字节的 base64 字符串；类型不验证内容编码或尺寸。
	data: string; // base64 encoded image data
	// 声明媒体类型，例如 image/png；是否与字节一致由实际处理器判断。
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

// 模型提出的一次工具调用，仅描述请求，接口里没有真正的工具 execute 函数。
export interface ToolCall {
	// 联合分辨字段为 toolCall。
	type: "toolCall";
	// 调用 id 用于与 ToolResultMessage.toolCallId 配对。
	id: string;
	// 模型选择的工具名字。
	name: string;
	// 参数为 JSON 对象，schema 校验仍在执行管线，不因类型标注自动合法。
	arguments: JsonObject;
	// Google 思考上下文回放签名，不应当普通可见参数。
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	/** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
	// Responses 动态/命名空间工具的原生命名信息。
	namespace?: string;
	/**
	 * Set when the model's complete arguments text was not a valid JSON object. `arguments` is then `{}`.
	 * Describes the problem and includes the text the model sent; tool argument validation fails with it.
	 */
	// 完整参数不是合法 JSON 对象时记录解析错误，arguments 会先用 {}，执行校验据此报错。
	argumentsError?: string;
}

// 统一用量结构，不是所有分量都必须由每个供应商原生报告。
export interface Usage {
	// 普通输入 token 数。
	input: number;
	// 输出 token 数，包含已计入其中的 reasoning 子集。
	output: number;
	// 缓存读取 token，独立于普通 input 分项；总上下文统计可按约定与 input/output 等相加。
	cacheRead: number;
	// 缓存写入 token 数。
	cacheWrite: number;
	/** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
	// cacheWrite 中采用 1h 保留的子集，不要再额外加到 cacheWrite 总量。
	cacheWrite1h?: number;
	/**
	 * Reasoning/thinking tokens, when the provider reports them. This is a subset of
	 * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
	 * providers that expose a reasoning breakdown; left undefined by providers that don't.
	 */
	// 可选思考 token 子集，已包含于 output；undefined 与明确 0 不同。
	reasoning?: number;
	// 统一总 token，用量计算可能优先采用供应商原生总数。
	totalTokens: number;
	// 费用各分项和总额分开；总额可能来自供应商而分项仍是目录估算。
	cost: {
		/** Catalog-derived input cost. */
		// 按目录单价估算的普通输入费。
		input: number;
		/** Catalog-derived output cost. */
		// 按目录单价估算的输出费。
		output: number;
		/** Catalog-derived cache-read cost. */
		// 按目录单价估算的缓存读取费。
		cacheRead: number;
		/** Catalog-derived cache-write cost. */
		// 按目录规则估算的缓存写入费。
		cacheWrite: number;
		/** Best available total: provider-reported billed cost when supported, otherwise the catalog estimate. */
		// 最佳可得总费用：支持时供应商实报，否则目录估算。
		total: number;
		/** True when `total` is the billed cost reported by the provider. False when it is a catalog estimate; absent also means false. */
		// 仅 true 才表明 total 为供应商账单值；未提供或 false 为估算。
		totalFromProvider?: boolean;
	};
}

// 归一化停止原因；pending/deferred 可能仍有后台任务，stopReason 不等于单纯“是否成功”。
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

// 递归 JSON 值联合，数组只读；不含函数、symbol、undefined，number 类型仍不能保证运行值为有限数。
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
// 字符串索引签名描述 JSON 对象，任意键对应递归 JsonValue。
export type JsonObject = { [key: string]: JsonValue };

// 类型技巧检测 any：与 any 交叉后 0 extends 1 & any 成立；只在编译期计算。
type IsAny<T> = 0 extends 1 & T ? true : false;
// 用 [T] 包裹抑制条件类型对联合逐项分发；双向 extends 检查是否恰为整个 JsonValue 类型。
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
// 判断对象属性类型能否作为 JSON；any/unknown 不直接视为可信 JSON。
type IsJsonProperty<T> = IsAny<T> extends true
	? // any 属性为 false，避免擦掉 JSON 约束。
		false
	: // unknown extends T 表示 T 足够宽（如 unknown），不能静态确认。
		unknown extends T
		? // 过宽属性拒绝。
			false
		: // 排除 undefined 后若为 never，则纯 undefined 的可选/可省略属性可通过属性层规则。
			[Exclude<T, undefined>] extends [never]
			? // 此处 true 表示可在对象序列化表示中省略，不表示顶层 undefined 是 JSON。
				true
			: // 其他属性继续递归检查排掉 undefined 后的内容。
				IsJsonCompatible<Exclude<T, undefined>>;
// 映射对象全部键，最终产出不可 JSON 化的键名联合。
type InvalidJsonKeys<T extends object> = {
	// keyof 遍历属性，-? 去可选标记以确保检查每项；合法字符串/数字键若值可 JSON 则变 never，symbol 键保留为非法键。
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
	// 索引访问把映射结果的各属性值合成联合，合法对象应只剩 never。
}[keyof T];
// 递归 JSON 兼容判断，同样先拒绝 any/unknown，避免不受约束的详情混入消息类型。
type IsJsonCompatible<T> = IsAny<T> extends true
	? // any 分支为 false。
		false
	: // 未知类型不能靠断言自动符合 JSON。
		unknown extends T
		? // unknown 分支为 false。
			false
		: // 整体就是 JsonValue 的类型可直接通过，防无限递归。
			IsExactlyJsonValue<T> extends true
			? // 精确 JSON 联合返回 true。
				true
			: // null/布尔/数字/字符串是基本 JSON 值类型。
				T extends null | boolean | number | string
				? // 基本类型分支通过，但不做 number 的运行时有限性验证。
					true
				: // 顶层 undefined 不作为 JSON 值。
					T extends undefined
					? // 该分支返回 false。
						false
					: // readonly 数组也检查元素，infer TItem 提取元素类型。
						T extends readonly (infer TItem)[]
						? // 对每个元素的类型继续递归判断。
							IsJsonCompatible<TItem>
						: // 函数即便也是对象，也应先排除，不把它当可序列化记录。
							T extends (...args: never[]) => unknown
							? // 函数类型返回 false。
								false
							: // 其他 object 检查每个键值，不是做运行时 JSON.stringify。
								T extends object
								? // 所有非法键结果为 never 才合法；用元组包裹避免 never 的分发效应。
									[InvalidJsonKeys<T>] extends [never]
									? // 对象属性全部可 JSON 时通过。
										true
									: // 至少存在非法键时拒绝。
										false
								: // 其他没有匹配的类型也拒绝。
									false;

/** The JSON representation of a typed in-memory value. Optional object properties remain optional. */
// 将可存于内存的 T 映射成 JSON 表示类型；保留可选属性，但不会执行序列化/删除真实字段。
export type JsonRepresentation<T> = IsAny<T> extends true
	? // any 映成宽泛 JsonValue，表示失去具体结构，而非任意值运行时都合法。
		JsonValue
	: // unknown 同样退回 JsonValue。
		unknown extends T
		? // 这里是 unknown 对应分支的类型结果。
			JsonValue
		: // T 已可赋给 JsonValue 时保留 T，避免不必要重构其类型。
			[T] extends [JsonValue]
			? // 该分支原样返回类型 T。
				T
			: // 数组/元组递归映射，每个位置去掉 undefined；数组与对象分开保留索引形状。
				T extends readonly unknown[]
				? // 映射每个数组/元组键，递归生成 JSON 表示。
					{ [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
				: // 普通对象按属性递归映射，映射默认保留原可选/readonly 修饰。
					T extends object
					? // 每个属性排除 undefined 后递归处理。
						{ [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: // 其他不可表示类型落到 never，在类型层面禁止使用。
						never;

// 可持久保存的后台响应句柄，便于之后获取/取消；它不包含可执行函数。
export interface DeferredHandle {
	// 拥有该任务的供应商 id。
	provider: string;
	// 该后台任务的模型 id，区别于完整模型对象。
	modelId: string;
	// 原生 API 协议标识。
	api: string;
	/** Provider token, such as a response id or batch id plus row id. */
	// 供应商 response id 或批次/行标识等不透明 token，不是认证 API key。
	id: string;
	// 可选过期时间，具体是否可再获取仍由供应商决定。
	expiresAt?: number;
	// 建议下次轮询前等待的毫秒数，不会因字段存在自动启动定时器。
	pollAfterMs?: number;
	/** Provider conversion data required to reconstruct the final assistant message. */
	// 重建最终消息所需的供应商 JSON 数据；不在类型层验证协议细节。
	data?: JsonValue;
}

/**
 * System instructions and tool declarations at one point in the transcript.
 *
 * The leading system message is the system prompt. Later system messages change it:
 * `content` adds instructions from that point on, `sections` replace or remove named
 * prompt sections, and `toolsAdded`/`toolsRemoved` change the tool set. Replaying
 * every system message in order yields the current prompt and tools. Providers that
 * accept system messages mid-conversation send each one in place; other providers
 * rebuild the leading system message from the replayed state.
 */
// system 消息既可包含规则也可表示章节/工具增删；顺序重放得到当前规则，不是每条都完全替换前文。
export interface SystemMessage {
	// 联合角色分辨字段。
	role: "system";
	/** Instruction text. On the leading message this is the base prompt; later, additional instructions. */
	// 首条为基础规则，中途正文作追加规则；支持纯文字或文字块列表。
	content: string | TextContent[];
	/**
	 * Named, ordered prompt sections rendered verbatim after `content`. The leading message
	 * declares them; later messages replace sections by name, and `null` removes one. Keep
	 * each section self-delimiting (a tag, a heading) so the model can relate an update to
	 * the original. Avoid integer-like names; JSON objects reorder those.
	 */
	// 命名章节按键更新，null 删除；避免整数样式键以免对象键顺序重排，类型不自动检查这一约定。
	sections?: Record<string, string | null>;
	/** Complete definitions of tools that become available at this point. */
	// 从此处开始新增/重新定义的完整工具 schema，不能把本地 execute 函数混入声明。
	toolsAdded?: Tool[];
	/** Tools that stop being available at this point. */
	// 从此处停止可用的工具名称引用。
	toolsRemoved?: ToolReference[];
	// system 变更的毫秒时间，不是供应商回复耗时。
	timestamp: number; // Unix timestamp in milliseconds
}

// 普通用户消息可带文字和图片，不含 assistant 的推理/工具调用块。
export interface UserMessage {
	// 角色固定 user，供 switch 收窄字段。
	role: "user";
	// 字符串或文字/图片数组；联合类型表示两种合法表示法，不自动相互转换。
	content: string | (TextContent | ImageContent)[];
	// 用户消息创建的 Unix 毫秒时间。
	timestamp: number; // Unix timestamp in milliseconds
}

// 统一模型回复结构，失败/取消也使用它；不能只凭获得该对象就判断成功。
export interface AssistantMessage {
	// assistant 角色。
	role: "assistant";
	// 内容块联合数组，文字、思考、工具调用可交错；不支持直接放 ImageContent。
	content: (TextContent | ThinkingContent | ToolCall)[];
	// 生成该回复的协议。
	api: Api;
	// 生成该回复的供应商身份。
	provider: ProviderId;
	// 请求记录的模型 id 字符串。
	model: string;
	// 服务端实报的具体模型，可与请求 model 不同，未报告就缺省。
	responseModel?: string; // Concrete model reported by the provider, when reported. May equal the requested `model`
	// 服务端消息/响应 id，可用于诊断或延迟任务关联，不是会话树条目 id。
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/** Exact provider-native effort level used for this response. Absent for legacy or unmanaged responses. */
	// 供应商原生思考 effort 精确值，未管理/旧消息可没有。
	providerThinkingLevel?: string;
	/** Pi thinking level the agent loop requested for this response. Absent outside the agent loop and for legacy responses. */
	// Agent 循环请求的统一思考级别；直接 API 调用或旧记录可缺省。
	thinkingLevel?: ModelThinkingLevel;
	// 经整理的失败/恢复诊断，仍需按诊断类型解释，不能当正文发送。
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	// 该回复 token 与费用记录，失败 setup 可为零占位。
	usage: Usage;
	// 统一停止原因，消费者应检查 error/aborted/pending/deferred 等状态。
	stopReason: StopReason;
	// 后台任务句柄，只有延迟响应场景可能带上。
	deferred?: DeferredHandle;
	// 可读错误信息，可缺省；是否失败以协议状态为准而不是仅有无文字。
	errorMessage?: string;
	// 服务端原始停止原因，便于定位适配前状态。
	rawStopReason?: string;
	/**
	 * Provider indication of whether the model explicitly ended its turn.
	 * Preserved for debugging and does not currently affect agent control flow.
	 */
	// 原生 end-turn 调试信息，当前不直接驱动 Agent 控制流。
	endTurn?: boolean;
	/** Unix timestamp in milliseconds when the request started. */
	// 请求开始的 Unix 毫秒时间，区别于结果对象被读取的时间。
	timestamp: number;
	/**
	 * Milliseconds from `timestamp` until the response ended, measured with a monotonic clock. Set by
	 * `AssistantMessageEventStream` on the final message of a response it saw start; absent for legacy messages and
	 * for deferred results fetched later.
	 */
	// 流层用单调时钟计的耗时，可缺省；旧消息和后来取回的 deferred 结果不伪造为刚开始的新生成时长。
	durationMs?: number;
}

/** A tool call that another tool made while it ran, for example from a codemode script. */
// 一个工具内部再调用另一个工具的有限记录，用于会话追踪，不是新模型 toolCall 正文。
export interface NestedToolCallRecord {
	// 嵌套调用 id，通常含父 id/序号，由上层执行器生成。
	id: string;
	// 被调用的工具名。
	name: string;
	/** Omitted when over the size limits; `argumentsBytes` then gives their size. */
	// 参数太大可省略；没有该字段不代表调用一定无参数。
	arguments?: JsonObject;
	/** UTF-8 size of the arguments as JSON, set when `arguments` is omitted. */
	// 省略参数时记录其 JSON UTF-8 字节数，区别于字符长度。
	argumentsBytes?: number;
	/** `unfinished`: the call was still running when the calling tool finished. */
	// ok/error/unfinished 三种结束状态，最后一种表示父工具结束时它还没完成。
	status: "ok" | "error" | "unfinished";
	// 可选嵌套执行耗时毫秒。
	durationMs?: number;
	/** Error text, truncated. */
	// 截断过的错误文字，不是完整原始工具结果。
	error?: string;
}

/** Bounded record of the nested calls a tool made. Results are not recorded. */
// 父工具的一组嵌套调用记录，不保存子调用全部结果正文。
export interface NestedToolCalls {
	// 本次保留的子调用记录数组。
	calls: NestedToolCallRecord[];
	/** False when calls were dropped, arguments omitted, or calls had not finished. */
	// 任何记录被丢弃、参数省略或尚未完成会为 false，不能把数组等同完整执行审计。
	complete: boolean;
}

// 只有 TDetails 可静态表示为 JSON 时才形成工具结果类型，否则为 never；不会运行时自动净化详情。
export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			// 模型工具结果的角色分辨字段。
			role: "toolResult";
			// 必须关联原始 toolCall.id，不能用任意消息 id 替代。
			toolCallId: string;
			// 实际执行工具名字。
			toolName: string;
			// 模型可见结果允许文字和图片，使用统一内容块数组。
			content: (TextContent | ImageContent)[]; // Supports text and images
			// 可选 JSON 表示详情，原内存类型映成 JsonRepresentation<TDetails>；不代表必发给模型正文。
			details?: JsonRepresentation<TDetails>;
			/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
			// 工具自身或嵌套模型工作用量，不计入主模型上下文大小的普通 usage 推断。
			usage?: Usage;
			/** Calls this tool made to other tools. Kept for the session record; not sent to the model. */
			// 子调用追踪只留会话记录，不发给模型。
			nestedCalls?: NestedToolCalls;
			// 明确工具是否失败，不要求模型从错误文字猜测。
			isError: boolean;
			/** Unix timestamp in milliseconds when the result was created. */
			// 工具结果创建时 Unix 毫秒时间。
			timestamp: number;
			/** Milliseconds the tool's execution took, measured with a monotonic clock. Absent for legacy results. */
			// 工具本次执行耗时，旧记录可缺省。
			durationMs?: number;
		}
	: // 不兼容 JSON 的 TDetails 选到 never，从类型层禁止该结果形状。
		never;

// 四种模型协议角色的联合；coding-agent 的 custom/bash/摘要角色需先转换才能进入这套类型。
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

// 图片生成输入可以是 prompt 文字或参考图片。
export type ImagesInputContent = TextContent | ImageContent;
// 图片生成输出也可能同时有文字块，具体由模型 output 能力决定。
export type ImagesOutputContent = TextContent | ImageContent;

// 专用图片请求上下文，没有聊天 messages 的多角色历史结构。
export interface ImagesContext {
	// 有序输入内容块数组。
	input: ImagesInputContent[];
}

// 图片结果只用 stop/error/aborted，不套用聊天 toolUse 等状态。
export type ImagesStopReason = "stop" | "error" | "aborted";

// 完整图片生成结果，错误也由相同结构表达。
export interface AssistantImages {
	// 图片 API 协议。
	api: ImageApi;
	// 供应商身份。
	provider: ProviderId;
	// 请求模型 id。
	model: string;
	// 输出文字/图片数组，失败包装通常为空。
	output: ImagesOutputContent[];
	// 供应商响应 id，可省略。
	responseId?: string;
	// 只有供应商/适配器提供时才有用量。
	usage?: Usage;
	// 图片任务停止状态。
	stopReason: ImagesStopReason;
	// 可选错误说明。
	errorMessage?: string;
	// 结果记录 Unix 毫秒时间。
	timestamp: number; // Unix timestamp in milliseconds
}

// 多选一分类问题，criteria 的键是候选答案 id，值是对该答案的说明。
export interface ClassifierChoiceQuestion {
	// 分辨问题形状为 choice。
	type: "choice";
	// 判断要求，如“给工单选一个类别”。
	instructions: string;
	// 例如 {bug:"程序错误",request:"功能请求"}，字符串值是供分类理解的标准。
	criteria: Record<string, string>;
}

// 分数分类问题，采用一组有序评分标准。
export interface ClassifierScoreQuestion {
	// 问题种类 score。
	type: "score";
	// 评分任务要求。
	instructions: string;
	// 评分标准文字列表，如何映成数值由相应分类协议解释。
	criteria: string[];
}

// 布尔分类问题，分别描述 true/false 的判据。
export interface ClassifierBoolQuestion {
	// 问题种类 bool。
	type: "bool";
	// 判断任务要求。
	instructions: string;
	// 对象键是 true/false 对应的属性名，不是两份运行时布尔值。
	criteria: { true: string; false: string };
}

// 三种问题构成可分辨联合，先检查 type 再读各自 criteria。
export type ClassifierQuestion = ClassifierChoiceQuestion | ClassifierScoreQuestion | ClassifierBoolQuestion;

// 一次分类请求含 JSON 状态和按名字索引的问题，不是任意聊天提示词数组。
export interface ClassifierContext {
	// 被判断的结构化状态，须可用 JSON 对象表达。
	state: JsonObject;
	/**
	 * Images judged together with `state`. Only models whose `input` includes `"image"` accept them;
	 * other models return an error result.
	 */
	// 可选图片；非空时模型 input 必须允许 image，上层会检查能力，不在类型层检查字节。
	images?: ImageContent[];
	// 问题名到问题结构的映射，结果 answers 按相应名返回。
	questions: Record<string, ClassifierQuestion>;
}

// choice 答案包含选择、每项概率及置信度，类型不验证概率是否归一化。
export interface ClassifierChoiceAnswer {
	// 答案种类 choice。
	type: "choice";
	// 选中的候选 id，接口是 string，不会自动与问题 criteria 键形成依赖类型。
	choice: string;
	// 各候选 id 的概率数字。
	probabilities: Record<string, number>;
	// 适配器提供的置信度，不自行保证数值范围。
	confidence: number;
}

// score 答案结构。
export interface ClassifierScoreAnswer {
	// 答案种类 score。
	type: "score";
	// 评分数值，尺度按问题/协议定义。
	score: number;
	// 该评分的置信度。
	confidence: number;
}

// bool 答案用一个概率表达判断。
export interface ClassifierBoolAnswer {
	// 答案种类 bool。
	type: "bool";
	// 为 true 的概率，number 声明不做 0..1 运行时限制。
	probability: number;
}

// 三种答案联合，按 type 决定可读字段。
export type ClassifierAnswer = ClassifierChoiceAnswer | ClassifierScoreAnswer | ClassifierBoolAnswer;
// 分类结果的有限停止原因。
export type ClassifierStopReason = "stop" | "error" | "aborted";

// 完整分类结果，错误仍可用同结构返回。
export interface ClassifierResult {
	// 分类协议标识。
	api: ClassifierApi;
	// 供应商身份。
	provider: ProviderId;
	// 模型 id。
	model: string;
	// 问题名到答案映射，失败包装通常为空对象。
	answers: Record<string, ClassifierAnswer>;
	/** Token usage and its cost at the model's catalog price, when the service reports token counts. */
	// 可选 token 与目录估算费用，服务未给 token 时可缺省。
	usage?: Usage;
	// 分类停止状态，Promise 完成后仍须检查。
	stopReason: ClassifierStopReason;
	// 可选错误说明。
	errorMessage?: string;
	// 结果 Unix 毫秒时间。
	timestamp: number; // Unix timestamp in milliseconds
}

/** OpenAI grammar variants for constrained sampling. */
// 约束生成的两种 OpenAI 语法格式名字，不是本地解析器已经执行语法校验。
export type GrammarFormat = "openai_lark" | "openai_regex";

// Partial 允许只给某些格式，Record 把格式映到对应语法文本。
export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * Optional provider-side constrained sampling configs for a tool.
 *
 * The `json_schema` value roughly maps to the concept of `strict` in APIs which is
 * implemented as json-schema constrained sampling by APIs. Grammar variants let
 * callers provide provider-specific encodings of the same intended language.
 */
// 工具参数生成约束的联合，选择 JSON Schema 严格模式或供应商 grammar；不代替本地参数 schema 校验。
export type ConstrainedSamplingConfig =
	| {
			// 分辨 JSON Schema 约束模式。
			type: "json_schema";
			// prefer 表示优先，require 表示要求，适配器按协议支持决定处理；不是单纯 boolean。
			strict: "prefer" | "require";
	  }
	| {
			// 分辨语法约束模式。
			type: "grammar";
			// 同一预期语言的不同供应商格式版本，键可省略。
			variants: GrammarVariants;
	  };

/**
 * A tool the model may call. `parameters` is the JSON Schema of its arguments: pi-schema's builders (which also type
 * the arguments, see `Static` in `@earendil-works/pi-schema`), TypeBox schemas, or any JSON Schema object.
 */
// 工具声明泛型只约束参数 schema 是对象；它不是实际工具实现或参数值类型。
export interface Tool<TParameters extends object = object> {
	// 供模型调用的名字。
	name: string;
	// 供模型理解用途的描述。
	description: string;
	// JSON Schema/TypeBox/pi-schema 等 schema 对象，执行管线据它验证实参。
	parameters: TParameters;
	// false 可明确关闭约束；缺省和具体约束配置保留不同含义，是否支持看适配器。
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

// 工具移除等操作只需名字引用，不需完整 schema。
export interface ToolReference {
	// 目标工具名称。
	name: string;
}

/**
 * Request input accepted by the public stream entry points (`Models.stream()`,
 * `streamSimple()`, ...). `systemPrompt` and `tools` are shorthand for a leading
 * system message; `normalizeContext()` folds them into one before the request
 * reaches a provider.
 */
// 公共请求输入可用顶层 systemPrompt/tools 简写；规范化后这些信息折进首条 system 消息。
export interface Context {
	// 可选系统规则简写，不在接口声明时自动追加消息。
	systemPrompt?: string;
	// 按因果顺序排列的统一消息数组。
	messages: Message[];
	// 可选工具声明简写，不含执行函数。
	tools?: Tool[];
}

// declare 只声明编译期唯一 symbol 品牌，不生成运行时常量；品牌用来区分规范上下文。
declare const transcriptContextBrand: unique symbol;

/**
 * Normalized request context passed to providers and API implementations. The
 * prompt and tool declarations are carried by the transcript's system messages.
 * Only `normalizeContext()` produces this type, so a raw `Context` cannot reach
 * provider code by accident.
 */
// 规范上下文只携带 messages；品牌限制普通 Context 意外赋值，不是运行时验证或不可绕过的安全边界。
export type TranscriptContext = {
	// system 规则/工具声明已规范进有序消息数组。
	messages: Message[];
	// 计算属性名与 unique symbol 形成名义区分，readonly 仅类型层约束；规范化器通过断言构造此类型，不把品牌实际写进对象。
	readonly [transcriptContextBrand]: true;
};

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Successful streams emit `start` before partial updates and terminate with
 * `done`. A stream may terminate directly with `error` when request setup fails
 * before generation starts; after `start`, failures also terminate with `error`.
 * Direct `streamSimple()` calls throw synchronously when request auth is missing.
 * Updates and `done` must never appear before `start`.
 *
 * `partial` is the shared live response-so-far helper, not an event-time
 * snapshot. Text and thinking blocks are empty when their `*_start` event is
 * emitted and grow only through their corresponding `*_delta` events until the
 * authoritative `*_end`. Redacted thinking may be complete at start and emit no
 * deltas. Tool-call arguments at `toolcall_start` are provider-specific;
 * `toolcall_delta` carries subsequent JSON updates.
 */
// 事件联合按 type 收窄；partial 是共享的实时累计对象，不是每个事件时刻的深快照。
export type AssistantMessageEvent =
	// start 宣告生成开始，partial 尚可继续变化。
	| { type: "start"; partial: AssistantMessage }
	// 文字块开始，contentIndex 指向内容块位置，普通文字此刻通常为空。
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	// 文字增量 delta 是本次片段，partial 包含累计回复。
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	// 文字块结束给完整 content，区别于 delta。
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// 思考块开始；被遮蔽思考可从开始就已完整且没有后续 delta。
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	// 思考文字增量。
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	// 思考块结束给完整思考文字。
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// 工具调用块开始，初始参数表示依适配器而异。
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	// 工具参数 JSON 的后续增量文字，不保证每个 delta 本身可独立 JSON.parse。
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	// 工具调用结束给完整 ToolCall，执行仍由 Agent 管线负责。
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			// 流正常协议结束，原因可为 stop/length/toolUse/deferred。
			type: "done";
			// Extract 从 StopReason 联合中选允许的正常终止原因；不含 error/aborted。
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			// 最终完整消息，仍应检查停止原因是否需要工具或后台轮询。
			message: AssistantMessage;
	  }
	// 错误/取消用 error 事件携带完整 assistant 失败消息；setup 失败可直接发该事件而没有 start。
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** Fields shared by every catalog entry, regardless of what you can do with it. */
// 各模型种类共用的目录元数据；TApi 限制协议字符串形状，不是供应商实现对象。
export interface BaseModel<TApi extends string> {
	// 目录内模型 id，同种类内用于定位。
	id: string;
	// 用户可见展示名。
	name: string;
	// 实际请求协议，泛型保留字面量以关联参数类型。
	api: TApi;
	// 拥有模型的供应商 id。
	provider: ProviderId;
	// 请求端点基础地址，可由认证/配置覆盖。
	baseUrl: string;
	// 允许的输入模态，如 text/image，由目录数据声明。
	input: ModelInputModality[];
	/** Provider input limits and cache-safe preprocessing metadata. */
	// 模型输入限制与缓存一致的预处理元数据，是否应用由实际入口决定。
	inputLimits?: ModelInputLimits;
	// 目录单价与可选阶梯规则，不是请求使用量。
	cost: ModelCost;
	// 静态模型请求头只允许字符串；后续装配到 ProviderHeaders 时可再加入 null 抑制标记。
	headers?: Record<string, string>;
}

/** Chat model: usable with `stream()` and friends. */
// 聊天模型继承通用目录形状，并加上下文/输出/思考等能力元数据。
export interface Model<TApi extends Api> extends BaseModel<TApi> {
	/**
	 * Optional: chat is the default model type, so models without `type` are chat
	 * models. Narrow mixed model lists with `isModelType()` instead of comparing
	 * `type` directly.
	 */
	// type 可省略；旧模型省略按 chat，混合列表应调用 isModelType 而不直接比 undefined。
	type?: "chat";
	// 是否支持 reasoning 的目录标记，不代表当前请求已启用。
	reasoning: boolean;
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 */
	// 统一思考档位到原生值映射；缺键走适配器默认，null 明确不支持。
	thinkingLevelMap?: ThinkingLevelMap;
	/** Prompt cache lifetimes per retention tier. Unset when the provider's cache behavior is unknown. */
	// 可选提示词缓存档位寿命信息；缺省表示未知，不等于明确禁缓存。
	promptCache?: ModelPromptCache;
	// 模型上下文容量，区别于请求 maxTokens 和实际 usage。
	contextWindow: number;
	// 模型目录声明最大输出 token 预算。
	maxTokens: number;
	/** Default sampling parameters for this model. See {@link StreamOptions.samplingParams}; per-request keys override these. */
	// 模型默认抽样字段，请求 samplingParams 同名键优先。
	samplingParams?: SamplingParams;
	/** Sampling parameter overrides selected by the effective pi thinking level. */
	// 按当前有效统一思考级别挑抽样覆盖项。
	samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	// 条件类型按 TApi 选择兼容配置结构，不在此猜测实际 HTTP 服务能力。
	compat?: TApi extends "openai-completions"
		? // Completions 协议对应自己的兼容 schema。
			OpenAICompletionsCompat
		: // 三种 Responses 协议共用 Responses 兼容选项。
			TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? // Responses 条件命中的类型结果。
				OpenAIResponsesCompat
			: // Anthropic 分支条件。
				TApi extends "anthropic-messages"
				? // Anthropic 对应选项。
					AnthropicMessagesCompat
				: // Bedrock 分支条件。
					TApi extends "bedrock-converse-stream"
					? // Bedrock 对应选项。
						BedrockCompat
					: // Mistral 分支条件。
						TApi extends "mistral-conversations"
						? // Mistral 对应选项。
							MistralConversationsCompat
						: // 其余协议 compat 字段类型为 never；不生成实际运行时分支。
							never;
}

/** Image-generation model: usable with `generateImages()` only. */
// 专用图片生成模型，不能仅因聊天模型支持看图就传入它的入口。
export interface ImageModel<TApi extends ImageApi> extends BaseModel<TApi> {
	// 种类必须明确为 image，不能省略。
	type: "image";
	/** Output modalities. Always includes `"image"`; `"text"` means the model can also return text blocks. */
	// 可输出的模态，应包含 image；text 表示可伴随说明，数组类型本身不强制至少有一项。
	output: ("text" | "image")[];
}

/** Structured classifier model: usable with `classify()` only. */
// 专用结构化分类模型，继承通用目录形状。
export interface ClassifierModel<TApi extends ClassifierApi> extends BaseModel<TApi> {
	// 种类必须 classifier。
	type: "classifier";
	// 分类上下文容量元数据。
	contextWindow: number;
	/** Compatibility overrides for System One APIs. If not set, auto-detected from provider, baseUrl, and id. */
	// 仅这两类 System One 协议提供该兼容配置，其余为 never。
	compat?: TApi extends "typesafe-system-one" | "cloudflare-workers-ai-system-one" ? SystemOneCompat : never;
}

/** Model shape for each model type. */
// 种类到完整模型形状的类型字典，供索引访问/泛型推导。
export interface ModelTypeMap {
	// chat 对应聊天模型联合 API。
	chat: Model<Api>;
	// image 对应图片生成模型。
	image: ImageModel<ImageApi>;
	// classifier 对应分类模型。
	classifier: ClassifierModel<ClassifierApi>;
}

/** What a catalog entry is for. Decides which `Models` operation accepts it. */
// keyof 提取映射的键联合，结果为 chat|image|classifier。
export type ModelType = keyof ModelTypeMap;

/** Anything a provider can list. Narrow with `isModelType()`. */
// 用全部种类键索引映射，得到三种模型的联合；先按种类收窄再用专属字段。
export type AnyModel = ModelTypeMap[ModelType];
