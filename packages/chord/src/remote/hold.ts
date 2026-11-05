// 本文件实现提供端服务的一条 hold：到达后等待主机发布、放置、拒绝或中继，持有对象、跟踪其失败与重试，并在窗口内发送快照与成员变化。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的本地服务持有。
// 职责边界：管理一条入站 hold 的状态机（unplaced/pending/binding/bound/refused/released）、对象引用、成员订阅与待发帧；不负责连接窗口的调度（ProviderSide）也不解析调用参数（ProviderSide 已完成）。
// 上游入口：ProviderSide.#hold 校验消息后构造并调用 start；Host 发布、索引唤醒、对象 moved/removed 都会驱动状态迁移。
// 下游依赖：主机 place/serving/index/unindex（放置与对象）、ChordObject（对象状态与调用）、Delta encoder/PendingOps（操作编码）、Source（成员订阅）。
// 结果与错误流向：failed/loading/gone/bound/state 都通过 ProviderSide.send 发出；拒绝原因分 waiting（可被发布唤醒）与 broken（等 retry）。
//
// 能力清单：
// - type HoldRequest：去掉连接决定的字段后的 hold 请求。
// - class Hold：start 放置，wake/retry 重启，moved 跟随对象状态，boundEntry/entry/queue/pendingEntry 生成快照与批次帧，release/drop/end 结束，removed 处理类型或版本移除。
// - function actingFor：仅在路由连接上返回调用者身份字段。
//
// 组合关系：ProviderSide 创建 Hold；对象 live 后 ProviderSide.bind 取得 boundEntry；批次变化经 subscribe 回调进入 #changes，flush 时 entry 或 queue。
// 示例：const hold = new Hold(id, provider, caller, limits); hold.start(request);
// 建议阅读顺序：先看 HoldState 与 Followed，再看 start/moved 的状态机，然后 boundEntry/entry/pendingEntry，最后 release/end/removed。
// A hold arriving on a link and served here (§7, §22, W1): where it goes once the host published (waiting in the
// unbound index until then), why it is unbound (refused: kept in the index while it waits for a name, dependency
// model §1), the object it keeps, the notices of its object's failures and new attempts, the snapshot and subscription
// taken in one synchronous step when a slot of the window is free, and the ops of its members per batch (sent at
// once, or pending while the window is full), each member with its own Delta encoder. Across a reload (slice 7b §6) a
// bound hold is kept: a swap in place sends it a fresh `bound` once the new instance is live (it answers calls
// meanwhile), an object leaving `live` unbinds it (`loading` or `failed`, then a fresh `bound`), a version no longer
// bound or a removed type leaves it waiting unbound. A hold of an older version follows its object's adapted members
// (Q10).

// 导入上下文、合约变体工具、错误类型、Delta 编码器、主机内部持有者类型、链路消息工具、状态源，以及提供端与中继类型。
import type { Context } from "../context/index.ts";
import { type VariantData, type VariantNames, variantNames, variantOrder, variantsAt } from "../contracts/internal.ts";
import { ChordError, type FailureCause, isChordError, type Principal } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import { type Encoder, encoder, type Op, PendingOps } from "../delta/index.ts";
import {
	type Caller,
	type ChordObject,
	type Holder,
	type Removal,
	retryWalk,
	type Serving,
	type UnboundRequest,
} from "../host/internal.ts";
import type { JsonValue } from "../json.ts";
import {
	type BoundEntry,
	type FailedMember,
	jsonPart,
	type Limits,
	type Message,
	NO_RETIRED,
	oversized,
	parsePart,
	type StateEntry,
	wireError,
} from "../link/internal.ts";
import { type DeriveSource, Source, type Subscriber } from "../state/internal.ts";
import type { HostLink } from "./host-link.ts";
import type { ProviderSide } from "./provider.ts";
import { RelayedHold } from "./relay.ts";

/** A `hold` message. */
// Extract 把 Message 联合收窄为 kind 为 "hold" 的那一个成员。
type HoldMessage = Extract<Message, { readonly kind: "hold" }>;

/**
 * What a `hold` message asks for. Whom it acts for is not part of it: a host takes that from the message once, as its
 * link allows (`ProviderSide`), and names it again only on a route link (`actingFor`). Its `chain` and `limit` are the
 * ones this host honours, sent on as they are when it relays the hold.
 */
// Omit 从 HoldMessage 去掉由连接/提供端决定的字段，只留下可转发的请求内容。
export type HoldRequest = Omit<HoldMessage, "kind" | "origin" | "hold" | "principal" | "incarnation">;

/**
 * A state member a bound hold follows: its index in the bound version, its source and subscription (which feeds this
 * record), its own encoder (R1, path interning) and the ops waiting for a slot of the window.
 */
// 每个被跟随成员一条记录；encoder 与 pending 都是每成员独立，避免不同成员共享 Delta 路径词典。
type Followed = {
	// 成员在绑定版本中的线上索引。
	readonly index: number;
	/** Its source (subscribed when it changes, a constant's never). */
	// 成员的值源；常量没有订阅，只有 Source 实例才会订阅。
	readonly source: DeriveSource;
	// 订阅句柄，取消跟随时用它退订。
	readonly subscriber: Subscriber;
	// 该成员的 Delta 编码器，替代旧值并生成操作。
	readonly encoder: Encoder;
	// 窗口满时累积的操作队列。
	readonly pending: PendingOps;
};

