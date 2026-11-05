// 所属：Chord 的可移植 context 模块（与 Durable 共用），提供调用范围内显式传递的不可变上下文值。
// 职责：用 ContextKey 类型安全地保存 abort signal、telemetry span 和应用自定义值；组合而非修改父上下文。
// 边界：不是 AsyncLocalStorage，不会自动跨 await/回调传播；不拥有取消源，只组合/遮蔽调用者传入的 signal。
// 上游：host/object/job 等接收 Context；下游：pi-telemetry 的 span、AbortSignal、应用自定义 ContextKey。
// 导出清单：ContextKey/Context 类型；BACKGROUND_CONTEXT/TODO_CONTEXT 空根；createContextKey/withContextValue；
// withTelemetry/traceIn；withAbortSignal/withoutAbortSignal/withCancel/awaitWithContext；内部实现类不导出。
// 组合顺序：选根 → withAbortSignal/withContextValue 逐层派生 → traceIn 创建子 span → awaitWithContext 等待并响应取消。
// 示例：const key = createContextKey<number>("n"); const context = withContextValue(key, 1, BACKGROUND_CONTEXT);
// 阅读顺序：ContextKey/Context → 内置 key → BaseContext → EmptyContext/ContextValue → 常量 → 组合函数 → await/abortError。
import { NOOP_TELEMETRY_CONTEXT, type SpanOptions, type TelemetrySpan } from "@earendil-works/pi-telemetry";

/** Typed identity for one value carried by a {@link Context}. */
// 带类型的键：token 是运行时身份（Symbol），valueType 只在编译期携带 T，防止不同值类型的键被互换。
// 两个键即使 description 相同，token 也不同；valueType 从不在运行时赋值，声明它仅为类型推断。
export interface ContextKey<T> {
	// token：真正的查找依据；Symbol 保证进程内唯一，无法被字符串键意外命中。
	readonly token: symbol;
	/** Type-only marker that prevents keys with different value types from being interchangeable. */
	readonly valueType?: (value: T) => T;
}

/** Immutable invocation-scoped values passed explicitly through operations. */
// 一次调用链上显式传递的只读上下文：取消信号可缺省，telemetry 总是可用（缺省为 noop）。
// 实现是不可变值链：每次派生返回新对象，父对象保持不变。
export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	readonly telemetry: TelemetrySpan;
	// 按键查找值；未设置时返回 undefined。泛型 T 由 key 的类型参数推断，调用方无需再写。
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

// 内置键：取消信号。Object.freeze 是运行时冻结，防止 token/对象被替换；值本身是 undefined 表示“无取消”。
const ABORT_SIGNAL_CONTEXT_KEY: ContextKey<AbortSignal | undefined> = Object.freeze({
	token: Symbol("chord.abortSignal"),
});

// 内置键：当前 telemetry span；BaseContext.telemetry 在缺失时回退到 NOOP，保证调用方无需判空。
const TELEMETRY_CONTEXT_KEY: ContextKey<TelemetrySpan> = Object.freeze({
	token: Symbol("chord.telemetry"),
});

// 所有上下文实现的基类：把 abortSignal/telemetry 两个便捷 getter 建立在通用 value 查找之上。
abstract class BaseContext implements Context {
	abstract value<T>(key: ContextKey<T>): T | undefined;
	abstract toString(): string;

	get abortSignal(): AbortSignal | undefined {
		return this.value(ABORT_SIGNAL_CONTEXT_KEY);
	}

	// 缺失时用 NOOP_TELEMETRY_CONTEXT，仍返回完整 span 接口；不会创建或记录真实 span。
	get telemetry(): TelemetrySpan {
		return this.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
	}
}

// 值链的根：任何键都返回 undefined；#name 只用于 toString 调试，不影响查找。
class EmptyContext extends BaseContext {
	readonly #name: string;

	constructor(name: string) {
		super();
		this.#name = name;
	}

	value<T>(_key: ContextKey<T>): T | undefined {
		return undefined;
	}

	toString(): string {
		return this.#name;
	}
}

// 值链节点：保存 parent/key/value；查找先比较 token，未命中则递归到 parent。
class ContextValue<T> extends BaseContext {
	readonly #parent: Context;
	readonly #key: ContextKey<T>;
	readonly #value: T;

	constructor(parent: Context, key: ContextKey<T>, value: T) {
		super();
		this.#parent = parent;
		this.#key = key;
		this.#value = value;
	}

