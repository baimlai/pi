// 用内存存储与 faux 模型演示 runFailure：这是给界面读取的失败状态，不是抛给调用方的异常。
// `pi.live.runFailure`: why the newest run ended without an answer, as state a renderer shows (#11327).

import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AfterFailedRun,
	type Conversation,
	defineTool,
	type Harness,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	type RunFailure,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, unanswered } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

// 输入 Harness 和会话，异步读取该会话的 pi.live 文档；文档不存在时返回空对象，不写入数据。
// Readonly<LiveState> 只约束开发时赋值；例失败后读 runFailure，正常结束后通常得到 {}。
// snapshot 的拒绝向调用者传播，?? 只处理缺省值，不吞错误。
async function live(harness: Harness, conversation: Conversation): Promise<Readonly<LiveState>> {
	// LiveDoc 决定文档类型，conversation.id 决定读取哪个会话，context 提供调用上下文。
	return (await harness.snapshot(LiveDoc, conversation.id, context)) ?? {};
}

/** A response that fails for good once `gate` opens; `reached` resolves when it was requested. */
// 无参数夹具：返回一条可控 faux 响应以及 gate/reached 两个 Promise 闸门。
// step 被请求时通知 reached，等 gate 放行才返回永久错误消息；本函数本身不发请求。
// 例等待 reached.promise、排入 followUp、再 gate.resolve()，便可固定失败与排队先后关系。
function failingOnce() {
	// gate 由测试放行；reached 由响应回调通知请求已到达。deferred 的默认泛型是 void。
	const gate = deferred();
	const reached = deferred();
	// FauxResponseStep 是测试供应商回调类型；没有参数表示这条脚本不需要检查请求内容。
	const step: FauxResponseStep = async () => {
		// 先让测试知道请求已进入，之后阻塞本条响应。
		reached.resolve();
		// await 让出执行权；只有显式 resolve 后才继续返回消息。
		await gate.promise;
		// 返回 stopReason:error 的助手消息，模拟终止错误，并非在这里 throw。
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" });
	};
	// 属性简写暴露同一闭包对象，供测试精确控制时序。
	return { step, gate, reached };
}

