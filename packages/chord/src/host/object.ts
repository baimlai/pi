// Objects (§6): one per identity, from its first attempt to its end. Its state across attempts (its documents, line
// and job runs), the instance its references follow (`followed`: decision "References are the only indirection"), its
// holders, retries after failures (backoff, `ref.retry()`, passed
// on while parked), what it shows while its attempt is parked on dependencies (dependency model §3), its first outcome
// (the start barrier, decision (a)), a live object's failure (slice 6a §1.4), the waits and cycle checks of activations
// (Q5, its instance id and the activation chain it was created for), lingering after its last reference (§3, D8), the
// job runs that keep it alive (§15), its contributions to registries while live and its wake signals (`retryOn`, slice
// 8), its ending, revocation included (§4, R11), and what a reload does to it (slice 7b §4): a pure swap in place, a
// native restart after the drain, a retry on the new code, or its end by its type's removal, after which its
// references wait with their last values and follow the next object of the identity.

// 所属：packages/chord/src/host 的对象状态机（设计 §6；slice 6a、7b；决策“引用是唯一间接层”）。
// 职责边界：一个 identity 一个 ChordObject，跨 attempt 保留文档、行、任务运行与 holder；不负责参数校验、放置决策或链接编码。
// 上游：host.ts 的 #object 创建/查找对象；reference.ts 的 Binding 通过 hold/unhold 挂载；远端 serving 取得对象。
// 下游：Attempt（每次激活的新实例）、Documents、JobRecords、注册表贡献、宿主 presence/activity/backoff、RetryWakes。
// 结果与错误：激活失败分 transient（退避后重试）/broken（等显式 retry）/waiting（依赖未就绪，事件唤醒）；
// 结束原因经 Holder.end/removed 通知引用；拆卸失败汇总为 CloseFailed 交给宿主。
// 能力清单：
// - LocalContract/RemoteContract：两种契约的收窄类型（本地无 principal，远程工厂带 principal）。
// - Served：宿主上已服务类型的联合（local 带 hostLifetime，remote 带 principal 工厂）。
// - Holder：对象通知引用的接口（retarget/following/moved/end/removed）。
// - Removal：类型被移除后引用重新等待所需的信息（cause/host/params/context）。
// - ReloadFate：重载对对象的三种处理 swap/restart/retry。
// - ChordObject：对象类——状态投影（state/variant/stateMembers）、激活与重试（attempt/retry/retryOn）、
//   调用与跟随（call/followed/liveMember/keyedMember/pinKey）、holder 管理（hold/unhold）、失败（failLive）、
//   依赖与循环检查（waitsFor/assertNoCycle/dependencyMoved）、park/unpark、结束与清理（end/stop/remove）、
//   重载（reloadFate/reload）以及内部通知与拆卸流程。
// 组合与典型顺序：host 创建对象 -> attempt() 启动首次激活 -> 依赖 hold 时 parked，全部就绪后 unparked -> live 后
// call/followed 服务引用；失败 -> 退避或 retry；重载 -> reloadFate 决定 swap/restart/retry/end；最后一个 holder 离开
// -> linger 后 end -> stop 返回拆卸函数。
// 示例：const object = new ChordObject(host, served, { name: "a" }, principal, "name=a", identity, context, []);
//       object.hold(holder);
//       const value = await object.call("bump", { by: 1 }, context, caller, 1);
// 建议阅读顺序：LocalContract/RemoteContract/Served -> Holder/Removal/ReloadFate -> 状态与 Teardown/Ending 内部类型
// -> ChordObject 字段与构造 -> state/attempt/retry -> hold/unhold/call/followed -> parked/failLive -> end/stop/remove
// -> reload 系列 -> 最后的 #run/#wentLive/#tearDown 等内部流程。

import { awaitWithContext, type Context } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { ContractShape } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { asChordError, binds, invalid, type Provider, sameCause } from "../data/internal.ts";
import { Documents, type KeyedSlot } from "../documents/internal.ts";
import type { JobDefinition } from "../jobs/index.ts";
import { JobRecords } from "../jobs/internal.ts";
import type { JsonValue } from "../json.ts";
import { CHAIN } from "../link/internal.ts";
import type { RegistryContribution } from "../registries/internal.ts";
import type { DeriveSource } from "../state/internal.ts";
import { refusal } from "./adapted.ts";
import { Attempt, type PinnedKey, type Self } from "./attempt.ts";
import type { Caller } from "./ctx.ts";
import type { Dependency } from "./dependencies.ts";
import type { AnyHost } from "./host.ts";
import type { CloseFailed, NativeCloseReason } from "./native.ts";
import { type Ended, type Failed, LIVE, LOADING, type RefState } from "./ref-state.ts";
import { type CheckedParams, type Followed, type RetryWalk, retryWalk, type Target } from "./reference.ts";
import { type RetrySource, RetryWakes } from "./retry-on.ts";
import { migratesTables, type Recorded } from "./staging.ts";
import { uuidv7 } from "./uuid.ts";

/** A `local` contract, as a served type has it. */
// 本地契约：对象只在本宿主内，不跨链接；ContractShape 的 kind 收窄为 "local"。
export type LocalContract = Contract<ContractShape & { readonly kind: "local" }>;

/** A `remote` contract, as a served type has it. */
// 远程契约：可被其他宿主通过链接引用；工厂额外接收 principal。
export type RemoteContract = Contract<ContractShape & { readonly kind: "remote" }>;

/**
 * A type served on a host, by kind: its contract, factory (a remote one gets the object's principal) and argument
 * checks. Factories are plugin code: what they return is checked at activation.
 */
// 宿主上“已服务类型”的联合。local 分支带 hostLifetime（空参数对象随宿主存活），
// remote 分支的工厂多一个 principal 参数。两者都含 ServedType 的公共字段。
export type Served =
	| (ServedType<LocalContract> & {
			readonly kind: "local";
			readonly factory: (params: ParamsOf<Contract>, self: Self) => unknown;
			/** A type with empty params: its object lives as long as the host (Q-A). */
			readonly hostLifetime: boolean;
	  })
	| (ServedType<RemoteContract> & {
			readonly kind: "remote";
			readonly factory: (params: ParamsOf<Contract>, principal: Principal, self: Self) => unknown;
	  });

// Served 的公共字段：插件归属、契约、提供者与 linger 时长；两个分支只在这个基础上加工厂差异。
type ServedType<C extends Contract> = {
	/** The plugin whose facet served it: its objects contribute to registries by it. */
	// 提供该类型的插件名；reload 按插件归属判断对象是否受影响。
	readonly plugin: string;
	readonly contract: C;
	readonly provider: Provider<Contract>;
	/** How long a live object stays live after its last reference, in milliseconds (`serve`'s `linger`, 0 by default). */
	// linger 是最后一个引用离开后对象继续存活的毫秒数；0 表示立即结束。
	readonly linger: number;
};

/** What holds an object: a reference's binding, or a hold arriving over a link. */
// 持有者接口：引用绑定或来自链接的 hold。ChordObject 只通过这些回调通知外部，不直接依赖 Binding 的实现。
// 字段均为运行时对象；类型只在编译期保证回调形状。
export interface Holder {
	/** The object whose attempt declared the reference: it checks its dependencies again when this object changes. */
	// 声明该引用的对象（依赖图边）；对象状态变化时会通知 dependent 重新检查依赖。
	readonly dependent: ChordObject | undefined;
	/** Whom the reference acts for, with its origin's incarnation (`host.references`). */
	// 调用者身份与来源宿主运行标识；用于 presence 与权限判断。
	readonly caller: Caller;
	/** The consumer's contract version and fingerprint (its request's): the provider binds it or it waits unbound. */
	// 消费者契约版本与指纹：提供者必须绑定该版本，否则引用等待未绑定。
	readonly contract: { readonly version: number; readonly fingerprint: string };
	/**
	 * Inside a batch, before `moved`: what it follows of the object changed (`ChordObject.followed`): a reference moves its
	 * members' subscriptions to the new instance, or keeps their last values; a hold over a link has nothing to do here.
	 */
	// 在批次内、moved 之前调用：引用把成员订阅迁移到新实例或保留最后值；链接 hold 无动作。
	retarget(): void;
	/** Whether `retarget` moves anything (a reference whose members or keys were used): it then runs in a batch. */
	// 若引用从未使用成员/键，retarget 无事可做，可跳过批次开销。
	readonly following: boolean;
	/** The object's state (`state`) changed: an attempt started after a failure, it went live, or it failed. */
	// 状态变化通知：引用据此刷新自己的 state，并决定是否唤醒挂起调用。
	moved(): void;
	/** The object ended with `error`. */
	// 对象永久结束：引用结束并拒绝未完成调用。
	end(error: ChordError): void;
	/**
	 * The object ended because a reload removed its type (slice 7b §6): the holder's request is not ended; it waits
	 * unbound with `removal.cause` (`not_served`) until a publication serves the name again.
	 */
	// 类型被移除：引用不结束，而是保留最后值并回到未绑定等待，等待同名类型再次发布。
	removed(removal: Removal): void;
}

/**
 * What an object tells holders it leaves: why they wait (`not_served` after a removal, `contract_mismatch` after a
 * version refusal), its params (they place their requests again) and its context. A reference keeps its last values
 * meanwhile and moves its subscriptions to the next object of the identity that serves its version (one frame).
 */
