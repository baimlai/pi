// Looks and themes (slice 11 §4b, decision "Looks and themes", `docs/theming/`): a theme is data in one registry,
// `Themes`, that plugins contribute to on any host kind; a page writes the active theme as CSS custom properties on
// `:root`, a terminal looks colours up by role. A theme names a colour for each role (the kit's base roles, and roles
// an app adds), with `web` extras (more CSS variables: radii, fonts) and `tui` overrides (a colour per role for
// terminals). The user picks one dark and one light theme (`ThemeChoice`); the system's mode chooses between them.

//
// 文件导读
// 所属：packages/chord 的 surfaces 层，定义主题数据模型、注册表、激活选择与终端颜色换算。
// 职责边界：只提供纯数据与纯函数：主题形状、BASE_ROLES、Themes 注册表、themesFacet、内置 fallback、activeTheme、
// themeVariables、terminalColor 及私有颜色换算；不写 DOM、不读取用户设置、不监听系统模式（这些在 active-theme.ts、
// theme-choice.ts 和各客户端实现中）。上游：插件通过 Themes 注册表贡献主题，客户端从注册表与 ThemeChoice 取值；
// 下游：CSS 变量写入、终端 SGR 序列生成。错误：本文件不抛业务错误；无法解析为 #rrggbb 或 0..255 索引的颜色
// 在终端里回落到默认色。
// 能力清单：
// - BASE_ROLES / BaseRole：基础角色元组及其字面量联合。
// - Theme：主题数据类型（id、名称、mode、颜色、web 额外变量、tui 覆盖）。
// - Themes：主题注册表（贡献 Theme，组合为 readonly Theme[]）。
// - themesFacet：声明 Themes provider 的 facet 工厂。
// - FALLBACK_THEMES：无插件贡献时的深/浅默认主题。
// - ThemePick / activeTheme：用户选择与按 mode 选出生效主题。
// - themeVariables：把主题转换为 CSS 自定义属性表。
// - ColorDepth / terminalColor：真彩或 256 色下按角色生成 SGR 参数。
// - parseHex（私有）/ CUBE（私有）/ nearest256（私有）：十六进制解析与 xterm 调色板近似。
// 组合与顺序：插件贡献 → themesFacet compose 为有序数组 → 客户端结合 ThemeChoice.pick 与 mode 调 activeTheme →
// 页面用 themeVariables 写 CSS，终端用 terminalColor 生成颜色；没有候选时 activeTheme 返回 FALLBACK_THEMES。
// 示例：`activeTheme(themes, { dark: "midnight", light: null }, "light")` 会在 light 主题中找 id "midnight"，
// 找不到就用第一个 light 主题；仍没有则返回 FALLBACK_THEMES.light。
// 阅读顺序：BASE_ROLES/Theme/Themes → themesFacet → FALLBACK_THEMES/ThemePick → activeTheme/themeVariables →
// terminalColor → parseHex/nearest256。

