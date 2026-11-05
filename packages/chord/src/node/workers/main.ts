// The worker's side (slice 10 §3): `workerMain` reads the start message, takes the address's lock, makes the link to
// the server (`started` goes out when the app's host listens on it), runs the app's function with a plugin runtime over
// the shipped scripts, reports `ready` and each idle flip, applies reloads, and on `shutdown`, the parent's disconnect,
// `SIGTERM` or `SIGINT` aborts its context, runs the app's closers in reverse order and exits.

// 文件导读
// 所属模块：packages/chord/src/node/workers，worker 子进程侧的生命周期入口。
// 解决的问题：子进程被 fork 后不知道地址、启动数据和插件脚本；这些必须等服务器发 start 消息。随后它要在同一地址上
//   取得跨进程锁、建立到服务器的 link、运行应用函数、报告 started/ready/idle，并在重载与关闭时安全收敛。
// 职责边界：只负责单个 worker 进程内部；不决定何时启动、是否重试、如何授权（这些在服务器侧 workers.ts）。
//   它不解释业务错误，致命错误经 redact 压缩后作为 fatal 发出。
// 上游：应用入口模块调用 workerMain(fn, options)；服务器通过控制消息发送 start/reload/shutdown。下游：
//   processLock（地址互斥）、ipcLink（与服务器通信）、createPluginRuntime（加载/重载插件）、应用 fn。
//   结果与错误流向：started -> ready -> idle 翻转 -> reloaded；异常导致 fatal（redact 后）并以非零码退出；
//   正常 shutdown 中止 context、逆序运行 closers，最多等待 3 秒后强制退出。
// 能力清单：
// - WorkerStart：应用函数拿到的地址、start 数据、parent link、plugins 和 onClose。
// - WorkerPlugins：在应用的 host 上加载该 kind 的脚本。
// - WorkerResult：可选的 busy 计数 watchable，非零表示不能 idle。
// - WorkerMainOptions：hostPackages、redact、onError。
// - workerMain()：子进程入口，内部创建 Worker 并运行。
// - Worker（内部类）：启动、消息、重载、空闲与关闭状态机；ParentLink 负责在 host 监听 link 时发出 started。
// 组合关系：workerMain -> Worker.run -> 等 start -> processLock -> ParentLink(ipcLink) -> 应用调 plugins.load ->
//   应用 fn（期间 parent.onMessage 触发 started）-> fn 返回后 #follow 监听活动 -> 发 ready -> 处理 reload/idle ->
//   shutdown 时中止 context 并逆序执行 closers。
// 示例（示例，不是本文件的运行代码）：
//   workerMain(async ({ parent, plugins, onClose }, context) => {
//     onClose(() => cleanup());                 // 逆序执行
//     const host = makeHost();
//     await plugins.load(host, { kind: "worker", core: [] }, context);
//     parent.onMessage((frame) => { void frame; }); // 应用开始监听时发出 started
//     return { busy: host.busy };               // 可选
//   }, { hostPackages, redact, onError });
// 建议阅读顺序：先看 WorkerStart/WorkerPlugins/WorkerResult/WorkerMainOptions 与 workerMain，再看 Worker 构造器中的
//   事件接线，随后按 #run（启动）-> #follow/#isIdle/#flip（活动）-> #message/#applyReloads（重载）-> #shutdown/#fatal
//   （收尾）阅读，最后看 ParentLink 如何把连接动作转换成 started。

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../../context/index.ts";
import type { Address } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, LoadReport, PluginFacet, ReloadReport } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { type IpcPort, ipcLink, type Link } from "../../link/index.ts";
import type { Watchable } from "../../watch.ts";
import type { HostPackages } from "../plugins/evaluate.ts";
import { createPluginRuntime, type PluginScript } from "../plugins/runtime.ts";
import {
	type CrossedError,
	controlOf,
	crossed,
	crossedReport,
	envelope,
	type FromWorker,
	type ToWorker,
} from "./control.ts";
import { processLock } from "./lock.ts";

