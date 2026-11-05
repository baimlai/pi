// 文件导读
// ========
// 所属：packages/durable 的 Session 层（src/session）。本文件实现一次 Session.commit() 回调里使用的事务对象
// Transaction，以及事务与 Session 缓存/存储之间的契约 TransactionHost。
//
// 解决什么问题：Session 的每次提交必须把若干表记录（conversation/entry/task/submission）与若干文档改动
// （create/copy/change/retire）组装成一个原子批次：回调期间只暂存，回调成功后统一校验、生成一份
// StorageWrite[]，再交给 writer.ts 批量写入；任何一步失败都丢弃草稿，不产生半成品。
// 职责边界：
// - 本文件不做实际持久化，也不发布提交；Storage.commit() 由 session.ts 的 Writer 调用，adopt() 由 Session
//   在写入成功后调用。
// - 本文件不实现文档的值语义（合并、op、校验）；这些在 @earendil-works/chord/delta 的 Tracker/Prepared 中。
// - 本文件不决定行锁；它通过 TransactionHost.storage（实际是 GatedStorage）读，由 Session 的 touch() 等待
//   未发布写入。
// 上游入口：SessionImpl.#runCommit() 构造 new Transaction(host, context, scope)，把 tx 交给用户回调；
// 随后调用 settleFailure() 或 settleSuccess()；成功后 Session 用 holdable() 判断延迟提交，用 adopt() 发布，
// 用 writeKeys() 登记未发布的写键，用 takeHeld() 吸收已持有的文档改动。
// 下游依赖：documents.ts 的地址解析/记录校验/物化；forks.ts 的分叉文档复制计划；keys.ts 的键函数；
// types.ts 的 StorageWrite/DocumentRecord 等领域类型；errors.ts 的 ReadAfterWrite；Chord 的 track()/Draft/Op/
// PendingOps；pi-telemetry 的 TelemetryCarrier。
// 错误流向：回调内的错误由 Session 捕获并调用 settleFailure()；结算错误（未完成的异步操作、校验失败、
// 存储拒绝）在 settleSuccess() 内 abort 全部草稿后抛回 Session，不会写入 Storage。adopt() 抛错则说明内存
// 无法采纳已存储的批次，Writer 会把 Session 标记为失败。
//
// 能力清单（导出项）：
// - LoadedDocument：Session 文档缓存中的一条记录/追踪器/版本信息。
// - HeldDocument：延迟提交暂存在内存中的文档改动（PendingOps）与是否选了 base。
// - AdoptedDocuments：adopt() 的发布结果，区分“展示给 Session 自己观察者”与“Storage 实际收到的”。
// - TransactionHost：事务在持行期间需要的 Session 服务（存储、touch、时钟、缓存装载/安装/驱逐、新建会话钩子、
//   最新条目、任务文档索引、最新 head）。
// - TaskCreationOptions：TaskOptions 加上内部运行创建时用于解析 submission 追踪的 submissionIds。
// - TransactionScope：一次提交的默认会话与归属任务。
// - Transaction：实现 types.ts 的 Tx，另含 settleFailure/settleSuccess/discard/holdable/adoptHeld/takeHeld/
//   writeKeys/adopt 以及内部建表方法。
// - storeHeld：把一个 hold 的待发 op 与本次提交的 op 折叠成一条可存储的 DocumentContent，并返回读者需要重放的 op。
//
// 组合与典型顺序（一次成功提交）：
//   new Transaction -> 回调里读/写 -> settleSuccess() -> prepare() 所有草稿 -> #assemble() 校验并生成
//   StorageWrite[] -> Storage.commit()（Writer 完成）-> adopt(seq) 更新缓存并生成发布 -> 观察者收到变化。
// 失败路径：回调抛错或结算抛错 -> settleFailure()/内部 catch -> 每个 Change.abort() -> 草稿失效。
//
// 示例（真实签名，Session.commit 回调里的 tx）：
//   await session.commit(async (tx) => {
//     const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
//     await tx.appendEntry(conversation.id, { kind: "note", data: { text: "hello" } });
//     const draft = await tx.doc(NoteDoc, conversation.id); // NoteDoc 由 defineDoc() 创建
//     draft.count += 1; // 修改草稿，settleSuccess() 时 prepare()
//   }, context);
// 说明：示例展示调用顺序；真实运行时还要满足会话/任务存在、先读表后写表、文档定义与地址匹配等运行时校验。
// 延迟提交示例：Session 传入 persistence: { kind: "deferred" } 时，settleSuccess() 后 holdable() 可能返回
// { loaded, ops, base } 列表；Session 不存它，而是在内存中 adoptHeld()，之后由 takeHeld()+storeHeld() 落盘。
//
// 建议阅读顺序：先读 TransactionHost、LoadedDocument、HeldDocument、AdoptedDocuments 四个契约，
// 再读 Transaction 的构造与表读/表写（#read/#write），然后读文档获取 doc()/retireDoc() 与 #acquire 系列，
// 接着读结算 settleSuccess() 与 #assemble()，最后读 holdable()/adoptHeld()/takeHeld()/adopt() 和文件末尾的
// planDocument()/describe()/storeHeld()。相关测试：test/session-group-commit.test.ts（批量、失败边界）、
// test/session-deferred-commits.test.ts（延迟提交与 hold）、test/session-tables.test.ts、
// test/session-documents.test.ts、test/session-forks.test.ts。
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	type Change,
	type Draft,
	type Op,
	type PendingOps,
	type Prepared,
	type Tracker,
	track,
} from "@earendil-works/chord/delta";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import {
	type AnyDocDefinition,
	type AnyDocToken,
	addressId,
	checkRecordScope,
	checkRecordVersion,
	documentCreate,
	materializeDocumentValue,
	type ResolvedAddress,
	resolveAddress,
} from "../documents.ts";
import { ReadAfterWrite } from "../errors.ts";
import type {
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationOwnership,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentCommitChange,
	DocumentContent,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	Entry,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Seq,
	SessionDocFamilyToken,
	SessionDocToken,
	Storage,
	StorageWrite,
	SubmissionCreate,
	SubmissionId,
	SubmissionRecord,
	SubmissionSettlement,
	Task,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskOptions,
	TaskQuery,
	TaskRecord,
	Tx,
	TypedEntry,
	TypedEntryDraft,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { prepareForkDocumentCopies } from "./forks.ts";
import { documentKey, incarnationKey, scopeKey, tableKeys } from "./keys.ts";

// 事务内部把任务记录擦除到通用 JSON 类型：提交层不关心具体输入/状态/结果类型，
// 只做整体替换与合法性校验。
type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** A staged submission change: a settlement, or the placement of a queued submission at its entry. */
// 提交状态的两类暂存变更：结算（done/unanswered）或把排队项放置到某条目（placed）。
// placed 是内部合成状态，公开的 SubmissionSettlement 里没有它。
type SubmissionChange = SubmissionSettlement | { readonly status: "placed"; readonly entry: EntryId };

/**
 * Complete record after applying one change. Placement turns a queued input `placed` and a queued write `done`; a
 * continue is never queued, so never placed. Only a placed input or continue can be answered. A settled record stays.
 */
// 把一条暂存变更应用到当前 submission 记录，返回完整的新记录；不修改入参。
// 规则（编译期联合类型 + 运行时状态检查共同约束）：
// - 已 done/unanswered 的记录保持不变（结算幂等）。
// - placed：只允许 queued；input 变 placed，write 直接 done；continue 从不出现在 queued，故不会被 placed。
// - done（结算）：只允许 placed；queued 或已终态由前面的分支/抛错处理。
// 错误路径：违反状态机时抛普通 Error，说明调用方的 staging 逻辑有 bug。
// 例：applySubmissionChange(queuedRecord, { status: "done", answer: entryId }) 返回 answered 记录。
function applySubmissionChange(current: SubmissionRecord, change: SubmissionChange): SubmissionRecord {
	// 终态结算不会被后续变更覆盖：重复 settle/place 不改变结果。
	if (current.status === "done" || current.status === "unanswered") return current;
	// placed 分支：把排队输入放进 transcript。
	if (change.status === "placed") {
		// 只有 queued 可被放置；write 也可从 queued 直接变 done。
		if (current.status !== "queued") throw new Error(`Submission ${current.id} is not queued`);
		// 用户输入进入 placed，等待回答；被动写入已进入 transcript，直接 done。
		const status = current.type === "input" ? "placed" : "done";
		// 展开运算符保留 id/type/conversationId/trace 等身份字段，只覆盖状态和 entry；联合类型收窄需 as 断言。
		return { ...current, status, entry: change.entry } as SubmissionRecord;
	}
	// continue 没有 queued，只能结算 placed；input 的 done 也只从 placed 结算。
	if (change.status === "done" && current.status !== "placed") {
		// 违反状态机：例如对 queued input 直接 settle done。
		throw new Error(`Submission ${current.id} is not a placed input or continue`);
	}
	// 结算字段由 change 覆盖；queued/placed 记录本来就没有 answer/reason/detail，unanswered 的 entry 视情况保留。
	// Queued and placed records carry no answer, reason, or detail; an unanswered input keeps its entry.
	// 合并后仍是合法 SubmissionRecord；这里用 as 断言，因为 TS 无法从展开结果推断联合成员。
	return { ...current, ...change } as SubmissionRecord;
}

// 终止任务时扫描其文档的分页大小；只是内部性能常量，不是对外语义。
const INTERNAL_SCAN_PAGE_SIZE = 256;
// 空 op 数组共享常量：创建/复制文档没有被追踪的变更 op。
const EMPTY_OPERATIONS: readonly Op[] = [];
// 表记录复制选项：显式 undefined 的属性省略，避免把可选字段写成 undefined 存入 JSON。
// as const 让对象字面量保持只读字面量类型，可赋给 copyJson 的选项参数。
const TABLE_JSON_COPY_OPTIONS = { omitUndefinedProperties: true } as const;

/** One committed document incarnation owned by the Session tracker cache. */
// Session 缓存中的“当前 incarnation”：一个逻辑地址此刻对应的 DocumentRecord、它的追踪器和版本状态。
// storedVersion：Storage 里持久化的定义版本；valueVersion：内存 tracker 当前值的定义版本；
// deltasSinceBase：最新 base 之后已存储的 delta 数，adoption 时维护，供 checkpointWhen 判断。
// tracker：Chord 的不可变值追踪器；缓存与提交共享它，adopt() 只做指针交换。
// 编译期字段只读；运行时没有额外校验（Session 内部信任构造者）。
export type LoadedDocument = {
	// 逻辑地址的字符串身份，见 documents.ts 的 addressId()。
	readonly addressId: string;
	// 当前 incarnation 的持久化身份与 scope/history/fork 语义。
	readonly record: DocumentRecord;
	/** Persisted definition version; older while the tracked value is migrated only in memory. */
	// 已落盘的版本；内存值可能已迁移到更新版本，直到下次提交才写回。
	storedVersion: number;
	/** Definition version whose shape the tracked value has; access with another version reloads from Storage. */
	// 内存 tracker.value 的形状版本；与请求的定义版本不同就要重新 load/migrate。
	readonly valueVersion: number;
	/** Stored deltas after the newest base; advanced by adoption so the next predicate call needs no read. */
	// 最新 base 之后已存储的 delta 数；adoption 时递增，写 base 时清零。
	// 它不是 readonly：adopt() 会就地推进缓存计数。
	deltasSinceBase: number;
	// 值所有权；adopt(prepared) 是 O(1) 指针交换，旧草稿随后失效。
	readonly tracker: Tracker<JsonObject>;
};

/**
 * The changes of a cached incarnation that deferred commits adopted in memory and the Session has not stored yet
 * (`CommitPersistence`), folded. The Session owns it; a commit that stores them takes them.
 */
// 延迟提交（deferred）暂存在内存中的文档改动。Session 持有它而不是立即存储；
// 下一个读/写该文档的提交、截止时间或 close 会用 storeHeld() 把它折叠进存储内容。
// pending：PendingOps 队列，按文档累积并折叠 op；base：本次 held 提交是否选了 base（需要写完整值）。
export type HeldDocument = {
	// 该 incarnation 的缓存条目；hold 由 Session 按 record.id 管理。
	readonly loaded: LoadedDocument;
	// 尚未存储的 op，可能来自多个延迟提交；PendingOps 会在队列过长时退化为 replace。
	readonly pending: PendingOps;
	/** Set when a held commit selected a base (`checkpointWhen`): their store writes the whole value. */
	// 置位后，下次落盘必须写 base 而不是 delta（例如 checkpointWhen 选中）。
	// 不是 readonly：后续 held 提交可以把 false 提升为 true。
	base: boolean;
};

/** What adoption publishes: to the Session's own observers, and the stored changes to `observeCommits()`. */
// adopt() 的发布结果。观察者看到“内存采纳了什么”，observeCommits() 看到“Storage 实际收到什么”；
// 若本次提交顺带存储了之前的 held 改动，两者内容不同：stored 中对应文档的 ops 还包含更早的 held op。
export type AdoptedDocuments = {
	/** This commit's own changes, as memory adopted them. */
	// 仅本次提交自己的改动（内存视角），用于 Session 内部观察者。
	readonly observed: readonly DocumentCommitChange[];
	/** What Storage got: `observed`, unless the commit also stored held changes, which precede its own. */
	// Storage 实际收到的改动；没有 held 时与 observed 是同一数组引用。
	readonly stored: readonly DocumentCommitChange[];
};

/** Session services used by a transaction while it holds the mutation line. */
// 事务在持有 Session 变更行期间可用的 Session 服务。事务自身不直接接触 SessionImpl，
// 这样提交逻辑可以独立测试，也让“行内读取必须经 GatedStorage 等待未发布写”这条规则集中在一处。
export interface TransactionHost {
	/** Reads wait while their key has an unpublished writer (`GatedStorage`). */
	// 行内读取用的 Storage（实际是 GatedStorage）：读某个键前先等待它的未发布写。
	readonly storage: Storage;
	/** Wait while `key` has an unpublished writer; `undefined` when it has none. */
	// 等待 key 的未发布写；没有时返回 undefined，否则返回等待 Promise。
	// undefined 与 Promise 的联合让调用方可以用一次判断决定是否 await。
	touch(key: string): Promise<void> | undefined;
	/** Wall clock for task lifecycle times. */
	// 任务生命周期时间戳（startedAt/endedAt）使用的主机时钟。
	now(): number;
	/** Return the cached current incarnation without loading. */
	// 同步查看缓存中的当前 incarnation，不触发装载；缓存未命中时由调用方决定是否 load()。
	cached(addressId: string): LoadedDocument | undefined;
	/** Return the cached current incarnation, cold-loading and migrating it when necessary. */
	// 冷装载并按需迁移；没有当前 incarnation 时返回 undefined。
	// definition 提供 scope/version/migrate，address 用于 Storage.findDocument()，context 控制取消与 telemetry。
	load(
		definition: AnyDocDefinition,
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined>;
	/** Install a newly committed incarnation. */
	// 采纳新创建的 incarnation 到缓存；adopt() 在新建且未退休时调用。
	install(document: LoadedDocument): void;
	/** Remove a retired incarnation if it is still the cached occupant of its address. */
	// 仅在缓存仍指向该 recordId 时移除，避免误删同地址的新 incarnation。
	evict(addressId: string, recordId: DocumentId): void;
	/** Stage writes that belong to every newly created or forked conversation, in its creating transaction. */
	// 新会话/分叉的固定文档初始化钩子；在创建事务里执行，保证这些文档随会话原子提交。
	// 钩子拿到同一个 tx，可以继续 stage 文档写。
	conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void>;
	/** The newest entry ID visible from a conversation, known from the Session's commits. */
	// 会话最新可见条目 ID；Session 可从自己的提交得知，避免额外扫描。
	latestEntryId(conversationId: ConversationId, context: Context): Promise<EntryId | undefined>;
	/**
	 * The current documents of a live task when the Session knows all of them (it created the task), else `undefined`.
	 */
	// 本 Session 创建且仍存活的任务的文档索引；undefined 表示不认识该任务，调用方需要扫描 Storage。
	taskDocuments(taskId: TaskId): Iterable<DocumentRecord> | undefined;
	/** The newest visible head marker of a conversation, known from the Session's commits. */
	// 会话最新 head 标记条目；atOrBefore 由 Session 内部固定为 undefined（取最新）。
	// 返回的条目本身带 head: EntryId，作为上下文的起点。
	latestHeadMarker(
		conversationId: ConversationId,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
}

/** Committed and candidate state for one task touched by this transaction. */
// 本事务触碰过的任务暂存状态：committedRead 记忆化已提交读取；write 是候选记录；
// publicationConversationId 在 assemble 时提前解析，避免 adopt() 再读 Storage。
type TransactionTask = {
	// 已提交记录的读取 Promise；同一事务只读一次 Storage，失败结果也会被记忆。
	committedRead?: Promise<AnyTaskRecord | undefined>;
	// 候选写入：create 来自 createTask，replace 来自 setTask；记录是完整替换，不是补丁。
	write?: { readonly kind: "create" | "replace"; readonly record: AnyTaskRecord };
	// 任务文档发布时归属的会话 ID；assemble 提前解析，adopt 只读这个字段。
	publicationConversationId?: ConversationId;
};

/** Internal run creation resolves submission carriers against staged records before reading storage. */
// 内部扩展：批量创建 run 时，用 submissionIds 解析 telemetry trace/links。
// 公开的 TaskOptions 没有这个字段；它只由 Harness 的内部提交传入。
export type TaskCreationOptions = TaskOptions & { readonly submissionIds?: readonly SubmissionId[] };

/** Defaults a commit binds to: `tx.createTask()` conversation and the task attributed to appended entries. */
// 一次提交的默认绑定：createTask 省略 conversationId 时用它；appendEntry 用它作为 byTaskId。
// 两个字段都可选，因为调用方可以通过参数显式指定。
export type TransactionScope = {
	// 默认会话：tx.createTask() 未指定 conversationId 且没有 owner 时使用。
	readonly conversationId?: ConversationId;
	/** Task whose runtime commit this is; stamped as `byTaskId` on appended entries. */
	// 本次提交归属的任务；appendEntry 会把它写成条目的 byTaskId。
	readonly taskId?: TaskId;
};

/** Storage/cache provenance of one staged document incarnation. */
// 一个被暂存的文档 incarnation 的来源，决定 assemble 时生成哪种 StorageWrite：
// - loaded：缓存中已有当前 incarnation，草稿基于它修改；
// - created：本事务新建，尚未有 createdAt，Storage 提交时分配 seq；
// - fork-copy：分叉时按源地址复制，不需要定义，内容由 Storage 物化；
// - retire-only：本事务只退休它，不修改内容（可能来自扫描）。
type DocumentTarget =
	| { readonly kind: "loaded"; readonly document: LoadedDocument }
	| {
			// 新建 incarnation：记录（无 createdAt）、定义版本和初始 tracker。
			readonly kind: "created";
			// documentCreate() 生成的身份记录；createdAt 由 Storage 在提交时盖章。
			readonly record: DocumentCreate;
			readonly version: number;
			readonly tracker: Tracker<JsonObject>;
	  }
	| {
			// 分叉复制：记录与精确源（源 ID + 读取时点）。
			readonly kind: "fork-copy";
			readonly record: DocumentCreate;
			// 复制源：Storage 在提交 document.copy 时按此物化内容。
			readonly source: DocumentCopySource;
	  }
	// 只退休：已提交的 incarnation，assemble 只追加 document.retire。
	| { readonly kind: "retire-only"; readonly record: DocumentRecord };

/** One document incarnation acquired, created, or retired by this transaction. */
// 本事务按 staging 顺序记录的一个文档获取/退休标记。同一地址可以有多个 entry：
// 先 retire 再 doc() 会创建新 incarnation，因此 #latestDocumentByAddress 只指向最新 entry。
type DocumentEntry = {
	readonly addressId: string;
	// 逻辑地址对象；用于向 Storage 查询/创建，addressId 是它在 Map 中的字符串键。
	readonly address: DocumentAddress;
	/** Absent for definition-free fork copies and retirement entries discovered by a terminal-task scan. */
	// 定义；fork-copy 与扫描发现的 retire-only 可能没有（它们不需要初始值/版本语义）。
	// 可选字段在运行时靠 ! 断言表达“走到对应路径时一定已赋值”。
	definition?: AnyDocDefinition;
	/** Memoized public acquisition; absent for metadata-only retirement. */
	// 记忆化的公开获取 Promise；重复 doc() 返回同一草稿；metadata-only 退休没有它。
	draftPromise?: Promise<Draft<JsonObject>>;
	/** Set after acquisition or retirement lookup finds the affected incarnation. */
	// 找到的 incarnation 来源；尚未完成获取/退休查找时为空。
	target?: DocumentTarget;
	// 打开的 Chord 草稿；settleSuccess() 时同步 prepare()。
	change?: Change<JsonObject>;
	// prepare() 后的结果；只存在到 adopt()/abort()。
	prepared?: Prepared<JsonObject>;
	// 本事务是否要退休该 incarnation；获取后被 retireDoc() 置位。
	// 不是 readonly：同一个 entry 可以先获取草稿，再标记退休。
	retireOnCommit: boolean;
};

/**
 * What one staged incarnation writes and publishes, decided once before Storage admission so adoption only applies it.
 * `record` is a `DocumentRecord` for an incarnation that is already committed and a `DocumentCreate` for a new one.
 */
// 一次提交对某个 incarnation 的最终计划：写什么、是否退休、发布给谁。
// 在 Storage admission 之前一次性决定，adopt() 只应用，不再读 Storage。
// record 在提交前可能是 DocumentCreate（无 createdAt），adopt(seq) 时补上。
type DocumentPlan = {
	readonly addressId: string;
	// 提交前可能是新记录（DocumentCreate）或已提交记录（DocumentRecord）；adopt 用是否有 createdAt 区分。
	readonly record: DocumentCreate | DocumentRecord;
	// 是否写 document.retire；终态任务的文档会在 assemble 中被额外置位。
	retire: boolean;
	/** Creation, copy, or change content; absent when only retirement is written. */
	// 内容写；只退休时为 undefined。Extract 把 StorageWrite 联合收窄到三种文档内容写。
	content?: Extract<StorageWrite, { readonly type: "document.create" | "document.copy" | "document.change" }>;
	/** Prepared change of a tracked incarnation; absent for fork copies and retirement-only entries. */
	// 已 prepare 的追踪变更；fork-copy/仅退休没有。
	readonly change?: {
		// 草稿所属的 tracker；adopt(prepared) 时使用。
		readonly tracker: Tracker<JsonObject>;
		// 已物化的新值、op 和 baseRevision。
		readonly prepared: Prepared<JsonObject>;
		// 本次写入的定义版本（来自 definition.version）。
		readonly version: number;
		/** The cached incarnation this change updates; absent when it creates one. */
		// 被更新的缓存 incarnation；新建时为 undefined。
		readonly loaded?: LoadedDocument;
		// 定义；adopt/checkpoint 时需要，用于 checkpointWhen 与迁移判断。
		readonly definition?: AnyDocDefinition;
	};
	/** Resolved before Storage admission so adoption performs no reads. */
	// 发布归属；任务文档在 assemble 中通过任务记录解析，Session 文档保持 undefined。
	conversationId?: ConversationId;
	/**
	 * Set when this commit also stores held changes of the incarnation (`takeHeld()`): the operations its stored change
	 * publishes, held first, and whether it has a change of its own to show the Session's observers.
	 */
	// 本次提交同时存储了该文档的 held 改动时：存储的 ops（held 在前）以及是否还要向内部观察者发布自己的改动。
	held?: { readonly ops: readonly Op[]; readonly observed: boolean };
};

/**
 * Transaction for one Session commit callback.
 *
 * Every asynchronous operation is tracked so callback settlement can reject and drain unfinished work. Session calls
 * one settlement method, then either discards prepared changes or adopts them once after Storage succeeds.
 */
// 一次 Session 提交回调的 Transaction。
// 所有异步操作都被 #track() 登记，结算时可以拒绝并等待它们结束；
// Session 只调用一个结算方法（settleFailure 或 settleSuccess），后者要么 abort 草稿，
// 要么在 Storage 成功后统一 adopt。
// 公开方法实现 types.ts 的 Tx；内部方法用 # 前缀或注释里的 Internal 标明。
export class Transaction implements Tx {
	// 构造时注入的 Session 服务；整个事务生命周期固定。
	readonly #host: TransactionHost;
	// 提交的 Context；结算后替换为 BACKGROUND_CONTEXT，避免后续异步操作继承已取消/已结束的上下文。
	// 不是 readonly，因为结算会替换它。
	#context: Context;
	// 默认会话/归属任务。
	readonly #scope: TransactionScope;
	// 登记尚未结束的异步操作；settleSuccess 要求为空，settleFailure 会等待它们。
	readonly #pendingOperations = new Set<Promise<unknown>>();
	// 结算后置位；任何后续调用抛 "Transaction has settled"。
	#sealed = false;
	// 是否已发生表写；表读随后抛 ReadAfterWrite。
	#hasTableWrite = false;

	/** Atomic batch; conversation and entry writes stage eagerly, while task and document writes assemble later. */
	// 原子的 StorageWrite 批次：会话/条目边 stage 边 push；任务/文档在 assemble 时加入。
	// 数组本身 readonly 只禁止重新赋值，元素仍会被 push。
	readonly #writes: StorageWrite[] = [];
	// 本事务创建的会话 ID；#requireConversation 先查它，避免读尚未提交的记录。
	readonly #createdConversationIds = new Set<ConversationId>();
	// 被分叉的源会话；禁止在同一事务改其 current 策略文档。
	readonly #forkSourceConversationIds = new Set<ConversationId>();
	// 分叉复制出的源文档 ID；禁止在同一事务改源文档。
	readonly #forkSourceDocumentIds = new Set<DocumentId>();
	/** One entry per task touched by a public read, candidate write, or document-owner lookup. */
	// 每个被读到/写入/文档归属查询的任务一行。
	readonly #tasksById = new Map<TaskId, TransactionTask>();
	/** Submissions created by this transaction, by ID. */
	// 本事务创建的 submission 候选记录。
	readonly #submissions = new Map<SubmissionId, SubmissionRecord>();
	/** Submission settlements and placements in staging order; resolved against the latest candidate record during assembly. */
	// 结算/放置变更按 staging 顺序保存，assemble 时对最新候选解析。
	// 用数组而不是 Map，因为同一 submission 可以有多条变更且必须按顺序应用。
	readonly #submissionChanges: { readonly id: SubmissionId; readonly change: SubmissionChange }[] = [];

	/** Write and publication plans of every staged incarnation, built during assembly. */
	// assemble 生成的文档计划。
	readonly #plans: DocumentPlan[] = [];
	/** Every document acquisition or retirement marker in staging order. */
	// 所有文档获取/退休标记，按 staging 顺序。
	readonly #documents: DocumentEntry[] = [];
	/** Latest transaction-local incarnation or retirement marker at each logical address. */
	// 每个逻辑地址最新的 entry；用于复用草稿或判断退休后重建。
	readonly #latestDocumentByAddress = new Map<string, DocumentEntry>();

	// 输入：host 提供存储/缓存/时钟服务；context 是本次提交的上下文；scope 是默认会话与归属任务。
	// 副作用：只保存引用，不读不写；真正的行锁由 Session 在调用本构造器前持有。
	// scope 默认 {}，所以调用方可以省略。
	// 例：const tx = new Transaction(host, context, { conversationId, taskId });
	constructor(host: TransactionHost, context: Context, scope: TransactionScope = {}) {
		// 保存服务引用；之后所有读都经 host.storage（GatedStorage）。
		this.#host = host;
		// 保存上下文；settle* 结束后替换为 BACKGROUND_CONTEXT。
		this.#context = context;
		// 默认值对象由调用方拥有，这里只读使用。
		this.#scope = scope;
	}

	/** Internal: the context of the commit this transaction belongs to. */
	// 内部读取器：结算前返回提交 context，结算后返回 BACKGROUND_CONTEXT。
	// 例：const context = tx.context; // 结算前是提交 context，结算后是 BACKGROUND_CONTEXT。
	get context(): Context {
		return this.#context;
	}

	/** Internal: whether a table write was staged, after which table reads throw `ReadAfterWrite`. */
	// 内部读取器：判断是否已发生表写（通常供测试/诊断使用）。
	// 例：if (tx.hasTableWrite) { /* 之后的普通表读会抛 ReadAfterWrite */ }
	get hasTableWrite(): boolean {
		return this.#hasTableWrite;
	}

	/**
	 * Internal: whether `tx` is a transaction of a commit of the Session behind `host`. A brand check, so a proxy or
	 * another wrapper of a transaction is not one.
	 */
	// 品牌检查：判断传入的 tx 是否真的是“由这个 host 创建的 Transaction”，而不是代理/包装对象。
	// `#host in tx` 在运行时检查私有字段品牌（对任意对象安全）；两者都满足才返回 true。
	// 返回类型谓词 `tx is Transaction` 让调用方在 if 后获得具体类型；类型系统本身无法保证 Tx 就是 Transaction。
	// 例：if (Transaction.ownedBy(tx, host)) { /* 这里 tx 被收窄为 Transaction */ }
	static ownedBy(tx: Tx, host: TransactionHost): tx is Transaction {
		// 私有字段只有本类实例拥有；再比较 host 身份即可排除其他 Session 的事务。
		return #host in tx && tx.#host === host;
	}

	// ─── Table reads ────────────────────────────────────────────────────────

	// 读取会话记录；经 #read 检查未结算/未表写，并登记 Promise。
	// 例：const conversation = await tx.conversation(conversationId);
	conversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		return this.#read("conversation", () => this.#host.storage.conversation(id, this.#context));
	}

	// 重载 1：按全局条目 ID 读取，不按 kind 过滤。
	// 例：const entry = await tx.entry(entryId);
	entry(id: EntryId): Promise<EntryRecord | undefined>;
	// 重载 2：带类型 token，只有 kind 匹配才返回 TypedEntry；类型收窄在编译期，kind 比较在运行时。
	// 例：const note = await tx.entry(noteEntry, entryId); // note.data 已按 token 类型化
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
	// 实现签名：用 typeof first 判断走哪个重载。数字是 EntryId，对象是 token。
	// 重载的参数类型不会进入实现体，所以这里用联合类型手动收窄。
	// 例（内部转发）：this.entry(noteEntry, entryId) 与 this.entry(entryId) 都走这里。
	entry(first: EntryId | { readonly kind: string }, second?: EntryId): Promise<EntryRecord | undefined> {
		// token 分支取出 kind；数字分支为 undefined，表示不按 kind 过滤。
		const kind = typeof first === "number" ? undefined : first.kind;
		// 数字分支第一个参数就是 id；token 分支第二个参数才是 id（用 ! 断言，重载已保证存在）。
		const id = typeof first === "number" ? first : second!;
		return this.#read("entry", async () => {
			// storage.entry 返回 { entry, commitSeq }；事务只暴露 entry 本身。
			// 可选链 ?. 让 undefined 安全地传播。
			const entry = (await this.#host.storage.entry(id, this.#context))?.entry;
			// kind 未指定时直接返回；指定时做一次运行时 kind 比较，不匹配视为不存在。
			return kind === undefined || entry?.kind === kind ? entry : undefined;
		});
	}

	// 读取已提交任务记录；候选记录请用内部 #currentTask。
	// 例：const task = await tx.task(taskId);
	task(id: TaskId): Promise<AnyTaskRecord | undefined> {
		return this.#read("task", () => this.#committedTask(id));
	}

	// 会话扫描；游标与 order 由 Storage 解释。返回 Page<ConversationRecord, Cursor>。
	// 例：const page = await tx.scanConversations({}, 20, cursor);
	scanConversations(query: ConversationQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanConversations", () =>
			this.#host.storage.scanConversations(query, limit, cursor, this.#context),
		);
	}

	// 条目扫描；query 必须含 conversationId，limit 是页大小。
	// 例：const page = await tx.scanEntries({ conversationId }, 20);
	scanEntries(query: EntryQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanEntries", () => this.#host.storage.scanEntries(query, limit, cursor, this.#context));
	}

	// 最新 head 标记；Session 可从提交尾缓存得知，避免扫描。
	// 例：const marker = await tx.latestHeadMarker(conversationId);
	latestHeadMarker(conversationId: ConversationId) {
		return this.#read("latestHeadMarker", () => this.#host.latestHeadMarker(conversationId, this.#context));
	}

	// 最新可见条目 ID；空会话返回 undefined。
	// 例：const last = await tx.latestEntryId(conversationId);
	latestEntryId(conversationId: ConversationId): Promise<EntryId | undefined> {
		return this.#read("latestEntryId", () => this.#host.latestEntryId(conversationId, this.#context));
	}

	// 任务扫描。
	// 例：const page = await tx.scanTasks({}, 20);
	scanTasks(query: TaskQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanTasks", () => this.#host.storage.scanTasks(query, limit, cursor, this.#context));
	}

	/** Internal: committed submission record. */
	// 内部：已提交 submission 记录。
	// 例：const submission = await tx.submission(submissionId);
	submission(id: SubmissionId): Promise<SubmissionRecord | undefined> {
		return this.#read("submission", () => this.#host.storage.submission(id, this.#context));
	}

	/** Committed submission with a conversation-scoped request ID. */
	// 按会话内 requestId 去重查询。
	// 例：const existing = await tx.submissionByRequest(conversationId, requestId);
	submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined> {
		return this.#read("submissionByRequest", () =>
			this.#host.storage.submissionByRequest(conversationId, requestId, this.#context),
		);
	}

	// ─── Table writes ───────────────────────────────────────────────────────

	// 创建新会话；ownership 必填，ownerless 或归属于某任务。
	// 例：const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord> {
		return this.#write(() => this.#stageConversation(undefined, options.ownership));
	}

	/** Internal final-form bootstrap path for the reserved root identity. */
	// 内部：用保留 ID 创建根会话（引导路径），ownerless。
	// 例（内部引导）：const root = await tx.createRootConversation();
	createRootConversation(): Promise<ConversationRecord> {
		return this.#write(() => this.#stageConversation(undefined, { kind: "ownerless" }, ROOT_CONVERSATION_ID));
	}

	// 在父会话的某个具体条目处分叉；历史与文档复制由 #stageConversation 准备。
	// 例：const fork = await tx.forkConversation(parentId, atEntryId, { ownership: { kind: "ownerless" } });
	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord> {
		return this.#write(() =>
			this.#stageConversation({ conversationId: parentConversationId, at }, options.ownership),
		);
	}

	// 暂存一个会话记录；parent 非空时还会准备分叉文档复制计划并调用 conversationCreated 钩子。
	// 输入：parent 是 { conversationId, at } 或 undefined；ownership 决定 owner 字段；reservedId 仅供根会话引导。
	// 输出：完整 ConversationRecord；副作用：写入 #writes、#createdConversationIds、分叉源集合、文档 entry。
	// 错误：owner 任务不存在、条目不可见、复制地址冲突等都会抛错，随后 Session 走 settleFailure。
	// 例：await this.#stageConversation({ conversationId, at }, { kind: "ownerless" });
	async #stageConversation(
		parent: NonNullable<ConversationRecord["parent"]> | undefined,
		ownership: ConversationOwnership,
		reservedId?: ConversationId,
	): Promise<ConversationRecord> {
		// 只有 task 归属才需要解析 owner 任务。
		const ownerTaskId = ownership.kind === "task" ? ownership.taskId : undefined;
		// 根会话用保留 ID；普通会话向 Storage 申请全局递增 ID。
		// ?? 只在左侧为 null/undefined 时取右侧，因此 reservedId = 0 也会保留。
		const id = reservedId ?? (await this.#host.storage.mintId<ConversationId>());
		// mintId 是异步的，恢复后必须确认事务还没结算。
		// 同一方法后面每处 #assertOpen() 都对应一个 await 之后的复核。
		this.#assertOpen();
		// owner 字段包含任务 ID 与任务所在会话，供归属/级联查询使用。
		let owner: ConversationRecord["owner"];
		// 任务归属：先取任务的最新候选或已提交记录。
		if (ownerTaskId !== undefined) {
			// 候选优先：同一事务里刚创建的任务也能作为 owner。
			const task = await this.#currentTask(ownerTaskId);
			this.#assertOpen();
			// 运行时校验：owner 任务必须存在；类型上 TaskId 只保证编号类型。
			if (task === undefined) throw new Error(`Conversation owner task ${ownerTaskId} does not exist`);
			// 任务所在会话就是新会话的归属会话。
			owner = { conversationId: task.conversationId, taskId: ownerTaskId };
		}
		// 展开可选字段：没有父/owner 时不写 undefined 属性，保持严格 JSON。
		const record: ConversationRecord = {
			id,
			// 分叉只在有父时记录 parent；展开空对象等价于不添加字段。
			...(parent === undefined ? {} : { parent }),
			// 只有任务归属才添加 owner；ownerless 会话没有该字段。
			...(owner === undefined ? {} : { owner }),
		};
		// 分叉时只准备 document.copy 描述；真正的复制由 Storage 在提交时完成。
		// 会读取父会话可见条目与源文档元数据，因此是异步的。
		const copies =
			parent === undefined
				? []
				: await prepareForkDocumentCopies(this.#host.storage, parent.conversationId, parent.at, id, this.#context);
		this.#assertOpen();
		// 每个复制出的文档登记为 fork-copy entry，并记录源文档 ID 以防本事务误改。
		for (const copy of copies) {
			this.#forkSourceDocumentIds.add(copy.source.id);
			const entry: DocumentEntry = {
				addressId: addressId(copy.record),
				address: copy.record,
				// 展开 copy 的 record/source；target 的来源判别为 fork-copy。
				target: { kind: "fork-copy", ...copy },
				retireOnCommit: false,
			};
			// 按 staging 顺序登记 entry。
			this.#documents.push(entry);
			// 按地址登记最新 entry，后续对同一地址的 doc() 可复用它。
			this.#latestDocumentByAddress.set(entry.addressId, entry);
		}
		// 记录被分叉的源会话，assemble 时拒绝改其 current 文档。
		if (parent !== undefined) this.#forkSourceConversationIds.add(parent.conversationId);
		// 标记新会话，后续 appendEntry 无需读 Storage 确认存在。
		this.#createdConversationIds.add(id);
		// 会话写立即进入原子批次；条目写也在此阶段追加。
		this.#writes.push({ type: "conversation", value: record });
		// Session 钩子：为新会话 stage 必需文档（例如默认配置），这些文档写也属于本事务。
		await this.#host.conversationCreated(this, record);
		this.#assertOpen();
		// 返回完整记录；调用方拿到的引用之后由 Session 拥有，不应修改。
		return record;
	}

	// 重载 1：无 token，kind 与 data 由调用方自行保证。
	// 例：const entry = await tx.appendEntry(conversationId, { kind: "note", data: { text: "hi" } });
	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	// 重载 2：token 提供 kind 并类型化 data；NoInfer 防止从 value 反向推断 D。
	// 例：const entry = await tx.appendEntry(noteEntry, conversationId, { text: "hi" });
	appendEntry<D extends JsonValue>(
		token: Entry<D>,
		conversationId: ConversationId,
		value: TypedEntryDraft<NoInfer<D>>,
	): Promise<TypedEntry<D>>;
	// 实现签名：第一个参数可能是会话 ID（数字）或 token（对象）。
	// 第三个参数只在 token 重载里存在。
	// 例（内部转发）：this.appendEntry(noteEntry, conversationId, { text: "hi" })。
	appendEntry(
		first: ConversationId | { readonly kind: string },
		second: ConversationId | EntryDraft,
		third?: object,
	): Promise<EntryRecord> {
		// 数字 → 无 token 重载，第二个参数就是 EntryDraft。
		if (typeof first === "number") return this.#appendEntry(first, second as EntryDraft);
		// token 分支：第二个参数是会话语，第三个是 TypedEntryDraft；合入 token.kind 后交给内部实现。
		// as EntryDraft 是因为展开后的对象无法让 TS 自动证明与 kind/data 的对应关系。
		return this.#appendEntry(second as ConversationId, { ...third, kind: first.kind } as EntryDraft);
	}

	// 暂存一条 entry：先确认会话存在（本事务创建或已提交），再 mint ID、复制成严格 JSON 记录。
	// EntryDraft 允许 head: "self"，这里转成新 ID；byTaskId 来自 TransactionScope.taskId。
	// 例：await this.#appendEntry(conversationId, { kind: "note", data: {} });
	#appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord> {
		// #write 会先置 hasTableWrite；回调内不再允许表读。
		return this.#write(async () => {
			// 会话可以刚在本事务创建（#createdConversationIds），否则读 Storage。
			await this.#requireConversation(conversationId);
			this.#assertOpen();
			// 条目 ID 由 Storage 的全局命名空间分配，跨重开递增。
			const id = await this.#host.storage.mintId<EntryId>();
			this.#assertOpen();
			// 解构：head 单独处理，"self" 要换成新 ID；rest 保留 model/data/edits 等其余字段。
			const { head, ...rest } = value;
			// Undefined `head` and `byTaskId` are omitted by the copy.
			// copyJson 生成严格 JSON 且与输入不共享引用；omitUndefinedProperties 去掉可选空字段。
			// as unknown as EntryRecord：copyJson 返回 JsonValue，TS 无法从运行时的结构校验推断出 EntryRecord。
			const record = copyJson(
				{
					// 展开 rest 保留 model/data/edits 等字段。
					...rest,
					id,
					conversationId,
					// "self" → 新 id，表示活动上下文从这个条目开始；其他值（含 undefined）原样保留。
					head: head === "self" ? id : head,
					// 如果本次提交绑定了任务，条目记录 byTaskId；undefined 会被复制选项省略。
					byTaskId: this.#scope.taskId,
				},
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as EntryRecord;
			// entry 写立即进入批次。
			this.#writes.push({ type: "entry", value: record });
			// 返回新记录；它已进入原子批次，但还没提交。
			return record;
		});
	}

	// 创建一个持久任务记录，返回 TaskId。任务状态从 pending + definition.initial(input) 开始。
	// 输入：task 定义；input 初始输入；options 创建选项（ownership 必填）。
	// 内部扩展 submissionIds：从 submission 的 trace 推导本任务的 trace 与 links。
	// 约束：子任务不能 background，且必须与 owner 同会话；任务 owner 必须存在且非终态/非 abort 标记。
	// 副作用：把候选任务写进 #tasksById；实际存储由 assemble 统一追加。
	// 例：const id = await tx.createTask(MyTask, input, { ownership: { kind: "conversation" }, conversationId });
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: TaskCreationOptions,
	): Promise<TaskId<R>> {
		return this.#write(async () => {
			// 内部 run 创建：submissionIds 可能指向本事务刚创建的 submission，也可能在 Storage 中。
			if (options.submissionIds !== undefined) {
				// 第一个 submission 的 trace 作为父上下文；后续 submission 的 trace 作为 links。
				let trace: TaskOptions["trace"];
				let links: TelemetryCarrier[] | undefined;
				// 按顺序解析；index 0 决定 trace，其余只追加 links。
				for (let index = 0; index < options.submissionIds.length; index++) {
					const id = options.submissionIds[index]!;
					// 先查本事务刚创建的 submission，再回退到 Storage。
					// ?? 左侧为 undefined 时才 await 右侧。
					const submission = this.#submissions.get(id) ?? (await this.#host.storage.submission(id, this.#context));
					// 没有 trace 时用 "root" 表示从 adapter 根开始，不存 carrier。
					if (index === 0) trace = submission?.trace ?? "root";
					// 后续 trace 只作为创建时链接，不成为父上下文。
					else if (submission?.trace !== undefined) {
						links ??= [];
						links.push(submission.trace);
					}
				}
				// 覆盖 trace/links；其余 TaskOptions 保留。
				options = { ...options, trace, links };
			}
			// ownership 必填；决定任务是顶层还是子任务。
			const ownership = options.ownership;
			let owner: AnyTaskRecord | undefined;
			// 子任务：解析 owner 的候选/已提交记录。
			if (ownership.kind === "task") {
				// assemble 还会用 owner 的最终候选再审一次，防止同一提交先改 owner 后建子任务。
				// Validated again against the owner's final candidate during assembly.
				owner = await this.#currentTask(ownership.taskId);
				this.#assertOpen();
				if (owner === undefined) throw new Error(`Task owner ${ownership.taskId} does not exist`);
				// background 只用于顶层会话任务，避免被普通空闲等待忽略的子任务脱离归属。
				if (options.background === true) throw new TypeError("A child task cannot be background");
				if (options.conversationId !== undefined && options.conversationId !== owner.conversationId) {
					// 子任务必须与 owner 同会话；显式传入其他会话会破坏归属树。
					throw new Error(`A child task lives in its owner's conversation ${owner.conversationId}`);
				}
			}
			// 优先级：owner 的会话 > 显式 options.conversationId > 事务默认会话。
			const conversationId = owner?.conversationId ?? options.conversationId ?? this.#scope.conversationId;
			// 运行时必填检查；类型上 conversationId 可选，因为 owner 路径可以推导。
			if (conversationId === undefined) throw new TypeError("Tx.createTask() requires options.conversationId");
			await this.#requireConversation(conversationId);
			this.#assertOpen();
			// 定义提供 name/version 与 initial()。
			const definition = task.definition;
			// 起始 checkpoint 由定义生成；之后 phase handler 从这里恢复。
			const checkpoint = definition.initial(input);
			// 任务 ID 由 Storage 分配；泛型 R 只影响类型，运行时擦除。
			const id = await this.#host.storage.mintId<TaskId<R>>();
			this.#assertOpen();
			// copyJson 保证严格 JSON，并断开与 input 的引用共享。
			// as unknown as AnyTaskRecord 同样是跨过 JsonValue → 领域类型的断言。
			const record = copyJson(
				{
					id,
					conversationId,
					kind: definition.name,
					version: definition.version,
					input,
					// trace 三种情况：显式 "root" 不存；显式 carrier 原样存；未指定则从当前 telemetry 注入。
					// 可选链 propagation?. 允许没有传播能力的 adapter；注入失败/无 carrier 时得到 undefined。
					trace:
						// "root" 是字符串字面量，不是 carrier；其他值都是 TelemetryCarrier。
						options.trace === "root"
							? undefined
							: (options.trace ?? this.#context.telemetry.propagation?.inject(this.#context.telemetry)),
					// 创建时链接；undefined 属性会被复制选项省略。
					links: options.links,
					// 非顶层任务记录 owner ID；顶层任务没有该字段。
					...(owner === undefined ? {} : { owner: owner.id }),
					// 默认 false；只有顶层任务可选 true，子任务在上方已拒绝。
					background: options.background ?? false,
					// 新任务没有 abort 标记。
					abortRequested: false,
					// 仅在显式为 true 时写入，避免 false 占空间。
					...(options.abandonOnRestart === true ? { abandonOnRestart: true } : {}),
					// 初始状态 pending，携带完整 checkpoint；调度器之后会把它改成 running。
					state: { status: "pending", checkpoint },
				},
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as AnyTaskRecord;
			// 候选写入按 create 记入 tasksById；不直接 push #writes，assemble 时统一追加。
			this.#tasksById.set(id, { write: { kind: "create", record } });
			// 返回 ID；此时记录还未存储，但可被同一事务的后续操作引用。
			return id;
		});
	}

	/** Create a raw submission record with a fresh ID; no admission rules apply. */
	// 创建原始 submission 记录：不做忙闲检查、不排队、不放置；调用方自行实现准入规则。
	// 公开的 Conversation.submit() 会走 harness 的准入逻辑，这里只是底层能力。
	// 例：const s = await tx.createSubmission({ type: "input", status: "queued", conversationId });
	createSubmission(create: SubmissionCreate): Promise<SubmissionRecord> {
		return this.#write(async () => {
			await this.#requireConversation(create.conversationId);
			this.#assertOpen();
			const id = await this.#host.storage.mintId<SubmissionId>();
			this.#assertOpen();
			// 复制并补 id；展开后 TS 无法证明仍是 SubmissionRecord 联合成员，因此断言。
			const record = copyJson({ ...create, id }, TABLE_JSON_COPY_OPTIONS) as unknown as SubmissionRecord;
			// 本事务创建的候选记录；后续 settle/place 优先查这里。
			this.#submissions.set(id, record);
			return record;
		});
	}

	/**
	 * Settle a submission. Resolved during assembly against the transaction's latest candidate record, falling back to
	 * committed state, so it is not a caller table read and works after the first table write.
	 */
	// 暂存一次 submission 结算。它不是表读：assemble 时对本事务最新候选解析，
	// 因此即使已经发生表写也可以调用（与之相对，普通表读会抛 ReadAfterWrite）。
	// 输入：id + settlement；副作用：置 hasTableWrite、追加到 #submissionChanges。
	// copyJson 隔离调用方后续修改，并保证写入严格 JSON。
	// 例：tx.settleSubmission(submissionId, { status: "done", answer: entryId });
	settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		// copyJson 返回 JsonValue；settlement 的形状由调用方类型保证，这里断言回领域类型。
		this.#submissionChanges.push({ id, change: copyJson(settlement) as SubmissionSettlement });
	}

	/** Place a queued submission at `entry`; resolved during assembly like `settleSubmission()`. */
	// 暂存“把排队 submission 放到 entry”的变更；解析方式与 settleSubmission 相同。
	// input 放进去后变 placed，write 变 done（见 applySubmissionChange）。
	// 例：tx.placeSubmission(submissionId, entryId);
	placeSubmission(id: SubmissionId, entry: EntryId): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		// placed 是内部合成状态，SubmissionSettlement 不包含它。
		this.#submissionChanges.push({ id, change: { status: "placed", entry } });
	}

	/** Internal: replace one task record completely. Tasks change their own state through their runtime. */
	// 内部：整条替换任务记录。任务自己的 runtime 只通过提交改变状态；
	// 这里校验：候选已终态不能再改、不能换会话；时间戳由 #stampTimes() 补。
	// 例：tx.setTask({ ...current, state: { status: "running", checkpoint } });
	setTask(value: AnyTaskRecord): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		// 取/建该任务的暂存行。
		const task = this.#taskEntry(value.id);
		// 同一事务里可能已有候选；后续校验以候选为准。
		const candidate = task.write?.record;
		// 已终态候选不可再改；防止 terminal → running。
		if (candidate?.state.status === "terminal") {
			throw new Error(`Task ${value.id} already has a terminal candidate`);
		}
		// 任务绑定会话不可变。
		if (candidate !== undefined && candidate.conversationId !== value.conversationId) {
			throw new Error(`Task ${value.id} cannot change conversations`);
		}
		task.write = {
			kind: task.write?.kind === "create" ? "create" : "replace",
			// copyJson 隔离调用方对象；断言跨过 JsonValue → TaskRecord。
			record: copyJson(this.#stampTimes(value, candidate), TABLE_JSON_COPY_OPTIONS) as unknown as AnyTaskRecord,
		};
	}

	/** Internal: candidate records of the tasks this transaction created or replaced so far. */
	// 内部：返回本事务迄今创建/替换的候选任务记录，供 Session 索引任务文档。
	// 例：const candidates = tx.stagedTasks();
	stagedTasks(): AnyTaskRecord[] {
		const records: AnyTaskRecord[] = [];
		// 只收集有 write 的行；只读过的任务不产生记录。
		for (const task of this.#tasksById.values()) if (task.write !== undefined) records.push(task.write.record);
		return records;
	}

	/** Internal: IDs of the tasks this transaction creates. */
	// 内部：本事务创建（而非替换）的任务 ID。
	// 例：const created = tx.createdTaskIds();
	createdTaskIds(): TaskId[] {
		const ids: TaskId[] = [];
		// Map 迭代得到 [key, value] 元组；解构后取 ID。
		for (const [id, task] of this.#tasksById) if (task.write?.kind === "create") ids.push(id);
		return ids;
	}

	/** Internal: conversations this transaction created or forked so far. */
	// 内部：本事务创建/分叉的会话记录。
	// 例：const created = tx.stagedConversations();
	stagedConversations(): ConversationRecord[] {
		const records: ConversationRecord[] = [];
		// 会话写已经 eager 进入 #writes，因此直接筛选；判别联合的 type 收窄 value 类型。
		for (const write of this.#writes) if (write.type === "conversation") records.push(write.value);
		return records;
	}

	// ─── Documents ──────────────────────────────────────────────────────────
	// 重载 1：Session 作用域单例。
	// 例：const draft = await tx.doc(sessionDocToken);
	doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
	// 重载 2：会话作用域单例。
	// 例：const draft = await tx.doc(conversationDocToken, conversationId);
	doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<Draft<T>>;
	// 重载 3：任务作用域单例。
	// 例：const draft = await tx.doc(taskDocToken, taskId);
	doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
	// 重载 4：Session 作用域 family，key + seed。
	// 例：const draft = await tx.doc(sessionFamilyToken, "member-key", initialValue);
	doc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	// 重载 5：会话作用域 family；参数顺序是 conversationId、key、seed。
	// 例：const draft = await tx.doc(conversationFamilyToken, conversationId, "member-key", initialValue);
	doc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	// 重载 6：任务作用域 family；参数顺序是 taskId、key、seed。
	// 例：const draft = await tx.doc(taskFamilyToken, taskId, "member-key", initialValue);
	doc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	// doc() 的实现签名：token 决定 scope/family/version，args 是各重载去掉 token 后的地址参数。
	// 流程：assertOpen → resolveAddress → 任务终态检查 → 复用同事务草稿/fork-copy → 新建 entry → #acquire。
	// 返回 Promise<Draft<JsonObject>>；公开重载会把具体 T 透传给调用方。
	// 注意：任何同步错误都被 catch 转成 rejected Promise，因此调用方必须 await 才能看到错误。
	// 例（内部转发）：this.doc(conversationDocToken, conversationId);
	doc(token: AnyDocToken, ...args: readonly unknown[]): Promise<Draft<JsonObject>> {
		try {
			this.#assertOpen();
			// token 是 defineDoc()/defineDocFamily() 的产物，definition 带 scope/family/version/initial 等元数据。
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			this.#assertTaskDocumentsOpen(resolved);
			const latest = this.#latestDocumentByAddress.get(resolved.id);
			// 同一地址已有未退休 entry：复用其草稿或 fork-copy，避免重复获取。
			if (latest !== undefined && !latest.retireOnCommit) {
				if (latest.draftPromise !== undefined) return latest.draftPromise;
				if (latest.target?.kind === "fork-copy") {
					latest.draftPromise = this.#track(this.#acquireForkCopy(latest, definition, latest.target));
					return latest.draftPromise;
				}
			}
			// family 文档取 seed 参数（resolved.nextArgument 由 resolveAddress 计算），单例文档没有 seed。
			// copyJson 隔离调用方之后可能修改的 seed 对象。
			const seed = definition.family === true ? copyJson(args[resolved.nextArgument]) : undefined;
			// 新 entry：记录地址与定义；target 稍后由 #acquire 填充。
			const docEntry: DocumentEntry = {
				addressId: resolved.id,
				address: resolved.address,
				definition,
				retireOnCommit: false,
			};
			// 按 staging 顺序登记，并成为该地址最新 entry。
			this.#documents.push(docEntry);
			this.#latestDocumentByAddress.set(docEntry.addressId, docEntry);
			// Capture retirement before awaiting so a pending old acquisition and its replacement stay distinct.
			// 必须在 await 之前捕获 latest.retireOnCommit：旧草稿的退休状态与新获取要区分。
			// skipLoad = 同地址上一个 entry 已退休，此时直接建新 incarnation，不读旧值。
			docEntry.draftPromise = this.#track(this.#acquire(docEntry, seed, latest?.retireOnCommit === true));
			return docEntry.draftPromise;
		} catch (error) {
			// 同步错误（地址参数非法等）转为 rejected Promise，保持签名始终返回 Promise。
			return Promise.reject(error);
		}
	}

	// 重载 1：Session 作用域单例。
	// 例：await tx.retireDoc(sessionDocToken);
	retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
	// 重载 2：会话作用域单例。
	// 例：await tx.retireDoc(conversationDocToken, conversationId);
	retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<void>;
	// 重载 3：任务作用域单例。
	// 例：await tx.retireDoc(taskDocToken, taskId);
	retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
	// 重载 4：Session 作用域 family，只传 key，不传 seed。
	// 例：await tx.retireDoc(sessionFamilyToken, "member-key");
	retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
	// 重载 5：会话作用域 family；key 是成员键，retire 不需要 seed，因为不会创建文档。
	// 例：await tx.retireDoc(conversationFamilyToken, conversationId, "member-key");
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
	): Promise<void>;
	// 重载 6：任务作用域 family。
	// 例：await tx.retireDoc(taskFamilyToken, taskId, "member-key");
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
	): Promise<void>;
	// retireDoc() 的实现签名。退休一个文档 incarnation：若本地已获取草稿，先让它的内容随提交存储，再写 retire；
	// 若没有本地 entry，则异步查当前 incarnation，只写 retirement。重复退休幂等。
	// 返回 Promise<void>；与 doc() 一样，同步错误会转成 rejected Promise。
	// 例（内部转发）：this.retireDoc(conversationDocToken, conversationId);
	retireDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<void> {
		try {
			this.#assertOpen();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const latest = this.#latestDocumentByAddress.get(resolved.id);
			// 幂等：同地址最新 entry 已经安排退休，就不再重复登记。
			if (latest?.retireOnCommit) return Promise.resolve();
			// fork-copy 尚未真正读取源值；只需校验 scope 并标记退休，内容从未被本事务获取。
			// 可选链让 latest/target 任一不存在时条件为 false。
			if (latest?.target?.kind === "fork-copy") {
				// 运行时校验定义与复制记录语义匹配；不通过则抛错，由外层转成 rejected Promise。
				checkRecordScope(definition, latest.target.record);
				latest.retireOnCommit = true;
				return Promise.resolve();
			}
			if (latest?.draftPromise !== undefined) {
				// 已获取草稿：先把 retireOnCommit 置位，再等待获取完成；内容仍会被存储，然后才退休。
				// Retirement of an acquired draft persists its final content before retirement.
				// 先置位再 await：即使获取失败，退休意图也已记录；但失败会让整个事务结算失败。
				latest.retireOnCommit = true;
				// then(() => undefined) 丢弃草稿值，只保留完成/失败信号；#track 让结算等待它。
				return this.#track(latest.draftPromise.then(() => undefined));
			}
			// 无本地草稿：新建 retire-only entry，异步查找当前 record（可能不存在）。
			const entry: DocumentEntry = {
				addressId: resolved.id,
				address: resolved.address,
				definition,
				retireOnCommit: true,
			};
			this.#documents.push(entry);
			this.#latestDocumentByAddress.set(entry.addressId, entry);
			// findRetirement 会先等待该地址未发布写，再查缓存/Storage；它设置 entry.target。
			return this.#track(this.#findRetirement(entry));
		} catch (error) {
			// 与 doc() 一样把同步错误转为 rejected Promise。
			return Promise.reject(error);
		}
	}

	// 装载或新建一个 incarnation 并开始 Chord change。
	// 输入：entry（地址与定义）、seed（family 初始值）、skipLoad（上一个 incarnation 已在本事务退休）。
	// 输出：可写的 Draft；副作用：设置 entry.target/entry.change。
	// 流程：load → 校验 scope/version → beginChange；不存在则校验 owner 存在且非终态 → initial → mint ID → track。
	// 例：const draft = await this.#acquire(entry, seed, false);
	async #acquire(entry: DocumentEntry, seed: JsonValue | undefined, skipLoad: boolean): Promise<Draft<JsonObject>> {
		// 能走到 acquire 的 entry 一定有 definition；! 断言表达这个不变量。
		const definition = entry.definition!;
		// skipLoad 时旧 incarnation 已退休，直接创建新值。
		const loaded = skipLoad
			? undefined
			: // load 会使用缓存或从 Storage 冷装载，并按需 migrate；返回 undefined 表示地址上没有当前 incarnation。
				await this.#host.load(definition, entry.addressId, entry.address, this.#context);
		this.#assertOpen();
		// 已有 incarnation：基于缓存值开草稿，而不是创建新记录。
		if (loaded !== undefined) {
			// 运行时校验：定义的 scope/history/fork 必须与存储记录兼容。
			// 这些语义靠定义对象与记录对象的运行时值比较，TS 类型无法保证地址一致性。
			checkRecordScope(definition, loaded.record);
			// 运行时校验：存储版本不能比定义新；旧版本必须有 migrate()。
			checkRecordVersion(definition, loaded.record, loaded.storedVersion);
			// 标记来源为已加载；adopt() 时更新缓存而不是安装新记录。
			entry.target = { kind: "loaded", document: loaded };
			// beginChange() 创建草稿；同一 tracker 上可以有多个草稿，但只有基于最新 revision 的能成功 adopt。
			entry.change = loaded.tracker.beginChange();
			// Draft<T> 是 Proxy 视图；读/写由 Chord 追踪，不修改 base。
			return entry.change.state;
		}
		// 文档不存在：校验其 owner 仍可写。
		const scope = entry.address.scope;
		// 会话文档要求会话存在（本事务创建或已提交）。
		if (scope.kind === "conversation") await this.#requireConversation(scope.conversationId);
		if (scope.kind === "task") {
			const task = await this.#currentTask(scope.taskId);
			if (task === undefined) throw new Error(`Task ${scope.taskId} does not exist`);
			// 终态任务的文档不能再创建。
			if (task.state.status === "terminal") throw new Error(`Task ${scope.taskId} is terminal`);
		}
		this.#assertOpen();
		// family 用 initial(seed)，singleton 用 initial()；copyJson 隔离调用方 seed 并保证严格 JSON。
		// 条件表达式两侧返回 JsonObject，统一断言。
		const value = copyJson(
			definition.family === true ? definition.initial(seed) : definition.initial(),
		) as JsonObject;
		// 新 incarnation ID；同一逻辑地址重建时会得到新 ID，旧 ID 不复用。
		const id = await this.#host.storage.mintId<DocumentId>();
		this.#assertOpen();
		// track 接管 value 所有权，不复制不遍历；之后 value 只应由 tracker 草稿修改。
		const tracker = track(value);
		entry.target = {
			kind: "created",
			// 新记录还没有 createdAt；Storage 提交时盖章。history/fork 从 definition 带入。
			record: documentCreate(definition, entry.address, id),
			version: definition.version,
			tracker,
		};
		entry.change = tracker.beginChange();
		return entry.change.state;
	}

	// fork-copy 的值来自 Storage 中精确源（id + 时点）：读取、校验记录一致、迁移到当前版本，再 track。
	// 复制记录本身已由 prepareForkDocumentCopies() 生成；这里只负责在首次 doc() 时把值装载进内存。
	// 例：await this.#acquireForkCopy(entry, definition, entry.target);
	async #acquireForkCopy(
		entry: DocumentEntry,
		definition: AnyDocDefinition,
		target: Extract<DocumentTarget, { readonly kind: "fork-copy" }>,
	): Promise<Draft<JsonObject>> {
		// 按源 ID 和时点读取；时点通常是分叉条目的 commitSeq 或 "current"。
		const stored = await this.#host.storage.document(target.source.id, target.source.at, this.#context);
		this.#assertOpen();
		// 源文档不存在说明分叉准备与 Storage 状态不一致。
		if (stored === undefined) {
			throw new Error(`Fork source document ${target.source.id} cannot be read`);
		}
		if (
			// 运行时校验：源记录必须与复制记录同 scope/kind/key/history/fork，防止复制错文档。
			// 复制记录由 fork 准备阶段生成，这里是信任边界上的最后核对。
			stored.record.scope.kind !== "conversation" ||
			stored.record.kind !== target.record.kind ||
			stored.record.key !== target.record.key ||
			stored.record.history !== target.record.history ||
			stored.record.fork !== target.record.fork
		) {
			throw new Error(`Fork source document ${target.source.id} does not match the copied record`);
		}
		// materializeDocumentValue 会校验 scope/版本并在需要时 migrate，返回独立 JSON 值。
		const value = materializeDocumentValue(definition, target.record, stored.version, stored.value);
		const tracker = track(value);
		// definition 之前可能缺失（复制 entry 创建时没有）；这里补上，供后续 checkpoint/adopt 使用。
		entry.definition = definition;
		entry.target = { kind: "created", record: target.record, version: definition.version, tracker };
		entry.change = tracker.beginChange();
		return entry.change.state;
	}

	// 只为退休查找当前 incarnation：先等待该地址的未发布写（避免读到即将被替换的旧记录），
	// 再优先用缓存，否则查 Storage 的 current。找不到表示文档本就不存在，退休为空操作。
	// 例：await this.#findRetirement(entry);
	async #findRetirement(entry: DocumentEntry): Promise<void> {
		// touch 返回 undefined 表示没有未发布写，无需等待。
		const gate = this.#host.touch(documentKey(entry.addressId));
		if (gate !== undefined) await gate;
		// cached() 不装载；缓存没有才访问 Storage。
		// ?? 左侧为 undefined 时求值右侧（异步读）。
		const record =
			this.#host.cached(entry.addressId)?.record ??
			(await this.#host.storage.findDocument(entry.address, "current", this.#context));
		this.#assertOpen();
		// 文档不存在：提交里不需要 retire 写。
		if (record === undefined) return;
		checkRecordScope(entry.definition!, record);
		// retire-only 只保存已提交记录，assemble 生成 retirement 写。
		entry.target = { kind: "retire-only", record };
	}

	// ─── Settlement ─────────────────────────────────────────────────────────

	/** Seal after callback failure: abort every change and observe every pending operation. */
	// 回调失败后的结算：密封事务、abort 所有草稿、等待所有已登记异步操作落地，最后把 context 换成
	// BACKGROUND_CONTEXT（避免后续清理逻辑继承已取消的 context）。不会抛错，也不会写 Storage。
	// 例：await tx.settleFailure(); // 回调抛错时由 Session 调用
	async settleFailure(): Promise<void> {
		this.#sealed = true;
		this.#abortChanges();
		await Promise.allSettled(this.#pendingOperations);
		this.#context = BACKGROUND_CONTEXT;
	}

	/**
	 * Seal after callback success, prepare every open change, and assemble the atomic batch.
	 * Any failure aborts every change before Storage admission.
	 */
	// 回调成功后的结算：密封 → 确认没有遗留异步操作 → 同步 prepare 所有草稿 → assemble 原子批次。
	// 任何失败（包括未 await 的操作、校验失败）都会 abort 草稿后抛错，绝不进入 Storage。
	// 返回的 StorageWrite[] 交给 Session 的 Writer 批量存储。
	// 例：const writes = await tx.settleSuccess();
	async settleSuccess(): Promise<readonly StorageWrite[]> {
		this.#sealed = true;
		// 有未完成的 Tx 操作：不能提交一个还没决定完的事务。
		if (this.#pendingOperations.size > 0) {
			this.#abortChanges();
			// allSettled 不抛错；错误由下一行统一报告。
			await Promise.allSettled(this.#pendingOperations);
			this.#context = BACKGROUND_CONTEXT;
			// 这是调用方 bug：回调必须在所有 Tx 操作结束后才返回。
			throw new Error("Session commit callback settled before its pending Tx operations");
		}
		try {
			// 先同步 prepare：prepare() 会撤销草稿，之后任何写入都会抛 TypeError。
			// 同步执行也保证在第一个 await 之前，所有草稿状态已定型。
			// Synchronously prepare every open change; this revokes every draft.
			// 只 prepare 有 change 的 entry；fork-copy/retire-only 没有草稿。
			for (const document of this.#documents) {
				// prepare() 可能抛错（例如草稿里有非法值）；catch 会 abort 其他已打开的草稿。
				if (document.change !== undefined) document.prepared = document.change.prepare();
			}
			// assemble 内可能有 Storage 读（owner 校验、扫描），所以是异步。
			return await this.#assemble();
		} catch (error) {
			// 校验/组装失败：所有已 prepare 的变更都要 abort。
			this.#abortChanges();
			throw error;
		} finally {
			// 无论成功失败，之后都不应再用调用方 context 发起异步操作。
			this.#context = BACKGROUND_CONTEXT;
		}
	}

	/** Abort every prepared change after Storage failure or when no write is required. */
	// Storage 失败或事务没有写时调用：abort 所有草稿；对已 abort 的 change 是幂等的。
	// 例：tx.discard(); // Storage 已失败，放弃所有草稿
	discard(): void {
		this.#abortChanges();
	}

	/**
	 * Internal: what a deferred commit holds in memory instead of storing (`CommitPersistence`), each changed incarnation
	 * with its operations and whether they selected a base; `undefined` when the commit must be stored. It may be held
	 * only when every write changes an existing `latest`, `initial`-fork conversation document at its stored version.
	 */
	// 判断一次提交能否延迟存储（CommitPersistence deferred）：只有“修改已存在、latest+initial 会话文档、
	// 且版本未变”的 document.change 才能 hold。任何表写、创建/复制/退休、迁移都必须立即存储。
	// 返回每个文档的 LoadedDocument、待发 ops、是否选了 base；undefined 表示必须立即存储。
	// 纯查询：不修改事务状态；调用后仍可走正常存储路径。
	// 例：const held = tx.holdable(); // undefined 表示这次提交必须立即存储
	holdable(): { readonly loaded: LoadedDocument; readonly ops: readonly Op[]; readonly base: boolean }[] | undefined {
		// 表写（会话/条目/任务/submission）不能延迟。
		if (this.#writes.some((write) => write.type !== "document.change")) return undefined;
		// 逐个计划检查；不满足任一条件就整体拒绝。
		// 空数组类型由上下文推断为 { loaded, ops, base }[]。
		const held = [];
		for (const plan of this.#plans) {
			// 解构计划的内容写与追踪变更。
			const { content, change } = plan;
			// 只读、无内容写也无退休的计划不影响存储。
			if (content === undefined && !plan.retire) continue;
			// 退休、创建/复制、或没有实际 document.change 的提交不能 hold。
			if (plan.retire || change?.loaded === undefined || content?.type !== "document.change") return undefined;
			// 上方条件已排除 undefined，TS 在这里把 change/loaded 收窄为非空；运行时无需再判。
			const { loaded, prepared, version } = change;
			const record = loaded.record;
			// 只允许 conversation scope、history latest、fork initial 的文档延迟。
			if (record.scope.kind !== "conversation" || record.history !== "latest" || record.fork !== "initial") {
				return undefined;
			}
			// storedVersion !== version 表示需要迁移，必须立即写 base。
			// A migration stores a base at once.
			if (loaded.storedVersion !== version) return undefined;
			// 保存 ops；base 表示本次提交选中了完整值（迁移已被上方版本相等检查排除，实际来自 checkpointWhen）。
			held.push({ loaded, ops: prepared.ops, base: content.content.kind === "base" });
		}
		// 所有计划都可 hold，返回列表；Session 之后调用 adoptHeld()。
		return held;
	}

	/**
	 * Internal: adopt a held commit (`holdable()`) in memory only. Trackers advance by pointer swap; stored versions and
	 * delta counts stay, as nothing was stored. Returns its publication for the Session's own observers.
	 */
	// 内存采纳一个 held 提交：只做 tracker.adopt(prepared) 指针交换，不写 Storage，
	// 因此 storedVersion/deltasSinceBase 不变。返回给 Session 内部观察者的发布列表。
	// 没有 op 的 prepared 直接 abort，避免空草稿占用 tracker。
	// 例：const publications = tx.adoptHeld();
	adoptHeld(): DocumentCommitChange[] {
		// 每个非空计划生成一条发布。
		const publications: DocumentCommitChange[] = [];
		for (const plan of this.#plans) {
			// holdable() 保证每个 plan 都有 change（loaded+prepared+version），所以这里可以 ! 断言。
			// Every plan of a held commit changes or reads a loaded incarnation (`holdable()`).
			// 解构出指针交换所需的 tracker/prepared/version/loaded。
			const { tracker, prepared, version, loaded } = plan.change!;
			// 空变更不 adopt，也不发布。
			if (prepared.ops.length === 0) {
				prepared.abort();
				continue;
			}
			// 指针交换；旧草稿失效，tracker.value 变为 prepared.value。
			tracker.adopt(prepared);
			// loaded 一定存在（holdable 条件）；发布使用已提交的记录身份。
			const record = loaded!.record;
			// assemble 已解析归属；held 提交只改会话文档，所以应有值。
			const conversationId = plan.conversationId;
			// 发布内存采纳后的精确值/ops；conversationId 由 assemble 预先解析。
			publications.push({
				type: "document",
				kind: "change",
				record,
				conversationId,
				version,
				value: prepared.value,
				ops: prepared.ops,
			});
		}
		return publications;
	}

	/**
	 * Internal: store the held changes of every incarnation this commit reads or writes in front of its own, so a stored
	 * document never misses an operation its later ones build on. Called right before Storage admission, after every
	 * fallible step, because it empties the holds: a failure earlier keeps them. Returns the holds it took.
	 */
	// 在 Storage admission 前，把 Session 已持有（held）的文档改动并入本次提交的写，顺序在本次自己的 op 之前，
	// 保证“读者重放存储内容”与内存值一致。调用后 hold 即被取走；若之后失败，Session 仍保留它们（本函数只应在
	// 所有易失败步骤之后调用）。
	// 输入：held 按 DocumentId 查找；输出：被取走的 hold 列表，供 Session 在发布后释放。
	// 泛型 H 让 Session 可以传入自己的 Hold 子类型（带 deadline/unpin）。
	// 例：const holds = tx.takeHeld((id) => holdById.get(id));
	takeHeld<H extends HeldDocument>(held: (id: DocumentId) => H | undefined): H[] {
		// 记录本次取走的 hold；Session 负责 release（解除 pin 与队列）。
		const taken: H[] = [];
		for (const plan of this.#plans) {
			// 新 incarnation（DocumentCreate）没有 createdAt，也就没有已持有的改动。
			// A new incarnation holds nothing yet.
			if (!("createdAt" in plan.record)) continue;
			// plan.record 在这里已收窄为 DocumentRecord（上方 in 检查），id 是已提交 incarnation ID。
			const hold = held(plan.record.id);
			// 该 incarnation 没有 held 改动。
			if (hold === undefined) continue;
			// 取走：即使后续写入失败，Session 也不应再把这些 op 当作“已持有但不属于本次提交”。
			taken.push(hold);
			// 本次自己的内容写（若有）；创建/复制不可能是 held 目标。
			const own = plan.content?.type === "document.change" ? plan.content : undefined;
			// 本次自己的 prepared 变更（只读获取时为 undefined）。
			const change = plan.change;
			// 若本次有自己的草稿，用它的新值；否则文档只是被读取，用 hold 的当前值。
			const value = change?.prepared.value ?? hold.loaded.tracker.value;
			// 折叠 hold.pending + 本次 ops，得到一条可存储内容与读者需重放的 ops。
			const stored = storeHeld(hold, change?.prepared.ops ?? EMPTY_OPERATIONS, value, hold.loaded.valueVersion);
			// A base this commit selected or must write covers what was held.
			// 本次选中 base 时以本次的 base 为准（覆盖已折叠的 delta）；否则用 fold 结果。
			const content = own?.content.kind === "base" ? own.content : stored.content;
			// as const 让 type 保持字面量，符合 StorageWrite 联合。
			const write = { type: "document.change", id: plan.record.id, content } as const;
			// 本次已有 document.change 就原地替换内容，保持批次顺序。
			if (own !== undefined) this.#writes[this.#writes.indexOf(own)] = write;
			// 否则插到该文档的退休写之前（或末尾）。
			else this.#insertBeforeRetirement(write);
			// 记录存储的 ops；observed 表示本次自己也有改动要发布给内部观察者。
			if (!plan.retire) plan.held = { ops: stored.ops, observed: own !== undefined };
			// 让 adopt() 看到最终写入内容（决定 base/delta 与发布）。
			plan.content = write;
			// Held documents are conversation documents; one this commit only read has no owner resolved yet.
			// 会话文档的归属可以直接从记录 scope 得到；任务文档留给后面的统一解析。
			if (plan.record.scope.kind === "conversation") plan.conversationId = plan.record.scope.conversationId;
		}
		return taken;
	}

	/**
	 * Internal: the keys this commit writes, once settled (and after `takeHeld()`), for the Session's unpublished write
	 * set: its table records, and the address and incarnation of every document it creates, changes, or retires, with
	 * the scope of every incarnation it creates or retires.
	 */
	// 返回本提交写入的所有键：表记录键 + 每个文档的地址键/incarnation 键（创建/退休时再加 scope 键）。
	// Session 用它登记“未发布写”，读取这些键的任务会等待本次发布。
	// 必须在 takeHeld() 之后调用：被吸收的 held 文档也算本次写。
	// 例：const keys = tx.writeKeys(); // 交给 Writer 登记未发布写
	writeKeys(): string[] {
		const keys: string[] = [];
		// 复用 keys.ts 的表键规则；函数把键 append 到传入数组，避免中间分配。
		tableKeys(this.#writes, keys);
		for (const plan of this.#plans) {
			// 只读且无内容写的计划不算写。
			if (plan.content === undefined && !plan.retire) continue;
			// 地址键覆盖“当前 incarnation”读取；incarnation 键覆盖按 ID 读取。
			keys.push(documentKey(plan.addressId), incarnationKey(plan.record.id));
			// 创建或退休会改变 scope 内的存活集合，扫描按 scope 键等待。
			if (plan.retire || !("createdAt" in plan.record)) keys.push(scopeKey(plan.record.scope));
		}
		return keys;
	}

	/** Stage a content write for an incarnation, before its retirement when it retires. */
	// 把 change 写插到同一文档的 retire 写之前：先落内容再退休。
	// 例：this.#insertBeforeRetirement({ type: "document.change", id, content });
	#insertBeforeRetirement(write: Extract<StorageWrite, { readonly type: "document.change" }>): void {
		const at = this.#writes.findIndex(
			(candidate) => candidate.type === "document.retire" && candidate.id === write.id,
		);
		// 找不到 retire 写就追加到末尾。
		if (at < 0) this.#writes.push(write);
		// 找到则 splice 插入，保持“内容在退休前”的顺序。
		else this.#writes.splice(at, 0, write);
	}

	/** Adopt every prepared change by pointer swap after Storage success and describe the publication. */
	// Storage 成功后的内存采纳：把每个 plan 的 prepared change 指针交换进 tracker，更新版本/增量计数，
	// 安装或驱逐缓存，并生成发布描述。输入 seq 是本次提交的提交序号。
	// 保证：每个 prepared 要么 adopt 要么 abort；创建的 incarnation 补 createdAt，退休的补 retiredAt。
	// 返回 observed（本次改动）与 stored（Storage 实际收到，可能含 held 更早的 op）。
	// 例：const { observed, stored } = tx.adopt(commitSeq);
	adopt(seq: Seq): AdoptedDocuments {
		const publications: DocumentCommitChange[] = [];
		// Only when the commit stored held changes: then what Storage got differs from what memory adopted.
		let stored: DocumentCommitChange[] | undefined;
		for (const plan of this.#plans) {
			// 有 createdAt 说明是已存在 incarnation；否则是本次创建。
			// in 运算符在运行时检查属性，也帮助 TS 收窄联合类型。
			const committed = "createdAt" in plan.record;
			// 新创建记录补上本次 seq 作为 createdAt；已存在记录直接复用。
			let record: DocumentRecord = committed ? (plan.record as DocumentRecord) : { ...plan.record, createdAt: seq };
			// 退休记录补 retiredAt；新创建又退休的记录两者都有。
			if (plan.retire) record = { ...record, retiredAt: seq };
			// 只有 loaded/created 计划有 change；fork-copy/retire-only 没有。
			const change = plan.change;
			// 处理追踪器的采纳与缓存更新。
			if (change !== undefined) {
				// 解构追踪器、已 prepare 结果、缓存条目和定义版本。
				const { tracker, prepared, loaded, version } = change;
				// A new incarnation is adopted unless it retires in the same commit; a loaded one only when it changed.
				// 新 incarnation 在同一次提交退休则不 adopt；已加载的仅在真有 op 时 adopt。
				if (loaded === undefined ? !plan.retire : prepared.ops.length > 0) tracker.adopt(prepared);
				// 无实际改动的 prepared 放弃，避免 tracker 保留空草稿。
				else prepared.abort();
				// 已加载 incarnation：更新版本与增量计数，不重新安装。
				if (loaded !== undefined) {
					// 迁移后版本推进；adopt 后内存值与新版本一致。
					if (loaded.storedVersion < version) loaded.storedVersion = version;
					// 只有实际写了 document.change 才推进增量计数；只读计划不动。
					if (plan.content?.type === "document.change") {
						// 写 base：增量链清零。
						if (plan.content.content.kind === "base") loaded.deltasSinceBase = 0;
						// 写 delta：增量计数加一，供下次 checkpointWhen 判断。
						else loaded.deltasSinceBase++;
					}
					// 新建且不退休的 incarnation 装入缓存。
				} else if (!plan.retire) {
					// 新缓存条目：storedVersion/valueVersion 都是当前定义版本，增量为 0。
					this.#host.install({
						addressId: plan.addressId,
						record,
						storedVersion: version,
						valueVersion: version,
						deltasSinceBase: 0,
						tracker,
					});
				}
			}
			// 退休已存在的 incarnation：仅当缓存仍指向同一 record 时驱逐。
			if (plan.retire && committed) this.#host.evict(plan.addressId, record.id);
			// 生成发布描述；不发布时返回 undefined。
			const publication = describe(plan, record);
			// 无发布（例如只读的 loaded 计划）。
			if (publication === undefined) continue;
			// 本次是否同时存储了更早的 held op。
			const held = plan.held;
			// 没有 held：同一发布同时给内部观察者和 observeCommits()。
			if (held === undefined) {
				publications.push(publication);
				// 若之前已经为 held 建立 stored 列表，当前发布也要追加；否则 observable 与 stored 共享同一数组。
				stored?.push(publication);
				continue;
			}
			// 第一次遇到 held 时才复制此前的 publications，产生“Storage 视角”的独立列表。
			// ??= 仅在左侧 null/undefined 时赋值。
			stored ??= [...publications];
			// 本次自己也有改动才向内部观察者发布；纯读取不发布。
			if (held.observed) publications.push(publication);
			// Only a document change of a loaded incarnation carries held operations; a retirement is published alone.
			// Storage 收到的 ops 是 held 在前、本次在后；退休发布不带 ops。
			stored.push(
				publication.type === "document" && publication.kind === "change"
					? { ...publication, ops: held.ops }
					: publication,
			);
		}
		// 没有 held 时两者是同一数组引用；有 held 时 stored 是独立列表。
		return { observed: publications, stored: stored ?? publications };
	}

	// 生成最终 StorageWrite[]：
	// 1) 把每个文档 entry 变成 plan；2) 拒绝分叉源写；3) 校验 owner；
	// 4) 校验任务替换仍合法并处理终态任务的文档退休；5) 解析文档发布归属；
	// 6) 对最新候选解析 submission 变更；7) 追加 submission/task/document 写，最后执行 checkpoint 谓词。
	// 任何校验失败都抛错，由 settleSuccess() abort 全部草稿。
	// 例：const writes = await this.#assemble();
	async #assemble(): Promise<StorageWrite[]> {
		// 本方法内多次使用，先取局部引用；它是 GatedStorage，读会等待未发布写。
		const storage = this.#host.storage;
		const plans = this.#plans;
		// planDocument 对尚未获取完成的 entry 返回 undefined（没有 target）。
		for (const document of this.#documents) {
			const plan = planDocument(document);
			if (plan !== undefined) plans.push(plan);
		}
		// 在写 Storage 前拒绝修改分叉源。
		this.#rejectForkSourceWrites(plans);
		// 新建所有者引用的任务必须仍可创建新工作。
		await this.#validateOwners();
		// replace 候选还要对已提交状态再校验一次。
		for (const [id, task] of this.#tasksById) {
			if (task.write?.kind !== "replace") continue;
			const committed = await this.#committedTask(id);
			// 已提交任务不存在：可能是对不存在 ID 的替换。
			if (committed === undefined) throw new Error(`Task ${id} does not exist`);
			// 已终态任务不能复活。
			if (committed.state.status === "terminal") throw new Error(`Task ${id} is already terminal`);
			if (committed.conversationId !== task.write.record.conversationId) {
				throw new Error(`Task ${id} cannot change conversations`);
			}
		}

		// Terminal settlement retires every task document, including ones created by this transaction.
		// 终态任务要退休其所有文档，包括本次提交里创建又终态的。
		const terminalTaskIds = new Set<TaskId>();
		// 只看候选写入的状态；只读过的任务不会进入终态集合。
		for (const task of this.#tasksById.values()) {
			if (task.write?.record.state.status === "terminal") terminalTaskIds.add(task.write.record.id);
		}
		if (terminalTaskIds.size > 0) {
			// 已安排退休的 incarnation ID，避免重复 retire 写。
			const retiring = new Set<DocumentId>();
			// 先把已有计划里的任务文档标为退休。
			for (const plan of plans) {
				const scope = plan.record.scope;
				if (scope.kind !== "task" || !terminalTaskIds.has(scope.taskId)) continue;
				// 无论内容是否变化，终态任务的所有文档都要退休。
				plan.retire = true;
				retiring.add(plan.record.id);
			}
			// 补登记未被计划覆盖的已提交文档；retiring 去重。
			// 箭头函数捕获内层 plans/retiring。
			const retire = (record: DocumentRecord): void => {
				// 已在计划中或已登记过。
				if (retiring.has(record.id)) return;
				// 只退休的计划：没有 content/change，adopt 时生成 retirement 发布。
				plans.push({ addressId: addressId(record), record, retire: true });
				retiring.add(record.id);
			};
			// 本次创建的任务没有历史文档，跳过扫描。
			for (const taskId of terminalTaskIds) {
				if (this.#tasksById.get(taskId)?.write?.kind === "create") continue;
				// The Session knows the documents of the tasks it created; any other task's are scanned.
				// 扫描前等待该任务 scope 的未发布写。
				const gate = this.#host.touch(scopeKey({ kind: "task", taskId }));
				if (gate !== undefined) await gate;
				// Session 认识自己创建的任务文档时直接使用，省一次扫描。
				const known = this.#host.taskDocuments(taskId);
				if (known !== undefined) {
					// 这些文档全部登记退休。
					for (const record of known) retire(record);
					continue;
				}
				let cursor: Cursor | undefined;
				// 不认识时从 Storage 分页扫描 current 文档；do/while 保证至少执行一次。
				do {
					const page = await storage.scanDocuments(
						{ scope: { kind: "task", taskId }, at: "current" },
						INTERNAL_SCAN_PAGE_SIZE,
						cursor,
						this.#context,
					);
					// 当前页的每个存活文档都要退休。
					for (const record of page.items) retire(record);
					cursor = page.next;
				} while (cursor !== undefined);
			}
		}

		// Resolve publication ownership before Storage admission so adoption remains synchronous.
		// 下面的循环解析每个会发布的计划的会话归属。
		for (const plan of plans) {
			// 只读的 loaded 计划不发布，不需要归属。
			if (!publishes(plan)) continue;
			const scope = plan.record.scope;
			// 会话文档直接使用其 scope。
			if (scope.kind === "conversation") plan.conversationId = scope.conversationId;
			// Session 文档没有会话归属，保持 undefined。
			if (scope.kind !== "task") continue;
			// 任务文档归属任务所在会话；取暂存行以复用解析结果。
			const task = this.#taskEntry(scope.taskId);
			if (task.publicationConversationId === undefined) {
				// 候选任务优先，否则读已提交；任务可能刚在本事务创建。
				const current = await this.#currentTask(scope.taskId);
				if (current !== undefined) task.publicationConversationId = current.conversationId;
			}
			// 写入解析结果；adopt() 不再访问 Storage。
			plan.conversationId = task.publicationConversationId;
		}

		// 对每个暂存变更找最新候选：本事务创建优先，否则读已提交。
		for (const { id, change } of this.#submissionChanges) {
			const current = this.#submissions.get(id) ?? (await storage.submission(id, this.#context));
			// 运行时校验：结算/放置的目标必须存在。
			if (current === undefined) throw new Error(`Submission ${id} does not exist`);
			// 状态机检查在这里发生；返回同引用表示无需改变。
			const next = applySubmissionChange(current, change);
			// 只保存真正变化的记录；后续变更继续基于最新候选。
			if (next !== current) this.#submissions.set(id, next);
		}

		// 注意：writes 与 #writes 是同一数组，下面会继续 push。
		const writes = this.#writes;
		// 所有 submission 候选按 Map 迭代顺序追加；Map 保持首次插入顺序。
		for (const value of this.#submissions.values()) writes.push({ type: "submission", value });
		for (const task of this.#tasksById.values()) {
			// 任务候选整条写入。
			if (task.write !== undefined) writes.push({ type: "task", value: task.write.record });
		}
		for (const plan of plans) {
			// checkpoint 谓词只对已加载 incarnation 的 delta 变更有意义。
			const change = plan.change;
			// checkpointWhen 可能抛错（例如测试里的 explosion），必须在所有其他校验之后执行。
			// Checkpoint predicates run last, after every validation.
			if (plan.content?.type === "document.change" && plan.content.content.kind === "delta" && change?.loaded) {
				const { prepared, version } = change;
				const info = { deltasSinceBase: change.loaded.deltasSinceBase };
				// 谓词返回 true：把 delta 换成完整 base 值；adopt() 时据此清零增量计数。
				// definition 一定存在（loaded plan 由 planDocument 填充）。
				if (change.definition!.checkpointWhen(prepared.value, prepared.ops, info)) {
					plan.content = { ...plan.content, content: { version, kind: "base", value: prepared.value } };
				}
			}
			// 内容写在退休写之前。
			if (plan.content !== undefined) writes.push(plan.content);
			// 退休写只带 incarnation ID。
			if (plan.retire) writes.push({ type: "document.retire", id: plan.record.id });
		}
		// 返回的数组就是 #writes；Session 之后还会调用 writeKeys() 读取它。
		return writes;
	}

	// ─── Helpers ────────────────────────────────────────────────────────────

	/**
	 * New owned work needs a live owner, judged on the owner's final candidate: not `completing`, terminal, or
	 * abort-marked. A task therefore cannot create owned work in the commit that finishes it (spec §5.5).
	 */
	// 校验所有“新拥有工作的 owner”仍然存活：owner 任务存在、非 terminal/completing、未被 abort 标记。
	// 依据 owner 的最终候选记录判断（同一事务里先把 owner 写成终态，就不能再建子任务/归属会话）。
	// 例：await this.#validateOwners();
	async #validateOwners(): Promise<void> {
		// 收集待检查的 owner；what 只用于错误消息。
		const owners: { readonly what: string; readonly taskId: TaskId }[] = [];
		// 会话归属：conversation.owner 引用任务。
		for (const write of this.#writes) {
			if (write.type !== "conversation" || write.value.owner === undefined) continue;
			// owner 在这个分支里一定存在；TS 通过前一行 continue 收窄。
			owners.push({ what: "Conversation owner task", taskId: write.value.owner.taskId });
		}
		// 任务归属：本次创建的子任务引用 owner。
		for (const task of this.#tasksById.values()) {
			const record = task.write?.kind === "create" ? task.write.record : undefined;
			// 只有 create 候选才会创建新任务；replace 不改变 owner。
			if (record?.owner !== undefined) owners.push({ what: "Task owner", taskId: record.owner });
		}
		// 逐个重新读取 owner 的最新候选，确保同一事务里的写入生效。
		for (const { what, taskId } of owners) {
			const task = await this.#currentTask(taskId);
			// 运行时检查：类型只保证 TaskId 编号，不保证任务存在。
			if (task === undefined) throw new Error(`${what} ${taskId} does not exist`);
			// completing/terminal 的任务不能再拥有新工作。
			if (task.state.status === "terminal" || task.state.status === "completing") {
				throw new Error(`${what} ${taskId} is ${task.state.status}`);
			}
			// abort 标记后不允许创建归属工作，避免与取消竞争。
			if (task.abortRequested) throw new Error(`${what} ${taskId} is abort-marked`);
		}
	}

	// 禁止在同一分叉事务里修改源数据：否则副本可能基于已被本事务改动的源，语义不确定。
	// 例：this.#rejectForkSourceWrites(plans);
	#rejectForkSourceWrites(plans: readonly DocumentPlan[]): void {
		for (const plan of plans) {
			// 只读计划不改源，允许。
			if (plan.content === undefined && !plan.retire) continue;
			const record = plan.record;
			// 分叉复制出的源文档不可写，即使写的是同一逻辑地址的新 incarnation 也以其 ID 判断。
			if (this.#forkSourceDocumentIds.has(record.id)) {
				throw new Error(`Cannot change fork source document ${record.id} in the fork transaction`);
			}
			const scope = plan.record.scope;
			// 源会话的 current 策略文档不可改；asOf 副本已按条目时点取好，改它没有意义且会破坏一致性。
			if (
				scope.kind === "conversation" &&
				this.#forkSourceConversationIds.has(scope.conversationId) &&
				record.scope.kind === "conversation" &&
				record.fork === "current"
			) {
				throw new Error(
					`Cannot fork conversation ${scope.conversationId} while changing its current-policy documents`,
				);
			}
		}
	}

	// abort 所有已开始的 change；由 settleFailure/discard/结算失败调用。
	// 例：this.#abortChanges();
	#abortChanges(): void {
		for (const document of this.#documents) document.change?.abort();
	}

	// 结算后任何 API 调用都抛错；这是运行时状态检查，TS 无法表达。
	// 例：this.#assertOpen(); // 结算后抛 "Transaction has settled"
	#assertOpen(): void {
		if (this.#sealed) throw new Error("Transaction has settled");
	}

	// 任务文档的运行时准入：本事务已把任务写成 terminal 时，不允许再获取/修改其文档。
	// 检查的是本事务的候选状态，不是 Storage 里的已提交状态。
	// 例：this.#assertTaskDocumentsOpen(resolvedAddress);
	#assertTaskDocumentsOpen(resolved: ResolvedAddress): void {
		const scope = resolved.address.scope;
		// 可选链逐层取值：没有暂存行/没有 write 时条件为 false。
		if (scope.kind === "task" && this.#tasksById.get(scope.taskId)?.write?.record.state.status === "terminal") {
			throw new Error(`Task ${scope.taskId} is terminal`);
		}
	}

	/** Register an operation so callback settlement can reject and drain it. */
	// 登记一个异步操作，返回同一个 Promise。settleSuccess() 要求集合为空；
	// settleFailure() 用 allSettled 等它们结束。then 的两个回调都删除登记项，成功失败都清理。
	// 例：const loading = this.#track(this.#host.load(definition, addressId, address, context));
	#track<T>(operation: Promise<T>): Promise<T> {
		this.#pendingOperations.add(operation);
		// 结算回调：只负责从集合中移除，不改变 Promise 的结果。
		const settle = (): void => {
			this.#pendingOperations.delete(operation);
		};
		// 同时处理 fulfilled/rejected；返回的新 Promise 被丢弃，但 settle 不会抛错。
		operation.then(settle, settle);
		return operation;
	}

	// 表读统一入口：检查未结算、未发生表写（否则 ReadAfterWrite），并登记 Promise。
	// 错误转为 rejected Promise 而不是同步 throw，调用方始终可以 await。
	// method 只用于错误消息，指明是哪个 Tx 方法触发了顺序错误。
	// 例：return this.#read("task", () => this.#committedTask(id));
	#read<T>(method: string, read: () => Promise<T>): Promise<T> {
		try {
			this.#assertOpen();
			// 先读后写规则：首次表写之后，普通表读会破坏事务的一致性视图。
			if (this.#hasTableWrite) throw new ReadAfterWrite(`Tx.${method}()`);
			return this.#track(read());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// 表写统一入口：检查未结算，立即置 hasTableWrite，再登记异步写入。
	// 置位发生在回调执行前，所以同一回调里后续表读会被拒绝。
	// 例：return this.#write(async () => this.#appendEntry(conversationId, value));
	#write<T>(write: () => Promise<T>): Promise<T> {
		try {
			this.#assertOpen();
			this.#hasTableWrite = true;
			return this.#track(write());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// 会话存在性：先看本事务刚创建的集合，避免读尚未提交的记录。
	// 例：await this.#requireConversation(conversationId);
	async #requireConversation(id: ConversationId): Promise<void> {
		// 本事务创建的会话一定存在，无需 Storage 读。
		if (this.#createdConversationIds.has(id)) return;
		if ((await this.#host.storage.conversation(id, this.#context)) === undefined) {
			throw new Error(`Conversation ${id} does not exist`);
		}
	}

	/**
	 * Lifecycle times: `startedAt` on the first change to `running`, `endedAt` on the change to `terminal`. Once set,
	 * they carry over from the replaced record; records written before they existed lack them.
	 */
	// 任务生命周期时间戳：startedAt 只在首次进入 running 时写；endedAt 只在进入 terminal 时写。
	// 一旦 candidate 或 value 已有时间戳就沿用；旧版本记录可能两者都缺。
	// now 只在需要盖章时调用一次，避免不必要的时钟读取。
	// 例：const record = this.#stampTimes(value, candidate);
	#stampTimes(value: AnyTaskRecord, candidate: AnyTaskRecord | undefined): AnyTaskRecord {
		// 只看本次候选状态；running/terminal 是盖章条件。
		const status = value.state.status;
		// 小工具：条件成立时才读时钟；不成立返回 undefined。
		const now = (stamps: boolean) => (stamps ? this.#host.now() : undefined);
		// 优先级：已有候选时间戳 > 传入值 > 本次是否首次 running。
		// ?? 会把 undefined 当作缺失，因此 0 也会被保留。
		const startedAt = candidate?.startedAt ?? value.startedAt ?? now(status === "running");
		// 同上；endedAt 只在 terminal 时盖章。
		const endedAt = candidate?.endedAt ?? value.endedAt ?? now(status === "terminal");
		// 无需补时间戳时返回原引用，避免多余复制。
		if (startedAt === value.startedAt && endedAt === value.endedAt) return value;
		// 只包含已定义的字段，保持严格 JSON（不写 undefined）。
		return {
			...value,
			...(startedAt === undefined ? {} : { startedAt }),
			...(endedAt === undefined ? {} : { endedAt }),
		};
	}

	// 取或创建任务的暂存行；同一事务共享 committedRead/write。
	// 例：const task = this.#taskEntry(taskId);
	#taskEntry(id: TaskId): TransactionTask {
		let task = this.#tasksById.get(id);
		if (task === undefined) {
			task = {};
			this.#tasksById.set(id, task);
		}
		return task;
	}

	/** Latest candidate task record, falling back to committed state; not a caller table read. */
	// 最新候选优先，否则回退到已提交读取；这不是“调用方表读”，所以不受 ReadAfterWrite 限制。
	// 例：const task = await this.#currentTask(taskId);
	async #currentTask(id: TaskId): Promise<AnyTaskRecord | undefined> {
		return this.#tasksById.get(id)?.write?.record ?? (await this.#committedTask(id));
	}

	// 记忆化 committedRead：同一事务只读一次 Storage。
	// 例：const task = await this.#committedTask(taskId);
	#committedTask(id: TaskId): Promise<AnyTaskRecord | undefined> {
		const task = this.#taskEntry(id);
		task.committedRead ??= this.#host.storage.task(id, this.#context);
		return task.committedRead;
	}
}

