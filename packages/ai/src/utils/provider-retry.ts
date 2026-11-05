// 围住一次供应商SDK请求的可取消重试层；不同于Agent整条回答重试，调用方要关闭SDK自身重试以避免重试层叠加。
// 默认不接受服务器要求超过60秒的等待；数字中的下划线只是提高可读性，不影响数值。
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

// 本模块内部请求重试选项，不是Agent整个任务的重试配置。
interface ProviderRetryOptions {
	// 额外重试次数，初始请求不算一次重试。
	maxRetries?: number;
	// 服务器指定等待的上限，缺省60000；设0表示关闭该上限检查。
	maxRetryDelayMs?: number;
	// 可选取消信号，既在错误后检查，也用于打断退避等待。
	signal?: AbortSignal;
	/** HTTP statuses that fail at once although the default policy would retry them. */
	// 调用方可声明某些HTTP状态立即失败，覆盖默认可重试策略。
	noRetryStatuses?: readonly number[];
}

// 已知SDK错误形状，继承标准Error，再提供状态和响应头。
interface ProviderError extends Error {
	// 未收到HTTP响应的连接错误可能没有状态码。
	status: number | undefined;
	// 重试提示头可能缺失，读取时用?.。
	headers: Headers | undefined;
}

// 用途：识别外部SDK错误是否满足本重试器需要的形状。例普通Error但没status/headers字段不会当SDK重试错误；类型谓词通过后才能安全读响应头。
function isProviderError(error: unknown): error is ProviderError {
	// 先检查Error实例与必要字段存在，这是未知SDK抛出值的信任边界。
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		// status可无值，但有值必须是数字。
		(error.status === undefined || typeof error.status === "number") &&
		// 响应头有值时必须是标准Headers，才支持get方法。
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
// 用途：按固定SDK兼容策略判定是否暂时失败。服务器x-should-retry优先；无状态视为连接类失败，408/409/429/5xx可重试，不在这里决定次数或等待。
function isRetryableProviderError(error: ProviderError): boolean {
	// 先读取服务器明确的重试指示头。
	const shouldRetry = error.headers?.get("x-should-retry");
	// 服务器明确要求重试时优先于常见状态分类。
	if (shouldRetry === "true") return true;
	// 明确禁止重试也优先，即使状态看起来是5xx。
	if (shouldRetry === "false") return false;

	// 无HTTP状态一般是连接/传输失败，按此兼容策略允许重试。
	if (error.status === undefined) return true;
	return (
		// 请求超时可重试。
		error.status === 408 ||
		// 冲突状态按SDK兼容策略可重试。
		error.status === 409 ||
		// 限流通常需要等待后重试，调用方仍可通过noRetryStatuses排除。
		error.status === 429 ||
		// 服务器5xx及以上按既有SDK策略处理；这里原有typeof检查保持不变。
		(typeof error.status === "number" && error.status >= 500)
	);
}

// 用途：限制供应商要求的等待长度，返回原延迟或抛可读错误。例服务器要求120秒而上限60秒就立即失败；maxRetryDelayMs=0不限制。
function validateServerRetryDelayMs(
	// 服务器头解析得到的候选毫秒数；有限性在调用处已经检查。
	delayMs: number,
	// 调用方覆盖上限，可以省略。
	maxRetryDelayMs: number | undefined,
	// 原供应商错误文字，超过上限时一起附上，避免丢失根因。
	providerErrorMessage: string,
	// 此函数同步只返回一个等待值，没有计时器或网络操作。
): number {
	// 缺省使用60000，显式0会被保留。
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	// 只在开启上限且实际超出时拒绝；不把0误当缺省。
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		// 把过大等待转成错误交上层，它可以显示原因或施加自己的外层策略。
		throw new Error(
			// 毫秒换算秒并向上取整用于提示，保留原错误细节。
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	// 通过限制后不改写服务器给出的等待值。
	return delayMs;
}

// 用途：先读retry-after-ms，再读retry-after秒数/HTTP日期，否则指数退避加抖动。例首轮默认约375到500ms；服务器值超上限由上面函数抛错。
function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	// 优先使用明确的毫秒重试头。
	const retryAfterMs = error.headers?.get("retry-after-ms");
	// 有非空头值才解析。
	if (retryAfterMs) {
		// 按浮点数解析毫秒，可以接收字符串形式数值。
		const value = Number.parseFloat(retryAfterMs);
		// 有效有限数字就采用；NaN/Infinity继续尝试其他策略。
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	// 标准retry-after既可能是秒数，也可能是日期。
	const retryAfter = error.headers?.get("retry-after");
	// 有值才计算标准头等待。
	if (retryAfter) {
		// 先尝试把头当数字秒数。
		const seconds = Number.parseFloat(retryAfter);
		// 数值解析失败时当绝对日期，减当前时间得到剩余等待；秒数则乘1000。
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		// 日期或秒数最终仍须是有限值；过去日期可能负值，下方sleep会钳制为0。
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	// 无可用服务器提示时，从0.5秒按2的幂递增，最多8秒；retryIndex从0开始。
	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	// 随机缩短0到25%，分散同时重试的请求；不是每次都恰好等待同样时间。
	return exponentialDelay * (1 - Math.random() * 0.25);
}

// 用途：创建本层统一取消错误，name=AbortError。例等待期间取消会抛它；与传入signal.reason不同，这里使用固定文案。
function createAbortError(): Error {
	// 构造普通Error实例。
	const error = new Error("Request aborted");
	// 用约定错误名供上层区分取消与服务错误。
	error.name = "AbortError";
	// 交给调用处reject/throw，而非在这里直接抛出。
	return error;
}

// 用途：可取消的退避等待。例服务器要求5秒但用户1秒后取消，立即拒绝并清掉定时器；不传signal则正常等完。
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	// 用Promise把计时器成功和取消失败包装成await可用接口。
	return new Promise((resolve, reject) => {
		// 开始前已取消时不安排定时器。
		if (signal?.aborted) {
			// 以本层统一AbortError拒绝等待。
			reject(createAbortError());
			// 该分支已结束等待安排，不再继续注册其他步骤。
			return;
		}

		// 等待中取消会执行此回调。
		const onAbort = () => {
			// 清掉定时器，避免稍后再通知成功。
			clearTimeout(timeout);
			// 以本层统一AbortError拒绝等待。
			reject(createAbortError());
		};
		// 安排正常到期的成功分支。
		const timeout = setTimeout(
			// 时间到了后先清监听再完成Promise。
			() => {
				// 成功后不再保留取消回调。
				signal?.removeEventListener("abort", onAbort);
				// 成功只表示等待结束，没有返回正文值。
				resolve();
			},
			// 过去日期等负等待归0，立刻进入下一轮。
			Math.max(0, ms),
		);
		// 有信号才注册取消；once使触发后自动解除。
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
// 用途：用有限次数重新发起一次SDK请求。例maxRetries=2最多调用request三次；请求成功直接返回T，不符合SDK错误形状/策略就原样抛，重试等待可取消。
export async function retryProviderRequest<T>(
	// 传“每次重新发起请求”的函数，不是已经创建的一份Promise，否则重试无法真正重发。
	request: () => Promise<T>,
	// 省略配置就不额外重试，其他选项取各自默认。
	options: ProviderRetryOptions = {},
	// 泛型T保留成功请求的返回类型，async使调用者用await取得它。
): Promise<T> {
	// 额外重试预算默认0，初始请求仍会执行。
	const maxRetries = options.maxRetries ?? 0;
	// 剩余可重试次数，失败决定重试时才扣减。
	let retriesRemaining = maxRetries;

	// 省略三部分的for是无限循环，成功return或不可重试throw负责退出。
	for (;;) {
		// 捕获一次实际SDK请求失败，供策略分类。
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			// 每轮调用工厂重新创建SDK请求；await使异步拒绝进入当前catch。
			return await request();
			// 外部SDK异常按unknown处理，先判断取消再判断重试资格。
		} catch (error) {
			// 用户取消优先，不能因为连接错误恰好可重试就忽略取消。
			if (options.signal?.aborted) throw createAbortError();
			// 预算耗尽、未知错误形状、或策略禁止，都不吞错继续循环。
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;
			// 调用方明确排除的状态立即失败，覆盖默认可重试分类。
			if (error.status !== undefined && options.noRetryStatuses?.includes(error.status)) throw error;

			// 算本次退避序号，首次重试为0。
			const retryIndex = maxRetries - retriesRemaining;
			// 确实决定重试后扣一份预算。
			retriesRemaining--;
			// 计算等待并可取消地等完，然后for下一轮才重新调用request。
			await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
		}
	}
}
