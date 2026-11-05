// Natives (§13): the handle `self.open` returns, a value opened during activation and closed with a reason when its
// attempt ends; `within`, which bounds a close or a drain by a timeout; and the drain's admission of running work.

// 所属：packages/chord/src/host 的原生资源（native）生命周期模块，对应设计 §13。
// 职责边界：实现 self.open 返回的句柄、按原因关闭、超时等待与排空；不决定何时激活对象，只执行打开的资源和关闭回调。
// 上游：attempt.ts 为每个 self.open 创建 NativeHandle，并在激活/清理阶段调用 open/close；关闭失败进入 HostError 报告。
// 下游：插件提供的 open/close 回调；within/drained 供 attempt 等待关闭或后台工作；onError 收到 close_timeout/close_failed。
// 结果与错误：句柄状态机 unopened -> opening -> open -> closed（或 abandoned 接住迟到的打开值）；打开失败原样拒绝。
// 能力清单：
// - NativeCloseReason：关闭原因 end/close/reload 的判别联合。
// - Native<T>：插件可见句柄，只暴露 value。
// - NativeOptions：close 的等待毫秒数（缺省用宿主 closeTimeout）。
// - CloseFailed：HostError 中 close_failed 分支的类型别名。
// - NativeSlot：attempt 对任意资源类型统一执行 open/close 的接口。
// - NativeHandle<T>：单次尝试的句柄实现，保证最多打开一次、恰好关闭一次。
// - within：在 ms 内等待 Promise settle，返回 settled/timeout，不取消原工作。
// - drained：等待 drain 中已知数量的工作全部 settle，空集合立即返回。
// 组合与典型顺序：激活时 attempt 调 open -> 插件 open 完成 -> 对象结束/失败/重载时 close(reason) ->
// #closeValue 用 within 限时并汇报超时；宿主关闭时对所有句柄执行 close({kind:"close"})。
// 示例：const handle = new NativeHandle(open, close, 1000, owner);
//       await handle.open(context);
//       const value = handle.value; // 未打开时抛 not_ready
// 建议阅读顺序：NativeCloseReason/Native/NativeOptions -> NativeSlot -> NativeHandle（value/open/close/#opened/#closeValue）-> within/drained。

import { type Context, withAbortSignal } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { HostError } from "./host.ts";

/** Why a native closes: its object ended or its attempt failed (`end`), the host closes (`close`), a reload (slice 7). */
// 关闭原因：对象结束或尝试失败、宿主关闭、重载替换实例。它是可辨识联合，而不是裸字符串。
export type NativeCloseReason = { readonly kind: "end" } | { readonly kind: "close" } | { readonly kind: "reload" };
// kind 区分对象结束、宿主关闭和重载；联合类型使调用者不能拼写任意关闭原因。

/** A native's handle. */
// 插件拿到的句柄接口：只暴露 value，打开/关闭由 Chord 内部调用。
export interface Native<T> {
	/** The opened value: throws `not_ready` until its open resolved and `released` once its close started. */
	// T 是资源类型（连接、文件句柄等），由插件的 open 回调决定；编译期泛型，运行时无校验。
	readonly value: T;
}

/** What `self.open` takes besides the open and the close. */
export type NativeOptions = {
	/** How long its close may take; the host's `closeTimeout` by default. */
	// 毫秒数；undefined 时由宿主 closeTimeout 填充。只影响等待，不会强制终止插件的 close。
	readonly closeTimeout?: number;
};

/** A close that threw, as reported. */
export type CloseFailed = Extract<HostError, { readonly kind: "close_failed" }>;
// Extract 从 HostError 联合中筛选 close_failed 分支；只是类型运算，不会过滤运行时错误。

/**
 * Where a native belongs: its object's label and its position in declaration order (from 1) for errors and reports,
 * the object's context (every close runs under it, never under the aborted opener's), and where it reports.
 */
// 归属信息：object/position 用于错误定位；context 是对象上下文（关闭不继承已取消的启动上下文）；
// report 把后台关闭失败交给宿主 onError。这些字段由 attempt 构造时提供。
type NativeOwner = {
	readonly object: string;
	readonly position: number;
	readonly context: Context;
	readonly report: (error: HostError) => void;
};

