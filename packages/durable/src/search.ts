// 文件导读
// 所属：packages/durable 的 BM25 工具检索排序器，服务于 code mode 的 searchTools() 与 tool_search 工具。
// 作用：把工具的 name/text/namespaceText 分词并按 Okapi BM25 打分，返回最相关工具的名称（最佳优先，平局保持输入顺序）。
// 职责边界：纯函数，不访问注册表、不加载工具、无 I/O、无缓存；实现是 coding-agent 工具检索的副本，Durable 保留自己需要的副本。
// 上游：codemode/codemode.ts 与 tool-search/tool-search.ts 调用 rankDocuments；下游：只依赖 Intl.Segmenter 与本地常量。
// 能力清单：
// - SearchDocument：name、text（描述与参数文本）、可选 namespaceText 三字段输入。
// - rankDocuments(query, documents, limit)：返回按相关性排序的名称数组；limit <= 0 或没有查询词时返回 []。
// - tokenize(text)：Unicode 分词、驼峰/下划线拆分、NFC、停用词过滤、英文单数化。
// - （私有）indexDocument、stem、normalizeName、isExactNameQuery，以及 K1/B/NAME_WEIGHT/NAMESPACE_WEIGHT/STOP_WORDS。
// 排序规则（英文注释是权威描述）：命中查询词数多者优先；名称命中权重 3，高于正文任意次提及；本地名（最后一个 __ 之后）
// 的所有词都出现在查询中时，额外加“每个查询词各多命中一次”的 IDF 奖励；整条查询恰好是名称或其后缀时最优先。
// 组合与典型顺序：工具列表 → map 成 SearchDocument → rankDocuments → 按返回名称加载/展示工具。
// 示例（真实签名）：
//   const names = rankDocuments("peekaboo app", [
//     { name: "mcp__peekaboo__app", text: "Capture an application window" },
//     { name: "mcp__window__open", text: "Open a window" },
//   ], 10);
// 阅读顺序：先读 rankDocuments 前的英文规则与 SearchDocument，再看 indexDocument 的字段拆分，最后看 tokenize/stem/normalizeName。
/**
 * BM25 tool search for code mode's `searchTools()` and the `tool_search` tool, a copy of the coding agent's tool search
 * ranking: durable keeps its own copy of what it needs from the coding agent.
 */

// 排序器看到的工具视图。三个字段都只在本次调用内使用，不会写回工具。
/** A tool as the ranker sees it: its name, its text, and the text of its namespace. */
export type SearchDocument = {
	// 工具的完整名称，例如 mcp__github__list_issues；排序结果原样返回这个名字。
	readonly name: string;
	/** Description and parameter names and descriptions; not the name, which the ranker reads from `name`. */
	// 工具描述与参数文本。名称不重复放进 text；排序器从 name 单独读取，避免正文命中权重压过名称。
	readonly text: string;
	/** Name, description, and instructions of the tool's namespace. */
	// 可选命名空间文本（同一命名空间的所有工具共享），只帮助找到“这个命名空间”，不区分其中的具体工具。
	readonly namespaceText?: string;
};

// 对工具列表做 BM25 排序。
// 输入：query（用户/模型搜索词）、documents（工具视图）、limit（最多返回几个）。
// 输出：名称数组，最佳优先；平局保持 documents 的输入顺序（JS 的 sort 是稳定排序）。
// 副作用：只分配索引/Map/数组，不修改入参；错误：本函数不主动抛错。
// 主要流程：
//   1. 查询分词去重，空查询/空文档/非正 limit 直接返回 []；
//   2. 为每个文档建立 name/localName/text/namespace 索引，计算正文平均长度；
//   3. 为每个查询词计算 IDF（出现在任一字段的文档算命中）；
//   4. 逐文档累计权重：名称 3、命名空间 0.5、正文 BM25 词频；记录覆盖了几个查询词；
//   5. 本地名整体命中时加“所有查询词 IDF 之和”的奖励；
//   6. 按 exact → covered → score 排序，截断并返回名称。
// 例子：rankDocuments("pull requests", docs, 1) 返回最匹配 PR 的工具名；没有任一词命中时返回 []。
/**
 * Okapi BM25 (k1 1.2, b 0.75) over `text`, with the name and the namespace as separate fields: the names of the best
 * matches, best first; ties keep document order.
 * - A tool that matches more of the query's terms, in any field, ranks above one that matches fewer, whatever their
 *   scores: for `screenshot window`, a tool whose description has both words beats `window` whose name has one.
 * - A query term in the name scores more than any number of mentions in the text.
 * - A tool whose whole local name (after the last `__`) is in the query gets a bonus worth one more match of every
 *   query term, so among tools matching as many terms, `peekaboo app` finds `mcp__peekaboo__app` over tools that
 *   only mention the words.
 * - A query that is exactly a tool's name, or its name after a `__`, ranks that tool first, before coverage.
 *
 * Only `text` is length-normalized, so a long name or long namespace instructions do not lower a tool's score.
 */
