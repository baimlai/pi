// Chord v1 工厂通过 self 声明资源和监听器时使用的类型；这里只约定形状，实际开关资源在 object.ts。
import type { Ctx } from "./types.ts";

// What a factory declares through `self` besides state cells: the shapes of resources and listeners.

// E 是一次事件的数据类型；此接口不要求立即发送当前值，因此也能描述没有当前值的普通事件流。
export interface Subscribable<E> {
	/** 接收事件回调并返回取消订阅函数；例如 source.subscribe(e => log(e))，取消时调用其返回函数。 */
	subscribe(listener: (event: E) => void): () => void;
}

/** `self.resource(name, declaration)`: something the object opens and later closes (a database, a watch, a socket). */
export interface ResourceDeclaration<T> {
	/** Bump to replace the resource at the next reload (a native value has no schema to detect a change). */
	// version 是作者手动维护的原生资源版本，不能依赖 TS 推断资源内部实现是否已经变化。
	readonly version: number;
	/** References or resources that must be live/open first. A change replaces the resource. */
	// 两个 readonly 分别禁止改属性和改数组；unknown 允许引用与资源等不同依赖，实际依赖身份由对象运行时匹配。
	readonly deps?: readonly unknown[];
	/** Exclusive resources are replaced at the gate: old closed before new opened. */
	readonly exclusive?: boolean;
	/**
	 * 打开资源，接收本次打开的取消信号，返回 T 或 Promise<T>；可连接数据库等，会产生应用定义的外部副作用。
	 * 例如 async ({ signal }) => connect(signal)。失败使激活/准备失败；已取消后才成功打开的值由运行时安排关闭。
	 */
	open(options: { readonly signal: AbortSignal }): T | Promise<T>;
	/** 可选关闭操作，接收之前打开的 T，允许异步完成；例如 db => db.close()。错误由对象清理流程收集并报告。 */
	close?(value: T): void | Promise<void>;
}

// Resource<T> 是声明阶段得到的占位句柄，不是资源值本身；打开前访问 value 会在运行时抛 not_ready。
export interface Resource<T> {
	readonly key: string;
	/** Throws not_ready until opened. */
	readonly value: T;
}

/** A listener as `self.on` declares it. */
export interface ListenerDecl {
	// source 可以是状态、事件流或 Resource；unknown 表示此处还未选择和解析具体源类型。
	readonly source: unknown;
	// 可选 select 把资源打开后的值变成可订阅源；never 是内部擦除具体参数类型后的回调槽，不表示应用传入 never 值。
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
export type EventOf<S> = S extends Subscribable<infer E> ? E : S extends Resource<infer T> ? EventOf<T> : never;
