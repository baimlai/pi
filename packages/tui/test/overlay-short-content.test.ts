// 检查正文比屏高短时浮层仍能出现；使用内存 xterm，不改真实终端。测试保留普通 console 诊断输出，判断的是屏幕快照内是否有浮层文字，不测精确居中坐标。
// assert.ok 失败会抛错；下面 async 用例返回 Promise 等待模拟器解析。
import assert from "node:assert";
// 注册分组/场景。
import { describe, it } from "node:test";
// type 只用于编译期检查组件与宿主，不产生基类方法或创建窗口。
import type { Component, TUI } from "../src/tui.ts";
// 主屏实现使用注入 Terminal，非直接构造 ProcessTerminal。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 共享模拟器保存 xterm 缓冲，sendInput/resize 等也只在测试内存中。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 最小底图组件保存传入行数组，供 TUI 测正文不足一屏时的布局。
class SimpleContent implements Component {
	// private 为静态访问约束，string[] 不是只读数组。
	private lines: string[];

	// 输入 lines 并保存引用，无显式返回/IO；例三行 Line1..3，不先克隆内容。
	constructor(lines: string[]) {
		// 保存同一数组，外部若修改它，后续 render 会看到变化。
		this.lines = lines;
	}

	// 无参 render 返回原数组、无修改；例总是三行，不按宽度折行或截断。
	render(): string[] {
		// 直接返回引用，宿主应按组件结果约定使用。
		return this.lines;
	}
	// invalidate 空实现，推断返回 void，不清底图，也不请求重画。
	invalidate() {}
}

// 固定三行浮层组件，无数据字段/输入监听，只提供可辨认的字符串。
class SimpleOverlay implements Component {
	// render 无参、返回新三行数组、无 IO；例三种 OVERLAY 标记方便查看是否可见。
	render(): string[] {
		// 顶/中/底标签只用于样本识别，并非真实边框组件。
		return ["OVERLAY_TOP", "OVERLAY_MID", "OVERLAY_BOT"];
	}
	// 无缓存可清，空 invalidate 返回 void。
	invalidate() {}
}

// 分组注册短正文浮层场景。
describe("TUI overlay with short content", () => {
	// async 例：建立三行正文、显示默认定位浮层、启动等待、查快照再 stop；没有 try/finally，断言或等待失败时最后 stop 不会执行，不应描述成无条件清理保证。
	it("should render overlay when content is shorter than terminal height", async () => {
		// Terminal has 24 rows, but content only has 3 lines
		// 创建 80 列/24 行模拟器，不改变真实窗口大小。
		const terminal = new VirtualTerminal(80, 24);
		// TUI 接口标注约束用法，实际实例是主屏渲染器。
		const tui: TUI = new TuiMainScreen(terminal);

		// Only 3 lines of content
		// 添加三行短正文，远少于终端 24 行；此时只是组组件树。
		tui.addChild(new SimpleContent(["Line 1", "Line 2", "Line 3"]));

		// Show overlay centered - should be around row 10 in a 24-row terminal
		// 创建固定三行浮层，不立即绘制。
		const overlay = new SimpleOverlay();
		// 未给 options 使用默认定位/宽度；原英文说约第10行是背景，这个测试并未断言具体行。
		tui.showOverlay(overlay);

		// Trigger render
		// 启动模拟终端并安排初帧。
		tui.start();
		// 等 nextTick、约20ms 与已有写入解析，不保证任意后续异步任务全完成。
		await terminal.waitForRender();

		// 读取当前活动 buffer 的可见行文字快照，显式写出的空格仍可保留。
		const viewport = terminal.getViewport();
		// some 回调检查任一行含 OVERLAY，找到即短路；只能证明至少一个标签可见，不证明三行都完整显示。
		const hasOverlay = viewport.some((line) => line.includes("OVERLAY"));

		// 诊断输出模拟终端的行数，console.log 是普通测试日志，不发送窗口改尺寸控制码。
		console.log("Terminal rows:", terminal.rows);
		// 打印固定正文行数的说明，不计算真实内容高度。
		console.log("Content lines: 3");
		// 打印布尔检查结果，方便失败时阅读。
		console.log("Overlay visible:", hasOverlay);

		// 未见浮层才追加详细快照，不改变 hasOverlay 或重试绘制。
		if (!hasOverlay) {
			// 先打印诊断标题。
			console.log("\nViewport contents:");
			// 遍历快照数组的各行下标。
			for (let i = 0; i < viewport.length; i++) {
				// 模板输出下标与该行内容，仅供诊断，不参与断言判断。
				console.log(`  [${i}]: "${viewport[i]}"`);
			}
		}

		// 要求 hasOverlay 为真，失败抛错；没有检查浮层锚点或全部内容相等。
		assert.ok(hasOverlay, "Overlay should be visible when content is shorter than terminal");

		// 成功走到此处才停止 TUI，内存模拟器不 dispose，但测试回调与渲染状态会停止。
		tui.stop();
	});
});
