// Chord v1 的 host 层：一个 host 拥有类型服务、对象、代码版本、根调用和连接，是插件与外部调用方进入运行时的入口。
//
// 所属模块：packages/chord/src/old/host.ts（Chord v1 旧实现）。本文件定义 createHost/Host、HostImpl（同时实现
// object.ts 的 HostCore 接口）以及 facet、路由、代码版本和公开 API 的类型。上层调用方（Node 服务、TUI、测试）
// 通过 createHost 构造 host，再 serve/install/load 注册类型，通过 get/hold/root 取得对象引用或启动调用树；
// 传输层通过 accept/connect 接入 Link，connection.ts 把帧转成本文件的 peerHello、onReloadFrame、relay 等回调；
// reload.ts/cluster.ts 通过 HostImpl 的 current/previous/pending、gating、registriesChanged 等方法完成热重载。
//
// 职责边界：
// - 本文件负责“哪个对象属于哪个地址、哪个代码版本仍被保留、根调用何时结束、注册表何时发布、连接如何归属”。
// - 对象生命周期、方法调用、状态/监听/任务在 object.ts 的 ObjectImpl 中；帧编解码和流控在 connection.ts/wire.ts；
//   重载事务在 reload.ts/cluster.ts；远端引用在 remote.ts。本文件协调这些模块，不重复实现它们的细节。
// - 同步 API 用 ChordError 向调用方报错；后台错误（释放、监听、任务）交给构造时传入的 onError。
//
// 能力清单（按导出项）：
// - Serve<P>：按契约定义重载的 serve 签名，注册类型工厂；按 RemoteDef/LocalDef 区分，保留工厂返回的字面量 variant。
// - FacetApi<P>：facet 的 setup 拿到的接口（serve、name、root、registry、signal）。
// - FacetDefinition<P> / Facet<P> / defineFacet<P>：插件模块默认导出的定义、带名字的已加载 facet、定义辅助函数。
// - FacetLoader / PluginRef<P>：模块加载器类型，以及“已构造的 facet 或模块路径/URL”这一联合。
// - HostOptions<P> / ConnectOptions<P> / Route<P> / RootOptions<P> / LoadOptions：构造、连接、路由、根和加载的配置。
// - PrincipalPattern<P> / PrincipalMatch<P>：invalidatePrincipal 的模式（按字段匹配）或谓词。
// - Host<P>：外部可见的操作面，从 serve/load 到 get/hold/root/reload/close。
// - CodeVersionState：一个保留代码版本的服务表、注册表、根计数和强制退役信号。
// - createHost<P>()：构造 HostImpl 并以 Host<P> 暴露；HostImpl 同时充任 object.ts 的 HostCore。
//
// 典型组合顺序（示例；签名与真实 API 一致，激活行为才是运行时语义）：
//   const host = createHost<{ user: string }>({ self: { user: "server" }, principalKey: (p) => p.user });
//   // 若要从文件加载 facet，需在 createHost 选项里传 loader，例如 loader: nodeLoader；load() 本身只接收插件列表。
//   host.serve(Counter, ({ name }, principal, self) => { ... });      // 或 host.load(["./facet.ts"])
//   const ref = await host.get(Counter, { name: "clicks" });           // 等到引用就绪（含状态水合）
//   const held = host.hold(Counter, { name: "clicks" });               // 同步拿到可能仍 loading 的引用
//   const value = await host.root((ctx) => ref.increment({ by: 1 }, ctx)); // 启动一根调用树
//   await host.reload(["./facet.ts"]);                                 // 本地重载；有子 host 时走集群事务
//   await host.close();                                                // 先释放持有者，再关闭连接
// 示例只展示最常见的调用顺序；真实使用中 loader 需在 createHost 配置，accept/connect 由传输层驱动。
//
// 建议阅读顺序：
//   1. Serve、FacetApi、HostOptions、Host 等公开类型，先看调用方能看到什么；
//   2. HostImpl 的字段区和构造函数，理解对象、代码版本、引用绑定和根各由哪些集合维护；
//   3. serving 区（serve/install/load/resolve/startHostObject）与地址计算（#elsewhere/#locate/#remoteKey/acquire）；
//   4. roots、registries、links、reload 区，最后看文件末尾的 disposeHoldersFirst、matchesPattern、reaches 等辅助函数。
import { ChildReloads, reconcileChild, runClusterReload } from "./cluster.ts";
import { type AcceptOptions, Connection, type LinkOptions, type RelayRef } from "./connection.ts";
import {
	type AnyContract,
	bind,
	contractFromDescription,
	type InputOf,
	type LocalContract,
	type LocalDef,
	placedOn,
	placementText,
	type Ref,
	type RemoteContract,
	type RemoteDef,
	resolveHost,
} from "./contract.ts";
import { ChordError, invalid, runAll } from "./errors.ts";
import type { Link } from "./link.ts";
import {
	awaitReady,
	CtxImpl,
	type Decls,
	type Factory,
	type HostCore,
	hostLifetime,
	makeService,
	ObjectImpl,
	type RefCore,
	RefImpl,
	type RefOwner,
	type ServeOptions,
	type ServeOptionsFor,
	type Service,
} from "./object.ts";
import { enqueue } from "./publish.ts";
import type { Registry, RegistryTable, RegistryView } from "./registry.ts";
import { type ReloadOptions, type ReloadReport, runReload } from "./reload.ts";
import { RemoteBinding, RemoteRef } from "./remote.ts";
import { canonicalIdentity, canonicalJson, deepEqual, normalize } from "./schema.ts";
import type { Ctx, GetOptions } from "./types.ts";
import type { Frame } from "./wire.ts";

/**
 * Registers a factory for a type. Overloaded on the contract's definition (not the contract type) so TypeScript
 * keeps literal `variant`s in factory returns. `P` is the app's principal type (see `createHost`).
 */
// serve 的两个重载分别接收远端契约和本地契约，第三方调用方不必手写联合；泛型 D 让工厂返回值里的 variant 保持字面量类型。
// 运行时不做重载分派：两个签名最终都落到 AnyServe，契约对象自身决定行为。
export interface Serve<P = unknown> {
	<D extends RemoteDef>(
		type: RemoteContract<D>,
		factory: Factory<RemoteContract<D>, P>,
		options?: ServeOptionsFor<RemoteContract<D>>,
	): void;
	<D extends LocalDef>(
		type: LocalContract<D>,
		factory: Factory<LocalContract<D>, P>,
		options?: ServeOptionsFor<LocalContract<D>>,
	): void;
}

// 内部使用的擦除类型：实现和数组只能保存任意契约；调用方仍通过 Serve 获得精确签名。
// 这里的 AnyContract 是运行时契约令牌，Factory/ServeOptions 来自 object.ts。
type AnyServe = (type: AnyContract, factory: Factory<AnyContract>, options?: ServeOptions) => void;

/**
 * What a facet's `setup` gets. `serve` registers types; `root` and `registry` give the facet's code that is not a
 * Chord method, listener or task (Durable tools and hooks, callbacks of native libraries) access to its own host,
 * so plugins never need a process-global host. Both may be kept and used after `setup` returns.
 */
// facet 的 setup 只能通过这个接口接触宿主，避免依赖进程全局 host；各字段可在 setup 返回后继续使用。
// 这些成员都是 readonly 引用，但 root/registry 返回的宿主对象仍会随重载、关闭而变化。
export interface FacetApi<P = unknown> {
	readonly serve: Serve<P>;
	/** The host's name (`server`, `session:S1`, ...). */
	// 名字用于地址、路由前缀和子 host 识别；不是唯一身份，相同名字的宿主重启由 #incarnation 区分根。
	readonly name: string;
	/** Starts a root on the facet's host (in its current code version at call time). */
	// 在调用时的当前代码版本中启动根；若 facet 已处于重载候选期，这里仍走 host 的 current。
	root<T>(fn: (ctx: Ctx<P>) => T | Promise<T>, options?: RootOptions<P>): Promise<T>;
	/** The facet's host's registry view (`get(key, ctx)` reads the table of `ctx.codeVersion`). */
	// 注册表视图绑定同一个 host；带 ctx 查询会读取该 ctx 代码版本的表，而不是总读最新表。
	registry<V>(registry: Registry<V>): RegistryView<V>;
	/**
	 * Aborted when this run of the facet is no longer installed: a reload that replaced or removed it committed, the reload
	 * that loaded it aborted, or the host closed. While a reload prepares, the installed and the candidate run are both
	 * live.
	 */
	readonly signal: AbortSignal;
}

/** What a facet module exports (default export): the code that serves its types on one host kind. */
// signal 在“这一份 facet 代码不再安装”时中止：替换/移除已提交、加载它的重载失败，或 host 关闭。
// 重载准备期间旧运行和新候选运行可能同时存活，因此不能靠 signal 判断当前谁是正式版本。
// uses 只是消费方声明的契约令牌，加载时不验证；重载时才把它们与提供方重新绑定。
export interface FacetDefinition<P = unknown> {
	/** Contract tokens this facet consumes; checked against providers at reload. */
	readonly uses?: readonly AnyContract[];
	setup(api: FacetApi<P>): void;
}

/** A named facet. Modules are named by their URL; reloading a facet replaces everything it served. */
// name 是重载的替换单位：同名 facet 的旧服务表项被整体替换，不同名 facet 保持不变。
// 例如同名 facet 的新版本删掉一个类型，提交后该类型进入 removed，而其他 facet 的服务继续存在。
export interface Facet<P = unknown> extends FacetDefinition<P> {
	readonly name: string;
}

/** `defineFacet<P>(…)`: an app passes its principal type, so factories and contexts see `P`. */
// 纯工厂函数：不注册、不执行 setup，只把 setup 和可选 uses 收进普通对象；运行时也不校验 uses 的元素。
// 泛型 P 只影响编译期；示例 defineFacet<{ user: string }>((api) => api.serve(...))，setup 中的 api 会带 P。
export const defineFacet = <P = unknown>(
	setup: (api: FacetApi<P>) => void,
	options: { readonly uses?: readonly AnyContract[] } = {},
): FacetDefinition<P> => ({ setup, uses: options.uses });

/** Imports facet modules (fresh copies on every call) and names them by module URL. */
// 唯一的加载器接口：实现必须为每个模块产出带稳定 name 的 Facet；nodeLoader 通过 URL 查询参数强制新实例。
// 返回数组的顺序必须与输入模块顺序一致，host.resolve 依赖 loaded.shift() 做位置配对。
export type FacetLoader = (modules: readonly (string | URL)[]) => Promise<Facet[]>;

/** A facet object, or a module (path or URL) whose default export is a FacetDefinition. */
// 联合的三种成员在运行时用“是否对象且非 URL”区分；字符串和 URL 都可能指向同一个模块。
export type PluginRef<P = unknown> = Facet<P> | string | URL;

// 类型谓词 ref is Facet 让调用方在 true 分支里直接读 facet.name/setup；运行时检查只保证对象且不是 URL，
// 并不检查 name/setup 是否齐全，真正的 facet 结构由 install 使用时的行为暴露。
const isFacet = (ref: PluginRef): ref is Facet => typeof ref === "object" && !(ref instanceof URL);

/**
 * `P` is the app's principal type: who a caller is, JSON-serializable. Chord never makes one up: the app supplies the
 * host's own (`self`), the one its parent's own requests act as (`connect`), the ones links act as (`accept`) and the
 * ones routed hosts act as (`Route.principal`).
 */
