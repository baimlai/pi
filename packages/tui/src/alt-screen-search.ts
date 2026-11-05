// 备用屏的全文搜索基础：从渲染后的行建立可搜索文本和原始行列映射，再提供缓存索引与三行搜索框；上层TuiAltScreen负责导航、滚动和高亮。
// 搜索的是渲染文本而不是会话原始消息：剥受支持终端序列、折叠空白/换行，用忽略大小写的字面量匹配；不执行正则查询，也不做NFC规范化或去重音。
// 复用单行输入组件，只存查询和绘制内容，不在这里启动真实终端。
import { Input } from "./components/input.ts";
// 读取共享快捷键配置显示按钮提示；不写死按键匹配，也不在本文件执行上一项/下一项导航。
import { getKeybindings } from "./keybindings.ts";
// type导入仅提供编译期组件/焦点契约，运行时不加载一份接口对象。
import type { Component, Focusable } from "./tui.ts";
// 共享字素分段、剥序列、按列截断/计宽，统一搜索高亮和布局的终端列单位。
import { getGraphemeSegmenter, stripTerminalSequences, truncateToWidth, visibleWidth } from "./utils.ts";

// 取得模块共享的Intl字素分段器；组合字母/emoji尽量保持完整，不等同按UTF-16码元遍历。
const segmenter = getGraphemeSegmenter();

// 把归一化文本片段映射回渲染行列的内部类型；interface只约束开发期结构，实际保存普通对象。
interface SearchSourceSpan {
	// 该片段在合并搜索字符串中的包含起点，单位UTF-16码元。
	textStart: number;
	// 合并字符串中的排他终点，不是终端列。
	textEnd: number;
	// 对应输入lines的零起始行号。
	row: number;
	// 对应渲染行里的包含起列，ANSI代码不占列。
	startCol: number;
	// 对应渲染行里的排他终列，中文等宽字素可占多列。
	endCol: number;
	// true表示ASCII连续词串可按码元偏移直接算列；false表示整字素映射，匹配到字素内部也高亮整个字素。
	linearColumns: boolean;
}

// 一次建立的搜索语料：合并后的文字及从文字到原行列的映射，控制码/被折叠空白没有单独span。
interface SearchCorpus {
	// 供text.matchAll(expression)按正则扫描的归一化字符串，matchAll是字符串方法。
	text: string;
	// 按文本位置顺序排列的映射数组，供匹配后回到屏幕列。
	spans: SearchSourceSpan[];
}

// 一个命中在某行需要高亮的左闭右开区间，导出给TuiAltScreen，类型本身不绘制高亮。
export interface AltScreenSearchSegment {
	// 渲染内容的行号，不是当前屏幕viewport中的相对行。
	row: number;
	// 高亮包含起列。
	startCol: number;
	// 高亮排他终列，不能把它当成最后一个仍包含的列号。
	endCol: number;
}

// 一个搜索命中可横跨多行或中间隔着折叠空白，因此用多个行列区间表示。
export interface AltScreenSearchMatch {
	// 按文本顺序保存的区间；只有映射到实际内容的区间才会生成，不高亮插入的归一化空格。
	segments: AltScreenSearchSegment[];
}

