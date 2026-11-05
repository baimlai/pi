/// <reference lib="dom" />
// 文件导读
// ========
// 所属：packages/durable/src/storage/indexeddb.ts，Durable Storage 契约的浏览器 IndexedDB 后端。
// 文件首行的 /// <reference lib="dom" /> 让 TypeScript 在 Node 类型环境中也能看到 IDB* 声明；
// 它不改变运行时，也不加载 polyfill。
//
// 解决的问题：浏览器中的 Session/Harness 需要一个持久化 Storage。IndexedDB 提供事务和索引，
// 本文件把 Storage 的批次提交、扫描与文档修订映射到 8 个 object store 和对应的复合索引上。
//
// 职责边界：实现 Storage 契约（原子提交、全局 ID 归属、不可变会话/条目、文档记录与修订一致性、
// 脱离式读取）。它不校验任务状态迁移或引用完整性（由 Session 负责），不做业务 JSON 的语义解析。
// 一个数据库同一时刻只应由一个 owner 串行访问；跨标签页并发不在本实现的保证范围内。
//
// 上游：应用从子路径 @earendil-works/pi-durable/storage/indexeddb 导入 IndexedDbStorage，
// 调用 open(name, { indexedDB }) 后交给 Harness/Session。下游：浏览器 IndexedDB API、
// chord/delta 的 apply（重放文档 delta）、本包 ids/errors/types 与 ./scan.ts 的分页辅助。
//
// 结果与错误：读取的请求级问题抛 StorageRequestError（未知会话、非法游标、历史读取被保留策略
// 拒绝）；IndexedDB 自身的 DOMException 会中止整个事务；Durable 自己的批次检查则以
// CommitResult.refused 返回，保留之前批次的写入。close 后所有方法抛普通 Error。
//
// 能力清单：
// - IndexedDbStorage（导出类）：open/delete 静态入口；commit/mintId 写路径；conversation/entry/
//   task/submission/document/findDocument/scan* 读路径；close 释放连接。
// - IndexedDbStorageOptions（导出类型）：可注入 IDBFactory，测试用 fake-indexeddb 即从这里进入。
// - 文件内辅助：fromIndexedDb（区分 IDB 故障与 Durable 拒绝）、requestResult/transactionResult
//   （事件转 Promise）、cursorValues/firstCursorValue（游标收集）、page/cursorId/primaryRange/
//   compoundIdRange/scanCompoundRows（分页与键范围）、scopeColumns/addressParts/addressPrefix
//   （文档地址编码）、createSchema（版本 1 的 schema）。
//
// 组合与典型顺序：open 校验元数据行 -> 每个 commit 打开覆盖全部 store 的读写事务 -> 逐 batch
// 检查并写入 -> 元数据推进 nextSeq/nextId -> 事务完成后发送持久化回执 -> 读取各自开只读事务。
//
// 示例（真实签名）：
//   const storage = await IndexedDbStorage.open("my-app", { indexedDB: globalThis.indexedDB });
//   await storage.commit([[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }]],
//     (index, seq) => {}, BACKGROUND_CONTEXT);
//   const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 20, undefined,
//     BACKGROUND_CONTEXT);
//   await storage.close(BACKGROUND_CONTEXT);
//
// 建议阅读顺序：先读 STORES/INDEXES 与 Row 类型（数据布局），再读模块级 Promise/游标辅助，
// 然后读 open 与 createSchema，接着读 commit 的批次循环，最后读 fork 链条目读取与文档物化。
//
// 测试：test/indexeddb-storage.test.ts 用 fake-indexeddb 注册公共存储契约，并覆盖重开、事务
// 失败与拒绝前缀；公共用例在 src/testing/storage-conformance.ts。运行（在 packages/durable 下）：
//   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/indexeddb-storage.test.ts

import type { Context } from "@earendil-works/chord/context";
import { apply, type Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import { StorageRequestError } from "../errors.ts";
import { idFromNumber, seqFromNumber } from "../ids.ts";
import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Page,
	ScanOrder,
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
import { nextCursor, type ScanStart, scanStart } from "./scan.ts";

// 数据库 schema 版本。open 只在 oldVersion === 0（全新库）时建表；版本升级需要另行编写迁移。
const DATABASE_VERSION = 1;
// 复合索引尾部上界的哨兵值：ID 是安全整数，因此它一定大于任何真实 ID。
const MAX_KEY = Number.MAX_SAFE_INTEGER;
// meta store 里唯一一行的主键；该行原子地保存 nextId 与 nextSeq。
const META_KEY = "state";

// 8 个 object store 的名字。as const 让每个值成为字面量类型，Object.values 得到字符串元组；
// 运行时对象可变，但代码只读它。
const STORES = {
	meta: "meta",
	recordIds: "record_ids",
	conversations: "conversations",
	entries: "entries",
	tasks: "tasks",
	submissions: "submissions",
	documents: "documents",
	documentRevisions: "document_revisions",
} as const;

// 所有 store 名的数组；commit 打开覆盖全部 store 的事务，避免不同批次写入不同连接视图。
const ALL_STORES = Object.values(STORES);

// 索引名与建索引时的字段路径。复合索引的数组顺序就是键比较顺序：先是过滤列，最后是排序/分页键。
// 例如 conversations_by_owner_task = [ownerTaskId, id]，既能按任务分组，也能在该组内按 ID 分页。
const INDEXES = {
	conversationsByOwnerConversation: "conversations_by_owner_conversation",
	conversationsByOwnerTask: "conversations_by_owner_task",
	entriesByConversation: "entries_by_conversation",
	entryHeadsByConversation: "entry_heads_by_conversation",
	tasksByStatus: "tasks_by_status",
	tasksByConversation: "tasks_by_conversation",
	tasksByKind: "tasks_by_kind",
	tasksByAbortRequested: "tasks_by_abort_requested",
	tasksByBackground: "tasks_by_background",
	submissionsByRequest: "submissions_by_request",
	submissionsByConversation: "submissions_by_conversation",
	submissionsByStatus: "submissions_by_status",
	documentsByAddress: "documents_by_address",
	documentsByScope: "documents_by_scope",
	documentsByScopeKind: "documents_by_scope_kind",
	documentRevisionsByKind: "document_revisions_by_kind",
} as const;

// 存储层不解析任务业务类型，三个泛型统一用 JsonValue。
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
// 合并后的文档动作。与内存后端不同，copy 的 source 会保留到 resolveCopies 阶段才替换成 base 内容。
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};
// 文档作用域压缩成的可索引列：session 用 ownerId 0（它没有自己的 ID），
// conversation/task 用其数字 ID；scopeKind 与 ownerId 一起构成索引前缀。
type ScopeColumns = {
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
};
// meta 行的形状；nextId 与 nextSeq 在同一个读写事务里推进，避免并发分配重复值。
type MetaRow = { readonly key: typeof META_KEY; readonly nextId: number; readonly nextSeq: number };
// 全局 ID 归属行：id -> 表名。它让 conversation/entry/document 的 ID 不能被重写或跨表复用。
type RecordIdRow = { readonly id: number; readonly recordType: TableName };
// 会话行的索引列 + 完整记录。ownerConversationId/ownerTaskId 必须放在顶层，IndexedDB 才能建索引；
// record 保存原始 ConversationRecord，读取时直接返回它。
type ConversationRow = {
	readonly id: ConversationId;
	readonly ownerConversationId?: ConversationId;
	readonly ownerTaskId?: TaskId;
	readonly record: ConversationRecord;
};
// 条目行：conversationId 供普通条目索引；headConversationId 只在条目带 head 时写入，
// 供 head 索引使用。commitSeq 不属于条目记录本身，但读取时需要返回。
type EntryRow = {
	readonly id: EntryId;
	readonly conversationId: ConversationId;
	readonly headConversationId?: ConversationId;
	readonly commitSeq: Seq;
	readonly record: EntryRecord;
};
// 任务行：kind/status/abortRequested/background 是索引列。
// 布尔值存成 0/1，因为 IDBValidKey 不接受 boolean，复合索引需要数值键。
type TaskRow = {
	readonly id: TaskId;
	readonly conversationId: ConversationId;
	readonly kind: string;
	readonly status: StoredTask["state"]["status"];
	readonly abortRequested: 0 | 1;
	readonly background: 0 | 1;
	readonly record: StoredTask;
};
// 提交行：requestId 与 status 是索引列；requestId 可缺失，缺失时不会进入对应索引。
type SubmissionRow = {
	readonly id: SubmissionId;
	readonly conversationId: ConversationId;
	readonly requestId?: string;
	readonly status: SubmissionRecord["status"];
	readonly record: SubmissionRecord;
};
// 文档行：kind/family/keyValue/scopeKind/ownerId 组成地址索引前缀，createdAt/retiredAt 用于
// 存活判断；createdAt 与 id 还构成地址索引的排序尾部。family 0/1 与 keyValue 的编码见 addressParts。
type DocumentRow = {
	readonly id: DocumentId;
	readonly kind: string;
	readonly family: 0 | 1;
	readonly keyValue: string;
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
	readonly createdAt: Seq;
	readonly retiredAt?: Seq;
	readonly record: DocumentRecord;
};
// 修订行：主键是 [documentId, seq]，保证同一文档每个提交最多一条修订。
// content 在 base 时是 JsonObject，在 delta 时是 Op 数组；kind 字段区分两者。
type RevisionRow = {
	readonly documentId: DocumentId;
	readonly seq: Seq;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: JsonObject | readonly Op[];
};

