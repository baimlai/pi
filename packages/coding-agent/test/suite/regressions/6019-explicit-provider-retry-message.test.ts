import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

// 保留供应商真实错误外形供字符串分类器匹配；本测试没有请求 OpenAI。
const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
// 这仍是一个字符串，内部虽长得像 JSON，本测试不会 JSON.parse 或访问 Bedrock。
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';

// 注册 #6019 的两行表驱动用例；describe 回调只组织测试，实际模型响应由 faux 内存供应商提供。
describe("regression: issue 6019 explicit provider retry messages", () => {
	// each 将下方每行作为一组参数；例如 openai 行把完整错误文案交给同一个异步测试。
	it.each([
		["openai", openAIExplicitRetryMessage],
		["bedrock", bedrockExplicitRetryMessage],
		// 测试输入是标签及错误文案，结果由断言验证而非返回业务值；先失败再成功，finally 清理。
		// _provider 仅参与测试标题，不会选择真实供应商；例如两行都使用 harness 的 faux 模型。
	])("retries %s explicit retry guidance", async (_provider, errorMessage) => {
		// await 等待创建本地会话；开启会话级重试、最多 3 次，1ms 为退避基数，避免测试长时间等待。
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		// 把响应设置、执行和断言放进 try，使其中任何一步失败后仍进入 finally 释放资源。
		try {
			// 用固定顺序排好两次模型结果；这不是实际网络重试错误。
			harness.setResponses([
				// 首条助手消息以 error 结束；属性简写 errorMessage 使用测试参数里的同名变量。
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				// 第二次请求返回正常文本，供自动重试消耗。
				fauxAssistantMessage("recovered"),
			]);

			// 等待整次会话提问及自动重试收尾完成；prompt 返回后再检查累计事件。
			await harness.session.prompt("test");

			// 断言 faux 恰好收到两次请求：一次失败和一次恢复。
			expect(harness.faux.state.callCount).toBe(2);
			// 按事件标签筛选，再用箭头回调提取错误文本；只应出现一次开始重试通知。
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([errorMessage]);
			// 深比较成功标记数组，确认该次重试成功结束，而非只发出了开始事件。
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		} finally {
			// 释放会话、注销 faux 供应商并删除 harness 临时目录；finally 保证断言失败也执行。
			harness.cleanup();
		}
	});
});
