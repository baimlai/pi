// 两次用户提问，第一次读真实文件，共发生三次离线模型请求。
// 运行方法见 docs/learning/pi/QUERY_CALL_CHAIN.md；这里复用正式测试 harness，不需要 API Key。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText, getToolResult, getUserTexts } from "./harness.ts";

// describe 把这个完整场景归为一组；不是启动 Agent，只是在注册测试。
describe("中文学习：query 的完整调用链", () => {
	// async 表示测试里可以 await；await prompt() 等待整个工具循环和会话收尾。
	it("读文件后回答，再根据同一个会话的历史回答追问", async () => {
		// await 拿到初始化完成的会话。只启用 read，方便观察唯一一条工具路径。
		const harness = await createHarness({ initialActiveToolNames: ["read"] });
		// 真实文件属于测试临时目录，cleanup() 会清理它。
		writeFileSync(join(harness.tempDir, "decision.txt"), "决定：使用 TypeScript。原因：需要类型检查。");
		// string[][] 是两层字符串数组：每次请求存一组消息角色，方便下断点。
		const requests: string[][] = [];
		try {
			// 预先安排模型的三次回答；faux 会产生真实的流事件，但不会访问模型服务。
			harness.setResponses([
				// 第一次请求：模型只决定调用什么工具，尚未读到文件。
				(context) => {
					// map 把每条消息变成它的 role，例如 user、assistant、toolResult。
					requests.push(context.messages.map((message) => message.role));
					// 当前只有第一句用户问题，工具结果还不存在。
					expect(context.messages.some((message) => message.role === "toolResult")).toBe(false);
					// 返回工具调用声明；真正读文件的是 Agent 后面执行的 read.execute()。
					return fauxAssistantMessage(fauxToolCall("read", { path: "decision.txt" }, { id: "read-decision" }), {
						// toolUse 表示模型这次输出要求使用工具，不代表用户又问了一次。
						stopReason: "toolUse",
					});
				},
				// 第二次请求：仍属于第一句用户问题，但现在上下文已带上读文件的结果。
				(context) => {
					requests.push(context.messages.map((message) => message.role));
					// find 找到第一个匹配的工具结果；找不到时返回 undefined。
					const result = context.messages.find((message) => message.role === "toolResult");
					// 验证模型实际收到文件内容，而不只是 UI 显示了一次工具执行。
					expect(getMessageText(result)).toContain("决定：使用 TypeScript");
					// message_end 被会话层处理后，工具结果在下一次请求前已进入会话记录。
					expect(
						harness.sessionManager
							.getEntries()
							.some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
					).toBe(true);
					// 普通文本回答，没有新的 toolCall，正常情况下工具循环就会结束。
					return fauxAssistantMessage("项目决定使用 TypeScript，因为它能做类型检查。");
				},
				// 第三次请求：用户真的发了第二句话，这次应该能看见之前的完整对话。
				(context) => {
					requests.push(context.messages.map((message) => message.role));
					// filter 只保留 user；map 再提取文本。这是常见的数组处理写法。
					expect(context.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
						"读取 decision.txt，告诉我项目的决定和原因。",
						"用一句话重述刚才的决定。",
					]);
					// 历史工具结果仍在，所以不用再次读取文件。
					expect(getMessageText(context.messages.find((message) => message.role === "toolResult"))).toContain(
						"需要类型检查",
					);
					return fauxAssistantMessage("为了获得类型检查，项目采用 TypeScript。");
				},
			]);

			// Query 1：这里等到“读文件 → 再请求模型 → 回答 → 收尾”全部完成才返回。
			await harness.session.prompt("读取 decision.txt，告诉我项目的决定和原因。");
			// 用户只提问一次，但模型已被请求两次。
			expect(harness.faux.state.callCount).toBe(2);
			// isIdle 表示会话收尾完成，可以正常接受下一句提问。
			expect(harness.session.isIdle).toBe(true);
			// 结果通过 id 与模型发出的那次 read 调用配对。
			expect(getToolResult(harness, "read").toolCallId).toBe("read-decision");

			// Query 2：复用同一个 session，不 reset()，前面的对话因此保留下来。
			await harness.session.prompt("用一句话重述刚才的决定。");
			// 两句用户问题，总共三次模型请求、一次真实文件读取。
			expect(harness.faux.state.callCount).toBe(3);
			// 每次请求分别统计 toolResult 数量：第一次没有，后两次都有同一个结果。
			expect(requests.map((roles) => roles.filter((role) => role === "toolResult").length)).toEqual([0, 1, 1]);
			// 最终用户消息数是 2；内部工具循环没有伪造第三句用户问题。
			expect(getUserTexts(harness)).toHaveLength(2);
			// message_update 只是流式片段；完整 assistant 消息共有 3 条。
			expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
			// 每个用户 query 收尾一次；agent_end 与 agent_settled 的区别见导读。
			expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
			// 三个预设回答都用完，说明没有意外发出第四次请求。
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			// 即使断言抛错，也要注销 faux provider、释放 session、删除临时目录。
			harness.cleanup();
		}
	});
});
