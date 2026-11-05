// 展示用户 Bash 命令的流式输出/结束状态；执行与会话记录在调用方，展开和本地裁剪只影响界面。
/**
 * Component for displaying bash command execution with streaming output.
 */

// 布局/加载动画是运行时组件；type TUI 只约束宿主刷新接口，不在这里建立终端。
import { Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import {
	// 和工具层共享的默认正文 UTF-8 字节预算。
	DEFAULT_MAX_BYTES,
	// 和工具层共享的默认逻辑行预算。
	DEFAULT_MAX_LINES,
	// 上游截断详情的静态类型，编译后擦除。
	type TruncationResult,
	// 本地保留文本结尾的裁剪算法，不调用模型总结。
	truncateTail,
} from "../../../core/tools/truncate.ts";
// 清理每个输出片段中的 ANSI 控制序列，不是跨片段的终端模拟器。
import { stripAnsi } from "../../../utils/ansi.ts";
// 动态取得命令标题、弱化输出与状态提示的主题样式。
import { theme } from "../theme/theme.ts";
// 按当前渲染宽度产生上下边框，不固定捕获构造时的窗口宽度。
import { DynamicBorder } from "./dynamic-border.ts";
// 把当前配置的取消/展开键写入提示，组件自身没有绑定这些按键。
import { keyHint, keyText } from "./keybinding-hints.ts";
// 先按实际宽度折行再保留显示尾部，避免一条长逻辑行撑满屏幕。
import { truncateToVisualLines } from "./visual-truncate.ts";

// Preview line limit when not expanded (matches tool execution behavior)
// 折叠先取末 20 个逻辑行，再限制为末 20 个视觉行；这两种行数可能不同。
const PREVIEW_LINES = 20;

// 用于用户 !/!! 命令及其历史显示，不运行 shell、不自行写日志或改变模型消息；宿主传入命令输出和结束状态。
export class BashExecutionComponent extends Container {
	// 保存要显示的命令原文，不在此执行或解析 shell 语法。
	private command: string;
	// 累计去 ANSI/规范换行后的全部收到输出；显示裁剪不会缩小这个数组。
	private outputLines: string[] = [];
	// 字符串字面量联合限制状态取值，初始 running；状态由 setComplete 的传入值决定。
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	// 退出码可缺失，缺失不等于能证明进程正常退出。
	private exitCode: number | undefined = undefined;
	// 构造即启动动画的加载组件，setComplete 会停止其定时器。
	private loader: Loader;
	// 可选上游截断信息；本组件还会计算自己的显示裁剪，二者不能混为一份磁盘全文。
	private truncationResult?: TruncationResult;
	// 上游提供的全文日志路径，仅展示，不在这里打开/读取文件。
	private fullOutputPath?: string;
	// 初始折叠，展开仍受下面的共享行/字节显示预算限制。
	private expanded = false;
	// 上下边框之间的动态内容，每次更新清空重建。
	private contentContainer: Container;
	/** `dim` marks `!!` commands, whose output is excluded from the model context. */
	// 只读字段在构造时选颜色，readonly 禁止后续重赋；!! 的实际上下文排除由宿主处理，不由颜色实现。
	private readonly colorKey: "dim" | "bashMode";
	// 命令、输出和状态提示的左右留白；边框仍占父宽。
	private outputPad: number;

	// 创建命令显示：存命令/配色/留白→加边框和容器→启动 Loader→建立初始 running 内容。
	// 例 new BashExecutionComponent("pwd",ui,true) 用弱化色显示，但不会执行 pwd；历史恢复也先建动画，随后 setComplete 停止。
	// 参数 ui 用于 Loader 请求绘制；构建/主题错误向上传播，需结束时停止 Loader，组件自身无取消命令处理器。
	constructor(command: string, ui: TUI, excludeFromContext = false, outputPad = 1) {
		// 初始化父容器后访问 this。
		super();
		// 保存命令文字，显示时在前面加 $。
		this.command = command;
		// 三元表达式只选择显示颜色，不在此做模型上下文筛选。
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		// 保存水平留白，默认构造值 1；后续 setter 可更新。
		this.outputPad = outputPad;
		// 箭头闭包给上下边框着色，实际调用时读取当前主题。
		const borderColor = (str: string) => theme.fg(this.colorKey, str);

		// Add spacer
		// 整条命令卡片前加入一行聊天间距。
		this.addChild(new Spacer(1));

		// Top border
		// 上下边框各是独立组件，共用配色回调，render 时按传入宽度生成。
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		// 建立边框之间的动态内容容器。
		this.contentContainer = new Container();
		// 把内容放在上边框之后，下边框稍后加入。
		this.addChild(this.contentContainer);

		// 构造立即启动动画/刷新定时器，不只是保存配置；传入两种颜色回调和运行提示。
		this.loader = new Loader(
			// Loader 将通过宿主 requestRender 安排后续绘屏。
			ui,
			// 旋转图标使用当前命令配色。
			(spinner) => theme.fg(this.colorKey, spinner),
			// 运行提示文字使用弱化色。
			(text) => theme.fg("muted", text),
			// 模板插入当前取消键提示，原文仍由 Loader 着色；看到提示不代表本组件自行处理取消。
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // Plain text for loader
		);

		// Bottom border
		// 上下边框各是独立组件，共用配色回调，render 时按传入宽度生成。
		this.addChild(new DynamicBorder(borderColor));

		// 按当前累积输出和状态重建显示；本方法不直接 requestRender，宿主事件与 Loader 负责请求。
		this.updateDisplay();
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	// 更新展开状态后重建显示，无返回值；例 true 显示预算内全部输出，仍不读取 fullOutputPath，也不改原输出数组。
	setExpanded(expanded: boolean): void {
		// 保存标志，即使值相同也重建。
		this.expanded = expanded;
		// 按当前累积输出和状态重建显示；本方法不直接 requestRender，宿主事件与 Loader 负责请求。
		this.updateDisplay();
	}

	// 设置左右留白并重建，例传 0 将文字贴近内容区边缘；不在此验证数字范围，无返回值。
	setOutputPad(outputPad: number): void {
		// 保存新的水平留白；setter 自身没有默认参数或范围检查。
		this.outputPad = outputPad;
		// 按当前累积输出和状态重建显示；本方法不直接 requestRender，宿主事件与 Loader 负责请求。
		this.updateDisplay();
	}

	// 先通知旧孩子失效，再按当前主题/状态重建；例主题切换后刷新，override 由 TS 检查重写父类方法。
	override invalidate(): void {
		// 递归通知当前孩子；若 Loader 在其中，它自己的 invalidate 会请求重画，但不会因此重启动画。
		super.invalidate();
		// 按当前累积输出和状态重建显示；本方法不直接 requestRender，宿主事件与 Loader 负责请求。
		this.updateDisplay();
	}

	// 追加一段上游输出，清 ANSI、统一 CR/LF、拼接未完成行并重建显示；例先 "hel" 再 "lo\n" 得到 "hello" 行。
	// 保存收到的全部清理后文本，不限数组大小；片段间拆开的 ANSI/CRLF 没有单独跨块解析状态，格式化错误可传播。
	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		// 先移除本片段 ANSI，再把 CRLF 和剩余单 CR 都变 LF；这是逐片段清理，不是模拟光标回车覆写。
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		// 按 LF 拆分，末尾 LF 留空元素以便下个片段从新行继续。
		const newLines = clean.split("\n");
		// 已有输出时，当前片段首行是上一段末行的延续；字符串 split 总会产生至少一个元素。
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			// 将首段字符串接到累计末行；上一段以 LF 结束时该末行为空，效果就是新行内容。
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			// 剩余分行依次追加，... 展开数组元素，保留真实空白行。
			this.outputLines.push(...newLines.slice(1));
		} else {
			// 尚无旧输出时全部加入，不额外插一条空首行。
			this.outputLines.push(...newLines);
		}

		// 按当前累积输出和状态重建显示；本方法不直接 requestRender，宿主事件与 Loader 负责请求。
		this.updateDisplay();
	}

	// 接上游结束信息，保存退出码/取消与截断元数据，停止 Loader 并重建；无等待进程、无文件读取、无返回值。
	// 例 setComplete(1,false) 显示错误退出码，setComplete(undefined,false) 按现有规则显示 complete，不能据此证明成功。
	setComplete(
		// 退出码可缺，来自执行器/历史消息。
		exitCode: number | undefined,
		// 是否取消单独传入，优先于非零退出码。
		cancelled: boolean,
		// 可选上游输出裁剪说明，只用于结束提示。
		truncationResult?: TruncationResult,
		// 可选全文文件路径，只作显示文字。
		fullOutputPath?: string,
	): void {
		// 保留退出码，即使取消也不丢弃该字段。
		this.exitCode = exitCode;
		// 先按取消决定终态，再判断退出码，三元链从上向下选择。
		this.status = cancelled
			? // 取消优先，避免把取消后的信号/非零退出当普通错误。
				"cancelled"
			: // 明确非零且非空才 error；null 检查沿用原表达式，TS 形参本身不允许 null。
				exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? // 非零明确退出码显示错误状态。
					"error"
				: // 0 或缺码都归 complete，语义只是本组件的展示分支。
					"complete";
		// 保存上游截断对象引用，不重新读取磁盘全文。
		this.truncationResult = truncationResult;
		// 保存路径文字，无路径时可能不显示截断说明。
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		// 清掉动画计时器，不取消命令进程；业务已结束由宿主决定。
		this.loader.stop();

		// 按当前累积输出和状态重建显示；本方法不直接 requestRender，宿主事件与 Loader 负责请求。
		this.updateDisplay();
	}

	// 用全部收到的清理输出计算尾部显示预算，再按展开状态排正文/运行提示或终态提示。
	// 例 3000 行先受 2000 行/50KiB 预算裁尾，折叠再取末 20 行并按渲染宽度裁 20 个视觉行。
	// 仅重建孩子/闭包缓存，不缩小 outputLines，不在此截断持久会话或模型消息，也不打开日志；同步格式化错误传播。
	private updateDisplay(): void {
		// Apply truncation for LLM context limits (same limits as bash tool)
		// 每次把累计数组全部拼成字符串；名字 fullOutput 指收到的清理文本，不保证是磁盘/原始进程的完整字节。
		const fullOutput = this.outputLines.join("\n");
		// 复用工具层的本地尾部裁剪规则；这里的调用只决定界面可显示内容。
		const contextTruncation = truncateTail(fullOutput, {
			// 默认逻辑行上限 2000，末尾换行的计数规则由 helper 决定。
			maxLines: DEFAULT_MAX_LINES,
			// 默认 50×1024 UTF-8 字节上限；超长末行可只保留尾部完整字符片段。
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// Get the lines to potentially display (after context truncation)
		// 裁后正文非空才按 LF 拆分，空正文没有显示行；未裁时原末尾 LF 仍可能产生末尾空元素。
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// Apply preview truncation based on expanded state
		// 负下标从末尾取至多 20 个逻辑行，不直接按屏幕折行计数。
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		// 只计这层逻辑行预览隐藏数；窄屏再隐藏的视觉行不计入这个提示数字。
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		// 替换边框中的旧内容，Loader 实例仍在字段中复用，不在这里 stop 它。
		this.contentContainer.clear();

		// Command header
		// 命令加 $ 前缀/粗体/主题色，水平用设置、垂直 0；纯显示不执行插入文字。
		const header = new Text(theme.fg(this.colorKey, theme.bold(`$ ${this.command}`)), this.outputPad, 0);
		// 标题始终保留，哪怕还没有任何输出。
		this.contentContainer.addChild(header);

		// Output
		// 没有裁后显示行就跳过正文部分，仍显示运行/终态信息。
		if (availableLines.length > 0) {
			// 展开显示第一层裁剪后全部行，不恢复已超共享预算的更早输出。
			if (this.expanded) {
				// Show all lines
				// 逐逻辑行套弱化色，保持换行与原先顺序。
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				// 正文前加一个 LF 作为标题后的视觉分隔，再由 Text 按父宽排版。
				this.contentContainer.addChild(new Text(`\n${displayText}`, this.outputPad, 0));
			} else {
				// Use shared visual truncation utility with width-aware caching
				// 折叠只先着色尾部 20 个逻辑行，而非整个大输出。
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				// 包含标题后的分隔空行；它也进入接下来的视觉行预算。
				const styledInput = `\n${styledOutput}`;
				// 本次重建新建的闭包缓存宽度，未渲染时 undefined。
				let cachedWidth: number | undefined;
				// 本次预览的渲染行数组；每次 updateDisplay 重建后会重新开始缓存。
				let cachedLines: string[] | undefined;
				// 直接用对象字面量实现 Component 接口，不必为这个小预览再定义类。
				this.contentContainer.addChild({
					// 预览渲染回调按本次实际列宽返回行，例从 200 列缩到 80 列会重算，不使用构造时列宽。
					render: (width: number) => {
						// 无缓存或宽度改变才重新折行；空数组也是有效缓存。
						if (cachedLines === undefined || cachedWidth !== width) {
							// helper 先完整折行，再保留末 20 个视觉行，默认 keep=end，水平留白也纳入宽度。
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, this.outputPad);
							// 只保存显示行，忽略 helper 额外报告的 skippedCount，因此状态提示并非完整视觉隐藏计数。
							cachedLines = result.visualLines;
							// 成功计算后记录缓存对应宽度。
							cachedWidth = width;
						}
						// 返回缓存数组；?? 在缺失时兜底新空数组。
						return cachedLines ?? [];
					},
					// 预览无参失效回调，只清本闭包缓存，无返回值；例父容器失效后下次 render 重算。
					invalidate: () => {
						// 清旧宽度键。
						cachedWidth = undefined;
						// 清旧结果引用，不修改已返回给其他调用者的数组。
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		// 运行中只附 Loader，此时不展示下面终态说明。
		if (this.status === "running") {
			// 复用同一个已启动动画，避免每次输出片段重建计时器。
			this.contentContainer.addChild(this.loader);
		} else {
			// 结束状态用字符串数组收集可能的多个提示。
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			// 只有逻辑行数超过尾部预览才给展开/折叠提示；长行导致的视觉隐藏可能没有此提示。
			if (hiddenLineCount > 0) {
				// 展开后提示可折叠，不显示具体还有多少隐藏行。
				if (this.expanded) {
					// 把本次展开/折叠提示作为一个状态段保存，后面统一换行。
					statusParts.push(
						// 显示当前可配置折叠快捷键，括号使用弱化色。
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					// 把本次展开/折叠提示作为一个状态段保存，后面统一换行。
					statusParts.push(
						// 折叠提示用逻辑隐藏行数与展开键；此数不包含共享预算裁掉的更早行或窄屏多余折行。
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			// 取消以警告色提示，优先于普通错误码。
			if (this.status === "cancelled") {
				// 只展示取消状态，不在这里发送中止信号。
				statusParts.push(theme.fg("warning", "(cancelled)"));
				// 只有 setComplete 判为 error 时展示退出码。
			} else if (this.status === "error") {
				// 将保存的退出码插入红色提示，不解释具体系统信号。
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// Add truncation warning (context truncation, not preview truncation)
			// 上游裁剪或本次第一层显示裁剪任一发生即可；折叠预览不算这一类截断。
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			// 必须既有截断又有非空路径才显示全文说明；不会自动创建缺失日志。
			if (wasTruncated && this.fullOutputPath) {
				// 展示上游给的日志路径，不读取/验证文件，也不因为展开就加载它。
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			// 至少有一个终态提示才加 Text，普通成功短输出不造空提示。
			if (statusParts.length > 0) {
				// 各提示换行并在前面加分隔 LF，水平留白与正文一致。
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, this.outputPad, 0));
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	// 返回累计的清理后输出，供上游需要时组 BashExecutionMessage；例收到 "a\nb" 返回两行，不受界面折叠/裁剪影响。
	// 只读内存并拼字符串，不保留被 stripAnsi 去掉的控制码，也不保证包含上游从未交来的输出。
	getOutput(): string {
		// 按 LF 还原累计分行，不访问 fullOutputPath。
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	// 返回创建时保存的命令文字，无副作用；例构造 "pwd" 后始终返回 "pwd"，不在此执行命令或重新读取编辑器。
	getCommand(): string {
		// 直接返回字段字符串。
		return this.command;
	}
}
