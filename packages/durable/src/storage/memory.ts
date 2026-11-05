// 文件导读
// ========
// 所属：packages/durable/src/storage 的 MemoryStorage 后端，是 Durable Storage 契约的脱离式
// （detached）内存参考实现；它同时被 JSONL 后端当作内存状态机复用。
//
// 解决的问题：Session/Harness 需要一个不依赖外部数据库、行为与真实后端一致的 Storage。
// 本文件用普通 Map 和有序 ID 数组保存会话、条目、任务、提交与文档，并在读取时克隆返回值，
// 模拟序列化后端的所有权边界：调用方修改返回值不会影响存储内部状态。
//
// 职责边界：只保证 Storage 契约中的原子批次、全局 ID 归属、会话/条目不可变、文档记录与修订
// 一致性，以及返回值脱离；不校验业务语义（引用是否存在、任务状态迁移是否合法由 Session
// 负责）。上游由 Harness/Session 通过 new MemoryStorage() 注入；下游只依赖 Chord 的
// applyImmutableBatches（重放文档 delta）与本包的 ids/errors/types。
//
// 结果与错误：读取返回 Promise，未知会话、非法游标、读取无历史文档时抛 StorageRequestError
// （只失败该次读取）；提交中 Durable 自己的检查失败通过 CommitResult.refused 返回，已应用的
// 前缀保留；其他异常直接让 Promise 拒绝。
//
// 能力清单：
// - PreparedMemoryCommit（导出接口）：先校验、后应用的提交中间表示，含 seq、深度冻结的
//   writes 和幂等的 apply()。
// - MemoryStorage（导出类）：完整 Storage 实现；prepareCommit 额外公开给 JSONL 后端做
//   “先准备、再编码/落盘、最后应用”的两阶段提交；其余 commit/mintId/读取/close 对应契约。
// - 文件内辅助：深克隆 clone、递归冻结 freeze、有序数组二分 lowerBound/upperBound/insertSorted/
//   removeSorted、fork 感知的 visibleEntries/visibleEntriesAscending、文档动作检查与物化。
//
// 组合与典型顺序：
//   const storage = new MemoryStorage();
//   await storage.commit([[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }]],
//     (index, seq) => { /* 持久化回执 */ }, BACKGROUND_CONTEXT);
//   const page = await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
//   await storage.close(BACKGROUND_CONTEXT);
// commit 对每个 batch 调 prepareCommit（克隆、冻结、检查、解析文档副本），成功后立即 apply；
// 首个被拒绝的 batch 停止后续 batch，并在 Promise 结束前按顺序发送已存批次回执。
//
// 建议阅读顺序：先读 State 与 clone/freeze 理解所有权；再读 PreparedMemoryCommit 与
// commit/prepareCommit；然后读各 scan* 与 fork 链读取（visibleEntries*）；最后读文档
// materializeDocument 与 applyDocumentActions。
//
// 测试：test/memory-storage.test.ts 注册公共存储契约（src/testing/storage-conformance.ts），
// 并额外验证预备提交隔离与“应用中途失败仍发送前缀回执”；多个 harness/codemode 测试用
// MemoryStorage 作为夹具。运行（在 packages/durable 下）：
//   node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/memory-storage.test.ts
import type { Context } from "@earendil-works/chord/context";
import { applyImmutableBatches, type Op } from "@earendil-works/chord/delta";
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

// 下面几个类型别名把存储内部使用的记录与状态形状命名，避免每个函数都写长泛型。
// StoredTask 的三个泛型参数分别是任务输入、状态载荷和结果；Storage 契约统一用 JsonValue，
// 因为存储层不解析任务业务类型。
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
// 从任务记录联合类型里取出 state.status 的字面量联合（pending/running/...）。
// 索引签名 [TaskStatus, TaskId[]] 的键在运行时只是字符串，联合类型只约束编译期可用值。
type TaskStatus = StoredTask["state"]["status"];
// 提交状态：queued（已准入未入转录）、placed（已入转录）、done（已回答）、unanswered（终态）。
type SubmissionStatus = SubmissionRecord["status"];
// 全局 ID 所属的表名；文档写入也算 document 一张表，用于阻止同一 ID 跨表复用。
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
// 一条已存储的文档修订 = 内容（base 或 delta）+ 持久化它的提交序号；seq 由 applyDocumentActions 写入。
// 交叉类型（&）让 DocumentContent 的两个分支都获得 seq 字段。
type DocumentRevision = DocumentContent & { readonly seq: Seq };
// 一个文档化身在内存中的完整状态：记录元数据 + 自创建以来的修订序列。
// 修订按提交顺序 push，seq 单调递增，所以数组顺序就是历史顺序。
type StoredDocumentState = {
	record: DocumentRecord;
	revisions: DocumentRevision[];
};
// 一个批次内针对同一文档的合并动作：create/content/copy/retire 在准备阶段被归并，
// 这样“先建后改”“创建即退役”等组合可以在写入前统一校验，而不是边写边判断。
type DocumentAction = {
	create?: DocumentCreate;
	content?: DocumentContent;
	retire: boolean;
};

// 生成器：从 base 之后的修订逐个产出 ops，供 applyImmutableBatches 顺序重放。
// 输入 id/version 用于错误消息和版本校验，start 是 base 在 revisions 中的下标 + 1。
// 输出是若干组 Op；遇到跨版本却没有新 base 时抛普通 Error（存储一致性错误，不是请求级错误）。
function* documentDeltaBatches(
	id: DocumentId,
	version: number,
	revisions: readonly DocumentRevision[],
	start: number,
): Generator<readonly Op[]> {
	// index 从 base 的下一位开始；revision 的 ! 是类型非空断言，循环条件已保证下标在数组内。
	for (let index = start; index < revisions.length; index++) {
		const revision = revisions[index]!;
		// 同一版本的 delta 才能接在 base 后面；跨版本必须由新的 base 开始，否则无法物化。
		if (revision.kind !== "delta" || revision.version !== version) {
			throw new Error(`Document ${id} crosses a stored version boundary without a base`);
		}
		// yield 把这一组 Op 交给调用者；生成器本身不修改状态，也不缓存结果。
		yield revision.ops;
	}
}

// 文档逻辑地址的索引项：ids 按 ID 升序保存该地址的所有化身；currentId 指向当前未退役的那个。
// currentId 是可选的，因为地址可能只剩历史化身而没有当前化身。
type DocumentAddressIndex = {
	ids: DocumentId[];
	currentId?: DocumentId;
};

