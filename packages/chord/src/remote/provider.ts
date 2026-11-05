// 本文件实现一条连接上某个 origin 的提供端：服务该 origin 的持有与调用，为本地 bound/state 维护确认窗口，并把中继消息转给上游。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的提供端，每个连接每个 origin 一个实例。
// 职责边界：管理该 origin 的 hold 编号空间、并发调用上限、本地 bound/state 的 K=2 确认窗口与中继 relation；不执行用户方法的具体逻辑（交给 Hold/ChordObject），也不负责握手。
// 上游入口：HostLink.message 按 origin 把 hold/release/call/abort/retry/ack 交给 message；上游 reply 经 forward 进入。
// 下游依赖：Hold（本地持有）、RelayedHold（中继）、HostLink（发送与异步解压）、主机批次（flushing）。
// 结果与错误流向：result/error 回复调用；协议错误（编号复用、并发超限、子连接压缩参数）抛出并关闭连接；单个调用 too_large 只拒绝该调用。
//
// 能力清单：
// - class ProviderSide：message 分派，send 补 origin，closed 结束全部持有，revokeUnbound 撤销未绑定持有，relayTo/forward/unlinked/upstreamDropped 管理中继，forget/reply/settle 清理，bind/unbind/unbound/touched/flush/slotFreed 管理窗口。
// - 模块内 RunningCall/Sender/Relay 与常量 WINDOW：调用形态、发送者标记、中继记录与窗口大小。
//
// 组合关系：hold 创建 Hold 并放入 entries；对象 live 后 bind 发送或排队 bound；批次变化经 touched/flush 生成 state；ack 按 #sent 顺序释放名额或回传上游。
// 示例：const side = new ProviderSide(link, 0, 256); side.message({ kind: "hold", hold: 1, type: "Editor", version: 1, fingerprint: "...", params: "{}", address: ... });
// 建议阅读顺序：先看 RunningCall/Sender/Relay 与字段，再看 message 分派和 #hold/#call，然后窗口相关 bind/flush/slotFreed，最后中继 forward 与 closed。
// The provider side of one origin on a link (§3, §22, W1; decision "Relay flow control per origin"): the holds the
// peer sent for that origin, served here or relayed, by their ids; the calls on them, at most this side's N at once;
// and the window: at most K unacknowledged `bound` and `state` messages of this host's own, with what waits meanwhile,
// and the sender of every message in flight, so each `ack` reaches the host that sent its message.

// 导入上下文工具、错误与身份类型、主机调用者类型、链路消息/分片工具，以及本地的 Hold 和中继类型。
import { type Context, withAbortSignal } from "../context/index.ts";
import { ChordError, isChordError, type Principal } from "../data/index.ts";
import type { Caller } from "../host/internal.ts";
import {
	type BoundEntry,
	type ConsumerMessage,
	DeflatedPart,
	type Message,
	type OriginMessage,
	oversized,
	type ProviderMessage,
	parsePayload,
	payloadPart,
	type StateEntry,
	wireError,
} from "../link/internal.ts";
import { Hold } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { RelayedHold } from "./relay.ts";

/**
 * A call being handled: on a hold served here, with whether its result carries byte segments and the abort of its
 * handler's context; or relayed, its reply forwarded from upstream.
 */
// 可区分联合：served 由本主机执行，relayed 只转发；后续按 kind 分支处理。
type RunningCall =
	// 本地执行：bytes 决定结果是否拆字节段，abort 用于取消处理器。
	| { readonly kind: "served"; readonly hold: Hold; readonly bytes: boolean; readonly abort: AbortController }
	// 中继：只保存持有，回复由上游提供。
	| { readonly kind: "relayed"; readonly hold: RelayedHold };

/** Who sent a `bound` or `state` message in flight: this host, or the upstream link a relay forwarded it from. */
// 字符串 "local" 表示本主机自己的消息；HostLink 表示某条上游连接转发来的中继消息。
type Sender = "local" | HostLink;

/** A relaying origin: its number on upstream links, and the open upstream links it relayed holds to. */
// 每个下游 origin 在上游主机获得一个唯一编号；links 记录曾转发到的上游连接，用于关闭通知。
type Relay = { readonly origin: number; readonly links: Set<HostLink> };

/** At most this many of this host's own `bound` and `state` messages unacknowledged per origin. */
// K=2 的确认窗口：本主机自己的绑定/状态消息最多两条未确认，避免慢消费者无限占用内存。
const WINDOW = 2;

