/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/old/wire.ts，Chord v1 的线协议声明与校验层（旧实现；不是 packages/chord/src 下的 v2）。
 *
 * 功能：把 host 与 host、host 与 client 之间传输的所有 JSON 帧集中声明成一份 @earendil-works/pi-schema schema；
 * 用同一个 schema 同时导出 TypeScript 的 Frame 类型和运行时 isFrame 校验，避免“类型写一套、校验写另一套”后漂移。
 * 协议总览（方向、id 归属、state 的 (hold, member) 寻址）就在下方英文注释中。
 *
 * 职责边界：
 * - 负责：定义帧字段与字面量、校验不可信的收到值、把异常编码成可传输错误、把线上错误还原为 ChordError。
 * - 不负责：建立连接、排队/流控、路由、帧的业务处理、契约 payload 校验、state ops 解码。这些分别在
 *   link.ts、connection.ts、host.ts/object.ts 和 delta 解码器中完成。
 * - 浏览器 client 与 host 使用同一套帧；但 invalidate/prepare/commit/abort/retire 只允许父 host 发给子 host，
 *   vote 只允许子 host 发给父 host，方向检查在 connection.ts，不在本文件的 schema 中表达。
 *
 * 上游入口 / 下游依赖：
 * - 上游：link.ts 把收到的原始值交给 connection.ts 的 #receive；后者调用本文件 isFrame 后才当作 Frame 分派。
 *   发送侧 connection.ts、cluster.ts、remote.ts 构造 Frame 并调用 toWireError 编码错误。
 * - 下游：@earendil-works/pi-schema 的构建器与 Static（类型推导）；contract.ts 的 DescriptionSchema（hold token）；
 *   errors.ts 的 CHORD_ERROR_CODES 与 ChordError。
 * - 信任边界：isFrame 是“unknown 原始输入 → Frame”的唯一完整帧校验入口；FrameSchema 中 hold.input、call.args、
 *   state.value/ops 等 payload 故意保留为 unknown，留到使用处按契约或 delta 解码器再校验。Open 允许未知字段，
 *   使新旧 peer 可以互相追加字段而不被拒绝。
 *
 * 能力清单（导出项）：
 * - `PROTOCOL_VERSION`：hello 交换的链路协议版本，当前为 4；版本不同即关闭链路。
 * - `RootRef`：远程 root 的身份（rootId + codeVersion），用于 call/root_end 的租约与版本归属。
 * - `WireError` / `toWireError` / `fromWireError`：线上错误形状与双向转换。
 * - `WireReloadOptions` / `WireReloadReport`：集群重载帧携带的选项与子 host 投票报告。
 * - `Frame` / `isFrame`：所有帧的联合类型与运行时类型谓词。
 * 文件内声明：Id/Name/Reload 基元，List/Open 两个 schema helper，各帧 schema，FrameSchema 联合。
 *
 * 典型调用（示例；不是本文件运行时行为）：
 *   const raw: unknown = JSON.parse(text);
 *   if (!isFrame(raw)) throw new Error("protocol violation");
 *   if (raw.t === "call") {
 *     // raw 已收窄到 call 分支；raw.args 仍是 unknown，需按契约校验
 *   }
 *   const wire = toWireError(new ChordError("invalid", "bad input", { reason: "args" }));
 *   // wire = { code: "invalid", message: "invalid/args: bad input", reason: "args" }
 *   const local = fromWireError(wire); // local.message === "bad input"
 *
 * 建议阅读顺序：先读协议总览和三个基元/两个 helper，再按方向读 hello 与请求/响应帧，随后读 state 与集群重载帧；
 * 最后看 Frame/isFrame 和错误转换。新增帧时，除本文件外还必须让 connection.ts 的 #dispatch 处理对应 t。
 */
