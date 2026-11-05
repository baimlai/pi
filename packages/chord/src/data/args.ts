// 文件导读
// 所属包与模块：packages/chord/src/data 的参数模块（layer-1），服务 Chord 的契约调用分发。
// 职责边界：把插件提供者登记的契约与 accepts 表变成按版本分派的快速结构，并在每次调用时检查参数、
// 适配旧参数；不执行方法本身（L4 调度层负责），不校验返回值，也不编译验证器（首次调用才编译）。
// 上游：host 在插件 setup 时调用 bindProvider；link/调用路径把 method、raw、boundVersion、context 交给 checkArgs。
// 下游：checkArgs 返回 CheckedArgs，由调度层决定调用当前方法或提供者的旧版本替代函数；失败抛 ChordError。
// 错误流向：未知方法 invalid/member；版本未接受或明确拒绝 contract_mismatch；参数不符 invalid/args；
// 映射函数抛错原样传播（提供者代码责任）。
// 能力清单：
// - Value（类型）：JSON 加 Uint8Array 叶子的递归可传输值。
// - Provider<C>（类型）：契约、已接受版本表与 accepts 的绑定。
// - CheckedArgs<C,M>（联合类型）：检查后的调用形态，method 或 call，带可选结果反向映射。
// - bindProvider（函数）：登记提供者并建立版本→方法→规则的分发表。
// - binds（函数）：按版本与指纹判断消费者能否绑定。
// - checkArgs（函数）：每次调用的参数信任边界与旧版适配入口。
// 组合关系与典型调用顺序：bindProvider -> 保存 Provider -> 调用时 binds（可选）-> checkArgs ->
// 调度层执行 method/call。分发表缓存在 WeakMap，随 provider 回收。
// 示例（真实签名）：const provider = bindProvider(editorContract, accepts);
// const checked = checkArgs(provider, "add", rawArgs, 1, context); // kind 为 "method" 或 "call"
// 建议阅读顺序：先 Value/Provider/CheckedArgs，再看 bindProvider 与分发表构造，然后 checkArgs 的三段查找，
// 最后 binds 与 dispatchEntries/dispatchEntry 的细节。

// Arguments: a provider's binding (its dispatch table per accepted version) and the per-call argument check.

import type { Validator } from "@earendil-works/pi-schema";
import type { Context } from "../context/index.ts";
import { type AcceptedVersion, type AcceptsTable, checkAccepts } from "../contracts/accepts.ts";
import {
	type Contract,
	type CurrentVariants,
	contractData,
	type MethodData,
	type VersionData,
} from "../contracts/contract.ts";
import type { MemberNames, MethodAt } from "../contracts/history.ts";
import type { Static } from "../contracts/schema.ts";
import type { Snapshot } from "../contracts/snapshot.ts";
import { ChordError, invalid } from "./errors.ts";
import { check, validatorFor } from "./validator.ts";

/** JSON plus byte leaves. Same-host values are plain data and immutable once handed over, by convention. */
// 递归联合类型描述 JSON 加 Uint8Array 叶子；没有 undefined。这里只约束 TS，远端字节解析和参数校验由各自边界执行。
export type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value };

/**
 * A provider's binding of a contract with the older versions it accepts and their mappings (the table as checked, for
 * the state mappings of an older consumer's binding).
 */
// Provider 将具体契约 C 与已验收的旧版本表绑定；readonly 不深冻结 accepts，调用方按不可变约定使用。
export type Provider<C extends Contract> = {
	readonly contract: C;
	readonly accepted: readonly AcceptedVersion[];
	readonly accepts: AcceptsTable<C>;
};

/**
 * Checked arguments: a method's arguments in the current shape with the result mapping back to the caller's version,
 * or the old arguments for the provider's own `call` replacement (L4 dispatches it).
 */
