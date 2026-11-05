// 验证 Markdown 从源码到终端行的转换：列表、表格、数学、链接、样式恢复与流式缓存；断言失败会抛错交 Node 测试器记录。
// 绝大多数用例只处理字符串，少量通过内存 xterm 解释 ANSI；不访问示例网址、不接管真实终端。
// assert 的 strictEqual 比较单值，deepStrictEqual 比较数组/对象结构，ok 只检查表达式真值。
import assert from "node:assert";
// describe 注册分组、it 注册测试回调，afterEach 注册组内每个测试结束后的清理；注册时不等于立即执行所有回调。
import { afterEach, describe, it } from "node:test";
// V8 运行时接口用于后面的弱引用 GC 用例，改变当前测试进程的引擎开关。
import { setFlagsFromString } from "node:v8";
// VM 接口在新的 JavaScript 上下文中取得 gc 函数；这里执行的是固定测试代码，不是用户 Markdown。
import { runInNewContext } from "node:vm";
// type 导入只提供底层终端类型；as 重命名避免与项目自己的 Terminal 契约混淆。
import type { Terminal as XtermTerminalType } from "@xterm/headless";
// 导入可独立配置的 Chalk 构造器，用样式控制串进行确定性断言。
import { Chalk } from "chalk";
// Markdown 是运行时组件；MarkdownTheme 是编译期主题字段/函数签名，不会自动校验运行时对象。
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
// 测试可直接替换共享能力缓存，让同一输入分别走 OSC8 链接或括号地址分支。
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
// Component/TUI 仅作静态契约；声明类型不会把下面的对象变成真实终端或自动启动它。
import type { Component, TUI } from "../src/tui.ts";
// 主屏 TUI 负责调度渲染和写入，后面给它传的是 VirtualTerminal。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 共享主题用本地 Chalk 包装文字，例如行内代码黄、标题粗体青、引用斜体。
import { defaultMarkdownTheme } from "./test-themes.ts";
// 测试适配器用 headless xterm 的内存缓冲；write 是异步解析队列，断言前需等待。
import { VirtualTerminal } from "./virtual-terminal.ts";

// Force full color in CI so ANSI assertions are deterministic
// 独立实例显式启用颜色级别3，不依赖 CI 是否自动识别彩色；没有修改全局 FORCE_COLOR。
const chalk = new Chalk({ level: 3 });

// 读取虚拟终端视口中 row/col 对应的单元格并返回；不等待渲染，调用者应先 waitForRender。
// 流程：取得内部 xterm→活动缓冲→视口行→单元格；任一缺失用 assert 抛错。例 (0,2) 检查首行第三列实际样式。
function getCell(terminal: VirtualTerminal, row: number, col: number) {
	// 两次 as 先转 unknown 再描述 xterm 字段，从测试中绕过 TS 的 private 限制；不会运行时检查或复制 terminal。
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	// active 是当前普通屏/备用屏缓冲，不把两份缓冲合并。
	const buffer = xterm.buffer.active;
	// viewportY 是可见顶部在缓冲里的偏移，row 是视口相对行号，两者相加取得缓冲行。
	const line = buffer.getLine(buffer.viewportY + row);
	// 运行时要求该行存在；断言也让后续 TS 将 line 从可缺值收窄为行对象。
	assert.ok(line, `Missing buffer line at row ${row}`);
	// 按终端列取格，不按 JavaScript 字符串码元下标取字符。
	const cell = line.getCell(col);
	// 格缺失就抛出带坐标的诊断，成功后可调用样式查询方法。
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	// 返回 xterm 提供的单元格，供调用者立即查询当时属性；本辅助不另外复制各样式字段。
	return cell;
}