export function rankDocuments(query: string, documents: readonly SearchDocument[], limit: number): string[] {
	// 查询词去重；Set 只用于成员判断与迭代，不依赖顺序计算分数。
	const queryTerms = new Set(tokenize(query));
	// 没有有效词、没有候选或 limit 非正时无事可做；提前返回避免除零与无谓分配。
	if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
	// 一次性把每个文档拆成排序需要的字段，后续循环复用。
	const indexed = documents.map(indexDocument);
	// BM25 的长度归一化需要正文平均词数；`|| 1` 防止平均长度为 0 时除以零。
	const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
	// IDF：频率按“任一字段包含该词”的文档数计算；出现在越多工具的文本里，区分度越低。
	// `as const` 让每个映射结果是只读元组 [term, value]，满足 Map 构造函数的类型推断。
	const idf = new Map(
		[...queryTerms].map((term) => {
			// filter 统计包含该词的文档数；name/text/namespace 任一处命中都算一次。
			const frequency = indexed.filter(
				(document) =>
					document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term),
			).length;
			// 标准 BM25 的 log(1 + (N - n + 0.5)/(n + 0.5))；加 1 保证即使词出现在所有文档中也有正权重。
			return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
		}),
	);
	// 本地名整体命中的奖励：等价于每个查询词再命中一次，因此是全部 IDF 之和。
	const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
	// 精确名称比较用归一化后的整条查询（只做小写与字符替换，不分词）。
	const exactQuery = normalizeName(query);
	// 每个候选的分数、覆盖词数与是否精确同名；covered 用于排在 score 之前比较。
	const matches: { name: string; score: number; covered: number; exact: boolean }[] = [];
	for (const document of indexed) {
		// norm 是 BM25 的文档长度归一化因子：k1*(1-b+b*len/avg)，只使用正文长度。
		const norm = K1 * (1 - B + (B * document.textLength) / averageLength);
		// 累计本候选的加权分数与“命中了几个查询词”。
		let score = 0;
		let covered = 0;
		for (const term of queryTerms) {
			// 正文词频；没有出现时为 0，此时正文部分贡献 0。
			const count = document.textCounts.get(term) ?? 0;
			// 三个字段的权重相加：名称固定权重、命名空间固定权重、正文的 BM25 词频项。
			const weight =
				(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
				(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
				(count * (K1 + 1)) / (count + norm);
			// 任一分量大于 0 就说明该查询词被覆盖；覆盖数优先于分数参与排序。
			if (weight > 0) covered++;
			// idf 一定存在（由同一个 queryTerms 构建），因此用 `!` 断言。
			score += idf.get(term)! * weight;
		}
		// 所有查询词都没命中：不进入候选。
		if (score === 0) continue;
		// 本地名（最后一个 __ 之后）的全部词都出现在查询中时，加“每组查询词各命中一次”的奖励。
		const local = document.localNameTerms;
		if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
		// exact 用原始名称与归一化查询比较；注意与 covered/score 一起参与最终排序。
		matches.push({ name: document.name, score, covered, exact: isExactNameQuery(exactQuery, document.name) });
	}
	// 排序键依次为：精确同名（true 优先）→ 覆盖查询词数降序 → 分数降序；仍相等时稳定排序保持输入顺序。
	return (
		matches
			.sort(
				(left, right) =>
					Number(right.exact) - Number(left.exact) || right.covered - left.covered || right.score - left.score,
			)
			// 截断到 limit 个，再只保留名称（调用方按名称定位工具）。
			.slice(0, limit)
			.map((match) => match.name)
	);
}

// BM25 词频饱和参数：k1 越大，词频增长越慢地趋于上限；这两个常量同时用于正文与 IDF 公式外的归一化。
const K1 = 1.2;

// 长度归一化强度：0 表示完全不惩罚长正文，1 表示完全按平均长度缩放；0.75 是常用折中。
const B = 0.75;

// 名称命中权重 3：正文单项最多 K1+1=2.2，因此名称命中高于任意次正文提及。
/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most `K1 + 1` (2.2) times
 * its IDF and about 1 for a single mention, so a name match beats any number of mentions in the text.
 */
const NAME_WEIGHT = 3;

// 命名空间命中权重 0.5：同一命名空间的工具都共享这段文本，所以它有助于找到命名空间，但不足以区分具体工具。
/**
 * A query term in the namespace text counts this many times its IDF. Every tool of the namespace shares it, so it helps
 * find the namespace but not the tool in it.
 */
const NAMESPACE_WEIGHT = 0.5;

/** A document split into the fields the ranker weighs differently. */
// 一个文档按“排序器如何加权”拆开的字段集合；只存在于本次 rankDocuments 调用内。
type IndexedDocument = {
	// 原始名称，最终结果直接返回它。
	name: string;
	/** Terms of the name: `mcp`, `app`, `thread`, `read` for `mcp__app__thread_read`. */
	// 名称的完整词集合（去重），用于判断“查询词是否出现在名称里”。
	nameTerms: ReadonlySet<string>;
	/** Terms of the name after its last `__`, the part models say: `thread`, `read`. */
	// 最后一个 __ 之后的词，去重且保持出现顺序；模型通常只叫本地名，因此整体命中时额外奖励。
	localNameTerms: readonly string[];
	// 正文词频：词 → 出现次数；没有键表示 0。
	textCounts: ReadonlyMap<string, number>;
	// 正文总词数（各词频之和，不是字符数），用于 BM25 长度归一化。
	textLength: number;
	// 命名空间文本的词集合；所有同名空间工具相同。
	namespaceTerms: ReadonlySet<string>;
};

// 把一个 SearchDocument 拆成排序器需要的字段。
// 输入：原始工具视图；输出：IndexedDocument；副作用：分配 Map/Set/数组；错误：无。
// 主要流程：正文分词计数 → 名称按 "__" 分段取本地名 → 分别建立名称/命名空间词集合。
// 例子：name "mcp__app__thread_read" → 分段 [mcp, app, thread_read]，本地名分词为 [thread, read]。
function indexDocument(document: SearchDocument): IndexedDocument {
	// 正文词频表；同一查询词可能在描述中出现多次，权重随次数增长但受 k1 饱和。
	const textCounts = new Map<string, number>();
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	// 命名空间用 __ 连接（如 mcp__github__list_issues）；split 至少返回一个元素。
	const segments = document.name.split("__");
	// 返回普通对象；Readonly 只约束调用方，运行时没有冻结。
	return {
		name: document.name,
		// 名称整体分词，驼峰与下划线都会被拆开。
		nameTerms: new Set(tokenize(document.name)),
		// 本地名只取最后一段；先 Set 去重再转数组（数组需要 every 且长度参与判断）。
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]!))],
		textCounts,
		// 总词数来自词频之和；用值迭代而不是原文字符数，保证与 BM25 的 count 口径一致。
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		// 命名空间文本可选；缺省时 tokenize("") 得到空数组，空 Set。
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
}

