// 通过临时替换平台标识，检查文件资源去重键与合成标识的大小写规则；不会创建或加载扩展文件。
import { afterEach, describe, expect, it } from "vitest";
import { getResourcePathKey } from "../src/core/source-info.ts";

// 登记资源路径键的用例，并保存本进程原来的属性描述符。
describe("getResourcePathKey", () => {
	// 描述符包含value/writable/configurable等；恢复它可还原属性本身的约束。
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

	// 每例之后恢复真实平台，即使断言失败也交由Vitest运行；没有描述符时不定义新值。
	afterEach(() => {
		// if先缩小可选描述符类型，defineProperty随后按原设置恢复。
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/10488
	// 无输入；模拟win32并比较几个固定字符串。例如两个盘符大小写不同路径应同键，builtin:MCP保持大小写；不覆盖符号链接存在时的真实路径解析。
	it("folds file path casing on Windows but keeps synthetic identifiers unchanged", () => {
		// 只改JavaScript可见的平台字段，不将当前操作系统变成Windows。
		Object.defineProperty(process, "platform", { value: "win32" });
		// 双反斜杠是字符串转义，运行时路径里每处只有一个反斜杠。
		expect(getResourcePathKey("C:\\Users\\Me\\ext.ts")).toBe(getResourcePathKey("c:\\users\\me\\ext.ts"));
		// builtin:属于合成前缀，原样返回而不是按文件路径小写化。
		expect(getResourcePathKey("builtin:MCP")).toBe("builtin:MCP");
		// not.toBe明确区分两个大小写不同的合成身份。
		expect(getResourcePathKey("builtin:MCP")).not.toBe(getResourcePathKey("builtin:mcp"));
		// 尖括号内联标识同样绕过文件规范化。
		expect(getResourcePathKey("<inline:Name>")).toBe("<inline:Name>");
	});
});
