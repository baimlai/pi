// 验证每owner代码高亮缓存及工具展示重绘复用；TUI只用空requestRender桩，不接真实终端/执行工具。
// TUI类型import会擦除，下面对象断言只是开发期视图，并没构造完整UI。
import type { TUI } from "@earendil-works/pi-tui";
// Vitest的spy观察真实函数调用，假timer只推进本进程模拟时间；钩子恢复mock/计时器。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 真实write工具展示器，只展示传入内容，不执行写文件工具。
import { writeRenderers } from "../src/core/tools/renderers/write.ts";
// 真实codemode展示器，只显示脚本文字/调用详情，不运行脚本。
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
// 工具行组件负责进度/展开/渲染及其高亮缓存。
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
// 真实高亮器/普通高亮函数/主题初始化，initTheme默认不watch。
import { CodeHighlighter, highlightCode, initTheme } from "../src/modes/interactive/theme/theme.ts";
// 命名空间导入便于spyOn highlight；本地语言扩展加载不走网络。
import * as syntaxHighlight from "../src/utils/syntax-highlight.ts";

// 唯一桩方法无操作；as unknown as TUI绕过结构检查，不给缺失字段自动造实现。
const tui = { requestRender: () => {} } as unknown as TUI;

// 三例覆盖直接缓存、codemode进度和write局部改动，不证明所有renderer缓存路径。
describe("CodeHighlighter", () => {
	// 每例先设内置dark全局Theme，必要时读取固定JSON缓存，默认不开文件监听。
	beforeEach(() => initTheme("dark"));
	// 每例后恢复spy和计时器；不会卸载已注册语言或恢复此前全局主题。
	afterEach(() => {
		// 让被spy的方法恢复原实现。
		vi.restoreAllMocks();
		// 把假计时器恢复到真实实现，不是推进所有待排timer。
		vi.useRealTimers();
	});

	// 先复用同结果引用，再变代码/主题/注册语法；async允许等待本地语言加载。
	it("reuses its last result until the code, the theme or the grammars change", async () => {
		// 固定JS模板中的HTML只作为高亮输入，不执行html标签函数或DOM。
		const code = 'const page = html`<div class="x">ok</div>`;';
		// 每实例只持有最近一次结果。
		const highlighter = new CodeHighlighter();
		// 首次真实高亮JS，保存数组引用。
		const first = highlighter.highlight(code, "javascript");
		// toBe要求同一个数组，证明此键下直接复用。
		expect(highlighter.highlight(code, "javascript")).toBe(first);
		// 改代码必须生成不同引用，不要求内容必不同。
		expect(highlighter.highlight("const a = 1;", "javascript")).not.toBe(first);

		// 切到内置light的新Theme实例，不改代码。
		initTheme("light");
		// toEqual比较light下高亮内容与直接高亮一致，未直接断言数组引用换了。
		expect(highlighter.highlight(code, "javascript")).toEqual(highlightCode(code, "javascript"));
		// 保存此次light结果，后面作内容比较。
		const light = highlighter.highlight(code, "javascript");
		// 只加载依赖里的其余语法并注册到本进程，无远程下载；此注册不会由afterEach撤回。
		await syntaxHighlight.loadAllHighlightLanguages();
		// 嵌HTML的样本在语法增加后内容改变；用not.toEqual，不单测引用失效。
		expect(highlighter.highlight(code, "javascript")).not.toEqual(light);
	});

	// 同一codemode行从开始到进度/tick/展开/完成，spy计数应只高亮一次；不执行tools.read。
	it("codemode highlights the script once across progress, timer ticks, expanding and completion", () => {
		// 虚拟时钟接管后面组件进度timer，无需真实等2秒。
		vi.useFakeTimers();
		// spy默认仍调用真实highlight，不是伪造高亮结果。
		const highlight = vi.spyOn(syntaxHighlight, "highlight");
		// 仅构造工具展示行，传入下方固定参数/renderer/桩UI。
		const row = new ToolExecutionComponent(
			// 工具名选codemode展示行为。
			"codemode",
			// 固定toolCallId为c。
			"c",
			// code是待展示字符串，await不在测试函数里执行。
			{ code: "await tools.read({});" },
			// 空配置对象，非真实环境或登录配置。
			{},
			// 传具体renderer使组件用codemode展示。
			codemodeRenderers,
			// 用无I/O requestRender桩。
			tui,
			// cwd文字给展示上下文，不在/创建文件。
			"/",
		);
		// 标记参数收齐，组件可按完整脚本展示。
		row.setArgsComplete();
		// 进入执行中显示状态，仅状态/计时，不启动模型或工具。
		row.markExecutionStarted();
		// 手工注入空调用列表的进度结果，true表示部分结果。
		row.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
		// 推进假时间2,000ms以触发进度相关调度。
		vi.advanceTimersByTime(2_000);
		// 展开本行再看高亮是否重复。
		row.setExpanded(true);
		// 注入完成结果done，false表示不再是部分进度。
		row.updateResult({ content: [{ type: "text", text: "done" }], details: { calls: [] }, isError: false }, false);
		// 以80列计算展示行，未输出到真实屏幕。
		row.render(80);
		// 从spy安装起累计一次，断言次数而非耗时/像素完全正确。
		expect(highlight).toHaveBeenCalledTimes(1);
	});

	// 造60行write内容，先局部改末行再标完整，检查高亮次数；实际不写a.ts。
	it("write highlights unchanged first lines and a complete file only once", () => {
		// Array.from按length生成模板行，_忽略元素值、i是索引，join合成代码文字。
		const content = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
		// path/cwd仅传展示组件，renderer不能据此当本例执行了文件写入。
		const row = new ToolExecutionComponent("write", "w", { path: "a.ts", content }, {}, writeRenderers, tui, "/");
		// 先追加两个斜杠模拟末行参数仍在流入。
		row.updateArgs({ path: "a.ts", content: `${content} //` });
		// 渲染一次建立初始缓存。
		row.render(80);
		// 此时才装spy，所以前面初始高亮不计入后面的次数。
		const highlight = vi.spyOn(syntaxHighlight, "highlight");
		// Only the changed last line is highlighted again.
		// 只改最后行的注释文字，其余前缀不变。
		row.updateArgs({ path: "a.ts", content: `${content} // more` });
		// 再次渲染触发局部增量高亮。
		row.render(80);
		// 自spy起应只重高亮改过的末行一次。
		expect(highlight).toHaveBeenCalledTimes(1);

		// 参数结束后可对完整文件建立结果。
		row.setArgsComplete();
		// 先展开看全部代码。
		row.setExpanded(true);
		// 再收回，仍应复用完整缓存。
		row.setExpanded(false);
		// 又一次80列渲染，不执行写工具。
		row.render(80);
		// 累积次数为2，即末行局部一次和完整文件一次；不是整个例子总共只2次。
		expect(highlight).toHaveBeenCalledTimes(2);
	});
});
