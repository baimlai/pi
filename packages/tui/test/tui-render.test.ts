// 测试普通主屏的排帧、分块输出、图像清理、尺寸变化、差量更新和光标。Terminal 替身只保存字符串或交给内存 xterm，不连接用户 TTY/剪贴板。
// 调试与崩溃两例会在各自新建的临时目录写日志并 finally 删除；其余主要改内存、排 nextTick/定时器。多项 stop 只在正常尾部，不是统一 finally 清理保证。
// 断言库在不符合预期时抛错；本文件保留控制码字符串来检查协议顺序，而非验证真实终端像素显示。
import assert from "node:assert";
// 同步创建独立临时目录、读取日志和递归删除；本文件确有这些受控磁盘副作用。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
// 按当前进程临时目录环境取得 OS 临时路径，崩溃用例会临时修改相应环境。
import { tmpdir } from "node:os";
// 按本机路径规则拼日志位置，不自行读写文件。
import { join } from "node:path";
// describe 声明组，it 声明同步/异步用例；async 回调的 Promise 拒绝会使测试失败。
import { describe, it } from "node:test";
// type 导入仅供 TS 检查，as 为 xterm Terminal 类型起别名，不创建实例或加载真实终端。
import type { Terminal as XtermTerminalType } from "@xterm/headless";
// Image 将给定数据和像素尺寸变成控制串/空占位行，不直接输出。
import { Image } from "../src/components/image.ts";
// 真实单行 Input 用于验证焦点与伪光标行为。
import { Input } from "../src/components/input.ts";
// 项目 Terminal 是适配器接口，编译期核对方法，不继承真实 ProcessTerminal 的系统操作。
import type { Terminal } from "../src/terminal.ts";
// 图片协议函数在这里构造返回串或设置测试进程内能力/尺寸状态。
import {
	// 生成释放指定 Kitty ID 的删除命令，便于检查其在绘图前出现。
	deleteKittyImage,
	// 构造带 ID/行数的 Kitty 上传命令，载荷可以只是测试占位字符串。
	encodeKitty,
	// 清能力结果缓存，不清图片登记元数据或其它实例状态。
	resetCapabilitiesCache,
	// 直接指定能力，图片组件测试不依赖本机终端品牌。
	setCapabilities,
	// 设置一格对应多少像素，后续图片尺寸换算依赖它。
	setCellDimensions,
} from "../src/terminal-image.ts";
// Component/TUI 是类型契约；CURSOR_MARKER 只标硬件光标位置，renderFakeCursor 包标记供宿主转换反色样式。
import { type Component, CURSOR_MARKER, renderFakeCursor, type TUI } from "../src/tui.ts";
// 真实主屏渲染器，构造时接收 Terminal 替身；new 尚未注册输入或开始排首帧。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 按可见格列截字符串，最后的截断光标用例用它制造缺少结束标记的片段。
import { sliceByColumn } from "../src/utils.ts";
// 内存 xterm 适配器提供输入/resize模拟、写队列 flush 和视口读取，不接真实 stdin/stdout。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 最小可变组件：用例直接替换 lines 决定下一帧；implements 仅让 TS 检查 render/invalidate 接口。
class TestComponent implements Component {
	// 显式 string[] 初始为空，公开字段允许用例替换数组。
	lines: string[] = [];
	// 返回当前行数组原引用，不按 _width 截断；例如设置超宽行可故意触发宿主错误，_ 表示未使用参数。
	render(_width: number): string[] {
		// 只读取字段；父 Container 汇总时建立自己的行数组，所以这里不会主动加样式重置。
		return this.lines;
	}
	// 该假组件没有自己的渲染缓存，invalidate 作为契约空实现，返回 void、无副作用。
	invalidate(): void {}
}

// 在假组件上加渲染计数和输入处理，用于观察输入抢占节流帧；extends 继承 lines 和其它方法。
class InputComponent extends TestComponent {
	// 次数从0开始，每次调用 render 都递增，不只在有终端输出时计数。
	renderCount = 0;

	// 覆写 render：收父宽度、计数后返回父实现的行数组；override 让 TS 检查父类确有此方法。
	override render(width: number): string[] {
		// += 原地更新计数，供调度断言比较帧执行次数。
		this.renderCount += 1;
		// super.render 复用父方法，宽度被传入但父方法不使用；返回值不复制。
		return super.render(width);
	}

	// 接收一块假输入并把全部显示行替换成这一块，返回 void；例如 first→second 后只剩 second，不模拟逐字追加编辑器。
	handleInput(data: string): void {
		// 建立单元素数组，最后一次输入覆盖此前状态。
		this.lines = [data];
	}
}

// 单次 write 上限按 string.length 的 UTF-16 码元计为1048576，不是整帧长度或 UTF-8 字节数。
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

// 只记录 write 的终端替身，不模拟屏幕或强制限制大小；上限由被测渲染器执行，再由断言检查。
class BoundedWriteTerminal implements Terminal {
	// readonly 只禁止 TS 重新赋值 writes 引用，数组仍可 push 或改 length。
	readonly writes: string[] = [];
	// 固定列数80，供布局读取，不从系统终端查询。
	columns = 80;
	// 固定行数24，仍是普通可变字段。
	rows = 24;
	// 报告 Kitty 键盘协议未激活；这是键盘协商标志，不控制是否识别图片报文。
	readonly kittyProtocolActive = false;

	// start 空实现：接收但不保存/调用输入和 resize 回调，_ 参数避免误以为这里注册了系统监听器。
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	// stop 空实现，不额外记录或恢复终端模式。
	stop(): void {}
	// 异步排空接口立即完成 Promise<void>，两个可选时间参数故意忽略，没有真实 stdin 可排。
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	// 收一段输出并按调用顺序记入数组，返回 void；例如 write("abc") 只保存它，不解析控制码。
	write(data: string): void {
		// 保留本次独立 write 边界，因此能检查每块长度，而非只看拼接后的结果。
		this.writes.push(data);
	}
	// 相对移动光标接口为空，不生成控制码；本替身主要观察渲染器直接 write 的字符串。
	moveBy(_lines: number): void {}
	// 隐藏光标接口无操作，不向真实终端发送指令。
	hideCursor(): void {}
	// 显示光标接口无操作，也不追加到 writes。
	showCursor(): void {}
	// 清行接口无操作，不模拟字符缓冲。
	clearLine(): void {}
	// 从光标清到屏末接口无操作。
	clearFromCursor(): void {}
	// 清屏接口无操作；渲染器直接 write 的清屏码仍会被记录。
	clearScreen(): void {}
	// 忽略标题参数，不改真实窗口标题。
	setTitle(_title: string): void {}
	// 忽略进度开关，不创建保活动定时器。
	setProgress(_active: boolean): void {}
	// 程序状态接口为空；实现可以省略未用形参，仍满足接收状态的接口契约。
	setProgramStatus(): void {}
}

// 在 VirtualTerminal 上额外记录经 write 的原串，既可检查协议先后，也可读内存屏幕；继承 start/hideCursor 等不会自动经本 override 记日志。
class LoggingVirtualTerminal extends VirtualTerminal {
	// private 仅是 TS 访问限制，记录数组初始为空，不是写磁盘的日志。
	private writes: string[] = [];

	// 覆写 write：先记调用，再交父 xterm 队列；返回 void，不等解析完成，父方法异常仍向外传播。
	override write(data: string): void {
		// 即使后面的父写入失败，这条记录已经追加，没有回滚。
		this.writes.push(data);
		// super.write 真正排进内存模拟器，不写用户终端。
		super.write(data);
	}

	// 按顺序拼接当前记录并返回字符串；例如分开的两次 write 可用 includes/indexOf 检查跨块协议，不清记录。
	getWrites(): string {
		// join("") 不加分隔符，模拟连续的终端字符流。
		return this.writes.join("");
	}

	// 换成新空记录数组、返回 void；例如忽略首帧后只分析差量输出，不清 xterm 屏幕或它的待解析队列。
	clearWrites(): void {
		// 只清本类记录，父模拟器内容/光标保留。
		this.writes = [];
	}
}

// 临时更新指定环境键，在 await run 完成/拒绝后恢复旧值并返回结果；例如只在一个日志用例内开 REDRAW=1。
// <T> 把 Promise 完成值贯穿参数/返回类型，Record 值允许 undefined 表示删除。只隔离 updates 提供的键，不清理其它环境；回调错误在 finally 后继续传播。
// 保存/修改循环在 try 之前，若这些设置步骤自身抛错，下面 finally 不会执行；这里使用的普通键值由固定 fixture 提供。
async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	// 用 Map 保存每个被覆盖键的旧字符串或 undefined，与新值分开。
	const previousValues = new Map<string, string | undefined>();
	// Object.entries 得键值对，解构为 key/value，依次应用覆盖。
	for (const [key, value] of Object.entries(updates)) {
		// 保存原始值，供完成后恢复，不把缺失值强制转换成文本。
		previousValues.set(key, process.env[key]);
		// undefined 表示调用方要求移除这个键。
		if (value === undefined) {
			// delete 让变量真正缺失，避免写入字符串 "undefined"。
			delete process.env[key];
			// 其它值都是提供的字符串，包括空字符串。
		} else {
			// 只改当前测试进程环境，不改变父 shell 环境。
			process.env[key] = value;
		}
	}

	// 覆盖成功后保护整个异步回调范围。
	try {
		// return await 等到回调完成才进入 finally，不能写成不等待就返回 Promise 后立刻恢复环境。
		return await run();
		// 正常完成与 Promise 拒绝都会恢复，恢复后原结果/错误继续向外传。
	} finally {
		// 遍历之前保存的键及旧值，没有扩大到整个 process.env。
		for (const [key, value] of previousValues) {
			// 旧值缺失与旧值空字符串区分处理。
			if (value === undefined) {
				// 原先不存在就再次删除。
				delete process.env[key];
				// 原先有字符串则恢复它。
			} else {
				// 还原旧环境值，不保留临时新值。
				process.env[key] = value;
			}
		}
	}
}

