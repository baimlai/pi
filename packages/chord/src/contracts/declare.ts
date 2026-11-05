// Declarations: `remote(...)` and `local(...)`, the checks every declared version passes, and the reading of
// untyped declaration input.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约声明层。
// 解决的问题：把应用写的 remote()/local() 声明转成经过检查的 schema 快照和基础版本数据；
//   类型层负责形状约束，运行时还要挡住没有类型的 JavaScript 调用方。
// 职责边界：不计算指纹（materialize 在 fingerprint.ts）、不保存句柄（createContract 在 contract.ts）、
//   不实现对象行为；本文件只做声明读取、成员一致性检查和错误信息定位。
// 上游：应用源码调用 remote/local；evolve 复用这里的 checkMembers、memberPath、readMethod。
// 下游：contract.ts 的 createContract；链接层拿到快照与基础版本。结果流向 ContractData；错误以带路径的 Error 抛给调用方。
// 能力清单：
// - remote()、local()：两个声明入口，分别生成多变体和单 members 变体的基础契约。
// - VariantDeclaration(s)、RemoteVariants、LocalVariants、LocalMember、SchemaOf、SameMembers：声明的类型层形状与约束。
// - readVariant()、readMethod()：把声明项读取并转成 Chord 拥有的快照。
// - declare()：两个入口的公共收尾，检查版本号、成员一致性、params，并生成基础 VersionData。
// - checkMembers()、recordKind()、RESERVED_MEMBERS：跨变体/跨历史的成员种类与方法签名约束。
// - memberPath()、checkKeys()、entriesOf()：错误路径构造和未类型化输入的运行时检查。
// 组合关系：remote/local -> checkName/checkKeys -> readVariant 或 local 成员分类 -> readParams ->
//   materialize（基础版本）-> createContract；evolve 复用 checkMembers/readMethod/memberPath。
// 示例：
//   const session = hostKind("session", { id: str() });
//   const notes = remote("notes", {
//     version: 1,
//     params: { owner: str() },
//     hostAddress: ({ owner }) => session({ id: owner }),
//     variants: { editor: { state: { text: str() }, methods: { save: method(str(), nul()) } } },
//   });
// 建议阅读顺序：先看 remote/local 的声明形状，再看 readVariant/readMethod/declare 的运行时流程，
//   然后看 checkMembers 与 RESERVED_MEMBERS 的约束，最后看 checkKeys/entriesOf 这些信任边界辅助函数。

import {
	type Contract,
	createContract,
	type HostAddress,
	type Kind,
	LOCAL,
	type MemberKind,
	type MethodData,
	type VariantData,
} from "./contract.ts";
import { materialize } from "./fingerprint.ts";
import type { MemberNames, MethodAt, VariantShape } from "./history.ts";
import type { Address } from "./host-kind.ts";
import { checkName } from "./names.ts";
import { type Params, type RequiredFields, readParams } from "./params.ts";
import { KeyedMember, Method, type Schema, type Static } from "./schema.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "./snapshot.ts";

type VariantDeclaration = {
	// state 是“成员名 -> schema”的普通对象；省略表示该变体没有状态成员。
	readonly state?: { readonly [member: string]: Schema };
	// methods 是“成员名 -> method(...) 声明”的普通对象；省略表示没有方法。
	readonly methods?: { readonly [member: string]: Method };
};

// 变体名到声明的映射；remote 契约可以有多个变体。
type VariantDeclarations = { readonly [variant: string]: VariantDeclaration };

// 把声明里的可选字段规范成必有字段：省略 state/methods 时补 Record<never, never>（空对象类型）。
// 这样后续 CurrentVariants 索引时不会遇到 undefined。
type RemoteVariants<D extends VariantDeclarations> = {
	[V in keyof D]: {
		state: D[V]["state"] extends object ? D[V]["state"] : Record<never, never>;
		methods: D[V]["methods"] extends object ? D[V]["methods"] : Record<never, never>;
	};
};

