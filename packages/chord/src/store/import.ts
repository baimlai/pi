// `importStore(backend, parts, ctx, { outbox? })` (slice 6a §13, rules 12, 24, 25): a store made from an archive, a
// trust boundary. Every part is checked against the archive schema, its place in the archive's order and its content
// (names, rows against their table's recorded columns, ids and seqs, lifetimes at one address never overlapping,
// revisions in seq order from a base, versions, duplicates, the `end` count, the manifest); everything is applied in
// one backend transaction with the applier, so a refused import leaves the backend as it was. An input that stalls is
// cancelled by `ctx`.

// 文件导读
// 所属：packages/chord/src/store（store 层，归档导入）。
// 职责边界：校验 ArchivePart 的顺序与内容，并在一个后端事务里写入新 store；不编码 JSONL（见 jsonl.ts），失败时关闭后端。
// 上游：应用调用 importStore(backend, parts, ctx, { outbox? })。下游：checkPart/applyWrite/catalog/schema/Step 完成建表与写行；错误为 invalid/args、aborted 或后端错误。
// 能力清单：
// - importStore：入口，检查空后端、开事务、构造 ArchiveImport、结束并返回 Store；
// - inTransaction（内部）：把 executor 适配成 SqliteDatabase，让迁移不另开事务；
// - Place（内部）：归档位置的标签联合；
// - ArchiveImport：逐部件校验与应用的类；
// - take/finish/#start/#placeOf/#checkDocument/#checkRevision/#endDocument：顺序与内容检查；
// - each（内部）：消费输入并在中止时关闭输入迭代器。
// 组合顺序：importStore -> 查 meta 表确认空库 -> transaction(applyStoreSchema + ArchiveImport) -> each(parts) -> take -> #placeOf -> applyWrite -> finish 写 meta -> readCatalog -> new ChordStore。
// 示例：const store = await importStore(backend, decodeJsonl(bytes), ctx, { outbox: true }); 坏归档会拒绝且后端被关闭。
// 建议阅读顺序：importStore -> inTransaction/Place -> ArchiveImport 字段 -> take/finish -> #start/#placeOf -> #checkDocument/#checkRevision/#endDocument -> each。
import { awaitWithContext, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { SqliteDatabase, SqliteExecutor } from "../sqlite/index.ts";
import { IdAllocator } from "./allocator.ts";
import { applyWrite } from "./applier.ts";
import { ARCHIVE_FORMAT, type ArchiveManifest, type ArchivePart, checkPart } from "./archive.ts";
import type { Backend } from "./backend.ts";
import { readCatalog, writeCatalog } from "./catalog.ts";
import type { DocumentRecord } from "./engine.ts";
import { applyStoreSchema, type MetaRow, STORE_SCHEMA, TABLES } from "./schema.ts";
import { Step } from "./step.ts";
import { ChordStore, type Store, type StoreOptions } from "./store.ts";
import { storedText } from "./text.ts";

/**
 * A store holding the archive `parts` on `backend`, which must not hold a store yet: at the manifest's `lastSeq`, its
 * outbox (when `options.outbox`) starting after it. A refused archive, a stalled input cancelled by `context` or a
 * backend error rejects; the backend is closed then (rule 12).
 */
// 把归档导入一个新后端：校验+写入同一事务，成功后返回可直接使用的 Store。
// 输入 backend/parts/context/options；失败时关闭 backend 并原样抛出；成功不关闭。
// 示例：await importStore(backend, parts, ctx) 在空库上重建归档；已有 store 时 invalid/args。
export async function importStore(
	backend: Backend,
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	options: StoreOptions = {},
): Promise<Store> {
	const { db } = backend;
	try {
		// 导入开始前响应取消，避免无谓打开事务。
		context.abortSignal?.throwIfAborted();
		// 只查 store 自身的 meta 表：已有 store 就拒绝覆盖。
		const existing = await db.get(`SELECT name FROM sqlite_master WHERE name = ?`, TABLES.meta);
		// 导入只允许空后端（rule 12）。
		if (existing !== undefined) throw invalid("args", "import: the backend holds a store already");
		// 整个归档在一个后端事务中应用；任何校验失败都会回滚。
		const meta = await db.transaction(async (executor) => {
			// 迁移复用当前事务；inTransaction 阻止再开新事务。
			const meta = await applyStoreSchema(inTransaction(executor));
			// 每导入一个归档都新建状态机，记录已见表/地址/写入数。
			const archive = new ArchiveImport(executor, context);
			// 按输入顺序逐个校验并应用；中止由 each 转换。
			await each(parts, context, (part) => archive.take(part));
			// 结束校验并写入 manifest 的 lastSeq/nextId 与 outbox 设置。
			return archive.finish(meta, options.outbox === true);
		});
		// 事务提交后读取目录并构造 store；此时后端归 store 所有。
		return new ChordStore(db, meta, await readCatalog(db));
	} catch (error) {
		try {
			// 任何导入失败都关闭后端；关闭自身的错误不覆盖原始错误。
			await db.close();
		} catch {
			// The import's own failure is the one to report.
		}
		throw error;
	}
}

/** The store's schema migrations run inside the import's backend transaction (they open none of their own). */
// 把事务执行器伪装成 SqliteDatabase，供 applyStoreSchema 使用；不加锁、不另开事务。
function inTransaction(executor: SqliteExecutor): SqliteDatabase {
	return {
		// 以下方法都直接转发到当前事务执行器。
		exec: (sql) => executor.exec(sql),
		run: (sql, ...params) => executor.run(sql, ...params),
		runCounted: (sql, ...params) => executor.runCounted(sql, ...params),
		get: (sql, ...params) => executor.get(sql, ...params),
		all: (sql, ...params) => executor.all(sql, ...params),
		// 关键差异：迁移里的 transaction 直接执行回调，不会嵌套事务。
		transaction: (callback) => callback(executor),
		// 迁移路径不应关闭导入中的后端，误调用即报错。
		close: () => Promise.reject(new Error("import: the backend closes after the import")),
	};
}

/** A place in the archive's order: before the manifest, in a table group's puts or indexes, the documents, the end. */
// 归档顺序的状态标签：manifest -> 表组(puts/indexes) -> documents -> ended。
type Place = "manifest" | "puts" | "indexes" | "documents" | "ended";

/**
 * One archive being imported: the place reached in its order (the manifest, then table groups of a `table` write, its
 * `put`s and its `index` writes, then the documents, then `end`), what was seen (tables, ids, live addresses, the
 * write count) and the step its writes are applied in.
 */
// 导入状态机：检查顺序、去重、生命周期与修订链，并把合法部件交给 applyWrite。
class ArchiveImport {
	// 导入事务的执行器，所有写入共享它。
	readonly #executor: SqliteExecutor;
	// 用于 checkPart 的错误上下文与中止信号。
	readonly #context: Context;
	// 已收到的部件序号；错误消息用它定位。
	#position = 0;
	// manifest 到达后保存；后续检查依赖它的 lastSeq/nextId。
	#manifest: ArchiveManifest | undefined;
	// 应用写入的步骤；manifest 之前为 undefined。
	#step: Step | undefined;
	/** Where the next part may go. */
	// 下一个部件允许的位置。
	#place: Place = "manifest";
	/** The table whose group is open. */
	// 当前开放的表组；put/index 必须属于它。
	#table: string | undefined;
	// 已见表名，防止重复定义。
	readonly #tables = new Set<string>();
	// 已见文档 id，防止重复。
	readonly #ids = new Set<number>();
	/** The lifetimes seen at each address, `[createdAt, retiredAt)` (`Infinity` while live). */
	// 每个地址的已见生命周期，检查重叠。
	readonly #lifetimes = new Map<string, [number, number][]>();
	/** The record whose revisions may follow, with the last revision's seq and its base's version. */
	// 当前文档：记录、最后修订 seq、最后 base 版本；修订必须紧跟其 create。
	#document: { readonly record: DocumentRecord; seq: number; base: number | undefined } | undefined;
	// 已应用的写入数，与 end 部件的计数核对。
	#writes = 0;

	// 只保存事务执行器与 context；不做 I/O。
	constructor(executor: SqliteExecutor, context: Context) {
		this.#executor = executor;
		this.#context = context;
	}

	/** Checks the next part and applies it. */
	// 检查并应用一个部件：先定序号与位置，再按类型校验/写入。
	// 输入 unknown 部件；输出 Promise<void>；越序/重复/内容错误抛 invalid/args。
	// 示例：manifest 之后第一个 table 部件把位置推进到 puts。
	async take(value: unknown): Promise<void> {
		// 序号从 0 递增；即使部件非法也消耗一个位置。
		const position = this.#position++;
		// 归档是信任边界：checkPart 校验形状并附上下文。
		const part = checkPart(value, position, this.#context);
		// 统一错误前缀，指出部件号与类型。
		const what = `import: part ${position} (${part.kind})`;
		// end 之后不再接受任何部件。
		if (this.#place === "ended") throw invalid("args", `${what}: after the end`);
		// 第一个部件必须是 manifest；之后才能建 Step。
		if (part.kind === "manifest" || this.#step === undefined) {
			this.#start(part, what);
			return;
		}
		// end 部件核对写入数并结束当前文档。
		if (part.kind === "end") {
			// 计数不符说明归档缺件或多件，拒绝并回滚。
			if (part.writes !== this.#writes) {
				throw invalid("args", `${what}: counts ${part.writes} writes, the archive has ${this.#writes}`);
			}
			// 结束最后一个文档，检查其 base 完整性。
			this.#endDocument(what);
			this.#place = "ended";
			return;
		}
		// 其他部件先校验顺序，再推进位置。
		this.#place = this.#placeOf(part, what);
		// 只有真正应用的写入才计数。
		this.#writes++;
		// 具体建表/写行/写索引由 applier 完成。
		await applyWrite(this.#step, part, what);
	}

	/** The stored metadata once the archive ended: its `lastSeq`, the allocator's next id and the outbox setting. */
	// 导入结束：要求见过 end，写目录与 meta，返回更新后的 MetaRow。
	async finish(meta: MetaRow, outbox: boolean): Promise<MetaRow> {
		// 没有 end 或没有 manifest 的归档不完整。
		if (this.#place !== "ended" || this.#step === undefined || this.#manifest === undefined) {
			throw invalid("args", "import: the archive has no end part");
		}
		// 新 store 的水位与分配器值来自 manifest。
		const { lastSeq, nextId } = this.#manifest;
		// 把本步骤记录的表定义写入内部目录。
		await writeCatalog(this.#step);
		// 更新单行 meta：last_seq/next_id/outbox/outbox_floor。
		await this.#executor.run(
			`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ?, outbox = ?, outbox_floor = ? WHERE singleton = 1`,
			lastSeq,
			nextId,
			// SQLite 没有布尔：outbox 开关存 0/1。
			outbox ? 1 : 0,
			lastSeq,
		);
		// 返回内存 meta，供 ChordStore 构造使用。
		return {
			...meta,
			last_seq: lastSeq,
			next_id: nextId,
			outbox: outbox ? 1 : 0,
			outbox_floor: lastSeq,
		};
	}

	/** The manifest, first: a format and schema this code reads. */
	// 处理 manifest：格式/版本兼容检查，然后创建导入 Step。
	#start(part: ArchivePart, what: string): void {
		// manifest 必须第一个且只出现一次。
		if (part.kind !== "manifest" || this.#step !== undefined)
			throw invalid("args", `${what}: the manifest comes first, once`);
		// 写入词汇格式不匹配无法解释归档。
		if (part.format !== ARCHIVE_FORMAT)
			throw invalid("args", `${what}: format ${part.format} is not ${ARCHIVE_FORMAT}`);
		// 归档 schema 更新则当前代码读不懂，拒绝；更旧的可直接迁移升级。
		if (part.schema > STORE_SCHEMA)
			throw invalid("args", `${what}: schema ${part.schema} is newer than ${STORE_SCHEMA}`);
		// 保存 manifest，供后续范围/水位检查。
		this.#manifest = part;
		// 用 manifest 的 seq/nextId 建 Step；目录从空开始。
		this.#step = new Step(this.#executor, part.lastSeq, new IdAllocator(part.nextId), new Map());
	}

	/** Where `part` puts the archive, refused when out of order, a duplicate, or outside the manifest's ranges. */
	// 判断非 manifest/end 部件的合法位置，并更新表组状态。
	#placeOf(part: Exclude<ArchivePart, { readonly kind: "manifest" | "end" }>, what: string): Place {
		// 保存进入时位置；返回值是下一个位置。
		const place = this.#place;
		switch (part.kind) {
			// 表定义：文档之前、每个表只一次，并开启该表组。
			case "table":
				// 表定义不能出现在文档之后。
				if (place === "documents") throw invalid("args", `${what}: tables come before the documents`);
				// 同一 SQL 表名只允许一个定义部件。
				if (this.#tables.has(part.table)) throw invalid("args", `${what}: table ${part.table} occurs twice`);
				// 记录已见表名。
				this.#tables.add(part.table);
				// 后续 put/index 必须属于这个表。
				this.#table = part.table;
				return "puts";
			// 行：必须紧跟自己的 table，且在索引之前。
			case "put":
				if (place !== "puts" || part.table !== this.#table) {
					throw invalid("args", `${what}: a put follows its table's table write, before its indexes`);
				}
				return "puts";
			// 索引：属于当前表组，位于 puts 之后（也可连续多个）。
			case "index":
				if ((place !== "puts" && place !== "indexes") || part.table !== this.#table) {
					throw invalid("args", `${what}: an index follows its table's table write and puts`);
				}
				return "indexes";
			// 文档记录：检查 id、生命周期、地址与文本，再应用。
			case "document.create":
				this.#checkDocument(part, what);
				return "documents";
			// 修订：必须属于上一个 create，并满足 seq/base 规则。
			case "document.revision":
				this.#checkRevision(part, what);
				return "documents";
		}
	}

	/**
	 * A record within the manifest's ids and seqs (an id equal to a saturated `nextId` too), unique, its lifetime
	 * overlapping no other at its address; its address and meta well-formed text without NUL (SQLite would cut a NUL off,
	 * slice 6a §8). The record before it must have ended well (`#endDocument`).
	 */
	// 校验文档记录：范围、唯一性、生命周期不重叠、地址文本合法，并结束前一个文档。
	#checkDocument(part: Extract<ArchivePart, { readonly kind: "document.create" }>, what: string): void {
		// 新记录开始前，前一个文档必须已经完整结束。
		this.#endDocument(what);
		// 记录本体；字段来自 checkPart 后的归档数据。
		const { record } = part;
		// 范围由 manifest 决定；这里已保证 manifest 存在。
		const { lastSeq, nextId } = this.#manifest!;
		// 分配器饱和时允许 id 等于 nextId 的记录。
		const saturated = nextId === Number.MAX_SAFE_INTEGER && record.id === nextId;
		// 普通情况下 id 必须小于 manifest 的 nextId。
		if (record.id >= nextId && !saturated) throw invalid("args", `${what}: id ${record.id} is not below ${nextId}`);
		// 文档 id 全局唯一。
		if (this.#ids.has(record.id)) throw invalid("args", `${what}: id ${record.id} occurs twice`);
		// 生命周期必须在 [0, lastSeq] 内。
		const { createdAt, retiredAt } = record;
		// 创建/退役顺序与范围检查。
		if (createdAt > lastSeq || (retiredAt !== undefined && (retiredAt < createdAt || retiredAt > lastSeq))) {
			throw invalid("args", `${what}: a lifetime outside the manifest's lastSeq`);
		}
		// 地址四元组与可选 meta 都必须是可存储文本。
		const { namespace, owner, kind, meta } = record;
		// A singleton's record has no key; its column keeps `""`.
		// 单例文档没有 key；用空串参与地址与文本检查。
		const key = record.key ?? "";
		// 地址各部分不允许 NUL/孤立代理项，否则 SQLite 存储会截断。
		for (const text of [namespace, owner, kind, key]) {
			if (storedText(text, what) !== text) throw invalid("args", `${what}: an address is not well-formed text`);
		}
		// meta 同样要求 well-formed 文本。
		if (meta !== undefined && storedText(meta, what) !== meta) {
			throw invalid("args", `${what}: the meta is not well-formed text`);
		}
		// 用 JSON 数组编码地址，避免分隔符歧义。
		const address = JSON.stringify([owner, namespace, kind, key]);
		// 存活周期用半开区间；未退役用 Infinity。
		const lifetime: [number, number] = [createdAt, retiredAt ?? Number.POSITIVE_INFINITY];
		// 同一地址的历史生命周期。
		const lifetimes = this.#lifetimes.get(address) ?? [];
		// Two live records are two infinite lifetimes, which overlap; an empty one (`createdAt = retiredAt`) overlaps none.
		// 区间重叠检查；空生命周期（created=retired）不占地址。
		if (lifetime[0] < lifetime[1] && lifetimes.some(([from, to]) => from < lifetime[1] && lifetime[0] < to)) {
			throw invalid("args", `${what}: a second record at one address for an overlapping lifetime`);
		}
		// 记录本次生命周期。
		lifetimes.push(lifetime);
		// 写回地址映射。
		this.#lifetimes.set(address, lifetimes);
		// 标记 id 已见。
		this.#ids.add(record.id);
		// 开启当前文档，等待其修订。
		this.#document = { record, seq: 0, base: undefined };
	}

	/**
	 * A revision of the record before it, in seq order within its lifetime, from a base, each delta at its base's
	 * version.
	 */
	// 校验修订：属于当前记录、seq 递增且在生命周期内、base/delta 版本链正确。
	#checkRevision(part: Extract<ArchivePart, { readonly kind: "document.revision" }>, what: string): void {
		// 修订必须紧跟在 create 之后。
		const document = this.#document;
		// 没有当前文档或 id 不匹配都拒绝。
		if (document === undefined || document.record.id !== part.id) {
			throw invalid("args", `${what}: a revision follows its record's create`);
		}
		const { record } = document;
		// 退役的 none/latest 文档不保留修订。
		if (record.retiredAt !== undefined && record.history !== "rewindable") {
			throw invalid("args", `${what}: a retired ${record.history} record keeps no revisions`);
		}
		// seq 必须严格递增，并落在文档生命周期内。
		if (
			part.seq <= document.seq ||
			part.seq < record.createdAt ||
			part.seq > (record.retiredAt ?? this.#manifest!.lastSeq)
		) {
			throw invalid("args", `${what}: a revision out of seq order or outside its lifetime`);
		}
		// base 或 delta，两者规则不同。
		const { content } = part;
		// base 更新当前版本；后续 delta 必须与它同版。
		if (content.kind === "base") document.base = content.version;
		// delta 必须在 base 之后、且版本一致。
		else if (document.base !== content.version) {
			throw invalid("args", `${what}: a delta without a base at its version`);
		}
		// 记录最后 seq，供下一修订比较。
		document.seq = part.seq;
	}

	/**
	 * The record before ends well: its last base is at the record's version; only a retired `latest` record has none
	 * (its content was dropped at retirement; a retired `rewindable` one keeps its history).
	 */
	// 结束当前文档：最后一个 base 必须等于记录版本；退役 latest 可无内容。
	#endDocument(what: string): void {
		const document = this.#document;
		// 先清空当前文档，确保只检查一次。
		this.#document = undefined;
		// 没有打开的文档：无操作。
		if (document === undefined) return;
		// 记录与最后 base 版本。
		const { record, base } = document;
		// 退役 latest 文档的内容在退役时丢弃，允许没有 base。
		const contentless = record.retiredAt !== undefined && record.history === "latest";
		// 其它情况必须有一个与记录版本一致的 base。
		if (base === undefined ? !contentless : base !== record.version) {
			throw invalid("args", `${what}: record ${record.id} has no base at its version`);
		}
	}
}

/** Runs `take` on each part in turn; a wait for the next part ends when `context` aborts (the input is closed). */
// 逐个拉取输入部件并调用 take；等待可被 context 中止。
async function each(
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	take: (part: unknown) => Promise<void>,
): Promise<void> {
	// 同时支持异步与同步可迭代输入。
	const iterator = Symbol.asyncIterator in parts ? parts[Symbol.asyncIterator]() : parts[Symbol.iterator]();
	// 记录输入是否正常结束，决定 finally 是否需要关闭迭代器。
	let done = false;
	try {
		// 每次显式拉取，便于把等待包进 awaitWithContext。
		for (;;) {
			// 保存本次 next 的结果。
			let result: IteratorResult<unknown>;
			try {
				// Promise.resolve 统一同步/异步迭代器；中止时结束等待。
				result = await awaitWithContext(Promise.resolve(iterator.next()), context);
			} catch (error) {
				// 非中止错误原样传播。
				if (!context.abortSignal?.aborted) throw error;
				throw new ChordError(
					{ code: "aborted", message: "import: aborted" },
					{ cause: context.abortSignal.reason },
				);
			}
			// 输入结束：标记 done 并返回。
			if (result.done) {
				// 正常结束，finally 不再关闭。
				done = true;
				return;
			}
			// 校验/应用交给 ArchiveImport。
			await take(result.value);
		}
	} finally {
		// A stalled input is not awaited: the backend transaction ends now.
		// 出错/中止时异步关闭输入；不等待卡住的输入。
		if (!done) void Promise.resolve(iterator.return?.()).catch(() => {});
	}
}
