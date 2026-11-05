// The worker process: a host at the session's address, connected to the server, loading the plugins it was shipped.

// 文件导读
// 所属：packages/chord/test/examples/43-rollout/worker.ts，main.ts 的 createWorkers 通过 options.entry
//   启动的子进程入口。
// 演示什么：worker 侧启动流程与 41/42 相同；区别在于本示例的发布步骤会把新的 worker 脚本集合发到这个进程，
//   由 workerMain 里的插件运行时在 fn 返回后按顺序重载。worker 自己不构建、不发现文件。
// 上游/下游：上游是 main.ts 的 createWorkers 与 plugins.rollout 的 workers.step；下游是 workerMain、
//   createHost、plugins.load（初始脚本）以及后续的 reload 控制消息。本文件不打印；错误写 stderr，
//   未捕获异常经 redact 后成为 fatal。
// 能力清单：workerMain、createHost、onClose、connect、plugins.load、hostPackages/redact/onError。
// 典型运行顺序：fork -> 取锁 -> start（带初始脚本）-> createHost -> connect（started）-> plugins.load ->
//   ready -> 收到 reload { scripts }（若有）-> 宿主重载 -> reloaded。
// 同目录 plugins/notes/package.json（JSON，不能加注释）提供插件名 @example/notes 与 ESM 类型；该名字出现在
//   dirty 标记和 rollout 报告中。
// 建议阅读顺序：对照 41-workers/worker.ts；然后读 plugins/notes/worker.ts 的 Label 实现和 main.ts 的 rollout。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// 永不取消的根 context，供关停时的 host.close 使用。
import { createHost } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
// 本进程的包实例，作为插件求值时的宿主包；不能把服务器端的函数跨 IPC 传过来。
import { workerMain } from "../../../src/node/workers/index.ts";

// 应用回调在收到 start、取到锁后运行。WorkerStart 的字段：address、start（启动数据）、parent（父链路）、
// plugins（本 kind 的 WorkerPlugins）、onClose（关停清理）。context 随关停中止。
workerMain(
	async ({ address, parent, plugins, onClose }, context) => {
		// 本进程只服务启动消息中的这个会话地址；principal 是本机身份。
		const host = createHost({ address, principal: { kind: "worker" }, onError: console.error });
		// 关停时关闭宿主；用 BACKGROUND_CONTEXT 避免已中止的关停 context 取消关闭。
		onClose(() => host.close(BACKGROUND_CONTEXT));
		// Connect first: the server sees the worker started; then load.
		// 先 connect：服务器据此认定 started；trusted 跳过协议结构检查，不跳过参数校验。
		host.connect(parent, { principal: { kind: "server" }, trusted: true }, context);
		// 用启动消息里的脚本加载 worker facet；core 是应用自有 facet（示例为空）。
		await plugins.load(host, { kind: "worker", core: [] }, context);
		// 返回后发送 ready；之后 rollout 发来的 reload 会应用到同一个宿主。
		return {};
	},
	{
		hostPackages: { "@earendil-works/chord": chord },
		redact: (error) => ({ message: String(error) }),
		onError: console.error,
	},
);
