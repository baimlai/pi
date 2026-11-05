/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“以用户身份注入消息”。
 * 上游：宿主通过 `pi -e ./send-user-message.ts`（或把文件放进扩展目录）加载；用户输入
 * /ask、/steer、/followup、/askwith 时进入命令处理器。下游：pi.sendUserMessage() 把内容
 * 交给会话输入链，随后可能触发一轮模型调用；ctx.isIdle()/ctx.ui.notify() 只读取状态或
 * 显示提示，不写文件。
 *
 * 演示的机制：sendMessage() 注入的是自定义消息，而 sendUserMessage() 注入的是真正以
 * 用户身份出现的消息（会触发新一轮）。消息在流式进行中发送时必须指定 deliverAs：
 * "steer" 立刻转向（打断当前处理），"followUp" 排队等当前处理结束。
 *
 * 能力清单：
 * - /ask：空闲时发送一条用户消息；忙碌时提示改用 /steer 或 /followup。
 * - /steer：空闲时普通发送，忙碌时以 steer 方式插队。
 * - /followup：空闲时普通发送，忙碌时以 followUp 方式排队。
 * - /askwith：演示内容块数组形式（文字块；也可放图片块）。
 *
 * 典型运行顺序：加载扩展 -> 输入 /ask What is 2+2? -> 模型开始回答；在回答过程中输入
 * /steer Focus on X 会立即插入指令，/followup And then? 则排在当前回答之后。输入为空
 * 参数时只显示用法提示。
 *
 * 示例（真实签名）：
 *   pi.sendUserMessage("Summarize this", { deliverAs: "followUp" });
 *   忙碌时会排队；空闲时 deliverAs 不是必需。注意本调用返回 void，扩展无法直接 await 回复。
 *
 * 建议阅读顺序：先看 /ask 的空闲/忙碌分流，再看 /steer 与 /followup 的 deliverAs 差异，
 * 最后看 /askwith 的数组内容形式。
 *
 * 前置条件：需要能启动模型的普通交互会话；发送消息会真实调用模型并可能产生费用。
 */

/**
 * Send User Message Example
 *
 * Demonstrates pi.sendUserMessage() for sending user messages from extensions.
 * Unlike pi.sendMessage() which sends custom messages, sendUserMessage() sends
 * actual user messages that appear in the conversation as if typed by the user.
 *
 * Usage:
 *   /ask What is 2+2?     - Sends a user message (always triggers a turn)
 *   /steer Focus on X     - Sends while streaming with steer delivery
 *   /followup And then?   - Sends while streaming with followUp delivery
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口：只登记四个命令，不立即发送任何消息。
export default function (pi: ExtensionAPI) {
	// Simple command that sends a user message
	// /ask：空闲时直接发送；忙碌时拒绝，避免在没有 deliverAs 的情况下出错。
	pi.registerCommand("ask", {
		description: "Send a user message to the agent",
		handler: async (args, ctx) => {
			// trim() 去掉两端空白后再判空；只有空白也视为没有参数。
			if (!args.trim()) {
				ctx.ui.notify("Usage: /ask <message>", "warning");
				return;
			}

			// sendUserMessage always triggers a turn when not streaming
			// If streaming, it will throw (no deliverAs specified)
			// isIdle() 为 false 表示模型流式输出或队列中仍有待处理消息。
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Use /steer or /followup instead.", "warning");
				return;
			}

			// 默认以用户身份发送并触发一轮；返回 void，不提供模型回复。
			pi.sendUserMessage(args);
		},
	});

	// Command that steers the agent mid-conversation
	// /steer：需要打断当前处理时使用 steer 递送。
	pi.registerCommand("steer", {
		description: "Send a steering message (interrupts current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /steer <message>", "warning");
				return;
			}

			// 空闲时与普通发送等价，不必指定递送方式。
			if (ctx.isIdle()) {
				// Not streaming, just send normally
				pi.sendUserMessage(args);
			} else {
				// Streaming - use steer to interrupt
				// deliverAs: "steer" 让新指令插到当前生成之前生效。
				pi.sendUserMessage(args, { deliverAs: "steer" });
			}
		},
	});

	// Command that queues a follow-up message
	// /followup：不打断当前处理，等这一轮结束后再处理。
	pi.registerCommand("followup", {
		description: "Queue a follow-up message (waits for current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /followup <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// Not streaming, just send normally
				pi.sendUserMessage(args);
			} else {
				// Streaming - queue as follow-up
				// followUp 进入队列，当前轮次完成后才作为用户输入处理。
				pi.sendUserMessage(args, { deliverAs: "followUp" });
				ctx.ui.notify("Follow-up queued", "info");
			}
		},
	});

	// Example with content array (text + images would go here)
	// /askwith：演示内容块数组；数组元素是 TextContent/ImageContent 联合。
	pi.registerCommand("askwith", {
		description: "Send a user message with structured content",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /askwith <message>", "warning");
				return;
			}

			// 与 /ask 一样只在空闲时发送，避免流式期间缺少递送方式。
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			// sendUserMessage accepts string or (TextContent | ImageContent)[]
			// 两个 {type:"text"} 块会按顺序成为同一条用户消息；图片块会带 MIME 与编码数据。
			pi.sendUserMessage([
				{ type: "text", text: `User request: ${args}` },
				{ type: "text", text: "Please respond concisely." },
			]);
		},
	});
}
