// An activation's `readyTimeout` deadline (slice 6a §9): one timer that eager migration work pauses and resumes with
// the budget it had left, so a long migration does not fail its object while other activations keep their bounds.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现可暂停的激活期限。
// 职责：在 readyTimeout 内没有完成激活时触发一次 expired；暂停期间不消耗预算。
// 边界：只计时，不判断对象状态、不重试；到期动作由创建者提供。
// 上游：Attempt.activate 创建，迁移与停放时 pause，结束时 resume 或 clear。
// 下游：expired 回调通常调用 Attempt.abandon，使激活等待与 opener 上下文中止。
// 错误：不抛出；回调自身的异常不在类内捕获。
// 能力清单：
// - Deadline：constructor(ms, expired)、pause()、resume()、clear()；私有 #start 管理计时器。
// 组合与顺序：构造启动 -> pause 扣已耗预算并 clearTimeout -> resume 用剩余预算重启 -> clear 永久终止。
// 示例：const d = new Deadline(5000, () => attempt.abandon(outcome)); d.pause(); d.resume(); d.clear();
// 建议阅读顺序：字段 -> constructor -> pause/resume/clear -> #start。

/** A deadline of `ms` calling `expired` once when reached; paused time does not count. */
// 一个可暂停的倒计时；只计算活跃时间预算，暂停期间墙上时间继续走但不扣预算。
export class Deadline {
	// 保存到期时执行的无参数回调，不在类内解释或吞掉它的异常。
	readonly #expired: () => void;
	/** The budget left when the timer last started (or paused). */
	// 计时器最近启动或暂停时剩余的毫秒数。
	#remaining: number;
	// 最近一次启动的 Date.now 时间，用来在暂停时扣除已经走过的部分。
	#started = 0;
	// 保存计时器句柄；undefined 表示当前没有已登记的句柄。
	#timer: ReturnType<typeof setTimeout> | undefined;
	// clear 置为 true 后，即使再 resume 也不能启动。
	#cleared = false;

	// 输入毫秒预算与到期回调，创建后立即启动计时器；不返回额外值。
	// 例：1000 毫秒预算运行 200 毫秒后 pause，再 resume 约剩 800 毫秒；调度延迟仍由运行环境决定。
	constructor(ms: number, expired: () => void) {
		// 保存计时到期处理函数。
		this.#expired = expired;
		// 初始化整个活跃时间预算。
		this.#remaining = ms;
		// 按当前剩余预算登记计时器，并记启动时间。
		this.#start();
	}

	/** Stops the clock; `resume` restarts it with the budget left. */
	// 暂停尚登记的计时器并扣去已经消耗的时间，返回 void；重复暂停不会重复扣减。
	// 例：迁移或依赖停放期间暂停激活期限；它不影响外部 getter 自己的超时。
	pause(): void {
		// 没有句柄时直接退出，防止把同一运行区间扣两遍。
		if (this.#timer === undefined) return;
		// 清理当前计时器；已执行的回调不能因此撤回。
		clearTimeout(this.#timer);
		// 清掉句柄，让 pause 幂等，也允许未 clear 的期限再次 resume。
		this.#timer = undefined;
		// 用当前墙上时间减启动时间作为已耗预算；最多扣到 0，不形成负数延迟。
		this.#remaining = Math.max(0, this.#remaining - (Date.now() - this.#started));
	}

	/** Restarts a paused clock. */
	// 继续一个暂停且未永久清理的期限，返回 void；已在运行时不重复排队。例：迁移 finally 中恢复，沿用暂停前剩余预算。
	resume(): void {
		// 两个条件都满足才调用内部启动方法。
		if (this.#timer === undefined && !this.#cleared) this.#start();
	}

	/** Ends the deadline: `expired` is never called. */
	// 永久结束这个期限并停止计时器，返回 void；之后 resume 无效。例：对象激活成功后清理，不再由此期限报警。
	clear(): void {
		// 清理当前计时器；已经触发的回调无法撤回。
		clearTimeout(this.#timer);
		// 清掉句柄并置永久终止标记，之后 pause/resume 都不会重启计时。
		this.#timer = undefined;
		// 记录永久终止，不把 clear 当作普通暂停。
		this.#cleared = true;
	}

	// 内部按 #remaining 启动一次计时器，返回 void，产生计时器副作用。例：剩 800 毫秒时登记相同延迟；调用方负责避免重复启动。
	#start(): void {
		// 记录本段计时开始点，供下一次 pause 扣预算。
		this.#started = Date.now();
		// 让运行环境到时调用 expired；回调结束不会自动把 #timer 置空，因此本类由调用方按激活生命周期清理。
		this.#timer = setTimeout(this.#expired, this.#remaining);
	}
}
