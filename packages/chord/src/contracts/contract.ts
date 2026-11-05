// Contract handles: the branded, immutable value an app declares, its type-level shape, and the Chord-owned data
// behind it.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约（contract）模块的类型与句柄数据核心。
// 解决的问题：声明后的契约如何以一个不可伪造的句柄交给应用，同时把类型形状（kind、name、params、history）
//   与运行时事实（schema 快照、版本历史、成员种类、hostAddress）分开保存。
// 职责边界：本文件不解析声明输入（declare.ts）、不计算指纹（fingerprint.ts）、不实现对象行为（host 层）；
//   它只定义类型、持有 WeakMap、提供只读访问器。
// 上游与下游：declare()/evolve() 通过 createContract() 写入；链接层、host 路由和实现工厂通过 contractData()、
//   currentVariants()、variantsAt()、variantNames() 读取。结果流向绑定和线上索引；错误流向调用方。
// 能力清单：
// - Kind、LOCAL、MemberKind：契约种类、local 唯一变体名、成员种类三个基础字面量类型/常量。
// - Contract、ContractShape、ShapeOf、CurrentVariants、ParamsOf：句柄及从类型层取形状、当前变体、参数值类型。
// - Implementation、ImplementationOf、VariantImplementation、KeyedWatchable、MethodFunction：工厂返回值的类型形状。
// - ContractData、VersionData、VariantData、MethodData、HostAddress：WeakMap 中的运行数据和地址函数。
// - contractData()：取回数据，并拒绝展开/手工复制的句柄；createContract()：登记并返回新句柄。
// - takesNoArgs()、currentVariants()、variantsAt()、variantOrder()、variantNames()：给链接层用的查询与排序。
// 组合关系：declare()/evolve() -> createContract()；host/links -> contractData() -> 版本与变体查询；
//   类型层的 ShapeOf/CurrentVariants 又反过来支撑 Implementation 与 AcceptsTable 的推导。
// 示例：
//   const notes = local("notes", { version: 1, params: {}, members: { text: str() } });
//   console.log(notes.version, notes.fingerprint);          // 1 和当前版本指纹
//   console.log(currentVariants(notes).has("members"));     // true
// 建议阅读顺序：先看 ContractShape/Contract，再看 ContractData 及 VersionData/VariantData，随后看类型推导
//   （ShapeOf、Implementation 系列），最后看 WeakMap 访问器和 createContract()。

import type { Context } from "../context/index.ts";
import type { Watchable, WatchHandle } from "../watch.ts";
import type { Change, CurrentStep, History, VariantShape } from "./history.ts";
import type { Address } from "./host-kind.ts";
import type { Params, ParamsData } from "./params.ts";
import type { Method, NullSchema, Static } from "./schema.ts";
import type { Snapshot } from "./snapshot.ts";

// remote 契约按 principal 分成多个 variant；local 契约只有一个名为 members 的 variant。
// 这是编译期联合类型；运行时字段就是普通字符串，declare() 会原样保存。
export type Kind = "remote" | "local";

/** The variant name of a local contract's members. */
// local 契约唯一 variant 的名字：类型层用它做索引，运行时用它做 Map 的键。
export const LOCAL = "members";

/** Everything the types know about a contract: kind, name, params and the whole history. */
// 只存在于类型层：把 kind、name 的字符串字面量，以及 params 和 history 的类型一起装进契约类型。
// history 是逐版本累积的元组，后面的 CurrentStep、ChangesAfter 等类型靠它推导。
export type ContractShape = {
	readonly kind: Kind;
	readonly name: string;
	readonly params: Params;
	readonly history: History;
};

