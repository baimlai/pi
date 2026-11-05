// Chord v1 的远程引用实现：把“另一台宿主上的对象”包装成可共享的绑定（RemoteBinding）和多个引用视图（RemoteRef）。
//
// 所属模块：packages/chord/src/old，Chord v1 宿主运行时。远程对象通过 Connection 链路访问；一次 get 会先在本机
// 找到或建立绑定，绑定在一条链路上只发一个 hold（断线重连时带 again 重新 hold），对端用 shape + 各状态成员快照
// 回复，之后用 ops/reset 帧维持状态。
//
// 职责边界：本文件不负责网络帧编码/解码（wire.ts 与 connection.ts）、不负责对象激活（object.ts）、不负责路由与
// 绑定缓存（host.ts 的 #acquireRemote/#hold/bindingIdle/forgetBinding）。它负责：
// - 共享绑定的状态机：loading → live →（断线）loading → live；对端结束/本地关闭 → ended。
// - 状态成员的水合（hydration）：必须收齐当前 variant 的所有 state 成员才可读，避免读到半套状态。
// - 把绑定状态投影成每个引用自己的 status/ready/onStatus/onShape 与 release。
// - 方法调用：等待绑定可用、校验 ctx、按消费者 schema 清洗参数，然后经 hold 发到对端。
//
// 上游入口：host.ts 的 #acquireRemote 在第一次 get 远程类型时创建 RemoteBinding，并交给 #hold 选择链路；
// #acquireRemote 返回 RemoteRef 本身（它实现 RefCore），无需再包 RefImpl。connection.ts 实现 RemoteChannel，
// 在收到 hold 回复时调用 shaped、在状态帧到达时调用 state、断链时调用 detached、对端结束/拒绝时调用 gone。
// 下游依赖：delta（解码 ops 与不可变应用）、cell（HYDRATION 标记，供本地对象转发远程状态时等待水合）、contract
// （takesNoArgs 判断无参方法）、errors（ChordError 与 not_ready/not_in_variant/released 等代码）、object
// （CtxImpl、REF_BASE、notifyStatus、raceSignal、refsByProxy、RefCore 协议）、schema.cleaned（按 schema 清洗参数）、
// wire.fromWireError（把线上错误还原成本地 ChordError）、types（Ctx/Readable/RefStatus/Shape/StateEvent）。
//
// 能力清单：
// - StateIn：绑定从链路收到的一帧成员状态（snap/reset/ops/error），载荷已解包。
// - RemoteChannel：绑定对链路的最小需求（hold/release/call/wantState），由 Connection 实现。
// - RemoteHost：绑定对宿主的最小需求（inFactory/report/root/bindingIdle/forgetBinding），由 HostImpl 实现。
// - RemoteBinding：每个“类型 + 规范化输入 + 主体键 + 消费方契约指纹”一个共享绑定；管理 hold、状态、调用与视图集合。
// - ViewReadable：远程引用的一个状态成员，实现 Readable（value/subscribe/events），并带 HYDRATION 标记。
// - RemoteRef：一个引用视图，提供 contract/status/ready/onShape/onStatus/release 及按契约生成的方法/状态成员。
//
// 组合与典型顺序：
//   1. 调用方 await ctx.get(Counter, { name: "a" }) → host 找到/创建共享绑定并返回 RemoteRef 包装。
//   2. Connection 发 hold；对端回复 shaped(shape, listed) 和若干 state(name, snap)。
//   3. RemoteBinding 收齐成员后 #apply 置 live、水合完成；所有视图 update 为 live，ready 完成。
//   4. 调用 ref.increment(ctx) → RemoteRef.#caller 校验 ctx → RemoteBinding.call → Connection.call。
//   5. 状态帧 ops 通过 decoder 增量应用；断链时 detached 保留旧值并回到 loading；对端结束则所有视图 gone。
//   6. 最后一个视图 release 后，绑定进入宿主 linger 或 close；close 释放 hold 并从宿主移除。
//
// 示例（真实签名，host 已由 createHost 建立）：
//   const ref = await host.get(Counter, { name: "a" });
//   await ref.increment();                     // 省略 ctx 时 RemoteRef 为这次调用新建根；传入 ctx 可共享调用者的根
//   const value = ref.count.value;             // 状态成员，引用 ready（含状态）后可读
//   const off = ref.onStatus((status, error) => console.log(status, error));
//   ref.release();
//   这里的 ref 是契约推导出的 Ref<Counter>；真实运行时它是 Proxy，方法/状态成员按名称映射到 RemoteRef.member。
//
// 建议阅读顺序：先看 StateIn/RemoteChannel/RemoteHost 三个接口明确边界；再看 deferred/MemberState 与 RemoteBinding
// 字段注释理解状态机；然后按“视图管理 → 状态接收 → 链路事件 → 调用”顺序读 RemoteBinding 方法；接着看 ViewReadable
// 如何缓存值和通知；最后读 RemoteRef 的 Proxy、#caller 与 update/end/shapeChanged。收尾可对照 connection.ts 的
// hold/state 处理与 host.ts 的 #acquireRemote 看上下游如何衔接。
import { applyImmutable, type Decoder, decoder } from "../delta/index.ts";
import { HYDRATION, type Hydration } from "./cell.ts";
import { type AnyContract, takesNoArgs } from "./contract.ts";
import { ChordError, invalid } from "./errors.ts";
import {
	CtxImpl,
	notifyStatus,
	REF_BASE,
	type RefCore,
	type RefOwner,
	raceSignal,
	refsByProxy,
	type StatusListener,
} from "./object.ts";
import { cleaned } from "./schema.ts";
import type { Ctx, Readable, RefStatus, Shape, StateEvent } from "./types.ts";
import { fromWireError, type RootRef, type WireError } from "./wire.ts";

// 无参空函数，用作延迟 Promise 的初始 resolve/reject 占位，以及吞掉未被 await 的拒绝。
const noop = (): void => {};

/** One state frame for a member, as the binding receives it (payload unpacked). */
// 一帧状态输入的形状。as 是判别字段（字面量联合），便于 switch/if 收窄：
// - "snap"/"reset"：value 是完整值，绑定会为该成员新建 decoder；
// - "ops"：ops 是线上操作数组，绑定用该成员现有 decoder 解码并增量应用；
// - "error"：error 是线上错误，绑定用 fromWireError 还原；首次水合前会直接让整个绑定失败。
// value/ops/error 都是可选字段：类型只声明“可能有什么”，运行时不校验与 as 的配对关系，实际配对由 connection/wire 保证。
export interface StateIn {
	readonly as: "snap" | "reset" | "ops" | "error";
	readonly value?: unknown;
	readonly ops?: readonly unknown[];
	readonly error?: WireError;
}

