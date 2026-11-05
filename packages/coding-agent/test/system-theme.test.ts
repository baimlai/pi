// 用固定终端配色验证system主题的对比、色相/粉彩保留、灰度和索引回退，再检查Theme消费的ANSI文字。没有连接真实终端或请求模型；最后的主题列表会读所配置目录的自定义主题，路径由启动环境决定。
import { colorToOklch, colorToRgb, parseColor, type RgbColor, rgbColor } from "@earendil-works/pi-tui";
// Vitest负责分组/断言/清理；测试运行检查行为，TypeScript签名仍由统一check验证。
import { afterEach, describe, expect, it } from "vitest";
// 下面从纯配色模块取生成器、输入类型和对比函数；导入并不查询终端。
import {
	// 实际生成全部颜色的函数，测试多次调用都是同步本地计算。
	generateSystemThemeColors,
	// 输入形状仅作为type，不生成运行值或自动校验fixture。
	type SystemThemeInput,
	// 实际WCAG比值函数，也用于测试预期门槛。
	wcagContrast,
} from "../src/modes/interactive/theme/system-theme.ts";
// 从共享主题模块取列表、加载、导出设置和终端颜色注入能力；本文件不调用initTheme启动watch。
import {
	// 列出可用主题的函数会枚举内置及配置目录自定义主题，测试不改写它们。
	getAvailableThemes,
	// 按名得到Theme对象；system路径由注入颜色生成，不读取同名用户JSON。
	getThemeByName,
	// HTML导出配色查询，system返回空对象。
	getThemeExportColors,
	// 把固定颜色写入测试进程内的模块状态，不向终端发送控制串。
	setTerminalColors,
	// token名称联合type，让测试查色时不随意拼未知字段。
	type ThemeToken,
} from "../src/modes/interactive/theme/theme.ts";

// hex→parseColor→RGB通道的纯辅助，例#000000得黑色；:RgbColor是返回类型，不是运行时转换语句。
const rgb = (hex: string): RgbColor => colorToRgb(parseColor(hex));
// 参数解构后换OKLCH只取L，供比较视觉亮暗；区别于相对亮度Y及WCAG对比值。
const lightness = ({ r, g, b }: RgbColor) => colorToOklch(rgbColor(r, g, b)).l;

// Dracula固定输入fixture，类型注解检查字段；颜色名不意味着读取终端当前主题。
const DRACULA: SystemThemeInput = {
	// 固定深背景，hex先转普通RGB对象。
	background: rgb("#282a36"),
	// 固定浅前景，后面可检查直接沿用默认前景。
	foreground: rgb("#f8f8f2"),
	// 先写ANSI0..7八种色，数组中的文字仍保持原始测试载荷。
	palette: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2"]
		// concat追加8..15亮色，返回新数组，不改变上一数组。
		.concat(["#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"])
		// map逐项hex转RGB，最终长度16，满足生成器采用色板的条件。
		.map(rgb),
};

/** Dark with a palette, light with an unreadable foreground, background only, and mid-gray. */
// 具名输入字典覆盖四种代表情况；这是有限样本，不是所有终端/颜色空间的穷举。
const TERMINALS: Record<string, SystemThemeInput> = {
	// 复用Dracula对象引用，不拷贝色板。
	dracula: DRACULA,
	// 浅背景且原前景偏弱，用来触发文字调暗。
	solarizedLight: { background: rgb("#fdf6e3"), foreground: rgb("#657b83") },
	// 只报告深背景，省略前景和色板，生成器使用默认色族。
	backgroundOnly: { background: rgb("#1e1e1e") },
	// 中灰背景与白前景，检验规则空间不足时的放松路径。
	midGray: { background: rgb("#808080"), foreground: rgb("#ffffff") },
};

