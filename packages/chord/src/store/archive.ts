// Archives and recorded commits as they cross a trust boundary (slice 6a §13, slice 6b §1.6; decisions "Export archives
// are operations", "Writes carry their versions; archives are lossless"): the parts an export yields and an import
// takes, their order, and the compiled schemas every imported part and every applied write is checked against first.
// 本文件定义归档/批次写入的外部形状，并提供两层运行时校验：解释器逐个 part 校验，applier 逐条写入校验。
// 上游是 export/import 与同步层的 applyBatch；这里的 schema 不执行 SQL，只把 unknown 数据收窄成 StoreWrite。
// 所属模块：packages/chord/src/store 的归档与批次写入外部形状/校验。
// 上下游：export/import 产生或消费 ArchivePart；applyBatch 用 checkWrite 收窄每条写入。依赖 contracts 的 schema 构造器与 validatorFor。
// 结果：checkPart/checkWrite 返回收窄后的值，不合法抛 invalid/args；不执行 SQL，也不修改 store。
// 能力清单：
// - ARCHIVE_FORMAT：导入只接受的格式版本。
// - ArchiveManifest / ArchivePart：归档首部与 part 联合。
// - checkPart：按 PART schema 校验一个 part。
// - checkWrite：按 WRITE schema 校验一条批次写入。
// 组合关系：export 依次写 manifest/table/put/index/document/end -> import 逐 part 调用 checkPart -> 交给 applier；
//   批次路径则是 checkWrite -> applyWrite。
// 示例：const part = checkPart({ kind: "end", writes: 0 }, 3, ctx); // 返回同一对象，类型收窄为 ArchivePart
// 阅读顺序：先 ARCHIVE_FORMAT 与 ArchivePart 的顺序说明，再看 schema 常量，最后 checkPart/checkWrite。

import type { Context } from "../context/index.ts";
import {
	arr,
	bool,
	type IntegerSchema,
	int,
	lit,
	map,
	num,
	obj,
	opt,
	str,
	union,
	unknown,
} from "../contracts/index.ts";
import { invalid, validatorFor } from "../data/internal.ts";
import type { DocumentWrite } from "./engine.ts";
import type { TableWrite } from "./table-writes.ts";
import type { StoreWrite } from "./writes.ts";

/** The archive format `export` writes; `import` takes this one only. */
// 归档格式版本。导入只接受相等的值；未来格式变化时旧代码会明确拒绝，而不是误读新数据。
export const ARCHIVE_FORMAT = 1;

/** The first part: the format, the store's schema version, its `lastSeq` and the allocator's next id (rule 24, D3). */
// manifest 是归档的第一部分：它让导入方在读取大量数据前检查格式、store schema 版本和两个水位。
// 这些字段在运行时由 PART schema 校验为安全整数。
export type ArchiveManifest = {
	readonly kind: "manifest";
	readonly format: number;
	readonly schema: number;
	readonly lastSeq: number;
	readonly nextId: number;
};

/**
 * One part of an archive, in this order: the manifest; per table (by SQL name) its `table` write, its `put`s and its
 * `index` writes; per document record (by id, live and retired) its `document.create` without a base, then its kept
 * revisions in seq order; `end` with the count of the parts between.
 */
// 联合类型把 manifest、部分表写入、部分文档写入和 end 标记组合起来；`Extract` 从既有联合中挑出指定 kind 的分支。
// 注意归档只携带这些写入，而不是所有 StoreWrite：例如 update/delete 属于增量提交，不进入归档。
export type ArchivePart =
	| ArchiveManifest
	| Extract<TableWrite, { readonly kind: "table" | "put" | "index" }>
	| Extract<DocumentWrite, { readonly kind: "document.create" | "document.revision" }>
	| { readonly kind: "end"; readonly writes: number };

/** An integer from `min` up to 2^53 - 1: seqs, ids, versions and counts stay exact (a seq after 2^53 would repeat). */
// 构造一个整数 schema：下界由调用者给，上界固定为 Number.MAX_SAFE_INTEGER。
// 这是 schema 构造，不是校验本身；真正校验发生在 validatorFor(...).check 时。
function safe(min: number): IntegerSchema {
	return int({ min, max: Number.MAX_SAFE_INTEGER });
}

// 表版本、row 版本和文档版本的最小值都是 1。
const version = safe(1);

// 目录里的列记录形状：type 是五个字面量之一；optional/default/version/fingerprint 都可省略。
// union([lit(...)]) 把字面量组合成枚举；opt(...) 表示字段可缺失。
const column = obj({
	type: union([lit("str"), lit("int"), lit("num"), lit("bool"), lit("json")]),
	optional: opt(lit(true)),
	default: opt(union([str(), num(), bool()])),
	version: opt(version),
	fingerprint: opt(str()),
});

// map(version) 表示“字符串键到整数的对象”，用于 json(...) 列的版本表。
const versions = map(version);

// 表定义 part：kind 固定，columns 是按列名索引的记录，key 是字符串数组。
// unknown() 可用于 row/value 等“内容稍后由具体解码器处理”的字段，外层先只校验容器形状。
const TABLE = obj({
	kind: lit("table"),
	table: str(),
	version,
	state: union([lit("ready"), lit("migrating")]),
	columns: map(column),
	key: arr(str()),
	fingerprint: str(),
});

// put part：row 的字段值暂不细分类型，columns 记录该行 json(...) 单元格的版本。
const PUT = obj({
	kind: lit("put"),
	table: str(),
	row: map(unknown()),
	version,
	columns: versions,
});

// 索引 part：只记录表名、索引名和声明列；主键在渲染时追加。
const INDEX = obj({ kind: lit("index"), table: str(), name: str(), columns: arr(str()) });

