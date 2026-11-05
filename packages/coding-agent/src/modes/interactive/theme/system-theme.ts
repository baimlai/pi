// 由终端上报的前景/背景/16色板推导system主题：有背景时求各用途颜色的亮度，没背景就用ANSI索引/默认色。这里纯算颜色，不查询终端、不保存设置、不直接写屏幕。
/**
 * The `system` theme: pi's colors derived from the terminal's own theme.
 *
 * Every token belongs to a color family (its hue) and has contrast rules: it must reach a contrast level
 * on the background and on the panels it is drawn on. Hue and saturation come from the terminal's palette
 * color for the family's ANSI slot, or from the family's own hue when the terminal reports no palette.
 * Lightness comes from the rules alone. Colors are built in OKHSL, whose saturation is relative to the
 * sRGB gamut, and fade toward gray near black and white. A palette color never gains OKLCH chroma when it
 * moves to another lightness, so pastel palettes stay pastel.
 *
 * A contrast level is a target-lightness curve: the OKLab lightness a token needs, given the lightness of
 * the surface below it. The curves were fitted to the reference theme design from the "Pi themes: system
 * and light/dark" review. On dark backgrounds they aim for nearly fixed lightness; on light backgrounds the
 * required difference grows as the background darkens.
 *
 * Depending on what the terminal reports, the theme is generated in one of three tiers:
 * - background and palette: hues from the palette, lightness from the background;
 * - background only: the families' own hues, lightness from the background;
 * - nothing: ANSI palette indices and the default colors, which the terminal renders itself.
 */
// 这些是实际换色空间函数和RGB构造器，带type的通道接口只供TS检查；OKLab L与OKHSL l不是同一种亮度刻度。

// 同组导入实际函数与带type标记的接口，名字各有用途，并不是都返回同一种颜色空间。
import {
	// 从颜色值取得OKHSL通道：色相按度、饱和度/选色亮度按0..1。
	colorToOkhsl,
	// 取得OKLCH的L/C/h，后面用L解亮度、C限制彩色浓度。
	colorToOklch,
	// 把受限OKLCH等颜色值转回RGB，涉及色域映射，不承诺无损往返。
	colorToRgb,
	// 仅导入OKHSL三通道类型，不生成同名运行值。
	type OkhslChannels,
	// 从OKHSL构造RGB颜色，底层检查有限性与s/l范围，可能抛错。
	okhslColor,
	// 把OKLab亮度L转换为OKHSL选色亮度l，不能直接拿二者当相同值。
	oklabToOkhslLightness,
	// 建立OKLCH颜色值，后面还须colorToRgb才能得到显示RGB。
	oklchColor,
	// 仅使用RGB的r/g/b结构类型，不在类型层确保通道范围。
	type RgbColor,
	// RGB构造器会检查三个有限0..255通道，供换色函数统一处理。
	rgbColor,
} from "@earendil-works/pi-tui";
// 只导入外观/前景token/背景token/全部token类型，运行时不因此执行theme模块，避免依赖类型变成运行循环。
import type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme.ts";

// 公开主题名system常量，调用者用它识别自动适配主题，不是当前用户已经选中它的状态。
export const SYSTEM_THEME_NAME = "system";

// ============================================================================
// Recipe: color families and their tokens
// ============================================================================

/** A family's OKHSL hue and saturation: `max` at mid lightness, falling toward `min` at black and white. */
// 一组相近用途颜色的配方形状；例如blue指定缺色板时的色相/饱和范围，以及色板存在时参考ANSI槽4。
interface Family {
	// 缺色板时的固定色相角，单位度，和RGB红通道无关。
	hue: number;
	// 饱和度随亮度在黑白附近靠min、中间靠max；这是配方数值，不是运行时范围schema。
	saturation: { min: number; max: number };
	/** ANSI palette slot the family takes its hue and saturation from. */
	// 取终端调色板的0..15槽位，number类型本身不限制范围。
	slot: number;
}

// 按色族名保存配方；satisfies检查各项满足Family，同时保留具体键，后面keyof可得有限名字联合。
const FAMILIES = {
	// neutral色族：无色板用231.49度及0.02..0.08饱和曲线，有色板取ANSI槽8的来源色相/浓度，亮度仍由规则决定。
	neutral: { hue: 231.49, saturation: { min: 0.02, max: 0.08 }, slot: 8 },
	// blue色族：无色板用231.49度及0.1..0.68饱和曲线，有色板取ANSI槽4的来源色相/浓度，亮度仍由规则决定。
	blue: { hue: 231.49, saturation: { min: 0.1, max: 0.68 }, slot: 4 },
	// green色族：无色板用158.68度及0.1..0.76饱和曲线，有色板取ANSI槽2的来源色相/浓度，亮度仍由规则决定。
	green: { hue: 158.68, saturation: { min: 0.1, max: 0.76 }, slot: 2 },
	// red色族：无色板用20度及0.1..0.92饱和曲线，有色板取ANSI槽1的来源色相/浓度，亮度仍由规则决定。
	red: { hue: 20, saturation: { min: 0.1, max: 0.92 }, slot: 1 },
	// yellow色族：无色板用82.36度及0.5..1饱和曲线，有色板取ANSI槽3的来源色相/浓度，亮度仍由规则决定。
	yellow: { hue: 82.36, saturation: { min: 0.5, max: 1 }, slot: 3 },
	// orange色族：无色板用52度及0.12..0.85饱和曲线，有色板取ANSI槽3的来源色相/浓度，亮度仍由规则决定。
	orange: { hue: 52, saturation: { min: 0.12, max: 0.85 }, slot: 3 },
	// violet色族：无色板用295度及0.2..0.6饱和曲线，有色板取ANSI槽5的来源色相/浓度，亮度仍由规则决定。
	violet: { hue: 295, saturation: { min: 0.2, max: 0.6 }, slot: 5 },
	// calamine色族：无色板用202.43度及0.1..0.74饱和曲线，有色板取ANSI槽6的来源色相/浓度，亮度仍由规则决定。
	calamine: { hue: 202.43, saturation: { min: 0.1, max: 0.74 }, slot: 6 },
	// thinkingSlate色族：无色板用231.49度及0.08..0.2饱和曲线，有色板取ANSI槽4的来源色相/浓度，亮度仍由规则决定。
	thinkingSlate: { hue: 231.49, saturation: { min: 0.08, max: 0.2 }, slot: 4 },
	// thinkingBlue色族：无色板用231.49度及0.2..0.45饱和曲线，有色板取ANSI槽4的来源色相/浓度，亮度仍由规则决定。
	thinkingBlue: { hue: 231.49, saturation: { min: 0.2, max: 0.45 }, slot: 4 },
	// thinkingPeriwinkle色族：无色板用263.25度及0.3..0.6饱和曲线，有色板取ANSI槽6的来源色相/浓度，亮度仍由规则决定。
	thinkingPeriwinkle: { hue: 263.25, saturation: { min: 0.3, max: 0.6 }, slot: 6 },
	// thinkingViolet色族：无色板用295度及0.4..0.75饱和曲线，有色板取ANSI槽5的来源色相/浓度，亮度仍由规则决定。
	thinkingViolet: { hue: 295, saturation: { min: 0.4, max: 0.75 }, slot: 5 },
	// thinkingMagenta色族：无色板用337.5度及0.5..0.85饱和曲线，有色板取ANSI槽13的来源色相/浓度，亮度仍由规则决定。
	thinkingMagenta: { hue: 337.5, saturation: { min: 0.5, max: 0.85 }, slot: 13 },
	// thinkingRed色族：无色板用20度及0.95..1饱和曲线，有色板取ANSI槽1的来源色相/浓度，亮度仍由规则决定。
	thinkingRed: { hue: 20, saturation: { min: 0.95, max: 1 }, slot: 1 },
} satisfies Record<string, Family>;

