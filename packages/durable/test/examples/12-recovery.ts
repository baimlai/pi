// 文件导读
// 所属：packages/durable 的 test/examples 系列第 12 个示例，演示关闭 Harness 后用同一份存储恢复未完成任务。
// 演示内容：Ticker 任务每次打印一个 tick、写入持久 memo，再睡眠 50ms 进入下一个检查点；第一次运行在 tick 2 打印后、
//   下一次检查点保存前关闭 Harness（模拟效果已发生但结果未保存的崩溃）；随后只读打开存储查看 pending 检查点与 memos；
//   第二次打开后 waitForTask 自动恢复任务：tick 2 在检查点上重跑，但 memo 阻止重复打印，最终计数到 5。
// 上游入口：从 packages/durable 目录直接运行；下游调用 openNodeSqliteStorage、Harness.open/resume/close/getTask/waitForTask、
//   Tx.createTask、TaskRuntime.memo/sleepUntil/commit。没有模型请求与网络。
// 能力清单（按演示机制）：
// - openNodeSqliteStorage(path)：打开 SQLite 存储；关闭 Harness 后数据仍在文件中，重启可继续。
// - TaskRuntime.memo(name, candidate)：首写者胜的持久备忘；读取不存在时返回 undefined，写入返回已存在的赢家。
// - TaskRuntime.sleepUntil(until, checkpoint)：提交睡眠与下一检查点后释放调用；时间到后由调度器恢复。
// - TaskRuntime.now()：Harness 时钟（默认 Date.now），用于计算睡眠截止时间。
// - Harness.resume()：启用任务调度；waitForTask 等请求进度的调用也会隐式启用。
// - Harness.getTask(id)：只读任务记录，不运行任务；用于检查恢复前的状态。
// 典型运行顺序：建临时目录 → 定义 Ticker → open → root 建任务 → resume → 等 tick 2 → close → 只读 open/getTask/close →
//   再 open → waitForTask → 打印结果 → close → 删除临时目录。
// 示例（真实运行命令）：
//   cd packages/durable
//   node --conditions=source --experimental-strip-types test/examples/12-recovery.ts
// 实际输出：
//   tick 1
//   tick 2
//   closed; saved checkpoint: { status: 'pending', checkpoint: { phase: 'tick', n: 2 } } memos: { 'printed-1': true, 'printed-2': true }
//   tick 3
//   tick 4
//   tick 5
//   after reopen: { status: 'completed', result: 'counted to 5' }
// 阅读顺序：先看 memo 的“先写备忘再产生效果”顺序，再看 sleepUntil 保存下一检查点，随后看第一次运行的关闭时机，
//   最后看第二次运行为什么从 n=2 重跑却不重复打印。
// Close, reopen, and continue where a task stopped.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/12-recovery.ts
// node:fs/promises 提供 mkdtemp/rm；tmpdir 给出系统临时目录，join 拼接路径。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
// 使用 SQLite 存储时也要用 createRegistry() 注册内置任务，Harness.open 会校验它们齐全。
import { createRegistry, defineExtension, defineTask, Harness } from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

// 不取消任何操作。
const context = BACKGROUND_CONTEXT;

// Everything a task needs to continue is in storage, so a new Harness over the
// same storage picks up where the last one stopped. This example keeps its
// storage in a SQLite file so it survives closing.
// mkdtemp 创建唯一临时目录；示例结束时删除。数据库文件放在这个目录里。
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
const databasePath = join(directory, "session.sqlite");

