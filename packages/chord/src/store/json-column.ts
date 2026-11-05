// `json(schema, { version, migrate? })` table columns (decision "The `json(...)` column helper", W11): one JSON `TEXT`
// cell with its own version, typed when read, migrated on access (the result checked once, R8), never walked on write
// (R9).

// 文件导读
// 所属：packages/chord/src/store（store 层，json(...) 列定义）。
// 职责边界：声明期快照 schema、版本和指纹，读取期解析单元格并按需迁移；不写数据库，不生成 DDL。
// 上游：json() 被 defineTable 的 columns 调用；下游：Column.json 保存本类，RowCodec.encodeCell 在写入时序列化，decode 调用 read，columnRecord 记录 version/fingerprint，导入时 applier 校验指纹。
// 能力清单：
// - JsonColumnOptions：版本与可选 migrate 函数；
// - JsonColumnSchema：带 json 标记的 Schema，供 columns 识别；
// - json：构造该标记；
// - JsonColumn：私有 schema 快照、版本、指纹与 read；
// - refused：构造 unavailable 错误并保留 cause。
// 组合顺序：json(schema,{version,migrate}) -> JsonColumn 构造（校验版本、快照 schema、算指纹）-> 写入时 RowCodec 序列化 -> 读取时 read（同版 JSON.parse；旧版 migrate 后校验一次）。
// 示例：json(obj({ x: int() }), { version: 1 }) 返回 { json: JsonColumn }；读取 version 1 的单元格只做 JSON.parse。
// 建议阅读顺序：JsonColumnOptions/JsonColumnSchema -> json() -> JsonColumn 构造 -> read -> refused。

import type { JsonSchema } from "@earendil-works/pi-schema";
import type { Context } from "../context/index.ts";
import type { Schema, Static } from "../contracts/index.ts";
import { fingerprintOf } from "../contracts/internal.ts";
import { snapshotSchema } from "../contracts/snapshot.ts";
import { ChordError } from "../data/index.ts";
import { validatorFor } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";

/** What `json(...)` takes besides the schema. */
export type JsonColumnOptions<T> = {
	// <T> 把 migrate 的返回类型和列值联系起来；这是编译时约束，运行时仍须检查迁移结果。
	/** The version of the cells' shape; a cell stores the version it was written at. */
	readonly version: number;
	/** Maps a cell of an older version `from` to this version's shape; pure. Without it older cells are refused. */
	readonly migrate?: (old: JsonValue, from: number) => T;
};

/** A `json(...)` column as `columns` takes it: a schema of the cells' type carrying the column. */
export interface JsonColumnSchema<T> extends Schema<T> {
	// extends 在类型层面保留 Schema<T> 的值类型信息；json 字段携带运行时版本、迁移和指纹对象。
	readonly json: JsonColumn;
}

/** A column holding one JSON value of `schema` per row, at `version`; wrap it in `opt(...)` to make it nullable. */
// 声明一列 JSON 数据并返回带定义的 schema 标记，不读写单元格。例如 json(obj({x:int()}), {version:1}) 的 TS 值类型是 {x:number}；声明策略/版本错误会在 JsonColumn 构造中抛出。
export function json<S extends Schema>(schema: S, options: JsonColumnOptions<Static<S>>): JsonColumnSchema<Static<S>> {
	// S 捕获输入 schema 的具体类型，Static<S> 取它描述的值类型；类型信息擦除后只留下这个包装对象。
	// Typed as the cells' schema, so `opt(...)` and `Static` take it; the table reads its `json` field.
	return { json: new JsonColumn(schema, options.version, options.migrate) };
}

/** A `json(...)` column's definition: its schema snapshot, version and fingerprint, and the read of a stored cell. */
export class JsonColumn {
	readonly schema: JsonSchema;
	readonly version: number;
	/** The fingerprint of the schema's normal form, recorded with the table: the same version with another is `broken`. */
	readonly fingerprint: string;
	readonly #migrate: ((old: JsonValue, from: number) => unknown) | undefined;