// typeof取得配方表类型，keyof取所有键联合，例如blue|green；不生成运行时遍历代码。
type FamilyName = keyof typeof FAMILIES;

// Record要求每个ThemeToken都有色族；这里只指定色相来源，亮度由下方规则求，不是直接把blue写成蓝色hex。
const TOKEN_FAMILIES: Record<ThemeToken, FamilyName> = {
	// 选中项背景采用blue色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	selectedBg: "blue",
	// 搜索命中背景采用orange色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	searchMatchBg: "orange",
	// 用户消息背景采用blue色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	userMessageBg: "blue",
	// 扩展自定义消息背景采用violet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	customMessageBg: "violet",
	// 工具执行中面板背景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolPendingBg: "neutral",
	// 工具成功面板背景采用green色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolSuccessBg: "green",
	// 工具错误面板背景采用red色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolErrorBg: "red",

	// 默认正文前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	text: "neutral",
	// 用户消息正文前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	userMessageText: "neutral",
	// 自定义消息正文前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	customMessageText: "neutral",
	// 工具标题前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolTitle: "neutral",
	// 代码运算符前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxOperator: "neutral",
	// 代码标点前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxPunctuation: "neutral",
	// 次要文字前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	muted: "neutral",
	// 更弱文字前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	dim: "neutral",
	// 模型思考块正文前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingText: "neutral",
	// 工具输出正文前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolOutput: "neutral",
	// Markdown链接地址文字采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdLinkUrl: "neutral",
	// Markdown引用正文采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdQuote: "neutral",
	// Markdown引用边框采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdQuoteBorder: "neutral",
	// Markdown水平分隔线采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdHr: "neutral",
	// Markdown代码围栏采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdCodeBlockBorder: "neutral",
	// 差异中的上下文行采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolDiffContext: "neutral",
	// 代码注释前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxComment: "neutral",
	// 滚动条轨道字符前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	scrollbarTrack: "neutral",
	// 滚动条滑块字符前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	scrollbarThumb: "neutral",
	// 搜索命中文字前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	searchMatchText: "neutral",
	// 弱边框前景采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	borderMuted: "neutral",

	// 主强调色采用violet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	accent: "violet",
	// 强调边框前景采用violet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	borderAccent: "violet",
	// 自定义消息类型标签采用violet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	customMessageLabel: "violet",
	// Markdown行内代码采用violet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdCode: "violet",
	// Markdown列表点号和数字采用violet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdListBullet: "violet",
	// 代码类型名前景采用violet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxType: "violet",
	// 普通边框前景采用blue色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	border: "blue",
	// Markdown链接可读文字采用blue色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdLink: "blue",
	// 代码关键字前景采用blue色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxKeyword: "blue",
	// 代码变量名前景采用calamine色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxVariable: "calamine",
	// 成功状态前景采用green色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	success: "green",
	// Markdown代码块基础正文采用green色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdCodeBlock: "green",
	// 差异中的新增行采用green色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolDiffAdded: "green",
	// 命令模式输入框边框采用green色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	bashMode: "green",
	// 代码数字字面量采用green色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxNumber: "green",
	// 错误状态前景采用red色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	error: "red",
	// 差异中的删除行采用red色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	toolDiffRemoved: "red",
	// 警告状态前景采用yellow色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	warning: "yellow",
	// Markdown标题前景采用yellow色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	mdHeading: "yellow",
	// 代码函数名前景采用yellow色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxFunction: "yellow",
	// 代码字符串字面量采用orange色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	syntaxString: "orange",

	// 关闭思考时的边框采用neutral色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingOff: "neutral",
	// minimal思考档位边框采用thinkingSlate色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingMinimal: "thinkingSlate",
	// low思考档位边框采用thinkingBlue色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingLow: "thinkingBlue",
	// medium思考档位边框采用thinkingPeriwinkle色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingMedium: "thinkingPeriwinkle",
	// high思考档位边框采用thinkingViolet色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingHigh: "thinkingViolet",
	// xhigh思考档位边框采用thinkingMagenta色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingXhigh: "thinkingMagenta",
	// max思考档位边框采用thinkingRed色族；同族共享色相来源，实际亮度由该用途自己的对比规则决定。
	thinkingMax: "thinkingRed",
};

/** Palette slots for tokens that would otherwise share a hue with a similar token. */
// Partial让少数token覆盖色族默认ANSI槽；syntaxString→2、syntaxNumber→5、searchMatchBg→3，减少与相似用途撞色。
const TOKEN_SLOTS: Partial<Record<ThemeToken, number>> = { syntaxString: 2, syntaxNumber: 5, searchMatchBg: 3 };

// ============================================================================
// Contrast levels and rules
// ============================================================================

/**
 * Target-lightness curves: a polynomial in the surface's OKLab lightness giving the OKLab lightness a token
 * needs on it. `reachable` is the range of surface lightness where the level can be reached; beyond it the
 * level is relaxed.
 */
// 一条目标亮度多项式及其适用的底面亮度区间；区间外返回undefined供求解器降低要求，不是颜色通道裁剪。
interface Curve {
	// 数组第0项为常数，第1项乘surfaceL，第2项乘surfaceL²，依此类推。
	coefficients: number[];
	// [number,number]是固定二元元组，依次为可达下界/上界，比较时包含两端。
	reachable: [number, number];
}