// 模块级复用的 Unicode 分词器：构造 Intl.Segmenter 有成本，且 segment() 比 split 慢约 15 倍，
// 因此只在非纯 ASCII 文本上使用。locale 传 undefined 表示使用运行时默认语言。
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

// 英文停用词：这些词几乎出现在所有描述里，保留会稀释得分。只处理英文，其它语言的虚词（如日语助词）会保留。
const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

// 把文本切成用于匹配的词。
// 输入：任意文本；输出：小写、去停用词、英文词做朴素单数化后的词数组；顺序保持原文出现顺序。
// 副作用：无；错误：不主动抛错（Intl.Segmenter 的异常会在模块初始化/首次使用时暴露）。
// 主要流程：NFC 归一化 → 拆分驼峰/缩写边界 → 小写 → 非字母/标记/数字变空格 → ASCII 走 split，
// 其它文本走 Intl.Segmenter → 过滤空词与停用词 → 纯 ASCII 词做单数化。
// 例子：tokenize("listIssues for the GitHub_repo") === ["list", "issue", "git", "hub", "repo"]。
//   tokenize("搜索GitHub_repoIssues") 保留中文词并按标识符边界拆出 ["搜索","git","hub","repo","issue"]。
/** Unicode word segmentation with identifier boundaries and English stop words/singular forms. */
export function tokenize(text: string): string[] {
	// normalize("NFC") 把组合字符统一成规范形式，使 cafe + 重音组合与预组合 café 得到同一个词。
	const normalized = text
		.normalize("NFC")
		// 小写/数字后紧跟大写的驼峰边界（repoIssues → repo Issues）；$1/$2 是正则捕获组。
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		// 连续大写后接“大写+小写”的缩写边界（HTTPServer → HTTP Server）。
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		// 保留 Unicode 字母（L）、组合标记（M）、数字（N）；其余（标点、emoji、下划线）一律变空格。
		// 正则带 u 标志，才能正确按码点处理 \p{...} 与代理对。
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split. Plain ASCII splits into the same words at spaces, so only other
	// text, such as Chinese written without spaces, goes through it.
	// 纯 ASCII 快路径：上一步已把非字母数字变成空格，直接按空格 split 与分词器结果一致。
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? normalized.split(" ")
		: // 非 ASCII 文本用分词器；isWordLike 为 false 的分段（纯标点/空格）用空串占位，随后过滤。
			Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	// 去掉空串与英文停用词；stop-word 集合只包含小写英文词。
	return (
		words
			.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
			// 只对纯 ASCII 词做单数化；带重音或其它文字的词保持原样，避免误改。
			.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word))
	);
}