// 打开选项：indexedDB 可注入 IDBFactory。测试用 fake-indexeddb 注入它，浏览器默认用全局工厂。
type IndexedDbStorageOptions = {
	readonly indexedDB?: IDBFactory;
};

// IndexedDB 有时报告失败却不给出具体错误对象（例如事务被中止）；这个标记让调用方仍能把它
// 识别为“IndexedDB 自身故障”，而不是 Durable 的批次检查拒绝。
/** A failure IndexedDB reported without an error of its own: the database's, like every `DOMException` it throws. */
class IndexedDbFailure extends Error {}

// 判断一个错误是否来自 IndexedDB：DOMException 或 IndexedDbFailure，包括包装在 cause 链里的情况。
// 为什么要区分：commit 的 catch 中，IDB 故障必须中止整个事务（否则后续请求无法继续），
// 而 Durable 的检查失败只拒绝当前 batch、保留之前已写入的 batch。
// 输入是 catch 到的任意抛出值；输出布尔值；不抛错，也不会修改错误对象。
/**
 * Whether `error`, or an error it was caused by (a copy's rejection wraps its cause), is IndexedDB's own: a
 * `DOMException`, or a failure it reported without one. Any other error of a batch's checks is one of Durable's.
 */
function fromIndexedDb(error: unknown): boolean {
	// seen 防止 cause 链成环；at 从错误本身开始沿 cause 上溯。
	// 只有 object 才能有 cause；原始值（字符串/数字）到此结束。
	const seen = new Set<unknown>();
	for (let at: unknown = error; at !== null && typeof at === "object" && !seen.has(at); ) {
		// 命中两种标记即返回 true；instanceof 对跨 realm 的 DOMException 可能失效，
		// 但浏览器 IndexedDB 抛出的异常与当前 realm 一致，测试用 fake-indexeddb 同理。
		if (at instanceof DOMException || at instanceof IndexedDbFailure) return true;
		seen.add(at);
		// cause 是标准 ErrorOptions 字段；这里用结构类型读取，不要求 at 是 Error 实例。
		at = (at as { cause?: unknown }).cause;
	}
	return false;
}

// 把一次 IDBRequest 的 success/error 事件包装成 Promise。
// 输入 request 由调用方在同一事务中创建；输出请求结果；错误时优先用 request.error，
// 缺失时用 IndexedDbFailure 标记，保证拒绝值总能被 fromIndexedDb 识别。
// 两个事件监听都带 once: true，请求结束后自动移除，避免长期引用。
const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		// success 事件读取 request.result；泛型 T 是对请求结果形状的断言，不由 IndexedDB 运行时校验。
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener(
			"error",
			// ?? 只在 request.error 为 null/undefined 时使用标记错误；事件本身不阻止默认行为。
			() => reject(request.error ?? new IndexedDbFailure("IndexedDB request failed")),
			{
				once: true,
			},
		);
	});

// 把事务的整体结果包装成 Promise：complete 表示已提交，abort/error 表示失败。
// 注意 transaction 上的 error 事件可能先于 abort 触发；两个分支都拒绝，Promise 只采纳第一次 settle。
// 调用方通常先拿到这个 Promise，再在事务中发请求，最后 await 它确认真实提交。
const transactionResult = (transaction: IDBTransaction): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		// complete 在事务的所有请求成功且提交后触发；此时数据对后续读取可见。
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			// abort 可能由 abort() 调用、未处理的请求错误或浏览器资源限制触发；错误对象可能缺失。
			() => reject(transaction.error ?? new IndexedDbFailure("IndexedDB transaction was aborted")),
			{ once: true },
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new IndexedDbFailure("IndexedDB transaction failed")),
			{ once: true },
		);
	});

// 取全局 IDBKeyRange；Node 环境没有它，需要由测试或运行时注入（fake-indexeddb）。
// 缺失时抛普通 Error：这属于环境配置错误，不是 StorageRequestError。
const keyRanges = (): typeof IDBKeyRange => {
	if (typeof IDBKeyRange === "undefined") throw new Error("IndexedDB key ranges are not available");
	return IDBKeyRange;
};

// 用游标收集最多 limit 条满足 accept 的值。
// 输入 source 可以是 store 或 index，range 为键范围（null 表示全部），direction 为 next/prev，
// accept 在每条记录上运行（默认接受全部）。输出值数组；请求或游标错误时拒绝。
// 调用方通常传 limit+1 来判断是否还有下一页。
const cursorValues = <T>(
	source: IDBObjectStore | IDBIndex,
	range: IDBKeyRange | IDBValidKey | null,
	direction: IDBCursorDirection,
	limit: number,
	accept: (value: T) => boolean = () => true,
): Promise<T[]> =>
	new Promise<T[]>((resolve, reject) => {
		// 先收集再统一 resolve；values 只在成功路径增长。
		const values: T[] = [];
		// openCursor 在事务中异步执行；后续每次 continue 都会再次触发 success。
		const request = source.openCursor(range, direction);
		request.addEventListener(
			"error",
			() => reject(request.error ?? new IndexedDbFailure("IndexedDB cursor failed")),
			{
				once: true,
			},
		);
		// success 回调可能被多次调用：cursor 为 null 表示遍历结束。
		request.addEventListener("success", () => {
			const cursor = request.result;
			// 没有游标：所有记录已处理完，返回当前结果。
			if (cursor === null) {
				resolve(values);
				return;
			}
			// cursor.value 的运行时形状由 store 的 keyPath/写入方决定；as T 是存储内部断言。
			const value = cursor.value as T;
			// accept 过滤在 limit 之前：被过滤掉的记录不占页大小。
			if (accept(value)) values.push(value);
			// 达到上限就停止，不再 continue；游标随事务结束自动释放。
			if (values.length >= limit) {
				resolve(values);
				return;
			}
			// continue() 请求下一条；不 await，因为结果仍通过同一个 success 监听返回。
			cursor.continue();
		});
	});

// 与 cursorValues 相同的遍历方式，但只返回第一条满足 accept 的记录。
// 输入/错误路径同上；输出是值或 undefined（没有匹配）。
// 典型用途：按索引取最新 base 修订或最近的 head 标记。
const firstCursorValue = <T>(
	source: IDBObjectStore | IDBIndex,
	range: IDBKeyRange | IDBValidKey | null,
	direction: IDBCursorDirection,
	accept: (value: T) => boolean = () => true,
): Promise<T | undefined> =>
	new Promise<T | undefined>((resolve, reject) => {
		const request = source.openCursor(range, direction);
		request.addEventListener(
			"error",
			() => reject(request.error ?? new IndexedDbFailure("IndexedDB cursor failed")),
			{
				once: true,
			},
		);
		request.addEventListener("success", () => {
			const cursor = request.result;
			if (cursor === null) {
				resolve(undefined);
				return;
			}
			const value = cursor.value as T;
			if (accept(value)) {
				resolve(value);
				return;
			}
			cursor.continue();
		});
	});

// 把扫描数组切成 Page：最多 limit 条；调用方收集了 limit+1 条时生成 next。
// 与 MemoryStorage 的 page 不同，这里不克隆记录（调用方读取的是 IndexedDB 已脱离的普通对象）。
const page = <T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<T, Cursor> => {
	// slice 复制前 limit 项；items 的类型仍是记录数组。
	const items = values.slice(0, limit);
	// 数量不超过 limit 说明没有下一页，Page.next 保持缺失。
	if (values.length <= limit) return { items };
	// 末项一定存在（values.length > limit >= 0 隐含至少 limit+1 项）；! 表达这个不变量。
	return { items, next: nextCursor(items.at(-1)!.id, order) };
};

// 解析文档扫描游标中的 after，并验证它是安全整数。
// 输入是调用方回传的 JSON 记录；输出品牌 ID 或 undefined（第一页）。
// 非法值抛 StorageRequestError：这是存储读取边界，不导致 Session 失败。
const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) {
		throw new StorageRequestError("Invalid storage cursor");
	}
	return idFromNumber<I>(after);
};

// 主键扫描的键范围：没有游标时 null（全表）；升序用下界，降序用上界。
// 第二个参数 true 表示边界开放，即排除游标 ID 本身。
const primaryRange = (start: ScanStart): IDBKeyRange | null => {
	if (start.after === undefined) return null;
	return start.order === "ascending"
		? keyRanges().lowerBound(start.after, true)
		: keyRanges().upperBound(start.after, true);
};

// 构造复合索引的键范围：prefix 固定分组，尾部 [minimum, maximum] 限定 ID。
// minimumOpen/maximumOpen 用于把游标 ID 排除在下一页之外。
// 例：prefix [7]（会话 7），minimum 5，maximum 9 覆盖该会话 ID 5..9 的条目。
const compoundIdRange = (
	prefix: readonly IDBValidKey[],
	minimum: number,
	maximum: number,
	minimumOpen = false,
	maximumOpen = false,
): IDBKeyRange => keyRanges().bound([...prefix, minimum], [...prefix, maximum], minimumOpen, maximumOpen);