// 每个对比等级分别有dark/light曲线；系数是既有设计拟合数据，不是动态训练/模型调用或简单WCAG比值表。
const LEVELS = {
	// panel等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	panel: {
		// panel在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.29131, -0.39746, 2.33185, -0.85524, -1.2076, 0.86276], reachable: [0, 0.979] },
		// panel在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: { coefficients: [-3.74073, 27.94549, -78.44258, 112.6798, -79.60015, 22.11277], reachable: [0.348, 1] },
	},
	// track等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	track: {
		// track在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.39028, -0.23015, 0.83573, 2.43829, -4.38292, 2.01582], reachable: [0, 0.946] },
		// track在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: { coefficients: [-5.24921, 38.37322, -107.28833, 152.10005, -106.17127, 29.18061], reachable: [0.368, 1] },
	},
	// thinking0等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thinking0: {
		// thinking0在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.52988, -0.05809, -0.30924, 4.63567, -6.52933, 2.89108], reachable: [0, 0.873] },
		// thinking0在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thinking0/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-28.27749, 182.85284, -469.62416, 603.15916, -384.59976, 97.35147],
			// thinking0/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.51, 1],
		},
	},
	// thinking1等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thinking1: {
		// thinking1在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.55278, -0.03667, -0.45659, 4.95347, -6.90265, 3.0706], reachable: [0, 0.858] },
		// thinking1在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thinking1/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-37.10484, 235.86282, -596.62344, 754.3633, -474.00763, 118.3551],
			// thinking1/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.535, 1],
		},
	},
	// thinking2等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thinking2: {
		// thinking2在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.57486, -0.01765, -0.58987, 5.25227, -7.27175, 3.25532], reachable: [0, 0.842] },
		// thinking2在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thinking2/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-59.89653, 377.05024, -945.07843, 1182.03145, -734.96375, 181.68658],
			// thinking2/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.556, 1],
		},
	},
	// thinking3等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thinking3: {
		// thinking3在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.59621, -0.00062, -0.71148, 5.53588, -7.6392, 3.44606], reachable: [0, 0.827] },
		// thinking3在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thinking3/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-72.07122, 445.84082, -1099.57352, 1353.88793, -829.53392, 202.26164],
			// thinking3/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.58, 1],
		},
	},
	// thinking4等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thinking4: {
		// thinking4在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.61691, 0.01462, -0.82288, 5.80651, -8.00641, 3.64333], reachable: [0, 0.811] },
		// thinking4在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thinking4/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-110.14338, 674.21488, -1645.75941, 2004.32367, -1215.15899, 293.3183],
			// thinking4/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.6, 1],
		},
	},
	// thinking5等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thinking5: {
		// thinking5在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.63702, 0.02826, -0.92498, 6.06465, -8.37246, 3.84651], reachable: [0, 0.795] },
		// thinking5在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thinking5/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-175.47701, 1063.54495, -2570.70594, 3098.80776, -1860.15527, 444.76392],
			// thinking5/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.62, 1],
		},
	},
	// thinking6等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thinking6: {
		// thinking6在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.65658, 0.04044, -1.01835, 6.30989, -8.73529, 4.05439], reachable: [0, 0.779] },
		// thinking6在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thinking6/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-183.81712, 1094.70055, -2602.68539, 3088.71276, -1826.91131, 430.75931],
			// thinking6/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.643, 1],
		},
	},
	// subtle等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	subtle: {
		// subtle在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.56762, -0.02475, -0.5383, 5.12628, -7.10931, 3.17324], reachable: [0, 0.848] },
		// subtle在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// subtle/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-232.85459, 1376.54473, -3249.11801, 3827.91186, -2248.29472, 526.55751],
			// subtle/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.657, 1],
		},
	},
	// thumb等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	thumb: {
		// thumb在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.60323, 0.00278, -0.73328, 5.57157, -7.68067, 3.46933], reachable: [0, 0.823] },
		// thumb在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// thumb/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-82.89897, 511.01355, -1255.98095, 1540.76821, -940.68087, 228.58523],
			// thumb/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.586, 1],
		},
	},
	// readable等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	readable: {
		// readable在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.66937, 0.04704, -1.06871, 6.43941, -8.9332, 4.17229], reachable: [0, 0.77] },
		// readable在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// readable/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-1554.52576, 8733.56817, -19604.93507, 21977.72696, -12300.99599, 2749.81288],
			// readable/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.751, 1],
		},
	},
	// emphasis等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	emphasis: {
		// emphasis在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.7303, 0.07695, -1.31626, 7.1681, -10.14436, 4.92846], reachable: [0, 0.712] },
		// emphasis在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// emphasis/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-4948.31942, 26870.91986, -58334.48399, 63280.17197, -34298.01053, 7430.30146],
			// emphasis/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.811, 1],
		},
	},
	// textOnPanel等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	textOnPanel: {
		// textOnPanel在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.86713, 0.05232, -0.89428, 4.79014, -5.5432, 1.75023], reachable: [0, 0.542] },
		// textOnPanel在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// textOnPanel/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-8570.89457, 43954.60805, -90084.00702, 92220.6791, -47152.15802, 9632.27113],
			// textOnPanel/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.867, 1],
		},
	},
	// text等级保存两种外观的拟合曲线；名字是本地对比层次，不是WCAG固定比值。
	text: {
		// text在dark外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		dark: { coefficients: [0.89242, 0.02311, -0.44862, 2.34417, -0.06084, -2.63844], reachable: [0, 0.5] },
		// text在light外观的目标曲线：系数按0次到5次排列，reachable是底面OKLab L可达区间。
		light: {
			// text/light六项系数对应常数、L、L²到L⁵，不改变色相或作随机采样。
			coefficients: [-2004.67048, 6664.47299, -6060.70202, -1792.61209, 5133.82359, -1939.85583],
			// text/light底面L适用闭区间；区间外让levelTarget返回undefined，供上层放松。
			reachable: [0.894, 1],
		},
	},
	// satisfies要求各等级同时包含两种外观的Curve，保留具体等级键名，不冻结表或运行时验证系数。
} satisfies Record<string, Record<ThemeAppearance, Curve>>;

// 从LEVELS键推导panel/readable等等级联合，避免自由拼错字符串。
type Level = keyof typeof LEVELS;

// 可作为底面的类型：背景token、终端原背景及scrollbarTrack；联合在TS检查时区分合法名字。
type Surface = ThemeBg | "background" | "scrollbarTrack";

// 一个token在若干底面上需达到某等级的规则，例如toolTitle在三种工具面板上都需textOnPanel。
interface Rule {
	// 要被求解的颜色用途。
	token: ThemeToken;
	// 这项颜色会画在哪些底面，不是额外复制这些面板。
	on: Surface[];
	// 采用LEVELS中的哪一条目标亮度曲线。
	level: Level;
}

// 工具运行中/成功/失败三块底面，后面展开复用同一组规则对象材料。
const TOOL_PANELS: Surface[] = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];
// 用户和扩展消息两种底面。
const MESSAGE_PANELS: Surface[] = ["userMessageBg", "customMessageBg"];
// 需要先作为面板求解、并受极端文字可读性限制的背景token列表。
const PANELS: ThemeBg[] = [
	// userMessageBg：面板背景用途，先于其上的文字求解。
	"userMessageBg",
	// toolPendingBg：面板背景用途，先于其上的文字求解。
	"toolPendingBg",
	// toolSuccessBg：面板背景用途，先于其上的文字求解。
	"toolSuccessBg",
	// toolErrorBg：面板背景用途，先于其上的文字求解。
	"toolErrorBg",
	// selectedBg：面板背景用途，先于其上的文字求解。
	"selectedBg",
	// searchMatchBg：面板背景用途，先于其上的文字求解。
	"searchMatchBg",
	// customMessageBg：面板背景用途，先于其上的文字求解。
	"customMessageBg",
];
// 七种思考档位的前景token，与下面七个等级按数组下标一一对应。
const THINKING: ThemeColor[] = [
	// thinkingOff：思考档位颜色，按此位置对应THINKING_LEVELS。
	"thinkingOff",
	// thinkingMinimal：思考档位颜色，按此位置对应THINKING_LEVELS。
	"thinkingMinimal",
	// thinkingLow：思考档位颜色，按此位置对应THINKING_LEVELS。
	"thinkingLow",
	// thinkingMedium：思考档位颜色，按此位置对应THINKING_LEVELS。
	"thinkingMedium",
	// thinkingHigh：思考档位颜色，按此位置对应THINKING_LEVELS。
	"thinkingHigh",
	// thinkingXhigh：思考档位颜色，按此位置对应THINKING_LEVELS。
	"thinkingXhigh",
	// thinkingMax：思考档位颜色，按此位置对应THINKING_LEVELS。
	"thinkingMax",
];
// 思考档位对应的亮度等级，既有顺序决定映射；类型数组本身不检查它与THINKING长度一致。
const THINKING_LEVELS: Level[] = [
	// thinking0：对应思考档位的目标等级，不是数值token预算。
	"thinking0",
	// thinking1：对应思考档位的目标等级，不是数值token预算。
	"thinking1",
	// thinking2：对应思考档位的目标等级，不是数值token预算。
	"thinking2",
	// thinking3：对应思考档位的目标等级，不是数值token预算。
	"thinking3",
	// thinking4：对应思考档位的目标等级，不是数值token预算。
	"thinking4",
	// thinking5：对应思考档位的目标等级，不是数值token预算。
	"thinking5",
	// thinking6：对应思考档位的目标等级，不是数值token预算。
	"thinking6",
];

