// Accepted versions: the older versions a provider still serves, with the direct mappings their edits require.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约版本的兼容层。
// 解决的问题：提供者演进到新版本后，旧消费者仍可能连接；提供者需要声明接受哪些旧版本，并为每个旧版本给出
//   从旧到新（参数）和从新回旧（结果、状态）的映射。
// 职责边界：本文件只在声明期验证映射表的键和形状，不执行映射函数；真正的转换由链接层在读取时调用。
// 上游：bindProvider 在登记提供者时调用 checkAccepts（测试也可直接调用）；下游：绑定流程使用返回的版本号/指纹，
//   读取流程使用映射表。
// 结果流向 AcceptedVersion[]；错误以带路径的 Error 抛给调用方（未知版本、缺失/多余/形状错误的映射）。
// 能力清单：
// - AcceptsTable、AcceptsOf、VersionMappings：按旧版本号组织的映射表类型。
// - StateMapping、RemoteStateMappings、KeyedMappings：state/keyed 成员的映射方向与 refuse 规则。
// - MethodMappings、ChangedMethod、Replacement：方法参数/结果映射、替代实现或 refuse。
// - AcceptedVersion：检查通过后的版本号与指纹。
// - checkAccepts()：唯一入口，验证整张表但不调用映射。
// - Needs、needs()、changeKey()：根据编辑历史推导某旧版本真正需要的映射。
// - checkMappings()、checkSection()、checkStateMapping()、checkKeyedMapping()、checkMethodMapping()、checkSide()：
//   分段、逐键、逐侧的运行时结构检查。
// 组合关系：evolve 记录 Change -> checkAccepts(contract, accepts) -> needs() 汇总旧版本之后的编辑 ->
//   checkMappings() 逐段验证 -> 返回 versions；后续链接读取时才真正调用映射。
// 示例：
//   const v2 = evolve(v1, (e) => e.args("add", int()).result("add", str()));
//   checkAccepts(v2, {
//     1: { methods: { add: { args: (old) => String(old), result: (now) => Number(now) } } },
//   });
// 建议阅读顺序：先看 AcceptsTable/VersionMappings 理解三段结构，再看 StateMapping 与 ChangedMethod 的方向，
//   然后看 checkAccepts/needs 的运行时推导，最后看 checkSection/checkSide 等辅助检查。

import type { Context } from "../context/index.ts";
import {
	type Contract,
	type ContractData,
	type ContractShape,
	contractData,
	type Kind,
	LOCAL,
	type ShapeOf,
} from "./contract.ts";
import { checkKeys, entriesOf } from "./declare.ts";
import type {
	Change,
	ChangesAfter,
	CurrentStep,
	MemberNames,
	MethodAt,
	OlderVersions,
	StepAt,
	VariantShape,
	Variants,
	VariantsWith,
} from "./history.ts";
import type { Method, Static } from "./schema.ts";

/** Per accepted older version, exactly the mappings its later edits require (direct: old to current). */
// accepts 表以“旧版本号字符串”为键；每个旧版本只需列出从它到当前版本之间编辑真正要求的映射。
// 键是可选的（?），因为可以一个旧版本都不接受；值与编译期推导出的需求类型绑定。
export type AcceptsTable<C extends Contract> = AcceptsOf<ShapeOf<C>>;

// OlderVersions 给出所有旧版本号；StepAt 找该版本的变体，CurrentStep 找当前版本，ChangesAfter 得到其后的编辑。
type AcceptsOf<S extends ContractShape> = {
	readonly [V in OlderVersions<S["history"]>]?: VersionMappings<
		S["kind"],
		StepAt<S["history"], V>["variants"],
		CurrentStep<S["history"]>["variants"],
		ChangesAfter<S["history"], V>
	>;
};

// 一个版本的映射表固定分三段：state、methods、keyed（remote 的 keyed 是空类型）。
// 用交集拼起来；Section 按“是否真的有需求”决定该段必填还是可省略。
type VersionMappings<K extends Kind, Old extends Variants, Current extends Variants, C extends Change> = Section<
	"state",
	K extends "local" ? StateMappings<Old[Local], Current[Local], Local, C> : RemoteStateMappings<Old, Current, C>
