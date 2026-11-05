// Attempts (§6, §13, §14, §15): one activation of an object, a fresh instance each time. It is the `self` its factory
// declares with (handles to the object's documents and jobs, under its seal token); it runs the activation steps,
// each failing with its own kind; it takes the live object's calls and starts its routines and jobs; and it ends with
// its seal (slice 6a §1.3), the drain and the closes of its natives. A reload's swap hands it over (slice 7b §5): its
// routines stop and hand over to the new attempt's, its jobs to the new attempt's, and it is sealed once its calls
// settled.
// 文件导读
// 所属：packages/chord/src/host（主机层），实现对象的一次激活 Attempt。
// 职责：执行工厂与激活步骤，维护依赖/停放/成员/例程/作业/native/follow，承接调用，处理结束与 reload 交接。
// 边界：不决定对象何时创建或重试（ChordObject/Host），不做传输（link 层），不实现 derive/job 细节。
// 上游：ChordObject.attempt -> new Attempt + activate；ChordObject 转发 call/live/seal/close；
// reload 调用 handOver/stopRoutines/drainCalls/startedByReload。
// 下游：documents（状态/表）、host.bind 与 acquire、members、routines、jobs、natives、follow、registry。
// 结果与错误：activate 返回 live/failed(cause)/ended(error)；失败按激活步骤分类；call 返回 Promise 或拒绝。
// 能力清单：
// - Self<P>：工厂声明接口（state/derive/get/registry/writable/retryOn/open/tx/follow/on/onLive/job）。
// - StoreSelf<P>：稳定身份对象额外提供 table/contribute，并允许持久化 state。
// - PinnedKey：键控成员 pin 的结果（source + release）。
// - Factory<C,P>：按 local/remote 分派的工厂类型。
// - notLive(label, ms)：构造激活超时的 unavailable 错误。
// - Attempt：激活、调用、成员访问、结束与 reload 交接的实现类。
// 组合与顺序：activate -> #declare -> hydrate/load -> bind -> checkDependencies/#park -> #ownSteps ->
// live -> call；结束时 seal -> close（drain/cleanup/native close）-> detach/releaseReferences。
// 示例：工厂中 const user = self.get(User, { id: "u1" });
//       宿主侧 const outcome = await attempt.activate(undefined);
//       if (outcome.kind === "live") { ... } else if (outcome.kind === "failed") { ... }
// 建议阅读顺序：Self -> StoreSelf -> Factory -> Attempt 字段/constructor -> activate/#activate -> #park
// -> #ownSteps -> call -> live/例程/作业 -> seal/close -> reload 方法与成员映射辅助。

import { awaitWithContext, type Context, withAbortSignal } from "../context/index.ts";
import type { Contract, Implementation, ParamsOf } from "../contracts/index.ts";
import { contractData, type ShapeOf } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal } from "../data/index.ts";
import { asChordError, checkArgs, checkParams, invalid, openFailure, type Value } from "../data/internal.ts";
import type { HandleOf, JsonObject, StateDefinition, Tx } from "../documents/index.ts";
import {
	type AnyDefinition,
	type KeyDeclarer,
	type KeyedSlot,
	type KeySource,
	SealToken,
} from "../documents/internal.ts";
import type { JobDefinition, JobHandle, JobImplementation } from "../jobs/index.ts";
import { type AnyJobImplementation, type CutReason, Job } from "../jobs/internal.ts";
import type { JsonValue } from "../json.ts";
import type { Contribution, Registry, RegistryValue } from "../registries/index.ts";
import type { RegistryContribution, RegistryWaiter } from "../registries/internal.ts";
import type { Writable } from "../state/index.ts";
import { Derive, type DeriveSource, WritableSource } from "../state/internal.ts";
import type { Columns } from "../store/columns.ts";
import { tableSqlName } from "../store/sql.ts";
import type { ChordStore } from "../store/store.ts";
import type { TableDefinition } from "../store/table.ts";
import { type Table, TableHandle } from "../store/table-handle.ts";
import { prepareTables } from "../store/table-migration.ts";
import type { NativeWatchable, Watchable, WatchEnd } from "../watch.ts";
import { AdaptedMembers } from "./adapted.ts";
import { CallContext, type Caller, type Ctx, withLinkedAbortSignal } from "./ctx.ts";
import { Deadline } from "./deadline.ts";
import { checkDependencies, type Dependency, ParkedLong, parkedCause, waitingOn } from "./dependencies.ts";
import { type FollowAttach, FollowSource } from "./follow.ts";
import type { HostError } from "./host.ts";
import {
	attachDerives,
	checkImplementation,
	contributionOf,
	type KeyedBinding,
	type Members,
	type Method,
} from "./members.ts";
import {
	type CloseFailed,
	drained,
	type Native,
	type NativeCloseReason,
	NativeHandle,
	type NativeOptions,
	type NativeSlot,
} from "./native.ts";
import type { ChordObject, Served } from "./object.ts";
import type { Failed } from "./ref-state.ts";
import type { Binding, CheckedParams, Reference, RetryWalk } from "./reference.ts";
import { type RetrySource, retrySource } from "./retry-on.ts";
import {
	type OnHandler,
	type OnLiveHandler,
	type OnNativeHandler,
	type RoutineDeclarations,
	Routines,
} from "./routines.ts";

/**
 * What a factory declares with. Declarations (`state`, `derive`, `get`, `registry`, `writable`, `retryOn`, `open`,
 * `on`, `onLive`, `job`) are valid only while it runs. `P` is the app's principal type, which the ctx of routine calls
 * and job runs carry.
 */
export interface Self<P extends Principal = Principal> extends RoutineDeclarations<P> {
	// 工厂声明可用的全部能力。所有声明方法只在工厂同步执行期间有效，运行时会检查 #declaring；
	// 类型系统无法阻止插件把方法保存到工厂之后调用。P 是应用身份类型，会进入例程与作业调用的 Ctx。
	/** This object's documents of `definition`, in memory for its life (across its attempts). */
	// 声明一个状态文档并返回句柄。输入文档定义；输出 HandleOf<D>，生命周期跨该对象的多次尝试。
	// persist 时要求稳定身份和宿主 store，会占用 "chord" 文档；同一尝试内同名声明抛错。
	// 例：const count = self.state(CountDefinition); 之后 count.get()/set() 读写这份文档。
	state<D extends StateDefinition<JsonObject, boolean, false>>(definition: D): HandleOf<D>;
	/**
	 * A value computed from `sources` (JSON watchables and native ones: a `writable`, a registry value, `ref.state`) by
	 * the pure, synchronous `compute`; always JSON.
	 */
	// 声明一个纯同步派生值。输入源元组与 compute；输出 Watchable<T>，可继续作为依赖源。
	// compute 必须同步、无副作用；激活期抛错使本次尝试失败，live 后抛错按 derive_failed 上报。
	// 映射类型 [I in keyof S] 逐个取出源的值类型，使 compute 的参数元组与 sources 对齐。
	// 例：const total = self.derive([a, b], ([x, y]) => x + y);
	derive<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T extends JsonValue>(
		sources: S,
		compute: (
			values: {
				readonly [I in keyof S]: S[I] extends Watchable<infer V>
					? V
					: S[I] extends NativeWatchable<infer V>
						? V
						: never;
			},
		) => T,
	): Watchable<T>;
	/** A reference to another object, live once this object is, released when it ends. */
	// 声明一个引用。输入契约与参数；输出 Reference<C>。参数在这里做运行时校验；依赖记入 #dependencies，
	// 激活时统一绑定。目标未就绪时本次尝试会停放等待，而不是立即失败。
	// 例：const user = self.get(User, { id: "u1" }); 对象 live 后 user 可用。
	get<C extends Contract>(Type: C, params: ParamsOf<C>): Reference<C>;
	/**
	 * Registry `R`'s composed value as this plugin's version of `R` sees it: a declared dependency, as `get` is
	 * (the attempt parks until it has a usable value: `failed { waiting }` while it has none, woken when it has). Read
	 * `.value` at use; once live, a later failure of the registry keeps its last good value while every contribution it
	 * was built from is still in the table.
	 */
	// 声明注册表依赖，返回按本插件版本视图读取的值。输入注册表令牌；输出 RegistryValue<V>。
	// 与 get 一样产生依赖并可能停放；注册表失败时若仍有 last 好值，对象继续使用旧值。
	// 例：const settings = self.registry(Settings); const theme = settings.value.theme;
	registry<C, V>(R: Registry<C, V>): RegistryValue<V>;
	/**
	 * An in-process value this attempt sets (`set`, identity compared): a contribution, a derive source and an `on`
	 * source, never a state member; its watches end with the attempt, and `set` after its end throws `released`.
	 */
	// 创建一个尝试内可写值。输入初始值；输出 Writable<T>。它不是状态文档，不持久化；
	// 其 watch 随尝试结束而结束，尝试结束后 set 抛 released（由 owner.assertUsable 检查 seal token）。
	// 例：const draft = self.writable(""); 可作为 derive 源或 on 源。
	writable<T>(initial: T): Writable<T>;
	/**
	 * Wake signals: a new value of any of `sources` (registry values; constants never change) retries this object
	 * while it is failed, as `ref.retry()` does, and once more at once if its current activation fails. Followed from
	 * the factory's return until the next attempt's declaration or the object's end; failures wake nothing.
	 */
	// 声明唤醒信号：任一源出现新值时重试失败中的对象。输入 watchable 列表；无返回。
	// 源在工厂返回后立即交给对象，即使激活失败也保留；源自身失败不会唤醒对象。
	// 例：self.retryOn(config); 配置对象变化后，此前失败的本对象会再次激活。
	retryOn(...sources: readonly (Watchable<unknown> | NativeWatchable<unknown>)[]): void;
	/**
	 * A native, opened during activation after the references are live and the earlier natives are open, and closed
	 * in reverse when the attempt ends. `open` gets a context aborted when the attempt is abandoned; `close` one aborted
	 * at the close timeout. Throw `broken(error)` from `open` when retrying is pointless.
	 */
	// 声明一个 native 资源。open 在引用就绪、之前的 native 打开后执行；close 在尝试结束时逆序执行。
	// 输入 open/close 回调与可选 NativeOptions（closeTimeout）；输出 Native<T> 句柄。
	// open 抛 broken(error) 表示重试无意义；普通异常按激活失败类型处理。
	// 例：self.open(async () => connect(), (conn) => conn.close());
	open<T>(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		options?: NativeOptions,
	): Native<T>;
	/** Runs `fn` as one transaction of this object (§9). */
	// 在本对象的文档上执行一个事务。输入 fn 与上下文；输出 fn 的结果 Promise。
	// seal 之后事务会被拒绝；与其它事务一样由对象串行化。
	// 例：await self.tx((tx) => tx.set(doc, next), ctx);
	tx<R>(fn: (tx: Tx) => R | Promise<R>, context: Context): Promise<R>;
	/**
	 * A source following another runtime's synchronous observer (Durable's views, slice 6b §3): `attach` runs during
	 * activation once the natives opened (a rejection or `undefined` fails the activation `transient`), and the observer
	 * is detached when the attempt ends. Its runtime failing fails this object `transient`; its `ended` is final, the
	 * source keeping its last value. A state member, a derive source, an `on` source.
	 */
	// 挂接外部运行时的同步观察者，返回 Chord 源。输入 attach 回调；输出 Watchable<T>。
	// attach 在 native 打开后执行；返回 undefined 或 reject 使激活 transient 失败；尝试结束自动 detach。
	// 例：const doc = self.follow((observer) => runtime.observeDoc(id, observer));
	follow<T>(attach: FollowAttach<T>): Watchable<T>;
	/**
	 * This object's job `definition` (§15), once per job name: `run` runs each started run outside transactions,
	 * `finish` records its outcome in one. Starts are taken once the object is live.
	 */
	// 声明一个作业并返回句柄。输入定义与实现；输出 JobHandle<A,R,S>。同名作业重复声明抛错；
	// persist 时要求稳定身份，并占用作业相关的两份文档。对象 live 后开始接收 start。
	// 例：const mailer = self.job(EmailJob, { run: send, finish: record });
	job<A, R, S>(definition: JobDefinition<A, R, S>, implementation: JobImplementation<A, R, S, P>): JobHandle<A, R, S>;
}