// 批量建立规则：输入token列表/共享底面数组/等级，返回每token一项的新数组；例each(["accent"], ["background"], "readable")。对象中的on仍共用传入数组，不深拷贝。
const each = (tokens: ThemeToken[], on: Surface[], level: Level): Rule[] =>
	// map逐token返回对象，({})表示对象字面量；同名属性简写等价token:token等。
	tokens.map((token) => ({ token, on, level }));

// 把各用途的对比要求集中列出；...展开一批规则，多条相同token规则之后会一起约束该颜色。
const RULES: Rule[] = [
	// 每块面板先相对终端背景满足panel等级，成为后续文字的底面。
	...each(PANELS, ["background"], "panel"),
	// 普通正文在原背景上采用text曲线。
	{ token: "text", on: ["background"], level: "text" },
	// 同一正文在选中背景上另加textOnPanel要求，两条不是后者覆盖前者。
	{ token: "text", on: ["selectedBg"], level: "textOnPanel" },
	// 用户消息正文相对用户消息面板求文字对比。
	{ token: "userMessageText", on: ["userMessageBg"], level: "textOnPanel" },
	// 工具标题必须同时适应三种工具面板。
	{ token: "toolTitle", on: TOOL_PANELS, level: "textOnPanel" },
	// 强调/成功/错误/警告相对原背景、选择和工具面板均需readable，数组展开不会新增面板种类。
	...each(["accent", "success", "error", "warning"], ["background", "selectedBg", ...TOOL_PANELS], "readable"),
	// muted虽更弱，也需在列出的各底面达到readable曲线。
	{ token: "muted", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "readable" },
	// dim在相同底面采用更弱subtle等级，与SGR dim效果列表不是同一概念。
	{ token: "dim", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "subtle" },
	// 思考正文只对原背景约束readable。
	{ token: "thinkingText", on: ["background"], level: "readable" },
	// 扩展消息正文在扩展面板和工具面板上需可读。
	{ token: "customMessageText", on: ["customMessageBg", ...TOOL_PANELS], level: "readable" },
	{
		// 多行对象仍是一条规则：目标是扩展消息标签。
		token: "customMessageLabel",
		// 标签可出现在原背景、扩展/选择及三种工具底面上。
		on: ["background", "customMessageBg", "selectedBg", ...TOOL_PANELS],
		// 标签使用readable等级。
		level: "readable",
	},
	// 工具输出文字需适应原背景和工具面板。
	{ token: "toolOutput", on: ["background", ...TOOL_PANELS], level: "readable" },
	// 下面用each给一组Markdown用途创建相同底面/等级规则。
	...each(
		// 标题/链接/URL/行内代码/引用/边框/列表标记这组用途。
		["mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdQuote", "mdCodeBlockBorder", "mdListBullet"],
		// 这些用途可出现在原背景或两种消息面板上。
		["background", ...MESSAGE_PANELS],
		// 统一采用readable等级，并非每种用途相同色相。
		"readable",
	),
	// Markdown代码块正文额外允许在工具面板上显示。
	{ token: "mdCodeBlock", on: ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], level: "readable" },
	// 三种diff用途都相对原背景/工具面板求可读，正负色相由色族映射区分。
	...each(["toolDiffAdded", "toolDiffRemoved", "toolDiffContext"], ["background", ...TOOL_PANELS], "readable"),
	// 为所有语法高亮类别建立readable约束。
	...each(
		[
			// syntaxComment：参与这批语法高亮可读性约束的用途。
			"syntaxComment",
			// syntaxKeyword：参与这批语法高亮可读性约束的用途。
			"syntaxKeyword",
			// syntaxFunction：参与这批语法高亮可读性约束的用途。
			"syntaxFunction",
			// syntaxVariable：参与这批语法高亮可读性约束的用途。
			"syntaxVariable",
			// syntaxString：参与这批语法高亮可读性约束的用途。
			"syntaxString",
			// syntaxNumber：参与这批语法高亮可读性约束的用途。
			"syntaxNumber",
			// syntaxType：参与这批语法高亮可读性约束的用途。
			"syntaxType",
			// syntaxOperator：参与这批语法高亮可读性约束的用途。
			"syntaxOperator",
			// syntaxPunctuation：参与这批语法高亮可读性约束的用途。
			"syntaxPunctuation",
		],
		// 高亮语法会出现在原背景、两种消息及三种工具底面。
		["background", ...MESSAGE_PANELS, ...TOOL_PANELS],
		// 这一批语法用途均以readable作为亮度要求。
		"readable",
	),
	// 搜索命中文字以搜索命中背景为其底面。
	{ token: "searchMatchText", on: ["searchMatchBg"], level: "readable" },
	// bash模式提示与两类边框相对原背景可读。
	...each(["bashMode", "border", "borderAccent"], ["background"], "readable"),
	// 弱边框只要求subtle曲线。
	{ token: "borderMuted", on: ["background"], level: "subtle" },
	// 引用边框/水平线在原背景、消息与工具面板上同样有可读要求。
	...each(["mdQuoteBorder", "mdHr"], ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], "readable"),
	// 滚动条轨道相对终端背景用track等级。
	{ token: "scrollbarTrack", on: ["background"], level: "track" },
	// 滚动条滑块相对已求解轨道用thumb等级，形成依赖关系。
	{ token: "scrollbarThumb", on: ["scrollbarTrack"], level: "thumb" },
	// map使用下标关联七个思考token/等级，返回类型:Rule检查对象形状；没有运行时确认数组长度。
	...THINKING.map((token, index): Rule => ({ token, on: ["background"], level: THINKING_LEVELS[index] })),
];

/** Relaxation compresses levels stronger than this one toward it before weakening all levels. */
// 放松规则的第一阶段先把更强等级压向此下限：dark用readable，light用subtle，之后才整体贴近底面。
const READABLE_FLOOR: Record<ThemeAppearance, Level> = { dark: "readable", light: "subtle" };

/** Body text uses the terminal's foreground when it reaches this level, which is clearly stronger than muted. */
// 决定能否直接沿用终端前景时用emphasis等级，不是所有token都改用此曲线。
const FOREGROUND_LEVEL: Level = "emphasis";

/** Text-level tokens that take the terminal's foreground. */
// 只有这三种正文用途会在后面尝试沿用终端默认前景，扩展消息正文未在列表中。
const FOREGROUND_TOKENS: ThemeColor[] = ["text", "userMessageText", "toolTitle"];

/** WCAG 2 contrast ratio that body text must reach on the surfaces it is drawn on. */
// 正文颜色补偿时目标WCAG对比4.5；不是把所有配色曲线都替换成这个单值。
const TEXT_MINIMUM_WCAG_CONTRAST = 4.5;