import type { Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import { defineRegistry, type Registry } from "../registries/index.ts";

/** The roles every theme names: the kit's base set. Apps add their own roles; themes fill at least these. */
// as const 保留各个字符串字面量，并把数组变为只读元组；不会在运行时冻结它。
export const BASE_ROLES = ["accent", "bg", "fg", "muted", "error", "warning", "success"] as const;

/** A base role. */
// typeof 取上方值的类型，[number] 表示元组所有元素类型的联合，如 "accent" | "bg"。
export type BaseRole = (typeof BASE_ROLES)[number];

/** A theme: an id, a name, its mode, a colour per role (CSS colours; `#rrggbb` for terminals), web and terminal extras. */
// readonly 是编译期约束；colors 的交叉类型 & 要求基础角色齐全，同时允许应用自定义角色。
// 主题是普通数据，可以在插件间传递；本文件不对运行时形状做 schema 校验，插件作者负责提供合法值。
export type Theme = {
	// 稳定标识，ThemePick 按它匹配；注册表不强制唯一，activeTheme 只取第一个匹配项。
	readonly id: string;
	// 展示给用户的名称，不参与匹配。
	readonly name: string;
	// 深/浅模式；activeTheme 先按它过滤，再按 id 选择。
	readonly mode: "dark" | "light";
	// 角色 → 颜色。类型层要求 BASE_ROLES 全部存在；额外的应用自定义角色通过索引签名允许。
	// 终端只解析 #rrggbb 或 0..255 的数字串，其他 CSS 颜色在终端里回落到默认色。
	readonly colors: Readonly<Record<BaseRole, string>> & Readonly<Record<string, string>>;
	/** More CSS variables on `:root`, by name without `--` (`radius`, `font`); URLs of the plugin's assets allowed. */
	// web 额外变量：键不带 `--`，themeVariables 会补前缀；同名键会覆盖 colors 生成的变量。
	readonly web?: Readonly<Record<string, string>>;
	/** Terminal colours by role, before `colors`: `#rrggbb` or an xterm 256-colour index (`"208"`). */
	// tui 按角色覆盖 colors，优先级最高；值可以是 #rrggbb 或数字索引字符串。
	readonly tui?: Readonly<Record<string, string>>;
};

/** The themes plugins contribute, in plugin-name order; served on every client and on the server by the kit. */
// defineRegistry 声明共享 token，实际 provider 由 themesFacet 注册；类型参数分别表示贡献 Theme 和组合数组。
// 注册表按插件名稳定排序，同 ID 的多个贡献都保留；选择时按顺序取第一个匹配，因此后贡献者不会自动覆盖前者。
export const Themes: Registry<Theme, readonly Theme[]> = defineRegistry<Theme, readonly Theme[]>("chord.themes", {
	version: 1,
});

/** The kit's facet serving `Themes` on a host: the contributions as they are, in plugin-name order. */
/** 创建一个只声明 Themes provider 的 facet，无参数，返回应用身份 P 的 Facet。
 * host.load 执行 setup 时才 serve；compose 从有序贡献表提取 value，不复制主题对象。
 * 例如两个插件各贡献一项，结果就是按插件名排列的两个主题；冲突 ID 不在这里去重或校验。
 */
export function themesFacet<P extends Principal>(): Facet<P> {
	// setup 声明注册表；map 的解构忽略 plugin，只保留每个贡献的原值引用。
	return defineFacet<P>((host) => host.serve(Themes, { compose: (table) => table.map(({ value }) => value) }));
}

/** The theme used when no plugin contributed one of a mode: neutral colours. */
// Readonly<Record<Theme["mode"], Theme>> 要求 dark/light 两项都存在；这些默认颜色是原始配置数据。
// 只有 activeTheme 在所有贡献主题都缺失对应模式时才会用到；它不参与注册表组合，插件也不能修改这个对象。
export const FALLBACK_THEMES: Readonly<Record<Theme["mode"], Theme>> = {
	// 深色 fallback：id 使用 chord. 前缀，通常不会与插件主题重名。
	dark: {
		id: "chord.dark",
		name: "Dark",
		mode: "dark",
		// 七个基础角色全部给出；终端可直接解析这些 #rrggbb 值。
		colors: {
			accent: "#4c9aff",
			bg: "#16181d",
			fg: "#e6e6e6",
			muted: "#8a8f98",
			error: "#ff6b6b",
			warning: "#f0b429",
			success: "#3ecf8e",
		},
	},
	// 浅色 fallback：与深色一一对应，保证对比度适合浅背景。
	light: {
		id: "chord.light",
		name: "Light",
		mode: "light",
		colors: {
			accent: "#0b62d6",
			bg: "#ffffff",
			fg: "#1c1e21",
			muted: "#6b7280",
			error: "#c62828",
			warning: "#b26a00",
			success: "#1b7f4b",
		},
	},
};

/** The user's choice: a theme id for dark and one for light (`null`: the first contributed of that mode). */
// null 明确表示未指定 ID；与对象缺少 dark/light 属性不同。
export type ThemePick = { readonly dark: string | null; readonly light: string | null };

/** The active theme for `mode`: the one `pick` names if contributed, else the first of that mode, else the fallback. */
/** 根据主题列表、每种模式的用户选择和当前 mode 返回一个主题；只创建过滤数组，不改输入。
 * 先限制深浅模式，再找所选 ID，找不到则取该模式第一项，仍为空才取内置 fallback。
 * 例如 light 模式不会选中列表里同 ID 的 dark 主题；null 或失效 ID 都落到第一项。
 */
export function activeTheme(themes: readonly Theme[], pick: ThemePick, mode: Theme["mode"]): Theme {
	// 索引访问按 mode 读取 dark 或 light 对应的 ID/null。
	const wanted = pick[mode];
	// filter 遍历贡献列表并保持原先相对顺序。
	const ofMode = themes.filter((theme) => theme.mode === mode);
	// ?? 只在 null/undefined 时走下一项；find 返回第一个匹配主题。
	return ofMode.find((theme) => theme.id === wanted) ?? ofMode[0] ?? FALLBACK_THEMES[mode];
}

/** The CSS custom properties of `theme`: `--<role>` for every colour, then `--<name>` for each `web` extra. */
/** 将主题转为 CSS 变量表并返回新对象；不写 DOM、不验证 CSS。
 * 例如 colors.accent 产生 --accent；web.accent 若存在会后写并覆盖同名颜色变量。
 */
export function themeVariables(theme: Theme): Readonly<Record<string, string>> {
	// Record<string, string> 表示字符串键和值的字典，先从空对象开始。
	const variables: Record<string, string> = {};
	// Object.entries 解构角色与颜色，模板字面量在键前加 --。
	for (const [role, color] of Object.entries(theme.colors)) variables[`--${role}`] = color;
	// 没有 web 时遍历空对象；后写的 extras 可以覆盖前面相同的键。
	for (const [name, value] of Object.entries(theme.web ?? {})) variables[`--${name}`] = value;
	// readonly 返回类型仅限制调用方的写法，不冻结返回对象。
	return variables;
}

/** How many colours a terminal shows. */
// 字面量联合只允许这两种终端能力，未引入自定义枚举或运行时代码。
export type ColorDepth = "truecolor" | "256";

/**
 * The SGR parameters of `role`'s colour in `theme` for a terminal of `depth` (`38;2;r;g;b`, `38;5;n`; `48;…` for a
 * background): the role's `tui` override first, else its colour, else the fallback theme's; a `#rrggbb` colour is the
 * nearest of the 256 xterm colours on a 256-colour terminal. A role nobody defines, or a colour that is no `#rrggbb`,
 * gives the terminal's default (`39`, `49`).
 */
/** 把 theme 中 role 的颜色转成 ANSI SGR 参数，depth 决定真彩或 256 色、layer 决定前景/背景。
 * 优先 tui 覆盖，再 colors，再相同模式 fallback；纯数字 0..255 直接用索引，#rrggbb 可转换。
 * 例如 truecolor 下 #ff0000 的前景返回 38;2;255;0;0；无法解析时返回 39/49，函数不输出终端字符。
 */
export function terminalColor(theme: Theme, role: string, depth: ColorDepth, layer: "fg" | "bg"): string {
	// 基础颜色字典在这里按任意 role 查询；断言不增加 fallback 本来没有的角色。
	const fallback = FALLBACK_THEMES[theme.mode].colors as Readonly<Record<string, string>>;
	// 可选链跳过缺少的 tui；?? 只在不存在时降级，非法但存在的字符串不再回退颜色表。
	const color = theme.tui?.[role] ?? theme.colors[role] ?? fallback[role];
	// SGR 38 设置前景、48 设置背景，后续拼接 2（RGB）或 5（调色板）。
	const base = layer === "fg" ? "38" : "48";
	// 此处解析主题颜色字符串格式，不是重复校验 theme 的 TypeScript 类型。
	if (color !== undefined && /^\d{1,3}$/.test(color) && Number(color) < 256) return `${base};5;${color}`;
	// 非数字索引尝试严格六位十六进制；缺少角色则无需解析。
	const rgb = color === undefined ? undefined : parseHex(color);
	// 39/49 恢复终端默认前景/背景；如 CSS 的 red/rgb(...) 在这里不会解析。
	if (rgb === undefined) return layer === "fg" ? "39" : "49";
	// join 用分号拼接 RGB 三个通道，256 色模式另找最近色阶。
	if (depth === "truecolor") return `${base};2;${rgb.join(";")}`;
	return `${base};5;${nearest256(rgb)}`;
}

/** The red, green and blue of a `#rrggbb` colour. */
/** 严格解析六位十六进制字符串，返回 RGB 三元组或 undefined；如 #00ff80 得 [0,255,128]，不支持 #fff。
 * 正则捕获组三段两位字符；! 断言捕获成功后各组存在，不会在运行时增加检查。
 */
function parseHex(color: string): readonly [number, number, number] | undefined {
	// i 允许大小写 A..F，首尾锚点拒绝额外字符。
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	// exec 未匹配时给 null；此格式解析失败不是异常。
	if (match === null) return undefined;
	// 基数 16 将三个通道各自转换到 0..255。
	return [Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16), Number.parseInt(match[3]!, 16)];
}

