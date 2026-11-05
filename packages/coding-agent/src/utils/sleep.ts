// 用Promise等待一段时间，供Agent重试退避使用；取消只结束这次等待，不会替调用方终止模型或子进程。
/**
 * Sleep helper that respects abort signal.
 */
// 输入毫秒数及可选取消信号，返回Promise<void>：到时成功、已取消或途中取消则以Error("Aborted")拒绝。
// 例如await sleep(1000, controller.signal)等待约1秒；调用controller.abort()可让上层catch提前结束退避。
// 本实现不校验ms，采用Node计时器规则；也没有在成功后移除abort监听，Promise一旦完成后再reject不会改变结果。
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	// Promise执行器立刻安装计时器/监听；resolve成功，reject进入await调用方的catch。
	return new Promise((resolve, reject) => {
		// ?.允许调用方不提供signal；已经取消时不再创建定时器。
		if (signal?.aborted) {
			// 普通Error而非DOMException，判断方式需遵守调用方实际约定。
			reject(new Error("Aborted"));
			// reject本身不停止执行器，所以还需return跳过下面的注册。
			return;
		}

		// 延迟结束时调用resolve，没有返回数值；计时器不是同步阻塞或精确实时保证。
		const timeout = setTimeout(resolve, ms);

		// 没信号则跳过注册；箭头函数捕获本次timeout和reject，在未来abort事件触发时执行。
		signal?.addEventListener("abort", () => {
			// 取消尚未触发的成功计时器，避免继续保留等待资源。
			clearTimeout(timeout);
			// 拒绝当前等待，让重试逻辑识别取消；若之前已成功，Promise状态不会反转。
			reject(new Error("Aborted"));
		});
	});
}