/** What an attempt does with each of its natives, whatever their value's type. */
// 一次激活对每个 native 的统一操作接口：open 等待打开；close 返回关闭失败记录或 undefined。
// 泛型 T 被擦除，所以 attempt 能以同一集合遍历不同资源类型的句柄。
export interface NativeSlot {
	open(context: Context): Promise<void>;
	close(reason: NativeCloseReason): Promise<CloseFailed | undefined>;
}

/** Where a native stands. `abandoned`: closed while its open was pending, so the late value is closed at once. */
// 五态状态机：未打开 → 打开中 → 已打开 → 已关闭；若关闭先于打开完成，则进入 abandoned，
// 迟到的值由 #opened 立即清理。状态对象是判别联合，编译器据此保证只读取该状态的字段。
type NativeState<T> =
	| { readonly kind: "unopened" }
	| { readonly kind: "opening" }
	| { readonly kind: "open"; readonly value: T }
	| { readonly kind: "abandoned"; readonly reason: NativeCloseReason }
	| { readonly kind: "closed" };

/** One native of one attempt: opened at most once, closed exactly once. */
// 每个 native 每次尝试一个句柄。构造只保存回调与配置；open 与 close 的竞争由 #state 串行化。
export class NativeHandle<T> implements Native<T>, NativeSlot {
	// T 是打开资源的实际类型，例如文件句柄；# 字段是 JavaScript 的私有字段，外部无法直接读写。
	readonly #open: (context: Context) => Promise<T>;
	readonly #close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>;
	readonly #closeTimeout: number;
	readonly #owner: NativeOwner;
	#state: NativeState<T> = { kind: "unopened" };

	// 保存打开/关闭回调、超时毫秒数与归属信息；不执行回调，无返回值。
	// 例如传入数据库连接回调，只会在 activate 调用 open 时真正建立连接。
	constructor(
		open: (context: Context) => Promise<T>,
		close: (value: T, reason: NativeCloseReason, context: Context) => void | Promise<void>,
		closeTimeout: number,
		owner: NativeOwner,
	) {
		// 将各输入保存到本句柄，供激活和结束阶段使用。
		this.#open = open;
		this.#close = close;
		this.#closeTimeout = closeTimeout;
		this.#owner = owner;
	}

	// 读取已打开的资源，无参数；返回 T，不复制资源。例：句柄 open 后读取 value 可得到原连接。
	// 未完成打开抛 not_ready；开始关闭后抛 released，避免继续获取已交给清理回调的资源。
	get value(): T {
		// 用局部快照判别 kind，TypeScript 据此知道 open 分支携带 value。
		const state = this.#state;
		if (state.kind === "open") return state.value;
		const name = this.#name();
		// 尚未打开和正在打开都没有可用值；错误消息包含对象与声明位置。
		if (state.kind === "unopened" || state.kind === "opening") {
			throw new ChordError({ code: "not_ready", message: `${name}: not open yet` });
		}
		throw new ChordError({ code: "released", reason: "closed", message: `${name}: closed` });
	}

	/** Opens the value; one that arrives after its attempt was abandoned is closed at once, a failure reported. */
	// 激活阶段用给定上下文打开资源；返回完成信号，不返回 T。失败原样拒绝，让 attempt 决定失败类别。
	// 例如网络连接晚于结束才到达，#opened 会立即关闭它；调用者按 NativeSlot 协议只打开一次。
	async open(context: Context): Promise<void> {
		// 先标记进行中，使并发 close 能留下 abandoned 原因。
		this.#state = { kind: "opening" };
		// 内层 await 等资源，外层 await 等资源收下或迟到清理；两处错误都会拒绝 open。
		await this.#opened(await this.#open(context));
	}

	/** Closes the value if it is open (a pending open's value is closed when it arrives); resolves with a throw. */
	// 按原因关闭：已打开则等清理，尚在打开则记下原因，其他状态无事可做；返回失败记录或 undefined。
	// 例如 close({kind:"close"}) 不等待一个悬挂的 opener，迟到值由 #opened 清理。
	async close(reason: NativeCloseReason): Promise<CloseFailed | undefined> {
		// 先把句柄变得不可读，再调用插件清理，避免清理期间再次取得 value。
		const state = this.#state;
		this.#state = state.kind === "opening" ? { kind: "abandoned", reason } : { kind: "closed" };
		return state.kind === "open" ? this.#closeValue(state.value, reason) : undefined;
	}

