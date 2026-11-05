#!/usr/bin/env node
// 手工键码观察程序：直接启动真实终端，把收到的字符串转为十六进制、字符码和部分转义文本，显示最近20条记录与当前键盘协议。
// 首行 shebang 必须保持在文件第一行；它提供通过可执行文件启动时的 Node 解释器提示，不是 TypeScript 类型声明。下面 matchesKey 识别协议键名，Kitty 解析还可更新模块共享的事件类型状态。
import { matchesKey } from "../src/keys.ts";
// ProcessTerminal 负责真实 stdin/stdout、键盘协议协商与停止复原，new 时还没有接管键盘。
import { ProcessTerminal } from "../src/terminal.ts";
// type Component 约束可渲染组件，TUI 约束宿主；两个类型在运行时擦除，不会自动实现方法。
import type { Component, TUI } from "../src/tui.ts";
// 主屏实现按组件返回的行更新终端；它不会自动把所有 Ctrl+C 当退出命令，组件在下面自己处理。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// truncateToWidth 先按终端显示格裁剪并尽量保留控制样式；后面的 padEnd 则按 UTF-16 长度补齐，两种度量不同。
import { truncateToWidth } from "../src/utils.ts";

/**
 * Simple key code logger component
 */
// 记录键码并渲染的有状态组件；implements 让 TS 核对 render/invalidate 等签名，但不自动挂到 TUI 或注册输入。
class KeyLogger implements Component {
	// 每实例独立的字符串数组保存已格式化记录；private 主要是 TS 访问限制，数组仍会被本类 push/shift 修改。
	private log: string[] = [];
	// 最多保留20条输入记录，字段未声明 readonly，因此类型上仍允许类内修改。
	private maxLines = 20;
	// 保存宿主引用，供输入后请求重画；声明本身尚未赋值。
	private tui: TUI;
	// 保存真实适配器引用，协议名称从它的状态 getter 读取，而不是再次问终端。
	private terminal: ProcessTerminal;

	// 构造时接宿主与适配器，只保存引用，没有返回值，也不启动监听或绘制；例如之后 handleInput('a') 才会追加记录。
	constructor(tui: TUI, terminal: ProcessTerminal) {
		// 把传入 tui 保存为实例字段，参数和字段同名时用 this 区分。
		this.tui = tui;
		// 保存 terminal，不复制或重新创建终端。
		this.terminal = terminal;
	}