// local 契约只有一个 members 变体。这里用键重映射（as）把同一个成员表拆成三组：
// 非 Method/KeyedMember 的是 state，Method 的是 methods，KeyedMember 的是 keyed。
// Exclude/Extract 在类型层做集合差集和交集；运行时由 local() 里的 instanceof 完成同样的分类。
type LocalVariants<M extends { readonly [member: string]: LocalMember }> = {
	[LOCAL]: {
		state: { [K in keyof M as M[K] extends Method | KeyedMember ? never : K]: Exclude<M[K], Method | KeyedMember> };
		methods: { [K in keyof M as M[K] extends Method ? K : never]: Extract<M[K], Method> };
		keyed: { [K in keyof M as M[K] extends KeyedMember ? K : never]: SchemaOf<M[K]> };
	};
};

/** A local contract's member: a state schema, `method(...)` or `keyed(schema)`. */
// local 成员是一个联合：裸 schema 表示状态，Method 表示方法，KeyedMember 表示按 key 的文档集合。
type LocalMember = Schema | Method | KeyedMember;

// 从 KeyedMember 的泛型参数里取出内部 schema 类型；不是 KeyedMember 时得到 never。
type SchemaOf<M> = M extends KeyedMember<infer S> ? S : never;

/** D11: a member name has one kind in every variant, a method one signature; no keyed members. */
// 编译期约束：同名成员在所有变体里必须同种类；方法在所有变体里签名一致；remote 不允许 keyed。
// 条件里用 [T] extends [U] 的元组包一层，避免分布式条件类型把联合拆开以及 never 意外通过检查。
type SameMembers<D extends VariantDeclarations, V extends { [variant: string]: VariantShape } = RemoteVariants<D>> = {
	[X in keyof D]: {
		state?: {
			// Keyed members are only in local contracts (slice 6a §12).
			[M in keyof D[X]["state"]]: M extends MemberNames<V, "methods">
				? never
				: D[X]["state"][M] extends KeyedMember
					? never
					: D[X]["state"][M];
		};
		methods?: {
			[M in keyof D[X]["methods"]]: M extends MemberNames<V, "state">
				? never
				: [MethodAt<V, M>] extends [D[X]["methods"][M]]
					? D[X]["methods"][M]
					: never;
		};
	};
};

/** Declares a remote contract: per-principal variants of state and methods. */
// 用途：声明 remote 契约。输入名称、declaration（version、params、hostAddress、variants），输出 Contract 句柄。
// 副作用：无外部副作用，只在内部登记 WeakMap；错误路径：名称非法、未知键、没有变体、hostAddress 不是函数、
// 成员种类冲突或参数不合法时抛 Error。流程：检查声明 -> 每个变体转快照 -> declare() 生成基础版本。
// 例子：remote("notes", { version: 1, params: { owner: str() }, hostAddress: ({ owner }) => sessions(owner),
//   variants: { editor: { state: { text: str() }, methods: { save: method(str()) } } } })。
// 泛型 N/P/V/D 都用 const 修饰，让调用处传入的字符串、数字和对象字面量保留最窄的字面量类型。
export function remote<
	const N extends string,
	const P extends Params,
	const V extends number,
	const D extends VariantDeclarations,
