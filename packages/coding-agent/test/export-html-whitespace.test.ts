// 验证HTML导出保留工具文字空白、ANSI行间不插源码空白、首尾TUI间隔行被裁掉；只读CSS与内存组件，无真实终端或工具执行。
// import type只引入Component编译期接口，不在运行时加载该名字。
import type { Component } from "@earendil-works/pi-tui";
// 同步读取实际CSS文件，fs是Node内置模块的另一种specifier写法。
import { readFileSync } from "fs";
// 导入测试分组、用例和断言；这些回调由Vitest调度。
import { describe, expect, it } from "vitest";
// 导入实际ANSI行转HTML函数，不用模拟转换结果来替代实现。
import { ansiLinesToHtml } from "../src/core/export-html/ansi-to-html.ts";
// 导入实际工具展示适配器；它调用renderResult展示回调，不执行工具execute。
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
// 类型导入只约束下面夹具的声明，断言as不会自动补全缺少的运行时字段。
import type { ToolDefinition } from "../src/core/extensions/types.ts";
// Theme也只作编译期类型，空对象断言不是创建真实主题。
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

// 三项测试共享一个主题分组，但各自构造输入和断言。
describe("export HTML tool output whitespace", () => {
	// 第一例读CSS检查选择器与空白声明；是文本约束，不是启动浏览器计算最终样式。
	it("preserves whitespace for plain-text tool output lines without preserving template whitespace", () => {
		// new URL相对当前模块的import.meta.url解析资源，不依赖命令行cwd；readFileSync以UTF8解码文本。
		const css = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

		// toMatch要求字符串匹配正则，下面检查两种展开状态的普通文字行。
		expect(css).toMatch(
			// 点和括号转义为字面符号，\s*允许换行空白，[\s\S]*?跨行找pre-wrap；未限制当前规则的闭括号，可能跨到后续规则，不严格证明声明属于同一CSS块或最终级联。
			/\.output-preview > div:not\(\.expand-hint\),\s*\.output-full > div:not\(\.expand-hint\) \{[\s\S]*?white-space:\s*pre-wrap;/,
		);
		// 要求从ansi-line选择器后找到white-space: pre文本；同样可能跨CSS块。意图是保留行内空格，最终级联还可能被更具体规则覆盖。
		expect(css).toMatch(/\.ansi-line\s*\{[\s\S]*?white-space:\s*pre;/);
		// not.toMatch排除外层预览/完整容器后跟pre-wrap的文本模式，意图避免显示模板缩进；正则仍可能跨块，不是一般CSS语义解析。
		expect(css).not.toMatch(/\.output-preview,\s*\.output-full\s*\{[\s\S]*?white-space:\s*pre-wrap;/);
	});

	// 第二例用两条纯文本行检查HTML拼接边界。
	it("does not insert source whitespace between ANSI-rendered lines", () => {
		// 精确期待两个div紧贴，中间没有新增空格或换行；toBe对字符串比较值。
		expect(ansiLinesToHtml(["one", "two"])).toBe('<div class="ansi-line">one</div><div class="ansi-line">two</div>');
	});

	// 第三例给实际渲染器一份同步内存组件，检查裁首尾空行并转换红色SGR。
	it("trims TUI spacing lines from custom tool result HTML", () => {
		// Component类型要求render/invalidate；render忽略列宽参数且每次返回新行数组，\u001b是ESC，invalidate空回调不会安排重绘。
		const component: Component = { render: () => ["", "\u001b[31mone\u001b[0m", "two", ""], invalidate: () => {} };
		// 构造仅本例需要的工具展示字段，没有实际execute实现。
		// 末尾as unknown as跨过结构兼容检查；这是夹具的静态断言，不验证对象真有ToolDefinition的全部方法。
		const tool = {
			// name提供夹具的工具标识文字。
			name: "custom",
			// label是固定展示标签，不发起工具调用。
			label: "custom",
			// description是固定说明，不在本例生成模型工具schema。
			description: "custom",
			// 箭头函数总返回同一component，不消费结果/主题/上下文，也不读取磁盘。
			renderResult: () => component,
		} as unknown as ToolDefinition;
		// 创建实际适配器，内部缓存只服务这一用例；创建时不会执行展示回调。
		const renderer = createToolHtmlRenderer({
			// 名字解析替身忽略传入名称，总返回这份tool，不验证真实注册表查找。
			getToolRenderers: () => tool,
			// 把空对象断言成Theme；夹具回调不用主题，所以此例能运行，不意味着空主题可供所有工具。
			theme: {} as Theme,
			// cwd只是传给展示上下文的数据；适配器不据此切换目录或访问该路径。
			cwd: "/tmp",
		});

		// 直接渲染固定id、空内容、缺details、非错误结果；实现先折叠后展开，?.只在结果缺失时给undefined，使下面比较失败而不是取属性抛错。
		expect(renderer.renderResult("id", "custom", [], undefined, false)?.expanded).toBe(
			// 期待首尾空行去掉、内部红色one转成span并与two紧贴；没有断言折叠字段或所有SGR颜色情况。
			'<div class="ansi-line"><span style="color:#800000">one</span></div><div class="ansi-line">two</div>',
		);
	});
});
