// Waiting helpers for routines, jobs and handlers (§14): `sleep(ms, ctx)` and `untilAborted(ctx)`, which end with
// their context, leaving no timer or listener behind. Portable: timers and `AbortSignal` only.
// 本文件提供两个可取消的等待原语：延时一段时间，或一直等到上下文被取消。
// 上游是 routine、job 和 handler 的异步流程；结果只是 Promise，不启动后台循环。取消时会清掉计时器和监听器。
// 所属模块：packages/chord/src/host 的通用异步等待工具。
// 上下游：routine/job/handler 调用 sleep/untilAborted；只依赖 Context 的 abortSignal。结果 Promise<void>，取消时以原因拒绝。
// 能力清单：
// - MAX_TIMER：单个 setTimeout 能可靠表示的最大延时。
// - sleep(ms, context)：可取消延时，超过上限的等待自动分段。
// - untilAborted(context)：只等待取消，永不正常兑现。
// 组合关系：sleep 反复调用 setTimeout 直到总时长耗尽；每段都监听 abort，结束或取消时移除监听。
// 示例：await sleep(30_000, ctx); // ctx 取消时立即以取消原因拒绝，而不是继续等满 30 秒。
// 阅读顺序：先 untilAborted 理解取消原语，再读 sleep 的分段计时与清理。

import type { Context } from "../context/index.ts";

/** The longest delay one timer takes (a longer one fires at once). */
// 浏览器和 Node 的 setTimeout 用 32 位有符号整数保存延时，超过 2^31-1 会溢出成立即触发；
// 因此 sleep 把更长的等待拆成多个计时器，这个常量就是单个计时器的上限。
const MAX_TIMER = 2 ** 31 - 1;

/**
 * Resolves after `ms` milliseconds; rejects with the abort reason once `context` is aborted, clearing its timer and
 * listener. Delays above the timer limit (2^31-1 ms) are chained timers.
 */
// 等待 ms 毫秒；context 取消时立即拒绝，原因为 signal.reason。无副作用残留（计时器和监听器都会被清理）。
// 返回 Promise<void>；正常到点兑现，取消时拒绝。ms 不是有限数或为负时由运行时计时器自行处理，本函数不额外校验。
// 示例：await sleep(1000, ctx) 等 1 秒；若 ctx 在 300ms 时取消，Promise 以取消原因拒绝，后续不再触发计时器。
export function sleep(ms: number, context: Context): Promise<void> {
	// abortSignal 是可选的：上下文可以根本不支持取消。`?.` 在 undefined 上短路，不会抛错。
	const signal = context.abortSignal;
	// 已经取消时不必创建计时器；signal.reason 是 AbortController.abort 传入的任意值。
	if (signal?.aborted) return Promise.reject(signal.reason);
	// Promise.withResolvers 一次取得 promise 和它的 resolve/reject，便于闭包在计时器与取消监听之间共享。
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	// ReturnType<typeof setTimeout> 从函数类型推导返回类型；不同运行时的计时器句柄类型不同，不写死 number。
	let timer: ReturnType<typeof setTimeout> | undefined;
	// 取消回调：先停掉当前计时器，再以取消原因拒绝。即使计时器已经触发，clearTimeout 也是安全的空操作。
	const abort = (): void => {
		clearTimeout(timer);
		reject(signal?.reason);
	};
	// 递归安排剩余等待；每个计时器最多等 MAX_TIMER，剩余部分在回调里继续。
	const wait = (left: number): void => {
		timer = setTimeout(
			() => {
				// 还有超出一轮的时长就再排一个计时器，不兑现 Promise。
				if (left > MAX_TIMER) return wait(left - MAX_TIMER);
				// 最后一轮到点：先移除取消监听，避免上下文之后取消时再次调用 abort。
				signal?.removeEventListener("abort", abort);
				resolve();
			},
			// Math.min 保证传给 setTimeout 的延时不溢出。
			Math.min(left, MAX_TIMER),
		);
	};
	// { once: true } 让监听器在第一次 abort 后自动移除；没有 signal 时 ?. 使整行变成空操作。
	signal?.addEventListener("abort", abort, { once: true });
	// 启动第一轮等待。此时 promise 还没有兑现，调用方可以继续挂 then/await。
	wait(ms);
	return promise;
}

/** Resolves once `context` is aborted (never without an abort signal); leaves no listener behind. */
// 返回一个只在上下文取消时兑现的 Promise；没有取消信号时永远不兑现（用于让调用方保持等待）。
// 已经取消时立即兑现。正常路径只挂一个 once 监听器，兑现后自动移除；不产生计时器。
// 示例：await untilAborted(runCtx) 会一直挂起，直到该次运行的上下文被取消。
export function untilAborted(context: Context): Promise<void> {
	const signal = context.abortSignal;
	// 没有取消能力就没有“被取消”这个事件；返回永不 settle 的 Promise，而不是立即兑现或拒绝。
	if (signal === undefined) return new Promise(() => {});
	// 已经取消：直接兑现，避免安装一个永远不会再触发的监听器。
	if (signal.aborted) return Promise.resolve();
	// 取消事件的监听器只调用 resolve；{ once: true } 保证触发一次后 listener 被清理。
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
