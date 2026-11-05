// 本文件表示消费端的一个远端对象：它跨越路径上的多条连接，保存最近一次绑定的副本、当前的 hold 以及通过该 hold 发出的调用。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的消费端对象实现。
// 职责边界：实现主机的 Target/Holder 接口，管理引用状态、绑定元数据、成员副本与路径迁移；不发送底层消息（委托 ConsumerSide）、不解码 Delta（委托 Replica）、不决定重连（委托 Path）。
// 上游入口：Host.pathOf 创建后由 Path.attach 调用 attach；ConsumerSide 收到 bound/state/failed/loading/gone 后调用对应方法；引用层调用 hold/unhold/call/member/followed/retry。
// 下游依赖：ConsumerSide（hold 与调用）、Replica（成员值）、delta/state（批次与源）、Host（批次、unplaced 路径、错误上报）。
// 结果与错误流向：调用失败以 ChordError 拒绝；绑定超限走 tooLarge 进入 broken；协议不匹配抛普通 Error 由 Channel 关闭连接；结束状态让读取与调用得到 ended/released 错误。
//
// 能力清单：
// - class RemoteObject：state/variant/hydrated/lastFailure 读取状态，attach/dropped/unreachable 管理路径，call/member/followed 提供引用能力，prepareBound/prepare/wentLive 应用消息，retry/tooLarge/revoke/lost 处理恢复与结束，其余 Target 方法声明远端限制。
// - 模块内 Bound 类型：最近一次绑定的 variant、方法表、名字索引与副本表。
//
// 组合关系：Path.attach 发起 hold；ConsumerSide 收到 bound 后 prepareBound 建副本、批次采用、wentLive 转 live；state 消息 prepare 解码操作后 adopt；连接断开 dropped 转 loading，新连接再次 attach。
// 示例：const object = new RemoteObject(host, contract, checked, address, caller, path, undefined); path.attach(object); await object.call("read", {}, ctx);
// 建议阅读顺序：先看 Bound 与字段，再看 attach/call/member/followed，然后 prepareBound/prepare，最后 retry/tooLarge/lost 与 #move。
// An object held over a link (§7): what one remote reference is bound to on the consumer, across the links of its path
// (the parent, or a route address). Its state, the replicas of its last bound variant (kept while its link is down),
// its hold on the path's current link and calls through it.