// 类型被移除/版本不再匹配时交给引用的信息：cause 解释等待原因；host/params/context 让引用之后能重新放置请求。
// 引用保留最后值，直到同一 identity 的下一个对象绑定它。
export type Removal = {
	readonly cause: FailureCause;
	readonly host: AnyHost;
	readonly params: CheckedParams;
	readonly context: Context;
};

/** What a reload does to a live, activating, parked or failed object whose type is still served (slice 7b §4). */
// 三种 fate：swap（同实例原地换新代码）、restart（先排空再换新实例）、retry（非 live 对象直接重试新代码）。
export type ReloadFate = "swap" | "restart" | "retry";

/**
 * A pure swap in progress (slice 7b §5): the attempt it replaces (its calls run on, then it is sealed), whether the new
 * attempt parked (holders then see what it shows, and the old one's contributions left the tables), and the end of
 * the swap (its new attempt live, parked or failed, or the object ended), which calls arriving meanwhile wait for.
 */
// old 是被替换的尝试；parked 标记新尝试是否已 park；done 是“门”，swap 期间的调用在 #gate 等待它。
type Swap = { readonly old: Attempt; parked: boolean; readonly done: PromiseWithResolvers<void> };

/**
 * Where an object stands. `waiting`: for its identity's backoff window before its first attempt. `activating` has what
 * its references show: `loading`, or `failed { waiting }` while its attempt is parked on a failed dependency. `failed`
 * has the state its references show.
 */
// 对象状态联合：waiting（等待退避窗口）、activating（有进行中的 attempt 与对外展示状态）、
// live（有可用实例）、failed（失败状态，引用看到 failure）、ended（永久结束）。
// activating 的 swap 可选字段只在 reload 的纯 swap 期间存在。
type ObjectState =
	| { readonly kind: "waiting" }
	| {
			readonly kind: "activating";
			readonly attempt: Attempt;
			readonly shown: RefState;
			/** Set while a reload's pure swap replaces the live attempt. */
			readonly swap?: Swap;
	  }
	| { readonly kind: "live"; readonly attempt: Attempt }
	| { readonly kind: "failed"; readonly failure: Failed }
	| { readonly kind: "ended"; readonly ended: Ended };

/**
 * What an ended object still has to do once its previous teardowns finished (`previous`): drain and close its attempt;
 * then drop its documents and job runs (`end` alone).
 */
// 结束后的清理描述：none 无事可做；end 只需等待前序清理；close 还需关闭当前 attempt。
// previous 是同一 identity 上更早实例的 teardown，避免旧实例仍在使用共享文档时被清理。
type Teardown =
	| { readonly kind: "none" }
	| { readonly kind: "end"; readonly previous: Promise<void> | undefined }
	| { readonly kind: "close"; readonly attempt: Attempt; readonly previous: Promise<void> | undefined };

/** How an object ends: by an end (its last reference, revocation, the host closing) or by its type's removal. */
// 结束原因：end 终止引用；removed 保留引用为未绑定等待（类型可能再次发布）。
type Ending =
	| { readonly kind: "end"; readonly error: ChordError }
	| { readonly kind: "removed"; readonly error: ChordError; readonly cause: FailureCause };

// 关闭原因常量复用同一对象，避免每次结束分配；只为可读性与身份稳定。
const END: NativeCloseReason = { kind: "end" };

const CLOSE: NativeCloseReason = { kind: "close" };

const RELOAD: NativeCloseReason = { kind: "reload" };

/** No dependencies waited for: the shared empty list. */
// 共享空数组：没有依赖/没有贡献时复用，避免每次分配。
const NO_DEPENDENCIES: readonly Dependency[] = [];

/** No contributions leaving: the shared empty list. */
const NO_CONTRIBUTIONS: readonly RegistryContribution[] = [];

/**
 * One object. Each attempt is a fresh `Attempt`; the documents, the line, the job runs and the holders outlive it. An
 * attempt parked on its dependencies waits for them without a timer; a transient failure (its own) is retried after its
 * backoff window, or at once when a reference asks (`retry`); a broken one stays failed until a reference asks.
 * The object ends with its last reference, a live one after its type's `linger` (never, for a host-lifetime object),
 * or when the host closes.
 */
// 一个 ChordObject 对应一个 identity（类型+参数+principal 键）。实例字段跨 attempt 保留，attempt 只承载一次激活。
// 所有方法都假定单线程事件循环：状态读写无需锁，但批次/微任务顺序决定通知时机。
export class ChordObject implements Target {
	readonly host: AnyHost;
	/** Its served type: replaced by a reload that swaps, restarts or retries it. */
	// 已服务类型；reload 提交后替换为新代码的 Served。
	served: Served;
	readonly params: ParamsOf<Contract>;
	/** Its params' identity key (empty for empty params). */
	// 参数规范化后的 identity 键；空参数类型为空串。
	readonly key: string;
	/** The principal in a remote object's identity, which its factory gets; `undefined` for a local object. */
	// 远程对象的 principal 是 identity 的一部分；本地对象为 undefined。
	readonly principal: Principal | undefined;
	readonly identity: string;
	/** The object in errors, reports and cycles: its type, and its params key when it has params. */
	// 人类可读标签，例如 "Note(1)"；用于错误、报告与循环检测。
	readonly label: string;
	/**
	 * The activation chain it was created for (Q5): the instance ids of the activations waiting for it, from the hold
	 * that created it (a trusted link's) or the activation here that declared it; empty otherwise.
	 */
	// 激活链：创建该对象的调用链上的激活 id，用于跨宿主依赖环检测；普通 get 为空。
	readonly chain: readonly string[];
	/** Its documents and line, across its attempts. */
	// 文档集合跨 attempt 存活：失败重试不会丢文档；keyed 文档的 slot 也在这里。
	readonly documents: Documents;
	/** The context of every attempt: its creator's, without the creator's cancellation. */
	// 去掉取消信号的创建者上下文：某个 getter 取消不应取消共享对象。
	readonly #context: Context;
	/** Its job runs by job name, across its attempts. */
	readonly #jobs = new Map<string, JobRecords>();
	/** This instance's id (uuidv7), minted at its first attempt: a restarted object is a new instance (D4). */
	// 实例 id 在首次 attempt 时生成；restart 会换新 id，swap 复用同一实例 id。
	#instance: string | undefined;
	#state: ObjectState = { kind: "waiting" };
	/** References and holds of this object. */
	readonly #holders = new Set<Holder>();
	/** The dependencies its parked attempt waits for; their objects are followed to find cycles (Q5). */
	#waitingFor: readonly Dependency[] = NO_DEPENDENCIES;
	/**
	 * Its first outcome (decision (a)): live, failed, parked with no blocker here still without one, or ended; once.
	 * The promise is made by the first who waits for it (the start barrier, for host-lifetime objects).
	 */
	// 首次结局的一次性 Promise 与标记；start barrier 用它判断对象是否已给出结果。
	#firstOutcome: PromiseWithResolvers<void> | undefined;
	#hasFirstOutcome = false;
	/** The error of the last failed attempt, or the last cause a parked attempt showed, until one goes live. */
	// 最近一次失败/停驻原因，供 getter 截止时报告；live 后清空。
	#lastFailure: ChordError | undefined;
	/** Ends the object when its type's `linger` passed after its last reference; cleared by a new one. */
	// linger 计时器：最后一个引用离开后开始；新引用或结束会清除它。
	#lingering: ReturnType<typeof setTimeout> | undefined;
	/** Its running and finishing job runs: they keep it alive like references (D4), without being references. */
	// 运行中及正在收尾的任务数：像引用一样保活对象，但不出现在 presence 中。
	#runs = 0;
	/**
	 * The instance its references follow (`followed`): the live one, the old one while a swap brings its successor in
	 * place, or the last one that went live while it still changes after a failure or a restart (references take their
	 * last values from it when it stops); `undefined` before the first went live and once it stopped changing.
	 */
	// 引用当前跟随的实例；可能不是 live 的那个（swap/失败后的已接纳提交仍可发布）。
	#exposed: Attempt | undefined;
	/**
	 * Whether references still follow `#exposed`, which may still change: while it is live, drains (a restart), retires
	 * (a swap's old instance until its successor is live or it retired), or failed live until the commits admitted
	 * before it published (every member, its own and re-exposed ones: audit A10); not once it stopped changing.
	 */
	// following 为 true 表示 #exposed 仍可能变化；#stopFollowing 把它置 false 并让引用取最后值。
	#following = false;
	/** The one timer storing its jobs' held state changes by their earliest deadline (D8), while one is held. */
	// 任务被 hold 的状态变化共用最早截止时间的一个计时器，避免每任务一个定时器。
	#flush: { readonly deadline: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	/** Its wake signals (`retryOn`), the last attempt's declaration; made by the first. */
	#wakes: RetryWakes | undefined;
	/** Its swapped-out attempts while they retire (bounded by `closeTimeout`); made by the first swap. */
	#retiring: Map<Attempt, Promise<void>> | undefined;

