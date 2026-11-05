/**
 * Node/Bun的沙箱后端：每次执行新建一个worker，把公共Execution的消息桥接到其中的QuickJS。
 * 公共层管理工具/结果/取消，这里只负责WASM准备、worker启动、消息传递和请求停止；结果结束不等于线程已经退出。
 */
// Node原生worker线程，隔开脚本的同步计算与宿主事件循环。
import { Worker } from "node:worker_threads";
// import type在运行JS中擦除，只复用配置契约。
import type { CodemodeSandboxOptions } from "../types.ts";
// type关键字只导入模块类型；loadQuickJSWasm是实际执行的加载函数。
import { type CodemodeWasmModule, loadQuickJSWasm } from "../wasm.ts";
// 继承共享执行管线，VmLauncher描述后端必须提供的启动函数。
import { CodemodeSandboxBase, errorMessage, type VmLauncher } from "./execution.ts";
// WorkerData仅是传给线程的静态类型，不会自己验证wire数据。
import type { WorkerData } from "./protocol.ts";

/** 源码运行取旁边worker.ts，发布dist取worker.js；URL相对当前模块，和进程cwd无关。无磁盘访问。 */
function defaultWorkerUrl(): URL {
	// `.ts` when running from source (tests, tsx), `.js` from the published dist.
	// import.meta.url识别当前模块后缀，new URL解析相邻入口；仅返回地址，不启动线程。
	return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

/**
 * Each execution gets its own worker thread and QuickJS VM. A fresh worker per run keeps
 * termination simple: a runaway script, including one that only spins the microtask queue, is
 * killed with `terminate()` and cannot poison a later run. Before terminating, the host sets a
 * shared interrupt flag that the VM polls, because Bun's `terminate()` cannot stop a thread that
 * is spinning in wasm. Stopping requests termination without waiting for exit: some built-ins do
 * not poll the flag, so on Bun a worker can outlive the script's result.
 */
/**
 * 返回一个启动闭包，构造时不启动线程。每次调用：等WASM→预留容量→新建worker→装监听→返回post/stop通道。
 * 例acquireWorker抛错会拒绝准入；new Worker抛错则立即release；成功线程要到真实exit才release。
 * WASM/启动失败交给公共Execution转sandbox结果；宿主提供的release回调按契约不能抛错。
 */
function workerLauncher(options: CodemodeSandboxOptions): VmLauncher {
	// async闭包收到本次VM启动数据和公共层回调，返回Promise<VmChannel>。
	return async (data, events) => {
		// 此变量最终持有编译模块，不是WASM实例。
		let module: CodemodeWasmModule;
		// 只包住WASM获取，以便标明是哪一步失败。
		try {
			// 可传现成模块或Promise；否则默认读取/编译。await两者都适用。
			module = await (options.wasm ?? loadQuickJSWasm());
		} catch (error) {
			// 加载拒绝不预占worker容量。
			// 统一可读错误；errorMessage能处理非Error异常。
			throw new Error(`Failed to load QuickJS: ${errorMessage(error)}`);
		}
		// 4字节恰好容纳一个Int32，主线程和VM可共享中断标志。
		const interrupt = new SharedArrayBuffer(4);
		// 对象展开复制启动字段，再附模块与共享内存；不是复制编译模块内部代码。
		const workerData: WorkerData = { ...data, wasm: module, interrupt };
		// ?.表示回调存在才调用；同步预留在WASM成功之后，创建worker之前。
		const releaseWorker = options.acquireWorker?.();
		// 先声明变量，方便构造try及后面回调共用。
		let worker: Worker;
		// 将构造失败与运行期间error事件区分开。
		try {
			// 显式workerUrl覆盖默认入口；workerData由worker_threads传输。
			worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), { workerData });
		} catch (error) {
			// 构造没成功，不会有可用线程exit来归还名额。
			// 若预留返回了release，现在同步归还。
			releaseWorker?.();
			// 继续抛出，公共执行器会决定失败结果。
			throw new Error(`Failed to start worker: ${errorMessage(error)}`);
		}
		// once只在真实exit时释放一次；不在结果完成或stop返回时提前释放。
		if (releaseWorker) worker.once("exit", releaseWorker);
		// wire信任边界先按unknown接收，再处理watch噪声并交给公共层识别消息。
		worker.on("message", (message: unknown) => {
			// Node 24/26 --watch leaks dependency reports onto the worker channel (nodejs/node#65044).
			// Node watch可能混入依赖报告；这里只排除带这两种键的非null对象，不验证完整协议载荷。
			if (
				// typeof null也是object，所以后面还需排除null。
				typeof message === "object" &&
				// 排除null后，下一条件才能安全使用in操作符。
				message !== null &&
				// in也能看到继承键；这段是已知watch噪声过滤规则。
				("watch:import" in message || "watch:require" in message)
			)
				// 该消息不属于脚本执行结果，忽略它。
				return;
			// 其他消息交给Execution；真正JSON解码/状态收尾在公共层。
			events.message(message);
		});
		// 线程error事件来自脚本外的worker失败，不是普通工具抛错。
		worker.on("error", (error: unknown) => {
			// 通知公共层尝试结束本次执行；它负责首次结束事件胜出的规则。
			events.failure({
				// sandbox表示VM/传输基础设施问题。
				kind: "sandbox",
				// 只有真Error才读取name，其他异常不凭空伪造名字。
				name: error instanceof Error ? error.name : undefined,
				// 任意异常转可读消息。
				message: errorMessage(error),
			});
		});
		// exit也通知失败；正常done之后公共层已经finished，后来的exit不会覆盖结果。
		worker.on("exit", (code) => {
			// 退出码用于诊断；即使0，若没有收到脚本done也属于提前退出。
			events.failure({ kind: "sandbox", message: `Worker exited with code ${code} before the script settled` });
		});
		/** 请求中断和terminate后立即完成；不等待真实线程退出，不保证不响应中断的内建函数已停止。 */
		const stop = async (): Promise<void> => {
			// Atomics把共享Int32第0项置1，VM中断回调能看到；不是普通局部变量。
			Atomics.store(new Int32Array(interrupt), 0, 1);
			// A non-interruptible built-in can delay Bun's terminate() until it returns (#10748).
			// Do not hold up the result while that worker exits.
			// void明确不等terminate Promise，catch吞掉其拒绝；线程退出由单独exit事件跟踪。
			void worker.terminate().catch(() => undefined);
			// terminate() refs the worker internally; unref it after requesting termination.
			// terminate内部可能ref线程，所以之后unref；它只影响宿主保活，不等于终止已完成。
			worker.unref();
		};
		// 生命周期钩子本身也可能抛错，因此要对已启动worker做清理。
		try {
			// 可选钩子拿到只会在真实exit完成的Promise；resolve()不传退出码。
			options.onWorkerStarted?.(new Promise<void>((resolve) => worker.once("exit", () => resolve())));
		} catch (error) {
			// 钩子抛错属于启动链失败。
			// 发出停止请求，仍不等待线程真实退出。
			void stop();
			// 原异常交给公共层；release仍等exit回调。
			throw error;
		}
		// post闭包把宿主回复发给worker；返回的stop复用上面的停止逻辑。
		return { post: (message) => worker.postMessage(message), stop };
	};
}

/**
 * Runs JavaScript in a QuickJS VM (a separate wasm instance) inside a worker thread. The worker
 * keeps script execution off the host thread: QuickJS runs synchronously, so a spinning script on
 * the host thread would block its event loop. Requires `node:worker_threads` (Node or Bun); see
 * `InlineCodemodeSandbox` and `RemoteCodemodeSandbox` in `@earendil-works/pi-codemode/portable`
 * for other runtimes.
 */
/** worker版公共入口；例new CodemodeSandbox({tools}).execute("return 1")。构造仅配置后端，execute/start才真正起worker。 */
export class CodemodeSandbox extends CodemodeSandboxBase {
	/** 配置缺省为{}，父类设置工具表/默认值；与上层coding-agent的会话/持久化是不同职责。 */
	constructor(options: CodemodeSandboxOptions = {}) {
		// super先初始化父类；workerLauncher此时只是创建闭包，不预先读取WASM。
		super(options, workerLauncher(options));
	}
}
