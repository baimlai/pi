// 检查区域指示符与表情流式中间态的保守列宽/换行规则；只算字符串，不连模型流或真实终端。每个 it 无参数/正常返回 void，断言失败抛错。
// strictEqual 以数值严格比较宽度，不把码点数当显示列。
import assert from "node:assert";
// 注册测试组与场景。
import { describe, it } from "node:test";
// 使用实际列宽和 ANSI 折行工具，宽度按项目兼容策略，不是字体像素测量。
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

// 分组复现流式拼国旗中尚只有一个区域指示符时的计宽漂移。
describe("regional indicator width regression", () => {
	// 半旗例：单个区域指示符就按 2 列，不等待第二个组成完整旗帜；这是避免绘制漂移的规则，不保证所有终端视觉相同。
	it("treats partial flag grapheme as full-width to avoid streaming render drift", () => {
		// Repro context:
		// During streaming, "🇨🇳" often appears as an intermediate "🇨" first.
		// If "🇨" is measured as width 1 while terminal renders it as width 2,
		// differential rendering can drift and leave stale characters on screen.
		// 构造一个区域指示符，虽然只一个 Unicode 码点，在 UTF-16 中是代理对，不是长度 1 的 ASCII。
		const partialFlag = "🇨";
		// 六空格、短横、一空格共 8 列，再接该符号。
		const listLine = "      - 🇨";

		// 符号单独的估算宽应为 2。
		assert.strictEqual(visibleWidth(partialFlag), 2);
		// 列表整行应为 8+2=10。
		assert.strictEqual(visibleWidth(listLine), 10);
	});

	// 9 列折行例：10 列样本必须拆行，且不能切半个符号。
	it("wraps intermediate partial-flag list line before overflow", () => {
		// Width 9 cannot fit "      - 🇨" if 🇨 is width 2 (8 + 2 = 10).
		// This must wrap to avoid terminal auto-wrap mismatch.
		// 用真实折行器处理，不直接把源串按 9 个码元 slice。
		const wrapped = wrapTextWithAnsi("      - 🇨", 9);

		// 应分成两行。
		assert.strictEqual(wrapped.length, 2);
		// 第一行在换行时 trim 掉末尾空格，保留六空格加短横共 7 列；|| 空串只是防缺项取宽抛错，行数另有检查。
		assert.strictEqual(visibleWidth(wrapped[0] || ""), 7);
		// 第二行完整区域指示符占 2。
		assert.strictEqual(visibleWidth(wrapped[1] || ""), 2);
	});

	// 遍历整个区域指示符码点范围例：26 个单符号都应按保守双宽计，不只测一个具体旗帜字母。
	it("treats all regional-indicator singleton graphemes as width 2", () => {
		// 十六进制范围 U+1F1E6..U+1F1FF，含两端；cp++ 每次递增一个码点。
		for (let cp = 0x1f1e6; cp <= 0x1f1ff; cp++) {
			// fromCodePoint 支持辅助平面码点，区别于仅按 16 位码元的 fromCharCode。
			const regionalIndicator = String.fromCodePoint(cp);
			// 多行参数组成一次 strictEqual 调用，失败消息在后面生成。
			assert.strictEqual(
				// 实际值为当前单符号的显示列宽。
				visibleWidth(regionalIndicator),
				// 期望数值 2。
				2,
				// 模板插入样本与大写十六进制码点，供失败定位；没有输出到真实终端的主动操作。
				`Expected ${regionalIndicator} (U+${cp.toString(16).toUpperCase()}) to be width 2`,
			);
		}
	});

	// 完整旗帜例：两个区域指示符组合仍为整体 2 列，不能因半旗都 2 就合起来算 4。
	it("keeps full flag pairs at width 2", () => {
		// 六个完整旗帜样本，不据此覆盖全部可能 Unicode 组合。
		const samples = ["🇯🇵", "🇺🇸", "🇬🇧", "🇨🇳", "🇩🇪", "🇫🇷"];
		// 逐个计算每个完整字素。
		for (const flag of samples) {
			// 预期都为 2，第三参数仅为断言失败时的说明。
			assert.strictEqual(visibleWidth(flag), 2, `Expected ${flag} to be width 2`);
		}
	});

	// 常见表情中间态例：含肤色、变体选择符、连接符的样本保持整体双宽，不通过真实流逐字节渲染。
	it("keeps common streaming emoji intermediates at stable width", () => {
		// 固定样本覆盖单表情及部分扩展组合，保留原始字面量，不能泛化为任意表情字符串全是 2。
		const samples = ["👍", "👍🏻", "✅", "⚡", "⚡️", "👨", "👨‍💻", "🏳️‍🌈"];
		// 逐个取完整样本，不逐 UTF-16 码元迭代。
		for (const sample of samples) {
			// 每个示例按项目规则为 2，失败消息帮助定位具体样本。
			assert.strictEqual(visibleWidth(sample), 2, `Expected ${sample} to be width 2`);
		}
	});
});
