// 验证 Text 同文更新保留渲染缓存数组：内容相同之外，还要数组身份相同。只在内存渲染，不启动 TUI 或真实终端。
// assert.strictEqual 对数组检查同一个引用，区别于 deepStrictEqual 只比内容。
import assert from "node:assert";
// describe/it 注册分组与测试，无需手动调用场景回调。
import { describe, it } from "node:test";
// 导入实际 Text 组件，折行工具及显示宽度计算都走真实实现。
import { Text } from "../src/components/text.ts";

// 注册 Text 缓存组，回调只定义测试。
describe("Text", () => {
	// 用例无参数/正常返回 void：先 render 保存数组，再 set 同文，再 render 比身份；例外部 renderer 反复设置同文不该重新折行，断言失败会抛错。
	it("keeps its wrapped lines when the same text is set again", () => {
		// 构造正文 hello world，水平/垂直留白都为 0，避免留白影响 5 列折行预算。
		const text = new Text("hello world", 0, 0);
		// render(5) 真正折行并缓存结果，lines 保存数组引用，不是复制快照。
		const lines = text.render(5);
		// 相同字符串在 setText 内提前返回，未清旧缓存；不请求宿主重绘。
		text.setText("hello world");
		// 相同 width 再 render 应拿回同一数组对象；不单独断言折行具体内容或计算耗时。
		assert.strictEqual(text.render(5), lines);
	});
});
