// 问题 #3317：用 faux 连续返回网络错误和成功文字，验证自动重试事件及最终历史；没有建立或断开真实网络连接。
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

// 注册网络错误重试这一组测试；回调只声明用例和清理规则。例：错误文字为 Network connection lost. 时应再次请求 faux。
describe("issue #3317 network connection lost retry", () => {
	// 保存本组创建的测试环境；Harness[] 是元素类型为 Harness 的数组，清理时逐一释放临时目录和 faux 注册。
	const harnesses: Harness[] = [];

	// 每个用例结束后执行清理回调；无参数、无业务返回值，断言失败时 Vitest 也会安排它运行。
	afterEach(() => {
		// 只要还有测试环境，就从尾部取出一个，避免 faux 供应商和会话订阅泄漏到下一例。
		while (harnesses.length > 0) {
			// pop 取出并移除最后一项；?. 在数组意外为空时跳过，cleanup 释放会话、注销 faux 并删本环境临时目录。
			harnesses.pop()?.cleanup();
		}
	});

	// 无输入的异步用例，构造一次失败再成功的回复；等待 prompt 后检查请求数、重试事件和历史，断言失败抛出测试错误。
	it('retries transient "Network connection lost." failures', async () => {
		// 异步创建配置化测试环境；下面选项决定扩展、工具或重试设置，await 等初始化完成。
		const harness = await createHarness({
			// 开启自动重试、最多重试三次并把基础退避设为 1ms；用例只实际触发一次重试，不证明三次上限边界。
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);
		// 顺序装入 faux 回复脚本；每次模型请求消费一项，便于检查额外续轮或重试。
		harness.setResponses([
			// 第一项模拟 assistant 错误终态；空正文和错误文字都是固定夹具，不是底层 socket 错误。
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost." }),
			// 第二项模拟正常最终回复，供重试成功后的模型调用消费。
			fauxAssistantMessage("recovered after reconnect"),
		]);

		// 发送用户文字并等待会话整轮（含自动重试）收尾；错误回复的重试由真实会话逻辑决定。
		await harness.session.prompt("test");

		// 运行时断言共请求 faux 两次，证明此脚本发生一次重试。
		expect(harness.faux.state.callCount).toBe(2);
		// 按事件类型筛选并投影错误文字，深比较完整数组，要求恰好一次重试开始且携带原错误。
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
			// 这里是期望的事件字段值，必须和模拟失败的错误文字相同。
			"Network connection lost.",
		]);
		// 要求唯一的重试结束事件报告成功；map 回调读取已按类型收窄的 success 字段。
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		// 检查会话助手历史包含恢复回复，避免仅发成功事件却丢失结果；不约束历史中其他助手项。
		expect(getAssistantTexts(harness)).toContain("recovered after reconnect");
	});
});
