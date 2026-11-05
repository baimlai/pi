// Root scopes (slice 8 §4, D3, design §8): `host.root(fn, context, options?)`, a call context for code outside objects
// (a Durable tool, a CLI), sealed when `fn` settles, when `context` aborts and when the host closes: its signal aborted,
// its `ctx.get` refused `released`, every reference it took released.
// 本文件实现 host.root 的作用域管理：为对象外的代码创建和 handler 一样的调用上下文，并保证结束时释放引用。
// 上游是 Host.root（host.ts）；结果沿 fn 的 Promise 返回。宿主关闭时 RootScopes.close 统一封口并拒绝调用方。
// 所属模块：packages/chord/src/host 的根调用作用域（host.root）。
// 上下游：Host.root 转发到 RootScopes.run；依赖 CallContext/Ctx、host.incarnation 与 context 的取消链接。
// 结果：Promise 按 fn 结果兑现；fn 结束、父取消或宿主关闭都会释放引用并中止作用域。提前取消直接拒绝。
// 能力清单：
// - RootOptions<P>：host.root 的可选参数（principal）。
// - RootScopes：每个宿主一份，run 创建作用域，close 在宿主关闭时统一封口。
// - SETTLED：fn 正常结束时的内部释放原因。
// 组合关系：run 建 AbortController 与 CallContext -> 登记 open -> 执行 fn -> then/catch 中 seal 再兑现。
// 示例：await host.root(async (ctx) => { const notes = await ctx.get(Notes); return notes.add("x"); }, context, { principal });
// 阅读顺序：先 RootOptions 与 OpenScope 结构，再 run 的登记/清理，最后 close 与 SETTLED 的语义。

import { awaitWithContext, type Context, withAbortSignal, withoutAbortSignal } from "../context/index.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { CallContext, type Ctx } from "./ctx.ts";
import type { AnyHost } from "./host.ts";

/** What `host.root` takes besides `fn` and the context. */
export type RootOptions<P extends Principal = Principal> = {
	// P 是应用定义的身份类型；? 允许省略该字段，显式 undefined 则表示匿名身份，由 host.root 区分这两种输入。
	/**
	 * Whom the scope acts as: the host's principal when omitted; a trusted same-host caller's choice (base code), an
	 * explicit `undefined` anonymous (`ctx.principal` undefined).
	 */
	readonly principal?: P | undefined;
};

/** An open root scope: its seal, and how its caller is rejected when the host closes. */
// 两个函数字段：seal 负责清理资源（只生效一次），reject 负责让调用方的 Promise 立刻失败。
// 分开是因为资源清理与“调用方何时收到拒绝”不一定同一时刻：fn 可以继续运行。
type OpenScope = { readonly seal: (reason: unknown) => void; readonly reject: (reason: unknown) => void };

/** The open root scopes of a host, each sealed once; `close` seals the rest and rejects their callers. */
// 一个宿主的所有未结束根作用域。Set 只用来枚举，封口是否已发生由每个 scope 自己的 seal 闭包判断。
export class RootScopes {
	// AnyHost 是宿主内部接口；RootScopes 只用它创建 CallContext（取 incarnation 和 ctx.get）。
	readonly #host: AnyHost;
	/** Each open scope: how it is sealed with a reason, and its caller's rejection when the host closes. */
	// Set 保持插入顺序；close 时复制成数组再遍历，避免 seal 删除元素影响本轮。
	readonly #open = new Set<OpenScope>();

	constructor(host: AnyHost) {
		// 保存宿主供后续创建调用上下文；这里只建立管理器，不启动用户代码或创建引用。
		this.#host = host;
	}