>(
	name: N,
	declaration: {
		readonly version: V;
		// NoInfer 让 P 只从实参推断，而不是被 RequiredFields<P> 反向影响；随后再检查 P 的字段必须全部必填。
		readonly params: P & NoInfer<RequiredFields<P>>;
		/** The address of the host serving an object for these params; never part of the fingerprint. */
		// hostAddress 只决定请求发往哪个进程，不进入指纹；这样同一契约可以在不同地址的 host 上运行。
		readonly hostAddress: (params: { [F in keyof P]: Static<P[F]> }) => Address;
		// D 先由实参推断，再用 NoInfer<SameMembers<D>> 做成员一致性检查，避免检查反过来放宽 D。
		readonly variants: D & NoInfer<SameMembers<D>>;
	},
): Contract<{
	kind: "remote";
	name: N;
	params: P;
	history: [{ version: `${V}`; variants: RemoteVariants<D>; changes: never }];
}> {
	// Declaration policy: JavaScript callers reach every check below.
	// 类型只在编译期把关；JS 调用方没有类型，所以下面每条声明规则都要在运行时再检查一次。
	checkName(name, "A contract name");
	checkKeys(declaration, ["version", "params", "hostAddress", "variants"], name);
	// entriesOf 拒绝非对象和数组，返回 [变体名, 声明] 的数组；空变体集合没有意义，直接拒绝。
	const variants = entriesOf(declaration.variants, `${name}.variants`);
	if (variants.length === 0) throw new Error(`${name}.variants: at least one variant is required`);
	const { hostAddress } = declaration;
	if (typeof hostAddress !== "function") throw new Error(`${name}.hostAddress: expected a function of the params`);
	// 每个变体在内层 readVariant 中检查并转成 Chord 拥有的快照；as const 保留二元组的精确类型。
	const read = variants.map(([variant, members]) => [variant, readVariant(members, `${name}.${variant}`)] as const);
	// The host address gets the checked params of this contract.
	// 交给 declare 的 hostAddress 断言成统一签名；真正调用前 params 已按 ParamsData.schema 检查。
	return declare("remote", name, declaration, new Map(read), hostAddress as HostAddress);
}

/**
 * Declares a local contract: one flat map of members, where a schema is state, `method(...)` a method and
 * `keyed(schema)` a keyed state member.
 */
// 用途：声明 local 契约。输入名称、version、params 和成员表，输出 Contract 句柄。
// 流程：逐个成员按运行时类型分流——Method 进 methods，KeyedMember 进 keyed，其余当作 state schema；
// 三类都先转成快照，再交给 declare 生成 members 变体。错误路径：名称/键/params 非法时抛 Error。
// 例子：local("counter", { version: 1, params: {}, members: { count: int(), add: method(int(), int()) } })。
export function local<
	const N extends string,
	const P extends Params,
	const V extends number,
	const M extends { readonly [member: string]: LocalMember },
>(
	name: N,
	declaration: { readonly version: V; readonly params: P & NoInfer<RequiredFields<P>>; readonly members: M },
): Contract<{
	kind: "local";
	name: N;
	params: P;
	history: [{ version: `${V}`; variants: LocalVariants<M>; changes: never }];
}> {
	// Declaration policy: JavaScript callers reach every check below.
	// 与 remote 一样，类型检查挡不住 JS 调用方，所以名称、键集合和每个成员都要在运行时验证。
	checkName(name, "A contract name");
	checkKeys(declaration, ["version", "params", "members"], name);
	const state = new Map<string, Snapshot>();
	const methods = new Map<string, MethodData>();
	const keyed = new Map<string, Snapshot>();
	// instanceof 查的是构造器的运行时原型链，这是把三类声明分开的唯一依据；顺序不能反，
	// 因为 Method/KeyedMember 也是对象，若不先判断就会被误当成 state schema。
	for (const [member, value] of entriesOf(declaration.members, `${name}.${LOCAL}`)) {
		const path = `${name}.${LOCAL}.${member}`;
		if (value instanceof Method) methods.set(member, readMethod(value, path));
		else if (value instanceof KeyedMember) keyed.set(member, snapshotSchema(value.schema, path));
		else state.set(member, snapshotSchema(value, path));
	}
	return declare("local", name, declaration, new Map([[LOCAL, { state, methods, keyed }]]));
}

