// Durable's documents in the store's documents engine (slice 6b §1.5, R1): a Durable address as an engine address
// under the storage's owner name (its scope as the namespace, its kind and key JSON-encoded as Durable's indexed
// strings), a Durable record as an engine record and back (the Durable record in `meta`), and a document read at a
// point.

// 文件导读

// 所属：packages/durable/src/storage/store 的文档地址/记录映射层，连接 Durable 文档语义与 Chord 文档引擎。

// 职责边界：把 Durable 的 scope/kind/key 映射成引擎的 owner/namespace/kind/key，把 Durable 记录序列化进

//   引擎记录的 meta 字段并在读取时还原；提供按时间点读取的标记结果。它不写数据库、不检查提交合法性，

//   写入由 commit.ts 调用，读取查询由 storage.ts 调用。

// 上下游：store/storage.ts 的 findDocument/document/scanDocuments 与 commit.ts 的 check/apply 使用这里；

//   下游是 Chord 的 readDocumentEntry/loadContent 与 delta 的 apply（由 loadContent 内部完成）。

// 结果与错误：readAt 用“found/current_only”标记结果，请求错误在受保护读结束后才转异常；

//   引擎调用抛出的数据库错误直接向上传播。

// 能力清单：

// - SCOPE_NAMESPACES：打开时占用的三个 namespace 前缀。

// - namespaceOf(scope)：Durable 作用域 -> 引擎 namespace。

// - addressOf(address, owner)：Durable 地址 -> 引擎地址（kind/key 做无损编码）。

// - historyOf(record)：该记录保留 latest 还是 rewindable 历史。

// - engineRecord(create, owner, version, seq, retired)：创建引擎记录，Durable 记录放入 meta。

// - durableRecord(record, owner) / recordOfEntry(entry)：还原 Durable 记录。

// - aliveAt(record, at)：半开生存期判断。

// - DocumentRead / readAt：按 id 和时间点物化文档。

// 组合顺序：addressOf -> findDocumentEntry/readDocumentEntry -> recordOfEntry -> loadContent。

// 示例：const address = addressOf({ kind: "notes", scope: { kind: "task", taskId: 7 } }, "durable.app");

//   得到 { owner: "durable.app", namespace: "task:7", kind: "\"notes\"" }。

// 阅读顺序：先看命名空间与地址映射，看 engineRecord/meta 的序列化约定，最后看 readAt 的时间点读取。

// 文档引擎类型与读取函数；loadContent 负责“最近 base + 后续 delta”的物化。
import {
	type DocumentEntry,
	type DocumentHistory,
	type DocumentAddress as EngineAddress,
	type DocumentPoint as EnginePoint,
	type DocumentRecord as EngineRecord,
	loadContent,
	readDocumentEntry,
} from "@earendil-works/chord";
// 从存储数字还原品牌 Seq；createdAt/retiredAt 在引擎中是普通数字。
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { seqFromNumber } from "../../ids.ts";
import type {
	DocumentAddress,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentRecord,
	JsonObject,
	StoredDocument,
} from "../../types.ts";
// 索引字符串编码必须与 tables.ts 的写入形式一致，保证地址查询能命中。
import { encodeIndexed } from "./tables.ts";

/** The namespaces a storage claims under its owner: Durable's scopes (Chord's namespaces never contain a `:`). */
// 三个合法 namespace：session 是单例；conversation:/task: 带具体所有者 id，前缀本身也用于 claim。
export const SCOPE_NAMESPACES = ["session", "conversation:", "task:"] as const;

/** The engine namespace of a Durable scope: `session`, `conversation:<id>`, `task:<id>`. */
// 把 Durable 作用域渲染成引擎 namespace；session 不需要 id，其余把所有者编号拼进字符串。
export function namespaceOf(scope: DocumentRecord["scope"]): string {
	switch (scope.kind) {
		case "session":
			return "session";
		case "conversation":
			return `conversation:${scope.conversationId}`;
		case "task":
			return `task:${scope.taskId}`;
	}
}

