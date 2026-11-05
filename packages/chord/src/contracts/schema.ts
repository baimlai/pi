// Schema helpers: Chord's short constructors over pi-schema's builders (plain JSON Schema, typed with the values they
// accept), and method and keyed member declarations. The helpers keep the shapes contracts were fingerprinted with:
// literals carry their `type`, `oneOf` is a union of literals, `map` a pattern-property record.

// 文件导读
// 所属模块：packages/chord/src/contracts，契约 schema 构造器与成员声明标记。
// 解决的问题：应用需要短小、带静态值类型的构造函数，同时这些函数生成的 JSON Schema 必须保持指纹依赖的固定形状：
//   lit 带 type、oneOf 是 anyOf 字面量、map 用 patternProperties。
// 职责边界：只构造普通 JSON Schema 和 Method/KeyedMember 标记；不做值校验（validator 负责）、不做快照/白名单检查
//   （snapshot.ts 负责）；这些函数不会在运行时验证应用传入的值。
// 上游：应用声明 members/variants/params；下游：declare/evolve 调 snapshotSchema/snapshotArguments，schema 构造器
//   生成的对象随后被复制成 Chord 拥有的快照。Method/KeyedMember 靠 instanceof 在声明期分流。
// 能力清单：
// - Bounds、Defaulted、Literal：长度/数值边界、默认值和字面量值的类型辅助。
// - StringSchema/NumberSchema/IntegerSchema/BooleanSchema/NullSchema/LiteralsSchema：带 type 判别的 schema 接口。
// - str()/num()/int()/bool()/nul()：标量构造器，部分接受边界、pattern 或默认值。
// - lit()/oneOf()/union()：字面量、字面量联合和任意 schema 联合。
// - obj()/arr()/map()/unknown()/bytes()：对象、数组、字符串键记录、任意值和二进制叶节点。
// - Method、KeyedMember、keyed()、method()：成员声明标记；method 有四种重载对应参数/结果的省略组合。
// - defaultOf()、limits()、isOptional()：内部辅助；isOptional 是类型谓词，用于识别 opt(...)。
// 组合关系：标量构造器 -> obj/arr/map/union 组合 -> method/keyed 包装 -> remote/local 声明 -> snapshot 复制。
// 示例：
//   const task = obj({ title: str({ min: 1 }), done: opt(bool()) });
//   const save = method(task, nul());
//   // save.args 是闭合对象 schema，save.result 是 null schema
// 建议阅读顺序：先看 StringSchema 等接口与 Bounds/Defaulted，再看标量构造器的重载，随后看 lit/oneOf/union/obj/
//   arr/map/unknown/bytes，最后看 Method/KeyedMember 与 method/keyed 声明入口。

import {
	arr as arrSchema,
	bool as boolSchema,
	bytes as bytesSchema,
	int as intSchema,
	nul as nulSchema,
	num as numSchema,
	Optional,
	obj as objSchema,
	type Properties,
	type Schema,
	type Static,
	type StaticObject,
	str as strSchema,
	union as unionSchema,
	unknown as unknownSchema,
} from "@earendil-works/pi-schema";

export { Optional, opt, type Schema, type Static } from "@earendil-works/pi-schema";

/** Bounds of a string length, a number or an array length. */
// 通用边界：min/max 的含义由调用方映射到具体关键字（minLength/maximum/minItems 等）。
export type Bounds = { readonly min?: number; readonly max?: number };

/** A declared default value: a table column with one may be left out of a `put` (slice 6a §5). */
// 带默认值的 schema 在表中允许 put 省略该列；params 字段则明确禁止 default。
export type Defaulted<T> = { readonly default: T };

// Interfaces, not intersections: declarations of apps' exported contracts and tables name them (an intersection with
// `Schema<T>` would print pi-schema's private brand, which declaration files cannot name).

/** A string schema (`str()`), told apart from the other scalars by its `type`. */
// 在类型层用 type: "string" 与其他标量区分；运行时它只是普通对象，判别靠读取 type 字段。
export interface StringSchema extends Schema<string> {
	readonly type: "string";
}

/** A number schema (`num()`). */
// type: "number" 让注解能表达它接受的值是 number。
export interface NumberSchema extends Schema<number> {
	readonly type: "number";
}

/** An integer schema (`int()`). */
// 与 NumberSchema 分开，便于 params 白名单和文档阅读时区分整数约束。
export interface IntegerSchema extends Schema<number> {
	readonly type: "integer";
}

/** A boolean schema (`bool()`). */
export interface BooleanSchema extends Schema<boolean> {
	readonly type: "boolean";
}

/** The `null` schema (`nul()`): also the omitted side of a method. */
// null schema 同时表示方法省略的一侧；类型层 NullSchema 用于 MethodFunction 判断是否省略参数。
export interface NullSchema extends Schema<null> {
	readonly type: "null";
}

/** A union of literals (`oneOf(...)`). */
// anyOf 是 schema 数组；泛型 V 让静态值类型变成字面量联合。
export interface LiteralsSchema<V extends Literal> extends Schema<V> {
	readonly anyOf: readonly Schema<V>[];
}

