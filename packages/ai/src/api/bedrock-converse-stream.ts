// Bedrock ConverseStream适配：交AWS SDK处理认证与网络，把系统/工具/缓存和SDK事件转换成Pi统一消息。
// 仅导入Node HTTPS Agent类型并重命名，运行时不加载https模块值。
import type { Agent as HttpsAgent } from "node:https";
// 这一组混合导入AWS SDK运行值与type类型，本文件真正创建SDK客户端并由它发请求。
import {
	// 客户端负责端点、认证签名、HTTP及AWS事件流反序列化。
	BedrockRuntimeClient,
	// type只复用客户端配置契约，编译后擦除。
	type BedrockRuntimeClientConfig,
	// SDK服务错误基类供限额降级和可读错误分类。
	BedrockRuntimeServiceException,
	// StopReason运行值重命名，避免和Pi统一停止原因类型重名。
	StopReason as BedrockStopReason,
	// SDK工具声明类型重命名为BedrockTool，不是Pi工具执行对象。
	type Tool as BedrockTool,
	// 缓存点类型常量，后面取DEFAULT。
	CachePointType,
	// 缓存TTL常量，ONE_HOUR实际值是1h。
	CacheTTL,
	// SDK输入内容块是按互斥成员组织的联合类型。
	type ContentBlock,
	// 内容增量事件类型，索引和delta在SDK签名里仍可undefined。
	type ContentBlockDeltaEvent,
	// 块开始事件类型，本文件只接其中toolUse。
	type ContentBlockStartEvent,
	// 块结束事件类型，和整条messageStop分开。
	type ContentBlockStopEvent,
	// user/assistant等角色运行值常量。
	ConversationRole,
	// 一次ConverseStream请求的命令类，交client.send真正发送。
	ConverseStreamCommand,
	// 命令输出类型含可选异步stream及SDK的$metadata。
	type ConverseStreamCommandOutput,
	// 元数据事件类型含用量、性能、trace等，本适配器只读取usage。
	type ConverseStreamMetadataEvent,
	// 图片格式运行值常量，后面按MIME挑对应成员。
	ImageFormat,
	// AWS消息类型，别与Pi消息联合混淆。
	type Message,
	// 顶层system块类型，和普通消息content块分开。
	type SystemContentBlock,
	// AWS工具选择联合包含auto/any/具体tool。
	type ToolChoice,
	// AWS工具列表与选择配置类型。
	type ToolConfiguration,
	// 工具结果内容联合，可放文本或图片等。
	type ToolResultContentBlock,
	// AWS工具结果success/error运行值常量。
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
// HTTP/1.1 handler，遇代理或强制HTTP1时替换SDK默认HTTP2 handler。
import { NodeHttpHandler } from "@smithy/node-http-handler";
// Smithy中间件、文档JSON、HTTP响应和元数据类型，仅用于编译期。
import type { BuildMiddleware, DeserializeMiddleware, DocumentType, HttpResponse, MetadataBearer } from "@smithy/types";
// HTTP目标经代理时使用的Agent构造器。
import { HttpProxyAgent } from "http-proxy-agent";
// HTTPS目标经代理时使用的Agent构造器。
import { HttpsProxyAgent } from "https-proxy-agent";
// 按模型目录价格计算本地用量费用，原地写usage.cost。
import { calculateCost } from "../models.ts";
// 这一组仅类型导入，不在运行时创建实例。
import type {
	// API协议标识联合。
	Api,
	// 统一assistant输出形状，流事件可引用同一可变对象。
	AssistantMessage,
	// 缓存偏好none/short/long类型。
	CacheRetention,
	// Pi图片块携带MIME与base64正文。
	ImageContent,
	// JSON对象类型供结构化诊断details使用。
	JsonObject,
	// 递归JSON值联合，用于工具参数文档清洗。
	JsonValue,
	// 泛型Model把本入口与对应API元数据关联。
	Model,
	// 请求环境覆盖字典，不是独立的进程环境。
	ProviderEnv,
	// 统一响应钩子的状态/头字典形状。
	ProviderResponse,
	// 公共简化选项，后面转换为Bedrock原生配置。
	SimpleStreamOptions,
	// Pi统一停止原因，与AWS原始原因分开。
	StopReason,
	// 泛型流函数签名。
	StreamFunction,
	// 共用流选项；继承不意味着每个字段在本适配器都会生效。
	StreamOptions,
	// Pi普通文字内容块类型。
	TextContent,
	// 自定义四档token思考预算类型。
	ThinkingBudgets,
	// 不含off的思考级别联合。
	ThinkingLevel,
	// Pi工具声明形状，不要求包含执行函数。
	Tool,
	// 工具结果消息形状，含调用id、结果块与isError。
	ToolResultMessage,
} from "../types.ts";
// 给统一消息附结构化诊断，不自动执行重试。
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
// 把未知供应商异常规范成文字/状态/正文视图，不等于自动脱敏。
import { normalizeProviderError } from "../utils/error-body.ts";
// Pi本地异步事件通道，不是AWS网络事件流本身。
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
// 合并可删除请求头为普通字典；null会在进入中间件前被移除。
import { providerHeadersToRecord } from "../utils/headers.ts";
// 身份配置仅类型导入，getClientVersion运行时生成版本部分。
import { type ClientIdentity, getClientVersion } from "../utils/identity.ts";
// 按目标及环境选择HTTP/HTTPS代理，坏代理配置可抛错。
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
// 请求env优先，再进程环境，再Bun沙箱回退；空值按||继续回退。
import { getProviderEnvValue } from "../utils/provider-env.ts";
// 删除不成对UTF-16代理码元，保留正常文字与成对字符。
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// 每条工具调用单独维护增量JSON预览，块结束才做最终参数解析。
import { ToolCallArgumentsStream } from "../utils/streaming-json.ts";
// 渲染system正文及有效sections。
import { getSystemMessageText } from "../utils/text.ts";
// 会话轨迹辅助负责系统/工具状态重放，不调用模型摘要。
import {
	// 把所有system变化折叠成首条完整system，返回新轨迹。
	collapseSystemMessages,
	// 顺序重放工具增删，取当前工具集合。
	getCurrentTools,
	// 只取轨迹第一条system。
	getInitialSystemMessage,
	// 规范轨迹类型，type导入在编译后擦除。
	type TranscriptContext,
	// 供应商把system放顶层时，去掉消息列表中的首条system。
	withoutInitialSystemMessage,
} from "../utils/transcript.ts";
// 工具JSON Schema约束辅助，不负责执行工具。
import {
	// strict为true时产生严格schema副本，否则返回原schema引用。
	getJsonSchemaToolParameters,
	// 按已知大小写敏感错误子串识别严格工具总量/编译限制。
	isStrictToolLimitErrorMessage,
	// 只识别声明是否明确strict:prefer。
	prefersJsonSchemaStrictSampling,
	// 按能力和prefer/require决定是否启用严格schema，require不能满足时可抛错。
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
// 简化配置与预算辅助，不发网络。
import {
	// 协调思考与回答共享的输出上限。
	adjustMaxTokensForThinking,
	// 选定公共字段透传并按上下文估算输出预算。
	buildBaseOptions,
	// 把输出上限限制在估算上下文剩余空间，非精确tokenizer保证。
	clampMaxTokensToContext,
	// xhigh/max映射为四档预算表中的high。
	clampReasoning,
} from "./simple-options.ts";
// 历史转换负责跨模型签名/id/图片和缺结果；Claude错误结果拆图由另一helper处理。
import { splitErrorToolResultImages, transformMessages } from "./transform-messages.ts";

// 导出的字符串字面量联合限定显示选项；类型本身不会修改思考内容。
export type BedrockThinkingDisplay = "summarized" | "omitted";

// 原生配置扩展公共流选项，interface只在编译期约束调用者。
export interface BedrockOptions extends StreamOptions {
	// 显式地区，可被Node/Bun的模型ARN地区优先覆盖。
	region?: string;
	// 显式命名profile；与仅有进程AWS_PROFILE的路径处理不同。
	profile?: string;
	// none会省略工具配置；具体工具用带type标签的对象表达。
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	// 原生入口直接读取reasoning与model.reasoning，不统一先按模型能力钳制。
	reasoning?: ThinkingLevel;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	// 自定义预算只覆盖minimal到high，xhigh/max在token预算分支归high。
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	// 固定预算Claude思考分支默认开交错beta，false可关闭；adaptive分支另有binding beta。
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude's thinking content is returned in responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking content is redacted but the signature still travels back
	 *   for multi-turn continuity, reducing time-to-first-text-token.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.8 and Mythos Preview is
	 * "omitted". We default to "summarized" here to keep behavior consistent with
	 * older Claude 4 models. Only applies to Claude models on Bedrock.
	 */
	// Claude请求的显示偏好，非GovCloud缺省summarized；不是本地解密或生成摘要。
	thinkingDisplay?: BedrockThinkingDisplay;
	/** Key-value pairs attached to the inference request for cost allocation tagging.
	 * Keys: max 64 chars, no `aws:` prefix. Values: max 256 chars. Max 50 pairs.
	 * Tags appear in AWS Cost Explorer split cost allocation data.
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	// 专用Bedrock请求元数据原样附加；这里不验证原英语所列数量/长度限制，也不与公共metadata自动合并。
	requestMetadata?: Record<string, string>;
	/** Bearer token for Bedrock API key authentication.
	 * When set, bypasses SigV4 signing and sends Authorization: Bearer <token> instead.
	 * Requires `bedrock:CallWithBearerToken` IAM permission on the token's identity.
	 * Set via AWS_BEARER_TOKEN_BEDROCK env var or pass directly.
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	// 显式Bearer token优先于apiKey和环境值；本文件不登录/刷新/核验其权限。
	bearerToken?: string;
}

/**
 * Stream state of one open Bedrock content block, keyed by `contentBlockIndex` and kept off the content block so it
 * never reaches partial messages.
 */
// 每个网络块索引对应的临时状态，独立于对外content块。
type OpenBlock = {
	// 输出content数组的位置；readonly仅限制TS中重赋，不是运行时冻结。
	readonly contentIndex: number;
	// 工具JSON增量解析器可缺省；readonly不阻止解析器内部状态变化。
	readonly arguments?: ToolCallArgumentsStream;
	/** Encrypted reasoning deltas, joined into `thinkingSignature` when the block ends. */
	// 加密思考字节暂存在这里，块结束/整体清理时合成base64，不放到partial消息里。
	redactedChunks?: Uint8Array[];
};

// 网络contentBlockIndex→本地状态的可变Map，不等于直接用网络索引访问output.content。
type OpenBlocks = Map<number, OpenBlock>;

// 必须有文字但过滤后为空时使用的固定占位，非用户真实输入。
const EMPTY_TEXT_PLACEHOLDER = "<empty>";

// Claude思考块绑定策略的请求beta标识。
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

/** Matches the placeholder the Anthropic API path uses for redacted thinking. */
// 加密思考的可读占位；不解密或显示原始思考。
const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";

/**
 * 调用Bedrock ConverseStream，同步返回Pi事件通道；输入模型、完整规范历史与原生选项，不执行工具。
 * 先折叠系统轨迹，配置地区/端点/profile/key或Bearer及代理，再由AWS SDK发命令；严格prefer工具限额可重建一次请求，随后消费SDK事件组装内容、用量和停止原因。
 * 会联网、调用钩子并修改本轮output；例Claude调用read后，上层回传toolResult，本入口下一轮把连续结果合成user消息。缓存点只是服务端提示缓存请求，不是模型摘要，也不保证缓存命中。
 * 前置轨迹可同步抛错，异步配置也有部分在主try外；通常主try内失败保留partial并发error。公共fetch/timeout/maxRetries未直接映射到此SDK配置，SDK默认认证/重试可另有行为。
 */
// 泛型静态绑定Bedrock协议和原生选项；函数同步返回Pi事件通道。
export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	// 模型含id、URL、能力与目录价格。
	model: Model<"bedrock-converse-stream">,
	// 输入完整规范轨迹，不只包含最后一条用户消息。
	context: TranscriptContext,
	// 缺省配置用新空对象，后面可直接读取options字段。
	options: BedrockOptions = {},
	// 返回通道对象而非Promise，内部异步任务另外启动。
): AssistantMessageEventStream => {
	// 先创建本地事件通道，不等AWS响应。
	const stream = new AssistantMessageEventStream();
	// Bedrock has no mid-conversation system messages; fold them into the leading prompt.
	// 全部system折入首条当前提示/工具；这里是同步前置步骤，抛错不会进入内部catch。
	const normalizedContext = collapseSystemMessages(context);

	/**
	 * 本轮立即执行的异步任务，闭包读取模型/轨迹/选项并向Pi通道发布结果，无独立返回数据。
	 * 例send返回后仍继续await异步流，只有有效停止状态后才发done；配置计算位于主try之前，那里抛错可能让这个未被外层等待的Promise拒绝而没有error事件。
	 */
	// 立即执行async闭包，外层不返回或等待它的Promise。
	(async () => {
		// 创建本轮共享可变assistant，后续partial事件继续引用它。
		const output: AssistantMessage = {
			// 固定assistant角色。
			role: "assistant",
			// 内容从空数组开始，按首个相应事件建立文字/思考/工具块。
			content: [],
			// 记录统一API标识，as仅帮助TS，不转换运行值。
			api: "bedrock-converse-stream" as Api,
			// 保存请求模型的provider身份。
			provider: model.provider,
			// 保存请求模型id，不自动改成远端返回别名。
			model: model.id,
			// 用量容器初始为零，收到metadata.usage才更新。
			usage: {
				// 普通输入初始零。
				input: 0,
				// 输出初始零。
				output: 0,
				// 缓存读初始零。
				cacheRead: 0,
				// 缓存写初始零。
				cacheWrite: 0,
				// 总token初始零。
				totalTokens: 0,
				// 费用四项及总价初始零，终态用量到来后按目录估价。
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			// pending表示还没有收到可交付停止状态。
			stopReason: "pending",
			// 本地毫秒起始时间，不是服务端生成时间。
			timestamp: Date.now(),
		};

		// 每轮独立临时块Map，不把解析器/字节缓存塞进输出内容。
		const openBlocks: OpenBlocks = new Map();

		// A profile explicitly configured through pi's auth flow (the `profile`
		// option or scoped `AWS_PROFILE` on the stored credential's env) must win
		// over ambient AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. The SDK default
		// chain already prefers a configured profile over env keys, but only when
		// `credentials` is not set on the client config. See #6957.
		// 只看显式profile或请求env中的AWS_PROFILE，用它阻止后面把环境access keys固定进config。
		const optionsProfile = options.profile || options.env?.AWS_PROFILE;
		// SDK配置先设profile与附加User-Agent，不是发请求时的全部wire字段。
		const config: BedrockRuntimeClientConfig = {
			// 显式/scoped profile优先，否则用环境helper；仅ambient profile也会写到config，但不阻止下方固定access keys。
			profile: optionsProfile || getProviderEnvValue("AWS_PROFILE", options.env),
			// 生成AWS SDK自定义UA部分；本适配器不使用其他入口的通用归因头构建器。
			customUserAgent: bedrockUserAgent(options.identity),
		};
		// 选项region→AWS_REGION→AWS_DEFAULT_REGION，均取首个真值，不trim。
		const configuredRegion = getConfiguredBedrockRegion(options);
		// 刻意只查ambient环境，不传options.env；仅scoped/显式profile不使这个标记为true。
		const hasAmbientConfiguredProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
		// 只从标准AWS Bedrock runtime主机名提地区，不为自定义代理猜地区。
		const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
		// 决定是否把模型baseUrl固定为SDK endpoint。
		const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
			// 传模型基础URL，后面代理选择也仍用它。
			model.baseUrl,
			// 有显式/环境地区时不固定标准目录端点。
			configuredRegion,
			// 有ambient profile时让SDK解析标准端点/地区；scoped profile不影响此标记。
			hasAmbientConfiguredProfile,
		);

		// Only pin standard AWS Bedrock runtime endpoints when no region or ambient AWS_PROFILE is configured.
		// This preserves custom endpoints (VPC/proxy) from #3402 without forcing built-in
		// catalog defaults such as us-east-1 to override AWS_REGION/AWS_PROFILE.
		// 自定义端点始终进入；标准端点仅在没有configuredRegion和ambient profile时进入。
		if (useExplicitEndpoint) {
			// 写endpoint原字符串，不在此重新按ARN地区改URL。
			config.endpoint = model.baseUrl;
		}

		// Resolve bearer token for Bedrock API key auth.
		// 只有精确字符串1启用代理用的dummy凭证路径；它不是“完全关闭SDK签名”的开关。
		const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
		// 依次选择Bearer候选，空串会继续回退，纯空白仍是真值。
		const bearerToken =
			// 原生bearerToken优先。
			options.bearerToken ||
			// 其次公共apiKey也当Bedrock Bearer用，不当accessKeyId。
			options.apiKey ||
			// 再读scoped/ambient AWS_BEARER_TOKEN_BEDROCK。
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) ||
			// 全无真值统一undefined。
			undefined;
		// token存在且没skipAuth才显式配置Bearer；不在本处检查token格式/期限。
		const useBearerToken = bearerToken !== undefined && !skipAuth;

		// in Node.js/Bun environment only
		// 仅Node/Bun做ARN地区、显式key和Node代理handler配置，浏览器走下面else。
		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			// Region resolution: ARN-embedded > explicit option > env vars > SDK default chain.
			// When the model ID is an inference profile ARN, extract the region from it.
			// This avoids conflicts with AWS_REGION set for other services.
			// 从特定aws分区Bedrock ARN开头捕获地区，大小写敏感，不完整验证ARN身份/权限。
			const arnRegionMatch = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
			// 匹配到ARN时优先使用捕获地区。
			if (arnRegionMatch) {
				// 即使options.region/AWS_REGION不同也先用ARN地区；此前endpoint选择不会因此重算。
				config.region = arnRegionMatch[1];
				// 无ARN地区才采用显式/环境地区。
			} else if (configuredRegion) {
				// 将选出的地区字符串交SDK。
				config.region = configuredRegion;
				// 再用已固定的标准endpoint地区。
			} else if (endpointRegion && useExplicitEndpoint) {
				// 与固定标准主机名地区对应；自定义主机未在此猜地区。
				config.region = endpointRegion;
				// 无上述来源且无ambient profile时设本地缺省。
			} else if (!hasAmbientConfiguredProfile) {
				// 默认us-east-1；若有ambient profile则此处不赋region，让SDK配置链解析。
				config.region = "us-east-1";
			}

			// Support proxies that don't need authentication
			// skipAuth在这个Node/Bun分支只配置dummy访问密钥。
			if (skipAuth) {
				// 固定凭证对象避免这条分支依赖真实访问密钥；SDK仍可按认证方案签名。
				config.credentials = {
					// dummy访问key，不是用户AWS身份。
					accessKeyId: "dummy-access-key",
					// dummy秘密key，不证明代理一定会接受请求。
					secretAccessKey: "dummy-secret-key",
				};
			}

			// 从请求/环境取成对access key和可选session token。
			const credentials = getConfiguredBedrockCredentials(options.env);
			// 仅没skipAuth、key成对且没显式/scoped profile才固定credentials；仅ambient profile不阻止这里。
			if (!skipAuth && credentials && !optionsProfile) {
				// 固定对象绕过默认凭证查找链；不在此验证这些key能否使用。
				config.credentials = credentials;
			}

			// 按模型baseUrl和请求环境挑代理；这一段在主try之前，坏代理配置可使内部任务提前拒绝。
			const proxyUrl = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
			// 有代理时采用支持Agent的HTTP/1.1 handler。
			if (proxyUrl) {
				// Bedrock runtime uses NodeHttp2Handler by default since v3.798.0, which is based
				// on `http2` module and has no support for http agent.
				// Use NodeHttpHandler to support HTTP(S) proxy agents.
				// 用NodeHttpHandler替换安装SDK默认NodeHttp2Handler，不是复用options.fetch。
				config.requestHandler = new NodeHttpHandler({
					// HTTP目标的代理Agent。
					httpAgent: new HttpProxyAgent(proxyUrl),
					// HTTPS目标的代理Agent；双重as只桥接包的类型差异，不转换或验证实例。
					httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
				});
				// 无代理时才看强制HTTP1开关，精确1生效。
			} else if (getProviderEnvValue("AWS_BEDROCK_FORCE_HTTP1", options.env) === "1") {
				// Some custom endpoints require HTTP/1.1 instead of HTTP/2
				// 新建默认HTTP/1.1 handler，没有在此传options.timeoutMs。
				config.requestHandler = new NodeHttpHandler();
			}
			// 浏览器等非Node/Bun分支不执行上面的ARN提取/访问密钥对象/Node代理配置。
		} else {
			// Non-Node environment (browser): fall back to us-east-1 since
			// there's no config file resolution available.
			// 为浏览器直接选择地区，不依赖Node共享配置文件链。
			config.region =
				// configuredRegion优先，其次固定标准端点地区，最后us-east-1；这里不读取模型ARN地区。
				configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
		}

		// 有显式选中的Bearer候选时配置SDK认证方案。
		if (useBearerToken) {
			// token对象交SDK，不在本处刷新或验权。
			config.token = { token: bearerToken };
			// 优先httpBearerAuth，由SDK选方案并签头，不手写Authorization。
			config.authSchemePreference = ["httpBearerAuth"];
		}

		// Kept outside the try so the catch can still correlate a mid-stream failure:
		// exceptions delivered as stream events carry no HTTP metadata of their own.
		// 保存响应请求id供中途异常诊断，流内错误可能没有自己的$metadata。
		let responseRequestId: string | undefined;

		// 主try从SDK客户端构造开始，不覆盖此前配置计算，也没有第二层catch兜底自身清理/格式化失败。
		try {
			// 严格工具能力缺省false，不联网探测模型能力。
			const supportsStrictMode = model.compat?.supportsStrictMode ?? false;
			// 每轮新建客户端；本文件没有finally client.destroy，也没有跨轮客户端缓存。
			const client = new BedrockRuntimeClient(config);
			// 标记是否已在原始HTTP中间件观察到响应，避免之后再次补发精简元数据。
			let observedRawResponse = false;
			// 有onResponse才安装原始HTTP头捕获。
			if (options.onResponse) {
				/**
				 * 原始HTTP响应被识别时调用的零参数回调，返回void，更新observedRawResponse；不自己调用用户钩子。
				 * 例网关自定义头已经由中间件交出后，避免成功send回来再补一份只有requestId的精简头。
				 */
				// 注册回调，成功观察原始响应后同步设标记，再等待用户onResponse。
				addResponseHeadersMiddleware(client, options.onResponse, model, () => {
					// 原始响应已观察，不再把只有requestId的$metadata当完整头重复回调。
					observedRawResponse = true;
				});
			}
			// 只处理options.headers，未在此单独合并model.headers；null标记会在helper里移除。
			const customHeaders = providerHeadersToRecord(options.headers);
			// 有有效普通头才安装中间件，空字典不会安装。
			if (customHeaders) {
				// build阶段写允许的头，auth/host/x-amz-*会跳过。
				addCustomHeadersMiddleware(client, customHeaders);
			}
			// 显式缓存偏好优先，否则环境long，再默认short。
			const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
			// 原生maxTokens显式优先；未传仅Claude补模型上限，其他模型可省略maxTokens。
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			// 折叠后首system已包含全部当前系统变更。
			const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
			// 渲染首system文字/sections；无首system保持undefined。
			const initialSystemPrompt = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : undefined;
			// 用于严格prefer工具限额时最多降级一次，require工具不随之关闭strict。
			let disablePreferredStrictTools = false;
			// SDK请求输出变量等send成功后赋值。
			let response: ConverseStreamCommandOutput;
			// 无显式循环条件；正常break，严格prefer限额失败最多继续一次，否则抛错。
			for (;;) {
				// 每次尝试重新转换工具，不能直接复用第一次严格schema。
				const tools = convertToolConfig(
					// 从折叠轨迹得到当前工具声明，非全部历史工具。
					getCurrentTools(normalizedContext.messages),
					// 工具选择none可整体省略toolConfig。
					options.toolChoice,
					// 用模型strict能力决定prefer/require处理。
					supportsStrictMode,
					// 第二次尝试禁用prefer的strict，require保持其规则。
					disablePreferredStrictTools,
				);
				// 每次重建SDK命令输入，payload钩子也会再执行。
				let commandInput = {
					// 发送模型id或ARN原字符串。
					modelId: model.id,
					// 历史转换含跨模型处理、工具结果归并、可选缓存点。
					messages: convertMessages(normalizedContext, model, cacheRetention, options.env),
					// system独立放顶层，支持缓存且启用时可追加系统缓存点。
					system: buildSystemPrompt(initialSystemPrompt, model, cacheRetention, options.env),
					// 基础推理配置对象，不等于把所有samplingParams展开进去。
					inferenceConfig: {
						// 条件展开仅undefined省略，0也会原样发送，不在此做范围验证。
						...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
						// 同理temperature=0保留。
						...(options.temperature !== undefined && { temperature: options.temperature }),
					},
					// 使用当前尝试转换后的工具配置。
					toolConfig: tools.toolConfig,
					// 模型专属思考字段，Claude与OpenAI/GPT-OSS结构不同。
					additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
					// 仅专用requestMetadata非undefined才附加，原对象引用透传，不自动验证长度。
					...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
				};
				// 等待payload钩子，可改对象、返回替代值或抛错；重建请求时会重新调用。
				const nextCommandInput = await options?.onPayload?.(commandInput, model);
				// 只有非undefined返回才整体替换，undefined保留原地修改。
				if (nextCommandInput !== undefined) {
					// typeof在类型位置取原对象类型，as不做wire校验或恢复默认字段。
					commandInput = nextCommandInput as typeof commandInput;
				}
				// 只围client.send的catch处理严格工具限额，构建/钩子错误不进该专用恢复分支。
				try {
					// SDK负责序列化/认证/请求/事件流解码；这里只传用户abortSignal，未映射options.fetch/timeoutMs/maxRetries到SDK配置。
					response = await client.send(new ConverseStreamCommand(commandInput), { abortSignal: options.signal });
					// 拿到SDK响应后退出重建循环，不等待模型事件全部完成。
					break;
					// 这里只接send阶段拒绝；后面的流事件异常不会回到这个循环。
				} catch (error) {
					// Bedrock checks the tool schemas before it starts the stream, so a retry never repeats streamed output.
					// 任一排除条件成立就保持原错误，不做prefer降级。
					if (
						// 用户已取消不再重建请求。
						options.signal?.aborted ||
						// 已降级过不再第二次恢复。
						disablePreferredStrictTools ||
						// 没真正启用prefer strict工具时无可降级项。
						!tools.hasPreferredStrictTools ||
						// 必须是实际SDK服务异常实例，不仅检查同名字段。
						!(error instanceof BedrockRuntimeServiceException) ||
						// 仅精确ValidationException可进入该恢复。
						error.name !== "ValidationException" ||
						// 还必须含已知strict工具总量/grammar编译限制文案。
						!isStrictToolLimitErrorMessage(error.message)
					) {
						// 其余错误交外层失败流，不自建通用重试；SDK自身重试策略另算。
						throw error;
					}
					// 设标记，下一轮只让prefer工具回非严格声明。
					disablePreferredStrictTools = true;
					// 记录这次降级发生，不把它算已生成模型内容。
					appendAssistantMessageDiagnostic(output, {
						// 固定诊断类型。
						type: "bedrock_strict_tools_fallback",
						// 本地发生时间。
						timestamp: Date.now(),
						// 保留SDK错误说明，不在此自动脱敏。
						error: { message: error.message },
						// 结构化记录降级原因。
						details: { reason: "strict_tool_limits_exceeded" },
					});
				}
			}
			// 将请求id trim并限200码元；太长/空/非string则无回退id。
			responseRequestId = normalizeDiagnosticValue(response.$metadata.requestId);
			// 原始HTTP没被观察且SDK有状态时，补一次精简响应信息；有onResponse才实际调用。
			if (!observedRawResponse && response.$metadata.httpStatusCode !== undefined) {
				// 新头字典只准备已知requestId，不凭空恢复全部网关头。
				const responseHeaders: Record<string, string> = {};
				// 原始requestId有真值时才加头，不使用前面的限长诊断值。
				if (response.$metadata.requestId) {
					// 用标准AWS请求id头名携带原始元数据值。
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				// 等待响应钩子；此处异常进入外层失败，不进入前面的strict降级循环。
				await options?.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, model);
			}

			// 顺序消费SDK异步事件，!只消除TS的可选类型，缺stream真实运行仍会报错。
			for await (const item of response.stream!) {
				// 每个原SDK事件先给观察钩子并await，之后按可能被原地修改的事件处理；异常直接失败。
				await options.onProviderStreamEvent?.(item, model);
				// messageStart分支先检查角色，不由HTTP成功自动发start。
				if (item.messageStart) {
					// 非assistant角色（含缺省值）视为错误。
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						// 抛固定说明，尽管实际异常角色不一定真为user。
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
					// 每条有效messageStart都发start，这里没有整轮去重标记。
					stream.push({ type: "start", partial: output });
					// 内容块开始事件只由对应helper接管。
				} else if (item.contentBlockStart) {
					// 当前只建立工具调用块，其他start成员不会建块。
					handleContentBlockStart(item.contentBlockStart, openBlocks, output, stream);
					// 内容增量可懒建立文字/思考块。
				} else if (item.contentBlockDelta) {
					// 委托helper按网络索引找本地content位置并发相应delta。
					handleContentBlockDelta(item.contentBlockDelta, openBlocks, output, stream);
					// 内容块结束与messageStop分开处理。
				} else if (item.contentBlockStop) {
					// 结束工具时做最终参数解析，思考时合并redacted字节，随后发块end。
					handleContentBlockStop(item.contentBlockStop, openBlocks, output, stream);
					// 整条消息停止事件更新原因，但仍继续读后续usage metadata直到流结束。
				} else if (item.messageStop) {
					// 原始停止原因单独保存，不用统一reason覆盖它。
					output.rawStopReason = item.messageStop.stopReason;
					// AWS原因映射为统一停止状态与可选说明。
					const { stopReason, errorMessage } = mapStopReason(item.messageStop.stopReason);
					// 写本轮停止状态，工具调用还需上层实际执行。
					output.stopReason = stopReason;
					// 仅有真值错误说明时赋值，不主动删除已有errorMessage。
					if (errorMessage) {
						// 原地保存供应商停止错误。
						output.errorMessage = errorMessage;
					}
					// 元数据事件不作为可见文字块。
				} else if (item.metadata) {
					// 使用usage更新计数并按目录估价，忽略其他trace/性能字段。
					handleMetadata(item.metadata, model, output);
					// 以下各SDK错误成员直接抛原值，未强制包装成Error。
				} else if (item.internalServerException) {
					// 内部服务错误中断本轮流。
					throw item.internalServerException;
					// 模型流错误同样直接传播。
				} else if (item.modelStreamErrorException) {
					// 抛模型流错误值。
					throw item.modelStreamErrorException;
					// 流内验证错误不走send阶段的strict prefer恢复。
				} else if (item.validationException) {
					// 抛流内验证错误。
					throw item.validationException;
					// 流内限流由外层报错，未在本文件重新发送已消费正文。
				} else if (item.throttlingException) {
					// 抛限流值。
					throw item.throttlingException;
					// 服务不可用异常成员。
				} else if (item.serviceUnavailableException) {
					// 抛原异常；未识别事件成员会自然跳过，不新增音频/图像输出支持。
					throw item.serviceUnavailableException;
				}
			}

			// SDK流结束后再次检查用户取消。
			if (options.signal?.aborted) {
				// 已取消不发done，转外层aborted。
				throw new Error("Request was aborted");
			}

			// 没messageStop有效状态就不把EOF当成功。
			if (output.stopReason === "pending") {
				// 缺停止原因以失败结束。
				throw new Error("Bedrock stream ended without a stop reason");
			}
			// 已明确error/aborted也不发成功done。
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				// 有错误说明优先，否则固定未知错误。
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// A stream can settle without stopping every block, so finalize here too.
			// 清临时Map并合并尚未停止的redacted字节；不替缺stop工具调用做finish或补发所有块end。
			flushOpenBlocks(openBlocks, output);
			// 发布统一done，reason可能stop/length/toolUse，不等于整个Agent任务完成。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			// 结束Pi事件通道。
			stream.end();
			// 主try失败保留已收partial，转统一error事件；前面的配置异常不在此覆盖范围。
		} catch (error) {
			// 同样合并redacted字节并清临时Map，不回滚已有内容。
			flushOpenBlocks(openBlocks, output);
			// 只按用户signal当前状态分aborted/error，错误名字本身不决定aborted。
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			// 用兼容前缀和规范错误正文格式化，不在此保证所有错误文字脱敏。
			output.errorMessage = formatBedrockError(error);
			// 仅error记录失败元数据诊断，用户取消不追加这一诊断。
			if (output.stopReason === "error") {
				// 从SDK异常/已收到的请求id提有限字段；没有字段就不生成诊断。
				appendBedrockFailureDiagnostic(output, error, responseRequestId);
			}
			// 失败流保留整条共享assistant及此前内容。
			stream.push({ type: "error", reason: output.stopReason, error: output });
			// 关闭本地失败通道；若清理/格式化本身再次抛错则走不到这里。
			stream.end();
		}
		// 调用异步闭包启动任务，其Promise不作为公开返回值。
	})();

	// 同步把本地事件通道交调用者。
	return stream;
};

