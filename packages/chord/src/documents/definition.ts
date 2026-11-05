// Document definitions: `defineState(name, ...)`, its fingerprint, the one check of a definition's `initial()` (R8),
// the checked `migrate` of an older value and, for a persisted document, its checkpoint rule (slice 6a §10).

// 文件导读
// 所属：packages/chord/src/documents，Chord 文档定义层。
// 职责边界：把应用的 defineState 参数固化成 StateDefinition（name/schema/version/fingerprint/keyed/persist），并提供 initial/migrate 的首次校验与 checkpointWhen 规则；不创建文档、不读写 store。
// 上游：应用调用 defineState；Documents.declare/hydrate 在 activation 中使用定义；下游：slot 保存 SlotDefinition，Persistence 把 version/fingerprint 写进 store 记录。
// 结果/错误：defineState 的名称非法抛 invalid/args；initial/migrate 首次结果不符合 schema 抛普通 Error（activation 再包成 broken）；migrate 缺失时读取旧值抛普通 Error。
// 能力清单：JsonObject 文档根类型；CommitPersistence 提交落盘策略；CheckpointInfo/CheckpointWhen 检查点规则；defineState 工厂（两个重载）；StateDefinition 定义类（initial/migrate/checkpointWhen/version/fingerprint）。
// 组合关系：defineState → StateDefinition → Documents.declare 建槽 → hydrate 调 initial/migrate → 持久化提交按 fingerprint/version 校验并可能调 checkpointWhen。
// 示例：const counter = defineState("counter", { schema, version: 1, initial: () => ({ count: 0 }) }); 首次 initial(ctx) 返回 {count:0} 并校验一次，之后不再校验。
// 阅读顺序：先看 JsonObject/CommitPersistence/CheckpointWhen 类型，再看 defineState 重载，最后看 StateDefinition 的 initial/migrate/#check。
// 类型层与运行期：schema/version/keyed/persist/fingerprint 是运行期数据；~keyed/~persist 只是编译期标记；initial/migrate 的校验是运行期（首次）检查。
import type { Context } from "../context/index.ts";
import type { Schema, Static } from "../contracts/index.ts";
import { checkName, fingerprintOf } from "../contracts/internal.ts";
import { snapshotSchema } from "../contracts/snapshot.ts";
import { validatorFor } from "../data/internal.ts";
import type { Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";

// JsonObject 是“根为 JSON 对象”的别名：索引签名要求所有键映射到 JsonValue；这是编译期约束，运行期不校验。
// 例：{ count: 0 } 可赋值给 JsonObject；Date 或函数不行（类型层拒绝）。
/** A document root: a JSON object. */
export type JsonObject = { [key: string]: JsonValue };

// CommitPersistence 是判别联合：kind 为字面量类型 "immediate" | "deferred"，TS 用它可以收窄。
// immediate：commit 在写 store 后才 resolve；deferred：先在内存收养并发布，稍后再写（D8，任务状态用）。
// withinMs 默认 1000ms；运行期不校验数值范围，调用者传入什么就用什么。
// 例：const p: CommitPersistence = { kind: "deferred", withinMs: 200 }。
/**
 * When a commit reaches the store (Durable's `CommitPersistence`): `immediate`, the default, before the commit
 * resolves; `deferred` (a persisted run's state change, D8): adopted and published at once, stored with the next
 * immediate change, the run's outcome, the object's close, or about `withinMs` (default 1,000 ms) later.
 */
export type CommitPersistence =
	| { readonly kind: "immediate" }
	| { readonly kind: "deferred"; readonly withinMs?: number };

// checkpointWhen 能看到的存储信息：当前 base 之后已经累积了多少条 delta；运行期由 store 记录给出。
// 它不包含“本次变化是否要存 base”的决定，决定由 checkpointWhen 返回。
/** What a persisted document's `checkpointWhen` learns of its stored revisions. */
export type CheckpointInfo = {
	/** The deltas stored after its newest base, without the change being decided. */
	readonly deltasSinceBase: number;
};

// CheckpointWhen 是函数类型：输入文档新值、本次 ops、存储信息；返回 true 表示整根存成新 base，false 表示存 delta。
/** Whether a commit's change of a persisted document is stored as a whole new base (`true`) or as a delta. */
export type CheckpointWhen<T> = (value: T, ops: readonly Op[], info: CheckpointInfo) => boolean;

// StateOptions 是所有文档定义共有的输入；泛型 S 保留 schema 的类型，K 保留 keyed 的布尔字面量。
// initial 是每次缺席时取值的工厂（不是共享常量，singleton 和 keyed 每次都可能调用）。
// migrate 可选：缺少它时读取旧版本会抛错（见 StateDefinition.migrate）；函数应是纯函数。
// 这些字段是编译期接口；运行期 defineState 只检查 name 与默认值，不深度校验 schema。
/** What `defineState` takes for any document. */
type StateOptions<S extends Schema, K extends boolean> = {
	readonly schema: S;
	readonly version: number;
	readonly initial: () => DocumentOf<S>;
	/** Maps a value of an older version `from` to this version's shape; pure. Required to read older values. */
	readonly migrate?: (old: JsonObject, from: number) => DocumentOf<S>;
	readonly keyed?: K;
};

// 持久化文档额外要求：persist 必须为字面量 true，checkpointWhen 必填（内存文档则禁止出现 checkpointWhen，见第一个重载）。
/** What a persisted document adds (slice 6a §10): `checkpointWhen` is required. */
type PersistOptions<S extends Schema> = {
	/** Stored in the host's store; only in `local` types with empty params (P3). */
	readonly persist: true;
	/** Called once per commit per changed document; creations and version changes always store a base. */
	readonly checkpointWhen: CheckpointWhen<DocumentOf<S>>;
};

// 函数说明：声明一个文档定义；输入 name 与 options，返回 StateDefinition；运行期副作用只有 checkName 与对象创建。
// 例子：const cart = defineState("cart", { schema, version: 1, initial: () => ({ items: [] }) })。
// 重载 1：非持久化（persist?: false 且 checkpointWhen?: never）；重载 2：持久化（PersistOptions）。实现签名对调用者不可见。
// checkpointWhen?: never 的技巧：若调用者在非持久化分支传 checkpointWhen，类型是 never，编译错误；运行期仍会读到它。
// 实现签名把 persist/keyed 放宽为 boolean，是为了同时兼容两个重载；TS 只保证实现与重载兼容。
// 运行时 `?? false` 把 undefined 归一为 false；显式传入 false 也保持 false。
// checkpointWhen 原样传入 StateDefinition，构造函数再用 `?? NEVER` 处理缺省。
/**
 * Declares a document: a singleton per object, or with `keyed: true` many per object, each by a string key; with
 * `persist: true` stored in the host's store. Its name is a restricted name (lowercase `[a-z0-9@/._~-]`).
 */
export function defineState<S extends Schema, K extends boolean = false>(
	name: string,
	options: StateOptions<S, K> & { readonly persist?: false; readonly checkpointWhen?: never },
): StateDefinition<DocumentOf<S>, K, false>;
export function defineState<S extends Schema, K extends boolean = false>(
	name: string,
	options: StateOptions<S, K> & PersistOptions<S>,
): StateDefinition<DocumentOf<S>, K, true>;
export function defineState<S extends Schema, K extends boolean>(
	name: string,
	options: StateOptions<S, K> & {
		readonly persist?: boolean;
		readonly checkpointWhen?: CheckpointWhen<DocumentOf<S>>;
	},
): StateDefinition<DocumentOf<S>, K, boolean> {
	checkName(name, "A state name");
	const { schema, version, initial, migrate, keyed, persist, checkpointWhen } = options;
	return new StateDefinition(
		name,
		schema,
		version,
		initial,
		migrate,
		keyed ?? false,
		persist ?? false,
		checkpointWhen,
	);
}

// DocumentOf 用条件类型提取 schema 的静态类型，并要求它 extends JsonObject；否则解析为 never，defineState 调用编译失败。
// 这是纯类型映射，运行时不存在；schema 的运行时检查由 initial()/migrate() 首次验证完成。
/** The value of a document whose schema is `S`: its static type, which must be a JSON object. */
type DocumentOf<S extends Schema> = Static<S> extends JsonObject ? Static<S> : never;

// 默认检查点规则：永远返回 false（存 delta）；只有持久化且显式提供 checkpointWhen 时才会被替换。
const NEVER: CheckpointWhen<JsonObject> = () => false;

// 例：StateDefinition<{count:number}, false, false> 表示非键控、内存文档；~keyed/~persist 只在类型层携带 K/P。
/** A declared document; `T` is its value, `K` whether it is keyed, `P` whether it is persisted. */
export class StateDefinition<T extends JsonObject, K extends boolean, P extends boolean = false> {
	// name 是对外错误与存储地址的一部分；schema/version 是定义元数据；keyed/persist 在声明之间必须一致（SlotDefinition.check）。
	readonly name: string;
	readonly schema: Schema;
	readonly version: number;
	readonly keyed: boolean;
	readonly persist: boolean;
	// fingerprint 在构造时算一次：snapshotSchema 取 schema 的规范化形式，fingerprintOf 做 hash64；描述/标题不影响它。
	// fingerprint 用于发现“改了 schema 却没升 version”：同版本不同指纹会在加载/声明时被拒。
	/**
	 * `hash64` of the schema's normal form (descriptions and titles ignored), computed once: the same version with
	 * another fingerprint is a schema changed without a version bump.
	 */
	readonly fingerprint: string;
	// 这两个 declare 字段只做类型标记，不生成运行期字段；declare 告诉 TS 不要 emit。
	// 它们让类型层保留 K/P 的字面量，供 HandleOf 等条件类型使用。
	/** Type only: whether the definition is keyed. */
	declare readonly "~keyed"?: K;
	/** Type only: whether the definition is persisted. */
	declare readonly "~persist"?: P;
	readonly #initial: () => T;
	readonly #migrate: ((old: JsonObject, from: number) => T) | undefined;
	// #checkpointWhen 的类型写成对象方法再索引访问，是为了保持方法参数的双变（bivariance），让窄 T 的定义仍可当 StateDefinition<JsonObject,...> 使用。
	// 若写成普通函数属性，严格函数类型下参数逆变会让窄类型不可赋值，Chord 内部统一的 AnyDefinition 就无法接收它。
	// #checked 记录 initial() 是否已经做过一次 schema 校验（R8：只校验第一次）。
	/** Method-typed so that a definition of a narrower `T` still is a `StateDefinition<JsonObject, ...>`. */
	readonly #checkpointWhen: { rule(value: T, ops: readonly Op[], info: CheckpointInfo): boolean }["rule"];
	#checked = false;

	// 函数说明：保存定义字段并计算指纹；输入定义元数据，无输出；可能因 schema 快照/哈希抛错。
	// 构造函数不校验 version 为正、initial 是否匹配 schema；这些留到首次 initial()/加载时。
	// 每个 readonly 字段都在这里显式赋值：TS 的 strictPropertyInitialization 要求如此，运行期无额外检查。
	constructor(
		name: string,
		schema: Schema,
		version: number,
		initial: () => T,
		migrate: ((old: JsonObject, from: number) => T) | undefined,
		keyed: boolean,
		persist: boolean,
		checkpointWhen: CheckpointWhen<T> | undefined,
	) {
		this.name = name;
		this.schema = schema;
		this.version = version;
		this.#initial = initial;
		this.#migrate = migrate;
		this.keyed = keyed;
		this.persist = persist;
		this.#checkpointWhen = checkpointWhen ?? NEVER;
		this.fingerprint = fingerprintOf(snapshotSchema(schema, name).normal);
	}

	// 函数说明：转发持久化检查点规则；输入新值/ops/存储信息，返回是否存 base；永不查询内存文档。
	// 运行时若没有提供规则，NEVER 返回 false；不会因为调用而触发 I/O。
	/** Whether a persisted document's change is stored as a new base (its `checkpointWhen`); never asked in memory. */
	checkpointWhen(value: T, ops: readonly Op[], info: CheckpointInfo): boolean {
		return this.#checkpointWhen(value, ops, info);
	}

	// 函数说明：生成一个全新的缺席值；输入 context，返回 T；副作用是首次调用计入验证次数并可能抛错。
	// 例：initial(ctx) 连续两次返回两个独立对象（实现里是 () => ({count: 0})，不是共享引用）。
	// R8：第一次校验后 #checked 置真，后续不再校验；这假设用户的 initial 每次返回同形值，类型系统只保证 T。
	// 校验失败抛普通 Error（不是 ChordError）；activation 路径会把它包成 broken。
	/** A fresh `initial()` value; the first is checked against the schema (counted), later ones are not (R8). */
	initial(context: Context): T {
		const value = this.#initial();
		if (this.#checked) return value;
		this.#check(value, "initial()", context);
		this.#checked = true;
		return value;
	}

	// 函数说明：把 from 版本的旧值迁移到当前版本并校验；输入旧值/来源版本/context，返回 T。
	// 错误：没有 migrate 时抛普通 Error（值仍保留在存储中，不丢数据）；结果不符合 schema 时也抛普通 Error。
	// 例：migrate({n:1}, 1, ctx) 调用 #migrate 得到 {count:1}，校验后返回。
	// 迁移结果只校验一次，与 initial 一样计入 chord.data.validations。
	/**
	 * `old`, a value of version `from`, migrated to this version and checked against the schema once, as it is
	 * produced (R8, counted). Throws without a `migrate` (the access is refused, the data kept) and when the result does
	 * not match.
	 */
	migrate(old: JsonObject, from: number, context: Context): T {
		if (this.#migrate === undefined) {
			throw new Error(`${this.name}: no migrate from version ${from} to ${this.version}`);
		}
		const value = this.#migrate(old, from);
		this.#check(value, `migrate() from version ${from}`, context);
		return value;
	}

	// 函数说明：私有校验 helper；输入值、描述字符串、context；成功无返回，失败抛错；副作用是计数。
	// validatorFor(this, context) 按定义对象弱缓存验证器，首次编译计入 chord.data.compilations；失败时用描述定位 initial/migrate。
	// check 返回是否匹配；format 在编译时被当作注解，不做运行时格式断言。
	#check(value: T, what: string, context: Context): void {
		context.telemetry.metrics?.counter("chord.data.validations").add(1);
		if (!validatorFor(this, context).check(value)) {
			throw new Error(`${this.name}: ${what} does not match the schema`);
		}
	}
}