// 文档记录 part：id/createdAt/revision 都是安全整数，retiredAt 可省，key 对单例文档可省。
const RECORD = obj({
	id: safe(1),
	owner: str(),
	namespace: str(),
	kind: str(),
	// Absent for a singleton.
	key: opt(str()),
	history: union([lit("none"), lit("latest"), lit("rewindable")]),
	createdAt: safe(1),
	retiredAt: opt(safe(1)),
	meta: opt(str()),
	revision: safe(1),
	version,
	fingerprint: str(),
});

// 文档 base 内容：版本、schema 指纹和值本身；值暂按 unknown 接收。
const BASE = obj({ version, fingerprint: str(), value: unknown() });

/** A delta's ops; their shapes are checked where they are applied. */
// ops 是操作数组；这里只要求它是数组，具体 op 结构由 delta 层在应用时校验。
const ops = arr(unknown());

// 归档中的一条历史修订：它属于文档 id，位于 seq，内容可以是 base 或 delta。
// content 用 union 区分两种形状；kind 是判别字段。
const REVISION = obj({
	kind: lit("document.revision"),
	id: safe(1),
	seq: safe(1),
	content: union([obj({ kind: lit("base"), version, value: unknown() }), obj({ kind: lit("delta"), version, ops })]),
});

// 所有允许的 part 形状。union 按顺序尝试分支；每个分支都以 kind 字面量区分。
// 这是导入边界的主 schema，checkPart 用它把 unknown 收窄为 ArchivePart。
const PART = union([
	obj({ kind: lit("manifest"), format: safe(1), schema: safe(1), lastSeq: safe(0), nextId: safe(1) }),
	TABLE,
	PUT,
	INDEX,
	obj({ kind: lit("document.create"), record: RECORD }),
	REVISION,
	obj({ kind: lit("end"), writes: safe(0) }),
]);

// 受影响行数从 0 起；计数属于提交记录，必须精确。
const count = safe(0);

// 迁移中的列编辑：rename/add/drop 或把一个已有列改成 json(...)。
const edit = union([
	obj({ kind: lit("rename"), from: str(), to: str() }),
	obj({ kind: lit("add"), name: str(), column }),
	obj({ kind: lit("drop"), name: str() }),
	obj({ kind: lit("json"), name: str(), column }),
]);

// 主键值只能是标量；键的数量和列名由 applier 对照表记录再检查。
const key = map(union([str(), num(), bool()]));

/** One recorded write of a commit (a batch's); `where` and `set` nodes are checked by the applier. */
// 批次提交的写入形状。这里故意把 where/set 保留为 unknown：它们的表达式语法由 applier 的 checkWhere/checkExpr 校验，
// 避免在 archive 层重复定义整个查询 DSL。
const WRITE = union([
	TABLE,
	PUT,
	INDEX,
	obj({ kind: lit("dropIndex"), table: str(), name: str() }),
	obj({ kind: lit("alter"), table: str(), version, edit }),
	obj({ kind: lit("update"), table: str(), key, set: unknown(), columns: versions, count, version: opt(version) }),
	obj({ kind: lit("delete"), table: str(), key, count }),
	obj({
		kind: lit("updateWhere"),
		table: str(),
		where: unknown(),
		set: unknown(),
		columns: versions,
		count,
		version: opt(version),
	}),
	obj({ kind: lit("deleteWhere"), table: str(), where: unknown(), count }),
	obj({ kind: lit("document.create"), record: RECORD, base: BASE }),
	obj({
		kind: lit("document.change"),
		id: safe(1),
		revision: safe(1),
		content: union([
			obj({ kind: lit("base"), version, fingerprint: str(), value: unknown() }),
			obj({ kind: lit("delta"), version, ops }),
		]),
	}),
	obj({ kind: lit("document.retire"), id: safe(1), revision: safe(1) }),
]);

// validatorFor 接收的形状是 `{ schema }`；包一层避免把内部 schema 当作外部参数直接传。
const PART_SCHEMA = { schema: PART };

const WRITE_SCHEMA = { schema: WRITE };

/** Checks one imported part against the archive schema (a trust boundary); `invalid/args` naming its position. */
// 校验一个归档 part。输入 unknown、位置和上下文；返回已收窄的 ArchivePart，不合法时抛 invalid/args。
// 每次校验递增 chord.data.validations 计数；位置只用于错误定位，索引不影响校验规则。
// 示例：checkPart({ kind: "end", writes: 0 }, 3, ctx) 通过；kind 拼错则抛 invalid/args。
export function checkPart(part: unknown, position: number, context: Context): ArchivePart {
	// metrics 可以是 undefined（无遥测上下文）；?. 让测试或 CLI 环境无需配置指标。
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	// validatorFor 编译/复用 schema 验证器；check 返回 boolean，是真正的运行时校验。
	if (!validatorFor(PART_SCHEMA, context).check(part)) {
		throw invalid("args", `import: part ${position}: not an archive part`);
	}
	// The check above establishes the type.
	// 断言只告诉编译器“上面的运行校验已通过”；它本身不再执行任何检查。
	return part as ArchivePart;
}

/** Checks one write of a batch's commit against the write schema (a trust boundary); `what` names its place. */
// 校验批次里的一条写入。输入 unknown、位置描述和上下文；返回 StoreWrite，不合法时抛 invalid/args。
// 与 checkPart 一样计数；where/set 只校验外层形状，表达式细节留给 applier。
export function checkWrite(write: unknown, what: string, context: Context): StoreWrite {
	context.telemetry.metrics?.counter("chord.data.validations").add(1);
	if (!validatorFor(WRITE_SCHEMA, context).check(write)) throw invalid("args", `${what}: not a store write`);
	// The check above establishes the type, the nodes aside (the applier checks them).
	return write as StoreWrite;
}
