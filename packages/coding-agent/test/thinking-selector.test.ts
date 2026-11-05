import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// 在内存中构造选择器并发送控制字符；不启真实 TUI，也不修改模型的实际思考级别。
describe("thinking selector", () => {
	// 本组测试开始时初始化共享主题，保证渲染所需颜色已就绪；无参数/返回。
	beforeAll(() => {
		initTheme("dark");
	});

	// 每例重置全局键位对象；新实例使用默认绑定，不读用户键位配置文件。
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// 构造 medium/high 两项，向下浏览后仍让勾标记 medium；箭头才表示当前浏览项。
	// 两个空回调只忽略选择/取消通知；本例不提交任何设置，失败由 expect 报告。
	it("keeps the current thinking level marked while browsing", () => {
		// 当前级别与可用级别分别传入；构造器给当前值加勾并预选它。
		const selector = new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
		);
		// 输入级别名，返回首条包含它的无颜色行或 undefined；此处两个候选没有包含关系。
		// 箭头函数省略花括号时，整个链式表达式就是返回值；它只渲染组件，不接终端。
		const getLevelRow = (level: string): string | undefined =>
			selector
				// 读取当前列表，用 80 列布局得到字符串数组。
				.getSelectList()
				.render(80)
				// map 对每一行删除 ANSI 序列，便于检查可见前缀。
				.map((line) => stripAnsi(line))
				// find 找到即停止；没找到时返回 undefined，不保证一定存在。
				.find((line) => line.includes(level));

		// ?. 让空选择得到 undefined；初始标签应包含勾。
		expect(selector.getSelectList().getSelectedItem()?.label).toBe("✓ medium");
		// 初始箭头和勾都在 medium 行。
		expect(getLevelRow("medium")?.startsWith("→ ✓ medium")).toBe(true);
		// ESC [ B 是向下方向键的输入序列，直接交给组件处理。
		selector.handleInput("\x1b[B");
		// medium 的勾保留，但不再带当前选择箭头。
		expect(getLevelRow("medium")?.startsWith("  ✓ medium")).toBe(true);
		// high 得到箭头而没有勾，说明“浏览”与“已应用”是两套状态。
		expect(getLevelRow("high")?.startsWith("→   high")).toBe(true);
	});

	// 把保存默认级别动作改成 Ctrl+R，验证帮助文案和输入处理共同使用新绑定。
	// 回调只记调用，不写设置文件；旧 Ctrl+S 不应触发它，Ctrl+R 应提交 medium。
	it("uses the configured save binding", () => {
		// 只覆盖此动作；KeybindingsManager 为其他动作保留默认值。
		setKeybindings(new KeybindingsManager({ "app.thinking.save": "ctrl+r" }));
		// vi.fn 创建可断言的函数替身。
		const saveDefault = vi.fn();
		// 第五参数提供设默认回调；前两个空回调仍忽略普通确认/取消。
		const selector = new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
			saveDefault,
		);

		// 将整个组件行数组按换行拼接后去颜色，只检查保存动作的提示片段。
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Ctrl+R to set as default");
		// \x13 表示 Ctrl+S；该动作已被重新配置，不应调用保存替身。
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		// \x12 表示 Ctrl+R；保存时传当前列表值 medium，而不是整个候选对象。
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith("medium");
	});
});
