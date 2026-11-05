// 用固定样本和程序生成的短字符串核对 ANSI 清理；这里只处理内存字符串，不向终端发送控制码。
import { describe, expect, it } from "vitest";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../src/utils/ansi.ts";

// 无参数，创建旧版 chalk 风格的参考正则并返回 RegExp；不调用外部包，也不修改输入。
// 例：ESC[31m 会被 CSI 分支匹配。它是兼容性比较基线，不代表完整终端协议规范。
function referenceAnsiRegex(): RegExp {
	// 字符串中的双反斜杠留给 RegExp 再解释；三个选项分别是 BEL、ESC 加反斜杠、8 位 ST。
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	// 模板插值拼入结束规则；非贪婪 [\s\S]*? 允许 OSC 内容跨行并尽早结束。
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
	// 固定 CSI 字符规则保留旧行为，后面的独立回归用例另外检查新版修复的边界。
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
	// | 表示二选一，g 让 replace 删除全部匹配，而非只删除第一段颜色码。
	return new RegExp(`${osc}|${csi}`, "g");
}

// 模块加载时只构造一次参考正则，后续字符串替换共用它。
const referenceRegex = referenceAnsiRegex();

// 输入文字，按参考规则删完整控制序列并返回新串；无 I/O，普通文字原值返回。
// 例：aESC[31mb 得到 ab；这里没有 stripAnsi 的非字符串校验，错误测试不走此参考函数。
function referenceStripAnsi(value: string): string {
	// && 要求两种引导符都不存在；! 把 includes 的结果取反。
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		// 无需运行正则的快路径。
		return value;
	}
	// 删除参考正则识别的所有片段，未识别的序列仍会保留。
	return value.replace(referenceRegex, "");
}

// 无参数，返回固定样本加有限组合形成的 string[]；只修改本次新建的数组，不生成随机输入。
// 例：char 为 a 时加入 xESCay、xCSIay，再每隔三个候选字符生成双字符后缀；这不是穷举全部 ANSI。
function getCompatibilityInputs(): string[] {
	// 覆盖普通字、颜色、超链接、未结束 OSC、DCS/APC 等候选形式和若干裸 ESC 序列。
	const inputs = [
		"plain",
		"a\x1b[31mred\x1b[0mz",
		"a\x1b]8;;https://example.com\x07link\x1b]8;;\x07z",
		"a\x1b]unterminated",
		"a\x1b]funterminated",
		"a\x1bPabc\x1b\\z",
		"a\x1b^abc\x07z",
		"a\x1b_abc\x9cz",
		"a\x90abc\x9cz",
		"a\x9dabc\x9cz",
		"a\x9b31mred",
		"a\x1b(0x",
		"a\x1b*0x",
		"a\x1b+c",
		"a\x1b/0x",
		"a\x1bcok",
		"a\x1b\\ok",
	];
	// 候选表混合普通字符、参数标点和控制字节；每项是一个 JS 字符串。
	const chars = [
		"a",
		"f",
		"0",
		"1",
		";",
		":",
		"[",
		"]",
		"(",
		")",
		"#",
		"?",
		"m",
		"P",
		"_",
		"\\",
		"\x07",
		"\x1b",
		"\x9b",
		"\x9c",
		"\x90",
		"\x9d",
	];

	// for...of 逐一取值；const 只约束每轮的绑定，不冻结数组。
	for (const char of chars) {
		// 给 ESC 后接一个候选字符，外侧 x/y 让正文被误吞时也能发现。
		inputs.push(`x\x1b${char}y`);
		// 同一候选再用于 8 位 CSI 引导符。
		inputs.push(`x\x9b${char}y`);
		// index += 3 是稀疏取样，不是遍历候选表的每个两字符组合。
		for (let index = 0; index < chars.length; index += 3) {
			// 下标取第二个候选，push 原地追加构造的字符串。
			inputs.push(`x\x1b${char}${chars[index]}y`);
		}
	}

	// 返回全部固定和组合样本供测试循环使用。
	return inputs;
}

