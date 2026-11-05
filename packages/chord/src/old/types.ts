// Chord v1 的公共调用上下文、可读状态和引用类型；interface/type 在运行时会被擦除，不会自行校验数据。
/**
 * Chord v1 旧实现：公共类型定义（调用上下文、状态读取、引用外壳）。
 *
 * 所属包与功能模块：packages/chord/src/old/types.ts，属于 Chord v1 的公共 API 类型层。
 * 这些类型被 object.ts、remote.ts、connection.ts、host.ts 以及应用代码共同使用，是“对象、引用、状态”
 * 三个概念在类型系统里的最小交集。
 *
 * 解决什么问题：Chord 的对象有远程引用、状态成员、调用上下文和生命周期。应用需要在不关心传输细节的情况下
 * 写类型安全的代码：ctx.get 返回什么、状态成员如何订阅、引用何时 ready、如何监听 gone。本文件只声明这些
 * 形状，不包含运行时实现。
 *
 * 职责边界：这里全部是 TypeScript 的 interface/type，编译后会被擦除，运行时不存在任何对象、校验或默认值。
 * 真正的实现分布在 object.ts（CtxImpl、RefImpl、Readable 实现）、remote.ts（RemoteBinding/RemoteRef）、
 * host.ts（根与激活）中。不要指望这里的类型能在运行时验证 wire 数据；跨链路的校验在 wire.ts/schema.ts。
 *
 * 上游入口：应用代码通过 chord/old 的导出拿到 Ctx、Readable、RefStatus、Shape、StateEvent 等类型；
 * ctx.get 的签名来自本文件，实际调用进入 object.ts 的 CtxImpl。
 * 下游依赖：delta 的 Op（增量操作类型）、contract 的 AnyContract/InputOf/Ref（契约与引用类型推导）。
 *
 * 能力清单（按导出项）：
 * - GetOptions<P>：ctx.get 的选项（principal、state）。
 * - Ctx<P>：一次调用的显式上下文（signal/rootId/codeVersion/principal/get）。
 * - StateEvent<T>：状态事件的可辨识联合（snap/ops/reset）。
 * - Readable<T>：可读状态源（value/subscribe/events）。
 * - StateSource<T>：实现可以暴露为状态成员的类型别名（当前等于 Readable<T>）。
 * - Exposed<T> + EXPOSED：用唯一 symbol 在类型层标记“由资源支撑的成员”。
 * - RefStatus：引用的四种状态（loading/live/released/gone）。
 * - Shape：当前变体、成员名列表与 provider 契约指纹。
 * - RefBase<C>：所有引用共有的外壳（contract/status/ready/variant/shape/error/onShape/onStatus/release）。
 *
 * 组合关系与典型调用顺序：
 * 1. 应用在对象方法里收到 Ctx，用 ctx.get 获取其他对象引用；
 * 2. 引用就绪后可读 state 成员（Readable），订阅 subscribe（值）或 events（增量）；
 * 3. 引用状态变化通过 onStatus/onShape 观察；结束时 release() 或收到 gone；
 * 4. 实现侧用 StateEvent/Readable 描述自己暴露的状态。
 *
 * 示例（真实签名形状；假设 Counter 是 local 契约，或只有一个 variant 的 remote 契约，state 成员叫 value）：
 *   async function useCounter(ctx: Ctx<{ id: string }>, counter: Ref<typeof Counter>) {
 *     const values: number[] = [];
 *     const off = counter.value.subscribe((v) => values.push(v));
 *     await counter.ready;
 *     off();
 *   }
 *   Ref<C> 的成员类型由 contract.ts 推导；多 variant 的 remote 引用要先按 ref.variant 收窄。
 *
 * 建议阅读顺序：GetOptions -> Ctx -> StateEvent -> Readable -> RefStatus/Shape -> RefBase。
 * 读 RefBase 时对照 object.ts 的 RefCore/RefImpl，理解哪些字段是类型声明、哪些由运行时维护。
 */
import type { Op } from "../delta/index.ts";
import type { AnyContract, InputOf, Ref } from "./contract.ts";

// GetOptions：ctx.get 的第二个参数。泛型 P 只影响 principal 字段的类型，运行时不检查 principal 结构。
// 示例：await ctx.get(Notes, { id: "n1" }, { principal: user, state: false })
// 注意：state 的默认值不是这里决定的；默认行为在 object.ts 的获取逻辑中。
/**
 * Options of `get`. `P` is the app's principal type: a JSON-serializable identity of a caller, mapped to an object key
 * by `createHost({ principalKey })`.
 */
// P 是应用自己的身份类型，默认 unknown；readonly 表示 TS 不允许通过这个接口改属性，? 表示可省略。
// GetOptions 接口：两个字段都可选，因此对象获取有“方法引用”和“完整状态引用”两种模式。
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

// Ctx：一次调用的上下文。它把 root（短调用树）、代码版本、取消信号和身份绑在一起，
// 让嵌套调用（跨链路或跨对象）仍然属于同一个 root，并在 root 结束时统一释放引用。
// 这不是全局上下文，而是显式传递的参数：对象方法、root(fn) 回调和远程调用都会收到它。
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
	// 下面这段是 get 的详细契约（中文版）。get 是 Ctx 上唯一的业务方法，
	// 也是应用获取其他对象引用的标准入口；它返回的引用生命周期与当前调用绑定。
	/**
	 * 在当前调用内获取契约 type、输入 input 对应的引用；等待其激活并按 options 决定是否等待状态。
	 * Promise 返回 Ref<C>，引用在当前调用结束时释放；激活失败、取消或就绪超时会拒绝并释放此引用。
	 * 例如 await ctx.get(Counter, { name: "a" }) 获取本次调用可用的计数器。C extends 约束契约，InputOf/Ref 据此推导类型。
	 */
	// 类型参数 C extends AnyContract：C 必须是契约；InputOf<C> 从契约推导输入参数类型，
	// Ref<C> 从契约推导引用暴露的成员。三者配合让 ctx.get(Notes, { id: "n1" }) 的返回类型自动正确。
	// 运行时：host 会校验 input、placement 与契约版本；类型系统本身不做这些检查。
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Promise<Ref<C>>;
}