> &
	Section<"methods", MethodMappings<Old, Current, C>> &
	Section<"keyed", K extends "local" ? KeyedMappings<Old[Local], Current[Local], C> : Record<never, never>>;

/**
 * A local contract's keyed members (slice 7b): a changed one maps each document of the current version back, or
 * refuses; a removed one refuses (no document maps from the whole state).
 */
// keyed 成员变化时：schema 变了要提供“当前文档 -> 旧文档”的函数或 "refuse"；
// 整个成员被删除时只能 "refuse"，因为无法从变化后的整份状态里还原每个旧文档。
type KeyedMappings<Old extends VariantShape, Current extends VariantShape, C extends Change> = OmitNever<{
	[S in keyof NonNullable<Old["keyed"]>]: S extends keyof NonNullable<Current["keyed"]>
		? [Local, S, "keyed"] extends C
			? ((current: Static<NonNullable<Current["keyed"]>[S]>) => Static<NonNullable<Old["keyed"]>[S]>) | "refuse"
			: never
		: "refuse";
}>;

// local 契约唯一 variant 的字面量类型，用来索引 Old/Current 的成员表。
type Local = typeof LOCAL;

/** A section is required when it holds a required mapping; otherwise it may be absent or empty. */
// 如果 T 里没有任何键（never 属性过滤后），该段可省略，且只允许空对象；否则该段必填。
// 元组 [keyof T] 防止 never 触发分布式条件类型的怪异结果。
type Section<Key extends string, T> = [keyof T] extends [never]
	? { readonly [K in Key]?: { readonly [member: string]: never } }
	: { readonly [K in Key]: T };

/** `T` without its `never` properties: the members that need no mapping. */
// 键重映射：值为 never 的属性直接删掉，只留下真正需要映射的成员。
type OmitNever<T> = { readonly [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] };

// remote 的 state 映射按变体分组；只保留至少有一个成员需要映射的变体。
type RemoteStateMappings<Old extends Variants, Current extends Variants, C extends Change> = OmitNever<{
	[X in keyof Old & keyof Current]: [keyof StateMappings<Old[X], Current[X], X, C>] extends [never]
		? never
		: StateMappings<Old[X], Current[X], X, C>;
}>;

// 一个变体内，每个旧 state 成员对应的映射需求。
type StateMappings<Old extends VariantShape, Current extends VariantShape, X, C extends Change> = OmitNever<{
	[S in keyof Old["state"]]: StateMapping<Old, Current, X, S, C>;
}>;

/** A changed member maps the current member back; a removed one maps the variant's whole current state, or refuses. */
// 成员仍存在且被编辑过：提供“当前值 -> 旧值”的函数；成员被删除：提供“整个当前 state -> 旧值”的函数或 "refuse"。
// [X, S, "state"] extends C 表示这次编辑确实发生在从该旧版本之后的路径上。
type StateMapping<
	Old extends VariantShape,
	Current extends VariantShape,
	X,
	S extends keyof Old["state"],
	C,
> = S extends keyof Current["state"]
	? [X, S, "state"] extends C
		? (current: Static<Current["state"][S]>) => Static<Old["state"][S]>
		: never
	: ((state: { [M in keyof Current["state"]]: Static<Current["state"][M]> }) => Static<Old["state"][S]>) | "refuse";

// 方法映射：如果方法在旧版本存在、但当前版本某些变体里已删除，必须提供替代实现或 "refuse"；
// 否则只为真正改动过的参数/结果侧生成映射。
type MethodMappings<Old extends Variants, Current extends Variants, C extends Change> = OmitNever<{
	[M in MemberNames<Old, "methods">]: [RemovedFrom<Current, VariantsWith<Old, M>, M>] extends [never]
		? ChangedMethod<
				Changed<C, VariantsWith<Old, M>, M, "args">,
				Changed<C, VariantsWith<Old, M>, M, "result">,
				MethodAt<Old, M>,
				MethodAt<Current, M>
			>
		: Replacement<MethodAt<Old, M>>;
}>;

