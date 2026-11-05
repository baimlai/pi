// 文件导读：Session 提交线的键与门控 Storage
//
// 所属包与模块：packages/durable/src/session，Durable（@earendil-works/pi-durable）的 Session 内核。
// 本文件定义“提交线”的字符串键：每个可能在写入后立即被读取的记录或范围都有一个键。Writer 把未发布的提交登记到
// 这些键上，任务读取前通过 Session.touch(key) 等待该键最新的写入发布；GatedStorage 把同一规则包装进 Storage
// 读接口。这样即使提交还在内存队列里，后续读取也不会看到后端的旧状态。本文件不执行提交、不缓存记录，也不决定
// 发布顺序。
//
// 上游入口：Transaction 准备提交时用 tableKeys()（以及文档地址相关的 documentKey/incarnationKey/scopeKey）
// 收集本次写入的键，Writer 把这些键登记为未发布；Session 构造 GatedStorage 后交给任务和 readOnLine 使用。
// 下游依赖：src/types.ts 的 Storage 接口、记录与查询类型；addressId() 把文档逻辑地址变成稳定字符串。
// 错误流向：键函数本身不抛错；GatedStorage 的读取错误来自底层 Storage，或来自 touch 返回的门 Promise（会话失败时），
// 两种情况都原样拒绝调用方的读取 Promise。
//
// 能力清单（按导出项）：
//   - taskKey/conversationKey/entryKey/submissionKey：单条表记录键（task:/conv:/entry:/sub:）。
//   - appendKey：会话追加流键（entry-append:<conversationId>），追加写影响最新条目、扫描和 head 标记。
//   - requestKey：会话内 requestId 去重键（req:<conversationId>:<requestId>）。
//   - documentKey：文档逻辑地址键（doc:<addressId>），地址的当前 incarnation、值或挂起变更变化时使用。
//   - incarnationKey：文档具体 incarnation 键（docid:<DocumentId>），按 ID 精确读取时使用。
//   - scopeKey：文档 scope 内存活 incarnation 集合键（session/conversation/task 三种格式）。
//   - ownedKey：调度器所有权树节点键；ROOTS_KEY/INTENT_KEY 分别表示无主会话根集合和取消意图集合。
//   - ALL_KEYS：无法按键的扫描使用的通配键，等待所有未发布写入。
//   - tableKeys(writes, keys)：把一批写入里表记录的键追加到调用方数组；文档键由 Transaction 另行补充。
//   - GatedStorage：实现 Storage 的包装器，读前先 touch 对应键，提交/mintId/close 直接透传。
//   - StoredEntry（文件私有）：entry() 的返回类型，包含条目记录和写入它的提交序号。
//
// 典型用法（示例）：
//   const keys: string[] = [];
//   tableKeys(writes, keys); // 若 writes 含会话 1 的 entry 7，则 keys 至少含 "entry:7" 和 "entry-append:1"
//   const gated = new GatedStorage(rawStorage, (key) => session.touch(key));
//   const stored = await gated.entry(conversationId, entryId, context);
//   // gated 先等待该条目/会话的未发布写入，再调用 rawStorage.entry；没有未发布写入时直接读。
//   注意：键只是字符串，不含运行时校验；不同标识通过固定前缀和分隔符区分。
//
// 建议阅读顺序：先读键构造函数与三个特殊常量，理解命名规则；再读 tableKeys 看提交写入如何映射到键；
// 然后读 GatedStorage 的字段和读方法，最后读底部的 #afterEntries/#after 理解等待时序。
//
// ---------------------------------------------------------------------------
// The keys of the Session line: what a commit writes and a job reads, so a read of an unpublished write waits for it.
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { addressId } from "../documents.ts";
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

// entry() 的返回值：entry 是不可变条目记录，commitSeq 是写入该条目的提交序号（分叉时用来取 asOf 文档）。
// 这是纯类型别名，编译期约束字段；运行时不会检查 Storage 返回的对象是否符合它。
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };

// 任务记录键：输入带品牌的 TaskId，返回 `task:<id>`；纯函数，不读存储、无副作用、无错误分支。
// 示例：ID 为 2 的任务得到 "task:2"；Writer 用它登记未发布的任务写入。
/** A task record. */
export function taskKey(id: TaskId): string {
	return `task:${id}`;
}

