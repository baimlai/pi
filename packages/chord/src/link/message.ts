// Messages (§22, R1, R4, 2b): the one `Message` type every link carries, defined as a schema and checked after every
// decode, and the codecs that turn it into bytes.

// 文件导读
// 所属模块：packages/chord/src/link（Chord v2 链路层）的协议消息定义。链路层负责在 host 之间搬运字节；
// 本文件规定这些字节解码后必须长什么样，是编解码器、Channel 与 host/remote 层共用的词汇表。
// 职责与边界：只定义“信封”（kind、编号、origin、错误外壳、Part 外壳），不解析 Part 内容，不执行流控/握手，
// 不决定消息业务含义。params/args/value 等字段刻意是 unknown，解析权归持有契约的 owner。
// 上游入口：binary.ts 的 decode、text.ts 的 fromTuple 产出普通对象，Channel 随即调用 checkMessage。
// 下游依赖：@earendil-works/pi-schema 提供 schema 与验证器；data/internal.ts 的 validatorFor 编译并缓存；
// host/remote 层按 Message 的 kind 收窄后处理。
// 结果与错误流向：checkMessage 成功返回同一对象；不符合 schema 时抛 Error，Channel 将其视为协议错误并关闭链路。
// 能力清单：
// - Message：所有协议消息的可辨识联合类型。
// - WireError：跨链路的 ChordError JSON 或插件错误。
// - OriginMessage：可携带中继 origin 的消息子集。
// - ProviderMessage / ConsumerMessage：provider/consumer 各自方向的消息子集。
// - BoundEntry / StateEntry / FailedMember / WireAddress：bound、state、address 等复合字段的元素类型。
// - Codec：encode/decode 接口，binaryCodec 与 textCodec 实现它。
// - CHAIN / RETRY_HOPS / CAUSE_KINDS / NO_RETIRED：协议上限、重试预算、失败原因与空退役列表常量。
// - checkMessage：解码后的运行时信封校验，并计入 chord.link.checks。
// 典型调用顺序：codec.decode(bytes) -> checkMessage(message, context) -> Channel 按 kind 分发 -> owner 用 openPart 打开 Part。
// 示例：checkMessage({ kind: "ping" }, context) 返回 { kind: "ping" }；
//       checkMessage({ kind: "hold", hold: -1, ... }, context) 抛错，因为 hold 的 schema 要求非负整数。
// 建议阅读顺序：先看 MESSAGE union 了解全部消息，再看 CHAIN/CAUSE_KINDS 等常量与 type 推导，最后看 Codec 与 checkMessage。

import { obj as openObj, type Schema } from "@earendil-works/pi-schema";
import type { Context } from "../context/index.ts";
import { arr, int, lit, obj, oneOf, opt, type Static, str, union, unknown } from "../contracts/index.ts";
import { validatorFor } from "../data/internal.ts";
import type { Part } from "./part.ts";

/** A link-local id, chosen by its origin: a counter, unique per link, direction and origin while in use. */
// 链路本地编号：hold/call 等条目的编号由发起方（origin）分配，在“链路 + 方向 + origin”范围内唯一。
// int({min:0}) 表示运行时必须是非负整数；这不是普通 TypeScript 注解，而是会进入 schema 的约束。
const id = int({ min: 0 });

/**
 * Whose work a message is (decision "Relay flow control per origin"): a relay's number for one downstream link (and
 * the origin that link's messages carried), never reused on a link; absent for the sender's own work. Holds, calls,
 * windows and acks are keyed by (origin, id), and replies carry the origin of what they answer.
 */
// 中继编号：1 起，由转发方为自己的下游链路分配，永不复用；回复消息携带被回复内容所属的 origin。
// 没有 origin 字段表示这是发送方自己的直接工作。
const origin = int({ min: 1 });

/** A name as an index into the hold's bound version (each variant's names sorted). */
// 成员/方法名在“已绑定版本”中按名字排序后的下标；用整数而不是字符串传输，减少线上体积。
// 下标只表示位置，真正名字由持有版本元数据的 host 还原。
const index = int({ min: 0 });