/** The variants among `Xs` that no longer have method `M`. */
// 对每个仍拥有该方法的旧变体，如果当前版本对应变体已经没有它，就把变体名留下来；结果是这些变体名的联合。
type RemovedFrom<Current extends Variants, Xs extends keyof Current, M> = {
	[X in Xs]: M extends keyof Current[X]["methods"] ? never : X;
}[Xs];

/** `true` when an edit changed `Side` of `M` in one of `Xs`. */
// 先让 Xs 成为裸类型参数触发分布式条件；任一 [变体, 方法, 侧] 落在编辑集合 C 中，就得到 true。
type Changed<C, Xs, M, Side> = Xs extends unknown ? ([Xs, M, Side] extends C ? true : never) : never;

/** Mappings for the changed sides of a method (`A`, `R` are `true` when changed), or a replacement. */
// 参数变了提供 (old) => current；结果变了提供 (current) => old；两侧都没变则不需要映射（never）。
// 也可以用 { call } 直接替代整个方法。可选属性的 never 用来禁止给未改动的一侧多写映射。
type ChangedMethod<A, R, Old extends Method, Current extends Method> = [A | R] extends [never]
	? never
	:
			| ({ readonly call?: never } & ([A] extends [never]
					? { readonly args?: never }
					: { readonly args: (old: Static<Old["args"]>) => Static<Current["args"]> }) &
					([R] extends [never]
						? { readonly result?: never }
						: { readonly result: (current: Static<Current["result"]>) => Static<Old["result"]> }))
			| Replacement<Old>;

/** A removed (or changed) method served by the provider's own function, or refused. */
// 方法被删除时，提供者用自己的函数实现旧方法（参数/结果仍是旧签名），或明确 "refuse" 让旧消费者收到拒绝。
type Replacement<Old extends Method> =
	| {
			readonly call: (args: Static<Old["args"]>, context: Context) => Promise<Static<Old["result"]>>;
			readonly args?: never;
			readonly result?: never;
	  }
	| "refuse";

/** An accepted older version and its fingerprint. */
// 检查通过后交给链接绑定使用的版本信息；指纹用于确认双方说的确实是同一份历史。
export type AcceptedVersion = { readonly version: number; readonly fingerprint: string };

/**
 * Validates an accepts table without calling any mapping: known older versions only, exactly the required mappings
 * with the right shapes. Fails with an Error naming the path (`notes accepts[1].methods.add`).
 */
// 用途：验证 accepts 表。输入契约句柄和映射表，输出 { versions }（旧版本号与指纹）。无副作用：只检查结构，不调用映射。
// 错误路径：未知/当前版本、缺失、多余或形状错误的映射都会抛错。
// 流程：遍历表的键 -> 在历史中定位旧版本 -> needs() 算出该版本真正需要的映射 -> 逐段检查。
// 例子：accepts = { 1: { methods: { add: { args: (old) => ({ n: old.n }) } } } } 表示接受 v1 并提供参数映射；
//   若编辑还改了结果，却只写 args，则会报 missing mapping。
export function checkAccepts<C extends Contract>(
	contract: C,
	accepts: AcceptsTable<C>,
): { readonly versions: readonly AcceptedVersion[] } {
	const data = contractData(contract);
	// Declaration policy: JavaScript callers reach every check below.
	const versions = entriesOf(accepts, `${data.name} accepts`).map(([key, mappings]) => {
		const path = `${data.name} accepts[${key}]`;
		// 版本号在对象键里是字符串；用 String(version) 比较。index === -1 表示历史里没有；最后一项是当前版本，不能“接受”。
		const index = data.versions.findIndex(({ version }) => String(version) === key);
		if (index === -1 || index === data.versions.length - 1) throw new Error(`${path}: not an older version`);
		checkMappings(mappings, needs(data, index), data.kind, path);
		const { version, fingerprint } = data.versions[index]!;
		return { version, fingerprint };
	});
	return { versions };
}

