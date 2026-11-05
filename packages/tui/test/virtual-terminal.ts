// 用内存里的 xterm 解释终端控制序列，供 TUI 测试检查屏幕/历史/光标；不会接管真实 stdin/stdout，也不连接系统剪贴板。
// type 导入只提供实例类型；as 给类型起别名，与下面的运行时 Terminal 类区分。
import type { Terminal as XtermTerminalType } from "@xterm/headless";
// 默认导入取得模块运行时对象，构造函数从其 Terminal 属性读取。
import xterm from "@xterm/headless";
// 本地 Terminal 接口只在编译期检查适配器方法；implements 不会继承 ProcessTerminal 的输入/模式逻辑。
import type { Terminal } from "../src/terminal.ts";

// Extract Terminal class from the module
// 保存真正的 xterm 构造器，赋值尚未创建终端实例。
const XtermTerminal = xterm.Terminal;

/**
 * Virtual terminal for testing using xterm.js for accurate terminal emulation
 */
// 实现项目终端契约，再增加测试专用的 sendInput、flush、屏幕快照等方法；所有转发异常默认向调用方传播。
export class VirtualTerminal implements Terminal {
	// private 是 TypeScript 的访问限制，不是 JS 的 # 私有字段；其他测试仍可能用类型断言读底层 xterm。
	private xterm: XtermTerminalType;
	// 可选输入回调；? 允许尚未 start 或 stop 后为 undefined，不注册操作系统监听器。
	private inputHandler?: (data: string) => void;
	// 可选尺寸变化回调，无参数、无返回值；resize 时同步执行。
	private resizeHandler?: () => void;
	// 单独保存项目接口看到的列数，初始由构造参数决定。
	private _columns: number;
	// 同样保存行数；它们不是每次从 xterm 动态读取的访问器。
	private _rows: number;

	// 创建内存模拟器，输入默认 80 列/24 行，无显式返回；例 new VirtualTerminal(20,5) 只建测试屏，不启动 TUI。
	constructor(columns = 80, rows = 24) {
		// 记录列数，构造时不在包装器层额外取整或校验。
		this._columns = columns;
		// 记录行数。
		this._rows = rows;

		// Create xterm instance with specified dimensions
		// 用给定尺寸构造 xterm，配置/构造错误直接抛出；没有真实窗口或 PTY。
		this.xterm = new XtermTerminal({
			// xterm 的列数字段叫 cols，与包装器 columns 名称不同。
			cols: columns,
			// 行数使用属性名 rows。
			rows: rows,
			// Disable all interactive features for testing
			// 禁用 xterm 的输入功能；不表示屏蔽本类 sendInput 直接调用的测试回调，也不是禁用所有控制序列解析。
			disableStdin: true,
			// 允许访问 proposed API，例如 buffer；这是本地模拟器 API 开关，不是网络/真实终端能力探测。
			allowProposedApi: true,
		});
	}

	// 保存输入与尺寸回调并排队开启括号粘贴模式，返回 void；例 tui.start() 注入处理器，真正解析输出仍需 flush，不会自动生成键盘输入。
	start(onInput: (data: string) => void, onResize: () => void): void {
		// 保存 onInput 函数引用，此行不调用它。
		this.inputHandler = onInput;
		// 保存 onResize 引用，后续 resize 才执行。
		this.resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal
		// 把 CSI ?2004h 写入模拟器队列，影响内存终端模式；不向宿主 shell 发控制串。
		this.xterm.write("\x1b[?2004h");
	}