// 会话记录键：输入 ConversationId，返回 `conv:<id>`；用于等待会话创建/更新的发布。
// 示例：conversationKey(idFromNumber<ConversationId>(5)) === "conv:5"。
/** A conversation record. */
export function conversationKey(id: ConversationId): string {
	return `conv:${id}`;
}

// 单条条目键：输入 EntryId，返回 `entry:<id>`；按精确条目读取/更新时使用。
// 追加条目还会同时登记 appendKey（见 tableKeys），因为扫描和最新条目读取不知道具体 ID。
// 示例：entryKey(idFromNumber<EntryId>(7)) === "entry:7"。
/** An entry record. */
export function entryKey(id: EntryId): string {
	return `entry:${id}`;
}

// 会话追加流键：输入 ConversationId，返回 `entry-append:<id>`；一个会话的所有追加共享它。
// “blind append” 指写入条目前不读取会话尾部；因此扫描、最新条目和 head 标记读取必须先等这个键，
// 否则可能看不到刚追加但尚未发布的条目。
// 示例：会话 1 的追加键为 "entry-append:1"；GatedStorage.#afterEntries 会连续等待会话键和它。
/** The newest entries of a conversation: appended blind, read by scans, the newest entry, and head markers. */
export function appendKey(id: ConversationId): string {
	return `entry-append:${id}`;
}

// 提交记录键：输入 SubmissionId，返回 `sub:<id>`；按提交 ID 读取或等待其状态变化时使用。
// 示例：提交 12 的键为 "sub:12"；纯字符串拼接，不访问存储。
/** A submission record. */
export function submissionKey(id: SubmissionId): string {
	return `sub:${id}`;
}

// 请求去重键：同一会话内用户提供的 requestId 唯一，键为 `req:<conversationId>:<requestId>`。
// requestId 是任意字符串，可能含冒号；固定前缀和会话 ID 在前，仍能保证不同会话不混淆。
// 示例：会话 1、requestId "abc" 得到 "req:1:abc"；submissionByRequest 用它等待对应提交发布。
/** The submission a conversation's request ID names. */
export function requestKey(conversationId: ConversationId, requestId: string): string {
	return `req:${conversationId}:${requestId}`;
}

// 文档逻辑地址键：参数是 addressId(address) 的结果（kind/scope/key 组成的稳定字符串），返回 `doc:<addressId>`。
// 一个地址的当前 incarnation、物化值或挂起变更改变时都登记这个键；读取当前文档前等待它。
// 示例：地址字符串 "note/c1/x" 得到 "doc:note/c1/x"；地址本身不含 incarnation ID。
/** A document address (`addressId()`): its current incarnation, value, and held changes. */
export function documentKey(addressId: string): string {
	return `doc:${addressId}`;
}

// 文档代际键：输入具体 DocumentId（某一代 incarnation），返回 `docid:<id>`；按 ID 精确读取历史版本时使用。
// 它与 documentKey 不同：地址会指向新的 incarnation，而同一 incarnation 的内容/生命周期按这个键等待。
// 示例：文档 ID 为 9 时键为 "docid:9"。
/** A document incarnation, for reads by its ID. */
export function incarnationKey(id: DocumentId): string {
	return `docid:${id}`;
}

// scope 集合键：表示某个 scope（session、conversation、task）里存活 incarnation 的集合。
// 创建和退休都会登记它；扫描文档和任务文档索引按 scope 读取，因此必须先等集合变化发布。
// 输入是 DocumentRecord["scope"] 判别联合；返回字符串，纯函数。示例见下面三个分支。
/** The incarnations alive in a scope: created and retired blind, read by scans and the task-document index. */
export function scopeKey(scope: DocumentRecord["scope"]): string {
	// 按判别字段 kind 收窄联合类型；三个分支覆盖了类型上的全部成员，所以不需要 default。
	// 运行时若收到非法 scope（不在 Storage 契约内），switch 不会命中，函数会落到末尾返回 undefined；这里不做防御检查。
	switch (scope.kind) {
		// session scope 没有额外 ID，所有 Session 级文档共用一个固定键。
		case "session":
			return "docscope:session";
		// conversation 分支里 TypeScript 已把 scope 收窄为带 conversationId 的成员；前缀 c 避免不同 scope 类型撞键。
		case "conversation":
			return `docscope:c${scope.conversationId}`;
		// task 分支同理，用 t 前缀加 TaskId；示例：会话 5 -> "docscope:c5"，任务 9 -> "docscope:t9"。
		case "task":
			return `docscope:t${scope.taskId}`;
	}
}

