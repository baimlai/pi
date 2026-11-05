// 将SessionManager历史及可选AgentState装进单文件HTML，供/export和CLI文件导出使用；模板/第三方脚本只读取拼装，不在Node端启动浏览器。
// HTML保存所有分支并记录默认leafId，不是模型上下文投影；数据base64仅避免直接嵌入JSON时的转义问题，不加密、不脱敏。
import type { AgentState } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { SessionManager } from "../session-manager.ts";

/**
 * Interface for rendering custom tools to HTML.
 * Used by agent-session to pre-render extension tool output.
 */
export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	// 同步把调用参数转成HTML片段，id关联结果；自定义实现可运行宿主代码/抛错，本导出器不在接口层隔离它。
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to HTML. Returns collapsed/expanded or undefined if tool has no custom renderer. */
	// 内容沿用会话通用结构，details未知；结果中折叠/展开可分别缺省，undefined表示不提供自定义展示。
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/** Pre-rendered HTML for a custom tool call and result */
// 以工具调用id关联的三个可选片段，模板会消费它们；接口不验证任意外部renderer返回的HTML安全性。
interface RenderedToolHtml {
	callHtml?: string;
	resultHtmlCollapsed?: string;
	resultHtmlExpanded?: string;
}

export interface ExportOptions {
	// 输出路径可相对cwd，调用者需自行确认覆盖目标；不自动建父目录。
	outputPath?: string;
	// 传给主题颜色解析，和自定义工具renderer自己持有的theme对象不必然一致。
	themeName?: string;
	/** Optional tool renderer for custom tools */
	// 仅exportSessionToHtml预渲染时使用；exportFromFile接受同一选项类型但未调用它。
	toolRenderer?: ToolHtmlRenderer;
}

