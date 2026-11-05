// 验证JSON里显式export颜色的变量与CSS转换，读固定内置主题再写自建tmp；没有网络/模型/HTML浏览器。
// 用真实OKHSL构造与hex转换作参照，未启动终端查询/watch。
import { colorToHex, okhslColor } from "@earendil-works/pi-tui";
// 文件函数只操作每例随机临时目录与仓库内置JSON。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
// 从OS取得临时目录根。
import { tmpdir } from "os";
// 按平台拼agent/themes路径。
import { join } from "path";
// Vitest管理每例设置/清理与内容断言。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 真实JSON export解析器；它遇错误会返回{}，这些用例只覆盖有效配置。
import { getThemeExportColors } from "../src/modes/interactive/theme/theme.ts";

// 测试JSON的最小TS形状；字段声明不做运行时数据校验。
type ThemeFile = {
	// 名称决定加载时的自定义主题键。
	name: string;
	// 可选vars允许多层别名和数值索引。
	vars?: Record<string, string | number>;
	// 继承内置colors只为保持主题文件完整，此组断言主要看export。
	colors: Record<string, string | number>;
	// export是可选三背景配置对象，与TS export关键字在此没有关系。
	export?: {
		// 页面背景可为颜色字面量、变量名或索引数。
		pageBg?: string | number;
		// 卡片背景同类值。
		cardBg?: string | number;
		// 信息区域背景同类值。
		infoBg?: string | number;
	};
};

