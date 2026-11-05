// The outbox (slice 6a §2; decisions "The outbox is optional, internal and versioned", small items 3-4): the store's
// commits as the sync layer reads them, one `{ seq, writes }` per commit from its floor on, in the current format.

// 文件导读
// 所属：packages/chord/src/store（store 层，可选 outbox）。
// 职责边界：按 seq 读取提交记录、裁剪并推进 floor，串行化 read/trim；不写业务表、不决定 outbox 是否开启。
// 上游：ChordStore 暴露的 outbox 对象；应用调用 read/trim。下游：chord_outbox/chord_meta 表与 StoreWrite JSON；格式不兼容抛 unavailable。
// 能力清单：
// - OUTBOX_FORMAT：当前写入词汇格式版本；
// - OutboxCommit：seq/nextId/writes 的提交记录；
// - NOTHING（内部）：吞掉队列尾部结果，避免未处理拒绝；
// - Outbox：floor 读取、read、trim 与内部串行队列。
// 组合顺序：打开 store 时用 meta.outbox_floor 构造 Outbox -> read(afterSeq,limit) 校验范围并查询 -> 应用消费 writes -> trim(throughSeq) 删除并更新 floor。
// 示例：const commits = await store.outbox.read(store.outbox.floor, 100, ctx); 返回该 floor 之后最多 100 条 OutboxCommit。
// 建议阅读顺序：OUTBOX_FORMAT/OutboxCommit -> Outbox 字段与构造 -> floor/read/trim -> #queued/#read/#trim。
import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { TABLES } from "./schema.ts";
import type { ChordStore } from "./store.ts";
import type { StoreWrite } from "./writes.ts";

/** The write vocabulary's version an outbox commit is stored in; a newer one is refused, data intact. */
// 写入词汇格式；读到更高版本说明数据来自更新代码，拒绝而不是猜测。
export const OUTBOX_FORMAT = 1;

/** One commit as the outbox gives it: its seq, the allocator's value it persisted (D3) and its writes in applied order. */
// 一条提交的读取形态：writes 已解析为 StoreWrite[]，字段名转成 camelCase。
export type OutboxCommit = { readonly seq: number; readonly nextId: number; readonly writes: readonly StoreWrite[] };

// 队列尾部只需要吞掉结果，避免一次失败阻塞后续操作。
const NOTHING = (): void => {};

/** A store's outbox: its commits after the floor (the seq it was turned on at, advanced by `trim`). */
// outbox 门面：read 与 trim 共享一条 Promise 队列，保证 floor 与数据库一致。
export class Outbox {
	// 通过 store.read/maintain 复用其事务与失败语义。
	readonly #store: ChordStore;
	// 内存中的 floor；trim 成功后同步更新。
	#floor: number;
	/**
	 * The outbox's reads and trims, one at a time: a read checks the floor and reads with no trim running (a trim's
	 * commit may have deleted rows before its floor is set), a trim waits for the reads in flight.
	 */
	// 队列尾；每个操作接在它后面，前一个失败也要让后续操作继续。
	#queue: Promise<void> = Promise.resolve();

	// 保存 store 与打开时读到的 floor；不做 I/O。
	constructor(store: ChordStore, floor: number) {
		this.#store = store;
		this.#floor = floor;
	}

	/** The seq the outbox starts after: `read` takes any `afterSeq` from it to `lastSeq`. */
	// 返回内存 floor；它是 read 允许的最早起点。
	get floor(): number {
		return this.#floor;
	}

	/** Up to `limit` commits after `afterSeq`, in seq order; `afterSeq` outside floor..lastSeq is `invalid/args`. */
	// 读取 afterSeq 之后最多 limit 条提交；参数非法抛 invalid/args；查询在队列中执行。
	async read(afterSeq: number, limit: number, context: Context): Promise<OutboxCommit[]> {
		// 应用传入的参数是信任边界：先检查是否为安全整数。
		if (!Number.isSafeInteger(afterSeq)) throw invalid("args", `outbox: read after ${afterSeq}, not an integer`);
		// limit 必须是正安全整数，防止负数/NaN 进入 SQL。
		if (!Number.isSafeInteger(limit) || limit < 1) throw invalid("args", "outbox: limit is a positive integer");
		return this.#queued(() => this.#read(afterSeq, limit, context));
	}

