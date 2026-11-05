/**
 * Node/Bun worker入口：宿主创建线程后才在这里读取启动数据，建立一个QuickJS实例并转发消息。
 * 与主入口不同，本模块有顶层启动副作用；在有parentPort的worker里导入就执行main，在普通主线程不启动VM。
 * 宿主拥有最终结果与生命周期，线程内不主动dispose session，而由宿主terminate及共享中断标志收尾。
 */
/**
 * Worker thread entry. One worker runs one script inside a fresh QuickJS VM
 * (a separate wasm instance), relays tool calls and output to the host, and
 * reports the result. The host terminates the worker when the script settles,
 * times out, or is aborted; the worker exists so that a spinning script never
 * blocks the host thread.
 *
 * Importing this module starts the worker. Hosts that bundle their code (for
 * example a Bun compiled executable) add a file that imports
 * `@earendil-works/pi-codemode/worker` as a separate entrypoint and pass its URL
 * or embedded-module string specifier as `workerUrl`.
 */
// parentPort是当前worker与父线程的通道，workerData是构造线程时传来的数据。
import { parentPort, workerData } from "node:worker_threads";
// type导入只供编译；守卫函数运行时仅识别result外壳，不深验payload字段。
import { isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";
// 共享VM驱动处理QuickJS实例、桥和promise jobs。
import { startVm } from "./vm.ts";

/** 把一条VM消息发父线程，无通道则跳过；例输出片段由公共Execution收集，不在这里画终端。postMessage错误可同步抛出。 */
function post(message: WorkerToHostMessage): void {
	// 可选链兼容无parentPort情形，不自己创建通道。
	parentPort?.postMessage(message);
}

/** 启动共享中断视图→创建VM→监听宿主回复。启动异步失败由顶层catch报告crash；resolve只说明session/监听建立，不表示脚本已结束。 */
async function main(data: WorkerData): Promise<void> {
	// Int32Array视图共用同一SharedArrayBuffer，不复制标志值。
	const interrupt = new Int32Array(data.interrupt);
	// The VM lives until the host terminates the worker, so the session is never disposed.
	// 创建WASM实例并执行前导/脚本初段；等待本身不阻塞父线程。
	const session = await startVm({
		// JS文字/工具目录/store快照等启动数据。
		data,
		// 父线程传编译模块，避免每次worker重新读取编译。
		wasm: data.wasm,
		// 对象简写传同名post回调，VM消息转父线程。
		post,
		// Atomics跨线程读中断标志，非零请求停止；不轮询的内建计算仍可能延迟响应。
		shouldInterrupt: () => Atomics.load(interrupt, 0) !== 0,
	});
	// session准备好后接收父线程的工具回答，wire边界按unknown接收。
	parentPort?.on("message", (message: unknown) => {
		// 仅已知result外壳才递交，不完整字段也可能通过；真正处理在VM/prelude，未识别消息直接忽略。
		if (isHostToWorkerMessage(message)) session.deliver(message);
	});
}

// 有父端口才自动启动；普通主线程导入时不调用main。
if (parentPort) {
	// WorkerData断言是宿主与自身线程的既定启动契约，不做运行时schema转换；Promise错误在此收口。
	main(workerData as WorkerData).catch((error: unknown) => {
		// 发送基础设施crash，Error保留类名+消息，其他异常走String；不是脚本可catch的工具拒绝。
		post({ type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
	});
}
