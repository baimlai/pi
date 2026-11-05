/**
 * Presentation for the codemode tool.
 *
 * The call shows the script; the result lists the nested tool calls with their status as they
 * run and the cost of its model calls, followed by the script output without the "Script completed"
 * header, and the time the script has been running (`Elapsed`) or took (`Took`), like bash rows.
 * Nested calls are not separate tool rows because they never reach the model as tool calls.
 */

// 只负责终端里 codemode 调用/结果的显示，不执行脚本。调用视图显示代码，结果视图展示嵌套调用进度、费用、输出及耗时。
// 例：脚本并行读2个文件，这里同一工具行下显示两条 read 状态；结果只截展示预览，展开不重新执行工具。
// Container 拼组件，Text 负责普通文字布局；中文注释保留实际控制字符串与原显示符号。
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
// ToolDefinition 只用于 renderer 签名类型。
import type { ToolDefinition } from "../../core/extensions/types.ts";
// 复用计时、输出文字提取、tab替换及字符串边界检查，避免显示层各自实现执行逻辑。
import { getTextOutput, replaceTabs, startToolTimer, str, toolTimerText } from "../../core/tools/render-utils.ts";
// keyHint 读取可配置按键名称，不硬编码快捷键。
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
// VisualLinePreview 按终端自动折行后的视觉行数折叠，不是简单 split 换行后数行。
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
// 高亮器存每行状态，主题负责文字样式；类型 Theme 不产生运行时值。
import { CodeHighlighter, type Theme } from "../../modes/interactive/theme/theme.ts";
// 嵌套调用/工具详情类型来自工具定义，运行结果由 execute.ts 更新。
import type { CodemodeNestedCall, CodemodeToolDetails } from "./tool.ts";

// 脚本折叠预览最多10视觉行。
const CODE_PREVIEW_LINES = 10;
// 嵌套调用折叠时只展示最近8条，展开才全部展示。
const CALL_PREVIEW_COUNT = 8;
// 输出折叠最多5视觉行。
const OUTPUT_PREVIEW_LINES = 5;
// 参数预览按UTF-16字符串length截80个代码单元，不是终端显示列或token。
const COLLAPSED_ARGS_CHARS = 80;
// 只识别整个第一文本块恰好是执行器头部；无m的$要求匹配到实际字符串末尾，模式自己已包括最后LF。
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

/** Renderer state of a codemode row. */
// 界面行的持久渲染状态；这是类型，不创建实例。
interface CodemodeRenderState {
	// Progress, timer ticks and expanding redraw the call, so the row keeps the script's highlighting.
	// 可选高亮器在第一次需要代码高亮时创建，后续进度/展开重绘复用。
	scriptHighlighter?: CodeHighlighter;
}