// 构造配置。self 是必填项（不是可选）：Chord 从不凭空发明身份，所有入口和对象都必须能追溯到一个 principal。
export interface HostOptions<P = unknown> {
	// 省略时为 "host"；它参与地址、路由匹配和日志，不要求全局唯一。
	readonly name?: string;
	/**
	 * The principal of the host's own code: roots it starts, code inside its objects, and its `lifetime: "host"` objects.
	 * Compared by `principalKey`, so an equal principal from elsewhere reaches the same objects. Not used to infer `P`:
	 * pass the app's type as `createHost<P>(…)`.
	 */
	// NoInfer<P> 阻止 TypeScript 用 self 的字面量反推 P；P 只由 createHost<P>() 的显式参数或上下文决定。
	// 运行时没有额外校验：self 是什么，#selfKey 就按 principalKey 算出什么。
	readonly self: NoInfer<P>;
	/** Maps a principal to its object key (should include connection provenance and grant revision). */
	// 默认 canonicalJson；相同 key 的 principal 被视为同一身份，会落到同一个对象地址。
	// 该函数必须是纯的、确定的；作者应把连接来源和授权版本纳入 key，避免权限变化后复用旧对象。
	readonly principalKey?: (principal: P) => string;
	/** Validates every cell write and exposed state value against its schemas. */
	// 开启后 Cell 写入和对外状态值会按 schema 校验；关闭时主要依赖输入/输出边界上已有的校验。
	readonly dev?: boolean;
	/** Errors from background work (disposal, listeners, tasks). Defaults to console.error. */
	// 只接收无法直接返回给调用方的错误；同步 API 的错误仍由 Promise 或 throw 传播。回调抛错不会被本文件吞掉。
	readonly onError?: (error: unknown) => void;
	/**
	 * Milliseconds a reload waits for an object's aborted tasks to finish before it starts their replacements anyway
	 * (reported). Default 5000.
	 */
	// 重载时先中止旧任务；超过这个时间仍没结束就报告并启动替代任务，避免新旧两轮任务长期并行。
	readonly taskStopDeadline?: number;
	/**
	 * Milliseconds an activation (or a reload's prepare) waits for its references to be ready and hydrated, and an
	 * awaited `get` for its reference, before failing with `unavailable/ready_timeout`. Default 60000.
	 */
	// 超时抛 unavailable/ready_timeout；错误信息会列出仍在等待的地址，便于定位跨 host 的引用环。
	readonly readyTimeout?: number;
	/**
	 * Consumer-side linger of remote references: when the last reference to a remote object is released, its binding
	 * stays held, and hydrated, for `types[typeName]` milliseconds, so a reference taken again meanwhile costs nothing
	 * on the link. At most `cap` bindings (default 4) linger; beyond, the least recently released go first. Types not
	 * listed do not linger. (The provider's own `serve(…, { linger })` keeps its object after the last reference.)
	 */
	// 只对“消费侧远端引用”的绑定生效；未列出的类型释放后立即关闭绑定。提供方对象自身的 linger 在 serve 选项里。
	readonly linger?: { readonly types?: Readonly<Record<string, number>>; readonly cap?: number };
	/** Needed for `load`/`reload` with modules; `nodeLoader` from loader.ts in Node. */
	// 只有传字符串/URL 的插件才需要；直接传已构造的 Facet 对象可以没有 loader。缺失时 load 会给出配置提示。
	readonly loader?: FacetLoader;
	/** `client` (browser): never a reload participant, never carries roots or code versions. Default `host`. */
	// client 不承载根或代码版本，也不参与重载协调；它仍可有对象、远端引用和连接。
	readonly kind?: "host" | "client";
	/** The link to this host's parent (server). Can also be set later with `connect`. */
	// 这里给出的是初始连接；之后再次 connect 会关闭旧 upstream link 并把共享绑定重新 hold 到新连接。
	// 交叉类型 & 表示“同时具备 link 字段和 ConnectOptions 的字段”，不是运行时的合并操作。
	readonly upstream?: { readonly link: Link } & ConnectOptions<P>;
}

/** `connect` options: the link's, and the principal its parent's own requests act as. */
// 连接父 host 的配置：继承 LinkOptions（ping、窗口等），并强制提供 principal。
// principal 是父 host 自身代码发起请求时的身份；父转发调用者身份时，帧里的 principal 会覆盖它。
export interface ConnectOptions<P = unknown> extends LinkOptions {
	/** What a request from the parent acts as when the parent does not forward its caller's principal (its own code). */
	readonly principal: P;
}

/** Where requests for hosts named `prefix…` go (on the server). */
// 路由把“目标 host 名”映射成一条已认证的 Link。resolve 可能拉起新进程，因此 authorize 会在解析前后各检查一次。
export interface Route<P = unknown> {
	/** Checked before resolving (or spawning) and again after: grants may change meanwhile. */
	// 返回 false 时抛 forbidden；返回 Promise 时 host 会等待。authorize 抛错也会直接向上传播。
	authorize(principal: P, hostName: string): boolean | Promise<boolean>;
	/** A link to the host, spawned if needed. */
	// 只负责拿到 link，不负责发送 hello；host 会把它包装成 downstream Connection 并等待 whenSynced。
	resolve(hostName: string): Promise<Link>;
	/** The principal the resolved host acts as when it calls back. */
	// 被路由的 host 反向调用本 host 时使用的身份；它不同于发起本次 resolve 的 principal。
	readonly principal: (hostName: string) => P;
}

/** Fields a principal must have, equal (`deepEqual`), for an `invalidatePrincipal` pattern. */
// 条件类型：P 是对象时，模式只能使用 P 的键且值类型对应；P 不是对象时退回任意字符串键记录。
// 全部字段可选，未写出的字段不参与比较；运行时用 deepEqual 逐字段比较，模式不会校验 principal 本身的 schema。
export type PrincipalPattern<P> = P extends object
	? { readonly [K in keyof P]?: P[K] }
	: Readonly<Record<string, unknown>>;

/** `invalidatePrincipal` matches: a predicate (this host only), or a pattern (fields that must be equal; propagates). */
// 谓词只在本 host 执行；模式会作为 invalidate 帧转发给子 host，让它们也清理匹配对象。
// 两种形式都在运行时判断（typeof match === "function"），联合类型本身不会自动收窄到实现。
export type PrincipalMatch<P = unknown> = ((principal: P) => boolean) | PrincipalPattern<P>;

// 根调用的选项。根是短调用树：它携带 rootId、代码版本和 principal，并在结束（包括异常）时释放 ctx.get 的引用。
// rootId 不在这里给出，由 host.root 生成；跨 host 的调用通过线上的 RootRef 复用同一个 rootId。
export interface RootOptions<P = unknown> {
	// 省略时用 host 的 self；入口调用常用调用者身份，对象内部则通常是 self。
	readonly principal?: P;
	// 中止后根内的 ctx.signal 触发，正在等待的调用被取消；根仍会走 finally 清理租约。
	readonly signal?: AbortSignal;
	/** Start the root in a retained code version (links carry code versions). Defaults to the current code version. */
	// 代码版本必须仍被保留，否则 joinRoot 抛 superseded；子 host 重连后可能用旧版本发起调用。
	readonly codeVersion?: number;
}

// install/load 的可选行为。默认等待 host 生命周期对象激活；关闭等待可让需要父 host 的子对象先安装、后完成。
export interface LoadOptions {
	/**
	 * Await the activation of the `lifetime: "host"` objects the facets serve (default true). False starts them but
	 * leaves readiness to `host.ready()` (a child host whose objects need its parent, which admits it only later).
	 */
	// false 时 install 立即返回，host.ready() 仍可等待这些对象；激活失败通过 onError 报告。
	readonly awaitHostObjects?: boolean;
}

// 外部操作面。createHost 返回的运行时对象其实是 HostImpl，但调用方只依赖这个接口，便于替换和测试。
// 泛型 P 会流入 serve 工厂、get 选项、root ctx 和 accept/connect 的 principal 类型。
export interface Host<P = unknown> {
	// 宿主名，参与地址生成、路由匹配和日志；Chord 不要求它在进程内唯一。
	readonly name: string;
	// 新根和新对象默认使用的代码版本 id；重载提交后会变化，因此是 getter 而不是固定字段。
	readonly codeVersion: number;
	// 仍保留的上一代码版本 id；没有旧版本（例如未重载或已退役）时为 undefined。
	readonly previousCodeVersion: number | undefined;
	// 不属于任何 facet 的宿主代码可直接用它注册类型；该服务只随 host 关闭而消失。
	readonly serve: Serve<P>;
	/** Installs synchronously, then awaits this facet's host objects unless `awaitHostObjects` is false. */
	// setup 在返回 Promise 前同步执行；同名 facet 已安装会拒绝，重载请用 reload。setup 抛错时中止该 facet 的运行信号并原样抛出。
	install(facet: Facet<P>, options?: LoadOptions): Promise<void>;
	/** Installs all facets before awaiting their host objects; referenced objects are created when first referenced. */
	// 先解析模块，再用 Promise.all 并行 install；install 之间不 await，允许后面的 facet 为前面的 host 对象提供类型。
	load(plugins: readonly PluginRef<P>[], options?: LoadOptions): Promise<void>;
	/** Awaits the host objects present at call time, including those started by `serve` or deferred loads. */
	// 只等待调用时已存在的 host 对象集合；之后通过 serve 新增的对象要靠再次 ready()（install 默认会等待自己的）。
	ready(): Promise<void>;
	/**
	 * A reference held until `release()`. Resolves once it is ready: live, with every state member of its variant
	 * (unless `state: false`). Rejects with the activation error, `aborted` (`signal`), or `unavailable/ready_timeout`
	 * after `readyTimeout`; the reference is released then.
	 */
	get<C extends AnyContract>(
		type: C,
		input: InputOf<C>,
		options?: GetOptions<P> & { readonly signal?: AbortSignal },
		// 等待失败的引用会被释放，不能拿来重试；要重试请再次 get。signal 中止或 readyTimeout 超时都会拒绝并释放。
	): Promise<Ref<C>>;
	/**
	 * The same reference, synchronously, possibly still `loading`: for UI runtimes that render its status (hooks, a
	 * TUI watch). Its state members throw `not_ready` until it is live.
	 */
	// 不会等待激活；返回的引用已持有对象，调用方法会自动排队到对象就绪。引用必须由调用方 release，否则对象不会闲置。
	hold<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Ref<C>;
	// 启动本地根：rootId 带 host 名和随机 incarnation，避免同一名字的宿主重启后与旧根混淆。
	root<T>(fn: (ctx: Ctx<P>) => T | Promise<T>, options?: RootOptions<P>): Promise<T>;
	// 注册表视图；订阅时会先同步收到当前表，之后在发布队列中收到变化。
	registry<V>(registry: Registry<V>): RegistryView<V>;
	/**
	 * Force-disposes every object whose principal matches (never the host's own principal), re-stamps or closes
	 * matching links, and propagates pattern matches to child hosts.
	 */
	// 永不匹配 host 自身 principal；模式会传播到子 host，谓词不会。所有匹配对象强制释放，等待全部清理结束。
	invalidatePrincipal(match: PrincipalMatch<P>): Promise<void>;
	/** Accepts a child link (a worker or a browser); requests on it act as `options.principal`. */
	// 角色和 peer 类型由本端决定，不信任对方 hello；client 默认、host 必须给 name。连接建立后立即发送 hello。
	accept(link: Link, options: AcceptOptions<P>): void;
	/**
	 * Sets (or replaces, after a reconnect) the link to this host's parent; remote references re-hold over it. The
	 * parent's own requests act as `options.principal`; requests it relays act as the principal it forwards.
	 */
	// 重复 connect 会先关闭旧 upstream link（原因 "replaced"），再把没有 hold 的绑定重新发到新连接。
	connect(link: Link, options: ConnectOptions<P>): void;
	// 同一个前缀重复注册会覆盖旧路由；匹配时选择最长前缀，而不是注册顺序。
	route(prefix: string, route: Route<P>): void;
	/** Reloads the given facets (modules are re-imported); facets not listed keep running unchanged. */
	// 有子 host 或给出 remote/remoteRemove 时走集群事务；否则本地 prepare/commit。client host 不向父 host 发起协调。
	reload(plugins: readonly PluginRef<P>[], options?: ReloadOptions): Promise<ReloadReport>;
	// 幂等关闭：先释放所有对象（持有者先于被引用者），再关闭连接；重复调用会等待同一个清理结果。
	close(): Promise<void>;
}

// 一个保留中的代码版本。current/previous/pending 都是这个结构；roots 按 rootId 计数，因为同一根可能在本地有嵌套调用，
// 也可能有经由连接回到本 host 的重入调用。tables 是可变引用，但装载时整体替换，不原地修改旧表。
export interface CodeVersionState {
	// 单调递增的版本号；关联的 host 间通过 hello/commit/retire 帧对齐。
	readonly id: number;
	// 类型名到 Service 的映射；不同代码版本可以有同名类型的不同实现。
	readonly services: Map<string, Service>;
	// 注册表快照；某些版本可能从未注册，读取时回退到共享空表。
	tables: ReadonlyMap<string, RegistryTable<unknown>>;
	/** Running roots with the number of their calls running here. */
	// 只统计“此刻在本 host 上运行”的调用；根离开本 host 后计数归零，但根在外面的链接仍由 #rootLinks 跟踪。
	readonly roots: Map<string, number>;
	/** Aborts every root of this code version (forced retirement). */
	// 强制退役时先 abort 这个信号，让仍在运行的根看到取消，再关闭该版本独有的资源。
	readonly abort: AbortController;
}

// 共享的只读空表，避免每次查未注册的 registry 都新建 Map；RegistryTable<never> 表示它不含任何值。
const EMPTY_TABLE: RegistryTable<never> = new Map<string, never>();

