// The unbound index (dependency model §1, §4): the requests a host decided cannot bind yet, by the name they wait for.
// Before the host's first publication every hold arriving on its links, and a request made here while `load` runs the
// setups (before `load` this host's own requests throw), waits here (`unpublished`); after it, those its check left
// unbound (`not_served`, `version`): a reference made here, a hold that arrived over a link and was refused for a name.
// A publication wakes the requests of the names it serves (`load`'s every one, a reload's those of its names); a
// request leaves when it ends (released, settled, given up, its link or origin closed, revoked) or binds. A request
// waiting with a cause (after the publication) is on the host's `UnboundClock` while it is indexed: reported after 5 s.
// 本文件是宿主的“按名称等待”索引。上游是引用绑定失败、链接上的 hold 被拒等路径调用 add；
// 发布/重载时 wakeAll 或 wake(names) 按名称重新检查；请求结束、撤权或宿主关闭时 delete/close 将其移出。
// 索引只保存唤醒和结束两个动作，不保存类型、参数或代理对象。
// 所属模块：packages/chord/src/host 的无绑定请求索引（依赖模型）。
// 上下游：引用/链接在无法绑定时 add；发布调用 wakeAll/wake(names)；结束、撤权、宿主关闭调用 delete/revoke/close。
// 结果：只调用请求的 wake/end，不做类型解析；带 cause 的请求同时登记 UnboundClock，时钟只负责报告。
// 能力清单：
// - UnboundRequest：索引所需的最小接口（principal、wake、end），本地绑定与远端 hold 都实现它。
// - UnboundIndex：add/delete/names/wakeAll/wake/revoke/close 组成的按名称集合。
// 组合关系：add 建集合并入时钟 -> 发布时 wakeAll 或 wake(names) 逐个移出并唤醒 -> 请求自行重新检查。
// 示例：index.add("Notes", request, undefined); index.wake(["Notes"]); // request.wake() 被调用一次
// 阅读顺序：先 UnboundRequest，再 add/delete 的登记规则，最后 wake/revoke/close 的遍历与快照。

import type { ChordError, FailureCause, Principal } from "../data/index.ts";
import type { UnboundClock } from "./unbound-clock.ts";

/** A request in the index: a reference made here or a hold that arrived over a link. */
// 接口只约定索引需要的三个成员：身份、被唤醒时做什么、被终止时做什么。
// 本地 Binding 和远端 hold 都实现它，索引因此不需要知道它们的具体类型；接口在运行时完全擦除。
export interface UnboundRequest {
	/** Whom it acts for: revocation ends the requests of a revoked principal. */
	// undefined 表示匿名；撤权检查会跳过这种请求。身份来自调用方，不是索引自己推断的。
	readonly principal: Principal | undefined;
	/** The name it waits for became usable (or the host published): it runs its check again, leaving the index first. */
	// 唤醒不是“绑定成功”的通知，而是“再检查一次”的请求；实现方应先离开索引，避免检查中再次被加入。
	wake(): void;
	/** It is revoked, or its host closes: it ends with `error` (a hold sends `gone`), leaving the index. */
	// 终止是永久的：实现方负责释放自己的引用或向链路发送 gone，并确保不会再次进入索引。
	end(error: ChordError): void;
}

/** A host's unbound requests by name. */
// 一个宿主的无绑定请求索引。内部是“名称 → 请求集合”的 Map；同一请求在同一名称下只出现一次。
// 集合用 Set：加入/删除是常数时间，且重复 add 不会产生重复项。
export class UnboundIndex {
	// 键是等待的名称（类型名或 `registry <name>`），值是等待该名称的请求集合。
	readonly #byName = new Map<string, Set<UnboundRequest>>();
	// 带原因等待的请求同时登记到时钟；时钟只负责 5 秒报告，不参与唤醒。
	readonly #clock: UnboundClock;

	// 保存时钟引用，不创建映射项；例如 new UnboundIndex(clock) 之后索引为空。
	constructor(clock: UnboundClock) {
		this.#clock = clock;
	}

	/**
	 * Indexes `request` under `name` (once; again after a wake), waiting for the publication (no `cause`) or for a
	 * provider that fits (`cause`, on the clock).
	 */
	// 把请求登记到名称下。输入名称、请求对象和可选的失败原因；无返回值。
	// cause 为 undefined 表示首次发布前或尚未检查（loading）；有 cause 表示检查后仍无法绑定（failed { waiting }）。
	// 副作用：必要时创建 Set，并在有 cause 时启动 5 秒报告计时。示例：add("Notes", req, cause) 让发布 Notes 时唤醒 req。
	add(name: string, request: UnboundRequest, cause: FailureCause | undefined): void {
		// 名称首次出现时才创建集合；后续请求复用同一个 Set。
		let requests = this.#byName.get(name);
		if (requests === undefined) {
			requests = new Set();
			this.#byName.set(name, requests);
		}
		// Set.add 幂等：同一请求重复登记不会变成两个元素。
		requests.add(request);
		// 只有已经知道失败原因时才需要报告等待过长；首次发布前的普通等待不报告。
		if (cause !== undefined) this.#clock.start(request, name, cause.error);
	}

