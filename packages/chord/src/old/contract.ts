// 文件导读（Chord v1 契约声明）
// ============================
// 所属包与模块：packages/chord/src/old/contract.ts，Chord v1 的契约声明与静态类型推导层。
//
// 解决问题：应用用 `remote(...)`/`local(...)` 声明“一个对象类型有哪些变体、状态成员、方法和不透明原生值”。
// 本文件把这些声明变成一份可跨链路传输的纯数据 description 与指纹 fingerprint，并提供版本覆盖检查
// coverage() 和跨版本适配选择 bind()；再从同一份声明推导出 TypeScript 的引用类型 Ref、调用类型 Call、
// 实现类型 ImplementationOf。运行时与编译期共用一套声明，避免手写两份容易漂移的接口。
//
// 职责边界：本文件声明契约、生成描述、比较兼容性；它不创建对象实例、不打开连接、不执行方法、不做网络编码。
// 上游：old/index.ts 重导出；host.ts、connection.ts、remote.ts、reload.ts、object.ts、wire.ts 使用这些描述。
// 下游：@earendil-works/pi-schema 的构建器与 Static 类型；schema.ts 的 canonicalJson/fits/hash64/isValid；
// errors.ts 的 ChordError/invalid；types.ts 的 Ctx/Exposed/Readable/RefBase/StateSource（仅类型）。
// 结果与错误流向：声明错误抛 TypeError；描述令牌格式错误抛 ChordError("invalid", reason:"token")；
// 版本不匹配抛 ChordError("contract_mismatch")；正常比较返回 undefined 或适配函数。
//
// 能力清单（导出项）：
// - MethodSpec / method()：声明方法及其参数、结果 schema；重载区分无参/无结果。
// - OpaqueSpec / opaque()：声明本地不透明原生对象（name@version），不能跨远程契约使用。
// - VariantDef / RemoteDef / LocalDef：远程多变体或本地单变体契约的定义形状。
// - HostNamed / HostFamily / Placement / hostNamed() / hostFamily()：远程对象归属的宿主位置。
// - PlacementFor / InputOf：从输入类型推导可用位置或输入值类型。
// - resolveHost() / placedOn() / placementText()：解析位置、判断宿主是否可服务、生成可读文字。
// - LocalMember：本地成员（方法/不透明值/状态 schema 三者之一）。
// - MemberDescription / Description / DescriptionSchema：跨链路传输的描述及其运行时校验 schema。
// - ContractBase / RemoteContract / LocalContract / AnyContract：声明产物与描述、指纹的封装。
// - LOCAL_VARIANT / RESERVED_MEMBERS：本地契约的固定变体名、引用自身保留的成员名。
// - remote() / local()：创建契约并计算指纹。
// - contractFromDescription()：从收到的描述还原“消费者令牌”（没有 def，只能绑定和校验）。
// - coverage() / Adapter / Accepts / bind()：同版本覆盖检查、跨版本适配器的选择与绑定。
// - MethodImplementation / Call / ImplementationOf / Ref：从声明推导实现与引用类型的类型工具。
// - takesNoArgs()：查询某方法是否无参数（决定引用调用签名）。
//
// 组合关系与典型顺序：
//   声明：remote(name, { version, input, host, variants }) -> RemoteContract
//   绑定：contractFromDescription(description) -> bind(provider, accepts, consumer) -> 适配器或 undefined
//   类型：ImplementationOf<typeof Contract> 约束服务端工厂返回值；Ref<typeof Contract> 是客户端引用类型。
// 例子（示例；导入和版本号按真实签名书写）：
//   const Counter = remote("demo.counter", {
//     version: 1,
//     input: obj({ name: str() }),
//     host: hostFamily("counter:", "name"),
//     variants: {
//       main: { state: { count: int() }, methods: { add: method(int()) } },
//     },
//   });
//   const ref: Ref<typeof Counter> = await ctx.get(Counter, { name: "a" });
//   if (ref.variant === "main") await ref.add(1);
//
// 建议阅读顺序：先看 MethodSpec/OpaqueSpec 与 method()/opaque() 的声明方式，再看 Placement 与 resolveHost；
// 然后读远端/本地 Def、DescriptionSchema 和 remote()/local() 如何生成描述与指纹；接着读 coverage()/bind()
// 的兼容规则；最后读文件末尾的条件类型，理解 Ref 与 ImplementationOf 如何从声明推导出来。
import { int, lit, map, obj, opt, type Schema, type Static, str, union } from "@earendil-works/pi-schema";
import { ChordError, invalid } from "./errors.ts";
import { canonicalJson, fits, hash64, isValid } from "./schema.ts";
import type { Ctx, Exposed, Readable, RefBase, StateSource } from "./types.ts";

// 成员品牌：用唯一 Symbol 作为运行时标记，区分 method()/opaque() 与普通状态 schema。
// Symbol 不会被 JSON 序列化，也不会出现在 description 里；它只服务于 describeMember 的分派。
const MEMBER = Symbol("chord.member");

/** A method's arguments and result; `undefined`: it takes no arguments, or returns nothing (void). */
// MethodSpec 的泛型参数：
// - A 是参数 schema 或 undefined（无参数），约束为 Schema | undefined；
// - R 是结果 schema 或 undefined（无结果/void）；
// - 两个默认值让只写 MethodSpec 时等价于 MethodSpec<Schema | undefined, Schema | undefined>。
// [MEMBER] 是计算属性名，值被限定为字面量 "method"；这样 method() 的返回值在运行时带品牌、在类型上可识别。
export interface MethodSpec<
	A extends Schema | undefined = Schema | undefined,
	R extends Schema | undefined = Schema | undefined,
