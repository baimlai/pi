// 文件导读
// 所属：packages/durable/test/examples 的 23-child-tasks.ts，Durable 示例系列第 23 个，演示“父子任务与任务图”。
// 演示内容：Checkout 任务在 pay 阶段创建四个 Payment 子任务，然后以 waiting 提交等待全部付款；
// decide 阶段读取每个子任务的结果并决定整单成败。示例覆盖四种情形：过期卡失败与 failFast 级联、
// 用户取消时的级联退款、任务图快照、以及付款进行中关闭进程后重开继续。
// 上游入口：node 直接运行本文件；使用临时目录中的 sqlite 存储，可重开，无网络与 API key。
// 下游依赖：Durable 的 Harness/defineTask/defineExtension/createTask/waitForTask/abortTask/watchTaskGraph，Node sqlite 存储。
// 能力清单：Payment 与 Checkout 两个任务；charged 假银行集合；sleepUntil 持久睡眠；outcomes 汇合；
// printGraph 递归打印；resume 启动调度；重开继续 pending 任务。
// 典型顺序：定义任务 -> 安装扩展 -> 打开 sqlite -> 运行失败单 -> 运行取消单并打印任务图 ->
// 运行中途关闭并重开 -> 等待结果 -> 清理。
// 前置条件：无 API key；包含 100ms 持久睡眠与 20ms 真实等待，脚本约运行一秒。
// 预期输出：三组场景标题、付款结果列表、任务树、退款与中止日志、三次 checkout 结果。
// 阅读顺序：先看 Payment 的 charge/confirm 两阶段与 abort，再看 Checkout 的 waiting 提交格式，
// 然后看 printGraph 的所有者边遍历，最后看三种运行场景。
// A task that owns child tasks: a checkout charges four payments at once and waits for them.
// The task graph view prints the checkout's tree while its payments run.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/23-child-tasks.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	type TaskGraph,
	type TaskGraphNode,
	type TaskId,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

// 共享操作上下文；提交、等待、任务图 watch 与中止都沿用它。
const context = BACKGROUND_CONTEXT;

// A fake bank: it declines an expired card at once, and confirms other charges after a moment.
// 假银行的已扣款集合。它是进程内普通 Set，不是持久状态；重启后为空，因此退款只会记录实际扣过的卡。
const charged = new Set<string>();

// Payment 的输入、结果与状态类型。输入只有卡号；结果回报卡号；状态是 charge/confirm 两个阶段。
type PaymentInput = { card: string };
type PaymentResult = { card: string };
type PaymentState = { phase: "charge" } | { phase: "confirm" };
// 付款任务。三个泛型依次是持久输入、持久状态、最终结果；阶段函数与 abort 都必须以提交结束。
// 示例：创建 { card: "visa-1" } 的任务，100ms 后完成并返回 { card: "visa-1" }。
const Payment = defineTask<PaymentInput, PaymentState, PaymentResult>({
	name: "example.payment",
	version: 1,
	// 新付款从 charge 阶段开始。
	initial: () => ({ phase: "charge" }),
	phases: {
		// charge 阶段。输入：task.input.card；输出：通过提交失败或进入 confirm。
		// 副作用：过期卡直接失败；其他卡加入假银行集合并睡眠。错误：拒绝用 failed 结果表达，不抛异常。
		charge: async (task, runtime, taskContext) => {
			const card = task.input.card;
			// 卡号以 expired 开头即拒绝；这是示例约定，startsWith 在运行时判断字符串。
			if (card.startsWith("expired")) {
				// 失败原因对象；message 会出现在父任务的 outcomes 与最终 waitForTask 结果里。
				const error = { message: `${card} declined` };
				// 提交终止失败；return 让本阶段不再执行后续扣款。
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error } }), taskContext);
				return;
			}
			// 记录扣款，供 abort 时判断是否需要退款。
			charged.add(card);
			// The bank confirms after a moment: wait for it without holding an invocation.
			// 持久睡眠到当前时间加 100ms，并把检查点设为 confirm 阶段；等待期间不占用执行调用。
			// 重启后由调度器按到期时间继续，而不是重新扣款。
			await runtime.sleepUntil(runtime.now() + 100, { phase: "confirm" }, taskContext);
		},
		// confirm 阶段。输入：持久状态与 task.input；输出：completed 结果。副作用：无，仅提交。
		confirm: async (task, runtime, taskContext) => {
			const card = task.input.card;
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { card } } }),
				taskContext,
			);
		},
	},
	// Each payment undoes its own effect when aborted.
	// 付款被中止时执行：从假银行撤回扣款并提交 aborted。输入：任务与运行时；输出：终止提交。
	// 副作用：可能修改 charged 并打印日志；错误：无。
	abort: async (task, runtime, taskContext) => {
		// delete 返回是否真的删除；false 表示未扣过款，无需称为退款。
		const refunded = charged.delete(task.input.card);
		// 三元只追加 refunded 后缀；展示用，不影响状态。
		console.log(`  payment ${task.input.card} aborted${refunded ? ", refunded" : ""}`);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});