	// 处理一个已分好的输入字符串：Ctrl+C 时正常停屏并退出，否则计算三种表示、保留最近20条、请求重画，返回 void。
	// 例如输入 a 的 UTF-8 hex 是61、首码元97；输入错误、停止或写入错误没有统一 catch。显示的是 ProcessTerminal 解码后的字符串，不是原始 stdin 字节抓包。
	handleInput(data: string): void {
		// Handle Ctrl+C (raw or Kitty protocol) for exit
		// 匹配原始或受支持协议编码的 ctrl+c；这里直接使用固定键名，不通过用户可配置的动作名查询。
		if (matchesKey(data, "ctrl+c")) {
			// 先停止 TUI，尽力复原终端与解绑输入；异常会阻止后面的日志和退出。
			this.tui.stop();
			// 停止后打印退出提示，避免把这段普通日志混进正在绘制的组件内容。
			console.log("\nExiting...");
			// 立即退出进程，随后记录/重绘路径不会再执行；不等待任何周期定时器自然结束。
			process.exit(0);
		}

		// Convert to various representations
		// 把当前 JS 字符串重新按默认 UTF-8 编码成 Buffer，再转小写 hex；若原始字节先被 UTF-8 解码替换过，这里不能还原那些丢失字节。
		const hex = Buffer.from(data).toString("hex");
		// Array.from 按 Unicode 码点迭代字符串并生成数组，下一行对每个码点字符串取首 UTF-16 码元。
		const charCodes = Array.from(data)
			// charCodeAt(0) 不是 codePointAt(0)：补充平面字符的字符串有两个码元，此处只显示高代理码元，不是完整码点或所有码元列表。
			.map((c) => c.charCodeAt(0))
			// 把这些数字用逗号空格连接成一段诊断文字。
			.join(", ");
		// 从输入构造可读表示，下面连续 replace 各生成新字符串，不修改原 data；只转义列出的五类控制字符，不是完整的安全终端转义器。
		const repr = data
			// 将所有 ESC 字节替换为可见的反斜杠 x1b 文本，避免常见转义序列在 Repr 栏直接起作用。
			.replace(/\x1b/g, "\\x1b")
			// 将所有 CR 显示为反斜杠 r。
			.replace(/\r/g, "\\r")
			// 将所有 LF 显示为反斜杠 n，不让该类换行在这一栏直接拆成多行。
			.replace(/\n/g, "\\n")
			// 将所有 Tab 显示为反斜杠 t。
			.replace(/\t/g, "\\t")
			// 将 DEL 显示为反斜杠 x7f；BEL 等其他未列控制字符仍可能原样保留，不能宣称 Repr 已对任意输入完全消毒。
			.replace(/\x7f/g, "\\x7f");

		// 拼出整条记录，hex 至少补到20码元、数字列表至少15码元，长内容不会被 padEnd 截断；Repr 外侧双引号只是展示分隔。
		const logLine = `Hex: ${hex.padEnd(20)} | Chars: [${charCodes.padEnd(15)}] | Repr: "${repr}"`;

		// 把新记录追加数组末尾，之后显示顺序从旧到新。
		this.log.push(logLine);

		// Keep only last N lines
		// 超过配置20条时移除最旧一条；一次输入只追加一条，所以一次 shift 足以恢复上限。
		if (this.log.length > this.maxLines) {
			// shift 原地移除首元素，其返回的旧记录没有使用。
			this.log.shift();
		}

		// Request re-render to show the new log entry
		// 请求未来一帧显示新记录，不在这里直接 render 或等待屏幕刷新。
		this.tui.requestRender();
	}

	// 实现无缓存的失效接口，不接参数、不改状态、返回 void；例如父容器统一 invalidate 时这里没有额外工作。
	invalidate(): void {
		// No cached state to invalidate currently
	}

	// 读取本实例协议标志并返回名称，无查询/I/O；Kitty 优先，其次 modifyOtherKeys，再回退 legacy，不保证终端实际支持名称代表的全部特性。
	private protocolName(): string {
		// Kitty 标志只有收到支持性回复后才为真，已发送启用请求但未确认时不一定命中。
		if (this.terminal.kittyProtocolActive) return "kitty";
		// 没有Kitty时检查已启用后备协议的本地标志；getter 不在此发协商报文。
		if (this.terminal.modifyOtherKeysActive) return "modifyOtherKeys";
		// 两者都未标记激活就显示 legacy，包括协议还没协商完成的时刻。
		return "legacy";
	}

	// 把一行按显示宽裁剪，再按字符串长度补齐并返回，不改组件状态；例如 ASCII abc 宽5得两个尾空格，但含ANSI或宽字时 padEnd 的码元度量不能保证输出恰为5个终端格。
	private fit(line: string, width: number): string {
		// truncateToWidth 的默认省略标记计入显示预算；随后 padEnd(width) 看裁剪串的 UTF-16 长度，不会剥样式或再做可见宽度校正。
		return truncateToWidth(line, width).padEnd(width);
	}

