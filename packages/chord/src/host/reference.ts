// References (§7): what `get` and `hold` return, a plain object built from the contract's members, and its binding to
// the object: counted as a reference, it follows the object's state, parks calls while loading, keeps the
// per-reference watches and is released once. A binding whose object a reload removed, or whose version it no longer
// binds, waits unbound and binds again (slice 7b §6); one of an older version reads adapted members (Q10).
// 所属模块：packages/chord/src/host 的引用与绑定层（§7、slice 7b §6、Q10）。
// 上下游：Host.get/hold 与 ctx.get 创建 Binding；Target（本地 ChordObject 或远端 RemoteObject）提供状态与成员；
//   下游依赖 ReferenceSource（成员转接）、ReferenceKeys（键 pin）、ParkedCalls（加载期调用）与 ReferenceState（ref.state）。
// 结果：返回由契约成员组成的普通对象，读取走成员 getter/方法，方法返回 Promise；错误为 ChordError（not_ready/failed/released）。
// 能力清单：
// - Reference / Held / RefIn / InVariants / Lifecycle：引用的编译期形状（本地成员 + state/retry/release；远端按 variant 收窄）。
// - Target：绑定目标接口，描述状态、成员、调用与 pin。
// - Followed / Attachable / RetryWalk / retryWalk：目标当前跟随内容与重试遍历。
// - CheckedParams：已校验参数与身份 key。
// - Binding：引用核心，管理 BindingState、members、watches、parked calls 与释放。
// - ReferenceMember / ReferenceKeyed / KeyedMemberAt：状态成员、键ed 成员与 at(key) 句柄。
// - resolveKeyed / resolveWatchable / place：把句柄解析成内部源，并把它放到目标当前值上。
// 组合关系：new Binding -> bind(target) -> retarget/place 成员 -> 调用 #call/#send 或等待 #until -> release/end。
// 示例：const ref = await ctx.get(Notes, { id: "a" }); ref.state.value; ref.title.value;
//   await ref.add({ text: "x" }, ctx); ref.release();
// 阅读顺序：先 Reference/Held/Lifecycle/Target/Followed 类型，再 Binding 的构造与 bind/retarget/removed；
//   随后 #call/#send/#until 与 release/end；最后读三个成员句柄类和 place/resolve 辅助函数。

import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import type { Contract, Implementation, ParamsOf } from "../contracts/index.ts";
import {
	type CurrentVariants,
	currentVariants,
	LOCAL,
	type MethodData,
	type ShapeOf,
	takesNoArgs,
	type VariantImplementation,
} from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { Keyed, type KeyedSlot, type SealToken, Singleton } from "../documents/internal.ts";
import type { JsonValue } from "../json.ts";
import { RETRY_HOPS } from "../link/internal.ts";
import { type Batch, Constant, type DeriveSource, Source } from "../state/internal.ts";
import type { NativeWatchable, Watch, Watchable } from "../watch.ts";
import type { PinnedKey } from "./attempt.ts";
import { type Caller, withLinkedAbortSignal } from "./ctx.ts";
import type { KeyedBinding } from "./members.ts";
import type { ChordObject, Holder, Removal } from "./object.ts";
import { ParkedCalls } from "./parked.ts";
import { type Ended, type Failed, LOADING, ReferenceState, type RefState } from "./ref-state.ts";
import { ReferenceKeys } from "./reference-keys.ts";
import { ReferenceSource } from "./reference-source.ts";
import type { UnboundRequest } from "./unbound.ts";

/**
 * A reference: a local contract's members, or for a remote contract the members of the variant its object chose,
 * narrowed by `variant`; and its state, `retry()` and `release()`. Every use after release throws.
 */
// 条件类型：ShapeOf<C>["kind"] 在编译期决定本地还是远端形状；本地是成员实现加生命周期，远端是所有 variant 的联合。
// 远端首次绑定前 variant 为 undefined，因此 InVariants 的 Unbound 参数是 never（此时还拿不到 Reference，只能拿 Held）。
export type Reference<C extends Contract> = ShapeOf<C>["kind"] extends "local"
	? Implementation<C> & Lifecycle
	: InVariants<C, never>;

/** What `host.hold` returns: a reference whose `variant` is `undefined` until its first binding. */
// 与 Reference 相同，但远端 variant 额外允许 undefined；读取成员前需等待首次绑定。
export type Held<C extends Contract> = ShapeOf<C>["kind"] extends "local"
	? Implementation<C> & Lifecycle
	: InVariants<C, undefined>;

/** A remote reference narrowed to some of its variants. */
// Extract 从远端的 variant 联合中只留下 variant 恰好为 V 的分支，供类型收窄使用。
export type RefIn<C extends Contract, V extends string> = Extract<Reference<C>, { readonly variant: V }>;

/** One member of a remote reference's union per variant; `Unbound` is what `variant` may also be. */
// 映射类型：对每个 variant V 生成“variant 字段 + 该变体实现 + 生命周期”，再用索引访问合并成联合。
// 这是纯编译期计算，不产生运行时对象。
type InVariants<C extends Contract, Unbound> = {
	[V in keyof CurrentVariants<C>]: { readonly variant: V | Unbound } & VariantImplementation<CurrentVariants<C>[V]> &
		Lifecycle;
}[keyof CurrentVariants<C>];

/** What every reference has besides its members. */
// 生命周期字段由 Binding 以 getter/方法实现；远端 variant 也是运行时 getter。
type Lifecycle = {
	/** The reference's state: loading, live, failed or released; watches get every change. */
	readonly state: NativeWatchable<RefState>;
	/**
	 * Asks a failed object for an attempt now (the backoff skipped, a broken one renewed); an object parked on failed
	 * dependencies passes it on to them, once; otherwise nothing.
	 */
	retry(): void;
	release(): void;
};

/**
 * What a binding is bound to: an object on this host (`ChordObject`), or an object held over a path, the parent link
 * or a route address (`RemoteObject`). It tells its holders of each change of `state`.
 */