// 所有权树节点键：输入 TaskId 或字符串（根会话节点用 `c<conversationId>`），返回 `owned:<node>`。
// 调度器把任务创建/终结时要更新的所有权链节点登记到这些键；所有展开该节点的遍历读取前都会等待。
// TaskId | string 是编译期联合类型；运行时都按字符串拼接，不做格式校验。
// 示例：任务 3 的节点键为 "owned:3"，会话 5 的根节点键为 "owned:c5"。
/**
 * A node of the scheduler's ownership tree (a task ID, or `c<conversation ID>`): the live work listed below it. Written
 * by task creation and a task becoming terminal for every node from the task's parent up to and including the nearest
 * live task or the root conversation; read by every walk that expands the node.
 */
export function ownedKey(node: TaskId | string): string {
	return `owned:${node}`;
}

// 固定键 "roots"：表示“其下仍有活工作的无主会话”集合；调度器全局空闲遍历从这里开始。
// 它是集合级键，不对应单条记录；任何增删根集合的提交都要登记它。
/** The ownerless conversations with live work below them, which global idle walks from. */
export const ROOTS_KEY = "roots";

// 固定键 "intent"：表示带取消意图的活任务集合（abort 标记，以及非 completed 的已持有结果）。
// 取消查询读取这个集合前会等待；调度器在意图变化时登记该键。
/** The live tasks with cancellation intent: abort marks, and held outcomes other than `completed`. */
export const INTENT_KEY = "intent";

// 通配键 "*"：无法确定单条键的读（扫描）使用它；Session.touch 对 ALL_KEYS 特殊处理，等待所有未发布写入。
// 它不是普通字符串键，不能用来登记具体写入；Writer 和 Session 的语义都依赖这个特殊值。
/** Every unpublished write: what a read that cannot be keyed, such as a scan, touches. */
export const ALL_KEYS = "*";

// 把一批 StorageWrite 里“表记录”的键追加到 keys；返回 void，副作用是原地修改调用方数组。
// 文档写入故意不在这里处理：Transaction 掌握文档地址、incarnation 和 scope，由它补充文档键。
// 不检查重复，也不排序；Writer 的 Map 会按最后一次登记处理同一键。
// 示例：writes 为会话 1 的 entry 7 时，keys 追加 ["entry:7", "entry-append:1"]。
/** The keys of the table records in `writes`; document writes are keyed by the transaction, which knows addresses. */
export function tableKeys(writes: readonly StorageWrite[], keys: string[]): void {
	// 按写入顺序遍历；每个 write 都是 StorageWrite 判别联合，下面 switch 用 type 收窄 value 的具体类型。
	for (const write of writes) {
		// 只为四种表记录生成键；document.create/copy/change/retire 落到 switch 之外且不报错，这是有意留白。
		switch (write.type) {
			// 会话记录只需等待自身 ID 的键。
			case "conversation":
				keys.push(conversationKey(write.value.id));
				break;
			// 条目写入影响两个读取面：精确条目（entryKey）和会话追加流（appendKey）。
			// keys.push 一次追加两个字符串；这里不复制数组。
			case "entry":
				keys.push(entryKey(write.value.id), appendKey(write.value.conversationId));
				break;
			// 任务记录按任务 ID 等待；调度器的任务读取会 touch 同一个键。
			case "task":
				keys.push(taskKey(write.value.id));
				break;
			// 提交记录先登记自身 ID；requestId 是可选的去重键。
			case "submission":
				keys.push(submissionKey(write.value.id));
				// 只有带 requestId 的提交才登记去重键；此判断是运行时检查，因为该字段在类型上可选。
				// 非空字符串仍是调用方约定，这里不做格式校验。
				if (write.value.requestId !== undefined) {
					keys.push(requestKey(write.value.conversationId, write.value.requestId));
				}
				break;
		}
	}
}

// GatedStorage：Storage 的门控包装器，供 Session 线上的任务读取使用。
// 每个读方法先调用注入的 touch(key)：返回 Promise 表示该键有未发布写入，要等它发布；返回 undefined 表示可以直接读。
// 无法按键的扫描使用 ALL_KEYS，等待所有未发布写入；提交、mintId 和 close 不门控，直接转发。
// 它不缓存、不重试、不吞错；底层错误和门 Promise 的拒绝都会传给调用方。
// 示例：见本文件头部“典型用法”；构造时保存底层 Storage 和 touch 回调。
/**
 * The Storage a job on the line reads through: every read first touches its key (`touch`), which waits while the key
 * has an unpublished writer, so the read sees what the line admitted before it. Scans that cannot be keyed touch
 * `ALL_KEYS`. Commits and `close()` pass through; the line never commits through it.
 */
