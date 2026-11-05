// 测项目的显示列估算规则，不测真实字体像素或所有终端；每个 it 回调无参数、正常返回 void，断言失败同步抛错交 node:test。
// assert.strictEqual 要求结果数值严格相等，不能用字符串形式的数字替代。
import assert from "node:assert";
// describe 注册组，it 注册各输入场景，回调在测试运行时才执行。
import { describe, it } from "node:test";
// 导入真实宽度函数；可能更新它内部缓存，但不改变传入字符串、不写终端。
import { visibleWidth } from "../src/utils.ts";

// 分组覆盖已完成控制码、固定 tab 宽度、非 ASCII 与不完整转义。
describe("visibleWidth", () => {
	// 控制码例：不同 CSI/OSC/APC 外壳都应剥去，普通标签文字仍计列；不据此保证所有终端序列都能识别。
	it("measures styled ASCII without counting escape sequences", () => {
		// 256 色前景码与恢复默认色不占列，hello、空格、world 合计 11。
		assert.strictEqual(visibleWidth("\x1b[38;5;4mhello\x1b[39m world"), 11);
		// OSC8 链接地址只是控制码载荷，标签 link 为 4；不会访问 URL。
		assert.strictEqual(visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"), 4);
		// OSC133 提示起点以 ST 结束，正文 prompt 为 6。
		assert.strictEqual(visibleWidth("\x1b]133;A\x1b\\prompt"), 6);
		// 项目 APC 光标标记零宽，后面的 cursor 仍为 6。
		assert.strictEqual(visibleWidth("\x1b_pi:c\x07cursor"), 6);
	});

	// tab 例：项目固定算 3 列，区别于真实终端按当前位置跳制表位。
	it("counts tabs as three columns in styled text", () => {
		// a=1、tab=3、b=1，粗体/关闭粗体不占列，共 5。
		assert.strictEqual(visibleWidth("\x1b[1ma\tb\x1b[22m"), 5);
	});

	// 非 ASCII 例：宽汉字/日文与单列符号分别计宽，颜色码仍忽略。
	it("measures styled non-ASCII text", () => {
		// 两个日文汉字 4 列、空格 1、ok 2，共 7。
		assert.strictEqual(visibleWidth("\x1b[31m日本\x1b[39m ok"), 7);
		// 线条与箭头在项目默认宽度规则里各 1，共 2，不保证所有字体或 ambiguous-wide 配置相同。
		assert.strictEqual(visibleWidth("\x1b[31m─→\x1b[39m"), 2);
	});

	// 不完整转义例：名字不能理解为整段都零宽；只忽略孤立 ESC，后面未被识别为完整控制码的文字继续计宽。
	it("treats unterminated escape sequences as zero-width control characters", () => {
		// ESC[31 缺少 CSI 结束字母，因此 [31 三个普通码元仍算 3 列。
		assert.strictEqual(visibleWidth("\x1b[31"), 3);
		// 普通 a 计 1，串末孤立 ESC 本身零宽。
		assert.strictEqual(visibleWidth("a\x1b"), 1);
	});
});