// 立即读取内存视口某个格的斜体属性数值；例如 row1/col0 应为0，验证上一行斜体没泄漏。
// 调用方先等待渲染；按 viewportY 换算缓冲区行，缺行/格由 assert 抛错。只读取 xterm，不改样式或额外复制格内容。
function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	// 经 unknown 再断言成含 xterm 的对象以越过包装器 private 限制；as 不验证运行时结构，这里依赖已知 VirtualTerminal 实现。
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	// 选择当前活动缓冲区，不固定为 normal 或手动合并历史。
	const buffer = xterm.buffer.active;
	// row 是0基视口行，加 viewportY 才是完整缓冲中的行下标。
	const line = buffer.getLine(buffer.viewportY + row);
	// 若不存在则抛带行号错误，也让 TS 在后续知道 line 非 undefined。
	assert.ok(line, `Missing buffer line at row ${row}`);
	// col 是0基终端格列，不是字符串 UTF-16 下标；越界可能返回 undefined。
	const cell = line.getCell(col);
	// 要求该格存在，避免把缺格误当属性关闭。
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	// isItalic 按本机 xterm 类型返回 number，测试用0表示未启用，不应注释成返回 boolean。
	return cell.isItalic();
}

// 调度组观察 render 调用次数/最终组件状态，不用时长阈值证明所有平台的延迟上限。
describe("TUI render scheduling", () => {
	// 先排普通节流请求再连续送三块输入，等待 nextTick，要求即时帧只执行一次且呈现最后一块；不等待 xterm 屏幕解析。
	it("renders keyboard input without waiting for a throttled frame", async () => {
		// 创建40列10行内存终端。
		const terminal = new VirtualTerminal(40, 10);
		// 以 TUI 接口声明真实主屏实例，类型标注不产生额外包装。
		const tui: TUI = new TuiMainScreen(terminal);
		// 计数/输入组件用于直接观测帧执行和输入覆盖。
		const component = new InputComponent();
		// 首帧内容为 initial。
		component.lines = ["initial"];
		// 挂到基础组件树，addChild 本身不绘制。
		tui.addChild(component);
		// 把输入目标设为该组件；它不是 Focusable，仍可通过 handleInput 接收数据。
		tui.setFocus(component);
		// 连接内存输入回调、隐藏模拟光标并排首帧；没有接管真实终端。
		tui.start();
		// 同步满足首帧请求，记录稳定的初始调用次数。
		tui.renderNow();
		// 保存当前计数，后面的预期是在此基础加1，不假定全程固定起始次数。
		const renderCountBeforeInput = component.renderCount;

		// Queue a normal throttled render first. Keyboard input should preempt it.
		// 先改成 pending，但不立刻渲染。
		component.lines = ["pending"];
		// 普通请求会经 nextTick/定时器节流，随后应被输入即时帧抢占。
		tui.requestRender();
		// 同步调用已保存的输入处理，组件行先变成 first，并请求即时帧。
		terminal.sendInput("first");
		// 同轮第二块覆盖为 second，即时帧请求应合并。
		terminal.sendInput("second");
		// 最后一块覆盖为 typed，前两块不要求分别绘一帧。
		terminal.sendInput("typed");
		// Promise<void> 注册 nextTick 屏障，给此前即时绘制执行机会；不是等待未来所有定时器或真实显示完成。
		await new Promise<void>((resolve) => process.nextTick(resolve));

		// 本轮三块输入和普通请求合并成恰好一次 render。
		assert.strictEqual(component.renderCount, renderCountBeforeInput + 1);
		// 组件实际保存最后一块输入；这里没有对 xterm 视口作断言。
		assert.deepStrictEqual(component.lines, ["typed"]);
		// 正常尾部停止 TUI，解除 exit/输入回调和普通渲染定时器；若前面断言抛错不会走到这里。
		tui.stop();
	});
});

// 调试日志组真的写临时文件，检查配置目录被采用；不向用户目录写固定日志。
describe("TUI debug logging", () => {
	// 开启重绘日志并传独立目录，首帧后读内容匹配原因，finally 删除目录；环境 fixture 自己恢复开关。
	it("writes redraw logs to the provided directory", async () => {
		// mkdtempSync 在 OS 临时目录创建带随机后缀的新目录，不是只拼出路径。
		const logDir = mkdtempSync(join(tmpdir(), "pi-tui-log-"));
		// 保护后面的日志 fixture，确保最终清理目录。
		try {
			// 仅这一异步范围把 REDRAW 设1，run 完成或拒绝后恢复原值。
			await withEnv({ PI_TUI_DEBUG_REDRAW: "1" }, async () => {
				// 渲染输出仍交内存 xterm，磁盘副作用仅日志分支。
				const terminal = new VirtualTerminal(40, 10);
				// 第二参数 undefined 使用默认硬件光标策略，第三参数明确指定日志目录。
				const tui: TUI = new TuiMainScreen(terminal, undefined, logDir);
				// 用最小组件提供固定行。
				const component = new TestComponent();
				// 追加到基础组件树。
				tui.addChild(component);
				// 首帧只有 test 文本。
				component.lines = ["test"];
				// 启动并安排首帧，日志尚不保证已写。
				tui.start();
				// 辅助方法先 nextTick、再约20ms等待、最后 flush xterm，给常规首帧执行机会；不是通用“所有任务都完成”保证。
				await terminal.waitForRender();

				// 同步读取 UTF-8 日志，正则只要求包含首帧原因，不比较时间戳或所有行；读失败会抛错。
				assert.match(readFileSync(join(logDir, "pi-tui-debug.log"), "utf-8"), /fullRender: first render/);
				// 正常路径停 TUI；环境/目录有 finally，但这句本身不在专门的 finally 中。
				tui.stop();
			});
			// 不管异步 fixture 是否成功，都会尝试移除临时目录。
		} finally {
			// recursive 删除其中日志，force 容忍目录已不存在；其它删除错误仍可抛出。
			rmSync(logDir, { recursive: true, force: true });
		}
	});
});

// 大输出组检查单次 write 分块和连续流内容，不用实际终端消费百万字符载荷。
describe("TUI bounded render output", () => {
	// 两条大 Kitty 示例组成首帧：要求每次 write 不超上限，合并后严格等于原同步输出流。
	it("splits a large full render without changing its output", () => {
		// 只记录写入，不模拟屏幕；不会把巨大图片交真实用户终端。
		const terminal = new BoundedWriteTerminal();
		// 创建真实渲染器但不 start，后面显式 renderNow 仍可绘制，因为初始 stopped 为 false。
		const tui = new TuiMainScreen(terminal);
		// 固定行由假组件提供，没有自动宽度截断。
		const component = new TestComponent();
		// 1_200_000 的下划线是数字分隔符，仍为1200000；载荷全 A，图片前缀使主屏跳过普通行末复位，不验证真实 PNG；首帧整绘本身不做差量路径的普通行宽检查。
		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		// 两行都使用同一个 kittyLine 字符串值，输出必须包含两张示例行。
		component.lines = [kittyLine, kittyLine];
		// 挂载组件，但尚未注册输入或定时帧。
		tui.addChild(component);

		// 同步执行首帧，分块过程会多次调用替身 write。
		tui.renderNow();

		// 断言有超过两次写入，排除整帧一次性写出的实现。
		assert.ok(terminal.writes.length > 2, "large output should be split across terminal writes");
		// every 对所有记录块检查上限，第二参数是失败诊断文字。
		assert.ok(
			// write 是每块字符串；length 按 UTF-16 码元，不保证按 UTF-8 字节限制。
			terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS),
			// 只在断言失败时显示的说明，不写进实际渲染流。
			"each terminal write should stay below the configured limit",
		);
		// 再精确比较合并结果，防分块丢失/重复字符；此例不含代理对，不能单独证明 Unicode 切点规则。
		assert.strictEqual(
			// 按 write 顺序直接连接，不添加分隔符。
			terminal.writes.join(""),
			// CSI ?2026h/l 是同步输出开/关请求，中间两条图片行用 CRLF 隔开；只比协议串，不保证终端支持此模式。
			`\x1b[?2026h${kittyLine}\r\n${kittyLine}\x1b[?2026l`,
			// 失败诊断指出分块应保持整体字符流。
			"chunking must preserve the synchronized render output",
		);
	});

	// 在已有正文后追加两条大图，检查分块仍适用于差量路径且不会出现清屏重绘码。
	it("splits large differential updates without a full redraw", () => {
		// 仅记录 write 的固定尺寸替身。
		const terminal = new BoundedWriteTerminal();
		// 真实主屏实例，不 start 也可显式绘制。
		const tui = new TuiMainScreen(terminal);
		// 创建最小行源。
		const component = new TestComponent();
		// 挂载行源。
		tui.addChild(component);
		// 先放一行 before，建立旧帧比较基准。
		component.lines = ["before"];
		// 同步绘制旧帧。
		tui.renderNow();
		// writes 字段虽为 readonly，指向的数组仍可变；把 length 改0清记录，渲染器旧帧缓存仍保留。
		terminal.writes.length = 0;

		// 新的大图片示例包含1200000个 A，只测试流分块。
		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		// 保留首行不变，后面纯追加两张图片行。
		component.lines = ["before", kittyLine, kittyLine];
		// 同步执行差量更新。
		tui.renderNow();

		// 本次输出也必须分成超过两块。
		assert.ok(terminal.writes.length > 2, "large output should be split across terminal writes");
		// 每块都按码元长度不超过1048576。
		assert.ok(terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS));
		// 合并本次差量写入，不包含已清记录的首帧。
		const output = terminal.writes.join("");
		// 流开头带同步输出开始请求。
		assert.ok(output.startsWith("\x1b[?2026h"));
		// 流结尾带同步输出结束请求；替身 hideCursor 无额外记录，所以结尾可直接这样检查。
		assert.ok(output.endsWith("\x1b[?2026l"));
		// 没有 CSI2J 是此项对“未全屏重绘”的检查，没有精确比较所有差量正文。
		assert.ok(!output.includes("\x1b[2J"), "the update should stay on the differential render path");
	});
});