/**
 * The provider side of one origin on a link. Ids are the origin's; a message naming an id this side does not know is
 * ignored (Q1), one reusing a live id is a protocol error, and so are more concurrent calls than this side announced.
 * This host's own `bound` and `state` messages go through the window: locally served holds wait while it is full
 * (their ops in their members' pending queues, their bindings for the next slot). A relay forwards upstream messages
 * at once (each upstream host keeps its own window for the origin it sees), so a slow consumer stalls only its origin.
 */
// 每个 origin 一个实例，由 HostLink 创建与删除；origin 0 是对端自己，非零值是下游中继。
export class ProviderSide {
	// 所属连接。
	readonly link: HostLink;
	/** Whose work this side serves: 0 for the peer's own, a relay's number for one of its downstream links. */
	// 本提供端服务的来源编号。
	readonly origin: number;
	// 调用编号到在途调用的映射。
	readonly #calls = new Map<number, RunningCall>();
	// 持有编号到本地 Hold 或中继持有的映射。
	readonly #entries = new Map<number, Hold | RelayedHold>();
	// 本端允许的并发调用数（hello 中声明的 CALLS）。
	readonly #limit: number;
	/** The sender of each `bound` and `state` message in flight, in order: the consumer acknowledges in order. */
	// 按发送顺序记录每条未确认 bound/state 的发送者，ack 按先进先出对应。
	readonly #sent: Sender[] = [];
	/** This host's own messages in flight. */
	// 本主机自己未确认的 bound/state 数，达到 WINDOW 后停止发送。
	#inFlight = 0;
	/** The holds the current batch touched, in order; its flush sends or queues them. */
	// 本批次被触及的 hold；批次 flush 时统一发送或排队。
	#touched: Hold[] = [];
	/** Holds whose ops wait in their pending queues for a slot. */
	// 因窗口满而把操作留在 pending 队列中的 hold。
	readonly #waiting = new Set<Hold>();
	/** Holds waiting for a slot to send their first binding. */
	// 等待名额发送首次 bound 的 hold。
	readonly #binding = new Set<Hold>();
	/** The waiting bindings take the next slot: the last one went to waiting state while they waited. */
	// 交替标志：上一次名额给了 state，下一次优先给 binding，防止两类排队互相饿死。
	#bindingTurn = false;
	/** Set once a hold of this origin is relayed. */
	// 第一次中继时创建；保存本 origin 在上游的编号与连接集合。
	#relay: Relay | undefined;

	// 创建提供端：输入连接、origin 与本端调用上限；只保存字段，消息由 HostLink 转交。
	// 例：HostLink.#hold 首次见到 origin 7 时 new ProviderSide(this, 7, 256)。
	constructor(link: HostLink, origin: number, limit: number) {
		// 保存连接。
		this.link = link;
		// 保存 origin。
		this.origin = origin;
		// 保存并发调用上限。
		this.#limit = limit;
	}

	/** Handles one message of this origin; a call whose arguments wait for an asynchronous inflate returns its promise. */
	// 处理该 origin 的一条消息；只有 call 可能返回 Promise（参数异步解压），其他分支同步完成。
	message(message: ProviderMessage): void | Promise<void> {
		// switch 按 kind 收窄消息类型。
		switch (message.kind) {
			case "hold":
				// 新持有请求。
				this.#hold(message);
				break;
			case "release":
				// 释放指定持有并尝试回收本提供端。
				this.#release(message.hold);
				this.#settle();
				break;
			case "call":
				// 调用可能异步解压参数。
				return this.#call(message);
			case "abort":
				// 取消调用后检查是否可回收。
				this.#abort(message.call);
				this.#settle();
				break;
			case "retry":
				// 未知持有按 Q1 忽略；否则交给持有处理。
				this.#entries.get(message.hold)?.retry(message);
				break;
			case "ack":
				// 确认一条在途消息并推进窗口。
				this.#ack();
				this.#settle();
				break;
		}
	}

