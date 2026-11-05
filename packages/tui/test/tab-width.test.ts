// 测项目 tab 固定三列规则在切片、浮层合成、最终写入中一致；最后一例使用内存模拟终端，无真实 TTY/网络/剪贴板，回调断言失败由 node:test 记录。
// assert 比字符串/列宽/数组，不能把 xterm 的空单元裁剪误当成 trimEnd 删除所有空格。
import assert from "node:assert";
// describe/it 注册组与用例，同步场景返回 void，async 场景返回 Promise 等待模拟器解析。
import { describe, it } from "node:test";
// type 导入约束组件/宿主接口，编译后移除，不创建真实 TUI。
import type { Component, TUI } from "../src/tui.ts";
// 真正运行主屏渲染器，但构造时注入的是下面的内存 Terminal。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 真实字符串工具分别取覆盖区两侧、生成输出副本、切片同时给宽度、估算显示列。
import { extractSegments, normalizeTerminalOutput, sliceWithWidth, visibleWidth } from "../src/utils.ts";
// 共享 VirtualTerminal 把输出交 @xterm/headless，而不是 process.stdout。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 测试底图组件，implements 只约束方法，不继承其他组件绘制；三行内容供覆盖后断言。
class FullViewportContent implements Component {
	// 输入列宽，返回铺满该宽的三行，无状态/IO；例 16 列把 base 0 后补空格，不处理任意宽字，因为本样本全 ASCII。
	render(width: number): string[] {
		// map 对每条基础行调用 padEnd(width)，返回新数组；按码元补齐在此 ASCII 样本与列宽一致，超宽时 padEnd 也不截断。
		return ["base 0", "base 1", "base 2"].map((line) => line.padEnd(width));
	}

	// 无缓存的 invalidate 空实现，返回 void，无参数/副作用；宿主统一失效通知无需特例。
	invalidate(): void {}
}

// 包装共享模拟器以额外收集经本 override write 的原始输出，便于检查 tab 是否仍被发出；不捕获基类直接对其 xterm.write 的模式写。
class CapturingVirtualTerminal extends VirtualTerminal {
	// 私有累计字符串，初始空；private 不产生 JS # 私有槽。
	private output = "";

	// 重写 write，输入 data、返回 void：先累积再交基类解析；例合成输出不该含可见 tab。super 抛错时 output 已追加，不回滚。
	override write(data: string): void {
		// += 拼接原始控制串和文字，未解释其显示效果。
		this.output += data;
		// super.write 真正排队给内存 xterm；此方法本身不等待解析完成。
		super.write(data);
	}

	// 返回已收原始输出字符串，无等待/修改；例 getOutput().includes(tab) 可查发送内容，不等同读屏幕文字。
	getOutput(): string {
		// 直接返回累计值，没有自动清记录。
		return this.output;
	}
}

// 最小浮层组件只产生 tab 后跟 X 的一行，用于重现布局按三列而终端按制表位可能错位的问题。
class TabStatusOverlay implements Component {
	// 无参数渲染，返回 string[]，不看宿主传来的 width；例声明宽 4 恰为项目 tab 3 加 X 1，无 IO。
	render(): string[] {
		// 字符串含实际 tab，必须经过最终 normalizeTerminalOutput 才变成三个空格，不预先在组件中替换。
		return ["\tX"];
	}

	// 空 invalidate 不改任何状态，返回 void。
	invalidate(): void {}
}

