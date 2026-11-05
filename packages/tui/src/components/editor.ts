// 多行输入组件：保存文字/光标，处理键鼠、历史、删除环、撤销、大粘贴与补全；CustomEditor再叠加应用快捷键，TUI负责最终输出。
// 字符串位置一律以UTF-16码元计数，终端宽度用visibleWidth另算；此文件的visualCol是折行片段内的码元偏移，不能直接等同于屏幕列。
// type导入只约束提供者/建议的编译期形状，不加载补全实现或保证异步结果当前仍有效。
import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.ts";
// 每次输入读取全局键位管理器，动作名可配置到不同物理按键。
import { getKeybindings } from "../keybindings.ts";
// 显式文本协议解码与按键身份匹配；后者的Kitty解析可更新共享事件类型，不应全部称作纯函数。
import { decodePrintableKey, matchesKey } from "../keys.ts";
// 组件自己的成段删文环，不是系统剪贴板。
import { KillRing } from "../kill-ring.ts";
// 导入TUI契约及光标标记工具，type项会被擦除，其他项是运行时值。
import {
	// 组件需要render/invalidate等方法，接口不自动把对象挂到UI。
	type Component,
	// 硬件光标定位用零宽标记，宿主提取后从文字中移除。
	CURSOR_MARKER,
	// 焦点契约只要求focused字段。
	type Focusable,
	// 给模拟光标文字包内部标记，不直接写终端。
	renderFakeCursor,
	// 只在类型上依赖宿主TUI，构造参数提供真实实例。
	type TUI,
	// 鼠标坐标已由宿主转换为组件局部终端格坐标。
	type TuiMouseEvent,
	// 鼠标返回值描述处理/焦点/渲染意图，由宿主兑现。
	type TuiMouseEventResult,
} from "../tui.ts";
// 泛型快照栈在push时structuredClone；这里决定何时记录，栈本身不合并打字动作。
import { UndoStack } from "../undo-stack.ts";
// 共享Unicode边界、分段和终端列工具，避免把码元长度当字形宽度。
import {
	// 补全token可从正文开头、空白或CJK标点之后开始。
	autocompleteBoundaryRegex,
	// 未加引号的补全遇空白/CJK标点结束。
	autocompleteSeparatorRegex,
	// 含中日韩文字的字素可以成为候选折行边界，不是严格排版禁则。
	cjkBreakRegex,
	// 取共享字素分段器，组合字符尽量作为完整编辑单位。
	getGraphemeSegmenter,
	// 取共享词分段器供按词移动，不是简单按空格split。
	getWordSegmenter,
	// 检查字符串是否含空白；调用方通常传单字素，某些路径可传整段输入。
	isWhitespaceChar,
	// 按终端列切显示文本，边框超窄时使用。
	sliceByColumn,
	// 按本项目规则估算终端显示列数，不探测当前字体。
	visibleWidth,
} from "../utils.ts";
// 按词移动工具只返回新码元下标；跨逻辑行和删文由Editor完成。
import { findWordBackward, findWordForward } from "../word-navigation.ts";
// 候选菜单实现与其布局/主题类型；菜单只选择条目，应用文字由本类回调完成。
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.ts";

// 模块加载时保存共享字素分段器引用，不为每次按键重新new。
const graphemeSegmenter = getGraphemeSegmenter();
// 另存词分段器，word/grapheme两种粒度用途不同。
const wordSegmenter = getWordSegmenter();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
// 全局扫描粘贴标记，捕获数字ID及可选行数/字符数说明；g让matchAll遍历全部命中。
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
// 非全局完整形状匹配供单段检查；不查询注册表，也不是内容来源证明。
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/** Check if a segment is a paste marker (i.e. was merged by segmentWithMarkers). */
// 判断给定段是否像完整粘贴标记，返回布尔值无修改；例：[paste #1]可匹配，但是否有对应内容另由validIds控制合并。
function isPasteMarker(segment: string): boolean {
	// 先用长度做便宜筛选，再匹配固定语法；没有在此验证ID已登记。
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste markers into single atomic segments.  This makes cursor
 * movement, deletion, word-wrap, etc. treat paste markers as single units.
 *
 * Only markers whose numeric ID exists in `validIds` are merged.
 */
// 在词/字素分段结果里把已登记粘贴标记合成一个单位，返回可迭代段，不改原文/集合；例：光标一步越过整段[paste #1]。
// 先查所有有效标记区间，再遍历基础分段合并；同形且ID已存在的手输文字也可能被认作标记，不依据对象身份辨来源。
function segmentWithMarkers(
	// 待分段原文，各index仍相对于这个字符串。
	text: string,
	// 调用方选择word或grapheme的Intl分段器。
	baseSegmenter: Intl.Segmenter,
	// 允许合并的数字ID集合，不含粘贴正文。
	validIds: Set<number>,
	// Iterable允许返回原Segments或新数组；类型不校验自定义段是否覆盖每个字符。
): Iterable<Intl.SegmentData> {
	// Fast path: no paste markers in the text or no valid IDs.
	// 无已登记ID或连标记开头都没有，就走普通分段。
	if (validIds.size === 0 || !text.includes("[paste #")) {
		// 返回原分段迭代对象，不额外展开数组。
		return baseSegmenter.segment(text);
	}

	// Find all marker spans with valid IDs.
	// 记录匹配区间的起始/排除式结束码元下标。
	const markers: Array<{ start: number; end: number }> = [];
	// matchAll遍历全部标记形状；基础正则带g，匹配顺序按源位置递增。
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		// 首捕获组按十进制转数字，!是非空断言，不生成检查。
		const id = Number.parseInt(m[1]!, 10);
		// ID没有登记就不合并，仍留给基础分段。
		if (!validIds.has(id)) continue;
		// 保存有效标记的半开区间，长度是完整标记串长度。
		markers.push({ start: m.index, end: m.index + m[0].length });
	}
	// 所有形似标记都无效时无需建立合并数组。
	if (markers.length === 0) {
		// 回退基础分段。
		return baseSegmenter.segment(text);
	}

	// Build merged segment list.
	// 取基础分段的可迭代对象，尚未在本函数为每段建立新对象。
	const baseSegments = baseSegmenter.segment(text);
	// 本路径用数组收集最终段，元素遵循Intl.SegmentData形状。
	const result: Intl.SegmentData[] = [];
	// 当前要考察的标记区间下标。
	let markerIdx = 0;

	// 依源位置顺序遍历基础词段/字素段。
	for (const seg of baseSegments) {
		// Skip past markers that are entirely before this segment.
		// 当前标记已完全落在本段之前时，不再让它参与判断。
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			// 推进到下一标记；不会回头扫描已消费区间。
			markerIdx++;
		}

		// 尚有标记就取该区间，否则用null表示没有。
		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		// 只有基础段起点落在标记半开区间里才进入合并路径。
		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			// This segment falls inside a marker.
			// If this is the first segment of the marker, emit a merged segment.
			// 仅在标记起点发出一次合并段；其余内部段不再输出。
			if (seg.index === marker.start) {
				// 从原文截完整标记，保留其原始拼写/说明。
				const markerText = text.slice(marker.start, marker.end);
				// 手工构造一个分段对象，替代标记内部多个基础段。
				result.push({
					// segment装完整标记文字。
					segment: markerText,
					// index保留其在text中的码元起点。
					index: marker.start,
					// input仍是整段原text，未复制正文。
					input: text,
				});
			}
			// Otherwise skip (already merged into the first segment).
			// 不落在有效标记里的基础段原样保留。
		} else {
			// 保存原段对象引用，其isWordLike等元数据仍在。
			result.push(seg);
		}
	}

	// 返回合并数组；标记合成段没有额外isWordLike字段，词导航通过原子判定识别它。
	return result;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
// 一个显示折行片段与原逻辑行位置的类型；interface仅编译期存在。
export interface TextChunk {
	// 片段文字，不包括TUI边框/补白/光标标记。
	text: string;
	// 片段在原逻辑行中的起始码元下标。
	startIndex: number;
	// 片段排除式结束码元下标，slice(startIndex,endIndex)可重建它。
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
// 把一条逻辑行按终端列预算分成TextChunk数组，保留原码元范围，不修改输入；先整行快路，再按空白/CJK边界回退或强拆长词。
// 例：hello world在窄宽度可在空格后折行，空白仍属于原文本。preSegmented可让粘贴标记逻辑原子化、显示时再拆；不验证预分段一致性。
// 注意：宽于预算的普通单个字素也会递归同一输入，例如2列汉字配maxWidth=1可能递归不终止，不能把此算法描述为对任意极窄输入都安全。
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	// 空文本或非正预算返回一条空片段，不抛宽度参数错误。
	if (!line || maxWidth <= 0) {
		// 空片段的原范围固定为0..0。
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	// 先测整条逻辑行的终端列数。
	const lineWidth = visibleWidth(line);
	// 整行放得下就不需要分词/回退。
	if (lineWidth <= maxWidth) {
		// 返回一片完整原文，endIndex用码元长度而不是列宽。
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	// 准备收集按顺序切出的片段。
	const chunks: TextChunk[] = [];
	// 优先沿用调用方预分段；缺省才把共享字素分段展开为数组，??不把空数组当缺失。
	const segments = preSegmented ?? [...graphemeSegmenter.segment(line)];

	// 当前待输出片段的累计显示列数。
	let currentWidth = 0;
	// 当前待输出片段在原文里的起点。
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	// -1表示还没有可回退的软折行位置。
	let wrapOppIndex = -1;
	// 记录软折行处之前累计宽度，回退时从总宽扣掉它。
	let wrapOppWidth = 0;

	// 逐段前进，数组下标不是原文位置。
	for (let i = 0; i < segments.length; i++) {
		// 取当前段，!只让TS认为它存在。
		const seg = segments[i]!;
		// 段文字可能是一个字素，也可能是合并后的整个粘贴标记。
		const grapheme = seg.segment;
		// 测当前段列宽，不能用segment.length代替。
		const gWidth = visibleWidth(grapheme);
		// 取该段在原逻辑行中的UTF-16起点。
		const charIndex = seg.index;
		// 粘贴标记即使包含空格也不当空白段，普通段按共享规则判定。
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		// 把本段加进去之前先看是否超过预算。
		if (currentWidth + gWidth > maxWidth) {
			// 有软边界且回退后“保留尾段+当前段”能放下，才采用该边界。
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				// 输出边界之前的原文片段，起止都用原串下标。
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				// 新片段从边界开始，边界后的文字并未丢弃。
				chunkStart = wrapOppIndex;
				// 扣掉已输出前半段列宽，剩下的尾段继续与当前段拼。
				currentWidth -= wrapOppWidth;
				// 没有可用软边界但当前片段已有文字，就在当前段前强制切开。
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				// 输出当前段之前的内容，保留长词原文不加连字符。
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				// 下一片段从本段开始。
				chunkStart = charIndex;
				// 新片段累计宽度清零，当前段稍后再计入。
				currentWidth = 0;
			}
			// 一次溢出处理后旧软边界失效，等待重新记录。
			wrapOppIndex = -1;
		}

		// 原子段自身比整个预算还宽时，需要专门处理显示拆分。
		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			// 不传preSegmented递归，通常把整条粘贴标记拆回普通字素；若本来就是过宽单字素，这里不会取得进展，见函数前边界说明。
			const subChunks = wordWrapLine(grapheme, maxWidth);
			// 先输出子拆分除最后一片之外的所有片段。
			for (let j = 0; j < subChunks.length - 1; j++) {
				// 取当前子片段，!依赖循环范围。
				const sc = subChunks[j]!;
				// 子片段下标加当前段原起点，转换回整逻辑行坐标。
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			// 最后子片段暂不输出，后续原文还可能接在它后面。
			const last = subChunks[subChunks.length - 1]!;
			// 当前片段起点改成最后子片段在原行的起点。
			chunkStart = charIndex + last.startIndex;
			// 累计宽度从最后子片段重新计算。
			currentWidth = visibleWidth(last.text);
			// 拆段后清软边界记录。
			wrapOppIndex = -1;
			// 当前原子段已处理完，直接看下一段，避免再次累加整段宽度。
			continue;
		}

		// Advance.
		// 未走专门拆分时把当前段宽度加入累计。
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace
		// (multiple spaces join; the break point is after the last space),
		// or at a boundary where either side is CJK (CJK allows breaking
		// between any adjacent characters).
		// 预读下一段，末尾可能undefined。
		const next = segments[i + 1];
		// 本段为空白、下一段是正文/原子标记时，允许在整串空白之后折行。
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			// 边界使用下一段起点，空白仍留在前一片段尾部。
			wrapOppIndex = next.index;
			// 保存该边界前的累计列宽。
			wrapOppWidth = currentWidth;
			// 两边都不是空白时，再考虑CJK相邻分段边界。
		} else if (!isWs && next && !isWhitespaceChar(next.segment)) {
			// 当前段必须不是粘贴标记，且含CJK换行类字符。
			const isCjk = !isPasteMarker(grapheme) && cjkBreakRegex.test(grapheme);
			// 下一段用同样判据，避免标记内部空白成为语义边界。
			const nextIsCjk = !isPasteMarker(next.segment) && cjkBreakRegex.test(next.segment);
			// 任一侧为CJK就提供一处软边界，不是完整中文行首禁则。
			if (isCjk || nextIsCjk) {
				// 把下一段起点保存为最新可回退位置。
				wrapOppIndex = next.index;
				// 记住本处累计宽度，后续溢出才用。
				wrapOppWidth = currentWidth;
			}
		}
	}

	// Push final chunk.
	// 循环结束后把最后起点到行末输出，保留尾空白及原长度。
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	// 返回所有片段，不给它们加颜色/光标或写终端。
	return chunks;
}

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.
// Editor内存状态，不含协议字段、不解析Kitty CSI-u；输入报文在handleInput调用decodePrintableKey处处理。
interface EditorState {
	// 按LF拆开的逻辑行，通常至少一行空串。
	lines: string[];
	// 零起始逻辑行号，不是折行后的可见行号。
	cursorLine: number;
	// 行内UTF-16下标，不是屏幕列。
	cursorCol: number;
}

/** Undo snapshot: editor text state plus the paste registry. */
// 一次撤销的文本/光标及粘贴注册表快照；不包含历史列表、删除环或补全任务。
interface EditorSnapshot {
	// 要恢复的逻辑文字与光标状态。
	state: EditorState;
	// ID到真实大粘贴正文的映射，避免撤销只恢复标记却丢正文。
	pastes: Map<number, string>;
	// 后续分配/删除标记时使用的计数。
	pasteCounter: number;
}

// render准备的一条折行结果，不等同于完整终端输出行。
interface LayoutLine {
	// 片段显示文字。
	text: string;
	// 光标是否归属于这片段。
	hasCursor: boolean;
	// 可选片段内部码元位置，仅hasCursor时需要。
	cursorPos?: number;
}

// 编辑器主题的编译期契约，不自动检查回调是否保持文字宽度。
export interface EditorTheme {
	// 边框文字着色回调，构造后公开borderColor可另换。
	borderColor: (str: string) => string;
	// 补全菜单自己的主题回调集合。
	selectList: SelectListTheme;
}

// 可选构造配置；?表示可不传字段，实际数值规范在构造/设置方法完成。
export interface EditorOptions {
	// 请求左右各留的空格列数，实际渲染会按当前宽度再夹住。
	paddingX?: number;
	// 候选可见项数，规范到3..20，不包含菜单的额外页码行。
	autocompleteMaxVisible?: number;
}

// 斜杠命令菜单主文字列的偏好范围，不限制命令名真实长度。
const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	// 主列最小目标12列。
	minPrimaryColumnWidth: 12,
	// 主列最大目标32列，SelectList会结合实际可用宽度截断。
	maxPrimaryColumnWidth: 32,
};

// 自然符号补全延迟20毫秒合并连打，不是请求超时或最小网络间隔。
const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
// 默认@与#触发符；提供者追加有效字符，不能通过空数组移除这两个默认值。
const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];
// Unquoted completions end at whitespace or CJK punctuation; quoted paths may contain either.
// 模式逐字符排除空白/CJK标点，不带s所以点也不跨LF；只是构造正则，不查询候选。
const unquotedAutocompleteSuffixRegex = new RegExp(`(?:(?!${autocompleteSeparatorRegex.source}).)*`, "u");
// Trigger tokens may be wrapped in prose, e.g. "(@src/foo" or "`@src/foo".
// 边界后允许若干包装开符号，例：空格后(@src；不是任意嵌套语法解析器。
const autocompleteTokenStartSource = `${autocompleteBoundaryRegex.source}[([{<\`]*`;

