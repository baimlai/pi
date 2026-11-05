// #10169 回归：按显示列截取时，区间前样式必须排在边界重置之前，避免后缀意外染色；仅比较字符串，不启动终端。
// strictEqual 比完整 JS 字符串的码元序列；每个 it 无参数、正常返回 void，失败同步抛错。
import assert from "node:assert";
// 注册场景而不是立即执行两次截取。
import { describe, it } from "node:test";
// 导入真实显示列切片器，true 只要求右边界不切半个宽字，不是删除 ANSI。
import { sliceByColumn } from "../src/utils.ts";

// https://github.com/earendil-works/pi/issues/10169
// 测试组保留原 issue 链接，下面两例给出具体的前置样式/边界关闭顺序。
describe("sliceByColumn ANSI order regression", () => {
	// 绿色 foo 后恢复默认色例：截起点恰在关闭颜色处，旧绿色应先输出、默认色重置随后输出。
	it("keeps a reset at the slice start after earlier style codes", () => {
		// CSI32m 开绿色，foo 三列，CSI39m 恢复默认前景，再跟空格 bar。
		const line = "\x1b[32mfoo\x1b[39m bar";
		// 从列 3 严格取 4 列，应是原先绿色前缀、边界默认色码、空格 bar；并非只取可见四字符而丢控制码。
		assert.strictEqual(sliceByColumn(line, 3, 4, true), "\x1b[32m\x1b[39m bar");
	});

	// 两段高亮例：切掉 alpha 之后，普通后缀应先恢复默认色，后面的 beta 仍保留自身高亮。
	it("does not leak color into text after a highlighted token", () => {
		// Another 加空格占 8 列，alpha 5 列，到列 13 正好结束，后面紧跟 CSI39m。
		const line = "Another \x1b[35malpha\x1b[39m line with \x1b[35mbeta\x1b[39m later.";
		// 从列 13 请求最多 100 列，长度超剩余文本时保留到实际行尾，不补空格。
		const after = sliceByColumn(line, 13, 100, true);
		// 保留先前紫色码再边界默认色码，然后普通后缀/beta 的独立紫色与恢复码，严格验证顺序以免普通文字继承紫色。
		assert.strictEqual(after, "\x1b[35m\x1b[39m line with \x1b[35mbeta\x1b[39m later.");
	});
});
