// 显示当前有效系统提示的 JavaScript 字符串长度，并在关闭时清除该页脚状态。

/**
 * Displays a status widget showing the system prompt length.
 *
 * Demonstrates ctx.getSystemPrompt() for accessing the effective system prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 接收 API 后登记启动/关闭监听，无返回值。例：提示长度 120 时显示 System: 120 chars；这里不统计 token 或修改提示内容。
export default function (pi: ExtensionAPI) {
	// 每次 Agent 运行开始重新取提示，因此可反映本轮扩展修改后的有效内容。
	pi.on("agent_start", (_event, ctx) => {
		// 从宿主读取有效提示字符串，不发模型请求。
		const prompt = ctx.getSystemPrompt();
		// .length 统计 UTF-16 代码单元，不能严格当作用户看到的字符个数。
		ctx.ui.setStatus("system-prompt", `System: ${prompt.length} chars`);
	});

	// 会话关闭事件中清除本扩展留下的状态。
	pi.on("session_shutdown", (_event, ctx) => {
		// undefined 表示删除该 key 的状态片段。
		ctx.ui.setStatus("system-prompt", undefined);
	});
}
