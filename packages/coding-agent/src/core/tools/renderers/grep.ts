// grep 内容搜索的调用/结果展示；上游执行器提供内容和裁剪详情，宿主渲染组件/HTML使用本对象，不在此运行rg。
/**
 * Presentation for the grep tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `grep.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

// Text以终端宽度折行并缓存文字布局。
import { Text } from "@earendil-works/pi-tui";
// 宿主可配置工具展开键的显示提示。
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
// 回调主题类型，不在导入时创建主题。
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
// 工具定义与部分/展开选项类型导入，编译后不拉入执行链。
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
// grep结果详情类型，包含匹配上限/字节裁剪/长行裁剪标记。
import type { GrepToolDetails } from "../grep.ts";
// 共用正文清理、非法参数占位、路径缩短及str辅助。
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
// 字节限制展示后备和易读大小格式化。
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

// 拼grep标题，输入可缺参数和主题，返回ANSI文字，无搜索副作用。
// 例：pattern:"TODO",path:"src",glob:"*.ts",limit:10 显示搜索表达式、目录、筛选和限制；斜线只是展示装饰，不在此编译正则。
function formatGrepCall(
	// 可选整体参数中模式必填但流式时整体可undefined；路径/glob/limit可缺，运行时展示仍经str区分错误类型。
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	// 当前主题对象。
	theme: Theme,
	// 返回字符串而非TUI组件，外层renderCall负责放Text。
): string {
	// 模式未给变空串，错误类型变null。
	const pattern = str(args?.pattern);
	// 读取原路径并做显示类型规范。
	const rawPath = str(args?.path);
	// 合法空路径显示点号，非法null保留，主目录可缩为~。
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	// glob同样经str；非法null与空串在后面都不展示，不生成独立glob错误提示。
	const glob = str(args?.glob);
	// 取数量限制，不在此校验数值。
	const limit = args?.limit;
	// 取得可复用非法参数文字。
	const invalidArg = invalidArgText(theme);
	// 开始拼工具标题。
	let text =
		// grep名加粗并着标题色。
		theme.fg("toolTitle", theme.bold("grep")) +
		// 名称后留一个空格。
		" " +
		// 合法模式包斜线着accent，非法模式显示占位；不会据此改变搜索参数。
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		// 追加in目录说明，非法路径用占位。
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	// glob为非空字符串才追加括号说明。
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	// limit明确提供才追加，0也显示，不代表执行器接受0。
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	// 返回标题字符串。
	return text;
}
// 格式化已有grep结果，接内容/详情及展开/主题/图片开关，返回ANSI正文，不执行搜索。
// 折叠保留前15逻辑行，展开显示全部当前结果，再区分匹配上限、总输出裁剪和单行裁剪。例：20行折叠提示剩5行；展开不还原执行时被裁掉的长行。
function formatGrepResult(
	// 宽松展示结果结构。
	result: {
		// 内容块可能为文字/图片，字段按块类型可缺。
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		// 可选grep执行元数据。
		details?: GrepToolDetails;
	},
	// expanded控制预览长度；isPartial此函数未单独分支处理。
	options: ToolRenderResultOptions,
	// 当前主题。
	theme: Theme,
	// 图片展示开关，正文提取还需结合终端能力。
	showImages: boolean,
	// 返回显示字符串。
): string {
	// 正文提取清理控制字符/ANSI，必要时补图片占位，再trim首尾空白。
	const output = getTextOutput(result, showImages).trim();
	// 从空字符串累计，可只有警告。
	let text = "";
	// 有正文才处理行预览。
	if (output) {
		// 按换行拆逻辑行，不等于终端自动折行后的视觉行。
		const lines = output.split("\n");
		// 展开全部，折叠最多15逻辑行。
		const maxLines = options.expanded ? lines.length : 15;
		// slice取显示部分，不修改原数组/结果。
		const displayLines = lines.slice(0, maxLines);
		// 计算超出预算的行数，后面仅>0显示提示。
		const remaining = lines.length - maxLines;
		// 逐行套toolOutput颜色并接到新行，宿主Text随后才按宽度布局。
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		// 有隐藏行才补展开提示。
		if (remaining > 0) {
			// 提示更多逻辑行数与宿主实际展开键，模板内容保持显示协议。
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	// 匹配数量上限标记/上限数。
	const matchLimit = result.details?.matchLimitReached;
	// 整体输出裁剪信息。
	const truncation = result.details?.truncation;
	// 是否有单条匹配行被裁短，与整个结果条数上限不同。
	const linesTruncated = result.details?.linesTruncated;
	// 三个限制任一真值即展示warning。
	if (matchLimit || truncation?.truncated || linesTruncated) {
		// 收集可并存的限制原因。
		const warnings: string[] = [];
		// 记录匹配数量上限。
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		// 记录输出字节预算，没给具体maxBytes用公共默认。
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		// 单行裁剪单独提示，不假装expand能恢复原行。
		if (linesTruncated) warnings.push("some lines truncated");
		// 把所有限制用逗号连接成warning色说明。
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	// 返回正文和各类显示提示。
	return text;
}

// 导出调用/结果两个渲染槽；Pick只挑方法类型，不运行工具。
export const grepRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	// 调用展示回调，输入参数/主题/上下文，更新并返回Text；例如参数流变化只刷新标题，不搜索。
	renderCall(args, theme, context) {
		// 复用当前调用槽组件，首次新建0留白Text；as不做运行时类检查。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 格式化标题后更新文字，参数断言只放宽类型。
		text.setText(formatGrepCall(args as any, theme));
		// 返回给宿主继续render。
		return text;
	},
	// 结果展示回调输入已有结果、展开/主题/context，返回Text；只改变显示，不修改持久结果或调用rg。
	renderResult(result, options, theme, context) {
		// 复用结果槽Text，首次才创建。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 按展开与图片开关格式化正文，Text.setText相同文字时保留缓存。
		text.setText(formatGrepResult(result as any, options, theme, context.showImages));
		// 交回显示组件引用。
		return text;
	},
};