// 内存存储的全部可变状态。ID 表的 key 是带品牌的数字 ID（运行时就是 number），地址/作用域索引用字符串键；
// 数组保存按 ID 升序（即创建顺序）的同一批 ID，用于分页扫描和二分查找。
type State = {
	// 全局 ID -> 表名；checkGlobalIds 用它阻止 conversation/entry/document 的 ID 被重写或跨表复用。
	recordTypes: Map<Id<string>, TableName>;
	// 会话 ID -> 不可变会话记录（身份、fork 来源 parent、创建者 owner）。
	conversations: Map<ConversationId, ConversationRecord>;
	// 全部会话 ID 的升序数组，支持无过滤扫描和游标定位。
	conversationIds: ConversationId[];
	// 创建者会话 ID -> 它拥有的会话 ID 升序数组；scanConversations 的 ownerConversationId 过滤使用。
	conversationIdsByOwnerConversation: Map<ConversationId, ConversationId[]>;
	// 创建者任务 ID -> 它创建的会话 ID 升序数组；用于按 ownerTaskId 扫描子树。
	conversationIdsByOwnerTask: Map<TaskId, ConversationId[]>;
	// 条目 ID -> 不可变条目记录（模型消息、应用数据、head 标记等）。
	entries: Map<EntryId, EntryRecord>;
	// 会话 ID -> 该会话直接拥有的条目 ID 升序数组；不含 fork 祖先的条目。
	entryIds: Map<ConversationId, EntryId[]>;
	// 会话 ID -> 带 head 标记的条目 ID 升序数组；findLatestHeadMarker 用它找最近的上下文起点。
	headEntryIds: Map<ConversationId, EntryId[]>;
	// 条目 ID -> 持久化它的提交序号；Storage.entry 的第二个返回值从这里读取。
	entryCommitSeqs: Map<EntryId, Seq>;
	// 任务 ID -> 最新的完整任务记录；同一 ID 会被后续提交覆盖（任务生命周期可变）。
	tasks: Map<TaskId, StoredTask>;
	// 全部任务 ID 升序；scanTasks 没有 status 过滤时从这里扫描。
	taskIds: TaskId[];
	// 任务状态 -> 该状态的 ID 升序数组；状态变化时在旧数组删除、新数组插入。
	taskIdsByStatus: Record<TaskStatus, TaskId[]>;
	// 提交 ID -> 最新提交记录；与任务一样可按同一 ID 更新状态。
	submissions: Map<SubmissionId, SubmissionRecord>;
	// 全部提交 ID 升序，用于无 status 过滤的扫描。
	submissionIds: SubmissionId[];
	// 提交状态 -> 该状态的 ID 升序数组。
	submissionIdsByStatus: Record<SubmissionStatus, SubmissionId[]>;
	// 会话 ID -> 主机去重键 requestId -> 提交 ID；submissionByRequest 用它做幂等查找。
	submissionIdsByRequest: Map<ConversationId, Map<string, SubmissionId>>;
	// 文档 ID -> 化身状态（记录 + 修订序列）。
	documents: Map<DocumentId, StoredDocumentState>;
	// 逻辑地址键（kind + scope + singleton/family）-> 该地址的化身索引。
	documentAddresses: Map<string, DocumentAddressIndex>;
	// 作用域键 -> 该作用域内文档 ID 升序数组；scanDocuments 遍历一个 scope 时使用。
	// 注意这里不区分 kind，kind 过滤在读取时逐条进行。
	documentIdsByScope: Map<string, DocumentId[]>;
};

