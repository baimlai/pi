/**
 * Hidden Thinking Label Extension
 *
 * Demonstrates `ctx.ui.setHiddenThinkingLabel()` for customizing the label shown
 * when thinking blocks are hidden.
 *
 * Usage:
 *   pi --extension examples/extensions/hidden-thinking-label.ts
 *
 * Test:
 *   1. Load this extension
 *   2. Hide thinking blocks with Ctrl+T
 *   3. Ask for something that produces reasoning output
 *   4. The collapsed thinking block label will show the custom text
 *
 * Commands:
 *   /thinking-label <text>   Set a custom hidden thinking label
 *   /thinking-label          Reset to the default label
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 扩展自己的初始文字；不保证等于宿主内置折叠标题。
const DEFAULT_LABEL = "Pondering...";

// 加载时保存标题状态并注册会话/命令回调；不改变模型思考内容，无返回值。
// 例如 /thinking-label Calculating 将当前 UI 标题设为该文字；空参数恢复宿主默认标题。
export default function (pi: ExtensionAPI) {
	// 闭包中的可变状态跨命令回调保留，初值为扩展常量。
	let label = DEFAULT_LABEL;

	// 辅助函数接收上下文，把当前 label 应用到 UI；同步返回 void，无模型请求。
	const applyLabel = (ctx: ExtensionContext) => {
		// 只更新折叠显示的标签，不切换思考块显示状态。
		ctx.ui.setHiddenThinkingLabel(label);
	};

	// 会话开始时应用内存中的标题；async 回调没有需要 await 的工作。
	pi.on("session_start", async (_event, ctx) => {
		// 调用共同入口，使用这一会话的 UI 上下文。
		applyLabel(ctx);
	});

	// 登记可由用户输入的标题命令。
	pi.registerCommand("thinking-label", {
		description: "Set the hidden thinking label. Use without args to reset.",
		// 命令回调只修改扩展状态与当前 UI。
		handler: async (args, ctx) => {
			// trim 后判断是否有用户文字。
			const nextLabel = args.trim();

			// 空参数走恢复分支。
			if (!nextLabel) {
				// 内存 label 恢复扩展常量；以后 session_start 仍会应用这个值。
				label = DEFAULT_LABEL;
				// 不带参数表示恢复宿主默认值，和显式传 DEFAULT_LABEL 并非必然相同。
				ctx.ui.setHiddenThinkingLabel();
				// 提示扩展常量文字；实际默认外观仍由宿主决定。
				ctx.ui.notify(`Hidden thinking label reset to: ${DEFAULT_LABEL}`);
				// 恢复完成，不进入设置分支。
				return;
			}

			// 保存去除首尾空白后的新标题。
			label = nextLabel;
			// 立即应用到当前 UI。
			ctx.ui.setHiddenThinkingLabel(label);
			// 通知已设置的新值。
			ctx.ui.notify(`Hidden thinking label set to: ${label}`);
		},
	});
}