/**
 * Human-readable prefixes for Bedrock SDK exception names.
 * The downstream retry logic in agent-session matches patterns like
 * `server.?error` and `service.?unavailable`, so we preserve the legacy
 * prefix format rather than using the raw SDK exception name.
 */
// SDK异常name→稳定可读前缀字典，供上层文字分类，不在此启动重试。
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	// 内部服务错误对应前缀。
	InternalServerException: "Internal server error",
	// 模型流错误对应前缀。
	ModelStreamErrorException: "Model stream error",
	// 验证失败对应前缀。
	ValidationException: "Validation error",
	// 限流对应前缀。
	ThrottlingException: "Throttling error",
	// 服务不可用对应前缀。
	ServiceUnavailableException: "Service unavailable",
};

/**
 * Some models reject the account/profile's configured Bedrock data retention mode
 * (e.g. "data retention mode 'default' is not available for this model"). Point
 * users at the AWS docs explaining how to configure a supported mode.
 */
// 遇data retention mode错误时附此静态文档地址，不自动修改AWS账号配置。
const BEDROCK_DATA_RETENTION_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

/**
 * Format a Bedrock error with a human-readable prefix.
 * AWS SDK exceptions (both from `client.send()` and from stream event items)
 * extend BedrockRuntimeServiceException. We map the `.name` to a stable
 * human-readable prefix so downstream consumers (retry logic, context-overflow
 * detection) can distinguish error categories via simple string matching.
 */
