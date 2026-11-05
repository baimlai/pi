// 验证Theme的样式/颜色解析/默认色与明暗推断，使用内置JSON副本和自建临时文件，不接真实终端。
// fs函数只读仓库固定主题、写删本文件创建的tmp目录；所有颜色控制码作为字符串断言。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// tmpdir取系统临时目录，不是用户主题目录。
import { tmpdir } from "node:os";
// join按平台拼临时路径。
import { join } from "node:path";
// 拿真实颜色构造/转hex/通用格式器作参照，不mock颜色实现。
import { colorToHex, okhslColor, styleText } from "@earendil-works/pi-tui";
// Vitest注册测试、每例清理和断言；import本身不执行下面it正文。
import { afterEach, describe, expect, it } from "vitest";
// 测真实主题加载器/终端报告状态；未启用initTheme或watch。
import { loadThemeFromPath, setTerminalColors } from "../src/modes/interactive/theme/theme.ts";

// 保存已创建临时目录供afterEach统一删除，const不禁止数组push/splice。
const tempDirs: string[] = [];

// 本测试读改JSON所需的最小TS形状，不是运行时schema。
type ThemeFile = {
	// 主题内名称用于临时JSON文件名。
	name: string;
	// 可选明暗联合，delete能移除此可选字段。
	appearance?: "dark" | "light";
	// 可选变量表，值仍可为别名/颜色串或索引。
	vars?: Record<string, string | number>;
	// 宽字符串键允许测试改token；不代表任意键业务上都合法。
	colors: Record<string, string | number>;
};

/** Load a copy of a built-in theme, modified by `edit`. */
// 创建可修改的内置主题副本并从真实加载器返回Theme；输入dark/light及可选编辑回调。
// 流程：读固定JSON→编辑内存对象→建/记tmp→写JSON→以truecolor加载；例回调可把accent改成OKLCH。
// 同步IO/解析/颜色错误向外抛，目录创建成功后进入清理表；edit在创建目录前执行，默认空箭头无副作用。
function loadTheme(base: "dark" | "light", edit: (theme: ThemeFile) => void = () => {}) {
	// JSON.parse返回未知形状，下面as只声明本测试依赖的字段。
	const themeJson = JSON.parse(
		// new URL相对import.meta.url定位仓库固定JSON，模板插入受联合类型限定的base。
		readFileSync(new URL(`../src/modes/interactive/theme/${base}.json`, import.meta.url), "utf8"),
		// as ThemeFile不检查内容，可信样本来自仓库文件。
	) as ThemeFile;
	// 同步执行编辑回调，直接改本次新解析对象。
	edit(themeJson);
	// mkdtemp在前缀后加随机尾部创建独立目录。
	const dir = mkdtempSync(join(tmpdir(), "pi-theme-style-"));
	// 马上登记清理目标，后面写/加载失败afterEach仍能处理它。
	tempDirs.push(dir);
	// 用JSON内name组成tmp文件路径，局部path是字符串而非path模块。
	const path = join(dir, `${themeJson.name}.json`);
	// 写真实临时JSON，不写仓库内置文件。
	writeFileSync(path, JSON.stringify(themeJson));
	// 显式truecolor避免这一步读缺省终端能力；返回真实Theme。
	return loadThemeFromPath(path, "truecolor");
}