/** A host whose principals are `P` (the app's type; `unknown` if not given). */
// 泛型 P 只存在于类型层。运行时先按擦除后的 HostOptions 构造，再 through unknown 断言为 Host<P>：
// 这是 TypeScript 无法从构造器泛型保留 P 时的断言，不是运行时转换；HostImpl 的方法随后通过泛型签名补齐类型。
// 示例：createHost<{ user: string }>({ self: { user: "server" } }) 返回 Host<{ user: string }>。
export function createHost<P = unknown>(options: HostOptions<P>): Host<P> {
	return new HostImpl(options as HostOptions) as unknown as Host<P>;
}

// HostImpl 是唯一实现：对外满足 Host，对 object.ts 满足 HostCore，对 remote.ts 满足 RemoteHost（结构类型）。
// 字段分四组理解：对象与代码版本；远端绑定与连接；根与租约；注册表与重载协调。
export class HostImpl implements Host, HostCore {
	// 下面两个字段在构造时固定；principal 是 self 的运行时值，isSelf 用它做快速引用相等判断。
	readonly name: string;
	readonly dev: boolean;
	readonly principal: unknown;
	// 工厂执行深度。>0 时禁止读写 cell、调用远端方法，防止工厂在对象尚未装配完成时产生副作用。
	inFactory = 0;
	// 首次致命提交错误的缓存；一旦非 undefined，admit 拒绝所有新工作，host 不再假装健康。
	failed: unknown;
	// 地址 -> 对象。地址包含类型、规范化输入和 principal 部分；同一地址的引用共享一个 ObjectImpl。
	readonly objects = new Map<string, ObjectImpl>();
	// 仍保留的代码版本：current、可能存在的 previous，以及重载准备中的 pending 只在待提交阶段加入。
	readonly codeVersions = new Map<number, CodeVersionState>();
	// 已安装 facet 的当前定义，按 name 索引；重载提交后整体替换，旧运行通过 signal 中止。
	readonly facets = new Map<string, Facet>();
	/** The host's own references to its `lifetime: "host"` objects, by type name. */
	// 这些引用由宿主自己持有，因此 host 生命周期对象不会因为外部引用释放而消失；close 时清空。
	readonly hostObjects = new Map<string, RefCore>();
	readonly kind: "host" | "client";
	// 本 host 参与的所有连接，含 upstream 和 downstream；关闭连接时各自从集合移除。
	readonly connections = new Set<Connection>();
	// 指向父 host 的唯一定向连接；重连时替换。它同时承载直接调用和子 host 的 relay。
	upstream: Connection | undefined;
	/** Shared bindings of this host's remote references, by key (re-held after an upstream reconnect). */
	// key 由 #remoteKey 生成：类型、输入身份、principal 部分、消费方契约指纹；不含目标 host 名。
	// 多个本地引用可共享同一绑定，对应链路上一次 hold；绑定结束后由 forgetBinding 移除。
	readonly bindings = new Map<string, RemoteBinding>();
	/** Bindings without references that linger, least recently released first. */
	// Map 的插入顺序即“最近释放”顺序；超过 cap 时从最旧开始 close。
	readonly #lingering = new Map<string, RemoteBinding>();
	// linger 配置按类型复制引用；类型未列出时值为 0，表示立即关闭。
	readonly #lingerTypes: Readonly<Record<string, number>>;
	readonly #lingerCap: number;
	// client 连接的 origin 序号，与 #incarnation 组合成跨 relay 仍可区分的来源 id。
	#originSeq = 0;
	// 前缀 -> Route；#routeFor 每次线性扫描并挑选最长匹配，路由数量预期很小。
	readonly #routes = new Map<string, Route>();
	// 子 host 发来的重载帧交给它处理；它维护跨 host prepare/vote/commit/abort 的状态。
	readonly #childReloads = new ChildReloads(this);
	/** Child facet modules by host-name prefix, from every committed cluster reload (for reconciling children). */
	// 集群重载提交后记住“前缀对应哪些模块”，新连接的落后子 host 可据此重建到当前代码版本。
	// 这些是普通可变对象，属于 host 协调数据，不参与 Chord 对象地址或状态。
	remoteModules: Record<string, string[]> = {};
	/** Removal tombstones also reconcile children that connected during a transaction. */
	// 与 remoteModules 相反：记录已移除的模块。使用墓碑是因为事务期间新连入的子 host 没经历 remove 事件。
	remoteRemoved: Record<string, string[]> = {};
	/** Highest code version the parent has retired. */
	// 子 host 只能退役到父 host 明确允许的版本；初值 0 表示父还没发 retire 帧。
	#retireAllowed = 0;
	/** Roots that came over a link, by the link they came from. */
	/** Foreign roots (started on another host), by the links they came over. */
	// 一个外来根可能经多条链路到达本 host；只有所有来源链路都宣布 root_end/关闭后才结束租约。
	readonly #foreign = new Map<string, Set<Connection>>();
	/** Roots started on this host that have not ended. */
	// 本地发起的根；收到同 rootId 的外来调用不会把它误认成外来根。
	readonly #local = new Set<string>();
	// 随机短后缀让同一 host 名重启后的 rootId 不与上一进程冲突；不是安全随机数，只用于去重。
	readonly #incarnation = Math.random().toString(36).slice(2, 8);
	/** Links each root's calls went out on. */
	// 根结束时需要向这些连接发送 root_end，让远端释放该根的租约和爷爷化状态。
	readonly #rootLinks = new Map<string, Set<Connection>>();
	// 当前代码版本：新根默认使用它，新对象用它查找 Service。
	current: CodeVersionState;
	// 上一代码版本，等所有旧根结束且父 host 允许后才退役；重载期间两版并存。
	previous: CodeVersionState | undefined;
	/** The code version a running reload will commit; new types activated during prepare install their implementation for it. */
	// 重载准备期已分配但未提交的版本；新类型激活时会把实现安装到 pending，使候选对象在提交前就可用新契约绑定。
	pending: CodeVersionState | undefined;
	/** Activations of these types wait (reload gate). */
	/** Types behind a reload gate: new objects of these types are rejected `upgrade_conflict` until commit/abort. */
	// 变更类型在 gate 期间禁止新建对象，避免候选集不断增长；提交/回滚后清空。
	gating: ReadonlySet<string> | undefined;
	// 串行化重载：第二个 reload 会被 beginReload 拒绝。子 host 的 hello 在重载期间也会先延后。
	reloading = false;
	// 两个超时都由构造选项决定；数值有限且很小会让激活/重载更容易超时，测试可借此验证错误路径。
	readonly taskStopDeadline: number;
	readonly readyTimeout: number;
	// principalKey 接收 unknown，以便比较任意来源的身份；默认 canonicalJson 对普通 JSON 值生成稳定字符串。
	readonly #principalKey: (principal: unknown) => string;
	/** `principalKey(self)`: an equal principal is the host's own, whatever object carries it. */
	// 只缓存 self 的 key；isSelf 先比较引用，再比较 key，因此等价但不同对象也视为同一身份。
	readonly #selfKey: string;
	/** Called when a root ends, the parent allows a retirement, or the previous code version retires. */
	// 重载等待退役时订阅这些事件；watcher 是同步回调，调用方自己负责移除。
	readonly #retirementWatchers = new Set<() => void>();
	/** Child hosts whose hello arrived while a reload ran: synced or reconciled once it ends. */
	// 值是 hello 里声明的代码版本；重载结束后 reloadEnded 会重新调用 peerHello，使用最新状态。
	readonly #deferredHellos = new Map<Connection, number>();
	/** Resolved when the running reload ends. */
	// whenReloadEnded 的等待者；reloadEnded 一次性全部唤醒，不保留 promise。
	readonly #reloadWaiters: (() => void)[] = [];
	/** Aborted when the installed run of a facet (by name) is replaced, removed, or the host closes. */
	// 每次 install/load 的 facet 运行都有独立控制器；重载提交时新运行替换旧运行，旧信号中止。
	readonly #facetRuns = new Map<string, AbortController>();
	// 已解析的 onError，避免每次报告都做空值判断；默认打印到 console.error。
	readonly #onError: (error: unknown) => void;
	// 模块加载器可以为 undefined（只安装已构造 facet 时不需要）。
	readonly #loader: FacetLoader | undefined;
	// 正在销毁的对象地址。旧对象尚未清理完时，同地址的新对象必须等它完成，避免独占资源重叠。
	readonly #dying = new Map<string, ObjectImpl>();
	// rootId -> 该根接触过的对象；根结束时据此清除对象的租约。
	readonly #touches = new Map<string, Set<ObjectImpl>>();
	// 每个 registry 的稳定键顺序：首次注册的 key 分配递增序号，重载后仍按初始顺序发布表。
	readonly #order = new Map<string, Map<string, number>>();
	// registry 名称 -> 订阅者集合；只在当前代码版本的表变化时通知，重载安装时用 all=true 强制通知。
	readonly #subscribers = new Map<string, Set<(table: RegistryTable<unknown>, codeVersion: number) => void>>();
	// 代码版本号从 1 开始；pending 分配后即使重载失败也不会复用（nextCodeVersionId 只增不减）。
	#codeVersionSeq = 1;
	// 本地根序号；与 #incarnation 和 host 名一起构成唯一 rootId。
	#rootSeq = 0;

	// 构造只建立空代码版本和配置，不激活任何对象，也不发送 hello；连接若在 options.upstream 中给出则立即 connect。
	constructor(options: HostOptions) {
		// ?? 只对 null/undefined 取默认值；空字符串 host 名会被保留，调用方需自行保证名字可用。
		this.name = options.name ?? "host";
		this.dev = options.dev ?? false;
		// TS 已要求 self，但 createHost 是库入口，未类型化的 JS 调用仍可能漏传；这是构造边界上的运行时兜底。
		if (!("self" in options)) throw new TypeError("createHost needs `self`: the principal of the host's own code");
		this.principal = options.self;
		// principalKey 的默认实现要求 principal 可 JSON 序列化；函数若返回非字符串不会在这里检查。
		this.#principalKey = options.principalKey ?? canonicalJson;
		this.#selfKey = this.#principalKey(options.self);
		// 包一层 console.error，确保报告器始终可调用；用户回调抛错会直接冒泡到调用 report 的地方。
		this.#onError = options.onError ?? ((error) => console.error("chord:", error));
		this.#loader = options.loader;
		// 数字分隔符 60_000 只是可读性写法，值仍是 60000 毫秒。
		this.taskStopDeadline = options.taskStopDeadline ?? 5000;
		this.readyTimeout = options.readyTimeout ?? 60_000;
		this.#lingerTypes = options.linger?.types ?? {};
		this.#lingerCap = options.linger?.cap ?? 4;
		// 初始代码版本总是 1：服务表为空，注册表为空，根计数为空，信号未中止。
		this.current = {
			id: this.#codeVersionSeq,
			services: new Map(),
			tables: new Map(),
			roots: new Map(),
			abort: new AbortController(),
		};
		this.codeVersions.set(this.current.id, this.current);
		// kind 默认 host；client 只是不参与重载协调/代码版本，并不禁用对象或远端引用。
		this.kind = options.kind ?? "host";
		// 先完成 current 初始化再 connect，因为 Connection 构造时会读取 host.current.id 发送 hello。
		if (options.upstream !== undefined) this.connect(options.upstream.link, options.upstream);
	}

	/** Whether `principal` is the host's own: the same key as `self`. */
	// 先做引用相等（最常见、最便宜），再按 principalKey 比较语义身份。
	// principalKey 不是纯函数时，这里可能产生与对象地址不一致的判断；运行时无法验证纯函数性。
	isSelf(principal: unknown): boolean {
		return principal === this.principal || this.#principalKey(principal) === this.#selfKey;
	}

	// getter 在读取时动态返回；重载提交后 codeVersion 会变化，不能在构造时缓存。
	get codeVersion(): number {
		return this.current.id;
	}

	// previous 只在保留旧版本时存在；可能为 undefined，因此返回类型带 | undefined。
	get previousCodeVersion(): number | undefined {
		return this.previous?.id;
	}

	/** Allocates the next code version id, or adopts one issued by the coordinating server. */
	// 本地重载不传 given，序号递增；协调服务器会下发统一 id，此时必须严格大于当前版本。
	// 这里抛普通 Error 而不是 ChordError：它表示协调协议/调用方错误，不是运行时可重试的业务错误。
	nextCodeVersionId(given?: number): number {
		if (given !== undefined && given <= this.current.id)
			throw new Error(`code version ${given} is not newer than ${this.current.id}`);
		// given 直接采纳（协调者保证全局单调）；否则在本地序号上加一。
		this.#codeVersionSeq = given ?? this.#codeVersionSeq + 1;
		return this.#codeVersionSeq;
	}

