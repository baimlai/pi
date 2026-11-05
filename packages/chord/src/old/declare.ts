// Chord v1 工厂通过 self 声明资源和监听器时使用的类型；这里只约定形状，实际开关资源在 object.ts。
/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/old/declare.ts，Chord v1 的“工厂声明形状”类型层（旧实现）。
 *
 * 功能：定义对象工厂通过 `self.resource(name, declaration)` 和 `self.on(name, source, ...)` 声明资源与监听器时
 * 使用的类型；并用条件类型 ValueOf 推导 select 的输入、用 EventOf 推导“没有 select”时 handler 的事件类型。
 * 本文件没有运行时代码，只有 interface 和 type。
 *
 * 职责边界：
 * - 负责：声明形状与编译期类型推导，让工厂作者在 `self.resource`/`self.on` 处得到正确的 T、事件类型和 ctx。
 * - 不负责：资源打开/关闭/替换、依赖解析、监听器订阅/保留、运行时参数检查。这些在 object.ts 中：
 *   Self.resource/on、ResourceImpl/ResourceFacade、#listenSource、stageListeners。类型不会在运行时被验证。
 * - Resource<T> 只是声明阶段的句柄：真实值由 object.ts 在对象激活/重载 prepare 时打开；打开前读取抛 not_ready，
 *   工厂运行期间读取也抛 not_ready（见 ResourceFacade），避免两代代码同时触碰同一个原生资源。
 *
 * 上游 / 下游：
 * - 上游：object.ts 的 Self 接口和工厂作者；old/index.ts 重导出 Subscribable/Resource/ResourceDeclaration/ValueOf/EventOf。
 * - 下游：types.ts 的 Ctx（监听器每次事件的新 root 上下文）；TypeScript 的结构化类型与条件类型。
 * 公开 API：Subscribable、ResourceDeclaration、Resource、ValueOf、EventOf；ListenerDecl 是 object.ts 内部存储形状，
 * index.ts 不重导出它。
 *
 * 能力清单（按导出项）：
 * - `Subscribable<E>`：只有一个 subscribe(listener) 方法的结构化事件源；返回取消订阅函数。
 * - `ResourceDeclaration<T>`：version/deps/exclusive/open/close；object.ts 在运行时检查 version 为整数、解析 deps，
 *   并按 version/exclusive/deps 决定重载时保留还是替换资源。
 * - `Resource<T>`：对象内资源的句柄，key 是对象内名字，value 在打开后可用。
 * - `ListenerDecl`：self.on 的存储形状（source/select/fn），类型被擦除为 unknown/never 以便统一保存。
 * - `ValueOf<S>` / `EventOf<S>`：前者推导 select 的输入；后者推导没有 select 时 handler 的事件类型。
 *
 * 典型调用（示例；不是本文件的运行时行为）：
 *   const db = self.resource("db", {
 *     version: 1,
 *     deps: [config],
 *     open: ({ signal }) => openDb(url, { signal }),
 *     close: (handle) => handle.close(),
 *   });
 *   self.on("change", db, (handle) => handle.changes, (event, ctx) => { ... });
 * 这里 select 的参数类型由 ValueOf<Resource<Db>> 推导为 Db；handler 的事件类型来自 select 的返回类型。
 * 三参数重载没有 select，此时才由 EventOf<S> 推导 handler 的事件类型。
 *
 * 建议阅读顺序：Subscribable → ResourceDeclaration（version/deps/exclusive 的替换规则）→ Resource 句柄 →
 * ListenerDecl 的擦除类型 → 末尾两个条件类型。读条件类型时注意分支顺序是语义的一部分。
 */
import type { Ctx } from "./types.ts";

// 说明：这里的“声明”只是工厂代码里的数据形状；真正的资源生命周期和监听器订阅由 object.ts 执行。
// What a factory declares through `self` besides state cells: the shapes of resources and listeners.

// E 是一次事件的数据类型；此接口不要求立即发送当前值，因此也能描述没有当前值的普通事件流。
// 结构化接口：任何对象只要有 subscribe(listener) 方法就能作为事件源，不要求继承某个类。
// listener 收到事件；subscribe 返回的取消函数由调用方保存，运行时不会检查它是否幂等或必须调用。
export interface Subscribable<E> {
	/** 接收事件回调并返回取消订阅函数；例如 source.subscribe(e => log(e))，取消时调用其返回函数。 */
	subscribe(listener: (event: E) => void): () => void;
}

