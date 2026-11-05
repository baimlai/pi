// 主题总入口：把JSON/注册实例/终端上报色变成Theme，再给交互组件、高亮和HTML导出提供样式。
// 上游ThemeController负责查询终端与选择主题；此文件保存状态、按需读文件和监听，但import本身不会启动文件watch。
// 阅读可沿loadTheme→createTheme→Theme.fg/style走显示链，再看theme代理、热加载和CodeHighlighter缓存。
// fs命名空间提供同步文件读取、枚举与watcher类型；不在这里绕过config拼接安装资源目录。
import * as fs from "node:fs";
// path命名空间按当前平台拼路径；join规范化路径，但本身不校验主题名称或建立目录边界。
import * as path from "node:path";
// import type只取思考级别联合类型，生成JS时擦除，不为了类型加载Agent实现。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
// 从TUI取颜色编码/混合函数与组件主题类型；下方各type项目仅在开发期使用。
import {
	// 把Color编码成背景SGR控制串，返回文字，不向终端写入。
	backgroundAnsi,
	// Color是带kind区分的颜色联合：索引/RGB/OKLCH等通过构造器表示。
	type Color,
	// 导出CSS前把颜色转为#rrggbb；索引色按库内近似表解释。
	colorToHex,
	// 把颜色转OKLCH通道，下面只用l比较感知亮度，不是WCAG相对亮度。
	colorToOklch,
	// 编辑器需要边框/选择列表格式函数的接口。
	type EditorTheme,
	// 把Color编码成前景SGR，具体模式由truecolor/256color决定。
	foregroundAnsi,
	// 读取TUI能力缓存的颜色模式；首次能力探测在tmux且无链接覆盖时可能同步执行只读tmux命令，不发送OSC颜色查询。
	getTerminalColorMode,
	// 从0..255索引构造颜色，用于把JSON导出数值转CSS。
	indexedColor,
	// Markdown渲染需要的格式回调集合，包含代码高亮入口。
	type MarkdownTheme,
	// 将第一颜色混向第二颜色；下面用0.4近似终端dim，默认在OKLCH空间混合。
	mixColors,
	// 解析主题数值/颜色文字为Color；真正颜色格式与范围检查在该函数里。
	parseColor,
	// 终端报告的r/g/b对象类型；类型标注本身不验证外部输入。
	type RgbColor,
	// 把终端r/g/b三通道变为库内RGB颜色对象，构造器会检查数值。
	rgbColor,
	// 选择列表的选中/描述/无匹配文字格式接口。
	type SelectListTheme,
	// 设置列表的label/value/cursor等格式接口。
	type SettingsListTheme,
	// 接预计算前/背景ANSI和文字属性，按顺序包裹后返回字符串。
	styleTextWithAnsi,
	// 颜色模式联合类型；不是运行时开关对象。
	type TerminalColorMode,
	// 终端可选前景/背景与16色调色板等报告字段。
	type TerminalColors,
	// bold/dim等文字属性；ThemeStyle继承这些字段再添加主题颜色。
	type TextAttributes,
} from "@earendil-works/pi-tui";
// Chalk提供粗体/斜体等格式器；它是否实际加控制码还受自身颜色能力配置影响。
import chalk from "chalk";
// 资源目录统一经config取得，兼容源码、npm安装和独立二进制。
import { getCustomThemesDir, getThemesDir } from "../../../config.ts";
// 来源信息只描述资源出处，供界面标识；不在此自动鉴权或验证来源。
import type { SourceInfo } from "../../../core/source-info.ts";
// watch包装吞创建/关闭的一些错误并通知回调；不提供文件事件可靠送达或自动重试保证。
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.ts";
// 本地语法注册/高亮辅助；highlight解析代码文本，不执行代码。
import { getHighlightLanguageCount, highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";
// 先去UTF-8文本开头的BOM，再交JSON.parse。
import { stripBom } from "../../../utils/text.ts";
// 系统主题配色生成器及明暗判定；实际数学求解在同目录system-theme.ts。
import { generateSystemThemeColors, SYSTEM_THEME_NAME, terminalAppearance } from "./system-theme.ts";
// token表描述每个颜色名的前/背景槽及可选回退，类型仅用于编译期约束。
import {
	// 所有回退补齐后的token→值映射类型。
	type ResolvedThemeColorValues,
	// 运行时token描述表；后面按它拆前/背景，而非猜名字是否带Bg。
	THEME_TOKENS,
	// 只含背景槽token的名字联合。
	type ThemeBg,
	// 只含前景槽token的名字联合。
	type ThemeColor,
	// 带可选回退字段的泛型颜色映射，Value决定每项存字符串还是Color等值。
	type ThemeColorValues,
	// 全部颜色token名字的联合，用作Map/Record键。
	type ThemeToken,
} from "./theme-tokens.ts";

// 转导出系统主题保留名称，调用方无需直接引用生成器模块。
export { SYSTEM_THEME_NAME } from "./system-theme.ts";

// ============================================================================
// Types & Schema
// ============================================================================

/** The schema that validates this shape lives in `theme-schema.ts`; importing the type is free. */
// 只导入schema的静态类型并用as改本地名字，不加载完整校验器；unknown真正验证需显式安装回调。
import type { ThemeColorValue as ColorValue, ValidatedThemeJson as ThemeJson } from "./theme-schema.ts";

// 向外转导出主题JSON类型；export type在运行时没有值。
export type { ValidatedThemeJson as ThemeJson } from "./theme-schema.ts";
// 向外提供三组token名字类型，方便组件约束只能传合法槽。
export type { ThemeBg, ThemeColor, ThemeToken } from "./theme-tokens.ts";

/**
 * Tokens are only accepted in their own slot, because "" (terminal default) means the default foreground
 * or background depending on the slot. Use `theme.colors[token]` to use a token's color in the other slot.
 */
// 一次文字样式对象：extends继承bold等属性，再按槽限制token；也能直接传具体Color。
export interface ThemeStyle extends TextAttributes {
	// 可省略前景；字符串必须是前景token，Color对象可跨槽使用。
	fg?: ThemeColor | Color;
	// 可省略背景；例如userMessageBg可作bg，跨到fg应传theme.colors.userMessageBg。
	bg?: ThemeBg | Color;
}

// 校验函数类型：输入定位标签与未知JSON，成功返回ThemeJson；错误通常由实现抛出。
export type ThemeJsonValidator = (label: string, json: unknown) => ThemeJson;

// 模块级可选校验回调，未安装时只做下方很浅的对象/colors存在检查。
let themeJsonValidator: ThemeJsonValidator | undefined;

/**
 * Install full theme validation. Without it, documents are accepted as-is, which is what built-in
 * themes already do: validating user-authored JSON needs typebox, and a presentation that only uses
 * built-in themes should not pay ~17 MB of module graph for it.
 */
// 安装/替换主题JSON校验器，无返回；影响后续解析，不重新验证已有Theme。
// 例如启动层传入完整schema解析函数，纯展示入口则可避免加载大校验模块；此setter不运行校验。
export function setThemeJsonValidator(validator: ThemeJsonValidator): void {
	// 直接保存函数引用，后来的安装会覆盖前一回调；没有累加或卸载逻辑。
	themeJsonValidator = validator;
}

// ============================================================================
// Color Utilities
// ============================================================================

// 把颜色值中的变量别名递归解到字面色，返回string/number；不读文件、不修改vars。
// 例：vars={brand:"accent",accent:"#112233"}、value="brand"返回#112233；缺名/循环抛错。
// 这里只识别字面色前缀，是否合法由后续parseColor决定；visited只跟踪当前单条别名链。
function resolveVarRefs(
	// 颜色联合可为索引数字、空串、颜色文字或变量名。
	value: ColorValue,
	// Record<string,...>允许按变量名取值；运行时并不保证所有字符串都存在。
	vars: Record<string, ColorValue>,
	// 首次调用创建Set，递归复用；两个独立token各有自己的visited，不互相误判。
	visited = new Set<string>(),
	// 返回值已消除别名，但颜色字符串还未解析成Color对象。
): string | number {
	// 数字、终端默认空串、#及oklch(/okhsl(前缀直接作为叶子；i忽略颜色函数大小写。
	if (typeof value === "number" || value === "" || value.startsWith("#") || /^ok(lch|hsl)\(/i.test(value)) {
		// 叶子原样返回，不在此检查数字范围或#后的位数。
		return value;
	}
	// 当前别名已在同一链上出现，说明回到了之前的变量。
	if (visited.has(value)) {
		// 抛带变量名的循环错误，交加载层决定报错或降级。
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	// in检查属性链上是否有名字，不仅限own property；此处不是创建安全字典。
	if (!(value in vars)) {
		// 找不到别名就抛错，不把未知名字当CSS命名颜色使用。
		throw new Error(`Variable reference not found: ${value}`);
	}
	// 记录已经经过的变量；这条链只有一个后继，因此无需回溯删除。
	visited.add(value);
	// 取该变量值继续解引用；递归返回的最终叶子直接向外返回。
	return resolveVarRefs(vars[value], vars, visited);
}

// 逐项解整个颜色映射的别名，输入T保留原键集合，返回同键的string/number映射。
// 例：{accent:"brand"}配{brand:"#123456"}得到{accent:"#123456"}；任一别名失败则整次抛错。
// <T extends Record<...>>约束值类型，keyof T让调用方保留具体token名字，而非只看到string。
function resolveThemeColors<T extends Record<string, ColorValue>>(
	// 原映射T不被改动，Object.entries只读取它的可枚举自有字符串键。
	colors: T,
	// 省略变量表时用空对象；undefined也触发参数默认值。
	vars: Record<string, ColorValue> = {},
	// 映射类型把T每个键对应的值改为解引用后的联合。
): Record<keyof T, string | number> {
	// 先用宽字符串键创建可逐步填充的新结果。
	const resolved: Record<string, string | number> = {};
	// 数组解构每个[key,value]，for...of逐项处理。
	for (const [key, value] of Object.entries(colors)) {
		// 每项独立创建visited链；解析异常向外传播。
		resolved[key] = resolveVarRefs(value, vars);
	}
	// as补回已逐项保留键的类型信息，不做运行时拷贝或验证。
	return resolved as Record<keyof T, string | number>;
}

// 按token表补缺省颜色，返回完整泛型映射；不改输入顶层。
// 例：新token声明fallback:"muted"且自身未给值时复用muted；显式空串仍有效，不会回退。
// 按表顺序只走一遍，并非递归依赖排序；回退尚未有值就抛错，也不替所有必填token做完整验证。
function withThemeTokenFallbacks<Value>(values: ThemeColorValues<Value>): ResolvedThemeColorValues<Value> {
	// 展开做浅复制；Partial表示填充中可缺键，as只是开发期视图。
	const resolved = { ...values } as Partial<ResolvedThemeColorValues<Value>>;
	// 遍历实际token描述表，descriptor联合由不同token字段推断。
	for (const [rawName, descriptor] of Object.entries(THEME_TOKENS)) {
		// 只有带fallback的描述才需要补，不擅自给其他token造默认值。
		if (!("fallback" in descriptor)) continue;
		// entries丢失精确键名，断言回ThemeToken；不检查外部任意名称。
		const name = rawName as ThemeToken;
		// 只把undefined视为缺失，数字0或空串都保留。
		if (resolved[name] !== undefined) continue;
		// 读取描述表中的回退token名字，断言供索引使用。
		const fallback = descriptor.fallback as ThemeToken;
		// 从本次结果表取回退值，可能来自输入或此前已经补齐项。
		const fallbackValue = resolved[fallback];
		// 回退此时也没值，无法完成这一token。
		if (fallbackValue === undefined) {
			// 抛出两端名字，避免无声生成undefined颜色。
			throw new Error(`Theme token ${rawName} has unresolved fallback ${descriptor.fallback}`);
		}
		// 赋同一个Value引用；泛型Value若是对象，这不是深复制。
		resolved[name] = fallbackValue;
	}
	// 以完整映射类型返回；其完整性依赖调用方输入和token约定，不是as带来的验证。
	return resolved as ResolvedThemeColorValues<Value>;
}

// ============================================================================
// Appearance & Terminal Default Colors
// ============================================================================

/** The background a theme is designed for. */
// 主题设计的明暗背景，用TerminalTheme同一"dark"/"light"联合起语义别名。
export type ThemeAppearance = TerminalTheme;

// The terminal's reported colors. Replaced (never mutated) on update, so themes can cache resolved colors
// by identity.
// 终端报告的模块内快照；空对象表示尚无具体颜色，不等终端必为黑底。
let terminalColors: TerminalColors = {};
// While the terminal color query is in flight, the system theme renders in grayscale.
// 查询等待标记只影响之后生成系统主题的饱和度，不自动改已有Theme。
let terminalColorsPending = false;
// The terminal's last light/dark report (mode 2031). Only used while it has not reported a background.
// 终端明暗报告可缺省；已知实际背景色时它不会覆盖背景判定。
let terminalColorScheme: TerminalTheme | undefined;

/**
 * Record the terminal's reported colors. Themes use the default colors for tokens set to "" (terminal
 * default); the system theme is generated from all of them. Ends the pending state.
 */
// 保存终端报告并结束pending，无返回/终端I/O；例如ThemeController拿到查询结果后调用。
// 用新顶层对象触发Theme.colors按引用失效；嵌套RGB/调色板并未深复制，调用方仍应遵守数据约定。
export function setTerminalColors(colors: TerminalColors): void {
	// 浅展开换顶层身份，即使传空对象也会让旧具体颜色缓存重算。
	terminalColors = { ...colors };
	// 收到这次报告后不再按等待态强制系统主题灰度。
	terminalColorsPending = false;
}

/** Record the terminal's light/dark report, the fallback for terminals that do not report their background. */
// 记录或清除明暗报告，无返回/查询；例如2031报告light后供缺背景时使用。
// 这里只赋字段，不主动重建主题，也不替换terminalColors来刷新已有colors缓存。
export function setTerminalColorScheme(scheme: TerminalTheme | undefined): void {
	// 保存scheme或undefined，后者会继续回退COLORFGBG和dark。
	terminalColorScheme = scheme;
}

/** Render the system theme in grayscale until `setTerminalColors()` reports the terminal's colors. */
// 标记接下来创建的系统主题暂时灰度，无参数/返回或I/O；不负责发查询或设置超时。
// 例：查询开始时标记，收到颜色后setTerminalColors取消标记；已经创建的Theme不会原地重配。
export function markTerminalColorsPending(): void {
	// 只改模块布尔值，界面刷新/重新创建由上层驱动。
	terminalColorsPending = true;
}

/** Assumed terminal default colors when the terminal does not report them. */
// 缺终端报告时的明暗默认色表；Record要求两种appearance都给出前/背景Color。
const GUESSED_DEFAULT_COLORS: Record<ThemeAppearance, { foreground: Color; background: Color }> = {
	// 深色主题猜浅灰字与黑底；模块加载时解析这些常量。
	dark: { foreground: parseColor("#e5e5e7"), background: parseColor("#000000") },
	// 浅色主题猜黑字与白底，并非终端实际报告。
	light: { foreground: parseColor("#000000"), background: parseColor("#ffffff") },
};

// 平均一组可稳定解释颜色的OKLCH l，全部只是终端0..15索引时返回undefined。
// 例：只有索引7不能推断用户调色板明暗；混入一个RGB色则只对可用项平均，无输入修改。
function averageLightness(colors: Color[]): number | undefined {
	// Palette colors 0-15 follow the user's terminal palette, so they say nothing about the theme.
	// filter排除0..15可自定义ANSI色，保留其他颜色和固定256色索引。
	const fixed = colors.filter((color) => color.kind !== "indexed" || color.index >= 16);
	// 没有可用颜色就不给平均值，避免除以0。
	if (fixed.length === 0) return undefined;
	// reduce从0累加感知l，再除数量；不求WCAG对比度，也不按出现频率加权。
	return fixed.reduce((sum, color) => sum + colorToOklch(color).l, 0) / fixed.length;
}

/** Detect the background a theme is designed for from the lightness of its own colors. */
// 由主题自身前/背景的平均l推断明暗，返回dark/light或undefined；不看终端状态。
// 例：前景明显亮于背景判dark；仅背景时0.5为阈值，全无可用色交调用方回退终端。
function detectAppearance(foregrounds: Color[], backgrounds: Color[]): ThemeAppearance | undefined {
	// 算前景平均感知亮度，可undefined。
	const fg = averageLightness(foregrounds);
	// 同样算背景平均感知亮度。
	const bg = averageLightness(backgrounds);
	// 两边有值时只比相对大小，相等归light；不检查可读对比阈值。
	if (fg !== undefined && bg !== undefined) return bg < fg ? "dark" : "light";
	// 只知背景时，小于0.5当深色背景。
	if (bg !== undefined) return bg < 0.5 ? "dark" : "light";
	// 只知前景时，大于0.5的亮字推为深色背景。
	if (fg !== undefined) return fg > 0.5 ? "dark" : "light";
	// 两组都无法推断时明确留空，不在这个纯函数读取process.env。
	return undefined;
}

// ============================================================================
// Theme Class
// ============================================================================

// 一份主题实例：预计算终端控制码，同时按需给出可计算/导出的具体颜色。
// 由createTheme/createSystemTheme构造；fg/bg/style仅返回字符串，不写TTY，不转义输入中的ANSI。
// 例如t.fg("success","完成")给终端文字，t.colors.success给Color对象；两者不是同一返回类型。
export class Theme {
	// 可选名称；readonly只禁止正常TS赋值，不冻结整个实例。
	readonly name?: string;
	// 可选JSON来源路径，纯内存/系统生成主题可能没有文件。
	readonly sourcePath?: string;
	// 来源信息允许后续资源层补写，不是只读字段。
	sourceInfo?: SourceInfo;
	// private限制正常TS访问；模式在构造时记录，没有此类公开setter。
	private mode: TerminalColorMode;
	// Precomputed escape sequences keep fg()/bg() on the render hot path to a lookup and concat.
	// 前景token→开启码缓存；readonly限制Map引用替换，Map内容仍可set。
	private readonly fgAnsi = new Map<ThemeColor, string>();
	// 背景槽另存Map，因此错槽token在查表时可以报错。
	private readonly bgAnsi = new Map<ThemeBg, string>();
	// Tokens set to "" have no color of their own; `colors` fills them from the terminal defaults.
	// 只有显式色有Color，空串默认色要稍后按终端补；Partial让键可缺。
	private readonly concreteColors: Partial<Record<ThemeToken, Color>> = {};
	// 收集使用终端默认前景的token。
	private readonly defaultForegroundTokens: ThemeToken[] = [];
	// 收集使用终端默认背景的token，避免把空串在两个槽解释成同一RGB。
	private readonly defaultBackgroundTokens: ThemeToken[] = [];
	// Foreground tokens rendered faint (SGR 2) on top of their color.
	// 需要SGR2淡化的前景集合；ReadonlySet是TS只读接口，不是运行时freeze。
	private readonly dimTokens: ReadonlySet<ThemeColor>;
	// 构造时声明/推断的明暗，可缺省；不含动态终端回退结果。
	private readonly ownAppearance: ThemeAppearance | undefined;
	// 具体颜色缓存同时记终端对象身份；Readonly仅限制返回表的TS写入，下面还会浅freeze表。
	private resolvedColors: { terminal: TerminalColors; colors: Readonly<Record<ThemeToken, Color>> } | undefined;

	// 构造主题并解析颜色；输入两槽颜色表、终端模式与可选元数据，解析错误直接抛出。
	// 流程：复制元信息→补fallback/拆槽→为空串记默认槽、为实色缓存ANSI→推断appearance。
	// 例：createTheme把dark.json转进来后，同一实例多次fg只查Map；此构造不读文件或写终端。
	constructor(
		// Pick选出前景键，泛型底层值是string|number；可选fallback项仍可省略。
		fgColors: Pick<ThemeColorValues<string | number>, ThemeColor>,
		// 背景键单独输入，具体按表slot拆分而非颜色内容。
		bgColors: Pick<ThemeColorValues<string | number>, ThemeBg>,
		// 指定truecolor或256color，用于预计算后续控制码。
		mode: TerminalColorMode,
		// 最后一个可选对象集中提供元信息；没有就使用下面默认空对象。
		options: {
			// 显示/查找用名称，不会在此断言无斜杠。
			name?: string;
			// 源JSON路径只是元信息，构造器不会读取它。
			sourcePath?: string;
			// 来源元信息按引用保存。
			sourceInfo?: SourceInfo;
			// 显式明暗优先，否则按颜色推断。
			appearance?: ThemeAppearance;
			/** Foreground tokens to render faint (SGR 2). */
			// 只读前景token数组供构造Set；省略则为空Set。
			dim?: readonly ThemeColor[];
			// 参数默认值只在options为undefined或未传时生效。
		} = {},
	) {
		// 把options名称写入实例字段，构造期可以赋readonly。
		this.name = options.name;
		// 保存源路径，不规范化或检查文件存在。
		this.sourcePath = options.sourcePath;
		// 保存来源引用，不深复制。
		this.sourceInfo = options.sourceInfo;
		// 记住终端编码模式。
		this.mode = mode;
		// 从可选数组创建Set，去重；new Set(undefined)得到空集合。
		this.dimTokens = new Set(options.dim);
		// 嵌套解构把fgColors/bgColors在本地改名，避免与参数同名。
		const { fgColors: foregrounds, bgColors: backgrounds } = splitThemeColors(
			// 合并两表后补fallback；展开后面bg同名项会覆盖前面，但合法槽键本来分开。
			withThemeTokenFallbacks({ ...fgColors, ...bgColors }),
		);
		// 暂存显式前景Color，用于推断主题设计背景。
		const concreteForegrounds: Color[] = [];
		// 背景同理；空串默认色不加入这两数组。
		const concreteBackgrounds: Color[] = [];
		// Returns the escape sequence for the token's own slot.
		// 构造器局部闭包：输入token/值/槽，记录颜色或默认槽并返回开启码，无外部I/O。
		// 例如value=""且isBackground=true会记默认背景并返回49m；parseColor失败会让整个构造抛错。
		const addToken = (token: ThemeToken, value: string | number, isBackground: boolean): string => {
			// 空串专指终端默认色，而不是透明色或未知变量。
			if (value === "") {
				// 三元表达式选数组再push，按这个token自己的槽记账。
				(isBackground ? this.defaultBackgroundTokens : this.defaultForegroundTokens).push(token);
				// 49恢复终端默认背景，39恢复默认前景；不是清空全部样式。
				return isBackground ? "\x1b[49m" : "\x1b[39m";
			}
			// 把索引/颜色文字转Color；变量应已由上游解开。
			const color = parseColor(value);
			// 具体色按token保存，供colors getter重用。
			this.concreteColors[token] = color;
			// 把色放到对应暂存数组，不按text内容做采样。
			(isBackground ? concreteBackgrounds : concreteForegrounds).push(color);
			// 按槽和构造时模式算控制串；不输出串。
			return isBackground ? backgroundAnsi(color, mode) : foregroundAnsi(color, mode);
		};
		// entries断言为前景二元组数组，补回精确键类型，不验证运行数据。
		for (const [token, value] of Object.entries(foregrounds) as [ThemeColor, string | number][]) {
			// false表示前景；闭包完成副作用后把开启串缓存进Map。
			this.fgAnsi.set(token, addToken(token, value, false));
		}
		// 背景同样逐项解构，和前景使用不同键类型。
		for (const [token, value] of Object.entries(backgrounds) as [ThemeBg, string | number][]) {
			// true表示背景，缓存进背景Map。
			this.bgAnsi.set(token, addToken(token, value, true));
		}
		// ??只在显式appearance缺失时推断；推断也可undefined，getter再看终端。
		this.ownAppearance = options.appearance ?? detectAppearance(concreteForegrounds, concreteBackgrounds);
	}

	/**
	 * The background the theme is designed for: declared in the theme JSON, detected from its colors,
	 * or, for themes without usable colors, the terminal's appearance.
	 */
	// 属性getter：读取t.appearance时运行，返回声明/推断结果或当前终端明暗；不读主题文件。
	// 例：只用可变0..15索引的主题可能随终端背景变化，此值不是构造时永远固定。
	get appearance(): ThemeAppearance {
		// 只有ownAppearance缺省才调用终端判定；??不把light等有效值当空。
		return this.ownAppearance ?? getTerminalTheme();
	}

	/**
	 * Concrete colors for all tokens. Tokens set to "" (terminal default) use the terminal's reported
	 * default colors, or a guess based on `appearance` when the terminal did not report them. Faint
	 * tokens are approximated by mixing their color toward the background.
	 */
	// 按需返回完整token→Color表，供颜色运算/HTML导出；补默认色并近似dim，无终端I/O。
	// 例：text=""时用终端前景，没有报告则按appearance猜色；dim向背景混40%，不等真实终端SGR2算法。
	// 缓存只按terminalColors顶层身份失效；单改scheme或外部篡改嵌套报告不保证重算。返回表浅冻结，不能当深层不可变保证。
	get colors(): Readonly<Record<ThemeToken, Color>> {
		// 捕获当前终端快照引用，整个本次计算用同一对象。
		const terminal = terminalColors;
		// 可选链使尚无缓存也进入；比较引用，不逐项比r/g/b。
		if (this.resolvedColors?.terminal !== terminal) {
			// 按当前appearance选择缺报告时的前/背景猜色。
			const guess = GUESSED_DEFAULT_COLORS[this.appearance];
			// 局部箭头函数把可选r/g/b报告转Color，缺失用给定fallback；例如无foreground时用浅灰。
			const toColor = (rgb: RgbColor | undefined, fallback: Color) =>
				// 有对象才调用rgbColor校验通道；否则复用fallback引用。
				rgb ? rgbColor(rgb.r, rgb.g, rgb.b) : fallback;
			// 求默认前景具体色。
			const foreground = toColor(terminal.foreground, guess.foreground);
			// 求默认背景具体色。
			const background = toColor(terminal.background, guess.background);
			// 复制显式Color映射，后续只改新表；Color对象本身复用。
			const colors = { ...this.concreteColors };
			// 所有默认前景token补同一foreground引用。
			for (const token of this.defaultForegroundTokens) colors[token] = foreground;
			// 默认背景token补background引用。
			for (const token of this.defaultBackgroundTokens) colors[token] = background;
			// 仅对声明dim的前景做导出近似。
			for (const token of this.dimTokens) {
				// 取该token当前颜色，可仍undefined。
				const color = colors[token];
				// 有色才混向背景40%；这影响具体颜色表，不更改终端ANSI缓存。
				if (color) colors[token] = mixColors(color, background, 0.4);
			}
			// 浅freeze映射并连同终端身份缓存；as不补不存在的必填token。
			this.resolvedColors = { terminal, colors: Object.freeze(colors as Record<ThemeToken, Color>) };
		}
		// 缓存命中直接返回同一表引用，调用者不要修改它。
		return this.resolvedColors.colors;
	}

	// 将文字同时加前/背景token或具体Color及属性，返回带控制码字符串，不写终端。
	// 例：t.style("完成",{fg:"success",bold:true})；错槽/未知token查表抛错，Color则直接编码。
	// 内部文字含ANSI也原样保留，关闭码回默认属性而非自动恢复外层任意样式。
	style(text: string, options: ThemeStyle): string {
		// 解构拿原fg/bg，后续即使浅复制options也沿用这两个值。
		const { fg, bg } = options;
		// 字符串是token分支；若在dim集合就用新对象强制dim:true，原options不被改。
		if (typeof fg === "string" && this.dimTokens.has(fg)) options = { ...options, dim: true };
		// 统一拼开启码/原文/逆序关闭码，属性处理交TUI。
		return styleTextWithAnsi(
			// 文字保持原样，不在此做HTML/终端控制串净化。
			text,
			// 前景没给时不给前景开启码。
			fg === undefined
				? // undefined是缺省，不是终端默认空token值。
					undefined
				: // 已给值中，字符串代表主题token。
					typeof fg === "string"
					? // 从前景Map取码；背景token放这里会找不到。
						this.tokenAnsi(this.fgAnsi, fg)
					: // 对象Color按实例模式直接编码，不需要注册token。
						foregroundAnsi(fg, this.mode),
			// 背景同样先分是否给值。
			bg === undefined
				? // 缺背景就不主动加49/背景控制串。
					undefined
				: // 背景字符串按token处理。
					typeof bg === "string"
					? // 只读背景Map，确保槽语义。
						this.tokenAnsi(this.bgAnsi, bg)
					: // 背景Color对象直接转背景码。
						backgroundAnsi(bg, this.mode),
			// 透传bold等属性；fg/bg已经单独算好，callee不再读它们。
			options,
		);
	}

	// 给text加一个前景token，返回新字符串；例t.fg("error","失败")，未知token抛错。
	// 只恢复默认前景；dim时另关闭粗体/弱化，不修补text中嵌套重置。
	fg(color: ThemeColor, text: string): string {
		// 查预计算前景开启码，渲染热路径不再解析颜色。
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		// dim追加SGR2，结尾22同时关粗体/弱化、39回默认前景。
		if (this.dimTokens.has(color)) return `${ansi}\x1b[2m${text}\x1b[22;39m`;
		// 普通色直接前缀+原文+39m，不清背景。
		return `${ansi}${text}\x1b[39m`;
	}

	// 给text加背景token并回默认背景，例t.bg("toolErrorBg","失败")；查错token抛错，不写终端。
	bg(color: ThemeBg, text: string): string {
		// 从背景Map取开启码。
		const ansi = this.tokenAnsi(this.bgAnsi, color);
		// 49仅恢复默认背景，不保存此前的背景。
		return `${ansi}${text}\x1b[49m`;
	}

	// 私有查表器返回token开启码，不存在抛Error；例如前景Map不能读userMessageBg。
	// <T extends ThemeToken>把Map键与token联动，private是TS访问限制，未创建运行时#私有槽。
	private tokenAnsi<T extends ThemeToken>(ansi: Map<T, string>, token: T): string {
		// Map.get仍返回string|undefined，因为类型不证明该键已经插入。
		const value = ansi.get(token);
		// 显式undefined判断保留合法空字符串开启码的可能性。
		if (value === undefined) throw new Error(`Unknown theme color: ${token}`);
		// 返回原缓存串，无拼接/副作用。
		return value;
	}

	// 返回Chalk粗体文字，例t.bold("标题")；仅格式化字符串，是否开启控制码服从Chalk能力设置。
	bold(text: string): string {
		// 调用Chalk的bold格式器，处理其支持的嵌套关闭码，不写stdout。
		return chalk.bold(text);
	}

	// 返回斜体文字，例t.italic("强调")；终端是否显示斜体仍取决于终端支持。
	italic(text: string): string {
		// 交Chalk.italic生成字符串。
		return chalk.italic(text);
	}

	// 返回下划线文字，例t.underline("链接")；不因此赋予点击链接能力。
	underline(text: string): string {
		// 交Chalk.underline格式化，不添加OSC8超链接。
		return chalk.underline(text);
	}

	// 返回反显文字，例t.inverse("选中")；前后景交换由终端解释控制码。
	inverse(text: string): string {
		// 使用Chalk.inverse，不在这里计算RGB互换。
		return chalk.inverse(text);
	}

	// 返回删除线文字，例t.strikethrough("旧值")，不删除原文。
	strikethrough(text: string): string {
		// Chalk.strikethrough包裹原文，显示支持依赖终端。
		return chalk.strikethrough(text);
	}

	/** Opening escape sequence for a foreground token. Faint tokens include SGR 2, which `\x1b[22m` closes. */
	// 取得前景开启码，dim token还带SGR2；例t.getFgAnsi("muted")用于组件自己拼文本。
	// 不自动加关闭码，调用者必须按自己组合的样式关闭，未知token抛错。
	getFgAnsi(color: ThemeColor): string {
		// 复用前景Map查表。
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		// dim返回额外2m，否则返回原码；22m可关dim但也会关bold。
		return this.dimTokens.has(color) ? `${ansi}\x1b[2m` : ansi;
	}

	// 取得背景开启码而不包文本/关闭，例组件自行拼t.getBgAnsi("userMessageBg")；查错名抛错。
	getBgAnsi(color: ThemeBg): string {
		// 背景不应用前景dim集合。
		return this.tokenAnsi(this.bgAnsi, color);
	}

	// 返回此实例构造时的颜色模式，无I/O；后来终端能力变化不会原地更新本字段。
	getColorMode(): TerminalColorMode {
		// 直接读取mode，而非重新探测能力。
		return this.mode;
	}

	// 按思考级别返回文字格式函数；例t.getThinkingBorderColor("high")("─")使用thinkingHigh。
	// 返回箭头闭包捕获this，稍后调用才查码；default用off兜底，不判断模型是否真的在思考。
	getThinkingBorderColor(level: ThinkingLevel): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		// switch枚举级别，每个case直接return，不需要break防穿透。
		switch (level) {
			// 关闭思考对应专用off色。
			case "off":
				// 返回接str的函数而非立即返回颜色字符串。
				return (str: string) => this.fg("thinkingOff", str);
			// 最低minimal级别。
			case "minimal":
				// 闭包使用当前实例的thinkingMinimal token。
				return (str: string) => this.fg("thinkingMinimal", str);
			// low级别。
			case "low":
				// 稍后传文字时加thinkingLow前景。
				return (str: string) => this.fg("thinkingLow", str);
			// medium级别。
			case "medium":
				// 使用thinkingMedium，不修改级别本身。
				return (str: string) => this.fg("thinkingMedium", str);
			// high级别。
			case "high":
				// 用thinkingHigh给边框文字上色。
				return (str: string) => this.fg("thinkingHigh", str);
			// xhigh级别。
			case "xhigh":
				// 用独立thinkingXhigh色，而非复用high。
				return (str: string) => this.fg("thinkingXhigh", str);
			// max级别。
			case "max":
				// 最高级用thinkingMax token。
				return (str: string) => this.fg("thinkingMax", str);
			// 运行时若出现未覆盖值走off，不是TS联合的运行时校验。
			default:
				// 兜底仍返回同签名格式函数。
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	// 返回Bash模式边框格式函数，例t.getBashModeBorderColor()("─")；只上色，不执行shell。
	getBashModeBorderColor(): (str: string) => string {
		// 箭头闭包保留实例this，稍后用bashMode token。
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

// 内置dark/light JSON的模块级缓存；system由函数生成，不存在此表里。
let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

// 按需同步读取两份内置JSON并缓存，返回共享对象；例首次loadTheme("dark")才读包资源。
// 路径来自config；BOM/JSON语法处理后只作类型断言，不调用可选用户校验器。读取/解析错会抛。
function getBuiltinThemes(): Record<string, ThemeJson> {
	// 尚无缓存才读；缓存一旦建立不靠主题watch自动刷新内置文件。
	if (!BUILTIN_THEMES) {
		// 统一取安装形态适配后的资源目录。
		const themesDir = getThemesDir();
		// dark的实际资源路径。
		const darkPath = path.join(themesDir, "dark.json");
		// light的实际资源路径。
		const lightPath = path.join(themesDir, "light.json");
		// 两次解析都成功后才把对象赋给缓存，不逐项暴露半成品缓存。
		BUILTIN_THEMES = {
			// 同步读UTF-8、去BOM、JSON.parse，as不补schema验证。
			dark: JSON.parse(stripBom(fs.readFileSync(darkPath, "utf-8"))) as ThemeJson,
			// light同样解析，即使当前只请求dark也读两份。
			light: JSON.parse(stripBom(fs.readFileSync(lightPath, "utf-8"))) as ThemeJson,
		};
	}
	// 返回共享JSON映射，不深复制/冻结。
	return BUILTIN_THEMES;
}

// 列出可用主题名称；例选择器调用后得到system优先的名称数组，内部也会读自定义JSON。
// 复用带路径枚举去重/排序，不应把它误当不接触文件的纯函数。
export function getAvailableThemes(): string[] {
	// map参数解构仅保留name，返回新数组。
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

// 选择器用的名称/来源路径数据，类型不证明路径存在或已信任。
export interface ThemeInfo {
	// 主题JSON里的名字，不总等于文件去后缀。
	name: string;
	// 字段必须存在但值可undefined；这与path?可省略不同。
	path: string | undefined;
}

// 枚举系统、内置、自定义目录、注册表主题，按名字先到先得去重，返回system优先的有路径列表。
// 例：同名内置和自定义时列表保留内置条目；实际loadTheme仍可能先选注册实例，两种优先级不同。
// 同步IO/目录错误可能抛；单个自定义主题加载错会在getCustomThemeInfos吞掉。
export function getAvailableThemesWithPaths(): ThemeInfo[] {
	// 内置路径统一由config提供。
	const themesDir = getThemesDir();
	// 本次新建结果数组。
	const result: ThemeInfo[] = [];
	// Set按完整名字去重，不按路径。
	const seen = new Set<string>();
	// 局部addTheme闭包接一条信息，无返回；例如同名第二次被忽略，不覆盖先前条目。
	const addTheme = (themeInfo: ThemeInfo) => {
		// 之前已经见过这个名字。
		if (seen.has(themeInfo.name)) {
			// 直接结束这次添加，不结束外层枚举。
			return;
		}
		// 先标记已见，后续同名忽略。
		seen.add(themeInfo.name);
		// 按引用把信息对象加入结果。
		result.push(themeInfo);
	};

	// Built-in themes. The system theme is generated, so it has no file.
	// system是生成色，没有JSON路径。
	addTheme({ name: SYSTEM_THEME_NAME, path: undefined });
	// 读取内置缓存并取自有键；首次会同步读两JSON。
	for (const name of Object.keys(getBuiltinThemes())) {
		// 属性简写name加对应内置路径。
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// Custom themes
	// 枚举自定义主题时会真正尝试解析/构造每份JSON。
	for (const themeInfo of getCustomThemeInfos()) {
		// 同名不覆盖此前system/内置。
		addTheme(themeInfo);
	}

	// Map.entries给[name,Theme]，解构读取注册资源。
	for (const [name, theme] of registeredThemes.entries()) {
		// 注册纯内存主题sourcePath可缺，且不覆盖前面的同名条目。
		addTheme({ name, path: theme.sourcePath });
	}

	// The system theme comes first: it is the default and adapts to every terminal.
	// 对本地result原地排序后返回，不改注册Map。
	return result.sort((a, b) =>
		// system固定最前，其他按localeCompare；数字负/正决定前后。
		a.name === SYSTEM_THEME_NAME ? -1 : b.name === SYSTEM_THEME_NAME ? 1 : a.name.localeCompare(b.name),
	);
}

// 同步查自定义目录，加载每个.json后用主题内name生成条目，返回数组；不启动watch。
// 例：foo.json里name="Bar"返回Bar与foo路径；空name/单文件解析错忽略，目录枚举错误仍可抛。
function getCustomThemeInfos(): ThemeInfo[] {
	// 自定义目录通过config取得，可受PI_CODING_AGENT_DIR影响。
	const customThemesDir = getCustomThemesDir();
	// 新列表用于收集有效名称。
	const result: ThemeInfo[] = [];
	// 目录不存在时无需读取。
	if (!fs.existsSync(customThemesDir)) {
		// 返回空数组，未创建目录。
		return result;
	}

	// 同步读一层目录名字，不递归遍历。
	for (const file of fs.readdirSync(customThemesDir)) {
		// 只认大小写精确的.json结尾；不是按文件内容探测。
		if (!file.endsWith(".json")) {
			// 不匹配就跳过本项。
			continue;
		}
		// 拼候选路径，尚不检查是否目录或合法文件。
		const themePath = path.join(customThemesDir, file);
		// 单项读取/解析/颜色构造都在try内。
		try {
			// 完整创建Theme，而非只从JSON提name；坏颜色也会抛。
			const customTheme = loadThemeFromPath(themePath);
			// 只收真值name；没名称不会自动用文件名。
			if (customTheme.name) {
				// 保留JSON内name与实际文件路径的对应。
				result.push({ name: customTheme.name, path: themePath });
			}
			// 单主题失败被忽略；目录readdir本身不在此catch。
		} catch {
			// Invalid themes are ignored here; the resource loader reports them
			// during normal startup/reload.
		}
	}
	// 返回收集项，排序留给外层。
	return result;
}

// 拒绝含/的注册主题名，无返回；例light/dark保留给自动明暗设置，遇到就抛错。
// 只做这条规则，不是通用文件名净化；也不是所有加载入口都会调用它。
function assertThemeNameIsValid(name: string): void {
	// includes查任意位置的正斜杠，不在此检查反斜杠或..。
	if (name.includes("/")) {
		// 构造有说明的Error向调用方抛出。
		throw new Error(
			// 错误文字说明/已被自动明暗语法占用，不改用户输入。
			`Invalid theme name "${name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
}

// 把unknown JSON交已安装完整校验器，否则仅检查非null对象和colors属性存在，返回ThemeJson视图。
// 例：没装校验时{colors:null}仍可能先通过此处，随后构造失败；不能把as当完整schema验证。
// 无IO；校验器/本地错误直接抛，label仅用于诊断。
function parseThemeJson(label: string, json: unknown): ThemeJson {
	// 有回调就直接返回它的结果，包括它的默认/错误行为。
	if (themeJsonValidator) return themeJsonValidator(label, json);
	// 信任边界的浅检查：in允许继承属性，也没检查colors的具体形状。
	if (typeof json !== "object" || json === null || !("colors" in json)) {
		// 最基础外壳不满足就报错。
		throw new Error(`Invalid theme "${label}": expected an object with a "colors" map.`);
	}
	// 类型断言不补字段、不转换值、不清除额外属性。
	return json as ThemeJson;
}

// 去BOM并解析JSON文字，再走上述校验；返回ThemeJson，语法错误包上label后抛。
// 例：主题文件格式写坏时显示Failed to parse theme；schema校验错误在JSON try之外，保留自身信息。
function parseThemeJsonContent(label: string, content: string): ThemeJson {
	// 先以unknown承接外部JSON，开发期不能无检查访问其字段。
	let json: unknown;
	// 这层try仅包含BOM/JSON语法解析。
	try {
		// 去开头BOM后JSON.parse，不执行主题内容。
		json = JSON.parse(stripBom(content));
		// 捕获语法解析错误，TS错误值按unknown处理。
	} catch (error) {
		// 插入label和原错误的文字表示，不保留原Error实例为cause。
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	// 解析完成才调用主题验证，验证异常不被这层改写。
	return parseThemeJson(label, json);
}

// 按名字取得JSON数据供构造/导出：内置缓存→注册来源文件→自定义同名.json。
// 名字未先命中内置表时，已注册但无sourcePath的实例在此抛错；同名dark/light仍先取内置JSON。
// 例如插件提供sourcePath时会重新读磁盘，不序列化Theme对象；路径/读取/解析错向外传播，不在此校验安全相对路径。
function loadThemeJson(name: string): ThemeJson {
	// 先取内置JSON映射，首次会读两份资源。
	const builtinThemes = getBuiltinThemes();
	// 使用in查内置对象属性，不是Map.has或own-property专用检查。
	if (name in builtinThemes) {
		// 命中直接返回缓存引用，不重复校验。
		return builtinThemes[name];
	}
	// 内置未命中才查注册表JSON来源；注意实例加载loadTheme的优先级不同。
	const registeredTheme = registeredThemes.get(name);
	// 注册实例存在且sourcePath是真值才可从文件取原JSON。
	if (registeredTheme?.sourcePath) {
		// 同步读取源文件；主题显示所用实例可能比磁盘内容旧。
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		// 用来源路径作为错误label解析/校验。
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	// 已注册但没来源路径，不能从实例重建export配置。
	if (registeredTheme) {
		// 明确报没有可导出的源文件，而不另找自定义同名文件。
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	// 未注册才访问全局自定义目录。
	const customThemesDir = getCustomThemesDir();
	// 把name直接拼成.json路径，没有在此做目录穿越防护。
	const themePath = path.join(customThemesDir, `${name}.json`);
	// 缺路径给主题不存在错误；存在与真正读取间仍可能变化。
	if (!fs.existsSync(themePath)) {
		// 抛出包含请求名称的错误。
		throw new Error(`Theme not found: ${name}`);
	}
	// 同步读内容，I/O失败同样向外抛。
	const content = fs.readFileSync(themePath, "utf-8");
	// 用名字作label，解析+可选完整校验。
	return parseThemeJsonContent(name, content);
}

// 按token描述的slot拆完整颜色表，返回前/背景两个新对象；例toolErrorBg进bgColors。
// 只拆分不解析颜色，不改原表；输入含未声明键时读取descriptor可能抛，as不会替调用方验证。
function splitThemeColors(colors: ResolvedThemeColorValues<string | number>): {
	// 返回前景名→string/number映射。
	fgColors: Record<ThemeColor, string | number>;
	// 返回背景名→同类值映射。
	bgColors: Record<ThemeBg, string | number>;
} {
	// 空表逐步填；as先告诉TS最终键类型，不实际创建必填属性。
	const fgColors = {} as Record<ThemeColor, string | number>;
	// 背景表同理，与前景独立对象。
	const bgColors = {} as Record<ThemeBg, string | number>;
	// 遍历输入自有可枚举键值。
	for (const [key, value] of Object.entries(colors)) {
		// 根据真实描述表的slot选槽，key断言只是弥补entries精确类型丢失。
		if (THEME_TOKENS[key as ThemeToken].slot === "background") {
			// 背景键赋值，不把名字后缀当判断条件。
			bgColors[key as ThemeBg] = value;
			// 其余合法slot属于前景。
		} else {
			// 赋到前景新表。
			fgColors[key as ThemeColor] = value;
		}
	}
	// 属性简写返回两张表。
	return { fgColors, bgColors };
}

// 把已解析主题JSON变Theme，流程解变量→补fallback→拆槽→构造；不读主题文件，不自动安装schema。
// 例loadThemeFromPath读到dark形状后调用；可传颜色模式/来源路径，省略模式就读取TUI能力，首次探测可能运行只读tmux命令。颜色错会抛。
function createTheme(themeJson: ThemeJson, mode?: TerminalColorMode, sourcePath?: string): Theme {
	// ??只在mode未给时取当前能力，不自动随以后探测变化。
	const colorMode = mode ?? getTerminalColorMode();
	// 先解所有变量，再补token fallback；themeJson.vars缺省由resolveThemeColors默认空表处理。
	const resolvedColors = withThemeTokenFallbacks(resolveThemeColors(themeJson.colors, themeJson.vars));
	// 按表拆出两槽。
	const { fgColors, bgColors } = splitThemeColors(resolvedColors);
	// new执行构造与ANSI预计算，返回新实例。
	return new Theme(fgColors, bgColors, colorMode, {
		// JSON名称成为实例名称，不取文件名作默认值。
		name: themeJson.name,
		// sourcePath简写，把调用者传入来源保存进实例。
		sourcePath,
		// JSON声明明暗优先于构造时自动推断。
		appearance: themeJson.appearance,
	});
}

/** Generate the system theme from the terminal's reported colors (grayscale while they are pending). */
// 以当前终端快照生成system Theme；pending时饱和度0，完成后1，不发OSC颜色查询/读JSON。
// 省略mode会读取TUI能力，首次探测可能执行只读tmux命令。例报告到来后上层重新创建，旧实例不会在这里原地换ANSI。
function createSystemTheme(mode?: TerminalColorMode): Theme {
	// 调用同目录数学配色器，得到颜色、appearance和dim集合。
	const generated = generateSystemThemeColors({
		// 展开终端报告，RGB/调色板沿用嵌套引用。
		...terminalColors,
		// pending只控制饱和度，仍保留已有亮度/默认色信息。
		saturation: terminalColorsPending ? 0 : 1,
		// 明暗提示来自当前终端判定；有实际背景时生成器仍按其规则判定。
		appearanceHint: getTerminalTheme(),
	});
	// 补fallback并拆槽，把生成值送进相同Theme实现。
	const { fgColors, bgColors } = splitThemeColors(withThemeTokenFallbacks(generated.colors));
	// 显式mode优先，否则当前TUI模式；新实例不进注册表。
	return new Theme(fgColors, bgColors, mode ?? getTerminalColorMode(), {
		// 使用保留名称system。
		name: SYSTEM_THEME_NAME,
		// 生成器已经判定的明暗直接保存。
		appearance: generated.appearance,
		// dim前景在终端走SGR2，在具体colors中走混背景近似。
		dim: generated.dim,
	});
}

// 同步从指定路径加载主题并返回Theme；例loadThemeFromPath("/tmp/demo.json","truecolor")。
// 读UTF-8→去BOM/解析/可选校验→解变量/构造，任何错误向外抛；不注册、切换全局主题或启动watch。
export function loadThemeFromPath(themePath: string, mode?: TerminalColorMode): Theme {
	// 按传入路径读取，不在这里改用自定义目录。
	const content = fs.readFileSync(themePath, "utf-8");
	// 以路径作错误标签，不自动把路径改成绝对路径。
	const themeJson = parseThemeJsonContent(themePath, content);
	// 返回新实例并保存原sourcePath，显式模式可省略。
	return createTheme(themeJson, mode, themePath);
}

// 内部按名加载实例：system生成优先，其次注册实例，再按JSON新建；不设置当前全局主题。
// 例注册dark实例会先于内置dark显示；返回已有注册实例时mode参数不重编码该实例。错误向外抛。
function loadTheme(name: string, mode?: TerminalColorMode): Theme {
	// The system theme name is reserved: it takes precedence over custom themes of the same name.
	// 保留system名称始终走生成器，同名注册资源不能覆盖。
	if (name === SYSTEM_THEME_NAME) return createSystemTheme(mode);
	// 查Map按名取注册Theme。
	const registeredTheme = registeredThemes.get(name);
	// 已注册即直接用该实例，不读其sourcePath。
	if (registeredTheme) {
		// 保留对象身份和原有mode，不重新构造。
		return registeredTheme;
	}
	// 其余走内置/自定义JSON加载路径。
	const themeJson = loadThemeJson(name);
	// 从JSON新建，传入可选mode但这里没有sourcePath参数。
	return createTheme(themeJson, mode);
}

// 按名尝试加载，成功返回Theme、任意加载错误返回undefined；例UI预览先判断结果再显示。
// 会触发必要同步文件读取/颜色解析，不切换全局；吞掉错误细节，不表示失败名称一定不存在。
export function getThemeByName(name: string): Theme | undefined {
	// 把全部loadTheme路径放在try内。
	try {
		// 成功直接返回实例。
		return loadTheme(name);
		// IO/解析/变量/颜色等异常都统一吞掉。
	} catch {
		// 用undefined供调用者判断无法加载。
		return undefined;
	}
}

// 仅两个合法明暗文字的联合类型，无运行时代码。
export type TerminalTheme = "dark" | "light";

// 解析自动明暗设置，输入可选文字，返回左右主题名或undefined；无IO/主题存在性检查。
// 例" light / dark "得到lightTheme="light"、darkTheme="dark"；必须恰一个/且两边trim后非空。
export function parseAutoThemeSetting(
	// 字符串也允许未设置undefined。
	themeSetting: string | undefined,
	// 返回对象类型与undefined联合；字段名表示左浅右深。
): { lightTheme: string; darkTheme: string } | undefined {
	// undefined或空串不是自动设置。
	if (!themeSetting) return undefined;
	// 找第一个正斜杠位置，没找到为-1。
	const slashIndex = themeSetting.indexOf("/");
	// 没有/或还有第二个/都拒绝，不把路径当主题名。
	if (slashIndex === -1 || themeSetting.indexOf("/", slashIndex + 1) !== -1) {
		// 返回undefined，不抛解析异常。
		return undefined;
	}

	// 左半截是浅色主题名，只对自动语法做trim。
	const lightTheme = themeSetting.slice(0, slashIndex).trim();
	// 右半截是深色主题名。
	const darkTheme = themeSetting.slice(slashIndex + 1).trim();
	// 任一侧为空都无效。
	if (!lightTheme || !darkTheme) {
		// 拒绝"/dark"或"light/"等形式。
		return undefined;
	}
	// 属性简写返回两个已trim字符串。
	return { lightTheme, darkTheme };
}

// 把设置与终端明暗合成单个名称或undefined，无主题加载/IO。
// 例"light/dark"配light取左边；普通"dark"原样返回，空串和空白也原样保留，非法含/语法返回undefined。
export function resolveThemeSetting(
	// 原始配置可未设置。
	themeSetting: string | undefined,
	// 终端明暗已经由调用方决定，不在这里探测。
	terminalTheme: TerminalTheme,
	// 结果只有名字，没有Theme实例。
): string | undefined {
	// 先尝试自动语法。
	const autoTheme = parseAutoThemeSetting(themeSetting);
	// 只有两边都有效才用自动切换。
	if (autoTheme) {
		// 浅色取左值，深色取右值。
		return terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
	}
	// 未解析成功但含/的一律无效，不继续当普通名称加载。
	if (themeSetting?.includes("/")) return undefined;
	// 普通string原样保留，不trim或验证它是否可用。
	if (typeof themeSetting === "string") return themeSetting;
	// 未设置才走到这里。
	return undefined;
}

/**
 * Dark or light from the `COLORFGBG` environment variable some terminals set, or undefined without a
 * usable background index. The value is `fg;bg` or `fg;xpm;bg` (rxvt), where a field is an ANSI color
 * index or `default` when the color is not in the palette. The index refers to the terminal's own palette,
 * whose colors are unknown here, so it is classified by index like Vim does: 0-6 and 8 (bright black, e.g.
 * Solarized Dark's background) are dark, 7 and 9-15 are light.
 */
// 从可注入env的COLORFGBG末字段按索引猜明暗，无IO；例15;0→dark，0;15→light。
// 只处理0..15和一两位十进制，未知/default返回undefined；按索引猜，不知道用户真正改过的调色板。
export function detectColorFgBgTheme(env: NodeJS.ProcessEnv = process.env): TerminalTheme | undefined {
	// 可选链逐级保护缺值，at(-1)取最后字段，再trim两端空白。
	const bg = env.COLORFGBG?.split(";").at(-1)?.trim();
	// 正则锚定一两位数字；不接受default、负数、小数或空串。
	if (!bg || !/^\d{1,2}$/.test(bg)) return undefined;
	// 把匹配过的十进制文字转数值，"08"得到8。
	const index = Number(bg);
	// 大于15不属于此16色猜测规则。
	if (index > 15) return undefined;
	// 0..6及8算深，其余7/9..15算浅；不是按RGB实际亮度算。
	return index <= 6 || index === 8 ? "dark" : "light";
}

/**
 * Whether the terminal is dark or light. The background it renders decides, classified the same way the
 * system theme does. Without a reported background: the terminal's light/dark report, then COLORFGBG,
 * then dark.
 */
// 纯计算终端明暗：实际背景→明暗报告→COLORFGBG→dark；返回联合值，不主动询问终端。
// 例colors有背景时即使reportedScheme="light"也先按颜色判；前景可帮助生成器判断可读方向。
export function detectTerminalTheme(
	// 省略报告时为空对象。
	colors: TerminalColors = {},
	// 可选终端2031报告，仅在没有background时使用。
	reportedScheme?: TerminalTheme,
	// env可注入测试，默认process.env只是读取。
	env: NodeJS.ProcessEnv = process.env,
	// 返回值保证dark/light，最后有dark兜底。
): TerminalTheme {
	// 解构两种默认色，palette不参与此函数的明暗选择。
	const { background, foreground } = colors;
	// 已知背景优先，具体规则调用system-theme的terminalAppearance。
	if (background) return terminalAppearance(background, foreground);
	// ??依次用报告、环境猜测，最后dark；不把未知当异常。
	return reportedScheme ?? detectColorFgBgTheme(env) ?? "dark";
}

/** Whether the terminal is dark or light, from everything it reported so far. See `detectTerminalTheme()`. */
// 使用当前模块保存报告求终端明暗，无参数/IO；例Theme.appearance缺自身结论时调用。
export function getTerminalTheme(): TerminalTheme {
	// 同时给当前颜色和scheme，环境参数沿callee默认process.env。
	return detectTerminalTheme(terminalColors, terminalColorScheme);
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (node + jiti in dev mode)
// Symbol.for从共享符号表拿稳定键，让同一JS realm不同模块加载器能找同一全局Theme。
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
// 保留原包名符号键，写入时也同步；并非跨进程共享内存。
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (node, jiti) see the same theme
// 全局主题的稳定代理入口；每次读属性都从globalThis选当前实例，尚未init时抛错。
// 例theme.fg("success","完成")在下次切换后读到新Theme；as只让空target通过TS，不创建实例字段。
// 只有get trap，无通用绑定/枚举转发；解构出方法直接调用仍可能丢this，不能当完全透明对象代理。
export const theme: Theme = new Proxy({} as Theme, {
	// 读取属性触发；_target未用，prop可能string或symbol。
	get(_target, prop) {
		// 把globalThis作符号键表的TS视图，读取当前真实Theme。
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		// 缺初始化给明确错误，不在首次读取时偷偷选默认。
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		// 原样返回属性/方法，不bind；正常theme.method()调用时this是代理，字段读取继续由get转发。
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

/** The theme instance behind the `theme` proxy, whose own identity never changes. */
// 返回代理背后的当前真实实例或undefined，无初始化/抛错；高亮缓存用身份判断主题切换。
// 稳定的是theme代理身份，真实实例可替换，不把英文注释误解为后者永不改变。
function getGlobalTheme(): Theme | undefined {
	// 以允许undefined的类型读同一个全局符号键。
	return (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
}

// 内部替换全局Theme引用，无返回/回调/文件操作；例setTheme成功后调用，再由上层通知重绘。
function setGlobalTheme(t: Theme): void {
	// 写当前包名的共享符号键。
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	// 旧包名键也指同一实例，不复制Theme。
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

// 当前选择名，可能system、自定义或<in-memory>；不等当前实例一定可按此名重载。
let currentThemeName: string | undefined;
// 保存活跃Node文件监听句柄，可尚未开启。
let themeWatcher: fs.FSWatcher | undefined;
// 100ms防抖计时器句柄，和文件watcher是两个资源。
let themeReloadTimer: NodeJS.Timeout | undefined;
// 仅一个变更回调，不是事件监听器列表。
let onThemeChangeCallback: (() => void) | undefined;
// 插件/资源加载器注册的实例表，Map以名称为键。
const registeredThemes = new Map<string, Theme>();

// 整体替换注册主题表，无返回；例资源重载传入Theme数组，后同名覆盖前同名，无名跳过。
// 先clear再逐项校验/写入，遇非法名称抛错会留下已写部分，不是原子替换；不切换当前Theme/通知。
export function setRegisteredThemes(themes: Theme[]): void {
	// 立刻清空旧注册表，后续失败不回滚。
	registeredThemes.clear();
	// 按数组顺序处理，变量theme遮住外层同名代理，但仅限这个块。
	for (const theme of themes) {
		// 有真值名称才注册，不用sourcePath兜底。
		if (theme.name) {
			// 仅检查名称不含正斜杠，错误直接抛。
			assertThemeNameIsValid(theme.name);
			// 同键set覆盖前项值；仍保留Map原键的插入顺序规则。
			registeredThemes.set(theme.name, theme);
		}
	}
}

// 初始化全局主题，可选名称/监听开关，无返回；例initTheme("dark")默认不watch。
// 加载或启watch失败时静默改system，但回退加载自身仍可抛；不调用变更回调。
// false/回退分支不会主动stop旧watcher，不承诺反复初始化后旧句柄必清理。
export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	// ??只对未给名称选system，空串照常尝试加载。
	const name = themeName ?? SYSTEM_THEME_NAME;
	// 先记录请求名称，即使随后加载失败。
	currentThemeName = name;
	// 加载与可选watch启动同属此try。
	try {
		// 加载成功才把实例写全局符号。
		setGlobalTheme(loadTheme(name));
		// 显式true才开始监听；false不调用stop。
		if (enableWatcher) {
			// start会先停旧资源，再判断是否值得监听。
			startThemeWatcher();
		}
		// 静默吞原错误；catch里的回退若再失败仍向外抛。
	} catch (_error) {
		// Theme is invalid - fall back to the system theme silently
		// 把当前选择改成保留system。
		currentThemeName = SYSTEM_THEME_NAME;
		// 重新生成并设置system，不通知变更回调。
		setGlobalTheme(loadTheme(SYSTEM_THEME_NAME));
		// Don't start watcher for fallback theme
	}
}

// 按名切换全局主题，返回success/error；例setTheme("light")成功后通知当前单个回调。
// 加载/watch/回调都在try；回调抛错也会切system并返回失败，不代表此前完全没换过主题。
// 回退加载若抛错仍会逸出；false或失败分支不主动停旧watcher，失败回退不再通知回调。
export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	// 先改选择名，之后失败再改system。
	currentThemeName = name;
	// 把设置与通知作为同一try内的顺序步骤，并非事务。
	try {
		// 先真正替换全局实例，后启动watch/通知。
		setGlobalTheme(loadTheme(name));
		// 开关控制是否调用watch入口。
		if (enableWatcher) {
			// 启动时会清旧watcher/timer。
			startThemeWatcher();
		}
		// 只存在一个已注册回调，有才调用。
		if (onThemeChangeCallback) {
			// 同步调用；它的异常也进入下方catch。
			onThemeChangeCallback();
		}
		// 全部同步步骤正常后返回成功对象。
		return { success: true };
		// unknown错误可来自加载、watch或通知，不只JSON无效。
	} catch (error) {
		// Theme is invalid - fall back to the system theme
		// 失败时记录system为当前名。
		currentThemeName = SYSTEM_THEME_NAME;
		// 替换为重新生成的system；这里没有二次catch。
		setGlobalTheme(loadTheme(SYSTEM_THEME_NAME));
		// Don't start watcher for fallback theme
		// 用对象返回状态而不是直接抛原错误。
		return {
			// false指请求切换整体未正常完成。
			success: false,
			// Error取message，其他抛值用String；这才是对unknown错误的运行时收窄。
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// 直接切到给定Theme实例，停止watch并通知，无返回；例插件内存预览无需JSON路径。
// currentThemeName变占位符，后续按名导出不保证能重载此实例；回调抛错向外传播，已切换不会回滚。
export function setThemeInstance(themeInstance: Theme): void {
	// 保存传入对象本身，不复制/重新编码。
	setGlobalTheme(themeInstance);
	// 用占位名标记非按名加载，不把它注册到Map。
	currentThemeName = "<in-memory>";
	// 清计时器和watcher，直接实例不靠固定自定义JSON跟踪。
	stopThemeWatcher(); // Can't watch a direct instance
	// 有回调才通知。
	if (onThemeChangeCallback) {
		// 不在try中调用，异常交调用者。
		onThemeChangeCallback();
	}
}

// 登记唯一主题变更回调，无返回；例交互层传入使界面失效/重绘的函数。
// 后来的登记覆盖前者，不立即执行，不返回取消订阅函数。
export function onThemeChange(callback: () => void): void {
	// 按引用存回调，稍后切换/热重载才调用。
	onThemeChangeCallback = callback;
}

// 内部启动自定义目录watch与100ms防抖，无返回；先停旧监听，再按当前名称找固定<name>.json。
// 不是直接监听注册实例sourcePath；文件缺失/内置主题不启动，watch错误清句柄且不自动重试。
// 例编辑同名JSON触发延后重载，坏JSON保留旧实例；回调抛错发生在替换之后，catch也不回滚。
function startThemeWatcher(): void {
	// 先清旧timer/watcher，包括本次后面决定不启动的情形。
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	// 多行或条件判断：无当前名和三个内置/生成名都跳过。
	if (
		// 没有选择名无法拼watch目标。
		!currentThemeName ||
		// 内置dark无需监听自定义目录。
		currentThemeName === "dark" ||
		// 内置light同理，即使有同名注册实例也跳过。
		currentThemeName === "light" ||
		// system从报告生成，没有对应JSON。
		currentThemeName === SYSTEM_THEME_NAME
	) {
		// 早返，不创建资源。
		return;
	}

	// 只取标准自定义目录，不读注册Theme.sourcePath。
	const customThemesDir = getCustomThemesDir();
	// 闭包捕获本次名字快照，后面过滤过期事件。
	const watchedThemeName = currentThemeName;
	// 按名字拼固定.json文件名；与任意sourcePath注册的来源可能不同。
	const watchedFileName = `${watchedThemeName}.json`;
	// 保存完整目标路径，监听本身随后建在目录上。
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	// 当前文件不存在就不开；exists到真正reload之间仍可能变化。
	if (!fs.existsSync(themeFile)) {
		// 不自动轮询等待未来创建。
		return;
	}

	// 局部防抖函数，无参/返回；每次相关事件取消旧timer并重新排100ms，例如编辑器连发rename/change合并处理。
	const scheduleReload = () => {
		// 已有待执行重载就先取消它。
		if (themeReloadTimer) {
			// 清计时器不撤回已经开始执行的回调。
			clearTimeout(themeReloadTimer);
		}
		// 重新安排将来重载，不立即读取文件；句柄保存在模块字段。
		themeReloadTimer = setTimeout(() => {
			// 回调开始先清句柄，表示不再有待执行timer。
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			// 当前名字变了就忽略；仅按名字比较，不是任务版本号。
			if (currentThemeName !== watchedThemeName) {
				// 保留现有全局实例，不用旧名字覆盖新选择。
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			// 编辑器原子替换期间可能暂时缺文件，此次不重载。
			if (!fs.existsSync(themeFile)) {
				// 不清旧主题，也不在这里安排重试。
				return;
			}

			// 读取/构造/注册/全局替换/通知都在同一catch范围内。
			try {
				// Reload the theme from disk and refresh the registry cache
				// 重新读目标JSON创建新Theme，缺省模式取当前能力。
				const reloadedTheme = loadThemeFromPath(themeFile);
				// 用被监听名字作Map键，JSON内name可不同；不把这当名称一致性验证。
				registeredThemes.set(watchedThemeName, reloadedTheme);
				// 再把新实例设为当前，全局名仍沿用watchedThemeName。
				setGlobalTheme(reloadedTheme);
				// Notify callback (to invalidate UI)
				// 有变更通知时触发UI失效。
				if (onThemeChangeCallback) {
					// 通知同步抛错会被吞，但前面Map/全局修改不会回滚。
					onThemeChangeCallback();
				}
				// 吞临时坏文件等错误；成功修改后的后续错误也不会撤销已有状态。
			} catch (_error) {
				// Ignore errors (file might be in invalid state while being edited)
			}
			// 固定100毫秒防抖，不是保证100ms精准执行。
		}, 100);
	};

	// 保存包装器返回的watcher或undefined。
	themeWatcher =
		// 包装Node fs.watch的创建与error通知，不提供事件完整性保证。
		watchWithErrorHandler(
			// 监听整个目录以处理编辑器rename保存，而非只绑定旧文件inode。
			customThemesDir,
			// 事件类型不用，filename可为null；普通函数参数均由Node回调传入。
			(_eventType, filename) => {
				// 名字已经切换就忽略该旧监听事件。
				if (currentThemeName !== watchedThemeName) {
					// 早返，不继续调度。
					return;
				}
				// 没有文件名无法精确筛，保守调度本主题重读。
				if (!filename) {
					// 重置100ms等待。
					scheduleReload();
					// 不再执行后续文件名比较。
					return;
				}
				// 只接受目标文件的精确名字，不接受其他主题变化。
				if (filename !== watchedFileName) {
					// 其他文件事件跳过。
					return;
				}
				// 命中目标时同样防抖，而不直接同步reload。
				scheduleReload();
			},
			// 监听错误回调负责关闭已保存句柄，不接收错误对象。
			() => {
				// 尽力close，包装内部吞关闭错误。
				closeWatcher(themeWatcher);
				// 清本地watcher引用；已排timer不由这个错误回调自动取消。
				themeWatcher = undefined;
			},
			// 包装创建失败返回null，用??规范成此模块的undefined状态。
		) ?? undefined;
}

// 停止主题watch和待排重载，无参数/返回；例退出交互或切直接实例时调用。
// 尽力关watcher，不删除主题文件，不撤回已经开始的回调，也不清注册表或当前全局Theme。
export function stopThemeWatcher(): void {
	// 只有句柄存在才取消计时器。
	if (themeReloadTimer) {
		// 取消尚未开始的防抖任务。
		clearTimeout(themeReloadTimer);
		// 字段清空以免继续持有旧句柄。
		themeReloadTimer = undefined;
	}
	// 允许undefined的close包装，关闭错误吞掉。
	closeWatcher(themeWatcher);
	// 无论关闭是否报错都清引用。
	themeWatcher = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
// 按主题名加载并返回全部具体色的CSS hex表；例HTML导出把accent等放入CSS变量。
// 名称默认显式参数→currentThemeName→system，不直接读全局实例；<in-memory>因此不保证能导出。
// 默认色使用报告/猜色，dim取近似混色；IO/解析/颜色错误向外抛，不创建watch。
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	// nullish顺序选名字并loadTheme，再访问具体颜色getter；可能同步读JSON。
	const colors = loadTheme(themeName ?? currentThemeName ?? SYSTEM_THEME_NAME).colors;
	// entries逐色转hex，再fromEntries组新对象，索引按库内RGB近似而非终端自定义16色实值。
	return Object.fromEntries(Object.entries(colors).map(([token, color]) => [token, colorToHex(color)]));
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
// 按名字加载后判断appearance是否light，例导出CSS选明暗样式；名称默认规则同上。
// 可能读文件/抛加载错，不是单纯检查名称是否等于light，也不直接返回当前代理的appearance。
export function isLightTheme(themeName?: string): boolean {
	// 读取实例声明/推断/终端回退的appearance，与字面light严格比较。
	return loadTheme(themeName ?? currentThemeName ?? SYSTEM_THEME_NAME).appearance === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
// 取JSON显式export三背景并解变量，返回可选CSS色对象；例pageBg:"brand"可沿vars解到#色。
// system无JSON返回{}；缺配置/任意加载解析错误也返回{}，有配置但某项空串时该键值undefined。
// 索引/OKHSL转hex，#和OKLCH原串透传；不返回全部主题token，不保证任意无校验字符串都是合法CSS。
export function getThemeExportColors(themeName?: string): {
	// 页面背景字段可省略。
	pageBg?: string;
	// 卡片背景字段可省略。
	cardBg?: string;
	// 信息区域背景字段可省略。
	infoBg?: string;
} {
	// 选名不直接读取当前实例；传undefined沿当前名称回退。
	const name = themeName ?? currentThemeName ?? SYSTEM_THEME_NAME;
	// system没有显式JSON export配置，直接空对象。
	if (name === SYSTEM_THEME_NAME) return {};
	// 以下文件IO、变量解析和色转换失败都降级为空对象。
	try {
		// 加载原JSON而非Theme.colors，有来源文件时重新读取。
		const themeJson = loadThemeJson(name);
		// 取单独export配置区域。
		const exportSection = themeJson.export;
		// 整个区域缺失返回{}，不使用token颜色造默认值。
		if (!exportSection) return {};

		// vars没给用空表，供下面闭包复用。
		const vars = themeJson.vars ?? {};
		// Export colors end up in CSS, which understands hex and oklch() values directly but not okhsl().
		// 局部CSS值解析器接可选颜色值，返回string或undefined；例如数值24转固定256色hex。
		// 无额外IO；别名/色解析错误向外抛给本函数catch，空串表示不用显式覆盖。
		const resolve = (value: ColorValue | undefined): string | undefined => {
			// 未配置项保持undefined。
			if (value === undefined) return undefined;
			// 复用与普通颜色同一变量递归规则。
			const resolved = resolveVarRefs(value, vars);
			// 数字是ANSI索引，构造后转CSS可理解的hex。
			if (typeof resolved === "number") return colorToHex(indexedColor(resolved));
			// 终端默认空串不能作为CSS色，转成undefined。
			if (resolved === "") return undefined;
			// CSS不识别OKHSL，解析为库内Color再转hex。
			if (/^okhsl\(/i.test(resolved)) return colorToHex(parseColor(resolved));
			// 其他叶子如#色或OKLCH直接返回，不在这里统一重写成hex。
			return resolved;
		};

		// 三个键统一写入返回对象，即使某值为undefined也仍是对象属性。
		return {
			// 分别解页面背景值。
			pageBg: resolve(exportSection.pageBg),
			// 解卡片背景值，和其他项各自独立别名链。
			cardBg: resolve(exportSection.cardBg),
			// 解信息背景值；一个失败会让整体进入catch返回{}。
			infoBg: resolve(exportSection.infoBg),
		};
		// 不暴露错误原因给导出调用者。
	} catch {
		// 统一无显式覆盖结果，不表示文件或颜色一定不存在。
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

// scope名→文字格式函数，Record的string索引不要求把所有语法scope都列全。
type CliHighlightTheme = Record<string, (s: string) => string>;

// 缓存格式函数表对应的Theme参数引用；highlightCode通常给稳定theme代理。
let cachedHighlightThemeFor: Theme | undefined;
// 仅保留一份scope格式表，不存所有源代码高亮结果。
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

// 构造语法scope格式函数表，输入Theme，返回捕获它的箭头函数集合；不立即高亮代码。
// 例keyword("const")调用t.fg("syntaxKeyword",...)；如果t是全局代理，函数每次调用仍读当前主题。
function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	// 对象字段对应highlight.js的scope，经本地HTML文本解析器选择调用。
	return {
		// 关键字const/if等用syntaxKeyword。
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		// 内置名称用类型色syntaxType。
		built_in: (s: string) => t.fg("syntaxType", s),
		// 字面常量scope用syntaxNumber，与普通数字同色。
		literal: (s: string) => t.fg("syntaxNumber", s),
		// 数字片段用syntaxNumber。
		number: (s: string) => t.fg("syntaxNumber", s),
		// 正则片段用字符串色，不执行正则。
		regexp: (s: string) => t.fg("syntaxString", s),
		// 字符串片段用syntaxString。
		string: (s: string) => t.fg("syntaxString", s),
		// 字符串内替换表达式subst用普通text色。
		subst: (s: string) => t.fg("text", s),
		// 代码注释用syntaxComment，和本文件教学注释不是同一渲染过程。
		comment: (s: string) => t.fg("syntaxComment", s),
		// 文档注解标记同样用注释色。
		doctag: (s: string) => t.fg("syntaxComment", s),
		// 元信息scope用muted。
		meta: (s: string) => t.fg("muted", s),
		// function scope用函数色。
		function: (s: string) => t.fg("syntaxFunction", s),
		// 标题/函数名title也用函数色。
		title: (s: string) => t.fg("syntaxFunction", s),
		// class scope用类型色。
		class: (s: string) => t.fg("syntaxType", s),
		// type scope同用类型色。
		type: (s: string) => t.fg("syntaxType", s),
		// 标签tag本身用标点色。
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		// 标签名name用关键字色。
		name: (s: string) => t.fg("syntaxKeyword", s),
		// 属性名attr用变量色。
		attr: (s: string) => t.fg("syntaxVariable", s),
		// 变量名用syntaxVariable。
		variable: (s: string) => t.fg("syntaxVariable", s),
		// 参数片段params同用变量色。
		params: (s: string) => t.fg("syntaxVariable", s),
		// 运算符scope用syntaxOperator。
		operator: (s: string) => t.fg("syntaxOperator", s),
		// 标点scope用syntaxPunctuation。
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		// emphasis用斜体格式器，不另加token前景。
		emphasis: (s: string) => t.italic(s),
		// strong用粗体。
		strong: (s: string) => t.bold(s),
		// link用下划线，不能据此执行/打开链接。
		link: (s: string) => t.underline(s),
		// diff新增片段用toolDiffAdded。
		addition: (s: string) => t.fg("toolDiffAdded", s),
		// diff删除片段用toolDiffRemoved。
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

// 按传入Theme引用复用一份scope表；例相同代理反复高亮不重建回调。
// 缓存不存颜色结果：回调捕获代理时可随真实主题切换；如果传新真实实例则重新建表。
function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	// 引用变化或尚无表才重建，不比对主题名称。
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		// 先记录本次参数引用。
		cachedHighlightThemeFor = t;
		// 构造新回调表；没有语法分析或终端写入。
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	// 返回共享表引用供本次高亮读取。
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
// 给代码文字按显式已支持语言高亮并按LF返回行数组；例highlightCode("const x=1;","typescript")。
// 无有效语言用mdCodeBlock全文逐行，不做自动语言猜测；高亮内部异常也降级，但准备opts/降级本身异常可逸出。
// 仅解析字符串、不执行代码、不访问代码内URL；需已初始化全局主题。
export function highlightCode(code: string, lang?: string): string[] {
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	// 只有非空且当前已注册的语言才保留，未知语言不传给引擎。
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// Skip highlighting when no valid language is specified. cli-highlight's
	// auto-detection is unreliable and can misidentify prose as AppleScript,
	// LiveCodeServer, etc., coloring random English words as keywords.
	// 未给/未知语言统一走纯代码块色。
	if (!validLang) {
		// 按LF拆行，每行用当前主题上色；尾LF会保留最后空行，CR不在这里删除。
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	// 为已知语言准备高亮选项；在try外，构造异常不被下面catch吞。
	const opts = {
		// 固定语言名，不走highlightAuto。
		language: validLang,
		// 忽略该语法定义识别的非法片段，不表示所有输入都绝不抛。
		ignoreIllegals: true,
		// 提供scope→主题格式函数表，传入稳定代理。
		theme: getCliHighlightTheme(theme),
	};
	// 仅捕获真正highlight/结果split步骤的错误。
	try {
		// 解析语法HTML再转主题文字，按LF切成行。
		return highlight(code, opts).split("\n");
		// 引擎/格式回调失败时尝试纯色回退。
	} catch {
		// 回退也依赖初始化主题，若它抛错不会在本catch再次捕获。
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
}

/**
 * Highlights code for one owner, such as a tool row, and reuses the last result while the code, the language, the
 * theme and the registered grammars stay the same. Each owner keeps its own highlighter, so cached results live as long
 * as the code they show instead of in a process-wide cache.
 */
// 每个工具行等owner可持有一份高亮器，只缓存最近一次代码/语言/真实主题/语法数量对应的行。
// 例如进度重绘代码不变时复用数组，owner释放后本缓存也可回收，不建全局源代码强引用表。
export class CodeHighlighter {
	// 可选最近记录；private是TS访问限制，不是运行时校验或#私有字段。
	private last?: {
		// 缓存原代码字符串，逐值比较内容。
		code: string;
		// 语言可为undefined，未知语言原串也仍是缓存键。
		lang: string | undefined;
		// 缓存真实主题实例引用，可在未初始化时undefined。
		theme: Theme | undefined;
		// 语法数量作为便宜变化信号，不是语法内容哈希。
		languageCount: number;
		// 返回数组只在TS接口readonly，下面没有freeze；调用方必须不改共享结果。
		lines: readonly string[];
	};

	/** Like {@link highlightCode}. The result is shared with later calls, so callers must not modify it. */
	// 高亮并复用最近行，接代码/可缺省值的语言，返回共享readonly数组；例同参数连续两次===相同结果。
	// 先看依赖键→全命中直接返回→否则调用highlightCode并存新记录；失败不写新缓存。无终端/文件IO。
	highlight(code: string, lang: string | undefined): readonly string[] {
		// Renderers cannot tell a theme change from any other redraw, so the highlighter checks what its result depends on.
		// 直接拿代理背后真实实例，避免稳定代理身份掩盖切主题。
		const currentTheme = getGlobalTheme();
		// 取当前已注册语法数，延后本地语言加载可能使它增加。
		const languageCount = getHighlightLanguageCount();
		// 本次读取一份last快照。
		const last = this.last;
		// 短路与条件要求四个依赖都一致。
		if (
			// last未存在时可选链得undefined，code是string因而不会误命中。
			last?.code === code &&
			// 语言字符串值也必须相同。
			last.lang === lang &&
			// 真实Theme身份变化使缓存失效，不只比name。
			last.theme === currentTheme &&
			// 语法数量变化失效；同数量替换实现则不被此键识别。
			last.languageCount === languageCount
		) {
			// 返回原数组引用，不复制、不重新高亮。
			return last.lines;
		}
		// 未命中才做实际语法高亮/纯色回退。
		const lines = highlightCode(code, lang);
		// 保存这一次的键和结果，覆盖旧代码引用；只有单项缓存。
		this.last = { code, lang, theme: currentTheme, languageCount, lines };
		// 返回刚缓存数组，readonly不是运行时深冻结。
		return lines;
	}
}

/**
 * Get language identifier from file path extension.
 */
// 按最后一个.后的小写后缀查语言表；普通后缀返回语言或undefined，不读文件/探测内容。
// 例a.TS→typescript，README无映射；裸dockerfile也会命中，因为实现不要求路径中真的有点。
// 它不是完整basename解析，目录名中的.也参与split；普通对象的__proto__等继承键还可能读出非字符串，返回类型不验证运行值。
export function getLanguageFromPath(filePath: string): string | undefined {
	// split最后段转小写；pop可undefined用?.保护，空后缀保留空串。
	const ext = filePath.split(".").pop()?.toLowerCase();
	// 空路径或尾点等空后缀直接undefined。
	if (!ext) return undefined;

	// 每次调用创建普通对象映射；Record<string,string>只给静态索引类型，普通未命中键通常undefined，继承键仍可读出。
	const extToLang: Record<string, string> = {
		// ts后缀映射TypeScript。
		ts: "typescript",
		// tsx复用TypeScript语法，不另建tsx入口。
		tsx: "typescript",
		// js映射JavaScript。
		js: "javascript",
		// jsx复用JavaScript。
		jsx: "javascript",
		// mjs即ES模块后缀也用JavaScript。
		mjs: "javascript",
		// cjs即CommonJS后缀也用JavaScript。
		cjs: "javascript",
		// py映射Python。
		py: "python",
		// rb映射Ruby。
		rb: "ruby",
		// rs映射Rust。
		rs: "rust",
		// go映射Go。
		go: "go",
		// java映射Java。
		java: "java",
		// kt映射Kotlin。
		kt: "kotlin",
		// swift映射Swift。
		swift: "swift",
		// c映射C。
		c: "c",
		// h头文件此表选C，不推断它是否实际为C++。
		h: "c",
		// cpp映射C++。
		cpp: "cpp",
		// cc同为C++。
		cc: "cpp",
		// cxx同为C++。
		cxx: "cpp",
		// hpp头文件按C++。
		hpp: "cpp",
		// cs映射C#。
		cs: "csharp",
		// php映射PHP。
		php: "php",
		// sh映射Bash语法。
		sh: "bash",
		// bash也映射Bash。
		bash: "bash",
		// zsh在此复用Bash，未独立解析Zsh全语法。
		zsh: "bash",
		// fish映射Fish。
		fish: "fish",
		// ps1映射PowerShell。
		ps1: "powershell",
		// sql映射SQL。
		sql: "sql",
		// html映射HTML。
		html: "html",
		// htm同为HTML。
		htm: "html",
		// css映射CSS。
		css: "css",
		// scss映射SCSS。
		scss: "scss",
		// sass也复用SCSS，不判缩进方言差异。
		sass: "sass",
		// less映射Less。
		less: "less",
		// json映射JSON。
		json: "json",
		// yaml映射YAML。
		yaml: "yaml",
		// yml同为YAML。
		yml: "yaml",
		// toml映射TOML。
		toml: "toml",
		// xml映射XML。
		xml: "xml",
		// md映射Markdown。
		md: "markdown",
		// markdown同为Markdown。
		markdown: "markdown",
		// dockerfile字面段映射Dockerfile语法。
		dockerfile: "dockerfile",
		// makefile字面段映射Makefile。
		makefile: "makefile",
		// cmake映射CMake。
		cmake: "cmake",
		// lua映射Lua。
		lua: "lua",
		// perl映射Perl。
		perl: "perl",
		// r映射R。
		r: "r",
		// scala映射Scala。
		scala: "scala",
		// clj映射Clojure。
		clj: "clojure",
		// ex映射Elixir。
		ex: "elixir",
		// exs脚本也用Elixir。
		exs: "elixir",
		// erl映射Erlang。
		erl: "erlang",
		// hs映射Haskell。
		hs: "haskell",
		// ml映射OCaml。
		ml: "ocaml",
		// vim映射Vim脚本。
		vim: "vim",
		// graphql映射GraphQL。
		graphql: "graphql",
		// proto映射Protocol Buffers。
		proto: "protobuf",
		// tf映射HCL。
		tf: "hcl",
		// hcl也映射HCL。
		hcl: "hcl",
	};

	// 按文字键直接读属性并返回，不做own-property或supportsLanguage校验；如x.__proto__可读到原型对象。
	return extToLang[ext];
}

// 构造Markdown样式回调表，供组件渲染时使用；例heading稍后以当前theme.mdHeading上色。
// 返回新对象，不触发Markdown解析；箭头延迟读全局代理，需调用时主题已初始化，可能由主题查表抛错。
export function getMarkdownTheme(): MarkdownTheme {
	// 字段名符合MarkdownTheme接口，主要值是函数，不是CSS字符串。
	return {
		// Markdown标题文字用mdHeading。
		heading: (text: string) => theme.fg("mdHeading", text),
		// 链接显示文字用mdLink，不打开URL。
		link: (text: string) => theme.fg("mdLink", text),
		// 链接URL显示部分用mdLinkUrl。
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		// 行内代码用mdCode。
		code: (text: string) => theme.fg("mdCode", text),
		// 代码块纯色文本用mdCodeBlock。
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		// 代码块边框用独立边框token。
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		// 引用正文用mdQuote。
		quote: (text: string) => theme.fg("mdQuote", text),
		// 引用竖线边框用mdQuoteBorder。
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		// 水平分隔线用mdHr。
		hr: (text: string) => theme.fg("mdHr", text),
		// 列表项目符号用mdListBullet。
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		// 粗体交当前Theme.bold。
		bold: (text: string) => theme.bold(text),
		// 斜体交当前Theme.italic。
		italic: (text: string) => theme.italic(text),
		// 下划线交当前Theme.underline。
		underline: (text: string) => theme.underline(text),
		// 删除线交当前Theme.strikethrough。
		strikethrough: (text: string) => theme.strikethrough(text),
		// 方法值简写等价highlightCode:highlightCode，代码块以后才调用。
		highlightCode,
	};
}

// 构造选择列表格式器，返回选中/描述/滚动/无匹配回调；例选中项前缀用accent。
// 函数延迟读全局theme，不生成列表或改变选择，只有调用时才需要主题初始化。
export function getSelectListTheme(): SelectListTheme {
	// 返回新样式对象，不缓存组件本身。
	return {
		// 选中前缀用accent。
		selectedPrefix: (text: string) => theme.fg("accent", text),
		// 选中文本同用accent。
		selectedText: (text: string) => theme.fg("accent", text),
		// 描述用muted。
		description: (text: string) => theme.fg("muted", text),
		// 滚动提示用muted。
		scrollInfo: (text: string) => theme.fg("muted", text),
		// 无匹配文案用muted，不自行生成文案。
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

// 构造编辑器样式，边框回调用borderMuted，并嵌一份选择列表样式；不创建编辑器/监听输入。
// 例Editor接此对象后按需要调用borderColor，之后切主题仍通过代理生效。
export function getEditorTheme(): EditorTheme {
	// 新对象只描述样式回调。
	return {
		// 边框格式函数延迟查当前主题。
		borderColor: (text: string) => theme.fg("borderMuted", text),
		// 立即新建选择列表回调集合，但不执行其中格式函数。
		selectList: getSelectListTheme(),
	};
}

// 构造设置列表样式，返回label/value/描述/提示回调与已上色cursor字符串。
// 例选中value用accent、未选中用muted；cursor在调用本函数时就计算，所以此入口立即需要初始化主题。
// 返回对象不自动重建，cursor不会仅因之后切主题而自行变色，其他箭头回调则延迟读代理。
export function getSettingsListTheme(): SettingsListTheme {
	// 对象既有延迟回调，也有立即求值字符串，两种时机不同。
	return {
		// 选中label上accent，未选中原文返回；selected是布尔参数。
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		// 选中值accent，未选中也加muted，不等label的原文行为。
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		// 描述用dim token；它可同时含主题配置的SGR弱化行为。
		description: (text: string) => theme.fg("dim", text),
		// 立即格式化箭头和空格，不是函数，也不读取系统光标位置。
		cursor: theme.fg("accent", "→ "),
		// 提示回调在稍后渲染时用当前dim前景。
		hint: (text: string) => theme.fg("dim", text),
	};
}