// 朴素的英文单数化，只处理最常见的复数后缀；不追求语言学正确，只为让 issue/issues 归到同一个词。
// 输入：纯小写 ASCII 词；输出：单数形式或原词；副作用/错误：无。
// 例子：issues→issue、queries→query、searches→search、classes→class、glass 保持 glass。
/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
	// 长度 >4 且以 ies 结尾：把 ies 变成 y（queries → query）。
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	// 长度 >4 且以 ches/shes/sses/xes/zes 结尾：去掉 es（searches → search、boxes → box、classes → class）。
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	// 其余以单个 s 结尾的词去掉 s（issues → issue）；ss 结尾（glass）不动。
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	// 不需要变化时返回原词。
	return term;
}

// 归一化工具名，用于“整条查询等于名称/后缀”的比较。
// 输入：名称或查询；输出：去首尾空格、小写、把脚本标识符非法字符替换为 _ 的字符串；副作用/错误：无。
// 保留 a-z0-9_$，因此 "dev-radius" 与 "dev_radius" 都变成 "dev_radius"。
/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
function normalizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$]/g, "_");
}

// 判断整条查询是否就是工具名（完整名称或 __ 之后的后缀）。
// 输入：query 已是 normalizeName 的结果，name 是原始名称；输出：布尔；副作用/错误：无。
// 例子：query "thread_read" 或 "app__thread_read" 都匹配 mcp__app__thread_read；普通词查询不匹配。
/**
 * Whether the whole query is the tool's name: its full name or a suffix after a `__` separator, so `thread_read` and
 * `app__thread_read` both name `mcp__app__thread_read`.
 */
function isExactNameQuery(query: string, name: string): boolean {
	// 先归一化名称；完整相等或以后缀形式 __query 结尾都算精确同名。
	const normalized = normalizeName(name);
	return normalized === query || normalized.endsWith(`__${query}`);
}
