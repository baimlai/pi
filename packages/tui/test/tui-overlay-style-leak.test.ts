// 回归主屏整行样式重置与浮层切片导致的斜体泄漏，使用内存xterm读单元属性，不操作真实终端；两个async用例返回Promise，断言/等待错误向测试框架传播。
// strictEqual 精确比较 isItalic() 的数字0，不只观察可见文本相同。
import assert from "node:assert";
// 注册组与测试场景。
import { describe, it } from "node:test";
// type 导入第三方 Terminal 实例接口别名，供测试读取底层缓冲字段，不创建另一个终端。
import type { Terminal as XtermTerminalType } from "@xterm/headless";
// 项目Component/TUI为编译期约束。
import type { Component, TUI } from "../src/tui.ts";
// 使用真实主屏算法与模拟Terminal组合。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 内存终端解析SGR并保留单元样式，便于检查肉眼不可直接从字符串看到的状态。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 固定底图组件保存传入行数组，供渲染样式文本及下一行普通INPUT。
class StaticLines implements Component {
	// private限制静态访问，readonly只禁止字段重新赋值，数组元素仍可变。
	private readonly lines: string[];

	// 构造接lines并保存引用，无IO/显式返回；例两行底图，不复制每个字符串。
	constructor(lines: string[]) {
		// 原数组引用赋到字段，未在构造渲染。
		this.lines = lines;
	}

	// render 无参、返回原行数组、无状态修改；不按width再截断，让主屏处理完整宽度样本。
	render(): string[] {
		// 直接给宿主完整底图，下一行INPUT可用于检测前行样式是否泄漏。
		return this.lines;
	}

	// 无缓存，invalidate空实现，不重置lines。
	invalidate(): void {}
}

// 单行浮层组件，保存一条文字；与上面的多行底图区别仅是输入形状。
class StaticOverlay implements Component {
	// readonly限制字段绑定，不影响字符串原本不可变特性。
	private readonly line: string;

	// 构造输入line、保存它、无IO；例OVR，未建立终端浮层直到宿主showOverlay。
	constructor(line: string) {
		// 记录line字符串。
		this.line = line;
	}

	// render 无参、返回新一项数组，不直接写屏；例此组件只占一行。
	render(): string[] {
		// 将已存line包装为行数组。
		return [this.line];
	}

	// invalidate为空，无副作用/返回值。
	invalidate(): void {}
}

// 读模拟终端(row,col)单元斜体标志，返回number，无写入；例普通格得0。行/格缺失由断言抛错，必须先等待写队列解析，不验证真实字体是否画斜。
function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	// 双重as先转unknown再声明有xterm字段，绕过TS private访问限制；运行时不创建字段或检查形状，只因测试知道VirtualTerminal内部结构才可用。
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	// 取当前活动normal/alternate缓冲。
	const buffer = xterm.buffer.active;
	// viewportY加屏内row得到缓冲行，不把row当完整历史绝对行。
	const line = buffer.getLine(buffer.viewportY + row);
	// 缺行先断言失败，避免下一步读undefined掩盖定位。
	assert.ok(line, `Missing buffer line at row ${row}`);
	// 按终端列取cell，不能按UTF-16字符串下标读样式。
	const cell = line.getCell(col);
	// 缺cell同样报带行列的断言说明。
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	// isItalic为第三方API数值标志；只关心0/非0，此测试不承诺非零值一定为1。
	return cell.isItalic();
}

// 请求强制下一帧并等待常见调度及xterm队列，返回Promise<void>；例renderAndFlush后读cell，非任意异步动画全稳保证，不写真实终端。
async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	// true先重置主屏渲染缓存并排nextTick即时帧，不等于同步画完。
	tui.requestRender(true);
	// 注册nextTick屏障并await，让此前排队帧有机会执行。
	await new Promise<void>((resolve) => process.nextTick(resolve));
	// 共享waitForRender还等nextTick/约20ms和flush，避免只排帧未解析就读样式。
	await terminal.waitForRender();
}

// 分组对比无浮层与有浮层两种尾部关闭码场景。
describe("TUI overlay compositing", () => {
	// 无浮层例：一行恰占20列后才出现SGR23，下一行INPUT首格仍不能继承斜体；没有finally，停止在成功路径。
	it("should not leak styles when a trailing reset sits beyond the last visible column (no overlay)", async () => {
		// 固定终端宽20列。
		const width = 20;
		// 斜体开启、20个X、关闭斜体；控制码零宽，所以关闭码位于最后可见格之后但不等于无效。
		const baseLine = `\x1b[3m${"X".repeat(width)}\x1b[23m`;

		// 建20列6行模拟器。
		const terminal = new VirtualTerminal(width, 6);
		// 真实主屏宿主，所有write只进内存。
		const tui: TUI = new TuiMainScreen(terminal);
		// 底图第一行斜体、第二行普通INPUT，不先给第二行手动加reset来掩盖bug。
		tui.addChild(new StaticLines([baseLine, "INPUT"]));
		// 启动并排初帧。
		tui.start();
		// 再强制渲染等待完成，保证检查的是解析后单元属性。
		await renderAndFlush(tui, terminal);
		// 屏内row1即第二行，col0首格应非斜体，检上一行样式没漏过来。
		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		// 成功后stop，前面断言抛错不会自动执行此行。
		tui.stop();
	});

	// 有浮层例：覆盖第一行中部，切片可能漏掉可见末端后的原关闭码，宿主仍应防样式泄漏到第二行。
	it("should not leak styles when overlay slicing drops trailing SGR resets", async () => {
		// 同样20列，用相同基准便于比较。
		const width = 20;
		// 同样构造恰满行斜体样本，源末包含SGR23。
		const baseLine = `\x1b[3m${"X".repeat(width)}\x1b[23m`;

		// 独立模拟器，不继承上一测试屏状态。
		const terminal = new VirtualTerminal(width, 6);
		// 创建对应主屏宿主。
		const tui: TUI = new TuiMainScreen(terminal);
		// 添加同类两行底图。
		tui.addChild(new StaticLines([baseLine, "INPUT"]));

		// 把OVR浮层放row0/col5，宽3，只盖第一行中间；此调用注册浮层，不自行同步画屏。
		tui.showOverlay(new StaticOverlay("OVR"), { row: 0, col: 5, width: 3 });
		// 启动调度。
		tui.start();
		// 强制排帧并等模拟器解析。
		await renderAndFlush(tui, terminal);

		// 仍检查第二行首格斜体为0，证明此样本下浮层切片没有令后行染样式；不检所有其他属性。
		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		// 成功路径停止TUI。
		tui.stop();
	});
});
