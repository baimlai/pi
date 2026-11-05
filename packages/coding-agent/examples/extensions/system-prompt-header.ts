// 显示当前有效系统提示的 JavaScript 字符串长度，并在关闭时清除该页脚状态。

/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是读取有效系统提示。
 * 上游：agent_start 事件在每轮 Agent 运行开始时触发；session_shutdown 在会话关闭时触发。
 * 下游：ctx.getSystemPrompt() 从宿主读取渲染后的提示字符串，ctx.ui.setStatus() 写入页脚。
 * 本示例不修改提示、不调用模型、不写文件。
 *
 * 能力清单：
 * - agent_start 监听：把 `System: N chars` 写到 key 为 system-prompt 的页脚状态。
 * - session_shutdown 监听：用 undefined 清除该状态，避免残留旧文字。
 *
 * 典型运行顺序：加载扩展 -> 第一次 Agent 运行 -> 页脚出现提示长度；每轮开始重新计算；
 * 会话关闭时状态被清除。
 *
 * 示例（真实签名）：
 *   const prompt = ctx.getSystemPrompt();  // string，已包含扩展/工具/项目上下文等有效内容
 *   ctx.ui.setStatus("system-prompt", `System: ${prompt.length} chars`);
 *   注意 length 统计 UTF-16 代码单元，不是 token 数，也不是严格的可见字符数。
 *
 * 建议阅读顺序：先看 agent_start 中 getSystemPrompt 的调用，再看关闭事件里的清理。
 *
 * 前置条件：有 UI 的会话才能看到页脚；无 UI 时调用仍安全但不显示。
 */

/**
 * Displays a status widget showing the system prompt length.
 *
 * Demonstrates ctx.getSystemPrompt() for accessing the effective system prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 接收 API 后登记启动/关闭监听，无返回值。例：提示长度 120 时显示 System: 120 chars；这里不统计 token 或修改提示内容。
export default function (pi: ExtensionAPI) {
	// 每次 Agent 运行开始重新取提示，因此可反映本轮扩展修改后的有效内容。
	// 底层 Agent 循环开始时调用；同步回调，不返回结果。
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