// 普通屏 OSC133 测试检查行首提示标记被剥离，避免它们被真实终端误解成新的 shell 提示；此处只检查返回写流。
describe("TUI OSC 133 markers", () => {
	// 先首帧 BEL 结束标记，再差量 ST 结束标记；两次的正文都应保留，控制前缀不应输出。
	it("does not write OSC 133 prompt markers to the terminal", () => {
		// Terminals read 133;A as a new shell prompt and drop the OSC 7501 program status.
		// 使用记录替身，不让测试协议到达真实终端。
		const terminal = new BoundedWriteTerminal();
		// 普通主屏实例，与全屏提示导航路径不同。
		const tui = new TuiMainScreen(terminal);
		// 构造可替换行源。
		const component = new TestComponent();
		// 先挂载再设置输入行。
		tui.addChild(component);
		// 第一行有 A，第二行连续 B/C，均位于行首并以 BEL 结束；实际实现只剥行首连续A/B/C，不涵盖任意位置。
		component.lines = ["\x1b]133;A\x07prompt", "\x1b]133;B\x07\x1b]133;C\x07output"];
		// 同步首帧，记录剥离后的结果。
		tui.renderNow();
		// 展开原数组保留旧行，再添加 ST 结束的 A 和 B/C 两行，覆盖另一种终止形式。
		component.lines = [...component.lines, "\x1b]133;A\x1b\\reply", "\x1b]133;B\x1b\\\x1b]133;C\x1b\\done"];
		// 同步差量绘制新增行。
		tui.renderNow();

		// 拼两帧所有 write，检查没有任何这些 fixture 中的 OSC133 残留。
		const output = terminal.writes.join("");
		// 结果不含该前缀；不能由这些行首例子推论所有嵌入 OSC133 都被清除。
		assert.ok(!output.includes("\x1b]133;"), "regular mode must not emit OSC 133 markers");
		// for...of 逐个检查四段正文仍存在，只是 includes，不验证各段唯一次数/精确位置。
		for (const text of ["prompt", "output", "reply", "done"]) assert.ok(output.includes(text));
	});
});

/** Set each environment variable to `value`, returning a function that restores the previous state. */
// 把 names 中每个环境键改成同一 value，返回恢复闭包；例如暂把 TMPDIR/TEMP/TMP 指向新目录。
// readonly string[] 只限制 TS 从参数引用修改数组，不冻结对象；返回类型 () => void 表明拿到的是未来才执行的恢复函数，不会自动 finally。
function overrideEnv(names: readonly string[], value: string): () => void {
	// map 建立旧键/值二元组快照；as const 保留只读元组位置类型，旧值可能 undefined。
	const previousValues = names.map((name) => [name, process.env[name]] as const);
	// 逐个遍历目标键。
	for (const name of names) {
		// 当前进程内写入共同的新字符串。
		process.env[name] = value;
	}
	// 返回箭头闭包，捕获旧值；只有调用方稍后调用它才恢复，不是现在恢复。
	return () => {
		// 解构每个保存的键名和旧值。
		for (const [name, previousValue] of previousValues) {
			// 原先缺失就删除，不写 "undefined" 字符串。
			if (previousValue === undefined) delete process.env[name];
			// 原先存在则恢复旧字符串，包括空串。
			else process.env[name] = previousValue;
		}
	};
}

// 无日志目录的崩溃路径应使用 OS 临时目录；本组不写用户 home，而在专属临时目录留一份诊断后清掉。
describe("TUI crash dump without configured log directory", () => {
	// 先正常首帧，再追加超宽普通行以触发差量错误；验证错误提及隔离路径且日志包含终端宽度，finally 恢复环境/删目录。
	it("writes the crash dump to the OS temp directory instead of a home-directory default", async () => {
		// The TUI falls back to os.tmpdir() when no log directory is configured, so
		// isolate the test by pointing the temp directory at a fresh directory rather
		// than sharing the real one with concurrent test runs. os.tmpdir() reads
		// TMPDIR on POSIX and TEMP/TMP on Windows, so override all three.
		// 先按原 tmpdir 创建独立目录，随后才改变临时目录环境，避免递归依赖新值。
		const crashDir = mkdtempSync(join(tmpdir(), "pi-tui-crash-"));
		// 预期渲染器使用固定文件名 pi-tui-crash.log。
		const crashLogPath = join(crashDir, "pi-tui-crash.log");
		// POSIX/Windows 读取的三个临时目录变量都覆盖；只保存恢复闭包，此刻环境已经改了。
		const restoreTmpdirEnv = overrideEnv(["TMPDIR", "TEMP", "TMP"], crashDir);
		// 后续同步/异步错误都会进入 finally 恢复环境及清目录。
		try {
			// 使用40列10行内存模拟器。
			const terminal = new VirtualTerminal(40, 10);
			// 不传 logDirectory，使实际错误分支回退到 os.tmpdir。
			const tui: TUI = new TuiMainScreen(terminal);
			// 该假组件故意不截宽，才能构造组件契约违规。
			const component = new TestComponent();
			// 加入主屏。
			tui.addChild(component);
			// 首帧先是合法短行，避免把错误放在不做该宽检的首帧整绘路径。
			component.lines = ["ok"];
			// 启动并排首帧。
			tui.start();
			// 等待常规帧及 xterm 写队列，建立上一帧缓存。
			await terminal.waitForRender();

			// Width overflow is detected in the differential render path
			// 追加60个 ASCII x，实际列宽60超过40；旧首行保留，下一次会进差量检查。
			component.lines = ["ok", "x".repeat(60)];
			// assert.throws 要求同步抛错，第二回调验证抛出对象而不是异步拒绝。
			assert.throws(
				// renderNow 同步执行真正渲染，普通行超宽路径会先写日志、stop，再抛 Error；文件操作失败则可能更早抛。
				() => tui.renderNow(),
				// 异常来源按 unknown 处理，先缩窄后才能访问 message；不凭 TS 假定任意 throw 都是 Error。
				(error: unknown) => {
					// 运行时确认确为 Error，并让 TS 缩窄类型。
					assert.ok(error instanceof Error);
					// 错误信息必须包含预期的临时日志路径；不精确断言整条建议文本。
					assert.ok(error.message.includes(crashLogPath), `error message should reference ${crashLogPath}`);
					// 返回 true 告诉 assert.throws 该错误符合验证器要求。
					return true;
				},
			);
			// 同步读实际生成文件并匹配 Terminal width: 40，证明日志确实落在隔离目录。
			assert.match(readFileSync(crashLogPath, "utf-8"), /Terminal width: 40/);
			// 正常宽度错误会在实现中 stop；这里 finally 主要清环境和目录，不额外 stop 任意中途失败的 TUI。
		} finally {
			// 先恢复临时目录变量；若这步自身抛错，下一句不是独立 finally，不能保证仍执行。
			restoreTmpdirEnv();
			// 递归删除本项自建目录及崩溃文件，force 容忍不存在。
			rmSync(crashDir, { recursive: true, force: true });
		}
	});
});

