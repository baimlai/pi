// 验证纯字符串换行中的样式/背景/链接边界和列宽计算；控制串只作为数据参与断言，不发送到真实终端，不访问示例 URL。
// 导入 Node 断言；deepStrictEqual 比较整组输出，strictEqual 比较单值，ok 检查条件真值。
import assert from "node:assert";
// describe/it 注册测试分组与同步用例，测试回调失败时抛断言错误。
import { describe, it } from "node:test";
// visibleWidth 计算估计终端列数，wrapTextWithAnsi 按词/CJK字素换行并保留支持的控制码，均不做 I/O。
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

// 第一大组检查 SGR 样式及基本换行；具体样例宽度足够放下单字素，不能从这些测试推断任意极窄宽度都不超宽。
describe("wrapTextWithAnsi", () => {
	// 下划线子组关注起效位置与行末局部关闭，避免延伸到调用者随后补的空白。
	describe("underline styling", () => {
		// 输入前缀加下划线长 URL，按40列折行，断言第一行不提前着下划线、下一行才开始；URL 只是字符串。
		it("should not apply underline style before the styled text", () => {
			// SGR4 开启下划线，ESC 用十六进制转义表示。
			const underlineOn = "\x1b[4m";
			// SGR24 仅关闭下划线，不等于 SGR0 全面重置。
			const underlineOff = "\x1b[24m";
			// 构造长词样例，没有网络请求。
			const url = "https://example.com/very/long/path/that/will/wrap";
			// 模板插值把下划线控制码仅放在 URL 两端，前缀应保持无下划线。
			const text = `read this thread ${underlineOn}${url}${underlineOff}`;

			// 请求每行最多40估计列的换行结果，不额外补齐空格。
			const wrapped = wrapTextWithAnsi(text, 40);

			// First line should NOT contain underline code - it's just "read this thread"
			// 严格比较整条首行，连下划线控制码与尾部空格都不允许混入。
			assert.strictEqual(wrapped[0], "read this thread");

			// Second line should start with underline, have URL content
			// 检查第二行的控制串起点，证明样式跟随 URL 移到新行。
			assert.strictEqual(wrapped[1].startsWith(underlineOn), true);
			// 检查 URL 开头出现在第二行，没有断言第二行完整内容。
			assert.ok(wrapped[1].includes("https://"));
		});

		// 把下划线范围内的尾空格放在关闭码前，按18列折行，检查首行不残留“空格紧接关闭码”；不宣称删除所有内部空格。
		it("should not have whitespace before underline reset code", () => {
			// 准备下划线开启码。
			const underlineOn = "\x1b[4m";
			// 准备只关闭下划线的码。
			const underlineOff = "\x1b[24m";
			// 输入中 here 后故意留一空格，再关闭下划线并接 more。
			const textWithUnderlinedTrailingSpace = `${underlineOn}underlined text here ${underlineOff}more`;

			// 按18列拆行，触发文本与控制码相邻的裁剪边界。
			const wrapped = wrapTextWithAnsi(textWithUnderlinedTrailingSpace, 18);

			// includes 搜索特定相邻子串，再取反；仅约束第一行，不比较所有行的完整输出。
			assert.ok(!wrapped[0].includes(` ${underlineOff}`));
		});

		// 用更长 URL 产生中间行，逐条检查含下划线开启码的中间行以24m收尾且不以0m收尾；不实际添加 padding。
		it("should not bleed underline to padding - each line should end with reset for underline only", () => {
			// SGR4 开启下划线。
			const underlineOn = "\x1b[4m";
			// SGR24 关闭下划线但保留其他样式。
			const underlineOff = "\x1b[24m";
			// 长 URL 作为可按字素切开的单词。
			const url = "https://example.com/very/long/path/that/will/definitely/wrap";
			// 普通前缀/后缀包围带下划线的词，检验跨行继承与最终关闭。
			const text = `prefix ${underlineOn}${url}${underlineOff} suffix`;

			// 30列预算会把长词拆成多段。
			const wrapped = wrapTextWithAnsi(text, 30);

			// Middle lines (with underlined content) should end with underline-off, not full reset
			// Line 1 and 2 contain underlined URL parts
			// 从下标1到倒数第二行检查，跳过首行普通前缀和末行收尾。
			for (let i = 1; i < wrapped.length - 1; i++) {
				// 按当前索引取得输出行，本例没有在这一行再做运行时存在性校验。
				const line = wrapped[i];
				// 只有含开启码的行才要求局部收尾，避免对普通前缀行作错误要求。
				if (line.includes(underlineOn)) {
					// Should end with underline off, NOT full reset
					// 确认字符串末尾是下划线关闭码。
					assert.strictEqual(line.endsWith(underlineOff), true);
					// 排除行末全面 reset，防止背景等状态也被清掉。
					assert.strictEqual(line.endsWith("\x1b[0m"), false);
				}
			}
		});
	});

	// #10925
	// 对应上方 #10925 的边界回归组：空格可被丢弃，但空格携带的样式关闭码不能丢。
	describe("styled words at the wrap boundary", () => {
		// 粗体词刚好装满9列，下一词移到第二行；完整数组比较证明关闭码留在原行，且下一行无前导空格。
		it("keeps the closing code on the wrapped line and drops the following space", () => {
			// 输入 aaaa+空格+粗体bold 共9列，断言两行精确输出。
			assert.deepStrictEqual(wrapTextWithAnsi("aaaa \x1b[1mbold\x1b[22m next word", 9), [
				// 首行保留 SGR22 关闭粗体，不将它误挪到下一行。
				"aaaa \x1b[1mbold\x1b[22m",
				// 第二行从 next 开始，不继承已经关闭的粗体。
				"next word",
			]);
		});

		// 红色词占满8列后跟两个空格；丢空格时仍要应用默认前景码，完整数组不得在 next 前重新开启红色。
		it("does not re-open a style closed by the dropped space", () => {
			// 比较按8列换行的实际数组与下面两行预期。
			assert.deepStrictEqual(wrapTextWithAnsi("aaaa \x1b[31mred\x1b[39m  next", 8), [
				// 首行以 SGR39 关闭前景红色，保留词内原码。
				"aaaa \x1b[31mred\x1b[39m",
				// 下一行只有普通 next，不能恢复已关闭的前景色。
				"next",
			]);
		});

		// 遍历三种含20个空格的样式输入，按10列换行并检查每行列宽；只覆盖这些 ASCII/样式边界，不是通用宽度证明。
		it("does not exceed width for styled whitespace wider than the line", () => {
			// for...of 逐个拿到输入串，数组字面量里的模板均只是测试数据。
			for (const text of [
				// 单独红背景空白后全面重置，重置码不能挡住尾空格处理。
				`\x1b[41m${" ".repeat(20)}\x1b[0m`,
				// 短前缀与短后缀之间夹带背景长空白。
				`ab\x1b[41m${" ".repeat(20)}\x1b[49mcd`,
				// 黄色长空白后还有可见 x，不能只依赖最终字符串 trimEnd。
				`\x1b[33m${" ".repeat(20)}x\x1b[39m`,
			]) {
				// 对每个输入的所有输出行做检查，不只看第一行。
				for (const line of wrapTextWithAnsi(text, 10)) {
					// 估计列宽不超过10；JSON.stringify(line) 仅作为失败消息暴露控制字符，不影响比较。
					assert.ok(visibleWidth(line) <= 10, JSON.stringify(line));
				}
			}
		});

		// 短词后有删除线空格和超长词，预期先裁旧行尾空格再加关闭码，长词拆成9+1列并正确续接删除线。
		it("trims trailing spaces before the line-end reset when a long word follows", () => {
			// SGR9/29 开关删除线，宽9迫使 abcdefghij 拆开；对完整三行做深比较。
			assert.deepStrictEqual(wrapTextWithAnsi("aaa\x1b[9m    abcdefghij\x1b[29m", 9), [
				// 旧行只保留 aaa 与删除线开关，四个尾空格应消失。
				"aaa\x1b[9m\x1b[29m",
				// 长词首段9个字母，段尾局部关闭删除线。
				"\x1b[9mabcdefghi\x1b[29m",
				// 最后的 j 前重开删除线，原输入最终29m将其关闭。
				"\x1b[9mj\x1b[29m",
			]);
		});

		// 删除线词组跨12列边界，验证行末29m关闭、续行9m重开；完整输出同时检查空格裁剪。
		it("resets strikethrough at line end and restores it on the next line", () => {
			// 比较源串换行后的两行。
			assert.deepStrictEqual(wrapTextWithAnsi("aaaa \x1b[9mstrike me\x1b[29m next", 12), [
				// 第一行结尾局部关删除线，避免覆盖之后补白。
				"aaaa \x1b[9mstrike\x1b[29m",
				// 续行先恢复删除线，me 后用原码关闭，next 保持普通样式。
				"\x1b[9mme\x1b[29m next",
			]);
		});

		// 红背景与删除线合并开启，按6列折行；预期行末仅关删除线，下一行同时恢复删除线和背景，不清背景。
		it("preserves background when resetting strikethrough at line end", () => {
			// 41;9 是组合 SGR，深比较也约束此实现重建控制码的具体顺序。
			assert.deepStrictEqual(wrapTextWithAnsi("\x1b[41;9mstrike me\x1b[0m", 6), [
				// 首行保留红背景并用29m局部关闭删除线。
				"\x1b[41;9mstrike\x1b[29m",
				// 第二行重建为9;41组合，最后保留输入全面 reset。
				"\x1b[9;41mme\x1b[0m",
			]);
		});
	});

	// 背景延续子组关注中间行不被全面 reset 清掉；函数本身不会补背景或补白。
	describe("background color preservation", () => {
		// 蓝背景长句按15列折行，要求每行都有背景开启码且非末行不以全面 reset 收尾；只验证字符串，不证明终端实际绘制颜色。
		it("should preserve background color across wrapped lines without full reset", () => {
			// SGR44 表示蓝背景。
			const bgBlue = "\x1b[44m";
			// SGR0 全面重置，作为原输入末尾结束样式。
			const reset = "\x1b[0m";
			// 把整句包在蓝背景与最终 reset 之间。
			const text = `${bgBlue}hello world this is blue background text${reset}`;

			// 按15列获得多行结果。
			const wrapped = wrapTextWithAnsi(text, 15);

			// Each line should have background color
			// 遍历包括最后一行在内的全部输出。
			for (const line of wrapped) {
				// 每行都应包含蓝背景开启码，续行需要从跟踪状态重建。
				assert.ok(line.includes(bgBlue));
			}

			// Middle lines should NOT end with full reset (kills background for padding)
			// 只检查非末行，末行允许含原始最终 reset。
			for (let i = 0; i < wrapped.length - 1; i++) {
				// 中间行不能以全面重置结尾，防止后续补白失去背景。
				assert.strictEqual(wrapped[i].endsWith("\x1b[0m"), false);
			}
		});

		// 红背景中含下划线长词，检查背景在各行保留，并对仍带未关闭下划线的非末行要求局部关闭；不是完整 ANSI 解释器测试。
		it("should reset underline but preserve background when wrapping underlined text inside background", () => {
			// 下划线开启码。
			const underlineOn = "\x1b[4m";
			// 下划线关闭码，后面用 includes 检查是否已出现过。
			const underlineOff = "\x1b[24m";
			// 原输入结尾全面重置码。
			const reset = "\x1b[0m";

			// 红背景从 prefix 开始，下划线只覆盖长词，suffix 仍在背景范围内。
			const text = `\x1b[41mprefix ${underlineOn}UNDERLINED_CONTENT_THAT_WRAPS${underlineOff} suffix${reset}`;

			// 20列预算让长词跨行。
			const wrapped = wrapTextWithAnsi(text, 20);

			// All lines should have background color 41 (either as \x1b[41m or combined like \x1b[4;41m)
			// 先检查每一行是否携带红背景标记。
			for (const line of wrapped) {
				// 允许独立41或与其他属性合并的几种字面形式；这是有限字符串检查，不完整解析全部 SGR 编码。
				const hasBgColor = line.includes("[41m") || line.includes(";41m") || line.includes("[41;");
				// 背景码缺失使本例失败。
				assert.ok(hasBgColor);
			}

			// Lines with underlined content should use underline-off at end, not full reset
			// 非末行才检查人为添加的行尾关闭规则。
			for (let i = 0; i < wrapped.length - 1; i++) {
				// 取本轮输出行。
				const line = wrapped[i];
				// If this line has underline on, it should end with underline off (not full reset)
				// 复合 if 同时要求出现开启样式且没有任何下划线关闭码，才检查下方局部收尾断言。
				if (
					// 兼容单独4、组合首项4、组合末项4这几种本例可能输出的形式。
					(line.includes("[4m") || line.includes("[4;") || line.includes(";4m")) &&
					// 若行中已出现24m，则跳过该断言；这不是判断“行末最终样式”的完整状态机。
					!line.includes(underlineOff)
				) {
					// 对命中条件的行要求最后以24m关闭下划线。
					assert.strictEqual(line.endsWith(underlineOff), true);
					// 并且不以0m全面重置结束，保留背景状态。
					assert.strictEqual(line.endsWith("\x1b[0m"), false);
				}
			}
		});
	});

	// 基础组检查逻辑换行、普通文本/CJK分段、OSC宽度和区域指示符列宽。
	describe("basic wrapping", () => {
		// 混合 LF/CRLF/CR 按80列处理，要求四条逻辑行；样例每行都足够短，无额外折行。
		it("should handle LF, CRLF, and CR line endings", () => {
			// 深比较输出数组，CRLF 应作为一个换行而非两个空行。
			assert.deepStrictEqual(wrapTextWithAnsi("first\nsecond\r\nthird\rfourth", 80), [
				// LF 前的第一段。
				"first",
				// LF 与 CRLF 之间的第二段。
				"second",
				// CRLF 与 CR 之间的第三段。
				"third",
				// 最后一段，不含换行符。
				"fourth",
			]);
		});

		// 红色跨 CRLF/CR 的逻辑换行，要求每一后续行重开红色，原最终 reset 只保留在末行；断言整组字符。
		it("should preserve ANSI state across CRLF and CR line endings", () => {
			// SGR31 开前景红色。
			const red = "\x1b[31m";
			// SGR0 在源串最后全面重置。
			const reset = "\x1b[0m";

			// 80列不触发单行内部折行，仅验证逻辑行之间样式传递。
			assert.deepStrictEqual(wrapTextWithAnsi(`${red}first\r\nsecond\rthird${reset}`, 80), [
				// 首行保留源头红色码。
				`${red}first`,
				// 第二行来自跨逻辑行跟踪器补入的红色码。
				`${red}second`,
				// 末行也重开红色，再保留原串最终 reset。
				`${red}third${reset}`,
			]);
		});

		// 普通英语按10列换行，至少两行且各行估计列宽≤10；并未比较完整词序数组。
		it("should wrap plain text correctly", () => {
			// 准备无控制码的普通句子。
			const text = "hello world this is a test";
			// 调用按词换行器。
			const wrapped = wrapTextWithAnsi(text, 10);

			// 先证明发生了拆行，避免“原样单行”误通过后续意图。
			assert.ok(wrapped.length > 1);
			// 对每条生成行检查。
			for (const line of wrapped) {
				// 列宽与10比较，不使用包含ANSI码的 string.length 作通用列宽。
				assert.ok(visibleWidth(line) <= 10);
			}
		});

		// 拉丁前缀后紧接连续中文，按40列允许 CJK 字素间断行；精确数组和宽度共同验证给定样例。
		it("should break CJK runs at grapheme boundaries after Latin text", () => {
			// 连续中文没有普通空格，不能完全依赖英语单词边界。
			const text = "This is an example 中文汉字测试段落内容中文汉字测试段落内容.";
			// 40列预算以中文通常两列计，不把每个汉字当一列。
			const wrapped = wrapTextWithAnsi(text, 40);

			// 精确检查两行文本边界，要求没有拆坏字符或丢字。
			assert.deepStrictEqual(wrapped, ["This is an example 中文汉字测试段落内容", "中文汉字测试段落内容."]);
			// 逐行补充列宽约束。
			for (const line of wrapped) {
				// 估计宽度不得超40，覆盖本例的 Latin/CJK 混合情况。
				assert.ok(visibleWidth(line) <= 40);
			}
		});

		// 同一混合句加红色控制码，要求两行文本及颜色恢复精确匹配，并再次检查宽度；不会输出控制串到终端。
		it("should preserve color codes when wrapping CJK runs", () => {
			// 红色开启码作为源串前缀。
			const red = "\x1b[31m";
			// 全面重置作为源串后缀。
			const reset = "\x1b[0m";
			// 模板组合颜色与原始混合文本，控制码不算可见列。
			const text = `${red}This is an example 中文汉字测试段落内容中文汉字测试段落内容.${reset}`;
			// 以40列执行换行。
			const wrapped = wrapTextWithAnsi(text, 40);

			// 要求恰好两行。
			assert.strictEqual(wrapped.length, 2);
			// 首行保留初始红色，不额外添加全面 reset。
			assert.strictEqual(wrapped[0], `${red}This is an example 中文汉字测试段落内容`);
			// 第二行先重开红色，末尾保留原 reset。
			assert.strictEqual(wrapped[1], `${red}中文汉字测试段落内容.${reset}`);
			// 逐条输出再检查列宽。
			for (const line of wrapped) {
				// 颜色控制码不能让宽度计算多算列。
				assert.ok(visibleWidth(line) <= 40);
			}
		});

		// OSC133语义标记以BEL结束，夹着 hello；这里只测标记零宽，不验证 shell integration 行为。
		it("should ignore OSC 133 semantic markers in visible width", () => {
			// A/B是控制数据，BEL转义结束 OSC，只有 hello 是可见文字。
			const text = "\x1b]133;A\x07hello\x1b]133;B\x07";
			// 预期五列，不把控制参数计入。
			assert.strictEqual(visibleWidth(text), 5);
		});

		// 同样的 OSC 标记改以ST结束，验证宽度扫描识别另一种终止形式；无实际终端协议协商。
		it("should ignore OSC sequences terminated with ST in visible width", () => {
			// ST 是 ESC 后跟反斜杠，字符串转义后得到实际控制串。
			const text = "\x1b]133;A\x1b\\hello\x1b]133;B\x1b\\";
			// 两端 OSC 都应跳过，只计 hello 五列。
			assert.strictEqual(visibleWidth(text), 5);
		});

		// 区域指示符单个或组成旗帜都按当前宽度规则计2列；只检查给定两个 Unicode 样例。
		it("should treat isolated regional indicators as width 2", () => {
			// 孤立区域指示符C不是 ASCII 字母C，预期两列。
			assert.strictEqual(visibleWidth("🇨"), 2);
			// 两个区域指示符组成的中国旗帜作为一个旗帜字素也占两列。
			assert.strictEqual(visibleWidth("🇨🇳"), 2);
		});

		// 两空格放进1列时应去掉超宽尾空白；这里只检查第一条结果宽度，不断言输出恰有几行。
		it("should truncate trailing whitespace that exceeds width", () => {
			// 触发纯空格超宽处理。
			const twoSpacesWrappedToWidth1 = wrapTextWithAnsi("  ", 1);
			// 首行宽度≤1即可，不要求一定保留一个空格。
			assert.ok(visibleWidth(twoSpacesWrappedToWidth1[0]) <= 1);
		});

		// 红色英语跨10列多行，检查所有续行起点都重开红色，非末行不全面 reset；未比较每一行的完整文本。
		it("should preserve color codes across wraps", () => {
			// 前景红色开启码。
			const red = "\x1b[31m";
			// 原串末尾全面重置码。
			const reset = "\x1b[0m";
			// 把整句包在红色状态中。
			const text = `${red}hello world this is red${reset}`;

			// 请求10列换行结果。
			const wrapped = wrapTextWithAnsi(text, 10);

			// Each continuation line should start with red code
			// 从第二行开始遍历，首行原本就带输入前缀，不属于恢复样式的证明。
			for (let i = 1; i < wrapped.length; i++) {
				// 每条续行都以同样红色码开头。
				assert.strictEqual(wrapped[i].startsWith(red), true);
			}

			// Middle lines should not end with full reset
			// 遍历所有非末行，允许最终行保留原 reset。
			for (let i = 0; i < wrapped.length - 1; i++) {
				// 非末行不能以全面 reset 结束。
				assert.strictEqual(wrapped[i].endsWith("\x1b[0m"), false);
			}
		});
	});
});

