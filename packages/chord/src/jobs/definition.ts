// Job definitions (§15): `defineJob(name, …)`, the checks of a declaration, and the types of what a run ends with.

// 文件导读（作业声明层）
// 所属：packages/chord/src/jobs，Chord v2 作业模块的声明层。
// 职责边界：把插件写的普通配置变成经过运行期校验的 JobDefinition；不启动运行、不写 store、不管理状态文档。
// 上游入口：插件在模块顶层调用 defineJob；host/attempt.ts 的 `job(definition, implementation)` 读取这里产出的
// version/args/result/state/concurrency/accepts/persist/fingerprint。
// 下游依赖：contracts 的 checkName/checkKeys/snapshotArguments/snapshotSchema/hash64，以及 documents 的
// StateDefinition（只读取其 version/keyed/persist/fingerprint，不修改它）。
// 结果与错误流向：成功返回不可变 JobDefinition；失败直接抛普通 Error，错误信息带声明路径（如 `name.accepts[2].args`），
// 对象尝试激活时会被当作声明失败处理。运行期的参数错误不在这里，而是在 start 时由 args 快照校验。
// 能力清单：
// - JobOptions：defineJob 的配置类型，绑定 args/result/state 三个 schema/定义。
// - JobPersistence：持久化运行的恢复策略（rerun/abandon）。
// - JobAccepts：旧版本号到 args/result 前向映射函数的表。
// - StateOf：编译期条件类型，从状态定义抽出文档值（无状态时是 undefined）。
// - Outcome：运行结束后的公开结果联合（done 带 result，failed 带 JobError）。
// - JobError：运行失败的三种原因（抛出、被中止、重启上限）。
// - defineJob：唯一值导出，完成全部声明检查并计算指纹。
// - checkPersistence / checkJobAccepts：两个内部校验器，分别约束持久化选项与 accepts 表。
// - JobDefinition：声明产物类，保存 schema 快照与运行所需元数据。
// 组合关系/典型顺序：defineJob 先 checkName/checkKeys，再复制 args/result 快照，接着校验 state 与 persist 的联动，
// 再校验 concurrency/accepts，最后用 normal 形式计算 fingerprint 并构造 JobDefinition。
// 示例（真实签名）：
//   const Sum = defineJob("sum", { version: 1, args: obj({ a: int(), b: int() }), result: int() });
//   Sum.version === 1；若把 version 改为 0，defineJob 当场抛 "sum.version: expected a positive integer"。
// 建议阅读顺序：JobOptions -> Outcome/JobError -> defineJob -> checkPersistence/checkJobAccepts -> JobDefinition。
// 注意两类检查的区别：这里的检查都在 JavaScript 运行时执行（TS 类型不能阻止 JS 调用者），
// 而泛型 A/R/S 只在编译期给插件提供类型提示；运行期 args 的逐次校验发生在 start 时，result 从不校验。
import { checkKeys, entriesOf } from "../contracts/declare.ts";
import type { Schema, Static } from "../contracts/index.ts";
import { checkName, hash64 } from "../contracts/internal.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "../contracts/snapshot.ts";
import type { ChordError, PluginError } from "../data/index.ts";
import type { JsonObject, StateDefinition } from "../documents/index.ts";

/** What `defineJob` takes besides the name. */
// 这是 defineJob 的配置对象。三个类型参数分别绑定参数 schema（A）、结果 schema（R）和状态定义（D）。
// A、R 使用 `extends Schema`，因为 options.args/result 必须能被 snapshotSchema 读取；
// D 只允许“单例文档定义”（`StateDefinition<JsonObject, false, boolean>`），keyed 状态在 defineJob 里会被拒绝。
// 这些字段是 JSON 形状的声明，defineJob 返回后不再变化；因此全部 readonly 只是编译期约束。
export type JobOptions<
	A extends Schema,
	R extends Schema,
	D extends StateDefinition<JsonObject, false, boolean> | undefined,
