// Parked calls (§3, §7): calls made on a loading reference, queued in the order they were made until it goes live,
// each with its own deadline from the moment it was called (the reference's `readyTimeout`, never renewed).

// 所属：packages/chord/src/host 中“引用尚未就绪时挂起调用”的队列（设计 §3、§7）。
// 职责边界：只保存调用与截止时间，不发送消息；发送、失败与释放由引用绑定决定。每个调用从入队时刻起算截止时间，永不续期。
// 上游：reference.ts 在 loading 引用上 call 时交给 ParkedCalls.park；引用 live/fail/release 时调用 flush/reject。
// 下游：flush 的发送函数（引用已绑定时真正调用对象方法）；超时错误为 unavailable/park_timeout，释放错误由调用方传入。
// 能力清单：
// - ParkedCalls（唯一导出类）：
//   - waiting：是否还有排队调用。
//   - park：登记一次调用，返回其 Promise，并按调用者取消与截止时间结算。
//   - flush：引用 live 后按入队顺序发送；发送前重新检查 live，已过期调用直接拒绝。
//   - reject：引用失败/释放时以同一错误拒绝全部排队调用。
//   - #expire/#take：#expire 按绝对时间构造 park_timeout；#take 负责清理计时器与取消订阅。
// 组合与典型顺序：ref.call -> park 入队 -> 引用 live -> flush 发送（send 返回 Promise）-> 每个调用 settle；
// 或引用失败 -> reject；或到期 -> expire。例子：hold 后立即 ref.bump()，调用排队，live 后按序发出。
// 示例：const parked = new ParkedCalls(1000, "Counter(1)");
//       const result = parked.park("bump", 1, context);
//       parked.flush((method, args, ctx) => send(method, args, ctx), () => binding.live());
// 建议阅读顺序：ParkedCall 字段 -> ParkedCalls 字段/构造 -> park -> flush -> reject -> #expire/#take。

import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";

/** One queued call: what to send, how its caller is settled, its deadline (`Date.now()` time) and what ends its wait. */
// 一条排队调用：方法名、参数、调用者上下文、Promise 的结算函数、绝对截止时间、计时器以及可选的取消函数。
// resolve/reject 来自 Promise.withResolvers，队列只负责在正确时机调用其中一个。
type ParkedCall = {
	readonly method: string;
	readonly args: unknown;
	readonly context: Context;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly due: number;
	readonly deadline: ReturnType<typeof setTimeout>;
	readonly cancel: (() => void) | undefined;
};

/**
 * The queue of one reference's parked calls. A call leaves it when it is sent, at its deadline (`unavailable/
 * park_timeout`), when its caller cancels, or rejected with the queue (the reference failed or was released).
 */
// 一个引用对应一个队列实例。构造时给定每个调用的等待上限（毫秒）和用于错误消息的引用标签。
// 队列本身不发送消息，只保存调用；发送由 flush 的调用者决定。
// 例子：hold 后立即 ref.bump()，调用进入队列；引用 live 时 flush 把 bump 发出去。
export class ParkedCalls {
	/** In the order the calls were made (a `Set` keeps insertion order and deletes in constant time). */
	// Set 保留插入顺序，因此 flush 能按调用先后发送；删除单个元素是 O(1)。
	readonly #calls = new Set<ParkedCall>();
	// 每个调用允许等待的毫秒数；引用不会再为它续期。
	readonly #timeout: number;
	// 出错消息中使用的引用标签，例如 "Note(1)"。
	readonly #label: string;

	// 保存超时与标签；不做其他动作。
	constructor(timeout: number, label: string) {
		this.#timeout = timeout;
		this.#label = label;
	}

	/** Whether calls are queued: a new call waits behind them, also while they are being sent. */
	// 队列非空即为 true；正在 flush 时元素先被取出再发送，所以“正在发送”的调用看不到，但新调用仍要排在剩余调用之后。
	get waiting(): boolean {
		return this.#calls.size > 0;
	}

