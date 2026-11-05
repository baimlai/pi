// 文件导读
// 所属：packages/durable 的 test/examples 系列第 11 个示例，演示定义并运行一个持久任务（状态机）。
// 演示内容：Payment 任务先在 prepare 阶段保存下一步意图，再在 charge 阶段调用一次假的支付服务并提交终态结果；
//   任务由根会话拥有，通过 waitForTask 才会被调度；示例用一个进程内 Map 模拟可重复调用、按键去重的外部支付服务。
// 上游入口：从 packages/durable 目录直接运行；下游调用 defineTask、defineExtension、createRegistry、Harness.open/root、
//   Tx.createTask、Harness.waitForTask、TaskRuntime.commit。没有模型请求与网络。
// 能力清单（按演示机制）：
// - defineTask<I, S, R>：声明任务；S 是检查点联合，必须含 phase；phases 必须覆盖每个 phase。
// - PhaseHandler(task, runtime, taskContext)：阶段处理器；返回前必须通过 runtime.commit() 提交新检查点或终态，
//   否则任务会被判为 faulted。task 已收窄到当前 phase。
// - runtime.commit(change, context)：在同一提交里重读任务、写文档并替换状态；回调返回 NextTaskState。
// - abort：任务被 abortTask 后运行，必须提交终态。
// - Tx.createTask(task, input, options)：创建任务记录；ownership 必填；绑定会话的 commit 可省略 conversationId。
// - Harness.waitForTask(id, context)：启用调度并等待任务进入终态，返回带类型结果的记录。
// 典型运行顺序：定义任务 → 注册扩展 → open/root → root.commit 创建任务 → waitForTask → 打印 outcome → close。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/11-tasks.ts
// 实际输出：
//   payment outcome: { status: 'completed', result: { receipt: 500 } }
// 阅读顺序：先看注释里的“先保存、再执行、再保存结果”模式与幂等要求，再看 PaymentState 联合与 phases 的映射类型，
//   随后看 prepare/charge 两次 commit，最后看 createTask 的 ownership 与 waitForTask。
// Run a durable task.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/11-tasks.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage } from "../../src/index.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;

// A task is a small state machine. Its state, the checkpoint, is saved after
// every step, so after a crash the next open continues from the last saved
// step. The usual pattern: save what you are about to do, do it, then save
// the result. A crash between doing and saving reruns that step, so the step
// must be safe to repeat; here the fake payment service ignores a repeated key.
// payments 模拟外部支付服务：key -> 金额（分）。进程内 Map，重启后丢失，仅用于演示。
const payments = new Map<string, number>();
// 检查点的可辨识联合：phase 字段用于收窄。prepare 无额外数据；charge 带幂等键 key。
type PaymentState = { phase: "prepare" } | { phase: "charge"; key: string };
// 泛型依次为输入 I={amount:number}、检查点 S=PaymentState、结果 R={receipt:number}、钩子 H 省略。
// defineTask 只返回 {definition} 包装，不做运行时校验；name/version 用于持久化匹配。
const Payment = defineTask<{ amount: number }, PaymentState, { receipt: number }>({
	name: "example.payment",
	version: 1,
	// 新任务的第一个检查点。
	initial: () => ({ phase: "prepare" }),
	// One handler per phase. Each must save progress through runtime.commit():
	// its callback returns the next checkpoint or the final outcome, and that
	// state is saved in the same commit as everything else the callback wrote.
	// phases 是映射类型：S["phase"] 的每个字面量都必须是键，漏写会编译报错；处理器拿到的 task 已收窄。
	phases: {
		// prepare 阶段：只保存“接下来要做 charge”的意图，不执行外部副作用。
		// commit 回调返回 {status:"running", checkpoint:...}；提交成功后 Promise 才解决。
		prepare: async (task, runtime, taskContext) => {
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "charge", key: `payment-${task.id}` } }),
				taskContext,
			);
		},
		// charge 阶段：task.state 被收窄为 running，checkpoint 是 charge 检查点；key 来自上一步的持久状态。
		charge: async (task, runtime, taskContext) => {
			const key = task.state.checkpoint.key;
			// 幂等的外部副作用：同一个 key 只扣一次款；崩溃后重跑会复用已记录的金额。
			if (!payments.has(key)) payments.set(key, task.input.amount * 100);
			// has/set 之后 get 一定成功；! 是非空断言，仅用于消除 undefined，运行时不做检查。
			const receipt = payments.get(key)!;
			// 提交终态与结果；若没有存活的普通子任务，记录直接变为 terminal。
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { receipt } } }),
				taskContext,
			);
		},
	},
	// Runs instead of the phases after harness.abortTask(); it decides the outcome.
	// abort 处理器必须提交终态；这里不退款、不产生结果，只记录 aborted。
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});

// Extensions bring task code; the Harness finds it by name in the registry.
// Nothing runs until resume() or a call that waits for progress, such as
// waitForTask().
// 任务定义装在扩展的 tasks 数组里；Harness 按持久化的 name 在阶段快照中查找可执行代码。
const registry = createRegistry();
registry.install(defineExtension({ name: "payments", tasks: [Payment] }));
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);
// Every task names its owner. This one belongs to the conversation; a task can
// also own child tasks and wait for them (23-child-tasks.ts).
// root.commit 绑定 root，因此省略 conversationId 时任务归该会话；ownership 仍必须显式给出。
// 创建任务只写 pending 记录，不立即执行；返回的 TaskId 编码结果类型 R。
const paymentId = await root.commit(
	(tx) => tx.createTask(Payment, { amount: 5 }, { ownership: { kind: "conversation" } }),
	context,
);
// The finished task record is the durable receipt; waitForTask() knows its result type.
// waitForTask 会启用调度并等待终态；返回值 state.outcome 按 R 推导为 completed/failed 等联合。
const paid = await harness.waitForTask(paymentId, context);
// 金额 5 美元按 *100 记为 500 分；receipt 来自假支付服务。
console.log("payment outcome:", paid.state.outcome);

// 关闭 Harness；本示例已等到终态。若关闭时仍有任务在运行，close 会等待调用结束并把它们写回 pending，
// 重新打开后从检查点恢复，且不计一次重启。
await harness.close(context);