// describe 的回调注册测试；expect 失败会由 Vitest 报告，不是应用自身的运行时校验。
describe("stripAnsi", () => {
	// 无参数测试回调逐样本比较新版和本文件参考实现，无外部副作用。
	it("matches chalk strip-ansi for generated compatibility inputs", () => {
		// 每个 input 都来自上面的有限样本生成器。
		for (const input of getCompatibilityInputs()) {
			// toBe 比较最终字符串值；标题中的 chalk 实际指本地参考规则，没有导入 chalk。
			expect(stripAnsi(input)).toBe(referenceStripAnsi(input));
		}
	});

	// 故意绕过静态 string 参数限制，验证错误类别和错误文字；每个值被独立调用两次。
	it("throws the same TypeError as chalk strip-ansi for non-string values", () => {
		// as 只向 TS 声明可接收 unknown，不改变 stripAnsi 的真实代码或自动转换参数。
		const stripAnsiUnknown = stripAnsi as (value: unknown) => string;

		// 包含基本值、普通对象和装箱字符串对象；Object("x") 的 typeof 仍是 object。
		for (const value of [undefined, null, 123, {}, Object("x")]) {
			// 模板中的 typeof 得到各输入的运行时类型名称。
			const message = `Expected a \`string\`, got \`${typeof value}\``;
			// 传箭头函数给 expect，才能让 toThrow 捕获调用时的异常。
			expect(() => stripAnsiUnknown(value)).toThrow(TypeError);
			// 第二次调用单独核对异常消息；没有证明它与首次调用是同一个 Error 对象。
			expect(() => stripAnsiUnknown(value)).toThrow(message);
		}
	});

	// 例：ESC c 是完整 RIS，c 不应泄漏到保留的 done 前面。
	it("strips RIS without leaking the final byte", () => {
		expect(stripAnsi("\x1bcdone")).toBe("done");
	});

	// 遍历两个字母区间，检查完整 ESC 序列被清除而普通后缀 ok 保留。
	it("strips single-byte ESC sequences without leaking final bytes", () => {
		// charCodeAt 得到字符码，code++ 每轮加一，端点 m 也在测试内。
		for (let code = "g".charCodeAt(0); code <= "m".charCodeAt(0); code++) {
			// fromCharCode 把计数器还原成字母，再与 ESC 和正文拼接。
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
		// 第二个闭区间是 r、s、t；不推论其他单字节序列都受支持。
		for (let code = "r".charCodeAt(0); code <= "t".charCodeAt(0); code++) {
			// 同样只断言此组合的清理结果。
			expect(stripAnsi(`\x1b${String.fromCharCode(code)}ok`)).toBe("ok");
		}
	});

	// 混合彩色文字和 OSC 超链接，核对控制部分消失、可见标签仍在原顺序。
	it("strips common ANSI sequences used in tool output", () => {
		// \x1b 是 ESC，\x07 是 BEL；URL 只是字符串，测试不会访问链接。
		const input = "a\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07z";
		// a/red/link/z 拼成最终可见内容。
		expect(stripAnsi(input)).toBe("aredlinkz");
	});

	// https://github.com/earendil-works/pi/issues/11377
	// 检查真正 CSI 引导符后的私有参数前缀；每条断言是独立的回归样本。
	it("strips private-parameter CSI sequences with their parameters", () => {
		// 鼠标报告的 < 和坐标参数必须连同末尾 M 一并删掉。
		expect(stripAnsi("\x1b[<35;59;1Mstep 1")).toBe("step 1");
		// 同样覆盖小写最终字符 m。
		expect(stripAnsi("a\x1b[<0;10;20mb")).toBe("ab");
		// > 前缀带多段数字的设备属性报告。
		expect(stripAnsi("a\x1b[>0;276;0cb")).toBe("ab");
		// 私有前缀后没有数字也可构成完整序列。
		expect(stripAnsi("a\x1b[>cb")).toBe("ab");
		// = 前缀与 h 最终字节的组合。
		expect(stripAnsi("a\x1b[=5hb")).toBe("ab");
		// 8 位 CSI 不需要 ESC 加 [ 两字符引导符。
		expect(stripAnsi("a\x9b<35;59;1Mb")).toBe("ab");
	});

	// https://github.com/earendil-works/pi/issues/11377
	// 裸 ESC 后的 =、>、< 自身结束序列，后面的数字属于正文，不能当参数吞掉。
	it("keeps digits after bare ESC keypad-mode sequences", () => {
		// 先去应用光标键模式，再去 ESC=，保留数字 123。
		expect(stripAnsi("\x1b[?1h\x1b=123 tests passed")).toBe("123 tests passed");
		// 相反模式及 ESC> 仍应保留 42。
		expect(stripAnsi("\x1b[?1l\x1b>42 files")).toBe("42 files");
		// < 在裸 ESC 分支同样不吃后面的 10。
		expect(stripAnsi("\x1b<10 items")).toBe("10 items");
	});
});

// 此组只验证内存拆分，不实际把下一块流数据拼回或驱动终端。
describe("splitIncompleteAnsiSuffix", () => {
	// https://github.com/earendil-works/pi/issues/11377
	// 输入末尾半条 CSI，预期保留到 pending；完整裸 ESC= 则应立即放行。
	it("holds back unfinished private-parameter CSI sequences", () => {
		// toEqual 深比较对象字段；前缀 x 可输出，未完参数等待下一块。
		expect(splitIncompleteAnsiSuffix("x\x1b[<35;59")).toEqual({ complete: "x", pending: "\x1b[<35;59" });
		// 此处 = 已结束 ESC 序列，所以 pending 是空串。
		expect(splitIncompleteAnsiSuffix("x\x1b=")).toEqual({ complete: "x\x1b=", pending: "" });
	});
});