/**
 * 将unknown异常转可读文字，返回string，不修改原异常、不重试请求。
 * 先规范化正文/状态，再按SDK服务异常name加稳定前缀，匹配数据保留错误时附文档；例网关403正文可显示“403: ...”，不是仅Unknown。字串格式化本身仍可能抛错，不承诺自动脱敏。
 */
// 输入任意异常，返回兼容上层文字分类的错误说明，不请求AWS或修改原异常。
function formatBedrockError(error: unknown): string {
	// 规范错误文字、状态与正文；并非所有异常都必须是Error实例。
	const norm = normalizeProviderError(error);
	// Surface the raw HTTP body (with status) when the SDK did not fold it into
	// the message; otherwise fall back to the message. This is what stops a
	// gateway 403 from collapsing to `Unknown: UnknownError`.
	// 选择核心错误说明，不把同一正文再附两次。
	const core =
		// 文字尚未带正文且状态/正文都非undefined才显示HTTP正文。
		!norm.messageCarriesBody && norm.status !== undefined && norm.body !== undefined
			? // 用状态码和正文拼接，有空正文也仍符合非undefined条件。
				`${norm.status}: ${norm.body}`
			: // 否则使用规范错误message。
				norm.message;
	// 大小写不敏感匹配data retention mode子串。
	const dataRetentionHint = /data retention mode/i.test(core)
		? // 命中时只追加文档提示，不自动修改AWS数据保留策略。
			` See ${BEDROCK_DATA_RETENTION_DOCS_URL} for supported data retention modes.`
		: // 其他错误不附该提示。
			"";
	// 仅真实SDK服务异常加按name映射的前缀。
	if (error instanceof BedrockRuntimeServiceException) {
		// 字典没对应值就用原错误name，不仅限已知五种错误。
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		// 拼前缀、核心文字与可选文档提示。
		return `${prefix}: ${core}${dataRetentionHint}`;
	}
	// 普通Error或抛出对象只用核心文字和提示，不假造SDK前缀。
	return `${core}${dataRetentionHint}`;
}

// 宽松元数据视图允许字段unknown，as不验证真实抛出值形状。
type SdkErrorMetadata = { $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };

/** Over-long header values are dropped rather than truncated: a truncated request id is not a request id. */
// 诊断字符串长度按JS UTF-16码元计，最多200；过长丢弃而非截成可能错误的requestId。
const MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS = 200;

/**
 * 从未知值保留trim后非空且不超200码元的字符串，返回string|undefined，无外部修改。
 * 例“ req-1 ”变“req-1”，201码元被整个丢弃，不截断成另一个看似可用id；并不验证AWS请求id格式。
 */
// 规范未知诊断值为短非空字符串或undefined，不改变原值。
function normalizeDiagnosticValue(value: unknown): string | undefined {
	// 非string不自动String化，直接省略。
	if (typeof value !== "string") return undefined;
	// trim去两端空白，返回值可能与原头文字不同。
	const trimmed = value.trim();
	// trim后空或超过200码元直接省略，不校验requestId的具体格式。
	if (trimmed.length === 0 || trimmed.length > MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS) return undefined;
	// 原样返回trim后的合法长度文字。
	return trimmed;
}

/**
 * The SDK puts the modeled code on `error.name` for service exceptions and unmodeled stream errors alike, so
 * do not narrow to `BedrockRuntimeServiceException`. Modeled Bedrock errors all end in `Exception`, unlike
 * transport names such as `TimeoutError`.
 */
/**
 * 按Error实例与name的Exception后缀提诊断code，再应用短字符串规则，无I/O。
 * 例ModelStreamErrorException可保留，TimeoutError或裸{message:...}不保留；这只是后缀启发式，非完整AWS错误码认证。
 */
// 取可用的异常code文字，实际依赖Error.name的Exception后缀，不完整验证AWS错误码。
function extractBedrockErrorCode(error: unknown): string | undefined {
	// 必须为Error实例且name精确以Exception结尾；普通对象即使有同名字段也不通过。
	if (!(error instanceof Error) || !error.name.endsWith("Exception")) return undefined;
	// 再应用trim/长度规则，非SDK Error也可能通过后缀启发式。
	return normalizeDiagnosticValue(error.name);
}

/**
 * Structured metadata alongside `errorMessage`, which stays byte-identical because `isRetryableAssistantError`
 * matches against it. Unknown fields are omitted, never guessed: a modeled mid-stream exception reaches us as
 * a bare object literal, leaving only `fallbackRequestId`. `details` only, as the throw is not always `Error`.
 */
/**
 * 从失败异常及回退requestId提status/errorCode/requestId，返回void，按需追加output.diagnostics，不改errorMessage。
 * 例流中抛裸对象但此前HTTP有id时只记requestId；未知字段省略，三项全无时不记空诊断。status只检查number类型，不验证HTTP范围。
 */
// 给失败消息追加有限元数据诊断，只有能取到字段才追加。
function appendBedrockFailureDiagnostic(
	// 诊断写入此共享assistant，不改其errorMessage。
	output: AssistantMessage,
	// 原始抛出值可不是Error。
	error: unknown,
	// send成功后曾取得的requestId，当前错误没有id时回退使用。
	fallbackRequestId: string | undefined,
	// 返回void，副作用是可能追加output.diagnostics。
): void {
	// 可选链容忍null/undefined；as只允许TS读$metadata，没有完整runtime验证。
	const metadata = (error as SdkErrorMetadata)?.$metadata;
	// 新建JSON details字典，未知字段不随意复制进去。
	const details: JsonObject = {};

	// 状态只检查typeof number，未验证有限值或标准HTTP状态范围。
	if (typeof metadata?.httpStatusCode === "number") details.status = metadata.httpStatusCode;

	// 从Error.name后缀启发式提code，裸流错误对象可能没有可提取code。
	const errorCode = extractBedrockErrorCode(error);
	// 非undefined才附errorCode。
	if (errorCode !== undefined) details.errorCode = errorCode;

	// 错误本身有效requestId优先，其次已收到HTTP响应的回退id。
	const requestId = normalizeDiagnosticValue(metadata?.requestId) ?? fallbackRequestId;
	// 可用id才附字段，不猜造新id。
	if (requestId !== undefined) details.requestId = requestId;

	// 没任何details就不追加空诊断。
	if (Object.keys(details).length === 0) return;

	// 追加固定类型/本地时间/details，不把任意原异常对象塞进诊断。
	appendAssistantMessageDiagnostic(output, { type: "bedrock_response_failure", timestamp: Date.now(), details });
}

/**
 * Header keys that must never be overwritten by caller-supplied headers.
 * `host` and `x-amz-*` participate in the SigV4 canonical request; `authorization`
 * is owned by SigV4 or the bearer-token path (config.token + authSchemePreference).
 * Compared case-insensitively (caller key is lower-cased before lookup).
 */
// auth与host精确保留名单；另有前缀x-amz-*规则。
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

/**
 * 对头名做大小写不敏感保留判断，返回boolean，无修改；例X-Amz-Date、HOST被跳过，x-custom可注入。
 * 这里只处理本中间件调用者头权限，不验证所有HTTP头名/值或控制SDK之后的行为。
 */
// 判断请求头名是否被本适配器保留，返回boolean，不修改头。
function isReservedHeader(key: string): boolean {
	// 小写化只用于判断，不改变原传入key。
	const lower = key.toLowerCase();
	// x-amz-前缀或authorization/host任一命中就跳过调用者覆盖。
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * The client identity as AWS SDK user agent pairs. The SDK appends them to its own `User-Agent` and escapes characters
 * that are not valid in a user agent token, so the detailed form is reduced to name and version.
 */
/**
 * 把客户端身份转为AWS SDK customUserAgent表示，输入可选identity，输出自定义字符串或名称/版本元组数组，无网络。
 * 例short→[["pi"]]，缺省detailed→[["pi",版本]]；这里只构建额外UA片段，SDK再合入自己的UA，不生成通用供应商归因头。
 */
// 身份转换为AWS SDK自定义UA字符串或名称/可选版本二元组数组，不发网络。
function bedrockUserAgent(identity: ClientIdentity | undefined): string | [string, string?][] {
	// 未指定模式取detailed；??只回退null/undefined。
	const mode = identity?.userAgent ?? "detailed";
	// 合法对象模式含custom字符串，直接返回，由SDK处理UA格式。
	if (typeof mode === "object") return mode.custom;
	// short只附pi名字，其他合法模式附pi与版本；[string,string?][]表示每项第二元素可选。
	return mode === "short" ? [["pi"]] : [["pi", getClientVersion(identity)]];
}

/**
 * Attach caller-supplied headers to the outgoing Bedrock request via a Smithy
 * `build`-step middleware. The `build` step runs after request serialisation but
 * before SigV4 signing, so injected headers are covered by the signature. Reserved
 * SigV4 / auth headers (`x-amz-*`, `authorization`, `host`) are silently skipped;
 * all other caller headers override any existing same-named header on the request.
 */
/**
 * 给客户端安装build阶段头注入中间件，输入client和已合并普通头，返回void并修改中间件栈。
 * 例x-custom写进请求头，authorization/host/x-amz-*静默跳过；写字典保留原拼写，不主动删除既有不同大小写键，最终HTTP处理仍由SDK负责。
 */
// 在客户端注册build中间件，返回void；实际请求到build阶段才注入头。
function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	/**
	 * 中间件工厂接next并返回async handler；handler接本次args，检查request有headers后注入允许项，再返回next结果。
	 * 会原地写request.headers，例同精确key旧值被覆盖；异常不吞，await链后续签名/网络拒绝仍向上传。
	 */
	// 两层箭头：外层接next生成异步handler，内层接本次args并返回后续链的Promise。
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		// 取得序列化阶段留下的request，类型边界不是浏览器Request。
		const request = args.request;
		// 仅做真值对象及headers键存在检查，没有验证headers每个字段。
		if (request && typeof request === "object" && "headers" in request) {
			// as为访问普通头字典提供静态视图，不创建Headers或大小写归一化。
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			// 逐调用者字典项注入，保留当前key原拼写。
			for (const [key, value] of Object.entries(headers)) {
				// 保留头静默跳过，其余可写。
				if (!isReservedHeader(key)) {
					// 用JS字典精确key赋值；不同大小写的既有键未在此先删，不能保证总按HTTP同名规范合并。
					requestHeaders[key] = value;
				}
			}
		}
		// 返回next(args)的Promise，让SDK继续签名/发送；没有吞后续拒绝。
		return next(args);
	};
	// 注册build低优先级中间件，在签名阶段之前；具体签名头选择仍由SDK负责。
	client.middlewareStack.add(middleware, { step: "build", name: "pi-ai-custom-headers", priority: "low" });
}