export class GatedStorage implements Storage {
	// 底层真实 Storage；所有实际 IO 都转发给它。`#` 表示 ECMAScript 私有字段，类外无法访问。
	readonly #storage: Storage;
	// touch 回调由 Session 注入：返回门 Promise 表示需要等待，返回 undefined 表示没有未发布写入。
	// GatedStorage 不解释键含义，只把本类选好的键交给回调；因此键规则集中在本文件上半部分。
	readonly #touch: (key: string) => Promise<void> | undefined;

	// 构造器保存两个依赖，不执行 IO。参数顺序是底层 storage、touch 回调；两者都由 Session 提供。
	// 示例：new GatedStorage(raw, (key) => session.touch(key))。
	constructor(storage: Storage, touch: (key: string) => Promise<void> | undefined) {
		this.#storage = storage;
		this.#touch = touch;
	}

	// 提交直接透传到底层 Storage，不 touch 任何键：提交顺序由 Session 的 Writer/Transaction 负责，
	// 而 GatedStorage 只约束“读取者等待未发布写入”。返回底层 Promise，不额外 await 或包装错误。
	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult> {
		return this.#storage.commit(batches, receive, context);
	}

	// ID 铸造直接透传；泛型 I 保留调用方要求的品牌类型，运行时仅返回数字 ID，不做类型检查。
	// mintId 失败在 Storage 契约中是致命错误，GatedStorage 原样返回拒绝的 Promise。
	mintId<I extends Id<string>>(): Promise<I> {
		return this.#storage.mintId<I>();
	}

