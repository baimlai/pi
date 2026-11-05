// Tests of the waiting helpers (§14): `sleep` resolving, rejecting with the abort reason, chaining delays above the
// timer limit and leaving no timer behind; `untilAborted`.

import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, withCancel } from "../../src/context/index.ts";
import { sleep, untilAborted } from "../../src/host/index.ts";
import { fakeTimers } from "../support.ts";

// Vitest 在注册阶段运行 describe 回调；fakeTimers 注册每例的虚拟时钟，时间推进不会真的等待一秒。
describe("sleep", () => {
	// 每例开始把时间设为零，结束恢复真实计时器，避免跨用例污染。
	fakeTimers();

	// 无参数测试：观察 sleep(1000) 的 Promise；999 毫秒未完成，再过 1 毫秒完成且无残留定时器。
	it("resolves after its delay", async () => {
		// 用布尔值观测 then 回调是否执行；sleep 的返回值本身是 void。
		let done = false;
		// void 表示此处故意不 await；否则还没机会推进虚拟时钟就会一直等待。
		void sleep(1_000, BACKGROUND_CONTEXT).then(() => {
			// sleep 成功后把观测值设为 true；回调无参数、无返回值。
			done = true;
		});
		// Async 版本也处理 Promise 微任务，让断言看得到 then 的结果。
		await vi.advanceTimersByTimeAsync(999);
		// 还差 1 毫秒，Promise 应保持待定。
		expect(done).toBe(false);
		// 推进剩下的时间，触发完成回调。
		await vi.advanceTimersByTimeAsync(1);
		// 确认完成，并检查计时器已经从虚拟队列移除。
		expect(done).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	// 输入可取消上下文和 60 秒延迟：取消应原样拒绝 reason，并清理等待；示例错误为 stop。
	it("rejects with the abort reason and clears its timer", async () => {
		// 对象解构同时取得派生上下文和取消函数，不改变背景上下文本身。
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		// 保存尚未完成的 Promise，随后主动取消它。
		const waiting = sleep(60_000, context);
		// 保留错误对象以便检查引用相等，而不只是错误消息相同。
		const reason = new Error("stop");
		// 取消同步触发 signal 的 abort 监听器。
		cancel(reason);
		// rejects 断言 Promise 拒绝；toBe 检查就是传入的同一个 Error。
		await expect(waiting).rejects.toBe(reason);
		// 原来的 60 秒计时器也必须删除。
		expect(vi.getTimerCount()).toBe(0);
	});

	// 先取消再 sleep(10)：应直接拒绝 before，不为已取消的等待创建计时器。
	it("rejects at once when its context is aborted already", async () => {
		// 建立本例独有的取消范围。
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		// 令 signal 在 sleep 被调用前已经 aborted。
		cancel(new Error("before"));
		// await 等待拒绝断言完成，这里无需推进时间。
		await expect(sleep(10, context)).rejects.toThrow("before");
		// 检查提前拒绝没有留下定时器。
		expect(vi.getTimerCount()).toBe(0);
	});

	// 测试超过单个计时器上限的延迟：先等一整段再等余数；另一次链式等待在中途取消并清理。
	it("chains timers for delays above 2^31-1 ms; an abort clears the chained timer", async () => {
		// ** 是幂运算，2^31-1 是实现中每段延迟的最大值。
		const limit = 2 ** 31 - 1;
		// 此观测值只由成功分支修改。
		let done = false;
		// 总时长比上限多 5000 毫秒，需要至少两个计时器依次完成。
		void sleep(limit + 5_000, BACKGROUND_CONTEXT).then(() => {
			// 第二段完成后才标记成功。
			done = true;
		});
		// 只推进第一整段，余下的 5000 毫秒应仍在等待。
		await vi.advanceTimersByTimeAsync(limit);
		// 不能因计时器溢出而提前完成。
		expect(done).toBe(false);
		// 链条只保留当前一段，不同时创建多段定时器。
		expect(vi.getTimerCount()).toBe(1);
		// 完成余数后应执行成功回调。
		await vi.advanceTimersByTimeAsync(5_000);
		expect(done).toBe(true);
		// 第二个等待单独使用可取消上下文。
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		// 建立三段长延迟，用于验证换段后也能清理。
		const long = sleep(3 * limit, context);
		// 第一段结束，第二段已经开始。
		await vi.advanceTimersByTimeAsync(limit + 1);
		// 此时取消必须清理第二段的计时器。
		cancel(new Error("late"));
		// 取消是拒绝而非成功，错误保留 late 消息。
		await expect(long).rejects.toThrow("late");
		// 成功链与取消链都不应残留计时器；本例未直接计数 abort 监听器。
		expect(vi.getTimerCount()).toBe(0);
	});
});

// 注册另一个机制的用例：untilAborted 的取消路径成功完成，与 sleep 的拒绝路径不同。
describe("untilAborted", () => {
	// 创建可取消上下文，证明取消前待定、取消后完成，再以同一已取消上下文调用也立即完成。
	it("resolves once its context is aborted, at once when it is already", async () => {
		// context 带 signal，cancel 触发该 signal。
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		// 通过 then 的副作用记录等待是否完成。
		let done = false;
		// 保存 then 返回的 Promise，后面 await 时也等待布尔值写入完成。
		const waiting = untilAborted(context).then(() => {
			// 取消后正常 resolve，回调因此运行。
			done = true;
		});
		// 让出一次微任务，排除函数无条件立即完成的错误实现。
		await Promise.resolve();
		// 未取消前不应完成。
		expect(done).toBe(false);
		// 不传 reason 也能触发取消；本机制不返回 reason。
		cancel();
		// 正常 await 成功，证明取消没有导致拒绝。
		await waiting;
		expect(done).toBe(true);
		// 已取消上下文应走立即完成分支，不能再次等待一个不会重发的 abort 事件。
		await untilAborted(context);
	});
});
