// 测 TruncatedText 只取首个 LF 前文本、截断和补白的渲染行，无真实终端操作；各 it 回调无参数、正常返回 void，断言失败抛错。
// strictEqual 比数值/字符串，assert.ok 检条件，不把可见列数误称所有字符数。
import assert from "node:assert";
// 注册组件测试组及各用例。
import { describe, it } from "node:test";
// Chalk 构造器用于生成 ANSI 样式字符串，不向终端输出。
import { Chalk } from "chalk";
// 导入真实单行截断组件，与自动折行 Text 的空串/换行行为不同。
import { TruncatedText } from "../src/components/truncated-text.ts";
// 用实际宽度规则测返回行，排除 ANSI 码本身。
import { visibleWidth } from "../src/utils.ts";

// Force full color in CI so ANSI assertions are deterministic
// 独立 Chalk 实例强制 level=3 真彩色支持，保证生成样式不依赖 CI 探测；不改变真实终端能力或全局 Chalk 默认实例。
const chalk = new Chalk({ level: 3 });

// 分组只注册用例，下方每次单独建组件，render 返回新的字符串数组。
describe("TruncatedText component", () => {
	// 补白例：正文可放下时仍填满 50 列，不为短文附省略号。
	it("pads output lines to exactly match width", () => {
		// 输入 Hello world，左右各 1 列留白、上下 0 行。
		const text = new TruncatedText("Hello world", 1, 0);
		// render(50) 才生成行，构造时不写终端或预先计算。
		const lines = text.render(50);

		// Should have exactly one content line (no vertical padding)
		// 上下无留白，因此仅有一条正文行。
		assert.strictEqual(lines.length, 1);

		// Line should be exactly 50 visible characters
		// 测首行显示列，不能直接用 line.length（有 ANSI 时不同）。
		const visibleLen = visibleWidth(lines[0]);
		// 必须恰好 50，证明不足列被空格补齐。
		assert.strictEqual(visibleLen, 50);
	});

	// 垂直留白例：上下各 2 行，加正文 1 行，共 5 行，每行都铺满 40 列。
	it("pads output with vertical padding lines to width", () => {
		// 水平 0、垂直 2，与构造参数顺序一致。
		const text = new TruncatedText("Hello", 0, 2);
		// 渲染总宽 40。
		const lines = text.render(40);

		// Should have 2 padding lines + 1 content line + 2 padding lines = 5 total
		// 明确验证总行数 2+1+2=5。
		assert.strictEqual(lines.length, 5);

		// All lines should be exactly 40 characters
		// for...of 遍历正文和所有留白行，不只检查第一条。
		for (const line of lines) {
			// 每条显示宽都应为 40；不检查具体文字/空格字节排列。
			assert.strictEqual(visibleWidth(line), 40);
		}
	});

	// 超长正文例：截到一行、保留省略号、仍补满请求总宽。
	it("truncates long text and pads to width", () => {
		// 这段长 ASCII 文本明显超过可用正文预算。
		const longText = "This is a very long piece of text that will definitely exceed the available width";
		// 水平两侧各 1 列，30 总列只给正文 28。
		const text = new TruncatedText(longText, 1, 0);
		// 实际调用 render 进行截断与补齐。
		const lines = text.render(30);

		// 不因长文本额外折出第二行。
		assert.strictEqual(lines.length, 1);

		// Should be exactly 30 characters
		// 最终整行恰 30 列，包括左右边距与尾部补白。
		assert.strictEqual(visibleWidth(lines[0]), 30);

		// Should contain ellipsis
		// 正则 g 删除所有此样本的数字/分号 SGR 串，仅服务断言，不是通用 ANSI/OSC 清理函数。
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		// 去 SGR 后正文应含默认三个点，未钉死截后前缀全部文字。
		assert.ok(stripped.includes("..."));
	});

	// 样式短文例：控制码保留而列宽仍正确，避免把样式字节算进预算。
	it("preserves ANSI codes in output and pads correctly", () => {
		// 模板拼红色 Hello、空格、蓝色 world，只生成字符串，没有真实颜色显示。
		const styledText = `${chalk.red("Hello")} ${chalk.blue("world")}`;
		// 包装有样式的原文，左右各 1 列。
		const text = new TruncatedText(styledText, 1, 0);
		// 总宽 40，短文无须截断，但要补白。
		const lines = text.render(40);

		// 只出一条正文。
		assert.strictEqual(lines.length, 1);

		// Should be exactly 40 visible characters (ANSI codes don't count)
		// 样式码不计宽，最终仍恰 40 列。
		assert.strictEqual(visibleWidth(lines[0]), 40);

		// Should preserve the color codes
		// 至少保留 CSI 前缀；此断言并未逐项核对红/蓝具体色码。
		assert.ok(lines[0].includes("\x1b["));
	});

	// 样式长文例：省略号前应关闭正文样式，不让省略号继续红色。
	it("truncates styled text and adds reset code before ellipsis", () => {
		// Chalk 给整段长文加红色外壳。
		const longStyledText = chalk.red("This is a very long red text that will be truncated");
		// 留左右边距，正文预算较小，必然截断。
		const text = new TruncatedText(longStyledText, 1, 0);
		// 总宽 20。
		const lines = text.render(20);

		// 仍只一行。
		assert.strictEqual(lines.length, 1);

		// Should be exactly 20 visible characters
		// 加上边距/补白后显示宽恰 20。
		assert.strictEqual(visibleWidth(lines[0]), 20);

		// Should contain reset code before ellipsis
		// 检查重置码紧挨默认省略号，未要求它是整行末尾，因为后面可有重置/边距空格。
		assert.ok(lines[0].includes("\x1b[0m..."));
	});

	// 原标题说 fits exactly，但样本正文只有 11 列、预算 28，实际验证“可放下且补齐”，不是正文正好卡边界。
	it("handles text that fits exactly", () => {
		// With paddingX=1, available width is 30-2=28
		// "Hello world" is 11 chars, fits comfortably
		// 两侧各 1 留白，Hello world 不超可用 28。
		const text = new TruncatedText("Hello world", 1, 0);
		// 总宽 30 渲染。
		const lines = text.render(30);

		// 无垂直留白，所以一行。
		assert.strictEqual(lines.length, 1);
		// 补齐后总显示宽仍 30。
		assert.strictEqual(visibleWidth(lines[0]), 30);

		// Should NOT contain ellipsis
		// 去掉此样本 SGR，便于检查省略号；不去其他终端协议。
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		// !includes 确认无需截断时不加三点。
		assert.ok(!stripped.includes("..."));
	});

	// 空正文例：本组件仍返回一条全空白内容行，区别于 Text 的空白输入可返回 []。
	it("handles empty text", () => {
		// 空串、水平 1、垂直 0。
		const text = new TruncatedText("", 1, 0);
		// 按 30 列生成留白/补齐结果。
		const lines = text.render(30);

		// 不是零行，而是 1 行。
		assert.strictEqual(lines.length, 1);
		// 这一行恰 30 列空白；本断言只测宽，未逐字符比空格。
		assert.strictEqual(visibleWidth(lines[0]), 30);
	});

	// 多行输入例：只显示第一个 LF 之前的文字，不折出后续两条。
	it("stops at newline and only shows first line", () => {
		// 字符串内 \n 在运行时是真换行，不是反斜杠和字母 n 两字符。
		const multilineText = "First line\nSecond line\nThird line";
		// 组件保存全文，render 时才取首段。
		const text = new TruncatedText(multilineText, 1, 0);
		// 40 列足以显示 First line。
		const lines = text.render(40);

		// 只一条正文行。
		assert.strictEqual(lines.length, 1);
		// 该行补齐到 40 列。
		assert.strictEqual(visibleWidth(lines[0]), 40);

		// Should only contain "First line"
		// 删除本样本 SGR，再 trim 两侧边距/补白，产生仅用于断言的副本。
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "").trim();
		// 首行文案应存在。
		assert.ok(stripped.includes("First line"));
		// 第二行文案不能出现。
		assert.ok(!stripped.includes("Second line"));
		// 第三行文案也不能出现。
		assert.ok(!stripped.includes("Third line"));
	});

	// 首行超长且有后续行例：先取首行，再对其截断，不靠读第二行填满预算。
	it("truncates first line even with newlines in text", () => {
		// 构造较长首行加 LF 后 Second line。
		const longMultilineText = "This is a very long first line that needs truncation\nSecond line";
		// 设置左右各 1 列边距。
		const text = new TruncatedText(longMultilineText, 1, 0);
		// 总宽 25，正文可用 23。
		const lines = text.render(25);

		// 截断后仍仅一条内容行。
		assert.strictEqual(lines.length, 1);
		// 最终整行恰 25 列。
		assert.strictEqual(visibleWidth(lines[0]), 25);

		// Should contain ellipsis and not second line
		// 去 SGR 后检查内容，保留边距空格也不影响 includes。
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		// 必须出现默认省略号。
		assert.ok(stripped.includes("..."));
		// 不显示 Second line；不推成自动支持所有 CR/其他换行符，本组件只查 LF。
		assert.ok(!stripped.includes("Second line"));
	});
});