/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
// 输入颜色文字，识别六位hex或整数rgb(...)并返回三通道，其他格式undefined，无I/O；例如#ff8000→{r:255,g:128,b:0}。
// 不支持#abc/alpha/负数/CSS变量，也不把rgb(999,0,0)钳到255；无m正则的^/$约束整串，不trim颜色前后空白。
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	// 三个捕获组各取两位hex，匹配才按16进制转数字。
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	// rgb小写精确匹配，括号周围/逗号处允许空白，通道只接受一串十进制数字。
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	// 不认识的CSS颜色不猜测，调用者可保留原色或选固定回退色。
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
// 输入预期0..255的RGB，返回按sRGB线性化加权的相对亮度，无副作用；例如黑约0、白约1，供明暗背景分支判断。
// 公式本身不校验/钳位通道，所以越界颜色不保证结果处于原English所述0..1范围。
function getLuminance(r: number, g: number, b: number): number {
	// 局部纯函数：单通道归一到0..1，再按阈值走线性/幂函数，返回线性光强。
	const toLinear = (c: number) => {
		const s = c / 255;
		// **是乘方，不是按位异或；三元表达式只计算被选中的公式。
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	// RGB权重不同，不能直接用(r+g+b)/3代替感知亮度。
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
// 输入可识别颜色与倍数，返回每通道乘倍数后四舍五入/钳到0..255的rgb文字；不识别则原样返回，无I/O。
// 例如rgb(100,50,0)乘0.5得到rgb(50, 25, 0)；这是通道缩放，非HSL亮度调整，不额外验证factor为有限正数。
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	// 闭包捕获factor，对每个通道作同样计算；无有效颜色时上面已提前返回。
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color (e.g., userMessageBg). */
// 输入基础背景色，返回页面/卡片/信息区三色，无I/O；解析失败用固定深色，否则按亮度>0.5分明暗分支。
// 例如亮色卡片保留baseColor，页面乘0.96；暗色页面乘0.7、卡片乘0.85。不是完整配色对比度保证或自动检测浏览器主题。
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		// 固定回退值独立于当前终端颜色，不能解析的CSS表达式不会在Node端求值。
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	// 通道可能来自未钳位rgb文字，判断按实际解析数值进行。
	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		// 亮背景信息区稍增红/绿、降蓝；这些分量只按各自表达式作单边限制。
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	// 暗背景加暖信息区，页面/卡片分别变暗。
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom property declarations from theme colors.
 */
// 输入可选主题名，读取解析后的主题色并拼CSS变量声明，返回缩进连接的文字；主题加载/解析异常可向上传播。
// 例如普通颜色变--userMessageBg: ...;，导出专用颜色优先，缺省从userMessageBg推导；不在此写CSS文件或验证浏览器最终配色。
function generateThemeVars(themeName?: string): string {
	// 下层按显式名→当前主题→系统主题取色，可能读取主题资源，不只访问纯内存常量。
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		// 模板插值只构造CSS文字，不做HTML属性转义；主题解析结果是这里的颜色来源。
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	// 专用export色由主题helper解析；||在背景空串时也使用固定基础色，??仅在专用色缺失时采用推导。
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	// 三种导出区域分别选优先值，值之间不因某一字段缺失而整组回退。
	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	// 换行和空格用于模板可读排版，不改变CSS变量含义。
	return lines.join("\n      ");
}

// 内嵌数据结构：ReturnType从管理器方法取真实返回类型；这里entries是全历史，leafId仅告诉浏览器默认展示哪条分支。
interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
	leafId: string | null;
	// 运行态可提供当前系统提示及工具schema，文件独立导出未额外填这两项，但历史system条目仍在entries内。
	systemPrompt?: string;
	// Pick只挑工具定义的三个字段，Array表示可有多个；没有把执行函数放进可导出类型。
	tools?: Array<Pick<ToolDefinition, "name" | "description" | "parameters">>;
	/** Pre-rendered HTML for custom tool calls/results, keyed by tool call ID */
	renderedTools?: Record<string, RenderedToolHtml>;
}

/**
 * Core HTML generation logic shared by both export functions.
 */
// 输入会话数据及主题名，同步读取模板/CSS/JS/本地vendor资产，注入颜色和base64数据后返回HTML；不写文件，不运行浏览器脚本。
// 例如中文会话JSON先UTF8→base64，浏览器模板再atob→UTF8解码→JSON；base64不是隐私保护，整个历史仍随HTML可读取。
// 资源缺失/主题错误/JSON序列化失败会抛；此函数不下载缺失vendor，也不对调用方自定义HTML片段另作清洗。
function generateHtml(sessionData: SessionData, themeName?: string): string {
	// config兼容源码、dist和Bun布局，不使用硬编码__dirname。
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	// 六份资产同步读入内存，vendor是已有分发文件，只读取，不在这里重生成或修改。
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const markedCjkFriendlyJs = readFileSync(join(templateDir, "vendor", "marked-cjk-friendly.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	// CSS变量与基础区域背景都生成，模板CSS中的不同占位分别需要这些值。
	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
	// 专用页面/卡片/信息区颜色各自优先，不要求主题同时声明全部三色。
	const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
	const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
	const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;

	// Base64 encode session data to avoid escaping issues
	// JSON.stringify会省略undefined对象属性；自定义details若不可序列化会抛，未作脱敏或裁剪。
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

	// Build the CSS with theme variables injected
	// 每个字符串replace只替换首个匹配占位，原模板约定这些标记的位置；这不是通用模板引擎。
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	// 再嵌入CSS、本地脚本和数据；字符串替换里的$&等仍按JS规则解释，不是DOM节点API或通用安全插值引擎。
	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataBase64)
		.replace("{{MARKED_JS}}", markedJs)
		.replace("{{MARKED_CJK_FRIENDLY_JS}}", markedCjkFriendlyJs)
		.replace("{{HIGHLIGHT_JS}}", hljsJs);
}

/** Tools rendered directly by the HTML template (not pre-rendered via TUI→ANSI→HTML pipeline) */
// 固定这五个名字由浏览器模板专门展示，即使宿主同名工具有自定义回调，这里的调用预渲染也会跳过它。
const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

/**
 * Pre-render custom tools to HTML using their TUI renderers.
 */
// 输入完整会话条目和同步renderer，顺序扫描assistant调用/toolResult结果，返回以调用id为键的HTML片段表。
// 例如自定义search先保存callHtml，再把collapsed/expanded结果合并到同一id；不执行工具，只调用展示接口，任意renderer异常在这里不catch。
// 依赖条目扫描顺序，不另建匹配/去重队列；重复id的后写值可覆盖前写值，也不只渲染当前叶分支。
function preRenderCustomTools(
	entries: SessionEntry[],
	toolRenderer: ToolHtmlRenderer,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = {};

	for (const entry of entries) {
		// 只读message条目，压缩/模型变化等仍会进入最终导出数据，但不在此尝试工具展示。
		if (entry.type !== "message") continue;
		const msg = entry.message;

		// Find tool calls in assistant messages
		// 判别role后再看content数组，保留现有运行时数组分支，不把所有消息文字当工具调用列表。
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
					// 固定模板工具跳过，其余按原参数给回调；无非空调用HTML就暂不建记录。
					const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
					if (callHtml) {
						// 赋整个新对象，不合并同id之前已有的结果字段。
						renderedTools[block.id] = { callHtml };
					}
				}
			}
		}

		// Find tool results
		// toolCallId真值才关联，缺工具名用空串给resolver，不从之前调用自动推断名字。
		if (msg.role === "toolResult" && msg.toolCallId) {
			const toolName = msg.toolName || "";
			// Only render if we have a pre-rendered call OR it's not template-rendered
			// 已有记录或名字不在模板集合才调用结果renderer；只提供renderResult也可预渲染自定义工具。
			const existing = renderedTools[msg.toolCallId];
			if (existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)) {
				const rendered = toolRenderer.renderResult(
					msg.toolCallId,
					toolName,
					msg.content,
					msg.details,
					msg.isError || false,
				);
				if (rendered) {
					// 保留已有调用片段，再写结果字段；即使两个字段为空/undefined，真值结果对象也可使表留下该id。
					renderedTools[msg.toolCallId] = {
						...existing,
						resultHtmlCollapsed: rendered.collapsed,
						resultHtmlExpanded: rendered.expanded,
					};
				}
			}
		}
	}

	return renderedTools;
}

