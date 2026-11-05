// 验证一轮生成失败后，排在后面的输入/写入如何按 keep、continue、withdraw 策略处理。
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type AfterFailedRun, AssistantEntry, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, textOf } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

/** A response that fails for good once `gate` opens; `reached` resolves when it was requested. */
// 无参数；返回 faux 应答步骤及两道闸门，不立即启动请求。
// reached 告知已请求，gate 放行后返回 stopReason=error 的消息；它不直接 throw。
// 例：await reached.promise 后可确定第一轮正卡着，再排第二条输入。
function failingOnce() {
	// deferred 是可从外部 resolve 的 Promise 封装，用来控制失败发生的时机。
	const gate = deferred();
	const reached = deferred();
	// FauxResponseStep 类型约束回调契约；这里只模拟返回失败，不调用真实供应商。
	const step: FauxResponseStep = async () => {
		// 先报告开始，再等待测试放行。
		reached.resolve();
		await gate.promise;
		// errorMessage 让生成被视为模型错误；空内容不是成功答案。
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" });
	};
	// 把同一组闸门和使用它的步骤交给调用者。
	return { step, gate, reached };
}

/** A run that fails with an input queued behind it, under `policy`; returns how the queued input settled. */
// policy 为失败策略或 undefined（沿用默认）；开 Harness、暂停首答、排 followUp 后放行错误。
// 返回仍打开的 harness/root/second，由各测试等待或检查；本函数只断言首输入失败。
// 例：传 continue 会让第二条继续运行；提交/等待/断言抛错会直接拒绝这个 Promise。
async function failWithQueuedInput(policy: AfterFailedRun | undefined) {
	// 独立的设置对象和 faux 响应队列，不影响其他用例。
	const setup = chatSetup();
	// undefined 时不写设置，才能测试默认 keep 而不是人为指定它。
	if (policy !== undefined) setup.settings.afterFailedRun = policy;
	// 第一个步骤卡住后失败，后两条成功回答供后续队列消费。
	const failing = failingOnce();
	setup.faux.setResponses([failing.step, fauxAssistantMessage("second answer"), fauxAssistantMessage("third answer")]);
	// 解构取得 Harness 与根会话；只用 MemoryStorage。
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	// 提交首输入后等 faux 确认真正进入请求步骤。
	const first = await root.submit({ type: "input", content: "Analyze this report" }, context);
	await failing.reached.promise;
	// 忙时明确选择 followUp：放在当前轮之后，不作为当前轮的 steer。
	const second = await root.submit({ type: "input", content: "Email me the summary", whenBusy: "followUp" }, context);
	// 现在才放出首轮失败，保证第二条已经在队列里。
	failing.gate.resolve();
	// 输入终态是 unanswered/model_error；不是直接把模型错误抛给 first.wait。
	expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
	// 此时 second 是否已开始取决于策略，调用者负责检查和关闭。
	return { harness, root, second };
}

// 四个用例分别固定默认保留、自动继续、写入边界、撤回输入的语义。
describe("inputs queued behind a failed run", () => {
	// 默认失败后先空闲但 second 保留；再提交 third，二者依序完成，最后关闭资源。
	// 例：用户再次发问可以启动先前保留的队列；断言失败会使本测试失败。
	it("stay queued by default", async () => {
		// undefined 保持 afterFailedRun 的默认值。
		const { harness, root, second } = await failWithQueuedInput(undefined);
		// 等调度器空闲再看状态，排除“只是还没来得及启动”的解释。
		await harness.waitForIdle(context);
		expect(await second.status(context)).toMatchObject({ status: "queued" });
		// The next input runs the queue, as before.
		// 后来的输入使保留的 second 与新的 third 都得到一次成功回答。
		const third = await root.submit({ type: "input", content: "Anything else?" }, context);
		expect((await second.wait(context)).status).toBe("done");
		expect((await third.wait(context)).status).toBe("done");
		// 释放调度器和存储句柄。
		await harness.close(context);
	});

	// continue 无需第三条输入唤醒；取回 second 对应的答案验证不是只改了状态。
	it("start the next run with continue", async () => {
		// 首轮已由 helper 验证为 model_error。
		const { harness, root, second } = await failWithQueuedInput("continue");
		// 等第二条终态，后面的运行时条件也让 TS 收窄到带 answer 的输入结果。
		const settled = await second.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		// 从事务读取 AssistantEntry；token 不匹配或不存在时可返回 undefined。
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		// 可选链处理缺失值，textOf 抽消息里的文本；实际断言要求成功读到第二答。
		expect(textOf(answer?.model?.[0])).toBe("second answer");
		await harness.close(context);
	});

	// 同一场景跑两种策略：普通 write 不等于用户 input，withdraw 不撤销它。
	// 返回 void Promise；各轮建立并关闭独立 Harness，失败交给测试框架。
	it("place queued writes, and keep them with withdraw", async () => {
		// as const 保留两个字符串字面量类型，避免被推断成任意 string。
		for (const policy of ["continue", "withdraw"] as const) {
			// 新建环境并明确设置当前循环的策略。
			const setup = chatSetup();
			setup.settings.afterFailedRun = policy;
			// 第一答仍卡在闸门处，确保 write 在忙时入队。
			const failing = failingOnce();
			setup.faux.setResponses([failing.step, fauxAssistantMessage("second answer")]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			const first = await root.submit({ type: "input", content: "first" }, context);
			await failing.reached.promise;
			// 作为 entry.model 的用户消息；timestamp 固定以便测试可重复。
			const note = { role: "user", content: "a note the model sees", timestamp: 1 } as const;
			// write 写自定义条目，不请求模型回答；此刻仍须等待边界。
			const write = await root.submit({ type: "write", entry: { kind: "test.note", model: [note] } }, context);
			expect(await write.status(context)).toMatchObject({ status: "queued" });
			// 放行失败并等所有可运行工作静止，再比较策略差异。
			failing.gate.resolve();
			await first.wait(context);
			await harness.waitForIdle(context);
			// `continue` places the write at the failed run's boundary; `withdraw` withdraws inputs only.
			// 三元表达式构造各策略的真实预期；withdraw 下 write 仍保留排队。
			expect(await write.status(context)).toMatchObject({ status: policy === "continue" ? "done" : "queued" });
			await harness.close(context);
		}
	});

	// withdraw 把排队的 second 结为 unanswered/run_failed，而不是沿用首轮的 model_error。
	it("settle unanswered with run_failed with withdraw", async () => {
		const { harness, second } = await failWithQueuedInput("withdraw");
		// wait 可返回业务上的失败终态，这里不期待 Promise 拒绝。
		expect(await second.wait(context)).toMatchObject({ status: "unanswered", reason: "run_failed" });
		// 不再向队列发送新的输入。
		await harness.close(context);
	});
});