/** Plan of one staged document: its record, content write, and prepared change. Retirement is decided later. */
// 把一个已完成的 DocumentEntry 转成 DocumentPlan；entry 还没找到 target 时返回 undefined。
// created：写 document.create + base 内容；fork-copy：写 document.copy；retire-only：只记录；
// loaded：按版本/op 决定写 base、delta 还是不写内容。
// 例：const plan = planDocument(document); // target 未就绪时返回 undefined
function planDocument(document: DocumentEntry): DocumentPlan | undefined {
	// 尚未完成获取/退休查找的 entry 不产生计划。
	const target = document.target;
	if (target === undefined) return undefined;
	// 公共字段：地址与是否退休；各分支补充 record/content/change。
	const plan = { addressId: document.addressId, retire: document.retireOnCommit };
	// 判别联合收窄：每个 case 内 target 的具体字段可用。
	switch (target.kind) {
		// 新建 incarnation：prepared 一定存在（settleSuccess 已同步 prepare）。
		case "created": {
			const prepared = document.prepared!;
			const { record, version, tracker } = target;
			// 新文档的初始内容一定是完整 base。
			const content = { version, kind: "base", value: prepared.value } as const;
			return {
				...plan,
				record,
				// create 写携带完整初始值。
				content: { type: "document.create", record, content },
				// change 用于 adopt 新 tracker；没有 loaded。
				change: { tracker, prepared, version },
			};
		}
		// 复制不需要 prepared；Storage 物化源值。
		case "fork-copy":
			return {
				...plan,
				record: target.record,
				content: { type: "document.copy", record: target.record, source: target.source },
			};
		// 只记录已提交记录，assemble 末尾追加 retire 写。
		case "retire-only":
			return { ...plan, record: target.record };
		// 已加载 incarnation：可能写 base（迁移）或 delta（普通改动），也可能不写。
		case "loaded": {
			const loaded = target.document;
			const definition = document.definition!;
			const prepared = document.prepared!;
			// 定义版本是本次要写入的目标版本；loaded.storedVersion 是旧版本。
			const version = definition.version;
			const id = loaded.record.id;
			// 版本变化即使没有 op 也写 base，让旧形状的观察者收到新值；否则只有 op 非空才写 delta。
			// 条件表达式嵌套：先判迁移，再判 op；否则不写内容。
			// A version change stores a base even without operations; otherwise only a change stores a delta.
			const content =
				loaded.storedVersion < version
					? ({ type: "document.change", id, content: { version, kind: "base", value: prepared.value } } as const)
					: prepared.ops.length > 0
						? ({ type: "document.change", id, content: { version, kind: "delta", ops: prepared.ops } } as const)
						: undefined;
			// 已加载计划的 change 包含 tracker/prepared/version/loaded/definition，供 adopt/checkpoint 使用。
			const change = {
				tracker: loaded.tracker,
				prepared,
				version,
				loaded,
				definition,
			};
			// 没有内容写时省略 content 字段（而不是写 undefined）。
			return { ...plan, record: loaded.record, change, ...(content === undefined ? {} : { content }) };
		}
	}
}

