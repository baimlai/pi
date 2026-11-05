// 定义颜色值、解析与混色、ANSI 样式串；主题层使用本模块，底层数学在 oklab.ts。函数返回数据/字符串，不直接操作终端。
// sRGB 是常见屏幕编码颜色；linear sRGB 去掉传输曲线后才代表线性通道；OKLCH 用亮度L、色度C、色相角H描述颜色。
import { linearSrgbToRgb, okhslToRgb, oklabToLinearSrgb, rgbToOkhsl, rgbToOklab } from "./oklab.ts";
// 仅引入三通道类型，不会运行 terminal-colors 中的解析器。
import type { RgbColor } from "./terminal-colors.ts";

// 调色板索引颜色的编译期形状；readonly 限制通过该接口赋值，构造函数才会运行时 freeze。
export interface IndexedColor {
	// 固定标签让 switch 能把 Color 联合收窄成索引颜色。
	readonly kind: "indexed";
	// ANSI 0..255 的索引；number 类型本身不保证范围/整数。
	readonly index: number;
}

// 直接携带 sRGB 通道的颜色对象，不含透明度。
export interface RgbColorValue {
	// 判别标签 rgb。
	readonly kind: "rgb";
	// 红通道，构造器要求有限且在0..255，但允许小数。
	readonly r: number;
	// 绿通道，同样使用0..255标度。
	readonly g: number;
	// 蓝通道；不可把这里的255标度直接代入0..1线性公式。
	readonly b: number;
}

// OKLCH 极坐标颜色；有些色度超出屏幕色域，转RGB时才降低色度。
export interface OklchColorValue {
	// 判别标签 oklch。
	readonly kind: "oklch";
	// 亮度 L，构造器限制0..1。
	readonly l: number;
	// 非负色度 C，构造器没有设固定上限。
	readonly c: number;
	// 色相角以度计，构造器归一化到[0,360)。
	readonly h: number;
}

/** A concrete color. Every color can be converted to sRGB, so color math never fails. */
// 带标签联合：三种具体颜色都可走转换分支；不是运行时校验器，不能把原英文理解为任意伪造对象或极端数值都保证有效。
export type Color = IndexedColor | RgbColorValue | OklchColorValue;
// 输出模式只决定RGB如何编码为控制串，不在这里探测终端能力。
export type TerminalColorMode = "256color" | "truecolor";
// 混色可选OKLCH或编码后的sRGB通道；不是线性光RGB混色。
export type ColorMixSpace = "oklch" | "srgb";

// 转换函数返回的可变通道对象；与带kind标签的颜色值不同。
export interface OklchChannels {
	// 亮度L。
	l: number;
	// 色度C。
	c: number;
	// 色相角H，单位度。
	h: number;
}

/**
 * OKHSL channels: hue in degrees, saturation and lightness 0-1. Saturation is relative to the most the
 * sRGB gamut allows at that hue and lightness, so every value is in gamut.
 */
// OKHSL是基于sRGB色域的选色坐标；类型只声明数字，合法范围由构造入口检查。
export interface OkhslChannels {
	// 色相角h，单位度。
	h: number;
	// 相对该色相/亮度最大色度的饱和度s，约定0..1。
	s: number;
	// 经过OKHSL亮度曲线的l，约定0..1，不等于Oklab的L。
	l: number;
}

// 可选文本属性；true才开启，false/undefined均不会生成对应开启码。
export interface TextAttributes {
	// 粗体。
	bold?: boolean;
	// 弱化/暗显，与粗体共用SGR22关闭码。
	dim?: boolean;
	// 斜体。
	italic?: boolean;
	// 下划线。
	underline?: boolean;
	// 前景背景反显。
	inverse?: boolean;
	// 删除线。
	strikethrough?: boolean;
}

// extends只复用类型字段，实际样式数据仍是普通对象。
export interface TextStyle extends TextAttributes {
	// 可选前景色。
	fg?: Color;
	// 可选背景色。
	bg?: Color;
}