	// 构造对象元数据并建立 Documents；不启动激活（由 host.#object 决定何时 attempt）。
	// 输入：宿主、已服务类型、已检查参数与键、principal、identity、创建者上下文、激活链。
	// 副作用：创建 Documents 并挂上存储失败/报告回调；不调用插件工厂。
	constructor(
		host: AnyHost,
		served: Served,
		params: ParamsOf<Contract>,
		principal: Principal | undefined,
		key: string,
		identity: string,
		context: Context,
		chain: readonly string[],
	) {
		this.host = host;
		this.served = served;
		this.params = params;
		this.principal = principal;
		this.key = key;
		this.identity = identity;
		// 空参数用类型名，否则附加参数键，便于日志与错误定位。
		this.label = key === "" ? served.contract.name : `${served.contract.name}(${key})`;
		this.chain = chain;
		this.#context = context;
		const { store } = host;
		// Documents 需要存储命名空间（类型名）与失败回调；失败只在对象 live 时转成运行时失败。
		this.documents = new Documents({
			label: this.label,
			batch: host.batch,
			context,
			store: store === undefined ? undefined : { store, owner: served.contract.name },
			fail: (error) => {
				if (this.#state.kind === "live") this.failLive(this.#state.attempt, { kind: "broken", error });
			},
			report: (error) => host.report(error),
		});
	}

	/** The object's state as its references show it. */
	// 把内部 ObjectState 投影成引用可见的 RefState：failed/live/ended 直接映射，
	// activating 用 shown（loading 或等待失败），waiting 视为 loading。
	get state(): RefState {
		const state = this.#state;
		if (state.kind === "failed") return state.failure;
		if (state.kind === "live") return LIVE;
		if (state.kind === "ended") return state.ended;
		return state.kind === "activating" ? state.shown : LOADING;
	}

	/** Whether its state members have values: once live (a local object stays live until it ends). */
	// 只有 live 状态的实例才有可读的状态成员；activating/failed 时为 false。
	get hydrated(): boolean {
		return this.#state.kind === "live";
	}

	/** Resolves at its first outcome (the start barrier waits for it); never rejects. */
	// 幂等创建 Promise：#hasFirstOutcome 后直接返回已完成 Promise；否则复用或新建 resolvers。
	get firstOutcome(): Promise<void> {
		if (this.#hasFirstOutcome) return Promise.resolve();
		this.#firstOutcome ??= Promise.withResolvers<void>();
		return this.#firstOutcome.promise;
	}

	/**
	 * Whether an activation is under way: waiting for its previous instance's teardown, or activating and showing
	 * `loading` (its factory, its natives' opens, a dependency still loading); a parked wait (`failed { waiting }`) is not.
	 */
	// 用于 host.activationsUnderWay 与关闭/重载判断：parked 的 awaiting 不算激活中。
	get activating(): boolean {
		const state = this.#state;
		return state.kind === "waiting" || (state.kind === "activating" && state.shown.kind === "loading");
	}

	/** Whether it holds up the start barrier: it has no first outcome yet. */
	// 取反的标记读取；start barrier 遍历对象时用它筛选。
	get blocksFirstPass(): boolean {
		return !this.#hasFirstOutcome;
	}

	/**
	 * The error of its last failure while none went live since: a failed attempt's, or the cause its parked attempt
	 * showed last (kept when the dependency falls back to `loading`, so a getter's deadline names it).
	 */
	// getter 超时时用这个错误拒绝，而不是泛泛的 not_ready。
	get lastFailure(): ChordError | undefined {
		return this.#lastFailure;
	}

	/** Its instance id while an attempt activates; `undefined` otherwise (a hold's chain names only activations). */
	// 只有 activating 时暴露实例 id：链接 hold 用它构造跨宿主依赖链。
	get activationId(): string | undefined {
		return this.#state.kind === "activating" ? this.#instance : undefined;
	}

	/**
	 * The chain a hold this object's activation makes over a link carries (Q5): its own chain and its instance id, the
	 * last 32; `undefined` when it is not activating.
	 */
	// 链长度上限 CHAIN：只保留最近的部分，防止无限增长；末尾追加当前实例 id。
	// 例：chain=[]、正在激活时返回 [instanceId]。
	activationChain(): string[] | undefined {
		const id = this.activationId;
		if (id === undefined) return undefined;
		const { chain } = this;
		// 先截取最后 CHAIN-1 项，再追加 id，使总长不超过 CHAIN。
		return [...(chain.length < CHAIN ? chain : chain.slice(chain.length - CHAIN + 1)), id];
	}

	/** Its holders, for a presence list made after they took it. */
	// 返回内部 Set 的只读视图（不是拷贝）；调用方不应修改。
	get holders(): ReadonlySet<Holder> {
		return this.#holders;
	}

	/** The variant a live remote object's factory chose; `undefined` for a local object and before it is live. */
	// 远程契约的变体名决定成员表；本地对象没有变体概念。
	get variant(): string | undefined {
		return this.#state.kind === "live" ? this.#state.attempt.variant : undefined;
	}

	/** The live object's state members, as Chord follows them. */
	// 非 live 时 #live() 会抛出 not_ready/失败原因；调用者应先确认状态。
	get stateMembers(): ReadonlyMap<string, DeriveSource> {
		return this.#live().stateMembers;
	}

	/**
	 * Starts an attempt when waiting or failed and returns it; a trigger while an attempt runs (or once live) is ignored.
	 * After a failure the holders are told: their references are loading again.
	 */
	// 触发一次新的激活。输入无；输出 Attempt，若当前不能重试则 undefined。
	// 副作用：生成实例 id、把状态改为 activating、异步启动 #run、失败后通知 holders。
	// 例：退避窗口结束后 Backoff 调用此方法；live 状态重复调用不会产生新尝试。
	attempt(): Attempt | undefined {
		const state = this.#state;
		// 只有等待或失败的对象可以开始新尝试；activating/live/ended 忽略。
		if (state.kind !== "waiting" && state.kind !== "failed") return undefined;
		// 首次激活时生成实例 id；swap 不会走到这里（它直接创建 Attempt）。
		this.#instance ??= uuidv7();
		const attempt = new Attempt(this, this.#context);
		this.#state = { kind: "activating", attempt, shown: LOADING };
		// 从 failed 重新激活：先通知引用“回到 loading”。
		if (state.kind === "failed") this.#notify();
		// 不等待激活完成；teardown 依赖前序实例的 ending。
		void this.#run(attempt, this.host.endingOf(this.identity));
		return attempt;
	}

	/**
	 * `ref.retry()` and a `retry` message, as a step of `walk` (handled once per walk: a diamond reaches it twice): an
	 * attempt now when failed (a broken one too) or waiting, its backoff window skipped; passed on to the failed
	 * dependencies while parked `failed { waiting }`; ignored otherwise (an attempt runs, or it is live).
	 */
	// 显式重试。walk.visited 去重，防止菱形依赖重复处理；若正在激活且处于等待失败，则递归重试其依赖。
	// 若 waiting/failed：跳过退避窗口并立即 attempt；否则忽略。无返回值，副作用是状态变化与通知。
	retry(walk: RetryWalk = retryWalk()): void {
		if (walk.visited.has(this)) return;
		walk.visited.add(this);
		const state = this.#state;
		if (state.kind === "activating") {
			if (state.shown.kind === "failed") state.attempt.retryDependencies(walk);
			return;
		}
		if (state.kind !== "waiting" && state.kind !== "failed") return;
		this.host.backoff.skip(this.identity);
		this.attempt();
	}

	/**
	 * Follows `sources` as its wake signals instead of the last attempt's (`self.retryOn`, right after a factory
	 * returned): a new value retries it while failed, as `ref.retry()` does; one while it activates retries it at once
	 * if that attempt fails; one while live does nothing.
	 */
	// 注册唤醒源；同一对象复用 RetryWakes 实例并整体替换源列表。空列表且从未创建时直接返回，避免分配。
	retryOn(sources: readonly RetrySource[]): void {
		if (this.#wakes === undefined && sources.length === 0) return;
		this.#wakes ??= new RetryWakes();
		this.#wakes.replace(sources, () => this.#wake());
	}

	/**
	 * Calls a method of the live object for `caller`, bound at `version` (an older one maps its arguments and result,
	 * Q10). While a reload's pure swap runs, the call waits for its new attempt (the gate), bounded by `readyTimeout`.
	 */
	// 方法调用的对象侧入口。输入方法名、参数、调用上下文、调用者与消费者版本。
	// 若正处于 swap 的“门”期，先等待新尝试有结果；随后交给 live 实例执行（版本映射在 Attempt 内）。
	async call(method: string, args: unknown, context: Context, caller: Caller, version: number): Promise<unknown> {
		const state = this.#state;
		if (state.kind === "activating" && state.swap !== undefined) await this.#gate(state.swap, context);
		return this.#live().call(method, args, context, caller, version);
	}

	/**
	 * Whether a reload's pure swap runs in place: the new attempt neither parked nor failed yet. Holds stay bound
	 * meanwhile (their calls wait at the gate) and get a fresh `bound` once it is live.
	 */
	// 纯 swap 且新尝试尚未 park：旧实例仍被跟随，调用走门等待。
	get swapsInPlace(): boolean {
		const state = this.#state;
		return state.kind === "activating" && state.swap !== undefined && !state.swap.parked;
	}

	/** Whether a consumer of `contract`'s version and fingerprint binds to this object's provider now (R6, Q10). */
	// 委托给 provider.binds：版本相同，或 provider 的 accepts 能映射旧版本。
	binds(contract: Contract): boolean {
		return binds(this.served.provider, contract.version, contract.fingerprint);
	}

	/** Its params as checked, with their identity key. */
	// 返回新对象字面量，不复制 params 本身；供引用重新放置请求时使用。
	get checkedParams(): CheckedParams {
		return { params: this.params, key: this.key };
	}

	/**
	 * What a reference of `version` follows for state member `member` now (decision "References are the only
	 * indirection"): the shown instance's member (its mapping at an older version) while that instance is live, while a
	 * swap brings its successor in place, and after a live failure until its admitted commits published; else nothing:
	 * `failed` with the cause's error, or `loading`, with that member to take a last value from.
	 */
	// 引用读取状态成员时询问：现在应跟随哪个源。返回判别联合：
	// live（source+instance）、lacking（版本不匹配错误）、failed（失败原因+最后源）、loading（可带最后源）。
	// 输入成员名与消费者版本；无副作用，但 memberAt 可能抛契约错误。
	followed(member: string, version: number): Followed {
		const exposed = this.#exposed;
		let shown: DeriveSource | undefined;
		let lacking: ChordError | undefined;
		if (exposed !== undefined) {
			try {
				// memberAt 按消费者版本返回映射后的源；旧版本可能要求映射。
				shown = exposed.memberAt(member, version);
			} catch (error) {
				const failure = asChordError(error, this.label);
				// contract_mismatch 表示“这个实例还没有该版本”，属于暂时缺省；其他错误才是真正失败。
				// The shown instance does not serve this version (a swap's old one, while a reload brings it): nothing yet.
				if (failure.code !== "contract_mismatch") lacking = failure;
			}
		}
		// 仍在跟随旧实例：能读到就用 live；有真实错误则 lacking；否则 loading，让引用保留最后值。
		if (exposed !== undefined && this.#following) {
			if (shown !== undefined) return { kind: "live", source: shown, instance: exposed };
			if (lacking !== undefined) return { kind: "lacking", error: lacking };
			return { kind: "loading", last: undefined, instance: undefined };
		}
		const state = this.#state;
		// 没有可跟随实例时，根据对象当前状态给出失败或 loading；last 让引用在失败时仍能取最后值。
		const failure =
			state.kind === "failed"
				? state.failure
				: state.kind === "activating" && state.shown.kind === "failed"
					? state.shown
					: undefined;
		if (failure !== undefined) return { kind: "failed", error: failure.cause.error, last: shown, instance: exposed };
		return { kind: "loading", last: shown, instance: exposed };
	}

	/**
	 * The instance its references follow now (they attach to it; they take last values only from an instance they
	 * attached to); `undefined` once it stopped changing.
	 */
	// 用于 key 重新 pin 与订阅附着；只有 following 为 true 时暴露。
	get attachable(): Attempt | undefined {
		return this.#following ? this.#exposed : undefined;
	}

	/** The live instance, which references pin their keys on (a new one: they pin again); `undefined` when not live. */
	// 仅 live 状态返回当前 Attempt；activating 的新实例尚未可 pin。
	get instance(): Attempt | undefined {
		return this.#state.kind === "live" ? this.#state.attempt : undefined;
	}

	/** The live instance's state member `member` as a consumer of `version` follows it (a hold over a link). */
	// 链接上的 hold 直接取快照，不维护长期订阅；非 live 会抛错。
	liveMember(member: string, version: number): DeriveSource {
		return this.#live().memberAt(member, version);
	}

	/** How a consumer of `version` reads keyed member `member`'s documents: mapped back when older (`undefined`: as they are). */
	// 版本映射函数：旧消费者读新代码的 keyed 文档时需要反向映射；同版本返回 undefined。
	keyedMapping(member: string, version: number): ((current: JsonValue) => JsonValue) | undefined {
		return this.#live().keyMapping(member, version);
	}

	/** Waits until `swap` ended (its new attempt live, parked, failed, or the object ended). */
	// 门只等待 swap.done，不另设计时器；新尝试自身的步骤由 readyTimeout 限制。
	// context 取消只结束本次等待。
	async #gate(swap: Swap, context: Context): Promise<void> {
		// No timer of its own: the swap ends when its new attempt is live, parked or failed, and `readyTimeout` bounds
		// the new attempt's own steps (Fable).
		await awaitWithContext(swap.done.promise, context);
	}

	/** The keyed member `member` of the live object: its ultimate slot (slice 6a §12). */
	// 读取 keyed 成员句柄；重新暴露的成员会沿引用走到提供者的 slot。
	keyedMember(member: string): KeyedSlot {
		return this.#live().keyedMember(member);
	}

	/** Pins `key` of keyed member `member` on the live instance, as a consumer of `version` reads it (`Attempt.pinKey`). */
	// 委托 live 实例执行 pin；ReferenceKeys 负责跨实例的复用与释放。
	pinKey(member: string, key: string, version: number, context: Context): Promise<PinnedKey> {
		return this.#live().pinKey(member, key, version, context);
	}

	/**
	 * Counts `holder` as a reference to this object (the holder reads `state` itself), listed in its type's presence; a
	 * lingering object stays.
	 */
	// 登记引用。先检查 live 提供者是否接受该 holder 的版本/成员；不接受则不挂上，直接转成未绑定等待。
	// 副作用：加入 holders、取消 linger 计时、更新 presence。例：get 绑定成功后调用。
	hold(holder: Holder): void {
		// A version it binds whose member the live provider refuses (an older consumer): it waits unbound instead.
		const state = this.#state;
		const unfit = state.kind === "live" ? this.#unfit(holder, state.attempt) : undefined;
		if (unfit !== undefined) {
			this.#unbound(holder, unfit);
			return;
		}
		this.#holders.add(holder);
		this.#stopLingering();
		// Last: a derive over the presence list may close a link synchronously, which may release this holder again.
		this.host.referenced(this, holder, this.#context);
	}

	/** `holder` was released: the object may end (`#idle`). */
	// 释放引用。若 holder 不在集合中直接返回；随后清理该版本的共享映射、尝试进入 linger/结束，并更新 presence。
	// 最后更新 presence：监听 presence 的 derive 可能同步关闭链接并再次释放其他 holder。
	unhold(holder: Holder): void {
		if (!this.#holders.delete(holder)) return;
		this.#dropUnheld(holder.contract.version);
		this.#idle();
		// Last: a derive over the presence list may close a link synchronously, which releases other holders again.
		this.host.unreferenced(this, [holder], this.#context);
	}

	/**
	 * The records of job `definition`'s runs, made by its first declaration. A later declaration (a new attempt's, after a
	 * reload) at another version takes the records over (each run keeps its version, slice 7b §8); one at the same
	 * version with another fingerprint is refused (`checkJob`).
	 */
	// 每个对象按任务名保存一组 JobRecords，跨 attempt 与 reload 保留运行历史。
	// 首次声明创建记录并注入存储/计数/held 回调；之后重新声明先 check 再 redefine。
	jobRecords(definition: JobDefinition<unknown, unknown, unknown>): JobRecords {
		const records = this.#jobs.get(definition.name);
		if (records === undefined) {
			const { store } = this.host;
			// owner 是 JobRecords 需要的对象侧能力：文档、存储命名空间、运行计数与 held 截止时间。
			const owner = {
				label: this.label,
				host: this.host,
				context: this.#context,
				documents: this.documents,
				store: store === undefined ? undefined : { store, owner: this.served.contract.name },
				countRuns: (delta: number) => this.countRuns(delta),
				held: (deadline: number) => this.#heldUntil(deadline),
			};
			const made = new JobRecords(definition, owner);
			this.#jobs.set(definition.name, made);
			return made;
		}
		this.checkJob(definition);
		records.redefine(definition);
		return records;
	}

	/** Refuses a declaration of a job its records cannot take (`JobRecords.check`); a reload's staging checks it too. */
	// 只在已有记录时检查；首次声明无需比较。
	checkJob(definition: JobDefinition<unknown, unknown, unknown>): void {
		this.#jobs.get(definition.name)?.check(definition);
	}

	/**
	 * Claims table `table` (its SQL name) in the host's store for this object, until its end (slice 6b claims); held by
	 * another owner: `invalid/args`, which fails the declaring factory.
	 */
	// 表名归属检查；非空断言表明有 store 时 claims 才存在（由服务配置保证）。
	claimTable(table: string): void {
		this.host.store!.claims.table(table, this);
	}

	/** Claims this object's documents in `namespace` of the host's store, as `claimTable`. */
	// 文档命名空间按类型名隔离；同一对象不能与其他对象争用同一命名空间。
	claimDocuments(namespace: string): void {
		this.host.store!.claims.documents(this.served.contract.name, namespace, this);
	}

	/**
	 * A runtime failure of the live attempt `attempt`: `broken` (a `migrate` failing on access, a stored version newer
	 * than the code, a refused commit) or `transient` (a followed runtime failed, R4): the attempt is sealed and the
	 * object `failed` with `cause`; calls reject with it, holders are told, its references keep their last values once the
	 * admitted commits adopted (`followed`), the natives close in the background (then its references are released),
	 * `onError` gets `object_failed` once. Documents and job runs stay. Recovery: a broken failure by `ref.retry()`, a
	 * transient one after its identity's backoff too (a new attempt, whose members its references follow once live). A
	 * failure of a sealed attempt is ignored, so several at once fail it once.
	 */
	// 运行中失败处理。关键顺序：先标记 failed 并停止接收新调用，再等待文档已接纳提交落定（frozen），
	// 然后关闭 natives、解除引用；这样引用能在旧实例停止变化前取到最后值。
	failLive(attempt: Attempt, cause: FailureCause): void {
		const state = this.#state;
		// 只有当前 live 的同一实例才处理；已 seal 或已被替换的尝试的失败忽略（幂等）。
		if (state.kind !== "live" || state.attempt !== attempt) return;
		const { error } = cause;
		// transient 进入退避；broken 清除退避，等待显式 retry。
		if (cause.kind === "transient") this.host.backoff.failed(this.identity);
		else this.host.backoff.delete(this.identity);
		const failure: Failed = { kind: "failed", cause, retryAt: this.host.backoff.until(this.identity) };
		this.#state = { kind: "failed", failure };
		this.#lastFailure = error;
		// 先撤下注册表贡献，再 seal：读者不会看到失败实例的贡献。
		this.#withdraw(attempt);
		attempt.seal(error);
		// Its references follow every member on until the commits admitted before the seal adopted and published once
		// (frames included), then stop. A retry's factory and hydration wait for both (its ending), so no old commit
		// lands in a new attempt.
		const frozen = this.documents.settled().then(() => this.#stopFollowing(attempt));
		const closing = Promise.all([attempt.close(END), frozen]).then(([failures]) => {
			attempt.detach();
			attempt.releaseReferences();
			return failures;
		});
		// 结束被记录到 host.ending：同一 identity 的下一次尝试会等待它。
		this.host.ending(this.identity, this.#reported(closing));
		this.host.report({ kind: "object_failed", object: this.label, failure: cause });
		this.#notify();
		this.#idle();
	}

	/** A held state change must be stored by `deadline`: the timer is set for the earliest one. */
	// 只保留一个计时器：若已有更早截止时间则不动；否则清除旧计时器，按最早截止时间重设。
	#heldUntil(deadline: number): void {
		if (this.#flush !== undefined && this.#flush.deadline <= deadline) return;
		if (this.#flush !== undefined) clearTimeout(this.#flush.timer);
		// A foreground timer: what is held is stored before the process may exit.
		const timer = setTimeout(() => void this.#flushHeld(), Math.max(0, deadline - Date.now()));
		this.#flush = { deadline, timer };
	}

	/** The timer fired: every held change past its deadline is stored, and the timer set for the next one. */
	// 异步落盘本轮到期的 held 状态；随后找出下一个截止时间，若有限则继续安排。
	async #flushHeld(): Promise<void> {
		this.#flush = undefined;
		// 对象已结束则不再写存储。
		if (this.#state.kind === "ended") return;
		const now = Date.now();
		const jobs = [...this.#jobs.values()];
		await Promise.all(jobs.map((records) => records.flushHeld(now)));
		// Math.min 对空数组返回 Infinity，Number.isFinite 过滤“没有下一个截止时间”。
		const next = Math.min(...jobs.map((records) => records.nextDeadline()));
		if (Number.isFinite(next)) this.#heldUntil(next);
	}

	/**
	 * Adds `delta` to its running and finishing job runs (and `host.activity.jobs`). A new run keeps a lingering object;
	 * the last one settling on an object without references ends it as its last release would (`#idle`).
	 */
	// delta > 0 表示新运行开始，取消 linger；归零时重新评估是否应结束对象。
	countRuns(delta: number): void {
		this.#runs += delta;
		this.host.count("jobs", delta);
		// A run started while the object lingers keeps it, like a new reference.
		if (delta > 0) this.#stopLingering();
		if (this.#runs === 0) this.#idle();
	}

	/**
	 * Throws `invalid/cycle` when waiting for `dependency` closes a chain of waits back to this object (Q5). Every other
	 * object on the chain fails broken with the same error, so no part of a cycle waits for a retry. Counts the objects
	 * it visits (`chord.cycle.visits`). Otherwise, a dependency whose activation is in this object's chain closes a
	 * cycle through other hosts (they fail through their dependency on this one).
	 */
	// 依赖环检查：先沿当前 parked 依赖链做深度优先搜索；找到环则让环上其他激活 attempt 以同一错误失败，
	// 再抛出。未找到时检查跨宿主环（依赖的 activationId 在本对象链中）。
	assertNoCycle(dependency: Target, context: Context): void {
		const visited = new Set<Target>();
		const cycle = dependency.pathTo(this, visited);
		// 遥测计数：本对象在本次检查中访问了多少对象；? 表示无 metrics 适配器时不记录。
		context.telemetry.metrics?.counter("chord.cycle.visits").add(visited.size);
		if (cycle === undefined) {
			// 跨宿主：本对象创建时携带的链若包含依赖的激活 id，说明链在别处绕回。
			const across = dependency.activationId;
			if (across === undefined || !this.chain.includes(across)) return;
			throw this.host.cycle(this.chain, across, [this.label, dependency.label]);
		}
		const error = invalid("cycle", `dependency cycle: ${[this, ...cycle].map(({ label }) => label).join(" → ")}`);
		// 让环上其他对象的进行中尝试立即失败，避免只有当前对象报错而其余继续等待。
		for (const object of cycle) {
			const state = object.#state;
			if (object !== this && state.kind === "activating") {
				state.attempt.abandon({ kind: "failed", cause: { kind: "broken", error } });
			}
		}
		throw error;
	}

	/** Its parked attempt waits for `dependencies` (none once it leaves parking): the waits a cycle check follows. */
	// 每次进入/离开 parking 时由 Attempt 更新；空列表复用共享常量。
	waitsFor(dependencies: readonly Dependency[]): void {
		this.#waitingFor = dependencies;
	}

	/**
	 * A dependency of its current attempt changed (its state, or its first outcome): a parked attempt checks again; an
	 * attempt past its dependency check ignores it (R18 after live), and so does any other state.
	 */
	// 只转发给 activating 的 attempt；Attempt 内部判断是否真的在 parking。
	dependencyMoved(): void {
		const state = this.#state;
		if (state.kind === "activating") state.attempt.dependencyMoved();
	}

	/**
	 * Its attempt `attempt` is parked showing `shown` (`loading` or `failed { waiting }`): holders are told when that
	 * changed (a cause compared by value). `firstPass`: no blocker here is still without its first outcome, so this
	 * object has its first outcome now.
	 */
	// Attempt 因依赖停驻时回调。swap 的新尝试首次 park 需要特殊处理（撤下旧贡献、打开门）。
	// shown 变化才通知 holders；firstPass 为 true 表示本对象首次结局已可结算。
	parked(attempt: Attempt, shown: RefState, firstPass: boolean): void {
		const state = this.#state;
		if (state.kind !== "activating" || state.attempt !== attempt) return;
		const { swap } = state;
		// parks 只在新 swap 第一次 park 时为 true；后续 park 状态变化照常通知。
		// A swap's new attempt parks (decision 4): no overlap of old and new code, holders see what it shows.
		const parks = swap !== undefined && !swap.parked;
		if (parks) this.#swapParked(swap);
		if (parks || !sameState(state.shown, shown)) {
			// 保留 swap 字段：使用条件展开，避免在无 swap 时写入 undefined 字段。
			this.#state = { kind: "activating", attempt, shown, ...(swap === undefined ? {} : { swap }) };
			if (shown.kind === "failed") this.#lastFailure = shown.cause.error;
			this.#notify();
		}
		if (firstPass) this.#settleFirstOutcome();
	}

	/** Its attempt `attempt` left parking for its own steps: it shows `loading` until its outcome. */
	// 离开 parking 后对外显示 loading；若已是 loading 则不重复通知。
	unparked(attempt: Attempt): void {
		const state = this.#state;
		if (state.kind !== "activating" || state.attempt !== attempt) return;
		if (!sameState(state.shown, LOADING)) this.parked(attempt, LOADING, false);
	}

	/** A swap's new attempt parked: the old attempt's contributions leave the tables (it is not live any more). */
	// swap 新尝试 park 意味着旧代码不能继续提供服务：撤下旧贡献并打开门，让等待调用去读新状态。
	#swapParked(swap: Swap): void {
		swap.parked = true;
		this.#withdraw(swap.old);
		swap.done.resolve();
	}

	/**
	 * Ends the object (once): sealed now, its holders and running calls told `error` (`released` by default), torn down
	 * in the background with reason `end`, close failures reported.
	 */
	// 默认错误是 released/ended；#seal 幂等，已结束返回 none 时不再登记 teardown。
	end(error: ChordError = this.ended()): void {
		const teardown = this.#seal({ kind: "end", error });
		if (teardown.kind !== "none") this.host.ending(this.identity, this.#reported(this.#tearDown(teardown, END)));
	}

	/**
	 * Ends the object for `host.close`: sealed now; returns its teardown (reason `close`), which the host runs once every
	 * object is sealed, so no reference it releases starts an ending in the background.
	 */
	// 与 end 不同：不在这里登记 ending，而把清理函数交给宿主统一执行，保证所有对象先 seal。
	stop(): () => Promise<CloseFailed[]> {
		const teardown = this.#seal({ kind: "end", error: this.ended() });
		return () => this.#tearDown(teardown, CLOSE);
	}

	/**
	 * Ends the object because a reload removed its type (slice 7b §4): as `end` (natives close with reason `end`,
	 * running calls' callers rejected `released`, handlers drained), but its holders' requests are not ended: they wait
	 * unbound with `cause` (`not_served`), references with their last values, until the next object of its identity
	 * binds them (`Removal`).
	 */
	// 与 end 的差别只在 Ending.kind：seal 时把 holders 转到 removed 等待，而不是结束。
	remove(cause: FailureCause): void {
		const teardown = this.#seal({ kind: "removed", error: this.ended(), cause });
		if (teardown.kind !== "none") this.host.ending(this.identity, this.#reported(this.#tearDown(teardown, END)));
	}

	/**
	 * What a reload with `recorded` (the new factory's declarations) does to this object, whose type is still served:
	 * a live object swaps in place when neither its live attempt nor the new factory opens natives and no table of the
	 * new factory is newer than the store's, else it restarts; any other is retried.
	 */
	// 判定顺序：非 live 一律 retry；有 native 或涉及表迁移则 restart（需先排空/关闭）；否则纯 swap。
	reloadFate(recorded: Recorded): ReloadFate {
		const state = this.#state;
		if (state.kind !== "live") return "retry";
		if (state.attempt.opensNatives || recorded.natives > 0 || migratesTables(this, recorded)) return "restart";
		return "swap";
	}

	/**
	 * Takes `fate` with its new served type (after the reload's commit); returns the new attempt, whose first
	 * dependency check the reload's report waits for.
	 */
	// 先替换 served，让新尝试使用新契约/工厂；startedByReload 标记用于重载报告。
	reload(served: Served, fate: ReloadFate): Attempt {
		// Its members per version stay: the previous version's are mapped once the new attempt goes live.
		this.served = served;
		const attempt = fate === "swap" ? this.#swap() : fate === "restart" ? this.#restart() : this.#retryReloaded();
		attempt.startedByReload();
		return attempt;
	}

	/**
	 * A pure swap (slice 7b §5): a new attempt of the same object (its documents, line and job records, its instance id),
	 * its activation at once; the live attempt keeps its running calls, its routines aborted, its jobs handed over,
	 * and is sealed once its calls settled and the new attempt's requests bound (`#retire`). Calls arriving meanwhile
	 * wait at the gate.
	 */
	// 状态从 live 直接变成带 swap 的 activating；旧 attempt 进入 retiring 集合，但其调用继续运行直到 drain。
	// 例：reload 后 getter 的调用先 await #gate，新尝试 live 后由新实例执行。
	#swap(): Attempt {
		// A swap starts from a live object (`reloadFate`).
		const old = (this.#state as Extract<ObjectState, { readonly kind: "live" }>).attempt;
		const ending = this.host.endingOf(this.identity);
		const attempt = new Attempt(this, this.#context);
		const swap: Swap = { old, parked: false, done: Promise.withResolvers() };
		this.#state = { kind: "activating", attempt, shown: LOADING, swap };
		old.handOver();
		this.#retiringAdd(old, this.#retire(swap));
		this.#notify();
		void this.#run(attempt, ending);
		return attempt;
	}

	/**
	 * Keeps `retire` (a swapped-out attempt's) until it settled: a restart, an end and the host's close wait for it; a
	 * later swap does not (it holds no natives, its documents are the object's: Fable, Opus F1), so a second reload is
	 * never held up by the first one's old calls.
	 */
	// retiring 映射延迟创建；finally 清掉自己，即使 retire 拒绝也不会留下条目。
	#retiringAdd(old: Attempt, retire: Promise<void>): void {
		this.#retiring ??= new Map();
		const retiring = this.#retiring;
		retiring.set(old, retire);
		void retire.finally(() => {
			retiring.delete(old);
		});
	}

	/** Its swapped-out attempts still retiring, as one wait; `undefined` when none is. */
	// 无 retiring 或为空返回 undefined，调用方可跳过等待；否则合并为一个 Promise。
	#retiringNow(): Promise<void> | undefined {
		const retiring = this.#retiring;
		if (retiring === undefined || retiring.size === 0) return undefined;
		return Promise.all(retiring.values()).then(() => {});
	}

	/**
	 * Seals a swapped attempt once its running calls (and routine calls) settled, bounded by `closeTimeout`, and the swap
	 * ended (the new attempt live, parked, failed: its requests bound, so no request it shares with the old one ends in
	 * between, M§3.9, and its holders compared the old members with the new); a parked swap's references take their last
	 * values from it once the commits it admitted before the seal published; then its references are released. Its job
	 * invocations run on, on their old code.
	 */
	// 等待顺序很重要：先排空旧调用并等 swap 门结束，再 seal；随后等文档落定，停止跟随，关闭 natives，解绑引用。
	async #retire({ old, done }: Swap): Promise<void> {
		await Promise.all([old.drainCalls(), done.promise]);
		old.seal(this.#reloaded());
		// A parked swap's old instance stops changing once its admitted commits published (its successor, live, took over
		// its references before).
		await this.documents.settled();
		this.#stopFollowing(old);
		const failures = await old.close(END);
		old.detach();
		old.releaseReferences();
		// 关闭失败逐条报告给 onError，不中断清理。
		for (const failure of failures) this.host.report(failure);
	}

	/**
	 * A native restart (decision "A native restart drains first"): new calls park (it shows `loading`), its
	 * contributions leave, the live attempt's running calls drain (bounded by `closeTimeout`), then it is sealed (its
	 * in-memory job runs end `aborted { reload }`), its references take their last values once its admitted commits
	 * published, its natives close with reason `reload`; the new attempt, a new instance (D4), activates after that
	 * teardown.
	 */
	// restart 生成新实例 id；旧尝试的 teardown 异步进行，新尝试等待 host.ending 后再运行。
	// 例：带数据库连接的插件 reload 时先排空旧调用，再以 reload 原因关闭连接。
	#restart(): Attempt {
		const old = (this.#state as Extract<ObjectState, { readonly kind: "live" }>).attempt;
		this.#withdraw(old);
		old.stopRoutines();
		this.#instance = uuidv7();
		const teardown = (async () => {
			await Promise.all([old.drainCalls(), this.#retiringNow()]);
			old.seal(this.#reloaded(), "reload");
			// Drained and sealed: its references take their last values once the commits it admitted before published
			// (a store write is not a running call's promise; Sol).
			await this.documents.settled();
			this.#stopFollowing(old);
			const failures = await old.close(RELOAD);
			old.detach();
			old.releaseReferences();
			return failures;
		})();
		this.host.ending(this.identity, this.#reported(teardown));
		const attempt = this.#replace();
		void this.#run(attempt, this.host.endingOf(this.identity));
		return attempt;
	}

	/**
	 * A reload retries an object that is not live (slice 7b §9, decision 1): a parked attempt is replaced in one
	 * handover (it opened nothing: the new attempt's requests bind before the old ones are released, M§3.9); an attempt
	 * in its own steps is sealed, its natives close with reason `reload`, and the new one activates after that teardown;
	 * a failed or waiting one gets an attempt now, its backoff skipped.
	 */
	// 三种分支：activating（parked 或自己的步骤中）、waiting/failed。
	// parked 的继任者不必等旧 teardown 即可运行；非 parked 则让新尝试等待旧关闭完成。
	#retryReloaded(): Attempt {
		const state = this.#state;
		if (state.kind === "activating") {
			const { attempt: old, swap } = state;
			if (swap !== undefined && !swap.parked) this.#swapParked(swap);
			swap?.done.resolve();
			const parked = old.isParked;
			// A parked attempt's successor waits for no teardown of it (its references are released after it bound).
			const ending = this.host.endingOf(this.identity);
			old.seal(this.#reloaded(), "reload");
			const attempt = this.#replace();
			if (parked) void this.#run(attempt, ending);
			const after = parked ? attempt.checked : Promise.resolve();
			const closing = after
				.then(() => old.close(RELOAD))
				.then((failures) => {
					old.detach();
					old.releaseReferences();
					return failures;
				});
			this.host.ending(this.identity, this.#reported(closing));
			if (!parked) void this.#run(attempt, this.host.endingOf(this.identity));
			return attempt;
		}
		this.host.backoff.skip(this.identity);
		// Waiting or failed (`reloadFate`): an attempt starts.
		return this.attempt()!;
	}

	/** A new attempt replacing the current one, holders told; its caller starts it (`#run`) after what it waits for. */
	// 只设置状态并通知，不启动激活；调用者决定何时 #run。
	#replace(): Attempt {
		const attempt = new Attempt(this, this.#context);
		this.#state = { kind: "activating", attempt, shown: LOADING };
		this.#notify();
		return attempt;
	}

	/** The `released` error of an attempt a reload replaced. */
	// reason 为 ended：旧实例的运行中调用者收到“已被重载替换”。
	#reloaded(): ChordError {
		return new ChordError({ code: "released", reason: "ended", message: `${this.label}: replaced by a reload` });
	}

	/** The `released` error of this object. */
	// 对象最后一次结束的默认原因；与“宿主关闭”的 released/closed 区分。
	ended(): ChordError {
		return new ChordError({ code: "released", reason: "ended", message: `${this.label}: ended` });
	}

	/** Runs `attempt`'s activation once `ending` (its predecessors' teardowns, if any) finished; takes its outcome. */
	// 等待前序清理后激活；激活结果只有 live/failed 两种。若对象已结束或被替换，结果丢弃。
	async #run(attempt: Attempt, ending: Promise<void> | undefined): Promise<void> {
		const outcome = await attempt.activate(ending);
		// The object may have ended after the activation's last step.
		if (this.#state.kind !== "activating" || this.#state.attempt !== attempt) return;
		switch (outcome.kind) {
			case "live":
				return this.#wentLive(attempt);
			case "failed":
				return this.#failed(attempt, outcome.cause);
		}
	}

	// 新尝试 live：先处理版本不再匹配的 holder，再切换状态/跟随实例，提交注册表贡献，通知引用，最后交接任务。
	// 顺序保证：贡献在“别人看到 live”之前进入表；失败清空；firstOutcome 结算。
	#wentLive(attempt: Attempt): void {
		// 激活成功后唤醒信号不再需要在“激活中”记录。
		if (this.#wakes !== undefined) this.#wakes.during = undefined;
		const swap = this.#swapOf(attempt);
		// Before the new instance is shown: holders of a version its provider does not bind leave with their last values,
		// which their references take from the instance shown so far.
		const unbound = this.#unbindUnfit(attempt);
		this.#state = { kind: "live", attempt };
		this.#exposed = attempt;
		this.#following = true;
		const { contributions } = attempt;
		// The old attempt's contributions leave in the batch the new ones enter (slice 7b §5), so no reader sees a gap.
		const leaving = swap !== undefined && !swap.parked ? swap.old.contributions : NO_CONTRIBUTIONS;
		// In the registries' tables before anyone sees it live (a getter released now reads them recomposed).
		if (contributions.length > 0 || leaving.length > 0) {
			this.host.batch.within(() => {
				for (const contribution of leaving) contribution.record.remove(contribution);
				for (const contribution of contributions) contribution.record.add(contribution);
			}, this.#context);
			// Contributions entering a registry nobody serves are reported as at a publication.
			for (const contribution of contributions) contribution.record.reportUndeclared();
		}
		this.#lastFailure = undefined;
		this.host.wentLive(this);
		// Its references move to the new instance (one frame each); holds get a fresh `bound`.
		this.#notify();
		this.#settleFirstOutcome();
		swap?.done.resolve();
		// A swap's routines start once the old attempt's routine calls finished (the handover, §14).
		attempt.live(swap?.old);
		this.#takeJobs(attempt);
		// Its last holders may have left for their version: it ends as at their release.
		if (unbound) this.#idle();
	}

	/**
	 * After `attempt` went live: the jobs it does not declare block their runs (slice 7b §8); after a reload, the blocked
	 * runs of the jobs it declares are retried.
	 */
	// 没有任务时直接返回，避免遍历；undeclare 只影响旧代码声明的任务记录。
	#takeJobs(attempt: Attempt): void {
		if (this.#jobs.size === 0) return;
		const reloaded = attempt.reloadStarted;
		for (const [name, records] of this.#jobs) {
			if (!attempt.declaresJob(name)) records.undeclare();
			else if (reloaded) void records.retryBlocked(this.#context);
		}
	}

	/**
	 * Its holders whose version `attempt`'s provider (going live) does not bind (a reload dropped it, slice 7b §6), or
	 * of which it refuses a member (`contract_mismatch`), leave it: they wait unbound `version` (`failed { waiting }`),
	 * references with their last values, until a publication serves their version again. The object and its other
	 * holders stay.
	 */
	// 先收集不匹配的 holder，再统一移除并更新 presence，最后逐个转入未绑定等待。
	// 返回是否移除了任何 holder，供 #wentLive 判断对象是否因此空闲。
	#unbindUnfit(attempt: Attempt): boolean {
		let unfit: [Holder, ChordError][] | undefined;
		for (const holder of this.#holders) {
			const error = this.#unfit(holder, attempt);
			if (error === undefined) continue;
			unfit ??= [];
			unfit.push([holder, error]);
		}
		if (unfit === undefined) return false;
		for (const [holder] of unfit) this.#holders.delete(holder);
		this.host.unreferenced(
			this,
			unfit.map(([holder]) => holder),
			this.#context,
		);
		for (const [holder, error] of unfit) this.#unbound(holder, error);
		return true;
	}

	/** Whether a holder of `version` holds it. */
	// 线性扫描；holder 数量通常很小，避免额外索引。
	#heldAt(version: number): boolean {
		for (const holder of this.#holders) if (holder.contract.version === version) return true;
		return false;
	}

	/**
	 * Why `holder` cannot bind to `attempt` (live): its version is not one the provider binds, or the provider refuses a
	 * member of it (`contract_mismatch`); `undefined` when it binds.
	 */
	// 版本与指纹都相同直接可绑；否则 provider.binds 判断是否能映射；能映射但成员被拒时由 refusal 给出错误。
	#unfit(holder: Holder, attempt: Attempt): ChordError | undefined {
		const { contract, provider } = this.served;
		const { version, fingerprint } = holder.contract;
		if (version === contract.version && fingerprint === contract.fingerprint) return undefined;
		if (binds(provider, version, fingerprint)) return refusal(this.served, version, attempt.variant);
		return new ChordError({ code: "contract_mismatch", message: `${contract.name} v${version} is not served here` });
	}

	/**
	 * `holder` (no longer held) waits unbound with `error` (`failed { waiting }`) until a publication fits it.
	 */
	// 构造 waiting 失败原因并交给 holder.removed；引用据此保留最后值并等待下一次发布。
	#unbound(holder: Holder, error: ChordError): void {
		const cause: FailureCause = { kind: "waiting", error };
		holder.removed({ cause, host: this.host, params: this.checkedParams, context: this.#context });
	}

	/** The swap `attempt` (still the current one) ends: `undefined` when it is no swap's new attempt. */
	// 必须同时匹配状态为 activating、当前 attempt 身份，避免旧尝试的回调误认新 swap。
	#swapOf(attempt: Attempt): Swap | undefined {
		const state = this.#state;
		return state.kind === "activating" && state.attempt === attempt ? state.swap : undefined;
	}

	/**
	 * Records a failed attempt: reported, torn down in the background (reason `end`), its references released once its
	 * natives closed, its holders told. Transient: a backoff window, whose end is the failure's `retryAt`; broken: no
	 * automatic retry.
	 */
	// 与 failLive 类似，但处理的是激活阶段失败。wokenBy 记录“激活期间收到过唤醒信号”，失败后立即重试一次。
	#failed(attempt: Attempt, cause: FailureCause): void {
		const swap = this.#swapOf(attempt);
		// swap 的新尝试失败：旧贡献撤下并打开门，等待调用不再卡在门后。
		if (swap !== undefined && !swap.parked) this.#swapParked(swap);
		swap?.done.resolve();
		const wokenBy = this.#wakes?.during === attempt;
		if (this.#wakes !== undefined) this.#wakes.during = undefined;
		if (cause.kind === "transient") this.host.backoff.failed(this.identity);
		else this.host.backoff.delete(this.identity);
		const failure: Failed = { kind: "failed", cause, retryAt: this.host.backoff.until(this.identity) };
		this.#state = { kind: "failed", failure };
		this.#lastFailure = cause.error;
		attempt.seal(this.ended());
		const closing = attempt.close(END).then((failures) => {
			attempt.detach();
			// Released once its natives closed (a close may use them, §6, §13).
			attempt.releaseReferences();
			return failures;
		});
		this.host.ending(this.identity, this.#reported(closing));
		this.host.report({ kind: "activation_failed", object: this.label, failure: cause });
		this.#notify();
		this.#settleFirstOutcome();
		// Job runs kept it while it activated; failed, they keep it no longer.
		this.#idle();
		// A wake signal arrived while it activated: it retries it now.
		if (wokenBy) this.retry();
	}

	/**
	 * A wake signal's new value (inside its batch): retries a failed object (after the batch: a factory may not run in
	 * one), remembered while it activates, ignored while live and when its own contributions' leaving made it.
	 */
	// #wakes 由 retryOn 创建后才会有回调；! 断言表示调用来源保证了这一点。
	#wake(): void {
		const state = this.#state;
		// Called by its wakes only.
		const wakes = this.#wakes!;
		if (state.kind === "activating") {
			// While parked its dependencies decide (dependency model §3.8).
			if (!state.attempt.isParked) wakes.during = state.attempt;
			return;
		}
		// 仅 failed 且不是“自己的贡献撤离”触发的唤醒才重试；queueMicrotask 把工厂调用移出当前批次。
		if (state.kind !== "failed" || wakes.leaving) return;
		queueMicrotask(() => this.retry());
	}

	/**
	 * The live attempt `attempt` leaves the registries' tables (it fails or ends), inside a batch; a composition this
	 * leaving makes wakes no wake signal of this object.
	 */
	// 无贡献时直接返回；否则在批次内移除，并用 flushing 标记屏蔽“离开导致的组合变化”对自身的唤醒。
	#withdraw(attempt: Attempt): void {
		const { contributions } = attempt;
		if (contributions.length === 0) return;
		const { batch } = this.host;
		const wakes = this.#wakes;
		batch.within(() => {
			if (wakes !== undefined) {
				wakes.leaving = true;
				batch.flushing(() => {
					wakes.leaving = false;
				});
			}
			for (const contribution of contributions) contribution.record.remove(contribution);
		}, this.#context);
	}

	/**
	 * `attempt`, the instance shown, stopped changing (a live failure's admitted commits published, a restart's drain, a
	 * swapped or parked old instance retiring): its references take their last values from it, holds leave it, and the
	 * object lets it go (a reference made later never attached to it: it takes nothing from it).
	 */
	// 幂等：仅当仍跟随该实例时才有动作；先置 following=false 并通知（引用立即重定向/取最后值），再清空 exposed。
	#stopFollowing(attempt: Attempt): void {
		if (this.#exposed !== attempt || !this.#following) return;
		this.#following = false;
		this.#notify();
		// Its references took their values (`#notify` retargets them at once): a failed object keeps no ended instance.
		this.#exposed = undefined;
	}

	/** Tells every holder that the state changed: references first follow what it shows now (`followed`). */
	// 先 retarget（可能需要批次以合并帧），再 moved。复制 holders 数组，避免回调中增删导致遍历问题。
	#notify(): void {
		const holders = [...this.#holders];
		// In one batch when some reference's members move (one frame each, a diamond over several sees one change); no
		// commit at all for references that used none (activation churn).
		const retarget = (): void => {
			for (const holder of holders) holder.retarget();
		};
		if (holders.some((holder) => holder.following)) this.host.batch.within(retarget, this.#context);
		else retarget();
		for (const holder of holders) holder.moved();
	}

	/**
	 * Marks the object ended: forgotten by the host, waits rejected, references to it ended with `error` (and gone from
	 * its type's presence), its job runs ended (signals fired, waiters rejected), its transactions refused, its attempt
	 * sealed. Returns what is left to tear down; it releases nothing itself.
	 */
	// 关键点：先标记 ended 并清理周边状态，再同步通知 holders；teardown（关闭 natives、释放引用、删除文档）由调用者执行。
	// 返回 Teardown 描述，保证“先全部 seal，再逐个清理”的关闭顺序。
	#seal(ending: Ending): Teardown {
		const { error } = ending;
		const state = this.#state;
		if (state.kind === "ended") return { kind: "none" };
		const endings = this.host.endingOf(this.identity);
		// Its ending rejects the callers of its swapped-out attempts' calls too, at once.
		if (this.#retiring !== undefined) for (const old of this.#retiring.keys()) old.seal(error);
		const retiring = this.#retiringNow();
		// Its swapped-out attempts end before its teardown completes (they share its documents).
		const previous = retiring === undefined ? endings : Promise.all([endings, retiring]).then(() => {});
		this.#state = { kind: "ended", ended: { kind: "ended", error } };
		for (const records of this.#jobs.values()) records.end(error);
		if (this.#flush !== undefined) clearTimeout(this.#flush.timer);
		this.#flush = undefined;
		this.documents.seal();
		this.#stopLingering();
		this.#wakes?.stop();
		this.host.forget(this);
		// An object of the start barrier's cohort that ends before its first outcome settles it as ended.
		this.#settleFirstOutcome();
		// Sealed: its instance stops changing; its references take their last values from it.
		this.#following = false;
		const holders = [...this.#holders];
		this.#holders.clear();
		this.host.unreferenced(this, holders, this.#context);
		// Its type removed: its references wait with their last values, which they take from the instance shown (still
		// here); otherwise they end with it.
		const removal: Removal | undefined =
			ending.kind === "removed"
				? { cause: ending.cause, host: this.host, params: this.checkedParams, context: this.#context }
				: undefined;
		for (const holder of holders) {
			if (removal === undefined) holder.end(error);
			else holder.removed(removal);
		}
		this.#exposed = undefined;
		if (state.kind === "activating" && state.swap !== undefined) {
			if (!state.swap.parked) this.#withdraw(state.swap.old);
			state.swap.old.seal(error);
			state.swap.done.resolve();
		}
		// A failed attempt is closed (or closing) since it failed.
		if (state.kind === "waiting" || state.kind === "failed") return { kind: "end", previous };
		if (state.kind === "live") this.#withdraw(state.attempt);
		state.attempt.seal(error);
		return { kind: "close", attempt: state.attempt, previous };
	}

	/**
	 * The last holder of `version` left: the shown instance's shared mapping for it goes (Opus F2), so a long-lived
	 * object keeps no mapped value nobody reads.
	 */
	// 仍有同版本 holder 时保留映射；否则让当前实例丢弃该版本缓存。
	#dropUnheld(version: number): void {
		if (this.#heldAt(version)) return;
		this.#exposed?.dropVersion(version);
	}

	/**
	 * A remote object or a local one with params ends once it has no references and no running or finishing job runs:
	 * a live one once its type's `linger` passed without a new reference, any other at once.
	 */
	// 以下四项任一成立即保活：有 holder、有运行中的任务、宿主生命周期对象（本地空参数）。
	// 已有 linger 计时器时不重复安排；非 live 或 linger=0 立即结束。
	#idle(): void {
		const kind = this.#state.kind;
		// A run waiting for a live attempt keeps its object only while one is live or activating.
		const running = this.#runs > 0 && (kind === "live" || kind === "activating");
		const kept = this.#holders.size > 0 || running || (this.served.kind === "local" && this.served.hostLifetime);
		if (kept || this.#state.kind === "ended" || this.#lingering !== undefined) return;
		if (this.#state.kind !== "live" || this.served.linger === 0) {
			this.end();
			return;
		}
		// A new holder clears the timer (`hold`), so an expiry finds none.
		this.#lingering = setTimeout(() => {
			this.#stopLingering();
			this.end();
		}, this.served.linger);
		this.host.count("lingering", 1);
	}

	/** Its linger timer stops (a new holder, its expiry, its end): no longer counted as lingering. */
	// 计时器存在才减计数；重复调用安全。
	#stopLingering(): void {
		if (this.#lingering === undefined) return;
		clearTimeout(this.#lingering);
		this.#lingering = undefined;
		this.host.count("lingering", -1);
	}

	/**
	 * Once the previous teardowns finished (a failed attempt's closes may read the documents): drains and closes a
	 * sealed attempt, then releases its references (after the closes, which may use them), then waits for an admitted
	 * commit step to adopt and drops the documents and job runs. Resolves with the closes that threw.
	 */
	// 清理顺序固定：等前序 → 关 attempt → detach/releaseReferences → 等文档落定 → 结束文档 → 释放表声明 → 丢弃任务记录。
	// kind 为 end 时无需关闭 attempt（它已失败并自行关闭）。
	async #tearDown(teardown: Teardown, reason: NativeCloseReason): Promise<CloseFailed[]> {
		if (teardown.kind === "none") return [];
		await teardown.previous;
		const failures = teardown.kind === "close" ? await teardown.attempt.close(reason) : [];
		if (teardown.kind === "close") {
			teardown.attempt.detach();
			teardown.attempt.releaseReferences();
		}
		await this.documents.settled();
		this.documents.end();
		this.host.store?.claims.release(this);
		for (const records of this.#jobs.values()) records.drop();
		this.#jobs.clear();
		return failures;
	}

	/** Reports the close failures of a teardown nobody waits for. */
	// 逐个调用 host.report，把 close_failed/close_timeout 交给 onError。
	async #reported(closing: Promise<CloseFailed[]>): Promise<void> {
		for (const failure of await closing) this.host.report(failure);
	}

	/**
	 * The live attempt; `not_ready` before the object went live and while it activates again, the cause while failed,
	 * `released` once it ended.
	 */
	// 内部调用的统一入口：把非 live 状态转成对应的 ChordError，避免调用者读到空实例。
	#live(): Attempt {
		const state = this.#state;
		if (state.kind === "live") return state.attempt;
		if (state.kind === "ended") throw this.ended();
		if (state.kind === "failed") throw state.failure.cause.error;
		throw new ChordError({ code: "not_ready", message: `${this.label}: not live yet` });
	}

	/** The settlement of its first outcome (once): dependents parked on it check their first pass again. */
	// 只结算一次；resolve 后清空 resolvers，避免保留闭包。通知每个 holder 的 dependent 重新检查依赖。
	#settleFirstOutcome(): void {
		if (this.#hasFirstOutcome) return;
		this.#hasFirstOutcome = true;
		this.#firstOutcome?.resolve();
		this.#firstOutcome = undefined;
		for (const holder of this.#holders) holder.dependent?.dependencyMoved();
	}

	/** The chain of waits from this activation to `target` (see `Target`), through its parked attempt's dependencies. */
	// 深度优先搜索：this===target 即闭环；visited 防止无限递归。返回从 this 到 target 的对象数组。
	// 例：A 等 B、B 等 C、C 等 A 时，从 A.pathTo(A) 返回 [A,B,C,A]? 实际由调用方起点决定，返回路径含起点。
	pathTo(target: ChordObject, visited: Set<Target>): ChordObject[] | undefined {
		if (this === target) return [this];
		visited.add(this);
		for (const dependency of this.#waitingFor) {
			const next = dependency.kind === "reference" ? dependency.binding.target : undefined;
			if (next === undefined || visited.has(next)) continue;
			const rest = next.pathTo(target, visited);
			if (rest !== undefined) return [this, ...rest];
		}
		return undefined;
	}
}

/** Whether two states of a reference say the same: the same object, or failures with the same cause (by value). */
// 身份相同直接相等；否则只有双方都是 failed 且重试时间与失败原因按值相同才算同状态。
// sameCause 做结构化比较，避免每次重试都因新错误对象而通知。
function sameState(a: RefState, b: RefState): boolean {
	if (a === b) return true;
	return a.kind === "failed" && b.kind === "failed" && a.retryAt === b.retryAt && sameCause(a.cause, b.cause);
}
