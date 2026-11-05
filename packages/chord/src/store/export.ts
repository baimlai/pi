// `store.export(ctx)` (slice 6a §13, rule 26): the store's state after its `lastSeq` as archive parts, read page by
// page with plain reads while the export holds the commit queue (no commit can interleave, no long read transaction).
// The queue is taken at the first `next()` and given back when the iteration ends, throws, is closed or `ctx` aborts;
// an abort while the consumer is suspended gives it back at once and drops the pages and records the export held, and
// an abort while it waits for the queue ends the wait. Closing the store ends it too (`released`).

// 文件导读
// 所属：packages/chord/src/store（store 层，归档导出）。
// 职责边界：持住提交队列后按页读取 store 状态并产出 ArchivePart 流；不写数据库，也不做 JSONL 编码（见 jsonl.ts）。
// 上游：store.export(ctx) 构造 StoreExport。下游：应用或 encodeJsonl 消费 parts；读取通过 engine.listRecords/listRevisions 与普通 store.read。
// 能力清单：
// - EXPORT_PAGE：每页读取行数；
// - StoreExport：异步迭代器，管理队列占用/释放与终止状态；
// - aborted（内部）：构造 aborted 错误；
// - parts（内部）：按 manifest/table/put/index/document/end 顺序生成；
// - puts/putOf（内部）：记录表的分页 put；
// - documents/revisions（内部）：文档记录与修订的分页导出。
// 组合顺序：export() -> 第一次 next() 触发 parts -> take 队列 -> manifest -> 每表 table + puts + index -> documents + revisions -> end -> finally 释放队列；abort/close/return 都走 #end。
// 示例：for await (const part of store.export(ctx)) 依次得到 manifest、table、put、index、document.create、document.revision、end。
// 建议阅读顺序：EXPORT_PAGE/StoreExport 字段 -> next/return/#hold/#end -> parts -> puts/putOf -> documents/revisions。
import { awaitWithContext, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { ARCHIVE_FORMAT, type ArchivePart } from "./archive.ts";
import type { TableRecord } from "./catalog.ts";
import { listRecords, listRevisions } from "./engine.ts";
import { ROW_VERSION, type Scalar, versionColumn } from "./rows.ts";
import { STORE_SCHEMA } from "./schema.ts";
import { quote, recordedPut } from "./sql.ts";
import type { ChordStore } from "./store.ts";

/** The rows and documents an export reads per page. */
// 每页读取行数；控制单次查询的内存与持锁时间。
export const EXPORT_PAGE = 100;

/**
 * An export of `store` under `context`: an async iterator of its parts. One pass; after an abort `next()` rejects
 * `aborted`, after the store closed `released`.
 */
// 导出的异步迭代器：第一次 next 才占队列，结束/中止/关闭都会释放。
export class StoreExport implements AsyncIterableIterator<ArchivePart> {
	// 导出使用的 context；中止信号决定 aborted 错误与监听器。
	readonly #context: Context;
	/** The parts, until the export ends; dropped then, with the pages they hold. */
	// 实际生成器；结束时置空并丢弃其持有的页。
	#parts: AsyncGenerator<ArchivePart> | undefined;
	// 终止状态；只能从 open 迁移一次，保证释放幂等。
	#state: "open" | "aborted" | "closed" | "ended" = "open";
	/** Gives the commit queue back while the export holds it. */
	// 占用提交队列时拿到的释放闭包；未占用时为 undefined。
	#release: (() => void) | undefined;
	// 箭头函数捕获 this，可安全作为 abort 监听器。
	readonly #abort = (): void => this.#end("aborted");

	// 只创建生成器并传入 hold/end 回调；队列在第一次 next 才占用。
	constructor(store: ChordStore, context: Context) {
		this.#context = context;
		const hold = (release: () => void): void => this.#hold(release);
		this.#parts = parts(store, context, hold, () => this.#end("closed"));
	}

	// 自身就是迭代器；支持 for await…of。
	[Symbol.asyncIterator](): this {
		return this;
	}

	// 拉取下一个 part；中止/关闭在这里转成错误，结束返回 done。
	async next(): Promise<IteratorResult<ArchivePart>> {
		// 已中止：先结束导出，再让 #assertOpen 抛 aborted。
		if (this.#context.abortSignal?.aborted) this.#end("aborted");
		this.#assertOpen();
		// 已结束：不再产生 part。
		if (this.#parts === undefined) return { done: true, value: undefined };
		// 启动一次生成器拉取；此时可能开始占用队列。
		const pending = this.#parts.next();
		// 明确保存结果，便于 catch 后统一检查状态。
		let result: IteratorResult<ArchivePart>;
		try {
			// Until the export holds the queue only `context` ends the wait; from then on its abort listener does.
			// 未占队列时用 context 竞争等待；占用队列后由 abort 监听器结束等待。
			result = await (this.#release === undefined ? awaitWithContext(pending, this.#context) : pending);
		} catch (error) {
			// 生成器抛错：若因 context 中止则记 aborted，否则按已结束处理；先区分两种来源。
			if (this.#context.abortSignal?.aborted) this.#end("aborted");
			this.#assertOpen();
			this.#end("ended");
			throw error;
		}
		// Ended meanwhile (an abort, the store's close): no part after that, even one that needed no read.
		this.#assertOpen();
		// 正常结束：释放队列并关闭生成器。
		if (result.done) this.#end("ended");
		return result;
	}

	// for await 提前 break 或调用者手动关闭时走这里；幂等。
	async return(): Promise<IteratorResult<ArchivePart>> {
		this.#end("ended");
		return { done: true, value: undefined };
	}

	/** The parts took the queue: the export holds it until it ends, and an abort ends it; ended already, it gives it back. */
	// 生成器占用队列后的回调：若已结束就立刻释放，否则保存并监听 abort。
	#hold(release: () => void): void {
		// 导出在占用队列前已结束：不能泄漏队列，立即释放。
		if (this.#state !== "open") {
			release();
			return;
		}
		// 保存释放闭包，供 #end 调用一次。
		this.#release = release;
		// once 避免重复触发；#end 里会先移除。
		this.#context.abortSignal?.addEventListener("abort", this.#abort, { once: true });
	}

	/** Ends the export once: the queue given back, the parts closed (once they reach a `yield`) and dropped. */
	// 唯一的终止路径：释放队列、移除监听、关闭并丢弃生成器；重复调用无效果。
	#end(state: "aborted" | "closed" | "ended"): void {
		// 已终止：保持第一次的状态与错误。
		if (this.#state !== "open") return;
		// 先记状态，后续 next 会据此抛错。
		this.#state = state;
		// 只有占用过队列才需要释放。
		this.#release?.();
		this.#release = undefined;
		// 终止后不再需要 abort 监听。
		this.#context.abortSignal?.removeEventListener("abort", this.#abort);
		// 异步关闭生成器；失败无关紧要，也不能让 #end 抛错。
		void this.#parts?.return(undefined).catch(() => {});
		// 丢弃生成器与其持有的分页数据。
		this.#parts = undefined;
	}

	/** Throws `aborted` after an abort, `released` after the store closed. */
	// 在每次 next 的前后把终止状态转成对外错误。
	#assertOpen(): void {
		// 中止错误保留 signal.reason 作为 cause。
		if (this.#state === "aborted") throw aborted(this.#context);
		if (this.#state === "closed")
			throw new ChordError({ code: "released", reason: "closed", message: "store: closed" });
	}
}

/** The error of a use of an aborted export: `aborted`, the signal's reason as the cause. */
// 构造 aborted 错误；cause 是中止原因，输入 context，输出错误对象。
function aborted(context: Context): ChordError {
	return new ChordError({ code: "aborted", message: "store: export aborted" }, { cause: context.abortSignal?.reason });
}

/**
 * The parts in archive order, after taking the queue (handed to `hold`; the store's close calls `end`); the queue is
 * given back when they end.
 */
// 实际生成归档部件：先占队列，再按固定顺序产出，最后在 finally 释放。
// 输入 store/context/hold/end；输出 ArchivePart 流；读取失败直接传给消费方。
// 示例：部件顺序固定为 manifest、各表 table/put/index、文档 create/revision、end。
async function* parts(
	store: ChordStore,
	context: Context,
	hold: (release: () => void) => void,
	end: () => void,
): AsyncGenerator<ArchivePart> {
	// 占用提交队列；若等待期间 store 关闭，take 会以 released 拒绝。
	const release = await store.take(end);
	// 把释放闭包交给 StoreExport；若导出已结束，hold 会立即释放。
	hold(release);
	try {
		// 占用队列后再次检查中止，避免产出任何 part。
		if (context.abortSignal?.aborted) throw aborted(context);
		// manifest 记录导出点的 seq 与分配器值。
		const { lastSeq, nextId } = store;
		// 第一个部件是格式/schema/水位清单。
		yield { kind: "manifest", format: ARCHIVE_FORMAT, schema: STORE_SCHEMA, lastSeq, nextId };
		// 统计写入部件数量，供最后 end 部件与导入侧核对。
		let writes = 0;
		// 表按 SQL 名排序，保证导出顺序稳定（便于比较归档）。
		const tables = [...store.tables.values()].sort((a, b) => (a.table < b.table ? -1 : 1));
		// 每张记录表：定义、所有行、索引。
		for (const record of tables) {
			// 解构出导入侧重建表所需字段。
			const { table, version, state, columns, key, fingerprint } = record;
			// 表定义部件；导入时先建表再放行。
			yield { kind: "table", table, version, state, columns, key, fingerprint };
			writes++;
			// 分页读取该表所有行。
			for await (const put of puts(store, record, context)) {
				yield put;
				writes++;
			}
			// 每张表的所有索引作为独立部件。
			for (const [name, on] of Object.entries(record.indexes)) {
				yield { kind: "index", table, name, columns: on };
				writes++;
			}
		}
		// 文档记录与修订在表数据之后导出。
		for await (const part of documents(store, context)) {
			yield part;
			writes++;
		}
		// 最后一个部件，携带写入总数。
		yield { kind: "end", writes };
	} finally {
		// 无论正常结束、抛错还是提前关闭，都释放队列。
		release();
	}
}

/** The `put`s of a recorded table in key order, a page per read: the stored values and their versions. */
// 按页读取一张记录表的所有行，转成 put 部件；键列保证分页全序。
async function* puts(
	store: ChordStore,
	record: TableRecord,
	context: Context,
): AsyncGenerator<Extract<ArchivePart, { readonly kind: "put" }>> {
	// 记录表的名字、列与键。
	const { table, columns, key } = record;
	// 复用 RowCodec 的物理列顺序生成 SELECT 列。
	const select = recordedPut(table, columns)
		.physical.map((name) => quote(name))
		.join(", ");
	// 按键列排序，并用相同的列做游标比较。
	const order = key.map(quote).join(", ");
	// 上一页最后一行的键；undefined 表示第一页。
	let after: SqliteValue[] | undefined;
	// 至少读一页，直到不足一页为止。
	do {
		// 固定本页游标，避免循环中修改影响 WHERE 构造。
		const page = after;
		// 行值比较实现键序续页。
		const from = page === undefined ? "" : ` WHERE (${order}) > (${page.map(() => "?").join(", ")})`;
		// LIMIT 绑定 EXPORT_PAGE。
		const sql = `SELECT ${select} FROM ${quote(table)}${from} ORDER BY ${order} LIMIT ?`;
		// 通过 store.read 读取一页；导出期间队列被占用，不会看到新提交。
		const rows = await store.read(
			(executor) => executor.all<{ readonly [column: string]: SqliteValue }>(sql, ...(page ?? []), EXPORT_PAGE),
			context,
		);
		// 每个存储行转成 put 部件。
		for (const stored of rows) yield putOf(record, stored);
		// 满页才继续；下一页从最后一行键之后开始。
		after = rows.length < EXPORT_PAGE ? undefined : key.map((name) => rows.at(-1)![name]!);
	} while (after !== undefined);
}

/** A stored row as its `put`: `NULL` cells absent, booleans from 0 and 1, `json(...)` cells parsed with versions. */
// 把存储行还原成归档行：NULL 缺省、bool 从 0/1、json 解析并带版本。
function putOf(
	record: TableRecord,
	stored: { readonly [column: string]: SqliteValue },
): Extract<ArchivePart, { readonly kind: "put" }> {
	// 归档行与版本表分开构建。
	const row: { [column: string]: Scalar | JsonValue } = {};
	// 只记录存在的 json 列版本。
	const versions: { [column: string]: number } = {};
	// 按记录列遍历；STRICT 表保证存储类型。
	for (const [name, column] of Object.entries(record.columns)) {
		const value = stored[name];
		// NULL 列不写进归档行（opt 列缺省）。
		if (value === null || value === undefined) continue;
		// The recorded columns' types say what SQLite stored (STRICT tables): text for `json(...)` with its version.
		// INTEGER 0/1 还原布尔。
		if (column.type === "bool") row[name] = value === 1;
		// JSON 存 TEXT：解析回值，同时取版本列。
		else if (column.type === "json") {
			row[name] = JSON.parse(value as string) as JsonValue;
			versions[name] = stored[versionColumn(name)] as number;
		} else row[name] = value as Scalar;
	}
	// 版本来自整行 $v 列；columns 只含 json 版本。
	return { kind: "put", table: record.table, row, version: stored[ROW_VERSION] as number, columns: versions };
}

/**
 * Every stored record by id, live and retired, as its creation without a base, then its kept revisions in seq order:
 * a `none` or `latest` record's current base and its deltas, a retired `latest` one none, a `rewindable` one all.
 */
// 按 id 分页读取全部文档记录（含已退役），每条后接其保留的修订。
async function* documents(
	store: ChordStore,
	context: Context,
): AsyncGenerator<Extract<ArchivePart, { readonly kind: "document.create" | "document.revision" }>> {
	// 文档 id 游标；从 1 开始（0 表示尚未读取）。
	let after = 0;
	// 每轮读一页记录，直到不足一页。
	for (;;) {
		// listRecords 按 id 升序读取。
		const records = await store.read((executor) => listRecords(executor, after, EXPORT_PAGE), context);
		for (const record of records) {
			// 先输出创建记录（不含 base）。
			yield { kind: "document.create", record };
			// 再把该文档的修订逐个委托给 revisions。
			yield* revisions(store, record.id, context);
		}
		// 不足一页说明读完了。
		if (records.length < EXPORT_PAGE) return;
		// 下一页从最后一个 id 之后开始。
		after = records.at(-1)!.id;
	}
}

/** Document `id`'s kept revisions in seq order, read page by page (a long history is never one array). */
// 按 seq 分页读取一个文档保留的修订；历史再长也不会一次进内存。
async function* revisions(
	store: ChordStore,
	id: number,
	context: Context,
): AsyncGenerator<Extract<ArchivePart, { readonly kind: "document.revision" }>> {
	let after = 0;
	for (;;) {
		// 每次读一页修订。
		const page = await store.read((executor) => listRevisions(executor, id, after, EXPORT_PAGE), context);
		// 每个修订展开成归档部件。
		for (const revision of page) yield { kind: "document.revision", ...revision };
		// 读完。
		if (page.length < EXPORT_PAGE) return;
		// 下一页从最后一个 seq 之后继续。
		after = page.at(-1)!.seq;
	}
}
