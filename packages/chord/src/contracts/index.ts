// 文件导读
// 所属模块：packages/chord/src/contracts，面向应用的公开入口（@earendil-works/chord/contracts）。
// 解决的问题：把声明、演进、host 种类和 schema 构造器集中到一个稳定入口，应用不必知道内部文件划分。
// 职责边界：只做再导出，不执行声明、不读 WeakMap、不修改全局状态；内部层需要额外访问器时改用 internal.ts。
// 上游：应用源码 import；下游：declare.ts、evolve.ts、host-kind.ts、schema.ts 的实现。export type 在运行时擦除。
// 能力清单：
// - AcceptsTable：旧版本映射表的类型，通常与 evolve 配合。
// - Contract、Implementation、KeyedWatchable、ParamsOf：契约句柄、工厂形状、keyed 成员和参数对象的类型。
// - local()、remote()：声明 local/remote 契约。
// - evolve()：追加新版本并生成新契约。
// - Address、HostKind、hostKind、KindShape、ParamsOfKind：声明 host 种类并生成地址。
// - arr/bool/bytes/int/keyed/lit/map/method/nul/num/obj/oneOf/opt/str/union/unknown 及配套类型：schema 构造器与声明标记。
// 组合关系：schema 构造器 -> remote/local 的 members/variants -> evolve 演进 -> hostKind 给 remote 提供 hostAddress；
//   Implementation 只用于标注工厂返回值，不参与运行时。
// 示例：
//   const session = hostKind("session", { id: str() });
//   const notes = remote("notes", {
//     version: 1,
//     params: { owner: str() },
//     hostAddress: ({ owner }) => session({ id: owner }),
//     variants: { editor: { state: { text: str() }, methods: { save: method(str(), nul()) } } },
//   });
//   const v2 = evolve(notes, (e) => e.addState("editor", "count", int()));
// 建议阅读顺序：先看 Contract/Implementation 与 schema 构造器，再看 remote/local 的声明，随后看 evolve，
//   最后看 hostKind/Address 与 AcceptsTable 的兼容性入口。

// Contracts for apps: declaring, evolving and implementing Chord object types.

// 应用的契约入口（@earendil-works/chord/contracts）：只做再导出，不执行声明或修改全局状态。
// 应用从这里拿 remote/local、evolve、hostKind 和 schema 构造器；内部层使用 internal.ts 的额外导出。
// export type 在运行时擦除；export 的函数/常量仍指向各自实现文件。

export type { AcceptsTable } from "./accepts.ts";
// 契约句柄与实现形状：应用用 Contract 标注导出的契约，用 Implementation 标注工厂返回值。
export type { Contract, Implementation, KeyedWatchable, ParamsOf } from "./contract.ts";
// 声明与演进的公开函数。
export { local, remote } from "./declare.ts";
export { evolve } from "./evolve.ts";
// host 种类与地址；Address 是类型，hostKind 是运行时函数。
export { type Address, type HostKind, hostKind, type KindShape, type ParamsOfKind } from "./host-kind.ts";
// schema 构造器与类型：str/int/bool 等返回带静态值类型的 Schema，method/keyed 用于声明成员。
export {
	arr,
	type BooleanSchema,
	type Bounds,
	bool,
	bytes,
	type Defaulted,
	type IntegerSchema,
	int,
	type KeyedMember,
	keyed,
	lit,
	map,
	method,
	type NullSchema,
	type NumberSchema,
	nul,
	num,
	type Optional,
	obj,
	oneOf,
	opt,
	type Schema,
	type Static,
	type StringSchema,
	str,
	union,
	unknown,
} from "./schema.ts";