// 绑定目标接口：Binding 只依赖这些成员，不关心目标是本地对象还是远端对象。
// 所有方法都是运行时实现，类型只描述契约；lastFailure/variant 等字段由目标维护。
export interface Target {
	/** The object in errors: its type, and its params key when it has params. */
	readonly label: string;
	/** Its state as its references show it. */
	readonly state: RefState;
	/** Whether its state members have values: live once, for a remote object bound once. */
	readonly hydrated: boolean;
	/** The variant bound last; `undefined` for a local object and before the first binding. */
	readonly variant: string | undefined;
	/** The error of its last failure (an attempt's, or the dependencies it is parked on) while none went live since. */
	readonly lastFailure: ChordError | undefined;
	/** Its instance id while it activates on this host (Q5); `undefined` otherwise and over a link. */
	readonly activationId: string | undefined;
	/**
	 * Whether it holds up this host's start barrier: an object here without its first outcome (decision (a)); a remote
	 * object never does.
	 */
	readonly blocksFirstPass: boolean;
	/** Counts `binding` as a reference; the binding reads `state` itself. */
	hold(binding: Binding): void;
	/** `binding` was released. */
	unhold(binding: Binding): void;
	/** Calls a method of the live object for `caller`, bound at `version` (an older one is mapped, Q10). */
	call(method: string, args: unknown, context: Context, caller: Caller, version: number): Promise<unknown>;
	/**
	 * What a reference of `version` follows for state member `member` now (decision "References are the only
	 * indirection"): the live instance's member (a replica over a link), or nothing (`loading`, or `failed` with the
	 * cause's error), with the member a reference takes its last value from.
	 */
	followed(member: string, version: number): Followed;
	/** The instance its references follow now (they attach to it); `undefined` once it stopped changing. */
	readonly attachable: Attachable | undefined;
	/** Its live instance (a reference's keys pin there; a new one, they pin again); `undefined` when not live. */
	readonly instance: unknown;
	/** The keyed member `member` of the live object: its ultimate slot (slice 6a §12; only local objects have any). */
	keyedMember(member: string): KeyedSlot;
	/**
	 * How a consumer of `version` reads keyed member `member`'s documents: mapped back to its version when older
	 * (slice 7b §7), `undefined` when as they are; `contract_mismatch` when the provider refuses it.
	 */
	keyedMapping(member: string, version: number): ((current: JsonValue) => JsonValue) | undefined;
	/**
	 * Pins `key` of keyed member `member` on the live instance, loaded, as a consumer of `version` reads it (mapped when
	 * older); only a live local object has keyed members.
	 */
	pinKey(member: string, key: string, version: number, context: Context): Promise<PinnedKey>;
	/**
	 * `ref.retry()`, as one step of `walk`: an attempt now if failed; an object parked on failed dependencies passes it
	 * on; ignored otherwise.
	 */
	retry(walk: RetryWalk): void;
	/**
	 * The chain of activation waits from this object to `target`, both included (Q5); `undefined` when there is none.
	 * `visited` keeps a search over shared dependencies linear in the waits.
	 */
	pathTo(target: ChordObject, visited: Set<Target>): ChordObject[] | undefined;
}

/** An instance a reference attaches to (`Target.attachable`): it keeps last values in that instance's variant. */
// 只保留 variant 字符串；attachable 变化即表示目标换了实例，成员需迁移。
export type Attachable = { readonly variant: string | undefined };

/**
 * What a reference follows of its target for one state member (`Target.followed`): the member of the instance it
 * follows (`instance`, still changing), a member its live variant lacks (`invalid/member`), or nothing: its target loads
 * (no call) or failed (one `failed` call with the cause's error); `last` is the member of `instance`, which stopped
 * changing, that a reference attached to it takes a last value from (never one it never attached to).
 */
// four-way 判别联合：live 直接跟随；lacking 成员不存在；loading 目标未就绪；failed 目标失败。
// last 只在 loading/failed 出现，且仅当引用确实接过该实例时才可用（place 会再检查 instance === attached）。
export type Followed =
	| { readonly kind: "live"; readonly source: DeriveSource; readonly instance: unknown }
	| { readonly kind: "lacking"; readonly error: ChordError }
	| { readonly kind: "loading"; readonly last: DeriveSource | undefined; readonly instance: unknown }
	| {
			readonly kind: "failed";
			readonly error: ChordError;
			readonly last: DeriveSource | undefined;
			readonly instance: unknown;
	  };

/**
 * One retry's walk through parked objects on this host (dependency model §3.7, audit A5): the objects it reached (one
 * reached again, through a diamond, ignores it) and the hop budget a `retry` message to another host carries (none is
 * sent at 0, so a waiting ring of hosts stops).
 */
// visited 记录本次遍历到过的对象，防止菱形依赖或环导致重复/无限遍历；hops 是还能跨宿主转发几次。
export type RetryWalk = { readonly visited: Set<ChordObject>; readonly hops: number };

/** A walk starting here: `ref.retry()`'s, with the first host's budget, or a `retry` message's, with one hop less. */
// 默认参数在调用方省略时生效；返回新 Set，绝不共享上一次遍历。
// 示例：retryWalk() 得到 { visited: new Set(), hops: RETRY_HOPS }；跨宿主消息用 retryWalk(hops - 1)。
export function retryWalk(hops = RETRY_HOPS): RetryWalk {
	return { visited: new Set(), hops };
}

/** A reference's params as L1 checked them, with their identity key. */
// key 是规范化后的身份字符串（通常来自参数 JSON），用于在宿主中复用同一对象的绑定；params 已通过运行时校验。
export type CheckedParams = { readonly params: ParamsOf<Contract>; readonly key: string };

/**
 * Where a binding stands. `unbound`: waiting for its object's activation to bind it (a `self.get`); `waiting`: in the
 * host's unbound index, `place` checking it again when woken: before the publication (no `failure`: `loading`), or after
 * a check that found no fitting provider (`failed { waiting }`, `not_served` or `version`); `refused`: a broken refusal
 * (a `hostAddress` or `authorize` that threw or refused) until `ref.retry()` places it again; a released binding keeps
 * nothing but its name and its end (`ref.state`'s `ended`). `dependent` is the object whose attempt declared the
 * reference with `self.get`, `undefined` for `host.get`, `host.hold` and `ctx.get`.
 */
// 绑定状态机：unbound -> bound；unbound -> waiting -> (wake) unbound；unbound -> refused -> (retry) unbound；
// 任意状态 -> released（终态）。batch 用于把成员迁移/失败通知合并为一次发布。
type BindingState =
	| {
			readonly kind: "unbound";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
	  }
	| {
			readonly kind: "bound";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
			readonly target: Target;
	  }
	| {
			readonly kind: "waiting";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
			readonly failure: Failed | undefined;
			readonly place: () => void;
			/** Takes it out of the index (it ended). */
			readonly leave: () => void;
	  }
	| {
			readonly kind: "refused";
			readonly batch: Batch;
			readonly dependent: ChordObject | undefined;
			readonly failure: Failed;
			readonly bind: () => void;
	  }
	| { readonly kind: "released"; readonly state: Ended };

/** What a wait for a state decides at each change. */
// 返回 wait 表示继续等；done 表示兑现；failed 带错误拒绝。
type Decision =
	| { readonly kind: "wait" }
	| { readonly kind: "done" }
	| { readonly kind: "failed"; readonly error: unknown };

const WAIT: Decision = { kind: "wait" };

const DONE: Decision = { kind: "done" };

/** A wait for a state: checked at every change, rejected with the reference's end. */
// check 在每次状态迁移时运行；end 由 Binding.end 调用，保证等待者不会永久悬挂。
type Waiter = { readonly check: () => void; readonly end: (error: ChordError) => void };

/**
 * A reference's binding to its object: counted by the object as one of its references while bound, and told of each
 * change of its state. Calls run while live, park while loading (sent in order once live) and reject while failed.
 * Released, or ended with its object, it ends the watches taken through it and rejects the calls made through it.
 */
