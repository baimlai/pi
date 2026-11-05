// The `unbound_long` report (decision "Mistakes that wait are reported at once" (c)): a request waiting unbound after
// the host's publication (a type or registry not served here, not at its version, a registry whose first `compose`
// threw) is reported once through `onError` after 5 s, naming what it waits for and why; it keeps waiting as before.
// One clock per host, one timer armed for the earliest wait not reported yet: no timer per request.
// 本文件只负责“等待多久后报告一次”的计时，不决定请求何时能绑定。上游是 UnboundIndex.add；
// 结果通过构造时传入的 report 回调（通常是 host.onError）送出，然后该请求从时钟表移除，但索引里的等待不受影响。
// 所属模块：packages/chord/src/host 的无绑定请求超时报告（unbound_long）。
// 上下游：UnboundIndex.add/failed/stop 调用 start/failed/stop；时钟通过构造回调把 UnboundLong 交给 host.onError。
// 结果：每个请求最多报告一次；close 清空全部计时，不再回调。本文件不抛业务错误。
// 能力清单：
// - UnboundLong：报告负载（kind、等待名称、原因、起始时间、错误）。
// - REPORTED_AFTER：5 秒报告阈值。
// - UnboundClock：start/failed/stop/close 与内部 #sweep 组成的单计时器调度器。
// 组合关系：start 登记并布置最早到期项 -> 到期 #sweep 报告并安排下一项；failed 只更新错误；stop/close 移除。
// 示例：const clock = new UnboundClock((e) => host.onError(e)); clock.start(request, "Notes", err); // 5 秒后收到一次报告。
// 阅读顺序：先 UnboundLong 字段，再 start/stop 的登记语义，最后 #sweep 的重排逻辑。

import type { ChordError } from "../data/index.ts";

/** What the clock reports: a request waiting unbound for `waitingFor` since `since` (`Date.now()` time), and why. */
// 报告对象是普通数据，不是 Error 实例。kind 是判别标签，让接收方能在多种 HostError 中收窄。
// waitingFor 是给人看的名称；error 是最近一次失败原因；since 是开始等待的 Date.now() 毫秒值。
// readonly 只阻止 TypeScript 赋值，运行时对象没有冻结。
export type UnboundLong = {
	readonly kind: "unbound_long";
	/** The type's name, or `registry <name>`. */
	readonly waitingFor: string;
	readonly error: ChordError;
	readonly since: number;
};

/** One wait not reported yet: what it waits for, its latest error, since when. */
// 内部记录比公开报告少一个 kind 字段；error 不是 readonly，因为 failed() 会替换成最新错误。
// 这种“公开形状 + 内部可变字段”的拆分让报告保持纯数据，同时允许等待期间更新原因。
type Wait = { readonly waitingFor: string; error: ChordError; readonly since: number };

/** How long a request waits unbound before it is reported (decided: 5 s). */
// 数字分隔符 `_` 只影响可读性，值仍是 5000 毫秒。这是“报告一次”的阈值，不是请求超时。
const REPORTED_AFTER = 5_000;

/** A host's waits not reported yet and the one timer of their sweep. */
// 一个宿主只有一个时钟。Map 以请求对象为键，值记录等待信息；插入顺序就是开始等待的顺序。
// 同一时间只挂一个 setTimeout，避免每个请求一个计时器；#sweep 每次重排到最早到期者。
export class UnboundClock {
	/** By request, in the order they started, so by `since`: the sweep reads from the front and stops at the first due later. */
	// Map 保持插入顺序，因此按插入顺序遍历等价于按 since 从小到大；扫描到第一个未到期者即可停止。
	readonly #waits = new Map<object, Wait>();
	// 报告回调由宿主注入；时钟不直接依赖 host，便于测试。
	readonly #report: (error: UnboundLong) => void;
	// 当前唯一计时器的句柄；undefined 表示没有等待或已经清理。
	#timer: ReturnType<typeof setTimeout> | undefined;

	// 保存报告回调，不启动计时器；例如 new UnboundClock(onError) 之后，只有 start 才会安排报告。
	constructor(report: (error: UnboundLong) => void) {
		this.#report = report;
	}

	/** `request` waits unbound for `waitingFor` with `error`: reported after 5 s unless it stops before. */
	// 登记一个请求的等待。输入请求对象、等待目标名称和当前错误；无返回。
	// 同一请求只登记第一次（否则每次唤醒都会重置起点）；若还没有计时器，就为最早这次等待安排一次扫描。
	// 示例：start(req, "Notes", err) 后 5 秒，若期间没 stop，report 会收到 unbound_long。
	start(request: object, waitingFor: string, error: ChordError): void {
		// has 防重：等待不是从最后一次错误重新计时，而是从第一次进入无绑定状态算起。
		if (this.#waits.has(request)) return;
		// Date.now() 记录起点；error 保留原对象引用，后续 failed 可以就地替换。
		this.#waits.set(request, { waitingFor, error, since: Date.now() });
		// `??=` 只在 #timer 为 null/undefined 时赋值，避免每个请求都重置一个计时器。
		this.#timer ??= setTimeout(() => this.#sweep(), REPORTED_AFTER);
	}

	/** The wait of `request` has a new error (a registry's failure changed): the report names the latest. */
	// 更新等待中的最新错误。输入请求和错误；无返回。请求已经停止或从未登记时是空操作。
	// 例如注册表第一次 compose 失败后恢复又失败，报告应展示最近一次原因，而不是最初那条。
	failed(request: object, error: ChordError): void {
		const wait = this.#waits.get(request);
		// 只在仍登记时修改；Wait.error 是内部可变字段。
		if (wait !== undefined) wait.error = error;
	}

	/** `request` bound, ended or was woken: no report for this wait. */
	// 请求已绑定、结束或被唤醒：取消它的报告。无返回；未知请求同样安全。
	// 只有仍然存在别的等待时才保留计时器；最后一个等待移除后必须清掉计时器，避免无意义地唤醒事件循环。
	stop(request: object): void {
		// delete 返回是否真的删除；没删到或还有剩余等待，都无需处理计时器。
		if (!this.#waits.delete(request) || this.#waits.size > 0) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** The host closed: nothing is reported any more. */
	// 宿主关闭：丢弃全部等待，不再报告。无返回；之后即使有残留调用也不会触碰已关闭的宿主。
	close(): void {
		this.#waits.clear();
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Reports every wait due, each once, then arms the timer for the next one, if any. */
	// 扫描到期等待。私有方法，无参数无返回；可能安排下一次扫描。
	// 因为 Map 按开始时间有序，遇到第一个尚未到期的项就可以停下，把它作为下一次计时目标。
	#sweep(): void {
		// 当前计时器已经触发，先清空句柄；后面的分支会按需要重新赋值。
		this.#timer = undefined;
		const now = Date.now();
		// 每项解构为请求键和等待记录；删除当前项不会影响 Map 的继续遍历。
		for (const [request, wait] of this.#waits) {
			const due = wait.since + REPORTED_AFTER;
			if (due > now) {
				// 还没到期：为这一项安排剩余时间，然后结束本轮（后面的项只会更晚）。
				this.#timer = setTimeout(() => this.#sweep(), due - now);
				return;
			}
			// 到期：先移除，保证只报告一次；再解构出报告字段。
			this.#waits.delete(request);
			const { waitingFor, error, since } = wait;
			// 回调是宿主边界，可能抛错；本方法不捕获，由计时器回调的调用方处理。
			this.#report({ kind: "unbound_long", waitingFor, error, since });
		}
	}
}
