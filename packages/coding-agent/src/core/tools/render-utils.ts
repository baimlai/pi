// 工具终端显示的共享格式化：路径链接、参数预览、文本/图片占位和执行耗时；不参与模型选择或工具实际执行。
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath, shortenHomePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ToolRenderContext } from "../extensions/types.ts";

/**
 * 把未知路径输入转换成适合显示的短路径，非字符串返回空串；合法绝对主目录路径可缩为 ~。
 * 例：用户目录下 /Users/alice/a.txt 显示为 ~/a.txt，原始文件操作路径不应据此改写。
 */
export function shortenPath(path: unknown): string {
	// path 属于未知 UI 输入，先收窄为字符串，避免调用路径函数时把对象当文件名。
	if (typeof path !== "string") return "";
	// 仅改变展示文本，保留原值用于真正文件操作/链接。
	return shortenHomePath(path);
}

/**
 * 终端支持超链接时，把显示文字链接到相对 cwd 解析出的 file: URL；不支持时原样返回文字。
 * 例：界面可显示 src/a.ts，链接目标仍是完整绝对文件 URL；不访问文件正文。
 */
export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	// 终端不支持 OSC 超链接时不能硬塞控制序列，直接返回已有样式文本。
	if (!getCapabilities().hyperlinks) return styledText;
	// 链接目标按真实会话目录解析，不能从已经缩短/着色的显示文字反推路径。
	const absolutePath = resolvePath(rawPath, cwd);
	// 用 Node 的 file URL 编码正确处理空格/特殊字符，再由 TUI 生成链接序列。
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

/**
 * 安全处理未知显示参数：字符串原样返回，null/undefined 变空串，其他类型返回 null 表示格式不对。
 * 例：str(123) 是 null 而非 "123"，下游可据此显示 invalid arg。
 */
export function str(value: unknown): string | null {
	// 未知值若已是字符串无需转换。
	if (typeof value === "string") return value;
	// == null 在这里同时匹配 null 与 undefined，是有意处理两种空缺值。
	if (value == null) return "";
	// 其他输入类型标为非法，区别于合法但为空的字符串。
	return null;
}

/**
 * 从未知值读取有限数字，非空数字字符串先 Number 转换；非法值返回 undefined。
 * 例如 "12" 变 12，空白串不变成 0；函数只检查有限数值，并不强制正整数。
 */
