// 文件导读：Durable Session 的记录读取缓存
//
// 所属包与模块：packages/durable/src/session，Durable（pi-durable）包的 Session 内核层。
//
// 解决什么问题：Session 在一次运行中会反复按 ID 读取会话、任务和已写入的提交记录。每次都走后端 Storage
// 会把同一条记录重复读出来。本文件提供一个“写穿（write-through）”缓存包装器：写仍然先落到后端，等 Session
// 发布提交时再把同一批写入应用到内存；之后的按 ID 读取直接命中内存。
//
// 职责边界：
//   - 只缓存 conversation、task、submission 三张表的按 ID 读取。
//   - entry、scan*（分页扫描）和 document 相关方法原样转发：条目由上下文区间持有，文档由 Session 自己的
//     文档缓存持有，扫描结果没有单一缓存键，缓存它们既不划算也容易陈旧。
//   - 不负责持久化、不负责决定提交顺序；这些属于后端 Storage 和 Session 的 Writer。
//
// 上游入口：SessionImpl 构造时执行 new CachedStorage(storage)，再把它交给 GuardedStorage 包装；
// Writer 在每次提交发布时调用 published(writes)，这是缓存与持久化状态对齐的唯一入口。
// 下游依赖：构造参数 storage 是任意 Storage 实现（MemoryStorage、SQLite、JSONL、IndexedDB 等）。
// 错误流向：缓存命中不会调用后端，也不会产生错误；未命中时后端的拒绝原样返回给 Session 的失败保护层。
//
// 能力清单（按导出项）：
//   - CachedStorage：实现 Storage 接口的缓存包装类，构造参数为后端 Storage。
//   - CachedStorage.published(writes)：提交发布时把一批 StorageWrite 应用到缓存和任务等待关系。
//   - CachedStorage.sizes / readsInFlight：仅供测试观察缓存条目数与正在进行的读取数。
//   - scopeOf(storage)：取出后端可选的 Storage.publishing 作用域，供包装器原样暴露。
//   - Lru（文件内私有）：有界 Map，容量满时淘汰最久未使用项。
//   - freeze（文件内私有）：递归冻结缓存值，保证共享给调用方的记录不可变。
//
// 典型调用顺序：
//   1. Session 构造：new CachedStorage(backend) -> Session 的所有读写都经过它。
//   2. 提交：commit() 直接转发给后端；后端持久化成功后 Writer 调用 published(batch)。
//   3. 读取：conversation()/task()/submission() 先查内存，未命中才读后端，并且只有读期间没有并发发布
//      写同一记录时才把结果留在缓存里。
//
// 示例（ID 的构造细节省略，record/context 来自 Durable 的公共类型）：
//   const cached = new CachedStorage(backend);
//   cached.published([{ type: "conversation", value: { id: conversationId } }]);
//   const same = await cached.conversation(conversationId, context); // 命中内存，不再访问 backend
//
// 建议阅读顺序：先读类注释和 published() 的 switch，再看 task() 的三种查找位置与
// #keepTask/#followWait/#release 的等待关系，随后看 #keep() 的重叠读版本规则，最后看 Lru 与 freeze。
//
// Write-through cache of hot Storage record reads for the Session that owns the Storage.
// 以下 import 都是类型导入（`import type`）：只在编译期参与检查，编译成 JS 后整行被擦除，
// 因此运行时不加载 chord/json，也不产生模块依赖。
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	Page,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../types.ts";

// 任务记录的统一擦除类型：TaskRecord 有三个泛型参数（输入、检查点、结果），
// 这里只关心记录结构，不关心具体业务类型，所以三处都用 JsonValue。类型别名只在编译期存在。
type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
// 条目读取结果：条目本体加上它所在提交的序号 Seq；序号用于 as-of（历史时点）判断。
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };

