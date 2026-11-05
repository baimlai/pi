// The store (slice 6a §2, §3, slice 6b §1): opened over a backend, one commit queue that serializes only the commit step
// (the seal fence's admission check, `BEGIN`, the writes in their order, the outbox commit, `lastSeq` and the
// allocator's value, `COMMIT`, then the owner's adoption), the id allocator, the claims of its tables and documents,
// reads guarded as Durable's `GuardedStorage` guards them, Durable's Storage semantics for a refused step (D4), and the
// stop after an unknown outcome.

// 文件导读
// 所属：packages/chord/src/store（store 门面：打开/关闭、单提交队列、序列与分配器、claims、受保护读取、批量回放）。
// 职责边界：串行化提交步骤并维护内存中的 lastSeq/catalog/allocator；不实现具体写入 SQL（step/tables/engine）与 outbox 编码（outbox.ts）。
// 上游：openStore 由后端打开方调用；应用通过 Store 接口 commit/read/export/close；host 用 attach 提供 batch 与失败监听。
// 下游：schema/catalog 建表与目录、Step 执行写入、export/outbox/claims/IdAllocator 协作。
// 结果与错误流向：拒绝的 commit 原样抛出且 store 继续（D4）；未知结果（BEGIN/COMMIT/ROLLBACK/adopt 失败）进入 storage_failed；close 幂等。
// 能力清单：
// - Store/StoreOptions/CommitFence/SeriesCommit/SeriesResult/Attachment/Replayed：对外与宿主的类型；
// - openStore/switchOutbox：打开 store 并切换 outbox；
// - ChordStore：实现 Store，含提交队列、读取守卫、claims、回放与关闭；
// - Series/SeriesProgress/StoreState（内部）：批处理事务与状态；
// - ORDER/NOTHING/NONE：提交阶段顺序与哨兵值；
// - writeMeta/watchCalls/storageFailed：元数据写入、调用监视与错误构造。
// 组合顺序：openStore -> applyStoreSchema -> switchOutbox -> readCatalog -> new ChordStore；commit -> 队列 -> #step -> fence.admit -> transaction(#write -> writeMeta) -> COMMIT -> 内存更新 -> fence.adopt。
// 示例：const store = await openStore(backend, ctx, { outbox: true }); const seq = await store.commit(writes, fence, ctx); await store.close(ctx);
// 建议阅读顺序：Store/openStore -> commit 与 #step -> #write -> commitSeries/#series -> read/#guarded/close -> replay -> 辅助函数。
import { awaitWithContext, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { SqliteDatabase, SqliteExecutor } from "../sqlite/index.ts";
import type { Batch } from "../state/internal.ts";
import { IdAllocator } from "./allocator.ts";
import type { ArchivePart } from "./archive.ts";
import type { Backend } from "./backend.ts";
import { readCatalog, type TableRecord, writeCatalog } from "./catalog.ts";
import { Claims } from "./claims.ts";
import { StoreExport } from "./export.ts";
import { OUTBOX_FORMAT, Outbox } from "./outbox.ts";
import { applyStoreSchema, type MetaRow, TABLES } from "./schema.ts";
import { type StagedWrite, Step, type WriteOrder } from "./step.ts";
import type { StoreWrite } from "./writes.ts";

/** A store as apps hold it: opened by `openStore`, owned and closed by the app. */
// 应用持有的 store 接口：打开后由应用关闭；提交与读取的细节在 ChordStore。
export interface Store {
	/** The seq of the store's last commit (0 for a new store). */
	// 最近一次提交的序号；新 store 为 0。
	readonly lastSeq: number;
	/** The outbox the sync layer reads; `undefined` without one. */
	// 同步层读取的 outbox；未开启时为 undefined。
	readonly outbox: Outbox | undefined;
	/**
	 * The store's state after its `lastSeq` as archive parts (slice 6a §13), holding the commit queue from the first
	 * `next()` until the iteration ends, throws, is closed or `context` aborts.
	 */
	// 以归档部件流导出当前状态；从第一次 next() 起占用提交队列（见 export.ts）。
	export(context: Context): AsyncIterableIterator<ArchivePart>;
	/**
	 * Closes the store: waits for a running commit step, rejects queued commits and reads `released`, closes the
	 * backend. Idempotent, also after `storage_failed`; `context` ends only this caller's wait (the close goes on).
	 */
	// 等待进行中的提交、拒绝排队提交、关闭后端；幂等，context 只结束本次等待。
	close(context: Context): Promise<void>;
}

/** What `openStore` takes besides the backend. */
// openStore 的选项；只控制 outbox 开关。
export type StoreOptions = {
	/** Turns the outbox on (`true`) or off (`false`); omitted, the persisted setting stays (a new store: off). */
	// true 开启、false 关闭；省略则保留持久化设置（新 store 默认关）。
	readonly outbox?: boolean;
};

/**
 * Opens a store over `backend`: the store's schema migrations, the UTF-8 check, the metadata read once, the outbox
 * switched when asked. A failure closes the backend and rejects (rule 12).
 */
// 在 backend 上打开 store：跑迁移、检查 UTF-8、读元数据、按需切换 outbox。
// 成功返回 Store；任何失败关闭 backend 并原样抛出（rule 12）。
// 示例：const store = await openStore(backend, ctx, { outbox: true });
export async function openStore(backend: Backend, context: Context, options: StoreOptions = {}): Promise<Store> {
	// backend 的数据库句柄；成功后由 ChordStore 拥有。
	const { db } = backend;
	try {
		// 打开前响应取消，避免无谓迁移。
		context.abortSignal?.throwIfAborted();
		// 迁移返回 meta；再按选项切换 outbox，返回最新 meta。
		const meta = await switchOutbox(db, await applyStoreSchema(db), options.outbox);
		// 读目录后构造 store；目录只在提交成功后变化。
		return new ChordStore(db, meta, await readCatalog(db));
	} catch (error) {
		try {
			// 打开失败：关闭后端；关闭自身的错误不覆盖原始错误。
			await db.close();
		} catch {
			// The open's own failure is the one to report.
		}
		throw error;
	}
}

/** Turns the outbox on (from the current `lastSeq`) or off (its commits dropped) when `outbox` asks for the other. */
// 按需切换 outbox：开启从当前 lastSeq 起算，关闭清空积压的 outbox 行。
async function switchOutbox(db: SqliteDatabase, meta: MetaRow, outbox: boolean | undefined): Promise<MetaRow> {
	// 未指定或已是目标状态：不改数据库。
	if (outbox === undefined || outbox === (meta.outbox === 1)) return meta;
	// 开启时从当前水位开始记录；关闭时 floor 归零。
	const floor = outbox ? meta.last_seq : 0;
	// 开关与清理在同一事务，避免半开状态。
	await db.transaction(async (executor) => {
		// 更新 meta 的 outbox 与 floor；SQLite 用 0/1 表示布尔。
		await executor.run(
			`UPDATE ${TABLES.meta} SET outbox = ?, outbox_floor = ? WHERE singleton = 1`,
			outbox ? 1 : 0,
			floor,
		);
		// 关闭时丢弃积压记录，避免重新开启后重放旧提交。
		if (!outbox) await executor.run(`DELETE FROM ${TABLES.outbox}`);
	});
	// 返回内存 meta，无需重新读取。
	return { ...meta, outbox: outbox ? 1 : 0, outbox_floor: floor };
}

/** The seal fence's two checks of a commit (§1.3), as the commit step calls them. */
// seal fence 的准入门：提交步骤入口检查，提交成功后采纳。
export type CommitFence = {
	/** At the step's entry: `false` rejects the commit `released` and writes nothing. */
	// 返回 false 时提交以 released 拒绝，且不写任何东西。
	admit(): boolean;
	/** After `COMMIT`: adopts the commit, `ids` being its created documents' ids in the order of their writes. */
	// COMMIT 后调用；ids 是本提交创建的文档 id，按写入顺序。
	adopt(seq: number, ids: readonly number[]): void;
};

/**
 * One commit of a series (`ChordStore.commitSeries`): its own checks, which write nothing, and its writes. The checks
 * read through the commit's step, which sees what the series' earlier commits wrote.
 */
// 一系列提交中的一次：先检查（不写），再写；检查通过前一个提交的 step 读取。
export type SeriesCommit = {
	/** Throws to refuse the commit: the series stops before it, the commits before it stand. */
	// 抛错即拒绝该提交；系列停在这里，之前的提交保留。
	check(step: Step): Promise<void>;
	// 该提交的暂存写入；为空时不占 seq。
	readonly writes: readonly StagedWrite[];
};

/** What a series stored: how many of its commits, and why the next one was refused, if one was. */
// 系列结果：存下的提交数，以及下一次被拒绝的原因（若有）。
export type SeriesResult = { readonly stored: number; readonly refused?: unknown };

/**
 * A series as its transaction leaves it: each stored commit's seq and created documents; once a commit wrote, the last
 * seq, the allocator's value after it and the table records the series changed; the commits that wrote and the
 * statements run.
 */
// 系列事务提交后带回内存的数据。
type Series = {
	// 每个已存提交的 seq 与新建 id。
	readonly stored: readonly { readonly seq: number; readonly created: readonly number[] }[];
	// 最后一个真正写入的提交；没有写入时为 undefined。
	readonly last:
		| { readonly seq: number; readonly nextId: number; readonly tables: ReadonlyMap<string, TableRecord> }
		| undefined;
	// 实际写入的提交数（用于 metrics）。
	readonly written: number;
	// 事务内执行的语句数。
	readonly statements: number;
};

/**
 * A series while its transaction runs: each stored commit's seq and created documents, its last step that wrote, the
 * allocator's value after it, the table records it changed (a copy of the catalog, made once one changed) and the
 * statements run.
 */
// 系列在事务进行中的可变进度。
type SeriesProgress = {
	// 已处理提交的 seq/created；空写提交记 seq-1。
	readonly stored: { readonly seq: number; readonly created: readonly number[] }[];
	// 最后一个写入步骤；后续 seq 从它递增。
	last: Step | undefined;
	// 当前分配器值；每次写入后更新。
	nextId: number;
	// 首次表变化时复制的目录；未变化前复用全局目录。
	changed: Map<string, TableRecord> | undefined;
	// 累计语句数。
	statements: number;
};

/** What the open host gives the store: its `storage_failed` listener and its batch, in which adapters publish (§1.3). */
// 打开宿主给 store 的东西：失败监听与 batch。
export type Attachment = {
	// storage_failed 时告知宿主，只调用一次。
	readonly failed: (error: unknown) => void;
	// 适配器在 batch 中发布自己的提交。
	readonly batch: Batch;
};

/** Where a replayed batch leaves the store: its last commit's seq and allocator value, the tables it changed. */
// 批量回放后 store 的新位置。
export type Replayed = {
	// 回放最后提交的 seq。
	readonly lastSeq: number;
	readonly nextId: number;
	// 回放改变的表的记录。
	readonly tables: ReadonlyMap<string, TableRecord>;
};

/** Where a store stands: open, stopped by a backend error, or closed. */
// store 状态：运行、因未知结果停止、已关闭。
type StoreState =
	// 可提交、可读取。
	| { readonly kind: "open" }
	// 后端结果未知；所有操作以 unavailable/storage_failed 拒绝。
	| { readonly kind: "failed"; readonly error: unknown }
	// close 后；操作以 released 拒绝。
	| { readonly kind: "closed" };

// 提交阶段顺序：先退役、再创建、最后其余写入；同阶段内保持 staged 顺序。
const ORDER: readonly WriteOrder[] = ["retire", "create", "write"];

// 队列链的哨兵回调：成功失败都不做事。
const NOTHING = (): void => {};

/** The step's own error, until its callback throws one: a distinct value no thrown error can be. */
// 区分“步骤自己抛出的错误”与“事务框架抛出的错误”。
const NONE: unique symbol = Symbol("none");

/** The store behind `Store`, with what Chord's layers use: commits, guarded reads, the host's failure listener. */
// Store 的实现：提交队列、读取守卫、导入/导出/回放与关闭。
export class ChordStore implements Store {
	// 后端数据库；store 唯一所有者。
	readonly #db: SqliteDatabase;
	// 内存中的最后提交 seq，COMMIT 后才更新。
	#lastSeq: number;
	/** The allocator's value as the last commit persisted it (an export's manifest). */
	// 最近一次提交持久化的分配器值（导出 manifest 用）。
	#committedNextId: number;
	// 运行中的分配器；提交时 mint 新 id。
	readonly #ids: IdAllocator;
	/** The claims of its tables and documents (slice 6b). */
	// 声明表/文档的 claims；批量回放前要求无人持有。
	readonly claims = new Claims();
	// 开启时存在；提交时由 #write 追加。
	#outbox: Outbox | undefined;
	// 初始运行；失败或关闭后不可逆。
	#state: StoreState = { kind: "open" };
	/** Set once a batch's recorded count did not reproduce (S17): no batch applies any more. */
	// 批量计数不一致后永久为 true，不再接受回放。
	#diverged = false;
	/** The commit queue's tail: each step starts after the one before it settled. */
	// 提交队列的尾部；每一步排在前一步 settle 之后。
	#tail: Promise<void> = Promise.resolve();
	/** Reads and maintenance writes underway, which `close` waits for. */
	// 进行中的读取/维护写；close 要等它归零。
	#underway = 0;
	/** Resolves `close`'s wait once no read is underway. */
	// close 等待读取归零时挂起的 resolve。
	#drained: (() => void) | undefined;
	/** The open host's listener for `storage_failed` (told once) and batch; one host per store (rule 7). */
	// 打开宿主；一个 store 同一时间只允许一个（rule 7）。
	#attachment: Attachment | undefined;
	// close 只执行一次，后到者共享同一 Promise。
	#closing: Promise<void> | undefined;
	/** The versions migrations of tables announced (`announceTable`), by SQL name, until their last commit. */
	// 已宣布但尚未提交的迁移版本，按 SQL 表名。
	readonly #announced = new Map<string, number>();
	/** The recorded tables, by SQL name; changed only after a step's `COMMIT`. */
	// 已记录的表，按 SQL 名；只在提交成功后更新。
	readonly #catalog: Map<string, TableRecord>;
	/** The ends of the exports holding the queue or waiting for it, which closing the store calls. */
	// 占用/等待提交队列的导出 end 回调；close 时全部调用。
	readonly #held = new Set<() => void>();

	// 只做内存初始化；权限/迁移已由 openStore/importStore 完成。
	constructor(db: SqliteDatabase, meta: MetaRow, catalog: Map<string, TableRecord>) {
		// 接管数据库句柄。
		this.#db = db;
		// 目录来自 readCatalog，之后由提交步骤维护。
		this.#catalog = catalog;
		// 水位来自 meta。
		this.#lastSeq = meta.last_seq;
		// 分配器的持久值。
		this.#committedNextId = meta.next_id;
		// 运行中分配器从持久值继续。
		this.#ids = new IdAllocator(meta.next_id);
		// meta 的 0/1 决定是否创建 Outbox。
		this.#outbox = meta.outbox === 1 ? new Outbox(this, meta.outbox_floor) : undefined;
	}

	// 最近提交的 seq；提交前不暴露未提交值。
	get lastSeq(): number {
		// 直接读内存。
		return this.#lastSeq;
	}

	// outbox 句柄；未开启为 undefined。
	get outbox(): Outbox | undefined {
		// 不创建、不懒加载。
		return this.#outbox;
	}

	/** The allocator's value as the last commit persisted it. */
	// 最近一次提交持久化的分配器值。
	get nextId(): number {
		// 与运行中的 #ids.value 可能不同（mint 只改内存）。
		return this.#committedNextId;
	}

	/** The id allocator: `mint` takes the next id, `raise` makes room above an explicit one (D3). */
	// 运行中的分配器；提交步骤与其他层共用。
	get ids(): IdAllocator {
		// mint/raise 的入口。
		return this.#ids;
	}

	/** Takes the next id from the allocator (Durable's `mintId`); refused once the store stopped or closed. */
	// 从分配器取下一个 id（Durable 的 mintId）；停止/关闭后拒绝。
	mintId(): number {
		this.assertUsable();
		// 只改内存；持久化发生在下一次提交的 meta。
		return this.#ids.mint();
	}

	/** The open host's batch, in which an adapter publishes its commits; `undefined` without a host. */
	// 打开宿主的 batch；无宿主时 undefined。
	get batch(): Batch | undefined {
		// 从 attachment 读取。
		return this.#attachment?.batch;
	}

	/** Every recorded table, by SQL name, as of the last commit. */
	// 最近提交后的表记录，按 SQL 名。
	get tables(): ReadonlyMap<string, TableRecord> {
		// 调用方只读，不要修改。
		return this.#catalog;
	}

	// 创建导出迭代器；队列在第一次 next() 才占用。
	export(context: Context): AsyncIterableIterator<ArchivePart> {
		this.assertUsable();
		// 实际状态机在 export.ts。
		return new StoreExport(this, context);
	}

	/**
	 * Takes the commit queue (an export): resolves once every earlier commit settled, with the release that lets the
	 * later ones run (idempotent). Closing the store calls `end` (from the call on, also while waiting, and at once for a
	 * store closed before the call took the queue), which must release.
	 */
	// 占用提交队列：等所有更早的提交 settle，返回幂等 release；close 会调用 end。
	// 输入 end（关闭时通知导出）；输出 Promise<release>；store 已关闭时立即释放并 end。
	take(end: () => void): Promise<() => void> {
		// 队列占用直到 release 才解除。
		const held = Promise.withResolvers<void>();
		// 幂等释放：从 #held 移除并 resolve。
		const release = (): void => {
			// 关闭时不再需要通知这个导出。
			this.#held.delete(end);
			// 放行后续提交。
			held.resolve();
		};
		// 登记，供 close 主动结束导出。
		this.#held.add(end);
		// 排在前一个队列步骤之后。
		const taken = this.#tail.then(() => {
			// A store closed meanwhile (also before the export's first `next()`) holds nothing: the export ends.
			// 等待期间 store 被关闭：不占队列。
			if (this.#state.kind === "closed") {
				// 立即放行。
				release();
				// 让导出结束，避免一直等 release。
				end();
			}
			// 后续 next() 会拿到这个 release。
			return release;
		});
		// 新的队尾要等 release，后续提交才能开始。
		this.#tail = taken.then(() => held.promise);
		// 调用者得到 release。
		return taken;
	}

	/** The recorded table `name` (its SQL name), as of the last commit. */
	// 按 SQL 名查最近提交后的表记录。
	table(name: string): TableRecord | undefined {
		// 不存在返回 undefined。
		return this.#catalog.get(name);
	}

	/**
	 * The version table `name` is at or is being migrated to: the recorded one, or a higher one a migration announced
	 * before its first commit (`announceTable`), so an old handle is refused before its SQL could queue behind the
	 * migration's DDL (fix round 1, Sol 8).
	 */
	// 表当前（或正在迁移到）的版本：已记录版本与已宣布迁移取较大者。
	tableVersion(name: string): number | undefined {
		// 已提交的版本。
		const recorded = this.#catalog.get(name)?.version;
		// 尚未提交的迁移版本。
		const announced = this.#announced.get(name);
		// 宣布值更高时返回它，让旧表句柄在排队前就被拒绝。
		return announced === undefined || (recorded !== undefined && recorded >= announced) ? recorded : announced;
	}

	/** Announces a migration of table `name` to `version` until the returned withdrawal (after its last commit). */
	// 宣布表迁移到 version，返回撤销函数（迁移最后一次提交后调用）。
	announceTable(name: string, version: number): () => void {
		// 旧句柄读取此值判断是否过期。
		this.#announced.set(name, version);
		return () => {
			// 只撤销自己宣布的版本，避免误删后续迁移。
			if (this.#announced.get(name) === version) this.#announced.delete(name);
		};
	}

	/** Attaches the open host; a store attached to an open host is refused (rule 7). */
	// 绑定打开宿主；已绑定另一个宿主时拒绝（rule 7）。
	attach(attachment: Attachment): void {
		// 一个 store 只能有一个打开宿主。
		if (this.#attachment !== undefined) {
			// 调用方错误，不是存储失败。
			throw new ChordError({ code: "invalid", reason: "args", message: "store: already attached to an open host" });
		}
		// 绑定后提供 batch 与失败监听。
		this.#attachment = attachment;
	}

	/** The host closed: the store may serve another one. */
	// 宿主关闭：解绑，允许下一个宿主 attach。
	detach(): void {
		// 不再向旧宿主发失败通知。
		this.#attachment = undefined;
	}

	/**
	 * Commits `writes` as one seq when the commit queue reaches it: `fence.admit()` at the step's entry, the writes in
	 * their order (retirements, creations, the rest), the outbox commit, `lastSeq` and the allocator's value, `COMMIT`,
	 * then `fence.adopt` before the next step starts. Resolves with the seq. A refused admission rejects `released`. A
	 * step the backend rolled back after the step's own code threw (a refusal, D4) rejects with that error unchanged and
	 * the store goes on; any other failure (`BEGIN`, `COMMIT`, `ROLLBACK`, a throwing `adopt`) is an unknown outcome
	 * that stops the store (`storage_failed`). `context` counts the step (no abort once queued).
	 */
	// 提交一组写入为一个 seq：排队、admit、按阶段写入、outbox、meta、COMMIT、更新内存、adopt。
	// 输入 writes/fence/context；成功返回 seq；拒绝原样拒绝，未知结果停库；context 只用于计量。
	// 示例：await store.commit([staged], fence, ctx) 在队列轮到时执行，返回新 seq。
	commit(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		try {
			this.assertUsable();
		} catch (error) {
			// 已停止/关闭：立即拒绝，不进入队列。
			return Promise.reject(error);
		}
		// 排到队尾之后执行提交步骤。
		const step = this.#tail.then(() => this.#step(writes, fence, context));
		// 无论成功失败都放行下一步。
		this.#tail = step.then(NOTHING, NOTHING);
		// 调用者拿到本步结果。
		return step;
	}

	/**
	 * Commits `commits` in one backend transaction when the commit queue reaches them, one seq each, in order: each
	 * commit's `check`, which writes nothing, then its writes as `commit` writes them, with its own outbox commit and the
	 * metadata (a commit without writes takes no seq: it stands at the one before). A `check` that throws refuses its
	 * commit: the series stops there and the transaction commits the ones before it. A check whose backend statement
	 * failed, and a throw of a commit's writes, roll the whole series back and reject with that error, the store going
	 * on (D4); any other failure is an unknown outcome that stops the store, as for `commit`. After `COMMIT`,
	 * `receive(index, seq, ids)` is called per stored commit, in order, before the next step starts (`ids`: its created
	 * documents). Resolves with what it stored.
	 */
	// 在一个后端事务中按顺序提交多个 commit，每个占一个 seq（空写不占）。
	commitSeries(
		commits: readonly SeriesCommit[],
		receive: (index: number, seq: number, ids: readonly number[]) => void,
		context: Context,
	): Promise<SeriesResult> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		// 整段系列占一个队列位置。
		const series = this.#tail.then(() => this.#series(commits, receive, context));
		// settle 后放行后续提交。
		this.#tail = series.then(NOTHING, NOTHING);
		// 返回 SeriesResult。
		return series;
	}

	/**
	 * Runs `read` on the backend under the guard (rule 11, Durable's `GuardedStorage`): refused once the store stopped
	 * or closed; a backend error fails the store unless `context` was aborted (then `aborted`); a read settling after
	 * the store stopped rejects `unavailable/storage_failed`. `read` returns data and never throws for a request: an
	 * adapter checks a request from what it returned, after the guard (slice 6b §1.4).
	 */
	// 在读取守卫下执行读：停止/关闭拒绝，后端错误停库，abort 转 aborted。
	read<T>(read: (executor: SqliteExecutor) => Promise<T>, context: Context): Promise<T> {
		// 单条读直接使用数据库。
		return this.#guarded(() => read(this.#db), context);
	}

	/**
	 * `read` for several queries that must see one state (S4, a document from its record and revisions): one backend
	 * transaction, guarded as `read`.
	 */
	// 多条读需要同一状态时，用一个后端事务包住。
	readTransaction<T>(read: (executor: SqliteExecutor) => Promise<T>, context: Context): Promise<T> {
		// 事务仍受同一读取守卫。
		return this.#guarded(() => this.#db.transaction(read), context);
	}

	// 读取守卫：先检查可用，再计 underway，失败分类后统一 settle。
	async #guarded<T>(run: () => Promise<T>, context: Context): Promise<T> {
		this.assertUsable();
		// close 需要等这次读取结束。
		this.#underway++;
		// 保存结果，最后统一返回。
		let result: T;
		try {
			// A read throwing before its first await is the backend's too: inside the `try`.
			// 首次 await 前抛出的错误也算后端错误（在 try 内）。
			result = await run();
		} catch (error) {
			this.assertUsable();
			// 读取期间的中止信号。
			const signal = context.abortSignal;
			// 中止优先于后端错误：这是调用方取消，不是存储失败。
			if (signal?.aborted)
				// cause 保留取消原因。
				throw new ChordError({ code: "aborted", message: "store: read aborted" }, { cause: signal.reason });
			// 其他后端错误：停库并抛 storage_failed。
			throw this.#fail(error);
		} finally {
			// 无论结果如何都通知 close。
			this.#settle();
		}
		// 读取完成后再确认 store 仍可用。
		this.assertUsable();
		return result;
	}

	/** One read or maintenance write settled: `close` goes on once none is underway. */
	// 一次读取/维护写结束；归零时唤醒 close。
	#settle(): void {
		// 只在归零时 resolve，之后清空由 #close 负责。
		if (--this.#underway === 0) this.#drained?.();
	}

	/**
	 * Runs `write` on the backend outside the commit queue (the outbox's `trim`), in a backend transaction, guarded as
	 * a read without a context: any error stops the store.
	 */
	// 提交队列之外的维护写（outbox trim），自带事务并按读取守卫处理错误。
	async maintain(write: (executor: SqliteExecutor) => Promise<void>): Promise<void> {
		this.assertUsable();
		this.#underway++;
		try {
			// 维护写与读取一样计入 underway。
			await this.#db.transaction(write);
		} catch (error) {
			this.assertUsable();
			// 维护写失败：没有 context 可判断中止，任何错误都停库。
			throw this.#fail(error);
		} finally {
			// 结束计数。
			this.#settle();
		}
	}

	// 关闭 store：等待队列与读取，拒绝后续提交；幂等。
	close(context: Context): Promise<void> {
		// 只真正关闭一次；后到者共享 Promise。
		this.#closing ??= this.#close();
		// context 只结束本次等待，不取消关闭。
		return awaitWithContext(this.#closing, context);
	}

	// 实际关闭流程：标记 closed、结束导出、等队列、等读取、关后端。
	async #close(): Promise<void> {
		// 先置 closed：新读取/提交立即拒绝。
		this.#state = { kind: "closed" };
		// 结束所有占用/等待队列的导出；复制一份避免迭代中修改。
		for (const end of [...this.#held]) end();
		// 等当前提交步骤（及其 rollback/commit）结束。
		await this.#tail;
		// 还有读取未 settle。
		if (this.#underway > 0) {
			// 挂起直到 #settle 归零。
			await new Promise<void>((resolve) => {
				// #settle 读取这个 resolve。
				this.#drained = resolve;
			});
		}
		// 最后关闭后端。
		await this.#db.close();
	}

	// 一次提交的完整步骤：准入、空提交、事务写入、COMMIT 后内存更新与采纳。
	async #step(writes: readonly StagedWrite[], fence: CommitFence, context: Context): Promise<number> {
		this.assertUsable();
		// seal fence 的入口检查。
		if (!fence.admit()) {
			// 拒绝且不写任何东西。
			throw new ChordError({ code: "released", reason: "discarded", message: "store: the commit's attempt ended" });
		}
		// 空提交不取 seq，但仍要 adopt（可能抛错停库）。
		if (writes.length === 0) {
			// An empty commit takes no seq; a throwing `adopt` stops the store as for any commit.
			try {
				// 空提交原地采纳当前 seq。
				fence.adopt(this.#lastSeq, []);
			} catch (error) {
				// 空提交的 adopt 抛错同样属于未知结果，停库。
				throw this.#fail(error);
			}
			// 返回当前 seq，不递增。
			return this.#lastSeq;
		}
		// 新提交取下一个 seq。
		const seq = this.#lastSeq + 1;
		// Past the safe range seqs stop counting exactly (a later one would repeat): the store cannot number further.
		// 超过安全整数后 seq 会重复，直接停库。
		if (seq > Number.MAX_SAFE_INTEGER) throw this.#fail(new Error("store: no seq past Number.MAX_SAFE_INTEGER"));
		// 记住步骤自己抛出的错误，用于区分回滚与未知结果。
		let thrown: unknown = NONE;
		// 事务成功后的返回值。
		let done: { readonly step: Step; readonly nextId: number };
		try {
			// 所有写入在一个后端事务中。
			done = await this.#db.transaction(async (executor) => {
				try {
					// 步骤持有 executor、seq、分配器与目录。
					const step = new Step(executor, seq, this.#ids, this.#catalog);
					// 按阶段应用写入、写目录与 outbox。
					const nextId = await this.#write(step, writes);
					// 事务内最后更新 last_seq/next_id。
					await writeMeta(step, nextId);
					// 带回内存提交后的步骤与分配器值。
					return { step, nextId };
				} catch (error) {
					// 标记为步骤自身错误。
					thrown = error;
					throw error;
				}
			});
		} catch (error) {
			// The facade rolled back and rejects with the step's own error: a refusal, the store goes on (D4).
			// 同一错误：对方回滚后原样拒绝（refusal），store 继续（D4）。
			if (error === thrown) throw error;
			// 其他错误（BEGIN/COMMIT/ROLLBACK）：结果未知，停库。
			throw this.#fail(error);
		}
		// `COMMIT` returned: the commit is durable, and memory follows.
		// COMMIT 已返回，提交持久化。
		const { step, nextId } = done;
		// 内存水位跟进。
		this.#lastSeq = seq;
		// 持久化的分配器值跟进。
		this.#committedNextId = nextId;
		// 把本步骤改变的表记录并入内存目录。
		for (const [name, record] of step.tables) this.#catalog.set(name, record);
		// 有遥测适配器时记录指标。
		const metrics = context.telemetry.metrics;
		// 一次提交。
		metrics?.counter("chord.store.commits").add(1);
		// 步骤内语句数。
		metrics?.counter("chord.store.statements").add(step.statements);
		try {
			// 提交后采纳；这里抛错属于未知结果。
			fence.adopt(seq, step.created);
		} catch (error) {
			throw this.#fail(error);
		}
		// 提交成功。
		return seq;
	}

	/**
	 * A series inside one backend transaction: per commit a step at the next seq, its check (a throw refuses it, unless
	 * one of its statements failed), then its writes; then, after `COMMIT`, memory and the receipts as after `#step`.
	 */
	// 系列提交：校验 seq 范围，在一个事务中写入，再更新内存并逐条 receive。
	async #series(
		commits: readonly SeriesCommit[],
		receive: (index: number, seq: number, ids: readonly number[]) => void,
		context: Context,
	): Promise<SeriesResult> {
		this.assertUsable();
		// Past the safe range seqs stop counting exactly (a later one would repeat): the store cannot number further. Only
		// a commit with writes takes a seq, as for `commit`.
		// 只统计有写入的提交。
		let seqs = 0;
		// 空写提交不占 seq。
		for (const commit of commits) if (commit.writes.length > 0) seqs++;
		// 整段系列结束后不能越过安全整数。
		if (this.#lastSeq + seqs > Number.MAX_SAFE_INTEGER) {
			// 直接停库，事务尚未开始。
			throw this.#fail(new Error("store: no seq past Number.MAX_SAFE_INTEGER"));
		}
		let thrown: unknown = NONE;
		// 记录系列停止的原因。
		let refused: { readonly error: unknown } | undefined;
		// 事务成功后的系列结果。
		let done: Series;
		try {
			// 整个系列一个事务。
			done = await this.#db.transaction(async (executor) => {
				try {
					// refuse 回调只记录拒绝原因，不抛出。
					return await this.#writeSeries(executor, commits, (error) => {
						// 保存第一次拒绝（系列在此停止）。
						refused = { error };
					});
				} catch (error) {
					thrown = error;
					throw error;
				}
			});
		} catch (error) {
			// The facade rolled back and rejects with the series' own error: the store goes on (D4).
			// 系列自身错误：回滚后原样拒绝，store 继续。
			if (error === thrown) throw error;
			// 其他错误：未知结果，停库。
			throw this.#fail(error);
		}
		// `COMMIT` returned: the stored commits are durable, and memory follows.
		// COMMIT 已返回，解构事务结果。
		const { stored, last, written, statements } = done;
		// 至少有一个提交真正写入。
		if (last !== undefined) {
			// 水位推进到最后一个写入提交。
			this.#lastSeq = last.seq;
			// 分配器持久值跟进。
			this.#committedNextId = last.nextId;
			// 并入系列改变的表记录。
			for (const [name, record] of last.tables) this.#catalog.set(name, record);
		}
		const metrics = context.telemetry.metrics;
		// 按实际写入的提交数计数。
		metrics?.counter("chord.store.commits").add(written);
		// 系列语句总数。
		metrics?.counter("chord.store.statements").add(statements);
		try {
			// 按顺序把每个已存提交交给调用方；抛错则停库。
			for (const [index, { seq, created }] of stored.entries()) receive(index, seq, created);
		} catch (error) {
			// receive 抛错：提交已持久化但内存无法跟进，属于未知结果。
			throw this.#fail(error);
		}
		// 有拒绝时一并返回原因。
		return refused === undefined ? { stored: stored.length } : { stored: stored.length, refused: refused.error };
	}

	/**
	 * The commits of a series in its backend transaction, until one is refused (`refuse`): each commit's check, then its
	 * writes; the metadata once, at the end.
	 */
	// 系列事务内的循环：逐提交检查（不写）、再写入；最后统一写 meta。
	async #writeSeries(
		executor: SqliteExecutor,
		commits: readonly SeriesCommit[],
		refuse: (error: unknown) => void,
	): Promise<Series> {
		// 每次 check 前重置的标志：区分检查自身拒绝与后端调用失败。
		const calls = { failed: false };
		// 包装 executor，任何语句抛错都会置位。
		const watched = watchCalls(executor, calls);
		// 系列进度从当前分配器与全局目录开始。
		const progress: SeriesProgress = {
			stored: [],
			last: undefined,
			// 当前运行中分配器值。
			nextId: this.#ids.value,
			changed: undefined,
			statements: 0,
		};
		// 顺序执行，前一个提交的写入对后一个 check 可见。
		for (const commit of commits) {
			// 检查不写入。
			const refusal = await this.#checkCommit(commit, watched, calls, progress);
			// 检查拒绝：系列停在此处。
			if (refusal !== undefined) {
				// 记录原因，交由 #series 返回。
				refuse(refusal.error);
				// 不执行该提交及其后的提交。
				break;
			}
			// 检查通过：写入该提交。
			await this.#writeCommit(commit, executor, progress);
		}
		// 写 meta 并返回内存需要的值。
		return this.#closeSeries(progress);
	}

	/**
	 * Runs `commit`'s check on a step at the series' next seq whose backend calls are watched; resolves with its refusal,
	 * if it refused. A check one of whose backend calls failed throws instead: a failure, not a refusal.
	 */
	// 在系列的下一 seq 上运行 check；语句失败视为未知结果，不是业务拒绝。
	async #checkCommit(
		commit: SeriesCommit,
		watched: SqliteExecutor,
		calls: { failed: boolean },
		progress: SeriesProgress,
	): Promise<{ readonly error: unknown } | undefined> {
		// check 只能读；目录用系列已改动的副本（若有）。
		const step = new Step(watched, this.#nextSeq(progress), this.#ids, progress.changed ?? this.#catalog);
		// 本次检查的调用监视重置。
		calls.failed = false;
		try {
			// 业务检查成功。
			await commit.check(step);
			// 没有拒绝。
			return undefined;
		} catch (error) {
			// 后端语句失败：系列整体回滚并停库，而不是业务拒绝。
			if (calls.failed) throw error;
			// 纯业务抛错：记录为拒绝。
			return { error };
		} finally {
			// 检查语句也计入总数。
			progress.statements += step.statements;
		}
	}

	/**
	 * Writes `commit` on its own step at the series' next seq (`#write`), unwatched, and keeps the table records it
	 * changed in a copy of the catalog, made only once one changed; a commit without writes takes no seq.
	 */
	// 写入一个通过检查的提交；空写不占 seq。
	async #writeCommit(commit: SeriesCommit, executor: SqliteExecutor, progress: SeriesProgress): Promise<void> {
		// 该提交应占的 seq。
		const seq = this.#nextSeq(progress);
		// 空写提交：不建 step、不占 seq。
		if (commit.writes.length === 0) {
			// 记录它停在再前一个 seq。
			progress.stored.push({ seq: seq - 1, created: [] });
			// 继续下一个提交。
			return;
		}
		// 写入步骤使用系列当前目录。
		const step = new Step(executor, seq, this.#ids, progress.changed ?? this.#catalog);
		// 写入后分配器值可能升高。
		progress.nextId = await this.#write(step, commit.writes);
		// 累计写入语句数。
		progress.statements += step.statements;
		// 该步骤改变过表定义。
		if (step.tables.size > 0) {
			// 首次变化才复制目录，避免无谓开销。
			progress.changed ??= new Map(this.#catalog);
			// 把变化并入副本。
			for (const [name, record] of step.tables) progress.changed.set(name, record);
		}
		// 系列最后一个写入步骤。
		progress.last = step;
		// 记录该提交的 seq 与新建 id。
		progress.stored.push({ seq, created: step.created });
	}

	/** The seq the series' next commit takes. */
	// 系列下一个提交的 seq：最后一个写入步骤之后，或当前水位之后。
	#nextSeq(progress: SeriesProgress): number {
		// 空写不推进 last。
		return (progress.last?.seq ?? this.#lastSeq) + 1;
	}

	/** Ends the series' writes with the metadata, once, after its last commit that wrote; returns what memory takes. */
	// 系列收尾：有写入才写 meta，并计算写入数与语句数。
	async #closeSeries(progress: SeriesProgress): Promise<Series> {
		// 取出事务收尾需要的值。
		const { stored, last, nextId, changed, statements } = progress;
		// 全是空写：不写 meta。
		if (last === undefined) return { stored, last: undefined, written: 0, statements };
		// 用最后写入步骤的 seq 更新水位与分配器。
		await writeMeta(last, nextId);
		return {
			stored,
			// 没有表变化时返回空映射。
			last: { seq: last.seq, nextId, tables: changed ?? new Map() },
			// 本次系列实际推进的 seq 数。
			written: last.seq - this.#lastSeq,
			// 加上这次的 meta UPDATE。
			statements: statements + 1,
		};
	}

	/**
	 * The step's writes inside its backend transaction: each staged write in its phase, the catalog, the outbox commit.
	 * Returns the allocator's value, taken once, after the writes applied (mints meanwhile only raise it); the metadata
	 * (`writeMeta`) is the caller's.
	 */
	// 步骤内应用写入：先按 ORDER 分阶段，再写目录与 outbox，返回分配器值。
	async #write(step: Step, writes: readonly StagedWrite[]): Promise<number> {
		// 本步骤的 seq，用于 outbox 行。
		const seq = step.seq;
		// 只有开启 outbox 才收集写入记录。
		const recorded: StoreWrite[] | undefined = this.#outbox !== undefined ? [] : undefined;
		// retire -> create -> write。
		for (const order of ORDER) {
			// 同阶段内保持 staged 顺序。
			for (const write of writes) {
				// 跳过其他阶段。
				if (write.order !== order) continue;
				// 每个 StagedWrite 自己执行 SQL 并返回 outbox 记录。
				const done = await write.apply(step);
				// 收集到本 seq 的 outbox 行。
				recorded?.push(...done);
			}
		}
		// 把本步骤发生的表定义变化写入目录表。
		await writeCatalog(step);
		// 写入期间的 mint 已抬高分配器值。
		const nextId = this.#ids.value;
		// 有 outbox 时插入一行。
		if (recorded !== undefined) {
			// 一行包含 seq、格式、next_id 与本步全部写入的 JSON。
			await step.run(
				`INSERT INTO ${TABLES.outbox} (seq, format, next_id, writes) VALUES (?, ?, ?, ?)`,
				seq,
				OUTBOX_FORMAT,
				nextId,
				// 写入记录在此序列化；读端按 OUTBOX_FORMAT 解析。
				JSON.stringify(recorded),
			);
		}
		// 交给 writeMeta 持久化。
		return nextId;
	}

	/**
	 * Batch apply's turn (slice 6b §1.6, S5): refused (`invalid/args`) while an owner holds a claim (its memory would
	 * go stale) and once the store diverged; otherwise `apply` runs in the commit queue, in one backend transaction, and
	 * returns the position its last commit leaves (`lastSeq`, the allocator's value) and the tables it changed, which
	 * memory takes after `COMMIT`. `apply`'s own error rolls back and rejects as a refusal (a `Diverged` one marks the
	 * store diverged); any other failure stops the store.
	 */
	// 批量回放的入口：检查无人持有 claims 且未 diverged，然后排入提交队列。
	replay(
		apply: (executor: SqliteExecutor, catalog: ReadonlyMap<string, TableRecord>) => Promise<Replayed>,
		isDivergence: (error: unknown) => boolean,
	): Promise<void> {
		try {
			// 调用时先检查，尽早拒绝。
			this.#assertReplayable();
		} catch (error) {
			return Promise.reject(error);
		}
		// 回放占一个队列位置，与普通提交互斥。
		const turn = this.#tail.then(() => this.#replay(apply, isDivergence));
		// settle 后放行后续提交。
		this.#tail = turn.then(NOTHING, NOTHING);
		// 返回回放结果。
		return turn;
	}

	/** At its call and again at its turn: a claim or a divergence may come between the two. */
	// 回放条件：store 可用、未 diverged、没有 owner 持有 claims。
	#assertReplayable(): void {
		this.assertUsable();
		// 计数不一致后永久拒绝回放。
		if (this.#diverged) throw invalid("args", "store: diverged; a batch can no longer apply");
		// 有 owner 内存仍在使用时回放会让它过期。
		if (this.claims.held) throw invalid("args", "store: an owner holds claims; a batch would stale its memory");
	}

	// 队列轮到时的回放：再次检查条件，并在 apply 期间锁住 claims。
	async #replay(
		apply: (executor: SqliteExecutor, catalog: ReadonlyMap<string, TableRecord>) => Promise<Replayed>,
		isDivergence: (error: unknown) => boolean,
	): Promise<void> {
		this.#assertReplayable();
		// While it applies, no owner may claim (and read) what it is changing.
		// 回放期间任何 owner 都不能 claim/读取。
		const unlock = this.claims.lock();
		try {
			// 实际事务与内存更新。
			await this.#applyReplay(apply, isDivergence);
		} finally {
			// 无论成功失败都解锁。
			unlock();
		}
	}

	// 在一个后端事务中调用 apply；区分分歧、业务错误与未知结果。
	async #applyReplay(
		apply: (executor: SqliteExecutor, catalog: ReadonlyMap<string, TableRecord>) => Promise<Replayed>,
		isDivergence: (error: unknown) => boolean,
	): Promise<void> {
		let thrown: unknown = NONE;
		// 事务成功后的新位置。
		let replayed: Replayed;
		try {
			// apply 的写入与目录变化都在此事务。
			replayed = await this.#db.transaction(async (executor) => {
				try {
					// apply 拿到 executor 与当前目录。
					return await apply(executor, this.#catalog);
				} catch (error) {
					thrown = error;
					throw error;
				}
			});
		} catch (error) {
			// 事务框架错误：未知结果，停库。
			if (error !== thrown) throw this.#fail(error);
			// 判定为分歧后拒绝后续回放。
			if (isDivergence(error)) this.#diverged = true;
			throw error;
		}
		// COMMIT 后内存跟进。
		this.#lastSeq = replayed.lastSeq;
		// 持久分配器值跟进。
		this.#committedNextId = replayed.nextId;
		// 运行中分配器至少抬到回放值。
		this.#ids.raise(replayed.nextId - 1);
		// 并入回放改变的表记录。
		for (const [name, record] of replayed.tables) this.#catalog.set(name, record);
	}

	/** Whether the store has an outbox, which a replayed batch writes too. */
	// 回放是否也要写 outbox（由当前设置决定）。
	get recordsOutbox(): boolean {
		// 与 #write 的 recorded 条件一致。
		return this.#outbox !== undefined;
	}

	/** Throws `unavailable/storage_failed` once the store stopped, `released` once it closed. */
	// 可用性检查：failed -> storage_failed，closed -> released。
	assertUsable(): void {
		// 快照一次，避免中途变化。
		const state = this.#state;
		// 停止后所有操作都拒绝。
		if (state.kind === "failed") throw storageFailed(state.error);
		// 已关闭。
		if (state.kind === "closed")
			// closed 是可恢复的调用方状态，不是存储失败。
			throw new ChordError({ code: "released", reason: "closed", message: "store: closed" });
	}

	/** Stops the store after `error` (once; its host is told once); returns the error the caller rejects with. */
	// 未知结果：第一次失败时置 failed 并通知宿主，返回 storage_failed。
	#fail(error: unknown): ChordError {
		// 只通知一次；后续失败保持第一个错误。
		if (this.#state.kind === "open") {
			// 停库不可逆。
			this.#state = { kind: "failed", error };
			// 宿主据此终止或重建。
			this.#attachment?.failed(error);
		}
		// 调用方拿到统一的 unavailable/storage_failed。
		return storageFailed(error);
	}
}