// 三例每次切PI_CODING_AGENT_DIR到自己的tmp路径，再按原值恢复。
describe("getThemeExportColors", () => {
	// 由beforeEach赋本次根路径；类型声明不自动初始化。
	let tempRoot: string;
	// 保留原env值，undefined与空串需分别恢复。
	let previousAgentDir: string | undefined;

	// 每例前创建独立主题目录并切配置根；仅固定tmp写入，不触用户原目录。
	beforeEach(() => {
		// mkdtemp创建随机目录。
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-export-"));
		// 保存原配置根字符串或undefined。
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		// 只改当前测试进程env，config会实时读此值。
		process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
		// 递归建agent/themes供待测函数按名字读取。
		mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "themes"), { recursive: true });
	});

	// 每例后先删tmp再恢复env；钩子不是finally包裹两步，rmSync若抛会跳过恢复。
	afterEach(() => {
		// force容忍不存在，但不保证任何删除失败都吞掉。
		rmSync(tempRoot, { recursive: true, force: true });
		// 原变量缺失时必须delete，不能赋字符串undefined。
		if (previousAgentDir === undefined) {
			// 还原真正缺失状态。
			delete process.env.PI_CODING_AGENT_DIR;
			// 原来有值（含空串）则走赋回。
		} else {
			// 恢复先前字符串，不触其他环境键。
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	// 多层pageBgAlias→pageBgVar和另外两直接变量应都解析成预期hex文字。
	it("resolves export variable references using the same syntax as colors", () => {
		// 读固定内置dark为基础，JSON.parse新建对象。
		const darkTheme = JSON.parse(
			// import.meta.url保证相对本测试文件定位，不依赖临时cwd。
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
			// as ThemeFile不验证内容，样本来自仓库。
		) as ThemeFile;

		// 带静态类型构造新JSON，后续只写本例tmp。
		const customTheme: ThemeFile = {
			// 浅展开内置字段，后置name/vars/export覆盖各自字段。
			...darkTheme,
			// 唯一名称与下方文件名一致。
			name: "custom-export-vars",
			// 构造变量表，不修改darkTheme.vars原对象。
			vars: {
				// 保留原vars；未给时用空对象作展开源。
				...(darkTheme.vars ?? {}),
				// 页面叶子色。
				pageBgVar: "#112233",
				// 页面再加一层别名。
				pageBgAlias: "pageBgVar",
				// 信息区域叶子色。
				infoBgVar: "#445566",
				// 卡片叶子色。
				cardBgVar: "#223344",
			},
			// 独立export区引用变量名字，不把值提前解出来。
			export: {
				// pageBg先指别名，再由真实函数递归到叶子。
				pageBg: "pageBgAlias",
				// cardBg直接指卡片变量。
				cardBg: "cardBgVar",
				// infoBg直接指信息变量。
				infoBg: "infoBgVar",
			},
		};

		// 将JSON写到真实自建主题目录以覆盖按名字读文件这条路径。
		writeFileSync(
			// !是非空断言，基于beforeEach已赋env，不自动检查运行时。
			join(process.env.PI_CODING_AGENT_DIR!, "themes", "custom-export-vars.json"),
			// JSON.stringify第三参数2只控制文件缩进。
			JSON.stringify(customTheme, null, 2),
		);

		// 按名称读取并对返回对象逐字段比较。
		expect(getThemeExportColors("custom-export-vars")).toEqual({
			// 页面两层别名最终为#112233。
			pageBg: "#112233",
			// 卡片变量为#223344。
			cardBg: "#223344",
			// 信息变量为#445566。
			infoBg: "#445566",
		});
	});

	// CSS不能直接用OKHSL，测试其转hex，同时已支持的OKLCH保持原串。
	it("converts OKHSL export colors to hex because CSS does not support them", () => {
		// 再次独立读dark样本。
		const darkTheme = JSON.parse(
			// 固定仓库URL，不读用户主题。
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
			// 类型断言只供编辑字段。
		) as ThemeFile;
		// 构造第二份自定义配置。
		const customTheme: ThemeFile = {
			// 沿用内置其余字段。
			...darkTheme,
			// 给第二例不同名字。
			name: "custom-export-okhsl",
			// 卡片色走变量，20%是S、20%是OKHSL亮度。
			vars: { card: "okhsl(250 20% 20%)" },
			// 页面直接OKHSL/卡片别名/信息OKLCH三种形式并列。
			export: { pageBg: "okhsl(250 20% 15%)", cardBg: "card", infoBg: "oklch(30% 0.05 80)" },
		};
		// 序列化到本例tmp。
		writeFileSync(
			// 文件名与请求名称保持一致，!不添加路径校验。
			join(process.env.PI_CODING_AGENT_DIR!, "themes", "custom-export-okhsl.json"),
			// 生成格式化JSON文本，无主题执行。
			JSON.stringify(customTheme, null, 2),
		);

		// 真实导出解析结果应匹配下面转换参照。
		expect(getThemeExportColors("custom-export-okhsl")).toEqual({
			// 页面H250/S.2/L.15经真实颜色库得到hex。
			pageBg: colorToHex(okhslColor(250, 0.2, 0.15)),
			// 卡片先解别名再转换，L为.2。
			cardBg: colorToHex(okhslColor(250, 0.2, 0.2)),
			// OKLCH字面串本来CSS可用，应原样保留，不强制hex。
			infoBg: "oklch(30% 0.05 80)",
		});
	});

	// 再测递归变量、固定256色索引与终端默认空串不覆盖CSS。
	it("resolves recursive vars and converts 256-color export values to hex", () => {
		// 读取第三例独立基础对象。
		const darkTheme = JSON.parse(
			// 仍只访问仓库dark.json。
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
			// as不做schema验证。
		) as ThemeFile;

		// 新JSON对象，不修改前面例子。
		const customTheme: ThemeFile = {
			// 浅展开内置基础字段。
			...darkTheme,
			// 第三例主题名称。
			name: "custom-export-recursive",
			// 为这例构造变量表。
			vars: {
				// 保留已有变量。
				...(darkTheme.vars ?? {}),
				// 页面颜色叶子。
				deepPageBg: "#abcdef",
				// 别名指向叶子名。
				pageBgAlias: "deepPageBg",
				// 卡片变量为索引24，colorToHex用库内固定256色表近似。
				cardBgAnsi: 24,
			},
			// export字段仍保存引用而非预先解值。
			export: {
				// 页面经两层引用。
				pageBg: "pageBgAlias",
				// 卡片经变量得到数字索引。
				cardBg: "cardBgAnsi",
				// 空串代表终端默认，在CSS显式覆盖中应变undefined。
				infoBg: "",
			},
		};

		// 将第三份JSON写入自建临时主题目录。
		writeFileSync(
			// 按测试名拼文件路径，env基于beforeEach非空。
			join(process.env.PI_CODING_AGENT_DIR!, "themes", "custom-export-recursive.json"),
			// 序列化对象，未改变产品默认配置。
			JSON.stringify(customTheme, null, 2),
		);

		// 比较输出含三个键的对象；undefined键与完全没有export返回{}有区别。
		expect(getThemeExportColors("custom-export-recursive")).toEqual({
			// 递归后得到页面叶子hex。
			pageBg: "#abcdef",
			// 索引24对应#005f87，不代表自定义终端调色板任意颜色。
			cardBg: "#005f87",
			// 空串导出值undefined，不把终端默认猜成CSS颜色。
			infoBg: undefined,
		});
	});
});
