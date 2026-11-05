// A worker crash (slice 10): workers never restart by themselves. A crashed worker's address stays failed, its
// holders see `failed` with the error, and nothing forks until the app retries (a Retry button) or a rollout ships new
// code. Here: a session crashes, stays failed for a while, then Retry brings it back.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/42-worker-crash/main.ts
// 文件导读
// 所属：packages/chord/test/examples/42-worker-crash，Chord slice 10 的 workers 示例，主题是 worker 崩溃后的
//   失败状态与显式重试。
// 演示什么：workers 组件不会自动重启崩溃的进程（避免崩溃循环）。崩溃后：地址状态变为 failed，持有者引用的
//   state 也是 failed 且仍停留在该地址的路径上；一个地址不会因为重试之外的原因再次 fork。调用 workers.retry
//   （真实应用里是 Retry 按钮或 rollout）清除失败，同一个引用会重新绑定到新进程。
// 上游/下游：由下一行命令启动；上游是 Node 与 ./plugins/sessions 的契约；下游调用 createPlugins、createHost、
//   createWorkers，子进程入口 ./worker.ts；崩溃由插件方法 crash 触发。脚本只打印，不写文件、不联网。错误经
//   workers 的 onError 打印 kind；未捕获异常让进程非零退出。
// 能力清单（按演示步骤）：
// - sleep：轮询等待辅助。
// - createPlugins/createHost/createWorkers：与 41 相同的组件装配；本示例不设置 idleMs，使用默认 5 分钟。
// - server.hold：同步取得引用（不等待 live），用 state 观察加载/失败。
// - session.crash：远程方法调用，让 worker 进程退出。
// - workers.state：读取某地址的公开状态与错误消息。
// - workers.retry：清除失败并重新启动被持有的地址。
// 典型运行顺序：装配 -> load -> hold S1 -> 等 live -> 调 crash -> 等 failed -> 观察 1 秒后仍 failed ->
//   retry -> 等 live -> release -> 关闭。
// 预期输出（示例，pid 每次不同；前两条 reported 来自 onError，顺序稳定）：
//   1. S1 runs in process ...
//      reported: worker_exited
//      reported: worker_failed
//   2. crashed: worker exited (code 13)
//   3. a second later: failed, the holder: failed
//   4. after Retry: S1 runs in process ...
// 建议阅读顺序：先读 plugins/sessions/contract.ts 的 Process（state 与 crash 方法），再看本文件的 hold/crash/
//   retry 三步，最后读 ./worker.ts 与 plugin 的 crash 实现。
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// BACKGROUND_CONTEXT 是永不取消的根 Context；本示例用它作为所有组件与引用的生命周期上下文。
import { hostKind } from "../../../src/contracts/index.ts";
import { createHost } from "../../../src/host/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";
import { createWorkers } from "../../../src/node/workers/index.ts";
import { Process, Session } from "./plugins/sessions/contract.ts";

// 等待辅助：返回一个在 ms 毫秒后 resolve 的 Promise。`ms: number` 是参数类型标注；`new Promise` 没有显式
// 泛型，TypeScript 会把 resolve 的参数推断为 unknown，于是返回 Promise<unknown>——这里只 await，不读取值，
// 所以没有影响。示例（示例）：await sleep(1000) 在约一秒后继续。
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 插件组件与 41 相同：只在构造时启动 watcher，首次使用时发现并构建 worker facet。
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { worker: { platform: "node", hostPackages: ["@earendil-works/chord"] } },
		onError: console.error,
	},
	context,
);
// 服务器宿主的 onError 被刻意留空：本示例只关心 workers 组件报告的错误，避免宿主内部噪声混进输出。
// 真实应用应该记录它。server 的地址与 principal 同 41。
const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: () => {} });
// 与 41 相同的 createWorkers 配置，区别：
// - 不提供 idleMs，空闲停止使用默认的 5 分钟，所以 1 秒等待期间 worker 不会被空闲停止；
// - onError 只打印 error.kind，便于观察 worker_exited（非请求的退出）和 worker_failed（失败汇总）两类事件。
const workers = createWorkers(
	server,
	Session,
	{
		kind: "worker",
		entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
		execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
		authorize: () => true,
		principal: (address) => ({ kind: "worker", session: address.params.id }),
		start: () => ({}),
		lock: (address) => `example-42:${process.pid}:${address.key}`,
		plugins,
		onError: (error) => console.log(`   reported: ${error.kind}`),
	},
	context,
);
await server.load([], context);

// 1. A held session (a tab showing it): its worker runs.
// hold 与 get 不同：它同步返回引用，只做参数检查与放置，不会 reject；对象尚未 live 时 state 是 loading。
// 第一次 hold 触发路由 resolve 并 fork worker，需要等 worker 启动并绑定后才变为 live。
const session = server.hold(Process, { id: "S1" }, context);
// state 是 NativeWatchable<RefState>；.value.kind 可能是 loading、live、failed 或 ended。
// 这个箭头函数每次读取当前值，供下面的轮询使用。
const state = () => session.state.value.kind;
// 轮询直到 live；10ms 的间隔只是示例写法，事件驱动的写法是 session.state.watch(context)。
while (state() !== "live") await sleep(10);
// pid 是远程对象的状态成员（Watchable），live 之后可以读取 worker 进程的 pid。
console.log(`1. S1 runs in process ${session.pid.value}`);

// 2. It crashes. The address is failed, and the holder sees why; it stays on the address's path.
// crash 是远程方法。method() 声明为无参数、结果为 null，所以引用上的调用形式是 crash(context)：
// await 会等待 worker 返回 null；worker 里用 10ms 延迟安排进程退出，通常让这次调用的回复先发出。
await session.crash(context);
// 进程退出后，服务器把该地址标为 failed（崩溃不会自动重启）；持有者的 RefState 也变为 failed，
// 但引用仍停留在该地址的路径上，retry 后能重新绑定。
while (state() !== "failed") await sleep(10);
// workers.state 是按地址 key 的记录；"session|S1" 是 kind 与参数字面量拼出的 key。可选链 failed?. 处理
// “地址没有状态项”的情况。WorkerState 是联合：status 为 "failed" 的分支才有 error，先比较再取 message，
// TypeScript 通过这个判断收窄类型；否则打印状态字符串（可能为 undefined）。
const failed = workers.state.value["session|S1"];
console.log(`2. crashed: ${failed?.status === "failed" ? failed.error.message : failed?.status}`);

// 3. No restart loop: a second later it is still failed, and no other worker was started.
// 等待一秒再读：地址仍是 failed，持有者仍是 failed，说明没有自动重试或重新 fork。
await sleep(1_000);
console.log(`3. a second later: ${workers.state.value["session|S1"]?.status}, the holder: ${state()}`);

// 4. Retry (the app's button): the worker starts again and the same holder binds to it.
// retry 清除该地址的失败（以及可能存在的挂起），若还有持有者就立即重新启动；它对应路由的 RouteHandle.retry。
// 我们不需要重新 hold：同一个 session 引用会重新绑定到新进程，state 再次变为 live。
await workers.retry(Session({ id: "S1" }), context);
while (state() !== "live") await sleep(10);
// pid 已变化，说明是新进程；语义上仍是同一个会话。
console.log(`4. after Retry: S1 runs in process ${session.pid.value}`);

// 关闭：释放引用会结束对象；close 停止所有子进程，然后关闭宿主，最后停止插件的文件监视器。
session.release();
await workers.close(context);
await server.close(context);
plugins.close();