> {
	readonly [MEMBER]: "method";
	readonly args: A;
	readonly result: R;
}

// OpaqueSpec 表示一个本地原生对象，按 name@version 标识；远程契约不能暴露它（见 describeMember）。
// type 字段只用于携带泛型 T，让 Ref<C> 能推导出原生值的类型；它永远不会在运行时赋值。
export interface OpaqueSpec<T = unknown> {
	readonly [MEMBER]: "opaque";
	readonly id: string;
	/** Type carrier only; never set. */
	readonly type?: T;
}

/**
 * A method. `method()`: no arguments (called as `ref.name(ctx)`, implemented as `(ctx) => …`) and no result.
 * `method(args)`: no result, the handler returns nothing (void). `method(args, result)`, or `method(undefined, result)`
 * for a method without arguments that returns something.
 */
// 三个重载覆盖三种声明：method()、method(args)、method(args, result)。
// 最后一个签名是实现签名，参数在实现里是可选的；调用方只能看到上面三个重载的精确类型。
// 注意 method(undefined, result) 会命中第三个重载，用来声明“无参数但有返回值”的方法。
export function method(): MethodSpec<undefined, undefined>;
export function method<A extends Schema>(args: A): MethodSpec<A, undefined>;
export function method<A extends Schema | undefined, R extends Schema>(args: A, result: R): MethodSpec<A, R>;
export function method(args?: Schema, result?: Schema): MethodSpec {
	// 返回对象同时保存品牌与原始 schema；不做运行时 schema 编译或校验，校验发生在使用参数的宿主边界。
	return { [MEMBER]: "method", args, result };
}

/** A native in-process object identified by `name@version` (local contracts only). */
// 声明一个本地不透明原生对象。
// 输入：id 必须是 "name@version" 形式（名称不含 @/空白，版本是数字）。输出：带品牌与类型载体的 OpaqueSpec<T>。
// 错误：格式不符时同步抛 TypeError；这是对公开 API 参数的运行时校验，TypeScript 只能保证它是 string。
// 副作用：无。该对象只记录标识，真正实例由本地实现提供。
// 示例：const Harness = opaque<HarnessImpl>("harness@1"); 之后可在 local() 的 members 里使用。
export const opaque = <T = unknown>(id: string): OpaqueSpec<T> => {
	// 正则拆解：^[^@\s]+ 是名称（至少一个非 @、非空白字符），@ 分隔，\d+ 是数字版本，$ 要求整串匹配。
	if (!/^[^@\s]+@\d+$/.test(id)) throw new TypeError(`opaque id must be name@version: ${id}`);
	// 不设置 type 字段：它只存在于类型层，运行时对象只有品牌和 id。
	return { [MEMBER]: "opaque", id };
};

// 一个远程变体的可选成员表：state 是“成员名 -> schema”，methods 是“成员名 -> MethodSpec”。
// Record<string, ...> 是 TS 内置映射类型，表示任意字符串键；Readonly 只阻止通过该类型改属性。
export interface VariantDef {
	readonly state?: Readonly<Record<string, Schema>>;
	readonly methods?: Readonly<Record<string, MethodSpec>>;
}

/** Where objects of a remote type live: one named host. */
// 放置方式一：所有对象都在同一个固定名字的宿主上；name 会进入 description 和指纹。
export interface HostNamed {
	readonly name: string;
}

/** Where objects of a remote type live: the host `prefix` + the input's string field `key` (`session:` + `session`). */
// 放置方式二：按输入里的字符串字段动态选宿主。例如 prefix "session:"、key "session" 时，
// 输入 { session: "S1" } 的对象放在 "session:S1" 上。K 保存字段名的字面量类型，便于后续类型检查。
export interface HostFamily<K extends string = string> {
	readonly prefix: string;
	readonly key: K;
}

/** A remote type's placement: data only, so a description carries it and every host can check it. */
// Placement 是 HostNamed | HostFamily 的联合。因为都是纯数据，才能放进 description 跨链路传输。
export type Placement = HostNamed | HostFamily;

/** Objects of the type live on the host named `name` (`hostNamed("server")`). */
// 创建固定宿主放置。
// 输入：name 非空字符串。输出：{ name }。错误：空字符串或非字符串（后者只可能来自 JS 调用方）抛 TypeError。
// 示例：hostNamed("server") 表示该远程类型的对象都在名为 "server" 的宿主上。
export function hostNamed(name: string): HostNamed {
	// typeof 检查在 TS 调用方看来多余，但这是公开 API，JS 调用方可能传其他值；信任边界在此。
	if (typeof name !== "string" || name === "") throw new TypeError("hostNamed needs a host name");
	return { name };
}

/**
 * Objects of the type live on `prefix` + the value of the input's string field `key`: `hostFamily("session:",
 * "session")` puts `{ session: "S1", … }` on `session:S1`. The field is required and must be a non-empty string.
 */
// 创建“按输入字段选宿主”的放置。
// 输入：prefix 非空字符串，key 是非空字段名。泛型 <const K extends string> 让 TS 保留传入的字面量类型。
// 输出：HostFamily<K>。错误：参数为空或不是字符串时抛 TypeError（JS 调用方的运行时边界）。
// 示例：hostFamily("session:", "session") 返回 { prefix: "session:", key: "session" }。
export function hostFamily<const K extends string>(prefix: string, key: K): HostFamily<K> {
	if (typeof prefix !== "string" || prefix === "") throw new TypeError("hostFamily needs a host-name prefix");
	if (typeof key !== "string" || key === "") throw new TypeError("hostFamily needs an input field name");
	return { prefix, key };
}