// 整行都是可打印ASCII（含空格）时用快路；*也允许空行，不能把这条规则当任意Unicode可打印检查。
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// 把渲染行数组转换成可搜索语料，返回文本和映射；不改输入，按ASCII连续非空格串或Unicode字素建立span。
// 例：["foo  bar","baz"]得到“foo bar baz”，但bar仍映射原第0行第5列；首尾空白不保留，跨行只加一个分隔空格。
function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
	// 先收集小文本块，最后join一次形成搜索字符串。
	const chunks: string[] = [];
	// 保存每块非空白内容对应的原行列范围。
	const spans: SearchSourceSpan[] = [];
	// 目前归一化文本累计的UTF-16码元长度，与原屏幕列分开记账。
	let textLength = 0;
	// 记住“下一段正文前需要一个空格”，延迟插入以免产生尾随空格。
	let pendingSeparator = false;

	// 无参数闭包，只有存在待分隔状态时才追加一个空格；修改chunks/textLength/pendingSeparator，不创建span。
	const appendSeparator = (): void => {
		// 没有待分隔的空白就无需插入。
		if (!pendingSeparator) return;
		// 把任意长度的原空白压成一个ASCII空格。
		chunks.push(" ");
		// 归一化字符串长度增加1，不改变原行的column。
		textLength += 1;
		// 分隔符已消费，连续正文不再重复插空格。
		pendingSeparator = false;
	};

	// 按输入行顺序建立索引，不重排原行。
	for (let row = 0; row < lines.length; row++) {
		// 剥掉本解析器识别的终端控制序列；缺行值回退空串，但不是全面控制字符消毒。
		const line = stripTerminalSequences(lines[row] ?? "");
		// 这一行原渲染文本的显示列坐标从0重新开始。
		let column = 0;

		// Rendered transcripts are overwhelmingly ASCII. Index complete non-space
		// runs at once instead of segmenting and allocating one mapping per cell.
		// ASCII整行没有宽字/组合字素，可以用码元长度直接作列宽。
		if (PRINTABLE_ASCII.test(line)) {
			// ASCII行的原字符串下标。
			let index = 0;
			// 按空格和非空格连续段遍历这一行。
			while (index < line.length) {
				// 普通ASCII行中空白只有空格，直接比较数值0x20。
				if (line.charCodeAt(index) === 0x20) {
					// 前面已经有正文才需要分隔；开头空格仅推进原列，不进入语料。
					if (textLength > 0) pendingSeparator = true;
					// 原渲染行的空格仍占1列，要保留其位置影响。
					column += 1;
					// 输入下标越过这个空格。
					index += 1;
					// 继续扫描，直到找到后面的非空格内容才真正插入分隔符。
					continue;
				}
				// 非空格串至少有当前这一码元，准备找其末尾。
				let end = index + 1;
				// 一次扩展整个连续非空格串，减少每字符一个span的分配。
				while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
				// 如前面遇过空格/换行，在新串前插入一个归一化空格。
				appendSeparator();
				// 取出这段ASCII连续正文。
				const text = line.slice(index, end);
				// 将它作为一个块加入语料。
				chunks.push(text);
				// 建立这整段文字到原行列的映射。
				spans.push({
					// 起点是当前语料长度，已包含刚补的分隔符。
					textStart: textLength,
					// 语料终点用ASCII串长度推进。
					textEnd: textLength + text.length,
					// 属性简写，使用当前遍历的行号。
					row,
					// 保存原行中的实际起列，不因空白折叠而左移。
					startCol: column,
					// ASCII串每码元1列，原终列可直接相加。
					endCol: column + text.length,
					// 标记后续可以在这个span内精确截出部分词的列范围。
					linearColumns: true,
				});
				// 语料累计码元长度增加整个串。
				textLength += text.length;
				// 原行列位置同样增加串宽，此分支才有二者相等的关系。
				column += text.length;
				// 原行下标转到该词串末尾。
				index = end;
			}
			// 非ASCII整行必须用字素和真实列宽映射。
		} else {
			// Intl逐个产出完整字素对象；即使字素内部有多个码点也作为一个映射单位。
			for (const grapheme of segmenter.segment(line)) {
				// 取该字素的原文。
				const text = grapheme.segment;
				// 测字素显示列数，tab固定3列，控制/组合标记按utils规则处理。
				const width = visibleWidth(text);
				// 整个字素都为空白时折叠为语料分隔，不建立正文span。
				if (/^\s+$/u.test(text)) {
					// 只在已有语料正文后才记待插空格，避免开头空白。
					if (textLength > 0) pendingSeparator = true;
					// 原行仍按字素实际宽度推进，不能按归一化1空格算。
					column += width;
					// 暂不插分隔符，避免行末尾留下无用空格。
					continue;
				}
				// 下一个非空白字素前补上必要的单空格。
				appendSeparator();
				// 把完整字素原文放入语料，保持UTF-16内容而非转音译/正规化。
				chunks.push(text);
				// 为这个字素创建单独映射，Unicode慢路不会把它按内部码元拆开。
				spans.push({
					// 记录合并文本起点。
					textStart: textLength,
					// 记录码元终点；例如辅助平面字可能length=2但显示列宽另算。
					textEnd: textLength + text.length,
					// 记录这个字素所属原行。
					row,
					// 原行的包含起列。
					startCol: column,
					// 用visibleWidth算出的宽度确定原行终列。
					endCol: column + width,
					// 即使查询只命中组合字素的一部分，也按完整字素范围高亮，不用码元偏移直接作列。
					linearColumns: false,
				});
				// 合并文本的码元长度增加原字素length。
				textLength += text.length;
				// 原渲染列增加终端宽度，二者可能不同。
				column += width;
			}
		}
		// 每行后预留一个跨行空格，只有后续还有正文才会真正插入，空行/多空白仍折成单空格。
		if (textLength > 0) pendingSeparator = true;
	}

	// 连接正文块，返回映射数组；不会复制或冻结其中的对象。
	return { text: chunks.join(""), spans };
}