// 每个测试结束后清理状态/文件，无返回；例断言失败仍由Vitest调钩子，但钩子自身错误可中断后续清理。
afterEach(() => {
	// 设空终端报告并换顶层身份，不恢复测试前任意报告。
	setTerminalColors({});
	// splice(0)先清记录表并返回旧目录列表，再逐个递归删除；rm抛错会停止本次循环。
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 把六种主题机制案例归一组，不隐含所有颜色输入都已覆盖。
describe("theme styles", () => {
	// 比较同一示例的Theme.style和通用styleText逐字控制码，验证前/背景与bold组合。
	it("renders theme tokens the same as the generic text styler", () => {
		// 用默认无修改dark副本，已固定truecolor。
		const theme = loadTheme("dark");
		// 期望主题token路径生成与下面具体Color路径完全相同的字符串。
		expect(theme.style("Ready", { fg: "success", bg: "toolSuccessBg", bold: true })).toBe(
			// 先取具体颜色，再交真实通用格式器；只验证Ready这个组合，不证明全部嵌套ANSI行为。
			styleText("Ready", { fg: theme.colors.success, bg: theme.colors.toolSuccessBg, bold: true }, "truecolor"),
		);
	});

	// 用强制非法名字/错槽输入验证运行查表报错，同时保留一条编译期错误指令。
	it("rejects unknown tokens and tokens in the wrong slot", () => {
		// 新建独立主题，避免前一例改动。
		const theme = loadTheme("dark");
		// as never仅绕过静态约束以构造坏输入；expect箭头延迟执行，toThrow检查真实运行错误。
		expect(() => theme.style("x", { fg: "notAToken" as never })).toThrow("Unknown theme color: notAToken");
		// 下一条英文编译指令必须紧邻目标：TS应拒绝背景名放fg；运行时仍应报Unknown theme color。
		// @ts-expect-error background tokens are not foreground colors; use theme.colors.userMessageBg
		expect(() => theme.style("x", { fg: "userMessageBg" })).toThrow("Unknown theme color: userMessageBg");
	});

	// 让accent用OKLCH字面量，验证解析后各通道，不依赖终端实际显示。
	it("loads OKLCH theme values", () => {
		// 编辑回调获得本次JSON副本。
		const theme = loadTheme("dark", (json) => {
			// 62%将被颜色解析器转l=0.62，C=0.1、h=200不变。
			json.colors.accent = "oklch(62% 0.1 200)";
		});
		// toEqual比较对象内容而非引用；只验证此有效样本。
		expect(theme.colors.accent).toEqual({ kind: "oklch", l: 0.62, c: 0.1, h: 200 });
	});

	// 同时覆盖OKHSL变量别名和直接字面量，结果转hex与构造器比较。
	it("loads OKHSL theme values, including through variables", () => {
		// 在写临时JSON前编辑vars和colors。
		const theme = loadTheme("dark", (json) => {
			// 展开已有vars，后置brand覆盖同名；未给vars时对象展开不产生字段。
			json.vars = { ...json.vars, brand: "okhsl(250 60% 55%)" };
			// accent只存别名brand，真实加载时递归解析。
			json.colors.accent = "brand";
			// error直接给另一OKHSL颜色。
			json.colors.error = "okhsl(20 90% 60%)";
		});
		// 变量路径最终hex等于H=250、S=.6、L=.55构造的颜色。
		expect(colorToHex(theme.colors.accent)).toBe(colorToHex(okhslColor(250, 0.6, 0.55)));
		// 直接路径hex同样匹配对应OKHSL，未断言内部一定用哪种Color kind。
		expect(colorToHex(theme.colors.error)).toBe(colorToHex(okhslColor(20, 0.9, 0.6)));
	});

	// 验证明暗声明优先、去声明后按自身色推断、全16色索引时随终端背景。
	it("detects the appearance unless it is declared", () => {
		// 内置dark声明/颜色得到dark。
		expect(loadTheme("dark").appearance).toBe("dark");
		// 内置light得到light。
		expect(loadTheme("light").appearance).toBe("light");
		// Without a declaration, the appearance is detected from the theme's own colors.
		// as const把数组收窄成只读字面元组，base保持dark|light而非宽string。
		for (const base of ["dark", "light"] as const) {
			// 箭头delete移除可选声明，其布尔结果被void回调类型忽略；检查推断仍匹配样本名称。
			expect(loadTheme(base, (json) => delete json.appearance).appearance).toBe(base);
		}
		// 多行expect接一个实际Theme.appearance值。
		expect(
			// 在dark配色上故意声明light。
			loadTheme("dark", (json) => {
				// 显式声明应覆盖自身颜色推断。
				json.appearance = "light";
				// 取本次实例getter结果，不读全局theme代理。
			}).appearance,
			// 断言声明优先为light。
		).toBe("light");

		// Palette colors 0-15 follow the terminal palette, so such themes follow the terminal background.
		// 造只有终端可自定义0..15索引的主题，不能从索引数值认定RGB明暗。
		const paletteOnly = loadTheme("dark", (json) => {
			// 删明暗声明以便进入自动检测。
			delete json.appearance;
			// 测试fixture按名字Bg后缀分0/7；生产拆槽按THEME_TOKENS.slot，不是这条启发式。
			for (const key of Object.keys(json.colors)) json.colors[key] = key.endsWith("Bg") ? 0 : 7;
		});
		// 此时无终端报告，预期缺省dark；测试没有在beforeEach主动清任意外部scheme/env。
		expect(paletteOnly.appearance).toBe("dark");
		// 仅注入固定浅色背景报告，不发终端查询。
		setTerminalColors({ background: { r: 250, g: 250, b: 250 } });
		// 同一paletteOnly实例的appearance getter应随报告变light。
		expect(paletteOnly.appearance).toBe("light");
	});

	// 验证空串token的SGR默认码与具体色getter的报告/猜色两条路径。
	it("renders empty tokens as terminal defaults and reports concrete colors for them", () => {
		// 仅修改本例副本。
		const theme = loadTheme("dark", (json) => {
			// 前景text设终端默认，不是透明。
			json.colors.text = "";
			// 背景同样设默认；槽不同，对应关闭/恢复码不同。
			json.colors.userMessageBg = "";
		});
		// 前景开启和结尾都是39m，原文字x夹在中间。
		expect(theme.fg("text", "x")).toBe("\x1b[39mx\x1b[39m");
		// 背景使用49m；不声称保存/恢复外层任意背景。
		expect(theme.bg("userMessageBg", "x")).toBe("\x1b[49mx\x1b[49m");
		// 无报告的dark主题具体前景猜浅灰。
		expect(colorToHex(theme.colors.text)).toBe("#e5e5e7");
		// 具体背景猜黑色；这是计算/导出色，不影响默认SGR码。
		expect(colorToHex(theme.colors.userMessageBg)).toBe("#000000");

		// 注入前/背景两RGB，setTerminalColors换对象令colors缓存失效。
		setTerminalColors({ foreground: { r: 200, g: 210, b: 220 }, background: { r: 10, g: 20, b: 30 } });
		// 同实例前景具体色更新为报告值，hex是十六进制通道。
		expect(colorToHex(theme.colors.text)).toBe("#c8d2dc");
		// 背景也取报告色；样式码仍依照默认槽而不是改成硬编码RGB。
		expect(colorToHex(theme.colors.userMessageBg)).toBe("#0a141e");
	});
});
