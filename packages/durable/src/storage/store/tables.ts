// Durable's records as declared tables of the store (slice 6b D2, §2.2): every row carries its record's indexed columns
// and the whole record as one `json(...)` cell. Indexed strings that must stay lossless (`kind`, `request_id`) hold
// Durable's JSON encoding; index columns are never `opt`, so absent values take sentinels no encoded value can be
// (`0` for an absent owner, which is never an id; `""` for an absent request id: an encoded string starts with `"`).

// 文件导读
// 所属：packages/durable/src/storage/store 的表声明与行投影模块，供 StoreStorage 在 Chord store 中落库。
// 职责边界：把 Durable 的五类记录（conversation、entry、task、submission，以及全局 id 和 head 辅助表）声明成
//   Chord 的 defineTable，并把领域记录投影为带索引列的存储行；不执行 SQL、不打开事务、不做写入检查。
// 上下游：storage.ts 在 open 时把这里的表声明交给 StoreOwnerTables；commit.ts 用 *Row() 生成插入行；
//   queries.ts 用表定义预编译读取。下游是 Chord 的 defineTable/int/json/str/unknown。
// 能力清单：
// - RecordIds / Conversations / Entries / EntryHeads / Tasks / Submissions（表定义）：物理表与索引声明。
// - encodeIndexed(value)：对需要索引的字符串做无损 JSON 编码，避免 SQL 字符串边界丢失孤立代理项或 NUL。
// - conversationRow / entryRow / taskRow / submissionRow：把领域记录投影成含索引列和完整 record 的行对象。
// 组合顺序：declared.declare(表定义) -> tables.*.encode(row) -> commit.ts 的 table.put(step, encoded)。
// 示例：conversationRow({ id, owner: { conversationId: 7, taskId: 9 } }) 返回
//   { id, owner_conversation_id: 7, owner_task_id: 9, record }；它还没有写入数据库。
// 阅读顺序：先看 record 列与 encodeIndexed 的编码约定，再看六张表的索引，最后看四个行投影函数。
import { defineTable, int, json, str, unknown } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationRecord, EntryRecord, SubmissionRecord, TaskRecord } from "../../types.ts";

/** A record as one `json(...)` cell. */
// 每次调用创建一列 JSON schema；unknown 不限制内容形状，version: 1 是此列的存储版本。
// 无输入，无 I/O；返回列声明供 defineTable 使用。例如 Conversations.record 接收完整会话对象。
const record = () => json(unknown(), { version: 1 });

/** Which record type owns an id: Durable's one namespace across its five record types. */
// 表声明只描述列/键，不立即写数据库。int/str 是列声明器，key 指定主键列名。
export const RecordIds = defineTable("record_ids", {
	version: 1,
	columns: { id: int(), record_type: str() },
	key: ["id"],
});

// 会话索引列保存两种所有者 ID；不存在的所有者用 0，占位值不可能与合法 ID 相等。
// 复合查询可先沿一个所有者索引取候选项，再检查另一个条件。
export const Conversations = defineTable("conversations", {
	version: 1,
	columns: { id: int(), owner_conversation_id: int(), owner_task_id: int(), record: record() },
	key: ["id"],
	indexes: { by_owner_conversation: ["owner_conversation_id"], by_owner_task: ["owner_task_id"] },
});

// 消息按 ID 唯一，conversation_id 可枚举会话内容；commit_seq 在实际提交时被填为该步序号。
export const Entries = defineTable("entries", {
	version: 1,
	columns: { id: int(), conversation_id: int(), commit_seq: int(), record: record() },
	key: ["id"],
	indexes: { by_conversation: ["conversation_id"] },
});

/**
 * The entries with a head marker, by conversation: what `SqliteStorage`'s partial index on `head IS NOT NULL` is,
 * as rows written only with such an entry, so a commit of an entry without one updates no second index.
 */
// 单独的小表相当于 SQLite 的 head 非空部分索引，仅含有上下文 head 标记的 entry。
export const EntryHeads = defineTable("entry_heads", {
	version: 1,
	columns: { id: int(), conversation_id: int() },
	key: ["id"],
	indexes: { by_conversation: ["conversation_id"] },
});