	// 从应用 schema 建立私有快照并计算结构指纹，保存版本与可选迁移函数；例如 version:1 会记录第 1 版但不调用 migrate。坏版本或不受支持的 schema 会抛错，不执行 SQL。
	constructor(schema: Schema, version: number, migrate: ((old: JsonValue, from: number) => unknown) | undefined) {
		// Declaration policy: JavaScript callers reach this check.
		if (!Number.isSafeInteger(version) || version < 1)
			// number 类型并不保证正安全整数，JavaScript 调用者也可能传来不合规则的版本。
			throw new Error(`json(...): version ${version} is not a positive integer`);
		// snapshotSchema 检查允许的 schema 词汇并复制出 schema 与结构规范形；它不验证任何列值。
		const snapshot = snapshotSchema(schema, "json(...)");
		// 保存快照而非应用原始 schema，以免应用改动原对象改变已有声明。
		this.schema = snapshot.schema;
		// 版本用于单元格读取时比较；指纹用于表定义检查同版本下的结构是否变化。
		this.version = version;
		this.fingerprint = fingerprintOf(snapshot.normal);
		// 可选函数只保存不执行；unknown 返回类型迫使运行时迁移路径再做 schema 校验。
		this.#migrate = migrate;
	}

	/**
	 * The value of a stored cell written at `version`: parsed; an older one migrated and checked once (R8, counted). A
	 * newer version, a missing or throwing `migrate` and an invalid result throw `unavailable` (`what` names the cell);
	 * the caller fails the owner (slice 6a §1.4), the data stays.
	 */
	// 解析存储的 JSON 单元格并按需迁移，返回当前版本值。例如存储 v1、定义 v2 时调用 migrate(value,1) 并校验一次；同版只 JSON.parse，新版数据/缺迁移/迁移抛错或结果不符会拒绝。只读不回写，校验计数记入 context。
	read(text: string, version: number, what: string, context: Context): unknown {
		// as JsonValue 是内部存储格式的断言；JSON 语法损坏时 JSON.parse 原异常直接抛出，未进入迁移包装。
		const value = JSON.parse(text) as JsonValue;
		// 当前版本无需再遍历验证整列；schema 类型不是这一步的自动运行时验证器。
		if (version === this.version) return value;
		// 旧代码不能猜新数据含义，拒绝回退读取，避免静默按旧结构使用新值。
		if (version > this.version) throw refused(`${what}: stored at version ${version}, newer than ${this.version}`);
		// 走到这里说明存储版本较旧；没有适配函数就不能提供当前形状。
		if (this.#migrate === undefined) throw refused(`${what}: no migrate from version ${version} to ${this.version}`);
		// 先用 unknown 接收插件函数的结果，再由下方实际 schema check 决定是否可信。
		let migrated: unknown;
		try {
			// 回调只收到旧 JSON 值及其版本，不收到 SQL 事务，按约定必须保持纯函数。
			migrated = this.#migrate(value, version);
		} catch (error) {
			// 迁移抛出的值作为本机 cause 保留；调用者负责把列读取失败传播为拥有者失败。
			throw refused(`${what}: migrate from version ${version} threw`, error);
		}
		// ?. 表示没有 metrics 能力时跳过计数；有能力则记录这次真实的迁移结果校验。
		context.telemetry.metrics?.counter("chord.data.validations").add(1);
		// validatorFor 按 JsonColumn 对象弱缓存编译结果；check 才是运行时的值验证，泛型本身不做这件事。
		if (!validatorFor(this, context).check(migrated)) {
			throw refused(`${what}: migrate from version ${version} does not match the schema`);
		}
		// 只交出内存中的迁移结果，不修改 text、数据库或原列版本。
		return migrated;
	}
}

/** The error of a cell the code cannot read: the owner fails `broken` with it. */
// 构造单元格不可读取的 unavailable 错误，可附原始 cause；例如 migrate 抛错时包装说明。返回错误对象而不自行 throw，也不直接标记拥有者状态，后者由调用路径处理。
function refused(message: string, cause?: unknown): ChordError {
	// 只有实际提供 cause 才创建 options；三元表达式保留“没有原因”与“有原因”的差别。
	return new ChordError({ code: "unavailable", message }, cause === undefined ? undefined : { cause });
}