// kind 是判别字段：method 表示调用当前实现，call 表示提供者为旧方法准备了替代函数。
// result 可选函数把当前返回值变回旧形状；它不在参数校验阶段执行。
export type CheckedArgs<C extends Contract, M extends string> =
	| { readonly kind: "method"; readonly args: ArgsOf<C, M>; readonly result?: (current: Value) => Value }
	| { readonly kind: "call"; readonly args: Value; readonly call: (args: Value, context: Context) => Promise<Value> };

// 条件类型从当前契约的方法名索引 args schema，再用 Static 推值类型；无法对应的方法名退回 Value。
type ArgsOf<C extends Contract, M extends string> = M extends MemberNames<CurrentVariants<C>, "methods">
	? Static<MethodAt<CurrentVariants<C>, M>["args"]>
	: Value;

/**
 * Binds a contract and the app's accepts table (validated once, kept as it is) into a provider. Builds the dispatch
 * table: accepted version -> method -> schema and mapping; nothing is compiled yet.
 */
// 登记一次提供者：输入真实契约和 accepts，先验证适配表，再建“版本→方法→规则/映射”表。
// 返回 provider 并用它作弱缓存键，无 I/O、此时不编译验证器；声明错误由 checkAccepts/contractData 抛出。
// 例如 v2 接受 v1 的 add 参数映射后，后续 v1 调用先按 v1 规则检查再直达 v2 参数。
export function bindProvider<C extends Contract>(contract: C, accepts: AcceptsTable<C>): Provider<C> {
	// 解构时把返回字段 versions 改名 accepted；此检查只检查映射形状，不调用映射函数。
	const { versions: accepted } = checkAccepts(contract, accepts);
	// 取 Chord 私有的完整版本历史；手工拼的契约没有私有登记，会在这里被拒绝。
	const { versions } = contractData(contract);
	// at(-1) 取最新版本；非空历史由声明流程保证，! 只是向 TS 表达这一前提。
	const current = versions.at(-1)!;
	// checkAccepts established this shape.
	// 将已验证适配表换成内部可读取类型；as 不执行运行时校验。
	const mappings = accepts as CheckedAccepts;
	// 先为当前版本建方法表，传 undefined 表示当前调用无需适配。
	const table: Dispatch = new Map([[current.version, dispatchEntries(current, undefined)]]);
	// 仅为明确接受的旧版本建立入口，不自动接受所有历史版本。
	for (const { version } of accepted) {
		// 在私有历史中定位旧版本；checkAccepts 已保证它存在。
		const data = versions.find((candidate) => candidate.version === version)!;
		// 旧版本入口保存其旧参数规则，以及本次提供者直接提供的旧→当前映射。
		table.set(version, dispatchEntries(data, mappings[version]?.methods));
	}
	// 创建登记对象，保留原 accepts 引用，不复制提供者的函数。
	const provider = { contract, accepted, accepts };
	// 以 provider 身份弱持有分发表；登记和进行中的调用都释放后可以回收。
	dispatchTables.set(provider, table);
	// 返回供绑定检查与每次调用复用的登记对象。
	return provider;
}

/**
 * Whether `provider` binds a consumer of `version` with `fingerprint`: its current version and fingerprint, or a
 * version it accepts with the fingerprint its own history computes (R6, Q10).
 */
// 输入提供者、消费者声明的版本与指纹；输出 boolean，表示该版本能否绑定到这个提供者。
// 不执行参数验证，也不调用 accepts 的映射；无 I/O、无副作用（只读 provider）。
// 主要流程：当前版本比较 fingerprint；旧版本在 accepted 中查找同时匹配版本与指纹的条目。
// 示例：提供者当前 v3，accepted 含 v2（指纹 f2）；binds(p, 2, "f2") 为 true，binds(p, 2, "f1") 为 false。
export function binds(provider: Provider<Contract>, version: number, fingerprint: string): boolean {
	// 读取当前提供者契约，判断当前版本时无需扫描旧版本表。
	const { contract } = provider;
	// 当前版本要求当前指纹完全相等，不能只看数字版本。
	if (version === contract.version) return fingerprint === contract.fingerprint;
	// some 遇到首个版本和指纹都相等的条目即为 true，否则 false。
	return provider.accepted.some((accepted) => accepted.version === version && accepted.fingerprint === fingerprint);
}