/** An error that may come from plugin code: a ChordError's JSON (checked by L1), or a plugin's code and message. */
// 线上错误有两种形状，用 kind 做可辨识联合：
// - chord：完整 ChordError JSON，其内部结构由 data 层（L1）再校验；
// - plugin：插件错误的 code/message，details 可选且内容任意。
// union([...]) 生成一个“满足任一分支”的 schema；TS 侧 Static 得到对应的联合类型。
const wireError = union([
	// lit("chord") 是字面量类型/校验：kind 必须恰好等于 "chord"；error 留给 data 层验证。
	obj({ kind: lit("chord"), error: unknown() }),
	// 插件错误必须带字符串 code/message；opt(unknown()) 表示 details 可缺失、存在时不做形状检查。
	obj({ kind: lit("plugin"), code: str(), message: str(), details: opt(unknown()) }),
]);

/** The members of a hold that failed with this message (W1). */
// 一次 bound/state 消息里“哪些成员失败了”的列表。arr(...) 在运行时验证数组每项形状，
// member 是成员下标，error 复用上面的线上错误联合。TS 会推导出 { member: number; error: ... }[]。
const failed = arr(obj({ member: index, error: wireError }));

/** A part's envelope: the codec built it, so any value passes (its content is the owner's to parse). */
// 载荷外壳：编解码器负责构造（JSON 文本、字节或压缩对象），所以这里接受任意值。
// `as Schema<Part>` 是类型断言，把 unknown 的 schema 标成 Part，运行时没有额外校验；
// 真正的解析（JSON.parse、解码、大小限制）发生在接收方 owner 调用 parsePart/openPart 时。
const part = unknown() as Schema<Part>;

/**
 * The byte segments of a payload part whose method's schema has a `bytes()` leaf, referenced from its JSON by
 * `{"$bytes": i}`; absent for every other payload. Built by the codec, like the part.
 */
// 与 part 同理：数组内容由编解码器构造，schema 只检查“可选”这一层；
// readonly 只影响 TS 使用方式，运行时仍是普通数组。segments 用于 bytes() 叶子节点，JSON 中用 {"$bytes": i} 引用。
const segments = opt(unknown() as Schema<readonly Uint8Array[]>);

/** An address as a hold names it: its host kind and params, checked against the kind where it is routed. */
// hold 携带的目标地址：host 种类名 + 参数。params 在这里不检查，路由到对应 host kind 后
// 才用该 kind 的 schema 验证；kind 与 params 的对应关系无法由这个通用 schema 表达。
const address = obj({ kind: str(), params: unknown() });

/** A principal on a hold: JSON with a `kind`, honoured only on a parent link. */
// 调用主体：至少含字符串 kind，open:true 允许任意附加字段（例如身份键）。
// schema 只保证“有 kind”，是否接受该 principal 由父链路（可信侧）决定；普通/中继链路上即使出现也不被信任。
const principal = openObj({ kind: str() }, { open: true });

/** A uuidv7 as text. */
// incarnation 是 host 实例的 uuidv7 文本；pattern 是运行时正则约束，防止任意字符串混入。
// 形式不符会作为协议错误在解码后的信封检查中失败。
const incarnation = str({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });

/** The longest activation chain a hold carries (Q5): a longer one keeps its last entries. */
// 激活链最多记录 32 个实例 id；超过时保留最近的条目，避免跨 host 循环链无限增长。
// 这里导出给 binary/text 编解码器共同使用，保证两端上限一致。
export const CHAIN = 32;

/** A `retry`'s hop budget as the first host sends it (dependency model §3.7, audit A5): one less per host after it. */
// retry 的初始跳数预算；每经过一个 host 减一且不能减到 0，从而让“互相等待的环路”最终停止。
// 16 同时是 schema 的 max，超过会被信封检查拒绝。
export const RETRY_HOPS = 16;

/** The kinds of a `failed` message's cause, in their codes' order (the binary codec's byte, the text codec's letter). */
// 失败原因的三个取值，顺序即线码顺序：二进制用下标当字节，文本编码用对应字母；
// 显式元组类型 ["transient","broken","waiting"] 让 TS 知道长度恰好为 3、元素是字面量。
// oneOf(...CAUSE_KINDS) 会把这三个字面量展开成运行时枚举校验。
export const CAUSE_KINDS: ["transient", "broken", "waiting"] = ["transient", "broken", "waiting"];