// 移除这套主题常见的数字/分号 SGR 颜色装饰串，输入输出均为 string、无 I/O；例粗体 hi 得 hi。
// 名称虽叫 stripAnsi，正则并不删除 OSC8 链接或所有终端控制协议，后面链接断言会另做处理。
function stripAnsi(line: string): string {
	// 全局替换 ESC [ 数字/分号 m；g 表示替换全部匹配，其他字符原样保留。
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

// 注册 Markdown 总测试组；内部各组提供具体输入和断言，不能由组名推导全部 Markdown 规范都已覆盖。
describe("Markdown component", () => {
	// 这一组检查 transform 在什么时机被调用，以及得到的是扣除左右边距后的宽度。
	describe("Transforms", () => {
		// 测试无参数/无返回值：记录转换回调→同宽复绘→改宽→改文本→主动失效。
		// 例总宽80且每侧边距2，回调收到76；断言同时检查显示结果和完整调用记录，不执行终端 I/O。
		it("caches transformed Markdown by source and available width", () => {
			// Array<{...}> 是对象数组类型：每条保存源码 source 和内容列宽 availableWidth；空数组随后由回调填充。
			const calls: Array<{ source: string; availableWidth: number }> = [];
			// 保存 source，横边距每侧2、纵边距0；undefined 跳过默认正文样式，最后对象传渲染选项。
			const markdown = new Markdown("source", 2, 0, defaultMarkdownTheme, undefined, {
				// 同步转换回调的参数类型由 MarkdownOptions 推断；构造时只登记函数，render 缓存未命中才调用。
				transform: (source, availableWidth) => {
					// 属性简写把本次两个参数加入调用日志，这是测试可观察的副作用。
					calls.push({ source, availableWidth });
					// 模板插值返回“源码 空格 宽度”，便于从结果验证回调实际使用了什么输入。
					return `${source} ${availableWidth}`;
				},
			});

			// 要求首次渲染经过转换；多行调用下两项分别是实际行数组与预期数组。
			assert.deepStrictEqual(
				// 总宽80先触发渲染，map 箭头逐行去 SGR 并 trim 两端空白，因此此断言不保留边距。
				markdown
					.render(80)
					.map((line) => stripAnsi(line).trim()),
				// 80减左右各2为76，预期只有这一条转换后的文字行。
				["source 76"],
			);
			// 同源码同总宽再渲染，应命中整帧缓存而不重复调用 transform。
			markdown.render(80);
			// 换成较窄宽度，要求重新转换并产生另一份行结果。
			assert.deepStrictEqual(
				// 总宽60对应内容宽56；去样式/trim 后方便比较正文。
				markdown
					.render(60)
					.map((line) => stripAnsi(line).trim()),
				// 此时源码尚未更新，仍要求原 source，内容宽度已变56。
				["source 56"],
			);
			// 深比较整个调用日志，既检查参数，也限制此前总调用次数为两次。
			assert.deepStrictEqual(calls, [
				// 第一条调用保存首次源码与76列预算。
				{ source: "source", availableWidth: 76 },
				// 第二条只因换宽发生，源码相同而预算56。
				{ source: "source", availableWidth: 56 },
			]);

			// setText 修改组件源码并清整帧缓存，不在这行立即执行 transform。
			markdown.setText("updated");
			// 下一次绘制应使用新源码。
			assert.deepStrictEqual(
				// render60 触发 updated 的转换，再标准化行文本。
				markdown
					.render(60)
					.map((line) => stripAnsi(line).trim()),
				// 预期新文本已生效，内容宽仍56。
				["updated 56"],
			);
			// at(-1) 读日志末项，确认最新回调参数而不是检查所有历史项。
			assert.deepStrictEqual(calls.at(-1), { source: "updated", availableWidth: 56 });

			// 主动失效清整帧/块样式缓存；即使源码和宽度相同也要重绘。
			markdown.invalidate();
			// 现在执行失效后的 render，转换回调会再记录一次。
			markdown.render(60);
			// 失效没有改源码/宽度，最新参数仍为 updated、56。
			assert.deepStrictEqual(calls.at(-1), { source: "updated", availableWidth: 56 });
			// 此前首次、换宽、换源码、invalidate 后各一次，共四次，限制了额外重复转换。
			assert.strictEqual(calls.length, 4);
		});
	});

	// 这组检查顶层块复用以及需要重绘的条件；弱引用可被 GC 清除，不是永久缓存保证。
	describe("Block reuse", () => {
		// 每个用例结束清能力缓存，避免本组显式能力设置留给后面的测试；此处登记回调而非马上清除。
		afterEach(() => resetCapabilitiesCache());

		// 创建计数高亮主题：输入可变字符串日志，返回符合 MarkdownTheme 的新对象；无立即高亮。
		// 回调被渲染实际调用时记录语言/正文，再逐行绿色包装；例 ts 与 x 记录 ts:x，用来识别缓存复用。
		function countingTheme(calls: string[]): MarkdownTheme {
			// 返回对象容器，日志数组仍是调用者传入的同一引用。
			return {
				// 对象展开复制共享主题字段，再由下面的 highlightCode 覆盖/补充高亮策略。
				...defaultMarkdownTheme,
				// code/lang 由主题签名推断，lang 可缺；这是同步字符串高亮回调，不会执行代码。
				highlightCode: (code, lang) => {
					// 把本次语言和代码正文以冒号连接，push 修改外部日志数组。
					calls.push(`${lang}:${code}`);
					// 按 LF 拆代码源行，map 返回绿色样式行数组；没有使用代码语法分析器。
					return code.split("\n").map((line) => chalk.green(line));
				},
			};
		}

		// 测试完整代码块后追加正文及缩窄宽度时复用高亮，invalidate 后重新高亮；以调用日志判定，不检查真实终端颜色。
		it("highlights a code block once across streamed text and resizes, and again after invalidate", () => {
			// 独立日志避免和其他测试共享计数。
			const calls: string[] = [];
			// 输入是语言 ts、正文 x 的完整围栏，横纵边距均0。
			const markdown = new Markdown("```ts\nx\n```", 0, 0, countingTheme(calls));
			// 首次 render80 建立块与高亮缓存。
			markdown.render(80);
			// 源码末尾追加新段落，但原代码块 raw 没变。
			markdown.setText("```ts\nx\n```\n\nafter");
			// 缩到40列需要重排版，本用例期间仍存活的块记录可保留高亮结果。
			markdown.render(40);
			// 只允许一条 ts:x，说明追加和换宽没有再次调用高亮器。
			assert.deepStrictEqual(calls, ["ts:x"]);
			// 主动清块缓存，外观/高亮需要重新生成。
			markdown.invalidate();
			// 同40列重绘验证失效路径。
			markdown.render(40);
			// 第二条相同记录证明高亮函数确实又运行一次。
			assert.deepStrictEqual(calls, ["ts:x", "ts:x"]);
		});

		// 异步测试弱块缓存可回收：开启 gc→首次绘制→跨任务让弱引用不再被本任务保活→主动 GC→换宽。
		// 以高亮重新发生两次为观察结果，不证明所有对象都已回收或测量内存泄漏；开关未在本用例恢复，仅影响测试进程。
		it("holds rendered blocks weakly, so a full garbage collection releases them", async () => {
			// 向当前 V8 请求暴露 GC 入口，使用固定引擎开关，不操作文件或终端。
			setFlagsFromString("--expose-gc");
			// 新 VM 上下文求值固定字符串 gc，as () => void 仅告诉 TS 它是无参函数，不做运行时验证。
			const gc = runInNewContext("gc") as () => void;
			// 创建本例专用高亮调用日志。
			const calls: string[] = [];
			// 仍用简单 ts/x 代码块隔离布局与复杂高亮的影响。
			const markdown = new Markdown("```ts\nx\n```", 0, 0, countingTheme(calls));
			// 首次绘制创建弱引用持有的块记录和高亮缓存。
			markdown.render(80);
			// A WeakRef keeps its target alive until the current job ends.
			// Promise executor 立即注册 setImmediate；await 让当前任务结束，给 WeakRef 目标解除本任务保活。
			await new Promise((resolve) => setImmediate(resolve));
			// 实际调用得到的 GC 入口；与自然 GC 在何时发生无关，测试主动触发。
			gc();
			// 改变宽度避开强持有的整帧行缓存，迫使查询弱块缓存。
			markdown.render(40);
			// 日志两条说明旧高亮未复用，这个具体场景观察到了块回收效果。
			assert.deepStrictEqual(calls, ["ts:x", "ts:x"]);
		});

		// 测试同一标题 raw 后接新段落时补空行，避免只按块源码复用旧间距；输入/结果全部在字符串中。
		it("renders a block again when the block after it changes its spacing", () => {
			// 初始文档只有一级标题，末尾无需块间空行。
			const markdown = new Markdown("# Title", 0, 0, defaultMarkdownTheme);
			// 首次渲染建立“后继不存在”的块记录。
			markdown.render(80);
			// 追加 foo 使标题的后继类型变成 paragraph，标题本身源码相同。
			markdown.setText("# Title\nfoo");
			// 按完整行数组断言新的间距。
			assert.deepStrictEqual(
				// 重绘后去样式和两端补白；空行会成为空串。
				markdown
					.render(80)
					.map((line) => stripAnsi(line).trim()),
				// 要求标题、恰一条空行、正文 foo。
				["Title", "", "foo"],
			);
		});

		// 测试引用式链接定义变化：标签块不变而定义 URL 改变，输出应采用新地址；不会访问两个示例域名。
		it("follows changed reference link definitions", () => {
			// 关闭超链接，使标签后以可见括号显示地址，便于直接查字符串。
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			// 正文 [a][x] 通过文末定义 x 指向第一个地址。
			const markdown = new Markdown("[a][x]\n\n[x]: https://one.example", 0, 0, defaultMarkdownTheme);
			// 先绘制旧定义，建立可观察的旧结果。
			markdown.render(80);
			// 标签 raw 不变，只改引用定义；Markdown 遇 links 定义会禁用按块 raw 复用。
			markdown.setText("[a][x]\n\n[x]: https://two.example");
			// 只断言新地址出现在去样式输出中；不额外断言旧地址完全不存在。
			assert.ok(stripAnsi(markdown.render(80).join("\n")).includes("https://two.example"));
		});
	});

	// 列表分组覆盖嵌套、源码标记、松散项、任务框以及续行前缀。
	describe("Lists", () => {
		// 以两层无序列表验证父/子项文字及四空格缩进子串；不会精确比较全部输出行。
		it("should render simple nested list", () => {
			// 构造组件，下面整个多行模板是 Markdown 输入，行首空格参与列表层级识别。
			const markdown = new Markdown(
				// 示例父项1包含两个以源码两空格缩进的子项，最后是同层父项2；渲染器按嵌套层数改成四空格缩进。
				`- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
				// 横边距0，缩进完全来自列表结构。
				0,
				// 纵边距0，不额外制造首尾空行。
				0,
				// 使用项目共享列表符号颜色/文字主题。
				defaultMarkdownTheme,
			);

			// 按80列生成样式行数组，尚未向任何终端输出。
			const lines = markdown.render(80);

			// Check that we have content
			// 先要求至少有一条行，避免下面 some 在空数组时全部失败却不清楚原因。
			assert.ok(lines.length > 0);

			// Strip ANSI codes for checking
			// 逐行只删除简单 SGR，不 trim，保留待检验的列表缩进。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check structure
			// some 只要求某条包含父项1，不要求它恰在第一行。
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			// 检查第一个子项的四空格前缀子串。
			assert.ok(plainLines.some((line) => line.includes("    - Nested 1.1")));
			// 第二子项也应在同一嵌套层。
			assert.ok(plainLines.some((line) => line.includes("    - Nested 1.2")));
			// 要求父项2出现在某行中。
			assert.ok(plainLines.some((line) => line.includes("- Item 2")));
		});

		// 四层列表例检查每层比上一层多四空格；includes 是子串检查，不限定整行或顺序。
		it("should render deeply nested list", () => {
			// 构造深嵌套输入，整段模板从 Level1 逐层增加源码缩进。
			const markdown = new Markdown(
				// 四条源行分别表示第1至4层，渲染目标缩进0、4、8、12空格。
				`- Level 1
  - Level 2
    - Level 3
      - Level 4`,
				// 不加组件横边距。
				0,
				// 不加上下空行。
				0,
				// 共享主题负责符号着色。
				defaultMarkdownTheme,
			);

			// 80列足够容纳这些短项，不用触发宽度折行。
			const lines = markdown.render(80);
			// 删除样式但保留原有空格，以便检查缩进。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check proper indentation
			// 第一层无额外列表深度缩进。
			assert.ok(plainLines.some((line) => line.includes("- Level 1")));
			// 第二层要求四空格加符号。
			assert.ok(plainLines.some((line) => line.includes("    - Level 2")));
			// 第三层要求八空格。
			assert.ok(plainLines.some((line) => line.includes("        - Level 3")));
			// 第四层要求十二空格。
			assert.ok(plainLines.some((line) => line.includes("            - Level 4")));
		});

		// 测试有序父列表与有序子列表的编号/缩进，输入显示从1起号，各层自行编号。
		it("should render ordered nested list", () => {
			// 创建有序嵌套列表，两个子项属于 First。
			const markdown = new Markdown(
				// 模板中父项1、子项1/2、父项2构成两级结构。
				`1. First
   1. Nested first
   2. Nested second
2. Second`,
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 共享主题给编号着色。
				defaultMarkdownTheme,
			);

			// 按80列绘制。
			const lines = markdown.render(80);
			// 只去SGR，留下四空格子列表缩进。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// 要求父项1存在。
			assert.ok(plainLines.some((line) => line.includes("1. First")));
			// 要求缩进后的子项1。
			assert.ok(plainLines.some((line) => line.includes("    1. Nested first")));
			// 要求同层子项2。
			assert.ok(plainLines.some((line) => line.includes("    2. Nested second")));
			// 要求第二个父项仍是2。
			assert.ok(plainLines.some((line) => line.includes("2. Second")));
		});

		// 默认规范化有序项：输入连续三个1.，预期显示1/2/3；deepStrictEqual 同时限制完整行数和内容。
		it("should normalize ordered list markers by default", () => {
			// 源字符串中的 \n 是真实换行，不是三个独立构造参数。
			const markdown = new Markdown("1. alpha\n1. beta\n1. gamma", 0, 0, defaultMarkdownTheme);

			// 去SGR再 trimEnd 只裁右边补白，保留左侧符号与缩进。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 完整数组必须恰为三条连续编号的行。
			assert.deepStrictEqual(lines, ["1. alpha", "2. beta", "3. gamma"]);
		});

		// 开启保留源码标记：同时检查倒序数字、右括号标记、+/*/-及空项目；选项名含Ordered但实现也处理无序符号。
		it("should preserve source list markers when configured", () => {
			// 构造输入和选项，下面长字符串用 \n 描述多组列表。
			const markdown = new Markdown(
				// 原数字4/3、10)/7)及不同无序符号不按默认策略重编号/统一，源码缩进仍可规范化。
				"  4. forth\n  3. third\n\n10) ten\n7) seven\n\n+ plus\n* star\n- minus\n+",
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 使用相同共享主题，控制变量只在渲染选项。
				defaultMarkdownTheme,
				// 默认正文样式留空，以便传第六个 options 参数。
				undefined,
				// 开始选项对象，字段由 MarkdownOptions 做编译期检查。
				{
					// true 要求尽可能从每项 raw 提取原始项目标记。
					preserveOrderedListMarkers: true,
				},
			);

			// 渲染后只去右侧空白，不抹掉左侧结构。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 以下完整预期数组同时固定空行、编号、符号与空项目。
			assert.deepStrictEqual(lines, [
				// 第一项保留4，不把列表重置为1。
				"4. forth",
				// 第二项保留3，不从4自动递增。
				"3. third",
				// 空串表示两组有序列表之间的空行。
				"",
				// 保留右括号10)形式。
				"10) ten",
				// 保留7)的原编号。
				"7) seven",
				// 有序/无序组间保留一条空行。
				"",
				// + 符号保持不变。
				"+ plus",
				// 星号不会统一成减号。
				"* star",
				// 减号仍按减号显示。
				"- minus",
				// 空的+项目也保留符号，trimEnd 去掉其末尾空格。
				"+",
			]);
		});

		// 有序父项下嵌无序子项；只抽查父项1/2与一个四空格子项，不逐一断言模板内全部文字。
		it("should render mixed ordered and unordered nested lists", () => {
			// 构造混合类型的两层列表。
			const markdown = new Markdown(
				// 多行模板保留真实缩进，Marked 根据缩进与标记建立列表token。
				`1. Ordered item
   - Unordered nested
   - Another nested
2. Second ordered
   - More nested`,
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 共享主题显示有序/无序标记。
				defaultMarkdownTheme,
			);

			// 生成80列样式行。
			const lines = markdown.render(80);
			// 删除SGR，不抹掉空格缩进。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// 检查第一个有序父项。
			assert.ok(plainLines.some((line) => line.includes("1. Ordered item")));
			// 检查父项下无序子项有四空格缩进。
			assert.ok(plainLines.some((line) => line.includes("    - Unordered nested")));
			// 检查第二个父项存在。
			assert.ok(plainLines.some((line) => line.includes("2. Second ordered")));
		});

		// 松散列表在项目中含多个段落，完整数组断言要求段内续文对齐、项目间空行；未按终端像素测量。
		it("should render blank lines between loose list items", () => {
			// 构造含空行和缩进续段的三项有序列表。
			const markdown = new Markdown(
				// 整个模板是测试输入：前两项各有一个缩进续段，第三项只有正文；空白行也是输入的一部分。
				`1. Lorem ipsum dolor sit amet.

   Ut enim ad minim veniam.

2. Duis aute irure dolor.

   Excepteur sint occaecat cupidatat.

3. Beep boop`,
				// 组件不增加横边距。
				0,
				// 组件不增加纵边距。
				0,
				// 采用默认列表主题。
				defaultMarkdownTheme,
			);

			// 去SGR和右侧补白，保留续段前的三个空格。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 下面数组完整固定三项及空行的位置。
			assert.deepStrictEqual(lines, [
				// 第一项首行带1.标记。
				"1. Lorem ipsum dolor sit amet.",
				// 首项正文与续段之间保留空行。
				"",
				// 续段用三个空格对齐1.之后的正文。
				"   Ut enim ad minim veniam.",
				// 松散项之间保留空行。
				"",
				// 第二项首行编号2。
				"2. Duis aute irure dolor.",
				// 第二项续段前的空行。
				"",
				// 第二项续段同样对齐正文。
				"   Excepteur sint occaecat cupidatat.",
				// 第三项之前的项目间隔。
				"",
				// 末项没有额外尾空行。
				"3. Beep boop",
			]);
		});

		// 任务列表把未完成/完成标记保留为文本方框，不创建交互式复选框；完整比较两条输出。
		it("should render task list markers", () => {
			// 两项分别含 [ ] 与 [x]，由 Marked task/checked 字段决定显示。
			const markdown = new Markdown("- [ ] beep\n- [x] boop", 0, 0, defaultMarkdownTheme);

			// 标准化SGR/行尾补白，保留方框中的空格。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 未勾选仍为空格，勾选为小写x。
			assert.deepStrictEqual(lines, ["- [ ] beep", "- [x] boop"]);
		});

		// 无缩进代码围栏会把有序项拆成不同列表token；测试各token.start使1/2/3仍连续，代码文本不会执行。
		it("should maintain numbering when code blocks are not indented (LLM output)", () => {
			// When code blocks aren't indented, marked parses each item as a separate list.
			// We use token.start to preserve the original numbering.
			// 构造父编号之间夹独立围栏的 Markdown。
			const markdown = new Markdown(
				// 整个模板包含三条编号项和两个独立代码块；模板中的 // code block 只是待显示字符串。
				`1. First item

\`\`\`typescript
// code block
\`\`\`

2. Second item

\`\`\`typescript
// another code block
\`\`\`

3. Third item`,
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 主题负责代码颜色与围栏显示。
				defaultMarkdownTheme,
			);

			// 按80列渲染整份文档。
			const lines = markdown.render(80);
			// 去SGR后 trim 两端，为后续正则匹配移除补白/缩进。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());

			// Find all lines that start with a number and period
			// filter 保留以至少一位数字后接点号开头的行，不检查代码或其他非编号行。
			const numberedLines = plainLines.filter((line) => /^\d+\./.test(line));

			// Should have 3 numbered items
			// 要求恰有三条编号行，失败信息把实际候选拼出。
			assert.strictEqual(numberedLines.length, 3, `Expected 3 numbered items, got: ${numberedLines.join(", ")}`);

			// Check the actual numbers
			// 按候选顺序第一条必须以1.开头，未比较其全部正文。
			assert.ok(numberedLines[0].startsWith("1."), `First item should be "1.", got: ${numberedLines[0]}`);
			// 第二条以2.开头。
			assert.ok(numberedLines[1].startsWith("2."), `Second item should be "2.", got: ${numberedLines[1]}`);
			// 第三条以3.开头。
			assert.ok(numberedLines[2].startsWith("3."), `Third item should be "3.", got: ${numberedLines[2]}`);
		});

		// 无序项长正文在20列下折行，续行两个空格对齐“- ”后的文字；精确比较两行。
		it("should indent wrapped unordered list lines", () => {
			// 只有一个无序项，避免嵌套干扰续行缩进。
			const markdown = new Markdown("- alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			// 20列绘制后保留左边空格并去掉右侧补白。
			const lines = markdown.render(20).map((line) => stripAnsi(line).trimEnd());

			// 第一行带符号，第二行只带两个对齐空格，不重复减号。
			assert.deepStrictEqual(lines, ["- alpha beta gamma", "  delta epsilon"]);
		});

		// 一位有序编号“1. ”占三列，折行续行需三个空格；完整数组固定词语分配。
		it("should indent wrapped ordered list lines", () => {
			// 源输入为单个编号项。
			const markdown = new Markdown("1. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			// 按20列触发词边界折行。
			const lines = markdown.render(20).map((line) => stripAnsi(line).trimEnd());

			// 续行正文与第一行alpha起点对齐。
			assert.deepStrictEqual(lines, ["1. alpha beta gamma", "   delta epsilon"]);
		});

		// 两位编号“10. ”占四列，续行不能仍按三列缩进；用21列验证这一差别。
		it("should indent wrapped ordered list lines with multi-digit markers", () => {
			// 起号10来自源token.start，不强制从1开始。
			const markdown = new Markdown("10. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			// 生成21列行并去SGR/尾部补白。
			const lines = markdown.render(21).map((line) => stripAnsi(line).trimEnd());

			// 预期第二行四空格，而非一位编号的三个。
			assert.deepStrictEqual(lines, ["10. alpha beta gamma", "    delta epsilon"]);
		});

		// 嵌套无序列表折行：子项先有四空格深度，再有两空格标记；续行合计六空格。
		it("should indent wrapped nested list lines", () => {
			// 父项后换行与源码两空格表示一个嵌套子列表。
			const markdown = new Markdown(`- parent\n  - alpha beta gamma delta epsilon`, 0, 0, defaultMarkdownTheme);

			// 24列让子项长正文产生两条物理行。
			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			// 完整输出要求父项一行、子项首行和六空格续行。
			assert.deepStrictEqual(lines, ["- parent", "    - alpha beta gamma", "      delta epsilon"]);
		});

		// 有序父项下的无序子列表也用四空格深度，子项续行六空格；父编号不能额外叠加到子层预算。
		it("should indent wrapped nested list lines under ordered parents", () => {
			// 源父项1.，其下是无序长项。
			const markdown = new Markdown(`1. parent\n   - alpha beta gamma delta epsilon`, 0, 0, defaultMarkdownTheme);

			// 在24列下绘制并保留左缩进。
			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			// 完整行数组确认子项布局与无序父项场景相同。
			assert.deepStrictEqual(lines, ["1. parent", "    - alpha beta gamma", "      delta epsilon"]);
		});

		// 列表项内嵌引用：首行“- │ ”、续行“  │ ”，每次折行都要保留引用边界。
		it("should render and wrap blockquotes inside list items", () => {
			// 一个减号项的正文是 > 引用块。
			const markdown = new Markdown("- > alpha beta gamma delta epsilon zeta", 0, 0, defaultMarkdownTheme);

			// 24列使引用内容折成两行。
			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			// 精确比较引用边框及项目续行空格，没有检测真实终端样式。
			assert.deepStrictEqual(lines, ["- │ alpha beta gamma", "  │ delta epsilon zeta"]);
		});

		// 列表项内代码块仍按项目正文预算折行，代码只显示不执行；预期将固定围栏、缩进与词语分行。
		it("should render and wrap code blocks inside list items", () => {
			// 构造一个带 ts 围栏的列表项。
			const markdown = new Markdown(
				// 源内代码行与闭围栏缩进两个空格，表示属于同一列表项。
				"- ```ts\n  alpha beta gamma delta epsilon zeta\n  ```",
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 共享代码主题绿色/弱化围栏。
				defaultMarkdownTheme,
			);

			// 24列绘制后去SGR和行尾空白，保留列表/代码缩进。
			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			// 精确要求四行：项目围栏、代码首行、代码续行、缩进闭围栏；续行只保留项目对齐空格，不重复代码首行缩进。
			assert.deepStrictEqual(lines, ["- ```ts", "    alpha beta gamma", "  delta epsilon zeta", "  ```"]);
		});
	});

	// 表格测试覆盖边框、列预算、换行及样式收尾；逐条断言强度不同，不以英文标题代替实际验证。
	describe("Tables", () => {
		// 最小双列表格例，抽查表头、两个人名与横竖边框；未比较每格数值/对齐位置。
		it("should render simple table", () => {
			// 构造两列表头和两条数据行。
			const markdown = new Markdown(
				// 整个模板为GFM表格输入，---行用于识别表头分隔，不作为正文显示。
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 共享主题处理表头粗体等行内样式。
				defaultMarkdownTheme,
			);

			// 80列足以容纳这张短表。
			const lines = markdown.render(80);
			// 去SGR，保留边框字符与空格。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check table structure
			// some 检查 Name 出现在某行。
			assert.ok(plainLines.some((line) => line.includes("Name")));
			// 检查 Age 表头存在。
			assert.ok(plainLines.some((line) => line.includes("Age")));
			// 检查第一条数据的人名存在。
			assert.ok(plainLines.some((line) => line.includes("Alice")));
			// 检查第二条数据的人名存在。
			assert.ok(plainLines.some((line) => line.includes("Bob")));
			// Check for table borders
			// 至少一行含竖线，未固定每一行的竖线数量。
			assert.ok(plainLines.some((line) => line.includes("│")));
			// 至少一行含横线，未逐字符比较边框。
			assert.ok(plainLines.some((line) => line.includes("─")));
		});

		// 两条数据行应有表头分隔及数据间分隔两条横线；按中间交叉符┼统计。
		it("should render row dividers between data rows", () => {
			// 重复相同双列表格以隔离分隔线断言。
			const markdown = new Markdown(
				// 模板含表头及Alice/Bob两条数据。
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 按80列绘制。
			const lines = markdown.render(80);
			// 去颜色装饰，保留┼。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// filter 只保留含┼的行；顶底边框使用其他交叉符，不在此集合中。
			const dividerLines = plainLines.filter((line) => line.includes("┼"));

			// 严格要求两行：表头之后一次、两条数据之间一次。
			assert.strictEqual(dividerLines.length, 2, "Expected header + row divider");
		});

		// 32列示例要求最长ASCII词完整出现在首列且列内容预算不短于该词；不是所有超长词都保证不折断。
		it("should keep column width at least the longest word", () => {
			// 保存13个ASCII字母的长词，便于插值和长度比较。
			const longestWord = "superlongword";
			// 构造首列含长词加short的双列表格。
			const markdown = new Markdown(
				// 整个模板插入 longestWord，同时给第二列较短词形成宽度竞争。
				`| Column One | Column Two |
| --- | --- |
| ${longestWord} short | otherword |
| small | tiny |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 32列触发列宽分配，仍有预算放下示例最长词。
			const lines = markdown.render(32);
			// 只去SGR，保留单元左右空格。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// find 取第一条仍含完整长词的行，找不到为 undefined。
			const dataLine = plainLines.find((line) => line.includes(longestWord));
			// 运行时要求找到，随后可把 dataLine 当字符串。
			assert.ok(dataLine, "Expected data row containing longest word");

			// 按竖线切段再去首尾外部片段，留下单元格文本。
			const segments = dataLine.split("│").slice(1, -1);
			// 数组解构取第一列片段。
			const [firstSegment] = segments;
			// 要求首列片段不是空值。
			assert.ok(firstSegment, "Expected first column segment");
			// 扣掉单元两侧各一个空格；此处 length 是UTF-16码元数，示例ASCII词/单列边框恰可对应列数。
			const firstColumnWidth = firstSegment.length - 2;

			// 多行 ok 调用比较首列预算与长词长度。
			assert.ok(
				// 只要求该例列宽至少容纳长词，不断言整列内容不折行。
				firstColumnWidth >= longestWord.length,
				// 失败信息包含预期下限与实际值，便于定位分配错误。
				`Expected first column width >= ${longestWord.length}, got ${firstColumnWidth}`,
			);
		});

		// 输入带左/居中/右对齐标记，但本例只断言文字存在；当前 renderTable 未按 token.align 调整空格，不能据名称说已验证对齐。
		it("should render table with alignment", () => {
			// 构造三个带不同冒号标记的列。
			const markdown = new Markdown(
				// 模板首列:---、中列:---:、末列---:是GFM对齐语法；整段保持原样供解析。
				`| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |
| Long text | Middle | End |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 按80列输出，不强制发生换行。
			const lines = markdown.render(80);
			// 去SGR后查文字。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check headers
			// 检查 Left 表头存在，不检查它在格中偏左多少列。
			assert.ok(plainLines.some((line) => line.includes("Left")));
			// 检查 Center 文字，不测量居中两边空格。
			assert.ok(plainLines.some((line) => line.includes("Center")));
			// 检查 Right 文字，不测量右对齐。
			assert.ok(plainLines.some((line) => line.includes("Right")));
			// Check content
			// 检查一个较长数据单元，未遍历每条数据。
			assert.ok(plainLines.some((line) => line.includes("Long text")));
		});

		// 宽窄不同的两列示例只要求成功产生输出并保留长表头/长正文，不对最终列宽数值作断言。
		it("should handle tables with varying column widths", () => {
			// 构造一列短、一列长的表格。
			const markdown = new Markdown(
				// 多行输入中第二列表头与第一条数据明显长于第一列。
				`| Short | Very long column header |
| --- | --- |
| A | This is a much longer cell content |
| B | Short |`,
				// 横边距0。
				0,
				// 纵边距0。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 80列足够给这些文字自然布局。
			const lines = markdown.render(80);

			// Should render without errors
			// 至少有输出；若 render 抛异常，测试器也会直接判失败。
			assert.ok(lines.length > 0);

			// 移除SGR，为文字子串断言作准备。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 长表头必须完整出现在某一行。
			assert.ok(plainLines.some((line) => line.includes("Very long column header")));
			// 长数据单元必须完整出现在某一行。
			assert.ok(plainLines.some((line) => line.includes("This is a much longer cell content")));
		});

		// 50列三列表格触发单元换行；逐行限制示例长度，并抽查部分关键词，不等于逐字验证全部表内容。
		it("should wrap table cells when table exceeds available width", () => {
			// 构造命令/说明/示例三列。
			const markdown = new Markdown(
				// 整个模板里的 npm install/npm run build 只是文字，不会执行npm命令。
				`| Command | Description | Example |
| --- | --- | --- |
| npm install | Install all dependencies | npm install |
| npm run build | Build the project | npm run build |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// Render at narrow width that forces wrapping
			// 总宽50交给表格分配列预算。
			const lines = markdown.render(50);
			// 去SGR再去右侧补白，保留正文与边框。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should fit within width
			// 遍历每条实际输出行。
			for (const line of plainLines) {
				// length<=50 对此ASCII正文/单码元边框适用；不是宽字/组合字符的一般列宽算法。
				assert.ok(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length})`);
			}

			// Content should still be present (possibly wrapped across lines)
			// 用空格连接行，便于跨输出集合搜索，但不能恢复原表格精确结构。
			const allText = plainLines.join(" ");
			// 检查 Command 表头完整存在。
			assert.ok(allText.includes("Command"), "Should contain 'Command'");
			// 检查 Description 表头完整存在。
			assert.ok(allText.includes("Description"), "Should contain 'Description'");
			// 检查 npm install 片段未被丢掉。
			assert.ok(allText.includes("npm install"), "Should contain 'npm install'");
			// 抽查说明中的 Install。
			assert.ok(allText.includes("Install"), "Should contain 'Install'");
		});

		// 异步样式回归：分别开/关OSC8，窄表长粗体链接折行后，边框与普通格不能继承链接前景/粗体。
		// 流程构造内存TUI→等待帧和xterm解析→定位文字列→查询真实格属性；finally停TUI并清缓存，无网络或真实TTY。
		it("should not leak wrapped link styles into table borders or plain cells", async () => {
			// 整个模板为两列表格：左侧是带粗体的长链接，右侧普通文字；网址只被编码/显示。
			const source = `| Link | Plain |
| --- | --- |
| [**one two three four five six**](https://example.com) | normal text |`;

			// 外层 finally 负责即使断言失败也清共享能力缓存。
			try {
				// for...of 顺序运行支持链接与不支持链接两种能力，不并行共享缓存。
				for (const hyperlinks of [true, false]) {
					// 属性简写 hyperlinks 保存本轮值，显式能力绕过自动检测。
					setCapabilities({ images: null, trueColor: false, hyperlinks });
					// 创建24列16行的内存 xterm，窄列迫使链接换行。
					const terminal = new VirtualTerminal(24, 16);
					// TUI 类型注解检查接口；实际对象是向这个模拟终端输出的主屏实现。
					const tui: TUI = new TuiMainScreen(terminal);
					// 添加 Markdown 子组件，只登记，不在这一行开始完整绘制。
					tui.addChild(new Markdown(source, 0, 0, defaultMarkdownTheme));
					// 启动调度与虚拟输入回调；它在内层 try 之前，后面的 finally 只包已成功启动后的流程。
					tui.start();

					// 内层 try/finally 确保本轮断言/等待失败后仍尝试 stop。
					try {
						// 给 nextTick/约20ms节流帧机会，再排空此前 xterm 写队列；不是对任意未来任务的保证。
						await terminal.waitForRender();
						// 取当前可见文字快照，不含ANSI样式。
						const viewport = terminal.getViewport();
						// findIndex 找同时含one与norm的首行，未找到为-1。
						const row = viewport.findIndex((line) => line.includes("one") && line.includes("norm"));
						// 要求行存在，失败时JSON展示整个视口。
						assert.notStrictEqual(row, -1, `Missing wrapped table row: ${JSON.stringify(viewport)}`);
						// 取已找到的行字符串。
						const line = viewport[row];
						// 用one起点代表链接格的位置。
						const linkCol = line.indexOf("one");
						// 从链接文字之后找第一个竖线，定位列间边界。
						const separatorCol = line.indexOf("│", linkCol);
						// 用norm起点代表右侧普通单元。
						const plainCol = line.indexOf("norm");
						// 要求三处位置存在且从左到右有序；这些示例前缀都是单列字符，字符串索引可用作格列。
						assert.ok(linkCol >= 0 && separatorCol > linkCol && plainCol > separatorCol);
						// 链接文字前景应非终端默认色，未要求具体蓝色编号。
						assert.strictEqual(getCell(terminal, row, linkCol).isFgDefault(), false);
						// 列间竖线必须恢复默认前景。
						assert.strictEqual(getCell(terminal, row, separatorCol).isFgDefault(), true);
						// 右侧普通文字也必须用默认前景。
						assert.strictEqual(getCell(terminal, row, plainCol).isFgDefault(), true);
						// isBold 返回数值标志，不以true比较；非0表示链接处粗体开启。
						assert.notStrictEqual(getCell(terminal, row, linkCol).isBold(), 0);
						// 边界格粗体必须为0。
						assert.strictEqual(getCell(terminal, row, separatorCol).isBold(), 0);
						// 普通格粗体必须为0。
						assert.strictEqual(getCell(terminal, row, plainCol).isBold(), 0);

						// 只有不支持OSC8时，渲染器才显示括号URL并用dim样式。
						if (!hyperlinks) {
							// 找包含https的回退地址行。
							const urlRow = viewport.findIndex((viewportLine) => viewportLine.includes("https"));
							// 要求实际有URL行，否则后续格定位没有意义。
							assert.notStrictEqual(urlRow, -1, `Missing fallback URL row: ${JSON.stringify(viewport)}`);
							// 保存这一条行的可见文字。
							const urlLine = viewport[urlRow];
							// URL首字母位置用作弱化样式检查点。
							const urlCol = urlLine.indexOf("https");
							// 查URL右边的首个列间竖线。
							const urlSeparatorCol = urlLine.indexOf("│", urlCol);
							// 最后一个竖线是表格右侧外边框。
							const urlBorderCol = urlLine.lastIndexOf("│");
							// 要求地址→列分隔→外边框位置顺序正确。
							assert.ok(urlCol >= 0 && urlSeparatorCol > urlCol && urlBorderCol > urlSeparatorCol);
							// 地址格的dim标志应非0。
							assert.notStrictEqual(getCell(terminal, urlRow, urlCol).isDim(), 0);
							// 列间竖线不能带地址的dim。
							assert.strictEqual(getCell(terminal, urlRow, urlSeparatorCol).isDim(), 0);
							// 右外框也不能带dim。
							assert.strictEqual(getCell(terminal, urlRow, urlBorderCol).isDim(), 0);
						}
						// 无论本轮断言成功与否都运行清理；stop 抛错会按JS finally规则影响原异常。
					} finally {
						// 停止这个虚拟TUI，不访问真实终端。
						tui.stop();
					}
				}
				// 退出两种能力循环后执行外层清理，断言失败也会进入。
			} finally {
				// 仅清共享能力缓存，下次访问可重探测；没有恢复一份先前缓存快照。
				resetCapabilitiesCache();
			}
		});

		// 引用内的窄表链接换行后应恢复引用RGB色，而非默认色；查询首/末链接物理行上的边界/普通格。
		// 主题使用简单包装不替调用者重开嵌套颜色，迫使渲染器自己的恢复逻辑被验证；finally只包start成功后的步骤。
		it("should restore the enclosing style after a wrapped table link", async () => {
			// 0x123456 是RGB数值18/52/86，与下面引用SGR38;2参数对应。
			const quoteColor = 0x123456;
			// MarkdownTheme 注解检查新主题字段/函数签名，无运行时验证。
			const theme: MarkdownTheme = {
				// 复制默认主题，其余规则维持一致。
				...defaultMarkdownTheme,
				// Use a basic wrapper that does not automatically reopen itself after nested resets.
				// 固定RGB引用前景包装，39m恢复默认；函数仅拼串，不自动修补内部重置。
				quote: (text) => `\x1b[38;2;18;52;86m${text}\x1b[39m`,
				// 链接采用另一种RGB前景，让链接色和引用色可以区分。
				link: (text) => `\x1b[38;2;129;162;190m${text}\x1b[39m`,
			};
			// 整个模板每行有>，因此表格属于引用块；长链接和普通格在同一数据行。
			const source = `> | Link | Plain |
> | --- | --- |
> | [one two three four five six](https://example.com) | normal text |`;

			// 直接设真彩/超链接能力，避免依赖实际终端支持情况。
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			// 内存屏28列10行，给引用边界和窄表换行留位置。
			const terminal = new VirtualTerminal(28, 10);
			// 创建主屏调度器，契约用TUI标注。
			const tui: TUI = new TuiMainScreen(terminal);
			// 注册使用自定义引用/链接主题的Markdown。
			tui.addChild(new Markdown(source, 0, 0, theme));
			// 启动虚拟TUI，开始后的等待/断言由下面try保护。
			tui.start();

			// try/finally负责等待及断言失败时的停止与缓存清理。
			try {
				// 等待常见帧完成和已排队xterm写入。
				await terminal.waitForRender();
				// 读无样式的视口文字以定位坐标。
				const viewport = terminal.getViewport();
				// 找首条同时含one/normal的数据行。
				const row = viewport.findIndex((line) => line.includes("one") && line.includes("normal"));
				// 必须找到，失败列出视口。
				assert.notStrictEqual(row, -1, `Missing wrapped blockquote table row: ${JSON.stringify(viewport)}`);
				// 保存被选中的行。
				const line = viewport[row];
				// 链接起点定位。
				const linkCol = line.indexOf("one");
				// 链接后的第一个竖线定位列间边界。
				const separatorCol = line.indexOf("│", linkCol);
				// 普通文字起点定位。
				const plainCol = line.indexOf("normal");
				// 要求坐标存在且顺序正确；这些定位前缀无多列宽字。
				assert.ok(linkCol >= 0 && separatorCol > linkCol && plainCol > separatorCol);

				// 链接处颜色须与引用色不同，未限定精确链接RGB。
				assert.notStrictEqual(getCell(terminal, row, linkCol).getFgColor(), quoteColor);
				// 列分隔恢复0x123456引用色。
				assert.strictEqual(getCell(terminal, row, separatorCol).getFgColor(), quoteColor);
				// 右侧普通文字也恢复引用色。
				assert.strictEqual(getCell(terminal, row, plainCol).getFgColor(), quoteColor);

				// findIndex 通过末尾文字five six找最后链接片段行。
				const finalRow = viewport.findIndex((line) => line.includes("five six"));
				// 要求末片段存在，避免只测试首片段。
				assert.notStrictEqual(finalRow, -1, `Missing final wrapped link row: ${JSON.stringify(viewport)}`);
				// 保存末片段行。
				const finalLine = viewport[finalRow];
				// 末片段文字起点。
				const finalLinkCol = finalLine.indexOf("five six");
				// 末片段后列间分隔的位置。
				const finalSeparatorCol = finalLine.indexOf("│", finalLinkCol);
				// 这一行最右竖线的位置。
				const finalBorderCol = finalLine.lastIndexOf("│");
				// 约束末文字→分隔→外框的左右顺序。
				assert.ok(finalLinkCol >= 0 && finalSeparatorCol > finalLinkCol && finalBorderCol > finalSeparatorCol);
				// 末片段后列分隔也应回到引用色。
				assert.strictEqual(getCell(terminal, finalRow, finalSeparatorCol).getFgColor(), quoteColor);
				// 最右外框应保持引用色。
				assert.strictEqual(getCell(terminal, finalRow, finalBorderCol).getFgColor(), quoteColor);
				// 进入清理分支；这里不是整个测试从构造开始都受保护。
			} finally {
				// 停止虚拟TUI。
				tui.stop();
				// 清能力缓存，避免本例强制真彩/链接影响后例。
				resetCapabilitiesCache();
			}
		});

		// 单列长正文在25列下折行；统计带│的内容行并抽查短语，未逐字对比整段原文。
		it("should wrap long cell content to multiple lines", () => {
			// 构造只有一个表头与一个长数据格的表。
			const markdown = new Markdown(
				// 整段模板的长句需要拆成多条物理行。
				`| Header |
| --- |
| This is a very long cell content that should wrap |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// Render at width that forces the cell to wrap
			// 按25列绘制。
			const lines = markdown.render(25);
			// 删除SGR/尾空格。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have multiple data rows due to wrapping
			// 筛选以│开头且不含横线的行；这个集合也包括表头，变量名dataRows并非只指数据。
			const dataRows = plainLines.filter((line) => line.startsWith("│") && !line.includes("─"));
			// 数量大于2说明除表头外至少有两条数据物理行。
			assert.ok(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`);

			// All content should be preserved (may be split across lines)
			// 空格连接输出，用子串搜索抽查文字。
			const allText = plainLines.join(" ");
			// 保留very long短语。
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			// 保留cell content短语。
			assert.ok(allText.includes("cell content"), "Should preserve 'cell content'");
			// 保留should wrap短语。
			assert.ok(allText.includes("should wrap"), "Should preserve 'should wrap'");
		});

		// 单元先有prefix再接不含空格长URL，测试途中长token也会折开且内容可重组；不下载URL。
		it("should wrap long unbroken tokens inside table cells (not only at line start)", () => {
			// Pin to no-hyperlinks so width checks work on plain text without OSC 8 sequences.
			// 关闭链接避免OSC8载荷混入length与文本提取，显式能力不依赖宿主。
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			// 保存长URL供模板插值和最终完整子串比较。
			const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";
			// 构造单列输入。
			const markdown = new Markdown(
				// 模板格内容为prefix空格接长地址，确保长token不是行首。
				`| Value |
| --- |
| prefix ${url} |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 保存预算30，后续渲染与长度断言使用同一值。
			const width = 30;
			// 按这个预算绘制。
			const lines = markdown.render(width);
			// 正常路径立即清缓存；这里没有finally，前面的render若抛错将跳过此清理。
			resetCapabilitiesCache();
			// 删除SGR并裁右侧空格。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// 遍历所有结果行，包括边框。
			for (const line of plainLines) {
				// 对本例ASCII文字/单码元边框限制码元长度不超30。
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			// 取以竖线开头的表头/数据行。
			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			// 先要求集合非空，后面的逐行检查才不是空集合上直接通过。
			assert.ok(tableLines.length > 0, "Expected table rows to render");
			// 逐条验证内容行边框数量。
			for (const line of tableLines) {
				// split 按每条竖线切段，段数减1得到出现次数。
				const borderCount = line.split("│").length - 1;
				// 单列表格内容行恰两条竖线，避免折行把边框拆散。
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			// 拼全部行后删除指定框线字符和空白，将被折开的URL片段重新相邻；并非删除所有Unicode边框。
			const extracted = plainLines.join("").replace(/[│├┤─\s]/g, "");
			// 要求前缀未丢失。
			assert.ok(extracted.includes("prefix"), "Should preserve 'prefix'");
			// 要求完整原URL仍为连续子串，验证这一URL的字符保留。
			assert.ok(extracted.includes(url), "Should preserve URL");
		});

		// 长行内代码在20列表格中折行，检查黄色SGR、每行长度与现有内容行边框数量；不执行代码。
		it("should wrap styled inline code inside table cells without breaking borders", () => {
			// 构造一个含反引号长标识符的格。
			const markdown = new Markdown(
				// 整个模板中反斜杠只用于JS模板转义反引号，Markdown实际收到单反引号代码片段。
				`| Code |
| --- |
| \`averyveryveryverylongidentifier\` |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题将行内代码设为黄色。
				defaultMarkdownTheme,
			);

			// 保存20列预算。
			const width = 20;
			// 渲染得到ANSI行。
			const lines = markdown.render(width);
			// 用LF拼原样输出以查找样式序列。
			const joinedOutput = lines.join("\n");
			// 只要求某处存在黄色开启码，未检查每个代码格都保持黄色。
			assert.ok(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)");

			// 去SGR和右侧补白后测本例码元长度。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			// 遍历所有实际行。
			for (const line of plainLines) {
				// 每行长度不得超过20。
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			// 挑竖线开头的内容行；此处没有另断言集合非空。
			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			// 逐条检查已找到行，若集合为空循环本身不会失败。
			for (const line of tableLines) {
				// 数出竖线个数。
				const borderCount = line.split("│").length - 1;
				// 现有每条内容行必须恰有两条竖线。
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}
		});

		// 15列三列表格测试不崩溃、有输出且行长受限；这个具体输入仍可分到每格1列，并非所有极窄预算的回退测试。
		it("should handle extremely narrow width gracefully", () => {
			// 构造三列各一个字母/数字的短表。
			const markdown = new Markdown(
				// 模板三列简单ASCII内容，方便按length检查。
				`| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// Very narrow width
			// 在15列渲染；这个短表自然宽度为13列，仍能放下，不触发过窄原文回退。
			const lines = markdown.render(15);
			// 去样式/尾空格。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should not crash and should produce output
			// 要求至少生成一条行。
			assert.ok(lines.length > 0, "Should produce output");

			// Lines should not exceed width
			// 遍历全部行。
			for (const line of plainLines) {
				// 该例每行码元数最多15。
				assert.ok(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length})`);
			}
		});

		// 宽80时自然宽即可放下，抽查表头/分隔/数据结构；不强迫表格拉伸占满80列。
		it("should render table correctly when it fits naturally", () => {
			// 构造最小两列短表。
			const markdown = new Markdown(
				// 模板表头A/B、数据1/2，不含复杂行内格式。
				`| A | B |
| --- | --- |
| 1 | 2 |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// Wide width where table fits naturally
			// 宽预算应允许自然宽布局。
			const lines = markdown.render(80);
			// 删除样式和尾部统一补白。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have proper table structure
			// 找同时含A/B的首行，代表表头。
			const headerLine = plainLines.find((line) => line.includes("A") && line.includes("B"));
			// 要求表头行存在。
			assert.ok(headerLine, "Should have header row");
			// 可选链安全读取并要求表头含竖边框；不逐列量宽。
			assert.ok(headerLine?.includes("│"), "Header should have borders");

			// 找同时含├/┼的分隔行。
			const separatorLine = plainLines.find((line) => line.includes("├") && line.includes("┼"));
			// 要求该结构存在。
			assert.ok(separatorLine, "Should have separator row");

			// 找同时含1/2的数据行。
			const dataLine = plainLines.find((line) => line.includes("1") && line.includes("2"));
			// 要求数据行存在。
			assert.ok(dataLine, "Should have data row");
		});

		// 总宽40且每侧paddingX2，内容预算36；检查完整行长度和至少一条表格行的左边距。
		it("should respect paddingX when calculating table width", () => {
			// 构造两列表，长表头让预算计算有意义。
			const markdown = new Markdown(
				// 整段模板保留原表头/数据行。
				`| Column One | Column Two |
| --- | --- |
| Data 1 | Data 2 |`,
				// 每侧2空格，不是左右合计2。
				2, // paddingX = 2
				// 上下不加空行。
				0,
				// 共享主题。
				defaultMarkdownTheme,
			);

			// Width 40 with paddingX=2 means contentWidth=36
			// render内部从40扣2*2作为表格可用宽度。
			const lines = markdown.render(40);
			// 去SGR和右补白，保留左边距。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should respect width
			// 遍历结果行。
			for (const line of plainLines) {
				// 码元长度不超总宽40，包含未裁左边距。
				assert.ok(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length})`);
			}

			// Table rows should have left padding
			// 找到第一条含竖线的表格内容行。
			const tableRow = plainLines.find((line) => line.includes("│"));
			// 可选链后ok要求行存在且以两个空格开头，未检查每条行的两侧padding。
			assert.ok(tableRow?.startsWith("  "), "Table should have left padding");
		});

		// 表格是末块时不补额外尾空行；只比较末项不等空串，不能单凭此断言推导数组一定非空。
		it("should not add a trailing blank line when table is the last rendered block", () => {
			// 构造只有一张表的文档。
			const markdown = new Markdown(
				// 模板单列Name/Alice之后没有后继段落。
				`| Name |
| --- |
| Alice |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享主题。
				defaultMarkdownTheme,
			);

			// 生成80列行。
			const lines = markdown.render(80);
			// 尾补白trimEnd后，真正空白行会成为空串。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// notStrictEqual只要求下面两值不同。
			assert.notStrictEqual(
				// at(-1)读末项；数组若为空会得undefined，本断言也会通过，所以关注点是尾项而非非空性。
				plainLines.at(-1),
				// 禁止末项等于空串。
				"",
				// 失败信息序列化完整行数组，便于看多出来的空行。
				`Expected table to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	// 组合场景把标题、嵌套列表和表格放同一文档，检查关键内容能共存。
	describe("Combined features", () => {
		// 本例只做存在性抽查，不精确固定全部块间空白与顺序。
		it("should render lists and tables together", () => {
			// 构造三类块混合文档。
			const markdown = new Markdown(
				// 整个模板包含一级标题、两层列表、两列表格；空白行用于分隔各块。
				`# Test Document

- Item 1
  - Nested item
- Item 2

| Col1 | Col2 |
| --- | --- |
| A | B |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享主题。
				defaultMarkdownTheme,
			);

			// 80列绘制整份文档。
			const lines = markdown.render(80);
			// 去SGR保留结构字符/缩进。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check heading
			// 检查标题文字。
			assert.ok(plainLines.some((line) => line.includes("Test Document")));
			// Check list
			// 检查第一个父列表项。
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			// 检查四空格嵌套项子串。
			assert.ok(plainLines.some((line) => line.includes("    - Nested item")));
			// Check table
			// 检查表头Col1。
			assert.ok(plainLines.some((line) => line.includes("Col1")));
			// 检查至少一处竖边框，不比较整张表的全部格。
			assert.ok(plainLines.some((line) => line.includes("│")));
		});
	});

	// 数学测试经Markdown分隔符识别后再调用有限LaTeX渲染器；和直接renderLatex只接公式正文的测试不同。
	describe("LaTeX math", () => {
		// 行内数学例覆盖美元及反斜杠圆括号分隔、字母上下标、分数和箭头；只转换文字，不求公式数值。
		it("renders inline dollar and parenthesis delimiters", () => {
			// 构造一个同时含多个行内公式的段落。
			const markdown = new Markdown(
				// String.raw 保留模板里的反斜杠，输入仍含$与圆括号分隔符，由 Markdown 数学扩展识别。
				String.raw`A map $\mathbb{C}^3 \to \mathbb{C}^3$, $xy$, $x-y$, $-x$, $\frac{1}{2}$, $\rightarrow$, and \(s \to \infty\).`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享主题。
				defaultMarkdownTheme,
			);

			// 80列绘制后去SGR和右补白，保留公式内部空格。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 精确固定这一行Unicode结果；简单行内分数为1/2，未使用display二维分数。
			assert.deepStrictEqual(lines, ["A map ℂ³ → ℂ³, xy, x-y, -x, 1/2, →, and s → ∞."]);
		});

		// 双美元块内的转义花括号/间距命令不能先被Markdown转义规则破坏；完整比较前段、公式、后段及间隔。
		it("renders display dollar delimiters without Markdown escape corruption", () => {
			// 创建有前后普通段落的数学文档。
			const markdown = new Markdown(
				// 整个String.raw模板保留反斜杠花括号、分号间距和pm等原命令；双美元是块分隔符。
				String.raw`Before

$$\{3x+2y,\; x \in \{0, \pm 1\}\}$$

after`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 80列渲染并去装饰/尾空白。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 完整数组要求保留花括号集合、∈与±，块前后各一空行。
			assert.deepStrictEqual(lines, ["Before", "", "{3x+2y, x ∈ {0, ± 1}}", "", "after"]);
		});

		// 反斜杠方括号显示数学用二维分数，预期三条公式物理行及前后空行；这不是计算照度数值。
		it("renders display bracket delimiters", () => {
			// 构造带前后文的display公式。
			const markdown = new Markdown(
				// 整段原始模板含独立开闭方括号行和frac/text命令，JS不吞反斜杠。
				String.raw`Before

\[
E \approx \frac{0.1\ \text{lux}}{100\ \text{lm/W}}
\]

after`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 80列足以容纳二维布局，去右补白后保留左对齐空格。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 数组精确规定分子、横线、分母位置；前四个空格使它们对齐E≈之后。
			assert.deepStrictEqual(lines, ["Before", "", "    0.1 lux", "E ≈ ────────", "    100 lm/W", "", "after"]);
		});

		// 矩阵的多行结果要相对于A=对齐开括号；pmatrix内容使用横向斜杠分数，精确比较字符布局。
		it("aligns matrix rows with the opening delimiter", () => {
			// 创建前段加显示矩阵。
			const markdown = new Markdown(
				// 整个原始模板为2×2矩阵，双反斜杠分行、&分列，末尾句点在矩阵闭括号后。
				String.raw`Consider the matrix

\[
A=
\begin{pmatrix}
\pi & 0\\
0 & \frac{1}{\pi}
\end{pmatrix}.
\]`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 按80列绘制并保留行首空格。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 第二个矩阵物理行前四空格与首行括号对齐，不把每行都重复加A=。
			assert.deepStrictEqual(lines, ["Consider the matrix", "", "A = ⎛ π │ 0   ⎞", "    ⎝ 0 │ 1/π ⎠."]);
		});

		// 显示lim的下标放在运算符下方，复杂分子/分母为三行布局；断言的是排版，不验证极限等式数学真假。
		it("renders lower limits beneath display operators", () => {
			// 构造一个独立显示公式块。
			const markdown = new Markdown(
				// 原始模板的外层frac、嵌套frac和lim下标在Markdown识别后交LaTeX有限解析器。
				String.raw`\[
\lim_{x\to 0}\frac{\frac{\sin x}{x}-1}{\frac{e^x-1}{x}-1}=0
\]`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 渲染80列，去尾空白但保留二维对齐前缀。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 完整三行同时规定lim上/下位置、横线长度以及右侧=0。
			assert.deepStrictEqual(lines, ["     (sin x)/x-1", "lim  ─────────── = 0", "x→0  (eˣ-1)/x-1"]);
		});

		// 行内数学扩展也应作用于列表正文与表格单元；用两个子串抽查，不比较全部边框和行数。
		it("renders math inside lists and tables", () => {
			// 构造列表加单列表格。
			const markdown = new Markdown(
				// 原始模板列表含F_1/u^2，表格含mathbb C^3，两个位置都保留美元分隔给Markdown。
				String.raw`- Formula: $F_1 = u^2$

| Value |
| --- |
| $\mathbb{C}^3$ |`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
			);

			// 渲染后去SGR/尾补白。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());
			// 用换行连接结果供存在性搜索。
			const output = lines.join("\n");

			// 要求列表中显示下标₁、上标²，美元分隔符不在这个片段里。
			assert.ok(output.includes("- Formula: F₁ = u²"));
			// 要求表格内容出现ℂ³且有左边框。
			assert.ok(output.includes("│ ℂ³"));
		});

		// 常见金额、shell变量和行内代码不能被美元数学规则吞掉；所有$名称只是文本，不读取进程环境变量。
		it("does not treat currency, shell variables, or code spans as math", () => {
			// 拼接$和{PATH}仍是普通双引号字符串，不是JS模板插值；反引号标出代码片段。
			const source = "Costs $5 and $10 or $8k–$12k; use `$x$`, $HOME, and $" + "{PATH}.";
			// 保存原文的Markdown组件。
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);

			// 80列绘制并标准化主题/右补白。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 完整行要求价格和变量美元符保留，代码片段只去Markdown反引号。
			assert.deepStrictEqual(lines, ["Costs $5 and $10 or $8k–$12k; use $x$, $HOME, and $" + "{PATH}."]);

			// 另一示例包含相邻$HOME/$USER及大写下划线变量。
			const shellVariables = "Paths: $HOME/$USER and $XDG_CONFIG_HOME/$APP_CONFIG";
			// 直接在新构造器结果上链式调用，变量没有被shell解释。
			const shellLines = new Markdown(shellVariables, 0, 0, defaultMarkdownTheme)
				// 以80列绘制这条路径文字。
				.render(80)
				// map去SGR/右侧空格，得到可精确比较的数组。
				.map((line) => stripAnsi(line).trimEnd());
			// 整个变量字符串逐字保留为一行。
			assert.deepStrictEqual(shellLines, [shellVariables]);
		});

		// 不支持命令与流式未闭合公式均回退原文；这里只验证给定两个例子，不承诺任意非法输入都完全同样处理。
		it("preserves unsupported and incomplete LaTeX exactly", () => {
			// cases是字符串数组：unknown命令闭合公式、mathbb命令未闭美元；String.raw保反斜杠。
			const cases = [String.raw`Unknown $x + \unknown{y}$ after`, String.raw`Streaming $\mathbb{C}^3`];

			// 顺序遍历两个源例，没有异步或共享终端。
			for (const source of cases) {
				// 每例新建组件，避免上一份缓存影响结果。
				const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
				// 去样式和右侧补白，未删除公式分隔符。
				const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());
				// 深比较仅含原source的一条行，要求这两例原文完全保留。
				assert.deepStrictEqual(lines, [source]);
			}
		});

		// 显式反斜杠开符未闭时以pending保留，不提前吞反斜杠或转换命令；分别比较行内与块级例。
		it("preserves incomplete backslash delimiters while streaming", () => {
			// String.raw让行内开符\(和mathbb反斜杠真实进入输入，末尾没有\)。
			const inline = new Markdown(String.raw`Map \(\mathbb{C}^3`, 0, 0, defaultMarkdownTheme);
			// 对行内例比较完整行数组。
			assert.deepStrictEqual(
				// render80后只去装饰/右补白。
				inline
					.render(80)
					.map((line) => stripAnsi(line).trimEnd()),
				// 预期仍为原始未闭合源码。
				[String.raw`Map \(\mathbb{C}^3`],
			);

			// 普通字符串中双写反斜杠表示实际一个，\n为LF；块数学开\[后只有x^2。
			const display = new Markdown("\\[\nx^2", 0, 0, defaultMarkdownTheme);
			// 对块级例比较两个物理行。
			assert.deepStrictEqual(
				// 渲染并标准化主题。
				display
					.render(80)
					.map((line) => stripAnsi(line).trimEnd()),
				// 没有闭合分隔，预期保留开符与x^2，不转成x²。
				["\\[", "x^2"],
			);
		});

		// 反斜杠转义的美元和代码围栏里的公式均不转换；代码围栏本身规范显示且有默认两空格代码缩进。
		it("does not render LaTeX inside escaped delimiters or code fences", () => {
			// 数组按LF拼出转义正文、空行、text围栏和公式代码；原始模板中的反斜杠必须保持。
			const source = [String.raw`Escaped \$x-y\$.`, "", "```text", String.raw`$\mathbb{C}^3$`, "```"].join("\n");
			// 用默认策略构造。
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
			// 渲染后只去样式/尾补白，代码缩进保留。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 精确要求正文去转义反斜杠但保留美元，围栏里的mathbb命令原样显示。
			assert.deepStrictEqual(lines, ["Escaped $x-y$.", "", "```text", "  $\\mathbb{C}^3$", "```"]);
		});

		// renderLatex:false禁止已识别数学token转Unicode，分隔符与命令仍按raw显示；没有卸载词法扩展。
		it("allows LaTeX rendering to be disabled", () => {
			// 构造块数学及行内数学混合文档。
			const markdown = new Markdown(
				// 整个原始模板含多行块命令及后面的\(A_sf\)，禁用转换时都保留为文字。
				String.raw`$$
\widetilde Y_{sf}
=
(1-w_{sf})\mu_{sf}^{\mathrm{MAR}}
$$

Inline \(A_{sf}\)`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题。
				defaultMarkdownTheme,
				// 跳过默认正文样式。
				undefined,
				// 单独传options对象。
				{
					// 显式false触发数学显示回退，不是把全文当普通无Markdown文字。
					renderLatex: false,
				},
			);

			// 完整数组固定raw数学行及空行。
			assert.deepStrictEqual(
				// 以80列输出并去主题/尾补白。
				markdown
					.render(80)
					.map((line) => stripAnsi(line).trimEnd()),
				// 开始预期各物理行。
				[
					// 块数学开双美元仍可见。
					"$$",
					// widetilde命令原文保留。
					String.raw`\widetilde Y_{sf}`,
					// 单独等号行保持。
					"=",
					// 长命令行的上下标/花括号不做Unicode替换。
					String.raw`(1-w_{sf})\mu_{sf}^{\mathrm{MAR}}`,
					// 闭双美元仍可见。
					"$$",
					// 块与后段之间一条空行。
					"",
					// 行内原始反斜杠圆括号分隔符也保留。
					String.raw`Inline \(A_{sf}\)`,
				],
			);
		});

		// Regression test for https://github.com/earendil-works/pi/issues/11483
		// #11483：二维公式太宽时整块回到raw再普通换行，避免逐行折断数学二维几何；比较40列正常转换和30列回退。
		it("falls back to raw source when display math is wider than the content width", () => {
			// 通过行数组构造显示公式，后面join为一段源码。
			const source = [
				// 开方括号只含一个实际反斜杠。
				"\\[",
				// 原始模板保存偏导、求和、积分命令，不执行数值计算。
				String.raw`\frac{\partial^2 u}{\partial x^2} + \frac{\partial^2 u}{\partial y^2} = \sum_{i=1}^{n} \frac{1}{i^2} + \int_0^1 f(x)\,dx`,
				// 闭方括号分隔行。
				"\\]",
				// LF拼接三条源码行。
			].join("\n");
			// 局部render辅助接收number宽度并返回标准化行数组；每次新建组件，无旧缓存复用。
			const render = (width: number) =>
				// 在指定宽度渲染source并去SGR/尾补白，箭头函数隐式返回数组。
				new Markdown(source, 0, 0, defaultMarkdownTheme)
					.render(width)
					.map((line) => stripAnsi(line).trimEnd());

			// 40列时精确比较三行Unicode布局。
			assert.deepStrictEqual(render(40), [
				// 预期第一条包含分子与运算符上限。
				"∂² u   ∂² u   n   1   1",
				// 中线固定分数横线、求和/积分与右侧正文。
				"──── + ──── = ∑   ── +∫ f(x) dx",
				// 底线固定分母和下限。
				"∂ x²   ∂ y²  i=1  i²  0",
			]);

			// 30列不足容纳二维结果，保存回退行数组。
			const narrow = render(30);
			// 首行必须保留raw开符。
			assert.strictEqual(narrow[0], "\\[");
			// 末行必须保留raw闭符。
			assert.strictEqual(narrow[narrow.length - 1], "\\]");
			// 二维分数横线不应出现；some 查是否有─，外层 ! 要求一条都没有。
			assert.ok(!narrow.some((line) => line.includes("─")));
			// 本例回退源码是ASCII，逐行length不超30；未逐字重组比较全部回退正文。
			assert.ok(narrow.every((line) => line.length <= 30));
		});

		// Regression tests for https://github.com/earendil-works/pi/issues/11159
		// #11159：未闭显示公式不能越过GFM表格去配后来的分隔符，或把表格一直当pending；子例固定真实fallback输出。
		describe("unclosed display math before tables (#11159)", () => {
			// 共享三条表源码，每次用...table把条目展开到新的源数组。
			const table = ["| A | B |", "|---|---|", "| 1 | 2 |"];
			// 共享五条期望表框/表头/数据，不含首尾空行。
			const renderedTable = ["┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ 1 │ 2 │", "└───┴───┘"];
			// 局部render辅助输入源码string，返回80列去样式/右补白后的数组，无终端I/O。
			const render = (source: string) =>
				// 每次新建Markdown避免跨例缓存；只显示不访问链接。
				new Markdown(source, 0, 0, defaultMarkdownTheme)
					.render(80)
					.map((line) => stripAnsi(line).trimEnd());

			// 孤立$$后跟表格时$$保留为文字、表格仍渲染；精确固定前后段及空行。
			it("renders a table after an orphan $$ opener", () => {
				// ...table展开源码行，join把整个数组变文档，孤立开符没有数学闭符。
				const source = ["Intro", "", "$$", "", ...table, "", "After"].join("\n");
				// 预期原始$$仍在，同时用renderedTable替代源表格。
				assert.deepStrictEqual(render(source), ["Intro", "", "$$", "", ...renderedTable, "", "After"]);
			});

			// 即使孤立$$后有x=1这种“像数学”的内容，也不能吞掉后续表格。
			it("renders a table after an orphan $$ opener with math-like content", () => {
				// 源先开$$、正文x=1，再空行和表格。
				const source = ["$$", "x = 1", "", ...table].join("\n");
				// 未闭数学保留原行，表格独立渲染。
				assert.deepStrictEqual(render(source), ["$$", "x = 1", "", ...renderedTable]);
			});

			// 前一个未闭$$不能跨表格与后方开符配对；后方自身闭合的y^2仍应转换。
			it("does not pair an unclosed $$ with a later $$ across a table", () => {
				// 一次输入包含孤立块、表格、完整y^2块，以区分跨表格配对与正常新块。
				const source = ["Intro", "", "$$", "x = 1", "", ...table, "", "$$", "y^2", "$$"].join("\n");
				// 前块保留raw，后块显示y²，完整数组同时限定间隔。
				assert.deepStrictEqual(render(source), ["Intro", "", "$$", "x = 1", "", ...renderedTable, "", "y²"]);
			});

			// 单列表的分隔行可无管道但带居中冒号；未闭$$不能吞掉这一表格组合。
			it("renders a single-column table with a pipe-free aligned delimiter after an orphan $$", () => {
				// 表头带管道、分隔:---:不带管道，满足containsTableStart的组合识别。
				const source = ["$$", "", "| A |", ":---:", "| 1 |"].join("\n");
				// 固定单列表边框/内容；未测量居中位置，当前渲染器不读取align作布局。
				assert.deepStrictEqual(render(source), ["$$", "", "┌───┐", "│ A │", "├───┤", "│ 1 │", "└───┘"]);
			});

			// 这一例普通字符串实际输入两个连续反斜杠再[，不等于String.raw中单个\[；按现有Markdown转义/数学启发式固定输出。
			it("renders a table after an orphan \\[ opener", () => {
				// JS源码四个反斜杠表示实际两个，后接x^2和表格；不能把它描述成标准单反斜杠显示公式。
				const source = ["\\\\[", "x^2", "", ...table].join("\n");
				// 预期含首空行、一个反斜杠开括号、原x^2与表格，按整个数组比较现有行为。
				assert.deepStrictEqual(render(source), ["", "\\[", "x^2", "", ...renderedTable]);
			});

			// 两个“双反斜杠方括号”源段跨表格，断言具体转义/未闭合回退，不是正常闭合数学应转换的例。
			it("does not pair an unclosed \\[ with a later \\[ across a table", () => {
				// 三个普通字符串开/闭符都双重转义，运行时各有两个反斜杠；表格放在中间。
				const source = ["\\\\[", "x = 1", "", ...table, "", "\\\\[", "y^2", "\\\\]"].join("\n");
				// 下面完整数组照实际输出固定每条反斜杠与空行，避免只看测试英文名推导语义。
				assert.deepStrictEqual(render(source), [
					// 首行为空。
					"",
					// 第一段开符显示一个反斜杠加[。
					"\\[",
					// x=1仍原文。
					"x = 1",
					// 表格之前的空行。
					"",
					// 展开完整五行表格预期。
					...renderedTable,
					// 表格之后空行。
					"",
					// 独立一个实际反斜杠行。
					"\\",
					// 再一空行。
					"",
					// 后段开符显示一个反斜杠加[。
					"\\[",
					// y^2仍raw，没有转换y²。
					"y^2",
					// 闭符预期保留两个实际反斜杠再]。
					"\\\\]",
				]);
			});

			// 表头无管道但分隔行有管道时仍能识别单列表；孤立$$和x^2不得吞掉它。
			it("renders a table with a pipe-free header after an orphan $$", () => {
				// Value是无管道表头，| --- |提供表格结构，最后1是数据。
				const source = ["$$", "x^2", "", "Value", "| --- |", "1"].join("\n");
				// 比较完整输出，而非只查Value存在。
				assert.deepStrictEqual(render(source), [
					// 孤立$$原样显示。
					"$$",
					// 未闭公式x^2原样显示。
					"x^2",
					// 表前空行。
					"",
					// 单列顶边框按Value宽度生成。
					"┌───────┐",
					// 表头Value带两侧格空白。
					"│ Value │",
					// 表头下分隔线。
					"├───────┤",
					// 短数据1右补空格到该列宽。
					"│ 1     │",
					// 底边框结束表格。
					"└───────┘",
				]);
			});

			// 防吞表格规则不能破坏已经在表格前正常闭合的多行数学。
			it("still renders closed multi-line display math followed by a table", () => {
				// a和+b在$$内先正常闭合，再独立插入表格。
				const source = ["$$", "a", "+ b", "$$", "", ...table].join("\n");
				// 数学合并显示a+b，空行后接完整渲染表格。
				assert.deepStrictEqual(render(source), ["a + b", "", ...renderedTable]);
			});
		});

		// 模拟同一组件流式补到闭美元：先保留pending原文，再setText后重绘成Unicode；没有真实流式网络。
		it("switches from raw to rendered math when a streamed delimiter closes", () => {
			// 初始Map后mathbb公式缺末美元。
			const markdown = new Markdown(String.raw`Map $\mathbb{C}^3`, 0, 0, defaultMarkdownTheme);
			// 第一次比较pending输出。
			assert.deepStrictEqual(
				// 80列渲染并标准化。
				markdown
					.render(80)
					.map((line) => stripAnsi(line).trimEnd()),
				// 必须仍为含开美元与命令的原文。
				[String.raw`Map $\mathbb{C}^3`],
			);

			// 补上闭美元并清整帧结果，真正重新分词/转换在下一次render发生。
			markdown.setText(String.raw`Map $\mathbb{C}^3$`);

			// 第二次比较完整结果。
			assert.deepStrictEqual(
				// 同80列再次渲染。
				markdown
					.render(80)
					.map((line) => stripAnsi(line).trimEnd()),
				// 闭合后只显示Map ℂ³，不再显示美元与命令。
				["Map ℂ³"],
			);
		});
	});

	// 转义标点组区分默认消费反斜杠和选项保留raw，不涉及文件路径解析。
	describe("Backslash escapes", () => {
		// 默认例输入一个普通双引号加反斜杠转义的双引号，期望两只双引号无反斜杠。
		it("should normalize escaped punctuation by default", () => {
			// String.raw中保留反斜杠，再由Marked escape token决定显示；非JS双引号串转义。
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme);

			// 80列输出并去SGR/右空格。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 模板只有两个实际双引号，深比较一行结果。
			assert.deepStrictEqual(lines, [`""`]);
		});

		// 开启preserveBackslashEscapes，escape token选择raw字段，反斜杠也显示。
		it("should preserve source backslash escapes when configured", () => {
			// 与默认例相同源码，undefined跳过默认样式以传options。
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme, undefined, {
				// 只切换转义保存策略，未禁用其他Markdown语法。
				preserveBackslashEscapes: true,
			});

			// 标准化主题/尾空白。
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			// 预期与原始模板逐字相同，包含反斜杠。
			assert.deepStrictEqual(lines, [String.raw`"\"`]);
		});
	});

	// 思考正文常用灰色斜体作为默认样式；前两例仅检查输出包含对应码，后例用xterm格查询是否泄漏。
	describe("Pre-styled text (thinking traces)", () => {
		// 普通思考文字夹行内代码；本例断言文本和各SGR存在，不精确证明代码后每一字符的最终样式。
		it("should preserve gray italic styling after inline code", () => {
			// This replicates how thinking content is rendered in assistant-message.ts
			// 构造默认灰色斜体正文。
			const markdown = new Markdown(
				// 源中只有inline code由反引号单独着色，后面还留普通文字供恢复。
				"This is thinking with `inline code` and more text after",
				// 每侧边距1。
				1,
				// 纵边距0。
				0,
				// 共享主题让代码为黄色。
				defaultMarkdownTheme,
				// 第五参数是DefaultTextStyle对象，而非MarkdownOptions。
				{
					// color回调在正文样式应用时实际调用chalk.gray。
					color: (text) => chalk.gray(text),
					// 默认italic=true交主题斜体包装，不是改变Markdown源语法。
					italic: true,
				},
			);

			// 生成带ANSI的行。
			const lines = markdown.render(80);
			// LF拼接，保留样式供includes检查。
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			// 只要求代码文字出现在输出。
			assert.ok(joinedOutput.includes("inline code"));

			// The output should have ANSI codes for gray (90) and italic (3)
			// 要求至少出现一次灰色开启90m。
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			// 要求至少出现一次斜体开启3m。
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Verify that inline code is styled (theme uses yellow)
			// 单独保存是否含黄色33m的布尔值。
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			// 要求代码样式码确实出现，不查询具体格坐标。
			assert.ok(hasCodeColor, "Should style inline code");
		});

		// 灰色斜体正文夹粗体，抽查文字与灰/斜/粗开启码；不能从出现码就承诺后文所有属性都恢复正确。
		it("should preserve gray italic styling after bold text", () => {
			// 构造带默认样式的Markdown。
			const markdown = new Markdown(
				// **bold text**用Markdown粗体，后面more after仍是普通正文。
				"This is thinking with **bold text** and more after",
				// 每侧边距1。
				1,
				// 纵边距0。
				0,
				// 共享主题。
				defaultMarkdownTheme,
				// 默认样式对象。
				{
					// 对正文应用灰色回调。
					color: (text) => chalk.gray(text),
					// 同时开启默认斜体。
					italic: true,
				},
			);

			// 80列绘制。
			const lines = markdown.render(80);
			// 连接原ANSI行。
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			// 要求粗体内容存在。
			assert.ok(joinedOutput.includes("bold text"));

			// The output should have ANSI codes for gray (90) and italic (3)
			// 要求存在灰色SGR。
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			// 要求存在斜体SGR。
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Should have bold codes (1 or 22 for bold on/off)
			// 实际断言只查1m粗体开启，没有单独检查22m关闭码。
			assert.ok(joinedOutput.includes("\x1b[1m"), "Should have bold code");
		});

		// 异步回归在Markdown后附普通INPUT行，查询INPUT首格斜体是否0；只证明该格没有斜体，不涵盖全部样式。
		// 虚拟TUI等待约20ms并flush，stop仅在正常末尾执行，断言抛错时这里没有finally清理。
		it("should not leak styles into following lines when rendered in TUI", async () => {
			// 局部测试组件满足Component契约，组合Markdown与后续普通行，不继承真实终端。
			class MarkdownWithInput implements Component {
				// public字段记录上次Markdown输出行数，初值0供渲染是否发生的断言。
				public markdownLineCount = 0;
				// private readonly仅在TS限制外部访问/重新赋值，保存的Markdown对象仍可setText/invalidate。
				private readonly markdown: Markdown;

				// 构造接收一个Markdown并保存引用，无渲染/返回值；例new MarkdownWithInput(markdown)随后由TUI调用render。
				constructor(markdown: Markdown) {
					// 显式赋值避免参数属性语法，未复制组件。
					this.markdown = markdown;
				}

				// 接收可用宽度，返回Markdown行加INPUT的新数组并更新行数；例Markdown两行则INPUT在零基第2行。
				render(width: number): string[] {
					// 先把同一宽度传给内部Markdown。
					const lines = this.markdown.render(width);
					// 记录实际行数，副作用供外部确定INPUT行坐标。
					this.markdownLineCount = lines.length;
					// ...lines展开原行到新数组，最后增加无样式INPUT，不修改内部缓存数组。
					return [...lines, "INPUT"];
				}

				// 无参失效通知转交内部组件，返回void；下一次绘制才重算，不在这里主动requestRender。
				invalidate(): void {
					// 清Markdown外观结果，保留源码。
					this.markdown.invalidate();
				}
			}

			// 创建思考正文，末尾是行内代码，横边距1/纵边距0。
			const markdown = new Markdown("This is thinking with `inline code`", 1, 0, defaultMarkdownTheme, {
				// 默认正文前景灰色。
				color: (text) => chalk.gray(text),
				// 默认正文斜体。
				italic: true,
			});

			// 内存屏80列6行，足够容纳此短正文和后续INPUT。
			const terminal = new VirtualTerminal(80, 6);
			// 构造主屏调度器。
			const tui: TUI = new TuiMainScreen(terminal);
			// 用局部组合组件将INPUT接在Markdown后面。
			const component = new MarkdownWithInput(markdown);
			// 将组合组件加入TUI。
			tui.addChild(component);
			// 启动虚拟输入与帧调度。
			tui.start();
			// 等待常见节流帧并排空xterm写队列，再查询格属性。
			await terminal.waitForRender();

			// 要求Markdown至少一行，也证明render记录已被更新。
			assert.ok(component.markdownLineCount > 0);
			// INPUT紧接行数组，零基行号恰等Markdown行数。
			const inputRow = component.markdownLineCount;
			// 查询第0列I的isItalic数值为0，而非仅看输出含不含3m。
			assert.strictEqual(getCell(terminal, inputRow, 0).isItalic(), 0);
			// 正常末尾停止虚拟TUI；前面若抛错则跳过此行。
			tui.stop();
		});
	});

	// 代码块后间距组，使用去样式/尾补白后的空串表示可见空行。
	describe("Spacing after code blocks", () => {
		// 段落→代码→段落例要求闭围栏后只有一条前导空行再到正文，不统计后面所有可能空行。
		it("should have only one blank line between code block and following paragraph", () => {
			// 构造代码前后均有段落的文档。
			const markdown = new Markdown(
				// 整个模板含hello段落、js围栏和again段落；const hello仅待显示，不执行。
				`hello world

\`\`\`js
const hello = "world";
\`\`\`

again, hello world`,
				// 无横边距。
				0,
				// 无纵边距，空白只能来自Markdown块间距。
				0,
				// 默认代码主题。
				defaultMarkdownTheme,
			);

			// 按80列输出。
			const lines = markdown.render(80);
			// 去SGR/尾补白，空白行归一为空串。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// indexOf找第一条恰等三反引号的闭围栏行；开围栏带js所以不会误选。
			const closingBackticksIndex = plainLines.indexOf("```");
			// 必须找到闭围栏，-1表示没找到。
			assert.ok(closingBackticksIndex !== -1, "Should have closing backticks");

			// slice创建闭围栏后所有行的新数组，排除围栏本身。
			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			// findIndex找首个非空行的相对索引；其值等于最前连续空行数量，若全空则-1，并非统计全部空行。
			const emptyLineCount = afterBackticks.findIndex((line) => line !== "");

			// 比较这个前导空行数。
			assert.strictEqual(
				// 实际值为首个非空行的位置。
				emptyLineCount,
				// 要求只有一条空行后就到正文。
				1,
				// 失败只展示后续最多五行，便于定位重复间距。
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`,
			);
		});

		// 相同段落/围栏结构，无显式空白行和有显式空白行两种输入，都规范为一空行间隔；完整比较七行。
		it("should normalize paragraph and code block spacing to one blank line", () => {
			// cases保存两份多行Markdown，不在模板内容中插注释。
			const cases = [
				// 第一个模板紧邻段落和围栏，源码没空白行。
				`hello this is text
\`\`\`
code block
\`\`\`
more text`,
				// 第二个模板在围栏前后各有一空白行，但目标布局相同。
				`hello this is text

\`\`\`
code block
\`\`\`

more text`,
			];
			// 共享预期完整七行，代码默认缩进两个空格。
			const expectedLines = ["hello this is text", "", "```", "  code block", "```", "", "more text"];

			// for...of逐例执行，text是当前源码字符串。
			for (const text of cases) {
				// 每例创建新组件，不跨输入复用缓存。
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				// 80列绘制。
				const lines = markdown.render(80);
				// 去SGR及尾空白，保留代码左缩进。
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				// 比较整个实际数组和共享预期。
				assert.deepStrictEqual(
					// 实际规范化结果。
					plainLines,
					// 预期七条行。
					expectedLines,
					// 失败时JSON.stringify源文本，转义换行便于看哪种输入失败。
					`Unexpected spacing for markdown: ${JSON.stringify(text)}`,
				);
			}
		});

		// 代码块是文档末块时不要额外尾空行；覆盖纯代码和前面有段落两种输入，断言仅检查末项。
		it("should not add a trailing blank line when code block is the last rendered block", () => {
			// 两份字符串的代码仅作显示，第二份多一个前段与空行。
			const cases = ["```js\nconst hello = 'world';\n```", "hello world\n\n```js\nconst hello = 'world';\n```"];

			// 依次取两种文档。
			for (const text of cases) {
				// 新建组件避免缓存串扰。
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				// 80列渲染。
				const lines = markdown.render(80);
				// 去SGR/右侧补白，末尾空白行会成为空串。
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				// notStrictEqual只禁止最后值为空串。
				assert.notStrictEqual(
					// at(-1)读取末项；空数组返回undefined也会通过，因此本断言不单独保证非空。
					plainLines.at(-1),
					// 禁止的空白行值。
					"",
					// 序列化实际数组作为失败信息。
					`Expected code block to end without a blank line: ${JSON.stringify(plainLines)}`,
				);
			}
		});
	});

	// 水平分割线后的间距，与代码块类似由后继块/space token共同决定。
	describe("Spacing after dividers", () => {
		// 输入前段、---分割线、后段，要求分割线后首个非空行前恰有一空行。
		it("should have only one blank line between divider and following paragraph", () => {
			// 创建三段结构。
			const markdown = new Markdown(
				// 整段模板里的---由Marked识别为hr，不是代码或列表项。
				`hello world

---

again, hello world`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 默认主题将hr横线弱化。
				defaultMarkdownTheme,
			);

			// 按80列绘制，hr会取可用宽度和80的较小值。
			const lines = markdown.render(80);
			// 去SGR/尾空白，保留横线字符。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// findIndex找第一条含─的行，作为分割线位置。
			const dividerIndex = plainLines.findIndex((line) => line.includes("─"));
			// 要求确实存在，否则后续slice坐标错误。
			assert.ok(dividerIndex !== -1, "Should have divider");

			// 取得分割线之后的行。
			const afterDivider = plainLines.slice(dividerIndex + 1);
			// 首个非空行的索引就是前导连续空行数；不是全文空行总数。
			const emptyLineCount = afterDivider.findIndex((line) => line !== "");

			// 严格比较这一前导数量。
			assert.strictEqual(
				// 实际数量。
				emptyLineCount,
				// 要求1。
				1,
				// 错误信息只取后续五行展示。
				`Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`,
			);
		});

		// 只有分割线的文档末尾不得另加空白行；不检查横线长度或总输出行数。
		it("should not add a trailing blank line when divider is the last rendered block", () => {
			// 创建仅---的Markdown。
			const markdown = new Markdown("---", 0, 0, defaultMarkdownTheme);
			// 80列生成横线输出。
			const lines = markdown.render(80);
			// 去样式/尾补白。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// 检查末项不是空串。
			assert.notStrictEqual(
				// at(-1)可能undefined，本例未另要求数组非空。
				plainLines.at(-1),
				// 禁止的尾空行。
				"",
				// 失败显示完整数组。
				`Expected divider to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	// 标题后的空行规则，一级标题本身还带粗体/下划线主题。
	describe("Spacing after headings", () => {
		// 标题后有段落，首个非空后继行前应恰有一空行；未验证标题所有样式。
		it("should have only one blank line between heading and following paragraph", () => {
			// 创建一级Hello标题与普通段落。
			const markdown = new Markdown(
				// 完整模板的空白行用于块分隔，不要额外再加一行造成双空白。
				`# Hello

This is a paragraph`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享标题主题。
				defaultMarkdownTheme,
			);

			// 80列渲染。
			const lines = markdown.render(80);
			// 去SGR/尾补白以比较空行。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// 以Hello子串找标题行。
			const headingIndex = plainLines.findIndex((line) => line.includes("Hello"));
			// 要求匹配到标题。
			assert.ok(headingIndex !== -1, "Should have heading");

			// 从标题之后截取数组。
			const afterHeading = plainLines.slice(headingIndex + 1);
			// 查首个非空行的相对索引，得到前导空行数。
			const emptyLineCount = afterHeading.findIndex((line) => line !== "");

			// 严格比较数量。
			assert.strictEqual(
				// 实际索引。
				emptyLineCount,
				// 要求1条前导空行。
				1,
				// 失败时展示后续前五条行。
				`Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`,
			);
		});

		// 标题是末块时不补尾空行；此断言只禁止末项等空串，不覆盖所有标题等级。
		it("should not add a trailing blank line when heading is the last rendered block", () => {
			// 只有一个一级标题。
			const markdown = new Markdown("# Hello", 0, 0, defaultMarkdownTheme);
			// 80列渲染。
			const lines = markdown.render(80);
			// 去SGR/尾补白。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// 比较末项与空串是否不同。
			assert.notStrictEqual(
				// 读最后一项，不额外保证数组非空。
				plainLines.at(-1),
				// 被禁止的空白值。
				"",
				// JSON展示实际数组供失败定位。
				`Expected heading to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	// 引用后的间距测试，引用子块尾空行应先被去掉，再让外层统一补一次间距。
	describe("Spacing after blockquotes", () => {
		// 普通段落→引用→后段落，要求引用后首个非空行前恰一空行。
		it("should have only one blank line between blockquote and following paragraph", () => {
			// 创建三块文档。
			const markdown = new Markdown(
				// 整个模板中只有中间行带>，后段由空行与引用分开。
				`hello world

> This is a quote

again, hello world`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 引用主题为斜体/弱化竖边框。
				defaultMarkdownTheme,
			);

			// 80列渲染。
			const lines = markdown.render(80);
			// 去SGR/尾部空白。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// 按引用正文找它的首行。
			const quoteIndex = plainLines.findIndex((line) => line.includes("This is a quote"));
			// 要求找到引用行。
			assert.ok(quoteIndex !== -1, "Should have blockquote");

			// 取引用行之后的结果。
			const afterQuote = plainLines.slice(quoteIndex + 1);
			// 第一个非空行的相对索引即前导空行数量。
			const emptyLineCount = afterQuote.findIndex((line) => line !== "");

			// 严格比较这一数量。
			assert.strictEqual(
				// 实际首个非空行位置。
				emptyLineCount,
				// 要求1。
				1,
				// 错误信息展示后续前五行，而非整个文档。
				`Expected 1 empty line after blockquote, but found ${emptyLineCount}. Lines after quote: ${JSON.stringify(afterQuote.slice(0, 5))}`,
			);
		});

		// 文档只有引用时不在结尾增加间距，单独检查末项非空串。
		it("should not add a trailing blank line when blockquote is the last rendered block", () => {
			// 构造一个简单单行引用。
			const markdown = new Markdown("> This is a quote", 0, 0, defaultMarkdownTheme);
			// 80列渲染。
			const lines = markdown.render(80);
			// 去SGR/尾补白。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// 末项与空串不应相同。
			assert.notStrictEqual(
				// at(-1)读末项；这里没有额外非空数组断言。
				plainLines.at(-1),
				// 禁止空行值。
				"",
				// 失败打印完整数组。
				`Expected blockquote to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	// 深层引用回归，限制输出数量而非简单按每层两列无限叠边框。
	describe("Deeply nested blockquotes", () => {
		// Regression test for https://github.com/earendil-works/pi/issues/11272
		// #11272：60层引用超过80列预算时仍只产一行并保留x；不在此断言最终列宽或计算耗时上限。
		it("should render quotes nested deeper than the width allows without exploding", () => {
			// repeat生成60个>再接x，横边距每侧1；这是字符串构造，不是60次真实终端调用。
			const markdown = new Markdown(`${">".repeat(60)}x`, 1, 0, defaultMarkdownTheme);
			// render80在引用剩余宽度不足3时停止继续加边框。
			const lines = markdown.render(80);
			// 去SGR和尾空白，保留左边距/框线。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// 严格要求一行，捕获深层重复折行导致行数爆炸的回归。
			assert.strictEqual(plainLines.length, 1, `Expected a single line: ${JSON.stringify(plainLines)}`);
			// 要求这一行以x结尾，证明叶子正文未丢；未检查前面框线精确数量。
			assert.ok(plainLines[0].endsWith("x"), `Expected content to be kept: ${JSON.stringify(plainLines)}`);
		});
	});

	// 引用多行/内部块测试，区分默认消息样式与引用自身主题。
	describe("Blockquotes with multiline content", () => {
		// 惰性续行例：第二行无>仍属于同一引用，要求两行边框、斜体码且没有默认洋红色码。
		it("should apply consistent styling to all lines in lazy continuation blockquote", () => {
			// Markdown "lazy continuation" - second line without > is still part of the quote
			// 构造两行文本，默认消息色故意选与引用主题不同的洋红。
			const markdown = new Markdown(
				// 整个模板第二行bar没有>，Marked仍把它作为引用段落续行。
				`>Foo
bar`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享quote主题使用斜体。
				defaultMarkdownTheme,
				// 第五参数提供默认正文样式，不是给引用单独指定主题。
				{
					// 回调若用于普通消息会输出35m；引用普通文字路径应不调用它。
					color: (text) => chalk.magenta(text), // This should NOT be applied to blockquotes
				},
			);

			// 按80列渲染两条引用行。
			const lines = markdown.render(80);

			// Both lines should have the quote border
			// 去SGR后保留行首竖线和空格。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// filter只取以“│ ”开头的行。
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			// 要求恰两条引用行。
			assert.strictEqual(quotedLines.length, 2, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`);

			// Both lines should have italic (from theme.quote styling)
			// 从原样ANSI行中找Foo。
			const fooLine = lines.find((line) => line.includes("Foo"));
			// 另找bar所在行。
			const barLine = lines.find((line) => line.includes("bar"));
			// 要求Foo行存在。
			assert.ok(fooLine, "Should have Foo line");
			// 要求bar行存在。
			assert.ok(barLine, "Should have bar line");

			// Check that both have italic (\x1b[3m) - blockquotes use theme styling, not default message color
			// 只检查Foo行包含3m斜体开启，并非读取最终每格属性。
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			// bar行也含斜体开启码。
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (magenta)
			// Foo行不能出现默认洋红35m。
			assert.ok(!fooLine?.includes("\x1b[35m"), `Foo line should NOT have magenta color: ${fooLine}`);
			// bar行也不能出现该默认色。
			assert.ok(!barLine?.includes("\x1b[35m"), `bar line should NOT have magenta color: ${barLine}`);
		});

		// 显式两行都带>的引用应有一致边框/斜体且不采用默认青色；用可选链结合ok同时捕获缺行。
		it("should apply consistent styling to explicit multiline blockquote", () => {
			// 创建默认青色、引用斜体的文档。
			const markdown = new Markdown(
				// 模板两条行都显式标>。
				`>Foo
>bar`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享主题。
				defaultMarkdownTheme,
				// 默认正文样式对象。
				{
					// 普通消息色是cyan36m，引用应走自己的上下文。
					color: (text) => chalk.cyan(text), // This should NOT be applied to blockquotes
				},
			);

			// 80列渲染。
			const lines = markdown.render(80);

			// Both lines should have the quote border
			// 删除SGR，保留边框供筛选。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 收集带引用前缀的行。
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			// 恰两行引用。
			assert.strictEqual(quotedLines.length, 2, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`);

			// Both lines should have italic (from theme.quote styling)
			// 在原ANSI结果找Foo行。
			const fooLine = lines.find((line) => line.includes("Foo"));
			// 找bar行。
			const barLine = lines.find((line) => line.includes("bar"));
			// Foo行存在且含斜体码才为真。
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			// bar行同样要含斜体码。
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (cyan)
			// Foo行无默认青色；缺行会使否定可选链为true，但上面的斜体断言已要求它存在。
			assert.ok(!fooLine?.includes("\x1b[36m"), `Foo line should NOT have cyan color: ${fooLine}`);
			// bar行无默认青色，依赖前面的存在/斜体断言约束。
			assert.ok(!barLine?.includes("\x1b[36m"), `bar line should NOT have cyan color: ${barLine}`);
		});

		// 引用内包含有序与无序列表块，验证renderToken递归块渲染而不是只按普通行内文字处理。
		it("should render list content inside blockquotes", () => {
			// 创建两个带引用标记的列表行。
			const markdown = new Markdown(
				// 整个模板先1.列表再-列表；nested bullet只是文字名称，不由名称保证它真是嵌套层级。
				`> 1. bla bla
> - nested bullet`,
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享主题负责列表符号和引用样式。
				defaultMarkdownTheme,
			);

			// 80列绘制。
			const lines = markdown.render(80);
			// 去SGR保留│前缀。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 只在实际引用行中找列表正文，避免其他区域的同名文本误通过。
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));

			// 检查有序列表项存在。
			assert.ok(
				// some要求某条引用行包含1. bla bla。
				quotedLines.some((line) => line.includes("1. bla bla")),
				// 失败展示筛选后的引用行数组。
				`Missing ordered list item: ${JSON.stringify(quotedLines)}`,
			);
			// 独立检查无序列表项存在。
			assert.ok(
				// some要求含减号项文字，不测量它相对有序项的层级缩进。
				quotedLines.some((line) => line.includes("- nested bullet")),
				// 失败同样列引用行。
				`Missing unordered list item: ${JSON.stringify(quotedLines)}`,
			);
		});

		// 长引用在30列折行，每条非空行都需“│ ”前缀；只抽查三个内容片段，未逐字重组整段。
		it("should wrap long blockquote lines and add border to each wrapped line", () => {
			// 保存长ASCII句子。
			const longText = "This is a very long blockquote line that should wrap to multiple lines when rendered";
			// 模板插值在其前加引用标记，组件无外部边距。
			const markdown = new Markdown(`> ${longText}`, 0, 0, defaultMarkdownTheme);

			// Render at narrow width to force wrapping
			// 30列迫使引用正文按28列左右折行。
			const lines = markdown.render(30);
			// 去SGR/右补白，保留左边框。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines (exclude trailing blank line after blockquote)
			// filter去掉完全空白行，保留所有非空内容。
			const contentLines = plainLines.filter((line) => line.length > 0);

			// Should have multiple lines due to wrapping
			// 至少两条内容行，确保确实走过折行路径。
			assert.ok(contentLines.length > 1, `Expected multiple wrapped lines, got: ${JSON.stringify(contentLines)}`);

			// Every content line should start with the quote border
			// 逐条检查所有非空行。
			for (const line of contentLines) {
				// 每条都须带引用前缀，不只第一条有边框。
				assert.ok(line.startsWith("│ "), `Wrapped line should have quote border: "${line}"`);
			}

			// All content should be preserved
			// 空格连接内容行用于片段搜索，结果仍包含边框字符。
			const allText = contentLines.join(" ");
			// 抽查very long未丢。
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			// 抽查blockquote未丢。
			assert.ok(allText.includes("blockquote"), "Should preserve 'blockquote'");
			// 抽查multiple未丢。
			assert.ok(allText.includes("multiple"), "Should preserve 'multiple'");
		});

		// 窄引用应用自身斜体，不能继承默认黄色；逐行检查前缀，SGR只做全体输出存在/不存在检查。
		it("should properly indent wrapped blockquote lines with styling", () => {
			// 构造有默认黄色斜体的引用。
			const markdown = new Markdown(
				// 输入一条长引用，足以在25列换行。
				"> This is styled text that is long enough to wrap",
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享quote主题为斜体。
				defaultMarkdownTheme,
				// 默认消息样式对象。
				{
					// 黄色回调故意作为不应出现在引用中的默认前景。
					color: (text) => chalk.yellow(text), // This should NOT be applied to blockquotes
					// 默认斜体与引用主题恰都斜体，后面的颜色断言才区分默认色路径。
					italic: true,
				},
			);

			// 25列触发折行。
			const lines = markdown.render(25);
			// 去SGR/尾空白，为边框断言留前缀。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines
			// 筛掉空白行。
			const contentLines = plainLines.filter((line) => line.length > 0);

			// All lines should have the quote border
			// 遍历非空引用行；这里没有单独断言集合非空。
			for (const line of contentLines) {
				// 每条非空行需带引用边框。
				assert.ok(line.startsWith("│ "), `Line should have quote border: "${line}"`);
			}

			// Check that italic is applied (from theme.quote)
			// 将原样ANSI行合为一串。
			const allOutput = lines.join("\n");
			// 至少一处斜体码应出现。
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic");

			// Blockquotes should NOT have the default message color (yellow)
			// 任何黄色33m都不应出现在此例输出。
			assert.ok(!allOutput.includes("\x1b[33m"), "Should NOT have yellow color from default style");
		});

		// 引用内粗体和代码分别保留，输出应含粗/黄/斜体开启；这些存在性断言不等于逐格证明后文引用样式恢复。
		it("should render inline formatting inside blockquotes and reapply quote styling after", () => {
			// 源为一条引用，内含**bold**及反引号code。
			const markdown = new Markdown("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme);

			// 按80列绘制。
			const lines = markdown.render(80);
			// 去SGR得到普通文字行用于内容/前缀检查。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Should have the quote border
			// 多行ok要求至少有一条引用边框行。
			assert.ok(
				// some只查前缀存在。
				plainLines.some((line) => line.startsWith("│ ")),
				// 此字符串只是失败消息。
				"Should have quote border",
			);

			// Content should be preserved
			// 空格连接去样式文本。
			const allPlain = plainLines.join(" ");
			// 检查引用普通文字片段。
			assert.ok(allPlain.includes("Quote with"), "Should preserve 'Quote with'");
			// 检查粗体正文不丢。
			assert.ok(allPlain.includes("bold"), "Should preserve 'bold'");
			// 检查代码正文不丢。
			assert.ok(allPlain.includes("code"), "Should preserve 'code'");

			// 连接原ANSI行以检查样式码。
			const allOutput = lines.join("\n");

			// Should have bold styling (\x1b[1m)
			// 要求1m出现。
			assert.ok(allOutput.includes("\x1b[1m"), "Should have bold styling");

			// Should have code styling (yellow = \x1b[33m from defaultMarkdownTheme)
			// 要求代码黄色33m出现。
			assert.ok(allOutput.includes("\x1b[33m"), "Should have code styling (yellow)");

			// Should have italic from quote styling (\x1b[3m)
			// 要求引用斜体3m出现。
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic from quote styling");
		});
	});

	// 标题行内局部样式结束后需恢复标题上下文；这里混合字符串窗口检查与xterm格检查。
	describe("Heading with inline code", () => {
		// 三级标题夹代码，在代码后文字之前40个码元窗口查粗/青开启；不解析窗口内完整ANSI状态。
		it("should preserve heading styling after inline code", () => {
			// ###显示三级前缀，sourceInfo作为行内代码黄色。
			const markdown = new Markdown("### Why `sourceInfo` should not be optional", 0, 0, defaultMarkdownTheme);

			// 80列绘制。
			const lines = markdown.render(80);
			// 保留ANSI并用LF连接。
			const joinedOutput = lines.join("\n");

			// The heading theme is bold+cyan. After the yellow inline code, the heading
			// styling (bold+cyan) must be restored so subsequent text is styled correctly.
			// bold = \x1b[1m, cyan = \x1b[36m, yellow = \x1b[33m
			// 要求至少出现黄色，证明代码主题参与了渲染。
			assert.ok(joinedOutput.includes("\x1b[33m"), "Should have yellow for inline code");

			// Find the position of "should not be optional" in the raw output.
			// It must be preceded by heading style codes (bold+cyan), not appear unstyled.
			// indexOf在含ANSI原串中定位后续文字起点。
			const afterCodeIndex = joinedOutput.indexOf("should not be optional");
			// 要求起点大于0，既存在又有前缀内容。
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			// Look at the ANSI codes between the code span end and "should not be optional".
			// There should be bold (\x1b[1m) and cyan (\x1b[36m) re-applied.
			// 取最多前40个UTF-16码元，不是40个可见终端列；Math.max避免起点为负。
			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			// 检查这个局部窗口的粗体开启码。
			assert.ok(
				// includes不重建最终样式状态，但能捕获漏重开码的常见回归。
				precedingChunk.includes("\x1b[1m"),
				// 失败展示所取窗口。
				`Should re-apply bold before text after code: ${precedingChunk}`,
			);
			// 独立检查青色开启码。
			assert.ok(
				// 要求窗口中含36m。
				precedingChunk.includes("\x1b[36m"),
				// 错误信息展示同一窗口。
				`Should re-apply cyan before text after code: ${precedingChunk}`,
			);
		});

		// 一级标题在代码之后还需粗体/青色/下划线恢复；同样通过前40码元窗口抽查。
		it("should preserve heading styling after inline code for h1", () => {
			// #标题有额外下划线主题，后续inside是待检查普通标题文字。
			const markdown = new Markdown("# Title with `code` inside", 0, 0, defaultMarkdownTheme);

			// 80列生成ANSI行。
			const lines = markdown.render(80);
			// 连接原始输出。
			const joinedOutput = lines.join("\n");

			// 在原串定位inside起点。
			const afterCodeIndex = joinedOutput.indexOf("inside");
			// 要求inside存在且不是整串第0码元。
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			// 截取起点之前最多40码元，保留控制串供接下来的SGR检查。
			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			// H1 uses heading + bold + underline
			// 一级标题窗口里要求粗体1m。
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h1: ${precedingChunk}`);
			// 要求标题青色36m。
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h1: ${precedingChunk}`);
			// 要求一级专属下划线4m；仍是字符串窗口检查，不读取每个格的最终状态。
			assert.ok(precedingChunk.includes("\x1b[4m"), `Should re-apply underline for h1: ${precedingChunk}`);
		});

		// 异步格级回归：一级标题最后恰是代码，后面的整行补白不能继承下划线。
		// 虚拟屏绘制后计算正文尾列，逐格查isUnderline=0；stop只在正常末尾，无finally，不操作真实终端。
		it("should not leak h1 underline into padding when inline code is the last token", async () => {
			// open()只是代码片段文字，不会执行函数调用。
			const markdown = new Markdown("# Important distinction from `open()`", 0, 0, defaultMarkdownTheme);
			// 内存屏80列4行，标题应放在首行。
			const terminal = new VirtualTerminal(80, 4);
			// 创建向该模拟器写入的主屏TUI。
			const tui: TUI = new TuiMainScreen(terminal);
			// 添加标题组件。
			tui.addChild(markdown);
			// 启动虚拟终端回调/排帧。
			tui.start();
			// 先等常见节流帧和xterm写队列，再读单元格。
			await terminal.waitForRender();

			// 再次render80通常命中整帧缓存，取第一条ANSI行。
			const renderedLine = markdown.render(80)[0];
			// 要求首行存在，断言后类型收窄为string。
			assert.ok(renderedLine, "Should render heading line");
			// 去简单SGR、去尾补白再取length；此标题纯ASCII，码元数可对应正文列数，不是通用visibleWidth。
			const contentWidth = renderedLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().length;
			// 要求正文宽度大于0。
			assert.ok(contentWidth > 0, "Should have visible heading content");

			// 从正文之后第一格到第79格，逐一检查整行右补白。
			for (let col = contentWidth; col < 80; col++) {
				// 严格比较每个格的下划线标志。
				assert.strictEqual(
					// 读取首行当前列的xterm实际isUnderline数值。
					getCell(terminal, 0, col).isUnderline(),
					// 0表示没有下划线，属性查询不是boolean。
					0,
					// 失败报告具体补白列号。
					`Expected no underline in padding at col ${col}`,
				);
			}

			// 正常末尾stop解除虚拟调度和exit监听，前面断言失败会跳过。
			tui.stop();
		});

		// 二级标题内粗体结束后仍应恢复标题粗/青；前40码元窗口查重开码，不检查下划线。
		it("should preserve heading styling after bold text", () => {
			// ##标题带嵌套**bold**以及后续and more。
			const markdown = new Markdown("## Heading with **bold** and more", 0, 0, defaultMarkdownTheme);

			// 80列绘制。
			const lines = markdown.render(80);
			// LF连接ANSI原串。
			const joinedOutput = lines.join("\n");

			// 在原串定位后文起点。
			const afterBoldIndex = joinedOutput.indexOf("and more");
			// 要求找得到且之前有内容。
			assert.ok(afterBoldIndex > 0, "Should contain text after bold");

			// 取前40码元窗口，起点夹到0避免负索引语义。
			const precedingChunk = joinedOutput.slice(Math.max(0, afterBoldIndex - 40), afterBoldIndex);
			// 要求窗口存在粗体开启。
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h2: ${precedingChunk}`);
			// 要求窗口存在青色开启。
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h2: ${precedingChunk}`);
		});
	});

	// 删除线词法规则只接受严格双波浪，单波浪仍为普通文字；不从主题函数本身推断识别规则。
	describe("Strikethrough syntax", () => {
		// 双波浪例检查9m删除线开启、文字保留且字面分隔串不显示；未检查每格属性。
		it("should render ~~text~~ as strikethrough", () => {
			// 创建含~~strikethrough~~的段落。
			const markdown = new Markdown("Use ~~strikethrough~~ here", 0, 0, defaultMarkdownTheme);

			// 80列输出。
			const lines = markdown.render(80);
			// 原串用于SGR搜索。
			const joinedOutput = lines.join("\n");
			// 另一份逐行去SGR再用空格连接，用于普通正文断言。
			const joinedPlain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");

			// 要求至少一处9m删除线开启码。
			assert.ok(joinedOutput.includes("\x1b[9m"), "Should apply strikethrough styling");
			// 要求正文strikethrough仍存在。
			assert.ok(joinedPlain.includes("strikethrough"), "Should include struck text content");
			// 禁止原始双波浪包正文整段仍出现，说明分隔符被语法消费。
			assert.ok(!joinedPlain.includes("~~strikethrough~~"), "Should not render delimiters as text");
		});

		// 单波浪输入不能误启删除线，保留原文字形式；与上例形成识别边界。
		it("should keep ~text~ as plain text", () => {
			// 只有一对单波浪。
			const markdown = new Markdown("Use ~strikethrough~ literally", 0, 0, defaultMarkdownTheme);

			// 按80列输出。
			const lines = markdown.render(80);
			// 保存ANSI原串。
			const joinedOutput = lines.join("\n");
			// 去SGR并连接作为普通文字。
			const joinedPlain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");

			// 单波浪包正文的字面串必须保留。
			assert.ok(joinedPlain.includes("~strikethrough~"), "Single-tilde delimiters should remain visible");
			// 整个输出不能含删除线开启9m。
			assert.ok(!joinedOutput.includes("\x1b[9m"), "Single-tilde text should not use strikethrough styling");
		});
	});

	// #10925
	// #10925：带样式词恰好到换行边界时，检查空格消耗和行尾补白的装饰收尾。
	describe("styled words at the wrap boundary", () => {
		// 11列含每侧1空格，内容预算9；逐条精确比较背景/粗体/删除线SGR与补白，而非只查关键字。
		it("should not start the next line with a space or carry styles into padding", () => {
			// 输入粗体bold、删除线strk及后续词，默认样式只设置背景。
			const markdown = new Markdown("aaaa **bold** next ~~strk~~ more words", 1, 0, defaultMarkdownTheme, {
				// bgColor同步包44m蓝底/49m恢复默认背景，接收的是含补白的整行。
				bgColor: (text) => `\x1b[44m${text}\x1b[49m`,
			});

			// 深比较完整原始ANSI行数组，任何额外空格或样式码也会影响此断言。
			assert.deepStrictEqual(markdown.render(11), [
				// 首行aaaa和bold占满内容9列；22m在右侧边距之前关闭粗体。
				"\x1b[44m aaaa \x1b[1mbold\x1b[22m \x1b[49m",
				// 第二行next和strk，29m在右侧边距之前关闭删除线。
				"\x1b[44m next \x1b[9mstrk\x1b[29m \x1b[49m",
				// 第三行more后补满剩余空格，背景覆盖整行。
				"\x1b[44m more      \x1b[49m",
				// 第四行words同样补到11列后关闭背景，没有尾空行。
				"\x1b[44m words     \x1b[49m",
			]);
		});
	});

	// #10154
	// #10154：中文/日文/韩文邻接标点的强调识别，通过可见标签主题观察token是否被识别。
	describe("CJK emphasis", () => {
		// MarkdownTheme注解要求完整主题，下面浅复制后只替换粗体/斜体；标签是输出字符串，不创建HTML DOM。
		const tagTheme: MarkdownTheme = {
			// 其余主题从共享对象复制。
			...defaultMarkdownTheme,
			// 粗体回调以<b>包正文，便于不依赖ANSI直接断言识别结果。
			bold: (text) => `<b>${text}</b>`,
			// 斜体以<i>包正文，同样不访问浏览器。
			italic: (text) => `<i>${text}</i>`,
		};
		// 局部render辅助输入string，创建新组件并返回80列去尾补白的行；不去SGR，因为关注的是自定义标签文本。
		const render = (text: string) => new Markdown(text, 0, 0, tagTheme).render(80).map((line) => line.trimEnd());

		// 逐例固定CJK标点邻接时的强调输出；完整数组比较，同时要求后续普通文字未被吞入强调。
		it("renders emphasis delimited next to CJK punctuation", () => {
			// 句号贴闭粗体与后文中文，粗体应被识别。
			assert.deepStrictEqual(render("**这是测试。**后面"), ["<b>这是测试。</b>后面"]);
			// 冒号位于粗体内容末尾，后文不加粗。
			assert.deepStrictEqual(render("**一句话说清：**一台机器"), ["<b>一句话说清：</b>一台机器"]);
			// 强调后紧接数字20也应保留分界。
			assert.deepStrictEqual(render("**要点到此为止。**20 小时"), ["<b>要点到此为止。</b>20 小时"]);
			// 中日韩引号包在粗体中，外侧两个字保持普通。
			assert.deepStrictEqual(render("字**「引用」**字"), ["字<b>「引用」</b>字"]);
			// 单星号斜体在中文句号旁也应识别。
			assert.deepStrictEqual(render("*斜体。*后面"), ["<i>斜体。</i>后面"]);
		});

		// 非CJK示例仍保留CommonMark的分隔邻接限制，不能把CJK补丁推广为所有标点都放宽。
		it("keeps CommonMark flanking rules for non-CJK text", () => {
			// 英文end.后立即Then不满足此例粗体识别，完整原双星号文本保留。
			assert.deepStrictEqual(render("**end.**Then next"), ["**end.**Then next"]);
		});
	});

	// 链接分组只编码/展示地址，不发HTTP或发送邮件；显式设置能力覆盖保证两种渲染分支可测。
	describe("Links", () => {
		// afterEach注册组内每例结束后的能力缓存清理，无论测试断言是否失败都由测试器调度。
		afterEach(() => {
			// 仅把共享缓存清空，不恢复旧缓存对象/不修改实际终端能力。
			resetCapabilitiesCache();
		});

		// 裸URL遇CJK标点应结束链接，标点和后文仍显示；遍历标点×URL组合并检查完整去控制码文本。
		it("should stop bare URLs at CJK punctuation and preserve the following text", () => {
			// 显式开OSC8、关图片/真彩，避免真实终端探测影响断言。
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			// for...of按Unicode码点遍历这组标点，不把普通汉字当链接结束符。
			for (const punctuation of "。，；：！？、“”‘’（）【】《》「」『』…—·・〈〉［］｛｝．｡｢｣､･") {
				// 内层覆盖普通https、含中文路径查询片段的https和www前缀。
				for (const url of ["https://example.com", "https://example.com/中文?q=搜索#片段", "www.example.com"]) {
					// 模板拼接URL、当前标点及固定后文，全部只是待渲染文本。
					const source = `${url}${punctuation}后面的中文`;
					// 160列避免这些短例换行，join空串把物理行连接，保留ANSI/OSC8。
					const output = new Markdown(source, 0, 0, defaultMarkdownTheme).render(160).join("");
					// www自动链接href会补http://，https输入原样；三元表达式返回待查目标字符串。
					const href = url.startsWith("www.") ? `http://${url}` : url;
					// 要求OSC8开启序列里的href不含后面的标点，source作为失败消息。
					assert.ok(output.includes(`\x1b]8;;${href}\x1b\\`), source);
					// stripAnsi仅去SGR，保留OSC8关闭串，要求关闭紧接标点与后文，验证标点落在链接外。
					assert.ok(stripAnsi(output).includes(`\x1b]8;;\x1b\\${punctuation}后面的中文`), source);
					// 另用OSC8专用正则去链接序列，再去SGR/尾补白，完整文本必须等于原source，不能丢字符或重复。
					assert.strictEqual(stripAnsi(output.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")).trimEnd(), source);
				}
			}
		});

		// 没有分隔标点的中日韩文字可以留在裸URL里；只查href保留，不检查后缀可见文本的精确数组。
		it("should preserve Chinese characters without punctuation in bare URLs", () => {
			// 强制OSC8分支。
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			// 遍历以下三种地址文字，数组各项是本次循环的url。
			for (const url of [
				// 域名后紧接中文、无分隔标点。
				"https://example.com紧接着中文",
				// 中文路径、查询与片段。
				"https://example.com/中文?q=搜索#片段",
				// 日文长音符与韩文不属于这里的CJK断开标点集合。
				"https://example.com/テストー한글",
			]) {
				// 新组件160列渲染并连接保留控制序列。
				const output = new Markdown(url, 0, 0, defaultMarkdownTheme).render(160).join("");
				// 链接开启串的目标地址应与整个url一致，不访问目标。
				assert.ok(output.includes(`\x1b]8;;${url}\x1b\\`));
			}
		});

		// 显式[标签](地址)及<地址>自动链接走独立Marked规则，不采用裸URL的CJK标点截断。
		it("should preserve CJK punctuation in explicit links and angle autolinks", () => {
			// 强制OSC8输出。
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			// 地址特意含中文逗号、中点、省略号和破折号等。
			const url = "https://example.com/中文，路径·テスト・한글…—。";
			// 模板分别构造显式链接和尖括号自动链接，两种源共用同一完整地址。
			for (const source of [`[文档](${url})`, `<${url}>`]) {
				// 160列绘制并保留OSC8。
				const output = new Markdown(source, 0, 0, defaultMarkdownTheme).render(160).join("");
				// 要求每种输入的href仍包含整个url，标点不被截掉。
				assert.ok(output.includes(`\x1b]8;;${url}\x1b\\`), source);
			}
		});

		// 先在CJK逗号处截裸URL后，父类规则仍应修剪末英文句点；句点与逗号一起保留为链接外正文。
		it("should preserve English punctuation trimming before Chinese punctuation", () => {
			// 显式开超链接。
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			// 地址末紧贴英文句点再中文逗号和后文。
			const source = "https://example.com.，后面的中文";
			// 渲染160列并连接原ANSI行。
			const output = new Markdown(source, 0, 0, defaultMarkdownTheme).render(160).join("");
			// href只到example.com，不含英文点或中文逗号。
			assert.ok(output.includes("\x1b]8;;https://example.com\x1b\\"));
			// 去SGR后要求OSC8关闭紧接“.，后面的中文”，两个标点都未被吞掉。
			assert.ok(stripAnsi(output).includes("\x1b]8;;\x1b\\.，后面的中文"));
		});

		// 邮箱自动链接的可见文字已等于去mailto前缀地址，回退模式不应额外印mailto；本例没有单独计邮箱出现次数。
		it("should not duplicate URL for autolinked emails", () => {
			// Hyperlinks capability does not affect the mailto: display check.
			// 关闭超链接使地址回退逻辑可见，显式能力仅影响缓存。
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			// 普通文本中的邮箱由Marked识别为mailto链接；不会发邮件。
			const markdown = new Markdown("Contact user@example.com for help", 0, 0, defaultMarkdownTheme);

			// 80列绘制。
			const lines = markdown.render(80);
			// 去SGR保留普通文字。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 空格连接行供子串检查。
			const joinedPlain = plainLines.join(" ");

			// Should contain the email once, not duplicated with mailto:
			// 要求至少出现邮箱，不保证恰一次。
			assert.ok(joinedPlain.includes("user@example.com"), "Should contain email");
			// 禁止mailto:字符串出现，捕获额外括号地址的常见重复情形。
			assert.ok(!joinedPlain.includes("mailto:"), "Should not show mailto: prefix for autolinked emails");
		});

		// 裸URL标签本身就是地址，回退模式不再另附同地址；这里用正则次数严格要求只出现一次。
		it("should not duplicate URL for bare URLs", () => {
			// 显式关闭OSC8。
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			// 创建正文含一个https地址的段落。
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			// 80列渲染。
			const lines = markdown.render(80);
			// 去简单SGR。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 用空格连接行，得到可搜索文字。
			const joinedPlain = plainLines.join(" ");

			// URL should appear only once
			// 全局match返回匹配数组或null；||[]使无匹配时次数为0，正则转义/与.匹配字面地址。
			const urlCount = (joinedPlain.match(/https:\/\/example\.com/g) || []).length;
			// 要求恰一次，不是至少出现。
			assert.strictEqual(urlCount, 1, "URL should appear exactly once");
		});

		// 标签与URL不同且不支持OSC8时，标签后应显示括号URL；只查两个片段，不比较间距全部细节。
		it("should show URL in parentheses when hyperlinks are not supported", () => {
			// 关闭超链接缓存。
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			// click here标签与https地址不同。
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			// 80列绘制。
			const lines = markdown.render(80);
			// 去SGR。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 连接为普通文本。
			const joinedPlain = plainLines.join(" ");

			// 要求可见标签。
			assert.ok(joinedPlain.includes("click here"), "Should contain link text");
			// 要求带括号的完整URL，不能只显示标签。
			assert.ok(joinedPlain.includes("(https://example.com)"), "Should show URL in parentheses");
		});

		// 自定义邮箱标签与地址不同，回退要显示含mailto的完整括号地址，与自动邮箱只显示邮箱形成对照。
		it("should show mailto URL in parentheses when hyperlinks are not supported", () => {
			// 关闭OSC8。
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			// Email me不同于地址本身，字符串不会发送邮件。
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			// 80列输出。
			const lines = markdown.render(80);
			// 去SGR。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 空格连接行。
			const joinedPlain = plainLines.join(" ");

			// 可见标签保留。
			assert.ok(joinedPlain.includes("Email me"), "Should contain link text");
			// 括号中保留mailto前缀与完整地址。
			assert.ok(joinedPlain.includes("(mailto:test@example.com)"), "Should show mailto URL in parentheses");
		});

		// 显式链接在OSC8能力开启时只显示标签，并输出开/闭序列；不额外显示括号URL。
		// 断言只检查生成字符串，不证明用户真实终端可点击，也不实际打开链接。
		it("should emit OSC 8 hyperlink sequence when terminal supports hyperlinks", () => {
			// 强制超链接支持。
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			// 构造标准标签+URL。
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			// 80列生成含控制码行。
			const lines = markdown.render(80);
			// 空串连接，不额外插入LF，方便搜索完整序列。
			const joined = lines.join("");

			// OSC 8 open: ESC ] 8 ; ; <url> ESC \
			// 要求OSC8开启包含目标URL且以ESC反斜杠结束。
			assert.ok(joined.includes("\x1b]8;;https://example.com\x1b\\"), "Should contain OSC 8 open sequence");
			// OSC 8 close: ESC ] 8 ; ; ESC \
			// 要求空地址OSC8关闭序列存在。
			assert.ok(joined.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 close sequence");
			// Visible text is present
			// 这份原正则粗略去若干ESC序列供可见标签搜索，不是通用ANSI清洗器。
			const plainLines = lines.map((line) => line.replace(/\x1b[^a-zA-Z]*[a-zA-Z]|\x1b\].*?\x1b\\/g, ""));
			// 去控制后的结果仍含click here。
			assert.ok(plainLines.join("").includes("click here"), "Should contain link text");
			// URL is NOT printed inline as plain text
			// 另创建更针对OSC8和SGR的普通文本数组。
			const rawPlain = lines.map((line) =>
				// 先删到ESC反斜杠结尾的OSC8串，再删简单SGR；每行map返回新字符串。
				line
					.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
					.replace(/\x1b\[[0-9;]*m/g, ""),
			);
			// 禁止可见正文额外出现括号URL；URL在OSC8载荷里出现仍允许。
			assert.ok(!rawPlain.join("").includes("(https://example.com)"), "URL should not appear inline in parentheses");
		});

		// mailto也可编码为OSC8目标；只检查开/闭序列，不发邮件、不验证邮件客户端行为。
		it("should use OSC 8 for mailto links when terminal supports hyperlinks", () => {
			// 强制超链接支持。
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			// 构造带自定义标签的mailto链接。
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			// 80列输出。
			const lines = markdown.render(80);
			// 连接原串保留协议。
			const joined = lines.join("");

			// 多行ok检查开启目标。
			assert.ok(
				// 要求地址带mailto前缀完整编码。
				joined.includes("\x1b]8;;mailto:test@example.com\x1b\\"),
				// 这是失败消息，不是返回值。
				"Should contain OSC 8 open with mailto URL",
			);
			// 同时要求空地址关闭序列。
			assert.ok(joined.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 close sequence");
		});

		// 裸URL在OSC8模式也是链接标签，只编码一次目标且不额外附括号地址；并未计全部原串中URL次数。
		it("should use OSC 8 for bare URLs when terminal supports hyperlinks", () => {
			// 开超链接能力。
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			// 裸地址在普通段落中。
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			// 80列渲染。
			const lines = markdown.render(80);
			// 连接保留OSC8的原串。
			const joined = lines.join("");

			// 要求OSC8目标地址正确。
			assert.ok(joined.includes("\x1b]8;;https://example.com\x1b\\"), "Should contain OSC 8 hyperlink");
			// URL should not also appear as raw parenthetical text
			// 准备剥掉控制序列后的文字数组。
			const rawPlain = lines.map((line) =>
				// map每行先去OSC8，再去简单SGR。
				line
					.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
					.replace(/\x1b\[[0-9;]*m/g, ""),
			);
			// 只禁止括号形式的第二份URL；原串协议载荷中还有URL是正常的。
			assert.ok(!rawPlain.join("").includes("(https://example.com)"), "URL should not appear twice");
		});
	});

	// HTML样式标签只作为终端文字展示，不生成DOM/执行脚本；这里不是对任意终端控制符的安全过滤测试。
	describe("HTML-like tags in text", () => {
		// 模型输出类似thinking标签时，至少保留内部文字或开标签之一；||意味着不要求两者都显示或整段精确相同。
		it("should render content with HTML-like tags as text", () => {
			// When the model emits something like <thinking>content</thinking> in regular text,
			// marked might treat it as HTML and hide the content
			// 创建内联标签混普通段落。
			const markdown = new Markdown(
				// 标签及hidden content是固定示例字符串，无模型请求。
				"This is text with <thinking>hidden content</thinking> that should be visible",
				// 无横边距。
				0,
				// 无纵边距。
				0,
				// 共享主题。
				defaultMarkdownTheme,
			);

			// 80列绘制，可能按词折行。
			const lines = markdown.render(80);
			// 去SGR。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 空格连接成普通文字便于跨行搜索。
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			// ok检查下方或条件，不是全等。
			assert.ok(
				// 内部内容存在或开标签存在任一即可通过，断言比英文描述更宽松。
				joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>"),
				// 失败消息说明用例目标，不增加实际检查条件。
				"Should render HTML-like tags or their content as text, not hide them",
			);
		});

		// 代码围栏里的HTML标签应该字面显示，检查开/闭div都存在；不测试浏览器HTML语义。
		it("should render HTML tags in code blocks correctly", () => {
			// html仅是围栏语言标记，正文<div>不会被执行。
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			// 80列绘制。
			const lines = markdown.render(80);
			// 去SGR保留尖括号文字。
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			// 用LF连接，保持物理行分隔。
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			// 对两项AND条件作断言。
			assert.ok(
				// 开/闭标签必须同时出现，但没有要求Some HTML正文完整或唯一。
				joinedPlain.includes("<div>") && joinedPlain.includes("</div>"),
				// 失败消息。
				"Should render HTML in code blocks",
			);
		});
	});

	// 模拟流式代码围栏尚未补齐的字符串，比较当前完整输出行；不需要网络流或真实编辑器。
	describe("Streaming code fences", () => {
		// 短闭围栏在末尾时先从代码正文剔除并统一画闭围栏，避免补最后一个字符时高度缩短；中间两反引号仍作代码。
		it("stabilizes partial closing fence rendering", () => {
			// cases是由input源码和expected行数组组成的对象数组，TS从字面量推断字段类型。
			const cases = [
				{
					// 末尾两个反引号比三个开围栏短，视为流式半截闭符。
					input: "```ts\nconst x = 1;\n``",
					// 预期只显示代码正文一次，并画规范三反引号闭围栏。
					expected: ["```ts", "  const x = 1;", "```"],
				},
				{
					// 两个反引号位于完整闭围栏之前，属于真正代码内容，不应被裁掉。
					input: "```md\nnot a closing fence:\n``\n```",
					// 预期中间``保留并带默认代码缩进。
					expected: ["```md", "  not a closing fence:", "  ``", "```"],
				},
				{
					// 没有其他正文、只有半截闭符的代码块。
					input: "```ts\n``",
					// 空正文保留一条空字符串行，上下是围栏。
					expected: ["```ts", "", "```"],
				},
				{
					// 开围栏四个、末尾三个反引号仍不足闭合，应作半截闭符。
					input: "````\n```",
					// 显示围栏统一三反引号，不复刻原开符长度。
					expected: ["```", "", "```"],
				},
				{
					// 五个波浪开符/四个波浪半截闭符，也走同一修剪规则。
					input: "~~~~~\n~~~~",
					// 终端显示规范化三反引号边界，中间为空正文。
					expected: ["```", "", "```"],
				},
				{
					// 代码内两反引号后有完整闭围栏与后段，不能把代码内文字删掉。
					input: "```md\nnot a closing fence:\n``\n```\n\nafter",
					// 完整预期保留中间两反引号，代码后恰一空行再到after。
					expected: ["```md", "  not a closing fence:", "  ``", "```", "", "after"],
				},
			];

			// for...of逐例，{input,expected}对象解构直接取两个字段，不修改原cases。
			for (const { input, expected } of cases) {
				// 每例用独立组件避免缓存干扰。
				const markdown = new Markdown(input, 0, 0, defaultMarkdownTheme);
				// 80列绘制并去SGR/尾空白，保留代码左缩进。
				const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

				// 深比较完整数组，包含围栏、正文、空行与后段。
				assert.deepStrictEqual(lines, expected);
			}

			// 另建末尾只有两个闭反引号的组件。
			const partial = new Markdown("```ts\nconst x = 1;\n``", 0, 0, defaultMarkdownTheme);
			// 另建完整三反引号闭合的同正文组件。
			const complete = new Markdown("```ts\nconst x = 1;\n```", 0, 0, defaultMarkdownTheme);

			// 只比较两次渲染数组长度，证明本例补齐闭符不改变行数；不在此比较每行内容。
			assert.strictEqual(partial.render(80).length, complete.render(80).length);
		});
	});
});
