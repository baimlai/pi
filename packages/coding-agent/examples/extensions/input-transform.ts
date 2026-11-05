// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示 input 事件的三种结果：continue（原样继续）、transform（改写文字后继续）、handled（扩展
//   自己处理完，不再交给后续输入链）。示例实现 ?quick 前缀改写、ping 即时回复和 time 即时时间。
// 上游：`pi -e ./examples/extensions/input-transform.ts` 加载，宿主在每次提交输入时调用下面登记的
//   input handler，并传入当前 InputEvent 与 ExtensionContext。
// 下游：只调用 ctx.ui.notify 显示本地消息；只有 transform 分支会把新文字交给模型，ping/time 不发请求。
//   扩展不写文件、不持久化状态，也没有网络副作用。
// 能力：
//   默认导出函数   向 ExtensionAPI 注册一个输入处理器，按来源/正文选择动作。
// 典型顺序：加载扩展 -> 用户输入 -> handler 依次检查 source、?quick、ping、time -> 返回动作。
// 示例：输入 `?quick What is TypeScript?` 得到 `Respond briefly in 1-2 sentences: What is TypeScript?`；
//   输入 `ping` 只显示 pong，不调用模型。
// 阅读顺序：先看默认导出的 input 回调，再对照 InputEventResult 的三个分支理解返回值。

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
// 示例：导出函数在扩展加载时调用一次，真正的输入处理发生在之后的 pi.on("input") 回调里。
export default function (pi: ExtensionAPI) {
	// async 回调收到当前输入和 UI 上下文，返回的 action 联合值决定后续输入流程。
	// event.source 的联合类型是 "interactive" | "rpc" | "extension"；ctx 是 ExtensionContext，
	// ctx.ui.notify 是本地提示，不进入模型上下文。
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
			// 下面 slice(7).trim() 先截掉 "?quick " 七个 UTF-16 代码单元，再去掉首尾空白。
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