/**
 * 检查未知响应最小形状并返回类型谓词，供TS收窄，不修改输入。
 * 例{statusCode:200,headers:{}}通过，null失败；只查数字状态与真值对象头，未验证头值、状态范围、body或完整Smithy接口。
 */
// 运行时识别可供响应钩子使用的最小HTTP形状，并用类型谓词让TS收窄。
function isSmithyHttpResponse(response: unknown): response is HttpResponse {
	// null/undefined/非对象都拒绝。
	if (!response || typeof response !== "object") return false;
	// Partial只让各字段静态可缺，不执行校验。
	const candidate = response as Partial<HttpResponse>;
	// 仅要求数字statusCode和真值对象headers，未逐项验头值或验证完整HttpResponse接口。
	return typeof candidate.statusCode === "number" && !!candidate.headers && typeof candidate.headers === "object";
}

/**
 * 从未知HTTP响应取统一状态/头浅副本，返回ProviderResponse或undefined，无body消费。
 * 例原headers有网关x-route就一起复制；不保证这是完整schema验证，也不把标准Headers对象转换作为这里的契约。
 */
// 把未知Smithy响应转换为统一状态/头对象，失败返回undefined。
function toProviderResponse(response: unknown): ProviderResponse | undefined {
	// 最小形状检查不通过就不通知原始响应观察。
	if (!isSmithyHttpResponse(response)) return undefined;
	// 复制头字典，保留名称/值原表示，不把body暴露给钩子。
	return { status: response.statusCode, headers: { ...response.headers } };
}

/**
 * Bedrock's modeled `$metadata` only preserves selected HTTP metadata (for example
 * requestId), so custom gateway headers are otherwise lost before callers see
 * `onResponse`. Capture the raw Smithy HTTP response at the deserialize step,
 * after the SDK receives the response but before the event stream is consumed.
 */
/**
 * 在客户端安装响应头观察中间件，输入用户onResponse、模型和内部已观察回调，返回void，修改中间件栈。
 * next成功返回且有最小HTTP形状才先通知onObserved，再await用户钩子；例网关自定义头可在模型事件消费前交给上层。next拒绝不在此捕获，不保证每个失败响应都调用。
 */
// 安装deserialize中间件，返回void；实际响应经过时才触发回调。
function addResponseHeadersMiddleware(
	// 目标客户端的中间件栈会被修改。
	client: BedrockRuntimeClient,
	// NonNullable去掉可选钩子的undefined/null类型，不做运行时存在检查。
	onResponse: NonNullable<BedrockOptions["onResponse"]>,
	// 模型身份交用户钩子。
	model: Model<"bedrock-converse-stream">,
	// 零参数回调通知主入口“已观察原始响应”，与用户钩子分开。
	onObserved: () => void,
	// 注册动作没有返回响应数据。
): void {
	/**
	 * 中间件工厂返回本次响应处理async函数，输入next/args，返回原result，可能调用两个回调。
	 * 例onResponse拒绝时整个handler拒绝，原始模型流尚未由主入口消费；无可识别response时原样返回，不构造假头。
	 */
	// 外层中间件工厂接next，返回处理本次args的异步函数。
	const middleware: DeserializeMiddleware<object, MetadataBearer> = (next) => async (args) => {
		// 先等下游返回；若next拒绝，这里不捕获，也不保证每个失败HTTP响应都会回调。
		const result = await next(args);
		// 对返回的response做有限形状转换，不消费事件流body。
		const providerResponse = toProviderResponse(result.response);
		// 有可用状态/头才标记并通知。
		if (providerResponse) {
			// 先设置已观察标记，再等待用户钩子，避免精简元数据补发。
			onObserved();
			// await保证用户回调结算后才继续返回；抛错让当前SDK调用拒绝，不被静默忽略。
			await onResponse(providerResponse, model);
		}
		// 原结果整体返回SDK，不用统一响应对象替换它。
		return result;
	};
	// 按固定名称注册deserialize阶段中间件，没有在此发送请求或缓存响应。
	client.middlewareStack.add(middleware, { step: "deserialize", name: "pi-ai-response-headers" });
}

/**
 * 公共简化选项转Bedrock原生stream，输入模型/完整轨迹/选项，同步返回事件通道，预算转换错误可同步抛。
 * 基础helper估算maxTokens；Claude adaptive直接传effort，固定预算Claude先加思考预算再按上下文收紧，并压思考预算给正文留空间；其他模型直接透传reasoning。
 * 例xhigh固定预算按high查表；极小总上限只能把正常非负思考预算压0，不能保证仍有1024正文空间。基础字段透传不等于Bedrock专属region/profile/requestMetadata都能从简化入口保留。
 */