/** The levels of the xterm 6×6×6 colour cube. */
// xterm 256 色的 16–231 是 6×6×6 立方体，每个通道只有这 6 个可能值；索引为 16 + 36*r + 6*g + b。
// 索引 0–15 是用户可配置的系统色，不用于近似，避免颜色随终端主题变化。
const CUBE = [0, 95, 135, 175, 215, 255];

/** The nearest xterm 256-colour index to `rgb`: the nearer of the colour cube's (16–231) and the grey ramp's (232–255). */
/** 将 RGB 三元组近似成 xterm 索引，比较 6×6×6 色立方和 24 级灰阶；返回数字，不改输入。
 * 例如纯红 [255,0,0] 对应立方坐标 [5,0,0]、索引 196；不会在 0..15 的系统可变色中搜索。
 */
function nearest256(rgb: readonly [number, number, number]): number {
	// 对单通道选差值最小的 CUBE 索引；相同差值保留先遇到的低索引。
	const level = (value: number): number => {
		let best = 0;
		for (let index = 1; index < CUBE.length; index++) {
			// ! 告诉 TS 循环索引确实对应色阶项；每次找到更近的项才更新 best。
			if (Math.abs(CUBE[index]! - value) < Math.abs(CUBE[best]! - value)) best = index;
		}
		return best;
	};
	// map 逐通道算坐标；断言三元组依赖输入本就是三元组，不做运行时长度检测。
	const [r, g, b] = rgb.map(level) as [number, number, number];
	// 得到色立方候选颜色，用于与灰色候选比较误差。
	const cube = [CUBE[r]!, CUBE[g]!, CUBE[b]!] as const;
	// 灰阶采用三个通道平均值，并四舍五入到 8,18,...,238 的 24 级。
	const average = (rgb[0] + rgb[1] + rgb[2]) / 3;
	const grey = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
	const greyValue = 8 + grey * 10;
	// RGB 欧氏距离的平方即可比较远近，省去平方根；** 2 是平方运算。
	const distance = (other: readonly number[]): number =>
		(other[0]! - rgb[0]) ** 2 + (other[1]! - rgb[1]) ** 2 + (other[2]! - rgb[2]) ** 2;
	// 灰阶严格更近才选灰阶；平手选色立方，按其 r/g/b 位置换算 xterm 索引。
	return distance([greyValue, greyValue, greyValue]) < distance(cube) ? 232 + grey : 16 + 36 * r + 6 * g + b;
}
