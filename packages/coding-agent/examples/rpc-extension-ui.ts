/**
 * RPC Extension UI Example (TUI)
 *
 * A lightweight TUI chat client that spawns the agent in RPC mode.
 * Demonstrates how to build a custom UI on top of the RPC protocol,
 * including handling extension UI requests (select, confirm, input, editor).
 *
 * Usage: node examples/rpc-extension-ui.ts
 *
 * Slash commands:
 *   /select  - demo select dialog
 *   /confirm - demo confirm dialog
 *   /input   - demo input dialog
 *   /editor  - demo editor dialog
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples，RPC 示例系列。上游在构建后由
 * `node examples/rpc-extension-ui.ts` 启动；下游 spawn `node dist/cli.js --mode rpc
 * --no-session --no-extensions --extension extensions/rpc-demo.ts`，通过 stdin/stdout 的
 * JSON 行协议通信，并用 pi-tui 在真实终端里绘制聊天界面。
 *
 * 演示什么：如何在 RPC 协议之上自建 UI。宿主进程不直接调用 AgentSession，而是把用户输入
 * 写成 `{type:"prompt",message}` 等命令，再解析子进程输出的事件；扩展的 select/confirm/
 * input/editor 请求会作为 extension_ui_request 到达，UI 显示对话框后用 extension_ui_response
 * 按同一 id 回复。notify/setStatus/setWidget/set_editor_text 是不需要回复的通知类方法。
 * 斜杠命令完全在本地演示对话框，不发给子进程。发送普通消息会发起真实模型请求并可能产生费用。
 *
 * 能力清单（按文件顺序）：
 * - OutputLog：累积带 ANSI 样式的行，只渲染能放下的末尾部分。
 * - LoadingIndicator：等待模型时以 400ms 间隔轮播点号。
 * - PromptInput / InputDialog：单行输入，Ctrl+D 退出钩子。
 * - SelectDialog：包装 SelectList，把选择/取消转成回调。
 * - main：spawn 子进程、搭建 TUI、解析事件、处理扩展 UI 请求与斜杠命令、清理退出。
 * - handleExtensionUI / handleAgentLine：协议分发核心。
 *
 * 典型运行顺序与预期输出：
 *   1. 先构建 coding-agent（dist/cli.js 与 dist 中的扩展加载能力）。
 *   2. 在终端运行脚本；500ms 后若子进程已退出，打印 stderr 并以 1 退出。
 *   3. 正常时显示 RPC Chat 头部；输入问题回车，显示 You 行与 Agent 流式回答，工具调用显示为
 *      [tool: 名称]，结束后停止 spinner。
 *   4. Esc 在流式时发送 abort，空闲时退出；Ctrl+D 直接退出。子进程退出码会作为脚本退出码。
 *   5. 这是交互式 TUI，需要 TTY；在重定向输出的环境里无法正常操作。
 *
 * 示例（真实签名）：
 *   const agent = spawn("node", [cliPath, "--mode", "rpc", "--no-session", "--no-extensions",
 *     "--extension", extensionPath], { stdio: ["pipe", "pipe", "pipe"] });
 *   agent.stdin.write(JSON.stringify({ type: "prompt", message: "hi" }) + "\n");
 *   协议是逐行 JSON；扩展 UI 响应必须带回请求里的 id。
 *
 * 建议阅读顺序：先看三个基础组件（日志、加载指示、输入），再看两个对话框，随后看 main 的
 * 子进程与 TUI 装配，最后看 handleExtensionUI、handleAgentLine 与输入/退出处理。
 */