// The checkout creates its payments as child tasks and waits for all of them.
// With `failFast`, the first payment that fails aborts the others; the checkout
// itself is not aborted and decides its outcome once every payment is done.
// Checkout 的持久状态。decide 阶段携带子任务 ID 列表；TaskId<PaymentResult> 把“该任务的最终结果是 PaymentResult”
// 编码进类型，runtime.outcomes 才能据此推导结果类型。
type CheckoutState = { phase: "pay" } | { phase: "decide"; payments: TaskId<PaymentResult>[] };
// 结账任务。输入是卡号数组，结果字符串，状态两阶段。
// 流程：pay 创建全部付款并以 waiting 提交等待 -> decide 读取 outcomes 并提交整单结果。
const Checkout = defineTask<{ cards: string[] }, CheckoutState, string>({
	name: "example.checkout",
	version: 1,
	// 新结账从 pay 阶段开始。
	initial: () => ({ phase: "pay" }),
	phases: {
		// pay 阶段。输入：task.input.cards；输出：waiting 提交，等所有子任务结束后进入 decide。
		// 副作用：创建四个子任务；错误：创建任务失败会让本次提交失败。
		pay: async (task, runtime, taskContext) => {
			await runtime.commit(async (tx) => {
				// 显式标注元素类型，确保 push 的 ID 与 waiting 的 on 列表类型一致。
				const payments: TaskId<PaymentResult>[] = [];
				for (const card of task.input.cards) {
					// 在事务里创建子任务，拥有者是当前 checkout；等待 await 取得持久任务 ID 后再 push。
					payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
				}
				// waiting 提交同时做三件事：保存 decide 检查点、声明等待的任务、指定汇合策略。
				// failFast 表示任一子任务失败就中止其余子任务；checkout 自己等全部结束后再决定结果。
				return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
			}, taskContext);
		},
		// decide 阶段。输入：检查点中的 payments；输出：completed 或 failed 终止提交。
		// 副作用：打印各子任务状态；错误：outcomes 读取失败会让阶段失败。
		decide: async (task, runtime, taskContext) => {
			// 按 ID 读取子任务结果；返回数组与输入顺序对应，元素是带 status 的联合，completed 分支才有 result。
			const outcomes = await runtime.outcomes(task.state.checkpoint.payments, taskContext);
			// 只打印状态名，便于观察 failed/aborted/completed 的组合。
			console.log(`  payments: ${outcomes.map((outcome) => outcome.status).join(", ")}`);
			// every 要求全部完成；空数组会返回 true，但本例总是四个付款。下面的三元据此提交 completed 或 failed。
			const paid = outcomes.every((outcome) => outcome.status === "completed");
			await runtime.commit(
				() =>
					paid
						? { status: "terminal", outcome: { status: "completed", result: "order placed" } }
						: { status: "terminal", outcome: { status: "failed", error: { message: "payment failed" } } },
				taskContext,
			);
		},
	},
	// Runs only after every payment is done, so the refunds have already happened.
	// checkout 的 abort 在它拥有的所有付款结束后才运行，因此退款已经先完成；这里只提交 aborted。
	abort: async (_task, runtime, taskContext) => {
		console.log("  checkout aborted");
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});

// 创建注册表并安装两个任务定义；扩展只是打包，任务在 createTask 时才实例化。
const registry = createRegistry();
registry.install(defineExtension({ name: "checkout", tasks: [Payment, Checkout] }));
// 临时目录与 sqlite 路径；重开使用同一文件，因此第三个场景能继续未完成的付款。
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
const databasePath = join(directory, "session.sqlite");
// 打开宿主。输入：无；输出：Harness。副作用：打开同一 sqlite 文件；每次调用 createModels 新建模型目录（本例不调用模型）。
const open = async () =>
	Harness.open(await openNodeSqliteStorage(databasePath), { models: createModels(), registry }, context);
/** Print the live tasks as a tree along their owner edges. */
// 把任务图打印成树。输入：watchTaskGraph 的值；输出：无。
// 主流程：取所有节点 -> 递归打印子节点 -> 从没有 owner 的根节点开始。
// 示例：checkout 节点下缩进打印四个 example.payment 节点。
function printGraph(graph: TaskGraph): void {
	// graph.tasks 是任务 ID 到节点的记录；Object.values 得到节点数组。
	const nodes = Object.values(graph.tasks);
	// 递归辅助。输入：节点与深度；输出：无；副作用：console.log 一行。
	// 子节点通过 owner 字段等于当前节点 ID 来查找。
	const print = (node: TaskGraphNode, depth: number): void => {
		// 节点状态是以 status 区分的联合；waiting 分支带 on 数组，其他分支没有。
		const state = node.state;
		// 条件表达式在两个分支都得到 string；status 检查把 state 收窄到 waiting 后才能读 on。
		const status = state.status === "waiting" ? `waiting on ${state.on.join(", ")}` : state.status;
		// repeat 按深度生成缩进；kind 是任务定义名，id 是持久任务 ID。
		console.log(`  ${"  ".repeat(depth)}${node.kind} ${node.id}: ${status}`);
		// 线性扫描找子节点；示例规模很小，没有为树构建索引。
		for (const child of nodes.filter((candidate) => candidate.owner === node.id)) print(child, depth + 1);
	};
	// owner 为 undefined 的是会话拥有的顶层任务；从它们开始递归。
	for (const node of nodes.filter((candidate) => candidate.owner === undefined)) print(node, 0);
}
// 在根会话的事务里创建 checkout 任务。输入：会话与卡号；输出：任务 ID 的 Promise。
// 副作用：提交一次创建；错误：提交失败会抛出。
const checkout = (root: Conversation, cards: string[]) =>
	root.commit((tx) => tx.createTask(Checkout, { cards }, { ownership: { kind: "conversation" } }), context);

// 打开 sqlite 宿主；let 因为第三个场景要整体替换。
let harness = await open();
// 创建（或重开时取回）根会话；这里不配置 agent，因为示例只用任务。
let root = await harness.root(context);

// 场景 1：四张卡中一张过期。waitForTask 会等 checkout 进入终态；failFast 会中止其他付款，
// 最终 checkout 因并非全部 completed 而提交 failed。
console.log("One card is declined:");
// 创建失败单；随后的 waitForTask 也会启动调度器。
let id = await checkout(root, ["visa-1", "expired-2", "visa-3", "visa-4"]);
console.log(`  checkout: ${(await harness.waitForTask(id, context)).state.outcome.status}`);

// 场景 2：先让付款跑起来并打印任务树，再中止 checkout。
console.log("The customer cancels:");
// 创建第二单；下一行显式启动调度器，让子任务真正运行。
id = await checkout(root, ["visa-5", "visa-6", "visa-7", "visa-8"]);
// resume 启动任务调度器；创建任务本身只持久化记录，不会自动让所有阶段立即运行。
harness.resume();
await new Promise((resolve) => setTimeout(resolve, 20));
// 取得任务图的当前快照与后续 watch；20ms 真实等待让付款进入 waiting 的 100ms 睡眠。
const graph = await harness.watchTaskGraph(context);
// 打印快照中的树：checkout 在 waiting，四个 payment 处于 sleeping 状态（charge 阶段的持久睡眠）。
printGraph(graph.value);
// 停止任务图 watch；本例只用一次快照，不需要后续帧。
await graph.stop();
// abortTask 只标记取消并立即返回 marked/terminal；级联中止与退款由调度器完成。
// 紧接着的 waitForTask 才等整个中止过程结束。
await harness.abortTask(id, context);
console.log(`  checkout: ${(await harness.waitForTask(id, context)).state.outcome.status}`);

// 场景 3：创建第三单，等 20ms 后直接关闭 Harness，模拟付款进行中进程退出；再用同一 sqlite 文件重开并取回根会话，等待 waitForTask 恢复未完成的付款。
console.log("The process stops while the payments run, and a new one continues:");
// 创建第三单；随后 20ms 真实等待让任务至少被创建，但可能在确认前就被关闭。
id = await checkout(root, ["visa-9", "visa-10", "visa-11", "visa-12"]);
await new Promise((resolve) => setTimeout(resolve, 20));
await harness.close(context);
harness = await open();
root = await harness.root(context);
console.log(`  checkout: ${(await harness.waitForTask(id, context)).state.outcome.status}`);

await harness.close(context);
// 等待最后一行 checkout 结果后关闭宿主并删除临时目录。
await rm(directory, { recursive: true, force: true });
