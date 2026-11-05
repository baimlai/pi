// 合并多个取消来源，供 Codex/Mistral 请求在“用户取消”或其他取消源触发时统一结束；本模块不发网络请求。
// 返回值的接口：既提供统一 signal，也提供清理监听器的函数；interface 只用于 TS 检查。
export interface CombinedAbortSignal {
	// ? 表示可能没有信号：没有传入有效来源时不必创建一个虚构来源。
	signal?: AbortSignal;
	// 保存一个无参数、无返回值的函数；请求结束后调用它解除监听。
	cleanup: () => void;
}

// 用途：任一来源取消就取消合成信号。输入只读信号数组，输出 signal/cleanup；例 [用户信号, 超时信号]，任一触发即传播原因。cleanup 必须由调用方在操作结束后调用。
export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	// 去掉 undefined；“signal is AbortSignal”是类型谓词，告诉 TS 筛完后每个元素都有信号。
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	// 没有取消来源，不分配控制器，也没有监听需要清理。
	if (activeSignals.length === 0) {
		// 返回空清理函数，让调用方统一写 cleanup()，不必另加分支。
		return { cleanup: () => {} };
	}
	// 只有一个来源时直接复用，无需创建多余的转发监听。
	if (activeSignals.length === 1) {
		// 将原信号交出去；本模块没注册监听，所以清理函数可以为空。
		return { signal: activeSignals[0], cleanup: () => {} };
	}

	// 控制器负责发出取消；它的 signal 才是给下游观察的只读信号。
	const controller = new AbortController();
	// 记录每次注册的“来源信号 + 回调”，稍后必须用同一个回调引用才能删除监听。
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	// 定义转发取消的小回调；定义函数时不会立即取消。
	const abort = (signal: AbortSignal) => {
		// 只接收第一个取消原因；后到的来源不能覆盖已经确定的原因。
		if (!controller.signal.aborted) {
			// 取消合成信号，并原样转发来源 reason，例如用户指定的 Error。
			controller.abort(signal.reason);
		}
	};

	// 逐个接线，for...of 遍历数组元素，不是下标。
	for (const signal of activeSignals) {
		// 某来源在接线前就已取消，合成结果也应立即取消。
		if (signal.aborted) {
			// 通过上面的转发函数保留取消原因。
			abort(signal);
			// 已经得到取消结果，无需继续给后面的来源安装监听。
			break;
		}
		// 闭包记住本次循环的来源，事件发生时将该来源传给 abort。
		const listener = () => abort(signal);
		// 监听一次取消事件；once 只负责触发后移除，未触发的监听仍要由 cleanup 清理。
		signal.addEventListener("abort", listener, { once: true });
		// 把清理所需信息记下来；对象字段简写等价于 signal: signal。
		listeners.push({ signal, listener });
	}

	return {
		// 对外只暴露信号，调用方不能借返回值直接触发这个内部控制器。
		signal: controller.signal,
		// 返回清理动作，供网络请求完成、失败或取消后的 finally 使用。
		cleanup: () => {
			// 对象解构：一次取出每条记录中配对的信号和监听函数。
			for (const { signal, listener } of listeners) {
				// 解除本模块安装的监听；不会撤销已经发生的取消。
				signal.removeEventListener("abort", listener);
			}
		},
	};
}