// 归一化用户查询的空白，返回新串不改输入；例：“ foo\n  bar ”变成“foo bar”，不改大小写或Unicode组合形式。
function normalizeQuery(query: string): string {
	// \s+合并连续空白为一个空格，gu覆盖所有Unicode感知匹配，trim再去掉头尾空白。
	return query.replace(/\s+/gu, " ").trim();
}

// 转义查询里的正则元字符，返回可作字面量模式的字符串，无副作用；例：a.b中的点不再表示任意字符。
function escapeRegExp(text: string): string {
	// 替换串中的$&表示原匹配内容，前面的反斜杠让这些字符按字面意义匹配，而非执行用户提供正则。
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 在已归一化语料中找查询，再把每个命中还原成原行列区间，返回新命中数组，不修改语料。
// 例：跨行“quick brown”得到两段高亮；giu忽略大小写且找非重叠命中，ASCII可取词内部分，Unicode映射按整个字素扩大，不做重音/正规化等价搜索。
function findSearchCorpusMatches(corpus: SearchCorpus, normalizedQuery: string): AltScreenSearchMatch[] {
	// 空查询不匹配每个位置，直接返回空数组。
	if (!normalizedQuery) return [];
	// 先转义再构造正则，g全局、i忽略大小写、u使用Unicode语义；仍是字面量文本搜索。
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	// 保存每一个可映射回原文的完整命中。
	const matches: AltScreenSearchMatch[] = [];
	// 按搜索文本顺序推进的span游标，避免每次命中都从映射数组头重扫。
	let spanIndex = 0;

	// matchAll按原文位置逐个给出非重叠结果，模式含g才能使用该全局迭代方式。
	for (const match of corpus.text.matchAll(expression)) {
		// match.index是合并字符串的码元起点，不是显示列。
		const start = match.index;
		// 加匹配原文长度得到排他终点。
		const end = start + match[0].length;
		// 跳过已经完全在命中起点之前的span；!是编译期非空断言，循环范围保证索引有效。
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= start) spanIndex += 1;

		// 当前命中可能跨行/空格，收集它对应的多个高亮片段。
		const segments: AltScreenSearchSegment[] = [];
		// 从第一个可能相交的span开始扫描。
		for (let index = spanIndex; index < corpus.spans.length; index++) {
			// 取当前映射对象，不复制它，也不修改其字段。
			const span = corpus.spans[index]!;
			// span已到命中终点之后，再往后不会相交，可以结束。
			if (span.textStart >= end) break;
			// span完全在命中之前则跳过。
			if (span.textEnd <= start) continue;
			// ASCII可按内部偏移取部分，Unicode则从整个字素起列开始高亮。
			const startCol = span.linearColumns
				? // 取命中起点与span起点较大者，减去span文本起点得码元偏移，再加原起列。
					span.startCol + Math.max(start, span.textStart) - span.textStart
				: // 非线性字素映射不能把码元偏移直接当列数，使用整字素原起列。
					span.startCol;
			// ASCII取命中终点/span终点较小值换算列；Unicode直接取整个字素终列。
			const endCol = span.linearColumns ? span.startCol + Math.min(end, span.textEnd) - span.textStart : span.endCol;
			// 查看当前命中已产生的最后一段，可能不存在。
			const previous = segments[segments.length - 1];
			// 同一行且两段接触/重叠时合并，跨原空白的有间隔片段不会被抹平。
			if (previous && previous.row === span.row && startCol <= previous.endCol) {
				// 把已有结果片段终列扩到较右端；只修改本次新建的结果对象。
				previous.endCol = Math.max(previous.endCol, endCol);
				// 不相邻或换行就需要新片段。
			} else {
				// 保存原行号与左闭右开列边界。
				segments.push({ row: span.row, startCol, endCol });
			}
		}
		// 跳过截至本次命中末尾已消费完的span；若命中在ASCII词中间，保留该span供下次继续映射。
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex]!.textEnd <= end) spanIndex += 1;
		// 只有确有原文片段才收录命中，不为纯合成分隔空格生成空高亮。
		if (segments.length > 0) matches.push({ segments });
	}

	// 按出现顺序返回所有命中。
	return matches;
}

