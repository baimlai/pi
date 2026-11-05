// find 的调用/结果显示，工具执行器合入定义，交互组件或导出调用；仅格式化已有结果，不扫描磁盘。
/**
 * Presentation for the find tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `find.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

// Text 负责按实际宽度折行及缓存，渲染回调返回组件而非终端字符串数组。
import { Text } from "@earendil-works/pi-tui";
// 可配置的工具展开快捷键提示。
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
// 主题纯类型，运行主题从回调参数传入。
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
// 工具定义与显示选项纯类型，编译后擦除，不加载工具执行链。
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
// find 的结果数量与输出裁剪详情类型。
import type { FindToolDetails } from "../find.ts";
// 正文提取/非法占位/主目录路径缩短/未知参数转字符串等显示辅助。
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
// 字节限制后备及格式化函数，此处只展示限制。
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

// 构造 find 标题，输入可缺参数与主题，返回ANSI文字，无搜索副作用。
// 例如 pattern:"*.ts",path:"src",limit:5 显示模式、目录和条数；参数尚未生成完整也能展示，错误类型显示占位，不替代执行schema校验。
function formatFindCall(args: { pattern: string; path?: string; limit?: number } | undefined, theme: Theme): string {
	// 未知显示参数经 str 规范，缺省为空串，非字符串标为 null。
	const pattern = str(args?.pattern);
	// 读取可选搜索目录并区分缺省和非法类型。
	const rawPath = str(args?.path);
	// 合法空目录按点号展示，并把主目录缩为 ~；null 非法标记保留。
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	// 取调用方限制，只显示不校验是否正整数。
	const limit = args?.limit;
	// 提前取得错误色参数占位文字，供模式/路径错误使用。
	const invalidArg = invalidArgText(theme);
	// 开始逐段拼标题文字，let 允许后面追加limit。
	let text =
		// 工具名加粗并着标题色。
		theme.fg("toolTitle", theme.bold("find")) +
		// 工具名和模式间一个空格。
		" " +
		// 非法模式用占位，合法或未完成模式用accent，空串可暂时为空。
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		// 追加 in 目录，非法目录明确显示错误占位。
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	// 只要limit不是undefined就展示，0也显示；这不是执行合法性判断。
	if (limit !== undefined) {
		// 把limit括号说明加到标题末尾。
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	// 返回格式化标题，不写入结果或历史。
	return text;
}
// 格式化 find 结果，输入内容/详情、展开选项、主题与图片开关，返回显示字符串。
// 正文折叠保留前20逻辑行，展开保留全部当前输出，随后补执行器截断说明；例：25行折叠提示还有5行。显示折叠与执行截断是两层，展开不能找回已截断数据。
function formatFindResult(
	// 宽松结果对象用于展示，不在此验证搜索是否成功。
	result: {
		// 内容块数组，按type选择文字/图片，具体字段可缺。
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		// 可选find详情，省略时不展示执行裁剪提示。
		details?: FindToolDetails;
	},
	// 展开状态及部分结果标记，本格式器只用expanded。
	options: ToolRenderResultOptions,
	// 当前主题。
	theme: Theme,
	// 图片展示开关，getTextOutput还结合终端能力决定文字占位。
	showImages: boolean,
	// 返回ANSI显示字符串，无文件或模型写入。
): string {
	// 从结果提取安全正文/图片占位并去首尾空白，保留原content不变。
	const output = getTextOutput(result, showImages).trim();
	// 初始结果文字为空，允许只有裁剪警告而无正文。
	let text = "";
	// 正文非空才计算行预览。
	if (output) {
		// 按换行切逻辑行，一条长行在Text里仍可折成多视觉行。
		const lines = output.split("\n");
		// 展开用全部行，折叠最多20逻辑行。
		const maxLines = options.expanded ? lines.length : 20;
		// slice返回要显示的新外层数组。
		const displayLines = lines.slice(0, maxLines);
		// 总行数减预算，少于20时可能负值，后面仅正数才显示提示。
		const remaining = lines.length - maxLines;
		// 逐行着正文色、以换行拼接，开头换行与调用标题隔开。
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		// 确有隐藏行才追加展开提示。
		if (remaining > 0) {
			// 提示隐藏逻辑行数及宿主展开键；只改UI文字，不改模型工具结果。
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	// 读取执行器因数量预算停止的结果上限，非0才算真值。
	const resultLimit = result.details?.resultLimitReached;
	// 读取执行器输出截断元数据。
	const truncation = result.details?.truncation;
	// 达到结果数量上限或整体输出截断任一满足就补警告；下面没有再按truncatedBy区分行/字节原因，而统一显示字节预算。
	if (resultLimit || truncation?.truncated) {
		// 独立收集多个限制原因。
		const warnings: string[] = [];
		// 有数量上限则展示 results limit，数字是上限信息不是本方法重新计数。
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		// 有输出裁剪就格式化详情字节预算，缺省用默认值。
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		// 合并限制原因成 warning 色截断提示。
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	// 返回累计正文/隐藏提示/截断警告。
	return text;
}

// 导出仅两个显示槽的对象，Pick从工具定义挑字段；any让参数/详情类型在展示层放宽，不是运行时检查。
export const findRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	// 调用渲染回调输入参数/主题/上下文，更新并返回Text，不执行find。例：流式参数更新后标题跟着刷新。
	renderCall(args, theme, context) {
		// 优先复用上次调用槽Text，首次才建零留白组件；as不验证实际类。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 格式化标题并setText；相同文字可复用Text折行缓存。
		text.setText(formatFindCall(args as any, theme));
		// 交回组件，宿主决定终端宽度和外壳。
		return text;
	},
	// 结果渲染回调接已有结果与展示设置，返回Text，正文只做显示折叠；不会重跑搜索或恢复裁掉内容。
	renderResult(result, options, theme, context) {
		// 优先复用上次结果槽的Text组件。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 用展开和图片开关更新结果正文，as any不做schema验证。
		text.setText(formatFindResult(result as any, options, theme, context.showImages));
		// 返回已有/新建组件。
		return text;
	},
};