// 简化入口返回事件通道；同步预算/配置转换可抛，网络由原生stream推进。
export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	// 输入Bedrock模型能力及预算信息。
	model: Model<"bedrock-converse-stream">,
	// 完整规范上下文参与输出预算估算。
	context: TranscriptContext,
	// 公共简化配置可整体省略，不包含所有Bedrock专属字段。
	options?: SimpleStreamOptions,
	// 同步返回Pi通道，不是async函数。
): AssistantMessageEventStream => {
	// 新建基础配置，后面按模型思考策略覆盖部分字段。
	const base = {
		// 复制选定公共字段并按上下文钳制maxTokens；undefined key参数仍可回退options.apiKey。
		...buildBaseOptions(model, context, options, undefined),
		// 工具选择单独复制，基础helper没有该字段。
		toolChoice: options?.toolChoice,
		// satisfies只作编译期兼容检查，不改对象或添加默认值。
	} satisfies BedrockOptions;
	// 未请求reasoning时不做思考预算调整。
	if (!options?.reasoning) {
		// 显式reasoning:undefined交原生入口，未在此发送关闭思考专用wire字段。
		return stream(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	// Claude根据id/name本地识别，不向AWS探测。
	if (isAnthropicClaudeModel(model)) {
		// adaptive候选用effort路径，不按固定思考token预算额外加输出空间。
		if (supportsAdaptiveThinking(model.id, model.name)) {
			// 直接调用原生入口，返回同一事件通道。
			return stream(model, context, {
				// 先复制基础字段。
				...base,
				// 思考级别原样交下层映射，未在这里按model.thinkingLevelMap排除null档位。
				reasoning: options.reasoning,
				// 自定义预算也透传，但adaptive构建不读取budget_tokens。
				thinkingBudgets: options.thinkingBudgets,
				// 静态检查对象为BedrockOptions，运行值不变。
			} satisfies BedrockOptions);
		}

		// Undefined means the caller did not request an output cap; let the helper use the model cap.
		// Do not coerce to 0 here, or the thinking budget would become the entire maxTokens value.
		// 固定预算Claude先协调思考与正文输出上限；下面实际传的是base.maxTokens，不是原options.maxTokens。
		const adjusted = adjustMaxTokensForThinking(
			// buildBaseOptions通常已经给数值并按上下文钳制，因此“helper接受undefined”的原英语不等于本调用必传undefined。
			base.maxTokens,
			// 模型最大输出上限限制总预算。
			model.maxTokens,
			// xhigh/max由helper按high token预算处理。
			options.reasoning,
			// 合并自定义四档预算。
			options.thinkingBudgets,
		);

		// 调整后的输出上限再次按当前上下文估值限制，不保证实际tokenizer绝不溢出。
		const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

		// 将最终总上限与思考预算交原生入口。
		return stream(model, context, {
			// 复制基础配置，下面maxTokens覆盖旧值。
			...base,
			// 属性简写传最终上限。
			maxTokens,
			// 保留请求reasoning档位供原生模型字段转换。
			reasoning: options.reasoning,
			// 创建预算表副本，仅覆盖本次实际预算档。
			thinkingBudgets: {
				// 先保留其他自定义档位，不修改调用者原表。
				...(options.thinkingBudgets || {}),
				// 计算属性名把xhigh/max归high；!仅去TS可选类型，预算压到maxTokens-1024的非负空间内，极小总上限不能保证仍有1024回答token。
				[clampReasoning(options.reasoning)!]: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
			},
			// satisfies检查最后选项形状，不做实际数值/模型能力验证。
		} satisfies BedrockOptions);
	}

	// 非Claude思考模型不走Claude共享预算额外调整。
	return stream(model, context, {
		// 复制公共基础配置。
		...base,
		// 原样传reasoning，下层按GPT/GPT-OSS等本地识别规则构建。
		reasoning: options.reasoning,
		// 预算表虽透传，非Claude分支当前并不读取它。
		thinkingBudgets: options.thinkingBudgets,
		// 静态类型检查后调用stream，不额外异步包装通道。
	} satisfies BedrockOptions);
};

/**
 * 只处理toolUse块开始，输入SDK事件、临时Map、output与Pi通道，返回void并追加工具块/解析器，发布toolcall_start。
 * 例网络索引7可能映到output.content[0]，两种索引不等价；不会执行工具，缺id/name按空串，索引!不做运行时验证。
 */
// 处理块开始事件，仅建立toolUse，不主动执行工具。
function handleContentBlockStart(
	// SDK事件的start可undefined，工具id/name也可undefined。
	event: ContentBlockStartEvent,
	// 网络索引到临时状态的Map将被修改。
	openBlocks: OpenBlocks,
	// 统一输出content将被追加。
	output: AssistantMessage,
	// Pi通道用于发布toolcall_start。
	stream: AssistantMessageEventStream,
	// 返回void，数据通过共享对象/事件发布。
): void {
	// 取可选开始内容；不是文字增量本身。
	const start = event.start;

	// 只有toolUse成员才建立内容块，图片等其他start在此忽略。
	if (start?.toolUse) {
		// 追加新工具调用对象。
		output.content.push({
			// 统一块标签toolCall。
			type: "toolCall",
			// id假值回空串，不生成随机id或验证格式。
			id: start.toolUse.toolUseId || "",
			// 工具名假值同样回空串。
			name: start.toolUse.name || "",
			// 初始参数为空对象，后面append提供增量预览。
			arguments: {},
		});
		// 本地内容索引由追加后的数组位置决定，未假设等于AWS网络索引。
		const contentIndex = output.content.length - 1;
		// 按网络索引登记工具解析器；!不会检查缺失索引，异常SDK数据仍可能以undefined作Map键。
		openBlocks.set(event.contentBlockIndex!, { contentIndex, arguments: new ToolCallArgumentsStream() });
		// 发工具块开始事件，partial是共享output引用。
		stream.push({ type: "toolcall_start", contentIndex, partial: output });
	}
}

/**
 * 把SDK单个块增量转为Pi文字、工具参数或思考增量，原地改output/Map并发start/delta，无独立返回值。
 * 文字/思考缺状态时懒建立，工具参数必须已有start建立的解析器；例input分两次{"path":"和a"}时append生成预览，最终还要块结束finish。
 * 普通signature拼接，加密redacted字节独立暂存、首次追加占位并清普通签名；不解密，不支持的SDK图片/引用等增量在这里忽略。
 */
// 处理SDK文字/工具/思考增量，原地写对应内容并发Pi delta，不处理未支持的其他成员。
function handleContentBlockDelta(
	// 输入增量事件含网络索引与可选delta。
	event: ContentBlockDeltaEvent,
	// 临时Map负责关联不同网络块。
	openBlocks: OpenBlocks,
	// 输出块可被追加/修改。
	output: AssistantMessage,
	// Pi通道接收块start/delta。
	stream: AssistantMessageEventStream,
	// 返回void，不返回新消息。
): void {
	// 非空断言只影响TS，运行值仍原样取索引。
	const contentBlockIndex = event.contentBlockIndex!;
	// 取可选delta，后面按联合成员分流。
	const delta = event.delta;
	// 查当前网络块临时状态；let允许第一次增量时新建。
	let open = openBlocks.get(contentBlockIndex);
	// 有状态才用本地contentIndex读块，缺状态时先undefined。
	let block = open === undefined ? undefined : output.content[open.contentIndex];

	// 文字用!==undefined判断，空字符串delta也可进入并发布。
	if (delta?.text !== undefined) {
		// If no text block exists yet, create one, as `handleContentBlockStart` is not sent for text blocks
		// 尚无对应状态才懒建立文字块。
		if (!open) {
			// 文字块初始空正文。
			output.content.push({ type: "text", text: "" });
			// 记录新本地内容位置。
			open = { contentIndex: output.content.length - 1 };
			// 把网络索引关联到此本地状态。
			openBlocks.set(contentBlockIndex, open);
			// 读取新块供下面统一更新。
			block = output.content[open.contentIndex];
			// 先发text_start，再处理本次文字delta。
			stream.push({ type: "text_start", contentIndex: open.contentIndex, partial: output });
		}
		// 只有现有块真为text才追加；类型冲突不在此替换成另一种块。
		if (block?.type === "text") {
			// +=原地累计文字。
			block.text += delta.text;
			// 发本次原始文字增量与同一partial对象。
			stream.push({ type: "text_delta", contentIndex: open.contentIndex, delta: delta.text, partial: output });
		}
		// 工具增量必须已有toolCall块与解析器，未先收到toolUse start的增量不会自行补工具块。
	} else if (delta?.toolUse && block?.type === "toolCall" && open?.arguments !== undefined) {
		// append只喂新片段并返回当前参数对象预览，不在每个delta重新解析全文。
		block.arguments = open.arguments.append(delta.toolUse.input || "");
		// 发工具参数增量，最终参数是否完整要等块结束finish。
		stream.push({
			// 事件标签toolcall_delta。
			type: "toolcall_delta",
			// 使用本地内容索引。
			contentIndex: open.contentIndex,
			// 参数input假值按空串处理，事件delta保留本次片段。
			delta: delta.toolUse.input || "",
			// partial仍是共享output引用。
			partial: output,
		});
		// 思考成员另走懒建立路径，包括仅signature或redacted字节的事件。
	} else if (delta?.reasoningContent) {
		// 缺本网络块状态才建立thinking。
		if (!open) {
			// 初始思考正文/签名均空串。
			output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
			// 保存本地content索引。
			open = { contentIndex: output.content.length - 1 };
			// 登记到当前网络索引。
			openBlocks.set(contentBlockIndex, open);
			// 取得新思考块引用。
			block = output.content[open.contentIndex];
			// 发布thinking_start。
			stream.push({ type: "thinking_start", contentIndex: open.contentIndex, partial: output });
		}

		// 只在当前块为thinking时处理，错误索引对应其他块则忽略这段思考。
		if (block?.type === "thinking") {
			// 本地索引供思考事件复用。
			const thinkingIndex = open.contentIndex;
			// 思考text按真值判断，空串不会发thinking_delta。
			if (delta.reasoningContent.text) {
				// 累计可读思考，不把signature当文字。
				block.thinking += delta.reasoningContent.text;
				// 发本次可读思考增量。
				stream.push({
					// 事件标签thinking_delta。
					type: "thinking_delta",
					// 指定对应本地块位置。
					contentIndex: thinkingIndex,
					// 仅本次新增思考文字。
					delta: delta.reasoningContent.text,
					// 共享partial消息。
					partial: output,
				});
			}
			// `thinkingSignature` holds either an Anthropic signature or an opaque redacted
			// payload, never both: mixing them would corrupt whichever arrived first.
			// 只在未标redacted时追加普通signature，防它与加密载荷混用。
			if (delta.reasoningContent.signature && !block.redacted) {
				// 片段拼接到thinkingSignature，不做本地验签。
				block.thinkingSignature = (block.thinkingSignature || "") + delta.reasoningContent.signature;
			}
			// 只有非空redacted字节才进入加密思考路径。
			if (delta.reasoningContent.redactedContent?.length) {
				// Encrypted reasoning from non-Anthropic models on Bedrock (e.g. OpenAI GPT-5.6).
				// The payload is opaque, so keep it verbatim in `thinkingSignature` the way the
				// Anthropic path stores redacted thinking, and replay it on the next turn.
				// 首次redacted设置标记与固定占位，后续字节不反复追加占位。
				if (!block.redacted) {
					// 标记该块签名字段后续承载opaque加密载荷。
					block.redacted = true;
					// 清可能先到的普通signature，避免两种表示混拼。
					block.thinkingSignature = "";
					// 正文追加一次固定占位，已有可读思考不在此删除。
					block.thinking += REDACTED_THINKING_PLACEHOLDER;
					// 通过思考delta通知占位出现，不展示加密字节。
					stream.push({
						// thinking_delta标签。
						type: "thinking_delta",
						// 对应本地思考索引。
						contentIndex: thinkingIndex,
						// 只发固定占位文字。
						delta: REDACTED_THINKING_PLACEHOLDER,
						// 共享partial引用。
						partial: output,
					});
				}
				// ??=仅在redactedChunks为null/undefined时创建数组，已有数组继续使用。
				open.redactedChunks ??= [];
				// 暂存字节块引用，不在每个增量上全量base64重编码。
				open.redactedChunks.push(delta.reasoningContent.redactedContent);
			}
		}
	}
}

/**
 * Encodes buffered encrypted reasoning into `thinkingSignature`. The chunks stay in the stream state, never on the
 * block: `Uint8Array` is not JSON and serializes to an index-keyed object roughly ten times the size of the base64
 * payload.
 */
/**
 * 把一块临时redacted字节按顺序编码到thinkingSignature，输入OpenBlock与output，返回void，清该字节数组引用。
 * 例[1,2]+[3]编码AQID，只有thinking且有暂存数组才处理；不发thinking_end、不解密，编码异常仍可向上传。
 */
// 把临时加密字节合成可持久化base64签名，返回void，修改对应thinking块及临时状态。
function flushRedactedContent(open: OpenBlock, output: AssistantMessage): void {
	// 根据本地索引取输出块。
	const block = output.content[open.contentIndex];
	// 非thinking或没有暂存数组就不处理。
	if (block?.type !== "thinking" || !open.redactedChunks) return;
	// 按顺序编码所有字节，替换thinkingSignature，不解密载荷。
	block.thinkingSignature = bytesToBase64(open.redactedChunks);
	// 解除暂存字节数组引用，避免留在此状态供重复编码。
	open.redactedChunks = undefined;
}

/** Ends the stream state of blocks a stream settled without stopping. */
/**
 * 收尾仍打开的临时Map，逐项合并加密思考后clear，返回void，不删除已有输出。
 * 例没contentBlockStop但流结束时仍保存redacted签名；不会替工具调用补finish、不会为所有未停止块补end事件，也不证明工具JSON已完整。
 */
// 收尾所有仍打开的块，返回void；只合并redacted字节并清Map。
function flushOpenBlocks(openBlocks: OpenBlocks, output: AssistantMessage): void {
	// 遍历状态逐个刷加密字节，没有在此对工具调用finish或补发块end。
	for (const open of openBlocks.values()) flushRedactedContent(open, output);
	// 清所有网络索引引用，不删除output.content已有块。
	openBlocks.clear();
}

/**
 * 有metadata.usage时覆盖统一token计数并按模型目录估价，返回void，原地写output.usage，不发网络。
 * 例1h/5m混合cacheDetails只把1h计入cacheWrite1h；缺总量时仅输入+输出回退，缺usage则保留原值。不是账单查询，也未验证所有计数范围/相互关系。
 */
// 元数据事件更新统一用量/费用，不生成内容块。
function handleMetadata(
	// SDK元数据可能没有usage。
	event: ConverseStreamMetadataEvent,
	// 模型目录价格供本地估价。
	model: Model<"bedrock-converse-stream">,
	// 修改这条共享消息的usage。
	output: AssistantMessage,
	// 返回void。
): void {
	// 只有存在usage时覆盖用量，缺省元数据不把旧值清零。
	if (event.usage) {
		// 普通输入原值或0；||会把0/NaN等假值也归0，未统一验证负数。
		output.usage.input = event.usage.inputTokens || 0;
		// 输出token同样按||0。
		output.usage.output = event.usage.outputTokens || 0;
		// 缓存读计数缺省0。
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		// 总缓存写计数缺省0。
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		// 从可选cacheDetails累计1h写入子集；没details时undefined，空数组时0。
		output.usage.cacheWrite1h = event.usage.cacheDetails?.reduce(
			/**
			 * reduce回调接累计数与一条缓存明细，返回新累计值，无外部修改；例ttl=1h/inputTokens=100时加100，5m加0，缺token按0。
			 */
			// reduce回调仅ttl精确ONE_HOUR（1h）时加inputTokens，缺值按0，不独立校验其和不超过总缓存写。
			(total, detail) => total + (detail.ttl === CacheTTL.ONE_HOUR ? (detail.inputTokens ?? 0) : 0),
			// 累计初值0。
			0,
		);
		// 总量真值优先，否则只用普通输入+输出，不额外补缓存计数。
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		// 按目录估价原地写cost，1h缓存写按共享helper的两倍输入单价策略，不是AWS实时账单查询。
		calculateCost(model, output.usage);
	}
}

/**
 * 按网络索引结束已知块，删除临时Map项，给文字/思考发end，工具先finish最终参数再发toolcall_end，返回void。
 * 例工具JSON不完整时finish可写argumentsError，后续工具schema/执行由上层负责；未知索引直接忽略，不补一条假内容。
 */
// 结束指定网络块，移临时状态并发对应end，工具参数在这里最终解析。
function handleContentBlockStop(
	// SDK块结束事件。
	event: ContentBlockStopEvent,
	// 网络索引状态Map。
	openBlocks: OpenBlocks,
	// 已累积的统一内容。
	output: AssistantMessage,
	// Pi块end输出通道。
	stream: AssistantMessageEventStream,
	// 返回void。
): void {
	// 按网络索引找状态，!不创建运行时检查。
	const open = openBlocks.get(event.contentBlockIndex!);
	// 不认识的块结束直接忽略，不凭事件创建内容。
	if (!open) return;
	// 先移除状态，再处理块终结；重复stop不再重复结束。
	openBlocks.delete(event.contentBlockIndex!);
	// 取本地内容索引。
	const index = open.contentIndex;
	// 取现有块，!只消除TS可能缺省提示，不防外部篡改导致缺块。
	const block = output.content[index]!;

	// 按Pi块标签分流，不直接按SDK事件联合猜内容。
	switch (block.type) {
		// 文字块分支。
		case "text":
			// 发累计文字最终值，不复制整条partial快照。
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			// 退出switch该分支。
			break;
		// 思考块分支。
		case "thinking":
			// 先合并暂存redacted字节成签名，再发end。
			flushRedactedContent(open, output);
			// 事件content是思考显示文字（可能占位），签名仍在partial块上。
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			// 退出思考分支。
			break;
		// 工具调用块分支。
		case "toolCall":
			// 有解析器则finish最终参数并Object.assign写arguments/可选argumentsError；不做工具schema校验或执行。
			if (open.arguments !== undefined) Object.assign(block, open.arguments.finish());
			// 发toolcall_end，参数错误可在块上供上层识别，不因此必然把整轮状态改error。
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			// 退出工具分支。
			break;
	}
}

/**
 * Check if the model supports adaptive thinking (Opus 4.6+, Sonnet 4.6).
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
/**
 * 从模型id和可选name产生小写与分隔符归一化候选，返回新数组，无I/O。
 * 例“Claude Opus 4.8”增加“claude-opus-4-8”，让应用profile ARN可借展示名判断；不去重、不完整解析版本或确认AWS真实能力。
 */
// 生成id/name的匹配候选字符串，无网络能力探测。
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	// name真值才加入，空串不参与。
	const values = modelName ? [modelId, modelName] : [modelId];
	/**
	 * flatMap回调把单个原值变小写，并返回原分隔符/横线分隔符两项，无输入修改；例a_b变[a_b,a-b]。
	 */
	// flatMap为每个原值产出两种形式并合并数组，不去重。
	return values.flatMap((value) => {
		// 转小写，后面includes不用i正则。
		const lower = value.toLowerCase();
		// 额外把连续空白/下划线/点/冒号换成横线，便于匹配不同命名形式，不完整解析ARN/模型版本。
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

/**
 * 按候选中已列Claude型号子串判断adaptive，返回boolean，无网络/修改；例Opus 4.6命中，Sonnet 4.5不命中。
 * 这是本地分支选择启发式，既不验证model.reasoning，也不是任意未来版本能力探测。
 */
// 本地启发式判断是否用adaptive字段，不向服务端确认能力。
function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	// 取id/name及其规范化候选。
	const candidates = getModelMatchCandidates(modelId, modelName);
	// 任一候选命中下面子串即true，非完整版本比较。
	return candidates.some(
		/**
		 * some回调对一个规范候选做已列子串或比较，返回boolean；例“claude-opus-4-6”真，普通ARN无名称线索时可假，不请求AWS。
		 */
		// some回调接一个候选，返回多项或表达式结果。
		(s) =>
			// Opus 4.6子串。
			s.includes("opus-4-6") ||
			// Opus 4.7子串。
			s.includes("opus-4-7") ||
			// Opus 4.8子串。
			s.includes("opus-4-8") ||
			// Opus 5子串也可匹配更长后缀。
			s.includes("opus-5") ||
			// Sonnet 4.6子串。
			s.includes("sonnet-4-6") ||
			// Sonnet 5子串。
			s.includes("sonnet-5") ||
			// Haiku 5子串。
			s.includes("haiku-5") ||
			// Fable 5子串，前面都没命中才读到这里。
			s.includes("fable-5"),
	);
}

/**
 * 按本地型号子串判断xhigh是否有原生例外，返回boolean，无网络；例Opus 4.7真、4.6假。
 * 用于effort映射时先于thinkingLevelMap检查，不等于所有其他思考能力都受该名单控制。
 */
// 本地识别原生xhigh候选，返回boolean，无修改/请求。
function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	// 同样检查id与name，支持名称识别应用推理profile。
	const candidates = getModelMatchCandidates(model.id, model.name);
	// some要求任一候选中任一已列子串命中。
	return candidates.some(
		/**
		 * 对一个候选检查原生xhigh名单，返回boolean，无修改；例Opus 4.8命中，4.6未列。
		 */
		// 回调按候选字符串比较。
		(s) =>
			// Opus 4.7在名单中，4.6不在本名单。
			s.includes("opus-4-7") ||
			// Opus 4.8命中。
			s.includes("opus-4-8") ||
			// Opus 5系列子串命中。
			s.includes("opus-5") ||
			// Sonnet 5命中。
			s.includes("sonnet-5") ||
			// Haiku 5命中。
			s.includes("haiku-5") ||
			// Fable 5命中。
			s.includes("fable-5"),
	);
}

/**
 * Check if the model accepts `thinking.block_binding`. Opus 4.6 and Sonnet 4.6 reject it with
 * "thinking.adaptive.block_binding: Extra inputs are not permitted".
 */
/**
 * 判断本地是否附Claude thinking.block_binding，输入模型，返回boolean，无网络；例Opus 4.7命中，Opus/Sonnet 4.6不命中。
 * 真正附字段还要求非GovCloud及思考分支等条件，返回true不保证服务端接受任意自定义名称伪装的模型。
 */
// 本地判断是否附thinking.block_binding，不联网探测AWS是否接受。
function supportsThinkingBlockBinding(model: Model<"bedrock-converse-stream">): boolean {
	// 取id/name规范候选。
	const candidates = getModelMatchCandidates(model.id, model.name);
	// 任一候选满足下列子串就true。
	return candidates.some(
		/**
		 * 对一个候选检查binding名单，返回boolean，无修改；例Fable 5子串命中，名称只是启发式线索。
		 */
		// 回调逐候选判断。
		(s) =>
			// Opus 4.7及后面显式列出的候选有binding，未列4.6。
			s.includes("opus-4-7") ||
			// Opus 4.8候选。
			s.includes("opus-4-8") ||
			// Opus 5候选。
			s.includes("opus-5") ||
			// Sonnet 5候选。
			s.includes("sonnet-5") ||
			// Haiku 5候选。
			s.includes("haiku-5") ||
			// Fable 5候选，不是通用未来版本自动能力检测。
			s.includes("fable-5"),
	);
}

/**
 * 将统一档位映射成Claude effort，输入模型与可选level，返回五档字符串联合，无网络/输入修改。
 * 先给本地原生xhigh型号例外，再用字符串映射表，最后minimal/low→low、medium/high原样、其余high；例非原生型号xhigh可按表变max，映射null则继续默认，不在此禁用该档。
 * 字符串映射只做typeof检查后as断言，不验证其真在返回联合名单内。
 */
// 把统一思考档位转Claude effort，返回静态五档字符串联合，不修改模型或联网。
function mapThinkingLevelToEffort(
	// 模型id/name与thinkingLevelMap影响映射。
	model: Model<"bedrock-converse-stream">,
	// 索引访问复用公共reasoning类型，允许undefined。
	level: SimpleStreamOptions["reasoning"],
	// 返回联合不自动验证下面从映射表断言出来的任意string。
): "low" | "medium" | "high" | "xhigh" | "max" {
	// xhigh且本地型号支持原生xhigh就优先返回，不再查看映射表该档是否null/其他值。
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	// 有level才查对应表，缺省得到undefined。
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	// 映射值为string直接断言返回，未核验它真是列出的五种effort之一；null继续走默认分支。
	if (typeof mapped === "string") return mapped as "low" | "medium" | "high" | "xhigh" | "max";

	// 无字符串映射时按档位回退，不把null解释为禁止请求。
	switch (level) {
		// minimal与low合并。
		case "minimal":
		// low分支共用下面返回。
		case "low":
			// 映射成low，不发送minimal。
			return "low";
		// medium分支。
		case "medium":
			// 返回medium。
			return "medium";
		// high分支。
		case "high":
			// 返回high。
			return "high";
		// 其他包括缺省、没有原生例外的xhigh、未映射max都回high。
		default:
			// 不在此抛“不支持档位”，按既有逻辑回退high。
			return "high";
	}
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
/**
 * 选本入口缓存偏好，显式值优先，否则只认环境PI_CACHE_RETENTION=long，再默认short，无网络/外部修改。
 * 例显式none压过环境long；环境none而未显式配置仍回short。决定是否加缓存点还要结合模型本地识别，不保证服务端缓存命中。
 */
// 选本入口缓存偏好，输入显式值与请求env，输出none/short/long，不发网络。
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	// 合法显式值都是真值，none也会进入。
	if (cacheRetention) {
		// 显式值优先，环境long不能覆盖显式none/short。
		return cacheRetention;
	}
	// 未传时仅精确环境long生效，其他环境文字（含none）不在此识别。
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		// 选择long，后面支持缓存的请求点可加1h TTL。
		return "long";
	}
	// 其他一律short，不代表每个模型都会添加缓存点。
	return "short";
}

/**
 * Check if the model is an Anthropic Claude model on Bedrock.
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
/**
 * 按id的anthropic.claude或anthropic/claude，或name的claude等子串识别Claude，返回boolean，无探测/修改。
 * 例应用推理profile ARN不带型号但name含Claude可命中；展示名是调用者可控制的线索，不是真实模型供应商/能力保证。
 */
// 用id/name子串判断Claude路径，返回boolean，不验证真实模型来源或服务能力。
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	// id转小写，但不做分隔符归一化。
	const id = model.id.toLowerCase();
	// name可缺省，缺省用空串。
	const name = model.name?.toLowerCase() ?? "";
	// 任一已列子串命中即视为Claude。
	return (
		// id含anthropic.claude命中。
		id.includes("anthropic.claude") ||
		// id含anthropic/claude也命中。
		id.includes("anthropic/claude") ||
		// 展示name也可含完整点形式。
		name.includes("anthropic.claude") ||
		// 展示name斜线形式也可命中。
		name.includes("anthropic/claude") ||
		// name仅含claude即可命中；id若只含claude而不含前两种完整形式则不靠这一项通过。
		name.includes("claude")
	);
}

