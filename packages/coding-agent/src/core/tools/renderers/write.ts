// write 的调用正文/结果显示：流式参数增长时缓存代码高亮，参数完整后按本行owner缓存复用；实际写入文件由execute负责，本文件不落盘。
/**
 * Presentation for the write tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `write.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

// Container用于无额外结果正文，Text用于调用/错误文字，组件自身按终端宽度折行。
import { Container, Text } from "@earendil-works/pi-tui";
// 宿主可配置工具展开按键提示。
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
// 高亮工具与主题类型来自统一主题模块。
import {
	// 每个工具行自己的最后一次高亮缓存，避免进程级保留所有源代码。
	CodeHighlighter,
	// 从路径扩展名推语言，不读取文件内容猜语言。
	getLanguageFromPath,
	// 直接全段/单行高亮函数，内部不支持语言/失败时有显示回退。
	highlightCode,
	// Theme纯类型，运行主题作为回调参数传入。
	type Theme,
	// 结束同一主题模块的值/类型混合导入。
} from "../../../modes/interactive/theme/theme.ts";
// 显示方法签名与展开/部分结果选项的纯类型。
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
// CR删除、路径链接、tab替换及未知参数str规范都只影响显示，不改实际写入正文。
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "../render-utils.ts";

// 参数仍流式增长时的高亮缓存结构，保存在调用组件上，不是文件写入缓存。
type WriteHighlightCache = {
	// 原路径展示值或非法null，用来判断能否沿用同一缓存。
	rawPath: string | null;
	// 已识别语言。
	lang: string;
	// 上次完整原始content，用startsWith判断本次是否纯追加。
	rawContent: string;
	// CR/tab正规化后的逻辑行数组，便于只更新末行和新增行。
	normalizedLines: string[];
	// 与normalizedLines对应的ANSI高亮行，可在增量更新中原地覆盖。
	highlightedLines: string[];
};
// 调用区专用Text子类，增加缓存/高亮owner；extends继承布局行为，不因此写文件。
class WriteCallRenderComponent extends Text {
	// Line by line highlighting of a call whose content is still streaming.
	// 可选增量缓存，参数完整或无法识别语言时可清空。
	cache?: WriteHighlightCache;
	// A streamed call highlights its first lines on every delta, which stop changing once the file is longer, and a
	// complete call highlights the whole file on every update and expand toggle. Either way the row reuses the last
	// highlighting; it also holds the only copy of a complete call's displayed source.
	// 每个组件独有高亮器；readonly禁止通过类型重赋属性，highlighter内部缓存仍会变化，不是深冻结。
	readonly highlighter = new CodeHighlighter();

	// 无参构造文本组件并初始化类字段，只分配显示状态；例如首个write调用得到空文字、零留白，不高亮或写入正文。
	constructor() {
		// 调用父Text构造，文字空、横纵padding为0，外层工具壳负责留白。
		super("", 0, 0);
	}
}
// 增量更新时，前50逻辑行作为整段重高亮以保留跨行语法；初次/不兼容缓存重建仍会全段高亮，50不是输出截断上限。
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;
// 高亮单逻辑行，输入文字/语言，返回首个着色行或空串，无I/O。例：新增第51行可单独着色，跨前行语法状态不由这个函数追踪。
function highlightSingleLine(line: string, lang: string): string {
	// 调用统一高亮器，它返回字符串行数组。
	const highlighted = highlightCode(line, lang);
	// 只取第一行，缺失时回退空字符串，??不把合法空串当缺省。
	return highlighted[0] ?? "";
}
// 更新增量缓存前缀高亮，输入可变缓存和owner高亮器，无返回值，仅改高亮数组。
// 例：追加到100行后前50行内容不再变，owner可复用该前缀高亮；第51行以后主要靠单行高亮，不保证持续追加状态始终与全段解析完全一致。
function refreshWriteHighlightPrefix(cache: WriteHighlightCache, highlighter: CodeHighlighter): void {
	// 前缀长度取50与当前总逻辑行较小值。
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	// 没有逻辑行无需做高亮。
	if (prefixCount === 0) return;
	// slice复制前缀行并用换行组成多行源串。
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	// owner高亮器按文字/语言/主题/已注册语法数量缓存结果，未变可直接复用只读数组。
	const prefixHighlighted = highlighter.highlight(prefixSource, cache.lang);
	// 逐个回填前缀对应高亮行，for的i只在这个块内有效。
	for (let i = 0; i < prefixCount; i++) {
		// 修改缓存数组该行，不改owner返回的共享数组。
		cache.highlightedLines[i] =
			// 优先使用整段前缀高亮行，缺失则对原逻辑行单独高亮，原行缺失用空串。
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}
// 为某路径/正文重建完整增量缓存，返回缓存或undefined，不读写文件。
// 先识别语言→只为显示去CR/替tab→拆行并全段高亮；例：src/a.ts建TS缓存，未知扩展名不建，正文仍可普通显示。
function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	// 有非空路径才按扩展名查语言。
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	// 没有识别语言就不缓存语法高亮。
	if (!lang) return undefined;
	// 仅显示副本删除CR，原fileContent仍保留。
	const displayContent = normalizeDisplayText(fileContent);
	// 显示副本把每个tab替成3空格，不是按制表位动态对齐。
	const normalized = replaceTabs(displayContent);
	// 构造新缓存，和传入正文没有写文件关系。
	return {
		// 保存路径以检测之后是否换目标。
		rawPath,
		// 保存本次语言。
		lang,
		// 保存原文供后续纯追加判定，不能用去CR/tab后的文字做这个比较。
		rawContent: fileContent,
		// 展示文字按换行拆成逻辑行。
		normalizedLines: normalized.split("\n"),
		// 首次完整高亮整个当前正文，而非只算前50行。
		highlightedLines: highlightCode(normalized, lang),
	};
}
// 更新纯追加流式正文的缓存，输入旧缓存/路径/当前完整content/owner，返回原地更新缓存或重建结果；无文件操作。
// 路径/语言改变或非追加时全量重建；否则只重算旧末行和新增行，再多行重算前50行。例："a"增长为"ab\nc"只处理受影响尾部；不是将delta写到文件。
function updateWriteHighlightCacheIncremental(
	// 旧缓存可不存在。
	cache: WriteHighlightCache | undefined,
	// 当前路径或非法标记。
	rawPath: string | null,
	// 本次完整原始正文，不是直接给delta。
	fileContent: string,
	// 工具行独有的整段高亮缓存器。
	highlighter: CodeHighlighter,
	// 可能因未知语言返回undefined，调用方改走普通显示。
): WriteHighlightCache | undefined {
	// 按当前路径确定语言。
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	// 不支持/无法识别语言时不沿用旧缓存。
	if (!lang) return undefined;
	// 首次尚无缓存，调用全量重建，不进入增量算法。
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	// 语言/原路径变化，或当前正文不以旧原文开头，表示不是同一份纯追加状态。
	if (cache.lang !== lang || cache.rawPath !== rawPath || !fileContent.startsWith(cache.rawContent)) {
		// 不兼容时丢弃旧增量缓存并全量重建。
		return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	}
	// 已确认纯追加且长度相同，文字必然相同，直接返回旧缓存，不重做高亮。
	if (fileContent.length === cache.rawContent.length) return cache;

	// 取超出旧原文长度的新增片段。
	const deltaRaw = fileContent.slice(cache.rawContent.length);
	// 只对新增片段删除CR。
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	// 新增显示文字把tab换成3空格。
	const deltaNormalized = replaceTabs(deltaDisplay);
	// 更新缓存原文快照，后续比较以本次完整原文为准。
	cache.rawContent = fileContent;
	// 若逻辑数组为空，先补末行槽；正常split通常至少有一项，这是既有实现的分支。
	if (cache.normalizedLines.length === 0) {
		// 初始化空源行。
		cache.normalizedLines.push("");
		// 初始化对应空高亮行，保持两个数组索引对齐。
		cache.highlightedLines.push("");
	}

	// 增量可能含多行，按换行切成片段。
	const segments = deltaNormalized.split("\n");
	// 旧数组最后索引，即上一次还可能继续增长的逻辑行。
	const lastIndex = cache.normalizedLines.length - 1;
	// 增量首片段接到旧末行，不另建新行。
	cache.normalizedLines[lastIndex] += segments[0];
	// 重高亮这条被延长的末行，单行解析不携带前面行语法状态。
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	// 从第二片段起都是新增逻辑行。
	for (let i = 1; i < segments.length; i++) {
		// 逐条追加规范化源行。
		cache.normalizedLines.push(segments[i]);
		// 对每条新行单独高亮并追加，与源数组对齐。
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	// 再用整段前缀修正前50行的跨行着色；owner可缓存没有变化的前缀。
	refreshWriteHighlightPrefix(cache, highlighter);
	// 返回被原地更新的同一缓存对象。
	return cache;
}
// 去掉末尾严格空串行，接只读字符串数组、返回slice新数组；不修改owner共享高亮结果。例：["a",""]变["a"]，带空格/ANSI色码的行不在此视作空串。
function trimTrailingEmptyLines(lines: readonly string[]): string[] {
	// 从数组末端开始找保留边界。
	let end = lines.length;
	// 末项真为空串且还有项时继续去除。
	while (end > 0 && lines[end - 1] === "") {
		// 边界前移一行。
		end--;
	}
	// 返回保留部分的新数组，不就地pop输入。
	return lines.slice(0, end);
}
// 格式化write调用预览，输入参数/显示选项/主题/增量缓存/owner/cwd，返回ANSI文字，无实际写入。
// 路径标题后显示内容，折叠前10逻辑行，展开显示全部当前正文；例：15行内容提示余5行/共15行，content为错误类型显示提示，空串不新增正文。
function formatWriteCall(
	// 可缺参数/兼容file_path别名，content是待写入全文的展示来源。
	args: { path?: string; file_path?: string; content?: string } | undefined,
	// expanded决定行预算，isPartial在该函数中未直接分支。
	options: ToolRenderResultOptions,
	// 当前主题，用来套标题/普通正文/错误颜色。
	theme: Theme,
	// 可用增量高亮缓存，参数完整时通常undefined。
	cache: WriteHighlightCache | undefined,
	// 本工具行owner高亮器，用于完整内容重绘复用。
	highlighter: CodeHighlighter,
	// 路径链接解析基准cwd，不用于实际写文件。
	cwd: string,
	// 返回纯展示字符串。
): string {
	// 旧file_path非null/undefined优先；??保留空字符串而不回退path，经str把错误类型标null。
	const rawPath = str(args?.file_path ?? args?.path);
	// content缺省/null归空串，其他非字符串归非法null。
	const fileContent = str(args?.content);
	// 渲染路径/链接/非法占位，不检查文件存在。
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	// 先生成工具标题，let允许后面追加正文。
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	// 只有错误类型content会是null，不与合法空文件混淆。
	if (fileContent === null) {
		// 在标题下空一行展示错误提示，未抛执行异常，也不修改模型参数。
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
		// 非空合法正文才展示；空字符串仍可能是合法写空文件意图，但UI不铺正文。
	} else if (fileContent) {
		// 按路径扩展名选语言。
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		// 是否有语言决定用着色代码行还是普通文字行。
		const renderedLines = lang
			? // 优先增量缓存行，否则对规范化全文用owner高亮；owner缓存文字/语言/主题/语法集合未变时避免重复解析。
				(cache?.highlightedLines ?? highlighter.highlight(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: // 无语言仅去CR再拆行，tab在后面显示时转换。
				normalizeDisplayText(fileContent).split("\n");
		// 去尾部严格空串，返回新数组，不改共享高亮缓存。
		const lines = trimTrailingEmptyLines(renderedLines);
		// 用于提示的总逻辑行数，是去尾空行后的显示数量。
		const totalLines = lines.length;
		// 展开全部当前行，折叠最多10逻辑行，不计终端宽度自动折行。
		const maxLines = options.expanded ? lines.length : 10;
		// 取显示片段，不修改缓存数组。
		const displayLines = lines.slice(0, maxLines);
		// 计算预算外行数，只有正数才显示提示。
		const remaining = lines.length - maxLines;
		// 高亮行保留ANSI，普通行tab转空格后套正文色；标题与正文间两次换行。
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		// 确有折叠行才补提示。
		if (remaining > 0) {
			// 提示剩余/总逻辑行数与当前展开按键，不恢复不存在的正文。
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	// 返回完整调用标题和预览文字，实际写入仍用原参数。
	return text;
}
// 只显示write的错误结果，输入带可选isError的内容/主题，返回ANSI或undefined；成功的普通确认句省略以免和调用正文重复。例：权限错误显示一行错误信息，不重新写文件。
function formatWriteResult(
	// 宽松内容块及错误标志；外层从context补isError，避免只靠AgentToolResult没有该字段。
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	// 当前主题。
	theme: Theme,
	// undefined表示结果槽无额外文字。
): string | undefined {
	// 非错误（含未给标志）直接省略确认消息。
	if (!result.isError) {
		// 返回无额外结果正文，不等于没有执行成功记录。
		return undefined;
	}
	// 从错误结果收集文字。
	const output = result.content
		// 只取text块，图片不变成错误文字。
		.filter((c) => c.type === "text")
		// 缺文字或空文字用空串。
		.map((c) => c.text || "")
		// 多文字块用换行合并，此路径不额外调用getTextOutput清理。
		.join("\n");
	// 没有错误文字就不产生空错误行。
	if (!output) {
		// 返回无正文标记。
		return undefined;
	}
	// 错误文字着error色，前加一换行与调用预览区分。
	return `\n${theme.fg("error", output)}`;
}

// 导出两项显示回调，Pick只挑工具定义的显示槽，参数/详情any为展示兼容并不验证数据。
export const writeRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	// 调用显示回调，输入参数/主题/context，返回专用Text并更新本行高亮状态。
	// 参数未完整时维护追加缓存，完整时清该缓存并用owner复用全文高亮；例：宿主可把多次流式content参数更新合并到一帧绘制，本回调只更新显示，不创建文件。
	renderCall(args, theme, context) {
		// 断言兼容显示参数形状，不把流式输入当schema已验证。
		const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
		// 取当前路径，file_path优先，并区分非法null。
		const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
		// 规范当前content类型，缺省为空串。
		const fileContent = str(renderArgs?.content);
		// 准备复用或新建本调用槽的专用组件。
		const component =
			// 优先复用lastComponent断言类型，首次才new并创建owner缓存；as不执行类校验。
			(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
		// 根据参数完成状态更新/清空增量缓存。
		component.cache =
			// content类型合法且参数尚未完整才尝试增量缓存；空字符串也满足非null。
			fileContent !== null && !context.argsComplete
				? // 按当前路径/正文与已有owner更新，可因无法识别语言返回undefined。
					updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent, component.highlighter)
				: // 参数完整或content非法就清增量缓存，不清owner最后一次高亮。
					undefined;
		// 把下面格式化结果写入Text。
		component.setText(
			// 调用预览格式器，不执行write工具。
			formatWriteCall(
				// 原展示参数。
				renderArgs,
				// 用context构造展开/部分选项；当前格式器只用expanded。
				{ expanded: context.expanded, isPartial: context.isPartial },
				// 当前主题。
				theme,
				// 传刚更新的可选增量行缓存。
				component.cache,
				// 传本行owner高亮器，完整正文重绘可复用。
				component.highlighter,
				// 传cwd用于路径链接。
				context.cwd,
			),
		);
		// 返回组件供宿主按终端宽度折行。
		return component;
	},
	// 结果显示回调接已有结果/未使用options/主题/context，成功返回空容器，错误返回文字组件；显示状态改变不写文件。例：权限失败用context.isError显示错误，而不是猜content句子。
	renderResult(result, _options, theme, context) {
		// 浅复制结果外壳并以context.isError覆盖错误标志，再生成可选错误文字。
		const output = formatWriteResult({ ...result, isError: context.isError }, theme);
		// 没有额外文字（通常成功或空错误）则用空容器。
		if (!output) {
			// 断言上次结果槽为Container并复用，首次才new；断言不是实际类型检测。
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			// 清旧子组件，不删除原工具结果。
			component.clear();
			// 返回空结果显示，调用预览仍在另一个槽。
			return component;
		}
		// 有错误文字时断言上次组件为Text或新建；若上一分支实际返回Container，断言不会补setText，下面调用可能抛错，宿主ToolExecutionComponent会捕获后用通用结果显示回退。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 把错误文字写到Text；通常同分支重复渲染可复用缓存，非法组件方法错误按宿主规则处理。
		text.setText(output);
		// 交回结果槽组件。
		return text;
	},
};