/** `self.resource(name, declaration)`: something the object opens and later closes (a database, a watch, a socket). */
// self.resource(name, declaration) 的 declaration 形状。T 是打开后得到的值类型，只在编译期存在；
// 对象运行时会检查 version 为整数、deps 都是本对象的引用或资源，并据此决定重载时是否复用旧资源。
export interface ResourceDeclaration<T> {
	/** Bump to replace the resource at the next reload (a native value has no schema to detect a change). */
	// version 是作者手动维护的原生资源版本，不能依赖 TS 推断资源内部实现是否已经变化。
	// object.ts 只检查它是整数，不解释版本含义；是否重新打开仍由作者递增 version 决定。
	readonly version: number;
	/** References or resources that must be live/open first. A change replaces the resource. */
	// 两个 readonly 分别禁止改属性和改数组；unknown 允许引用与资源等不同依赖，实际依赖身份由对象运行时匹配。
	// deps 必须是本对象拥有的引用或资源；object.ts 的 resource() 用 refOf/resourceOf 逐个解析，
	// 解析失败抛 TypeError。依赖数组逐项身份变化会让重载替换资源，而不是复用已打开的值。
	readonly deps?: readonly unknown[];
	/** Exclusive resources are replaced at the gate: old closed before new opened. */
	// exclusive 为 true 时在重载 gate 处先关闭旧资源再打开新资源；否则新旧资源可以短暂并存。
	// 这个字段参与“是否复用旧资源”的判断，改变它会导致重载替换。
	readonly exclusive?: boolean;
	/**
	 * 打开资源，接收本次打开的取消信号，返回 T 或 Promise<T>；可连接数据库等，会产生应用定义的外部副作用。
	 * 例如 async ({ signal }) => connect(signal)。失败使激活/准备失败；已取消后才成功打开的值由运行时安排关闭。
	 */
	open(options: { readonly signal: AbortSignal }): T | Promise<T>;
	/** 可选关闭操作，接收之前打开的 T，允许异步完成；例如 db => db.close()。错误由对象清理流程收集并报告。 */
	// close 可选；参数是 open 成功返回的 T。关闭错误不会中断整体清理：object.ts 收集并报告，
	// 因为此时旧资源可能已经不可用，继续清理更重要。
	close?(value: T): void | Promise<void>;
}

// Resource<T> 是声明阶段得到的占位句柄，不是资源值本身；打开前访问 value 会在运行时抛 not_ready。
// key 在同一个对象的声明中唯一；value 是 getter，工厂运行期间也抛 not_ready，恢复失败后抛 unavailable。
export interface Resource<T> {
	readonly key: string;
	/** Throws not_ready until opened. */
	// 注意：这里的 readonly 只禁止 TypeScript 调用方赋值；getter 每次读取都会检查 ResourceImpl 的状态。
	readonly value: T;
}

/** A listener as `self.on` declares it. */
// 监听器在 object.ts 中的统一存储形状。source/select/fn 的强类型在 self.on 重载处已经用于推导，
// 进入 ListenerDecl 时被擦除，便于运行时按名字保存、比较和重载保留。
export interface ListenerDecl {
	// source 可以是状态、事件流或 Resource；unknown 表示此处还未选择和解析具体源类型。
	readonly source: unknown;
	// 可选 select 把资源打开后的值变成可订阅源；never 是内部擦除具体参数类型后的回调槽，不表示应用传入 never 值。
	// 非资源时 select 接收 source 本身；资源时接收打开后的 value。
	readonly select: ((value: never) => Subscribable<unknown>) | undefined;
	// fn 接收事件及该次事件新建的调用上下文，可能异步；这里只存声明，不执行监听器。
	readonly fn: (event: unknown, ctx: Ctx) => void | Promise<void>;
}

// A cell has a `key` and a `value` too: sources are matched before resources.
/** What `self.on(name, source, …)` passes to `select`: a resource's opened value, or the source itself. */
// 条件类型按顺序判断：本身可订阅就保留 S；否则 Resource<infer T> 提取资源值 T；都不是则保留 S。
// 这避免有 key/value 的 cell 被误当成资源，例如 ValueOf<Resource<Socket>> 是 Socket。
export type ValueOf<S> = S extends Subscribable<unknown> ? S : S extends Resource<infer T> ? T : S;
/** What `self.on(name, source, handler)` delivers: a readable's values, an event source's events. */
// infer E 取订阅事件类型；资源则递归查看打开后的 T，无法订阅时得到 never。只帮助编译器，不在运行时测试方法存在。
// 运行时是否可订阅由 object.ts 的 #listenSource 检查（invalid/implementation），与本条件类型无关。
export type EventOf<S> = S extends Subscribable<infer E> ? E : S extends Resource<infer T> ? EventOf<T> : never;
