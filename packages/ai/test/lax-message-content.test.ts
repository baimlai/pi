/**
 * The Message types require `content` to always be present, but untyped
 * callers (custom tools, hand-built histories, old session files) can violate
 * that contract. `transformMessages` is the choke point before every provider
 * request and is intentionally lax: it normalizes null/missing content to an
 * empty array (issues #6259, #6276).
 */

import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Message, Model } from "../src/types.ts";

// Text-only model so the image downgrade path (replaceImagesWithPlaceholder) runs,
// which was the primary crash site for null tool result content.
// 返回纯文字测试模型，无输入/外部副作用；例 transformMessages(..., makeTextOnlyModel()) 会走图片降级分支。
// 这里只声明模型不支持图，不运行真实模型；需要给完整元数据以符合 Model<"openai-completions">。
function makeTextOnlyModel(): Model<"openai-completions"> {
	// 新对象只服务于历史转换，不注册到模型目录。
	return {
		// 固定请求 id 和显示名。
		id: "test-model",
		name: "Test Model",
		// API 是协议标签，provider 是供应商名，二者不必同名。
		api: "openai-completions",
		provider: "openai",
		// invalid 地址不会被本组的纯转换函数请求。
		baseUrl: "https://example.invalid/v1",
		// 无思考能力，输入模态只列 text，确保工具结果的替图代码会读取 content。
		reasoning: false,
		input: ["text"],
		// 费用和容量是完整类型必需字段，不在本用例执行计费或容量测试。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

// 声明无类型历史入口的兼容回归测试；有效的 Message 静态类型本来不允许 content 为 null/缺省。
describe("lax message content handling", () => {
	// 人工构造三种缺正文消息，再执行纯历史转换；例缺 content 的 toolResult 应变 []，不执行 web_search。
	it("normalizes null/missing content to an empty array instead of crashing", () => {
		// 这里故意违反 TS 契约，模拟 JS 调用者/旧会话文件的实际数据。
		const messages = [
			// 用户正文明确为 null，而不是空字符串或合法内容数组。
			{ role: "user", content: null, timestamp: Date.now() },
			{
				// 回复正文也明确为 null；其余字段补齐，避免把不相关的字段错误混入测试。
				role: "assistant",
				content: null,
				// 来源与目标模型相同，本例不测试跨模型签名/思考块处理。
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				// 统一 usage 的各项零值只是占位，不表示发生了请求。
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				// 设正常结束，避免转换器按 error/aborted 规则丢掉整条 assistant。
				stopReason: "stop",
				// Date.now 只给消息时间，本例不对具体时间作断言。
				timestamp: Date.now(),
			},
			{
				// 工具结果连 content 字段都没给，模拟 undefined，与前两条的 null 分开覆盖。
				role: "toolResult",
				// 这些只是记录字段，没有相应真实工具执行。
				toolCallId: "call_1",
				toolName: "web_search",
				isError: false,
				timestamp: Date.now(),
			},
			// 双重 as 先经过 unknown 绕过静态不兼容，仅用于注入坏历史，不会运行时补 content。
		] as unknown as Message[];

		// 真实转换器先把 null/undefined content 补 []，再做纯文字模型的图片降级等步骤。
		const result = transformMessages(messages, makeTextOnlyModel());

		// 结果仍为三条；此测试也展示无配对调用的工具结果不会自动被删掉。
		expect(result).toHaveLength(3);
		// 对每条结果都检查正文结构为空数组；不声称覆盖所有坏历史的修复。
		for (const msg of result) {
			// toEqual 比较数组内容，不要求三条共用同一个 [] 引用。
			expect(msg.content).toEqual([]);
		}
	});
});
