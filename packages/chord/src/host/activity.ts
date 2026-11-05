// Keep-alive counts (§3, R26): `host.activity`, a JSON watchable of the work keeping a host busy, for the app's
// supervisor. Counters are kept where the work happens; their changes in one microtask turn are one publication.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现 host.activity 保活计数。
// 职责：维护 references/calls/jobs/lingering 四个计数，把同一微任务轮次内的多次增减合并为一次发布。
// 边界：不统计工作本身，也不校验增减是否配对；计数发生在各业务点，本文件只聚合与发布。
// 上游：Host 构造时创建 Activity；引用、Attempt、作业与 linger 逻辑在发生点调用 count()。
// 下游：watch/derive 订阅它；发布经 Source 批次，读取 value 得到 JSON 快照
// { references, calls, jobs, lingering }。
// 错误：文件内不产生业务错误；非法 kind 在开发期被 keyof 拒绝，运行时没有检查。
// 能力清单：
// - ActivityCounts：四个只读计数字段的类型，仅编译期约束，运行时不冻结。
// - Activity：Source 子类，提供 count(kind, delta) 与 value，并把变更发布给订阅者。
// 组合与顺序：count 修改原始计数 -> 清空快照缓存 -> 若有人观察则排一个微任务 -> 微任务在批次内 changed()
// -> 批次交付时 deliver() 发布 [["r", snapshot]]。
// 示例：host.activity.count("calls", 1); try { await work(); } finally { host.activity.count("calls", -1); }
// 建议阅读顺序：ActivityCounts -> Activity 字段 -> value -> count -> deliver。

import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import { Source } from "../state/internal.ts";

/** What `host.activity` counts. */
// 活跃工作计数的只读类型；readonly 只限制 TypeScript 调用方写字段，运行时不冻结对象。
export type ActivityCounts = {
	/** Holds arriving over links and served here. */
	// 到达此主机并在这里处理的 hold 请求数；未绑定但仍等待的请求也由其调用处计数。
	readonly references: number;
	/** Method calls running on this host, local and remote. */
	// 在此主机尚未结束的方法处理器数，不只限于网络调用。
	readonly calls: number;
	/** Running jobs (slice 5). */
	// 正在运行或完成收尾的作业数，阻塞作业不占这个保活计数。
	readonly jobs: number;
	/** Objects kept live by their type's `linger` after their last reference. */
	// 最后一个引用释放后，仍在 linger 保温期内的对象数。
	readonly lingering: number;
};

/**
 * `host.activity`. A count marks it changed; while it is watched or derived from, the first change of a microtask turn
 * schedules one publication, a batch that gives its watches the counts as they are then (`[["r", counts]]`: a slow
 * watch gets the newest counts) and marks derives over it. Its value is built from the counters when read or
 * published.
 */
// 继承 Source 的订阅与批次机制；四个计数是原始数据，发布时才生成 JSON 快照。
export class Activity extends Source {
	// # 表示运行时私有字段；readonly 禁止替换这张表，但允许后面增加或减少其中计数。
	readonly #counts = { references: 0, calls: 0, jobs: 0, lingering: 0 };
	/** The counts as last read, until the next change. */
	// 缓存最近读取的快照；undefined 表示计数改变后需要重建。
	#value: ActivityCounts | undefined;
	// 标记是否已有发布微任务，避免同一轮多次增减各排一次发布。
	#scheduled = false;

	// 读取当前计数的 JSON 快照，无参数；首次或变更后浅拷贝四个数字并缓存。
	// 例：count("calls", 1) 后读取会看到 calls 为 1；读取本身不发送通知。
	get value(): JsonValue {
		// ??= 只在缓存为 null/undefined 时赋值；展开对象复制数字，之后原计数变化不会修改旧快照。
		this.#value ??= { ...this.#counts };
		// 返回这次缓存的快照指针，同一计数版本的多次读取共享它。
		return this.#value;
	}

	/**
	 * Adds `delta` to the count of `kind`; published with the turn's other changes. Nothing is scheduled while nobody
	 * watches or derives from it: a later watch or derive reads the counts as they are then.
	 */
	// 给 kind 指定的计数加 delta，返回 void；keyof 在开发时把名称限制为四种字段。
	// 会清掉快照缓存；有人观察时安排一次微任务发布。例如进入/退出调用分别传 calls 与 1/-1；这里不做运行时非负校验。
	count(kind: keyof ActivityCounts, delta: number): void {
		// 按字段名原地累加；由实际开始/结束工作的调用点保证增减配对。
		this.#counts[kind] += delta;
		// 使下次 value 读取重新抓取四个数字。
		this.#value = undefined;
		// 已排队则合并变更；既无 watch/订阅者又无依赖者时不排任务，之后读取仍会得到最新计数。
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		// 在排队前立刻置位，让本轮后续 count 共享此次发布。
		this.#scheduled = true;
		// 注册当前同步调用结束后运行的回调；回调读取届时计数，因此一次发布合并这一轮增减。
		queueMicrotask(() => {
			// 清除排队标记，使后续轮次可以再次安排发布。
			this.#scheduled = false;
			// 在主机批次内标记源变化；Source.changed 通知依赖者失效，并为被观察的源登记交付。
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}

	// 批次交付时发布当前快照，输入为该批次上下文，返回 void；会向订阅者和 watch 发帧。
	// 例：同轮 calls 从 0 到 1 再到 0，交付时发布最终的 0，而非逐次增减日志。
	deliver(context: Context): void {
		// 通过上面的 getter 获取最新且可共享的快照。
		const value = this.value;
		// 用 Delta 的 r 操作表示整值替换；false 表示不是文档退休事件，context 随帧传递。
		this.publish(value, [["r", value]], false, context);
	}
}
