// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：验证浮层合成（overlay compositing）与内嵌文本输入：菜单项里直接编辑文字，同时铺满整行的
//   宽字符、ANSI 样式和 emoji 用于检查边框对齐与裁剪。
// 上游：`pi --extension ./examples/extensions/overlay-test.ts` 加载；用户执行 /overlay-test 触发命令。
// 下游：ctx.ui.custom 以 overlay 显示 OverlayTestComponent；组件实现 Focusable 与渲染接口，
//   使用 CURSOR_MARKER 让宿主摆放硬件光标、renderFakeCursor 画出光标格。不写文件、不发网络。
// 能力：
//   默认导出函数         注册 /overlay-test。
//   OverlayTestComponent  固定 70 列浮层：方向键选择、行内光标编辑、Enter 返回结果。
// 运行：执行 /overlay-test，在 Search/Run 行输入文字，↑↓ 切换，Enter 确认，Esc 取消。
// 示例：在 Search 输入 "pi" 后 Enter，命令提示 `Search: "pi"`；Esc 时 result 为 undefined，不提示。
// 阅读顺序：先看命令 handler 的结果处理，再看 handleInput 的按键分支，最后看 render 的宽字符/光标处理。

/**
 * Overlay Test - validates overlay compositing with inline text inputs
 *
 * Usage: pi --extension ./examples/extensions/overlay-test.ts
 *
 * Run /overlay-test to show a floating overlay with:
 * - Inline text inputs within menu items
 * - Edge case tests (wide chars, styled text, emoji)
 */

// Theme 只作为类型使用；ExtensionAPI/ExtensionCommandContext 来自 coding-agent。
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
// CURSOR_MARKER 是零宽 APC 标记，宿主据此摆放硬件光标；Focusable 是“可聚焦组件”的结构约定；
// renderFakeCursor 给文本包上伪光标标记（渲染时反色）；visibleWidth 计算不占 ANSI 的显示列宽。
import { CURSOR_MARKER, type Focusable, matchesKey, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是注册 /overlay-test 命令。
// 示例：执行 /overlay-test 后浮层出现；关闭后 handler 才继续执行并可能提示。
export default function (pi: ExtensionAPI) {
	pi.registerCommand("overlay-test", {
		description: "Test overlay rendering with edge cases",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// custom 的泛型就是 done 参数与 Promise 结果类型；undefined 表示用户取消。
			// overlay: true 但没有 overlayOptions，使用宿主默认尺寸/位置，由组件自己控制 70 列宽度。
			const result = await ctx.ui.custom<{ action: string; query?: string } | undefined>(
				(_tui, theme, _keybindings, done) => new OverlayTestComponent(theme, done),
				{ overlay: true },
			);

			// 只有确认时才提示；query 仅在带输入的行（Search/Run）存在。
			if (result) {
				const msg = result.query ? `${result.action}: "${result.query}"` : result.action;
				ctx.ui.notify(msg, "info");
			}
		},
	});
}

// 固定宽度的浮层测试组件。实现 Focusable 表示 TUI 会设置 focused 字段并期望组件自行绘制光标。
// 状态：selected 是当前菜单项下标；items 每项保存标签、是否带输入、文本和光标位置。
// 示例：选中 Search 并输入 "ab" 后，text="ab"、cursor=2；按 ← 后 cursor=1。
class OverlayTestComponent implements Focusable {
	readonly width = 70;

	/** Focusable interface - set by TUI when focus changes */
	focused = false;

	private selected = 0;
	private items = [
		// cursor 以 UTF-16 码元为单位，与 String.slice 的下标一致；空文本时 cursor 为 0。
		{ label: "Search", hasInput: true, text: "", cursor: 0 },
		{ label: "Run", hasInput: true, text: "", cursor: 0 },
		{ label: "Settings", hasInput: false, text: "", cursor: 0 },
		{ label: "Cancel", hasInput: false, text: "", cursor: 0 },
	];

	private theme: Theme;
	private done: (result: { action: string; query?: string } | undefined) => void;

	// 保存主题和完成回调；菜单状态由字段初始值提供，构造无其他副作用。
	constructor(theme: Theme, done: (result: { action: string; query?: string } | undefined) => void) {
		this.theme = theme;
		this.done = done;
	}

