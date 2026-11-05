/**
 * Chord v1 旧对象运行时（packages/chord/src/old/object.ts）。
 *
 * 所属包与功能模块：packages/chord 的 v1 实现（src/old/），本文件是对象层核心，不是 v2 的 Chord 根实现。
 *
 * 本文件解决什么问题、职责边界：它把宿主的一次 `get`/`hold` 变成一个具有生命周期的对象：运行工厂并记录声明、
 * 打开资源、等待引用与远程状态就绪、执行 `init`、校验实现、按代码版本安装实现；运行时通过 Proxy 延迟绑定，
 * 把方法调用和状态读取分派给当前代码版本的实现；引用释放、重载替换或宿主关闭时按相反顺序清理。
 * 它不负责输入归一化、地址计算、代码版本管理和网络传输，这些由 host.ts、connection.ts、remote.ts 负责。
 *
 * 上游入口：host.ts 的 `HostImpl.acquire/get/hold` 创建并缓存 `ObjectImpl`，`HostImpl.root` 构造 `CtxImpl`；
 * reload.ts 的 prepare/gate/commit 调用本文件的 `run`、`open`、`initCells`、`stageListeners`、`dispose`；
 * remote.ts 复用本文件的 `CtxImpl`、`RefCore`、`REF_BASE`、`notifyStatus`、`awaitReady`、`raceSignal`。
 * 下游依赖：cell.ts 的 `Cell`/`Derived`/`HYDRATION`，contract.ts 的契约描述、`bind` 与实现/引用类型，
 * declare.ts 的 `Resource`/`ListenerDecl`，errors.ts 的 `ChordError`/`invalid`/`asChordError`/`runAll`，
 * publish.ts 的 `enqueue`，registry.ts 的 `Registration`，schema.ts 的 `assertValid`/`cleaned`/`normalize`，
 * types.ts 的 `Ctx`/`Readable`/`RefStatus`/`Shape` 等公共类型。
 *
 * 结果与错误流向：激活成功让引用变为 `live`；激活失败会回滚本次创建的资源与引用，并让引用 `gone`；
 * 方法调用和状态写入的错误通过 Promise 拒绝或同步抛出（`admit`/`guard`）；后台监听器与任务错误交给 `host.report`。
 *
 * 能力清单（按导出项）：
 * - `ServeOptions`/`ReferencedServeOptions`/`HostServeOptions`/`ServeOptionsFor`/`Lifetime`：工厂的存活策略。
 * - `Factory`：工厂签名 `(input, principal, self) => implementation`。
 * - `Service`/`makeService`/`hostLifetime`：宿主保存的“契约 + 工厂 + 选项 + facet 名”。
 * - `StateOptions`：状态单元格的 schema 版本与迁移函数；`StateInit`：异步初始化描述。
 * - `Self`：工厂声明 state/get/resource/on/task/derive/register/expose 的接口。
 * - `ResourceImpl`：资源句柄的真实实现；`Decls`/`Run`/`Installed`：一次工厂运行及其安装结果。
 * - `HostCore`：对象层需要宿主提供的能力（地址、根、代码版本、注册表通知等）。
 * - `CtxImpl`：一次调用的上下文，持有调用内获取的引用并转发取消。
 * - `linkedSignal`/`awaitReady`/`raceSignal`：取消信号合并、引用就绪等待、Promise 竞速工具。
 * - `RefOwner`/`RefCore`/`REF_BASE`/`notifyStatus`/`refsByProxy`/`refOf`：引用所有权、核心接口、
 *   代理保留名、状态通知和 Proxy 反查。
 * - `RefImpl`：本地引用与 Proxy；`variantOf`：从实现读取变体名。
 * - `ObjectStatus`/`StagedListeners`/`ObjectIdentity`：对象状态机、重载预订阅结果和构造身份参数。
 * - `ObjectImpl`：对象生命周期、运行时、调用与清理。
 * - `memberSchemas`：把实现暴露的远程状态成员映射到 schema。
 *
 * 典型调用顺序（真实运行路径）：
 * `host.get(type, input)` → `HostImpl.acquire` → `new ObjectImpl` → `start()` → `#activate()` →
 * `run()`（同步执行工厂并记录 `Decls`）→ `open()`（打开资源并等待引用）→ `waitHydrated()` → `initCells()` →
 * 安装 `implementations` → `refreshSchemas()` → `startRuntime()`（监听器/任务）→ 引用 `live()`。
 * 方法调用路径：`ref.method(...)` → Proxy → `RefImpl.caller` → `ObjectImpl.call` → `ctx.child` →
 * 当前代码版本实现里的函数；状态读取路径：`ref.cell` → `MemberReadable` → 当前实现的 Cell/Derived。
 *
 * 示例（使用本文件声明的 v1 API；示例只展示声明与调用，不会自行启动宿主）：
 * ```ts
 * const Counter = local("counter", {
 *   version: 1,
 *   input: obj({}, { open: true }),
 *   members: { count: num(), increment: method() },
 * });
 * host.serve(Counter, (_input, _principal, self) => {
 *   const count = self.state("count", num(), 0);
 *   return { count, increment: (ctx) => count.change(ctx, (draft) => { draft += 1; }) };
 * });
 * const ref = await host.get(Counter, {});
 * await host.root((ctx) => ref.increment(ctx));
 * console.log(ref.count.value);
 * ```
 *
 * 建议阅读顺序：先看 `ServeOptions`/`Factory`/`Self` 理解工厂能声明什么；再看 `ObjectImpl.start` 与
 * `#activate` 理解对象如何上线；随后看 `RefImpl` 与 `CtxImpl` 理解调用和状态如何读写；最后看
 * `stageListeners`、`startTasks` 与 `#dispose` 理解重载和清理。错误路径可先读 `checkLifetime`、
 * `admit`、`call` 与 `#activate` 的 catch。
 */
import type { Schema, Static } from "@earendil-works/pi-schema";
import {
	Cell,
	Derived,
	HYDRATION,
	type Hydration,
	hydrationOf,
	isSource,
	notReady,
	type Sources,
	type SourceValues,
	unhydrated,
} from "./cell.ts";
import {
	type Accepts,
	type Adapter,
	type AnyContract,
	bind,
	type ImplementationOf,
	type InputOf,
	LOCAL_VARIANT,
	type LocalContract,
	type MemberDescription,
	type Ref,
	takesNoArgs,
} from "./contract.ts";
import type { EventOf, ListenerDecl, Resource, ResourceDeclaration, Subscribable, ValueOf } from "./declare.ts";
import { asChordError, ChordError, invalid, runAll } from "./errors.ts";
import { enqueue } from "./publish.ts";
import type { Registration, Registry } from "./registry.ts";
import type { RemoteHost } from "./remote.ts";
import { assertValid, cleaned, normalize } from "./schema.ts";
import type { Ctx, Exposed, GetOptions, Readable, RefStatus, Shape, StateEvent } from "./types.ts";

const noop = (): void => {};

// ─── Services ────────────────────────────────────────────────────────────────

/**
 * `serve` options. `lifetime` says how long objects of the type live. `"referenced"` (default): created at the first
 * `get` of an address, disposed after the last reference is released (plus `linger`). `"host"`: one object, created when
 * its facet loads (loading waits until it is live) and kept until the host closes or a reload removes its facet. Only
 * local types whose input accepts `{}` may have it (`ServeOptionsFor` checks that at compile time, `serve` again at
 * runtime); every `get` reaches that one object, created for the host principal. Only such objects may register into
 * registries.
 */
// 存活策略是联合类型：默认的引用计数型与宿主生命周期型；两者共享可选的 accepts 适配器。
export type ServeOptions = ReferencedServeOptions | HostServeOptions;

// referenced 型选项：linger 是最后一个引用释放后的毫秒宽限期；accepts 按消费者契约版本提供适配器。
export interface ReferencedServeOptions {
	readonly lifetime?: "referenced";
	/** Milliseconds an object stays alive after its last reference is released. */
	readonly linger?: number;
	/** Adapters for consumers built against older contract versions. */
	readonly accepts?: Accepts;
}

// host 型选项：对象与宿主同寿，因此 linger 必须缺省；只有本地且输入接受空对象的类型可用。
export interface HostServeOptions {
	readonly lifetime: "host";
	/** An object of lifetime `"host"` lives as long as the host: it does not linger. */
	readonly linger?: undefined;
	/** Adapters for consumers built against older contract versions. */
	readonly accepts?: Accepts;
}

/**
 * The options `serve` accepts for `C`: `lifetime: "host"` only for a local type whose input has no required fields
 * (the type's one object has the empty input).
 */
// 条件类型在编译期筛选选项：本地契约且空对象可赋给 InputOf<C> 时允许 host，否则只允许 referenced。
// `Record<never, never> extends InputOf<C>` 是在类型层面询问“{} 是否满足输入 schema 的静态类型”。
// 运行时仍由 checkLifetime 再检查，因为 JS 调用或类型断言可以绕过这里。
export type ServeOptionsFor<C extends AnyContract> = C extends LocalContract
	? Record<never, never> extends InputOf<C>
		? ServeOptions
		: ReferencedServeOptions
	: ReferencedServeOptions;

// 对外暴露的存活类型别名；运行时字符串由 checkLifetime 再次校验。
export type Lifetime = "referenced" | "host";

/** A type's factory. `P` is the app's principal type: `principal` is the caller the object is created for. */
// 工厂必须同步返回实现；input 已由宿主归一化，principal 是创建对象时的调用者，self 是声明接口。
// P 是应用自己的身份类型，默认 unknown；实现中方法拿到的 ctx.principal 也使用它。
export type Factory<C extends AnyContract, P = unknown> = (
	input: InputOf<C>,
	principal: P,
	self: Self<P>,
) => ImplementationOf<C, P>;
// 内部擦除泛型后的工厂类型，便于 Service 统一存放；运行时不会检查这个签名。
type AnyFactory = (input: unknown, principal: unknown, self: Self) => unknown;

// 宿主按类型名保存的服务记录；facet 记录提供者，用于重载时判断哪些类型被替换。
// contract/factory/options 都由 makeService 写入，对象层只读。
export interface Service {
	readonly contract: AnyContract;
	readonly factory: AnyFactory;
	readonly options: ServeOptions;
	readonly facet: string;
}

/**
 * 创建并校验 Service。输入是契约、工厂、存活选项和 facet 名；返回普通对象，不启动对象。
 * 失败路径：checkLifetime 抛 TypeError（未知 lifetime、远程类型用 host、host 型却给了 linger、
 * host 型的输入不接受 {}）。例如 makeService(Counter, factory, {}, "counter") 只登记服务。
 */
export const makeService = <C extends AnyContract>(
	contract: C,
	factory: Factory<C>,
	options: ServeOptions,
	facet: string,
): Service => {
	// 先做运行时策略校验，再擦除泛型保存；`as unknown as` 是 TS 无法表达的“同一函数的不同参数化”。
	checkLifetime(contract, options);
	return {
		contract,
		factory: factory as unknown as AnyFactory,
		options: options as ServeOptions,
		facet,
	};
};

/** Whether objects of `service` have `lifetime: "host"`. */
// 判断服务是否为宿主生命周期；只读 options，不修改服务。
export const hostLifetime = (service: Service): boolean => service.options.lifetime === "host";

/** Refuses lifetimes the type cannot have, when it is served. */
/**
 * 运行时校验存活策略；无返回值，不合法时抛 TypeError。
 * TypeScript 的 ServeOptionsFor 已在编译期限制大部分组合，但 serve 可被 JS 调用或经类型断言绕过，
 * 所以这里仍是一个信任边界。
 */
function checkLifetime(contract: AnyContract, options: ServeOptions): void {
	// 缺省为 referenced；?? 只在值为 null/undefined 时取默认值，空字符串不会被替换。
	const lifetime = options.lifetime ?? "referenced";
	// 运行时值可能来自 JS，先收窄到两个允许的字符串；String(lifetime) 只用于错误信息。
	if (lifetime !== "referenced" && lifetime !== "host")
		throw new TypeError(`${contract.name}: unknown lifetime ${String(lifetime)}`);
	// referenced 路径到此结束；后面的规则只针对 host 型。
	if (lifetime !== "host") return;
	// host 型对象必须本地创建；远程对象按引用计数在远端存活，不能由本地宿主保证同寿。
	if (contract.scope !== "local")
		throw new TypeError(`${contract.name}: lifetime "host" needs a local type (remote types are referenced)`);
	// host 型与宿主同寿，不允许 linger 语义，避免作者误以为可以延迟销毁。
	if (options.linger !== undefined)
		throw new TypeError(
			`${contract.name}: an object of lifetime "host" does not linger (it lives as long as the host)`,
		);
	try {
		// 用空输入归一化一次，确认该类型能用一个固定地址承载唯一对象。
		// 这是编译期 ServeOptionsFor 检查的运行时对应物，失败会被下面的 catch 转成更明确的 TypeError。
		normalize(contract.input, {}, `${contract.name} input`);
	} catch {
		throw new TypeError(
			`${contract.name}: lifetime "host" needs an input that accepts {} (the object's one address)`,
		);
	}
}

// ─── Declarations ────────────────────────────────────────────────────────────

/** Options of `self.state`. */
// 状态单元格的选项：version 默认 1；重载提高版本时运行 migrate，未提供则要求旧值仍满足新 schema。
export interface StateOptions<T> {
	/** The meaning of the cell's value (default 1). A reload that raises it runs `migrate`. */
	// 作者维护的 schema 版本；与契约版本无关，只用于检测状态形状变化并触发迁移。
	readonly version?: number;
	/**
	 * Maps the value of an older version (`from`) to this version's, at the reload that raised the version. The cell
	 * may be several versions behind. Without it, the value is kept and must fit the new schema.
	 */
	// 从旧版本值迁移到当前版本的纯函数；重载提交时调用，结果会按新 schema 校验。
	readonly migrate?: (old: unknown, from: number) => T;
}

/**
 * A cell's first value from its source: `init` runs after the object's resources are open and its references are live,
 * before the object goes live, so no call, listener or subscriber sees a value that is not from the source. It runs in
 * a root of its own (acting as the host principal) and may be async; the inits of one object run in parallel. Its
 * value is validated against the schema; a throw or an invalid value fails the activation.
 */
// `{ init }` 形式的初始值：运行时通过 isStateInit 识别。init 可异步，在资源打开、引用就绪后、
// 对象上线前执行，因此调用者不会看到“尚未从源读取”的中间值。
export interface StateInit<T, P = unknown> {
	// P 是应用身份类型；ctx 提供取消信号和 principal，例如从数据库读取首值。返回值会按 schema 校验。
	readonly init: (ctx: Ctx<P>) => T | Promise<T>;
}

/** What a factory declares through. `P` is the app's principal type (`ctx.principal` of its listeners and tasks). */
// 工厂的声明接口。所有成员都只登记声明，真正执行由 ObjectImpl/SelfImpl 在激活或重载时负责。
// P 是应用的身份类型；监听器和任务拿到的 ctx.principal 使用它。
export interface Self<P = unknown> {
	/**
	 * A state cell named `name`: its schema (required: there is no TypeScript at runtime) and its initial value
	 * (validated), or `{ init }` to read the first value from its source before the object goes live. The name identifies
	 * the cell across reloads: a reload keeps the cell and its value (`initial` is ignored, `init` does not run), migrates
	 * it when its version rises, and refuses a schema change without a version bump. A cell a reload adds runs its `init`
	 * while the reload prepares.
	 */
	state<S extends Schema>(
		name: string,
		schema: S,
		initial: Static<S> | StateInit<Static<S>, P>,
		options?: StateOptions<Static<S>>,
	): Cell<Static<S>>;
	/** An object-owned reference, identified by its address. */
	// 获取（或复用）对象拥有的引用；地址由类型、输入和 principal 决定，重载时可能复用旧引用。
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Ref<C>;
	/**
	 * A resource named `name`: opened before the object goes live, closed after it is disposed. A reload keeps it unless
	 * its `version`, `deps` or `exclusive` changed.
	 */
	// 声明一个由对象打开和关闭的资源；版本、依赖或独占性变化会在重载时替换它。
	resource<T>(name: string, declaration: ResourceDeclaration<T>): Resource<T>;
	/**
	 * Reacts to `source` once the object is live: a readable (cell, derivation, reference state member) delivers its
	 * current value, then every new value; an event source (or a resource whose value is one) delivers its events.
	 * With `select`, subscribes to `select(value)` instead (the opened value for a resource). Each event runs `handler`
	 * in a fresh root. The name keeps the subscription across reloads while its source and `select` are unchanged; a
	 * listener on state whose source the reload replaced (a derivation is new at every reload) subscribes again and
	 * gets the current value again, so a handler of state must reconcile, not count.
	 */
	// 声明监听器；source 可以是状态、事件流或资源。重载按名字和 select 文本判断能否保留订阅。
	on<S>(name: string, source: S, handler: (event: EventOf<S>, ctx: Ctx<P>) => void | Promise<void>): void;
	on<S, E>(
		name: string,
		source: S,
		select: (value: ValueOf<S>) => Subscribable<E>,
		handler: (event: E, ctx: Ctx<P>) => void | Promise<void>,
	): void;
	/** Long-running work of the live object (a code holder: its calls start fresh roots), restarted at every reload. */
	// 声明长期任务；每次重载重启。任务 ctx 是 code holder，每次调用都会开新根。
	task(fn: (ctx: Ctx<P>) => Promise<void>): void;
	/** A synchronous projection of readables, recomputed when they change; a new one at every reload. */
	// 声明同步派生值；每次工厂运行创建新实例，源变化时原子重算。const S 保留元组字面量长度以便推导参数类型。
	derive<const S extends Sources, T>(sources: S, fn: (...values: SourceValues<S>) => T): Readable<T>;
	/** Objects of lifetime `"host"` only. Keys are the registry's own keys. */
	// 仅 host 生命周期对象可注册；注册项按 registry+key 去重，并在代码版本之间发布。
	register<V>(registry: Registry<V>, entries: Readonly<Record<string, V>>): void;
	/**
	 * A member backed by one of this object's resources, for local contracts: references read the resource's value once
	 * the object is live (`undefined` before). Typically an `opaque` member: `{ harness: self.expose(durable) }`.
	 */
	// 把资源值暴露为本地 opaque 成员；引用上线后读取资源值，例如 { harness: self.expose(durable) }。
	expose<T>(resource: Resource<T>): Exposed<T>;
}