	// 读会话：先等待该会话的 conv 键发布，再调用底层 conversation。命中缓存或无未发布写入时 gate 为 undefined。
	// 返回底层结果或错误；示例：等待 "conv:5" 后读到会话 5。
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		return this.#after(conversationKey(id), () => this.#storage.conversation(id, context));
	}

	// 扫描会话列表无法映射到单条记录，因此 touch ALL_KEYS，等待所有未发布写入。
	// 分页参数 cursor 原样转发；底层拒绝（非法游标等）会传给调用方。
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.#after(ALL_KEYS, () => this.#storage.scanConversations(query, limit, cursor, context));
	}

	// entry 有两个重载：先声明“按全局条目 ID 读取”，再声明“按会话可见性读取”。
	// 重载只在编译期选择签名；运行时统一进入下面的实现，由第三个参数是否存在区分。
	entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	// 可见性重载：同一 ID 只有能通过该会话祖先链看到时才返回；读取前要先等会话创建和条目写入发布。
	entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	// 实现签名用联合类型接收两种调用；返回 StoredEntry | undefined。
	// 调用方若传错误参数组合，TypeScript 会在重载处报错；实现内部没有运行时 schema 校验。
	entry(
		first: EntryId | ConversationId,
		second: EntryId | Context,
		third?: Context,
	): Promise<StoredEntry | undefined> {
		// 第三个参数是运行时判别：没有 context 表示两参数的全局读取重载。
		if (third === undefined) {
			// 实现签名中 first 是 EntryId | ConversationId；此处断言为 EntryId，`as` 只影响编译期，不转换值。
			const id = first as EntryId;
			// 只等待条目自身的 entry 键；没有会话参数，所以不需要检查会话创建。
			// 回调延迟到底层读取，确保门 Promise 完成前不发起 IO。
			return this.#after(entryKey(id), () => this.#storage.entry(id, second as Context));
		}
		// 有第三个参数时，first/second 分别是 ConversationId 和 EntryId；两个 as 同样只是给联合类型补上收窄信息。
		const conversationId = first as ConversationId;
		// 这里的 second 已由调用形态确定为 EntryId；运行时值仍是原参数。
		const id = second as EntryId;
		// 嵌套 #after 的顺序很重要：先等会话创建发布，再等条目写入发布；否则底层可能因会话尚不存在而拒绝读取。
		// Visibility follows the conversation's immutable ancestry; the conversation may be unpublished itself.
		// 外层门等待会话键；内层门等待条目键。两个门都通过后，才真正调用 storage.entry(conversationId, id, context)。
		return this.#after(conversationKey(conversationId), () =>
			this.#after(entryKey(id), () => this.#storage.entry(conversationId, id, third)),
		);
	}

	// 读会话最新 head 标记：使用 #afterEntries，同时等待会话创建和追加流；atOrBeforeEntryId 是包含式截止 ID。
	// 返回 EntryRecord 且保证 head 存在，或 undefined；Storage 的请求错误原样传播。
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.#afterEntries(conversationId, () =>
			this.#storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context),
		);
	}

	// 扫描会话条目同样依赖追加流，所以使用 #afterEntries(query.conversationId)；limit/cursor 原样转发。
	// 示例：读取会话 1 的最近条目时，先等 "conv:1" 和 "entry-append:1"。
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.#afterEntries(query.conversationId, () => this.#storage.scanEntries(query, limit, cursor, context));
	}

	// 读任务：等待 task 键发布后转发；返回任务记录或 undefined，底层错误原样拒绝。
	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
		return this.#after(taskKey(id), () => this.#storage.task(id, context));
	}

	// 任务扫描无法按键，touch ALL_KEYS；查询条件和分页参数原样交给底层。
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
		return this.#after(ALL_KEYS, () => this.#storage.scanTasks(query, limit, cursor, context));
	}

	// 读提交：等待 sub 键；返回提交记录或 undefined，错误原样传播。
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		return this.#after(submissionKey(id), () => this.#storage.submission(id, context));
	}

	// 提交扫描无法按键，等待所有未发布写入（ALL_KEYS）；其余参数直接转发。
	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.#after(ALL_KEYS, () => this.#storage.scanSubmissions(query, limit, cursor, context));
	}

	// 按会话 + requestId 查提交：等待 req 键发布，再调用底层去重查询。
	// 返回提交记录或 undefined；requestId 不匹配或会话不存在都由底层决定。
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.#after(requestKey(conversationId, requestId), () =>
			this.#storage.submissionByRequest(conversationId, requestId, context),
		);
	}

	// 按逻辑地址查文档：先用 addressId(address) 得到稳定地址串，再等待 doc 键。
	// at 是提交序号或 "current"；返回文档记录或 undefined，错误原样传播。
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		return this.#after(documentKey(addressId(address)), () => this.#storage.findDocument(address, at, context));
	}

	// 按具体 incarnation ID 读文档版本：等待 docid 键，不等待逻辑地址的当前指向。
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		return this.#after(incarnationKey(id), () => this.#storage.document(id, at, context));
	}

	// 按 scope 扫描文档：等待该 scope 的集合键；scopeKey 会把三种 scope 映射成不同字符串。
	// 查询条件、分页和 at 时点原样转发；非法游标等由底层拒绝。
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.#after(scopeKey(query.scope), () => this.#storage.scanDocuments(query, limit, cursor, context));
	}

	// 关闭直接透传，不等待未发布写入：关闭是 Session 生命周期操作，不应被门控阻塞。
	// 返回底层 close 的 Promise；失败由调用方处理。
	close(context: Context): Promise<void> {
		return this.#storage.close(context);
	}

	// #afterEntries：读取会话条目前的组合门。先等会话创建（conv 键），再等追加流（entry-append 键），
	// 最后执行 read；嵌套顺序保证底层不会在会话尚未创建时收到读取。
	// 泛型 T 保留 read 的返回类型；read 只在两个门都通过后调用一次，门拒绝时不会执行。
	// 示例：scanEntries 用它等待会话 1 的创建和所有追加写入发布。
	/**
	 * Run a read of a conversation's entries once neither its appends nor its creation has an unpublished writer: Storage
	 * refuses the read of a conversation it does not have yet.
	 */
	#afterEntries<T>(conversationId: ConversationId, read: () => Promise<T>): Promise<T> {
		return this.#after(conversationKey(conversationId), () => this.#after(appendKey(conversationId), read));
	}

	// #after：单个键的通用门。touch 返回 undefined 时同步调用 read；返回 Promise 时用 .then(read) 延迟到发布后。
	// 它不捕获错误：门拒绝或 read 拒绝都会让返回的 Promise 拒绝。
	// read 必须是无副作用的延迟函数，因为它在门通过前不应发起 IO。
	// 示例：touch("task:2") 有门时，read() 在门 resolve 后的微任务中才执行。
	/** Run `read` once `key` has no unpublished writer. */
	#after<T>(key: string, read: () => Promise<T>): Promise<T> {
		const gate = this.#touch(key);
		return gate === undefined ? read() : gate.then(read);
	}
}