// 缓存搜索方法的返回结构，类型不冻结数据，也不自动驱动重绘。
export interface AltScreenSearchResult {
	// 命中数组可能是缓存中的同一引用，调用方应只读使用。
	matches: AltScreenSearchMatch[];
	// 原行值或归一化后的查询发生变化；不是“视觉上的高亮内容一定不同”的保证。
	changed: boolean;
}

/** Cache the searchable corpus and matches while rendered transcript lines remain unchanged. */
// 缓存渲染文本及一次查询的结果，search仍检查行数并逐行比较值，遇差异提前结束比较，再重建语料；无文件/终端I/O。
// 例：新数组含相同行字符串和相同查询，重用同一matches数组；缓存不是按数组引用判断，外部不要改返回对象。
export class AltScreenSearchIndex {
	// 上一轮原行字符串的数组副本，undefined表示尚未建索引。
	private sourceLines: string[] | undefined;
	// 去控制码、折空白后的语料和映射。
	private corpus: SearchCorpus | undefined;
	// 上一轮空白归一化查询；保留大小写，因此只改查询大小写也会触发重搜。
	private normalizedQuery: string | undefined;
	// 最新命中数组，不为每次调用额外复制。
	private matches: AltScreenSearchMatch[] = [];

	// 搜索传入渲染行/查询，返回matches与changed并更新本实例缓存；先判原行变化，再按归一化查询决定是否重匹配。
	// 例：查询空白写法变化但归一化值相同可复用；相同原行颜色代码变动也会判changed，哪怕剥序列后的正文一样。
	search(lines: readonly string[], query: string): AltScreenSearchResult {
		// 可选链读取旧长度；未建索引时undefined与任何数组长度不同，首次调用视为变化。
		let sourceChanged = this.sourceLines?.length !== lines.length;
		// 长度相同且有旧副本时，还需逐行比较字符串值。
		if (!sourceChanged && this.sourceLines) {
			// 顺序比较每一行，不做散列或按对象引用判断。
			for (let index = 0; index < lines.length; index++) {
				// 当前行原文相同则继续找下一行差异。
				if (this.sourceLines[index] === lines[index]) continue;
				// 遇到第一行不同即可判原数据变化。
				sourceChanged = true;
				// 无需继续比较剩余行，稍后会重建整份语料。
				break;
			}
		}
		// 原数据变动或未建语料时才执行索引构造。
		if (sourceChanged || !this.corpus) {
			// 复制数组容器；字符串是不可变值，之后外部替换数组元素也能在下轮检测到。
			this.sourceLines = Array.from(lines);
			// 按当前原行重新建立合并文本和映射。
			this.corpus = buildSearchCorpus(lines);
		}

		// 查询先统一空白，避免多空格形式白白触发重搜。
		const normalizedQuery = normalizeQuery(query);
		// 原文变化或归一化查询按字符串值不同，都视为需要更新；大小写比较这里仍是敏感的。
		const changed = sourceChanged || normalizedQuery !== this.normalizedQuery;
		// 只有changed才替换缓存查询和命中数组。
		if (changed) {
			// 保存本轮归一化查询。
			this.normalizedQuery = normalizedQuery;
			// 用当前语料重新计算，空查询得到空数组。
			this.matches = findSearchCorpusMatches(this.corpus, normalizedQuery);
		}
		// 返回一个新外层结果对象，但matches是内部数组原引用，不是防修改副本。
		return { matches: this.matches, changed };
	}
}