/** Runtime form of `Exposed<T>`. */
// Exposed 的运行时载体：只保存资源，不复制值；真正的读取发生在 RefImpl.member 中。
class ExposedImpl {
	readonly resource: ResourceImpl;
	// 资源对象由 SelfImpl.expose 校验后传入；TS 的 Exposed<T> 只是类型标记，不参与运行时。
	constructor(resource: ResourceImpl) {
		this.resource = resource;
	}
}

/**
 * 资源的真实实例（不是工厂拿到的 façade）。它记录声明、依赖和状态，保证 open/close 的幂等与顺序。
 * 状态机：closed → opening → open → closed；重载回滚失败时进入 unavailable，值不再可用。
 */
export class ResourceImpl<T = unknown> implements Resource<T> {
	// 资源在对象内的唯一名称；重载按名字决定保留还是替换。
	readonly key: string;
	/** The declaration of the factory run whose code is current: a kept resource adopts the new one at commit. */
	// 当前代码版本的声明；保留的资源在 commit 时 adopt 新声明，从而用新代码的 close 关闭旧值。
	spec: ResourceDeclaration<T>;
	// 依赖的引用或资源；打开时先等待引用就绪、先打开资源。
	readonly deps: readonly (RefCore | ResourceImpl)[];
	/** `unavailable`: a close/reopen failed during a reload rollback; the value is gone for good. */
	// 运行时状态机；unavailable 表示回滚时关闭或重开失败，资源值永久丢失。
	state: "closed" | "opening" | "open" | "unavailable" = "closed";
	// `#` 私有字段在运行时真正不可从外部访问；undefined 只在非 open 状态出现。
	#value: T | undefined;

	constructor(key: string, spec: ResourceDeclaration<T>, deps: readonly (RefCore | ResourceImpl)[]) {
		this.key = key;
		this.spec = spec;
		this.deps = deps;
	}

	/**
	 * 读取打开后的资源值。无参数；成功返回 T，未打开或恢复失败时抛 ChordError。
	 * 副作用：无；不会触发打开。
	 */
	get value(): T {
		// 恢复失败是终态：不再尝试打开，避免把未知的原生状态交给调用方。
		if (this.state === "unavailable")
			throw new ChordError("unavailable", `resource ${this.key} could not be restored`);
		// 未打开时用 not_ready，让上层知道这是时序问题而不是永久失败。
		if (this.state !== "open") throw notReady(`resource ${this.key}`);
		// open 成功时已写入值；这里的断言是状态机保证的不变量，不是运行时检查。
		return this.#value as T;
	}

	// 是否独占资源；独占资源在重载 gate 处先关旧值再开新值。
	get exclusive(): boolean {
		return this.spec.exclusive === true;
	}

	/**
	 * Opens the resource. An open that completes after `signal` aborted (rollback, abandonment) closes the value it
	 * produced at once: nobody owns it any more.
	 */
	/**
	 * 打开资源。输入：本次打开/激活的取消信号，以及记录打开顺序的数组；成功返回 void 并把自身加入 order。
	 * 副作用：调用 declaration.open，可能建立数据库连接等外部资源。
	 * 幂等：非 closed 状态直接返回。错误：open 抛错时恢复 closed 并原样抛出；
	 * 打开完成时信号已取消，则关闭刚得到的值并抛 aborted。
	 */
	async open(signal: AbortSignal, order: ResourceImpl[]): Promise<void> {
		// 只允许从 closed 打开；opening/open/unavailable 都不重复执行。
		if (this.state !== "closed") return;
		// 先标记再进行异步打开，防止并发调用重复进入。
		this.state = "opening";
		let value: T;
		try {
			// 把取消信号交给资源作者；同步返回值也会被 await 解包。
			value = await this.spec.open({ signal });
		} catch (error) {
			// 打开失败：回到 closed，保留原异常（可能是 ChordError 或任意抛出值）。
			this.state = "closed";
			throw error;
		}
		// 打开期间被取消：即使 open 已成功，也没有所有者了；先关闭再报 aborted。
		if (signal.aborted) {
			this.state = "closed";
			await this.spec.close?.(value);
			throw new ChordError("aborted", `resource ${this.key} opened after abort`);
		}
		// 只有确认未取消才发布值；顺序不能反过来，否则回滚会漏掉关闭。
		this.#value = value;
		// 值已保存，资源进入可读状态。
		this.state = "open";
		// 记录打开顺序，关闭时按逆序进行。
		order.push(this);
	}

	/**
	 * 关闭资源。输入打开顺序数组；成功返回 void。非 open 状态直接返回，因此可安全重复清理。
	 * 副作用：从 order 移除自身、清空私有值并调用 declaration.close；close 的错误向调用者传播。
	 */
	async close(order: ResourceImpl[]): Promise<void> {
		// 只关闭 open 状态；closed/opening/unavailable 不重复调用 close。
		if (this.state !== "open") return;
		this.state = "closed";
		// indexOf 返回 -1 表示资源未成功打开或已从顺序中移除；两种情况都不应再 splice。
		const index = order.indexOf(this);
		if (index !== -1) order.splice(index, 1);
		const value = this.#value as T;
		// 先清空值再 await close：即使 close 抛错，资源也不会被当作仍可读。
		this.#value = undefined;
		await this.spec.close?.(value);
	}

	// 重载回滚无法恢复时调用：标记终态并丢弃值，后续读取抛 unavailable。
	markUnavailable(): void {
		this.state = "unavailable";
		this.#value = undefined;
	}

	/**
	 * A reload kept this resource (same version, deps and exclusivity): its later `close` is the new declaration's, and
	 * the old declaration (with the old code it closes over) is no longer referenced.
	 */
	// 重载保留资源时换上新声明；旧声明及其闭包代码不再被引用，close 将使用新代码。
	adopt(spec: ResourceDeclaration<T>): void {
		this.spec = spec;
	}
}

/**
 * What `self.resources` returns: the resource, except that `.value` throws `not_ready` while any factory runs, even
 * if the resource is open (a reload's prepare rerun must not touch the native resource the old code uses).
 */
/**
 * 工厂拿到的资源门面：包装 ResourceImpl，并在工厂运行期间禁止读取 value。
 * 原因：重载 prepare 会重跑工厂，此时旧代码仍在使用已打开的本地资源；让 prepare 的读取抛 not_ready，
 * 避免两代代码同时触碰同一个原生资源。闭包中的资源引用通过 WeakMap 映射回真实实现。
 */
class ResourceFacade<T> implements Resource<T> {
	// façade 不复制资源，只转发 key；value 读取要经过工厂计数检查。
	readonly #resource: ResourceImpl<T>;
	readonly #host: HostCore;

	constructor(resource: ResourceImpl<T>, host: HostCore) {
		this.#resource = resource;
		this.#host = host;
		// 登记 façade → ResourceImpl，供 resourceOf 在 deps 和 expose 中还原真实对象；WeakMap 不阻止回收。
		facades.set(this, resource as ResourceImpl);
	}

	get key(): string {
		return this.#resource.key;
	}

	// inFactory 计数器由 ObjectImpl.run 维护；工厂内读取直接拒绝，哪怕资源已经打开。
	get value(): T {
		if (this.#host.inFactory > 0) throw notReady(`resource ${this.key} (inside a factory)`);
		return this.#resource.value;
	}
}

// 只按对象身份映射，不复制也不强引用；ResourceImpl 本身可直接通过 instanceof 识别。
const facades = new WeakMap<object, ResourceImpl>();
// 同时接受真实资源和 façade；非对象值返回 undefined，调用方据此报 TypeError。
// facades.get 只对对象安全，所以先用 typeof 收窄。
const resourceOf = (value: unknown): ResourceImpl | undefined =>
	value instanceof ResourceImpl ? value : value !== null && typeof value === "object" ? facades.get(value) : undefined;

// 任务函数只接收 ctx；返回 Promise，错误在任务运行器里报告。
type TaskFn = (ctx: Ctx) => Promise<void>;

/** Everything one factory run declared, by kind and key. */
/**
 * 一次工厂运行声明的全部内容，按种类和名字索引。重载 prepare 的“记录模式”也使用它：
 * 新 run 的 decls 与旧 decls 对比，决定哪些状态、资源、监听器可以保留。
 */
export class Decls {
	// 状态名 → Cell；重载按名字判断是否复用旧单元格。
	readonly cells = new Map<string, Cell<unknown>>();
	// 状态 schema、版本和迁移函数；reload.ts 用它们检测版本提升与无版本 schema 变更。
	readonly cellSchemas = new Map<string, Schema>();
	readonly cellVersions = new Map<string, number>();
	readonly cellMigrations = new Map<string, (old: unknown, from: number) => unknown>();
	// 地址 → 引用；同一 run 内相同地址只保留一个。
	readonly refs = new Map<string, RefCore>();
	// 名字 → 资源实现；重载按 version/deps/exclusive 判断保留。
	readonly resources = new Map<string, ResourceImpl>();
	/** Resources this run kept from the previous one, with this run's declarations (adopted at commit). */
	// 本次保留的旧资源 → 新声明；commit 时调用 adopt，让 close 使用新代码。
	readonly adopted = new Map<ResourceImpl, ResourceDeclaration<unknown>>();
	// 名字 → 监听器声明；按名字跨重载保留订阅。
	readonly listeners = new Map<string, ListenerDecl>();
	/** By position (`#0`, `#1`, …): tasks have no names. */
	// 任务没有名字，用 #0、#1… 的位置键；每次运行重新创建。
	readonly tasks = new Map<string, TaskFn>();
	/** By position: derivations have no names and are new at every run. */
	// 派生也没有名字，用位置键；每次运行都是新实例。
	readonly derives = new Map<string, Derived<unknown>>();
	// registry+key → 注册记录；仅 host 生命周期对象可写。
	readonly registrations = new Map<string, Registration>();
}

// init 的运行时签名；结果由 Cell.initialize 校验并安装。
type InitFn = (ctx: Ctx) => unknown;

/** One factory run: its implementation, declarations and the objects it created (not reused from the previous run). */
// 一次工厂运行的完整结果：实现对象、声明，以及本次新建（不能从上一代复用）的对象。
export interface Run {
	// 工厂返回的实现对象；运行时校验后才会被安装。
	readonly implementation: Record<string, unknown>;
	readonly decls: Decls;
	// 本次运行新建的引用、资源、派生和待初始化的单元格；失败回滚只清理这些，不碰复用的旧对象。
	readonly created: {
		readonly refs: RefCore[];
		readonly resources: ResourceImpl[];
		readonly derives: Derived<unknown>[];
		/** Cells this run created with `init`, which fills them before they are used. */
		// init 单元格与初始化函数的配对；激活时并行执行，然后把值写入单元格。
		readonly inits: (readonly [Cell<unknown>, InitFn])[];
	};
}

// 运行时类型谓词：普通初始值可能是任意 JSON，只有带函数 init 的对象才是 StateInit。
// 返回值 `value is StateInit<unknown>` 让调用分支内能安全读取 init。
const isStateInit = (value: unknown): value is StateInit<unknown> =>
	value !== null && typeof value === "object" && typeof (value as { init?: unknown }).init === "function";

// 某个代码版本下已安装的实现；同一对象可能同时保留旧版本实现，以服务跨重载的旧根。
export interface Installed {
	// 这份实现属于哪个代码版本；调用按 ctx.codeVersion 选择。
	readonly codeVersion: number;
	// 产生该实现的提供方服务；ref.viewOf 用它的 accepts 适配消费者契约。
	readonly service: Service;
	readonly implementation: Record<string, unknown>;
	readonly decls: Decls;
}

// ─── Host interface the runtime pieces use ───────────────────────────────────

// 对象层使用的宿主接口（HostImpl 实现）。这里只声明对象层需要的能力，避免 object.ts 依赖完整 Host 类。
// 方法都由宿主实现，对象层不假设其内部结构。
export interface HostCore {
	// 宿主名，用于错误信息和远端路由。
	readonly name: string;
	// 开发模式标志；Cell/Derived 据此决定是否每次写入都做 schema 校验。
	readonly dev: boolean;
	// 宿主自身身份；对象内部代码以它行动，get 未指定 principal 时也使用它。
	readonly principal: unknown;
	// 当前正在运行的工厂数量；>0 时资源 façade 与写入守卫都会拒绝操作。
	inFactory: number;
	/** Set when a commit failed midway: the host admits no more work (terminal). */
	// 提交失败后设置的终止错误；一旦非 undefined，宿主不再接受新工作。
	readonly failed: unknown;
	// 报告后台错误（监听器、任务、清理）；不会把错误抛回调用者。
	report(error: unknown): void;
	// 当前已提交的代码版本；重载 prepare 期间新对象可能暂时没有该版本实现。
	currentCodeVersion(): number;
	// 该代码版本是否仍然保留；退役版本的调用应得到 superseded。
	hasCodeVersion(codeVersion: number): boolean;
	// 仍保留的代码版本及其服务表；激活时据此为每个保留版本安装同一份实现。
	retainedCodeVersions(): Iterable<readonly [number, ReadonlyMap<string, Service>]>;
	// 正在 prepare 的重载将要提交的版本；激活可能需要先为它安装实现。
	pendingCodeVersion(): number | undefined;
	// 按类型名查找当前服务；返回 undefined 表示类型未被提供。
	service(typeName: string): Service | undefined;
	acquire(
		type: AnyContract,
		input: unknown,
		options: GetOptions | undefined,
		owner: RefOwner,
		from?: ObjectImpl,
		candidate?: boolean,
	): RefCore;
	// 计算对象地址；candidate 为 true 时使用重载候选服务表，让新旧契约一起升级。
	addressOf(type: AnyContract, input: unknown, principal: unknown, candidate?: boolean): string;
	// 在宿主根中执行 fn；根提供调用上下文、代码版本和取消信号，并参与重载 gate 与退役等待。
	root<T>(fn: (ctx: Ctx) => T | Promise<T>, options?: { codeVersion?: number; signal?: AbortSignal }): Promise<T>;
	// 记录根触碰了对象；宿主在根结束时回调 object.rootEnded。
	touch(rootId: string, object: ObjectImpl): void;
	// 从宿主对象表移除；激活失败或开始销毁时调用，避免再次按地址命中。
	forget(object: ObjectImpl): void;
	/** The object finished its disposal. */
	// 对象完成销毁后通知宿主；宿主据此结束清理流程。
	disposed(object: ObjectImpl): void;
	/** Milliseconds a reload waits for aborted tasks to finish before starting their replacements. */
	// 重载等待被中止任务结束的最长时间；超时后新任务仍会启动并报告。
	readonly taskStopDeadline: number;
	/**
	 * Milliseconds an activation or a reload's prepare waits for its references to be ready and hydrated before it fails
	 * (`unavailable/ready_timeout`; a reference cycle across hosts never resolves).
	 */
	// 激活/准备等待引用就绪的最长时间；超时抛 unavailable/ready_timeout。
	readonly readyTimeout: number;
	// 校验注册项冲突；在提交声明前调用，失败会回滚激活。
	checkRegistrations(object: ObjectImpl, decls: Decls): void;
	/** Rebuilds the current registry tables from live objects (plus `including`, which is finishing activation). */
	// 重建注册表并通知订阅者；including 是正在完成激活、尚未 live 的对象。
	registriesChanged(including?: ObjectImpl): void;
}

// ─── Contexts ────────────────────────────────────────────────────────────────

/**
 * 一次调用或根的上下文实现。它持有调用期间获取的引用、代码版本和 principal，并合并多个取消信号。
 * 生命周期：根/调用结束时 close()，之后不能再开始工作；关闭会释放本次调用获取的引用。
 */
export class CtxImpl implements Ctx {
	// 上下文所属宿主；跨宿主传递 ctx 会被 check 拒绝。
	readonly host: HostCore;
	// 合并后的取消信号；任一输入信号取消，它也会取消并保留原因。
	readonly signal: AbortSignal;
	// 根 id；同一棵调用树共享它，宿主用它做租约和 gate 祖父判定。
	readonly rootId: string;
	// 本次根使用的代码版本；嵌套调用继续使用同一版本，避免跨代执行。
	readonly codeVersion: number;
	// 本次调用/根使用的身份；宿主入口处是调用者，对象内部创建的子 ctx 使用宿主身份。
	readonly principal: unknown;
	/** Code holders (tasks): every call they make starts a fresh root. */
	// code holder（任务）标志；为 true 时每次方法调用都开新根，而不是复用当前根。
	readonly holder: boolean;
	// 本次调用通过 ctx.get 获取的引用；close 时统一释放。
	readonly #refs: RefCore[] = [];
	readonly #release: () => void;
	/** Aborted when the ctx closes: awaited `get`s give up. */
	// ctx 关闭时中止它；等待 ctx.get 就绪的调用会因此放弃。
	readonly #closing = new AbortController();
	#closed = false;

