// Chord v2's workers component (`@earendil-works/chord/workers`, slice 10 §3, §4): a forked worker process per
// address of a host kind, started on demand, stopped when idle, never restarted by itself, its plugins shipped from the
// server; `workerMain` is the worker's side. Node-only.

// 文件导读
// 所属模块：packages/chord/src/node/workers，workers 子系统的公开入口（仅在 Node 下可用）。
// 解决的问题：应用需要两套 API：服务器侧按地址管理子进程（createWorkers），子进程侧把当前进程变成 worker
//   （workerMain）；同时不希望把 IPC、锁、进程事件等内部实现暴露成公共表面。
// 职责边界：只做再导出和入口文档，不包含逻辑；具体的 fork、锁、消息协议分别在 process.ts、lock.ts、control.ts，
//   生命周期在 workers.ts 与 main.ts。
// 上游：服务器应用从本模块 import createWorkers；worker 入口模块（由 options.entry 指定）import workerMain。
//   下游：workers.ts 使用 process.ts/control.ts/lock.ts；main.ts 使用 lock.ts/control.ts。错误通过 WorkersError
//   回调、WorkerState.failed、启动 Promise 的拒绝和子进程的 fatal 消息流出；本文件不改写它们。
// 能力清单：
// - CrossedError：跨进程错误形状（message、可选 code/reason）。
// - ProcessLock、processLock()：跨进程互斥的地址锁，保证一个地址只有一个存活 worker。
// - WorkerStart、WorkerPlugins、WorkerResult、WorkerMainOptions、workerMain()：子进程侧入口及其参数/返回值。
// - WorkersOptions、WorkerState、WorkersError、Workers、createWorkers()：服务器侧组件、状态与错误类型。
// 组合关系：服务器 createWorkers -> host.route -> 按需 fork；子进程 entry 调 workerMain -> processLock -> ipcLink ->
//   应用函数；之后通过控制消息同步 started/ready/idle/reload/fatal。
// 示例（示例，不是本文件的运行代码）：
//   declare const host: Host<Principal>;
//   declare const Kind: HostKind<"notes", {}>;
//   const workers = createWorkers(host, Kind, options, context); // Workers<HostKind<"notes", {}>>
//   const states = workers.state.value;                         // Readonly<Record<string, WorkerState>>
//   // worker 入口模块中：
//   workerMain(async ({ parent, plugins }) => undefined, { hostPackages, redact, onError });
// 建议阅读顺序：先看 WorkersOptions/Workers 了解服务器侧契约，再看 WorkerStart/WorkerMainOptions 了解子进程侧，
//   然后读 workers.ts 的生命周期、main.ts 的子进程流程，最后看 control.ts、process.ts、lock.ts 的支撑细节。

export type { CrossedError } from "./control.ts";
export { type ProcessLock, processLock } from "./lock.ts";
export {
	type WorkerMainOptions,
	type WorkerPlugins,
	type WorkerResult,
	type WorkerStart,
	workerMain,
} from "./main.ts";
export {
	createWorkers,
	type WorkerState,
	type Workers,
	type WorkersError,
	type WorkersOptions,
} from "./workers.ts";
