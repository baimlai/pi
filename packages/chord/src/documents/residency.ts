// Residency of keyed documents (slice 6a §10, rule 23): which keyed documents are in memory, and the eviction of
// persisted ones nobody pinned and nobody read or wrote for the retention. One idle structure and one timer per
// object, Durable's (`Session.#touchDocument`): an insertion-ordered map whose oldest entry the timer waits for, a
// touch moving an entry to the back at most once per granule (O(1) per touch, no timer per key).

// 文件导读
// 所属：packages/chord/src/documents，持久键控文档的驻留与驱逐。
// 职责边界：只记录未 pin 文档的闲置时间、安排清扫并调用 slot.evict；不加载文档、不改变存储、不处理 pin 计数（KeyedSlot 管）。
// 上游：KeyedSlot 的 #touch/forget/drop，Documents.end；下游：定时器 → onLine 回调 → Resident.slot.evict → 槽从 #residents 删除。
// 结果/错误：touch/forget/end 不抛错；定时器回调的错误只有 onLine 在对象结束后的 released，由 Documents 侧 catch 吞掉。
// 能力清单：Resident 驻留记录；RETENTION_MS 保留期；GRANULE_MS 重排粒度；Residency 类（touch/forget/end 与定时清扫）。
// 组合关系：get 命中未 pin 的持久文档 → touch 排到 Map 尾部 → 定时器等最旧项到期 → onLine 上 #evictExpired → evict 移出内存。
// 示例：new Residency((sweep) => { void documents.onLine(async () => sweep()).catch(() => {}); })；residency.touch(resident) 后最迟约 10 分钟被驱逐。
// 阅读顺序：先看 Resident 与常量，再看 touch/#schedule，最后看 #evictExpired 与 keyed-slot.ts 的 #touch/evict。
import type { Tracker } from "../delta/index.ts";
import type { JsonObject } from "./definition.ts";
import type { Stored } from "./persistence.ts";

// Resident 是一条驻留记录：键、tracker（当前值）、已知存储坐标、值对应的定义版本。
/** One keyed document in memory: its slot, its tracker and, persisted, what is stored of it. */
export class Resident {
	// slot 用结构类型 { evict(resident): void } 而不是 KeyedSlot，避免 residency.ts 与 keyed-slot.ts 循环导入。
	// key 是规范化后的字符串键；tracker 持有文档值；stored 为 undefined 表示仅内存或尚无存储。
	// version 低于槽定义版本时，下次访问会按需迁移；这些字段可变，readonly 只在 key/slot 上。
	readonly slot: { evict(resident: Resident): void };
	readonly key: string;
	tracker: Tracker<JsonObject>;
	stored: Stored | undefined;
	/** The definition version the tracker's value is at: below the slot's, it migrates on its next access. */
	version: number;

	// 函数说明：保存五个字段；输入 slot/key/tracker/stored/version，无输出与 I/O。
	// 例：new Resident(this, "a", track(value), undefined, 1)。
	// 用显式字段赋值而不是参数属性，因为项目要求可擦除 TS 语法（Node strip-only）。
	constructor(
		slot: { evict(resident: Resident): void },
		key: string,
		tracker: Tracker<JsonObject>,
		stored: Stored | undefined,
		version: number,
	) {
		this.slot = slot;
		this.key = key;
		this.tracker = tracker;
		this.stored = stored;
		this.version = version;
	}
}

// 保留期：未 pin 的持久键控文档在最后一次访问后 10 分钟内可留在内存，随后由清扫驱逐。
/** How long an unpinned persisted keyed document stays in memory after its last read or write (slice 6a §10). */
export const RETENTION_MS = 10 * 60_000;

/** A touch moves an entry at most once per granule: a tenth of the retention, up to 1 s (Durable's rule). */
// 粒度：touch 至少间隔 1 秒才重排；RETENTION/10 为 60 秒，所以取 min 得到 1 秒。
// 允许文档最多提前一个粒度被驱逐，换取 O(1) 的 touch 与每对象一个定时器。
const GRANULE_MS = Math.min(1_000, RETENTION_MS / 10);

// 例：未 pin 的 a 先被使用、b 后使用；Map 顺序 a→b；定时器等 a 的 10 分钟到点，清扫按顺序删除已过期项。
/** The idle persisted keyed documents of one object, oldest first, and the one timer evicting them. */
export class Residency {
	// #onLine 由 Documents 传入：把清扫排到对象线，避免与冷加载/事务并发；签名返回 void，因为调用方不等清扫结果。
	// #idle 的插入顺序就是最旧在前的顺序；值是上次重排的时间戳，不是过期时间。
	// #sweep 记录当前定时器与到期时刻；#ended 一旦为 true，end() 后任何清扫/重排都被忽略。
	/** Runs a sweep on the object's line. */
	readonly #onLine: (sweep: () => void) => void;
	readonly #idle = new Map<Resident, number>();
	/** The pending sweep: when it is due and its timer; stays set until its job runs on the line. */
	#sweep: { readonly at: number; timer: ReturnType<typeof setTimeout> | undefined } | undefined;
	#ended = false;