/** Required string fields of `I`: what a `hostFamily` may name. */
// 类型工具：从输入类型 I 中找出“必填且值类型为 string”的键。
// [K in keyof I] 遍历所有键；-? 在中间映射类型上去掉可选修饰；
// I[K] extends string ? K : never 只保留值类型为 string 的键——可选字段的 I[K] 含 undefined，因此通常不通过；
// 最后 [keyof I] 做索引访问，把各键的结果合并成联合；& string 排除 symbol/number 键，保证 key 是字符串。
type StringKeys<I> = { [K in keyof I]-?: I[K] extends string ? K : never }[keyof I] & string;
/** The placements a remote type with input `I` may have. */
// 给定输入类型 I，只允许固定宿主，或 key 必须是 I 中某个必填字符串字段的 HostFamily。
export type PlacementFor<I> = HostNamed | HostFamily<StringKeys<I>>;

/** The host an object of `placement` with this (normalized) input lives on. Throws `invalid/placement`. */
// 根据放置方式和已归一化的输入算出对象所在宿主名。
// 输入：typeName 只用于错误文字；placement；input 应为归一化后的对象。
// 输出：宿主名字符串。错误：hostFamily 的字段缺失、不是字符串或为空时抛 invalid("placement")。
// 示例：resolveHost("demo.counter", hostFamily("counter:", "name"), { name: "a" }) 返回 "counter:a"。
export function resolveHost(typeName: string, placement: Placement, input: unknown): string {
	// "name" in placement 是运行时判别：HostNamed 有 name，HostFamily 没有。收窄后可直接读 placement.name。
	if ("name" in placement) return placement.name;
	// input 来自链路或调用方，仍是 unknown；先确认是非 null 对象，再按 placement.key 取字段。
	// 这里的 as Record<string, unknown> 只是索引访问所需的类型断言，不改变运行时值。
	const value =
		input !== null && typeof input === "object" ? (input as Record<string, unknown>)[placement.key] : undefined;
	// 必须是字符串且非空；空字符串无法构成有意义的宿主名。
	if (typeof value !== "string" || value === "")
		throw invalid("placement", `${typeName}: input field ${placement.key} names no host`);
	return placement.prefix + value;
}

/** Whether the host named `hostName` may serve a type of `placement`. */
// 判断名为 hostName 的宿主是否有资格服务该放置方式的对象。
// 固定宿主：名字必须完全相等。hostFamily：宿主名必须以 prefix 开头，且后面还有内容（避免 prefix 本身被当成宿主）。
// 这是纯函数，不做 I/O；名字比较区分大小写。
export const placedOn = (placement: Placement, hostName: string): boolean =>
	"name" in placement
		? placement.name === hostName
		: hostName.startsWith(placement.prefix) && hostName.length > placement.prefix.length;

// 生成适合错误消息/日志的放置文字：固定宿主直接给名字，动态宿主写成 "session:<session>"。
// 该字符串只用于展示，不参与指纹或路由。
export const placementText = (placement: Placement): string =>
	"name" in placement ? placement.name : `${placement.prefix}<${placement.key}>`;

// 远程契约定义：版本、输入 schema、放置方式、至少一个变体。
// input 描述“如何找到一个对象”，不描述对象状态；version 用于跨版本兼容判断。
export interface RemoteDef {
	readonly version: number;
	readonly input: Schema;
	/** Where its objects live: `hostNamed(…)` or `hostFamily(…)`. Part of the contract (and its fingerprint). */
	// host 是契约的一部分并参与指纹：改变放置方式等于改变了类型身份，旧消费者不能直接复用。
	readonly host: Placement;
	// 变体名 -> 变体定义；remote() 要求至少一个变体。
	readonly variants: Readonly<Record<string, VariantDef>>;
}

/** A local member: a method, an opaque native object, or a state member described by its schema. */
// 本地成员是三种值的联合：MethodSpec（方法）、OpaqueSpec（原生对象）、Schema（状态）。
// describeMember 用运行时品牌区分前两种，剩下的对象都按状态 schema 处理。
export type LocalMember = MethodSpec | OpaqueSpec | Schema;

// 本地契约定义：与远程相比没有 host 和变体，成员都放在同一个未命名变体里。
export interface LocalDef {
	readonly version: number;
	readonly input: Schema;
	readonly members?: Readonly<Record<string, LocalMember>>;
}

// A description travels as a reference's contract token (wire.ts), so it is declared once, as the schema that validates it.
// Any object is a schema, which is all a peer's schema is checked for here.
// 描述会作为引用的 contract token 跨链路传输，所以这里用一份 schema 同时定义“运行时如何校验”和“TypeScript 静态类型”。
// SchemaObject 表示“任意对象都算 schema”：对端 schema 的内部关键字不在本层校验，使用参数时再由 pi-schema 编译。
// obj({}, { open: true }) 生成允许任意额外字段的对象 schema；as Schema<Schema> 是类型断言，不改变运行时结构。
const SchemaObject = obj({}, { open: true }) as Schema<Schema>;

// 成员描述按 kind 判别：方法（参数/结果可选）、状态（带 schema）、不透明值（带 id）。
// union 要求值匹配其中一个分支；开放对象保留未知字段，便于新旧版本共存。
const MemberDescriptionSchema = union([
	// Absent `args`: the method takes none. Absent `result`: it returns nothing.
	// lit("method") 是字面量 schema，只接受字符串 "method"；opt(...) 表示字段可省略（不能是 null）。
	obj({ kind: lit("method"), args: opt(SchemaObject), result: opt(SchemaObject) }, { open: true }),
	obj({ kind: lit("state"), schema: SchemaObject }, { open: true }),
	obj({ kind: lit("opaque"), id: str() }, { open: true }),
]);
// Static<typeof Schema> 在编译期从 schema 反推 TypeScript 类型；它与运行时校验规则对应，但不会生成运行代码。
export type MemberDescription = Static<typeof MemberDescriptionSchema>;

