// 为 Input/Editor 计算按词移动或删词的边界；只返回字符串下标，不修改编辑器。
// 工具提供共享 Unicode 词分段、空白检测和 ASCII 标点集合；自定义分段用于让粘贴占位标记等作为完整单位。
import { getWordSegmenter, isWhitespaceChar, PUNCTUATION_REGEX } from "./utils.ts";

// 复用 Intl.Segmenter 的 word 分段器，不是按空格简单 split，也不是字素分段器。
const wordSegmenter = getWordSegmenter();

/**
 * Options for word navigation functions.
 * When omitted, uses the default Intl.Segmenter word segmentation.
 */
// 可选策略接口，只限制回调签名；函数不验证自定义结果是否完整覆盖原文或边界是否正确。
export interface WordNavigationOptions {
	/** Custom segmenter returning word segments for the given text. */
	// 输入是 cursor 左侧/右侧切出的子串，返回可迭代词段；Iterable 允许数组或惰性迭代器，Intl.SegmentData 包含 segment/index/isWordLike 等元数据。
	segment?: (text: string) => Iterable<Intl.SegmentData>;
	/** Predicate identifying atomic segments that should be treated as single units (e.g. paste markers). */
	// 把给定段判为不可拆单位；返回 true 时即使含空格/标点也整段跨越，默认没有这个特殊判定。
	isAtomicSegment?: (segment: string) => boolean;
}

/**
 * Find the cursor position after moving one word backward from `cursor` in `text`.
 * Skips trailing whitespace, then stops at the next word/punctuation boundary.
 *
 * Pure function - does not mutate any state.
 */
// 计算从 cursor 向左按词走一步后的 UTF-16 下标，返回 number，不改传入文本或编辑状态；可选回调会真实执行并可抛错。
// 先取左侧子串并分段，跳末尾空白，再跨一个原子段/词段或连续标点段。例：findWordBackward("foo.bar",7) 得 4，光标从 bar 后移到 bar 前；回调是否有副作用由调用方负责，cursor 预期在合法字符串边界内。
export function findWordBackward(text: string, cursor: number, options?: WordNavigationOptions): number {
	// 输入在起点或更左时直接返回 0，不调用分段回调。
	if (cursor <= 0) return 0;

	// 按 UTF-16 下标截取左侧文字，不含 cursor 之后部分；不是按终端列切。
	const textBeforeCursor = text.slice(0, cursor);
	// 取可选自定义分段函数，?. 遇缺省 options 得 undefined。
	const segmentFn = options?.segment;
	// 取可选原子段判断函数引用。
	const isAtomic = options?.isAtomicSegment;
	// 自定义优先，否则用共享默认分段；都展开为新数组，允许下面从尾部 pop，不修改自定义原数组容器。
	const segments = segmentFn ? [...segmentFn(textBeforeCursor)] : [...wordSegmenter.segment(textBeforeCursor)];
	// 从原下标开始累计要向左减掉的字符串长度。
	let newCursor = cursor;

	// Skip trailing whitespace
	// 先持续跳过靠近光标的空白，下面三个条件都满足才继续。
	while (
		// 数组还有段可检查。
		segments.length > 0 &&
		// 尾段若是原子单位，即使含空白也不能在这个空白循环中跳过；可选链与 || 为取不到尾段时提供空串。
		!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
		// 其余尾段只有被空白判定匹配才移除；isWhitespaceChar 使用正则检查是否含空白。
		isWhitespaceChar(segments[segments.length - 1]?.segment || "")
	) {
		// pop 消费最后一段，按它的 UTF-16 长度向左减；缺失或零长时回退 0。
		newCursor -= segments.pop()?.segment.length || 0;
	}

	// 只剩空白或自定义没有返回词段时直接返回累计位置。
	if (segments.length === 0) return newCursor;

	// 此时数组非空，! 告诉 TypeScript 尾项存在，不新增运行时检查。
	const last = segments[segments.length - 1]!;

	// 原子段优先于 isWordLike 和标点处理。
	if (isAtomic?.(last.segment)) {
		// Skip one atomic segment.
		// 整个原子段一次跨过，不检查它内部的空格或符号。
		newCursor -= last.segment.length;
		// 普通词样段进入词内标点边界处理。
	} else if (last.isWordLike) {
		// Skip inside one word-like segment, preserving ASCII punctuation boundaries.
		// 保存该段文字，而不是读取它的 index；位置变化主要按 segment.length 累计。
		const segment = last.segment;
		// 创建带 g 的新正则查找该段内所有 ASCII 标点，matchAll 返回迭代器，... 展成数组；不会修改共享正则的 lastIndex。
		const matches = [...segment.matchAll(new RegExp(PUNCTUATION_REGEX, "g"))];
		// 没有标点时整个词段是本次移动单位。
		if (matches.length <= 0) {
			// 向左减去全部词段长度。
			newCursor -= segment.length;
			// 词样段内部含标点时，只跨到最后一个标点的后面。
		} else {
			// 取得最靠后的标点匹配，前面已确认至少一个。
			const lastMatch = matches[matches.length - 1]!;
			// 段长减“末标点起点加其长度”得到后缀长度，向左减它，停在最后标点之后；自定义异常分段下也可能移动 0。
			newCursor -= segment.length - (lastMatch.index + lastMatch[0].length);
		}
		// 既不是原子段也不是词样段时，把连续非空白符号段作为一组跨越。
	} else {
		// Skip non-word non-whitespace run (punctuation)
		// 继续检查相邻尾段，直到数组空、原子段、词段或空白出现。
		while (
			// 仍有尾段可处理。
			segments.length > 0 &&
			// 遇到原子段停止，留给下一次按词操作。
			!isAtomic?.(segments[segments.length - 1]?.segment || "") &&
			// 遇到词样段停止，不把前一个词一起吞掉。
			!segments[segments.length - 1]?.isWordLike &&
			// 遇到空白停止，不把标点之前的间隔再跨过去。
			!isWhitespaceChar(segments[segments.length - 1]?.segment || "")
		) {
			// 消费一个符号段，按字符串长度累计左移；不按显示宽度计算。
			newCursor -= segments.pop()?.segment.length || 0;
		}
	}

	// 返回求得下标，上游自行更新光标或按该区间删除文字。
	return newCursor;
}