// 导入上下文、合约与变体工具、错误类型、主机内部引用类型、链路消息类型、Delta 源类型，以及相邻的消费端/中继/连接/路径/副本类型。
import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import {
	currentVariants,
	type MethodData,
	type VariantNames,
	variantNames,
	variantOrder,
} from "../contracts/internal.ts";
import { ChordError } from "../data/index.ts";
import { asChordError, invalid } from "../data/internal.ts";
import {
	type AnyHost,
	type Attachable,
	type Binding,
	type Caller,
	type CheckedParams,
	type ChordObject,
	type Followed,
	LIVE,
	LOADING,
	type PinnedKey,
	type RefState,
	type RetryWalk,
	type Target,
} from "../host/internal.ts";
import type { JsonValue } from "../json.ts";
import {
	type BoundEntry,
	errorFromWire,
	jsonPart,
	type Message,
	parsePart,
	type StateEntry,
	type WireAddress,
} from "../link/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import type { ConsumerSide } from "./consumer.ts";
import type { HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import { type MemberSnapshot, Replica } from "./replica.ts";

/** The last binding: its variant, methods, the bound version's names (the wire's indexes) and a replica per member. */
// 最近一次绑定的快照元数据；连接断开时仍保留，供成员读取最后一次好值与等待下一次绑定。
type Bound = {
	// 绑定的 variant 名。
	readonly variant: string;
	// 方法名到方法数据的映射，调用时按名字查参数 schema。
	readonly methods: ReadonlyMap<string, MethodData>;
	// 该版本 state/method 名按线上索引排序后的数组。
	readonly names: VariantNames;
	// 每个 state 成员一个本地副本。
	readonly replicas: ReadonlyMap<string, Replica>;
};

/**
 * One remote reference's object, owned by its host across the links of its path. It is `loading` until a link's hold
 * of it is bound, and again whenever that link drops or its relay's upstream starts over; each link holds it with its
 * own id. Two references are two holds, each member of each with its own Delta decoder.
 */
// 实现主机的 Target 接口，因此本地引用可以像跟随本地对象一样跟随它；状态与副本都由远端消息驱动。
export class RemoteObject implements Target {
	// 对象类型标签，本地对象实现同一接口时也有各自的值。
	readonly kind = "remote";
	/** The object in errors: its type, and its params key when it has params. */
	// 错误信息中的可读标签，例如 "Editor" 或 "Document(doc-7)"。
	readonly label: string;
	// 合约句柄，提供类型名、版本、指纹与成员定义。
	readonly contract: Contract;
	// 拥有该对象的主机，用于批次、路径查找和上报。
	readonly #host: AnyHost;
	/** What its holds ask for: the params as a part (checked by L1 when the reference was made), the address. */
	// hold 消息的公共部分：类型、版本、指纹、参数分片与地址；参数已由 L1 检查。
	readonly request: HoldRequest;
	/** Whom its reference acts for: named on route links (`actingFor`). */
	// 引用代表谁：在路由连接上会把这些身份字段发给上游。
	readonly caller: Caller;
	/** Its params, for placing it anew (`retry` after a part past the limits). */
	// 保留参数原值，超限后重新放置时需要再次计算路径。
	readonly #params: ParamsOf<Contract>;
	/** Its path: the parent's or a route address's; the host's `unplaced` one after a part past the limits. */
	// 当前路径；超限后会换到主机的 unplaced 路径，直到 retry 重新放置。
	#path: Path;
	/** The object whose activation declared the reference (`self.get`): its holds carry its chain while it activates. */
	// 触发该引用的本地对象；它的激活链会随 hold 发送，用于跨主机防止挂起环。
	#dependent: ChordObject | undefined;
	// 引用的可观察状态：loading、live、failed 或 ended。
	#state: RefState = LOADING;
	/** The last binding, kept while loading or failed: members keep their last values and watches. */
	// 最近一次绑定；loading/failed 期间保留，成员仍能读到旧值。
	#bound: Bound | undefined;
	/** The hold on the path's link while one is open: that link's consumer side and this hold's id on it. */
	// 当前连接上的 hold；连接断开后为 undefined，等路径的下一条连接。
	#hold: { readonly side: ConsumerSide; readonly id: number } | undefined;
	// 主机的引用绑定记录；状态变化时通过它通知引用并重定向跟随者。
	#binding: Binding | undefined;
	// 最近一次失败原因，直到再次 live。
	#lastFailure: ChordError | undefined;

	// 创建远端对象：输入主机、合约、已检查参数与键、地址、调用者和路径，以及可选的依赖对象。
	// 构造只登记元数据，不发消息；attach 由路径在连接可用时调用。
	// 例：host.get(Editor, params) 解析到远端提供者后构造该对象，随后 path.attach 发出 hold。
	constructor(
		host: AnyHost,
		contract: Contract,
		{ params, key }: CheckedParams,
		address: WireAddress,
		caller: Caller,
		path: Path,
		dependent: ChordObject | undefined,
	) {
		// 保存主机。
		this.#host = host;
		// 保存合约句柄。
		this.contract = contract;
		// 有键时把键放进标签，便于日志与错误定位；模板字符串本身保持原样。
		this.label = key === "" ? contract.name : `${contract.name}(${key})`;
		// 从合约句柄解构线上标识字段。
		const { name: type, version, fingerprint } = contract;
		// 组装 hold 请求；jsonPart 把参数序列化成 JSON 分片（参数只允许 JSON）。
		this.request = {
			type,
			version,
			fingerprint,
			params: jsonPart(params),
			address,
		};
		// 保存调用者身份。
		this.caller = caller;
		// 保存参数原值，供重新放置使用。
		this.#params = params;
		// 保存初始路径。
		this.#path = path;
		// 保存依赖对象，attach 时读取它的激活链。
		this.#dependent = dependent;
	}

	// 读取引用状态；返回共享的 LOADING/LIVE 常量或新建的 failed/ended 对象。
	get state(): RefState {
		// 直接返回内部状态。
		return this.#state;
	}

	/** An object over a link is no blocker of this host's first pass. */
	// 远端对象不会阻塞主机的首次启动屏障：它的值来自另一台主机，本地无需等待它完成激活。
	get blocksFirstPass(): false {
		// 返回字面量 false，类型被收窄为 false。
		return false;
	}

	/** The error of the last `failed`, until `bound`. */
	// 读取最近失败原因；绑定成功后 wentLive 会清空。
	get lastFailure(): ChordError | undefined {
		// 直接返回保存的错误。
		return this.#lastFailure;
	}

	/** The variant last bound; `undefined` before the first binding. */
	// 读取最近绑定的 variant 名；首次绑定前为 undefined。
	get variant(): string | undefined {
		// 可选链在未绑定时得到 undefined。
		return this.#bound?.variant;
	}

	/** Whether its state members have values: bound once. */
	// 是否至少绑定过一次；副本可能保留旧值，但仍算 hydrated。
	get hydrated(): boolean {
		// 有 bound 即表示快照已到。
		return this.#bound !== undefined;
	}

	/** Its one reference bound to it. */
	// 记录引用绑定；由主机的引用层在绑定到该对象时调用。
	hold(binding: Binding): void {
		// 保存绑定，状态变化时用它通知引用。
		this.#binding = binding;
	}

	/** The reference was released: the current link's provider is told and the reference's sent calls rejected. */
	// 引用被释放：通知提供端释放该 hold，并结束本地对象。
	unhold(_binding: Binding): void {
		// 构造 released 错误，供调用方与副本读取时抛出。
		const error = new ChordError({ code: "released", message: `${this.label}: released` });
		// 若仍有连接，向提供端发送 release；释放规则由提供端执行。
		this.#hold?.side.release(this.#hold.id, error);
		// 结束对象：清理状态、副本与路径登记。
		this.#end(error);
	}

	/**
	 * Holds on `link`, the path's link now (a first hold, or a re-hold on a new link), with the activation chain of its
	 * dependent while that activates (Q5).
	 */
	// 在路径的当前连接上发起 hold：读取私有编号并登记回 #hold。
	attach(link: HostLink): void {
		// 依赖对象若仍在激活，activationChain() 返回链；否则 undefined。
		const chain = this.#dependent?.activationChain();
		// consumer.attach 发送 hold 并返回本连接内的编号。
		this.#hold = { side: link.consumer, id: link.consumer.attach(this, chain) };
	}

	/**
	 * Its path's address cannot be reached for now (a route's `resolve` failed, a suspension): `failed { waiting }` with
	 * `error`, still on the path, bound by its next link.
	 */
	// 路径暂时不可达：记录原因并进入 waiting 失败；对象仍留在路径上，下一次连接可重新绑定。
	unreachable(error: ChordError): void {
		// 保存最近失败原因。
		this.#lastFailure = error;
		// 已结束的对象不再改变状态。
		if (this.#state.kind !== "ended")
			// failed 分支同时带 cause 与 retryAt；waiting 表示可等待恢复，undefined 表示没有自动重试时间。
			this.#move({ kind: "failed", cause: { kind: "waiting", error }, retryAt: undefined });
	}

	/** The link dropped: loading until a new link's hold is bound (`#startOver`). */
	// 连接断开：清空当前 hold，转入 loading；已发送调用由连接关闭流程失败。
	dropped(_error: ChordError): void {
		// 旧连接的 hold 已失效。
		this.#hold = undefined;
		// 进入 loading（若尚未 loading/ended）。
		this.#startOver();
	}

	/**
	 * Calls a method of the bound variant over the link; one outside it fails `invalid/member`. Only a live object is
	 * called: bound on an open link.
	 */
	// 调用远端方法：输入方法名、参数与上下文，返回结果 Promise。
	// 只有 live 对象会被调用，因此这里用 ! 断言 bound 与 hold 一定存在。
	async call(method: string, args: unknown, context: Context): Promise<unknown> {
		// 非空断言说明调用方保证已绑定；未绑定调用属于内部错误。
		const bound = this.#bound!;
		// 同理，live 状态必有当前 hold。
		const hold = this.#hold!;
		// 按名字查方法数据。
		const data = bound.methods.get(method);
		// 方法不在绑定 variant 中：抛出 invalid/member，而不是发送错误索引。
		if (data === undefined) {
			throw invalid("member", `${this.label} (variant ${bound.variant}) has no method "${method}"`);
		}
		// Arguments are checked by the provider.
		// 参数由提供端按自己的版本检查；这里只做序列化。
		// names.methods.indexOf 把方法名换成线上索引，协议用数字标识方法。
		return hold.side.call(hold.id, bound.names.methods.indexOf(method), data, args, context);
	}

	/**
	 * The replica of `member`; `not_ready` before the first binding, `invalid/member` for a member no binding had (one
	 * a later variant lacks reads its `invalid/member` failure).
	 */
	// 返回某个 state 成员的副本：未绑定时 not_ready，成员不存在时 invalid/member。
	member(member: string): DeriveSource {
		// 读取最近绑定。
		const bound = this.#bound;
		// 首次绑定前没有任何副本可读。
		if (bound === undefined) throw new ChordError({ code: "not_ready", message: `${this.label}: not bound yet` });
		// 按成员名查找副本。
		const replica = bound.replicas.get(member);
		// 缺失时报告 invalid/member；新 variant 可能已经移除该成员。
		if (replica === undefined) {
			throw invalid("member", `${this.label} (variant ${bound.variant}) has no state member "${member}"`);
		}
		// 返回副本，它实现 DeriveSource，可被 derive 读取与监听。
		return replica;
	}

	/**
	 * What its reference follows of `member` (a consumer over a link binds at its own version, mapped at the provider):
	 * the replica while live, a member the bound variant lacks (`invalid/member`); while loading or failed nothing, the
	 * replica (kept until the next binding) giving its last value (rule 5).
	 */
	// 告诉引用层当前该跟随什么：live 给实时副本，loading/failed 给上次绑定的副本作为最后值。
	// _version 参数保留给统一接口，但远端对象由提供端做版本映射，这里不使用。
	followed(member: string, _version: number): Followed {
		// 读取绑定和副本。
		const bound = this.#bound;
		const replica = bound?.replicas.get(member);
		// 读取当前状态用于分支。
		const state = this.#state;
		// live：副本就是实时源。
		if (state.kind === "live") {
			// 副本存在则返回 live；instance 用整个绑定对象，后续变更通过它辨别。
			if (replica !== undefined) return { kind: "live", source: replica, instance: bound };
			// live 但成员缺失：返回 lacking，引用读取时抛出 invalid/member。
			const message = `${this.label} (variant ${bound?.variant}) has no state member "${member}"`;
			return { kind: "lacking", error: invalid("member", message) };
		}
		// failed：引用收到一次失败通知，同时可读取最后好值。
		if (state.kind === "failed") return { kind: "failed", error: state.cause.error, last: replica, instance: bound };
		// loading：不发送失败，只提供最后值；下一个绑定的快照会继续更新。
		return { kind: "loading", last: replica, instance: bound };
	}

	/** Its binding while live (its replicas change); `undefined` while loading or failed. */
	// 只有 live 时暴露绑定元数据，供引用层比较实例是否变化。
	get attachable(): Attachable | undefined {
		// 三元表达式按状态选择。
		return this.#state.kind === "live" ? this.#bound : undefined;
	}

	/** Keyed members are only in local contracts: no instance to pin a key on. */
	// keyed 成员只存在于本地合约，远端对象没有可钉键的本地实例。
	get instance(): undefined {
		// 统一接口要求该字段，这里恒为 undefined。
		return undefined;
	}

	/** Keyed members are only in local contracts (`keyedMember`). */
	// 与 instance 相同：远端对象不支持 keyed 成员。
	keyedMapping(member: string): never {
		// 统一抛错。
		return this.keyedMember(member);
	}

	/** Keyed members are only in local contracts (`keyedMember`). */
	// pinKey 同样拒绝；never 返回类型表示它永不正常返回。
	async pinKey(member: string): Promise<PinnedKey> {
		// 转交同一个错误构造。
		return this.keyedMember(member);
	}

	/** Keyed members are only in local contracts, whose objects are never held over a link (slice 6a §12). */
	// 构造 invalid/member 错误，说明 keyed 成员只能在本地合约中使用。
	keyedMember(member: string): never {
		// 抛出并结束函数；调用方拿不到返回值。
		throw invalid("member", `${this.label} has no keyed member "${member}": keyed members are local`);
	}

	/** An object over a link activates on another host: it is in no chain here (Q5). */
	// 远端对象在另一台主机激活，本主机没有它的激活实例编号。
	get activationId(): undefined {
		// 恒为 undefined。
		return undefined;
	}

	/** An object over a link waits for nothing on this host: no chain of waits (its holds carry the chain, Q5). */
	// 远端对象在本主机没有依赖等待链；等待关系通过 hold 携带的链在上游表达。
	pathTo(): undefined {
		// 恒为 undefined。
		return undefined;
	}

	/**
	 * `ref.retry()`, as a step of `walk`: a failed object's provider is asked for an attempt with the walk's hop budget,
	 * none left: nothing is sent (a hold it refused is started there again; a parked object there passes it on with one
	 * hop less). One that failed for a part past the link's limits is placed anew and held with a new id, now or on its
	 * path's next link (a `hostAddress` that throws fails it broken again).
	 */
	// 重试一个失败的远端对象：调用方走 RetryWalk，hops 是剩余跨主机跳数。
	retry(walk: RetryWalk): void {
		// 只有 failed 状态可以重试；loading/live/ended 无需行动。
		if (this.#state.kind !== "failed") return;
		// 超限后对象被放到主机的 unplaced 路径：先在本地重新计算路径并放置。
		if (this.#path === this.#host.unplaced) {
			this.#place();
			return;
		}
		// 仍有跳数预算时请提供端重试；0 表示不再发送，避免主机环无限转发。
		if (walk.hops > 0) this.#hold?.side.retry(this.#hold.id, walk.hops);
	}

	/** Places a reference whose part was past the limits anew, on its path now (a throwing `hostAddress` fails it). */
	// 重新计算路径：hostAddress 可能抛错，此时对象以 broken 失败。
	#place(): void {
		// 声明路径变量，供 try 成功后使用。
		let path: Path;
		try {
			// 按合约、参数与调用者身份重新解析路径。
			path = this.#host.pathOf(this.contract, this.#params, this.caller.principal);
		} catch (error) {
			// 解析失败：把任意错误规整成 ChordError 并永久失败。
			this.#fail(asChordError(error, this.contract.name));
			// 解析失败后不再继续。
			return;
		}
		// 从旧路径（unplaced）移除。
		this.#path.detach(this);
		// 切换到新路径。
		this.#path = path;
		// 回到 loading，等待新路径的 hold 绑定。
		this.#move(LOADING);
		// 加入新路径；若已有连接会立即 attach。
		path.attach(this);
	}

	/**
	 * A part of its snapshot or of a state change was past the link's limits (`too_large/part`): the hold is released
	 * at the provider, and the reference fails broken with `error`, final: no link holds it again (a reconnect
	 * included) until `retry`.
	 */
	// 分片超限：若有 hold，先释放提供端 hold；再把对象移到 unplaced 路径并永久失败，等待显式 retry。
	tooLarge(error: ChordError): void {
		// 没有 hold 时无事可做（可能已断开）。
		const hold = this.#hold;
		if (hold === undefined) return;
		// 先清空本地 hold，避免 release 回调重入。
		this.#hold = undefined;
		// 通知提供端释放；错误随 release 发送。
		hold.side.release(hold.id, error);
		// 从当前路径移除，重连也不会自动重新持有。
		this.#path.detach(this);
		// 换到主机的 unplaced 路径，使 retry 能找到它。
		this.#path = this.#host.unplaced;
		// 在 unplaced 路径登记。
		this.#path.attach(this);
		// 以 broken 失败：不会自动重试。
		this.#fail(error);
	}

	/** Fails broken with `error`: no automatic retry. */
	// 把对象置为 broken 失败；broken 表示需要人工/显式 retry，而不是等待恢复。
	#fail(error: ChordError): void {
		// 记录失败原因。
		this.#lastFailure = error;
		// 移动到 failed 状态；retryAt 为 undefined 表示没有退避计时。
		this.#move({ kind: "failed", cause: { kind: "broken", error }, retryAt: undefined });
	}

	/**
	 * Prepares one entry of a `bound` message (a first binding, a re-hold; a live hold is bound again): the
	 * variant and every state member once, as a value or as failed. Returns what applies it inside the batch of the
	 * whole message: a member it had gets the snapshot as one frame `[["r", value]]` and a fresh decoder, a member
	 * outside the new variant fails (its replica stays, for a later binding that has it again), a new one gets its first
	 * value. Throws on a snapshot that
	 * does not fit (a protocol error), and `too_large/part` for a value past the link's limits, before anything changed.
	 * `wentLive` follows the batch.
	 */
	// 准备一条 bound 条目：解析 variant、快照值或失败，返回批次内应用的闭包；本函数不改变可观察状态。
	prepareBound(entry: BoundEntry, link: HostLink): () => void {
		// 线上用数字索引标识 variant；variantOrder 给出排序后的变体名数组。
		const variant = variantOrder(this.contract)[entry.variant];
		// 未知索引是协议错误：对端发了本合约没有的 variant。
		if (variant === undefined) throw new Error(`hold ${entry.hold}: no variant ${entry.variant}`);
		// 取当前版本中该变体的数据；! 表示上面的 variant 名来自同一张表，必然存在。
		const data = currentVariants(this.contract).get(variant)!;
		// 计算该 variant 的 state/method 索引顺序。
		const names = variantNames(data);
		// 收集成员名到快照的映射，同时检测重复与缺失。
		const members = new Map<string, MemberSnapshot>();
		// 局部辅助函数：按索引登记一个成员快照。
		const add = (index: number, state: MemberSnapshot): void => {
			// 把索引换成成员名。
			const member = names.state[index];
			// 名字不存在或重复都是协议错误。
			if (member === undefined || members.has(member))
				throw new Error(`hold ${entry.hold}: member ${index} in bound`);
			// 登记快照。
			members.set(member, state);
		};
		// Fresh JSON from the link: state is JSON and never validated (§30).
		// 快照值来自网络：打开分片后 parsePart 解析 JSON，再断言为 JsonValue；状态内容不再做 schema 校验。
		for (const { member, value } of entry.members) {
			// openPart 负责上限与压缩检查，parsePart 负责 JSON 解析。
			add(member, { kind: "value", value: parsePart(link.openPart(value, link.limits, link.context)) as JsonValue });
		}
		// 失败成员只需恢复错误信封，不需要值。
		for (const { member, error } of entry.failed) add(member, { kind: "failed", error: errorFromWire(error) });
		// 快照必须覆盖该 variant 的全部 state 成员。
		if (members.size !== names.state.length) throw new Error(`hold ${entry.hold}: the snapshot misses a member`);
		// 返回采用闭包；它会在消费端的同一个批次内执行。
		return () => {
			// 保留旧副本表，用于复用成员副本。
			const previous = this.#bound?.replicas;
			// 新副本表。
			const replicas = new Map<string, Replica>();
			// First: a derive recomputing in this batch reads the new variant through its reference.
			// 先设置 #bound 再创建副本：批次内重算的 derive 通过引用读取时，应看到新 variant 而不是旧元数据。
			this.#bound = { variant, methods: data.methods, names, replicas };
			// 为每个成员建立或复用副本。
			for (const [member, state] of members) {
				// 旧绑定里有同名成员则复用，保留其 watch 与解码器历史。
				const replica = previous?.get(member);
				if (replica === undefined) {
					// 新成员：创建副本并加入共享批次。
					replicas.set(member, new Replica(this.#host.batch, state));
				} else {
					// 已有成员：用新快照重置，内部会重建 Delta 解码器。
					replica.reset(state);
					replicas.set(member, replica);
				}
			}
			// 旧绑定中不在新 variant 的成员：保留副本但标记失败，后续绑定若重新包含它可以恢复。
			for (const [member, replica] of previous ?? []) {
				// 新 variant 有的成员已经处理过。
				if (members.has(member)) continue;
				// vanish 复用失败机制，错误说明该 variant 没有此成员。
				replica.vanish(invalid("member", `${this.label} (variant ${variant}) has no state member "${member}"`));
				// 仍放进副本表，使 member() 能读到它的失败状态。
				replicas.set(member, replica);
			}
		};
	}

	/** After a `bound` message's batch: the reference goes live (its parked calls are sent, a parked dependent goes on). */
	// 绑定批次结束后进入 live：清除失败记录，并通知引用层恢复调用与依赖。
	wentLive(): void {
		// 成功绑定后不再有失败。
		this.#lastFailure = undefined;
		// 移动到共享的 LIVE 状态对象。
		this.#move(LIVE);
	}

	/**
	 * `failed`: the provider's object failed and no attempt runs (`retryIn`: the rest of its backoff window), or the hold
	 * is unbound there or its object parked on a failed dependency (`waiting`), each new cause a new message. On a bound
	 * hold it unbinds it (slice 7b, model §5): the members keep their last values until the next `bound`.
	 */
	// 处理提供端 failed 消息：cause.kind 区分 transient/broken/waiting，retryIn 转成本地绝对时间。
	failed(message: Extract<Message, { readonly kind: "failed" }>): void {
		// A plugin's error a provider failed with is this object's failure, as a ChordError.
		// 插件错误跨链接后仍是错误信封；asChordError 把它恢复成本地 ChordError，标签用对象标签。
		const error = asChordError(errorFromWire(message.cause.error), this.label);
		// 记录最近失败。
		this.#lastFailure = error;
		// retryIn 是相对毫秒；转成 Date.now() 基准的绝对时间供退避调度使用。
		const retryAt = message.retryIn === undefined ? undefined : Date.now() + message.retryIn;
		// 保留 cause.kind，让引用层区分可等待与永久失败。
		this.#move({ kind: "failed", cause: { kind: message.cause.kind, error }, retryAt });
	}

	/**
	 * `loading`: the provider's object started a new attempt after a failure, or its relay's upstream link dropped
	 * (`#startOver`).
	 */
	// 提供端开始新一轮尝试：进入 loading，保留副本旧值。
	loading(): void {
		// 复用统一的 loading 迁移。
		this.#startOver();
	}

	/**
	 * Decodes and applies one entry of a state message (its members by index, each with its ops), without changing
	 * anything yet: returns what adopts it into the replicas, run inside the batch that applies the whole message.
	 * Throws on an entry that does not fit (a protocol error), and `too_large/part` for ops past the link's limits.
	 */
	// 准备一条 state 条目：解码操作、检查重复与退役索引，返回批次内采用闭包；暂不改变状态。
	prepare({ hold: id, members, failed, retired }: StateEntry, link: HostLink): () => void {
		// 读取当前绑定。
		const bound = this.#bound;
		// state 只能出现在 live 且已绑定之后；否则是协议错误。
		if (this.#state.kind !== "live" || bound === undefined) throw new Error(`hold ${id}: state before bound`);
		// 局部函数：把线上索引换成副本，不存在则报协议错误。
		const replica = (index: number): Replica => {
			// 索引先换成成员名。
			const name = bound.names.state[index];
			// 名字无效或副本缺失都是协议错误。
			const found = name === undefined ? undefined : bound.replicas.get(name);
			if (found === undefined) throw new Error(`hold ${id}: no state member ${index}`);
			return found;
		};
		// Made by the first retirement (rare): no allocation per message otherwise.
		// 退役集合延迟分配：大多数 state 消息没有 retired 成员。
		let retirements: Set<Replica> | undefined;
		// 校验 retired 索引：转换副本并拒绝同一成员重复退役。
		for (const member of retired) {
			// 解析索引。
			const target = replica(member);
			// 第一次需要时才创建集合。
			retirements ??= new Set();
			// 重复退役是协议错误。
			if (retirements.has(target)) throw new Error(`hold ${id}: member ${member} retired twice in one state`);
			// 记录退役副本。
			retirements.add(target);
		}
		// 记录本消息中已经出现的副本，防止同一成员出现两次。
		const changed = new Set<Replica>();
		// 解码每个成员的操作；target.decode 只计算新值，不应用。
		const updates = members.map(({ member, ops }) => {
			// 解析索引得到副本。
			const target = replica(member);
			// 同一成员重复出现是协议错误。
			if (changed.has(target)) throw new Error(`hold ${id}: member ${member} twice in one state`);
			// 记录已出现。
			changed.add(target);
			// decode 返回 {value, ops}；展开后与 target 合并成一条更新记录。
			return { target, ...target.decode(parsePart(link.openPart(ops, link.limits, link.context))) };
		});
		// 失败成员同样先解析副本与错误，稍后应用。
		const failures = failed.map(({ member, error }) => ({ target: replica(member), error: errorFromWire(error) }));
		// 返回采用闭包。
		return () => {
			// 逐个采用新值与操作；退役标志来自本消息的 retired 集合。
			for (const { target, value, ops } of updates) target.adopt(value, ops, retirements?.has(target) === true);
			// 应用成员失败。
			for (const { target, error } of failures) target.fail(error);
			// A retirement without ops (a derive whose value stayed, rule 21): the flag alone, after the failures (a
			// failed member keeps it for its next value).
			// 只在 retired 中出现、没有操作也没有失败的成员：单独发布退役标志，由副本决定立即传播还是等下一次值。
			if (retirements !== undefined) {
				// changed 中的成员已经在 adopt 时带上标志，无需重复处理。
				for (const target of retirements) if (!changed.has(target)) target.retireAlone();
			}
		};
	}

	/**
	 * Its principal was revoked on this host (`host.revoke`): released at its provider if it is held there, then ended
	 * with `error` as `lost` does; no later link holds it.
	 */
	// 身份撤销：先向提供端释放 hold，再让对象以 lost 结束。
	revoke(error: ChordError): void {
		// 取出当前 hold 并立即清空，避免重入。
		const hold = this.#hold;
		this.#hold = undefined;
		// 有连接时发送 release；可选调用保证没有连接也能继续。
		hold?.side.release(hold.id, error);
		// 走与 gone 相同的结束流程。
		this.lost(error);
	}

	/** `gone`, or the host closes: the reference ends, its calls reject with `error`. */
	// 永久结束对象：通知消费端遗忘该 hold，结束绑定与本地状态。
	lost(error: ChordError): void {
		// 保存绑定引用，稍后结束它。
		const binding = this.#binding;
		// 从消费端调用表移除该 hold，并让在途调用失败。
		this.#hold?.side.forget(this.#hold.id, error);
		// 清理对象自身状态。
		this.#end(error);
		// 通知引用层该绑定已结束。
		binding?.end(error);
	}

	/** Ends the object: detached from its path, waits rejected, replicas ended; keeps nothing of its reference. */
	// 结束对象：状态置为 ended，清空所有关联，退出路径并结束副本。
	#end(error: ChordError): void {
		// 保留旧绑定，关闭其副本。
		const bound = this.#bound;
		// 终态保存原因，之后读取 value/state 会得到它。
		this.#state = { kind: "ended", error };
		// 清空引用绑定。
		this.#binding = undefined;
		// 清空依赖对象。
		this.#dependent = undefined;
		// 清空 hold。
		this.#hold = undefined;
		// 清空副本表。
		this.#bound = undefined;
		// 从路径移除，未来连接不再持有。
		this.#path.detach(this);
		// 结束每个副本，关闭其 watch。
		for (const replica of bound?.replicas.values() ?? []) replica.end(error);
	}

	/**
	 * Loading again until the next binding; the members keep their last values. A drop while it is loading already
	 * changes nothing: a dependent parked on it goes on waiting for the next link's binding (a drop is not a dependency
	 * failure).
	 */
	// 重新进入 loading：ended 不再改变，已经 loading 时什么也不做，避免重复通知。
	#startOver(): void {
		// 读取状态 kind。
		const { kind } = this.#state;
		// 只要不是 ended/loading 就迁移。
		if (kind !== "ended" && kind !== "loading") this.#move(LOADING);
	}

	/** Moves to `state` and tells the reference: its members follow what it shows now (in a batch), then its state. */
	// 状态迁移的唯一入口：保存状态，通知绑定重定向跟随目标，再报告移动事件。
	#move(state: RefState): void {
		// 保存新状态。
		this.#state = state;
		// 没有引用绑定时无需通知。
		const binding = this.#binding;
		if (binding === undefined) return;
		// following 为真表示引用正在跟随成员：重定向会改变其 derive 输入，必须放进批次。
		// within 用 BACKGROUND_CONTEXT 运行，不在调用者上下文中传播取消。
		if (binding.following) this.#host.batch.within(() => binding.retarget(), BACKGROUND_CONTEXT);
		// 否则直接重定向即可。
		else binding.retarget();
		// 通知绑定状态已变化。
		binding.moved();
	}
}