/** Local contracts have one unnamed variant. */
// 本地契约没有变体概念，但仍统一放在一个空字符串命名的变体里，便于和远程共用描述结构。
export const LOCAL_VARIANT = "";

// 放置描述的运行时 schema：要么 { name }，要么 { prefix, key }；两个字符串都必须非空。
const PlacementSchema = union([
	obj({ name: str({ minLength: 1 }) }),
	obj({ prefix: str({ minLength: 1 }), key: str({ minLength: 1 }) }),
]);

// 跨链路传输的完整描述 schema。字段含义：
// - name/scope/version：类型身份与作用域；
// - input：查找对象的输入 schema；
// - host：仅远程类型必需，本地类型没有（外层用 opt 允许缺席）；
// - variants：两层 Record，外层变体名，内层成员名 -> MemberDescription。
// { open: true } 允许新版本增加字段；旧解析器只读取自己认识的字段。
export const DescriptionSchema = obj(
	{
		name: str({ minLength: 1 }),
		scope: union([lit("remote"), lit("local")]),
		version: int(),
		input: SchemaObject,
		/** Remote types only (required there): where their objects live. */
		host: opt(PlacementSchema),
		// map(T) 生成“任意字符串键 -> T”的 Record schema；嵌套两次就是 Record<string, Record<string, MemberDescription>>。
		variants: map(map(MemberDescriptionSchema)),
	},
	{ open: true },
);
// Description 是 DescriptionSchema 的静态类型：字段类型由 schema 推导，避免手写一份重复接口。
export type Description = Static<typeof DescriptionSchema>;

// 所有契约共有的字段：名字、版本、输入 schema、可传输描述、描述哈希得到的指纹。
// def 只保留在声明方的进程内对象上，不进入 description；从链路收到的令牌没有完整的 def。
interface ContractBase {
	readonly name: string;
	readonly version: number;
	readonly input: Schema;
	readonly description: Description;
	readonly fingerprint: string;
}

// 远程契约携带完整 RemoteDef；D 的默认值让 AnyContract 可以不写类型参数。
export interface RemoteContract<D extends RemoteDef = RemoteDef> extends ContractBase {
	readonly scope: "remote";
	readonly def: D;
}

// 本地契约携带完整 LocalDef。
export interface LocalContract<D extends LocalDef = LocalDef> extends ContractBase {
	readonly scope: "local";
	readonly def: D;
}

// 任意契约的联合；所有泛型工具都先判断 scope，再取对应的 def。
export type AnyContract = RemoteContract | LocalContract;

/** Names a reference uses itself; members may not use them. */
// 引用对象自身的方法/属性名；业务成员不能重名，否则会被引用实现覆盖或产生歧义。
// Set 是运行时集合，describeMember 声明成员时逐个检查；ReadonlySet 只阻止通过该引用调用 add/delete。
export const RESERVED_MEMBERS: ReadonlySet<string> = new Set([
	"variant",
	"status",
	"ready",
	"shape",
	"error",
	"onShape",
	"onStatus",
	"release",
	"then",
	"contract",
]);

// 把一个声明成员转换成可传输的 MemberDescription。
// 输入：成员名、成员值（unknown，因为来自用户声明）、契约作用域。
// 输出：method/state/opaque 三种描述之一。错误：保留名、远程契约里的 opaque 成员抛 TypeError。
// 流程：先查保留名 -> 读 Symbol 品牌 -> 方法省略缺席的 args/result -> opaque 检查作用域 -> 其余按状态 schema。
// 运行时校验边界：这里只认品牌和对象形状，不编译或验证状态 schema 本身。
function describeMember(name: string, member: unknown, scope: "remote" | "local"): MemberDescription {
	// 保留名冲突是声明错误，用 TypeError 而不是 ChordError，因为发生在应用启动期而非链路调用期。
	if (RESERVED_MEMBERS.has(name)) throw new TypeError(`member name is reserved: ${name}`);
	// 读取 Symbol 品牌；成员可能没有品牌（普通 schema），所以索引签名声明为可选字符串。
	const brand = (member as { [MEMBER]?: string })[MEMBER];
	if (brand === "method") {
		// 品牌成立后断言为 MethodSpec；args/result 可能为 undefined。
		const spec = member as MethodSpec;
		return {
			kind: "method",
			// 条件展开：只有真正声明了 schema 才写字段，undefined 不进入描述（描述要能无损走 JSON）。
			...(spec.args === undefined ? {} : { args: spec.args }),
			...(spec.result === undefined ? {} : { result: spec.result }),
		};
	}
	if (brand === "opaque") {
		// 不透明值只在同一进程内有意义，跨远程契约没有可移植标识，因此禁止。
		if (scope === "remote") throw new TypeError(`remote contracts cannot expose opaque members: ${name}`);
		return { kind: "opaque", id: (member as OpaqueSpec).id };
	}
	// 其余成员一律当作状态 schema；这是声明约定，不是运行时形状校验。
	return { kind: "state", schema: member as Schema };
}

// 给契约补上指纹并返回。输入是去掉 fingerprint 的契约（Omit 工具类型删除该字段）。
// 指纹只对 description 做规范化 JSON 后哈希：同一描述必然同一指纹，与 def 里的函数/对象身份无关。
// as C 是必要的断言：TS 无法从 Omit<C, "fingerprint"> 泛型参数证明加回字段后恰好是 C。
function finish<C extends AnyContract>(contract: Omit<C, "fingerprint">): C {
	return { ...contract, fingerprint: hash64(canonicalJson(contract.description)) } as C;
}

