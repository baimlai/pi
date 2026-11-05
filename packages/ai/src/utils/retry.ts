// 应用层对完整assistant调用做重试：识别暂时故障、有限退避并报告回调；与供应商SDK单次HTTP重试分层。
// 本层依据完整回复的stopReason/errorMessage决策，不直接处理HTTP对象。
import type { AssistantMessage } from "../types.ts";

// 用途：把多个正则片段用或连接并忽略大小写。例["timeout","overloaded"]任一命中即可；输入字符串本身是正则源码，不是自动转义的普通关键词。
function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	// |组成备选模式，i标记忽略大小写；编译一次后多次复用。
	return new RegExp(patterns.join("|"), "i");
}

// 账户额度/计费等不是等几秒能解决的暂时故障，优先排除；即使文本也含429也不重试。
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	// OpenCode Go账户使用上限。
	"GoUsageLimitError",
	// 免费层使用上限。
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	// 月度额度耗尽，短时退避通常无助。
	"Monthly usage limit reached",
	// 账户余额/额度提示归入不可重试类别。
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	// OpenAI等明确报告配额不足。
	"insufficient_quota",
	// 预算已经耗尽。
	"out of budget",
	// 普通配额超限说明。
	"quota exceeded",
	// 涉及计费配置/额度的错误默认不反复请求。
	"billing",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	// 共享订阅额度需较长周期恢复，不当临时限流。
	"subscription_sharing_usage_limit_exceeded",
	// Sign in with ChatGPT on a ChatGPT Business plan: a usage limit set by the
	// workspace admin. Only the admin can raise it.
	// 工作区管理员设定的个人上限，需管理员处理。
	"subscription_sharing_workplace_individual_usage_limit_exceeded",

	// Zhipu/Z.ai (open.bigmodel.cn) error code 1308: the plan's usage limit is
	// reached, sent as HTTP 429. It resets after hours, not seconds (#11537).
	// 匹配Z.ai的1308额度错误，负向前瞻避免把13080之类也当1308。
	'"code"\\s*:\\s*"?1308(?![0-9])',
]);

// 暂时过载、网络中断、传输断流等候选模式；只是分类，实际还要看预算和取消状态。
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	// 服务过载。
	"overloaded",
	// 服务忙状态码式文字。
	"server_busy",
	// 自然语言的当前繁忙说明。
	"servers are currently busy",
	// 临时高负载说明。
	"currently experiencing high demand",
	// 模型当前容量已满。
	"model is at capacity",
	// rate与limit间允许0或1个任意字符，兼容常见分隔写法。
	"rate.?limit",
	// 典型请求频率过高说明。
	"too many requests",
	// Status codes must not be part of a longer word or number, e.g. a request id or byte count (#11057).
	// 只匹配独立状态码，前后不许紧邻字母数字，避免请求id里的数字误触发。
	"(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])",
	// Also matches "The service is temporarily unavailable" (#10965).
	// 兼容service unavailable及带is/temporarily的常见变体。
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",
	// 服务端错误的分隔变体。
	"server.?error",
	// 内部错误的分隔变体。
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264) and gateway wording such as
	// "The upstream provider returned an error" (#10842).
	// 网关转述上游供应商错误。
	"provider.?returned.?(?:an.?)?error",
	// 网关在转发上游重试时缓冲超限。
	"exceeded request buffer limit while retrying upstream",
	// Gateway failure relaying the upstream response stream, sent as an OpenAI
	// Responses `response.failed` event without an error code (#10920).
	// 网关暂时无法转发到上游。
	"unable to forward upstream",
	// Other gateway upstream failures relayed as `response.failed` error codes (#10920).
	// 上游请求失败的常见分隔形式。
	"upstream.?request.?failed",
	// 读取上游流失败。
	"upstream_stream_read_error",
	// 流未正常完成就中断。
	"stream was interrupted",
	// HTTP2或HTTP/2流失败。
	"http/?2 stream failed",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	// 网络层错误。
	"network.?error",
	// 连接层错误。
	"connection.?error",
	// 连接被拒绝。
	"connection.?refused",
	// 连接丢失。
	"connection.?lost",
	// 对端提前关闭连接。
	"other side closed",
	// fetch传输失败的通用文字。
	"fetch failed",
	// node-fetch system errors, e.g. the Google ADC OAuth token refresh used by
	// google-vertex. The reason is often empty (#10996).
	// node-fetch请求失败说明；\\S+在生成的正则里表示非空白目标字符串。
	"request to \\S+ failed, reason:",
	// DNS解析类系统错误。
	"getaddrinfo",
	// 域名未找到的系统错误码。
	"ENOTFOUND",
	// DNS临时失败的系统错误码。
	"EAI_AGAIN",
	// 网关连接上游失败。
	"upstream.?connect",
	// 响应头前连接被重置。
	"reset before headers",
	// socket提前断开。
	"socket hang up",
	// socket连接已关闭。
	"socket connection was closed",
	// 兼容time out和timed out。
	"timed? out",
	// 连续拼写的超时提示。
	"timeout",
	// 请求/流被传输层终止。
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	// WebSocket关闭的常见文字变体。
	"websocket.?closed",
	// WebSocket错误。
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	// 流缺少必需终止事件就结束。
	"ended without",
	// Anthropic消息停止事件前流已结束。
	"stream ended before message_stop",
	// 没有最终响应事件就断流。
	"stream ended before a terminal response event",
	// HTTP2连接未收到响应。
	"http2 request did not get a response",
	// Codex CLI mid-stream disconnect, relayed by proxies that wrap the Codex CLI,
	// e.g. "stream disconnected before completion: stream closed before response.completed" (#11057).
	// 模型流在完成前断开。
	"stream disconnected before completion",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	// HTTP2会话终止导致待发流取消，不一定是用户取消。
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	// 供应商要求过长等待被内层拒绝时，可让外层策略报告/取消。
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	// 供应商明确提示请求可重试。
	"you can retry your request",
	// 自然语言“再试一次”提示。
	"try your request again",
	// 另一种明确重试建议。
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	// gRPC资源不足错误，可能是暂时容量问题。
	"ResourceExhausted",

	// Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
	// failures can arrive mid-stream without an HTTP 503 in the message.
	// 共享订阅使用数据暂不可用，区别于额度已经耗尽。
	"subscription_sharing_usage_unavailable",
	// 共享订阅用户数据暂不可用。
	"subscription_sharing_user_unavailable",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * `maxAgentDelayMs` caps each computed delay and defaults to 60 seconds.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