/** A string, with optional length bounds, pattern and default. */
// str 有两个公开重载：提供 default 时返回带 Defaulted<string> 的交叉类型，表列可省略；否则只返回 StringSchema。
// 例子：str({ min: 1, max: 80 }) 与 str({ default: "" }) 都能通过类型检查。
export function str(
	options: Bounds & { readonly pattern?: string; readonly default: string },
): StringSchema & Defaulted<string>;
export function str(options?: Bounds & { readonly pattern?: string }): StringSchema;
// 实现签名同时兼容两个重载；default 设为可选，返回值按最宽形状标注，具体重载由上面两行决定。
export function str(options: Bounds & { readonly pattern?: string; readonly default?: string } = {}): StringSchema {
	// 只在提供 pattern 时展开该键；snapshot 拒绝值为 undefined 的关键字，所以不能无条件写 pattern: undefined。
	const pattern = options.pattern === undefined ? {} : { pattern: options.pattern };
	// limits 把 min/max 改名成 minLength/maxLength；defaultOf 只在有默认值时返回 { default }。
	// pi-schema 的 strSchema 返回更宽的 Schema 类型，这里断言成 StringSchema 以保留 type: "string" 的判别。
	return strSchema({
		...limits(options, "minLength", "maxLength"),
		...pattern,
		...defaultOf(options),
	}) as StringSchema;
}

/** A finite number within optional bounds, with an optional default. */
// 与 str 相同的重载模式：有 default 时返回带 Defaulted<number> 的类型，否则只返回 NumberSchema。
export function num(options: Bounds & { readonly default: number }): NumberSchema & Defaulted<number>;
export function num(options?: Bounds): NumberSchema;
export function num(options: Bounds & { readonly default?: number } = {}): NumberSchema {
	// min/max 映射为 JSON Schema 的 minimum/maximum；default 只在存在时加入。
	return numSchema({ ...limits(options, "minimum", "maximum"), ...defaultOf(options) }) as NumberSchema;
}

/** An integer within optional bounds, with an optional default. */
// 整数版本与 num 相同，但底层用 intSchema，规范形式里的 type 是 "integer"。
export function int(options: Bounds & { readonly default: number }): IntegerSchema & Defaulted<number>;
export function int(options?: Bounds): IntegerSchema;
export function int(options: Bounds & { readonly default?: number } = {}): IntegerSchema {
	return intSchema({ ...limits(options, "minimum", "maximum"), ...defaultOf(options) }) as IntegerSchema;
}

/** A boolean, with an optional default. */
// bool 没有边界，只有可选的 default；实现签名接受空对象，方便无参调用。
export function bool(options: { readonly default: boolean }): BooleanSchema & Defaulted<boolean>;
export function bool(options?: Record<never, never>): BooleanSchema;
export function bool(options: { readonly default?: boolean } = {}): BooleanSchema {
	return boolSchema(defaultOf(options)) as BooleanSchema;
}

/** The `default` keyword of `options`, left out when absent (snapshots refuse `undefined`). */
// 用途：把可选 default 转成 schema 片段。输入可能带 default 的 options，输出 {} 或 { default }。
// 关键点：不能返回 { default: undefined }，否则序列化/快照会包含 undefined 键；因此按值是否存在分支。
function defaultOf<T extends string | number | boolean>(options: { readonly default?: T }): { default?: T } {
	return options.default === undefined ? {} : { default: options.default };
}

/** `null`; also the omitted side of a method. */
// 用途：构造 null schema。无输入，输出 NullSchema；无副作用。
// nulSchema() 的返回类型更宽，断言成 NullSchema 以保留 type: "null" 的判别信息。
export function nul(): NullSchema {
	// The builder's `type: "null"`, typed as such.
	return nulSchema() as NullSchema;
}

/** Exactly the given value, with its JSON type (`{ type: "string", const: "a" }`). */
// 用途：字面量 schema。输入字符串/数字/布尔，输出带 type 和 const 的普通对象。
// const 泛型保留最窄字面量类型；typeof value 只产生 "string" | "number" | "boolean" 三种 JSON 类型。
// 例子：lit("open") 生成 { type: "string", const: "open" }。
export function lit<const V extends Literal>(value: V): Schema<V> {
	return { type: typeof value, const: value };
}

/** A value `lit(...)` and `oneOf(...)` take. */
// 只允许 JSON 标量字面量；对象/数组不能作为 oneOf 的候选值。
export type Literal = string | number | boolean;

/** One of the given literals: a union of `lit(...)` schemas, in order. */
// 用途：字面量联合。输入若干字面量，输出 { anyOf: [...] }；顺序保留，但快照阶段会对 anyOf 数组保持顺序。
// V[number] 把元组转成元素联合，得到静态值类型。例子：oneOf("open", "closed") 接受两个字符串之一。
export function oneOf<const V extends Literal[]>(...values: V): LiteralsSchema<V[number]> {
	return { anyOf: values.map((value) => lit(value)) };
}

/** Any of the given schemas. */
// 用途：任意 schema 联合。输入 readonly 元组，输出 Schema<Static<元素联合>>；底层交给 pi-schema 的 union。
export function union<const S extends readonly Schema[]>(schemas: S): Schema<Static<S[number]>> {
	return unionSchema(schemas);
}