/**
 * Where a hold stands: `unplaced` in the unbound index until the host's publication places it; `pending` until its
 * object is live (the activation, parking and retries; `toldFailed` once the consumer was told of a failure, so the
 * next attempt is announced with `loading`); `binding` while its object is live and its `bound` waits for a slot
 * (after a swap in place with the names it was bound with, `previous`: the consumer still holds it bound, so its calls
 * are answered by those names, design §22; only contract data, so the old instance and its sources go meanwhile);
 * `bound` with the object's variant and the members it follows.
 */
// 可区分联合：每个 kind 只带该阶段需要的字段，读取前用 kind 收窄。
type HoldState =
	// 主机尚未发布：保存请求，等待 index 唤醒。
	| { readonly kind: "unplaced"; readonly request: HoldRequest }
	// 等待对象变为 live；toldFailed 记录是否已把失败告诉消费端。
	| { readonly kind: "pending"; readonly toldFailed: boolean }
	// 对象已 live，bound 消息在等窗口名额；previous 仅在原地换实例后存在。
	| { readonly kind: "binding"; readonly previous?: BoundNames }
	| {
			readonly kind: "bound";
			/** The bound variant's data at the hold's version. */
			// 该 hold 所用版本中的 variant 数据（可能是历史版本）。
			readonly variant: VariantData;
			/** The bound version's names of the variant, which the wire's indexes point into. */
			// 绑定版本的成员名顺序，线上索引指向这里。
			readonly names: VariantNames;
			/** The members it follows, in the order they were subscribed. */
			// 已跟随成员，按订阅顺序保存。
			readonly followed: Followed[];
			/** The instance it was bound to: a swap brings another, which it binds to afresh. */
			// 绑定的对象实例；换实例后与当前实例不同，会触发重新绑定。
			readonly instance: unknown;
	  }
	/**
	 * Refused where it arrived, with `cause`: `waiting` (not served here, another version, placed elsewhere by the
	 * provider's code) in the unbound index until a publication wakes it; `broken` (invalid params, a cycle, a route that
	 * refused, a part past the limits) until a `retry` restarts it.
	 */
	// 被拒绝：waiting 可等发布唤醒，broken 只能等 retry。
	| { readonly kind: "refused"; readonly request: HoldRequest; readonly cause: FailureCause }
	// 已释放或结束，之后不再处理。
	| { readonly kind: "released" };

/** A bound hold's state. */
// 从联合中抽出 bound 分支，函数签名可直接使用而不重复写 kind。
type Bound = Extract<HoldState, { readonly kind: "bound" }>;

/** What calls need of a binding: its variant's data at the hold's version and the names the wire's indexes point into. */
// 调用只需要 variant 数据和名字索引，不需要成员订阅；原地换实例期间仍用旧名字应答。
type BoundNames = { readonly variant: VariantData; readonly names: VariantNames };

// 两个无字段状态复用同一对象，避免每次分配。
const PENDING: HoldState = { kind: "pending", toldFailed: false };

const BINDING: HoldState = { kind: "binding" };

/**
 * One hold served here: a reference to its object acting as its caller (the hold's principal). While pending, each
 * failure of its object is sent as `failed` (with the rest of its backoff window) and the next attempt as `loading`; a
 * hold that cannot be taken holds nothing: `failed { waiting }` (not served, another version) until a publication
 * re-runs its start, `failed { broken }` (invalid params, a cycle) until a `retry` does. Once live it binds when its
 * link's window has a slot, then sends a part per batch that changed its members (or keeps their ops pending while the
 * window is full), and `gone` when its object ends. It counts as one of the host's references from its arrival to its
 * end, bound or not.
 */
// 实现 Holder 与 UnboundRequest 两个主机接口：既能作为对象持有者，也能留在未绑定索引中等待。
export class Hold implements Holder, UnboundRequest {
	// 字面量标签，提供端据此区分本地 Hold 与 RelayedHold。
	readonly kind = "served";
	// 该 origin 内唯一的持有编号。
	readonly id: number;
	/** A hold is declared by no object on this host. */
	// 远端请求在本主机没有声明它的对象，因此依赖为空。
	readonly dependent = undefined;
	/** Whom the hold acts for: its calls run as it, with its origin's incarnation. */
	// 调用者身份，调用对象方法时作为 principal/incarnation 传入。
	readonly caller: Caller;
	/** The limits per part of its params and its calls' arguments: its link's, the decoded one smaller when stamped (Q2). */
	// 参数与调用参数的分片上限；父主机盖章的更小上限会被采用。
	readonly limits: Limits;
	// 所属提供端。
	readonly #provider: ProviderSide;
	// 当前阶段，初始为 pending。
	#state: HoldState = PENDING;
	/** What it asks for (its params owned), once it started: it is placed again after a reload left it unbound. */
	// 启动后保存请求副本，重载后重新放置时使用；params 已复制，不引用消息缓冲。
	#request: HoldRequest | undefined;
	/** The held object, from its binding until the hold is released. */
	// 当前持有的本地对象。
	#object: ChordObject | undefined;
	/** The members the current batch changed, with their ops, in order. */
	// 本批次内发生变化的成员及其操作；刷出后清空。
	#changes: (readonly [Followed, readonly Op[]])[] = [];
	/** The members that failed since the last message that carried this hold. */
	// 自上次携带本 hold 的消息以来失败的成员。
	#failed: FailedMember[] = [];
	/** The members whose document was retired since the last message that carried this hold (ORed while it waits). */
	// 自上次消息以来的退役成员索引；等待期间按位或合并。
	#retired: readonly number[] = NO_RETIRED;
	// 本批次是否已把本 hold 报告给提供端，避免重复登记。
	#touched = false;
	/** Whether the hold counts as one of the host's references (`host.activity`): from its arrival until it ends. */
	// 是否已计入主机活动统计；构造时 +1，drop 时 -1，只减一次。
	#counted = true;

