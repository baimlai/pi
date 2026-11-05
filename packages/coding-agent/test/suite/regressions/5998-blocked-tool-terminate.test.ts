// 问题 #5998：tool_call 扩展同时 block 和 terminate 后，应产生错误工具结果并停止自然续轮；没有执行真实工具。
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

// 注册工具拦截并终止的回归测试；例：模型想调用 echo，被策略阻止后不再消费下一条助手回复。
describe("#5998 blocked tool termination", () => {
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

	// 无输入异步用例：造必抛错工具和阻止策略，脚本请求工具后检查剩余回复与终止结果；若真执行工具，错误信息会暴露该路径。
	it("lets a tool_call handler terminate the run after blocking execution", async () => {
		// 声明符合 AgentTool 契约的测试工具；类型约束仅检查开发期对象形状。
		const echoTool: AgentTool = {
			// 工具注册名，必须与 fauxToolCall 的 echo 一致。
			name: "echo",
			// 界面显示名，不影响工具匹配。
			label: "Echo",
			// 给模型的工具描述，保持原英文固定文本。
			description: "Echo text back",
			// 构造要求 text 为字符串的参数 schema；真正工具参数校验在调用管线，TS 类型本身不会校验 JSON。
			parameters: Type.Object({ text: Type.String() }),
			// 不读取参数的异步执行替身；正常情况下策略应在到达它之前拦截。
			execute: async () => {
				// 一旦实际执行就抛错，用于暴露绕过拦截；后续还会核对终止标志和未消费回复。
				throw new Error("tool should have been blocked");
			},
		};
		// 异步创建配置化测试环境；下面选项决定扩展、工具或重试设置，await 等初始化完成。
		const harness = await createHarness({
			// 只注入本测试的 echo 工具，避免依赖内置文件或 shell 工具。
			tools: [echoTool],
			// 提供内联扩展工厂数组，harness 会加载这些函数并绑定到本次会话。
			extensionFactories: [
				// 扩展工厂接收本次 ExtensionAPI；只注册或保存 API，工厂本身不是模型回复。
				(pi) => {
					// 注册异步工具调用前策略；箭头直接返回对象，所有工具调用在此例都得到同一策略。
					pi.on("tool_call", async () => ({
						// 要求不进入工具 execute，生成被阻止的工具结果。
						block: true,
						// 把固定策略原因写进失败结果，帮助解释拦截。
						reason: "Blocked by terminating policy",
						// 同时要求停止当前自然工具续轮；此例没有排队 follow-up，不证明所有将来用户请求都被阻止。
						terminate: true,
					}));
				},
			],
		});
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);
		// 顺序装入 faux 回复脚本；每次模型请求消费一项，便于检查额外续轮或重试。
		harness.setResponses([
			// 第一条助手回复带 echo 调用并以 toolUse 结束，触发真实工具编排。
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			// 第二条是哨兵回复；如果终止正确它应留在 faux 队列。
			fauxAssistantMessage("should not run"),
		]);

		// 启动并等待整个会话回合，工具调用策略由真实会话/Agent 管线执行。
		await harness.session.prompt("hi");

		// 要求哨兵回复仍未消费，证明未自动再请求模型。
		expect(harness.getPendingResponseCount()).toBe(1);
		// 从最终助手历史再验证哨兵文字没有出现。
		expect(getAssistantTexts(harness)).not.toContain("should not run");
		// 取首个工具结束事件，要求结果携带 terminate:true，核对策略标志传播。
		expect(harness.eventsOfType("tool_execution_end")[0]?.result).toHaveProperty("terminate", true);
		// 下面跨行断言查找错误工具结果；expect 的参数是 find 的返回对象或 undefined。
		expect(
			// 按 role 和 isError 找错误工具结果，&& 同时为 TS 收窄并筛选失败项。
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
			// 要求确有错误工具结果；未进一步断言它的完整正文或错误原因。
		).toBeDefined();
	});
});