/** What a binding needs from the link it is bound to (implemented by Connection). */
// 绑定观察链路的窄接口，避免 remote.ts 依赖整个 Connection。Connection 同时实现它和 wire 协议。
// 这些方法都由绑定在状态变化时调用；返回值/异常由 Connection 决定，绑定只使用 hold 返回的数字 id。
export interface RemoteChannel {
	/** Sends a hold for `binding`; `again`: the binding already has values (a re-hold), its unit is not urgent. */
	// 发送 hold 帧并返回本次 hold 的本地编号（后续 release/call/wantState 都用它）。
	// again 为 true 表示绑定已有旧值，是断线后的再次 hold；对端可降低该 unit 的发送优先级。
	// 注意这里只发起请求；结果通过 shaped/state/gone 回调异步返回。
	hold(binding: RemoteBinding, again: boolean): number;
	// 释放某个 hold；绑定关闭时调用。重复释放不存在 id 的行为由 Connection 定义。
	release(id: number): void;
	// 经指定 hold 调用远端成员。member 是契约中的方法名；args 已按消费者 schema 清洗或为 undefined；
	// root 携带 rootId/codeVersion，让对端把嵌套调用放进同一棵短调用树；signal 取消时链路应拒绝。
	call(hold: number, member: string, args: unknown, root: RootRef | undefined, signal: AbortSignal): Promise<unknown>;
	/** Starts (`sub`) or stops (`unsub`) the state of a hold. */
	// 请求对端开始/停止发送该 hold 的状态。绑定在视图对状态的需求变化时调用；
	// 停止后绑定会清空已水合的值，重新需要时再次等待完整快照。
	wantState(hold: number, wanted: boolean): void;
}

/** What a binding needs from its host. */
// 绑定观察宿主的窄接口，由 HostImpl 实现。把它抽出来可让 RemoteBinding 不依赖 host.ts 的具体类。
export interface RemoteHost {
	// 当前是否正在运行对象工厂（>0 表示在工厂内）。在工厂内发起远程调用会被拒绝，因为此时绑定/对象尚未稳定。
	readonly inFactory: number;
	// 报告后台错误（状态解码失败、监听器抛错等）。报告不会中断绑定状态机。
	report(error: unknown): void;
	// 创建一棵宿主根调用并返回 Promise；绑定用它为“没有显式 ctx”或“ctx.holder”的调用建立 root。
	// 泛型 T 让回调返回值类型传递到 Promise；options.signal 用于取消。
	root<T>(fn: (ctx: Ctx) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
	/** The binding has no views left: the host lingers it or closes it. */
	// 最后一个视图移除后的回调：宿主可选择 linger（保留一段时间以复用状态）或直接 close。
	bindingIdle(binding: RemoteBinding): void;
	/** The binding ended or was closed: the host forgets it. */
	// 绑定已结束/关闭：宿主从自己的 bindings 表移除它，防止后续 get 复用死绑定。
	forgetBinding(binding: RemoteBinding): void;
}

// Settle 描述一个 Promise 的两个控制函数；交叉类型 & 在 deferred 返回值里把 promise 与它们组合。
type Settle = { resolve: () => void; reject: (error: unknown) => void };

// 创建一个可由外部手动完成的 Promise<void>。用途：#live 让调用等待“本次 hold 已应用形状”，#settleReady 让
// ready 等待引用首次 live。Promise 执行器里的 done/fail 被保存到闭包变量；catch(noop) 提前挂一个拒绝处理器，
// 避免绑定在没人 await 的情况下结束时触发 Node 的未处理拒绝警告（真正的错误仍由 #live.promise 的等待者看到）。
// 示例：const d = deferred(); d.promise.then(...); d.resolve();
// 真实行为：resolve/reject 只能通过返回对象调用；重复调用不会改变 Promise 的最终状态，但这里没有做防重检查。
function deferred(): { promise: Promise<void> } & Settle {
	let resolve = noop;
	let reject: (error: unknown) => void = noop;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	promise.catch(noop);
	return { promise, resolve, reject };
}

/** A member's value with the decoder of its current stream. */
// 一个状态成员的本地缓存：value 是当前值（按契约不可变）；decoder 记住该成员增量流的基线，
// ops 帧到达时用同一个 decoder 解码，才能正确解释相对于已应用值的 delta。snap/reset 会替换成新的 decoder()。
interface MemberState {
	value: unknown;
	decoder: Decoder;
}

/**
 * One hold per host and key (type, normalized input, principal key, contract fingerprint), shared by every reference to
 * it: one hold over the link, one stream per state member, calls over the same hold. References are views onto it.
 *
 * A hold implies the state of its variant (unless no view wants state): the provider answers with a unit, the shape
 * followed by a snapshot of each state member the binding lacks. A shape is applied only once all of its snapshots are
 * here, so a live binding always has every state member of its variant. After the first hydration the values stay
 * readable while the binding re-holds (link loss): status `loading`, last values kept.
 */
// 共享绑定。关键不变量：
// - 同一 key 只发一个 hold；所有 RemoteRef 只是视图，各自有 status/release，不重复占用链路。
// - 一个 hold 隐含其 variant 的状态（除非没有任何视图要状态）：对端先回 shape，再逐个 state 成员回快照。
// - #apply 只在 pending.missing 为空（listed 中本地需要的成员都已到齐）时执行；hydrated 进一步要求 shape.members
//   中属于契约 state 的成员都有值。正常情况下 live 的状态视图意味着整套状态可读。
// - 断线时保留 members 和 shape，状态回到 loading；重新 hold 成功后再次水合，期间旧值仍可读（read 只在未水合时拒绝）。
// - ended 是单向终态：对端 gone 或宿主 close 后不再复用，必须由 host.forgetBinding 清除。
export class RemoteBinding {
	// 绑定所属宿主；调用 begin/forget、报告错误、建立 root 都经它。
	readonly host: RemoteHost;
	// 绑定键：由 host.ts #acquireRemote 计算，包含类型名、规范化输入、主体键与消费者契约指纹。
	// 相同 key 的 get 复用这个绑定；key 也用作 Ref.address 与错误消息中的标识。
	readonly key: string;
	// 消费者契约（调用方声明的那一份），用于读取 variant 描述、方法参数 schema 和状态成员 schema。
	// 它不一定与服务端提供者契约相同；绑定时已用契约指纹/coverage 检查兼容性。
	readonly contract: AnyContract;
	// 目标 host 名（placement 解析结果），用于诊断和宿主选择链路；本文件不根据它做路由，路由由 host 完成。
	readonly at: string;
	// 规范化后的输入对象，与 key 一起标识实例；绑定不再修改它。
	readonly input: unknown;
	/** Forwarded principal (omitted for the host's own principal). */
	// 转发的主体身份；undefined 表示使用宿主自己的主体。该字段会进入 key，因此不同主体不会共享绑定。
	readonly principal: unknown | undefined;
	/** `ended`: gone with `error`, or closed (no views, no linger). */
	// 三态：loading 等待 hold/水合；live 有当前 hold 且（若需要状态）已水合；ended 终态。
	// 注意断线重连会 live → loading → live，但 ended 不会回到 loading。
	status: "loading" | "live" | "ended" = "loading";
	// 终止原因；只有 gone(error) 或 close 的 released 错误会写入，供 RemoteBinding.terminalError 使用
	//（read/call/whenHydrated 等读取它）；RemoteRef 使用自己的 error 字段。
	error: unknown;
	/** The applied shape (kept while re-holding). */
	// 已应用的形状（variant + members + provider 契约指纹）；重连期间保留，便于视图继续展示旧 variant。
	shape: Shape | undefined;
	/** Every state member of the applied shape has a value (stays true while re-holding). */
	// 是否已收齐该 shape 中按消费者契约属于 state 的成员。stateOn=false 的仅方法引用不会水合，此值保持 false。
	// 断线重连时保留旧值（重连期间旧状态仍可读），之后由 #apply 重新计算；#syncState 关闭状态需求时清成 false。
	hydrated = false;
	/** The current hold; undefined while resolving the route or after a link loss. */
	// 当前链路 hold；路由尚未解析或断线后为 undefined。channel 是 Connection 的窄接口，id 是该 hold 的本地编号。
	hold: { readonly channel: RemoteChannel; readonly id: number } | undefined;
	/** What the provider was told: state for this hold (`state: false` / `sub` / `unsub`). */
	// 已经告知提供者的状态意愿：true 表示已 sub，false 表示未订阅/已 unsub。用于避免重复发送 wantState。
	stateOn = false;
	// 当前所有引用视图；Set 可安全在遍历时增删（删除当前项不会跳过后续项）。
	readonly views = new Set<RemoteRef>();
	// 已水合的状态成员缓存，键为成员名；值对象在 ops 帧时原地更新 value（按契约不可变，但这里替换值字段）。
	readonly members = new Map<string, MemberState>();
	/** Lingering since (no views): set by the host. */
	// 宿主设置的 linger 定时器句柄；添加新视图时清除，到期由宿主 close。
	lingerTimer: ReturnType<typeof setTimeout> | undefined;
	// 每个状态成员名 → 该成员上的 ViewReadable 集合；只有调用过 subscribe/events 的 ViewReadable 才会登记。
	readonly #listeners = new Map<string, Set<ViewReadable>>();
	/** A shape waiting for its snapshots. */
	// 正在等待快照的 shape。missing 是还缺的成员名；values 是已收但尚未应用的成员值。
	// 首次水合前这些值不会进入 members，因此读取不会看到半套状态；重新 hold 期间 members 仍保留旧值。
	#pending: { shape: Shape; readonly missing: Set<string>; readonly values: Map<string, MemberState> } | undefined;
	/** Resolved while a shape is applied for the current hold (calls wait for it). */
	// “已可调用”信号：call 在绑定非 live 时等待它，#apply 时 resolve；断线从 live 回到 loading 时换一个新的
	// deferred（gone/close 则 reject）。用 deferred 而不是直接判断状态，是为了把“等待形状应用”与“等待重连”
	// 合并成同一个可取消等待。
	#live = deferred();
	/** A shape was applied once (a re-hold says `again`). */
	// 是否曾经成功应用过 shape；决定下一次 hold 的 again 参数（true 表示已有旧值，对端可降低优先级）。
	#applied = false;
	/** Waiting for the first hydration (`whenHydrated`). */
	// 等待首次水合的调用者；#apply 完成水合、gone 或 close 时统一 settle，避免永久挂起。
	readonly #hydrationWaiters = new Set<Settle>();