// 在复合索引上按前缀 + ID 范围扫描。
// 输入 index/prefix/start/limit/accept；输出满足条件的行。
// 升序：下界是游标 ID（开放）或 0，上界 MAX；降序：下界 0，上界是游标 ID（开放）或 MAX。
// 方向交给 IndexedDB 游标，避免把整组读进内存再排序。
const scanCompoundRows = <T extends { readonly id: number }>(
	index: IDBIndex,
	prefix: readonly IDBValidKey[],
	start: ScanStart,
	limit: number,
	accept: (value: T) => boolean,
): Promise<T[]> => {
	// 升序时从游标之后开始；没有游标从 0 开始。
	const minimum = start.order === "ascending" && start.after !== undefined ? start.after : 0;
	// 降序时到游标之前结束；没有游标到 MAX_KEY。
	const maximum = start.order === "descending" && start.after !== undefined ? start.after : MAX_KEY;
	return cursorValues<T>(
		index,
		compoundIdRange(
			prefix,
			minimum,
			maximum,
			// 只有存在游标的那一侧边界需要开放，另一侧保持闭区间以包含端点的合法 ID。
			start.order === "ascending" && start.after !== undefined,
			start.order === "descending" && start.after !== undefined,
		),
		// IndexedDB 游标方向：next 升序、prev 降序；与 start.order 一一对应。
		start.order === "ascending" ? "next" : "prev",
		limit,
		accept,
	);
};

// 把文档作用域展开成两个可索引列：scopeKind 与数字 ownerId。
// session 没有自己的 ID，用 0 占位；conversation/task 用其 ID。
// switch 穷尽三个分支，TypeScript 不会要求 default。
const scopeColumns = (scope: DocumentRecord["scope"]): ScopeColumns => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};

// 把文档地址编码成索引列：kind + scope 列 + family + keyValue。
// key 缺失（单例）时 family=0、keyValue=""；存在（家族成员）时 family=1、keyValue=key。
// 为什么要 family 列：IndexedDB 不能索引 undefined，把“无 key”编码成可比较的值。
const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: address.kind,
		...scope,
		// 三元表达式分别产生字面量 0/1；as const 让 TypeScript 保留字面量类型而不是 number。
		family: address.key === undefined ? (0 as const) : (1 as const),
		keyValue: address.key ?? "",
	};
};

