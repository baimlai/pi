/**
 * Tool discovery: a BM25 ranker over tool metadata, shared by `searchTools()` in codemode scripts and
 * the optional `tool_search` tool.
 *
 * `tool_search` searches tools that are not declared to
 * the model (`codemode` and `deferred` exposure) and loads the matches, so they are declared for the
 * next model call. Loading goes through the active tool set, so it is recorded in the transcript
 * like any other tool change and survives `/tree`, resume, and fork on that branch.
 */

// 工具搜索：把名称/说明/参数schema拆成词，用本地评分选工具，再让会话激活它们。上游 tool_search 扩展创建定义，codemode 的 searchTools 也复用排名器，但后者不激活模型工具。
// 例：查询“搜索仓库问题”，先分词，再比较候选工具的文字；这里不调用语言模型，也不请求向量服务，没有同义词自动理解。
// Type 创建运行时schema，Static从schema推导TS类型；二者都不是在import时验证一切。
import { type Static, Type } from "typebox";
// 纯类型 import 定义宿主工具集合和命名空间的接口，不在这里引入整个会话实现。
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "../../core/extensions/types.ts";

// 公共名称，用于注册与模型调用。
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
// 一次默认最多加载8个，显式limit可覆盖；不是固定只能搜索8个候选。
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** A tool as the ranker sees it: its name and the texts built by {@link createToolSearchDocument}. */
/** 排名器的纯数据输入：一个工具对应一个文档，元数据由下面的建文档函数提取。 */
export interface ToolSearchDocument {
	// 原工具名，返回时仍用它，精确名称比较另外做规范化。
	name: string;
	/** Description, schema descriptions, and property names. */
	// 工具描述、参数说明和属性名拼成的可搜索正文。
	text: string;
	/** Name, description, and instructions of the tool's namespace. */
	// 可选命名空间文字，一台服务器的工具通常共享这部分，用较低权重参与评分。
	namespaceText?: string;
}

/** 一条匹配结果，只返回原名和分数；分数依赖本次候选集合，不能当跨查询的固定概率。 */
export interface ToolSearchMatch {
	// 匹配的原始工具名。
	name: string;
	// 相关性分数，数字越大在同覆盖率/精确度组内越靠前，不是成功率。
	score: number;
}