	// 构造函数只保存宿主与 key 字段，不发起 hold、不注册视图；真正的链路建立由 host.ts 的 #hold 选择 Connection 后调用。
	// 参数是内联对象类型；host、contract 等字段直接赋值，便于测试与宿主构造。
	constructor(
		host: RemoteHost,
		fields: { key: string; contract: AnyContract; at: string; input: unknown; principal: unknown | undefined },
	) {
		this.host = host;
		this.key = fields.key;
		this.contract = fields.contract;
		this.at = fields.at;
		this.input = fields.input;
		this.principal = fields.principal;
	}

	// 是否终态。使用 getter 而不是字段，保证 status 是唯一事实来源，不会出现 ended 字段与 status 不一致。
	get ended(): boolean {
		return this.status === "ended";
	}

	/** Views that want state. */
	// 统计需要状态的视图数。每个视图的 wantsState 在构造时固定（state:false 的视图永远为 false）。
	get stateViews(): number {
		let count = 0;
		for (const view of this.views) if (view.wantsState) count++;
		return count;
	}

	/** Whether the next hold should carry state: some view wants it, or nobody is left (lingering keeps it). */
	// 计算下一次 hold 是否请求状态：
	// - 还有视图：只要有一个视图要状态就请求；
	// - 没有视图（linger 中）：沿用 stateOn，避免 linger 到期前无缘无故丢弃已有状态。
	// 注意这不等于“当前 hold 已订阅状态”；stateOn 反映已发给提供者的意愿。
	get wantsState(): boolean {
		return this.views.size === 0 ? this.stateOn : this.stateViews > 0;
	}

	/** Whether a re-hold is `again` (the binding already has a shape). */
	// 只要成功应用过 shape 就为 true，即使随后断线；用于向后端表明重连可复用旧 unit、无需抢优先发送。
	get applied(): boolean {
		return this.#applied;
	}

	// ─── views ───

	// 添加一个引用视图：取消 linger、按新的状态需求同步 sub/unsub，并立即让该视图计算自己的 status。
	// 输入 view 由 host 创建并已绑定到本 binding；重复添加同一 view 不会报错（Set 去重），但会重复 update。
	addView(view: RemoteRef): void {
		this.views.add(view);
		if (this.lingerTimer !== undefined) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = undefined;
		}
		this.#syncState();
		view.update();
	}

