// Workers (slice 10): the server routes a session's address to its own worker process. The first reference to a
// session starts its worker; once nobody uses it for `idleMs`, the worker stops. The worker's code is the sessions
// plugin (`plugins/`), built by the server and shipped to the worker.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/41-workers/main.ts
// 文件导读
// 所属：packages/chord/test/examples/41-workers，Chord slice 10（HTTP 与 workers）的 workers 示例，属于
//   `packages/chord/test/examples/` 下按编号排列的可运行示例。
// 演示什么：服务器用 host kind `session` 的地址标识每个会话，createWorkers 把该地址上的对象路由到独立的 Node
//   子进程；第一次 get 时 fork，最后一个引用释放且空闲超过 `idleMs` 后停止。worker 的插件脚本由服务器的
//   plugins 组件构建，随启动消息运给子进程；子进程只求值，不构建。
// 上游/下游：由下一行的命令启动；上游是 Node 与 ./plugins/sessions 中的契约；下游调用
//   src/node/plugins 的 createPlugins（发现/构建/监视插件）、src/node/workers 的 createWorkers（路由与子进程）、
//   src/host 的 createHost；子进程入口 ./worker.ts 调用 workerMain。脚本只打印场景，不写文件、不访问网络
//   （进程间 IPC 除外）。错误经两个 onError 的 console.error 输出到 stderr；未捕获异常会让进程以非零码退出。
// 能力清单（按演示步骤）：
// - createPlugins：扫描 ./plugins，并声明 worker 种类的构建平台与宿主包。
// - createHost：创建带 `server` 地址的服务器宿主。
// - createWorkers：为 `Session` 地址注册路由，并管理每个地址的 worker（start/principal/lock/idleMs）。
// - workers.state.watch：订阅每个地址的 starting/running/stopping/failed 状态。
// - server.get(Greeting, { id })：取得 worker 中服务的远程对象，再读取它的状态成员。
// - release 加轮询：观察引用归零后的空闲停止。
// 典型运行顺序：创建 plugins/server/workers -> load 服务器 -> 订阅状态 -> get 触发 fork -> 读取成员 ->
//   release -> 等状态表为空 -> 依次关闭 watch、workers、server、plugins。
// 前置条件与运行命令（从 packages/chord 目录执行；Node 需要支持类型剥离，插件构建需要可用的 esbuild）：
//   node --conditions=source --experimental-strip-types test/examples/41-workers/main.ts
// 预期输出（示例，pid 每次不同；workers 日志由异步回调打印，可能与主流程的行略有交错）：
//   1. getting S1's greeting
//      workers: session|S1 starting
//      workers: session|S1 running
//   2. "hello from session S1" (worker pid ..., server pid ...)
//   3. released; waiting for the idle stop
//   4. stopped
// 本示例是最小演示：一条契约、一个插件目录。真实应用还需要权限校验、持久存储和错误处理。
// 建议阅读顺序：先读 plugins/sessions/contract.ts 的 Session 与 Greeting 声明，再回到本文件的 createWorkers
//   配置，最后读 ./worker.ts 的子进程侧；选项语义可查 docs/design.md §23 的 Workers 一节。
import { fileURLToPath } from "node:url";
// fileURLToPath 把 `file:` URL 转成文件系统路径：createPlugins 的 roots 和子进程的 entry 都要路径字符串。
// `import.meta.url` 是当前 ESM 模块自身的 URL；`new URL("./plugins/", import.meta.url)` 以它为基准解析，
// 末尾的斜杠表示得到目录 URL。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// BACKGROUND_CONTEXT 是一个永不取消、没有 telemetry 的根 Context，适合组件级生命周期；`as context` 只是
// 重命名导入，后续代码直接把它传给各组件。它不是 AsyncLocalStorage，不会自动跨 await 传递状态。
import { hostKind } from "../../../src/contracts/index.ts";
// hostKind 声明“宿主种类”；调用它得到地址工厂，`hostKind("server")()` 生成无参数的 server 地址。
import { createHost } from "../../../src/host/index.ts";
// createHost 创建宿主：它持有对象、路由、引用和注册表。本示例只创建服务器宿主。
import { createPlugins } from "../../../src/node/plugins/index.ts";
// createPlugins 是 Node 端插件组件：发现插件目录、用 esbuild 构建 facet、求值/加载/重载并监视文件变化。
import { createWorkers } from "../../../src/node/workers/index.ts";
// createWorkers 是服务器侧 workers 组件：为一种 host kind 注册路由，按地址 fork 子进程并管理其生命周期。
import { Greeting, Session } from "./plugins/sessions/contract.ts";

// 契约既给服务器用（路由与引用），也给 worker 里的 facet 用（服务对象）。

