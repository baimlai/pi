// 测深浅主题回复、OSC颜色解析和TUI颜色查询队列；输入回复全由内存Terminal人工注入，没有真实终端探测/网络。同步it返回void，async场景返回Promise，断言失败交node:test。
// assert检查解析对象/队列投递/普通输入去向；不证明用户真实终端支持这些协议。
import assert from "node:assert";
// 注册测试组与回调，最后一组才创建宿主和定时器。
import { describe, it } from "node:test";
// 从公开入口导入契约和真正实现，兼顾公开API可用性。
import {
	// Component静态接口约束输入记录器，不赋予自动渲染能力。
	type Component,
	// 解析CSI?997深浅报告的纯函数，不读取主题设置。
	parseTerminalColorSchemeReport,
	// Terminal契约描述测试适配器需有哪些方法，编译后擦除。
	type Terminal,
	// TerminalColors结果字段都可缺，interface不会强制收齐16色。
	type TerminalColors,
	// TUI接口约束宿主使用。
	type TUI,
	// 主屏实现负责颜色查询/输入分流，输出交下方内存对象。
	TuiMainScreen,
} from "../src/index.ts";
// StdinBuffer是事件发射式序列重组器，测试主动process，不监听真实stdin。
import { StdinBuffer } from "../src/stdin-buffer.ts";
// OSC10/11/4单条回复解析器，形状合法但颜色坏了仍能返回target。
import { parseOscColorResponse } from "../src/terminal-colors.ts";

// 最小Terminal实现只保存write与回调，不像VirtualTerminal解释ANSI成屏幕格；适合观测查询串/输入分发。
class TestTerminal implements Terminal {
	// 可选输入处理器，未start/stop后为undefined。
	private inputHandler?: (data: string) => void;
	// 可选尺寸处理器，sendResize人工触发。
	private resizeHandler?: () => void;
	// 构造后不再重新赋值的列数字段。
	private readonly columnCount: number;
	// 同理行数，只供宿主布局。
	private readonly rowCount: number;
	// readonly禁止重绑数组，push仍允许；公开writes供测试读最后一次write。
	readonly writes: string[] = [];

	// 创建固定默认80×24的内存适配器，无IO/显式返回；例new TestTerminal()本身不start。
	constructor(columnCount = 80, rowCount = 24) {
		// 保存列数，不在此取整/验证正值。
		this.columnCount = columnCount;
		// 保存行数。
		this.rowCount = rowCount;
	}

	// start接两个回调并保存，返回void；例setup让TUI接收sendInput，不自动回复任何查询或改终端模式。
	start(onInput: (data: string) => void, onResize: () => void): void {
		// 保存输入函数引用，没有调用。
		this.inputHandler = onInput;
		// 保存尺寸函数引用。
		this.resizeHandler = onResize;
	}

	// stop无参/void，只移除两回调；不清writes，不销毁TUI自己的颜色查询队列或计时器。
	stop(): void {
		// 之后sendInput不会再递送到旧宿主。
		this.inputHandler = undefined;
		// sendResize同样无旧回调可调。
		this.resizeHandler = undefined;
	}

	// 异步排空空实现，返回已完成Promise<void>，忽略两个可选时长；这里没有stdin可清。
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	// write接data并push、返回void；例完整颜色查询保存在一项里，不解析、不生成自动回复，异常不另捕获。
	write(data: string): void {
		// 原样记录每次调用的整段字符串，读取数组可区分一次write与多次write。
		this.writes.push(data);
	}

	// 无参读取列数、返回number、无副作用；例80列。
	get columns(): number {
		// 直接给保存的构造值。
		return this.columnCount;
	}

	// 同样读取行数，无等待/IO。
	get rows(): number {
		// 返回固定行数。
		return this.rowCount;
	}

	// 固定报告Kitty键盘协议未激活，返回false、不做协商；与OSC颜色查询支持互相独立。
	get kittyProtocolActive(): boolean {
		// 返回false，未因此禁用颜色串解析。
		return false;
	}