/** The publication of one adopted plan, if it publishes (`publishes()`), with `record` as committed. */
// 为 adopt() 生成一条发布描述；不发布时返回 undefined。
// 退休 → retire；fork-copy → document.copy；已加载且无内容写 → 不发布；
// 新创建/有内容写的已加载 → document.change，创建时 ops 为空。
// 例：const publication = describe(plan, committedRecord);
function describe(plan: DocumentPlan, record: DocumentRecord): DocumentCommitChange | undefined {
	// assemble 已解析；Session 文档为 undefined。
	const conversationId = plan.conversationId;
	// 退休发布只带记录，不带值/ops。
	if (plan.retire) return { type: "document", kind: "retire", record, conversationId };
	// fork-copy 发布为 document.copy，消费者通过 watch 重新获取值。
	if (plan.content?.type === "document.copy") {
		return { type: "document.copy", record, conversationId: conversationId!, source: plan.content.source };
	}
	const change = plan.change;
	// loaded 且没有内容写时不发布；fork-copy 的 change 是 undefined 但上面已处理。
	if (change === undefined || !publishes(plan)) return undefined;
	// 新创建的文档没有“基于旧值”的 op；已加载文档用 prepared.ops。
	const ops = change.loaded === undefined ? EMPTY_OPERATIONS : change.prepared.ops;
	return {
		type: "document",
		kind: "change",
		record,
		conversationId,
		version: change.version,
		value: change.prepared.value,
		ops,
	};
}

