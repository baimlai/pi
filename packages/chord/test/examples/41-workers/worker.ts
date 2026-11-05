// The worker process: a host at the session's address, connected to the server, loading the plugins it was shipped.

// 文件导读
// 所属：packages/chord/test/examples/41-workers/worker.ts，上面 main.ts 的 createWorkers 通过 options.entry
//   启动的子进程入口。
// 演示什么：worker 侧的最小启动流程。workerMain 负责 IPC、跨进程锁、start 消息和关停；应用回调在收到 start
//   后创建一个位于该会话地址的宿主，先连回服务器（连接动作就是“started”信号），再加载服务器运来的插件脚本。
// 上游/下游：上游是 main.ts 的 createWorkers（fork 本文件并发送 start 消息）；下游调用 src/node/workers 的
//   workerMain、src/host 的 createHost、plugins/sessions 的 worker facet（由 plugins.load 求值）。本文件不打印
//   输出；错误经 onError 写 stderr，未捕获异常会被 workerMain 转成 fatal（经 redact 脱敏）并让进程退出。
// 能力清单：
// - workerMain(fn, options)：子进程入口，运行 fn 并管理生命周期。
// - 应用回调：createHost（地址与身份）-> onClose（逆序清理）-> connect（先连父链路）-> plugins.load（求值脚本）。
// - hostPackages/redact/onError：子进程自己的模块实例、对外错误脱敏、内部错误日志。
// 典型运行顺序：父进程 fork -> 子进程取锁 -> 收到 start -> 回调建 host -> connect（服务器记录 started） ->
//   plugins.load -> 回调返回 ready -> ... -> shutdown 时逆序执行 onClose，进程退出。
// 同目录的 plugins/sessions/package.json 是本示例插件 @example/sessions 的清单：discoverPlugins 读取它的
//   name 作为插件名（出现在报告与 dirty 标记中），type: "module" 让 facet 文件按 ESM 解析；JSON 不能写注释，
//   所以清单的作用记录在这里。
// 建议阅读顺序：先看 workerMain 的参数类型（src/node/workers/main.ts 的 WorkerStart），再读本回调的四步，
//   最后对照 docs/design.md §23 Workers 的“the child”一段。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// BACKGROUND_CONTEXT 永不取消；下面 host.close 用它，避免关停时已中止的 context 让关闭立即被取消。
import { createHost } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
// 以命名空间方式导入包的公开入口，作为 hostPackages 的模块实例；插件里 `import ... from
// "@earendil-works/chord"` 在求值时会被映射到这个对象（函数不能跨 IPC 传递，所以必须用本进程实例）。
import { workerMain } from "../../../src/node/workers/index.ts";

// workerMain 立即返回 void：它在后台等待 start 消息，随后的进程存活由 IPC 通道和宿主的定时器维持。
// 回调的输入是 WorkerStart：address 是服务器解析出的地址；start 是 options.start 的 JSON 结果；parent 是到
// 服务器的 Link；plugins 是已绑定本 kind 脚本的 WorkerPlugins；onClose 注册关停时逆序执行的清理函数。
// context 是子进程的关停作用域：shutdown、父进程断开、SIGTERM/SIGINT 都会中止它。
workerMain(
	async ({ address, parent, plugins, onClose }, context) => {
		// address 来自启动消息，与服务端路由解析出的地址一致；principal 是本进程本机的身份。
		// 注意服务器给链路盖的 principal 是 { kind: "worker", session }，这里本机只用 { kind: "worker" }；
		// 示例把 P 留作默认的 Principal，两者都合法，真实应用应统一一个 P 类型。
		const host = createHost({ address, principal: { kind: "worker" }, onError: console.error });
		// 注册清理函数：宿主的 close 在关停时执行。它使用 BACKGROUND_CONTEXT，因为触发关停的 context 已经中止，
		// 若把中止的 context 传给 close，关闭动作会马上被取消而无法完成。
		onClose(() => host.close(BACKGROUND_CONTEXT));
		// Connect first: the server sees the worker started; then load.
		// 先 connect：服务器把“链路已连接”当作 started 信号，启动计时只覆盖 fork、取锁和 connect。
		// trusted: true 表示这是自己 fork 的进程，协议层跳过 MESSAGE 结构校验；参数/参数值检查仍会运行。
		// 之后才做可能较慢的 plugins.load，这样慢加载不会被误判为启动失败。
		host.connect(parent, { principal: { kind: "server" }, trusted: true }, context);
		// 加载服务器在启动消息里运来的脚本：kind 决定用哪套脚本，core 是本应用自己的 facet（示例没有）。
		// 求值使用本进程的 hostPackages，不在 worker 里运行 esbuild，也不重新发现文件。
		await plugins.load(host, { kind: "worker", core: [] }, context);
		// WorkerResult：这里不提供 busy 计数；返回后 workerMain 发送 ready，服务器开始允许空闲停止。
		return {};
	},
	{
		// 宿主包的说明符到本进程模块对象的映射；插件构建时这些导入保持外部，求值时从这里取。
		hostPackages: { "@earendil-works/chord": chord },
		// 对外可见的致命错误只保留 message；原始错误（可能含敏感信息）只进 onError。
		redact: (error) => ({ message: String(error) }),
		onError: console.error,
	},
);
