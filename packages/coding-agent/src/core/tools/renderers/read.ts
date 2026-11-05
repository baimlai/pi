// read 的调用/结果展示：按路径把技能/项目说明/自带文档折叠成简短标题，展开时显示既有内容及裁剪信息；不执行读取文件业务。
/**
 * Presentation for the read tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `read.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

// 路径名/父目录/包含关系展示辅助；resolve别名为resolvePath以免与其他名字冲突，sep是当前平台分隔符。
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
// 文字/图片块纯类型，用于结果契约。
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
// Text运行组件，按终端宽度折行且可复用缓存。
import { Text } from "@earendil-works/pi-tui";
// 统一安装布局的README地址，源码/npm/独立程序位置由config处理。
import { getReadmePath } from "../../../config.ts";
// 从宿主可配置动作生成展开按键与提示。
import { keyHint, keyText } from "../../../modes/interactive/components/keybinding-hints.ts";
// 按扩展名选择语言并高亮；Theme只作类型，两个函数为运行值。
import { getLanguageFromPath, highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
// 项目内路径显示相对cwd，项目外保留绝对路径；只格式化不读文件。
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
// 工具定义与显示选项纯类型。
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
// 按会话cwd正规化工具路径，兼容~、@和特殊空格，不检查存在。
import { resolveToCwd } from "../path-utils.ts";
// read执行器提供的裁剪详情类型。
import type { ReadToolDetails } from "../read.ts";
// 复用行范围格式、正文清理/图片占位、路径链接、tab替换与未知参数收窄。
import { formatReadLineRange, getTextOutput, renderToolPath, replaceTabs, str } from "../render-utils.ts";
// 执行裁剪的默认行/字节预算，只有详情缺具体值才用来说明。
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../truncate.ts";

// 折叠标题分类结构，interface只约束形状，不扫描资源或执行技能。
interface CompactReadClassification {
	// docs为Pi包自带文档/例子，resource为指定说明文件名，skill为SKILL.md路径。
	kind: "docs" | "resource" | "skill";
	// 该分类用于标题显示的短标签。
	label: string;
}
// 精确文件名集合，区分大小写且只含列出的变体；不是不分大小写地匹配所有agents/claude文件。
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
// 宽松显示参数：新path与旧file_path别名，行区间unknown以兼容流式/旧记录；类型并不执行schema验证。
type ReadRenderArgs = { path?: string; file_path?: string; offset?: unknown; limit?: unknown };
// 格式化带颜色的行范围，输入显示参数/主题，返回后缀字符串，无读取副作用。例：offset=11,limit=5显示:11-15；非法数值或都缺省则空串。
function styledReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	// 统一辅助解析有限数字/数字字符串，行范围仅作展示，不替代执行参数校验。
	const range = formatReadLineRange(args?.offset, args?.limit);
	// 有范围着warning色，否则不添加后缀。
	return range ? theme.fg("warning", range) : "";
}
// 普通read标题，输入参数/主题/cwd，返回工具名、路径链接和范围。例：read src/a.ts:2-4；不打开文件。
function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	// file_path非null/undefined优先，即使空串也不回退path；str区分缺省与非法，路径辅助按cwd创建显示链接。
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	// 拼工具标题、路径和范围，格式化函数不会执行工具。
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${styledReadLineRange(args, theme)}`;
}
// 去掉末尾严格等于空串的行，输入字符串数组，返回新slice，无原数组修改。例：["a",""]变["a"]，仅空格或ANSI空色码行不会被当空串。
function trimTrailingEmptyLines(lines: string[]): string[] {
	// 从数组末端起计算保留边界。
	let end = lines.length;
	// 还有项且最后项为真正空串才继续退边界。
	while (end > 0 && lines[end - 1] === "") {
		// 边界前移一行。
		end--;
	}
	// 保留前半部分的新外层数组，数组内字符串复用。
	return lines.slice(0, end);
}
// 把当前平台路径分隔符转为/展示，无I/O；例如Windows路径变成统一文档标签，不转换路径权限或真实目标。
function toPosixPath(filePath: string): string {
	// 按sep拆后以正斜线接，POSIX平台sep本就是/。
	return filePath.split(sep).join("/");
}
// 判断绝对路径是否属于Pi包README/docs/examples，返回docs分类或undefined，不读取目标文档正文；包根定位可能探测package.json存在。
// 先取安装包根→算relative→拒根本身/上级/跨盘→识别前缀；例：包内docs/a.md显示docs/a.md。未realpath，不是文件授权边界或存在性证明。
function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	// 由统一README位置取包根，兼容不同安装方式；普通Node定位包根会向上existsSync探测清单，不是完全零文件系统查询。
	const packageRoot = dirname(getReadmePath());
	// 先绝对化两边再求相对路径，尚不解析符号链接目标。
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	// 以下任一条件说明不能当包内具体文档文件。
	if (
		// 相对为空表示包根自身，不作为文档条目。
		relativePath === "" ||
		// 直接上级目录拒绝。
		relativePath === ".." ||
		// 上级目录前缀拒绝，使用平台sep而非写死/。
		relativePath.startsWith(`..${sep}`) ||
		// 跨盘等结果仍为绝对路径也拒绝。
		isAbsolute(relativePath)
	) {
		// 不属于包内候选时返回无分类。
		return undefined;
	}

	// 把候选相对路径统一正斜线用于前缀识别/显示。
	const label = toPosixPath(relativePath);
	// 只接受README精确名或docs/、examples/下路径；仅名称计算，不检查后缀/文件存在。
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		// 返回docs类别及包内标签，属性简写label复用同名变量。
		return { kind: "docs", label };
	}
	// 包内其他路径不折叠成docs分类。
	return undefined;
}
// 按路径选择折叠标题类别，输入显示参数/cwd，返回分类或undefined，无文件内容读取。
// 优先任何SKILL.md路径，再包内docs，再指定项目说明名；例如skills/git/SKILL.md用父目录git显示技能名，名称不来自技能正文。
function getCompactReadClassification(
	// 可缺参数，path/file_path都可能尚未生成。
	args: ReadRenderArgs | undefined,
	// 会话工作目录，用于相对路径归一。
	cwd: string,
	// 未命中特殊分类时返回undefined，由普通read标题兜底。
): CompactReadClassification | undefined {
	// 优先旧file_path显示别名，经str标记错误类型。
	const rawPath = str(args?.file_path ?? args?.path);
	// 空/缺省/非法null都无法分类，交普通标题处理而非在这里抛错。
	if (!rawPath) return undefined;

	// 按cwd解析绝对路径，仅字符串规则不查询文件系统。
	const absolutePath = resolveToCwd(rawPath, cwd);
	// 取最终文件名用于精确分类。
	const fileName = basename(absolutePath);
	// SKILL.md先匹配，哪怕位于包docs里也优先skill。
	if (fileName === "SKILL.md") {
		// 标签用父目录名，没有父目录名可用时回退SKILL.md；并未读取frontmatter的name。
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	// 接着检查是否Pi自带文档/例子。
	const docsClassification = getPiDocsClassification(absolutePath);
	// 命中docs立即返回，不再检查项目说明类别。
	if (docsClassification) return docsClassification;

	// 剩余路径按指定文件名集合识别resource。
	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		// 项目内用相对路径、外部用绝对路径展示资源标签，不隐去其来源目录。
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	// 普通文件没有特殊折叠类别。
	return undefined;
}
// 拼特殊折叠调用标题，输入分类/参数/主题，返回带展开键的ANSI字符串，不执行技能。
// 例如skill标签显示[skill] git，文档显示read docs README.md；行范围位于展开提示之前。
function formatCompactReadCall(
	// 已计算的类别和标签。
	classification: CompactReadClassification,
	// 仍需原参数生成offset/limit范围。
	args: ReadRenderArgs | undefined,
	// 当前回调主题。
	theme: Theme,
	// 返回标题文字。
): string {
	// 读取可配置展开动作按键并着dim，未绑定可能为空按键文字。
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	// skill用自定义消息样式，不写成read skill。
	if (classification.kind === "skill") {
		// 返回skill专用几段拼接结果。
		return (
			// 给[skill]标签添加粗体ANSI和自定义标签色，后面的22m只结束粗体。
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			// 技能目录标签使用自定义消息正文色。
			theme.fg("customMessageText", classification.label) +
			// 追加可选读取行范围。
			styledReadLineRange(args, theme) +
			// 最后追加展开按键提示。
			expandHint
		);
	}

	// 非skill分类共用read docs/resource形式。
	return (
		// 按当前类别构造加粗工具标题。
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		// 标题和标签间一个空格。
		" " +
		// 文档/资源标签着accent。
		theme.fg("accent", classification.label) +
		// 追加读取范围。
		styledReadLineRange(args, theme) +
		// 追加展开提示。
		expandHint
	);
}
// 把read现有结果变成显示字符串，输入参数/结果/展开/主题/图片开关/cwd/错误状态。
// 折叠成功返回空正文；展开显示全部当前内容，折叠错误仍显示前10逻辑行。按路径高亮仅成功结果，最后补执行裁剪说明；例：config.ts读取失败的错误文字不会当TS代码着色。
function formatReadResult(
	// 参数只用于路径语言选择，不重新读取文件。
	args: ReadRenderArgs | undefined,
	// 正文为文字/图片块，可带执行裁剪详情。
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	// 展开选项决定正文可见与行预算，isPartial在此没有独立分支。
	options: ToolRenderResultOptions,
	// 当前主题。
	theme: Theme,
	// 控制图片占位选择，真正图片显示由宿主另做。
	showImages: boolean,
	// 保留契约中的cwd参数但此格式器未使用，_前缀表达有意忽略。
	_cwd: string,
	// 来自context的最终/当前错误标志，不从content文字猜成功失败。
	isError: boolean,
	// 返回ANSI文字，空串让Text不占正文行。
): string {
	// 未展开且不是错误，隐藏全部正文，包括普通文件；不只是docs/skill才隐藏。
	if (!options.expanded && !isError) {
		// 空串只隐藏本渲染器的文字正文，工具结果和模型上下文仍有原内容；ToolExecutionComponent仍可能另行显示图片块。
		return "";
	}

	// 取路径用于语言识别，支持file_path别名。
	const rawPath = str(args?.file_path ?? args?.path);
	// 提取安全文字/必要图片占位，不trim首尾，由后面仅去尾空行保持正文首行缩进。
	const output = getTextOutput(result, showImages);
	// 只有成功且路径非空才按扩展名识别语言，错误说明不做文件语法高亮。
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	// 有语言则先tab转空格再高亮，无语言则直接按换行拆行；高亮失败由共享函数回退普通样式。
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	// 移除末尾严格空串，避免多余显示行。
	const lines = trimTrailingEmptyLines(renderedLines);
	// 展开全部，折叠错误最多10逻辑行；成功折叠在前面已提前返回。
	const maxLines = options.expanded ? lines.length : 10;
	// slice取显示区间，不改原结果。
	const displayLines = lines.slice(0, maxLines);
	// 求超预算行数，负值不会生成更多行提示。
	const remaining = lines.length - maxLines;
	// 逐行tab转空格；已高亮则保留颜色，否则套正文色，开头换行与调用标题分开。
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	// 确有更多逻辑行才加提示。
	if (remaining > 0) {
		// 隐藏行数与当前展开按键构成提示，长逻辑行仍可被Text自动折行。
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	// 读取执行裁剪元数据。
	const truncation = result.details?.truncation;
	// 执行器确实truncated才展示限制，和UI折叠独立。
	if (truncation?.truncated) {
		// 首行自身过大，无法在预算内保留完整首行的特殊提示。
		if (truncation.firstLineExceedsLimit) {
			// 说明首行超字节预算，优先详情maxBytes否则默认。
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
			// 按行数裁剪使用单独说明。
		} else if (truncation.truncatedBy === "lines") {
			// 展示保留/总行数和行预算，详情未给maxLines回退默认。
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
			// 其他截断原因按字节预算展示。
		} else {
			// 显示当前保留行数及字节上限，不宣称展开可恢复被裁掉部分。
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	// 返回正文/展开提示/截断警告组合。
	return text;
}

// read只导出两显示槽；details泛型限定ReadToolDetails或undefined，参数any兼容流式/历史宽松输入。
export const readRenderers: Pick<ToolDefinition<any, ReadToolDetails | undefined>, "renderCall" | "renderResult"> = {
	// 调用展示回调，输入rawArgs/主题/context，返回Text；折叠时分类成skill/docs/resource，展开恢复普通路径标题，无文件正文读取。
	renderCall(rawArgs, theme, context) {
		// 把展示参数断言成ReadRenderArgs，断言不执行schema验证。
		const args = rawArgs as ReadRenderArgs | undefined;
		// 优先复用上次调用槽Text，首次0留白新建。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 仅折叠时计算特殊分类，展开不走分类标题。
		const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
		// 更新组件文字，Text对相同文字保留布局缓存。
		text.setText(
			// 有分类走简短标题，否则普通read路径/范围标题。
			classification ? formatCompactReadCall(classification, args, theme) : formatReadCall(args, theme, context.cwd),
		);
		// 返回调用槽组件，交宿主套壳和按宽度render。
		return text;
	},
	// 结果展示回调，输入既有结果/选项/主题/context，返回复用Text；例：setExpanded后显示当前正文，不重新执行read。
	renderResult(result, options, theme, context) {
		// 复用结果槽组件，首次创建零留白Text。
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		// 把下面格式化输出写到组件。
		text.setText(
			// 调用完整结果格式器，参数逐项来自本工具行上下文。
			formatReadResult(
				// 同一工具调用原参数，断言只供TS使用。
				context.args as ReadRenderArgs | undefined,
				// 当前部分/最终已有结果。
				result,
				// 是否展开/部分的显示选项。
				options,
				// 当前主题。
				theme,
				// 用户图片显示开关。
				context.showImages,
				// cwd传给保留参数，格式器当前未使用它。
				context.cwd,
				// 传入错误状态，决定成功隐藏/错误预览和是否高亮。
				context.isError,
			),
		);
		// 返回展示组件，不修改日志或模型消息。
		return text;
	},
};
