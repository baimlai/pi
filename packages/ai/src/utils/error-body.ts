// 不同供应商 SDK 把 HTTP 失败正文放在不同字段；本模块统一提取状态/正文，避免只剩“403 没有正文”这类无法排查的信息。
// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

// 截断大响应体时让短片段拥有独立存储，尽量不因错误说明保留整个大字符串。
import { ownedSlice } from "./text.ts";

// 展示的正文最多保留4000个字符；这是本地诊断长度上限，不是模型上下文上限。
export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

// 统一错误形状：HTTP状态、可用正文、SDK说明，以及说明中是否已经有正文。
export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	// 可选HTTP状态；网络连接失败可能没有任何HTTP响应。
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	// 从SDK字段中找到、去空白并截断后的正文，没找到则缺省。
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	// 始终提供最基本的错误说明；异常不一定是标准 Error。
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	// true 表示不用另拼一份正文，包括根本没有可提取正文的情况。
	messageCarriesBody: boolean;
}

// 交叉类型只描述可能见到的SDK额外字段；字段来自外部错误，所以具体内容仍用 unknown。
type SdkErrorShape = Error & {
	// 某些SDK把HTTP状态放这里，后面要检查是否真是 number。
	statusCode?: unknown;
	// 另一类SDK使用 status 字段。
	status?: unknown;
	// Mistral等SDK可能保留原始正文字符串。
	body?: unknown;
	// OpenAI类SDK可能在 error 字段存已解析的JSON正文。
	error?: unknown;
	// AWS样式元数据里的状态码，外层对象和字段都可缺失。
	$metadata?: { httpStatusCode?: unknown };
	// AWS原始响应可能保留状态和正文流，不能不分情况全部JSON化。
	$response?: { statusCode?: unknown; body?: unknown };
};