	// 创建 hold：输入编号、提供端、调用者与分片上限；构造只保存字段并把主机引用计数加一。
	// 例：ProviderSide.#hold 校验消息后 new Hold(id, this, caller, limits)，随后调用 start(request)。
	constructor(id: number, provider: ProviderSide, caller: Caller, limits: Limits) {
		// 保存编号。
		this.id = id;
		// 保存提供端，发送消息与登记窗口都通过它。
		this.#provider = provider;
		// 保存调用者身份。
		this.caller = caller;
		// 保存分片上限。
		this.limits = limits;
		// 主机活动计数器加一；hold 到达即算一个引用。
		provider.link.host.count("references", 1);
	}

	/** Whether the hold is bound: its members' changes are sent. */
	// 是否已绑定：只有 bound 状态会发送成员变化。
	get bound(): boolean {
		// 用 kind 比较即可。
		return this.#state.kind === "bound";
	}

	/** Whether calls on it reach its object: bound, or binding afresh after a swap in place (its `bound` not sent yet). */
	// 是否可调用：已绑定，或原地换实例后正等 bound 名额但已有旧名字可用。
	get callable(): boolean {
		// 读取状态。
		const state = this.#state;
		// binding 且有 previous 时，消费端仍认为它绑定在老名字上，可以继续应答。
		return state.kind === "bound" || (state.kind === "binding" && state.previous !== undefined);
	}

	/** Whom it acts for (the unbound index's revocation). */
	// 暴露 principal；未绑定索引撤权时读取它。
	get principal(): Principal | undefined {
		// 调用者的 principal 可能为空（未认证）。
		return this.caller.principal;
	}

	/** Its consumer's contract version and fingerprint (its request's): the provider binds them or it waits. */
	// 读取原始请求；! 断言调用方只在 start 之后读取它。
	get contract(): HoldRequest {
		// #request 在 start 成功后设置。
		return this.#request!;
	}

	/** Whether the hold holds no object: before the publication, or refused (revocation ends it, §4). */
	// 是否尚未持有对象：发布前或拒绝后；已释放不算。
	get unbound(): boolean {
		// 对象为空且状态不是 released。
		return this.#object === undefined && this.#state.kind !== "released";
	}