	/** Keeps the value an open resolved with, or closes it at once when the native was closed meanwhile. */
	// 接收 opener 的实际结果：正常保存，若本次打开已被放弃就关闭；返回完成信号，清理失败走报告渠道。
	// 例如超时后才连上的 socket 不会被重新公开给对象。
	async #opened(value: T): Promise<void> {
		const state = this.#state;
		if (state.kind !== "abandoned") {
			// 正常完成时从 opening 进入 open；此方法依赖 NativeSlot 的生命周期调用约定。
			this.#state = { kind: "open", value };
			return;
		}
		this.#state = { kind: "closed" };
		// 使用被放弃时记录的原因；普通 close 的返回通道已经结束，迟到失败只能另行报告。
		const failure = await this.#closeValue(value, state.reason);
		if (failure !== undefined) this.#owner.report(failure);
	}

	/**
	 * Runs the close under the object's context, aborted at the close timeout, and waits for it up to then; longer is
	 * reported.
	 */
	// 用对象上下文运行插件的 close，最多等待配置的毫秒数。返回抛错记录，超时仅报告并发出取消信号。
	// 例如 close 挂住会报告 close_timeout，后续资源仍可清理；Promise 本身不会被强制杀死。
	async #closeValue(value: T, reason: NativeCloseReason): Promise<CloseFailed | undefined> {
		// 解构取得归属与报告函数；as const 让 native.kind 保留字面量类型而不变成 string。
		const { object, position, context, report } = this.#owner;
		const at = { object, native: { kind: "native", position } } as const;
		const timeout = new AbortController();
		// async 包装把同步 throw 也变成拒绝；替换信号使清理不直接继承已取消的 opener 信号。
		const closing = (async () => this.#close(value, reason, withAbortSignal(timeout.signal, context)))();
		try {
			// within 在期限内完成返回 settled，超时返回 timeout，拒绝则抛给 catch。
			if ((await within(closing, this.#closeTimeout)) === "timeout") {
				timeout.abort(new ChordError({ code: "aborted", message: `${this.#name()}: close timed out` }));
				// 超时与抛错分开报告：超时不作为 CloseFailed 返回。
				report({ kind: "close_timeout", ...at });
			}
			return undefined;
		} catch (error) {
			// 展开 at 加入统一定位字段，交上层收集或报告；不在此重新抛出插件异常。
			return { kind: "close_failed", ...at, error };
		}
	}

	// 组合错误中使用的资源名，无输入、无副作用；例："store native #2"，位置从声明顺序而来。
	#name(): string {
		return `${this.#owner.object} native #${this.#owner.position}`;
	}
}

/** Whether `promise` settled within `ms` (it rejects when `promise` does first); `promise` itself runs on. */
// 等待 promise 或 ms 毫秒的定时器；返回 settled/timeout，原 Promise 拒绝则继续抛错。
// 例：5ms 结束的工作配 100ms 返回 settled；100ms 后仍未结束返回 timeout，工作仍在后台运行。
// 只管理自己的定时器，不取消输入工作；finally 在成功、拒绝和超时三种路径都执行。
export async function within(promise: Promise<unknown>, ms: number): Promise<"settled" | "timeout"> {
	// ReturnType<typeof setTimeout> 由当前平台类型决定定时器句柄类型，undefined 表示还没赋值。
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Promise 构造器同步调用回调，故 timer 会在下面 race 前被赋值。
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(resolve, ms, "timeout");
	});
	try {
		// then 只把成功值换成字符串标签，原拒绝仍传播；as const 保留该字面量类型。
		return await Promise.race([promise.then(() => "settled" as const), timeout]);
	} finally {
		// 输入工作先结束时撤销尚未触发的计时，避免遗留定时器。
		clearTimeout(timer);
	}
}

/** Whether the `size` pieces of work in `drain` settled within `ms` (at once when there is none). */
// 等待 drain 中的后台工作全部 settle，最多 ms 毫秒；size 是调用方已知数量，避免空集合的异步开销。
// 返回 settled/timeout；单项拒绝由 allSettled 吸收，因为排空只关心是否结束。例：size=0 立即完成。
export async function drained(
	drain: Iterable<Promise<unknown>>,
	size: number,
	ms: number,
): Promise<"settled" | "timeout"> {
	// 非空时把 Iterable 转成一个等全部完成的 Promise，再复用超时逻辑；不遍历统计 size。
	return size === 0 ? "settled" : within(Promise.allSettled(drain), ms);
}
