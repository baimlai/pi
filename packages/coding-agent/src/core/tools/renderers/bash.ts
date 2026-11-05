// bash/PowerShell 的终端显示，执行器把这两个回调合入工具定义，ToolExecutionComponent/HTML 导出消费它们；显示本身不重新执行命令。
/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

// Container 竖向组合子组件，Spacer 留空行，Text 按宽度折行并缓存；都是实际运行值。
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
// 从宿主可配置按键取得展开提示，不硬编码快捷键。
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
// 按终端宽度计算视觉行的预览组件，长单行自动换行也计入预算。
import { VisualLinePreview } from "../../../modes/interactive/components/visual-truncate.ts";
// 使用当前全局主题值，而下面 _theme 参数保留接口但不使用。
import { theme } from "../../../modes/interactive/theme/theme.ts";
// 工具定义/结果展示选项仅用于类型约束，不加载执行器。
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
// bash 输出裁剪/完整日志路径的详情类型，编译后擦除该导入。
import type { BashToolDetails } from "../bash.ts";
// 复用文字清理、非法参数占位及 UI 行计时；str 区别缺参数空串和错误类型 null。
import { getTextOutput, invalidArgText, startToolTimer, str, toolTimerText } from "../render-utils.ts";
// 输出字节限制的展示后备与易读大小格式函数，不在此裁剪模型收到的工具结果。
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