// Kitty 图片组检查删除/预留控制的相对顺序；内存 xterm 不会证明真实图片成功显示，重要断言直接看写流。
describe("TUI Kitty image cleanup", () => {
	// 向正文后追加2行图片，要求先擦完整预留区域，再上移放图、下移回占位末端，避免后擦行毁掉新放置。
	it("clears reserved Kitty image rows before drawing appended image placements", async () => {
		// 固定 Kitty 能力，消除本机检测对组件编码的影响。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 单格10×10px，20×20图按2列显示占2行。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// finally 只恢复能力/格尺寸；TUI 的 stop 仍在正常尾部。
		try {
			// 带写流记录的40×10内存终端。
			const terminal = new LoggingVirtualTerminal(40, 10);
			// 主屏以接口类型引用。
			const tui: TUI = new TuiMainScreen(terminal);
			// 组件可容纳普通文字和图片占位行。
			const component = new TestComponent();
			// 挂载该组件。
			tui.addChild(component);

			// 先绘普通 before 行，建立差量基准。
			component.lines = ["before"];
			// 连接模拟输入并排首帧。
			tui.start();
			// 等待首帧/写队列完成。
			await terminal.waitForRender();
			// 清首帧写记录，保留屏幕和渲染器缓存。
			terminal.clearWrites();

			// 构造图片组件；显式尺寸让占位计算不依赖有效 PNG 文件。
			const image = new Image(
				// 占位 base64，非完整图片解码测试。
				"AAAA",
				// PNG MIME 直接走 Kitty 编码，不安装转码器。
				"image/png",
				// 回退着色回调原样返回文本。
				{ fallbackColor: (value) => value },
				// 最大内容宽两列。
				{ maxWidthCells: 2 },
				// 源图20×20px，配当前方格成为2×2格。
				{ widthPx: 20, heightPx: 20 },
			);
			// 父宽40仍受选项限制成2列，返回图片串及一个空占位行。
			const imageLines = image.render(40);
			// 保存首行完整协议串，用于检查写流中的精确相对顺序。
			const imageSequence = imageLines[0];
			// 展开图片数组把占位行也放进组件内容，末尾接 after。
			component.lines = ["before", ...imageLines, "after"];
			// 请求异步差量更新，不是当场写出。
			tui.requestRender();
			// 等待节流帧和此前 xterm 队列。
			await terminal.waitForRender();

			// 取得清记录后所有 write 的连续字符串。
			const writes = terminal.getWrites();
			// 检查正向要求：清两行必须先于图片上传/放置出现。
			assert.ok(
				// 2K擦首行，CRLF到下一行再2K，1A回起点放图，1B回占位末行；控制码只进模拟器。
				writes.includes(`\x1b[2K\r\n\x1b[2K\x1b[1A${imageSequence}\x1b[1B`),
				// 断言失败时解释预留行清理顺序。
				"reserved rows should be cleared before the image placement is drawn",
			);
			// 同时检查不允许的图后清行片段，防止仅出现正向片段却还重复擦新图。
			assert.ok(
				// 不应先发图像再立即换行2K擦其占位；这里只排除该具体片段。
				!writes.includes(`${imageSequence}\r\n\x1b[2K`),
				// 这是失败诊断文字，不参与渲染。
				"reserved row clears must not run after the image placement is drawn",
			);

			// 所有断言通过后正常 stop；此前失败时仅下面能力/格尺寸清理仍执行。
			tui.stop();
			// 即使异步步骤或断言失败，也恢复共享图片配置。
		} finally {
			// 清能力结果，不清登记的图片元数据。
			resetCapabilitiesCache();
			// 单格像素回到常规9×18。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 图片占位比视口还高，差量预清会越界，主屏应退回全屏重绘；检查计数增长与清屏码出现。
	it("falls back to full redraw when Kitty image pre-clear would scroll", async () => {
		// 强制 Kitty 图片编码。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 方格10×10px，让30×30图占三行。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// finally 恢复配置，不保证中途错误后也调用正常尾部 stop。
		try {
			// 终端仅两行高，故三行图片无法安全在差量预清区内放下。
			const terminal = new LoggingVirtualTerminal(40, 2);
			// 创建真实主屏渲染器。
			const tui: TUI = new TuiMainScreen(terminal);
			// 最小行源。
			const component = new TestComponent();
			// 挂载到基础树。
			tui.addChild(component);

			// 先一行 before。
			component.lines = ["before"];
			// 启动排首帧。
			tui.start();
			// 等待首帧完成以保存比较基线。
			await terminal.waitForRender();
			// 记录此时的整绘次数，后面只检查增长而非固定绝对次数。
			const redrawsBeforeImage = tui.fullRedraws;
			// 清历史 write，方便只找本次退路清屏。
			terminal.clearWrites();

			// 构造三行图片，足以超出两行终端。
			const image = new Image(
				// 占位 base64，没有真实像素解码。
				"AAAA",
				// PNG MIME 免转码。
				"image/png",
				// 回退主题原样输出。
				{ fallbackColor: (value) => value },
				// 最大宽三格。
				{ maxWidthCells: 3 },
				// 源图30×30px，配方格得到三行。
				{ widthPx: 30, heightPx: 30 },
			);
			// 将图片串及空占位展开追加，再接 after 文字。
			component.lines = ["before", ...image.render(40), "after"];
			// 普通请求先尝试差量逻辑，由实际预清检查决定是否整绘。
			tui.requestRender();
			// 等待本次帧及写解析。
			await terminal.waitForRender();

			// 整绘计数必须增加；该断言不要求精确只增加一次。
			assert.ok(tui.fullRedraws > redrawsBeforeImage, "unsafe image pre-clear should force a full redraw");
			// 写流包含 CSI2J 清可见屏码，作为整绘退路的另一项证据。
			assert.ok(terminal.getWrites().includes("\x1b[2J"), "fallback should clear and fully redraw");

			// 正常完成后停 TUI。
			tui.stop();
			// 成功/异常均恢复下面的图片配置。
		} finally {
			// 清能力缓存。
			resetCapabilitiesCache();
			// 格像素恢复9×18。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 五行屏已填满后再追加三行图片，导致整绘退路；整绘也要先预留两行、上移放图、下移，不能图后再写占位。
	it("reserves Kitty image rows before drawing during full redraw fallbacks", async () => {
		// 固定 Kitty 能力，图像数据仅进内存模拟器。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 每格10×10px。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// 用 finally 还原共享图片配置，stop 仍只在正常尾部。
		try {
			// 40列5行内存终端，首帧正好填满视口。
			const terminal = new LoggingVirtualTerminal(40, 5);
			// 真实普通主屏渲染器。
			const tui: TUI = new TuiMainScreen(terminal);
			// 可替换行的最小组件。
			const component = new TestComponent();
			// 挂载组件，接下来的 start 才安排帧。
			tui.addChild(component);

			// 五行短文字形成已满屏的旧画面。
			component.lines = ["l0", "l1", "l2", "l3", "l4"];
			// 启动模拟输入/排首帧。
			tui.start();
			// 等首帧渲染和此前 xterm 写队列。
			await terminal.waitForRender();
			// 保存整绘计数基线。
			const redrawsBeforeImage = tui.fullRedraws;
			// 清写记录，不清屏幕或主屏缓存。
			terminal.clearWrites();

			// 创建三格高的图片组件。
			const image = new Image(
				// 占位数据，不验证是否完整 PNG。
				"AAAA",
				// PNG MIME 使 Kitty 无需转码。
				"image/png",
				// 回退主题回调原样返回。
				{ fallbackColor: (value) => value },
				// 最大内容宽三列。
				{ maxWidthCells: 3 },
				// 源图30×30配方格成为三行。
				{ widthPx: 30, heightPx: 30 },
			);
			// 生成首行图片串及后续两个空占位行。
			const imageLines = image.render(40);
			// 保存完整首行协议，精确检查它前后的控制码。
			const imageSequence = imageLines[0];
			// 五行正文之后展开图片三行，再接 after，总高度超过视口。
			component.lines = ["l0", "l1", "l2", "l3", "l4", ...imageLines, "after"];
			// 普通排帧先按变化判断，实际实现会发现预清越出当前视口而整绘。
			tui.requestRender();
			// 等待该帧和写入解析。
			await terminal.waitForRender();

			// 获取本次更新的连续写流。
			const writes = terminal.getWrites();
			// 要求整绘次数比首帧后增加，未要求只增加一次。
			assert.ok(tui.fullRedraws > redrawsBeforeImage, "scrolling image append should force a full redraw");
			// 验证整绘顺序的具体片段。
			assert.ok(
				// 先 CRLF 两次预留图片后两行，再上移2行放图，最后下移2行回末端。
				writes.includes(`\r\n\r\n\x1b[2A${imageSequence}\x1b[2B`),
				// 失败说明指出必须先预留，而不是实际发送给终端的内容。
				"full redraw should reserve visible image rows before drawing the placement",
			);
			// 负向断言排除图后紧接占位行重置的旧路径。
			assert.ok(
				// 图片之后不应 CRLF 再写 SGR0 占位行；这里只排除这个连续片段。
				!writes.includes(`${imageSequence}\r\n\x1b[0m`),
				// 失败诊断文字说明图后补占位会出问题。
				"full redraw must not write reserved padding rows after drawing the placement",
			);

			// 正常断言完成后 stop，不是 finally 中的终端清理。
			tui.stop();
			// 始终恢复测试进程中的图片配置。
		} finally {
			// 清能力缓存，但不清元数据登记表。
			resetCapabilitiesCache();
			// 格像素回到9×18。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 六行图片高于五行视口时，整绘必须保留第一行直接放图路径，不能先预留后上移五行；检查图确实出现且无该上移片段。
	it("does not use cursor-up placement for Kitty images taller than the viewport", async () => {
		// 明确 Kitty 能力。
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		// 方格10×10px便于60×60图生成六行。
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		// finally 负责配置恢复，正常 stop 仍在 try 尾部。
		try {
			// 终端视口仅五行。
			const terminal = new LoggingVirtualTerminal(40, 5);
			// 创建主屏渲染器。
			const tui: TUI = new TuiMainScreen(terminal);
			// 创建最小组件。
			const component = new TestComponent();
			// 挂载行源。
			tui.addChild(component);

			// 先绘 before，建立非空旧帧。
			component.lines = ["before"];
			// 连接内存终端并安排首帧。
			tui.start();
			// 等待首帧建立比较状态。
			await terminal.waitForRender();
			// 清首帧记录，后面只检查强制更新。
			terminal.clearWrites();

			// 构造比视口还高的图片。
			const image = new Image(
				// 占位 PNG 数据。
				"AAAA",
				// PNG MIME 不转码。
				"image/png",
				// 主题原样返回回退文字。
				{ fallbackColor: (value) => value },
				// 最大宽六列，正方形图得到六行。
				{ maxWidthCells: 6 },
				// 源60×60像素配10×10格。
				{ widthPx: 60, heightPx: 60 },
			);
			// 按父宽40仍受六列选项约束，返回六行。
			const imageLines = image.render(40);
			// 取首行上传/放置串。
			const imageSequence = imageLines[0];
			// 先验证 fixture 真高于视口，避免“没有上移”只是小图没进入目标条件。
			assert.ok(imageLines.length > terminal.rows, "test image should exceed the viewport height");

			// 把全部图片占位夹在 before/after 中。
			component.lines = ["before", ...imageLines, "after"];
			// true 强制重置渲染缓存、排即时帧，不同步绘制；本项直接覆盖整绘大图分支。
			tui.requestRender(true);
			// 等待即时帧与 xterm 写解析。
			await terminal.waitForRender();

			// 获取强制更新的控制字符流。
			const writes = terminal.getWrites();
			// 要求图片串实际被输出，不能因完全跳过图片而通过下一条负断言。
			assert.ok(writes.includes(imageSequence), "image placement should be drawn");
			// 检查不可采用的预留后上移路径。
			assert.ok(
				// 拒绝紧接在图片前的五行上移（六行减一）；不表示整帧不含任何其它光标移动。
				!writes.includes(`\x1b[${imageLines.length - 1}A${imageSequence}`),
				// 保留原回归编号 #4461 的失败诊断，指向第一行直接放置规则。
				"taller-than-viewport images must keep the #4461 first-row placement path",
			);

			// 正常路径结束时停止 TUI。
			tui.stop();
			// 无论成功/异常都恢复图片设置。
		} finally {
			// 清能力结果缓存。
			resetCapabilitiesCache();
			// 恢复9×18单格像素。
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	// 同 ID42 换载荷并从第二行移到第一行时，要求先删除旧图，再发送新串；通过写流索引证明相对顺序。
	it("deletes changed image ids before drawing moved placements", async () => {
		// 40×10内存终端，同时记录 write。
		const terminal = new LoggingVirtualTerminal(40, 10);
		// 主屏渲染器会记住上一帧 Kitty ID 集合。
		const tui: TUI = new TuiMainScreen(terminal);
		// 固定行组件。
		const component = new TestComponent();
		// 挂载到基础树。
		tui.addChild(component);

		// 低层直接编码 ID42、2列2行、C=1；不自动生成占位数组或注册元数据。
		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		// 旧图位于 top 后面一行，本 fixture 没有给旧图追加任何空占位行。
		component.lines = ["top", oldImage];
		// 启动并排首帧。
		tui.start();
		// 等首帧记住 ID42。
		await terminal.waitForRender();
		// 清写流记录，保持上一帧 ID 跟踪。
		terminal.clearWrites();

		// 仍为 ID42，但新载荷 BBBB、高改1行；BBBB 同样只用于编码，不验证图像有效性。
		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		// 新图移到第0行，第1行变空，触发旧/新图区变化。
		component.lines = [newImage, ""];
		// 请求后续更新。
		tui.requestRender();
		// 等待一帧及此前写解析。
		await terminal.waitForRender();

		// 拼出这次差量更新流。
		const writes = terminal.getWrites();
		// indexOf 查首次 ID42 删除命令位置，缺失为-1。
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		// 查首次新图串位置；不是查询终端里真的存在图像。
		const drawIndex = writes.indexOf(newImage);
		// 删除命令必须存在，防止-1参与顺序比较导致误判。
		assert.ok(deleteIndex >= 0, "changed old image should be deleted");
		// 新图串也必须存在。
		assert.ok(drawIndex >= 0, "new image should be drawn");
		// 删除在重画之前，检查字符流顺序而非终端执行确认。
		assert.ok(deleteIndex < drawIndex, "old image must be deleted before the new placement is drawn");

		// 正常末尾停 TUI。
		tui.stop();
	});

	// 前一行文字改变时，即使后面的图片字符串没变，也要扩变化区删除并重画该图；本 fixture 检查此前行影响，不直接模拟真实图片覆盖像素。
	it("redraws image lines when an earlier reserved image row changes", async () => {
		// 记录写流的内存终端。
		const terminal = new LoggingVirtualTerminal(40, 10);
		// 主屏渲染器按旧/新行扩展图片变化区。
		const tui: TUI = new TuiMainScreen(terminal);
		// 最小组件保存两行。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// ID88 图片声称2行，禁止终端自行移动光标。
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
		// 空白行在图片之前，不是 Image 组件通常返回的“图片后空占位”；本项以此构造历史回归形状。
		component.lines = ["", image];
		// 启动并排首帧。
		tui.start();
		// 等待旧图 ID88 被主屏跟踪。
		await terminal.waitForRender();
		// 清记录，以观察下一次更新。
		terminal.clearWrites();

		// 只改图片前的空行成 covered，图片字符串保持完全相同。
		component.lines = ["covered", image];
		// 普通请求并非显式强制整绘。
		tui.requestRender();
		// 等待差量帧及解析。
		await terminal.waitForRender();

		// 取得更新的连续字符流。
		const writes = terminal.getWrites();
		// 查旧 ID88 删除位置。
		const deleteIndex = writes.indexOf(deleteKittyImage(88));
		// 查相同图片串再次出现的位置。
		const drawIndex = writes.indexOf(image);
		// 即使图片文本没变，也要求删除旧放置/数据的命令存在。
		assert.ok(deleteIndex >= 0, "image should be deleted when a reserved row changes");
		// 要求旧串重画，不能只删不画。
		assert.ok(drawIndex >= 0, "unchanged image line should be redrawn after deleting the placement");
		// 删除必须发生在重画之前。
		assert.ok(deleteIndex < drawIndex, "old placement must be deleted before the image line is redrawn");
		// 排除 CSI2J 清屏码，证明这个 fixture 不应靠整绘退路通过。
		assert.ok(!writes.includes("\x1b[2J"), "reserved row changes should not force a full redraw");

		// 正常断言后停止。
		tui.stop();
	});

	// 强制整绘并移除旧图时，旧 ID77 删除命令要先于清屏，避免旧放置残留。
	it("deletes previously rendered image ids during full redraws", async () => {
		// 内存模拟器兼记录写流。
		const terminal = new LoggingVirtualTerminal(40, 10);
		// 真实主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 可变行组件。
		const component = new TestComponent();
		// 挂载到主屏。
		tui.addChild(component);

		// 首帧只放低层 ID77 图串；没有 Image 组件补出的空占位行。
		component.lines = [encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false })];
		// 启动并排首帧。
		tui.start();
		// 等待旧图 ID 集合形成。
		await terminal.waitForRender();
		// 丢弃首帧记录。
		terminal.clearWrites();

		// 新帧移除图片，只显示普通文字。
		component.lines = ["plain text"];
		// 强制重置比较缓存并排即时帧；旧 ID 集合仍保留供整绘先删除。
		tui.requestRender(true);
		// 等待强制帧完成。
		await terminal.waitForRender();

		// 取得本次输出。
		const writes = terminal.getWrites();
		// 首次删除 ID77 的协议位置。
		const deleteIndex = writes.indexOf(deleteKittyImage(77));
		// 首次清可见屏 CSI2J 的位置。
		const clearIndex = writes.indexOf("\x1b[2J");
		// 删除必须出现。
		assert.ok(deleteIndex >= 0, "previous image should be deleted during full redraw");
		// 清屏也必须出现。
		assert.ok(clearIndex >= 0, "full redraw should clear the screen");
		// 删除在清屏之前，不是只检查二者都存在。
		assert.ok(deleteIndex < clearIndex, "old image should be deleted before the screen is cleared");

		// 正常路径停止主屏。
		tui.stop();
	});
});

// 尺寸变化组通过内存 resize 回调驱动真实排帧，区分一般高度变化、Termux 高度策略和列宽变化。
describe("TUI resize handling", () => {
	// 明确移除 Termux 线索后把高度10改15，要求整绘且首行内容仍在。
	it("triggers full re-render when terminal height changes", async () => {
		// undefined 临时删除环境键，异步结束后 fixture 恢复旧值。
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			// 初始40列10行的虚拟屏。
			const terminal = new VirtualTerminal(40, 10);
			// 创建主屏。
			const tui: TUI = new TuiMainScreen(terminal);
			// 固定行组件。
			const component = new TestComponent();
			// 挂载。
			tui.addChild(component);

			// 内容三行，少于初始视口高度。
			component.lines = ["Line 0", "Line 1", "Line 2"];
			// 启动首帧。
			tui.start();
			// 等待初始渲染/写队列。
			await terminal.waitForRender();

			// 保存已发生整绘的次数。
			const initialRedraws = tui.fullRedraws;

			// Resize height
			// 只改高为15，宽40保持；包装器会同步发 resize 回调排后续帧。
			terminal.resize(40, 15);
			// 等待重新绘制和解析，不假定 resize 调用当场完成重画。
			await terminal.waitForRender();

			// Should have triggered a full redraw
			// 普通环境高度改变应增加整绘次数。
			assert.ok(tui.fullRedraws > initialRedraws, "Height change should trigger full redraw");

			// 读当时可见行的新数组，不是对将来屏幕变化保持链接的对象。
			const viewport = terminal.getViewport();
			// 只检查第0行包含 Line0；未逐行比较全部内容或清屏协议。
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			// 正常结束 stop；环境恢复由 withEnv finally 独立负责。
			tui.stop();
		});
	});

	// Termux 只改变高度时不重放整段历史：连续四次调整高，要求整绘次数不变、无清屏/清历史且最新行仍可见。
	it("skips full re-render on height changes in Termux", async () => {
		// 字符串1作为 Termux 存在性标记，不模拟 Android 真机。
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			// 虚拟终端记录原控制流，初始40×10。
			const terminal = new LoggingVirtualTerminal(40, 10);
			// 创建主屏，策略依据环境标记判断。
			const tui: TUI = new TuiMainScreen(terminal);
			// 创建可变内容组件。
			const component = new TestComponent();
			// 挂载。
			tui.addChild(component);

			// Array.from 建20行 Line0..Line19；_ 是未使用的元素值，i 是0基索引，内容会超过一屏。
			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			// 启动渲染。
			tui.start();
			// 等初始20行输出及模拟器滚动。
			await terminal.waitForRender();
			// 清首帧流，后面只分析 resize 输出。
			terminal.clearWrites();

			// 记录初始整绘计数。
			const initialRedraws = tui.fullRedraws;
			// 逐个使用15/8/14/11行，覆盖升高与降低，仍保持列宽40。
			for (const height of [15, 8, 14, 11]) {
				// 同步修改模拟器尺寸并通知主屏。
				terminal.resize(40, height);
				// 每次等一轮，避免四次被合并成只测试最终尺寸。
				await terminal.waitForRender();
			}

			// 整个序列没有增加整绘次数；不表示 Termux 的任何其它变化永远不会整绘。
			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");
			// 更新流不含擦可见屏的 CSI2J。
			assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Height change should not clear the screen");
			// 更新流也不含清滚动历史的 CSI3J。
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");

			// 读取最后11行高状态的视口。
			const viewport = terminal.getViewport();
			// 拼视口只检查最新 Line19 存在，没有精确比较每次 resize 的全部历史布局。
			assert.ok(viewport.join("\n").includes("Line 19"), "Latest content remains visible after resize");

			// 正常结束停 TUI，再由 fixture 恢复 Termux 变量。
			tui.stop();
		});
	});

	// 仅把宽40改60时必须整绘；列宽变化会影响组件折行，不适用 Termux 的“仅高变化”优化。
	it("triggers full re-render when terminal width changes", async () => {
		// 创建初始40×10虚拟终端。
		const terminal = new VirtualTerminal(40, 10);
		// 真实主屏。
		const tui: TUI = new TuiMainScreen(terminal);
		// 固定行组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 先设置三行普通文字。
		component.lines = ["Line 0", "Line 1", "Line 2"];
		// 启动排首帧。
		tui.start();
		// 等待建立初始40列缓存。
		await terminal.waitForRender();

		// 保存整绘计数。
		const initialRedraws = tui.fullRedraws;

		// Resize width
		// 只改列为60，行数保持10。
		terminal.resize(60, 10);
		// 等待尺寸回调排出的更新帧。
		await terminal.waitForRender();

		// Should have triggered a full redraw
		// 检查计数增加，没有另断言完整屏幕文字或折行算法。
		assert.ok(tui.fullRedraws > initialRedraws, "Width change should trigger full redraw");

		// 正常结束停止。
		tui.stop();
	});
});

// 主动缩短清理组显式打开 clearOnShrink，检查缩到少量/一行/空时清除旧内容；默认策略不是由这些用例推断。
describe("TUI content shrinkage", () => {
	// 六行缩到两行后要求整绘、头两行保留、后面两行无非空白文字；不逐个断言整个十行视口。
	it("clears empty rows when content shrinks significantly", async () => {
		// 40×10内存终端。
		const terminal = new VirtualTerminal(40, 10);
		// 创建主屏。
		const tui: TUI = new TuiMainScreen(terminal);
		// 显式启用缩短时整绘清工作区；当前 setter 只改字段、不排帧，原英文环境说法不构成这里的额外运行逻辑。
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		// 最小组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// Start with many lines
		// 初始六行，给后面缩短形成旧工作区。
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		// 启动首帧。
		tui.start();
		// 等屏幕和缓存就绪。
		await terminal.waitForRender();

		// 保存首帧整绘次数。
		const initialRedraws = tui.fullRedraws;

		// Shrink to fewer lines
		// 保留前两行，移除其余四行。
		component.lines = ["Line 0", "Line 1"];
		// 请求下一帧以生效，直接改 lines 本身不排帧。
		tui.requestRender();
		// 等更新解析。
		await terminal.waitForRender();

		// Should have triggered a full redraw to clear empty rows
		// 启用 clearOnShrink 且无浮层时行数低于工作区高水位，要求整绘计数增加。
		assert.ok(tui.fullRedraws > initialRedraws, "Content shrinkage should trigger full redraw");

		// 读取可见行字符串快照。
		const viewport = terminal.getViewport();
		// 第0行仍有原首行文字。
		assert.ok(viewport[0]?.includes("Line 0"), "First line preserved");
		// 第1行仍有原第二行文字。
		assert.ok(viewport[1]?.includes("Line 1"), "Second line preserved");
		// Lines below should be empty (cleared)
		// 第2行 trim 后为空，允许显式空格；?. 缺行会得到 undefined，从而断言失败。
		assert.strictEqual(viewport[2]?.trim(), "", "Line 2 should be cleared");
		// 第3行也无非空白文字；未在此检查原第4/5行。
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 should be cleared");

		// 正常路径停止主屏。
		tui.stop();
	});

	// 四行缩成一条新文字，检查新首行和下一行清空，不额外检查整绘次数。
	it("handles shrink to single line", async () => {
		// 固定40×10虚拟终端。
		const terminal = new VirtualTerminal(40, 10);
		// 主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 明确开启缩短整绘策略，不依赖默认 false。
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		// 行源。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 初始四行旧内容。
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		// 启动排首帧。
		tui.start();
		// 等旧屏显示。
		await terminal.waitForRender();

		// Shrink to single line
		// 换为一行新内容 Only line。
		component.lines = ["Only line"];
		// 请求后续更新。
		tui.requestRender();
		// 等主屏更新和 xterm 解析。
		await terminal.waitForRender();

		// 取更新后的视口快照。
		const viewport = terminal.getViewport();
		// 第0行必须包含新文字。
		assert.ok(viewport[0]?.includes("Only line"), "Single line rendered");
		// 第1行 trim 后为空；这不是对所有旧尾行逐条断言。
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		// 正常停止，不放在 finally 中。
		tui.stop();
	});

	// 三行缩为空数组时应清旧屏；实际断言只检查前两行 trim 后为空，不声称整屏每行都已逐一验证。
	it("handles shrink to empty", async () => {
		// 创建40×10虚拟终端。
		const terminal = new VirtualTerminal(40, 10);
		// 主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 启用主动缩短清理。
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		// 最小组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 初始三行。
		component.lines = ["Line 0", "Line 1", "Line 2"];
		// 启动排首帧。
		tui.start();
		// 等待旧内容形成。
		await terminal.waitForRender();

		// Shrink to empty
		// 空数组表示组件不再返回任何行，不是返回一条空行。
		component.lines = [];
		// 请求更新以清除旧工作区。
		tui.requestRender();
		// 等待更新/解析。
		await terminal.waitForRender();

		// 读取当前可见屏幕字符串。
		const viewport = terminal.getViewport();
		// All lines should be empty
		// 第0行移除所有非空白内容。
		assert.strictEqual(viewport[0]?.trim(), "", "Line 0 should be cleared");
		// 第1行也清空，未断言其它8行。
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		// 正常停止。
		tui.stop();
	});
});

// 差量回归组从连续状态变化检验光标定位、局部文字更新、样式复位和视口退路；差量减少输出，不意味着只 render 变化组件。
describe("TUI differential rendering", () => {
	// 先五行缩到前三行都未改，再改中间一行；用最终文字所在行间接检查删除尾行后的光标记录，不直接访问私有 cursorRow。
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		// 40×10内存屏，所有初始内容可见。
		const terminal = new VirtualTerminal(40, 10);
		// 主屏默认 clearOnShrink=false，后续删除可以走差量清尾而非主动缩短整绘。
		const tui: TUI = new TuiMainScreen(terminal);
		// 可替换行组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// Initial render: 5 identical lines
		// 五行各自有不同编号；原英文 identical 指与后续保留行对应内容相同，不是五行彼此相同。
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		// 启动。
		tui.start();
		// 等首帧。
		await terminal.waitForRender();

		// Shrink to 3 lines, all identical to before (no content changes in remaining lines)
		// 移除最后两行，保留的前三行字符串完全不变。
		component.lines = ["Line 0", "Line 1", "Line 2"];
		// 请求删尾更新。
		tui.requestRender();
		// 等清尾和光标缓存更新完成。
		await terminal.waitForRender();

		// cursorRow should be 2 (last line of new content)
		// Verify by doing another render with a change on line 1
		// 再只改第1行，若之前位置记错，差量定位可能把它画到其它行。
		component.lines = ["Line 0", "CHANGED", "Line 2"];
		// 请求第二次更新。
		tui.requestRender();
		// 等更新解析。
		await terminal.waitForRender();

		// 读取最终视口。
		const viewport = terminal.getViewport();
		// Line 1 should show "CHANGED", proving cursor tracking was correct
		// 本项只直接检查第1行包含 CHANGED；私有光标数值由这个行为间接验证，没有检查其它行是否也含该词。
		assert.ok(viewport[1]?.includes("CHANGED"), `Expected "CHANGED" on line 1, got: ${viewport[1]}`);

		// 正常停 TUI。
		tui.stop();
	});

	// 模拟四帧旋转符号，只更新三行中的中行，每轮检查头/中/尾文字；不测真实动画时间、写入量或帧率。
	it("renders correctly when only a middle line changes (spinner case)", async () => {
		// 40×10虚拟屏。
		const terminal = new VirtualTerminal(40, 10);
		// 真实主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 行数组组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// Initial render
		// 初始头/工作中/尾三行。
		component.lines = ["Header", "Working...", "Footer"];
		// 启动。
		tui.start();
		// 等首帧解析后再逐帧变化。
		await terminal.waitForRender();

		// Simulate spinner animation - only middle line changes
		// 四个旋转符号是固定字符串数组，\\ 在 JS 字面量中表示一个反斜杠。
		const spinnerFrames = ["|", "/", "-", "\\"];
		// 逐个同步设状态，再在循环内 await 更新，避免只画最终一帧。
		for (const frame of spinnerFrames) {
			// 头尾保持相同，模板插值只改变中行帧字符。
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			// 请求异步更新。
			tui.requestRender();
			// 等这一帧的定时渲染及 xterm 解析。
			await terminal.waitForRender();

			// 每轮读取新快照，不能复用上一轮旧数组判断变化。
			const viewport = terminal.getViewport();
			// 首行仍包含 Header。
			assert.ok(viewport[0]?.includes("Header"), `Header preserved: ${viewport[0]}`);
			// 中行必须包含本轮 Working 加帧字符。
			assert.ok(viewport[1]?.includes(`Working ${frame}`), `Spinner updated: ${viewport[1]}`);
			// 尾行仍包含 Footer。
			assert.ok(viewport[2]?.includes("Footer"), `Footer preserved: ${viewport[2]}`);
		}

		// 全部四轮断言后正常停止。
		tui.stop();
	});

	// 第一行故意不关闭斜体，要求主屏行尾重置使第二行首格无斜体；实际只检查这一格，非全部样式组合。
	it("resets styles after each rendered line", async () => {
		// 20列6行虚拟终端足够显示两行。
		const terminal = new VirtualTerminal(20, 6);
		// 主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 不主动清理样式的假组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 第一行 ESC[3m 开斜体没有复位，第二行纯文字 Plain，用来暴露样式泄漏。
		component.lines = ["\x1b[3mItalic", "Plain"];
		// 启动排首帧。
		tui.start();
		// 等控制码被 xterm 解析后再读取格属性。
		await terminal.waitForRender();

		// 读取视口第1行第0格，数值0表示非斜体；只看文本快照无法证明这一点。
		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		// 正常停止。
		tui.stop();
	});

	// 四行中只改首行，分别确认新首行和三个旧行仍在各自位置；不对输出是否最少作断言。
	it("renders correctly when first line changes but rest stays same", async () => {
		// 固定40×10内存终端。
		const terminal = new VirtualTerminal(40, 10);
		// 主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 最小组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 初始四行编号内容。
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		// 启动排首帧。
		tui.start();
		// 等旧内容就绪。
		await terminal.waitForRender();

		// Change only first line
		// 首行改为 CHANGED，其余字符串保持原样。
		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		// 请求更新，不手动强制整绘。
		tui.requestRender();
		// 等帧及写解析。
		await terminal.waitForRender();

		// 读取更新后视口。
		const viewport = terminal.getViewport();
		// 第0行出现新文字。
		assert.ok(viewport[0]?.includes("CHANGED"), `First line changed: ${viewport[0]}`);
		// 第1行保留 Line1。
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		// 第2行保留 Line2。
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		// 第3行保留 Line3。
		assert.ok(viewport[3]?.includes("Line 3"), `Line 3 preserved: ${viewport[3]}`);

		// 正常停止。
		tui.stop();
	});

	// 四行中只改末行，检查前三行保持和末行新文字，覆盖差量定位到尾部。
	it("renders correctly when last line changes but rest stays same", async () => {
		// 40×10虚拟终端。
		const terminal = new VirtualTerminal(40, 10);
		// 主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 固定行源。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 初始四行。
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		// 启动首帧。
		tui.start();
		// 等待初始画面。
		await terminal.waitForRender();

		// Change only last line
		// 只把第3行变成 CHANGED，数组长度未变。
		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		// 请求普通更新。
		tui.requestRender();
		// 等写队列反映这一帧。
		await terminal.waitForRender();

		// 读取新视口快照。
		const viewport = terminal.getViewport();
		// 第0行仍为包含 Line0 的行。
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		// 第1行仍包含 Line1。
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		// 第2行仍包含 Line2。
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		// 第3行必须包含新内容。
		assert.ok(viewport[3]?.includes("CHANGED"), `Last line changed: ${viewport[3]}`);

		// 正常停止。
		tui.stop();
	});

	// 不相邻的第1/3行同时变化，中间第2行保持；检查结果正确，不意味着实现跳过区间内部未变行的输出。
	it("renders correctly when multiple non-adjacent lines change", async () => {
		// 40×10内存屏。
		const terminal = new VirtualTerminal(40, 10);
		// 主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 行源。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 初始五行。
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		// 启动。
		tui.start();
		// 等首帧。
		await terminal.waitForRender();

		// Change lines 1 and 3, keep 0, 2, 4 the same
		// 只替换两个非相邻位置；新旧总行数不变。
		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		// 请求一轮更新。
		tui.requestRender();
		// 等该轮写入解析。
		await terminal.waitForRender();

		// 读取最终视口。
		const viewport = terminal.getViewport();
		// 未变的第0行保留。
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		// 第1行显示 CHANGED1。
		assert.ok(viewport[1]?.includes("CHANGED 1"), `Line 1 changed: ${viewport[1]}`);
		// 变化区间中间的第2行显示正确；实际差量代码可重写整个首末变化闭区间。
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		// 第3行显示 CHANGED3。
		assert.ok(viewport[3]?.includes("CHANGED 3"), `Line 3 changed: ${viewport[3]}`);
		// 后续未变的第4行保留。
		assert.ok(viewport[4]?.includes("Line 4"), `Line 4 preserved: ${viewport[4]}`);

		// 正常停止。
		tui.stop();
	});

	// 内容→空数组→新内容，检查回到有内容后可从正确位置绘制；中间空状态有等待但没有直接断言空屏。
	it("handles transition from content to empty and back to content", async () => {
		// 40×10虚拟屏。
		const terminal = new VirtualTerminal(40, 10);
		// 主屏实例。
		const tui: TUI = new TuiMainScreen(terminal);
		// 最小行组件。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// Start with content
		// 初始三行。
		component.lines = ["Line 0", "Line 1", "Line 2"];
		// 启动。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();

		// let 允许后面重新赋为新快照；旧快照不会自动随模拟器变化。
		let viewport = terminal.getViewport();
		// 先确认初始首行真的出现。
		assert.ok(viewport[0]?.includes("Line 0"), "Initial content rendered");

		// Clear to empty
		// 组件变为零行，不是一行空串。
		component.lines = [];
		// 请求清尾/空状态更新。
		tui.requestRender();
		// 等待空状态处理，避免直接跳过这个转换。
		await terminal.waitForRender();

		// Add content back - this should work correctly even after empty state
		// 再恢复为两行新文字，触发从旧行数组空开始的绘制路径。
		component.lines = ["New Line 0", "New Line 1"];
		// 请求恢复内容。
		tui.requestRender();
		// 等待实际帧/解析。
		await terminal.waitForRender();

		// 重新读取快照，替换局部变量。
		viewport = terminal.getViewport();
		// 新第0行位于正确行。
		assert.ok(viewport[0]?.includes("New Line 0"), `New content rendered: ${viewport[0]}`);
		// 新第1行也正确出现。
		assert.ok(viewport[1]?.includes("New Line 1"), `New content line 1: ${viewport[1]}`);

		// 正常停止。
		tui.stop();
	});

	// 十二行缩成七行后，新末行在旧视口上方，需要整绘重建视口；检查计数与精确五行可见窗口。
	it("full re-renders when deleted lines move the viewport upward", async () => {
		// 20列5行屏，内容超过视口时末五行可见。
		const terminal = new VirtualTerminal(20, 5);
		// 默认不主动 clearOnShrink，退路由旧/新视口位置决定。
		const tui: TUI = new TuiMainScreen(terminal);
		// 可变行源。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// Array.from 生成 Line0..Line11 共十二行。
		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		// 启动。
		tui.start();
		// 等输出滚动到末五行。
		await terminal.waitForRender();

		// 记录整绘次数。
		const initialRedraws = tui.fullRedraws;

		// 只保留 Line0..Line6，共七行；新末索引6小于旧视口顶7。
		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		// 请求删除尾部更新。
		tui.requestRender();
		// 等整绘退路和 xterm 缓冲更新。
		await terminal.waitForRender();

		// 计数增加，证明没有仅依靠光标移动清旧尾部。
		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should trigger a full redraw");
		// 深比较整个五行视口：新七行内容的末五行为 Line2..Line6。
		assert.deepStrictEqual(terminal.getViewport(), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		// 正常停止。
		tui.stop();
	});

	// 先缩短触发视口重置整绘，再追加一行应回到差量路径，避免此后每帧都因旧视口缓存继续整绘。
	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		// 20×5虚拟屏。
		const terminal = new VirtualTerminal(20, 5);
		// 默认主屏策略。
		const tui: TUI = new TuiMainScreen(terminal);
		// 行源。
		const component = new TestComponent();
		// 挂载。
		tui.addChild(component);

		// 初始八行 Line0..Line7，超过五行屏。
		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		// 启动。
		tui.start();
		// 等首帧滚动及缓存建立。
		await terminal.waitForRender();

		// 保存初始整绘次数。
		const initialRedraws = tui.fullRedraws;

		// 缩成两行，新内容末端位于旧可见窗口上方。
		component.lines = ["Line 0", "Line 1"];
		// 请求缩短更新。
		tui.requestRender();
		// 等视口重置。
		await terminal.waitForRender();

		// 这一次必须发生整绘。
		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should reset the viewport with a full redraw");
		// 以缩短后的计数为第二阶段基线，而非仍用原计数。
		const redrawsAfterShrink = tui.fullRedraws;

		// 保留两行并只追加 Line2。
		component.lines = ["Line 0", "Line 1", "Line 2"];
		// 普通请求，给差量逻辑自行决定。
		tui.requestRender();
		// 等追加帧。
		await terminal.waitForRender();

		// 整绘计数不再增加，是对“追加回到差量”的直接观察。
		assert.strictEqual(tui.fullRedraws, redrawsAfterShrink, "Append should stay on the differential path");
		// 整个视口精确为三行内容和两条空行，检验旧窗口原点已经修正。
		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", ""]);

		// 正常停止。
		tui.stop();
	});

	// 编辑区短暂变长会抬高工作区历史高水位；恢复编辑区后再缩聊天内容，应整绘清旧尾，不能残留 Chat12..14。
	// 这里所谓分支切换只是更换假组件行数组，不调用实际会话管理或读取仓库分支。
	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		// 40列10行虚拟终端。
		const terminal = new VirtualTerminal(40, 10);
		// 普通主屏。
		const tui: TUI = new TuiMainScreen(terminal);
		// 聊天行组件在前。
		const chat = new TestComponent();
		// 编辑/选择区用第二个可变假组件模拟，不是真正 Editor。
		const editor = new TestComponent();
		// 先挂聊天组件。
		tui.addChild(chat);
		// 再挂编辑组件，Container 按顺序拼接两个组件的行。
		tui.addChild(editor);

		// 十五行长聊天 Chat0..Chat14。
		const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
		// 十二行短聊天 Chat0..Chat11。
		const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
		// 常规编辑区仅三行。
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
		// 短暂选择区八行，将总行数从18抬高到23。
		const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);

		// 初始使用长聊天数组。
		chat.lines = longChat;
		// 编辑区先为常规三行。
		editor.lines = editorLines;
		// 启动首帧，总18行。
		tui.start();
		// 等初始屏幕和高水位建立。
		await terminal.waitForRender();

		// 编辑组件切到八行选择区，模拟临时 UI 增高。
		editor.lines = selectorLines;
		// 请求显示选择区。
		tui.requestRender();
		// 等待23行状态真正执行，不能只在同轮修改后跳过。
		await terminal.waitForRender();

		// 编辑区恢复三行，总行数回18；差量路径的历史高水位未必随之下降。
		editor.lines = editorLines;
		// 请求恢复编辑区。
		tui.requestRender();
		// 等此状态处理。
		await terminal.waitForRender();

		// 记录更换聊天数据前的整绘次数。
		const redrawsBeforeSwitch = tui.fullRedraws;
		// 聊天从十五行变十二行，移除 Chat12/13/14，编辑区保持三行。
		chat.lines = shortChat;
		// 请求新的十五行总内容。
		tui.requestRender();
		// 等待更新。
		await terminal.waitForRender();

		// 整绘计数增加；这里只用假数据形状验证回归，不是真的执行会话分支切换。
		assert.ok(tui.fullRedraws > redrawsBeforeSwitch, "Branch switch should trigger a full redraw");

		// 读取十行视口快照。
		const viewport = terminal.getViewport();
		// 遍历每个0..9可见行，逐行排除三条已删除聊天。
		for (let i = 0; i < 10; i++) {
			// ?? 只在缺失时回退空串；随后完整数组比较仍会抓住意外缺失行。
			const line = viewport[i] ?? "";
			// 不允许任何视口行残留 Chat12。
			assert.ok(!line.includes("Chat 12"), `Stale "Chat 12" at viewport row ${i}`);
			// 不允许残留 Chat13。
			assert.ok(!line.includes("Chat 13"), `Stale "Chat 13" at viewport row ${i}`);
			// 不允许残留 Chat14。
			assert.ok(!line.includes("Chat 14"), `Stale "Chat 14" at viewport row ${i}`);
		}

		// 再深比较完整十行窗口，不只证明旧行消失，还证明保留行和编辑区位置正确。
		assert.deepStrictEqual(viewport, [
			// 十五行总内容的末十行从 Chat5 开始。
			"Chat 5",
			// 第二可见行是 Chat6。
			"Chat 6",
			// 第三可见行是 Chat7。
			"Chat 7",
			// 第四可见行是 Chat8。
			"Chat 8",
			// 第五可见行是 Chat9。
			"Chat 9",
			// 第六可见行是 Chat10。
			"Chat 10",
			// 第七可见行是聊天末行 Chat11。
			"Chat 11",
			// 后面接常规编辑区第0行。
			"Editor 0",
			// 编辑区第1行。
			"Editor 1",
			// 编辑区第2行作为可见末行。
			"Editor 2",
		]);

		// 正常停止。
		tui.stop();
	});
});