/**
 * Take a hold's changes after `ops`, a commit's own on top of them, as one stored content for an incarnation now at
 * `value`, and the operations a reader of the stored state applies to reach it: the folded ones, or a root replacement
 * after the queue overflowed, which stores a base, as does a hold whose commits selected one.
 */
// 把 hold.pending 与本次提交的 ops 合并成一条可存储内容：
// - 队列溢出（take 返回 replace）→ 写完整 base，并给读者一个根替换 op；
// - hold.base（更早的提交选了 base）→ 本次也必须写 base；
// - 否则写 delta。
// 返回 content 供 StorageWrite 使用，ops 是读者从旧存储值重放到新值所需的操作
// （根替换时是 [["r", value]]）。
// 例：const { content, ops } = storeHeld(hold, prepared.ops, value, version);
export function storeHeld(
	hold: HeldDocument,
	ops: readonly Op[],
	value: JsonObject,
	version: number,
): { readonly content: DocumentContent; readonly ops: readonly Op[] } {
	// 先追加本次提交的 op；push 不会修改传入数组，必要时折叠。
	hold.pending.push(ops);
	// take() 清空并返回 PendingTake 判别联合：ops 或 replace。
	const taken = hold.pending.take();
	// 溢出后只保留“用当前值替换根”；content 写 base，读者重放一条 r op。
	// [["r", value]] 是 Op 联合中的根替换。
	if (taken.kind === "replace") return { content: { version, kind: "base", value }, ops: [["r", value]] };
	// 更早的 hold 选了 base：本次存储也必须写 base，但读者仍需重放折叠后的 ops。
	if (hold.base) return { content: { version, kind: "base", value }, ops: taken.ops };
	// 普通情况：content 与读者重放使用同一批 delta op。
	return { content: { version, kind: "delta", ops: taken.ops }, ops: taken.ops };
}

/**
 * Whether adoption publishes the plan: every creation, copy, and retirement, and a loaded incarnation that writes
 * content, which includes a migration-only base so observers of the older shape receive the new value.
 */
// 是否发布该 plan：退休、创建/复制（loaded 为 undefined）、以及有内容写的已加载文档都发布。
// 迁移时即使没有 op 也写 base，因此也要发布，让旧形状观察者收到新值。
// 例：if (publishes(plan)) publications.push(describe(plan, record)!);
function publishes(plan: DocumentPlan): boolean {
	// 可选链：change 不存在时 `?.loaded` 为 undefined，视为“非 loaded”（创建/复制）。
	return plan.retire || plan.change?.loaded === undefined || plan.content !== undefined;
}