	// 实现异步排空接口但这里无 stdin 可排空，返回完成的 Promise<void>；两个带 _ 的可选参数故意忽略，例 stop 流程可统一 await，不发生等待超时。
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain
	}

	// 停止测试回调接收并排队关闭括号粘贴，返回 void；例 stop 后 sendInput 不再送给旧 TUI，但模拟器数据仍保留，没有 dispose 或清屏。
	stop(): void {
		// Disable bracketed paste mode
		// 模拟器异步解析关闭模式码，返回时不保证此写入已经处理。
		this.xterm.write("\x1b[?2004l");
		// 清输入回调，之后 sendInput 静默跳过。
		this.inputHandler = undefined;
		// 清尺寸通知回调；之后 resize 仍会改变模拟器尺寸。
		this.resizeHandler = undefined;
	}

	// 把 data 原样交 xterm 写队列，返回 void；例 write("abc") 后 await flush() 再断言，调用本身不保证屏幕已更新，错误不吞。
	write(data: string): void {
		// xterm 负责解释文字与 ANSI；这里不记录独立写日志、不做内容转义。
		this.xterm.write(data);
	}

	// 读取包装器记下的列数，返回 number、无状态变化；例 terminal.columns 得构造或最近 resize 的输入值。
	get columns(): number {
		// 直接返回字段，不等待模拟器写队列。
		return this._columns;
	}

	// 读取包装器行数，无参数/副作用；例 rows=5 时宿主按 5 行布局。
	get rows(): number {
		// 返回最近保存的行数。
		return this._rows;
	}

	// 固定报告测试环境 Kitty 键盘协议已激活，返回 boolean；例输入解析可走协议分支，但这不证明 xterm 实现 Kitty 图片或真实终端协商成功。
	get kittyProtocolActive(): boolean {
		// Virtual terminal always reports Kitty protocol as active for testing
		// 每次都为 true，不发送协议查询。
		return true;
	}

	// 按 lines 相对移动内存光标，返回 void；例 2 发 CSI 2B，-2 发 CSI 2A，0 不写；不移动业务组件内容，也不在这里规范小数等输入。
	moveBy(lines: number): void {
		// 正数分支向下。
		if (lines > 0) {
			// Move down
			// 模板插入行数形成向下控制串，排队交模拟器。
			this.xterm.write(`\x1b[${lines}B`);
			// 不是正数时再检查负数。
		} else if (lines < 0) {
			// Move up
			// 对负数取反得到协议所需正数量，并用 A 向上。
			this.xterm.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	// 请求隐藏模拟光标，返回 void，无参数；例画面结束时 hideCursor 不删除文本，实际模式写入需等待解析。
	hideCursor(): void {
		// CSI ?25l 关闭光标可见状态，不写真实终端。
		this.xterm.write("\x1b[?25l");
	}

	// 请求显示模拟光标，返回 void；例 showCursor 不指定位置，只修改显示模式。
	showCursor(): void {
		// CSI ?25h 交模拟器解析。
		this.xterm.write("\x1b[?25h");
	}

	// 擦当前位置到行末，返回 void；例光标在第 3 列时不会擦左侧前两列，不等于总是清整行。
	clearLine(): void {
		// CSI K 缺省参数为 0，清光标处到行末。
		this.xterm.write("\x1b[K");
	}

	// 擦光标到屏幕末尾，返回 void；例保留光标前的内容，不主动清滚动历史。
	clearFromCursor(): void {
		// CSI J 缺省参数为 0；队列完成前读屏可能仍见旧内容。
		this.xterm.write("\x1b[J");
	}

	// 请求清可见屏并回左上角，返回 void；例不保证清掉 normal buffer 的 scrollback，勿与下面 xterm.clear 混同。
	clearScreen(): void {
		// 先 CSI 2J 擦屏，再 CSI H 回到协议坐标 (1,1)，全部只进模拟器写队列。
		this.xterm.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	// 把 title 编进 OSC0 标题指令，返回 void；例 setTitle("测试") 不改正文，此实现未像 ProcessTerminal 那样清理 title 控制字符，也不改真实窗口标题。
	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		// 模板内原样插入标题，再用 BEL 结束 OSC；解析/支持范围由模拟器决定。
		this.xterm.write(`\x1b]0;${title}\x07`);
	}

	// 进度接口的空实现，接受但忽略 _active、返回 void；例宿主统一调用 setProgress(true) 不会创建定时器或改变模拟屏。
	setProgress(_active: boolean): void {}
	// 程序状态接口同样为空、返回 void；方法可少声明实现未用的形参，满足 Terminal 契约不等于实际发送 OSC7501。
	setProgramStatus(): void {}

	// Test-specific methods not in Terminal interface

	/**
	 * Simulate keyboard input
	 */
	// 模拟上游输入，把 data 同步交已保存回调，返回 void；例 sendInput("a") 直接驱动 TUI，不经过 xterm.input、stdin 缓冲或键盘硬件，回调异常向外抛。
	sendInput(data: string): void {
		// 尚未 start 或已经 stop 时没有处理器，静默跳过。
		if (this.inputHandler) {
			// 真正同步调用 onInput；终端重画是否同步由 TUI 自己决定。
			this.inputHandler(data);
		}
	}

	/**
	 * Resize the terminal
	 */
	// 调整包装器与模拟器尺寸，再同步通知宿主，返回 void；例 resize(40,10) 驱动 TUI 排帧，不改变真实终端。底层抛错时前两字段已改，未回滚。
	resize(columns: number, rows: number): void {
		// 先记录新列数。
		this._columns = columns;
		// 先记录新行数。
		this._rows = rows;
		// 让 xterm 改缓冲区尺寸，底层有自己的整数/范围规则；包装器没有把规范后的 xterm 尺寸写回上述字段。
		this.xterm.resize(columns, rows);
		// 只有已注册通知函数才执行。
		if (this.resizeHandler) {
			// 同步通知尺寸变化，回调可安排异步渲染，方法不等待它完成。
			this.resizeHandler();
		}
	}

	/**
	 * Wait for all pending writes to complete. Viewport and scroll buffer will be updated.
	 */
	// 返回写队列屏障 Promise<void>，例 write("abc"); await flush() 后再读屏；只等待此空写之前队列数据被解析，不保证未来定时器渲染或真实显示器刷新完成。
	async flush(): Promise<void> {
		// Write an empty string to ensure all previous writes are flushed
		// new Promise 的 executor 同步执行以注册空写，resolve 是完成回调，泛型 void 表示完成值不供业务使用。
		return new Promise<void>((resolve) => {
			// 空串仍带解析完成回调，排在已有写入后；箭头执行 resolve 后这个屏障才完成。
			this.xterm.write("", () => resolve());
		});
	}

	/**
	 * Flush and get viewport - convenience method for tests
	 */
	// 先 flush 再返回视口字符串数组的 Promise；例 await flushAndGetViewport() 省两步，不会等待今后才排入的业务更新，异常作为拒绝传播。
	async flushAndGetViewport(): Promise<string[]> {
		// await 写队列屏障，让此前输出已反映到 buffer。
		await this.flush();
		// 同步读取当前可见行，async 将数组作为 Promise 的完成值。
		return this.getViewport();
	}

	/**
	 * Get the visible viewport (what's currently on screen)
	 * Note: You should use getViewportAfterWrite() for testing after writing data
	 */
	// 立即读取活动缓冲区视口快照并返回新 string[]，无 IO/等待；例刚 write 后应先 await flushAndGetViewport()，原英文提到的 getViewportAfterWrite 当前类并没有这个方法。
	getViewport(): string[] {
		// 建立新的结果数组，字符串内容由下方逐行提取。
		const lines: string[] = [];
		// active 可能为 normal 或 alternate，随已解析的切屏控制码变化，不把两份历史合并。
		const buffer = this.xterm.buffer.active;

		// Get only the visible lines (viewport)
		// 只遍历模拟器当前 rows 行；循环不是按包装器 _rows 字段。
		for (let i = 0; i < this.xterm.rows; i++) {
			// viewportY 是视口顶部在 buffer 中的偏移，加 i 得缓冲区行索引，不是 cursorY。
			const line = buffer.getLine(buffer.viewportY + i);
			// 底层 getLine 返回可选行，有行才调用它的方法。
			if (line) {
				// translateToString(true) 取单行字符并裁掉末尾未写入的空单元，显式写入的空格仍保留，不等于 JS trimEnd；不带 ANSI 样式，也不按 isWrapped 拼软折行。
				lines.push(line.translateToString(true));
				// 缺失行走空字符串退路。
			} else {
				// 仍补一项空行，让返回数组长度与 xterm.rows 一致。
				lines.push("");
			}
		}

		// 返回当时收集的数组；后续写入不会改这些已复制出的字符串。
		return lines;
	}

	/**
	 * Get the entire scroll buffer
	 */
	// 立即读取活动缓冲区现存全部行，含其 scrollback，返回新数组不等待；例 normal buffer 可多于一屏，容量受 xterm 配置限制，不保证无限历史。
	getScrollBuffer(): string[] {
		// 创建结果数组。
		const lines: string[] = [];
		// 取当前活动缓冲区，而非固定 normal；备用屏并不因此获得 normal 历史。
		const buffer = this.xterm.buffer.active;

		// Get all lines in the buffer (including scrollback)
		// 遍历 buffer.length 的所有索引，不仅 viewportY 后面的一屏。
		for (let i = 0; i < buffer.length; i++) {
			// 按完整 buffer 行号取行。
			const line = buffer.getLine(i);
			// 有行对象才能转成文字。
			if (line) {
				// 只取文字，裁掉末尾未写入的空单元、保留显式空格，保留行数组边界；不保留样式/图片载荷或复原软折行段落，不等于 trimEnd。
				lines.push(line.translateToString(true));
				// 缺失对象以空行占位。
			} else {
				// 补空串保持索引对应。
				lines.push("");
			}
		}

		// 返回新历史快照，不改变终端滚动位置。
		return lines;
	}

	/**
	 * Clear the terminal viewport
	 */
	// 调用 xterm 的 clear，返回 void；例已有历史时保留当前光标行并把它作为首行、清其余历史/补空行，光标已在首行且无历史时可不操作，并非保证全空屏。
	clear(): void {
		// 同步委托底层 clear，不等于排队发送 CSI2J；也不先 flush 之前尚未解析的输出。
		this.xterm.clear();
	}

	/**
	 * Reset the terminal completely
	 */
	// 调用 xterm 完整重置，返回 void；例把模拟终端状态恢复，包装器的回调/尺寸字段不会由此重新初始化，没有 dispose 或真实终端操作。
	reset(): void {
		// 委托 xterm.reset；底层重置语义与 clear 保留当前行不同。
		this.xterm.reset();
	}

	/**
	 * Get cursor position
	 */
	// 立即读取当前活动缓冲光标坐标，返回新 {x:number,y:number} 对象，无等待/副作用；例左上角为 (0,0)，不是整个历史的绝对行，x 允许位于最后格之后。
	getCursorPosition(): { x: number; y: number } {
		// 选择当前 normal/alternate 缓冲。
		const buffer = this.xterm.buffer.active;
		// 创建位置对象，字段类型只约束数值，不做边界验证。
		return {
			// cursorX 是终端列偏移，不是字符串 UTF-16 下标，可能等于列数。
			x: buffer.cursorX,
			// cursorY 相对底部页面 baseY，不额外加 viewportY 或 ybase。
			y: buffer.cursorY,
		};
	}

	/** Wait for TUI's throttled render pipeline to settle. */
	// 供测试等待常见节流帧，返回 Promise<void>；先 nextTick 再至少约 20ms 再 flush，例 requestRender 后调用。它是时序辅助，不保证任意动画/长任务/后续帧全部稳定，无真实 TTY。
	async waitForRender(): Promise<void> {
		// 注册下一轮 nextTick 回调并 await，给 TUI 已排的同类任务执行机会；Promise executor 现在注册，resolve 以后执行。
		await new Promise<void>((resolve) => process.nextTick(resolve));
		// 定时器约 20ms 后 resolve，宿主繁忙可更晚，不是精确实时截止。
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		// 最后等待此前写队列解析，防定时帧已经 write 但 xterm 还没更新 buffer。
		await this.flush();
	}
}