// 伪光标组检查内部定位/包裹标记如何变为反色或被硬件光标策略去除；观察 write 串，不开启真实光标显示。
describe("TUI fake cursor", () => {
	// 焦点 Input 默认用反色首字，开启硬件光标后去除对应伪反色/内部标记；测试不把 setValue 误解成移到文字末尾。
	it("draws the focused fake cursor in reverse video and omits it when the hardware cursor is shown", async () => {
		// 20×5内存终端，额外记录写流。
		const terminal = new LoggingVirtualTerminal(20, 5);
		// 主屏默认隐藏硬件光标。
		const tui: TUI = new TuiMainScreen(terminal);
		// 真实 Input 初始光标为0、默认提示为 "> "。
		const input = new Input();
		// 设 abc 只夹旧光标上限，所以新实例光标仍0，后面反色的是 a 而非末尾空格。
		input.setValue("abc");
		// 将 Input 挂到基础树。
		tui.addChild(input);
		// 获得焦点后 Input 会在 a 前加硬件位置标记。
		tui.setFocus(input);
		// 启动排首帧。
		tui.start();
		// 等待生成/解析首帧。
		await terminal.waitForRender();
		// SGR7 开反色、27关反色，要求只有首字 a 包在其中；本项是 includes，不比较整行补空格。
		assert.ok(terminal.getWrites().includes("> \x1b[7ma\x1b[27mbc"));

		// 只清首帧写记录，保留屏幕和内容缓存。
		terminal.clearWrites();
		// 改变显示策略并请求新帧；硬件光标与伪光标是两套相关逻辑。
		tui.setShowHardwareCursor(true);
		// 等待配置变化产生的新帧。
		await terminal.waitForRender();
		// 这次写流不含反色开始码，焦点伪光标应被移除。
		assert.ok(!terminal.getWrites().includes("\x1b[7m"));
		// 输出也不应泄漏 pi 内部 APC 标记前缀。
		assert.ok(!terminal.getWrites().includes("\x1b_pi:"));

		// 正常停止。
		tui.stop();
	});

	// 硬件光标模式只替换紧跟定位标记的焦点伪光标；未聚焦 Input 没位置标记，仍保留反色首字。
	it("keeps the fake cursor of an unfocused input when the hardware cursor is shown", async () => {
		// 记录型虚拟终端。
		const terminal = new LoggingVirtualTerminal(20, 5);
		// 构造第二参数 true 表示从开始就显示硬件光标策略，不会自动给所有组件焦点。
		const tui: TUI = new TuiMainScreen(terminal, true);
		// 真实 Input 默认 focused=false。
		const input = new Input();
		// 设 abc 后光标仍在0。
		input.setValue("abc");
		// 只挂载，没有调用 setFocus，保持无焦点。
		tui.addChild(input);
		// 启动。
		tui.start();
		// 等待首帧。
		await terminal.waitForRender();
		// 仍应看见 a 的 SGR反色片段，不能全局删除所有伪光标。
		assert.ok(terminal.getWrites().includes("> \x1b[7ma\x1b[27mbc"));
		// 正常停止。
		tui.stop();
	});

	// 按列截到光标字 c 后可能丢伪光标结束标记，硬件策略仍应去掉焦点伪包裹并定位到第3列。
	it("omits the focused fake cursor when truncation dropped its end marker", async () => {
		// 20×5记录型虚拟终端。
		const terminal = new LoggingVirtualTerminal(20, 5);
		// 启用硬件光标策略。
		const tui: TUI = new TuiMainScreen(terminal, true);
		// 用普通假组件手工生成标记，测试不依赖 Focusable 字段，而依赖渲染串里实际标记。
		const base = new TestComponent();
		// ab 后是定位标记和包裹 c 的伪光标，再接 def；严格取0起3显示列，得到可见 abc，后续结束标记被截掉以覆盖串尾匹配。
		base.lines = [sliceByColumn(`ab${CURSOR_MARKER}${renderFakeCursor("c")}def`, 0, 3, true)];
		// 挂载这条手工标记行。
		tui.addChild(base);
		// 启动排帧。
		tui.start();
		// 等待写入完成。
		await terminal.waitForRender();
		// 缺结束标记也不能漏出反色开始码。
		assert.ok(!terminal.getWrites().includes("\x1b[7m"));
		// 定位标记前 ab 占两列，协议从1计数故最后是 CSI3G；只检查写流尾部，不读取真实光标。
		assert.ok(terminal.getWrites().endsWith("\x1b[3G"));
		// 正常停止。
		tui.stop();
	});

	// 浮层恰好覆盖光标左侧三列时不应丢定位标记；分别检查隐藏/显示硬件光标两种策略与第4列定位。
	it("keeps the cursor when an overlay ends directly left of it", async () => {
		// for...of 遍历 false/true 两个布尔值，每轮建立独立 TUI/虚拟终端。
		for (const showHardwareCursor of [false, true]) {
			// 本轮20×5内存屏与写记录。
			const terminal = new LoggingVirtualTerminal(20, 5);
			// 传入当前显示硬件光标开关，不复用上一轮组件状态。
			const tui: TUI = new TuiMainScreen(terminal, showHardwareCursor);
			// 基础行组件。
			const base = new TestComponent();
			// abc 占前三列，位置标记紧邻 d 前，d 被伪光标包裹，后面是 ef。
			base.lines = [`abc${CURSOR_MARKER}${renderFakeCursor("d")}ef`];
			// 挂基础行。
			tui.addChild(base);
			// 浮层用最小固定行组件，无输入处理。
			const overlay = new TestComponent();
			// XXX 恰好三列 ASCII，覆盖 abc 而不应覆盖 d 或其边界位置标记。
			overlay.lines = ["XXX"];
			// 浮层从屏内0行0列开始、声明宽3；挂浮层可能改变焦点，但手工基础串里的光标标记仍是本项检测依据。
			tui.showOverlay(overlay, { row: 0, col: 0, width: 3 });
			// 启动排首帧。
			tui.start();
			// 等待浮层合成、位置提取和写队列。
			await terminal.waitForRender();

			// 取得当前整帧写流。
			const writes = terminal.getWrites();
			// 确认浮层实际出现在流中，避免没画浮层而假通过边界测试。
			assert.ok(writes.includes("XXX"));
			// !showHardwareCursor 表示只在硬件隐藏模式有反色 d；布尔严格比较同时覆盖有/无两个方向。
			assert.strictEqual(writes.includes("\x1b[7md"), !showHardwareCursor);
			// The hardware cursor is positioned at column 4 in both modes
			// 两种显示策略都要定位到0基列3，即协议第4列，硬件隐藏也仍为输入法等定位。
			assert.ok(writes.endsWith("\x1b[4G"));
			// 本轮正常停止后才进入下一布尔情形；若前面抛错，没有专门 finally。
			tui.stop();
		}
	});
});