// pi-schema 构建器：arr/bool/int/lit/map/num/obj/oneOf/opt/str/union/unknown 生成运行时 schema；
// compile 生成校验函数；Properties/Schema/Static 是类型工具（Properties 约束对象字段，Static 从 schema 推导值类型）。
import {
	arr,
	bool,
	compile,
	int,
	lit,
	map,
	num,
	obj,
	oneOf,
	opt,
	type Properties,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
// 契约描述 token 已由 contract.ts 定义；wire.ts 直接复用，避免在线上格式里重复声明一份契约结构。
import { DescriptionSchema } from "./contract.ts";
// CHORD_ERROR_CODES 是允许跨链路的错误码白名单；ChordError 是本地错误类，本文件负责它与 WireError 的互转。
import { CHORD_ERROR_CODES, ChordError } from "./errors.ts";

// 下面的英文注释是协议总览：请求/响应帧各有固定方向，hello/ping/pong/bye/root_end/ack 双向；创建 hold/call/
// subscription 的一方选择 id，因此不同方向的同号 id 不会冲突；state 以 (hold id, member) 寻址，按 shape + 快照单元发送。
// JSON frames between two hosts (or a host and a client). Ids are chosen by the side that creates the hold, call or
// subscription; every frame type has one direction, so ids never collide:
//   consumer → provider: hold, release, call, cancel, sub, unsub, resync
//   provider → consumer: shape, gone, result, state
// State is addressed by (hold id, member): a hold implies the state of its variant, sent as units (a shape followed by
// a snapshot of each member the consumer lacks; see Connection).
//   both: hello, ping, pong, bye, root_end, ack; parent → child: invalidate, prepare, commit, abort, retire;
//   child → parent: vote
//
// Each frame is declared once, as the schema every received frame is checked against (`isFrame`); the types are derived
// from it. Payloads (hold inputs, call args, results, snapshots) stay `unknown`: they are validated where they are
// used, against the contract. State ops are checked op by op by the delta decoder.

/**
 * The link protocol version, announced in `hello`. Peers of different versions do not talk: the side that notices
 * closes the link with reason `protocol-version <its version>`, so the other side learns it too
 * (`LinkOptions.onProtocolMismatch`).
 */
// 协议版本只在 hello 中交换一次。接收方发现版本不同会关闭链路并附上自己的版本；
// 具体比较与回调在 connection.ts 的 #onHello/#protocolMismatch，本文件只声明字段。
export const PROTOCOL_VERSION = 4;

// Id/Name/Reload 是复用基元：Id 是正整数，由创建 hold/call/sub 的一方分配；
// Name 是非空名字（host、member、root 等）；Reload 是正整数集群事务 id。
const Id = int({ minimum: 1 });
// 名字不能为空串：空名字无法用于路由或 children 报告键。
const Name = str({ minLength: 1 });
// 集群重载事务 id 必须为正；同一事务的 prepare/vote/commit/abort 共用它。
const Reload = int({ minimum: 1 });
/** Arrays a sender may pass as readonly: the same schema, a readonly type. */
// List 把 item schema 包装成只读数组的 schema：`as Schema<readonly T[]>` 只改变编译期类型，
// 运行时仍由 arr(item) 逐项校验，也不会冻结数组。发送方因此可以传 readonly 数组。
const List = <T>(item: Schema<T>) => arr(item) as Schema<readonly T[]>;
/** An object that admits fields it does not name (a newer peer's), as every frame does. */
// Open 让对象 schema 接受未声明字段（open: true），用于跨版本兼容。`const P` 是 const type parameter：
// 保留调用处对象字面量的键和字面量类型，使 obj() 能推导出精确的属性形状。
const Open = <const P extends Properties>(properties: P) => obj(properties, { open: true });

// RootRef 标识一次跨 host 的 root：rootId 用于关联同一棵调用树，codeVersion 标明 root 启动时的代码版本，
// 供接收方做版本准入与 root_end 租约清理。
const RootRefSchema = Open({ rootId: Name, codeVersion: int({ minimum: 1 }) });
// RootRef 是 schema 推导类型（Static），不是手写接口；改字段时类型和校验一起变。
export type RootRef = Static<typeof RootRefSchema>;

// 所有线上错误统一为 { code, message, reason? }。code 用 oneOf(CHORD_ERROR_CODES) 做运行时白名单校验；
// 该 schema 也是 Open，较新 peer 多出的错误字段不会让旧 peer 拒帧。
const WireErrorSchema = Open({
	// oneOf 接受字面量数组，运行时检查值是否属于 CHORD_ERROR_CODES；error.code 不是任意字符串。
	code: oneOf(CHORD_ERROR_CODES),
	message: str(),
	// reason 可选：更细的失败原因（如 args/input/implementation），不是所有错误都有。
	reason: opt(str()),
});
// ChordError 分支的 message 是 error.message 原样编码（已含 "code/reason: " 前缀，见 toWireError）；其他异常没有该前缀。
export type WireError = Static<typeof WireErrorSchema>;

// 父 host 在 prepare 帧里下发的子重载选项：remove 列表、gate/retire 截止时间；均可选，缺省由子 host 决定。
const WireReloadOptionsSchema = Open({
	// remove 是本次重载要移除的 facet 模块名列表；只影响子 host 自己声明/加载的模块。
	remove: opt(List(str())),
	// gateDeadline：等待旧 root/任务 gate 完成的最长时间。
	gateDeadline: opt(num()),
	// retireDeadline：等待旧代码版本退役的最长时间。
	retireDeadline: opt(num()),
});
// WireReloadOptions 是 schema 推导类型；与 reload.ts 的 ReloadOptions 相比只保留可跨链路的部分。
export type WireReloadOptions = Static<typeof WireReloadOptionsSchema>;

/** A child's prepared reload, sent with its vote (same fields as `ReloadReport`, without children). */
// 子 host 投票时携带的“已准备”报告：与 ReloadReport 字段相同，但没有 children，避免报告无限嵌套。
const WireReloadReportSchema = Open({
	// codeVersion 是本次候选版本；previous 是重载前（子 host 当前）的版本。
	codeVersion: int(),
	// previous 用于父 host 汇总和诊断，不参与版本匹配。
	previous: int(),
	// changed/removed 分别是本次代码变更涉及和移除的 facet 名；prepared 是安装新工厂的对象地址，gated 是经过 gate 处理的对象地址。
	changed: List(str()),
	removed: List(str()),
	prepared: List(str()),
	gated: List(str()),
});
// 类型同样由 schema 推导；changed 等数组在类型上是 readonly（List helper）。
export type WireReloadReport = Static<typeof WireReloadReportSchema>;

// FrameSchema 是所有帧的判别联合；每个帧用 t 字面量区分，字段显式声明一次，Frame 类型和 isFrame 都源于此。
const FrameSchema = union([
	// hello：链路建立后双方发送的第一帧，声明协议版本、身份、代码版本和 ack 能力。
	Open({
		t: lit("hello"),
		/** The link protocol version (`PROTOCOL_VERSION`; absent: 1). Peers of another version close the link. */
		// protocol 可选；缺省按 1 处理（兼容最早期没有该字段的实现），比较逻辑在 connection.ts。
		protocol: opt(int({ minimum: 1 })),
		// name 是发送方 host/client 名字；downstream 的 hello 若在 accept 时指定了名字，必须与这里一致。
		name: Name,
		// kind 是发送方自报的身份；downstream 会与 accept 配置核对，upstream 则要求必须是 host，不能用它绕过授权。
		kind: union([lit("host"), lit("client")]),
		// codeVersion 是发送方当前运行的代码版本；子 host 的版本由父 host 用来同步、围栏或 reconcile，
		// 父 host 绝不把子 host 的旧代码重标成新版本。
		codeVersion: int({ minimum: 0 }),
		/** The sender acknowledges what it receives (`ack`). Flow control applies only when both hellos say so. */
		// acks 表示发送方会回 ack；只有双方都声明 true 才启用流控/窗口。
		acks: opt(bool()),
	}),
	/** Every frame received so far except `ack` frames, counted from the link's start, once processed. */
	// ack：累计确认“已处理到第 n 帧”（不含 ack 自身），从链路开始计数；
	// connection.ts 会校验 n 在已确认值和已发送值之间，越界视为协议违规。
	Open({ t: lit("ack"), n: int({ minimum: 1 }) }),
	Open({
		// hold：消费者创建对象引用；id 由消费者选择，后续 release/shape/gone/call/state 用同一个 id 关联该引用。
		t: lit("hold"),
		id: Id,
		/**
		 * Target host name, resolved by the consumer from the token's `host` and `input`. Relays route on it after
		 * checking it against both; the target refuses an input its own contract places elsewhere.
		 */
		// at：目标 host 名（路由用）；ingress host 会再核对 token 与 input 是否把对象放在这个 host 上。
		at: Name,
		/** The consumer's contract token; the provider checks that it covers it. Remote tokens carry `host`. */
		// token：消费者拿到的契约描述，provider 用它检查自己是否覆盖该契约；远程 token 里还可能带 host 信息。
		token: DescriptionSchema,
		/** Normalized with the consumer's contract. */
		// input 故意保持 unknown：帧级 schema 不解析业务输入，留给对象工厂按契约归一化/校验。
		input: unknown(),
		/** A forwarded principal. Honored only on frames from the parent link. */
		// principal 只允许父 host 转发时携带；downstream 连接始终使用 accept 时盖章的身份，帧里的值被忽略。
		principal: opt(unknown()),
		/**
		 * The client connection the hold comes from: an opaque id the server assigned to it, forwarded by relays. Honored
		 * only on frames from the parent link; present means the hold is a client's (not a reload participant).
		 */
		// origin：请求来自哪个 client 连接（服务端分配的 opaque id，由 relay 转发），只允许父 host 携带；
		// 它把 client 与 host 区分开，client 不参与重载协调。
		origin: opt(Name),
		/** False: no state for this hold until `sub` (a method-only binding). */
		// state: false 表示 method-only 绑定：先不要状态，等显式 sub 帧再建立。
		state: opt(lit(false)),
		/** The consumer already has values (a re-hold after a link loss): its unit is not urgent. */
		// again: true 表示重新 hold（例如断链后恢复），消费者已有值，状态单元不紧急。
		again: opt(lit(true)),
	}),
	// release：消费者主动释放 hold；provider 退订状态并减少对象引用计数。
	Open({ t: lit("release"), id: Id }),
	Open({
		// shape：provider 对 hold 的形态回复：variant、成员名、契约指纹，以及随后会跟快照的 state 成员名。
		t: lit("shape"),
		id: Id,
		// variant 可选：本地单变体契约可能省略；远程多变体对象用它选择成员集合。
		variant: opt(str()),
		// members 是该形态下所有成员名（方法、状态、不透明值等）。
		members: List(str()),
		// contract 是契约指纹字符串；消费者用它判断自己与 provider 的契约是否兼容。
		contract: str(),
		/** The state members whose snapshots follow this frame; the consumer applies the shape once they are here. */
		// state 列出“随后会发送快照”的状态成员；消费者收齐这些快照后才把 shape 应用到引用。
		state: List(Name),
	}),
	// gone：hold 结束（对象消失、权限撤销等），error 解释原因；之后该 id 不再有效。
	Open({ t: lit("gone"), id: Id, error: WireErrorSchema }),
	Open({
		// call：在某个 hold 上调用方法；id 是本次调用的 id，hold 指出对象，member 指出方法。
		t: lit("call"),
		id: Id,
		// hold 必须已由同一消费者建立；未知 hold 会得到 gone/result 错误而不是断链。
		hold: Id,
		// member 是方法名（Name 非空）；provider 按契约检查方法与参数。
		member: Name,
		// args 故意保持 unknown：调用参数按方法 schema 在使用处校验，不在帧级展开。
		args: opt(unknown()),
		/** Absent: the receiving host starts a root (browsers never carry roots). */
		// root 可选：host 对端可以携带已有的 root 引用，使跨 host 调用归入同一棵 root；
		// 没有 root（或来自 client）时，接收 host 为本次调用新建一个 root。
		root: opt(RootRefSchema),
	}),
	Open({
		// result：调用的成功值或错误，id 对应 call.id；error 非空时 value 不参与。
		t: lit("result"),
		id: Id,
		// value 可选：无返回值或值为 undefined 时省略；解包/契约校验在 connection/remote 层完成。
		value: opt(unknown()),
		// error 可选；成功时没有 error。schema 不强制二者恰好一个，消费方按 error 优先解释。
		error: opt(WireErrorSchema),
	}),
	// cancel：取消进行中的 call（按 call.id），provider 通过 AbortController 中止方法。
	Open({ t: lit("cancel"), id: Id }),
	/** Starts the state of a hold opened with `state: false` (answered with a unit). */
	// sub：对 state:false 的 hold 开始状态流；provider 回复一个 unit（shape + 快照）。
	Open({ t: lit("sub"), hold: Id }),
	/** Stops the state of a hold. */
	// unsub：停止状态流，但保留 hold 本身；之后的 call 仍可使用该 hold。
	Open({ t: lit("unsub"), hold: Id }),
	/** Sends member `m` again as a reset (a relay that had to drop what waited for it). */
	// resync：请求 provider 把成员 m 重新作为 reset 发送；用于 relay 丢弃了排队 ops、需要重新对齐时。
	Open({ t: lit("resync"), hold: Id, m: Name }),
	Open({
		// state：成员状态流的一帧。hold+member 定位流，as 决定 value/ops/error 哪个字段有效。
		t: lit("state"),
		hold: Id,
		m: Name,
		/** `snap`/`reset` without `value`: the value is `undefined`. */
		// as 是字面量联合：snap/reset（完整值或 undefined）、ops（增量）、error（错误）。
		as: union([lit("snap"), lit("reset"), lit("ops"), lit("error")]),
		value: opt(unknown()),
		// ops 是编码后的增量操作数组；外层 List 校验“数组的数组”，每个 op 的具体形状由 delta 解码器逐条校验。
		/** Encoded with the stream's delta encoder; the decoder validates each op. */
		ops: opt(List(List(unknown()))),
		// error 只在 as: "error" 时使用；同样是可跨链路的 WireError。
		error: opt(WireErrorSchema),
	}),
	// ping/pong：心跳与往返测量，n 原样回显；没有最小值约束，调用方可自由选择序号。
	Open({ t: lit("ping"), n: int() }),
	Open({ t: lit("pong"), n: int() }),
	/** Ends the link (consumed by the link itself). `reason: "protocol-version <n>"`: the sender speaks version n. */
	// bye：结束链路，由 link 层消费；reason 可选，协议版本不匹配时会带 "protocol-version <n>"。
	Open({ t: lit("bye"), reason: opt(str()) }),
	/** The root ended at its origin: its leases on objects end (sent on every link the root's calls used). */
	// root_end：root 在 origin 结束，通知所有该 root 调用过的链路释放租约；rootId 对应 RootRef.rootId。
	Open({ t: lit("root_end"), rootId: Name }),
	// invalidate：父 host 把 principal 匹配模式（只含数据字段）转发给子 host，让子 host 也撤销/重盖章匹配的连接和对象；
	// 函数谓词无法序列化，只在本 host 执行，不会出现在线上。
	Open({ t: lit("invalidate"), pattern: map(unknown()) }),
	Open({
		// prepare：父 host 要求子 host 为集群重载做准备；子 host 加载 plugins、按 options 准备对象后回 vote。
		t: lit("prepare"),
		// reload 是本次事务 id；子 host 的 vote/commit/abort 必须匹配同一个 id。
		reload: Reload,
		// codeVersion 是父 host 指定的目标版本，必须比子 host 当前版本新。
		codeVersion: int({ minimum: 1 }),
		// plugins 是父 host 按子 host 名字筛选后的 facet 模块列表；子 host 只加载这些模块。
		plugins: List(str()),
		// options 携带 remove 与 gate/retire 截止时间；缺省用子 host 自己的默认值。
		options: WireReloadOptionsSchema,
	}),
	Open({
		// vote：子 host 对 prepare 的回复；error 表示失败，report 表示已准备并可提交。
		t: lit("vote"),
		// reload 对应 prepare.reload；父 host 的 votes Map 按它兑现等待中的 Promise。
		reload: Reload,
		// error 与 report 按 error 优先解释；连接层若存在 error 就拒绝，否则 resolve report。
		error: opt(WireErrorSchema),
		// report 是子 host 的 ReloadReport（不含 children）；父 host 汇总到最终报告的 children 字段。
		report: opt(WireReloadReportSchema),
	}),
	// commit：父 host 通知子 host 提交已准备的版本；子 host 安装并启动新代码，然后释放重载槽。
	Open({ t: lit("commit"), reload: Reload }),
	/** The parent dropped `codeVersion`: roots of it may still come from there no longer. */
	// retire：父 host 告知“已退役到 codeVersion”，子 host 可以丢弃更旧的版本并结束等待。
	Open({ t: lit("retire"), codeVersion: int({ minimum: 1 }) }),
	// abort：父 host 放弃本次事务；子 host 回滚已准备状态并释放重载槽。
	Open({ t: lit("abort"), reload: Reload }),
]);
// Frame 是判别联合的静态类型：通过 isFrame 后，`frame.t` 可直接收窄到具体帧分支。
export type Frame = Static<typeof FrameSchema>;

/** A frame that passes validation; anything else is a protocol violation. */
// isFrame 是唯一完整帧校验入口：compile 只编译一次 schema，返回的 check 是类型谓词；
// 失败说明对端违反协议，connection.ts 会按协议违规处理。校验同时检查 t、必填字段和字段类型。
export const isFrame: (value: unknown) => value is Frame = compile(FrameSchema).check;

// toWireError：把任意异常编码成 WireError。ChordError 保留 code/message/reason；其他异常统一为 unavailable，
// 保留可读 message。cause/details 不跨链路，接收方只能看到这三个字段。
export function toWireError(error: unknown): WireError {
	// instanceof 是运行时检查：参数类型是 unknown（catch 到的值没有静态保证），必须在此信任边界分类。
	if (error instanceof ChordError) {
		return error.reason === undefined
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, reason: error.reason };
	}
	// 非 ChordError：Error 取 message，其他值用 String；code 固定 unavailable，表示本地未知失败。
	return { code: "unavailable", message: error instanceof Error ? error.message : String(error) };
}

// fromWireError：WireError 已通过 isFrame 校验，code 一定在白名单内，因此可直接构造 ChordError。
export const fromWireError = (error: WireError): ChordError =>
	// ChordError 构造器会再加 "code/reason: " 前缀；先用正则剥掉 message 开头形如 `code[/reason]: ` 的前缀
	// （小写字母/下划线），避免重复成 "invalid/args: invalid/args: ..."。结果保留 code/reason，但 cause/details 无法恢复。
	new ChordError(error.code, error.message.replace(/^[a-z_]+(\/[a-z_]+)?: /, ""), { reason: error.reason });