// createPlugins 先只构造组件并启动文件监视器；首次 load/scripts 时才做发现与构建。
// options.roots 是插件根目录列表；options.kinds 的键是 facet 种类名，发现阶段把每个插件目录里的
// `<kind>.ts`（这里是 worker.ts）当作该种类的入口；hostPackages 列出构建时保持外部的导入，子进程求值时
// 再提供这些模块的实例；onError 接收 watcher 无法监视或监视监听器抛出的错误。第二个参数在当前实现中
// 不读取（参数名是 _context），保留它是统一的组件签名。
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { worker: { platform: "node", hostPackages: ["@earendil-works/chord"] } },
		onError: console.error,
	},
	context,
);

// 1. The server, and its workers: one forked process per session, stopped after 300 ms without use.
// 服务器宿主没有存储，只需要一个带地址的身份：`hostKind("server")()` 生成的地址参数为空，
// 但地址让宿主的对象、路由和日志有稳定标识。principal 是本机代码以什么身份行动；onError 记录宿主内部错误。
const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: console.error });
// createWorkers 在构造时就调用 server.route(Session, ...)，因此必须在 server.load 之前调用。
// 各字段的含义：
// - kind：worker 加载的 facet 种类，必须与 options.kinds 的键一致，也决定启动消息里携带哪套脚本；
// - entry：子进程入口模块（它调用 workerMain）；execArgv 是该子进程的 Node 参数；
// - authorize：路由的同步授权钩子，这里对所有人放行（真实应用应按 principal 与地址判断）；
// - principal：解析成功后盖在链路上的“worker 身份”；
// - start：每次启动前发给子进程的 JSON 启动数据，这里为空；抛错会让本次启动失败；
// - lock：跨进程锁名，保证同一地址只有一个存活 worker；加进程 pid 避免并行运行的本示例互相干扰；
// - idleMs：子进程空闲多久后停止，这里 300ms（空闲扫描默认每秒一次，所以实际停止可能晚到约 1 秒）；
// - plugins：提供该 kind 的完整脚本集合，启动时运给子进程；
// - onError：workers 组件的错误出口（启动失败、崩溃、非请求退出等）。
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
		lock: (address) => `example-41:${process.pid}:${address.key}`,
		idleMs: () => 300,
		plugins,
		onError: console.error,
	},
	context,
);
// 空 facet 列表也能 load：服务器没有自己的对象，只提供 workers 注册的路由；load 解析后路由正式发布。
await server.load([], context);

// 2. Every change of the workers' state, printed.
// workers.state 是一个 JSON Watchable<Record<地址键, WorkerState>>；watch() 返回句柄，start() 之后才开始投递。
// 地址键形如 "session|S1"，即 kind 与参数字面量拼接；集合为空表示没有任何 worker 在运行或失败。
const watch = await workers.state.watch(context);
// 监听帧是 WatchCall 联合：kind 为 "value"（新值）或 "failed"（源暂时无法计算，watch 不结束）。
// 这里忽略 failed 帧，只打印 value 帧；回调是 async，但 start 不会等待它完成。
watch.start(async (call) => {
	if (call.kind !== "value") return;
	// Object.entries 把记录拆成 [key, state] 二元组数组；map 解构参数，state 被推断为 WorkerState。
	const entries = Object.entries(call.value).map(([key, state]) => `${key} ${state.status}`);
	console.log(`   workers: ${entries.join(", ") || "none"}`);
});

// 3. The first reference starts the worker; the greeting comes from that process.
// server.get 返回 Promise<Reference<Greeting>>。Greeting 并不由服务器自己服务：它的 hostAddress 指向
// Session 地址，服务器把 hold 交给 createWorkers 注册的路由，路由再 fork 出该会话的 worker。
// 第一次 get 会等待 worker 启动并绑定完成，因此下一行拿到的是已经 live 的引用。
console.log("1. getting S1's greeting");
const greeting = await server.get(Greeting, { id: "S1" }, context);
// text 和 pid 是远程契约的状态成员，类型是 Watchable；.value 读取当前值，不会发起异步请求。
// 其中 pid 来自子进程的 process.pid，所以能与服务器进程的 pid 区分开。
console.log(`2. "${greeting.text.value}" (worker pid ${greeting.pid.value}, server pid ${process.pid})`);

// 4. Releasing it leaves the worker idle: 300 ms later it stops.
// release() 释放唯一的引用；对象结束，worker 的活动计数归零，服务器开始空闲计时。
greeting.release();
console.log("3. released; waiting for the idle stop");
// 轮询状态表，直到它为空（worker 被停止后不会再出现在 state 中）。这里用 50ms 轮询，
// 因为空闲扫描每秒才跑一次，停止通常发生在 release 后约 1 秒内；这不是忙等，但也只是示例写法。
while (Object.keys(workers.state.value).length > 0) {
	await new Promise((resolve) => setTimeout(resolve, 50));
}
console.log("4. stopped");

// 关闭顺序：先停止观察（stop 返回终止结果），再停掉所有子进程，然后关闭宿主，最后停止文件监视器。
// workers.close 会取消未开始的启动、按宽限期停止每个子进程；plugins.close 是同步的，只停止 watcher。
await watch.stop();
await workers.close(context);
await server.close(context);
plugins.close();