/** What an accepted version needs, by edit and never by schema comparison. */
// 需求完全由“从该版本之后发生过哪些编辑”推导，而不是比较 schema 内容：
// 即使两个 schema 最终看起来相同，只要中间改过，旧消费者仍需要映射。
type Needs = {
	/** Per variant, per state member. */
	readonly state: ReadonlyMap<string, ReadonlyMap<string, StateNeed>>;
	readonly methods: ReadonlyMap<string, MethodNeed>;
	/** Per keyed member (local contracts). */
	readonly keyed: ReadonlyMap<string, StateNeed>;
};

type StateNeed = "changed" | "removed";

type MethodNeed =
	| { readonly kind: "removed" }
	| { readonly kind: "changed"; readonly args: boolean; readonly result: boolean };

// 用途：计算从 versions[index] 到当前版本所需的映射。输入契约数据和旧版本下标，输出 Needs；无副作用。
// changes 收集旧版本之后所有版本的编辑，用 JSON 字符串做集合键；changed 判断某个三元组是否发生过。
function needs(data: ContractData, index: number): Needs {
	const old = data.versions[index]!;
	const current = data.versions.at(-1)!;
	// flatMap 把每个版本自己的 changes 摊平；Set 让查找为 O(1)。
	const changes = new Set(data.versions.slice(index + 1).flatMap((version) => version.changes.map(changeKey)));
	const changed = (...change: Change) => changes.has(changeKey(change));
	const state = new Map<string, Map<string, StateNeed>>();
	const methods = new Map<string, { removed: boolean; args: boolean; result: boolean }>();
	const keyed = new Map<string, StateNeed>();
	for (const [variant, { state: oldState, methods: oldMethods, keyed: oldKeyed }] of old.variants) {
		// 变体集合永不变化，因此当前版本一定有同名变体；! 表示这个内部不变量。
		const now = current.variants.get(variant)!;
		for (const member of oldKeyed.keys()) {
			if (!now.keyed.has(member)) keyed.set(member, "removed");
			else if (changed(variant, member, "keyed")) keyed.set(member, "changed");
		}
		const variantNeeds = new Map<string, StateNeed>();
		for (const member of oldState.keys()) {
			if (!now.state.has(member)) variantNeeds.set(member, "removed");
			else if (changed(variant, member, "state")) variantNeeds.set(member, "changed");
		}
		// 空 Map 不放进结果，便于 Section 判断该段是否可省略。
		if (variantNeeds.size > 0) state.set(variant, variantNeeds);
		for (const member of oldMethods.keys()) {
			// 同名方法可能出现在多个变体；把各变体的需求合并到一条记录。
			const need = methods.get(member) ?? { removed: false, args: false, result: false };
			need.removed ||= !now.methods.has(member);
			need.args ||= changed(variant, member, "args");
			need.result ||= changed(variant, member, "result");
			methods.set(member, need);
		}
	}
	const methodNeeds = new Map<string, MethodNeed>();
	for (const [member, { removed, args, result }] of methods) {
		// 删除优先于改动：只要任一变体删了该方法，旧消费者就需要 call 或 refuse。
		if (removed) methodNeeds.set(member, { kind: "removed" });
		else if (args || result) methodNeeds.set(member, { kind: "changed", args, result });
	}
	return { state, methods: methodNeeds, keyed };
}

// 把编辑三元组序列化成稳定的字符串键；Change 是只含字符串的只读元组，JSON 顺序与内容都确定。
function changeKey(change: Change): string {
	return JSON.stringify(change);
}

