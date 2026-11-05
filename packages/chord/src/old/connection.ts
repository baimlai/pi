/**
 * Chord v1 旧实现：连接层（Connection）——一条已建立链路上的完整协议状态机。
 *
 * 所属包与功能模块：packages/chord/src/old/connection.ts，属于 Chord v1（旧版）的网络/链接层。
 * v1 代码保留在 src/old，直到 p2 迁移到 Chord v2；本文件不参与 v2 的 slice 构建。
 *
 * 解决什么问题：Host 之间、浏览器与服务器之间通过 Link 传输 Frame。链路本身只负责收发，
 * 本文件把“帧”解释成对象语义：hold（持有远端对象）、state（状态复制与增量）、call（远程方法调用）、
 * relay（把请求转发给真正拥有对象的 host）、重载控制与 principal 授权。它还实现了应用层流量控制，
 * 防止慢消费者把快生产者的内存撑爆。
 *
 * 职责边界：
 * - 不决定对象放在哪个 host（host.acquire / HostImpl.relay 负责寻址与路由解析）；
 * - 不实现传输（link.ts 负责内存/IPC/WebSocket 与尺寸报告）；
 * - 不做契约版本协商（host.peerHello、wire.PROTOCOL_VERSION 负责）；
 * - 不执行对象方法本身（object.ts 的 RefImpl/ObjectImpl 负责），只建立 ctx、root 和取消信号。
 *
 * 上游入口：HostImpl.accept（downstream，本 host 接受客户端或子 host）与 HostImpl.connect
 * （upstream，本 host 连向父 host）创建 Connection；RemoteBinding 通过 RemoteChannel 接口调用消费侧方法；
 * peer 的帧由 link.receive 送入 #receive，链路关闭由 link.onClose 送入 #closed。
 *
 * 下游依赖：wire.ts（Frame schema、PROTOCOL_VERSION、错误线格式）、link.ts（send/close/尺寸）、
 * contract.ts（contractFromDescription、resolveHost、LOCAL_VARIANT）、object.ts（RefImpl、variantOf）、
 * host.ts（acquire/root/joinRoot/relay/peerHello/...）、remote.ts（RemoteBinding/RemoteChannel）、
 * delta（每成员流的 Encoder）、schema（assertValid）。
 *
 * 结果与错误流向：业务拒绝（未知对象、placement 不符、对象结束）编码成 gone/result.error 帧回给对端；
 * 协议错误（重复 id、越界 ack、非法帧）通过 #violation 报告 host 并关闭链路；链路关闭时 #closed
 * 统一拒绝本端所有等待中的调用、投票与同步等待者，并释放对端持有的对象。
 *
 * 能力清单（按导出项）：
 * - LinkOptions：窗口、待发上限、心跳、协议版本不一致回调等链路级配置。
 * - AcceptOptions<P>：在 LinkOptions 上增加 principal、peer kind/name、restamp、maxCalls，
 *   是 host.accept 的配置类型。
 * - Peer：对端身份（client 或 host）与名字。
 * - RelayRef：一个被转发到下游连接的 hold，拥有排队中的 state/调用、下游 id 与关闭清理。
 * - RelayCall：一次转发中的调用，保证只结算一次并清理两侧映射。
 * - Connection：本文件的核心类，实现 RemoteChannel，并提供发送、流控、收帧分派、提供侧与中继。
 * - 非导出但重要：StateFrame（state 帧类型）、Slot（等待槽位）、Overflow（溢出策略）、Feed（成员流）、
 *   ServedLocal/Served（提供侧 hold）、Pending（等待者）、unavailable（错误构造），以及文件末尾的
 *   relayCall、validateSnapshot、clientError、stateKey、unitKey。
 *
 * 组合关系与典型调用顺序：
 * 1. Host 接受/建立链路 -> new Connection(...) 发送 hello，双方确认协议版本与 ack 能力；
 * 2. 消费者侧：RemoteBinding -> connection.hold(...) -> 对端 shape + state 快照 -> 应用后 live；
 *    后续 ops/reset 进入 binding.state，调用结果进入 #onResult；
 * 3. 提供者侧：对端 hold -> #onHold -> host.acquire -> #unit/#sendUnit 推送状态；对端 call ->
 *    #onCall -> host.root/joinRoot -> result；
 * 4. 中继：hold.at 不是本 host -> RelayRef -> host.relay 解析路由 -> relay.open(down) 转发；
 *    下游的 shape/state/result 再由 RelayRef 转回 origin；
 * 5. 链路关闭 -> #closed 清理所有映射与等待者。
 *
 * 示例（假设 host 与 link 已存在，binding 是一个 RemoteBinding）：
 *   const connection = new Connection(host, link, {
 *     role: "downstream",
 *     principal: "guest",
 *     peer: { kind: "client", name: undefined },
 *     window: 64 * 1024,
 *   });
 *   const id = connection.hold(binding, false);
 *   const value = await connection.call(id, "add", { text: "hi" }, undefined, signal);
 *
 * 建议阅读顺序：
 * 1. LinkOptions/AcceptOptions/Peer（文件开头的配置与身份类型）：先知道连接能配置什么；
 * 2. Slot/Overflow/Feed/ServedLocal（紧随其后的内部类型）：理解等待队列与提供侧状态；
 * 3. RelayRef/RelayCall（relay 段）：中继是理解 hold 生命周期的关键；
 * 4. Connection 的字段与构造函数（connection 段开头）：建立整体状态图；
 * 5. send/sendState/#flush：流量控制；
 * 6. #receive/#dispatch 与各 #onXxx：协议状态机；
 * 7. 文件末尾的 relayCall、validateSnapshot、clientError 等横切辅助函数。
 */
import { type Encoder, encoder } from "../delta/index.ts";
import { contractFromDescription, LOCAL_VARIANT, resolveHost } from "./contract.ts";
import { ChordError, invalid } from "./errors.ts";
import type { HostImpl } from "./host.ts";
import { type Link, Packed, unpack } from "./link.ts";
import { type CtxImpl, RefImpl, variantOf } from "./object.ts";
import type { RemoteBinding, RemoteChannel } from "./remote.ts";
import { assertValid } from "./schema.ts";
import type { Ctx, Readable, Shape, StateEvent } from "./types.ts";
import { type Frame, fromWireError, isFrame, PROTOCOL_VERSION, type RootRef, toWireError } from "./wire.ts";

// LinkOptions：Connection 的链路级配置，全部可选。它只影响传输/流控/心跳，不改变对象语义。
// 这些字段会与 AcceptOptions 合并后传给构造函数；nullish 合并（??）负责填默认值。
export interface LinkOptions {
	/** Milliseconds between pings (default 15000). */
	// pingInterval：两次 ping 之间的毫秒数，默认 15000。仅用于心跳，不影响业务帧。
	readonly pingInterval?: number;
	/** Close the link when nothing arrived for this long (default 45000). Everything held through it is released. */
	// pingTimeout：超过这么久没有收到任何帧就关闭链路，默认 45000。
	// 关闭会释放该链路上所有 hold（远端消费者会收到 gone 或连接关闭）。
	readonly pingTimeout?: number;
	/**
	 * Unacknowledged frame bytes (JSON text length) beyond which state frames wait for the peer (default 256 KiB). Only
	 * applies when both ends acknowledge frames and the link reports sizes; `Infinity` never holds state back.
	 */
	// window：允许“已发送但未确认”的帧字节数上限，默认 256 KiB。
	// 只有双方都在 hello 中声明 acks、且链路报告帧尺寸时才生效；Infinity 表示永不因窗口阻塞。
	// 注意：这是应用层背压，不是 TCP 窗口；它约束的是 state 帧，result/shape/gone/心跳不受限。
	readonly window?: number;
	/**
	 * Bytes of state ops that may wait for the peer on this link (default 4 windows). Beyond, the oldest waiting streams
	 * are replaced by their current value (a reset), so memory stays bounded however long the peer stalls.
	 */
	// pendingCap：等待发送的 state ops 字节上限，默认 4 个 window。
	// 超过后最老的流被“当前值 reset”替换（provider 重发快照，relay 请求下游 resync），保证内存有界。
	// 示例：window = 256 KiB，pendingCap 默认 1 MiB；对端停读时最多积压约 1 MiB 的 ops。
	readonly pendingCap?: number;
	/**
	 * The peer speaks another link protocol version (`peer`: undefined if it did not say): the link closes, and should
	 * not be reconnected with the same code. A browser reloads its page, for instance.
	 */
	// onProtocolMismatch：对端协议版本不同时调用一次，参数是 { local, peer }；peer 为 undefined 表示对端未声明。
	// 回调返回后链路关闭，调用方不应再用同一份代码重连（例如浏览器应刷新页面以加载新版本）。
	// 回调抛出的异常会交给 host.report，不会阻止关闭。
	readonly onProtocolMismatch?: (versions: { readonly local: number; readonly peer: number | undefined }) => void;
}

// 默认窗口：256 KiB。与 LinkOptions.window 的默认值一致。
const DEFAULT_WINDOW = 256 * 1024;
// 默认待发上限 = 4 个窗口（PENDING_WINDOWS），在构造函数中按 window 计算。
/** The default cap of waiting state ops per link, in windows. */
// 待发上限的窗口倍数。
const PENDING_WINDOWS = 4;

// StateFrame：从 Frame 可辨识联合中提取 t === "state" 的那一支。
// Extract<Frame, { t: "state" }> 是 TypeScript 的条件类型工具：保留联合中可赋值给 { t: "state" } 的成员。
// 这样后续代码拿到的是精确的 state 帧类型（含 hold/m/as/value/ops/error），而不是整个 Frame 联合。
type StateFrame = Extract<Frame, { t: "state" }>;

// Overflow：等待中的流被丢弃时如何恢复，是一个二选一的函数联合。
// - resend：provider 侧，重新订阅成员并发送当前值（reset）；
// - resync：relay 侧，自己没有值，向下游请求一次 reset。
// 用“带不同方法名的对象联合”而不是布尔标志，是为了让调用点通过 `in` 收窄，避免非法状态。
/**
 * How a waiting stream recovers when its ops must be dropped: the provider resends the current value as a reset at
 * flush; a relay (which has no value) asks downstream for one.
 */
// 两种恢复策略的联合类型。
type Overflow = { readonly resend: () => void } | { readonly resync: () => void };

// Slot：一个链路发送队列中的等待槽位，是可辨识联合：
// - unit：某个 hold 的惰性 unit（shape + 缺失成员快照），flush 时才构建；
// - state：某个成员的流，保存 base（snap/reset/error）和后续 ops，或 lazy 重发计划。
// 队列键：unit 用 "u<hold>"，state 用 "s<hold>\0<member>"，两类共用一个 Map 以保持全局创建顺序。
/**
 * What waits on a link. A unit slot is lazy: the shape and snapshots are built from the current values when it is sent.
 * A state slot keeps a snapshot, reset or error (`base`) and encoded ops to apply after it, in order (as they arrived;
 * the receiving decoder validates them), or, once `lazy`, only the promise of a reset built at flush.
 */
// Slot 联合：unit 槽位只需要 hold 和 flush 回调；state 槽位需要更多字段。
type Slot =
	// unit 槽位：flush 回调在窗口有空位时构建并发送最新 unit。
	| { readonly kind: "unit"; readonly hold: number; readonly flush: () => void }
	// state 槽位：字段可变（base/ops/size/lazy），因为等待期间会不断追加或替换。
	| {
			// kind：槽位类型标记；state 槽位比 unit 槽位多保存 base/ops 等字段。
			readonly kind: "state";
			// hold：所属 hold（用于 dropHoldState 和状态帧的 hold 字段）。
			readonly hold: number;
			// m：成员名。
			readonly m: string;
			// base：最近一个非 ops 帧（snap/reset/error），发送它之后再发送 ops。
			base: StateFrame | undefined;
			// ops：按到达顺序累积的增量批次；可能来自同一个 encoder 的多个 encode 调用。
			ops: (readonly unknown[])[];
			// size：ops 的近似字节数（JSON 文本长度），用于 pendingCap。
			size: number;
			// lazy：true 表示 flush 时重新生成当前值（provider）或请求 resync（relay），而不是发送 base/ops。
			lazy: boolean;
			// overflow：丢弃该流时的恢复策略，创建槽位时确定。
			readonly overflow: Overflow;
	  };

// AcceptOptions<P>：host.accept 的配置，在 LinkOptions 之上增加“对端是谁、以谁的身份执行”。
// P 是应用自定义的 principal 类型；Chord 不解释它的结构，只负责传递与比较键。
// extends LinkOptions 让心跳、窗口等链路配置也能在 accept 时一次性给出。
export interface AcceptOptions<P = unknown> extends LinkOptions {
	/** The principal of whatever connects, from the app's authenticator. Every request on the link acts as it. */
	// principal：应用认证器给出的身份。该链路上的所有请求都以这个身份执行；
	// 帧里携带的 principal 不会被 downstream 连接采用（见 #principalOf）。
	readonly principal: P;
	/**
	 * What the peer is, decided here and never by its `hello`: `client` (default; a browser: no roots, no code versions,
	 * not a reload participant, not addressable) or `host` (a child host; needs `name`).
	 */
	// kind：对端类型，由本端在 accept 时决定，而不是由对端 hello 自报。
	// client（默认）：浏览器/简单客户端，没有 roots、代码版本，不参与重载，不可按名字寻址；
	// host：子 host，必须提供 name。
	readonly kind?: "host" | "client";
	/** A child host's name: its hello must match, and it is reachable `at` this name. */
	// name：子 host 的名字。对端 hello 必须匹配；其他 host 可以通过这个 at 名字路由到它。
	readonly name?: string;
	/** On `invalidatePrincipal`: a new principal keeps the link, `undefined` closes it (default: close). */
	// restamp：invalidatePrincipal 时决定是否保留链路。返回新 principal 表示继续（并更新盖章身份），
	// 返回 undefined 表示关闭链路（默认行为）。
	restamp?(principal: P): P | undefined;
	/**
	 * Calls the peer may have in progress on this link (default: no limit). Further ones never run: they are answered
	 * at once with `unavailable` (reason `too_many_calls`), and the link stays open.
	 */
	// maxCalls：该连接上允许的对端并发调用数，默认不限。
	// 超出的调用不会执行，立即以 unavailable/too_many_calls 回复；链路保持打开，避免一个慢客户端拖垮服务端。
	readonly maxCalls?: number;
}

// Peer：对端的身份。downstream 连接使用 accept 时配置的值；upstream 连接由父 host 的 hello 公告。
export interface Peer {
	// client 或 host。客户端没有 root/代码版本，也不可寻址。
	readonly kind: "host" | "client";
	/** Configured (downstream hosts) or announced by the trusted parent (upstream). */
	// 名字：downstream host 必须配置；upstream 连接由父 host 公告（另存于 #parentName）。
	readonly name: string | undefined;
}

/** A state member's stream to the consumer: its subscription and delta encoder. */
// Feed：一个状态成员到消费者的流。每个 hold 的每个成员各有一个 Feed。
// 它把“订阅对象实现”和“编码增量”绑定在一起，并在首次快照构建期间缓冲事件。
interface Feed {
	// unsubscribe：取消对象实现的订阅，避免释放后继续收到事件。
	unsubscribe: () => void;
	// encoder：该成员专用的 Delta 编码器；reset 时替换，保证新旧流的路径表不混用。
	encoder: Encoder;
	/** Events that arrived while a unit or reset was being built (replayed after it is sent). */
	// buffer：快照构建期间到达的事件；发送完快照后由 #replay 回放，然后置为 undefined。
	// undefined 表示“快照已经发出”，后续事件直接走 #feedEvent。
	buffer: StateEvent<unknown>[] | undefined;
}

/** A hold the peer made on this host and serves locally. */
// ServedLocal：对端在本 host 上建立、由本地对象直接服务的 hold。
// 它记录消费者已经拥有哪些成员的快照（feeds），以及是否需要状态、是否重新 hold。
interface ServedLocal {
	// 可辨识标签：本地服务。
	readonly kind: "local";
	// 对端分配并发送的 hold id（在本连接内唯一）。
	readonly id: number;
	// host.acquire 得到的本地引用；释放时减少引用计数。
	readonly ref: RefImpl;
	// 该 hold 使用的 principal（由 #principalOf 安全地确定）。
	readonly principal: unknown;
	/** The client connection it comes from (see `Frame` hold `origin`); undefined for a host's own holds. */
	// origin：客户端连接的标识；host 自己的 hold 为 undefined。relay 转发时保留它。
	readonly origin: string | undefined;
	/** The consumer wants state (hold without `state: false`, or `sub`). */
	// wantsState：消费者是否要状态（hold 没写 state: false，或之后发送了 sub）。
	wantsState: boolean;
	/** The consumer had values before (re-hold): its first unit waits for the window like any other. */
	// again：消费者之前已经有值（重新 hold）。此时首个 unit 不应绕过窗口。
	readonly again: boolean;
	/** A unit was sent. */
	// unitSent：是否已经发送过 unit。用于判断“首个 unit”的 urgent 语义。
	unitSent: boolean;
	/** The members whose snapshot the consumer has, with their streams. */
	// feeds：消费者已经拥有快照的成员 -> 该成员的流。没有 feed 的成员会在下一个 unit 中补发快照。
	readonly feeds: Map<string, Feed>;
}

/** A hold the peer made on this host: served locally or relayed to another link. */
// Served：对端建立的一个 hold，要么本地服务（ServedLocal），要么转发到别的 host（RelayRef）。
// 用 kind 作为可辨识标签，提供侧代码通过 served.kind 收窄。
type Served = ServedLocal | { readonly kind: "relay"; readonly relay: RelayRef };

// Pending：一个等待中的 Promise 的 resolve/reject 对。
// resolve 统一接收 unknown，便于 hold/call/vote/sync 等不同场景复用。
type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void };

