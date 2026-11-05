// The `ctx` a method handler gets (§8): its call's context, who called, the calling host's incarnation, and
// call-scoped references; and the abort signal of a call's context, linked to long-lived sources until it settles.
// 文件导读
// 所属：packages/chord/src/host（主机层），定义方法处理器的调用上下文。
// 职责：把调用方身份、调用方主机 incarnation、调用级信号和调用级引用封装成 Ctx；结算时统一释放引用。
// 边界：不负责路由或绑定目标对象（交给 AnyHost.acquire），不做参数校验（由主机侧 checkParams 完成）。
// 上游：Attempt.call() 组装 CallContext 并运行处理器；处理器通过 ctx.get/principal/incarnation 使用它。
// 下游：ctx.get -> host.acquire -> Binding；settle -> binding.release；信号 -> withLinkedAbortSignal。
// 错误：get 在结算后抛 released/settled；参数或网络错误由 acquire 原样 reject；中止原因优先于内部错误。
// 能力清单：
// - Ctx<P>：处理器上下文接口（principal、incarnation、get 及 Context 能力）。
// - Caller：一次调用的行动者身份与主机 incarnation。
// - CallContext：Ctx 的实现，维护 #references 与 #settling。
// - withLinkedAbortSignal(signal, context)：手动合并两个信号，返回 context 与 release。
// 组合与顺序：Attempt.call -> withLinkedAbortSignal -> new CallContext -> 处理器 ctx.get -> settle -> release。
// 示例：const other = await ctx.get(Counter, { id: "a" }); 处理器返回后该引用自动释放。
// 建议阅读顺序：Ctx -> Caller -> CallContext.get -> settle -> withLinkedAbortSignal。

import { type Context, type ContextKey, withAbortSignal, withoutAbortSignal } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import { ChordError, type Principal } from "../data/index.ts";
import type { AnyHost, GetOptions } from "./host.ts";
import type { Binding, Reference } from "./reference.ts";

/** A handler's context. */
// Ctx 继承通用的 Context（telemetry、value、abortSignal 等），再加三项业务能力。
// P 是应用的身份类型，默认 Principal；它是编译期约束，运行时不检查 principal 的具体字段。
// 例：defineContract 的 P 为 AppPrincipal 时，handler 里 ctx.principal 的类型就是 AppPrincipal | undefined。
export interface Ctx<P extends Principal = Principal> extends Context {
	/** The caller as its link stamped it; on a local object's handler the host's principal (none on a client). */
	// 调用方身份，可能不存在：本地对象用本机 host.principal 填充；远程对象用链路上携带的身份；
	// 客户端没有身份时为 undefined。它由调用路径写入，处理器不应修改（readonly 只在开发期限制）。
	readonly principal: P | undefined;
	/** The calling host's incarnation over a link, this host's otherwise (R20). */
	// 发起调用的主机的 incarnation（同一主机每次启动的新标识）；链路调用取对方值，本机调用取本机值。
	// 它用于区分“另一个进程里的同名对象”，运行时不校验格式，只透传。
	readonly incarnation: string;
	/**
	 * A reference as the caller (`principal`) sees it, released when the handler settles; afterwards `get` throws
	 * `released`.
	 */
	// 获取一个以调用方身份建立的引用；返回的 Promise 解析为 Reference<C>。
	// 输入：契约 C、符合该契约参数的 params、可选 GetOptions（例如 unbound 等选项）。
	// 输出：Promise<Reference<C>>；副作用：登记一个引用，处理器结算时自动释放。
	// 错误：参数不合法时 reject（运行时会检查 params）；调用已结算或已中止时 reject released。
	// 例：const counter = await ctx.get(Counter, { id: "a" }); 处理器返回后该引用被释放，再读会抛 released。
	get<C extends Contract>(Type: C, params: ParamsOf<C>, options?: GetOptions): Promise<Reference<C>>;
}

/** Who makes a call: the principal it acts as and its host's incarnation. */
// 一次调用的“行动者”：principal 是它代表的身份，incarnation 是它所在主机的启动标识。
// 两者是普通数据对象；CallContext 会复制字段，调用方之后修改原对象不会影响已建立的上下文。
export type Caller = { readonly principal: Principal | undefined; readonly incarnation: string };