// 用途：检查一个旧版本的映射表。输入未知值 mappings、需求、契约种类和错误路径；无返回值。
// 流程：只允许 state/methods/keyed 三个键 -> 按 local/remote 选择 state 的检查方式 -> 各段交给 checkSection。
function checkMappings(mappings: unknown, needs: Needs, kind: Kind, path: string): void {
	checkKeys(mappings, ["state", "methods", "keyed"], path);
	const { state, methods, keyed } = mappings as {
		readonly state?: unknown;
		readonly methods?: unknown;
		readonly keyed?: unknown;
	};
	// 先绑定一个只做 state 段检查的闭包，供 remote 的每个变体复用。
	const checkVariant = (variantMappings: unknown, variantNeeds: ReadonlyMap<string, StateNeed>, at: string) =>
		checkSection(variantMappings, variantNeeds, at, checkStateMapping);
	// A local table is flat: its state section is the one variant's.
	// local 的 state 段直接是成员映射，不再按变体分层；members 没有需求时用空 Map 让它可省略。
	if (kind === "local") checkVariant(state, needs.state.get(LOCAL) ?? new Map(), `${path}.state`);
	else checkSection(state, needs.state, `${path}.state`, checkVariant);
	checkSection(methods, needs.methods, `${path}.methods`, checkMethodMapping);
	checkSection(keyed, needs.keyed, `${path}.keyed`, checkKeyedMapping);
}

/** Exactly the needed keys: no missing and no unnecessary mapping; absent only when nothing is needed. */
// 用途：检查一个分段的键集合。输入未知 section、需求 Map、路径和单值检查函数；无返回值。
// 规则是“恰好相等”：多写不需要的映射会报 unnecessary（防止误以为它生效），少写会报 missing。
// section 为 undefined 时视为空对象，交给后面的缺失检查处理。
function checkSection<N>(
	section: unknown,
	needs: ReadonlyMap<string, N>,
	path: string,
	check: (mapping: unknown, need: N, path: string) => void,
): void {
	const mappings = new Map(section === undefined ? [] : entriesOf(section, path));
	for (const key of mappings.keys()) if (!needs.has(key)) throw new Error(`${path}.${key}: unnecessary mapping`);
	for (const [key, need] of needs) {
		if (!mappings.has(key)) throw new Error(`${path}.${key}: missing mapping`);
		check(mappings.get(key), need, `${path}.${key}`);
	}
}

// state 成员被改动时必须是函数；被删除时还允许字符串 "refuse"。
function checkStateMapping(mapping: unknown, need: StateNeed, path: string): void {
	if (typeof mapping === "function" || (need === "removed" && mapping === "refuse")) return;
	throw new Error(`${path}: expected ${need === "removed" ? 'a function or "refuse"' : "a function"}`);
}

// keyed 成员被改动时允许函数或 "refuse"；被删除时只允许 "refuse"。
function checkKeyedMapping(mapping: unknown, need: StateNeed, path: string): void {
	if (mapping === "refuse" || (need === "changed" && typeof mapping === "function")) return;
	throw new Error(`${path}: expected ${need === "changed" ? 'a function or "refuse"' : '"refuse"'}`);
}

// 方法映射要么是 "refuse"，要么是 { call }（替代实现），要么是只含改动侧 { args, result } 的对象。
// call !== undefined 或需求为 removed 时走替代实现分支：必须恰好有函数 call，且不能再写 args/result。
function checkMethodMapping(mapping: unknown, need: MethodNeed, path: string): void {
	if (mapping === "refuse") return;
	checkKeys(mapping, ["args", "result", "call"], path);
	const { args, result, call } = mapping as {
		readonly args?: unknown;
		readonly result?: unknown;
		readonly call?: unknown;
	};
	if (call !== undefined || need.kind === "removed") {
		if (typeof call !== "function" || args !== undefined || result !== undefined) {
			throw new Error(`${path}: expected { call } or "refuse"`);
		}
		return;
	}
	checkSide(args, need.args, `${path}.args`);
	checkSide(result, need.result, `${path}.result`);
}

// 用途：检查方法某一侧是否需要映射。输入未知值、需求布尔和路径；无返回值。
// 多写、漏写、类型不是函数都分别报错；不需要时 undefined 才算正确。
function checkSide(mapping: unknown, needed: boolean, path: string): void {
	if (!needed && mapping !== undefined) throw new Error(`${path}: unnecessary mapping`);
	if (needed && mapping === undefined) throw new Error(`${path}: missing mapping`);
	if (needed && typeof mapping !== "function") throw new Error(`${path}: expected a function`);
}
