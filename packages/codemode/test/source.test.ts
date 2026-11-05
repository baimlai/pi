// 只测试输入文字的配置拆分，不执行其中 JavaScript；toThrow 接收函数，避免在 expect 调用前就抛出异常。
import { describe, expect, it } from "vitest";
import { CodemodeSourceError, parseCodemodeSource } from "../src/source.ts";

// describe 的回调只登记下面的测试；每个 it 的回调在测试执行时才运行。
describe("parseCodemodeSource", () => {
	/** 输入普通脚本和注释脚本，逐字比较 code 与空 options；例 text(hi) 不被 trim 或改写。无 VM 或外部副作用。 */
	it("returns plain code unchanged", () => {
		// toEqual 深比较对象字段；普通正文原样返回，不自动添加默认配置。
		expect(parseCodemodeSource("text('hi')")).toEqual({ code: "text('hi')", options: {} });
		// 转义的 \n 是传入文本里的换行，期望 code 连原注释也完整保留。
		expect(parseCodemodeSource("// just a comment\nreturn 1")).toEqual({
			code: "// just a comment\nreturn 1",
			options: {},
		});
	});

	/** 输入首行 JSON 配置及 LF/CRLF 正文，检查字段换成驼峰并保留空首行。例 timeout_ms:10 变 timeoutMs:10；只解析，不启动计时器。 */
	it("parses the options line and keeps line numbers", () => {
		// 首行配置被移除但 LF 留下，所以正文 const 仍在第二行，方便对应错误行号。
		expect(parseCodemodeSource('// @options: {"timeout_ms": 10}\nconst a = 1;\ntext(a)')).toEqual({
			code: "\nconst a = 1;\ntext(a)",
			options: { timeoutMs: 10 },
		});
		// 缩进和冒号后的空白可省；预算 0 有效，两个字段独立映射，不填其他默认值。
		expect(parseCodemodeSource('  // @options:{"max_output_tokens":0,"timeout_ms":1500}\r\ntext(1)').options).toEqual(
			{
				maxOutputTokens: 0,
				timeoutMs: 1500,
			},
		);
		// 合法空对象不同于没有 JSON 文字，解析成功且保留空首行。
		expect(parseCodemodeSource("// @options: {}\ntext(1)")).toEqual({ code: "\ntext(1)", options: {} });
	});

	/** 输入相似前缀和正文中的字符串，确认不误认为首行配置；这里只覆盖这两种文字形式，不是完整 JS 语法分析。 */
	it("only treats the first line as an options line", () => {
		// optionsx 不含确切前缀 // @options:，所以按普通正文处理。
		expect(parseCodemodeSource("// @optionsx {}\ntext(1)").options).toEqual({});
		// 整行以 text 开头，字符串内部出现配置标记也不算首行配置。
		expect(parseCodemodeSource('text("// @options: {}")').options).toEqual({});
	});

	// #10631: an options line after the first line used to be ignored, so its timeout never applied.
	/** 遍历配置行位于第二/三行的输入，检查专用错误类和可读行号。例开头空行也不允许；输入里的死循环从未执行。 */
	it("rejects an options line that is not the first line", () => {
		// 元组数组每项依次为输入和预期行号；[string,number] 的位置类型由 TS 检查。
		const cases: [string, number][] = [
			['// count things\n// @options: {"timeout_ms": 1000}\nwhile (true) {}', 2],
			['\n  // @options: {"timeout_ms": 1000}\nwhile (true) {}', 2],
			['text(1)\r\n// @options: {"timeout_ms": 1}', 2],
			['// @options: {"timeout_ms": 1}\ntext(1)\n// @options: {"timeout_ms": 2}', 3],
		];
		// for...of 取每个元组并解构；行号是从 1 开始的人类读法。
		for (const [input, line] of cases) {
			// 箭头函数推迟解析；第二参数把当前输入作为断言失败时的上下文，断言专用错误类别。
			expect(() => parseCodemodeSource(input), input).toThrow(CodemodeSourceError);
			// 再核对同一次输入的具体报错文字，而不只判断“抛了任意异常”。
			expect(() => parseCodemodeSource(input), input).toThrow(
				// 模板插值放入当前用例的预期行号，不执行输入正文。
				`The // @options: line must be the first line of the input; found one on line ${line}`,
			);
		}
	});

	/** 逐例输入空白、坏 JSON、非对象、未知字段和非法数值，检查错误类型与消息；例 timeout_ms:0 被拒绝，脚本正文不执行。 */
	it("rejects empty input and invalid options", () => {
		// 第二格允许字符串或正则：字符串检查包含消息，正则匹配消息形状。每项第一格仍是输入文字。
		const cases: [string, string | RegExp][] = [
			["", /Expected JavaScript source text \(non-empty\)/],
			["  \n", /Expected JavaScript source text \(non-empty\)/],
			["// @options:\ntext(1)", /@options must be a JSON object with supported fields/],
			["// @options: {timeout_ms: 1}\ntext(1)", /@options must be valid JSON with supported fields/],
			["// @options: [1]\ntext(1)", /@options must be a JSON object with supported fields/],
			[
				'// @options: {"yield": 1}\ntext(1)',
				"@options only supports `max_output_tokens` and `timeout_ms`; got `yield`",
			],
			[
				'// @options: {"max_output_tokens": 1.5}\ntext(1)',
				"@options field `max_output_tokens` must be a non-negative safe integer",
			],
			['// @options: {"timeout_ms": 0}\ntext(1)', /@options field `timeout_ms` must be a positive integer/],
			[
				'// @options: {"timeout_ms": 1}',
				"The @options line must be followed by JavaScript source on subsequent lines",
			],
			[
				'// @options: {"timeout_ms": 1}\n  \n',
				"The @options line must be followed by JavaScript source on subsequent lines",
			],
		];
		// 逐项独立解析，任何错误用例意外成功都会使其 toThrow 失败。
		for (const [input, message] of cases) {
			// 箭头函数推迟解析；第二参数把当前输入作为断言失败时的上下文，断言专用错误类别。
			expect(() => parseCodemodeSource(input), input).toThrow(CodemodeSourceError);
			// 匹配本例列出的原因；这组样例没有穷举所有数字边界或所有 JSON Schema 规则。
			expect(() => parseCodemodeSource(input), input).toThrow(message);
		}
	});
});
