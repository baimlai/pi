// 用“查询字符按顺序出现在候选中”筛选并排序候选，供设置搜索和自动补全使用；分数越低越优。它比较字符串，不调用模型，也不是编辑距离算法。匹配下标与长度按 UTF-16 字符串单元处理。
/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

// 单个查询的结果结构，interface 只在编译期约束形状，不负责运行时搜索。
export interface FuzzyMatch {
	// 是否匹配；false 时 score=0 只是占位，不能把它与成功项直接按分数比较优劣。
	matches: boolean;
	// 排序分值，允许小数和负数，不是 0..1 的概率或相似度百分比。
	score: number;
}

// 给一组已选中的匹配下标打分，输入小写候选和按序位置，返回数值，不改输入数组。
// 按连续、间隔、词边界与出现早晚加减分。例：紧邻字符得到奖励、散落位置产生间隔惩罚；readonly 只禁止通过本参数改数组，调用方需提供合适位置。
function scorePositions(textLower: string, positions: readonly number[]): number {
	// 局部累计分从 0 开始，减分代表更好。
	let score = 0;
	// 尚无前一匹配时用 -1 哨兵。
	let lastMatchIndex = -1;
	// 记录当前连续匹配链长度，后面连续越长奖励越大。
	let consecutiveMatches = 0;

	// for...of 按匹配位置数组顺序遍历，不遍历候选全部字符。
	for (const i of positions) {
		// Reward consecutive matches
		// 当前位置正好比上次大 1 就算连续；初始 i=0 与哨兵 -1 也满足此式，因此首字符在开头也得到这一奖励。
		if (lastMatchIndex === i - 1) {
			// 连续计数自增。
			consecutiveMatches++;
			// 从分数减去“当前连续计数乘 5”，后续连续字符获得更大奖励。
			score -= consecutiveMatches * 5;
			// 中间断开时重新统计链。
		} else {
			// 连续计数重置为 0。
			consecutiveMatches = 0;
			// Penalize gaps
			// 已有前一匹配才能计算中间空隙，首个较晚匹配不在此虚构前导间隔。
			if (lastMatchIndex >= 0) {
				// 两个位置之间漏掉的单元数乘 2，作为惩罚加分。
				score += (i - lastMatchIndex - 1) * 2;
			}
		}

		// Reward word boundary matches
		// 候选开头或前一字符属于空白/连接符/点/斜杠/冒号时，视作词边界；这是固定正则启发式，不用 Intl 分词。
		if (i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!)) {
			// 词边界减 10 分作为奖励。
			score -= 10;
		}

		// Slight penalty for later matches
		// 位置越晚按 i*0.1 轻微加分；支持同类匹配里优先靠前出现的文字。
		score += i * 0.1;

		// 当前位置作为下一轮的“前一匹配”。
		lastMatchIndex = i;
	}

	// 返回这组位置的总分。
	return score;
}

// 对已经小写化的单词查询匹配一个候选，返回 matches/score，不改外部数据。
// 先贪心找按序子序列并评分，再枚举所有连续出现位置取更低分，完全相同额外奖励。例：候选前部散落 o/p/u/s，末尾真有 opus，也会单独给末尾连续片段评分；并未枚举所有非连续对齐来保证全局最低分。
function matchQuery(normalizedQuery: string, textLower: string): FuzzyMatch {
	// 空查询直接匹配所有文字。
	if (normalizedQuery.length === 0) {
		// 返回成功和 0，不继续应用完全相同奖励。
		return { matches: true, score: 0 };
	}

	// 查询比候选还长就不可能成为按序子序列。
	if (normalizedQuery.length > textLower.length) {
		// 返回未匹配结果，0 不是成功分。
		return { matches: false, score: 0 };
	}

	// Greedy alignment: each query character at its first occurrence after the previous one.
	// 保存贪心匹配的各 UTF-16 下标，之后会复用该数组计算连续匹配位置。
	const positions: number[] = [];
	// 首字符从候选位置 0 开始查，因此前一位置初始为 -1。
	let lastMatchIndex = -1;
	// 按查询字符串下标逐个单元匹配，不是按字素或词迭代。
	for (let queryIndex = 0; queryIndex < normalizedQuery.length; queryIndex++) {
		// 从上个命中之后找当前查询单元的第一次出现；! 仅为 TypeScript 非空断言。
		const i = textLower.indexOf(normalizedQuery[queryIndex]!, lastMatchIndex + 1);
		// 找不到当前单元，整个查询不匹配。
		if (i === -1) {
			// 提前返回，不尝试交换字母数字；交换回退由外层 fuzzyMatch 决定。
			return { matches: false, score: 0 };
		}
		// 记录这个贪心命中位置。
		positions.push(i);
		// 下一字符只能从更靠后的位置查。
		lastMatchIndex = i;
	}

	// 先计算贪心对齐分值，let 允许更好的连续位置覆盖它。
	let score = scorePositions(textLower, positions);

	// The greedy alignment can scatter the query over an earlier, unrelated part of the text,
	// e.g. "opus" in "openrouter openrouter/anthropic/claude-opus" takes o, p, u from "openrouter".
	// Also score every contiguous occurrence and keep the best alignment.
	// 再枚举完整查询串在候选中的每个连续出现位置，下面是跨行 for 的初始化/条件/推进。
	for (
		// 首次 indexOf 找完整小写查询，-1 表示没有连续出现。
		let start = textLower.indexOf(normalizedQuery);
		// 只要还有出现位置就继续。
		start !== -1;
		// 从当前位置加 1 重新查，允许重叠的连续出现也参与评分。
		start = textLower.indexOf(normalizedQuery, start + 1)
	) {
		// 把 positions 改成这一次连续匹配的下标组，长度仍为查询长度。
		for (let k = 0; k < positions.length; k++) {
			// 第 k 个查询单元位置就是连续起点 start+k。
			positions[k] = start + k;
		}
		// 保留既有分与本次连续评分中更低者，不把所有匹配分相加。
		score = Math.min(score, scorePositions(textLower, positions));
	}

	// 整个候选与查询完全相同才给精确匹配额外奖励。
	if (normalizedQuery === textLower) {
		// 再减 100，使精确匹配优先于较长前缀等候选。
		score -= 100;
	}

	// 返回成功与最终分数；位置数组不暴露给调用方。
	return { matches: true, score };
}