// 分组注册三项字符串断言与一项模拟终端集成场景。
describe("tab width accounting", () => {
	// 严格切片例：tab 占完整三列，起始八列正文后仅余两列时应整体舍弃，不声称所有切片结果都正好填满预算。
	it("keeps slice helper widths consistent with visible width", () => {
		// out、空格、192M 共八列，tab 从第 8 列起（0 基）。
		const text = "out 192M\t.pi/skill-tests/results-ha";
		// 从 0 严格取 10 列，tab 的末界 11 越过 10，所以不能保留；返回 text 与实际 width。
		const slice = sliceWithWidth(text, 0, 10, true);

		// 只留下前八列正文，未补两空格。
		assert.strictEqual(slice.text, "out 192M");
		// 返回 width 必须为 8，不能错误把请求 10 当实际宽。
		assert.strictEqual(slice.width, 8);
		// 用 visibleWidth 重测结果，验证两个 API 对同样文本计宽一致。
		assert.strictEqual(visibleWidth(slice.text), slice.width);
	});

	// 覆盖区两侧提取例：beforeEnd=10 排除放不下的 tab，改为 11 时应整体保留并正确计宽。
	it("keeps overlay segment widths consistent with visible width", () => {
		// 构造同一 tab 样本以比较两个边界。
		const text = "out 192M\t.pi/skill-tests/results-ha";
		// before 取 0..10，after 从 13 请求 10 列，true 控制右侧严格边界；本用例主要检查 before。
		const segments = extractSegments(text, 10, 13, 10, true);

		// 不完整 tab 不许留下。
		assert.strictEqual(segments.before, "out 192M");
		// 左段实际仅 8 列。
		assert.strictEqual(segments.beforeWidth, 8);
		// 列宽工具重测必须相同。
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);

		// 左段终界改 11，其余右侧参数不变，tab 整体恰能放下。
		const tabFits = extractSegments(text, 11, 13, 10, true);
		// 返回左段应原样含 tab 字符，提取工具不负责把它展开。
		assert.strictEqual(tabFits.before, "out 192M\t");
		// 实际宽 8+3=11。
		assert.strictEqual(tabFits.beforeWidth, 11);
		// 重测仍为 11。
		assert.strictEqual(visibleWidth(tabFits.before), tabFits.beforeWidth);
	});

	// 受支持序列载荷内 tab 保持原样例：只替换外面的可见 tab；这里没有 Thai/Lao AM 等会被另一正规化阶段改写的载荷字符，不能概括为任意载荷永远字节不变。
	it("keeps tabs inside terminal control sequences byte-identical", () => {
		// 三种完整控制外壳均只作为字符串样本，不执行链接/标题/图片动作。
		const controlSequences = [
			// BEL 结束的 OSC8 URL 内放 tab，不打开该地址。
			"\x1b]8;;https://example.test/a\tb\x07",
			// ST 结束的 OSC0 标题内放 tab，不改真实窗口标题。
			"\x1b]0;window\ttitle\x1b\\",
			// ST 结束的通用 APC 载荷内放 tab，不按可见空白展开。
			"\x1b_payload\tdata\x1b\\",
		];

		// 逐个样本独立正规化，for...of 不改原数组。
		for (const controlSequence of controlSequences) {
			// 模板后附可见 label-tab-text，期望控制串逐码元相同而正文变 label 三空格 text；strictEqual 比完整输出。
			assert.strictEqual(normalizeTerminalOutput(`${controlSequence}label\ttext`), `${controlSequence}label   text`);
		}
	});

	// 模拟终端场景：真实 TUI 合成带 tab 浮层后应只占预期一行；async 返回 Promise，try 内失败仍 finally stop，无真实终端资源。
	it("keeps tab-containing overlays on one physical terminal row", async () => {
		// 建 16 列/3 行的内存 xterm 及输出记录包装器。
		const terminal = new CapturingVirtualTerminal(16, 3);
		// TUI 静态接口约束实例用法，new 创建真实主屏渲染器并使用模拟 Terminal。
		const tui: TUI = new TuiMainScreen(terminal);
		// 添加三个底图行，不直接写屏，启动后才绘制。
		tui.addChild(new FullViewportContent());
		// 浮层宽 4、0 基行 1/列 4，覆盖第二行局部；其 tab+X 的项目宽正好 4。
		tui.showOverlay(new TabStatusOverlay(), { width: 4, row: 1, col: 4 });
		// 启动模拟输入/尺寸处理及初帧调度，不接管真实 stdin。
		tui.start();

		// 用 try/finally 保证等待/断言过程中抛错也会停止本地 TUI。
		try {
			// 等常见调度机会并 flush 此前 xterm 写队列，不宣称所有后续任务都结束。
			await terminal.waitForRender();
			// 验证三条物理屏行完整内容，第二行从列 4 放三空格再 X；右边显式补写空格由 xterm 快照保留，区别于末尾未写入空单元。
			assert.deepStrictEqual(terminal.getViewport(), ["base 0          ", "base   X        ", "base 2          "]);
			// 经 override write 收集的原始串不能再含 tab，避免 xterm 自己按制表位跳转造成行折叠。
			assert.ok(!terminal.getOutput().includes("\t"));
			// 不论断言成败都走 finally，异常不会被自动吞掉。
		} finally {
			// 停止渲染/测试回调和相关计时状态，所有终端控制仍只写内存模拟器。
			tui.stop();
		}
	});
});
