// 模型选择、范围配置和自动补全共用的搜索文字/显示名称规则；只处理本地字符串，不查询目录或修改模型。
// 搜索所需的最小字段接口；调用方可传完整 Model，TS 的结构类型只要求这些字段。
export interface ModelSearchItem {
	// 模型 id 可以自带斜杠/命名空间，不在此拆成供应商。
	id: string;
	// 实际注册供应商 id，和模型 id 内包含的代理路径不同。
	provider: string;
	// ? 表示可没有显示名，不是空字符串默认值。
	name?: string;
}

// 构造范围选择/自动补全的评分文本，返回新字符串，无副作用；例 id="gpt-5",provider="openai"，文本重复身份片段以影响 fuzzyFilter 的位置评分。
// 不保证只显示一次或进行精确查找；类型外错误原样传播，没有运行时结构校验。
export function getModelSearchText(item: ModelSearchItem): string {
	// 对象解构取身份字段，不改 item。
	const { id, provider } = item;
	// 真值名称前补空格，否则空串；不在这里 trim，纯空白名称仍会拼入。
	const name = item.name ? ` ${item.name}` : "";
	// 模板按固定顺序重复 id/provider，让候选文字可供按词和按序字符匹配；这些内容不是请求提示词。
	return `${id} ${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

// 把标签小写化、按非 Unicode 字母/数字拆词、去空项，返回数组；例 "GPT-5"→["gpt","5"]。无 IO，不改变原字符串。
const splitModelLabel = (value: string): string[] =>
	// 箭头函数的跨行表达式体从原 value 开始链式处理，不需要 return 块。
	value
		// 使用 JS 默认 Unicode 小写转换，不做拼音、音调或语言定制归一化。
		.toLowerCase()
		// u 开启 Unicode 正则，\p{L}/\p{N} 是字母/数字类别；方括号内 ^ 取反，+ 合并连续分隔符。
		.split(/[^\p{L}\p{N}]+/u)
		// Boolean 作回调过滤空字符串；不是 TS 的“每项必须是布尔值”声明。
		.filter(Boolean);

/**
 * Returns the model name when it has words the ID does not, e.g. a renamed override like
 * "MiniMax M3 [rasmus@openrouter, parasail]" for "minimax/minimax-m3". Names that only
 * restate the ID with different casing, separators, or a dropped namespace/version suffix
 * ("Claude Sonnet 4.5 (EU)" for "eu.anthropic.claude-sonnet-4-5-20250929-v1:0") return undefined.
 */
// 决定显示名是否有 id 未表达的词；例 "Model B" 对 model-b 被隐藏，"Renamed B" 被保留。
// 输入 id/可选 name，返回裁过两端空白的名称或 undefined；只做启发式词覆盖，不验证模型身份，无外部副作用。
export function getDistinctModelName(item: { id: string; name?: string }): string | undefined {
	// ?. 处理缺 name，存在时 trim 两端空白；不会改 item.name。
	const name = item.name?.trim();
	// 缺名称或裁后空串就没有额外显示文案。
	if (!name) return undefined;
	// 把 id 拆成小写 Unicode 字母数字词。
	const idWords = splitModelLabel(item.id);
	// Set 按词保存，用于完整词精确命中。
	const idTokens = new Set(idWords);
	// 同时把 id 各词无分隔连接，允许较长名字词跨原分隔符命中。
	const compactId = idWords.join("");
	// Single-character words must match a whole ID token: "4" is not covered by "mistral-small-2603".
	// 局部判词闭包：完整词匹配，或长度大于 1 时在紧凑 id 中找到子串；length 按 UTF-16 码元，未做语义理解。
	const isCovered = (word: string) => idTokens.has(word) || (word.length > 1 && compactId.includes(word));
	// 名称的每个词都已覆盖就隐藏，否则保留裁后原名；全是标点的名称拆成空数组，every 对空数组为 true，因而也隐藏。
	return splitModelLabel(name).every(isCovered) ? undefined : name;
}

/**
 * The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5, so keep the bare model ID out of the leading position.
 */
// 构造 /model 选择器专用评分文本，返回字符串；例 openai/gpt-5 查询要优先实际 openai 身份而非代理模型 id 内的 openai。
// 区别在片段次序，排名最终仍由 fuzzyFilter 决定，不是任意目录都保证固定名次；无 IO/状态修改。
export function getModelSelectorSearchText(item: ModelSearchItem): string {
	// 解构模型 id 和实际供应商，仍保留原字符串。
	const { id, provider } = item;
	// 可选名称作为后缀，空串不额外加空格。
	const name = item.name ? ` ${item.name}` : "";
	// 先放实际 provider，再放 provider/id；刻意不把裸 id 放开头，减少代理路径抢占前部评分。
	return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}
