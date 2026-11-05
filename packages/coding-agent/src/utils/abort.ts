// 统一可选取消信号，并让调用方停止等待异步工作；停止等待不等于底层文件/网络操作已经停止。
/** 取得信号的取消原因；没有明确原因时创建名为 AbortError 的错误，返回值允许是任意抛出值。 */
function abortReason(signal: AbortSignal): unknown {
	// AbortSignal.reason 可以是字符串、Error 或其他值，不强行包成另一个错误丢失原因。
	if (signal.reason !== undefined) return signal.reason;
	// 没有 reason 时提供统一错误说明。
	const error = new Error("The operation was aborted");
	// name 用于调用方辨认取消；不需要定义额外子类。
	error.name = "AbortError";
	// 返回新错误，但不在这个辅助函数内抛出。
	return error;
}

/** Normalize an optional public signal without imposing a deadline. */
/** 有调用方信号就复用，否则返回一个未取消的新信号；不加定时器。例：内部方法统一拿到必填 AbortSignal。 */
export function operationSignal(signal?: AbortSignal): AbortSignal {
	// ?? 只处理空缺；新控制器仅用于提供 signal，不会自动取消它。
	return signal ?? new AbortController().signal;
}

/** Stop waiting on abort while observing the abandoned operation through settlement. */
/**
 * 等待 operation，同时允许 signal 先拒绝调用方的等待；原 operation 仍被监听直到完成，避免未处理拒绝。
 * T 保留原操作的成功类型；例：两个读者共享一次读取，其中一个取消可先退出，是否取消实际读取由上层协调。
 * 流程：无信号直接复用 → 已取消立即拒绝 → 监听取消与操作完成 → 首个结果生效并移除监听。
 */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	// 没有取消需求就返回原 Promise，避免额外创建等待包装。
	if (!signal) return operation;
	// 调用时已经取消，不必先注册监听再等待未来事件。
	if (signal.aborted) {
		// 即使本次不等了，原操作未来失败也会被观察；void 表示有意不等待这个兜底链。
		void operation.catch(() => {});
		// 以信号原本的原因拒绝，成功值类型仍为 T。
		return Promise.reject(abortReason(signal));
	}

	// 显式泛型让新 Promise 与原 operation 的结果类型保持一致。
	return new Promise<T>((resolve, reject) => {
		// 取消与 operation 完成可能紧邻发生，只接受第一个结果。
		let settled = false;
		// 闭包保存 signal 和 onAbort，结束时删除当前监听。
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		// 取消回调只结束这层等待，不调用 operation 的某个不存在的通用 cancel 方法。
		const onAbort = () => {
			// 如果原操作已经完成，不覆盖原来的成功/失败结果。
			if (settled) return;
			// 先标记再清理，防止同一轮中的另一个完成回调重复处理。
			settled = true;
			// 释放取消监听对闭包的引用。
			cleanup();
			// 让外层 await 按取消原因结束。
			reject(abortReason(signal));
		};

		// once 限制事件仅触发一次；正常完成路径仍会主动移除它。
		signal.addEventListener("abort", onAbort, { once: true });
		// 同时登记成功/失败处理；即使取消先赢，迟到的拒绝也不会无人处理。
		void operation.then(
			// 操作先成功时，原样返回 T 类型的值。
			(value) => {
				// 若已取消就忽略迟到的成功，不再改变外层 Promise。
				if (settled) return;
				// 当前成功路径占用最终结果。
				settled = true;
				// 不再需要观察取消事件。
				cleanup();
				// 解决外层 Promise，保留原成功值。
				resolve(value);
			},
			// unknown 说明抛出值不一定是 Error，本层原样传播而不假定它有 message。
			(error: unknown) => {
				// 取消先发生时，这次拒绝只被观察，不再重复 reject 外层。
				if (settled) return;
				// 当前错误路径占用最终结果。
				settled = true;
				// 释放监听后再向调用方传递错误。
				cleanup();
				// 不包装错误，调用方可以辨认原始异常类型或值。
				reject(error);
			},
		);
		// 再检查监听安装期间是否已经取消，覆盖“先读 aborted、后安装监听”的时间窗口。
		if (signal.aborted) onAbort();
	});
}