> = {
	/** The job's version; every change of its args, result or state bumps it. */
	// 版本号是运行记录与代码之间的契约：持久化的运行固定在自己启动时的版本上，
	// 之后代码升级只通过 accepts 把旧参数/结果映射到新版本。运行期校验为正的安全整数。
	readonly version: number;
	/** The run's arguments: closed objects, JSON only (`running` carries them), checked at every start. */
	// 参数 schema。defineJob 会复制它（snapshotArguments）并拒绝 bytes()，因为 running 列表要把 args 放进 JSON；
	// 每次 start 时用这份快照编译出的校验器检查实参，不合法会以 invalid/args 拒绝。
	readonly args: A;
	/** What `run` returns; not validated. */
	// 结果 schema 只用于类型和指纹（以及持久化时禁止 bytes），不会在运行结束时校验返回值。
	readonly result: R;
	/**
	 * A singleton document definition: one document per run, `ctx.state` in `run`, `outcome.state` in `finish`; a
	 * persisted job's is persisted (`persist: true`, its `checkpointWhen`).
	 */
	// 可选状态文档：每个 run 独享一份，run 里通过 ctx.state 读写，finish 里从 outcome.state 读最终值。
	// 若作业持久化，这份状态也必须 persist: true，否则 checkPersistence 会拒绝。
	readonly state?: D;
	/** At most this many runs running or finishing per object; a start beyond it rejects `unavailable/busy`. */
	// 每个对象上“正在运行或正在收尾”的运行数上限；超过时 start 立即以 unavailable/busy 拒绝。未声明则不限。
	readonly concurrency?: number;
	/** Per older version, how its args and result map forwards (used from slice 7 on; checked now). */
	// 旧版本兼容表：键是旧版本号，值是 args/result 的前向映射函数。运行期在 defineJob 时校验形状，
	// 真正使用要等 reload 之后（slice 7）：旧版本运行要用当前版本的代码处理。
	readonly accepts?: JobAccepts<A, R>;
	/**
	 * Persists the runs in the object's store (slice 6b; only in `local` types with empty params, P3): how a run cut
	 * off by a crash or a stop resumes, `rerun` (its `run` again: idempotent work) or `abandon` (`finish` gets `failed {
	 * aborted, reason: "restart" }`). Its result is JSON only (no `bytes()`).
	 */
	// 持久化选项。`rerun` 表示崩溃/停机后重新执行 run（要求 run 幂等）；`abandon` 表示不再重跑，
	// 直接让 finish 收到 aborted/restart 的失败结果。持久化运行的结果必须可 JSON 存储，因此禁止 bytes。
	readonly persist?: JobPersistence;
};

/** How a persisted job's runs resume after a crash or a stop. */
// 只影响“已被切断、但对象还在”的运行：rerun 重新调用 run；abandon 直接把这次运行判为失败交给 finish。
// 这是运行期真值（records.ts 的 cut 分支会读它），不是仅类型提示。
export type JobPersistence = { readonly resume: "rerun" | "abandon" };

/** Per older version, its mappings forwards: its args to the current args, its result to the current result. */
// 映射表用数字索引签名表示：键必须是旧版本号（运行期 checkJobAccepts 检查 >=1 且 < 当前版本）。
// 函数参数写作 `old: never` 是一种类型占位：调用点拿到的旧值在编译期没有精确类型，
// 插件需要自己按旧版本形状断言；返回值被声明为当前 schema 的静态类型，但不代表运行期会校验它。
export type JobAccepts<A extends Schema = Schema, R extends Schema = Schema> = {
	readonly [version: number]: { readonly args: (old: never) => Static<A>; readonly result: (old: never) => Static<R> };
};

/** The value of a job's state document: the definition's document, `undefined` without one. */
// StateOf 是编译期的条件类型（conditional type）：D 是否能匹配 StateDefinition<infer T, false, boolean>？
// 能则用 infer 抽出的文档值 T，不能（即 D 是 undefined）则得到 undefined。
// 例：StateOf<typeof Counter> = { count: number }；StateOf<undefined> = undefined。它没有运行时代码。
type StateOf<D> = D extends StateDefinition<infer T, false, boolean> ? T : undefined;

