// 验证主屏内容从三行清空后，内存终端原来显示的文字被擦除；不接管真实终端，也不证明所有终端模拟器行为。
// 默认导入严格断言所需的 Node assert 对象。
import assert from "node:assert";
// 注册测试组与异步用例，Node 测试运行器等待用例返回的 Promise。
import { describe, it } from "node:test";
// type 导入只在编译期检查组件/宿主契约，运行时不会创建 Component 或 TUI 对象。
import type { Component, TUI } from "../src/tui.ts";
// 使用真实主屏差量渲染器，输出交给下方虚拟终端。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 内存 xterm 解析输出控制码，供测试读取实际页面内容。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 最小多行组件：保存传入数组并原样 render；implements 仅检查方法签名，不继承运行时实现。
class Lines implements Component {
	// private 是 TypeScript 访问限制；字段保存数组引用，不复制或冻结。
	private lines: string[];

	// 构造时接收待绘制的行数组，保存引用、无 I/O，例如三条字符串对应三行内容。
	constructor(lines: string[]) {
		// 直接保存调用者数组，本用例之后不修改数组，而是从宿主移除整个组件。
		this.lines = lines;
	}

	// 返回当前行数组供宿主绘制；无参数、不测宽或补白，返回的也不是副本。
	render(): string[] {
		// 把存好的行原样交回主屏渲染流程。
		return this.lines;
	}

	// 满足组件失效接口的空方法，无参数/结果/副作用，因为本小组件没有派生缓存可清。
	invalidate(): void {}
}

// 组织内容缩小的回归用例，不启动外部程序。
describe("TUI shrinking content", () => {
	// 异步流程：绘制三行→等常见节流帧及 xterm 写队列→清空子组件→重绘→检查旧文字消失→stop；失败抛断言，此例没有 finally 保证失败也 stop。
	it("clears all rendered lines when content shrinks to zero", async () => {
		// 创建40列10行的内存终端，尺寸为测试输入而非探测本机窗口。
		const terminal = new VirtualTerminal(40, 10);
		// 用 TUI 接口标注主屏实例，静态隐藏具体类细节，不改变运行时对象。
		const tui: TUI = new TuiMainScreen(terminal);
		// 构造三行测试组件，字符串不是从文件或用户会话读取。
		const content = new Lines(["first", "second", "third"]);
		// 把组件加入主屏的子组件列表。
		tui.addChild(content);
		// 连接虚拟输入回调并安排初始绘制，不会绑定真实 stdin。
		tui.start();
		// 先 nextTick、约20ms再 flush xterm；这是本例的时序辅助，不保证任意未来任务都已完成。
		await terminal.waitForRender();

		// some 只需有一行包含 first 即通过，未断言具体行号或整页完全相等。
		assert.ok(terminal.getViewport().some((line) => line.includes("first")));
		// 同样确认第二条文字已经真正进入终端页面。
		assert.ok(terminal.getViewport().some((line) => line.includes("second")));
		// 确认第三条文字也存在，避免“从未绘制”导致后面的消失断言空通过。
		assert.ok(terminal.getViewport().some((line) => line.includes("third")));

		// clear 移除宿主所有子组件；本行不直接清除 xterm 已有屏幕文字。
		tui.clear();
		// 显式请求后续帧，让渲染器对比新空内容并擦除旧区域。
		tui.requestRender();
		// 等待该帧写入内存终端并解析，之后才读屏幕。
		await terminal.waitForRender();

		// 取得当前可见页的字符串快照，不读取终端滚动历史。
		const viewport = terminal.getViewport();
		// 对 some 取反：任何可见行都不能再含 first；失败信息说明应擦除旧行。
		assert.ok(!viewport.some((line) => line.includes("first")), "first line should be cleared");
		// 独立检查 second 消失，不把首行清掉等同于所有旧行清掉。
		assert.ok(!viewport.some((line) => line.includes("second")), "second line should be cleared");
		// 检查最后一条也消失；本例仅验证这些文字，不要求整页所有样式或空格完全一致。
		assert.ok(!viewport.some((line) => line.includes("third")), "third line should be cleared");

		// 正常路径停止宿主并关闭虚拟终端回调/模式；不是销毁底层 xterm 缓冲。
		tui.stop();
	});
});
