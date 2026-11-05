// One Durable commit as one commit of the store's series (slice 6b §2.3): staged before the queue (rows encoded,
// contents serialized, explicit ids raising the store's allocator), then inside the series' transaction what
// `SqliteStorage` does inside its own, with the step's reader: Durable's checks of ids and documents and the copies
// resolved from their sources (its messages, a refusal), then its one composite write: the table puts, and the
// documents in two passes, existing ones first (their content, then their retirement, which frees the addresses this
// commit's creations take), then the creations and copies.

// 文件导读

// 所属：packages/durable/src/storage/store 的提交实现，把一次 Durable commit 映射为 Chord store 的一个 series commit。

// 职责边界：在进入提交队列前暂存（编码行、序列化文档内容、登记显式 id）；在 series 事务内做 Durable 自己的

//   id/文档/复制检查；通过检查后写出表行与文档引擎写入。它不开启事务、不分配 seq、不做数据库回滚，

//   这些由 Chord 的 commitSeries 和 Step 完成。

// 上下游：StoreStorage.commit 为每个 batch 构造 DurableCommit，并把它交给 ChordStore.commitSeries；

//   下游是 Chord 的 OwnerTable/put、文档引擎 insertDocument/writeContent/retireRecord 与 documents.ts 的映射。

// 结果与错误：构造期或 check 期抛错表示 Durable 拒绝该提交（series 在它之前停止）；Step 内 SQL 失败则由

//   Chord 回滚整个 series 并作为数据库故障向上抛。

// 能力清单：

// - RecordType（类型）：record_ids 中登记的五种记录类型。

// - CommitTables（类型）：提交写入所需的六张已声明表句柄。

// - DurableCommit（类）：实现 SeriesCommit 与 StagedWrite；check 检查，apply 写入。

// 组合顺序：new DurableCommit(writes, ...) 暂存 -> commitSeries 调 check(step) -> 调 apply(step)。

// 示例：const commit = new DurableCommit(writes, owner, tables, (id) => store.ids.raise(id), context);

// 阅读顺序：类字段与构造函数 -> check/resolveCopies -> apply -> stage 的写类型分支 -> 辅助检查函数。

// Chord store 的适配器接口：EncodedRow 是编码后的行，OwnerTable 负责 put/encode，
// 文档引擎函数在 Step 内写文档记录与修订。
import {
	type EncodedRow,
	type DocumentContent as EngineContent,
	type DocumentRecord as EngineRecord,
	findDocument,
	insertDocument,
	type OwnerTable,
	readDocument,
	retireRecord,
	type SeriesCommit,
	type StagedWrite,
	type Step,
	type StoreWrite,
	writeContent,
} from "@earendil-works/chord";
// Context 用于行解码/迁移时可能需要的取消与追踪。
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
// StorageRequestError 表示请求级失败（如复制源不保留历史），与数据库故障区分。
import { StorageRequestError } from "../../errors.ts";
import type {
	DocumentContent,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	Id,
	JsonObject,
	StorageWrite,
} from "../../types.ts";
import { addressOf, durableRecord, engineRecord, readAt } from "./documents.ts";
import { conversationRow, entryRow, submissionRow, taskRow } from "./tables.ts";

// record_ids.record_type 列的取值集合；document 也算一类全局 id。
/** Durable's record types, as `record_ids` names them. */
export type RecordType = "conversation" | "entry" | "task" | "submission" | "document";

// 打开时声明好的表句柄；提交只通过它们写入，不直接拼接表名。
/** The storage's tables, as a commit writes them. */
export type CommitTables = {
	readonly recordIds: OwnerTable;
	readonly conversations: OwnerTable;
	readonly entries: OwnerTable;
	readonly entryHeads: OwnerTable;
	readonly tasks: OwnerTable;
	readonly submissions: OwnerTable;
};

// 一条表写：id 用于检查，row 已在暂存阶段编码成绑定参数。
/** A table write of the commit: its record's id and type, its table and its row encoded at staging. */
type RowWrite = {
	readonly id: number;
	readonly type: Exclude<RecordType, "document">;
	readonly table: OwnerTable;
	readonly row: EncodedRow;
};

// 创建文档时的 base：版本、值，以及进入队列前序列化好的 JSON 文本。
/** A base as the commit stores it: its version and value, and the value serialized. */
type StagedBase = { readonly version: number; readonly value: JsonObject; readonly text: string };