	// 移除视图：同时清掉该视图在成员监听表中的登记（否则已释放视图会继续收到状态）。
	// 若这是最后一个视图，交给宿主决定 linger/close，而不是在这里直接关闭。
	removeView(view: RemoteRef): void {
		if (!this.views.delete(view)) return;
		for (const set of this.#listeners.values())
			for (const readable of set) if (readable.view === view) set.delete(readable);
		if (this.views.size === 0) {
			this.host.bindingIdle(this);
			return;
		}
		this.#syncState();
	}

	/** Tells the provider to start or stop state when the views' wish changed. */
	// 当视图集合对状态的需求变化时通知提供者。wanted 为 true 时只发 sub，不立即清空；
	// 变为 false 时清空已水合值（stateOn 已关闭，旧值不再可信），并清掉 pending 中待收成员（关闭期间不再等这些快照）。
	// hold 尚不存在时只记录 stateOn，hold 建立后 Connection.hold 会读取它来决定是否带 state: false。
	#syncState(): void {
		if (this.ended || this.views.size === 0) return;
		const wanted = this.stateViews > 0;
		if (wanted === this.stateOn) return;
		this.stateOn = wanted;
		if (!wanted) {
			this.hydrated = false;
			this.members.clear();
			if (this.#pending !== undefined) this.#pending.missing.clear();
		}
		if (this.hold !== undefined) this.hold.channel.wantState(this.hold.id, wanted);
		for (const view of this.views) view.update();
	}

	// 登记一个成员级监听者（ViewReadable）；同名成员可有多个监听者，只有它们存在时 #deliver 才有工作。
	listen(name: string, readable: ViewReadable): void {
		let set = this.#listeners.get(name);
		if (set === undefined) {
			set = new Set();
			this.#listeners.set(name, set);
		}
		set.add(readable);
	}

	// 取消登记；使用可选链 ?. 避免成员从未被监听时创建空集合。空集合保留在 Map 中，不影响正确性。
	unlisten(name: string, readable: ViewReadable): void {
		this.#listeners.get(name)?.delete(readable);
	}

	/** Whether `name` is a state member of the applied variant (as the consumer's contract describes it). */
	// 判断某个名字是否是“已应用 variant”的 state 成员。它只看消费者契约的 description，不检查 members 中是否真有值，
	// 因此可用来区分“成员不在当前 variant”与“成员应在但尚未水合”。
	// 可选链 shape?.variant：未应用 shape 时 variant 为 undefined，直接返回 false。
	// variants[variant]?.[name]?.kind：两级可选索引，缺 variant 或缺成员都得到 undefined，不会抛错。
	inVariant(name: string): boolean {
		const variant = this.shape?.variant;
		return variant !== undefined && this.contract.description.variants[variant]?.[name]?.kind === "state";
	}

	/** The members' value as views read it: throws `not_ready` before the first hydration, `not_in_variant` outside it. */
	// 状态成员的实际读取入口，ViewReadable.value 会委托到这里。错误顺序很重要：
	// 1. 已结束 → 抛出终止原因（gone 的错误或 released）；
	// 2. 未水合 → not_ready（包括“状态刚被 unsub 清空”或“首次快照还没齐”）；即使成员不在 variant 也先报这个；
	// 3. 名字不是当前 variant 的 state 成员 → not_in_variant；
	// 4. 返回 members 中的值；若契约声明了但提供者漏发，则返回 undefined（类型层不区分，调用方需依赖契约保证）。
	read(name: string): unknown {
		if (this.status === "ended") throw this.terminalError();
		if (!this.hydrated) throw new ChordError("not_ready", `${this.key}.${name} is not hydrated yet`);
		if (!this.inVariant(name))
			throw new ChordError(
				"not_in_variant",
				`${this.key}: ${name} is not a state member of variant ${this.shape?.variant}`,
			);
		return this.members.get(name)?.value;
	}

	/** Resolves once the binding has its state (rejects if it ends first). */
	// 等待首次（或重新订阅后的）水合完成。已经水合立即 resolve；已结束立即 reject；
	// 否则加入等待集合，由 #apply 成功、gone 或 close 统一 settle。
	// 注意仅方法引用（stateOn=false）永远不会水合，如果没有视图切换到要状态，这个 Promise 会一直等到绑定结束。
	whenHydrated(): Promise<void> {
		if (this.hydrated) return Promise.resolve();
		if (this.ended) return Promise.reject(this.terminalError());
		return new Promise<void>((resolve, reject) => this.#hydrationWaiters.add({ resolve, reject }));
	}

	// 一次性结算所有水合等待者：error 为 undefined 表示成功。先复制再清空，本次结算不会影响回调中新登记的等待者。
	#settleHydration(error?: unknown): void {
		const waiters = [...this.#hydrationWaiters];
		this.#hydrationWaiters.clear();
		for (const waiter of waiters) {
			if (error === undefined) waiter.resolve();
			else waiter.reject(error);
		}
	}

	// 视图能否读取该成员：绑定未结束、已水合、且成员属于当前 variant。ViewReadable 用它决定是否立即发送初始值。
	readable(name: string): boolean {
		return this.status !== "ended" && this.hydrated && this.inVariant(name);
	}

	// 绑定终态的错误：优先使用真实原因；被本地 close 而没有 error 时，构造 released 错误。
	// ?? 只在左侧为 null/undefined 时取右值；即使 error 是 falsy 的字符串或 0，也会被保留。
	terminalError(): unknown {
		return this.error ?? new ChordError("released", `reference ${this.key} released`);
	}

	// ─── driven by the host and the link ───

	// 由 Connection 在 hold 成功登记后调用：记录链路与 id，并把“本次 hold 是否要状态”定为当前视图需求。
	// 这里不发送 wantState；Connection.hold 紧接着在发帧时读取 binding.stateOn，后续变化才经 #syncState 发 wantState。
	bound(channel: RemoteChannel, id: number): void {
		this.hold = { channel, id };
		this.stateOn = this.wantsState;
	}

	/** A unit begins: `listed` are the members whose snapshots follow. */
	// 收到一个 unit 的开头。shape 是对端描述；listed 是随后会发快照的 state 成员名。
	// 流程：
	// 1. 若仍有旧 pending，合并其 missing（中继可能重排：新 shape 先到、旧快照后到，必须都等）；
	// 2. 只保留“当前 variant 的 state 成员且本地确实订阅了状态”的名字；
	// 3. 建立 pending，复用旧 values；若一个都不缺，立即 #apply。
	// 注意 listed 之外的成员不会被等待；#apply 计算 hydrated 时仍要求 shape.members 中属于契约 state 的成员都有值，
	// 否则状态视图会继续停留在 loading（提供者应保证 listed 覆盖这些成员）。
	shaped(shape: Shape, listed: readonly string[]): void {
		if (this.ended) return;
		const previous = this.#pending;
		const missing = new Set<string>(listed);
		// A newer shape before the older one's snapshots (relays may reorder them): wait for both.
		if (previous !== undefined) for (const name of previous.missing) missing.add(name);
		const wanted = new Set(this.#stateMembers(shape));
		for (const name of [...missing]) if (!wanted.has(name) || !this.stateOn) missing.delete(name);
		this.#pending = { shape, missing, values: previous?.values ?? new Map() };
		if (missing.size === 0) this.#apply();
	}

	/** A state frame for member `name` of the current hold. */
	// 处理当前 hold 的一个成员状态帧。按 as 分支：
	// - error：还原线上错误；若尚未水合且本地想要状态，绑定直接 gone+close（否则调用者会永远等）；否则仅报告。
	// - ops：优先应用到 pending 中的候选值，否则应用到 members；找不到目标说明该成员未被需要，静默忽略。
	//   解码后的 ops 是不可变操作，applyImmutable 返回新值；只有直接应用到 members 时才立即通知监听者。
	// - snap/reset：构造新的 MemberState（新 decoder）；若属于 pending，则填入并可能触发 #apply；
	//   否则若成员在当前 variant，直接覆盖 members 并以 reset 事件通知（例如重连后的非首次快照）。
	state(name: string, frame: StateIn): void {
		if (this.ended) return;
		if (frame.as === "error") {
			const error = fromWireError(frame.error!);
			// Before the first hydration nobody could read anything: the binding fails instead of waiting forever.
			if (!this.hydrated && this.stateOn) {
				this.gone(error);
				this.close();
			} else this.host.report(error);
			return;
		}
		const pending = this.#pending;
		if (frame.as === "ops") {
			const target = pending?.values.get(name) ?? this.members.get(name);
			if (target === undefined) return;
			const ops = target.decoder.decode(frame.ops ?? []);
			target.value = applyImmutable(target.value, ops);
			if (target === this.members.get(name)) this.#deliver(name, { type: "ops", ops, value: target.value });
			return;
		}
		const fresh: MemberState = { value: frame.value, decoder: decoder() };
		if (pending !== undefined && (pending.missing.has(name) || pending.values.has(name))) {
			pending.values.set(name, fresh);
			pending.missing.delete(name);
			if (pending.missing.size === 0) this.#apply();
			return;
		}
		if (!this.inVariant(name)) return;
		this.members.set(name, fresh);
		this.#deliver(name, { type: "reset", value: fresh.value });
	}

	/** The provider ended the object (or refused the hold): every view is gone. */
	// 对端彻底结束对象（或拒绝 hold）：绑定进入终态。顺序很重要：
	// 先标记 ended 阻止新工作，再 reject 正在等待的 call（#live）和水合等待者，然后逐个结束视图，
	// 清空监听并让宿主删除绑定。这里不清空 members；视图已 ended，read 会先抛终止错误。
	gone(error: unknown): void {
		if (this.ended) return;
		this.status = "ended";
		this.error = error;
		this.hold = undefined;
		this.#pending = undefined;
		this.#live.reject(error);
		this.#settleHydration(error);
		for (const view of [...this.views]) view.end(error);
		this.#listeners.clear();
		this.host.forgetBinding(this);
	}

	/** The link went down but may come back (upstream reconnect): keep the values, wait for the re-hold. */
	// 链路断开但可能恢复（上游重连）：丢弃当前 hold 和未完成的 pending，但保留 shape、members 和 stateOn。
	// 若之前是 live，则回到 loading 并换一个新的 #live deferred，让后续 call 等待下一次 hold；
	// 若本来就在 loading，沿用现有 deferred，避免多次断线产生多个等待信号。
	detached(): void {
		if (this.ended) return;
		this.hold = undefined;
		this.#pending = undefined;
		if (this.status === "live") {
			this.status = "loading";
			this.#live = deferred();
		}
		for (const view of this.views) view.update();
	}

	/** No views and no linger: releases the hold and forgets the binding. */
	// 没有视图且 linger 到期（或宿主直接关闭）时调用。先清定时器，再 release 当前 hold；
	// 若尚未 ended，构造 released 错误、reject #live、结束所有视图和水合等待者；最后清 pending/监听并从宿主移除。
	// 已经是 ended 时仍会执行清理，因此可安全重复调用（例如 state error 分支先 gone 再 close）。
	close(): void {
		if (this.lingerTimer !== undefined) clearTimeout(this.lingerTimer);
		this.lingerTimer = undefined;
		if (this.hold !== undefined) this.hold.channel.release(this.hold.id);
		this.hold = undefined;
		if (this.status !== "ended") {
			this.status = "ended";
			const error = new ChordError("released", `reference ${this.key} released`);
			this.#live.reject(error);
			this.#settleHydration(error);
			for (const view of [...this.views]) view.end(error);
		}
		this.#pending = undefined;
		this.#listeners.clear();
		this.host.forgetBinding(this);
	}

	/** Calls `name` over the current hold, waiting for it while the binding (re)holds. */
	// 经当前 hold 调用成员。循环处理“等待期间又断线/重连”的竞态：
	// 1. 已结束立即抛终止错误；
	// 2. 非 live 或无 hold 时等待 #live（受 ctx.signal 取消）；醒来后重新读取 hold；
	// 3. 检查成员在当前 variant 中确实是方法；
	// 4. 参数按消费者 schema 清洗后发送（只发送消费者知道的字段，避免把本地私有字段传给对端）；
	// 5. root 只传 rootId/codeVersion，不传整个 ctx；signal 让链路中止请求。
	// 若等待后仍不可用，continue 再次等待，而不是抛出瞬时错误。
	async call(name: string, args: unknown, ctx: Ctx): Promise<unknown> {
		for (;;) {
			if (this.ended) throw this.terminalError();
			if (this.status !== "live" || this.hold === undefined) await raceSignal(this.#live.promise, ctx.signal);
			const hold = this.hold;
			if (hold === undefined || this.status !== "live") continue;
			const variant = this.shape?.variant;
			const description = variant === undefined ? undefined : this.contract.description.variants[variant]?.[name];
			if (description?.kind !== "method") {
				throw new ChordError("not_in_variant", `${this.key}: ${name} is not a method of variant ${variant}`);
			}
			// Send only what the consumer's own schema knows (the additive rule's premise; see ObjectImpl.call).
			const sent = description.args === undefined ? undefined : cleaned(description.args, args);
			return hold.channel.call(
				hold.id,
				name,
				sent,
				{ rootId: ctx.rootId, codeVersion: ctx.codeVersion },
				ctx.signal,
			);
		}
	}

	// 计算一个 shape 中“按消费者契约属于 state 的成员名”。shape.variant 缺失时返回空数组；shape.members 是
	// 提供者列出的成员，按契约过滤掉 method/opaque 等非状态成员。返回新数组，调用方通常再转成 Set。
	#stateMembers(shape: Shape): string[] {
		const members = shape.variant === undefined ? undefined : this.contract.description.variants[shape.variant];
		if (members === undefined) return [];
		return shape.members.filter((name) => members[name]?.kind === "state");
	}

	/** Applies the pending shape with its snapshots: members outside the variant go, new values are announced. */
	// 应用 pending shape 与已收快照。步骤：
	// 1. 取走 pending 并记录 shape（此后 inVariant 以新 variant 为准）；
	// 2. 删除新 variant 不再包含的旧成员，写入新成员；
	// 3. hydrated = 订阅了状态且 shape.members 中属于契约 state 的每个成员都有值。仅方法绑定不算水合；
	// 4. 置 live、记录 applied、resolve #live（唤醒等待的 call）、更新所有视图；
	// 5. 对每个新值发送 reset 事件（即使已有同值，也代表一次重新绑定/快照）；
	// 6. 通知每个视图 shape 变化（onShape 监听者）。
	// 注意 pending.values 中不属于 wanted 的成员被丢弃，不进入 members。
	#apply(): void {
		const pending = this.#pending;
		if (pending === undefined) return;
		this.#pending = undefined;
		this.shape = pending.shape;
		const wanted = new Set(this.#stateMembers(pending.shape));
		for (const name of [...this.members.keys()]) if (!wanted.has(name)) this.members.delete(name);
		for (const [name, state] of pending.values) if (wanted.has(name)) this.members.set(name, state);
		this.hydrated = this.stateOn && [...wanted].every((name) => this.members.has(name));
		if (this.hydrated) this.#settleHydration();
		this.status = "live";
		this.#applied = true;
		this.#live.resolve();
		for (const view of this.views) view.update();
		for (const [name, state] of pending.values) {
			if (wanted.has(name)) this.#deliver(name, { type: "reset", value: state.value });
		}
		for (const view of [...this.views]) view.shapeChanged();
	}

	// 把事件投递给该成员的所有 ViewReadable。复制集合再遍历，防止监听器在回调中取消订阅导致迭代跳过。
	// 没有监听者时直接返回；绑定不缓存事件，晚注册者由 ViewReadable 自己补发当前值。
	#deliver(name: string, event: StateEvent<unknown>): void {
		const readables = this.#listeners.get(name);
		if (readables === undefined) return;
		for (const readable of [...readables]) readable.deliver(event);
	}
}

/**
 * A state member of a remote reference: the binding's value. Reading throws `not_ready` before the first hydration and
 * `not_in_variant` outside the variant. A listener added before the hydration gets its snapshot then.
 */
// 一个远程状态成员的可读视图，实现 types.ts 的 Readable<unknown>：value/subscribe/events。
// 每个 RemoteRef 按成员名惰性创建并缓存一个实例；它把读取委托给 binding，把监听登记到 binding.#listeners。
// 监听语义：
// - subscribe：注册后若已可读，立即同步交付当前值；之后每次 ops/reset 都交付最终值。
// - events：已可读时立即交付 snap；未水合时先记为 unseen，等首个非 ops 事件到达时补发 snap。正常流程中 #apply
//   会先发 reset，因此 unseen 监听者能拿到首个完整值；若首个事件是 ops，则该事件不投递，之后按已见监听者接收。
// - 监听器抛错不会影响其它监听者：每个调用都经 #safe 捕获并交给 host.report。
class ViewReadable implements Readable<unknown> {
	// 反向引用所属引用视图，用于判断是否结束、读取绑定以及释放时清理。
	readonly view: RemoteRef;
	// 成员名，与绑定 members 和监听表使用同一键。
	readonly #name: string;
	// 值监听者集合（subscribe）；事件监听者集合（events）；尚未收到首个快照的事件监听者。
	readonly #values = new Set<(value: unknown) => void>();
	readonly #events = new Set<(event: StateEvent<unknown>) => void>();
	/** Event listeners that have not had their snapshot yet. */
	readonly #unseen = new Set<(event: StateEvent<unknown>) => void>();

	// 构造只保存引用与成员名；不注册监听，直到第一次 subscribe/events 才 attach。
	constructor(view: RemoteRef, name: string) {
		this.view = view;
		this.#name = name;
	}

	// 读取当前值：视图已结束（released/gone）时抛终止错误，否则交给绑定 read，
	// 由绑定统一抛出 not_ready / not_in_variant。
	get value(): unknown {
		if (this.view.ended) throw this.view.terminalError();
		return this.view.binding.read(this.#name);
	}

	/** Not hydrated before the binding's first snapshots (a local object forwarding this member waits for them). */
	// HYDRATION 是 cell.ts 定义的特殊 symbol 键，供“本地对象把远程状态成员再暴露出去”时判断是否需要等待水合。
	// 返回 undefined 表示水合已完成（读取仍可能因 variant 不含该成员而抛 not_in_variant）；否则返回
	// { hydrated:false, whenHydrated }，让上层对象在激活前等待。这里是计算属性名 [HYDRATION]，TS 会用 symbol
	// 常量作为键类型；不产生字符串属性。
	get [HYDRATION](): Hydration | undefined {
		const binding = this.view.binding;
		if (binding.hydrated) return undefined;
		return { hydrated: false, whenHydrated: () => binding.whenHydrated() };
	}

	// 订阅最终值。先登记再 attach，避免在 attach 与初始交付之间漏掉同步事件；
	// 若此刻已可读则立即同步调用 listener（Readable 契约要求先给当前值），否则等后续 deliver。
	// 返回取消函数：只移除该 listener；当值和事件监听者都为空时解除对绑定的登记。
	subscribe(listener: (value: unknown) => void): () => void {
		this.#values.add(listener);
		this.#attach();
		if (this.#readable()) this.#safe(() => listener(this.view.binding.members.get(this.#name)?.value));
		return () => this.#remove(this.#values, listener);
	}

	// 订阅状态事件。与 subscribe 类似，但未可读时把 listener 放入 #unseen，等首个 reset/snap 时补发 snap。
	// 取消函数同时从 unseen 和 events 移除，再按需解除绑定登记。
	events(listener: (event: StateEvent<unknown>) => void): () => void {
		this.#events.add(listener);
		this.#attach();
		if (this.#readable()) {
			const value = this.view.binding.members.get(this.#name)?.value;
			this.#safe(() => listener({ type: "snap", value }));
		} else this.#unseen.add(listener);
		return () => {
			this.#unseen.delete(listener);
			this.#remove(this.#events, listener);
		};
	}

	// 绑定推送事件时调用。先处理事件监听者：unseen 中的监听者收到首个非 ops 事件时改发 snap；若首个事件是 ops，
	// 则只把它移出 unseen、本次不投递，之后作为已见监听者收到后续 reset/ops 事件。已见过的监听者收到原事件。
	// 再处理值监听者，统一交付 event.value。
	// 所有回调都经 #safe，单个监听器抛错不阻断其余投递。
	deliver(event: StateEvent<unknown>): void {
		for (const listener of [...this.#events]) {
			if (!this.#unseen.delete(listener)) this.#safe(() => listener(event));
			else if (event.type !== "ops") this.#safe(() => listener({ type: "snap", value: event.value }));
		}
		for (const listener of [...this.#values]) this.#safe(() => listener(event.value));
	}

	// 视图结束或 release 时清空所有监听并解除绑定登记；之后到达的事件不会再投递。
	stop(): void {
		this.#values.clear();
		this.#events.clear();
		this.#unseen.clear();
		this.view.binding.unlisten(this.#name, this);
	}

	// 当前是否可立即读取：视图未结束且绑定 readable（未结束、已水合、成员在当前 variant）。
	#readable(): boolean {
		return !this.view.ended && this.view.binding.readable(this.#name);
	}

	// 向绑定登记自己。已结束的视图不再登记，避免为死引用保留监听。
	#attach(): void {
		if (!this.view.ended) this.view.binding.listen(this.#name, this);
	}

	// 从给定集合移除一个 listener；若该成员已没有任何值/事件监听者，则解除绑定登记。
	// 泛型 T 让同一个辅助函数同时服务两种监听器类型，避免重复代码。
	#remove<T>(set: Set<T>, listener: T): void {
		set.delete(listener);
		if (this.#values.size + this.#events.size === 0) this.view.binding.unlisten(this.#name, this);
	}

	// 统一捕获监听器异常并交给宿主报告；监听器是用户代码，不能让一个异常破坏绑定状态机。
	#safe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.view.binding.host.report(error);
		}
	}
}

/**
 * A reference to an object on another host: a view onto the host's shared binding for its key. Each view has its own
 * owner, status, observers and `release`; ending by the provider and re-holding belong to the binding.
 */
// 远程对象的一个引用视图，实现 object.ts 的 RefCore，因此能像本地 RefImpl 一样交给 ctx.get / 对象层使用。
// 它不是绑定本身：多个 RemoteRef 可共享一个 RemoteBinding，各自 release 只移除自己的视图。
// proxy 是给用户/契约层使用的对象；对 proxy 的属性访问会转成 member(name)，而 RefBase 方法（status/onStatus/
// release 等）从本实例读取并绑定 this，保证解构后仍能正常工作。
export class RemoteRef implements RefCore {
	// RefCore 协议要求 object 字段；远端引用没有本地 ObjectImpl，按 RefCore 约定固定为 undefined。
	readonly object = undefined;
	// 共享绑定；引用状态的真正来源。release 后仍保留引用，但不再加入绑定。
	readonly binding: RemoteBinding;
	// 引用持有者：caller/object/host/client 等，决定 ctx 释放和清理策略；本文件只保存并传给宿主使用。
	readonly owner: RefOwner;
	/** False: a method-only view (`state: false`), ready once live. */
	// 是否需要状态：来自 GetOptions.state !== false。false 时 ready 只等 live，不等待水合；绑定的状态需求由所有视图汇总。
	readonly wantsState: boolean;
	// 对外暴露的 Proxy 对象；契约类型 Ref<C> 实际指向它。Proxy 只拦截 get，不拦截 set/枚举等。
	readonly proxy: object;
	// 首次就绪 Promise：live（状态视图还要求 hydrated）时 resolve；release/gone 时 reject。
	// 完成后 #settleReady 清空，后续状态变化只能靠 onStatus 观察，不能重复 await ready 当健康检查。
	readonly ready: Promise<void>;
	// 视图自己的状态，初始 loading；断线可 live → loading，release/gone 为终态。
	status: RefStatus = "loading";
	// 视图终止原因；仅 gone 时写入（released 由 terminalError 动态构造）。
	error: unknown;
	// onShape 监听者；#apply 后由 binding 调用 shapeChanged 逐个通知。
	readonly shapeListeners = new Set<(shape: Shape) => void>();
	// onStatus 监听者，交给 object.ts 的 notifyStatus 统一通知和捕获异常。
	readonly #statusListeners = new Set<StatusListener>();
	// 已创建的状态成员视图缓存；同一成员重复访问返回同一 Readable，避免重复登记监听。
	readonly #readables = new Map<string, ViewReadable>();
	// 已创建的方法调用器缓存；缓存的是闭包，重复取 ref.method 不会每次新建函数。
	readonly #callers = new Map<string, (...given: unknown[]) => Promise<unknown>>();
	// ready 的结算器；resolve/reject 后设为 undefined，防止二次结算。
	#settleReady: Settle | undefined;

	// 构造视图：保存绑定/持有者/状态需求，建立 ready deferred，并创建 Proxy。
	// Proxy 的 get 陷阱：
	// - REF_BASE 中的属性（RefBase 的 status/ready/onShape/onStatus/release 等）：从 target 读取，方法绑定 target，
	//   这样 const { release } = ref 后调用仍作用于本视图；
	// - 非字符串属性或 "then"：返回 undefined，避免 Promise 检查把引用当成 thenable；
	// - 其它字符串：按契约成员名解析成方法调用器或状态 Readable。
	// refsByProxy 记录 proxy → RemoteRef，供对象层通过 refOf 从 deps: [ref] 或 link 中的 proxy 找回运行时引用。
	constructor(binding: RemoteBinding, owner: RefOwner, wantsState: boolean) {
		this.binding = binding;
		this.owner = owner;
		this.wantsState = wantsState;
		const ready = deferred();
		this.ready = ready.promise;
		this.#settleReady = ready;
		this.proxy = new Proxy(this, {
			get: (target, property) => {
				if (REF_BASE.has(property)) {
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				if (typeof property !== "string" || property === "then") return undefined;
				return target.member(property);
			},
		});
		refsByProxy.set(this.proxy, this);
	}

	// 消费方契约，来自共享绑定；同一绑定的所有视图看到同一契约。
	get contract(): AnyContract {
		return this.binding.contract;
	}

	// 引用地址：直接复用绑定 key，用于日志、错误和引用标识。
	get address(): string {
		return this.binding.key;
	}

	// 终态判断：released 和 gone 都不可再使用；loading/live 仍可能变化。
	get ended(): boolean {
		return this.status === "released" || this.status === "gone";
	}

	// 当前 variant；未应用 shape 时为 undefined。转发绑定的 shape，引用自己不缓存 variant。
	get variant(): string | undefined {
		return this.binding.shape?.variant;
	}

	// 当前形状对象；与 variant 一样来自绑定。返回的是同一个对象引用，调用方不应修改。
	get shape(): Shape | undefined {
		return this.binding.shape;
	}

	// 订阅形状变化。注册时不会立即补发已有形状（RefBase 契约如此）；返回取消函数。
	// 与 RefImpl 不同，这里的通知是同步的，异常由 shapeChanged 捕获并交给宿主报告。
	onShape(listener: (shape: Shape) => void): () => void {
		this.shapeListeners.add(listener);
		return () => this.shapeListeners.delete(listener);
	}

	// 订阅状态变化；返回取消函数。事件只在 status 实际改变时发出，不会因 update 的重复计算而重复通知；
	// 通知经 notifyStatus 排入发布队列，是异步投递。
	onStatus(listener: StatusListener): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	// 终止错误：gone 用保存的原因；released（或其它非 gone 终态）构造 released 错误。
	// 与绑定 terminalError 不同，这里不读取 binding.error，因为视图可能先于绑定结束。
	terminalError(): unknown {
		return this.status === "gone" ? this.error : new ChordError("released", `reference ${this.address} released`);
	}

	// 主动释放视图：标记 released、通知监听者、拒绝未完成的 ready、停止该视图创建的所有成员监听，
	// 最后从绑定移除视图（可能触发宿主的 linger/close）。已结束则直接返回，幂等。
	release(): void {
		if (this.ended) return;
		this.status = "released";
		this.#notify();
		this.#settleReady?.reject(new ChordError("released", `reference ${this.address} released`));
		this.#settleReady = undefined;
		for (const readable of this.#readables.values()) readable.stop();
		this.binding.removeView(this);
	}

	// ─── driven by the binding ───

	/** Follows the binding: live once it has a shape (and, for a state view, its state) over a current hold. */
	// 由绑定在 addView/#apply/detached/#syncState 时调用，把绑定状态投影成视图状态。
	// 视图 live 的条件：绑定 live、有当前 hold，且（方法视图或绑定已水合）。
	// 已结束的视图不再变化；状态未变时不重复通知。首次变为 live 时 resolve ready 并清空结算器。
	update(): void {
		if (this.ended) return;
		const binding = this.binding;
		const live = binding.status === "live" && binding.hold !== undefined && (!this.wantsState || binding.hydrated);
		const next: RefStatus = live ? "live" : "loading";
		if (next === this.status) return;
		this.status = next;
		this.#notify();
		if (live) {
			this.#settleReady?.resolve();
			this.#settleReady = undefined;
		}
	}

	// 由绑定结束视图：error.code === "released" 视为主动释放，否则 gone 并保存原因。
	// 无论是哪种，都通知监听者、reject ready、停止成员监听。已结束幂等。
	end(error: unknown): void {
		if (this.ended) return;
		const released = error instanceof ChordError && error.code === "released";
		this.status = released ? "released" : "gone";
		if (!released) this.error = error;
		this.#notify();
		this.#settleReady?.reject(error);
		this.#settleReady = undefined;
		for (const readable of this.#readables.values()) readable.stop();
	}

	// 通知该视图的所有 onShape 监听者。只读取绑定 shape，不检查 variant 是否真的变化；由 #apply 在应用后调用一次。
	// 逐个 try/catch：监听器是用户代码，异常只报告给宿主，继续通知其余监听者。
	// 遍历副本，允许监听器在回调中取消订阅。
	shapeChanged(): void {
		const shape = this.binding.shape;
		if (shape === undefined || this.ended) return;
		for (const listener of [...this.shapeListeners]) {
			try {
				listener(shape);
			} catch (error) {
				this.binding.host.report(error);
			}
		}
	}

	// 统一通知状态监听者；notifyStatus 负责复制集合并捕获每个监听器的异常。报告函数交给宿主。
	#notify(): void {
		notifyStatus(this.#statusListeners, this.status, this.error, (error) => this.binding.host.report(error));
	}

	// ─── members ───

	// 把属性名解析为契约成员。搜索所有 variant（不是只搜索当前 variant），因为调用方可能在引用切换 variant 之前
	// 就缓存了方法；真正调用/读取时仍会按当前 variant 检查并可能抛 not_in_variant。
	// - method：返回缓存的调用器；
	// - state：返回缓存的 ViewReadable；
	// - 未知成员：undefined（读取属性得到 undefined，而不是抛错）。
	member(name: string): unknown {
		const description = Object.values(this.contract.description.variants)
			.map((members) => members[name])
			.find((member) => member !== undefined);
		if (description?.kind === "method") return this.#caller(name);
		if (description?.kind === "state") {
			let readable = this.#readables.get(name);
			if (readable === undefined) {
				readable = new ViewReadable(this, name);
				this.#readables.set(name, readable);
			}
			return readable;
		}
		return undefined;
	}

	// 创建（并缓存）一个方法调用器。返回的闭包把用户调用参数与 ctx 分开：
	// - Contract.method 生成的无参方法签名是 (ctx?) => Promise，因此 noArgs 时第一个实参是 ctx；
	// - 有参方法的签名是 (args, ctx?)，因此解构出 args 与 ctx。
	// 校验顺序：
	// 1. 在对象工厂内禁止远程调用（not_ready），避免工厂执行期间产生不可控的嵌套根；
	// 2. ctx 若存在必须是 CtxImpl（invalid/foreign_ctx），防止外部伪造的 ctx 把 root 带到别的宿主；
	// 3. ctx.check(host) 由 CtxImpl 校验 root 所属宿主与 codeVersion；
	// 4. 没有 ctx 或 ctx.holder（任务等 code holder，每次调用应开新根）时，用 host.root 新建短调用树；
	//    否则直接复用调用方的 ctx，使嵌套远程调用共享 rootId/codeVersion。
	// 错误路径：同步校验失败会 throw（工厂内）或返回 rejected Promise；真正的调用错误来自 binding.call。
	#caller(name: string): (...given: unknown[]) => Promise<unknown> {
		let caller = this.#callers.get(name);
		if (caller === undefined) {
			const noArgs = takesNoArgs(this.contract, name);
			caller = (...given) => {
				// A method without arguments is called as `ref.name(ctx)`.
				const [args, ctx] = (noArgs ? [undefined, given[0]] : given) as [unknown, Ctx | undefined];
				const host = this.binding.host;
				if (host.inFactory > 0)
					throw new ChordError("not_ready", `${this.address}.${name} called inside a factory`);
				// The same checks as a local reference's caller (RefImpl.caller and ObjectImpl.call): a ctx from another host
				// or one not made by Chord would carry a root this host does not own over its link.
				if (ctx !== undefined && !(ctx instanceof CtxImpl)) {
					return Promise.reject(invalid("foreign_ctx", "ctx must come from a Chord host"));
				}
				try {
					ctx?.check(host);
				} catch (error) {
					return Promise.reject(error);
				}
				if (ctx === undefined || ctx.holder) {
					return host.root((root) => this.#call(name, args, root), { signal: ctx?.signal });
				}
				return this.#call(name, args, ctx);
			};
			this.#callers.set(name, caller);
		}
		return caller;
	}

	// 最终调用入口：先检查视图是否已结束，然后交给共享绑定，由绑定等待 hold/水合并经链路发送。
	// 返回 Promise 而不是同步值；错误（not_in_variant、取消、对端错误）都体现在拒绝上。
	#call(name: string, args: unknown, ctx: Ctx): Promise<unknown> {
		if (this.ended) return Promise.reject(this.terminalError());
		return this.binding.call(name, args, ctx);
	}
}