/** A closed object: unknown fields are refused; `opt(...)` marks an optional field. */
// 用途：闭合对象 schema。输入属性表，输出 Schema<StaticObject<P>>；未知字段在值校验时被拒绝。
// 参数对象的闭合性还会被 snapshotArguments 检查，所以方法参数里的对象必须用 obj。
export function obj<const P extends Properties>(properties: P): Schema<StaticObject<P>> {
	return objSchema(properties);
}

/** An array, with optional length bounds. */
// 用途：数组 schema。items 决定元素类型，min/max 映射为 minItems/maxItems；返回 Schema<T[]>。
export function arr<T>(items: Schema<T>, options: Bounds = {}): Schema<T[]> {
	return arrSchema(items, limits(options, "minItems", "maxItems"));
}

/** A string-keyed record: one pattern property matching every key. */
// 用途：字符串键记录。patternProperties 的 "^.*$" 表示所有键都套用同一个值 schema；
// 因此可以表达 map(str()) 而无需列举键。无运行时值校验，只有结构。
export function map<T>(value: Schema<T>): Schema<Record<string, T>> {
	return { type: "object", patternProperties: { "^.*$": value } };
}

/** Any value. */
// 用途：接受任意值；底层 unknownSchema 的规范形式仍受 snapshot 的 vocabulary 限制。
export function unknown(): Schema<unknown> {
	return unknownSchema();
}

/**
 * A `Uint8Array` leaf, checked by `instanceof` and length, never enumerated: `{ type: "bytes", minLength?, maxLength? }`
 * (pi-schema's extension of JSON Schema for values that never pass through JSON).
 */
// 用途：二进制叶节点。输入可选边界，输出 Schema<Uint8Array>；运行时不枚举字节，只检查实例和长度。
// 生成的 type: "bytes" 不属于标准 JSON Schema，是 pi-schema 的扩展；snapshot 会标记 bytes 叶供链接编码。
export function bytes(options: Bounds = {}): Schema<Uint8Array> {
	return bytesSchema(limits(options, "minLength", "maxLength"));
}

/** Builder options for the given bounds; an absent bound is left out, since snapshots refuse `undefined`. */
// 用途：把 min/max 改名为指定关键字。输入边界、最小/最大关键字名，输出只含实际提供项的对象。
// 不能写 { [min]: undefined }，因为快照会拒绝 undefined 值。例子：limits({ min: 1 }, "minLength", "maxLength")
// 返回 { minLength: 1 }。
function limits(options: Bounds, min: string, max: string): { [keyword: string]: number } {
	const result: { [keyword: string]: number } = {};
	if (options.min !== undefined) result[min] = options.min;
	if (options.max !== undefined) result[max] = options.max;
	return result;
}

/** Whether a declared object field is `opt(...)`. */
// 类型谓词 `value is Optional`：返回 true 时，调用方的类型在分支内收窄为 Optional。
// 运行时靠 instanceof 判断 pi-schema 的 Optional 标记对象；params 校验据此拒绝可选字段。
export function isOptional(value: unknown): value is Optional {
	return value instanceof Optional;
}

/** A method declaration: its argument and result schemas; an omitted side is `null` on the wire. */
// 方法声明标记。args 与 result 保存 schema；声明阶段用 instanceof Method 把它们从 state 成员里分流出来。
export class Method<A extends Schema = Schema, R extends Schema = Schema> {
	readonly args: A;
	readonly result: R;

	constructor(args: A, result: R) {
		this.args = args;
		this.result = result;
	}
}

/** A keyed state member's declaration (slice 6a §12): documents of `schema` by string key; only in `local` contracts. */
// keyed 成员标记：内部保存文档 schema；只有 local 契约允许，remote 声明会拒绝。
export class KeyedMember<S extends Schema = Schema> {
	readonly schema: S;

	constructor(schema: S) {
		this.schema = schema;
	}
}

/** Declares a keyed state member of a `local` contract: documents of `schema` by string key, each watchable. */
// 用途：声明 keyed 成员。输入文档 schema，输出 KeyedMember；无副作用。运行时靠 instanceof 分流。
export function keyed<S extends Schema>(schema: S): KeyedMember<S> {
	return new KeyedMember(schema);
}

/** Declares a method: `method()`, `method(args)`, `method(args, result)` or `method(undefined, result)`. */
// 四个重载覆盖省略参数、省略结果、两者都有、只给结果四种写法：
// method() -> (null, null)；method(args) -> (args, null)；method(undefined, result) -> (null, result)；
// method(args, result) 保留两侧类型。实现签名用可选参数，最后统一用 nul() 补缺省值。
export function method(): Method<NullSchema, NullSchema>;
export function method<A extends Schema>(args: A): Method<A, NullSchema>;
export function method<R extends Schema>(args: undefined, result: R): Method<NullSchema, R>;
export function method<A extends Schema, R extends Schema>(args: A, result: R): Method<A, R>;
export function method(args?: Schema, result?: Schema): Method {
	return new Method(args ?? nul(), result ?? nul());
}
