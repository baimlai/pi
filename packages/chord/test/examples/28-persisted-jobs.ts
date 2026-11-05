// 文件导读
// 所属：packages/chord/test/examples，Chord v2 示例 28，对应 slice 6b（持久化作业）。
// 演示内容：defineJob 的 persist: { resume } 把每个未结算运行的记录与状态文档存进对象的 store。
// 运行能跨“崩溃”（连续五次则 restart_limit）、干净关闭（写回 stopped，恢复但不计数）以及对象重试；
// abort 会被存储并 join 正在跑的 run；状态变更可以使用 deferred 持久化。
// 上游入口：命令行直接运行；自建临时目录与一个 SQLite 文件，不依赖外部服务。
// 下游调用：defineState（run 状态文档）、defineJob、self.job（JobHandle 的 start/abort/running）、store/host。
// 写入 <tmp>/chord-example-28-*/session.sqlite；运行结束删除。
// 失败行为：任何 await 拒绝都会让脚本非零退出；run 抛错/被 abort/host 关闭导致的结算由 finish 与 abort 返回值体现。
// 能力清单（按演示机制列出，本文件没有导出）：
// - ImportState：持久化 singleton 状态文档，每 16 条 delta 换一次 base。
// - ImportJob：持久化作业；args {path}，result {count}，state 为 ImportState，resume 规则为 rerun。
// - Notes 契约：start(path) 返回运行 id；abort(id) 返回 "marked"/"terminal"。
// - behaviour：控制当前进程的 run 悬挂还是完成；jobs：模块级句柄，用于读取 running 列表。
// - facet：声明作业实现 run/finish，并把 start/abort 暴露成方法。
// - process()：在数据库文件上开 store 与 host，加载 facet。
// - 主流程：启动后“崩溃” → 重开（计数并重跑）→ 干净关闭后重开（恢复不计数）→ abort 已结算/未结算的运行。
// 典型运行顺序：见下面四个编号段落；每段之间用 settle() 等 150ms 让 deferred 状态和后台结算跑完。
// 示例（真实签名）：
//   const handle = self.job(ImportJob, { run, finish });
//   const run = await handle.start({ path: "inbox" }, ctx);   // Run，run.id 是字符串
//   const result: "marked" | "terminal" = await handle.abort(run.id, ctx);
// 阅读顺序：先看 ImportState/ImportJob 的持久化约束，再看 run/finish 与 deferred 状态，最后逐段读四个场景。
// 前置条件：Node 支持 --experimental-strip-types 与 node:sqlite。在 packages/chord 下运行：
//   node --conditions=source --experimental-strip-types test/examples/28-persisted-jobs.ts
// 预期输出（本机实测；abort 与 finish 两行的先后依赖微任务调度，可能互换）：
// 1. start, then crash
//   run inbox: from done = 0
// 2. reopen: the run is counted and rerun
//   run inbox: from done = 1
// 3. clean close, reopen: resumed, uncounted
//   run inbox: from done = 2
//   finish: done { count: 3 }
//    unsettled runs now: 0
// 4. abort
//   run drafts: from done = 0
//    abort: marked
//   finish: done { count: 1 }
//    once settled: terminal / the first run: terminal
// 相关文档：packages/chord/docs/slice-6b.md（运行记录、resume、deferred、abort）；相关测试：test/jobs/ 的持久化用例。
// Persisted jobs: `persist: { resume }` keeps each unsettled run's record and state document in the object's store.
// A run survives a crash (counted: five in a row end it `restart_limit`), a clean close (written back `stopped`, resumed
// without counting) and its object's retry; `abort` is stored and joins `run`; a state change may be `deferred`.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/28-persisted-jobs.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host } from "../../src/host/index.ts";
import { defineJob, type JobHandle } from "../../src/jobs/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { openStore, type Store, sqliteBackend } from "../../src/store/index.ts";

// 后台上下文：作业与 host 都继承它；每个 run 另有自己的 abort 信号。
const context = BACKGROUND_CONTEXT;