// unavailable：构造 unavailable 错误的简写。unavailable 表示“暂时不可用”，通常可以重试，
// 与 forbidden/invalid 等永久错误区分。
const unavailable = (message: string): ChordError => new ChordError("unavailable", message);

// 以下两个类处理“对象不在本 host”的情况：把 hold/调用转发到下游连接，并把结果转回 origin。
// ─── relay ───────────────────────────────────────────────────────────────────

/**
 * A hold relayed from an origin link to a downstream link. It owns everything done through it: state and calls queued
 * while the route resolves, and the downstream twins once forwarded. `close` undoes all of it exactly once (cancels
 * calls downstream, drops what waits for the origin, releases the downstream hold, rejects waiters).
 */
// RelayRef：一个从 origin 连接转发到下游连接的 hold。
// 它拥有：等待路由解析的 state/调用、下游分配的 hold id、下游调用映射，以及关闭时的统一清理。
// 生命周期：origin 发来 hold -> 创建 RelayRef 并登记到 origin.served -> host.relay 解析路由 ->
// open(down) 发送下游 hold -> 下游 shape/state/result 经本对象转回 origin -> close 撤销一切。
// 错误：close 可以因 origin 释放、origin 链路关闭、principal 撤销、下游 gone 或路由失败而触发；
// 它保证只执行一次清理（closed 标志），取消下游调用、释放下游 hold、拒绝等待者、按需通知 origin。
export class RelayRef {
	// 发起该 hold 的 origin 连接（本 host 接受的那条链路）。
	readonly origin: Connection;
	// 原始的 hold 帧：保存 at/token/input/again 等字段，转发时复用。
	readonly frame: Extract<Frame, { t: "hold" }>;
	// 该 hold 的 principal（由 origin 的连接安全地盖章）。
	readonly principal: unknown;
	/** The client connection the hold comes from (forwarded downstream); undefined for a host's own holds. */
	// origin 的客户端标识；undefined 表示 origin 是 host 自己的 hold（不是某个浏览器连接）。
	readonly originTag: string | undefined;
	/** The origin's authorization generation when the hold arrived; a revocation bumps it. */
	// 创建时的授权代际：origin.generation 变化后，这个 relay 不再 authorized（见 current）。
	readonly generation: number;
	// 路由解析完成后的下游连接；undefined 表示仍在等待 host.relay。
	down: Connection | undefined;
	// 下游连接上为本 hold 分配的 id；0 表示尚未 open。
	downId = 0;
	// 已关闭：所有转发与清理都变为幂等。
	closed = false;
	/** The origin wants state (forwarded as `state: false`, `sub`, `unsub`). */
	// origin 是否想要状态；会随 sub/unsub 变化，并转发成下游的 state: false/sub/unsub。
	stateWanted: boolean;
	/** The members of the first unit, still to forward past the origin's window. */
	// 首个 unit 的成员集合：这些成员的 state 帧要绕过 origin 侧的窗口（见 shape/state）。
	urgent: Set<string> | undefined;
	// 是否已经收到下游的第一个 shape；只有第一个 shape 才建立 urgent 集合。
	#shaped = false;
	/** Members whose ops this relay dropped: downstream ops are ignored until their reset arrives. */
	// 等待 reset 的成员：中继丢弃了这些成员的 ops，在下游发来 reset 之前忽略它们的 ops。
	readonly awaiting = new Set<string>();
	// 下游 call id -> RelayCall；用于把 result/cancel 路由回正确的 origin 调用。
	readonly calls = new Map<number, RelayCall>();
	// 等待路由解析完成的 Promise（ready()）；open 或 close 时结算。
	readonly #waiters = new Set<Pending>();

	// constructor：保存 origin、原始帧、principal 与 originTag，并记录授权代际。
	// 输入：origin 连接、hold 帧、principal、originTag。
	// 副作用：只初始化字段，不发送任何帧；真正的转发在 open(down) 时发生。
	// 示例：const relay = new RelayRef(origin, frame, principal, originTag);
	// 注意：stateWanted 的初值来自帧的 state 字段（缺省为 true）。
	constructor(
		origin: Connection,
		frame: Extract<Frame, { t: "hold" }>,
		principal: unknown,
		originTag: string | undefined,
	) {
		// 保存 origin 连接。
		this.origin = origin;
		// 保存原始 hold 帧（转发时读取 at/token/input/again）。
		this.frame = frame;
		// 保存 principal。
		this.principal = principal;
		// 保存 origin 的客户端标识。
		this.originTag = originTag;
		// 缺省要状态；只有显式 state: false 才关闭。
		this.stateWanted = frame.state !== false;
		// 记录创建时的代际；revoke 后 current 变为 false。
		this.generation = origin.generation;
	}

	// originId：origin 连接上的 hold id。转回 origin 时所有帧都使用这个 id。
	get originId(): number {
		// 原始帧的 id 就是 origin 侧的 hold id。
		return this.frame.id;
	}

	// client：该 hold 是否来自一个客户端连接（有 originTag）。
	get client(): boolean {
		// originTag 存在即表示客户端；host 自己的 hold 没有 origin。
		return this.originTag !== undefined;
	}

	// current：该 relay 是否仍然有效：未关闭、origin 链路仍打开、授权代际未变化。
	/** Still authorized as it was when it arrived. */
	// 三个条件缺一不可；generation 变化意味着 principal 被撤销/重盖章。
	get current(): boolean {
		return !this.closed && this.origin.open && this.origin.generation === this.generation;
	}

	// ready：等待路由解析完成，返回下游连接。
	// 输出：Promise<Connection>。错误：relay 已关闭时以 gone 拒绝；close 也会拒绝所有等待者。
	// 示例：const down = await relay.ready(); // 之后才能发送下游 hold/call
	// 注意：如果 down 已经存在，立即 resolve；否则把 resolve/reject 放进 #waiters。
	/** The downstream connection once the route resolved; rejects if the relay closes first. */
	// 已关闭：不可能再有下游连接。
	ready(): Promise<Connection> {
		// 用 gone 表示“转发目标已不存在”，与 unavailable（可重试）区分。
		if (this.closed) return Promise.reject(new ChordError("gone", "relayed hold closed"));
		// 已经解析过路由：直接返回缓存的连接。
		if (this.down !== undefined) return Promise.resolve(this.down);
		// 尚未解析：返回一个由 open/close 结算的 Promise。
		return new Promise<Connection>((resolve, reject) => {
			// Pending 的 resolve 接收 unknown；这里包一层把 Connection 适配成 unknown。
			this.#waiters.add({ resolve: resolve as (value: unknown) => void, reject });
		});
	}

