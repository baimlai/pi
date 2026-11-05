// Hosts (§3): `createHost`, loading facets and the start barrier, links to children, the parent (connected again after
// a drop) and routes, the origins it relays holds for, getting and holding references as a principal, the heartbeat
// of every link, revocation (§4), presence (§19) and keep-alive counts, registries and root scopes (slice 8), reloads
// (slice 7b: staging, the commit, each object's fate, the report), closing; one batch per host, the backoff map and the
// endings new instances wait for.

// 所属：packages/chord/src/host 的宿主实现（设计 §3、§4、§19；slice 7b、8）。
// 职责边界：实现 createHost 返回的 Host 实例——启动屏障、对象/引用入口、链路与路由、撤销、presence、注册表、根作用域、
// 重载与关闭。它不实现对象内部状态机（object.ts）、引用绑定（reference.ts）或链接协议（remote/）。
// 上游：应用调用 createHost(...) 后使用 load/reload/get/hold/accept/connect/route/revoke/root/registry/close；
// 下游：staging（插件发布）、ChordObject（对象）、Destination（放置）、HostLink/RemoteObject（链接）、RegistryRecord、
// Batch（可观察源提交）、Backoff、Activity、References、Store。
// 结果与错误：同步配置错误抛普通 Error；运行期错误统一为 ChordError（not_ready/invalid/forbidden/unavailable/
// contract_mismatch/released/aborted 等）；后台失败经 onError 报告，不向无等待者的路径抛出。
// 能力清单：
// - HostOptions：createHost 配置（principal、telemetry、onError、超时、心跳、压缩、store）。
// - Position：错误定位中的声明位置（on/onLive/native）。
// - HostError：宿主报告给 onError 的错误联合（对象失败、注册表未声明、关闭失败、存储失败等）。
// - LinkOptions/GetOptions：链路与 get 的选项（principal、trusted、limits、readyTimeout）。
// - AnyHost：去掉创建/加载/连接等入口后的宿主内部视图，供对象与引用依赖。
// - Host：应用使用的宿主接口（load/reload/get/hold/accept/connect/route/revoke/references/activity/registry/root/close）。
// - PluginFailure/LoadReport/ReloadOptions/ReloadReport/ReloadedObject/CommittedReload：load/reload 的失败与逐对象结果。
// - Serving：远端 hold 落点的结果（object 或 waiting 原因）。
// - createHost：构造 ChordHost 的工厂函数。
// - ChordHost：宿主类，包含全部公开方法与内部协作方法。
// 组合与典型调用顺序：createHost -> route（必须 load 前）-> load（staging + 发布 + 首次结局屏障）-> get/hold/root/registry
// -> reload（staging -> closure -> commit -> report）-> close（关链路、结束对象、逆序拆卸）。
// 示例：const host = createHost<AppPrincipal, Revocation>({ onError: (error) => log(error) });
//       const report = await host.load([defineFacet((h) => h.serve(Counter, factory))], context);
//       const counter = await host.get(Counter, { name: "a" }, context);
//       await host.close(context);
// 建议阅读顺序：HostOptions/Host/HostError 类型 -> createHost -> load（启动屏障）-> get/hold/#hold/#place/bind
// -> reload/#reload/#stageReload/#commit/#report -> close；对象细节转 object.ts，引用细节转 reference.ts。

import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	type Context,
	withAbortSignal,
	withoutAbortSignal,
} from "../context/index.ts";
import type { Address, Contract, HostKind, ParamsOf } from "../contracts/index.ts";
import { contractData, type Params } from "../contracts/internal.ts";
import { ChordError, type FailureCause, type Principal, type PrincipalKeyFunction } from "../data/index.ts";
import {
	asChordError,
	binds,
	canonicalJson,
	checkParams,
	identityKey,
	invalid,
	principalKey,
} from "../data/internal.ts";
import type { TransactionCancelled } from "../documents/internal.ts";
import type { JsonValue } from "../json.ts";
import { binaryCodec, type Codec, type Compression, type Link, type PartLimits } from "../link/index.ts";
import { linkLimits } from "../link/internal.ts";
import type { Registry, RegistryValue } from "../registries/index.ts";
import type { RegistryValueSource } from "../registries/internal.ts";
import { type RegistryContribution, type RegistryError, RegistryRecord } from "../registries/internal.ts";
import {
	type HoldRequest,
	HostLink,
	type LinkRole,
	Path,
	type ProviderSide,
	RemoteObject,
	type Upstream,
} from "../remote/internal.ts";
import { Batch, type BatchError } from "../state/internal.ts";
import type { ChordStore, Store } from "../store/store.ts";
import type { Watchable } from "../watch.ts";
import { Activity, type ActivityCounts } from "./activity.ts";
import { type Attempt, notLive } from "./attempt.ts";
import { Backoff } from "./backoff.ts";
import { type Caller, type Ctx, withLinkedAbortSignal } from "./ctx.ts";
import { Destination, type Placed } from "./destination.ts";
import type { Facet } from "./facet.ts";
import { contributionOf } from "./members.ts";
import type { CloseFailed } from "./native.ts";
import { ChordObject, type Holder, type ReloadFate, type Served } from "./object.ts";
import { type Presence, References } from "./presence.ts";
import { Binding, type CheckedParams, type Held, type Reference, type Target } from "./reference.ts";
import { RevocationKeys, type RevokedBy } from "./revocation.ts";
import { type RootOptions, RootScopes } from "./root.ts";
import { Route, type RouteHandle, type RouteOptions } from "./route.ts";
import {
	addStaged,
	checkPluginNames,
	emptyStaged,
	type PluginFacet,
	type Recorded,
	type Request,
	recordFactory,
	type Staged,
	type StagedPlugin,
	type StagedRegistry,
	type StagingHost,
	stagePlugin,
} from "./staging.ts";
import { UnboundIndex, type UnboundRequest } from "./unbound.ts";
import { UnboundClock, type UnboundLong } from "./unbound-clock.ts";
import { uuidv7 } from "./uuid.ts";

/** What `createHost` takes; `R` is the app's revocation type (JSON). */
// 宿主选项。P 是应用 principal 类型，R 是撤销值类型；二者只在编译期约束，运行时由调用方保证形状。
// 必填 onError 决定所有后台错误（激活失败、关闭失败、协议错误等）的去向；其余均可选。
export type HostOptions<P extends Principal = Principal, R extends JsonValue = JsonValue> = {
	/** This host's address (`Session({ id })`): it serves only objects placed there. Without one, a client. */
	// 地址决定哪些对象“放在本机”；不提供地址的宿主是客户端，只发请求不服务。
	readonly address?: Address;
	/** Who this host acts as for its own requests; a host without one (a client) has none. */
	readonly principal?: P;
	/** The key of a principal in identities; L1's canonical JSON by default. The same function on every host. */
	// principalKey 决定身份字符串：不同 principal 是否等价、对象 identity 是否相同都依赖它。
	readonly principalKey?: PrincipalKeyFunction<P>;
	/** The telemetry adapter; NOOP by default. */
	readonly telemetry?: TelemetryContext;
	/** Everything that fails in the background; every app handles it. */
	readonly onError: (error: HostError) => void;
	/** How long a native's close, and an ending object's running calls, are waited for; 30 s by default. */
	// 关闭/排空的宽限时间；超时只报告，不强杀插件代码。
	readonly closeTimeout?: number;
	/** How long an activation attempt, and a `get`, may take until the object is live; 60 s by default. */
	// 激活与 getter 的默认截止时间；单个 get/hold 可用 GetOptions.readyTimeout 覆盖。
	readonly readyTimeout?: number;
	/**
	 * The heartbeat of every link: a link silent for `ping` ms (15 s by default) sends a `ping`; one silent for `close`
	 * ms (30 s by default), its handshake included, is closed.
	 */
	// 心跳参数：ping 控制探测频率，close 控制判定死亡；宿主只为所有链接维护一个计时器。
	readonly heartbeat?: { readonly ping?: number; readonly close?: number };
	/**
	 * What revokes a principal (§4): `host.revoke(r)` ends the objects and closes the child links of every principal
	 * `p` whose `revokedBy(p)` holds `r` (compared as canonical JSON). The same function on every host.
	 */
	// 撤销判定函数：host.revoke(r) 时对每个 principal 调用；只有远程对象与子链接会受影响。
	readonly revokedBy?: RevokedBy<P, R>;
	/**
	 * A synchronous compressor (`nodeCompression` for Node): JSON parts above 16 KiB this host originates are deflated
	 * once, and deflated parts it owns inflated in place. Without one (a browser), nothing is compressed and deflated
	 * parts are inflated asynchronously, later messages of their link waiting in order.
	 */
	// 压缩器是同步实现（Node 的 zlib）；浏览器没有时，压缩由对端负责，本地异步解压并按序等待。
	readonly compression?: Compression;
	/**
	 * The store persisted documents and tables live in (`openStore`); the app owns it and closes it after the host.
	 * One open host per store. A `storage_failed` of the store is reported once and closes the host.
	 */
	// 存储由应用打开并关闭；一个 store 只能附加一个宿主。后端失败会让宿主自行关闭（#storageFailed）。
	readonly store?: Store;
};

/** Where a reported part sits on its object: a routine (`on`, `onLive`) or a native, by kind, from 1 in declaration order. */
// 错误/报告中的位置：routine 种类或 native，位置从 1 开始按声明顺序编号。
export type Position = { readonly kind: "on" | "onLive" | "native"; readonly position: number };

/**
 * What `onError` gets, by kind. `object` is the object's type, with its params key when it has params; `failure` is a
 * `FailureCause`, `error` the plain error.
 */
// onError 收到的后台事件联合：激活/运行失败、存储失败、关闭失败/超时、协议错误、derive/routine/job 失败、
// 未绑定等待过长、parked 过久等。每种 kind 的字段决定应用如何记录/上报；这是运行时形状，类型仅编译期检查。
export type HostError =
	| BatchError
	| RegistryError
	| UnboundLong
	| TransactionCancelled
	| { readonly kind: "activation_failed"; readonly object: string; readonly failure: FailureCause }
	/** A live object failed at runtime (a `migrate` failing on access, a stored version newer than the code). */
	| { readonly kind: "object_failed"; readonly object: string; readonly failure: FailureCause }
	/** The host's store stopped after a backend error: the host closes itself (once). */
	| { readonly kind: "storage_failed"; readonly error: unknown }
	| { readonly kind: "close_failed"; readonly object: string; readonly native: Position; readonly error: unknown }
	| { readonly kind: "close_timeout"; readonly object: string; readonly native: Position }
	| { readonly kind: "drain_timeout"; readonly object: string }
	| { readonly kind: "protocol_error"; readonly error: unknown }
	| { readonly kind: "resolve_failed"; readonly address: string; readonly error: unknown }
	/**
	 * A derive's compute threw (its owner's, once per failure episode: the first failure after a value or after its
	 * creation; a value ends the episode); `member` when it is an exposed state member.
	 */
	| { readonly kind: "derive_failed"; readonly object: string; readonly member?: string; readonly error: unknown }
	/** A routine's call threw, or its source failed for good; `routine` is its kind and position. */
	| { readonly kind: "routine_failed"; readonly object: string; readonly routine: Position; readonly error: unknown }
	/** A job's `run` threw (not after an abort): its outcome is `failed { threw }`. */
	| {
			readonly kind: "job_failed";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly error: unknown;
	  }
	/** A job's `finish` threw: retried with backoff, blocked after five failures in a row. */
	| {
			readonly kind: "job_finish_failed";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly error: unknown;
	  }
	/** A persisted run was cut off five times in a row by crashes (D6): it ends `failed { restart_limit }`, `finish` runs. */
	| {
			readonly kind: "job_interrupted";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly restarts: number;
	  }
	/** A blocked run was dropped without `finish`: aborted, or its object ended. */
	| { readonly kind: "job_dropped"; readonly object: string; readonly job: string; readonly id: string }
	/**
	 * An attempt parked longer than `readyTimeout` (since `since`, `Date.now()` time), whatever its blocker: once per
	 * parking episode, naming the first blocker in declaration order (`waitingFor`, a reference's label or `registry
	 * <name>`) and its `state`; a diagnostic of a ring across hosts started at the same moment or a long wait (nothing
	 * fails).
	 */
	| {
			readonly kind: "parked_long";
			readonly object: string;
			readonly waitingFor: string;
			readonly state: "loading" | "failed";
			readonly since: number;
	  };

/**
 * What `accept` and `connect` take: the principal of the host at the other end, as this host stamps it; `trusted` skips
 * the message check on the link (IPC to the host's own processes; never grants the principal fields); the codec both
 * ends of the link use (`binaryCodec` by default); and the limits per part of what arrives on it (Q2: none on a
 * trusted link, 16 MiB on the wire and 64 MiB decoded otherwise, unless set).
 */
// 建立链接的选项。principal 是对端宿主在此处的身份（由本端盖章）；trusted 只跳过消息编码检查，
// 不改变 principal 字段；limits 控制单条 part 的大小上限。
export type LinkOptions<P extends Principal = Principal> = {
	// 链路代表谁行事；远程对象的身份与权限都包含这个 principal。
	readonly principal: P;
	// trusted 放宽分片限额；codec 决定编解码；limits 覆盖默认数额。三者都只由应用配置，运行时不重复校验类型。
	readonly trusted?: boolean;
	readonly codec?: Codec;
	readonly limits?: PartLimits;
};