// 中文导读：会话、任务、提交三类记录的写穿缓存。
// 只缓存按 ID 读取的热记录；容量有界（LRU），但活任务和“被等待的终态任务”单独保留。
// 提交只在发布（published）时进入缓存，而不是在后端持久化回执时，因此缓存内容与 Session 已发布的状态一致。
/**
 * Storage that serves hot record reads from memory: conversations, tasks, and written submissions, each table bounded
 * by a count, the least recently used record leaving first, except live tasks, which are kept until they end, and the
 * ended tasks a task waits on, kept until it moved on from its wait: a task's record is read again at each of its state
 * changes, a waiter reads the outcomes of what it waited on once it resumes (`runtime.outcomes()`), and both are
 * bounded by live work, which the scheduler keeps in memory too. Without that, a burst of more tasks than the count
 * would make each of those reads a Storage read on the line. Every commit goes through it, and one process owns a
 * Storage, so it applies each batch as it is published and never goes stale: `commit()`'s batches when the Session publishes
 * them (`published()`), not at their durability receipts. A read
 * result is kept only when no commit published since the read started wrote its record, as the read may not observe
 * that commit; versions are kept only for records with a read in flight. Cached values are frozen and shared. Entries,
 * scans, and documents pass through: the Session keeps documents and the newest entry per conversation itself, and
 * context ranges hold the entries a run reads.
 *
 * Not for a read-only Session: another process writes its Storage.
 */
// 实现 Storage 接口。`#` 前缀是 ECMAScript 私有字段：只在类内部可见，编译后仍是普通字段，但类型系统禁止外部访问。
export class CachedStorage implements Storage {
	// 真正的后端 Storage；所有未命中或未缓存的方法都直接转发给它。
	readonly #storage: Storage;
	// 会话记录 LRU，容量 4096。键类型是品牌化的 ConversationId，运行时只是数字；值类型由 Lru 的泛型保证。
	readonly #conversations = new Lru<ConversationId, ConversationRecord>(4096);
	// 活任务记录（state.status 不是 terminal）：任务结束前一直保留，不占 LRU 名额。
	/** Live (non-terminal) task records, until their task ends. */
	readonly #liveTasks = new Map<TaskId, AnyTaskRecord>();
	// 被等待任务表：count 是还有多少个等待方引用它；record 是它结束后的终态记录（未结束时没有）。
	// 等待方恢复后要读取被等待任务的 outcomes，所以要跨一次状态变化保留终态记录。
	/**
	 * Tasks some task waits on, or waited on until its wait ended and it has not moved on since: how many such waits name
	 * each, and its ended record once it ended.
	 */
	readonly #awaited = new Map<TaskId, { count: number; record?: AnyTaskRecord }>();
	// 每个等待方任务一条：on 是它等待的任务 ID 列表，left 表示它是否已经离开等待。
	// 离开等待后再发生一次状态变化（或结束）就释放目标记录，避免无限期保留。
	/** Per task that waits, or left its wait and has not changed since: what it waited on, and whether it left. */
	readonly #waits = new Map<TaskId, { readonly on: readonly TaskId[]; left: boolean }>();
	// 普通终态任务使用容量更小的 LRU（256）：终态记录里可能带工具调用参数和结果，占用较大。
	// Ended task records carry inputs and outcomes, such as a tool call's arguments, so fewer are kept.
	readonly #tasks = new Lru<TaskId, AnyTaskRecord>(256);
	// 已写入的提交记录 LRU，容量 256；只存放本进程写入过的提交，读到的历史提交不回填。
	readonly #submissions = new Lru<SubmissionId, SubmissionRecord>(256);
	// 只对“正在进行的读”记录版本：count 是并发读数量，version 在发布写入该记录时递增。
	// 读开始时记下版本，读完若版本未变才把结果放进缓存，避免把读到一半时已被新提交覆盖的旧值缓存下来。
	/** Per record with a read in flight: the reads, and how many published commits wrote it since the first began. */
	readonly #reads = new Map<Id<string>, { count: number; version: number }>();

	// 构造只保存后端引用；不读、不写、不启动定时器，因此不会抛错。
	constructor(storage: Storage) {
		this.#storage = storage;
	}

