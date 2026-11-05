// Text in the store (decision "Text is plain UTF-8, in code point order"): Chord compares strings by code point, as
// SQLite's BINARY collation compares their UTF-8 bytes, never by JavaScript's UTF-16 code units; every stored string
// is well-formed and free of NUL, and a prefix becomes a range by its upper bound.

// 所属：packages/chord/src/store 的存储层文本规则，被 rows/columns（写入校验）、evaluate（比较）、
// sql（前缀范围）、import（归档文本校验）和 documents/keyed-slot（有序键）共同使用。
// 解决的问题：JavaScript 的字符串比较按 UTF-16 单元，而 SQLite 的 BINARY 排序按 UTF-8 字节；
// 两者对补充平面字符（如表情）的顺序不同，因此仓库统一用码点顺序，并由本文件提供比较与规范化。
// 职责边界：只做纯字符串计算，不访问数据库、不缓存、不抛 ChordError 之外的错误；
// 错误只在 storedText 遇到 NUL 时以 invalid/args 抛出，调用方负责把插件输入送到这里。
// 下游依赖：data/internal.ts 的 invalid 构造器。
//
// 能力清单：
// - compareText：按码点顺序比较两个字符串，供排序和条件求值。
// - codePointRank（内部）：把 UTF-16 单元映射到码点比较用的排名。
// - storedText：存储前的文本规范化，拒绝 NUL、替换孤立代理项。
// - prefixUpperBound：为前缀计算最小开区间上界，供 SQL 范围扫描。
//
// 组合关系：写入路径先经 storedText 规范化（rows/columns），读回或谓词求值用 compareText 得到与 SQLite 一致的顺序；
// 前缀查询把 SQL 条件写成 `column >= prefix AND column < prefixUpperBound(prefix)`。
//
// 示例：
// [...["b", "a", "\u{1F600}"]].sort(compareText); // ["a", "b", "\u{1F600}"]，与 SQLite 字节序一致
// storedText("a\0b", "path"); // 抛 invalid/args
// prefixUpperBound("a/"); // "a0"
//
// 建议阅读顺序：先看 storedText（写入信任边界），再看 compareText 与 codePointRank（排序规则），
// 最后看 prefixUpperBound（把排序规则用于范围查询）。

import { invalid } from "../data/internal.ts";

/** Compares `a` and `b` by code point: negative, zero or positive. */
/**
 * 按码点顺序比较 a 与 b，返回负数、0 或正数；示例 compareText("a", "b") < 0。
 * 输入两个已解码的 string，无副作用，不访问存储；比较本身不会抛错。
 * 主流程：只扫描共同长度内的 UTF-16 单元，遇到不同单元时用 codePointRank 修正，
 * 共同前缀相同时用长度差决定较短者在前。
 * 直接用 < 运算符会按 UTF-16 单元比较，U+FFFF 会排在 U+10000 之前；本函数与 SQLite BINARY 的
 * UTF-8 字节序保持一致，因此插件排序和 SQL 排序得到同一顺序。
 */
export function compareText(a: string, b: string): number {
	// length 是两者 UTF-16 单元数的较小值；只扫描共同长度，先出现的不同单元决定顺序。
	const length = Math.min(a.length, b.length);
	// i++ 每次前进一个 UTF-16 单元；代理项的排序差异由下面的 rank 变换处理。
	for (let i = 0; i < length; i++) {
		// charCodeAt 读取一个 16 位单元；它与 codePointAt 不同，遇到表情等字符时不会合并代理项对。
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		// 第一个不同单元经排名转换后比较；前缀完全相等时不会进入这一分支。
		if (x !== y) return codePointRank(x) - codePointRank(y);
	}
	// 共同部分相同则较短字符串在前；长度相同就返回 0。
	return a.length - b.length;
}

/**
 * A UTF-16 code unit's rank in code point order: a surrogate starts a code point above U+FFFF, so it ranks above every
 * unit from U+E000 on.
 */
/** 将一个 UTF-16 单元映射到比较用的排名，无副作用；例如 U+D800（代理项）的排名被移到 U+E000 之后，使补充平面字符排在 BMP 字符之后。 */
/**
 * 内部辅助：把单个 UTF-16 单元转换成可以数值比较的排名。输入 0..0xFFFF 的单元，返回排名数字。
 * 转换分三段：代理项之前不变；E000..FFFF 下移 0x800；D800..DFFF 的代理项上移 0x2000。
 * 这样单元数值的大小顺序恰好等于“码点顺序”，且不需要把字符串拼接成语义码点。转换只用于比较，不改输入。
 * 示例：compareText(String.fromCodePoint(0xffff), String.fromCodePoint(0x10000)) < 0，因为排名 0xF7FF < 0xF800。
 */