	/**
	 * Drops the commits through `throughSeq` and advances the floor; idempotent; beyond `lastSeq` is `invalid/args`.
	 * Trims run one at a time, so the stored floor only rises and equals the one in memory.
	 */
	// 删除 seq <= throughSeq 的提交并推进 floor；幂等，以 Promise 返回。
	trim(throughSeq: number, context: Context): Promise<void> {
		try {
			// 入队前响应取消；取消与参数错误一样以拒绝返回。
			context.abortSignal?.throwIfAborted();
			// throughSeq 不能越过 lastSeq，否则调用者状态必然不一致。
			if (!Number.isSafeInteger(throughSeq) || throughSeq > this.#store.lastSeq) {
				throw invalid("args", `outbox: trim through ${throughSeq}, beyond ${this.#store.lastSeq}`);
			}
		} catch (error) {
			return Promise.reject(error);
		}
		// 真正的删除排在已有 read 之后。
		return this.#queued(() => this.#trim(throughSeq));
	}

	/** Runs `operation` once the outbox operations before it settled. */
	// 串行化入口：把 operation 接到队尾，并让队列在成功/失败后都继续。
	#queued<T>(operation: () => Promise<T>): Promise<T> {
		// then 返回新 Promise；调用者拿到的是本次操作的结果。
		const run = this.#queue.then(operation);
		// 队列尾吞掉结果，错误仍交给调用者。
		this.#queue = run.then(NOTHING, NOTHING);
		return run;
	}

	/** `read`, its turn come: the floor as no trim moves it. */
	// 队列轮到的 read：先检查 floor 范围，再查询 outbox 表。
	async #read(afterSeq: number, limit: number, context: Context): Promise<OutboxCommit[]> {
		// 队内执行时 floor 不会被 trim 改动，范围检查稳定。
		if (afterSeq < this.#floor || afterSeq > this.#store.lastSeq) {
			throw invalid("args", `outbox: read after ${afterSeq}, outside ${this.#floor}..${this.#store.lastSeq}`);
		}
		// 通过 store.read 在同一读事务中查询，失败语义与其它读一致。
		const rows = await this.#store.read(
			(executor) =>
				executor.all<{
					readonly seq: number;
					readonly format: number;
					readonly next_id: number;
					readonly writes: string;
				}>(
					`SELECT seq, format, next_id, writes FROM ${TABLES.outbox} WHERE seq > ? ORDER BY seq LIMIT ?`,
					afterSeq,
					limit,
				),
			context,
		);
		// 逐行验证 format 并解析 JSON；损坏的 writes 以 JSON.parse 错误上抛。
		return rows.map(({ seq, format, next_id, writes }) => {
			// 更高格式不能按当前词汇解释，抛 unavailable 且不删除数据。
			if (format !== OUTBOX_FORMAT) {
				const message = `outbox: commit ${seq} is in format ${format}, newer than ${OUTBOX_FORMAT}`;
				throw new ChordError({ code: "unavailable", message });
			}
			// 列名 snake_case 转 camelCase；as 信任写入侧已序列化 StoreWrite。
			return { seq, nextId: next_id, writes: JSON.parse(writes) as StoreWrite[] };
		});
	}

	// 队列轮到的 trim：先判幂等，再在同一 maintain 事务里删行并更新 meta。
	async #trim(throughSeq: number): Promise<void> {
		// 已裁剪过同样范围：直接成功，不重复写。
		if (throughSeq <= this.#floor) return;
		// maintain 使用 store 的写事务与提交队列；两条语句同成同败。
		await this.#store.maintain(async (executor) => {
			await executor.run(`DELETE FROM ${TABLES.outbox} WHERE seq <= ?`, throughSeq);
			await executor.run(`UPDATE ${TABLES.meta} SET outbox_floor = ? WHERE singleton = 1`, throughSeq);
		});
		// 数据库成功后更新内存 floor；失败时保持旧值。
		this.#floor = throughSeq;
	}
}