// 转义将被放进正则字符组的文字，返回新串，无状态修改；例：自定义触发符-按字面匹配，不表示字符范围。
function escapeCharacterClass(value: string): string {
	// 用全局替换给正则元字符加反斜杠，$&代表本次匹配原文。
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

// 构造自然触发的末尾模式，输入触发字符数组、返回RegExp，不发请求；例：空格后@src或@开启引号路径可命中。
function buildTriggerPattern(triggerCharacters: string[]): RegExp {
	// 创建一个无g的正则，反复test不推进lastIndex。
	return new RegExp(
		// 拼“合法起点+引用@分支或触发字符组+未引用后缀”，最后锚到当前文本尾；map转义每个触发符，再join组成字符组正文。
		`${autocompleteTokenStartSource}(?:@"[^"]*|[${triggerCharacters.map(escapeCharacterClass).join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		// u启用Unicode正则语义，不启用逐行m。
		"u",
	);
}

// 构造防抖上下文模式，返回正则无I/O；@双引号可包含分隔字符，其他触发符使用未引用后缀，例：@my前缀自然连打合并。
function buildDebouncePattern(triggerCharacters: string[]): RegExp {
	// 将@单独留给专门分支，其他触发字符分别转义后组成字符组。
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	// 创建防抖判定用正则，不在这里启动计时器。
	return new RegExp(
		// 模板连接边界/包装、@引用或未引用分支、其他符号分支以及末尾锚点，运行时仅做文本匹配。
		`${autocompleteTokenStartSource}(?:@(?:"[^"]*|${unquotedAutocompleteSuffixRegex.source})|[${escapedWithoutAt.join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		// u保持Unicode语义，未开启m或s。
		"u",
	);
}

// 生成含上/下隐藏行数的边框字符串，返回文本不写终端；先居中，较窄时靠左，再截前缀加省略号，例：↑ 9 more提示上方9折行。
function createScrollBorder(direction: "↑" | "↓", hiddenLineCount: number, width: number): string {
	// 负宽先夹到0，未统一验证NaN/整数等任意调用值。
	const availableWidth = Math.max(0, width);
	// 构造左右含空格的完整方向/计数标签。
	const label = ` ${direction} ${hiddenLineCount} more `;
	// 按终端显示列数测标签，箭头不按字符串字节数算。
	const labelWidth = visibleWidth(label);
	// 标签两边至少还能各有一横线才采用居中布局。
	if (labelWidth + 2 <= availableWidth) {
		// 可余空间一半向下取整放左边。
		const leftWidth = Math.floor((availableWidth - labelWidth) / 2);
		// 剩余横线放右边，三部分组成给定宽度。
		return "─".repeat(leftWidth) + label + "─".repeat(availableWidth - leftWidth - labelWidth);
	}

	// 放不下居中时改用三横线开头的固定提示形式。
	const indicator = `─── ${direction} ${hiddenLineCount} more `;
	// 计算完整靠左提示后还能填多少列。
	const remaining = availableWidth - visibleWidth(indicator);
	// 够放就补右横线并立即返回。
	if (remaining >= 0) return indicator + "─".repeat(remaining);

	// 极窄时省略号最多也只占availableWidth个ASCII字符。
	const ellipsis = "...".slice(0, availableWidth);
	// 先给省略号留位置，其余预算给提示前段。
	const indicatorWidth = availableWidth - visibleWidth(ellipsis);
	// 按列严格切前段再加省略号，避免切出半个宽字符，主题着色在调用方之后进行。
	return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}

// 实现多行编辑组件与焦点契约；new只保存状态，TUI调用handleInput/render后才有编辑/显示效果，不在此调用模型或系统剪贴板。
export class Editor implements Component, Focusable {
	// private只限制TS外部访问；初始编辑状态从一条空逻辑行开始。
	private state: EditorState = {
		// 至少一条空行，方便行内编辑逻辑。
		lines: [""],
		// 光标初始在第0逻辑行。
		cursorLine: 0,
		// 初始码元列0。
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes */
	// 宿主切焦点时修改；render即便未聚焦仍生成模拟光标，只在聚焦时加硬件定位标记。
	focused: boolean = false;

	/** The open autocomplete menu receives fullscreen viewport keys, such as PageUp/PageDown. */
	// 访问器无参数、返回菜单是否打开，不改状态；例：全屏视口把PageDown优先交给当前编辑菜单，而不是滚动消息记录。
	get capturesViewportInput(): boolean {
		// 只看菜单模式是否非null，不把尚在等待中的请求当成已打开UI。
		return this.autocompleteState !== null;
	}

	// protected让CustomEditor子类可访问宿主，类型本身不启动终端。
	protected tui: TUI;
	// 保存主题对象引用，渲染才调用回调。
	private theme: EditorTheme;
	// 左右请求边距初值0，构造选项可覆盖。
	private paddingX: number = 0;

	// Store last render geometry for cursor navigation and mouse hit-testing.
	// 最近渲染的折行预算，初始80；尚未render时移动光标也用这个值。
	private lastWidth: number = 80;
	// 最近一次实际显示的内容折行数，供鼠标区间判断。
	private renderedVisibleLineCount = 1;
	// 最近绘出的补全菜单行数，包含可能的页码行。
	private renderedAutocompleteHeight = 0;

	// Vertical scrolling support
	// 当前内容视口的首个折行下标，不是逻辑行号。
	private scrollOffset: number = 0;

	// Border color (can be changed dynamically)
	// 公开可改的边框回调，与theme.borderColor初始同引用，子类可自定义边框。
	public borderColor: (str: string) => string;

	// Autocomplete support
	// 可选提供者，不存在时Tab/自动触发不会执行查询。
	private autocompleteProvider?: AutocompleteProvider;
	// 复制默认触发数组，避免每个Editor共享同一可变数组。
	private autocompleteTriggerCharacters = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
	// 按当前触发符建立自然补全文本模式。
	private autocompleteTriggerPattern = buildTriggerPattern(this.autocompleteTriggerCharacters);
	// 另建防抖判定模式，更新提供者时同步重建。
	private autocompleteDebouncePattern = buildDebouncePattern(this.autocompleteTriggerCharacters);
	// 实际菜单实例，尚未打开时可缺省。
	private autocompleteList?: SelectList;
	// 带字面量联合的菜单状态：自然/强制文件模式，null表示UI关闭，非请求生命周期枚举。
	private autocompleteState: "regular" | "force" | null = null;
	// 菜单对应的原始替换前缀，选择时交提供者应用。
	private autocompletePrefix: string = "";
	// 候选最多可见项数，构造/设置时夹范围。
	private autocompleteMaxVisible: number = 5;
	// 当前运行请求的取消控制器；abort只能通知合作的提供者，不强制结束任意Promise。
	private autocompleteAbort?: AbortController;
	// 可选防抖定时器；ReturnType<typeof setTimeout>在类型层复用环境返回类型。
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	// 串行请求链从已完成Promise起步，后续请求先等此前任务，未提供拒绝恢复catch。
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	// 启动代号淘汰尚未执行的旧排队/防抖请求；取消也递增它。
	private autocompleteStartToken: number = 0;
	// 真正开始查询才递增的请求编号，与文本/光标快照一起判定结果是否过期。
	private autocompleteRequestId: number = 0;

	// Paste tracking for large pastes
	// 大粘贴正文保存在实例内Map，不写会话磁盘；文字里显示短标记。
	private pastes: Map<number, string> = new Map();
	// 分配新标记的数字计数，特定Backspace路径删除后会减一并重编号。
	private pasteCounter: number = 0;

	// Bracketed paste mode buffering
	// 收到括号粘贴开始后暂存输入，直到找到结束标记。
	private pasteBuffer: string = "";
	// 是否处于跨handleInput调用的粘贴缓冲状态，不是系统剪贴板状态。
	private isInPaste: boolean = false;

	// Prompt history for up/down navigation
	// 内存提示历史，最新放首部，调用者显式addToHistory，不在submitValue里自动记录。
	private history: string[] = [];
	// -1表示草稿模式，0最新历史，正数越大越旧。
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	// 首次进入历史前深复制的草稿文字/光标，不含独立粘贴注册表快照。
	private historyDraft: EditorState | null = null;

	// Kill ring for Emacs-style kill/yank operations
	// 每个Editor独立删除环，保存成段删除的文本，不随提交自动clear。
	private killRing = new KillRing();
	// 最近动作决定删文累积、yank轮换和打字撤销合并，null打断这些连续动作。
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Character jump mode
	// 等待下一个可打印输入作为搜索目标的方向；不是持久Vi模式。
	private jumpMode: "forward" | "backward" | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	// 垂直移动穿过短片段时暂记偏好码元偏移；名称Visual不表示经过visibleWidth转换的终端列。
	private preferredVisualCol: number | null = null;

	// When the cursor is snapped to the start of an atomic segment, e.g. a
	// paste marker, cursorCol no longer reflects where the cursor would have
	// landed. This field stores the pre-snap cursorCol so that the next
	// vertical move can resolve it to a visual column on whatever VL it belongs
	// to.
	// 记录吸附到原子段开头之前的码元位置，以便下次垂直移动/resize后恢复相对偏移。
	private snappedFromCursorCol: number | null = null;

	// Undo support
	// 泛型参数规定快照结构，push内部深复制，undo恢复弹出的独立对象；没有redo。
	private undoStack = new UndoStack<EditorSnapshot>();

	// 提交回调接收展开大粘贴并trim后的文字；本类不会因回调存在自动发送模型请求。
	public onSubmit?: (text: string) => void;
	// 修改回调接收当前存储文字（可能仍含粘贴标记），并非总收到expandedText。
	public onChange?: (text: string) => void;
	// 提交开关在特定Enter判断里使用，不表示禁止所有编辑或禁止菜单应用候选。
	public disableSubmit: boolean = false;

	// 构造保存TUI/主题并规范边距与菜单项数，无I/O/渲染；例：paddingX=2.8会向下取整为2，候选数100夹为20。
	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		// 保存宿主原引用，之后仅请求它安排重画。
		this.tui = tui;
		// 保存主题原引用，不复制回调。
		this.theme = theme;
		// 公开边框样式初始取主题函数。
		this.borderColor = theme.borderColor;
		// 未传边距才回退0，??保留显式0。
		const paddingX = options.paddingX ?? 0;
		// 有限值向下取整并至少0，非有限回退0；number类型本身不保证有限整数。
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		// 候选数缺省5，先保留原数供规范。
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		// 有限值取整后夹3..20，非有限回退5，不重新构造已打开菜单。
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	// 取当前注册粘贴ID集合，返回新Set无状态修改；例：分段只把Map已有ID对应标记合并，不返回正文。
	private validPasteIds(): Set<number> {
		// Map.keys迭代器构成新集合，每次调用都会重新分配。
		return new Set(this.pastes.keys());
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	// 按word/grapheme粒度分段并合并有效标记，返回Iterable不修改text；例：删词与左右移动共用标记原子性但基础粒度不同。
	private segment(text: string, mode: "word" | "grapheme"): Iterable<Intl.SegmentData> {
		// 选择共享分段器，实时复制有效ID，再交前面的合并函数；不会在此展开真实粘贴正文。
		return segmentWithMarkers(text, mode === "word" ? wordSegmenter : graphemeSegmenter, this.validPasteIds());
	}

	// 读取配置横边距，返回数字无副作用；例：渲染宽度很窄时实际边距可能小于这个配置值。
	getPaddingX(): number {
		// 返回请求边距，而非最近render夹取后的数值。
		return this.paddingX;
	}

	// 设置横边距，规范后不同才修改并请求重画，返回void；例：负数归0，不重建文本/光标或主动调用render。
	setPaddingX(padding: number): void {
		// 有限值取整且至少0，否则回退0。
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		// 规范后没有变化就不安排重画。
		if (this.paddingX !== newPadding) {
			// 保存新的请求边距。
			this.paddingX = newPadding;
			// 通知宿主异步安排render，本行不直接写终端。
			this.tui.requestRender();
		}
	}

	// 读取候选可见项数配置，返回number无修改；例：之后创建的SelectList使用该值。
	getAutocompleteMaxVisible(): number {
		// 不直接查询已打开菜单的内部maxVisible。
		return this.autocompleteMaxVisible;
	}

	// 设置候选数并请求重画，返回void；例：2规范为3。当前菜单实例仍保留其构造值，下次重建菜单才采用新值。
	setAutocompleteMaxVisible(maxVisible: number): void {
		// 有限数取整夹3..20，非有限值回退5。
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		// 新旧配置不同才更新。
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			// 保存供后续createAutocompleteList使用的项数。
			this.autocompleteMaxVisible = newMaxVisible;
			// 请求宿主重画，不在这里替换现有SelectList。
			this.tui.requestRender();
		}
	}

	// 更换补全提供者并关闭旧请求/UI，返回void；例：新提供者增加$触发符，旧自定义符号不会一直保留，默认@/#仍存在。
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		// 先取消旧等待并清掉菜单，避免继续应用旧提供者的候选。
		this.cancelAutocomplete();
		// 保存新对象原引用，类型不保证它会响应取消或永不抛错。
		this.autocompleteProvider = provider;
		// 缺triggerCharacters按[]，统一与默认字符合并/筛选并重建正则。
		this.setAutocompleteTriggerCharacters(provider.triggerCharacters ?? []);
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	// 显式加入历史，trim后去空/连续同文，最新在前且最多100条，返回void；例：连续提交同一句只保留一条，不持久化或立即展示。
	addToHistory(text: string): void {
		// 首尾空白规范掉，历史不是输入原串的逐字备份。
		const trimmed = text.trim();
		// 全空白不入历史。
		if (!trimmed) return;
		// Don't add consecutive duplicates
		// 仅和最新一条比较，不去掉中间隔过其他提示的重复文本。
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		// 插入数组开头，使下标0总是最新。
		this.history.unshift(trimmed);
		// Limit history size
		// 超过100条时需要淘汰最旧一条。
		if (this.history.length > 100) {
			// 从数组尾删除，不影响当前编辑文字。
			this.history.pop();
		}
	}

	// 判断严格空编辑器，返回布尔无修改；例：一行空串true，多条空行或空格串都false。
	private isEditorEmpty(): boolean {
		// 必须恰好一行且该行完全为空，不做trim。
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	// 判断光标是否在首个显示片段，返回布尔无修改；例：同一逻辑行折成多行时，中段不算首行。
	private isOnFirstVisualLine(): boolean {
		// 按最近一次渲染预算重建逻辑到折行映射。
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		// 用当前逻辑行/码元位置找所在片段。
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		// 只有折行下标0成立。
		return currentVisualLine === 0;
	}

	// 判断光标是否在最后显示片段，返回布尔无修改；例：历史Down仅在末片段才进入下一历史判断。
	private isOnLastVisualLine(): boolean {
		// 以最近layoutWidth重新建立折行表。
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		// 定位当前光标所属片段。
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		// 与表中最后下标比较，不是只比较逻辑cursorLine。
		return currentVisualLine === visualLines.length - 1;
	}

	// 向旧/新历史移动，direction=-1向旧、1向新；修改文字/光标并通知onChange，首次进入保存草稿/撤销，例：Down退到-1恢复先前草稿。
	// 越界或无历史直接不动文字；草稿克隆失败/回调异常传播，不自动展开或替换粘贴注册表。
	private navigateHistory(direction: 1 | -1): void {
		// 打断删除/yank/打字连续动作。
		this.lastAction = null;
		// 空历史没有可浏览项。
		if (this.history.length === 0) return;

		// 历史下标减方向，Up传-1所以变大。
		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		// 小于草稿位-1或超过最旧项均拒绝，不环绕。
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// Capture state when first entering history browsing mode
		// 仅第一次从草稿进入历史时保存，不为每次上下浏览都建快照。
		if (this.historyIndex === -1 && newIndex >= 0) {
			// 撤销快照还含大粘贴注册表/计数。
			this.pushUndoSnapshot();
			// 单独深复制EditorState供浏览退回草稿，非JSON复制。
			this.historyDraft = structuredClone(this.state);
		}

		// 采用有效的新历史下标。
		this.historyIndex = newIndex;

		// 退回-1表示离开历史、恢复草稿。
		if (this.historyIndex === -1) {
			// 先取出待恢复草稿。
			const draft = this.historyDraft;
			// 清除持有字段，避免下轮复用旧草稿。
			this.historyDraft = null;
			// 确实保存过草稿时恢复它。
			if (draft) {
				// 替换state对象引用，Map粘贴表不在这个赋值里。
				this.state = draft;
				// 取消此前短行偏好列。
				this.preferredVisualCol = null;
				// 清掉原子段吸附前的位置。
				this.snappedFromCursorCol = null;
				// 视口回到开头，下一render再为新光标调整。
				this.scrollOffset = 0;
				// 可选通知当前存储文字，不直接执行提交。
				if (this.onChange) this.onChange(this.getText());
				// 没有保存草稿时使用空输入回退。
			} else {
				// 内部设置会规范行/光标并通知，不清当前历史下标。
				this.setTextInternal("");
			}
			// 仍处于某条历史时加载该项。
		} else {
			// 向旧历史把光标放全文起点，向新历史放末尾；缺项回退空串，未在此推额外undo。
			this.setTextInternal(this.history[this.historyIndex] || "", direction === -1 ? "start" : "end");
		}
	}

	// 退出历史浏览，清游标/草稿，无文字替换或回调；例：打字后Up不能继续当作仍在旧历史链里。
	private exitHistoryBrowsing(): void {
		// 回到非浏览标志-1。
		this.historyIndex = -1;
		// 丢弃保存草稿引用，不删除历史条目。
		this.historyDraft = null;
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	// 内部加载文本，按start/end放光标、清滚动并通知onChange，返回void；例：navigateHistory向旧项选start，不重置历史浏览标志/粘贴表或新增撤销。
	private setTextInternal(text: string, cursorPlacement: "start" | "end" = "end"): void {
		// 按真实LF拆逻辑行；此函数自身不规范CR/Tab，公共setText在上层先做。
		const lines = text.split("\n");
		// 采用拆出的行，原实现保留空数组兜底；普通字符串split通常至少返回一项。
		this.state.lines = lines.length === 0 ? [""] : lines;
		// start放首逻辑行，其余放最后逻辑行。
		this.state.cursorLine = cursorPlacement === "start" ? 0 : this.state.lines.length - 1;
		// start列0，否则取末行码元长度；setCursorCol同时清垂直偏好和吸附记录。
		this.setCursorCol(cursorPlacement === "start" ? 0 : this.state.lines[this.state.cursorLine]?.length || 0);
		// Reset scroll - render() will adjust to show cursor
		// 重置视口起点，下一render再把光标滚入可见区。
		this.scrollOffset = 0;

		// 只有安装修改回调才通知。
		if (this.onChange) {
			// 回调收到当前存储文字，调用异常直接传播。
			this.onChange(this.getText());
		}
	}

	// 满足Component的失效接口，无参数/返回值；本类不缓存整帧行，例：主题切换时宿主可统一调用，此空方法不清编辑状态。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 生成并着色上边框，输入总宽与隐藏折行数、返回字符串；例：上方还有内容显示↑计数。protected允许子类覆写，不写终端。
	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		// 有隐藏行才使用滚动提示，否则画等宽横线。
		const border = hiddenLineCount > 0 ? createScrollBorder("↑", hiddenLineCount, width) : "─".repeat(width);
		// 实际执行公开borderColor回调，其异常/返回值原样传播。
		return this.borderColor(border);
	}

	// 生成下边框字符串，输入宽度与下方隐藏折行数；例：还有4片未展示显示↓4，子类可覆盖，无状态修改。
	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		// 存在隐藏行用下箭头提示，否则用纯横线。
		const border = hiddenLineCount > 0 ? createScrollBorder("↓", hiddenLineCount, width) : "─".repeat(width);
		// 着色后返回边框，不直接输出。
		return this.borderColor(border);
	}

	// 根据总宽渲染编辑器行数组；规范实际边距、折行、保持光标可见、放边框/光标/菜单，更新最近几何与滚动状态。
	// 例：24行终端最多显示7条正文折行，菜单另接在下边框后；仅返回字符串、主题回调可抛错，字素极窄递归等边界见wordWrapLine。
	render(width: number): string[] {
		// 每侧边距最多留到正文仍有1列，floor令成对边距按整数列。
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		// 实际边距不超过配置值，配置本身不因此被改。
		const paddingX = Math.min(this.paddingX, maxPadding);
		// 扣左右实际边距，正文预算至少1列。
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		// 无边距时专留1列给行末光标；有边距可让光标占右边距首格，因此不再额外扣一列。
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Store for cursor navigation (must match wrapping width)
		// 保存实际折行预算，后续方向键与鼠标映射必须沿用它。
		this.lastWidth = layoutWidth;

		// Layout the text
		// 生成全部正文显示片段及光标归属，不只生成可见部分。
		const layoutLines = this.layoutText(layoutWidth);

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		// 从传入宿主终端读取行数，不探测真实TTY。
		const terminalRows = this.tui.terminal.rows;
		// 正文视口取终端高30%向下取整、至少5行；不是总组件高上限，边框和菜单另算。
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// Find the cursor line index in layoutLines
		// 找带光标的显示片段下标，箭头回调只读取hasCursor。
		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		// 意外无光标片段时按首片段处理滚动，不新增光标状态。
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		// Adjust scroll offset to keep cursor visible
		// 光标在当前视口上方时，把视口首行移到它。
		if (cursorLineIndex < this.scrollOffset) {
			// 滚动起点直接对齐光标片段。
			this.scrollOffset = cursorLineIndex;
			// 光标在视口末尾之后时需向下滚。
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			// 让光标落在最后可见行，而不是总把它顶到第一行。
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		// 内容比视口短时最大滚动为0，否则是最后一页起点。
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		// 将滚动起点夹在有效区间，避免删文后停在空白页。
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		// Get visible lines slice
		// 截取本次可见正文片段，slice不改原布局数组。
		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
		// 保存可见正文行数，供鼠标区间和菜单起点计算。
		this.renderedVisibleLineCount = visibleLines.length;

		// 创建最终带边框/补白/菜单的结果数组。
		const result: string[] = [];
		// 每侧边距由固定数量ASCII空格组成。
		const leftPadding = " ".repeat(paddingX);
		// 右边距先用同样字符串，光标溢入时可少一格。
		const rightPadding = leftPadding;

		// Render top border (with scroll indicator if scrolled down)
		// 上边框总宽按组件width，隐藏量是当前scrollOffset。
		result.push(this.renderTopBorder(width, this.scrollOffset));

		// Render each visible layout line
		// Emit hardware cursor marker when focused so TUI can position the
		// hardware cursor for IME candidate-window placement even while
		// autocomplete (e.g. slash-command menu) is visible.
		// 焦点只决定是否发硬件定位标记，菜单打开也不抑制它，以便IME候选窗定位。
		const emitCursorMarker = this.focused;

		// 依次生成可见正文行。
		for (const layoutLine of visibleLines) {
			// 从未加光标的片段文字开始。
			let displayText = layoutLine.text;
			// 测文字本身列宽，内部光标标记零宽另处理。
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			// 初始认为行末光标没有占用右边距。
			let cursorInPadding = false;

			// Add cursor if this line has it
			// 片段带光标且有明确下标才插入标记，0也是有效位置。
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				// 以片段内码元下标切光标左侧。
				const before = displayText.slice(0, layoutLine.cursorPos);
				// 同一下标取光标及其后文字。
				const after = displayText.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				// 聚焦时才加CURSOR_MARKER，放在模拟光标之前方便宿主提取位置。
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				// 右侧仍有字素时，用该字素作为模拟光标内容。
				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					// 按有效标记规则分段右侧，原子标记可整体成为该光标单位。
					const afterGraphemes = [...this.segment(after, "grapheme")];
					// 取首段文字，缺省空串。
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					// 剥掉已作为模拟光标的首段，剩余文字还需正常显示。
					const restAfter = after.slice(firstGrapheme.length);
					// 仅包内部模拟光标标记，真正反显/硬件光标由宿主处理。
					const cursor = renderFakeCursor(firstGrapheme);
					// 拼接前文、硬件定位、模拟光标和后文，原文字数量不增加。
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
					// 光标位于片段末尾时，没有原字素可反显。
				} else {
					// Cursor is at the end - add highlighted space
					// 用一个空格作为行末模拟光标载体。
					const cursor = renderFakeCursor(" ");
					// 末尾新增这个带标记空格。
					displayText = before + marker + cursor;
					// 正文实际多占1显示列。
					lineVisibleWidth = lineVisibleWidth + 1;
					// If cursor overflows content width into the padding, flag it
					// 若这1列超过contentWidth且存在边距，允许它借右边距首格。
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						// 记住随后要把右边距缩短1格。
						cursorInPadding = true;
					}
				}
			}

			// Calculate padding based on actual visible width
			// 按已知正文/光标宽度补缺少空格，超宽不在此强行裁剪。
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			// 光标已占右边距时去掉右侧一个空格，否则全保留。
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			// 生成一条内容行：左右只有边距，无竖向边框。
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// Render bottom border (with scroll indicator if more content below)
		// 总折行数减去可见区末尾，得到下方隐藏量。
		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		// 下边框与上边框同用整个组件width。
		result.push(this.renderBottomBorder(width, linesBelow));

		// Add autocomplete list if active
		// 默认本轮菜单高度为0，防止关闭后沿用旧鼠标区间。
		this.renderedAutocompleteHeight = 0;
		// 模式和菜单对象都存在才绘候选区。
		if (this.autocompleteState && this.autocompleteList) {
			// 候选菜单用正文宽度，不把外边距当可显示文字区域。
			const autocompleteResult = this.autocompleteList.render(contentWidth);
			// 保存菜单实际行数，可能含额外滚动序号行。
			this.renderedAutocompleteHeight = autocompleteResult.length;
			// 逐行拼菜单边距与补白。
			for (const line of autocompleteResult) {
				// 测菜单行真实显示宽，不按字符串长度。
				const lineWidth = visibleWidth(line);
				// 补足到正文预算，不裁剪菜单异常超宽输出。
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				// 菜单也加与正文相同左右边距。
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		// 返回新数组，实际终端输出由TUI稍后执行。
		return result;
	}

	// 处理局部格坐标鼠标，优先转交菜单，正文只接受左键click定位光标，返回处理/焦点意图或undefined。
	// 例：拖拽留给宿主屏幕选字，不在此复制系统剪贴板；依赖最近render几何，定位按字素列宽换成码元下标，回调异常传播。
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 菜单从可见正文后再跳过上下两条边框的位置开始。
		const autocompleteStartRow = this.renderedVisibleLineCount + 2;
		// 以下四条件共同判断事件是否位于现有菜单区域。
		if (
			// 菜单模式必须打开。
			this.autocompleteState &&
			// 必须确有菜单实例。
			this.autocompleteList &&
			// 鼠标行达到菜单起始行。
			event.y >= autocompleteStartRow &&
			// 且尚未越过实际菜单末行。
			event.y < autocompleteStartRow + this.renderedAutocompleteHeight
		) {
			// 按本事件提供的组件宽重新限制横边距。
			const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
			// 采用不超过可用范围的请求边距。
			const paddingX = Math.min(this.paddingX, maxPadding);
			// 扣左右边距求菜单可用宽度。
			const contentWidth = Math.max(1, event.width - paddingX * 2);
			// 可选调用菜单鼠标方法，将坐标转换进它的局部区域。
			const result = this.autocompleteList.handleMouse?.({
				// 先浅复制事件字段，包括screenX/Y和修饰键。
				...event,
				// x减左边距，不改绝对screenX。
				x: event.x - paddingX,
				// y减菜单开始行，令首候选行从0开始。
				y: event.y - autocompleteStartRow,
				// 子菜单宽度改为正文预算。
				width: contentWidth,
				// 子菜单高度改为真实渲染行数。
				height: this.renderedAutocompleteHeight,
			});
			// 菜单确实返回意图时额外要求Editor获焦；无返回则保持未处理。
			return result ? { ...result, focus: true } : undefined;
		}

		// Leave press/drag/release unhandled so the renderer's screen-level text
		// selection can run over the editor rows (drag to select, release to copy).
		// The renderer synthesizes a click when press and release land on the same
		// cell without movement, which is the gesture that positions the cursor.
		// 正文press/drag/release等放行，只有左键click自行定位；屏幕选择/复制由宿主处理。
		if (event.type !== "click" || event.button !== "left") return undefined;
		// 点击边框/正文外仍吞事件并要焦点，不改变光标。
		if (event.y <= 0 || event.y > this.renderedVisibleLineCount) return { handled: true, focus: true };

		// 按最近渲染宽度建立所有折行的逻辑位置表。
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		// 鼠标第1内容行对应scrollOffset，减1跳过上边框。
		const visualLineIndex = this.scrollOffset + event.y - 1;
		// 取该可见位置对应的完整折行记录。
		const visualLine = visualLines[visualLineIndex];
		// 没有对应记录时也只要焦点，不索引文字。
		if (!visualLine) return { handled: true, focus: true };
		// 读该记录的逻辑行，缺省空串。
		const logicalLine = this.state.lines[visualLine.logicalLine] ?? "";
		// 片段末位置为逻辑码元起点加长度。
		const chunkEnd = visualLine.startCol + visualLine.length;
		// 从整逻辑行截出当前可点击片段。
		const chunk = logicalLine.slice(visualLine.startCol, chunkEnd);
		// 用事件当前宽度重新算可用边距上限。
		const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
		// 实际左边距仍夹住配置值。
		const paddingX = Math.min(this.paddingX, maxPadding);
		// 点击目标先扣左边距并至少0，单位是终端格。
		const targetColumn = Math.max(0, event.x - paddingX);
		// 累计走过的显示格，从0起。
		let visibleColumn = 0;
		// 默认点在文字后就用片段末尾码元位置。
		let targetIndex = chunk.length;
		// 记住最后一个字素起点，非末片段的尾部点击可能要吸附这里。
		let lastGraphemeIndex = 0;
		// 遍历片段字素/有效原子标记，index相对于chunk。
		for (const grapheme of this.segment(chunk, "grapheme")) {
			// 当前段后边界的显示格位置。
			const nextColumn = visibleColumn + visibleWidth(grapheme.segment);
			// 保存本段原始码元起点。
			lastGraphemeIndex = grapheme.index;
			// 点落在当前段占用范围里，包括宽字符第二格时，也选段首。
			if (targetColumn < nextColumn) {
				// 将显示格坐标转为本段起始码元下标。
				targetIndex = grapheme.index;
				// 找到即停止，不再扫描后面段。
				break;
			}
			// 否则继续累计到下一显示格位置。
			visibleColumn = nextColumn;
		}
		// 判断这是其逻辑行的最后显示片段，下面两个条件取或。
		const isLastSegment =
			// 全表最后片段自然也为逻辑末段。
			visualLineIndex === visualLines.length - 1 ||
			// 或下片段来自别的逻辑行，当前就是本逻辑行最后片段。
			visualLines[visualLineIndex + 1]?.logicalLine !== visualLine.logicalLine;
		// 非末片段的末尾逻辑位置属于下一片段，所以末尾点击改吸附当前最后字素起点。
		if (!isLastSegment && targetIndex === chunk.length && chunk.length > 0) targetIndex = lastGraphemeIndex;

		// 采用该片段所属逻辑行号。
		this.state.cursorLine = visualLine.logicalLine;
		// 片段起点加局部码元下标，并清垂直偏好/吸附记录。
		this.setCursorCol(visualLine.startCol + targetIndex);
		// 点击打断连续编辑/删除环动作。
		this.lastAction = null;
		// 定位后离开历史浏览，不替换当前文字。
		this.exitHistoryBrowsing();
		// 已有菜单时重新查当前光标上下文，旧候选不继续当最新结果。
		if (this.autocompleteState) this.updateAutocomplete();
		// 请求已处理和焦点，实际重画由宿主鼠标调度决定。
		return { handled: true, focus: true };
	}

	// 处理一段终端输入，返回void并可修改文字/光标/历史/菜单，调用onChange/onSubmit；按跳字符→括号粘贴→复制/撤销→菜单→编辑/导航→可打印文字依次分派。
	// 例：普通Enter提交，末尾反斜杠Enter改换行，菜单Enter可能只应用候选或继续落入提交。这里不启动外部编辑器、不读剪贴板，用户回调异常会传播。
	// data通常是宿主分好的输入单元，但本方法不保证它只有一个码点；后备路径可把整段以可打印码元开头的data插入，不是完整控制符消毒器。
	handleInput(data: string): void {
		// 取当前全局键位，用户可以改动作对应按键；共享键冲突按下列分支先后解决。
		const kb = getKeybindings();

		// Handle character jump mode (awaiting next character to jump to)
		// 有跳字符方向时，先消费这一次输入作搜索目标或取消。
		if (this.jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			// 任一跳字符热键再次触发都取消等待，不切换成另一个方向。
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				// 清掉跳转状态。
				this.jumpMode = null;
				// 本次热键已处理，不继续正常插字/移动。
				return;
			}

			// 先解码显式文本协议，失败则首码元>=32时采用整段data，空串charCodeAt为NaN。
			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
			// 有可打印目标才实际搜索，undefined与空串不是同一个值。
			if (printable !== undefined) {
				// Printable character - perform the jump
				// 先保存已等待的方向。
				const direction = this.jumpMode;
				// 搜索前退出等待状态。
				this.jumpMode = null;
				// 按原方向搜索字符串，具体用indexOf/lastIndexOf而非词/字素匹配。
				this.jumpToChar(printable, direction);
				// 目标输入只作搜索，不同时插到正文。
				return;
			}

			// Control character - cancel and fall through to normal handling
			// 其余控制输入取消等待，但继续下面普通按键处理。
			this.jumpMode = null;
		}

		// Handle bracketed paste mode
		// 任何位置发现括号粘贴开标记就进入缓冲；本方法本身不负责拼合被拆开的开标记。
		if (data.includes("\x1b[200~")) {
			// 设置粘贴状态，后续输入不按快捷键处理。
			this.isInPaste = true;
			// 新的开始标记重置已有缓冲。
			this.pasteBuffer = "";
			// 只去掉首次开标记；同一data里之前/之后其余文字都仍在本串里。
			data = data.replace("\x1b[200~", "");
		}

		// 粘贴状态中先累积，不直接逐键编辑。
		if (this.isInPaste) {
			// 追加整段输入，没有在这里设大小/等待超时上限。
			this.pasteBuffer += data;
			// 在累计串里找首次完整结束标记，可横跨多次调用拼成。
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			// 找到结束才提交这轮缓冲。
			if (endIndex !== -1) {
				// 结束标记之前都算粘贴正文，不含该标记。
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				// 非空才处理粘贴，空粘贴不新增快照。
				if (pasteContent.length > 0) {
					// 实际清理、存大粘贴/插字并通知修改。
					this.handlePaste(pasteContent);
				}
				// 正文处理成功后退出缓冲状态；若回调抛错会提前退出本方法，未用finally保证这里执行。
				this.isInPaste = false;
				// 跳过6码元结束标记，取同一输入随后余下文字。
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				// 清掉本轮缓冲引用。
				this.pasteBuffer = "";
				// 确有余串才重新分派。
				if (remaining.length > 0) {
					// 递归处理结束后输入，避免把后续按键一概当粘贴正文。
					this.handleInput(remaining);
				}
				// 本轮处理结束，不重复落入普通按键路径。
				return;
			}
			// 尚未收到结束标记就等下一次handleInput。
			return;
		}

		// Ctrl+C - let parent handle (exit/clear)
		// 复制动作优先于菜单取消；本类只让上层处理，不自己访问系统剪贴板。
		if (kb.matches(data, "tui.input.copy")) {
			// 不再向下匹配同键的选择取消。
			return;
		}

		// Undo
		// 撤销动作优先于菜单处理。
		if (kb.matches(data, "tui.editor.undo")) {
			// 恢复最近快照，具体不会自动清菜单/取消异步请求。
			this.undo();
			// 本次撤销键结束。
			return;
		}

		// Handle autocomplete mode
		// 只有已打开且有实例的菜单参与下列路由，等待中的请求不算打开。
		if (this.autocompleteState && this.autocompleteList) {
			// 匹配菜单取消动作时关闭请求及UI。
			if (kb.matches(data, "tui.select.cancel")) {
				// 递增启动代号、清计时器、abort和清菜单状态。
				this.cancelAutocomplete();
				// 取消键不再用于后面编辑动作。
				return;
			}

			// 下面四个选择导航动作任一命中都交给菜单。
			if (
				// 候选向上动作。
				kb.matches(data, "tui.select.up") ||
				// 候选向下动作。
				kb.matches(data, "tui.select.down") ||
				// 候选上翻页动作。
				kb.matches(data, "tui.select.pageUp") ||
				// 候选下翻页动作。
				kb.matches(data, "tui.select.pageDown")
			) {
				// 菜单更新选择，不移动正文光标；Editor没有在这条分支自己请求重画。
				this.autocompleteList.handleInput(data);
				// 导航键被菜单消费。
				return;
			}

			// 打开菜单时Tab应用当前项，不再启动另一轮查询。
			if (kb.matches(data, "tui.input.tab")) {
				// 读取菜单选中对象，空/无效下标可返回null。
				const selected = this.autocompleteList.getSelectedItem();
				// 有条目且提供者仍存在才应用。
				if (selected && this.autocompleteProvider) {
					// 应用前保存文字/光标及粘贴表快照，支持一次undo撤销整次补全。
					this.pushUndoSnapshot();
					// 补全打断连续打字/删文动作。
					this.lastAction = null;
					// 同步委托提供者算新文字/坐标，回调可抛错，不是自动执行命令。
					const result = this.autocompleteProvider.applyCompletion(
						// 传当前逻辑行数组原引用。
						this.state.lines,
						// 传当前逻辑行号。
						this.state.cursorLine,
						// 传当前行内码元下标。
						this.state.cursorCol,
						// 传选中的完整候选。
						selected,
						// 传菜单保存的原替换前缀。
						this.autocompletePrefix,
					);
					// 采用提供者返回行数组，没有另做内容形状/边界验证。
					this.state.lines = result.lines;
					// 采用返回的逻辑行号。
					this.state.cursorLine = result.cursorLine;
					// 采用返回码元列，同时清垂直偏好/吸附记录。
					this.setCursorCol(result.cursorCol);
					// 应用后关闭菜单并取消等待请求。
					this.cancelAutocomplete();
					// 通知当前存储文字，未展开大粘贴。
					if (this.onChange) this.onChange(this.getText());
				}
				// 即使没有可应用项，Tab也在此消费，不落到后续新请求。
				return;
			}

			// 选择确认动作与输入提交动作可共享Enter，但不必然相同键。
			if (kb.matches(data, "tui.select.confirm")) {
				// 取当前高亮项。
				const selected = this.autocompleteList.getSelectedItem();
				// 项与提供者都存在才修改编辑器。
				if (selected && this.autocompleteProvider) {
					// 保存补全前快照。
					this.pushUndoSnapshot();
					// 打断连续动作合并。
					this.lastAction = null;
					// 用提供者应用确认项，参数含当前编辑状态与菜单前缀。
					const result = this.autocompleteProvider.applyCompletion(
						// 当前行数组。
						this.state.lines,
						// 当前逻辑行号。
						this.state.cursorLine,
						// 当前码元列。
						this.state.cursorCol,
						// 选中候选对象。
						selected,
						// 本轮保存前缀，不用候选label猜替换范围。
						this.autocompletePrefix,
					);
					// 接管新行数组。
					this.state.lines = result.lines;
					// 接管新行号。
					this.state.cursorLine = result.cursorLine;
					// 设置新列并清垂直偏好/吸附记录。
					this.setCursorCol(result.cursorCol);

					// 前缀以/开头时采取命令式确认路径，并非检查真实命令已注册。
					if (this.autocompletePrefix.startsWith("/")) {
						// 先关闭菜单，再继续用同一data匹配后续编辑/提交分支；只有该键也匹配submit等条件才真的提交。
						this.cancelAutocomplete();
						// Fall through to submit
						// 其他前缀如文件/命令参数只完成选择。
					} else {
						// 清补全请求及UI。
						this.cancelAutocomplete();
						// 通知补全后的文字。
						if (this.onChange) this.onChange(this.getText());
						// 直接结束，避免同一个Enter又提交正文。
						return;
					}
				}
			}
		}

		// Tab - trigger completion
		// 没有菜单时Tab才发新请求；打开菜单时的Tab已在前面应用候选或被消费并返回。
		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			// 根据是否处于首行命令名上下文选择普通或force请求。
			this.handleTabCompletion();
			// 请求发起不代表结果已完成，本次输入先返回。
			return;
		}

		// Deletion actions
		// 匹配删到逻辑行尾动作，优先级在其他删除之前。
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			// 成段删除并保存到kill ring，可在行末合并下一行。
			this.deleteToEndOfLine();
			// 删除动作已经完成，停止分派。
			return;
		}
		// 匹配删到逻辑行首动作。
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			// 成段向后删并保存环，行首可合并前一行。
			this.deleteToStartOfLine();
			// 不继续其他删除分支。
			return;
		}
		// 匹配向后删词动作。
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			// 按分词/原子标记边界删除并积累到环。
			this.deleteWordBackwards();
			// 结束本次按键。
			return;
		}
		// 匹配向前删词动作。
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			// 删除到下一词边界，行末可删换行。
			this.deleteWordForward();
			// 结束本次按键。
			return;
		}
		// 可配置后删字符动作外，还独立匹配Shift+Backspace兼容形式，因此这一个形式不通过该动作的用户绑定控制。
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			// 按前一个字素/有效标记后删，特殊标记路径还改注册表。
			this.handleBackspace();
			// 后删键已消费。
			return;
		}
		// 可配置前删字符动作或原有Shift+Delete形式进入前删。
		if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			// 删当前字素/标记或合并下一行，注册表处理与Backspace不同。
			this.handleForwardDelete();
			// 结束前删键。
			return;
		}

		// Kill ring actions
		// 匹配yank，即从本实例删除环粘回最近删文。
		if (kb.matches(data, "tui.editor.yank")) {
			// 插入删除环当前项，不读系统剪贴板。
			this.yank();
			// 本次键不再按普通文字解释。
			return;
		}
		// 匹配yankPop轮换动作。
		if (kb.matches(data, "tui.editor.yankPop")) {
			// 只在刚yank且多于一环项时替换上次插入内容。
			this.yankPop();
			// 本次动作结束。
			return;
		}

		// Dedicated history actions always browse entries instead of moving the cursor.
		// 显式上一历史动作不要求先到首行/空编辑器。
		if (kb.matches(data, "tui.editor.historyPrevious")) {
			// 浏览前关闭菜单与等待任务。
			this.cancelAutocomplete();
			// 传-1表示向更旧历史移动。
			this.navigateHistory(-1);
			// 优先于普通光标上下导航。
			return;
		}
		// 显式下一历史动作同样直接浏览。
		if (kb.matches(data, "tui.editor.historyNext")) {
			// 取消当前补全上下文。
			this.cancelAutocomplete();
			// 传1向更新项或草稿移动。
			this.navigateHistory(1);
			// 结束历史键处理。
			return;
		}

		// Cursor movement actions
		// 匹配逻辑行首动作，不是当前折行片段的开头。
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			// 将码元列设0，行号不变。
			this.moveToLineStart();
			// 结束本次导航。
			return;
		}
		// 匹配逻辑行尾动作。
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			// 把列放该逻辑行码元末尾。
			this.moveToLineEnd();
			// 不继续词导航。
			return;
		}
		// 匹配按词左移动作。
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			// 调用向后词边界计算，可在行首跳前一逻辑行尾。
			this.moveWordBackwards();
			// 词左移结束。
			return;
		}
		// 匹配按词右移动作。
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			// 调用向前词边界计算，可在行末跳下一逻辑行首。
			this.moveWordForwards();
			// 词右移结束。
			return;
		}

		// New line
		// 以下是换行判据，多条协议兼容形式与可配置动作取或，先于普通提交判断。
		if (
			// 用户配置的newLine动作。
			kb.matches(data, "tui.input.newLine") ||
			// 以LF开头且还有后续码元的输入也按本分支处理，不逐字插入整段。
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			// 兼容ESC+CR形式。
			data === "\x1b\r" ||
			// 兼容特定Shift+Enter转义形式。
			data === "\x1b[13;2~" ||
			// 含ESC和CR的多码元串也满足，属宽松兼容判据而非完整协议解析。
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			// 单个LF固定进入换行分支。
			(data === "\n" && data.length === 1)
		) {
			// 若用户把提交改成Shift+Enter，普通Enter配末反斜杠可在此反向用作提交。
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				// 先删去反斜杠；这一步可通知一次onChange并触发补全检查。
				this.handleBackspace();
				// 再展开标记/trim、清状态并调用提交回调。
				this.submitValue();
				// 不再插入新逻辑行。
				return;
			}
			// 其他匹配情况拆当前逻辑行，新增LF。
			this.addNewLine();
			// 换行键在此结束。
			return;
		}

		// Submit (Enter)
		// 只有未被换行等较早分支消费、且匹配submit动作才尝试普通提交。
		if (kb.matches(data, "tui.input.submit")) {
			// 提交禁用时直接不操作；之前菜单选择等路径可能已经修改过文字。
			if (this.disableSubmit) return;

			// Workaround for terminals without Shift+Enter support:
			// If char before cursor is \, delete it and insert newline instead of submitting.
			// 取光标所在逻辑行检查反斜杠兼容写法。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 只检查紧邻光标前的一个字面反斜杠，不分析转义奇偶。
			if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
				// 先删一个反斜杠，支持多个连续时只消费最后一个。
				this.handleBackspace();
				// 再新增逻辑行，不发送提交回调。
				this.addNewLine();
				// 兼容换行完成后结束。
				return;
			}

			// 否则执行正常提交，状态清空后通知宿主。
			this.submitValue();
			// 提交键不再进入导航/插字。
			return;
		}

		// Arrow key navigation (with history support)
		// 向上动作可浏览历史、跳行首或按显示片段移动，取决于当前位置。
		if (kb.matches(data, "tui.editor.cursorUp")) {
			// 要进入历史，下面两个条件须同时成立。
			if (
				// 光标已处于全文首显示片段。
				this.isOnFirstVisualLine() &&
				// 并且严格空输入、已经浏览历史、或码元列0，任一成立。
				(this.isEditorEmpty() || this.historyIndex > -1 || this.state.cursorCol === 0)
			) {
				// 向旧历史移动；没有历史或越界时不改文字。
				this.navigateHistory(-1);
				// 首显示片段但不满足历史入口时先把光标移至逻辑行首。
			} else if (this.isOnFirstVisualLine()) {
				// Already at top - jump to start of line
				// 保留草稿，让下一次Up才可能进入历史。
				this.moveToLineStart();
				// 还有更早显示片段可移动时。
			} else {
				// 以显示片段为单位向上一步。
				this.moveCursor(-1, 0);
			}
			// 向上动作结束。
			return;
		}
		// 向下动作也区别历史与普通移动。
		if (kb.matches(data, "tui.editor.cursorDown")) {
			// 历史浏览中且在最后显示片段时才向更新历史。
			if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
				// direction=1可回到原草稿。
				this.navigateHistory(1);
				// 非历史但已在全文最后显示片段，跳逻辑行末。
			} else if (this.isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				// 末行不能再下移时用行尾定位。
				this.moveToLineEnd();
				// 其他位置还可以向下一显示片段移动。
			} else {
				// 向下移动一个折行片段。
				this.moveCursor(1, 0);
			}
			// 结束向下键处理。
			return;
		}
		// 匹配右移动作。
		if (kb.matches(data, "tui.editor.cursorRight")) {
			// 横向delta只看方向，每次跨一个字素/标记，必要时跨逻辑行。
			this.moveCursor(0, 1);
			// 结束右移。
			return;
		}
		// 匹配左移动作。
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			// 向前一个字素/标记或前一行尾移动。
			this.moveCursor(0, -1);
			// 结束左移。
			return;
		}

		// Page up/down - scroll by page and move cursor
		// 匹配编辑区域上翻页动作，若宿主已优先路由消息滚动则不会进这里。
		if (kb.matches(data, "tui.editor.pageUp")) {
			// 将光标上移一个正文视口大小，范围夹住。
			this.pageScroll(-1);
			// 结束上翻页。
			return;
		}
		// 匹配编辑区域下翻页。
		if (kb.matches(data, "tui.editor.pageDown")) {
			// 光标向下移动一页显示片段。
			this.pageScroll(1);
			// 结束下翻页。
			return;
		}

		// Character jump mode triggers
		// 尚不在jump等待时，向前跳字符热键只设置等待方向。
		if (kb.matches(data, "tui.editor.jumpForward")) {
			// 下一可打印输入才真正开始搜索。
			this.jumpMode = "forward";
			// 本热键不插到正文。
			return;
		}
		// 反向跳字符动作同理。
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			// 保存向后搜索方向。
			this.jumpMode = "backward";
			// 返回等待下一次handleInput。
			return;
		}

		// Shift+Space - insert regular space
		// 直接识别Shift+Space兼容输入，这条判断不通过动作名查用户绑定。
		if (matchesKey(data, "shift+space")) {
			// 写入普通ASCII空格，并走打字撤销/补全更新逻辑。
			this.insertCharacter(" ");
			// 避免后面再次解码同一输入。
			return;
		}

		// 统一尝试Kitty CSI-u与modifyOtherKeys显式文本编码，不解码任意普通串作兜底。
		const printable = decodePrintableKey(data);
		// 得到字符（即使长度大于1码元）才插入。
		if (printable !== undefined) {
			// 将协议解码后的文字作为一次insertCharacter调用。
			this.insertCharacter(printable);
			// 不再把原转义报文尾巴插入。
			return;
		}

		// Regular characters
		// 剩余输入只看首码元>=32，不做整串可打印性/控制符校验。
		if (data.charCodeAt(0) >= 32) {
			// 将整段data原样作为一次插入；上游分包语义会影响撤销合并和触发判断。
			this.insertCharacter(data);
		}
	}

	// 把逻辑行转为带光标归属的显示片段，返回LayoutLine数组，不改原文；例：折行边界处光标归下一片，末片允许停该逻辑行末尾。
	// 用列宽决定是否折行，但cursorPos/startIndex始终是码元；不在这里加终端边距/边框或滚动裁剪。
	private layoutText(contentWidth: number): LayoutLine[] {
		// 准备收集完整布局，包含不可见部分。
		const layoutLines: LayoutLine[] = [];

		// 无行或仅一条空行时用固定空编辑器布局。
		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			// Empty editor
			// 空编辑器也有一条光标行。
			layoutLines.push({
				// 显示文字为空。
				text: "",
				// 此行承载光标。
				hasCursor: true,
				// 光标在码元位置0。
				cursorPos: 0,
			});
			// 固定空布局直接返回。
			return layoutLines;
		}

		// Process each logical line
		// 遍历所有逻辑行，不只当前光标行。
		for (let i = 0; i < this.state.lines.length; i++) {
			// 缺/空逻辑行回退空串。
			const line = this.state.lines[i] || "";
			// 判断是否当前光标逻辑行。
			const isCurrentLine = i === this.state.cursorLine;
			// 测整行实际列宽，后面用它判能否单片显示。
			const lineVisibleWidth = visibleWidth(line);

			// 整行放得下就保留为一个显示片段。
			if (lineVisibleWidth <= contentWidth) {
				// Line fits in one layout line
				// 当前行需要额外保存光标位置。
				if (isCurrentLine) {
					// 构造当前行单片记录。
					layoutLines.push({
						// 文字仍是完整原逻辑行。
						text: line,
						// 标记光标在这里。
						hasCursor: true,
						// 光标码元位置不需要减片段起点0。
						cursorPos: this.state.cursorCol,
					});
					// 非当前逻辑行不放光标。
				} else {
					// 添加该行单片布局。
					layoutLines.push({
						// 保留整行文字。
						text: line,
						// 明确这行不承载光标，cursorPos可以缺省。
						hasCursor: false,
					});
				}
				// 整行列宽超过预算，需要折成多个显示片段。
			} else {
				// Line needs wrapping - use word-aware wrapping
				// 将有效粘贴标记视作原子段传入wordWrapLine；它可为显示拆开过长标记，但编辑位置仍对应原文。
				const chunks = wordWrapLine(line, contentWidth, [...this.segment(line, "grapheme")]);

				// 按片段顺序生成布局。
				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					// 读取当前片段对象。
					const chunk = chunks[chunkIndex];
					// 原实现保留缺项跳过，避免使用不存在片段。
					if (!chunk) continue;

					// 当前全局光标列仍是逻辑行内码元下标。
					const cursorPos = this.state.cursorCol;
					// 当前逻辑行的最后片段允许光标落在其结尾插入点。
					const isLastChunk = chunkIndex === chunks.length - 1;

					// Determine if cursor is in this chunk
					// For word-wrapped chunks, we need to handle the case where
					// cursor might be in trimmed whitespace at end of chunk
					// 默认本片段不含光标。
					let hasCursorInChunk = false;
					// 局部光标码元位置初值0，只有命中才使用。
					let adjustedCursorPos = 0;

					// 其他逻辑行绝不因列值相同就获得光标。
					if (isCurrentLine) {
						// 最后片段单独处理末尾插入位置。
						if (isLastChunk) {
							// Last chunk: cursor belongs here if >= startIndex
							// 只要光标不在此片起点之前就归最后片；依赖编辑状态本身范围有效。
							hasCursorInChunk = cursorPos >= chunk.startIndex;
							// 减去片段原起点，转换成局部码元位置。
							adjustedCursorPos = cursorPos - chunk.startIndex;
							// 非末片使用半开区间，末端属于下一片。
						} else {
							// Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
							// But we need to handle the visual position in the trimmed text
							// 光标同时满足起点不小于、终点严格小于才在这里。
							hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
							// 确实属于当前片才计算局部位置。
							if (hasCursorInChunk) {
								// 逻辑列减片段起点，不用列宽相减。
								adjustedCursorPos = cursorPos - chunk.startIndex;
								// Clamp to text length (in case cursor was in trimmed whitespace)
								// 保留原实现的尾位置夹取；当前wordWrapLine本身保留原文空白，不代表此处会主动trim。
								if (adjustedCursorPos > chunk.text.length) {
									// 若局部下标过大则夹到实际片段文字末尾。
									adjustedCursorPos = chunk.text.length;
								}
							}
						}
					}

					// 根据归属生成有/无光标的两类记录。
					if (hasCursorInChunk) {
						// 有光标时加入位置字段。
						layoutLines.push({
							// 片段文字照存。
							text: chunk.text,
							// hasCursor=true供render定位。
							hasCursor: true,
							// cursorPos相对于片段文字，不是整逻辑行。
							cursorPos: adjustedCursorPos,
						});
						// 没有光标的片段不需要位置字段。
					} else {
						// 加入普通片段记录。
						layoutLines.push({
							// 仍保留这片文字，不丢不可见内容。
							text: chunk.text,
							// 明确光标不在本片。
							hasCursor: false,
						});
					}
				}
			}
		}

		// 返回全部布局片段，由render随后滚动取可见段。
		return layoutLines;
	}

	// 读取当前存储文字，按LF连接逻辑行并返回，无状态修改；例：大粘贴在此仍是[paste #1]式短标记，要正文需getExpandedText。
	getText(): string {
		// join新建字符串，不返回可变行数组引用。
		return this.state.lines.join("\n");
	}

	// 按当前注册表把标记替成大粘贴正文，返回新串不改编辑状态；例：回调替换让正文中的$&按字面插入，不当replace模板解释。
	// 按Map迭代顺序逐轮替换，先插入的正文若包含后面ID的标记形状，后续轮仍可能再展开；这不是任意内容都绝无级联的转义格式。
	private expandPasteMarkers(text: string): string {
		// 局部结果初始为输入原串，后面逐轮覆盖引用。
		let result = text;
		// 解构每条登记的数字ID与正文，未引用的注册条目也会参与扫描。
		for (const [pasteId, pasteContent] of this.pastes) {
			// 只匹配这一ID及可选行数/字符数说明，g替换全部同ID标记；不要求说明与实际正文长度一致。
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			// 箭头返回正文作替换结果，避免$1等在字符串替换参数中被解释；回调此时实际执行。
			result = result.replace(markerRegex, () => pasteContent);
		}
		// 返回按所有登记ID处理后的结果，不写磁盘或清注册表。
		return result;
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	// 返回展开大粘贴后的全文，无状态修改/I/O；例：宿主可把结果交外部编辑器，但本方法自身不会启动编辑器。
	getExpandedText(): string {
		// 先按LF连行，再用注册表展开，沿用其顺序替换语义，不额外trim。
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	// 读取逻辑行副本，返回新数组无修改；例：调用方更改返回数组元素不会写回Editor。
	getLines(): string[] {
		// ...只复制容器，字符串值不可变，无须深复制文字。
		return [...this.state.lines];
	}

	// 读取光标为新对象，返回逻辑行号和行内码元列，无副作用；例：col=2不代表屏幕第2格。
	getCursor(): { line: number; col: number } {
		// 属性改名line/col公开，不直接返回内部state引用。
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	// 整体替换文字，先取消补全/历史，规范换行和Tab，内容不同时存undo，再清粘贴表并把光标放末尾，通知onChange。
	// 例：setText("a\r\nb")存成a换行b，可undo回旧文；同文仍会清注册表/重置光标并通知，但不因同文新增快照。
	setText(text: string): void {
		// 关闭已有菜单及旧请求，避免旧候选应用到新文本。
		this.cancelAutocomplete();
		// 打断连续编辑合并标志。
		this.lastAction = null;
		// 离开历史浏览并丢草稿记录。
		this.exitHistoryBrowsing();
		// 规范CRLF/CR为LF、Tab为4空格，此路径未过滤其他控制符。
		const normalized = this.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		// 只有规范后的存储文本与旧文不同才建撤销点。
		if (this.getText() !== normalized) {
			// 快照复制旧粘贴表，所以整次替换后仍可撤销恢复旧正文。
			this.pushUndoSnapshot();
		}
		// 清空当前粘贴正文映射，即使新文字看起来仍含旧标记也不自动保留其登记。
		this.pastes.clear();
		// 新一轮标记从计数0重新分配。
		this.pasteCounter = 0;
		// 内部设置行数组/末尾光标、视口，并通知onChange。
		this.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	// 以程序调用在光标处插入文字，整次一个undo单元，返回void；例：宿主插入图片路径字符串，但这里不读取图片或剪贴板。
	// 先取消补全/历史并存快照，再规范并拼接单/多行，回调异常传播，不自动生成大粘贴标记。
	insertTextAtCursor(text: string): void {
		// 空串完全不操作，也不保存快照。
		if (!text) return;
		// 关闭补全请求和UI。
		this.cancelAutocomplete();
		// 插入前深复制文本/光标/粘贴表。
		this.pushUndoSnapshot();
		// 打断连续打字/删文/yank链。
		this.lastAction = null;
		// 程序插入后不再沿历史上下浏览。
		this.exitHistoryBrowsing();
		// 交内部插入实现完成规范、光标更新及一次onChange。
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	// 规范编辑存储文本，返回新串无外部副作用；例：Windows换行变LF，Tab固定换4空格，与Markdown渲染的3空格规则不同。
	private normalizeText(text: string): string {
		// 先替CRLF避免变双换行，再替余下CR，最后全局展开Tab；不是完整安全过滤器。
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * Internal text insertion at cursor. Handles single and multi-line text.
	 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
	 * Normalizes line endings and calls onChange once at the end.
	 */
	// 内部插入单/多行，更新文字及光标并通知一次onChange，返回void；例：在ab中间插x换行y得到ax换行yb。
	// 不自行建undo、清历史或触发补全；调用者负责这些动作，文本先规范换行/Tab，其他字符原样存储。
	private insertTextAtCursorInternal(text: string): void {
		// 空文字不修改/通知。
		if (!text) return;

		// Normalize line endings and tabs
		// 本内部插入路径先统一CRLF/CR及Tab写法；其他直接插字/yank方法有各自处理。
		const normalized = this.normalizeText(text);
		// 按LF拆分决定单行还是跨行插入，尾LF会保留末尾空行。
		const insertedLines = normalized.split("\n");

		// 取当前逻辑行，无内容时空串。
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		// 保留光标之前的原文字。
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		// 保留光标之后的原文字。
		const afterCursor = currentLine.slice(this.state.cursorCol);

		// 仅一条插入行可直接替当前行。
		if (insertedLines.length === 1) {
			// Single line - insert at cursor position
			// 前文+完整规范插文+后文，原后文不丢。
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			// 光标向右移动插文码元长度，清垂直偏好/吸附。
			this.setCursorCol(this.state.cursorCol + normalized.length);
			// 多行插入需重新组装逻辑行数组。
		} else {
			// Multi-line insertion
			// 创建新数组，各展开项说明其在新文本中的位置。
			this.state.lines = [
				// All lines before current line
				// 保留原当前行之前的全部逻辑行。
				...this.state.lines.slice(0, this.state.cursorLine),

				// The first inserted line merged with text before cursor
				// 插文首行接原光标前内容。
				beforeCursor + insertedLines[0],

				// All middle inserted lines
				// 插文中间行原样展开，不含首/末行。
				...insertedLines.slice(1, -1),

				// The last inserted line with text after cursor
				// 插文末行接原光标后内容。
				insertedLines[insertedLines.length - 1] + afterCursor,

				// All lines after current line
				// 保留原当前行之后的全部行。
				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			// 新光标行从原行后移新增逻辑行数量。
			this.state.cursorLine += insertedLines.length - 1;
			// 光标停在插文末行末尾、原后文之前，按插文末行码元长定位。
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		// 有修改回调才通知。
		if (this.onChange) {
			// 回调收到已更新存储文字，整次内部插入只在此调用一次。
			this.onChange(this.getText());
		}
	}

	// All the editor methods from before...
	// 把传入字符串插到光标处并检查补全，返回void；常见输入单字素，但类型不限制长度。按连续动作/空白存undo，再改行、通知、触发/更新菜单。
	// 例：连续hello共一个撤销单元，空格前存点使后续word与该空格一起撤销；skipUndoCoalescing真时跳过这段快照/标志更新，但仍有插字和补全判断。
	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		// 输入新字符后离开历史浏览。
		this.exitHistoryBrowsing();

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		// 未要求跳过合并管理才处理打字快照。
		if (!skipUndoCoalescing) {
			// 本次字符串含空白，或前次不是type-word时，建立新undo起点；这里并未验证字符是否真正是字母“单词”。
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				// 保存插入前状态，允许后续连续非空白字符串共用这一点。
				this.pushUndoSnapshot();
			}
			// 记作打字动作，其他操作通常会清掉它。
			this.lastAction = "type-word";
		}

		// 当前逻辑行原文字。
		const line = this.state.lines[this.state.cursorLine] || "";

		// 按码元列取得插入点之前部分。
		const before = line.slice(0, this.state.cursorCol);
		// 其后部分保留，包括可能存在的闭引号。
		const after = line.slice(this.state.cursorCol);

		// 在本逻辑行中直接拼入char，没有normalize或逐码元过滤。
		this.state.lines[this.state.cursorLine] = before + char + after;
		// 光标前移char.length码元，组合字符/补充平面可能不止1。
		this.setCursorCol(this.state.cursorCol + char.length);

		// 安装回调时通知修改。
		if (this.onChange) {
			// 在补全判断之前发onChange，回调可能观察或改变外部状态。
			this.onChange(this.getText());
		}

		// Check if we should trigger or update autocomplete
		// 当前没有菜单时，只有特定上下文才自然触发，不是每个字符都查路径。
		if (!this.autocompleteState) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			// 本次恰好插入/且当前仍在首行消息开头（可含空白）时触发命令。
			if (char === "/" && this.isAtStartOfMessage()) {
				// 普通非force请求，实际查询可能要排队异步开始。
				this.tryTriggerAutocomplete();
			}
			// Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries
			// 恰好一个登记触发串时，检查符号token边界。
			else if (this.autocompleteTriggerCharacters.includes(char)) {
				// 读取插字后的当前行。
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				// 只取光标之前的上下文。
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// 合法边界/包装/后缀模式命中才自然触发。
				if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
					// 发普通补全请求，符号上下文通常防抖20毫秒。
					this.tryTriggerAutocomplete();
				}
			}
			// Also auto-trigger when typing letters in a slash command or symbol completion context
			// 本串包含ASCII字母数字/点横线下划线，或含CJK类字符时，再尝试延续上下文；test未锚定，不是验证整个串。
			else if (/[a-zA-Z0-9.\-_]/.test(char) || cjkBreakRegex.test(char)) {
				// 读取已经更新的逻辑行。
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				// 仍只用光标前文字匹配，不看后文。
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// Check if we're in a slash command (with or without space for arguments)
				// 首逻辑行去前导空白后从/起，既可命令名也可参数上下文。
				if (this.isInSlashCommandContext(textBeforeCursor)) {
					// 延续斜杠补全请求，不要求当前菜单已经打开。
					this.tryTriggerAutocomplete();
				}
				// Check if we're in a symbol-based completion context like @, #, or provider triggers
				// 否则符号上下文仍成立时请求候选。
				else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
					// 使用普通模式并合并自然连打请求。
					this.tryTriggerAutocomplete();
				}
			}
			// 已经打开菜单时，不再限定本次输入类别。
		} else {
			// 按现有regular/force模式重查，可能得空后关闭。
			this.updateAutocomplete();
		}
	}

	// 接收括号粘贴正文，原子存undo后解码部分CSI-u控制字节、规范/筛选、必要时补空格，大内容登记短标记，否则直接插入。
	// 例：超过10行或1000码元先显示短标记，提交时再展开；不读系统剪贴板、不执行粘贴文本，不触发补全，筛选仍保留DEL/C1等>=32字符。
	private handlePaste(pastedText: string): void {
		// 先关闭补全和排队/运行中的旧查询。
		this.cancelAutocomplete();
		// 粘贴视作当前草稿修改，不继续历史浏览。
		this.exitHistoryBrowsing();
		// 打断此前打字/yank/kill合并链。
		this.lastAction = null;

		// 保存整次粘贴之前状态，长内容登记也在此点之后。
		this.pushUndoSnapshot();

		// Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
		// control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
		// (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
		// per-char filter below preserves newlines instead of stripping ESC and
		// leaking the printable tail (e.g. "[106;5u") into the editor.
		// 全局替换ESC[数字;5u形式，回调收到完整匹配与数字捕获；仅专门处理Ctrl+英文字母编码。
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			// 数字捕获字符串转为数值码点。
			const cp = Number(code);
			// 小写a..z映射到控制码1..26，例：j106减96得到LF10。
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			// 大写A..Z同样映射1..26。
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			// 其他码点保留原报文，后面过滤只去低控制码，可能留下可打印尾串。
			return match;
		});

		// Clean the pasted text: normalize line endings, expand tabs
		// 把解码后的CRLF/CR统一为LF、Tab展开4空格。
		const cleanText = this.normalizeText(decodedText);

		// Filter out non-printable characters except newlines
		// 接下来链式建立过滤后的新文本，不原地改cleanText。
		let filteredText = cleanText
			// split空串按UTF-16码元拆，代理对两半会各自通过后面阈值，再join复原。
			.split("")
			// 保留LF或码元>=32，其余去掉；不是所有不可打印Unicode/终端控制形式的完整过滤。
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			// 将保留码元连接回字符串。
			.join("");

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		// 首字符看起来像绝对/主目录/相对路径时，考虑在它前面加可读性空格。
		if (/^[/~.]/.test(filteredText)) {
			// 取当前光标行，尚未把粘贴写入。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 光标不在行首才取前一码元，否则空串。
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			// 前字符为ASCII词字符字母数字下划线才加空格，\w在此不等同Unicode所有文字。
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				// 只在整串最前增加一个空格，改变的是实际存储/提交文字，不只是显示。
				filteredText = ` ${filteredText}`;
			}
		}

		// Split into lines to check for large paste
		// 按LF拆过滤后的文本，包括可能新增空格的版本。
		const pastedLines = filteredText.split("\n");

		// Check if this is a large paste (> 10 lines or > 1000 characters)
		// 字符预算实际按UTF-16长度计，不按终端格或Unicode码点。
		const totalChars = filteredText.length;
		// 两个严格大于条件取或：11行或1001码元开始用短标记，边界10行/1000码元本身不超限。
		if (pastedLines.length > 10 || totalChars > 1000) {
			// Store the paste and insert a marker
			// 先递增分配计数。
			this.pasteCounter++;
			// 本次ID复制为局部数值。
			const pasteId = this.pasteCounter;
			// 保存真实过滤正文，菜单/文本只存短标记但注册表仍持有大内容。
			this.pastes.set(pasteId, filteredText);

			// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
			// 构造标记展示文本，按是否超过行数阈值在下方两种格式中选择；标记只保存ID与长度说明，真实正文仍在Map。
			const marker =
				// 超过10行优先显示行数，即使同时超过字符预算。
				pastedLines.length > 10
					? // 行数形式含+及总行数，不是额外新增行数的精确差值。
						`[paste #${pasteId} +${pastedLines.length} lines]`
					: // 否则显示总码元数chars。
						`[paste #${pasteId} ${totalChars} chars]`;
			// 内部插入标记并通知，未再push快照或触发补全。
			this.insertTextAtCursorInternal(marker);
			// 大粘贴在此结束，正文不同时写进逻辑行数组。
			return;
		}

		// 未超阈值且只有一行的普通粘贴。
		if (pastedLines.length === 1) {
			// Single line - insert atomically (do not trigger autocomplete during paste)
			// 原子插入整串，避免逐字补全/多个撤销点。
			this.insertTextAtCursorInternal(filteredText);
			// 单行粘贴处理完结束。
			return;
		}

		// Multi-line paste - use direct state manipulation
		// 普通多行也交同一内部插入方法，只改变逻辑行结构，不再经过按键处理。
		this.insertTextAtCursorInternal(filteredText);
	}

	// 在光标处拆逻辑行，返回void；取消补全/历史、存undo、前文留原行后文移下一行并通知，例：ab中间换行成a换行b。
	private addNewLine(): void {
		// 关菜单并取消旧查询。
		this.cancelAutocomplete();
		// 离开历史浏览。
		this.exitHistoryBrowsing();
		// 换行打断连续动作。
		this.lastAction = null;

		// 保存拆行前快照。
		this.pushUndoSnapshot();

		// 读当前逻辑行。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 光标前文留在原行。
		const before = currentLine.slice(0, this.state.cursorCol);
		// 光标后文将成为新行。
		const after = currentLine.slice(this.state.cursorCol);

		// Split current line
		// 将原当前行缩成前半段。
		this.state.lines[this.state.cursorLine] = before;
		// splice在下一行位置插入后半段，不删除其他行。
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		// 光标逻辑行加1。
		this.state.cursorLine++;
		// 新行光标列0并清垂直偏好。
		this.setCursorCol(0);

		// 存在onChange时通知。
		if (this.onChange) {
			// 回调看到新LF结构，不是提交事件。
			this.onChange(this.getText());
		}
	}

	// 判断换行路径中的“反斜杠+普通Enter反向提交”兼容，输入data与当前键位、返回boolean无文本修改。
	// 例：submit改绑Shift+Enter后，普通Enter本来换行，但前一码元为反斜杠时可先删它再提交；ReturnType只复用管理器返回类型。
	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		// 禁提交就不触发该兼容提交。
		if (this.disableSubmit) return false;
		// 必须是现有码中硬匹配的无修饰Enter，不把任意newLine绑定都视为此形式。
		if (!matchesKey(data, "enter")) return false;
		// 读取submit动作当前有效别名副本。
		const submitKeys = kb.getKeys("tui.input.submit");
		// 只检查其中是否显式含shift+enter或shift+return这两个规范字符串。
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		// 未配置它们则不做反向兼容。
		if (!hasShiftEnter) return false;

		// 取当前行查反斜杠。
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		// 至少有前一码元且恰好反斜杠才true，不检查更多转义层。
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	// 提交当前值，先展开大粘贴并trim，清文字/粘贴/历史浏览/滚动/undo，再通知清空和提交；返回void，不自动addToHistory或调用模型。
	// 例：前后空白会去掉，即使结果空串也可回调；清状态先于回调，onChange若抛错会阻止后续onSubmit且不回滚已清状态。
	private submitValue(): void {
		// 取消补全请求并清菜单，防止旧结果写回已提交输入。
		this.cancelAutocomplete();
		// 连逻辑行、按注册表顺序展开、最后去首尾空白；原始空白并非无条件保留。
		const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

		// 直接换成初始一行空串的状态对象。
		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		// 清掉真实粘贴正文登记。
		this.pastes.clear();
		// 新输入ID从0重新计。
		this.pasteCounter = 0;
		// 退出历史浏览并丢草稿，但history条目本身保留。
		this.exitHistoryBrowsing();
		// 视口起点归0。
		this.scrollOffset = 0;
		// 提交后不能undo回此前输入；删除环和跳字符等其他字段未在此全部重置。
		this.undoStack.clear();
		// 连续编辑标志重置。
		this.lastAction = null;

		// 先同步通知文字已清空，宿主此时getText得到空串。
		if (this.onChange) this.onChange("");
		// 再把事先保存的result交提交回调，数据不因state清空丢失。
		if (this.onSubmit) this.onSubmit(result);
	}

	// 后删一个字素/有效粘贴标记，行首则并前行，返回void；有修改时先存undo，再更新列、通知并重查补全。
	// 例：Backspace删整条已登记粘贴标记时删注册项、计数减一并重排更高ID；其他删除方法不都做这套登记清理，不应泛化。
	private handleBackspace(): void {
		// 退出历史浏览。
		this.exitHistoryBrowsing();
		// 普通Backspace打断kill/yank/连续打字，不把删字存入删除环。
		this.lastAction = null;

		// 行内有前文时按末字素删除。
		if (this.state.cursorCol > 0) {
			// 删除前深复制文本及注册表，支持undo恢复标记/真实正文。
			this.pushUndoSnapshot();

			// Delete grapheme before cursor (handles emojis, combining characters, etc.)
			// 用let是因为重编号后要重新取当前行。
			let line = this.state.lines[this.state.cursorLine] || "";
			// 取光标之前文字，分段范围不包含光标之后。
			const beforeCursor = line.slice(0, this.state.cursorCol);

			// Find the last grapheme in the text before cursor
			// 字素分段同时合并ID有效的粘贴标记。
			const graphemes = [...this.segment(beforeCursor, "grapheme")];
			// 取前文最后一个编辑单位。
			const lastGrapheme = graphemes[graphemes.length - 1];
			// 其码元长度决定后删范围，缺段默认1；下一行仍依赖实际存在末段。
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			// 对末段检测完整标记形状，直接读segment，依赖有效编辑位置而非由上一行回退保证。
			const isPastedSegmented = PASTE_MARKER_SINGLE.exec(lastGrapheme.segment);

			// 命中标记后执行注册表重编号分支。
			if (isPastedSegmented) {
				// This contains the id part e.g 4 from [paste #4 +123 lines]
				// 从捕获组取数字ID。
				const targetId = Number(isPastedSegmented[1]);
				// 删除此ID对应真实正文，Map.delete结果未检查。
				this.pastes.delete(targetId);
				// 计数减1，为后面更高ID整体下移准备。
				this.pasteCounter--;

				// Shift registry entries down in ascending id order, independent
				// of marker order in the text ([paste #3] becomes [paste #2] when
				// [paste #1] is removed).
				// 先收集更高ID并数值升序，确保移动目标不覆盖尚未取出的原条目，不按标记在文本里的顺序移动。
				const higherIds = [...this.pastes.keys()].filter((id) => id > targetId).sort((a, b) => a - b);
				// 依升序重排每个更高登记项。
				for (const id of higherIds) {
					// 把原正文写到id-1，!只消除TS可缺值类型。
					this.pastes.set(id - 1, this.pastes.get(id)!);
					// 删原id位置，保持重编号结果。
					this.pastes.delete(id);
				}

				// Renumber markers with ids greater than the removed one.
				// 对所有逻辑行生成新串，重写高于被删ID的标记文本；不限于当前行，也未再次按Map筛有效ID。
				this.state.lines = this.state.lines.map((line) =>
					// 每个标记匹配回调收到完整串、数字组和可选说明组。
					line.replace(PASTE_MARKER_REGEX, (fullMatch, idGroup, suffixGroup) => {
						// 把数字捕获转number用于比较。
						const x = Number(idGroup);
						// 低于或等于被删ID的标记原样保留，此处还没删除当前标记文字。
						if (x <= targetId) return fullMatch;
						// 更高ID减1并拼原说明组；生成的正常标记有说明，手输无说明的形状未在此用??回退。
						return `[paste #${x - 1}${suffixGroup}]`;
					}),
				);
			}

			// 重编号后重新读当前行，沿用原光标/长度计算，没有重算同一行更高ID重写造成的码元位置变化。
			line = this.state.lines[this.state.cursorLine] || "";

			// 取被删单位之前的原文。
			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			// 光标之后文字保留。
			const after = line.slice(this.state.cursorCol);

			// 拼接后去掉前一个编辑单位。
			this.state.lines[this.state.cursorLine] = before + after;
			// 光标向左减该单位码元长度，清垂直偏好/吸附。
			this.setCursorCol(this.state.cursorCol - graphemeLength);
			// 行首且有上一逻辑行时转成删换行。
		} else if (this.state.cursorLine > 0) {
			// 合并前存undo。
			this.pushUndoSnapshot();

			// Merge with previous line
			// 当前行内容将接到前一行后。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 取前一逻辑行内容。
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			// 上行替成两行正文直接相接。
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			// 移除当前逻辑行，等价删一个LF。
			this.state.lines.splice(this.state.cursorLine, 1);

			// 光标移到前一行号。
			this.state.cursorLine--;
			// 列定位在原前行末尾，不是合并后整行末尾。
			this.setCursorCol(previousLine.length);
		}

		// 有onChange即通知，即使全文起点无可删内容也会走这里。
		if (this.onChange) {
			// 返回当前存储文字给宿主。
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after backspace
		// 菜单已打开时按现有模式更新候选。
		if (this.autocompleteState) {
			// 重发请求取消旧查询，不直接在旧列表上删项。
			this.updateAutocomplete();
			// 菜单没开时，删除可能让上下文重新变可补全。
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			// 取删后的当前逻辑行。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 只考察光标之前文字。
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			// 首行斜杠上下文成立就重触发。
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				// 发普通命令/参数补全请求。
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @, #, or provider triggers
			// 否则合法符号token上下文可自然触发。
			else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
				// 用普通模式查询，符号上下文可防抖。
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	// 设置码元光标列并清垂直偏好/吸附，返回void；例：左右移动或插字用它，垂直移动直接写列以保留偏好，不在此校验范围。
	private setCursorCol(col: number): void {
		// 采用传入col，不夹到当前行长或字素边界。
		this.state.cursorCol = col;
		// 后续垂直移动需从新位置重新建立偏好。
		this.preferredVisualCol = null;
		// 也清此前原子段吸附前的位置。
		this.snappedFromCursorCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	// 把光标移到指定显示片段，输入完整映射/源片号/目标片号、返回void，更新偏好和吸附；例：穿短行先夹末端，下一长行可恢复原偏移。
	// 所有起点/length/VisualCol实际按UTF-16偏移相减，不通过visibleWidth换算成真实屏幕列；多码元字素/粘贴标记内位置会吸到段首。
	private moveToVisualLine(
		// 映射元素含逻辑行号、原行起点和码元长度，Array类型不验证内容/排序。
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		// 当前显示片段下标。
		currentVisualLine: number,
		// 希望抵达的显示片段下标，可能跨逻辑行。
		targetVisualLine: number,
		// 只修改编辑状态，不返回渲染行或自动请求重画。
	): void {
		// 读取源片段。
		const currentVL = visualLines[currentVisualLine];
		// 读取目标片段。
		const targetVL = visualLines[targetVisualLine];
		// 源/目标缺失时直接不移动。
		if (!(currentVL && targetVL)) return;

		// When the cursor was snapped to a segment start, resolve the pre-snap
		// position against the VL it belongs to. This gives the correct visual
		// column even after a resize reshuffles VLs.
		// 稍后确定源片段内当前偏移；名字Visual仍是码元单位。
		let currentVisualCol: number;
		// 之前被吸附过时，要用吸附前位置恢复意图。
		if (this.snappedFromCursorCol !== null) {
			// 在当前重排后的映射里重新找该原位置所属片段，以适应resize改变折行。
			const vlIndex = this.findVisualLineAt(visualLines, currentVL.logicalLine, this.snappedFromCursorCol);
			// 吸附前逻辑列减其所属片段起点，得到原意图的片内偏移。
			currentVisualCol = this.snappedFromCursorCol - visualLines[vlIndex].startCol;
			// 未吸附时直接用现有光标位置。
		} else {
			// 当前逻辑列减当前片段起点。
			currentVisualCol = this.state.cursorCol - currentVL.startCol;
		}

		// For non-last segments, clamp to length-1 to stay within the segment
		// 判断源片段是否其逻辑行的末片，以下两条件取或。
		const isLastSourceSegment =
			// 全表末片必然成立。
			currentVisualLine === visualLines.length - 1 ||
			// 或下片逻辑行不同说明当前为本行末片。
			visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
		// 末片允许停在length末尾插入点，非末片最多length-1以免该位置归下一片，最小0。
		const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

		// 目标片同样需要分辨末片与非末片。
		const isLastTargetSegment =
			// 目标为全表最后。
			targetVisualLine === visualLines.length - 1 ||
			// 或它的下一片来自另一逻辑行。
			visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
		// 据此求目标可用最大码元偏移，不是终端列宽。
		const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

		// 应用偏好决策表，函数会同时更新preferredVisualCol。
		const moveToVisualCol = this.computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

		// Set cursor position
		// 先将逻辑行号改成目标片所属行。
		this.state.cursorLine = targetVL.logicalLine;
		// 目标片起点加选出的片内偏移，恢复逻辑行内码元位置。
		const targetCol = targetVL.startCol + moveToVisualCol;
		// 取目标逻辑行文字供最终范围/原子段判定。
		const logicalLine = this.state.lines[targetVL.logicalLine] || "";
		// 列最多夹到逻辑行末尾，此处故意不调用setCursorCol以保留偏好。
		this.state.cursorCol = Math.min(targetCol, logicalLine.length);

		// Snap cursor to atomic segment boundary (e.g. paste markers)
		// so the cursor never lands in the middle of a multi-grapheme unit.
		// Single-grapheme segments don't need snapping.
		// 整条目标逻辑行按字素/有效标记分段，不只分目标片段，才能识别跨片标记。
		const segments = [...this.segment(logicalLine, "grapheme")];
		// 按源顺序寻找光标落入的段。
		for (const seg of segments) {
			// 已越过光标就停止，没有后续可能命中段。
			if (seg.index > this.state.cursorCol) break;
			// 只有长度大于1码元的段才需要吸附；补充平面单字素也可能在此处理，不能把英文Single-grapheme理解成所有单字素都跳过。
			if (seg.segment.length <= 1) continue;
			// 在此前已确认seg.index<=cursorCol的前提下，列小于段尾即落在段内（也含段首）。
			if (this.state.cursorCol < seg.index + seg.segment.length) {
				// 该段起点早于目标显示片，说明目标是长段的显示续片。
				const isContinuation = seg.index < targetVL.startCol;
				// 按目标/源显示下标确定是否向下移动。
				const isMovingDown = targetVisualLine > currentVisualLine;

				// 向下落进此前已跨入的原子段续片时，尝试跳过余下续片，避免吸回段首而卡住。
				if (isContinuation && isMovingDown) {
					// The segment started on a previous visual line, and we
					// already visited it on the way down. Skip all remaining
					// continuation VLs and land on the first VL past it.
					// 整段排除式末尾码元位置。
					const segEnd = seg.index + seg.segment.length;
					// 从当前目标片下一片开始找落点。
					let next = targetVisualLine + 1;
					// 循环找首个不再覆盖该原子段的显示片，以下条件共同限定。
					while (
						// 仍有下一片可检查。
						next < visualLines.length &&
						// 仍在同一逻辑行上。
						visualLines[next].logicalLine === targetVL.logicalLine &&
						// 而且片起点仍在当前原子段内部。
						visualLines[next].startCol < segEnd
					) {
						// 跳过这一续片再看下一片。
						next++;
					}
					// 找到可用后继片才递归移动。
					if (next < visualLines.length) {
						// 保留原源片下标，改目标为跨过原子段之后的片段，继续应用同一偏好策略。
						this.moveToVisualLine(visualLines, currentVisualLine, next);
						// 递归处理完成就结束，避免后面再吸回原段首。
						return;
					}
				}

				// Snap to the start of the segment so it gets highlighted.
				// Store the pre-snap position so the next vertical move can
				// resolve it to the correct visual column.
				// 未能向下跳过续片时，记住本次尚未吸附的逻辑码元位置。
				this.snappedFromCursorCol = this.state.cursorCol;
				// 实际光标吸到整段开头，可使完整粘贴标记成为光标单位。
				this.state.cursorCol = seg.index;
				// 吸附后立刻结束，不清刚保存的snappedFromCursorCol。
				return;
			}
		}

		// No snap occurred – we moved out of the atomic segment.
		// 没有进入多码元段吸附分支时，旧吸附记录失效。
		this.snappedFromCursorCol = null;
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table:
	 *
	 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
	 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
	 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
	 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
	 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
	 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
	 *
	 * Where:
	 * - P = preferred col is set
	 * - S = cursor in middle of source line (not clamped to end)
	 * - T = target line shorter than current visual col
	 * - U = target line shorter than preferred col
	 */
	// 按当前偏移/源末端/目标末端计算垂直落点，返回片内码元偏移并更新preferredVisualCol；对应上方P/S/T/U决策表，不测终端列宽。
	// 例：偏移8→短片末2会暂记8，下一长片能容8时恢复并清记忆；resize后当前不再夹末时则以当前偏移重新开始。
	private computeVerticalMoveColumn(
		// 当前片内码元偏移，不是visibleWidth结果。
		currentVisualCol: number,
		// 源片允许的最大码元偏移，非末片已减1。
		sourceMaxVisualCol: number,
		// 目标片允许的最大码元偏移。
		targetMaxVisualCol: number,
		// 返回要采用的偏移，调用者再加目标片起点。
	): number {
		// P：是否已有待恢复偏好，0也算已设置。
		const hasPreferred = this.preferredVisualCol !== null; // P
		// S：光标严格在源允许末端之前，用作重排后当前位置优先的判据。
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		// T：目标是否容不下当前偏移。
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		// 没有旧偏好，或当前不在源末端，就以当前偏移发起新决策。
		if (!hasPreferred || cursorInMiddle) {
			// 目标更短时需要夹到目标末端。
			if (targetTooShort) {
				// Cases 2 and 7
				// 记录当前意图，供后续长片恢复。
				this.preferredVisualCol = currentVisualCol;
				// 这一步先返回目标能容纳的最大偏移。
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			// 目标能容当前偏移，就不再保留旧偏好。
			this.preferredVisualCol = null;
			// 维持当前片内偏移直接下移/上移。
			return currentVisualCol;
		}

		// U：此时已有偏好，非空断言只给TS提示；看目标能否装下旧意图。
		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		// 目标比当前还短，或虽长一些仍装不下旧偏好，都继续夹末端。
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			// 不改preferredVisualCol，后面更长片仍有机会恢复。
			return targetMaxVisualCol;
		}

		// Case 3
		// 目标足够长，取出原偏好作为本次落点。
		const result = this.preferredVisualCol!;
		// 恢复成功后清偏好，后续从真实位置重新决策。
		this.preferredVisualCol = null;
		// 返回已保存的偏移值，而不是清空后的字段。
		return result;
	}

	// 移到当前逻辑行首，返回void并打断连续动作/垂直偏好；例：折行中段Home仍到逻辑行0列，不清历史或重查补全。
	private moveToLineStart(): void {
		// 断开kill/yank/打字合并链。
		this.lastAction = null;
		// 码元列设0，同时清吸附记录。
		this.setCursorCol(0);
	}

	// 移到当前逻辑行末，返回void；例：多显示片的长行End到整个逻辑行末，并非可见片尾，不通知文字变化。
	private moveToLineEnd(): void {
		// 清连续动作标志。
		this.lastAction = null;
		// 读取当前行，缺省空串。
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		// 用字符串码元长度放光标到插入点末尾，清垂直偏好。
		this.setCursorCol(currentLine.length);
	}

	// 向后删到逻辑行首，行首则并前行，返回void；存undo、把删文向kill ring前端累积、改光标并通知，例：Ctrl+U后Ctrl+Y可粘回。
	// 不统一取消/刷新补全、不按删掉的标记清注册表，不能把所有成段删文说成执行Backspace的特殊登记流程。
	private deleteToStartOfLine(): void {
		// 离开历史浏览，当前文字仍保留直到后面删除。
		this.exitHistoryBrowsing();

		// 取当前行原文。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 有行内前文时删该区间。
		if (this.state.cursorCol > 0) {
			// 保存删除前文本/光标/粘贴表。
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
			// 原行开头到光标的半开区间就是删文。
			const deletedText = currentLine.slice(0, this.state.cursorCol);
			// 向后删除新文放原环项前面，只有前次kill才累积；否则新建条目。
			this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
			// 记作kill使下一次成段删除可连续累积。
			this.lastAction = "kill";

			// Delete from start of line up to cursor
			// 当前行仅保留光标之后部分。
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			// 光标回到本行列0。
			this.setCursorCol(0);
			// 无前文但还有前行时，删的是一个LF。
		} else if (this.state.cursorLine > 0) {
			// 合并前存快照。
			this.pushUndoSnapshot();

			// At start of line - merge with previous line, treating newline as deleted text
			// 把换行也记进删除环，方向向后所以prepend。
			this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
			// 维持kill连续动作。
			this.lastAction = "kill";

			// 取前行文字。
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			// 前行变成前文接当前行。
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			// 移除当前行槽位，完成逻辑行合并。
			this.state.lines.splice(this.state.cursorLine, 1);
			// 光标行移到前一行。
			this.state.cursorLine--;
			// 停在原前行末尾，setCursorCol清偏好。
			this.setCursorCol(previousLine.length);
		}

		// 有回调则通知，包括全文起点什么也没删的情况。
		if (this.onChange) {
			// 传当前存储文字，不展开大粘贴。
			this.onChange(this.getText());
		}
	}

	// 向前删到逻辑行末，行末则并下一行，返回void；存undo、删文向环尾追加/累积并通知，例：Ctrl+K多次可连同换行一起恢复。
	// 光标行内位置保持，不负责补全重查/注册表重编号，用户回调异常向上传播。
	private deleteToEndOfLine(): void {
		// 退出历史浏览。
		this.exitHistoryBrowsing();

		// 读取当前行原文供删区间/合并使用。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 光标右侧有正文时删除后缀。
		if (this.state.cursorCol < currentLine.length) {
			// 修改前记录undo。
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (forward deletion = append)
			// 从光标到原行末是本次删文。
			const deletedText = currentLine.slice(this.state.cursorCol);
			// 向前删文追加到当前环项末尾，前次不是kill就单独新建。
			this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
			// 把本次记作可连续累积的kill。
			this.lastAction = "kill";

			// Delete from cursor to end of line
			// 当前行缩为光标前文，光标列未改变。
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
			// 光标在行末且还有下一逻辑行时改删换行。
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// 合并前存快照。
			this.pushUndoSnapshot();

			// At end of line - merge with next line, treating newline as deleted text
			// 换行追加到环，保留连续删文中的先后顺序。
			this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
			// 维持kill动作标记。
			this.lastAction = "kill";

			// 取下一行原文。
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			// 当前行后接下一行。
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			// 删除下一行槽位；原光标仍停在两段连接处。
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		// 有onChange就通知，即使已在全文末尾无删除也会调用。
		if (this.onChange) {
			// 交回当前存储文字。
			this.onChange(this.getText());
		}
	}

	// 向后删一个词/符号串/有效原子段，行首可删LF，返回void；先存快照再借词导航求左边界、恢复旧列取删文，向删除环前面累积并通知。
	// 例：foo.bar末尾后删词先去bar而保留点；此路径不按Backspace方式删除粘贴登记，不主动更新补全。
	private deleteWordBackwards(): void {
		// 退出历史浏览。
		this.exitHistoryBrowsing();

		// 保存当前行原文，后续移动只改变光标不改变该串。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		// 列0时没有本行词可删。
		if (this.state.cursorCol === 0) {
			// 仍有上一行才可合并。
			if (this.state.cursorLine > 0) {
				// 在删除换行前存快照。
				this.pushUndoSnapshot();

				// Treat newline as deleted text (backward deletion = prepend)
				// LF视作向后删文，前次kill时放当前环项之前。
				this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
				// 记为kill，后续可继续累积。
				this.lastAction = "kill";

				// 读取上一行文字。
				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				// 将当前行接在上一行之后。
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				// 移除当前行条目。
				this.state.lines.splice(this.state.cursorLine, 1);
				// 光标移到上一逻辑行。
				this.state.cursorLine--;
				// 列到原上一行末尾，连接处保留。
				this.setCursorCol(previousLine.length);
			}
			// 行内还有前文时求词边界。
		} else {
			// 删词前保存撤销快照。
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordBackwards resets it)
			// 先保存旧kill标志，因为moveWordBackwards会清lastAction。
			const wasKill = this.lastAction === "kill";

			// 记原光标右边界，稍后要恢复用于取区间。
			const oldCursorCol = this.state.cursorCol;
			// 借词移动计算左边界，会清垂直偏好。
			this.moveWordBackwards();
			// 记录移动后的左边界。
			const deleteFrom = this.state.cursorCol;
			// 恢复旧光标列，使下方slice仍用原右边界。
			this.setCursorCol(oldCursorCol);

			// 从左边界到旧列的原串是删文。
			const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
			// 按先前保存的wasKill决定是否向前累积，不看刚被移动清掉的标志。
			this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
			// 恢复动作标志为kill。
			this.lastAction = "kill";

			// 开始替换当前行，表达式续行拼删区间前后文字。
			this.state.lines[this.state.cursorLine] =
				// 保留左边界前部分和旧列后部分，中间词区间去掉。
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			// 实际光标放删除后连接位置。
			this.setCursorCol(deleteFrom);
		}

		// 有修改回调时通知当前文字，即使开头无事可删也可能调用。
		if (this.onChange) {
			// 不在此读取系统剪贴板或提交。
			this.onChange(this.getText());
		}
	}

	// 向前删词/符号串/原子段，行末可删换行，返回void；存快照、借词导航找右边界、恢复旧列，删文向环尾累积并通知。
	// 例：从foo.bar开头先删foo，下一次再删点；保留旧光标码元列，不自动重查补全/清粘贴登记。
	private deleteWordForward(): void {
		// 离开历史浏览。
		this.exitHistoryBrowsing();

		// 取原当前行文字。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, merge with next line (delete the newline)
		// 已在行末或更右就没有本行词可删。
		if (this.state.cursorCol >= currentLine.length) {
			// 仍有下一行才可删LF。
			if (this.state.cursorLine < this.state.lines.length - 1) {
				// 合并前保存undo。
				this.pushUndoSnapshot();

				// Treat newline as deleted text (forward deletion = append)
				// 向前删的换行追加到环，可与此前kill累积。
				this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
				// 标记本次为kill。
				this.lastAction = "kill";

				// 取下一逻辑行内容。
				const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
				// 当前行后接下一行文字。
				this.state.lines[this.state.cursorLine] = currentLine + nextLine;
				// 从数组移除下一行，当前光标列不动。
				this.state.lines.splice(this.state.cursorLine + 1, 1);
			}
			// 光标在行内时求向前词边界。
		} else {
			// 删词前深复制快照。
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordForwards resets it)
			// 先保存连续kill标志，词移动会把它清掉。
			const wasKill = this.lastAction === "kill";

			// 保存原光标作为删文左边界。
			const oldCursorCol = this.state.cursorCol;
			// 按词向前移动，寻找右边界。
			this.moveWordForwards();
			// 保存计算出的右边界。
			const deleteTo = this.state.cursorCol;
			// 把光标恢复原位置，供slice和最终状态使用。
			this.setCursorCol(oldCursorCol);

			// 取原列到右边界的删文。
			const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
			// 向前删文append，沿用保存的连续kill状态。
			this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
			// 本次动作恢复为kill。
			this.lastAction = "kill";

			// 赋值表达式跨行，建立去掉词区间后的新行。
			this.state.lines[this.state.cursorLine] =
				// 拼原列前文与右边界后文，光标仍在原列。
				currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
		}

		// 有onChange才通知。
		if (this.onChange) {
			// 通知的是存储串，不是环中删文。
			this.onChange(this.getText());
		}
	}

	// 前删当前字素/有效标记，行末合并下一行，返回void；存undo并通知，随后刷新/重新触发补全。
	// 例：光标在标记前Delete整条显示标记，但该方法不删Map登记/减计数或重编号，和Backspace分支不同；不保存普通删字到kill ring。
	private handleForwardDelete(): void {
		// 退出历史浏览。
		this.exitHistoryBrowsing();
		// 打断连续编辑/删文环链。
		this.lastAction = null;

		// 读当前行原文字。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 右侧仍有文字就删首个编辑单位。
		if (this.state.cursorCol < currentLine.length) {
			// 操作前保存undo。
			this.pushUndoSnapshot();

			// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
			// 从光标开始截取右侧文字，供局部分段。
			const afterCursor = currentLine.slice(this.state.cursorCol);

			// Find the first grapheme at cursor
			// 字素分段合并有效标记，数组下标不同于原行坐标。
			const graphemes = [...this.segment(afterCursor, "grapheme")];
			// 取要删除的第一个单位。
			const firstGrapheme = graphemes[0];
			// 删去该单位的码元长度，缺失时回退1。
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			// 保留光标前文。
			const before = currentLine.slice(0, this.state.cursorCol);
			// 跳过该单位后保留其余后文。
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			// 当前行替成前后拼接，光标列保持。
			this.state.lines[this.state.cursorLine] = before + after;
			// 已在末尾但还有下一行时删LF合并。
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// 合并前保存快照。
			this.pushUndoSnapshot();

			// At end of line - merge with next line
			// 取下一逻辑行文字。
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			// 将其接到当前行后。
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			// 移除下一行条目，不修改当前光标列。
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		// 有回调就通知，全文末尾没有可删内容时也可能走此处。
		if (this.onChange) {
			// 报告当前存储文字。
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after forward delete
		// 已有菜单就按原模式重查。
		if (this.autocompleteState) {
			// 取消/替代旧请求，不直接复用旧列表。
			this.updateAutocomplete();
			// 菜单未打开时删除也可能让上下文重新成立。
		} else {
			// 读删除后的当前行。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 取光标之前文本。
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			// 首行斜杠上下文可重新自然触发。
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				// 发普通补全请求。
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @, #, or provider triggers
			// 否则合法符号token可触发。
			else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
				// 发普通模式请求，可能防抖。
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 */
	// 建立显示片段到逻辑位置的映射，输入折行列宽，返回新数组无文本修改；例：长逻辑行会有多个同logicalLine、不同startCol记录。
	// 对象字段logicalLine是逻辑行号，startCol/length是码元起点/长度；width才是显示列预算，返回类型不是运行时验证。
	private buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		// 收集不含实际片段文字的定位记录，只保存行号与区间。
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		// 遍历全部逻辑行。
		for (let i = 0; i < this.state.lines.length; i++) {
			// 当前逻辑行，缺省空串。
			const line = this.state.lines[i] || "";
			// 先测整行显示列宽供快路判断。
			const lineVisWidth = visibleWidth(line);
			// 空行仍应占一个可导航显示片。
			if (line.length === 0) {
				// Empty line still takes one visual line
				// 空片从码元0开始、长0，保持其原逻辑行号。
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
				// 非空但能放得下预算时也是单片。
			} else if (lineVisWidth <= width) {
				// 整行长度用码元数保存，不用lineVisWidth。
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
				// 超过列预算时需要实际分片。
			} else {
				// Line needs wrapping - use word-aware wrapping
				// 按有效标记字素分段再wordWrap，保持和layoutText使用同样算法。
				const chunks = wordWrapLine(line, width, [...this.segment(line, "grapheme")]);
				// 每个折行片生成一条映射。
				for (const chunk of chunks) {
					// 建立本片普通对象记录。
					visualLines.push({
						// 其源逻辑行号为i。
						logicalLine: i,
						// 原行码元起点沿用chunk.startIndex。
						startCol: chunk.startIndex,
						// 排除式终点减起点得到码元长度。
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		// 返回完整映射，包含屏幕外片段，不改scrollOffset。
		return visualLines;
	}

	/**
	 * Find the visual line index that contains the given logical position.
	 */
	// 从逻辑行号/码元列查所在显示片下标，返回number无状态修改；例：非末片末端归下一片，整逻辑行末尾可归末片。
	// 若没命中就回退全表最后下标，空表为-1；不保证任何越界输入都会被夹到所属逻辑行。
	private findVisualLineAt(
		// 预先按当前宽度建立的映射数组。
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		// 要定位的零起始逻辑行号。
		line: number,
		// 该逻辑行中的码元下标。
		col: number,
		// 返回显示片数组下标，不是逻辑行号。
	): number {
		// 从头寻找第一个包含目标位置的片段。
		for (let i = 0; i < visualLines.length; i++) {
			// 取当前映射条目。
			const vl = visualLines[i];
			// 缺项或逻辑行不符直接跳过。
			if (!vl || vl.logicalLine !== line) continue;
			// 目标码元列减本片起点得到局部偏移。
			const offset = col - vl.startCol;
			// Cursor is in this segment if it's within range. For the last
			// segment of a logical line, cursor can be at length (end position)
			// 全表末项或下一项来自别逻辑行时，本片就是本逻辑行末片。
			const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
			// 非负偏移且在半开范围内可命中；末片额外允许等于length的结尾插入点。
			if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
				// 一旦命中返回本片数组下标。
				return i;
			}
		}
		// 没命中按表尾回退，调用方预期正常光标位置才有常规语义。
		return visualLines.length - 1;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	// 定位当前光标所在显示片，输入映射、返回下标无修改；例：上下键先用它取得源片，不另建分段。
	private findCurrentVisualLine(
		// 同一份折行映射由调用者传入。
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		// 返回number沿用findVisualLineAt的回退规则。
	): number {
		// 取内部逻辑行/码元列交通用定位函数。
		return this.findVisualLineAt(visualLines, this.state.cursorLine, this.state.cursorCol);
	}

	// 按显示片纵移或按字素横移，输入两个方向增量、返回void；改光标/偏好并在菜单开着时重查，不改正文。
	// 例：向右在逻辑行末转下一行首，左右以delta符号只走一个单位；纵移用deltaLine实际数值，非法目标忽略，不保证所有导航入口都刷新菜单。
	private moveCursor(deltaLine: number, deltaCol: number): void {
		// 导航打断打字/删除/yank连续动作。
		this.lastAction = null;
		// 按最近layoutWidth建立完整显示片映射。
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		// 先找当前片号供纵移与末尾偏好计算。
		const currentVisualLine = this.findCurrentVisualLine(visualLines);

		// 非零纵向增量时计算目标显示片。
		if (deltaLine !== 0) {
			// 目标下标是当前片加deltaLine，可不止一步。
			const targetVisualLine = currentVisualLine + deltaLine;

			// 仅在表内才执行纵移，不环绕。
			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				// 共享垂直移动实现处理短行偏好/原子段吸附。
				this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		// 横向非零才继续字素移动；若同时指定纵向，使用刚移动后的状态。
		if (deltaCol !== 0) {
			// 读取此时所在逻辑行文字。
			const currentLine = this.state.lines[this.state.cursorLine] || "";

			// 正deltaCol视作向右一个单位，不按绝对数值走多次。
			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				// 行内未到末尾时可跨一个字素/标记。
				if (this.state.cursorCol < currentLine.length) {
					// 截右侧文字作局部分段。
					const afterCursor = currentLine.slice(this.state.cursorCol);
					// 分段带有效标记意识，字素完整保留。
					const graphemes = [...this.segment(afterCursor, "grapheme")];
					// 取右侧第一个单位。
					const firstGrapheme = graphemes[0];
					// 按其码元长度加列，缺省加1；setCursorCol清此前偏好/吸附。
					this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
					// 右侧已到末尾但还有下一逻辑行。
				} else if (this.state.cursorLine < this.state.lines.length - 1) {
					// Wrap to start of next logical line
					// 逻辑行号前进一行。
					this.state.cursorLine++;
					// 下一行从码元列0开始。
					this.setCursorCol(0);
					// 全文末尾无法再右移时，仅更新垂直移动偏好。
				} else {
					// At end of last line - can't move, but set preferredVisualCol for up/down navigation
					// 取先前计算的当前显示片记录。
					const currentVL = visualLines[currentVisualLine];
					// 确有该片时才能求片内偏移。
					if (currentVL) {
						// 用当前列减片起点记偏好，不是终端格列。
						this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
					}
				}
				// 负deltaCol按向左一个单位处理。
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				// 本行前面还有文字就跨前一个字素/标记。
				if (this.state.cursorCol > 0) {
					// 截光标之前文本。
					const beforeCursor = currentLine.slice(0, this.state.cursorCol);
					// 展开其字素分段，便于取最后一段。
					const graphemes = [...this.segment(beforeCursor, "grapheme")];
					// 读紧邻光标左侧的完整单位。
					const lastGrapheme = graphemes[graphemes.length - 1];
					// 按该单位码元长度减列，缺失回退1，清垂直偏好。
					this.setCursorCol(this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
					// 列0且有前一逻辑行时可跨LF定位。
				} else if (this.state.cursorLine > 0) {
					// Wrap to end of previous logical line
					// 逻辑行号退一行。
					this.state.cursorLine--;
					// 取上一逻辑行内容。
					const prevLine = this.state.lines[this.state.cursorLine] || "";
					// 定位其码元末尾，不删除换行。
					this.setCursorCol(prevLine.length);
				}
			}
		}

		// Keep an open autocomplete picker in sync with the new cursor
		// position: cursor movement changes the text before the cursor, so a
		// picker computed for the old position is stale. Re-query so it
		// refreshes — or closes when the new position yields no suggestions —
		// mirroring insertCharacter()/handleBackspace(). Without this, arrowing
		// left from `/cmd ` back into the command name leaves the argument
		// picker showing against a `/cmd` prefix (and a Tab there would
		// concatenate the stale suggestion onto the partial command name).
		// 移动前打开的菜单现在前缀可能变了，需要重查。
		if (this.autocompleteState) {
			// 按原菜单模式重新发请求，得到空结果后会关闭；发起和实际异步完成是不同阶段。
			this.updateAutocomplete();
		}
	}

	/**
	 * Scroll by a page (direction: -1 for up, 1 for down).
	 * Moves cursor by the page size while keeping it in bounds.
	 */
	// 光标按正文视口大小翻一页，direction=-1向上/1向下，返回void；通过垂直移动保留短片偏好，render随后调整scrollOffset。
	// 例：24行终端页长7片，不直接按逻辑行跳；此方法本身不更新补全，不能泛称所有光标移动都刷新菜单。
	private pageScroll(direction: -1 | 1): void {
		// 翻页打断连续动作。
		this.lastAction = null;
		// 读取传入宿主的终端行数。
		const terminalRows = this.tui.terminal.rows;
		// 页长与render正文视口同为30%高度且至少5。
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		// 按最近渲染宽度建立显示片映射。
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		// 定位源显示片号。
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		// 加方向乘页长后夹到首末片，不环绕或超界。
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

		// 移动实际光标，视口滚动由之后render保持可见逻辑完成。
		this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	// 向后移一个词边界，返回void，不改正文；行首先转上一行尾，其他位置委托共享词导航并提供有效标记分段。
	// 例：foo.bar末尾Ctrl+Left停在bar前，不跨一个任意“空格词”；不在此退出历史或重查补全，清连续动作/垂直偏好。
	private moveWordBackwards(): void {
		// 移动打断kill/yank/打字标志，删词调用者会另保存旧kill状态。
		this.lastAction = null;
		// 当前逻辑行原文。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, move to end of previous line
		// 列0无法在本行再左移词。
		if (this.state.cursorCol === 0) {
			// 存在上一逻辑行时才跨行。
			if (this.state.cursorLine > 0) {
				// 行号减1。
				this.state.cursorLine--;
				// 读取上一行文字。
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				// 光标到上一行码元末尾，清偏好/吸附。
				this.setCursorCol(prevLine.length);
			}
			// 行首分支处理结束，不再拿旧行文字算边界。
			return;
		}

		// 下面先求边界再作为setCursorCol参数写回。
		this.setCursorCol(
			// 共享工具输入原行/当前码元列与定制分段策略，仅返回新码元下标。
			findWordBackward(currentLine, this.state.cursorCol, {
				// 闭包在工具需要分段时执行，将word粒度和有效标记合并交回。
				segment: (text) => this.segment(text, "word"),
				// 以完整标记形状把合并段当原子单位；不是直接验证正文来源。
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	/**
	 * Yank (paste) the most recent kill ring entry at cursor position.
	 */
	// 从本实例删除环粘回当前项，返回void；非空时存undo、插字并标记yank，例：Ctrl+W后Ctrl+Y粘回所删文字，不读系统剪贴板。
	private yank(): void {
		// 空环不保存快照/不修改lastAction。
		if (this.killRing.length === 0) return;

		// 插入前建立撤销点。
		this.pushUndoSnapshot();

		// peek只读尾项，!由length>0支持正常环状态。
		const text = this.killRing.peek()!;
		// 直接插入删文，不重新做大粘贴压标记或自然补全。
		this.insertYankedText(text);

		// 标记刚yank，下一次Alt+Y可替换这一次内容。
		this.lastAction = "yank";
	}

	/**
	 * Cycle through kill ring (only works immediately after yank or yank-pop).
	 * Replaces the last yanked text with the previous entry in the ring.
	 */
	// 刚yank后轮换旧删文，返回void；先存undo，按当前尾项长度删上次插入，再旋环插新尾项，例：多次Alt+Y轮流切换历史删文。
	// 删/插各自可调用onChange，因此不是只通知一次的原子回调；回调抛错不会回滚环/文字，undo快照也不包括环顺序。
	private yankPop(): void {
		// Only works if we just yanked and have more than one entry
		// 必须紧接yank链且至少2项，否则完全不做替换。
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		// 保存替换前编辑状态作为一次撤销点。
		this.pushUndoSnapshot();

		// Delete the previously yanked text (still at end of ring before rotation)
		// 环还未旋转，peek仍对应刚插入的文本，用它删相应码元/逻辑行范围。
		this.deleteYankedText();

		// Rotate the ring: move end to front
		// 原尾项移到首部，使倒数第二项成为新尾项；修改环顺序。
		this.killRing.rotate();

		// Insert the new most recent entry (now at end after rotation)
		// 旋转后读取新当前删文，!依赖环非空。
		const text = this.killRing.peek()!;
		// 将新删文插到同一连接处并更新光标。
		this.insertYankedText(text);

		// 维持yank标志，允许下一次继续轮换。
		this.lastAction = "yank";
	}

	/**
	 * Insert text at cursor position (used by yank operations).
	 */
	// 将删除环文字直接插在光标处，返回void，改逻辑行/列并通知onChange；单行直接拼，多行首尾接原前后文。
	// 例：光标在ab中间插x换行y得ax换行yb；不normalize、建快照、清补全或登记大粘贴，调用者在外层负责undo。
	private insertYankedText(text: string): void {
		// 退出历史浏览，丢草稿引用。
		this.exitHistoryBrowsing();
		// 按LF拆删文，环中的文本通常来自原存储内容。
		const lines = text.split("\n");

		// 单行可直接拼当前行。
		if (lines.length === 1) {
			// Single line - insert at cursor
			// 读取当前逻辑行。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 保留光标前的原文字。
			const before = currentLine.slice(0, this.state.cursorCol);
			// 保留光标后的原文字。
			const after = currentLine.slice(this.state.cursorCol);
			// 把删文text直接拼在两段之间，未再normalize。
			this.state.lines[this.state.cursorLine] = before + text + after;
			// 光标右移插文码元长度，清偏好/吸附。
			this.setCursorCol(this.state.cursorCol + text.length);
			// 多行删文需要分别处理首行、中间行和末行。
		} else {
			// Multi-line insert
			// 读取当前逻辑行作为首尾拼接来源。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 截取当前光标之前部分。
			const before = currentLine.slice(0, this.state.cursorCol);
			// 截取当前光标之后部分。
			const after = currentLine.slice(this.state.cursorCol);

			// First line merges with text before cursor
			// 首插入行接原前文，覆盖原当前行；空首行按空串。
			this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

			// Insert middle lines
			// 仅插入删文中的中间逻辑行，不重复首/末行。
			for (let i = 1; i < lines.length - 1; i++) {
				// 在对应位置逐行splice插入，原后续行自动后移。
				this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
			}

			// Last line merges with text after cursor
			// 末插入行在新数组中的最终逻辑行号。
			const lastLineIndex = this.state.cursorLine + lines.length - 1;
			// 末行接原后文后插到该位置，不覆盖其他原行。
			this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

			// Update cursor position
			// 光标移动到末插入行。
			this.state.cursorLine = lastLineIndex;
			// 停在插入末行文字后、原后文前，以码元长计算。
			this.setCursorCol((lines[lines.length - 1] || "").length);
		}

		// 有回调时通知本次插入完成。
		if (this.onChange) {
			// 文字可能仍含粘贴标记，未调用getExpandedText。
			this.onChange(this.getText());
		}
	}

	/**
	 * Delete the previously yanked text (used by yank-pop).
	 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
	 */
	// 删除刚yank的文本范围，返回void；在环尚未旋转时读取当前尾项，按其行数/码元长度从当前光标往回撤，更新位置并通知。
	// 例：多行yank尾部在第三行，恢复其首行前文并接回光标后文；依赖紧接yank时光标/文字仍匹配，不另验证待删区间内容。
	private deleteYankedText(): void {
		// 取当前环项，必须在rotate之前调用才能对应先前插文。
		const yankedText = this.killRing.peek();
		// 无删文则不改文字或通知。
		if (!yankedText) return;

		// 按LF拆其结构，决定单行/跨行删除。
		const yankLines = yankedText.split("\n");

		// 单行删文只需从当前列往回减码元长度。
		if (yankLines.length === 1) {
			// Single line - delete backward from cursor
			// 读取当前逻辑行。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			// 待删长度是完整yankedText.length，不按字素/显示格数。
			const deleteLen = yankedText.length;
			// 保留原yank开始前的文字。
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			// 保留当前光标后面的文字。
			const after = currentLine.slice(this.state.cursorCol);
			// 前后相接，撤掉刚插入的一段。
			this.state.lines[this.state.cursorLine] = before + after;
			// 把光标移回原插入点，清偏好/吸附。
			this.setCursorCol(this.state.cursorCol - deleteLen);
			// 多行删文需把多条逻辑行合回。
		} else {
			// Multi-line delete - cursor is at end of last yanked line
			// 当前末行号减新增行数得到yank起始逻辑行。
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			// 起始行当前长度减掉首插入行长度，得到原插入点码元列。
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// Get text after cursor on current line
			// 保存末插入行光标之后的原后文。
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// Get text before yank start position
			// 保存首插入行起点之前的原前文。
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// Remove all lines from startLine to cursorLine and replace with merged line
			// 用前后文拼成的一行替掉从起始到当前的全部yank行。
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// Update cursor
			// 光标回到起始逻辑行。
			this.state.cursorLine = startLine;
			// 列回原yank起点，清垂直偏好。
			this.setCursorCol(startCol);
		}

		// 有回调才通知删除阶段完成。
		if (this.onChange) {
			// yankPop随后还会插新文本并再次通知，不应说其外部只看到最终一次变化。
			this.onChange(this.getText());
		}
	}

	// 保存一次撤销快照，无参数/返回值；交文本状态、粘贴Map及计数给深复制栈，例：删标记后undo仍可恢复真实正文。
	// 不快照kill ring、历史条目、菜单/异步任务或滚动等字段；structuredClone若失败会抛错且不新增栈项。
	private pushUndoSnapshot(): void {
		// 构造普通快照对象，UndoStack.push内部实际structuredClone而非只保存这些可变原引用。
		this.undoStack.push({ state: this.state, pastes: this.pastes, pasteCounter: this.pasteCounter });
	}

	// 撤销最近一次已保存状态，返回void；退出历史、弹快照并恢复文字/光标及粘贴表，清动作/偏好后通知，例：原子多行粘贴一次undo整体恢复。
	// 没有redo，不取消补全或统一重置滚动/吸附记录/kill ring；空栈也先退出历史浏览，不能描述成所有状态完全回到历史时刻。
	private undo(): void {
		// 首先离开历史浏览，即使栈空也会清其草稿游标。
		this.exitHistoryBrowsing();
		// 弹出最近快照，栈项随读取移除。
		const snapshot = this.undoStack.pop();
		// 无快照直接结束，不通知onChange。
		if (!snapshot) return;
		// 将快照state字段拷到现有state对象，保留当前对象身份但采用已深复制的lines数组。
		Object.assign(this.state, snapshot.state);
		// 直接接管快照中的独立粘贴Map，不再clone。
		this.pastes = snapshot.pastes;
		// 恢复其计数，后续新粘贴沿该状态编号。
		this.pasteCounter = snapshot.pasteCounter;
		// 撤销打断kill/yank/打字链。
		this.lastAction = null;
		// 清短行垂直偏好；此处没有顺便清snappedFromCursorCol。
		this.preferredVisualCol = null;
		// 有回调才报告恢复结果。
		if (this.onChange) {
			// 通知当前存储文本，不是提交或大粘贴展开。
			this.onChange(this.getText());
		}
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	// 沿指定方向跨逻辑行找字符串首次命中，返回void并改光标，不改文字；通常目标为一字符，但string类型允许多码元/多字符。
	// 例：向前从光标后一码元开始indexOf，找到即停，大小写敏感；反向行首传-1时lastIndexOf会夹到0，不能绝对承诺任何边界都排除当前字符。
	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		// 跳转打断连续动作，即使最终没找到也清标志。
		this.lastAction = null;
		// 布尔值决定遍历行和每行搜索的方向。
		const isForward = direction === "forward";
		// 保存当前逻辑行数组引用，不复制正文。
		const lines = this.state.lines;

		// 向前以lines.length为循环哨兵，向后用-1。
		const end = isForward ? lines.length : -1;
		// 行号每次加1或减1。
		const step = isForward ? 1 : -1;

		// 从当前行开始按方向逐行搜索，不环绕全文。
		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			// 读取本行文字，缺省空串。
			const line = lines[lineIdx] || "";
			// 比较是否还是起始光标行；找到前内部未修改state.cursorLine。
			const isCurrentLine = lineIdx === this.state.cursorLine;

			// Current line: start after/before cursor; other lines: search full line
			// 计算本行搜索起点，嵌套三元在后续行继续。
			const searchFrom = isCurrentLine
				? // 当前行需要排开当前码元位置，其他行用默认范围。
					isForward
					? // 向前从当前列+1开始，不按完整字素长度跳。
						this.state.cursorCol + 1
					: // 向后从当前列-1开始，负数如何夹取遵循JS lastIndexOf语义。
						this.state.cursorCol - 1
				: // 其他行给undefined：indexOf从0、lastIndexOf从末尾搜索。
					undefined;

			// 按方向调用字符串搜索，返回码元起点或-1；不验证命中是否在字素/标记边界。
			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			// 找到第一个命中就采用，不继续后面的行。
			if (idx !== -1) {
				// 设置命中的逻辑行号。
				this.state.cursorLine = lineIdx;
				// 光标设命中码元下标并清垂直偏好/吸附。
				this.setCursorCol(idx);
				// 完成跳转，不触发onChange或补全重查。
				return;
			}
		}
		// No match found - cursor stays in place
	}

	// 向前移一个词/符号串/原子单位，行末可转下一行首，返回void；例：foo.bar开头先停点前，共享词导航实际决定边界。
	// 只改位置并打断连续动作，不自行取消历史/补全或通知文字变化。
	private moveWordForwards(): void {
		// 清最近动作，删词调用者会先保存wasKill。
		this.lastAction = null;
		// 取当前逻辑行原文。
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, move to start of next line
		// 光标已到行末时不再在本行求词边界。
		if (this.state.cursorCol >= currentLine.length) {
			// 仍有下一行才跨逻辑行。
			if (this.state.cursorLine < this.state.lines.length - 1) {
				// 逻辑行号加1。
				this.state.cursorLine++;
				// 光标列0，清偏好/吸附。
				this.setCursorCol(0);
			}
			// 行末分支处理完结束，不继续使用旧currentLine。
			return;
		}

		// 将下方求出的边界作为新的码元列。
		this.setCursorCol(
			// 共享findWordForward只返回位置，不直接修改本state。
			findWordForward(currentLine, this.state.cursorCol, {
				// 闭包返回word粒度/有效标记合并分段，调用时才执行。
				segment: (text) => this.segment(text, "word"),
				// 完整标记段由isPasteMarker视作一个单位跨越。
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	// Slash menu only allowed on the first line of the editor
	// 判断自然斜杠菜单允许的逻辑行，返回布尔无修改；例：第2行输入/不会经这些自然上下文判据启动命令菜单。
	// 这是辅助门槛，不是提供者的全局权限边界，显式Tab的force路径另有判断。
	private isSlashMenuAllowed(): boolean {
		// 只允许cursorLine严格为0，不看折行/scrollOffset。
		return this.state.cursorLine === 0;
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	// 判断当前是否在消息开头，返回布尔无修改；例：首逻辑行空白后刚插/仍成立，正文foo/不成立。
	private isAtStartOfMessage(): boolean {
		// 不在首逻辑行时立刻false。
		if (!this.isSlashMenuAllowed()) return false;
		// 读取当前行原文字。
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		// 只考察光标前部分。
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		// trim后为空或恰好/即可，不检查光标之后是否已有正文。
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	// 识别首逻辑行的斜杠上下文，传光标前文、返回boolean无修改；例：行首空格后/model arg仍成立，不验证命令是否存在。
	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		// 先检查首行，再去前导空白看是否以/起头；后面可以含空格/更多路径斜杠。
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// Autocomplete methods
	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	// 为候选列表求默认高亮下标，输入条目与原前缀，返回下标或-1不改数组；精确value优先，其次第一个startsWith，例：two精确匹配胜过排前的twelve。
	// 大小写敏感、只比value，不看label、不做模糊打分或去掉@/斜杠；-1表示保留SelectList初始选项。
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		// 空前缀不偏向任意条目，返回-1。
		if (!prefix) return -1;

		// 暂存第一个前缀命中，下标0有效，-1表示没见过。
		let firstPrefixIndex = -1;

		// 按候选原顺序扫描。
		for (let i = 0; i < items.length; i++) {
			// 只读取当前项value，!依赖正常稠密数组。
			const value = items[i]!.value;
			// 完全相等即可最高优先级结束。
			if (value === prefix) {
				// 返回这个精确项，不用之前记下的前缀项。
				return i; // Exact match always wins
			}
			// 还未记过前缀命中且本项startsWith才记录。
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				// 保存最先命中的下标，不让后面普通前缀覆盖。
				firstPrefixIndex = i;
			}
		}

		// 没有精确命中就返回首前缀项或-1。
		return firstPrefixIndex;
	}

	// 构造候选菜单并登记确认回调，输入前缀/候选、返回SelectList；构造仅保存函数，之后鼠标确认等才应用文字。
	// 例：命令前缀/使用12..32主列布局，选中会保存undo、委托提供者替换、关菜单并通知，不在此直接提交模型请求。
	private createAutocompleteList(
		// 原始替换前缀，用来挑展示布局；回调应用时读取实例当前autocompletePrefix。
		prefix: string,
		// 公开候选数组原对象，description可缺省，类型不验证value是否唯一。
		items: Array<{ value: string; label: string; description?: string }>,
		// 返回菜单实例，宿主Editor持有它，非已经渲染的行数组。
	): SelectList {
		// 前缀从/起用命令布局，否则undefined使SelectList采用默认配置。
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		// 新菜单初始高亮0，使用当前项数配置与主题；此时不执行applyCompletion。
		const list = new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
		// 登记选择回调，selected是菜单后来确认的原候选对象，回调修改编辑状态并可抛错。
		list.onSelect = (selected) => {
			// 回调执行时提供者可能已变，缺省就不应用。
			if (!this.autocompleteProvider) return;
			// 选择前存整次undo快照。
			this.pushUndoSnapshot();
			// 选择打断连续动作。
			this.lastAction = null;
			// 同步调用当前提供者的应用方法，返回状态不在此再校验。
			const result = this.autocompleteProvider.applyCompletion(
				// 传当前逻辑行数组。
				this.state.lines,
				// 当前逻辑行号。
				this.state.cursorLine,
				// 当前码元列。
				this.state.cursorCol,
				// 本次确认对象。
				selected,
				// 传当前菜单保存的原前缀。
				this.autocompletePrefix,
			);
			// 采用返回行数组。
			this.state.lines = result.lines;
			// 采用返回行号。
			this.state.cursorLine = result.cursorLine;
			// 设返回列并清垂直偏好/吸附。
			this.setCursorCol(result.cursorCol);
			// 关闭请求和UI，避免旧菜单继续使用。
			this.cancelAutocomplete();
			// 可选通知新文字；与handleInput里命令Enter可能继续提交的路径不同，此回调不自动submit。
			this.onChange?.(this.getText());
		};
		// 返回已装好回调的菜单对象。
		return list;
	}

	// 发普通模式请求，输入可选“是否显式Tab”、返回void；例：自然输入/默认false，不代表同步完成或一定显示菜单。
	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		// force=false让提供者可按命令/自然上下文处理，explicitTab沿用传入值。
		this.requestAutocomplete({ force: false, explicitTab });
	}

	// 无菜单时响应Tab，返回void并发适合的请求；首行/命令名无ASCII空格用普通命令模式，其余请求force文件补全。
	// 例：/mod按命令名补，src按force路径；不直接执行提供者或保证一定有候选，force还会查可选shouldTrigger门槛。
	private handleTabCompletion(): void {
		// 没提供者就完全不请求。
		if (!this.autocompleteProvider) return;

		// 取当前逻辑行。
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		// 取光标之前原文供上下文判断。
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		// 首行斜杠上下文且去前导空白后还无ASCII空格，视为命令名；Tab等别的空白不在这条includes判据里。
		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			// 发普通模式的显式命令补全。
			this.handleSlashCommandCompletion();
			// 其他上下文交force文件路径入口。
		} else {
			// explicitTab=true可绕过自然防抖并让唯一候选自动应用。
			this.forceFileAutocomplete(true);
		}
	}

	// 显式触发命令名补全，无参数/返回值；例：/mo后Tab不强制改成文件路径模式，不等查询完成。
	private handleSlashCommandCompletion(): void {
		// 普通模式+显式Tab，仅排入请求流程。
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	// 请求force模式，输入可选显式Tab、返回void；例：普通词src也可交提供者查文件，是否真的查询仍由其门槛/实现决定。
	private forceFileAutocomplete(explicitTab: boolean = false): void {
		// force=true沿用显式标志，后续UI模式会标为force。
		this.requestAutocomplete({ force: true, explicitTab });
	}

	// 统一安排补全，输入force/explicitTab、返回void；先可选门槛，再取消旧请求，生成启动代号并防抖或入串行队列。
	// 例：自然@连打在20毫秒后只启动新上下文，显式Tab不延迟；本方法用void忽略Promise且无catch，不保证提供者拒绝时自动恢复队列。
	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		// 无提供者不取消旧状态或另做查询。
		if (!this.autocompleteProvider) return;

		// 只有force路径询问显式文件补全门槛。
		if (options.force) {
			// 开始计算是否允许触发，逻辑在后续多行完成。
			const shouldTrigger =
				// 提供者没有可选门槛函数时默认允许，短路后不调用缺失方法。
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				// 存在函数就同步执行，它可能抛错/有副作用。
				this.autocompleteProvider.shouldTriggerFileCompletion(
					// 传当前逻辑行数组原引用。
					this.state.lines,
					// 传当前行号。
					this.state.cursorLine,
					// 传当前码元列。
					this.state.cursorCol,
				);
			// 门槛拒绝时直接结束。
			if (!shouldTrigger) {
				// 这一早退在cancelAutocompleteRequest之前，不把它说成必然关闭已有菜单或旧请求。
				return;
			}
		}

		// 取消旧等待/运行请求，但保留当前UI，直到新结果处理或显式清UI。
		this.cancelAutocompleteRequest();
		// 前置++递增并取得新启动代号；cancel内部也会递增，数字只作相等比较。
		const startToken = ++this.autocompleteStartToken;

		// 根据显式状态和当前文本求自然防抖时长。
		const debounceMs = this.getAutocompleteDebounceMs(options);
		// 大于0才注册延迟启动。
		if (debounceMs > 0) {
			// 保存setTimeout句柄，回调等计时到达才执行，不是本行同步查询。
			this.autocompleteDebounceTimer = setTimeout(() => {
				// 定时器触发后先清句柄字段。
				this.autocompleteDebounceTimer = undefined;
				// 将该代号排入异步串行启动，void仅丢弃返回值，不接住Promise拒绝。
				void this.startAutocompleteRequest(startToken, options);
				// 防抖时长单位毫秒，由自然符号上下文决定。
			}, debounceMs);
			// 已注册定时器直接返回，不重复立即启动。
			return;
		}

		// 无需防抖则立即调用异步启动入口；其内部仍先await旧任务，不保证提供者此刻已执行。
		void this.startAutocompleteRequest(startToken, options);
	}

	// 把请求串行排在旧任务之后，输入启动代号/模式、返回Promise<void>；等旧任务完成后再检查代号，创建取消器与文本/光标快照，调用实际查询。
	// 例：旧提供者即便不响应abort，新请求也等它结束；旧Promise拒绝会让后续await拒绝且本实现无恢复catch，不能承诺任意提供者都不会拖住补全。
	private async startAutocompleteRequest(
		// 排队时保存的启动代号，取消/更新后可能失效。
		startToken: number,
		// force决定提供者模式，explicitTab决定唯一候选自动应用。
		options: { force: boolean; explicitTab: boolean },
		// 调用者可await整个等待/查询流程，但入口通常以void调用它。
	): Promise<void> {
		// 先保存旧链Promise引用，否则更新字段后会误等自己。
		const previousTask = this.autocompleteRequestTask;
		// 立即调用async闭包形成新Promise并保存到链字段，闭包开始会先暂停在旧任务上。
		this.autocompleteRequestTask = (async () => {
			// 等待上一任务完成，保证提供者查询不在此链里并发；没有独立超时/拒绝恢复。
			await previousTask;
			// 排到执行时若代号已过期或提供者被移除，就不创建新查询。
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				// 这条排队任务正常完成，后续仍可沿链执行。
				return;
			}

			// 真正开始这次查询才创建专属AbortController。
			const controller = new AbortController();
			// 保存为当前可取消请求。
			this.autocompleteAbort = controller;
			// 递增真实请求编号，和仅排队启动代号分开。
			const requestId = ++this.autocompleteRequestId;
			// 快照当前完整存储文本（含粘贴标记）。
			const snapshotText = this.getText();
			// 快照当前逻辑行号。
			const snapshotLine = this.state.cursorLine;
			// 快照当前码元列。
			const snapshotCol = this.state.cursorCol;

			// 等待实际查询及结果应用，错误自然传到本链，未统一转空建议。
			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
			// async IIFE的括号后()表示现在调用闭包，不是仅登记回调。
		})();
		// 外层也等已保存的新链，返回其完成或拒绝。
		await this.autocompleteRequestTask;
	}

	// 规范提供者触发符并重建模式，返回void，修改本实例三个触发字段；例：$可追加，/或多码元表情不接收，默认@/#始终保留。
	private setAutocompleteTriggerCharacters(triggerCharacters: string[]): void {
		// 从默认数组重新复制，替换提供者时旧自定义符号不会累计。
		const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
		// 逐个处理提供者声明的字符串。
		for (const character of triggerCharacters) {
			// 仅length=1码元、不是/、不含空白且未重复才接受；不是“任意一个Unicode码点”规则。
			if (character.length !== 1 || character === "/" || isWhitespaceChar(character) || next.includes(character)) {
				// 不符合条件直接跳过，不报配置错误。
				continue;
			}
			// 把新触发符加到本轮独立数组。
			next.push(character);
		}
		// 整体替换当前触发字符数组。
		this.autocompleteTriggerCharacters = next;
		// 重建自然触发正则，特殊符号会字面转义。
		this.autocompleteTriggerPattern = buildTriggerPattern(next);
		// 同时重建防抖正则，@仍走专门引用分支。
		this.autocompleteDebouncePattern = buildDebouncePattern(next);
	}

	// 求请求防抖时长，输入两个模式位、返回毫秒，无计时器或查询副作用；例：显式Tab/force为0，自然合法@前缀20，其余0。
	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		// 显式或force任一成立都不额外延迟。
		if (options.explicitTab || options.force) {
			// 0只是跳过防抖，串行队列仍可能等待旧任务。
			return 0;
		}

		// 读取当前光标逻辑行。
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		// 只检查光标前上下文。
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		// 命中符号上下文返回固定20，否则立即排队；不按文件搜索成本动态调节。
		return this.autocompleteDebouncePattern.test(textBeforeCursor) ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	// 实际await提供者建议，再以取消/编号/文字/光标快照丢弃过期结果；当前空建议关菜单，显式force唯一项直接应用，否则建菜单并请求重画。
	// 输入为请求身份/控制器/三项快照与模式，返回Promise<void>；例：旧@请求迟到不覆盖新输入，但提供者抛错/拒绝会向上传播，无catch/finally清理保证。
	private async runAutocompleteRequest(
		// 真正开始查询时分配的编号。
		requestId: number,
		// 本次专属取消器，提供者只收到signal。
		controller: AbortController,
		// 查询启动时完整存储文字快照。
		snapshotText: string,
		// 查询启动时逻辑行号。
		snapshotLine: number,
		// 查询启动时码元列。
		snapshotCol: number,
		// force/显式Tab控制结果应用方式。
		options: { force: boolean; explicitTab: boolean },
		// 异步返回表示本轮结果处理结束，不是提交完成。
	): Promise<void> {
		// 入口时提供者已不存在则不执行查询。
		if (!this.autocompleteProvider) return;

		// 真正调用当前提供者并await其Promise，函数可读文件/执行自定义回调，Editor不在此限定其副作用。
		const suggestions = await this.autocompleteProvider.getSuggestions(
			// 传当前行数组原引用，没有clone给提供者。
			this.state.lines,
			// 传当前逻辑行号。
			this.state.cursorLine,
			// 传当前码元列。
			this.state.cursorCol,
			// 传只读取消意图signal和force，不传explicitTab给提供者。
			{ signal: controller.signal, force: options.force },
		);

		// await后先检查请求仍对应当前状态，判旧在结果应用之前。
		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			// 过期就不显示/应用、不请求重画，取消清理多由发起新请求路径完成。
			return;
		}

		// 当前有效查询已完成，清可取消控制器字段。
		this.autocompleteAbort = undefined;

		// 保留原实现的存在/数组/非空判断，不能说TS接口自动校验第三方运行时结果。
		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			// 无有效候选时取消请求代号并清UI。
			this.cancelAutocomplete();
			// 让宿主安排重画关闭旧菜单，不直接写终端。
			this.tui.requestRender();
			// 空结果处理结束。
			return;
		}

		// 仅force且显式Tab且恰好1候选才自动应用，普通命令唯一项不由这条件自动插入。
		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			// 数组已非空，取唯一项，!是静态断言。
			const item = suggestions.items[0]!;
			// 应用前保存undo。
			this.pushUndoSnapshot();
			// 自动补全打断连续打字/删文动作。
			this.lastAction = null;
			// 同步委托当前提供者应用，未在此验证返回光标范围。
			const result = this.autocompleteProvider.applyCompletion(
				// 传当下行数组。
				this.state.lines,
				// 传当下逻辑行号。
				this.state.cursorLine,
				// 传当下码元列。
				this.state.cursorCol,
				// 传唯一候选。
				item,
				// 替换前缀采用本次建议对象里的prefix，不取旧菜单字段。
				suggestions.prefix,
			);
			// 接管返回行数组。
			this.state.lines = result.lines;
			// 接管返回行号。
			this.state.cursorLine = result.cursorLine;
			// 设置新列并清垂直偏好/吸附。
			this.setCursorCol(result.cursorCol);
			// 通知更新文字，回调在请求重画之前执行，可抛错。
			if (this.onChange) this.onChange(this.getText());
			// 安排一次重画；此唯一项分支本身没有clearAutocompleteUi，不应无条件承诺任何先前菜单都已被清空。
			this.tui.requestRender();
			// 不再创建新菜单，直接结束。
			return;
		}

		// 其他有效建议重建菜单，状态由force位决定，explicitTab不另作为UI状态保存。
		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		// 请求重画展示更新后的候选。
		this.tui.requestRender();
	}

	// 检查异步建议是否仍可应用，输入请求编号/取消器/文字与行列快照，返回布尔不修改状态；例：输入相同文字但光标变了仍拒绝旧结果。
	private isAutocompleteRequestCurrent(
		// 本次查询的真实编号。
		requestId: number,
		// 本次控制器，不只是当前字段可能已改绑的控制器。
		controller: AbortController,
		// 原存储全文值。
		snapshotText: string,
		// 原逻辑行号。
		snapshotLine: number,
		// 原码元列。
		snapshotCol: number,
		// 全部条件成立才true，不查询提供者内部任务是否已停止。
	): boolean {
		// 多行布尔与表达式按顺序短路。
		return (
			// 取消过的请求必定拒绝，即使后来文字又变回相同值。
			!controller.signal.aborted &&
			// 编号必须仍是最新真正启动的查询。
			requestId === this.autocompleteRequestId &&
			// 当前完整存储串必须等于启动时快照。
			this.getText() === snapshotText &&
			// 光标逻辑行也需相同。
			this.state.cursorLine === snapshotLine &&
			// 码元列同样需相同，单靠文字一致不够。
			this.state.cursorCol === snapshotCol
		);
	}

	// 接管有效建议并建立菜单状态，输入建议与regular/force标签、返回void；保存前缀、建菜单、选择精确/首前缀高亮后标打开，不执行候选或请求重画。
	// 例：value恰等prefix的第二项会默认选第二项；找不到匹配仍保留新SelectList的初始0高亮。
	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		// 保存应用时要替换的原前缀。
		this.autocompletePrefix = suggestions.prefix;
		// 每轮新建菜单，候选数组沿用提供者引用，不在旧菜单上增量过滤。
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		// 计算当前原前缀对应最佳高亮，大小写敏感只看value。
		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		// 非负下标才主动选中，0是有效匹配。
		if (bestMatchIndex >= 0) {
			// 设置菜单下标，SelectList会夹范围但不通知选择变化。
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		// 最后标记菜单模式打开，capturesViewportInput从此为true。
		this.autocompleteState = state;
	}

	// 取消排队/防抖/当前查询意图，返回void；递增代号、清计时器、发abort并释放控制器，例：连打新字符让旧启动代号失效。
	// 保留旧Promise链和菜单UI，abort不强制结束任意提供者；需要UI也关时用cancelAutocomplete，不是等待所有底层资源都已关闭。
	private cancelAutocompleteRequest(): void {
		// 令所有已捕获旧startToken的排队任务在真正执行时退回。
		this.autocompleteStartToken += 1;
		// 有防抖句柄才清计时器。
		if (this.autocompleteDebounceTimer) {
			// 取消尚未触发的延迟启动回调。
			clearTimeout(this.autocompleteDebounceTimer);
			// 清掉句柄字段。
			this.autocompleteDebounceTimer = undefined;
		}
		// 可选向当前控制器发取消通知，合作的提供者自行停止/完成。
		this.autocompleteAbort?.abort();
		// 不再持有该控制器，旧任务闭包仍可持有它判取消。
		this.autocompleteAbort = undefined;
	}

	// 只清菜单界面状态，无参数/返回值，不取消异步任务；例：配合cancelAutocompleteRequest分别管理请求与展示。
	private clearAutocompleteUi(): void {
		// null表示没有打开菜单。
		this.autocompleteState = null;
		// 释放菜单实例引用，回调若外部仍持有并非由此销毁。
		this.autocompleteList = undefined;
		// 清替换前缀，避免旧菜单上下文继续使用。
		this.autocompletePrefix = "";
	}

	// 同时取消请求意图与关闭菜单，无参数/返回值；例：Escape/setText/submit均复用，不保证底层Promise此刻已完成。
	private cancelAutocomplete(): void {
		// 先让旧任务过期并发abort。
		this.cancelAutocompleteRequest();
		// 再清菜单模式、实例和前缀，不直接请求重画。
		this.clearAutocompleteUi();
	}

	// 公开查询菜单是否显示，返回布尔无修改；例：CustomEditor用它决定Escape优先取消候选还是走应用中断，不把正在防抖算已显示。
	public isShowingAutocomplete(): boolean {
		// 只看模式是否非null，与capturesViewportInput保持同一判断。
		return this.autocompleteState !== null;
	}

	// 更新已打开菜单，返回void；无菜单/提供者时不操作，否则沿原force模式重发非显式请求，例：输入字符缩小候选，但不会自动应用唯一项。
	private updateAutocomplete(): void {
		// 必须已有UI模式且提供者仍存在，不能用此方法自然打开全新菜单。
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		// force模式保留、explicitTab=false；新结果可能重建或关闭菜单，旧请求先按统一入口取消。
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