	/**
	 * Admits the hold: before the host's publication it waits in the unbound index, placed by the publication.
	 * Then its params within the link's part limit (`too_large/part`), then relayed (it is replaced by a relayed hold),
	 * or served here, its params opened and parsed (a malformed part is a protocol error), its object taken and followed
	 * (`moved`) in the turn it arrived. A hold that cannot be served here waits refused (`#refuse`).
	 */
	// 受理 hold：发布前登记到未绑定索引；发布后校验参数上限、决定中继或本地服务，并取对象跟随。
	start(request: HoldRequest): void {
		// 读取连接。
		const { link } = this.#provider;
		// 主机尚未发布：保存请求副本并登记，等发布时唤醒。
		if (!link.host.published) {
			// owned 复制 params，避免长期引用消息缓冲。
			this.#state = { kind: "unplaced", request: owned(request) };
			// index 按类型名登记，发布时按类型重新放置。
			link.host.index(request.type, this, undefined);
			return;
		}
		// 声明放置结果；分支内赋值。
		let served: Serving;
		try {
			// 参数分片超过连接 part 上限：直接作为 too_large 抛出。
			const oversize = oversized(request.params, link.limits.part);
			if (oversize !== undefined) throw oversize;
			// 主机决定本地服务、路由路径（中继）或拒绝。
			const placed = link.host.place(request, link, this.caller, link.context);
			// path 表示该 hold 要去上游，本主机只中继。
			if (placed.kind === "path") {
				// Counted where it is served: a relayed hold is not this host's reference.
				// 中继由上游主机计数，这里先撤销本地计数并退出。
				this.drop();
				// 用相同编号创建中继持有，并立即开始。
				new RelayedHold(this.id, this.#provider, request, this.caller, placed.path).start();
				return;
			}
			// 参数正文在本地解析。
			let params: unknown;
			try {
				// 先按 hold 上限打开分片（可能解压），再解析 JSON。
				params = parsePart(link.openPart(request.params, this.limits, link.context));
			} catch (error) {
				// Past its limits: the hold's \`too_large/part\`. No JSON: a protocol error, reported, and the link closes.
				// 超限属于该 hold 的失败；JSON 畸形则是协议错误，上报并关闭连接。
				if (isChordError(error, "too_large")) throw error;
				link.host.report({ kind: "protocol_error", error });
				link.close();
				return;
			}
			// 让主机按参数与调用者取对象；principal! 成立是因为 ProviderSide.#caller 总会回落到连接盖章的身份，而连接必有身份。
			served = link.host.serving(request, params, this.caller.principal!, link.context);
		} catch (error) {
			// 任何失败都变成 broken 拒绝，等待 retry 重新启动。
			this.#refuse(request, { kind: "broken", error: asChordError(error, request.type) });
			return;
		}
		// 主机暂时无法服务：保留 waiting 原因，发布后可能恢复。
		if (served.kind === "waiting") {
			this.#refuse(request, served.cause);
			return;
		}
		// 保存请求副本，供重载后重新放置。
		this.#request = owned(request);
		// 取出对象。
		const { object } = served;
		// 记录持有。
		this.#object = object;
		// 对象登记该持有者。
		object.hold(this);
		// 根据对象状态进入绑定或失败流程。
		this.moved();
	}

	/**
	 * Woken by the unbound index (out of it already): before the publication, placed now; refused `waiting`, its start
	 * runs again, announced with `loading` (then `bound` or `failed`).
	 */
	// 索引唤醒：unplaced 说明主机刚发布，立即启动；refused 说明可以再次尝试。
	wake(): void {
		// 读取状态。
		const state = this.#state;
		// 发布前保存的请求：转为 pending 后重新开始。
		if (state.kind === "unplaced") {
			this.#state = PENDING;
			this.start(state.request);
		} else if (state.kind === "refused") {
			// 等待型拒绝：先发 loading，再重新启动。
			this.#restart(state.request);
		}
	}

	/**
	 * The object's state changed, or the hold took it: a pending hold binds once it is live (when a slot is free),
	 * sends each failure, and announces the attempt after a failure with `loading`. A bound hold (or one whose `bound`
	 * waits for a slot) whose object leaves `live` goes back to pending (slice 7b §6), except while a reload's swap runs
	 * in place; a bound one whose object went live with another attempt (a swap) gets a fresh `bound` (audit A9).
	 */
	// 对象状态变化或刚被持有：根据对象 live/failed/loading 迁移 hold 状态。
	moved(): void {
		// 当前状态。
		const current = this.#state;
		// 没有对象时无事可做。
		const object = this.#object;
		if (object === undefined) return;
		// 已绑定或等待绑定：检查对象是否仍 live。
		if (current.kind === "bound" || current.kind === "binding") {
			// 读取对象状态 kind。
			const { kind } = object.state;
			// 仍 live：bound 且实例不同则重新绑定；binding 则继续等名额。
			if (kind === "live") {
				// 原地换实例：用新实例成员重新发送 bound。
				if (current.kind === "bound" && object.instance !== current.instance) this.#rebind(current);
				return;
			}
			// Its instance still changes (a swap's old one, a restart's drain, a live failure's admitted commits): it follows
			// it on until it stopped (slice 7b, decision "References are the only indirection").
			// 旧实例仍在收尾：bound 状态继续跟随旧实例，直到 attachable 不再指向它。
			if (current.kind === "bound" && object.attachable === current.instance) return;
			// binding 且对象进入 loading 并承诺原地换实例：保持 binding，等新实例。
			if (current.kind === "binding" && kind === "loading" && object.swapsInPlace) return;
			// 其他情况解除绑定；failed 时把失败原因传下去。
			this.#unbind(object.state.kind === "failed" ? object.state.cause.error : undefined);
		}
		// 继续按 pending 流程处理（可能刚被 #unbind 设为 pending）。
		this.#pending(object);
	}

	/** Member `followed` failed with `error`: its failure waits to be sent, replacing one still waiting. */
	// 记录成员失败：先丢弃该成员待发操作，再替换同成员尚未发送的失败。
	#memberFailed(followed: Followed, error: unknown): void {
		// 失败后旧操作已无意义，从 pending 队列取走丢弃。
		followed.pending.take();
		// 组装线上失败条目，错误先转成网络信封。
		const failure = { member: followed.index, error: wireError(error) };
		// 查找同成员已有失败。
		const at = this.#failed.findIndex(({ member }) => member === followed.index);
		// A new list when one is replaced (rare): a list handed to an entry is never written to.
		// 没有则追加；有则整体替换成新数组，避免修改已交给 StateEntry 的数组。
		if (at === -1) this.#failed.push(failure);
		else this.#failed = this.#failed.map((pending, i) => (i === at ? failure : pending));
	}

	/** Member `index` has a value again: a failure of it still waiting to be sent (rare) is not sent. */
	// 成员恢复：移除尚未发送的失败，避免先报错再报好值。
	#memberHealed(index: number): void {
		// 只有存在失败时才过滤，减少分配。
		if (this.#failed.length > 0) this.#failed = this.#failed.filter(({ member }) => member !== index);
	}

