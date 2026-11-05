// 为colors.ts提供Oklab/OKHSL与sRGB之间的数值转换；本文件是参考算法的源码移植，下面MIT许可和全部拟合系数保持原样，不是生成输出。
// 读法：RGB先去传输曲线变线性RGB，再经矩阵和立方根到Oklab；反向用立方和逆矩阵。OKHSL在此基础上按色域边界解释饱和度。
// 低层公式假设调用方给合理范围和归一化色相方向，不逐项运行时校验；NaN/零分母等仍按JS浮点规则传播，不能推断成任意输入都安全。
/**
 * Oklab and OKHSL <-> sRGB conversion. `colors.ts` builds its OKLCH, OKHSL, and color mixing on it.
 *
 * Oklab and OKHSL are Björn Ottosson's color spaces; OKHSL's saturation is relative to the sRGB gamut at
 * each hue and lightness. This is a port of his reference implementation (https://bottosson.github.io/posts/colorpicker/),
 * Copyright (c) 2021 Björn Ottosson, used under the MIT license:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions: The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED.
 */

// 只用RGB结构类型，不引入终端探测行为。
import type { RgbColor } from "./terminal-colors.ts";

// 长度恰为3的元组类型，按调用上下文表示RGB、LMS或L/a/b；类型擦除后仍是数组。
type Vector = [number, number, number];
// 三行Vector组成3×3矩阵，类型不检查可逆性或系数物理意义。
type Matrix = [Vector, Vector, Vector];

// 矩阵乘三维列向量，返回新Vector；例：单位矩阵保持[x,y,z]。解构参数后每行做点积，无输入修改。
const multiply = (m: Matrix, [x, y, z]: Vector): Vector =>
	// map每行计算row·向量；as Vector因为map的普通数组类型丢掉了固定长度，不做运行时长度转换。
	m.map((row) => row[0] * x + row[1] * y + row[2] * z) as Vector;

// ============================================================================
// OKHSL <-> sRGB
// ============================================================================

