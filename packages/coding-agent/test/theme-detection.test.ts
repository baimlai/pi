// 验证主题明暗推断、输出颜色模式与自动明暗设置；仅传对象/env或读内置JSON，不启动TTY/文件watch。
// 能力setter直接换TUI缓存，reset仅清缓存；不等保存并恢复任何先前任意能力状态。
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
// Vitest的分组/断言与每例结束清理钩子。
import { afterEach, describe, expect, it } from "vitest";
// 导入真实主题辅助，分别测环境索引、终端报告、按名加载与设置解析。
import {
	// 纯读取传入env的COLORFGBG末字段。
	detectColorFgBgTheme,
	// 按背景/报告/env/默认顺序判终端明暗。
	detectTerminalTheme,
	// 读内置主题并按当前能力预计算ANSI。
	getThemeByName,
	// 把一条light/dark配置拆成两名字。
	parseAutoThemeSetting,
	// 按当前明暗取最终单主题名，不加载该名称。
	resolveThemeSetting,
} from "../src/modes/interactive/theme/theme.ts";

// 每例后清能力缓存，避免本例setCapabilities对象直接留给后例；没有重新探测或恢复旧缓存。
afterEach(() => {
	// 只把缓存置空，不清程序覆盖等其他模块状态。
	resetCapabilitiesCache();
});

// 按COLORFGBG数字索引猜测，未声称读到用户自定义调色板实际RGB。
describe("detectColorFgBgTheme", () => {
	// 固定末字段样本包含两字段/rxvt三字段/未知默认值。
	it("classifies the last field by palette index like Vim", () => {
		// 最后0归dark，与前景15无关。
		expect(detectColorFgBgTheme({ COLORFGBG: "15;0" })).toBe("dark");
		// 三字段也只看最后15，归light。
		expect(detectColorFgBgTheme({ COLORFGBG: "0;7;15" })).toBe("light");
		// Solarized Dark's background is bright black.
		// 索引8按亮黑归dark，不用8>7推成浅色。
		expect(detectColorFgBgTheme({ COLORFGBG: "12;8" })).toBe("dark");
		// rxvt writes "default" when the background is not a palette color.
		// default不是数字索引，结果undefined。
		expect(detectColorFgBgTheme({ COLORFGBG: "15;default" })).toBeUndefined();
		// 没有环境字段也undefined，不直接在此返回dark。
		expect(detectColorFgBgTheme({})).toBeUndefined();
	});
});

// 终端综合判定覆盖数据优先级与固定可读性样本。
describe("detectTerminalTheme", () => {
	// 构造相互冲突的报告/env，检查背景优先和逐层回退。
	it("prefers the background, then the reported scheme, then COLORFGBG, then dark", () => {
		// 测试专用env字面对象，不修改process.env。
		const env = { COLORFGBG: "0;15" };
		// 实际深背景压过light报告和浅色环境。
		expect(detectTerminalTheme({ background: { r: 8, g: 8, b: 8 } }, "light", env)).toBe("dark");
		// 没背景时dark报告压过浅色环境。
		expect(detectTerminalTheme({}, "dark", env)).toBe("dark");
		// 报告也缺时取环境light。
		expect(detectTerminalTheme({}, undefined, env)).toBe("light");
		// 报告/env都无则dark兜底。
		expect(detectTerminalTheme({}, undefined, {})).toBe("dark");
	});

	// 以118灰和128灰两有限样本说明前景可能影响可读方向，不证明所有RGB组合。
	it("follows the foreground when text is readable that way", () => {
		// 固定较暗的中灰背景。
		const background = { r: 118, g: 118, b: 118 };
		// 无前景时该背景按对比规则选light。
		expect(detectTerminalTheme({ background })).toBe("light");
		// 加白色前景后达到所需方向条件，返回dark。
		expect(detectTerminalTheme({ background, foreground: { r: 255, g: 255, b: 255 } })).toBe("dark");
		// White text cannot reach 4.5:1 on mid-gray.
		// 稍亮的中灰使白字4.5对比条件不满足。
		const midGray = { r: 128, g: 128, b: 128 };
		// 即使前景仍白，这个样本按另一方向判light。
		expect(detectTerminalTheme({ background: midGray, foreground: { r: 255, g: 255, b: 255 } })).toBe("light");
	});
});

// 模式只测ANSI字符串编码，不验证真实终端是否照此显示。
describe("theme color mode", () => {
	// 同一内置dark先后按256色和真彩能力各建新实例。
	it("uses terminal capabilities", () => {
		// 直接设完整缓存，关图片/链接、false真彩；无能力探测/命令。
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		// 读取真实内置JSON，按缓存false生成模式。
		const ansi256Theme = getThemeByName("dark");
		// 显式确认可选加载结果非空，失败用清楚错误代替后续属性异常。
		if (!ansi256Theme) throw new Error("dark theme not found");
		// 模式应是256color。
		expect(ansi256Theme.getColorMode()).toBe("256color");
		// 只断言前景码形状38;5;索引，不固定究竟哪一个最近色。
		expect(ansi256Theme.getFgAnsi("accent")).toMatch(/^\x1b\[38;5;\d+m$/);

		// 换能力缓存为真彩，不会原地改此前实例。
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		// 再加载新Theme以重新计算ANSI。
		const truecolorTheme = getThemeByName("dark");
		// 再次收窄Theme|undefined。
		if (!truecolorTheme) throw new Error("dark theme not found");
		// 新实例mode应truecolor。
		expect(truecolorTheme.getColorMode()).toBe("truecolor");
		// 检查38;2;r;g;b数字形式，不测试通道具体数值。
		expect(truecolorTheme.getFgAnsi("accent")).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
	});
});

// 配置字符串解析组，不检查这些主题名是否都可加载。
describe("theme setting helpers", () => {
	// 同时验证普通名、左右选择和多斜杠拒绝的固定样本。
	it("parses and resolves automatic theme settings", () => {
		// 恰一斜杠的左浅右深字段，对象内容相等。
		expect(parseAutoThemeSetting("light/dark")).toEqual({ lightTheme: "light", darkTheme: "dark" });
		// 普通dark名不因terminalTheme=light而变。
		expect(resolveThemeSetting("dark", "light")).toBe("dark");
		// 自动语法配light选左。
		expect(resolveThemeSetting("light/dark", "light")).toBe("light");
		// 配dark选右。
		expect(resolveThemeSetting("light/dark", "dark")).toBe("dark");
		// 第二条斜杠使配置无效，返回undefined而非抛错。
		expect(resolveThemeSetting("light/dark/extra", "dark")).toBeUndefined();
	});
});