	// 按给定宽度生成标题、协议、最近记录、补白与操作提示并返回字符串数组；不直接写终端，也不因终端高度更小而自行减少这些行。
	render(width: number): string[] {
		// 为本次渲染创建新的 string[]，后面 push 按顺序积累行。
		const lines: string[] = [];

		// Title
		// 生成 width 个 ASCII 等号作为顶部边框；repeat 依赖调用方给出可用宽度，非法次数可抛错。
		lines.push("=".repeat(width));
		// 裁剪并补齐固定标题，标题文字提醒的 Ctrl+C 与上面的实际按键分支对应。
		lines.push(this.fit("Key Code Tester - Press keys to see their codes (Ctrl+C to exit)", width));
		// 访问当前协议标志，模板拼 Protocol 文案，再经 fit 适配宽度；不触发新的能力查询。
		lines.push(this.fit(`Protocol: ${this.protocolName()}`, width));
		// 在协议信息下再加一条等号分隔线。
		lines.push("=".repeat(width));
		// 增加一个空字符串行作为标题区与记录区的空隙，不在此补到 width 个空格。
		lines.push("");

		// Log entries
		// 按保存顺序遍历最多20条记录，不反转数组或删除已显示项。
		for (const entry of this.log) {
			// 每条经 fit 后追加为一行，长记录只影响其显示，不改变 log 中原始诊断串。
			lines.push(this.fit(entry, width));
		}

		// Fill remaining space
		// 使标题加记录区至少25行；Math.max 防负数，未用 terminal.rows 动态计算可见高度。
		const remaining = Math.max(0, 25 - lines.length);
		// 按 remaining 次循环追加空白，let i 每轮递增。
		for (let i = 0; i < remaining; i++) {
			// 空串 padEnd(width) 生成 width 个空格，作为完整空白行。
			lines.push("".padEnd(width));
		}

		// Footer
		// 追加页脚顶部等号线。
		lines.push("=".repeat(width));
		// 显示操作提示小标题。
		lines.push(this.fit("Test these:", width));
		// 提示可以测试 Shift+Enter 及 Kitty 预期编码，源码双反斜杠让画面出现可见转义写法，并不是在此发送 Shift+Enter。
		lines.push(this.fit("  - Shift + Enter (should show: \\x1b[13;2u with Kitty protocol)", width));
		// 列出 Alt/Option+Enter 手工观察项目，没有自动化断言。
		lines.push(this.fit("  - Alt/Option + Enter", width));
		// 列出 Alt/Option+Backspace。
		lines.push(this.fit("  - Option/Alt + Backspace", width));
		// 列出 Command/Ctrl+Backspace；不同平台/终端可能实际发送不同序列，文字不证明它们相同。
		lines.push(this.fit("  - Cmd/Ctrl + Backspace", width));
		// 列出普通 Backspace 观察项目。
		lines.push(this.fit("  - Regular Backspace", width));
		// 页脚末尾等号线；这8条页脚行加在已补到25行的上部之后，正常总高为33行。
		lines.push("=".repeat(width));

		// 返回本次新数组，由宿主主屏真正输出；渲染不清空日志。
		return lines;
	}
}

// Set up TUI
// 模块顶层创建真实进程适配器，不是虚拟终端测试替身。
const terminal = new ProcessTerminal();
// 创建主屏TUI并注入真实适配器，类型 TUI 不改变实例。
const tui: TUI = new TuiMainScreen(terminal);
// 创建日志组件并保存同一 tui/terminal 引用。
const logger = new KeyLogger(tui, terminal);

// 把日志组件加入可见组件树。
tui.addChild(logger);
// 键盘输入焦点指向日志组件，让 handleInput 可以收到协议字符串。
tui.setFocus(logger);

// Handle Ctrl+C for clean exit (SIGINT still works for raw mode)
// 另注册进程 SIGINT 回调：外部 SIGINT 到达时停TUI、打印提示并退出；raw模式下物理Ctrl+C通常变成输入字节，由上面的 handleInput 分支处理，不保证自动生成SIGINT。
process.on("SIGINT", () => {
	// SIGINT 回调中先正常停止终端。
	tui.stop();
	// 停止后打印退出提示。
	console.log("\nExiting...");
	// 以0立即退出；没有把这次中断当错误退出码。
	process.exit(0);
});

// Start the TUI
// 启动真实终端输入与协议协商，安排首帧；直接导入这个手工文件也会执行启动。
tui.start();

// Protocol negotiation completes asynchronously after the first render.
// Refresh briefly/continuously so the displayed protocol state is not stale.
// 登记每100ms请求重绘的真实 interval，让稍后协商得到的协议标志可见；未保存句柄或 unref，常规退出靠 process.exit，不是定时器会自动结束。
setInterval(() => tui.requestRender(), 100);