	// 把后端的 Storage.publishing 可选作用域暴露出去；没有作用域时返回 undefined。
	// 作用是让 Session 的发布动作仍能落在后端自己的宿主批次里，而不是被缓存层吞掉。
	/** The backend's own scope for a publication (`Storage.publishing`), when it has one. */
	get publishing(): Storage["publishing"] {
		return scopeOf(this.#storage);
	}

	// 提交直接转发给后端；这里不更新缓存，因为“后端已持久化”不等于“Session 已发布”。
	// 参数 batches 是多个逻辑批次，receive 是后端的持久化回执回调，context 提供取消/遥测上下文。
	// 例：await cached.commit([[write]], (index, seq) => {}, context)；缓存要等 published(write) 才更新。
	/** Pass the batches through; the Session applies each one with `published()` when it publishes it. */
	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult> {
		return this.#storage.commit(batches, receive, context);
	}

	// 在 Session 发布一批提交时调用：把这一批写入应用到缓存与等待关系。
	// 选择在发布时而不是持久化回执时更新，是为了和 Session 的“只有已发布状态可见”规则一致。
	// 输入是已存储的一批 StorageWrite；无返回值、无异步操作，出错只会来自 switch 内部的对象访问。
	// 例：cached.published([{ type: "task", value: record }]) 之后，task(record.id) 直接返回 record。
	/**
	 * Apply a batch `commit()` stored, when the Session publishes it. Its records are frozen in place and kept as
	 * they are, no copies: the Session's components that follow the publication, such as the scheduler's live tasks,
	 * hold the same objects, so a live task's record is in memory once.
	 */
	published(writes: readonly StorageWrite[]): void {
		for (const write of writes) {
			// StorageWrite 是由 type 字段区分的联合类型；进入分支后 TypeScript 把 write.value 收窄成对应记录类型。
			// 三种表记录都先调用 #wrote() 标记“这条记录刚被发布写过”，再更新对应缓存。
			switch (write.type) {
				case "conversation":
					// 如果有读正在读这条记录，递增版本号，让它读完时放弃缓存旧结果。
					this.#wrote(write.value.id);
					// freeze 递归冻结后放入 LRU；同一个对象也交给会话的其他组件共享，因此不能再被修改。
					this.#conversations.set(write.value.id, freeze(write.value));
					break;
				case "task":
					this.#wrote(write.value.id);
					// 任务记录还要维护“谁在等谁”：先处理等待关系，再按活/终态归档记录。
					this.#followWait(write.value);
					// 活任务进入 #liveTasks，终态任务进入 #tasks（或作为被等待记录留在 #awaited）。
					this.#keepTask(freeze(write.value));
					break;
				case "submission":
					this.#wrote(write.value.id);
					this.#submissions.set(write.value.id, freeze(write.value));
					break;
			}
		}
	}

	// ID 分配必须由后端统一保证单调，缓存不能自己生成 ID；直接转发。
	// 泛型 I 保留调用方期望的品牌类型，运行时没有额外检查（类型断言由后端负责）。
	mintId<I extends Id<string>>(): Promise<I> {
		return this.#storage.mintId<I>();
	}

	// 会话读取：命中 LRU 时同步返回 Promise.resolve(冻结记录)；未命中才异步读后端。
	// 参数 id 是品牌化数字，context 用于取消与遥测；返回记录或 undefined（不存在）。
	// 例：await cached.conversation(conversationId, context)。
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		const cached = this.#conversations.get(id);
		if (cached !== undefined) return Promise.resolve(cached);
		// #keep 负责重叠读规则：只有读期间没有发布写这条会话时才把读到的记录放进缓存。
		return this.#keep(
			id,
			() => this.#storage.conversation(id, context),
			(record) => this.#conversations.set(id, record),
		);
	}

	// 分页扫描不缓存：游标是不透明状态，结果随查询条件变化，缓存没有稳定的键；直接转发。
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.#storage.scanConversations(query, limit, cursor, context);
	}

	// entry 有两个重载：只按条目 ID 读，或按“会话 + 条目 ID”读并顺带检查祖先可见性。
	// 实现签名合并两个重载，用第三个参数是否存在来区分；as 断言是编译期消除重载联合，不做运行时校验。
	// 条目由上下文区间和 Session 持有，这里不缓存，避免与它们的生命周期冲突。
	entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(
		first: EntryId | ConversationId,
		second: EntryId | Context,
		third?: Context,
	): Promise<StoredEntry | undefined> {
		if (third === undefined) return this.#storage.entry(first as EntryId, second as Context);
		return this.#storage.entry(first as ConversationId, second as EntryId, third);
	}

	// 查找截止点之前最新的 head 标记；结果依赖 atOrBeforeEntryId，缓存键不能只是会话 ID，因此直接转发。
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.#storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
	}

	// 条目区间扫描不缓存，直接转发给后端。
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.#storage.scanEntries(query, limit, cursor, context);
	}

	// 任务读取的三级查找顺序：活任务表 -> 被等待任务的终态记录 -> 普通终态 LRU。
	// 命中任意一级都直接返回缓存；都未命中才调用 #keep 读后端，读回后由 #keepTask 按状态归档。
	// 这个顺序保证活任务不受容量限制，等待方恢复后的第一次读取也不需要回后端。
	// 例：await cached.task(taskId, context)；任务仍在运行时应返回最新 running 记录。
	task(id: TaskId, context: Context): Promise<AnyTaskRecord | undefined> {
		// `??` 是空值合并：只有左侧为 null/undefined 才继续取右侧；空 Id 为 undefined 表示该表没有。
		const cached = this.#liveTasks.get(id) ?? this.#awaited.get(id)?.record ?? this.#tasks.get(id);
		if (cached !== undefined) return Promise.resolve(cached);
		return this.#keep(
			id,
			() => this.#storage.task(id, context),
			(record) => this.#keepTask(record),
		);
	}

	// 任务分页扫描不缓存：查询条件组合多，且扫描本身不是热路径；直接转发。
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<AnyTaskRecord, Cursor>> {
		return this.#storage.scanTasks(query, limit, cursor, context);
	}

	// 提交记录只在“本进程写入时”缓存：本进程会写入它结算的每个提交，而读到的提交通常已结算，
	// 因此未命中时直接读后端、不回填，避免缓存大量只读一次的记录。
	// 例：await cached.submission(id, context) 命中时返回冻结记录，否则转发。
	/** Cached as written only: this process writes every submission it settles, and a read one is usually settled. */
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		const cached = this.#submissions.get(id);
		return cached === undefined ? this.#storage.submission(id, context) : Promise.resolve(cached);
	}

	// 提交分页扫描直接转发。
	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.#storage.scanSubmissions(query, limit, cursor, context);
	}

	// 按会话 + 请求 ID 查找提交；键不是单个 ID，直接转发。
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.#storage.submissionByRequest(conversationId, requestId, context);
	}

	// 以下三个文档方法都直接转发：文档的当前值、版本和撤销由 Session 自己的文档缓存与 Storage 管理。
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		return this.#storage.findDocument(address, at, context);
	}

	// 按 incarnation（文档某一代）ID 读取具体版本，不跟随地址替换；直接转发。
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		return this.#storage.document(id, at, context);
	}

	// 文档范围扫描直接转发。
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.#storage.scanDocuments(query, limit, cursor, context);
	}

	// 关闭后端；缓存没有需要清理的异步资源（只是内存 Map），因此直接转发。
	close(context: Context): Promise<void> {
		return this.#storage.close(context);
	}

	// 仅测试使用的只读快照：观察各表当前保留多少条记录，用于验证容量上限和释放逻辑。
	// 它不触发任何读或淘汰，也不会改变缓存状态。
	/** Records kept per table, for tests that bound memory. */
	get sizes(): {
		readonly conversations: number;
		readonly tasks: number;
		readonly liveTasks: number;
		readonly awaited: number;
		readonly waits: number;
		readonly submissions: number;
	} {
		return {
			conversations: this.#conversations.size,
			tasks: this.#tasks.size,
			liveTasks: this.#liveTasks.size,
			awaited: this.#awaited.size,
			waits: this.#waits.size,
			submissions: this.#submissions.size,
		};
	}

	// 把一条已冻结的任务记录放到正确的位置。
	// 终态：从活任务表移除；若它正被某个等待方引用，更新 #awaited 里的终态记录；否则放入有界 LRU。
	// 非终态：从 LRU 移除，放入活任务表，任务结束前一直保留。
	/** Keep a frozen task record: a live one until its task ends, an ended one in the bounded table. */
	#keepTask(record: AnyTaskRecord): void {
		// 判别联合收窄：status 为 "terminal" 后，record.state 具有 outcome 字段，不再有 checkpoint。
		if (record.state.status === "terminal") {
			this.#liveTasks.delete(record.id);
			const awaited = this.#awaited.get(record.id);
			if (awaited !== undefined) awaited.record = record;
			else this.#tasks.set(record.id, record);
			return;
		}
		this.#tasks.delete(record.id);
		this.#liveTasks.set(record.id, record);
	}

	// 跟随一个任务写入的等待关系，更新 #waits 与 #awaited。
	// 等待中（waiting）：释放它上一次等待的目标计数，登记新的 on 列表，并为每个目标增加引用计数。
	// 非等待中：如果之前没离开等待且任务还没结束，只标记 left；否则删除等待条目并释放目标。
	// 例：任务 2 先等待 [3,4]，之后变成 running；下一次再变化时 3/4 的保留计数才归零。
	/**
	 * Follow a task's waits from its written record: a wait holds the ended records of its `on` until the task, after
	 * leaving the wait, changes again (or ends), as the phase that resumes reads their outcomes before its next commit.
	 */
	#followWait(record: AnyTaskRecord): void {
		const wait = this.#waits.get(record.id);
		// 等待状态在类型上一定带 on 和 policy；这里只使用 on。
		if (record.state.status === "waiting") {
			if (wait !== undefined) this.#release(wait.on);
			const on = record.state.on;
			this.#waits.set(record.id, { on, left: false });
			for (const id of on) {
				let awaited = this.#awaited.get(id);
				// 第一次有人等待这个目标：若它已结束并躺在有界 LRU 里，就把它移到 #awaited 专属保留区。
				if (awaited === undefined) {
					// One that ended already moves over from the bounded table.
					const ended = this.#tasks.get(id);
					this.#tasks.delete(id);
					awaited = ended === undefined ? { count: 0 } : { count: 0, record: ended };
					this.#awaited.set(id, awaited);
				}
				awaited.count++;
			}
			return;
		}
		if (wait === undefined) return;
		// 离开等待后的第一次变化只标记 left，不立即释放：恢复后的阶段还要读取被等待任务的 outcomes。
		// 再下一次变化（或任务结束）才真正释放，保证读取发生在记录仍被保留时。
		if (!wait.left && record.state.status !== "terminal") {
			wait.left = true;
			return;
		}
		this.#waits.delete(record.id);
		this.#release(wait.on);
	}

	// 一个等待关系结束：每个目标引用计数减一；归零时删除 #awaited，并把终态记录放回有界 LRU。
	// `!` 非空断言只告诉 TypeScript 这里一定存在，运行时不检查；#followWait 已为每个目标建过条目。
	/** A wait on `on` is over: what no other wait names goes back to the bounded table. */
	#release(on: readonly TaskId[]): void {
		for (const id of on) {
			const awaited = this.#awaited.get(id)!;
			if (--awaited.count > 0) continue;
			this.#awaited.delete(id);
			if (awaited.record !== undefined) this.#tasks.set(id, awaited.record);
		}
	}

	// 发布写入记录 id 时调用：只对“有读正在读这条记录”的条目递增版本号。
	// 没有读在飞时什么也不做，版本表因此只随并发读增长，不随历史记录增长。
	/** A published commit wrote record `id`: a read of it in flight may have missed that. */
	#wrote(id: Id<string>): void {
		const reads = this.#reads.get(id);
		if (reads !== undefined) reads.version++;
	}

	// 执行一次后端读，并在安全时把结果冻结后放入缓存。
	// 步骤：登记读计数 -> 记下版本 -> await 后端 -> finally 减计数 -> 冻结 -> 版本未变才 keep。
	// 错误路径：read() 拒绝时 finally 仍会清理计数，错误原样抛给调用方，且不会缓存任何值。
	// 泛型 T extends object：只有记录对象才值得冻结和缓存；undefined 表示记录不存在。
	// 例：task() 未命中时调用 #keep(id, () => backend.task(id, ctx), record => this.#keepTask(record))。
	/** Resolve with a read's result, frozen; keep a found record unless a commit published since wrote it. */
	async #keep<T extends object>(
		id: Id<string>,
		read: () => Promise<T | undefined>,
		keep: (value: T) => void,
	): Promise<T | undefined> {
		// 首次读这条记录时创建版本条目；后续并发读共享同一个 version。
		let reads = this.#reads.get(id);
		if (reads === undefined) {
			reads = { count: 0, version: 0 };
			this.#reads.set(id, reads);
		}
		reads.count++;
		// 快照当前版本；如果读期间有发布写了这条记录，version 会变大，读完就不缓存旧结果。
		const version = reads.version;
		let value: T | undefined;
		// try/finally 保证无论读成功还是失败，读计数都会归零；归零时删除版本条目。
		try {
			value = await read();
		} finally {
			if (--reads.count === 0) this.#reads.delete(id);
		}
		if (value === undefined) return undefined;
		// 后端返回的是“可变的普通对象”；冻结后可以安全地共享给 Session 的多个组件与观察者。
		freeze(value);
		// 只有没有并发发布覆盖时才写入缓存；调用方仍然拿到本次读到的值。
		if (reads.version === version) keep(value);
		return value;
	}

	// 仅测试接口：正在读的版本条目数；空闲时应为 0。
	/** Records with a read in flight, for tests that bound memory. */
	get readsInFlight(): number {
		return this.#reads.size;
	}
}

