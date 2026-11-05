/**
 * 会话选择器的文字搜索：解析普通词/双引号短语/re:正则，匹配会话概览的名字、id、用户/助手正文与 cwd，并筛选/排序。
 * 例 cache "node cve" 要求两个词都匹配，可以分别落在名字和正文；一个词不能拼接不同字段，但 allMessagesText 本身已拼接全文件多条消息。
 * 不读会话文件、不调用模型；SessionManager 先生成概览。正文小写/空白归一化用 WeakMap 按对象身份缓存，正文串变化时重新生成。
 * 分数越低越优；recent 只保留输入顺序，其他有搜索模式按数值相关度排。正则执行没有超时/长度预算，不把 TS 类型当查询运行时验证器。
 */
// 复用 TUI 的大小写无关模糊匹配/评分；它按 UTF-16 下标找按序字符，特定字母数字组合还有交换回退，不是编辑距离。
import { fuzzyMatch } from "@earendil-works/pi-tui";
// SessionInfo 只作类型，包含全文件概览，不因 import type 执行磁盘加载。
import type { SessionInfo } from "../../../core/session-manager.ts";

// 三种显示模式的字面量联合；threaded 的无查询树形布局在 session-selector.ts，本 helper 不建立父子树。
export type SortMode = "threaded" | "recent" | "relevance";

// all 不限制名字，named 只保留 trim 后非空名字；不是按当前搜索是否匹配名字筛选。
export type NameFilter = "all" | "named";

// 解析结果接口含独立字段，没有用联合强制 mode 与 regex/tokens 关联；调用方应按解析器产出使用，TS 不运行验证。
export interface ParsedSearchQuery {
	// 决定使用词元还是正则路径。
	mode: "tokens" | "regex";
	// 每个词元有类型标签与原文字；数组可变，TS 不冻结解析结果。
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	// RegExp 对象或 null；null 可表示非正则或解析失败，不能单凭此字段判断成功。
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	// 可选错误消息，filterAndSortSessions 遇真值返回空数组，不抛正则语法错误给 UI。
	error?: string;
}

// 匹配结果有布尔和数字分，未用标签联合限制两字段关联。
export interface MatchResult {
	// 是否通过所有词或所选正则。
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	// 只有 matches 为 true 时才参与排序，失败分数0不是高质量匹配。
	score: number;
}