// 引用绑定：实现 Holder（目标统计引用数）与 UnboundRequest（索引可在唤醒/撤权时调用）。
// 状态迁移会影响 ref.state 的 watch、成员源、等待者、parked 调用与声明它的对象。
export class Binding implements Holder, UnboundRequest {
	readonly reference: Reference<Contract>;
	/** Who calls through this reference: the principal it was got as, and this host's incarnation. */
	// caller 在构造后不变；远程调用与错误报告都使用这一身份。
	readonly caller: Caller;
	/** The contract's name, for errors. */
	// 只保存名称，避免释放后继续持有契约对象；错误消息在释放后仍可读。
	readonly #name: string;
	/** The consumer's contract (its version is the binding's) until the reference is released (it keeps none then). */
	// 释放时清空，防止引用长期保留契约与插件代码；未释放时 getter 用 ! 断言其存在。
	#contract: Contract | undefined;
	/** How long a call made while loading waits: the reference's `readyTimeout`. */
	// ParkedCalls 用该毫秒数限制加载期调用等待，超时以 not_ready 拒绝。
	readonly #parkTimeout: number;
	// 当前绑定状态；所有状态迁移都替换整个对象，便于 switch 收窄。
	#state: BindingState;
	// 通过本引用打开的 watch；引用结束时统一 end，集合在 closed 后移除。
	readonly #watches = new Set<Watch<JsonValue>>();
	/**
	 * Aborted when the reference ends: its calls' callers are rejected and their handlers' contexts aborted. Made by the
	 * first call and dropped at the end, so a released reference keeps no error (whose stack keeps its frames).
	 */
	// 调用方取消链接：引用结束时 abort 所有进行中的调用；释放后清空以打断帧引用。
	#calls: AbortController | undefined;
	/** Calls made while loading; made by the first. */
	// 加载阶段的调用排队；变 live 时按顺序 flush，失败时统一 reject。
	#parked: ParkedCalls | undefined;
	/** Waits for a state (getters, member watches before the first binding); each checks the state at every change. */
	// 等待者集合在每次 moved/end 时遍历检查；副本遍历允许 check 自己移除。
	readonly #waiters = new Set<Waiter>();
	/** `ref.state`, made on first access. */
	// 懒创建，避免不读 state 的引用分配额外对象。
	#refState: ReferenceState | undefined;
	/** The keys its object's factory pinned with `ref.member.at(key)`: pinned once bound, released with it. */
	// 工厂内声明的 at(key) 句柄；绑定后统一 pin，引用结束时统一 release。
	readonly #ats: KeyedMemberAt[] = [];
	/** Its state members as consumers follow them (`ReferenceSource`), by name; each made by its first use. */
	// 只有被读取过的成员才创建转接源，未使用成员不产生运行时开销。
	#sources: Map<string, ReferenceSource> | undefined;
	/** The keys of its object's keyed members it holds (key watches, `at(key)` pins); made by the first. */
	// 键集合管理器按引用惰性创建，负责跨实例重新 pin。
	#heldKeys: ReferenceKeys | undefined;
	/** The instance it attached to last: it takes last values only from that one (never one it never followed). */
	// 用于区分“曾经跟随过的实例”和“从未接过的实例”，后者不得拿 last 值。
	#attached: Attachable | undefined;

