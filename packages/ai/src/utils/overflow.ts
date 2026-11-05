// 识别上下文/请求体过大与可恢复的输出截断；返回分类结果供会话层决定压缩，不在此调用模型或删除历史。
// 读取完整回复的停止原因、错误文字和usage；类型不能保证供应商所有错误措辞都已被识别。
import type { AssistantMessage } from "../types.ts";

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window or the provider's request byte-size limit.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - LiteLLM pre-call check: "litellm.ContextWindowExceededError: ... Context Window exceeded for given call."
 * - OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)."
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - GitHub Copilot: 'github-copilot API error (413): {"message":"failed to parse request","code":""}'
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: `{"code":"1261","message":"Prompt too long"}`, `{"code":"1261","message":"Prompt exceeds max length"}` (CN endpoint), or silent overflow via usage.input > contextWindow
 * - Xiaomi MiMo: Truncates input to fill contextWindow exactly, then returns finish_reason "length"
 *   with output=0 (no room left to generate). Detected via stopReason "length" + zero output +
 *   input filling the context window.
 * - DashScope/Qwen: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)
 * - Ollama: Some deployments truncate silently, others return errors like "prompt too long; exceeded max context length by X tokens"
 */
// 已知供应商“输入太大”错误正则表；它只做启发式分类，不是真正精确token计数器。
const OVERFLOW_PATTERNS = [
	// 匹配prompt too long及prompt is too long；(?:...)是不捕获分组，?表示这段可省略，i忽略大小写。
	/prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
	// Z.ai中文区域端点常见英文错误措辞。
	/prompt exceeds max length/i, // z.ai CN endpoint token overflow
	// 这是请求字节大小超限，也可能不是token窗口满，但同样归为输入过大。
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	// Bedrock的模型输入长度错误。
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	// 兼容有无the/model's与两种数值写法，[\d,]+允许带千位逗号的数字。
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
	// LiteLLM在实际发请求前也可能报告此类错误。
	/context window exceeded/i, // LiteLLM pre-call check (ContextWindowExceededError)
	// Google通常在两段固定文字之间插入实际token数，.*匹配中间内容。
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	// xAI报告最大提示长度后跟数字。
	/maximum prompt length is \d+/i, // xAI (Grok)
	// Groq提示减少消息长度，视为上下文过大线索。
	/reduce the length of the messages/i, // Groq
	// OpenRouter转述多数后端窗口限制的措辞。
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	// Poolside允许the可选、token单复数可选。
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	// 括号需要在正则里转义；匹配Together同时给出输入与模型窗口的文字。
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	// Copilot常见token数量超过限制说明。
	/exceeds the limit of \d+/i, // GitHub Copilot
	// llama.cpp服务提示可用上下文不足。
	/exceeds the available context size/i, // llama.cpp server
	// LM Studio保留前缀等操作可能超过窗口。
	/greater than the context length/i, // LM Studio
	// MiniMax的窗口越界措辞。
	/context window exceeds limit/i, // MiniMax
	// Kimi报告请求超过模型token上限。
	/exceeded model token limit/i, // Kimi For Coding
	// Mistral报告输入过大并给模型最大长度。
	/too large for model with \d+ maximum context length/i, // Mistral
	// DS4同时报告实际输入与配置窗口；数字支持逗号分组。
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	// Z.ai非标准停止原因被适配成错误文字后仍可识别。
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	// Ollama明确报错可识别；其静默截断并不能仅靠本模式检测。
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	// DashScope输入长度范围错误。
	/range of input length should be/i, // DashScope / Qwen Token Plan
	// 通用兼容：词间允许下划线或空格。
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	// 宽泛兜底，后面必须先排除可能同样含此文字的限流错误。
	/too many tokens/i, // Generic fallback
	// 另一类通用token数量超限说明。
	/token limit exceeded/i, // Generic fallback
	// HTTP 413 means request-size overflow regardless of provider or body text.
	// Match raw SDK errors and formatProviderError's prefix, not a status mentioned in the body.
	// ^限定错误头部出现HTTP413，避免只因正文顺带提到413就误判。
	/^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];

// Cerebras特例：400/413且SDK没保留正文，不能给所有供应商的任意400都判上下文溢出。
const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
 * Error messages matching any of these are excluded from overflow detection
 * even if they also match an OVERFLOW_PATTERN.
 *
 * Example: Bedrock formats throttling errors as "ThrottlingException: Too many tokens,
 * please wait before trying again." which would match the /too many tokens/i overflow
 * pattern without this exclusion.
 */