/** The protocol's messages, one tagged union. Parts are opaque here (the owners parse them). */
// 协议消息总表：每个分支都有字面量 kind，解码后可用 switch(kind) 收窄成具体类型。
// 这里只描述“信封”；args/value 等 Part 仍是 unknown，由拿到消息的 owner 解析。
const MESSAGE = union([
	// `calls`: how many concurrent calls this side accepts (the call window).
	// hello 是链路握手第一帧：protocol 版本、本端 incarnation、本端允许的并发调用窗口 calls（至少 1）。
	// 所有字段都有运行时校验；origin 不允许出现在 hello 上。
	obj({ kind: lit("hello"), protocol: int({ min: 0 }), incarnation, calls: int({ min: 1 }) }),
	// hold 请求为某个对象建立绑定。origin 可选：经中继转发时存在，表示该转发方编号。
	// 必填字段描述契约类型名、版本、指纹、参数、目标地址；可选字段分别描述主体、实例、激活链、大小上限。
	obj({
		kind: lit("hold"),
		origin: opt(origin),
		hold: id,
		type: str(),
		version: int({ min: 1 }),
		fingerprint: str({ pattern: "^[0-9a-f]{16}$" }),
		params: part,
		// The address the caller computed with the type's `hostAddress`: it routes the hold.
		// 路由地址由调用方按契约的 hostAddress 算出；host 用它决定本地提供者还是继续转发。
		address,
		// Whom the hold acts for and the origin's incarnation; read only on a parent link.
		// 主体与 origin 实例只允许在父链路（可信边界）读取；普通链路上可能存在但被忽略。
		// opt(...) 让字段可缺省，Static 类型会加上 `| undefined`。
		principal: opt(principal),
		incarnation: opt(incarnation),
		// The instance ids of the activations waiting for this hold (Q5); read only on a trusted link.
		// 激活链记录等待同一 hold 的实例，最多 CHAIN 项；只有可信链路才信任它，防止伪造环。
		chain: opt(arr(incarnation, { max: CHAIN })),
		// The decoded limit per part of the link the hold was admitted on (Q2); read only on a parent link.
		// limit 是该 hold 被接纳链路的“解码后单 part 上限”；同样只从父链路读取。
		limit: opt(int({ min: 0 })),
	}),
	// release 撤销一个 hold 编号；origin 表明它属于哪段转发。
	obj({ kind: lit("release"), origin: opt(origin), hold: id }),
	// call 在已绑定的 hold 上调用方法：call 是调用编号（用于 result/error/abort 配对），
	// method 是版本内方法名排序后的下标；args 可缺省表示无参数方法，否则是一个 Part。
	obj({ kind: lit("call"), origin: opt(origin), call: id, hold: id, method: index, args: opt(part), segments }),
	// abort 请求取消尚未完成的调用；只需 call 编号，不携带原因。
	obj({ kind: lit("abort"), origin: opt(origin), call: id }),
	// Asks the provider for an attempt of a failed hold's object now (`ref.retry()`); `hops` is its budget: the host
	// there passes it on to its remote dependencies with one less, never at 0, so a waiting ring of hosts stops. Relays
	// forward it as it is.
	// retry 让 provider 立刻为失败的 hold 重试一次；hops 是剩余预算，范围 1..RETRY_HOPS，
	// 收到方转发给远端依赖时减一且不会传 0，因此环路会在有限步后停止。
	obj({ kind: lit("retry"), origin: opt(origin), hold: id, hops: int({ min: 1, max: RETRY_HOPS }) }),
	// Binds several holds at once (first bindings, re-holds), applied in one batch.
	// bound 是 provider 的批量绑定结果：每个 hold 给出 variant 下标、成员值（Part）和失败成员列表。
	// 批量交付让一次重绑定只占一个流控窗口名额；失败成员仍可随成功成员一起返回。
	obj({
		kind: lit("bound"),
		origin: opt(origin),
		holds: arr(obj({ hold: id, variant: index, members: arr(obj({ member: index, value: part })), failed })),
	}),
	// state 是绑定后的状态更新（每成员一串 ops 增量），与 bound 一样按批交付。
	obj({
		kind: lit("state"),
		origin: opt(origin),
		// `retired`: the members whose document was retired since the hold's last message (decision "One retirement
		// mechanism"); a `bound` snapshot carries no flag.
		// retired 只出现在 state：列出上次消息后被退役的成员下标；bound 是快照，没有这项。
		// members 的 ops 是 Part，由持有版本的 owner 解析成具体状态操作。
		holds: arr(obj({ hold: id, members: arr(obj({ member: index, ops: part })), failed, retired: arr(index) })),
	}),
	// One per applied `bound` or `state` message of its origin (the window).
	// ack 确认一个已应用的 bound/state，从而推进该 origin 的 ack 时钟窗口；没有编号字段，按到达顺序配对。
	obj({ kind: lit("ack"), origin: opt(origin) }),
	// A relay's downstream link closed: the origin's holds are released and its calls aborted.
	// closed 必须带 origin（中继本身没有 origin 就不能通知下游关闭）；接收方释放该 origin 的全部 hold 并 abort 调用。
	obj({ kind: lit("closed"), origin }),
	// A revocation from the parent, applied with this host's own `revokedBy` (no origin).
	// revoke 只能来自父链路（可信），携带撤销数据；它不参与中继编号，所以 origin 不允许出现。
	obj({ kind: lit("revoke"), revocation: unknown() }),
	// 心跳：ping 由一端定时发出，pong 立即回应；两者都不带字段，也不带 origin。
	obj({ kind: lit("ping") }),
	obj({ kind: lit("pong") }),
	// failed 通知该 hold 的绑定/调用失败；cause.kind 是三类原因之一，cause.error 是线上错误。
	obj({
		kind: lit("failed"),
		origin: opt(origin),
		hold: id,
		// A failure cause's error in the wire error format (a ChordError, checked by L1's envelope check, or a plugin's).
		// `waiting`: not the object's fault (no provider, no fitting version, a dependency failed); an event wakes it.
		// oneOf(...CAUSE_KINDS) 把元组展开成三个字面量的运行时枚举；error 仍复用 wireError 联合。
		cause: obj({ kind: oneOf(...CAUSE_KINDS), error: wireError }),
		// The rest of the object's backoff window in milliseconds: when it retries by itself (absent: broken, waiting).
		// retryIn 只对可自动重试的失败有意义：毫秒数表示退避剩余时间；broken/waiting 时不带。
		retryIn: opt(int({ min: 0 })),
	}),
	// The failed object of a hold started a new attempt.
	// loading 表示失败对象重新开始一次尝试；消费方据此把状态从 failed 切回加载中。
	obj({ kind: lit("loading"), origin: opt(origin), hold: id }),
	// result 返回调用成功值；value 缺省表示 null（与 args 缺省的约定对称），segments 供 bytes 叶子使用。
	obj({ kind: lit("result"), origin: opt(origin), call: id, value: opt(part), segments }),
	// error 返回调用失败；只需要 call 配对和线上错误。
	obj({ kind: lit("error"), origin: opt(origin), call: id, error: wireError }),
	// gone 表示对象已不存在（例如被退役/删除），携带原因错误；后续该 hold 不再有效。
	obj({ kind: lit("gone"), origin: opt(origin), hold: id, error: wireError }),
]);