	/** True after the call or root that received this ctx settled: it may no longer start work. */
	// 只读状态查询：true 表示调用/根已经结束，不能再开始工作。
	get closed(): boolean {
		return this.#closed;
	}

	/** Throws unless this ctx may start work on `host` (the called reference's host) now: not expired, aborted or foreign. */
	// 校验 ctx 现在能否在 host 上开始工作；不满足时同步抛 ChordError。
	// 顺序：宿主归属 → 是否过期 → 信号是否取消；取消原因若是 superseded 则保留可重试的语义。
	check(host: HostCore | RemoteHost): void {
		// 对象身份比较即可：ctx 只能用于创建它的宿主，远程引用也传自己的 RemoteHost。
		if (this.host !== host) throw invalid("foreign_ctx", "ctx belongs to another host");
		// 调用已结束；即使信号尚未取消，也不允许再获取引用或调用方法。
		if (this.#closed) throw new ChordError("aborted", "ctx expired: its call already settled", { reason: "expired" });
		// 信号已取消；读取 reason 以区分强制退役（superseded）和普通取消。
		if (this.signal.aborted) {
			const reason: unknown = this.signal.reason;
			// A forced retirement aborted the root: its code version is gone, so the next call is `superseded` (retryable).
			// 强制退役的根留下 superseded：下一次调用可重试，而不是当作普通 aborted。
			if (reason instanceof ChordError && reason.code === "superseded")
				throw new ChordError("superseded", reason.message, { cause: reason });
			throw new ChordError("aborted", "ctx aborted", { cause: reason });
		}
	}

	// 构造函数接收多个取消源并合并；holder 缺省为 false，任务会显式传 true。
	/** `signals`: the ctx is aborted with the first of them; it stops following them when it closes. */
	constructor(
		host: HostCore,
		fields: {
			signals: readonly AbortSignal[];
			rootId: string;
			codeVersion: number;
			principal: unknown;
			holder?: boolean;
		},
	) {
		// 保存宿主和合并后的信号；release 用于在 close 时解绑所有源监听器。
		this.host = host;
		const linked = linkedSignal(fields.signals);
		this.signal = linked.signal;
		this.#release = linked.release;
		this.rootId = fields.rootId;
		this.codeVersion = fields.codeVersion;
		this.principal = fields.principal;
		this.holder = fields.holder ?? false;
	}

	// 在本次调用内获取引用：先检查 ctx，再让宿主 acquire；引用记录在 #refs 中，调用结束统一释放。
	// options 与调用方 principal 合并；awaitReady 等待 live 与状态就绪，失败时只释放这一个引用。
	async get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions): Promise<Ref<C>> {
		// 过期或跨宿主的 ctx 不能开始新工作。
		this.check(this.host);
		// owner 为 call：引用的寿命跟随本次调用；展开 options 允许调用方覆盖 principal。
		const ref = this.host.acquire(type, input, { principal: this.principal, ...options }, "call");
		// 先记录再等待；即使等待失败，awaitReady 会释放引用，close 时再次 release 也是幂等的。
		this.#refs.push(ref);
		// 同时监听调用取消和 ctx 关闭；超时时间来自宿主配置。
		await awaitReady(ref, [this.signal, this.#closing.signal], this.host.readyTimeout);
		// 对外只暴露契约类型；运行时对象是代理，成员会在读取时绑定当前实现。
		return ref.proxy as Ref<C>;
	}

	/**
	 * A context for a call into `object`: same root and code version, its own call-owned references, aborted on forced
	 * disposal. Code inside an object acts as the host principal.
	 */
	// 为进入 object 的代码创建子 ctx：同根、同代码版本，principal 换成宿主身份，
	// 并额外监听对象的 callAbort，使强制销毁能取消正在执行的调用。
	child(object: ObjectImpl): CtxImpl {
		return new CtxImpl(this.host, {
			// 父 ctx 或对象调用被取消时，子 ctx 都会取消。
			signals: [this.signal, object.callAbort.signal],
			rootId: this.rootId,
			codeVersion: this.codeVersion,
			principal: this.host.principal,
		});
	}

	// 结束 ctx：标记 closed、中止等待中的 get、解绑信号监听器，并释放本 ctx 获取的引用。
	// 同步返回；不等待引用释放完成。
	close(): void {
		// 先标记，防止 close 过程中的回调再次开始工作。
		this.#closed = true;
		// 用 expired 原因中止尚未完成的等待；这与外部取消区分开。
		this.#closing.abort(new ChordError("aborted", "ctx expired: its call already settled", { reason: "expired" }));
		// 解绑所有源信号上的 abort 监听器，避免长生命周期源保留这个 ctx。
		this.#release();
		// splice(0) 取出并清空数组；即使 release 触发回调，也不会重复处理同一引用。
		for (const ref of this.#refs.splice(0)) ref.release();
	}
}

/**
 * A signal aborted with the first of `sources` to abort, until `release()`. Not `AbortSignal.any`: Node keeps a
 * dependant of a long-lived source (an object's or a code version's) reachable while it has abort listeners, so every
 * call or task context would keep its listeners, and the code they close over, alive as long as the source.
 */
/**
 * 合并多个 AbortSignal，返回一个 signal 和 release()。输入是取消信号数组；成功返回控制器信号。
 * 副作用：向源信号注册 abort 监听器；release() 移除它们。第一个取消的源决定 reason。
 * 不用 AbortSignal.any 的原因：Node 的长生命周期源在仍有监听器时会保留依赖，导致每个调用上下文
 * 及其闭包一直存活；这里在 release 时显式解绑。
 */
export function linkedSignal(sources: readonly AbortSignal[]): { readonly signal: AbortSignal; release(): void } {
	// 合并信号由新控制器产生；它不是任何源的子信号，因此源不会反向持有它。
	const controller = new AbortController();
	// 保存每个源监听器的解绑函数；release 或第一次取消时统一调用。
	const detach: (() => void)[] = [];
	// 解绑函数幂等：splice 清空数组，重复调用不会重复移除。
	const release = (): void => {
		for (const remove of detach.splice(0)) remove();
	};
	for (const source of sources) {
		// 已经取消的源优先：立即解绑此前监听器、转发原因并停止处理后面的源。
		if (source.aborted) {
			release();
			controller.abort(source.reason);
			break;
		}
		// 第一个取消的源触发：先解绑全部监听器，再中止合并信号；once 保证每个源只触发一次。
		const forward = (): void => {
			release();
			controller.abort(source.reason);
		};
		// once 让源只通知一次；仍然把移除函数放进 detach，以便在取消前主动 release。
		source.addEventListener("abort", forward, { once: true });
		detach.push(() => source.removeEventListener("abort", forward));
	}
	// 返回的 release 不会取消信号，只停止跟随；调用方关闭根时使用。
	return { signal: controller.signal, release };
}

/**
 * Waits until `ref` is ready, at most `ms` and until a signal aborts; on failure the reference is released (only it: a
 * binding other references share stays) and the error is rethrown: the activation error, `aborted`, or
 * `unavailable/ready_timeout`.
 */
/**
 * 等待引用就绪。输入：引用、额外取消信号、超时毫秒；成功返回 void。
 * 失败：引用激活错误、任一信号取消、或超时（unavailable/ready_timeout）；失败时只释放这个引用本身，
 * 不会拆掉与其他引用共享的远端绑定。超时原因优先于取消原因返回。
 */
export async function awaitReady(ref: RefCore, signals: readonly AbortSignal[], ms: number): Promise<void> {
	// 超时也建模成取消信号，复用同一套竞速逻辑；非有限 ms 表示不设超时。
	const timeout = new AbortController();
	// 只有有限毫秒数才设置时钟；setTimeout 的回调把 ready_timeout 错误设为取消原因。
	const timer = Number.isFinite(ms)
		? setTimeout(
				() =>
					timeout.abort(
						new ChordError("unavailable", `${ref.address} was not ready after ${ms} ms`, {
							reason: "ready_timeout",
						}),
					),
				ms,
			)
		: undefined;
	// 定时器 unref：仅等待引用不应阻止 Node 进程退出；类型断言是因为浏览器/Node 返回类型不同。
	(timer as { unref?: () => void } | undefined)?.unref?.();
	// 合并调用方信号和超时信号；展开生成新数组，不修改输入。
	const linked = linkedSignal([...signals, timeout.signal]);
	try {
		// 引用就绪与取消竞速；ref.ready 失败时保留原始激活错误。
		await raceSignal(ref.ready, linked.signal);
	} catch (error) {
		ref.release();
		const reason: unknown = linked.signal.reason;
		// 如果原因是超时，优先返回带地址和毫秒数的超时错误；否则返回原始失败。
		throw reason instanceof ChordError && reason.reason === "ready_timeout" ? reason : error;
	} finally {
		// 无论成功失败都清理时钟并解绑合并信号，避免泄漏。
		clearTimeout(timer);
		linked.release();
	}
}

// 让 promise 与取消信号竞速；signal 已取消时立即抛 aborted。
// 成功后移除 abort 监听器，避免长生命周期信号保留闭包；失败时原样传播 promise 或取消错误。
export async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	// 快速路径：已取消就不必创建竞速 Promise。
	if (signal.aborted) throw new ChordError("aborted", "call aborted", { cause: signal.reason });
	let onAbort = noop;
	// 取消分支永不 resolve；onAbort 通过闭包捕获 reject，finally 中移除监听器。
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new ChordError("aborted", "call aborted", { cause: signal.reason }));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		// 两个 Promise 谁先落定就返回谁；Promise.race 不会取消落败的一方。
		return await Promise.race([promise, aborted]);
	} finally {
		// 无论哪一方先完成都解绑；此时 promise 可能仍在后台继续。
		signal.removeEventListener("abort", onAbort);
	}
}

// ─── References ─────────────────────────────────────────────────────────────────

/** Who a reference belongs to. `connection`: a peer host over a link; `client`: a browser (not a reload participant). */
// 引用所有权决定释放和重载行为：object（工厂持有）、call（调用内临时获取）、host（宿主自身）、
// external（host.get 返回给应用）、connection（另一宿主的连接）、client（浏览器，不参与重载投票）。
export type RefOwner = "object" | "call" | "host" | "external" | "connection" | "client";

/** A claim on an object: a local `RefImpl`, or a `RemoteRef` on another host (no object here). */
// 本地 RefImpl 和远端 RemoteRef 的共同核心；ObjectImpl 只依赖这些字段，不关心引用在本地还是远端。
export interface RefCore {
	// 对象地址；错误信息、租约和远端绑定键都使用它。
	readonly address: string;
	readonly contract: AnyContract;
	// 当前引用状态；loading 可在远端重连时再次出现，released/gone 是终态。
	readonly status: RefStatus;
	// 第一次满足就绪条件时完成；后续状态变化要看 status，不能把已完成的 Promise 当作健康检查。
	readonly ready: Promise<void>;
	// 对外的契约代理；成员读取时才解析当前实现。
	readonly proxy: object;
	// 本地引用指向对象；远端引用为 undefined，因为对象在另一宿主。
	readonly object: ObjectImpl | undefined;
	release(): void;
}

// Proxy 上由引用自身提供的名字；其余字符串才被解释为契约成员。
// then 不在集合里，但代理会单独屏蔽它，避免引用被误当作 thenable。
export const REF_BASE: ReadonlySet<PropertyKey> = new Set([
	"contract",
	"status",
	"ready",
	"variant",
	"shape",
	"error",
	"onShape",
	"onStatus",
	"release",
]);

// 状态回调；(status, error) 中 error 只在 gone 等失败状态有意义。
export type StatusListener = (status: RefStatus, error: unknown) => void;

/** Queues a status notification (after the change that caused it is complete, like every publication). */
/**
 * 把状态变化排到统一通知队列。输入监听器集合、状态、错误和错误报告函数；无返回值。
 * 副作用：复制当前监听器后 enqueue，稍后逐个调用；单个监听器抛错只报告，不影响其他监听器。
 */
export function notifyStatus(
	listeners: ReadonlySet<StatusListener>,
	status: RefStatus,
	error: unknown,
	report: (error: unknown) => void,
): void {
	// 没有监听者时不入队，避免无意义的闭包分配。
	if (listeners.size === 0) return;
	// 复制快照：本批通知使用入队时的监听器集合，通知期间移除不会影响这一批。
	const current = [...listeners];
	// 与状态发布共用 FIFO 队列，保证状态通知不会插到正在提交的变更中间。
	enqueue(() => {
		for (const listener of current) {
			try {
				listener(status, error);
			} catch (thrown) {
				// 监听器错误不向状态变更的触发者传播，只交给宿主报告。
				report(thrown);
			}
		}
	});
}

/** Proxy → reference, for `deps: [ref]` and links. */
// 反查表：从 Proxy 找回 RefCore，供 deps 与远端链接识别引用；WeakMap 不阻止代理回收。
export const refsByProxy = new WeakMap<object, RefCore>();
// 只对对象查表；函数或原始值不是引用。先判断 typeof 是为了避免 WeakMap.get 对原始值抛错。
export const refOf = (value: unknown): RefCore | undefined =>
	value !== null && typeof value === "object" ? refsByProxy.get(value) : undefined;

/**
 * A reference's state member: a stable readable that follows whatever source the current implementation exposes under
 * that name. Reading throws `not_ready` until the reference is live, `not_in_variant` while the variant lacks the
 * member. A listener added before the member is readable gets its snapshot then. Rebinding (reload, variant) delivers a
 * reset. Upstream is subscribed only while someone listens.
 */
/**
 * 引用上的状态成员：一个稳定的 Readable，始终跟随当前实现暴露的同名源。
 * 为什么需要它：重载或变体切换会替换实现里的 Cell/Derived，但消费者手里的 readable 对象必须保持不变。
 * 行为：未 live 时读取抛 not_ready，变体没有该成员时抛 not_in_variant；首次订阅交付当前值；
 * 源变化时发 reset；没有监听者时不订阅上游，避免额外开销。
 */
class MemberReadable implements Readable<unknown> {
	// 反向持有引用，用于读取状态、解析当前实现和报告错误。
	readonly #ref: RefImpl;
	readonly #name: string;
	// 值监听器与事件监听器分开保存；两者共享同一个上游订阅。
	readonly #values = new Set<(value: unknown) => void>();
	readonly #events = new Set<(event: StateEvent<unknown>) => void>();
	/** Event listeners that have not had their snapshot yet (added while the member was not readable). */
	// 在成员可读之前添加的事件监听器；第一次上游事件到来时补发 snap 而不是 reset。
	readonly #unseen = new Set<(event: StateEvent<unknown>) => void>();
	// 当前实现暴露的源；重载后可能换成新的 Cell/Derived，但本对象身份不变。
	#source: Readable<unknown> | undefined;
	// 上游取消订阅函数；没有订阅时是 noop，bind 时替换。
	#upstream = noop;
	/** The value listeners last saw; a first upstream snapshot equal to it is not re-announced. */
	// 值监听器最后看到的值；用于抑制重绑后重复的同值快照。
	#seen: { readonly value: unknown } | undefined;

