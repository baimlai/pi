// 用固定文本区分流式参数预览与工具结束后的完整解析；只做字符串/对象运算，不发模型请求。
// Vitest登记分组和用例，expect断言实际结果。
import { describe, expect, it } from "vitest";
// 导入真实解析函数：parseStreamingJson可保留不完整前缀；parseToolCallArguments结束时只接收完整对象或返回错误。
import { parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.ts";

// 登记三个流式预览回归例；String.raw保留反斜杠供解析器处理，不能把这些输入当已通过工具schema验证的数据。
describe("parseStreamingJson", () => {
	// #10868
	// 回归#10868：不合法Unicode转义应作为字面反斜杠文字保留，修复一个字段时也不丢掉其余字段。每例无外部副作用。
	it("keeps invalid \\u escapes as literal text without dropping fields", () => {
		// String.raw标签模板把反斜杠u原样传给解析器；右侧普通字符串用双反斜杠表示一个真实反斜杠。这里url不是四位十六进制Unicode转义。
		expect(parseStreamingJson(String.raw`{"text":"\url{x}"}`)).toEqual({ text: "\\url{x}" });
		// 同样输入LaTeX命令，同时检查path/content/mode整对象，避免只保住坏转义之前的前缀。
		expect(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`)).toEqual({
			// path应保留输入文件名。
			path: "a.tex",
			// content应包含字面反斜杠usepackage，而不是被当非法Unicode转义丢掉。
			content: "\\usepackage{x}",
			// 坏转义后面的mode字段也必须存在。
			mode: "w",
		});
	});

	// 合法与非法转义同时出现时分别处理：合法四位Unicode解码，非法url保留原文字。只断言这一固定组合。
	it("decodes valid \\u escapes", () => {
		// raw模板中的u00e9经JSON解析变成é，url前的反斜杠则保留；并非把所有反斜杠一律加倍展示。
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`)).toEqual({ text: "café \\url" });
	});

	// 检查流尚未结束且Unicode转义只到u00的情况，预览应保留已完成文本ab，暂不展示残缺转义。此行为不能用于推断最终参数完整。
	it("omits a \\u escape that is cut off mid-stream", () => {
		// 输入刻意没有收尾双引号/右花括号；partial-json部分字符串路径能舍弃截断的转义，结果只预览text:ab。
		expect(parseStreamingJson(String.raw`{"text":"ab\u00`)).toEqual({ text: "ab" });
	});
});

// #10897
// 完整参数解析分组：返回对象含arguments，失败另带argumentsError；{}占位必须配合后续验证检查错误标记。
describe("parseToolCallArguments", () => {
	// 完整对象中的无效字符串转义允许有限修复，不属于缺结构的JSON；例seek调用保留note反斜杠url。
	it("parses complete JSON and repairs invalid escapes", () => {
		// 把完整raw JSON交给真实结束解析函数，并比较返回包装对象。
		expect(parseToolCallArguments(String.raw`{"kind":"seek","note":"\url"}`)).toEqual({
			// 成功时只需arguments字段；kind和字面反斜杠note都保留，具体工具schema仍未在此检查。
			arguments: { kind: "seek", note: "\\url" },
		});
	});

	// 空文本按本入口约定视为空参数；本例只传空串，不覆盖undefined/空白等全部分支。
	it("uses empty arguments for empty text", () => {
		// 预期返回arguments空对象；真实成功分支省略argumentsError，但toEqual本身不会区分省略字段与值为undefined的对象键。
		expect(parseToolCallArguments("")).toEqual({ arguments: {} });
	});

	// 回归#10897：JSON中间出现坏数字不能仅返回已成功读到的action前缀；完整调用必须记录错误。
	it("does not keep the valid prefix of malformed JSON", () => {
		// JSON数字.5缺少整数部分，尽管JS数字字面量可写.5，标准JSON必须写0.5。此处故意保留非法文本。
		const raw = '{"action":"apply","actions":[{"kind":"seek","time":.5}]}';
		// 保存解析返回值；结束解析函数捕获错误，不让JSON语法异常直接逃出。
		const result = parseToolCallArguments(raw);
		// 失败参数统一为空对象，不保留action/apply或已解析actions片段。
		expect(result.arguments).toEqual({});
		// 正则只检查错误中含两次换行与Received arguments分隔文字，不固定Node生成的SyntaxError完整文案。
		expect(result.argumentsError).toMatch(/\n\nReceived arguments:\n/);
		// 可选链在错误字段缺失时会得到undefined而断言失败；endsWith要求原输入完整出现在消息末尾。
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	// 检查尚未收尾的调用不能像流式预览那样补齐文本；输入与输出只在内存中。
	it("does not complete cut-off JSON", () => {
		// clipId字符串和根对象均缺少结束符，不能作为完整工具调用的合法参数。
		const raw = '{"kind":"seek","clipId":"clip-fl';
		// 调用结束解析入口，而不是上面允许残缺内容的流式预览入口。
		const result = parseToolCallArguments(raw);
		// 应返回空arguments，而不是kind加截断clipId的部分对象。
		expect(result.arguments).toEqual({});
		// 错误末尾必须保留完整残缺原文，便于上游报告；这里不约束错误前缀的具体语法措辞。
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	// 顶层数组虽是合法JSON，也不符合工具参数必须是对象的入口约定。此例只覆盖数组，不是所有原始值都各测一遍。
	it("rejects JSON that is not an object", () => {
		// 完整解析数组后由顶层形状检查拒绝，深比较错误包装。
		expect(parseToolCallArguments("[1,2]")).toEqual({
			// 错误返回仍带空对象占位，后续应依据错误字段拒绝执行。
			arguments: {},
			// 明确说明必须是JSON对象，并按固定分隔保留原数组文本；此处toEqual比较完整字符串。
			argumentsError: "Tool arguments must be a JSON object\n\nReceived arguments:\n[1,2]",
		});
	});
});
