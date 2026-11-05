// OAuth 轮询等流程的可取消等待；与 retry 文件中的内部等待器分开，必须由调用者传取消信号。
// 用途：等 ms 毫秒或提前响应取消。成功不返回数值，取消用 signal.reason 拒绝；例轮询登录前 await sleep(1000, signal)，取消后无需白等一秒。
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	// Promise 包装计时器；resolve 表示等待到期，reject 表示取消失败。
	return new Promise((resolve, reject) => {
		// 先检查已经取消的情况；在 Promise executor 里抛错会变成这个 Promise 的拒绝。
		signal.throwIfAborted();
		// 定义取消回调，注册后才会在取消发生时执行。
		const onAbort = () => {
			// 取消尚未到期的计时器，避免它稍后又试图报告完成。
			clearTimeout(timeout);
			// 保留原取消原因，不额外改成普通超时错误。
			reject(signal.reason);
		};
		// 安排 ms 毫秒后的完成回调；timeout 是供 clearTimeout 使用的句柄。
		const timeout = setTimeout(() => {
			// 正常到期后不再需要取消监听，解除它。
			signal.removeEventListener("abort", onAbort);
			// Promise<void> 成功只表示等完，没有正文值。
			resolve();
			// 计时长度来自调用参数；本函数不自行施加重试退避策略。
		}, ms);
		// 等待期间允许取消，once 避免同一监听重复触发。
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