// 地址索引的完整前缀（不含 createdAt/id 尾部），用于范围扫描和 currentDocumentId。
const addressPrefix = (address: DocumentAddress | DocumentCreate | DocumentRecord): readonly IDBValidKey[] => {
	const parts = addressParts(address);
	return [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
};

// 内存 Map 用的结构键；JSON.stringify 后同一地址得到同一字符串。
const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string =>
	JSON.stringify(addressPrefix(address));

// 判断文档化身在读取点是否存活；规则与内存后端相同：
// current 只看未退役；历史点用 [createdAt, retiredAt) 区间。
const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

// 只保留当前状态的文档：非 conversation 作用域，或 conversation 文档的 history 为 latest。
// 对这些文档请求历史内容会抛 StorageRequestError。
const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

// 返回写入携带的记录 ID（用于抬高 nextId）；change/retire 不引入新 ID，返回 undefined。
// switch 覆盖 StorageWrite 的全部判别值，因此不需要 default。
const writeId = (write: StorageWrite): Id<string> | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

// 在全新数据库的 upgradeneeded 中建立版本 1 的 schema。
// meta 预置 nextId=2（根会话 ID 1 已保留）与 nextSeq=1；recordIds 记录全局 ID 归属。
// 其余 store 的 keyPath 都是 id，文档修订用复合主键 [documentId, seq]。
// 索引把过滤列放在前面、id 放在最后，使“分组 + 按 ID 分页”能由一次范围扫描完成。
function createSchema(database: IDBDatabase): void {
	const meta = database.createObjectStore(STORES.meta, { keyPath: "key" });
	// satisfies MetaRow 只做编译期形状检查；add 在空 store 中写入第一行。
	meta.add({ key: META_KEY, nextId: 2, nextSeq: 1 } satisfies MetaRow);
	database.createObjectStore(STORES.recordIds, { keyPath: "id" });

	const conversations = database.createObjectStore(STORES.conversations, { keyPath: "id" });
	// 复合索引 [ownerConversationId, id]；没有 owner 的会话不会进入该索引。
	conversations.createIndex(INDEXES.conversationsByOwnerConversation, ["ownerConversationId", "id"]);
	conversations.createIndex(INDEXES.conversationsByOwnerTask, ["ownerTaskId", "id"]);

	const entries = database.createObjectStore(STORES.entries, { keyPath: "id" });
	entries.createIndex(INDEXES.entriesByConversation, ["conversationId", "id"]);
	// head 索引只包含带 headConversationId 的条目（即带 head 的条目）。
	entries.createIndex(INDEXES.entryHeadsByConversation, ["headConversationId", "id"]);

	const tasks = database.createObjectStore(STORES.tasks, { keyPath: "id" });
	tasks.createIndex(INDEXES.tasksByStatus, ["status", "id"]);
	tasks.createIndex(INDEXES.tasksByConversation, ["conversationId", "id"]);
	tasks.createIndex(INDEXES.tasksByKind, ["kind", "id"]);
	tasks.createIndex(INDEXES.tasksByAbortRequested, ["abortRequested", "id"]);
	tasks.createIndex(INDEXES.tasksByBackground, ["background", "id"]);

	const submissions = database.createObjectStore(STORES.submissions, { keyPath: "id" });
	submissions.createIndex(INDEXES.submissionsByRequest, ["conversationId", "requestId"]);
	submissions.createIndex(INDEXES.submissionsByConversation, ["conversationId", "id"]);
	submissions.createIndex(INDEXES.submissionsByStatus, ["status", "id"]);

	const documents = database.createObjectStore(STORES.documents, { keyPath: "id" });
	documents.createIndex(INDEXES.documentsByAddress, [
		"kind",
		"scopeKind",
		"ownerId",
		"family",
		"keyValue",
		"createdAt",
		"id",
	]);
	documents.createIndex(INDEXES.documentsByScope, ["scopeKind", "ownerId", "id"]);
	documents.createIndex(INDEXES.documentsByScopeKind, ["scopeKind", "ownerId", "kind", "id"]);

	// 修订的主键是 [documentId, seq]：同一文档同一提交只能有一条修订。
	// 另建 [documentId, kind, seq] 索引，便于按 kind 找最近 base。
	const revisions = database.createObjectStore(STORES.documentRevisions, { keyPath: ["documentId", "seq"] });
	revisions.createIndex(INDEXES.documentRevisionsByKind, ["documentId", "kind", "seq"]);
}

// 类的未导出构造器只由 static open 调用；字段跟踪关闭状态和在途事务，见下方 closeDatabase。
// 所有访问数据库的公开方法都会经过 assertOpen（直接或经由 transaction），保证关闭后的调用立即失败。
/** Browser IndexedDB implementation of the durable storage contract. One owner must serialize access to each database. */
export class IndexedDbStorage implements Storage {
	// 数据库连接由 open 创建并验证；构造后不会替换。
	private readonly database: IDBDatabase;
	// close 一旦开始就置 true；assertOpen 用它拒绝后续所有公开调用。
	private closed = false;
	// close 的进行中 Promise，缓存后让重复调用返回同一个等待结果，而不是重复关闭。
	private closing: Promise<void> | undefined;
	// 当前在途事务数；closeDatabase 等它归零后才真正关闭连接，避免在执行中关闭数据库。
	private activeOperations = 0;
	// 归零时由最后一个事务调用的 resolve；closeDatabase 用 Promise 包住它来等待排空。
	private operationsDrained: (() => void) | undefined;

	// 私有构造器：schema 与元数据校验都在静态 open 中完成，外部无法绕过。
	private constructor(database: IDBDatabase) {
		this.database = database;
	}

	// 打开或创建数据库：输入名字与可选 IDBFactory；输出已校验元数据的实例。
	// 流程：factory.open(name, 1) -> upgradeneeded 时建 schema -> 等打开成功 -> 只读事务读取 meta 行。
	// 错误：环境没有 IndexedDB、打开失败、meta 行缺失都会拒绝 Promise；打开后校验失败会先关闭连接。
	// 例：await IndexedDbStorage.open("chat", { indexedDB: fakeIndexedDb })。
	/** Open or create a browser-only IndexedDB database. */
	static async open(name: string, options: IndexedDbStorageOptions = {}): Promise<IndexedDbStorage> {
		// 选项注入优先；浏览器里 globalThis.indexedDB 存在，Node 中需要测试显式提供 polyfill。
		const factory = options.indexedDB ?? globalThis.indexedDB;
		// 没有工厂就无法打开；这是环境错误，直接抛普通 Error。
		if (factory === undefined) throw new Error("IndexedDB is not available");
		// 打开请求是异步的；版本号固定为 DATABASE_VERSION，升级逻辑只在下面处理全新库。
		const request = factory.open(name, DATABASE_VERSION);
		// upgradeneeded 在数据库首次创建或版本变化时触发；request.result 此时是连接。
		request.addEventListener("upgradeneeded", (event) => {
			// oldVersion === 0 表示全新数据库，才需要建表；已有库的版本变化不在这里静默重建。
			if ((event as IDBVersionChangeEvent).oldVersion === 0) createSchema(request.result);
		});
		// 等待打开完成；若升级失败，requestResult 会以 IndexedDB 的错误拒绝。
		const database = await requestResult(request);
		try {
			// 元数据读取成功后返回实例；任何一步失败都要关闭已打开的连接，避免泄漏。
			const transaction = database.transaction(STORES.meta, "readonly");
			// 只读事务只覆盖 meta store；它同时验证 schema 确实存在。
			const done = transactionResult(transaction);
			// 先挂上事务完成监听，再发请求；这样 complete/abort 不会错过。
			const metadata = await requestResult(
				// 读取唯一的 meta 行；as IDBRequest<MetaRow> 断言请求结果形状，运行时仍由存储内容决定。
				transaction.objectStore(STORES.meta).get(META_KEY) as IDBRequest<MetaRow>,
			);
			// 等事务真正提交（只读事务完成）后再返回，确保连接处于可用状态。
			await done;
			// 老库或损坏库可能没有 meta 行；不能继续分配 ID/序号。
			if (metadata === undefined) throw new Error("Durable IndexedDB metadata is missing");
			return new IndexedDbStorage(database);
		} catch (error) {
			// 校验失败时关闭连接，避免调用方拿不到实例却留下打开的数据库句柄。
			database.close();
			// 重新抛出原始错误；不包装成 StorageRequestError，因为打开失败是致命的环境问题。
			throw error;
		}
	}

	// 删除一个已关闭的数据库；打开中的连接会阻塞 deleteDatabase，直到它们关闭。
	// 测试用它清理每个用例；生产调用方需自行确保没有其它 owner 正在使用。
	/** Delete a closed database. Open connections in this or another owner can block deletion. */
	static async delete(name: string, options: IndexedDbStorageOptions = {}): Promise<void> {
		const factory = options.indexedDB ?? globalThis.indexedDB;
		if (factory === undefined) throw new Error("IndexedDB is not available");
		await requestResult(factory.deleteDatabase(name));
	}

	// 在一个 IndexedDB 事务里提交多个 batch：每个 batch 独立 seq，并看到前一个 batch 写入后的状态。
	// 输入 batches（每个至少一条写入）、receive 回执、context（未使用）；输出 CommitResult。
	// 关键原子性：整个调用是一个读写事务。Durable 检查拒绝时只停止后续 batch（前面的已写）；
	// IndexedDB 自身出错时整个事务中止，不留下任何 batch。
	// 回执只在事务 complete 之后发送，因此收到的 seq 一定已持久化。
	// 例：两个 batch 中第二个 ID 冲突 -> 返回 { stored: 1, refused }，第一个 batch 已提交。
	/**
	 * Commit `batches` in one IndexedDB transaction, each with its own seq. Each batch does every read and check, copy
	 * resolution included, against the state the earlier ones left before it issues its first write; the first one
	 * refused ends the call, and the transaction commits the ones before it. An error of IndexedDB itself aborts the
	 * transaction: the call rejects with nothing stored.
	 */
	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		_context: Context,
	): Promise<CommitResult> {
		// 关闭后不允许再开新事务。
		this.assertOpen();
		// seqs 只记录事务中已写入的 batch；事务完成后据此发送回执。
		const seqs: Seq[] = [];
		// refused 用对象包裹，区分“没有拒绝”和拒绝值为 undefined。
		let refused: { readonly error: unknown } | undefined;
		// ALL_STORES 让一个事务覆盖所有表；读写模式允许检查阶段读取并写入。
		await this.transaction(ALL_STORES, "readwrite", async (transaction) => {
			// meta store 保存 nextSeq/nextId；整个调用只读写一次该行。
			const metaStore = transaction.objectStore(STORES.meta);
			// 读取元数据；缺失说明库被外部破坏，属于致命错误。
			const metadata = await requestResult(metaStore.get(META_KEY) as IDBRequest<MetaRow>);
			if (metadata === undefined) throw new Error("Durable IndexedDB metadata is missing");
			// 局部变量在内存中推进，最后一次性写回 meta，减少事务内请求数。
			let next = metadata.nextSeq;
			let nextId = metadata.nextId;
			// 按顺序处理每个 batch：后一个 batch 的检查读取前一个 batch 已写入的行。
			for (const writes of batches) {
				let documentActions: Map<DocumentId, DocumentAction>;
				// 准备阶段可能抛两类错误：Durable 的检查失败，或 IndexedDB 请求失败。
				try {
					// 合并同一文档的多条写入，标注 create/content/copy/retire。
					documentActions = this.prepareDocumentActions(writes);
					// 全局 ID 归属检查；读取 recordIds store，能看到同事务中前面的写入。
					await this.checkGlobalIds(transaction, writes);
					// 检查文档存在性、退役状态、delta 版本衔接与地址唯一当前化身。
					await this.checkDocumentActions(transaction, documentActions);
					// 把 copy 解析成源文档在指定点的 base 内容；失败可能是 Durable 检查，也可能是 IDB 读失败。
					await this.resolveCopies(transaction, documentActions);
				} catch (error) {
					// IDB 故障必须重新抛出以中止事务；否则后续请求会落在已失效的事务上，且可能提交不完整状态。
					if (fromIndexedDb(error)) throw error;
					// Durable 自己的拒绝：记录首个错误并停止后续 batch，事务会提交前面已写入的部分。
					refused = { error };
					break;
				}
				// 每个 batch 消耗一个严格递增的 seq；next 只在这里推进。
				const seq = seqFromNumber(next++);
				// 先写表记录（会话/条目/任务/提交）；文档写入在这个函数中跳过。
				for (const write of writes) await this.applyTableWrite(transaction, write, seq);
				// 再统一应用文档动作：创建化身、追加修订、退役，并维护地址索引。
				await this.applyDocumentActions(transaction, documentActions, seq);
				// 写入可能带有比分配器更大的 ID（例如恢复或测试数据），把 nextId 抬到最大已见值 + 1。
				for (const write of writes) {
					const id = writeId(write);
					if (id !== undefined) nextId = Math.max(nextId, id + 1);
				}
				seqs.push(seq);
			}
			// 只有确实写过 batch 才更新 meta；空调用不触碰数据库。
			if (seqs.length > 0) {
				await requestResult(metaStore.put({ key: META_KEY, nextId, nextSeq: next } satisfies MetaRow));
			}
		});
		// 事务已 complete：这些 seq 已持久化，回执现在才发送。
		// 如果事务在校验阶段因 IDB 错误中止，这里不会执行；调用方收到拒绝且什么也没存。
		// 回执是持久化回执，不是发布；Session 之后才发布缓存与观察者。
		// The transaction completed: the stored batches are durable.
		// 同步、按顺序调用 receive；回调抛错会跳过后续回执并拒绝整个 Promise。
		for (const [index, seq] of seqs.entries()) receive(index, seq);
		// refused 存在时把原始错误交回 Session；stored 只统计已提交的 batch。
		return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
	}

	// 从全局数字命名空间分配一个新 ID。
	// 流程：读写事务读取 meta -> 检查安全整数 -> 写回 nextId+1 -> 返回旧值。
	// 用读写事务而不是先读后写，保证与 commit 的 ID 推进、其他 mintId 互斥。
	// 例：meta.nextId 为 7 时返回 7，数据库中的 nextId 变为 8。
	async mintId<I extends Id<string>>(): Promise<I> {
		// close 之后不再分配。
		this.assertOpen();
		// 只碰 meta store 的读写事务；ID 分配与 seq 推进共享同一行。
		return this.transaction(STORES.meta, "readwrite", async (transaction) => {
			const store = transaction.objectStore(STORES.meta);
			const metadata = await requestResult(store.get(META_KEY) as IDBRequest<MetaRow>);
			if (metadata === undefined) throw new Error("Durable IndexedDB metadata is missing");
			// 溢出后不能继续分配：超出安全整数的 ID 会失去精度，破坏唯一性与排序。
			if (!Number.isSafeInteger(metadata.nextId)) throw new Error("ID space is exhausted");
			// 展开原行并覆盖 nextId；key 与 nextSeq 保持不变。
			await requestResult(store.put({ ...metadata, nextId: metadata.nextId + 1 }));
			// 返回分配前的值；idFromNumber 只施加编译期品牌。
			return idFromNumber<I>(metadata.nextId);
		});
	}

	// 按 ID 读取会话；缺失返回 undefined。
	// 事务只覆盖 conversations store；row?.record 用可选链处理没有该 ID 的情况。
	conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		return this.transaction(
			STORES.conversations,
			"readonly",
			async (transaction) =>
				(
					await requestResult(
						transaction.objectStore(STORES.conversations).get(id) as IDBRequest<ConversationRow | undefined>,
					)
				)?.record,
		);
	}

	// 按 ID 顺序扫描会话，可按创建者任务或创建者会话过滤。
	// 输入 query/limit/cursor；输出 Page<ConversationRecord>。
	// 索引选择：ownerTaskId -> conversations_by_owner_task；ownerConversationId -> 对应索引；
	// 否则按主键扫描。limit+1 条用于判断下一页。
	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		// 解析方向与游标位置；默认升序，游标携带的方向优先。
		const start = scanStart(query.order, cursor, "ascending");
		return this.transaction(STORES.conversations, "readonly", async (transaction) => {
			const store = transaction.objectStore(STORES.conversations);
			// ownerTaskId 索引的键前缀已固定任务；ownerConversationId 仍需逐条确认，
			// 因为该索引不包含创建者会话列。
			const accept = (row: ConversationRow) =>
				query.ownerConversationId === undefined || row.ownerConversationId === query.ownerConversationId;
			let rows: ConversationRow[];
			// 按 ownerTaskId 扫描：复合索引 [ownerTaskId, id]，在任务子树内按 ID 分页。
			if (query.ownerTaskId !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.conversationsByOwnerTask),
					[query.ownerTaskId],
					start,
					limit + 1,
					accept,
				);
				// 按 ownerConversationId 扫描：复合索引 [ownerConversationId, id]。
			} else if (query.ownerConversationId !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.conversationsByOwnerConversation),
					[query.ownerConversationId],
					start,
					limit + 1,
					accept,
				);
				// 无 owner 过滤：主键扫描，用 primaryRange 处理游标的开区间。
			} else {
				rows = await cursorValues<ConversationRow>(
					store,
					primaryRange(start),
					start.order === "ascending" ? "next" : "prev",
					limit + 1,
					accept,
				);
			}
			// 把行投影回记录；page 处理截断和 next 游标。
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}

	// entry 的两个重载与内存后端一致：只给条目 ID 时全局读取；给会话 ID 时要求条目在 fork 链上可见。
	// 重载在编译期选择；实现签名用 context 是否为 undefined 区分参数形态。
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	// 合并实现：两参数时是 (EntryId, Context)，三参数时是 (ConversationId, EntryId, Context)。
	// 返回条目与其持久化提交序号；条目存在但属于别的 fork 分支时返回 undefined。
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		// 同时读 conversations 与 entries，因为可见性检查需要沿 parent 链上溯。
		return this.transaction([STORES.conversations, STORES.entries], "readonly", async (transaction) => {
			// 根据参数形态恢复条目 ID：两参数重载的第一个参数就是条目 ID；
			// 三参数重载的第二个参数是条目 ID，第一个是会话 ID。
			const id =
				context === undefined
					? idFromNumber<EntryId>(idOrConversationId)
					: typeof idOrContext === "number"
						? idFromNumber<EntryId>(idOrContext)
						: undefined;
			// 类型正确的调用不会走到这里；这层运行时检查覆盖绕过 TypeScript 的 JS 调用。
			if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
			let conversation: ConversationRecord | undefined;
			// 只有三参数重载需要验证可见性；两参数重载直接返回全局条目。
			if (context !== undefined) {
				// 第一个参数此时是会话 ID；读取失败会在下一行转成 StorageRequestError。
				const conversationId = idFromNumber<ConversationId>(idOrConversationId);
				conversation = await this.readConversation(transaction, conversationId);
				// 未知会话是请求级错误，只失败这次读取。
				if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			}
			// 条目按全局 ID 读取；它可能属于另一个会话。
			const row = await requestResult(
				transaction.objectStore(STORES.entries).get(id) as IDBRequest<EntryRow | undefined>,
			);
			// 全局都不存在：直接 undefined。
			if (row === undefined) return undefined;
			// 三参数重载：沿当前会话的 parent 链确认条目可见。
			if (conversation !== undefined) {
				// upperEntryId 是当前分支允许访问的最大条目 ID，初始不设限。
				let upperEntryId = MAX_KEY;
				// 条目所在会话还未到达当前会话时，逐层上溯。
				while (conversation.id !== row.conversationId) {
					// 到达根仍没找到：条目存在但不属于这条 fork 链。
					if (conversation.parent === undefined) return undefined;
					// fork 点本身及更早的条目可见；upperEntryId 取所有祖先 fork 点的最小值。
					upperEntryId = Math.min(upperEntryId, conversation.parent.at);
					// 父会话一定存在（存储契约要求写入方先写父会话，checkGlobalIds 保证 ID 未被复用）；! 把这个不变量告诉 TypeScript。
					conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
				}
				// 条目 ID 大于 fork 点：它属于 fork 之后的历史，对当前会话不可见。
				if (row.id > upperEntryId) return undefined;
			}
			// 返回记录和持久化提交序号；调用方据此判断条目所在提交。
			return { entry: row.record, commitSeq: row.commitSeq };
		});
	}

	// 查找会话 fork 链上最新的 head 标记，可给定包含式上界。
	// 先查当前会话的 entry_heads 索引中 <= upper 的最大项；没有则上溯父会话，
	// 并把 upper 收紧到 parent.at。未知会话抛 StorageRequestError。
	// 返回条目记录加上它的 head 值（该 head 是上下文区间的实际下界）。
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.transaction([STORES.conversations, STORES.entries], "readonly", async (transaction) => {
			// 从当前会话开始；parent 链上的每一段都要单独查询。
			let conversation = await this.readConversation(transaction, conversationId);
			// 未知会话是请求级错误。
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
			// 没有显式上界时用 MAX_KEY，表示最新。
			let upper = atOrBeforeEntryId ?? MAX_KEY;
			// entry_heads 的键是 [headConversationId, id]；范围限定在本会话且 id <= upper。
			const index = transaction.objectStore(STORES.entries).index(INDEXES.entryHeadsByConversation);
			while (true) {
				// 降序取第一条即最大的 head；只接受带 head 的条目（索引本身已保证）。
				const row = await firstCursorValue<EntryRow>(index, compoundIdRange([conversation.id], 0, upper), "prev");
				// 类型断言：索引只收 headConversationId 存在的行，因此 entry.head 必有值。
				if (row !== undefined) return row.record as EntryRecord & { readonly head: EntryId };
				// 根会话也没有 head：返回 undefined。
				if (conversation.parent === undefined) return undefined;
				// 父会话只能贡献 fork 点及更早的 head。
				upper = Math.min(upper, conversation.parent.at);
				// 继续沿祖先查找；parent 链完整由存储写入方保证。
				conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
			}
		});
	}

	// 扫描一个会话的可见条目，默认降序；只影响返回顺序与游标边界。
	// 升序/降序分别由 readEntriesAscending/readEntriesDescending 实现 fork 链合并。
	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		// 条目扫描默认降序（最新在前），与 Conversation/Task 扫描的默认升序不同。
		const start = scanStart(query.order, cursor, "descending");
		return this.transaction([STORES.conversations, STORES.entries], "readonly", async (transaction) => {
			// 三元选择两个私有实现；两者都返回最多 limit+1 条，page 再截断。
			const values =
				start.order === "ascending"
					? await this.readEntriesAscending(transaction, query, limit, start.after)
					: await this.readEntriesDescending(transaction, query, limit, start.after);
			return page(values, limit, start.order);
		});
	}

	// 按 ID 读取任务最新记录；缺失返回 undefined。
	task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		return this.transaction(
			STORES.tasks,
			"readonly",
			async (transaction) =>
				(await requestResult(transaction.objectStore(STORES.tasks).get(id) as IDBRequest<TaskRow | undefined>))
					?.record,
		);
	}

	// 扫描任务：按查询条件选择最合适的索引，其余过滤逐条应用。
	// 索引优先级：status > conversationId > kind > abortRequested > background > 主键。
	// 复合索引前缀固定第一个条件，剩下的条件在 accept 中过滤。
	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		return this.transaction(STORES.tasks, "readonly", async (transaction) => {
			const store = transaction.objectStore(STORES.tasks);
			// accept 对所有条件做逻辑与；布尔条件与 0/1 列比较。
			const accept = (row: TaskRow) =>
				(query.conversationId === undefined || row.conversationId === query.conversationId) &&
				(query.kind === undefined || row.kind === query.kind) &&
				(query.status === undefined || row.status === query.status) &&
				(query.abortRequested === undefined || row.abortRequested === (query.abortRequested ? 1 : 0)) &&
				(query.background === undefined || row.background === (query.background ? 1 : 0));
			// source 既可能是 store 也可能是 index；prefix 只在选了索引时存在。
			let source: IDBObjectStore | IDBIndex = store;
			let prefix: readonly IDBValidKey[] | undefined;
			// 依次尝试每个可选过滤条件；第一个命中的索引作为扫描源。
			if (query.status !== undefined) {
				source = store.index(INDEXES.tasksByStatus);
				prefix = [query.status];
			} else if (query.conversationId !== undefined) {
				source = store.index(INDEXES.tasksByConversation);
				prefix = [query.conversationId];
			} else if (query.kind !== undefined) {
				source = store.index(INDEXES.tasksByKind);
				prefix = [query.kind];
			} else if (query.abortRequested !== undefined) {
				source = store.index(INDEXES.tasksByAbortRequested);
				prefix = [query.abortRequested ? 1 : 0];
			} else if (query.background !== undefined) {
				source = store.index(INDEXES.tasksByBackground);
				prefix = [query.background ? 1 : 0];
			}
			// 没有索引前缀时按主键范围扫描；有前缀时走复合索引。
			const rows =
				prefix === undefined
					? await cursorValues<TaskRow>(
							source,
							primaryRange(start),
							start.order === "ascending" ? "next" : "prev",
							limit + 1,
							accept,
						)
					: // as IDBIndex 是安全断言：prefix !== undefined 与 source 被赋为 index 总是一起发生。
						await scanCompoundRows<TaskRow>(source as IDBIndex, prefix, start, limit + 1, accept);
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}

	// 按 ID 读取提交最新记录；缺失返回 undefined。
	submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		return this.transaction(
			STORES.submissions,
			"readonly",
			async (transaction) =>
				(
					await requestResult(
						transaction.objectStore(STORES.submissions).get(id) as IDBRequest<SubmissionRow | undefined>,
					)
				)?.record,
		);
	}

	// 扫描提交：可按 status 与 conversationId 过滤；状态索引优先。
	// 与 scanTasks 相同，limit+1 条用于判断下一页。
	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		const start = scanStart(query.order, cursor, "ascending");
		return this.transaction(STORES.submissions, "readonly", async (transaction) => {
			const store = transaction.objectStore(STORES.submissions);
			// 索引前缀之外的条件在这里逐条过滤。
			const accept = (row: SubmissionRow) =>
				(query.conversationId === undefined || row.conversationId === query.conversationId) &&
				(query.status === undefined || row.status === query.status);
			let rows: SubmissionRow[];
			// 状态过滤走 submissions_by_status 索引 [status, id]。
			if (query.status !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.submissionsByStatus),
					[query.status],
					start,
					limit + 1,
					accept,
				);
				// 没有状态但有会话过滤：走 submissions_by_conversation 索引 [conversationId, id]。
			} else if (query.conversationId !== undefined) {
				rows = await scanCompoundRows(
					store.index(INDEXES.submissionsByConversation),
					[query.conversationId],
					start,
					limit + 1,
					accept,
				);
			} else {
				rows = await cursorValues<SubmissionRow>(
					store,
					primaryRange(start),
					start.order === "ascending" ? "next" : "prev",
					limit + 1,
					accept,
				);
			}
			return page(
				rows.map((row) => row.record),
				limit,
				start.order,
			);
		});
	}

	// 按会话 + requestId 查提交：requestId 是主机提供的去重键，作用域限定在会话内。
	// 复合索引 [conversationId, requestId] 的 get 是 O(1) 查找；没有匹配返回 undefined。
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.transaction(STORES.submissions, "readonly", async (transaction) => {
			const row = await requestResult(
				transaction
					.objectStore(STORES.submissions)
					.index(INDEXES.submissionsByRequest)
					// index.get(compoundKey) 直接按键取值，不需要打开游标。
					.get([conversationId, requestId]) as IDBRequest<SubmissionRow | undefined>,
			);
			// 行存在时取完整记录；requestId 缺失的记录不会进入该索引，所以不会命中。
			return row?.record;
		});
	}

	// 在指定读取点查找占用某逻辑地址的文档化身。
	// 用地址索引按前缀扫描，方向 prev 取最大的 [createdAt, id]，即最新创建的化身；accept 过滤存活。
	// current 点会得到当前未退役的化身；历史点会得到该 seq 存活的那个。
	findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
		return this.transaction(STORES.documents, "readonly", async (transaction) => {
			// 地址索引键的尾部是 [createdAt, id]；这里用 [0,0] 到 [MAX,MAX] 覆盖整个尾部。
			const row = await firstCursorValue<DocumentRow>(
				transaction.objectStore(STORES.documents).index(INDEXES.documentsByAddress),
				keyRanges().bound([...addressPrefix(address), 0, 0], [...addressPrefix(address), MAX_KEY, MAX_KEY]),
				"prev",
				// isAliveAt 同时处理 current 与历史点；被过滤掉的旧化身继续向前找。
				(value) => isAliveAt(value.record, at),
			);
			// 取行记录的 record 字段；没有匹配行时可选链返回 undefined。
			return row?.record;
		});
	}

	// 按具体化身 ID 物化文档，不跟随地址替换。
	// 同时读 documents（元数据）与 document_revisions（内容）；返回记录、版本、值和 delta 数。
	document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		return this.transaction([STORES.documents, STORES.documentRevisions], "readonly", (transaction) =>
			this.materializeDocument(transaction, id, at),
		);
	}

	// 扫描一个作用域内在指定点存活的文档化身，按 ID 升序；kind 可选过滤。
	// 游标只读取 after（方向固定升序）；返回行投影为记录。
	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		// 解析并校验 after；非法游标抛 StorageRequestError。
		const after = cursorId<DocumentId>(cursor);
		return this.transaction(STORES.documents, "readonly", async (transaction) => {
			// 把作用域编码成 scopeKind/ownerId 前缀列。
			const scope = scopeColumns(query.scope);
			const store = transaction.objectStore(STORES.documents);
			// 有 kind 时用 [scopeKind, ownerId, kind, id] 索引，无 kind 时用 [scopeKind, ownerId, id]。
			const index =
				query.kind === undefined
					? store.index(INDEXES.documentsByScope)
					: store.index(INDEXES.documentsByScopeKind);
			// 索引前缀与查询条件完全对应；kind 放在 owner 之后、id 之前。
			const prefix: readonly IDBValidKey[] =
				query.kind === undefined ? [scope.scopeKind, scope.ownerId] : [scope.scopeKind, scope.ownerId, query.kind];
			// 有游标时下界开放以排除已返回项；limit+1 条用于判断下一页。
			// accept 只返回在 query.at 存活的化身。
			const rows = await cursorValues<DocumentRow>(
				index,
				compoundIdRange(prefix, after ?? 0, MAX_KEY, after !== undefined),
				"next",
				limit + 1,
				(row) => isAliveAt(row.record, query.at),
			);
			// 方向固定升序（未传 order，page 默认 ascending）；生成的游标带有 order，但 scanDocuments 只读取 after。
			return page(
				rows.map((row) => row.record),
				limit,
			);
		});
	}

	// 关闭连接：先标记 closed，让新的公开调用立即失败；再等待在途事务排空并关闭数据库。
	// 重复调用返回同一个 closing Promise，保证只关闭一次。
	close(_context: Context): Promise<void> {
		// 第一次 close 时创建 closing；之后直接复用。
		if (this.closing === undefined) {
			// 先置 closed 再启动异步关闭，防止关闭过程中有新事务进入。
			this.closed = true;
			this.closing = this.closeDatabase();
		}
		return this.closing;
	}

	// 等待 activeOperations 归零后调用 database.close()。
	// 在途事务的 finally 会递减计数并在归零时调用 operationsDrained。
	private async closeDatabase(): Promise<void> {
		if (this.activeOperations > 0) {
			// 把 resolve 存到字段上，让最后一个事务在 finally 中调用；Promise 本身不轮询。
			await new Promise<void>((resolve) => {
				this.operationsDrained = resolve;
			});
		}
		// 关闭连接会中止未完成事务并释放数据库句柄；此后不能再开事务。
		this.database.close();
	}

	// 事务包装器：统一处理“先挂完成监听、再执行操作、失败时回滚、最后计数排空”。
	// 输入 stores/mode/operation；输出 operation 的返回值。
	// 错误：operation 抛错时先 abort（可能已提交/已中止，忽略二次错误），再抛出原错误；
	// IndexedDB 的 abort/error 通过 done 拒绝。
	// 副作用：递增/递减 activeOperations，并在归零时唤醒 closeDatabase。
	private async transaction<T>(
		stores: string | readonly string[],
		mode: IDBTransactionMode,
		operation: (transaction: IDBTransaction) => Promise<T>,
	): Promise<T> {
		// 关闭后不能再创建事务。
		this.assertOpen();
		// 在创建事务之前计数，保证 close 不会在事务开始与登记之间关闭数据库。
		this.activeOperations++;
		try {
			// 创建 IDB 事务；mode 为 readonly 或 readwrite，stores 决定锁范围。
			const transaction = this.database.transaction(stores, mode);
			// 立即挂上 complete/abort/error 监听；事务可能很快完成，不能等到操作结束后再挂。
			const done = transactionResult(transaction);
			try {
				// 执行调用方的请求序列；它返回业务值（例如读取的记录）。
				const value = await operation(transaction);
				// 等事务真正提交；请求成功但事务后续可能 abort，所以必须等 done。
				await done;
				return value;
			} catch (error) {
				// 操作失败时主动回滚；读写事务的未提交写入不会生效。
				try {
					// abort() 在事务已提交或已中止时会抛 InvalidStateError，这里忽略。
					transaction.abort();
				} catch {
					// It may already have aborted or committed.
				}
				// 等待 done 只是为了确保事务收尾；它的错误不应覆盖 operation 的原始错误。
				try {
					await done;
				} catch {
					// 重新抛出原始业务错误，保持 StorageRequestError 等语义。
					// Preserve the operation failure.
				}
				throw error;
			}
		} finally {
			// 递减在途计数；最后一个事务结束时唤醒等待中的 closeDatabase。
			if (--this.activeOperations === 0) this.operationsDrained?.();
		}
	}

	// 在事务内读取会话记录；多个读取共用同一事务视图，避免同一逻辑读看到不同提交。
	private async readConversation(
		transaction: IDBTransaction,
		id: ConversationId,
	): Promise<ConversationRecord | undefined> {
		return (
			await requestResult(
				transaction.objectStore(STORES.conversations).get(id) as IDBRequest<ConversationRow | undefined>,
			)
		)?.record;
	}

	// 降序读取会话可见条目：先读当前会话 <= upper 的条目，再沿 parent 链上溯。
	// 输入 query（conversationId/min/maxEntryId）与 after 游标；输出最多 limit+1 条记录。
	// after 是上一页最后一项的 ID；本函数把上界收紧到 after - 1 以排除游标项。
	// 未知会话抛 StorageRequestError。
	private async readEntriesDescending(
		transaction: IDBTransaction,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<EntryRecord[]> {
		// 先确认会话存在，并取得 parent 链的起点。
		let conversation = await this.readConversation(transaction, query.conversationId);
		// 未知会话是请求级错误，不写入任何状态。
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		// 上限初始来自查询的 maxEntryId，缺省为 MAX_KEY。
		let upper = query.maxEntryId ?? MAX_KEY;
		// 游标项上一页已返回，所以本页上限是 after - 1；与显式 max 取较小值。
		if (after !== undefined) upper = Math.min(upper, after - 1);
		// 下限来自 minEntryId，缺省 0。
		const minimum = query.minEntryId ?? 0;
		const values: EntryRecord[] = [];
		const index = transaction.objectStore(STORES.entries).index(INDEXES.entriesByConversation);
		// 每次循环处理 fork 链的一段：当前会话，然后父会话，直到根。
		while (true) {
			// 上界低于下限说明本段没有可返回条目，直接跳到父段判断。
			if (upper >= minimum) {
				// 复合索引 [conversationId, id] 范围扫描；limit+1 - values.length 是剩余配额。
				const rows = await cursorValues<EntryRow>(
					index,
					compoundIdRange([conversation.id], minimum, upper),
					"prev",
					limit + 1 - values.length,
				);
				values.push(...rows.map((row) => row.record));
			}
			// 已超过 limit（page 需要 limit+1 判断下一页）或没有父会话时结束。
			if (values.length > limit || conversation.parent === undefined) break;
			// 父会话只能贡献 fork 点及更早的条目。
			upper = Math.min(upper, conversation.parent.at);
			if (upper < minimum) break;
			// 父会话记录由存储契约保证存在；! 表示这个不变量。
			conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
		}
		return values;
	}

	// 升序读取会话可见条目：先收集 fork 链各段，再从根到当前逐段升序产出。
	// 输入/输出同 readEntriesDescending；after 是上一页最后一项，升序时下界收紧到 after + 1。
	// 反转段顺序后整体仍是全局 ID 升序：祖先段条目不超过 fork 点，子会话条目在 fork 之后创建、ID 更大。
	private async readEntriesAscending(
		transaction: IDBTransaction,
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<EntryRecord[]> {
		// segments 保存每段的会话 ID 与包含式上界，从当前会话一路收集到根。
		const segments: { readonly conversationId: ConversationId; readonly upper: number }[] = [];
		let conversation = await this.readConversation(transaction, query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		// 上限初始来自查询的 maxEntryId。
		let upper = query.maxEntryId ?? MAX_KEY;
		// 请求的最小 ID；游标还会在这里进一步收紧。
		const requestedMinimum = query.minEntryId ?? 0;
		while (true) {
			// 当前段的起点；上界随后被 parent.at 收紧。
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			// 父会话只能贡献到 fork 点。
			upper = Math.min(upper, conversation.parent.at);
			// 上界已低于最小 ID，更早的祖先段不可能有可返回条目。
			if (upper < requestedMinimum) break;
			conversation = (await this.readConversation(transaction, conversation.parent.conversationId))!;
		}
		// 游标项已返回，升序时下一项从 after + 1 开始；与显式 min 取较大值。
		const minimum = after === undefined ? requestedMinimum : Math.max(requestedMinimum, after + 1);
		const values: EntryRecord[] = [];
		const index = transaction.objectStore(STORES.entries).index(INDEXES.entriesByConversation);
		// reverse() 让根会话段先产出；数组是局部变量，不影响 state。
		for (const segment of segments.reverse()) {
			// 整段上界都低于最小 ID 时跳过，无需发查询。
			if (segment.upper < minimum) continue;
			// 每段按 [conversationId, id] 升序扫描；剩余配额随已收集数量减少。
			const rows = await cursorValues<EntryRow>(
				index,
				compoundIdRange([segment.conversationId], minimum, segment.upper),
				"next",
				limit + 1 - values.length,
			);
			values.push(...rows.map((row) => row.record));
			// 超过 limit 即可停止：page 会截断并用末项生成 next。
			if (values.length > limit) break;
		}
		return values;
	}

	// 物化一个文档化身：读取记录，找到读取点前最新的 base 修订，重放其后的 delta。
	// 输入 id 与 DocumentPoint；输出 StoredDocument 或 undefined。
	// 错误：历史读取只保留当前状态的文档抛 StorageRequestError；缺少 base 或跨版本 delta 抛普通 Error。
	// deltasSinceBase 是实际重放的 delta 数，可用于决定何时写新 base。
	private async materializeDocument(
		transaction: IDBTransaction,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		// 先读文档元数据；这是地址索引与记录的唯一来源。
		const record = (
			await requestResult(transaction.objectStore(STORES.documents).get(id) as IDBRequest<DocumentRow | undefined>)
		)?.record;
		if (record === undefined) return undefined;
		// 对只保留当前状态的文档，历史读取没有可返回的内容，明确拒绝。
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		// 该化身在读取点尚未创建或已经退役：视为不存在。
		if (!isAliveAt(record, at)) return undefined;
		// 历史点的修订上界是 at；current 用 MAX_KEY 包含全部修订。
		const upper = at === "current" ? MAX_KEY : at;
		const revisions = transaction.objectStore(STORES.documentRevisions);
		// 在 [id, "base", 0] .. [id, "base", upper] 中降序取第一条，即最新 base。
		const base = await firstCursorValue<RevisionRow>(
			revisions.index(INDEXES.documentRevisionsByKind),
			keyRanges().bound([id, "base", 0], [id, "base", upper]),
			"prev",
		);
		// 没有 base 说明存储损坏：创建文档时必定写入 base。
		if (base === undefined || base.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		let value = base.content as JsonObject;
		// base.seq >= upper 表示读取点就在 base 或更早（后者已被范围排除），没有 tail。
		const tail =
			base.seq >= upper
				? // 范围 [id, base.seq] .. [id, upper]，lowerOpen=true 排除 base 自身；limit 用 MAX_KEY 取全部。
					[]
				: await cursorValues<RevisionRow>(
						revisions,
						keyRanges().bound([id, base.seq], [id, upper], true),
						"next",
						MAX_KEY,
					);
		// tail 是 base 之后的全部修订；每条都必须是同版本 delta，否则物化会跨越版本边界。
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			// apply 原地修改 value 并返回它；base.content 是已脱离存储的普通 JSON 值。
			value = apply(value, revision.content as readonly Op[]) as JsonObject;
		}
		// record 是 IndexedDB 读出的普通对象；调用方修改它不会写回存储（需显式 commit）。
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	// 检查一个批次内的全局 ID 归属（IndexedDB 版本）：读取 recordIds store 确认 ID 未被占用。
	// conversation/entry/document 不可重写或同批次重复；task/submission 允许同表覆盖。
	// 错误是普通 Error，由 commit 转成 refused，而不是让整个事务中止。
	private async checkGlobalIds(transaction: IDBTransaction, writes: readonly StorageWrite[]): Promise<void> {
		const store = transaction.objectStore(STORES.recordIds);
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			// 读取该 ID 的归属表；undefined 表示尚未使用。同事务中前面 batch 的 claim 已可见。
			const existing = (await requestResult(store.get(id) as IDBRequest<RecordIdRow | undefined>))?.recordType;
			const earlier = claimed.get(id);
			// 不可变身份：已存在或同批次重复都拒绝，文档化身 ID 永不复用。
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
				// 可变生命周期记录：允许覆盖同表，但不能占用别的表的 ID，也不能同批次写成两种表。
			} else {
				if (existing !== undefined && existing !== table)
					throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	// 把一个 batch 的文档写入合并成按文档 ID 的动作，供检查、copy 解析与应用。
	// 约束：每个文档最多一条内容命令（create/copy/change），最多一次 retire；否则抛普通 Error。
	// 输出 Map；copy 的 source 在 resolveCopies 中才解析为 base 内容。
	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			) {
				continue;
			}
			// create/copy 的 ID 在 record 上，change/retire 的 ID 在写入本身。
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			// 第一次见到该文档时创建动作；retire 默认 false。
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				// create：保存记录和 base 内容；与 copy/change 的内容命令互斥。
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				// copy：只保存记录和源信息；内容在 resolveCopies 中读取源文档后填入。
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				// change：只保存内容；现有文档由 checkDocumentActions 确认存在。
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				// retire：可与 create/change 组合，但不能重复。
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	// 针对事务中的现有状态检查文档动作：存在性、退役、copy 源冲突、delta 版本、地址唯一当前化身。
	// 所有读取都在同一事务里，因此看到的是前面 batch 已写入的状态。
	private async checkDocumentActions(
		transaction: IDBTransaction,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<void> {
		const documents = transaction.objectStore(STORES.documents);
		const revisions = transaction.objectStore(STORES.documentRevisions);
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			// 复制源同时在本批次被创建/修改/退役时，复制应读取的状态无法定义，直接拒绝。
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			// 读取该 ID 的现有记录；create 时仍要检查重复创建。
			const existing = (await requestResult(documents.get(id) as IDBRequest<DocumentRow | undefined>))?.record;
			// change/retire 指向不存在的文档。
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			// 文档化身 ID 不能复用。
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			// 已退役的化身不能再修改或再次退役。
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			// delta 必须接在已有修订之后，且版本与最新修订相同；版本变化必须写新 base。
			if (action.content?.kind === "delta") {
				// 降序取该文档最新的一条修订（不按 kind 过滤），即上一状态。
				const previous = await firstCursorValue<RevisionRow>(revisions, compoundIdRange([id], 0, MAX_KEY), "prev");
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			// 地址键取本批次最终记录：create 用新记录，否则用现有记录。
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			// 地址已有当前化身则存活数为 1；currentDocumentId 用地址索引查找未退役者。
			if (live === undefined) live = (await this.currentDocumentId(transaction, record)) === undefined ? 0 : 1;
			// 退役已有化身就减少存活数；已退役的记录在存活检查中已被拒绝，因此现存且未退役的化身就是当前化身。
			if (action.retire && existing !== undefined) live--;
			// 新建且不立即退役才留下当前化身。
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		// 一个逻辑地址最多一个当前化身；出现第二个说明替换前忘记退役。
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	// 用地址索引找该逻辑地址当前未退役的化身 ID；没有则 undefined。
	private async currentDocumentId(
		transaction: IDBTransaction,
		address: DocumentAddress | DocumentCreate | DocumentRecord,
	): Promise<DocumentId | undefined> {
		const row = await firstCursorValue<DocumentRow>(
			transaction.objectStore(STORES.documents).index(INDEXES.documentsByAddress),
			keyRanges().bound([...addressPrefix(address), 0, 0], [...addressPrefix(address), MAX_KEY, MAX_KEY]),
			"prev",
			// accept 只看行上的 retiredAt 列，避免读取并解析完整记录。
			(value) => value.retiredAt === undefined,
		);
		return row?.id;
	}

	// 写入全局 ID 归属行。put 允许 task/submission 覆盖同表归属；不可变表在 checkGlobalIds 已保证不重复。
	private async claimId(transaction: IDBTransaction, id: Id<string>, recordType: TableName): Promise<void> {
		await requestResult(transaction.objectStore(STORES.recordIds).put({ id, recordType } satisfies RecordIdRow));
	}

	// 写入一条表记录，把查询需要的字段提升为索引列。
	// conversation/entry 用 add（创建一次）；task/submission 用 put（生命周期更新）。
	// 文档写入在这里跳过，由 applyDocumentActions 统一处理。
	private async applyTableWrite(transaction: IDBTransaction, write: StorageWrite, seq: Seq): Promise<void> {
		switch (write.type) {
			// 会话创建：登记 ID，再 add 行；owner 存在时拆成两列写索引。
			case "conversation":
				await this.claimId(transaction, write.value.id, "conversation");
				await requestResult(
					transaction.objectStore(STORES.conversations).add({
						id: write.value.id,
						// 条件展开：owner 缺失时不写这两个属性，而不是写入 undefined。
						...(write.value.owner === undefined
							? {}
							: {
									ownerConversationId: write.value.owner.conversationId,
									ownerTaskId: write.value.owner.taskId,
								}),
						record: write.value,
					} satisfies ConversationRow),
				);
				break;
			// 条目创建：登记 ID；head 存在时写 headConversationId 列，使其进入 head 索引。
			case "entry":
				await this.claimId(transaction, write.value.id, "entry");
				await requestResult(
					transaction.objectStore(STORES.entries).add({
						id: write.value.id,
						conversationId: write.value.conversationId,
						// head 缺失时省略列；条目仍进入普通 conversation 索引。
						...(write.value.head === undefined ? {} : { headConversationId: write.value.conversationId }),
						commitSeq: seq,
						record: write.value,
					} satisfies EntryRow),
				);
				break;
			// 任务写入：put 覆盖同 ID 行，status/kind/布尔索引列随记录一起更新。
			case "task":
				await this.claimId(transaction, write.value.id, "task");
				await requestResult(
					transaction.objectStore(STORES.tasks).put({
						id: write.value.id,
						conversationId: write.value.conversationId,
						kind: write.value.kind,
						status: write.value.state.status,
						abortRequested: write.value.abortRequested ? 1 : 0,
						background: write.value.background ? 1 : 0,
						record: write.value,
					} satisfies TaskRow),
				);
				break;
			// 提交写入：同样 put；requestId 可选。
			case "submission":
				await this.claimId(transaction, write.value.id, "submission");
				await requestResult(
					transaction.objectStore(STORES.submissions).put({
						id: write.value.id,
						conversationId: write.value.conversationId,
						...(write.value.requestId === undefined ? {} : { requestId: write.value.requestId }),
						status: write.value.status,
						record: write.value,
					} satisfies SubmissionRow),
				);
				break;
			// 文档类写入不落表；applyDocumentActions 负责 documents 与 document_revisions。
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	// 把每个 copy 解析成源文档在指定点的 base 内容。
	// 约束：源不能在本批次被修改；源必须存在、是 conversation 作用域，且 kind/key/history/fork 与副本一致。
	// 失败时抛错并用 cause 保留底层原因；commit 会把非 IDB 错误当作 batch 拒绝。
	/** Resolve each copy to a base of its source's state before this batch, which may not change the source. */
	private async resolveCopies(transaction: IDBTransaction, actions: Map<DocumentId, DocumentAction>): Promise<void> {
		for (const [id, action] of actions) {
			// 没有 copy 的动作直接跳过；大多数提交不会进入物化路径。
			if (action.copy === undefined) continue;
			try {
				// 读取源文档在 source.at 的状态；历史读取可能抛 StorageRequestError 或 IDB 错误。
				const stored = await this.materializeDocument(transaction, action.copy.id, action.copy.at);
				// 源不存在或在该点不存活：复制没有初始值。
				if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
				// create 一定存在：copy 写入总带 record；! 表达这个不变量。
				const create = action.create!;
				// 副本必须与源同类：conversation 作用域、相同 kind/key/history/fork，否则复制语义不成立。
				if (
					stored.record.scope.kind !== "conversation" ||
					create.scope.kind !== "conversation" ||
					stored.record.kind !== create.kind ||
					stored.record.key !== create.key ||
					stored.record.history !== create.history ||
					stored.record.fork !== create.fork
				) {
					// 不匹配时给出可定位的错误消息；消息里带源文档 ID。
					throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
				}
				// 用物化结果构造 base：version 沿用源的版本号，value 是脱离式 JSON。
				action.content = { kind: "base", version: stored.version, value: stored.value };
			} catch (error) {
				// 包装错误并保留 cause；外层消息说明是哪个复制目标被拒绝。
				throw new Error(`Document copy ${id} was rejected`, { cause: error });
			}
		}
	}

	// 应用已检查的文档动作：创建化身行、追加修订行、处理退役，并级联清理只保留当前状态的文档。
	// 假设 checkDocumentActions/resolveCopies 已通过，这里不再返回业务错误。
	private async applyDocumentActions(
		transaction: IDBTransaction,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Promise<void> {
		const documents = transaction.objectStore(STORES.documents);
		const revisions = transaction.objectStore(STORES.documentRevisions);
		for (const [id, action] of actions) {
			// Copies are resolved to their content by `resolveCopies()`.
			// copy 已在 resolveCopies 中变成 base 内容；这里的 content 是最终 base 或 delta，仅退役动作为 undefined。
			const content = action.content;
			let record: DocumentRecord;
			// 新建化身：由存储盖上 createdAt；同一批次退役时同时盖上 retiredAt。
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq,
					// 条件展开 retiredAt：只有创建即退役才写成同一个 seq。
					...(action.retire ? { retiredAt: seq } : {}),
				};
				// addressParts 生成索引列；claimId 登记 ID 归属；add 保证不会覆盖已有行。
				const parts = addressParts(record);
				await this.claimId(transaction, id, "document");
				await requestResult(
					documents.add({
						id,
						...parts,
						createdAt: seq,
						...(action.retire ? { retiredAt: seq } : {}),
						record,
					} satisfies DocumentRow),
				);
			} else {
				// 已有化身：读取当前行以取得记录；行一定存在（检查阶段已确认）。
				record = (await requestResult(documents.get(id) as IDBRequest<DocumentRow>)).record;
			}

			// 有内容命令：写一条修订行，主键 [documentId, seq] 由本次提交 seq 保证唯一。
			if (content !== undefined) {
				// 只保留当前状态的文档遇到新 base：先删掉旧修订，避免历史无限增长。
				// compoundIdRange([id], 0, MAX_KEY) 覆盖该文档的全部修订键。
				if (content.kind === "base" && isCurrentOnly(record)) {
					await requestResult(revisions.delete(compoundIdRange([id], 0, MAX_KEY)));
				}
				// base 行保存 JsonObject，delta 行保存 Op 数组；kind 字段让读取方区分。
				await requestResult(
					revisions.add({
						documentId: id,
						seq,
						kind: content.kind,
						version: content.version,
						content: content.kind === "base" ? content.value : content.ops,
					} satisfies RevisionRow),
				);
			}

			// 退役处理：创建即退役的 retiredAt 已在上面写入；已有化身需要更新行。
			if (action.retire) {
				if (action.create === undefined) {
					// 只改记录的 retiredAt 字段；其它字段保持不变。
					record = { ...record, retiredAt: seq };
					// 读取当前行以保留索引列（kind/family/address 等），再整体 put。
					const row = (await requestResult(documents.get(id) as IDBRequest<DocumentRow>))!;
					await requestResult(documents.put({ ...row, retiredAt: seq, record } satisfies DocumentRow));
				}
				// 只保留当前状态的文档退役后清空修订，释放内容；记录本身保留供历史元数据查询。
				if (isCurrentOnly(record)) {
					await requestResult(revisions.delete(compoundIdRange([id], 0, MAX_KEY)));
				}
			}
		}
	}

	// 所有公开入口共享的关闭检查；关闭后抛普通 Error（生命周期错误，不是请求错误）。
	private assertOpen(): void {
		if (this.closed) throw new Error("IndexedDbStorage is closed");
	}
}

// 再导出打开选项，调用方无需直接导入内部类型即可标注 open/delete 的参数。
export type { IndexedDbStorageOptions };