// 先排除已知限流/临时服务错误；这些词可能也含too many tokens，不能立即压缩。
const NON_OVERFLOW_PATTERNS = [
	// Bedrock格式化前缀明确表示限流或不可用，不是窗口满。
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
	// 按时间单位的请求/用量限制，应走退避等处理而非缩短上下文。
	/rate limit/i, // Generic rate limiting
	// 请求次数过多，同样不当成上下文溢出。
	/too many requests/i, // Generic HTTP 429 style
];

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles three cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern.
 * 2. Silent overflow: Some providers accept overflow requests and return
 *    successfully. For these, we check if usage.input exceeds the context window.
 * 3. Length-stop overflow: Xiaomi MiMo can return "length" with zero output when
 *    the input fills the context window.
 *
 * ## Reliability by Provider
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum" or "request_too_large"
 * - OpenAI (Completions & Responses): "exceeds the context window", "exceeds the model's maximum context length of X tokens", or "exceeds model's maximum context length (X)"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - GitHub Copilot: HTTP 413 "failed to parse request" (request byte-size overflow)
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter (most backends): "maximum context length is X tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - DashScope/Qwen: "Range of input length should be [1, X]"
 * - z.ai: "Prompt too long"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),
 *   sometimes returns rate limit errors. Pass contextWindow param to detect silent overflow.
 * - Xiaomi MiMo: Truncates input to fit contextWindow then returns stopReason "length" with
 *   output=0. Pass contextWindow param to detect via the "filled context + zero output" signal.
 * - Ollama: May truncate input silently for some setups, but may also return explicit
 *   overflow errors that match the patterns above. Silent truncation still cannot be
 *   detected here because we do not know the expected token count.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size for detecting silent overflow (z.ai)
 * @returns true if the message indicates a context overflow
 */
// 用途：合并三种线索判断输入过大：已知错误文本、成功但用量越窗、输入填满窗口且输出0的length。例stop且input+cacheRead>window也返回true；没有窗口数时只能查文字。
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// Case 1: Check error message patterns
	// 错误文字检测只适用于确实失败且有说明的回复，避免把成功正文当错误匹配。
	if (message.stopReason === "error" && message.errorMessage) {
		// Skip messages matching known non-overflow patterns (e.g. throttling / rate-limit)
		// some只要一条排除模式命中就为true；!表示外层已保证errorMessage存在。
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		// 明确的限流/服务暂不可用不再落入宽泛too many tokens兜底。
		if (!isNonOverflow) {
			// 任一已知输入过大模式命中即可分类为溢出。
			if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
				// 找到至少一种足够的输入过大/窗口耗尽线索，交由调用者决定恢复动作。
				return true;
			}
			// 没有正文的400/413只在Cerebras身份下采用此特殊判断。
			if (message.provider === "cerebras" && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(message.errorMessage)) {
				// 找到至少一种足够的输入过大/窗口耗尽线索，交由调用者决定恢复动作。
				return true;
			}
		}
	}

	// Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
	// 有窗口上限且模型正常结束时，再检测供应商是否静默接收了超窗口输入。
	if (contextWindow && message.stopReason === "stop") {
		// 输入上下文包括普通输入与缓存读取token；不能只看usage.input。
		const inputTokens = message.usage.input + message.usage.cacheRead;
		// 成功回复报告输入仍超窗，认为需要压缩，但这不等于必须重试已完成回答。
		if (inputTokens > contextWindow) {
			// 找到至少一种足够的输入过大/窗口耗尽线索，交由调用者决定恢复动作。
			return true;
		}
	}

	// Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates oversized input
	// to fit the context window, leaving no room for output. Returns stopReason "length"
	// with output=0 and input+cacheRead filling the context window.
	// 部分模型把输入塞满窗口后没有空间输出，表现为length且输出0。
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		// 输入上下文包括普通输入与缓存读取token；不能只看usage.input。
		const inputTokens = message.usage.input + message.usage.cacheRead;
		// 允许约1%统计差异，接近填满窗口即视为这种特殊溢出。
		if (inputTokens >= contextWindow * 0.99) {
			// 找到至少一种足够的输入过大/窗口耗尽线索，交由调用者决定恢复动作。
			return true;
		}
	}

	// 没有命中现有线索，只能说本函数未识别，不能证明任意自定义供应商绝不溢出。
	return false;
}

/**
 * Check whether a length stop ended below the caller or model's intended output limit.
 * Such responses may be caused by context pressure or provider-side truncation, so callers
 * can make one bounded compact-and-retry attempt. `desiredMaxOutput` must be the original
 * limit before any context-based clamping.
 */
// 用途：判断length是否发生在原本想要的输出预算之前，供上层一次有界压缩重试。例期望1000但只输出100就length返回true；正常用满预算则false，参数必须是钳制前预算。
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
	// 同时要求length停止、有效期望值、实际输出不足；仅有length不直接断言上下文溢出。
	return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}

/**
 * Get the overflow patterns for testing purposes.
 */
// 用途：给测试读取模式表的浅副本。例检查新供应商错误文案能否命中；不允许通过push改模块内数组，但RegExp对象本身仍复用。
export function getOverflowPatterns(): RegExp[] {
	// 数组展开复制顶层容器，不深复制每个正则实例。
	return [...OVERFLOW_PATTERNS];
}