// reachedTick 初始为空函数；第一次运行期间被替换成“看到 n===2 就 resolve”的闭包，作为测试信号。
// 参数名 _n 前缀下划线表示当前实现不使用它；类型注解 : (n: number) => void 必须在 let 上给出。
let reachedTick = (_n: number): void => {};
// Ticker 的输入 {to:number}、检查点 {phase:"tick"; n:number}、结果 string。
// 只有一个 phase，因此 phases 只需 tick；abort 仍是必填字段。
const Ticker = defineTask<{ to: number }, { phase: "tick"; n: number }, string>({
	name: "example.ticker",
	version: 1,
	initial: () => ({ phase: "tick", n: 1 }),
	phases: {
		// tick 阶段：读取当前 n，先确保 memo 记录“已打印”，再打印并进入下一状态。
		tick: async (task, runtime, taskContext) => {
			const n = task.state.checkpoint.n;
			// Save the intent before the effect. A memo keeps the first value
			// written under its name, so if the process dies after printing but
			// before the next checkpoint is saved, the rerun sees the memo and
			// does not print the same tick twice.
			// 单参数 memo(name) 是读取：没有该 key 时返回 undefined，不会创建。
			// 双参数 memo(name, candidate) 是写入：若 key 已存在则保留旧值并返回赢家，保证首写胜。
			if ((await runtime.memo(`printed-${n}`, taskContext)) === undefined) {
				// 先持久化备忘，再产生外部可见效果（打印）；崩溃后重跑能看到 true。
				await runtime.memo(`printed-${n}`, true, taskContext);
				console.log(`tick ${n}`);
			}
			// 通知示例的测试钩子；它不持久化，重启后不会保留。
			reachedTick(n);
			// Save the outcome: the final result, or the next tick after a short
			// sleep. The sleep is stored with the checkpoint, so the task holds no
			// invocation meanwhile, and a Harness opened later continues it once
			// its time has come.
			// 到达输入上限：提交终态结果并显式 return，之后不再调用 sleepUntil。
			if (n === task.input.to) {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: `counted to ${n}` } }),
					taskContext,
				);
				return;
			}
			// 未到上限：提交“睡到 now+50ms、下一检查点 n+1”；Promise 只表示睡眠已落库，不表示时间已到。
			await runtime.sleepUntil(runtime.now() + 50, { phase: "tick", n: n + 1 }, taskContext);
		},
	},
	// abort 必须提交终态；本示例没有触发中止。
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});
const registry = createRegistry();
registry.install(defineExtension({ name: "ticker", tasks: [Ticker] }));
// open 是 async 闭包：输入无，输出 Harness；副作用是打开/创建 SQLite 数据库文件与连接。
// 每次调用都新建 Storage 与 Harness；同一路径的存储共享持久记录。打开或文件系统错误会拒绝。
// 示例：const harness = await open(); 之后 harness.close(context) 会关闭底层存储。
const open = async () =>
	Harness.open(await openNodeSqliteStorage(databasePath), { models: createModels(), registry }, context);

// First run: start counting to 5, and close the Harness right after tick 2 is
// printed, before its next checkpoint is saved. That is the same situation as
// a crash between the effect and saving its outcome.
// 第一次打开：创建任务；TaskId 的结果类型由 Ticker 的 R 推导，因此后面 getTask/waitForTask 有类型。
const firstRun = await open();
const tickerId = await (await firstRun.root(context)).commit(
	(tx) => tx.createTask(Ticker, { to: 5 }, { ownership: { kind: "conversation" } }),
	context,
);
// 构造一个只在 tick 2 解决的 Promise；resolve 被闭包捕获，任务代码通过 reachedTick 调用它。
// Promise<void> 的泛型表示解决值类型为 void。
const tickTwo = new Promise<void>((resolve) => {
	reachedTick = (n) => {
		if (n === 2) resolve();
	};
});
// resume 启用调度；任务从 pending 开始运行。
firstRun.resume();
// 等到 tick 2 已打印；此时 tick 2 的下一检查点（睡到 tick 3）尚未提交。
await tickTwo;
// 立即关闭：模拟“效果已发生、结果未保存”的崩溃窗口。关闭后记录停在 checkpoint n=2。
await firstRun.close(context);
// 恢复钩子为空，避免第二次运行继续引用已关闭进程里的 Promise。
reachedTick = () => {};

// Read the saved record through a Harness that never resumes, so nothing runs.
// 只读方式：打开同一存储但不 resume，也不调用 waitForTask，因此任务不会运行。
const reader = await open();
// getTask 可能返回 undefined；ID 是刚创建且已知存在的，所以用 ! 断言非空（运行时不做检查）。
const saved = (await reader.getTask(tickerId, context))!;
await reader.close(context);
// state 显示 pending + checkpoint n=2；memos 里已有 printed-1/printed-2，说明两项副作用都已记录。
console.log("closed; saved checkpoint:", saved.state, "memos:", saved.memos);

// Second run: nothing to restart by hand. Waiting for the unfinished task
// enables scheduling and continues it. Tick 2 runs again because its outcome
// was never saved, but its memo says it was already printed.
// 第二次打开：waitForTask 隐式启用调度，从持久检查点 n=2 继续；tick 2 会重跑，但 memo 命中，不再打印。
const secondRun = await open();
const counted = await secondRun.waitForTask(tickerId, context);
// counted.state.outcome 是终态收据；结果为 "counted to 5"。
console.log("after reopen:", counted.state.outcome);
await secondRun.close(context);
// 递归删除临时目录，force 让不存在时也不报错。若前面抛错，这一行不会执行，临时目录会保留。
await rm(directory, { recursive: true, force: true });