/** The engine address of a Durable address under `owner`. */
// 构造引擎地址：owner 区分同级存储，kind/key 使用 Durable 的 JSON 编码以无损保存任意字符串。
// key 缺失表示单例文档；引擎用空字符串列表示缺失，由调用方根据记录判断 single/family。
export function addressOf(address: DocumentAddress | DocumentCreate, owner: string): EngineAddress {
	const at = { owner, namespace: namespaceOf(address.scope), kind: encodeIndexed(address.kind) };
	// 有 key 时才展开 key 字段；展开语法不修改原对象，返回新的普通对象。
	return address.key === undefined ? at : { ...at, key: encodeIndexed(address.key) };
}

/** What a record of `scope` keeps: session and task documents and latest conversation ones their latest state. */
// 只有 conversation 作用域的 rewindable 文档保留历史；其余（session/task/latest）只保留最新状态。
export function historyOf(record: DocumentCreate | DocumentRecord): DocumentHistory {
	return record.scope.kind === "conversation" && record.history === "rewindable" ? "rewindable" : "latest";
}

// 创建引擎记录：地址字段 + history + createdAt + 可选 retiredAt + meta。
// meta 保存完整 Durable 记录（含 createdAt），读取时只解析这一列就能还原 Durable 记录。
/**
 * The engine record of a Durable creation at `seq` (retired at once for an empty lifetime): the Durable record itself,
 * its creation seq included, in `meta`, so a read of a live record parses one JSON text from one column, as
 * `SqliteStorage`'s does (a retirement later sets only the engine's `retired_at`).
 */
// 输入创建描述和打开时分配的 owner/version/seq；retired 为 true 表示创建即退役。
// 返回引擎需要的记录形状，不做 I/O。例：seq=5、retired=false 时 createdAt=5、无 retiredAt。
export function engineRecord(
	create: DocumentCreate,
	owner: string,
	version: number,
	seq: number,
	retired: boolean,
): EngineRecord {
	// id 由上层分配并已登记；这里原样写入引擎记录。
	return {
		// ...addressOf 展开 owner/namespace/kind/key 四个地址字段。
		id: create.id,
		// historyOf 决定引擎在新 base/退役时丢弃哪些旧修订。
		...addressOf(create, owner),
		history: historyOf(create),
		createdAt: seq,
		...(retired ? { retiredAt: seq } : {}),
		// meta 必须是字符串；展开 create 后覆盖 createdAt，避免调用方传入的旧值。
		meta: JSON.stringify({ ...create, createdAt: seq }),
		revision: 1,
		// revision 从 1 开始；version 是文档内容版本；fingerprint 对 Durable 文档固定为空。
		version,
		fingerprint: "",
	};
}

/**
 * The Durable record of an engine record of this storage's owner and scopes, `undefined` for anyone else's (a Chord
 * document, another owner's): its id is unknown to this storage.
 */
// 还原 Durable 记录：只接受本 owner 且 namespace 属于 Durable 三种作用域的记录；
// 否则说明这是 Chord 自己的文档或别的存储的文档，返回 undefined。
export function durableRecord(record: EngineRecord, owner: string): DocumentRecord | undefined {
	const { meta } = record;
	// 没有 meta 的引擎记录不是 Durable 创建的；ownedHere 再检查 owner/namespace。
	if (meta === undefined || !ownedHere(record, owner)) return undefined;
	// 读取时把引擎的 retiredAt 合并到 meta 解析出的记录上。
	return recordOfEntry({ meta, retired_at: record.retiredAt ?? null });
}

/** The Durable record of an engine entry read at one of this storage's addresses or scopes (the record in `meta`). */
// 从查询返回的 entry 还原 Durable 记录；meta 由 engineRecord 写入，可安全 parse。
export function recordOfEntry(entry: DocumentEntry): DocumentRecord {
	// Written by `engineRecord`, parsed fresh: a retirement since is set on it in place.
	// 映射类型去掉 readonly，因为下面要就地补写 retiredAt；这是本地副本，不是共享记录。
	const record = JSON.parse(entry.meta!) as { -readonly [K in keyof DocumentRecord]: DocumentRecord[K] };
	// 引擎以 null 表示未退役；只有存在退役序号时才覆盖 meta 中的值。
	if (entry.retired_at !== undefined && entry.retired_at !== null) record.retiredAt = seqFromNumber(entry.retired_at);
	return record as DocumentRecord;
}