// 忽略大小写匹配单个查询和候选，返回结构，不修改参数；正常匹配失败时仅对完整的 ASCII 字母段与数字段两块组合尝试互换顺序。
// 例：codex52 先无法按序匹配 gpt-5.2-codex，可交换成 52codex 再试并加 5 分惩罚；正常路径已匹配就不会比较交换结果，也不自动拆空格或斜杠，那是 fuzzyFilter 的工作。
export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	// 小写化查询，用默认 JavaScript Unicode 大小写转换，不做音调/拼音或语言专用归一化。
	const queryLower = query.toLowerCase();
	// 同样小写化候选。
	const textLower = text.toLowerCase();

	// 先走正常按序匹配。
	const primaryMatch = matchQuery(queryLower, textLower);
	// 正常路径成功就采用它。
	if (primaryMatch.matches) {
		// 直接返回，无交换尝试。
		return primaryMatch;
	}

	// 命名捕获组识别整个查询是否恰为 ASCII 字母后接数字，^/$ 限定整串，不接受中间连接符。
	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	// 反方向识别数字后接 ASCII 字母。
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	// 构造交换后的查询，下面三元表达式按两种形状选择拼接顺序。
	const swappedQuery = alphaNumericMatch
		? // 字母+数字形状改为数字+字母；groups?. 与 ?? 提供类型可选字段的缺省值。
			`${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: // 不是第一形状时再看是否为数字+字母。
			numericAlphaMatch
			? // 数字+字母改成字母+数字。
				`${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: // 两种形状都不是时用空字符串表示无回退方案。
				"";

	// 没有可交换串就保留原未匹配结果。
	if (!swappedQuery) {
		// 不尝试任意字符重排。
		return primaryMatch;
	}

	// 用同一匹配算法检查交换串。
	const swappedMatch = matchQuery(swappedQuery, textLower);
	// 交换后仍不匹配也不让原失败变成成功。
	if (!swappedMatch.matches) {
		// 返回原未匹配对象。
		return primaryMatch;
	}

	// 交换成功后附加 5 分惩罚，返回成功的新结果；这不是得分上限或百分比。
	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports whitespace- and slash-separated tokens: all tokens must match.
 */
// 按 query 筛选任意类型 T 的 items，返回按总分排序的原条目引用数组；不修改原数组顺序。
// 先按空白/斜杠分词，要求每个词都匹配 getText(item)，再累加分排序。例：openai/model 可匹配候选中顺序不同的两块文字；空查询或只有分隔符时直接返回原数组，非空筛选才建新数组。getText 回调同步执行，可抛错，其副作用由调用者负责。
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	// 全空白查询不做筛选，也不调用 getText。
	if (!query.trim()) {
		// 返回原数组引用，调用方不能假设每次都拿到独立副本。
		return items;
	}

	// 将有效查询拆成多个 token，链式调用的每一步在下一行继续。
	const tokens = query
		// 先去两端空白。
		.trim()
		// 正则以连续空白或 / 为分隔符；token 之间不要求在候选中按查询的原顺序出现。
		.split(/[\s/]+/)
		// 过滤分隔造成的空 token，箭头回调返回是否保留。
		.filter((t) => t.length > 0);

	// 例如 query="///"，trim 后非空但 token 全空，仍直接返回原数组。
	if (tokens.length === 0) {
		// 不调用文本提取与排序。
		return items;
	}

	// 用 {item:T,totalScore:number}[] 暂存通过项及总分；泛型保留调用者条目类型，不做运行时结构验证。
	const results: { item: T; totalScore: number }[] = [];

	// 按原数组顺序逐条候选检查。
	for (const item of items) {
		// 每项实际调用一次 getText 获得匹配文字，后续各 token 共用此字符串。
		const text = getText(item);
		// 当前项总分从 0 起。
		let totalScore = 0;
		// 先假定所有 token 匹配，失败时改 false。
		let allMatch = true;

		// 每个 token 都要单独匹配整段候选文字，命中区间允许重叠，不从候选里消费掉字符。
		for (const token of tokens) {
			// 委托大小写与字母数字交换逻辑，返回匹配状态和分数。
			const match = fuzzyMatch(token, text);
			// 本 token 成功才累加它的分数。
			if (match.matches) {
				// 多个 token 的分数相加作为候选排序依据。
				totalScore += match.score;
				// 任一 token 失败就淘汰当前项。
			} else {
				// 记录该项未通过全部 token。
				allMatch = false;
				// 不再检查剩余 token，降低无效工作。
				break;
			}
		}

		// 只有全部 token 通过才存结果。
		if (allMatch) {
			// 保存原项引用和累计分，不克隆候选对象。
			results.push({ item, totalScore });
		}
	}

	// 只对临时结果原地排序，分越低越靠前；比较值相等按现代 JS 稳定排序保留原相对顺序。
	results.sort((a, b) => a.totalScore - b.totalScore);
	// map 丢掉辅助得分，返回按新顺序排列的条目引用数组。
	return results.map((r) => r.item);
}
