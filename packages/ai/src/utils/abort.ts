// 认证与 Models 等公共接口使用的取消辅助函数；“停止等待”不代表底层操作一定已停止。
// 用途：取取消原因，缺失时补 AbortError。输入信号，输出任意 reason 或 Error；例 controller.abort("stop") 会原样得到字符串 stop，不抛错。
function abortReason(signal: AbortSignal): unknown {
	// reason 的类型可以是任意值；显式提供了原因就保留原值。
	if (signal.reason !== undefined) return signal.reason;
	// 没有原因时新建常规 Error，保证调用者能收到可读说明。
	const error = new Error("The operation was aborted");
	// 用约定的 name 标记取消错误；这不是声明一个新的 TS 类型。
	error.name = "AbortError";
	// 返回错误对象供调用者 reject，不在这个函数里 throw。
	return error;
}

/** Create an operation-local signal for public APIs whose signal is optional. */
// 用途：把可选信号变成操作内部总可用的信号。例 operationSignal(undefined) 创建独立未取消信号；已有信号则原样返回。
export function operationSignal(signal?: AbortSignal): AbortSignal {
	// ?? 只在 null/undefined 时取右边；不向外返回新控制器，因此外部无法主动取消新建的内部信号。
	return signal ?? new AbortController().signal;
}

/**
 * Stop waiting for an operation when its signal aborts while continuing to
 * observe the abandoned promise so a later rejection is always handled.
 */
// 用途：在操作完成与取消之间抢先返回。泛型 T 保留成功结果类型；取消时拒绝等待，但继续观察原 Promise，避免它稍后失败变成未处理拒绝。例慢认证尚未结束，用户取消可先退出等待。
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	// 开始等待前就已取消，直接走拒绝路径。
	if (signal.aborted) {
		// 仍观察原操作的后续拒绝；void 表示有意不等待 catch 返回的 Promise，并不取消操作。
		void operation.catch(() => {});
		// 返回一个已拒绝的 Promise，错误原因按上面的统一规则取得。
		return Promise.reject(abortReason(signal));
	}

	// 创建中间 Promise；resolve 保留 T，reject 用于取消或原操作失败。
	return new Promise<T>((resolve, reject) => {
		// 记录中间 Promise 是否已经选定结果，避免两个竞争分支重复执行清理逻辑。
		let settled = false;
		// 保存解除取消监听的动作；真正调用时 onAbort 已完成初始化。
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		// 注册给信号的回调，只结束本次等待，不直接终止 operation。
		const onAbort = () => {
			// 另一分支已经完成就忽略后到的事件/结果。
			if (settled) return;
			// 当前分支赢得竞争，标记为已经决定结果。
			settled = true;
			// 不再需要取消监听，及时释放闭包引用。
			cleanup();
			// 用取消原因拒绝中间 Promise。
			reject(abortReason(signal));
		};

		// 将本次等待接到信号上；事件最多触发这份监听一次。
		signal.addEventListener("abort", onAbort, { once: true });
		// 同时观察原 Promise 的成功与失败，后到的原结果也算被正常处理。
		void operation.then(
			// 原操作成功时执行的回调，value 的类型由泛型 T 决定。
			(value) => {
				// 另一分支已经完成就忽略后到的事件/结果。
				if (settled) return;
				// 当前分支赢得竞争，标记为已经决定结果。
				settled = true;
				// 不再需要取消监听，及时释放闭包引用。
				cleanup();
				// 把原操作的成功值交给中间 Promise 的调用者。
				resolve(value);
			},
			// 拒绝原因来自外部异步操作，按 unknown 接收，不能假定必然是 Error。
			(error: unknown) => {
				// 另一分支已经完成就忽略后到的事件/结果。
				if (settled) return;
				// 当前分支赢得竞争，标记为已经决定结果。
				settled = true;
				// 不再需要取消监听，及时释放闭包引用。
				cleanup();
				// 原操作失败且尚未取消时，原样传播拒绝原因。
				reject(error);
			},
		);
		// 接线完成后再检查一次取消，覆盖注册前后交错发生的取消时序。
		if (signal.aborted) onAbort();
	});
}
