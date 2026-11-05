import { afterEach, describe, expect, it } from "vitest";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

// 每例结束把全局主题切回 dark；无输入/返回，不恢复任意先前主题，也不启动监听器。
afterEach(() => {
	// initTheme 默认不启用文件 watcher，只更新当前全局主题。
	initTheme("dark");
});

// 注册 ThemedText 的缓存测试；describe 回调负责登记测试，真正断言在 it 中执行。
describe("ThemedText", () => {
	// 无参数测试：构造、渲染、切主题、失效再渲染；例如 hello 只有失效后才换成 light 的 accent。
	// 这里只生成内存中的 ANSI 字符串；失败由 expect 抛出，不接真实终端。
	it("builds lazily and rebuilds with the current theme after invalidation", () => {
		// 固定初始颜色，避免测试顺序决定结果。
		initTheme("dark");
		// let 允许回调逐次增加计数，用它观察真实 build 调用次数。
		let builds = 0;
		// 传入延迟构建闭包；闭包执行时才读取当前 theme，而非此刻预先着色。
		const text = new ThemedText(() => {
			// 每执行一次闭包就加一。
			builds++;
			// 返回带当前 accent ANSI 颜色的 hello，作为 Text 正文。
			return theme.fg("accent", "hello");
		});
		// 构造对象还没 render，故构建次数应为零。
		expect(builds).toBe(0);
		// render 返回行数组；join 拼成字符串，保存 dark 时的完整结果。
		const dark = text.render(20).join("");

		// 只换全局主题，不会自动让已有 ThemedText 缓存失效。
		initTheme("light");
		// 同宽再次渲染仍使用旧正文。
		expect(text.render(20).join("")).toBe(dark);
		// 主动清父类布局缓存，并标记下次 render 重建正文。
		text.invalidate();
		// 重建后的输出应含当前 light accent 的 ANSI 前景序列。
		expect(text.render(20).join("")).toContain(theme.getFgAnsi("accent"));
		// 初次 render 与失效后 render 各调用 build 一次；中间缓存命中不调用。
		expect(builds).toBe(2);
	});
});