// 校验契约头：名字非空、版本是正整数。运行时检查公开 API 输入，因为 JS 调用方绕过 TS 类型。
function checkHeader(name: string, version: number): void {
	if (!name) throw new TypeError("contract name is empty");
	if (!Number.isInteger(version) || version < 1) throw new TypeError(`contract version must be a positive integer`);
}

// 创建远程契约。
// 输入：name；def 至少含 version/input/host/variants。泛型 <const D> 保留变体名等字面量，便于 Ref 精确推导。
//   host 的类型是 PlacementFor<Static<D["input"]>>，编译期限制 hostFamily 的 key 必须是输入里的字符串字段。
// 输出：RemoteContract<D>，含 def、description 和 fingerprint。
// 错误：名字/版本非法、host 缺失或形状错误、没有变体、同一变体内状态与方法重名、方法位置放了非 method 值，
//   都抛 TypeError；这些都是声明期错误，不是链路协议错误。
// 副作用：无 I/O；只创建普通对象并计算哈希。
// 流程：校验头 -> 校验并复制 host -> 遍历变体，把状态和方法转成成员描述 -> 组装 description -> 计算指纹。
// 示例：
//   const Counter = remote("demo.counter", {
//     version: 1,
//     input: obj({ name: str() }),
//     host: hostFamily("counter:", "name"),
//     variants: { main: { state: { count: int() }, methods: { add: method(int()) } } },
//   });
export function remote<const D extends RemoteDef>(
	name: string,
	def: D & { readonly host: PlacementFor<Static<D["input"]>> },
): RemoteContract<D> {
	checkHeader(name, def.version);
	// 泛型 def 在编译期一定有 host，但 JS 调用方可能省略，所以这里按“可能是 undefined”处理。
	const placement = def.host as Placement | undefined;
	// 运行时重新校验放置形状：不能只依赖 TypeScript；非法 host 会成为跨链路的错误路由。
	if (placement === undefined || !isValid(PlacementSchema, placement))
		throw new TypeError(`remote contract ${name} needs \`host\`: hostNamed(…) or hostFamily(…)`);
	// A JSON copy: the description travels, and a placement object may carry nothing else.
	// 只复制已知字段，丢弃调用方在 host 对象上附带的额外属性，保证描述是纯 JSON 且指纹稳定。
	const host: Placement =
		"name" in placement ? { name: placement.name } : { prefix: placement.prefix, key: placement.key };
	// 外层键是变体名，内层键是成员名；值统一为 MemberDescription。
	const variants: Record<string, Record<string, MemberDescription>> = {};
	// 没有变体的远程类型无法描述对象形状，直接拒绝。
	if (Object.keys(def.variants).length === 0) throw new TypeError(`remote contract ${name} has no variants`);
	// Object.entries 同时拿到键和值；元组解构 [kind, variant] 的 kind 是变体名字符串。
	for (const [kind, variant] of Object.entries(def.variants)) {
		const members: Record<string, MemberDescription> = {};
		// state 字段可选，?? {} 让缺省时得到空对象，Object.entries 不会报错。
		for (const [key, schema] of Object.entries(variant.state ?? {}))
			members[key] = describeMember(key, schema, "remote");
		for (const [key, spec] of Object.entries(variant.methods ?? {})) {
			// 先登记 state 再登记 methods，所以这里能发现同名冲突；in 运算符检查键是否存在。
			if (key in members) throw new TypeError(`member ${key} is both state and method in ${name}.${kind}`);
			members[key] = describeMember(key, spec, "remote");
			// methods 表中的值若不是 method()，describeMember 会把它当状态 schema；这里显式拒绝，避免静默误声明。
			if (members[key].kind !== "method") throw new TypeError(`methods.${key} is not a method()`);
		}
		variants[kind] = members;
	}
	// description 是唯一跨链路传输的部分：不含 def，也不含函数或 Symbol。
	const description: Description = { name, scope: "remote", version: def.version, input: def.input, host, variants };
	return finish<RemoteContract<D>>({
		scope: "remote",
		name,
		version: def.version,
		input: def.input,
		def,
		description,
	});
}

// 创建本地契约：没有 host，也没有变体；所有成员放在 LOCAL_VARIANT（空字符串）下。
// 输入：name 与 LocalDef（version/input/members）。输出：LocalContract<D>。
// 错误：名字/版本非法或成员名保留时抛 TypeError。副作用：无 I/O。
// 示例：
//   const Clock = local("demo.clock", {
//     version: 1, input: obj({}), members: { now: method(undefined, int()) },
//   });
export function local<const D extends LocalDef>(name: string, def: D): LocalContract<D> {
	checkHeader(name, def.version);
	const members: Record<string, MemberDescription> = {};
	// members 可省略；每个成员按 method/opaque/state 三分支描述。
	for (const [key, member] of Object.entries(def.members ?? {})) members[key] = describeMember(key, member, "local");
	const description: Description = {
		name,
		scope: "local",
		version: def.version,
		input: def.input,
		// 计算属性名 [LOCAL_VARIANT] 在运行时求值为 ""，得到 { "": members }。
		variants: { [LOCAL_VARIANT]: members },
	};
	return finish<LocalContract<D>>({ scope: "local", name, version: def.version, input: def.input, def, description });
}

/**
 * A consumer token received over a link (only its description travels). Has no `def`, so it is only good for binding
 * and validation, never for TypeScript types.
 */
