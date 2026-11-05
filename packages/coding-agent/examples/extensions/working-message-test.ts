// 这是供人工观察的扩展示例，不是自动断言测试；检查工作提示在 loader 重建后是否仍使用自定义配置。

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
