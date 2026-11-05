// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./border-status-editor.ts` 加载。
// 演示内容：继承 CustomEditor，替换编辑器上下边框，在边框中显示旋转指示器、模型、思考档位、上下文占用、cwd 和 git 分支；同时隐藏内置 footer 和工作行。
// 上下游：session_start 时通过 ctx.ui.setFooter/setWorkingVisible/setEditorComponent 安装 UI；pi.on("agent_start"/"agent_settled") 控制 80ms 定时器；pi.exec 调用 git branch 读取分支。渲染由 TUI 在每帧调用 BorderStatusEditor.render(width)。
// 能力清单：
// - fitBorder(left,right,width,border,fill=border)：把左右文字放入宽度固定的单行边框，必要时从右侧、再左侧逐列截断。
// - formatCwd(cwd)：把 HOME 前缀替换成 `~`（纯字符串前缀，不做路径边界判断）。
// - formatContext(ctx)：生成 `ctx 42%/200k` 或 `ctx ?`。
// - formatThinking(level)：当前实现是恒等函数，原样返回档位字符串；off 分支没有额外文案。
// - EmptyFooter：实现 Component，render 返回空数组，用于隐藏内置页脚。
// - 默认导出 (pi: ExtensionAPI) => void：注册事件、构造并安装编辑器组件。
// - BorderStatusEditor：继承 CustomEditor，super.render(width) 后替换首尾边框行。
// 典型运行顺序：加载 -> session_start 安装空 footer/编辑器并异步取分支 -> agent_start 启动 spinner -> 每帧 render 读状态 -> agent_settled 停止 spinner -> session_shutdown 清理定时器和 activeTui。
// 示例（真实签名）：
//   pi -e ./examples/extensions/border-status-editor.ts
//   // 顶部边框显示 `⠋`，底部显示 ` anthropic/claude-sonnet-4 · high ` 与 ` ctx 12%/200k · /repo (main) `
// 阅读顺序：先看 fitBorder 的宽度算法，再看格式化辅助和 EmptyFooter，最后看 session_start 里的类与事件状态。
// 前置与副作用：仅在交互式 TUI 中能真正显示；会持续创建 80ms 定时器直到 agent_settled/session_shutdown，定时器期间可能阻止进程退出（已由 shutdown 清理）。git branch 只读，不修改仓库；cwd/分支只在 session_start 读取一次，切换分支不会自动刷新。
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// 把左右标签拼成一行边框：总宽固定为 width，两端各一个 `─`，中间用 fill 填充；left/right 已经带好主题转义。
// 输入是字符串和宽度，返回字符串；无 I/O。width<=0 返回空串，width===1 只返回一个边框字符。
// 示例：fitBorder("A","B",10,border) -> "─A──────B─"（宽度按可见列计算，不受 ANSI 转义影响）。
function fitBorder(
	left: string,
	right: string,
	width: number,
	// border 给两端和填充上色；fill 是可选的独立填充函数，默认复用 border（默认参数在调用时求值）。
	border: (text: string) => string,
	fill: (text: string) => string = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	// 两个端点的固定宽度；minimumGap 是正常情况下尽量保留的 3 列填充，极窄宽度下实际填充可能更少。
	const fixedWidth = 2;
	const minimumGap = 3;

	// 先收缩右侧：只要总宽超出且右标签还有可见宽度，就每次少 1 列。truncateToWidth 处理 ANSI 转义，不会把颜色码截断。
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	// 右侧缩到空后仍超宽，再从左侧收缩；两个循环保证不会无限循环，因为 visibleWidth>0 的文本每次至少减少 1 列。
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	// 计算剩余填充列数；Math.max 防止负数。正常路径下最终长度等于 width：2 个端点 + left + gap + right。
	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

// 把绝对 cwd 中开头的 HOME 换成 `~`，便于在窄边框中显示；返回字符串，不修改进程环境。
// 示例：HOME=/Users/ada，cwd=/Users/ada/project -> "~/project"。
function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	// startsWith 只是字符串前缀比较，不检查分隔符；HOME=/home/a 时 /home/abc 也会变成 "~bc"（示例的已知简化）。
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

// 读取当前上下文占用并格式化为短标签；usage 不存在、percent 为 null 或窗口未知时显示 "ctx ?"。
function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	// 先取 usage 的 contextWindow，缺失时回退到当前模型的 contextWindow；?. 和 ?? 只处理 null/undefined，0 会被后续 !contextWindow 当成未知。
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	// percent 的类型是 number | null；null 表示无法估算（例如刚压缩完），不是 0%。
	if (!contextWindow || !usage || usage.percent === null) {
		return "ctx ?";
	}
	// Math.round 取整百分比；contextWindow/1000 再 toFixed(0) 得到 200000 -> "200k"，小数窗口会被四舍五入。
	return `ctx ${Math.round(usage.percent)}%/${(contextWindow / 1000).toFixed(0)}k`;
}