	value<Value>(key: ContextKey<Value>): Value | undefined {
		// token 相同即认为类型相同；两个 as 是因为运行时擦除泛型，TypeScript 无法从 token 证明 Value === T。
		// 这是模块内的约定：ContextKey 只能由 createContextKey 创建，调用方不能伪造同 token 的异类型键。
		if (key.token === this.#key.token) return this.#value as unknown as Value;
		return this.#parent.value(key);
	}

	toString(): string {
		return `${this.#parent}.WithValue(${this.#key.token.description ?? "anonymous"})`;
	}
}

// 没有取消、没有 telemetry 的根上下文，用于后台工作；TODO_CONTEXT 是另一实例，toString 可区分类别。
export const BACKGROUND_CONTEXT: Context = new EmptyContext("[Context BACKGROUND_CONTEXT]");
export const TODO_CONTEXT: Context = new EmptyContext("[Context TODO_CONTEXT]");

// 创建一个新键：description 只进入 Symbol 描述，便于调试；每次调用都生成不同 token。
// 示例：const RequestId = createContextKey<string>("requestId"); context.value(RequestId) 返回 string | undefined。
// 返回对象被冻结；泛型 T 由调用方显式指定或从上下文推断。
export function createContextKey<T>(description: string): ContextKey<T> {
	return Object.freeze({ token: Symbol(description) });
}

// 派生一层新上下文：同一 token 的值被新值遮蔽，其余键继续向 parent 查找；parent 本身不变。
/** Derive a context containing one additional or replaced value. */
export function withContextValue<T>(key: ContextKey<T>, value: T, parent: Context): Context {
	return new ContextValue(parent, key, value);
}

/** Derive an explicit telemetry parent without changing cancellation or application values. */
// 派生一个只替换 telemetry 的上下文；取消信号和自定义值保持原样。
// 返回类型交叉 & { telemetry: T } 让调用方无需断言就能拿到更具体的 span 类型。
// 实现末尾的 as 是必要的：接口 getter 声明为 TelemetrySpan，泛型 T 的收窄无法由实现自动证明。
export function withTelemetry<T extends TelemetrySpan>(
	telemetry: T,
	context: Context,
): Context & { readonly telemetry: T } {
	return withContextValue(TELEMETRY_CONTEXT_KEY, telemetry, context) as Context & { readonly telemetry: T };
}

/** Run a child span with a derived context whose telemetry member is that span. */
// 在当前 telemetry 下创建子 span，并把该 span 作为子上下文传给 fn；返回 fn 的结果。
// 输入 options/fn/context；输出 Promise<T>。fn 同步抛错或 Promise 拒绝会原样传播，span 由 startSpan 收尾。
// 副作用：开始/结束一个 span；child context 仍共享父 abortSignal 和自定义值。
// 示例：await traceIn({ name: "load" }, async (ctx) => ctx.telemetry.addEvent("x"), context);
export function traceIn<T>(
	options: SpanOptions,
	fn: (context: Context) => T | Promise<T>,
	context: Context,
): Promise<T> {
	return context.telemetry.startSpan(options, (span) => fn(withTelemetry(span, context)));
}

/**
 * Derive a context cancelled by either the parent signal or the supplied signal.
 * The parent context remains unchanged.
 */
// 派生一个“父 signal 或传入 signal 任一取消即取消”的上下文；父上下文保持不变。
// 父无 signal 时直接采用传入 signal；否则 AbortSignal.any 组合，任一触发都会中止组合信号。
// 不注册/移除手动监听器，组合信号由平台管理；传入 signal 已中止时结果立即是 aborted。
export function withAbortSignal(signal: AbortSignal, context: Context): Context {
	const parentSignal = context.abortSignal;
	const combined = parentSignal === undefined ? signal : AbortSignal.any([parentSignal, signal]);
	return withContextValue(ABORT_SIGNAL_CONTEXT_KEY, combined, context);
}

/** Derive a context retaining all values except caller cancellation. Intended for mandatory cleanup only. */
// 派生一个遮蔽取消信号的上下文，其余值原样保留；只应用于必须完成的清理路径。
export function withoutAbortSignal(context: Context): Context {
	return withContextValue(ABORT_SIGNAL_CONTEXT_KEY, undefined, context);
}

/** Derive an independently cancellable child context. */
// 派生一个可独立取消的子上下文：返回新 context 和 cancel 函数；cancel 只影响这层，不取消父上下文。
// reason 原样交给 AbortController.abort；之后 awaitWithContext/监听 signal 的操作会看到中止。
// 示例：const { context: child, cancel } = withCancel(parent); cancel(new Error("stop"));
export function withCancel(context: Context): {
	readonly context: Context;
	readonly cancel: (reason?: unknown) => void;
} {
	const controller = new AbortController();
	return {
		context: withAbortSignal(controller.signal, context),
		cancel: (reason?: unknown) => controller.abort(reason),
	};
}

/**
 * Observe a promise until it settles or the invocation is cancelled.
 * Cancellation rejects only this waiter; it does not cancel the underlying promise.
 */
// 等待 promise，同时在 context 被取消时只拒绝这个等待者；底层 promise 不会被取消。
// 无 signal 时直接返回原 promise；已中止时立即用 abortError 拒绝，不注册监听器。
// 副作用：在 signal 上临时注册 once 监听器，promise 成功/失败时移除；取消后 promise 仍可能继续运行。
// 示例：await awaitWithContext(fetchWork(), context) 在 ctx 取消时抛 AbortError/调用者的 reason。
export function awaitWithContext<T>(promise: Promise<T>, context: Context): Promise<T> {
	const signal = context.abortSignal;
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		// once: true 让监听器触发后自动移除；若 promise 先结束，下面的成功/失败回调会手动移除。
		const onAbort = (): void => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		// 不返回这个 then 的链，外层 Promise 只由 resolve/reject 控制；void 表明故意忽略其返回值。
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

// 把 signal.reason 规范成 Error：调用方传 Error 时原样返回，否则构造 DOMException AbortError。
// 这样上层可以统一按 Error 处理，同时保留调用者给出的具体原因。
function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
