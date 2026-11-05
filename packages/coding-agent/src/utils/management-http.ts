// 为版本检查、目录和下载等管理请求做有限即时重试；聊天生成另有语义重试，不能直接混用。
// Parameters 提取函数参数元组，[0] 取 fetch 首参数类型，避免另抄一份 URL/Request/string 联合。
type FetchInput = Parameters<typeof fetch>[0];

// 只把这组 HTTP 状态视作可重试；例如 429 会重试，404 不会，最后一次仍返回响应供调用方检查。
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 管理请求重试选项：次数与 HTTP 状态策略独立于总体/单次超时；所有字段都可省略。 */
export interface FetchRetryOptions {
	/** Number of additional attempts after the initial request. Defaults to two. */
	// 默认额外两次，即初始一次加两次重试；不是总共只请求两次。
	maxRetries?: number;
	/** Retry transient HTTP responses as well as transport failures. Defaults to true. */
	// false 只关闭按 HTTP 状态重试，网络抛错的重试规则仍然存在。
	retryOnStatus?: boolean;
	/** Overall time budget shared by all attempts. */
	// 一份信号贯穿所有尝试；依赖 fetch 等下层配合信号，不是强制终止任意不响应信号的 Promise。
	timeoutMs?: number;
	/** Per-attempt timeout. A new timeout is created for every attempt. */
	// 每轮重新计时；只因本轮信号超时且父/总体未取消时，还允许后续重试。
	attemptTimeoutMs?: number;
}

/**
 * Fetch a management HTTP resource with a bounded immediate retry.
 *
 * This is intentionally a transport-level helper for idempotent management
 * requests (version checks, catalogs, and downloads). It must not be used for
 * agent/model operations: those can fail after the HTTP request starts and are
 * retried by their semantic caller instead.
 *
 * Caller cancellation and timeoutMs are terminal. attemptTimeoutMs aborts
 * only the current attempt so a hung connection can be retried.
 */
/**
 * 发管理请求，按选项立即重试，无额外退避；例：maxRetries:2 遇两次 503 后第三次 200，返回第三个 Response。
 * 调用方取消或总体超时停止后续重试；最后的非成功 HTTP 响应仍可正常返回，调用者要检查 response.ok。
 * 本函数返回响应而非已读完的 JSON，调用方后续 response.json() 的解析失败不在此重试循环里。
 */
export async function fetchWithRetry(
	// 与原生 fetch 相同的首参数类型，允许 URL、字符串或 Request。
	input: FetchInput,
	// 显式 undefined 默认值保留原接口；信号、请求头等从这里传入。
	init: RequestInit | undefined = undefined,
	// 省略 options 时创建空选项对象，后面逐项决定默认值。
	options: FetchRetryOptions = {},
): Promise<Response> {
	// 归一化“额外尝试次数”，而不是校验 TS 已保证的 number 类型；NaN/Infinity 仍不适合作次数。
	const maxRetries =
		// 未给次数或不是有限数字，统一默认额外两次。
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: // 小数向下取整，负数钳到零；例如 2.9 变 2，-1 变 0。
				Math.max(0, Math.floor(options.maxRetries));
	// ?? 保留明确 false，不能用 || 使关闭状态重试的选项失效。
	const retryOnStatus = options.retryOnStatus ?? true;
	// RequestInit.signal 也允许 null，这里统一成信号或 undefined。
	const parentSignal = init?.signal ?? undefined;
	// 总体定时器只创建一次，下一轮继续使用剩余预算，而非每轮重置。
	const timeoutSignal =
		// 只对正值启用；AbortSignal.timeout 自己还会约束参数的有效范围。
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	// 单次超时先只保留时长，信号在每轮循环内新建。
	const attemptTimeoutMs =
		options.attemptTimeoutMs !== undefined && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	// 从零开始计数：0 是初始尝试，attempt==maxRetries 时已来到最后允许的一次。
	for (let attempt = 0; ; attempt++) {
		// 取消/总体超时发生在重试间隙时，下一轮一开始就停止。
		parentSignal?.throwIfAborted();
		// 这两行在下面 try 外，取消原因直接向调用者传播。
		timeoutSignal?.throwIfAborted();
		// 每轮新建，因此第一轮的单次超时不会自动使第二轮也已超时。
		const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
		// 组合可能不存在的三个来源，先去掉 undefined。
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			// 类型谓词让 filter 后的元素类型变成 AbortSignal。
			(signal): signal is AbortSignal => signal !== undefined,
		);
		// 多个信号用 any：任一个取消就取消本次请求；单个直接复用，没有则 undefined。
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

		try {
			// 仅需要合并信号时复制 init；Response 到达不表示响应正文已全部消费。
			const response = await fetch(input, signal ? { ...init, signal } : init);
			// 同时满足开关、状态在集合内、还有次数才重试，三项缺一就返回这次响应。
			const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
			// 非 2xx 也可能走这里返回；helper 不对每个 HTTP 错误自动 throw。
			if (!shouldRetry) return response;
			try {
				// 即将丢弃响应，取消其 body 消费，尽量释放连接资源，再开始下一次请求。
				await response.body?.cancel();
			} catch {
				// 清理失败不应遮住原本要重试的状态响应。
				// The response is being discarded before a retry. There is nothing useful to
				// do if cancelling its body also fails.
			}
		} catch (error) {
			// 单次超时只有在父信号/总体仍正常时才算可重试；多个信号同时取消时终止优先。
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
			// 以下任一终止条件满足，就把原错误向上抛；否则循环立即进入下一次尝试。
			if (
				// 用户取消不可用新请求抵消。
				parentSignal?.aborted ||
				// 总体预算耗尽，不能再给一轮单次超时继续跑。
				timeoutSignal?.aborted ||
				// 外部抛出值可能不是 Error，在错误边界确认后才读取 name。
				(error instanceof Error &&
					// 处理未能归因为本轮超时的 AbortError。
					error.name === "AbortError" &&
					// 已确认是本轮单次超时则不因这个分支终止。
					!attemptTimedOut &&
					// 原规则只有没有总体信号时，把这种额外 AbortError 直接当终止；不将其概括成所有 AbortError 都重试/都停止。
					timeoutSignal === undefined) ||
				// 最后一次失败没有可用次数，保留其原始错误。
				attempt >= maxRetries
			) {
				// 不包装错误，调用方可以辨认原取消原因或网络异常。
				throw error;
			}
		}
	}
}