/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
// 输入管理器、可选运行态和选项（也接受输出路径字符串），预渲染工具并同步拼写HTML，Promise返回实际输出路径。
// 例如/export out.html把全部分支、当前leafId及可选当前工具定义写到cwd相对文件；不是只导出当前模型消息，也不会自动脱敏。
// 要求有已存在的会话文件，即使管理器内已有消息也不支持纯内存会话；async使同步读取/渲染/写盘异常成为Promise拒绝，但不移到后台线程。
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	// 字符串简写归一为outputPath字段，缺选项用空对象；不复制完整选项对象。
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	// 内存模式没有文件路径，明确拒绝；不是自动先保存会话再导出。
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	// 从管理器现有记录取全历史新数组，不重新从磁盘读取，不应用compaction/context_edit投影。
	const entries = sm.getEntries();

	// Pre-render custom tools if a tool renderer is provided
	let renderedTools: Record<string, RenderedToolHtml> | undefined;
	if (opts.toolRenderer) {
		// 传入当前所有分支条目，所以扩展渲染回调也可能为历史非当前分支运行。
		renderedTools = preRenderCustomTools(entries, opts.toolRenderer);
		// Only include if we actually rendered something
		// 表无任何自有id时改undefined，JSON.stringify后不输出renderedTools字段。
		if (Object.keys(renderedTools).length === 0) {
			renderedTools = undefined;
		}
	}

	const sessionData: SessionData = {
		// header可null，保持管理器提供的数据；entries与leafId分别表示全树和默认选中路径。
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		// 只摘工具名称/描述/参数schema，不序列化execute函数；运行态工具集合不等于每个历史时刻的集合。
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		renderedTools,
	};

	const html = generateHtml(sessionData, opts.themeName);

	// normalizePath处理输入写法但不强制变绝对路径；空字符串真值判断会走默认文件名。
	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		// 去掉会话文件.basename末尾的.jsonl，默认输出在当前cwd，而不是原会话所在目录。
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	// UTF8同步覆盖目标，父目录缺失则抛；返回值保留相对路径或用户给定的绝对路径形式。
	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}

/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
// 输入会话文件路径及可选主题/输出选项，解析输入→SessionManager.open→取全部历史→写HTML，Promise返回输出路径。
// 例如导出旧.jsonl可能在open中迁移记录或补末尾换行，不能称整个过程纯只读；不额外补当前AgentState，也未使用opts.toolRenderer。
// 输出默认仍在cwd、可覆盖既有文件、不建父目录；模板/主题/会话读取/写入错误会拒绝Promise。
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const resolvedInputPath = resolvePath(inputPath);

	// 明确检查存在后再打开；两者间仍可能有文件变化，open自身错误不会被吞。
	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}

	// open采用会话头cwd并建立管理器，可能进行格式迁移/文件修复，不是在此执行会话工具。
	const sm = SessionManager.open(resolvedInputPath);

	const sessionData: SessionData = {
		// 系统提示/工具字段留undefined会在JSON中省略，历史里的system消息仍保留，并非删除了系统记录。
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	const html = generateHtml(sessionData, opts.themeName);

	// 和运行态导出一致，输出仅normalize，默认名取输入basename；没有把输出自动放输入目录。
	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const inputBasename = basename(resolvedInputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}

	// 实际同步写文件；async只包装返回值和异常，返回路径可能相对cwd。
	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}