/** Ranks tools for a query. BM25 today; a hybrid ranker with embeddings can replace it. */
/** 可替换排名器的接口，当前实现是词项匹配；接口不要求网络或机器学习模型。 */
export interface ToolRanker {
	// readonly限制TS修改输入数组；rank返回新结果数组，limit由调用通道决定如何校验。
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

// 创建可复用的Unicode词分割器，undefined使用运行环境默认locale；分词细节可能随ICU/运行环境变化。
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

// 过滤这些常见英语虚词，ReadonlySet是编译期只读视图，不是Object.freeze；中文词不会因为这张英语表被统一删除。
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

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
// 简单英语词尾归并，不是完整词形分析。例 issues→issue、queries→query；只对后面识别出的ASCII词使用，可能把其他单词也错误归并。
function stem(term: string): string {
	// 长度>4且ies结尾换y，避免过短词随意变化。
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	// ches/shes/sses/xes/zes结尾去es；$无m只认实际末尾。
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	// 其余长度>3的s结尾去s，但ss结尾保留。
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	// 没命中则原词返回。
	return term;
}

/** Unicode word segmentation with identifier boundaries and English stop words/singular forms. */
/** 文字→规范化/拆标识符→分词→去英语虚词→ASCII词尾归并。例 listIssues for the GitHub_repo 得到 list,issue,git,hub,repo；无网络副作用。 */
export function tokenize(text: string): string[] {
	// 链式方法每一步返回新字符串，不修改调用者的text。
	const normalized = text
		// NFC把等价的组合字符表示统一，如e加组合重音与单字符é，便于匹配；不是去掉重音。
		.normalize("NFC")
		// 小写字母/数字与后面大写字母之间插空格，拆listIssues。
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		// 连续大写缩写与后续首字母大写单词之间拆开，例如HTTPServer→HTTP Server。
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		// 接着统一小写。
		.toLowerCase()
		// Unicode属性转义保留字母L/组合标记M/数字N，其余连续字符换一个空格；u启用Unicode模式，g全局替换。
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
	// The segmenter costs about 15 times a split. Plain ASCII splits into the same words at spaces, so only other
	// text, such as Chinese written without spaces, goes through it.
	// 只有ASCII小写/数字/空格走快速split；其余语言交Intl分词，不直接按字符一字一词。
	const words = /^[a-z0-9 ]*$/.test(normalized)
		? // split可能留下空词，后面统一过滤。
			normalized.split(" ")
		: // Array.from边迭代边映射，isWordLike为false的片段置空；它不是一个远端调用。
			Array.from(wordSegmenter.segment(normalized), (segment) => (segment.isWordLike ? segment.segment : ""));
	// 最后两步作用于词数组。
	return (
		words
			// 去空词和STOP_WORDS的词，不去重，所以正文中出现次数仍可统计。
			.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
			// ASCII词才stem，非ASCII词保持内容；不同语言没有共用的英语词尾处理。
			.map((word) => (/^[a-z0-9]+$/.test(word) ? stem(word) : word))
	);
}

// unknown schema的根形状判断；排除null和数组，不检查所有JSON Schema关键字。
function isObject(value: unknown): value is Record<string, unknown> {
	// value is...是类型谓词，返回true后TS允许按字典读字段。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
// 递归提取description、properties的字段名/子schema、items和三种联合数组；这是搜索文字提取器，不是完整schema验证/引用解析，循环对象没有visited保护。
function schemaText(schema: unknown, parts: string[]): void {
	// 布尔schema/数组/基本类型没有可提取字段，直接停止。
	if (!isObject(schema)) return;
	// description是字符串就加入，空白的最终在建文档时过滤。
	if (typeof schema.description === "string") parts.push(schema.description);
	// 仅对象形式properties会遍历。
	if (isObject(schema.properties)) {
		// Object.entries枚举自有可枚举字段，数组在上面已排除。
		for (const [name, property] of Object.entries(schema.properties)) {
			// 字段名也参加搜索，如参数state可被搜索命中。
			parts.push(name);
			// 再递归字段自己的说明/嵌套结构。
			schemaText(property, parts);
		}
	}
	// 单个对象items继续提取；元组数组items没有在此逐项处理。
	schemaText(schema.items, parts);
	// 按这三个关键字逐个扫描，不扫描$defs/$ref/additionalProperties等所有schema位置。
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		// 索引读取当前联合关键字的值。
		const variants = schema[key];
		// 只有数组分支才遍历其元素，顺序加入parts。
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/**
 * Search text of a tool: the description and the schema descriptions and property names, and
 * separately the namespace name, description, and instructions. The ranker reads the name from `name`.
 */
/** 建一个搜索文档：工具说明+有限schema文字为正文，命名空间另存。例参数query.description="关键词"也参与搜索；不做令牌化或联网。 */
export function createToolSearchDocument(
	// Pick只要求ToolInfo的这三个字段，其余功能无须依赖。
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	// 没有命名空间时这部分为空串。
	namespace?: ToolNamespace,
): ToolSearchDocument {
	// 先放工具原说明，供递归继续append。
	const parts = [tool.description];
	// 函数原地向parts追加文字，返回void。
	schemaText(tool.parameters, parts);
	// 命名空间可包含服务器说明和长instructions；它们是搜索元数据，不等于执行指令被本函数自动遵从。
	const namespaceText = namespace
		? // 缺项填空，join用空格分开，保留原文字供分词器规范化。
			[namespace.name, namespace.description ?? "", namespace.instructions ?? ""].join(" ")
		: "";
	// 过滤只用trim判断是否全空白，保留的片段本身不在这里trim；namespaceText即使空也存在于返回对象。
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" "), namespaceText };
}

/** Lowercase with characters invalid in script identifiers as `_`, so `dev-radius` matches `dev_radius`. */
// 规范化名称便于精确比较：去外层空白、转小写、把非ASCII允许字符逐个变下划线。例dev-radius与dev_radius相同，不是完整JS标识符验证。
function normalizeName(name: string): string {
	return (
		name
			// 只去两端空白，中间空白稍后逐个换成_。
			.trim()
			// 名称比较忽略大小写。
			.toLowerCase()
			// 保留a-z/数字/_/$，不把数字开头修成合法标识符；这是搜索匹配规则，不同于脚本标识符完整转换。
			.replace(/[^a-z0-9_$]/g, "_")
	);
}

/**
 * Whether the whole query is the tool's name: its full name or a suffix after a `__` separator, so
 * `thread_read` and `app__thread_read` both name `mcp__app__thread_read`.
 */
// 检查整个已规范化query是否是完整名或__之后的后缀；例thread_read匹配mcp__app__thread_read，不是任意包含子串都算精确。
function isExactNameQuery(query: string, name: string): boolean {
	// 只在这里规范化工具名，调用方要先规范化query。
	const normalized = normalizeName(name);
	// 完全相等或双下划线分隔后缀才true。
	return normalized === query || normalized.endsWith(`__${query}`);
}

/** A document split into the fields the ranker weighs differently. */
// 内部索引每次rank新建，不是跨调用持久缓存。
interface IndexedDocument {
	// 保留原名用于返回。
	name: string;
	/** Terms of the name, for example `mcp`, `app`, `thread`, `read` for `mcp__app__thread_read`. */
	// 名称词集合去重，单词在名字中重复出现不会叠加名称次数。
	nameTerms: ReadonlySet<string>;
	/** Terms of the last `__` segment of the name, the part models say: `thread`, `read`. */
	// 最后一个__段的去重词数组，用于判断查询是否覆盖整个局部工具名。
	localNameTerms: readonly string[];
	// 正文词→出现次数，Map不同于只记是否存在的Set。
	textCounts: ReadonlyMap<string, number>;
	// 正文总词数（含重复）用于长度归一化，不是字符串字符数。
	textLength: number;
	// 命名空间词也去重，只算是否命中。
	namespaceTerms: ReadonlySet<string>;
}

// 把一个文档转成词集合/频数/长度。例正文"read read file"记read=2,file=1,total=3；不在这里计算最终相关性。
function indexDocument(document: ToolSearchDocument): IndexedDocument {
	// 新建词频字典。
	const textCounts = new Map<string, number>();
	// 每遇一词把已存数量+1，未出现时??0。
	for (const term of tokenize(document.text)) textCounts.set(term, (textCounts.get(term) ?? 0) + 1);
	// 按双下划线划分名称层，最后一段视为局部名。
	const segments = document.name.split("__");
	return {
		// 返回原始名。
		name: document.name,
		// 完整名称tokenize后Set去重。
		nameTerms: new Set(tokenize(document.name)),
		// 最后段tokenize再去重，展开成数组方便every检查。
		localNameTerms: [...new Set(tokenize(segments[segments.length - 1]))],
		// 复用已计算的正文词频Map。
		textCounts,
		// reduce累加出现次数，初值0保证空正文也有数字。
		textLength: [...textCounts.values()].reduce((sum, count) => sum + count, 0),
		// 缺命名空间就分词空串，得到空Set。
		namespaceTerms: new Set(tokenize(document.namespaceText ?? "")),
	};
}

/**
 * A query term in the name counts this many times its IDF. The text part of a term is at most
 * `k1 + 1` (2.2) times its IDF and about 1 for a single mention, so a name match beats any number of
 * mentions in the description.
 */
// 名称命中权重3；“大于任意正文重复”的说明依赖默认k1=1.2和正常参数，调用者自定义k1/b后不自动保证。
const NAME_WEIGHT = 3;

/**
 * A query term in the namespace name, description, or instructions counts this many times its IDF. They
 * are shared by every tool of the server, so they help find the server but not the tool in it.
 */
// 命名空间权重0.5，比名称弱；同一服务器多工具共享它，主要帮助找到服务器。
const NAMESPACE_WEIGHT = 0.5;

/**
 * Okapi BM25 over the description, with the name and the namespace as separate fields:
 * - a tool that matches more of the query's terms, in any field, ranks above one that matches
 *   fewer, whatever their scores: for `screenshot window`, a tool whose description has both words
 *   beats `window`, whose name has one;
 * - a query term in the name scores more than any number of mentions in the description;
 * - a tool whose whole local name is in the query (`app` in `peekaboo app` for
 *   `mcp__peekaboo__app`) gets a bonus worth one more match of every query term, so among tools
 *   matching as many terms it mostly wins over tools that only mention the words;
 * - a query that is exactly a tool's name ranks that tool first, before coverage.
 *
 * The description alone is length-normalized, so a long name or long namespace instructions do
 * not lower a tool's score. Ties keep document order.
 */
/** 本地BM25式排序：先精确名称，再命中不同查询词的数量，最后比分数；分数是文本相关性，不能判断工具是否真的适合/可执行。 */
export class Bm25Ranker implements ToolRanker {
	// 正文词频饱和参数，readonly只限制重赋字段。
	private readonly k1: number;
	// 正文长度归一化强度；这两个值未在构造器做有限数/范围验证。
	private readonly b: number;