	/** Queues a call; settles as the call it becomes once sent, or with why it left the queue. */
	// 入队一个调用并返回 Promise：之后由 flush 发送并 resolve，或由超时、取消、reject 结算。
	// 副作用：设置计时器，可能向 ctx 的 abort 信号注册监听。例如 park("bump", [], ctx)。
	park(method: string, args: unknown, context: Context): Promise<unknown> {
		// 先取取消信号；上下文已经在入队前被取消时立即抛出，避免把死调用放进队列。
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		// withResolvers 把 Promise 和它的两个结算函数一起取出，供队列稍后使用。
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		// 截止计时器：从入队时开始计时，不因引用状态变化而重置。
		const deadline = setTimeout(() => this.#expire(call), this.#timeout);
		// cancel 在信号触发时移除调用并拒绝；undefined 表示没有信号可监听。
		let cancel: (() => void) | undefined;
		if (signal !== undefined) {
			cancel = () => {
				// 先出队并清掉计时器，再用取消原因拒绝调用者。
				this.#take(call);
				reject(signal.reason);
			};
			// once: true 让监听在第一次取消后自动移除；#take 里还会显式移除一次。
			signal.addEventListener("abort", cancel, { once: true });
		}
		// due 是绝对毫秒时间戳，flush 用它判断调用是否已过期。
		const due = Date.now() + this.#timeout;
		// call 在闭包中被引用：上面的计时器和 cancel 在对象创建前登记，但真正执行时对象已存在。
		const call: ParkedCall = { method, args, context, resolve, reject, due, deadline, cancel };
		this.#calls.add(call);
		return promise;
	}

	/**
	 * Sends the queued calls in order through `send`, each only while `live()` still holds: sending one runs code
	 * (a handler's synchronous part) that may release or drop the reference, and the rest then stays queued or is
	 * rejected by that; or that makes a new call, which is queued behind the rest and sent in this loop. A call whose
	 * deadline passed while earlier ones ran (their timers could not fire) is rejected instead of sent.
	 */
	// 按入队顺序发送尚未过期的调用。send 返回 Promise；发送本身不等待其结果，先把调用者 Promise 接到 send 的结果上。
	// live() 每次迭代都检查：前一个处理器的同步部分可能释放引用，后续调用应停止发送。
	// 例子：排队的两个调用在 live 后依次发送；若第一个处理器同步 release，第二个留在队列。
	flush(send: (method: string, args: unknown, context: Context) => Promise<unknown>, live: () => boolean): void {
		// 遍历当前 Set；发送过程中新加入的调用会排在末尾，本次循环也能看到。
		for (const call of this.#calls) {
			// 引用已不再 live：停止发送，剩余调用继续留在队列中（由引用状态变化决定后续）。
			if (!live()) return;
			// 事件循环被前一个调用的同步代码占用时计时器可能来不及触发，这里补做过期判断。
			if (Date.now() >= call.due) {
				this.#expire(call);
				continue;
			}
			// 先出队（清计时器与监听），再发送；这样发送期间队列只反映仍未处理的调用。
			this.#take(call);
			send(call.method, call.args, call.context).then(call.resolve, call.reject);
		}
	}

	/** Rejects every queued call with `error`. */
	// 引用失败或释放时清空队列：每个调用先出队，再用同一个错误拒绝。
	// 例子：引用 broken 后，队列中的调用都以该失败原因 reject。
	reject(error: unknown): void {
		for (const call of this.#calls) {
			this.#take(call);
			call.reject(error);
		}
	}

	/** `call`'s deadline passed: `unavailable/park_timeout`. */
	// 超时路径：出队后构造 unavailable/park_timeout 错误，消息里带上等待时长和引用标签。
	#expire(call: ParkedCall): void {
		this.#take(call);
		const message = `${this.#label}: a call waited ${this.#timeout} ms for its reference to go live`;
		call.reject(new ChordError({ code: "unavailable", reason: "park_timeout", message }));
	}

	/** Takes `call` out of the queue: its deadline and cancellation stop. */
	// 统一出队：删除 Set 项、清除计时器、移除 abort 监听；重复调用是安全的（delete/clear 无副作用）。
	#take(call: ParkedCall): void {
		this.#calls.delete(call);
		clearTimeout(call.deadline);
		if (call.cancel !== undefined) call.context.abortSignal?.removeEventListener("abort", call.cancel);
	}
}
