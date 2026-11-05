// 由 worker-lifetime 测试启动的独立进程；只跑固定本地 WASM 脚本，分别记录结果决定和进程退出的真实耗时。
import { CodemodeSandbox } from "../../src/runtime/host.ts";

// 第三个进程参数选择停止方式；这里是命令行字符串边界，不是已验证的标签类型。
const how = process.argv[2];
// 只接收三个模式，未知模式直接抛错，后续比较便可缩窄为这三个字符串。
if (how !== "abort" && how !== "timeout" && how !== "close") throw new Error(`Unknown stop mode: ${how}`);
// 单调时钟只用于经过时间，不依赖墙钟日期。
const started = performance.now();
// 退出回调不能再等异步操作；这里同步打印一行 JSON，让父进程看到真实自然退出时刻。
process.on("exit", () => {
	// 这行是进程退出记录，和下方 result 记录分开；打印 result 不证明进程已能退出。
	console.log(JSON.stringify({ type: "exit", elapsedMs: performance.now() - started }));
});
// 仅 abort 模式触发此控制器；signal 随执行参数传入。
const controller = new AbortController();
// ReturnType 从函数类型取定时器句柄；未创建时为 undefined，finally 同样可清理。
let timer: ReturnType<typeof setTimeout> | undefined;
// 记录结果打印前是否已收到真实线程退出通知；不把 close 完成误认作线程退出。
let workerExited = false;
// 配置本地 worker 沙箱；直到 execute 才加载模块并起线程。
const sandbox = new CodemodeSandbox({
	// 限制 QuickJS 堆为 256 MiB，不是限制整个进程占用。
	memoryLimitBytes: 256 * 1024 * 1024,
	// 启动钩子收到真实 exit 的 Promise；注册 then 只观察，不阻塞脚本启动。
	onWorkerStarted: (exited) => {
		// void 表明不等待此 Promise，回调会在线程真正退出后更新标记。
		void exited.then(() => {
			// 只有 exit 通知结算才置 true，执行结果完成本身不会修改它。
			workerExited = true;
		});
	},
	tools: [
		{
			name: "ready",
			// ready 工具忽略脚本参数，通知宿主可以安排停止；同步返回 undefined。
			execute: () => {
				// timeout 模式靠执行器自己的定时器，另外两种才安排工具启动后的停止。
				if (how !== "timeout") {
					// 延后约 100ms，让脚本进入后续繁重的内建字符串操作；并非精确调度保证。
					timer = setTimeout(() => {
						// abort 模式通知整个执行取消；脚本里的普通 catch 不能恢复该运行。
						if (how === "abort") controller.abort();
						// 剩下 close 模式请求关闭；void 不在定时器回调里等待其结果。
						else void sandbox.close();
					}, 100);
				}
			},
		},
	],
});
// try/finally 覆盖执行和记录，无论哪步异常都清定时器并请求关闭。
try {
	// 先等 ready 工具再做固定的昂贵字符串查找，用来暴露停止请求与线程真正退出的时间差。
	const result = await sandbox.execute(
		"await tools.ready(); return 'a'.repeat(300000).indexOf('a'.repeat(10000) + 'b')",
		// timeout 模式设 300ms，其他模式用 Infinity 禁用墙钟期限，依赖 abort/close。
		{ signal: controller.signal, timeoutMs: how === "timeout" ? 300 : Number.POSITIVE_INFINITY },
	);
	// 预期必须失败；意外正常完成抛错，使父进程命令失败而非伪装取消通过。
	if (result.ok) throw new Error("The script completed instead of being cancelled");
	// 等关闭请求结算；它可早于真实 worker exit，后面的标记正是观察这个差异。
	await sandbox.close();
	// 打印结果 JSON 作为第一行，父进程会解析 kind 与耗时，并等待进程退出记录。
	console.log(
		JSON.stringify({
			type: "result",
			// 上面的 result.ok 分支已排除成功，TS 允许读取 error；这里不做重复形状检查。
			kind: result.error.kind,
			elapsedMs: performance.now() - started,
			// 对象简写传当前线程退出标记，不是强制要求它此时为 true。
			workerExited,
		}),
	);
} finally {
	// 取消可能尚未触发的人工停止定时器；句柄 undefined 时无操作。
	clearTimeout(timer);
	// 等关闭请求结算；它可早于真实 worker exit，后面的标记正是观察这个差异。
	await sandbox.close();
}
