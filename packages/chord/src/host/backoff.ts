// Retry backoff per identity (§6): after a transient failure an identity waits 1 s, doubling up to 60 s. The entries
// hold no object, so a failed object is collected after its last reference while its window still runs.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现对象身份级重试退避。
// 职责：为一个 identity 记录最近延迟、窗口截止时间和计时器；暂时失败后 1s 起翻倍到 60s。
// 边界：不持有对象、不决定是否重试；到期只回调主机，由主机查对象并触发 attempt()。
// 上游：ChordObject 在 transient/broken 失败后调用 failed/delete；ref.retry() 调用 skip；Host 关闭时 clear。
// 下游：Host 的 #due(identity) 在窗口到期时重试；Failed.retryAt 来自 until()。
// 错误：没有显式错误路径；identity 只是字符串键，运行时不校验格式。
// 能力清单：
// - nextDelay(previous)：计算下一次退避毫秒数。
// - Backoff：failed/waiting/until/skip/ended/delete/clear 的计时器表。
// 组合与顺序：failed -> 新 Entry + setTimeout -> 到期 #due -> 主机重试；成功或永久失败 -> delete；
// 对象结束后已无对象可重试 -> ended 清理已过期项。
// 示例：backoff.failed(identity); const at = backoff.until(identity); backoff.skip(identity);
// 建议阅读顺序：FIRST_DELAY/MAX_DELAY -> nextDelay -> Entry -> Backoff.failed -> 查询与清理方法。

/** The delay after the first transient failure. */
// 数字中的下划线仅便于阅读；首次暂时性失败等待 1000 毫秒。
const FIRST_DELAY = 1_000;

/** The longest delay. */
// 延迟上限为 60 秒，不是达到后停止重试。
const MAX_DELAY = 60_000;

/**
 * The delay after a failure: 1 s after the first (no `previous` delay), then the previous one doubled, up to 60 s.
 * Identities, routines and job finishes back off alike.
 */
// 输入上次延迟或 undefined，返回此次退避毫秒数，不改状态；首次 1 秒，之后翻倍并限幅。
// 例：undefined → 1000，1000 → 2000，40000 → 60000；这只是计算，不创建计时器。
export function nextDelay(previous: number | undefined): number {
	// 三元表达式选择首次值或翻倍值，Math.min 把后者截在上限。
	return previous === undefined ? FIRST_DELAY : Math.min(previous * 2, MAX_DELAY);
}

/**
 * One identity's backoff: the delay of its last window, when that window ends (`Date.now()` time), and the timer ending
 * a window still running.
 */
// 每个身份保存上次延迟、墙上时钟截止点和可取消计时器；ReturnType 从 setTimeout 推导句柄类型。
// delay 供下次失败翻倍；until 是展示给引用 retryAt 的绝对时间；timer 为 undefined 表示窗口已过或在跳过中。
type Entry = { readonly delay: number; readonly until: number; timer: ReturnType<typeof setTimeout> | undefined };

/**
 * The host's backoff map. When a window ends, `due(identity)` runs: the host retries the identity's object, or
 * deletes the entry when there is none. An entry is deleted on success, on a broken failure, and when its window has
 * passed with nothing left to retry.
 */
export class Backoff {
	// 按身份字符串索引退避窗口，不把 ChordObject 存进表内。
	readonly #entries = new Map<string, Entry>();
	// 由主机提供到期回调；参数只含身份，主机再查该身份的对象是否仍存在。
	readonly #due: (identity: string) => void;

	// 创建退避表并保存到期回调，输入函数不在此时执行；例如主机传入查表并尝试激活的回调。无计时器副作用直到 failed。
	constructor(due: (identity: string) => void) {
		// 保存函数引用供以后窗口到期调用。
		this.#due = due;
	}