// 一次提交对同一个文档的全部动作；多个写入会合并到这里，重复的内容命令会被拒绝。
/** What one commit does with one document, as `SqliteStorage`'s action map has it. */
type DocumentAction = {
	create?: DocumentCreate;
	copy?: DocumentCopySource;
	/** A creation's base: the write's own, or a copy's once resolved. */
	base?: StagedBase;
	content?: { readonly content: DocumentContent; readonly text: string };
	retire: boolean;
};

// DurableCommit 同时是 SeriesCommit（check + writes）和 StagedWrite（apply）。
// writes 只含它自己：整个提交在 store 中按一个复合写入执行。
/** A Durable commit staged for the store's series: its checks, then itself as its one write. */
export class DurableCommit implements SeriesCommit, StagedWrite {
	readonly order = "write";
	readonly writes: readonly StagedWrite[];
	readonly #owner: string;
	readonly #tables: CommitTables;
	readonly #context: Context;
	// claims 按写入顺序记录所有被占用的 id（含创建/复制的文档），用于全局 id 检查。
	/** Every id a write claims, in write order (documents created or copied included), for the id checks. */
	readonly #claims: { readonly id: number; readonly type: RecordType }[] = [];
	// rows 是表写入；actions 按文档 id 合并创建/内容/退役命令。
	readonly #rows: RowWrite[] = [];
	readonly #actions = new Map<DocumentId, DocumentAction>();
	// check 的结果供同一步骤的 apply 使用：已登记的 id 类型和需要修改的现有文档记录。
	/** What `check` found for `apply`, in the same step: the stored types of the claimed ids, the changed documents. */
	#checked:
		| { readonly claimed: Map<number, RecordType>; readonly existing: Map<DocumentId, EngineRecord> }
		| undefined;

	// 暂存一次提交：逐条写入被编码/归并，显式 id 通过 raise 抬高 store 分配器。
	// 这里的错误是 Durable 的批内校验错误（例如同一文档两个内容命令），会在进入队列前抛出。
	// 例：new DurableCommit([{ type: "entry", value }], owner, tables, raise, context)。
	/**
	 * Stages `writes` (rule 8: rows and contents encoded here, before the queue); `raise` makes room above each explicit
	 * id. A malformed batch (two content commands for one document, a second retirement) throws Durable's message.
	 */
	constructor(
		writes: readonly StorageWrite[],
		owner: string,
		tables: CommitTables,
		raise: (id: number) => void,
		context: Context,
	) {
		this.#owner = owner;
		this.#tables = tables;
		this.#context = context;
		// 顺序暂存；任何一条不合法都会在此抛出，StoreStorage 会把它变成该 batch 的拒绝。
		for (const write of writes) this.#stage(write, raise);
		// 复合写入只包含自身，apply 返回的记录都是本次提交产生的。
		this.writes = [this];
	}

	// 检查阶段：只读 step（能看到 series 中更早提交的结果），不写任何行。
	// id、文档动作、copy 解析任一失败都抛出，series 在本提交前停止，之前批次保持已提交。
	/**
	 * Durable's checks against the state the series' earlier commits left, writing nothing: the ids, the documents and
	 * the copies; a throw refuses the commit.
	 */
	// 先查全局 id，再查文档动作（存在性、退役、delta 版本、地址唯一），最后解析 copy。
	async check(step: Step): Promise<void> {
		const claimed = await this.#checkIds(step);
		const existing = await this.#checkDocuments(step);
		await this.#resolveCopies(step);
		this.#checked = { claimed, existing };
	}