// 折叠正文保留末尾 5 个视觉行；额外的隐藏行提示/警告/计时不计入这 5 行。
const BASH_PREVIEW_LINES = 5;
// 执行器增量输出的节流预算为100ms；初始空部分通知及最终结果另有发送路径，不能推断所有工具事件强制至少隔100ms。这里仅导出常量，不开启定时器。
export const BASH_UPDATE_THROTTLE_MS = 100;
// 格式化命令调用标题，输入可缺参数及 $/PS> 提示符，返回带主题 ANSI 的文字，无执行副作用。
// 例如 command:"pwd",timeout:5 显示命令和 5s 标记；超时只展示，真正限制由执行器实施。
function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	// str 缺 command 变空串、非字符串变 null，不把数字命令伪装成正常字符串。
	const command = str(args?.command);
	// 断言 timeout 为数字/undefined 不验证运行时值；展示链可能接收尚未完成的参数。
	const timeout = args?.timeout as number | undefined;
	// 只有真值超时才显示后缀，0 不展示；这里使用秒单位，和扩展 exec 的 timeout 毫秒不同。
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	// null 显示非法参数，非空命令照常展示，空/尚未收到用省略号。
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	// 提示符与命令先加粗再着标题色，尾部拼较弱超时文字。
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}
// 重建 shell 结果组件，输入可复用容器/结果/展开设置/图片开关/计时文字，无返回值。
// 先清子组件→清理重复日志脚注→正文（折叠留末5视觉行）→裁剪警告→计时；只修改显示树，原工具结果不变。例：展开可看当前保留的全部输出，不能恢复执行器已裁掉的内容。
function rebuildBashResultRenderComponent(
	// 传入本次结果槽复用的容器。
	component: Container,
	// 结果用宽松展示形状接收内容块和可选详情。
	result: {
		// 块至少有 type，其他字段按文字/图片不同可缺；Array<...> 是泛型数组写法。
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		// 可选裁剪状态/完整日志路径。
		details?: BashToolDetails;
	},
	// 是否展开和是否仍部分输出。
	options: ToolRenderResultOptions,
	// 是否允许展示图片，实际还需看终端能力。
	showImages: boolean,
	// 已有计时文本或 undefined，本函数不创建计时器。
	timerText: string | undefined,
	// 返回 void，效果体现在传入组件子列表。
): void {
	// 清掉旧子组件再建本帧，Container.clear 不清空原工具输出，也不自动释放任意用户资源。
	component.clear();

	// 提取已清 ANSI/控制字符的显示文字并 trim；as any 只放宽 TS，不验证结果。局部 output 可改，原 content 不写回。
	let output = getTextOutput(result as any, showImages).trim();
	// 可选链读取裁剪详情，没详情时 undefined。
	const truncation = result.details?.truncation;
	// 读取执行器保存的完整输出文件路径，只展示不读文件。
	const fullOutputPath = result.details?.fullOutputPath;
	// 最终输出确有裁剪/日志路径且尾部像脚注时才尝试去重；部分结果不删脚注。
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		// 定位最后一个空行加方括号的候选脚注开头。
		const footerStart = output.lastIndexOf("\n\n[");
		// 候选存在且含同一日志路径才删除；这是文本启发式，非严格脚注格式解析。
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			// 只保留脚注前局部显示正文并去尾部空白，稍后由独立警告统一显示日志信息。
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	// 有非空正文才创建正文子组件。
	if (output) {
		// 准备逐逻辑行加正文颜色。
		const styledOutput = output
			// 按换行拆字符串，尚未做终端宽度折行。
			.split("\n")
			// map 返回每行着色后的字符串，空行也保留。
			.map((line) => theme.fg("toolOutput", line))
			// 用换行恢复正文布局。
			.join("\n");

		// 展开时展示全部当前保留的正文。
		if (options.expanded) {
			// 开头换行留出标题间距，Text 横纵 padding 为 0，由外层工具壳负责留白。
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
			// 折叠时改用受视觉行数限制的组件。
		} else {
			// 在标题/正文间加一空行。
			component.addChild(new Spacer(1));
			// 向结果容器加入预览组件。
			component.addChild(
				// 构造懒按实际宽度折行的 VisualLinePreview，不在此决定终端宽度。
				new VisualLinePreview({
					// 传入已着色的正文。
					text: styledOutput,
					// 最多保留 5 个换行/折行后的视觉行。
					maxVisualLines: BASH_PREVIEW_LINES,
					// 保留末尾，适合命令日志看最近输出。
					keep: "end",
					// 隐藏行提示回调接实际隐藏视觉行数、返回样式文字；渲染预览时才调用，无工具执行副作用。
					formatHint: (hidden) =>
						// 前半段显示早先有多少行被折叠。
						theme.fg("muted", `... (${hidden} earlier lines,`) +
						// 后半段接宿主展开按键和右括号，模板中只拼原有提示文本。
						` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				}),
			);
		}
	}

	// 有裁剪信息或日志文件路径就添加独立警告，即使正文为空也可显示。
	if (truncation?.truncated || fullOutputPath) {
		// 聚合人可读警告的字符串数组。
		const warnings: string[] = [];
		// 有完整日志路径就展示位置。
		if (fullOutputPath) {
			// 追加 Full output 说明，不加载那份文件。
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		// 只有真正标 truncated 才补裁剪原因。
		if (truncation?.truncated) {
			// 按行数裁剪与按字节裁剪分别描述。
			if (truncation.truncatedBy === "lines") {
				// 显示当前保留行数/总行数。
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
				// 其他裁剪原因按字节上限展示。
			} else {
				// 长警告字符串单独追加到数组。
				warnings.push(
					// 使用详情 maxBytes，未提供时回退执行器默认字节上限，再 formatSize 转易读单位。
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		// 合并警告句，用 warning 色单独一行展示。
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	// 有计时文字才在末尾加弱化样式的一行；不在此计算耗时。
	if (timerText) component.addChild(new Text(`\n${theme.fg("muted", timerText)}`, 0, 0));
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
// 创建共享 shell 显示方法，输入提示符，返回仅含 renderCall/renderResult 的对象；闭包保存 prompt，不运行两回调。
// 例如 bash 用 "$"、PowerShell 用 "PS>"；Pick 只挑定义的两个显示槽，any 放宽不同 shell 参数/详情类型。
export function createShellRenderers(prompt: string): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	// 返回两个供宿主后续调用的渲染方法。
	return {
		// 调用展示回调输入参数、未使用主题和本工具行 context，返回可复用 Text；例：参数流到来后把标题从省略号更新为命令，不执行命令。
		renderCall(args, _theme, context) {
			// 若 context.executionStarted 且尚无起点，就记录 UI 行开始时间；参数流尚未执行不会启动计时。
			startToolTimer(context);
			// 优先复用本调用槽组件；as 不检查它真是 Text，没有上次组件才新建零留白文本。
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			// 格式化并更新标题；Text.setText 对相同文本保留折行缓存。
			text.setText(formatShellCall(args as { command?: string; timeout?: number } | undefined, prompt));
			// 返回组件供宿主稍后按终端宽度 render。
			return text;
		},
		// 结果展示回调接部分/最终结果、展开选项和行上下文，返回复用 Container；可管理 UI 计时重绘，最终结果自身 durationMs 优先。
		renderResult(result, options, _theme, context) {
			// 生成 Elapsed/Took 计时文本，可能安排/清理每秒 invalidation 定时器；不是重新运行工具。
			const timerText = toolTimerText(context, options.isPartial);
			// 优先复用上次结果槽容器，首次才创建。
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			// 按当前结果、展开/图片状态与计时重新填充该容器。
			rebuildBashResultRenderComponent(component, result as any, options, context.showImages, timerText);
			// 递归使新子组件缓存失效；Container.invalidate 本身不向 TUI 请求绘制，宿主控制绘制时机。
			component.invalidate();
			// 返回结果组件引用，不把显示文本写回会话日志。
			return component;
		},
	};
}