	/** Records a transient failure: a window of the previous delay doubled (1 s at first), then `due`. */
	// 记录该身份一次暂时性失败并重建计时器，返回 void；会保留延迟历史用于下次翻倍。
	// 例：同一身份连续两次失败，第二个窗口为 2 秒；到期只调用 due，由主机决定是否重试。
	failed(identity: string): void {
		// 查上次窗口；没有记录时取到 undefined。
		const previous = this.#entries.get(identity);
		// 可选链允许没有旧记录；存在旧计时器则先取消，避免两次到期。
		clearTimeout(previous?.timer);
		// 按旧延迟算本次等待长度。
		const delay = nextDelay(previous?.delay);
		// 新建记录，until 是供引用显示的绝对时间，不是剩余毫秒数。
		const entry: Entry = { delay, until: Date.now() + delay, timer: undefined };
		// 设定一个延后回调，并把句柄写回记录供 skip/delete 清理。
		entry.timer = setTimeout(() => {
			// 标记窗口已过，但保留 delay 供再次失败翻倍。
			entry.timer = undefined;
			// 通知主机该身份可以尝试；回调没有直接捕获对象。
			this.#due(identity);
		}, delay);
		// 用新记录覆盖该身份旧窗口。
		this.#entries.set(identity, entry);
	}

	/** Whether `identity` is inside a window: a new object for it waits for `due` before its first attempt. */
	// 查询身份是否还有等待计时器，返回布尔值，无副作用。例：failed 后为 true，窗口回调执行后为 false。
	waiting(identity: string): boolean {
		// 有计时器才算等待，只有历史 delay 的记录不算。
		return this.#entries.get(identity)?.timer !== undefined;
	}

	/** When the window of `identity` ends, while one runs: a failed reference's `retryAt`. */
	// 返回尚在等待的窗口截止时间；没有窗口返回 undefined，无副作用。例：可据此计算 UI 的 retryAt。
	until(identity: string): number | undefined {
		// 取该身份记录，允许不存在。
		const entry = this.#entries.get(identity);
		// 只有计时器仍存在时才公开截止点，避免暴露已过期的历史时间。
		return entry?.timer === undefined ? undefined : entry.until;
	}

	/** Ends the window at once (its object is retried now: `ref.retry()`, a wake); the delay stays for the next failure. */
	// 跳过该身份当前等待窗口，不删延迟历史，也不自行调用重试；返回 void。例：用户点 retry 时主机跳过后立即启动尝试。
	skip(identity: string): void {
		// 取该身份记录，允许不存在。
		const entry = this.#entries.get(identity);
		// 取消已有的到期回调，不存在句柄时无事发生。
		clearTimeout(entry?.timer);
		// 清除等待标记，记录中的 delay 仍在。
		if (entry !== undefined) entry.timer = undefined;
	}

	/** Its object ended: an entry whose window has passed gets no outcome any more and goes. */
	// 对象结束时清理已经过期的记录；仍在窗口内的记录保留到主机的到期处理。
	// 返回 void；例如窗口结束后最后一个对象释放，表项就删除，不再维持无用历史。
	ended(identity: string): void {
		// 只删有记录且不再等待的身份；短路 && 避免对不存在项继续查询。
		if (this.#entries.has(identity) && !this.waiting(identity)) this.#entries.delete(identity);
	}

	/** Forgets `identity` (success, a broken failure, or a window that passed with nothing to retry). */
	// 忘掉一个身份及计时器，返回 void；供成功、不可自动恢复失败或到期后已无对象时使用。例：成功后下次失败又从 1 秒开始。
	delete(identity: string): void {
		// 先停该身份仍可能触发的回调。
		clearTimeout(this.#entries.get(identity)?.timer);
		// 从 Map 移除延迟和截止点。
		this.#entries.delete(identity);
	}

	/** Forgets every identity (the host closes). */
	// 停止并删除全表的退避窗口，返回 void；主机关闭时调用，后续不会由这些计时器触发 due。例：关闭有十个窗口的主机会逐一清理。
	clear(): void {
		// 展开键得到本次清理清单，逐项复用 delete 的计时器清理逻辑。
		for (const identity of [...this.#entries.keys()]) this.delete(identity);
	}
}