// 深克隆：把存储内部值转成调用方可安全持有的副本。
// 标量原样返回；数组和对象逐层复制；保留 null 原型（Chord 的 JsonObject 可能没有原型）。
// 这是“脱离式后端”的所有权模拟，不是运行时校验：输入类型已由 StorageWrite 保证。
const clone = <T>(value: T): T => {
	// typeof 为 object 的才需要复制；null 和函数直接返回（JSON 值里不会出现函数）。
	if (value === null || typeof value !== "object") return value;
	// 数组逐项克隆；as T 只是把 unknown[] 收回原泛型，运行时不检查元素类型。
	if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
	// 对象按 Record<string, unknown> 读取；Object.keys 只取自有可枚举字段，符合 JSON 数据形状。
	const source = value as Record<string, unknown>;
	// 保留 null 原型，避免把无原型 JSON 对象变成带 Object.prototype 的普通对象。
	const nullPrototype = Object.getPrototypeOf(value) === null;
	// 创建与源对象同类的容器；空对象字面量 {} 只有在非 null 原型时使用。
	const result = (nullPrototype ? Object.create(null) : {}) as Record<string, unknown>;
	// 遍历源对象的自有键，逐个递归复制。
	for (const key of Object.keys(source)) {
		// 先复制再赋值，避免嵌套结构共享引用。
		const copied = clone(source[key]);
		// 普通对象上直接 result["__proto__"] = x 会触发原型 setter，改变结果的原型而不是创建字段。
		// 因此当键已存在（来自原型链）时改用 defineProperty 定义自有数据属性；null 原型对象没有这个陷阱。
		if (!nullPrototype && key in result) {
			Object.defineProperty(result, key, {
				value: copied,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			// 其余键直接赋值即可，既保持可枚举，也保留 JSON 的原始键名。
			result[key] = copied;
		}
	}
	// 递归完成后收回原泛型 T；对象和数组的形状没有被校验，只是被复制。
	return result as T;
};

// 递归冻结：返回同一个引用，只把对象和数组变成不可写，不做拷贝。
// 用于 PreparedMemoryCommit.writes，让“已预备的写入”无法被调用方篡改；
// 输入应是 JSON 树（无环），否则未冻结的环会无限递归。
const freeze = <T>(value: T): T => {
	// 标量和已经冻结的值直接返回；Object.isFrozen 也避免了重复遍历已冻结的子树。
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	// 先递归冻结所有自有可枚举值（数组元素也在这里），保证父对象冻结后整棵子树仍可安全读取。
	for (const child of Object.values(value)) freeze(child);
	// 子节点都冻结后再冻结父节点；strict mode 下对已冻结值的写入会抛 TypeError。
	return Object.freeze(value);
};

// 解析分页游标的 after 字段：输入是调用方原样传回的 JSON 记录，输出是带品牌的数字 ID。
// after 缺失表示第一页；存在但不是安全整数时抛 StorageRequestError。
// 例：cursorId<EntryId>({ after: 7 }) 返回 7；{ after: 1.5 } 抛错。
const cursorId = <I extends Id<string>>(cursor: Readonly<Record<string, JsonValue>> | undefined): I | undefined => {
	// 可选链：cursor 为 undefined 时整个表达式为 undefined，不抛错。
	const after = cursor?.after;
	// 没有位置就是从头开始；返回 undefined 让调用方区分“无游标”。
	if (after === undefined) return undefined;
	// 调用方可能传入字符串、小数或非有限数；这里在存储读取边界做运行时校验。
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	// idFromNumber 只做类型断言，数字本身已在上一行验证。
	return idFromNumber<I>(after);
};

// 二分查找第一个 >= target 的下标（下界）。ids 是升序的品牌数字数组，比较按数值进行。
// 例：ids = [1, 3, 5]，target = 4 时返回 2（值 5 的位置）。
const lowerBound = <I extends Id<string>>(ids: readonly I[], target: number): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		// low/high 是数组下标，非负且远小于 2^31；>>> 1 等价于 Math.floor((low + high) / 2)。
		const middle = (low + high) >>> 1;
		if (ids[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
};

// 二分查找第一个 > target 的下标（上界）；与 lowerBound 的差别只在比较用了 <=。
// 游标续扫用它跳过已经返回过的 ID。
const upperBound = <I extends Id<string>>(ids: readonly I[], target: number): number => {
	let low = 0;
	let high = ids.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ids[middle] <= target) low = middle + 1;
		else high = middle;
	}
	return low;
};

// 把 ID 插入升序数组：常见情况是新 ID 最大，直接 push；否则二分找到位置后 splice。
// 例：ids 为 [1, 3]、插入 idFromNumber<EntryId>(2) 后得到 [1, 2, 3]。副作用是原地修改 ids。
const insertSorted = <I extends Id<string>>(ids: I[], id: I): void => {
	// 快路径：空数组或新 ID 大于当前最大值，追加即可。
	if (ids.length === 0 || ids[ids.length - 1] < id) ids.push(id);
	// 慢路径：lowerBound 找到第一个 >= id 的位置，把 id 插在它前面。
	else ids.splice(lowerBound(ids, id), 0, id);
};

// 从升序数组删除 ID：二分定位后只在值确实相等时 splice，缺失时安静地什么也不做。
const removeSorted = <I extends Id<string>>(ids: I[], id: I): void => {
	// lowerBound 给出可能的位置；ids[index] 与 id 都是品牌数字，直接全等比较。
	const index = lowerBound(ids, id);
	// 只有精确命中才删除，避免误删相邻 ID。
	if (ids[index] === id) ids.splice(index, 1);
};

// 在 Map 的分组数组里插入 ID：键不存在时先建空数组，再走 insertSorted。
const insertMapId = <K, I extends Id<string>>(index: Map<K, I[]>, key: K, id: I): void => {
	// 先取分组；undefined 表示这是该 owner 的第一个记录。
	let ids = index.get(key);
	if (ids === undefined) {
		ids = [];
		// 新数组挂回 Map；同一个数组后续会被原地修改。
		index.set(key, ids);
	}
	// 保持组内 ID 升序，供游标二分使用。
	insertSorted(ids, id);
};

// 作用域的结构化键：用 JSON 数组字符串区分 session / conversation / task。
// Map 的键按引用比较，因此必须先把结构压成字符串；数值 ID 放在数组里被序列化。
const scopeKey = (scope: DocumentRecord["scope"]): string => {
	switch (scope.kind) {
		// session 没有自己的 ID，用固定单元素数组表示。
		case "session":
			return JSON.stringify(["session"]);
		// conversation 作用域带会话 ID。
		case "conversation":
			return JSON.stringify(["conversation", scope.conversationId]);
		// task 作用域带任务 ID；switch 已穷尽联合类型，因此不需要 default。
		case "task":
			return JSON.stringify(["task", scope.taskId]);
	}
};

// 文档逻辑地址键：kind + 作用域键 + singleton/family 标记。
// key 缺失表示单例（singleton），存在表示带键的家族成员（family）；两种形状用不同 JSON 数组，
// 因此字符串键不会与某个真实 key 冲突。
const addressKey = (address: DocumentAddress): string =>
	JSON.stringify([
		// 地址的 kind 是文档定义类别，如 "pi.agent"。
		address.kind,
		scopeKey(address.scope),
		// key 为 undefined 时写成 ["singleton"]；否则写成 ["family", key]。
		address.key === undefined ? ["singleton"] : ["family", address.key],
	]);

// 从完整文档记录或创建参数构造地址键；记录里的 key 可能与创建参数一样缺失。
const recordAddressKey = (record: DocumentRecord | DocumentCreate): string =>
	addressKey({ kind: record.kind, scope: record.scope, key: record.key });

// 判断文档化身在某个读取点是否存活。
// "current" 只看是否未退役；历史点要求 createdAt <= at 且 retiredAt 缺失或 at < retiredAt。
// 退役提交本身（at === retiredAt）不再算存活，所以上下界都是精确的提交序号。
const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	// current 是 DocumentPoint 的特殊字面量，不是 Seq；先处理它避免把字符串当数字比较。
	if (at === "current") return record.retiredAt === undefined;
	// 历史存活区间：[createdAt, retiredAt)；没有 retiredAt 表示一直存活到现在。
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

// 是否只保留当前状态：session/task 作用域的文档没有历史，conversation 文档若 history 为 latest 也没有。
// 对这些文档做历史读取会抛 StorageRequestError，而不是返回伪造的旧值。
const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

// 查询全局 ID 所属表；undefined 表示这个 ID 还没被占用。
const tableContaining = (state: State, id: Id<string>): TableName | undefined => state.recordTypes.get(id);

// 把扫描结果切成页：最多 limit 条；只有传入超过 limit 条（调用方通常取 limit+1）时才生成 next。
// 返回值中的 items 经过 clone，调用方无法通过修改数组元素影响存储；next 由末项 ID 与方向生成。
const page = <T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<T, Cursor> => {
	// slice 不修改原数组；items 的长度最多是 limit。
	const items = values.slice(0, limit);
	// 没有多余元素说明已经到末页，Page.next 保持缺失。
	if (values.length <= limit) return { items: clone(items) };
	// items.at(-1)! 取末项；values.length > limit 时末项一定存在，! 表示这个不变量。
	return { items: clone(items), next: nextCursor(items.at(-1)!.id, order) };
};

/** Indexes of sorted `ids` in scan order, after the cursor's ID when there is one. */
// 按扫描方向产出 ids 的下标，cursor 指向的 ID 已被上一页返回，因此从它之后开始。
// 升序用 upperBound 跳过 <= after 的项；降序用 lowerBound 找到第一个 >= after 的位置再减一。
// 这是生成器：每次 yield 一个下标，不复制 ids，也不修改它。
function* scanIndexes(ids: readonly Id<string>[], start: ScanStart): Generator<number> {
	if (start.order === "ascending") {
		// 升序：没有游标从 0 开始，有游标从第一个大于 after 的位置开始。
		const first = start.after === undefined ? 0 : upperBound(ids, start.after);
		for (let index = first; index < ids.length; index++) yield index;
	} else {
		// 降序：lowerBound 给出第一个 >= after 的位置，减一后正好是最后一个 < after 的位置。
		const end = start.after === undefined ? ids.length : lowerBound(ids, start.after);
		for (let index = end - 1; index >= 0; index--) yield index;
	}
}

// 预备提交的公开表示：prepareCommit 先完成所有可能失败的检查，返回这个对象；
// 调用方随后可以选择何时 apply（MemoryStorage.commit 立即应用，JSONL 后端先落盘再应用）。
// seq 是这次提交的序号；writes 是已克隆并深度冻结的写入；apply 幂等并返回 seq。
/** A fully validated, detached state mutation whose application performs no fallible preparation. */
export interface PreparedMemoryCommit {
	// 序号在准备时确定，保证同一次提交的文档修订与回执使用同一个 seq。
	readonly seq: Seq;
	/** Deeply frozen detached writes for persistence. */
	// 冻结后的写入可以安全交给持久化层读取；调用方改动会在运行时抛 TypeError。
	readonly writes: readonly StorageWrite[];
	// apply 只应用已经校验过的写入，不再做可失败的准备；重复调用只生效一次。
	apply(): Seq;
}

// 类的总体说明见文件导读。这里补充实现要点：所有公开读取方法都是 async（即使内部同步完成），
// 以符合 Storage 接口；所有返回值经过 clone，提交路径写入的是 clone+freeze 后的副本。
/**
 * Detached in-memory reference implementation of `Storage`.
 *
 * Reads and retained writes are cloned intentionally to match the ownership boundary
 * of serialization-backed stores. This is backend conformance, not validation.
 */
// 一个 MemoryStorage 实例独占一份 State；没有共享的模块级缓存，因此多个实例互不影响。
export class MemoryStorage implements Storage {
	// state 用 readonly 字段声明，但容器本身可变：Map/数组在提交时原地更新；readonly 只禁止换掉整个对象。
	private readonly state: State = {
		recordTypes: new Map(),
		conversations: new Map(),
		conversationIds: [],
		conversationIdsByOwnerConversation: new Map(),
		conversationIdsByOwnerTask: new Map(),
		entries: new Map(),
		entryIds: new Map(),
		headEntryIds: new Map(),
		entryCommitSeqs: new Map(),
		tasks: new Map(),
		taskIds: [],
		taskIdsByStatus: { pending: [], running: [], waiting: [], sleeping: [], completing: [], terminal: [] },
		submissions: new Map(),
		submissionIds: [],
		submissionIdsByStatus: { queued: [], placed: [], done: [], unanswered: [] },
		submissionIdsByRequest: new Map(),
		documents: new Map(),
		documentAddresses: new Map(),
		documentIdsByScope: new Map(),
	};
	// 下一个可分配的全局 ID。初始为 2，因为根会话固定占用 ID 1。
	// 与 nextSeq 分开：ID 标识实体，seq 标识提交历史位置。
	private nextId = 2;
	// 下一个提交序号，从 1 开始；每次 apply 后变成 seq + 1。
	private nextSeq = 1;
	// close 后所有公开方法先经过 assertOpen 并抛错；内存后端没有需要释放的底层资源。
	private closed = false;

	// 提交多个批次：每个 batch 是一个独立的原子提交，拥有自己的 seq，并针对前面 batch 留下的状态做检查。
	// 输入 batches 至少一个 batch；receive(index, seq) 是持久化回执，按顺序同步调用；
	// context 在这里不参与内存操作（参数保留给 Storage 接口）。
	// 输出 CommitResult：stored 是已应用批次数量，refused 是首个被 Durable 检查拒绝的错误。
	// 首个被拒绝的 batch 停止后续 batch；之前已应用的 batch 保留，其回执仍会发送。
	// 例：commit([[rootWrite], [badWrite]], receive) 中第二批 ID 冲突时返回 { stored: 1, refused }。
	/**
	 * Apply `batches` one by one, each checked against the state the earlier ones left (`prepareCommit()`, which only
	 * checks and detaches, so a batch it refuses changed nothing); stops at the first one refused. Memory is durable at
	 * once; the receipts follow the last batch.
	 */
	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		_context: Context,
	): Promise<CommitResult> {
		// 已关闭时立即失败；后面的批次不会开始。
		this.assertOpen();
		// 记录每个已应用 batch 的 seq，用于 finally 中的回执循环。
		const seqs: Seq[] = [];
		// refused 用对象包一层，让“没有拒绝”和“拒绝值为 undefined”在类型上可区分。
		let refused: { readonly error: unknown } | undefined;
		try {
			// 严格按顺序处理 batch：后一个 batch 的检查看到前一个 batch 已应用的状态。
			for (const writes of batches) {
				// 先声明再在 try 中赋值：只有 prepareCommit 成功返回后才执行 apply。
				let prepared: PreparedMemoryCommit;
				try {
					// prepareCommit 只做克隆、冻结和检查；它不改变可观察状态，所以拒绝时无需回滚。
					prepared = this.prepareCommit(writes);
					// 任何准备阶段异常都被当作 Durable 的拒绝：记录首个错误并停止后续 batch。
				} catch (error) {
					refused = { error };
					break;
				}
				// apply 之后再记录 seq；如果 apply 抛错，这个 batch 不会被加入回执列表。
				seqs.push(prepared.apply());
			}
			// finally 保证回执一定发送：即使某个 apply 抛错、Promise 拒绝，之前已应用的批次仍算已存储。
			// 这正是 Storage 契约要求的“已发送的回执在拒绝后仍然有效”。
		} finally {
			// Also when a batch's apply throws: the batches applied before it are stored, and their receipts stand.
			// 同步按顺序调用 receive；此时这些 batch 已经变更了内存状态。
			for (const [index, seq] of seqs.entries()) receive(index, seq);
		}
		// 有 refused 时返回其原始错误对象；没有时只返回 stored 数量。
		return refused === undefined ? { stored: seqs.length } : { stored: seqs.length, refused: refused.error };
	}

	// 准备一次提交：校验序号严格递增，克隆并冻结写入，解析 document.copy，执行全局 ID 与文档检查。
	// 输入 writes 是一个 batch 的原始写入；seq 可选，默认取当前 nextSeq（JSONL 重放可显式传入）。
	// 输出 PreparedMemoryCommit；不修改 state，也不推进 nextSeq——这些只发生在 apply 中。
	// 错误：序号不递增、ID 冲突、文档动作非法、副本源不可读等都以异常抛出，调用方据此拒绝该 batch。
	// 例：const prepared = storage.prepareCommit(writes, seqFromNumber(5)); prepared.apply();
	// 这个“先准备后应用”的拆分是 JSONL 后端在落盘前复用同一套检查的依据。
	/** Validate and detach one commit without changing observable state. */
	prepareCommit(writes: readonly StorageWrite[], seq: Seq = seqFromNumber(this.nextSeq)): PreparedMemoryCommit {
		this.assertOpen();
		// 显式 seq 必须是非负安全整数，并且不小于 nextSeq：不能重放已应用的序号；
		// 允许跳跃（例如恢复或导入），apply 后 nextSeq 直接跟到 seq + 1。
		if (!Number.isSafeInteger(seq) || seq < this.nextSeq) {
			throw new Error(`Commit sequence ${seq} does not strictly increase`);
		}
		// 先深克隆写入，解析副本（读取的是当前 state），再递归冻结；之后这些对象不再被内部引用修改。
		// 顺序很重要：resolveDocumentCopies 需要读旧状态，clone 保证调用方之后改原对象不影响预备提交。
		const detachedWrites = freeze(this.resolveDocumentCopies(writes.map((write) => clone(write))));
		// 全局 ID 归属检查：conversation/entry/document 不可重写，task/submission 可更新。
		this.checkGlobalIds(detachedWrites);
		// 把同一文档的多条写入合并成 create/content/retire 动作，并顺手发现重复内容命令。
		const documentActions = this.prepareDocumentActions(detachedWrites);
		// 针对现有状态检查文档是否存在、是否已退役、delta 版本是否衔接、地址是否出现第二个当前化身。
		this.checkDocumentActions(documentActions);
		// applied 标志让 apply 幂等；JSONL 后端可能因重试或调用方重复调用而多次触发同一个 prepared。
		let applied = false;
		return {
			seq,
			writes: detachedWrites,
			// 闭包捕获已校验的 detachedWrites/documentActions/seq；apply 本身不再做检查。
			apply: () => {
				// 已经应用过就直接返回 seq，不重复写索引或推进 nextSeq。
				if (!applied) {
					applied = true;
					// 应用所有表写入和文档动作，并把 nextSeq 推进到 seq + 1。
					this.applyPreparedCommit(detachedWrites, documentActions, seq);
				}
				return seq;
			},
		};
	}

	// 把 document.copy 写入改写成等价的 document.create（内容为源文档在指定点的 base）。
	// 输入是已克隆的写入数组；返回新数组，未含 copy 时直接返回原数组（避免无谓分配）。
	// 约束：源文档不能在同一批次里被创建/修改/退役，否则复制结果依赖批次内顺序而不可定义。
	// 错误：源不可读、记录种类/作用域/key/history/fork 不匹配时抛错，并用 cause 保留底层原因。
	// 例：复制 A@current 得到 B 的初始 base；B 只拿到该点的值，不共享 A 之后的修改。
	private resolveDocumentCopies(writes: StorageWrite[]): StorageWrite[] {
		// 快路径：没有 copy 就不扫描、不分配新的 Set。
		if (!writes.some((write) => write.type === "document.copy")) return writes;
		// 记录本批次会改变的所有文档 ID，用于拒绝“复制源同时被修改”。
		const changedDocumentIds = new Set<DocumentId>();
		for (const write of writes) {
			if (write.type === "document.create" || write.type === "document.copy") {
				changedDocumentIds.add(write.record.id);
			} else if (write.type === "document.change" || write.type === "document.retire") {
				changedDocumentIds.add(write.id);
			}
		}
		return writes.map((write) => {
			if (write.type !== "document.copy") return write;
			try {
				// 源文档在本批次内被改写时，复制应读哪个版本无法定义，直接拒绝。
				if (changedDocumentIds.has(write.source.id)) {
					throw new Error(`Fork source document ${write.source.id} is changed in the copy batch`);
				}
				// 物化源文档在 source.at 的状态；historical 读取可能因无历史而抛 StorageRequestError。
				const stored = this.materializeDocument(write.source.id, write.source.at);
				// 源不存在或在该点不存活：复制没有可用的初始值。
				if (stored === undefined) throw new Error(`Fork source document ${write.source.id} cannot be read`);
				// 副本记录必须与源记录逐项兼容：两者都必须是 conversation 作用域，且 kind/key/history/fork 一致。
				// scope.kind 检查两次是因为源和副本是两个独立对象，TypeScript 不能从一个收窄另一个。
				if (
					stored.record.scope.kind !== "conversation" ||
					write.record.scope.kind !== "conversation" ||
					stored.record.kind !== write.record.kind ||
					stored.record.key !== write.record.key ||
					stored.record.history !== write.record.history ||
					stored.record.fork !== write.record.fork
				) {
					throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
				}
				// 用源文档物化结果构造 base：version 沿用源的版本号，value 是脱离式 JSON 值。
				return {
					type: "document.create",
					record: write.record,
					content: { kind: "base", version: stored.version, value: stored.value },
				};
				// 任何复制失败都加上“Document copy <id> was rejected”上下文；cause 保留原始错误供诊断。
				// 这层包装不影响检查语义，只改善错误消息的定位能力。
			} catch (error) {
				throw new Error(`Document copy ${write.record.id} was rejected`, { cause: error });
			}
		});
	}

	// 应用已校验的写入：按顺序更新各表、维护所有索引，最后统一应用文档动作并推进 nextSeq。
	// 这个方法假设调用前已完成全部检查，因此这里不返回错误，只做状态变更；只能由 apply 调用一次。
	private applyPreparedCommit(
		prepared: readonly StorageWrite[],
		documentActions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Seq {
		// 顺序遍历批次内的写入，同一个 ID 的后续 task/submission 写入会覆盖前一条记录。
		for (const write of prepared) {
			switch (write.type) {
				// conversation 创建后不可变：登记 ID 归属、记录、全局 ID 数组和 owner 索引。
				case "conversation": {
					this.state.recordTypes.set(write.value.id, "conversation");
					this.state.conversations.set(write.value.id, write.value);
					insertSorted(this.state.conversationIds, write.value.id);
					// owner 是可选的创建者边；只有存在时才进入按会话/任务分组的索引。
					const owner = write.value.owner;
					if (owner !== undefined) {
						insertMapId(this.state.conversationIdsByOwnerConversation, owner.conversationId, write.value.id);
						insertMapId(this.state.conversationIdsByOwnerTask, owner.taskId, write.value.id);
					}
					// 记录中可能带有比分配器更大的 ID（例如测试或重放），把 nextId 抬到最大已见 ID + 1。
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				// entry 同样不可变；除记录本身外还要维护会话条目索引、head 索引和提交序号。
				case "entry": {
					this.state.recordTypes.set(write.value.id, "entry");
					this.state.entries.set(write.value.id, write.value);
					// 条目所属提交就是当前 batch 的 seq；entry() 读取时原样返回。
					this.state.entryCommitSeqs.set(write.value.id, seq);
					let ids = this.state.entryIds.get(write.value.conversationId);
					if (ids === undefined) {
						ids = [];
						this.state.entryIds.set(write.value.conversationId, ids);
					}
					insertSorted(ids, write.value.id);
					// 只有带 head 的条目进入 head 索引；没有 head 的普通条目不会出现在 findLatestHeadMarker 的结果里。
					if (write.value.head !== undefined) {
						let headIds = this.state.headEntryIds.get(write.value.conversationId);
						if (headIds === undefined) {
							headIds = [];
							this.state.headEntryIds.set(write.value.conversationId, headIds);
						}
						insertSorted(headIds, write.value.id);
					}
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				// task 是可更新的生命周期记录：同一 ID 可能多次提交，每次覆盖记录并维护状态索引。
				case "task": {
					this.state.recordTypes.set(write.value.id, "task");
					const previous = this.state.tasks.get(write.value.id);
					// 首次出现：同时进入全局任务数组和对应状态数组。
					if (previous === undefined) {
						insertSorted(this.state.taskIds, write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
						// 已存在：只有状态变化时才在状态索引之间移动，taskIds 本身不变。
					} else if (previous.state.status !== write.value.state.status) {
						removeSorted(this.state.taskIdsByStatus[previous.state.status], write.value.id);
						insertSorted(this.state.taskIdsByStatus[write.value.state.status], write.value.id);
					}
					this.state.tasks.set(write.value.id, write.value);
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				// submission 与 task 类似，另外维护 conversationId + requestId 的去重索引。
				case "submission": {
					this.state.recordTypes.set(write.value.id, "submission");
					const previous = this.state.submissions.get(write.value.id);
					if (previous === undefined) {
						insertSorted(this.state.submissionIds, write.value.id);
						insertSorted(this.state.submissionIdsByStatus[write.value.status], write.value.id);
					} else if (previous.status !== write.value.status) {
						removeSorted(this.state.submissionIdsByStatus[previous.status], write.value.id);
						insertSorted(this.state.submissionIdsByStatus[write.value.status], write.value.id);
					}
					// 更新前先清理旧的 requestId 映射；只有它确实指向当前提交时才删除，避免误删别人的键。
					if (previous?.requestId !== undefined) {
						const previousRequests = this.state.submissionIdsByRequest.get(previous.conversationId);
						if (previousRequests?.get(previous.requestId) === write.value.id) {
							previousRequests.delete(previous.requestId);
							// 该会话没有其它 requestId 时删除整个内层 Map，保持索引紧凑。
							if (previousRequests.size === 0) this.state.submissionIdsByRequest.delete(previous.conversationId);
						}
					}
					this.state.submissions.set(write.value.id, write.value);
					// 新记录带 requestId 时写入去重索引；requestId 可缺失（普通输入没有主机去重键）。
					if (write.value.requestId !== undefined) {
						let requests = this.state.submissionIdsByRequest.get(write.value.conversationId);
						if (requests === undefined) {
							requests = new Map();
							this.state.submissionIdsByRequest.set(write.value.conversationId, requests);
						}
						requests.set(write.value.requestId, write.value.id);
					}
					this.nextId = Math.max(this.nextId, write.value.id + 1);
					break;
				}
				// 所有 copy 在 resolveDocumentCopies 中已改写成 create，这里遇到 copy 说明内部流程被破坏。
				case "document.copy":
					throw new Error("Prepared document copy was not resolved");
				// 文档写入不在这里落表，交给下面的 applyDocumentActions 统一处理修订与地址索引。
				case "document.create":
				case "document.change":
				case "document.retire":
					break;
			}
		}

		// 应用文档动作：创建化身、追加修订、标记退役，并更新地址的 currentId。
		this.applyDocumentActions(documentActions, seq);
		// 内存中的下一个序号严格递增；后续默认 seq 从这里取。
		this.nextSeq = seq + 1;
		return seq;
	}

	// 分配一个新的全局 ID：内存中只是自增计数器，但仍检查安全整数上限以匹配持久化后端。
	// 返回的是自增前的值；nextId++ 是后置自增。例：nextId 为 7 时返回 7，之后 nextId 为 8。
	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		// Number.isSafeInteger 排除超出 2^53-1 的值；ID 一旦不能精确表示就会破坏排序与唯一性。
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		// idFromNumber 只施加编译期品牌；运行时返回普通数字。
		return idFromNumber<I>(this.nextId++);
	}

	// 按 ID 读取会话：找到时返回克隆，未知 ID 返回 undefined（读取未知会话不算错误，扫描才要求会话存在）。
	// 输入是品牌 ConversationId；输出是脱离式 ConversationRecord。
	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const value = this.state.conversations.get(id);
		return value === undefined ? undefined : clone(value);
	}

	// 按 ID 顺序扫描会话，可按创建者会话或创建者任务过滤。
	// 输入 query.order（默认升序）、limit、上一页游标；输出 Page，items 为克隆记录，next 为继续游标。
	// 流程：优先走 owner 索引数组，再按 ownerConversationId 二次过滤，最后用 scanIndexes 定位游标。
	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		// 选择候选 ID 数组：ownerTaskId 优先（任务子树），其次 ownerConversationId，最后全部会话。
		// ?? [] 把“索引里没有该 owner”转成空数组，循环自然产出一页空结果。
		const ids =
			query.ownerTaskId !== undefined
				? (this.state.conversationIdsByOwnerTask.get(query.ownerTaskId) ?? [])
				: query.ownerConversationId !== undefined
					? (this.state.conversationIdsByOwnerConversation.get(query.ownerConversationId) ?? [])
					: this.state.conversationIds;
		const start = scanStart(query.order, cursor, "ascending");
		const values: ConversationRecord[] = [];
		// scanIndexes 是生成器；for...of 会逐个取值，游标之后的 ID 才开始产出。
		for (const index of scanIndexes(ids, start)) {
			// 多收集一条用于判断是否还有下一页：values.length > limit 时 page() 会生成 next。
			if (values.length > limit) break;
			const value = this.state.conversations.get(ids[index]!)!;
			// ownerTaskId 索引只按任务分组，若同时给了 ownerConversationId，还要在这里做二次过滤。
			if (query.ownerConversationId !== undefined && value.owner?.conversationId !== query.ownerConversationId) {
				continue;
			}
			values.push(value);
		}
		// page 负责截断到 limit、克隆 items、并在多余时用末项 ID 生成游标。
		return page(values, limit, start.order);
	}

	// entry 有两个重载：只给条目 ID 时按全局 ID 读取；给会话 ID 时还要求条目在该会话的 fork 链上可见。
	// 重载只存在于编译期；运行时由实现签名根据参数个数和类型区分。
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	// 实现签名把两种调用合并：两参数时 context 为 undefined，三参数时 context 有值。
	// 返回值要么 undefined，要么同时带 entry 与持久化它的 commitSeq。
	async entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		this.assertOpen();
		// context === undefined 表示两参数重载 (id, context)：第一个参数实际是条目 ID。
		if (context === undefined) {
			const id = idFromNumber<EntryId>(idOrConversationId);
			const entry = this.state.entries.get(id);
			// 全局读取不检查祖先可见性；未找到就是 undefined。
			if (entry === undefined) return undefined;
			return { entry: clone(entry), commitSeq: this.state.entryCommitSeqs.get(id)! };
		}
		// 三参数重载下第二个参数应为 EntryId；typeof 检查覆盖绕过 TypeScript 的 JS 调用，
		// 类型正确的调用不会走到这里。
		if (typeof idOrContext !== "number") throw new StorageRequestError("Storage.entry() requires an entry ID");
		const conversationId = idFromNumber<ConversationId>(idOrConversationId);
		const id = idFromNumber<EntryId>(idOrContext);
		// 先恢复 conversationId，再用可见性生成器查找恰好等于 id 的条目；找不到说明条目存在但不在此 fork 链上。
		const entry = this.visibleEntries(conversationId, id, id).next().value;
		if (entry === undefined) return undefined;
		return { entry: clone(entry), commitSeq: this.state.entryCommitSeqs.get(id)! };
	}

	// 查找会话 fork 链上最新的 head 标记，可给定包含式的条目上界。
	// 输入 conversationId 与可选 atOrBeforeEntryId；输出条目记录本身加上它的 head 值（真正的上下文下界）。
	// 流程：从当前会话开始，在自己的 head 索引里找 <= upper 的最大 ID；没有就沿 parent 上溯，
	// 同时把 upper 收紧到 parent.at。未知会话抛 StorageRequestError。
	// 例：在 fork 出来的会话里没有新 head 时，返回父会话在 fork 点之前的最近 head。
	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		this.assertOpen();
		// 会话必须存在；这是请求级错误，只影响本次读取。
		if (!this.state.conversations.has(conversationId)) {
			throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		// 没有上界时用正无穷，表示“到最新为止”；有上界时只考虑该 ID 及更早的 head。
		let upperEntryId = atOrBeforeEntryId ?? Number.POSITIVE_INFINITY;
		while (true) {
			// headEntryIds 按 ID 升序；upperBound - 1 是最后一个 <= upper 的位置。
			const ids = this.state.headEntryIds.get(currentId) ?? [];
			const index = upperBound(ids, upperEntryId) - 1;
			if (index >= 0) {
				const entry = this.state.entries.get(ids[index])!;
				// head 字段在进入索引时一定存在；head! 把这个不变量告诉 TypeScript。
				// 展开 {...entry, head: ...} 生成新对象，随后 clone 保证返回值脱离。
				return clone({ ...entry, head: entry.head! });
			}
			// 当前会话没有可用 head，接着沿 fork 来源查找。
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) return undefined;
			// 父会话只能贡献 fork 点及更早的条目；与已有上界取较小值，防止越过 fork。
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			currentId = conversation.parent.conversationId;
		}
	}

	// 扫描一个会话的可见条目，默认降序（最新在前），可按 ID 范围过滤并分页。
	// 输入 EntryQuery（conversationId 必填、min/maxEntryId 可选、order 可省略）与游标；
	// 输出 Page<EntryRecord>。未知会话抛 StorageRequestError；items 均为克隆。
	// 流程：把游标转换成 min/max 的一侧收紧，再选择降序或升序生成器。
	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		this.assertOpen();
		// 条目扫描默认 descending；游标携带的方向优先于 query.order。
		const { order, after } = scanStart(query.order, cursor, "descending");
		// The cursor narrows the bound on the side the scan moves away from.
		let minEntryId: number | undefined = query.minEntryId;
		// 游标指向上一页最后一项：降序时后续项必须更小（<= after-1），升序时后续项必须更大（>= after+1）。
		let maxEntryId: number | undefined = query.maxEntryId;
		if (after !== undefined && order === "descending") maxEntryId = Math.min(maxEntryId ?? after, after - 1);
		if (after !== undefined && order === "ascending") minEntryId = Math.max(minEntryId ?? after, after + 1);
		const visible: EntryRecord[] = [];
		// 生成器按可见性逐条产出；多读一条用于 page() 判断下一页。
		const entries =
			order === "descending"
				? this.visibleEntries(query.conversationId, minEntryId, maxEntryId)
				: this.visibleEntriesAscending(query.conversationId, minEntryId, maxEntryId);
		for (const entry of entries) {
			visible.push(entry);
			if (visible.length > limit) break;
		}
		// 显式传 order 给 page，让 next 游标记录本次实际扫描方向。
		return page(visible, limit, order);
	}

	// 按 ID 读取任务的最新完整记录；未知任务返回 undefined。
	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const value = this.state.tasks.get(id);
		return value === undefined ? undefined : clone(value);
	}

	// 扫描任务：有 status 时走状态索引，否则走全局 ID 数组；其余过滤条件逐条应用。
	// 输出按 ID 升序/降序分页；所有匹配条件之间是逻辑与。
	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		// 有状态过滤时只扫描该状态的 ID 数组，避免遍历全部任务。
		const ids = query.status === undefined ? this.state.taskIds : this.state.taskIdsByStatus[query.status];
		const values: StoredTask[] = [];
		for (const index of scanIndexes(ids, start)) {
			if (values.length > limit) break;
			const value = this.state.tasks.get(ids[index]!)!;
			// 状态索引已经保证 status 匹配；这里继续过滤会话、kind、abortRequested、background。
			// 注意 background/abortRequested 是布尔值，直接与记录字段比较。
			if (query.conversationId !== undefined && value.conversationId !== query.conversationId) continue;
			if (query.kind !== undefined && value.kind !== query.kind) continue;
			if (query.abortRequested !== undefined && value.abortRequested !== query.abortRequested) continue;
			if (query.background !== undefined && value.background !== query.background) continue;
			values.push(value);
		}
		return page(values, limit, start.order);
	}

	// 按 ID 读取提交的最新记录；未知提交返回 undefined。
	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const value = this.state.submissions.get(id);
		return value === undefined ? undefined : clone(value);
	}

	// 扫描提交：有 status 时走状态索引，否则走全部提交 ID；再按 conversationId 二次过滤。
	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const start = scanStart(query.order, cursor, "ascending");
		// 状态过滤与全量扫描共用同一套 scanIndexes 游标语义。
		const ids =
			query.status === undefined ? this.state.submissionIds : this.state.submissionIdsByStatus[query.status];
		const values: SubmissionRecord[] = [];
		for (const index of scanIndexes(ids, start)) {
			if (values.length > limit) break;
			const value = this.state.submissions.get(ids[index]!)!;
			if (query.conversationId !== undefined && value.conversationId !== query.conversationId) continue;
			values.push(value);
		}
		return page(values, limit, start.order);
	}

	// 按会话 + requestId 查提交：这是主机传入的去重键，同一会话内唯一。
	// 先查内层 Map，再通过 ID 取记录并克隆；没有映射时返回 undefined。
	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const id = this.state.submissionIdsByRequest.get(conversationId)?.get(requestId);
		if (id === undefined) return undefined;
		return clone(this.state.submissions.get(id)!);
	}

	// 在指定读取点查找占用某个逻辑地址的文档化身（单例或家族成员）。
	// current 返回当前未退役的化身；历史点返回在该 seq 存活的那个化身。
	// 地址索引只保存同一地址的化身；currentId 是快路径，历史读取按创建顺序找第一个存活的。
	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		// 地址键由 kind + scope + singleton/family 组成；没有该地址时 index 为 undefined。
		const index = this.state.documentAddresses.get(addressKey(address));
		// current 直接用缓存的 currentId；可选链同时处理“索引不存在”和“没有当前化身”。
		if (at === "current") {
			return index?.currentId === undefined ? undefined : clone(this.state.documents.get(index.currentId)!.record);
		}
		// 历史点没有单一 currentId，按 ID 升序检查每个化身：同一地址的 createdAt 随 ID 递增，
		// 第一个存活的化身就是该点的有效化身。
		for (const id of index?.ids ?? []) {
			const record = this.state.documents.get(id)!.record;
			if (isAliveAt(record, at)) return clone(record);
		}
		return undefined;
	}

	// 按具体化身 ID 物化文档，不跟随地址替换；返回记录、定义版本、物化值和 delta 数量。
	// 历史读取对只保留当前状态的文档抛 StorageRequestError；不存在或该点不存活返回 undefined。
	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		const stored = this.materializeDocument(id, at);
		// materializeDocument 返回的是内部记录引用，这里逐字段克隆后再交给调用方。
		return stored === undefined
			? undefined
			: {
					record: clone(stored.record),
					version: stored.version,
					value: clone(stored.value),
					deltasSinceBase: stored.deltasSinceBase,
				};
	}

	// 扫描一个作用域内在指定点存活的文档化身，按 ID 升序；可按 kind 过滤。
	// 文档扫描方向固定为升序，游标只用 after（忽略可能存在的 order）。
	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		// documentIdsByScope 只按作用域分组，kind 过滤在循环里做。
		const ids = this.state.documentIdsByScope.get(scopeKey(query.scope)) ?? [];
		// cursorId 校验并取出上一页末项 ID；undefined 表示第一页。
		const after = cursorId(cursor);
		// upperBound 跳过已返回的 ID：从第一个 > after 的位置开始。
		const start = after === undefined ? 0 : upperBound(ids, after);
		const values: DocumentRecord[] = [];
		// values.length <= limit 作为循环条件，允许收集 limit+1 条以检测下一页；page() 会再截断。
		for (let index = start; index < ids.length && values.length <= limit; index++) {
			const record = this.state.documents.get(ids[index]!)!.record;
			// kind 过滤是逐条判断：scope 索引没有把 kind 放进键。
			if (query.kind !== undefined && record.kind !== query.kind) continue;
			// 只返回在 query.at 存活的化身；历史点可能命中多个化身，它们都属于同一 scope。
			if (isAliveAt(record, query.at)) values.push(record);
		}
		return page(values, limit);
	}

	// 关闭存储：设置 closed 后，所有公开方法在 assertOpen 处抛错。
	// 内存后端没有异步资源，所以不需要等待在途操作。
	async close(_context: Context): Promise<void> {
		this.closed = true;
	}

	// 物化一个文档化身：找到读取点之前最新的 base，重放其后的 delta，返回最终 JSON 值。
	// 输入 id 与 DocumentPoint（"current" 或某个提交 seq）；输出 StoredDocument 或 undefined。
	// 错误：历史读取只保留当前状态的文档抛 StorageRequestError；缺少 base 或跨版本 delta 抛普通 Error。
	// deltasSinceBase 统计重放了多少条 delta，供上层判断是否值得写新的 base。
	private materializeDocument(id: DocumentId, at: DocumentPoint): StoredDocument | undefined {
		const stored = this.state.documents.get(id);
		// 没有这个化身直接返回；调用方无法区分“从未存在”和“ID 错误”，两者都是 undefined。
		if (stored === undefined) return undefined;
		// 历史读取被保留策略禁止时明确报错，而不是返回当前值。
		if (at !== "current" && isCurrentOnly(stored.record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(stored.record, at)) return undefined;
		// current 使用全部修订；历史点只使用 seq <= at 的修订（记录存活检查已保证 at 在生命周期内）。
		const revisions = at === "current" ? stored.revisions : stored.revisions.filter((revision) => revision.seq <= at);
		// 从末尾向前找最近的 base；base 把历史切成可独立重放的段。
		let baseIndex = revisions.length - 1;
		while (baseIndex >= 0 && revisions[baseIndex]!.kind !== "base") baseIndex--;
		const base = revisions[baseIndex];
		// 没有 base 意味着存储损坏：创建文档时必定写入 base，后续也只在版本切换时写新 base。
		if (base?.kind !== "base") throw new Error(`Document ${id} is missing a required base`);
		// applyImmutableBatches 不修改 base.value，按顺序应用生成器产出的每一批 Op，返回最终值。
		const value = applyImmutableBatches(
			base.value,
			documentDeltaBatches(id, base.version, revisions, baseIndex + 1),
		) as JsonObject;
		// 返回内部记录引用（调用方 document() 会克隆）；deltasSinceBase 是 base 之后实际重放的修订数。
		return { record: stored.record, version: base.version, value, deltasSinceBase: revisions.length - baseIndex - 1 };
	}

	// 生成器：按“当前会话 -> 父会话 -> 更早祖先”的顺序产出可见条目，最新在前（降序）。
	// 每段只取 ID <= upper 的条目，upper 在每次上溯时收紧到 parent.at，从而尊重 fork 点。
	// minEntryId 以下是调用方要求的最早 ID，低于它的条目不产出。
	private *visibleEntries(
		conversationId: ConversationId,
		minEntryId: number = Number.NEGATIVE_INFINITY,
		maxEntryId: number = Number.POSITIVE_INFINITY,
	): Generator<EntryRecord> {
		// 未知会话是请求级错误；生成器第一次 next() 时才会执行到这里。
		if (!this.state.conversations.has(conversationId)) {
			throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		let currentId = conversationId;
		// maxEntryId 默认正无穷；它既是本段的起始上界，也会被 fork 点进一步收紧。
		let upperEntryId = maxEntryId;
		while (true) {
			const ids = this.state.entryIds.get(currentId) ?? [];
			// 从最后一个 <= upper 的位置向前遍历；ids 是该会话直接拥有的条目升序数组。
			for (let index = upperBound(ids, upperEntryId) - 1; index >= 0; index--) {
				const id = ids[index];
				// 低于最小 ID 后本段剩余项都更小，直接结束本段。
				if (id < minEntryId) break;
				// entries 索引与 entryIds 同步维护，! 表示不变量成立。
				yield this.state.entries.get(id)!;
			}
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) break;
			// 进入父会话时，父会话只能贡献 <= parent.at 的条目。
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			// 收紧后的上界已经低于最小 ID，祖先更早的条目也不可能命中。
			if (upperEntryId < minEntryId) break;
			currentId = conversation.parent.conversationId;
		}
	}

	/** Visible entries oldest first: the fork chain's segments from the root conversation forward. */
	// 生成器：同样跨 fork 链，但按全局 ID 升序（最旧在前）。
	// 做法是先沿链收集各段及其上界，再反转成根会话优先的顺序逐段升序产出。
	// 父会话的条目 ID 一定小于 fork 点条目，因此反转段顺序后整体仍按 ID 递增。
	private *visibleEntriesAscending(
		conversationId: ConversationId,
		minEntryId: number = Number.NEGATIVE_INFINITY,
		maxEntryId: number = Number.POSITIVE_INFINITY,
	): Generator<EntryRecord> {
		if (!this.state.conversations.has(conversationId)) {
			throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		// segments 保存每段的会话 ID 与包含式上界；从当前会话收集到根。
		const segments: { readonly conversationId: ConversationId; readonly upper: number }[] = [];
		let currentId = conversationId;
		let upperEntryId = maxEntryId;
		while (true) {
			// 当前段总是从 upper 开始；随后沿 parent 收集祖先段。
			segments.push({ conversationId: currentId, upper: upperEntryId });
			const conversation = this.state.conversations.get(currentId)!;
			if (conversation.parent === undefined) break;
			// 父段的上界不能超过 fork 点；与已有上界取 min 处理多层 fork。
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			// 一旦上界低于最小 ID，更早的祖先段也不可能贡献可见条目。
			if (upperEntryId < minEntryId) break;
			currentId = conversation.parent.conversationId;
		}
		// reverse() 原地反转收集顺序（当前 -> 根 变成 根 -> 当前），让产出按 ID 递增。
		// reverse 修改的是局部数组，不触碰 state。
		for (const segment of segments.reverse()) {
			const ids = this.state.entryIds.get(segment.conversationId) ?? [];
			// lowerBound 跳到第一个 >= minEntryId 的位置；再逐条升序产出直到段上界。
			for (let index = lowerBound(ids, minEntryId); index < ids.length; index++) {
				const id = ids[index]!;
				// 超过本段上界就进入下一段（更晚的会话）。
				if (id > segment.upper) break;
				yield this.state.entries.get(id)!;
			}
		}
	}

	// 检查一个批次内的全局 ID 归属，防止 ID 跨表复用和不可变记录被重写。
	// conversation/entry/document 是创建即固定：任何已存在或同批次重复都拒绝。
	// task/submission 是生命周期记录：允许同表更新，但不能占用别的表的 ID，也不能同批次写成两种表。
	// claimed 记录本批次已声明的 ID -> 表名；existing 来自存储的 recordTypes。
	// 错误是普通 Error，由 commit 转成 refused，不导致 Promise 拒绝。
	private checkGlobalIds(writes: readonly StorageWrite[]): void {
		// 同批次声明表：key 是 ID，value 是该批次内第一次声明的表名。
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			// change/retire 不引入新 ID，也没有 record/value 可供检查。
			if (write.type === "document.change" || write.type === "document.retire") continue;
			// 文档 create/copy 用 record.id；其它写入用 value.id。
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = tableContaining(this.state, id);
			const earlier = claimed.get(id);
			// 不可变身份的第一次写入：existing 表示 ID 已被别的记录占用，earlier 表示同批次重复。
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				// 可变记录：允许覆盖同表记录（任务/提交状态更新），但跨表或同批次跨表仍然拒绝。
				if (existing !== undefined && existing !== table) {
					throw new Error(`ID ${id} already belongs to ${existing}`);
				}
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			// 记录本批次声明；后一条写入会覆盖 value，但表名保持不变时才合法。
			claimed.set(id, table);
		}
	}

	// 把一个批次内的文档写入按文档 ID 合并成动作，供后续统一检查和应用。
	// 约束：同一文档最多一条内容命令（create/copy/change），最多一次 retire。
	// 输出 Map<DocumentId, DocumentAction>；copy 在进入本函数前已被 resolveDocumentCopies 改写为 create。
	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire") {
				continue;
			}
			// create 的 ID 在 record 上，change/retire 的 ID 在写入本身。
			const id = write.type === "document.create" ? write.record.id : write.id;
			let action = actions.get(id);
			// 第一次见到这个文档时创建动作对象；retire 默认为 false。
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				// create：同时保存记录和 base 内容；同一批次已有内容命令时在这里拒绝。
				case "document.create":
					if (action.create !== undefined || action.content !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				// change：只设置内容；如果同一批次已有 create/copy/change 内容则拒绝。
				case "document.change":
					if (action.content !== undefined) throw new Error(`Document ${id} has more than one content command`);
					action.content = write.content;
					break;
				// retire：允许与 create/change 组合（创建即退役、修改后退役），但同一文档只能退役一次。
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	// 针对现有文档状态检查合并后的动作：存在性、退役状态、delta 版本衔接、地址唯一当前化身。
	// 这里只检查，不写入；错误由 prepareCommit 抛出，对应 batch 被 refused。
	private checkDocumentActions(actions: ReadonlyMap<DocumentId, DocumentAction>): void {
		// liveCounts 按逻辑地址统计“本批次应用后会有几个当前化身”，用于拒绝一个地址出现两个当前化身。
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			// existing 是该 ID 已存储的状态；create 表示本批次首次创建。
			const existing = this.state.documents.get(id);
			// 既没有 create 又没有现有记录：change/retire 指向了不存在的文档。
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			// create 一个已存在的 ID：文档化身 ID 永不复用。
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			// 已退役的化身不能再修改或再次退役。
			if (existing?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			// 最新修订用于 delta 版本衔接检查；at(-1) 在空数组上返回 undefined。
			const previous = existing?.revisions.at(-1);
			// delta 必须接在已有 base/delta 之后，且 version 与最新修订相同；版本变化必须写新的 base。
			if (action.content?.kind === "delta") {
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}

			// 地址键取本批次最终记录：create 用新记录，否则用现有记录。
			const key = action.create === undefined ? recordAddressKey(existing!.record) : recordAddressKey(action.create);
			// 当前索引里该地址的 currentId；没有当前化身时为 undefined。
			const currentId = this.state.documentAddresses.get(key)?.currentId;
			let live = liveCounts.get(key);
			// 初始存活数：地址已有当前化身则 1，否则 0。
			if (live === undefined) live = currentId === undefined ? 0 : 1;
			// 只有退役的正是当前化身时才减少存活数；退役历史化身不改变 currentId。
			if (action.retire && currentId === id) live--;
			// 新建且不立即退役才增加存活数；创建即退役不留下当前化身。
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}

		// 任何地址出现两个当前化身都拒绝：文档地址是逻辑单值，替换必须先退役旧的。
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error(`Document address already has a current incarnation`);
		}
	}

	// 应用已检查的文档动作：创建化身记录、追加/替换修订、处理退役，并维护地址与作用域索引。
	// 假设 checkDocumentActions 已通过，因此这里不再返回错误。
	private applyDocumentActions(actions: ReadonlyMap<DocumentId, DocumentAction>, seq: Seq): void {
		for (const [id, action] of actions) {
			// stored 可能为 undefined（新建）或已有状态（修改/退役）。
			let stored = this.state.documents.get(id);
			if (action.create !== undefined) {
				// 新建化身：记录由 storage 盖上 createdAt，并与创建同批次退役时盖上 retiredAt。
				const record: DocumentRecord = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				// 新建文档的修订序列从这一条内容开始；! 表示 create 一定带 content（create/copy 都要求内容）。
				stored = { record, revisions: [{ ...action.content!, seq }] };
				this.state.recordTypes.set(id, "document");
				this.state.documents.set(id, stored);

				// 更新地址索引与作用域索引；此时记录与全局 ID 归属已经登记。
				const key = recordAddressKey(record);
				// 地址索引不存在时创建；ids 按 ID 升序保存所有化身。
				let address = this.state.documentAddresses.get(key);
				if (address === undefined) {
					address = { ids: [] };
					this.state.documentAddresses.set(key, address);
				}
				insertSorted(address.ids, id);

				// 作用域索引用于 scanDocuments；同样首次出现时创建数组。
				let scopeIds = this.state.documentIdsByScope.get(scopeKey(record.scope));
				if (scopeIds === undefined) {
					scopeIds = [];
					this.state.documentIdsByScope.set(scopeKey(record.scope), scopeIds);
				}
				insertSorted(scopeIds, id);
				// 新 ID 可能大于分配器当前值，抬高 nextId 保证后续 mintId 不冲突。
				this.nextId = Math.max(this.nextId, id + 1);
				// 已有化身的更新：追加一条带 seq 的修订。
			} else if (action.content !== undefined) {
				const revision = { ...action.content, seq } as DocumentRevision;
				// 只保留当前状态的文档遇到新 base 时替换全部修订，避免历史无限增长；
				// 普通文档则保留全部修订供历史读取。
				if (revision.kind === "base" && isCurrentOnly(stored!.record)) stored!.revisions = [revision];
				else stored!.revisions.push(revision);
			}

			// 退役已有化身：记录上盖 retiredAt；不删除记录，历史读取仍能看到它。
			if (action.retire && action.create === undefined) stored!.record = { ...stored!.record, retiredAt: seq };
			// 只保留当前状态的文档退役后清空修订，释放内容。
			if (action.retire && isCurrentOnly(stored!.record)) stored!.revisions = [];
			// 创建或退役会改变地址的当前化身，因此需要更新 currentId。
			if (action.create !== undefined || action.retire) {
				const address = this.state.documentAddresses.get(recordAddressKey(stored!.record))!;
				// 退役的正是当前化身：删除 currentId，地址暂时没有当前化身。
				if (action.retire && address.currentId === id) delete address.currentId;
				// 新建且未退役：新化身成为地址的当前化身。
				if (action.create !== undefined && !action.retire) address.currentId = id;
			}
		}
	}

	// 所有公开入口共享的关闭检查；关闭后抛普通 Error，因为这是调用方生命周期错误，不是存储请求错误。
	private assertOpen(): void {
		if (this.closed) throw new Error("MemoryStorage is closed");
	}
}
