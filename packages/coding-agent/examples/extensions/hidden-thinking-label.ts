// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi --extension examples/extensions/hidden-thinking-label.ts` 加载。
// 演示内容：用 ctx.ui.setHiddenThinkingLabel 自定义“思考块被隐藏”时显示的标题；支持 /thinking-label 设置和空参数恢复。
// 上下游：session_start 应用内存 label；命令修改 label 并立即调用 UI；setHiddenThinkingLabel 只影响折叠占位显示，不改 thinking 内容/档位。无模型请求、无文件 I/O。
// 能力清单：DEFAULT_LABEL、applyLabel、session_start、/thinking-label 的设置/恢复分支。
// 典型运行顺序：加载 -> session_start 应用 Pondering... -> Ctrl+T 隐藏思考 -> 请求产生 reasoning -> 折叠标题显示；/thinking-label Calculating -> 立即更新；/thinking-label -> 恢复宿主默认并改写内存值。
// 示例（真实签名）：
//   /thinking-label Calculating
//   /thinking-label
// 阅读顺序：先看 DEFAULT_LABEL 与 applyLabel，再看 session_start，最后看命令的两个分支。
// 前置与副作用：仅交互式 UI 能看到效果；RPC 模式 setHiddenThinkingLabel 是空实现。DEFAULT_LABEL 是扩展自己的文字，不保证等于宿主默认标题；空参数调用 setHiddenThinkingLabel() 恢复宿主默认，但闭包 label 同时被设为 DEFAULT_LABEL，下一次 session_start 又会应用它，所以恢复只在当前会话内有效。通知文案说 reset to Pondering...，实际当前显示可能是宿主默认。label 只在扩展实例内保存，重载后回到 DEFAULT_LABEL。setHiddenThinkingLabel 不会修改模型思考内容或思考档位；空字符串在 API 中合法，但命令会把空白参数当恢复，无法设置空标题。
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

// import type 只引入类型；ExtensionAPI 标注入口，ExtensionContext 标注 applyLabel。
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