// normalizeWhitespaceLower 接文本，转小写→连续空白压成一格→去两端空白，返回新串无外部修改；例如 Node 换行 CVE 变 node cve，不做拼音/音调归一化。
function normalizeWhitespaceLower(text: string): string {
	// 链式操作均返回字符串；正则 g 替换所有空白段，包含换行但不解析 Markdown。
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Match tiers, best first. Each token is scored by the best field it matches; tiers dominate
 * fuzzy scores so an exact hit anywhere beats a scattered subsequence in a short field.
 */
// 名字中出现连续查询子串的档位0，随后还可加模糊评分以区分名字内位置。
const TIER_NAME = 0; // query text appears in the session name
// id/正文/cwd 连续子串匹配档位1，正文出现早晚不再影响同档分数。
const TIER_TEXT = 1; // query text appears in the session id, messages, or cwd
// 名字/cwd 散落字符匹配档位2，不对 id/正文做这种模糊搜索。
const TIER_FUZZY = 2; // query characters appear scattered in the session name or cwd
// 数字分档权重100万是排序启发式，不是词法元组比较；模糊分无本模块证明的全局界限，多词还会求和，别推广成任意输入下档位绝对优先的定理。
const TIER_WEIGHT = 1_000_000;

// 缓存项同时保留源正文和派生串，便于对象复用但内容变化时失效。
interface LowercaseCache {
	// 原 allMessagesText 字符串，用内容相等判断缓存是否仍适用。
	source: string;
	// 只转小写的正文，用于普通连续子串匹配。
	lower: string;
	// 短语匹配需要时才生成空白归一化版本，? 表示尚未算可缺省。
	normalized?: string;
}

/**
 * Lowercased message text per session. allMessagesText holds every user/assistant message and
 * can be megabytes, so lowercase it once instead of on every keystroke.
 */
// 弱键是 SessionInfo 对象，缓存值不反指对象，不单独延长它寿命；换一个同内容对象仍会重新缓存，不是全局按会话 id 永久存储。
const messageTextCache = new WeakMap<SessionInfo, LowercaseCache>();

// getMessageText 查对象缓存并校验源串，返回缓存对象；例如同一会话 allMessagesText 改后会重建 lower 并丢旧 normalized。会改 WeakMap，无磁盘/网络操作。
function getMessageText(session: SessionInfo): LowercaseCache {
	// let 允许缓存缺失/失效时换成新对象。
	let cached = messageTextCache.get(session);
	// 没缓存或源正文字符串内容不同才重算，不靠文件 mtime 或 session.id 判版本。
	if (!cached || cached.source !== session.allMessagesText) {
		// 保存当前源串和小写派生串，不复制整个 SessionInfo。
		cached = { source: session.allMessagesText, lower: session.allMessagesText.toLowerCase() };
		// 按同一对象身份写回 WeakMap，替换旧缓存项。
		messageTextCache.set(session, cached);
	}
	// 返回缓存对象本身，供下面延迟补 normalized。
	return cached;
}

// getNormalizedMessageText 先拿有效小写缓存，再按需算短语正文，返回字符串；例如多次短语搜索复用压缩空白后的正文，不修改会话原文。
function getNormalizedMessageText(session: SessionInfo): string {
	// 先让 getMessageText 处理源正文变化，不能直接复用失效的 normalized。
	const cached = getMessageText(session);
	// ??= 只有字段 null/undefined 时赋值，已有空串也会保留；连续空白压一格、两端去掉。
	cached.normalized ??= cached.lower.replace(/\s+/g, " ").trim();
	// 返回已得到的字符串，后续调用不重复归一化同源正文。
	return cached.normalized;
}

// tierScore 将档位与细分分数合成一个 number，无副作用；例如档位1默认细分0得100万，数字默认参数仅在未提供时取0。
function tierScore(tier: number, score = 0): number {
	// 乘权重再加分，不截断/夹紧数值，也不构建可逐字段比较的排序元组。
	return tier * TIER_WEIGHT + score;
}

/** Exact (case-insensitive) text match. Messages and ids are only matched exactly: scattered matches in them are noise. */
// matchLiteralToken 依名字→id→正文→cwd 找连续小写子串，返回首个命中档位分或 undefined；value 由上游转小写，例如 cache 命中正文深处仍只得档位1。名字命中才额外按位置评分，无文件读写。
function matchLiteralToken(session: SessionInfo, value: string): number | undefined {
	// 可选链处理无名字，?? 补空串；名字仍未压缩空白。
	const name = session.name?.toLowerCase() ?? "";
	// includes 是连续子串，不要求字段整体相等；名字命中用 fuzzyMatch 细分分数，先返回而不再比较其他字段。
	if (name.includes(value)) return tierScore(TIER_NAME, fuzzyMatch(value, name).score);
	// id 连续子串匹配，统一档位1，不做散落字符对齐。
	if (session.id.toLowerCase().includes(value)) return tierScore(TIER_TEXT);
	// 正文用缓存小写串，任何位置命中都同档，避免长正文里靠后出现被罚。
	if (getMessageText(session).lower.includes(value)) return tierScore(TIER_TEXT);
	// cwd 连续命中同档；这只是路径字符串搜索，不规范 realpath。
	if (session.cwd.toLowerCase().includes(value)) return tierScore(TIER_TEXT);
	// 四处都没命中，用 undefined 区分合法得分0。
	return undefined;
}

// matchFuzzyToken 先尝试连续命中，再仅比较名字/cwd 的最佳模糊分，返回数值或 undefined；例如 c-a-c-h-e 名字可匹配 cache，正文散落字符不算。缓存正文读取可能发生，但不读磁盘。
function matchFuzzyToken(session: SessionInfo, value: string): number | undefined {
	// 普通词先转小写给连续匹配器，保留它的字段档位优先路径。
	const literal = matchLiteralToken(session, value.toLowerCase());
	// !==undefined 让名字得分0/负数都算已命中，不继续尝试散落匹配。
	if (literal !== undefined) return literal;

	// best 初始 undefined 表示尚无成功字段，不以0当缺省分。
	let best: number | undefined;
	// 只对名字和工作目录做模糊搜索，不把全部正文送入模糊评分。
	for (const field of [session.name ?? "", session.cwd]) {
		// helper 自己处理大小写，返回 matches 与 score，不要求原 value 已小写。
		const m = fuzzyMatch(value, field);
		// 只取真正命中的更小分；&&/|| 短路使无 best 时无需比较。
		if (m.matches && (best === undefined || m.score < best)) best = m.score;
	}
	// 两字段均没命中则 undefined，有命中加档位2权重。
	return best === undefined ? undefined : tierScore(TIER_FUZZY, best);
}

// matchPhraseToken 接已经归一化的短语，对字段做连续匹配，返回档位或 undefined；例如 "node cve" 可匹配正文中多段空白，id 仅转小写而不压空白，未做同等规范化。
function matchPhraseToken(session: SessionInfo, phrase: string): number | undefined {
	// 名字先转小写、空白压缩并 trim，短语规范化由调用者完成。
	const name = normalizeWhitespaceLower(session.name ?? "");
	// 名字连续命中用档位0并按模糊 helper 评分细分，而非把整名字相等作为唯一条件。
	if (name.includes(phrase)) return tierScore(TIER_NAME, fuzzyMatch(phrase, name).score);
	// id 只小写，短语中的单空格不会自动匹配 id 内多空格。
	if (session.id.toLowerCase().includes(phrase)) return tierScore(TIER_TEXT);
	// 正文取延迟归一化缓存，可能跨原文件消息之间拼入的空格命中。
	if (getNormalizedMessageText(session).includes(phrase)) return tierScore(TIER_TEXT);
	// cwd 同样压空白后查短语，不读取目录。
	if (normalizeWhitespaceLower(session.cwd).includes(phrase)) return tierScore(TIER_TEXT);
	// 均无连续命中则 undefined，不回退散落字母搜索。
	return undefined;
}

// matchRegex 按名字→id/原正文/cwd 执行给定正则，返回档位或 undefined；解析器正常提供仅 i 的正则，不统一空白。若外部自造 g/y 正则，本函数不会重置 lastIndex，会沿对象的状态语义执行。
function matchRegex(session: SessionInfo, regex: RegExp): number | undefined {
	// 非空名字先试，命中直接档位0，不按出现位置细分。
	if (session.name && regex.test(session.name)) return tierScore(TIER_NAME);
	// 其他三个字段用 || 短路，正则不跨字段拼接；正文自身包含多消息拼接。
	if (regex.test(session.id) || regex.test(session.allMessagesText) || regex.test(session.cwd)) {
		// 任一其他字段命中统一档位1。
		return tierScore(TIER_TEXT);
	}
	// 都失败用 undefined；这里不 catch 访问/执行异常或限制正则耗时。
	return undefined;
}

// hasSessionName 接概览，返回名字去空白后是否非空，无副作用；例如空串/全空格/缺省都 false，不检查文件名。
export function hasSessionName(session: SessionInfo): boolean {
	// ?. 缺名字得 undefined，Boolean 统一成真正布尔值。
	return Boolean(session.name?.trim());
}

// matchesNameFilter 根据名字筛选开关返回布尔，无修改；例如 all 保留无名会话，named 再用 hasSessionName。
function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	// all 直接通过，不需要读取名字。
	if (filter === "all") return true;
	// 剩余合法模式 named，委托判断非空名字。
	return hasSessionName(session);
}