	/** Forwards the hold to `down`. */
	// open：路由解析成功，把 hold 转发到下游连接。
	// 输入：down（下游 Connection）。副作用：记录 down/downId、登记到下游 relayedRefs、发送 hold 帧、
	// 唤醒所有 ready() 等待者。
	// 错误：relay 已关闭时直接返回（close 可能先于路由完成）。
	// 示例：relay.open(childConnection); // 下游会收到带 principal/origin/state/again 的 hold
	// 注意：下游 id 由 down.nextId() 分配，origin 侧 id 保持不变。
	open(down: Connection): void {
		// 已关闭：路由回来得太晚，不能再转发。
		if (this.closed) return;
		// 记录下游连接。
		this.down = down;
		// 分配下游 hold id。
		this.downId = down.nextId();
		// 登记到下游的 relayedRefs，使下游的 shape/gone/state 能找回本 relay。
		down.relayedRefs.set(this.downId, this);
		// 解构原始帧中需要转发的字段：at（目标 host）、token（契约）、input（对象参数）。
		const { at, token, input } = this.frame;
		// 发送下游 hold：id 换成 downId，其余字段保留；principal 与 origin 由本 relay 盖章。
		down.send({
			t: "hold",
			id: this.downId,
			at,
			token,
			input,
			principal: this.principal,
			// origin 存在时转发；undefined 表示 host 自己的 hold，不写该字段。
			...(this.originTag === undefined ? {} : { origin: this.originTag }),
			// 消费者不要状态时显式发送 state: false，避免下游默认推送。
			...(this.stateWanted ? {} : { state: false as const }),
			// again 只在下游需要区分“重新 hold”时转发。
			...(this.frame.again === true ? { again: true as const } : {}),
		});
		// 唤醒所有等待路由的调用方。
		for (const waiter of this.#waiters) waiter.resolve(down);
		// 清空等待者，避免重复 resolve。
		this.#waiters.clear();
	}

	/** The origin starts or stops the hold's state. */
	// wantState：origin 开始或停止 hold 的状态。
	// 输入：wanted。副作用：更新 stateWanted；关闭状态时清掉 origin 侧排队内容与 awaiting；
	// 下游已连接时发送 sub/unsub。
	// 示例：origin 收到 sub 帧 -> relay.wantState(true) -> 下游收到 sub(hold=downId)。
	// 注意：状态没有变化时直接返回，避免重复帧。
	wantState(wanted: boolean): void {
		// 已关闭或状态未变化：无需转发。
		if (this.closed || wanted === this.stateWanted) return;
		// 记录新的状态意图。
		this.stateWanted = wanted;
		// 从开启变为关闭：清理本 relay 的等待数据。
		if (!wanted) {
			// 丢弃 origin 侧为该 hold 排队的 state 帧。
			this.origin.dropHoldState(this.originId);
			// 不再等待任何成员的 reset：状态已经关闭。
			this.awaiting.clear();
		}
		// 下游已经连接时转发 sub/unsub；尚未连接时，open 会用 stateWanted 决定是否发送 state: false。
		this.down?.send({ t: wanted ? "sub" : "unsub", hold: this.downId });
	}

	/**
	 * The origin could not keep up and dropped what waited for member `m` (or asked for it again): ask downstream for a
	 * reset, and ignore its ops until the reset arrives.
	 */
	// resync：origin 丢弃了成员 m 的 ops（或主动要求重发），请求下游发送 reset。
	// 输入：成员名。副作用：把 m 加入 awaiting（在 reset 到达前忽略其 ops），向下游发 resync。
	// 示例：relay.state 发现窗口溢出 -> resync("title") -> 下游回一个 reset 快照。
	// 注意：awaiting 是“忽略 ops 直到 reset”的状态，防止丢弃后的增量被错误拼接到旧快照。
	// 已关闭时直接返回；下游还没连接时只记录 awaiting，open 后不会补发 resync（下游会通过首个 unit 给全量快照）。
	resync(m: string): void {
		// 已关闭：不再转发。
		if (this.closed) return;
		// 标记该成员等待 reset；期间到达的 ops 会被丢弃。
		this.awaiting.add(m);
		// 下游存在时请求 reset；不存在时，下游的下一个 unit 会提供完整快照。
		this.down?.send({ t: "resync", hold: this.downId, m });
	}

	/** A shape from downstream: forwarded at once; the members of the first unit then skip the origin's window. */
	// shape：下游发来的对象形态，转发给 origin。
	// 输入：shape 帧。副作用：第一个 shape 记录 urgent 成员集合（首个 unit 的成员绕过 origin 窗口）；
	// 把 id 换回 originId 后发送。
	// 示例：下游 shape.members = ["title", "add"]，state = ["title"] -> origin 收到同一 shape。
	// 注意：again 为 true（重新 hold）时不设置 urgent：此时 origin 已有旧值，不需要绕过窗口抢首屏。
	shape(frame: Extract<Frame, { t: "shape" }>): void {
		// 已关闭：忽略迟到的 shape。
		if (this.closed) return;
		// 只处理第一个 shape：后续 shape 是对象变体变化，urgent 只对首次 unit 有意义。
		if (!this.#shaped) {
			// 标记已经见过 shape。
			this.#shaped = true;
			// 首个 unit 的成员集合来自 shape.state；这些成员的 state 帧会在 state() 中直接发送。
			if (this.frame.again !== true) this.urgent = new Set(frame.state);
		}
		// 转发给 origin，id 换回 origin 侧的 hold id。
		this.origin.send({ ...frame, id: this.originId });
	}

	/** A state frame from downstream. */
	// state：下游发来的成员状态帧，转发给 origin。
	// 输入：state 帧。副作用：awaiting 中的成员在 reset 到达前丢弃 ops；urgent 成员直接发送，
	// 其余成员走 origin 的 sendState（受窗口与溢出策略约束）。
	// 示例：下游发 title 的 ops -> 若 origin 窗口满，则排队；溢出时调用 resync 请求下游 reset。
	// 注意：中继不解析 value/ops，只改 hold id 后转发，保持“中继不解析负载”的规则。
	state(frame: StateFrame): void {
		// 已关闭：忽略迟到的状态。
		if (this.closed) return;
		// 取出成员名。
		const m = frame.m;
		// 该成员正在等待 reset：ops 会破坏快照一致性，必须丢弃。
		if (this.awaiting.has(m)) {
			// ops 直接丢弃；reset/snap/error 到达后解除等待。
			if (frame.as === "ops") return;
			// 非 ops 帧（reset/snap/error）表示下游已经重新同步，解除等待。
			this.awaiting.delete(m);
		}
		// 构造转发帧：hold 换回 originId，其余字段（m/as/value/ops/error）不变。
		const out: StateFrame = { ...frame, hold: this.originId };
		// urgent 成员属于首个 unit：直接发送，绕过 origin 的窗口，保证 ctx.get 尽快完成。
		if (this.urgent?.delete(m) === true) {
			// 直接发送并返回；delete 返回 true 表示该成员确实在 urgent 集合中。
			this.origin.send(out);
			return;
		}
		// 普通成员：走 origin 的 sendState，溢出时让下游 resync。
		this.origin.sendState(out, { resync: () => this.resync(m) });
	}

	/**
	 * Closes the relay. `releaseDown`: the downstream hold is still there (origin released, disconnected, or was
	 * revoked): cancel its calls and release it. `notify`: tell the origin the hold is gone.
	 */
	// close：关闭 relay 并撤销它做过的一切（幂等）。
	// 输入：error（传给等待者与下游调用的错误）、options.releaseDown（是否向下游发 release）、
	// options.notify（是否向 origin 发 gone）。
	// 副作用：取消所有下游调用、丢弃 origin 排队状态、从 origin.served 删除、从下游 relayedRefs 删除、
	// 按需发 release、拒绝 #waiters、按需发 gone。
	// 示例：origin 释放 hold -> close(new ChordError("released", ...), { releaseDown: true, notify: false })
	// 注意：先置 closed，保证递归调用（例如 cancel 触发 close）不会重复清理。
	close(error: unknown, options: { readonly releaseDown: boolean; readonly notify: boolean }): void {
		// 已经关闭：幂等返回。
		if (this.closed) return;
		// 先标记关闭，后续清理中的回调即使重入也不会再次执行。
		this.closed = true;
		// 复制一份调用列表再遍历：cancel 可能修改 relay.calls。
		for (const call of [...this.calls.values()]) call.cancel(error, options.releaseDown);
		// 丢弃 origin 侧为该 hold 排队的 state。
		this.origin.dropHoldState(this.originId);
		// 如果 origin.served 仍指向本 relay，删除它；已被替换时不误删新 hold。
		if (this.origin.served.get(this.originId)?.kind === "relay") this.origin.served.delete(this.originId);
		// 下游存在时清理下游侧映射。
		if (this.down !== undefined) {
			// 删除 relayedRefs，之后下游的迟到帧会被忽略。
			this.down.relayedRefs.delete(this.downId);
			// releaseDown：下游仍持有对象时发送 release；下游自己 gone 时不需要。
			if (options.releaseDown) this.down.send({ t: "release", id: this.downId });
		}
		// 拒绝所有等待路由的调用。
		for (const waiter of this.#waiters) waiter.reject(error);
		// 清空等待者。
		this.#waiters.clear();
		// notify：告诉 origin 这个 hold 已经结束（对象 gone、授权撤销等）。
		if (options.notify) this.origin.send({ t: "gone", id: this.originId, error: toWireError(error) });
	}
}

/** One relayed call: settles once, by result, cancellation or the relay closing; removes both mappings. */
// RelayCall：一次经 relay 转发的调用。
// 它连接 origin 侧 call id 与下游 call id，保证结果/取消只结算一次，并同时清理两侧 Map。
export class RelayCall {
	// 所属 relay。
	readonly relay: RelayRef;
	// origin 连接上的 call id。
	readonly originId: number;
	// 下游连接上的 call id。
	readonly downId: number;
	// origin 侧等待结果的 Promise 控制块。
	readonly #pending: Pending;
	// 是否已经结算；防止 result 与 cancel 竞争导致二次 resolve/reject。
	#settled = false;

	// constructor：登记到 relay 的两侧映射。
	// 输入：relay、originId、downId、pending。
	// 副作用：relay.calls.set(originId, this) 与 relay.down.relayedCalls.set(downId, this)。
	// 示例：const call = new RelayCall(relay, 3, 9, { resolve, reject });
	// 注意：down 可能尚未存在（构造时路由已解析，通常存在）；可选链保证安全。
	constructor(relay: RelayRef, originId: number, downId: number, pending: Pending) {
		this.relay = relay;
		this.originId = originId;
		this.downId = downId;
		this.#pending = pending;
		// origin 侧映射：relay.calls 由 RelayRef.state/close 使用。
		relay.calls.set(originId, this);
		// 下游侧映射：下游 result 到达时通过 downId 找回本对象。
		relay.down?.relayedCalls.set(downId, this);
	}

	// finish：结算调用（只生效一次），并删除两侧映射。
	// 输入：error（undefined 表示成功）、value。
	// 副作用：从 relay.calls 与 relay.down.relayedCalls 删除；resolve 或 reject pending。
	// 示例：下游 result error=undefined, value=42 -> finish(undefined, 42)。
	// 注意：先置 #settled 再结算，避免 resolve 触发的回调重入 cancel/finish。
	finish(error: unknown, value?: unknown): void {
		// 已结算：忽略重复结果。
		if (this.#settled) return;
		// 标记已结算。
		this.#settled = true;
		// 删除 origin 侧映射。
		this.relay.calls.delete(this.originId);
		// 删除下游侧映射（down 可能已被关闭）。
		this.relay.down?.relayedCalls.delete(this.downId);
		// error 为 undefined 表示成功；否则拒绝。
		if (error === undefined) this.#pending.resolve(value);
		else this.#pending.reject(error);
	}

	/** Cancels downstream (when the downstream hold still exists) and settles with `error`. */
	// cancel：取消转发中的调用：按需向下游发 cancel，然后以 error 结算。
	// 输入：error、forward（下游 hold 是否仍然存在）。
	// 副作用：forward 为 true 时发送 cancel 帧；随后 finish(error)。
	// 示例：origin 的 signal 中止 -> call.cancel(abortedError, true)。
	// 注意：forward 为 false 表示下游已经结束，不需要再通知。
	cancel(error: unknown, forward: boolean): void {
		// 已结算：忽略。
		if (this.#settled) return;
		// 下游仍存在时通知它取消执行；否则只做本地结算。
		if (forward) this.relay.down?.send({ t: "cancel", id: this.downId });
		// 结算并清理映射。
		this.finish(error);
	}
}

// ─── connection ──────────────────────────────────────────────────────────────

// Connection：一条链路在本 host 上的“本端对象”，同时扮演三个角色。
// 1. 消费者（implements RemoteChannel）：RemoteBinding 通过 hold/release/wantState/call 让本 host 去请求对端对象；
//    对应的回复（shape/gone/state/result）在 #receive 中回到 binding。
// 2. 提供者：对端 hold 本 host 的对象时，Connection 负责 acquire 引用、订阅状态成员并推送 unit/ops，
//    对端调用方法时通过 host.root/joinRoot 建立调用上下文并回送 result。
// 3. 中继（relay）：hold 的 at 不是本 host 时，创建 RelayRef，把请求转发给真正拥有对象的下一跳，
//    并把下游的 shape/state/result 转发回 origin。
//
// 上游入口：HostImpl.accept（downstream，本 host 接受客户端/子 host）或 HostImpl.connect（upstream，本 host
// 连向父 host）创建本对象；link.receive 的每一帧进入 #receive，link.onClose 进入 #closed。
// 下游依赖：link.ts（发送/关闭/尺寸）、wire.ts（Frame schema、协议版本、错误线格式）、contract.ts（重建契约、
// 解析 placement）、object.ts（RefImpl 的状态成员与方法调用）、host.ts（acquire、root、relay、重载控制）、
// delta（每个成员流的 Encoder）、schema（快照校验）。
//
// 下面的英文 JSDoc 详细描述了 state unit 与流量控制的设计；这里给出中文要点，便于先建立整体模型：
// - unit = shape 帧 + 每个 state 成员的快照帧；之后同一成员用 ops（增量）或 reset（整体替换）继续。
// - 消费者对收到的帧做累计确认（ack n），发送方统计“已发未确认”的字节数；超过 window 时 state 帧排队，
//   但首个 unit、result、shape、gone、重载控制帧和 ping/pong 不受窗口限制。
// - 排队总量超过 pendingCap 时，provider 丢弃最老的流并在 flush 时重发当前值（reset），relay 则向下游发 resync。
// - 双方都必须声明 acks；不报告尺寸的链路（IPC）永远不会把窗口填满。
//
// 建议阅读顺序：先读 RelayRef/RelayCall（relay 段），再读类字段理解每个 Map 的所有者，
// 然后读构造函数与 send/sendState/#flush 的流量控制，最后读 #receive 的分派及各 #onXxx 状态机。
/**
 * One end of a link on a host: consumer of remote references, provider for the peer's holds, and relay.
 *
 * State
 * -----
 *
 * A hold implies the state of its variant (unless it says `state: false`). The provider answers with a unit: the shape,
 * then a snapshot of each state member the consumer does not have yet (`shape.state` lists them), then the members'
 * ops and resets. A reload or a variant change sends another unit with the members that are new; members that left the
 * variant stop. The consumer applies a shape once its snapshots are here (`RemoteBinding`).
 *
 * Flow control
 * ------------
 *
 * Problem: state is pushed as fast as it changes, but a peer may read slowly (a phone behind a relay), and a relay may
 * hide that: Cloudflare forwards to browsers without backpressure. Everything sent then queues in front of the next
 * call result. Example: a browser opens three long transcripts (500 KiB of snapshots each) over a 5 Mbit/s path; a
 * result sent next waits 2.4 s, and the snapshot of a transcript the user already left is still sent in full.
 *
 * Solution: the peer acknowledges what it processed (`ack`, a cumulative frame count), and the sender counts the sizes
 * of the frames not yet acknowledged. While they exceed the window, state waits here in slots, flushed in creation
 * order as acknowledgements come:
 * - a member's stream has one slot: ops are appended (encoded batches of one stream may be concatenated, see
 *   `encoder`), a snapshot, reset or error replaces it;
 * - a hold's unit has one slot, built lazily from the current values when it is sent, so a newer unit merges into it;
 *   while it waits, the members it introduces have no stream yet.
 *
 * The first unit of a hold that is not a re-hold (`again`) is sent at once, past the window: a `get` waits for it, and
 * must not wait behind other holds' state. Results, shapes, gone, reload control and pings are sent at once too: they
 * are bounded by the requests the peer makes. Hence the one ordering exception of a link: while state waits, a result
 * can arrive before state changes made before it. Frames of one stream stay in order.
 *
 * Waiting ops are capped per link (`pendingCap`): beyond, the oldest streams are replaced by their current value (a
 * reset built at flush), or, on a relay, by a reset asked of the provider (`resync`), so memory stays bounded however
 * long the peer stalls. The window bounds what is unacknowledged when a frame is sent, so one frame (a large snapshot)
 * may exceed it. Both hellos must announce `acks`; with an older peer nothing is acknowledged and nothing waits. Links
 * that do not report sizes (IPC) never fill the window.
 */
// Connection 类的实现开始。字段分成四组：连接身份、流控计数、消费侧映射、提供侧/中继映射。
export class Connection implements RemoteChannel {
	// 所属 host：提供 acquire/root/relay/report 等能力，是所有业务操作的最终落点。
	readonly host: HostImpl;
	// 底层链路：只负责收发字节/对象和关闭通知，不理解帧语义。
	readonly link: Link;
	/** `upstream`: the link to this host's parent. `downstream`: a link this host accepted. */
	// 方向：upstream 表示本 host 是子端（连向父 host）；downstream 表示本 host 是服务端（接受别人）。
	readonly role: "upstream" | "downstream";
	// 对端身份：accept 时声明（downstream）或由父 host 的 hello 公告（upstream 的 name 另存在 #parentName）。
	readonly peer: Peer;
	/** A client connection's opaque id: holds that come over it (directly or relayed) carry it as their `origin`. */
	// 客户端连接的稳定标识；该连接上的 hold（含 relay 转发的 hold）都以它作为 origin。
	readonly originId: string | undefined;
	// 本连接当前盖章的 principal；revoke 时可以换成新的 principal，而不是断开连接。
	principal: unknown;
	// revoke(invalidatePrincipal) 时的重盖章函数：返回新 principal 表示保留链路，返回 undefined 表示关闭。
	readonly restamp: ((principal: unknown) => unknown | undefined) | undefined;
	/** Bumped when the stamped principal is revoked or re-stamped: relays from before are refused. */
	// 授权代际：每次重盖章/撤销加一；relay 记住创建时的代际，代际变化后旧 relay 立即失效。
	// 消费侧/提供侧都靠这个字段判断“旧授权下建立的转发是否还能继续”。
	generation = 0;
	/** The code version a downstream host peer runs (from its hello, then from commits). */
	// 子 host 对端当前运行的代码版本（来自 hello，之后由 host 的 commit 更新）。
	peerCodeVersion: number | undefined;
	/** A downstream host peer is usable once it runs this host's current code version (see `HostImpl.peerHello`). */
	// 子 host 是否已与本 host 的代码版本同步；未同步时 hold/call 需要等待（host 会协调或围栏）。
	synced: boolean;
	/** Code versions this child announced while behind this host (fenced): this host never ran them. */
	// 本 host 从未运行过、由子 host 公告的代码版本集合（被围栏的版本）。
	readonly fencedCodeVersions = new Set<number>();
	/** Roots of fenced code versions, by the code version of this host they were admitted in. */
	// 被围栏 root 的映射：rootId -> 本 host 接纳它时使用的代码版本（见 #admitRoot）。
	readonly #admitted = new Map<string, number>();
	// upstream 连接上父 host 公告的名字；downstream 连接使用 peer.name。
	#parentName: string | undefined;
	// 等待 whenSynced() 的 Promise 集合；同步完成或链路关闭时统一结算。
	readonly #syncWaiters = new Set<Pending>();
	// 下一条 hold/call/relay id；从 1 开始，单调递增，连接内唯一。
	#nextId = 1;
	// 最近一次收到帧的时间，用于 ping 超时判断。
	#lastSeen = Date.now();
	// 心跳定时器；ReturnType<typeof setInterval> 让类型同时兼容 Node 与浏览器实现。
	#pinger: ReturnType<typeof setInterval> | undefined;
	// 对端允许的并发调用上限（来自 AcceptOptions.maxCalls），Infinity 表示不限。
	readonly #maxCalls: number;
	// flow control (see the class comment)
	// 未确认字节数的窗口（默认 256 KiB）；超过后 state 帧排队。
	readonly #window: number;
	// 待发 state 字节上限（默认 4 个窗口）；超过后丢弃最老的流。
	readonly #pendingCap: number;
	/** Whether the peer acknowledges frames; until its hello is here, frames are counted in case it does. */
	// 对端是否确认帧：undefined 表示 hello 还没到（先按“可能确认”计数），false 表示对端不确认。
	#peerAcks: boolean | undefined;
	// 已发送的帧序号（累计）；ack 的 n 就是这个序号。
	#sent = 0;
	// 已被对端确认到的帧序号。
	#acked = 0;
	/** Sizes of the frames sent after the last acknowledged one. */
	// 最近一次 ack 之后发送的每帧大小（字节）；收到 ack 时按序号从头部移除。
	#unacked: number[] = [];
	// #unacked 中所有帧大小之和，用于和 window 比较。
	#unackedBytes = 0;
	// 等待发送的槽位：state 流（键 s<hold>\\0<member>）或 hold 的惰性 unit（键 u<hold>）。
	readonly #pending = new Map<string, Slot>();
	/** Bytes of ops waiting in `#pending`. */
	// #pending 中所有 state 槽位累计的 ops 字节数，用于 pendingCap。
	#pendingBytes = 0;
	// 已接收并处理（不含 ack）的帧数；回给对端的 ack.n。
	#received = 0;
	// 合并 ack 的定时器；同一轮事件循环内只安排一次。
	#ackTimer: ReturnType<typeof setTimeout> | undefined;
	// 应用提供的协议版本不一致回调；只调用一次。
	readonly #onProtocolMismatch: LinkOptions["onProtocolMismatch"];
	/** The peer speaks another protocol version: nothing it sends is processed any more. */
	// 已发现协议版本不一致：之后收到的帧全部忽略。
	#mismatched = false;
	// consumer side: what this host asked of the peer
	// 消费侧：本 host 发出的 hold id -> RemoteBinding。
	readonly remotes = new Map<number, RemoteBinding>();
	// 消费侧：本 host 发出的 call id -> 等待中的 resolve/reject。
	readonly calls = new Map<number, Pending>();
	// provider side: what the peer asked of this host
	// 提供侧：对端发来的 hold id -> 本地服务或 relay。
	readonly served = new Map<number, Served>();
	// 提供侧：对端发来的 call id -> 用于取消的 AbortController。
	readonly incoming = new Map<number, AbortController>();
	// downstream side of relays: ids this host used on this link
	// 中继的下游侧：本 host 在下游连接上使用的 hold id -> RelayRef。
	readonly relayedRefs = new Map<number, RelayRef>();
	// 中继的下游侧：本 host 在下游连接上使用的 call id -> RelayCall。
	readonly relayedCalls = new Map<number, RelayCall>();
	/** Reload votes awaited from this (child) peer. */
	// 重载投票：reload id -> 等待子 host 回复的 Promise。
	readonly votes = new Map<number, Pending>();

	// constructor：初始化连接身份、流控参数，注册链路回调，发送 hello，并启动心跳。
	// 输入：host、link，以及 config（role/principal/peer/originId/restamp/maxCalls + LinkOptions）。
	// 副作用：立即发送 hello；设置 link.onClose/link.receive；启动 ping 定时器（若链路未关闭）。
	// 错误：这里不抛错；链路已关闭时直接返回，后续清理由 #closed 完成。
	// 示例：new Connection(host, link, { role: "downstream", principal: "guest",
	//   peer: { kind: "client", name: undefined }, window: 64 * 1024 })
	// 注意：this.synced 的初值取决于方向与对端类型：只有 downstream host 需要等待代码版本同步。
	constructor(
		host: HostImpl,
		link: Link,
		config: {
			readonly role: "upstream" | "downstream";
			readonly principal: unknown;
			readonly peer: Peer;
			readonly originId?: string;
			readonly restamp?: (principal: unknown) => unknown | undefined;
			readonly maxCalls?: number;
		} & LinkOptions,
	) {
		// 身份字段直接保存，后续所有授权/寻址都以它们为准。
		this.host = host;
		// 保存链路引用；后续 send/close 都通过它。
		this.link = link;
		// 方向决定 principal/origin/hello 的处理方式。
		this.role = config.role;
		// 对端身份由 accept 时决定，hello 只做一致性校验。
		this.peer = config.peer;
		// 客户端连接的 originId 由 host.accept 分配；host 对端为 undefined。
		this.originId = config.originId;
		// 初始 principal；revoke 可能替换它。
		this.principal = config.principal;
		// 重盖章函数可选；没有时 revoke(undefined) 只能关闭连接。
		this.restamp = config.restamp;
		// downstream host 需要等代码版本同步；客户端和服务器的 upstream 连接立即可用。
		this.synced = !(this.role === "downstream" && this.peer.kind === "host");
		// 默认窗口 256 KiB；LinkOptions.window 可覆盖。
		this.#window = config.window ?? DEFAULT_WINDOW;
		// pendingCap 默认是窗口的 4 倍（PENDING_WINDOWS），按字节计。
		this.#pendingCap = config.pendingCap ?? this.#window * PENDING_WINDOWS;
		// maxCalls 默认 Infinity（Number.POSITIVE_INFINITY），即不限制并发。
		this.#maxCalls = config.maxCalls ?? Number.POSITIVE_INFINITY;
		// 保存协议版本不一致回调，供 #protocolMismatch 使用。
		this.#onProtocolMismatch = config.onProtocolMismatch;
		// 先注册关闭和收帧回调，再发 hello：即使对端已经发来帧，也不会丢。
		link.onClose((reason) => this.#closed(reason));
		// link.receive 的帧可能来自不可信对端，因此 #receive 的参数类型是 unknown。
		link.receive((frame) => this.#receive(frame));
		// 发送 hello：协议版本、本 host 名字/类型/当前代码版本，以及“本端支持 ack”的能力声明。
		this.send({
			t: "hello",
			protocol: PROTOCOL_VERSION,
			name: host.name,
			kind: host.kind,
			codeVersion: host.current.id,
			acks: true,
		});
		// 心跳间隔与超时都可以由 LinkOptions 覆盖。
		const interval = config.pingInterval ?? 15_000;
		// 默认 15 秒发一次 ping，45 秒没有任何帧就认为失联。
		const timeout = config.pingTimeout ?? 45_000;
		// A link that was already closed closed this connection above; it needs no keepalive.
		// 链路可能在构造前就已关闭（例如 WebSocket 立即断开）：此时 onClose 已触发过 #closed，
		// 不再启动心跳，避免定时器泄漏。
		if (link.closed) return;
		// n 是 ping 序号，只用于匹配 pong，不参与业务。
		let n = 0;
		// setInterval 每 interval 毫秒执行一次：先检查是否超时，否则发 ping。
		this.#pinger = setInterval(() => {
			// 超过 pingTimeout 没有收到任何帧：认为对端失联，主动关闭链路（触发 #closed）。
			if (Date.now() - this.#lastSeen > timeout) link.close("ping timeout");
			// 否则发送带序号的 ping；对端会回 pong，刷新 #lastSeen。
			else this.send({ t: "ping", n: ++n });
			// 定时器间隔；Node 返回 Timeout 对象，浏览器返回 number。
		}, interval);
		// unref?.() 让定时器不阻止 Node 进程退出；浏览器环境没有 unref，因此用可选调用。
		this.#pinger.unref?.();
	}

	// open：链路是否仍然打开。关闭后发送会被 link 层忽略，但调用方仍可据此快速失败。
	// 示例：if (connection.open) connection.send(frame);
	get open(): boolean {
		// link.closed 是链路层的真实状态。
		return !this.link.closed;
	}

	/** The peer's name: configured for downstream hosts, announced by the parent upstream. */
	// name：对端名字。upstream 连接使用父 host 在 hello 中公告的名字，downstream 使用 accept 时配置的名字。
	// 示例：错误信息 "link to session:S1 closed" 中的名字就来自这里。
	get name(): string | undefined {
		// 方向决定名字来源：父 host 的名字只能等 hello 到达后才知道。
		return this.role === "upstream" ? this.#parentName : this.peer.name;
	}

	// send：发送一帧，并在需要时记录它的大小用于流量控制。
	// 输入：Frame。输出：无。
	// 副作用：调用 link.send；若对端确认帧（或尚未确定），把本帧大小追加到 #unacked 并累计字节数。
	// 错误：link.send 抛错会向上传播；通常 link 层自己处理写失败并关闭链路。
	// 示例：connection.send({ t: "ping", n: 1 });
	// 注意：link.send 返回 undefined 表示该链路不报告尺寸（如 IPC），此时按 0 计，窗口永远不会满。
	send(frame: Frame): void {
		// ?? 0 兼容不报告尺寸的链路；这类链路实际上没有应用层背压。
		const size = this.link.send(frame) ?? 0;
		// 对端明确不支持 ack 时完全不计数，避免 #unacked 无限增长。
		if (this.#peerAcks === false) return;
		// 帧序号递增；ack.n 就是“已处理到第几帧”。
		this.#sent++;
		// 记录本帧大小，供收到 ack 时按序扣除。
		this.#unacked.push(size);
		// 累计未确认字节数；#full 用它和 window 比较。
		this.#unackedBytes += size;
	}

	// sendState：发送一个成员状态帧；窗口已满时把它放进该成员的槽位，等 ack 释放空间。
	// 输入：state 帧、溢出策略（provider 用 resend，relay 用 resync）。
	// 输出：无。副作用：可能立即发送、替换槽位中的快照、追加 ops、触发 #makeRoom 丢弃旧流。
	// 错误：不抛错；溢出时按策略降级（重发当前值或请求下游重置）。
	// 示例：connection.sendState({ t: "state", hold: 7, m: "title", as: "ops", ops }, {
	//   resend: () => this.#resend(served, "title") });
	// 注意：同一成员始终只有一个槽位，保证该成员的流内顺序；不同成员之间的顺序由 Map 插入顺序决定。
	/** Sends a state frame, or keeps it waiting (see the class comment). */
	sendState(frame: StateFrame, overflow: Overflow): void {
		// 槽位键由 hold 和成员名组成；unit 槽位用另一个前缀。
		const key = stateKey(frame.hold, frame.m);
		// 取出该成员已有的槽位；undefined 表示当前没有排队。
		let slot = this.#pending.get(key);
		// 没有槽位且窗口未满：直接发送，保持低延迟。
		if (slot === undefined && !this.#full) {
			// 直接发送；该帧仍会经过 send 的未确认字节统计。
			this.send(frame);
			return;
		}
		// 槽位是 unit：该成员的快照会由 unit 统一携带，单独的 state 帧不再发送（unit 会包含最新值）。
		if (slot?.kind === "unit") return;
		// 没有槽位但窗口已满：新建一个 state 槽位，后续 ops 先累积在这里。
		if (slot === undefined) {
			// 初始化槽位：base 保存快照/reset/error 帧，ops 保存增量，size 是当前 ops 的字节数。
			slot = {
				// 槽位类型标记：这是一个 state 流（而不是 unit）。
				kind: "state",
				hold: frame.hold,
				m: frame.m,
				base: undefined,
				ops: [],
				size: 0,
				// 窗口满时新建的槽位保存 base/ops，因此 lazy 为 false；后续若溢出再改为 true。
				lazy: false,
				overflow,
			};
			this.#pending.set(key, slot);
		}
		// 非 ops 帧（snap/reset/error）：整体替换槽位内容，旧的增量全部作废。
		if (frame.as !== "ops") {
			// 先扣除旧内容占用的字节数，再替换 base 并清空 ops/size。
			this.#pendingBytes -= slot.size;
			// 保存新的 base 帧。
			slot.base = frame;
			// 旧 ops 已被新快照覆盖。
			slot.ops = [];
			// size 归零，与清空 ops 保持一致。
			slot.size = 0;
			// lazy 必须复位：新的具体快照已经取代了“稍后重发”的计划。
			slot.lazy = false;
			// 新的 base 已经保存；返回，等待 flush 或后续 ops。
			return;
		}
		// lazy 槽位表示“flush 时会重发当前值”，这些具体 ops 已经被覆盖，直接丢弃。
		// A reset built at flush already covers these ops.
		// 具体 ops 会破坏“reset 后重新同步”的语义，因此不再追加。
		if (slot.lazy) return;
		// 用 JSON 文本长度估算 ops 的线上大小；与 window/pendingCap 使用同一单位（字节数近似）。
		const size = JSON.stringify(frame.ops).length;
		// 超过 pendingCap 时先丢弃最老的流给当前流腾空间。
		if (this.#pendingBytes + size > this.#pendingCap) this.#makeRoom(size, slot);
		// makeRoom 可能丢弃了当前槽位（把它变成 lazy 或删除），此时不能再把 ops 追加进去。
		if (slot.lazy || this.#pending.get(key) !== slot) return;
		// 把每个 op 追加到槽位；ops 是数组，逐项保存以保持顺序。
		for (const op of frame.ops ?? []) slot.ops.push(op);
		// 更新槽位大小。
		slot.size += size;
		// 更新全连接待发字节数。
		this.#pendingBytes += size;
	}

	// #makeRoom：在 pendingCap 压力下丢弃最老的 state 流，为新的 ops 腾出空间。
	// 输入：需要新增的字节数 size、当前正在写入的槽位 current。
	// 副作用：调用 #drop 把槽位变为 lazy reset（provider）或直接删除并请求 resync（relay）。
	// 规则：按 Map 插入顺序（最老的先）丢弃，跳过 unit 槽位（它们不是 ops 字节）和 current 本身；
	// 如果丢完其他流仍不够，再丢 current（当前这次 ops 本身也会被 reset 取代）。
	// 示例：pending 中有三个各 100 KiB 的流，cap 为 256 KiB，新流要 80 KiB：
	// 丢一个后 200 + 80 > 256，仍不够，所以丢两个；最后剩 100 + 80 = 180 KiB。
	/** Replaces the oldest waiting streams by resets until `size` more bytes fit; `current` last, if needed. */
	#makeRoom(size: number, current: Extract<Slot, { kind: "state" }>): void {
		// 按插入顺序遍历所有槽位；[...] 先复制一份，因为 #drop 可能修改 Map。
		for (const slot of [...this.#pending.values()]) {
			// 已经腾够空间就停止，避免不必要地丢弃更多流。
			if (this.#pendingBytes + size <= this.#pendingCap) return;
			// 只丢弃有实际 ops 字节的 state 槽位；unit 槽位不占 pendingBytes。
			if (slot.kind === "state" && slot !== current && slot.size > 0) this.#drop(slot);
		}
		// 其他流都丢完仍不够时，当前流也只能降级为 reset。
		if (this.#pendingBytes + size > this.#pendingCap) this.#drop(current);
	}

	// #drop：丢弃一个 state 槽位的待发内容，并按溢出策略安排恢复。
	// 输入：state 槽位。副作用：扣除字节数、清空 base/ops/size；
	// 若策略是 resend（provider），保留槽位并标记 lazy，flush 时重发当前值；
	// 若策略是 resync（relay），删除槽位并立即请求下游发送 reset。
	// 示例：provider 的一个成员积压被丢弃 -> slot.lazy = true -> #flush 调用 overflow.resend()。
	// 注意：'resend' in slot.overflow 是 TypeScript 的可辨识联合收窄：检查属性是否存在即可区分两种策略。
	/** Drops what waits for a stream: a lazy reset replaces it (provider), or the relay asks downstream for one. */
	#drop(slot: Extract<Slot, { kind: "state" }>): void {
		// 清空槽位内容并扣除对应字节数。
		this.#pendingBytes -= slot.size;
		// 丢弃旧快照：稍后会用最新值重新生成。
		slot.base = undefined;
		// 丢弃旧增量。
		slot.ops = [];
		// size 归零。
		slot.size = 0;
		// provider 的恢复方式：不立即重发，而是等 flush 时用最新值生成 reset，避免发送过期快照。
		if ("resend" in slot.overflow) {
			// 标记为 lazy；#flush 会调用 overflow.resend()。
			slot.lazy = true;
			return;
		}
		// relay 没有自己的值：删除槽位，并请求下游重新发送（downstream 会回 resync）。
		this.#pending.delete(stateKey(slot.hold, slot.m));
		// overflow.resync() 由 RelayRef 提供：向下游发 resync 帧。
		slot.overflow.resync();
	}

	// #resetLater：安排稍后把某个成员重新作为 reset 发送（用于下游 resync 请求）。
	// 输入：hold、成员名、resend 回调（provider 的 #resend）。
	// 副作用：创建/复用 lazy state 槽位，并立即尝试 flush。
	// 与 #drop 的区别：这里不是溢出，而是恢复请求；槽位初始就是 lazy，flush 时调用 resend。
	// 示例：收到 resync(hold=7, m="title") -> #resetLater(7, "title", () => this.#resend(served, "title"))。
	// 注意：如果已有 unit 槽位，reset 会被 unit 的最新快照覆盖，因此直接返回。
	/** Sends member `m` of a served hold again as a reset, through the window (`resync`). */
	#resetLater(hold: number, m: string, resend: () => void): void {
		// 槽位键与 sendState 使用同一命名规则，保证 reset 与旧 ops 落在同一个槽位。
		const key = stateKey(hold, m);
		// 取出已有槽位。
		let slot = this.#pending.get(key);
		// 已有 unit 槽位：unit 会包含最新值，无需单独的 reset。
		if (slot?.kind === "unit") return;
		// 没有槽位：创建 lazy 槽位。
		if (slot === undefined) {
			// overflow.resend 在 flush 时调用，用于重新生成当前值。
			slot = { kind: "state", hold, m, base: undefined, ops: [], size: 0, lazy: true, overflow: { resend } };
			// 登记新建的 lazy 槽位。
			this.#pending.set(key, slot);
			// 已有槽位：清空旧内容并转为 lazy，等待 flush。
		} else {
			// 扣除旧内容字节数。
			this.#pendingBytes -= slot.size;
			// 丢弃旧 base。
			slot.base = undefined;
			// 丢弃旧 ops。
			slot.ops = [];
			// size 归零。
			slot.size = 0;
			// 标记 lazy。
			slot.lazy = true;
		}
		// 立即尝试发送（如果窗口允许）；否则它会留在队列里等 ack。
		this.#flush();
	}

	// #queueUnit：把一个 hold 的 unit 放入惰性槽位；同一个 hold 只保留一个 unit。
	// 输入：hold id、flush 回调（调用 #sendUnit）。
	// 副作用：登记 unit 槽位（若不存在）并立即尝试 flush。
	// 语义：unit 在真正发送时才构建，因此排队期间对象可以继续变化，最终只发最新形态。
	// 示例：对象首次上线触发 #queueUnit(7, () => this.#sendUnit(served))。
	/** Queues a hold's lazy unit (a waiting one already covers this one), and sends what the window allows. */
	#queueUnit(hold: number, flush: () => void): void {
		// 键前缀 "u" 与 state 槽位区分。
		const key = unitKey(hold);
		// 已有同 hold 的 unit 时不重复登记：旧 unit 的 flush 会构建最新值。
		if (!this.#pending.has(key)) this.#pending.set(key, { kind: "unit", hold, flush });
		// 立即按窗口尝试发送。
		this.#flush();
	}

	// dropState：忘记一个成员流的排队内容（成员离开变体、hold 释放或 state 关闭时）。
	// 输入：hold、成员名。副作用：扣除 pendingBytes 并删除槽位。
	// 错误：槽位不存在或不是 state 槽位时直接返回。
	// 示例：对象切换到不含 "draft" 的变体 -> dropState(7, "draft")。
	/** Forgets what waits for a stream that ended. */
	dropState(hold: number, m: string): void {
		// 取出槽位。
		const slot = this.#pending.get(stateKey(hold, m));
		// 只处理 state 槽位；unit 槽位由 dropHoldState 统一清理。
		if (slot?.kind !== "state") return;
		// 扣字节数。
		this.#pendingBytes -= slot.size;
		// 删除槽位。
		this.#pending.delete(stateKey(hold, m));
	}

	// dropHoldState：忘记一个 hold 的所有排队内容（state 与 unit 都包括）。
	// 输入：hold id。副作用：删除所有属于该 hold 的槽位并扣减字节数。
	// 示例：客户端 release hold 7 -> dropHoldState(7)。
	// 注意：遍历时删除 Map 项是安全的（每次 delete 当前项，迭代器继续）。
	/** Forgets everything that waits for a hold (released, closed, or its state stopped). */
	dropHoldState(hold: number): void {
		// 遍历所有槽位。
		for (const [key, slot] of this.#pending) {
			// 不属于该 hold 的槽位保持不动。
			if (slot.hold !== hold) continue;
			// state 槽位占 pendingBytes，需要扣减；unit 槽位不占。
			if (slot.kind === "state") this.#pendingBytes -= slot.size;
			// 删除当前键；Map 允许在迭代中删除当前项。
			this.#pending.delete(key);
		}
	}

	// waiting：观测接口，返回排队中的槽位数量和 ops 字节数（测试与诊断使用）。
	// 示例：expect(connection.waiting.bytes).toBeLessThan(cap);
	/** What waits for the peer: slots and bytes of ops (for tests and diagnostics). */
	get waiting(): { readonly slots: number; readonly bytes: number } {
		// 返回快照，而不是内部对象，避免调用方修改连接状态。
		return { slots: this.#pending.size, bytes: this.#pendingBytes };
	}

	// #full：窗口是否已满。只有对端明确支持 ack 且未确认字节数达到窗口时才为真。
	// 不报告尺寸的链路（link.send 返回 undefined）size 恒为 0，因此永远不会满。
	get #full(): boolean {
		// hello 未到时 peerAcks 为 undefined：可以先计数，但在确认对端支持 ack 之前不阻塞发送；
		// peerAcks 为 false 表示对端不确认，send 也不再计数。两种情况都不会让窗口生效。
		return this.#peerAcks === true && this.#unackedBytes >= this.#window;
	}

	// #onAck：处理对端的累计确认，释放对应帧的字节数并唤醒排队中的槽位。
	// 输入：n（已处理到的帧序号）。输出：无。
	// 错误：n 小于已确认值或大于已发送值，说明对端 ack 越界，按协议违规断链。
	// 流程：校验范围 -> 从 #unacked 头部移除 n - acked 个大小 -> 更新 acked -> flush。
	// 示例：已发 5 帧（大小 10,20,30,40,50），收到 ack 3 -> 移除前 3 项，unackedBytes 减少 60。
	// 注意：ack 是累计的，不需要逐帧确认；重复或乱序的旧 ack 会被范围校验拒绝。
	#onAck(n: number): void {
		// 只有对端明确支持 ack 时才接受 ack；越界（回退或超过已发送）都是协议错误。
		if (this.#peerAcks !== true || n < this.#acked || n > this.#sent) {
			// 越界直接断链；不尝试猜测对端意图。
			this.#violation(`ack ${n} outside ${this.#acked}..${this.#sent}`);
			return;
		}
		// splice(0, count) 删除并返回最老的 count 个大小，逐个从总字节数中扣除。
		for (const size of this.#unacked.splice(0, n - this.#acked)) this.#unackedBytes -= size;
		// 记录新的最高确认序号。
		this.#acked = n;
		// 释放空间后立即尝试发送排队槽位。
		this.#flush();
	}

	// #flush：按创建顺序发送排队槽位，直到窗口再次变满。
	// 输入：无。副作用：删除槽位、发送帧、触发惰性 unit 或 resend、扣减 pendingBytes。
	// 关键点：unit 槽位的 flush 回调可能在发送时又产生新的 state 帧（#sendUnit），因此先删除槽位再调用。
	// 示例：ack 到达后 #flush 依次发送成员 A 的 ops、成员 B 的 reset、hold 的 unit。
	/** Sends waiting slots in creation order while the window allows. */
	#flush(): void {
		// 按 Map 插入顺序遍历：先排队的先发送，保证同一成员的流内顺序。
		for (const [key, slot] of this.#pending) {
			// 窗口满时停止；剩余槽位等下一次 ack。
			if (this.#full) return;
			// 先删除当前槽位再发送，避免 flush 回调重入时重复处理。
			this.#pending.delete(key);
			// unit：调用惰性构建函数；它内部会发送 shape + 快照。
			if (slot.kind === "unit") {
				// 构建并发送最新形态；随后继续处理下一个槽位。
				slot.flush();
				continue;
			}
			// state：先扣 pendingBytes（ops 是否发送都会离开队列）。
			this.#pendingBytes -= slot.size;
			// lazy：不需要保存 base，provider 调用 resend 重新生成当前值；relay 的 lazy 槽位已经在 #drop 时删除。
			if (slot.lazy) {
				// provider 的 resend：重新订阅并从当前值发 reset。
				if ("resend" in slot.overflow) slot.overflow.resend();
				continue;
			}
			// 有具体 base（snap/reset/error）时先发它。
			if (slot.base !== undefined) this.send(slot.base);
			// 再发累积的 ops；同一成员的 base 与 ops 必须保持顺序。
			if (slot.ops.length > 0) this.send({ t: "state", hold: slot.hold, m: slot.m, as: "ops", ops: slot.ops });
		}
	}

	// #scheduleAck：安排一次合并 ack；同一轮事件循环内只安排一次。
	// 输入：无。副作用：setTimeout(0) 后发送 { t: "ack", n: this.#received }。
	// 条件：对端支持 ack、当前没有已安排的 timer、链路仍打开；否则不安排。
	// 示例：一轮收到 10 个 state 帧 -> 只回一个 ack n=10，而不是 10 个 ack。
	// 注意：ack 直接走 link.send 而不是 this.send，因为 ack 本身不参与“未确认帧”计数。
	/** Acknowledges once the frames that arrived together are processed: one ack per burst, not per frame. */
	#scheduleAck(): void {
		// 对端不支持 ack、已有 timer、或链路已关闭时都不需要安排。
		if (this.#peerAcks !== true || this.#ackTimer !== undefined || !this.open) return;
		// timer 触发时先清空引用，再发送 ack。
		this.#ackTimer = setTimeout(() => {
			// 清空 timer 引用，允许下一批帧重新安排。
			this.#ackTimer = undefined;
			// 发送当前已接收帧数；ack 之后到达的帧会触发新的 scheduleAck。
			this.link.send({ t: "ack", n: this.#received });
		}, 0);
		// unref?.() 避免 ack 定时器阻止 Node 进程退出。
		this.#ackTimer.unref?.();
	}

	// nextId：分配下一个连接内唯一的 id（hold/call/relay 共用）。
	// 示例：const id = connection.nextId(); // 1, 2, 3, ...
	// 注意：后置 ++ 返回旧值，因此第一个 id 是 1。
	nextId(): number {
		// 先返回再自增。
		return this.#nextId++;
	}

	// whenSynced：等待对端可用（downstream host 运行本 host 的代码版本）。
	// 输入：无。输出：Promise<void>。错误：链路已关闭时以 unavailable 拒绝；
	// 若已经同步则立即 resolve；否则登记 waiter，等 markSynced 或 #closed 结算。
	// 示例：await connection.whenSynced(); // 之后才能向子 host 发送需要新代码版本的 hold
	// 注意：只有 downstream host 对端会把 synced 初始化为 false；客户端对端和 upstream 连接
	// 在构造函数中已经是 synced = true，因此直接 resolve。
	/** Resolves once the peer is usable (a host peer runs this host's code version); rejects if the link closes first. */
	whenSynced(): Promise<void> {
		// 链路关闭后不可能再同步，直接拒绝。
		if (!this.open) return Promise.reject(unavailable(`link to ${this.name ?? "peer"} closed`));
		// 已同步：无需等待。
		if (this.synced) return Promise.resolve();
		// 尚未同步：登记 resolve/reject，由 markSynced/#closed 结算；resolve 的签名适配 Pending 的 unknown 参数。
		return new Promise<void>((resolve, reject) => this.#syncWaiters.add({ resolve: resolve as () => void, reject }));
	}

	// markSynced：标记子 host 已同步到 codeVersion，并唤醒所有等待者。
	// 输入：子 host 的代码版本。副作用：更新 peerCodeVersion、synced，结算 #syncWaiters。
	// 示例：host.peerHello(connection, 7) 内部在版本匹配时调用 markSynced(7)。
	// 注意：resolve(undefined) 因为 Promise 是 Promise<void>。
	markSynced(codeVersion: number): void {
		// 记录对端代码版本，用于后续 hold/call 的版本检查。
		this.peerCodeVersion = codeVersion;
		// 标记可用：之后 whenSynced 直接 resolve。
		this.synced = true;
		// 唤醒所有等待者。
		for (const waiter of this.#syncWaiters) waiter.resolve(undefined);
		// 清空集合；重复调用是幂等的。
		this.#syncWaiters.clear();
	}

	// revoke：撤销/重盖章本连接的 principal（来自父 host 的 invalidate 控制帧）。
	// 输入：next（新 principal；undefined 表示关闭连接）。输出：无。
	// 副作用：generation 加一（使旧 relay 失效）；关闭所有 relay 并通知 origin；必要时关闭链路或替换 principal。
	// 错误：不抛错；关闭 relay 的错误通过 gone 帧传给 origin。
	// 示例：管理员撤销 guest 权限 -> revoke(undefined) -> 所有 relay 收到 gone("principal invalidated")。
	// 注意：即使 next 存在，旧 relay 也必须关闭：它们是在旧授权下建立的，不能沿用。
	// 重新 hold 会使用新 principal 并建立新的 relay（generation 已更新）。
	/** Revokes the stamped principal: relays made under it close at once (also those still resolving a route). */
	revoke(next: unknown | undefined): void {
		// 代际加一：RelayRef.current 会比较 generation，旧 relay 立即失效。
		this.generation++;
		// 统一的撤销错误，用于结算 relay 中的调用和等待者。
		const error = new ChordError("gone", "principal invalidated");
		// 关闭所有 relay：释放下游 hold、取消下游调用、通知 origin。
		for (const served of [...this.served.values()]) {
			// releaseDown 为 true：下游可能仍持有对象，需要释放；notify 为 true：origin 需要收到 gone。
			if (served.kind === "relay") served.relay.close(error, { releaseDown: true, notify: true });
		}
		// 没有新 principal：关闭链路。
		if (next === undefined) this.link.close("principal invalidated");
		// 有新的 principal：替换盖章身份；之后到达的 hold/call 以新身份执行。
		else this.principal = next;
	}

	// #protocolMismatch：处理对端协议版本不一致：通知应用并关闭链路。
	// 输入：peer（对端版本，undefined 表示未声明）、close（是否由本端关闭链路）。
	// 副作用：#mismatched 置真（之后忽略所有帧）；调用 onProtocolMismatch；关闭链路并附带本端版本。
	// 错误：应用回调抛错时交给 host.report，不影响关闭流程。
	// 示例：对端 hello.protocol = 3，本端 PROTOCOL_VERSION = 4 ->
	//   onProtocolMismatch({ local: 4, peer: 3 })，随后 close("protocol-version 4")。
	// 注意：关闭原因 "protocol-version <n>" 让对端知道本端版本；对端先用同一格式通知时，
	// #closed 会解析它并把 close 设为 false，避免两边互相关闭。
	/**
	 * Stops talking to a peer of another protocol version: reports it and closes the link. The close reason tells the
	 * peer this side's version (`protocol-version <n>`); a peer that noticed first told us the same way (`#closed`).
	 */
	#protocolMismatch(peer: number | undefined, close = true): void {
		// 只报告一次；后续帧不再处理。
		if (this.#mismatched) return;
		// 标记为不一致，后续 #receive 直接返回。
		this.#mismatched = true;
		// 回调可能由应用提供，抛错不应阻止断链。
		try {
			// 把本端与对端版本交给应用；peer 可能为 undefined（对端未声明版本）。
			this.#onProtocolMismatch?.({ local: PROTOCOL_VERSION, peer });
			// 捕获回调异常。
		} catch (error) {
			// 报告给 host 的 onError，不让应用回调破坏连接清理。
			this.host.report(error);
		}
		// 关闭链路，并把本端版本写进原因，供对端识别；close = false 时链路已经由对端关闭。
		if (close) this.link.close(`protocol-version ${PROTOCOL_VERSION}`);
	}

	// #violation：处理协议违规：报告错误并关闭链路。
	// 输入：原因字符串。输出：无。
	// 错误 details.reason = "protocol" 让应用区分协议错误与普通业务错误。
	// 示例：收到重复 hold id -> #violation("duplicate hold id 7") -> close("protocol error: ...")。
	// 注意：违规意味着对端不可信，链路上的所有未决操作都会在 #closed 中被拒绝。
	/** A protocol violation: the peer cannot be trusted with anything on this link any more. */
	#violation(reason: string): void {
		// 报告给 host 的 onError；错误码 invalid 表示对端违反了协议。
		this.host.report(new ChordError("invalid", `link to ${this.name ?? "peer"}: ${reason}`, { reason: "protocol" }));
		// 关闭链路；具体原因保留在关闭信息中。
		this.link.close(`protocol error: ${reason}`);
	}

	// ─── 消费侧（RemoteChannel 接口）───
	// 以下四个方法是 RemoteBinding 与 Connection 的契约：绑定只关心“发请求/取消/开关状态”，
	// 具体的帧格式、id 分配和结果路由都由 Connection 负责。
	// ─── consumer side (RemoteChannel) ───

	// hold：为本 host 的一个 RemoteBinding 发送 hold 请求。
	// 输入：binding（包含 at/token/input/principal/stateOn 等信息）、again（是否重新 hold）。
	// 输出：新分配的 hold id。副作用：登记 remotes，通知 binding 已绑定，发送 hold 帧。
	// 错误：不抛错；对端的拒绝会以 gone 帧异步回到 binding.gone。
	// 示例：const id = connection.hold(binding, false); // binding.bound 已经收到同一个 id
	// 注意：principal 为 undefined 时不写该字段（使用对端的默认身份）；stateOn 为 false 时发送 state: false。
	hold(binding: RemoteBinding, again: boolean): number {
		// 分配 id 并登记。
		const id = this.nextId();
		// 先登记，保证对端回复 shape/gone 时能找到 binding。
		this.remotes.set(id, binding);
		// 通知 binding（它需要记录 channel/id，并可能触发等待中的调用）。
		binding.bound(this, id);
		// principal 只在存在时携带；undefined 表示“使用连接默认 principal”。
		const principal = binding.principal;
		// 发送 hold 帧；token 是契约描述，input 是对象参数。
		this.send({
			// t/id：帧类型与连接内唯一的 hold id。
			t: "hold",
			id,
			at: binding.at,
			token: binding.contract.description,
			input: binding.input,
			// 可选字段用条件展开：值为 undefined 时整个字段不出现，而不是传 null。
			...(principal === undefined ? {} : { principal }),
			// stateOn 为 false：消费者暂时不需要状态，先不发送快照。
			...(binding.stateOn ? {} : { state: false as const }),
			// again：重新 hold（已有旧值），首个 unit 不享受 urgent 绕过窗口。
			...(again ? { again: true as const } : {}),
		});
		// 返回新分配的 hold id，调用方用它 release/call/wantState。
		return id;
	}

	// release：释放一个本 host 发出的 hold。
	// 输入：hold id。副作用：从 remotes 删除并发送 release 帧。
	// 错误：未知 id 也会发送 release（对端会忽略），本地删除是幂等的。
	// 示例：binding 没有视图且 linger 到期 -> connection.release(id)。
	// 注意：删除本地映射后，迟到的 state/result 会被 #onState/#onResult 当作未知 id 忽略。
	release(id: number): void {
		// 先删除本地映射，再通知对端。
		this.remotes.delete(id);
		// 通知对端释放。
		this.send({ t: "release", id });
	}

	// wantState：开关一个本 host 发出的 hold 的状态流（对应帧是 sub/unsub）。
	// 输入：hold id、wanted。副作用：发送 sub 或 unsub。
	// 错误：未知 hold 不发送，避免向已释放的 hold 发无效帧。
	// 示例：UI 需要状态时 connection.wantState(id, true)；不再需要时 connection.wantState(id, false)。
	// 注意：只有仍登记在 remotes 中的 hold 才发送，防止 release 后的竞态。
	wantState(hold: number, wanted: boolean): void {
		// 已释放/未知的 hold 不再发送 sub/unsub；根据 wanted 选择帧类型。
		if (this.remotes.has(hold)) this.send({ t: wanted ? "sub" : "unsub", hold });
	}

	// call：消费者侧发起一次远程方法调用，返回一个在结果或错误到达时结算的 Promise。
	// 输入：hold（本连接上的 hold id）、member（方法名）、args（调用参数，原样随帧发送）、root（调用所属的
	// root，客户端没有）、signal（调用方的取消信号）。输出：远端返回的值（已经过 unpack 解包）。
	// 副作用：分配 call id 并登记到 this.calls；发出的 call 帧可能携带 root；取消时发出 cancel 帧。
	// 错误：信号已中止时立即以 aborted 拒绝；链路关闭时由 #closed 统一拒绝所有未决调用。
	// 示例：const value = await connection.call(7, "add", { text: "hi" }, undefined, signal);
	// 注意：这里只是“发出请求并等待结果”，真正的执行发生在对端（或更下游的 relay）。
	call(hold: number, member: string, args: unknown, root: RootRef | undefined, signal: AbortSignal): Promise<unknown> {
		// 调用 id 和 hold id 共用同一个递增计数器，保证同一连接上的 id 不重复。
		const id = this.nextId();
		// 用 Promise 包住“发帧 + 等待 result 帧”的整个过程，调用方拿到的是普通 Promise。
		return new Promise<unknown>((resolve, reject) => {
			// 如果信号在发帧前就已经中止，就不必浪费一次网络往返，直接拒绝。
			if (signal.aborted) {
				reject(new ChordError("aborted", "call aborted"));
				return;
			}
			// 中止回调：忘记本地的 pending 记录、通知对端取消、以 aborted 拒绝。
			const onAbort = (): void => {
				this.calls.delete(id);
				this.send({ t: "cancel", id });
				reject(new ChordError("aborted", "call aborted", { cause: signal.reason }));
			};
			// { once: true } 表示 abort 事件最多触发一次，避免重复执行上面的清理。
			signal.addEventListener("abort", onAbort, { once: true });
			// done 用于在结果正常到达时移除 abort 监听，防止 signal 长期持有本调用的闭包。
			const done = (): void => signal.removeEventListener("abort", onAbort);
			// this.calls 的键是 call id；值保存 resolve/reject，并在结算前先解除 abort 监听。
			this.calls.set(id, {
				resolve: (value) => {
					done();
					resolve(value);
				},
				reject: (error) => {
					done();
					reject(error);
				},
			});
			// 只有 host 类型的连接才搬运 root：client 没有代码版本和 root 的概念，服务器会为它新开 root。
			// Clients never carry roots or code versions: the server starts roots for them.
			// 告诉 host“这个 root 会经过这条连接”，让 host 记录 root 的生命周期与代码版本。
			const carried = root !== undefined && this.host.kind === "host";
			if (carried) this.host.rootSent(root.rootId, this);
			// 发出 call 帧；args 原样传递，root 只在 carried 为真时附带。
			// 注意：这里没有在发送前检查连接是否已关闭；关闭后的发送由 link 层忽略，未决调用由 #closed 清理。
			this.send({ t: "call", id, hold, member, args, ...(carried ? { root } : {}) });
		});
	}

	// ─── receiving ───

	// #receive：link.receive 的唯一入口，负责校验帧、更新心跳、分派并触发 ack。
	// 输入：frame（unknown，可能来自不可信的对端，因此先做 isFrame 运行时校验）。
	// 副作用：更新 #lastSeen（心跳）、递增 #received（ack 计数）、调用 #dispatch 处理具体帧、
	// 安排一次 ack。错误：帧格式非法时按协议违规关闭链路；单帧处理抛出的业务错误只上报，不断链。
	// 示例：link.receive((frame) => this.#receive(frame));
	// 注意：isFrame 是 wire.ts 中的类型谓词；校验后 TypeScript 才把 unknown 收窄为 Frame。
	#receive(frame: unknown): void {
		// 双方协议版本不一致后，不再处理对端发来的任何内容（包括 ack），避免用错误语义继续通信。
		if (this.#mismatched) return;
		// 收到任何帧都先刷新 #lastSeen（即使随后因格式非法被关闭），用于 ping 超时判断。
		this.#lastSeen = Date.now();
		// 先按 wire schema 校验帧结构；不合法说明对端实现有误或数据损坏，属于协议错误。
		if (!isFrame(frame)) {
			this.#violation("malformed frame");
			return;
		}
		// ack 不进 #dispatch：它不是一条“消息”，而是流量控制信号，单独交给 #onAck。
		if (frame.t === "ack") {
			this.#onAck(frame.n);
			return;
		}
		// 只有非 ack 帧才计入“已接收帧数”，ack 的 n 指的就是这个计数。
		this.#received++;
		// 业务处理放在 try 中：某一条请求（如参数错误、对象方法抛异常）失败不应拖垮整条链路。
		try {
			this.#dispatch(frame);
			// 如果 #dispatch 抛错，只报告给 host 的 onError，链路继续工作。
		} catch (error) {
			this.host.report(error);
		}
		// ack 延迟到本轮同步代码结束后的 setTimeout(0)，把同时到达的多个帧合并成一个 ack。
		this.#scheduleAck();
	}

	// #dispatch：按帧的 t 字段（可辨识联合的标签）把帧路由到对应处理逻辑。
	// 输入：已经通过 isFrame 校验的 Frame。输出：无；副作用由各分支产生。
	// 这里只做分派，不写状态机细节，具体语义在各 #onXxx 方法中。
	// 示例：this.#dispatch({ t: "ping", n: 3 }) 会立即回一个 pong。
	// TypeScript 在 switch 中对 frame.t 收窄：进入 case "hold" 后，frame 的类型就是提取出的 hold 帧。
	#dispatch(frame: Frame): void {
		// switch (frame.t) 是可辨识联合的标准用法：每个 case 里 frame 自动收窄为对应成员类型。
		switch (frame.t) {
			// 握手帧：校验版本、ack 能力和对端身份。
			case "hello":
				this.#onHello(frame);
				return;
			// 心跳：收到 ping 立即回 pong，并带回相同的序号 n。
			case "ping":
				this.send({ t: "pong", n: frame.n });
				return;
			// pong 只用于刷新 #lastSeen（已在 #receive 做过）；bye 表示对端主动告别；
			// 响应式 ack 已在 #receive 处理，这里再列一次是为了让 switch 覆盖所有帧类型。
			case "pong":
			case "bye":
			case "ack":
				return;
			// 对端请求持有对象：要么本地服务，要么经 relay 转发到别的 host。
			case "hold":
				this.#onHold(frame);
				return;
			// 对端释放 hold：本地释放对象引用，或取消下游 relay。
			case "release":
				this.#dropServed(frame.id, true);
				return;
			// 对端发起远程方法调用。
			case "call":
				this.#onCall(frame);
				return;
			// 对端取消一个正在执行的调用：abort 对应的 AbortController，方法内部的 ctx.signal 会触发。
			case "cancel":
				this.incoming.get(frame.id)?.abort(new ChordError("aborted", "cancelled by caller"));
				return;
			// 消费者开始/停止接收某个 hold 的 state。
			case "sub":
			case "unsub":
				this.#onWantState(frame.hold, frame.t === "sub");
				return;
			// relay 丢弃了某些成员的待发 ops，请求上游重新发送当前值。
			case "resync":
				this.#onResync(frame.hold, frame.m);
				return;
			// shape/gone 都是对 hold 请求的回复：shape 表示对象形态，gone 表示对象结束。
			case "shape":
			case "gone":
				this.#onHoldReply(frame);
				return;
			// 调用的结果或错误。
			case "result":
				this.#onResult(frame);
				return;
			// 成员的 state 更新（快照、reset、ops 或 error）。
			case "state":
				this.#onState(frame);
				return;
			// 外部 root 结束：只接受从 root 进来的那条连接传来的通知（host.foreignRootEnded 会再核对）。
			case "root_end":
				// Honored only from the link the root came over (see HostImpl.foreignRootEnded).
				this.#admitted.delete(frame.rootId);
				this.host.foreignRootEnded(frame.rootId, this);
				return;
			// 重载控制帧只能由父 host 发来：invalidate/prepare/commit/abort/retire 都改变本 host 的代码状态，
			// 子 host 或客户端无权触发。
			case "invalidate":
			case "prepare":
			case "commit":
			case "abort":
			case "retire":
				// Control frames only from the parent.
				// 自己不是“父连接”却收到这些帧，说明对端在冒充父级或实现错误，按协议违规断链。
				if (this.role !== "upstream") {
					this.#violation(`${frame.t} from a child`);
					return;
				}
				// invalidatePrincipal 是异步操作，用 catch 把失败交给 host.report，避免未处理的 rejection。
				if (frame.t === "invalidate") {
					this.host.invalidatePrincipal(frame.pattern).catch((error: unknown) => this.host.report(error));
					// retire 允许 host 回收某个代码版本；其余 prepare/commit/abort 交给 host 的重载状态机。
				} else if (frame.t === "retire") this.host.allowRetire(frame.codeVersion);
				else this.host.onReloadFrame(this, frame);
				return;
			// 子 host 对一次重载的投票结果。
			case "vote": {
				// 只有“被接受的 downstream host”才能投票；客户端和不参与重载的 peer 投票是非法的。
				if (this.role !== "downstream" || this.peer.kind !== "host") {
					this.#violation("vote from a non-participant");
					return;
				}
				// 按 reload id 找到等待中的 Promise；即使找不到也不报错（可能已经超时或重复）。
				const vote = this.votes.get(frame.reload);
				this.votes.delete(frame.reload);
				// error 为 undefined 表示投票成功，带回 report；否则把线格式错误还原成 ChordError 后拒绝。
				if (frame.error === undefined) vote?.resolve(frame.report);
				else vote?.reject(fromWireError(frame.error));
				return;
			}
		}
	}

	/**
	 * The peer's hello must agree with what this side decided about it. A downstream host announces its code version:
	 * the host either finds it in step or fences and reconciles it (never renumbers).
	 */
	// #onHello：处理对端的握手帧，确认版本、ack 能力与身份。
	// 输入：hello 帧（protocol/name/kind/codeVersion/acks）。
	// 副作用：设置 #peerAcks；upstream 连接记录父 host 名字；downstream host 交给 host.peerHello 同步代码版本。
	// 错误：版本不同走 #protocolMismatch；身份与 accept 时声明的不符按协议违规断链。
	// 示例：客户端连上来时 config.peer = { kind: "client", name: undefined }，hello 必须同样是 client。
	// 注意：frame.protocol ?? 1 兼容最早期没有该字段的实现，缺省视为版本 1。
	#onHello(frame: Extract<Frame, { t: "hello" }>): void {
		// 协议版本不同：报告给应用并关闭链路；不再处理后续帧。
		if ((frame.protocol ?? 1) !== PROTOCOL_VERSION) {
			this.#protocolMismatch(frame.protocol ?? 1);
			return;
		}
		// 只根据第一次 hello 决定对端是否 ack；如果对端不 ack，之前为“可能 ack”而累计的字节数全部作废。
		if (this.#peerAcks === undefined) {
			this.#peerAcks = frame.acks === true;
			if (!this.#peerAcks) {
				this.#unacked = [];
				this.#unackedBytes = 0;
			}
		}
		// upstream 表示这是通往父 host 的连接：父必须是 host，不能是客户端。
		if (this.role === "upstream") {
			if (frame.kind !== "host") {
				this.#violation("parent is not a host");
				return;
			}
			// 父 host 的名字以第一次公告为准（??= 只在 undefined 时赋值）。
			this.#parentName ??= frame.name;
			return;
		}
		// downstream 表示本 host 接受了对方：kind 必须与 accept 时声明一致，名字（若声明了）也必须一致。
		// 这是“服务端决定对端身份”的体现：不信任 hello 自报的身份来做授权。
		if (frame.kind !== this.peer.kind || (this.peer.name !== undefined && frame.name !== this.peer.name)) {
			this.#violation(
				`hello ${frame.kind} ${frame.name} does not match the accepted ${this.peer.kind} ${this.peer.name ?? ""}`,
			);
			return;
		}
		// downstream host 的代码版本交给 host.peerHello：host 判断是同步、围栏还是需要协调。
		if (this.peer.kind === "host") this.host.peerHello(this, frame.codeVersion);
	}

	/**
	 * Principal stamping: a downstream link acts as the principal it was accepted with, whatever the frame says. Only
	 * the parent may forward a principal (relayed requests); its own requests act as the principal given to `connect`.
	 */
	// #principalOf：为一条请求确定“以谁的身份执行”。
	// 输入：帧上的可选 principal。输出：实际使用的 principal。
	// 规则：downstream 连接永远使用 accept 时由应用认证器给出的 principal，帧里写什么都不算；
	// upstream 连接（父 host）可以转发下游的 principal，否则使用 connect 时给定的 principal。
	// 这是安全边界：客户端不能通过伪造帧字段提升权限。
	// 示例：客户端发送 { principal: "admin" }，但 accept 时 principal 是 "guest"，这里仍返回 "guest"。
	#principalOf(frame: { readonly principal?: unknown }): unknown {
		// 下游连接：忽略帧内 principal，使用本连接被接受时盖章的身份。
		if (this.role === "downstream") return this.principal;
		// 上游连接：父 host 转发的 principal 优先；没有转发时使用本连接自己的 principal。
		return frame.principal ?? this.principal;
	}

	/**
	 * The client connection a hold comes from: this link's own id for a client link (whatever the frame says), the id
	 * the parent forwarded for a relayed hold, none for a host's own holds.
	 */
	// #originOf：确定 hold 来自哪个客户端连接（origin 用于同一 principal 下区分多个标签页/连接）。
	// 输入：帧上的可选 origin。输出：origin 字符串或 undefined。
	// 规则：downstream 连接使用本连接自己的 originId，不信任帧；upstream 连接使用父 host 转发的 origin；
	// host 自己发起的 hold 没有 origin。这样 relay 转发时可以保留真正的客户端来源。
	// 示例：浏览器标签页 A 的 origin 是 "c-17"，它经父 host relay 到本 host 时，这里返回 "c-17"。
	#originOf(frame: { readonly origin?: string }): string | undefined {
		// 下游连接只认自己 accept 时分配的 originId。
		return this.role === "downstream" ? this.originId : frame.origin;
	}

	// #onHold：处理对端发来的 hold 请求：本地对象直接服务，别的 host 的对象交给 relay。
	// 输入：hold 帧（id、at、token、input、principal/origin、state、again）。
	// 输出：无直接返回值；成功时登记到 this.served 并开始发送 unit/state，失败时回 gone 帧。
	// 错误处理：寻址失败、contract 不匹配、placement 不符等都以 gone 回复，不关闭链路（这是正常的业务拒绝）；
	// 重复的 hold id 属于协议错误，直接断链。
	// 示例：客户端 hold 本 host 上的 Notes 对象，at 等于本 host 名字，于是进入本地 acquire 分支。
	// 注意：relay 分支会先登记 RelayRef，再异步解析路由；解析失败时 relay.close 通知 origin。
	#onHold(frame: Extract<Frame, { t: "hold" }>): void {
		// 同一个连接上 hold id 必须唯一；重复说明对端状态机错乱或恶意复用，无法安全区分两个 hold。
		if (this.served.has(frame.id)) {
			this.#violation(`duplicate hold id ${frame.id}`);
			return;
		}
		// principal 和 origin 都通过上面的安全规则得出，后续所有请求都以它们为准。
		const principal = this.#principalOf(frame);
		// origin 存在等价于“来自某个客户端连接”，用于授权与 state 隔离的粒度。
		const origin = this.#originOf(frame);
		// 本地变量 client：后面决定 acquire 的 owner 以及错误翻译方式。
		const client = origin !== undefined;
		// 帧里的 at 不是本 host：这个对象在别处，需要转发。
		if (frame.at !== this.host.name) {
			// upstream 连接不能再向上转发（父 host 不接受 relay 的 relay），直接回 gone。
			if (this.role === "upstream") {
				this.send({ t: "gone", id: frame.id, error: toWireError(unavailable(`${this.host.name} does not relay`)) });
				return;
			}
			// downstream 连接可以创建 relay：先登记再异步解析路由，避免路由解析期间重复 hold。
			const relay = new RelayRef(this, frame, principal, origin);
			this.served.set(frame.id, { kind: "relay", relay });
			// 路由解析（host.relay）失败时，关闭 relay 并通知 origin；releaseDown 为 true 因为下游可能已经建立 hold。
			this.host.relay(relay).catch((error: unknown) => relay.close(error, { releaseDown: true, notify: true }));
			return;
		}
		// 以下 try 块负责在本地解析契约、核对 placement 并 acquire 引用；失败都回 gone。
		let ref: RefImpl;
		try {
			// token 是对象契约的线格式描述；contractFromDescription 在运行时重建契约，并做 schema 校验。
			const token = contractFromDescription(frame.token);
			// 只有 remote 类型能跨链路；local 类型出现在 hold 里说明对端用错了 API。
			if (token.scope !== "remote") throw invalid("token", `${token.name} is local; only remote types cross links`);
			// Addressed here, so the input must place it here (also by this host's contract, checked when acquiring).
			// 再次检查 placement：即使 at 声称是本 host，input 也必须解析到本 host，防止冒充寻址。
			// host! 的非空断言来自契约创建时的保证：remote 契约必须有 host 描述。
			if (resolveHost(token.name, token.description.host!, frame.input) !== this.host.name)
				throw invalid("placement", `${token.name} with this input does not live on ${this.host.name}`);
			// host.acquire 返回 RefCore；本地可服务的对象应当是 RefImpl。client 来源会标记为 "client"，
			// 影响对象的生命周期与诊断（见 host.acquire 的 owner 参数）。
			const acquired = this.host.acquire(token, frame.input, { principal }, client ? "client" : "connection");
			// 运行时收窄：只有 RefImpl 才具备 onShape/member/object.call 等本地服务所需能力。
			if (!(acquired instanceof RefImpl)) throw unavailable("not a local reference");
			ref = acquired;
		} catch (error) {
			// 任何拒绝都转换成 gone 帧；对客户端使用 clientError，把 contract_mismatch 翻译成 upgrade_required，
			// 提示浏览器刷新代码。
			this.send({ t: "gone", id: frame.id, error: toWireError(client ? clientError(error) : error) });
			return;
		}
		// 登记本地服务状态：wantsState 由帧的 state 字段决定（缺省为 true），again 表示这是重新 hold。
		const served: ServedLocal = {
			kind: "local",
			id: frame.id,
			ref,
			principal,
			origin,
			wantsState: frame.state !== false,
			again: frame.again === true,
			unitSent: false,
			feeds: new Map(),
		};
		this.served.set(frame.id, served);
		// 对象形态变化（上线、重载、变体切换）时重新计算并发送 unit。
		ref.onShape(() => this.#unit(served));
		// 对象结束（dispose/revoke）时：仅当这条 served 记录仍然有效才清理，避免旧监听误删新 hold。
		ref.goneListeners.add((error) => {
			if (this.served.get(frame.id) !== served) return;
			// 先删除 served 记录再发 gone，保证后续到达的调用得到 unknown hold。
			this.#dropServed(frame.id, false);
			this.send({ t: "gone", id: frame.id, error: toWireError(error) });
		});
		// 如果对象当前已经 live，立即发送第一个 unit；否则等 onShape 回调触发。
		if (ref.status === "live") this.#unit(served);
	}

	/** The state members of `shape` the consumer's contract knows. */
	// #stateMembers：从 shape 的成员列表中筛出“状态成员”（可订阅、可复制的那部分）。
	// 输入：ref 和它当前的 shape。输出：成员名数组。
	// 方法成员不参与 state 复制；describe 返回 undefined 的成员（对端契约不认识）也被过滤掉，
	// 因此旧客户端不会收到它无法理解的状态。
	// 示例：shape.members = ["title", "add"]，其中 title 是 state、add 是 method，返回 ["title"]。
	#stateMembers(ref: RefImpl, shape: Shape): string[] {
		// filter 保留 describe(...).kind === "state" 的成员；可选链 ?. 让未知成员安全地得到 undefined。
		return shape.members.filter((name) => ref.describe(shape.variant, name)?.kind === "state");
	}

	/**
	 * The shape changed (live, reload, variant) or state was asked for: members that left lose their stream, and a unit
	 * goes out with the shape and the members the consumer lacks. The first unit of a hold (not a re-hold) is urgent.
	 */
	// #unit：在对象形态变化或 state 被重新请求时，安排发送一个 unit（shape + 缺失成员的快照）。
	// 输入：served（本地服务的 hold）。输出：无；副作用是给成员建立/取消订阅并发送或排队 unit。
	// 流程：先按最新 shape 计算应有的状态成员，取消已经离开变体的成员的订阅；
	// 若消费者还没有任何成员流且不是“重新 hold”，unit 立即发送（urgent，绕过窗口），
	// 否则作为惰性 unit 排队，窗口有空位时再用最新值构建，避免为中间状态浪费带宽。
	// 示例：对象从 variant v1 切到 v2，新成员 "tags" 出现，旧成员 "draft" 消失；
	// 这里会退订 draft，并把包含 tags 快照的 unit 排入发送队列。
	#unit(served: ServedLocal): void {
		// 陈旧回调保护：served 可能已经被释放或被新的 hold 取代。
		if (this.served.get(served.id) !== served) return;
		// 对象尚未有 shape（还在加载/激活）时不发送；等下一次 onShape。
		const shape = served.ref.shape;
		// 没有 shape 就没有成员列表，直接返回。
		if (shape === undefined) return;
		// 集合中只保留 consumer 契约认识的状态成员；wantsState 为 false 时为空集。
		const members = new Set(served.wantsState ? this.#stateMembers(served.ref, shape) : []);
		// 退订并遗忘已离开当前变体的成员流，同时丢弃它们尚未发送的 ops。
		for (const [name, feed] of served.feeds) {
			if (members.has(name)) continue;
			feed.unsubscribe();
			served.feeds.delete(name);
			this.dropState(served.id, name);
		}
		// urgent 的条件：这是该 hold 的第一个 unit（还没有任何 feed），并且不是“已经有值后的重新 hold”。
		// 首个 unit 必须尽快到达，因为 ctx.get 等操作在等它，不能排在别的 hold 的大量状态后面。
		const urgent = served.feeds.size === 0 && !(served.again && !served.unitSent);
		// 非 urgent 的 unit 使用惰性槽位：发送时才从当前值构建，多次 shape 变化会合并成一次。
		if (urgent) this.#sendUnit(served);
		else this.#queueUnit(served.id, () => this.#sendUnit(served));
	}

	/** Builds and sends a unit from the current shape and values. */
	// #sendUnit：真正构建并发送一个 unit：shape 帧 + 每个新成员的快照帧，然后回放快照期间缓冲的事件。
	// 输入：served。输出：无。副作用：给缺失成员建立订阅（Feed）、发送 shape/state 帧、清掉排队中的 unit 槽。
	// 错误：单个成员的快照校验失败会生成 as: "error" 的 state 帧，而不是让整个 unit 失败。
	// 示例：首次 hold 时 shape 列出 ["title", "body"]，这里为两者各发一个 snap，再开始推送后续 ops。
	#sendUnit(served: ServedLocal): void {
		// 该 unit 已经要发送，删除排队中的惰性槽位，避免窗口刷新时重复发送。
		this.#pending.delete(unitKey(served.id));
		// 再次核对 served 仍然有效（排队期间可能已被释放）。
		if (this.served.get(served.id) !== served) return;
		const shape = served.ref.shape;
		// 没有 shape 时无法发送 unit；等对象上线后的 onShape。
		if (shape === undefined) return;
		// 标记已经发送过 unit：对 again（重新 hold）的首次 unit 判断而言，之后就不再是首个 unit。
		served.unitSent = true;
		// 当前应该具备的状态成员（wantsState 关闭时为空）。
		const members = served.wantsState ? this.#stateMembers(served.ref, shape) : [];
		// 只给消费者还没有的成员发快照；已有 feed 的成员继续沿用原来的 delta 流。
		const listed = members.filter((name) => !served.feeds.has(name));
		// snaps 与 attached 一一对应：前者是待发送的 state 帧，后者是新建立的订阅。
		const snaps: StateFrame[] = [];
		// attached 保存“成员名 + Feed”，用于发完快照后回放缓冲事件。
		const attached: (readonly [string, Feed])[] = [];
		// 逐个 attach：建立订阅、拿到当前值快照；成员不可读时跳过（不算错误）。
		for (const name of listed) {
			// attach 返回 undefined 表示该成员不是可读状态，跳过即可。
			const attachment = this.#attach(served, name);
			if (attachment === undefined) continue;
			snaps.push(attachment.frame);
			attached.push([name, attachment.feed]);
		}
		// 先发 shape：它告诉消费者当前变体、成员列表、契约指纹，以及紧随其后的快照有哪些成员。
		// variant 为 undefined 表示 local 类型的扁平成员表，此时省略该字段。
		this.send({
			t: "shape",
			id: served.id,
			...(shape.variant === undefined ? {} : { variant: shape.variant }),
			members: shape.members,
			contract: shape.contract,
			state: snaps.map((frame) => frame.m),
		});
		// 再逐个发快照；顺序与 shape.state 中的成员名对应。
		for (const frame of snaps) this.send(frame);
		// 最后回放快照构建期间缓冲的事件，保证消费者从快照平滑过渡到增量。
		for (const [name, feed] of attached) this.#replay(served, name, feed);
	}

	/**
	 * Subscribes member `name` for the consumer: its snapshot (as a frame of type `as`), and a feed whose later events
	 * wait in its buffer until the snapshot is sent (`#replay`). Undefined if the member is not readable state.
	 */
	// #attach：为一个状态成员建立订阅并生成当前值快照。
	// 输入：served、成员名 name、快照类型 as（首次为 "snap"，重置为 "reset"）。
	// 输出：{ frame, feed }，成员不是可读状态时返回 undefined。
	// 副作用：调用 readable.events 订阅；在构建快照期间到达的事件先放进 feed.buffer。
	// 错误：快照值不符合契约 schema 时，frame 会是 as: "error"（由 #snapshot 处理），订阅仍然建立。
	// 示例：name = "title"，readable.events(cb) 返回退订函数，快照为 { t: "state", as: "snap", value: "Hi" }。
	// 注意：这是运行时检查 readable.events 是否为函数，因为 member 的静态类型是 Readable|undefined，
	// 但对象实现可能提供一个只有 value 的只读成员。
	#attach(
		served: ServedLocal,
		name: string,
		as: "snap" | "reset" = "snap",
	): { readonly frame: StateFrame; readonly feed: Feed } | undefined {
		// 从对象实现取出成员；不是状态成员或不存在时返回 undefined。
		// as 断言告诉 TypeScript 这里期望 Readable；随后的 events 检查才是运行时保证。
		const readable = served.ref.member(name) as Readable<unknown> | undefined;
		// 状态成员必须有 events 方法才能推送增量；只有 value 的成员无法建立流。
		if (readable === undefined || typeof readable.events !== "function") return undefined;
		// Feed 初始带一个空 encoder 和空缓冲；unsubscribe 先占位，订阅成功后替换。
		const feed: Feed = { unsubscribe: () => {}, encoder: encoder(), buffer: [] };
		// first 捕获“订阅后同步收到的第一个事件”，它对应的值可能比 readable.value 更新。
		let first: StateEvent<unknown> | undefined;
		// 订阅回调：第一个事件单独保存（用于快照取最新值），之后的先缓冲，等快照发完再回放。
		feed.unsubscribe = readable.events((event) => {
			// 第一个事件只记录，不缓冲：它用于生成快照，避免重复发送同一个值。
			if (first === undefined) first = event;
			// 后续事件进入缓冲；buffer 为 undefined 表示快照已经发出，此时直接走 #feedEvent。
			else if (feed.buffer !== undefined) feed.buffer.push(event);
			else this.#feedEvent(served, name, feed, event);
		});
		// 登记 feed 后立即生成快照；快照值优先使用 first.value（订阅期间的最新值）。
		served.feeds.set(name, feed);
		// 返回帧和 feed：调用方负责发送帧并调用 #replay。
		return { frame: this.#snapshot(served, name, as, first?.value), feed };
	}

	/** Sends the events that arrived while the snapshot was built, now that it is sent. */
	// #replay：把构建快照期间缓冲的事件按顺序补发，然后关闭缓冲（之后事件直接发送）。
	// 输入：served、成员名、feed。输出：无。
	// 这样消费者先看到完整快照，再看到快照之后发生的增量，不会丢事件也不会重复应用。
	// 示例：attach 期间收到两个 ops 事件，快照发出后这里依次把它们编码发送。
	#replay(served: ServedLocal, name: string, feed: Feed): void {
		// 可选值兼容：正常路径 buffer 一定是数组；这里用 ?? [] 只是让类型更宽松。
		const buffered = feed.buffer ?? [];
		// 取出缓冲并立即置为 undefined：置空表示“快照已经发出”，后续事件走 #feedEvent 的快路径。
		feed.buffer = undefined;
		// 按到达顺序回放；每个事件都经过 #feedEvent，因此仍受窗口和溢出策略约束。
		for (const event of buffered) this.#feedEvent(served, name, feed, event);
	}

	/** A member's state frame for a snapshot or reset: validated against the schema the consumer is promised. */
	// #snapshot：生成一个成员快照帧，并在发送前按契约 schema 校验。
	// 输入：served、成员名、as（snap/reset）、value。输出：state 帧；校验失败时输出 as: "error" 的帧。
	// 错误：校验失败不会抛给调用方，而是把错误编码进线上帧，让消费者把该成员标记为失败；
	// 一个坏成员不会阻断其他成员的快照。
	// 示例：value = { text: 1 } 但 schema 要求 text: string，返回 { as: "error", error: {...} }。
	// 注意：value 为 undefined 时不带 value 字段，表示“没有值”，而不是 JSON null。
	#snapshot(served: ServedLocal, name: string, as: "snap" | "reset", value: unknown): StateFrame {
		try {
			// validateSnapshot 会区分直接绑定与 accepts 适配后的消费者视图（见文件末尾）。
			validateSnapshot(served.ref, name, value);
			// 校验失败：保留错误信息给消费者，as: "error" 会触发消费者的失败处理。
		} catch (error) {
			return { t: "state", hold: served.id, m: name, as: "error", error: toWireError(error) };
		}
		// 成功：as 原样保留；undefined 值不写入帧，避免序列化成 null。
		return { t: "state", hold: served.id, m: name, as, ...(value === undefined ? {} : { value }) };
	}