	// 后台错误的唯一出口；对象、连接、重载模块都用它报告，避免各处散落 console 调用。
	report(error: unknown): void {
		this.#onError(error);
	}

	// ─── serving ───

	// 直接 serve 属于“无 facet 的宿主代码”：facet 名为空字符串。重载期间禁止，因为正在构建候选服务表。
	// satisfies AnyServe 只检查箭头函数符合内部擦除签名，不改变运行时值；随后的 as Serve 把公开重载类型补回去。
	readonly serve: Serve = ((type, factory, options = {}) => {
		if (this.reloading) throw new Error("host.serve during a reload; serve from a facet passed to reload()");
		// 空 facet 名表示该服务不属于任何可重载模块，只有 host 关闭才会消失。
		this.serveInto(this.current.services, makeService(type, factory, options, ""));
		// host 生命周期类型在 serve 时立即创建唯一对象；失败通过 onError 报告，serve 本身不改返回 Promise。
		if (options.lifetime === "host") this.startHostObject(this.current.services.get(type.name)!);
	}) satisfies AnyServe as Serve;

	// install 是同步注册 + 异步等待：setup 必须在返回前完成，这样 load 可以并行安装多个 facet。
	install(facet: Facet, options: LoadOptions = {}): Promise<void> {
		if (this.reloading) throw new Error("host.install during a reload");
		// 已安装同名 facet 不能直接覆盖；需要替换时走 reload，以保留旧版本直到提交。
		if (this.facets.has(facet.name)) throw new Error(`facet ${facet.name} is already installed; use reload()`);
		const added: Service[] = [];
		// 这个控制器代表“本次 facet 运行”；被替换/移除/关闭时中止 Api.signal。
		const run = new AbortController();
		try {
			// setup 收到的 serve 已绑定 facet 名，且只把服务写进当前版本，不检查 placement 之外的重载约束。
			facet.setup(
				this.facetApi(
					((type, factory, options = {}) => {
						const service = makeService(type, factory, options, facet.name);
						this.serveInto(this.current.services, service);
						added.push(service);
					}) satisfies AnyServe as Serve,
					run.signal,
				),
			);
		} catch (error) {
			// setup 失败也要中止信号，让 setup 期间拿到的 api 不再被使用；错误原样抛给调用方。
			run.abort(error);
			throw error;
		}
		// 只有 setup 成功后才登记 facet 与运行控制器，避免失败安装留下半套状态。
		this.facets.set(facet.name, facet);
		this.facetRunChanged(facet.name, run);
		// 只为本次新增的 host 生命周期服务创建对象；普通类型按需创建。
		const refs = added.filter(hostLifetime).map((service) => this.startHostObject(service));
		return options.awaitHostObjects === false ? Promise.resolve() : this.#hostObjectsReady(refs);
	}

	async load(plugins: readonly PluginRef[], options: LoadOptions = {}): Promise<void> {
		const facets = await this.resolve(plugins);
		// No await between installs: a host object's factory may consume a type served by a later facet.
		// Promise.all 仍会等待所有 install，但各 install 的同步注册阶段按数组顺序先全部执行。
		await Promise.all(facets.map((facet) => this.install(facet, options)));
	}

	// 等待“调用时已存在”的 host 对象；集合是可迭代的 Map.values()，先展开成数组再逐一取 ready。
	ready(): Promise<void> {
		return this.#hostObjectsReady(this.hostObjects.values());
	}