// 从跨链路收到的 description 还原一个“消费者契约令牌”。
// 输入：description（通常已经过 DescriptionSchema 校验）。输出：AnyContract，含 description 和重新计算的指纹。
// 错误：顶层字段不合法、scope 与 host 不匹配时抛 ChordError("invalid", reason:"token")。
// 关键限制：令牌没有 def 的完整类型信息（远程 variants 置空、本地没有 members），只能用于绑定和描述校验，
// 不能拿它推导 TypeScript 类型，也不能据此调用方法。
// 主要流程：手动检查随后要读取的顶层字段 -> 以 description 重新计算指纹 -> 按 scope 构造最小 def。
export function contractFromDescription(description: Description): AnyContract {
	// 解构出顶层字段；variants 不取出，因为这里只构造令牌外壳。
	const { name, scope, version, input, host } = description;
	if (
		// 逐项运行时检查：name 是字符串、scope 是两个字面量之一、version 是整数。
		typeof name !== "string" ||
		(scope !== "remote" && scope !== "local") ||
		!Number.isInteger(version) ||
		// 远程必须有 host，本地必须没有：用“两个布尔值是否不同”表达异或（XOR）。
		(scope === "remote") !== (host !== undefined)
	) {
		throw new ChordError("invalid", "malformed contract token", { reason: "token" });
	}
	// 指纹只依赖 description，所以收到方可以独立重算，无需信任发送方的 fingerprint 字段。
	const base = { name, version, input, description, fingerprint: hash64(canonicalJson(description)) };
	// host! 非空断言：上面的 XOR 检查已经保证远程分支的 host 存在，但 TS 无法跨条件推断。
	return scope === "remote"
		? { ...base, scope, def: { version, input, host: host!, variants: {} } }
		: { ...base, scope, def: { version, input } };
}

/** Returns why `provider` does not cover `consumer`, or undefined when it does. */
// 检查提供方是否覆盖消费者期望；覆盖时返回 undefined，否则返回简短原因字符串。
// 输入：provider 是实际实现的描述，consumer 是调用方持有的（可能是旧版本）描述。
// 方向很重要：消费者能发送的输入必须被提供方接受；提供方返回的结果必须满足消费者的期望。
// 运行时只比较描述数据，不调用方法、不编译 schema；fits 是保守的结构子类型判断。
// 示例：coverage(providerDesc, consumerDesc) 返回 "editor.add arguments" 表示方法参数不兼容。
export function coverage(provider: Description, consumer: Description): string | undefined {
	// 名字或作用域不同就不是同一个类型；版本相同才会走到 coverage。
	if (provider.name !== consumer.name || provider.scope !== consumer.scope) return "different type";
	// 放置方式必须一致：对象换了宿主，对消费者来说就是另一个类型。
	if (!samePlacement(provider, consumer)) return "host";
	// 消费者可能发送的输入集合必须是提供方接受集合的子集，因此 fits(consumer.input, provider.input)。
	if (!fits(consumer.input, provider.input)) return "input";
	// 只遍历消费者需要的变体和成员；提供方多出来的变体/成员不影响兼容性。
	for (const [kind, consumerMembers] of Object.entries(consumer.variants)) {
		const providerMembers = provider.variants[kind];
		if (providerMembers === undefined) return `variant ${kind} missing`;
		for (const [name, wanted] of Object.entries(consumerMembers)) {
			const offered = providerMembers[name];
			// 成员必须存在且种类完全相同：方法不能替代状态，状态也不能替代方法。
			if (offered === undefined || offered.kind !== wanted.kind) return `${kind}.${name} missing or of another kind`;
			if (offered.kind === "method" && wanted.kind === "method") {
				// Both take arguments or neither does; a consumer that expects no result accepts any.
				// 参数“有无”必须一致：消费者不发参数而提供方要求参数，或反之，都无法调用。
				if ((wanted.args === undefined) !== (offered.args === undefined)) return `${kind}.${name} arguments`;
				// 消费者发送的参数值必须落在提供方参数 schema 内：fits(wanted.args, offered.args)。
				if (wanted.args !== undefined && offered.args !== undefined && !fits(wanted.args, offered.args))
					return `${kind}.${name} arguments`;
				// 消费者不关心结果时可以接受任意结果；一旦声明了结果，提供方必须返回值且值满足消费者 schema。
				if (wanted.result !== undefined && (offered.result === undefined || !fits(offered.result, wanted.result)))
					return `${kind}.${name} result`;
			} else if (offered.kind === "state" && wanted.kind === "state") {
				// 状态方向：提供方实际提供的值必须满足消费者的读取期望。
				if (!fits(offered.schema, wanted.schema)) return `${kind}.${name} state`;
			} else if (offered.kind === "opaque" && wanted.kind === "opaque" && offered.id !== wanted.id) {
				// 不透明值按 name@version 字符串精确比较，无法做结构适配。
				return `${kind}.${name} opaque ${offered.id} != ${wanted.id}`;
			}
		}
	}
	// 所有消费者需要的部分都被覆盖。
	return undefined;
}

// 比较两个描述的放置方式：把 host（本地为 undefined）转成规范 JSON 的 null 再比较。
// 对象键排序由 canonicalJson 保证，因此 { name } 与 { name } 的不同对象字面量也视为相等。
const samePlacement = (a: Description, b: Description): boolean =>
	canonicalJson(a.host ?? null) === canonicalJson(b.host ?? null);
// 生成放置方式的可读文字，用于 contract_mismatch 消息；本地契约显示 "(local)"。
const placementOf = (description: Description): string =>
	description.host === undefined ? "(local)" : placementText(description.host);

/** Maps the provider's current implementation to the view a consumer of an older contract version expects. */
// Adapter 把提供方当前实现（当前成员值的普通对象）转换成旧消费者期望的视图。
// 参数/返回值都是 Record<string, unknown>，因为不同版本的字段形状由应用自己决定；本文件不调用或校验它。
export type Adapter = (current: Record<string, unknown>) => Record<string, unknown>;
// accepts 以“消费者版本号”为键；Record<number, Adapter> 在运行时仍是普通对象，数字键会被转成字符串键。
export type Accepts = Readonly<Record<number, Adapter>>;