/** A declared contract: a branded handle, immutable by convention. Spread or hand-built copies are refused. */
// 应用拿到的契约句柄。泛型 S 缺省为 ContractShape，具体声明会把它收窄成字面量类型。
// readonly 只在编译期阻止赋值；运行时由 WeakMap 登记来识别真句柄。
export interface Contract<S extends ContractShape = ContractShape> {
	// 该契约是 remote 还是 local，类型是 S["kind"] 这个字面量。
	readonly kind: S["kind"];
	// 契约名，类型是 S["name"] 这个字面量。
	readonly name: S["name"];
	// 当前（最新）版本号；句柄创建后不会变化。
	readonly version: number;
	// 当前版本的指纹，链接绑定和协议协商时使用。
	readonly fingerprint: string;
	/** Type only: absent at runtime. */
	// 类型层携带完整形状；运行时没有这个属性，编译后会被擦除。
	readonly "~shape"?: S;
}

// 从可选属性中取出形状；NonNullable 去掉 undefined，使后续索引访问不必再判空。
export type ShapeOf<C extends Contract> = NonNullable<C["~shape"]>;

/** The variants of a contract's current version. */
// 先取 history 元组的最后一个版本，再取它的 variants 映射。
export type CurrentVariants<C extends Contract> = CurrentStep<ShapeOf<C>["history"]>["variants"];

/** The params object of a contract. */
// 映射类型遍历 params 的字段，用 Static 把每个 Schema 转成它接受的值类型。
// 例如 str() 变成 string，int() 变成 number，得到工厂和 hostAddress 使用的普通对象。
export type ParamsOf<C extends Contract> = { [F in keyof ShapeOf<C>["params"]]: Static<ShapeOf<C>["params"][F]> };

/**
 * What a factory returns: for `local`, a `Watchable` per state member and a function per method, `(args, context)`,
 * or `(context)` when the method takes no arguments; for `remote`, one variant `{ variant, members }` with exactly
 * that variant's members. `X` is the context the methods get.
 */
// 工厂（Implementation）的形状：local 契约直接返回成员对象；remote 契约返回带 variant 判别字段的成员对象联合，
// 调用方按 principal 选择其中一支。X 允许应用指定方法回调收到的 Context 子类型，默认就是 Context。
export type Implementation<C extends Contract, X extends Context = Context> = ImplementationOf<
	ShapeOf<C>["kind"],
	CurrentVariants<C>,
	X
>;

// 先按契约种类分派：local 取 V[typeof LOCAL]（即 members）这一份成员；
// remote 对每个 variant 名 N 映射出 { variant: N, members: ... }，最后用 [keyof V] 索引成联合。
type ImplementationOf<
	K extends Kind,
	V extends { readonly [variant: string]: VariantShape },
	X extends Context,
> = K extends "local"
	? VariantImplementation<V[typeof LOCAL], X>
	: { [N in keyof V]: { readonly variant: N; readonly members: VariantImplementation<V[N], X> } }[keyof V];

/**
 * One variant's members: a `Watchable` per state member, a function per method and, in a local contract, a
 * `KeyedWatchable` per keyed member.
 */
// 成员名取 state、methods、keyed 三处键的联合，再逐个判断归属：
// 方法 -> 函数，state -> Watchable，keyed -> KeyedWatchable。条件类型按顺序收窄，因此名字冲突时以靠前者为准，
// 而 declare() 在运行时已经拒绝同名跨种类，类型层的顺序只是兜底。
export type VariantImplementation<V extends VariantShape, X extends Context = Context> = {
	[M in keyof V["state"] | keyof V["methods"] | keyof NonNullable<V["keyed"]>]: M extends keyof V["methods"]
		? MethodFunction<V["methods"][M], X>
		: M extends keyof V["state"]
			? Watchable<Static<V["state"][M]>>
			: M extends keyof NonNullable<V["keyed"]>
				? KeyedWatchable<Static<NonNullable<V["keyed"]>[M]>>
				: never;
};

/**
 * A keyed state member (slice 6a §12): documents by key, each watchable on its own; a keyed document handle
 * provides it. `at(key)` is valid only in a factory (it pins the key while that attempt lives).
 */