/** Whether a record is this storage's: `owner`'s, in one of Durable's scopes (not a Chord document of the owner). */
// 判断记录是否属于本存储：owner 相同，且 namespace 是三种 Durable 作用域之一。
function ownedHere(record: { readonly owner: string; readonly namespace: string }, owner: string): boolean {
	const { namespace } = record;
	if (record.owner !== owner) return false;
	// startsWith 检查前缀形式；具体 id 部分已在 addressOf 中生成，不在这里重新解析。
	return namespace === "session" || namespace.startsWith("conversation:") || namespace.startsWith("task:");
}

/** Whether a document is alive at `at` (the half-open lifetime). */
// 半开生存期：current 表示未退役；历史点要求 createdAt <= at 且（未退役或 at < retiredAt）。
export function aliveAt(record: DocumentRecord, at: DocumentPoint): boolean {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
}

// 读取结果用标记联合：found 带记录或 undefined；current_only 表示记录不保留该历史点。
// 这样 readAt 不抛请求错误，受保护读不会因此被当作存储故障。
/**
 * A document read at a point, as a tagged result: request errors are told after the guarded read (slice 6b §1.4),
 * never thrown inside it.
 */
export type DocumentRead =
	| { readonly kind: "found"; readonly document: StoredDocument | undefined }
	| { readonly kind: "current_only"; readonly id: DocumentId };

// 按 id 在时间点读取文档：先读 entry（含 meta/retired_at/owner/namespace/history），

// 再判断归属、历史能力、生存期，最后物化值。只要求执行器有 get/all，事务外连接也可用。

// 返回 found(document 可 undefined) 或 current_only；例：latest 文档在 at=3 时返回 current_only。

/**
 * Document `id` of `owner` at `at`: absent (unknown, someone else's, not alive at `at`), a record whose history does
 * not reach back to `at`, or its value from the base at or below `at` and the deltas up to it.
 */
export async function readAt(
	executor: Pick<SqliteExecutor, "get" | "all">,
	id: DocumentId,
	at: DocumentPoint,
	owner: string,
): Promise<DocumentRead> {
	// 一次读取拿到记录与 history；entry 缺失或 meta 为空都表示不是 Durable 文档。
	const entry = await readDocumentEntry(executor, id);
	// ownedHere 同时排除别的 owner 和 Chord 自己的 namespace。
	if (entry === undefined || entry.meta === null || !ownedHere(entry, owner)) {
		return { kind: "found", document: undefined };
	}
	// 解析 meta 得到 Durable 记录（含 scope/kind/key/history/fork）。
	const record = recordOfEntry(entry);
	// 请求历史点但引擎记录只保留 latest：交给调用方转成请求错误。
	if (at !== "current" && entry.history !== "rewindable") return { kind: "current_only", id };
	// 记录在该时间点尚未创建或已经退役，视为不存在。
	if (!aliveAt(record, at)) return { kind: "found", document: undefined };
	const point: EnginePoint = at;
	// loadContent 读取 <= at 的最近 base 及其后的 delta，apply 后返回值与 deltasSinceBase。
	const loaded = await loadContent(executor, id, point);
	// The engine stores what Durable's commits gave it: JSON objects.
	// Durable 的 base 值都是 JSON 对象；类型断言表达写入端已经保证这一点。
	const value = loaded.value as JsonObject;
	return {
		// 返回新的 StoredDocument：记录、base 版本、物化值和相对 base 的 delta 数。
		kind: "found",
		document: { record, version: loaded.version, value, deltasSinceBase: loaded.deltasSinceBase },
	};
}