/** What `host.get` and `host.hold` take besides the type, the params and the context. */
// get/hold 的选项类型；目前只有 readyTimeout 一项，缺省取宿主配置。
export type GetOptions = {
	/**
	 * A getter's deadline for its whole wait, and how long a call made while the reference is loading waits (the park
	 * deadline); the host's `readyTimeout` by default.
	 */
	// 只影响单次 get/hold：getter 总等待时间，以及引用 loading 时方法调用在队列中的期限。
	readonly readyTimeout?: number;
};

/**
 * A host whatever its principal type, as Chord's own parts use it: `ChordHost<P>` is invariant in `P` (`load` takes
 * facets typed for exactly `P`).
 */
// 去掉与 principal 类型相关的方法后得到的宿主视图，供链接/远程层等不关心 P 的实现使用。
// Omit 是编译期映射类型；ChordHost<P> 对 P 不变（load 接受精确的 P），因此不能把 ChordHost<A> 当 ChordHost<B>。
export type AnyHost = Omit<ChordHost, "load" | "reload" | "accept" | "connect" | "route" | "references" | "root">;

/** A host. `P` is the app's principal type, `R` its revocation type. */
// 应用可见的宿主接口。下面每个方法的英文文档描述行为；中文注释补充输入、副作用和常见错误路径。
export interface Host<P extends Principal = Principal, R extends JsonValue = JsonValue> {
	/**
	 * Runs every facet's setup and publishes what they declared in one batch (the types and registries served, the
	 * registries composed once, the contributions); holds that waited for the publication are placed after that batch,
	 * and a registry with contributions and no provider is reported (`registry_undeclared`). Then activates every
	 * served type with empty params and resolves when each has had its first outcome (the start barrier, decision (a)):
	 * live, failed by its own cause, parked with no blocker here still without its first outcome, or ended (failures go
	 * to `onError`). A plugin whose setup throws or is refused at declaration (a name given twice, a type or registry
	 * another plugin serves, a remote type here without principal or address, `checkAccepts`) is left out and reported
	 * (`failed`); it never closes the host. A name that is no npm name throws before anything changes. Runs once.
	 */
	// 输入：插件 facet 列表与上下文；输出：被排除的插件及错误。只能调用一次，之后状态变 loaded。
	// 副作用：运行各 setup、提交发布批次、激活空参数本地对象并等待首次结局。
	load(facets: readonly PluginFacet<P>[], context: Context): Promise<LoadReport>;
	/**
	 * Reloads this host's plugins (slice 7b): `facets` is its complete new plugin set; a plugin in it and not loaded
	 * is added, one loaded with another facet value is changed (the same facet object is unchanged: untouched), one
	 * loaded and not in it is removed. Staging runs every new setup and every affected object's new factory against a
	 * recording `self`, per plugin: a plugin whose new code fails there keeps its old code (an added one is left out),
	 * and so does a changed plugin whose recorded requests would not bind because of it (the closure rule); both are
	 * reported (`failed`); `options.failed` names plugins the caller passes as their loaded facet because their new
	 * code failed before (a build, an evaluation): the same for the closure rule and the report. Then it commits in one
	 * batch (types, registries,
	 * contributions; a publication waking the requests for the names it serves) and every object of a changed or
	 * removed plugin takes its fate: swapped in place, restarted after its drain, retried, or ended (its type
	 * removed). Resolves with the report once every fate started (swaps and retries checked their dependencies; it
	 * does not wait for objects to go live). Reloads run one after another. Throws before `load` resolved and for a
	 * name that is no npm name (before anything changes); rejects `released/closed` after `close`; `context`'s abort
	 * before the commit rejects `aborted` and changes nothing, after it only ends the wait (`aborted`, its
	 * `details.committed` naming what the commit applied: `CommittedReload`).
	 */
	// 串行执行：后一次 reload 等前一次结束。提交前失败不改变任何状态；提交后取消只影响等待报告。
	reload(facets: readonly PluginFacet<P>[], context: Context, options?: ReloadOptions): Promise<ReloadReport>;
	/**
	 * A reference once its object is live (and hydrated). It acts as the host's principal and goes where its type's host
	 * address puts it: here, over a route, or over the parent link (`Destination`). It waits while the reference is
	 * `loading`, `failed { transient }` or `failed { waiting }` until its `readyTimeout`, then rejects with the last
	 * cause and releases the reference; a broken failure rejects at once, and so does a get before `load` (`not_ready`).
	 */
	// 成功才返回引用；失败会释放已取的引用。等待上限默认 readyTimeout，可被 options 覆盖。
	get<C extends Contract>(Type: C, params: ParamsOf<C>, context: Context, options?: GetOptions): Promise<Reference<C>>;
	/**
	 * A reference at once, following its object until released: loading, live, failed (retried as its object is) and
	 * loading again while its link is down; it never rejects. Throws at once only for invalid params and before `load`
	 * (`not_ready`). A type not served where it goes is `failed { waiting }` (bound when a publication serves it;
	 * reported `unbound_long` after 5 s); a `hostAddress` or route that refuses fails it broken. Its `variant` is
	 * `undefined` until its first binding.
	 */
	// 同步返回引用；只做参数检查与放置。引用状态通过 ref.state 观察，不通过 Promise 拒绝。
	hold<C extends Contract>(Type: C, params: ParamsOf<C>, context: Context, options?: GetOptions): Held<C>;
	/**
	 * A link from a child: this host serves its remote types over it, every hold and call arriving on it acting as
	 * `principal`. `context` is the parent of the work arriving on it (its cancellation is dropped).
	 */
	// 子链接：本宿主在链接上提供远程类型。返回 void；握手完成后链接进入 #links 并参与心跳。
	accept(link: Link, options: LinkOptions<P>, context: Context): void;
	/**
	 * This host's parent link: remote types not served here and not routed are held over it, every such reference held
	 * again on a new one; holds arriving on it may name whom they act for. Throws while the previous one is open; once
	 * it closed (a drop), `connect` takes the next. `principal` is who the parent is.
	 */
	// 父链接：本宿主不服务的远程类型经它向上游请求。已有打开的父链接时同步抛错。
	connect(link: Link, options: LinkOptions<P>, context: Context): void;
	/**
	 * How this host reaches hosts of `Kind` (called before `load`, once per kind): `authorize` admits every hold routed
	 * over it, `resolve` makes the link of an address, for a new hold, on `retry`, or once after a link that completed
	 * its handshake dropped while held (no timer). A rejected `resolve`, or a link closed before its handshake, fails the
	 * address's holders `failed { waiting }` (they stay on its path). `context` is the parent of the route's work (its
	 * `resolve`s, the holds and calls on its links), aborted for it when this host closes. Returns the address controls.
	 */
	// 必须在 load 之前声明，且每种 Kind 只能一次。返回的 retry/suspend 控制该地址的链接。
	route<N extends string, Q extends Params>(
		Kind: HostKind<N, Q>,
		options: RouteOptions<P, HostKind<N, Q>>,
		context: Context,
	): RouteHandle<HostKind<N, Q>>;
	/**
	 * Revokes `revocation` (§4, R10, R11), synchronously: every remote object whose principal it revokes (`revokedBy`)
	 * ends at once, whatever references remain (holders get `forbidden`, running calls are aborted, an activation is
	 * abandoned); every child link whose principal it revokes closes (never the parent, never this host's own
	 * principal); and every route link is sent `revoke`, which the host there applies with its own `revokedBy`. Nothing
	 * is replayed to links made later.
	 */
	// 同步执行：先结束被撤销 principal 的本地远程对象与未绑定请求，再通知路由链接、关闭子链接。
	revoke(revocation: R, context: Context): void;
	/**
	 * The references to objects of `Type` on this host (§19), one entry per reference: the object's params, the
	 * principal it acts as (remote types) and its origin, the incarnation of the host it was made for (two tabs are two
	 * origins). Changes in the batch where a reference binds or ends; a link drop is a departure.
	 */
	// 首次调用时创建并缓存该类型的列表，并把已有 holder 补录进去；之后由对象 hold/unhold 增量维护。
	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, P>[]>;
	/**
	 * The work keeping this host busy, for the app's supervisor: holds arriving over links and served here, method
	 * calls running, running jobs and lingering objects; published at most once per microtask turn with changes.
	 */
	// 只读 watchable；计数由各层通过 host.count 更新，宿主关闭后归零。
	readonly activity: Watchable<ActivityCounts>;
	/**
	 * Registry `R`'s composed value as `R`'s version sees it, for code outside objects, once it is usable: waits while it
	 * has no value (`unavailable/undeclared` without a provider, a first `compose` that threw, a version not served
	 * here: `contract_mismatch`) until its `readyTimeout`, then rejects with the last error; before `load` it rejects
	 * `not_ready` at once.
	 */
	// 注册表值可用后再返回；不可用（无提供者/首次 compose 抛错/版本不匹配）时等待到 readyTimeout。
	registry<C, V>(R: Registry<C, V>, context: Context, options?: GetOptions): Promise<RegistryValue<V>>;
	/**
	 * Runs `fn` with a call context for code outside objects (a Durable tool, a CLI): the host's principal (or
	 * `options.principal`; an explicit `undefined` runs anonymous), this host's incarnation, `context`'s telemetry and signal, `ctx.get`. When `fn` settles or
	 * `context` aborts, the context is sealed: its signal aborted, `ctx.get` refused `released`, every reference it took
	 * released; an abort rejects at once. `host.close` seals the open ones; after it, `root` rejects `released`.
	 */
	// 为对象之外的代码提供 ctx。fn 结束后其取的引用全部释放；显式 principal: undefined 表示匿名。
	root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options?: RootOptions<P>): Promise<T>;
	/**
	 * Closes its links, seals its root scopes, then ends every object at once, then drains and closes them one by one,
	 * the last to go live first (reason `close`). Rejects with an `AggregateError` of the closes that threw.
	 */
	// 幂等：多次调用返回同一个 Promise。即使某些 close 抛错，宿主状态仍已完成清理。
	close(context: Context): Promise<void>;
}

/** A plugin left out at `load`, or whose new code failed at a reload (it kept its old code, if it had any), and why. */
// 失败插件记录：error 是 setup/声明/闭包规则产生的原始错误，应用通常记录而不终止宿主。
export type PluginFailure = { readonly plugin: string; readonly error: unknown };

/**
 * What a reload's commit applied, by plugin name: the `details.committed` of the `aborted` error of a reload whose
 * context aborted after its commit (the commit stands; only the wait for the report ended).
 */
// 提交结果快照：added/changed/removed 是插件名列表，failed 是“新代码失败但保留旧代码”的插件名。
// 它只描述提交已应用的内容，不包含对象 fate。
export type CommittedReload = {
	readonly added: readonly string[];
	readonly changed: readonly string[];
	readonly removed: readonly string[];
	/** The plugins whose new code failed: they kept their old code (an added one was left out). */
	readonly failed: readonly string[];
};

/** What `host.reload` takes besides the plugin set: the plugins whose new code failed before it (a build, an evaluation). */
// 调用方已知失败的插件：等同上一次 staging 失败，用于闭包规则与报告，避免重复运行其新代码。
export type ReloadOptions = { readonly failed?: readonly PluginFailure[] };

/** What `load` did (decision "Per plugin at startup and reload"): the plugins it left out. */
// 加载报告：只列出被排除的插件；成功加载的插件隐含在宿主状态中。
export type LoadReport = { readonly failed: readonly PluginFailure[] };

/**
 * What a reload did (slice 7b §1): its plugins by change (those applied), the plugins whose new code failed, and what
 * every affected object did.
 */
// 重载报告：plugins 是按变化分类的插件名；failed 是保留旧代码/被排除的插件；objects 是每个受影响对象的 fate。
// objects 与 plugins 是运行时数据，类型仅在编译期约束 kind 取值。
export type ReloadReport = {
	readonly plugins: {
		readonly added: readonly string[];
		readonly changed: readonly string[];
		readonly removed: readonly string[];
	};
	readonly failed: readonly PluginFailure[];
	/** Every live, activating, parked or failed object of a changed or removed plugin, by its label. */
	readonly objects: readonly ReloadedObject[];
};

/**
 * One object's fate in a reload: `swapped` (pure, in place), `restarted` (natives: drained, closed with reason
 * `reload`, activated again), `ended` (its type is gone), `parked` (its new code waits for a dependency, `cause`), or
 * `retried` (it was failed, parked or activating: a new attempt runs on the new code).
 */
// 单个对象的 fate，附对象标签。parked 时带 cause，说明新代码在等哪个依赖。
export type ReloadedObject = { readonly object: string } & (
	| { readonly kind: "swapped" }
	| { readonly kind: "restarted" }
	| { readonly kind: "ended" }
	| { readonly kind: "parked"; readonly cause: FailureCause }
	| { readonly kind: "retried" }
);

/**
 * What a hold placed here binds to (`serving`): its object, or why it waits unbound (`failed { waiting }`: not served,
 * another version, or placed elsewhere by the provider's code).
 */