/**
 * Check if the model supports prompt caching.
 * Supported: Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x models, Claude 5 models
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * also checks model.name which is user-controlled via models.json or registerProvider.
 * As a last resort, set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points.
 * Amazon Nova models have automatic caching and don't need explicit cache points.
 */
/**
 * 按模型id/name启发式决定是否加显式缓存点，返回boolean，不发网络、不查询命中率。
 * 先查Claude线索；没有线索时AWS_BEDROCK_FORCE_CACHE=1可强制，有线索时只认列出的5/4/3.7 Sonnet/3.5 Haiku版本。
 * 例含Claude但版本未列时false，即使强制开关为1也不再读取；none缓存偏好还会在调用点排除加点，不干预模型自有自动缓存。
 */
// 判断本地是否向请求加显式缓存点，输入模型/env，返回boolean，不探测服务端缓存状态。
function supportsPromptCaching(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): boolean {
	// 使用id/name及规范分隔符候选。
	const candidates = getModelMatchCandidates(model.id, model.name);

	/**
	 * some回调判断单候选是否含claude子串，返回boolean；仅作本地名称启发式，不确认模型真实身份。
	 */
	// some回调只查claude子串，任一有即认为有Claude线索。
	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	// 没Claude线索时走强制开关回退。
	if (!hasClaudeRef) {
		// Application inference profiles don't contain the model name in the ARN.
		// Allow users to force cache points via environment variable.
		// 精确AWS_BEDROCK_FORCE_CACHE=1可在此直接开，不能保证目标模型真接受缓存点。
		if (getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1") return true;
		// 没线索又没强制则不开显式缓存点，未干预模型自身自动缓存。
		return false;
	}
	// Claude 5 models (fable-5, opus-5, sonnet-5, haiku-5)
	// 有Claude线索后按本地型号白名单判断，不再读取强制开关。
	if (
		// 任一候选命中Claude 5已列系列就接受。
		candidates.some(
			/**
			 * 对一条候选检查四种已列Claude 5系列子串，返回boolean，无修改；例opus-5-5也包含opus-5。
			 */
			// 回调按fable/opus/sonnet/haiku-5子串或比较，不解析真实版本。
			(s) => s.includes("fable-5") || s.includes("opus-5") || s.includes("sonnet-5") || s.includes("haiku-5"),
		)
	)
		// 有命中就返回true。
		return true;
	// Claude 4.x models (opus-4, sonnet-4, haiku-4)
	/**
	 * some回调按候选含-4-判断这一缓存分支，返回boolean；它是子串检测，不是完整解析所有Claude 4版本号。
	 */
	// 只要某候选含-4-也接受；这个型号线索可能来自与claude线索不同的另一个候选。
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	/**
	 * some回调识别claude-3-7-sonnet子串，返回boolean，不探测服务端缓存能力。
	 */
	// Claude 3.7 Sonnet子串可接受。
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	/**
	 * some回调识别claude-3-5-haiku子串，返回boolean，不修改候选。
	 */
	// Claude 3.5 Haiku子串可接受。
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	// 其他有claude线索但未匹配版本时false，即使FORCE_CACHE=1也不会再检查。
	return false;
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (OpenAI, Qwen, Minimax, Moonshot, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Checks both model ID and model name to support application inference profiles.
 */
/**
 * 决定普通reasoningText是否附signature，输入模型，返回本地Claude识别结果，无网络/验签。
 * 例GPT的reasoningText只带text、不带signature，Claude缺普通签名会在转换器中回退普通文字；加密redactedContent走独立分支，不靠此函数解码。
 */
// 选择是否在重放reasoningText时附普通signature，返回boolean，无验签。
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	// 直接沿用本地Claude识别；redactedContent走另一路，不依赖此普通签名开关。
	return isAnthropicClaudeModel(model);
}

/**
 * 从可选系统文字构建SDK顶层system数组，输入模型/缓存偏好/env，返回新数组或undefined，无网络/原轨迹修改。
 * 有文字先删孤立代理码元，再按本地缓存支持加独立cachePoint；例long加ttl=1h，short省ttl，空串直接省system。
 * 纯空白或清理后变空的非空输入在此不会套<empty>占位，后端是否接受由真实请求决定。
 */
// 构建顶层system数组，输入文字/模型/缓存偏好/env，返回数组或undefined，无网络。
function buildSystemPrompt(
	// 原系统提示可缺省。
	systemPrompt: string | undefined,
	// 模型名称启发式决定是否能请求显式缓存点。
	model: Model<"bedrock-converse-stream">,
	// none关闭本入口加点，long加1h TTL。
	cacheRetention: CacheRetention,
	// 请求环境可影响强制缓存判断。
	env?: ProviderEnv,
	// 返回SDK系统块数组，不改原context。
): SystemContentBlock[] | undefined {
	// 空串/缺省不建system；任何非空字符串（含全空白）都通过，未trim检查。
	if (!systemPrompt) return undefined;

	// 删除孤立代理码元后放单个text块；即使清完变空也不在此补empty占位。
	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// Add cache point for supported Claude models when caching is enabled
	// 缓存未禁用且本地识别支持才加点。
	if (cacheRetention !== "none" && supportsPromptCaching(model, env)) {
		// 追加一个独立cachePoint块，不把缓存控制字串混进提示词。
		blocks.push({
			// DEFAULT类型；仅long显式ttl=1h，short不写ttl让服务端采用相应默认行为。
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	// 返回新块数组，服务端是否接受/命中缓存不由此保证。
	return blocks;
}

/**
 * 把id中非ASCII字母数字下划线横线逐个换下划线，再截最多64，返回字符串，无外部修改。
 * 例call|x变call_x；不补空id，不防不同原id碰撞，调用它的共享transform只在跨模型分支规范化。
 */
// 规范跨模型工具调用id，返回新字符串，无外部修改。
function normalizeToolCallId(id: string): string {
	// g替换每个非ASCII字母/数字/下划线/横线字符为下划线，不做唯一性保护。
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	// 超64码元截前64；处理后仅ASCII，不补空id或消除截断碰撞。
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

/**
 * 删除孤立代理码元并过滤空白，返回SDK文字块或undefined，不改输入。
 * 例“  hello  ”保留原两端空白，只有trim后为空才丢；ContentBlock.TextMember是SDK联合的文字成员类型。
 */
// 清文字并筛空，输入string，返回SDK文字块或undefined，无输入修改。
function createNonBlankTextBlock(text: string): ContentBlock.TextMember | undefined {
	// 删除不成对代理码元。
	const sanitized = sanitizeSurrogates(text);
	// trim仅用于空白判断，保留文字时仍用未trim的sanitized正文。
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

/**
 * 构建必需文字块，输入string，输出非空占位或清理后的文字，无外部副作用。
 * 例空白输入变{text:"<empty>"}，普通正文保留清理后的原空格，不把占位当真实用户内容。
 */
// 构建必须存在的文字块，输入string，返回SDK TextMember，不修改输入。
function createRequiredTextBlock(text: string): ContentBlock.TextMember {
	// 非空清理结果优先，否则固定<empty>占位，不当作用户真实文字。
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

/**
 * 递归把JsonValue容器清成AWS文档表示，删除对象中空字符串键，返回新数组/对象或原标量，不改原参数。
 * 例{edits:[{"":"",a:1}]}变{edits:[{a:1}]}；仅作用于重放请求，不删除已收到的模型参数空键，不验证工具schema，也不处理坏循环结构。
 */
// 清洗工具重放参数为AWS DocumentType，递归去掉空对象键，返回新容器或原标量，不是schema校验。
function sanitizeBedrockDocument(value: JsonValue): DocumentType {
	// 数组作为JsonValue合法分支递归处理，不转成普通字典。
	if (Array.isArray(value)) {
		// map生成新数组，每项递归清洗；不会修改原数组项容器。
		return value.map(sanitizeBedrockDocument);
	}
	// 非null对象才枚举字段，null后面原样保留。
	if (value !== null && typeof value === "object") {
		// 从筛过/递归转换的entry重建对象。
		return Object.fromEntries(
			// 只枚举自有可枚举字符串键，不递归处理原型属性。
			Object.entries(value)
				/**
				 * filter回调解构一对entry只取key，保留非空字符串键，返回boolean；例""删除而" "保留，不修改原对象。
				 */
				// filter回调仅删长度0的键，空格键保留，不在流入站参数阶段删除。
				.filter(([key]) => key.length > 0)
				/**
				 * map回调解构key/value，保留键并递归清洗值，返回新二元组供fromEntries；无原对象写入。
				 */
				// map回调保留非空key并递归转换对应值，返回二元组，无原对象修改。
				.map(([key, nestedValue]) => [key, sanitizeBedrockDocument(nestedValue)]),
		);
	}
	// 标量（含null）原样返回；不在此验证有限数或解决循环引用。
	return value;
}

/**
 * 转换工具结果文字/图片为AWS内容，输入块数组，输出新非空数组，不修改结果或发网络。
 * 例只有空白文字时补<empty>；图片按MIME和base64解码，错误可抛，status与调用id由外层另加。
 */
// 工具结果内容转AWS文本/图片块，返回新非空数组，无网络，不修改Pi结果。
function convertToolResultContent(content: (TextContent | ImageContent)[]): ToolResultContentBlock[] {
	// 新建输出数组。
	const result: ToolResultContentBlock[] = [];
	// 按原内容顺序转换。
	for (const c of content) {
		// image分支需要解码base64与识别MIME。
		if (c.type === "image") {
			// 图片转AWS image块，坏MIME/base64可抛错。
			result.push({ image: createImageBlock(c.mimeType, c.data) });
			// 其余合法联合成员为text。
		} else {
			// 删除孤立代理码元，并筛空白文字。
			const textBlock = createNonBlankTextBlock(c.text);
			// 有实际文字才追加，避免空字符串块。
			if (textBlock) result.push(textBlock);
		}
	}
	// 全部过滤/原内容为空时补一个固定占位。
	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	// 返回新工具结果块数组，不附status/id，这两项由调用方包裹。
	return result;
}

/**
 * 完整历史转AWS消息数组：首system另发顶层，先共享跨模型/图片/工具配对适配，再转换user、assistant与连续toolResult，返回新数组。
 * 会做id清洗、空文字过滤/占位、普通/加密思考重放及工具参数空键清理；例两条连续工具结果合成一条user，Claude错误图放该批所有结果后。图片/base64或递归结构转换可能抛错，不执行工具。
 * 缓存只在最终结果最后一项本身为user时加一个点，并非寻找最近user；模型实际缓存接受/命中另由服务端决定，不改持久会话。
 */
// 把完整Pi历史转AWS user/assistant列表，返回新数组，不修改持久历史、不执行工具。
function convertMessages(
	// 已折叠系统轨迹，首system后面转到请求顶层。
	context: TranscriptContext,
	// 模型身份控制跨模型签名/id与Claude错误图策略。
	model: Model<"bedrock-converse-stream">,
	// 缓存偏好决定是否给末项user加显式缓存点。
	cacheRetention: CacheRetention,
	// env可影响强制缓存判断，不是AWS SDK全局环境替换。
	env?: ProviderEnv,
	// 返回SDK Message[]，图片/base64或递归结构转换错误仍可抛。
): Message[] {
	// 新建结果消息数组。
	const result: Message[] = [];
	// 先用共享历史转换做跨模型和工具配对适配。
	const transformedMessages = transformMessages(
		// 去掉首system，因为它由buildSystemPrompt发顶层；首system不存在时helper可复用原数组。
		withoutInitialSystemMessage(context.messages),
		// 目标模型控制思考保留、图片降级和同模型判断。
		model,
		// 规范id回调只在共享helper判断跨模型时调用，不强制重写所有同模型id。
		normalizeToolCallId,
	);

	// 用下标遍历，连续工具结果合并后会手动跳过已处理项。
	for (let i = 0; i < transformedMessages.length; i++) {
		// 取当前共享转换后的消息，不是原context对应下标的简单别名保证。
		const m = transformedMessages[i];

		// 按Pi消息角色选择AWS表示。
		switch (m.role) {
			// 用户消息分支。
			case "user": {
				// 创建本条SDK内容数组。
				const content: ContentBlock[] = [];
				// 合法user内容联合允许纯字符串或块数组，typeof在此收窄。
				if (typeof m.content === "string") {
					// 纯字符串即使空白也补占位，保证有一块。
					content.push(createRequiredTextBlock(m.content));
					// 数组内容逐块处理，不直接作为AWS wire数组发送。
				} else {
					// 遍历文字/图片块。
					for (const c of m.content) {
						// 按块标签分流。
						switch (c.type) {
							// 文字块分支。
							case "text": {
								// 清理并筛空白文字。
								const textBlock = createNonBlankTextBlock(c.text);
								// 非空才追加。
								if (textBlock) content.push(textBlock);
								// 结束该文字分支。
								break;
							}
							// 图片块分支，模型无image能力时共享transform已先替文字。
							case "image":
								// 解码图片为AWS image块，原MIME选择格式。
								content.push({ image: createImageBlock(c.mimeType, c.data) });
								// 结束图片分支。
								break;
							// 未识别内容标签走后备分支。
							default:
								// 跳过该块而非抛新错误；不自动支持其他任意内容。
								continue;
						}
					}
					// 所有块被过滤时补固定占位，不丢整条用户消息。
					if (content.length === 0) content.push({ text: EMPTY_TEXT_PLACEHOLDER });
				}
				// 包成AWS user角色消息。
				result.push({ role: ConversationRole.USER, content });
				// 结束user分支。
				break;
			}
			// assistant消息分支，共享transform已跳过error/aborted回复。
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				// 空内容数组直接跳过，不发非法空assistant。
				if (m.content.length === 0) {
					// 继续外层消息循环。
					continue;
				}
				// 准备本条assistant的AWS块数组。
				const contentBlocks: ContentBlock[] = [];
				// 按原assistant块顺序转换，保留思考与工具调用相对顺序。
				for (const c of m.content) {
					// 按Pi块标签分流。
					switch (c.type) {
						// 文字块分支。
						case "text": {
							// Skip empty text blocks
							// 清理代理码元并筛空白文字。
							const textBlock = createNonBlankTextBlock(c.text);
							// 清完无文字就跳过此块。
							if (!textBlock) continue;
							// 有内容才加入assistant。
							contentBlocks.push(textBlock);
							// 结束文字分支。
							break;
						}
						// 工具调用分支，不执行调用。
						case "toolCall":
							// 追加AWS toolUse内容块。
							contentBlocks.push({
								// 用共享转换后的调用id及原工具名，递归清重放参数空键；不清原历史或刚流入的参数对象。
								toolUse: { toolUseId: c.id, name: c.name, input: sanitizeBedrockDocument(c.arguments) },
							});
							// 结束工具调用分支。
							break;
						// 思考块分支。
						case "thinking": {
							// Encrypted reasoning is opaque: replay the stored payload as the
							// `redactedContent` member instead of lowering it to reasoning text.
							// redacted优先，不把加密载荷降成可见reasoningText。
							if (c.redacted) {
								// 尝试base64解码已存签名，坏值返回undefined。
								const redactedContent = decodeRedactedContent(c.thinkingSignature);
								// 非空字节才重放，加密空载荷/坏base64块被省略。
								if (redactedContent?.length) {
									// 原字节作为reasoningContent.redactedContent发送，不本地解密/验签。
									contentBlocks.push({ reasoningContent: { redactedContent } });
								}
								// redacted处理完直接下一块，不再检查普通thinking文字。
								continue;
							}
							// Skip empty thinking blocks
							// 普通思考文字同样删孤立代理码元。
							const thinking = sanitizeSurrogates(c.thinking);
							// 空白思考直接跳过，即使普通signature非空也不发空reasoningText。
							if (thinking.trim().length === 0) continue;
							// Only Anthropic models support the signature field in reasoningText.
							// For other models, we omit the signature to avoid errors like:
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							// 本地判断Claude时可附普通signature，其他模型不附。
							if (supportsThinkingSignature(model)) {
								// Signatures arrive after thinking deltas. If a partial or externally
								// persisted message lacks a signature, Bedrock rejects the replayed
								// reasoning block. Fall back to plain text, matching Anthropic.
								// 缺签名或全空白签名则把已有非空思考当普通text重放。
								if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
									// 追加普通文字块，不伪造可验证签名。
									contentBlocks.push({ text: thinking });
									// 签名有非空白内容时保留reasoningText结构。
								} else {
									// 追加带普通签名的思考内容。
									contentBlocks.push({
										// 外层reasoningContent联合成员。
										reasoningContent: {
											// 内层reasoningText对象。
											reasoningText: {
												// 发送清理后的可读思考。
												text: thinking,
												// 发送原签名字符串，不trim签名正文或在本地验证。
												signature: c.thinkingSignature,
											},
										},
									});
								}
								// 非Claude普通思考路径省略signature。
							} else {
								// 追加不带签名的思考结构，不把它统一改成普通text。
								contentBlocks.push({
									// 外层reasoningContent。
									reasoningContent: {
										// reasoningText只含可读文字，避免发送其他模型不支持的signature字段。
										reasoningText: { text: thinking },
									},
								});
							}
							// 结束thinking分支。
							break;
						}
						// 未识别assistant内容类型。
						default:
							// 跳过该块，不新增任意wire类型支持。
							continue;
					}
				}
				// Skip if all content blocks were filtered out
				// 全部块被过滤时不发空assistant。
				if (contentBlocks.length === 0) {
					// 继续外层消息循环，不为这条回复补<empty>。
					continue;
				}
				// 追加有实际AWS块的assistant消息。
				result.push({
					// 使用AWS assistant角色。
					role: ConversationRole.ASSISTANT,
					// content用转换后的新数组。
					content: contentBlocks,
				});
				// 结束assistant分支。
				break;
			}
			// 工具结果分支，将连续toolResult合并成一条AWS user消息。
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message
				// Bedrock requires all tool results to be in one message
				// 收集本批工具结果块。
				const toolResults: ContentBlock[] = [];
				// Claude rejects error tool results that contain anything but text, so for Claude their
				// images follow all tool results of the turn (#10794). Other models keep them in place.
				// Claude错误结果里拆出的图片暂存到本批所有工具结果之后，正常结果/其他模型保留原图位置。
				const errorImages: ContentBlock[] = [];
				// j从当前消息位置向后扫描。
				let j = i;
				// 只连续工具结果归同批，遇其他角色就停止；不搜索整段历史中的全部结果。
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					// role已检查后断言为ToolResultMessage，as不验证wire对象。
					const toolMsg = transformedMessages[j] as ToolResultMessage;
					// 只有Claude错误且含图片时helper返回拆分对象，其他情形undefined。
					const split = isAnthropicClaudeModel(model) ? splitErrorToolResultImages(toolMsg) : undefined;
					// 加一个AWS toolResult块。
					toolResults.push({
						// 内层工具结果结构。
						toolResult: {
							// 结果引用对应工具调用id，不生成新id。
							toolUseId: toolMsg.toolCallId,
							// 有拆图时用纯文字/占位结果，其他用原内容转换。
							content: convertToolResultContent(split?.content ?? toolMsg.content),
							// isError真值选error，否则success，不代表这里重新执行过工具或验证结果正确。
							status: toolMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					// 确实拆图才额外附caption和图片。
					if (split) {
						// 收集到暂存图片数组，不立即夹入当前toolResult内部。
						errorImages.push(
							// caption点明来源调用，不是新工具执行输出。
							{ text: split.caption },
							/**
							 * map回调将一张原Pi图片解码成AWS image块，返回新对象，无网络；原base64/MIME错误会让本次历史转换抛错。
							 */
							// map回调逐图解码成AWS image块，再...展开追加，保持图片顺序。
							...split.images.map((image) => ({ image: createImageBlock(image.mimeType, image.data) })),
						);
					}
					// 扫描下一条连续工具结果。
					j++;
				}

				// Skip the messages we've already processed
				// 外层i设为j-1，配合for的i++下一次正好到未处理角色。
				i = j - 1;

				// 整批结果先放，再放错误图说明/图片，合成一条user消息，不单独建立tool角色。
				result.push({ role: ConversationRole.USER, content: [...toolResults, ...errorImages] });
				// 结束本批toolResult分支。
				break;
			}
			// 其他角色后备分支。
			default:
				// 跳过残留system等角色，不把它们伪装成user；公开入口已先折叠system。
				continue;
		}
	}

	// Add cache point to the last user message for supported Claude models when caching is enabled
	// 缓存未禁用、本地支持且结果非空才考虑末项缓存点。
	if (cacheRetention !== "none" && supportsPromptCaching(model, env) && result.length > 0) {
		// 只查看最后一条消息，不从后向前搜索最近user。
		const lastMessage = result[result.length - 1];
		// 末项恰为user且content存在才加点；末项assistant时完全不加这里的点。
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			// as只协调SDK块数组类型，实际向本次结果数组追加。
			(lastMessage.content as ContentBlock[]).push({
				// 独立cachePoint内容块。
				cachePoint: {
					// 使用DEFAULT类型。
					type: CachePointType.DEFAULT,
					// long显式1h，short省ttl；只是请求缓存策略，不保证命中或保留到期。
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	// 返回新AWS消息数组，嵌套值是否共用引用取决于具体转换分支，不写持久会话。
	return result;
}

/**
 * 把当前Pi工具及选择转SDK toolConfig，返回配置与hasPreferredStrictTools，无网络/工具执行。
 * none或空工具整体省略；每项按模型strict能力与prefer/require转换schema，降级标记只关prefer；例require项保持strict:true，prefer项第二次可省strict。
 * 不声明OpenAI custom grammar协议，具体工具名不额外查列表，schema构建错误向外抛而不走后续send阶段限额恢复。
 */
// 将Pi当前工具声明转AWS toolConfig，并报告是否真的启用了prefer strict项。
function convertToolConfig(
	// 工具声明数组可缺省，不是工具执行函数集合。
	tools: Tool[] | undefined,
	// 索引访问复用原生工具选择类型。
	toolChoice: BedrockOptions["toolChoice"],
	// 模型本地strict能力开关。
	supportsStrictMode: boolean,
	// true表示一次限额降级后关闭prefer strict，require仍继续按声明检查。
	disablePreferredStrictTools: boolean,
	// 返回配置与标志对象，不返回转换后的模型执行结果。
): { toolConfig: ToolConfiguration | undefined; hasPreferredStrictTools: boolean } {
	// 无工具或明确none时整个toolConfig缺省，标志false；none不是发一个AWS原生none成员。
	if (!tools?.length || toolChoice === "none") return { toolConfig: undefined, hasPreferredStrictTools: false };

	// 累计是否有至少一项真正启用prefer strict。
	let hasPreferredStrictTools = false;
	/**
	 * map回调转换一项工具，输入Tool，返回SDK toolSpec并可能更新外层prefer标记；不修改原schema。
	 * 例prefer且能力满足时strict:true并严格化副本，已降级则用原schema不附strict；require失败可抛。
	 */
	// map创建AWS工具列表，不执行工具。
	const bedrockTools: BedrockTool[] = tools.map((tool) => {
		// 只判断声明是json_schema+strict:prefer，不在此核验能力。
		const preferred = prefersJsonSchemaStrictSampling(tool);
		// 决定这一项的严格采样策略。
		const strict =
			// 已降级且此项prefer才强制关闭。
			disablePreferredStrictTools && preferred
				? // undefined表示不附strict:true，原参数schema保持非严格形状。
					undefined
				: // 其他按能力/声明解析；require不能满足时抛，构建错误不走send catch降级。
					resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		// 只有strict===true且prefer才记标志，声明prefer但本地已降级的不算。
		if (strict === true && preferred) hasPreferredStrictTools = true;
		// 返回本项AWS工具对象。
		return {
			// 普通toolSpec成员，不发送OpenAI custom grammar结构。
			toolSpec: {
				// 工具名原样。
				name: tool.name,
				// 描述原样。
				description: tool.description,
				// strict为true才产严格schema副本；双重as桥接DocumentType，不运行时验证任意schema可被AWS接受。
				inputSchema: { json: getJsonSchemaToolParameters(tool, strict) as unknown as DocumentType },
				// 只在true时附strict:true，undefined不写strict:false。
				...(strict === true ? { strict: true } : {}),
			},
		};
	});

	// 准备AWS工具选择，可不传让服务端决定默认。
	let bedrockToolChoice: ToolChoice | undefined;
	// 按原生toolChoice分支，不直接沿用公共其他供应商required字符串。
	switch (toolChoice) {
		// auto分支。
		case "auto":
			// 发送auto空配置对象。
			bedrockToolChoice = { auto: {} };
			// 结束auto分支。
			break;
		// any分支。
		case "any":
			// 发送any对象，表达要求工具请求，不在此执行工具。
			bedrockToolChoice = { any: {} };
			// 结束any分支。
			break;
		// 其余包括undefined或带type对象。
		default:
			// 对合法联合中具体工具对象检查标签；可选链容忍未传。
			if (toolChoice?.type === "tool") {
				// 发送所指定工具名，不额外确认名字就在tools数组中。
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	// 返回工具配置和实际prefer strict标记，供主入口识别可恢复限额。
	return { toolConfig: { tools: bedrockTools, toolChoice: bedrockToolChoice }, hasPreferredStrictTools };
}

/**
 * 把AWS原始停止原因转统一状态/可选错误，输入string|undefined，返回新对象，无修改/重试。
 * 例end_turn→stop、tool_use→toolUse、max_tokens或context超限→length；guardrail及未知真值→error+原原因，缺原因→error，不在此做上下文压缩。
 */
// AWS停止原因映射成Pi状态/可选说明，返回新对象，不修改output或重试。
function mapStopReason(reason: string | undefined): { stopReason: StopReason; errorMessage?: string } {
	// 按原始字符串精确分支，未给也进入default。
	switch (reason) {
		// end_turn正常结束。
		case BedrockStopReason.END_TURN:
		// stop_sequence同样视为正常stop。
		case BedrockStopReason.STOP_SEQUENCE:
			// 返回统一stop，不保证整个Agent任务已完成。
			return { stopReason: "stop" };
		// max_tokens视为长度截断。
		case BedrockStopReason.MAX_TOKENS:
		// model_context_window_exceeded同样返回length，不在此启动上下文压缩。
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			// 可交付长度终态，不说明答案完整。
			return { stopReason: "length" };
		// tool_use表示模型请求工具。
		case BedrockStopReason.TOOL_USE:
			// 返回toolUse，执行由上层负责。
			return { stopReason: "toolUse" };
		// 其他原始原因或undefined统一失败。
		default:
			// 有真值原因才附具体错误说明。
			return reason
				? // 包含未知原因、guardrail等原字串，不自动解释成可重试或正常停止。
					{ stopReason: "error", errorMessage: `Provider stopped with: ${reason}` }
				: // 无原因仅标error，外层可用固定未知错误文字。
					{ stopReason: "error" };
	}
}

/**
 * 选择显式/环境配置地区，返回options.region、AWS_REGION、AWS_DEFAULT_REGION中首个真值或undefined。
 * 例scoped AWS_REGION覆盖ambient同名变量；不读取模型ARN/URL/SDK profile文件，也不trim地区值，不发网络。
 */
// 按选项/环境选配置地区，返回首个真值字符串或undefined，无SDK凭证文件读取。
function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	// 短路或选择地区，空串继续回退。
	return (
		// 原生region选项优先。
		options.region ||
		// 其次请求env/ambient AWS_REGION。
		getProviderEnvValue("AWS_REGION", options.env) ||
		// 再AWS_DEFAULT_REGION。
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		// 所有来源无真值就undefined；ARN与SDK配置链在其他地方处理。
		undefined
	);
}

/**
 * 取成对AWS访问密钥与可选session token，返回新SDK credentials配置对象或undefined，无网络/文件读取。
 * 例只配置accessKeyId不配置secret则undefined；每个变量独立回退环境，可能混合来源，不核验有效性或刷新，不打印密钥。
 */
// 成对访问密钥转SDK配置对象，返回credentials类型或undefined，不验证、刷新或请求AWS。
function getConfiguredBedrockCredentials(env?: ProviderEnv): BedrockRuntimeClientConfig["credentials"] | undefined {
	// 每个变量单独按请求env→进程环境回退，可能混用不同来源。
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	// 取得秘密访问key，不打印或用它当Bearer。
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	// 任一缺少/空串都不构造部分凭证对象。
	if (!accessKeyId || !secretAccessKey) {
		// 让调用方保留其他SDK认证路径。
		return undefined;
	}
	// 可选session token也用同一环境优先级。
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	// 返回新普通对象，未从文件/metadata服务自行补key。
	return {
		// 访问key属性简写。
		accessKeyId,
		// 秘密key属性简写。
		secretAccessKey,
		// sessionToken真值才附加，不主动检测是否临时凭证必须带token。
		...(sessionToken ? { sessionToken } : {}),
	};
}

/**
 * 从标准Bedrock runtime URL主机名提地区，返回捕获字符串或undefined，无网络。
 * 例https://bedrock-runtime-fips.us-west-2.amazonaws.com/path提us-west-2，支持.com.cn；只比hostname，非法URL/自定义主机不识别，不验证地区真实存在。
 */
// 尝试从标准Bedrock runtime主机提地区，输入可缺省URL，返回string或undefined，无网络。
function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	// 空URL直接不识别。
	if (!baseUrl) {
		// 返回缺省值，不选默认地区。
		return undefined;
	}

	// URL解析异常在此被吞，不在此验证真实端点可用。
	try {
		// 标准URL解析只取hostname，端口/路径/query不参与后面标准主机匹配。
		const { hostname } = new URL(baseUrl);
		// 开头结尾锚定标准主机，可选-fips与.com.cn；无m的$不忽略末尾LF，URL解析本身另有规范化。
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		// 有匹配才取捕获地区，不验证它一定是AWS存在的地区。
		return match?.[1];
		// 非法URL不会在这个识别helper向外抛。
	} catch {
		// 返回undefined，调用者可能把它当需显式配置的自定义端点，不等于提前拒绝该URL。
		return undefined;
	}
}

/**
 * 判断是否把模型baseUrl显式交SDK，输入URL、配置地区与ambient-profile标记，返回boolean，无配置写入。
 * 非标准主机总true，标准主机只在两种配置都无时true；例配AWS_REGION后让标准目录URL不固定。true不等于URL合法，不处理ARN地区与scoped profile影响。
 */
// 决定是否把baseUrl原样固定给SDK，返回boolean，无网络/配置写入。
function shouldUseExplicitBedrockEndpoint(
	// 模型原基础URL字符串。
	baseUrl: string,
	// 选项或环境地区，非SDK最终地区。
	configuredRegion: string | undefined,
	// 只表示ambient profile存在，非任意profile配置都算。
	hasAmbientConfiguredProfile: boolean,
	// 返回是否显式设置endpoint。
): boolean {
	// 用标准主机识别helper取地区。
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	// 不像标准主机（也可能是坏URL）就保留显式endpoint路径。
	if (!endpointRegion) {
		// true只是配置选择，不证明URL合法/可连。
		return true;
	}

	// 标准主机仅在没有配置地区且没有ambient profile时固定；不在此考虑模型ARN地区或scoped profile。
	return !configuredRegion && !hasAmbientConfiguredProfile;
}

/**
 * 按配置地区或模型id前缀判断GovCloud兼容路径，返回boolean，无SDK查询/修改。
 * 例region=us-gov-west-1或arn:aws-us-gov:命中；不读profile解析后的地区或URL主机，故不能宣称覆盖真实运行时所有GovCloud目标。
 */
// 本地判断是否走GovCloud思考兼容路径，返回boolean，不查询SDK实际解析地区。
function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	// 只读显式/环境地区，不读SDK profile文件或从baseUrl提地区。
	const region = getConfiguredBedrockRegion(options);
	// 非空地区转小写以us-gov-开头即命中。
	if (region?.toLowerCase().startsWith("us-gov-")) {
		// 返回true，调用方省display/binding。
		return true;
	}

	// 未靠地区命中时再小写模型id。
	const modelId = model.id.toLowerCase();
	// id以us-gov.或特定GovCloud ARN分区开头也命中；未在此从name/baseUrl猜GovCloud。
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

/**
 * 构建模型专属思考参数，输入模型与BedrockOptions，返回字典或undefined，不发网络/修改历史。
 * 先要求请求reasoning及模型reasoning；Claude按本地型号选adaptive effort或固定budget，并按GovCloud省display/binding、按分支附beta；GPT-OSS扁平effort，其他GPT嵌套reasoning.effort。
 * 例Claude Opus 4.8非GovCloud可请求drop_block绑定策略；这是服务端参数，不是本地删除旧思考。原生预算未在这里按maxTokens钳制，未知模型不猜协议，参数真实支持仍由服务端决定。
 */
// 构建模型专属思考字段，输入模型/原生选项，返回字典或undefined，无网络。
function buildAdditionalModelRequestFields(
	// 模型reasoning标志及id/name/档位表决定分支。
	model: Model<"bedrock-converse-stream">,
	// 原生选项含reasoning、预算、显示、地区、交错偏好。
	options: BedrockOptions,
	// any允许不同模型字典结构，放宽静态检查，不提供runtime校验。
): Record<string, any> | undefined {
	// 必须请求reasoning且model.reasoning为真才构建；两者缺任一都不发这些字段。
	if (!options.reasoning || !model.reasoning) {
		// 返回undefined，不在此强制给供应商发送关闭思考字段。
		return undefined;
	}

	// Claude优先于后面GPT名称匹配分支。
	if (isAnthropicClaudeModel(model)) {
		// GovCloud Bedrock currently rejects the Claude thinking.display field.
		// Omit it there until the GovCloud Converse schema catches up.
		// 由配置地区/模型id判断GovCloud，不保证覆盖SDK profile最终地区。
		const isGovCloud = isGovCloudBedrockTarget(model, options);
		// GovCloud省display，其他缺省summarized；??保留合法omitted。
		const display = isGovCloud ? undefined : (options.thinkingDisplay ?? "summarized");
		// Replayed signed thinking blocks are bound to the system prompt and tools they were
		// created with. Bedrock 400s on replay after either changes unless stale blocks are
		// dropped, matching the Anthropic provider. Skipped on GovCloud like display.
		// 非GovCloud且型号本地支持才请求binding，不表示本地已删除失效思考块。
		const useBlockBinding = !isGovCloud && supportsThinkingBlockBinding(model);
		// 根据型号启发式在adaptive与固定预算对象间选择；result可供后面附beta。
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? // adaptive分支创建新对象。
				{
					// Claude thinking字段。
					thinking: {
						// 明确type:adaptive，不发budget_tokens。
						type: "adaptive",
						// display不是undefined才附加，GovCloud不附。
						...(display !== undefined ? { display } : {}),
						// 需要binding时请求prefix不匹配drop_block，由服务端处理，不在本地重写旧签名。
						...(useBlockBinding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
					},
					// output_config.effort用专用映射，和thinking内部字段分开。
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
					// 有binding才附对应beta数组；该分支不额外附交错思考beta。
					...(useBlockBinding ? { anthropic_beta: [THINKING_BINDING_CONTROLS_BETA] } : {}),
				}
			: /**
				 * 固定预算分支立即执行的零参数闭包，读取reasoning/自定义预算/display，返回thinking.enabled对象，无外部修改。
				 * 例reasoning=xhigh按high自定义值或默认16384；不会在这里校验预算正数或留1024正文，简化入口另做预算协调。
				 */
				// 固定预算用立即执行闭包生成新对象，便于局部定义预算表。
				(() => {
					// Record要求每个ThinkingLevel有数字默认值；不验证自定义预算数值范围。
					const defaultBudgets: Record<ThinkingLevel, number> = {
						// minimal默认1024。
						minimal: 1024,
						// low默认2048。
						low: 2048,
						// medium默认8192。
						medium: 8192,
						// high默认16384。
						high: 16384,
						// xhigh默认同high，采用相同token预算。
						xhigh: 16384, // Budget-based Claude clamps extended levels to high
						// max默认也16384。
						max: 16384,
					};

					// Custom budgets only cover token-based levels through high.
					// 自定义预算只用四档键，xhigh/max先归high。
					const level = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
					// 自定义所选档非null/undefined优先；0也保留，原生路径不在此按maxTokens再钳制预算。
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					// 返回固定预算Claude专属字段。
					return {
						// thinking容器。
						thinking: {
							// type:enabled与adaptive路径不同。
							type: "enabled",
							// 发送选中token预算，不在这里校验正数或总输出空间。
							budget_tokens: budget,
							// 非GovCloud才附display。
							...(display !== undefined ? { display } : {}),
						},
					};
					// 立即调用固定预算闭包，其返回对象成为result。
				})();

		// 仅非adaptive且interleavedThinking未明确false才附交错beta，GovCloud也可能走这个既有分支。
		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			// 设置固定交错beta数组，不把它和binding beta无条件合并。
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		// 返回Claude专属对象。
		return result;
	}

	// 非Claude再取模型id/name规范候选。
	const candidates = getModelMatchCandidates(model.id, model.name);

	/**
	 * some回调识别候选中的gpt-oss子串，返回boolean，无修改；该分支先于更宽的gpt-匹配。
	 */
	// some回调任一候选含gpt-oss时优先走OSS分支。
	if (candidates.some((s) => s.includes("gpt-oss"))) {
		// OSS用扁平reasoning_effort查默认表，xhigh/max归high；不读取thinkingLevelMap覆盖。
		return { reasoning_effort: OPENAI_GPT_OSS_EFFORT[options.reasoning] };
	}

	/**
	 * some回调识别候选中的gpt-子串，返回boolean，无网络；名称线索也可触发，不验证实际供应商身份。
	 */
	// 其他任一候选含gpt-走嵌套GPT结构。
	if (candidates.some((s) => s.includes("gpt-"))) {
		// 对当前档查映射，null或undefined后面都回退默认表，不在此禁用档位。
		const mapped = model.thinkingLevelMap?.[options.reasoning];
		// 返回新GPT专属配置对象。
		return {
			// 字符串映射直接作为effort，无支持值名单校验；否则minimal→low等默认表。
			reasoning: { effort: typeof mapped === "string" ? mapped : OPENAI_GPT_EFFORT[options.reasoning] },
		};
	}

	// 未识别其他模型即不发送专属字段，不凭reasoning标志推断通用budget协议。
	return undefined;
}

// GPT本地默认effort联合，不含minimal。
type OpenAIGptEffort = "low" | "medium" | "high" | "xhigh" | "max";
// OSS只允许本地三档联合。
type OpenAIGptOssEffort = "low" | "medium" | "high";

/** OpenAI GPT models (GPT-5.x, GPT-6) take a nested `reasoning.effort` and reject `minimal`. */
// Record逐个ThinkingLevel列默认GPT effort；类型仅编译期检查表完整。
const OPENAI_GPT_EFFORT: Record<ThinkingLevel, OpenAIGptEffort> = {
	// minimal降成low。
	minimal: "low",
	// low保留。
	low: "low",
	// medium保留。
	medium: "medium",
	// high保留。
	high: "high",
	// xhigh保留。
	xhigh: "xhigh",
	// max保留。
	max: "max",
};

/** gpt-oss takes a flat `reasoning_effort` and only accepts low, medium and high. */
// OSS默认表与GPT不同，仅三个effort值。
const OPENAI_GPT_OSS_EFFORT: Record<ThinkingLevel, OpenAIGptOssEffort> = {
	// minimal映射low。
	minimal: "low",
	// low保留。
	low: "low",
	// medium保留。
	medium: "medium",
	// high保留。
	high: "high",
	// xhigh降成high。
	xhigh: "high",
	// max降成high。
	max: "high",
};

/**
 * 从精确MIME与base64构建AWS image块，返回{source:{bytes},format}，不联网/读文件/修改输入。
 * 例image/jpg与image/jpeg均JPEG，未知MIME抛错，坏base64可抛；不检查实际文件魔数、图像尺寸或重新编码图片。
 */
// 用MIME挑AWS格式并解码base64，返回新image对象，不读取文件/联网。
function createImageBlock(mimeType: string, data: string) {
	// let变量稍后各分支赋值，类型为SDK ImageFormat。
	let format: ImageFormat;
	// MIME精确匹配，不自动转小写或去参数后缀。
	switch (mimeType) {
		// image/jpeg与image/jpg共用格式。
		case "image/jpeg":
		// jpg别名分支。
		case "image/jpg":
			// 选择SDK JPEG常量。
			format = ImageFormat.JPEG;
			// 结束JPEG分支。
			break;
		// png分支。
		case "image/png":
			// 选择PNG格式。
			format = ImageFormat.PNG;
			// 结束PNG分支。
			break;
		// gif分支。
		case "image/gif":
			// 选择GIF格式。
			format = ImageFormat.GIF;
			// 结束GIF分支。
			break;
		// webp分支。
		case "image/webp":
			// 选择WEBP格式。
			format = ImageFormat.WEBP;
			// 结束WEBP分支。
			break;
		// 未列MIME直接失败，不猜测格式或转码。
		default:
			// 错误包含原MIME，不在此裁剪/脱敏它。
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	// source.bytes是base64解码结果，未检查图片实际文件头、尺寸或是否符合声明MIME。
	return { source: { bytes: base64ToBytes(data) }, format };
}

/**
 * 用atob把base64转二进制串再逐字节复制，返回新Uint8Array，无外部修改。
 * 例AQID解为[1,2,3]；坏base64按运行时规则抛错，不做图片解析、解密或UTF-8文字转换。
 */
// base64文字解码为字节数组，返回Uint8Array，不解析图片或加密载荷。
function base64ToBytes(data: string): Uint8Array {
	// atob返回每字符表示一字节的二进制串；坏base64可抛，按运行时atob接受规则处理。
	const binaryString = atob(data);
	// 按二进制串长度分配字节数组。
	const bytes = new Uint8Array(binaryString.length);
	// 逐字符复制，不把二进制串当UTF-8文字再encode。
	for (let i = 0; i < binaryString.length; i++) {
		// charCodeAt取0..255的字节码写入数组。
		bytes[i] = binaryString.charCodeAt(i);
	}
	// 返回新字节数组。
	return bytes;
}

/**
 * Decodes a stored redacted payload. The AWS SDK hands the blob over as bytes, but a
 * persisted session carries it as base64. A hand-edited or externally produced session
 * can hold a signature that is not base64; drop that block instead of failing the
 * whole request.
 */
/**
 * 宽容解码存储的redacted签名，缺值或base64失败返回undefined，成功返回字节，无外部修改/验签。
 * 例坏签名让对应redacted块被历史转换省略，而不是把整轮请求拒绝；解码成功也不证明载荷能被服务端接受。
 */
// 宽容解码存储的加密签名，返回字节或undefined，不解密/验签。
function decodeRedactedContent(signature: string | undefined): Uint8Array | undefined {
	// 缺省/空串直接丢弃此载荷。
	if (!signature) return undefined;
	// 只包base64解码异常。
	try {
		// 复用同一atob字节解码，可能返回零长度字节。
		return base64ToBytes(signature);
		// 错误base64不让整个历史请求失败。
	} catch {
		// 返回undefined，历史转换再省略此redacted块。
		return undefined;
	}
}

/**
 * 把多个字节块按顺序编码成一个base64字符串，无输入修改，不解密内容。
 * 例[1,2]与[3]合成AQID；每32768字节用fromCharCode一次，再整体btoa，避免spread过大且不破坏跨块base64对齐，仍需保存完整二进制串。
 */
// 多个字节块编码一个base64字符串，返回string，不修改原字节数组。
function bytesToBase64(chunks: Uint8Array[]): string {
	// Encrypted reasoning runs to tens of KB, so build the binary string in slices
	// rather than one concatenation per byte. The window stays under the engine's
	// argument-count limit for spread calls.
	// 每片最多32768字节，避免单次spread参数过多；不是总载荷长度限制。
	const WINDOW = 0x8000;
	// 累计二进制串，仍会保留整体文字以便一次btoa。
	let binary = "";
	// 按字节块原顺序处理，未深复制输入。
	for (const chunk of chunks) {
		// 当前字节块再按窗口切片。
		for (let i = 0; i < chunk.length; i += WINDOW) {
			// subarray取视图，...把字节作为fromCharCode参数，追加二进制串；不是把每片独立base64后拼接。
			binary += String.fromCharCode(...chunk.subarray(i, i + WINDOW));
		}
	}
	// 整个二进制串一次btoa，跨块字节边界正确衔接，非模型摘要或解密。
	return btoa(binary);
}