// 无需复用索引时的一次性搜索入口，返回命中数组且不修改行数组；例：用两行测试文本直接找跨行短语。
export function findAltScreenSearchMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	// 先折叠并去掉查询首尾空白。
	const normalizedQuery = normalizeQuery(query);
	// 非空才创建语料并搜索，空查询省掉原行扫描，直接返回[]。
	return normalizedQuery ? findSearchCorpusMatches(buildSearchCorpus(lines), normalizedQuery) : [];
}

// 用命中首尾坐标生成保留选择用的字符串键，无修改；例：上层重搜后用它找原来选择的位置。
// 它不包含查询/所有中间片段，不保证跨不同内容或不同索引全局唯一；空segments返回空串。
export function getAltScreenSearchMatchKey(match: AltScreenSearchMatch): string {
	// 第一段提供起始行列，可能为空。
	const first = match.segments[0];
	// 最后一段提供终止行列，单段时与first是同一个对象。
	const last = match.segments[match.segments.length - 1];
	// 首尾都存在才按四项坐标拼键，缺段返回空字符串。
	return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}

// 搜索框组件同时满足绘制和焦点接口；只显示/编辑查询、记录导航按钮位置，真正搜全文和翻结果由TuiAltScreen完成。
// 例：用户输入needle触发onQueryChange，上层search后调用setResult；implements只做编译期约束，不自动给组件焦点或鼠标事件。
export class AltScreenSearchComponent implements Component, Focusable {
	// 创建内嵌Input实例，readonly禁止重绑字段，不禁止编辑Input内部状态；创建时不渲染/不执行下面样式回调。
	private readonly input = new Input({
		// 一列空格作输入前缀，替代Input默认的>提示。
		prompt: " ",
		// 空查询时显示的占位文案，不算查询正文。
		placeholder: "Find in transcript",
		// 渲染占位时执行此回调，用SGR2弱化后以22恢复粗体/弱化正常；仅返回字符串，无终端发送。
		placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
	});
	// 只读保存查询变化回调引用，接收原始输入值而非归一化搜索词。
	private readonly onQueryChange: (query: string) => void;
	// 只读保存导航按钮样式函数，参数含文本与悬停标志；返回值需由调用者保持可见宽度，类型不保证这一点。
	private readonly navigationButtonStyle: (text: string, hovered: boolean) => string;
	// 上层传来的结果总数，初始没有命中。
	private resultCount = 0;
	// 当前结果零起始索引，-1表示初始未选；这里不校验索引范围。
	private resultIndex = -1;
	// 上一个按钮的包含起列，由最近一次render更新，初始-1表示不显示。
	private previousButtonStart = -1;
	// 上一个按钮的排他终列。
	private previousButtonEnd = -1;
	// 下一个按钮的包含起列。
	private nextButtonStart = -1;
	// 下一个按钮的排他终列。
	private nextButtonEnd = -1;
	// 字面量联合保存悬停方向：-1上一个，1下一个，undefined不悬停。
	private hoveredNavigationDirection: -1 | 1 | undefined;
	// 组件自身的焦点标志，与内嵌Input同步。
	private _focused = false;

