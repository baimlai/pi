// Batch apply (slice 6b §1.6, S5, S17): a replica takes commits `from..to` as an outbox gave them, in one backend
// transaction through the store's commit queue, each write applied with its commit's seq by the applier (a trust
// boundary), `lastSeq` and the allocator set from the last commit. Internal: the sync layer's entry point.
// 本文件把另一副本的 outbox 提交原样重放到本地 store：先校验整批信封和写入形状，再在一个事务里逐条应用。
// 上游是同步层；结果写入表、文档、目录和 meta，并可选写入本地 outbox。任何计数不符都回滚整批并标记 store 已分叉。
// 所属模块：packages/chord/src/store 的副本批次重放（同步层入口）。
// 上下游：同步层取 outbox 提交后调用 applyBatch；依赖 archive.checkWrite、applier.applyWrite、Step、IdAllocator。
// 结果：Promise<void>；成功更新表/文档/目录/outbox/meta。错误：invalid/args 整批不写；Diverged 回滚并永久标记分叉。
// 能力清单：
// - applyBatch：校验信封与写入后，在 store.replay 的一次事务中重放整批。
// - checkCommit（内部）：校验 seq/nextId/writes 的运行时形状。
// - replay（内部）：逐提交建 Step、校验连续性、应用写入并更新 meta。
// - checkCreated（内部）：保证新文档 id 不会被本地分配器再次发出。
// 组合关系：applyBatch -> checkCommit/checkWrite -> store.replay -> 每条提交一个 Step -> applyWrite -> writeCatalog/outbox -> meta。
// 示例：await applyBatch(store, await outbox.read(store.lastSeq, 100, ctx), ctx);
// 阅读顺序：先 applyBatch 的校验/拒绝路径，再 replay 的游标推进，最后 checkCreated 的饱和边界。

import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import type { SqliteExecutor } from "../sqlite/index.ts";
import { IdAllocator } from "./allocator.ts";
import { applyWrite, Diverged } from "./applier.ts";
import { checkWrite } from "./archive.ts";
import { type TableRecord, writeCatalog } from "./catalog.ts";
import { OUTBOX_FORMAT, type OutboxCommit } from "./outbox.ts";
import { TABLES } from "./schema.ts";
import { Step } from "./step.ts";
import type { ChordStore, Replayed } from "./store.ts";

/**
 * Applies `commits` (from an outbox, in seq order) to `store`: refused while an owner holds a claim on it, once it
 * diverged, or when the first commit does not follow its `lastSeq` or one does not follow the one before; a write the
 * store's records refuse rolls the whole batch back (`invalid/args`); a recorded count the store does not reproduce
 * rolls it back and marks the store diverged, so every later batch is refused. Commits written to the store's outbox
 * too when it has one.
 */
// 应用一批 outbox 提交。输入 store、按 seq 排列的提交数组和上下文；返回整批成功或失败的 Promise。
// 失败路径：信封/写入形状非法 → 以 invalid/args 拒绝且不改库；seq 不连续或计数不符 → 回滚整批；计数不符还会把 store 标记为 diverged。
// 成功路径：所有提交在一个后端事务里应用，最后把 lastSeq/nextId 写回 meta。
// 示例：applyBatch(store, await outbox.read(store.lastSeq, 100, ctx), ctx) 把下一段提交追到本地；示例不负责拉取网络数据。
export function applyBatch(store: ChordStore, commits: readonly OutboxCommit[], context: Context): Promise<void> {
	let checked: OutboxCommit[];
	// 先在事务外做纯校验，避免明显的坏数据占用提交队列；map 保留顺序并给每条附上位置。
	try {
		checked = commits.map((commit, index) => checkCommit(commit, `batch: commit ${index}`, context));
	} catch (error) {
		// 这里同步返回 rejected Promise，而不是抛出：调用方的调用形式始终是 Promise。
		return Promise.reject(error);
	}
	// store.replay 取得提交队列的一次独占；第二个参数决定哪些错误要标记 diverged（只有 Diverged）。
	// 箭头函数捕获 checked；executor 和 catalog 由 store 在事务中提供。
	return store.replay(
		(executor, catalog) => replay(store, checked, executor, catalog),
		(error) => error instanceof Diverged,
	);
}

/** One commit's envelope and writes, checked (a trust boundary). */
// 校验一条提交的外壳并逐项校验写入。输入可能来自网络，所以先断言成 Partial 再检查，而不是相信静态类型。
// 返回新的提交对象（写入已规范化）；不合法时抛 invalid/args，由 applyBatch 转为拒绝。
function checkCommit(commit: OutboxCommit, what: string, context: Context): OutboxCommit {
	// Partial<OutboxCommit> 把所有字段临时当作可选，便于对运行时缺失字段取 undefined 再判断。
	const { seq, nextId, writes } = commit as Partial<OutboxCommit>;
	// 这是信任边界上的运行时校验：seq/nextId 必须是安全整数，writes 必须是数组。
	if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(nextId) || !Array.isArray(writes)) {
		throw invalid("args", `${what}: not an outbox commit`);
	}
	// 校验已排除 undefined，`!` 只是把这个事实告诉 TS；不会在运行时再检查一次。
	return {
		seq: seq!,
		nextId: nextId!,
		writes: writes.map((write, index) => checkWrite(write, `${what}: write ${index}`, context)),
	};
}

