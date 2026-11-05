// Presence (§19): `host.references(Type)`, a JSON watchable of the references to objects of one type on this host, one
// entry per reference with the object's params, the reference's principal (remote types) and its incarnation.

// 所属：packages/chord/src/host 的 presence 模块（设计 §19）：host.references(Type) 的可观察列表。
// 职责边界：只维护“某类型在本宿主上的引用条目”，不决定对象何时上线；它是 JSON Source，值必须可序列化。
// 上游：object.ts 在 hold/unhold 时经 host.referenced/unreferenced 调用 add/remove；host.ts 首次 references(Type) 创建实例并补录。
// 下游：监视该源的 derive 或远端订阅在批次提交时收到 splice 帧；无人监视时读取会按需重建列表。
// 能力清单：
// - Presence<C,P>：一条引用项（params、远程类型的 principal、incarnation）。
// - References：一个类型的引用列表源；value 返回当前 JSON 列表，add/remove 在批次内记录变化，
//   record 生成条目，deliver 在提交时折叠并发布，value/#follows/#fold 负责快照与折叠。
// 组合与典型顺序：host.references(Type) 创建 References -> holder 绑定时 add(object, holder) -> 批次提交 deliver 发布
// 一个删除 splice 加一个尾部添加 splice；holder 结束 remove。
// 示例：const references = new References(batch);
//       references.add(object, holder, context);
//       const list = references.value; // readonly Presence[] 的 JSON 视图
// 建议阅读顺序：Presence -> References 字段 -> value -> add/remove -> record -> deliver -> #follows/#fold。

import type { Context } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { Source } from "../state/internal.ts";
import type { ChordObject, Holder } from "./object.ts";

/**
 * One reference to an object of `C`: the object's params, the principal it acts as (for a remote type), and its
 * incarnation: the host that made it as its caller sees it (a hold's caller over a link; two tabs are two
 * incarnations), the word `ctx.incarnation` uses.
 */
// 一条 presence 项。params 是对象参数（业务含义：同一类型的不同实例）；
// principal 仅远程类型有：引用代谁行事；incarnation 是发起该引用的宿主运行标识（两个浏览器标签页不同）。
// 三者都来自运行时数据；类型参数 C/P 只在编译期约束形状，运行时不校验。
export type Presence<C extends Contract = Contract, P extends Principal = Principal> = {
	readonly params: ParamsOf<C>;
	readonly principal?: P;
	readonly incarnation: string;
};

/**
 * The references of one type, made by the host for its first `host.references(Type)` and kept from then on: one entry
 * per reference, added when it binds and removed when it ends, in the batch where that happens (derives over it
 * recompute there). While watched, a batch's changes are folded into the published list once, with one splice op per
 * removal and one for the additions; otherwise the list is built on its next read.
 */
// 每种类型一个 References 实例，由 host 缓存（#references）。entries 以 Holder 对象身份为键，保证同一引用只出现一次。
// 值的变化发生在批次内：add/remove 用 batch.within 包裹；批次提交时 deliver 把折叠好的 splice 操作发布给监视者。
// 例：两个引用先后 bind，则 added 累积两项，发布时一个尾插 splice。
export class References extends Source {
	// Holder → Presence 的映射：Holder 是引用绑定的内部身份，不作为 JSON 出现。
	readonly #entries = new Map<Holder, Presence>();
	/** The list as last published or read; `undefined` once it changed while nobody watched it. */
	// 上次发布/读取的列表快照。无人监视时一旦变化就置 undefined，下次读取时重建，避免维护增量。
	#list: readonly Presence[] | undefined;
	/** Entries added since `#list`, in order (only while it is defined). */
	// 自 #list 之后新增的项；仅在 #list 有定义（正在增量维护）时使用。
	#added: Presence[] = [];
	/** Entries of `#list` removed since. */
	// 自 #list 之后被删除的项集合；折叠时按索引生成 splice。
	readonly #removed = new Set<Presence>();
	/** The ops folding `#list` forward, for the current batch's frame. */
	// 本批次待发布的 splice 操作；deliver 后清空，保证每批次最多一帧。
	#ops: Op[] = [];

	// 读取当前列表（JSON 值）。无参数；可能触发 #fold 重建或折叠增量。
	// 例：derive 读取 references(Note) 时得到 Presence 数组的浅拷贝列表。
	get value(): JsonValue {
		this.#fold();
		// Entries are JSON: params, a principal and a string.
		// 强制类型断言是因为 Presence[] 的静态类型比 JsonValue 更具体，但运行时值确实是 JSON 数据。
		return this.#list as unknown as JsonValue;
	}