/** What a run ended with, as `finish` and `outcome` get it: its args and state, and its result or its error. */
// Outcome 用交叉类型（&）把公共字段 id/args/state 与一个可判别联合（kind: "done" | "failed"）拼起来。
// 这样 finish 和调用方先看 kind 就能安全访问 result 或 error；args/state 是运行开始时的快照值，不是引用。
export type Outcome<A, R, S> = { readonly id: string; readonly args: A; readonly state: S } & (
	| { readonly kind: "done"; readonly result: R }
	| { readonly kind: "failed"; readonly error: JobError }
);

/**
 * Why a run failed: `run` threw (reported as `job_failed`; anything but a ChordError or PluginError becomes a
 * PluginError `internal` with its message), it was aborted (`abort`: `abort(id)`; `restart`: cut off by its attempt's
 * seal while the object continues, or a persisted run abandoned after a crash; `reload` comes with slice 7), or a
 * persisted run was cut off five times in a row (`restart_limit`, D6).
 */
// 三种失败来源互斥，用 kind 判别：
// threw 是 run 自己抛出（非 ChordError/PluginError 会被包装成 PluginError internal）；
// aborted 是外部原因（用户 abort、重启、reload）；restart_limit 是持久化运行连续被切断达到上限。
// 这些对象可能被持久化到运行记录里，因此 error 字段必须是可序列化的 ChordError/PluginError。
export type JobError =
	| { readonly kind: "threw"; readonly error: ChordError | PluginError }
	| { readonly kind: "aborted"; readonly reason: "abort" | "reload" | "restart" }
	| { readonly kind: "restart_limit"; readonly restarts: number };

/** Declares a job: owned work a call starts that outlives it (§15). */
// 用途：把插件的声明规范化。输入 name 与 JobOptions，输出一个不可变的 JobDefinition；
// 无 I/O、无定时器，错误就是直接 throw 的普通 Error（在对象尝试激活时会变成声明失败）。
// 主要流程：名字/键/版本校验 -> 复制 args schema -> 复制 result schema -> 状态与持久化规则 -> accepts 形状 -> 计算指纹。
// 小例子（真实运行时）：defineJob("summarize", { version: 1, args: obj({ text: str() }), result: obj({ summary: str() }) })
// 返回的 definition.version 为 1，definition.args 是 schema 的副本；若把 version 写成 0 会当场抛错。
export function defineJob<
	// `const` 类型参数让调用点传入的字面量保持窄类型（例如 version 的 schema 常量不被拓宽），
	// 这里主要用于让 A/R 精确对应调用者传的 schema 对象。
	const A extends Schema,
	const R extends Schema,
	// D 默认 undefined：不传 state 时 S 就是 undefined；显式传入时必须满足单例文档定义。
	D extends StateDefinition<JsonObject, false, boolean> | undefined = undefined,
