import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

// 注册 #7925：去掉 partial 后，工具开始事件仍需提供 id 与名称，以便接收端识别新调用。
describe("regression #7925: tool-call metadata is available when streaming starts", () => {
	// 会话引用允许初始化前为空，供清理钩子共享。
	let harness: Harness | undefined;

	// 每例后清理已创建的 harness；无业务返回值。
	afterEach(() => {
		// 可选调用在创建失败时不再访问空对象。
		harness?.cleanup();
	});

	// 异步用例安排 write 调用和后续回复，找出开始事件，再深比较完整传输形状。
	// 例如 call_7925 必须在工具参数尚流入时可见；写入仅落在 harness 临时工作目录。
	it("includes the tool call id and name without cumulative snapshots", async () => {
		// 创建本地 faux 会话，其默认工具包含临时目录内的 write。
		harness = await createHarness();
		// 先给出工具调用消息，再给出工具完成后继续生成的普通回复。
		harness.setResponses([
			// 构造助手消息，内容由下面的工具调用块提供，结束原因另由第二个参数设置。
			fauxAssistantMessage(
				// 生成固定调用 id、工具名及参数；repeat 只是构造 100 字符的测试内容。
				fauxToolCall("write", { path: "output.txt", content: "x".repeat(100) }, { id: "call_7925" }),
				// toolUse 终态让 agent 执行工具并继续下一次模型请求。
				{ stopReason: "toolUse" },
			),
			// 工具完成后返回正常终态，结束这轮对话。
			fauxAssistantMessage("done"),
		]);

		// 等待真实会话编排、临时文件写入和事件收集完成。
		await harness.session.prompt("write a file");

		// 从多行方法链里寻找第一条工具开始更新。
		const update = harness
			// 按标签拿到全部内部助手更新。
			.eventsOfType("message_update")
			// find 通过增量标签挑出开始事件，未找到时返回 undefined。
			.find((event) => event.assistantMessageEvent.type === "toolcall_start");
		// 运行时检查样本存在且消息是助手类型，同时让 TypeScript 收窄访问范围。
		if (!update || update.message.role !== "assistant") {
			// 缺样本直接失败，不把后续对象比较变成空断言。
			throw new Error("Expected toolcall_start assistant update");
		}

		// 深比较整个传输对象，既要求关键字段存在，也会捕获多余快照字段。
		expect(toJsonEvent(update)).toEqual({
			// 顶层标签沿用会话更新标签。
			type: "message_update",
			// 仍带此刻累计用量。
			usage: update.message.usage,
			// 嵌套对象只包含这个工具开始增量所需的固定元数据。
			assistantMessageEvent: {
				// 工具开始标签与后续参数增量区分。
				type: "toolcall_start",
				// 该调用位于助手内容数组第 0 项。
				contentIndex: 0,
				// 固定 id 用于把后续增量与工具结果关联。
				id: "call_7925",
				// 投影从 partial 对应工具块提取工具名；这里不是执行工具的指令。
				toolName: "write",
			},
		});
	});
});