// 应用层重试策略：开关、额外次数和指数退避设置；maxRetries不含初始调用。
export interface RetryPolicy {
	// false时仍做初始produce，只是不追加重试。
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	// 额外重试预算，例如2表示初始一次加最多两次重试。
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	// 第一次重试等待的基础毫秒数，之后按2的幂增长。
	baseDelayMs: number;
	/** Optional cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	// 应用层单次退避上限；不改变供应商SDK重试上限。
	maxAgentDelayMs?: number;
}

// 应用层默认最大退避为60秒。
export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

// 用途：计算第attempt次重试等待。Pick只取策略中需要的两字段；例基础1000ms时第1/2/3次为1000/2000/4000，再受上限钳制，不在此启动计时器。
export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	// **是幂运算；attempt从1计数，减1后首轮不翻倍，负数指数被钳到0。
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	// 指数过大或出现非安全整数时用最大安全整数，再交后面上限约束。
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	// 取算得等待与配置上限较小值，未配置上限用默认60秒。
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
// 重试过程通知，可同步或异步；本模块会await它们，供UI显示等待/重试/结束。
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	// 开始每次退避前通知：告诉外部第几次、总预算、等待长度与原因。
	onRetryScheduled?: (
		// 当前重试序号，从1开始，不是总请求次数。
		attempt: number,
		// 策略允许的额外重试次数上限。
		maxAttempts: number,
		// 本次计算出的等待毫秒数。
		delayMs: number,
		// 导致本次重试的可读错误说明。
		errorMessage: string,
		// 回调可直接完成或返回Promise；联合类型兼容两种写法。
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	// 退避等完、重新调用produce之前的通知。
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	// 已有重试后最终退出时通知成功与否、最后次数和可选错误。
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

// 内部专门标记退避被取消的错误，方便与回调/其他异常区分。
class RetrySleepAbortError extends Error {
	// 用途：构造退避取消标记；只内部使用，不代表供应商HTTP错误。
	constructor() {
		// 初始化父类Error，保留instanceof可识别的内部类别。
		super("Aborted");
	}
}

// 用途：内部可取消等待。例退避过程中用户取消，reject专用RetrySleepAbortError，外层据此返回aborted消息；不直接重试模型。
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	// 将定时器成功与取消失败包装成可await的Promise。
	return new Promise((resolve, reject) => {
		// 进入等待前已取消，立即拒绝而不是再等退避时间。
		if (signal?.aborted) {
			// 用专用类别区分这次拒绝来自退避取消。
			reject(new RetrySleepAbortError());
			// 结束当前函数分支，不再继续安排计时器/其他工作。
			return;
		}
		// 安排等待到期后完成Promise，timeout句柄供取消回调清理。
		const timeout = setTimeout(resolve, ms);
		// 没有信号时仅等待；有信号时监听一次取消。
		signal?.addEventListener(
			// 监听标准取消事件名。
			"abort",
			// 取消时运行的匿名回调，闭包持有本次计时器句柄。
			() => {
				// 取消尚未到期的定时器。
				clearTimeout(timeout);
				// 用专用类别区分这次拒绝来自退避取消。
				reject(new RetrySleepAbortError());
			},
			// 取消触发一次后自动移除此监听；原实现正常到期时未主动移除监听，不能在注释中声称已清理。
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
// 用途：重试“会生成一条完整AssistantMessage”的调用。例暂时断网回复error，等待后produce再次请求；成功/不可重试/耗尽预算直接返回，退避取消转aborted消息。produce直接抛异常时不由此循环兜底转换。
export async function retryAssistantCall(
	// 每次调用都应重新产生一条回复；必须传函数以便真正发起下一次尝试。
	produce: () => Promise<AssistantMessage>,
	// 未提供或enabled=false时不追加重试。
	policy: RetryPolicy | undefined,
	// 控制本模块的退避等待；实际模型请求仍由produce自己接好取消信号。
	signal: AbortSignal | undefined,
	// 可选过程通知，可能异步并会影响本流程等待。
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// 启用时取额外预算，否则设0，但初始produce照样执行。
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	// 尚未安排任何额外重试，计数从0开始。
	let attempt = 0;
	// 只有真正安排过重试后才记录，避免首轮成功也误发重试结束事件。
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	// 持续尝试，直到return最终回复或某个未处理异常向外抛出。
	for (;;) {
		// 先得到一条完整回复，本循环依据stopReason判断，不按字流片段做重试决策。
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		// 取消是终止状态，不能自动再请求模型违背用户取消。
		if (response.stopReason === "aborted") {
			// 之前确实有重试才通知失败结束；?.允许没有回调。
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			// 直接把当前完整回复交还调用方，保留其内容、用量等字段。
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		// 非error且此前已排除aborted，视为一次正常返回，不强制要求stopReason=stop。
		if (response.stopReason !== "error") {
			// 重试后成功才通知success=true。
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			// 直接把当前完整回复交还调用方，保留其内容、用量等字段。
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		// 预算耗尽或属于确定性失败时不再继续，避免无意义费用/等待。
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			// 已有重试但最终失败，附最后错误说明。
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			// 直接把当前完整回复交还调用方，保留其内容、用量等字段。
			return response;
		}

		// 准备安排一次新的额外尝试，从这里开始编号1。
		attempt++;
		// 保留这次失败原因供等待UI和最终取消时使用。
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		// 能到这里代表已启用策略且有预算，!只表达这个已知条件，不验证policy。
		const delayMs = retryDelayMs(policy!, attempt);
		// 先通知“即将等待”，UI可显示重试倒计时。
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		// 专门捕获退避期间取消及相关错误，区别于produce本身的返回状态。
		try {
			// 等待完才发下一次请求，用户可在这段时间取消。
			await sleep(delayMs, signal);
			// 等待拒绝时先收尾通知，再判断能否转成统一取消消息。
		} catch (error) {
			// 重试尚未实际发出，但已安排过，仍需要通知结束。
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			// 只把本模块专用退避取消转为aborted；其他异常不能伪装取消。
			if (error instanceof RetrySleepAbortError) {
				// 解构丢掉旧errorMessage，保留回复其他字段，避免取消消息仍带旧失败原因。
				const { errorMessage: _errorMessage, ...rest } = response;
				// 返回统一的取消回复形状，不再向调用者抛内部等待标记。
				return { ...rest, stopReason: "aborted" };
			}
			// 非预期等待异常继续向外传播，不默默吞掉。
			throw error;
		}
		// 退避正常结束，通知即将开始新尝试；下一次循环再调用produce。
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
// 用途：只分类一条失败回复是否像暂时故障。例额度耗尽即使含429也false，timeout可true；调用方仍需先独立处理上下文溢出、次数预算和退避。
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	// 正常/取消消息或缺少错误说明不能仅靠猜测决定重试。
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	// 保存已确认存在的错误文字，便于多次匹配。
	const errorMessage = message.errorMessage;
	// 额度、账单等长期限制优先排除，避免与通用限流文字冲突。
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	// 命中暂时故障模式才返回true；没有模式依据则不默认重试。
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