/**
 * What the factory of a `local` type with empty params declares with: one object per host and type, so its data may
 * persist (P3). `P` as for `Self`.
 */
// 稳定身份对象的声明接口：只有 local 且无参数的契约能持久化。相比 Self 多出 table 与 contribute，
// 且 state 允许 persist=true；Self 把 persist 限定为 false。
export interface StoreSelf<P extends Principal = Principal> extends Self<P> {
	/** This object's documents of `definition`: in memory for its life, or persisted in the host's store. */
	// 与 Self.state 相同，但允许持久化；写入前会检查稳定身份与宿主 store。
	state<D extends StateDefinition<JsonObject, boolean, boolean>>(definition: D): HandleOf<D>;
	/** This object's table `definition` in the host's store, once per table name. */
	// 声明一张存储表并返回句柄；同名重复声明抛错，SQL 名称由契约名与表名共同生成。
	// 例：const events = self.table(EventsDefinition);
	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K>;
	/**
	 * Contributes `value` to registry `R` from the moment this object is live until it ends, fails or restarts (R21: a
	 * host-lifetime object): a plain value, or a Chord watchable of one (followed: its change recomposes). At most one
	 * per registry.
	 */
	// 从对象 live 到结束、失败或重启期间向注册表贡献值；每个注册表最多一次。
	// 普通值直接写入；watchable 会被跟随，其变化触发重新组合。
	// 例：self.contribute(Settings, { theme: "dark" });
	contribute<C>(R: Registry<C, unknown>, value: Contribution<C>): void;
}

/** A key of a keyed member pinned on one instance, loaded: its source (mapped when older), and the release (once). */
// 键控成员的一次 pin 结果：source 可直接作为 derive/on 源（旧版本已映射），release 释放 pin。
// 调用方必须保证 release 最多生效一次；映射层会再包一层幂等释放。
export type PinnedKey = { readonly source: DeriveSource; readonly release: () => void };

/**
 * A factory: synchronous and declarative, run once per attempt. A remote one also gets the principal in its object's
 * identity and returns one variant, `{ variant, members }`. Methods get a `Ctx` for the app's principal type `P`.
 */
// 工厂是同步声明函数，每次尝试执行一次。条件类型先按契约 kind 分派：
// - local：self 参数按“参数对象是否为空”选择 StoreSelf（可持久化、贡献）或普通 Self；
// - remote：额外收到 principal，并且实现必须返回 { variant, members }。
// keyof ParamsOf<C> extends never 只在类型层判断参数对象没有字段；运行时不校验工厂是否同步。
export type Factory<C extends Contract, P extends Principal = Principal> = ShapeOf<C>["kind"] extends "local"
	? (params: ParamsOf<C>, self: keyof ParamsOf<C> extends never ? StoreSelf<P> : Self<P>) => Implementation<C, Ctx<P>>
	: (params: ParamsOf<C>, principal: P, self: Self<P>) => Implementation<C, Ctx<P>>;

/** No declarations of a kind: the shared empty list. */
// 共享空只读数组，供没有声明时复用，避免每次分配。
const NONE: readonly never[] = [];

/** Running work of one kind (calls, routine calls, job invocations), with the bookkeeping each runs once. */
// 一组在途工作：键是 Promise，值是该工作的清理回调（减少计数、释放 ctx 引用等）。
// 用 Map 因为需要在工作落定时按 Promise 删除；同一个回调只应执行一次。
type Work = Map<Promise<unknown>, (() => void) | undefined>;

/** Its routines once started: aborted when they stop (its seal, a reload's handover or restart), and their running calls. */
// 例程运行态：abort 用于停止所有例程，calls 记录在途例程调用，结束时的 drain 要等它们。
type RoutineRun = { readonly abort: AbortController; readonly calls: Work };

/**
 * What a reload did to an attempt: `started` (a reload started it), `handedOver` (a swap: its jobs are the new
 * attempt's, its invocations finish on their own), `callsDrained` (a swap or restart waited for its calls: its end's
 * drain does not again), `routinesStopped` (its routines stopped, and do not start late after a handover).
 */
// 记录 reload 对本次尝试做过的动作；四个布尔值避免重复劳动：已 drain 的不再 drain，已交接的作业不再写入/等待。
// 由 #reload() 懒创建，多数尝试永远不会碰到 reload，因此不提前分配。
type Reloaded = { started: boolean; handedOver: boolean; callsDrained: boolean; routinesStopped: boolean };

/** A first dependency check that did not park: the shared answer. */
// 首次依赖检查“没有停放”的共享结果；as const 让 done 收窄为字面量 true。
const NOT_PARKED = { done: true, cause: undefined } as const;

/** No running work: the shared empty map. */
// 共享空 Map，供没有在途工作的尝试复用；类型是只读 Map，防止被误写入。
const NO_WORK: ReadonlyMap<Promise<unknown>, (() => void) | undefined> = new Map();

/** Runs the bookkeeping of the work still in `work` (stuck past the drain) and forgets it. */
// drain 超时后仍有工作未落定：逐个执行清理并从表中删除，防止计数与 ctx 引用永久泄漏。
// 工作本身仍在运行，只是不再被本次尝试追踪。
function cleanUp(work: Work | undefined): void {
	if (work === undefined) return;
	// 展开前先删除，避免清理回调同步触发再次遍历；删除后即使回调抛错，该项也已移除。
	for (const [running, cleanup] of work) {
		work.delete(running);
		cleanup?.();
	}
}

/** An attempt's registry reads, contributions and wake signals, and its writables (slice 8). */
// 本次尝试产生的注册表相关声明，整体懒创建；大多数对象从不使用注册表。
// reads：保住旧版本映射的读取释放函数；retrySources：retryOn 源；writables：随尝试结束的写值。
// declared：工厂声明但尚未解析的贡献；contributions：激活时解析后的结果，供对象 live 期间使用。
type RegistryDeclarations = {
	/** Releases its registry reads (with its references): a read keeps an older version's mapping. */
	// 释放注册表读取；读取本身会保留旧版本映射，因此必须与引用一起释放。
	readonly reads: (() => void)[];
	/** Its wake signals (`self.retryOn`), handed to its object right after the factory. */
	// 工厂返回后立即交给对象的唤醒源。
	readonly retrySources: RetrySource[];
	/** Its writables, whose watches end with it. */
	// 尝试内写值；结束时要 detach，使其 watch 收到 ended。
	readonly writables: { detach(error: Error): void }[];
	/** Its contributions as declared, resolved during activation into `contributions`. */
	// 工厂声明的原始贡献；激活后解析并替换为 contributions。
	readonly declared: { readonly registry: Registry<unknown, unknown>; readonly value: unknown }[];
	// 解析后的贡献记录；live 期间由对象写入注册表。
	contributions: readonly RegistryContribution[];
};

/** How an attempt's activation ended. */
// 激活结果三态：live 成功；failed 携带失败原因（可重试/不可恢复）；ended 表示对象在激活期被结束。
type Activation =
	| { readonly kind: "live" }
	| { readonly kind: "failed"; readonly cause: FailureCause }
	| { readonly kind: "ended"; readonly error: ChordError };

/** How an activation that did not go live ended. */
// 从 Activation 中排除 live 后的子集；激活失败/放弃时返回它。
type NotLive = Exclude<Activation, { readonly kind: "live" }>;

/** The error of an object, or a getter, that waited `ms` without the object going live. */
// 激活超时错误：code 为 unavailable，message 带对象 label 与毫秒预算；由 Deadline 到期时构造。
// 例：notLive("User@abc", 5000) 得到 “User@abc: did not become live within 5000 ms”。
export function notLive(label: string, ms: number): ChordError {
	return new ChordError({ code: "unavailable", message: `${label}: did not become live within ${ms} ms` });
}

/**
 * One attempt of an object. Activation: factory, documents hydrated (the object's slots), references bound, then parked
 * until every dependency is live (no timer: the deadline paused), then its own steps: natives opened one after
 * another, followed sources attached, members checked, derives computed; bounded by the host's `readyTimeout`.
 * Ending: sealed at once (calls aborted, its transactions refused and the one holding the line discarded, its job
 * invocations cut off), then the drain, the closes in reverse, derives detached; its object releases its references.
 * Documents and job runs stay on the object.
 */
