import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

// 固定 DNS 解析失败的嵌套错误文案；ENOTFOUND 只是测试输入，不会实际查域名。
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";

// 组织 #6904 回归：共享错误分类器应识别文案深处的临时传输失败。
describe("issue #6904 DNS transport failure retry", () => {
	// 无参数异步用例：安排一次 DNS 文案错误和一次正常回复，等待提问后核对两次请求与成功事件。
	// 例如固定文案含 getaddrinfo ENOTFOUND 时应触发重试；本例不证明真实 DNS 会恢复。
	it("retries a transient DNS lookup failure", async () => {
		// 创建本地 faux 会话，把重试等待基数降至 1ms；设置由内存 SettingsManager 提供。
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		// 保证后面执行或断言失败时也会清理已创建的 harness。
		try {
			// 预设两次顺序消费的内存响应。
			harness.setResponses([
				// 第一次返回 error 终态及固定 DNS 文案，走会话错误分类路径。
				fauxAssistantMessage("", { stopReason: "error", errorMessage: wrappedDnsLookupError }),
				// 第二次返回正常终态文字，作为恢复结果。
				fauxAssistantMessage("recovered after DNS retry"),
			]);

			// 等待自动重试与整轮会话事件处理结束。
			await harness.session.prompt("test");

			// 只有失败和恢复两次请求，不能无限重复重试。
			expect(harness.faux.state.callCount).toBe(2);
			// map 抽出所有重试开始的文案，并与下面单元素数组深比较。
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
				wrappedDnsLookupError,
			]);
			// 结束通知应只有一次，且明确标记成功。
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		} finally {
			// 在 finally 中注销假供应商、释放会话并移除临时目录。
			harness.cleanup();
		}
	});
});