	/**
	 * The link closed, or the origin did (`closed`): every hold is released (relayed ones by one `closed` to each
	 * upstream link) and every call aborted.
	 */
	// 关闭提供端：中止本地调用、结束所有持有，并通知中继的上游连接。
	closed(): void {
		// 读取主机是否正在整体关闭；关闭时对象由主机统一结束。
		const closing = this.link.host.closing;
		// 先取快照再清空，避免遍历时修改。
		const entries = [...this.#entries.values()];
		this.#entries.clear();
		// 共享的关闭原因。
		const closed = new ChordError({ code: "unavailable", message: "the link closed" });
		// 本地执行的调用通过 AbortController 取消；中继调用由上游处理。
		for (const call of this.#calls.values()) if (call.kind === "served") call.abort.abort(closed);
		this.#calls.clear();
		// While the host closes, it ends its objects itself.
		// 主机整体关闭时对象自行结束，这里只 drop；平时由 hold 释放对象引用。
		for (const entry of entries) {
			if (entry.kind === "served" && !closing) entry.release();
			else entry.drop();
		}
		// A batch flushing later finds nothing of this side.
		// 清空批次登记，稍后的 flush 不会再发送。
		this.#touched = [];
		// 没有中继记录则结束。
		const relay = this.#relay;
		if (relay === undefined) return;
		// 从主机的 origin 编号表中移除。
		this.link.host.relays.delete(relay.origin);
		// 通知每个上游连接：该 origin 的所有中继结束。
		for (const link of relay.links) link.send({ kind: "closed", origin: relay.origin });
	}

	/** Sends `message` on the link with this origin. */
	// 发送消息；origin 0 不需要字段，其他 origin 自动补上。
	send(message: OriginMessage): void {
		// 条件展开：非零 origin 才附加 origin 字段。
		this.link.send(this.origin === 0 ? message : { ...message, origin: this.origin });
	}

	/**
	 * Ends with `error` every hold of this origin that acts for a principal `revoked` names and holds nothing: served
	 * here but unbound (before the publication, refused), or relayed and waiting for its route's link.
	 */
	// 身份撤销：结束未绑定且身份匹配的持有；已绑定对象由对象侧撤销流程处理。
	revokeUnbound(revoked: (principal: Principal) => boolean, error: ChordError): void {
		// 复制一份再遍历，因为结束操作会修改 #entries。
		for (const hold of [...this.#entries.values()]) {
			// A hold arriving on a link acts for a principal: the link's, or one its parent named.
			// principal 由入口决定（连接盖章或父连接声明），! 表示 hold 必然有身份。
			if (!revoked(hold.caller.principal!)) continue;
			// 本地未绑定的 hold 直接结束。
			if (hold.kind === "served" && hold.unbound) hold.end(error);
			// 仍在等路径连接的中继持有走 revoked 流程。
			else if (hold.kind === "relayed" && hold.waiting) hold.revoked(error);
		}
	}

	/** A pending hold turned out to be relayed: it takes the hold's place in the table. */
	// 原本的 pending Hold 被中继持有替换，编号相同。
	relayed(hold: RelayedHold): void {
		// 覆盖同一编号的条目。
		this.#entries.set(hold.id, hold);
	}

	/** This origin's number on upstream links (one per host, never reused), with `link` as one it relays to. */
	// 取得本 origin 在上游的编号（每个主机唯一且不复用），并登记一条上游连接。
	relayTo(link: HostLink): number {
		// 读取已有中继记录。
		let relay = this.#relay;
		// 第一次中继时创建。
		if (relay === undefined) {
			// relayOrigin 由主机分配唯一编号。
			relay = { origin: this.link.host.relayOrigin(this), links: new Set() };
			this.#relay = relay;
		}
		// 记录该上游连接，关闭时统一通知。
		relay.links.add(link);
		// 返回编号供消息信封使用。
		return relay.origin;
	}

	/**
	 * A message from upstream link `from` for this origin's relayed holds, forwarded with this origin: `bound` and
	 * `state` join the window's senders (their `ack` goes back to `from`), a reply ends its call, `gone` forgets its
	 * hold. A link answers only for what was relayed over it: an entry, a notice or a reply naming a hold (or a call)
	 * this origin did not relay over `from` is dropped (Q1); a `bound` or `state` left without entries is acknowledged
	 * to `from` at once. Parts travel unchecked and unparsed: the end that parses a part checks it against its own
	 * link's limits.
	 */
	// 转发上游回复给下游消费端；输入已由 HostLink 按 origin 路由到本提供端。
	// 不解析分片正文，只过滤属于 from 的条目并重新组装信封。
	forward(message: ConsumerMessage, from: HostLink): void {
		// 没有中继记录或 from 不是登记过的上游连接：丢弃，避免伪造回复。
		const relay = this.#relay;
		if (relay === undefined || !relay.links.has(from)) return;
		// 去掉 origin 字段，得到可重新发送的正文；`_` 是约定不使用的变量名。
		const { origin: _, ...forwarded } = message;
		// 按 kind 分支。
		switch (forwarded.kind) {
			case "bound":
			case "state": {
				// 只保留确实通过 from 中继的持有条目。
				const holds = this.#relayedOver<BoundEntry | StateEntry>(forwarded.holds, from);
				// 全部不属于 from：没有内容可转，直接回 ack 让上游释放窗口。
				if (holds.length === 0) {
					from.send({ kind: "ack", origin: relay.origin });
					return;
				}
				// 记录发送者，使对应 ack 回到 from。
				this.#sent.push(from);
				// The entries of the message's own kind.
				// 全部条目都属于 from 时复用原消息；否则用过滤后的数组。
				// 断言把过滤结果恢复为原联合成员类型：元素类型未变，只是数量减少。
				this.send(holds === forwarded.holds ? forwarded : ({ ...forwarded, holds } as typeof forwarded));
				return;
			}
			case "result":
			case "error": {
				// 按调用编号查找；必须是中继调用且确实通过 from 持有。
				const call = this.#calls.get(forwarded.call);
				if (call?.kind === "relayed" && call.hold.heldOn(from)) this.reply(forwarded.call, forwarded);
				return;
			}
			case "gone": {
				// 找到中继持有后先本地遗忘，再转发 gone。
				const hold = this.#relayedHold(forwarded.hold, from);
				if (hold === undefined) return;
				hold.lost();
				this.send(forwarded);
				return;
			}
			default:
				// 其余（failed/loading）只要持有确实属于 from 就转发。
				if (this.#relayedHold(forwarded.hold, from) !== undefined) this.send(forwarded);
		}
	}

	/** An upstream link closed: nothing more is relayed to it, nor accepted from it. */
	// 上游连接关闭：从集合移除，之后的回复不再被接受。
	unlinked(link: HostLink): void {
		// 可选链在无中继记录时无动作。
		this.#relay?.links.delete(link);
	}

	/**
	 * The upstream link of relayed hold `hold` dropped with `error`: its calls in flight fail, the hold goes loading
	 * downstream, and its path's next link holds it again.
	 */
	// 上游断开：该持有的在途调用立即失败，并告知下游进入 loading 等待新连接。
	upstreamDropped(hold: RelayedHold, error: ChordError): void {
		// 遍历调用表，找到属于该持有的调用。
		for (const [id, call] of this.#calls) {
			// 用 error 回复下游；reply 会删除调用并释放记录。
			if (call.hold === hold) this.reply(id, { kind: "error", call: id, error: wireError(error) });
		}
		// 通知下游对象重新绑定。
		this.send({ kind: "loading", hold: hold.id });
	}

	/**
	 * Forgets a hold (released, refused or gone) and every call on it; local calls are aborted with `error` (its
	 * object's end for a gone hold, `released` otherwise).
	 */
	// 遗忘持有及其全部调用：本地调用通过 AbortController 取消，中继调用由上游负责。
	forget(hold: Hold | RelayedHold, error?: ChordError): void {
		// 只有表里仍是这个实例才删除，防止编号被替换后误删。
		if (this.#entries.get(hold.id) === hold) this.#entries.delete(hold.id);
		// 未提供原因时按 released 处理。
		const reason = error ?? new ChordError({ code: "released", message: `hold ${hold.id}: released` });
		// 扫描调用表，删除属于该持有的调用。
		for (const [id, call] of this.#calls) {
			if (call.hold !== hold) continue;
			this.#calls.delete(id);
			// 本地执行中的处理器收到取消信号。
			if (call.kind === "served") call.abort.abort(reason);
		}
		// 本地 hold 还要退出窗口等待集合。
		if (hold.kind === "served") this.unbind(hold);
		// 判断是否可以回收提供端。
		this.#settle();
	}

	/** A call ended with `reply` (a result or an error): its slot is free; nothing is sent for one already gone. */
	// 回复一个调用：删除在途登记并发送结果；已删除（取消/释放）的调用不再回复。
	reply(id: number, reply: Extract<OriginMessage, { readonly kind: "result" | "error" }>): void {
		// delete 返回 false 表示调用已不存在。
		if (!this.#calls.delete(id)) return;
		// 发送回复，自动补 origin。
		this.send(reply);
		// 可能可以回收提供端。
		this.#settle();
	}

	/**
	 * Drops this side from its link once it holds nothing: no holds, no calls, nothing in flight. Its origin's next hold
	 * makes a new one (origins are never reused), so a long-lived link keeps records only for live work.
	 */
	// 没有持有、调用和在途消息时从连接中移除本提供端，避免长期连接积累空记录。
	#settle(): void {
		// 三个集合都空才删除。
		if (this.#entries.size === 0 && this.#calls.size === 0 && this.#sent.length === 0) this.link.drop(this);
	}

	/** A hold's object is live: its `bound` goes now when a slot is free, else with the next free slot's bindings. */
	// 对象已 live：有名额则立即发送 bound，否则加入等待绑定集合。
	bind(hold: Hold, context: Context): void {
		// #free 同时检查窗口与两类排队，保持先来先服务。
		if (this.#free) {
			// 单条 bound 也走 sendOwn，以占用窗口名额。
			this.#sendOwn({ kind: "bound", holds: [hold.boundEntry(context)] });
		} else {
			// 等名额释放时统一发送。
			this.#binding.add(hold);
		}
	}

	/** A hold stopped waiting for a slot: it was forgotten. */
	// 持有被遗忘时从两个等待集合移除。
	unbind(hold: Hold): void {
		// 删除操作对不存在的元素是安全的。
		this.#waiting.delete(hold);
		this.#binding.delete(hold);
	}

	/**
	 * A served hold left its object's binding (slice 7b §6, model §5): its unsent pending ops and a queued `bound` are
	 * dropped (the ack slots of messages already sent stay until their `ack`), its calls in flight rejected with `error`
	 * (each slot freed once).
	 */
	// 解除绑定：作废未发送数据，拒绝在途调用；已发送消息仍占窗口直到 ack。
	unbound(hold: Hold, error: ChordError): void {
		// 退出等待集合。
		this.unbind(hold);
		// 遍历该持有的调用。
		for (const [id, call] of this.#calls) {
			if (call.hold !== hold) continue;
			// 本地处理器取消。
			if (call.kind === "served") call.abort.abort(error);
			// 给消费端回错误；reply 删除调用并释放名额。
			this.reply(id, { kind: "error", call: id, error: wireError(error) });
		}
	}

	/** A hold's members changed in the current batch; its flush sends or queues it. */
	// 成员变化时登记 hold；批次第一次登记时向主机注册 flush 回调。
	touched(hold: Hold): void {
		// 只有第一次需要注册，避免重复回调。
		if (this.#touched.length === 0) this.link.host.batch.flushing((context) => this.#flush(context));
		// 记录本批次的 hold。
		this.#touched.push(hold);
	}

	/**
	 * `entries` whose holds this origin relayed over `from`, in one pass: the same array when all are, else a copy made
	 * at the first one that is not.
	 */
	// 过滤属于 from 的中继条目；全部符合时返回原数组，避免复制。
	#relayedOver<E extends { readonly hold: number }>(entries: readonly E[], from: HostLink): readonly E[] {
		// 泛型 E 至少含 hold 编号；kept 为 undefined 表示目前全部符合。
		let kept: E[] | undefined;
		// 按下标遍历，便于在第一次不符合时复制前缀。
		for (let i = 0; i < entries.length; i++) {
			// ! 表示下标在范围内。
			const entry = entries[i]!;
			// 判断该条目是否通过 from 中继。
			const relayed = this.#relayedHold(entry.hold, from) !== undefined;
			if (kept !== undefined) {
				// 已进入复制模式：只追加符合项。
				if (relayed) kept.push(entry);
			} else if (!relayed) {
				// 第一次不符合：复制此前全部符合的前缀。
				kept = entries.slice(0, i);
			}
		}
		// 从未遇到不符合项时返回原数组。
		return kept ?? entries;
	}

	/** The hold `id` of this origin when it is relayed over `from`. */
	// 按编号取中继持有，并确认它确实通过 from 持有。
	#relayedHold(id: number, from: HostLink): RelayedHold | undefined {
		// 查找条目。
		const hold = this.#entries.get(id);
		// 必须是 relayed 且 heldOn(from)，否则视为未知。
		return hold?.kind === "relayed" && hold.heldOn(from) ? hold : undefined;
	}

	/**
	 * A hold message: a protocol error for a live id or compressed params (params are never compressed), otherwise
	 * admitted (`Hold.start`, placed once the host published). Its activation chain is kept only from a trusted link (Q5); its
	 * decoded limit is the link's, or the smaller one a parent stamped (Q2), and travels with it when it is relayed.
	 */
	// 受理 hold 消息：校验编号与 params，决定 honored 的 chain/limit，再创建 Hold。
	#hold(message: Extract<Message, { readonly kind: "hold" }>): void {
		// 编号已被占用是协议错误：持有编号在连接内不能复用。
		if (this.#entries.has(message.hold)) throw new Error(`hold ${message.hold}: the id is in use`);
		// params 从不压缩；收到压缩分片说明对端违反协议。
		if (message.params instanceof DeflatedPart) throw new Error(`hold ${message.hold}: compressed params`);
		// Whom it acts for is decided here once (`#caller`), never passed on: a relay names it only on a route link.
		// 解构去掉信封字段与身份字段；下划线变量同样表示不使用。
		const {
			kind: _kind,
			origin: _origin,
			hold: id,
			principal: _principal,
			incarnation: _incarnation,
			chain,
			limit: stamped,
			...fields
		} = message;
		// 取本连接。
		const { link } = this;
		// 只有父连接盖章的解码上限才被采用；其余情况用 Infinity，使 min 取连接上限。
		const limit = Math.min(link.limits.decoded, (link.role === "parent" ? stamped : undefined) ?? Infinity);
		// 重新组装请求：chain 只保留可信连接上的，limit 只在有限时保留。
		const request = {
			...fields,
			...(chain !== undefined && link.trusted ? { chain } : {}),
			...(limit === Infinity ? {} : { limit }),
		};
		// 上限未变时复用连接的 limits 对象，否则只替换 decoded。
		const limits = limit === link.limits.decoded ? link.limits : { part: link.limits.part, decoded: limit };
		// 入口处一次性决定调用者身份。
		const hold = new Hold(id, this, this.#caller(message), limits);
		// 登记编号。
		this.#entries.set(id, hold);
		// 启动放置流程。
		hold.start(request);
	}

	/**
	 * Whom a hold acts for: on a parent link the hold's own principal and incarnation when it names them, everywhere
	 * else the link's principal and the peer's incarnation (a child cannot claim to be someone else).
	 */
	// 决定 hold 的调用者身份；这是信任边界，子连接与路由连接不能自行声明身份。
	#caller(message: Extract<Message, { readonly kind: "hold" }>): Caller {
		// 取连接。
		const { link } = this;
		// 非父连接：使用连接盖章的 principal 与对端 incarnation。
		if (link.role !== "parent") return { principal: link.principal, incarnation: link.peer };
		// The message schema checked a principal's shape on an untrusted link; a trusted parent is believed.
		// 父连接允许声明身份；不可信链路上 schema 已检查形状，可信父连接直接相信。
		const principal = (message.principal as Caller["principal"]) ?? link.principal;
		// incarnation 缺省时用对端 hello 中的值。
		return { principal, incarnation: message.incarnation ?? link.peer };
	}

	// 处理 release：未知编号忽略；先遗忘调用与登记，再让 hold 释放对象。
	#release(id: number): void {
		// 查找持有。
		const hold = this.#entries.get(id);
		if (hold === undefined) return;
		// 删除调用并退出等待集合。
		this.forget(hold);
		// 通知对象解除持有。
		hold.release();
	}

	/**
	 * A call: one on a hold this side does not know is ignored (Q1), more than this side's N at once and compressed
	 * arguments from a child (clients never compress) are protocol errors. On a relayed hold it is forwarded, its
	 * arguments checked against this link's part limit first (the bytes are here). On a served hold that is not bound
	 * yet (nor binding afresh after a swap) it is refused `not_ready`; its method is an index into the bound variant (one
	 * outside it is a protocol error) and its arguments are opened and parsed here within the hold's limits (past one
	 * the call fails `too_large/part`; a malformed part is a protocol error), absent ones `null`. Arguments this host
	 * must inflate asynchronously are inflated first, then the call is handled again.
	 */
	// 处理调用：校验编号、并发数与压缩规则；中继直接转发，本地则解析参数并异步执行。
	#call(message: Extract<Message, { readonly kind: "call" }>): void | Promise<void> {
		// 调用编号在本提供端内不能复用。
		if (this.#calls.has(message.call)) throw new Error(`call ${message.call}: the id is in use`);
		// 未知持有按 Q1 忽略，避免已释放持有的迟到调用报错。
		const hold = this.#entries.get(message.hold);
		if (hold === undefined) return;
		// 并发调用不能超过本端在 hello 中声明的数量。
		if (this.#calls.size >= this.#limit) throw new Error(`call ${message.call}: more than ${this.#limit} calls`);
		// 取参数分片与字节段。
		const { args: part, segments } = message;
		// 子连接（客户端）从不压缩参数；收到压缩分片是协议错误。
		if (part instanceof DeflatedPart && this.link.role === "child") {
			throw new Error(`call ${message.call}: compressed arguments from a child`);
		}
		// 中继持有：本主机只检查链路 part 上限，不解析正文。
		if (hold.kind === "relayed") {
			// 未压缩时才检查体积；oversized 返回错误或 undefined。
			const error = part === undefined ? undefined : oversized(part, this.link.limits.part);
			if (error !== undefined) {
				// 超限在入表前拒绝，不占调用名额。
				this.#refuse(message.call, error);
				return;
			}
			// 登记为中继调用，使回复能按编号找回。
			this.#calls.set(message.call, { kind: "relayed", hold });
			// 交给中继持有转发上游。
			hold.call(message);
			return;
		}
		// 本地持有必须可调用：已绑定，或换实例期间仍有旧名字。
		if (!hold.callable) {
			// 未绑定给消费端一个明确的 not_ready 错误。
			this.#refuse(message.call, new ChordError({ code: "not_ready", message: `hold ${hold.id}: not bound yet` }));
			return;
		}
		// 方法索引换成方法名；越界会抛协议错误。
		const method = hold.method(message.method);
		// 参数需要异步解压时先解压，再用同一消息重新进入本方法。
		if (this.link.inflates(part, hold.limits)) {
			return this.link.inflate([[part, hold.limits.decoded]], () => this.#call(message));
		}
		// 声明解析结果；无参数时为 undefined。
		let json: string | Uint8Array | undefined;
		try {
			// 按 hold 的上限打开分片；超限抛出 too_large。
			json = part === undefined ? undefined : this.link.openPart(part, hold.limits, this.link.context);
		} catch (error) {
			// 只有超限是调用级失败；其他错误（畸形压缩流等）是协议错误，向上抛。
			if (!isChordError(error, "too_large")) throw error;
			this.#refuse(message.call, error);
			return;
		}
		// 无参数按协议解析为 null；有参数则结合字节段解析。
		const args = json === undefined ? null : parsePayload(json, segments);
		// as const 保留字面量字段类型；AbortController 用于取消处理器。
		const call = { kind: "served", hold, bytes: method.resultBytes, abort: new AbortController() } as const;
		// 登记在途调用。
		this.#calls.set(message.call, call);
		// 异步执行；void 明确表示不等待，错误在 #run 内处理。
		void this.#run(message.call, call, method.name, args);
	}

	/**
	 * Runs a call and sends its result (absent when `null`) or error, unless it was aborted, released or gone
	 * meanwhile. A result that cannot be encoded is sent as its error.
	 */
	// 执行本地调用并回复；处理器抛出的异常会作为 error 回复。
	async #run(
		id: number,
		call: Extract<RunningCall, { readonly kind: "served" }>,
		method: string,
		args: unknown,
	): Promise<void> {
		// 声明回复消息，try/catch 两条路径都赋值。
		let reply: Extract<OriginMessage, { readonly kind: "result" | "error" }>;
		try {
			// A link's context has no abort signal, so this is the call's own signal: no `AbortSignal.any` per call.
			// 连接上下文没有取消信号，因此 withAbortSignal 只组合调用自身的信号，避免每次调用创建合并信号。
			const result = await call.hold.call(method, args, withAbortSignal(call.abort.signal, this.link.context));
			// Results are not validated: they are the provider's.
			// 结果不做 schema 校验，提供者对其返回值负责。
			// 无值（null/undefined）发送不带 value 的 result；有值则编码为结果分片。
			reply =
				result === null || result === undefined
					? { kind: "result", call: id }
					: this.#result(id, result, call.bytes, this.link.context);
		} catch (error) {
			// 处理器错误转成网络信封；插件错误也会被保留。
			reply = { kind: "error", call: id, error: wireError(error) };
		}
		// 统一回复；调用可能已被取消，reply 会安全忽略。
		this.reply(id, reply);
	}

	/** Answers call `id` with `error` before it was admitted: it took no slot. */
	// 在调用入表前拒绝：只发送 error，不占用并发名额。
	#refuse(id: number, error: ChordError): void {
		// 错误先转成网络信封。
		this.send({ kind: "error", call: id, error: wireError(error) });
	}

	// 处理 abort：本地调用取消处理器，中继调用把 abort 转发上游。
	#abort(id: number): void {
		// 查找在途调用。
		const call = this.#calls.get(id);
		if (call === undefined) return;
		// 先删除，避免重复处理。
		this.#calls.delete(id);
		// 中继调用由 RelayedHold 转发。
		if (call.kind === "relayed") call.hold.abort(id);
		// 本地调用通过信号取消。
		else call.abort.abort(new ChordError({ code: "aborted", message: `call ${id}: aborted by its caller` }));
	}

	/**
	 * An `ack` answers the oldest message in flight: this host's own frees a slot, a relayed one is acknowledged to its
	 * upstream link (closed meanwhile: nothing to do). An ack crossing nothing in flight is ignored.
	 */
	// 处理 ack：按发送顺序确认最早一条未确认消息。
	#ack(): void {
		// shift 取出队首发送者。
		const sender = this.#sent.shift();
		// 没有在途消息时忽略多余 ack。
		if (sender === undefined) return;
		// 中继消息：把 ack 转给上游连接，使用本 origin 在上游的编号。
		if (sender !== "local") {
			// A relayed message implies the relay's number.
			// 既然有中继消息，中继记录必然存在。
			sender.send({ kind: "ack", origin: this.#relay!.origin });
			return;
		}
		// 本主机消息：释放一个名额并尝试发送等待项。
		this.#inFlight--;
		this.#slotFreed();
	}

	/**
	 * The end of a batch: while a slot is free and nothing waits, one `state` message with an entry per touched hold;
	 * otherwise each touched hold's ops join its pending queues until a slot frees.
	 */
	// 批次 flush：有空位且无人排队时把本批次变化合成一条 state；否则把操作放进各成员 pending 队列。
	#flush(context: Context): void {
		// 取本批次登记的 hold。
		const holds = this.#touched;
		// The side closed during the batch: nothing is sent.
		// 提供端可能在批次期间关闭，此时不发送。
		if (holds.length === 0) return;
		// 清空登记，下一批次重新累积。
		this.#touched = [];
		// A hold touched in this batch may have left its binding since (a reload unbound it).
		// 只有仍绑定的 hold 才有变化可发。
		if (this.#free) {
			// 收集仍绑定的条目。
			const entries: StateEntry[] = [];
			for (const hold of holds) if (hold.bound) entries.push(hold.entry(context));
			// 有条目才发送，空 state 没有意义。
			if (entries.length > 0) this.#sendOwn({ kind: "state", holds: entries });
			return;
		}
		// A bound hold never waits for its binding.
		// 窗口满：操作留在各成员 pending 队列，等名额释放。
		for (const hold of holds) {
			if (!hold.bound) continue;
			hold.queue();
			this.#waiting.add(hold);
		}
	}

	/** Whether this host's next message goes out now: a slot is free and nothing waits for one. */
	// 私有 getter：窗口有空位且没有等待中的绑定/状态时才可立即发送。
	get #free(): boolean {
		// 三个条件同时满足。
		return this.#binding.size === 0 && this.#waiting.size === 0 && this.#inFlight < WINDOW;
	}

	/**
	 * A slot may be free: while there is room, the waiting state goes out as one message and the waiting bindings as
	 * one `bound`, taking turns when both wait (state first), so neither a hold that keeps changing nor a stream of new
	 * holds starves the other.
	 */
	// 名额释放后尽量填满窗口：state 与 bound 交替发送，避免任一类排队饿死。
	#slotFreed(): void {
		// 使用连接上下文构造分片。
		const context = this.link.context;
		// 窗口还有空位时循环。
		while (this.#inFlight < WINDOW) {
			// 有待发绑定，且没有状态等待或轮到绑定时，优先绑定。
			if (this.#binding.size > 0 && (this.#waiting.size === 0 || this.#bindingTurn)) {
				// 取出全部等待绑定，作为一个 bound 消息。
				const holds = [...this.#binding];
				this.#binding.clear();
				// 下一次名额优先给 state。
				this.#bindingTurn = false;
				// Every snapshot in one synchronous step: the binding shows all of them at one moment.
				// 所有快照在同一个同步步骤内生成，消费端看到同一时刻的一致状态。
				this.#sendOwn({ kind: "bound", holds: holds.map((hold) => hold.boundEntry(context)) });
			} else if (this.#waiting.size > 0) {
				// 取出全部等待状态。
				const holds = [...this.#waiting];
				this.#waiting.clear();
				// 若仍有绑定等待，下一轮让给绑定。
				this.#bindingTurn = this.#binding.size > 0;
				// 每个 hold 一条 state 条目。
				this.#sendOwn({ kind: "state", holds: holds.map((hold) => hold.pendingEntry(context)) });
			} else {
				// 没有任何等待，结束循环。
				return;
			}
		}
	}

	/**
	 * A call's result message, its part deflated above the threshold when this host compresses; with byte segments when
	 * its method's result schema has a `bytes()` leaf.
	 */
	// 编码结果消息：结果 JSON 按需拆字节段并打包分片。
	#result(
		id: number,
		result: unknown,
		bytes: boolean,
		context: Context,
	): Extract<OriginMessage, { readonly kind: "result" }> {
		// payloadPart 返回 JSON 文本与可选字节段。
		const { json, segments } = payloadPart(result, bytes);
		// 打包成分片，主机压缩器可能压缩。
		const value = this.link.part(json, context);
		// 条件展开只在有字节段时加入字段。
		return { kind: "result", call: id, value, ...(segments === undefined ? {} : { segments }) };
	}

	/** Sends one of this host's own `bound` or `state` messages, taking a slot. */
	// 发送本主机自己的 bound/state：先占名额并登记为 local，再发送。
	#sendOwn(message: Extract<OriginMessage, { readonly kind: "bound" | "state" }>): void {
		// 计数加一，窗口据此阻塞。
		this.#inFlight++;
		// 记录发送者，ack 时据此释放名额。
		this.#sent.push("local");
		// 发送消息。
		this.send(message);
	}
}