// 当前实现对任何档位都返回原字符串（"off" 分支与 else 结果相同）；保留函数是为了将来可自定义显示。
function formatThinking(level: string): string {
	return level === "off" ? "off" : level;
}

// 实现 pi-tui 的 Component：render 返回空行数组，invalidate 为空操作。把它设为 footer 后，内置页脚内容不再绘制。
class EmptyFooter implements Component {
	// render 不接收宽度参数，因为本组件不画任何内容；返回新空数组，避免调用方修改共享状态。
	render(): string[] {
		return [];
	}

	// 没有缓存需要失效；保留空实现以满足 Component 接口。
	invalidate(): void {}
}

// 扩展入口：初始化扩展级可变状态并注册四个生命周期回调；加载时不读 Git、不启动定时器。
export default function (pi: ExtensionAPI) {
	// 这些变量属于本次扩展实例；session_start 可能创建新编辑器类，但状态在实例内共享。
	let isWorking = false;
	let spinnerIndex = 0;
	// ReturnType<typeof setInterval> 在 Node 类型环境下是 NodeJS.Timeout，在 DOM 类型环境下是 number；用 ReturnType 避免写死平台类型。
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	// Braille spinner 帧；每帧一个字符，索引在 80ms 定时器中循环。
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

	// 停止并清空定时器；重复调用安全。清理后 spinnerIndex 不重置，下次动画从当前帧继续。
	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	// agent_start 表示底层 Agent 循环开始（之后可能自动重试）；这里启动 spinner。stopSpinner 先清理可能残留的旧定时器。
	pi.on("agent_start", () => {
		isWorking = true;
		stopSpinner();
		// 80ms 约 12.5fps；每次只修改索引并请求重画，不在定时器中读取 Git 或模型状态。
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			// activeTui 可能尚未由编辑器构造赋值，?. 使首次 agent_start 不抛错。
			activeTui?.requestRender();
		}, 80);
		activeTui?.requestRender();
	});

	// agent_settled 是最终空闲信号，不同于 agent_end（可能还会重试/继续）；这里才停止 spinner。
	pi.on("agent_settled", () => {
		isWorking = false;
		stopSpinner();
		activeTui?.requestRender();
	});

	// 会话关闭/替换时清理定时器并释放 TUI 引用；否则旧定时器可能继续持有旧 UI。
	pi.on("session_shutdown", () => {
		stopSpinner();
		activeTui = undefined;
	});

	// 每个新会话安装 UI：隐藏内置工作行和页脚，让状态只画在编辑器边框上。非 TUI 模式下这些方法可能无效或显示占位。
	pi.on("session_start", (_event, ctx) => {
		// 隐藏内置流式工作行；不改变 Agent 是否在工作，只改显示。
		ctx.ui.setWorkingVisible(false);
		// setFooter 的工厂返回空组件；传 undefined 才能恢复内置页脚，这里没有提供恢复命令。
		ctx.ui.setFooter(() => new EmptyFooter());

		// 分支名缓存；git 不可用或不在仓库时为 undefined。
		let branch: string | undefined;

		// 异步读取当前分支；.catch(() => undefined) 把进程启动失败也转成 undefined，随后统一走可选链。
		const refreshBranch = async () => {
			// 显式传 cwd 给 git，避免依赖进程当前目录；branch --show-current 只输出分支名，detached HEAD 时输出空行。
			const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd }).catch(() => undefined);
			// stdout 已由 ExecResult 解码为字符串；trim 去掉换行，空串表示没有分支名。
			const stdout = result?.stdout.trim();
			// 只有非空才赋值，否则保持 undefined；三元表达式同时处理空字符串。
			branch = stdout && stdout.length > 0 ? stdout : undefined;
			// 分支读取完成后请求重画；若编辑器尚未创建，activeTui 仍为 undefined。
			activeTui?.requestRender();
		};
		// void 明确表示不等待这个 Promise；错误已在 refreshBranch 内 catch，不会成为未处理拒绝。
		void refreshBranch();

		// 每次 session_start 都定义一个新的子类；CustomEditor 的构造函数签名是 (tui, theme, keybindings, options?)，这里通过 options 把水平内边距设为 0。
		class BorderStatusEditor extends CustomEditor {
			// 构造函数参数由 EditorFactory 提供；EditorTheme 控制边框/补全颜色，KeybindingsManager 提供应用快捷键。
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				// super 必须在使用 this 前调用；paddingX:0 让边框贴住终端宽度，便于 fitBorder 精确画满整行。
				super(tui, theme, keybindings, { paddingX: 0 });
				// 保存当前 TUI 供事件回调请求重画；后创建的编辑器会覆盖这个引用。
				activeTui = tui;
			}

			// 先让父类绘制编辑器内容和默认边框，再替换首行和末行；中间行原样保留。
			render(width: number): string[] {
				const lines = super.render(width);
				// 少于两行说明没有上下边框可替换，直接返回，避免访问 lines[0]/最后一行越界。
				if (lines.length < 2) return lines;

				// 主题从会话上下文读取；ctx 是 session_start 捕获的实例，会话替换后旧编辑器可能被替换。
				const thm = ctx.ui.theme;
				// provider/id 组成模型标识；ctx.model 为 undefined 时显示 "no model"。
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
				// getThinkingLevel 返回当前档位字符串，不触发模型请求。
				const thinking = pi.getThinkingLevel();
				// 工作时在左上角画 spinner；空格包裹让字符不贴边。非工作时 topLeft 为空串。
				const topLeft = isWorking ? thm.fg("accent", ` ${spinnerFrames[spinnerIndex]} `) : "";
				// 右上角固定留空；fitBorder 仍然需要左右两个标签参数。
				const topRight = "";
				// 左下角显示模型和思考档位，muted 色降低视觉权重。
				const bottomLeft = thm.fg("muted", ` ${model} · ${formatThinking(thinking)} `);
				// 右下角显示上下文、cwd 与分支；分支存在时在括号中追加，否则只显示 cwd。
				const bottomRight = thm.fg(
					"muted",
					` ${formatContext(ctx)} · ${formatCwd(ctx.cwd)}${branch ? ` (${branch})` : ""} `,
				);
				// 把 this.borderColor 包成函数，保持子类/主题覆盖后的边框着色；borderColor 是 Editor 的公开可变字段。
				const borderColor = (text: string) => this.borderColor(text);

				// 替换顶部边框；传入的是已经上色的字符串，fitBorder 只按可见宽度计算。
				lines[0] = fitBorder(topLeft, topRight, width, borderColor);
				// 替换底部边框；中间行（编辑器正文）保持父类渲染结果，不重新计算。
				lines[lines.length - 1] = fitBorder(bottomLeft, bottomRight, width, borderColor);
				return lines;
			}
		}

		// 安装编辑器工厂；undefined 会恢复默认编辑器。工厂每次需要编辑器时调用，可创建多个实例。
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BorderStatusEditor(tui, theme, keybindings));
	});
}
