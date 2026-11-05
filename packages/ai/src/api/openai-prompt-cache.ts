// OpenAI提示缓存key的长度适配；只截字符串，不建立/查询缓存，也不保证不同原key截断后仍唯一。
// 允许的长度常量为64，实际下面按Array.from产生的码点数计算。
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * 把可选缓存key按Unicode码点截到前64项，返回原字符串、截后字符串或undefined，无I/O。
 * 例：65个常见汉字截成64；Array.from不会拆开代理对表示的单个码点，但组合字符/多码点emoji仍可能在中间切开，不按UTF-8字节或可见字符簇计数。
 */
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	// undefined原样返回；空字符串仍是合法字符串路径。
	if (key === undefined) return undefined;
	// 字符串迭代器按码点建立新数组，区别于key.length的UTF-16码元数。
	const chars = Array.from(key);
	// 不超过限制保留原字符串值，不额外重组。
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	// 截取前64码点再连接；不同后缀可能被截成同一key。
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