	constructor(ref: RefImpl, name: string) {
		this.#ref = ref;
		this.#name = name;
	}

	// 读取当前值；引用已结束、未 live、实现未就绪或变体不含成员时抛不同错误。
	// 这里不订阅上游，只做一次同步读取。
	get value(): unknown {
		const ref = this.#ref;
		// 终态引用保留原始错误（gone）或 released 错误，优先于 not_ready。
		if (ref.status === "released" || ref.status === "gone") throw ref.terminalError();
		// 引用尚未 live 时成员没有可读值。
		if (ref.status !== "live") throw notReady(`${ref.address}.${this.#name}`);
		// 当前实现经过 accepts 适配后的视图；适配失败时返回 undefined 并已报告。
		const view = ref.currentView();
		if (view === undefined) throw notReady(`${ref.address}.${this.#name}`);
		const source = this.#current();
		// live 但当前变体没有这个状态成员：这是契约/变体问题，不是时序问题。
		if (source === undefined) {
			throw new ChordError(
				"not_in_variant",
				`${ref.address}: ${this.#name} is not a state member of variant ${variantOf(view) ?? "(local)"}`,
			);
		}
		return source.value;
	}

	/** Not hydrated while the reference is not live, or while its source (a forwarded remote member) is not. */
	// 暴露水合状态：引用未 live 时未水合；live 时跟随当前源的 HYDRATION（如远端成员）。
	// 计算属性名 [HYDRATION] 使用 cell.ts 的 symbol，使 unhydrated/hydrationOf 能统一识别。
	get [HYDRATION](): Hydration | undefined {
		const ref = this.#ref;
		if (ref.status === "live") return hydrationOf(this.#current());
		return {
			hydrated: false,
			whenHydrated: async () => {
				await ref.ready;
				await hydrationOf(this.#current())?.whenHydrated();
			},
		};
	}

	// 注册值监听器：若当前可读，立即交付当前值并记录；随后 bind 确保上游已订阅。
	// 返回取消函数，移除监听器并按需解绑上游。
	subscribe(listener: (value: unknown) => void): () => void {
		this.#values.add(listener);
		// 只有 live、在变体内且已水合才立即交付；否则等 bind 的首次事件。
		const source = this.#readable();
		if (source !== undefined) {
			// 记录最后交付值，避免重绑后的第一个同值快照再次通知。
			this.#seen = { value: source.value };
			this.#safe(() => listener(source.value));
		}
		this.bind();
		return () => this.#remove(this.#values, listener);
	}

	// 注册事件监听器：可读时立即发 snap；否则放入 #unseen，等第一次上游事件补发 snap。
	// 返回值同时清理 #unseen 和 #events，防止未收到的监听器泄漏。
	events(listener: (event: StateEvent<unknown>) => void): () => void {
		this.#events.add(listener);
		const source = this.#readable();
		if (source !== undefined) {
			const value = source.value;
			this.#seen = { value };
			this.#safe(() => listener({ type: "snap", value }));
		} else this.#unseen.add(listener);
		this.bind();
		return () => {
			this.#unseen.delete(listener);
			this.#remove(this.#events, listener);
		};
	}

	/** (Re)subscribes upstream to the current source; a changed source is announced as a reset. */
	// (重新)订阅当前源；没有监听者时解绑。源变化时先把首个事件翻译成 reset，表示消费者需要重建视图。
	// 事件通过 enqueue 延后交付，避免在 commit 的同步安装过程中触发观察者。
	bind(): void {
		// 三个集合都为空时不保留上游订阅；这正是“没有监听者就不订阅”的实现。
		const source = this.#values.size + this.#events.size > 0 ? this.#current() : undefined;
		// 源未变化：保留现有上游订阅，不重复订阅单订阅源。
		if (source === this.#source) return;
		// 解绑旧源；noop 或之前的取消函数。
		this.#upstream();
		this.#upstream = noop;
		this.#source = source;
		if (source === undefined) return;
		// 每次重绑后的第一个事件用于区分 snap/reset 与普通增量。
		let first = true;
		this.#upstream = source.events((event) => {
			const isFirst = first;
			first = false;
			// 重绑后第一个事件与最后看到的值相同且没有待补发监听器时，抑制重复通知。
			if (isFirst && this.#unseen.size === 0 && this.#seen !== undefined && event.value === this.#seen.value) return;
			this.#seen = { value: event.value };
			// 源换了（重载/变体切换）：告诉事件监听器这是 reset，而不是普通 ops。
			const translated: StateEvent<unknown> = isFirst ? { type: "reset", value: event.value } : event;
			const events = [...this.#events];
			const values = [...this.#values];
			const unseen = new Set(this.#unseen);
			this.#unseen.clear();
			// Queued: a rebind during a commit must not run observers before the commit completes.
			enqueue(() => {
				for (const listener of events) {
					if (!this.#events.has(listener)) continue;
					const delivered: StateEvent<unknown> = unseen.has(listener)
						? { type: "snap", value: event.value }
						: translated;
					this.#safe(() => listener(delivered));
				}
				// 值监听器只关心新值；事件监听器才关心 snap/ops/reset 类型。
				for (const listener of values) if (this.#values.has(listener)) this.#safe(() => listener(event.value));
			});
		});
	}

	// 停止成员：清空所有监听器并解绑上游；引用释放或结束时调用。
	stop(): void {
		this.#values.clear();
		this.#events.clear();
		this.#unseen.clear();
		this.bind();
	}

	// 从当前视图取同名源；本地契约不限制变体，远程契约要求成员属于当前变体。
	// 结果必须是 Cell/Derived（isSource）或具备 Readable 形状的适配结果。
	#current(): Readable<unknown> | undefined {
		const view = this.#ref.currentView();
		if (view === undefined || !this.#ref.inVariant(view, this.#name)) return undefined;
		const value = view[this.#name];
		// Cells and derivations, or any readable an `accepts` adapter maps them to.
		return isSource(value) || isReadableLike(value) ? (value as Readable<unknown>) : undefined;
	}

	/** The current source if its value can be read now (live, in the variant, hydrated). */
	// 只有已水合的源才能立即读取；未水合时返回 undefined，等待首次事件。
	#readable(): Readable<unknown> | undefined {
		const source = this.#current();
		return source === undefined || hydrationOf(source)?.hydrated === false ? undefined : source;
	}

	// 删除监听器后重新评估是否需要上游订阅。
	#remove<T>(set: Set<T>, listener: T): void {
		set.delete(listener);
		this.bind();
	}

	// 监听器错误交给宿主报告，不能让它中断同批其他监听器。
	#safe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.#ref.object.host.report(error);
		}
	}
}

/** One reference on an object. Exposed through a Proxy so members bind late to the current implementation. */
/**
 * 本地引用：拥有一个对象和消费者契约，通过 Proxy 延迟绑定到当前代码版本的实现。
 * 状态：loading → live → released/gone；ready Promise 在第一次 live 后完成（失败则拒绝）。
 * 每个引用独立 release，但底层对象由 ObjectImpl 按引用计数与 linger 决定销毁。
 */
export class RefImpl {
	// 引用指向的本地对象；地址与对象状态都从它读取。
	readonly object: ObjectImpl;
	readonly contract: AnyContract;
	// 所有权决定销毁与重载行为；例如 client 引用不阻止重载。
	readonly owner: RefOwner;
	readonly address: string;
	readonly proxy: object;
	readonly ready: Promise<void>;
	status: RefStatus;
	error: unknown;
	readonly shapeListeners = new Set<(shape: Shape) => void>();
	/** Internal: notified when the reference becomes gone (links forward it). */
	readonly goneListeners = new Set<(error: unknown) => void>();
	readonly readables = new Map<string, MemberReadable>();
	/** Weak: a retired code version's service (and the factory code it holds) must not be kept alive by its consumers. */
	// 按提供方 Service 缓存绑定结果；WeakMap 防止已退役代码版本的工厂代码被消费者强引用。
	readonly bindings = new WeakMap<Service, Adapter | undefined>();
	// 按实现对象缓存适配后的视图，避免每次读取成员都重新执行 accepts 适配器。
	readonly views = new WeakMap<Record<string, unknown>, Record<string, unknown>>();
	// 按方法名缓存调用包装函数；代理每次读取方法时返回同一个函数。
	readonly callers = new Map<string, (...given: unknown[]) => Promise<unknown>>();

	// 创建引用：状态先按对象是否 live 决定，ready 跟随对象激活；随后建立 Proxy 并登记反查表。
	constructor(object: ObjectImpl, contract: AnyContract, owner: RefOwner) {
		this.object = object;
		this.contract = contract;
		this.owner = owner;
		this.address = object.address;
		// 对象已 live 时引用立即 live；否则等待对象 ready。
		this.status = object.status === "live" ? "live" : "loading";
		// ready 在对象激活后再次检查引用是否已被释放或终止；两种终态都拒绝。
		this.ready = object.ready.then(() => {
			if (this.status === "gone") throw this.error;
			if (this.status === "released") throw new ChordError("released", `reference ${this.address} released`);
		});
		// 调用者仍可通过 ready 收到拒绝；这里只防止未处理拒绝告警。
		this.ready.catch(noop);
		// 代理拦截属性读取：引用自身成员直接转发，其余字符串解析为契约成员。
		// 这样重载后无需替换消费者手里的引用，成员会绑定到新实现。
		this.proxy = new Proxy(this, {
			// REF_BASE 中的属性方法需要 bind(target)，否则 this 会指向代理并可能递归。
			get: (target, property) => {
				if (REF_BASE.has(property)) {
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				// symbol 属性（如 inspect）和 then 不当作成员；屏蔽 then 防止 Promise 解析把引用当成 thenable。
				if (typeof property !== "string" || property === "then") return undefined;
				return target.member(property);
			},
			// in 运算符也按契约成员判断；String(symbol) 只是为了让类型收窄通过，symbol 不会命中。
			has: (target, property) => REF_BASE.has(property) || target.member(String(property)) !== undefined,
		});
		refsByProxy.set(this.proxy, this);
	}

	// 当前实现的变体名；未 live 或本地契约时为 undefined。
	get variant(): string | undefined {
		const view = this.currentView();
		return view === undefined ? undefined : variantOf(view);
	}

	// 描述当前实现对外暴露的形状：变体、成员名和提供方契约指纹。
	// 适配失败或对象未 live 时返回 undefined。
	get shape(): Shape | undefined {
		const installed = this.status === "live" ? this.object.currentInstalled() : undefined;
		const view = installed === undefined ? undefined : this.#safeView(installed);
		if (installed === undefined || view === undefined) return undefined;
		return {
			variant: variantOf(view),
			members: Object.keys(view).filter((key) => key !== "variant"),
			contract: installed.service.contract.fingerprint,
		};
	}

	// 订阅形状变化；不会立即补发当前形状，调用方需要时先读 shape。
	onShape(listener: (shape: Shape) => void): () => void {
		this.shapeListeners.add(listener);
		return () => this.shapeListeners.delete(listener);
	}

	// 订阅状态变化；同样不会补发当前状态。
	onStatus(listener: StatusListener): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	readonly #statusListeners = new Set<StatusListener>();

	// 把当前 status/error 通知给订阅者；实际交付由 notifyStatus 入队。
	#statusChanged(): void {
		// 状态通知走统一队列；错误由宿主报告。
		notifyStatus(this.#statusListeners, this.status, this.error, (error) => this.object.host.report(error));
	}

	// 主动释放引用：终态直接返回；否则标记 released、停止状态成员、通知监听器并让对象减少引用。
	// 不等待对象销毁；最后一个引用释放后由 ObjectImpl 按 linger 决定销毁时机。
	release(): void {
		if (this.status === "released" || this.status === "gone") return;
		this.status = "released";
		// 先停止成员订阅，避免引用结束后仍收到上游事件。
		this.#stopReadables();
		this.#statusChanged();
		// 对象负责引用计数和可能的销毁；重复 release 已被状态检查挡住。
		this.object.release(this);
	}

	// ─── internal ───

	// 对象激活完成后把加载中的引用转为 live；其他状态（如已释放）不复活。
	live(): void {
		if (this.status !== "loading") return;
		// 所有步骤成功后才对引用开放；此前引用保持 loading。
		this.status = "live";
		this.#statusChanged();
		// live 后成员源才可绑定，同时通知形状监听器。
		this.shapeChanged();
	}

	// 对象失败或被强制销毁：引用进入 gone 并保留错误；已释放/已 gone 的引用不再改变。
	// 通知 goneListeners，远端链接用它把结束传播给对端。
	gone(error: unknown): void {
		if (this.status === "released" || this.status === "gone") return;
		this.status = "gone";
		this.error = error;
		this.#stopReadables();
		this.#statusChanged();
		for (const listener of [...this.goneListeners]) listener(error);
	}

	// 实现替换后重新绑定所有成员 readable，并异步通知形状监听器。
	shapeChanged(): void {
		for (const readable of this.readables.values()) readable.bind();
		const shape = this.shape;
		if (shape === undefined) return;
		const listeners = [...this.shapeListeners];
		enqueue(() => {
			for (const listener of listeners) {
				try {
					listener(shape);
				} catch (error) {
					this.object.host.report(error);
				}
			}
		});
	}

	// 返回终态错误：gone 用保存的原因，released 用新的 released 错误。
	terminalError(): unknown {
		return this.status === "gone" ? this.error : new ChordError("released", `reference ${this.address} released`);
	}

	/** The implementation as this consumer sees it (through an accepts adapter when bound to another version). */
	// 取得消费者视角的实现：同一提供方契约直接返回实现，旧版本经 accepts 适配器映射并缓存。
	// bind 失败会抛 contract_mismatch，由调用方决定如何报告。
	viewOf(installed: Installed): Record<string, unknown> {
		let adapter = this.bindings.get(installed.service);
		// 用 has 区分“尚未计算”和“计算结果是 undefined（无需适配）”；WeakMap 没有 undefined 哨兵。
		if (!this.bindings.has(installed.service)) {
			adapter = bind(installed.service.contract, installed.service.options.accepts, this.contract);
			this.bindings.set(installed.service, adapter);
		}
		// 指纹相同：消费者直接看到提供方实现，不做复制。
		if (adapter === undefined) return installed.implementation;
		let view = this.views.get(installed.implementation);
		if (view === undefined) {
			view = adapter(installed.implementation);
			this.views.set(installed.implementation, view);
		}
		return view;
	}

	// 当前代码版本实现的消费者视图；未 live 或没有实现时返回 undefined。
	currentView(): Record<string, unknown> | undefined {
		if (this.status !== "live") return undefined;
		const installed = this.object.currentInstalled();
		return installed === undefined ? undefined : this.#safeView(installed);
	}

	/** The view, or undefined when this consumer no longer binds (reported; calls reject with the bind error). */
	// 取消费者视图；适配失败时报告给宿主并返回 undefined，让调用方以 not_ready/gone 结束。
	#safeView(installed: Installed): Record<string, unknown> | undefined {
		try {
			return this.viewOf(installed);
		} catch (error) {
			this.object.host.report(error);
			return undefined;
		}
	}

	// 查找成员描述：指定变体时只查该变体；未指定时查任意变体，用于代理判断成员种类。
	describe(variant: string | undefined, member: string): MemberDescription | undefined {
		const variants = this.contract.description.variants;
		if (variant !== undefined) return variants[variant]?.[member];
		for (const members of Object.values(variants)) if (members[member] !== undefined) return members[member];
		return undefined;
	}

	/** Remote consumers see only the members their contract lists for the current variant. */
	// 本地契约不限制成员；远程消费者只能看到其契约在当前变体列出的成员。
	inVariant(view: Record<string, unknown>, name: string): boolean {
		return this.contract.scope !== "remote" || this.describe(variantOf(view), name) !== undefined;
	}

	// 解析代理成员：方法返回调用器，状态返回稳定 Readable，opaque 返回资源值。
	// 未声明时按运行时值形状推断（函数/可读对象），这支持适配器包装后的成员。
	member(name: string): unknown {
		const declared = this.describe(undefined, name);
		const view = this.currentView();
		const value = view?.[name];
		// 契约声明为方法，或本地实现未声明但值确实是函数时，按方法处理。
		if (declared?.kind === "method" || (declared === undefined && typeof value === "function")) {
			return this.caller(name);
		}
		// 状态成员统一包装成 MemberReadable，保证重载后对象身份不变。
		if (declared?.kind === "state" || (declared === undefined && (isSource(value) || isReadableLike(value)))) {
			let readable = this.readables.get(name);
			if (readable === undefined) {
				readable = new MemberReadable(this, name);
				this.readables.set(name, readable);
			}
			return readable;
		}
		// 当前不可读或成员不属于当前变体：返回 undefined，读取 value 时再抛 not_ready/not_in_variant。
		if (view === undefined || !this.inVariant(view, name)) return undefined;
		// expose 包装的资源只在引用 live 后可读；ResourceImpl.value 会检查状态。
		return value instanceof ExposedImpl ? value.resource.value : value;
	}

	// 为方法创建并缓存调用包装：处理无参数方法的 ctx 位置、工厂内禁止调用、ctx 归属和根复用。
	// 无 ctx 或 holder 时开新根；普通 ctx 直接复用当前根，保证调用树共享代码版本与租约。
	caller(name: string): (...given: unknown[]) => Promise<unknown> {
		let caller = this.callers.get(name);
		if (caller === undefined) {
			// 无参数方法的调用形式是 ref.name(ctx)，需要把第一个实参解释成 ctx。
			const noArgs = takesNoArgs(this.contract, name);
			caller = (...given) => {
				// A method without arguments is called as `ref.name(ctx)`.
				// 解构实参；类型断言描述调用约定，不做运行时校验。
				const [args, ctx] = (noArgs ? [undefined, given[0]] : given) as [unknown, Ctx | undefined];
				// 工厂运行期间不能调用方法：此时对象尚未安装实现，调用会造成重入。
				if (this.object.host.inFactory > 0) {
					throw new ChordError("not_ready", `${this.address}.${name} called inside a factory`);
				}
				// ctx 必须由 Chord 宿主创建；instanceof 是跨实现的运行时检查（trust boundary）。
				if (ctx !== undefined && !(ctx instanceof CtxImpl)) {
					return Promise.reject(invalid("foreign_ctx", "ctx must come from a Chord host"));
				}
				// 普通调用复用调用方 ctx；只有根入口或任务（holder）需要开新根。
				if (ctx === undefined || ctx.holder) {
					// A code holder (task) starts a fresh root per call, cancelled with the holder.
					try {
						ctx?.check(this.object.host);
					} catch (error) {
						return Promise.reject(error);
					}
					return this.object.host.root((root) => this.object.call(this, name, args, root as CtxImpl), {
						signal: ctx?.signal,
					});
				}
				// 已经在同一根中，直接进入对象调用；参数/结果校验在 ObjectImpl.call 内完成。
				return this.object.call(this, name, args, ctx);
			};
			this.callers.set(name, caller);
		}
		return caller;
	}

	// 停止所有状态成员的订阅；引用结束时调用。
	#stopReadables(): void {
		for (const readable of this.readables.values()) readable.stop();
	}
}

// 从实现对象读取 variant 字段；远程契约用它选择成员表，本地实现通常不设置，非字符串视为无变体。
export const variantOf = (implementation: Record<string, unknown>): string | undefined =>
	typeof implementation.variant === "string" ? implementation.variant : undefined;

// ─── Objects ─────────────────────────────────────────────────────────────────

// 对象状态机：activating 包含工厂、打开资源、init 等所有激活步骤；failed 是激活失败后的终态；
// disposing/disposed 只在销毁过程中出现，避免把“正在清理”当成可调用。
export type ObjectStatus = "activating" | "live" | "failed" | "disposing" | "disposed";

// 重载 gate：暂停新调用与监听器事件，等待已有租约的根结束；队列中的事件在 commit/abort 后重放。
interface Gate {
	// 已经触碰过对象的根 id；它们被允许在 gate 期间继续，直到 rootEnded 释放。
	readonly grandfathered: Set<string>;
	// gate 期间产生的监听器事件；提交后按原顺序重新交付。
	readonly queue: { readonly key: string; readonly event: unknown }[];
	// 最后一个祖父根结束时调用，唤醒等待 gate 的重载。
	drained: () => void;
}

// 一条已激活的监听器订阅；origin 记录声明来源，select 用于判断重载能否保留。
interface Subscription {
	/** What the listener was declared on: the resource (not its facade), or the source itself. */
	// 资源用真实 ResourceImpl、事件源用源对象本身；重载比较它与 select 文本。
	readonly origin: unknown;
	readonly select: ListenerDecl["select"];
	unsubscribe: () => void;
}

/**
 * Two `select` functions are the same if they are identical or have the same source text: an inline arrow is a new
 * object on every factory run, but its code is what matters. (A select whose implementation depends on captured values
 * that change between runs is not detected; such a listener keeps its old subscription until its source changes.)
 */
// 判断两个 select 是否等价：同一函数或源码文本相同。内联箭头函数每次运行都是新对象，但文本相同，
// 因此重载可以保留订阅；依赖捕获值且文本相同的 select 不会被识别，这是已知限制。
const sameSelect = (a: ListenerDecl["select"], b: ListenerDecl["select"]): boolean =>
	a === b || (a !== undefined && b !== undefined && String(a) === String(b));

/** Listener subscriptions made ahead of a commit: `activate` switches over, `discard` drops them. */
// prepare 阶段预订阅监听器的结果：commit 时 activate，rollback 时 discard。
export interface StagedListeners {
	activate(): void;
	discard(): void;
}

// 正在运行的任务：controller 用于停止，done 供下一次启动等待旧运行结束。
interface RunningTask {
	readonly controller: AbortController;
	readonly done: Promise<void>;
}

// 创建 ObjectImpl 所需的最小身份信息；地址已由宿主归一化输入后计算。
export interface ObjectIdentity {
	// 对象地址；同一个地址在宿主对象表里只对应一个 ObjectImpl。
	readonly address: string;
	// 契约类型名；激活时用它查找 Service，重载时按它判断类型是否变化。
	readonly typeName: string;
	// 归一化后的输入；工厂拿到的就是它，地址也由它和 principal 共同决定。
	readonly input: unknown;
	readonly principal: unknown;
	/** The one object of a `lifetime: "host"` type. */
	// 是否是 host 生命周期类型；决定对象能否写注册表、是否由宿主固定引用。
	readonly hostLifetime: boolean;
}

/**
 * 一个由宿主管理的对象。它负责激活事务、按代码版本保存实现、引用租约、监听器/任务运行时、
 * 调用分派和销毁。所有方法都在同一事件循环中运行；需要原子性的安装步骤在同步代码中完成。
 * 错误：激活/清理错误通过 ready Promise 与 host.report 传播；调用错误通过 Promise 拒绝。
 */
export class ObjectImpl {
	// 对象所属宿主；地址计算、根、代码版本和错误报告都通过它。
	readonly host: HostCore;
	// 对象地址；同一个地址在宿主对象表里只对应一个 ObjectImpl。
	readonly address: string;
	// 契约类型名；激活时用它查找 Service，重载时按它判断类型是否变化。
	readonly typeName: string;
	// 归一化后的输入；工厂拿到的就是它，地址也由它和 principal 共同决定。
	readonly input: unknown;
	// 创建对象时的调用者身份；对象内部代码以宿主身份行动，但对象本身保留这个 principal。
	readonly principal: unknown;
	/** The one object of a `lifetime: "host"` type: only such objects may register. */
	// host 生命周期对象由宿主固定引用，只有它能注册；接口在首次 get 时创建。
	readonly hostLifetime: boolean;
	// 初始状态是 activating；只有 #activate 成功后才改为 live。
	status: ObjectStatus = "activating";
	// 激活完成的 Promise；start() 会替换它。默认已完成，避免构造后未 start 时出现未处理等待。
	ready: Promise<void> = Promise.resolve();
	// 当前使用的服务；激活时写入，重载提交时由 Reload.install 替换。
	service: Service | undefined;
	/** Calls carrying an older code version are rejected upgrade_conflict (state bump or exclusive resource replaced). */
	// 允许调用该对象的最低代码版本；迁移或独占资源替换后提高，旧根调用得到 upgrade_conflict。
	minCodeVersion = 0;
	// 当前声明；激活前是空集合，提交重载时整体替换。
	decls = new Decls();
	/** Declarations of a factory run that has not been installed yet (activation or reload candidate). */
	// 尚未安装或丢弃的候选声明；跨对象引用环检查会遍历它。
	readonly pending = new Set<Decls>();
	// 代码版本 → 已安装实现；同一对象可能同时保留新旧版本，服务跨重载的旧根。
	readonly implementations = new Map<number, Installed>();
	// 当前存活的本地引用；引用计数决定对象何时空闲。
	readonly refs = new Set<RefImpl>();
	// 根 id → 代码版本；gate 用这些根判断是否还有在途工作。
	readonly leases = new Map<string, number>();
	// 资源成功打开的顺序；关闭时逆序进行，保证依赖后关闭。
	readonly openOrder: ResourceImpl[] = [];
	// 中止对象调用与监听器根的信号；强制销毁或激活失败时触发。
	readonly callAbort = new AbortController();
	// 中止激活事务的信号；销毁时触发，使打开资源/init 尽快结束。
	readonly activationAbort = new AbortController();
	// 非 undefined 表示对象处于重载 gate 中；新调用和监听器事件会被拒绝或排队。
	gate: Gate | undefined;
	/** Served only by a running reload's pending code version: listeners, tasks and registrations start at its commit. */
	// true：对象只由重载候选服务提供，监听器/任务/注册表要等 commit 才启动。
	deferredRuntime = false;
	// 已激活的监听器订阅，按声明名索引；跨重载保留时复用。
	readonly #subscriptions = new Map<string, Subscription>();
	// 正在运行的方法/监听器调用；销毁要等它们全部结束。
	readonly #invocations = new Set<Promise<unknown>>();
	// 位置键 → 运行中的任务；停止时逐个 abort。
	#tasks = new Map<string, RunningTask>();
	/** Aborted task runs that have not finished yet. */
	// 已被中止但尚未结束的任务；下一次启动会等待或超时后继续。
	readonly #stopped = new Set<Promise<void>>();
	/** Bumped by every start and stop of the tasks: a delayed start that is no longer the latest is dropped. */
	// 任务代际计数；每次 start/stop 递增，延迟启动回调据此丢弃过期启动。
	#taskRuns = 0;
	// linger 定时器；undefined 表示没有待执行的销毁。
	#linger: ReturnType<typeof setTimeout> | undefined;
	// 销毁 Promise 缓存，保证 dispose 幂等。
	#disposal: Promise<void> | undefined;

	// 构造函数只保存身份，不启动激活；start() 才把 ready 接上激活事务。
	constructor(host: HostCore, identity: ObjectIdentity) {
		this.host = host;
		this.address = identity.address;
		this.typeName = identity.typeName;
		this.input = identity.input;
		this.principal = identity.principal;
		this.hostLifetime = identity.hostLifetime;
	}

	/**
	 * 启动激活。after 是可选的前置屏障（例如 child host 等待父宿主）；返回 void，进度体现在 ready。
	 * 成功：所有引用 live，并在无引用/调用时检查是否需要销毁。
	 * 失败：若仍在 activating，状态变为 failed；宿主忘记该对象，引用 gone；错误规范化为 ChordError。
	 * 副作用：执行工厂、打开资源、运行 init、启动监听器/任务，均发生在 #activate 内。
	 */
	start(after: Promise<void> | undefined): void {
		// 成功分支把引用置 live；失败分支统一失败处理并重新抛出。
		this.ready = this.#activate(after).then(
			() => {
				for (const ref of this.refs) ref.live();
				this.#maybeIdle();
			},
			(cause: unknown) => {
				if (this.status === "activating") this.status = "failed";
				// 激活失败的对象不再按地址命中；后续 get 会创建新对象并重试。
				this.host.forget(this);
				// A ChordError (forbidden, a dependency's error, ...) keeps its code; anything else is `unavailable`.
				// ChordError 保留原 code；其他异常变成 unavailable，并携带原 cause。
				const error = asChordError(cause, `activating ${this.address}`);
				// 每个等待中的引用都收到同一失败原因。
				for (const ref of this.refs) ref.gone(error);
				throw error;
			},
		);
		this.ready.catch(noop);
	}

	/**
	 * Activation as one transaction: factory, opens, then a synchronous finalization (registry check and publication,
	 * implementations, runtime). Every failure, including one during finalization or a release while listeners start,
	 * unwinds everything this activation did.
	 */
	/**
	 * 激活事务的主体。任何一步失败都会撤销本次运行创建的资源、引用和派生，然后重新抛出原始错误。
	 * 步骤：等待屏障 → 查服务 → 运行工厂 → 打开资源/等待引用 → 等待水合 → 执行 init → 校验注册 →
	 * 安装实现 → 计算派生 → 刷新 schema → 启动运行时 → 标记 live。
	 */
	async #activate(after: Promise<void> | undefined): Promise<void> {
		// 等待前置屏障，但屏障失败不应阻止本对象尝试激活；真正的失败由宿主另行处理。
		await after?.catch(noop);
		// 整个激活事务共享一个取消信号；强制销毁会中止它。
		const signal = this.activationAbort.signal;
		// 统一的“激活被放弃”错误；地址帮助定位，code 为 aborted。
		const abandoned = (): ChordError => new ChordError("aborted", `${this.address} abandoned`);
		// 前置等待期间已被销毁：不再运行工厂。
		if (signal.aborted) throw abandoned();
		// 按类型名查当前服务；重载期间宿主会返回候选服务表。
		const service = this.host.service(this.typeName);
		// 类型未被提供：unavailable/unknown_type，引用会 gone。
		if (service === undefined)
			throw new ChordError("unavailable", `${this.typeName} is not served`, { reason: "unknown_type" });
		this.service = service;
		// 运行工厂并记录声明；这一步可能创建引用/资源，尚未打开。
		const run = this.run(service, undefined);
		try {
			// 打开资源并等待引用；两件事并行，失败时其他已开始的步骤也会收尾。
			await this.open(run.created.resources, run.created.refs, signal);
			if (signal.aborted) throw abandoned();
			// 本地对象必须等到状态源有值才 live，包括来自远端成员的转发/派生。
			await this.waitHydrated(run);
			if (signal.aborted) throw abandoned();
			// 执行异步 init；成功后单元格才有首值。
			await this.initCells(run, signal);
			if (signal.aborted) throw abandoned();
			// 注册冲突在发布前检查；失败会让整个激活回滚。
			this.host.checkRegistrations(this, run.decls);
			// 从候选声明切换为当前声明；运行时和清理都使用它。
			this.decls = run.decls;
			// 同一实现可服务多个保留代码版本；旧根仍按自己的 codeVersion 调用。
			for (const [retained, services] of this.host.retainedCodeVersions()) {
				if (services.get(this.typeName) === service) {
					this.implementations.set(retained, {
						codeVersion: retained,
						service,
						implementation: run.implementation,
						decls: run.decls,
					});
				}
			}
			// 确认当前版本或正在准备的版本至少有一个实现，否则代码在激活期间被换掉。
			const pending = this.host.pendingCodeVersion();
			if (
				!this.implementations.has(this.host.currentCodeVersion()) &&
				(pending === undefined || !this.implementations.has(pending))
			) {
				throw new ChordError("superseded", `${this.address}: code changed during activation`);
			}
			// 派生只在这里计算首值并开始跟随源；工厂内不能这么做。
			for (const derived of run.created.derives) derived.attach();
			// 把远程状态 schema 写回单元格，dev 模式下用于每次写入校验。
			this.refreshSchemas();
			// Served only by a running reload's pending code version: new code must not run (listeners, tasks,
			// registrations) before that reload commits.
			// 如果当前代码版本没有实现，说明对象只由重载候选服务提供；运行时必须等到 commit。
			this.deferredRuntime = !this.implementations.has(this.host.currentCodeVersion());
			// 正常激活或当前版本已安装：立即发布注册表并启动运行时。
			if (!this.deferredRuntime) {
				if (run.decls.registrations.size > 0) this.host.registriesChanged(this);
				this.startRuntime();
			}
			// A listener starting up may have released the last reference synchronously: no resurrection.
			if (signal.aborted) throw abandoned();
			// 所有步骤成功后才对引用开放；此前引用保持 loading。
			this.status = "live";
		} catch (error) {
			// Invocations started during finalization (listener roots) end before their resources close.
			// 取消激活收尾期间启动的监听器根/调用；下面还会停止任务和订阅。
			this.callAbort.abort(error);
			this.stopListeners();
			this.stopTasks();
			// 只有已发布过注册表的对象才需要重建；deferredRuntime 的对象尚未发布。
			const registered = this.decls.registrations.size > 0 && !this.deferredRuntime;
			this.implementations.clear();
			this.decls = new Decls();
			if (registered) this.host.registriesChanged();
			// 等待收尾期间的调用和被中止任务结束，再关闭资源，避免清理与使用并发。
			await Promise.allSettled([...this.#invocations, ...this.#stopped]);
			// 回滚本次 run 新建的资源/引用/派生；清理错误只报告，原始激活错误优先。
			await this.unwind(run).catch((cleanup: unknown) => this.host.report(cleanup));
			throw error;
		} finally {
			// 无论安装还是丢弃，候选声明不再属于 pending 集合。
			this.pending.delete(run.decls);
		}
	}

	/**
	 * Runs the factory synchronously. With `previous`, runs in recording mode for a reload prepare. The run's
	 * declarations stay in `pending` (visible to the cycle check) until the caller installs or discards them.
	 */
	/**
	 * 同步运行工厂并记录声明。previous 存在表示这是重载 prepare 的记录模式：状态/资源/引用可复用旧实例。
	 * 返回 Run；工厂抛错或实现不合法时清理本次已创建对象并抛出。
	 * 副作用：可能创建引用和资源（尚未打开）；工厂必须同步返回。
	 */
	run(service: Service, previous: Decls | undefined): Run {
		// 每次运行都用新的 SelfImpl，声明表与创建列表互不污染。
		const self = new SelfImpl(this, previous);
		// 失败路径：从 pending 移除并异步撤销本次 run，清理错误报告给宿主。
		const discard = (run: Run): void => {
			this.pending.delete(run.decls);
			void this.unwind(run).catch((cleanup: unknown) => this.host.report(cleanup));
		};
		// 在调用工厂前就把空声明放进 pending，使跨对象引用环检测能看到这次运行。
		this.pending.add(self.run(undefined).decls);
		// 计数期间禁止读取资源值、写状态和调用方法。
		this.host.inFactory++;
		let implementation: unknown;
		try {
			// 工厂必须同步返回；这里传入归一化输入、principal 和 self。
			implementation = service.factory(this.input, this.principal, self);
		} catch (error) {
			// 工厂抛错时也要先减少计数，再撤销已创建对象并原样抛出。
			this.host.inFactory--;
			discard(self.run(undefined));
			throw error;
		}
		this.host.inFactory--;
		// 把工厂返回值组装成 Run；之后再校验实现形状。
		const run = self.run(implementation);
		try {
			// 工厂返回 Promise 是用法错误；运行时无法 await，因为签名要求同步。
			if (implementation instanceof Promise)
				throw invalid("implementation", `${this.typeName}: factories must be synchronous`);
			// 校验实现形状；失败时清理本次 run。
			validateImplementation(service, run.implementation);
		} catch (error) {
			discard(run);
			throw error;
		}
		return run;
	}

	/** Opens resources (dependencies first) and waits for references; settles all before failing. */
	/**
	 * 打开本次 run 的资源并等待引用就绪。依赖资源先打开；所有打开与引用等待并行进行，
	 * 用 Promise.allSettled 收尾，确保一个失败时其他已开始的步骤也能结束，再抛第一个失败原因。
	 */
	async open(resources: readonly ResourceImpl[], refs: readonly RefCore[], signal: AbortSignal): Promise<void> {
		// 记忆化打开：同一资源在一次 open 中只打开一次。
		const opening = new Map<ResourceImpl, Promise<void>>();
		const openOne = (resource: ResourceImpl): Promise<void> => {
			let promise = opening.get(resource);
			if (promise === undefined) {
				promise = (async () => {
					// 先完成依赖：引用等待 ready；资源若属于本次列表就递归打开；不在列表中的视为已打开。
					await Promise.all(
						resource.deps.map((dep) =>
							!(dep instanceof ResourceImpl) ? dep.ready : resources.includes(dep) ? openOne(dep) : undefined,
						),
					);
					// 依赖就绪后打开自身；成功会把自己加入 openOrder。
					await resource.open(signal, this.openOrder);
				})();
				opening.set(resource, promise);
			}
			return promise;
		};
		// 所有引用就绪与资源打开同时进行；超时信息列出仍在 loading 的地址。
		const ready = this.withinReadyTimeout(Promise.all(refs.map((ref) => ref.ready)), () =>
			refs.filter((ref) => ref.status === "loading").map((ref) => ref.address),
		);
		// allSettled 等所有步骤落定，避免一个失败后其他打开过程继续无人管理。
		const results = await Promise.allSettled([...resources.map(openOne), ready]);
		// 按结果顺序取第一个拒绝；其余拒绝已被 allSettled 收集但不再单独报告。
		const failure = results.find((result) => result.status === "rejected");
		if (failure !== undefined) throw failure.reason;
	}

	/**
	 * Waits until the state sources a run exposes or derives from have their values: a local object goes live only with
	 * its state, also where it forwards or derives from a remote reference's member.
	 */
	/**
	 * 等待状态源就绪：远程引用成员在第一次快照前没有值，派生自它的值也不能上线。
	 * 输入是本次 run；成功返回 void，超时抛 unavailable/ready_timeout 并列出仍在等待的地址。
	 */
	async waitHydrated(run: Run): Promise<void> {
		// 实现的每个成员都可能是状态源或资源包装；unhydrated 只挑出尚未水合的。
		const exposed = Object.entries(run.implementation ?? {});
		// 派生和实现暴露的值一起检查；没有 HYDRATION 的源视为已就绪。
		const pending = unhydrated([...run.created.derives, ...exposed.map(([, value]) => value)]);
		// 全部已水合：不需要等待，也不需要设置超时。
		if (pending.length === 0) return;
		// 等待每个水合完成；超时回调说明仍在等待的成员名或派生 key。
		await this.withinReadyTimeout(Promise.all(pending.map((hydration) => hydration.whenHydrated())), () => [
			...exposed
				.filter(([, value]) => hydrationOf(value)?.hydrated === false)
				.map(([name]) => `${this.address}.${name}`),
			...run.created.derives
				.filter((derived) => hydrationOf(derived) !== undefined)
				.map((derived) => `derive ${derived.key}`),
		]);
	}

	/** `work` within the host's `readyTimeout`; a timeout names what is still awaited. */
	// 用宿主 readyTimeout 包装 work；有限值才设时钟，超时错误会调用 waiting() 说明卡在哪里。
	// 定时器 unref，避免仅因等待就阻止 Node 进程退出。
	async withinReadyTimeout<T>(work: Promise<T>, waiting: () => readonly string[]): Promise<T> {
		const ms = this.host.readyTimeout;
		// Infinity/NaN 表示不设超时；直接等待 work。
		if (!Number.isFinite(ms)) return work;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// 超时分支永不 resolve；回调在触发时再收集等待列表，避免额外开销。
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				// 超时瞬间再计算仍在等待的地址，避免提前做额外工作。
				const list = waiting();
				reject(
					new ChordError(
						"unavailable",
						`${this.address} was not ready after ${ms} ms${list.length === 0 ? "" : `, waiting on ${list.join(", ")}`} (a reference cycle across hosts?)`,
						{ reason: "ready_timeout" },
					),
				);
			}, ms);
			// unref 允许 Node 在只剩这个超时等待时退出；浏览器环境没有 unref，可选调用即可。
			(timer as { unref?: () => void }).unref?.();
		});
		// 超时 Promise 可能先于 work 落定；挂一个空 catch 防止未处理拒绝。
		timeout.catch(noop);
		try {
			// 成功返回 work；超时返回带地址与等待列表的 ready_timeout 错误。
			return await Promise.race([work, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Fills the cells `run` created with `init`, each in a root of its own, in parallel; settles all before failing. Runs
	 * after the run's resources are open and its references live, before anything reads the cells.
	 */
	/**
	 * 并行执行本次 run 的 init：每个 init 在独立根中运行（以宿主 principal 身份），
	 * 返回值经 schema 校验后写入单元格。所有 init 都结束后才统一抛第一个错误。
	 */
	async initCells(run: Run, signal: AbortSignal): Promise<void> {
		// 没有 init 单元格：无需创建根或等待。
		if (run.created.inits.length === 0) return;
		const results = await Promise.allSettled(
			run.created.inits.map(async ([cell, init]) => {
				// init 在宿主根中执行，可调用 ctx.get 等方法；activation 信号取消时根也会取消。
				const value = await this.host.root((ctx) => init(ctx), { signal });
				// 激活已取消时不要再写单元格；资源会被回滚。
				if (!signal.aborted) cell.initialize(value);
			}),
		);
		// 任一 init 失败就使整个激活失败；其他 init 已被 allSettled 等完。
		const failure = results.find((result) => result.status === "rejected");
		if (failure !== undefined) throw failure.reason;
	}

	/** Undoes the objects a run created: closes its resources (reverse order) and releases its references. */
	// 撤销一次 run：先 detach 派生，再按打开顺序的逆序关闭资源，最后释放引用。
	// runAll 确保某个清理失败时其余清理仍会执行。
	async unwind(run: Run): Promise<void> {
		// 先停止派生跟随源，避免资源关闭期间仍触发重算。
		for (const derived of run.created.derives) derived.detach();
		// 复制后按 openOrder 逆序排序：后打开的资源可能依赖先打开的。
		const resources = [...run.created.resources].sort(
			(a, b) => this.openOrder.indexOf(b) - this.openOrder.indexOf(a),
		);
		// 清理任务按“资源（逆序）→ 引用”排列；错误汇总后由调用方报告。
		await runAll(
			[
				...resources.map((resource) => () => resource.close(this.openOrder)),
				...run.created.refs.map((ref) => () => ref.release()),
			],
			`${this.address}: cleanup failed`,
		);
	}

	// 当前代码版本的实现；若当前版本没有（重载 prepare 期间），退回到最近安装的版本。
	currentInstalled(): Installed | undefined {
		return this.implementations.get(this.host.currentCodeVersion()) ?? [...this.implementations.values()].at(-1);
	}

	/** Every state source exposed as a remote state member gets that member's schema (checked per write in dev mode). */
	// 汇总所有已安装实现暴露的远程状态成员 schema，并写回各 run 的 Cell/Derived。
	// dev 模式下 Cell.validate 会按这里的 schema 校验每次写入。
	refreshSchemas(): void {
		// 同一个源可能被多个远程契约成员引用，因此值是 schema 列表。
		const schemas = new Map<Readable<unknown>, Schema[]>();
		for (const installed of this.implementations.values()) {
			for (const [source, list] of memberSchemas(installed.service, installed.implementation)) {
				schemas.set(source, [...(schemas.get(source) ?? []), ...list]);
			}
		}
		for (const decls of this.allDecls()) {
			// 不在列表中的源清空 schema；这会在实现替换后移除旧约束。
			for (const source of [...decls.cells.values(), ...decls.derives.values()])
				source.schemas = schemas.get(source) ?? [];
		}
	}

	// 当前声明、重载候选和所有已安装版本的声明；销毁时要全部清理。
	allDecls(): Set<Decls> {
		const result = new Set<Decls>([this.decls, ...this.pending]);
		for (const installed of this.implementations.values()) result.add(installed.decls);
		return result;
	}

	// ─── runtime: listeners and tasks of the current declarations ───

	/** The resource a listener is declared on, or its source itself. */
	// 监听器来源归一化：资源用真实 ResourceImpl 而不是 façade，便于重载比较。
	#origin(decl: ListenerDecl): unknown {
		return resourceOf(decl.source) ?? decl.source;
	}

	/** Resolves a listener's subscribable: `select(resource value)`, `select(source)` or the source itself. */
	// 解析监听器的实际可订阅源：资源先取 value，再应用可选 select；
	// 结果必须有 subscribe 函数，否则抛 invalid/implementation。
	#listenSource(key: string, decl: ListenerDecl): Subscribable<unknown> {
		const resource = resourceOf(decl.source);
		const value = resource === undefined ? decl.source : resource.value;
		// select 的输入类型被擦除为 never 以统一存储；这里的断言不改变运行时行为。
		const source = (decl.select === undefined ? value : decl.select(value as never)) as Subscribable<unknown>;
		// 运行时检查可订阅形状；这是工厂作者的信任边界。
		if (typeof source?.subscribe !== "function")
			throw invalid("implementation", `listener ${key}: source has no subscribe()`);
		return source;
	}

	/**
	 * Subscribes the listeners of `decls` without delivering: events are buffered until `activate`. A listener declared
	 * on the same resource (or source) with the same `select` keeps its subscription without calling `select` again
	 * (only its function is swapped, by name), so sources that accept a single subscriber survive reloads. Throws, with
	 * nothing left subscribed, if any source fails.
	 */
	/**
	 * 为一次 run 预订阅监听器，但不交付事件。输入 decls；返回 activate/discard 控制。
	 * 保留规则：同名字、同 origin、同 select 的旧订阅直接复用，避免重载时重新订阅单订阅源。
	 * 状态源延迟到 activate 再订阅，确保拿到 commit 后的当前值；事件源立即订阅并把事件缓冲到 activate。
	 * 失败时取消所有新订阅并抛出，保证 prepare 失败不会留下半订阅状态。
	 */
	stageListeners(decls: Decls): StagedListeners {
		type Fresh = Subscription & { buffer: unknown[] | undefined; subscribe?: () => void };
		// 本次新增或替换的订阅；kept 记录直接复用的旧订阅名。
		const fresh = new Map<string, Fresh>();
		// 直接复用的旧订阅名；activate 时不会取消它们。
		const kept = new Set<string>();
		try {
			for (const [key, decl] of decls.listeners) {
				const origin = this.#origin(decl);
				const previous = this.#subscriptions.get(key);
				// 同来源同 select：保留旧订阅，只更新处理函数（处理函数在 #deliver 时按名字查当前 decl）。
				if (previous !== undefined && previous.origin === origin && sameSelect(previous.select, decl.select)) {
					kept.add(key);
					continue;
				}
				// 新订阅需要现在解析源；解析失败会进入 catch 并取消已建立的新订阅。
				const source = this.#listenSource(key, decl);
				const entry: Fresh = {
					origin,
					select: decl.select,
					unsubscribe: noop,
					buffer: [],
				};
				fresh.set(key, entry);
				// State (a readable) is subscribed when the listener activates: it delivers the value current then, not one
				// of the candidate before the commit (a new derivation computes its value at the commit).
				// 状态源延迟到 activate：候选派生在 commit 前尚未算值，提前订阅会交付旧值。
				if (isSource(source) || isReadableLike(source)) {
					entry.buffer = undefined;
					entry.subscribe = () => {
						// 状态源在 activate 时才调用 subscribe；事件直接交付。
						entry.unsubscribe = source.subscribe((event) => this.#deliver(key, event));
					};
					continue;
				}
				// 事件源立即订阅；buffer 未清空前只入队，等 activate 后按顺序交付。
				entry.unsubscribe = source.subscribe((event) => {
					if (entry.buffer !== undefined) entry.buffer.push(event);
					else this.#deliver(key, event);
				});
			}
		} catch (error) {
			// 任一来源失败：取消所有新订阅后抛出，保持无半订阅状态。
			for (const entry of fresh.values()) entry.unsubscribe();
			throw error;
		}
		return {
			// 先移除被替换的旧订阅，再安装新订阅；状态源在此刻才 subscribe。
			activate: () => {
				for (const [key, subscription] of this.#subscriptions) {
					if (kept.has(key)) continue;
					subscription.unsubscribe();
					this.#subscriptions.delete(key);
				}
				for (const [key, entry] of fresh) {
					this.#subscriptions.set(key, entry);
					entry.subscribe?.();
					const buffered = entry.buffer ?? [];
					entry.buffer = undefined;
					for (const event of buffered) this.#deliver(key, event);
				}
			},
			// prepare 失败或候选对象未 live：只取消本次新订阅，旧订阅不受影响。
			discard: () => {
				for (const entry of fresh.values()) entry.unsubscribe();
			},
		};
	}

	// 激活当前声明的监听器和任务；正常激活与重载提交都走这里。
	startRuntime(): void {
		this.stageListeners(this.decls).activate();
		this.startTasks();
	}

	/**
	 * Starts the tasks of the current declarations. Runs aborted by `stopTasks` (a reload, a gate) may still be finishing:
	 * their replacements start once they all finished, or after `taskStopDeadline` (reported), so the old and the new run
	 * of a task never work side by side. A later start or stop, or the object leaving `live`, cancels a delayed start.
	 */
	/**
	 * 启动当前声明的任务。若上一代任务仍未结束，先等待它们全部结束或到达 taskStopDeadline；
	 * 超时会报告并仍然启动新任务，避免旧任务永久阻塞重载。
	 * 延迟启动会被后续 start/stop 或对象离开 live 取消。
	 */
	startTasks(): void {
		// 每次启动/停止递增；延迟回调据此判断自己是否已过期。
		const run = ++this.#taskRuns;
		// 按位置键启动所有任务；任务没有名字，键只用于停止和替换。
		const start = (): void => {
			for (const key of this.decls.tasks.keys()) this.#startTask(key, this.host.currentCodeVersion());
		};
		// 没有待结束的旧任务：可以立即启动。
		if (this.#stopped.size === 0) {
			start();
			return;
		}
		// 旧任务最多再等这么久；超时后新任务仍会启动，并报告旧任务未停。
		const deadline = this.host.taskStopDeadline;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// late 在截止时间后 resolve true，表示“错过了”旧任务的结束。
		const late = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), deadline);
		});
		// 全部旧任务结束后 resolve false；allSettled 不会因旧任务失败而提前。
		const stopped = Promise.allSettled([...this.#stopped]).then(() => false);
		// 谁先完成都可以；回调里再检查代际和对象状态，避免过期启动。
		void Promise.race([stopped, late]).then((missed) => {
			clearTimeout(timer);
			// 期间发生了新的 start/stop，或对象已不 live：本次延迟启动作废。
			if (run !== this.#taskRuns || this.status !== "live") return;
			if (missed) {
				this.host.report(
					new ChordError(
						"aborted",
						`${this.address}: aborted tasks still running after ${deadline} ms; starting their replacements anyway`,
					),
				);
			}
			start();
		});
	}

	// 取消并清空当前所有监听器订阅；激活失败和销毁会调用。重载只暂停任务，监听器由 stage/activate 切换。
	stopListeners(): void {
		for (const subscription of this.#subscriptions.values()) subscription.unsubscribe();
		this.#subscriptions.clear();
	}

	// 启动一个任务：创建子 AbortController 与 holder 上下文，任务根 id 为 task:地址:位置。
	#startTask(key: string, codeVersion: number): void {
		// 声明可能已被替换；找不到就跳过。
		const fn = this.decls.tasks.get(key);
		if (fn === undefined) return;
		// 每个任务独立控制器，stopTasks 只中止对应任务。
		const controller = new AbortController();
		// holder: true 让任务内的每次方法调用开新根，而不是共享任务根。
		const ctx = new CtxImpl(this.host, {
			signals: [controller.signal, this.callAbort.signal],
			rootId: `task:${this.address}:${key}`,
			codeVersion,
			principal: this.host.principal,
			holder: true,
		});
		const done = (async () => {
			try {
				await fn(ctx);
			} catch (error) {
				// 任务被取消时不报告，取消是预期路径；其他错误报告给宿主。
				if (!ctx.signal.aborted) this.host.report(error);
			} finally {
				// 任务结束关闭 ctx，释放它获取的引用并解绑信号。
				ctx.close();
				if (this.#tasks.get(key)?.controller === controller) this.#tasks.delete(key);
			}
		})();
		this.#tasks.set(key, { controller, done });
	}

	/**
	 * Aborts running tasks (and cancels a delayed start). Their completion is awaited by the next `startTasks` and at
	 * disposal; each leaves `#stopped` when it finishes.
	 */
	// 中止所有运行中的任务并清空任务表；已完成/将完成的 Promise 放进 #stopped，
	// 供下一次启动等待。递增 #taskRuns 使延迟启动失效。
	stopTasks(): void {
		this.#taskRuns++;
		// 逐个 abort 并登记完成 Promise；finally 中从 #stopped 移除。
		for (const task of this.#tasks.values()) {
			task.controller.abort(new ChordError("aborted", "task stopped"));
			const done = task.done;
			this.#stopped.add(done);
			void done.finally(() => this.#stopped.delete(done));
		}
		this.#tasks.clear();
	}

	/**
	 * Delivers one listener event, in publication order. The invocation is a root that references a lease on this object
	 * (a reload gate waits for it like for any other root that touched the object), counts as an invocation (disposal
	 * waits for it) and is cancelled by forced disposal.
	 */
	/**
	 * 交付一个监听器事件。事件先进入统一通知队列；若对象在 gate 中则排队，commit/abort 后重放。
	 * 每次交付在独立根中运行，并给对象加租约，使重载 gate 和销毁等待这次调用结束。
	 */
	#deliver(key: string, event: unknown): void {
		enqueue(() => {
			// gate 期间不运行监听器：把事件原样排队，等 openGate 用当前声明重放。
			if (this.gate !== undefined) {
				this.gate.queue.push({ key, event });
				return;
			}
			// 声明可能在重载后被移除；此时丢弃事件。
			const decl = this.decls.listeners.get(key);
			if (decl === undefined || (this.status !== "live" && this.status !== "activating")) return;
			// 监听器调用是新根；child ctx 额外监听对象的 callAbort。
			const invocation = this.host.root((root) => {
				// 记录根触碰对象，宿主 gate 会等待它结束。
				this.lease(root);
				// 根 ctx 一定是 CtxImpl；断言是因为 HostCore.root 的公共签名更宽。
				const child = (root as CtxImpl).child(this);
				return this.#invoke(async () => {
					try {
						await decl.fn(event, child);
					} finally {
						child.close();
					}
				});
			});
			// 监听器错误在后台报告，不影响事件来源。
			invocation.catch((error: unknown) => this.host.report(error));
		});
	}

	/** Opens the object's gate and replays queued listener events through the current listeners. */
	// 打开 gate：清空状态并按原顺序重放排队事件；重放时使用当前声明和当前实现。
	openGate(): void {
		const gate = this.gate;
		this.gate = undefined;
		for (const { key, event } of gate?.queue ?? []) this.#deliver(key, event);
	}

	// ─── calls ───

	/** Admission for a call or write carrying `ctx`. */
	/**
	 * 调用/写入准入检查：宿主失败、ctx 代码版本已退役、对象要求更高代码版本、
	 * 或 gate 未放行当前根时拒绝。无返回值；拒绝时抛对应 ChordError。
	 */
	admit(ctx: Ctx): void {
		// 提交失败后宿主进入终态，不再接受任何新工作。
		if (this.host.failed !== undefined) {
			throw new ChordError("unavailable", `${this.host.name} failed and admits no work`, { reason: "host_failed" });
		}
		// 代码版本已退役：旧根的下一次调用得到 superseded（可重试）。
		if (!this.host.hasCodeVersion(ctx.codeVersion))
			throw new ChordError("superseded", `code version ${ctx.codeVersion} is retired`);
		// 对象已迁移/升级，旧版本代码不能再读它的状态。
		if (ctx.codeVersion < this.minCodeVersion) {
			throw new ChordError(
				"upgrade_conflict",
				`${this.address} was upgraded in code version ${this.minCodeVersion}`,
			);
		}
		// gate 期间只允许已经触碰过对象的根；新根得到可重试的 upgrade_conflict。
		if (this.gate !== undefined && !this.gate.grandfathered.has(ctx.rootId)) {
			throw new ChordError("upgrade_conflict", `${this.address} is being upgraded`);
		}
	}

	/** Records that the root of `ctx` touched this object (a reload gate grandfathers it). */
	// 为一次根记录租约：同一根只记一次，并通知宿主该根触碰了此对象。
	lease(ctx: Ctx): void {
		// 同一根的多次调用共享一次租约；重复记录没有意义。
		if (this.leases.has(ctx.rootId)) return;
		this.leases.set(ctx.rootId, ctx.codeVersion);
		this.host.touch(ctx.rootId, this);
	}

	// 状态写入守卫，作为 WriteGuard 传给 Cell：工厂内禁止写；校验 ctx、取消和对象状态；
	// 任务根跳过 admit（任务已由对象生命周期管理），其他写入走正常准入。
	guard = (ctx: Ctx): void => {
		// 工厂必须只声明；写状态会使其他对象在激活中途看到不一致状态。
		if (this.host.inFactory > 0) throw invalid("read_only", "cells cannot be written while a factory runs");
		// 宿主内部 ctx 做完整校验；远端连接传入的兼容 Ctx 只做下面的信号检查。
		if (ctx instanceof CtxImpl) ctx.check(this.host);
		// 已取消的调用不能产生新写入。
		if (ctx.signal.aborted) throw new ChordError("aborted", "write with an aborted ctx");
		// 已销毁对象不再接受写入；disposing 阶段仍可能允许收尾写入。
		if (this.status === "disposed") throw new ChordError("gone", `${this.address} is disposed`);
		// 任务根由对象自身启动，跳过 gate 准入；对象销毁时会先中止任务。
		if (ctx.rootId.startsWith("task:")) return;
		// 检查宿主失败、代码版本和重载 gate；通过后才执行实现。
		this.admit(ctx);
	};

	/**
	 * 执行一次方法调用。ref/name/args/ctx 来自 RefImpl.caller；返回方法结果或 undefined（void）。
	 * 副作用：在根中租约对象、创建子 ctx、调用当前代码版本实现。
	 * 错误：引用或对象已结束、代码版本不匹配、变体不含该方法、参数/结果 schema 不匹配、
	 * 方法自身抛错，均以 Promise 拒绝。参数与结果校验只对远程契约执行。
	 */
	async call(ref: RefImpl, name: string, args: unknown, ctx: CtxImpl): Promise<unknown> {
		// 调用前再次校验 ctx；它可能在等待期间过期或被取消。
		ctx.check(this.host);
		if (ref.status === "released" || ref.status === "gone") throw ref.terminalError();
		// 引用仍在加载时等待激活；调用方取消则立即放弃。
		if (ref.status === "loading") await raceSignal(ref.ready, ctx.signal);
		// 引用或对象任一不 live：引用终态返回其错误，否则对象已 gone。
		if (ref.status !== "live" || this.status !== "live") {
			throw ref.status === "live"
				? new ChordError("gone", `${this.address} is ${this.status}`)
				: ref.terminalError();
		}
		this.admit(ctx);
		// 严格按调用方代码版本选择实现；没有就是 superseded，不能拿新代码顶替。
		const installed = this.implementations.get(ctx.codeVersion);
		if (installed === undefined)
			throw new ChordError(
				"superseded",
				`${this.address} has no implementation for code version ${ctx.codeVersion}`,
			);
		// 消费者视角的视图；旧契约可能经过 accepts 适配。
		const view = ref.viewOf(installed);
		const variant = variantOf(view);
		// 远程契约按当前变体查成员；本地契约使用唯一的空变体名。
		const wanted = ref.describe(ref.contract.scope === "remote" ? variant : LOCAL_VARIANT, name);
		const fn = view[name];
		// 实现里不是函数，或远程契约声明不是方法：not_in_variant。
		if (typeof fn !== "function" || (ref.contract.scope === "remote" && wanted?.kind !== "method")) {
			throw new ChordError(
				"not_in_variant",
				`${this.address}: ${name} is not a method of variant ${variant ?? "(local)"}`,
			);
		}
		// 没有适配器时视图就是实现本身；此时可以直接用提供方契约的 schema 校验。
		const direct = view === installed.implementation;
		const schema = direct
			? installed.service.contract.description.variants[variant ?? LOCAL_VARIANT]?.[name]
			: wanted;
		const method = schema?.kind === "method" ? schema : undefined;
		// 本地调用不做 wire 校验；远程调用按消费者契约的 schema 检查参数和结果。
		const validated = ref.contract.scope === "remote" ? method : undefined;
		// No arguments: the handler takes only ctx. No result (void): the caller gets undefined, whatever it returned.
		// 没有描述时按有参数处理；显式描述缺 args 表示无参数方法。
		const takesArgs = method === undefined || method.args !== undefined;
		// 没有描述时保留返回值；显式描述缺 result 表示 void。
		const returns = method === undefined || method.result !== undefined;
		let input: unknown;
		if (takesArgs) {
			// The additive rule assumes a consumer sends only what its own schema knows, and a provider sees only what its
			// schema knows: strip with both before validating.
			const own = ref.contract.scope === "remote" && wanted?.kind === "method" ? wanted.args : undefined;
			// 先按消费者 schema 剥离未知字段，防止把本端私有字段发给提供方。
			const sent = own === undefined ? args : cleaned(own, args);
			input = validated?.args ? cleaned(validated.args, sent) : sent;
			// 再按提供方 schema 校验；cleaned 只做结构裁剪，assertValid 才是严格校验。
			if (validated?.args) assertValid("args", `${this.address}.${name} args`, validated.args, input);
		}
		// 从调用开始给根加租约，使重载 gate 等待这次调用结束。
		this.lease(ctx);
		// 进入对象内部的 ctx：同根、同代码版本、宿主身份，并随对象强制销毁而取消。
		const child = ctx.child(this);
		let result: unknown;
		try {
			// 有参数时传 (args, ctx)，无参数时只传 ctx；这里用函数断言对应两种实现签名。
			result = await this.#invoke(() =>
				takesArgs
					? (fn as (args: unknown, ctx: Ctx) => unknown)(input, child)
					: (fn as (ctx: Ctx) => unknown)(child),
			);
		} finally {
			child.close();
		}
		// void 方法无论实现返回什么，调用者都得到 undefined。
		if (!returns) return undefined;
		// 只对远程契约校验结果；本地调用相信 TypeScript 与实现。
		if (validated?.result) assertValid("result", `${this.address}.${name} result`, validated.result, result);
		return result;
	}