	/**
	 * Its object left `live` (a restart, a parked swap, a live failure): no longer subscribed or waiting for a slot, its
	 * calls in flight rejected (`error`, or `unavailable`), pending again; a `loading` tells the consumer it rebinds
	 * (a failure is sent by `#pending`, which a consumer applies to a bound hold as a rebinding too, model §5).
	 */
	// 解除绑定：退订成员、清空待发数据、拒绝在途调用并回到 pending。
	#unbind(error: ChordError | undefined): void {
		// 读取当前状态。
		const state = this.#state;
		// 已绑定时先退订所有成员源。
		if (state.kind === "bound") unfollow(state);
		// 丢弃本批次变化与待发失败/退役。
		this.#changes = [];
		this.#failed = [];
		this.#retired = NO_RETIRED;
		this.#touched = false;
		// 没有具体失败时用 unavailable 说明只是重新绑定。
		const reason = error ?? new ChordError({ code: "unavailable", message: `hold ${this.id}: its object rebinds` });
		// 提供端结束该 hold 的调用并清理窗口登记。
		this.#provider.unbound(this, reason);
		// 回到 pending，等对象再次 live。
		this.#state = PENDING;
		// 非失败原因的重新绑定告诉消费端 loading；失败原因由后续 failed 消息表达。
		if (error === undefined) this.#provider.send({ kind: "loading", hold: this.id });
	}

	/**
	 * A swap of its object went live in place (slice 7b §5, audit A9): no longer subscribed to the old instance, it gets
	 * a fresh `bound` of the new one's members (as a restart, a variant or a version change does), answering calls by
	 * its old names until that is sent.
	 */
	// 原地换实例：退订旧实例，保留旧名字应答调用，并排队发送新实例的 bound。
	#rebind(state: Bound): void {
		// 停止跟随旧实例成员。
		unfollow(state);
		// Its ops still waiting for a slot are the old instance's: the `bound` replaces them.
		// 旧实例待发操作作废，同时从窗口等待集合移除。
		this.#provider.unbind(this);
		// 记录旧 variant/names，bound 发送前仍按旧名字应答。
		this.#state = { kind: "binding", previous: { variant: state.variant, names: state.names } };
		// 请求提供端发送新的 bound（或排队等名额）。
		this.#provider.bind(this, this.#provider.link.context);
	}

	/**
	 * A `retry` message with `hops` left of its budget: the object is asked for an attempt now (it ignores this unless
	 * failed; parked, it passes it on, to other hosts with one hop less); a refused hold is started again (a route's
	 * `authorize` may admit it now).
	 */
	// 处理 retry：未拒绝时把重试传给对象，并把跳数减一（跨过一条连接）；已拒绝则重新启动。
	retry({ hops }: Extract<Message, { readonly kind: "retry" }>): void {
		// 读取状态。
		const state = this.#state;
		// 未拒绝：对象自行决定是否重试，跳数预算是跨主机限制。
		if (state.kind !== "refused") {
			// 本主机已消耗一跳，传 retryWalk(hops - 1) 给对象依赖链。
			this.#object?.retry(retryWalk(hops - 1));
			return;
		}
		// 等待型拒绝还登记在索引里：先移除，重启后会重新登记。
		if (state.cause.kind === "waiting") this.#provider.link.host.unindex(state.request.type, this);
		// 重新走 start 流程。
		this.#restart(state.request);
	}

	/** The pending hold's part of `moved`: binds once live, sends each failure, announces the next attempt. */
	// pending 阶段的对象状态迁移：live 就排队绑定，failed 就发送失败，失败后的 loading 发送 loading。
	#pending(object: ChordObject): void {
		// 只有 pending 状态需要处理。
		const current = this.#state;
		if (current.kind !== "pending") return;
		// 读取对象状态。
		const state = object.state;
		// live：进入 binding，等待窗口名额发送 bound。
		if (state.kind === "live") {
			this.#state = BINDING;
			this.#provider.bind(this, this.#provider.link.context);
		} else if (state.kind === "failed") {
			// Each failure and each new cause (a parked object's blocker changed) is a message of its own.
			// 每次失败原因变化都单独发送；retryAt 为 undefined 时不带 retryIn。
			const { cause, retryAt } = state;
			// 剩余退避毫秒数，不发送负数；{} 用于条件展开。
			const retryIn = retryAt === undefined ? {} : { retryIn: Math.max(0, retryAt - Date.now()) };
			// 线上失败原因只带 kind 与错误信封。
			const failed = { kind: cause.kind, error: wireError(cause.error) };
			// 发送 failed 消息；...retryIn 在有值时加入字段。
			this.#provider.send({ kind: "failed", hold: this.id, cause: failed, ...retryIn });
			// 记住已告诉消费端失败，下一次尝试需要先发 loading。
			this.#state = { kind: "pending", toldFailed: true };
		} else if (state.kind === "loading" && current.toldFailed) {
			// 失败后对象开始新尝试：发 loading 清除消费端失败态。
			this.#provider.send({ kind: "loading", hold: this.id });
			// 重置 toldFailed。
			this.#state = PENDING;
		}
	}

	/** Starts a refused hold again, announced with `loading`. */
	// 重启被拒绝的 hold：先发 loading，再重新执行 start。
	#restart(request: HoldRequest): void {
		// 回到 pending。
		this.#state = PENDING;
		// 告知消费端新一轮尝试开始。
		this.#provider.send({ kind: "loading", hold: this.id });
		// 重新放置与取对象。
		this.start(request);
	}

	/** Calls a method of the held object as the hold's caller. */
	// 以 hold 的调用者身份调用对象方法；参数版本用消费端请求的版本，便于适配旧版本。
	call(method: string, args: unknown, context: Context): Promise<unknown> {
		// 对象在可调用状态下必然存在，! 断言内部约定。
		return this.#object!.call(method, args, context, this.caller, this.contract.version);
	}

	/**
	 * The method at `index` of the bound variant and whether its result carries byte segments (its schema has a
	 * `bytes()` leaf). Throws on an index outside the variant (a protocol error); a hold that is not bound has none.
	 */
	// 把线上方法索引换成方法名，并返回结果是否含字节段；越界索引是协议错误。
	method(index: number): { readonly name: string; readonly resultBytes: boolean } {
		// 读取状态。
		const state = this.#state;
		// Binding afresh after a swap: by the names the consumer still has (the new instance answers by name).
		// bound 用当前 names；binding 且 previous 存在时仍用旧 names，因为消费端还按旧索引发调用。
		const bound = state.kind === "bound" ? state : state.kind === "binding" ? state.previous : undefined;
		// 索引换成方法名。
		const name = bound?.names.methods[index];
		// 名字不存在：越界或未绑定，抛协议错误。
		if (name === undefined) throw new Error(`hold ${this.id}: no method ${index}`);
		// 从 variant 方法表取结果 schema 的 bytes 标志；! 表示名字来自同一张表。
		return { name, resultBytes: bound!.variant.methods.get(name)!.result.bytes };
	}

	/**
	 * The hold's binding, sent when a slot is free. The snapshot of every member, as a value or failed, and the
	 * subscription are taken in this synchronous step (race 2), so each member's next ops continue exactly from it.
	 * Names travel as indexes into the bound version (2b). Counts one encode (`chord.link.encodes`).
	 */
	// 生成 bound 条目：逐个成员取当前值、打包分片并订阅后续变化；取值与订阅在同一同步步骤完成。
	boundEntry(context: Context): BoundEntry {
		// 对象必然存在（只有 live 才会调用）。
		const object = this.#object!;
		// 对象自身服务的合约信息，用于比较版本。
		const { contract } = object.served;
		// 对象当前 variant；live 对象必有。
		// A live remote object has its variant.
		const variant = object.variant!;
		// 建立绑定状态并取得该 hold 版本下的 variant 数据。
		const state = this.#bindTo(object);
		// 收集成功成员的快照。
		const members: BoundEntry["members"][number][] = [];
		// 收集失败成员。
		const failed: FailedMember[] = [];
		// 消费端请求的合约版本。
		const { version } = this.contract;
		// 版本相同可直接读当前成员；不同则走对象提供的适配成员。
		const current = version === contract.version;
		// 按线上索引顺序遍历成员名。
		for (const [index, member] of state.names.state.entries()) {
			// An older version's members are its instance's mapping (its refusals unbound it before: `ChordObject`).
			// 旧版本成员通过 liveMember 适配；当前版本直接读 stateMembers。
			const source = current ? object.stateMembers.get(member)! : object.liveMember(member, version);
			// 声明值，稍后读取。
			let value: JsonValue;
			try {
				// 读取成员当前值；失败的 derive 会在这里抛错。
				value = source.value;
			} catch (error) {
				// A failed member (a derive whose compute throws) is followed: it recovers with a root replacement.
				// 失败成员记为 failed 条目，但仍订阅以便恢复；只有 Source 可订阅。
				failed.push({ member: index, error: wireError(error) });
				if (source instanceof Source) this.#follow(state, index, source);
				continue;
			}
			try {
				// 值序列化成 JSON 分片；link.part 可能压缩。
				members.push({ member: index, value: this.#provider.link.part(jsonPart(value), context) });
			} catch (error) {
				// A value past the link's limits: failed for this hold, which takes no more of it.
				// 超限值记为失败，不订阅：该 hold 无法接收这个成员。
				failed.push({ member: index, error: wireError(error) });
				continue;
			}
			// A constant never changes: nothing to follow.
			// 常量没有订阅价值，只有 Source 才跟随。
			if (source instanceof Source) this.#follow(state, index, source);
		}
		// 快照已包含当前值，清空本批次变化与待发失败/退役。
		this.#changes = [];
		this.#failed = [];
		this.#retired = NO_RETIRED;
		// 计数一次编码，供成本观测。
		context.telemetry.metrics?.counter("chord.link.encodes").add(1);
		// variant 转成排序后的线上索引。
		return { hold: this.id, variant: variantOrder(contract).indexOf(variant), members, failed };
	}

	/**
	 * This batch's entry of the `state` message: the members it changed with their ops, each encoded once with its
	 * member's encoder, and the members that failed; resets both. Counts one encode per hold (`chord.link.encodes`).
	 */
	// 生成 window 名额空闲时的 state 条目：把本批次各成员操作编码成分片。
	entry(context: Context): StateEntry {
		// 取连接。
		const { link } = this.#provider;
		// take 清空本批次变化；每条记录编码一次。
		const members = this.#take().map(([{ index, encoder }, ops]) => ({
			// 成员索引。
			member: index,
			// 操作数组转 JSON 再打包成分片。
			ops: link.part(jsonPart(encoder.encode(ops)), context),
		}));
		// 附带失败与退役信息。
		return this.#entry(members, context);
	}

	/** The window is full: this batch's ops join the members' pending queues (raw, never mutated). */
	// 窗口满：本批次操作原样加入各成员的 pending 队列，等名额释放后再编码。
	queue(): void {
		// 每条变化只把 ops 追加到对应成员队列。
		for (const [{ pending }, ops] of this.#take()) pending.push(ops);
	}

	/**
	 * The entry of a freed slot's `state` message: each member's pending ops encoded once, or `[["r", value]]` after an
	 * overflow, all reflecting the latest commit; and the members that failed meanwhile. Counts one encode per hold.
	 */
	// 名额释放后生成 state 条目：取出每个成员累积的操作编码一次；溢出时改为根替换。
	pendingEntry(context: Context): StateEntry {
		// 取连接。
		const { link } = this.#provider;
		// 收集成员条目。
		const members: StateEntry["members"][number][] = [];
		// Only a bound hold has pending ops.
		// 只有 bound 状态的 hold 会进入等待集合；as Bound 是已决定不变量的断言。
		for (const { index, source, encoder, pending } of (this.#state as Bound).followed) {
			// 没有待发操作就跳过。
			if (pending.size === 0) continue;
			// 取走累积结果：replace 表示队列溢出，需要发完整值。
			const taken = pending.take();
			// 根替换用当前最新值；否则把操作拼成数组。as const 保留元组字面量类型。
			const ops = taken.kind === "replace" ? [["r", source.value] as const] : taken.ops;
			// 空操作不发送（可能整批被后续更新抵消）。
			if (ops.length > 0) members.push({ member: index, ops: link.part(jsonPart(encoder.encode(ops)), context) });
		}
		// 附带失败与退役信息。
		return this.#entry(members, context);
	}

	/** The consumer released the hold, or its link closed: its waits stop and its object loses this reference. */
	// 消费端释放：退出所有等待，并通知对象不再被该持有引用。
	release(): void {
		// 先从提供端与索引中移除。
		this.drop();
		// 对象解除该持有者；对象可能已经结束，故用可选调用。
		this.#object?.unhold(this);
		// 清空对象引用。
		this.#object = undefined;
	}

	/** Ends the hold without releasing its object (the host closes and ends its objects itself). */
	// 结束 hold 但不通知对象（主机关闭时会自行结束对象）；只做本地清理与计数。
	drop(): void {
		// 读取状态。
		const state = this.#state;
		// 取主机，用于索引与计数。
		const { host } = this.#provider.link;
		// 已绑定：退订成员。
		if (state.kind === "bound") {
			unfollow(state);
		} else if (state.kind === "unplaced" || (state.kind === "refused" && state.cause.kind === "waiting")) {
			// 仍在未绑定索引中的状态需要移除登记。
			host.unindex(state.request.type, this);
		}
		// 标记已释放，后续消息忽略。
		this.#state = { kind: "released" };
		// 引用计数只减一次。
		if (this.#counted) host.count("references", -1);
		this.#counted = false;
	}

	/**
	 * The object ended while held (revocation; a reload, slice 7b), or the hold was revoked (or its host closed) while it
	 * held no object: the hold sends `gone` with `error`.
	 */
	// 结束并通知消费端 gone：先让提供端遗忘调用，再本地清理并发送原因。
	end(error: ChordError): void {
		// 已释放不再重复发送。
		if (this.#state.kind === "released") return;
		// 提供端删除本 hold 并结束相关调用。
		this.#provider.forget(this, error);
		// 本地清理。
		this.drop();
		// 清空对象引用。
		this.#object = undefined;
		// 发送 gone，错误转成网络信封。
		this.#provider.send({ kind: "gone", hold: this.id, error: wireError(error) });
	}

	/** The binding: its variant and names at the hold's version, with no member followed yet. */
	// 建立 bound 状态：按 hold 请求的版本取 variant 数据与名字顺序，成员列表先为空。
	#bindTo(object: ChordObject): Bound {
		// variantsAt 取历史版本中的 variant；对象 variant 必然存在。
		const variant = variantsAt(object.served.contract, this.contract.version).get(object.variant!)!;
		// 构造保留实例身份的状态对象。
		const state: Bound = {
			kind: "bound",
			variant,
			names: variantNames(variant),
			followed: [],
			instance: object.instance,
		};
		// 写入当前状态。
		this.#state = state;
		// 返回给调用者填充成员。
		return state;
	}

	/** A hold over a link follows its object's instances in `moved` (a fresh `bound` for a new one). */
	// Holder 接口要求的方法；远端 hold 不参与引用重定向，实例变化由 moved 处理。
	retarget(): void {}

	/** It moves nothing in `retarget`. */
	// 与 retarget 配套的常量标记。
	readonly following = false;

	/**
	 * Its object left it (slice 7b §6): its type was removed (`not_served`) or its provider no longer binds the hold's
	 * version (`version`): no longer subscribed, its calls in flight rejected, it waits refused with `removal.cause` in
	 * the host's index (a publication starts it again) and the consumer is sent `failed`, which unbinds a bound hold.
	 */
	// 对象被移除或不再绑定该版本：停止跟随、拒绝在途调用，并转为 refused 等待重新发布。
	removed(removal: Removal): void {
		// 读取状态。
		const state = this.#state;
		// 已释放或没有对象时结束。
		if (state.kind === "released" || this.#object === undefined) return;
		// 已绑定则退订成员。
		if (state.kind === "bound") unfollow(state);
		// 丢弃本批次数据。
		this.#changes = [];
		this.#failed = [];
		this.#retired = NO_RETIRED;
		this.#touched = false;
		// 提供端结束调用并清理窗口。
		this.#provider.unbound(this, removal.cause.error);
		// 清空对象。
		this.#object = undefined;
		// 用移除原因拒绝，等待索引重新启动。
		this.#refuse(this.contract, removal.cause);
	}

	/**
	 * Follows member `index` from its snapshot on (a failed one too: it may recover in this hold): its own encoder and
	 * pending queue, and a subscription feeding its calls into this hold's batch. Failures fold per member: a failure
	 * drops what was pending for it and replaces a failure not sent yet (one at most per member, however long the
	 * consumer stalls); the value after it (a root replacement) replaces the failure. A retirement waits for a value.
	 */
	// 订阅一个成员：每次变化把操作/失败/退役折叠进本 hold 的批次数据。
	#follow(state: Bound, index: number, source: DeriveSource): void {
		// 成员记录；subscriber 的回调通过闭包引用 followed 自身。
		const followed: Followed = {
			index,
			source,
			subscriber: {
				advance: (call) => {
					// 本批次第一次变化时向提供端登记，触发 flush。
					this.#touch();
					// 失败调用单独折叠。
					if (call.kind === "failed") {
						this.#memberFailed(followed, call.error);
						return;
					}
					// 有值则清除该成员待发失败。
					this.#memberHealed(index);
					// 解构出操作与退役标志。
					const { ops, retired } = call;
					// A retired derive's frame may carry no ops (rule 21): only the flag travels.
					// 空操作也要保留退役标志，因此只在 ops 非空时记录变化。
					if (ops.length > 0) this.#changes.push([followed, ops]);
					// A new list per retirement (rare): the shared empty one is never written to.
					// 退役索引去重后生成新数组，不修改共享的 NO_RETIRED。
					if (retired && !this.#retired.includes(index)) this.#retired = [...this.#retired, index];
				},
				// The member's source ended with its object, which ends this hold.
				// 源结束由对象结束流程统一处理，这里无需动作。
				end: () => {},
				endAfterDelivery: () => {},
			},
			encoder: encoder(),
			pending: new PendingOps(),
		};
		// A constant never changes: nothing to subscribe to.
		// 常量没有变化事件；Source 才订阅。
		if (source instanceof Source) source.subscribe(followed.subscriber);
		// 记录到绑定状态，pendingEntry 会遍历它。
		state.followed.push(followed);
	}

	/** Takes the current batch's changes; the hold is untouched again. */
	// 取出并清空本批次变化；同时复位 touched，下一批次可重新登记。
	#take(): (readonly [Followed, readonly Op[]])[] {
		// 保留旧数组引用。
		const changes = this.#changes;
		// 换新数组。
		this.#changes = [];
		// 复位批次标记。
		this.#touched = false;
		// 返回旧数组。
		return changes;
	}

	/** A state entry with `members` and the failures and retirements since the last one; counts one encode. */
	// 组装 state 条目：附带未发送的失败与退役；失败成员的退役延后到下一次值。
	#entry(members: StateEntry["members"], context: Context): StateEntry {
		// 取待发失败与退役，并立即清空。
		const failed = this.#failed;
		let retired = this.#retired;
		this.#failed = [];
		this.#retired = NO_RETIRED;
		// 同时有失败和退役时需要拆分。
		if (retired.length > 0 && failed.length > 0) {
			// A failed member's retirement travels with its next value, never with its failure.
			// 失败成员的退役留在本 hold，等下一次值（根替换）一起发送。
			const kept = retired.filter((index) => failed.some(({ member }) => member === index));
			if (kept.length > 0) {
				// 保存到下一次条目。
				this.#retired = kept;
				// 从本次退役列表移除。
				retired = retired.filter((index) => !kept.includes(index));
			}
		}
		// 计数一次编码。
		context.telemetry.metrics?.counter("chord.link.encodes").add(1);
		// 返回完整条目。
		return { hold: this.id, members, failed, retired };
	}

	// 标记本批次已接触本 hold；只登记一次。
	#touch(): void {
		// 已登记则直接返回。
		if (this.#touched) return;
		// 记录标记。
		this.#touched = true;
		// 让提供端安排批次 flush。
		this.#provider.touched(this);
	}

	/**
	 * Refuses the hold with `cause`, holding nothing: it keeps `request`, indexed under its type while `waiting` (a
	 * publication starts it again), for a `retry` otherwise.
	 */
	// 拒绝 hold：保存请求副本与原因；waiting 登记索引，broken 等 retry；并发送 failed。
	#refuse(request: HoldRequest, cause: FailureCause): void {
		// 保存状态；owned 复制 params。
		this.#state = { kind: "refused", request: owned(request), cause };
		// waiting 需要发布时再次尝试。
		if (cause.kind === "waiting") this.#provider.link.host.index(request.type, this, cause);
		// 告诉消费端失败；cause 只带 kind 与错误信封。
		this.#provider.send({
			kind: "failed",
			hold: this.id,
			cause: { kind: cause.kind, error: wireError(cause.error) },
		});
	}
}