// 用途：读取一个 remote 变体的声明。输入未知值 source 和错误路径前缀，输出 VariantData。
// source 来自 JS 调用方，因此先当作 unknown 检查：只允许 state/methods 两个键，且各自必须是对象。
// 错误路径：在 state 里放 method/keyed、在 methods 里放非 method 都会抛错；keyed 只能出现在 local 契约。
function readVariant(source: unknown, path: string): VariantData {
	checkKeys(source, ["state", "methods"], path);
	// 解构默认值把省略的 state/methods 变成空对象；断言成 VariantDeclaration 便于逐项读取。
	const { state = {}, methods = {} } = source as VariantDeclaration;
	// map 返回 [成员名, 快照] 二元组；as const 保留元组类型给 new Map 使用。
	const stateEntries = entriesOf(state, `${path}.state`).map(([member, schema]) => {
		if (schema instanceof Method) throw new Error(`${path}.state.${member}: a method belongs in methods`);
		if (schema instanceof KeyedMember) {
			throw new Error(`${path}.state.${member}: keyed members are only in local contracts`);
		}
		return [member, snapshotSchema(schema, `${path}.state.${member}`)] as const;
	});
	const methodEntries = entriesOf(methods, `${path}.methods`).map(([member, method]) => {
		if (!(method instanceof Method)) throw new Error(`${path}.methods.${member}: expected method(...)`);
		return [member, readMethod(method, `${path}.methods.${member}`)] as const;
	});
	// remote 变体没有 keyed 成员；仍放一个空 Map，保证 VariantData 形状统一。
	return { state: new Map(stateEntries), methods: new Map(methodEntries), keyed: new Map() };
}

/** One method declaration as Chord-owned snapshots; its arguments must be closed. */
// 用途：把 method(args, result) 转成两份快照。输入 Method 和错误路径，输出 MethodData。
// 参数侧调用 snapshotArguments，要求参数对象闭合；结果侧只要求 vocabulary 内。
export function readMethod(method: Method, path: string): MethodData {
	return {
		args: snapshotArguments(method.args, `${path}.args`),
		result: snapshotSchema(method.result, `${path}.result`),
	};
}

// 用途：两个声明函数的公共收尾。输入种类、名称、含 version/params 的声明、已读好的变体表（remote 还带 hostAddress）。
// 输出 Contract 句柄；副作用：登记 WeakMap。流程：检查版本号 -> 检查成员一致性 -> 读 params -> 生成基础版本 -> 创建句柄。
function declare<C extends Contract>(
	kind: Kind,
	name: string,
	declaration: { readonly version: number; readonly params: unknown },
	variants: ReadonlyMap<string, VariantData>,
	hostAddress?: HostAddress,
): C {
	const { version } = declaration;
	// Number.isSafeInteger 同时排除小数、NaN、Infinity 和超出安全范围的整数；版本从 1 开始。
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	// kinds 会随历史累积；这里传入引用，checkMembers 在检查过程中直接写入。
	const kinds = new Map<string, MemberKind>();
	checkMembers(variants, kinds, (variant, member, memberKind) => memberPath(name, kind, variant, member, memberKind));
	const params = readParams(entriesOf(declaration.params, `${name}.params`), `${name}.params`);
	// 基础版本没有编辑历史，changes 传空数组；materialize 计算并保存指纹。
	const versions = [materialize(kind, params, version, variants, [])];
	return createContract({ kind, name, params, hostAddress, versions, kinds });
}

/**
 * Checks the members of every variant: a name keeps one kind across variants and the whole history (`kinds`, updated
 * here), a method one signature across variants.
 */
