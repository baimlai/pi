/**
 * Input Transform Example - demonstrates the `input` event for intercepting user input.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/input-transform.ts
 *
 * Then type these inside pi:
 *   ?quick What is TypeScript?  → "Respond briefly: What is TypeScript?"
 *   ping                        → "pong" (instant, no LLM)
 *   time                        → current time (instant, no LLM)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 登记用户输入预处理器；只注册不返回数据，输入事件由宿主稍后派发。
// 回调按来源和内容选择继续、改写或接管；例如 ping 仅显示 pong，?quick hi 改写为简短回答提示。
export default function (pi: ExtensionAPI) {
	// async 回调收到当前输入和 UI 上下文，返回的 action 联合值决定后续输入流程。
	pi.on("input", async (event, ctx) => {
		// Source-based logic: skip processing for extension-injected messages
		// 扩展注入的文字直接跳过，避免重复改写扩展自身发送的输入。
		if (event.source === "extension") {
			// continue 让后续处理器继续使用原输入。
			return { action: "continue" };
		}

		// Transform: ?quick prefix for brief responses
		// startsWith 区分大小写并要求 ?quick 后紧跟空格。
		if (event.text.startsWith("?quick ")) {
			// slice(7) 去掉七个字符前缀，trim 清除问题两端空白。
			const query = event.text.slice(7).trim();
			// 前缀后没有有效内容时进入用法提示。
			if (!query) {
				// 只发本地警告，不为无内容的问题启动模型。
				ctx.ui.notify("Usage: ?quick <question>", "warning");
				// handled 表示已经接管这次输入，终止剩余输入处理。
				return { action: "handled" };
			}
			// transform 提供新文字；没有传 images 时宿主保留当前附图。
			return { action: "transform", text: `Respond briefly in 1-2 sentences: ${query}` };
		}

		// Handle: instant responses without LLM (extension shows its own feedback)
		// 只转小写、不 trim；PING 能命中，带首尾空格的 ping 不命中。
		if (event.text.toLowerCase() === "ping") {
			// 显示即时回应，无模型网络请求。
			ctx.ui.notify("pong", "info");
			// 即时回应结束此输入。
			return { action: "handled" };
		}
		// 同样按完整小写字符串匹配 time。
		if (event.text.toLowerCase() === "time") {
			// Date 取得运行时当前时间，toLocaleString 按宿主地区和时区格式化。
			ctx.ui.notify(new Date().toLocaleString(), "info");
			// 时间请求由扩展接管完成。
			return { action: "handled" };
		}

		// 其他所有输入保留原样交给后续流程。
		return { action: "continue" };
	});
}