// hold 落点结果：object 表示已绑定（新对象可能刚创建）；waiting 表示暂不能绑定，cause 供未绑定索引与引用状态使用。
export type Serving =
	| { readonly kind: "object"; readonly object: ChordObject }
	| { readonly kind: "waiting"; readonly cause: FailureCause };

/**
 * A published plugin: its facet (an unchanged reload passes the same object), what its setup staged (a reload that
 * keeps it uses it again, its setup not run) and its contributions in the registries' tables.
 */
// 已发布插件：facet 对象身份用于判断“未变化”；staged 保存 setup 产物，reload 未变时直接复用；
// contributions 便于 reload 时从注册表撤下旧贡献。
type LoadedPlugin<P extends Principal> = {
	readonly facet: Facet<P>;
	readonly staged: StagedPlugin;
	readonly contributions: readonly RegistryContribution[];
};

/**
 * What a reload staged: the staged set, the facets of the plugins it applies, the plugins by change, those that failed,
 * and each affected object's fate.
 */
// 一次 reload 的完整计划：staged 是最终代码集，facets 是本次应用的插件 facet，added/changed/removed 供报告，
// failed 是保留旧代码的插件，fates 是每个受影响对象的去留。
type ReloadPlan<P extends Principal> = {
	readonly staged: Staged;
	readonly facets: ReadonlyMap<string, Facet<P>>;
	readonly added: readonly string[];
	readonly changed: readonly string[];
	readonly removed: readonly string[];
	readonly failed: readonly PluginFailure[];
	readonly fates: readonly PlannedFate[];
};

/** One staging pass of a reload: its plan, or the plugins it found failing (staging runs again without their new code). */
// 单次 staging 的两种结果：成功时带计划与记录的工厂声明（供闭包规则检查）；失败时带插件名到错误的映射。
type StagingPass<P extends Principal> =
	| { readonly kind: "staged"; readonly plan: ReloadPlan<P>; readonly recorded: readonly RecordedFactory[] }
	| { readonly kind: "failed"; readonly failed: ReadonlyMap<string, unknown> };

/** A recorded new factory of an object staging planned a fate for: whose new code it is, and what it declared. */
// 记录的新工厂：plugin 用于把失败归因到提供者；recorded 含该工厂声明的请求与表/native 信息。
type RecordedFactory = { readonly plugin: string; readonly recorded: Recorded };

/** An affected object's fate, as staging decided it. */
// 计划中的 fate：end 或三种 reload fate；served 是新代码的服务类型，提交后替换对象旧 served。
type PlannedFate =
	| { readonly kind: "end"; readonly object: ChordObject }
	| { readonly kind: ReloadFate; readonly object: ChordObject; readonly served: Served };

/** A fate started by a reload's commit, for its report: a swap's or retry's new attempt is checked first. */
// 已启动的 fate：report 阶段只对 swapped/restarted/retried 等待第一个依赖检查结果；ended 无需等待。
type StartedFate =
	| { readonly object: string; readonly kind: "ended" }
	| { readonly object: string; readonly kind: "swapped" | "restarted" | "retried"; readonly attempt: Attempt };

/** Creates a host. */
// 应用入口。返回的对象同时实现 Host 与 ChordHost（后者供 Chord 内部层使用）。
// 例：const host = createHost({ onError, principal: { id: "app" } });
export function createHost<P extends Principal = Principal, R extends JsonValue = JsonValue>(
	options: HostOptions<P, R>,
): Host<P, R> {
	return new ChordHost<P, R>(options);
}

/** No activation chain (Q5). */
// 共享空链：普通 get 创建对象时没有跨宿主依赖链。
const NO_CHAIN: readonly string[] = [];

/** The params of a type with empty params, as checked: nothing, and the empty key. */
// 空参数类型的已检查参数；host-lifetime 对象用它创建，identity 键为空串。
const EMPTY_PARAMS: CheckedParams = { params: {}, key: "" };