// 用途：把外部异常整理成统一普通数据。例 Error 附 status=403、error={message:"拒绝"} 会提取状态和JSON正文；只提取信息，不发请求、不写日志。
export function normalizeProviderError(error: unknown): NormalizedProviderError {
	// 抛出值边界：throw 可以抛字符串/数字/对象，不保证是 Error。
	if (!(error instanceof Error)) {
		// 非Error无法按SDK字段可靠探测，先安全转成说明文字。
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	// 断言只允许TS查看SDK可选字段，真正值是否可用由后面的检查判断。
	const sdkError = error as SdkErrorShape;
	// 按已知SDK字段优先级寻找第一个数字状态码。
	const status = extractStatus(sdkError);
	// 找合适的正文，排除流/实例噪声，并限制展示长度。
	const body = extractBody(sdkError);
	// 没正文或 message 已包含它时，不要在展示时重复拼正文。
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		// 对象简写保留提取到的HTTP状态。
		status,
		// 对象简写保留已处理正文。
		body,
		// 保留SDK原本提供的错误说明，不主动抹掉。
		message: error.message,
		// 把是否需要额外拼正文的判断一起返回。
		messageCarriesBody,
		// satisfies 让TS检查对象符合接口，不会在运行时插入校验或改值。
	} satisfies NormalizedProviderError;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
// 用途：从SDK错误提取HTTP状态，优先 statusCode→status→metadata→response；例同时有statusCode=400和status=500时取400，无匹配则undefined。
function extractStatus(error: SdkErrorShape): number | undefined {
	// 外部字段先验证实际类型，再视为可用状态。
	if (typeof error.statusCode === "number") return error.statusCode;
	// 第一来源不可用时尝试OpenAI/Google常见字段。
	if (typeof error.status === "number") return error.status;
	// ?. 允许没有metadata时跳过访问。
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	// 最后尝试原始响应对象上的状态。
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	// 没有可靠结果时明确返回缺失，不猜测一个HTTP状态或正文值。
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
// 用途：挑选可用正文、去首尾空白并截断。例 body="  denied  " 得 denied；空正文保持undefined，不冒充有诊断内容。
function extractBody(error: SdkErrorShape): string | undefined {
	// 先按SDK结构找到候选文字，而不是直接JSON.stringify整个错误实例。
	const bodyText = pickBodyText(error);
	// 没有可用正文时尽早结束。
	if (bodyText === undefined) return undefined;
	// 只去首尾空白，正文内部换行等仍保留。
	const trimmed = bodyText.trim();
	// 空白正文也视为无正文。
	if (trimmed.length === 0) return undefined;
	// 防止巨大网关响应体挤满错误说明。
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

// 用途：按原body字符串、error对象、response.body的顺序选正文。例AWS响应流不读取/序列化，避免把_stream内部字段当错误原因；不消费网络流。
function pickBodyText(error: SdkErrorShape): string | undefined {
	// 最直接的原始HTTP正文优先。
	if (typeof error.body === "string") return error.body;
	// 已解析JSON对象可安全转成展示文字；空对象不提供有用信息。
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	// 保存可选原始响应体字段，避免重复访问。
	const responseBody = error.$response?.body;
	// 正文已经是字符串时直接使用。
	if (typeof responseBody === "string") return responseBody;
	// 流对象不是已读正文，不能靠JSON化得到真实内容。
	if (isReadableStreamLike(responseBody)) return undefined;
	// 只有普通非空对象才作为已解析JSON正文处理。
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	// 没有可靠结果时明确返回缺失，不猜测一个HTTP状态或正文值。
	return undefined;
}

// 用途：识别Node风格带pipe的响应流。例SDK原始IncomingMessage会被排除；这是未知SDK字段的形状识别，不是完整流协议校验。
function isReadableStreamLike(value: unknown): boolean {
	// 逐步收窄unknown后才读取pipe，避免null或原始值访问错误。
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
// 用途：仅接受普通非空对象作JSON正文。例 {message:"x"} 为true，{}、数组、Error、流包装类为false；支持 Object.create(null) 生成的无原型对象。
function isPlainNonEmptyObject(value: unknown): boolean {
	// 外部字段必须先是非null对象。
	if (typeof value !== "object" || value === null) return false;
	// 查看原型，区分普通JSON对象和SDK自定义实例。
	const proto = Object.getPrototypeOf(value);
	// 只允许普通对象原型或无原型，数组等其他实例都排除。
	if (proto !== Object.prototype && proto !== null) return false;
	// 至少有一个可枚举自有字段才算有展示价值。
	return Object.keys(value).length > 0;
}

/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
// 用途：把统一错误格式化为界面文字。例状态403、正文denied、前缀Gateway得到“Gateway (403): denied”；已有正文的原message不重复显示。
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	// 原说明已足够，或缺少状态/正文时，优先保持message而非拼不完整片段。
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		// 有前缀且有状态时，可加一个清晰来源头。
		return prefix !== undefined && norm.status !== undefined
			? // 保留SDK说明，前面加供应商/接口前缀和状态。
				`${prefix} (${norm.status}): ${norm.message}`
			: // 缺少前缀或状态则直接返回原说明。
				norm.message;
	}
	// 原说明未含可用正文时，改用状态加正文，按需加前缀。
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

// 用途：给长诊断文字截取前 maxChars 并报告省略字符数。例长5000、上限4000，会保留前4000并标记省略1000；不是按UTF-8字节裁剪。
export function truncateErrorText(text: string, maxChars: number): string {
	// 短文字原样返回，避免无意义附加截断提示。
	if (text.length <= maxChars) return text;
	// 使用独立存储片段并附实际省略长度，便于排查输出是否完整。
	return `${ownedSlice(text, 0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

// 用途：未知抛出值安全转字符串。例循环对象JSON化失败时退回String(value)，undefined也有可读表示；不抛出JSON序列化本身的异常。
export function safeJsonStringify(value: unknown): string {
	// JSON化可能因为循环引用等原因失败，需要捕获这个外部数据边界。
	try {
		// 尽量保留对象字段，便于看见SDK错误正文。
		const serialized = JSON.stringify(value);
		// JSON.stringify(undefined/function)可能无结果，退回常规字符串转换。
		return serialized === undefined ? String(value) : serialized;
		// 序列化失败时走最小兜底，不让错误显示逻辑再报一次错。
	} catch {
		// 常见对象退为 [object Object] 等文字，至少能继续报告原失败。
		return String(value);
	}
}