// OSC8链接组验证换行处关闭/恢复链接与保留原BEL/ST结束符；链接地址从不被访问。
describe("wrapTextWithAnsi with OSC 8 hyperlinks", () => {
	// 十个可见数字带ST链接按6列拆行；去控制码后有正文的行必须包含原链接开启串，断言允许开启串不在行首。
	it("re-emits OSC 8 open at the start of continuation lines", () => {
		// A hyperlink whose text is long enough to wrap
		// 固定 URL 作为 OSC8 载荷，不是 fetch 参数。
		const url = "https://example.com";
		// OSC 8 open + text that is 10 visible chars + OSC 8 close
		// 模板拼出 OSC8开启、十个数字、OSC8关闭；ST结束符在源码中用转义表示。
		const input = `\x1b]8;;${url}\x1b\\0123456789\x1b]8;;\x1b\\`;
		// 六列使十数字拆成多行，链接载荷长度不参与列宽。
		const lines = wrapTextWithAnsi(input, 6);

		// Every line that contains visible text from inside the hyperlink
		// should start with the OSC 8 open sequence (or be preceded by it).
		// 检查每条结果，包含没有可见文字的控制串行也可被遍历到。
		for (const line of lines) {
			// If the line has visible content it must begin with the OSC 8 re-open
			// OR it is the line where the close appeared with no following content.
			// 两个全局正则分别剥离本例ST链接和简单SGR，生成仅供本断言判空的串；不是项目完整ANSI剥离器。
			const stripped = line.replace(/\x1b\]8;;[^\x1b\x07]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
			// trim 后还有文字才要求链接开启码，空白/纯控制行不进入。
			if (stripped.trim().length > 0) {
				// 条件失败时 assert.ok 抛出，并附下面的原行诊断。
				assert.ok(
					// startsWith 或 includes 允许码在行首或更后面；实际证明是“存在开启码”，没有独立证明正文前的严格位置。
					line.startsWith(`\x1b]8;;${url}\x1b\\`) || line.includes(`\x1b]8;;${url}\x1b\\`),
					// 模板插入原行作为失败信息，不改变测试输入或输出。
					`Line "${line}" has visible text but no OSC 8 re-open`,
				);
			}
		}
	});

	// 对非末行中含ST链接开启串者，要求行末关闭链接，避免下行填充继续可点击；仅检查这个十数字样例。
	it("closes OSC 8 before each line break", () => {
		// 固定链接地址。
		const url = "https://example.com";
		// 重新构造十数字的完整ST链接文本。
		const input = `\x1b]8;;${url}\x1b\\0123456789\x1b]8;;\x1b\\`;
		// 六列宽生成至少一条中间行。
		const lines = wrapTextWithAnsi(input, 6);

		// 不检查最终行的人工换行收尾，因为它保留源串的自然关闭。
		for (let i = 0; i < lines.length - 1; i++) {
			// 读取当前非末行。
			const line = lines[i];
			// Every non-final line that is inside a hyperlink should end with the close
			// 只有包含本链接开启码的行才要求对应收尾。
			if (line.includes(`\x1b]8;;${url}\x1b\\`)) {
				// 断言该行末尾关闭链接，失败附原始行。
				assert.ok(
					// 空URL的OSC8加ST表示链接关闭。
					line.endsWith("\x1b]8;;\x1b\\"),
					// 失败消息解释是哪条中间行没有关闭。
					`Non-final line "${line}" is inside a hyperlink but does not close it`,
				);
			}
		}
	});

	// 模拟OAuth样式的长URL自身作为链接正文，以BEL结束OSC；按20列折行后检查每行BEL重开、非末行BEL关闭，不能擅改成ST。
	it("preserves BEL terminators when wrapping OAuth-style hyperlinks", () => {
		// repeat(32)只是加长测试URL路径，不生成真实令牌或执行OAuth流程。
		const url = `https://example.com/oauth/${"a".repeat(32)}`;
		// 地址既是载荷也是可见正文，两个BEL终止分别对应开/关链接。
		const input = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		// 按20列切可见URL，载荷不计宽。
		const lines = wrapTextWithAnsi(input, 20);

		// 先验证确实发生多行换行。
		assert.ok(lines.length > 1);
		// 遍历所有结果，包括最终行。
		for (const line of lines) {
			// 每行必须含带BEL结束的同一开启码；失败消息指出缺少恢复。
			assert.ok(line.includes(`\x1b]8;;${url}\x07`), `Line "${line}" does not reopen the hyperlink with BEL`);
			// 同时拒绝同一URL的ST版本，避免只检查“有链接”却漏掉终止符变化。
			assert.ok(!line.includes(`\x1b]8;;${url}\x1b\\`), `Line "${line}" reopens the hyperlink with ST`);
		}
		// slice(0,-1)生成去掉末行的新数组，专门检查人工换行前的关闭。
		for (const line of lines.slice(0, -1)) {
			// 要求非末行以BEL版空URL关闭，消息仅用于失败诊断。
			assert.ok(line.endsWith("\x1b]8;;\x07"), `Line "${line}" does not close the hyperlink with BEL`);
		}
	});

	// 普通文字包围短链接且80列完全容纳，只检查一行恰有一开一关；并未单独测试多行中链接范围外的行。
	it("does not emit OSC 8 sequences on lines that are outside the hyperlink", () => {
		// 固定URL，不会打开浏览器。
		const url = "https://example.com";
		// before/after在链接范围外，只有 link 放在OSC8开关之间。
		const input = `before \x1b]8;;${url}\x1b\\link\x1b]8;;\x1b\\ after`;
		// 80列使该样例原样放下，不触发续行状态恢复。
		const lines = wrapTextWithAnsi(input, 80);

		// With width 80 everything fits on one line; there should be exactly one
		// OSC 8 open and one OSC 8 close.
		// 确认只有一行，后面计数都针对这条完整结果。
		assert.strictEqual(lines.length, 1);
		// g 正则找带 https: 载荷的ST开启串；match无结果时??回退空数组，其长度即计数。
		const openCount = (lines[0].match(/\x1b\]8;;https:[^\x1b]+\x1b\\/g) ?? []).length;
		// 另一正则只找空URL的ST关闭串，同样把无匹配计为0。
		const closeCount = (lines[0].match(/\x1b\]8;;\x1b\\/g) ?? []).length;
		// 恰一个开启串，不能制造额外重开。
		assert.strictEqual(openCount, 1);
		// 恰一个关闭串，不能制造额外关闭。
		assert.strictEqual(closeCount, 1);
	});
});