// spawn 启动子进程；path/url 定位 CLI 与扩展；StringDecoder 处理跨 chunk 的 UTF-8 多字节字符。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
// 这些多为运行值：Component/TUI 是 type-only，编译后擦除；其余类与函数在运行时使用。
import {
	type Component,
	Container,
	Input,
	matchesKey,
	ProcessTerminal,
	SelectList,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";

// ESM 没有 __dirname；从 import.meta.url 还原当前文件目录。
const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// ANSI helpers
// ============================================================================

// 转义序列常量；渲染字符串时拼接，RESET 用于结束前面的颜色/加粗/变暗。
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ============================================================================
// Extension UI request type (subset of rpc-types.ts)
// ============================================================================

// 这是 rpc-types.ts 里请求类型的子集：只列出本 UI 会读取的字段，因此 method 用 string 而非
// 更窄的联合；各可选字段只在对应 method 下有意义，接口本身不会强制这种关联。
interface ExtensionUIRequest {
	type: "extension_ui_request";
	// 请求 id 用于把响应关联回原请求；同一时刻可能有多个请求在途。
	id: string;
	method: string;
	title?: string;
	options?: string[];
	message?: string;
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	text?: string;
}

// ============================================================================
// Output log: accumulates styled lines, renders the tail that fits
// ============================================================================

// 实现 pi-tui 的 Component：只负责保存历史行并渲染末尾窗口；不跟踪终端光标，也不做换行排版。
class OutputLog implements Component {
	// 每项是一整行（可能含 ANSI 序列）；渲染时再按宽度截断。
	private lines: string[] = [];
	// 上限防止长对话无限占用内存；超过后丢最旧的行。
	private maxLines = 1000;
	// 0 表示不限制可见行数；setVisibleLines 可让上层只显示窗口高度。
	private visibleLines = 0;

	setVisibleLines(n: number): void {
		this.visibleLines = n;
	}

	append(line: string): void {
		this.lines.push(line);
		// 超过上限时 slice(-maxLines) 返回最后 maxLines 项的新数组，旧行被丢弃。
		if (this.lines.length > this.maxLines) {
			this.lines = this.lines.slice(-this.maxLines);
		}
	}

	// 把片段追加到最近一行而不是新起一行；用于流式 text_delta 的分段渲染。
	appendRaw(text: string): void {
		if (this.lines.length === 0) {
			// 还没有任何行时，片段本身就是第一行。
			this.lines.push(text);
		} else {
			// 直接修改最后一项；字符串拼接产生新字符串，不影响其他行。
			this.lines[this.lines.length - 1] += text;
		}
	}

	// 没有缓存布局可失效；TUI 仍会调用此方法作为组件协议的一部分。
	invalidate(): void {}

	render(width: number): string[] {
		// 空日志也返回一行空串，避免容器高度塌陷。
		if (this.lines.length === 0) return [""];
		// visibleLines > 0 时只取末尾 n 行；否则展示全部已保存行。
		const n = this.visibleLines > 0 ? this.visibleLines : this.lines.length;
		// l.slice(0, width) 按 UTF-16 码元截断；ANSI 序列可能被从中间切断，宽字符也不按显示宽度计算。
		return this.lines.slice(-n).map((l) => l.slice(0, width));
	}
}

// ============================================================================
// Loading indicator: "Agent: Working." -> ".." -> "..." -> "."
// ============================================================================

// 等待提示：用定时器推进点号并请求重绘；渲染本身无副作用。
class LoadingIndicator implements Component {
	// 当前点号数量，取值 1..3；start 时重置。
	private dots = 1;
	// Node 定时器句柄；null 表示未启动，stop 后恢复为 null。
	private intervalId: NodeJS.Timeout | null = null;
	// 保存 TUI 以便定时器触发重绘；生命周期由 start/stop 管理。
	private tui: TUI | null = null;

	start(tui: TUI): void {
		this.tui = tui;
		this.dots = 1;
		// 每 400ms 轮换 1→2→3→1；requestRender 让 TUI 重新调用 render。
		this.intervalId = setInterval(() => {
			this.dots = (this.dots % 3) + 1;
			// ?. 防止窗口在 stop 前被销毁时仍访问 TUI。
			this.tui?.requestRender();
		}, 400);
	}

	stop(): void {
		// 只在存在定时器时清理，重复调用安全。
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	invalidate(): void {}

	// width 未使用：输出固定短文本；下划线前缀表示有意不读取该参数。
	render(_width: number): string[] {
		return [`${BLUE}${BOLD}Agent:${RESET} ${DIM}Working${".".repeat(this.dots)}${RESET}`];
	}
}

// ============================================================================
// Prompt input: label + single-line input
// ============================================================================

// 提示输入组件：外层负责 Ctrl+D 退出，其余按键交给 pi-tui 的 Input。
class PromptInput implements Component {
	// 公开只读引用，main 用它在提交后清空、设置焦点和挂 onSubmit。
	readonly input: Input;
	// 由 main 注入；未设置时 Ctrl+D 不做任何事。
	onCtrlD?: () => void;

	constructor() {
		this.input = new Input();
	}

	handleInput(data: string): void {
		// matchesKey 解析当前按键数据；Ctrl+D 被本组件截获，其余按键原样转发。
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {
		// 转发给内部 Input，让它丢弃可能的渲染缓存。
		this.input.invalidate();
	}

	render(width: number): string[] {
		// 第一行是标签，后续行是 Input 的渲染结果（可能包含光标）。
		return [`${GREEN}${BOLD}You:${RESET}`, ...this.input.render(width)];
	}
}

// ============================================================================
// Dialog components: replace the prompt input during interactive requests
// ============================================================================

// 选择对话框：把字符串选项包装成 SelectList 的 items，并把回调转成字符串结果。
class SelectDialog implements Component {
	// 真正的列表交互（方向键、回车、Esc、过滤）由 SelectList 处理。
	private list: SelectList;
	// 标题只用于渲染，不参与列表匹配。
	private title: string;
	// 选中时传回 value；取消时单独调用 onCancel，不传值。
	onSelect?: (value: string) => void;
	onCancel?: () => void;

	constructor(title: string, options: string[]) {
		this.title = title;
		// value 与 label 都用原字符串；SelectList 允许二者不同，这里不需要额外映射。
		const items = options.map((o) => ({ value: o, label: o }));
		// 第二个参数是可见行数，最多 8 行；选项少于 8 时按实际数量。
		this.list = new SelectList(items, Math.min(items.length, 8), {
			// 这些回调只负责加 ANSI 样式；返回的字符串交给 SelectList 拼接。
			selectedPrefix: (t) => `${MAGENTA}${t}${RESET}`,
			selectedText: (t) => `${MAGENTA}${t}${RESET}`,
			description: (t) => `${DIM}${t}${RESET}`,
			scrollInfo: (t) => `${DIM}${t}${RESET}`,
			noMatch: (t) => `${YELLOW}${t}${RESET}`,
		});
		// 把 SelectList 的 item 回调降成字符串回调；?. 处理宿主未设置回调的情况。
		this.list.onSelect = (item) => this.onSelect?.(item.value);
		this.list.onCancel = () => this.onCancel?.();
	}

	handleInput(data: string): void {
		// 不拦截任何按键，全部交给列表；Esc 由 SelectList 转成 onCancel。
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		// 标题行 + 列表行 + 固定操作提示；列表自身按 width 换行/截断。
		return [
			`${MAGENTA}${BOLD}${this.title}${RESET}`,
			...this.list.render(width),
			`${DIM}Up/Down, Enter to select, Esc to cancel${RESET}`,
		];
	}
}

// 单行文本对话框：复用 Input，只额外提供标题、预填值和 Ctrl+D 钩子。
class InputDialog implements Component {
	private dialogInput: Input;
	private title: string;
	// 由 main 注入；Ctrl+D 通常用于退出整个程序。
	onCtrlD?: () => void;

	constructor(title: string, prefill?: string) {
		this.title = title;
		this.dialogInput = new Input();
		// 空字符串预填会被跳过；这是有意的 falsy 判断，不是类型错误。
		if (prefill) this.dialogInput.setValue(prefill);
	}

	// setter 直接转发到内部 Input，保持外部 API 简洁；读取此属性没有对应实现。
	set onSubmit(fn: ((value: string) => void) | undefined) {
		this.dialogInput.onSubmit = fn;
	}

	set onEscape(fn: (() => void) | undefined) {
		this.dialogInput.onEscape = fn;
	}

	// 暴露内部 Input 供 TUI 设置焦点；返回同一引用，不是副本。
	get inputComponent(): Input {
		return this.dialogInput;
	}

	handleInput(data: string): void {
		// 与 PromptInput 相同：先截获 Ctrl+D，再转发其余按键。
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.dialogInput.handleInput(data);
	}

	invalidate(): void {
		this.dialogInput.invalidate();
	}

	render(width: number): string[] {
		// 标题、输入行、操作提示；Enter/Esc 的实际行为由 Input 回调触发。
		return [
			`${MAGENTA}${BOLD}${this.title}${RESET}`,
			...this.dialogInput.render(width),
			`${DIM}Enter to submit, Esc to cancel${RESET}`,
		];
	}
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	// rpc-demo.ts 提供触发 select/confirm/input/editor 的扩展；CLI 入口必须已构建。
	const extensionPath = join(__dirname, "extensions/rpc-demo.ts");
	const cliPath = join(__dirname, "../dist/cli.js");

	// --no-extensions 先禁用自动发现，再只用 --extension 加载演示扩展；--no-session 不写会话文件。
	// stdio 三路都是 pipe：stdin 写命令，stdout 读 JSON 事件，stderr 收集诊断。
	const agent = spawn(
		"node",
		[cliPath, "--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	// stderr 不按行解析，只累积到退出时一次性展示；data 是 Buffer，用 toString 解码。
	let stderr = "";
	agent.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});

	// 等待 500ms 给子进程启动；这是启发式检查，不是握手。exitCode 为 null 表示仍在运行。
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (agent.exitCode !== null) {
		console.error(`Agent exited immediately. Stderr:\n${stderr}`);
		// 子进程已失败，TUI 尚未启动，直接以 1 退出。
		process.exit(1);
	}

	// -- TUI setup --

	// ProcessTerminal 接管真实终端（raw mode、尺寸、按键）；TuiMainScreen 负责主屏渲染循环。
	const terminal = new ProcessTerminal();
	const tui: TUI = new TuiMainScreen(terminal);

	// 三个可复用组件：日志、加载提示、提示输入。对话框按需创建。
	const outputLog = new OutputLog();
	const loadingIndicator = new LoadingIndicator();
	const promptInput = new PromptInput();

	// Container 按添加顺序纵向排列子组件；root 是屏幕内容的唯一根节点。
	const root = new Container();
	root.addChild(outputLog);
	root.addChild(promptInput);

	tui.addChild(root);
	// 焦点决定哪个组件接收 handleInput；初始焦点在 Input 内部组件上，而不是 PromptInput 包装层。
	tui.setFocus(promptInput.input);

	// -- Agent communication --

	// RPC 是行分隔 JSON：stringify 后必须补 \n，否则子进程不会认为一条消息结束。
	function send(obj: Record<string, unknown>): void {
		// stdin 在 spawn 的 stdio 配置下必然存在；非空断言只用于消除可选类型。
		agent.stdin!.write(`${JSON.stringify(obj)}\n`);
	}

	// 当前是否处在一次 agent 运行中；控制 spinner 与 Esc 行为。
	let isStreaming = false;
	// 本次运行是否已经输出过文字；用于只在首个 delta 时插入 Agent 标题。
	let hasTextOutput = false;

	// 主动退出：先恢复终端，再终止子进程；process.exit 立即结束，不等待子进程优雅退出。
	function exit(): void {
		tui.stop();
		agent.kill("SIGTERM");
		process.exit(0);
	}

	// -- Bottom area management --
	// The bottom of the screen is either the prompt input or a dialog.
	// These helpers swap between them.

	// 当前显示的对话框；null 表示底部是普通提示输入。扩展请求与本地斜杠命令共用它。
	let activeDialog: Component | null = null;

	// 重建根容器内容：日志始终在顶部，流式中可插入 spinner，最底部是给定组件。
	function setBottomComponent(component: Component): void {
		// clear 只移除子组件引用，不会销毁对话框对象。
		root.clear();
		root.addChild(outputLog);
		if (isStreaming) root.addChild(loadingIndicator);
		root.addChild(component);
		// 焦点直接设为传入组件；对 InputDialog 调用方还需要再聚焦内部 Input。
		tui.setFocus(component);
		tui.requestRender();
	}

	// 回到普通输入：清除当前对话框引用并恢复提示输入。
	function showPrompt(): void {
		activeDialog = null;
		setBottomComponent(promptInput);
		tui.setFocus(promptInput.input);
	}

	// 显示对话框：记录引用，后续 spinner 更新会保留它而不是换成 promptInput。
	function showDialog(dialog: Component): void {
		activeDialog = dialog;
		setBottomComponent(dialog);
	}

	// agent_start 时进入流式状态；重复调用只生效一次，避免重置已输出的标题状态。
	function showLoading(): void {
		if (!isStreaming) {
			isStreaming = true;
			hasTextOutput = false;
			root.clear();
			root.addChild(outputLog);
			root.addChild(loadingIndicator);
			// 若扩展正显示对话框，保持它；否则显示普通输入。?? 只回退 null/undefined。
			root.addChild(activeDialog ?? promptInput);
			if (!activeDialog) tui.setFocus(promptInput.input);
			loadingIndicator.start(tui);
			tui.requestRender();
		}
	}

	// agent_settled 时停止 spinner；对话框仍保留，流式标记由调用方在更早处清除。
	function hideLoading(): void {
		loadingIndicator.stop();
		root.clear();
		root.addChild(outputLog);
		root.addChild(activeDialog ?? promptInput);
		if (!activeDialog) tui.setFocus(promptInput.input);
		tui.requestRender();
	}

	// -- Extension UI dialog handling --

	// 选择对话框的通用流程：无论选择还是取消，都先恢复普通输入，再把可选值交给调用方。
	function showSelectDialog(title: string, options: string[], onDone: (value: string | undefined) => void): void {
		const dialog = new SelectDialog(title, options);
		dialog.onSelect = (value) => {
			showPrompt();
			onDone(value);
		};
		dialog.onCancel = () => {
			showPrompt();
			onDone(undefined);
		};
		showDialog(dialog);
	}

	// 输入对话框：提交值会 trim，空串转成 undefined 表示“没有有效输入”；取消直接传 undefined。
	function showInputDialog(title: string, prefill?: string, onDone?: (value: string | undefined) => void): void {
		const dialog = new InputDialog(title, prefill);
		dialog.onSubmit = (value) => {
			showPrompt();
			// value.trim() || undefined：纯空白与空串都视为取消输入。
			onDone?.(value.trim() || undefined);
		};
		dialog.onEscape = () => {
			showPrompt();
			onDone?.(undefined);
		};
		// Ctrl+D 在对话框中也退出整个程序，而不是取消当前对话框。
		dialog.onCtrlD = exit;
		showDialog(dialog);
		// showDialog 聚焦的是包装组件；这里改聚焦内部 Input，按键才会进入文本缓冲。
		tui.setFocus(dialog.inputComponent);
	}

	// 把一条 extension_ui_request 分派到对应 UI；前四种需要回复，后四种只展示。
	function handleExtensionUI(req: ExtensionUIRequest): void {
		const { id, method } = req;

		switch (method) {
			// Dialog methods: replace prompt with interactive component
			case "select": {
				// 选中发送 value；取消发送 cancelled:true；两者都带回请求 id。
				showSelectDialog(req.title ?? "Select", req.options ?? [], (value) => {
					if (value !== undefined) {
						send({ type: "extension_ui_response", id, value });
					} else {
						send({ type: "extension_ui_response", id, cancelled: true });
					}
				});
				break;
			}

			case "confirm": {
				// 把 message 拼进标题而不是单独渲染；title 缺失时得到 "undefined: 消息"，这是示例的简化。
				const title = req.message ? `${req.title}: ${req.message}` : (req.title ?? "Confirm");
				// confirm 协议只需要布尔值；Esc 取消时 value 为 undefined，于是 confirmed 为 false。
				showSelectDialog(title, ["Yes", "No"], (value) => {
					send({ type: "extension_ui_response", id, confirmed: value === "Yes" });
				});
				break;
			}

			case "input": {
				// placeholder 仅作为标题提示展示；真正的输入框没有单独的占位文本渲染。
				const title = req.placeholder ? `${req.title} (${req.placeholder})` : (req.title ?? "Input");
				showInputDialog(title, undefined, (value) => {
					if (value !== undefined) {
						send({ type: "extension_ui_response", id, value });
					} else {
						send({ type: "extension_ui_response", id, cancelled: true });
					}
				});
				break;
			}

			case "editor": {
				// editor 本可多行，但示例用单行 Input：换行替换成空格，只保留内容大意。
				const prefill = req.prefill?.replace(/\n/g, " ");
				showInputDialog(req.title ?? "Editor", prefill, (value) => {
					if (value !== undefined) {
						send({ type: "extension_ui_response", id, value });
					} else {
						send({ type: "extension_ui_response", id, cancelled: true });
					}
				});
				break;
			}

			// Fire-and-forget methods: display as notification
			case "notify": {
				// 接口已把 notifyType 声明为三值联合，这里的 as string 是冗余断言，不改变运行时。
				const notifyType = (req.notifyType as string) ?? "info";
				// error 红、warning 黄、其余信息紫；嵌套三元从右到左结合。
				const color = notifyType === "error" ? RED : notifyType === "warning" ? YELLOW : MAGENTA;
				outputLog.append(`${color}${BOLD}Notification:${RESET} ${req.message}`);
				tui.requestRender();
				break;
			}

			case "setStatus":
				// statusText 缺省显示 (cleared)，表示该状态键被清除；没有状态栏，直接写日志。
				outputLog.append(
					`${MAGENTA}${BOLD}Notification:${RESET} ${DIM}[status: ${req.statusKey}]${RESET} ${req.statusText ?? "(cleared)"}`,
				);
				tui.requestRender();
				break;

			case "setWidget": {
				const lines = req.widgetLines;
				// 空数组视为清除/无内容，不打印；只有非空时才逐行展示。
				if (lines && lines.length > 0) {
					outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} ${DIM}[widget: ${req.widgetKey}]${RESET}`);
					for (const wl of lines) {
						outputLog.append(`  ${DIM}${wl}${RESET}`);
					}
					tui.requestRender();
				}
				break;
			}

			case "set_editor_text":
				// 用请求文本替换当前输入内容；缺省时清空。as string 同样是冗余断言。
				promptInput.input.setValue((req.text as string) ?? "");
				tui.requestRender();
				break;
		}
	}

	// -- Slash commands (local, not sent to agent) --

	// 返回 true 表示命令已在本地处理，调用方不应再向 agent 发送 prompt。
	function handleSlashCommand(cmd: string): boolean {
		switch (cmd) {
			case "/select":
				showSelectDialog("Pick a color", ["Red", "Green", "Blue", "Yellow"], (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} You picked: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Selection cancelled`);
					}
					tui.requestRender();
				});
				return true;

			case "/confirm":
				showSelectDialog("Are you sure?", ["Yes", "No"], (value) => {
					const confirmed = value === "Yes";
					outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Confirmed: ${confirmed}`);
					tui.requestRender();
				});
				return true;

			case "/input":
				showInputDialog("Enter your name", undefined, (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} You entered: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Input cancelled`);
					}
					tui.requestRender();
				});
				return true;

			case "/editor":
				showInputDialog("Edit text", "Hello, world!", (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Submitted: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Editor cancelled`);
					}
					tui.requestRender();
				});
				return true;

			default:
				// 未识别的命令不拦截，调用方会把它当普通消息发给 agent。
				return false;
		}
	}

	// -- Process agent stdout --

	// 每条 stdout 行是一个 JSON 值；只处理本 UI 关心的事件，其余静默忽略。
	function handleAgentLine(line: string): void {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(line);
		} catch {
			// 非 JSON 行（例如扩展误写 stdout）直接丢弃，避免破坏 TUI。
			return;
		}

		// 命令失败响应：打印命令名和错误；success 缺失或其他 type 不进入此分支。
		if (data.type === "response" && !data.success) {
			outputLog.append(`${RED}[error]${RESET} ${data.command}: ${data.error}`);
			tui.requestRender();
			return;
		}

		// 一轮运行开始：显示 spinner，并重置本次运行的文字输出标记。
		if (data.type === "agent_start") {
			showLoading();
			return;
		}

		// 扩展 UI 请求：data 的字段形状由上面的接口描述，这里强行断言以复用处理函数。
		if (data.type === "extension_ui_request") {
			handleExtensionUI(data as unknown as ExtensionUIRequest);
			return;
		}

		if (data.type === "message_update") {
			// assistantMessageEvent 是嵌套判别联合；先断言成键值对象，再用 type 判断是否为文字增量。
			const evt = data.assistantMessageEvent as Record<string, unknown> | undefined;
			if (evt?.type === "text_delta") {
				// 第一次文字输出时插入空行与 Agent 标签；同一次运行后续 delta 不再重复。
				if (!hasTextOutput) {
					hasTextOutput = true;
					outputLog.append("");
					outputLog.append(`${BLUE}${BOLD}Agent:${RESET}`);
				}
				const delta = evt.delta as string;
				// 按换行切成多段：第一段接到当前行，后续每段先新建一行，从而保留模型输出的换行结构。
				const parts = delta.split("\n");
				for (let i = 0; i < parts.length; i++) {
					if (i > 0) outputLog.append("");
					// 空段（连续换行）只保留换行，不追加空文本。
					if (parts[i]) outputLog.appendRaw(parts[i]);
				}
				tui.requestRender();
			}
			return;
		}

		// 工具开始：工具名写入日志；参数不在此展示。
		if (data.type === "tool_execution_start") {
			outputLog.append(`${DIM}[tool: ${data.toolName}]${RESET}`);
			tui.requestRender();
			return;
		}

		// 工具结束：把结果 JSON 截到 120 个字符展示；这只是预览，可能不是合法 JSON 前缀。
		if (data.type === "tool_execution_end") {
			const result = JSON.stringify(data.result).slice(0, 120);
			outputLog.append(`${DIM}[result: ${result}...]${RESET}`);
			tui.requestRender();
			return;
		}

		// 一轮运行完全落定（包括工具循环）：先清流式标记，再隐藏 spinner。
		if (data.type === "agent_settled") {
			isStreaming = false;
			hideLoading();
			outputLog.append("");
			tui.requestRender();
			return;
		}
	}

	// StringDecoder 保留跨 chunk 的半个 UTF-8 字符；直接用 Buffer.toString 可能把中文等多字节字符拆坏。
	const stdoutDecoder = new StringDecoder("utf8");
	let stdoutBuffer = "";

	// 协议是行分隔 JSON；一次 data 可能含多行、半行，或者多行加半行。
	agent.stdout!.on("data", (chunk: Buffer) => {
		// write 返回已能完整解码的字符串；不完整尾部留在 decoder 内部。
		stdoutBuffer += stdoutDecoder.write(chunk);
		while (true) {
			const newlineIndex = stdoutBuffer.indexOf("\n");
			// 没有换行说明还不到完整消息，留待下一次 data。
			if (newlineIndex === -1) break;

			const line = stdoutBuffer.slice(0, newlineIndex);
			// 去掉已消费的部分（含 \n），剩余部分继续扫描。
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			// 兼容 Windows 的 \r\n：只在确实以 \r 结尾时去掉最后一个字符。
			handleAgentLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	});

	// 子进程关闭 stdout 时冲刷 decoder 的残留字节，并处理最后一条没有换行符的消息。
	agent.stdout!.on("end", () => {
		stdoutBuffer += stdoutDecoder.end();
		if (stdoutBuffer.length > 0) {
			handleAgentLine(stdoutBuffer.endsWith("\r") ? stdoutBuffer.slice(0, -1) : stdoutBuffer);
		}
	});

	// -- User input --

	// 回车提交：空白忽略；斜杠命令本地处理；其余作为 prompt 发送给 agent。
	promptInput.input.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		// 先清空输入框，避免异步回答期间仍显示旧文本。
		promptInput.input.setValue("");

		if (handleSlashCommand(trimmed)) {
			// 本地命令也回显一行 You，但不发送给 agent。
			outputLog.append(`${GREEN}${BOLD}You:${RESET} ${trimmed}`);
			tui.requestRender();
			return;
		}

		// 先回显再发送；prompt 命令由子进程执行真实模型请求。
		outputLog.append(`${GREEN}${BOLD}You:${RESET} ${trimmed}`);
		send({ type: "prompt", message: trimmed });
		tui.requestRender();
	};

	// 普通输入框的 Ctrl+D 直接退出程序。
	promptInput.onCtrlD = exit;

	// Esc：流式中发送 abort；空闲时退出。abort 是合作式取消，不保证远端工具已停止副作用。
	promptInput.input.onEscape = () => {
		if (isStreaming) {
			send({ type: "abort" });
			outputLog.append(`${YELLOW}[aborted]${RESET}`);
			tui.requestRender();
		} else {
			exit();
		}
	};

	// -- Agent exit --

	// 子进程自然退出：恢复终端，输出收集到的 stderr 与退出码，并用相同码结束宿主进程。
	agent.on("exit", (code) => {
		tui.stop();
		if (stderr) console.error(stderr);
		console.log(`Agent exited with code ${code}`);
		// code 可能为 null（被信号终止），此时按 0 处理；这与被杀死应报非零的惯例不同。
		process.exit(code ?? 0);
	});

	// -- Start --

	// 初始日志：标题与操作提示；随后启动 TUI 渲染循环。
	outputLog.append(`${BOLD}RPC Chat${RESET}`);
	outputLog.append(`${DIM}Type a message and press Enter. Esc to abort or exit. Ctrl+D to quit.${RESET}`);
	outputLog.append(`${DIM}Slash commands: /select /confirm /input /editor${RESET}`);
	outputLog.append("");

	tui.start();
}

// 顶层兜底：main 中未捕获的拒绝（例如 spawn/终端初始化失败）打印后以 1 退出。
main().catch((err) => {
	console.error(err);
	process.exit(1);
});