	// 把多个引用的 ready 合成一个 Promise；.then(() => {}) 把 Promise<void[]> 擦成 Promise<void>。
	#hostObjectsReady(refs: Iterable<RefCore>): Promise<void> {
		const ready = Promise.all([...refs].map((ref) => ref.ready)).then(() => {});
		// Ignoring install's return still reports through onError without an unhandled rejection.
		// 单独挂一个空 catch，防止调用方不 await 时出现未处理拒绝；错误仍由 RefCore 的激活路径报告。
		ready.catch(() => {});
		return ready;
	}

	/** Turns plugin references into facets, importing modules through the loader. */
	// 先挑出需要加载的模块（类型谓词把联合收窄为 string | URL），再用 loader 一次加载全部模块。
	// 位置配对依赖 loader 返回顺序与输入顺序一致；已构造的 Facet 原样保留，不经过 loader。
	async resolve(plugins: readonly PluginRef[]): Promise<Facet[]> {
		const modules = plugins.filter((ref): ref is string | URL => !isFacet(ref));
		if (modules.length > 0 && this.#loader === undefined) {
			throw new Error(
				"loading modules needs createHost({ loader }), e.g. nodeLoader from @earendil-works/chord/old/node",
			);
		}
		const loaded = modules.length > 0 && this.#loader !== undefined ? await this.#loader(modules) : [];
		// shift() 从已加载数组头部取出与当前模块位置对应的 facet；非空断言 ! 表示 loader 契约保证数量足够。
		return plugins.map((ref) => (isFacet(ref) ? ref : loaded.shift()!));
	}

	// 把绑定了本次 serve 的函数和信号包装成 FacetApi；root/registry 只是转发到 host 的同名方法。
	facetApi(serve: Serve, signal: AbortSignal): FacetApi {
		return {
			serve,
			name: this.name,
			root: (fn, options) => this.root(fn, options),
			registry: (registry) => this.registry(registry),
			signal,
		};
	}

	/** The installed run of facet `name` is now `run` (or none): the run it replaces is aborted. */
	// 只在确实替换了不同控制器时中止旧运行；重复设置同一个 run 不会误伤自己。
	facetRunChanged(name: string, run: AbortController | undefined): void {
		const replaced = this.#facetRuns.get(name);
		if (run === undefined) this.#facetRuns.delete(name);
		else this.#facetRuns.set(name, run);
		if (replaced !== run) replaced?.abort(new ChordError("gone", `facet ${name} was replaced or removed`));
	}

	// 服务表写入前的最后检查：同名类型不能在同一版本重复提供；声明了 placement 的类型只能由匹配的 host 提供。
	serveInto(services: Map<string, Service>, service: Service): void {
		if (services.has(service.contract.name)) throw new Error(`${service.contract.name} is already served`);
		const placement = service.contract.description.host;
		// placedOn 处理 hostNamed/hostFamily 两类放置；不匹配是部署错误，用 TypeError 而非 ChordError。
		if (placement !== undefined && !placedOn(placement, this.name)) {
			throw new TypeError(
				`${service.contract.name} is declared for ${placementText(placement)}, but ${this.name} serves it`,
			);
		}
		services.set(service.contract.name, service);
	}

	// 为 host 生命周期类型创建宿主自己的引用：空输入、宿主 principal、owner "host"。
	// 先 acquire 再登记；激活失败只报告，不撤销服务（对象会在下一次引用/ready 时重试）。
	startHostObject(service: Service): RefCore {
		const ref = this.acquire(service.contract, {}, undefined, "host");
		this.hostObjects.set(service.contract.name, ref);
		ref.ready.catch((error: unknown) => this.report(error));
		return ref;
	}

	// ─── HostCore ───

	// HostCore 的实现：对象激活/调用时通过这些方法读取当前代码版本和 Service。
	currentCodeVersion(): number {
		return this.current.id;
	}

	// 只查 codeVersions（current/previous）。pending 不算“已保留给调用方”，但 retainedCodeVersions 会把它包括进去，
	// 让准备中的对象能把新实现同时登记到 pending。
	hasCodeVersion(codeVersion: number): boolean {
		return this.codeVersions.has(codeVersion);
	}

	// 生成器：每次 yield 一个 [版本号, 服务表] 对。调用方 for...of 可以惰性遍历，不必先构造数组。
	// 先列已保留版本，再把 pending（若有）放在最后，供对象激活时安装候选实现。
	*retainedCodeVersions(): Iterable<readonly [number, ReadonlyMap<string, Service>]> {
		for (const [id, state] of this.codeVersions) yield [id, state.services];
		if (this.pending !== undefined) yield [this.pending.id, this.pending.services];
	}

	pendingCodeVersion(): number | undefined {
		return this.pending?.id;
	}

	/** The current code for a type; a type a running reload adds is served from the pending code version. */
	// 先当前版本，再候选版本；旧版本中的类型只能通过显式的 implementations 表访问，不在这里回退。
	service(typeName: string): Service | undefined {
		return this.current.services.get(typeName) ?? this.pending?.services.get(typeName);
	}

	// 计算引用地址但不创建对象：远端类型先判断是否“在别处”，本地类型则规范化输入并拼地址。
	// candidate 为 true 时优先用重载 pending 的服务，使破坏性变更的消费者和提供方能在同一批准备。
	addressOf(type: AnyContract, input: unknown, principal: unknown, candidate = false): string {
		const elsewhere = this.#elsewhere(type, input);
		if (elsewhere !== undefined) return this.#remoteKey(type, elsewhere.input, principal);
		const service = this.#bindingService(type.name, candidate);
		if (service === undefined) throw unknownType(type.name, this.name);
		return this.#locate(service, input, principal).address;
	}

	/**
	 * Where an object of a remote type lives when that is another host: its name and the input normalized with the
	 * caller's contract (the placement is read from it). `undefined`: here (and every local type).
	 */
	// 只有 remote 且带 placement 的类型才可能“在别处”；本地类型永远由本 host 创建。
	// 归一化使用消费方契约的 input schema：默认值会被补齐、未知字段会被剥离，placement 读取的是归一化后的字段。
	#elsewhere(type: AnyContract, input: unknown): { readonly at: string; readonly input: unknown } | undefined {
		const placement = type.description.host;
		if (type.scope !== "remote" || placement === undefined) return undefined;
		const normalized = normalize(type.input, input, `${type.name} input`);
		const at = resolveHost(type.name, placement, normalized);
		return at === this.name ? undefined : { at, input: normalized };
	}

	/**
	 * The address of `input` for `principal`, normalized. A `lifetime: "host"` type has one object: the empty input, for
	 * the host principal, whoever asks; another input is invalid.
	 */
	// 地址格式为 name\0identity\0principalPart：三段用 NUL 分隔，避免名字/身份里出现分隔符造成歧义。
	// canonicalIdentity 省略等于默认值的字段，所以 {id:"a",opt:undefined} 与 {id:"a"} 得到同一地址。
	#locate(service: Service, input: unknown, principal: unknown) {
		const { name, input: schema } = service.contract;
		const normalized = normalize(schema, input, `${name} input`);
		const identity = canonicalIdentity(schema, normalized);
		if (hostLifetime(service)) {
			// 与“空输入规范化后再算身份”比较；不同 input 但身份等价（例如都省略默认字段）被视为同一空输入。
			if (identity !== canonicalIdentity(schema, normalize(schema, {}, `${name} input`)))
				throw invalid("input", `${name} has lifetime "host": its one object has the empty input`);
			// 无论调用者传什么 principal，host 生命周期对象都归宿主自身；忽略调用者的 principal 是有意行为。
			principal = this.principal;
		}
		return { address: `${name}\u0000${identity}\u0000${this.#principalPart(principal)}`, normalized, principal };
	}

	// 宿主自身 principal 统一记作 "host"，其余记作 "p:<key>"；这样 self 的不同写法不会生成不同地址。
	#principalPart(principal: unknown): string {
		return this.isSelf(principal) ? "host" : `p:${this.#principalKey(principal)}`;
	}

	/**
	 * The key of a remote binding: type, input identity (fields equal to their defaults omitted, as for local objects),
	 * principal key and the consumer's contract fingerprint. No host name: the type and the input decide where it lives.
	 */
	// 绑定 key 以 @ 开头以区别于本地对象地址；契约指纹参与 key，意味着同一远端对象在不同契约版本下会有不同绑定。
	// 目标 host 名不进 key：同一类型/输入/principal 的放置是确定的，重连后仍复用同一 binding。
	#remoteKey(type: AnyContract, normalized: unknown, principal: unknown): string {
		const identity = canonicalIdentity(type.input, normalized);
		return `@${type.name}\u0000${identity}\u0000${this.#principalPart(principal)}\u0000${type.fingerprint}`;
	}

	// 获取引用的统一入口：远端类型转到 #acquireRemote；本地类型找到/创建对象，再包一层 RefImpl。
	// owner 决定引用归谁释放（"external"、"object"、"host"、"client"、"connection"）；from 是实现该引用的对象，
	// 用于检测本 host 内的引用环；candidate 表示正在为重载准备绑定新契约。
	acquire(
		type: AnyContract,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
		from?: ObjectImpl,
		candidate = false,
	): RefCore {
		const elsewhere = this.#elsewhere(type, input);
		if (elsewhere !== undefined) return this.#acquireRemote(type, elsewhere.at, elsewhere.input, options, owner);
		const service = this.#bindingService(type.name, candidate);
		if (service === undefined) throw unknownType(type.name, this.name);
		// bind 把消费方契约与提供方契约做适配检查；不兼容时在这里抛 contract_mismatch/upgrade_required 等。
		bind(service.contract, service.options.accepts, type);
		// options?.principal 省略时落到宿主自身身份；#locate 会补齐默认输入并算出含 principal 的地址。
		const { address, normalized, principal } = this.#locate(service, input, options?.principal ?? this.principal);
		// The provider's own placement decides, never where a request says it is going (a client picks that).
		// 提供方声明的放置必须指向本 host；否则即使本 host 有同名服务，也不能创建该输入对应的对象。
		const placement = service.contract.description.host;
		if (placement !== undefined && resolveHost(type.name, placement, normalized) !== this.name) {
			throw invalid(
				"placement",
				`${type.name} with this input lives on ${resolveHost(type.name, placement, normalized)}, not ${this.name}`,
			);
		}
		let object = this.objects.get(address);
		// 从对象 A 获取引用 B 时，若 B 已存在且 B 可通过引用链到达 A（或 B 就是 A），则新增 A->B 会形成环；
		// 跨 host 的环不在此检测。
		if (from !== undefined && object !== undefined && (object === from || reaches(object, from))) {
			throw invalid("cycle", `${from.address} -> ${address} would create a ref cycle`);
		}
		if (object === undefined) {
			// gate 期间禁止创建变更类型的新对象，候选集才能保持有限；upgrade_conflict 标记为可重试。
			if (this.gating?.has(type.name)) {
				throw new ChordError("upgrade_conflict", `${type.name} is being upgraded; retry`, { reason: "gate" });
			}
			const dying = this.#dying.get(address);
			// 已彻底销毁的旧对象不再需要等待，清掉墓碑；仍在 disposing 的旧对象下面会作为 start 的前置 Promise。
			if (dying?.status === "disposed") this.#dying.delete(address);
			object = new ObjectImpl(this, {
				address,
				typeName: type.name,
				input: normalized,
				principal,
				hostLifetime: hostLifetime(service),
			});
			this.objects.set(address, object);
			// A new object for an address still being disposed waits for that cleanup (exclusive resources).
			// start 的 after 参数让激活先等待旧对象释放，避免两个对象同时占用同一个独占资源。
			object.start(dying?.status === "disposing" ? dying.dispose(false) : undefined);
		}
		// 引用是对象上的一个“视图”：同一对象可有多个 RefImpl，各自有 owner、状态监听和释放语义。
		const ref = new RefImpl(object, type, owner);
		object.addRef(ref);
		return ref;
	}

	// 对象开始销毁时从活动表移除；disposing 的对象进入 #dying，供同地址的新对象等待。
	// 比较 this.objects.get(...) === object，防止旧对象的清理误删同地址的新对象。
	forget(object: ObjectImpl): void {
		if (this.objects.get(object.address) === object) this.objects.delete(object.address);
		if (object.status === "disposing") this.#dying.set(object.address, object);
	}

	// 销毁完成时清除墓碑；同样做身份比较，避免误删后来者。
	disposed(object: ObjectImpl): void {
		if (this.#dying.get(object.address) === object) this.#dying.delete(object.address);
	}

	// 记录“这个根接触过这个对象”。根结束时按集合清租约；Set 去重，重复调用不会增加计数。
	touch(rootId: string, object: ObjectImpl): void {
		let touched = this.#touches.get(rootId);
		if (touched === undefined) {
			touched = new Set();
			this.#touches.set(rootId, touched);
		}
		touched.add(object);
	}

	// ─── roots ───

	// 本地根入口：生成唯一 rootId，把根标记为本地，再交给 joinRoot 执行和清理。
	async root<T>(fn: (ctx: Ctx) => T | Promise<T>, options: RootOptions = {}): Promise<T> {
		// The incarnation keeps root ids unique across restarts of a host with the same name.
		// 模板字符串包含 host 名、随机 incarnation 和自增序号；即使同名 host 重启，旧根 id 也不会撞上新根。
		const rootId = `${this.name}#${this.#incarnation}:${++this.#rootSeq}`;
		this.#local.add(rootId);
		// 默认当前代码版本；显式 codeVersion 让调用方在旧版本仍保留时继续使用旧代码。
		return this.joinRoot(rootId, options.codeVersion ?? this.current.id, fn, options);
	}

	/**
	 * Runs `fn` inside root `rootId` of `codeVersion`. A root counts as running here (for retirement) while any of its
	 * calls runs here. A root that started here ends when its last call here settles, even if it went out and came back
	 * over a link meanwhile. A foreign root (started elsewhere, arriving `from` a link) keeps its leases on objects
	 * until every link it came over announced its end (`root_end`) or closed, so its re-entry stays grandfathered.
	 */
	// 真正执行根的入口，本地 root 和连接收到的 call 都走这里。
	// 一个 rootId 可同时有多段调用在本地运行（嵌套/重入），roots 计数按段增减；最后一段结束时才结束根。
	async joinRoot<T>(
		rootId: string,
		codeVersionId: number,
		fn: (ctx: Ctx) => T | Promise<T>,
		options: { readonly principal?: unknown; readonly signal?: AbortSignal; readonly from?: Connection } = {},
	): Promise<T> {
		const codeVersion = this.codeVersions.get(codeVersionId);
		// 版本未保留（已退役或从未存在）时立即失败；本地根还要从未结束集合里移除。
		if (codeVersion === undefined) {
			this.#local.delete(rootId);
			throw new ChordError("superseded", `code version ${codeVersionId} is not retained by ${this.name}`);
		}
		// from 表示调用来自某条连接；只有“不是本 host 发起的根”才登记为外来根。
		// 同一外来根可经多条链路到达，因此用 Set 记录所有来源，全部结束后才释放租约。
		if (options.from !== undefined && !this.#local.has(rootId)) {
			let links = this.#foreign.get(rootId);
			if (links === undefined) {
				links = new Set();
				this.#foreign.set(rootId, links);
			}
			links.add(options.from);
		}
		codeVersion.roots.set(rootId, (codeVersion.roots.get(rootId) ?? 0) + 1);
		// CtxImpl 把调用方信号和代码版本退役信号合并；任一触发都会取消根内的异步操作。
		// 强制退役时先 abort codeVersion.abort，正是为了让旧版本的根在资源关闭前看到取消。
		const ctx = new CtxImpl(this, {
			// Forced retirement aborts what still runs on a code version before closing what only it used.
			signals:
				options.signal === undefined ? [codeVersion.abort.signal] : [options.signal, codeVersion.abort.signal],
			rootId,
			codeVersion: codeVersion.id,
			principal: options.principal ?? this.principal,
		});
		try {
			return await fn(ctx);
		} finally {
			// 无论成功、抛错还是取消，都关闭 ctx（释放其中 get 的引用）并递减本段计数。
			ctx.close();
			const count = (codeVersion.roots.get(rootId) ?? 1) - 1;
			if (count > 0) codeVersion.roots.set(rootId, count);
			else {
				codeVersion.roots.delete(rootId);
				// 外来根仍在等它经过的链接宣布结束，不能在这里直接 endRoot；本地根则立即结束。
				if (!this.#foreign.has(rootId)) this.endRoot(rootId);
				// 根结束可能让旧代码版本不再被使用，尝试退役；watcher 再通知等待重载的一方。
				this.maybeRetire();
				this.#retirementChanged();
			}
		}
	}

	/** Remembers that calls of `rootId` went out on `connection`, which must hear when the root ends. */
	// 连接层的 call() 在发送携带 root 的调用前调用；根结束时据此广播 root_end，让对端释放外来根的租约。
	rootSent(rootId: string, connection: Connection): void {
		let links = this.#rootLinks.get(rootId);
		if (links === undefined) {
			links = new Set();
			this.#rootLinks.set(rootId, links);
		}
		links.add(connection);
	}

	/** A root ended (here, or announced by its origin): end its leases and tell the links it went out on. */
	// 顺序：清本地/外来标记 -> 通知对象删除该根的租约 -> 向所有去过的链接发 root_end -> 清链接集合。
	// 即使连接已经关闭，send 也只是被 Link 丢弃；真正关闭的连接会从 #rootLinks 中移除（connectionClosed）。
	endRoot(rootId: string): void {
		this.#local.delete(rootId);
		this.#foreign.delete(rootId);
		for (const object of this.#touches.get(rootId) ?? []) object.rootEnded(rootId);
		this.#touches.delete(rootId);
		for (const connection of this.#rootLinks.get(rootId) ?? []) connection.send({ t: "root_end", rootId });
		this.#rootLinks.delete(rootId);
	}

	/**
	 * `from` announced the end of a foreign root (or closed). Honored only if the root came over `from`: a peer cannot
	 * end leases of roots it never carried. The root ends when no link that brought it remains.
	 */
	// 安全边界：只处理确实从 from 到达的外来根；未知 rootId 或没经过这条连接的 rootId 直接忽略。
	foreignRootEnded(rootId: string, from: Connection): void {
		const links = this.#foreign.get(rootId);
		// delete 返回 false 表示 from 不在来源集合中；仍有多条来源时不结束。
		if (links === undefined || !links.delete(from) || links.size > 0) return;
		// 本地可能仍有该根的在途调用；若有，删除 #foreign 标记（不再接受该根的新外来消息），
		// 租约在最后一段 joinRoot 结束时由 endRoot 收尾。
		const running = [...this.codeVersions.values()].some((codeVersion) => codeVersion.roots.has(rootId));
		// Still running here (a call in flight): the lease ends when it settles.
		if (running) this.#foreign.delete(rootId);
		else this.endRoot(rootId);
	}

	/**
	 * Retires the previous code version once no local roots of it remain. A child also waits for its parent to retire
	 * it: roots span hosts, and an old root on the server may still call in.
	 */
	// 便利入口：条件满足时立即退役；重载等待逻辑会反复调用 retirable，而不是反复调用 maybeRetire。
	maybeRetire(): void {
		if (this.retirable()) this.retire();
	}

	/** The previous code version has no roots left here and, on a child host, the parent has retired it. */
	// 三个条件：已存在 previous、previous 没有本地在途根、以及（若为子 host）父 host 已允许该版本退役。
	// client 不参与代码版本协调；没有 upstream 的独立 host 也不需要父许可。
	retirable(): boolean {
		const previous = this.previous;
		if (previous === undefined || previous.roots.size > 0) return false;
		return this.kind === "client" || this.upstream === undefined || previous.id <= this.#retireAllowed;
	}

	// 父 host 的 retire 帧到达时调用；只增不减，防止乱序帧把许可回退。
	allowRetire(codeVersion: number): void {
		this.#retireAllowed = Math.max(this.#retireAllowed, codeVersion);
		this.maybeRetire();
		this.#retirementChanged();
	}

	/** Calls `watcher` whenever a root ends, the parent allows a retirement, or a code version retires. */
	// 返回取消函数（thunk），调用方在等待结束后必须执行，避免 watcher 集合泄漏。
	watchRetirement(watcher: () => void): () => void {
		this.#retirementWatchers.add(watcher);
		return () => this.#retirementWatchers.delete(watcher);
	}

	// 复制一份再遍历：watcher 可能在回调中取消订阅，直接遍历原 Set 会改变迭代行为。
	#retirementChanged(): void {
		for (const watcher of [...this.#retirementWatchers]) watcher();
	}

	/**
	 * Tells a child that is now in step which code versions this host retired before: every id below the oldest one it
	 * retains (ids only grow). Without it, a child reconciled after those retirements would never hear a `retire` frame for
	 * its own previous code version and would wait for the retire deadline at every reload.
	 */
	// 只发一个“已退役到某版本”的帧：id 单调递增，所以告知比保留的最旧版本小一即可覆盖此前所有退役。
	// 例如 current.id=5 且没有 previous，说明 1..4 都已退役。
	announceRetired(connection: Connection): void {
		const retired = (this.previous ?? this.current).id - 1;
		if (retired > 0) connection.send({ t: "retire", codeVersion: retired });
	}

	/** Drops the previous code version: its implementations and the declarations only it used. */
	// 退役不等待异步清理：retireImplementation 内部启动关闭/释放并通过 onError 报告失败。
	// 必须先把 previous 置空并从 codeVersions 删除，后续递归调用才不会再看到它。
	retire(): void {
		const previous = this.previous;
		if (previous === undefined) return;
		this.previous = undefined;
		this.codeVersions.delete(previous.id);
		for (const object of [...this.objects.values()]) this.retireImplementation(object, previous.id);
		// 只通知 downstream 的 host 子连接；client 不参与代码版本，upstream 由父 host 自己管理。
		for (const connection of this.connections) {
			if (connection.role === "downstream" && connection.peer?.kind === "host")
				connection.send({ t: "retire", codeVersion: previous.id });
		}
		this.#retirementChanged();
	}

	/**
	 * Drops an object's implementation for `codeVersion` and what only that implementation declared, in disposal order:
	 * resources close (reverse open order) before its references are released.
	 */
	// 退役一个实现时只清理“其他保留声明不再使用”的资源/引用/派生，避免误关共享资源。
	// 若该实现就是对象当前的 decls（仍在使用），直接返回，不能清掉。
	retireImplementation(object: ObjectImpl, codeVersion: number): void {
		const installed = object.implementations.get(codeVersion);
		object.implementations.delete(codeVersion);
		if (installed === undefined || installed.decls === object.decls) return;
		// allDecls 汇总 current、pending 和各保留实现；keep 把每个声明集里的同类项摊平成 Set。
		// 泛型 <T>(pick: (decls: Decls) => Iterable<T>) 让 refs/resources/derives 复用同一段收集逻辑。
		const kept = object.allDecls();
		const keep = <T>(pick: (decls: Decls) => Iterable<T>): Set<T> =>
			new Set([...kept].flatMap((decls) => [...pick(decls)]));
		const refs = keep((decls) => decls.refs.values());
		const resources = keep((decls) => decls.resources.values());
		const derives = keep((decls) => decls.derives.values());
		// 只 detach 已不被任何保留声明使用的派生；仍被新代码使用的派生必须继续存在。
		for (const derived of installed.decls.derives.values()) if (!derives.has(derived)) derived.detach();
		// 资源按 openOrder 逆序关闭（依赖先关），索引比较实现倒序。
		const closing = [...installed.decls.resources.values()]
			.filter((resource) => !resources.has(resource))
			.sort((a, b) => object.openOrder.indexOf(b) - object.openOrder.indexOf(a));
		const releasing = [...installed.decls.refs.values()].filter((ref) => !refs.has(ref));
		// 先刷新 schema，确保状态成员不再引用即将清理的实现。
		object.refreshSchemas();
		// runAll 并行执行所有关闭/释放并聚合错误；这里不 await，后台失败走 report。
		runAll(
			[
				...closing.map((resource) => () => resource.close(object.openOrder)),
				...releasing.map((ref) => () => ref.release()),
			],
			`${object.address}: retiring code version ${codeVersion} failed`,
		).catch((error: unknown) => this.report(error));
	}

	// ─── registries ───

	// 返回一个普通对象视图；它不持有表快照，每次 table()/get() 都按代码版本现查。
	// ctx 省略时读当前版本；给出 ctx 时读取其 codeVersion 对应的表，旧版本退役后抛 superseded。
	registry<V>(registry: Registry<V>): RegistryView<V> {
		const table = (ctx?: Ctx): RegistryTable<V> => {
			const codeVersion = ctx === undefined ? this.current : this.codeVersions.get(ctx.codeVersion);
			if (codeVersion === undefined)
				throw new ChordError("superseded", `code version ${ctx?.codeVersion} is retired`);
			// 未注册过该 registry 的版本回退到共享空表；断言把 never 表转为 V 表，空表没有值可读。
			return (codeVersion.tables.get(registry.name) ?? EMPTY_TABLE) as RegistryTable<V>;
		};
		return {
			table,
			get: (key, ctx) => table(ctx).get(key),
			subscribe: (listener) => {
				let set = this.#subscribers.get(registry.name);
				if (set === undefined) {
					set = new Set();
					this.#subscribers.set(registry.name, set);
				}
				// 内部订阅者统一以 unknown 表保存；这里用断言擦掉 V，回调时再通过闭包的类型承诺还原。
				const wrapped = listener as (table: RegistryTable<unknown>, codeVersion: number) => void;
				set.add(wrapped);
				// 订阅立即收到当前表（同步调用，不经发布队列）；后续变化才经 enqueue 异步发送。
				wrapped(table(), this.current.id);
				return () => set.delete(wrapped);
			},
		};
	}

	/** Builds registry tables from (object, declarations) pairs. Throws registry_conflict. */
	// 纯构建：不修改 host 的当前表，只返回新表；调用方决定安装到哪个代码版本。
	// 冲突规则由 registry.conflict 决定：默认 "error" 时不同对象注册同一 key 会抛 invalid/registry_conflict；
	// 同一对象重复注册同一 key 则允许后者覆盖（重载准备时常见）。
	buildTables(entries: Iterable<readonly [ObjectImpl, Decls]>): Map<string, RegistryTable<unknown>> {
		const byRegistry = new Map<string, Map<string, { value: unknown; object: ObjectImpl }>>();
		for (const [object, decls] of entries) {
			for (const { registry, key, value } of decls.registrations.values()) {
				let entries = byRegistry.get(registry.name);
				if (entries === undefined) {
					entries = new Map();
					byRegistry.set(registry.name, entries);
				}
				const existing = entries.get(key);
				if (existing !== undefined && existing.object !== object && registry.conflict === "error") {
					throw invalid(
						"registry_conflict",
						`${registry.name}: ${key} registered by ${existing.object.address} and ${object.address}`,
					);
				}
				entries.set(key, { value, object });
				// 首次出现的 key 分配一个全局递增序号；之后无论重载多少次，顺序序号都保留。
				let order = this.#order.get(registry.name);
				if (order === undefined) {
					order = new Map();
					this.#order.set(registry.name, order);
				}
				if (!order.has(key)) order.set(key, order.size);
			}
		}
		const tables = new Map<string, RegistryTable<unknown>>();
		for (const [name, entries] of byRegistry) {
			const order = this.#order.get(name)!;
			// 按首次注册顺序排序，而不是按对象遍历顺序；这使重载后的表顺序稳定。
			const sorted = [...entries].sort(([a], [b]) => order.get(a)! - order.get(b)!);
			tables.set(name, new Map(sorted.map(([key, entry]) => [key, entry.value])));
		}
		return tables;
	}

	/**
	 * The service a reference binds against: the current one, or for a prepare rerun (`candidate`) the running reload's
	 * pending one, so consumer and provider of a breaking change can reload in one batch.
	 */
	// 准备重载时，消费者可能要先绑定到候选服务；candidate=false 时只看当前/候选的回退链，不读旧版本。
	#bindingService(typeName: string, candidate: boolean): Service | undefined {
		return (candidate ? this.pending?.services.get(typeName) : undefined) ?? this.service(typeName);
	}

	/** Live objects with their current declarations; objects waiting for a reload's commit only with `candidates`. */
	// deferredRuntime 的对象只由候选代码提供，运行时（监听/任务/注册）要等提交后才启动；默认不参与当前注册表构建。
	// 返回 tuple 数组而不是对象，方便 buildTables/entries 直接解构。
	liveDecls(candidates = false): [ObjectImpl, Decls][] {
		return [...this.objects.values()]
			.filter((object) => object.status === "live" && (candidates || !object.deferredRuntime))
			.map((object) => [object, object.decls]);
	}

	// 对象完成激活、安装注册前先试建表：若与现有 live 对象冲突，激活失败且不会留下半安装的注册。
	// 排除对象自身，避免它已存在于活动表时被重复计算。
	checkRegistrations(object: ObjectImpl, decls: Decls): void {
		if (decls.registrations.size === 0) return;
		this.buildTables([...this.liveDecls().filter(([other]) => other !== object), [object, decls]]);
	}

	// 某个对象的注册声明变化（激活/销毁/重载提交）后重建当前表并发布。
	// including 对象可能已从 liveDecls 中消失，因此单独用它的最新 decls 补回，确保这次变化被计算进去。
	registriesChanged(including?: ObjectImpl): void {
		const entries = this.liveDecls().filter(([object]) => object !== including);
		if (including !== undefined) entries.push([including, including.decls]);
		this.installTables(this.current, this.buildTables(entries));
	}

	/** A commit failed midway: from now on this host admits no work (calls fail `unavailable/host_failed`). */
	// ??= 只在 failed 仍为 undefined 时赋值：保留第一个根因，后续错误只报告不覆盖。
	fail(error: unknown): void {
		this.failed ??= error;
		this.report(error);
	}

	/** Installs tables for `codeVersion`; subscribers hear about changed tables of the current code version (all tables when `all`). */
	// 先整体替换该版本的 tables 引用，旧表保持不变，仍持有旧表的读取方不会看到半新半旧。
	// 只有当前版本的变化通知订阅者；pending/previous 的表变化不对外实时发布。
	installTables(codeVersion: CodeVersionState, tables: Map<string, RegistryTable<unknown>>, all = false): void {
		const before = codeVersion.tables;
		codeVersion.tables = tables;
		if (codeVersion !== this.current) return;
		for (const [name, listeners] of this.#subscribers) {
			const next = tables.get(name) ?? EMPTY_TABLE;
			// sameTable 比较 key 顺序和值引用；未变化时跳过，all=true 时（重载安装）即使相同也通知。
			if (!all && sameTable(before.get(name) ?? EMPTY_TABLE, next)) continue;
			// 复制监听者数组，避免发布排队期间有人取消订阅导致本次漏发或迭代变化。
			const current = [...listeners];
			// 通过发布队列异步通知，保证与其他状态/形状通知的相对顺序；单个监听者抛错只报告，不中断其余。
			enqueue(() => {
				for (const listener of current) {
					try {
						listener(next, codeVersion.id);
					} catch (error) {
						this.report(error);
					}
				}
			});
		}
	}

	// ─── public API ───

	// 公共获取：创建外部持有的引用，等待就绪后返回代理。等待期间若失败，引用已被 ObjectImpl 标记 gone，调用方拿不到。
	// options 同时包含 principal/state 和 signal；awaitReady 会合并这些信号并在超时后抛 unavailable/ready_timeout。
	async get<C extends AnyContract>(
		type: C,
		input: InputOf<C>,
		options?: GetOptions & { readonly signal?: AbortSignal },
	): Promise<Ref<C>> {
		const ref = this.acquire(type, input, options, "external");
		await awaitReady(ref, options?.signal === undefined ? [] : [options.signal], this.readyTimeout);
		// 类型断言把内部 RefCore 的泛型代理还原成 Ref<C>；运行时对象由 RefImpl 的 Proxy 提供成员。
		return ref.proxy as Ref<C>;
	}

	// 同步版本：不等待就绪，错误（未知类型、契约不匹配）仍同步抛出；引用本身可能在 loading。
	// 调用方必须保存并最终 release()，否则对象会一直被外部引用持有。
	hold<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions): Ref<C> {
		return this.acquire(type, input, options, "external").proxy as Ref<C>;
	}

	// 使匹配 principal 的对象和连接失效。函数谓词只作用于本 host；模式作为数据可跨连接传播。
	// 匹配 host 自身 principal 的对象被排除：宿主自己的对象不能通过这个 API 被清掉。
	async invalidatePrincipal(match: PrincipalMatch): Promise<void> {
		// typeof 收窄联合：函数就用函数，模式则包装成逐字段 deepEqual 的谓词；之后统一调用 matches。
		const matches = typeof match === "function" ? match : (principal: unknown) => matchesPattern(match, principal);
		const reason = new ChordError("gone", "principal invalidated");
		// Links acting as a matching principal are re-stamped (if the acceptor can) or closed.
		// 复制 connections 再遍历：revoke 可能同步关闭连接并从原集合删除元素。
		for (const connection of [...this.connections]) {
			if (connection.role !== "downstream" || !matches(connection.principal)) continue;
			// Relays under the old principal close at once, including those still resolving their route.
			// restamp 返回新 principal 则保留链路，返回 undefined 则关闭；generation 递增使旧 relay 立刻失效。
			connection.revoke(connection.restamp?.(connection.principal));
		}
		// Patterns propagate to child hosts, which dispose their own matching objects (e.g. relayed guests).
		// 只向 host 子连接转发；client 没有自己的对象需要清理。谓词无法序列化，故只在本 host 执行。
		if (typeof match !== "function") {
			for (const connection of this.connections) {
				if (connection.role === "downstream" && connection.peer.kind === "host") {
					connection.send({ t: "invalidate", pattern: match });
				}
			}
		}
		const matching = [...this.objects.values()].filter(
			(object) => !this.isSelf(object.principal) && matches(object.principal),
		);
		// 按“持有者先于被引用者”的波次强制释放，等待全部清理；错误聚合后抛出。
		await disposeHoldersFirst(matching, reason, "invalidatePrincipal: disposal failed");
	}

	// ─── links ───

	// 接收子连接。peer 的 kind/name 是本端决定的策略，对方 hello 必须匹配；默认按 client（浏览器/worker）处理。
	accept(link: Link, options: AcceptOptions): void {
		const kind = options.kind ?? "client";
		// host 子连接必须能从本端按名字路由到，因此 name 是必填；缺失视为调用方配置错误。
		if (kind === "host" && options.name === undefined) throw new TypeError("accepting a host link needs its name");
		this.#addConnection(link, {
			...options,
			role: "downstream",
			principal: options.principal,
			peer: { kind, name: kind === "host" ? options.name : undefined },
			// Holds over a client link carry its id as their origin (also when relayed), so hosts can tell clients apart.
			// 每个 client 连接生成稳定 origin id；relay 转发 hold 时带上它，提供方据此区分不同浏览器引用。
			...(kind === "client" ? { originId: `${this.#incarnation}:${++this.#originSeq}` } : {}),
		});
	}

	// 连接父 host。重连时先关闭旧 upstream link，再建立新连接；旧绑定不携带值重新 hold。
	connect(link: Link, options: ConnectOptions): void {
		// 运行时兜底：未类型化调用可能漏掉 principal，而它决定父 host 自身请求以谁的身份执行。
		if (!("principal" in options))
			throw new TypeError("connect needs `principal`: what the parent's own requests act as");
		// 只在旧连接仍打开时关闭；已关闭的连接无需再次发送 bye。
		if (this.upstream?.open) this.upstream.link.close("replaced");
		const connection = this.#addConnection(link, {
			...options,
			role: "upstream",
			principal: options.principal,
			peer: { kind: "host", name: undefined },
		});
		this.upstream = connection;
		// Bindings that lost their link re-hold over the new one (`again`: they keep their values meanwhile).
		// 只重新 hold 没有当前 hold 且未结束的绑定；again=applied 表示已有形状值，首帧按再水合处理而非紧急单元。
		for (const binding of this.bindings.values())
			if (binding.hold === undefined && !binding.ended) connection.hold(binding, binding.applied);
	}

	// Connection 构造会立即发送 hello 并注册接收器；若 link 已经关闭，构造函数内会同步触发 closed，
	// 此时不能把连接加入活动集合，否则后续路由会一直选中一条死连接。
	#addConnection(link: Link, config: ConstructorParameters<typeof Connection>[2]): Connection {
		const connection = new Connection(this, link, config);
		// A link that was already closed closed the connection in its constructor: keeping it would route to it forever.
		if (connection.open) this.connections.add(connection);
		return connection;
	}

	// 路由按前缀注册；运行时检查 principal 回调，因为反向调用身份是协议必需信息。
	route(prefix: string, route: Route): void {
		if (typeof route.principal !== "function")
			throw new TypeError(`route ${prefix} needs \`principal\`: what the routed hosts act as when they call back`);
		this.#routes.set(prefix, route);
	}

	/**
	 * A child host announced its code version. In step: usable. Behind: fenced (nothing is routed to it) and reconciled
	 * by a reload of its modules to this host's code version, never by renumbering what it runs. Ahead: impossible,
	 * refused.
	 */
	// 子 host 的 hello 处理：按代码版本决定“同步、围栏后协调、延迟决定”。
	// 父 host 绝不能把子 host 的版本号改成自己的：旧代码仍在子 host 上运行，重标号会让调用错误地落到新实现。
	peerHello(connection: Connection, codeVersion: number): void {
		// 子 host 不可能领先父 host（代码由父 host 协调）；这是协议违规，报告并关闭链路。
		if (codeVersion > this.current.id) {
			this.report(
				new ChordError(
					"invalid",
					`${connection.name} runs code version ${codeVersion}, ahead of ${this.current.id}`,
				),
			);
			connection.link.close("code version ahead of parent");
			return;
		}
		if (this.reloading) {
			// Not a participant of the running reload (participants are fixed when it starts): in step now, it would miss
			// the commit. Decided when the reload ends. A child already behind is fenced now, so the calls its roots make
			// meanwhile are admitted in this host's code version (never relabeled) instead of being `superseded`.
			// 记录 peerCodeVersion 并把旧版本加入 fenced，连接层 #admitRoot 会把落后根临时按当前版本接纳。
			connection.peerCodeVersion = codeVersion;
			if (codeVersion < this.current.id) connection.fencedCodeVersions.add(codeVersion);
			this.#deferredHellos.set(connection, codeVersion);
			return;
		}
		// 版本一致：连接可用，并告诉子 host 父 host 已退役到哪个版本，避免它永远等待 retire 帧。
		if (codeVersion === this.current.id) {
			connection.markSynced(codeVersion);
			this.announceRetired(connection);
			return;
		}
		// 落后：先围栏（不把新调用路由给它），再异步重载它的模块到当前版本；失败则关闭链路。
		connection.peerCodeVersion = codeVersion;
		connection.fencedCodeVersions.add(codeVersion);
		reconcileChild(this, connection).catch((error: unknown) => {
			this.report(error);
			connection.link.close("reconciliation failed");
		});
	}

	/** The host's reload slot was freed: children that said hello meanwhile are synced or reconciled now. */
	// 先复位 reloading，否则 peerHello 会再次把它当作“重载中”而继续延后。
	// 延后的 hello 按最新连接状态逐个重放；随后唤醒 whenReloadEnded 等待者，并检查是否可退役。
	reloadEnded(): void {
		this.reloading = false;
		const deferred = [...this.#deferredHellos];
		this.#deferredHellos.clear();
		for (const [connection, codeVersion] of deferred) if (connection.open) this.peerHello(connection, codeVersion);
		for (const resolve of this.#reloadWaiters.splice(0)) resolve();
		this.maybeRetire();
	}

	/** Resolves once no reload runs on this host. */
	// 没有重载时返回已完成的 Promise，避免调用方额外调度；有重载则登记一个一次性的 resolve。
	whenReloadEnded(): Promise<void> {
		if (!this.reloading) return Promise.resolve();
		return new Promise((resolve) => this.#reloadWaiters.push(resolve));
	}

	// 连接关闭的统一清理：从活动集合、延后 hello、外来根来源和根的去向链接中移除。
	// 遗漏任意一项都会让已死链路继续参与路由或阻止根结束。
	connectionClosed(connection: Connection): void {
		this.connections.delete(connection);
		this.#deferredHellos.delete(connection);
		// Foreign roots that came over this link will never announce their end over it.
		// 复制 #foreign 再遍历，因为 foreignRootEnded 可能同步删除条目。
		for (const [rootId, links] of [...this.#foreign])
			if (links.has(connection)) this.foreignRootEnded(rootId, connection);
		for (const links of this.#rootLinks.values()) links.delete(connection);
		// upstream 断开不等于 host 关闭：绑定进入 detached，等 connect 重连后重新 hold；子重载协调器也要知道父丢失。
		if (this.upstream === connection) {
			this.upstream = undefined;
			this.#childReloads.parentLost();
		}
	}

	/** The last reference to `binding` was released: it lingers if its type does (`HostOptions.linger`), else closes. */
	// 最后一个 view 释放后，由 RemoteBinding 调用。按类型配置决定立刻关闭还是保留一段时间。
	// 保留的前提：已应用过形状（有值值得复用）、绑定未结束、cap 允许；从未有过形状的绑定保留没有收益。
	bindingIdle(binding: RemoteBinding): void {
		// hasOwn 区分“类型列了 0”与“类型没列出”；未列出的类型默认 0，立即关闭。
		const ms = Object.hasOwn(this.#lingerTypes, binding.contract.name)
			? this.#lingerTypes[binding.contract.name]!
			: 0;
		// A binding that never had a shape has nothing worth keeping.
		if (ms <= 0 || binding.ended || !binding.applied || this.#lingerCap <= 0) {
			binding.close();
			return;
		}
		// 定时器 unref，避免一个仅因 linger 而存活的绑定阻止 Node 进程退出。
		binding.lingerTimer = setTimeout(() => binding.close(), ms);
		(binding.lingerTimer as { unref?: () => void }).unref?.();
		this.#lingering.set(binding.key, binding);
		// 插入顺序从旧到新；超过 cap 时从最旧的开始关闭，直到数量回到上限。
		for (const oldest of this.#lingering.values()) {
			if (this.#lingering.size <= this.#lingerCap) break;
			oldest.close();
		}
	}

	// 绑定真正结束/关闭时由 RemoteBinding 回调；身份比较防止误删同 key 的新绑定。
	forgetBinding(binding: RemoteBinding): void {
		if (this.bindings.get(binding.key) === binding) this.bindings.delete(binding.key);
		if (this.#lingering.get(binding.key) === binding) this.#lingering.delete(binding.key);
	}

	/** A downstream host connection by its configured name (never by what a peer announced). */
	// 只信本端 accept 时配置的 peer.name，不信任对方 hello 自称的名字；因此不会被恶意 peer 冒充其他子 host 路由。
	#childNamed(name: string): Connection | undefined {
		return [...this.connections].find(
			(connection) =>
				connection.open &&
				connection.role === "downstream" &&
				connection.peer.kind === "host" &&
				connection.peer.name === name,
		);
	}

	/**
	 * A reference to an object on host `at`: a view onto the binding for its key, created (and held) if there is none.
	 * `input` is normalized with `type` (the hold carries it so).
	 */
	// 远端引用的创建：先找共享绑定，再给当前调用方建一个 view。principal 是 self 或省略时传 undefined，
	// 表示“使用本 host 自身身份”，帧里不携带 principal 字段；非 self principal 会加入 key 并随 hold 发送。
	#acquireRemote(
		type: AnyContract,
		at: string,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
	): RefCore {
		const principal =
			options?.principal === undefined || this.isSelf(options.principal) ? undefined : options.principal;
		// key 仍要传具体 principal 给 #remoteKey；undefined 时回落到宿主自身。
		const key = this.#remoteKey(type, input, principal ?? this.principal);
		let binding = this.bindings.get(key);
		// 已结束的绑定不能复用，否则新引用会立刻继承 gone 状态；最后一段结束时创建新绑定。
		const fresh = binding === undefined || binding.ended;
		if (binding === undefined || binding.ended) {
			binding = new RemoteBinding(this, { key, contract: type, at, input, principal });
			this.bindings.set(key, binding);
		}
		// state:false 的 view 不要求状态；若同一绑定还有其他 view 要状态，绑定整体仍会订阅。
		const ref = new RemoteRef(binding, owner, options?.state !== false);
		// 新 view 复用绑定后，从 linger 集合移除，避免定时器把它关闭。
		this.#lingering.delete(key);
		binding.addView(ref);
		// 只有新建绑定才需要向链路发 hold；已有绑定已在链路注册过。
		if (fresh) this.#hold(binding);
		return ref;
	}

	/** Holds `binding` over the link to its host: the parent's, a child's, or one a route resolves. */
	// 选择链路优先级：upstream（父 host）> 直接子 host（按配置名）> 路由解析。
	// 任何异步解析失败都让 binding.gone，使所有 view 收到终止原因，而不是永远 loading。
	#hold(binding: RemoteBinding): void {
		const bindWhenSynced = (connection: Promise<Connection>): void => {
			connection.then(
				(target) => {
					// 解析期间绑定可能已关闭或已被重连重新 hold；两个条件都检查，避免重复 hold。
					if (!binding.ended && binding.hold === undefined) target.hold(binding, false);
				},
				(error: unknown) => binding.gone(error),
			);
		};
		const direct = this.#childNamed(binding.at);
		if (this.upstream !== undefined) this.upstream.hold(binding, false);
		else if (direct !== undefined) bindWhenSynced(direct.whenSynced().then(() => direct));
		else {
			const route = this.#routeFor(binding.at);
			if (route === undefined) binding.gone(new ChordError("unavailable", `no route to ${binding.at}`));
			else bindWhenSynced(this.#resolve(route, binding.at, binding.principal ?? this.principal));
		}
	}

	// 最长前缀匹配：同名前缀共存时，更具体（更长）的路由覆盖更短的路由。
	#routeFor(hostName: string): Route | undefined {
		let best: [string, Route] | undefined;
		for (const entry of this.#routes) {
			if (hostName.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry;
		}
		return best?.[1];
	}

	/** Authorize, resolve (maybe spawn) and admit the host, authorize again; returns the synced connection to the host. */
	// 授权、解析、再授权、等待 hello 同步。still 回调用于检查“发起该解析的 relay 是否仍有效”；
	// 每次 await 后重新检查，因为授权/撤销可能在这期间发生，不能让过期请求继续建立连接。
	async #resolve(
		route: Route,
		hostName: string,
		principal: unknown,
		still: () => boolean = () => true,
	): Promise<Connection> {
		const refuse = (): ChordError => new ChordError("forbidden", `${hostName} refused for this principal`);
		const revoked = (): ChordError => new ChordError("gone", "principal invalidated while resolving");
		if (!(await route.authorize(principal, hostName))) throw refuse();
		if (!still()) throw revoked();
		const link = await route.resolve(hostName);
		// Admitted before the checks: a host the route spawned for a request that is gone or refused meanwhile still runs,
		// and its own references to this host would otherwise wait on a link nobody reads until they time out.
		// 先找同一 link 的既有连接，避免重复包装；否则创建 downstream 连接，principal 用路由声明的反向身份。
		let connection = [...this.connections].find((candidate) => candidate.link === link);
		connection ??= this.#addConnection(link, {
			role: "downstream",
			principal: route.principal(hostName),
			peer: { kind: "host", name: hostName },
		});
		if (!still()) throw revoked();
		// 第二次授权：解析/建连可能耗时，期间权限可能被收回。
		if (!(await route.authorize(principal, hostName))) throw refuse();
		if (!still()) throw revoked();
		// 等待子 host 的 hello 使连接 synced；未同步的连接上的 hold 会排队，不能直接用于转发。
		await connection.whenSynced();
		if (!still()) throw revoked();
		return connection;
	}

	/**
	 * Relays a reference from `relay.origin` to the host it names. Relaying needs a route: it is where authorization
	 * lives. The origin's authorization generation is re-checked after every await and right before forwarding, so a
	 * revocation during resolution wins.
	 */
	// relay 只存在于有路由的中心 host：origin 把 hold 发给本 host，本 host 解析目标 host 并转发。
	// 先验证契约令牌声明的 placement 与帧里的 at 一致，防止一个请求借路由访问错误 host。
	async relay(relay: RelayRef): Promise<void> {
		const at = relay.frame.at;
		// The hold names its target; its contract token says where the type lives. They must agree.
		// contractFromDescription 从 wire 描述重建令牌；它不实例化对象，只恢复名称、版本、schema 和 placement。
		const placement = contractFromDescription(relay.frame.token).description.host;
		if (placement === undefined || resolveHost(relay.frame.token.name, placement, relay.frame.input) !== at)
			throw invalid("placement", `${relay.frame.token.name} with this input does not live on ${at}`);
		const route = this.#routeFor(at);
		if (route === undefined) {
			// 没有路由时区分两种错误：目标根本不是已连接子 host -> unavailable；是子 host 但没有路由授权 -> forbidden。
			throw this.#childNamed(at) === undefined
				? new ChordError("unavailable", `no route to ${at}`)
				: new ChordError("forbidden", `no route authorizes ${at}`);
		}
		// still 绑定当前 relay 的授权代次；解析途中 origin 撤销，本函数会抛 gone 或直接返回不打开。
		const down = await this.#resolve(route, at, relay.principal, () => relay.current);
		if (!relay.current) return;
		relay.open(down);
	}

	// 重载分派：只有服务端/独立 host 可以发起；有 host 子连接或显式 remote 配置时走集群协议，否则本地事务。
	reload(plugins: readonly PluginRef[], options: ReloadOptions = {}): Promise<ReloadReport> {
		// Client-local facet code versions never cross the parent link; only child hosts require cluster coordination.
		// 子 host 的重载必须由服务端发起，否则各端版本会分叉；这里用 rejected Promise 而不是同步 throw。
		if (this.kind !== "client" && this.upstream !== undefined) {
			return Promise.reject(
				new ChordError("unavailable", "reloads are coordinated by the server", { reason: "not_coordinator" }),
			);
		}
		const children = [...this.connections].some(
			(connection) => connection.role === "downstream" && connection.peer.kind === "host",
		);
		// 包含 host 子连接、或要求更新子 host 模块时，必须走 prepare/vote/commit/abort 的集群事务。
		return children || options.remote !== undefined || options.remoteRemove !== undefined
			? runClusterReload(this, plugins, options)
			: runReload(this, plugins, options);
	}

	// 只有 upstream 连接能投递重载控制帧（connection.ts 已检查 role）；这里转交给子重载协调器。
	onReloadFrame(connection: Connection, frame: Extract<Frame, { t: "prepare" | "commit" | "abort" }>): void {
		this.#childReloads.handle(connection, frame);
	}

	// 集群提交后更新“前缀 -> 子模块清单”。remote 和 remove 可能同时出现：先合并新模块，去掉被移除项；
	// 墓碑则相反，保留被移除项，去掉后来重新加入的项。两个集合都去重，避免重载多次后无限增长。
	rememberRemoteModules(
		remote: Readonly<Record<string, readonly string[]>> | undefined,
		remove: Readonly<Record<string, readonly string[]>> | undefined,
	): void {
		// 两个记录的键取并集；同一前缀可能只出现在一边。
		for (const prefix of new Set([...Object.keys(remote ?? {}), ...Object.keys(remove ?? {})])) {
			const modules = remote?.[prefix] ?? [];
			const removed = remove?.[prefix] ?? [];
			this.remoteModules[prefix] = [...new Set([...(this.remoteModules[prefix] ?? []), ...modules])].filter(
				(module) => !removed.includes(module),
			);
			this.remoteRemoved[prefix] = [...new Set([...(this.remoteRemoved[prefix] ?? []), ...removed])].filter(
				(module) => !modules.includes(module),
			);
		}
	}

	/** The code version id the next reload would commit. */
	// 不分配、不修改序号，只预测；协调服务器用它在下发 commit 前确定版本号。
	peekNextCodeVersion(): number {
		return this.#codeVersionSeq + 1;
	}

	/**
	 * Disposes every object, holders before what they reference (a resource's `close` may still use the objects its object
	 * references, local or remote), then closes the links.
	 */
	// 关闭顺序不可随意调整：先结束 linger 绑定和 facet 运行信号，再释放对象（资源 close 可能还需要远端引用），
	// 最后才关闭链路。对象释放期间的错误由 disposeHoldersFirst 汇总抛出，但 finally 仍保证链路关闭。
	async close(): Promise<void> {
		for (const binding of [...this.#lingering.values()]) binding.close();
		this.hostObjects.clear();
		for (const name of [...this.#facetRuns.keys()]) this.facetRunChanged(name, undefined);
		const reason = new ChordError("gone", `host ${this.name} closed`);
		try {
			await disposeHoldersFirst([...this.objects.values()], reason, "host close: disposal failed");
		} finally {
			for (const connection of [...this.connections]) connection.link.close("host closed");
		}
	}
}

/**
 * Force-disposes `objects` in waves: an object goes once no object of the set that references it is left, so holders are
 * disposed (and their resources closed) while what they reference is still live. In-host references are acyclic. Errors of
 * every disposal are collected.
 */
// 参数：objects 是待强制释放的本地对象（调用方已筛好，通常属于同一个 principal 或整个 host）；
// reason 是传给每个对象 dispose 的 ChordError；message 只在多个错误时作为 AggregateError 的说明。
// 返回 Promise<void>；单个错误原样抛出，多个错误包装成 AggregateError。副作用是逐个对象执行 dispose(true)。
// 示例：holder 引用了 resource，disposeHoldersFirst([holder, resource], err, "close failed") 会先释放 holder，
// 再释放 resource，因为第一轮里 holder 没有被 remaining 中的任何对象引用。
async function disposeHoldersFirst(objects: readonly ObjectImpl[], reason: unknown, message: string): Promise<void> {
	// remaining 保存本轮尚未释放的对象；每轮从中取出一批“没人引用”的对象。
	const remaining = new Set(objects);
	// 闭包 held：收集一个对象通过所有声明里的引用直接指向的本地对象；ref.object 为 undefined 表示远端引用。
	const held = (object: ObjectImpl): Set<ObjectImpl> => {
		const result = new Set<ObjectImpl>();
		for (const decls of object.allDecls()) {
			for (const ref of decls.refs.values()) if (ref.object !== undefined) result.add(ref.object);
		}
		return result;
	};
	// 预先对每个对象算好它引用的对象，`as const` 让每项推断为只读的 [key, value] 元组，供 Map 构造。
	const refs = new Map(objects.map((object) => [object, held(object)] as const));
	// 收集所有释放错误，留到最后统一抛出，避免一个对象失败阻断其余对象。
	const errors: unknown[] = [];
	while (remaining.size > 0) {
		// heldByRemaining：仍存活对象所引用的全部目标。被这些目标“压住”的对象必须等下一轮。
		const heldByRemaining = new Set<ObjectImpl>();
		for (const object of remaining) for (const target of refs.get(object) ?? []) heldByRemaining.add(target);
		// 本轮可释放的对象是 remaining 中不被任何 remaining 对象引用的那些，也就是当前的最外层持有者。
		let wave = [...remaining].filter((object) => !heldByRemaining.has(object));
		// A cycle cannot happen in-host; dispose the rest together rather than loop.
		// 同 host 内引用约定无环；若真出现环（或自引用），一次性释放剩余对象，避免 while 死循环。
		if (wave.length === 0) wave = [...remaining];
		for (const object of wave) remaining.delete(object);
		// 同一轮内并发释放；allSettled 不会因单个失败提前 reject，结果里逐项检查 status 收窄成败。
		const results = await Promise.allSettled(wave.map((object) => object.dispose(true, reason)));
		for (const result of results) if (result.status === "rejected") errors.push(result.reason);
	}
	// 单个错误保持原始错误类型（调用方常依赖 ChordError 的 code）；多个才聚合。
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

// 判断两个注册表是否“相同”：先比大小，再按 a 的 key 顺序逐个比对 b 的 key 与值引用。
// 值用 === 比较，因此表里同一 key 换成新数组/新函数也会被视为变化。仅用于 installTables 的发布去重。
// 示例：sameTable(new Map([["A", t]]), new Map([["A", t]])) === true；key 顺序不同则为 false。
function sameTable(a: RegistryTable<unknown>, b: RegistryTable<unknown>): boolean {
	if (a.size !== b.size) return false;
	// 先固化 a 的 key 顺序；下面的 every 按 b 的迭代顺序逐个与它对齐比较。
	const keys = [...a.keys()];
	return [...b].every(([key, value], index) => keys[index] === key && a.get(key) === value);
}

// principal 来自网络输入（信任边界），运行时必须确认它是对象后才能按字段匹配；
// pattern 的每个键值都必须与 principal 对应字段 deepEqual。示例：matchesPattern({ kind: "user" }, { kind: "user", id: 1 }) 为 true。
const matchesPattern = (pattern: Readonly<Record<string, unknown>>, principal: unknown): boolean =>
	principal !== null &&
	typeof principal === "object" &&
	Object.entries(pattern).every(([key, value]) => deepEqual((principal as Record<string, unknown>)[key], value));

// 统一的 unknown_type 错误工厂：状态 unavailable，附带 reason 供上层区分“类型未注册”与其他不可用原因。
// 示例：unknownType("Counter", "host-a") 生成 message "Counter is not served by host-a" 的 ChordError。
const unknownType = (type: string, host: string): ChordError =>
	new ChordError("unavailable", `${type} is not served by ${host}`, { reason: "unknown_type" });

/** True if `from` references `to`, directly or transitively, through object-owned references on this host. */
// 用显式栈做深度优先搜索，避免递归在长引用链上爆栈；seen 防止重复访问。
// 只沿本地引用（ref.object 存在）走，跨 host 的环由约定避免，不在本函数检测。
// 示例：A 的某个 cell 引用 B，调用 reaches(A, B) 返回 true；两者无引用链时返回 false。
function reaches(from: ObjectImpl, to: ObjectImpl): boolean {
	const seen = new Set<ObjectImpl>();
	// 栈里存放待检查对象；初始只有起点 from。
	const stack = [from];
	while (stack.length > 0) {
		// pop() 可能返回 undefined，但循环条件保证至少一项，所以用非空断言 !。
		const object = stack.pop()!;
		// 先判目标再判 seen：即使 to 之前访问过，也应在这里命中。
		if (object === to) return true;
		if (seen.has(object)) continue;
		seen.add(object);
		// Remote references have no object here: cycles across hosts are avoided by convention.
		for (const decls of object.allDecls()) {
			for (const ref of decls.refs.values()) if (ref.object !== undefined) stack.push(ref.object);
		}
	}
	return false;
}