	/** Runs an invocation (method or listener) that keeps the object alive until it settles. */
	// 包装一次方法/监听器调用：记录在 #invocations 中，调用结束后移除，并在对象空闲时检查销毁。
	#invoke<T>(fn: () => T | Promise<T>): Promise<T> {
		const invocation = (async () => fn())();
		this.#invocations.add(invocation);
		const done = (): void => {
			this.#invocations.delete(invocation);
			if (this.#invocations.size === 0) this.#maybeIdle();
		};
		invocation.then(done, done);
		return invocation;
	}

	// 根结束时释放租约；若 gate 正在等待这个根，最后一个根结束会触发 drained。
	rootEnded(rootId: string): void {
		this.leases.delete(rootId);
		const gate = this.gate;
		if (gate?.grandfathered.delete(rootId) && gate.grandfathered.size === 0) gate.drained();
	}

	// ─── lifetime ───

	// 新引用加入：取消 linger 定时器，避免对象在仍有引用时被销毁。
	addRef(ref: RefImpl): void {
		this.refs.add(ref);
		if (this.#linger !== undefined) clearTimeout(this.#linger);
		this.#linger = undefined;
	}

	// 引用释放：真正移除后才检查空闲；重复释放不会触发销毁逻辑。
	release(ref: RefImpl): void {
		if (this.refs.delete(ref)) this.#maybeIdle();
	}

	/** No references and no invocations: dispose (after `linger` for a live object). */
	// 判断对象是否空闲：无引用、无调用、无 linger 定时器时销毁。
	// activating 阶段没有引用就直接放弃激活；live 阶段按 linger 延迟；其他状态不处理。
	#maybeIdle(): void {
		// 仍有引用、调用或待销毁定时器时保持存活。
		if (this.refs.size > 0 || this.#invocations.size > 0 || this.#linger !== undefined) return;
		// 激活中就没有引用：不必等激活完成，直接后台销毁。
		if (this.status === "activating") {
			this.#background(this.dispose(false));
			return;
		}
		if (this.status !== "live") return;
		// 引用计数型可配置 linger；host 型选项保证没有 linger，因此为 0。
		const linger = this.service?.options.linger ?? 0;
		if (linger <= 0) {
			this.#background(this.dispose(false));
			return;
		}
		this.#linger = setTimeout(() => {
			this.#linger = undefined;
			if (this.refs.size === 0 && this.#invocations.size === 0 && this.status === "live") {
				this.#background(this.dispose(false));
			}
		}, linger);
		this.#linger.unref?.();
	}

	// 后台销毁的错误交给宿主报告，避免未处理的 Promise 拒绝。
	#background(disposal: Promise<void>): void {
		disposal.catch((error: unknown) => this.host.report(error));
	}

	/**
	 * Disposes the object. Forced: references become gone at once (new calls are rejected) and running invocations are
	 * cancelled. Either way, resources close only after every invocation settled.
	 */
	/**
	 * 幂等销毁：第一次调用创建 #disposal，后续返回同一 Promise。
	 * forced 为 true 时引用立即 gone、运行中的调用被取消；两种方式都要等调用结束后才关闭资源。
	 */
	dispose(forced: boolean, reason?: unknown): Promise<void> {
		this.#disposal ??= this.#dispose(forced, reason);
		return this.#disposal;
	}

	// 销毁主体：停止运行时、等待调用结束、撤销所有声明的派生/资源/引用，最后通知宿主。
	// 资源按 openOrder 逆序关闭；所有错误通过 runAll 汇总，但状态最终一定进入 disposed。
	async #dispose(forced: boolean, reason: unknown): Promise<void> {
		// 记录原状态：激活中的对象需要先等 ready 落定，再清理。
		const wasActivating = this.status === "activating";
		this.status = "disposing";
		// 从宿主对象表移除，阻止新引用命中正在销毁的对象。
		this.host.forget(this);
		if (this.#linger !== undefined) clearTimeout(this.#linger);
		this.#linger = undefined;
		const error = reason ?? new ChordError("gone", `${this.address} was disposed`);
		// 强制销毁：引用立即 gone，运行中的调用被 callAbort 取消。
		if (forced) {
			// 引用先进入终态，后续读取/调用立即得到 gone 错误。
			for (const ref of this.refs) ref.gone(error);
			// 取消所有方法/监听器根；非强制销毁则让它们自然结束。
			this.callAbort.abort(error);
		}
		// 中止可能仍在进行的激活/资源打开。
		this.activationAbort.abort(error);
		// 等激活事务收尾；它自己的 catch 已经回滚过，这里只等状态稳定。
		if (wasActivating) await this.ready.catch(noop);
		// 非强制销毁也把引用置 gone；对象已不可用。
		for (const ref of this.refs) ref.gone(error);
		// 收集当前、候选和所有保留版本的声明；每一份都要清理。
		const decls = this.allDecls();
		this.stopTasks();
		this.stopListeners();
		await Promise.allSettled([...this.#invocations]);
		// 只有实际发布过注册表的对象才需要重建注册表。
		const registered = [...decls].some((set) => set.registrations.size > 0) && !this.deferredRuntime;
		// 清空实现，释放对工厂代码和旧契约的引用。
		this.implementations.clear();
		// 清空当前声明；后续不应再有运行时读取。
		this.decls = new Decls();
		if (registered) this.host.registriesChanged();
		// 去重引用：同一引用可能被多个声明版本持有。
		const refs = new Set<RefCore>();
		for (const set of decls) {
			for (const derived of set.derives.values()) derived.detach();
			for (const ref of set.refs.values()) refs.add(ref);
		}
		try {
			await runAll(
				[
					() => Promise.allSettled([...this.#stopped]),
					...[...this.openOrder].reverse().map((resource) => () => resource.close(this.openOrder)),
					...[...refs].map((ref) => () => ref.release()),
				],
				`${this.address}: disposal failed`,
			);
		} finally {
			// 清理完成才进入 disposed；finally 保证即使清理失败也标记。
			this.status = "disposed";
			this.host.disposed(this);
		}
	}
}

// 结构判断：同时有 events 和 subscribe 的对象可作为状态源；用于接受适配器包装后的 readable。
const isReadableLike = (value: unknown): boolean =>
	value !== null &&
	typeof value === "object" &&
	typeof (value as Readable<unknown>).events === "function" &&
	typeof (value as Readable<unknown>).subscribe === "function";

/** The remote state-member schemas an implementation exposes, by source. */
/**
 * 返回远程实现中“状态成员 → schema 列表”的映射。输入服务与实现；无副作用。
 * 只处理 scope 为 remote、成员 kind 为 state、且值确实是 Cell/Derived 的成员；
 * 同一源可被多个 schema 引用。
 */
export function memberSchemas(
	service: Service,
	implementation: Record<string, unknown>,
): Map<Readable<unknown>, Schema[]> {
	const schemas = new Map<Readable<unknown>, Schema[]>();
	const contract = service.contract;
	// 本地契约没有远程状态成员，直接返回空表。
	if (contract.scope !== "remote") return schemas;
	// 只查实现当前变体的成员描述；variant 缺失时按空变体处理。
	const members = contract.description.variants[variantOf(implementation) ?? ""] ?? {};
	for (const [name, description] of Object.entries(members)) {
		const source = implementation[name];
		// 只收集 state 成员，且实现值必须是 Cell/Derived；opaque/method 不参与。
		if (description.kind !== "state" || !isSource(source)) continue;
		// 同一个源可能被多个成员/契约引用，因此累积 schema 而不是覆盖。
		schemas.set(source, [...(schemas.get(source) ?? []), description.schema]);
	}
	return schemas;
}

// 运行时校验工厂返回的实现：远程契约必须声明合法 variant 且不包含额外成员；
// 本地契约按 LOCAL_VARIANT 描述检查。方法必须是函数，状态必须是 Cell/Derived 或可读对象，
// opaque 不能缺失。这里不检查参数/结果类型。
function validateImplementation(service: Service, implementation: Record<string, unknown>): void {
	const contract = service.contract;
	// 统一把实现错误转成 invalid/implementation，消息带契约名。
	const fail = (message: string): never => {
		throw invalid("implementation", `${contract.name}: ${message}`);
	};
	// 工厂可能返回任意值；这是 JS/类型断言可绕过的信任边界。
	if (implementation === null || typeof implementation !== "object") fail("factory must return an object");
	let members: Readonly<Record<string, MemberDescription>>;
	if (contract.scope === "remote") {
		const variant = implementation.variant;
		// 远程契约必须声明已知 variant，否则成员表无从选择。
		if (typeof variant !== "string" || contract.description.variants[variant] === undefined)
			fail(`unknown variant ${String(variant)}`);
		members = contract.description.variants[variant as string]!;
		// 除 variant 外不允许额外成员：远程实现暴露的正是契约描述的集合。
		for (const key of Object.keys(implementation))
			if (key !== "variant" && members[key] === undefined) fail(`${key} is not in variant ${String(variant)}`);
	} else {
		// 本地契约只有 LOCAL_VARIANT 一组成员。
		members = contract.description.variants[LOCAL_VARIANT] ?? {};
	}
	for (const [name, description] of Object.entries(members)) {
		const value = implementation[name];
		// 方法成员必须是函数；状态成员必须是 Cell/Derived 或可读源；opaque 成员不能缺失。
		if (description.kind === "method" && typeof value !== "function") fail(`${name} must be a method`);
		if (description.kind === "state" && !isSource(value) && !isReadableLike(value)) {
			fail(`${name} must be a cell, a derivation or a held object's state member`);
		}
		if (description.kind === "opaque" && value === undefined) fail(`${name} is missing`);
	}
}

// ─── The factory's `self` ────────────────────────────────────────────────────

/**
 * Self 的运行时实现：在工厂执行期间把所有声明写入 #decls，把新创建的对象写入 #created。
 * previous 非空表示重载 prepare：可复用旧 Cell、引用和资源，以便比较和迁移。
 */
class SelfImpl implements Self {
	// 所属对象；声明最终由它安装和执行。
	readonly #object: ObjectImpl;
	// 上一代声明；非空时进入重载记录模式，可复用旧实例。
	readonly #previous: Decls | undefined;
	// 本次声明表；工厂返回后交给 ObjectImpl.run 组装成 Run。
	readonly #decls = new Decls();
	// 本次新建的对象；失败回滚只清理这些。
	readonly #created: Run["created"] = { refs: [], resources: [], derives: [], inits: [] };

	// 保存对象和上一代声明；构造函数不执行任何声明。
	constructor(object: ObjectImpl, previous: Decls | undefined) {
		this.#object = object;
		this.#previous = previous;
	}

	// 把当前声明与实现组装成 Run；第二次调用（带实现）才是真正的运行结果。
	run(implementation: unknown): Run {
		return { implementation: implementation as Record<string, unknown>, decls: this.#decls, created: this.#created };
	}

	/** Refuses a second declaration of `name` of one kind in this run (TypeScript cannot see string names). */
	// 拒绝同一类型里重复的名字；TypeScript 看不到字符串键的重复，因此这是运行时检查。
	#unique(map: ReadonlyMap<string, unknown>, kind: string, name: string): void {
		// 名字必须是非空字符串；JS 调用者可能传入任意值。
		if (typeof name !== "string" || name === "") throw new TypeError(`${kind} needs a name`);
		// 重复声明是作者错误，用 invalid/duplicate 报告。
		if (map.has(name)) throw invalid("duplicate", `${this.#object.typeName}: duplicate ${kind} name ${name}`);
	}

	// 声明状态；schema 必须显式给出，因为运行时没有 TypeScript 类型。返回 Cell，可在实现中读写。
	// initial 既可以是值，也可以是 { init }；重载按名字保留旧单元格及其值。
	state<S extends Schema>(
		name: string,
		schema: S,
		initial: Static<S> | StateInit<Static<S>>,
		options: StateOptions<Static<S>> = {},
	): Cell<Static<S>> {
		// 同一 run 内状态名唯一。
		this.#unique(this.#decls.cells, "state", name);
		// 缺省版本 1；版本只增不减，由 reload.ts 检查。
		const version = options.version ?? 1;
		if (!Number.isInteger(version) || version < 1)
			throw new TypeError(`state ${name}: version must be a positive integer`);
		const host = this.#object.host;
		// A JSON value never holds a function: an object with a function `init` is the initializer, not a value.
		// JSON 值永远不会包含函数；带函数 init 的对象是初始化描述而不是值。
		const init = isStateInit(initial) ? initial.init : undefined;
		// 重载记录模式下按名字找旧 Cell；找到就复用，值和订阅都保留。
		let cell = this.#previous?.cells.get(name);
		// 新状态：创建 Cell；有 init 时先不设值，等激活阶段填充。
		if (cell === undefined) {
			// Cell 接收 schema、初始值/空、写入守卫和 dev/report 选项；泛型擦除后统一存 unknown。
			cell = new Cell<unknown>(
				name,
				schema,
				init === undefined ? { value: initial } : undefined,
				this.#object.guard,
				{
					dev: host.dev,
					report: (error) => host.report(error),
				},
			);
			// 记录待执行 init；只有本次新建的 Cell 才需要初始化。
			if (init !== undefined) this.#created.inits.push([cell, init]);
		}
		// 写入声明表；后面的 cellSchemas/cellVersions/migrations 供重载检测。
		this.#decls.cells.set(name, cell);
		this.#decls.cellSchemas.set(name, schema);
		this.#decls.cellVersions.set(name, version);
		// 只有提供 migrate 才登记；没有迁移函数时重载要求旧值直接满足新 schema。
		if (options.migrate !== undefined) this.#decls.cellMigrations.set(name, options.migrate);
		return cell as Cell<Static<S>>;
	}

	// 声明对象拥有的引用：按地址去重，重载时优先复用上一代仍健康的引用，否则让宿主 acquire。
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions): Ref<C> {
		const host = this.#object.host;
		// A prepare rerun (recording mode) binds new references against the reload's pending contracts: a breaking provider
		// change and its updated consumer reload together.
		// 记录模式使用重载候选服务表，使提供方与消费者在同一代代码里一起升级。
		const candidate = this.#previous !== undefined;
		// 未指定 principal 时使用宿主身份；地址计算由宿主负责归一化和 principalKey。
		const address = host.addressOf(type, input, options?.principal ?? host.principal, candidate);
		const declared = this.#decls.refs.get(address);
		if (declared !== undefined) {
			if (declared.contract.fingerprint !== type.fingerprint) {
				throw invalid("duplicate", `${this.#object.typeName}: ${type.name} held twice with different contracts`);
			}
			return declared.proxy as Ref<C>;
		}
		// 上一代同地址引用可复用；契约指纹必须相同，且不能已 gone/released。
		const existing = this.#previous?.refs.get(address);
		if (
			existing !== undefined &&
			existing.contract.fingerprint === type.fingerprint &&
			existing.status !== "gone" &&
			existing.status !== "released"
		) {
			this.#decls.refs.set(address, existing);
			return existing.proxy as Ref<C>;
		}
		// owner 为 object：引用由工厂拥有；from 让宿主能检测对象间引用环。
		const ref = host.acquire(type, input, options, "object", this.#object, candidate);
		this.#decls.refs.set(address, ref);
		this.#created.refs.push(ref);
		return ref.proxy as Ref<C>;
	}

	// 声明资源：版本、独占性和依赖都相同则复用旧 ResourceImpl，否则创建新实例并在加载/提交时替换。
	resource<T>(name: string, declaration: ResourceDeclaration<T>): Resource<T> {
		// 同一 run 内资源名唯一。
		this.#unique(this.#decls.resources, "resource", name);
		if (!Number.isInteger(declaration.version)) throw new TypeError(`resource ${name}: version must be an integer`);
		// 把依赖解析成真实引用或资源；facade 通过 WeakMap 还原。
		const deps = (declaration.deps ?? []).map((dep) => {
			const resolved = refOf(dep) ?? resourceOf(dep);
			if (resolved === undefined) {
				throw new TypeError(`resource ${name}: deps must be references or resources of this object`);
			}
			return resolved;
		});
		// 重载按名字找旧资源；名字相同才有保留可能。
		const existing = this.#previous?.resources.get(name);
		// 保留条件：版本相同、独占性相同、依赖数组逐项同一；任一变化都替换。
		const kept =
			existing !== undefined &&
			existing.spec.version === declaration.version &&
			existing.exclusive === (declaration.exclusive === true) &&
			existing.deps.length === deps.length &&
			existing.deps.every((dep, index) => dep === deps[index]);
		// 保留时复用旧实现；替换时新实现会由 open 打开。
		const resource = kept ? existing : new ResourceImpl(name, declaration as ResourceDeclaration<unknown>, deps);
		// 保留资源登记新声明；commit 时 adopt，使 close 使用新代码。
		if (kept) this.#decls.adopted.set(existing, declaration as ResourceDeclaration<unknown>);
		else this.#created.resources.push(resource);
		this.#decls.resources.set(name, resource);
		return new ResourceFacade(resource, this.#object.host) as unknown as Resource<T>;
	}

	// 声明监听器；重载按名字唯一。参数重载用 rest 区分 (source, handler) 与 (source, select, handler)。
	on(name: string, source: unknown, ...rest: readonly unknown[]): void {
		this.#unique(this.#decls.listeners, "listener", name);
		// 一个额外参数是 handler，两个是 select + handler；元组解构得到两个槽位。
		const [select, fn] = rest.length === 1 ? [undefined, rest[0]] : [rest[0], rest[1]];
		if (typeof fn !== "function") throw new TypeError(`listener ${name}: the handler must be a function`);
		if (select !== undefined && typeof select !== "function")
			throw new TypeError(`listener ${name}: select must be a function`);
		this.#decls.listeners.set(name, {
			source,
			select: select as ListenerDecl["select"],
			fn: fn as ListenerDecl["fn"],
		});
	}

	// 任务没有名字，用当前数量生成位置键；位置键只用于本次运行内停止和替换。
	task(fn: (ctx: Ctx) => Promise<void>): void {
		if (typeof fn !== "function") throw new TypeError("a task must be a function");
		// 位置键 #0、#1…；任务本身不携带跨重载身份。
		this.#decls.tasks.set(`#${this.#decls.tasks.size}`, fn);
	}

	// 声明同步派生：位置键、新 Derived 实例；每次重载都重新计算首值。
	derive<const S extends Sources, T>(sources: S, fn: (...values: SourceValues<S>) => T): Readable<T> {
		if (typeof fn !== "function") throw new TypeError("a derivation needs a function");
		const host = this.#object.host;
		// 派生没有名字，用位置键区分；重载不会复用实例。
		const key = `#${this.#decls.derives.size}`;
		// 断言擦除参数化类型，Derived 内部统一按 unknown 计算；运行时仍会检查源和同步返回。
		const derived = new Derived(key, sources, fn as unknown as (...values: never[]) => unknown, {
			dev: host.dev,
			report: (error) => host.report(error),
		});
		this.#created.derives.push(derived);
		this.#decls.derives.set(key, derived);
		return derived as unknown as Readable<T>;
	}

	// 暴露资源：只接受本对象声明的资源；返回类型标记，不复制值。
	expose<T>(resource: Resource<T>): Exposed<T> {
		// façade 或真实资源都还原为 ResourceImpl。
		const resolved = resourceOf(resource);
		if (resolved === undefined || ![...this.#decls.resources.values()].includes(resolved)) {
			throw new TypeError("expose takes a resource declared by this object");
		}
		return new ExposedImpl(resolved) as unknown as Exposed<T>;
	}

	// 注册条目：只有 host 生命周期对象可调用；按 registry+key 去重，提交时由宿主检查冲突。
	register<V>(registry: Registry<V>, entries: Readonly<Record<string, V>>): void {
		// 引用计数对象可能在任意时刻销毁，不能提供稳定的注册表条目。
		if (!this.#object.hostLifetime)
			throw invalid("not_host_lifetime", `${this.#object.typeName}: only objects of lifetime "host" may register`);
		for (const [key, value] of Object.entries(entries)) {
			const id = `${registry.name}\u0000${key}`;
			// id 用 registry 名和 NUL 分隔，避免不同注册表的同名 key 冲突。
			this.#unique(this.#decls.registrations, "register", id);
			this.#decls.registrations.set(id, { registry: registry as Registry<unknown>, key, value });
		}
	}
}