/**
 * A protocol message. `args` absent: a method without arguments; `value` absent: `null`. A `state` entry's `retired`
 * list is read-only (the schema's type is mutable): entries without retirements share `NO_RETIRED`.
 */
export type Message =
	| Exclude<WireMessage, WireState>
	| (Omit<WireState, "holds"> & { readonly holds: readonly StateEntry[] });

// 上面这行把 schema 推导出的可变类型改造成对外类型：除 state 外原样保留；state 的 holds
// 用 Omit 去掉后重新声明为只读数组，元素换成只读版 StateEntry。
// Exclude / Extract / Omit 都是纯编译期工具类型，不会产生任何运行时代码。
type WireMessage = Static<typeof MESSAGE>;

// Static<typeof schema> 把 schema 的字面量结构转成值类型；WireState 再用 Extract 从联合中挑出 kind 为 "state" 的分支。
type WireState = Extract<WireMessage, { readonly kind: "state" }>;

/** An error as it crosses a link. */
// 线上错误联合类型：{kind:"chord",error:...} | {kind:"plugin",code,message,details?}。
// codec 与 Channel 只负责传输；解析成 ChordError/PluginError 由 errors.ts 的 errorFromWire 完成。
export type WireError = Static<typeof wireError>;

/** A message that may carry an origin (every kind but `hello`, `revoke`, `ping` and `pong`). */
// 可携带 origin 的消息集合。Exclude 的第二个参数是“kind 为这四种之一”的类型，
// TS 会把联合中所有匹配分支剔除；用于中继层统一处理带编号的消息。
export type OriginMessage = Exclude<Message, { readonly kind: "hello" | "revoke" | "ping" | "pong" }>;