	// 解析文档复制：源必须在同一提交中被读取，且本提交不能同时修改源文档。
	// 源的当前值会成为新文档的 base；来源与目标在 scope/kind/key/history/fork 上必须一致。
	/**
	 * Resolves the copies (S11): each source read at its point and checked against the copy's record, entered as a
	 * creation carrying the source's value as its base.
	 */
	async #resolveCopies(step: Step): Promise<void> {
		// 逐个处理带 copy 的动作；没有 copy 的继续。
		for (const [id, action] of this.#actions) {
			const source = action.copy;
			if (source === undefined) continue;
			// 同一批里修改源文档会让“复制”语义不确定，直接拒绝。
			if (this.#actions.has(source.id)) throw new Error(`Document copy ${id} source is changed in the copy batch`);
			try {
				// readAt 在 step 的当前事务快照中读源文档；普通错误统一包成“copy 被拒绝”。
				const read = await readAt(step, source.id, source.at, this.#owner);
				if (read.kind === "current_only") {
					// latest 历史的源在历史点不可读，转成请求级错误再被外层包装。
					throw new StorageRequestError(`Document ${read.id} does not retain historical content`);
				}
				const stored = read.document;
				// 源不存在说明 copy 的 source 不可满足。
				if (stored === undefined) throw new Error(`Fork source document ${source.id} cannot be read`);
				const create = action.create!;
				// 目标与源的作用域、kind、key、history、fork 必须完全匹配；否则复制结果会改变语义。
				if (
					stored.record.scope.kind !== "conversation" ||
					create.scope.kind !== "conversation" ||
					stored.record.kind !== create.kind ||
					stored.record.key !== create.key ||
					stored.record.history !== create.history ||
					stored.record.fork !== create.fork
				) {
					throw new Error(`Fork source document ${source.id} does not match the copied record`);
				}
				// 源的值序列化一次后作为 base 暂存，避免进入队列后再做 JSON 序列化。
				action.base = { version: stored.version, value: stored.value, text: JSON.stringify(stored.value) };
			} catch (error) {
				// 保留 cause，便于诊断是源读取、不匹配还是请求错误。
				throw new Error(`Document copy ${id} was rejected`, { cause: error });
			}
		}
	}

	// 写入阶段：check 必须在同一 step 中先执行，因此这里直接使用 #checked。
	// 顺序是表行 -> 现有文档的内容/退役 -> 本提交的文档创建/复制。
	/** The commit's writes, after its `check` in the same step. */
	async apply(step: Step): Promise<readonly StoreWrite[]> {
		const recorded: StoreWrite[] = [];
		const { claimed, existing } = this.#checked!;
		for (const write of this.#rows) {
			// 每个表写只 claim 一次 id；claimed 里已有该 id 说明同一记录类型重复写入，不再写 record_ids。
			if (claimed.get(write.id) === undefined) recorded.push(await this.#claim(step, write.id, write.type));
			claimed.set(write.id, write.type);
			// entry 行的 commit_seq 由 put 的 stamp 参数写入 step.seq，而不是暂存时的占位 0。
			const stamp = write.table === this.#tables.entries ? "commit_seq" : undefined;
			recorded.push(await write.table.put(step, write.row, stamp));
		}
		// 先处理现有文档：退役会释放地址，随后本提交的创建才能占用同一地址。
		// Existing documents first: a retirement frees its address before a creation of this commit takes it.
		for (const [id, record] of existing) recorded.push(...(await this.#change(step, record, this.#actions.get(id)!)));
		// 再创建/复制文档：每个文档先登记 document 类型 id，再插入记录与 base。
		for (const [id, action] of this.#actions) {
			if (action.create === undefined) continue;
			recorded.push(await this.#claim(step, id, "document"));
			recorded.push(await this.#create(step, action.create, action.base!, action.retire));
		}
		return recorded;
	}

	// 暂存一条 StorageWrite：表类型投影为索引行，文档类型归并进 actions。
	/** Stages one write: a table row encoded, a document command into its action. */
	#stage(write: StorageWrite, raise: (id: number) => void): void {
		const tables = this.#tables;
		switch (write.type) {
			case "conversation":
				// 会话行由 conversationRow 投影：id、两个 owner 哨兵列、完整 record。
				this.#row(write.value.id, write.type, tables.conversations, conversationRow(write.value), raise);
				return;
			// entry 先写 entries 行；若带 head，再写一张 EntryHeads 行，模拟 SQLite 的部分索引。
			// 两行共用 entry 的 id，但 apply 只会为这个 id 写一次 record_ids。
			case "entry": {
				const { id, conversationId, head } = write.value;
				this.#row(id, write.type, tables.entries, entryRow(write.value), raise);
				// Its claim is the entry's: `apply` claims an id once.
				// head 标记的辅助表行也编码成绑定参数；id 与 conversation_id 都已由类型保证。
				if (head !== undefined) {
					const row = tables.entryHeads.encode({ id, conversation_id: conversationId });
					this.#rows.push({ id, type: write.type, table: tables.entryHeads, row });
				}
				return;
			}
			case "task":
				// 任务行包含 status/abort_requested/background 等索引列，kind 使用无损编码。
				this.#row(write.value.id, write.type, tables.tasks, taskRow(write.value), raise);
				return;
			case "submission":
				// submission 行同样投影索引列；requestId 缺失与空字符串在编码后不同。
				this.#row(write.value.id, write.type, tables.submissions, submissionRow(write.value), raise);
				return;
			// 文档创建/复制：先检查是否已有内容命令，再把记录和 base/source 存入 action。
			case "document.create":
			case "document.copy": {
				const { id } = write.record;
				const action = this.#action(id);
				// 一个文档在同一个 batch 中只能有一个内容来源（创建或复制）。
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${id} has more than one content command`);
				}
				// copy 与 create 共用 action.create（目标记录）；copy 再单独保存 source 供 check 解析。
				action.create = write.record;
				if (write.type === "document.copy") action.copy = write.source;
				// 普通创建直接暂存 base；content 来自 document.create 的 base 类型。
				else action.base = { ...write.content, text: JSON.stringify(write.content.value) };
				// 文档 id 也要参与全局 id 检查；raise 防止后续 mintId 复用。
				this.#claims.push({ id, type: "document" });
				raise(id);
				return;
			}
			// 文档变更：把内容命令合并到同一 action；base 的 value 或 delta 的 ops 都提前序列化。
			case "document.change": {
				const action = this.#action(write.id);
				// A creation's base is its content command (`SqliteStorage` counts it so too), in either order.
				// 创建/复制已占用内容槽时不能再接受 change。
				if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
					throw new Error(`Document ${write.id} has more than one content command`);
				}
				const { content } = write;
				// 内容文本在这里序列化；delta 存 ops 数组，base 存完整值。
				action.content = { content, text: JSON.stringify(content.kind === "base" ? content.value : content.ops) };
				return;
			}
			// 退役命令只标记 retire；同一文档重复退役是批内错误。
			case "document.retire": {
				const action = this.#action(write.id);
				// retire 是幂等布尔标记，第二次出现说明调用方生成了矛盾写入。
				if (action.retire) throw new Error(`Document ${write.id} is retired more than once`);
				action.retire = true;
				return;
			}
		}
	}

	// 记录表写：id/type 用于检查，table.encode 把外部行编码成绑定参数。
	// raise 在这里统一调用，保证任何显式 id 都不会被后续分配器再次发出。
	#row(id: Id<string>, type: RowWrite["type"], table: OwnerTable, row: object, raise: (id: number) => void): void {
		this.#claims.push({ id, type });
		this.#rows.push({ id, type, table, row: table.encode(row) });
		raise(id);
	}

	// 取得或创建某文档的动作条目；retire 默认为 false。
	#action(id: DocumentId): DocumentAction {
		let action = this.#actions.get(id);
		if (action === undefined) {
			action = { retire: false };
			this.#actions.set(id, action);
		}
		return action;
	}

	// 全局 id 检查：conversation/entry/document 必须全新且只写一次；
	// task/submission 的 id 可以复用，但不能与另一种记录类型冲突。返回已存储 id 的类型映射。
	/**
	 * Durable's global id checks (`SqliteStorage.checkGlobalIds`): a conversation, entry or document id claimed by
	 * anything, or written twice; a task or submission id claimed by another type. Returns the stored types.
	 */
	async #checkIds(step: Step): Promise<Map<number, RecordType>> {
		// stored 缓存 record_ids 查询结果（undefined 表示不存在），avoid 重复点查。
		const stored = new Map<number, RecordType | undefined>();
		const claimed = new Map<number, RecordType>();
		// claimed 记录本提交内已声明过的 id 与类型。
		for (const { id, type } of this.#claims) {
			let existing = stored.get(id);
			// 第一次见到该 id 时读取 record_ids；stored.has 区分“查过但不存在”和“尚未查”。
			if (!stored.has(id)) {
				const row = await this.#tables.recordIds.get(step, [id], this.#context);
				existing = row?.record_type as RecordType | undefined;
				stored.set(id, existing);
				// earlier 是同一提交中更早写入声明的类型；用于拒绝批内重复。
			}
			const earlier = claimed.get(id);
			// 三类不可复用 id：已存在或本批重复都拒绝。
			if (type === "conversation" || type === "entry" || type === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				// 任务/提交 id 可以更新同一记录，但不能跨类型复用。
				if (existing !== undefined && existing !== type) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== type) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, type);
		}
		// 只返回实际存在的 id 类型，供 apply 决定是否需要写 record_ids。
		const types = new Map<number, RecordType>();
		for (const [id, type] of stored) if (type !== undefined) types.set(id, type);
		return types;
	}

	// 文档动作检查：未知/已退役文档、delta 跨版本、同一地址提交后出现多个存活 incarnation 都被拒绝。
	// 返回需要修改或退役的现有文档记录，按 action 顺序保存。
	/**
	 * Durable's document checks (`SqliteStorage.checkDocumentActions`): a change or retirement of an unknown or retired
	 * document, a delta on another version, more than one live incarnation per address after the commit. Returns the
	 * existing records the commit changes or retires, in action order.
	 */
	async #checkDocuments(step: Step): Promise<Map<DocumentId, EngineRecord>> {
		const existing = new Map<DocumentId, EngineRecord>();
		// 创建不需要读现有记录；change/retire 必须能读到属于本 owner 的活文档。
		for (const [id, action] of this.#actions) {
			if (action.create !== undefined) continue;
			// durableRecord 只接受本 owner 的 Durable 命名空间，别人的 Chord 文档视为未知。
			const stored = await readDocument(step, id);
			const record = stored === undefined ? undefined : durableRecord(stored, this.#owner);
			// 不存在或已退役都不能再修改。
			if (record === undefined) throw new Error(`Unknown document: ${id}`);
			if (record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			// delta 只能应用在当前 base 的版本上；同一版本还可由引擎的修订计数再校验。
			const content = action.content?.content;
			if (content?.kind === "delta" && content.version !== stored!.version) {
				throw new Error(`Document ${id} version transition requires a base`);
			}
			existing.set(id, stored!);
		}
		/** Per address a live creation takes: its live incarnations after the commit so far. */
		// live 按“地址键”统计提交后仍存活的 incarnation 数。
		const live = new Map<string, number>();
		for (const action of this.#actions.values()) {
			// 只检查新创建且未立即退役的动作；每个地址最终最多一个 current。
			if (action.create === undefined || action.retire) continue;
			const address = addressOf(action.create, this.#owner);
			// 地址键由 namespace、kind、key 组成；owner 已在查询范围内固定。
			const key = JSON.stringify([address.namespace, address.kind, address.key]);
			let count = live.get(key);
			// 首次遇到该地址时查当前存活文档；若它恰好在本提交中退役，则计数从 0 开始。
			if (count === undefined) {
				// The incarnation live there now counts unless this commit retires it.
				const current = await findDocument(step, address);
				count = current === undefined || this.#actions.get(current.id as DocumentId)?.retire === true ? 0 : 1;
			}
			// 多于一个存活 incarnation 会让地址解析产生歧义。
			if (++count > 1) throw new Error("Document address already has a current incarnation");
			live.set(key, count);
		}
		return existing;
	}

	// 写 record_ids 行，声明该 id 属于给定记录类型。
	/** Puts `id`'s `record_ids` row: its record type. */
	#claim(step: Step, id: number, type: RecordType): Promise<StoreWrite> {
		const table = this.#tables.recordIds;
		return table.put(step, table.encode({ id, record_type: type }));
	}

	// 现有文档：先写内容（如有），再写退役（如有）；两者都使用记录当前 revision。
	/** An existing document's content, then its retirement, as their writes. */
	async #change(step: Step, record: EngineRecord, action: DocumentAction): Promise<StoreWrite[]> {
		const writes: StoreWrite[] = [];
		// revision 是引擎的乐观并发计数；写入成功后本地加一，供后续 retire 写使用。
		let { revision } = record;
		if (action.content !== undefined) {
			const { content, text } = action.content;
			const stored = engineContent(content);
			// writeContent 同时插入修订并条件更新记录，校验记录仍存活且 revision 未变。
			await writeContent(step, record.id, record.history, revision, stored, text);
			writes.push({ kind: "document.change", id: record.id, revision, content: stored });
			revision++;
		}
		// 退役按记录 history 处理：latest 保留行并清修订，rewindable 全保留。
		if (action.retire) {
			await retireRecord(step, record);
			writes.push({ kind: "document.retire", id: record.id, revision });
		}
		return writes;
	}

	// 创建（或解析后的复制）写入引擎：engineRecord 把 Durable 记录放进 meta。
	// retired 为 true 表示创建后立即退役，形成空生存期。
	/** A creation or a resolved copy (retired at once for a create-plus-retire, an empty lifetime), as its write. */
	async #create(step: Step, create: DocumentCreate, base: StagedBase, retired: boolean): Promise<StoreWrite> {
		// engineRecord 使用 step.seq 作为 createdAt；insertDocument 同时写 base 修订。
		const record = engineRecord(create, this.#owner, base.version, step.seq, retired);
		await insertDocument(step, record, base.text);
		const value = base.value as JsonValue;
		return { kind: "document.create", record, base: { version: base.version, fingerprint: "", value } };
	}
}

// 把 Durable 内容转成 Chord 引擎内容：Durable 文档没有 schema fingerprint，统一填空字符串。
/** A Durable content as the engine stores it: its documents have no schema fingerprint. */
function engineContent(content: DocumentContent): EngineContent {
	return content.kind === "base"
		? { kind: "base", version: content.version, fingerprint: "", value: content.value }
		: { kind: "delta", version: content.version, ops: content.ops };
}