// 线性sRGB→LMS样中间坐标的参考变换矩阵；这些常量是算法系数，不是主题可配置颜色。
const LINEAR_SRGB_TO_LMS: Matrix = [
	// 第一行组合r/g/b得到第一个中间通道。
	[0.4122214694707629, 0.5363325372617349, 0.0514459932675022],
	// 第二行得到第二个中间通道。
	[0.2119034958178251, 0.6806995506452344, 0.1073969535369405],
	// 第三行得到第三个中间通道。
	[0.0883024591900564, 0.2817188391361215, 0.6299787016738222],
];
// 对开过立方根的LMS进行线性组合，得到Oklab的L/a/b。
const LMS_TO_LAB: Matrix = [
	// 第一行得到亮度L。
	[0.210454268309314, 0.793617774702305, -0.0040720430116193],
	// 第二行得到颜色轴a。
	[1.9779985324311684, -2.42859224204858, 0.450593709617411],
	// 第三行得到颜色轴b。
	[0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
// 从Oklab返回立方根LMS的参考逆矩阵，之后还要各自立方。
const LAB_TO_LMS: Matrix = [
	// L/a/b组合成第一中间量。
	[1, 0.3963377773761749, 0.2158037573099136],
	// 组合成第二中间量。
	[1, -0.1055613458156586, -0.0638541728258133],
	// 组合成第三中间量。
	[1, -0.0894841775298119, -1.2914855480194092],
];
// LMS→线性sRGB的参考矩阵，结果可超0..1，不在矩阵乘法时裁剪。
const LMS_TO_LINEAR_SRGB: Matrix = [
	// 第一行恢复红通道。
	[4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
	// 第二行恢复绿通道。
	[-1.2684379732850315, 2.6097573492876882, -0.341319376002657],
	// 第三行恢复蓝通道。
	[-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];
/**
 * Per sRGB channel (red, green, blue): the (a, b) half-plane where that channel clips
 * first, and the polynomial approximating the maximum saturation there.
 */
// 数组每项含一个二维分区判据与五个多项式系数；顺序对应先碰红/绿/蓝零边界。类型只约束形状，不是运行时拟合。
const SATURATION_FIT: [[number, number], number[]][] = [
	// 红通道先触及下界时使用这一组。
	[
		// 红分区的a/b半平面判据权重。
		[-1.8817031, -0.80936501],
		// 红分区k0..k4，供饱和度初值多项式使用。
		[1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245],
	],
	// 绿通道分区。
	[
		// 绿分区半平面权重。
		[1.8144408, -1.19445267],
		// 绿分区五个饱和度初值系数。
		[0.73956515, -0.45954404, 0.08285427, 0.12541073, -0.14503204],
	],
	// 最后蓝通道分区也是查找兜底。
	[
		// 蓝分区权重仍保存于表中，实际findIndex到第三项会直接选中。
		[0.13110758, 1.81333971],
		// 蓝分区五个初值系数。
		[1.35733652, -0.00915799, -1.1513021, -0.50559606, 0.00692167],
	],
];
// 亮度toe曲线参考常量K1，调暗部映射。
const K1 = 0.206;
// toe曲线参考常量K2。
const K2 = 0.03;
// 由K1/K2计算比例因子，使参考亮度映射衔接。
const K3 = (1 + K1) / (1 + K2);

/** Oklab lightness to OKHSL lightness. */
// Oklab亮度x映到选色器OKHSL亮度，返回number；例：0→0、1→1。非线性toe曲线，无修改/范围检查。
export const oklabToOkhslLightness = (x: number): number =>
	// **2是平方，sqrt开平方，整个表达式是参考toe映射，不是对RGB通道做gamma。
	0.5 * (K3 * x - K1 + Math.sqrt((K3 * x - K1) ** 2 + 4 * K2 * K3 * x));
/** OKHSL lightness to Oklab lightness. */
// 逆亮度toe曲线，输入OKHSL亮度x、返回Oklab L；例：0→0。分式可能对范围外输入出现零分母，不自行校验；无修改。
const okhslToOklabLightness = (x: number): number => (x * x + K1 * x) / (K3 * (x + K2));

/** sRGB transfer function: linear to encoded channel, both 0-1. */
// 线性通道映到sRGB编码通道，通常都用0..1标度；例：0→0、1约1。只换传输曲线，不裁剪，无修改。
const linearToSrgb = (value: number): number =>
	// 阈值以上用1/2.4幂，暗部用线性12.92斜率；三元只选一个分支。
	value > 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : 12.92 * value;
/** Inverse sRGB transfer function: encoded to linear channel, both 0-1. */
// sRGB编码通道的逆传输函数，输入/结果通常0..1；例：0→0。阈值以下除12.92，否则2.4次幂；无裁剪/修改。
const srgbToLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** Oklab [L, a, b] to linear sRGB [r, g, b] (0-1, may leave the gamut). */
// Oklab元组转线性RGB元组；例：[L,0,0]表示无彩方向。先逆矩阵到中间量、立方、再换RGB；可超色域，无修改/验证。
export function oklabToLinearSrgb(lab: Vector): Vector {
	// 内层multiply→map各自立方→外层multiply；map回调输入中间通道并返回其立方，不改原数组。
	return multiply(LMS_TO_LINEAR_SRGB, multiply(LAB_TO_LMS, lab).map((value) => value ** 3) as Vector);
}

/** Linear sRGB [r, g, b] (0-1) to Oklab [L, a, b]. */
// 线性RGB转Oklab，返回新元组；例：[0,0,0]→[0,0,0]。先变中间量、Math.cbrt取实立方根、再变L/a/b；无修改。
function linearSrgbToOklab(rgb: Vector): Vector {
	// Math.cbrt对负数也取实立方根；不能随意替换成value**(1/3)。as只保留固定长度类型。
	return multiply(LMS_TO_LAB, multiply(LINEAR_SRGB_TO_LMS, rgb).map(Math.cbrt) as Vector);
}

/** sRGB channels (0-255) to Oklab [L, a, b]. */
// 0..255编码RGB转Oklab元组；例：黑RGB得到L=0。解构三通道、归一化、逆曲线、矩阵转换，不校验范围/修改输入。
export function rgbToOklab({ r, g, b }: RgbColor): Vector {
	// 三通道除255再map(srgbToLinear)，最后进入线性RGB→Oklab。
	return linearSrgbToOklab([r / 255, g / 255, b / 255].map(srgbToLinear) as Vector);
}

/** Linear sRGB [r, g, b] to sRGB channels (0-255, rounded), clipping out-of-gamut channels. */
// 线性RGB转0..255整数RGB；例：[1,0,0]→红。逐通道编码、钳到0..1、乘255取整；无外部修改，NaN仍会传播。
export function linearSrgbToRgb(linear: Vector): RgbColor {
	// 局部map生成新数组，再解构r/g/b；min/max裁的是编码后的通道，而非先改原输入。
	const [r, g, b] = linear.map((value) => Math.round(Math.min(1, Math.max(0, linearToSrgb(value))) * 255));
	// 返回新对象；这里不带颜色kind，也不freeze。
	return { r, g, b };
}

/** Rate of change of each cube-root LMS component along a chroma direction (a, b). */
// 求固定色相方向(a,b)对三个立方根LMS量的斜率，返回三维向量；例：色度增量乘斜率得到各中间量增量。无修改，假设方向已归一化。
function lmsSlopes(a: number, b: number): Vector {
	// 每个逆矩阵行去掉L项，取a/b列与方向点积；map结果断言为Vector。
	return [LAB_TO_LMS[0], LAB_TO_LMS[1], LAB_TO_LMS[2]].map((row) => row[1] * a + row[2] * b) as Vector;
}

/** Largest saturation (C/L) inside sRGB for hue (a, b): polynomial fit plus one Halley step. */
// 近似求该单位色相方向下最大C/L，返回number；例：cusp再据此寻找该色相最饱和点。
// 先选触零通道、多项式初估，再做一次Halley校正；无外部修改，不保证对任意非单位方向或极端数值精确收敛。
function maxSaturation(a: number, b: number): number {
	// 嵌套解构取分区判据x/y，首个半平面命中选中；第三项index===2始终兜底，||短路不再算其判据。
	const channel = SATURATION_FIT.findIndex(([[x, y]], index) => index === 2 || x * a + y * b > 1);
	// 读取所选分区五个多项式系数。
	const [k0, k1, k2, k3, k4] = SATURATION_FIT[channel][1];
	// 读该通道从LMS还原RGB的权重，用来求该通道等于0的边界。
	const weights = LMS_TO_LINEAR_SRGB[channel];
	// 按常数、a、b、a²、ab项估计饱和度初值。
	const saturation = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;

	// 三个中间通道沿色相方向的变化斜率。
	const slopes = lmsSlopes(a, b);
	// 以L=1，在当前饱和度上形成中间量1+S×斜率；map回调不改原slopes。
	const base = slopes.map((k) => 1 + saturation * k);
	// 局部dot将输入数组按闭包weights加权求和，返回number；例：全0得到0。reduce初值0，每项配同下标权重，无外部修改。
	const dot = (values: number[]) => values.reduce((sum, value, index) => sum + weights[index] * value, 0);
	// 中间量立方后加权，得到要压到0的通道值f。
	const f = dot(base.map((value) => value ** 3));
	// 对S求一阶导数：3×斜率×中间量²，再加权。
	const f1 = dot(base.map((value, index) => 3 * slopes[index] * value ** 2));
	// 二阶导数：6×斜率²×中间量，再加权。
	const f2 = dot(base.map((value, index) => 6 * slopes[index] ** 2 * value));
	// 一次Halley迭代S−f f′/(f′²−0.5 f f″)，不是循环到误差任意小。
	return saturation - (f * f1) / (f1 * f1 - 0.5 * f * f2);
}

/** Oklab lightness and chroma of the most saturated sRGB color of hue (a, b). */
// 找该单位色相方向色域尖点，返回[L,C]；例：chromaStops拿它估算任意亮度可用色度。先求最大C/L再按最强RGB通道归一化，无修改。
function cusp(a: number, b: number): [number, number] {
	// 求L=1方向上的最大饱和度近似。
	const saturation = maxSaturation(a, b);
	// 先算RGB，...展开取最大通道；因为立方关系，取倒数的立方根得到缩放亮度。
	const lightness = Math.cbrt(1 / Math.max(...oklabToLinearSrgb([1, saturation * a, saturation * b])));
	// C=L×(C/L)，返回尖点亮度和色度元组。
	return [lightness, lightness * saturation];
}

/** Chroma where the constant-lightness line at `lightness` leaves the sRGB gamut. */
// 求指定L和单位色相方向的最大色度近似，输入还含该方向尖点[L,C]；返回number。
// 暗侧用三角边比例，亮侧从边界初值对三个通道各做一次校正，例：供OKHSL饱和度1取边界；无修改/额外数值验证。
function maxChroma(a: number, b: number, lightness: number, [cuspL, cuspC]: [number, number]): number {
	// L不超过尖点亮度时按从黑到尖点的边界比例返回。
	if (lightness <= cuspL) return (cuspC * lightness) / cuspL;
	// Upper half: triangle edge, then one Halley step against each channel reaching 1.
	// 亮侧先按尖点到白的三角边估计色度t。
	const t = (cuspC * (lightness - 1)) / (cuspL - 1);
	// 计算三个立方根LMS量对色度的斜率。
	const slopes = lmsSlopes(a, b);
	// 把固定亮度与t×方向斜率相加，得到当前中间量。
	const lms = slopes.map((k) => lightness + t * k);
	// 各自立方，供恢复RGB通道值。
	const cubes = lms.map((value) => value ** 3);
	// 每个中间量对t的一阶导数组合。
	const first = lms.map((value, index) => 3 * slopes[index] * value ** 2);
	// 每个中间量对t的二阶导数组合。
	const second = lms.map((value, index) => 6 * slopes[index] ** 2 * value);
	// 局部dot输入矩阵一行及三个数，返回三项点积；例：单位首行只取values[0]。不修改输入。
	const dot = (row: Vector, values: number[]) => row[0] * values[0] + row[1] * values[1] + row[2] * values[2];
	// 对RGB矩阵每一行计算一个触及通道1边界的校正步；回调只使用局部数据。
	const steps = LMS_TO_LINEAR_SRGB.map((row) => {
		// 当前通道值减1得到边界残差。
		const f = dot(row, cubes) - 1;
		// 通道的一阶导数。
		const f1 = dot(row, first);
		// 通道的二阶导数。
		const f2 = dot(row, second);
		// Halley校正比例u；没有检查分母是否0，依赖正常算法域。
		const u = f1 / (f1 * f1 - 0.5 * f * f2);
		// 非负u才接受−f×u，否则给极大候选使后面min通常不会选它。
		return u >= 0 ? -f * u : Number.MAX_VALUE;
	});
	// 取三个通道最小校正，加回初值t；按最先碰边界的候选求近似，不是任意输入的严格色域保证。
	return t + Math.min(...steps);
}

/** OKHSL's chroma reference points at lightness L and hue (a, b): [c0, cMid, cMax]. */
// 按L及单位色相方向求[c0,cMid,cMax]参考色度；例：OKHSL在s=0.8经过cMid，在s=1到cMax。
// 先求尖点/最大色度，再用参考拟合估中段与低饱和斜率；无修改，不是运行时统计拟合或所有颜色的误差证明。
function chromaStops(L: number, a: number, b: number): [number, number, number] {
	// 该色相的最饱和尖点。
	const peak = cusp(a, b);
	// 在当前L上估计真正能容纳的最大色度。
	const cMax = maxChroma(a, b, L, peak);
	// 最大色度与三角近似边界的比值k，用于修正拟合中段。
	const k = cMax / Math.min(L * (peak[1] / peak[0]), (1 - L) * (peak[1] / (1 - peak[0])));
	// midS是色相(a,b)的固定拟合表达式，不是待优化参数。
	const midS =
		// 先加拟合的常数项。
		0.11516993 +
		// 再加一个分式，分子为1。
		1 /
			// 分母从常数7.4477897开始。
			(7.4477897 +
				// 加入b的一次项。
				4.1590124 * b +
				// 其余多项式整体乘a。
				a *
					// 括号内先放这一常数。
					(-2.19557347 +
						// 再加这一b项。
						1.75198401 * b +
						// 继续嵌套a及b混合项；Horner式写法复用乘法结构，系数保持参考值。
						a * (-2.13704948 - 10.02301043 * b + a * (-4.24894561 + 5.38770819 * b + 4.69891013 * a))));
	// midT是另一侧的色相拟合表达式，结构类似但系数不同。
	const midT =
		// midT的外部常数。
		0.11239642 +
		// 加分子为1的分式。
		1 /
			// 分母初始常数。
			(1.6132032 -
				// 减去b项；源码的加减顺序参与浮点结果，不随意重排。
				0.68124379 * b +
				// 后续括号整体乘a。
				a *
					// 括号初始常数。
					(0.40370612 +
						// 加b项。
						0.90148123 * b +
						// 其余a/b混合多项式，保持原系数和运算顺序。
						a * (-0.27087943 + 0.6122399 * b + a * (0.00299215 - 0.45399568 * b - 0.14661872 * a))));
	// 将上下两侧参考色度作四次幂的平滑合成，再用0.9×k修正得到cMid；连续两次sqrt是四次方根。
	const cMid = 0.9 * k * Math.sqrt(Math.sqrt(1 / (1 / (L * midS) ** 4 + 1 / ((1 - L) * midT) ** 4)));
	// 低饱和参考c0使用二次幂平滑合成，上下侧比例分别0.4和0.8。
	const c0 = Math.sqrt(1 / (1 / (L * 0.4) ** 2 + 1 / ((1 - L) * 0.8) ** 2));
	// 按固定顺序返回三个参考量，调用者用数组解构接收。
	return [c0, cMid, cMax];
}

/**
 * Convert OKHSL to sRGB channels (0-255, rounded), clipping out-of-gamut channels.
 * @param hue Hue in degrees.
 * @param saturation Saturation, 0-1.
 * @param lightness Lightness, 0-1.
 */
// OKHSL(h度,s/l约定0..1)转0..255整数RGB，返回新对象；例：s=0走同亮度灰。
// 逆亮度、确定色相方向、分两段把s映C、转Oklab/RGB并裁通道；这里不验证输入范围，公开colors.okhslColor负责校验，无I/O。
export function okhslToRgb(hue: number, saturation: number, lightness: number): RgbColor {
	// 把选色器亮度l换成Oklab L。
	const L = okhslToOklabLightness(lightness);
	// 先以零a/b建立灰色，let允许有色分支整体替换元组。
	let lab: Vector = [L, 0, 0];
	// 仅内部亮度在0..1且s正才算色度，黑白或无彩跳过复杂边界计算。
	if (L > 0 && L < 1 && saturation > 0) {
		// h先环绕[0,360)再转弧度。
		const angle = (2 * Math.PI * (((hue % 360) + 360) % 360)) / 360;
		// 色相单位方向a=cos。
		const a = Math.cos(angle);
		// 方向b=sin。
		const b = Math.sin(angle);
		// 读取当前方向/亮度三个色度参考点。
		const [c0, cMid, cMax] = chromaStops(L, a, b);
		// Chroma rises from 0 through cMid at s = 0.8 to cMax at s = 1.
		// 声明分段计算的局部色度，后面两分支均赋值。
		let chroma: number;
		// 饱和度低于0.8走第一段。
		if (saturation < 0.8) {
			// 1.25=1/0.8，把这一段的s映到t的0..1。
			const t = 1.25 * saturation;
			// 第一段起始斜率尺度。
			const k1 = 0.8 * c0;
			// 有理式从0过渡到cMid，非简单C=s×cMax。
			chroma = (t * k1) / (1 - (1 - k1 / cMid) * t);
			// s≥0.8进入较高饱和段。
		} else {
			// 5=1/0.2，将剩余0.2区间映到t的0..1。
			const t = 5 * (saturation - 0.8);
			// 根据cMid/c0算第二段斜率，使段间过渡衔接。
			const k1 = (0.2 * cMid ** 2 * 1.25 ** 2) / c0;
			// 从cMid起步向cMax过渡的有理式。
			chroma = cMid + (t * k1) / (1 - (1 - k1 / (cMax - cMid)) * t);
		}
		// 把极坐标C/方向重新组成Oklab的[L,a,b]。
		lab = [L, chroma * a, chroma * b];
	}
	// Oklab→线性RGB→编码RGB，末步会钳通道及取整。
	return linearSrgbToRgb(oklabToLinearSrgb(lab));
}

/**
 * Convert sRGB channels (0-255) to OKHSL.
 * @returns Hue `h` in degrees (0 for grays), saturation `s` and lightness `l` 0-1.
 */
// 编码RGB转OKHSL，返回{h度,s,l}；例：黑色走无彩分支返回h=0/s=0，一般灰色仍可能因浮点残差没有触发该阈值。
// 先Oklab、亮度曲线、按色度相对中点反解分段s，最后只钳s到0..1；假设RGB正常，不额外保证范围外输入l合法，无修改。
export function rgbToOkhsl(rgb: RgbColor): { h: number; s: number; l: number } {
	// RGB先去曲线/换矩阵为L/a/b。
	const [L, labA, labB] = rgbToOklab(rgb);
	// hypot求色度√(a²+b²)。
	const chroma = Math.hypot(labA, labB);
	// L经toe曲线成为OKHSL亮度。
	const lightness = oklabToOkhslLightness(L);
	// 接近无彩或亮度到边界就避免除色度/边界计算；l原样返回，不在这里钳制。
	if (chroma < 1e-9 || lightness <= 0 || lightness >= 1) return { h: 0, s: 0, l: lightness };

	// atan2求颜色轴角度，转度并环绕。
	const hue = ((Math.atan2(labB, labA) * 180) / Math.PI + 360) % 360;
	// a/C、b/C成为单位色相方向，再求色度参考点。
	const [c0, cMid, cMax] = chromaStops(L, labA / chroma, labB / chroma);
	// 饱和度稍后由两条逆分式之一赋值。
	let saturation: number;
	// 实际C低于cMid时反解第一段。
	if (chroma < cMid) {
		// 第一段斜率同正向转换。
		const k1 = 0.8 * c0;
		// 正向有理式的反解再乘0.8，恢复低饱和段s。
		saturation = 0.8 * (chroma / (k1 + (1 - k1 / cMid) * chroma));
		// 否则反解0.8以上段。
	} else {
		// 第二段斜率与正向公式保持相同。
		const k1 = (0.2 * cMid ** 2 * 1.25 ** 2) / c0;
		// 色度先扣掉cMid，只看第二段增量。
		const offset = chroma - cMid;
		// 用逆有理式恢复高饱和段，再加0.8。
		saturation = 0.8 + 0.2 * (offset / (k1 + (1 - k1 / (cMax - cMid)) * offset));
	}
	// 输出h和l，s经min/max钳到0..1；NaN仍可能传播，并非输入验证。
	return { h: hue, s: Math.min(1, Math.max(0, saturation)), l: lightness };
}