/** A message for a provider side: the direction from the consumer (`closed` is the link's). */
// provider 一端（持有对象实现）会收到的消息：来自 consumer 的请求，以及链路自身的 closed。
// Extract 反过来只保留 kind 命中的分支；这是纯类型推导，不检查运行时的 kind。
export type ProviderMessage = Extract<
	Message,
	{ readonly kind: "hold" | "release" | "call" | "abort" | "retry" | "ack" }
>;

/** A message for a consumer side: the direction from the provider. */
// consumer 一端（调用方）会收到的消息：绑定结果、状态、失败与调用结果。
export type ConsumerMessage = Extract<
	Message,
	{ readonly kind: "bound" | "state" | "failed" | "loading" | "result" | "error" | "gone" }
>;

/** One hold's entry of a `bound` message. */
// 索引访问类型：先取出 bound 分支，再取 holds 数组，再取 [number] 得到元素类型。
// 因此 BoundEntry 始终与 schema 中的 holds 元素保持同步，无需手写第二份接口。
export type BoundEntry = Extract<Message, { readonly kind: "bound" }>["holds"][number];

/** One hold's entry of a `state` message. */
// 把 schema 推导出的 state 条目去掉 retired，再以只读数组重新加上；
// 交叉类型 & 合并两边字段，同时让这个类型与 Message 中的只读版本一致。
export type StateEntry = Omit<WireState["holds"][number], "retired"> & { readonly retired: readonly number[] };

/** The `retired` list of a state entry without retirements, shared (no allocation per message). */
// 空退列表的单例：没有退役成员的消息都引用同一个冻结语义的数组，避免每条消息分配 []。
// 这里只是普通数组常量，代码约定不修改它；readonly 是编译期保护。
export const NO_RETIRED: readonly number[] = [];

/** An address as a `hold` carries it. */
// hold 中 address 字段的静态类型：{ kind: string; params: unknown }。
export type WireAddress = Static<typeof address>;

/** A member of a hold that failed, by index, as `bound` and `state` list it. */
// failed 数组元素的静态类型：{ member: number; error: WireError }。
export type FailedMember = Static<typeof failed>[number];

/** How a link turns messages into bytes and back; both ends of a link use the same one. */
// 编解码器接口：name 用于协商/诊断，encode/decode 必须互逆。
// decode 只保证字节属于该格式；消息信封（字段/范围）随后由 Channel 调 checkMessage 验证。
// encode 的输入与 decode 的输出都是 Message；实现方（binary.ts/text.ts）负责处理 Part 和 origin。
export interface Codec {
	readonly name: string;
	encode(message: Message): Uint8Array;
	/** Throws on bytes that are no message of this codec (a protocol error); the envelope is checked afterwards. */
	decode(bytes: Uint8Array): Message;
}

// 包一层对象作为 validatorFor 的 WeakMap 键：schema 不能直接当键（它可能是原始结构），
// 这个包装对象身份稳定，编译一次后按引用命中缓存。
const MESSAGE_SCHEMA = { schema: MESSAGE };

/**
 * Checks a decoded message's envelope with the compiled schema (the wire is a trust boundary, after any codec): kinds,
 * ids and indexes, lists and error shapes; not the parts. Throws on a mismatch (a protocol error). Counted in
 * `chord.link.checks`.
 */
// 检查一个已解码值是否符合消息信封 schema；成功返回同一对象（不复制），失败抛普通 Error。
// 输入 message 声明为 unknown，因为来源是网络/编解码器的不可信输出；Context 提供遥测计数和验证器缓存。
// 例如 codec.decode 得到 {kind:"hold",hold:-1,...} 时校验失败并抛错（不会返回 false），Channel 会将其视为协议错误并关闭链路。
export function checkMessage(message: unknown, context: Context): Message {
	// 每次信封检查计一次数；?. 允许没有 metrics 的遥测实现。
	context.telemetry.metrics?.counter("chord.link.checks").add(1);
	// validatorFor 首次编译并弱缓存；check 只返回布尔值，不抛验证细节。
	if (!validatorFor(MESSAGE_SCHEMA, context).check(message)) throw new Error("message: fails the message schema");
	// The check above establishes the type.
	// 运行时检查已经通过，所以这里用 as 断言成 Message；assert 不改变值，也不做第二次校验。
	return message as Message;
}