	/** A later event of a member's stream: ops are encoded, a reset starts a new stream. */
	// #feedEvent：处理成员订阅上的后续事件：ops 编码后发送，reset 开启新的 delta 流。
	// 输入：served、成员名、feed、事件（StateEvent 的 snap/ops/reset 联合）。
	// 副作用：调用编码器、可能替换 encoder、通过 sendState 走窗口；溢出时用 #resend 恢复。
	// 错误：这里不额外校验 ops 内容，接收端解码 delta 时会校验序列；发送失败由链路层处理。
	// 示例：event = { type: "ops", ops: [{ op: "replace", path: ["title"], value: "X" }] }。
	#feedEvent(served: ServedLocal, name: string, feed: Feed, event: StateEvent<unknown>): void {
		// feed 可能已经被替换（resubscribe）或 hold 已释放，旧订阅的迟到事件必须丢弃。
		if (served.feeds.get(name) !== feed) return;
		// 溢出策略：窗口满且需要丢弃时，让 provider 重新发送当前值（resend），而不是继续堆积 ops。
		const overflow = { resend: () => this.#resend(served, name) };
		// ops 事件：用该成员自己的编码器压缩成增量批次；同一流的多个批次可以在槽位中拼接。
		if (event.type === "ops") {
			// feed.encoder.encode(event.ops) 把 JSON ops 压成 Delta 编码的紧凑表示，减少窗口占用。
			this.sendState(
				{ t: "state", hold: served.id, m: name, as: "ops", ops: feed.encoder.encode(event.ops) },
				overflow,
			);
			return;
		}
		// reset 事件：值被整体替换，旧的 delta 编码历史作废，必须换一个新 encoder，并从当前值发 reset 快照。
		feed.encoder = encoder();
		// reset 快照仍然走 sendState，因此同样可能排队或被溢出策略替换。
		this.sendState(this.#snapshot(served, name, "reset", event.value), overflow);
	}

	/** Sends member `name` again, now, as a reset from its current value (a lazy slot is flushed, or `resync`). */
	// #resend：把一个成员重新作为 reset 发送：退订旧流、从当前值重新 attach，再发送快照并回放缓冲。
	// 输入：served、成员名。输出：无。
	// 触发场景：窗口溢出后 provider 选择 resend（见 #drop），或下游 relay 发来 resync。
	// 错误：成员不存在或 hold 已失效时静默返回；订阅失败时 attach 返回 undefined，也直接返回。
	// 示例：消费者落后太多，排队 ops 被丢弃，这里发一个 reset 让它重新同步。
	// 注意：这条路径发送的是普通帧（不经 sendState），因为调用方已经处理了排队/窗口语义。
	#resend(served: ServedLocal, name: string): void {
		// 取出当前 feed；不存在说明成员已经离开变体或 hold 已释放。
		const feed = served.feeds.get(name);
		// feed 或 hold 已失效：没有可重发的成员。
		if (feed === undefined || this.served.get(served.id) !== served) return;
		// 退订旧流，避免旧 encoder 的历史与新 reset 混在一起。
		feed.unsubscribe();
		// 从 feeds 中移除，attach 会重新登记。
		served.feeds.delete(name);
		// 用 as: "reset" 重新 attach：消费者会清空该成员的旧值再应用新快照。
		const attachment = this.#attach(served, name, "reset");
		if (attachment === undefined) return;
		// 发送快照，然后回放 attach 期间缓冲的事件。
		this.send(attachment.frame);
		this.#replay(served, name, attachment.feed);
	}

