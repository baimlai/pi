// ls目录列表的展示模块；执行器提供既有结果，本文件生成调用标题/结果组件，不读取目录或执行ls。
/**
 * Presentation for the ls tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `ls.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

// 实际Text组件负责折行与缓存。
import { Text } from "@earendil-works/pi-tui";
// 从宿主配置生成工具展开键提示。
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
// 主题接口纯类型，运行时主题由回调传入。
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
// 工具定义/结果显示选项类型，编译后擦除。
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
// ls数量/输出裁剪详情类型，不引入执行器运行值。
import type { LsToolDetails } from "../ls.ts";
// 提取安全正文、显示路径链接和未知参数规范化的公共辅助。
import { getTextOutput, renderToolPath, str } from "../render-utils.ts";
// 裁剪字节预算显示后备及大小格式化。
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

// 拼ls调用标题，输入可缺参数、主题和cwd，返回ANSI文字，不读目录。
// 例如没传path显示点号并链接到cwd，limit:10追加限制；非字符串路径显示错误占位，不以点号掩盖非法类型。
function formatLsCall(args: { path?: string; limit?: number } | undefined, theme: Theme, cwd: string): string {
	// 读取可选限制，只展示不执行合法性校验。
	const limit = args?.limit;
	// str区分缺省空串与非法null，空串用点号，renderToolPath按cwd构建文件链接且不确认路径存在。
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	// 构造标题名与路径显示。
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${pathDisplay}`;
	// 明确提供limit时才展示，包括0。
	if (limit !== undefined) {
		// 追加括号数量提示。
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	// 返回标题字符串。
	return text;
}
// 格式化目录结果，输入内容/详情、展开、主题和图片开关，返回显示正文。
// 先提取文字→折叠取前20逻辑行→隐藏提示→数量/字节限制警告；例：30行折叠提示还有10行。展开仅恢复显示折叠，不恢复执行器已截断结果。
function formatLsResult(
	// 宽松展示结果结构，非执行参数schema。
	result: {
		// 内容块按type带可选文字/图片字段。
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		// 可选条数和裁剪元数据。
		details?: LsToolDetails;
	},
	// expanded决定显示行预算，isPartial在此未单独改变格式。
	options: ToolRenderResultOptions,
	// 当前主题。
	theme: Theme,
	// 图片开关交正文提取器，仍结合终端能力判断占位。
	showImages: boolean,
	// 返回字符串，由外层Text按终端宽度绘制。
): string {
	// 提取清理后的正文/图片占位并trim首尾空白，不改result。
	const output = getTextOutput(result, showImages).trim();
	// 初始化累计显示文本。
	let text = "";
	// 非空正文才生成行预览。
	if (output) {
		// 按换行拆逻辑行，终端长行折行不计入这个20行预算。
		const lines = output.split("\n");
		// 展开全部当前行，折叠最多20行。
		const maxLines = options.expanded ? lines.length : 20;
		// slice得到要显示的新数组。
		const displayLines = lines.slice(0, maxLines);
		// 求剩余行数，少于预算可为负，只有正数才显示提示。
		const remaining = lines.length - maxLines;
		// 行内容着正文色并按换行连接，前置换行和标题分开。
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		// 还有隐藏内容才附提示。
		if (remaining > 0) {
			// 提示隐藏逻辑行数量与当前宿主展开按键。
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	// 读取执行器目录条数上限信息。
	const entryLimit = result.details?.entryLimitReached;
	// 读取执行器整体输出裁剪状态。
	const truncation = result.details?.truncation;
	// 数量上限或输出截断任一满足就展示警告。
	if (entryLimit || truncation?.truncated) {
		// 收集限制原因。
		const warnings: string[] = [];
		// 追加entries上限说明，数字来自详情而非这里重新数目录。
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		// 被裁剪时显示字节预算，详情未给maxBytes则用默认。
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		// 合并为warning色独立行，不改原目录结果。
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	// 返回累计结果字符串。
	return text;
}

// 导出ls的两项显示方法，Pick从工具定义挑选显示槽，不包含execute。
export const lsRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	// 调用渲染回调输入参数/主题/上下文，格式化标题并返回Text，不读目录；例：空path按cwd显示点号。
	renderCall(args, theme, context) {
		// 优先复用调用槽组件，首次才建零留白Text。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 用context.cwd生成路径显示/链接，参数as any不做运行时校验。
		text.setText(formatLsCall(args as any, theme, context.cwd));
		// 返回组件让宿主按宽度绘制。
		return text;
	},
	// 结果渲染回调，输入现有结果和显示上下文，返回Text，仅改变可见行数/警告，不改变执行数据。
	renderResult(result, options, theme, context) {
		// 优先复用上次结果槽Text。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 按展开及图片开关更新结果文字，相同文字由Text保留布局缓存。
		text.setText(formatLsResult(result as any, options, theme, context.showImages));
		// 返回显示组件。
		return text;
	},
};
