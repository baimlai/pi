// 问题 #3688：扩展在树导航前取消时，叶子位置必须保持，导航占用的压缩状态也必须释放。
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

// 注册取消树导航的状态回归；例：从 second 导航到 first 被取消后仍停在 second。
describe("issue #3688 tree cancellation compaction state", () => {
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

	// 无参数异步用例：造三条内存历史，令扩展取消旧节点导航，再检查取消结果、忙碌状态和叶子；不生成摘要。
	it("clears branch summary state when session_before_tree cancels navigation", async () => {
		// 异步创建配置化测试环境；下面选项决定扩展、工具或重试设置，await 等初始化完成。
		const harness = await createHarness({
			// 提供内联扩展工厂数组，harness 会加载这些函数并绑定到本次会话。
			extensionFactories: [
				// 扩展工厂接收本次 ExtensionAPI；只注册或保存 API，工厂本身不是模型回复。
				(pi) => {
					// 注册无参数箭头回调返回取消对象；=> ({...}) 的括号把对象作为返回值，不是函数块。
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);

		// 构造 first 用户消息并追加到内存树，取返回条目 id 作为后续导航目标。
		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		// 在 first 后追加助手回复，使目标不是当前叶子；helper 只造消息，不调用模型。
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		// 再追加 second 用户消息，保存导航前的叶子 id，以便证明取消没有挪动位置。
		const currentLeafId = harness.sessionManager.appendMessage(userMsg("second"));

		// 取消后仍应保留原 second 叶子；同一断言在导航前后出现，用于比较位置未变。
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);

		// 请求去 first，并明确不总结离开分支；真实导航先设置控制器，再询问扩展，取消走 finally 清理。
		const result = await harness.session.navigateTree(targetId, { summarize: false });

		// 要求 API 返回扩展取消结果；这不同于抛异常或用户中止带 aborted 标志。
		expect(result).toEqual({ cancelled: true });
		// 验证导航控制器已清理，避免一次取消令会话以后永久被认为正在压缩。
		expect(harness.session.isCompacting).toBe(false);
		// 取消后仍应保留原 second 叶子；同一断言在导航前后出现，用于比较位置未变。
		expect(harness.sessionManager.getLeafId()).toBe(currentLeafId);
	});
});
