// 测颜色解析、色域映射和 ANSI 字符串编码，纯内存计算，不探测/改变真实终端；每个 it 无参数、正常返回 void，断言失败同步抛错。
// deepStrictEqual 比颜色对象字段，strictEqual 比完整串，throws 会实际执行传入回调并检查抛错。
import assert from "node:assert";
// 注册组与场景，回调不在 import 时立即跑完所有颜色转换。
import { describe, it } from "node:test";
// 从公开入口取真实 API，兼顾公开重导出是否可用；下面不是 mock 函数。
import {
	// 把颜色转成 #rrggbb，小数通道会取整。
	colorToHex,
	// 把具体颜色换成 OKHSL 通道，返回 {h,s,l}。
	colorToOkhsl,
	// 统一为 sRGB 通道，OKLCH 超色域时会降低色度，不直接截掉所有原输入数值。
	colorToRgb,
	// 构造 ANSI 调色板索引颜色，0..255 与具体终端用户调色板实际 RGB 不等同。
	indexedColor,
	// OKHSL 构造入口会转 RGB，返回 kind=rgb，不产生 okhsl 判别标签。
	okhslColor,
	// OKLCH 构造器保留 l/c/h 数据，转 RGB 时才映射色域。
	oklchColor,
	// 解析受支持文本或数字索引，不支持全部 CSS 颜色语法。
	parseColor,
	// 构造 RGB 颜色，通道采用 0..255 标度。
	rgbColor,
	// 样式函数返回控制串，不向终端打印。
	styleText,
} from "../src/index.ts";

// 注册颜色组，各用例只处理样本数据。
describe("colors", () => {
	// 解析例：本例只拒绝空串与 red，并非原名称 everything else 所指的所有非 hex/OKLCH；源码还支持 OKHSL/数字索引。
	it("parses hex and OKLCH colors and rejects everything else", () => {
		// 三位 hex 简写每位重复：a→aa=170、b→187、c→204，比较整个 RGB 标签对象。
		assert.deepStrictEqual(parseColor("#abc"), { kind: "rgb", r: 170, g: 187, b: 204 });
		// L 百分号转 0.62，C=0.1、H=200；结果仍是 OKLCH 对象而非先转 RGB。
		assert.deepStrictEqual(parseColor("oklch(62% 0.1 200)"), { kind: "oklch", l: 0.62, c: 0.1, h: 200 });
		// throws 的无参箭头实际解析空串，应抛含该消息的错误，不是要求返回 Error 对象。
		assert.throws(() => parseColor(""), /Invalid color value/);
		// 名称 red 不在本解析器支持语法内，回调应抛错。
		assert.throws(() => parseColor("red"), /Invalid color value/);
	});

	// 色域例：固定样本红色及最高/最低亮度的 OKLCH 换成 8 位 sRGB，未证明任意换色无误差。
	it("gamut-maps OKLCH to sRGB, including the lightness limits", () => {
		// 已知红色附近参数，经近似/取整得到 255/0/0。
		assert.deepStrictEqual(colorToRgb(oklchColor(0.627955, 0.257683, 29.2339)), { r: 255, g: 0, b: 0 });
		// L=1 的高色度输入最终映射白色，不能简单保留不可显示色度。
		assert.deepStrictEqual(colorToRgb(oklchColor(1, 0.3, 150)), { r: 255, g: 255, b: 255 });
		// L=0 相应映射黑色。
		assert.deepStrictEqual(colorToRgb(oklchColor(0, 0.3, 150)), { r: 0, g: 0, b: 0 });
	});

	// OKHSL 例：大小写、deg、百分号与范围错误都核对，再用三种 hex 做有限的往返验证，不保证所有浮点颜色无损。
	it("parses OKHSL colors and round-trips them", () => {
		// Full saturation at the red cusp is pure sRGB red.
		// 饱和度/亮度百分号换成 1/0.568，该红色样本得到与 rgbColor(255,0,0) 同字段结果。
		assert.deepStrictEqual(parseColor("okhsl(29.23 100% 56.8%)"), rgbColor(255, 0, 0));
		// 大写函数名和 deg 角度也接受，期望与直接构造 h250/s0.6/l0.55 同结果。
		assert.deepStrictEqual(parseColor("OKHSL(250deg 60% 55%)"), okhslColor(250, 0.6, 0.55));
		// s=160% 超出 0..1，应抛饱和度范围错误；throws 回调延后到断言执行时调用。
		assert.throws(() => parseColor("okhsl(250 160% 55%)"), /s must be between 0 and 1/);
		// for...of 遍历三个固定 hex，不读取外部调色板。
		for (const hex of ["#4f8eb3", "#20242a", "#f8f9fa"]) {
			// 先解析为颜色，再换到 OKHSL；对象解构把 h/s/l 数值各取成局部常量，不是保留颜色对象的可变引用。
			const { h, s, l } = colorToOkhsl(parseColor(hex));
			// 重新构造 RGB 并转 hex，应回原字符串；只针对这三个离散样本逐项相等。
			assert.strictEqual(colorToHex(okhslColor(h, s, l)), hex);
		}
	});

	// 样式例：前景/背景/粗体/斜体依次开，按相反顺序关，闭码恢复默认属性，不恢复任意外层样式栈。
	it("styles text and closes sequences in reverse order", () => {
		// 多行参数构成一次完整字符串比较。
		assert.strictEqual(
			// truecolor 让 RGB 前景用 38;2，索引背景仍用 48;5;9，不强制把索引背景展开为 RGB。
			styleText("Ready", { fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true }, "truecolor"),
			// 期望依次前景、背景、粗体、斜体、正文、关斜体、关粗体、默认背景、默认前景。
			"\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m",
		);
		// 256color 模式只要求生成 38;5;数字索引 的外壳，正则不钉死近似后的具体调色板编号，也不发送查询。
		assert.match(styleText("Ready", { fg: rgbColor(18, 52, 86) }, "256color"), /^\x1b\[38;5;\d+mReady\x1b\[39m$/);
	});
});