/**
 * Find the cursor position after moving one word forward from `cursor` in `text`.
 * Skips leading whitespace, then stops at the next word/punctuation boundary.
 *
 * Pure function - does not mutate any state.
 */
// 计算从 cursor 向右按词走一步后的 UTF-16 下标，返回 number，不改原文本；自定义分段/判定异常向上传播。
// 先切右侧并取迭代器，跳前导空白，再跨一个原子段/词段或连续标点。例：findWordForward("foo.bar",0) 得 3，停在点之前；不会自行跨行更新 Editor 的 cursorLine，那由上层处理。
export function findWordForward(text: string, cursor: number, options?: WordNavigationOptions): number {
	// 已在末尾或更右时夹到 text.length，不调用自定义分段。
	if (cursor >= text.length) return text.length;

	// 取得从当前字符串下标到末尾的子串，分段回调看到的是这个局部文本。
	const textAfterCursor = text.slice(cursor);
	// 取可选自定义分段函数。
	const segmentFn = options?.segment;
	// 取可选原子段函数。
	const isAtomic = options?.isAtomicSegment;
	// 选择自定义或默认 Iterable；这次不先展开完整数组，向前可以逐段读取。
	const segments = segmentFn ? segmentFn(textAfterCursor) : wordSegmenter.segment(textAfterCursor);
	// 通过 Symbol.iterator 取得迭代器，这是 for...of 背后的协议。
	const iterator = segments[Symbol.iterator]();
	// 先读第一段，结果对象有 done 和 value，let 允许后面不断替换结果。
	let next = iterator.next();
	// 从原 cursor 开始累计向右移动长度。
	let newCursor = cursor;

	// Skip leading whitespace
	// 迭代没结束、不是原子段且是空白时持续跳过；短路判断保护 next.value 的读取。
	while (!next.done && !isAtomic?.(next.value.segment) && isWhitespaceChar(next.value.segment)) {
		// 向右加当前空白段的 UTF-16 长度。
		newCursor += next.value.segment.length;
		// 推进迭代器到下一段。
		next = iterator.next();
	}

	// 已遍历完就返回位置，例如右侧全是空白或自定义返回空迭代器。
	if (next.done) return newCursor;

	// 原子段优先，不按其内部词/标点进一步切。
	if (isAtomic?.(next.value.segment)) {
		// Skip one atomic segment.
		// 一次跨过整个原子段。
		newCursor += next.value.segment.length;
		// 普通词样段按内部 ASCII 标点决定停止点。
	} else if (next.value.isWordLike) {
		// Skip inside one word-like segment, preserving ASCII punctuation boundaries.
		// exec 找第一个标点，有则只走到其起点，无则跨完整段；?? 保留 index=0，只有未匹配时才回退段长，共享正则没有 g 标志。
		newCursor += PUNCTUATION_REGEX.exec(next.value.segment)?.index ?? next.value.segment.length;
		// 其余按连续非词/非空白符号段处理。
	} else {
		// Skip non-word non-whitespace run (punctuation)
		// 迭代到词段、空白、原子段或结束就停止连续符号跨越。
		while (
			// 仍未到迭代结尾。
			!next.done &&
			// 当前不是原子单位。
			!isAtomic?.(next.value.segment) &&
			// 当前不是词样段。
			!next.value.isWordLike &&
			// 当前也不是空白段。
			!isWhitespaceChar(next.value.segment)
		) {
			// 累计本段字符串长度。
			newCursor += next.value.segment.length;
			// 推进到下一段，重新检查循环条件。
			next = iterator.next();
		}
	}

	// 返回完整字符串坐标下的新下标，上游再决定移动或删除。
	return newCursor;
}
