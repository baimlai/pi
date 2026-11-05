// 测浮层起列落在双宽汉字中间或边界时的切片/补格，纯字符串合成，不开真实窗口；各 it 无参数、正常返回 void，断言失败抛错。
// strictEqual 检文字/宽度；不测字体实际字形或全部 ANSI 状态组合。
import assert from "node:assert";
// 注册组与各边界用例。
import { describe, it } from "node:test";
// 公共合成器按显示列取左/浮层/右段，并在段间重置样式，不直接写终端。
import { compositeTuiLine } from "../src/tui.ts";
// extractSegments 同时取左右段，sliceByColumn 取显示列范围，visibleWidth 测估算列数；三者都不是按 UTF-16 下标裁剪。
import { extractSegments, sliceByColumn, visibleWidth } from "../src/utils.ts";

// 回归组分清“宽字不能留半个”和“浮层起列仍须准确”，缺格由合成器补白。
describe("overlay CJK boundary regression", () => {
	// 左片段边界例：汉字占列 4..6，beforeEnd=5 落在其中，整个汉字不能进入 before。
	it("excludes a wide grapheme from before when overlay starts inside it", () => {
		// 取左段到 5，右段从 9 最多 11 列，true 使右端严格；输入总宽 10，不补不存在的行尾内容。
		const segments = extractSegments("abcd让EFGH", 5, 9, 11, true);

		// 左侧只保留 abcd，不留半个汉字。
		assert.strictEqual(segments.before, "abcd");
		// 左段实际宽 4，不能错误报请求终界 5。
		assert.strictEqual(segments.beforeWidth, 4);
		// 重新测左段显示宽必须与辅助函数返回宽一致。
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
		// 汉字之后 E/F/G/H 起列依次 6/7/8/9，所以右段从 9 只剩 H。
		assert.strictEqual(segments.after, "H");
		// 右段实际宽 1。
		assert.strictEqual(segments.afterWidth, 1);
	});

	// ASCII 对照：相同终界 5 可以完整留住单列 G，不能因为修宽字而一律少保留一列。
	it("keeps ASCII before-segment behavior at the same boundary", () => {
		// 五个单列 abcdG 后空格，右段参数与上一例同样。
		const segments = extractSegments("abcdG EFGH", 5, 9, 11, true);

		// before 应包含完整 abcdG。
		assert.strictEqual(segments.before, "abcdG");
		// 这次左段实际宽为 5。
		assert.strictEqual(segments.beforeWidth, 5);
		// visibleWidth 重算应一致。
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
	});

	// 合成在宽字内部例：舍弃汉字后需补缺的一格，再把浮层准确放到列 5，而不是紧贴列 4。
	it("composites an overlay at the requested column when it starts inside a wide grapheme", () => {
		// 输入底行、4 列浮层、起列 5、总宽 20；合成器添加段间控制重置和空白补齐。
		const out = compositeTuiLine("abcd让EFGH", "│XX│", 5, 4, 20);
		// 严格取结果前 5 列，用来检查汉字被删后的空位已补齐。
		const prefix = sliceByColumn(out, 0, 5, true);
		// 严格取起列 5 的 4 列，定位浮层实际占位。
		const overlay = sliceByColumn(out, 5, 4, true);

		// 原汉字不该出现在结果，避免残半字或挤到别处。
		assert.strictEqual(out.includes("让"), false);
		// 最终整行补到 20 列。
		assert.strictEqual(visibleWidth(out), 20);
		// 前缀虽只四个原字母，也要因补空格达到请求起列 5。
		assert.strictEqual(visibleWidth(prefix), 5);
		// 浮层区域正好 4 列。
		assert.strictEqual(visibleWidth(overlay), 4);
		// 四列区域含完整边框/XX 文本，检其确实落在指定位置。
		assert.strictEqual(overlay.includes("│XX│"), true);
	});

	// 合成在宽字左边界例：起列 4 无需补内部缺格，但覆盖汉字仍须整体删除。
	it("composites an overlay when it starts at a wide grapheme boundary", () => {
		// 覆盖列 4..8，总宽 20；不是把字符串第 4 码元当任意显示位置。
		const out = compositeTuiLine("abcd让EFGH", "│XX│", 4, 4, 20);
		// 从结果列 4 严格取四列来核对浮层。
		const overlay = sliceByColumn(out, 4, 4, true);

		// 底图汉字被覆盖，不应留下。
		assert.strictEqual(out.includes("让"), false);
		// 结果仍为 20 列。
		assert.strictEqual(visibleWidth(out), 20);
		// 浮层四列完整保留。
		assert.strictEqual(visibleWidth(overlay), 4);
		// 区域内应包含完整边框和 XX，不只验证总宽正确。
		assert.strictEqual(overlay.includes("│XX│"), true);
	});
});