// The run's state: persisted, as a persisted job's must be.
// 持久化作业的 state 必须是 persist: true 的单例文档定义（defineJob 会做运行期检查，不符合直接抛错）。
// checkpointWhen 规则与普通持久化文档相同：每 16 条 delta 存一次新 base。
const ImportState = defineState("notes.import.state", {
	schema: obj({ done: int() }),
	version: 1,
	initial: () => ({ done: 0 }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 16,
});

// 声明持久化作业：args/result 都是 JSON 对象 schema；state 给出每个 run 独享的状态文档形状。
// 类型参数由 schema 推断，JobDefinition<{path:string},{count:number},{done:number}>。
// persist.resume = "rerun"：崩溃或被停机切断后再次执行 run（因此 run 必须幂等，只重复上次状态变更之后的工作）。
// 持久化还要求 result 可 JSON 存储（不能有 bytes()），并且作业属于有 store 的稳定身份对象。
const ImportJob = defineJob("notes.import", {
	version: 1,
	args: obj({ path: str() }),
	result: obj({ count: int() }),
	// 持久化作业的状态文档也必须是 persist: true；defineJob 的 checkPersistence 会校验。
	state: ImportState,
	// After a crash or a stop, `run` runs again: it must be idempotent (only work since the last state change repeats).
	persist: { resume: "rerun" },
});

// 契约：start(path) 同步启动一个 run 并返回其 id；abort(id) 返回 "marked" 或 "terminal"。
// 两个方法的结果 schema 都是 str()，但方法结果不做运行期校验，仅用于类型。
const Notes = local("notes.store", {
	version: 1,
	params: {},
	members: { start: method(str(), str()), abort: method(str(), str()) },
});

/** How the current process's `run` behaves: hang (to be cut off) or finish. */
// 模块级开关：run 读到 "hang" 时会悬挂，读到 "finish" 时正常返回。
// 这是示例模拟“长任务”的手段；真实作业不应依赖模块级状态（多对象会互相影响）。
let behaviour: "hang" | "finish" = "hang";
// 模块级作业句柄，主流程用它读 running 列表；类型参数与 ImportJob 的 args/result/state 对应。
// 激活前为 undefined，因此类型带 | undefined；真实应用应通过对象成员/方法暴露这些信息。
let jobs: JobHandle<{ path: string }, { count: number }, { done: number }> | undefined;

const facet = defineFacet((host) => {
	host.serve(Notes, (_, self) => {
		// self.job 声明作业并返回句柄；同名作业只能声明一次。实现分两部分：
		// run 在事务之外执行工作；finish 在结算时的一个事务里记录结果。
		const imports = self.job(ImportJob, {
			run: async ({ path }, ctx) => {
				// run 的 ctx 是 JobCtx：普通 Ctx 加上 jobId 和（有状态文档时的）state。
				// ctx.state.value 同步读取本次运行的状态；重跑时它来自 store（本例分别从 0/1/2 开始）。
				console.log(`  run ${path}: from done = ${ctx.state.value.done}`);
				// Progress, deferred: published at once, stored within 100 ms (or with the next immediate change).
				// change 在对象线上开一个只草拟该状态文档的事务；选项 persistence 选择落盘时机。
				// deferred：先在内存收养并发布，最迟 withinMs（这里 100ms）写入；若期间有下一个 immediate 变更/
				// 运行结算/对象关闭，则随之写入。这样高频进度不必每步都等待 store。
				await ctx.state.change(
					(draft) => {
						draft.done += 1;
					},
					ctx,
					{ persistence: { kind: "deferred", withinMs: 100 } },
				);
				// 模拟长任务：等待本次运行的 abort 信号。`?.` 在 abortSignal 为 undefined 时不注册监听，
				// Promise 永不 resolve（真的悬挂）；实际 run 上下文总有信号，abort/host.close/对象结束都会触发。
				// resolve 作为事件监听器接收 Event 参数，Promise 的 resolve 会忽略它。
				if (behaviour === "hang")
					await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
				// 返回结果；若在 abort 信号之后 run 仍正常返回，本次运行按 done 结算（abort 标记本身已持久化）。
				return { count: ctx.state.value.done };
			},
			finish: async (outcome) => {
				// outcome 是可辨识联合：kind === "done" 时有 result，否则有 error。
				// 三元表达式据此选择打印内容；error.kind 是 threw/aborted/restart_limit 之一。
				// finish 的返回值被忽略；它在一个事务里运行，成功后该运行记录被删除。
				console.log(`  finish: ${outcome.kind}`, outcome.kind === "done" ? outcome.result : outcome.error.kind);
			},
		});
		// 把句柄存到模块变量，供主流程读取 running；激活后一定已赋值。
		jobs = imports;
		return {
			// start 是异步的：先提交运行记录（与对象线事务），提交成功后才返回 Run。
			// 表达式体返回 run.id（uuid 字符串），与契约的 str() 结果对应。
			// 这里没有传 StartOptions.key，因此每次调用都创建新运行。
			start: async (path, ctx) => (await imports.start({ path }, ctx)).id,
			// abort 返回 Promise<"marked" | "terminal">，直接作为方法结果；它还会等 run 结算后 resolve。
			// "terminal" 表示没有未结算的同 id 运行（已结算、未知或对象已结束）。
			abort: (id, ctx) => imports.abort(id, ctx),
		};
	});
});

/** A process: a store over the file and a host serving `Notes`. */
// 用途：模拟一个“进程”：用给定 SQLite 文件打开 store，再建 host 并加载 facet。
// 输入：path（数据库文件）；输出：{ store, host }，两者都由调用方负责关闭。
// 副作用：打开数据库；load 会激活空参数对象并恢复未结算的持久化运行（重跑/恢复在后台发生）。
// 错误路径：打开或加载失败向上传播；加载期间对象激活失败不会让 load 拒绝，而是写入报告。
// 主要流程：openStore(sqliteBackend(openNodeSqliteDatabase(path))) → createHost → load → 返回。
// 示例（真实签名）：const { store, host } = await process("/tmp/session.sqlite");
// closeTimeout: 100 是 host 关闭时等待 native close 与结束中对象调用收尾的毫秒数；超时只报告错误，不强杀插件代码。
async function process(path: string): Promise<{ store: Store; host: Host }> {
	// store 打开同一文件：上一次“进程”的提交与运行记录都在这里。
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	// onError 打印后台错误的 code（例如运行抛错被上报）；closeTimeout 缩短关闭等待，避免悬挂 run 拖住演示。
	const host = createHost({
		store,
		onError: (error) => console.log("  onError:", error.kind),
		closeTimeout: 100,
	});
	// 加载插件：host.load 会启动恢复流程——未结算的持久化运行按 resume 规则重跑/放弃。
	await host.load([{ name: "@example/notes", facet }], context);
	return { store, host };
}

// 等待 150ms 的辅助函数：大于 deferred 的 100ms，让状态写入落盘，也给后台结算留出时间。
// 返回 Promise<unknown>；箭头函数没有参数，调用处直接 settle()。
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const directory = await mkdtemp(join(tmpdir(), "chord-example-28-"));
const path = join(directory, "session.sqlite");

// 1. Start a run, then crash: the store closes under the live host.
// 场景 1：启动 run 后“崩溃”。这里的模拟方式是关闭 store 而不关闭 host：真正崩溃会直接杀掉进程，
// 但持久化数据相同——运行记录仍是 unsettled，状态在 150ms 内已通过 deferred 规则落盘。
console.log("1. start, then crash");
// 解构 let：store/host 稍后会被重新赋值，所以用 let 而不是 const。
// 注意 `let { store, host } = ...` 是声明并解构；后面重新赋值必须写成 `({ store, host } = ...)`，加括号避免被当成块语句。
let { store, host } = await process(path);
// host.get 取 Notes 引用；start 返回运行 id（字符串）。第一个 run 从 done=0 开始，执行 +1 后悬挂。
const id = await (await host.get(Notes, {}, context)).start("inbox", context);
// 等待 150ms：deferred 状态变更在 100ms 内写入 store，run 也进入悬挂。
await settle();
// 关闭 store（模拟崩溃点）：后端关闭；仍活着的 host 不再被使用，脚本继续模拟下一个进程。
await store.close(context);

// 2. The next process counts the crash and reruns it (its state as stored: the deferred change was stored in time).
// 场景 2：同一个文件重新打开。load 发现未结算的运行记录，按 resume: "rerun" 重跑；
// 由于没有 stopped 标记，这被算作一次崩溃重启（连续 5 次才 restart_limit）。
// 状态从 store 恢复到 done=1，run 再 +1 到 2 后继续悬挂（behaviour 仍为 "hang"）。
console.log("2. reopen: the run is counted and rerun");
({ store, host } = await process(path));
await settle();

// 3. A clean close writes the run back `stopped`: the next process resumes it without counting.
// 场景 3：干净关闭。host.close 会切断悬挂运行并在 store 里写回 stopped（不计重启次数），
// 随后再关 store；behaviour 改为 "finish"，所以下一个进程恢复运行时不再悬挂：done 从 2 增加到 3 并正常完成。
console.log("3. clean close, reopen: resumed, uncounted");
// closeTimeout:100 是收尾宽限（超时只报告）；悬挂的 run 在尝试被切断时收到 abort 信号，持久化记录写为 stopped。
await host.close(context);
await store.close(context);
// 切换行为后重开：恢复（不是重跑计数）该运行，finish 打印 done { count: 3 }。
behaviour = "finish";
({ store, host } = await process(path));
await settle();
// jobs 在激活时被赋值；running.value 是当前未结算运行数组，正常完成后长度为 0。
// 这里用可选链是因为 jobs 的静态类型含 undefined；运行期此时必然已赋值。
console.log("   unsettled runs now:", jobs?.running.value.length);

// 4. A stored abort: marked, joined.
// 场景 4：存储式 abort。behaviour 切回 "hang"；新运行 drafts 从 done=0 开始，+1 后悬挂。
console.log("4. abort");
behaviour = "hang";
// 重新取引用：上一次 host 已关闭，这里是新对象的引用。
const notes = await host.get(Notes, {}, context);
// 第二次运行有独立的运行状态文档（新运行 = 新状态文档），因此从 0 开始。
const second = await notes.start("drafts", context);
await settle();
// abort 先持久化“已中止”标记并触发 run 的 abort 信号，然后 join 当前 invocation 结束后才 resolve。
// run 的信号处理让悬挂的 Promise resolve，run 返回 {count:1}；因此本次结算为 done，abort 得到 "marked"。
console.log("   abort:", await notes.abort(second, context));
await settle();
// 再次 abort 同一 id：运行已结算 → "terminal"；abort 第一个 id：它在场景 3 已完成 → 也是 "terminal"。
// console.log 的多个参数按从左到右求值，两个 await 依次完成。
console.log("   once settled:", await notes.abort(second, context), "/ the first run:", await notes.abort(id, context));

// 收尾：先关 host（排空提交、结束对象），再关 store（等待提交并关闭后端），最后删除临时目录。
// 注意这里没有 try/finally：中间失败会留下临时目录，示例优先展示主流程。
await host.close(context);
await store.close(context);
await rm(directory, { recursive: true, force: true });