// describe 登记五个异步用例；每例自己关闭 Harness，断言失败或意外拒绝会使该例失败。
describe("pi.live.runFailure", () => {
	// 输入 hi 得到模型错误，再输入 again 得到正常答案；检查失败记录出现、下一轮启动即清除。
	it("records a model error with its text, and a later run clears it", async () => {
		// chatSetup 创建隔离的注册表与 faux 供应商，不使用真实模型认证。
		const setup = chatSetup();
		// 首请求消费错误消息，下一请求消费文本 fine；每个用例的脚本互不共享。
		setup.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" }),
			fauxAssistantMessage([fauxText("fine")]),
		]);
		// 在内存存储上打开 Harness，根会话初次创建即配置 faux/faux-1。
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		// submit 负责接纳输入，返回的句柄还要 wait 才能知道它是否得到回答。
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		// 等待输入结算；失败作为 unanswered 数据返回，不是模型错误异常逃出 wait。
		const settled = await submission.wait(context);
		// 同时核对输入侧的状态、原因和错误文本，toMatchObject 允许附加字段。
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "Invalid request" });
		// 界面读取的失败记录还包括运行任务、输入 ID 与历史首条入口。
		const failure = (await live(harness, root)).runFailure;
		expect(failure).toEqual({
			// 非确定性 ID 只约束为数字；inputs 则必须准确对应本次输入。
			taskId: expect.any(Number),
			inputs: [submission.id],
			reason: "model_error",
			detail: "Invalid request",
			first: expect.any(Number),
			// satisfies 检查预期形状可赋给 RunFailure，不转换对象，也不增加运行校验。
		} satisfies RunFailure);
		// 再次接纳输入会在新的提交中启动运行，清掉上次失败。
		const next = await root.submit({ type: "input", content: "again" }, context);
		// The commit that starts the next run removes it.
		// 即使尚未等待第二条回答，失败状态也应已消失。
		expect((await live(harness, root)).runFailure).toBeUndefined();
		// 随后确认新运行回答成功，结束后没有残留 live 字段。
		expect((await next.wait(context)).status).toBe("done");
		expect(await live(harness, root)).toEqual({});
		// 关闭调度器与 Session，释放该用例资源。
		await harness.close(context);
	});

	// 将模型切到未注册的 faux/gone，检查输入结算不带 detail，而展示用失败状态写明缺哪个模型。
	it("records a missing model with which one", async () => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		// configure 持久化会话的模型选择；此时不要求模型已经存在于模型注册表。
		await root.configure({ model: { provider: "faux", modelId: "gone" } }, context);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const settled = await submission.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "no_model" });
		// 没有可用模型时仍以 unanswered/no_model 结算；原 API 不把诊断文字加入 settlement。
		// The settlement is unchanged: no detail.
		expect(settled).not.toHaveProperty("detail");
		// 可选字段诊断只出现在 pi.live.runFailure，供渲染器显示。
		expect((await live(harness, root)).runFailure).toMatchObject({
			inputs: [submission.id],
			reason: "no_model",
			detail: "Model faux/gone is not available",
		});
		await harness.close(context);
	});

	// 使用一直等待取消的响应，等请求到达后主动 abort；应记录同一任务与输入的 aborted 失败。
	it("records an abort", async () => {
		const setup = chatSetup();
		// unanswered 的 step 等待 AbortSignal，reached 只通知请求开始，不代表有答案。
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		// 请求进入后才取消，保证测试的是运行中止而非尚未开始的输入。
		await busy.reached;
		// ! 是非空断言，只帮助 TypeScript；此处依据已进入请求的夹具保证 run 存在。
		const taskId = (await live(harness, root)).run!.taskId;
		// abort 通知取消并等待相关状态提交；读取应看到失败而非仍运行。
		await root.abort(context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect((await live(harness, root)).runFailure).toEqual({
			taskId,
			inputs: [submission.id],
			reason: "aborted",
			first: expect.any(Number),
		});
		await harness.close(context);
	});

	// 工具被 gate 挡住时 reset，再排 followUp；结束旧运行的同一提交启动新运行时，保留旧 reset 诊断。
	it("records a reset that cut the run before an answer, kept by the run its queued input starts", async () => {
		const setup = chatSetup();
		const gate = deferred();
		// started 确认 hold 已经执行，gate 决定什么时候允许它结束。
		const started = deferred();
		// 把 hold 安装进当前扩展注册表；obj({}) 是无声明字段的参数 schema。
		addTool(
			setup.registry,
			defineTool({
				name: "hold",
				description: "Waits",
				parameters: obj({}),
				// 工具没有输入需求，进入时通知 started，然后等待 gate；返回 {} 表示空结果。
				execute: async () => {
					started.resolve();
					await gate.promise;
					return {};
				},
			}),
		);
		// reset 后的第二轮也固定保持忙碌，便于在其回答前检查两份状态并存。
		const second = unanswered();
		setup.faux.setResponses([
			// 首响应要求调用 hold，toolUse 让运行进入工具阶段，下一请求消费 second.step。
			fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" }),
			second.step,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const first = await root.submit({ type: "input", content: "go" }, context);
		// 等工具实际执行后再 reset，避免用计时猜测所处阶段。
		await started.promise;
		// undefined 使用 reset 默认入口；旧运行会按 reset 结算。
		await root.reset(undefined, context);
		// whenBusy:followUp 将 next 放到当前运行之后的队列。
		const followUp = await root.submit({ type: "input", content: "next", whenBusy: "followUp" }, context);
		// 放行旧工具，使旧运行结束并推动待处理输入。
		gate.resolve();
		expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "reset" });
		// 新请求已进入，随后读取的 run 归 followUp，runFailure 仍指旧输入。
		await second.reached;
		const state = await live(harness, root);
		// The follow-up's run started in the commit that ended the first; the failure stays until a later run starts.
		// 可选链避免读不存在字段时报错，若 run 缺失则与预期数组不等使测试失败。
		expect(state.run?.inputs).toEqual([followUp.id]);
		expect(state.runFailure).toMatchObject({ inputs: [first.id], reason: "reset" });
		await root.abort(context);
		expect((await live(harness, root)).runFailure).toMatchObject({ inputs: [followUp.id], reason: "aborted" });
		await harness.close(context);
	});

	// 分别检验 continue 与 keep：前者在同一提交消费排队输入并保留失败，后者空闲时仍保留失败。
	// 标题提到替换，实际本例只比较两策略的保留行为；替换成 aborted 由上一例断言。
	it("keeps the failure while a run continues the queue in the same commit, and replaces it with the next", async () => {
		// as const 保留字符串字面量；satisfies 检查它们属于 AfterFailedRun，实际循环只覆盖这两个策略。
		for (const policy of ["continue", "keep"] as const satisfies readonly AfterFailedRun[]) {
			const setup = chatSetup();
			// setup.settings 是活配置，Harness 读设置时会使用本轮策略。
			setup.settings.afterFailedRun = policy;
			// 用两个闸门确保 second 在 first 失败之前已排队。
			const failing = failingOnce();
			const busy = unanswered();
			setup.faux.setResponses([failing.step, busy.step, fauxAssistantMessage([fauxText("third")])]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			const first = await root.submit({ type: "input", content: "first" }, context);
			// 请求已到达但 gate 未开，第一轮此刻尚未失败。
			await failing.reached.promise;
			const second = await root.submit({ type: "input", content: "second", whenBusy: "followUp" }, context);
			// second 已接纳后才放出错误，消除排队与失败之间的竞争。
			failing.gate.resolve();
			await first.wait(context);
			// continue 必须启动 second 的请求；同时失败状态保留 first 的诊断。
			if (policy === "continue") {
				await busy.reached;
				const state = await live(harness, root);
				expect(state.run?.inputs).toEqual([second.id]);
				expect(state.runFailure).toMatchObject({ inputs: [first.id], reason: "model_error" });
			} else {
				// keep 不启动排队项，调度器可以空闲，但 first 的失败状态仍在。
				await harness.waitForIdle(context);
				expect((await live(harness, root)).runFailure).toMatchObject({ inputs: [first.id] });
			}
			// 两策略每轮独立关闭；continue 分支可能仍有 unanswered 请求，由关闭处理取消。
			await harness.close(context);
		}
	});
});