/** An accepts table after `checkAccepts`, as the binding reads it. */
// 内部索引签名按版本字符串读已检查的 methods；数字下标在普通对象上也会转成字符串键。
type CheckedAccepts = {
	readonly [version: string]: { readonly methods?: { readonly [member: string]: CheckedMethodMapping } };
};

// 联合区分拒绝、替代调用和参数/结果适配；这些回调由提供者代码承担正确性。
type CheckedMethodMapping =
	| "refuse"
	| { readonly call: (args: Value, context: Context) => Promise<Value> }
	| { readonly args?: (old: Value) => Value; readonly result?: (current: Value) => Value };

/** Accepted version -> method -> entry. */
// 两层 Map：先按数字版本，再按方法名检索，避免每次调用重建契约结构。
type Dispatch = Map<number, Map<string, DispatchEntry>>;

// kind 联合让拒绝项不带规则，另外两类都有旧参数规则和可延迟创建的 validator。
type DispatchEntry =
	| { readonly kind: "refuse" }
	| {
			readonly kind: "call";
			readonly args: Snapshot;
			readonly call: (args: Value, context: Context) => Promise<Value>;
			validator: Validator | undefined;
	  }
	| {
			readonly kind: "method";
			readonly args: Snapshot;
			readonly mapArgs: ((old: Value) => Value) | undefined;
			readonly mapResult: ((current: Value) => Value) | undefined;
			validator: Validator | undefined;
	  };

// 弱缓存仅按提供者登记对象持有表，不用全局强 Map 留住旧插件函数。
const dispatchTables = new WeakMap<Provider<Contract>, Dispatch>();

// 为某个版本建立方法分发表。输入是私有历史的版本快照（含多个变体）和该版本的提供者映射；
// 输出“方法名 -> 入口”的 Map。不编译验证器、不运行适配函数、无 I/O。
// 流程：把各变体的 methods 摊平并去重（同名方法签名一致），再为每个方法构造入口。
// 例如 editor/reader 都有同签名 add 时折叠成一个 add 项；这种折叠依赖声明已验证同名方法签名一致。
function dispatchEntries(
	version: VersionData,
	mappings: { readonly [member: string]: CheckedMethodMapping } | undefined,
): Map<string, DispatchEntry> {
	// 为该版本创建独立的结果映射。
	const entries = new Map<string, DispatchEntry>();
	// A method has one signature in every variant that has it.
	// 展开所有变体的方法条目后放进 Map；重复名字覆盖，已保证签名相同。
	const methods = new Map<string, MethodData>([...version.variants.values()].flatMap(({ methods }) => [...methods]));
	// 逐个唯一方法提取参数快照，结果 schema 不参与参数校验。
	for (const [member, { args }] of methods) {
		// 只读取映射自身拥有的键，避免原型上的同名属性被当成提供者声明。
		const mapping = mappings !== undefined && Object.hasOwn(mappings, member) ? mappings[member] : undefined;
		// 按拒绝/替代/普通映射构造一个入口，保存到方法名下。
		entries.set(member, dispatchEntry(args, mapping));
	}
	// 返回该版本的方法表给外层版本表使用。
	return entries;
}