	// moveBy接但忽略_lines，空方法返回void；没有屏幕缓冲可移动。
	moveBy(_lines: number): void {}

	// hideCursor空实现，无参数/副作用，不写控制串。
	hideCursor(): void {}

	// showCursor同样无操作。
	showCursor(): void {}

	// clearLine无操作，不清writes记录。
	clearLine(): void {}

	// clearFromCursor无操作，不改变输入回调。
	clearFromCursor(): void {}

	// clearScreen无操作，没有真正模拟屏幕。
	clearScreen(): void {}

	// setTitle忽略_title，不改窗口标题，也不额外记录到writes。
	setTitle(_title: string): void {}

	// setProgress忽略_active，不创建周期定时器。
	setProgress(_active: boolean): void {}
	// setProgramStatus空实现，可少声明未使用的状态参数，不生成OSC7501。
	setProgramStatus(): void {}

	// 人工送data给已注册输入回调，返回void；例sendInput(OSC11)同步触发TUI消费逻辑，非真实键盘编码，不在此拆包，回调异常传播。
	sendInput(data: string): void {
		// ?.仅在处理器存在时调用，未start或stop后静默跳过。
		this.inputHandler?.(data);
	}

	// 人工发尺寸通知、无参/void、不改columns/rows；例只让宿主排帧，不等价真实窗口resize。
	sendResize(): void {
		// 可选调用已注册回调。
		this.resizeHandler?.();
	}
}

// 焦点输入记录器，用来证明查询回复没有变成编辑器文字；无需真实Editor。
class InputRecorder implements Component {
	// 数组绑定readonly但push可变，元素类型string由TS约束。
	readonly inputs: string[] = [];

	// render忽略_width，返回零行数组，无IO/状态修改；例仍可被setFocus并收键盘。
	render(_width: number): string[] {
		// 空数组不占屏幕行，与[空串]一行不同。
		return [];
	}

	// handleInput接data并记录、返回void，不主动过滤颜色串；这样TUI漏消费会暴露在断言里。
	handleInput(data: string): void {
		// 保存原始序列而非去ANSI文本。
		this.inputs.push(data);
	}

	// invalidate空实现，不清输入历史。
	invalidate(): void {}
}