	/** `request` ended or binds: it leaves the index. */
	// 请求已结束或即将重新检查：从名称下移除。无返回值；未知名称或未知请求是空操作。
	// 同时停止它的时钟报告；最后一个请求离开后删除空 Set，避免 names() 一直列出无人等待的名称。
	delete(name: string, request: UnboundRequest): void {
		const requests = this.#byName.get(name);
		// `!requests.delete(request)` 表示集合里没有它；这种调用不应停止其他请求的计时。
		if (requests === undefined || !requests.delete(request)) return;
		this.#clock.stop(request);
		// size 为 0 时删除整个键，保持索引紧凑。
		if (requests.size === 0) this.#byName.delete(name);
	}

	/** The names requests wait for, sorted. */
	// 返回当前有人等待的名称，已排序。无副作用；返回新数组，调用者修改它不影响索引。
	// 展开 Map.keys() 得到字符串数组，再按字典序排序，便于诊断输出稳定。
	names(): string[] {
		return [...this.#byName.keys()].sort();
	}

	/** The host's publication: every request indexed (by any name) runs its check again, out of the index first. */
	// 宿主首次发布：所有等待者都重新检查。无返回。
	// 先用数组快照收集全部请求，再清空索引；wake 可能同步重新 add，先清空能避免遍历时修改集合。
	// flatMap 把每个 Set 展开成请求数组再拼接；[...requests] 把 Set 转成数组。
	wakeAll(): void {
		const all = [...this.#byName.values()].flatMap((requests) => [...requests]);
		this.#byName.clear();
		// 先统一停止计时，再统一唤醒；顺序避免 wake 期间时钟仍挂着旧报告。
		for (const request of all) this.#clock.stop(request);
		for (const request of all) request.wake();
	}

	/**
	 * A reload's publication: the requests indexed under `names` (the types and registries it serves) run their check
	 * again, out of the index first; the others stay (carry-over "Publications wake per name").
	 */
	// 重载发布：只唤醒本次服务涉及的名称。输入是 Iterable<string>（数组、Set 或生成器都可以）；无返回。
	// 与 wakeAll 一样先移除再唤醒；未列出的名称保持原样，等待下一次发布。
	// 示例：wake(["Notes", "registry  M"]) 只让这两类等待者重新检查，其他类型的请求继续等待。
	wake(names: Iterable<string>): void {
		const woken: UnboundRequest[] = [];
		for (const name of names) {
			const requests = this.#byName.get(name);
			// 该名称无人等待就跳过，不创建空集合。
			if (requests === undefined) continue;
			// 先删除整个名称，确保 wake 中的重新登记进入新集合。
			this.#byName.delete(name);
			woken.push(...requests);
		}
		for (const request of woken) this.#clock.stop(request);
		for (const request of woken) request.wake();
	}

	/** Every indexed request acting for a principal `revoked` names ends with `error`. */
	// 撤销：对所有身份满足 revoked 判定且正在等待的请求调用 end。输入判定函数和终止错误；无返回。
	// 遍历前复制 Map 值和 Set，因为 end 可能同步触发 delete；复制保证遍历稳定。
	// 匿名请求（principal === undefined）不会被撤权；判定函数由宿主提供，可能抛错并向上传播。
	revoke(revoked: (principal: Principal) => boolean, error: ChordError): void {
		// [...this.#byName.values()] 复制外层集合；内层 [...requests] 再复制每个 Set。
		for (const requests of [...this.#byName.values()]) {
			for (const request of [...requests]) {
				// 先排除匿名，再调用判定函数；&& 短路避免把 undefined 传进去。
				if (request.principal !== undefined && revoked(request.principal)) request.end(error);
			}
		}
	}

	/** The host closed: every indexed request ends with `error`. */
	// 宿主关闭：所有等待者以 error 结束。无返回；与 wakeAll 相同的快照策略，避免 end 修改集合。
	close(error: ChordError): void {
		const all = [...this.#byName.values()].flatMap((requests) => [...requests]);
		this.#byName.clear();
		for (const request of all) this.#clock.stop(request);
		for (const request of all) request.end(error);
	}
}