	// 函数说明：只保存 onLine；不创建定时器，第一次 touch 才调度。
	// 例：new Residency((sweep) => { void documents.onLine(async () => sweep()).catch(() => {}); })。
	constructor(onLine: (sweep: () => void) => void) {
		this.#onLine = onLine;
	}

	// 函数说明：记录一次未 pin 文档的使用；输入 resident，无返回；副作用是重排 #idle 并可能安排清扫。
	// 例（真实）：granule 内第二次读同一文档直接返回，不移动顺序；过了 granule 再读则移到最新。
	// since !== undefined && now - since < GRANULE_MS 是热路径快速返回：常见连续读取不触碰 Map。
	// delete + set 是 Map 的“移到末尾”；只改顺序，不复制 tracker。
	// 没有待清扫定时器时补一个；已有则复用，避免每个键一个 timer。
	/** A use of an unpinned `resident`: it becomes the newest idle one (once per granule), and a sweep is scheduled. */
	touch(resident: Resident): void {
		const now = Date.now();
		const since = this.#idle.get(resident);
		// A hot document moves at most once per granule: it may then leave up to a granule early (a reload).
		if (since !== undefined && now - since < GRANULE_MS) return;
		this.#idle.delete(resident);
		this.#idle.set(resident, now);
		if (this.#sweep === undefined) this.#schedule();
	}

	// 函数说明：resident 被 pin 或离开内存，从 #idle 删除；无返回。
	// 例：pin(key) 时 forget，防止清扫驱逐正在使用的文档；最后一个 pin 释放后重新 touch。
	/** `resident` is pinned or left memory: it is no longer idle. */
	forget(resident: Resident): void {
		this.#idle.delete(resident);
	}

	// 函数说明：对象结束；置 ended、清空 Map、清定时器；无返回；不调用 evict（文档由槽自己 drop）。
	/** The object ended: nothing is evicted any more, the timer is cleared. */
	end(): void {
		this.#ended = true;
		this.#idle.clear();
		clearTimeout(this.#sweep?.timer);
		this.#sweep = undefined;
	}

	// 函数说明：为最旧的 idle 文档安排清扫；无输入输出，副作用是 setTimeout。
	// values().next() 得到 IteratorResult；Map 为空或已结束直接返回。
	// at = 最旧时间 + RETENTION；延迟用 max(0, ...) 防止已过期/时钟回拨时传负数。
	// 先保存 sweep 再 setTimeout：回调用对象身份判断自己是否仍是当前计划。
	// 定时器早触发不会补扫：回调只执行一次清扫并重排下一次。
	// 回调通过 #onLine 进入对象线；清扫本身同步，不读 store。
	/** Schedules the eviction of the oldest idle document when its retention expires. */
	#schedule(): void {
		const oldest = this.#idle.values().next();
		if (this.#ended || oldest.done === true) return;
		const at = oldest.value + RETENTION_MS;
		const sweep: { readonly at: number; timer: ReturnType<typeof setTimeout> | undefined } = { at, timer: undefined };
		this.#sweep = sweep;
		// A timer firing early sweeps nothing and schedules the next one.
		sweep.timer = setTimeout(
			() =>
				this.#onLine(() => {
					if (this.#sweep === sweep) this.#sweep = undefined;
					this.#evictExpired();
				}),
			Math.max(0, at - Date.now()),
		);
	}

	// 函数说明：在对象线上驱逐所有已过保留期的 idle 文档；无输入输出；副作用是 evict 并可能安排下一次。
	// 遍历按插入顺序（最旧在前）：since > expired 时 break，因为后面的只会更新。
	// 删除后若 #sweep 为空（例如本轮由旧定时器触发），再安排下一次。
	// 清扫与冷加载互斥：两者都在对象线上；加载安装的未 pin 键会 touch 成最新，不会刚装好就被删。
	// evict 只从槽的 residents 删除；本循环边遍历边删 #idle 是安全的。
	/**
	 * On the line: evicts the idle documents whose retention passed, oldest first, then schedules the next sweep. No
	 * load in flight needs a pin against it: cold loads run on the line too, so a sweep never runs during one, and a
	 * load installing an unpinned key touches it (it is then the newest idle one).
	 */
	#evictExpired(): void {
		if (this.#ended) return;
		const expired = Date.now() - RETENTION_MS;
		for (const [resident, since] of this.#idle) {
			if (since > expired) break;
			this.#idle.delete(resident);
			resident.slot.evict(resident);
		}
		if (this.#sweep === undefined) this.#schedule();
	}
}
