/*
 * Portions of this file are derived from:
 * - ansi-regex (https://github.com/chalk/ansi-regex)
 * - strip-ansi (https://github.com/chalk/strip-ansi)
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// 清理工具输出中的常见ANSI序列，并帮流式Bash输出暂存末尾半条序列；这是适配后的源码，以上衍生来源与MIT许可保持原样。
// 此处处理特定正则能识别的控制序列，不是覆盖全部终端协议的安全净化器，例如APC等不在完整OSC规则内。
// Valid string terminator sequences are BEL, ESC\, and 0x9c
// 正则片段保存为字符串，双反斜杠让RegExp构造器最终收到\u转义；(?:...)只分组、不产生捕获编号。
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

// OSC sequences: ESC ] ... ST
// OSC以ESC和]开始，例如终端超链接；后面完整正则负责找到结束符。
const OSC_START = "\\u001B\\]";

// CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :), then final byte.
// A private prefix (<, =, >) is accepted only right after a real CSI introducer (ESC [ or 0x9B), so
// ESC[<35;59;1M (SGR mouse report) is stripped whole. After a bare ESC these bytes stay final bytes:
// ESC = and ESC > (keypad modes) must not swallow the digits of the text that follows.
// 两条分支分别处理真实CSI后的私有前缀、普通ESC/CSI形式；参数段允许分号和冒号，每段数字长度由正则限定。
const CSI_START = "(?:(?:\\u001B\\[|\\u009B)[<=>]|[\\u001B\\u009B][[\\]()#;?]*)(?:\\d{1,4}(?:[;:]\\d{0,4})*)?";
// 字符类列出本实现接受的最终字符；<、=、>既可在CSI前缀处出现，也可结束裸ESC序列。
const CSI_FINAL = "[\\dA-PR-TZcf-nq-uy=><~]";

// Complete sequences. OSC is non-greedy until the first ST.
// 模板插值组合片段，g使replace处理全部匹配；[\s\S]*?跨换行并尽早结束OSC，避免吞掉之后正文。
const ansiRegex = new RegExp(`(?:${OSC_START}[\\s\\S]*?${ST})|${CSI_START}${CSI_FINAL}`, "g");

// Unfinished sequence at the end of the text: OSC without its ST (a trailing ESC may start ESC\),
// or CSI without its final byte.
// 此正则无m标志，$只匹配输入末尾；负向前瞻(?!...)避开已构成ESC反斜杠的结束符，OSC正文自身仍可包含换行。
const unfinishedAnsiAtEndRegex = new RegExp(
	`(?:${OSC_START}(?:[^\\u0007\\u009C\\u001B]|\\u001B(?!\\\\))*|${CSI_START})$`,
);

// Longest unfinished sequence held back while streaming. Longer ones are processed as-is.
// 这是JS字符串的256个UTF-16码元窗口，不是256字节；只在末尾窗口识别半条序列，不缓存整段无限OSC。
const MAX_PENDING_ANSI_LENGTH = 256;

/**
 * Split streamed text into a part that is safe to pass to stripAnsi now and a trailing
 * unfinished escape sequence that should be prepended to the next chunk.
 */
// 输入本次文本（调用方已把上次pending拼在前面），返回可立即清理的complete和留待下次的pending；不修改外部状态。
// 例如"正文ESC[31"拆成正文和ESC[31，下一块"m红字"拼回后再stripAnsi；没有匹配就全部放行，不保证任意长半序列都暂存。
export function splitIncompleteAnsiSuffix(value: string): { complete: string; pending: string } {
	// 普通文字快路径；只找7位ESC或8位CSI引导符，不为无相关字符的字符串运行正则。
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return { complete: value, pending: "" };
	}
	// Math.max防止短文本产生负索引，只扫描最后最多256码元。
	const windowStart = Math.max(0, value.length - MAX_PENDING_ANSI_LENGTH);
	// 此正则没有g，exec返回匹配对象或null，match.index相对于slice后的窗口。
	const match = unfinishedAnsiAtEndRegex.exec(value.slice(windowStart));
	// 找不到本规则认识的未完成后缀时，调用方可继续清理整串。
	if (!match) {
		return { complete: value, pending: "" };
	}
	// 窗口内索引加窗口起点，换回原字符串位置。
	const splitAt = windowStart + match.index;
	// slice不改原串，前半不含待拼接后缀，后半由调用方保存。
	return { complete: value.slice(0, splitAt), pending: value.slice(splitAt) };
}

// 输入字符串，删除完整正则匹配的ANSI序列并返回新字符串；无I/O，不把所有控制字符都删除。
// 例如ESC[31m红ESC[0m得到红；TypeScript声明string只约束开发期，现有运行时检查仍会对JS等调用传入的非字符串抛TypeError。
export function stripAnsi(value: string): string {
	// 保留原接口的运行时类型报错行为，不尝试String(value)自动转换。
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	// Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
	// 无引导符直接复用原字符串值，减少工具输出普通文本的正则工作。
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}

	// Even though the regex is global, we don't need to reset the `.lastIndex`
	// because unlike `.exec()` and `.test()`, `.replace()` does it automatically
	// and doing it manually has a performance penalty.
	// 替换匹配为""；这里只删除完整匹配，末尾半条序列的跨块拼接由上面的函数及调用方负责。
	return value.replace(ansiRegex, "");
}