/** Tokens in dependency order: every surface before the tokens drawn on it. */
// 立即调用箭头函数在模块求值时计算依赖顺序，只做本地数组遍历；底面先于画在其上的文字。
const SOLVE_ORDER: ThemeToken[] = (() => {
	// 保存已完成遍历的token顺序。
	const order: ThemeToken[] = [];
	// 递归访问某token所依赖的底面，然后再放入自身；例先scrollbarTrack再scrollbarThumb。当前表无环，算法没有访问中集合来检测未来新增环。
	const visit = (token: ThemeToken): void => {
		// 已入结果数组才直接返回；不是在递归前先标记访问中。
		if (order.includes(token)) return;
		// 查所有规则寻找这个token的依赖，不只取第一条规则。
		for (const rule of RULES) {
			// 非当前token规则跳过。
			if (rule.token !== token) continue;
			// 终端原背景无需另求色；其他底面递归访问，确保其颜色在前。
			for (const surface of rule.on) if (surface !== "background") visit(surface);
		}
		// 全部底面完成后把当前token加入结果，同token之后可被includes去重。
		order.push(token);
	};
	// 逐规则发起访问，确保覆盖所有实际有约束的token。
	for (const rule of RULES) visit(rule.token);
	// 返回计算出的数组作为SOLVE_ORDER。
	return order;
})();

// ============================================================================
// Public API
// ============================================================================

// 纯计算输入，可选终端颜色/色板/饱和度/外观提示；TS接口不会查询终端或验证从wire得到的数据。
export interface SystemThemeInput {
	// 终端上报的默认文字RGB，可缺省；存在时影响外观方向及正文前景保留。
	foreground?: RgbColor;
	// 终端上报的默认底色；缺省会直接走ANSI索引方案，即使另给了色板也不做RGB求解。
	background?: RgbColor;
	/** ANSI colors 0-15. */
	// 仅长度恰16才采用此数组，表示ANSI0..15，不是任意256色表。
	palette?: RgbColor[];
	/** Saturation multiplier from 0 (grayscale) to 1. The first frame renders in grayscale until colors arrive. */
	// 饱和度乘子，缺省1；实际入口钳到0..1，number仍可能NaN而未另处理。
	saturation?: number;
	/** Appearance when the terminal did not report its background, e.g. from its light/dark report or COLORFGBG. */
	// 仅没有背景时作为外观结果提示；有背景就按颜色计算，不能强制覆盖它。
	appearanceHint?: ThemeAppearance;
}

// 输出各token颜色、需SGR2弱化的前景token和外观判断，不在这里安装全局主题。
export interface SystemThemeColors {
	/** Hex colors, ANSI palette indices, or "" for the terminal default. */
	// Record要求覆盖全部token；值可hex、ANSI索引或空串默认色，须结合前景/背景槽消费。
	colors: Record<ThemeToken, string | number>;
	/** Foreground tokens rendered faint (SGR 2), for terminals that did not report colors. */
	// 无背景回退方案把弱中性色放进此数组，调用方用SGR2显示；RGB方案返回空数组。
	dim: ThemeColor[];
	// 外观可能未知，字段本身存在但值可undefined。
	appearance: ThemeAppearance | undefined;
}

/** OKLab lightness of an sRGB color, 0-1. */
// 取有效RGB的OKLab L，无副作用；例黑约0、白约1。经rgbColor验证通道，失败可抛；与下方相对亮度Y是不同量。
function oklabLightness(color: RgbColor): number {
	// 先构造RGB颜色值再换OKLCH，只取其中L；不在这里使用C/h。
	return colorToOklch(rgbColor(color.r, color.g, color.b)).l;
}