// Attempt 每次激活都新建：工厂以它为 self，激活成功后它承接调用。字段按用途分组：
// - #object/#served：所属对象，以及创建时的服务视图（旧版本映射的依据）；
// - #context/#abort/#opening：对象上下文与本次尝试的中止信号；#token 是文档与事务的封闭令牌；
// - #declared/#tables/#references/#dependencies/#natives/#follows/#derives/#routines/#jobs：工厂声明产物；
// - #pins：工厂 at(key) 的 pin，工厂返回后交给对象跨尝试持有；
// - #members/#variant/#isLive：成员检查结果与是否已 live；
// - #running/#runs/#routineRun：在途调用、作业运行与例程，drain 的依据；
// - #abandoned/#parked/#moved/#changed/#endedEarly：激活与停放的瞬时状态；
// - #registryDeclarations/#check/#reloaded：懒创建的注册表声明、首次检查结果、reload 记录。
// 大多数可选字段懒创建，普通对象不为未使用的功能付费。
export class Attempt implements StoreSelf, KeyDeclarer, RegistryWaiter {
	// 所属对象；提供 host、documents、label、served 等共享能力。
	readonly #object: ChordObject;
	/** The type its object was served as when it was made: its provider's `accepts` map its older consumers. */
	// 创建时固定的服务视图；reload 后新实例可能不同，本实例仍按它解释契约与 accepts。
	readonly #served: Served;
	/** Its shared mappings for the consumers of older versions (Q10), by version; made by the first. */
	// 旧版本消费者的共享映射，按版本号缓存；首次用到才创建。
	#adapted: Map<number, AdaptedMembers> | undefined;
	/** The object's context: the natives' closes run under it. */
	// 对象级上下文；native 的 close 在它下面运行，不随本次尝试的中止信号结束。
	readonly #context: Context;
	/** Aborted when the attempt is abandoned or ends: openers, activation's waits and calls run under its signal. */
	// 本次尝试的独立中止信号；放弃或结束时 abort，opener、激活等待与调用都观察它。
	readonly #abort = new AbortController();
	/** The object's context under this attempt's signal. */
	// 对象上下文叠加 #abort 后的上下文，是激活步骤与 opener 实际使用的 Context。
	readonly #opening: Context;
	/** The seal token its handles and transactions carry (the seal fence). */
	// 文档句柄与事务携带的封闭令牌；seal 后令牌失效，后续事务被拒绝。
	readonly #token = new SealToken();
	/** Its routines once they started (most attempts have none). */
	// 例程启动后的运行态（中止控制器 + 在途调用），未启动时为 undefined。
	#routineRun: RoutineRun | undefined;
	/** The documents it declared, by name: "declared twice" is per attempt. */
	// 本尝试声明的文档定义，按名称索引；重复声明只在同一次尝试内判定。
	readonly #declared = new Map<string, AnyDefinition>();
	/** Its factory's `at(key)` pins: the object holds them from its factory's return to the next one's (rule 6). */
	// 工厂 at(key) 的释放函数；工厂返回后转交对象，跨尝试持有到下一次声明。
	readonly #pins: (() => void)[] = [];
	// 是否处于工厂同步执行期间；只有此时允许调用声明 API。
	#declaring = false;
	/** Set once it went live: its derives' failures are reported from then on (`derive_failed`). */
	// 是否已经 live；激活期 derive 失败会整体失败，live 后才逐条上报。
	#isLive = false;
	/** The checked implementation and, for a remote object, its variant, once activation checked them. */
	// 成员检查结果；远程对象同时保存 variant。
	#members: Members | undefined;
	// 远程对象的 variant；本地对象或尚未检查时为 undefined。
	#variant: string | undefined;
	// 本尝试创建的派生，按声明顺序；结束时统一 detach。
	readonly #derives: Derive[] = [];
	/** Its followed sources, attached in declaration order after the natives. */
	// 跟随外部运行时的源，按声明顺序在 native 打开后 attach。
	readonly #follows: FollowSource[] = [];
	// 声明的 on/onLive 例程集合，统一启停。
	readonly #routines = new Routines();
	// 声明的作业，按名称索引；同一次尝试内同名只允许一个。
	readonly #jobs = new Map<string, Job>();
	/** The tables it declared, by name. */
	// 声明的存储表，按名称索引。
	readonly #tables = new Map<string, TableHandle>();
	/** References this attempt declared with `self.get` (params checked), bound during activation. */
	// 工厂用 self.get 声明并已校验参数的引用，激活时统一绑定。
	readonly #references: { readonly binding: Binding; readonly contract: Contract; readonly params: CheckedParams }[] =
		[];
	/**
	 * Its dependencies (`self.get` references and `self.registry` values) in declaration order: the parked cause and
	 * `parked_long` name the first that blocks. Made by the first; let go after the dependency check (a live attempt
	 * keeps none).
	 */
	// 依赖列表（引用与注册表值），保持声明顺序；停放原因与 parked_long 取第一个阻塞者。
	// 激活检查后即释放，live 对象不再持有。
	#dependencies: Dependency[] | undefined;
	// native 槽，按声明顺序打开、逆序关闭。
	readonly #natives: NativeSlot[] = [];
	/**
	 * Running calls' handlers, routine calls and job runs, each with its bookkeeping (call counts, `ctx.get`
	 * references): an ending attempt waits for them (the drain); the bookkeeping runs once, when its work settles or at
	 * teardown for work stuck past the drain (decision "The seal fence" (4)). One map and one reaction per piece of work:
	 * the call path costs no more than before the cleanups.
	 */
	// 在途工作集合：键是工作 Promise，值是清理回调（减计数、释放 ctx.get 引用等）。
	// 结束时 drain 等待它们；清理在落定时或 teardown 时恰好执行一次。
	readonly #running: Work = new Map();
	/**
	 * Its running job invocations, as `#running`: the drain at its end waits for them; a swap does not (they finish on
	 * their old code, slice 7b §8). Made by the first.
	 */
	// 在途作业运行；正常结束时 drain 等待，reload swap 时不等（它们在旧代码上自然结束）。
	#runs: Work | undefined;
	/** What activation returns once the attempt was abandoned: a timeout, a cycle through its object, or its end. */
	// 放弃结果（超时、环、对象结束）；一旦设置，激活返回它而不是新的结果。
	#abandoned: NotLive | undefined;
	/** Its dependencies while it is parked on them (the dependency check); `undefined` otherwise. */
	// 停放期间的依赖列表，供 ref.retry() 传递重试；离开停放后清空。
	#parked: readonly Dependency[] | undefined;
	/** A dependency changed since the last check: the parked attempt checks again (one check per batch of changes). */
	// 自上次检查后依赖是否变化；同一批多次变化只置一次。
	#moved = false;
	/** What a parked attempt waiting for a change waits on; resolved after the change's batch. */
	// 停放等待的 Promise 句柄；依赖变化后由微任务唤醒。
	#changed: PromiseWithResolvers<void> | undefined;
	/** A followed source's end while this attempt activated: it fails as it goes live (if its activation returned). */
	// 激活期间跟随源结束的错误；激活返回 live 时据此改为失败。
	#endedEarly: ChordError | undefined;
	/** Its registry reads, contributions, wake signals and writables, made by the first: most attempts have none. */
	// 注册表相关声明集合，首次使用时创建；大多数尝试没有。
	#registryDeclarations: RegistryDeclarations | undefined;
	/**
	 * Its first dependency check, for a reload (its report, a swap's handover): waited for by someone, or done with why
	 * it parked (`undefined`: it did not). Made by the first who asks or by the check.
	 */
	// 首次依赖检查的结果槽：未完成时保存等待者，完成后保存停放原因（undefined 表示未停放）。
	// reload 报告与 swap 交接会等待它；普通激活不创建。
	#check:
		| { readonly done: false; readonly waiting: PromiseWithResolvers<FailureCause | undefined> }
		| { readonly done: true; readonly cause: FailureCause | undefined }
		| undefined;
	/** What a reload did to it, made by the first such step (most attempts never meet one). */
	// reload 对本实例做过的动作；首次涉及 reload 时创建。
	#reloaded: Reloaded | undefined;

	// 保存对象与上下文；#opening 是叠加本次尝试中止信号的上下文，opener、激活等待和调用都用它。
	// 不启动计时器，也不执行工厂；这些由 activate 负责。
	// 例：new Attempt(object, withoutAbortSignal(context)) 由 ChordObject 调用。
	constructor(object: ChordObject, context: Context) {
		this.#object = object;
		// 创建时固定 served，reload 后仍按旧服务视图解释本实例的契约与 accepts。
		this.#served = object.served;
		this.#context = context;
		this.#opening = withAbortSignal(this.#abort.signal, context);
	}