/** The host: its served types, its objects by identity, its batch, backoff and endings. */
// ChordHost 是唯一实现。字段很多，按用途分组：配置/身份、批处理与活动、类型与插件、对象/链接/路由、注册表与根作用域、状态机。
// 所有字段在构造时初始化；#state 控制 load/reload/close 的合法调用顺序。
export class ChordHost<P extends Principal = Principal, R extends JsonValue = JsonValue> implements Host<P, R> {
	// 批处理与超时：所有可观察状态修改都经 batch；backoff 按 identity 管理失败重试窗口。
	readonly batch: Batch;
	readonly timeouts: { readonly close: number; readonly ready: number };
	readonly backoff = new Backoff((identity) => this.#due(identity));
	readonly address: Address | undefined;
	readonly principal: P | undefined;
	/** This run of the host, sent in every handshake (R20). */
	// uuidv7 兼具时间有序与唯一性；引用与 presence 用它区分不同宿主运行。
	readonly incarnation = uuidv7();
	readonly compression: Compression | undefined;
	/** The host's store, if it has one. */
	readonly store: ChordStore | undefined;
	// 活动计数与 principal 键函数/撤销键缓存；撤销缓存避免每次 revoke 重新规范化。
	readonly #activity: Activity;
	readonly #principalKey: PrincipalKeyFunction<P> | undefined;
	readonly #revocationKeys: RevocationKeys;
	/** The presence list of each type someone asked about (`references`), by type name. */
	// 按类型名惰性创建；首次 references(Type) 时补录现有 holder。
	readonly #references = new Map<string, References>();
	readonly #onError: (error: HostError) => void;
	/** The served types by name: the published plugin set's (a reload's commit replaces it). */
	// 当前发布的服务类型表；reload 提交时整体替换为 staged.types。
	#types = new Map<string, Served>();
	/** The published plugins by name: their facet (an unchanged one is the same object), registries and contributions. */
	// 按插件名保存 facet/暂存产物/贡献；reload 判断 unchanged 用 facet 对象身份。
	readonly #plugins = new Map<string, LoadedPlugin<P>>();
	/** The reloads, one after another (slice 7b §1): the last one's end, which the next one waits for. */
	// reload 串行链：每次把新 Promise 接到链尾，链本身吞掉错误以免拒绝泄漏。
	#reloading: Promise<void> = Promise.resolve();
	/** By identity, in the order they went live (the others where they were created). */
	// 对象表：Map 保持插入顺序；wentLive 时移到末尾，使关闭按“最后 live 的最先结束”的逆序进行。
	readonly #objects = new Map<string, ChordObject>();
	/** Teardowns still running, by identity: the next instance of an identity waits for its previous ones. */
	// 同一 identity 的清理链；新实例激活前等待它，避免旧清理操作新实例的共享文档。
	readonly #endings = new Map<string, Promise<void>>();
	/** The requests waiting unbound after the publication (in the index, and registry readers), reported after 5 s. */
	// UnboundClock 为未绑定请求计时，超时产生 unbound_long/parked_long 诊断，但不会使请求失败。
	readonly #clock = new UnboundClock((error) => this.report(error));
	/** The requests that cannot bind yet, by name: before the publication all of them, then those left unbound. */
	// 未绑定索引：按类型/注册表名等待发布或提供者；发布后 wake 对应名字。
	readonly #unbound = new UnboundIndex(this.#clock);
	/** Resolved at the host's first publication (`load`'s batch), or its close. */
	// 发布门：load 提交批次后 resolve；close 也会 resolve，避免等待者永久挂起。
	readonly #publication = Promise.withResolvers<void>();
	#published = false;
	/** Every open link: children, routes and the parent. */
	readonly #links = new Set<HostLink>();
	/** Where holds go that are not served here and not routed: the parent link, across reconnects. */
	// Path 是“上游持有集合”：父链接断开重连后，Path 会重新 hold 其上的引用。
	readonly #parent = new Path(() => {});
	/**
	 * Remote references failed for a part past a link's limits: on no link's path (no reconnect holds them, no route
	 * resolves for them) until `ref.retry()` places them anew; ended at `close` like the others.
	 */
	readonly unplaced = new Path(() => {});
	readonly #routes = new Map<string, Route>();
	// Destination 把 (Type, params) 映射到本机对象、路由路径或父路径；所有 get/hold 最终都经过它。
	readonly #destination: Destination;
	/** The downstream origins this host relays holds for, by their number on upstream links (never reused). */
	// 中继来源编号：本机为下游链接转发 hold 时，上游用编号区分来源；编号不复用。
	readonly relays = new Map<number, ProviderSide>();
	#nextOrigin = 1;
	/** Aborted when the host closes: the context of every route's `resolve`, and the end of waiting `host.registry`s. */
	// 路由工作上下文；关闭时 abort，取消所有 resolve 与注册表等待。
	readonly #routing = new AbortController();
	readonly #heartbeat: { readonly ping: number; readonly close: number };
	/** Its registries by name, each made by its first use (a serve, a contribution or a reader). */
	readonly #registries = new Map<string, RegistryRecord>();
	readonly #roots = new RootScopes(this);
	/** The one heartbeat timer, running while the host has a link. */
	// 所有链接共享一个 setInterval；没有链接时清除。
	#ticking: ReturnType<typeof setInterval> | undefined;
	// 宿主状态机：new → loading → loaded → closed；非法顺序在方法入口被拒绝。
	#state: "new" | "loading" | "loaded" | "closed" = "new";
	/** The one closing, which every `close` returns. */
	// 幂等关闭：首次 close 创建 Promise，后续调用复用。
	#closing: Promise<void> | undefined;

	// 构造只保存配置、创建 Batch/Activity/RevocationKeys/Destination，并把 store 附加到 batch；
	// 不加载插件、不创建对象、不启动计时器。
	constructor(options: HostOptions<P>) {
		this.address = options.address;
		this.principal = options.principal;
		this.#principalKey = options.principalKey;
		this.#onError = options.onError;
		// Batch 的回调是 report：批次/监听器中的后台错误统一走 onError；telemetry 只传 metrics。
		this.batch = new Batch((error) => this.report(error), options.telemetry?.metrics);
		this.compression = options.compression;
		this.#activity = new Activity(this.batch);
		// `revokedBy` is called with this host's principals only, the `P`s its links stamp.
		// 断言把应用类型 R/P 收窄为内部通用类型；这是配置边界上的强制转换，运行时仍调用应用函数。
		this.#revocationKeys = new RevocationKeys(options.revokedBy as RevokedBy<Principal, JsonValue> | undefined);
		this.timeouts = { close: options.closeTimeout ?? 30_000, ready: options.readyTimeout ?? 60_000 };
		this.#heartbeat = { ping: options.heartbeat?.ping ?? 15_000, close: options.heartbeat?.close ?? 30_000 };
		this.#destination = new Destination(this.address, this.#routes, this.#parent);
		// Chord's own: `openStore` made it.
		// store 成功打开时带 claims/批处理能力；store?.attach 注册失败回调，失败时宿主自行关闭。
		this.store = options.store as ChordStore | undefined;
		this.store?.attach({ failed: (error) => this.#storageFailed(error), batch: this.batch });
	}

	// load 是启动屏障：先 staging 所有插件并发布声明，再放置等待中的 hold，最后激活宿主生命周期对象并等待首次结局。
	// 输入 facet 列表与上下文；输出失败插件报告。错误：重复 load、非法插件名同步抛；单个插件失败只进 failed。
	// 例：await host.load([facet], ctx) 后，serve 的空参数对象已 live 或已有首次结局。
	async load(facets: readonly PluginFacet<P>[], context: Context): Promise<LoadReport> {
		// load 不能在批次内调用（setup 可能同步触发观察者）。
		this.batch.assertOutside("load");
		this.#assertOpen();
		// 只允许一次；loading/loaded/closed 都拒绝。
		if (this.#state !== "new") throw new Error("load runs once per host");
		// npm 名称检查在任何状态改变前完成。
		checkPluginNames(facets);
		this.#state = "loading";
		const staged = emptyStaged();
		const loaded = new Map<string, Facet<P>>();
		const failed: PluginFailure[] = [];
		// A name given twice is refused the second time whether or not the first staged.
		const given = new Set<string>();
		// In the given order: of two plugins serving one name, the later is left out.
		for (const plugin of facets) {
			const twice = given.has(plugin.name);
			given.add(plugin.name);
			// stageInto 捕获 setup/声明错误并返回；成功则记录 facet。
			const error = twice ? loadedTwice(plugin.name) : this.#stageInto(staged, plugin);
			if (error === undefined) loaded.set(plugin.name, plugin.facet);
			else failed.push({ plugin: plugin.name, error });
		}
		this.#types = staged.types;
		// The publication: the types and registries served, the facets' contributions and the first composition of
		// every served registry, in one batch, before any object activates.
		this.batch.commit(() => {
			this.#publish(staged, loaded);
			for (const record of this.#registries.values()) record.composeServed();
		}, context);
		// After the batch: what waited for the publication is placed (the gate lasted only for the setups).
		this.#published = true;
		this.#publication.resolve();
		this.#reportUndeclared();
		// 唤醒所有因“等待发布”而索引的请求；随后创建宿主生命周期对象。
		this.#unbound.wakeAll();
		const objects = [...this.#types.values()]
			.filter((served) => served.kind === "local" && served.hostLifetime)
			.map((served) => this.#object(served, EMPTY_PARAMS, undefined, context));
		// 启动屏障：等待每个空参数本地对象的首次结局（live/failed/parked/ended 都算），不等待其重试成功。
		await Promise.all(objects.map(({ firstOutcome }) => firstOutcome));
		if (this.#state === "loading") this.#state = "loaded";
		return { failed };
	}

	/**
	 * Whether a request for `Type` with `params` binds to `served` as a real bind checks it (`bind`): its kind, version
	 * and fingerprint, and the provider's own host address; one whose `hostAddress` throws does not.
	 */
	// 闭包规则用这个“只检查不创建对象”的预演；hostAddress 抛错视为不在此处（真正 bind 时才会失败）。
	#wouldBind(served: Served, Type: Contract, params: ParamsOf<Contract>): boolean {
		if (unboundCause(served, Type.kind, Type.name, Type.version, Type.fingerprint) !== undefined) return false;
		try {
			return this.#misplaced(Type, served, params) === undefined;
		} catch {
			return false;
		}
	}

	/** Whether a request for `Type` with `params` goes here; a `hostAddress` that throws: not here (it fails at bind). */
	// 判断放置位置，不创建路径或对象；异常被吞掉，因为 staging 阶段不应因代码抛错中止整个 reload。
	#placedHere(Type: Contract, params: ParamsOf<Contract>): boolean {
		try {
			return this.#destination.placedHere(Type, params);
		} catch {
			return false;
		}
	}

	/** Stages `plugin`'s new code into `staged`: the error that refuses it (its setup, a declaration, a name served twice). */
	// 返回值约定：undefined 表示成功；否则返回原始错误。用错误作为返回值而不是抛出，方便调用方按插件收集。
	#stageInto(staged: Staged, plugin: PluginFacet<P>): unknown {
		try {
			return addStaged(staged, stagePlugin(plugin, this.#stagingHost()));
		} catch (error) {
			return error;
		}
	}

	// 重载入口：校验调用时机与插件名，把本次重载接到串行链尾，保证多个 reload 顺序执行。
	// 返回逐对象 fate 报告；提交后 context 取消会得到带 committed 详情的 aborted。
	// 示例：const report = await host.reload([updatedFacet], context, { failed: [] });
	reload(facets: readonly PluginFacet<P>[], context: Context, options: ReloadOptions = {}): Promise<ReloadReport> {
		this.batch.assertOutside("reload");
		// 关闭后 reload 以拒绝返回（而不是同步抛），与返回 Promise 的方法签名一致。
		if (this.#state === "closed") return Promise.reject(this.#closedError());
		if (this.#state !== "loaded") throw new Error("reload runs after load");
		checkPluginNames(facets);
		// 接到串行链尾：前一次无论成功失败，后一次都继续。
		const reload = this.#reloading.then(() => this.#reload(facets, options.failed ?? [], context));
		// The tail settles to nothing: a report kept as its value would keep a rejected facet's closure (its error).
		// then 的两个回调都返回 undefined，避免把结果/错误值继续保存在链上。
		this.#reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}

	/** One reload, after the previous one: staging, the commit, the fates, the report. */
	// 阶段顺序固定：检查取消 → staging（可能同步 abort）→ commit → 启动各对象 fate → 等依赖检查后报告。
	async #reload(
		facets: readonly PluginFacet<P>[],
		before: readonly PluginFailure[],
		context: Context,
	): Promise<ReloadReport> {
		this.#assertOpen();
		// 提交前取消：什么都没改，用 aborted（无 details）拒绝。
		if (context.abortSignal?.aborted) throw reloadAborted();
		const plan = this.#stageReload(facets, before, context);
		// Aborted while it staged (a setup may abort it synchronously): nothing changed.
		if (context.abortSignal?.aborted) throw reloadAborted();
		const started = this.#commit(plan, context);
		const { added, changed, removed, failed } = plan;
		const plugins = { added, changed, removed };
		const committed: CommittedReload = { ...plugins, failed: failed.map(({ plugin }) => plugin) };
		// 报告只等待 swapped/restarted/retried 的首次依赖检查；对象真正 live 不在等待范围内。
		const objects = await this.#report(started, committed, context);
		return { plugins, failed, objects };
	}

	/**
	 * Staging (slice 7b §2), synchronous (no request or arriving hold meets it half done), per plugin (decision "Per
	 * plugin at startup and reload"): a pass stages the new code (`#stagePass`); a plugin whose new code fails there
	 * (or failed `before`, passed as its loaded facet) keeps its old code (an added one is left out) and staging runs
	 * again without it; then a changed plugin whose recorded requests would not bind because of such a plugin keeps its
	 * old code too (`#closure`), until nothing more fails. Bounded by the number of plugins with new code.
	 */
	// 迭代到不动点：某轮 staging 失败或闭包规则拒绝插件，就把该插件加入 failed 并重跑；
	// 因为每轮至少淘汰一个插件，循环最多以有新区代码的插件数为界。返回计划时附加所有失败记录（含重复名）。
	#stageReload(facets: readonly PluginFacet<P>[], before: readonly PluginFailure[], context: Context): ReloadPlan<P> {
		const failed = new Map(before.map(({ plugin, error }) => [plugin, error]));
		const given = new Map<string, Facet<P>>();
		// A name given twice: the second is refused, the first staged.
		const twice: PluginFailure[] = [];
		for (const { name, facet } of facets) {
			if (given.has(name)) twice.push({ plugin: name, error: loadedTwice(name) });
			else given.set(name, facet);
		}
		for (;;) {
			const pass = this.#stagePass(given, failed, context);
			if (pass.kind === "failed") {
				// 本轮有新插件 staging 失败：记录下来，下一轮不再运行它们的新代码。
				for (const [name, error] of pass.failed) failed.set(name, error);
				continue;
			}
			const kept = this.#closure(pass.plan, pass.recorded, failed);
			if (kept.size > 0) {
				// 闭包规则拒绝的插件保留旧代码；同样进入 failed 后重跑。
				for (const [name, error] of kept) failed.set(name, error);
				continue;
			}
			const failures = [...failed].map(([plugin, error]) => ({ plugin, error }));
			// twice 排在前面：重复名字即使未参与 staging 也要出现在报告中。
			return { ...pass.plan, failed: [...twice, ...failures] };
		}
	}

	/**
	 * One staging pass: the loaded entries of the plugins kept as they are (unchanged, or failed: their setups not run
	 * again) first, then every other plugin's new code in the given order (one refused by a name the table has already
	 * fails), then the new factory of every object of a changed or removed plugin whose type is still served (a throw
	 * fails the plugin serving it). Its plan, or the plugins that failed.
	 */
	// 单轮 staging：先复用未变/已失败插件的已发布产物，再运行其余插件的新代码，最后为受影响对象记录新工厂。
	// 返回 failed 时表示计划作废，调用方需修正 failed 集后重试。
	#stagePass(
		given: ReadonlyMap<string, Facet<P>>,
		failed: ReadonlyMap<string, unknown>,
		context: Context,
	): StagingPass<P> {
		const staged = emptyStaged();
		const failing = new Map<string, unknown>();
		const fresh: PluginFacet<P>[] = [];
		for (const [name, facet] of given) {
			const loaded = this.#plugins.get(name);
			// facet 对象身份相同（未变化）或该插件已失败：直接复用旧 staged，不运行 setup。
			if (loaded !== undefined && (loaded.facet === facet || failed.has(name))) addStaged(staged, loaded.staged);
			else if (!failed.has(name)) fresh.push({ name, facet });
		}
		for (const plugin of fresh) {
			const error = this.#stageInto(staged, plugin);
			if (error !== undefined) failing.set(plugin.name, error);
		}
		if (failing.size > 0) return { kind: "failed", failed: failing };
		// applied 是本次运行新代码的插件；removed 是已发布但不在新集合中的插件。两者共同决定受影响对象。
		const applied = new Set(fresh.map(({ name }) => name));
		const removed = [...this.#plugins.keys()].filter((name) => !given.has(name));
		const reloaded = new Set([...applied, ...removed]);
		const fates: PlannedFate[] = [];
		const recorded: RecordedFactory[] = [];
		for (const object of this.#objects.values()) {
			if (!reloaded.has(object.served.plugin)) continue;
			const served = staged.types.get(object.served.contract.name);
			// 类型消失或 kind 改变：对象结束。
			if (served === undefined || served.kind !== object.served.kind) {
				fates.push({ kind: "end", object });
				continue;
			}
			try {
				// recordFactory 用 recording self 运行新工厂，收集其请求与声明；失败归因到服务该类型的插件。
				const declared = recordFactory(object, served, context);
				recorded.push({ plugin: served.plugin, recorded: declared });
				fates.push({ kind: object.reloadFate(declared), object, served });
			} catch (error) {
				if (!failing.has(served.plugin)) failing.set(served.plugin, error);
			}
		}
		if (failing.size > 0) return { kind: "failed", failed: failing };
		const facets = new Map(fresh.map(({ name, facet }) => [name, facet]));
		const added = fresh.filter(({ name }) => !this.#plugins.has(name)).map(({ name }) => name);
		const changed = fresh.filter(({ name }) => this.#plugins.has(name)).map(({ name }) => name);
		const plan = { staged, facets, added, changed, removed, failed: [], fates };
		return { kind: "staged", plan, recorded };
	}

	/**
	 * The closure rule: the changed plugins (new code applied) of `plan` with a recorded request that would not bind in
	 * the staged table because of a plugin that failed in this reload: its name served there by such a plugin's old code,
	 * or not served at all while some plugin failed (what a failed setup would have served is unknown). Requests to
	 * another host are not checked (a rollout's rules). Each such plugin with the error it keeps its old code for.
	 */
	// 闭包规则：新工厂记录的请求若依赖失败的插件（或该名字现在无人服务），应用新代码会破坏闭包，
	// 因此该插件也保留旧代码。只有本次 changed 的插件会被检查。
	#closure(
		plan: ReloadPlan<P>,
		recorded: readonly RecordedFactory[],
		failed: ReadonlyMap<string, unknown>,
	): Map<string, unknown> {
		const kept = new Map<string, unknown>();
		if (failed.size === 0) return kept;
		for (const { plugin, recorded: declared } of recorded) {
			if (kept.has(plugin) || !plan.facets.has(plugin)) continue;
			for (const request of declared.requests) {
				const unbound = this.#unboundRequest(plan.staged, request, failed);
				if (unbound === undefined) continue;
				kept.set(plugin, new Error(`plugin "${plugin}": ${unbound}`));
				break;
			}
		}
		return kept;
	}

	/**
	 * Why `request` (of a new factory) would not bind in `staged` because of a plugin in `failed`; `undefined`
	 * when it binds, is placed on another host, or does not bind for another reason (it waits as any request does).
	 */
	// 返回人类可读的原因字符串（会拼进 plugin 错误消息），undefined 表示无问题。
	// 类型请求和注册表请求分开检查；远程且放在别处的类型不检查。
	#unboundRequest(staged: Staged, request: Request, failed: ReadonlyMap<string, unknown>): string | undefined {
		const name = request.kind === "type" ? request.contract.name : request.registry.name;
		const provider = request.kind === "type" ? staged.types.get(name)?.plugin : staged.registries.get(name)?.plugin;
		// 提供者存在且未失败：绑定没问题。
		if (provider !== undefined && !failed.has(provider)) return undefined;
		if (request.kind === "type") {
			const { contract, params } = request;
			// A remote type the object reaches on another host: placed by the rollout's rules, not this host's.
			if (!this.#placedHere(contract, params)) return undefined;
			const served = staged.types.get(name);
			// 提供者存在且版本可绑：没问题（即使 provider 失败也会走到这里？provider 失败时 served 来自旧代码，wouldBind 为 true 则放行）。
			if (served !== undefined && this.#wouldBind(served, contract, params)) return undefined;
			return provider === undefined
				? `needs ${name} v${contract.version}, which no plugin serves now (a plugin failed)`
				: `needs ${name} v${contract.version}, which plugin "${provider}" serves on its old code`;
		}
		const served = staged.registries.get(name);
		// registryServes 还考虑 accepts 映射的回旧版本。
		if (served !== undefined && registryServes(served, request.registry.version)) return undefined;
		return provider === undefined
			? `needs registry ${name} v${request.registry.version}, which no plugin serves now (a plugin failed)`
			: `needs registry ${name} v${request.registry.version}, which plugin "${provider}" serves on its old code`;
	}

	/**
	 * The commit (slice 7b §3), one batch: the served types become the staged ones (an unchanged plugin's stay as
	 * they were), the removed plugins' registry providers go and the reloaded ones' are replaced, their facet
	 * contributions replaced by plugin, every changed registry composed once; a removed type's presence list goes.
	 * Then each object takes its fate, host-lifetime objects of new types start, and the publication wakes the
	 * requests waiting for the names the reload serves.
	 */
	// 提交在单个批次内完成：先撤下 changed/removed 插件的注册表提供与贡献，再替换类型表并发布新插件。
	// 批次结束后：清理已移除类型的 presence 列表，启动 fates 与新宿主生命周期对象，最后唤醒等待这些名字的请求。
	#commit(plan: ReloadPlan<P>, context: Context): readonly StartedFate[] {
		const { staged, changed, removed } = plan;
		const published = new Set(plan.facets.keys());
		// A kept plugin's types are its loaded ones, as they are: its objects are untouched.
		const types = staged.types;
		this.batch.commit(() => {
			for (const name of [...changed, ...removed]) {
				const loaded = this.#plugins.get(name)!;
				// 若该注册表不再由本插件提供，撤下 provider；其他插件接管的则保留。
				for (const registry of loaded.staged.registries.keys()) {
					if (staged.registries.get(registry)?.plugin !== name) this.registryRecord(registry).unserve();
				}
				for (const contribution of loaded.contributions) contribution.record.remove(contribution);
				this.#plugins.delete(name);
			}
			this.#types = types;
			this.#publish(staged, plan.facets);
			// 每个受发布插件的注册表重新组合一次，读者在同一批次看到新组合。
			for (const name of published) {
				for (const registry of staged.plugins.get(name)!.registries.keys()) {
					this.registryRecord(registry).composeServed();
				}
			}
		}, context);
		this.#reportUndeclared();
		// 已移除类型的 presence 列表不再有对象；删除缓存，后续 references 会重新创建。
		for (const name of this.#references.keys()) if (!types.has(name)) this.#references.delete(name);
		const names = new Set<string>();
		for (const [name, served] of types) if (published.has(served.plugin)) names.add(name);
		for (const [name, { plugin }] of staged.registries) if (published.has(plugin)) names.add(name);
		const started = plan.fates.map((fate) => this.#startFate(fate));
		// 新类型里的宿主生命周期对象也要在提交后启动。
		for (const type of types.values()) {
			if (type.kind === "local" && type.hostLifetime) this.#object(type, EMPTY_PARAMS, undefined, context);
		}
		this.#unbound.wake(names);
		return started;
	}

	/**
	 * Starts one object's fate after the commit (slice 7b §4): a removed type's object ends, its holders waiting
	 * `not_served`; any other swaps, restarts or retries on its new served type.
	 */
	// end：结束对象，其 holders 以 not_served 等待；其余 fate 生成新 attempt，STARTED 映射成报告用字符串。
	#startFate(fate: PlannedFate): StartedFate {
		const { object } = fate;
		if (fate.kind === "end") {
			const error = new ChordError({
				code: "unavailable",
				message: `${object.served.contract.name} is not served here`,
			});
			object.remove({ kind: "waiting", error });
			return { object: object.label, kind: "ended" };
		}
		const attempt = object.reload(fate.served, fate.kind);
		return { object: object.label, kind: STARTED[fate.kind], attempt };
	}

	/**
	 * The report, once every swap and retry had its first dependency check (a parked one reports why); restarts are
	 * reported at once (their check follows the drain). `context`'s abort ends only this wait (`aborted`, its `details`
	 * naming what the commit applied: `committed`).
	 */
	// 对每个已启动 fate：ended/restarted 立即报告；swapped/retried 等待 attempt.checked（首次依赖检查）。
	// 若等待期间 context 取消，抛出带 committed 详情的 aborted，表明提交已生效。
	async #report(
		started: readonly StartedFate[],
		committed: CommittedReload,
		context: Context,
	): Promise<ReloadedObject[]> {
		const checks = started.map(async (fate): Promise<ReloadedObject> => {
			if (fate.kind === "ended" || fate.kind === "restarted") return { object: fate.object, kind: fate.kind };
			const cause = await fate.attempt.checked;
			return cause === undefined
				? { object: fate.object, kind: fate.kind }
				: { object: fate.object, kind: "parked", cause };
		});
		try {
			return await awaitWithContext(Promise.all(checks), context);
		} catch {
			const { added, changed, removed, failed } = committed;
			const details = {
				committed: { added: [...added], changed: [...changed], removed: [...removed], failed: [...failed] },
			};
			throw new ChordError({ code: "aborted", message: "reload: aborted after its commit", details });
		}
	}

	/** This host as staging sees it: whom it acts as, its address and its presence lists. */
	// 只暴露 staging 需要的三个能力；references 的 P 类型在边界处断言，因为 staging 不关心具体 principal 类型。
	#stagingHost(): StagingHost {
		// Setups get presence lists of this host's `P`; staging passes them on as they are.
		const references = (Type: Contract) => this.references(Type);
		return { principal: this.principal, address: this.address, references: references as StagingHost["references"] };
	}

	/**
	 * A reference to `Type` with `params`, waiting until it binds unless `readyTimeout` (the host's by default) runs
	 * out: then `unavailable/not_live`. The reference follows the object's instance across attempts.
	 */
	// 获取一个引用：先经 acquire 走绑定/等待/放置，再返回绑定上的引用对象。
	// 返回的 Reference 会随实例重载/替换继续跟随；失败时抛 unavailable（超时）或插件/契约错误。
	// 示例：const counter = await host.get(Counter, { name: "a" }, context);
	async get<C extends Contract>(
		Type: C,
		params: ParamsOf<C>,
		context: Context,
		options: GetOptions = {},
	): Promise<Reference<C>> {
		// own() 表示调用者是本宿主自身（不是通过链接代表别的 principal）。
		const binding = await this.acquire(Type, params, this.#own(), context, options);
		// The binding was built from `Type`'s members.
		// 绑定在建立时已按契约成员构建；这里只是把宽类型收窄回 Reference<C>。
		return binding.reference as Reference<C>;
	}

	/**
	 * A reference to `Type` with `params` that does not wait: it binds as soon as it can, and its calls park until then.
	 * Must be called outside a batch (it publishes the hold at once).
	 */
	// 同步登记一个 hold：不等待绑定，返回的 Held 一开始可能无 variant，调用会排队直到绑定。
	// 与 get 的差别：get 等待就绪，hold 立即返回并由后续发布/链接唤醒。
	// 示例：const held = host.hold(Counter, { name: "a" }, context);
	hold<C extends Contract>(Type: C, params: ParamsOf<C>, context: Context, options: GetOptions = {}): Held<C> {
		// 批量更新期间不允许，避免在声明批次里插入等待请求。
		this.batch.assertOutside("hold");
		// The binding was built from `Type`'s members; it may be unbound, so `variant` may be undefined.
		return this.#hold(Type, params, this.#own(), context, options).reference as Held<C>;
	}

	/** Accepts a child host's link: its holds on types this host serves come here (`accept` makes no parent). */
	// 接受子宿主连入：远端 hold 通过该链接路由到本宿主。不接受重载/关闭期间调用。
	accept(link: Link, options: LinkOptions<P>, context: Context): void {
		this.#assertOpen();
		// 角色 child 表示这是别人连到本宿主的链路。
		this.#link(link, "child", options, context);
	}

	/** Connects this host to its one parent (`connect` again before the link closes throws). */
	// 连接到父宿主：本宿主未绑定或远程的 hold 会转发到父宿主。
	// 同一时间只允许一条未关闭的父链路，重复连接抛错；链路同步打开时立即标记已连接。
	connect(link: Link, options: LinkOptions<P>, context: Context): void {
		this.#assertOpen();
		// #parent.link 非空表示已有未关闭的父链路。
		if (this.#parent.link !== undefined) throw new Error("connect: this host has an open parent link");
		const parent = this.#link(link, "parent", options, context);
		// open 指链路握手已完成（不是仅登记）；之后才把父链路挂到连接状态上。
		if (parent.open) this.#parent.connected(parent);
	}

	/**
	 * Declares the route for a host kind (`route` after `load` or a second route for the kind throws): work arriving over
	 * a route link is resolved by `options.resolve` under `options.authorize`'s principals.
	 */
	// 为一个 host kind 注册路由：决定入站请求如何解析、代表哪个 principal、以及在哪里放置对象。
	// 必须在 load 之前声明且每个 kind 只能一次；返回 retry/suspend 句柄用于控制该地址。
	// 示例：const route = host.route(gatewayKind, { authorize, resolve }, context);
	route<N extends string, Q extends Params>(
		Kind: HostKind<N, Q>,
		options: RouteOptions<P, HostKind<N, Q>>,
		context: Context,
	): RouteHandle<HostKind<N, Q>> {
		this.#assertOpen();
		// 路由属于启动配置，load 之后不能再改。
		if (this.#state !== "new") throw new Error("route: routes are declared before load");
		if (this.#routes.has(Kind.kind)) throw new Error(`route: ${Kind.kind} is routed already`);
		// The parent of the route's work: its `resolve`s and the holds and calls on its links, aborted when it closes.
		// 路由工作继承 #routing 信号的取消；withAbortSignal 组合外部 context 与宿主的关闭信号。
		const routing = withAbortSignal(this.#routing.signal, context);
		// A route calls `authorize` with the principals of holds on this host, `P`s, and addresses of `Kind`.
		// 这里的 as unknown as 是必要的边界转换：Route 内部以宽类型 Principal/HostKind 工作，
		// 而公开签名需要保住调用者传入的具体 N/Q。类型断言不做运行时校验。
		const route = new Route(
			Kind as unknown as HostKind,
			options as unknown as RouteOptions<Principal, HostKind>,
			this,
			routing,
		);
		this.#routes.set(Kind.kind, route);
		// 返回的句柄只暴露按 address.key 控制的两个操作，不泄漏 Route 内部状态。
		return {
			retry: (address) => route.retry(address.key),
			suspend: (address) => route.suspend(address.key),
		};
	}

	/**
	 * Revokes a revocation (`canonicalJson` of it): objects and unbound requests of its principals end `forbidden/
	 * revoked`, the revocation goes down route links, and child links of its principals close.
	 */
	// 撤销：把撤销凭据规范化成 key，结束所有匹配 principal 的对象、未绑定请求、路径上的 hold，
	// 然后沿 route 链接下发撤销，最后关闭相关 principal 的 child 链接。
	// 本宿主自身的 principal 不受撤销影响（#isOwn）。
	revoke(revocation: R, context: Context): void {
		// 规范化后的 JSON 才是可比较的撤销键；context 参与序列化中的错误处理。
		const key = canonicalJson(revocation, context);
		// 判定函数：不是本宿主身份，且登记在撤销表里。
		const revoked = (principal: Principal): boolean =>
			!this.#isOwn(principal, context) && this.#revocationKeys.revokes(principal, key, context);
		const error = (label: string): ChordError =>
			new ChordError({ code: "forbidden", reason: "revoked", message: `${label}: revoked` });
		// 先结束已存在对象；复制 values() 避免结束过程中修改 Map。
		for (const object of [...this.#objects.values()]) {
			if (object.principal !== undefined && revoked(object.principal)) object.end(error(object.label));
		}
		// Requests not bound (waiting for the publication or a provider, refused, waiting for their link) end too: nothing
		// revives them.
		// 未绑定索引里的等待者同样结束，避免撤销后又因新发布而复活。
		const unbound = error("an unbound request");
		this.#unbound.revoke(revoked, unbound);
		for (const link of this.#links) link.revokeUnbound(revoked, unbound);
		// This host's own requests over its paths, linked or not (a route still resolving, a link down): a later link
		// would hold them again (fix round 1).
		// 本宿主路径上的 remote holder 也要结束：它们可能稍后通过新链路再次 hold。
		for (const holder of this.#pathHolders()) {
			if (holder.kind !== "remote") continue;
			const { principal } = holder.caller;
			if (principal !== undefined && revoked(principal)) holder.revoke(error(holder.label));
		}
		// Down the route links before the child links close: a worker ends the principal's objects with the revocation's
		// error before the closed origins release their holds.
		// 先下发撤销消息（让下游先以 revoked 结束对象），再关闭 child 链路，保证关闭原因正确。
		for (const link of this.#links) if (link.role === "route") link.send({ kind: "revoke", revocation });
		for (const link of [...this.#links]) if (link.role === "child" && revoked(link.principal)) link.close();
	}

	/** The host's activity counts (runs, holds, requests: an internal view). */
	// 活动计数是可观察值；内部以更具体的类型保存，这里只暴露只读的 Watchable 视图。
	get activity(): Watchable<ActivityCounts> {
		// Its value is an `ActivityCounts`.
		return this.#activity as unknown as Watchable<ActivityCounts>;
	}

	/**
	 * The live instances of `Type` here with their principals (`{ params, principal, incarnation }` entries), as one
	 * watchable: added when an instance goes live, removed when it ends.
	 */
	// 某类型的 presence 列表：首次访问时创建缓存，并把已存在的对象按 holder 补录进去。
	// 之后对象上线/结束会产生 splice 操作，读者在同一批次看到一致快照。
	references<C extends Contract>(Type: C): Watchable<readonly Presence<C, P>[]> {
		let references = this.#references.get(Type.name);
		if (references === undefined) {
			references = new References(this.batch);
			// 补录已有对象：只按契约名匹配；holder 携带 principal 与各实例的键。
			for (const object of this.#objects.values()) {
				if (object.served.contract.name !== Type.name) continue;
				for (const holder of object.holders) references.record(object, holder);
			}
			this.#references.set(Type.name, references);
		}
		// Entries of `Type`'s objects, acting as `P`s.
		return references as unknown as Watchable<readonly Presence<C, P>[]>;
	}

	/**
	 * The composition of registry `R` at its version, waiting for the publication and until every contribution has a
	 * value (a composition not yet usable keeps waiting up to `readyTimeout`, then `unavailable/not_live`).
	 */
	// 读取注册表组合值：等待 load 发布完成，再等到该版本组合可用（有值或已有 last 值）。
	// 超时、宿主关闭、context 取消都会中止等待；finally 清理定时器与监听器。
	// 示例：const routes = await host.registry(RouteRegistry, context, { readyTimeout: 1000 });
	async registry<C, V>(R: Registry<C, V>, context: Context, options: GetOptions = {}): Promise<RegistryValue<V>> {
		this.batch.assertOutside("registry");
		this.#assertOpen();
		// 注册表必须在 load 之后读取：发布前组合尚不存在。
		this.#assertLoadCalled(`registry ${R.name}`);
		const timeout = options.readyTimeout ?? this.timeouts.ready;
		const expired = new AbortController();
		// withLinkedAbortSignal 把外部 context 与内部超时信号组合，任一取消都结束等待。
		const waiting = withLinkedAbortSignal(expired.signal, context);
		let last: unknown;
		// 超时时用最近一次不可用原因构造错误；last 尚未赋值时用 notLive 的通用说明。
		const deadline = setTimeout(() => expired.abort(last ?? notLive(`registry ${R.name}`, timeout)), timeout);
		// The host's close ends the wait at once, `released/closed` (its timer with it).
		// 宿主关闭也要立即中止等待；监听器一次性，finally 中移除。
		const closing = (): void => expired.abort(this.#closedError());
		this.#routing.signal.addEventListener("abort", closing, { once: true });
		try {
			await awaitWithContext(this.#publication.promise, waiting.context);
			// 发布可能因关闭而提前结束，醒来后再确认宿主仍打开。
			this.#assertOpen();
			const value = this.registryRecord(R.name).value(R.version);
			// Its values are the composition as `R`'s version has it, `V`.
			// usable 检查组合是否已就绪：有实际 value 或曾有 last 值即可读。
			const usable = (): boolean => {
				const start = value.start();
				if (start.kind === "value" || start.last !== undefined) return true;
				last = start.error;
				return false;
			};
			if (!usable()) await untilUsable(value, usable, waiting.context);
			return value as RegistryValue<V>;
		} finally {
			clearTimeout(deadline);
			this.#routing.signal.removeEventListener("abort", closing);
			waiting.release();
		}
	}

	/** Runs `fn` as a root: its ctx acts as `principal` (omitted: the host's; explicit `undefined`: anonymous). */
	// 以某个 principal 的身份运行一段根作用域代码：fn 内发起的 get/hold 都代表该 principal。
	// options 中显式 principal: undefined 表示匿名；键缺省才继承宿主 principal。
	// 示例：await host.root(async (ctx) => ctx.get(Counter, { name: "a" }), context, { principal: user });
	async root<T>(fn: (ctx: Ctx<P>) => Promise<T>, context: Context, options: RootOptions<P> = {}): Promise<T> {
		this.batch.assertOutside("root");
		this.#assertOpen();
		// The scope's ctx acts as `principal`, a `P`: an explicit `undefined` runs anonymous (an HTTP request nobody
		// authenticated), only an omitted one takes the host's.
		// in 运算符区分“键存在但为 undefined”和“没有这个键”。
		const principal = "principal" in options ? options.principal : this.principal;
		// as 把内部宽函数签名适配回公开的 Ctx<P>；运行时行为由 #roots 决定。
		return this.#roots.run(fn as (ctx: Ctx) => Promise<T>, principal, context);
	}

	/**
	 * The names requests here wait for unbound that no plugin here serves (types and registries: `not_served`), sorted;
	 * a name served at another version (`version`) is not among them.
	 */
	// 诊断用途：列出等待中但本宿主无任何插件提供的名字（类型或注册表）。
	// 过滤条件：类型表没有该名字，且注册表记录没有 providedVersion；返回未排序（names 自身有序）。
	unservedNames(): string[] {
		return this.#unbound
			.names()
			.filter((name) => !this.#types.has(name) && this.#registries.get(name)?.providedVersion === undefined);
	}

	/** How many objects here have an activation under way (`ChordObject.activating`). */
	// 统计正在进行激活的对象数；用于关闭/测试断言，不返回对象列表。
	activationsUnderWay(): number {
		let count = 0;
		for (const object of this.#objects.values()) if (object.activating) count++;
		return count;
	}

	/** The registries with contributions here and no provider, each with the newest version contributed, by name. */
	// 找出有贡献者但无人提供声明的注册表，报告最新贡献版本，按名字排序。
	// 这是发布后的诊断：说明“有人在贡献，但缺 Registry 声明”。
	undeclaredRegistries(): { readonly name: string; readonly version: number }[] {
		const found: { readonly name: string; readonly version: number }[] = [];
		for (const record of this.#registries.values()) {
			const version = record.newestContribution;
			if (version !== undefined && record.providedVersion === undefined) found.push({ name: record.name, version });
		}
		// 字符串比较返回 -1/1，保证稳定排序；相等时不会命中这里（名字唯一）。
		return found.sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	/** The record of registry `name` on this host, made by its first use. */
	// 按名取注册表记录，首次使用时惰性创建；报告函数转交宿主 onError。
	// 记录由 RegistryRecord 内部维护贡献、提供者和组合值。
	registryRecord(name: string): RegistryRecord {
		let record = this.#registries.get(name);
		if (record === undefined) {
			record = new RegistryRecord(name, this.batch, (error) => this.report(error), this.#clock);
			this.#registries.set(name, record);
		}
		return record;
	}

	/** Closes the host (once; later calls get the same promise): objects end, links close, pending waits reject. */
	// 幂等关闭：第一次调用创建关闭 Promise 并缓存，后续调用复用；context 不参与，关闭总是执行完。
	// 示例：await host.close(context);
	async close(_context: Context): Promise<void> {
		this.batch.assertOutside("close");
		this.#closing ??= this.#close();
		return this.#closing;
	}

	/**
	 * Whether the host published its setups (`load`'s batch): until then requests made here and holds arriving wait in
	 * the unbound index, placed by the publication.
	 */
	// 发布标志：load 的声明批次提交后为 true；之前 get/hold 会在未绑定索引中等待。
	get published(): boolean {
		return this.#published;
	}

	/**
	 * `request` cannot bind yet: indexed under `name` (the type or registry it waits for) until woken or ended, waiting
	 * for the publication (no `cause`) or for a provider that fits (`cause`).
	 */
	// 把请求登记为未绑定；cause 为空表示还在等发布，否则表示等某提供者/版本。
	index(name: string, request: UnboundRequest, cause: FailureCause | undefined): void {
		this.#unbound.add(name, request, cause);
	}

	/**
	 * `binding`, whose object left it (its type removed, its version no longer bound: slice 7b §6), waits unbound with
	 * `cause` under its type's name; a publication places it again (`params` checked as it was, under `context`).
	 */
	// 重载后对象失去绑定：把该绑定的引用重新放回未绑定索引，等下一次发布再次放置。
	rewait(binding: Binding, Type: Contract, params: CheckedParams, cause: FailureCause, context: Context): void {
		this.#wait(binding, Type.name, cause, () => this.#place(binding, Type, params, context));
	}

	/** `request` left the unbound index's wait for `name` (it ended, or a retry checks it again). */
	// 从未绑定索引移除请求；请求结束或 retry 重新检查时调用。
	unindex(name: string, request: UnboundRequest): void {
		this.#unbound.delete(name, request);
	}

	/** Whether the host closes: its objects end through `close`, not through its links. */
	// 关闭状态以 #state === "closed" 判断；关闭中对象通过 close 结束，而不是通过链路断开。
	get closing(): boolean {
		return this.#state === "closed";
	}

	/**
	 * A reference to `Type` made by `caller` (its principal, its origin's incarnation), once it is live (`host.get`,
	 * `ctx.get`): a hold, waited for up to the getter's one deadline, across reconnects and through `loading`,
	 * `failed { transient }` and `failed { waiting }`; a broken failure rejects at once, the deadline with the last
	 * failure's error. A getter that gives up releases its reference.
	 */
	// 内部获取路径：先建立一个 hold，再用带超时的等待等 binding.live。
	// 超时以最近失败原因（binding.lastFailure）或 not_live 错误中止；任何失败都会 release 引用，避免泄漏 holder。
	// 示例：const binding = await host.acquire(Counter, { name: "a" }, caller, context, {});
	async acquire(
		Type: Contract,
		params: unknown,
		caller: Caller,
		context: Context,
		options: GetOptions,
	): Promise<Binding> {
		this.batch.assertOutside("get");
		const binding = this.#hold(Type, params, caller, context, options);
		const timeout = options.readyTimeout ?? this.timeouts.ready;
		const expired = new AbortController();
		// 组合外部取消与内部超时；等待本身在 waiting.context 下进行。
		const waiting = withLinkedAbortSignal(expired.signal, context);
		// setTimeout 回调中传入 abort 原因：优先用最后一次失败，否则构造 not_live。
		const deadline = setTimeout(() => expired.abort(binding.lastFailure ?? notLive(binding.label, timeout)), timeout);
		try {
			await binding.live(waiting.context);
			return binding;
		} catch (error) {
			// 等待失败（超时、取消、绑定被拒绝）时释放引用；错误继续抛给调用者。
			binding.release();
			throw error;
		} finally {
			clearTimeout(deadline);
			waiting.release();
		}
	}

	/** Adds `delta` to the keep-alive count of `kind` (`host.activity`), where the work happens. */
	// 活动计数的唯一写入口：kind 是计数类别，delta 为 +1/-1；由实际执行工作的层调用。
	count(kind: keyof ActivityCounts, delta: number): void {
		this.#activity.count(kind, delta);
	}

	/** `holder` references `object`: listed in its type's presence, if someone asked for it. */
	// 新 holder 出现时更新 presence；只有曾被 references() 订阅的类型才有缓存，否则无事可做。
	referenced(object: ChordObject, holder: Holder, context: Context): void {
		this.#references.get(object.served.contract.name)?.add(object, holder, context);
	}

	/** `holders` of `object` ended: gone from its type's presence. */
	// 一批 holder 结束时从 presence 移除；Iterable 允许调用方直接传集合。
	unreferenced(object: ChordObject, holders: Iterable<Holder>, context: Context): void {
		this.#references.get(object.served.contract.name)?.remove(holders, context);
	}

	/** Reports a background failure to `onError`; a throwing `onError` has nowhere left to report to. */
	// 后台错误统一出口：捕获 onError 自身抛出的异常并吞掉，避免破坏清理流程。
	report(error: HostError): void {
		try {
			this.#onError(error);
		} catch {
			// Nothing to do: teardowns and attempts go on.
		}
	}

	/**
	 * An unbound reference to an object of `Type` made by `caller`, declared by `dependent` (`undefined` for
	 * `host.get`, `host.hold` and `ctx.get`).
	 */
	// 创建未绑定的引用（不是绑定对象本身）：dependent 表示“哪个对象的成员持有它”，用于依赖图/循环检测。
	// 返回的 Binding 之后通过 bind 放置；宿主关闭后抛 released。
	reference(Type: Contract, dependent: ChordObject | undefined, caller: Caller, options: GetOptions): Binding {
		this.#assertOpen();
		return this.#binding(Type, dependent, caller, options);
	}

	/**
	 * Binds `binding` to the object for (Type, params) as its principal where its host address puts it (`Destination`):
	 * the object here, created with its first attempt if there is none, or a remote object held over its path. Placed
	 * here, the check is only against the type served here: not served (or of the other kind) or not at the caller's
	 * version and fingerprint, the reference waits unbound, `failed { waiting }`, indexed under the type's name. Returns
	 * the object it bound to; throws as `Destination.reference` does (a broken refusal).
	 */
	// 绑定的核心分派：先问 Destination 该引用应放本机还是走路径（远程），远程则创建 RemoteObject 并挂到路径上。
	// 本机放置还要检查服务版本/指纹、参数对应的 hostAddress 是否在别处、匿名远程调用等条件。
	// 返回绑定到的对象；等待时返回 undefined；不可恢复的拒绝抛 ChordError。
	bind(binding: Binding, Type: Contract, params: CheckedParams, context: Context): Target | undefined {
		const { principal } = binding.caller;
		const placed = this.#destination.reference(Type, params.params, principal, context);
		// path 分支：对象在别的宿主，引用经路径持有；RemoteObject 负责转发调用与跟随。
		if (placed.kind === "path") {
			const { caller, dependent } = binding;
			const remote = new RemoteObject(this, Type, params, placed.address, caller, placed.path, dependent);
			placed.path.attach(remote);
			binding.bind(remote);
			return remote;
		}
		const served = this.#types.get(Type.name);
		// unboundCause 检查未服务/种类不符/版本指纹不符；#misplaced 检查参数地址是否被放到其他宿主。
		const unbound =
			unboundCause(served, Type.kind, Type.name, Type.version, Type.fingerprint) ??
			this.#misplaced(Type, served!, params.params);
		if (unbound !== undefined) {
			// 不可绑但可等待：登记 waiting 原因，并在发布/服务变化时重新放置。
			this.#wait(binding, Type.name, unbound, () => this.#place(binding, Type, params, context));
			return undefined;
		}
		// An anonymous scope (an HTTP request nobody authenticated) is no principal a remote type's factory can serve
		// (Opus's build review F5): refused, never bound as the host.
		// 匿名调用者不能触发远程类型激活：远程工厂需要 principal 做隔离；直接拒绝而不是退化成宿主身份。
		if (served!.kind !== "local" && principal === undefined) {
			throw new ChordError({
				code: "forbidden",
				message: `${Type.name}: an anonymous caller gets no remote object`,
			});
		}
		// Checked above: served here at the caller's version.
		// 本机放置：取或创建对象（首次创建即开始第一次尝试），再把绑定指向它。
		const object = this.#object(served!, params, principal, context, NO_CHAIN, binding.dependent);
		binding.bind(object);
		return object;
	}

	/** Where a hold arriving on `link` goes (`Destination.hold`: by the address it names); `released` once the host closed. */
	// 远端 hold 的落点决策：完全委托 Destination，按请求里的地址选择本机新对象、已有对象或路径。
	place(request: HoldRequest, link: HostLink, caller: Caller, context: Context): Placed {
		this.#assertOpen();
		return this.#destination.hold(request, link, caller.principal, context);
	}

	/**
	 * What a hold placed here binds to, acting as `principal`: the object, or why it waits unbound (`failed
	 * { waiting }`): a remote type not served here (`not_served`), not at the hold's version and fingerprint, or whose
	 * params put it on another host (code skew: `version`). Throws for a broken refusal: invalid params, an activation
	 * the hold's chain waits for (`invalid/cycle`, Q5). A new object keeps the hold's chain.
	 */
	// 被放置到本机的远端 hold 的服务决策：检查远程类型是否在本机可用、参数是否合法、是否应在别处。
	// 返回 waiting 或 object；新对象继承 hold 带来的依赖链，若与激活中的对象成环则抛 invalid/cycle。
	serving(request: HoldRequest, params: unknown, principal: Principal, context: Context): Serving {
		const { type, version, fingerprint, chain = NO_CHAIN } = request;
		const served = this.#types.get(type);
		// 远端 hold 只能绑定到 remote 类型的服务；本地类型会得到 not_served 或种类不符。
		const unbound = unboundCause(served, "remote", type, version, fingerprint);
		if (unbound !== undefined) return { kind: "waiting", cause: unbound };
		// Checked above: a remote type served here.
		const remote = served as Extract<Served, { readonly kind: "remote" }>;
		// 参数是 wire 输入：必须在此信任边界做 checkParams。
		const checked = checkParams(remote.contract, params, context);
		const misplaced = this.#destination.misplaced(remote.contract, checked.params);
		if (misplaced !== undefined) return { kind: "waiting", cause: { kind: "waiting", error: misplaced } };
		const object = this.#object(remote, checked, principal, context, chain);
		// 若该对象正在激活，且它的 activationId 已出现在请求链中，说明形成依赖环。
		const activation = object.activationId;
		if (activation !== undefined && chain.includes(activation)) throw this.cycle(chain, activation, [object.label]);
		return { kind: "object", object };
	}

	/**
	 * The path a remote reference of `Type` with `params` acting as `principal` goes over now: `ref.retry()` places a
	 * reference failed for a part past the limits anew (a route may have forgotten its old path). Throws as
	 * `Destination.reference` does, and `unavailable` for a type placed here now.
	 */
	// retry() 的重放路径：用背景上下文重新询问 Destination；现在若放在本机则已不可恢复（unavailable）。
	// 注意这里不等待绑定：只返回路径，由 RemoteObject 重新挂接。
	pathOf(Type: Contract, params: ParamsOf<Contract>, principal: Principal | undefined): Path {
		// A retry has no context of its own: its admission checks count on none.
		const placed = this.#destination.reference(Type, params, principal, BACKGROUND_CONTEXT);
		if (placed.kind === "path") return placed.path;
		throw new ChordError({ code: "unavailable", message: `${Type.name} is placed here now` });
	}

	/**
	 * The `invalid/cycle` error of a cycle through `chain` (Q5): its entries from the activation `id` on, by label
	 * where the object is on this host ("…" for other hosts'), then `closing`.
	 */
	// 构造可读的循环链：从 id 第一次出现处截断（前面的部分不在环上），用对象标签替换 id，未知 id 记为 "…"。
	cycle(chain: readonly string[], id: string, closing: readonly string[]): ChordError {
		const labels = new Map([...this.#objects.values()].map((each) => [each.activationId, each.label]));
		const cycle = chain.slice(chain.indexOf(id)).map((entry) => labels.get(entry) ?? "…");
		return invalid("cycle", `dependency cycle: ${[...cycle, ...closing].join(" → ")}`);
	}

	/** A new origin number for `side`, which relays holds upstream; registered in `relays` until it closes. */
	// 为一次上游转发分配新的 origin 号（单调递增），并登记到 relays；远端响应用它找到回程。
	// side 表示提供方所在的一侧（本机/远端），在 unlink 时逐个通知。
	relayOrigin(side: ProviderSide): number {
		const origin = this.#nextOrigin++;
		this.relays.set(origin, side);
		return origin;
	}

	/**
	 * A route's link, its work under the route's `context`: registered with the host and its heartbeat; one closed
	 * already is returned closed.
	 */
	// route 角色的链路：交给通用 #link 构建；链路已关闭时不会注册，也不会启动心跳。
	routeLink(link: Link, options: LinkOptions<Principal>, context: Context): HostLink {
		return this.#link(link, "route", options, context);
	}

	/** A link completed its handshake: a route's address resolves again once if it drops. */
	// 链路握手完成后通知所有路由；只有 route 角色需要“掉线后可重试”的地址状态。
	linkOpened(link: HostLink): void {
		if (link.role !== "route") return;
		for (const route of this.#routes.values()) route.opened(link);
	}

	/**
	 * Forgets a link once it closed: the origins relaying to it, then the parent's path or its route's address are
	 * told; the heartbeat may stop.
	 */
	// 链路关闭清理：从集合删除、通知转发 origin、若无链路则停心跳，再按角色通知父路径或路由。
	unlink(link: HostLink): void {
		this.#links.delete(link);
		for (const relay of this.relays.values()) relay.unlinked(link);
		// 心跳只在至少一条链路存在时运行；ticking 置空避免重复 interval。
		if (this.#links.size === 0) {
			clearInterval(this.#ticking);
			this.#ticking = undefined;
		}
		if (link.role === "parent") this.#parent.disconnected(link);
		// route.closed 返回 true 表示该链路属于这个路由，已处理完毕，无需继续遍历。
		if (link.role === "route") for (const route of this.#routes.values()) if (route.closed(link)) break;
	}

	/** Moves `object` behind every object that went live before it (close ends in reverse); its backoff is over. */
	// 对象上线后移到 Map 末尾：关闭时 reverse 遍历，保证后上线者先清理。同时清除退避记录。
	wentLive(object: ChordObject): void {
		this.#objects.delete(object.identity);
		this.#objects.set(object.identity, object);
		this.backoff.delete(object.identity);
	}

	/** Drops an ended object (once, before a next instance of its identity exists). */
	// 对象结束后移出活动表，并通知退避表“该身份已结束”（可能触发下一次重试的时限计算）。
	forget(object: ChordObject): void {
		this.#objects.delete(object.identity);
		this.backoff.ended(object.identity);
	}

	/** Records a teardown for `identity`: its next attempt waits for it and for every earlier one still running. */
	// 记录一次拆卸：若同身份已有未完成拆卸，则串成 Promise.all 链，保证新尝试等所有旧清理完成。
	// 完成后只在仍是“当前链”时删除，避免覆盖后来登记的链。
	ending(identity: string, teardown: Promise<void>): void {
		const previous = this.#endings.get(identity);
		const ending = previous === undefined ? teardown : Promise.all([previous, teardown]).then(() => {});
		this.#endings.set(identity, ending);
		// void 表示不等待该 Promise；then 里的身份比较防止误删更新的链。
		void ending.then(() => {
			if (this.#endings.get(identity) === ending) this.#endings.delete(identity);
		});
	}

	/** What the next attempt for `identity` waits for: its previous instances' teardowns, if any still run. */
	// 查询某身份尚未完成的拆卸链；新 attempt 在启动前 await 它。
	endingOf(identity: string): Promise<void> | undefined {
		return this.#endings.get(identity);
	}

	/**
	 * A reference to `Type` made by `caller` for `host.hold` and getters: params checked at once (`invalid/params`,
	 * also before `load`), then placed (`#place`); before the host's publication it waits in the unbound index,
	 * `loading`, and the publication places it.
	 */
	// hold/get 的公共前半段：先做 wire 参数校验（失败立即抛 invalid/params），再创建绑定并放置。
	// 发布前只登记等待，发布时 place 回调被唤醒；发布后立即尝试放置。
	#hold(Type: Contract, params: unknown, caller: Caller, context: Context, options: GetOptions): Binding {
		this.#assertOpen();
		// load 之前本宿主自己的请求会永远等不到发布，因此立即报 not_ready。
		this.#assertLoadCalled(Type.name);
		const checked = checkParams(Type, params, context);
		const binding = this.#binding(Type, undefined, caller, options);
		const place = (): void => this.#place(binding, Type, checked, context);
		if (this.#published) place();
		else this.#wait(binding, Type.name, undefined, place);
		return binding;
	}

	/**
	 * Places a reference (`bind`); where it cannot go (a `hostAddress` or `authorize` that throws or refuses) fails it
	 * broken, until `ref.retry()` places it again. One woken after the host closed ends as the close ended the others.
	 */
	// 放置绑定的兜底：关闭后唤醒的请求直接以 released/closed 结束；bind 抛错则标记 broken 并提供 retry 回调。
	// broken 表示错误不可自动重试，只有调用者显式 ref.retry() 才再次放置。
	#place(binding: Binding, Type: Contract, checked: CheckedParams, context: Context): void {
		if (this.#state === "closed") {
			binding.end(this.#closedError());
			return;
		}
		try {
			this.bind(binding, Type, checked, context);
		} catch (error) {
			// again 回调保留同样的 Type/参数/上下文，供 retry() 使用。
			const again = (): void => this.#place(binding, Type, checked, context);
			binding.refuse({ kind: "broken", error: asChordError(error, Type.name) }, again);
		}
	}

	/**
	 * The provider's own host-address check of a remote `Type` placed here by the consumer's contract, against the one
	 * served (`invalid/host_address`, `waiting`: code skew); none when both have the same `hostAddress` (the consumer
	 * computed it with the provider's function) or the type is local. A provider's `hostAddress` that throws throws.
	 */
	// 只有当双方契约的 hostAddress 函数不同（可能的代码版本偏斜）时才重新计算参数应去的宿主。
	// 本地类型或函数相同则无需检查；返回 waiting 原因或 undefined。
	#misplaced(Type: Contract, served: Served, params: ParamsOf<Contract>): FailureCause | undefined {
		if (served.kind !== "remote" || contractData(Type).hostAddress === contractData(served.contract).hostAddress) {
			return undefined;
		}
		const error = this.#destination.misplaced(served.contract, params);
		return error === undefined ? undefined : { kind: "waiting", error };
	}

	/** Leaves `binding` unbound in the index under `name`: `cause` (`waiting`), or none before the publication. */
	// 把绑定留在未绑定索引：Binding.wait 保存 place 回调与移除回调，索引按名字分组以便发布时批量唤醒。
	#wait(binding: Binding, name: string, cause: FailureCause | undefined, place: () => void): void {
		binding.wait(cause, place, () => this.#unbound.delete(name, binding));
		this.#unbound.add(name, binding, cause);
	}

	/** A new reference's binding made by `caller`; its parked calls wait its `readyTimeout`. */
	// 创建 Binding：dependent 决定依赖图位置，readyTimeout 决定挂起调用的最长等待。
	#binding(Type: Contract, dependent: ChordObject | undefined, caller: Caller, options: GetOptions): Binding {
		return new Binding(Type, this.batch, dependent, caller, options.readyTimeout ?? this.timeouts.ready);
	}

	/** This host as the maker of its own references: its principal and incarnation. */
	// 本宿主自身的 Caller 身份：principal 可能为 undefined（匿名宿主），incarnation 标识本次宿主实例。
	#own(): Caller {
		return { principal: this.principal, incarnation: this.incarnation };
	}

	/** Whether `principal` is this host's own (by principal key): revocation never touches it. */
	// 用 principalKey 规范化后比较，而不是对象引用/深比较；context 参与 key 计算。
	// 宿主匿名时没有自身身份，任何 principal 都不算 own。
	#isOwn(principal: Principal, context: Context): boolean {
		const own = this.principal;
		if (own === undefined) return false;
		// Principals on this host are `P`s: its own, and the ones its links stamp.
		return (
			principalKey(own, context, this.#principalKey) === principalKey(principal as P, context, this.#principalKey)
		);
	}

	/** A new link of `role`, registered with the heartbeat while open. */
	// 构建链路：解析受信/编解码/限额，用 withoutAbortSignal(context) 剥掉调用者取消（链路生命周期独立于单个请求）。
	// 已关闭的链路直接返回；否则登记并惰性启动心跳 interval（周期取 ping/close 的十分之一）。
	#link(link: Link, role: LinkRole, options: LinkOptions<Principal>, context: Context): HostLink {
		const { principal, trusted = false, codec = binaryCodec } = options;
		const limits = linkLimits(trusted, options.limits);
		const made = new HostLink(this, link, { role, principal, trusted, codec, limits }, withoutAbortSignal(context));
		if (!made.open) return made;
		this.#links.add(made);
		if (this.#ticking === undefined) {
			const { ping, close } = this.#heartbeat;
			// 每个 tick 对所有链路复制一遍再遍历，避免 tick 中关闭链路修改集合。
			this.#ticking = setInterval(() => {
				const now = Date.now();
				for (const each of [...this.#links]) each.tick(now, ping, close);
			}, Math.min(ping, close) / 10);
		}
		return made;
	}

	/**
	 * The object for `params` (checked by L1) and, for a remote type, `principal` (its key is part of the identity),
	 * created if there is none; its first attempt starts at once, or when its identity's backoff window ends. A new one
	 * keeps the activation chain it is created for (Q5): `chain` (a hold's), or that of `dependent`'s activation when
	 * an activation declared it, so its own holds over links carry that chain on.
	 */
	// 对象表按 identity 去重：本机类型用契约+参数，远程类型再把 principal key 纳入身份。
	// 已有对象直接复用；新建对象继承依赖链（dependent 的激活链优先于传入 chain），
	// 若退避窗口未结束则暂不启动首次尝试，由 #due 稍后触发。
	#object(
		served: Served,
		params: CheckedParams,
		principal: Principal | undefined,
		context: Context,
		chain: readonly string[] = NO_CHAIN,
		dependent?: ChordObject,
	): ChordObject {
		const { key, params: checked } = params;
		const identity =
			served.kind === "local"
				? identityKey(served.contract, key)
				: // A host serving remote types has a principal, which its references act as unless a
					// link stamped its own (only `P`s).
					// principal as P：远程服务要求宿主有 principal，前面 bind 已拒绝匿名调用者。
					identityKey(served.contract, key, principalKey(principal as P, context, this.#principalKey));
		let object = this.#objects.get(identity);
		if (object === undefined) {
			// Shared by every getter: one getter's cancellation does not cancel it.
			// 对象上下文剥离调用者取消，多个 getter 共享同一个对象；owner 仅远程类型有。
			const owner = served.kind === "local" ? undefined : principal;
			const created = dependent?.activationChain() ?? chain;
			object = new ChordObject(this, served, checked, owner, key, identity, withoutAbortSignal(context), created);
			this.#objects.set(identity, object);
			// waiting 为 true 表示该身份仍在退避窗口内，等待 #due 到点再 attempt。
			if (!this.backoff.waiting(identity)) object.attempt();
		}
		return object;
	}

	/**
	 * Closes the links, then ends every object at once and tears them down one by one, the last to go live first, after
	 * the endings already running.
	 */
	// 关闭顺序有明确理由：先置 closed 并中止路由信号，再按 child→route→parent 关链路（不再发 gone），
	// 然后结束所有远端引用与未绑定等待，最后按上线逆序逐个 stop 并等待既有拆卸链。
	// 所有 native close 失败聚合成 AggregateError 抛给调用者。
	async #close(): Promise<void> {
		this.#state = "closed";
		// 中止路由工作：所有 resolve/hold 的 context 收到 released/closed。
		this.#routing.abort(this.#closedError());
		// Links first, children, routes, then the parent: no `gone` goes out for the objects ending below.
		// 固定角色顺序保证子端先于父端关闭；复制数组避免 close 过程修改集合。
		const links = [...this.#links];
		for (const role of ["child", "route", "parent"]) for (const link of links) if (link.role === role) link.close();
		// Remote references end now: their parked calls reject `released`, no later link holds them.
		const closed = this.#closedError();
		// Code outside objects stops at its next use of Chord: an `fn` waiting in `sleep(ms, ctx)` ends.
		this.#roots.close(closed);
		for (const holder of this.#pathHolders()) if (holder.kind === "remote") holder.lost(closed);
		// At the fence too: requests still waiting for a publication or a provider end as the others did, and gets
		// waiting for a publication that will not come fail now, not after the slow closes below (fix round 1).
		// 未绑定索引先关闭：等待发布的 get 立即失败，而不是拖到慢速拆卸之后。
		this.#unbound.close(closed);
		this.#clock.close();
		// 发布 Promise 必须 settle，否则仍在 await 发布的 registry 读取会悬挂。
		this.#publication.resolve();
		this.backoff.clear();
		// Every object is sealed before any teardown releases a reference, so none ends in the background.
		// stop() 同步封口并返回异步拆卸函数；reverse 对应 wentLive 的末尾插入，后上线先清理。
		const teardowns = [...this.#objects.values()].reverse().map((object) => object.stop());
		// 先等此前已在运行的拆卸（重载/失败路径触发的），再逐个执行本次的拆卸。
		await Promise.all(this.#endings.values());
		const failures: CloseFailed[] = [];
		for (const tearDown of teardowns) failures.push(...(await tearDown()));
		this.#types.clear();
		// Their facets keep their factories' closures (which may keep objects' handles).
		this.#plugins.clear();
		for (const record of this.#registries.values()) record.close();
		this.#registries.clear();
		// store 分离后不再向已关闭宿主写入；detach 的具体行为由 store 实现决定。
		this.store?.detach();
		if (failures.length > 0) {
			const message = `host.close: ${failures.length} native close(s) threw`;
			// AggregateError 保留每个原始错误，便于调用者区分资源。
			throw new AggregateError(
				failures.map(({ error }) => error),
				message,
			);
		}
	}

	/** Every holder of the parent path, the unplaced one and every route's paths: this host's requests over links. */
	// 汇总本宿主所有“跨链路请求”的持有者：父路径、无归属放置区、各路由路径。
	#pathHolders(): Upstream[] {
		const routed = [...this.#routes.values()].flatMap((route) => route.holders());
		return [...this.#parent.holders(), ...this.unplaced.holders(), ...routed];
	}

	/** The store stopped after a backend error (it tells the host once): reported, and the host closes. */
	// 存储后端失败：先报告 storage_failed，再启动关闭（若尚未关闭）。
	// catch(() => {}) 防止关闭失败变成未处理的 Promise 拒绝；应用自己的 close 仍会拿到该 Promise。
	#storageFailed(error: unknown): void {
		this.report({ kind: "storage_failed", error });
		this.#closing ??= this.#close();
		// The app's own `close` returns this closing and gets its failures.
		this.#closing.catch(() => {});
	}

	/** A backoff window ended: the identity's object is retried; without one the entry goes. */
	// 退避到点：有对象则触发下一次尝试；对象已不在则清掉退避条目，避免 Map 泄漏。
	#due(identity: string): void {
		const object = this.#objects.get(identity);
		if (object === undefined) this.backoff.delete(identity);
		else object.attempt();
	}

	/**
	 * Publishes the staged plugins of `facets` (by name), inside the publication's batch: the registries they serve
	 * served, their facet contributions entered into the tables (the types are the staged table's, set by the caller).
	 */
	// 发布一批插件：逐个登记注册表提供者（serve），把贡献值转成 RegistryContribution 并加入记录；
	// 最后把 facet 与 staging 结果保存到 #plugins，供后续重载对比和卸载。
	#publish(staged: Staged, facets: ReadonlyMap<string, Facet<P>>): void {
		for (const [name, facet] of facets) {
			const plugin = staged.plugins.get(name)!;
			for (const [registry, { registry: token, provider }] of plugin.registries) {
				this.registryRecord(registry).serve(token.version, provider);
			}
			// 贡献者身份先记为 { plugin, type: undefined }；类型级贡献会在重载等路径补全 type。
			const contributions = plugin.contributions.map(({ registry, value }) =>
				contributionOf(
					this.registryRecord(registry.name),
					{ plugin: name, type: undefined },
					registry.version,
					value,
				),
			);
			for (const contribution of contributions) contribution.record.add(contribution);
			this.#plugins.set(name, { facet, staged: plugin, contributions });
		}
	}

	// 统一断言：宿主关闭后任何公开操作都得到 released/closed。
	#assertOpen(): void {
		if (this.#state === "closed") throw this.#closedError();
	}

	/**
	 * A request of this host's own (`get`, `hold`, `registry`, a root's `ctx.get`) for `name` before its first `load`
	 * would wait for a publication nobody started: it throws `not_ready` at once (decision "Mistakes that wait are
	 * reported at once" (a)). Holds arriving on its links before `load` still wait for the publication (a worker
	 * connects first, W6).
	 */
	// 只在 state === "new"（从未 load）时报错；已 load 或已关闭走各自的错误路径。
	#assertLoadCalled(name: string): void {
		if (this.#state !== "new") return;
		const fix = "call host.load first (a host with nothing to load calls load([]))";
		throw new ChordError({ code: "not_ready", message: `${name}: the host has not loaded; ${fix}` });
	}

	/**
	 * At each publication (`load`'s, a reload's commit), after its batch: every registry with contributions and no
	 * provider here is reported `registry_undeclared`, naming its contributors; again only once they change.
	 */
	// 逐条记录调用 reportUndeclared；去重由 RegistryRecord 自己保证（贡献变化才再报）。
	#reportUndeclared(): void {
		for (const record of this.#registries.values()) record.reportUndeclared();
	}

	// 关闭后所有操作的统一错误：released + reason closed。
	#closedError(): ChordError {
		return new ChordError({ code: "released", reason: "closed", message: "the host is closed" });
	}
}

/**
 * Why a reference to a type of `kind` at `version` and `fingerprint`, placed here, cannot bind to `served` (the type of
 * that name served here): not served, or as the other kind (`unavailable`); another version or fingerprint
 * (`contract_mismatch`); `undefined` when it binds. Both wait for a publication: `failed { waiting }`.
 */
// 纯函数：判断“按名字找到的服务”能否满足引用声明的 kind/version/fingerprint。
// 未服务或种类不同 → unavailable（永久的等待原因，等待只是一种状态）；版本不匹配 → contract_mismatch。
function unboundCause(
	served: Served | undefined,
	kind: Contract["kind"],
	name: string,
	version: number,
	fingerprint: string,
): FailureCause | undefined {
	if (served === undefined || served.kind !== kind) {
		return { kind: "waiting", error: new ChordError({ code: "unavailable", message: `${name} is not served here` }) };
	}
	const { contract } = served;
	if (binds(served.provider, version, fingerprint)) return undefined;
	const message = `${name} v${version} does not match the served v${contract.version}`;
	return { kind: "waiting", error: new ChordError({ code: "contract_mismatch", message }) };
}

/**
 * Waits until `usable()` (a registry value's check, which records its last error) holds, checked at every change the
 * value tells its waiters of (after the batch that made it); rejects when `context` aborts or the value closes. It
 * waits on the value only while it runs.
 */
// 轮询式等待注册表值可用：每次 dependencyMoved 触发一次重新检查（queueMicrotask 合并同批次通知）。
// closed 原因直接拒绝等待；context 取消通过 awaitWithContext 生效；finally 释放订阅。
async function untilUsable(value: RegistryValueSource, usable: () => boolean, context: Context): Promise<void> {
	// withResolvers 同时得到 promise 和 resolve/reject，便于每次变化后换新的一对。
	let changed = Promise.withResolvers<void>();
	const release = value.wait({
		dependencyMoved: () => queueMicrotask(() => changed.resolve()),
		// The value closed with its host: the wait ends with the close's error.
		closed: (error) => changed.reject(error),
	});
	try {
		while (!usable()) {
			await awaitWithContext(changed.promise, context);
			// 醒来后换新 promise，防止上一次 resolve 影响下一轮等待。
			changed = Promise.withResolvers<void>();
		}
	} finally {
		release();
	}
}

/** What the report calls a fate. */
// 把内部 fate 种类映射成 ReloadedObject.kind 的字符串；as const 保留字面量类型。
const STARTED = { swap: "swapped", restart: "restarted", retry: "retried" } as const;

/** The `aborted` error of a reload whose context aborted before its commit: nothing changed. */
// 提交前取消：没有副作用，错误不带 committed 详情，调用者可安全重试整个 reload。
function reloadAborted(): ChordError {
	return new ChordError({ code: "aborted", message: "reload: aborted" });
}

/** The error of a plugin name given twice: the second is refused. */
// 同名插件重复 load/reload 是配置错误，返回普通 Error（不是 ChordError，因为不是运行期契约问题）。
function loadedTwice(name: string): Error {
	return new Error(`plugin "${name}" is loaded twice`);
}

/** Whether registry provider `served` serves readers of `version`: its own, or an older one its `accepts` maps back. */
// 注册表版本兼容：精确相等，或提供者版本更高且 accepts 明确映射了旧版本（旧的仍可绑定）。
function registryServes(served: StagedRegistry, version: number): boolean {
	const provided = served.registry.version;
	return provided === version || (provided > version && served.provider.accepts?.[version]?.value !== undefined);
}