// 以 type 字段区分三种事件；switch(event.type) 后 TS 能确定 ops 是否存在。
// snap 是首次完整值，ops 是增量及增量后的完整值，reset 是迁移/重新绑定后替换整个值；Op 是 delta 模块的操作类型。
export type StateEvent<T> =
	| { readonly type: "snap"; readonly value: T }
	| { readonly type: "ops"; readonly ops: readonly Op[]; readonly value: T }
	| { readonly type: "reset"; readonly value: T };

/** A readable state source: a cell, a derivation, or a reference's state member. Values are immutable by contract. */
// Readable：所有可读状态的统一接口。cell、derive、对象的 state 成员都实现它。
// “值不可变”是约定：订阅者拿到的是同一份结构共享的值，不能原地修改。
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
// StateSource：实现可以暴露为 state member 的类型。当前与 Readable 完全相同，
// 保留独立名字是为了让“对象可以暴露什么”与“消费者如何读取”在语义上分开。
export type StateSource<T> = Readable<T>;

// declare 只向 TS 声明这个唯一 symbol 的类型，不创建运行时变量；它用来给 Exposed 标记所承载的 T。
declare const EXPOSED: unique symbol;

/** A local member backed by a resource (`self.expose(res.x)`): references read the resource's value once live. */
// Exposed：包装一个由原生资源支撑的成员（self.expose(res.x)）。
// 泛型 T 是资源值的类型；引用在对象 live 后读取它。
// 运行时不存在 Exposed 对象，它只是类型层的标记。
export interface Exposed<T> {
	// 计算属性键 [EXPOSED] 充当类型标记；真正读取资源的逻辑由对象引用实现。
	readonly [EXPOSED]: T;
}

// 四个字符串字面量构成状态联合；loading 可在断线重连时再次出现，released 是主动释放，gone 是被终止。
export type RefStatus = "loading" | "live" | "released" | "gone";

// Shape 描述当前暴露的变体和成员名；本地契约的 variant 可以是 undefined，contract 是提供方指纹。
// Shape：消费者当前看到的对象形态。远程绑定的 shape 来自提供方，包含变体名、成员列表和契约指纹。
// 它决定“哪些成员可读/可调用”，也是重载或变体切换时 UI 更新的依据。
export interface Shape {
	readonly variant: string | undefined;
	readonly members: readonly string[];
	/** Fingerprint of the provider contract. */
	// contract：提供方契约的指纹。消费者用它判断自己是否理解当前形态；不同版本可能通过 accepts 适配。
	readonly contract: string;
}

// RefBase 是所有引用共有的外壳，实际方法/状态成员由 contract.ts 的 Ref<C> 叠加。
// RefBase<C>：所有引用共有的外壳。具体方法/状态成员由 contract.ts 的 Ref<C> 与本类型交叉（&）得到。
// 泛型 C 保留消费者绑定时使用的契约，便于类型推导与运行时核对 fingerprint。
export interface RefBase<C extends AnyContract> {
	/** The consumer contract token this reference was bound with. */
	// contract：消费者绑定时使用的契约 token（不是提供方当前契约）；适配后的旧消费者保留自己的版本。
	readonly contract: C;
	readonly status: RefStatus;
	// ready 在引用首次满足就绪条件时完成；后续连接变化应监听 status，不能重复等待已完成 Promise 当作健康检查。
	readonly ready: Promise<void>;
	// variant/shape：当前变体名与完整形态；加载中或未绑定时可能为 undefined。
	// 注意：shape 改变不代表引用失效，只代表可见成员变了；监听 onShape 更新 UI。
	readonly variant: string | undefined;
	readonly shape: Shape | undefined;
	// error：引用 gone 的原因；其他状态下通常为 undefined。
	/** Why the reference is gone, if it is. */
	readonly error: unknown;
	/** 订阅之后的可见成员形状变化，返回取消函数；不会立即补发已有形状。例如先读 ref.shape，再用 onShape 跟踪 UI 成员列表。 */
	onShape(listener: (shape: Shape) => void): () => void;
	// onStatus：监听状态变化（不是“立即回调”）。调用方应先读 ref.status 处理当前状态，
	// 再用 onStatus 跟踪后续变化；否则可能错过注册前已经发生的迁移。
	/**
	 * Called after every status change (`loading` → `live`, `live` → `loading` while a link reconnects, `released`,
	 * `gone` with `error`). A UI watches for `gone` to `get` again.
	 */
	/** 监听之后的状态变化及失败原因，返回取消函数；例如收到 gone 后 UI 可另行获取新引用，本接口不自动重新获取。 */
	onStatus(listener: (status: RefStatus, error: unknown) => void): () => void;
	/** 主动放弃此引用，阻止继续调用并释放它的持有权；无参数和返回值。例如 UI 卸载时 ref.release()。 */
	release(): void;
}