>(name: string, options: JobOptions<A, R, D>): JobDefinition<Static<A>, Static<R>, StateOf<D>> {
	// Declaration policy: JavaScript callers reach every check below.
	// 声明策略检查（不是类型检查）：名字必须是受限名称，选项里不能出现未知键。
	checkName(name, "A job name");
	checkKeys(options, ["version", "args", "result", "state", "concurrency", "accepts", "persist"], name);
	// 解构只为后续检查；这些字段仍来自调用者的对象，不做防御性复制（schema 在下一行才复制）。
	const { version, state, concurrency, accepts, persist } = options;
	// Number.isSafeInteger 同时排除 NaN、小数和超出安全整数的值；版本必须从 1 开始。
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	// snapshotArguments 复制 args schema，并给出 normal 形式（用于指纹）以及是否含 bytes 叶子。
	const args = snapshotArguments(options.args, `${name}.args`);
	// running 列表把 args 当 JSON 暴露，bytes() 无法表示，因此在这里拒绝而不是等到 start。
	if (args.bytes) throw new Error(`${name}.args: job arguments are JSON (running carries them); no bytes()`);
	// result 只做 schema 快照；是否含 bytes 由持久化检查单独约束。
	const result = snapshotSchema(options.result, `${name}.result`);
	// 每个运行只能有一份状态文档，所以 state 必须是单例定义（keyed 在这里被拒绝）。
	if (state?.keyed) throw new Error(`${name}.state: expected a singleton document definition`);
	// 持久化约束集中在一个函数里，便于把“结果可存储、状态也持久化”的条件一起检查。
	if (persist !== undefined) checkPersistence(persist, state, result, name);
	// 并发上限必须是正的安全整数；0 没有意义，负数更不合法。
	if (concurrency !== undefined && !(Number.isSafeInteger(concurrency) && concurrency > 0)) {
		throw new Error(`${name}.concurrency: expected a positive integer`);
	}
	// accepts 的键必须是严格更旧的版本，且每项恰有 args/result 两个函数。
	if (accepts !== undefined) checkJobAccepts(accepts, version, `${name}.accepts`);
	// 指纹覆盖 args、result schema 的 normal 形式和状态文档自身指纹。
	// 同样版本号但任一 schema 变了，指纹就变；持久化运行据此判断“没升版本却改了 schema”。
	const fingerprint = hash64(
		JSON.stringify({ args: args.normal, result: result.normal, state: state?.fingerprint ?? null }),
	);
	// accepts ?? {}：未声明时给一个空表，后续 reload 逻辑不必再判空；其余字段原样交给定义对象。
	return new JobDefinition(name, version, args, result, state, concurrency, accepts ?? {}, persist, fingerprint);
}

/** A persisted job's declaration: a resume rule, a persisted state document (if any), a JSON-only result. */
// 输入是调用者给的 persist（类型上已声明但运行期仍可能是任意 JS 值），以及状态/结果快照与作业名。
// 输出 void；不合法直接抛 Error。副作用只有抛错，不修改任何对象。
// 例：persist: { resume: "rerun" } 且 state 是 persist:true 的单例文档，则通过；
// persist: { resume: "later" } 会抛 `${name}.persist.resume` 错误。
function checkPersistence(
	persist: unknown,
	state: StateDefinition<JsonObject, false, boolean> | undefined,
	result: Snapshot,
	name: string,
): void {
	// 未知键立即报错，避免拼写错误被静默忽略（例如 resume 写成 resum）。
	checkKeys(persist, ["resume"], `${name}.persist`);
	// 先断言成只含可选 resume 的窄形状，再逐值判断；这里的 as 只是让 TS 允许 unknown 字段继续检查。
	const { resume } = persist as { readonly resume?: unknown };
	// 运行期真正的枚举校验：只接受两个字面量字符串。
	if (resume !== "rerun" && resume !== "abandon")
		throw new Error(`${name}.persist.resume: expected "rerun" or "abandon"`);
	// 持久化作业的每个运行状态都会落盘，所以状态文档必须本身也是持久化文档。
	if (state !== undefined && !state.persist) {
		throw new Error(`${name}.state: a persisted job's state is a persisted document (persist: true)`);
	}
	// 结果会写入运行记录，必须是纯 JSON；bytes 叶子无法由 store 的 JSON 列表示。
	if (result.bytes) throw new Error(`${name}.result: a persisted job's result is JSON (it is stored); no bytes()`);
}

/** Checks an accepts table's shape: older versions only, each with an `args` and a `result` function. */
// 输入是对象（运行期可能来自 JS，所以参数写 unknown）、当前版本号和用于错误信息的路径前缀；输出 void，失败抛 Error。
// entriesOf 同时枚举自有可枚举键；Number(key) 把数字索引签名的键还原成数字。例：accepts 表里有 "2" 或 2 都按版本 2 处理。
// 这里只检查形状，不调用映射函数；映射函数是插件代码，在 reload 处理旧运行时才会执行。
function checkJobAccepts(accepts: unknown, version: number, path: string): void {
	// 逐项检查，任何一项失败都会立即中断并带上具体路径，方便定位声明里的笔误。
	for (const [key, adapter] of entriesOf(accepts, path)) {
		// 键可能来自普通对象，字符串键需要转成数字再比较；非整数转换会得到 NaN，下面会拒绝。
		const older = Number(key);
		// 旧版本必须 >=1 且严格小于当前版本；等于当前版本没有“向前映射”的意义。
		if (!Number.isSafeInteger(older) || older < 1 || older >= version) {
			throw new Error(`${path}[${key}]: not an older version`);
		}
		// 每一项恰好两个键，避免多写/漏写。
		checkKeys(adapter, ["args", "result"], `${path}[${key}]`);
		// 同样先窄化到可选 unknown，再做 typeof 检查（运行期信任边界）。
		const { args, result } = adapter as { readonly args?: unknown; readonly result?: unknown };
		// 映射必须是函数；只检查可调用性，不检查函数签名（JS 无法在运行期看到 TS 参数类型）。
		if (typeof args !== "function") throw new Error(`${path}[${key}].args: expected a function`);
		if (typeof result !== "function") throw new Error(`${path}[${key}].result: expected a function`);
	}
}