/** Stops following every member of a bound hold. */
// 退订 bound 状态中的所有成员源；常量没有订阅，用 instanceof 排除。
function unfollow(state: Bound): void {
	// 逐个成员退订。
	for (const { source, subscriber } of state.followed) if (source instanceof Source) source.unsubscribe(subscriber);
}

/** `request` with its params owned, not a view of the message they came in (which the link's buffers may hold). */
// 复制请求中的字节参数，防止长期持有解码缓冲区；字符串本身不可变，直接复用。
function owned(request: HoldRequest): HoldRequest {
	// 取参数。
	const { params } = request;
	// 字符串直接返回原请求；字节视图复制一份独立缓冲。
	return typeof params === "string" ? request : { ...request, params: (params as Uint8Array).slice() };
}

/** A `hold` message's fields naming whom it acts for. */
// Pick 只取 principal 和 incarnation 两个字段。
type ActingFor = Pick<HoldMessage, "principal" | "incarnation">;

// 无身份时的共享空对象。
const NOBODY: ActingFor = {};

/**
 * The fields of a `hold` message naming whom it acts for (`caller`): sent only on a route link, whose child honours
 * them (§4); none elsewhere.
 */
// 只有路由连接且 principal 存在时才发送身份字段；其他连接使用共享空对象。
export function actingFor(link: HostLink, { principal, incarnation }: Caller): ActingFor {
	// 三元表达式返回身份或 NOBODY。
	return link.role === "route" && principal !== undefined ? { principal, incarnation } : NOBODY;
}