// 生成隐藏数量+展开快捷键提示，只返回带样式文字，不改变展开状态。例 hidden=3,noun="lines" 表示还有3行。
function expandHint(theme: Theme, hidden: number, noun: string): string {
	// 模板嵌套主题函数拼接样式；真正按键动作由宿主处理。
	return `${theme.fg("muted", `... (${hidden} more ${noun},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

// 把可选毫秒数转为简短显示；例如42→42ms、1500→1.5s，没给则空串，不在此校验有限数/非负。
function formatDuration(ms: number | undefined): string {
	// 严格undefined才视为没有时间。
	if (ms === undefined) return "";
	// 小于1000取四舍五入整数，否则秒数固定一位小数。
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Cents for larger amounts, two significant digits for the fractions of a cent classifier calls cost. */
// 费用单位始终USD：>=0.01显示2位小数，更小值取2位有效数字。例0.000012936→$0.000013；不是把美元转成“分”。
function formatCost(cost: number): string {
	// toFixed 与 toPrecision 的位数语义不同；这里只格式化，不从真实账单查询价格。
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

// 按嵌套调用标签选图标/颜色，联合类型使四个分支覆盖当前定义，不据图标触发业务。
function statusIcon(call: CodemodeNestedCall, theme: Theme): string {
	// switch 对状态字面量分派。
	switch (call.status) {
		// 运行中显示等待符号。
		case "running":
			return theme.fg("warning", "…");
		// 成功标记。
		case "ok":
			return theme.fg("success", "✓");
		// 错误标记。
		case "error":
			return theme.fg("error", "✗");
		// 取消标记只表达记录状态，不证明远端副作用已回滚。
		case "cancelled":
			return theme.fg("muted", "⊘");
	}
}

// 把一条调用记录转成显示行；折叠截参数，展开才附错误详情，不读取工具原始完整参数。
function formatCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean): string {
	// 折叠且args超过80代码单元才裁前缀；展开仍只拿记录中已有的预览（执行器最多保存200），不是恢复原始输入。
	const args =
		!expanded && call.args.length > COLLAPSED_ARGS_CHARS
			? `${call.args.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
			: call.args;
	// 调用耗时来自记录，运行中可能还没有。
	const duration = formatDuration(call.durationMs);
	// 先拼状态和工具名，再按有无内容追加参数/耗时/费用。
	let line = `${statusIcon(call, theme)} ${theme.fg("toolTitle", call.name)}`;
	// 非空参数才显示。
	if (args) line += ` ${theme.fg("muted", args)}`;
	// 时间文字非空才追加。
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	// truthy费用才显示，0会省略，未做货币区间检查。
	if (call.cost) line += ` ${theme.fg("dim", formatCost(call.cost))}`;
	// 展开且存在错误时按行缩进；错误在执行器已截预览，这里不会自动从文件读取完整异常。
	if (expanded && call.error) line += `\n    ${theme.fg("error", call.error.split("\n").join("\n    "))}`;
	// 返回带ANSI样式的字符串。
	return line;
}

/** 两个展示回调供宿主绑定；Pick只挑renderCall/renderResult，ToolDefinition的两个泛型分别描述参数schema和结果详情。 */
export const codemodeRenderers: Pick<
	ToolDefinition<any, CodemodeToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	/** 渲染调用：启动UI计时 → 校验code形状 → 复用容器/高亮缓存 → 按展开状态显示全部或10视觉行。 */
	renderCall(args, theme, context) {
		// 只启动显示计时，不会调用执行器。
		startToolTimer(context);
		// The code includes the `// @options:` line, so options show as part of the script.
		// as只帮助TS取未知code；str把字符串原样返回、null/undefined归空串，其他类型才返回null。
		const code = str((args as { code?: unknown } | undefined)?.code);
		// 工具名用标题样式加粗。
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		// 优先复用宿主传回的lastComponent；??不把合法空对象当缺失。
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		// 重绘先移除旧子组件，避免进度更新重复堆叠。
		component.clear();
		// null表示str判定为其他非法类型；缺code或null code被归为空串，同空字符串一样只显示标题。
		if (code === null) {
			// 添加无效参数提示，仍不抛错阻塞界面。
			component.addChild(new Text(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
			// 错误展示立即返回。
			return component;
		}
		// 有效形状先放工具标题。
		component.addChild(new Text(title, 0, 0));
		// 非空脚本文字才做高亮/预览。
		if (code) {
			// 将宿主持久state按本renderer状态类型使用，断言不在运行时验证。
			const state = context.state as CodemodeRenderState;
			// ??=只有没实例时创建，后续重绘重复使用。
			state.scriptHighlighter ??= new CodeHighlighter();
			// 高亮输入先去所有CR与末尾空白、再把tab替换为显示空格；不会改实际执行的脚本。
			const highlighted = state.scriptHighlighter
				.highlight(replaceTabs(code.replace(/\r/g, "").trimEnd()), "javascript")
				.join("\n");
			// 选择展示组件加到复用容器。
			component.addChild(
				// 展开标志来自宿主，renderer不自行翻转。
				context.expanded
					? // 展开显示完整高亮结果，但仍受宿主布局处理。
						new Text(highlighted, 0, 0)
					: // 折叠按视觉行裁剪，适合很长的单行代码。
						new VisualLinePreview({
							// 源文本是已高亮内容。
							text: highlighted,
							// 限制10视觉行。
							maxVisualLines: CODE_PREVIEW_LINES,
							// 保留开头，省略后面。
							keep: "start",
							// 回调接收隐藏行数，在实际宽度已知时生成提示。
							formatHint: (hidden) => expandHint(theme, hidden, "lines"),
						}),
			);
		}
		// 返回组件，真正绘到终端由TUI完成。
		return component;
	},
	/** 渲染结果：嵌套调用/总费用 → 结束后输出 → 耗时；partial进度阶段不重复渲染最终正文。 */
	renderResult(result, options, theme, context) {
		// 运行中取Elapsed，结束取Took，复用工具计时辅助。
		const timerText = toolTimerText(context, options.isPartial);
		// 与调用展示一样优先复用容器。
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		// 清旧子组件后重建这一帧。
		component.clear();
		// 没有details/calls时用空数组，不凭空产生嵌套调用。
		const calls = result.details?.calls ?? [];
		// 有嵌套调用才显示这部分。
		if (calls.length > 0) {
			// 折叠取末8条，展开沿用全表。
			const shown = options.expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT);
			// 每条按当前主题和展开状态格式化。
			const lines = shown.map((call) => formatCall(call, theme, options.expanded));
			// 确实省略了前面的调用才插说明。
			if (shown.length < calls.length) {
				// unshift把省略提示放到最近调用列表前。
				lines.unshift(
					`${theme.fg("muted", `... (${calls.length - shown.length} earlier calls,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				);
			}
			// Collapsed rows hide earlier calls, so the total covers every call.
			// 费用汇总取所有调用，不只屏幕上保留的8条；cost=0不加入priced，字段存在不等于truthy。
			const priced = calls.filter((call) => call.cost);
			// 超过1条有价调用才另显示合计，单条费用在它自己那行。
			if (priced.length > 1) {
				// reduce 从0累加每条cost，??缺失取0。
				const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
				// USD显示舍入可能让很小合计精度减少，不是修改实际usage。
				lines.push(theme.fg("muted", `Model calls: ${formatCost(total)}`));
			}
			// 留一行空白分隔标题与调用表。
			component.addChild(new Spacer(1));
			// 多条调用join成一块Text。
			component.addChild(new Text(lines.join("\n"), 0, 0));
		}

		// Drop the "Script completed\nWall time ...\nOutput:\n" header. Rejected input (invalid options)
		// has no header.
		// 数组解构取第一个content和剩下的数组；不会修改result.content。
		const [first, ...rest] = result.content;
		// 只有第一块为文字且整块符合头部模式才去掉；用户输出长得像头部但不是首块不会因此被裁。
		const hasHeader = first?.type === "text" && SCRIPT_HEADER.test(first.text);
		// 进度更新暂不显示正文，避免未结束输出反复重绘。
		const output = options.isPartial
			? ""
			: // 有头部则只提取rest，否则原内容；getTextOutput会按showImages处理图像占位，trim仅影响显示。
				getTextOutput({ ...result, content: hasHeader ? rest : result.content }, context.showImages).trim();
		// 非空正文才生成输出组件。
		if (output) {
			// 按宿主isError统一选择正文色，而不是从文本里猜错误。
			const color = context.isError ? "error" : "toolOutput";
			// 替换tab再逐行套样式，保持每行颜色边界。
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			// 调用表与输出之间空一行。
			component.addChild(new Spacer(1));
			// 展开显示全部已交给renderer的正文，执行器层可能早已截断它。
			if (options.expanded) {
				// Text负责普通折行。
				component.addChild(new Text(styled, 0, 0));
			} else {
				// Limit wrapped lines, not logical ones: script output is often one long JSON line.
				component.addChild(
					// 折叠保留5视觉行，长JSON单行也会折出多行计算。
					new VisualLinePreview({
						// 输入是已套正文颜色的文本。
						text: styled,
						// 5行上限。
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						// 保留开头而非结尾。
						keep: "start",
						// 隐藏行提示使用可配置展开按键。
						formatHint: (hidden) => expandHint(theme, hidden, "lines"),
					}),
				);
				// The collapsed preview hides the truncation notice at the end, so name the file here.
				// 从details取执行器保存的全文路径，不自行写文件。
				const fullOutputPath = result.details?.fullOutputPath;
				// 折叠可能把尾部保存说明裁掉，故额外显示路径；未附路径就不加。
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
		}
		// 有计时文字才显示最终的计时区域。
		if (timerText) {
			// 计时前空一行。
			component.addChild(new Spacer(1));
			// 添加耗时文字，只影响展示。
			component.addChild(new Text(theme.fg("muted", timerText), 0, 0));
		}
		// 返回这一帧组件。
		return component;
	},
};