// wait回调输入ms、返回Promise<void>，executor同步注册setTimeout，之后resolve；例wait(5)给1ms查询超时发生机会，实际调度可更晚，不是精确实时保证。
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 深浅主题解析组纯字符串，无Terminal实例或回调通知。
describe("parseTerminalColorSchemeReport", () => {
	// 正反与连报例：1深2浅，连续合法报告取最后一个，掺普通文字或其他编号失败。
	it("parses color scheme reports", () => {
		// 单个1报告→dark。
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n"), "dark");
		// 单个2报告→light。
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n"), "light");
		// 多个报告最后为1，取dark，不取第一个2。
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;2n\x1b[?997;1n\x1b[?997;1n"), "dark");
		// 最后为2，取light。
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;1n\x1b[?997;2n\x1b[?997;2n"), "light");
		// 未支持的3不按任意真值映射，返回undefined。
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?997;3n"), undefined);
		// 996不是997主题报告，undefined。
		assert.strictEqual(parseTerminalColorSchemeReport("\x1b[?996n"), undefined);
		// 头部普通x使整串模式失败，不从中间搜合法片段。
		assert.strictEqual(parseTerminalColorSchemeReport("x\x1b[?997;1n"), undefined);
	});
});

// OSC颜色组区分“非目标协议”与“目标回复但色值无法解析”。
describe("parseOscColorResponse", () => {
	// 解析例：BEL/ST都接受，目标与RGB字段精确核对，不真实读取用户调色板。
	it("parses OSC 10, 11, and 4 replies", () => {
		// OSC10默认前景rgb:ffff/ffff/ffff：每通道按四位十六进制最大值缩放。
		assert.deepStrictEqual(parseOscColorResponse("\x1b]10;rgb:ffff/ffff/ffff\x07"), {
			// target为foreground字符串，不是调色板索引10。
			target: "foreground",
			// 白色三通道均255，不保留原65535标度。
			rgb: { r: 255, g: 255, b: 255 },
		});
		// OSC4;13是第13号调色板槽，#ff0080为常用8位通道。
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;13;#ff0080\x1b\\"), {
			// target保存数字13，不写作字符串"13"。
			target: 13,
			// RGB255/0/128。
			rgb: { r: 255, g: 0, b: 128 },
		});
		// bogus色值坏了但外壳是颜色回复，仍返回target1/rgbundefined，便于上层消费它。
		assert.deepStrictEqual(parseOscColorResponse("\x1b]4;1;bogus\x07"), { target: 1, rgb: undefined });
		// OSC12不属于此函数支持目标，整份返回undefined而非{target,rgb}。
		assert.strictEqual(parseOscColorResponse("\x1b]12;#ffffff\x07"), undefined);
	});
});

// Array.from真实生成16条OSC4黑色回复，回调忽略_、用索引0..15，都是字符串，不写终端；BEL结束。
const PALETTE_REPLIES = Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};#000000\x07`);
// 手写DA1设备属性回复，TUI把它作为队首查询结束边界，不代表检测到真实设备属性。
const DA1 = "\x1b[?62;22c";
// 黑色对象供结构期望复用，不从真实终端取得。
const BLACK = { r: 0, g: 0, b: 0 };
// 白色对象同理。
const WHITE = { r: 255, g: 255, b: 255 };

// setup无参数、创建并启动内存宿主返回三个引用；有注册回调/排帧副作用，例用例try/finally中stop。它不等待初帧，也不创建真实输入设备。
function setup(): { terminal: TestTerminal; tui: TUI; component: InputRecorder } {
	// 创建记录型Terminal，不是xterm。
	const terminal = new TestTerminal();
	// 构造真实主屏TUI并注入该Terminal。
	const tui: TUI = new TuiMainScreen(terminal);
	// 创建空输入记录器。
	const component = new InputRecorder();
	// 把记录器加入组件树，render返回零行。
	tui.addChild(component);
	// 设焦点让未消费的人工输入能被观测。
	tui.setFocus(component);
	// 启动 TUI 输入/尺寸处理与初帧调度，不创建模型会话。
	tui.start();
	// 属性简写返回同一批对象引用，后面的stop必须由用例负责。
	return { terminal, tui, component };
}

// 查询集成组测试内存请求/人工回复归组，不检测实际终端能力。
describe("TUI.queryTerminalColors", () => {
	// 完整回复例：一条write含前景/背景/16色和DA1查询，普通x放行，18个不同目标到齐即resolve，但队首保留至DA1才移除。
	it("queries all colors in one write and consumes the replies", async () => {
		// 解构取得本例独立三个对象。
		const { terminal, tui, component } = setup();
		// try/finally让断言或await失败也调用stop；颜色计时器具体结束仍由回复/查询逻辑处理，stop不是清所有pending保证。
		try {
			// 发起1000ms上限查询，Promise执行器同步入队并write，此行不await以便下面人工回送。
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			// at(-1)取最后记录的完整write，??只在缺项时退空串。
			const written = terminal.writes.at(-1) ?? "";
			// 仅核对查询串起始部分和DA1尾部，不枚举全部中间16条或单独断言总write次数。
			assert.ok(written.startsWith("\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07") && written.endsWith("\x1b[c"));

			// 普通键x应该穿过查询消费链到焦点组件。
			terminal.sendInput("x");
			// 人工回默认前景白色，BEL结束。
			terminal.sendInput("\x1b]10;#ffffff\x07");
			// 人工回默认背景黑色，以ST结束。
			terminal.sendInput("\x1b]11;rgb:0000/0000/0000\x1b\\");
			// 依次送16个不同调色板索引的黑色回复，构成正常的18目标集合。
			for (const reply of PALETTE_REPLIES) terminal.sendInput(reply);
			// Resolves once every reply arrived, without waiting for DA1.
			// await此时即可得到完整颜色，不必等下面的DA1；比较所有结果字段。
			assert.deepStrictEqual(await query, {
				// 前景应白。
				foreground: WHITE,
				// 背景应黑。
				background: BLACK,
				// Array.from回调每槽用同一个BLACK引用作期望；deepStrictEqual检结构，不要求解析器也共享这一对象身份。
				palette: Array.from({ length: 16 }, () => BLACK),
			});
			// 完成Promise后仍有队首待DA1，送结束标记将其移出且不交焦点输入。
			terminal.sendInput(DA1);
			// 只剩普通x，所有颜色回复/DA1都被消费。
			assert.deepStrictEqual(component.inputs, ["x"]);
			// 无论成功失败都执行finally。
		} finally {
			// 停TUI输入与渲染，前面正常完成已清颜色查询计时器并出队。
			tui.stop();
		}
	});

	// 分片回归例：接收测试上下文t，使用假setTimeout推进100ms，StdinBuffer仍保留已识别的未完整颜色回复，避免尾串进编辑器；async完成/错误由测试框架等待。
	it("consumes delayed Ghostty color fragments without typing their tail or opening the editor", async (t) => {
		// 启用本用例上下文的setTimeout模拟，不模拟真实外部时间流逝；测试框架在用例清理时恢复mock。
		t.mock.timers.enable({ apis: ["setTimeout"] });
		// 创建独立宿主/记录器。
		const { terminal, tui, component } = setup();
		// 新建序列重组缓冲，没有真实stdin订阅。
		const buffer = new StdinBuffer();
		// data事件回调把已分出的完整序列同步送Terminal，返回值忽略；注册此回调不会立即发输入。
		buffer.on("data", (data) => terminal.sendInput(data));
		// finally清buffer与TUI，无论中间断言是否成功。
		try {
			// 颜色查询1000ms，假时钟100ms还未到其超时。
			const query = tui.queryTerminalColors({ timeoutMs: 1000 });
			// Captured from Ghostty 1.3.1 with Ayu Light, split at the reported tail.
			// 第一块缺通道尾部及BEL，StdinBuffer应继续保留完整回复前缀，不把残片当文字flush。
			buffer.process("\x1b]4;1;rgb:eaea/6c");
			// 人工推进假计时100ms，测试不真sleep100ms；此前已识别终端回复不按普通ESC歧义超时拆断。
			t.mock.timers.tick(100);
			// 补齐第二块，再拼DA1；buffer应先发完整OSC、再发DA1，保留原输入次序。
			buffer.process(`6c/6d6d\x07${DA1}`);
			// 只收到一个调色板槽，未收齐16色，所以paletteundefined；前景/背景也未回，全部字段缺值。
			assert.deepStrictEqual(await query, { foreground: undefined, background: undefined, palette: undefined });
			// 分片及尾部都没落焦点输入记录。
			assert.deepStrictEqual(component.inputs, []);

			// A real Ctrl+G must still reach the editor after the reply.
			// 后来的单独BEL是用户Ctrl+G，这时无pending查询，不再当旧回复终止符吞掉。
			buffer.process("\x07");
			// 记录器此时应只见这一个BEL字符；这里无真实编辑器开外部进程。
			assert.deepStrictEqual(component.inputs, ["\x07"]);
			// 开始释放本例辅助状态。
		} finally {
			// destroy 委托 clear 清重组缓存、计时器和去重状态，不移除 data 监听器，也不永久禁止以后 process 再发事件。
			buffer.destroy();
			// 停内存TUI，不对用户桌面/终端操作。
			tui.stop();
		}
	});

	// 并发查询例：回复按FIFO队首归组，用DA1分别完成两项，无请求ID乱序匹配能力；不完整调色板丢弃。
	it("resolves on DA1 with the replies that arrived, in query order", async () => {
		// 本例不需读取component，仍由setup创建并聚焦。
		const { terminal, tui } = setup();
		// finally负责TUI停止。
		try {
			// 第一查询立刻入队并发串，暂不await。
			const first = tui.queryTerminalColors({ timeoutMs: 1000 });
			// 第二查询也立即发串但后续输入先归第一项，不是等第一项完成才发第二串。
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			// 黑色背景归当前队首第一项。
			terminal.sendInput("\x1b]11;#000000\x07");
			// An incomplete palette is dropped.
			// 只送索引0..7半份调色板，slice新数组不改全局PALETTE_REPLIES。
			for (const reply of PALETTE_REPLIES.slice(0, 8)) terminal.sendInput(reply);
			// 第一DA1完成并移除第一查询。
			terminal.sendInput(DA1);
			// 第二DA1完成尚未得到颜色的第二查询。
			terminal.sendInput(DA1);

			// 第一项保留已收到背景，前景/完整palette缺失。
			assert.deepStrictEqual(await first, { foreground: undefined, background: BLACK, palette: undefined });
			// 第二项所有字段缺失，说明没有把第一项的半份调色板/背景串混进去。
			assert.deepStrictEqual(await second, { foreground: undefined, background: undefined, palette: undefined });
			// finally统一停止宿主。
		} finally {
			// 这里两项均已有DA1结束，正常路径的查询计时器已取消。
			tui.stop();
		}
	});

	// 超时晚回例：1ms先resolve当前快照，之后onLateReply继续收集，到DA1汇总；无pending后同样OSC串又按普通输入放行，不保证任意延迟回复永远吞掉。
	it("reports late replies after a timeout and consumes them until DA1", async () => {
		// 新setup避免旧查询队列干扰。
		const { terminal, tui, component } = setup();
		// 用finally确保停止TUI。
		try {
			// 类型TerminalColors[]记录晚投递，初始无项。
			const late: TerminalColors[] = [];
			// 1ms计时器正常触发后切到colors=>late.push回调；回调输入结果、追加记录，返回长度被void调用契约忽略，不是第二次resolve同一Promise。
			const query = tui.queryTerminalColors({ timeoutMs: 1, onLateReply: (colors) => late.push(colors) });
			// 真定时等待约5ms，给1ms超时回调运行机会，宿主调度可更晚。
			await wait(5);
			// 首次Promise完成时背景还未到，应undefined，不会在随后自动把此结果对象顶层字段补成白色。
			assert.strictEqual((await query).background, undefined);

			// 超时后再人工回白色背景，因有onLateReply仍能记到pending查询中。
			terminal.sendInput("\x1b]11;#ffffff\x07");
			// DA1使晚回调获得最终汇总并移除队首。
			terminal.sendInput(DA1);
			// late应恰一条，只有背景白色；不是每个晚来颜色都马上回调一次。
			assert.deepStrictEqual(late, [{ foreground: undefined, background: WHITE, palette: undefined }]);
			// 晚回复和DA1仍被消费，焦点输入为空。
			assert.deepStrictEqual(component.inputs, []);

			// With no query pending, color replies are ordinary input again.
			// 队列已空时再送同样OSC11，TUI没有pending依据把它当颜色查询回复消费。
			terminal.sendInput("\x1b]11;#ffffff\x07");
			// 整条控制串应出现在输入记录，不主动执行其中真实终端动作。
			assert.deepStrictEqual(component.inputs, ["\x1b]11;#ffffff\x07"]);
			// 无论断言是否成功进入finally。
		} finally {
			// 停止TUI，正常路径DA1已移除查询并清计时器。
			tui.stop();
		}
	});
});