function parseLineNumber(value: unknown): number | undefined {
	// 只转换非空数字字符串；trim 条件避免 Number(" ") 被误显示为行号 0。
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	// 有限数值才返回，排除 NaN/Infinity；这里没有正整数约束。
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Format finite numbers or numeric strings as a read line range, omitting malformed ranges. */
/**
 * 把 read 的未知 offset/limit 格式化为路径后缀；缺起始行默认 1，非法数值时不展示范围。
 * 例如 offset=11,limit=5 得到 :11-15；只给 offset 得到 :11。该函数只做展示，不替代执行参数校验。
 */
export function formatReadLineRange(offset: unknown, limit: unknown): string {
	// Strict schemas represent omitted optional arguments as null.
	// 两个选项都缺省时不显示任何行号后缀。
	if (offset == null && limit == null) return "";
	// 只给 limit 时起始行为 1，显式 offset 则解析其数值。
	const start = offset == null ? 1 : parseLineNumber(offset);
	// 非法起始行不生成看似可信的路径范围。
	if (start === undefined) return "";
	// 仅给 offset 时用单行起点形式，不猜终点。
	if (limit == null) return `:${start}`;
	// 同样解析可能是数字字符串的行数。
	const count = parseLineNumber(limit);
	// 非法数量就隐藏范围，避免展示 NaN。
	if (count === undefined) return "";
	// 从起始行起数 count 行，包含首尾，所以终点减一。
	const end = start + count - 1;
	// 通过嵌套模板拼起点与可选终点；原实现对 end=0 不添加终点。
	return `:${start}${end ? `-${end}` : ""}`;
}

/** 把每个制表符替换成三个空格，便于终端工具行稳定缩进；输入输出都是字符串，无 I/O。 */
export function replaceTabs(text: string): string {
	// 正则 g 替换全部制表符，不只第一个。
	return text.replace(/\t/g, "   ");
}

/** 删除回车 CR，避免文本中的回车控制终端光标；保留换行 LF，纯显示处理。 */
export function normalizeDisplayText(text: string): string {
	// 正则删除所有 CR，不删除 LF。
	return text.replace(/\r/g, "");
}

/**
 * 从可选工具结果中提取纯文字显示，清除 ANSI/二进制控制字符；图片不能显示或用户关闭图片时补图片占位说明。
 * 例：结果有文字和 PNG，纯文字终端返回文字加图片类型/尺寸提示；不是把图片发送给模型。
 */
export function getTextOutput(
	// UI 接收一个宽松的结果形状，字段可缺，区别于执行器内部更严格的内容块联合类型。
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	// 调用方是否希望终端显示图片；仍需结合终端自身能力。
	showImages: boolean,
): string {
	// 尚无结果时返回空文字，不凭空创建占位结果消息。
	if (!result) return "";

	// 挑出文字块，保持块原有顺序。
	const textBlocks = result.content.filter((c) => c.type === "text");
	// 图片单独统计，后面决定是否生成文字占位。
	const imageBlocks = result.content.filter((c) => c.type === "image");

	// 每段先去 ANSI、替换二进制控制，再去 CR，用换行合并；防止工具原输出破坏终端布局。
	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	// 读取当前终端能力，不假设所有终端都支持图片或超链接。
	const caps = getCapabilities();
	// 图片存在但终端不支持/用户关闭时，以文字说明其存在，避免静默丢失信息。
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		// 从每个图片块构造一条文字占位说明。
		const imageIndicators = imageBlocks
			// map 将图片元信息逐项转为显示字符串，暂不实际渲染图像。
			.map((img) => {
				// 未知 MIME 用明确占位，不猜 PNG/JPEG。
				const mimeType = img.mimeType ?? "image/unknown";
				// 只有数据与 MIME 都存在才尝试识别图片尺寸。
				const dims =
					// 可选尺寸识别失败时传 undefined，允许下游仍显示普通图片占位。
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				// 让 TUI 按 MIME/尺寸生成统一文字说明。
				return imageFallback(mimeType, dims);
			})
			// 把多个图片说明按行拼接。
			.join("\n");
		// 已有正文则另起一行附图像说明，没正文就直接用图片说明。
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	// 返回已清理的终端显示正文，不改原工具 result。
	return output;
}

// 泛型让不同工具的 details 保持各自类型，而共同 content 仍是文字/图片块。
export type ToolRenderResultLike<TDetails> = {
	// 括号表示数组每个元素可以是文字或图片，不是“文字或图片数组”两种不对称形式。
	content: (TextContent | ImageContent)[];
	// 详情类型由调用者传入，例如 edit 的 diff 或 read 的裁剪详情。
	details: TDetails;
};

// 折叠参数预览长度预算，以 JS 字符串码元计，不是终端显示列数或 UTF-8 字节数。
const COLLAPSED_ARGS_CHARS = 100;

/**
 * Generic tool call header: the title followed by the arguments. Collapsed, they are `key=value`
 * pairs on the title line, cut to {@link COLLAPSED_ARGS_CHARS}. Expanded, each is a `key: value`
 * line below the title, with strings shown raw and continuation lines indented.
 */
/**
 * 构造工具调用标题与参数展示；展开时每个参数占多行，折叠时生成最多约 100 个 JS 字符的预览。
 * 输入未知 args 需要在 UI 信任边界判断形状，不是 schema 执行校验；对象值用 JSON.stringify 格式化。
 * 例：read + {path:"a.ts",offset:2} 折叠成一行键值对；expanded=true 可显示多行原字符串。
 */
export function formatToolCallWithArgs(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	// 先给工具标题加粗并套主题前景色，后面参数使用 muted 颜色。
	const header = theme.fg("toolTitle", theme.bold(title));
	// 还没有参数时只展示标题，兼容 null/undefined。
	if (args == null) return header;
	// 准备把对象字段或单个非对象参数统一成键值对数组。
	const entries =
		// 未知 UI 参数是普通非数组对象时，按每个属性显示；数组单独作为一个 args 值。
		typeof args === "object" && !Array.isArray(args)
			? // Object.entries 把普通对象转成 [key,value] 列表。
				Object.entries(args)
			: // 其他形状包装为单项 args；as 声明元组数组类型，不改变数据。
				([["args", args]] as [string, unknown][]);
	// 空对象不增加空参数段。
	if (entries.length === 0) return header;
	// 展开模式优先保持完整参数内容及多行格式。
	if (expanded) {
		// 数组元素解构得到键和值，逐个构造参数段。
		const lines = entries.map(([key, value]) => {
			// 字符串保持原文，其他值先用两空格 JSON；无法得到 JSON 字符串时用 String 兜底。
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			// 参数首行缩进两格、续行四格，顺便正规化 tab/CR，防止多行参数冲掉布局。
			return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		// 标题独占一行，下方参数段统一使用弱化颜色。
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	// 折叠模式生成单行 key=value 预览，字符串使用 JSON 引号标识边界。
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	// 超 100 字符保留前 97 个再加省略号；展开后可看完整内容。
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	// 将单行参数预览接在标题后，不返回多行参数。
	return `${header} ${theme.fg("muted", preview)}`;
}

/** Duration as `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
/**
 * 把毫秒转为工具耗时字符串，小于一分钟显示一位小数秒，更长显示分钟/小时。
 * 例：4200→4.2s，90000→1m 30s，7384000→2h 3m 4s；不启动计时器。
 */
export function formatToolDuration(ms: number): string {
	// 输入毫秒转为秒，小于一分钟保留小数。
	const seconds = ms / 1000;
	// 短耗时一位小数，例如 4.2s。
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	// 超过一分钟后按整秒展示，向下取整。
	const totalSeconds = Math.floor(seconds);
	// 取完整分钟数。
	const minutes = Math.floor(totalSeconds / 60);
	// % 求余，得到分钟之外剩余秒数。
	const remainder = totalSeconds % 60;
	// 未满一小时用分+秒。
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	// 更长耗时分解为小时、剩余分钟与剩余秒数。
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Renderer state of {@link startToolTimer} and {@link toolTimerText}, kept in `ToolRenderContext.state`. */
// UI 工具行自己的计时状态，可跨重复 render 调用保存。
interface ToolTimerState {
	// 尚未观察到执行开始时没有开始时间。
	startedAt?: number;
	// 结束后冻结终点，避免之后每次渲染耗时还增加。
	endedAt?: number;
	// ReturnType 取得平台定时器返回值类型，避免手写浏览器/Node 句柄差异。
	interval?: ReturnType<typeof setInterval>;
}

/** Start the row's clock once execution starts. Call from `renderCall`. */
/**
 * 工具实际开始时，仅首次记录 UI 行开始时间；重复 renderCall 不会重置计时。
 * 输入可变 ToolRenderContext.state，副作用仅更新渲染状态，不产生工具调用。
 */
export function startToolTimer(context: ToolRenderContext<ToolTimerState>): void {
	// 取本工具行持久的渲染状态，不是整个 Agent 状态。
	const state = context.state;
	// 只有执行已开始且还没记录时才设时间，重复渲染不会重置起点。
	if (context.executionStarted && state.startedAt === undefined) {
		// 记录渲染侧墙上时钟，主要用于进行中展示。
		state.startedAt = Date.now();
		// 新一轮执行清除旧终点，恢复计时。
		state.endedAt = undefined;
	}
}

/**
 * The row's timing line, from `renderResult`: `Elapsed 4.2s` while the result is partial, redrawn
 * every second, and `Took 4.2s` once it is final. Undefined when the row has no start time and no
 * recorded duration.
 */
/**
 * 返回工具行耗时文字并管理每秒重绘定时器；进行中显示 Elapsed，最终显示 Took，无可用时间则 undefined。
 * 最终结果自带 durationMs 优先，因它来自执行单调时钟且可随历史保存；UI 时间只是实时显示兜底。
 * 完成/错误时清理 interval 防止永久重绘，副作用仅渲染状态与刷新请求。
 */
export function toolTimerText(context: ToolRenderContext<ToolTimerState>, isPartial: boolean): string | undefined {
	// 取本工具行持久的渲染状态，不是整个 Agent 状态。
	const state = context.state;
	// 有开始时间、结果仍在进行中且没有刷新计时器时，才安排每秒重绘。
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		// 定时请求 UI 失效重绘，不修改命令执行结果。
		state.interval = setInterval(() => context.invalidate(), 1000);
	}
	// 最终结果或错误都应结束行计时并清理持续重绘。
	if (!isPartial || context.isError) {
		// 只首次冻结终点，后续 render 不会改变已结束耗时。
		state.endedAt ??= Date.now();
		// 确有刷新计时器才清理。
		if (state.interval) {
			// 停止每秒重绘，避免工具完成后仍持有活动定时器。
			clearInterval(state.interval);
			// 清除句柄引用，表示当前没有进行中的 UI 时钟。
			state.interval = undefined;
		}
	}
	// A final result's recorded duration wins: it is monotonic and survives reloads. The renderer's own clock is the
	// fallback for live progress and for results stored without one.
	// 最终结果有执行侧记录时优先用它，避免 UI 观察晚/重载导致耗时不准。
	if (!isPartial && context.durationMs !== undefined) return `Took ${formatToolDuration(context.durationMs)}`;
	// 旧历史也没有记录耗时、UI 又没看到开始时，就不伪造一个时长。
	if (state.startedAt === undefined) return undefined;
	// 结束后用固定终点，进行中每次渲染用当前时间。
	const endTime = state.endedAt ?? Date.now();
	// 根据进行中/完成状态选择词，并格式化起终点差值。
	return `${isPartial ? "Elapsed" : "Took"} ${formatToolDuration(endTime - state.startedAt)}`;
}

/** 用主题错误色返回参数非法提示；只格式化显示，不向模型返回工具执行错误。 */
export function invalidArgText(theme: Theme): string {
	// 错误色提示只供显示，不在这里执行 schema 校验。
	return theme.fg("error", "[invalid arg]");
}

/**
 * 给工具行显示路径：null 表示非法，空路径可取占位，合法值缩短主目录并附终端链接。
 * 输入显示路径、主题、cwd 与空值替代项，返回带样式字符串；不验证该文件实际存在。
 */
export function renderToolPath(
	// null 是上游已判断参数非法的标记，空串则可以采用缺省显示。
	rawPath: string | null,
	// 主题样式对象，负责前景色与标题等统一外观。
	theme: Theme,
	cwd: string,
	// 可选空路径占位，例如工具默认目录显示为点号。
	options?: { emptyFallback?: string },
): string {
	// 非法值与缺省值分开，不拿默认目录掩盖错误参数。
	if (rawPath === null) return invalidArgText(theme);
	// 空字符串才退到可选替代文本。
	const value = rawPath || options?.emptyFallback;
	// 还没有完整路径参数时用省略占位，常见于流式参数尚未生成完。
	if (!value) return theme.fg("toolOutput", "...");
	// 显示文字缩短并着色，链接目标仍用原路径解析，不能把 ~ 显示/ANSI 当文件名。
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