	// 构造搜索框并保存两个回调，无显式返回；例：只传查询回调时按钮不额外着色，不会立即发查询通知。
	constructor(
		// 输入值真的变化时同步调用，错误会向上层输入分发传播。
		onQueryChange: (query: string) => void,
		// 可选样式函数默认text=>text恒等；保存函数不是调用函数，hovered参数默认回调可以不用。
		navigationButtonStyle: (text: string, hovered: boolean) => string = (text) => text,
	) {
		// 保存业务查询回调。
		this.onQueryChange = onQueryChange;
		// 保存按钮样式函数，渲染时才调用。
		this.navigationButtonStyle = navigationButtonStyle;
	}

	// 读取本搜索框焦点状态，无参数/副作用；访问为component.focused，不加调用括号。
	get focused(): boolean {
		// 返回内部布尔值，不查询全局TUI焦点。
		return this._focused;
	}

	// 赋component.focused时同步内嵌输入焦点，返回void；例：上层切到搜索时光标标记可由Input发出，不自行请求重绘。
	set focused(value: boolean) {
		// 先存搜索框自身标记。
		this._focused = value;
		// 再把同一值交给内部Input，保持焦点显示一致。
		this.input.focused = value;
	}

	// 接收上层选中索引与总数，保存供下次render显示，返回void；例：index0/count2显示1/2，不在此滚动或重搜。
	setResult(index: number, count: number): void {
		// 原样保存索引，未做夹限或从1换算。
		this.resultIndex = index;
		// 原样保存总数，显示是否有命中由render分支决定。
		this.resultCount = count;
	}

	// 按最近render的局部行列命中导航按钮，返回-1/1/undefined，无修改；例：底部第2行上一按钮内返回-1。
	getNavigationDirectionAt(row: number, column: number): -1 | 1 | undefined {
		// 组件三行从0起，只有底部按钮行是2；别的行即使有箭头字符也不算按钮。
		if (row !== 2) return undefined;
		// 左闭右开检查上一个按钮，文字快捷键部分也包含在按钮范围里。
		if (column >= this.previousButtonStart && column < this.previousButtonEnd) return -1;
		// 相同规则检查下一个按钮。
		if (column >= this.nextButtonStart && column < this.nextButtonEnd) return 1;
		// 分隔符、边框、隐藏按钮等位置都不导航。
		return undefined;
	}

	// 更新悬停方向并返回是否变化，供上层按需请求重绘；例：连续移在同一按钮上第二次返回false，不自行导航。
	setHoveredNavigationDirection(direction: -1 | 1 | undefined): boolean {
		// 相同方向无需状态更新或重绘。
		if (direction === this.hoveredNavigationDirection) return false;
		// 保存新的悬停状态，undefined可清掉高亮。
		this.hoveredNavigationDirection = direction;
		// 返回true表示上层应考虑重绘，并非已画到屏幕。
		return true;
	}

	// 把输入交内部Input，再比较值，确有变化才同步回调，返回void；例：移动光标但不改文字不会重复发搜索查询。
	handleInput(data: string): void {
		// 保存处理前的完整原值。
		const previous = this.input.getValue();
		// Input执行编辑/粘贴等逻辑，可能调用它自身回调；本组件没有额外实现搜索结果导航。
		this.input.handleInput(data);
		// 读取处理后的原始查询，未在此trim。
		const query = this.input.getValue();
		// 值不同才通知外部；回调执行发生在这行，构造时保存它不等于已执行。
		if (query !== previous) this.onQueryChange(query);
	}

	// 转交缓存失效通知，无参数/返回值；例：主题变化时调用，不清空查询/命中显示或直接重画。
	invalidate(): void {
		// 当前Input的invalidate没有缓存状态可清，仍按Component约定转发。
		this.input.invalidate();
	}