// 验证构造输入的数值有限性，成功void、失败抛Error；例：NaN颜色通道被拒绝。只做数值域检查，无外部修改。
function requireFinite(value: number, name: string): void {
	// Number.isFinite排除NaN和正负Infinity；number编译类型仍允许这些数值。
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

// 创建冻结的索引颜色；输入须整数0..255，失败抛Error，成功返回新对象；例：indexedColor(9)。无外部修改。
export function indexedColor(index: number): IndexedColor {
	// 同时检查整数和两端范围，不能只判断number类型。
	if (!Number.isInteger(index) || index < 0 || index > 255) {
		// 把无效数值带入错误说明，交给上层处理。
		throw new Error(`ANSI color index must be an integer from 0 to 255: ${index}`);
	}
	// 对象属性简写保存index；Object.freeze在运行时阻止这一层属性变更。
	return Object.freeze({ kind: "indexed", index });
}

// 创建冻结RGB颜色，校验三个有限通道在0..255，失败抛Error；例：rgbColor(255,0,0)为红。允许小数，输出编码时再取整；无外部修改。
export function rgbColor(r: number, g: number, b: number): RgbColorValue {
	// for...of逐个解构[通道名,值]，让错误说明准确指向r/g/b。
	for (const [name, value] of [
		// 本轮可能检查红通道r。
		["r", r],
		// 或绿通道g。
		["g", g],
		// 或蓝通道b。
		["b", b],
		// as const保留元组/字面量类型，避免解构后name/value混为同一种宽类型；不做运行时freeze。
	] as const) {
		// 先排NaN/Infinity，接下来的范围比较才有明确意义。
		requireFinite(value, name);
		// 负值或超过255直接抛，不自动裁剪用户输入。
		if (value < 0 || value > 255) throw new Error(`${name} must be between 0 and 255: ${value}`);
	}
	// 返回新冻结对象，并保留小数通道。
	return Object.freeze({ kind: "rgb", r, g, b });
}

// 创建冻结OKLCH，验证有限数、L在0..1、C非负并环绕色相；例：h=-10存成350。失败抛Error，无外部修改，不保证原C在sRGB色域内。
export function oklchColor(l: number, c: number, h: number): OklchColorValue {
	// 检查亮度有限。
	requireFinite(l, "l");
	// 检查色度有限。
	requireFinite(c, "c");
	// 检查角度有限。
	requireFinite(h, "h");
	// 亮度只允许闭区间0..1。
	if (l < 0 || l > 1) throw new Error(`l must be between 0 and 1: ${l}`);
	// 色度不能负，但可以很大，不在这里做色域映射。
	if (c < 0) throw new Error(`c must not be negative: ${c}`);
	// 两次%把负角度也映到[0,360)；%是余数，单次负角度%360仍可能为负。
	return Object.freeze({ kind: "oklch", l, c, h: ((h % 360) + 360) % 360 });
}

// String.raw保留反斜杠；此数字片段接受符号、小数、科学记数，后续正则的i也让E可用。只构造模式，不解析数值范围。
const NUMBER_PATTERN = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
// 构造OKLCH整串模式，模板只插入上面的数字子模式。
const OKLCH_PATTERN = new RegExp(
	// 依次捕获L、L百分号、C、H；C不接受百分号，H只可跟可选deg，括号外无额外首尾空白。
	`^oklch\\(\\s*(${NUMBER_PATTERN})(%)?\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})(?:deg)?\\s*\\)$`,
	// i忽略大小写；没有g，重复exec不保存匹配游标。
	"i",
);
// OKHSL模式与OKLCH不同，角度放第一，饱和度/亮度各可用百分号。
const OKHSL_PATTERN = new RegExp(
	// 捕获h、s、s百分号、l、l百分号；空白分隔而非逗号，不实现整个CSS颜色语法。
	`^okhsl\\(\\s*(${NUMBER_PATTERN})(?:deg)?\\s+(${NUMBER_PATTERN})(%)?\\s+(${NUMBER_PATTERN})(%)?\\s*\\)$`,
	// 函数名/deg/科学记数都允许大小写变体。
	"i",
);

/**
 * An OKHSL color, converted to sRGB. Saturation is relative to the sRGB gamut at the hue and lightness,
 * so equal saturation looks equally colorful across hues and lightness.
 * @param h Hue in degrees.
 * @param s Saturation, 0-1.
 * @param l Lightness, 0-1.
 */
// 校验h/s/l并经OKHSL转RGB，返回冻结RGB对象；例：okhslColor(29.23,1,0.568)接近纯红。
// 有限性和s/l范围失败抛Error；计算包含近似与取整，不承诺任意颜色往返无损，无外部副作用。
export function okhslColor(h: number, s: number, l: number): RgbColorValue {
	// 色相必须有限，实际环绕交底层公式。
	requireFinite(h, "h");
	// 饱和度必须有限。
	requireFinite(s, "s");
	// 亮度必须有限。
	requireFinite(l, "l");
	// 饱和度0..1，超出不自动钳制。
	if (s < 0 || s > 1) throw new Error(`s must be between 0 and 1: ${s}`);
	// 亮度0..1。
	if (l < 0 || l > 1) throw new Error(`l must be between 0 and 1: ${l}`);
	// 底层换色域/编码并取整，解构返回的RGB。
	const { r, g, b } = okhslToRgb(h, s, l);
	// 再经RGB构造器验证并freeze，返回kind=rgb而非新建okhsl标签。
	return rgbColor(r, g, b);
}

// 将任意Color先转RGB再转OKHSL，返回新通道对象；例：索引红也可得到h/s/l。RGB转换可能已做色域映射/取整，不保证保留原OKLCH，无外部修改。
export function colorToOkhsl(color: Color): OkhslChannels {
	// 内层先统一RGB，外层再执行OKHSL逆换算。
	return rgbToOkhsl(colorToRgb(color));
}

// 解析数字索引或有限几种文本颜色，返回冻结Color；例：#abc→RGB170/187/204，oklch(62% 0.1 200)→OKLCH。
// 按索引、3/6位hex、OKLCH、OKHSL依次尝试；不认red、rgb()或字符串数字，不trim整串。形状或范围无效抛Error，无I/O。
export function parseColor(value: string | number): Color {
	// 这里的typeof是在string|number联合中选择合法分支，不是复验已知单一类型。
	if (typeof value === "number") return indexedColor(value);

	// hex只接受#后3位或6位十六进制，不支持alpha的4/8位。
	const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
	// 命中hex后优先返回。
	if (hex) {
		// 3位简写逐位复制，如abc→aabbcc；展开字符串/map/join组成6位。
		const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
		// 将三个十六进制分量交给RGB构造器。
		return rgbColor(
			// 前两位为红，基数16。
			Number.parseInt(digits.slice(0, 2), 16),
			// 中间两位为绿。
			Number.parseInt(digits.slice(2, 4), 16),
			// 最后两位为蓝。
			Number.parseInt(digits.slice(4, 6), 16),
		);
	}

	// 尝试上面固定的OKLCH文本模式。
	const oklch = OKLCH_PATTERN.exec(value);
	// 形状命中，数值域还需构造器检查。
	if (oklch) {
		// L有%则除100，否则按0..1读取。
		const lightness = Number.parseFloat(oklch[1]) / (oklch[2] ? 100 : 1);
		// C/H按普通数值解析，由oklchColor检查范围并环绕H。
		return oklchColor(lightness, Number.parseFloat(oklch[3]), Number.parseFloat(oklch[4]));
	}

	// OKLCH未命中再试OKHSL。
	const okhsl = OKHSL_PATTERN.exec(value);
	// 匹配成功取各捕获字段。
	if (okhsl) {
		// s的百分号独立决定是否除100。
		const saturation = Number.parseFloat(okhsl[2]) / (okhsl[3] ? 100 : 1);
		// l也独立处理百分号。
		const lightness = Number.parseFloat(okhsl[4]) / (okhsl[5] ? 100 : 1);
		// h第一组，转换结果最终是RGB颜色对象。
		return okhslColor(Number.parseFloat(okhsl[1]), saturation, lightness);
	}

	// 所有支持语法都不匹配才报Invalid；构造器的范围错误则在前面已经抛出。
	throw new Error(`Invalid color value: ${value}`);
}

// 索引0..15用固定参考ANSI色值进行数学换算；不是终端OSC查询的真实用户调色板。readonly只限制通过此数组类型写入。
const BASIC_COLORS: readonly RgbColor[] = [
	// 参考索引0的黑色，实际终端可由用户改成别的颜色。
	{ r: 0, g: 0, b: 0 },
	// 参考索引1的暗红色，实际终端可由用户改成别的颜色。
	{ r: 128, g: 0, b: 0 },
	// 参考索引2的暗绿色，实际终端可由用户改成别的颜色。
	{ r: 0, g: 128, b: 0 },
	// 参考索引3的暗黄/橄榄色，实际终端可由用户改成别的颜色。
	{ r: 128, g: 128, b: 0 },
	// 参考索引4的暗蓝色，实际终端可由用户改成别的颜色。
	{ r: 0, g: 0, b: 128 },
	// 参考索引5的暗紫色，实际终端可由用户改成别的颜色。
	{ r: 128, g: 0, b: 128 },
	// 参考索引6的暗青色，实际终端可由用户改成别的颜色。
	{ r: 0, g: 128, b: 128 },
	// 参考索引7的浅灰色，实际终端可由用户改成别的颜色。
	{ r: 192, g: 192, b: 192 },
	// 参考索引8的深灰色，实际终端可由用户改成别的颜色。
	{ r: 128, g: 128, b: 128 },
	// 参考索引9的亮红色，实际终端可由用户改成别的颜色。
	{ r: 255, g: 0, b: 0 },
	// 参考索引10的亮绿色，实际终端可由用户改成别的颜色。
	{ r: 0, g: 255, b: 0 },
	// 参考索引11的亮黄色，实际终端可由用户改成别的颜色。
	{ r: 255, g: 255, b: 0 },
	// 参考索引12的亮蓝色，实际终端可由用户改成别的颜色。
	{ r: 0, g: 0, b: 255 },
	// 参考索引13的亮紫色，实际终端可由用户改成别的颜色。
	{ r: 255, g: 0, b: 255 },
	// 参考索引14的亮青色，实际终端可由用户改成别的颜色。
	{ r: 0, g: 255, b: 255 },
	// 参考索引15的白色，实际终端可由用户改成别的颜色。
	{ r: 255, g: 255, b: 255 },
];
// 6×6×6色立方每个通道的六档强度，索引16..231使用；as const保留只读元组类型。
const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
// Array.from生成24档灰，忽略占位值_，第index档为8+10×index。
const GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

// 把合法0..255索引转新RGB对象；例：16为黑、231为白、232为灰8。依赖调用方/构造器保证索引合法，不再校验；无外部修改。
function indexedToRgb(index: number): RgbColor {
	// 前16个色取参考表并浅展开，避免返回原表对象。
	if (index < 16) return { ...BASIC_COLORS[index] };
	// 16..231进入6³色立方。
	if (index < 232) {
		// 去掉前16色的编号偏移。
		const cubeIndex = index - 16;
		// 按36/6/1的位权解出三档强度。
		return {
			// 除36取红档，floor去余数。
			r: CUBE_VALUES[Math.floor(cubeIndex / 36)],
			// 模36后除6得到绿档。
			g: CUBE_VALUES[Math.floor((cubeIndex % 36) / 6)],
			// 模6得到蓝档。
			b: CUBE_VALUES[cubeIndex % 6],
		};
	}
	// 232..255按固定10级间距取灰。
	const gray = 8 + (index - 232) * 10;
	// 三个通道同值成为无彩色。
	return { r: gray, g: gray, b: gray };
}

// 判断线性RGB通道是否都落允许区间，返回boolean；例：[0,0.5,1]通过。只逐项数值比较，不检查数组长度；无修改。
function isInSrgbGamut(linear: number[]): boolean {
	// 给浮点误差留1e-7容差。
	const epsilon = 1e-7;
	// every要求每个通道在[-epsilon,1+epsilon]；NaN会比较失败，空数组则真。
	return linear.every((channel) => channel >= -epsilon && channel <= 1 + epsilon);
}

// 将L/C/H换RGB；固定L与H，先直接转换，超色域则二分降低C最多20轮，最后编码取整。
// 例：L=1且高色度最终回白色；不修改输入，无I/O，假设L/C来自合法构造而非任意伪造对象。
function oklchToRgb({ l, c, h }: OklchChannels): RgbColor {
	// Gamut mapping keeps the hue fixed, so its direction is computed once and scaled by chroma.
	// 度转弧度供三角函数使用。
	const radians = (h * Math.PI) / 180;
	// 固定色相a方向分量，只计算一次。
	const cos = Math.cos(radians);
	// 固定色相b方向分量。
	const sin = Math.sin(radians);
	// 局部闭包输入候选色度，返回线性RGB数组；[L,C cosH,C sinH]是极坐标转Oklab笛卡尔坐标，无状态修改。
	const atChroma = (chroma: number) => oklabToLinearSrgb([l, chroma * cos, chroma * sin]);

	// 先用原色度转换。
	const direct = atChroma(c);
	// 已在色域内就直接编码，不二分。
	if (isInSrgbGamut(direct)) return linearSrgbToRgb(direct);

	// Reduce chroma until the color fits. The achromatic color is always in gamut, so it is the
	// fallback when no bisection step fits, e.g. `oklch(100% 0.3 150)` must map to white.
	// 以零色度的同亮度灰作为保底候选。
	let linear = atChroma(0);
	// 可接受色度的下界从0开始。
	let low = 0;
	// 搜索上界从原C开始。
	let high = c;
	// 固定20步近似，并非无限精度求解。
	for (let index = 0; index < 20; index++) {
		// 取上下界中点。
		const chroma = (low + high) / 2;
		// 算这个C对应的线性RGB。
		const candidate = atChroma(chroma);
		// 这个候选能放进sRGB吗。
		if (isInSrgbGamut(candidate)) {
			// 能放进就提高下界，尝试保留更多色度。
			low = chroma;
			// 同时记住当前可用的线性RGB。
			linear = candidate;
			// 不能放进则收缩上侧范围。
		} else {
			// 把上界降到中点。
			high = chroma;
		}
	}
	// 将最后保留的线性RGB编码、钳制、取整为0..255通道。
	return linearSrgbToRgb(linear);
}

// 统一Color为新RGB通道对象；例：RGB直接复制、索引查固定表、OKLCH色域映射。无外部修改；结构类型并不替代输入数值校验。
export function colorToRgb(color: Color): RgbColor {
	// 按kind判别联合收窄，TS知道各分支字段。
	switch (color.kind) {
		// 索引类型分支。
		case "indexed":
			// 使用固定ANSI参考映射。
			return indexedToRgb(color.index);
		// 已经是RGB的分支。
		case "rgb":
			// 返回新对象，但不在这里钳制/取整原通道。
			return { r: color.r, g: color.g, b: color.b };
		// OKLCH分支。
		case "oklch":
			// 执行固定色相的色域映射。
			return oklchToRgb(color);
	}
}

// 将Color变为新OKLCH通道；原OKLCH直接复制，其余经RGB/Oklab转极坐标。例：RGB红得到红色相。无修改；近灰色的h由浮点结果决定，不额外固定0。
export function colorToOklch(color: Color): OklchChannels {
	// 保留原OKLCH，即使原C超sRGB也不先映射。
	if (color.kind === "oklch") return { l: color.l, c: color.c, h: color.h };
	// 数组解构Oklab的L/a/b；RGB来源可能包含索引近似。
	const [l, a, b] = rgbToOklab(colorToRgb(color));
	// hypot求√(a²+b²)色度，atan2求角度再环绕到非负度数。
	return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

// 返回#rrggbb字符串；例：RGB255/0/0→#ff0000。先统一RGB再四舍五入转hex，无I/O/修改；不另校验手工伪造颜色。
export function colorToHex(color: Color): string {
	// 提取转换后的三通道。
	const { r, g, b } = colorToRgb(color);
	// 局部channel回调输入通道数、返回小写16进制且至少两位；例：15→0f，padStart只补不截断。无修改。
	const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");
	// 拼接三个通道，不含透明度。
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// 按amount把first混向second，0为前者、1为后者；缺省OKLCH，srgb则在编码通道直接插值。
// 例：红/蓝各一半的两种空间结果不同；范围无效抛Error，返回新冻结Color，无修改，不是物理光线混合。
export function mixColors(first: Color, second: Color, amount: number, space: ColorMixSpace = "oklch"): Color {
	// 先要求amount有限。
	requireFinite(amount, "amount");
	// 比例须0..1，不自动裁剪。
	if (amount < 0 || amount > 1) throw new Error(`amount must be between 0 and 1: ${amount}`);

	// 明确srgb才走RGB通道分支。
	if (space === "srgb") {
		// 第一色统一到RGB。
		const a = colorToRgb(first);
		// 第二色同样转换，可能已经色域映射/取整。
		const b = colorToRgb(second);
		// 每个通道用a+(b-a)×amount插值；保留小数，构造器检查并freeze。
		return rgbColor(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount);
	}

	// 其他合法模式为OKLCH，先转换第一色。
	const a = colorToOklch(first);
	// 再转换第二色；原OKLCH色值不先裁色域。
	const b = colorToOklch(second);
	// 第一色几乎无彩时借第二色的h，避免灰的任意h干扰混合。
	const firstHue = a.c < 1e-7 ? b.h : a.h;
	// 第二色几乎无彩时沿用第一有效h。
	const secondHue = b.c < 1e-7 ? firstHue : b.h;
	// 选择[-180,180)内最短色相差；正好180度选择-180。
	const hueDelta = ((secondHue - firstHue + 540) % 360) - 180;
	// L/C线性插值，H沿短弧插值，再由构造器环绕；混合结果尚可能超sRGB。
	return oklchColor(a.l + (b.l - a.l) * amount, a.c + (b.c - a.c) * amount, firstHue + hueDelta * amount);
}

// 在档位数组中找离target最近项的下标；例：[0,10]目标6→1。等距保留先遇项，空数组返回初始0；无修改。
function findClosest(values: readonly number[], target: number): number {
	// 先假设第0档。
	let closestIndex = 0;
	// 距离从正Infinity起，保证首个有限候选能替换。
	let closestDistance = Infinity;
	// 按数组顺序扫描。
	for (let index = 0; index < values.length; index++) {
		// 绝对差作为一维距离。
		const distance = Math.abs(target - values[index]);
		// 只在严格更近时替换，平手不更新。
		if (distance < closestDistance) {
			// 记下新下标。
			closestIndex = index;
			// 记下新的最短距离。
			closestDistance = distance;
		}
	}
	// 返回下标而非档位数值。
	return closestIndex;
}

// 算两个RGB的加权平方距离，返回number；例：同色为0。非Oklab感知距离、不开平方，不改变输入。
function colorDistance(first: RgbColor, second: RgbColor): number {
	// 红通道差。
	const dr = first.r - second.r;
	// 绿通道差。
	const dg = first.g - second.g;
	// 蓝通道差。
	const db = first.b - second.b;
	// 平方防正负抵消，绿色权重最大；权重是这里的启发式选择。
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

// 把RGB近似为ANSI256索引；例：近灰可能选灰阶，否则取6³色立方。只在这两类候选间比较，不搜索前16参考色或全部256色，无修改。
function rgbToAnsi256(color: RgbColor): number {
	// 红通道挑最近六档下标。
	const rIndex = findClosest(CUBE_VALUES, color.r);
	// 绿通道独立挑档。
	const gIndex = findClosest(CUBE_VALUES, color.g);
	// 蓝通道独立挑档。
	const bIndex = findClosest(CUBE_VALUES, color.b);
	// 还原色立方候选RGB以比较误差。
	const cubeColor = { r: CUBE_VALUES[rIndex], g: CUBE_VALUES[gIndex], b: CUBE_VALUES[bIndex] };
	// 16偏移+36/6/1位权编码索引。
	const cubeIndex = 16 + 36 * rIndex + 6 * gIndex + bIndex;

	// 加权亮度近似转灰强度并取整，不是线性光计算。
	const gray = Math.round(0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
	// 在24灰档里找最近档。
	const grayOffset = findClosest(GRAY_VALUES, gray);
	// 取该档实际强度。
	const grayValue = GRAY_VALUES[grayOffset];
	// 最大最小通道差衡量是否近灰。
	const spread = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
	// 必须近灰且灰候选误差严格更小才选择灰。
	if (
		// 三通道跨度小于10才允许灰候选。
		spread < 10 &&
		// 用同一加权平方距离比较灰与色立方；平手选色立方。
		colorDistance(color, { r: grayValue, g: grayValue, b: grayValue }) < colorDistance(color, cubeColor)
	) {
		// 灰阶从232开始。
		return 232 + grayOffset;
	}
	// 否则使用色立方索引。
	return cubeIndex;
}

// 给颜色生成前景/背景SGR控制串，返回string；例：RGB红+truecolor+前景→38;2;255;0;0。只生成字符串不发送，索引色始终保留其索引。
function colorAnsi(color: Color, mode: TerminalColorMode, background: boolean): string {
	// kind=indexed时直接用38前景/48背景的5模式，mode不会强制展开RGB。
	if (color.kind === "indexed") return `\x1b[${background ? 48 : 38};5;${color.index}m`;

	// 其他颜色统一RGB。
	const rgb = colorToRgb(color);
	// 真彩模式使用三通道编码。
	if (mode === "truecolor") {
		// 38/48;2;r;g;b，三个通道在此四舍五入。
		return `\x1b[${background ? 48 : 38};2;${Math.round(rgb.r)};${Math.round(rgb.g)};${Math.round(rgb.b)}m`;
	}
	// 256色模式先近似到索引，再用5模式编码。
	return `\x1b[${background ? 48 : 38};5;${rgbToAnsi256(rgb)}m`;
}

// 生成前景色ANSI字符串；例：foregroundAnsi(indexedColor(9),"truecolor")仍是索引9。无终端写入/状态修改。
export function foregroundAnsi(color: Color, mode: TerminalColorMode): string {
	// false指定前景，交内部通用编码器。
	return colorAnsi(color, mode, false);
}

// 生成背景色ANSI字符串；例：背景红使用48开头。无终端写入/状态修改。
export function backgroundAnsi(color: Color, mode: TerminalColorMode): string {
	// true指定背景。
	return colorAnsi(color, mode, true);
}

// 把颜色和属性包在text周围并返回新字符串；例：粗体红字前加开启码、后加关闭码。无I/O，不转义text内部控制串，不恢复已有外层样式栈。
export function styleText(text: string, options: TextStyle, mode: TerminalColorMode): string {
	// 先算颜色码，再交属性拼接器统一处理。
	return styleTextWithAnsi(
		// 保留输入文字原样。
		text,
		// 仅有前景Color才生成前景串，&&缺省得undefined。
		options.fg && foregroundAnsi(options.fg, mode),
		// 仅有背景Color才生成背景串。
		options.bg && backgroundAnsi(options.bg, mode),
		// 同一options供读取bold等属性。
		options,
	);
}

/**
 * Like `styleText()`, but with precomputed color escape sequences, e.g. cached theme colors.
 * Colors in `options` are ignored.
 */
// 用预计算前/背景码及属性包裹文字，返回string；例：主题可复用已缓存颜色控制串。
// 按开启顺序追加prefix、逆序前插关闭码；无I/O/输入修改，关闭回默认属性而非恢复外层样式，不修补text内嵌重置。
export function styleTextWithAnsi(
	// 原样显示的文本，内部ANSI不会被解析重写。
	text: string,
	// 预计算前景码，可缺省；任意非空串都会原样加入，不校验内容。
	fgAnsi: string | undefined,
	// 预计算背景码，可缺省。
	bgAnsi: string | undefined,
	// 只读取六种文本属性，类型中无fg/bg。
	options: TextAttributes,
): string {
	// Resets are prepended so they close in reverse order of the opening sequences.
	// 局部开启串开始为空。
	let prefix = "";
	// 局部关闭串开始为空。
	let suffix = "";
	// 真值前景码才附加。
	if (fgAnsi) {
		// 开启前景放prefix末尾。
		prefix += fgAnsi;
		// 39只恢复默认前景，不恢复此前的任意前景色。
		suffix = "\x1b[39m";
	}
	// 真值背景码才附加。
	if (bgAnsi) {
		// 背景开启码在前景之后。
		prefix += bgAnsi;
		// 49恢复默认背景，前插到之前前景关闭码前面。
		suffix = `\x1b[49m${suffix}`;
	}
	// 1开启粗体。
	if (options.bold) prefix += "\x1b[1m";
	// 2开启弱化。
	if (options.dim) prefix += "\x1b[2m";
	// 22同时关闭粗体/弱化，所以两者只加一次关闭码。
	if (options.bold || options.dim) suffix = `\x1b[22m${suffix}`;
	// 启用斜体时生成一对控制码。
	if (options.italic) {
		// 3开启斜体。
		prefix += "\x1b[3m";
		// 23关闭斜体，并前插实现逆序关闭。
		suffix = `\x1b[23m${suffix}`;
	}
	// 下划线属性独立处理。
	if (options.underline) {
		// 4开启下划线。
		prefix += "\x1b[4m";
		// 24关闭下划线。
		suffix = `\x1b[24m${suffix}`;
	}
	// 反显属性独立处理。
	if (options.inverse) {
		// 7开启反显。
		prefix += "\x1b[7m";
		// 27关闭反显。
		suffix = `\x1b[27m${suffix}`;
	}
	// 删除线属性独立处理。
	if (options.strikethrough) {
		// 9开启删除线。
		prefix += "\x1b[9m";
		// 29关闭删除线。
		suffix = `\x1b[29m${suffix}`;
	}
	// 最终拼接开启串、原文字、关闭串；全无样式时结果就是原文字。
	return `${prefix}${text}${suffix}`;
}