function codePointRank(unit: number): number {
	// 代理项之前的 BMP 单元无需移动。
	if (unit < 0xd800) return unit;
	// 三元表达式把代理项区间上移、之后的 BMP 区间下移；排名只用于比较，不写回字符串。
	return unit < 0xe000 ? unit + 0x2000 : unit - 0x800;
}

/**
 * `text` as the store keeps it: a lone surrogate replaced by U+FFFD (copied only when one occurs), NUL refused
 * `invalid/args` (`what` names the value). Plugin strings are a trust boundary.
 */
/** 在插件文本进入 store 的边界处理内容：NUL 抛 invalid/args，孤立代理项替换成 U+FFFD，其余返回原文本。例如 "abc" 保持不变，含孤立高代理项的字符串会生成规范文本。 */
/**
 * 存储前的文本规范化：输入插件提供的 text 和用于错误信息的 what，返回可存入 SQLite 的字符串。
 * 错误路径：包含 NUL 时抛出 ChordError(invalid/args)；这是信任边界校验，因为 TypeScript 的 string 不排除 NUL。
 * 主流程：先查 NUL，再用 isWellFormed 快速判断；只有含孤立代理项时才调用 toWellFormed 生成替换后的新串。
 * 无副作用；正常文本原样返回（不复制）。示例：把包含孤立代理项 U+D800 的文本传给 storedText，
 * 返回的字符串中该位置变成替换字符 U+FFFD，其余字符不变。
 */
export function storedText(text: string, what: string): string {
	// TypeScript 的 string 只约束类型，不排除 NUL；what 用于指出哪一个参数出错。
	if (text.includes("\0")) throw invalid("args", `${what}: text may not contain NUL`);
	// 先检测，只有确实需要修复 UTF-16 时才调用 toWellFormed，避免正常文本额外处理。
	return text.isWellFormed() ? text : text.toWellFormed();
}

/**
 * The smallest string above every string starting with `prefix`, in code point order: the next code point after its
 * last, carrying past U+10FFFF; `undefined` when there is none (`""` and all-U+10FFFF prefixes). `prefix` is
 * well-formed.
 */
/** 为合法前缀计算不含在范围内的上界，供 SQL 范围查询使用；例如 "ab" 得到 "ac"。空前缀或全由最大码点组成时没有有限上界，返回 undefined；不会修改输入。 */
/**
 * 计算“所有以 prefix 开头的字符串”的最小上界（开区间端点）：输入已规范化的前缀，返回 string 或 undefined。
 * 无副作用、不抛错。流程：按码点拆开，从末位尝试加一；末位是 U+10FFFF 时丢弃并向左进位；
 * 跳过代理项空洞（U+D7FF 的下一个码点是 U+E000）。空前缀或全部码点都是 U+10FFFF 时没有有限上界。
 * 调用方（sql.ts）据此生成 `column >= prefix AND column < upper`，避免 LIKE 的转义与大小写问题。
 * 示例：prefixUpperBound("a/") === "a0"；prefixUpperBound("") === undefined。
 */
export function prefixUpperBound(prefix: string): string | undefined {
	// 字符串展开遵循码点迭代器，表情等补充平面字符在数组中占一项。
	const points = [...prefix];
	// 从末尾尝试加一；最大码点需要向更左的一位进位。
	while (points.length > 0) {
		// pop 删除最后一项；两处 ! 是 TypeScript 非空断言，循环条件和非空码点字符串保证此处有值，不是运行时校验。
		const last = points.pop()!.codePointAt(0)!;
		// 该位无法增大，舍去后继续找左侧可增加的一位。
		if (last === 0x10ffff) continue;
		// The surrogates are no code points of well-formed text: after U+D7FF comes U+E000.
		const next = last === 0xd7ff ? 0xe000 : last + 1;
		// 保留左侧前缀并附上增大的码点；右侧已被舍去，得到最小可用上界。
		return points.join("") + String.fromCodePoint(next);
	}
	// 原本为空，或所有位都进位失败；调用者据此只生成下界条件。
	return undefined;
}