	// 按宽度生成上边框、输入/结果行、底边导航三行，并更新按钮命中区，返回字符串数组，不输出终端。
	// 例：宽时显示↑及快捷键，窄时只显示箭头，再窄就隐藏按钮；调用样式函数可能抛错或改变列宽，本类不捕获/验证，普通布局按整数列使用。
	render(width: number): string[] {
		// 最少按1列渲染，避免负空间；不是对任意NaN/小数的完整数值验证。
		const safeWidth = Math.max(1, width);
		// 左右边框各1列，内部剩余不小于0。
		const innerWidth = Math.max(0, safeWidth - 2);
		// 本次render内的格式化闭包：输入可缺键名，输出可读提示，无状态修改；例：macOS的alt显示Option，未绑定显示Unbound。
		const formatKey = (key: string | undefined): string =>
			// 键字符串有真值才格式化各组成部分。
			key
				? // 真分支从原键字符串开始链式处理。
					key
						// 如ctrl+shift+f拆成各修饰键/主键名。
						.split("+")
						// map回调逐段转换，生成新数组，不修改快捷键配置。
						.map((part) => {
							// 仅在macOS把任意大小写alt显示成Option，不改变实际匹配用的键名。
							if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
							// 其他部分首字母大写，剩余字符沿用原值。
							return part.charAt(0).toUpperCase() + part.slice(1);
						})
						// 用+重新组合显示文本。
						.join("+")
				: // 没有第一键时使用未绑定提示。
					"Unbound";
		// 每次render读当前共享键绑定，以反映用户配置更新。
		const keybindings = getKeybindings();
		// 上一个结果动作只展示其第一条别名键，可能不存在。
		const previousKey = formatKey(keybindings.getKeys("tui.altScreen.searchPrevious")[0]);
		// 下一个结果动作同样只展示第一条键。
		const nextKey = formatKey(keybindings.getKeys("tui.altScreen.searchNext")[0]);
		// 读取原查询，决定是否显示结果计数。
		const query = this.input.getValue();
		// 嵌套三元先看查询是否原始空串，不是看归一化后是否为空。
		const result = !query
			? // 空查询不显示结果提示。
				""
			: // 有查询但命中数0则显示无结果。
				this.resultCount === 0
				? // 无结果的固定文案。
					"No matches"
				: // 否则把零起始索引加1显示给用户，未在此夹限上层提供的数值。
					`${this.resultIndex + 1}/${this.resultCount}`;
		// 预留输入/结果间的空间，结果本身最多使用innerWidth-3列。
		const resultSpace = Math.max(0, innerWidth - 3);
		// 超宽结果无省略号截短，避免小窗口被计数文本撑开。
		const visibleResult = truncateToWidth(result, resultSpace, "");
		// 有可显示结果时加两侧空格并弱化样式，否则不占列。
		const resultText = visibleResult ? `\x1b[2m ${visibleResult} \x1b[22m` : "";
		// 扣掉结果提示实际列宽，剩余交给输入框。
		const inputWidth = Math.max(0, innerWidth - visibleWidth(resultText));
		// Input至少按1列生成，再截到真正inputWidth（可为0），只取其第一行，无省略号。
		const inputLine = truncateToWidth(this.input.render(Math.max(1, inputWidth))[0] ?? "", inputWidth, "");
		// 给输入区不足的列补空格，结果计数便可靠右。
		const inputPadding = " ".repeat(Math.max(0, inputWidth - visibleWidth(inputLine)));
		// 依次拼输入、补白、结果文案，不改查询文本。
		const content = `${inputLine}${inputPadding}${resultText}`;

		// 上一个按钮包含上箭头和配置键名，箭头是原UI字符而非本函数执行的动作。
		let previousButton = `↑ ${previousKey}`;
		// 下一个按钮同样包含下箭头和配置键名。
		let nextButton = `↓ ${nextKey}`;
		// 宽布局用居中的点号作为按钮分隔符。
		let separator = " · ";
		// 按钮组左右各预留1列空隙。
		const outerGapWidth = 1;
		// 从内部宽度再扣两侧空隙和1列边线位置，得到可放控制文字的预算。
		const availableControlsWidth = Math.max(0, innerWidth - outerGapWidth * 2 - 1);
		// 按实际终端列宽求按钮组宽度，颜色代码不计列。
		let controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		// 完整快捷键提示放不下时先降级为纯箭头。
		if (controlsWidth > availableControlsWidth) {
			// 上一按钮缩成单箭头。
			previousButton = "↑";
			// 下一按钮缩成单箭头。
			nextButton = "↓";
			// 分隔符也缩成一个空格。
			separator = " ";
			// 重算简化后的按钮组宽度，不能继续沿用旧值。
			controlsWidth = visibleWidth(previousButton) + visibleWidth(separator) + visibleWidth(nextButton);
		}
		// 连简化组都放不下就完全隐藏按钮。
		const showButtons = controlsWidth <= availableControlsWidth;
		// 能显示时才调用样式函数组装按钮，否则空串。
		const renderedButtons = showButtons
			? // 上一按钮回调获得其是否被悬停，返回串接入组。
				this.navigationButtonStyle(previousButton, this.hoveredNavigationDirection === -1) +
				// 两按钮之间保留已经选定的分隔符。
				separator +
				// 下一按钮回调独立判断其悬停状态。
				this.navigationButtonStyle(nextButton, this.hoveredNavigationDirection === 1)
			: // 隐藏按钮不调用样式函数。
				"";
		// 只有显示按钮时才计算左右空隙总宽2。
		const outerGapsWidth = showButtons ? outerGapWidth * 2 : 0;
		// 非空按钮组且内部还容得下时，右侧保留1列横线，否则不留。
		const rightRuleWidth = renderedButtons && innerWidth > controlsWidth + outerGapsWidth ? 1 : 0;
		// 其余内部列分配给左横线，Math.max防止负repeat次数。
		const leftRuleWidth = Math.max(
			// 横线宽度下界0。
			0,
			// 扣掉可见按钮宽、两侧空隙和右横线；按钮隐藏时不扣它们的正文宽。
			innerWidth - (showButtons ? controlsWidth : 0) - outerGapsWidth - rightRuleWidth,
		);
		// 上一按钮起列=左边框1+左横线+1空隙，坐标相对整个组件。
		const previousStart = 1 + leftRuleWidth + outerGapWidth;
		// 最近一次render的上一按钮起点，隐藏时用-1使命中范围为空。
		this.previousButtonStart = showButtons ? previousStart : -1;
		// 上一按钮终点按未着样式的文字列宽计算，要求样式回调不改变可见宽度。
		this.previousButtonEnd = showButtons ? previousStart + visibleWidth(previousButton) : -1;
		// 下一按钮起点在上一按钮终点再加分隔符宽度。
		this.nextButtonStart = showButtons ? this.previousButtonEnd + visibleWidth(separator) : -1;
		// 下一按钮终点加其文字列宽，坐标同样左闭右开。
		this.nextButtonEnd = showButtons ? this.nextButtonStart + visibleWidth(nextButton) : -1;

		// 只有1列时返回三个左侧边框字符；不输出两列宽的完整框。
		if (safeWidth === 1) return ["┌", "│", "└"];
		// 普通宽度返回三行字符串，模板只是拼文本，宿主负责输出与光标标记处理。
		return [
			// 上边框：左右角夹内部宽度的横线。
			`┌${"─".repeat(innerWidth)}┐`,
			// 中间：竖框夹输入区和右对齐结果。
			`│${content}│`,
			// 底边框按左横线、可选空隙/按钮、右横线顺序拼，命中区域已按同一几何保存。
			`└${"─".repeat(leftRuleWidth)}${renderedButtons ? " " : ""}${renderedButtons}${renderedButtons ? " " : ""}${"─".repeat(rightRuleWidth)}┘`,
		];
	}
}