	/** The consumer starts (`sub`) or stops (`unsub`) the state of a hold. */
	// #onWantState：处理消费者的 sub/unsub：开始或停止一个 hold 的状态流。
	// 输入：hold id 和 wanted。输出：无。
	// 本地 hold：开启时补发 unit（包含缺失快照），关闭时退订所有成员并清空待发 ops；
	// relay hold：把 sub/unsub 继续转发给下游。
	// 示例：UI 打开详情页时对某个 hold 发送 sub，收起时发送 unsub，避免继续传输状态。
	// 注意：重复的 sub/unsub 会被忽略，不产生额外流量。
	#onWantState(hold: number, wanted: boolean): void {
		// 未知 hold 是正常竞态（release 与 sub 交叉），直接忽略。
		const served = this.served.get(hold);
		if (served === undefined) return;
		// relay：状态开关由下游连接决定，继续转发。
		if (served.kind === "relay") {
			served.relay.wantState(wanted);
			return;
		}
		// 状态没有变化时不重复处理。
		if (served.wantsState === wanted) return;
		served.wantsState = wanted;
		// 从关闭到开启：补发 unit，让消费者拿到当前快照并重新建立增量流。
		if (wanted) {
			// 立即重新计算并发送 unit；若窗口忙则内部会排队。
			this.#unit(served);
			return;
		}
		// 从开启到关闭：退订所有成员，清掉该 hold 排队中的状态帧。
		for (const feed of served.feeds.values()) feed.unsubscribe();
		served.feeds.clear();
		// 丢弃该 hold 的所有待发 state（包括快照和 ops）。
		this.dropHoldState(hold);
	}

	/** The consumer (a relay that dropped ops) asks for member `m` again as a reset. */
	// #onResync：下游 relay 请求某个成员重新同步（它丢弃了该成员的 ops）。
	// 输入：hold id、成员名 m。输出：无。
	// 本地 hold：稍后通过窗口发送 reset；relay hold：继续向下游转发 resync（由 RelayRef 发给目标 host 的连接）。
	// 示例：对端因队列丢弃 "title" 的 ops 发来 resync，这里安排一次 reset 重发快照。
	// 注意：如果该成员当前没有 feed，说明它不属于当前变体，直接忽略。
	#onResync(hold: number, m: string): void {
		// 未知 hold：正常竞态，忽略。
		const served = this.served.get(hold);
		if (served === undefined) return;
		// relay：把请求继续传给它所依赖的下游连接（链路方向上的下一跳）。
		if (served.kind === "relay") {
			served.relay.resync(m);
			return;
		}
		// 没有该成员的流时无法重置，忽略。
		if (!served.feeds.has(m)) return;
		// 用 #resetLater 排队而不是立即发送：reset 也要遵守窗口，避免大快照绕过流控。
		this.#resetLater(hold, m, () => this.#resend(served, m));
	}

	/** Forgets a served hold: unsubscribes its feeds and releases it (locally or downstream). */
	// #dropServed：忘记一个 hold：退订状态流、清理排队帧，并按需释放对象引用或下游 hold。
	// 输入：hold id、release（是否真正释放；false 表示对象已经 gone，只需清理本地状态）。
	// 错误：未知 id 直接返回。副作用：可能触发对象 dispose（引用计数减一）。
	// 示例：客户端发送 release 帧 -> #dropServed(id, true) -> ref.release()。
	// 注意：先删除 served 再清理，确保迟到的调用得到 unknown hold。
	#dropServed(id: number, release: boolean): void {
		// 未知 hold：可能已经释放，直接返回。
		const served = this.served.get(id);
		if (served === undefined) return;
		// 先移除登记，后续到达的 call/state 都会被当作未知 hold。
		this.served.delete(id);
		// relay hold：关闭 relay；release 决定是否向下游发 release 帧。
		// release 为 false 表示下游已经知道 hold 结束（例如它自己发来的 gone），无需再发。
		if (served.kind === "relay") {
			served.relay.close(new ChordError("released", "relayed hold released"), {
				releaseDown: release,
				notify: false,
			});
			return;
		}
		// 本地 hold：退订所有成员流。
		for (const feed of served.feeds.values()) feed.unsubscribe();
		served.feeds.clear();
		// 丢弃该 hold 所有排队中的状态帧，避免向已经释放的 hold 发送数据。
		this.dropHoldState(id);
		// release 为 true 时释放引用；引用计数归零后对象可能被 dispose。
		if (release) served.ref.release();
	}

	// #onCall：处理对端发来的远程方法调用：校验、建立 root、执行、回送 result。
	// 输入：call 帧（id、hold、member、args、root）。输出：无；结果通过 result 帧返回。
	// 错误：重复 call id、并发调用超限、未知 hold、方法抛错都以 result.error 返回；
	// 只有重复 id 属于协议违规（断链），超限和业务错误都不影响链路。
	// 流程：登记 AbortController -> 决定 root -> 本地对象调用或 relay 转发 -> then 发送结果 -> finally 清理。
	// 示例：客户端调用 Notes.add，参数 { text: "hi" }，方法返回 id 42，客户端收到 { t: "result", id, value: 42 }。
	#onCall(frame: Extract<Frame, { t: "call" }>): void {
		// 同一连接上 call id 必须唯一；重复意味着无法区分两个并发调用。
		if (this.incoming.has(frame.id)) {
			this.#violation(`duplicate call id ${frame.id}`);
			return;
		}
		// 并发调用上限：超过时不执行方法，立即回 unavailable/too_many_calls；链路保持可用，
		// 让对端自己排队重试，而不是把整条连接拖垮。
		if (this.incoming.size >= this.#maxCalls) {
			// 错误 details 里的 reason 是跨链路的稳定原因码，调用方据此区分“连接坏了”和“暂时太忙”。
			const error = new ChordError(
				"unavailable",
				`Too many calls in progress on this connection (${this.#maxCalls}); wait for earlier ones to finish`,
				{ reason: "too_many_calls" },
			);
			this.send({ t: "result", id: frame.id, error: toWireError(error) });
			return;
		}
		// 找到调用目标：本地服务对象或 relay。
		const served = this.served.get(frame.hold);
		// 未知 hold 是正常竞态（调用与 release 交叉），回 gone 而不是断链。
		if (served === undefined) {
			this.send({ t: "result", id: frame.id, error: toWireError(new ChordError("gone", "unknown hold")) });
			return;
		}
		// 为这次调用创建 AbortController：cancel 帧与链路关闭会通过它中止方法；
		// root 的代码版本退休则由 ctx.signal 的另一来源（codeVersion.abort）取消方法。
		const controller = new AbortController();
		// 登记后，cancel 帧和 #closed 都能找到它。
		this.incoming.set(frame.id, controller);
		// Roots are honored from hosts only; a request without one (or from a client) starts one here.
		// root：只有 host 类型的对端可以携带 root；客户端没有 root，由本 host 新建。
		// #admitRoot 处理“子 host 在被围栏的代码版本上启动的 root”。
		const root = this.peer.kind === "host" ? this.#admitRoot(frame.root) : undefined;
		// 以 hold 对应的 principal 执行，而不是以帧里的字段为准。
		const principal = served.kind === "local" ? served.principal : served.relay.principal;
		// 调用上下文选项：principal 决定授权，signal 让取消能传到方法内部。
		const options = { principal, signal: controller.signal };
		// 根据 hold 类型选择执行函数；两种分支都接受 ctx，返回 Promise。
		const run =
			served.kind === "local"
				? // 本地调用：unpack 解包参数，交给对象方法；ctx 是 host 建立的调用上下文。
					// host.root/joinRoot 总是构造 CtxImpl；这里的断言只是把公开类型 Ctx 收窄到 object.call 需要的实现类型。
					(ctx: Ctx) => served.ref.object.call(served.ref, frame.member, unpack(frame.args), ctx as CtxImpl)
				: (ctx: Ctx) =>
						// relay 调用：把 root 信息和 signal 传给 relayCall，由它等待路由并向下游转发。
						relayCall(
							served.relay,
							frame,
							// relayCall 的 root 只保留 rootId 与 codeVersion：下游 host 需要知道 root 的代码版本。
							{ rootId: ctx.rootId, codeVersion: ctx.codeVersion },
							// The root's signal: a cancel from the origin and the root's code version retiring both reach it.
							// 使用 ctx.signal：调用取消与 root 代码版本退休都会触发它。
							ctx.signal,
							this.host,
						);
		// 有 root 时加入已有 root（joinRoot），否则新建 root；from 记录这条调用来自哪条连接，
		// 用于外部 root 的生命周期管理。
		const result =
			root === undefined
				? this.host.root(run, options)
				: this.host.joinRoot(root.rootId, root.codeVersion, run, { ...options, from: this });
		// 成功和失败都转成 result 帧；toWireError 把异常编码成可跨链路的错误。
		result
			.then(
				(value) => this.send({ t: "result", id: frame.id, value }),
				(error: unknown) => this.send({ t: "result", id: frame.id, error: toWireError(error) }),
			)
			// finally 删除 incoming 记录：无论成功失败都释放并发调用名额。
			.finally(() => this.incoming.delete(frame.id));
	}

	/**
	 * A child that connected behind this host runs roots of a code version this host never had (it was fenced and is
	 * being, or was, reconciled). Such a root is admitted in this host's current code version at its first call here,
	 * and keeps that code version for its later calls (`superseded` once this host retired it). Other unknown code
	 * versions stay `superseded`.
	 */
	// #admitRoot：为被围栏（fenced）代码版本上的 root 重新指定本 host 的代码版本。
	// 背景：子 host 可能在本 host 尚未运行的代码版本上启动 root；本 host 先把它围栏，等协调后再处理。
	// 输入：调用帧携带的 root。输出：调整后的 root；不需要调整时原样返回。
	// 规则：只处理 downstream 且该代码版本被围栏过、且本 host 当前没有该版本的 root；
	// 同一个 rootId 在本 host 当前代码版本中只映射一次，后续调用沿用同一映射。
	// 示例：root { rootId: "child#1:1", codeVersion: 9 } 被围栏，本 host 当前版本是 7，
	// 首次调用映射为 { rootId: "child#1:1", codeVersion: 7 }，之后一直使用 7。
	#admitRoot(root: RootRef | undefined): RootRef | undefined {
		// 没有 root、不是 downstream、或该版本从未被围栏：都不需要调整。
		if (root === undefined || this.role !== "downstream" || !this.fencedCodeVersions.has(root.codeVersion))
			return root;
		// 如果本 host 现在已经有这个代码版本（协调完成），保留原 root。
		if (this.host.hasCodeVersion(root.codeVersion)) return root;
		// 已经为这个 rootId 分配过本 host 的代码版本：沿用，保证同一 root 的调用落在同一代码版本。
		let codeVersion = this.#admitted.get(root.rootId);
		// 首次见到：使用本 host 当前代码版本，并记录映射。
		if (codeVersion === undefined) {
			codeVersion = this.host.current.id;
			this.#admitted.set(root.rootId, codeVersion);
		}
		return { rootId: root.rootId, codeVersion };
	}

	// #onHoldReply：处理 shape/gone 帧：既可能是 relay 的下游回复，也可能是普通 consumer 的绑定回复。
	// 输入：shape 或 gone 帧。输出：无。
	// 先查 relayedRefs：如果这个 id 是本 host 作为下游使用时分配的，说明回复属于一个 relay，
	// 需要转发给 relay 的 origin；否则查 remotes，交给本地的 RemoteBinding。
	// 示例：远端对象结束，gone 帧先到达 relay，再由 relay.close(..., notify: true) 通知 origin。
	// 注意：未知 id 直接忽略——这是 release 与回复交叉的正常竞态。
	#onHoldReply(frame: Extract<Frame, { t: "shape" | "gone" }>): void {
		// relayedRefs 的键是下游 hold id，说明这条回复属于转发中的 hold。
		const relay = this.relayedRefs.get(frame.id);
		if (relay !== undefined) {
			// relay 的 gone：关闭 relay，但不释放下游（下游已经结束），并通知 origin。
			if (frame.t === "gone") relay.close(fromWireError(frame.error), { releaseDown: false, notify: true });
			// shape：转发给 origin，并让首个 unit 的成员跳过窗口（见 RelayRef.shape）。
			else relay.shape(frame);
			return;
		}
		// 本地消费者绑定：按 id 找到 RemoteBinding。
		const binding = this.remotes.get(frame.id);
		if (binding === undefined) return;
		// 本地 gone：删除绑定，交给 RemoteBinding 进入 ended 状态。
		if (frame.t === "gone") {
			this.remotes.delete(frame.id);
			binding.gone(fromWireError(frame.error));
			return;
		}
		// shape 带上快照成员列表；RemoteBinding 会等所有快照到齐后再应用。
		binding.shaped({ variant: frame.variant, members: frame.members, contract: frame.contract }, frame.state);
	}

	// #onResult：处理调用的结果帧：先看是否是 relay 转发中的调用，否则结算本地 pending。
	// 输入：result 帧（id、value 或 error）。输出：无。
	// 错误：远端错误用 fromWireError 还原为 ChordError；value 解包失败（例如 Packed 数据损坏）
	// 也会拒绝对应的 Promise，而不是让调用永远挂起。
	// 示例：远端返回 42，本地 pending.resolve(42)；远端抛 forbidden，本地 pending.reject(ChordError)。
	// 注意：先删除 calls 记录再结算，避免重复 result 造成二次 resolve。
	#onResult(frame: Extract<Frame, { t: "result" }>): void {
		// relay 调用：交给 RelayCall.finish，它会同时清理 origin/downstream 两侧的映射。
		const relayed = this.relayedCalls.get(frame.id);
		if (relayed !== undefined) {
			relayed.finish(frame.error === undefined ? undefined : fromWireError(frame.error), frame.value);
			return;
		}
		// 本地调用：取出 pending 并删除；找不到说明调用已被取消，忽略。
		const pending = this.calls.get(frame.id);
		this.calls.delete(frame.id);
		// 错误结果：直接拒绝。
		if (frame.error !== undefined) {
			pending?.reject(fromWireError(frame.error));
			return;
		}
		// 成功结果：unpack 可能解包 Packed（跨链路打包的值），失败时拒绝。
		let value: unknown;
		// try 只包住解包：解包失败要拒绝对应调用，而不是让异常冒到 #dispatch 被当成内部错误。
		try {
			value = unpack(frame.value);
		} catch (error) {
			pending?.reject(error);
			return;
		}
		pending?.resolve(value);
	}

	// #onState：处理 state 帧：relay 的转发、本地绑定的应用，以及 Packed 值的解包。
	// 输入：state 帧（hold、m、as、value/ops/error）。输出：无。
	// 错误：Packed 值解包失败时，把该成员转成 as: "error" 交给绑定，而不是丢弃整帧。
	// 示例：远端发送 { as: "snap", value: Packed }，这里解包后交给 binding.state(m, { as: "snap", value })。
	// 注意：relay 不解析 value，只改 hold id 后转发（见 RelayRef.state），保持“中继不解析负载”的规则。
	#onState(frame: StateFrame): void {
		// relay：把帧转发给 origin，只改 hold id。
		const relay = this.relayedRefs.get(frame.hold);
		if (relay !== undefined) {
			relay.state(frame);
			return;
		}
		// 本地绑定：未知 hold 是正常竞态，忽略。
		const binding = this.remotes.get(frame.hold);
		if (binding === undefined) return;
		// 非 Packed 值：直接交给绑定（ops 也是普通数组）。
		if (!(frame.value instanceof Packed)) {
			binding.state(frame.m, frame);
			return;
		}
		// Packed 值：解包后替换帧里的 value；解包失败时给该成员一个 error 帧。
		let value: unknown;
		try {
			value = unpack(frame.value);
		} catch (error) {
			binding.state(frame.m, { as: "error", error: toWireError(error) });
			return;
		}
		binding.state(frame.m, { ...frame, value });
	}

	// ─── lifetime ───

	// #closed：链路关闭时的统一清理：拒绝所有等待者、释放所有 hold、通知 host。
	// 输入：关闭原因（link 层提供，可能是 "ping timeout"、"protocol error: ..."、"protocol-version N" 等）。
	// 副作用：停止心跳/ack 定时器、清空排队状态、释放 served/relayed 资源、拒绝 calls/votes/syncWaiters、
	// 处理 remotes（上游连接是 detached，下游连接是 gone），最后通知 host.connectionClosed。
	// 错误：没有任何抛出——关闭路径必须尽量完成清理，单个回调失败也不应阻断其余清理。
	// 示例：网络断开后，所有等待结果的调用收到 unavailable("link to ... closed: ...")。
	// 注意：关闭原因里的协议版本号是双方协商“谁先发现版本不一致”的额外通道（见 #protocolMismatch）。
	#closed(reason: string): void {
		// 用正则解析 "protocol-version N"：对端先发现版本不一致时，会以这个原因关闭链路。
		const told = /^protocol-version (\d+)$/.exec(reason);
		// N 与本地版本不同才报告；close = false 因为链路已经关闭，不重复 close。
		if (told !== null && Number(told[1]) !== PROTOCOL_VERSION) this.#protocolMismatch(Number(told[1]), false);
		// 停止心跳定时器，避免关闭后继续发 ping。
		if (this.#pinger !== undefined) clearInterval(this.#pinger);
		// 取消尚未执行的 ack 定时器；此时链路已关闭，ack 没有意义。
		if (this.#ackTimer !== undefined) clearTimeout(this.#ackTimer);
		// 清空排队中的状态帧和字节计数：这些数据不会再发送。
		this.#pending.clear();
		// 排队字节数归零，与清空 #pending 保持一致。
		this.#pendingBytes = 0;
		// 构造统一的关闭错误；name 可能未知（用 "peer" 兜底）。
		const error = unavailable(`link to ${this.name ?? "peer"} closed: ${reason}`);
		// As origin: everything the peer held here, relayed or not, is released (downstream calls cancelled).
		// 作为 hold 的提供方：释放对端持有的所有对象（relay 会取消下游调用）。
		for (const id of [...this.served.keys()]) this.#dropServed(id, true);
		// 中止所有正在执行的本地/转发调用，方法内部的 ctx.signal 会触发。
		for (const controller of this.incoming.values()) controller.abort(error);
		this.incoming.clear();
		// 拒绝所有等待结果的调用。
		for (const pending of this.calls.values()) pending.reject(error);
		this.calls.clear();
		// 拒绝所有等待子 host 重载投票的 Promise。
		for (const vote of this.votes.values()) vote.reject(error);
		this.votes.clear();
		// 拒绝所有等待代码版本同步的 Promise。
		for (const waiter of this.#syncWaiters) waiter.reject(error);
		this.#syncWaiters.clear();
		// As downstream of relays: their origins lose the hold.
		// 作为 relay 的下游：通知所有 origin“下游链路没了”，但不向下游发 release（它已经关闭）。
		for (const relay of [...this.relayedRefs.values()]) relay.close(error, { releaseDown: false, notify: true });
		this.relayedRefs.clear();
		this.relayedCalls.clear();
		// 取出所有消费者绑定后清空映射。
		const bindings = [...this.remotes.values()];
		this.remotes.clear();
		// 逐个处理绑定：上游链路与下游 host 的语义不同。
		for (const binding of bindings) {
			// An upstream link may be replaced (reconnect); a downstream host that went away is gone.
			// 上游链路可能被重连替换：绑定进入 detached（保留最后的值，等待重新 hold）；
			// 下游 host 断开则是真正的 gone。
			if (this.role === "upstream") binding.detached();
			else binding.gone(error);
		}
		// 通知 host：移除这条连接，并处理与连接绑定的 root 生命周期。
		this.host.connectionClosed(this);
	}
}

// stateKey：为“hold + 成员名”生成排队槽位的唯一键。
// 用 \u0000 分隔，避免 hold 数字和成员名拼接产生歧义（成员名可能包含数字）。
// 示例：stateKey(7, "title") -> "s7\u0000title"。
const stateKey = (hold: number, m: string): string => `s${hold}\u0000${m}`;
// unitKey：为 hold 的惰性 unit 槽位生成键，与 state 槽位共享同一个 Map。
// 前缀 "u" 与 "s" 区分两类槽位，避免 hold 7 的 unit 与某个成员名冲突。
const unitKey = (hold: number): string => `u${hold}`;

/**
 * A call through a relay: waits for the route, then forwards with the root it runs in. It settles exactly once; a
 * cancel (or the origin going away) is forwarded downstream and removes both mappings.
 */
// relayCall：把一次调用经 relay 转发到下游连接，并等待结果。
// 输入：relay、call 帧、root、signal、host。
// 输出：下游返回值；错误时抛出 ChordError。
// 流程：等待 relay.ready()（路由解析完成）与取消信号竞速 -> 登记 RelayCall -> host.rootSent ->
// 向下游发 call 帧 -> 等待 result。取消信号会向下游发 cancel，并同时结算本地 Promise。
// 错误：signal 已中止时立即抛 aborted；relay 在等待路由期间关闭时抛 gone。
// 示例：客户端调用远端对象，本 host 作为 relay，relayCall 把调用转发给真正拥有对象的 host。
// 注意：aborted 是一个只会 reject 的 Promise，用它和 relay.ready() 竞速实现“可取消的等待”。
async function relayCall(
	relay: RelayRef,
	frame: Extract<Frame, { t: "call" }>,
	root: RootRef,
	signal: AbortSignal,
	host: HostImpl,
): Promise<unknown> {
	// 构造统一的取消错误，cause 保留调用方 signal 的原因。
	const abortError = (): ChordError => new ChordError("aborted", "call cancelled", { cause: signal.reason });
	// 早期取消：还没开始等待路由，直接失败。
	if (signal.aborted) throw abortError();
	// onAbort/onCancel 先占位，下面分别替换为两个阶段的取消行为。
	let onAbort = (): void => {};
	let onCancel = (): void => {};
	// 只用于等待路由阶段的取消 Promise；它永远不会 resolve。
	const aborted = new Promise<never>((_, reject) => {
		// 信号中止时拒绝，从而让 Promise.race 立即返回。
		onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	// 立即挂一个 catch，避免该 Promise 被拒绝时产生 unhandled rejection。
	aborted.catch(() => {});
	try {
		// 等待路由；取消信号先到则中断等待。
		const down = await Promise.race([relay.ready(), aborted]);
		// 路由已解析但 relay 在等待期间关闭：对象已经不可达。
		if (relay.closed) throw new ChordError("gone", "relayed hold closed");
		// 第二个阶段：登记 RelayCall 并等待下游 result。
		return await new Promise<unknown>((resolve, reject) => {
			// RelayCall 负责在下游 result 到达时结算，并清理两侧映射。
			const call = new RelayCall(relay, frame.id, down.nextId(), { resolve, reject });
			// 登记后若 signal 才中止，向下游发 cancel 并结算本地调用。
			onCancel = () => call.cancel(abortError(), true);
			signal.addEventListener("abort", onCancel, { once: true });
			// 让 host 知道这个 root 经过了下游连接，用于 root 生命周期与围栏。
			host.rootSent(root.rootId, down);
			// 向下游发送 call 帧；args 原样转发，不解析。
			down.send({ t: "call", id: call.downId, hold: relay.downId, member: frame.member, args: frame.args, root });
		});
		// 无论成功失败都移除两个 abort 监听，防止 signal 泄漏对本次调用的引用。
	} finally {
		signal.removeEventListener("abort", onAbort);
		signal.removeEventListener("abort", onCancel);
	}
}

/**
 * Validates a snapshot against the schema the consumer is promised: the provider's own schema for a direct binding,
 * the consumer's contract for one through an `accepts` adapter (the adapter's view is what the consumer gets).
 */
// validateSnapshot：按“消费者实际看到的契约”校验快照值。
// 输入：ref、成员名、值。输出：无；不合法时抛出（由 #snapshot 转成 error 帧）。
// 为什么不能只用 provider 自己的 schema：通过 accepts 适配的旧消费者看到的是映射后的旧形状，
// 应当按旧契约校验；直接绑定则按 provider 当前安装实现的 schema 校验。
// 示例：provider 的 v2 值经 accepts 映射成 v1 后，这里用 v1 的 schema 校验，消费者不会收到 v2 字段。
// 注意：value 为 undefined 时跳过校验（表示没有值）；对象没有安装实现时也跳过（无法确定 schema）。
function validateSnapshot(ref: RefImpl, member: string, value: unknown): void {
	// 没有值就无需校验。
	if (value === undefined) return;
	// 没有已安装实现（对象未上线/已结束）时没有可信 schema，跳过。
	const installed = ref.object.currentInstalled();
	if (installed === undefined) return;
	// view 是消费者侧通过适配器看到的实现视图；undefined 表示直接绑定。
	const view = ref.currentView();
	// variant 用于定位该成员在契约中的描述；LOCAL_VARIANT 是 local 类型的扁平成员表。
	const variant = view === undefined ? variantOf(installed.implementation) : variantOf(view);
	// 选择 schema：通过适配器且视图与实现不同时用 ref.contract（消费者的旧契约），
	// 否则用 provider 安装实现的契约。
	const description =
		view !== undefined && view !== installed.implementation
			? ref.contract.description.variants[variant ?? LOCAL_VARIANT]?.[member]
			: installed.service.contract.description.variants[variantOf(installed.implementation) ?? LOCAL_VARIANT]?.[
					member
				];
	// 只校验 state 成员；方法没有快照。
	// assertValid 是运行时 schema 校验入口，失败时抛出带路径的错误。
	if (description?.kind === "state") assertValid("state", `${ref.address}.${member}`, description.schema, value);
}

/** Clients (browsers) holding an outdated contract are told to reload their code. */
// clientError：把对客户端不友好的错误翻译成可操作的错误。
// 输入：任意错误。输出：需要翻译时返回新的 ChordError，否则原样返回。
// 规则：contract_mismatch 表示浏览器缓存的代码与服务器契约不一致，翻译成 upgrade_required，
// 前端可以据此提示刷新页面；其他错误保持原样。
// 示例：客户端 hold 一个已升级的对象 -> gone 帧里带 upgrade_required，而不是 contract_mismatch。
// 注意：catch 捕获到的 error 是 unknown，可能不是 ChordError；只有 ChordError 才有稳定的 code 字段可判断。
function clientError(error: unknown): unknown {
	// 只有带 contract_mismatch 代码的 ChordError 才翻译；cause 保留原始错误便于诊断。
	if (error instanceof ChordError && error.code === "contract_mismatch") {
		// upgrade_required 是面向客户端的稳定错误码，表示“重新加载你的代码”。
		return new ChordError("upgrade_required", error.message, { cause: error });
	}
	return error;
}