// 任务完整值在 record，常用查询字段另列存储以便索引；boolean 标记转为整数 0/1。
export const Tasks = defineTable("tasks", {
	version: 1,
	columns: {
		id: int(),
		conversation_id: int(),
		kind: str(),
		status: str(),
		abort_requested: int(),
		background: int(),
		record: record(),
	},
	key: ["id"],
	// 每个索引按这里声明的字段选择候选项；Chord 同时用主键确定稳定行顺序。
	indexes: {
		by_status: ["status"],
		by_conversation: ["conversation_id"],
		by_kind: ["kind"],
		by_abort_requested: ["abort_requested"],
		by_background: ["background"],
	},
});

// 请求 ID 用 JSON 字符串编码后存储，空字符串专门表示没有 requestId。
// 因此真实空 requestId 编码成两个引号，仍不会与“缺失”混淆。
export const Submissions = defineTable("submissions", {
	version: 1,
	columns: { id: int(), conversation_id: int(), request_id: str(), status: str(), record: record() },
	key: ["id"],
	indexes: {
		by_request: ["conversation_id", "request_id"],
		by_conversation: ["conversation_id"],
		by_status: ["status"],
	},
});

/** Durable's JSON encoding of an indexed string: lossless whatever the string (lone surrogates, NUL). */
// 输入 TS 已知的字符串，返回 JSON 字符串文本，不修改输入或做 I/O。
// 例：真实换行编码为反斜杠 n；索引比较和回读都沿用这个编码，避免 SQL 字符串边界损失信息。
export const encodeIndexed = (value: string): string => JSON.stringify(value);

/** The row of a conversation record. */
// 把完整会话 value 投影成表行，不写数据库；返回的新行仍引用原 record，序列化边界由 Store 负责。
// 可选 owner 缺失时写 0。例如 owner.taskId 为 7，则 owner_task_id 为 7，另一列为 0。
export function conversationRow(value: ConversationRecord): object {
	// ?. 安全读取可选 owner；?? 仅在缺省时选哨兵值，保留现有合法 ID。
	return {
		id: value.id,
		owner_conversation_id: value.owner?.conversationId ?? 0,
		owner_task_id: value.owner?.taskId ?? 0,
		record: value,
	};
}

/** The row of an entry record; `commit_seq` is stamped by the step. */
// 输入消息记录，返回含查询列和完整 record 的表行；不分配新 ID，也不直接存储。
// 例：消息 ID 为 9 时先返回 commit_seq: 0，commit 的 write 阶段随后替换为真实提交序号。
export function entryRow(value: EntryRecord): object {
	// commit_seq 的 0 是暂存占位，不是该消息最终持久化的提交号。
	return {
		id: value.id,
		conversation_id: value.conversationId,
		commit_seq: 0,
		record: value,
	};
}

/** The row of a task record. */
// 输入三个泛型位置均为 JsonValue 的任务，返回用于 insert/put 的索引行，不执行任务。
// 任务状态来自 state.status；例如 background=true 编码成 1，kind 则用 encodeIndexed 保真。
export function taskRow(value: TaskRecord<JsonValue, JsonValue, JsonValue>): object {
	// 只把要索引的字段变成标量；record 保留任务检查点、输入、结果等完整 JSON。
	return {
		id: value.id,
		conversation_id: value.conversationId,
		kind: encodeIndexed(value.kind),
		status: value.state.status,
		abort_requested: value.abortRequested ? 1 : 0,
		background: value.background ? 1 : 0,
		record: value,
	};
}

/** The row of a submission record. */
// 将入队/完成记录投影为表行；不入队、不去重，仅给上层存储写入使用。
// 例如 requestId 缺失写空哨兵，requestId 为 "" 则写 JSON 编码的空字符串，两者不同。
export function submissionRow(value: SubmissionRecord): object {
	// 三元表达式先区分缺失，再对实际字符串编码；状态列与完整记录一起更新。
	return {
		id: value.id,
		conversation_id: value.conversationId,
		request_id: value.requestId === undefined ? "" : encodeIndexed(value.requestId),
		status: value.status,
		record: value,
	};
}
