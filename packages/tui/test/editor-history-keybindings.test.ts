// 验证可配置的专用历史快捷键：不用先把光标移到首/末显示行就能浏览历史，并恢复原草稿与光标；只创建内存编辑器和虚拟终端。
// 默认导入 Node 断言，失败会抛出 AssertionError，使当前测试失败。
import assert from "node:assert";
// afterEach 注册每个用例结束后的清理；describe/it 分别组织测试组和用例，注册并不等于立即执行用例体。
import { afterEach, describe, it } from "node:test";
// 导入真实 Editor 实现，测试从公开 handleInput 进入，而非直接调用私有历史方法。
import { Editor } from "../src/components/editor.ts";
// 导入全局键位管理器、替换函数和默认定义，测试结束再恢复一份默认管理器。
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
// 主屏 TUI 为 Editor 提供宿主接口，本用例没有调用 start，不会启动终端渲染循环。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 导入测试主题，主题函数只生成 ANSI 字符串，不向真实终端输出。
import { defaultEditorTheme } from "./test-themes.ts";
// VirtualTerminal 用内存 xterm 承担终端契约，不接管系统 stdin/stdout。
import { VirtualTerminal } from "./virtual-terminal.ts";

// 每个用例后把进程内的全局键位恢复默认；无输入/返回值，不恢复进入测试前可能存在的自定义管理器。
afterEach(() => {
	// new 创建独立管理器；setKeybindings 替换模块保存的引用，避免本例 Ctrl+P/N 覆盖影响后续用例。
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

// 把“提示历史的专用快捷键”放在同一测试组；实际行为由下方同步回调中的断言检查。
describe("Editor prompt history keybindings", () => {
	// 准备两条历史和一份光标不在开头的草稿，再按上一/下一历史；预期旧项从起点加载、新项到末尾，退出历史还原草稿，断言失败直接抛出。
	it("browses history directly without first moving the cursor", () => {
		// 先安装本例的快捷键配置，构造管理器不会发送按键。
		setKeybindings(
			// 第二个构造参数是覆盖表，保留其他默认动作。
			new KeybindingsManager(TUI_KEYBINDINGS, {
				// 把“上一历史”动作配置为 Ctrl+P，动作名是可配置键，不在 Editor 中硬编码该组合。
				"tui.editor.historyPrevious": "ctrl+p",
				// 把“下一历史”动作配置为 Ctrl+N。
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		// 由内向外构造虚拟终端、主屏宿主和编辑器；这里只建对象，未连接真实终端。
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		// 先加入较旧项；addToHistory 会 trim、跳过空文/连续重复并插到数组开头。
		editor.addToHistory("older prompt");
		// 后加入多行新项，所以第一次向旧历史走会选中它；字符串里的转义换行不是两字符反斜杠+n。
		editor.addToHistory("newer\nmultiline prompt");
		// 设置草稿会把光标放在末尾，即行0码元列5。
		editor.setText("draft");
		// 直接喂一次左箭头控制串，光标从5到4；不是操作系统键盘事件。
		editor.handleInput("\x1b[D");
		// 再向左到列3，之后要证明恢复的是这个草稿位置，而非默认末尾。
		editor.handleInput("\x1b[D");

		// Ctrl+P 的原始控制字符触发 historyPrevious，专用动作不先做上下光标移动。
		editor.handleInput("\x10"); // Ctrl+P
		// 检查载入最新的多行历史，strictEqual 对字符串逐值严格比较。
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		// getCursor 返回逻辑行号和 UTF-16 码元下标；向旧项导航把位置设为全文起点。
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		// 再按上一历史，继续选择更旧的一项。
		editor.handleInput("\x10"); // Ctrl+P
		// 检查历史索引确实前进，没有只移动当前多行文本的光标。
		assert.strictEqual(editor.getText(), "older prompt");

		// Ctrl+N 触发 historyNext，向较新的历史走。
		editor.handleInput("\x0e"); // Ctrl+N
		// 检查从旧项返回多行新项。
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		// 向新项加载时光标在末行末尾；“multiline prompt”长16个码元，此处不是显示列宽测试。
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		// 再向新走超出最新历史，退回进入历史前保存的草稿。
		editor.handleInput("\x0e"); // Ctrl+N
		// 检查草稿正文恢复。
		assert.strictEqual(editor.getText(), "draft");
		// 检查草稿光标也恢复到此前两次左移后的列3，而不是重新定位到列5。
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
	});
});
