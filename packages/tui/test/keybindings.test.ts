// 测试默认按键映射、实际序列匹配与用户覆盖冲突；不启动终端、不读键盘。每个 it 无参数/正常返回 void，断言失败抛错由测试框架记录。
// deepStrictEqual 检结构/顺序，strictEqual 检严格值；测试里的键字面量是受测样本，不是生产代码硬编码快捷键处理。
import assert from "node:assert";
// 注册测试组与场景回调。
import { describe, it } from "node:test";
// 导入真实管理器与运行时默认表；构造局部 manager 不会调用全局 setKeybindings。
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";

// 分组运行独立配置实例，避免用例间用户覆盖相互污染。
describe("KeybindingsManager", () => {
	// 换行别名例：同时检默认表与两种 Ctrl+J 序列，匹配不执行真正换行。
	it("binds Ctrl+J as a default newline alias", () => {
		// 构造后立刻按默认表 rebuild，未传覆盖就是全部默认。
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		// 要求换行动作的别名数组内容/顺序恰为 Shift+Enter、Ctrl+J。
		assert.deepStrictEqual(keybindings.getKeys("tui.input.newLine"), ["shift+enter", "ctrl+j"]);
		// LF 字节即传统 Ctrl+J，检查可匹配此动作。
		assert.strictEqual(keybindings.matches("\n", "tui.input.newLine"), true);
		// Kitty CSI106;5u：106 是 j 的码点，修饰编码 5 表示 Ctrl，未带事件子字段时按 press；解析可能更新 keys 模块的最近事件状态。
		assert.strictEqual(keybindings.matches("\x1b[106;5u", "tui.input.newLine"), true);
	});

	// 编辑导航例：读有效绑定，不实际移动编辑光标或视口。
	it("binds modified and unmodified editor viewport navigation", () => {
		// 新建只用默认值的管理器。
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		// 行首允许 Home 或 Ctrl+A。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLineStart"), ["home", "ctrl+a"]);
		// 行尾允许 End 或 Ctrl+E。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLineEnd"), ["end", "ctrl+e"]);
		// 编辑上页同时允许裸 PageUp 与 Ctrl+PageUp。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.pageUp"), ["pageUp", "ctrl+pageUp"]);
		// 编辑下页同理；动作共享键时由外层模式/焦点路由决定，不在这里决定谁先消费。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.pageDown"), ["pageDown", "ctrl+pageDown"]);
	});

	// 专用历史例：动作存在但默认无绑定，不推出“没有历史功能”。
	it("leaves dedicated prompt history navigation unbound by default", () => {
		// 默认 manager 未对这两个动作加用户按键。
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		// 上条历史的有效键数组应为空。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.historyPrevious"), []);
		// 下条历史也为空。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.historyNext"), []);
	});

	// 全屏导航例：逐项核对默认表；只查绑定，不测试实际滚动、搜索或输入优先级。
	it("binds unmodified terminal viewport shortcuts to alternate-screen navigation", () => {
		// 构造独立默认实例。
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		// 全屏上页绑定裸 PageUp。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.pageUp"), ["pageUp"]);
		// 全屏下页绑定裸 PageDown。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.pageDown"), ["pageDown"]);
		// 上半页默认不绑定。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.halfPageUp"), []);
		// 下半页默认不绑定。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.halfPageDown"), []);
		// 上一行默认不绑定。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.lineUp"), []);
		// 下一行默认不绑定。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.lineDown"), []);
		// 前一语义提示位置有 Ctrl+Shift+Up 和 Ctrl+Up 别名。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.previousPrompt"), ["ctrl+shift+up", "ctrl+up"]);
		// 后一语义提示位置对应 Down 的两个别名。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.nextPrompt"), ["ctrl+shift+down", "ctrl+down"]);
		// 搜索切换默认 Ctrl+Shift+F。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.search"), ["ctrl+shift+f"]);
		// 搜索下一项默认 Enter 或 Ctrl+G。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.searchNext"), ["enter", "ctrl+g"]);
		// 上一项默认 Shift+Enter 或 Ctrl+Shift+G。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.searchPrevious"), ["shift+enter", "ctrl+shift+g"]);
		// 搜索关闭为 Escape。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.searchClose"), ["escape"]);
		// 主内容顶部默认 Ctrl+Home。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.top"), ["ctrl+home"]);
		// 主内容末尾默认 Ctrl+End。
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.bottom"), ["ctrl+end"]);
	});

	// 覆盖提交动作例：两个动作共享 Enter 也不能自动删掉选择确认默认键。
	it("does not evict selector confirm when input submit is rebound", () => {
		// 第二实参是用户覆盖对象，只覆盖列出的动作，构造立即重建有效表。
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			// 提交显式列两个别名；数组不是依次按的组合序列，任一个即可匹配。
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		// 检查提交采用用户给的整组键。
		assert.deepStrictEqual(keybindings.getKeys("tui.input.submit"), ["enter", "ctrl+enter"]);
		// 选择确认仍保留默认 Enter，管理器不做跨动作驱逐。
		assert.deepStrictEqual(keybindings.getKeys("tui.select.confirm"), ["enter"]);
	});

	// 共用 Up 例：用户给列表动作配置 Up/Ctrl+P，编辑动作的默认 Up 应仍在。
	it("does not evict cursor bindings when another action reuses the same key", () => {
		// 构造局部覆盖，其他动作继续默认。
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			// 选择上移有两个显式用户别名。
			"tui.select.up": ["up", "ctrl+p"],
		});

		// 检查该用户覆盖被采用。
		assert.deepStrictEqual(keybindings.getKeys("tui.select.up"), ["up", "ctrl+p"]);
		// 编辑上移默认 Up 不被移除；冲突报告规则与默认重叠不是一回事。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up"]);
	});

	// 显式冲突例：submit/confirm 都由用户指定 Ctrl+X，应报告冲突，同时未涉及的编辑默认仍保留；不证明自动修复或拒绝配置。
	it("still reports direct user binding conflicts without evicting defaults", () => {
		// 两个用户声明都交同一个 manager，在 rebuild 时收集同键 claim。
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			// 提交显式使用 Ctrl+X，单字符串会被规范为一项数组。
			"tui.input.submit": "ctrl+x",
			// 选择确认也显式使用同键。
			"tui.select.confirm": "ctrl+x",
		});

		// 结构检查冲突数组恰含这一条，字段和值在下面列出。
		assert.deepStrictEqual(keybindings.getConflicts(), [
			// 每个冲突对象记录一个键及声明它的动作列表。
			{
				// 冲突键是原 KeyId 字符串 Ctrl+X。
				key: "ctrl+x",
				// 动作列表按配置枚举/Set 插入顺序保存两项，不包含仅共享默认的动作。
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		// 不相关的编辑左移仍有 Left/Ctrl+B；本断言并未单独读取两个冲突动作的最终键，但源码仍保留它们。
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left", "ctrl+b"]);
	});
});