	/** `holder` references `object`, added in the batch running now or the next one. */
	// 登记一个引用。副作用：写入 entries，可能追加 added，并标记源已变化。
	// 在批次内执行（batch.within），因此同批次的多次 add 只发布一帧。例：get 成功绑定后调用。
	add(object: ChordObject, holder: Holder, context: Context): void {
		this.batch.within(() => {
			// record 生成 JSON 项并写入 entries；返回值供增量列表使用。
			const entry = this.record(object, holder);
			// 只有当前处于“边发布边增量维护”的状态才记 added；否则 on read 会整体重建。
			if (this.#follows()) this.#added.push(entry);
			// 标记源变化；批次提交时 deliver 会发布。
			this.changed();
		}, context);
	}

	/** `holders` of `object` ended, removed in one batch. */
	// 批量移除引用。若某项尚在 added 中，直接从 added 删除；否则记入 removed，由 #fold 生成删除 splice。
	remove(holders: Iterable<Holder>, context: Context): void {
		this.batch.within(() => {
			// 先确定是否处于增量跟随状态：若不是，后续无需维护 added/removed。
			const follows = this.#follows();
			for (const holder of holders) {
				const entry = this.#entries.get(holder);
				// 未登记过的 holder 忽略（例如绑定前就失败）。
				if (entry === undefined) continue;
				// Holder 身份是唯一键：先删映射。
				this.#entries.delete(holder);
				if (!follows) continue;
				// 若项还没发布过，撤销 added；否则记录已发布列表中的删除。
				const added = this.#added.indexOf(entry);
				if (added === -1) this.#removed.add(entry);
				else this.#added.splice(added, 1);
			}
			this.changed();
		}, context);
	}

	/** Records `holder` without a batch (the list being made) and returns its entry. */
	// 无批次副作用地登记 holder 并返回 Presence。principal 只在远程对象且确实有 principal 时加入对象字面量，
	// 因此本地对象的项没有 principal 字段。仅供构建列表与 add 使用。
	record(object: ChordObject, holder: Holder): Presence {
		const { principal, incarnation } = holder.caller;
		const entry: Presence = {
			params: object.params,
			// 条件展开：...({} 或 { principal })，让可选字段缺省时完全不存在。
			...(object.served.kind === "remote" && principal !== undefined ? { principal } : {}),
			incarnation,
		};
		this.#entries.set(holder, entry);
		return entry;
	}

	// 批次提交时由 Source 的发布流程调用：先取当前值（触发折叠），再发布本批累积的操作。
	// 无返回值；只有存在操作时才真正 publish。
	deliver(context: Context): void {
		const value = this.value;
		const ops = this.#ops;
		// 先清空再发布，避免监听者同步读取时看到旧操作。
		this.#ops = [];
		// Listed once per change: the batch's first delivery carries all of them.
		if (ops.length > 0) this.publish(value, ops, false, context);
	}

	/**
	 * Whether a change is folded into the published list: while watched (a watch read the list first). Otherwise the
	 * list is dropped and built on its next read.
	 */
	// 判断能否增量维护：必须已有监视者且 #list 已建立；否则丢弃快照，让下次读取重建全量。
	// 返回布尔值，无其他副作用（除上述重置）。
	#follows(): boolean {
		if (this.watched && this.#list !== undefined) return true;
		this.#list = undefined;
		return false;
	}

	/**
	 * Folds the changes since `#list` into a new list, once: a removal is one splice op at its index, the additions one
	 * splice op at the end. Builds the list from the entries when there is none.
	 */
	// 把 added/removed 折叠为 splice 操作。splice 操作格式 ["p", 路径, 起始索引, 删除数, 插入项]。
	// 例：删除列表索引 1 的项产生 ["p", [], 1, 1, []]；随后新增两项产生尾部插入。
	#fold(): void {
		// 没有快照：直接从 entries 重建，并清空增量状态。
		if (this.#list === undefined) {
			this.#list = [...this.#entries.values()];
			this.#added = [];
			this.#removed.clear();
			this.#ops = [];
			return;
		}
		// 没有增量变化：什么也不做。
		if (this.#added.length === 0 && this.#removed.size === 0) return;
		let list = this.#list;
		if (this.#removed.size > 0) {
			// kept 收集保留下来的项；kept.length 正好是删除发生时的目标索引（逐个删除后索引会前移）。
			const kept: Presence[] = [];
			for (const entry of list) {
				if (this.#removed.has(entry)) this.#ops.push(["p", [], kept.length, 1, []]);
				else kept.push(entry);
			}
			this.#removed.clear();
			list = kept;
		}
		if (this.#added.length > 0) {
			// 新增项统一在末尾插入；as unknown as JsonValue[] 是类型断言，运行时仍是 Presence 数组。
			this.#ops.push(["p", [], list.length, 0, this.#added as unknown as JsonValue[]]);
			list = [...list, ...this.#added];
			this.#added = [];
		}
		this.#list = list;
	}
}