// 本测试只把五种用途当面板；不覆盖生产PANELS里的searchMatchBg/customMessageBg全部组合。
const PANELS: ThemeToken[] = ["userMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "selectedBg"];

// 把fixture里某token解析成可比较RGB，返回颜色对象；例空串text沿用input.foreground。只供这些已知fixture，!与as不检验缺字段，不能作通用生产解析器。
function resolved(input: SystemThemeInput, token: ThemeToken): RgbColor {
	// 每次重新生成完整主题再取一项，未缓存，不等于测性能。
	const value = generateSystemThemeColors(input).colors[token];
	// 空串按本测试PANELS分背景/前景取原色，!只去掉TS可能undefined，不补真实值。
	if (value === "") return PANELS.includes(token) ? input.background! : input.foreground!;
	// 这里的fixture非空结果按hex处理，as string不把数字ANSI索引转hex；此helper不适用于无背景索引输出。
	return rgb(value as string);
}

// 每项用例结束把共享终端颜色设空，不恢复测试前任意旧值；只影响测试进程状态。
afterEach(() => {
	// 实际清理调用不输出屏幕、不读颜色回复。
	setTerminalColors({});
});

// 这一组直接验证生成器的同步结果。
describe("generateSystemThemeColors", () => {
	// 四fixture分别检查正文对原/选择背景，以及工具标题对错误面板>=4.5；不由标题推断所有token/底面/任意输入均满足。
	it("keeps body text readable (WCAG 4.5:1) on the background and its panels", () => {
		// Object.entries解构名字和输入，name作为失败提示便于定位样本。
		for (const [name, input] of Object.entries(TERMINALS)) {
			// 生成并解析正文色。
			const text = resolved(input, "text");
			// 只枚举原背景与selectedBg两块正文底面，!依赖fixture总有background。
			for (const surface of [input.background!, resolved(input, "selectedBg")]) {
				// 比较实际RGB的WCAG比值；expect第二参数name是断言诊断文字。
				expect(wcagContrast(text, surface), name).toBeGreaterThanOrEqual(4.5);
			}
			// 另一条断言采用多行参数布局，含工具标题与错误底面。
			expect(
				// 先分别生成/解析两色再算对比，不以色族名字替代数值判断。
				wcagContrast(resolved(input, "toolTitle"), resolved(input, "toolErrorBg")),
				// 失败提示仍用当前fixture名。
				name,
				// 要求这一对颜色比值至少4.5，含等于。
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	// 比较部分前景亮度差的次序和五面板贴近背景；这里标题的contrast排序实际用OKLab L差绝对值，只有面板另算WCAG比。
	it("orders foreground roles by contrast and keeps panels close to the background", () => {
		// 逐一测试四个固定终端配置。
		for (const [name, input] of Object.entries(TERMINALS)) {
			// 取原背景OKLab L。
			const background = lightness(input.background!);
			// 闭包按token求L减背景L，有符号，正为比背景亮；每次仍重新生成主题。
			const offset = (token: ThemeToken) => lightness(resolved(input, token)) - background;
			// On mid-gray the levels collapse to the strongest reachable color.
			// 中灰不验证三层严格次序，因为放松可让它们收敛；不是整个中灰用例跳过。
			if (name !== "midGray") {
				// 正文离背景的L差绝对值应大于muted。
				expect(Math.abs(offset("text")), name).toBeGreaterThan(Math.abs(offset("muted")));
				// muted差绝对值应大于dim，未检查所有语法/状态色的顺序。
				expect(Math.abs(offset("muted")), name).toBeGreaterThan(Math.abs(offset("dim")));
			}
			// 从生成外观读是否沿更亮方向配色，不直接从fixture名字猜。
			const lighter = generateSystemThemeColors(input).appearance === "dark";
			// 遍历测试自己的五块面板列表。
			for (const panel of PANELS) {
				// 各面板相对原背景WCAG小于2，表示贴近底色；name+panel帮助识别失败位置。
				expect(wcagContrast(resolved(input, panel), input.background!), `${name} ${panel}`).toBeLessThan(2);
				// 面板L差的正负应与dark方向一致；toBe比较布尔，不是亮度具体数值。
				expect(offset(panel) > 0, `${name} ${panel}`).toBe(lighter);
			}
		}
	});

	// 检查一份深色fixture保留默认前景、一份浅色重建前景，以及error与源红槽色相接近；并未测试所有palette槽。
	it("uses the terminal foreground and palette hues", () => {
		// 空串表示交终端使用原默认前景，不能当作没有文字。
		expect(generateSystemThemeColors(DRACULA).colors.text).toBe("");
		// Solarized's foreground is below 4.5:1 on its own background, so text is darkened.
		// 仅断言不是空串，数值4.5检查在前一例；本条单独不证明新色具体变暗多少。
		expect(generateSystemThemeColors(TERMINALS.solarizedLight).colors.text).not.toBe("");
		// 局部helper取OKLCH色相角，单位度；不把RGB红通道当色相。
		const hue = ({ r, g, b }: RgbColor) => colorToOklch(rgbColor(r, g, b)).h;
		// 比较普通角度绝对差小于8度，未做跨0/360的最短圆周距离处理；此固定样本不跨该边界。
		expect(Math.abs(hue(resolved(DRACULA, "error")) - hue(DRACULA.palette![1]))).toBeLessThan(8);
	});

	// https://github.com/earendil-works/pi/issues/10255
	// 对应原问题10255：粉彩改亮度时不能显著增浓，同时检查两消息面板不过分有色；有限容差不等严格数学不变量。
	it("keeps pastel palette colors pastel at other lightnesses", () => {
		// 另一份固定Frappe配色，专门覆盖先前色度升高的情形。
		const frappe: SystemThemeInput = {
			// 其深背景输入。
			background: rgb("#303446"),
			// 其浅前景输入。
			foreground: rgb("#c6d0f5"),
			// ANSI0..7含第5槽粉色，用作accent来源。
			palette: ["#51576d", "#e78284", "#a6d189", "#e5c890", "#8caaee", "#f4b8e4", "#81c8be", "#b5bfe2"]
				// 追加亮色8..15，保持真实fixture文字不变。
				.concat(["#626880", "#e67172", "#8ec772", "#d9ba73", "#7b9ef0", "#f2a4db", "#5abfb5", "#a5adce"])
				// 逐hex转RGB，生成完整16色板。
				.map(rgb),
		};
		// 局部helper取绝对色度C，和OKHSL相对饱和s不同。
		const chroma = ({ r, g, b }: RgbColor) => colorToOklch(rgbColor(r, g, b)).c;
		// 非空断言只让TS接受已知fixture.palette；第5槽是待保留浓度的粉色。
		const pink = frappe.palette![5];
		// 取得最终accent RGB，实际经过亮度求解与锚定。
		const accent = resolved(frappe, "accent");
		// The accent is darker than the pink, but must not gain chroma (it was 2x before the cap).
		// 最终accent的OKLab L与来源的差严格大于0.05，且方向为更暗。
		expect(lightness(accent)).toBeLessThan(lightness(pink) - 0.05);
		// 色度最多来源的1.03倍，允许3%偏差，不误写为绝对不增一丝C。
		expect(chroma(accent)).toBeLessThanOrEqual(chroma(pink) * 1.03);
		// as const保留两个背景token字面量/只读元组，不冻结运行数组。
		for (const panel of ["userMessageBg", "customMessageBg"] as const) {
			// 两消息面板C分别不大于0.1，不要求它们和来源粉色同色相。
			expect(chroma(resolved(frappe, panel)), panel).toBeLessThanOrEqual(0.1);
		}
	});

	// 只用error一项验证零饱和近灰，不从单例推断任意颜色往返都精确无色度。
	it("renders grayscale at zero saturation", () => {
		// 浅展开输入并覆盖saturation0，原DRACULA对象不改；只解构输出colors。
		const { colors } = generateSystemThemeColors({ ...DRACULA, saturation: 0 });
		// 实际转换后C小于0.005，容许数值近似，不断言严格等0。
		expect(colorToOklch(parseColor(colors.error as string)).c).toBeLessThan(0.005);
	});

	// 无背景时验证索引/默认色/dim及外观提示；不同于有RGB背景时生成hex方案。
	it("falls back to palette indices and faint text without a background", () => {
		// 只给light提示，不给背景；解构三个输出字段。
		const { colors, dim, appearance } = generateSystemThemeColors({ appearanceHint: "light" });
		// 外观保留输入提示，不表示代码查询到真实浅终端。
		expect(appearance).toBe("light");
		// 固定检查错误为ANSI红索引1、正文/面板空串默认；数字1不是RGB值。
		expect([colors.error, colors.text, colors.userMessageBg]).toEqual([1, "", ""]);
		// dim包含muted，只检查成员存在，不约束整个数组顺序/全部内容。
		expect(dim).toContain("muted");
		// 无背景且零饱和时error也用默认前景，非线性地回退，不是混一个中间灰RGB。
		expect(generateSystemThemeColors({ saturation: 0 }).colors.error).toBe("");
	});
});

// 这一组验证生成配色由Theme对象消费后的公开表现，仍不操作真实终端。
describe("system theme", () => {
	// 检查system排序/无HTML导出色，以及注入配色后Theme外观/ANSI字符串；列表可读内置与所配置目录的自定义主题，不创建终端。
	it("is listed first, has no export colors, and is generated from the terminal colors", () => {
		// 列表第一项必须是system，不要求后面其他主题排序的每项。
		expect(getAvailableThemes()[0]).toBe("system");
		// system没有固定HTML导出字段，空对象不表示终端颜色表为空。
		expect(getThemeExportColors("system")).toEqual({});

		// 给测试进程注入Dracula固定颜色，afterEach会设空。
		setTerminalColors(DRACULA);
		// !假定system可加载，若真实undefined随后属性访问仍会失败，不自动创建Theme。
		const theme = getThemeByName("system")!;
		// 生成的外观为dark。
		expect(theme.appearance).toBe("dark");
		// 正文使用SGR39默认前景，断言只是返回的控制串，不向stdout写入。
		expect(theme.getFgAnsi("text")).toBe("\x1b[39m");
		// error控制串以38颜色前缀起，不凭此正则证明完整RGB参数或视觉效果。
		expect(theme.getFgAnsi("error")).toMatch(/^\x1b\[38;/);
	});

	// 无终端颜色时muted用SGR2，分别检查fg与style两种包装的关闭顺序；不真正终端渲染。
	it("renders faint tokens with SGR 2 and closes it", () => {
		// 前面用例清了注入色，此处取回退system主题；没有调用initTheme/watch。
		const theme = getThemeByName("system")!;
		// 精确比较默认前景+dim开启和复合关闭串，x为待包装正文。
		expect(theme.fg("muted", "x")).toBe("\x1b[39m\x1b[2mx\x1b[22;39m");
		// style对象fg:muted路径的关闭串拆分顺序不同，测试按真实文本精确比较。
		expect(theme.style("x", { fg: "muted" })).toBe("\x1b[39m\x1b[2mx\x1b[22m\x1b[39m");
	});
});
