// The worker process: a host at the session's address, connected to the server, loading the plugins it was shipped.

// 文件导读
// 所属：packages/chord/test/examples/42-worker-crash/worker.ts，main.ts 的 createWorkers 通过 options.entry
//   启动的子进程入口；与 41 的同名文件结构相同。
// 演示什么：worker 侧启动流程——workerMain 处理 IPC/锁/start 消息，回调创建地址宿主、先 connect（告诉服务器
//   started）再加载服务器运来的插件脚本。崩溃不在这里发生，而由 plugins/sessions/worker.ts 的 crash 方法触发。
// 上游/下游：上游是 main.ts 的 createWorkers；下游是 workerMain、createHost 与 plugins.load。本文件不打印；
//   错误经 onError 写 stderr，未捕获异常由 workerMain 转成 fatal（redact 后）并退出进程。
// 能力清单：workerMain 调用、createHost、onClose 清理、connect、plugins.load、hostPackages/redact/onError。
// 典型运行顺序：fork -> 取锁 -> start -> createHost -> connect（started）-> plugins.load -> ready -> 崩溃 ->
//   退出 -> 服务器标记 failed；retry 后再 fork 一个新进程重复上述流程。
// 同目录 plugins/sessions/package.json（JSON，不能加注释）是插件 @example/sessions 的清单：name 供发现与
//   报告使用，type: "module" 决定 ESM 解析；其作用也记录在插件 facet 文件的文件头。
// 建议阅读顺序：对照 41-workers/worker.ts 阅读；再读 plugins/sessions/worker.ts 的 crash 实现。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// 永不取消的根 context，供关停时的 host.close 使用。
import { createHost } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
// 本进程的包实例，供插件求值时解析 "@earendil-works/chord"；函数不能跨 IPC，所以不能在服务器端构造。
import { workerMain } from "../../../src/node/workers/index.ts";

// workerMain 立即返回；应用回调在收到 start 且取到跨进程锁后运行。第一个参数解构出 WorkerStart 的字段：
// address（服务器解析的地址）、parent（到服务器的 Link）、plugins（本 kind 的 WorkerPlugins）、
// onClose（关停时逆序执行的清理函数）。context 会随 shutdown、父连接断开或信号中止。
workerMain(
	async ({ address, parent, plugins, onClose }, context) => {
		// 地址来自启动消息，本进程只服务这个会话；principal 是本机身份（服务器盖在链路上的身份是另一个对象）。
		const host = createHost({ address, principal: { kind: "worker" }, onError: console.error });
		// onClose 在 shutdown 时执行；用 BACKGROUND_CONTEXT 避免已经中止的关停 context 立刻取消 close。
		onClose(() => host.close(BACKGROUND_CONTEXT));
		// Connect first: the server sees the worker started; then load.
		// connect 是 started 信号：服务器以此结束启动阶段；先连接再做慢加载，慢加载不会被启动计时误杀。
		// trusted: true 表示链路另一端是自己 fork 的进程，跳过 MESSAGE 结构校验，但参数与 schema 检查仍在。
		host.connect(parent, { principal: { kind: "server" }, trusted: true }, context);
		// 求值服务器随启动消息运来的 worker 脚本；core 为本应用自有 facet，示例为空。
		await plugins.load(host, { kind: "worker", core: [] }, context);
		// 没有额外 busy 计数；返回后发送 ready。
		return {};
	},
	{
		// 本进程的模块实例表；插件构建时这些说明符保持外部，求值时从这里取。
		hostPackages: { "@earendil-works/chord": chord },
		// 公开的致命错误只保留字符串消息；完整错误只经 onError 输出。
		redact: (error) => ({ message: String(error) }),
		onError: console.error,
	},
);