	/**
	 * Runs `fn` with a call context like a handler's (`principal`, this host's incarnation, `context`'s telemetry, a
	 * signal linked to `context`'s), sealed when `fn` settles, `context` aborts or the host closes. Resolves as `fn`
	 * does; rejects at once when `context` aborts or the host closes (an uncooperative `fn` runs on and fails at its
	 * next use of Chord), or when `context` was aborted already (`fn` does not run).
	 */
	// 在对象外运行一次有生命周期的调用。输入是异步函数、调用身份和父上下文，返回同一结果类型 T 的 Promise。
	// 正常结束、父取消或宿主关闭都会释放 ctx.get 的引用；函数本身若不响应取消，仍可能继续运行。
	// 例如 CLI 在 fn 中取得 Notes 并调用 add，fn 返回后该引用自动释放；这里只举例，不额外执行任何 CLI。
	run<T>(fn: (ctx: Ctx) => Promise<T>, principal: Principal | undefined, context: Context): Promise<T> {
		// 可选信号没有值时不安装取消监听；已有取消则同步抛出，fn 不会执行。
		const caller = context.abortSignal;
		caller?.throwIfAborted();
		// 局部变量供回调捕获同一个宿主。
		const host = this.#host;
		// The scope's own signal, aborted by its seal; the caller's abort seals it (one listener, no linked signal: a
		// request's scope is made per HTTP request).
		const controller = new AbortController();
		// 去掉父信号后使用自己的信号，父取消通过下面的 seal 同时完成引用释放和取消传播。
		const scope = withAbortSignal(controller.signal, caller === undefined ? context : withoutAbortSignal(context));
		// 身份和 incarnation 随调用作用域交给 ctx.get；这里不重新认证 principal。
		const ctx = new CallContext(scope, { principal, incarnation: host.incarnation }, host);
		// 分开保存 Promise 和兑现函数，允许宿主关闭先拒绝调用方，即使 fn 仍未结束。
		const result = Promise.withResolvers<T>();
		const open: OpenScope = {
			seal: (reason) => {
				// delete 的布尔结果让封口只生效一次；后来的结束或取消不会重复释放。
				if (!this.#open.delete(open)) return;
				// 正常结束也要移除父监听，避免父上下文长期持有本次调用。
				caller?.removeEventListener("abort", aborted);
				// References first: a `get` still waiting gives up with `released`, not with the abort's reason.
				ctx.settle();
				// abort 通知协作式异步操作停止，不会中断任意 JavaScript 函数。
				controller.abort(reason);
			},
			// 关闭宿主时直接使用该拒绝入口。
			reject: result.reject,
		};
		// 箭头函数保留 this；取消原因来自父信号。监听安装前先把作用域登记。
		const aborted = (): void => open.seal(caller?.reason);
		this.#open.add(open);
		caller?.addEventListener("abort", aborted, { once: true });
		// Plugin code: a synchronous throw becomes the rejection.
		// 用 async IIFE 包住 fn：fn 同步抛错会变成 rejected Promise，而不会在这里同步冒泡。
		// 这是在插件代码边界上统一错误路径，不改变 fn 的返回值。
		const running = (async () => fn(ctx))();
		running.then(
			(value) => {
				// 先封口再交还结果，调用方拿到结果时引用已经释放。
				open.seal(SETTLED);
				result.resolve(value);
			},
			(error: unknown) => {
				// unknown 要求使用者先确认错误类型；本处原样传播，不假设它一定是 Error。
				open.seal(SETTLED);
				result.reject(error);
			},
		);
		// A method's caller gets `released` when its object ends, whatever the handler still does: so does this one
		// (`close` rejects `result`), and at once when its context aborts.
		// 有父信号时额外竞速取消；seal 负责资源清理，awaitWithContext 负责立即拒绝调用方。
		return caller === undefined ? result.promise : awaitWithContext(result.promise, context);
	}

	/** The host closes: every open scope is sealed with `reason`, its caller rejected with it. */
	// 宿主关闭入口：逐个封口并以同一原因拒绝。无返回；已经结束的作用域不在集合中，因此不会被重复处理。
	// 示例：close(releasedError) 后，仍在 await 的 host.root 调用立即拒绝，即使 fn 还在执行自己的逻辑。
	close(reason: unknown): void {
		// 关闭所有未结束作用域，无返回值；例如 host.close 传 released，调用方会收到该原因。
		// 展开为数组取得快照，seal 从 Set 删除当前项时不影响本轮遍历。
		for (const open of [...this.#open]) {
			// 释放引用并中止作用域，然后拒绝尚未完成的结果 Promise。
			open.seal(reason);
			open.reject(reason);
		}
	}
}

/** The abort reason of a scope whose `fn` settled. */
// 正常结束后仍然要 abort 作用域信号：让作用域内残留的协作式异步操作看到取消。reason 为 released/settled，
// 与“对象结束”的 released/ended 区分。错误对象复用同一值，不携带调用栈之外的状态。
const SETTLED = new ChordError({ code: "released", reason: "settled", message: "host.root: its fn settled" });