	// 处理一次按键。输入：原始按键序列；副作用：移动选中行、编辑当前行的文本/光标，或调用 done 结束。
	// 顺序：Esc 取消 -> Enter 确认 -> ↑↓ 换行 -> 仅对 hasInput 行处理编辑键。
	// 注意编辑分支只在当前行 hasInput 时进入，因此 Settings/Cancel 上的字符键被忽略。
	// 示例：选中 Run 输入 "ls" 后 Enter，done({ action: "Run", query: "ls" })。
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}

		// 非空断言：selected 由 Math.max/min 夹在 0..items.length-1。
		const current = this.items[this.selected]!;

		if (matchesKey(data, "return")) {
			// 无输入行把 query 设为 undefined，而不是空字符串，便于 handler 判断是否显示引号。
			this.done({ action: current.label, query: current.hasInput ? current.text : undefined });
			return;
		}

		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(this.items.length - 1, this.selected + 1);
		} else if (current.hasInput) {
			if (matchesKey(data, "backspace")) {
				// 光标在开头时没有可删字符；否则同时删除光标前一个码元并左移光标。
				if (current.cursor > 0) {
					current.text = current.text.slice(0, current.cursor - 1) + current.text.slice(current.cursor);
					current.cursor--;
				}
			} else if (matchesKey(data, "left")) {
				current.cursor = Math.max(0, current.cursor - 1);
			} else if (matchesKey(data, "right")) {
				// 光标最多停在文本末尾（允许等于 length），便于在尾部插入。
				current.cursor = Math.min(current.text.length, current.cursor + 1);
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				// 在当前光标处插入字符：前半段 + 新字符 + 后半段，然后光标右移一格。
				current.text = current.text.slice(0, current.cursor) + data + current.text.slice(current.cursor);
				current.cursor++;
			}
		}
	}

	// 渲染整个固定 70 列浮层。输入：_width 被忽略（组件自定宽 70）；输出：字符串行数组；无副作用。
	// 关键点：宽字符/emoji 用 visibleWidth 计算列宽后再补空格，保证左右边框对齐；
	// 选中行的光标位置同时发出 CURSOR_MARKER（真实光标）和 renderFakeCursor（反色格）。
	render(_width: number): string[] {
		const w = this.width;
		const th = this.theme;
		// 左右边框各一列，内部内容宽度为 68。
		const innerW = w - 2;
		const lines: string[] = [];

		// 按可见列补空格；ANSI 样式和宽字符不会被误当成多列，补齐不会超出内宽。
		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};

		// 每行统一加左右边框；content 必须不超过 innerW，否则边框会被推到下一行。
		const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", "🧪 Overlay Test")}`));
		lines.push(row(""));

		// Edge cases - full width lines to test compositing at boundaries
		// 以下整行包含中文/韩文/日文、多段 ANSI 样式和组合 emoji，用来压测浮层合成与宽度计算。
		lines.push(row(` ${th.fg("dim", "─── Edge Cases (borders should align) ───")}`));
		lines.push(row(` Wide: ${th.fg("warning", "中文日本語한글テスト漢字繁體简体ひらがなカタカナ가나다라마바")}`));
		lines.push(
			row(
				` Styled: ${th.fg("error", "RED")} ${th.fg("success", "GREEN")} ${th.fg("warning", "YELLOW")} ${th.fg("accent", "ACCENT")} ${th.fg("dim", "DIM")} ${th.fg("error", "more")} ${th.fg("success", "colors")}`,
			),
		);
		lines.push(row(" Emoji: 👨‍👩‍👧‍👦 🇯🇵 🚀 💻 🎉 🔥 😀 🎯 🌟 💡 🎨 🔧 📦 🏆 🌈 🎪 🎭 🎬 🎮 🎲"));
		lines.push(row(""));

		// Menu with inline inputs
		// 菜单区：带输入的行显示 "标签: 文本"，无输入的行只显示标签。
		lines.push(row(` ${th.fg("dim", "─── Actions ───")}`));

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const isSelected = i === this.selected;
			// 选中前缀固定占 3 列（▶ 两侧各一空格），未选中行同样占位以保持对齐。
			const prefix = isSelected ? " ▶ " : "   ";

			let content: string;
			if (item.hasInput) {
				// 选中时标签用 accent，否则用 text 主题色；“:”始终跟在标签后。
				const label = isSelected ? th.fg("accent", `${item.label}:`) : th.fg("text", `${item.label}:`);

				let inputDisplay = item.text;
				if (isSelected) {
					// before/after 夹住光标位置；光标在末尾时 cursorChar 用空格占一个可反色单元。
					const before = inputDisplay.slice(0, item.cursor);
					const cursorChar = item.cursor < inputDisplay.length ? inputDisplay[item.cursor] : " ";
					const after = inputDisplay.slice(item.cursor + 1);
					// Emit hardware cursor marker for IME support when focused
					// marker 只在组件 focused 时发出，避免浮层未聚焦时抢走硬件光标。
					const marker = this.focused ? CURSOR_MARKER : "";
					// 标记(零宽) + 伪光标文本 + 后半段；渲染器会把伪光标变成反色。
					inputDisplay = `${before}${marker}${renderFakeCursor(cursorChar)}${after}`;
				}
				content = `${prefix + label} ${inputDisplay}`;
			} else {
				content = prefix + (isSelected ? th.fg("accent", item.label) : th.fg("text", item.label));
			}

			lines.push(row(content));
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "↑↓ navigate • type to input • Enter select • Esc cancel")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	// 组件没有缓存，Invalidate 无需处理；dispose 也没有资源要释放。
	invalidate(): void {}
	dispose(): void {}
}