/** How a consumer token binds to a provider: directly or through an `accepts` adapter. Throws contract_mismatch. */
// 把消费者令牌绑定到提供方契约。
// 输入：provider 是实际实现契约；accepts 是可选的跨版本适配表；consumer 是调用方令牌。
// 输出：同指纹/同版本兼容时返回 undefined；跨版本且找到适配器时返回该 Adapter。
// 错误：放置方式不同、同版本但覆盖失败、跨版本却没有对应适配器，抛 ChordError("contract_mismatch")。
// 主要流程：指纹相同直接绑定 -> 放置检查 -> 同版本走 coverage -> 不同版本查 accepts[consumer.version]。
// 示例：bind(v2, { 1: (current) => ({ view: current.body }) }, v1) 返回 v1 的适配函数。
export function bind(provider: AnyContract, accepts: Accepts | undefined, consumer: AnyContract): Adapter | undefined {
	// 描述完全相同时指纹相同，无需任何适配，直接返回 undefined 表示直接绑定。
	if (provider.fingerprint === consumer.fingerprint) return undefined;
	// A moved type is another type for its consumers: no adapter reaches across hosts.
	// 宿主位置不同属于身份变化，不能通过 accepts 适配；适配器只处理同一宿主上的成员形状变化。
	if (!samePlacement(provider.description, consumer.description)) {
		throw new ChordError(
			"contract_mismatch",
			`${provider.name} lives on ${placementOf(provider.description)}, the consumer expects ${placementOf(consumer.description)}`,
		);
	}
	if (provider.version === consumer.version) {
		// 同版本没有适配器可用：必须是结构上完全覆盖，否则说明提供方改了形状却忘了升版本。
		const reason = coverage(provider.description, consumer.description);
		if (reason === undefined) return undefined;
		throw new ChordError(
			"contract_mismatch",
			`${provider.name}@${provider.version} does not cover the consumer's description (${reason}); forgotten version bump?`,
		);
	}
	// 版本不同：accepts 按消费者版本索引；可选链在 accepts 为 undefined 时得到 undefined。
	const adapter = accepts?.[consumer.version];
	if (adapter === undefined) {
		throw new ChordError(
			"contract_mismatch",
			`${provider.name}: provider version ${provider.version}, consumer version ${consumer.version}, no accepts adapter`,
		);
	}
	// 只选择适配器，不在绑定阶段执行它；真正转换发生在消费者取得实现视图时（object.ts 的 viewOf）。
	return adapter;
}

// ─── Static types ────────────────────────────────────────────────────────────

// 本节全部是类型层工具：编译成 JS 后会被擦除，不产生运行时代码，也不校验运行时值。
// 输入通常是 `typeof Contract`（契约对象的类型），输出是服务端实现或客户端引用的类型。

// 空对象类型，用作“该变体没有 state/methods”时的中性元素。
type Empty = Record<never, never>;
// 条件类型：如果变体 V 有 state 字段，用 infer S 推断并取出其类型（约束为“成员名 -> Schema”的 Record）；
// 没有 state 时返回 Empty。infer ... extends ... 在一条语句里完成推断与约束。
type StateOf<V> = V extends { readonly state: infer S extends Readonly<Record<string, Schema>> } ? S : Empty;
// 把 Schema 类型转换成它的静态值类型；S 不是 Schema 时给出 never。
type StaticOf<S> = S extends Schema ? Static<S> : never;
// 同理取出 methods 字段的类型；没有 methods 时返回 Empty，后续映射类型不会产生键。
type MethodsOf<V> = V extends { readonly methods: infer M extends Readonly<Record<string, MethodSpec>> } ? M : Empty;

/** What a handler returns: the result's value, or nothing for a void method. */
// 方法处理函数的返回类型：有 result schema 时是值或它的 Promise；无结果时是 void 或 Promise<void>。
// [R] extends [Schema] 把类型包进单元素元组再判断，避免条件类型对联合类型逐项分发（分布式条件类型）。
type Returned<R> = [R] extends [Schema] ? Static<R> | Promise<Static<R>> : void | Promise<void>;
/** What a call resolves to. */
// 引用调用最终解析出的值：有结果 schema 得到 Static<R>；void 方法得到 undefined。
type Resolved<R> = [R] extends [Schema] ? Static<R> : undefined;

/** A method's handler; `P` is the app's principal type (`ctx.principal`). */
// 从 MethodSpec 推导实现签名：
// - M extends MethodSpec<infer A, infer R> 同时推断参数 schema A 和结果 schema R；
// - [A] extends [Schema] 判断是否有参数；有则 (args, ctx)，无则只接收 ctx；
// - ctx 的类型是 Ctx<P>，实现方可以直接读取 ctx.principal。
export type MethodImplementation<M, P = unknown> = M extends MethodSpec<infer A, infer R>
	? [A] extends [Schema]
		? (args: Static<A>, ctx: Ctx<P>) => Returned<R>
		: (ctx: Ctx<P>) => Returned<R>
	: never;
// 从 MethodSpec 推导引用上的调用签名：参数 schema 决定是否要传 args；ctx 可选；返回值总是 Promise。
// 与实现签名不同，调用方不需要一定提供 ctx（运行时由宿主注入）。
export type Call<M> = M extends MethodSpec<infer A, infer R>
	? [A] extends [Schema]
		? (args: Static<A>, ctx?: Ctx) => Promise<Resolved<R>>
		: (ctx?: Ctx) => Promise<Resolved<R>>
	: never;