	// 声明状态文档。输入定义；输出文档句柄。副作用：登记定义名；persist 时占用 "chord" 文档。
	// 错误：非声明期、同名重复、persist 但无稳定身份/store 时抛错。
	// 例：const count = self.state(CountDefinition);
	state<D extends StateDefinition<JsonObject, boolean, boolean>>(definition: D): HandleOf<D> {
		this.#assertDeclaring("state");
		// 错误消息统一带对象 label 与声明名，便于定位是哪个插件。
		const what = `state "${definition.name}"`;
		if (this.#declared.has(definition.name)) throw new Error(`${this.#object.label}: ${what} is declared twice`);
		if (definition.persist) {
			// 持久化需要稳定身份与 store，并占用固定文档名 "chord"。
			this.#assertPersistable(what);
			this.#object.claimDocuments("chord");
		}
		this.#declared.set(definition.name, definition);
		// 句柄携带 seal token；this 作为 RegistryWaiter 让文档侧能登记等待者。
		return this.#object.documents.declare(definition, this.#token, this);
	}

	/** `handle.at(key)`: pins `key` of `slot` while this attempt's factory's pins are held, and returns its source. */
	// 供 handle.at(key) 调用：在本次尝试持有 pin 期间锁定 key，并返回可订阅源。
	// 输入槽与键；输出 KeySource。pin 在工厂抛错时由 #declare 释放，否则转交对象跨尝试持有。
	// 例：const user = this.at(userSlot, "u1");
	at(slot: KeyedSlot, key: string): KeySource {
		this.#assertDeclaring("state(...).at");
		this.#pins.push(slot.pin(key, this.#opening));
		return slot.source(key);
	}

	// 声明持久表。输入表定义；输出 Table<C,K>。要求稳定身份与 store；同名重复声明抛错。
	// SQL 名由契约名与表名生成，并登记到对象防止两个对象争用同一张表。
	// owner 提供作用域、live 检查与失败回调；句柄铸造用 as 恢复泛型（构造器按无类型定义工作）。
	// 例：const events = self.table(EventsDefinition);
	table<C extends Columns, K extends readonly string[]>(definition: TableDefinition<C, K>): Table<C, K> {
		this.#assertDeclaring("table");
		const object = this.#object;
		const { served, label } = object;
		const store = this.#assertPersistable(`table "${definition.name}"`);
		if (this.#tables.has(definition.name)) throw new Error(`${label}: table "${definition.name}" is declared twice`);
		const sqlName = tableSqlName(served.contract.name, definition.name);
		object.claimTable(sqlName);
		const owner = {
			label,
			scope: object.documents,
			assertLive: () => object.documents.assertLive(),
			fail: (error: ChordError) => object.failLive(this, { kind: "broken", error }),
		};
		// The handle's rows are the definition's, typed by `C` and `K`.
		const handle = new TableHandle(definition as unknown as TableDefinition, sqlName, store, owner);
		this.#tables.set(definition.name, handle);
		return handle as unknown as Table<C, K>;
	}

	// 组装 Derive 并登记。输入源与 compute；输出 Watchable<T>。
	// cast compute 是因为实现按 readonly unknown[] 统一处理，元组对齐由公开签名保证。
	// 例：const total = self.derive([a, b], ([x, y]) => x + y);
	derive<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T extends JsonValue>(
		sources: S,
		compute: (
			values: {
				readonly [I in keyof S]: S[I] extends Watchable<infer V>
					? V
					: S[I] extends NativeWatchable<infer V>
						? V
						: never;
			},
		) => T,
	): Watchable<T> {
		this.#assertDeclaring("derive");
		// The values are the sources' values, in order; the result is `T`.
		const derive = new Derive(sources, compute as (values: readonly unknown[]) => T, this.#object.host.batch);
		this.#derives.push(derive);
		return derive as unknown as Watchable<T>;
	}

	// 声明引用并记录依赖。输入契约与参数；输出 Reference<C>。参数立即运行 checkParams；
	// binding 由 host.reference 创建，激活时 host.bind 统一绑定；引用释放由对象负责。
	// 例：const user = self.get(User, { id: "u1" });
	get<C extends Contract>(Type: C, params: ParamsOf<C>): Reference<C> {
		this.#assertDeclaring("get");
		const { host } = this.#object;
		const checked = checkParams(Type, params, this.#opening);
		const binding = host.reference(Type, this.#object, this.#caller(), {});
		this.#references.push({ binding, contract: Type, params: checked });
		this.#dependencies ??= [];
		this.#dependencies.push({ kind: "reference", binding });
		// The binding was built from `Type`'s members.
		return binding.reference as Reference<C>;
	}

	// 声明注册表依赖。输入令牌；输出该版本的注册表值源，读取当前值用 .value。
	// 依赖记录后由 checkDependencies 判断是否可用；注册表失败但仍有 last 好值时不阻塞。
	// 例：const settings = self.registry(Settings);
	registry<C, V>(R: Registry<C, V>): RegistryValue<V> {
		this.#assertDeclaring("registry");
		const value = this.#object.host.registryRecord(R.name).value(R.version);
		this.#dependencies ??= [];
		this.#dependencies.push({ kind: "registry", value });
		// Its values are the composition as `R`'s version has it, `V`.
		return value as RegistryValue<V>;
	}

	// 创建尝试内可写值并登记，尝试结束时统一 detach。owner.assertUsable 用 seal token 判断是否已结束。
	// 例：const draft = self.writable("");
	writable<T>(initial: T): Writable<T> {
		this.#assertDeclaring("writable");
		const owner = {
			context: this.#context,
			assertUsable: () => {
				if (this.#token.sealed) throw this.#object.ended();
			},
		};
		const writable = new WritableSource(initial, owner, this.#object.host.batch);
		this.#declarations().writables.push(writable);
		return writable;
	}

	// 把每个源包装成 RetrySource 暂存；工厂返回后由 #activate 立即交给对象，失败时也保留。
	// 例：self.retryOn(config);
	retryOn(...sources: readonly (Watchable<unknown> | NativeWatchable<unknown>)[]): void {
		this.#assertDeclaring("retryOn");
		const { retrySources } = this.#declarations();
		for (const source of sources) retrySources.push(retrySource(source, this.#object.label));
	}

	// 声明注册表贡献。输入注册表与值；无返回。仅允许 local 且 hostLifetime 的对象；
	// 同一注册表名重复贡献抛错；实际解析延后到激活时 #resolveContributions。
	// 例：self.contribute(Settings, { theme: "dark" });
	contribute<C>(R: Registry<C, unknown>, value: Contribution<C>): void {
		this.#assertDeclaring("contribute");
		const { served, label } = this.#object;
		// R21: the types allow it only to host-lifetime objects; plugin code is bundled without type checks.
		if (served.kind !== "local" || !served.hostLifetime) {
			throw new Error(`${label}: self.contribute is valid only in a local type with empty params`);
		}
		const { declared } = this.#declarations();
		if (declared.some(({ registry }) => registry.name === R.name)) {
			throw new Error(`${label}: registry ${R.name} is contributed to twice`);
		}
		declared.push({ registry: R as Registry<unknown, unknown>, value });
	}

	// 声明 native。输入 open/close 与选项；输出句柄。关闭超时取 options.closeTimeout 或宿主默认；
	// owner 记录对象 label、序号、上下文与 host.report。真正的 open 在 #ownSteps 中按声明顺序执行。
	// 例：self.open(async () => connect(), (conn) => conn.close());
	open<T>(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		options: NativeOptions = {},
	): Native<T> {
		this.#assertDeclaring("open");
		const { host, label } = this.#object;
		const closeTimeout = options.closeTimeout ?? host.timeouts.close;
		const owner = {
			object: label,
			position: this.#natives.length + 1,
			context: this.#context,
			report: (error: HostError) => host.report(error),
		};
		const native = new NativeHandle(open, close, closeTimeout, owner);
		this.#natives.push(native);
		return native;
	}

	// 在对象文档上执行事务，交给 documents.tx 并携带 seal token；seal 后事务会被拒绝。
	// 例：await self.tx((tx) => tx.set(doc, next), ctx);
	tx<R>(fn: (tx: Tx) => R | Promise<R>, context: Context): Promise<R> {
		return this.#object.documents.tx(fn, this.#token, context);
	}

	// 创建 FollowSource 并登记。owner.ended 转给 #followEnded；源在 #ownSteps 中按声明顺序 attach。
	// 例：const doc = self.follow((observer) => runtime.observeDoc(id, observer));
	follow<T>(attach: FollowAttach<T>): Watchable<T> {
		this.#assertDeclaring("follow");
		const object = this.#object;
		const owner = { label: object.label, context: this.#context, ended: (end: WatchEnd) => this.#followEnded(end) };
		// The source holds what the runtime gives it, `T`, as Chord's JSON sources do.
		const source = new FollowSource(attach as unknown as FollowAttach<JsonValue>, owner, object.host.batch);
		this.#follows.push(source);
		return source as unknown as Watchable<T>;
	}

	// 注册普通源回调，交给 Routines 统一启停；回调在 Chord 批次内运行。
	// 例：self.on(count, () => report(count.value));
	on<T>(source: Watchable<T>, fn: OnHandler<T>): void;
	on<T>(source: NativeWatchable<T>, fn: OnNativeHandler<T>): void;
	on(source: Watchable<unknown> | NativeWatchable<unknown>, fn: (...args: never[]) => void | Promise<void>): void {
		this.#assertDeclaring("on");
		this.#routines.on(source, fn);
	}

	// 注册 live 时运行一次的例程；由 Routines 在启停周期内调用。
	// 例：self.onLive(() => log("ready"));
	onLive(fn: OnLiveHandler): void {
		this.#assertDeclaring("onLive");
		this.#routines.onLive(fn);
	}

	// 声明作业。输入定义与实现；输出 JobHandle。同名重复声明抛错；persist 时要求稳定身份并占用
	// "chord.jobs" 与 "chord.job-states" 两份文档。owner 把普通调用登记到 #running，把运行登记到 #runs，
	// 以便结束 drain 与 swap 区分等待范围。句柄用 as 恢复泛型。
	// 例：const mailer = self.job(EmailJob, { run: send, finish: record });
	job<A, R, S>(definition: JobDefinition<A, R, S>, implementation: JobImplementation<A, R, S>): JobHandle<A, R, S> {
		this.#assertDeclaring("job");
		const object = this.#object;
		if (this.#jobs.has(definition.name)) {
			throw new Error(`${object.label}: job "${definition.name}" is declared twice`);
		}
		if (definition.persist !== undefined) {
			this.#assertPersistable(`job "${definition.name}"`);
			object.claimDocuments("chord.jobs");
			object.claimDocuments("chord.job-states");
		}
		const owner = {
			host: object.host,
			caller: this.#caller(),
			context: this.#context,
			signal: this.#abort.signal,
			token: this.#token,
			documents: object.documents,
			admit: (running: Promise<unknown>, cleanup?: () => void) => this.#admit(this.#running, running, cleanup),
			admitRun: (running: Promise<unknown>, cleanup: () => void) => {
				this.#runs ??= new Map();
				this.#admit(this.#runs, running, cleanup);
			},
		};
		// The job keeps its runs as JSON and calls the implementation with them; the handle types them again.
		const records = object.jobRecords(definition as JobDefinition<unknown, unknown, unknown>);
		const job = new Job(records, implementation as unknown as AnyJobImplementation, owner);
		this.#jobs.set(definition.name, job);
		return job as unknown as JobHandle<A, R, S>;
	}

	/**
	 * Activates once `ending` (the previous instance's) has finished; `readyTimeout` bounds both (an attempt abandoned
	 * while it waits has opened nothing).
	 */
	// 激活入口。输入前一个实例的 teardown Promise（没有则 undefined）；输出 Activation。
	// 创建 readyTimeout 期限；先等待前一个实例结束（可被 abandon 提前打断），再执行 #activate；
	// finally 清理期限，并保证首次依赖检查有结果（返回 undefined 表示未停放）。
	// 错误不抛出：失败封装在 Activation.failed/ended 中。
	// 例：const result = await attempt.activate(object.ending);
	async activate(ending: Promise<void> | undefined): Promise<Activation> {
		const { ready } = this.#object.host.timeouts;
		// 到期只放弃激活，不直接抛错；错误种类是 transient 的 unavailable。
		const deadline = new Deadline(ready, () => {
			this.abandon({ kind: "failed", cause: { kind: "transient", error: notLive(this.#object.label, ready) } });
		});
		try {
			if (ending !== undefined) {
				try {
					// awaitWithContext 让等待随 #opening 中止，从而在截止时间或对象结束时提前退出。
					await awaitWithContext(ending, this.#opening);
				} catch {
					// An ending never rejects: only an abandonment (the deadline) ends this wait early.
					// 非空断言成立：catch 只可能来自 abandon，而 abandon 必先设置 #abandoned。
					return this.#abandoned!;
				}
			}
			return await this.#activate(deadline);
		} finally {
			deadline.clear();
			// Ended before its first dependency check (its factory threw, it was abandoned): nothing parked.
			this.#settleCheck(undefined);
		}
	}

	/** Abandons the activation with `outcome` (once): its waits stop and the openers' contexts are aborted. */
	// 放弃本次激活，只生效一次：先保存结果，再取 ended.error 或 failed.cause.error 中止 #abort，
	// 最后停止例程。所有以 #opening 运行的等待/opener 都会收到该原因。
	// 例：Deadline 到期时调用 abandon({ kind: "failed", cause: { kind: "transient", error } })。
	abandon(outcome: NotLive): void {
		if (this.#abandoned !== undefined) return;
		this.#abandoned = outcome;
		const reason = outcome.kind === "ended" ? outcome.error : outcome.cause.error;
		this.#abort.abort(reason);
		this.#stopRoutines(reason);
	}

	/**
	 * A followed runtime ended its observer (R4): `failed` fails this attempt `transient`, live or activating; `ended`
	 * does only while it activates (it would go live over a source that ended). An activation that already returned
	 * fails as it goes live.
	 */
	// FollowSource 报告外部结束。failed 一律让对象 transient 失败；ended 仅在未 live 时失败，
	// live 后只结束源本身。激活尚未返回时先记录 #endedEarly，由 live 决定失败。
	#followEnded(end: WatchEnd): void {
		if (end.kind === "ended" && this.#isLive) return;
		const { label } = this.#object;
		// failed 的错误可能是未知值，asChordError 收敛；ended 合成 unavailable 说明源在激活期结束。
		const error =
			end.kind === "failed"
				? asChordError(end.error, label)
				: new ChordError({ code: "unavailable", message: `${label}: a followed source ended while it activated` });
		if (this.#isLive) {
			// live 后失败走 failLive，由对象调度重试。
			this.#object.failLive(this, { kind: "transient", error });
			return;
		}
		// 激活期只记录第一次；随后 abandon 停止激活，最终 live 会再看到并失败。
		this.#endedEarly ??= error;
		this.abandon({ kind: "failed", cause: { kind: "transient", error } });
	}

	/**
	 * The object went live: its jobs take starts and its routines start, in this turn; both stop when it is sealed.
	 * After a swap (`previous`, the attempt it replaced) its routines start once the previous attempt's routine calls
	 * finished (the handover per object, §14), calls never wait for it.
	 */
	live(previous?: Attempt): void {
		// 先置 live，后续 failLive 与 derive 上报才能按 live 语义处理。
		this.#isLive = true;
		const early = this.#endedEarly;
		if (early !== undefined) {
			// 激活期间 followed 源已结束：不能带着死源进入 live。
			this.#object.failLive(this, { kind: "transient", error: early });
			return;
		}
		// 作业从此刻开始接收 start。
		for (const job of this.#jobs.values()) job.live();
		// 没有例程就不必创建控制器；empty 是 Routines 的只读判断。
		if (this.#routines.empty) return;
		if (previous === undefined) this.#startRoutines();
		// swap：等前一个实例的例程调用结束再开始，调用本身从不等待（void 表示不阻塞 live）。
		else void previous.handOverRoutines().then(() => this.#startRoutines());
	}

	/** Starts its routines, unless it was sealed meanwhile. */
	// 启动作业以外的例程：若已放弃或 reload 已停止例程则不再启动；创建独立 AbortController，
	// 使例程调用随本次尝试结束而中止，并登记其调用以便 drain。
	#startRoutines(): void {
		if (this.#abandoned !== undefined || this.#reloaded?.routinesStopped === true) return;
		const { host, label } = this.#object;
		const run: RoutineRun = { abort: new AbortController(), calls: new Map() };
		this.#routineRun = run;
		this.#routines.start({
			label,
			host,
			caller: this.#caller(),
			// 在对象上下文上叠加例程控制器，任何一个中止都传递到例程调用。
			context: withAbortSignal(run.abort.signal, this.#context),
			admit: (running, cleanup) => this.#admit(run.calls, running, cleanup),
		});
	}

	/** Its routines stop with `reason` (or may not start any more: `#startRoutines` asks the abandonment too). */
	// 中止所有例程；未启动时可选链直接跳过。已有例程调用通过 ctx 信号感知。
	#stopRoutines(reason: unknown): void {
		this.#routineRun?.abort.abort(reason);
	}

	/**
	 * A reload swaps this live attempt out (slice 7b §5): its routines stop, its jobs are handed over (their running
	 * invocations finish on this code), it takes no new starts; its calls run on until `drainCalls` settled.
	 */
	// reload 交换：标记 handedOver、停止例程、把作业交给新实例；本实例不再接收新作业 start，
	// 已有调用继续运行到 drainCalls 结算。
	handOver(): void {
		this.#reload().handedOver = true;
		this.stopRoutines();
		for (const job of this.#jobs.values()) job.handOver();
	}

	/** Its routines stop (their ctx aborted); their running calls are waited for by the drain or the handover. */
	// 停止例程并标记，阻止 handover 之后迟到的启动；在途调用由 drain 或新实例的 handOverRoutines 等待。
	stopRoutines(): void {
		this.#reload().routinesStopped = true;
		this.#stopRoutines(
			new ChordError({ code: "released", reason: "ended", message: `${this.#object.label}: reloaded` }),
		);
	}

	/**
	 * The new attempt's routines may start: once this attempt's routine calls finished, bounded by `closeTimeout` (a
	 * stuck one is reported `drain_timeout`; the whole attempt is sealed by then: the swap's retirement drains its
	 * calls and routine calls on the same bound from the swap's start, then seals it, so a stuck call's later commit
	 * is refused `released`).
	 */
	// 等本实例的例程调用结束，新实例随后才能启动例程；最多等 closeTimeout，超时只报告 drain_timeout。
	async handOverRoutines(): Promise<void> {
		const { host, label } = this.#object;
		const calls = this.#routineRun?.calls ?? NO_WORK;
		if ((await drained(calls.keys(), calls.size, host.timeouts.close)) === "timeout") {
			host.report({ kind: "drain_timeout", object: label });
		}
	}

	/**
	 * Waits for its running calls and routine calls (not its job invocations), bounded by `closeTimeout`
	 * (`drain_timeout` reported): a reload's swap or restart lets them finish before the seal. Its end's drain then
	 * waits for them no more.
	 */
	// swap/restart 前等待普通调用与例程调用（不含作业运行）；标记 callsDrained，使 close 的 drain 不重复等待。
	async drainCalls(): Promise<void> {
		const { host, label } = this.#object;
		// 展开两个 Map 的键得到数组，drained 需要长度与可迭代对象。
		const calls = [...this.#running.keys(), ...(this.#routineRun?.calls ?? NO_WORK).keys()];
		this.#reload().callsDrained = true;
		if ((await drained(calls, calls.length, host.timeouts.close)) === "timeout") {
			host.report({ kind: "drain_timeout", object: label });
		}
	}

	/** A reload started it: once live, its object retries its blocked job runs (slice 7b §8). */
	// 标记本实例由 reload 启动；对象 live 后据此重试被阻塞的作业运行。
	startedByReload(): void {
		this.#reload().started = true;
	}

	/** Whether a reload started it. */
	// 读取标记；未经历 reload 时 #reloaded 为 undefined，结果为 false。
	get reloadStarted(): boolean {
		return this.#reloaded?.started === true;
	}

	/** What a reload did to it, made by the first such step. */
	// 懒创建四个布尔记录；??= 仅在未创建时赋值，后续步骤共享同一对象。
	#reload(): Reloaded {
		this.#reloaded ??= { started: false, handedOver: false, callsDrained: false, routinesStopped: false };
		return this.#reloaded;
	}

	/** Whether its factory declared job `name`. */
	// 查询本次尝试的工厂是否声明了该作业；reload 用它判断旧作业是否仍有新实现接手。
	declaresJob(name: string): boolean {
		return this.#jobs.has(name);
	}

	/** Whether its factory opens natives (`self.open`): a reload restarts it instead of swapping it. */
	// 有 native 的尝试不能纯交换（旧连接无法迁移），reload 选择重启。
	get opensNatives(): boolean {
		return this.#natives.length > 0;
	}

	/**
	 * Its first dependency check: why it parked (`parkedCause`), `undefined` when it went on (its dependencies live) or
	 * its activation ended before (a reload's report and a swap's handover wait for it).
	 */
	// 返回首次依赖检查结果的 Promise。已完成直接 Promise.resolve；已有等待者复用；都没有则创建等待槽。
	// 注意：resolve(undefined) 与“尚未检查”不同，后者会挂起直到 #settleCheck。
	get checked(): Promise<FailureCause | undefined> {
		const check = this.#check;
		if (check?.done === true) return Promise.resolve(check.cause);
		if (check !== undefined) return check.waiting.promise;
		const waiting = Promise.withResolvers<FailureCause | undefined>();
		this.#check = { done: false, waiting };
		return waiting.promise;
	}

	/** Its first dependency check is done: parked for `cause`, or not (once). */
	// 结算首次检查，只生效一次：未停放时复用共享 NOT_PARKED；停放时保存原因；最后唤醒等待者。
	#settleCheck(cause: FailureCause | undefined): void {
		const check = this.#check;
		if (check?.done === true) return;
		// Not parked (most attempts): the shared answer, nothing made.
		this.#check = cause === undefined ? NOT_PARKED : { done: true, cause };
		check?.waiting.resolve(cause);
	}

	/** Whether it is parked on its dependencies (the dependency check runs). */
	// 是否正处于依赖停放；#park 开始时设置，finally 清空。
	get isParked(): boolean {
		return this.#parked !== undefined;
	}

	/** Its contributions, resolved by its activation: in the registries' tables while its object is live. */
	// 返回已解析的注册表贡献；没有注册表声明时复用共享空数组。
	get contributions(): readonly RegistryContribution[] {
		return this.#registryDeclarations?.contributions ?? NONE;
	}

	/** The variant a remote object's factory chose; `undefined` for a local object. */
	// 远程对象工厂选择的 variant；本地对象始终 undefined。成员检查后才有值。
	get variant(): string | undefined {
		return this.#variant;
	}

	/** The state members, as Chord follows them. */
	// 返回状态成员表；! 成立因为调用发生在成员检查之后。直接暴露只读 Map，不复制。
	get stateMembers(): ReadonlyMap<string, DeriveSource> {
		return this.#members!.state;
	}

	/**
	 * Calls a method for `caller`, bound at `version`: a method outside the variant fails `invalid/member` first (for an
	 * older version after its table's checks), then the arguments are checked against that version (L1) and, for an
	 * older one (Q10), mapped forwards, the handler's result mapped back, or the provider's replacement of a removed
	 * method run instead; a refused method fails `contract_mismatch`. The handler runs under a ctx aborted by the caller
	 * and by this attempt's end, admitted to the drain before it runs. Either rejects the caller at once; the handler
	 * runs on, its transactions refused, and the drain waits for it. Its `ctx.get` references are released when it
	 * settles. Measured choices (fix round 2): one body for every version (with the shared part in a helper method, a
	 * call over a link was about 10% slower in the links benchmark), and no `async` (a check's throw is returned as a
	 * rejection; as an async function a local call allocated about 250 B more).
	 */
	// 执行一次方法调用。输入：方法名、原始参数、调用上下文、Caller、调用方绑定的版本号；
	// 输出 handler 结果的 Promise（旧版本会把结果映射回去）。错误：中止、成员不存在、参数/契约错误立即 reject；
	// handler 自身的同步抛错或拒绝通过 running Promise 传给调用方。
	// 流程：检查中止 -> 找本版本方法 -> checkArgs（含旧版本适配/替代）-> 合并信号与 CallContext ->
	// 先登记 drain -> 运行 handler -> 等结果 -> 旧版本映射回。
	// 例：await attempt.call("increment", [2], ctx, { principal: "alice", incarnation: "h1" }, 1);
	call(method: string, args: unknown, context: Context, caller: Caller, version: number): Promise<unknown> {
		// checked 是 checkArgs 的结果联合：本版本方法、旧版本 call 适配，或带 result 映射。
		let checked: ReturnType<typeof checkArgs>;
		let handler: Method | undefined;
		try {
			// 调用方已中止时立即停止；这个错误与后续检查一样转为 rejection。
			context.abortSignal?.throwIfAborted();
			const { served } = this.#object;
			const own = this.#members!.methods.get(method);
			// 当前版本没有该方法：不必再跑适配检查，直接 invalid/member。
			if (own === undefined && version === served.contract.version) throw this.#noMethod(method);
			// checkArgs 是运行时信任边界：校验参数，并为旧版本选择映射或拒绝。
			checked = checkArgs(served.provider, method, args, version, context);
			// kind 为 "call" 表示旧版本有替代实现；否则用本版本的方法。
			const call = checked.kind === "call" ? checked.call : undefined;
			handler = call !== undefined ? (callArgs, ctx) => call(callArgs as Value, ctx) : own;
			// 旧版本没有替代且本版本没有方法：成员被拒绝或不存在。
			if (handler === undefined) throw this.#noMethod(method);
		} catch (error) {
			// 不用 async 函数也能把同步检查错误变成 rejection；见上方英文文档的性能说明。
			return Promise.reject(error);
		}
		const { host, served } = this.#object;
		// 把调用方信号与本次尝试的 #abort 合并；handler 结束时 release 监听。
		const linked = withLinkedAbortSignal(this.#abort.signal, context);
		const callContext = linked.context;
		// A local object's handlers act as the host, its principal and its incarnation (§4); a remote one's as their
		// caller. The caller stays the reference's (presence, §19).
		// 本地对象的处理器代表本机；远程对象代表调用者。引用持有仍记录原始 caller。
		const acting = served.kind === "remote" ? caller : { principal: host.principal, incarnation: host.incarnation };
		const ctx = new CallContext(callContext, acting, host);
		// Admitted to the drain before the handler runs: the handler may end its own object before it returns.
		// 先登记再运行：处理器可能在返回前结束自己的对象，drain 必须已经知道这次调用。
		const running = Promise.withResolvers<unknown>();
		host.count("calls", 1);
		this.#admit(this.#running, running.promise, () => {
			// 清理只执行一次：减计数、移除信号监听、结算 ctx（释放 ctx.get 的引用）。
			host.count("calls", -1);
			linked.release();
			ctx.settle();
		});
		// Plugin code, not type-checked: a synchronous throw or a plain value becomes the promise. Constants: the closure
		// captures them, not the `let`s above.
		// 固定 handler 与参数为 const，避免闭包捕获可变的 let；异步 IIFE 把同步返回值/抛错统一成 Promise。
		const run = handler;
		const runArgs = checked.args;
		(async () => run(runArgs, ctx))().then(running.resolve, running.reject);
		// awaitWithContext 让等待随调用信号中止；running 本身仍继续运行（其清理由 drain 负责）。
		const settled = awaitWithContext(running.promise, callContext);
		// 本版本方法或没有结果映射：直接返回。
		if (checked.kind === "call" || checked.result === undefined) return settled;
		// The handler's result is the current version's: its mapping back is the provider's (results are not validated).
		// 旧版本：结果按提供方映射回旧形状；映射结果不做运行时校验。
		const back = checked.result;
		return settled.then((result) => back(result as Value));
	}

	/** The `invalid/member` error of a method outside the variant. */
	// 构造成员不存在/不在当前 variant 的错误；错误消息带 variant 提示。
	#noMethod(method: string): ChordError {
		return invalid("member", `${this.#object.label}${this.#inVariant()} has no method "${method}"`);
	}

	/**
	 * The keyed member `member`'s ultimate slot (slice 6a §12, rule 22: through re-exposures); an unknown one fails
	 * `invalid/member`.
	 */
	// 解析键控成员的最终槽（可能经过再暴露）。own 直接返回 slot；否则走 binding.keyedSlot。
	// 未知成员抛 invalid/member。例：const slot = attempt.keyedMember("users");
	keyedMember(member: string): KeyedSlot {
		const keyed = this.#members!.keyed.get(member);
		if (keyed === undefined) throw invalid("member", `${this.#object.label} has no keyed member "${member}"`);
		return keyed.kind === "own" ? keyed.slot : keyed.binding.keyedSlot(keyed.member);
	}

	/** The keyed members as checked: what each is (`KeyedBinding`), for the keys its object holds across attempts. */
	// 返回检查后的键控成员表；对象跨尝试持有 key 时用它识别成员类型，不复制 Map。
	get keyedMembers(): ReadonlyMap<string, KeyedBinding> {
		return this.#members!.keyed;
	}

	/**
	 * State member `member` as a consumer of `version` follows it: its own member at its version, else its shared mapping
	 * for that version (`AdaptedMembers`); `invalid/member` outside the variant, `contract_mismatch` for a version or
	 * member its provider refuses.
	 */
	// 按消费者版本读取状态成员：当前版本直接走 member；旧版本走该版本的 AdaptedMembers 映射。
	// 例：const source = attempt.memberAt("count", 1);
	memberAt(member: string, version: number): DeriveSource {
		if (version === this.#served.contract.version) return this.member(member);
		return this.#adaptedAt(version).member(member);
	}

	/** How a consumer of `version` reads keyed member `member`'s documents: mapped when older (`undefined`: as they are). */
	// 当前版本返回 undefined 表示文档原样读取；旧版本返回该版本的映射函数。
	// 例：const map = attempt.keyMapping("users", 1);
	keyMapping(member: string, version: number): ((current: JsonValue) => JsonValue) | undefined {
		if (version === this.#served.contract.version) return undefined;
		return this.#adaptedAt(version).keyed(member);
	}

	/**
	 * Pins `key` of keyed member `member` on this instance, loaded (its own slot's document, or the re-exposed reference's
	 * key), as a consumer of `version` reads it (mapped when older); `release` lets it go.
	 */
	// 在当前实例上 pin 一个键控 key，并加载其文档。输入成员名、key、消费者版本、上下文；输出 PinnedKey。
	// 先按 own 或再暴露选择 raw pin；当前版本直接返回；旧版本再包一层映射，release 同时释放映射与 raw。
	// 映射创建失败时先释放 raw，避免 pin 泄漏。
	// 例：const pinned = await attempt.pinKey("users", "u1", 1, ctx);
	async pinKey(member: string, key: string, version: number, context: Context): Promise<PinnedKey> {
		const keyed = this.#members!.keyed.get(member);
		// 未知成员在 pin 前就拒绝，避免创建无效资源。
		if (keyed === undefined) throw invalid("member", `${this.#object.label} has no keyed member "${member}"`);
		// own 用本实例槽；再暴露的成员把 pin 请求转给其绑定。
		const raw =
			keyed.kind === "own"
				? await pinned(keyed.slot, key, context)
				: await keyed.binding.pinKey(keyed.member, key, context);
		// 当前版本消费者直接读原文档。
		if (version === this.#served.contract.version) return raw;
		try {
			// 旧版本：共享映射按“成员 + 文档”建立，release 幂等。
			const mapped = this.#adaptedAt(version).key(member, raw.source);
			return {
				source: mapped.source,
				release: () => {
					mapped.release();
					raw.release();
				},
			};
		} catch (error) {
			// 映射构造失败（例如成员被拒绝）时不能留下已 pin 的文档。
			raw.release();
			throw error;
		}
	}

	/** No consumer of `version` is left: its shared mapping goes. */
	// 某旧版本已无消费者：删除共享映射并 detach，watch 以对象 ended 错误结束。
	// 没有该版本时直接返回，不创建任何东西。
	dropVersion(version: number): void {
		const adapted = this.#adapted?.get(version);
		if (adapted === undefined) return;
		this.#adapted!.delete(version);
		adapted.detach(this.#object.ended());
	}

	/** Its mapping for `version`, made by the first use, reading this instance's own members and provider. */
	// 懒创建某版本的 AdaptedMembers；首次使用时以本实例成员读取与 host.report 构造。
	// 同一版本复用同一对象，保证“每个提交每版本一次 diff”。
	#adaptedAt(version: number): AdaptedMembers {
		this.#adapted ??= new Map();
		let adapted = this.#adapted.get(version);
		if (adapted === undefined) {
			const { host, label } = this.#object;
			adapted = new AdaptedMembers(
				{
					served: this.#served,
					variant: this.#variant,
					label,
					batch: host.batch,
					member: (name) => this.member(name),
					report: (member, error) => host.report({ kind: "derive_failed", object: label, member, error }),
				},
				version,
			);
			this.#adapted.set(version, adapted);
		}
		return adapted;
	}

	/** The state member `member`, as Chord follows it; one outside the variant fails `invalid/member`. */
	// 读取当前 variant 的状态成员；不存在时 invalid/member，消息带 variant 提示。
	member(member: string): DeriveSource {
		const source = this.#members!.state.get(member);
		if (source === undefined) {
			throw invalid("member", `${this.#object.label}${this.#inVariant()} has no state member "${member}"`);
		}
		return source;
	}

	/**
	 * Ends the attempt at once (the seal fence): calls, openers and routines aborted with `error` (their callers
	 * rejected with it), its transactions refused and the one holding the line discarded, its job invocations cut off
	 * (an in-memory run ends `aborted` with `runs` as its reason: `reload` for a native restart, slice 7b §8); documents
	 * stay readable.
	 */
	// 立即封闭尝试：abandon 以 ended 原因中止调用、opener 与例程；fence 文档令牌，拒绝后续事务并丢弃持锁者；
	// 封闭所有作业。文档仍可读。runs 区分 reload/restart，影响作业运行的结束原因。
	// 例：attempt.seal(error, "reload")。
	seal(error: ChordError, runs: CutReason = "restart"): void {
		this.abandon({ kind: "ended", error });
		const { documents } = this.#object;
		documents.fence(this.#token);
		for (const job of this.#jobs.values()) job.seal(error, runs);
	}

	/**
	 * Tears a sealed attempt down: waits for its running handlers, routine calls and runs up to the host's
	 * `closeTimeout` (the drain), then closes its natives in reverse with `reason`. Resolves with the closes that threw.
	 */
	// 拆除已封闭的尝试：先 drain（最多 closeTimeout，超时报告），再写回作业状态（已交接的跳过），
	// 清理卡住工作的簿记，最后逆序 close native，收集失败的 close。
	// 返回 CloseFailed[]；单个 native close 抛错不会阻止其余关闭。
	async close(reason: NativeCloseReason): Promise<CloseFailed[]> {
		const { host, label } = this.#object;
		if ((await this.#drained()) === "timeout") host.report({ kind: "drain_timeout", object: label });
		// The close writer: the persisted runs the seal stopped, and the held state changes (slice 6b §4.2).
		const handedOver = this.#reloaded?.handedOver === true;
		if (!handedOver) for (const job of this.#jobs.values()) await job.writeAtClose(this.#context);
		// Work stuck past the drain keeps running, but no longer counts as a call or holds its `ctx.get` references.
		cleanUp(this.#running);
		cleanUp(this.#routineRun?.calls);
		if (!handedOver) cleanUp(this.#runs);
		const failures: CloseFailed[] = [];
		// 逆序关闭：后打开的先关闭，符合资源依赖顺序；展开副本避免遍历时集合变化。
		for (const native of [...this.#natives].reverse()) {
			const failure = await native.close(reason);
			if (failure !== undefined) failures.push(failure);
		}
		return failures;
	}

	/**
	 * The drain at its end, bounded by `closeTimeout`: its running calls (unless a reload's `drainCalls` waited for them
	 * already), routine calls and job invocations (unless a swap handed its jobs over: they finish on their own).
	 */
	// 计算本次结束需要等待的工作：已 drainCalls 的调用不再等；已 handOver 的作业运行不再等。
	// 大多数尝试只有 #running，直接传 keys/size，避免构造数组。
	#drained(): Promise<"settled" | "timeout"> {
		const { close } = this.#object.host.timeouts;
		const reloaded = this.#reloaded;
		const running = reloaded?.callsDrained === true ? NO_WORK : this.#running;
		const runs = reloaded?.handedOver === true ? undefined : this.#runs;
		const routineCalls = this.#routineRun?.calls;
		// Most attempts have only calls: no list is made for them.
		if (routineCalls === undefined && runs === undefined) return drained(running.keys(), running.size, close);
		const all = [...running.keys(), ...(routineCalls ?? NO_WORK).keys(), ...(runs ?? NO_WORK).keys()];
		return drained(all, all.length, close);
	}

	/**
	 * Detaches its derives (once their object no longer needs them: reads throw `released`, their watches end), its
	 * followed sources (their observers detached, their watches ended) and its writables (their watches ended).
	 */
	// 分离本尝试的派生资源：旧版本映射、derives、followed 源、writables；都使用对象 ended 错误。
	// 不释放引用与注册表读取（由 releaseReferences 负责）。
	detach(): void {
		const ended = this.#object.ended();
		for (const adapted of this.#adapted?.values() ?? []) adapted.detach(ended);
		this.#adapted = undefined;
		for (const derive of this.#derives) derive.detach(ended);
		for (const follow of this.#follows) follow.detach();
		const declarations = this.#registryDeclarations;
		if (declarations !== undefined) for (const writable of declarations.writables) writable.detach(ended);
	}

	/** Releases its references and registry reads. */
	// 释放所有引用绑定与注册表读取；reads 用 splice(0) 取出并清空，保证只释放一次。
	releaseReferences(): void {
		for (const { binding } of this.#references) binding.release();
		const declarations = this.#registryDeclarations;
		if (declarations !== undefined) for (const release of declarations.reads.splice(0)) release();
	}

	/** The activation steps; each catches its own failures with their kind (the table in slice 2's spec). */
	// 激活主流程（不包含等待前一个实例）。输入 deadline；输出 Activation。
	// 顺序：工厂声明 -> 交 retry 源 -> hydrate/load 文档 -> 迁移表 -> 加载作业持久运行 -> 绑定引用 ->
	// 环检查 -> 读取注册表依赖 -> 依赖检查/停放 -> 自身步骤。
	// 工厂、文档、绑定等失败归为 broken；依赖与自身步骤按各自规则归类。
	// 例：const outcome = await this.#activate(deadline)。
	async #activate(deadline: Deadline): Promise<Activation> {
		let implementation: unknown;
		// 默认无依赖；后面的 catch 需要它保持已赋值状态。
		let dependencies: readonly Dependency[] = NONE;
		try {
			// 只在这里运行工厂；返回原始实现，稍后由 checkImplementation 检查。
			implementation = this.#declare();
			// Right after the factory, before anything can fail: a failed attempt keeps its wake signals.
			// 工厂刚返回就交源，确保后续任何失败都不会丢失唤醒能力。
			this.#object.retryOn(this.#registryDeclarations?.retrySources ?? NONE);
			const { documents } = this.#object;
			// The object holds the pins from now on.
			// splice(0) 把 pin 列表清空并转交对象；工厂若抛错，由 #declare 自己释放这些 pin。
			documents.hydrate(this.#declared, this.#pins.splice(0), this.#opening);
			const loading = documents.load(this.#opening);
			if (loading !== undefined) await loading;
			// 有表才迁移；迁移会暂停 deadline，避免长迁移耗尽激活预算。
			if (this.#tables.size > 0) await this.#prepareTables(deadline);
			// A persisted job's runs, loaded once per object: rebuilt before anything runs.
			for (const job of this.#jobs.values()) await job.load(this.#opening);
			const { host } = this.#object;
			// 逐个绑定引用；绑定可能异步等待远端对象。
			for (const { binding, contract, params } of this.#references) {
				host.bind(binding, contract, params, this.#opening);
			}
			// Once all are bound: a dependency made here may have bound back to this object meanwhile.
			// 必须先全部绑定再查环，否则互相引用的对象可能在对方目标尚未设置时漏检。
			for (const { binding } of this.#references) {
				const { target } = binding;
				if (target !== undefined) this.#object.assertNoCycle(target, this.#opening);
			}
			// Needed only up to the dependency check: a live attempt keeps none.
			// 取走依赖列表并清空字段，避免 live 对象长期持有它。
			dependencies = this.#dependencies ?? NONE;
			this.#dependencies = undefined;
			for (const dependency of dependencies) {
				// Read from here until its references are released: an older version's mapping is kept meanwhile.
				// 注册表读取要保留到引用释放，否则旧版本映射可能被过早回收。
				if (dependency.kind === "registry") this.#declarations().reads.push(dependency.value.read());
			}
		} catch (error) {
			// 工厂/文档/绑定/环检查失败统一按 broken 处理。
			return this.#broken(error);
		}
		// Parked only when something is not live yet (most activations find their dependencies live).
		// 快速检查一次；有 at(key) pin 时也必须进停放流程来加载它们。
		if ((dependencies.length > 0 && checkDependencies(dependencies).kind !== "live") || this.#pinsKeys()) {
			const parked = await this.#park(dependencies, deadline);
			if (parked !== undefined) return parked;
		} else {
			this.#settleCheck(undefined);
			// Its own steps start in a later turn: an object ended in the turn it was made opens nothing.
			// await undefined 让出一个微任务；同一轮创建后立即结束的对象不会晚开 native。
			await undefined;
		}
		return this.#ownSteps(implementation);
	}

	/**
	 * Parks while a dependency is not live (dependency model §3), with no timer: the deadline paused, `parked_long`'s
	 * report the only clock. Checks at every change of a dependency (after its batch) and shows what it found on its
	 * object; once all are live, the keys the factory pinned on them are loaded (a failed load parks it `waiting`
	 * until the next change or a retry). Resolves `undefined` once all are live and pinned, else with how it ends:
	 * abandoned, or broken (a cycle, an ended dependency).
	 */
	// 停放循环。输入依赖列表与期限；输出 undefined（可以继续）或 NotLive（被放弃/永久失败）。
	// 暂停 deadline（停放不计入 readyTimeout），登记 waitsFor 与注册表等待，创建 ParkedLong；每轮检查：
	// broken -> 失败；live -> 加载 pinned keys，期间无变化则 unparked 继续；parked -> 展示状态、记录原因并等待变化。
	// finally 停止诊断计时、释放注册表等待、清空停放状态并恢复 deadline。
	// 例：const ended = await this.#park(dependencies, deadline); if (ended !== undefined) return ended;
	async #park(dependencies: readonly Dependency[], deadline: Deadline): Promise<NotLive | undefined> {
		const object = this.#object;
		// 停放期间不消耗激活预算；ParkedLong 负责超长停放诊断。
		deadline.pause();
		this.#parked = dependencies;
		object.waitsFor(dependencies);
		// Waiters on a registry are woken when its value turns usable or its failure changes.
		const waits: (() => void)[] = [];
		for (const each of dependencies) if (each.kind === "registry") waits.push(each.value.wait(this));
		const long = new ParkedLong(object);
		try {
			// for (;;) 是无限循环，只能由 return 或 nextChange 失败退出。
			for (;;) {
				// 每轮先清“已变化”标记；检查期间再来的变化会把它重新置 true。
				this.#moved = false;
				const check = checkDependencies(dependencies);
				// 只要不再 parked（live 或 broken），首次检查就有结果了。
				if (check.kind !== "parked") this.#settleCheck(undefined);
				if (check.kind === "broken")
					return this.#abandoned ?? { kind: "failed", cause: { kind: "broken", error: check.error } };
				if (check.kind === "live") {
					// 依赖已 live，还要加载工厂在这些依赖上 pin 的 key。
					const pinned = await this.#pinKeys(long);
					if (this.#abandoned !== undefined) return this.#abandoned;
					// Changed while the keys loaded: checked again.
					// 加载期间没有变化且没有失败的 pin：真正离开停放。
					if (pinned === undefined && !this.#moved) {
						// Its own steps follow: `loading` until its outcome (a failure shows as the failure, not this).
						object.unparked(this);
						return undefined;
					}
					// 有 pin 失败：展示 waiting，但依赖本身仍 live，继续等变化或 retry。
					if (pinned !== undefined) object.parked(this, pinned, true);
				} else {
					// 仍停放：把对外状态、原因和诊断阻塞者同步给对象。
					object.parked(this, check.shown, check.firstPass);
					this.#settleCheck(parkedCause(check));
					long.blockedBy(check.blocker);
				}
				// 等下一次依赖变化；被放弃时返回 false，此时 #abandoned 必已设置。
				if (!(await this.#nextChange())) return this.#abandoned!;
			}
		} finally {
			// 无论正常离开还是失败/放弃，都要清理诊断计时器与注册表等待。
			long.stop();
			for (const release of waits) release();
			this.#parked = undefined;
			object.waitsFor(NONE);
			deadline.resume();
		}
	}

	/**
	 * Waits for the next change of a dependency (at once when one came during the check); `false` when the attempt was
	 * abandoned meanwhile (its end, the only thing that stops the wait).
	 */
	// 等待下一次依赖变化。输入无；输出 boolean：true 表示继续检查，false 表示等待期间对象被放弃（超时/结束）。
	// 若检查期间已有变化（#moved），立即返回 true；否则建立一次性 Promise，依赖变化在微任务中唤醒它。
	// awaitWithContext 把等待与 #opening 绑定：尝试被放弃时等待随之中止，走 catch 返回 false。
	// 例：检查完后没有变化，调用方挂起；之后某引用进入 live 并调用 dependencyMoved()，本方法恢复并返回 true。
	async #nextChange(): Promise<boolean> {
		// 检查期间已记录变化：无需等待，立即重查。
		if (this.#moved) return true;
		// Promise.withResolvers 同时给出 promise 和 resolve，便于外部（dependencyMoved）唤醒。
		this.#changed = Promise.withResolvers();
		try {
			// 只有 #opening 中止或 Promise resolve 才结束；中止意味着对象结束，不再继续停放。
			await awaitWithContext(this.#changed.promise, this.#opening);
			return true;
		} catch {
			// 等待被中止：对象已结束，由调用方返回 #abandoned。
			return false;
		} finally {
			// 每轮等待结束都清空句柄；下一轮重新建立。
			this.#changed = undefined;
		}
	}

	/**
	 * Loads the keys the factory pinned on its dependencies' keyed members (`at(key)`), each reference's named to `long`
	 * as the blocker while they load (`failed` when they failed); `undefined` once all are, else what the parked attempt
	 * shows for the first that failed to load (`waiting` on its reference).
	 */
	// 加载工厂在依赖键控成员上 pin 的 key。输入 ParkedLong（诊断记录）；输出 undefined（全部成功）或 Failed（第一个失败）。
	// 逐条引用调用 binding.pinKeys：返回 undefined 表示该引用没有 pin。加载时把该引用记为 loading，失败记为 failed 并返回 waiting。
	// 例：引用 A 的 at("u1") 加载失败 -> 返回 waitingOn(A.label, error)，对象保持 waiting 而不是 broken。
	async #pinKeys(long: ParkedLong): Promise<Failed | undefined> {
		for (const { binding } of this.#references) {
			const { label } = binding;
			try {
				const pinning = binding.pinKeys(this.#opening);
				// 没有 pin 的引用直接跳过。
				if (pinning === undefined) continue;
				// 加载期间 parked_long 报告看到的是 loading。
				long.blockedBy({ label, state: "loading" });
				await pinning;
			} catch (error) {
				// 失败转为等待状态；由 #park 展示，等下一次变化或 retry 再试。
				long.blockedBy({ label, state: "failed" });
				return waitingOn(label, asChordError(error, label));
			}
		}
		return undefined;
	}

	/**
	 * A dependency of this parked attempt changed (its state, its cause, its first outcome): it checks again after the
	 * batch that changed it, once however many changed. A change while it checks or loads pinned keys is remembered
	 * (`#moved`); one outside parking costs a flag.
	 */
	// 依赖变化通知入口，由引用或注册表在变化批次结束后调用。输入无；输出无。
	// 已标记则直接返回：同一轮多次变化只触发一次重查。否则置标记，并在有等待者时于微任务中唤醒。
	// 微任务合并保证“当前批次处理完再检查”，不会在依赖更新中途打断。
	dependencyMoved(): void {
		// 去重：检查进行中或已经排队的变化不再重复唤醒。
		if (this.#moved) return;
		this.#moved = true;
		// 只有 #nextChange 真正在等的时候才需要唤醒；否则仅保留标记。
		if (this.#changed !== undefined) queueMicrotask(() => this.#changed?.resolve());
	}

	/** A registry it is parked on closed with its host: the parked attempt ends with `error`. */
	// 停放所依赖的注册表随宿主关闭。输入错误；输出无；副作用：对象以 ended 结束，等待中的 #nextChange 被中止。
	closed(error: ChordError): void {
		this.abandon({ kind: "ended", error });
	}

	/** Whether its factory pinned keys on its dependencies' keyed members (`at(key)`), which load while it is parked. */
	// 是否有引用在依赖的键控成员上 pin 了 key。有则即使依赖全部 live 也必须进 #park 完成这些 key 的加载。
	// 用显式循环避免闭包分配，并便于提前 return。
	#pinsKeys(): boolean {
		for (const { binding } of this.#references) if (binding.pinsKeys) return true;
		return false;
	}

	/**
	 * `ref.retry()` on its parked object (`failed { waiting }`): passed on to every failed dependency (a broken or
	 * transient one retries, a parked one passes it on, a request waiting in an index is left alone), as a step of
	 * `walk`; then it checks again (a key that failed to load is loaded again).
	 */
	// ref.retry() 在停放对象上的入口：把重试传给所有失败的依赖，然后标记依赖变化以立即重查。
	// 输入 RetryWalk（重试遍历上下文，用于去重/环检测）；输出无。
	// 失败的 key 也会因为重查而重新加载；未失败的依赖不会被触碰。
	// 例：用户对 parked 的对象调用 retry()，这里唤醒失败引用并重新检查，成功后对象离开停放。
	retryDependencies(walk: RetryWalk): void {
		for (const dependency of this.#parked ?? NONE) {
			// 只重试失败中的引用；live/loading/ended 的引用由各自状态决定，不再传递。
			if (dependency.kind === "reference" && dependency.binding.refState.kind === "failed") {
				dependency.binding.retry(walk);
			}
		}
		// 强制下一轮立刻重新检查，包括重新加载失败的 pin key。
		this.dependencyMoved();
	}

	/**
	 * The steps after the dependency check (its own: natives, followed sources, the member check, derives, the keys
	 * references pin on its keyed members), under the deadline. A dependency that leaves `live` meanwhile changes
	 * nothing (R18 after live).
	 */
	// 依赖检查后的自身步骤：按声明顺序打开 native、attach follow 源、检查实现、解析贡献、挂接 derive 并读取初值。
	// 输入工厂返回值；输出 Activation。放弃优先于步骤结果；native 失败按 openFailure 归类（显式 broken() 为 broken，否则 transient），
	// follow attach 失败归为 transient。
	// 每个异步步骤（native/follow）前检查 #abandoned：停放期间已被结束的对象不会再晚开资源。
	async #ownSteps(implementation: unknown): Promise<Activation> {
		for (const native of this.#natives) {
			// An attempt abandoned before this open (ended while it waited) closed its natives already: none opens late.
			// 已放弃的对象其 native 已在结束流程关闭；这里直接返回，避免重新打开。
			if (this.#abandoned !== undefined) return this.#abandoned;
			try {
				await awaitWithContext(native.open(this.#opening), this.#opening);
			} catch (error) {
				// 普通 open 失败按 transient；只有显式 broken(...) 才由 openFailure 归为 broken。
				return this.#abandoned ?? { kind: "failed", cause: openFailure(error, this.#object.label) };
			}
		}
		for (const follow of this.#follows) {
			// attach 可能异步；期间对象可能被结束，所以每次 attach 前重查。
			if (this.#abandoned !== undefined) return this.#abandoned;
			try {
				await awaitWithContext(follow.attach(this.#opening), this.#opening);
			} catch (error) {
				// follow 附加失败视为暂时性问题，允许重试。
				const cause: FailureCause = { kind: "transient", error: asChordError(error, this.#object.label) };
				return this.#abandoned ?? { kind: "failed", cause };
			}
		}
		let members: Members;
		try {
			// 校验工厂返回值与契约一致；members 是工厂暴露的状态/方法集合，variant 用于远程契约。
			const checked = checkImplementation(this.#object.served.contract, implementation);
			members = checked.members;
			this.#members = members;
			this.#variant = checked.variant;
			// 引用已 live，此时才能解析注册表贡献；结果缓存在声明集合上供重载使用。
			if (this.#registryDeclarations !== undefined)
				this.#registryDeclarations.contributions = this.#resolveContributions(this.#registryDeclarations);
			const { host, label } = this.#object;
			// 激活期间的 derive 失败会整体失败尝试，由 activation_failed 统一报告；只有 live 后才逐条上报。
			attachDerives(this.#derives, members.state, (member) => (error) => {
				// During activation a throwing derive fails the attempt, which `activation_failed` reports alone.
				if (!this.#isLive) return;
				host.report({ kind: "derive_failed", object: label, ...(member === undefined ? {} : { member }), error });
			});
			// 主动读取一次，确保初始值和潜在错误在激活阶段暴露。
			for (const derive of this.#derives) void derive.value;
		} catch (error) {
			return this.#broken(error);
		}
		return this.#abandoned ?? { kind: "live" };
	}

	/** Its declared contributions, as Chord follows them (its references are live now), by its plugin and type. */
	// 把声明阶段的贡献解析成注册表记录。输入注册表声明集合；输出 RegistryContribution 数组。
	// 此时引用均已 live，可安全读取 host.registryRecord；contributor 由插件名与契约类型名组成。
	// 例：self.contribute(CacheRegistry, value) 解析为 { contributor: { plugin, type }, version, value }。
	#resolveContributions({ declared }: RegistryDeclarations): readonly RegistryContribution[] {
		const { served, host } = this.#object;
		const contributor = { plugin: served.plugin, type: served.contract.name };
		return declared.map(({ registry, value }) =>
			contributionOf(host.registryRecord(registry.name), contributor, registry.version, value),
		);
	}

	/**
	 * Brings the declared tables to their definitions before the references are bound (slice 6a §9): created fresh or
	 * migrated eagerly, with the `readyTimeout` deadline paused meanwhile (resumed with the budget it had left).
	 */
	// 在绑定引用前把声明的表带到定义版本（slice 6a §9）：新建或即时迁移。
	// 输入 deadline；输出 Promise；失败向上抛，由 #activate 的 catch 归为 broken。
	// 迁移期间暂停 readyTimeout，结束后恢复剩余预算；fence.admit 阻止对象已封存/结束时再接收迁移工作。
	// 例：对象声明了 v2 的表而存储中仍是 v1，这里先完成迁移，随后工厂/引用才看到新结构。
	async #prepareTables(deadline: Deadline): Promise<void> {
		const handles = [...this.#tables.values()];
		// prepareTables 只需要定义与表名；store 取第一个句柄的（同一宿主共享）。
		const tables = handles.map(({ definition, sql }) => ({ definition, table: sql.table }));
		const fence = { admit: () => !this.#token.sealed && this.#abandoned === undefined, adopt: () => {} };
		deadline.pause();
		try {
			await prepareTables(tables, handles[0]!.store, fence, this.#object.label, this.#opening);
		} finally {
			// 无论迁移成功与否都恢复 deadline，避免激活预算被永久暂停。
			deadline.resume();
		}
	}

	/**
	 * Runs the factory with declarations open; the member check establishes what it returned. A throwing factory
	 * releases its pins.
	 */
	// 在声明窗口打开时运行工厂。输入无；输出工厂返回值（尚未校验）。
	// 本地契约调用 factory(params, self)；远程契约额外把 principal 作为第二个参数。
	// 工厂抛错时释放它已经 pin 的 key，再原样抛出；finally 一定关闭声明窗口。
	// 例：工厂内 self.get(...) 合法；工厂返回后保存的 self 再调用声明 API 会抛错（#assertDeclaring）。
	#declare(): unknown {
		this.#declaring = true;
		try {
			const { served, params, principal } = this.#object;
			// 本地对象没有 principal，只传参数与 self。
			if (served.kind === "local") return served.factory(params, this);
			// A remote object's identity has its principal.
			// 远程对象的身份包含 principal；声明策略保证此时它已存在，! 表达该不变量。
			return served.factory(params, principal!, this);
		} catch (error) {
			// 工厂失败：这些 pin 尚未转交对象，必须在这里释放，否则键控文档无法回收。
			for (const release of this.#pins) release();
			throw error;
		} finally {
			this.#declaring = false;
		}
	}

	/**
	 * Persisted data needs a stable identity (P3: a `local` type with empty params, also checked by the types) and the
	 * host's store; returns the store.
	 */
	// 持久化前提检查：必须是本地契约且参数为空（稳定身份 P3，类型层面也有限制），且宿主配置了 store；返回 store。
	// 不满足时抛普通 Error：这是开发期声明错误，不是运行时 ChordError。
	#assertPersistable(what: string): ChordStore {
		const { host, served, label } = this.#object;
		if (served.kind !== "local" || contractData(served.contract).params.fields.length > 0) {
			throw new Error(`${label}: ${what}: persist needs a stable identity (a local type with empty params)`);
		}
		if (host.store === undefined) throw new Error(`${label}: ${what}: persist needs a store`);
		return host.store;
	}

	/**
	 * Adds `running` to `work` (its calls, routine calls or job invocations: the drain), with `cleanup` run once: when
	 * it settles, or at teardown if it never does.
	 */
	// 把正在运行的工作登记进 work（调用、例程调用或作业调用的 drain 集合），并保证 cleanup 恰好执行一次：
	// 正常 settle 时执行；若到 teardown 仍未 settle，则由 close 的清理步骤执行。
	// 输入 work、running、可选 cleanup；输出无。
	#admit(work: Work, running: Promise<unknown>, cleanup?: () => void): void {
		work.set(running, cleanup);
		// Out of the map already: the teardown ran the cleanup.
		// 只有仍能从 map 删除时才执行 cleanup；删除失败说明 teardown 已清理过，不能重复执行。
		const settled = (): void => {
			if (work.delete(running)) cleanup?.();
		};
		// 成功与失败都要清理，因此两个分支传同一个回调。
		running.then(settled, settled);
	}

	/** Whom this object's own work acts for: a remote object as its principal, a local one as the host; from this host. */
	// 本对象自身工作所代表的主体：远程对象用其 principal，本地对象用宿主 principal；incarnation 始终是本机。
	// 例：本地对象运行时调用授权检查，看到的主体是宿主 principal，而不是任意调用者。
	#caller(): Caller {
		const { host, served, principal } = this.#object;
		return { principal: served.kind === "remote" ? principal : host.principal, incarnation: host.incarnation };
	}

	/** ` (variant reader)` for a remote object, for errors. */
	// 错误消息里的 variant 后缀：远程对象且已确定 variant 时返回 " (variant X)"，本地对象返回空串。
	#inVariant(): string {
		return this.#variant === undefined ? "" : ` (variant ${this.#variant})`;
	}

	// 把未知错误收敛为 broken 激活结果；若期间已被放弃，放弃结果优先，避免覆盖 ended。
	#broken(error: unknown): Activation {
		const cause: FailureCause = { kind: "broken", error: asChordError(error, this.#object.label) };
		return this.#abandoned ?? { kind: "failed", cause };
	}

	// 惰性创建注册表声明集合；工厂可能完全不使用注册表，因此不在构造函数里分配。
	#declarations(): RegistryDeclarations {
		this.#registryDeclarations ??= {
			reads: [],
			retrySources: [],
			writables: [],
			declared: [],
			contributions: NONE,
		};
		return this.#registryDeclarations;
	}

	// 运行时检查：声明 API 只能在工厂执行期间调用；否则抛普通 Error，提示是开发期误用。
	#assertDeclaring(declaration: string): void {
		if (!this.#declaring) {
			throw new Error(`${this.#object.label}: self.${declaration} is valid only in the factory`);
		}
	}
}

/** Pins `key` on `slot` and loads it when it is not in memory; a failed load releases the pin. */
// 在键控槽位上 pin 一个 key 并确保其加载。输入 slot、key、context；输出 PinnedKey（source + release）。
// 先 pin 再 ensure：pin 防止加载期间文档被回收。加载失败时先释放 pin 再抛出，避免泄漏。
// 例：const key = await pinned(slot, "u1", ctx); try { ... } finally { key.release(); }
async function pinned(slot: KeyedSlot, key: string, context: Context): Promise<PinnedKey> {
	const release = slot.pin(key, context);
	try {
		await slot.ensure(key, context);
	} catch (error) {
		// 加载失败：释放刚建立的 pin，再把原始错误交给调用方。
		release();
		throw error;
	}
	return { source: slot.source(key), release };
}