	/** 保存评分参数；默认k1=1.2,b=0.75，不建立索引或验证自定义参数范围。 */
	constructor(options: { k1?: number; b?: number } = {}) {
		// ??缺失才默认，显式0会保留。
		this.k1 = options.k1 ?? 1.2;
		// 同样保存b，实际效果见rank的norm公式。
		this.b = options.b ?? 0.75;
	}

	/** 每次重建候选词索引并排序，返回至多limit项。例screenshot window先让覆盖两词者高于只覆盖一词者，精确名称例外优先；不修改输入数组。 */
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		// 查询词用Set去重，用户重复写同一词不会要求重复覆盖。
		const queryTerms = new Set(tokenize(query));
		// 空查询词/无文档/limit<=0直接空数组；公共rank不独立检查整数/NaN，工具入口有更严格规则。
		if (queryTerms.size === 0 || documents.length === 0 || limit <= 0) return [];
		// 本次所有文档各建一份索引，没有持久预编译缓存。
		const indexed = documents.map(indexDocument);
		// 平均正文词数；全为0时||1避免除0。
		const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1;
		// IDF是“这个查询词在候选中有多稀有”的权重，Map按词保存。
		const idf = new Map(
			// 每个不同查询词各算一次。
			[...queryTerms].map((term) => {
				// frequency是包含该词的文档数，不是所有正文出现次数之和。
				const frequency = indexed.filter(
					(document) =>
						// 名称、正文或命名空间任一命中，该文档就算出现一次。
						document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term),
				).length;
				// 出现文档越少，这个对数权重越大；as const让[词,权重]保留二元组类型。
				return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		// 所有查询词的IDF之和，后面给完整局部名额外奖励。
		const fullNameBonus = [...idf.values()].reduce((sum, value) => sum + value, 0);
		// 另准备精确名称比较用query，不等于上面tokenize后的词列表。
		const exactQuery = normalizeName(query);
		// 交叉类型在内部匹配上临时增加covered/exact，返回前会去掉。
		const matches: (ToolSearchMatch & { covered: number; exact: boolean })[] = [];
		// 逐文档计算，原顺序作为后面的平分顺序。
		for (const document of indexed) {
			// 长度归一化只用正文长度，不因命名空间说明长就直接惩罚。
			const norm = this.k1 * (1 - this.b + (this.b * document.textLength) / averageLength);
			// 当前文档累计得分。
			let score = 0;
			// 命中过多少个不同查询词，与出现次数不同。
			let covered = 0;
			// 逐个不同查询词看三个字段。
			for (const term of queryTerms) {
				// 正文出现次数，未出现为0。
				const count = document.textCounts.get(term) ?? 0;
				// 把三部分权重相加。
				const weight =
					// 名字出现一次加3，不按名字频率重复加。
					(document.nameTerms.has(term) ? NAME_WEIGHT : 0) +
					// 命名空间出现加0.5。
					(document.namespaceTerms.has(term) ? NAMESPACE_WEIGHT : 0) +
					// 正文频数用饱和公式：重复越多增益越小；自定义异常参数可能产生NaN/非预期值，此处不修正。
					(count * (this.k1 + 1)) / (count + norm);
				// 正权重才算覆盖一个查询词，覆盖数先于得分排序。
				if (weight > 0) covered++;
				// 这个词的稀有度乘字段权重，累加到score。
				score += (idf.get(term) ?? 0) * weight;
			}
			// 分数恰为0就排除；没有用<=0或有限数过滤自定义参数的异常结果。
			if (score === 0) continue;
			// 局部工具名的去重词。
			const local = document.localNameTerms;
			// 局部名至少一个词且全部都在query里，就加整组查询词IDF；不是“必须完整原字串相同”。
			if (local.length > 0 && local.every((term) => queryTerms.has(term))) score += fullNameBonus;
			// 记录评分及排序用标记，exact最后通过原名称规范化检查。
			matches.push({ name: document.name, score, covered, exact: isExactNameQuery(exactQuery, document.name) });
		}
		// 对新建matches排序，不动documents顺序。
		return (
			matches
				// 布尔转数值让true靠前；||在前比较平分时才看下一项，所有项平分保留原文档顺序。
				.sort((a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score)
				// 截前limit，公共rank非整数会按slice转换规则处理；工具入口已要求正整数。
				.slice(0, limit)
				// 解构只保留name/score，不向调用者暴露covered/exact内部字段。
				.map(({ name, score }) => ({ name, score }))
		);
	}
}

/** 搜索输入schema：query字符串，limit可省略；正整数/非空业务规则还在execute里检查。 */
export const toolSearchSchema = Type.Object({
	// query是必填字符串，这个描述不自动要求至少一个非空字符。
	query: Type.String({ description: "Search query for deferred tools." }),
	// Optional让limit可省略。
	limit: Type.Optional(
		// Number声明数值但非Integer；实际输入规则在下面Number.isInteger。
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

// Static<typeof...>从运行schema推导编译期参数结构，typeof这里取变量类型，不是运行时typeof判断。
export type ToolSearchInput = Static<typeof toolSearchSchema>;

/** 已选择工具的简要文字数据，用于生成模型提示。 */
export interface ToolSearchResultTool {
	// 选中工具名。
	name: string;
	// 选中工具描述，最后展示只取首行。
	description: string;
}

/** 搜索工具的UI/记录详情，不是所有搜索候选清单。 */
export interface ToolSearchToolDetails {
	/** Tools loaded by this call. */
	// 本次激活的名称数组，没匹配时为空。
	loaded: string[];
}

/** 搜索所需宿主能力，没注入tools时明确返回无匹配，不偷偷访问全局会话。 */
export interface ToolSearchToolOptions {
	/**
	 * The session's tools. `tool_search` searches the tools that are not declared to the model and
	 * activates the matches. Without it, the tool finds nothing. An `ExtensionAPI` fits.
	 */
	// Pick只开放读取全部/当前激活工具以及设置激活集合，不需要整个ExtensionAPI。
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
}

/** Whether `tool_search` can load a tool with this exposure. */
// 只有codemode/deferred可被搜索加载；direct已是直接暴露方案，hidden和model-only不在候选中。
function isSearchable(exposure: ToolExposure): boolean {
	// 两个精确字面量比较，不把任何非direct都算可搜索。
	return exposure === "codemode" || exposure === "deferred";
}

/**
 * Rank the searchable tools that are not active yet and activate the matches, so the next model
 * call declares them. Activation is recorded in the transcript like any tool change.
 */
// 排名并激活尚未激活的间接工具。例找到mcp__docs__search后加入active，下一轮模型请求才拿到声明；此处不执行该工具。
function searchAndLoad(
	// NonNullable去掉可选tools字段的undefined/null，调用方分支已保证有注入接口。
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	// 搜索文字由execute先检查非空，但纯虚词仍可能分词成空。
	query: string,
	// 最大加载数量，入口已验证正整数。
	limit: number,
): ToolSearchResultTool[] {
	// 快照记录当前激活集合，用于排除已加载工具和追加新项。
	const active = tools.getActiveTools();
	// 先按暴露方式+未激活过滤，再基于剩余候选计算IDF。
	const candidates = tools.getAllTools().filter((tool) => isSearchable(tool.exposure) && !active.includes(tool.name));
	// 把当前候选描述/schema/命名空间转成文档。
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	// 每次创建默认评分器，不跨调用缓存排名结果。
	const matches = new Bm25Ranker().rank(query, documents, limit);
	// 一次设置追加选中项；宿主负责把工具变更记录进会话，搜索函数本身不写JSONL。
	if (matches.length > 0) tools.setActiveTools([...active, ...matches.map((match) => match.name)]);
	// 返回选中名称及原描述，不返回schema/执行函数。
	return matches.map((match) => ({
		// 保留实际原工具名。
		name: match.name,
		// 从候选快照找对应描述，若没找到则空串；没有再请求远端刷新。
		description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
	}));
}

/**
 * The `tool_search` description. It does not list the searchable tools or their namespaces, so it
 * stays the same while tools are registered, for example when MCP servers connect.
 */
// 固定模型提示，故后来MCP注册新工具不会改这段description；不是把所有工具说明塞进每次搜索提示。
export const TOOL_SEARCH_DESCRIPTION = `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools, such as tools of MCP servers, may not have been provided to you upfront, and you should use this tool (\`${TOOL_SEARCH_TOOL_NAME}\`) to search for the required tools. For MCP tool discovery, always use \`${TOOL_SEARCH_TOOL_NAME}\`.`;

/** 创建模型侧工具定义，执行时才读工具集合、排名并激活。例query="docs",limit=2；它不是脚本里的searchTools（后者只搜索、不改变声明）。 */
export function createToolSearchToolDefinition(
	// 缺省没有tools，照样可创建定义，但搜索将没有候选。
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	// 返回新定义对象，不立即搜索。
	return {
		// 固定名称。
		name: TOOL_SEARCH_TOOL_NAME,
		// 展示标签。
		label: TOOL_SEARCH_TOOL_NAME,
		// 固定完整模型说明。
		description: TOOL_SEARCH_DESCRIPTION,
		// 系统提示的简短工具用途。
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		// 绑定参数schema，实际验证由宿主调用链进行。
		parameters: toolSearchSchema,
		// Searching is not something scripts need; it changes what the model sees.
		// model-only使它不能作为脚本的普通嵌套工具，避免脚本搜索动作改变模型声明集合。
		exposure: "model-only",
		// A query can match any tool that is not declared yet.
		// 声明可能触及所有工具，让MCP准备钩子等服务器就绪；并不是现在真的逐个调用所有工具。
		reachesTools: () => "all",
		/** 校验业务参数→搜索/激活→生成文字和loaded详情；失败抛错给工具执行器，不吞成“没找到”。 */
		async execute(_toolCallId, { query, limit }) {
			// 只拒绝trim后空白，原query继续传排名器，那里再规范化/分词。
			if (query.trim() === "") throw new Error("query must not be empty");
			// ??保留显式0供下一行报错，没有limit才取8。
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			// 正整数业务约束；NaN/Infinity/小数/0负数都拒绝，不为方便强行取整。
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			// 有接口才读会话，没接口得到[]，不自行实例化工具目录。
			const tools = options.tools ? searchAndLoad(options.tools, query, max) : [];
			// 生成模型看到的文字：空结果固定提示，非空列出本次新激活数量。
			// 非空模板内部先map每个工具为“名称:描述首行”，再以LF连接；这里只在模板外解释，保持实际提示字符串不变。
			const text =
				tools.length === 0
					? "No matching tools found."
					: `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
							.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`)
							.join("\n")}`;
			// 模型content是一块文字；details.loaded保存实际加载名称，供显示/检查，不额外执行工具。
			return { content: [{ type: "text", text }], details: { loaded: tools.map((tool) => tool.name) } };
		},
	};
}