/** The ctx of one handler run (or root scope): its references are released by `settle` when it settled. */
// 一次处理器运行（或根作用域）的上下文实现。构造时接收底层 Context、调用者 Caller 和主机 AnyHost；
// 不产生计时器或订阅，只有 get 会向主机申请引用。结算通过 settle 完成，重复调用 settle 是安全的。
// 例：new CallContext(callContext, { principal: "alice", incarnation: "h1" }, host)。
export class CallContext implements Ctx {
	// 复制调用者身份，避免外部对象后续变化影响本次调用。
	readonly principal: Principal | undefined;
	// 调用方主机的 incarnation，用于引用持有与 presence。
	readonly incarnation: string;
	// 底层 Context：信号、telemetry 和自定义值都委托给它。
	readonly #context: Context;
	// 主机接口：acquire 真正建立引用，并负责路由、绑定与撤销。
	readonly #host: AnyHost;
	/** The references taken with `get`; `undefined` once the handler settled. */
	// 本次调用通过 get 拿到的绑定；undefined 是已结算的哨兵，用“字段是否为 undefined”区分两种状态。
	#references: Binding[] | undefined = [];
	/** Aborted when the handler settles: a `get` still waiting gives up and releases its reference. By the first. */
	// 结算时中止的控制器；懒创建（第一次 get 时），避免没有 get 的调用多分配对象。
	// 它只用于让尚在等待的 get 放弃，不与底层调用信号混用。
	#settling: AbortController | undefined;

	// 构造上下文：保存底层 Context、调用者字段和主机；不执行 I/O，不建立引用。
	// 例：Attempt.call 中 new CallContext(linked.context, acting, host)。
	constructor(context: Context, caller: Caller, host: AnyHost) {
		this.#context = context;
		this.principal = caller.principal;
		this.incarnation = caller.incarnation;
		this.#host = host;
	}

	// 直接转发底层上下文的调用信号；调用方中止或尝试结束时，处理器里的异步工作能观察到。
	get abortSignal(): AbortSignal | undefined {
		return this.#context.abortSignal;
	}

	// 转发 telemetry，使处理器内的观测仍记到同一次调用/同一批处理上。
	get telemetry(): Context["telemetry"] {
		return this.#context.telemetry;
	}

	// 按 ContextKey 读取底层上下文的自定义值；未知键返回 undefined，不做额外缓存。
	value<T>(key: ContextKey<T>): T | undefined {
		return this.#context.value(key);
	}

	// 诊断字符串，标明这是 Ctx 包装，便于日志区分底层上下文。
	toString(): string {
		return `${this.#context}.Ctx`;
	}