// keyed 成员按字符串键保存一批文档：get/watch 每次显式传入 key；at 只在工厂里使用，
// 把 key 固定到当前这次实例化尝试，尝试结束后不能再调用。
export interface KeyedWatchable<T> {
	/** The document at `key`, `undefined` when absent. */
	get(key: string, context: Context): Promise<T | undefined>;
	/** A watch of the document at `key` that follows its address, `undefined` when absent. */
	watch(key: string, context: Context): Promise<WatchHandle<T> | undefined>;
	/** In a factory only: the document at `key` as a watchable, `initial()` while absent. */
	at(key: string): Watchable<T>;
}

/** A method as a function: without the argument when its argument schema is `null` (`null` stays the wire form). */
// 参数 schema 为 null 的方法在类型上省略 args，调用形式是 (context) => Promise<result>；
// 运行时 null 仍以 { type: "null" } 的快照参与指纹和线上编码。条件类型在编译期选择签名。
type MethodFunction<M extends Method, X extends Context = Context> = M["args"] extends NullSchema
	? (context: X) => Promise<Static<M["result"]>>
	: (args: Static<M["args"]>, context: X) => Promise<Static<M["result"]>>;

/** The Chord-owned data behind a contract handle. */
// 句柄背后的真实数据：版本历史、成员种类、params 快照和可选的 hostAddress。
// 它由 WeakMap 以句柄对象为键保存，不随句柄复制；WeakMap 不阻止句柄被垃圾回收。
export type ContractData = {
	readonly kind: Kind;
	readonly name: string;
	readonly params: ParamsData;
	/** A remote contract's host address: the address of the host serving an object for its params; none for local. */
	// remote 契约的 hostAddress 从参数算出宿主地址；local 契约没有宿主，这里是 undefined。
	readonly hostAddress: HostAddress | undefined;
	/** Every version of the history, oldest first; the last is current. */
	// 从最旧到最新排列；最后一项就是当前版本，至少有一项。
	readonly versions: readonly VersionData[];
	/** The kind of every member name ever declared in the history. */
	// 历史上出现过的所有成员名及其种类；即使后来删除也保留，防止同名成员换种类。
	readonly kinds: ReadonlyMap<string, MemberKind>;
};

// 成员种类：普通状态、方法、keyed 状态。运行时是普通字符串，类型层用于收窄。
export type MemberKind = "state" | "method" | "keyed";

/** A `hostAddress` as Chord calls it: with checked params. Plugin code: what it returns is checked where routed. */
// hostAddress 接收已经按 params 规则检查过的值；来自插件时，它返回的地址还会在路由处再验证。
export type HostAddress = (params: ParamsOf<Contract>) => Address;

// 一个版本：版本号、指纹、当时的变体快照，以及产生它的编辑列表（base 版本为空）。
export type VersionData = {
	readonly version: number;
	readonly fingerprint: string;
	readonly variants: ReadonlyMap<string, VariantData>;
	/** The changes that produced this version; empty for a base. */
	readonly changes: readonly Change[];
};

// 一个变体的运行时快照：state 和 keyed 保存 schema 快照，methods 保存参数与结果两份快照。
export type VariantData = {
	readonly state: ReadonlyMap<string, Snapshot>;
	readonly methods: ReadonlyMap<string, MethodData>;
	/** Keyed state members (slice 6a §12): only a local contract has any. */
	readonly keyed: ReadonlyMap<string, Snapshot>;
};

// 方法的两侧快照；参数侧在建契约时要求对象闭合。
export type MethodData = { readonly args: Snapshot; readonly result: Snapshot };

/** The data behind a contract handle; refuses spread and hand-built copies. */
// 用途：按句柄对象取回 WeakMap 中登记的数据。输入是契约句柄；输出是 ContractData；不修改任何状态。
// 错误路径：展开或手工构造的副本没有登记，抛 Error。例子：contractData(notes) 返回数据；
// contractData({ ...notes } as Contract) 抛 “not a declared contract”，这正是品牌保护的目的。
export function contractData(contract: Contract): ContractData {
	const data = contracts.get(contract);
	if (data === undefined) {
		throw new Error(`${contract.name}: not a declared contract (spread and hand-built copies are refused)`);
	}
	return data;
}

