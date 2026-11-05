// Host kinds and addresses (§3): a kind of addressable host with params like a contract's, and the address of one
// host of a kind, which a remote contract's `hostAddress` computes from its params.

// 文件导读
// 所属模块：packages/chord/src/contracts，host 种类与地址。
// 解决的问题：remote 契约需要知道对象由哪个 host 进程服务；host 种类把“种类名 + 参数规则”封装成可调用的
//   地址工厂，地址 key 用于路由和状态键。
// 职责边界：声明种类、生成地址 key；不在创建地址时校验参数值（真正的校验在路由边界），不建立连接。
// 上游：应用调用 hostKind 声明种类，remote 的 hostAddress 调用它生成地址；下游：host.route 用 kind/kindParams
//   校验并分发。结果流向 Address 与路由；错误在声明期抛给调用方，参数值错误在路由时抛出。
// 能力清单：
// - KindShape、Address、HostKind、ParamsOfKind：地址/种类的类型层形状和参数值类型。
// - hostKind()：声明入口，检查名称与 params，返回可调用的地址工厂并登记 ParamsData。
// - kindParams()：取回种类的 params 快照，拒绝非 hostKind 创建的对象。
// - addressKey()：按声明字段顺序拼接地址 key，交给 joinKey 转义。
// 组合关系：hostKind -> 应用 hostAddress -> Address -> host.route；路由读取 kindParams 校验 params.key 用于去重。
// 示例：
//   const session = hostKind("session", { id: str() });
//   const address = session({ id: "S1" }); // { kind: "session", params: { id: "S1" }, key: "session|S1" }
// 建议阅读顺序：先看 KindShape/Address/HostKind，再看 hostKind 的声明与地址工厂，最后看 kindParams/addressKey。

import { checkName } from "./names.ts";
import { joinKey, type Params, type ParamsData, type RequiredFields, readParams } from "./params.ts";
import type { Static } from "./schema.ts";

/** What an address's type needs of its kind: the name and the params, type only. */
// KindShape 只用于类型层：kind 是种类名字面量，"~params" 同样只是类型标记，运行时没有这个属性。
export type KindShape = { readonly kind: string; readonly "~params"?: Params };

/** One host of a kind: the kind's name, its params and its key (`session|S1`); two addresses are equal by key. */
// 地址是普通数据：kind 名字、参数值对象和拼好的 key。比较两个地址是否相同只看 key。
export type Address<K extends KindShape = KindShape> = {
	readonly kind: K["kind"];
	readonly params: ParamsOfKind<K>;
	readonly key: string;
};

/** A kind of addressable host: called with its params, it makes an address. */
// HostKind 是可调用接口：既像函数一样使用，又带 kind 属性。
// 参数列表用条件类型：没有字段时允许不传或传空对象；有字段时必须传完整对象。
// `...params: ...` 是剩余参数写法，元组类型决定调用形式。
export interface HostKind<N extends string = string, P extends Params = Params> {
	(
		...params: keyof P extends never ? [params?: Record<never, never>] : [params: { [F in keyof P]: Static<P[F]> }]
	): Address<HostKind<N, P>>;
	readonly kind: N;
	/** Type only: absent at runtime. */
	// 类型层携带 params；运行时没有，静态值由 WeakMap 保存。
	readonly "~params"?: P;
}

/** The params object of a host kind. */
// 从 KindShape 的可选 "~params" 中取出每个字段的静态值类型，得到普通对象类型。
export type ParamsOfKind<K extends KindShape> = {
	[F in keyof NonNullable<K["~params"]>]: Static<NonNullable<K["~params"]>[F]>;
};

/**
 * Declares a host kind; `params` follow the params policy of contracts (a flat record of required `str()`, `int()`,
 * `bool()` and `oneOf(...)`). Making an address computes its key only: its params are checked where it is routed.
 */
// 用途：声明 host 种类。输入名称和可选 params，输出 HostKind 函数；副作用：把 params 数据登记进 WeakMap。
// 错误路径：名称非法、占用 "client"、params 不符合策略时抛错。地址函数只拼 key，不在这里校验实参值。
// 例子：const session = hostKind("session", { id: str() }); const a = session({ id: "S1" }); a.key === "session|S1"。
export function hostKind<const N extends string, const P extends Params = Record<never, never>>(
	name: N,
	params?: P & NoInfer<RequiredFields<P>>,
): HostKind<N, P> {
	checkName(name, "A host kind's name");
	// `client` is the host kind of a host without an address in store names (owner strings, table names).
	// client 在存储命名里表示“没有地址的本地宿主”，若允许用户声明会造成歧义。
	if (name === "client") throw new Error('A host kind\'s name "client" is reserved for hosts without an address');
	const data = readParams(Object.entries(params ?? {}), `${name}.params`);
	// make 是地址工厂：默认空对象，便于无参数种类；key 由 addressKey 按声明字段顺序生成。
	const make = (values: { readonly [field: string]: unknown } = {}) => ({
		kind: name,
		params: values,
		key: addressKey(name, data, values),
	});
	// defineProperty 让 kind 只读且可枚举；普通赋值也能工作，这里明确属性形状。
	Object.defineProperty(make, "kind", { value: name, enumerable: true });
	// 以函数对象为键保存 params 快照；kindParams 只能识别真正由本函数创建的种类。
	kinds.set(make, data);
	// The function and its `kind` are the declared shape; the params type is type-level only.
	return make as unknown as HostKind<N, P>;
}

// 模块级 WeakMap：声明过的 host 种类 -> params 数据；函数对象被回收后记录也随之释放。
const kinds = new WeakMap<object, ParamsData>();

/** The params of a declared host kind. */
// 用途：取种类的 params 快照。输入任意带 kind 字段的对象，输出 ParamsData。
// 错误路径：不是 hostKind 创建的对象（例如手工伪造 { kind: "x" }）会抛错。
export function kindParams(kind: { readonly kind: string }): ParamsData {
	const data = kinds.get(kind);
	if (data === undefined) throw new Error(`${kind.kind}: not a declared host kind`);
	return data;
}

/** An address's key: the kind's name and each field value in declared order, joined (`joinKey`). */
// 用途：生成地址 key。输入种类名、params 数据和参数值，输出字符串；无副作用。
// 字段顺序来自声明而非对象键顺序，因此相同参数总得到相同 key；joinKey 会转义分隔符避免歧义。
export function addressKey(kind: string, params: ParamsData, values: { readonly [field: string]: unknown }): string {
	return joinKey([kind, ...params.fields.map((field) => String(values[field]))]);
}