/** WCAG 2 relative luminance. */
// 按r/g/b参数解构计算相对亮度Y，返回number，无IO；有效黑为0、白为1。先解sRGB传输曲线再加权，不自己验证/钳制任意通道或处理alpha。
export function relativeLuminance({ r, g, b }: RgbColor): number {
	// 局部函数把一个0..255编码通道转线性0..1，供三通道复用，不修改输入。
	const linear = (channel: number) => {
		// 除255把通道标度归一。
		const value = channel / 255;
		// 暗部走线性除法，其余用2.4次幂；**表示乘方，不是异或。
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	// 按固定RGB相对贡献加权相加，绿色权重最大；返回值不是OKLab L。
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 contrast ratio, 1-21. */
// 计算两RGB颜色的WCAG对比值，无IO；例相同色为1、黑白为21。先取两者相对亮度再按较亮/较暗比，不区分传参谁前景。非法数字不另作输入校验。
export function wcagContrast(first: RgbColor, second: RgbColor): number {
	// 求第一个颜色的相对亮度。
	const a = relativeLuminance(first);
	// 求第二个颜色的相对亮度。
	const b = relativeLuminance(second);
	// 分子取大值、分母取小值，各加0.05；这是比例不是亮度差。
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Whether a terminal is dark or light, from its reported colors: the direction of its own foreground
 * when text can be readable that way, otherwise dark when white text has more contrast on the
 * background than black text.
 */
// 用背景和可选前景判断dark/light，返回字面量，无终端查询；例黑底白字为dark。先参考前景方向且该方向黑/白极端色能达4.5，再回退两极端对比更高的一方；不只看背景是否低于0.5。
export function terminalAppearance(background: RgbColor, foreground?: RgbColor): ThemeAppearance {
	// 本地白色参照对象，未带Color的kind标签，wcagContrast接普通RGB。
	const white = { r: 255, g: 255, b: 255 };
	// 黑色参照对象。
	const black = { r: 0, g: 0, b: 0 };
	// 假定白字画此背景时的对比。
	const whiteContrast = wcagContrast(white, background);
	// 假定黑字画此背景时的对比。
	const blackContrast = wcagContrast(black, background);
	// 有上报前景才尝试保留它指示的明暗方向。
	if (foreground) {
		// 前景取OKLab L。
		const foregroundL = oklabLightness(foreground);
		// 背景也取OKLab L，与上面的WCAG亮度比值不同。
		const backgroundL = oklabLightness(background);
		// 前后L差必须严格大于0.05才认为方向有明显意义。
		if (Math.abs(foregroundL - backgroundL) > 0.05) {
			// 前景更亮视为dark，否则light，不直接保证这份前景自身已经4.5。
			const appearance = foregroundL > backgroundL ? "dark" : "light";
			// 按该方向取白/黑的极端对比作为可达到性的判断。
			const best = appearance === "dark" ? whiteContrast : blackContrast;
			// 该方向至少能以极端文字达到4.5才返回它。
			if (best >= TEXT_MINIMUM_WCAG_CONTRAST) return appearance;
		}
	}
	// 没有足够前景依据就选白/黑对比更高的一方；相等选dark。
	return whiteContrast >= blackContrast ? "dark" : "light";
}

// ============================================================================
// Generation
// ============================================================================

// 把有限value夹到[min,max]，纯函数如clamp(2,0,1)得1；Math.min/max不会把NaN自动修为合理值。
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// 解构RGB后返回小写#rrggbb，无IO；如{r:255,g:0,b:0}得#ff0000。四舍五入再补至少2位，不另限制伪造输入的通道。
function hexOf({ r, g, b }: RgbColor): string {
	// map逐通道round→基数16字符串→左补0，再join；padStart不截短超2位值。
	return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** Saturation weight at a lightness: a Gaussian (center 0.5, sigma 0.25), 0 at black and white, 1 in the middle. */
// 返回亮度上的饱和权重：0/1附近降到0，0.5为1；纯数学，无色域或输入范围检查。例bellWeight(0.5)=1，不是直接返回颜色。
function bellWeight(lightness: number): number {
	// 局部高斯函数，中心0.5、标准差0.25，exp为自然指数；返回曲线高度，不改亮度。
	const gaussian = (x: number): number => Math.exp(-((x - 0.5) ** 2) / (2 * 0.25 ** 2));
	// 减去端点高度再归一，使正常0..1区间两端0/中间1，范围外不另钳制。
	return (gaussian(lightness) - gaussian(0)) / (1 - gaussian(0));
}

/** A family's saturation curve relative to its maximum: 1 at mid lightness, `min / max` at black and white. */
// 参数嵌套解构取色族min/max，按亮度返回相对最大饱和的比例；例中点为1、端点min/max。只算比例，不构造颜色；max非正走既有floor1。
function saturationCurve({ saturation: { min, max } }: Family, lightness: number): number {
	// max正才取min/max，否则底线1避免这里直接除零。
	const floor = max > 0 ? min / max : 1;
	// 用bellWeight在底线和1之间插值，不是把sRGB通道线性混合。
	return floor + (1 - floor) * bellWeight(lightness);
}

/** The target lightness for a level on a surface, or undefined where the level cannot be reached. */
// 输入等级/外观/底面OKLab L，返回该曲线所需token亮度或undefined；例超reachable区间交上层放松，不自行截为黑白。纯计算，使用既有拟合系数。
function levelTarget(level: Level, appearance: ThemeAppearance, surfaceL: number): number | undefined {
	// 按两个键索引曲线，显式:Curve把各具体数组结构按公共接口使用。
	const curve: Curve = LEVELS[level][appearance];
	// 底面在区间外就不求多项式，等于上下界仍可求。
	if (surfaceL < curve.reachable[0] || surfaceL > curve.reachable[1]) return undefined;
	// reduce从0累加系数×surfaceL的power次幂，数组下标就是幂次数；输出不在此钳到0..1。
	return curve.coefficients.reduce((sum, coefficient, power) => sum + coefficient * surfaceL ** power, 0);
}

/**
 * Generate the system theme's colors from the terminal's reported colors.
 */
// 从输入生成全部主题颜色，返回{colors,dim,appearance}，不改全局/输入，不IO。流程：无背景用索引→有背景判断外观/色族→按依赖求亮度/必要时放松→限制面板→调整正文。例仅给深背景仍能用默认色族生成hex；只有恰16项色板才取其色相。无任意非法数字兜底，颜色构造可抛，全部规则不等WCAG官方认证。
export function generateSystemThemeColors(input: SystemThemeInput): SystemThemeColors {
	// 缺省饱和1，再夹到0..1；显式0保留灰度，NaN仍会传播。
	const saturation = clamp(input.saturation ?? 1, 0, 1);
	// 对象解构只取得两个字段引用，不复制RGB对象。
	const { background, foreground } = input;
	// 缺背景立即回退，不管前景/色板是否另有值；appearanceHint只在此方案使用。
	if (!background) return indexedColors(saturation, input.appearanceHint);
	// 色板必须length===16才逐项sourceOf，否则忽略；没有检测稀疏空槽等类型无法表达的数据问题。
	const palette = input.palette?.length === 16 ? input.palette.map(sourceOf) : undefined;

	// 有背景时根据实际前后色判断外观，忽略appearanceHint。
	const appearance = terminalAppearance(background, foreground);
	// dark时文字/面板向更亮方向解，light时向更暗方向解。
	const lighter = appearance === "dark";
	// 沿该方向的极端OKLab亮度为1或0，供规则不可达时放松。
	const extreme = lighter ? 1 : 0;
	// 背景L为求解参照，不修改传入背景。
	const backgroundL = oklabLightness(background);

	/**
	 * A token's color at an OKLab lightness. With a palette, the palette color's saturation applies at its
	 * own lightness and falls off toward black and white along the family's curve, never rising above it.
	 */
	// 闭包按token与指定OKLab L生成RGB：无色板用色族配方，有色板保留来源色相/限制饱和色度；例accent走violet族。捕获本次输入，不对外暴露或写全局。
	const paint = (token: ThemeToken, oklabL: number): RgbColor => {
		// 亮度由OKLab刻度换到OKHSL刻度再用于选色。
		const lightness = oklabToOkhslLightness(oklabL);
		// TOKEN_FAMILIES选择该token的色族，表值满足Family接口。
		const family: Family = FAMILIES[TOKEN_FAMILIES[token]];
		// 没有完整16色板走固定配方。
		if (!palette) {
			// 解构该族黑白端点与中间的饱和上下值。
			const { min, max } = family.saturation;
			// 先随亮度插值饱和，再乘用户饱和度，最后构造RGB；不是三原色比例。
			return okhslColor(family.hue, (min + (max - min) * bellWeight(lightness)) * saturation, lightness);
		}
		// 色板存在则优先token特定槽，再族默认槽；??保留槽0，anchored负责迁移亮度。
		return anchored(palette[TOKEN_SLOTS[token] ?? family.slot], family, lightness, saturation);
	};

	/**
	 * The lightness a rule needs on a surface, relaxed by `t`: from 0 to 1, levels stronger than the readable
	 * floor move toward it; from 1 to 2, all levels move toward the surface itself.
	 */
	// 闭包把某等级在底面上的目标按t放松，返回L或undefined；t0不放松，0..1把更强等级压缩至floor，1..2整体贴近底面。例t2距离乘0，不是改色相；仅本求解器按0..2使用。
	const target = (level: Level, surfaceL: number, t: number): number | undefined => {
		// 先查设计曲线的原目标。
		const reached = levelTarget(level, appearance, surfaceL);
		// 无目标且完全不放松时宣告本规则不可达。
		if (reached === undefined && t === 0) return undefined;
		// 可达用原目标，否则用本方向极端值，减底面得有正负的亮度距离。
		const distance = (reached ?? extreme) - surfaceL;
		// 同样计算当前外观可读下限与底面的距离；不可达也退极端。
		const floor = (levelTarget(READABLE_FLOOR[appearance], appearance, surfaceL) ?? extreme) - surfaceL;
		// 下一行决定第一阶段是否压缩更强的目标距离。
		const compressed =
			// 只有原距离绝对值更大才向floor插值，Math.min(t,1)让第一阶段到1就不再继续压这一项。
			Math.abs(distance) > Math.abs(floor) ? distance - (distance - floor) * Math.min(t, 1) : distance;
		// t>1时把剩余距离继续乘(2-t)，最后加回底面L；正常t2得到底面亮度。
		return surfaceL + compressed * (1 - Math.max(0, t - 1));
	};

	/**
	 * Keep a panel light enough (or dark enough) that white (or black) text still reaches the body text
	 * minimum on it. This only matters for backgrounds near mid-gray, where it barely does on the background.
	 */
	// dark用白文字、light用黑文字作面板可读性的极端参考对象。
	const extremeText = lighter ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	// 局部谓词测该极端文字对此面板是否至少4.5，无IO，不证明原始终端前景也能达标。
	const readable = (color: RgbColor) => wcagContrast(extremeText, color) >= TEXT_MINIMUM_WCAG_CONTRAST;
	// 闭包限制面板目标L：初色可读就用，否则在背景L至候选L间二分20次，意图保住极端文字可读性，返回RGB。low起点虽取背景L，未另验证该色族在此L的重建色一定可读；low不必数值更小。
	const limitPanel = (token: ThemeToken, l: number): RgbColor => {
		// 按token/候选亮度先实际构造RGB，后面测试最终颜色而非只测试抽象L。
		const color = paint(token, l);
		// 已经满足极端文字对比就不做二分。
		if (readable(color)) return color;
		// 端点从背景L到目标L；没有先验证paint(token,low)，因此初始low不能直接称已通过端，数值也不保证low<=high。
		let [low, high] = [backgroundL, l];
		// 固定20步求近似边界，没有按任意浮点精度无限循环。
		for (let index = 0; index < 20; index++) {
			// 两端算中点亮度。
			const middle = (low + high) / 2;
			// 中点实际颜色可读，把通过侧移到中点。
			if (readable(paint(token, middle))) low = middle;
			// 否则缩未通过侧，继续靠近背景L；重建色是否可读仍由中点检查决定。
			else high = middle;
		}
		// 最终按low重新生成RGB，不返回抽象L；只有此前命中readable中点才证实该low，末尾没有额外检查/补救。
		return paint(token, low);
	};

	// 单次求解器：给定放松t，依SOLVE_ORDER逐token合并其底面要求，返回颜色Map或undefined。例先有轨道再求滑块；任一目标不可达/越0..1就整体失败，不保存半成品到全局。
	const solve = (t: number): Map<Surface | ThemeToken, RgbColor> | undefined => {
		// Map键是底面/颜色token联合，先把终端原背景放进去，RGB对象按引用保存。
		const colors = new Map<Surface | ThemeToken, RgbColor>([["background", background]]);
		// 依模块初始化的依赖顺序处理所有受约束token。
		for (const token of SOLVE_ORDER) {
			// 收集当前token在所有规则/底面上的目标L。
			const targets: number[] = [];
			// 遍历全规则而不是找到第一条就结束。
			for (const rule of RULES) {
				// 不属于当前token的规则跳过。
				if (rule.token !== token) continue;
				// 同规则可能有多个底面，逐个求限制。
				for (const surface of rule.on) {
					// 取已解底面色，缺失才原背景兜底；换成OKLab L后查当前t目标。
					const value = target(rule.level, oklabLightness(colors.get(surface) ?? background), t);
					// 任一目标缺失或落0..1外立即失败；没有额外Number.isFinite，NaN比较有自己的JS语义。
					if (value === undefined || value < 0 || value > 1) return undefined;
					// 有效目标按遍历次序保存。
					targets.push(value);
				}
			}
			// dark取最亮目标、light取最暗目标以同时适应各底面，...把数组展开为Math参数。
			const l = lighter ? Math.max(...targets) : Math.min(...targets);
			// 面板才加limitPanel，其他用paint；as ThemeBg只是让includes接受联合token，不改变该值或判断为背景。
			colors.set(token, PANELS.includes(token as ThemeBg) ? limitPanel(token, l) : paint(token, l));
		}
		// 全部token求完返回局部Map，Map不自动冻结。
		return colors;
	};

	// 先记录完全不放松t0。
	let relaxation = 0;
	// 尝试原始全部曲线约束。
	let colors = solve(0);
	// 求解失败才搜索最小可行放松量，不因Map为空而误判（对象真值）。
	if (!colors) {
		// Mid-gray backgrounds cannot fit every level: relax as little as possible. Full relaxation always fits.
		// 在0到2的放松区间二分，正常完整放松会把目标压到各底面。
		let [low, high] = [0, 2];
		// 先求t2作为可行端点；后面的??仍保留没有Map时的兜底，不对任意坏输入承诺成功。
		colors = solve(high);
		// 固定20轮搜索近似最小可行t，不是精确解析解。
		for (let index = 0; index < 20; index++) {
			// 取当前放松区间中点。
			const middle = (low + high) / 2;
			// 重做完整求解，各次都有独立局部Map。
			const attempt = solve(middle);
			// 可行就同时更新上界与最近成功Map，解构赋值右侧先求值。
			if (attempt) [high, colors] = [middle, attempt];
			// 不可行就提升下界，允许放松更多。
			else low = middle;
		}
		// 保存最后可行侧t，后面选终端前景时用同样放松量。
		relaxation = high;
	}
	// 仍没Map就用新的空Map，之后缺色可回默认；这不是吞掉颜色构造抛出的异常。
	const solved = colors ?? new Map<Surface | ThemeToken, RgbColor>();
	// 闭包给一个token找其全部实际底面RGB，返回新数组；例toolTitle列出三块工具面板，可重复，不去重。
	const surfacesOf = (token: ThemeToken) =>
		// 先筛该token规则，再flatMap把每规则底面数组拍平一层。
		RULES.filter((rule) => rule.token === token).flatMap((rule) =>
			// 每个底面从已解Map取色，缺省用原背景。
			rule.on.map((surface) => solved.get(surface) ?? background),
		);

	// 先断言空对象最终会补全Record，各键真正写入在下一循环，as本身不创建任何键。
	const result = {} as Record<ThemeToken, string | number>;
	// 遍历配方里全部用途键，断言把Object.keys的string[]视为已知token[]。
	for (const token of Object.keys(TOKEN_FAMILIES) as ThemeToken[]) {
		// 找该token的求解RGB对象，可能缺省。
		const color = solved.get(token);
		// 有颜色就编码hex，没有就用空串让终端默认色，不把undefined放进结果字典。
		result[token] = color ? hexOf(color) : "";
	}

	// 对三种正文用途再做前景保留/文字对比补偿，不给所有彩色token同样处理。
	for (const token of FOREGROUND_TOKENS) {
		// 取该正文实际使用的各底面颜色。
		const surfaces = surfacesOf(token);
		// Body text uses the terminal's own foreground where it is clearly stronger than muted text; otherwise
		// the foreground's hue at just enough lightness.
		// 初始候选是刚求出的正文色，let允许稍后改为终端前景同色相的新色。
		let text = solved.get(token);
		// 有终端前景才考虑直接使用它或沿其色相调整。
		if (foreground) {
			// 采用emphasis基准计算保留前景的目标；原等级较强，但放松到下限/底面后可与较弱等级收敛，不保证始终严格高于muted。
			const targets = surfaces.map((surface) => target(FOREGROUND_LEVEL, oklabLightness(surface), relaxation));
			// 所有目标必须存在且在0..1内才采用这段；every空数组真值是JS规则，当前正文规则实际有底面。
			if (targets.every((value) => value !== undefined && value >= 0 && value <= 1)) {
				// 前面every已检查，as number[]不运行过滤；dark取最亮要求，light取最暗要求。
				const needed = lighter ? Math.max(...(targets as number[])) : Math.min(...(targets as number[]));
				// 当前终端前景取OKLab L。
				const foregroundL = oklabLightness(foreground);
				// 前景在所需方向足够远才沿用默认色，这里比较L门槛，不另调用withTextContrast检查原前景。
				if (lighter ? foregroundL >= needed : foregroundL <= needed) {
					// 空串表示让终端使用自己的默认前景，不是透明RGB。
					result[token] = "";
					// 直接沿用时跳过本token后面的文字补偿，不能把下面4.5检查说成每次都执行。
					continue;
				}
				// 否则用终端前景作为来源色，在neutral饱和曲线及所需L处重建，保留其色相/色度限制。
				text = anchored(sourceOf(foreground), FAMILIES.neutral, oklabToOkhslLightness(needed), saturation);
			}
		}
		// Body text keeps at least 4.5:1 on the surfaces it is drawn on, even on relaxed mid-gray backgrounds.
		// 有文字候选才调用实际WCAG补偿，再编码hex；不是对所有结果包括空串都做这一检查。
		if (text) result[token] = hexOf(withTextContrast(text, surfaces, lighter));
	}
	// 返回颜色表、空dim数组及推导外观；RGB模式不用SGR2弱化列表。
	return { colors: result, dim: [], appearance };
}

// 解构RGB后返回OKHSL通道对象，无IO；如灰色饱和近0。RGB构造会拒绝非法通道，输出不是Color标签值。
function okhslOf({ r, g, b }: RgbColor): OkhslChannels {
	// 用rgbColor检查通道，再colorToOkhsl换算，不直接把RGB数字当h/s/l。
	return colorToOkhsl(rgbColor(r, g, b));
}

/** A terminal color's OKHSL channels and its OKLCH chroma. */
// 接口继承OKHSL h/s/l，再加来源OKLCH色度；extends在这里是类型合成，不是运行时类继承。
interface SourceColor extends OkhslChannels {
	// 额外保留绝对色度C，避免相同OKHSL相对饱和换亮度后颜色反而过浓。
	chroma: number;
}

// 取得来源的h/s/l与绝对chroma，返回新对象无IO；例如色板粉色作为之后调亮/调暗的锚，输入不修改。
function sourceOf(color: RgbColor): SourceColor {
	// 对象展开复制通道字段，再从同一RGB取得C；这里会分别作两次换算，不共享内部结果缓存。
	return { ...okhslOf(color), chroma: colorToOklch(rgbColor(color.r, color.g, color.b)).c };
}

/**
 * A source color's hue at another OKHSL lightness. Its saturation applies at its own lightness and falls off
 * toward black and white along the family's saturation curve, never rising above it.
 *
 * OKHSL saturation is relative to the most chroma sRGB allows at a lightness, so the same saturation can mean
 * more chroma elsewhere: Catppuccin Frappe's pink #f4b8e4 (chroma 0.089) would become #eb76d1 (0.180) at the
 * lightness the accent needs. Chroma is therefore also capped at the source's, with the same falloff.
 */
// 把来源色迁移到新OKHSL亮度并限制饱和/绝对C，返回RGB，无IO；例粉彩换亮度仍限制在来源C附近。先算曲线衰减→造RGB→若C过cap再重建OKLCH并映回RGB，离散取整有误差，不承诺完全精确保持原色相。
function anchored(source: SourceColor, family: Family, lightness: number, saturation: number): RgbColor {
	// 先读来源亮度处该族的相对饱和曲线作分母锚点。
	const anchor = saturationCurve(family, source.l);
	// 目标/来源曲线比最多1，避免往其他亮度走时放大；分母非正走1，不直接除零。
	const falloff = anchor > 0 ? Math.min(1, saturationCurve(family, lightness) / anchor) : 1;
	// 来源色相与相对饱和乘衰减及全局饱和度，构造目标亮度RGB。
	const color = okhslColor(source.h, source.s * falloff * saturation, lightness);
	// 来源绝对C也按相同衰减/全局饱和度限制；同相对饱和不代表同绝对色度。
	const cap = source.chroma * falloff * saturation;
	// 转换刚造的RGB，读实际L/C，包括RGB量化后的结果。
	const { l, c } = colorToOklch(color);
	// 没超cap保留该RGB，否则以实际L/限制C/来源色相构造OKLCH再转RGB，后一步有色域映射/取整。
	return c <= cap ? color : colorToRgb(oklchColor(l, cap, source.h));
}

/** Move a text color toward white or black until it reaches the WCAG minimum on every surface. */
// 让文字沿同h/s往白或黑调整，返回尽量达各底面4.5的RGB；已满足原样返回，否则先试极端，再二分20步。例某底面仍不可能达标时直接返回极端，即函数有不能满足所有底面的回退，不能宣称任意输入都保证4.5。
function withTextContrast(color: RgbColor, surfaces: RgbColor[], lighter: boolean): RgbColor {
	// 局部谓词判断候选在所有底面上的实际WCAG对比。
	const meets = (candidate: RgbColor) =>
		// every逐底面检查>=4.5；空底面数组按JS语义直接true。
		surfaces.every((surface) => wcagContrast(candidate, surface) >= TEXT_MINIMUM_WCAG_CONTRAST);
	// 已达标返回原颜色对象，不做不必要的二分。
	if (meets(color)) return color;
	// 取原文字色的OKHSL通道，后面保持h/s，仅改变l。
	const { h, s, l } = okhslOf(color);
	// 局部颜色工厂给一个新l返回RGB，构造仍可能抛错。
	const at = (lightness: number) => okhslColor(h, s, lightness);
	// dark向白l1，light向黑l0；high是目标方向，不必比low数值大。
	const extreme = lighter ? 1 : 0;
	// 极端都无法对所有底面达标时仍返回极端，没有抛错或重新换方向。
	if (!meets(at(extreme))) return at(extreme);
	// 从原亮度到已通过的极端建立二分两端。
	let [low, high] = [l, extreme];
	// 固定20步找更接近原色且可读的边界。
	for (let index = 0; index < 20; index++) {
		// 算两端亮度中点。
		const middle = (low + high) / 2;
		// 中点可读就把通过端high拉近。
		if (meets(at(middle))) high = middle;
		// 否则移动未通过端low，不比较绝对数值大小来决定方向。
		else low = middle;
	}
	// 返回可读端重建的最终RGB，实际精度受颜色编码离散值影响。
	return at(high);
}

/**
 * Colors for terminals that reported nothing: the terminal renders ANSI indices 0-15 and the default
 * colors with its own theme, so they fit any background. Neutral tokens below body text are faint (SGR 2)
 * instead of bright black, which some themes make nearly invisible. Panels have no background.
 */
// 没有背景的回退方案：面板用默认背景，非中性色选ANSI槽，其余用默认前景，较弱中性色另列dim；返回完整表/外观提示，无IO。例saturation0时彩色也回默认，不会生成任意中间灰度索引。
function indexedColors(saturation: number, appearance: ThemeAppearance | undefined): SystemThemeColors {
	// 先声明空Record视图，循环实际填充全部用途，断言不生成默认键。
	const colors = {} as Record<ThemeToken, string | number>;
	// 另收需要SGR2的前景用途名。
	const dim: ThemeColor[] = [];
	// Object.entries变成[token,族名]数组，再断言为这些有限联合元组，不运行验证。
	for (const [token, familyName] of Object.entries(TOKEN_FAMILIES) as [ThemeToken, FamilyName][]) {
		// 面板列表里的token走默认背景，不用对应色族的ANSI槽当实色底。
		if (PANELS.includes(token as ThemeBg)) {
			// 空串交消费方按背景槽解释为默认底色。
			colors[token] = "";
			// 面板处理完跳过前景/弱化逻辑。
			continue;
		}
		// 是否属于neutral族，后面决定默认前景与弱化。
		const neutral = familyName === "neutral";
		// 非neutral且饱和度只要>0就选整数ANSI槽（不是按乘子混色）；其余空串默认前景。??可保留槽0。
		colors[token] = !neutral && saturation > 0 ? (TOKEN_SLOTS[token] ?? FAMILIES[familyName].slot) : "";
		// neutral中非三种正文用途加入dim列表；as只满足类型视图，具体前景/背景区分由前面的panel分支保证。
		if (neutral && !FOREGROUND_TOKENS.includes(token as ThemeColor)) dim.push(token as ThemeColor);
	}
	// 返回索引表、弱化用途及原appearance提示，不再推断未上报的底色。
	return { colors, dim, appearance };
}