/** Whether `contract`'s method `name` takes no arguments (it is called as `ref.name(ctx)`). */
// 判断契约中名为 name 的方法是否无参数。无参数方法在引用上调用形式是 ref.name(ctx)。
// 实现取第一个包含该成员且为方法的变体；若同名方法在不同变体里参数形态不同，这里不会继续核对。
// 找不到方法时返回 false（调用签名会按“有参数”处理）。
export function takesNoArgs(contract: AnyContract, name: string): boolean {
	// Object.values 取所有变体的成员表；本地契约只有一个空字符串变体。
	for (const members of Object.values(contract.description.variants)) {
		const member = members[name];
		// member?.kind 可选链兼容成员不存在；只有方法才有 args 字段。
		if (member?.kind === "method") return member.args === undefined;
	}
	return false;
}

// 一个远程变体的“实现”形状：变体标签 + 所有 state 成员为 StateSource + 所有 methods 为方法实现。
// 三个部分用 & 交叉；映射类型 keyof StateOf<V> 在 Empty 时没有键，交叉后不会增加成员。
type VariantImplementation<K, V, P> = { readonly variant: K } & {
	// S 遍历状态成员名；StateOf<V>[S] 是对应 schema，StaticOf 取出值类型，再包成 StateSource。
	readonly [S in keyof StateOf<V>]: StateSource<StaticOf<StateOf<V>[S]>>;
} & {
	// M 遍历方法名；MethodsOf<V>[M] 是对应 MethodSpec，MethodImplementation 转成处理函数类型。
	readonly [M in keyof MethodsOf<V>]: MethodImplementation<MethodsOf<V>[M], P>;
};
/**
 * A reference in one variant: its state members are plain readables (a reference you hold has its state) and its
 * methods calls. `variant` discriminates the union `Ref` is for a multi-variant type.
 */
// 远程引用在某个变体下的类型：公共引用外壳 RefBase + 判别标签 variant + 状态成员（只读 Readable）+ 方法成员（Call）。
// 与实现不同：状态只能读，方法只能调用；variant 让多变体 Ref 成为可收窄的判别联合。
type VariantRef<C extends AnyContract, K, V> = RefBase<C> & { readonly variant: K } & {
	readonly [S in keyof StateOf<V>]: Readable<StaticOf<StateOf<V>[S]>>;
} & {
	readonly [M in keyof MethodsOf<V>]: Call<MethodsOf<V>[M]>;
};

// 本地实现成员：三路条件类型。
// - MethodSpec -> 方法实现签名；
// - OpaqueSpec<infer T> -> 允许直接给原生值 T，或给一个 Exposed<T> 资源包装；
// - Schema -> 状态源 StateSource；
// - 其它 -> never（正常情况下不会出现）。
type LocalImplementationMember<M, P> = M extends MethodSpec
	? MethodImplementation<M, P>
	: M extends OpaqueSpec<infer T>
		? T | Exposed<T>
		: M extends Schema
			? StateSource<Static<M>>
			: never;
// 本地引用成员：方法变成 Call；不透明值读取为 T | undefined；状态 schema 变成 Readable。
type LocalRefMember<M> = M extends MethodSpec
	? Call<M>
	: M extends OpaqueSpec<infer T>
		? T | undefined
		: M extends Schema
			? Readable<Static<M>>
			: never;
// 取出本地定义 D 的 members 类型；没有声明 members 时用 Empty。
type LocalMembers<D> = D extends { readonly members: infer M extends Readonly<Record<string, LocalMember>> }
	? M
	: Empty;

// 从契约 C 的 def.input schema 推导输入值类型；Static<I> 是 schema 的静态值类型。
export type InputOf<C> = C extends { readonly def: { readonly input: infer I extends Schema } } ? Static<I> : never;

/** What a factory returns for contract C; its methods' `ctx.principal` is `P`. */
// 从契约推导服务端工厂应返回的“实现”类型。
// 远程契约：对每个变体生成 VariantImplementation，再用 [keyof D["variants"]] 做索引访问，
//   把各变体实现合并成一个联合；工厂只需返回其中一个变体。
// 本地契约：对所有 members 生成实现成员，再与 Record<string, unknown> 交叉，允许实现额外挂字段。
// 其它情况 never。P 是 ctx.principal 的类型。
export type ImplementationOf<C, P = unknown> = C extends RemoteContract<infer D>
	? { [K in keyof D["variants"]]: VariantImplementation<K, D["variants"][K], P> }[keyof D["variants"]]
	: C extends LocalContract<infer D>
		? { readonly [K in keyof LocalMembers<D>]: LocalImplementationMember<LocalMembers<D>[K], P> } & Record<
				string,
				unknown
			>
		: never;

/**
 * What `get` returns for contract C. A remote type's reference is a union discriminated by `variant`: another variant's
 * members are reachable only after narrowing (`if (ref.variant === "editor") ref.add(…)`). A local type's reference has
 * its members.
 */
// 从契约推导 ctx.get() 返回的引用类型。
// 远程契约：按变体生成 VariantRef，再索引访问得到判别联合；访问其它变体的成员前必须先按 ref.variant 收窄。
// 本地契约：RefBase 加所有成员；不透明值可能尚未就绪，所以读取类型是 T | undefined。
// 默认类型参数 AnyContract 允许只写 Ref 而不指定具体契约。
export type Ref<C extends AnyContract = AnyContract> = C extends RemoteContract<infer D>
	? { [K in keyof D["variants"]]: VariantRef<C, K, D["variants"][K]> }[keyof D["variants"]]
	: C extends LocalContract<infer D>
		? RefBase<C> & { readonly [K in keyof LocalMembers<D>]: LocalRefMember<LocalMembers<D>[K]> }
		: never;