/** The batch inside the store's turn: seqs continuous from `lastSeq`, allocator values never falling. */
// 实际重放。输入 store、已校验提交、事务执行器和已提交目录；返回新的 lastSeq/nextId/变更表。
// 每条提交创建一个 Step：这样写入共享同一事务，但 seq 和分配器按提交隔离，记录与单条提交时一致。
async function replay(
	store: ChordStore,
	commits: readonly OutboxCommit[],
	executor: SqliteExecutor,
	catalog: ReadonlyMap<string, TableRecord>,
): Promise<Replayed> {
	// 复制目录到可变 Map：本批新增/修改的表定义只影响本次返回和后续提交，不直接改 store 的已提交快照。
	const tables = new Map(catalog);
	// changed 只收集发生变化的表，replay 返回后由 store 接纳这些记录。
	const changed = new Map<string, TableRecord>();
	// 本地游标从 store 当前状态开始；提交必须严格连续，避免偷偷跳号。
	let lastSeq = store.lastSeq;
	let nextId = store.nextId;
	// entries() 同时给出下标和值；下标用于错误消息定位。
	for (const [index, commit] of commits.entries()) {
		const what = `batch: commit ${index} (seq ${commit.seq})`;
		// seq 只能比上一条大一；最初的 lastSeq 是 store 已提交的最后一条。
		if (commit.seq !== lastSeq + 1) throw invalid("args", `${what}: does not follow seq ${lastSeq}`);
		// 分配器水位不得倒退，否则后续 mint 可能重复已发放的 id。
		if (commit.nextId < nextId) throw invalid("args", `${what}: its next id ${commit.nextId} is below ${nextId}`);
		// 每条提交独立的 Step：seq 固定，分配器以该提交持久化的 nextId 为起点，目录看到前面提交的改动。
		const step = new Step(executor, commit.seq, new IdAllocator(commit.nextId), tables);
		// 按记录顺序应用写入；applyWrite 负责各 kind 的细节与计数校验。
		for (const [position, write] of commit.writes.entries()) {
			const where = `${what}: write ${position} (${write.kind})`;
			// 新文档 id 必须低于该提交的 nextId，保证以后分配器不会再发出同一个 id。
			if (write.kind === "document.create") checkCreated(write.record.id, commit.nextId, where);
			// await 逐条执行，保持同一事务内的顺序和错误位置。
			await applyWrite(step, write, where);
		}
		// 先写目录（表定义变化），再把步骤内的表记录合入本批快照。
		await writeCatalog(step);
		for (const [name, record] of step.tables) {
			tables.set(name, record);
			changed.set(name, record);
		}
		// 若本地也维护 outbox，就把收到的提交按原格式落库，供下一跳读取。
		if (store.recordsOutbox) {
			await executor.run(
				`INSERT INTO ${TABLES.outbox} (seq, format, next_id, writes) VALUES (?, ?, ?, ?)`,
				commit.seq,
				OUTBOX_FORMAT,
				commit.nextId,
				JSON.stringify(commit.writes),
			);
		}
		// 推进游标：下一条提交必须接着这一个。
		lastSeq = commit.seq;
		nextId = commit.nextId;
	}
	// 所有提交成功后才更新 meta；任何中途抛错都会让整个后端事务回滚。
	await executor.run(`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ? WHERE singleton = 1`, lastSeq, nextId);
	// Replayed 的形状：store 用这些值更新内存状态，并把 changed 中的目录记录纳入当前视图。
	return { lastSeq, nextId, tables: changed };
}

/**
 * A created document's id is below its commit's next id (the allocator never mints it again), or equal to a saturated
 * next id (`Number.MAX_SAFE_INTEGER` may be written, as import allows).
 */
// 校验显式写入的文档 id 与提交的分配器水位。无返回；不符合时抛 invalid/args。
// 正常情况下 id < nextId；导入允许把 id 恰好写成饱和值 MAX_SAFE_INTEGER，此时分配器不会再 mint，因此不会重复。
function checkCreated(id: number, nextId: number, what: string): void {
	// 条件成立就放行；两个分支分别对应普通水位和饱和边界。
	if (id < nextId || (nextId === Number.MAX_SAFE_INTEGER && id === nextId)) return;
	// 其余情况都会让未来 mint 再次产生这个 id，必须在事务中拒绝。
	throw invalid("args", `${what}: id ${id} is not below the commit's next id ${nextId}`);
}