	constructor(
		contract: Contract,
		batch: Batch,
		dependent: ChordObject | undefined,
		caller: Caller,
		parkTimeout: number,
	) {
		// 构造只建立引用对象与初始 unbound 状态，不触发绑定。
		this.#name = contract.name;
		this.#contract = contract;
		this.caller = caller;
		this.#parkTimeout = parkTimeout;
		this.#state = { kind: "unbound", batch, dependent };
		const reference: Record<string, unknown> = { release: () => this.release(), retry: () => this.retry() };
		// defineProperty 定义 getter，使 ref.state 每次读取都反映当前状态；enumerable 让调试/序列化可见。
		Object.defineProperty(reference, "state", { get: () => this.#watchableState(), enumerable: true });
		// Every member of every variant (one kind and signature per name, D11); the bound variant decides which work.
		const methods = new Map<string, MethodData>();
		// 遍历所有变体：同名成员只保留一个方法签名（D11），运行时由绑定变体决定其行为。
		for (const variant of currentVariants(contract).values()) {
			for (const member of variant.state.keys()) reference[member] = new ReferenceMember(this, member);
			for (const member of variant.keyed.keys()) reference[member] = new ReferenceKeyed(this, member);
			for (const [member, method] of variant.methods) methods.set(member, method);
		}
		for (const [member, method] of methods) {
			// A method without arguments omits them; `null` is their internal and wire form.
			// 三元表达式按签名生成不同 arity 的 async 函数；两者最终都走 #call，参数 null 表示无参。
			reference[member] = takesNoArgs(method)
				? async (context: Context) => this.#call(member, null, context)
				: async (args: unknown, context: Context) => this.#call(member, args, context);
		}
		if (contract.kind === "remote") {
			// variant 是运行时 getter；释放后读取会抛 released，而不是返回 undefined。
			Object.defineProperty(reference, "variant", { get: () => this.#variant(), enumerable: true });
		}
		// Built from the contract's own member lists.
		// as 断言把动态构造的对象标成契约实现；成员集合来自契约数据，运行时不额外检查。
		this.reference = reference as Reference<Contract>;
	}

	/** The consumer's contract: its version is the binding's. Only an unreleased binding is asked. */
	// 返回调用方契约；! 依赖释放后调用方不再读取该 getter 的内部约定。
	get contract(): Contract {
		return this.#contract!;
	}

	/** The object whose attempt declared this reference, until it is released. */
	// 释放后返回 undefined；否则取状态中的 dependent（等待/拒绝/绑定状态都保存它）。
	get dependent(): ChordObject | undefined {
		const state = this.#state;
		return state.kind === "released" ? undefined : state.dependent;
	}

	/** Whom it acts for (the unbound index's revocation). */
	// 匿名身份为 undefined；索引撤权时会跳过这种请求。
	get principal(): Principal | undefined {
		return this.caller.principal;
	}

	/** The reference's state. */
	// 把内部 BindingState 映射成外部 RefState：绑定取目标状态；等待取失败或 LOADING；拒绝取失败；unbound 是 LOADING；释放取 ended。
	get refState(): RefState {
		const state = this.#state;
		if (state.kind === "bound") return state.target.state;
		if (state.kind === "waiting") return state.failure ?? LOADING;
		if (state.kind === "refused") return state.failure;
		return state.kind === "unbound" ? LOADING : state.state;
	}

	/** The object it is bound to; `undefined` while it is not bound. */
	// 只有 bound 状态有 target；等待/拒绝时目标尚未确定。
	get target(): Target | undefined {
		return this.#state.kind === "bound" ? this.#state.target : undefined;
	}

	/** The object in errors: its label once bound, else the contract's name. */
	get label(): string {
		return this.#state.kind === "bound" ? this.#state.target.label : this.#name;
	}

	/** The error of the object's last failure while none went live since, or of the check that left it unbound. */
	// 按状态取不同来源：拒绝/等待取 failure.cause.error；绑定取目标的 lastFailure；其他 undefined。
	get lastFailure(): ChordError | undefined {
		const state = this.#state;
		if (state.kind === "refused") return state.failure.cause.error;
		if (state.kind === "waiting") return state.failure?.cause.error;
		return state.kind === "bound" ? state.target.lastFailure : undefined;
	}

	/**
	 * Binds to `target`, which counts this binding as a reference; its members and keys follow what `target` shows now
	 * (one frame from their last values), and the reference takes its state.
	 */
	// 把 unbound 引用绑到目标。输入 target；无返回，副作用是计数、迁移成员并改变 ref.state。
	// 只有 unbound 状态能绑定；waiting/refused 需先 wake/retry。示例：binding.bind(objectTarget)。
	bind(target: Target): void {
		const state = this.#state;
		// 非 unbound 的重复绑定被忽略；例如唤醒检查与新激活可能竞争。
		if (state.kind !== "unbound") return;
		this.#state = { kind: "bound", batch: state.batch, dependent: state.dependent, target };
		target.hold(this);
		// `hold` may release it at once (a presence derive): `retarget` sees that. A batch only when members move.
		// 有成员/键被使用时，迁移可能发送多帧，需在批次内完成；否则直接迁移即可。
		if (this.following) state.batch.within(() => this.retarget(), BACKGROUND_CONTEXT);
		else this.retarget();
		this.moved();
	}

	/** Whether its members or keys were used: `retarget` moves them (in a batch). */
	// 只检查惰性集合是否创建；没有任何成员/键使用时，重绑无需批次。
	get following(): boolean {
		return this.#sources !== undefined || this.#heldKeys !== undefined;
	}

	/**
	 * Inside a batch when `following`: its members and keys follow what its object shows now (`Target.followed`): the live instance's
	 * members (moved there, one frame each), or their last values (one `failed` call for a failure). The first time it
	 * points at nothing, every member of its version gets its last value, read or not.
	 */
	// 把成员转接源移动到目标当前状态。无返回；副作用：绑定/保留值/失败通知，keys 也跟随。
	// 示例：目标从 live 变 loading 时，成员保留最后值；换实例时 attachable 改变并触发迁移。
	retarget(): void {
		const state = this.#state;
		// 只有已绑定状态有目标；等待/释放时无需迁移。
		if (state.kind !== "bound") return;
		const { target } = state;
		const { version } = this.contract;
		const attachable = target.attachable;
		// attachable 存在表示目标当前有可跟随实例；记录它，供成员保留最后值。
		if (attachable !== undefined) this.#attached = attachable;
		// Detaching from an instance it attached to: every member keeps its last value (none before it ever attached).
		// 目标离开实例时，为契约版本的所有成员补建源，即使从未被读取过，以保证断开后仍有最后值。
		else if (this.#attached !== undefined) this.#keepAll(this.#attached);
		const attached = this.#attached;
		// 对每个已创建的成员源执行 place，参数是目标当前跟随的内容和旧实例标记。
		for (const [member, source] of this.#sources ?? []) place(source, target.followed(member, version), attached);
		// Its last values taken: it keeps no node of that instance (GC).
		// 保留值后清除 attached，防止 ReferenceSource 继续持有旧实例内部的节点。
		if (attachable === undefined) this.#attached = undefined;
		this.#heldKeys?.follow(BACKGROUND_CONTEXT);
	}

	/**
	 * Its object left it (slice 7b §6): its type was removed, or its provider no longer binds its version. The request
	 * waits unbound with `removal.cause` in the host's index, its members and keys keeping their last values (taken from
	 * the instance it leaves; one `failed` call), and binds again, by name, when a publication serves it: its members
	 * move to the next object's instance and its keys pin there again (one frame each); parked calls flush or reject;
	 * presence lists it again.
	 */
	// 对象因重载被移除时调用：成员保留最后值、发送失败帧，随后回到 unbound 并重新等待。
	// 无返回；副作用：批次内通知、解除 attached、加入宿主 unbound 索引。示例见重载流程。
	removed(removal: Removal): void {
		const state = this.#state;
		if (state.kind !== "bound") return;
		const { error } = removal.cause;
		state.batch.within(() => {
			// Its last values from the instance it attached to (one refused at its binding attached to none).
			// 先保存旧实例的最后值，再把失败发给每个成员源与键集合；两者在同一批次内发布。
			if (this.#attached !== undefined) this.#keepAll(this.#attached);
			for (const source of this.#sources?.values() ?? []) source.fail(error, BACKGROUND_CONTEXT);
			this.#heldKeys?.fail(error, BACKGROUND_CONTEXT);
		}, BACKGROUND_CONTEXT);
		// Its last values taken: it keeps no node of that instance (GC).
		this.#attached = undefined;
		// 回到 unbound；rewait 会把请求登记到宿主索引，等待下一次发布按名称重新绑定。
		this.#state = { kind: "unbound", batch: state.batch, dependent: state.dependent };
		removal.host.rewait(this, this.contract, removal.params, removal.cause, removal.context);
	}

	/**
	 * Every state member of its version, in the variant of the instance it attached to (its object may be live no more),
	 * gets a source, read or not, so each keeps a last value while it points at nothing (no-op for one already made).
	 */
	// 为某实例变体的所有状态成员创建 ReferenceSource；无返回。已存在的源直接复用。
	#keepAll(attached: Attachable): void {
		const variant = currentVariants(this.contract).get(attached.variant ?? LOCAL);
		for (const member of variant?.state.keys() ?? []) this.#memberSource(member);
	}

	/**
	 * Leaves the reference unbound in the host's unbound index (`leave` takes it out): `loading` before the publication
	 * (no `cause`), else `failed` with `cause` (`waiting`); `place` checks it again when the index wakes it.
	 */
	// 把 unbound 引用放入宿主等待索引。输入失败原因、重新检查函数和离队函数；无返回。
	// cause 为 undefined 表示首次发布前 waiting（外部看 loading）；否则 failed { waiting }。
	wait(cause: FailureCause | undefined, place: () => void, leave: () => void): void {
		const state = this.#state;
		// 只有 unbound 可进入 waiting；重复/迟到调用忽略。
		if (state.kind !== "unbound") return;
		// Kept while it waits: its stack made text now, so it keeps none of the frames' objects (an ended instance's).
		if (cause !== undefined) void cause.error.stack;
		const failure: Failed | undefined =
			cause === undefined ? undefined : { kind: "failed", cause, retryAt: undefined };
		const { batch, dependent } = state;
		this.#state = { kind: "waiting", batch, dependent, failure, place, leave };
		// Unchanged while loading: nothing to tell.
		// 失败原因才对外可见；首次发布前的等待保持 loading，不触发监听帧。
		if (failure !== undefined) this.moved();
	}

	/** Woken by the unbound index (out of it already): checked again where it goes. */
	// 索引唤醒回调：先回到 unbound 再调用 place 重新检查，避免检查中再次被加入索引。
	wake(): void {
		const state = this.#state;
		if (state.kind !== "waiting") return;
		const { batch, dependent } = state;
		this.#state = { kind: "unbound", batch, dependent };
		state.place();
	}

	/**
	 * A reference that cannot be bound (where it goes refused it): failed broken with `cause` until `ref.retry()` runs
	 * `bind` again (a route's `authorize` may admit it later).
	 */
	// 绑定路径明确拒绝（如 hostAddress/authorize 抛错或拒绝）时进入 refused。无返回，直到 ref.retry。
	// 与 waiting 不同，refused 不会自动被发布唤醒。
	refuse(cause: FailureCause, bind: () => void): void {
		const state = this.#state;
		if (state.kind !== "unbound") return;
		const failure: Failed = { kind: "failed", cause, retryAt: undefined };
		this.#state = { kind: "refused", batch: state.batch, dependent: state.dependent, failure, bind };
		this.moved();
	}

	/**
	 * The state may have changed: `ref.state`'s watches are told; live sends the parked calls in order, failed
	 * rejects them with the cause; waits for a state decide; the object whose attempt declared it re-evaluates.
	 */
	// 状态迁移后的统一通知：刷新 ref.state、处理 parked 调用、检查等待者、通知声明对象。
	// 无返回值；各个下游自行决定是否需要批次。
	moved(): void {
		this.#refState?.moved();
		const state = this.refState;
		if (state.kind === "live") {
			// flush 逐条发送排队调用；第二个回调在每次发送前确认仍 live，避免中途失败后继续发送。
			this.#parked?.flush(
				(method, args, context) => this.#send(method, args, context),
				() => this.refState.kind === "live",
			);
		} else if (state.kind === "failed") {
			this.#parked?.reject(state.cause.error);
		}
		for (const waiter of [...this.#waiters]) waiter.check();
		// dependencyMoved 让声明该引用的对象重新评估自己是否还能激活/保持 live。
		this.dependent?.dependencyMoved();
	}

	/** Resolves when the reference is live; rejects with a broken failure's error, or its end. Getters wait for it. */
	// 等待引用进入 live。输入 ctx；返回 Promise<void>，broken 失败或释放时拒绝。
	// 与 hydrated 不同，普通 failed { waiting } 会继续等待，而不是立即拒绝。
	live(context: Context): Promise<void> {
		return this.#until((state) => {
			if (state.kind === "live") return DONE;
			const broken = state.kind === "failed" && state.cause.kind === "broken";
			return broken ? { kind: "failed", error: state.cause.error } : WAIT;
		}, context);
	}

	/**
	 * The state member behind `member`, as consumers follow it (`ReferenceSource`): the instance's member while its
	 * object is live, its last value while it points at nothing; reads throw `released`, the failure's error, or
	 * `not_ready` when it never had a value.
	 */
	// 取得成员转接源。返回 DeriveSource；首次调用会创建并放到目标当前值上。
	// 示例：const title = binding.member("title"); title.value;
	member(member: string): DeriveSource {
		return this.#memberSource(member);
	}

	/** The source of state member `member`, made by its first use, following what its target shows now. */
	// 懒创建成员源并放入 Map。返回 ReferenceSource；已释放时直接抛终止错误。
	#memberSource(member: string): ReferenceSource {
		// ??= 首次访问时创建 Map；之后按成员名复用同一个转接源。
		this.#sources ??= new Map();
		let source = this.#sources.get(member);
		if (source !== undefined) return source;
		const state = this.#state;
		// A released reference throws its end (`#target`): it makes no source.
		if (state.kind === "released") throw state.state.error;
		source = new ReferenceSource(state.batch, this);
		this.#sources.set(member, source);
		// New, nothing follows it yet: placing it needs no batch.
		// 刚创建的源没有订阅者，直接放置即可；绑定状态下按目标当前跟随内容决定绑定/保留/失败。
		if (state.kind === "bound") place(source, state.target.followed(member, this.contract.version), this.#attached);
		return source;
	}

	/** What a read of a member that never had a value throws: `released`, the failure's error, or `not_ready`. */
	// 实现 SourceOwner：返回读取未绑定成员时应抛的错误；不抛异常，而是把 #target 的错误原样返回。
	none(): ChordError {
		try {
			this.#target();
		} catch (error) {
			return error as ChordError;
		}
		return new ChordError({ code: "not_ready", message: `${this.label}: not live yet` });
	}

	/** The keyed member `member`'s slot (slice 6a §12), as `member` resolves a state member. */
	// 返回底层键ed 槽位；未就绪/失败/释放时由 #target 抛错。
	keyedSlot(member: string): KeyedSlot {
		return this.#target().keyedMember(member);
	}

	/** How this reference reads keyed member `member`'s documents (`Target.keyedMapping`), as `keyedSlot` resolves. */
	// 旧版本引用读取新文档时返回映射函数；同版本返回 undefined，表示无需转换。
	keyedMapping(member: string): ((current: JsonValue) => JsonValue) | undefined {
		return this.#target().keyedMapping(member, this.contract.version);
	}

	/**
	 * Holds `key` of keyed member `member` (a key watch, a factory's `at(key)`, an object re-exposing this member): its
	 * source, pinned on the live instance and following its object's instances (`ReferenceKeys`); `release` once.
	 */
	// 持有键ed 成员的某个 key，返回 PinnedKey（含 source 和 release）。释放后拒绝；首次调用创建 ReferenceKeys。
	pinKey(member: string, key: string, context: Context): Promise<PinnedKey> {
		const state = this.#state;
		if (state.kind === "released") return Promise.reject(state.state.error);
		this.#heldKeys ??= new ReferenceKeys({
			batch: state.batch,
			version: this.contract.version,
			target: () => this.target,
			none: () => this.none(),
		});
		return this.#heldKeys.hold(member, key, context);
	}

	/** The bound object unless it failed: throws `released`, the failure's error, `not_ready` before the binding. */
	// 供成员读取使用的目标解析；所有不可用状态都转成对应的 ChordError 抛出。
	#target(): Target {
		const state = this.#state;
		// switch 按 kind 收窄；各分支返回 target 或抛错，因此函数无需末尾 return。
		switch (state.kind) {
			case "bound": {
				const current = state.target.state;
				// 已绑定但目标失败时，成员读取抛目标失败原因，而不是返回旧值。
				if (current.kind === "failed") throw current.cause.error;
				return state.target;
			}
			case "unbound":
				// 首次绑定前不可能有成员值。
				throw new ChordError({ code: "not_ready", message: `${this.#name}: not live yet` });
			case "waiting":
				// 已在索引中等待：有失败原因就抛它，否则仍是 not_ready。
				if (state.failure === undefined) {
					throw new ChordError({ code: "not_ready", message: `${this.#name}: not live yet` });
				}
				throw state.failure.cause.error;
			case "refused":
				throw state.failure.cause.error;
			case "released":
				throw state.state.error;
		}
	}

	/**
	 * A watch of `member` that ends when this reference is released, through its member (`ReferenceSource`): opened at
	 * once once it has a value (its last one while its object is not live, frames again when it is); before its first
	 * value it waits for its object's (`firstValues`: through failures, until the reference ends or `context` aborts).
	 */
	// 打开成员 watch。返回 Promise<Watch>；首次无值时会先等待对象成员有值。
	// 批次外检查与 openWatch 的断言一致；释放后由 #memberSource/owner.none 抛错。
	async watch(member: string, context: Context): Promise<Watch<JsonValue>> {
		// Checked here too: a constant's own watch has no batch to check. A released reference throws below.
		if (this.#state.kind !== "released") this.#state.batch.assertOutside("watch");
		const source = this.#memberSource(member);
		// Never had a value: it waits for its object's, as before the first binding.
		if (source.unbound) await this.firstValues(context);
		return this.follow(source.openWatch(context));
	}

	/**
	 * Resolves once its object's members have values (its first binding, for a watch on a reference that never had any);
	 * rejects only when the reference ends (released, revoked, its host closed) or `context` aborts: a failure is waited
	 * through (Opus G3).
	 */
	// 等待对象成员具备值。输入 ctx；返回 Promise<void>，只在引用结束或 ctx 取消时拒绝。
	// 已绑定且 hydrated 时立即兑现，避免不必要的等待者分配。
	async firstValues(context: Context): Promise<void> {
		if (this.#state.kind === "bound" && this.#state.target.hydrated) return;
		await this.#until((state) => (state.kind === "live" ? DONE : WAIT), context);
	}

	/** Resolves once the object's members have values; rejects when the reference fails or is released first. */
	// 与 firstValues 不同：目标失败即拒绝（用于方法/键读取），而不是穿透失败继续等。
	async hydrated(context: Context): Promise<void> {
		if (this.#state.kind === "bound" && this.#state.target.hydrated) return;
		await this.#until((state) => {
			if (state.kind === "live") return DONE;
			if (state.kind === "failed") return { kind: "failed", error: state.cause.error };
			return WAIT;
		}, context);
	}

	/**
	 * Ends `watch` when this reference is released; returns it. A watch opened while the reference was released (an
	 * async keyed watch racing `release`) is ended at once, its pin with it, and the caller gets `released`.
	 */
	// 登记 watch 随引用结束而结束；返回同一个 watch，便于链式使用。关闭时从集合移除，避免长期持有。
	follow<W extends Watch<JsonValue>>(watch: W): W {
		if (this.#state.kind === "released") {
			watch.end({ kind: "ended" });
			throw this.#state.state.error;
		}
		this.#watches.add(watch);
		void watch.closed.then(() => this.#watches.delete(watch));
		return watch;
	}

	/**
	 * `ref.member.at(key)`: only while its object's factory runs (the reference not yet bound); pinned once bound
	 * (`pinKeys`), released with the reference.
	 */
	// 工厂内声明 at(key)。返回 KeyedMemberAt；仅 unbound 且 dependent 存在（即 self.get 声明）时允许。
	at(member: string, key: string): KeyedMemberAt {
		if (this.#state.kind !== "unbound" || this.#state.dependent === undefined) {
			throw new Error(`${this.#name}: ${member}.at(key) is valid only in the factory`);
		}
		const at = new KeyedMemberAt(this, member, key);
		this.#ats.push(at);
		return at;
	}

	/** Whether its object's factory pinned keys on it (`at(key)`). */
	// 激活前据此决定是否需要 pinKeys。
	get pinsKeys(): boolean {
		return this.#ats.length > 0;
	}

	/**
	 * Pins the keys of `at(key)` on the live object's keyed members and loads those not in memory, before the
	 * dependent goes live (slice 6a §12); `undefined` when there are none. A failed load rejects.
	 */
	// 依次 pin 所有 at(key)。返回 Promise<void>，没有声明时返回 undefined（调用方无需等待）。
	pinKeys(context: Context): Promise<void> | undefined {
		if (this.#ats.length === 0) return undefined;
		return (async () => {
			for (const at of this.#ats) await at.pin(this, context);
		})();
	}

	/**
	 * `ref.retry()`, as a step of `walk` (a new one for `ref.retry()`, passed on through parked objects): the object is
	 * asked for an attempt now (ignored unless failed; a parked one passes it on); a refused reference is placed again;
	 * one waiting in the index is left as it is (an event wakes it).
	 */
	// 应用发起的 retry。输入遍历状态（默认新建）；无返回。
	// 已绑定转给目标；refused 回到 unbound 并重新 bind；waiting/unbound 不处理。
	retry(walk: RetryWalk = retryWalk()): void {
		const state = this.#state;
		if (state.kind === "bound") {
			state.target.retry(walk);
			return;
		}
		if (state.kind !== "refused") return;
		this.#state = { kind: "unbound", batch: state.batch, dependent: state.dependent };
		this.moved();
		state.bind();
	}

	/** Releases the reference (idempotent); the object may end when it was its last. */
	// 释放引用：先从目标 unhold，再进入 released 终态；重复调用无副作用。
	// 批次内不允许释放，避免在发布过程中改变引用计数。
	release(): void {
		const state = this.#state;
		if (state.kind === "released") return;
		state.batch.assertOutside("release");
		// First: an object over a link rejects the calls itself and sends no cancel for them.
		if (state.kind === "bound") state.target.unhold(this);
		this.end(this.#released());
	}

	/**
	 * Ends the reference without releasing it from its object (it ended): watches end, calls (running and parked)
	 * reject with `error`, `ref.state` is `ended` with it; the object whose attempt declared it checks again.
	 */
	// 终止引用（对象结束、撤权或宿主关闭），与主动 release 不同：不 unhold。无返回。
	// 清理顺序：状态 -> 等待离队 -> at 句柄 -> 成员/键源 -> 调用与 parked -> watch -> ref.state -> waiters -> dependent。
	end(error: ChordError): void {
		// Kept by `ref.state`: its stack is made text now, so the error holds none of the frames' objects.
		void error.stack;
		const ended: Ended = { kind: "ended", error };
		const previous = this.#state;
		this.#state = { kind: "released", state: ended };
		this.#contract = undefined;
		if (previous.kind === "waiting") previous.leave();
		for (const at of this.#ats) at.release();
		// Its members' and keys' watches end, derives over them are marked; their instance subscriptions go.
		const sources = this.#sources;
		const keys = this.#heldKeys;
		this.#sources = undefined;
		this.#heldKeys = undefined;
		this.#attached = undefined;
		if (previous.kind !== "released" && (sources !== undefined || keys !== undefined)) {
			const end = (): void => {
				for (const source of sources?.values() ?? []) source.end(error);
				keys?.end(error);
			};
			// A batch only when something still follows them (an ending object's derives detached already).
			const used = keys !== undefined || [...(sources?.values() ?? [])].some((source) => source.inUse);
			if (used) previous.batch.within(end, BACKGROUND_CONTEXT);
			else end();
		}
		this.#calls?.abort(error);
		this.#calls = undefined;
		this.#parked?.reject(error);
		this.#parked = undefined;
		for (const watch of this.#watches) watch.end({ kind: "ended" });
		this.#refState?.released(ended);
		// Each removes itself; promise reactions run later.
		for (const waiter of this.#waiters) waiter.end(error);
		// An ended dependency breaks a parked dependent (it cannot come back).
		if (previous.kind !== "released") previous.dependent?.dependencyMoved();
	}

	// 成员调用的统一入口。输入方法名、参数和 ctx；返回 Promise<unknown>。
	// live 时直接发送或排队；loading 时进入 parked 队列；failed/ended 时同步抛错。
	// 示例：await ref.getName([], ctx) 会经构造时生成的 async 方法进入 #call；参数数组由调用方按签名传入。
	#call(method: string, args: unknown, context: Context): Promise<unknown> {
		const state = this.refState;
		switch (state.kind) {
			case "live":
				// Calls queued before it went live are still being sent: a new one never overtakes them.
				if (this.#parked?.waiting) return this.#parked.park(method, args, context);
				return this.#send(method, args, context);
			case "loading":
				this.#parked ??= new ParkedCalls(this.#parkTimeout, this.label);
				return this.#parked.park(method, args, context);
			case "failed":
				throw state.cause.error;
			case "ended":
				throw state.error;
		}
	}

	/** Calls the live object; the call is aborted when the reference ends. */
	#send(method: string, args: unknown, context: Context): Promise<unknown> {
		// Only a bound reference is live.
		// as Extract<...> 是类型断言：live 与 bound 在状态联合中一一对应，这里把联合收窄到 bound 分支以取 target。
		const { target } = this.#state as Extract<BindingState, { readonly kind: "bound" }>;
		this.#calls ??= new AbortController();
		const linked = withLinkedAbortSignal(this.#calls.signal, context);
		return target.call(method, args, linked.context, this.caller, this.contract.version).finally(linked.release);
	}

	/**
	 * Settles once `decide` does for the reference's state, checked now and at every change; rejects when the reference
	 * ends (with its error, `released` when it is released already) or `context` aborts.
	 */
	// 等待判定函数返回 done/failed，或在状态每次变化时重新判定。输入 decide 与 ctx；返回 Promise<void>。
	// 等待者登记到 #waiters，状态变化时由 Binding.moved/wake/refuse 等调用 check。
	#until(decide: (state: RefState) => Decision, context: Context): Promise<void> {
		if (this.#state.kind === "released") return Promise.reject(this.#state.state.error);
		// Promise.withResolvers 一次取得 promise 与 resolve/reject，便于在事件回调里手动结算。
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const signal = context.abortSignal;
		// settle 统一清理：从等待集合移除、解绑 abort 监听，再执行结算动作。
		const settle = (done: () => void): void => {
			this.#waiters.delete(waiter);
			signal?.removeEventListener("abort", abort);
			done();
		};
		const waiter: Waiter = {
			check: () => {
				const decision = decide(this.refState);
				if (decision.kind === "done") settle(resolve);
				else if (decision.kind === "failed") settle(() => reject(decision.error));
			},
			end: (error) => settle(() => reject(error)),
		};
		const abort = (): void => settle(() => reject(signal?.reason));
		this.#waiters.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		// 先注册再检查：若信号已经取消则立即 abort；否则立即按当前状态判定一次，之后靠状态变化驱动。
		if (signal?.aborted) abort();
		else waiter.check();
		return promise;
	}

	// 懒创建对外可观察的 ReferenceState，供 derive/watch 使用；传入当前批次以便用户回调在批次内运行。
	#watchableState(): ReferenceState {
		if (this.#refState !== undefined) return this.#refState;
		const state = this.#state;
		// A released reference's state never changes: it is made ended, keeping no batch.
		if (state.kind === "released") {
			const made = new ReferenceState(() => this.refState, undefined);
			made.released(state.state);
			this.#refState = made;
			return made;
		}
		this.#refState = new ReferenceState(() => this.refState, state.batch);
		return this.#refState;
	}

	// 返回目标当前 variant（重载后可能变化）；未绑定/释放时分别是 undefined 或抛错。
	#variant(): string | undefined {
		const state = this.#state;
		if (state.kind === "released") throw state.state.error;
		return state.kind === "bound" ? state.target.variant : undefined;
	}

	/** The error of this reference's release by its holder (`released`, no reason). */
	#released(): ChordError {
		return new ChordError({ code: "released", message: `${this.#name}: released` });
	}
}

/** A state member of a reference: the provider's member, followed through this reference. */
// 引用上的状态成员句柄：把成员的 value/watch/source 转发给 Binding。
// 输入 Binding 和成员名；无副作用（创建时只记录字段）。
class ReferenceMember {
	readonly #binding: Binding;
	readonly #member: string;

	// 保存引用与成员名；不立即解析目标，真正读取时才有 I/O。
	constructor(binding: Binding, member: string) {
		this.#binding = binding;
		this.#member = member;
	}

	// 读取成员当前值；经 ReferenceMember.source -> Binding.member，未就绪时抛错。
	get value(): JsonValue {
		return this.source.value;
	}

	// 打开成员 watch；返回 Promise<Watch<JsonValue>>，等待由 Binding.watch 处理。
	watch(context: Context): Promise<Watch<JsonValue>> {
		return this.#binding.watch(this.#member, context);
	}

	/** The provider's member: a source or a constant. */
	// 取得成员转接源（可能跨实例跟随）；读取/监听都经过它。
	get source(): DeriveSource {
		return this.#binding.member(this.#member);
	}
}

/** A keyed member of a reference (slice 6a §12): reads by key behave as calls (they wait while loading). */
// 引用上的键ed 成员句柄：按 key 读取/监听文档，行为类似调用（加载时等待）。
// slot 指向最终提供者；读值时可应用旧版本映射。
class ReferenceKeyed {
	readonly #binding: Binding;
	readonly #member: string;

	// 记录引用与成员名，不触发加载。
	constructor(binding: Binding, member: string) {
		this.#binding = binding;
		this.#member = member;
	}

	/** The provider's slot: the ultimate provider's, through re-exposures (rule 22). */
	// 取得最终提供者的槽位；转接层只透传，不复制文档。
	get slot(): KeyedSlot {
		return this.#binding.keyedSlot(this.#member);
	}

	/** This member as another object re-exposing it has it: its keys held through this reference. */
	// 以“转发成员”的形式交给下游；kind 是判别字段，用于 KeyedBinding 联合收窄。
	get keyed(): KeyedBinding {
		return { kind: "reexposed", binding: this.#binding, member: this.#member };
	}

	// 按 key 读取文档；返回 Promise<JsonValue | undefined>，不存在为 undefined。
	// 先等待 hydrated（失败即拒绝），再用 ownAccess 取得当前版本，最后按旧版本映射值。
	async get(key: string, context: Context): Promise<JsonValue | undefined> {
		await this.#binding.hydrated(context);
		const slot = this.slot;
		const map = this.#binding.keyedMapping(this.#member);
		const value = await slot.get(key, ownAccess(slot), context);
		// map 为 undefined 表示同版本无需转换；value 不存在时也直接返回 undefined。
		return map === undefined || value === undefined ? value : map(value);
	}

	/**
	 * A watch of the document at `key` across the object's attempts (it holds the key through the object), `undefined`
	 * when absent; it ends with this reference.
	 */
	// 监听某个 key 的文档；返回 Promise<Watch<JsonValue> | undefined>，文档不存在时 undefined。
	// 先等对象成员有值（穿透失败），再 pin 住该 key，使 watch 跨对象实例跟随。
	async watch(key: string, context: Context): Promise<Watch<JsonValue> | undefined> {
		await this.#binding.firstValues(context);
		const slot = this.slot;
		if ((await slot.get(key, ownAccess(slot), context)) === undefined) return undefined;
		// Mapped to its version when older (slice 7b §7), across its object's instances (`ReferenceKeys`).
		const held = await this.#binding.pinKey(this.#member, key, context);
		// Retired between the read and now: absent.
		if (slot.current(slot.key(key)) === undefined) {
			held.release();
			return undefined;
		}
		let watch: Watch<JsonValue>;
		// openWatch 可能同步失败（如已释放）；失败时先释放 pin，避免泄漏。
		try {
			watch = held.source.openWatch(context);
		} catch (error) {
			held.release();
			throw error;
		}
		// watch 关闭时自动释放 pin；void 表示不等待该 Promise。
		void watch.closed.then(held.release);
		// follow 让 watch 在引用结束时一并结束。
		return this.#binding.follow(watch);
	}

	// 返回 key 的长期句柄（KeyedMemberAt）；as unknown as 是双重断言，因公开类型是 Watchable 接口。
	at(key: string): Watchable<JsonValue> {
		// The pinned key's values are the member's documents.
		return this.#binding.at(this.#member, key) as unknown as Watchable<JsonValue>;
	}
}

/** A consumer reads its provider's keyed documents as the provider's own code may: current version, own token. */
// 构造读取凭据：使用提供者自己的 token 与当前版本，让消费者能读到其有权看到的文档。
function ownAccess(slot: KeyedSlot): { readonly token: SealToken; readonly version: number } {
	return { token: slot.owner.own, version: slot.definition.current.version };
}

/** Where a `ref.member.at(key)` stands: not held yet, held on the object's keyed member, or released for good. */
// at(key) 句柄的三态：未 pin、已 pin（含源与释放函数）、已释放。kind 是判别字段。
type AtState =
	| { readonly kind: "unpinned" }
	| { readonly kind: "pinned"; readonly source: DeriveSource; readonly release: () => void }
	| { readonly kind: "released" };

/**
 * `ref.member.at(key)`: the key's source across the object's attempts once the reference is bound and the key held
 * (`pin`), until the reference ends (`release`, exactly once): then it drops the source (a retained reference keeps no
 * provider).
 */
// ref.member.at(key) 的句柄：引用绑定并 pin 住 key 后提供源的读写；引用结束时释放。
// 示例：const title = ref.task.at("t1"); title.value / title.watch(ctx)。
class KeyedMemberAt {
	readonly #binding: Binding;
	readonly member: string;
	readonly key: string;
	// 初始 unpinned；pin 成功后转 pinned；release 后为终态 released。
	#state: AtState = { kind: "unpinned" };

	// 记录所属引用、成员名和 key，不做 I/O。
	constructor(binding: Binding, member: string, key: string) {
		this.#binding = binding;
		this.member = member;
		this.key = key;
	}

	/** The key's source; `not_ready` before it is held, `released` after. */
	// 取得 key 的源；未 pin 抛 not_ready，已释放抛 released，因此调用方必须先 pin/等待。
	get source(): DeriveSource {
		const state = this.#state;
		if (state.kind === "pinned") return state.source;
		const what = `${this.member}.at(${this.key})`;
		// 按状态区分错误码：已释放是永久错误，未加载是暂时错误。
		if (state.kind === "released") throw new ChordError({ code: "released", message: `${what}: released` });
		throw new ChordError({ code: "not_ready", message: `${what}: not loaded yet` });
	}

	// 读取 key 当前值；委托 source，未就绪时由 source 抛错。
	get value(): JsonValue {
		return this.source.value;
	}

	// 打开该 key 的 watch，并交给引用 follow，使其随引用结束。
	async watch(context: Context): Promise<Watch<JsonValue>> {
		return this.#binding.follow(this.source.openWatch(context));
	}

	/**
	 * Holds the key through `binding` (once), loaded, mapped to an older binding's version (slice 7b §7); nothing once
	 * released (a hold that lands then is released).
	 */
	// 首次且仅一次真正 pin；输入 binding + ctx，返回 Promise<void>。
	// 若等待期间已 release，拿到句柄后立刻释放，避免悬挂的 pin。
	async pin(binding: Binding, context: Context): Promise<void> {
		if (this.#state.kind !== "unpinned") return;
		const held = await binding.pinKey(this.member, this.key, context);
		// await 期间状态可能被 release 改成 released；此时不能进入 pinned。
		if (this.#state.kind !== "unpinned") {
			held.release();
			return;
		}
		this.#state = { kind: "pinned", source: held.source, release: held.release };
	}

	/** Releases the pin and drops the source (once). */
	// 释放并丢弃源；重复调用安全，已 pin 时调用底层 release。
	release(): void {
		const state = this.#state;
		this.#state = { kind: "released" };
		if (state.kind === "pinned") state.release();
	}
}

/**
 * What a keyed member's value is (slice 6a §12): a keyed document handle's slot, or a reference's keyed member
 * (re-exposed); `undefined` for anything else.
 */
// 把成员值解析成键ed 绑定：自己的 Keyed 句柄或引用转发的成员；其他类型返回 undefined。
// 这里的 instanceof 是运行时判别（value 是 unknown），不是冗余的防御检查。
export function resolveKeyed(value: unknown): KeyedBinding | undefined {
	if (value instanceof Keyed) return { kind: "own", slot: value.slot };
	if (value instanceof ReferenceKeyed) return value.keyed;
	return undefined;
}

/**
 * The watchable Chord follows behind a state member or a derive source (Q14): a source or a constant itself, a
 * singleton handle's slot, a reference member's provider member, a keyed member's pinned key (a key source itself for
 * `handle.at(key)`); `undefined` for anything else, a native watchable included.
 */
// 把状态成员/derive 源解析成可 watch 的 DeriveSource；native watchable 等不识别，返回 undefined。
// 多个 instanceof 分支按具体到通用的顺序检查，最后才是 Source/Constant。
export function resolveWatchable(value: unknown): DeriveSource | undefined {
	if (value instanceof Singleton) return value.slot;
	if (value instanceof ReferenceMember) return value.source;
	if (value instanceof KeyedMemberAt) return value.source;
	if (value instanceof Source || value instanceof Constant) return value;
	return undefined;
}

/**
 * Points `source` at what its reference follows now (`Followed`), inside a batch; a new one takes its last value from
 * the instance that stopped, only when its reference was attached to that one (`attached`).
 */
// 按跟随状态放置成员源。输入源、Followed 和 attached 实例；无返回值。
// 已 live 直接绑定；lacking 让源消失；loading/failed 在条件满足时先保留旧实例的最后一个值，再 hold/fail。
function place(source: ReferenceSource, followed: Followed, attached: unknown): void {
	switch (followed.kind) {
		case "live":
			// 目标已有真实成员源：直接绑定，后续值变化由该源驱动。
			source.bind(followed.source);
			return;
		case "lacking":
			// 目标明确没有该成员：让源消失并携带错误。
			source.vanish(followed.error, BACKGROUND_CONTEXT);
			return;
		case "loading":
			// 新实例仍加载中：若旧实例正是当前引用挂载的实例，先用它的最后值占位，避免短暂闪空。
			if (source.unbound && followed.last !== undefined && followed.instance === attached)
				source.bind(followed.last);
			// hold 让源保留最后值并暂停跟随；已有失败被清除，但 told 保留恢复时的全量要求。
			source.hold();
			return;
		case "failed":
			// 与 loading 类似：可先展示旧值，再把源标记为失败。
			if (source.unbound && followed.last !== undefined && followed.instance === attached)
				source.bind(followed.last);
			source.fail(followed.error, BACKGROUND_CONTEXT);
			return;
	}
}