// parseSearchQuery 接原查询、返回词元/正则描述，不匹配会话；先 trim，re: 编 i 正则，否则扫描双引号和空白。例如 foo "node cve" 得普通词+短语；未闭引号退空白分词并保留引号字符，不按语法错误清空。
// 正则语法失败转 error 字段，无执行超时/输入预算；双引号没有反斜线转义机制，TS 接口不自动检查外部手造结果。
export function parseSearchQuery(query: string): ParsedSearchQuery {
	// 先去查询两端空白，后续解析都基于这个新串。
	const trimmed = query.trim();
	// 空查询视为零词元，不创建正则。
	if (!trimmed) {
		// 返回完整描述对象，regex 用 null 明确未用。
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	// 前缀严格区分大小写，只认 re:；RE: 仍按普通词解析。
	if (trimmed.startsWith("re:")) {
		// 截去前3个 UTF-16 单元，再 trim 正则表达式文字。
		const pattern = trimmed.slice(3).trim();
		// 表达式空时记录专门错误，而非编译能匹配任意位置的空正则。
		if (!pattern) {
			// mode=regex 但 regex=null，error 告诉上层返回无匹配。
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		// 捕获构造正则时的语法错误，不包后面实际 regex.test 执行。
		try {
			// 固定 i 忽略大小写，没有 g/y/m/s/u 标志；用户输入斜杠不会被当 /pattern/flags 语法剥掉。
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
			// catch 接未知抛出值，局部变量 err 需区分 Error 与其他值。
		} catch (err) {
			// Error 用 message，其他 String 化，供返回诊断使用。
			const msg = err instanceof Error ? err.message : String(err);
			// 失败仍返回解析结构，不向 UI 抛语法错误。
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	// 词元数组用对象数组类型声明，kind 是两项字面联合，不创建运行枚举。
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	// buf 累积当前段文字，遇空白/引号边界时 flush。
	let buf = "";
	// 当前是否在双引号内部，不包括外层引号本身。
	let inQuote = false;
	// 记录最终是否留未闭引号，稍后决定整体回退。
	let hadUnclosedQuote = false;

	// flush 闭包接词元类别，把 buf trim 后清空并按需追加，返回 void；例如引号闭合将整段空白规范化之前的文字记为 phrase，纯空段忽略，会修改局部 buf/tokens。
	const flush = (kind: "fuzzy" | "phrase"): void => {
		// 先保存去两端空白的当前段。
		const v = buf.trim();
		// 立即清空累积区，下一段从空开始。
		buf = "";
		// 空段不加词元，例如两个引号直接相邻。
		if (!v) return;
		// 对象属性简写保存类别与文字，不在这里统一内部空白或小写。
		tokens.push({ kind, value: v });
	};

	// 按 UTF-16 下标逐单元扫描，结构判断关心 ASCII 双引号与正则定义的空白字符。
	for (let i = 0; i < trimmed.length; i++) {
		// ! 非空断言基于循环边界，不运行额外检查。
		const ch = trimmed[i]!;
		// 只有双引号切换模式，单引号/反斜线没有额外转义含义。
		if (ch === '"') {
			// 已经在引号内，当前引号表示闭合。
			if (inQuote) {
				// 把引号内段作为 phrase 放入数组。
				flush("phrase");
				// 退出引用模式。
				inQuote = false;
			} else {
				// 引号外的前一段先按 fuzzy 结束，即使引号紧贴普通文字也分成两个词元。
				flush("fuzzy");
				// 进入引用模式，直到后面双引号或末尾。
				inQuote = true;
			}
			// 引号自身不加入正常 buf，开始下一字符。
			continue;
		}

		// 只有引号外的空白才分词；引号内空白保留在 buf。
		if (!inQuote && /\s/.test(ch)) {
			// 把普通词元冲入数组并清缓冲。
			flush("fuzzy");
			// 分隔空白不加入词元正文。
			continue;
		}

		// 其他字符按原样追加，大小写/内部空白在匹配阶段再处理。
		buf += ch;
	}

	// 扫描完仍在引号内，说明引号数不平衡。
	if (inQuote) {
		// 标记整体回退，不把之前已得到的部分词元直接作为最终结果。
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	// 未闭合时丢弃刚才分段成果，改从原 trimmed 重新分词。
	if (hadUnclosedQuote) {
		// 返回一个新的词元解析结构。
		return {
			// 保持 tokens 模式，不用 error 表示未闭引号。
			mode: "tokens",
			// 下面链式操作从原串产生 fallback tokens，因此未配对的引号也会留在 value。
			tokens: trimmed
				// 按连续空白分段，不再识别任何引号。
				.split(/\s+/)
				// 各段再 trim，主要用于保持每项无两端空白。
				.map((t) => t.trim())
				// 丢空项，避免生成空查询词。
				.filter((t) => t.length > 0)
				// 每段标 fuzzy，as const 保留字面标签类型，不做运行转换。
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			// 明确不用正则。
			regex: null,
		};
	}

	// 正常扫描结束补最后一段；此时不平衡情况已返回，inQuote 实际为 false，所以通常 flush fuzzy。
	flush(inQuote ? "phrase" : "fuzzy");

	// 返回正常词元数组，未提供 error，regex=null。
	return { mode: "tokens", tokens, regex: null };
}

/**
 * Each field is matched separately, so a token never matches across field boundaries.
 * Different tokens may match different fields.
 */
// matchSession 按 parsed 模式对一个概览评分，所有词都需匹配，返回 matches/总分；例如 cache命中名字、node命中正文也可整体通过，单词不能由名字尾+正文头拼出。会填正文缓存，不改概览。
// 本函数不单独读取 parsed.error；正常 filterAndSortSessions 先处理解析错误，外部自造描述应遵守契约。
export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	// 正则模式不处理 tokens 数组。
	if (parsed.mode === "regex") {
		// 缺正则对象就返回失败，包括解析失败的正常产物。
		if (!parsed.regex) {
			// 失败 score=0 是占位，不参与后面相关度排序。
			return { matches: false, score: 0 };
		}
		// 在字段间按固定顺序尝试同一个正则。
		const score = matchRegex(session, parsed.regex);
		// undefined 才是失败，合法0分也返回 matches:true。
		return score === undefined ? { matches: false, score: 0 } : { matches: true, score };
	}

	// 词元路径累计分从0开始，零词元自然全通过。
	let totalScore = 0;

	// 按查询词元顺序逐个要求成功，可落在不同字段。
	for (const token of parsed.tokens) {
		// 局部分数需容纳 undefined 表示该词未匹配。
		let score: number | undefined;
		// 短语走空白/大小写归一化后的连续匹配。
		if (token.kind === "phrase") {
			// 规范化词元文字，不修改 parsed 内 value。
			const phrase = normalizeWhitespaceLower(token.value);
			// 空短语忽略，正常解析器已过滤纯空白段，外部自造输入仍可进入此分支。
			if (!phrase) continue;
			// 计算短语字段档位分。
			score = matchPhraseToken(session, phrase);
		} else {
			// 其他合法标签 fuzzy，用连续优先/名字目录模糊回退。
			score = matchFuzzyToken(session, token.value);
		}
		// 只要一个词没命中就整体失败，不累计部分成功作为匹配。
		if (score === undefined) return { matches: false, score: 0 };
		// 把每个词的档位/细分分数相加，不是只看最弱词档位。
		totalScore += score;
	}

	// 所有词通过，返回总分，空词元为 true/0。
	return { matches: true, score: totalScore };
}

// filterAndSortSessions 输入概览数组/查询/模式/可选名字筛选，返回筛选后的原概览引用数组；先名字过滤→空查询返回→解析→匹配，recent 保留输入顺序，其他按总分/modified排。
// 例 recent 不自行按日期排序，依赖宿主原序；空查询也不排序，nameFilter=all 时直接返回原数组。非空 threaded 查询同 relevance 平铺排序，树形由外部无查询分支负责。
export function filterAndSortSessions(
	// 输入概览不复制内部对象，排序阶段仅排新包装数组。
	sessions: SessionInfo[],
	// 查询原文，可以含引号或 re: 前缀。
	query: string,
	// TS 联合限制三模式，运行时不验证任意字符串。
	sortMode: SortMode,
	// 名字过滤默认 all，默认参数在 undefined 时使用。
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	// 先按名字过滤，表达式下一行完成。
	const nameFiltered =
		// all 直接复用数组，named 才建过滤数组；此阶段不匹配搜索正文。
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	// 仅用于空查询判断，实际解析函数仍收到原 query 并自己 trim。
	const trimmed = query.trim();
	// 空查询早返，不重排 recent/relevance/threaded 的输入顺序。
	if (!trimmed) return nameFiltered;

	// 解析一次供所有会话复用，不为每项重新编译正则。
	const parsed = parseSearchQuery(query);
	// 有错误直接空结果，UI 不在此显示错误细节。
	if (parsed.error) return [];

	// Recent mode: filter only, keep incoming order.
	// recent 模式只过滤而不计算跨项排序。
	if (sortMode === "recent") {
		// 新结果数组初始空，不原地删输入项。
		const filtered: SessionInfo[] = [];
		// 沿原数组顺序访问会话。
		for (const s of nameFiltered) {
			// 仍计算每会话匹配结果，总分只是此模式不用于排序。
			const res = matchSession(s, parsed);
			// 通过的原对象依次入新数组。
			if (res.matches) filtered.push(s);
		}
		// 保持输入相对次序返回，不自行证明日期降序。
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	// 其他模式把匹配项和分数暂存，新数组随后 sort 不改原 sessions 数组。
	const scored: { session: SessionInfo; score: number }[] = [];
	// 逐项评分。
	for (const s of nameFiltered) {
		// 复用同一 parsed 描述，可能逐对象填 WeakMap 正文缓存。
		const res = matchSession(s, parsed);
		// 失败项不进入排序。
		if (!res.matches) continue;
		// 包装保留原 session 引用与总分。
		scored.push({ session: s, score: res.score });
	}

	// 原地排序仅改变局部包装数组。
	scored.sort((a, b) => {
		// 先按得分升序，小分优先，允许负数和小数。
		if (a.score !== b.score) return a.score - b.score;
		// 同分按 modified 毫秒降序；类型 Date 不证明有效时间，NaN 会沿 JS sort 语义处理，不另修复。
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	// 剥掉包装返回原概览对象引用的新数组，不写会话文件。
	return scored.map((r) => r.session);
}
