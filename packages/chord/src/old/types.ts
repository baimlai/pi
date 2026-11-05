// Chord v1 的公共调用上下文、可读状态和引用类型；interface/type 在运行时会被擦除，不会自行校验数据。
import type { Op } from "../delta/index.ts";
import type { AnyContract, InputOf, Ref } from "./contract.ts";

/**
 * Options of `get`. `P` is the app's principal type: a JSON-serializable identity of a caller, mapped to an object key
 * by `createHost({ principalKey })`.
 */
// P 是应用自己的身份类型，默认 unknown；readonly 表示 TS 不允许通过这个接口改属性，? 表示可省略。
export interface GetOptions<P = unknown> {
	/** Principal the object is created for. Defaults to the host's own principal (`createHost({ self })`). */
	// 不传 principal 时由宿主采用自己的身份；此处只是声明字段，不负责计算对象地址。
	readonly principal?: P;
	/**
	 * False: a method-only reference. It receives no state (unless another reference to the same object wants it), and
	 * is ready once its object is live.
	 */
	// state: false 只要求方法引用就绪；若共享同一绑定的其他引用需要状态，底层仍可能接收状态。
	readonly state?: boolean;
}

/**
 * The explicit call context of one root (a short Chord call tree). Calls made with it carry its root id and code
 * version; `get` references are released when the call that received this ctx settles.
 */
export interface Ctx<P = unknown> {
	// signal 通知调用取消；rootId 标识整棵短调用树，codeVersion 让嵌套调用继续使用相同版本的代码。
	readonly signal: AbortSignal;
	readonly rootId: string;
	readonly codeVersion: number;
	/** Who the root acts as: the caller at ingress, the host's own principal inside objects. */
	// 入口处是调用者身份，对象内部则由运行时转换成宿主自身身份。
	readonly principal: P;
	/**
	 * A reference for this call, released when the call settles. Resolves once it is ready: live, with every state
	 * member of its variant (unless `state: false`). Rejects with the activation error, `aborted` when the ctx is
	 * aborted or the call settles first, or `unavailable/ready_timeout` after the host's `readyTimeout`; the reference
	 * is released then.
	 */
	/**
	 * 在当前调用内获取契约 type、输入 input 对应的引用；等待其激活并按 options 决定是否等待状态。
	 * Promise 返回 Ref<C>，引用在当前调用结束时释放；激活失败、取消或就绪超时会拒绝并释放此引用。
	 * 例如 await ctx.get(Counter, { name: "a" }) 获取本次调用可用的计数器。C extends 约束契约，InputOf/Ref 据此推导类型。
	 */
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Promise<Ref<C>>;
}

// 以 type 字段区分三种事件；switch(event.type) 后 TS 能确定 ops 是否存在。
// snap 是首次完整值，ops 是增量及增量后的完整值，reset 是迁移/重新绑定后替换整个值；Op 是 delta 模块的操作类型。
export type StateEvent<T> =
	| { readonly type: "snap"; readonly value: T }
	| { readonly type: "ops"; readonly ops: readonly Op[]; readonly value: T }
	| { readonly type: "reset"; readonly value: T };

/** A readable state source: a cell, a derivation, or a reference's state member. Values are immutable by contract. */
export interface Readable<T> {
	// T 表示当前值的类型；值按约定不可变，readonly 不会递归冻结其内部对象。
	readonly value: T;
	/** Called with the current value immediately, then with every new value. */
	/** 注册值回调，先交付当前值再交付更新；返回无参数取消函数。例如 const off = source.subscribe(v => log(v)); off()。 */
	subscribe(listener: (value: T) => void): () => void;
	/** Delta stream: a snapshot immediately, then ops, or a reset after a migration or rebind. */
	/** 注册状态事件回调，首次 snap、之后 ops/reset；返回取消函数。例如 events(e => log(e.type)) 可观察增量类型。 */
	events(listener: (event: StateEvent<T>) => void): () => void;
}

/**
 * What an implementation may expose as a state member: a cell, a derivation, or a held object's state member (an
 * object goes live only once the members it exposes have their values).
 */
export type StateSource<T> = Readable<T>;

// declare 只向 TS 声明这个唯一 symbol 的类型，不创建运行时变量；它用来给 Exposed 标记所承载的 T。
declare const EXPOSED: unique symbol;

/** A local member backed by a resource (`self.expose(res.x)`): references read the resource's value once live. */
export interface Exposed<T> {
	// 计算属性键 [EXPOSED] 充当类型标记；真正读取资源的逻辑由对象引用实现。
	readonly [EXPOSED]: T;
}

// 四个字符串字面量构成状态联合；loading 可在断线重连时再次出现，released 是主动释放，gone 是被终止。
export type RefStatus = "loading" | "live" | "released" | "gone";

// Shape 描述当前暴露的变体和成员名；本地契约的 variant 可以是 undefined，contract 是提供方指纹。
export interface Shape {
	readonly variant: string | undefined;
	readonly members: readonly string[];
	/** Fingerprint of the provider contract. */
	readonly contract: string;
}

// RefBase 是所有引用共有的外壳，实际方法/状态成员由 contract.ts 的 Ref<C> 叠加。
export interface RefBase<C extends AnyContract> {
	/** The consumer contract token this reference was bound with. */
	readonly contract: C;
	readonly status: RefStatus;
	// ready 在引用首次满足就绪条件时完成；后续连接变化应监听 status，不能重复等待已完成 Promise 当作健康检查。
	readonly ready: Promise<void>;
	readonly variant: string | undefined;
	readonly shape: Shape | undefined;
	/** Why the reference is gone, if it is. */
	readonly error: unknown;
	/** 订阅之后的可见成员形状变化，返回取消函数；不会立即补发已有形状。例如先读 ref.shape，再用 onShape 跟踪 UI 成员列表。 */
	onShape(listener: (shape: Shape) => void): () => void;
	/**
	 * Called after every status change (`loading` → `live`, `live` → `loading` while a link reconnects, `released`,
	 * `gone` with `error`). A UI watches for `gone` to `get` again.
	 */
	/** 监听之后的状态变化及失败原因，返回取消函数；例如收到 gone 后 UI 可另行获取新引用，本接口不自动重新获取。 */
	onStatus(listener: (status: RefStatus, error: unknown) => void): () => void;
	/** 主动放弃此引用，阻止继续调用并释放它的持有权；无参数和返回值。例如 UI 卸载时 ref.release()。 */
	release(): void;
}
