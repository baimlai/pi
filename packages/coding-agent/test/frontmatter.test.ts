// Frontmatter 是 Markdown 开头由 --- 围住的 YAML 元数据；本文件只解析内存文字，不加载技能或读文件。
import { describe, expect, it } from "vitest";
import { parseFrontmatter, stripFrontmatter } from "../src/utils/frontmatter.ts";

// 注册 YAML 头拆分测试；错误用例验证 YAML 解析器的报错片段，不把泛型当作运行时字段校验。
describe("parseFrontmatter", () => {
	// 输入含双引号/单引号/带横线键的文档，返回去引号的元数据和去首尾空白正文。
	it("parses keys, strips quotes, and returns body", () => {
		// \n 是字符串内换行；双引号用转义保留在 YAML 源文本里。
		const input = "---\nname: \"skill-name\"\ndescription: 'A desc'\nfoo-bar: value\n---\n\nBody text";
		// <Record<string,string>> 告诉 TS 把结果当字符串字典；解析器并未检查所有值都是 string。
		// 花括号是解构，把返回对象的两个字段分别绑定到局部常量。
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		// 简单标量去除 YAML 引号。
		expect(frontmatter.name).toBe("skill-name");
		// 单引号形式也应成为普通字符串。
		expect(frontmatter.description).toBe("A desc");
		// 含横线的键不能用点语法写成 foo-bar，方括号可按完整字符串取属性。
		expect(frontmatter["foo-bar"]).toBe("value");
		// 成对头部存在时正文 trim，因此开头空行消失。
		expect(body).toBe("Body text");
	});

	// 例：Windows CRLF 头和正文都转成 LF；只解构本例需要的 body。
	it("normalizes newlines and handles CRLF", () => {
		// \r\n 明确构造两个码元的换行形式，不依赖测试源文件使用何种换行。
		const input = "---\r\nname: test\r\n---\r\nLine one\r\nLine two";
		// 元数据仍会解析，只是本例没有取 frontmatter 字段。
		const { body } = parseFrontmatter<Record<string, string>>(input);
		// 中间换行保留，\r 消失。
		expect(body).toBe("Line one\nLine two");
	});

	// 未闭合 YAML 流式数组应抛异常；不是把错误当空元数据静默返回。
	it("throws on invalid YAML frontmatter", () => {
		// Markdown 头部标记完整，坏的是 YAML 的 [bar 没有闭合 ]。
		const input = "---\nfoo: [bar\n---\nBody";
		// 包装函数延后执行，toThrow 的正则只核对位置文字，不限定完整错误类型或消息。
		expect(() => parseFrontmatter<Record<string, string>>(input)).toThrow(/at line 1, column 10/);
	});

	// YAML | 块标量保留行分隔和末尾换行，Markdown 正文则独立 trim。
	it("parses | multiline yaml syntax", () => {
		// 两个空格缩进把 Line one/Line two 归入 description，不属于正文。
		const input = "---\ndescription: |\n  Line one\n  Line two\n---\n\nBody";
		// 泛型仅约束后续 TS 使用；此固定样本由 YAML 语法实际生成字符串。
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		// 默认块标量保留一个末尾 LF。
		expect(frontmatter.description).toBe("Line one\nLine two\n");
		// 元数据块的末尾换行不意味着正文也保留空行。
		expect(body).toBe("Body");
	});

	// 缺少开头或结束标记时整段作为正文；“原样”仍受实现的换行归一化影响。
	it("returns original content when frontmatter is missing or unterminated", () => {
		// 第一份没有 --- 头。
		const noFrontmatter = "Just text\nsecond line";
		// 第二份有开头但没有结束标记，不能丢掉疑似元数据。
		const missingEnd = "---\nname: test\nBody without terminator";
		// 各自解析，不共享结果对象。
		const resultNoFrontmatter = parseFrontmatter<Record<string, string>>(noFrontmatter);
		const resultMissingEnd = parseFrontmatter<Record<string, string>>(missingEnd);
		// 无头部的两行正文保持。
		expect(resultNoFrontmatter.body).toBe("Just text\nsecond line");
		// 期望值显式进行 CRLF/CR→LF；本样本本就只有 LF，因此这里没有额外覆盖单独 CR 的场景。
		expect(resultMissingEnd.body).toBe(
			"---\nname: test\nBody without terminator".replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
		);
	});

	// 此例实际提供“只有 YAML 注释”的头部；标题也提到空头部，但没有单独构造空头样本。
	it("returns empty object for empty or comment-only frontmatter", () => {
		// # 在 YAML 中是注释，parse 得到 nullish 值后由实现回退 {}。
		const input = "---\n# just a comment\n---\nBody";
		// 未指定泛型时默认是 Record<string,unknown>，读取值需要调用方进一步收窄。
		const { frontmatter } = parseFrontmatter(input);
		// toEqual 深比较对象内容，不要求同一个对象引用。
		expect(frontmatter).toEqual({});
	});
});

// stripFrontmatter 复用 parseFrontmatter 后只返回 body，所以解析错误仍可能向上抛出。
describe("stripFrontmatter", () => {
	// 有完整头部时删除头部，并清掉正文前后的空白；例：Body 后面的换行也被去除。
	it("removes frontmatter and trims body", () => {
		// 头部与正文之间多一个空行，正文末尾也有 LF。
		const input = "---\nkey: value\n---\n\nBody\n";
		// 只比最终字符串，不直接断言内部元数据是否解析。
		expect(stripFrontmatter(input)).toBe("Body");
	});

	// 没有头部时保留正文原有首尾空白，和有头部时的 trim 行为不同。
	it("returns body when no frontmatter present", () => {
		// 前后换行及两侧空格都是有意构造的样本内容。
		const input = "\n  No frontmatter body  \n";
		// 精确比较能防止无头部文档也被无意 trim。
		expect(stripFrontmatter(input)).toBe("\n  No frontmatter body  \n");
	});
});