// 模块级 WeakMap：键是句柄对象，值是 Chord 自己的数据。WeakMap 不阻止句柄被回收，也不会被枚举。
const contracts = new WeakMap<Contract, ContractData>();

/** Whether a method takes no arguments: its argument schema is `null`, so its functions omit the argument. */
// 用途：判断方法是否无参数。输入是方法数据；输出布尔值，无副作用。
// 快照的 normal 是 JSON 对象；只有 { type: "null" } 一个键时才省略调用参数，别的含 null 的联合不算。
// 例子：method() 的结果是 true；method(nul(), str()) 的结果是 false。
export function takesNoArgs(method: MethodData): boolean {
	// A schema's normal form is an object of keywords.
	const normal = method.args.normal as { readonly [keyword: string]: unknown };
	return normal.type === "null" && Object.keys(normal).length === 1;
}

/** The variants of a contract's current version; a local contract has the one variant `LOCAL`. */
// 用途：取当前版本的变体表。输入句柄，输出只读 Map；不修改数据。
// at(-1) 取数组末项，! 是非空断言：declare/evolve 保证 versions 至少有一项。
export function currentVariants(contract: Contract): ReadonlyMap<string, VariantData> {
	return contractData(contract).versions.at(-1)!.variants;
}

/** The variants of version `version` of a contract's history (an older consumer's binding, Q10). */
// 用途：按版本号取历史中的变体表。输入句柄和版本号，输出只读 Map。
// 调用方只会传提供者已绑定（binds）的版本；若传入历史中不存在的版本，这里的 ! 会暴露内部约定被破坏。
export function variantsAt(contract: Contract, version: number): ReadonlyMap<string, VariantData> {
	// Callers name a version the provider binds (`binds`): its history has it.
	return contractData(contract).versions.find((data) => data.version === version)!.variants;
}

/** A variant's names as links index them (2b): its state members and its methods, each sorted. */
// 线上索引只传名字和下标，所以这里用排序后的名字数组表示一个变体的成员顺序。
export type VariantNames = { readonly state: readonly string[]; readonly methods: readonly string[] };

/** The current version's variant names in the order links index them: sorted. */
// 用途：当前变体名按字典序排序。输入句柄，输出新数组；排序只影响线上索引，不改变 Map 本身。
// 例子：变体为 { z, a } 时返回 ["a", "z"]。
export function variantOrder(contract: Contract): readonly string[] {
	return [...currentVariants(contract).keys()].sort();
}

/** A variant's state members and methods in the order links index them: each sorted. */
// 用途：返回一个变体的 state 和 method 名字，各自排序；输入运行时 VariantData，输出新数组，无副作用。
export function variantNames(variant: VariantData): VariantNames {
	return { state: [...variant.state.keys()].sort(), methods: [...variant.methods.keys()].sort() };
}

/** A new contract handle for `data`; the caller states the type-level shape. */
// 用途：创建公开句柄并登记数据。输入 ContractData 和调用方声明的类型形状 C，输出 Contract 句柄。
// 副作用：往 WeakMap 写入一条记录。句柄只复制当前版本的标量，历史等数据仍由 WeakMap 持有。
// 例子：declare() 最后调用 createContract<具体形状>(data) 返回应用看到的契约。
export function createContract<C extends Contract>(data: ContractData): C {
	const current = data.versions.at(-1)!;
	// 句柄只保留四个标量；历史、成员种类、hostAddress 都不复制到句柄上。
	const contract: Contract = {
		kind: data.kind,
		name: data.name,
		version: current.version,
		fingerprint: current.fingerprint,
	};
	contracts.set(contract, data);
	// The shape is type-level only; every caller states the shape it built.
	return contract as C;
}