// 用途：检查所有变体的成员一致性。输入变体表、可写的 kinds 映射和路径构造函数；没有返回值。
// 副作用：把每个成员名及种类写入 kinds（声明与 evolve 共用，因此历史上删掉的成员也不会被换种类）。
// 错误路径：同名跨种类、保留名、方法跨变体签名不同都会抛 Error。
// 例子：variant A 有 state.text、variant B 把它声明成 method，第二处会抛 “its kind never changes”。
export function checkMembers(
	variants: ReadonlyMap<string, VariantData>,
	kinds: Map<string, MemberKind>,
	path: (variant: string, member: string, kind: MemberKind) => string,
): void {
	// 方法签名只按名字记录；同一名字出现在多个变体时，比较参数和结果的规范形式。
	const signatures = new Map<string, string>();
	for (const [variant, { state, methods, keyed }] of variants) {
		for (const member of state.keys()) recordKind(kinds, member, "state", path(variant, member, "state"));
		for (const member of keyed.keys()) recordKind(kinds, member, "keyed", path(variant, member, "keyed"));
		for (const [member, { args, result }] of methods) {
			recordKind(kinds, member, "method", path(variant, member, "method"));
			// 快照已把对象键排序并去掉注解，所以字符串相等就代表签名相同。
			const signature = JSON.stringify([args.normal, result.normal]);
			// 第一次见到该方法时签名表为空，用当前签名兜底，比较自然通过。
			if ((signatures.get(member) ?? signature) !== signature) {
				throw new Error(`${path(variant, member, "method")}: a method has the same signature in every variant`);
			}
			signatures.set(member, signature);
		}
	}
}

// 用途：登记一个成员的种类。输入 kinds 映射、成员名、种类和错误路径；无返回值；副作用是写 kinds。
// 错误路径：保留名直接拒绝；已登记过且种类不同则拒绝。kind 的已知值让错误信息可用于定位。
function recordKind(kinds: Map<string, MemberKind>, member: string, kind: MemberKind, path: string): void {
	if (RESERVED_MEMBERS.has(member)) throw new Error(`${path}: "${member}" is reserved: a reference has it`);
	const known = kinds.get(member);
	if (known !== undefined && known !== kind) {
		throw new Error(`${path}: "${member}" is a ${known} member; its kind never changes`);
	}
	kinds.set(member, kind);
}

/**
 * Names a reference has itself (`release`, `variant`, and `state` and `retry` with failures), and `then`, which would
 * make an awaited reference thenable.
 */
// 引用对象自身已经暴露这些名字；若契约成员也叫它们，访问时会产生歧义。then 还会让 await 把引用当成 Promise。
const RESERVED_MEMBERS: ReadonlySet<string> = new Set(["then", "release", "variant", "state", "retry"]);

/** The path of a member in errors: `notes.editor.methods.add`, `info.members.clear`. */
// 用途：生成错误信息里的成员路径。local 契约是 `<契约>.members.<成员>`；
// remote 契约包含变体名，并按种类选择 state 或 methods 段。没有副作用。
export function memberPath(base: string, kind: Kind, variant: string, member: string, memberKind: MemberKind): string {
	if (kind === "local") return `${base}.${LOCAL}.${member}`;
	return `${base}.${variant}.${memberKind === "state" ? "state" : "methods"}.${member}`;
}

/** Refuses a non-object and unknown keys. */
// 用途：检查声明对象的键集合。输入未知值、允许的键和错误路径；无返回值。
// source 来自 JS 调用方，entriesOf 先保证它是普通对象，再逐个对比白名单；拼错的键会立即报错而不是被忽略。
export function checkKeys(source: unknown, allowed: readonly string[], path: string): void {
	for (const [key] of entriesOf(source, path)) {
		if (!allowed.includes(key)) throw new Error(`${path}: unknown key "${key}"`);
	}
}

/** The entries of an object; anything else is refused. */
// 用途：把未知输入读成键值对。输入和错误路径，输出 [key, value][]。
// typeof null 也是 "object"，所以单独排除 null；数组也会被排除。Object.entries 只返回自有可枚举字符串键。
export function entriesOf(source: unknown, path: string): [string, unknown][] {
	if (typeof source !== "object" || source === null || Array.isArray(source)) {
		throw new Error(`${path}: expected an object`);
	}
	return Object.entries(source);
}
