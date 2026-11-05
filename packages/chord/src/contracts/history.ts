// The type-level history of a contract: every version's members and the changes that produced it.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约历史的类型层（全部在编译后擦除）。
// 解决的问题：让 TypeScript 知道每个版本有哪些变体、成员和编辑，从而让 evolve 的返回值、accepts 的映射需求
//   在编译期被推导出来；运行时没有这里的对象。
// 职责边界：只定义类型和条件类型，不做运行时校验、不保存数据；真实历史在 contract.ts 的 VersionData[]。
// 上游：declare 构造基础 History 类型，evolve 通过 Increment 追加版本；下游：accepts.ts 的 OlderVersions/
//   ChangesAfter/StepAt，contract.ts 的 CurrentStep/CurrentVariants，evolve.ts 的 MemberNames/MethodAt 等。
// 能力清单：
// - VariantShape、Variants：一个变体的成员形状和变体名到形状的字典。
// - Change、Step、History：一次编辑、一个版本、整段历史都是只读元组。
// - CurrentStep、StepAt、OlderVersions、ChangesAfter：从元组中取当前版本、指定版本、旧版本集合和之后的编辑。
// - MemberNames、VariantsWith、MethodAt：跨变体汇总成员名、找拥有某方法的变体、取方法签名。
// - Increment、NextDigit：在类型层做十进制版本号加一。
// 组合关系：History 是类型层的事实来源；CurrentStep 决定工厂形状，OlderVersions+ChangesAfter 决定 accepts 表，
//   Increment 决定 evolve 返回的新版本号。
// 示例（类型层，不会生成运行时代码）：
//   type H = [
//     { version: "1"; variants: V1; changes: never },
//     { version: "2"; variants: V2; changes: ["members", "text", "state"] },
//   ];
//   type Old = OlderVersions<H>;        // "1"
//   type After = ChangesAfter<H, "1">;  // ["members", "text", "state"]
// 建议阅读顺序：先看 VariantShape/Variants/Change/Step/History，再看 CurrentStep 与 OlderVersions/ChangesAfter
//   的元组解构，随后看 MemberNames/VariantsWith/MethodAt，最后看 Increment/NextDigit。

import type { Method, Schema } from "./schema.ts";

/** One variant's members at one version: state schemas and method signatures. */
// 一个变体在某版本的类型形状：state 和 methods 必有，keyed 只有 local 契约才有，所以可选。
export type VariantShape = {
	readonly state: { readonly [member: string]: Schema };
	readonly methods: { readonly [member: string]: Method };
	/** A local contract's keyed state members (slice 6a §12). */
	readonly keyed?: { readonly [member: string]: Schema };
};

/** Variants by name. A local contract has the single variant `members`. */
// 变体名到形状的字典；local 契约固定只有 members 一个键。
export type Variants = { readonly [variant: string]: VariantShape };

/**
 * What one edit changed: one side of one member in one variant (a union of variants when it changed several); `keyed`
 * for a local contract's keyed member (slice 7b).
 */
// 一次编辑就是只读三元组：哪个变体的哪个成员的哪一侧。编辑多个变体时，Change 会是一个三元组联合。
// 类型上用 readonly [string, string, ...] 表示定长元组，运行时就是普通数组。
export type Change = readonly [variant: string, member: string, side: "state" | "args" | "result" | "keyed"];

/** One version: its number as digits, its variants, and the changes that produced it (`never` for a base). */
// 版本号在类型层用字符串表示（"1"、"2"），便于模板字面量类型做加一；base 版本的 changes 是 never。
type Step = { readonly version: string; readonly variants: Variants; readonly changes: Change };

/** Every version from the base, oldest first. */
// 历史是只读元组；顺序即版本顺序，最后一个元素是当前版本。
export type History = readonly Step[];

// 用“前缀元素... + 最后一个元素”的解构模式取出元组末项；不匹配（例如 any）时得到 never。
export type CurrentStep<H extends History> = H extends readonly [...Step[], infer Last extends Step] ? Last : never;

// Extract 从联合中挑出版本字段等于 V 的成员；V 是字符串字面量。
export type StepAt<H extends History, V extends string> = Extract<H[number], { readonly version: V }>;

/** Versions before the current one. */
// 模式 [...infer Older, Step] 把最后一个版本去掉，Older 推断为前缀元组；再取所有元素的 version 联合。
export type OlderVersions<H extends History> = H extends readonly [...infer Older extends Step[], Step]
	? Older[number]["version"]
	: never;

/** Every change made after version `V`. */
// 递归：当前首元素版本就是 V 时，返回剩余所有版本 changes 的联合；否则丢弃首元素继续找。
// 这是编译期递归，历史很长时由 TS 的递归深度限制兜底。
export type ChangesAfter<H extends readonly Step[], V extends string> = H extends readonly [
	infer First extends Step,
	...infer Rest extends Step[],
]
	? First["version"] extends V
		? Rest[number]["changes"]
		: ChangesAfter<Rest, V>
	: never;

/** Names of the state members or methods in any variant. */
// 映射类型对每个变体取 Side 段的键，再用 [keyof V] 合并成联合；& string 去掉可能的 number/symbol 键。
export type MemberNames<V extends Variants, Side extends keyof VariantShape> = {
	[X in keyof V]: keyof V[X][Side];
}[keyof V] &
	string;

/** The variants that have method `M`. */
// 对每个变体判断是否拥有方法 M：有则保留变体名，否则 never；最后索引成变体名联合。
export type VariantsWith<V extends Variants, M> = {
	[X in keyof V]: M extends keyof V[X]["methods"] ? X : never;
}[keyof V] &
	string;

/** Method `M` (one signature in every variant that has it). */
// 方法签名跨变体一致，所以取任一拥有它的变体即可；联合经过索引后得到同一个 Method 类型。
export type MethodAt<V extends Variants, M> = {
	[X in keyof V]: M extends keyof V[X]["methods"] ? V[X]["methods"][M] : never;
}[keyof V];

/** `N + 1` on decimal digits, so versions beyond 9 and 99 stay literal. */
// 模板字面量类型做十进制加一：以 9 结尾时把前缀继续加一并在末尾补 0（"9" -> "10"，"19" -> "20"）；
// 否则用映射 NextDigit 查最后一位的下一位数字。空字符串前缀时 "9" 变成 "10"。
export type Increment<N extends string> = N extends `${infer Init}9`
	? `${Init extends "" ? "1" : Increment<Init>}0`
	: { [D in keyof NextDigit]: N extends `${infer Init}${D}` ? `${Init}${NextDigit[D]}` : never }[keyof NextDigit];

// 单个十进制数字到下一个数字的映射；keyof 是 "0" | ... | "8"。
type NextDigit = { "0": "1"; "1": "2"; "2": "3"; "3": "4"; "4": "5"; "5": "6"; "6": "7"; "7": "8"; "8": "9" };