/** What the app's function gets. */
// 应用函数在服务器发出 start、子进程取到锁后运行。parent 是到服务器的 link；plugins 已绑定本 kind 的脚本。
// onClose 注册的清理函数在 shutdown 时逆序执行，适合释放数据库、后台任务等资源。
export type WorkerStart = {
	readonly address: Address;
	/** The start data the server's `start(address)` gave. */
	readonly start: JsonValue;
	/** The link to the server: `connect` it before anything slow (`started` goes out then). */
	readonly parent: Link;
	readonly plugins: WorkerPlugins;
	/** Registers a closer: closers run in reverse order at shutdown. */
	onClose(closer: (context: Context) => Promise<void> | void): void;
};

/** The worker's plugins: the shipped scripts of its kind, loaded on its host; the server's reloads applied to it. */
// load 由应用显式调用，把 host 和 core facets 交给插件运行时；运行时记住 host，供后续 reload 使用。
// 返回 LoadReport（失败插件列表），worker 会把它压缩成 ready 报告的一部分。
export interface WorkerPlugins {
	/** Loads `host` with the start message's scripts of `kind` and `core` (the app's own facets). */
	load<P extends Principal>(
		host: Host<P>,
		options: { readonly kind: string; readonly core: readonly PluginFacet<P>[] },
		context: Context,
	): Promise<LoadReport>;
}

/** What the app's function returns: extra keep-alive counts (busy while any is nonzero). */
// 除 host.activity 的 references/jobs/lingering 外，应用可用 busy 表达自己的存活计数；任一非零即不 idle。
export type WorkerResult = { readonly busy?: Watchable<Readonly<Record<string, number>>> };

/** What `workerMain` takes besides the app's function. */
// hostPackages 必须是本进程自己的实例（函数不能跨 IPC）；redact 决定对外可见的致命错误；
// onError 接收未压缩的内部错误，供应用日志使用。
export type WorkerMainOptions = {
	/** The host packages by specifier: this process's own instances (functions cannot cross IPC). */
	readonly hostPackages: HostPackages;
	/** What crosses as `fatal` for an error (never the original message unless this returns it). */
	readonly redact: (error: unknown) => CrossedError;
	readonly onError: (error: unknown) => void;
};

/**
 * Runs this process as a worker: `fn` once the start message arrived and the lock is taken. An uncaught error or a
 * throwing `fn` sends `fatal` (redacted) and exits.
 */
// 用途：子进程入口。输入应用函数和选项，返回 void（进程继续运行直到关闭或致命错误）。
// 关键点：函数立即返回，Worker 在后台等待 start；调用方之后应让进程保持存活（通常应用函数会挂起）。
// process 在 fork 出来的子进程中就是带 IPC 的端口，因此可当作 IpcPort 使用。
export function workerMain(
	fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>,
	options: WorkerMainOptions,
): void {
	// `process` is the IPC port of a forked child.
	new Worker(process as unknown as IpcPort, options).run(fn);
}

/** How long a shutdown's closers get before the worker exits anyway: 3 s. */
// 清理函数可能卡住；超时后无条件退出，避免服务器只能一直等到 GRACE 后杀进程。
const FORCED_EXIT = 3_000;

// Worker 是子进程侧状态机。它拥有 context（shutdown 时中止）、closer 列表、待处理的 reload 队列以及 idle/ready 标志。
class Worker {
	readonly #port: IpcPort;
	readonly #options: WorkerMainOptions;
	// 只在 shutdown 时 abort；context 由它和 BACKGROUND_CONTEXT 组合而成。
	readonly #controller = new AbortController();
	readonly #context: Context;
	readonly #closers: ((context: Context) => Promise<void> | void)[] = [];
	// start 消息可能先于 #run 的 await 到达；withResolvers 让消息处理只负责 resolve。
	readonly #start = Promise.withResolvers<Extract<ToWorker, { readonly kind: "start" }>>();
	/** Reloads that arrived, applied one after another once `fn` returned. */
	// 重载必须串行：一次只应用一个脚本集，避免运行时并发重载同一 host。
	readonly #reloads: (readonly PluginScript[])[] = [];
	// 应用调用 plugins.load 后才有；没有它则拒绝重载。
	#loaded: { readonly host: Host<Principal>; readonly runtime: ReturnType<typeof createPluginRuntime> } | undefined;
	// ready 之前不报告 idle 翻转；ready 之后每次状态变化发 idle。
	#ready = false;
	// 重载期间强制不 idle，防止服务器在重载中停掉 worker。
	#reloading = false;
	#busy: Watchable<Readonly<Record<string, number>>> | undefined;
	/** The last idle state sent. */
	// undefined 表示尚未发送过 idle（ready 之前）；用于去重，状态未翻转就不发消息。
	#idle: boolean | undefined;
	// shutdown 幂等标志；也用于区分“关闭导致的取消”和真正的致命错误。
	#stopping = false;