	// 建立调用级引用，输入契约、参数和可选获取选项，返回引用 Promise。
	// 主流程：拒绝已结算的调用 -> 检查信号 -> 记录调用者 -> 建结算控制器 -> 委托 host.acquire ->
	// 释放临时信号链接 -> 把绑定放进 #references。副作用是向主机登记引用，结算时释放。
	// 例：await ctx.get(Counter, { id: "a" })；若处理器此刻已被中止，则直接抛 released 或原中止原因。
	async get<C extends Contract>(Type: C, params: ParamsOf<C>, options: GetOptions = {}): Promise<Reference<C>> {
		// A settled scope refuses `released` whatever aborted it; an aborted call creates nothing.
		// 结算后 #references 被设为 undefined；先判断它，保证错误码总是 released/settled，而不是中止原因。
		if (this.#references === undefined) throw settled(Type);
		// 调用信号已中止时立即抛出；这样不会为一次已取消的调用申请新引用。
		this.#context.abortSignal?.throwIfAborted();
		// Made for the caller: its principal and its origin's incarnation travel with the reference's holds.
		// 重新组装普通对象：引用持有请求会带着 principal 与 incarnation 路由到目标主机。
		const caller = { principal: this.principal, incarnation: this.incarnation };
		// 第一次 get 才创建；??= 仅在当前值为 undefined 时赋值。
		this.#settling ??= new AbortController();
		// 把“结算中止”和调用方信号串联；返回的 context 用作 acquire 的上下文。
		const scoped = withLinkedAbortSignal(this.#settling.signal, this.#context);
		let binding: Binding;
		try {
			// 真正申请引用：参数在主机侧校验，成功才返回绑定。
			binding = await this.#host.acquire(Type, params, caller, scoped.context, options);
		} catch (error) {
			// 等待期间可能已结算：优先报 released，避免把内部中止错误泄漏给调用方。
			throw this.#references === undefined ? settled(Type) : error;
		} finally {
			// 不论成功失败都移除临时 abort 监听，避免长生命周期信号持有本次调用的闭包。
			scoped.release();
		}
		// A get that finished in the turn its handler settled: nobody releases its reference later.
		// await 之后重新检查结算状态：如果处理器恰在同一轮结算，没人会再释放刚拿到的绑定，这里自己释放。
		if (this.#references === undefined) {
			binding.release();
			throw settled(Type);
		}
		// 登记到调用级列表，settle() 统一释放。
		this.#references.push(binding);
		// The binding was built from `Type`'s members.
		// 绑定是按 Type 的成员构造的，这里用 as 恢复泛型引用类型；运行时没有额外检查。
		return binding.reference as Reference<C>;
	}

	/** The handler settled: its references are released, waiting gets give up, and `get` throws from now on. */
	// 结算本次调用：先拿到当前引用列表并把字段设为 undefined（后续 get 立即拒绝），再中止等待中的 get，
	// 最后逐个 release。重复调用 settle 不会重复释放（第二次列表为空）。
	// 例：Attempt.call 在处理器 Promise 落定后调用 ctx.settle()。
	settle(): void {
		// ?? [] 处理已经结算过的重复调用：#references 为 undefined 时得到空数组。
		const references = this.#references ?? [];
		// 先置空，保证释放过程中再次进入 get 也会被拒绝。
		this.#references = undefined;
		// 取消尚在等待的 acquire 链路；结算控制器可能从未创建，用可选链跳过。
		this.#settling?.abort();
		for (const binding of references) binding.release();
	}
}

// 构造“调用已结算”的 released 错误；输入契约只用于消息，返回 ChordError，不产生副作用。
// 例：处理器返回后再调用 ctx.get(Counter, ...) 会收到 reason 为 settled 的 released 错误。
function settled(Type: Contract): ChordError {
	return new ChordError({
		code: "released",
		reason: "settled",
		message: `${Type.name}: ctx.get after its call settled`,
	});
}

/**
 * A child of `context` aborted by `signal` and by the caller's signal (the caller's reason first) until `release()`,
 * which the call runs when it settles. Not `AbortSignal.any`: before Node 24.16.0 it keeps cleanup entries per call for
 * as long as its sources live (nodejs/node#62367), and a call's sources (its attempt, its reference) live long.
 * Without a caller's signal the child is aborted by `signal` itself and `release` does nothing.
 */
// 把两个信号合成为一个子上下文，返回 { context, release }。输入：长生命周期 signal（通常是尝试的）和
// 本次调用 context。输出上下文只暴露合并后的 abortSignal，其余字段沿用 context。副作用：注册最多两个
// abort 监听；release 移除它们。错误路径：任一源已中止时，新上下文立即以该源的原因中止。
// 例：withLinkedAbortSignal(attemptSignal, callContext)；调用结束后 release()，避免监听泄漏。
export function withLinkedAbortSignal(
	signal: AbortSignal,
	context: Context,
): { readonly context: Context; release(): void } {
	// 调用方没有信号时不需要合并：直接换成尝试信号，release 用共享空函数。
	const caller = context.abortSignal;
	if (caller === undefined) return { context: withAbortSignal(signal, context), release: NOTHING };
	// 手写合并控制器；不使用 AbortSignal.any，原因是旧 Node 会随长生命周期源累积清理项。
	const linked = new AbortController();
	// 每个源对应一个转发函数；as const 让元组保留 [AbortSignal, () => void] 的精确类型。
	const listeners = [caller, signal].map((source) => {
		const forward = (): void => {
			// 先移除两个监听，再中止子控制器；链接只触发一次。
			release();
			linked.abort(source.reason);
		};
		return [source, forward] as const;
	});
	// release 在 forward 之后声明，但 forward 只会在事件回调里执行，届时 release 已初始化；
	// 这是闭包引用同一作用域 const 的典型写法。
	const release = (): void => {
		for (const [source, forward] of listeners) source.removeEventListener("abort", forward);
	};
	// 任一源可能已中止：同步扫描一次，保证子上下文立刻带上原因，而不是等下一次事件。
	const aborted = listeners.find(([source]) => source.aborted);
	if (aborted !== undefined) linked.abort(aborted[0].reason);
	else for (const [source, forward] of listeners) source.addEventListener("abort", forward, { once: true });
	// withAbortSignal 附加合并信号；withoutAbortSignal 去掉原调用方信号，避免同一上下文出现两个信号来源。
	return { context: withAbortSignal(linked.signal, withoutAbortSignal(context)), release };
}

// 共享的空操作函数：无调用方信号时作为 release，避免每次调用分配新闭包。
const NOTHING = (): void => {};
