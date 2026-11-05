// GC-based measurements for cost guards and leak tests: bytes a function allocates, and collecting garbage on demand.
// 供内存成本/泄漏测试调用的 Node 专用辅助函数；这里测的是整个进程的 JS 堆，不是某个对象独占的内存。
import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// 导入模块时就修改 V8 的运行标志，使新 VM 上下文能取得 gc；不是 TypeScript 编译选项。
setFlagsFromString("--expose-gc");
// 在新上下文读取实际 gc 函数；as 只告诉 TS 它无参数且无返回值，不验证运行时确实存在。
const gc = runInNewContext("gc") as () => void;

/** Run a full garbage collection a few times, yielding in between so finalizers and weak references settle. */
// 无输入，交替让出事件循环和请求 GC 四次，异步返回 void；会影响进程堆，但不保证所有终结器已完成。
// 例：释放强引用后 await collectGarbage()，再检查 WeakRef；这里的四轮是测试策略，不是回收时限承诺。
export async function collectGarbage(): Promise<void> {
	// let 计数器从 0 到 3；每轮结束自增，四轮后退出。
	for (let round = 0; round < 4; round++) {
		// Promise 的 resolve 交给 setImmediate，让本轮 JS 作业结束后再继续，避免弱引用目标被当前作业保活。
		await new Promise((resolve) => setImmediate(resolve));
		// 同步请求 V8 垃圾回收；不是清空所有仍被引用的对象。
		gc();
	}
}

/**
 * Bytes `run` allocates on the JavaScript heap, including garbage collected while it ran: the heap growth plus what
 * every collection during the run freed.
 */
// 输入 run 为返回任意值的回调，先 GC 并开始分析，再等待回调、读取堆量和期间 GC，返回估算分配字节数。
// 例：await allocatedBytes(() => new Array(1000).fill(0)) 测这段执行附近的分配；还会包含测量本身及同期其他任务。
// run 的返回值被忽略，Promise 会被 await；异常向外传播，代码没有 finally，所以失败时不会执行 profiler.stop()。
export async function allocatedBytes(run: () => unknown): Promise<number> {
	// 先回收可回收对象，减少测量起点上旧垃圾的影响。
	gc();
	// 为本次测量创建 V8 GC 记录器。
	const profiler = new GCProfiler();
	// 开始记录此后发生的回收。
	profiler.start();
	// 记录起始 JS 堆已用字节，字段名来自 Node 的 HeapInfo。
	const before = getHeapStatistics().used_heap_size;
	// 执行并等待回调；同步值也可 await，不代表回调必须声明 async。
	await run();
	// 记录结束时仍占用的堆量；不包含这之后发生的分配。
	const after = getHeapStatistics().used_heap_size;
	// 对象解构只取回收记录 statistics；stop 同时结束本次分析。
	const { statistics } = profiler.stop();
	// let 允许逐次累加各轮 GC 释放的字节。
	let freed = 0;
	// for...of 逐条读取 profiler 实际记录的 GC。
	for (const collection of statistics) {
		// GC 记录用 camelCase 的 usedHeapSize；回收前减回收后，估算该轮释放量。
		freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
	}
	// 净堆增长加期间已回收量，避免只看最终堆量而漏掉短命分配；这不是对象存活量。
	return after - before + freed;
}

/** Whether `reference` is collected once nothing else holds its target. */
// 输入 WeakRef<object> 弱引用，先执行上述四轮回收再返回目标此刻是否不可取得；不修改弱引用。
// 例：await isCollected(ref) 为 true 表示 deref 已无目标，false 不能独自证明泄漏，可能尚未回收或仍有强引用。
export async function isCollected(reference: WeakRef<object>): Promise<boolean> {
	// 等待让出事件循环与 GC 步骤，避免在同一作业内立刻检查。
	await collectGarbage();
	// 严格等于 undefined 表示弱引用的目标已经被回收。
	return reference.deref() === undefined;
}