/** Records `seq`, the step's, as the store's last, and the allocator's value `nextId`. */
// 事务内更新单行 meta：last_seq 与 next_id。
function writeMeta(step: Step, nextId: number): Promise<void> {
	// meta 只有 singleton = 1 一行。
	return step.run(`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ? WHERE singleton = 1`, step.seq, nextId);
}

/**
 * `executor`, setting `calls.failed` when one of its calls throws, synchronously or by rejecting, with any value: a
 * check that throws then failed in the backend, not by its own decision.
 */
// 包装 executor：任一调用抛错/拒绝都置 calls.failed。
function watchCalls(executor: SqliteExecutor, calls: { failed: boolean }): SqliteExecutor {
	// 统一包装同步抛错与异步拒绝。
	const watched = async <T>(call: () => Promise<T>): Promise<T> => {
		try {
			// 正常调用。
			return await call();
		} catch (error) {
			// 供 #checkCommit 区分后端失败与业务拒绝。
			calls.failed = true;
			throw error;
		}
	};
	return {
		// 五个方法全部经过监视。
		exec: (sql) => watched(() => executor.exec(sql)),
		// 转发 run。
		run: (sql, ...params) => watched(() => executor.run(sql, ...params)),
		// 转发 runCounted。
		runCounted: (sql, ...params) => watched(() => executor.runCounted(sql, ...params)),
		// 转发 get。
		get: (sql, ...params) => watched(() => executor.get(sql, ...params)),
		// 转发 all。
		all: (sql, ...params) => watched(() => executor.all(sql, ...params)),
	};
}

/** The `unavailable/storage_failed` error of a stopped store, its backend error as the cause. */
// 构造 unavailable/storage_failed，原始后端错误放在 cause。
function storageFailed(error: unknown): ChordError {
	// 统一的存储失败错误。
	return new ChordError(
		// code/reason 是调用方判断用的稳定词汇。
		{ code: "unavailable", reason: "storage_failed", message: "store: storage failed" },
		// 保留底层错误，便于诊断。
		{ cause: error },
	);
}