// 把后端可选的 publishing 方法包装成同签名函数，供外层包装器（GuardSession 的 GuardedStorage 等）暴露。
// 为什么先判断 undefined：publishing 是可选方法；直接调用 this.#storage.publishing! 会丢失空值检查。
// 返回 undefined 表示后端没有自定义发布作用域，Session 会直接执行发布。
/** `storage`'s publication scope (`Storage.publishing`), for a wrapper to expose as its own; none when it has none. */
export function scopeOf(storage: Storage): Storage["publishing"] {
	if (storage.publishing === undefined) return undefined;
	return (publish, context) => storage.publishing!(publish, context);
}

// 极简 LRU：Map 的迭代顺序就是插入顺序，get/set 时删除再插入即可把键移到“最近使用”的末尾。
// 容量满时删除 keys() 的第一个键，也就是最久未使用的键。
// K/V 是泛型参数：K 是键类型，V 是值类型；它们只在编译期约束调用方。
/** A Map bounded to `capacity` entries that drops the least recently used one. */
class Lru<K, V> {
	readonly #map = new Map<K, V>();
	readonly #capacity: number;

	constructor(capacity: number) {
		this.#capacity = capacity;
	}

	// 命中后删除再插入，刷新“最近使用”顺序；未命中返回 undefined，不抛错。
	get(key: K): V | undefined {
		const value = this.#map.get(key);
		if (value === undefined) return undefined;
		this.#map.delete(key);
		this.#map.set(key, value);
		return value;
	}

	get size(): number {
		return this.#map.size;
	}

	delete(key: K): void {
		this.#map.delete(key);
	}

	// 覆盖写入也要先删除旧位置；超过容量时删除最久未使用的键。
	// `this.#map.keys().next().value!` 的 value 在 Map 非空时一定存在，`!` 只消除 TypeScript 的 undefined 推断。
	set(key: K, value: V): void {
		this.#map.delete(key);
		this.#map.set(key, value);
		if (this.#map.size > this.#capacity) this.#map.delete(this.#map.keys().next().value!);
	}
}

// 递归冻结一个 JSON 值：先冻结所有子值，再冻结自身，返回原引用（不做深拷贝）。
// null 需要单独排除，因为 typeof null === "object"；已冻结对象直接跳过，避免重复遍历。
// 这些记录按约定是无环 JSON，因此不做循环检测；函数等非对象值不会被冻结。
// 例：freeze({ id: 1, state: { status: "running" } }) 会同时冻结 state 和根对象。
function freeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze(child);
	return Object.freeze(value);
}
