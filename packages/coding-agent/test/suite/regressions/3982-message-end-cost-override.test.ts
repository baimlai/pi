// 问题 #3982：message_end 扩展替换费用字段后，最终助手历史和公开结束事件都应看到替换值；这不是计费准确性测试。
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// 注册完成消息费用替换测试；例：扩展给 total 写 0.123，历史与通知都应呈现 0.123。
describe("regression #3982: message_end cost override", () => {
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

	// 无参数异步用例，安装只处理助手完成消息的扩展，用 faux 回答后比较两处费用；仅验证替换传播。
	it("allows extensions to replace finalized assistant usage cost", async () => {
		// 异步创建配置化测试环境；下面选项决定扩展、工具或重试设置，await 等初始化完成。
		const harness = await createHarness({
			// 提供内联扩展工厂数组，harness 会加载这些函数并绑定到本次会话。
			extensionFactories: [
				// 扩展工厂接收本次 ExtensionAPI；只注册或保存 API，工厂本身不是模型回复。
				(pi) => {
					// 注册完成消息回调；输入可能有不同 role，返回可替换消息对象，随后由会话层保存并通知。
					pi.on("message_end", (event) => {
						// 判别联合类型的 role，非助手直接不替换；此分支也让 TS 知道后面的 usage 是助手字段。
						if (event.message.role !== "assistant") return;

						// 返回外层 message 替换结果；原代码的多层展开只复制相应对象层，不深复制整条消息。
						return {
							// message 是扩展返回契约的替换字段，不是新增一条历史。
							message: {
								// 先保留原助手字段，包括 role 和正文；对象展开后的同名属性会被后面覆盖。
								...event.message,
								// 重建 usage 外壳，避免丢掉 token 计数等原字段。
								usage: {
									// 复制原 usage 的各字段，后面的 cost 替换其中费用对象。
									...event.message.usage,
									// 重建费用对象，仅覆写 total，其他分项保持原值。
									cost: {
										// 展开保留 input/output/cache 等费用分项，不重新计算它们与总价的一致性。
										...event.message.usage.cost,
										// 固定写入演示总价 0.123；这个测试数值不是供应商真实账单。
										total: 0.123,
									},
								},
							},
						};
					});
				},
			],
		});
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);
		// 给 faux 一项正常 hello 回复，不使用真实模型凭据。
		harness.setResponses([fauxAssistantMessage("hello")]);

		// 等待 hi 请求及事件处理全部收尾，随后检查最终状态。
		await harness.session.prompt("hi");

		// 从会话历史找第一条助手消息；find 找不到会返回 undefined。
		const assistantMessage = harness.session.messages.find((message) => message.role === "assistant");
		// 先报告缺失助手的测试失败；?. 避免在缺失时直接读属性抛无关错误。
		expect(assistantMessage?.role).toBe("assistant");
		// 显式分支为 TypeScript 收窄对象类型，不能靠 expect 自动获得静态收窄。
		if (assistantMessage?.role !== "assistant") {
			// 缺少目标消息时终止用例，后面不再访问 usage。
			throw new Error("missing assistant message");
		}
		// 断言会话历史中最终对象的总价已被扩展替换。
		expect(assistantMessage.usage.cost.total).toBe(0.123);

		// 在公开完成事件中找助手项，独立验证观察者所见费用。
		const messageEnd = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		// 要求确有助手完成事件，避免只改历史而遗漏通知路径。
		expect(messageEnd?.message.role).toBe("assistant");
		// 检查存在性并按 role 收窄嵌套消息；这是供后面安全访问字段的测试控制流。
		if (messageEnd?.message.role !== "assistant") {
			// 没有助手结束事件时显式失败，不把缺失事件当默认费用。
			throw new Error("missing assistant message_end event");
		}
		// 断言公开事件携带的最终助手费用也为替换值，不只检查持久化投影。
		expect(messageEnd.message.usage.cost.total).toBe(0.123);
	});
});
