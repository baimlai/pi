// 这是供人工观察的扩展示例，不是自动断言测试；检查工作提示在 loader 重建后是否仍使用自定义配置。

/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是工作提示的持久性。
 * 上游：宿主通过 `pi --extension examples/extensions/working-message-test.ts` 加载；
 * session_start 时设置文字和指示器。下游：ctx.ui.setWorkingMessage() 与
 * ctx.ui.setWorkingIndicator() 只改 UI 配置，不启动 Agent、不写文件、不发网络请求。
 *
 * 演示的机制：loader 可能在轮次之间重建，本示例用于人工确认重建后自定义工作文字没有
 * 退回默认的灰色 "Working..."。文件里没有断言，是否通过要靠观察。
 *
 * 能力清单：
 * - CUSTOM_MESSAGE：带 ANSI 棕色的 "Working... (custom)" 字符串。
 * - CUSTOM_INDICATOR：单帧棕色圆点的 WorkingIndicatorOptions。
 * - 默认导出：会话启动时应用两项配置。
 *
 * 典型运行顺序：加载扩展 -> 连续发送几条消息 -> 每次出现工作行时观察是否为棕色
 * "Working... (custom)" 和棕色圆点；若变回默认样式，说明配置未跨重建保留。
 *
 * 示例（真实签名）：
 *   ctx.ui.setWorkingMessage("\x1b[38;2;155;86;63mWorking... (custom)\x1b[39m");
 *   ctx.ui.setWorkingIndicator({ frames: ["\x1b[38;2;155;86;63m●\x1b[39m"] });
 *   无参数调用 setWorkingMessage() 则会恢复默认。
 *
 * 建议阅读顺序：先看两个常量中的转义序列含义，再看 session_start 中两个设置调用。
 *
 * 前置条件：交互式 TUI 会话；需要手动观察，不能作为自动化回归测试。
 */

/**
 * Working Message Persistence Test
 *
 * Sets a custom working message and indicator on session start so you can
 * verify they survive across loader recreations (e.g. between agent turns).
 *
 * Usage:
 *   pi --extension examples/extensions/working-message-test.ts
 *
 * Then send a few messages in interactive mode. The working message should
 * stay "Working... (custom)" with a brown dot indicator every time the
 * loader appears, not revert to the default gray "Working...".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ANSI 真彩色前景设置为棕色，末尾 39m 恢复默认前景，不改变文字本身。
const CUSTOM_MESSAGE = "\x1b[38;2;155;86;63mWorking... (custom)\x1b[39m";
// 只有一帧的数组构成静态圆点；不需要本示例自己启动动画计时器。
const CUSTOM_INDICATOR = { frames: ["\x1b[38;2;155;86;63m●\x1b[39m"] };

// 接收 API 并注册启动钩子，无返回值。例：用户随后发送几轮消息，人工观察每次工作行；此文件没有证明持久化的断言。
export default function (pi: ExtensionAPI) {
	// 会话启动时应用配置；async 将同步操作包装为 Promise。
	pi.on("session_start", async (_event, ctx) => {
		// 将以后 loader 使用的工作文字设置为带 ANSI 样式的字符串。
		ctx.ui.setWorkingMessage(CUSTOM_MESSAGE);
		// 将工作指示器设置为单帧圆点，实际显示和生命周期由宿主负责。
		ctx.ui.setWorkingIndicator(CUSTOM_INDICATOR);
	});
}
