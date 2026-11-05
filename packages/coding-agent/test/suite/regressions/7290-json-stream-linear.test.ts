import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

// 组织 #7290：内存流保留累积快照，传输投影应只发增量；比较两份固定样本的编码字节比例。
describe("regression #7290: JSON event streams stay linear", () => {
	// 数组收集每次测量创建的会话，类型 Harness[] 表示元素都是 Harness。
	const harnesses: Harness[] = [];

	// 测试结束后弹出并清理所有测量资源；即使其中一次测量断言失败也会运行。
	afterEach(() => {
		// 数组尚有元素就继续清理，避免多次测量留下供应商注册。
		while (harnesses.length > 0) {
			// pop 删除并返回末项；?. 兼容其类型里可能的 undefined。
			harnesses.pop()?.cleanup();
		}
	});

	// 输入一段回复文本，运行 faux 会话后返回所有投影更新的 UTF-8 字节数；Promise<number> 表示异步数字。
	// 副作用是创建并登记 harness；例如 2000 个 x 用于小样本。异常由调用方测试报告，afterEach 负责清理。
	async function measureUpdateBytes(text: string): Promise<number> {
		// 等待本地内存会话初始化。
		const harness = await createHarness();
		// 先登记资源，使后续任意断言失败也能清理。
		harnesses.push(harness);
		// 把输入文本设为假模型唯一回复；分块由 faux 实现产生。
		harness.setResponses([fauxAssistantMessage(text)]);

		// 等待完整回复和事件收集完毕。
		await harness.session.prompt("respond");

		// 筛选内部更新事件，类型随事件标签收窄。
		const sessionUpdates = harness.eventsOfType("message_update");
		// 逐条检查内部事件仍包含快照；后面投影环节才删除它们。
		for (const update of sessionUpdates) {
			// 内部事件携带当前消息快照。
			expect(update).toHaveProperty("message");
			// faux 产生的内部增量仍带 partial；本测试并非要求核心事件省略它。
			expect(update.assistantMessageEvent).toHaveProperty("partial");
		}

		// map 为每个内部事件调用传输投影器，得到新数组，不在此写 stdout。
		const updates = sessionUpdates.map((event) => toJsonEvent(event));
		// 避免空更新数组使后面的字段缺失断言空转通过。
		expect(updates.length).toBeGreaterThan(0);
		// 逐条核对传输形状，不能重复携带整段累积内容。
		for (const update of updates) {
			// 顶层完整消息快照已移除。
			expect(update).not.toHaveProperty("message");
			// 嵌套增量的 partial 快照也已移除。
			expect(update.assistantMessageEvent).not.toHaveProperty("partial");
		}
		// 从 0 累加每条 JSON 的 UTF-8 字节数；不含行分隔符，也不是内存占用或实际 stdout 总量。
		return updates.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
	}

	// 无输入异步用例比较两份相差一倍长度的固定回复；断言变大但比例低于 2.2。
	// 这证明当前 faux 样本下没有重复快照膨胀，并非对任意内容和供应商作形式化复杂度证明。
	it("emits delta-only message updates whose size scales linearly", async () => {
		// 数字中的下划线只提高可读性，2_000 等于 2000；repeat 构造小样本文本。
		const smallBytes = await measureUpdateBytes("x".repeat(2_000));
		// 用同字符、两倍长度构造大样本，便于比较编码大小。
		const largeBytes = await measureUpdateBytes("x".repeat(4_000));

		// 大样本确实产生更多更新字节。
		expect(largeBytes).toBeGreaterThan(smallBytes);
		// 允许固定事件开销和分块差异，同时限制两倍文本的输出增长比例。
		expect(largeBytes / smallBytes).toBeLessThan(2.2);
	});
});
