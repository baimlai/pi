// 测格像素尺寸回复与普通输入分流：在内存 VirtualTerminal 里人工送协议，不查询真实显示器。每个 it 同步返回 void、断言失败抛错；环境辅助负责 finally 还原三个变量，不保证还原所有模块状态。
// deepStrictEqual 比数组/尺寸对象字段，不把字符串的行列计数当像素。
import assert from "node:assert";
// 注册测试组与用例。
import { describe, it } from "node:test";
// get/setCellDimensions 读写共享格像素缓存，resetCapabilitiesCache 只清能力判定缓存，不恢复格尺寸。
import { getCellDimensions, resetCapabilitiesCache, setCellDimensions } from "../src/terminal-image.ts";
// 接口 type 约束组件/宿主，无运行时 IO。
import type { Component, TUI } from "../src/tui.ts";
// 导入真实主屏实现，通过模拟 Terminal 驱动输入流程。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 共享 xterm 模拟器不会改真实 stdin/stdout。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 最小输入接收组件，用来观察哪些序列最终流到焦点输入层。
class InputRecorder implements Component {
	// readonly 禁止替换数组字段，push 仍允许，string[] 元素也不因此冻结。
	readonly inputs: string[] = [];

	// render 无参数，返回一条空行、无副作用；例界面不需要实际文本框也能给此组件焦点。
	render(): string[] {
		// 单空串数组代表一行，不是零高度的 []。
		return [""];
	}

	// 输入回调接 data:string、同步 push、返回 void；例普通 q 留记录，若尺寸回复也流进来测试会失败。
	handleInput(data: string): void {
		// 保存原始数据，不在记录器中自行解析/过滤协议，避免掩盖 TUI 行为。
		this.inputs.push(data);
	}

	// invalidate 空实现，不清 inputs，不触发绘制。
	invalidate(): void {}
}

// 泛型辅助暂装 Ghostty 环境、清能力缓存、同步调用 fn 返回 T，finally 还原环境；例传同步测试主体。它不 await T，即使 T 被推断成 Promise 也会在异步结束前还原，因此本文件只传同步回调。
function withImageTerminal<T>(fn: () => T): T {
	// 保存旧 TERM_PROGRAM，包括 undefined 与空串的区别。
	const prevTermProgram = process.env.TERM_PROGRAM;
	// 保存旧 TERM。
	const prevTerm = process.env.TERM;
	// 保存旧资源目录提示，不访问该目录。
	const prevGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;

	// 指定 Ghostty 标识供环境启发式，不启动 Ghostty 程序。
	process.env.TERM_PROGRAM = "ghostty";
	// 移除 TERM，避免它影响模拟能力选择。
	delete process.env.TERM;
	// 移除资源目录环境提示以隔离该线索。
	delete process.env.GHOSTTY_RESOURCES_DIR;
	// 清共享能力缓存，让下次读取按当前环境重新判断。
	resetCapabilitiesCache();

	// try 内执行测试主体，异常也进入 finally。
	try {
		// 立即调用 fn，不是仅保存函数引用；return 的值先求得，再运行 finally 后返回。
		return fn();
		// 无论同步返回还是抛错都还原；不捕获吞掉 fn 异常。
	} finally {
		// 原变量没定义则 delete，避免误恢复为字符串 undefined。
		if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
		// 原来存在则赋原值，空字符串也保留。
		else process.env.TERM_PROGRAM = prevTermProgram;
		// TERM 原本不存在时移除本轮可能设值。
		if (prevTerm === undefined) delete process.env.TERM;
		// 否则恢复旧 TERM。
		else process.env.TERM = prevTerm;
		// 同样按是否 undefined 恢复资源目录变量。
		if (prevGhosttyResourcesDir === undefined) delete process.env.GHOSTTY_RESOURCES_DIR;
		// 已有值原样赋回。
		else process.env.GHOSTTY_RESOURCES_DIR = prevGhosttyResourcesDir;
		// 再清能力缓存使外层不继续用 Ghostty 模拟结果；不重置 cellDimensions，所以后用例的10×20仍留模块中直到进程结束/另设值。
		resetCapabilitiesCache();
	}
}

// 分组检查 ESC 放行、合法尺寸回复消费，以及后续普通键仍送达。
describe("TUI cell size responses", () => {
	// ESC 例：启动已发格尺寸查询也不能把单独 Escape 当残缺回复一直吞掉；本测试绕过真实 StdinBuffer，直接人工 sendInput。
	it("forwards bare escape even when a cell size query was sent at startup", () => {
		// 同步回调无参/正常返回 void：在临时能力环境内建组件、发送一条ESC、断言、stop；失败仍还原环境，但没有把tui.stop放finally。
		withImageTerminal(() => {
			// 创建80列24行内存终端。
			const terminal = new VirtualTerminal(80, 24);
			// 主屏宿主只用模拟器，启动控制串不会写用户终端。
			const tui: TUI = new TuiMainScreen(terminal);
			// 独立记录器初始 inputs 为空。
			const recorder = new InputRecorder();

			// 设置焦点而未加到children也可接输入；焦点路由与参与绘制是两条关系。
			tui.setFocus(recorder);
			// 启动，具备图片能力时主屏可向模拟器写尺寸查询。
			tui.start();

			// 直接同步送 ESC 到TUI输入回调，不模拟硬件等待/字节分片。
			terminal.sendInput("\x1b");

			// 记录器应只收到原串 ESC，证明未被尺寸响应分支消费。
			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			// 正常通过断言后停止；若前面抛错此行不会到达。
			tui.stop();
		});
	});

	// 尺寸回复例：CSI6;高;宽t要被消费更新缓存，后来的q仍当普通文字。
	it("consumes cell size responses and still forwards later user input", () => {
		// 同步临时环境回调，无参数/void；环境恢复在辅助finally，TUI停止仍在成功路径末尾。
		withImageTerminal(() => {
			// 先设9×18像素基准，这个共享缓存改变不是测试终端字符列/行的80×24。
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			// 新建独立模拟器。
			const terminal = new VirtualTerminal(80, 24);
			// 创建真实输入处理宿主。
			const tui: TUI = new TuiMainScreen(terminal);
			// 新记录器确认没有上一用例输入残留。
			const recorder = new InputRecorder();

			// 单独给记录器焦点，不需要在屏幕组件树显示它。
			tui.setFocus(recorder);
			// 启动模拟TUI。
			tui.start();

			// 人工送“格高20、格宽10”的回复，协议顺序与对象字段宽/高顺序不同。
			terminal.sendInput("\x1b[6;20;10t");
			// 输入数组仍空，证明这条回复未键入焦点组件。
			assert.deepStrictEqual(recorder.inputs, []);
			// 缓存应更新为 widthPx10/heightPx20，核对没有交换两者。
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			// 再送普通 q。
			terminal.sendInput("q");
			// 此时应只有 q，尺寸回复消费不会把后续键盘输入全部屏蔽。
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			// 成功路径停止TUI，但没有恢复之前的9×18/更早格尺寸值。
			tui.stop();
		});
	});
});