// 把单个方法映射转成带 kind 的入口。输入参数快照 args 与提供者可选映射；
// 输出 DispatchEntry（validator 初始为 undefined，首次调用才编译）。不执行映射函数、无 I/O。
// 三种映射对应三种输出：refuse 拒绝、call 旧方法替代、args/result 适配（缺省即普通当前方法）。
// 例如 "refuse" 只返回拒绝标记，{call} 保留替代函数。
function dispatchEntry(args: Snapshot, mapping: CheckedMethodMapping | undefined): DispatchEntry {
	// 拒绝项以后直接报 contract_mismatch，无需编译其参数规则。
	if (mapping === "refuse") return { kind: "refuse" };
	// 已验收的映射有 call 时使用旧方法替代分支。
	if (mapping !== undefined && "call" in mapping) {
		// 保留旧参数 schema 和替代函数，validator 等到首次调用再创建。
		return { kind: "call", args, call: mapping.call, validator: undefined };
	}
	// 缺省映射也属于普通当前方法；?. 让未提供的两种适配函数保留 undefined。
	return { kind: "method", args, mapArgs: mapping?.args, mapResult: mapping?.result, validator: undefined };
}

/**
 * Checks a call's arguments against the provider's schema for the caller's bound version: three map lookups, one
 * compiled check, at most one direct mapping old -> current (never for current-version calls). A method without
 * arguments gets `null` (its internal and wire form). Unknown method: `invalid/member`; version not accepted or refused: `contract_mismatch`.
 */
// 执行一次真实调用的参数边界检查；输入 provider/方法名/unknown 参数/绑定版本/context。
// 按版本与方法找入口，先验证旧形状，随后最多执行一次参数映射；返回待调度的 tagged union。
// 例如旧 add 接收 {text:"x"}，先查旧 schema 再映成当前 {body:"x"}，映射输出不二次校验。
// 未知方法抛 invalid/member，版本缺失或明确拒绝抛 contract_mismatch；缓存/遥测会更新，映射异常原样传播。
export function checkArgs<C extends Contract, M extends string>(
	provider: Provider<C>,
	method: M,
	raw: unknown,
	boundVersion: number,
	context: Context,
): CheckedArgs<C, M> {
	// 读取名称仅用于后续错误文字。
	const name = provider.contract.name;
	// 登记对象保证存在私有表，再按消费者已绑定的版本查找；! 不创造缺失登记。
	const methods = dispatchTables.get(provider)!.get(boundVersion);
	// 没有此版本入口就不能以这个版本调用提供者。
	if (methods === undefined) {
		// 错误只说明版本未被接受，不尝试串接其他旧版本映射。
		throw new ChordError({ code: "contract_mismatch", message: `${name} v${boundVersion} is not accepted` });
	}
	// 在对应版本的方法名字表中查一个入口。
	const entry = methods.get(method);
	// 未知方法是无效成员，和已声明但提供者拒绝的旧方法区分。
	if (entry === undefined) throw invalid("member", `${name} v${boundVersion} has no method "${method}"`);
	// 显式拒绝该旧方法时提前结束，不检查其输入值。
	if (entry.kind === "refuse") {
		// 用 contract_mismatch 向消费者表示接口版本下此方法不可用。
		throw new ChordError({ code: "contract_mismatch", message: `${name} v${boundVersion} refuses "${method}"` });
	}
	// ??= 仅在尚未有验证器时取得/编译，并存回入口供下一次调用复用。
	entry.validator ??= validatorFor(entry.args, context);
	// 对每个调用者都按提供者持有的该版本参数规则检查 unknown，失败抛 invalid/args。
	check(entry.validator, raw, "args", context);
	// The check above establishes the argument type; mapping output is trusted.
	// 校验建立值约束后才断言成 Value；不复制 raw 或改变它的引用。
	const args = raw as Value;
	// 替代分支把已校验的旧参数和 call 函数交还上层，本函数不执行调用。
	if (entry.kind === "call") return { kind: "call", args, call: entry.call };
	// 普通分支返回当前形状参数和可选结果反向映射；kind 供上层调度收窄类型。
	return {
		kind: "method",
		// 无参数映射就沿用原引用；有则调用一次旧→当前回调，输出按提供者契约信任。
		args: (entry.mapArgs === undefined ? args : entry.mapArgs(args)) as ArgsOf<C, M>,
		// 仅携带当前→旧结果映射，等真正方法完成后由上层使用。
		result: entry.mapResult,
	};
}