	// 用途：接线 IPC 消息、断开和进程信号。构造时不等待 start，也不阻塞事件循环。
	// 每个终止来源都汇入 #shutdown 或 #fatal；uncaughtException/unhandledRejection 只处理一次。
	constructor(port: IpcPort, options: WorkerMainOptions) {
		this.#port = port;
		this.#options = options;
		this.#context = withAbortSignal(this.#controller.signal, BACKGROUND_CONTEXT);
		// 非控制消息（link 帧）由 ipcLink 自己消费；controlOf 返回 undefined 时忽略。
		port.on("message", (message) => this.#message(controlOf<ToWorker>(message)));
		// 父进程断开意味着服务器已退出或不再管理此 worker：按关闭处理，而不是继续成为孤儿。
		port.on("disconnect", () => void this.#shutdown());
		for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void this.#shutdown());
		// 未捕获异常和未处理拒绝都视为致命：脱敏后发给服务器并退出，避免进程带病运行。
		process.once("uncaughtException", (error) => this.#fatal(error));
		process.once("unhandledRejection", (error) => this.#fatal(error));
	}

	/** Takes the lock, makes the parent link, runs `fn`, then reports `ready` and applies reloads. */
	// 用途：启动异步流程；返回 void，错误在内部转为 fatal。
	// #run 的拒绝有两种可能：正常关闭期间 context 中止（closers 仍会执行），或其他致命错误。
	// 用 #stopping 区分：关闭中不重复 fatal。
	run(fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>): void {
		// A throw while shutting down is the shutdown's own cancellation (its `ctx` aborted): no fatal, the closers run.
		void this.#run(fn).catch((error: unknown) => {
			if (!this.#stopping) this.#fatal(error);
		});
	}

	// 用途：worker 的主启动流程。输入应用函数，完成后进程进入 ready 并处理后续消息。
	// 顺序很重要：先等 start（拿地址/脚本/锁名）-> 取锁（跨进程唯一）-> 建 ParentLink -> 加载插件 -> 运行应用 ->
	// 监听活动 -> 标记 ready -> 发 ready 报告 -> 开始处理已排队的 reload。
	async #run(fn: (start: WorkerStart, context: Context) => Promise<WorkerResult | undefined>): Promise<void> {
		const message = await this.#start.promise;
		// 同一地址只允许一个 worker；若持有者仍在，这里会等待，直到其退出。
		await processLock(message.lock, this.#context);
		// ParentLink 包装 ipcLink：应用调用 onMessage 开始监听时才发送 started，表明 host 已准备好接收帧。
		const parent = new ParentLink(ipcLink(this.#port), () => this.#send({ kind: "started" }));
		const runtime = createPluginRuntime();
		// 把 load 绑定到 message.scripts 和本进程的 hostPackages；同时记下 host/runtime 供 reload 使用。
		const plugins: WorkerPlugins = {
			load: async (host, { kind, core }, context) => {
				this.#loaded = { host: host as unknown as Host<Principal>, runtime };
				return runtime.load(
					host,
					{ kind, core, scripts: message.scripts, modules: this.#options.hostPackages },
					context,
				);
			},
		};
		let report: LoadReport = { failed: [] };
		// loading 是传给应用的 plugins：只多一件事，把 load 的结果保存到局部 report，供 ready 消息使用。
		const loading: WorkerPlugins = {
			load: async (host, options, context) => {
				report = await plugins.load(host, options, context);
				return report;
			},
		};
		const start: WorkerStart = {
			address: message.address,
			start: message.start,
			parent,
			plugins: loading,
			onClose: (closer) => void this.#closers.push(closer),
		};
		const result = await fn(start, this.#context);
		// 应用函数返回时可能已收到 shutdown；此时不再报告 ready 或处理重载。
		if (this.#stopping) return;
		this.#busy = result?.busy;
		// 监听 host.activity 与 busy，之后每次 idle 翻转都会发 idle 消息。
		await this.#follow();
		this.#ready = true;
		// 首次加载报告中失败的插件不算 added；其余脚本按名称列出。
		const failed = new Set(report.failed.map(({ plugin }) => plugin));
		const added = message.scripts.map(({ plugin }) => plugin.name).filter((name) => !failed.has(name));
		const loaded: ReloadReport = { plugins: { added, changed: [], removed: [] }, failed: report.failed, objects: [] };
		this.#idle = this.#isIdle();
		this.#send({ kind: "ready", idle: this.#idle, report: crossedReport(loaded) });
		// 不 await：ready 发出后立即处理已排队的 reload，同时继续响应新消息。
		void this.#applyReloads();
	}

	/** Follows the host's activity and the app's `busy`: each idle flip is reported. */
	// 用途：订阅两个可能变化的 idle 来源。输入无，输出 void；副作用是注册 watch。
	// host.activity 只有 plugins.load 调用过才存在；busy 只有应用返回值里有才存在。
	// 每个 source 的 watch 都有一个 start 回调；watch 自身的生命周期由 context 控制（shutdown 时中止）。
	async #follow(): Promise<void> {
		const sources: Watchable<unknown>[] = [];
		if (this.#loaded !== undefined) sources.push(this.#loaded.host.activity);
		if (this.#busy !== undefined) sources.push(this.#busy);
		for (const source of sources) {
			const watch = await source.watch(this.#context);
			watch.start(async () => this.#flip());
		}
	}

	/** Whether every count is zero: the host's references, jobs and lingering objects, the app's `busy`, no reload. */
	// 用途：计算当前是否 idle。输入无，输出布尔；无副作用。
	// 重载中永远不 idle；host 活动值的 references/jobs/lingering 任一非零即忙；busy 计数任一非零即忙。
	#isIdle(): boolean {
		if (this.#reloading) return false;
		const activity = this.#loaded?.host.activity.value;
		if (activity !== undefined && activity.references + activity.jobs + activity.lingering > 0) return false;
		return Object.values(this.#busy?.value ?? {}).every((count) => count === 0);
	}

	/** Reports the idle state when it flipped (after `ready`). */
	// 用途：状态变化时通知服务器。ready 之前不发；与上次发送相同则跳过，避免重复消息。
	#flip(): void {
		if (!this.#ready) return;
		const idle = this.#isIdle();
		if (idle === this.#idle) return;
		this.#idle = idle;
		this.#send({ kind: "idle", idle });
	}

	/** A control message from the server. */
	// 用途：分发 ToWorker。输入控制消息或 undefined（非控制消息），无返回值。
	// start 只 resolve 一次；shutdown 走统一关闭；reload 先排队，ready 后立即触发应用，
	// 关闭中的 reload 直接忽略（退出本身就是答复）。
	#message(message: ToWorker | undefined): void {
		if (message === undefined) return;
		switch (message.kind) {
			case "start":
				this.#start.resolve(message);
				return;
			case "shutdown":
				void this.#shutdown();
				return;
			case "reload":
				// A worker shutting down applies no reload (its exit answers it).
				if (this.#stopping) return;
				this.#reloads.push(message.scripts);
				if (this.#ready) void this.#applyReloads();
		}
	}

	/** Applies the reloads that arrived, one after another, each answered `reloaded`. */
	// 用途：串行消费 #reloads 队列。输入无，输出 Promise<void>；每条重载都会发 reloaded（成功带报告，失败带错误）。
	// 重入保护：已在重载则直接返回；队列为空也返回。重载期间 #reloading=true，#flip 会报告 busy。
	// 循环条件同时检查队列非空和未关闭；关闭后剩余的 reload 不再处理，由退出响应。
	async #applyReloads(): Promise<void> {
		if (this.#reloading || this.#reloads.length === 0) return;
		const loaded = this.#loaded;
		this.#reloading = true;
		this.#flip();
		for (
			let scripts = this.#reloads.shift();
			scripts !== undefined && !this.#stopping;
			scripts = this.#reloads.shift()
		) {
			// 应用从未调用 plugins.load，没有 host/runtime 可重载；明确报错而不是静默丢弃。
			if (loaded === undefined) {
				this.#send({ kind: "reloaded", error: { message: "worker: plugins.load was never called" } });
				continue;
			}
			try {
				const report = await loaded.runtime.reload(loaded.host, scripts, this.#context);
				this.#send({ kind: "reloaded", report: crossedReport(report) });
			} catch (error) {
				// 重载失败不结束 worker；错误压缩后作为本条重载的结果，服务器可继续使用旧插件状态。
				this.#send({ kind: "reloaded", error: crossed(error) });
			}
		}
		this.#reloading = false;
		this.#flip();
	}

	/** Aborts the context, runs the closers in reverse order and exits (forced after 3 s). */
	// 用途：统一关闭路径。幂等；abort 会让正在等待/运行的应用函数以取消结束。
	// 强制退出计时器 unref，不阻止事件循环；closers 使用未中止的 BACKGROUND_CONTEXT，让清理逻辑仍可执行。
	// 每个 closer 的错误交给 onError，不影响后续 closer；全部完成后 exit(0)。
	async #shutdown(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#controller.abort(new Error("worker: shutting down"));
		setTimeout(() => process.exit(0), FORCED_EXIT).unref();
		// 清理函数拿到的是新的、未中止的 context；否则它们自己的等待会被立刻取消。
		const context = BACKGROUND_CONTEXT;
		// reverse() 逆序执行：后注册的资源（依赖先注册的）先释放。
		for (const closer of this.#closers.reverse()) {
			try {
				await closer(context);
			} catch (error) {
				this.#options.onError(error);
			}
		}
		process.exit(0);
	}

	/** Sends `fatal` with the redacted error, then exits. */
	// 用途：把未捕获错误报告给服务器并退出。输入 unknown，返回 void。
	// 先 onError 保留完整错误给应用日志；redact 本身抛错时用固定消息兜底；只用 redact 的结果作为对外消息。
	// 若 IPC 已断开，无需发送，直接 exit(1)；否则等 send 回调确认消息已写出再退出。
	#fatal(error: unknown): void {
		this.#options.onError(error);
		let redacted: CrossedError;
		try {
			redacted = this.#options.redact(error);
		} catch {
			redacted = { message: "worker: fatal error" };
		}
		if (!this.#port.connected) process.exit(1);
		// `process.send` takes a callback once the message is out.
		// 回调形式给 IPC 另一个事件循环机会；同步 exit 可能在序列化完成前终止进程。
		(process.send as (message: unknown, callback: () => void) => void)(
			envelope({ kind: "fatal", error: redacted }),
			() => process.exit(1),
		);
	}

	/** Sends a control message; dropped when the server is gone. */
	// 只在 IPC 连接存在时发送；回调为空，因为发送失败最终由 disconnect/退出路径处理。
	#send(message: FromWorker): void {
		if (this.#port.connected) process.send?.(envelope(message), undefined, undefined, () => {});
	}
}

/** The link to the server as the app gets it: `started` goes out when the app's host sets its listener (`connect`). */
// 应用通常在 plugins.load 后调用 parent.onMessage(...) 开始接收帧；此时才通知服务器 started。
// 这样服务器不会在应用尚未准备好接收 link 帧时就把 hold 路由过来。
class ParentLink implements Link {
	readonly #inner: Link;
	// 只应触发一次；触发后置 undefined，重复 onMessage 不会重复发送 started。
	#started: (() => void) | undefined;

	constructor(inner: Link, started: () => void) {
		this.#inner = inner;
		this.#started = started;
	}

	send(message: Uint8Array): void {
		this.#inner.send(message);
	}

	// 注册监听的同时视为“应用已开始监听”，于是发出 started；先注册 inner，保证之后到达的帧不会漏掉。
	onMessage(listener: (message: Uint8Array) => void): void {
		this.#inner.onMessage(listener);
		const started = this.#started;
		this.#started = undefined;
		started?.();
	}

	close(): void {
		this.#inner.close();
	}

	onClose(listener: () => void): void {
		this.#inner.onClose(listener);
	}
}