/** A declared job; `A`, `R` and `S` are its args, result and state document (`undefined` without one). */
// JobDefinition 是 defineJob 的产物，也是运行记录的静态依据：它保存校验后的 schema 快照、版本、状态定义、
// 并发上限和指纹。实例构造后字段不再变化（readonly 是编译期约束；运行期代码约定不修改它）。
// 上游：defineJob；下游：host/attempt.ts 的 self.job、records.ts 的 check/redefine、job.ts 的参数校验。
export class JobDefinition<A, R, S> {
	readonly name: string;
	readonly version: number;
	/** The args schema, Chord's copy; its compiled check is cached by this snapshot. */
	// 注意这是 Snapshot（schema 的规范化副本），不是插件传入的原对象；缓存的编译校验器挂在这份快照上。
	readonly args: Snapshot;
	readonly result: Snapshot;
	// 状态定义：record 里保存的是同一份 StateDefinition 引用；运行期用它创建每个运行的状态文档。
	readonly state: StateDefinition<JsonObject, false, boolean> | undefined;
	readonly concurrency: number | undefined;
	/** The older versions' mappings, checked at declaration; slice 7 maps older runs with them. */
	// 空对象 {} 表示没有旧版本映射（不是 undefined），这让 reload 逻辑可以直接按键查找。
	readonly accepts: JobAccepts;
	/** How its runs persist; `undefined` for a job in memory. */
	// undefined 表示内存作业；有值表示运行记录会写入 chord.jobs 命名空间。
	readonly persist: JobPersistence | undefined;
	/** `hash64` of its args', result's and state's normal forms: a stored run of another fingerprint is blocked. */
	// 指纹是 16 进制字符串（hash64），用于比较“同版本但 schema 已经变了”的情况，不会在运行期重新计算。
	readonly fingerprint: string;
	/** Type only: the args, result and state types. */
	// declare 字段不产生 JS 属性，只在类型层保存 A/R/S，让 `JobDefinition<...>` 的类型参数可被下游推断。
	// 运行期访问 definition["~types"] 得到 undefined；它没有校验作用。
	declare readonly "~types"?: { readonly args: A; readonly result: R; readonly state: S };

	// 构造器采用显式字段赋值（而不是 TS 参数属性），因为代码要在 Node 的 strip-only 模式下直接运行；
	// 参数属性需要 JS 生成，属于该模式禁止的语法。
	constructor(
		name: string,
		version: number,
		args: Snapshot,
		result: Snapshot,
		state: StateDefinition<JsonObject, false, boolean> | undefined,
		concurrency: number | undefined,
		accepts: JobAccepts,
		persist: JobPersistence | undefined,
		fingerprint: string,
	) {
		// 逐字段复制 defineJob 已校验过的值；构造器不再重复检查，避免同一规则出现两份。
		// 这里没有副作用（不注册、不分配 id），所以同一份声明重复 defineJob 会得到等价的独立对象。
		this.name = name;
		this.version = version;
		this.args = args;
		this.result = result;
		this.state = state;
		this.concurrency = concurrency;
		this.accepts = accepts;
		this.persist = persist;
		this.fingerprint = fingerprint;
	}
}
