// The workers component (slice 10 §3, §4; decision "Slice 10's points"): a forked worker process per address of one
// host kind, started on demand by the route it owns, stopped when idle, never restarted by itself (R2): a crash, a
// `fatal`, a link lost while its child lives or a failed start leaves the address failed until `retry` or a rollout.
// Per address, a child's events are recorded on that child as they happen; starts and stops run one after another.

// 文件导读
// 所属模块：packages/chord/src/node/workers，服务器侧的 workers 组件。
// 解决的问题：每个 host 地址需要一个独立进程，但不能常驻全部进程：按 hold 按需启动、空闲后停止、崩溃后不自动重启
//   （避免崩溃循环），失败状态保留到显式 retry 或 rollout。多个地址共享服务器，事件必须记录到具体子进程上，
//   否则旧子进程的迟到事件会污染新子进程的状态。
// 职责边界：拥有一个 host kind 的路由、子进程生命周期、每地址操作队列、失败状态、idle 停止和 rollout；
//   不实现 IPC/进程封装（process.ts）、不运行应用代码（main.ts）、不实现跨进程锁（lock.ts）。
//   对外只暴露公开错误；完整错误和 stderr 末尾只通过 onError 给应用日志。
// 上游：应用在 host.load 前调用 createWorkers(host, Kind, options, context)；host 在每次 hold 时调用该路由的
//   resolve；插件组件通过 step() 发起 rollout。下游：WorkerProcess（fork/杀进程/收发控制消息）、control.ts
//   （错误与报告跨进程转换）、host 的 RouteHandle（suspend/retry）、plugins（current/scripts）。
//   结果流向：resolve 成功返回 { link, principal, trusted: true }；失败以公开 ChordError 拒绝；状态经 state
//   watchable 发布；生命周期事件经 WorkersError 回调；停止/关闭等待进程真正退出。
// 能力清单：
// - WorkersOptions：kind、entry、execArgv、env 及按地址调用的 authorize/principal/start/lock/idleMs/plugins/onOutput/onError。
// - WorkerState：starting/running/stopping 带 pid 与启动时间，failed 带公开错误和时间。
// - WorkersError：worker_failed、authorize_failed、worker_exited 以及状态监听器抛错（BatchError）。
// - Workers、createWorkers()：state、stop、retry、step、close 与路由创建。
// - 内部类型 Failure/Cause/Ended/Child/Routed：失败、子进程结局、事件原因、单个子进程记录和地址记录。
// - WorkersComponent：完整状态机；WorkersState：把地址映射发布成 JSON watchable。
// - closed/exitError/publicExit/keyOf/bounded/stateOf：公开错误、脚本集身份、等待边界和状态快照辅助。
// 组合关系：createWorkers -> host.route -> resolve -> #routed -> #enqueue -> #start -> #fork(WorkerProcess) ->
//   control/链路/退出事件 -> #control/#linkLost/#linkClosed/#exited -> 状态与失败；idle 定时器与 rollout 也通过
//   同一地址队列串行执行 stop/reload，避免和 start 交叉。
// 示例（示例，不是本文件的运行代码）：
//   declare const host: Host<Principal>;
//   declare const Kind: HostKind<"notes", {}>;
//   declare const options: WorkersOptions<Principal, HostKind<"notes", {}>>;
//   declare const address: Address<HostKind<"notes", {}>>;
//   const workers = createWorkers(host, Kind, options, context);
//   const states = workers.state.value;              // Readonly<Record<string, WorkerState>>
//   await workers.stop(address, context);            // 挂起并停止该地址
// 建议阅读顺序：先看 WorkersOptions/WorkerState/WorkersError/Workers 与 createWorkers，再看 Child/Routed 记录的语义，
//   随后按 #start/#fork/#control/#exited 读生命周期，最后看 idle、rollout、reload 与 WorkersState 的发布逻辑。

import type { Context } from "../../context/index.ts";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "../../context/index.ts";
import type { Address, HostKind, KindShape } from "../../contracts/index.ts";
import type { Params } from "../../contracts/internal.ts";
import { ChordError, type Principal } from "../../data/index.ts";
import type { Host, RouteHandle } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { Batch, type BatchError, Source } from "../../state/internal.ts";
import type { Watchable } from "../../watch.ts";
import type { Plugins, RolloutHost, RolloutStep } from "../plugins/plugins.ts";
import type { PluginScript } from "../plugins/runtime.ts";
import { type CrossedError, type CrossedReport, type FromWorker, uncrossed, uncrossedReport } from "./control.ts";
import { type Exit, WorkerProcess } from "./process.ts";

/** What `createWorkers` takes. `kind`, `entry`, `execArgv` and `env` are bootstrap; the functions are called per use. */
// 启动参数只在构造时读取；其余函数按地址/每次使用调用，允许应用根据地址动态决定授权、主体、启动数据和锁名。
export type WorkersOptions<P extends Principal, K extends KindShape> = {
	/** The facet kind its workers load (`"worker"`), shipped by the plugins component. */
	readonly kind: string;
	/** The worker's entry module (it calls `workerMain`), its Node flags and its environment. */
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** The route's `authorize`: whether `principal` may reach `address` (synchronous). */
	readonly authorize: (principal: P, address: Address<K>) => boolean;
	/** Who the worker at `address` is (stamped on its link). */
	readonly principal: (address: Address<K>) => P;
	/** The worker's start data (JSON), before each start; abortable (`close`), a throw fails the start. */
	readonly start: (address: Address<K>, context: Context) => Promise<JsonValue> | JsonValue;
	/** The lock one live worker of `address` holds (across processes). */
	readonly lock: (address: Address<K>) => string;
	/** How long a worker idles before it is stopped: 5 minutes by default. */
	readonly idleMs?: () => number;
	readonly plugins: Plugins;
	/** A worker's output; without it, mirrored to this process's own. */
	readonly onOutput?: (address: Address<K>, stream: "stdout" | "stderr", chunk: Uint8Array) => void;
	readonly onError: (error: WorkersError) => void;
};

/**
 * One address's worker (R5): running or on its way, or failed (until `retry` or a rollout) with a public error: a fixed
 * message (`worker failed to start`, `worker exited (SIGSEGV)`) or the child's redacted `fatal`.
 */
// starting：已 fork，尚未收到 ready；running：应用函数已返回、报告已发出；stopping：已请求关闭。
// failed 不是进程状态，而是地址状态：错误公开且固定，重试前该地址不会再次 fork。
export type WorkerState =
	| { readonly status: "starting" | "running" | "stopping"; readonly pid: number; readonly startedAt: number }
	| { readonly status: "failed"; readonly error: CrossedError; readonly at: number };

/** What the component reports (and the state's watch listeners that threw). */
// worker_failed 带完整错误和 stderr 末尾，只给应用日志；authorize_failed 说明授权钩子抛错且请求已被拒绝为 forbidden；
// worker_exited 只报告非本组件主动杀死的退出；BatchError 来自 state watch 监听器抛错。
export type WorkersError =
	| {
			readonly kind: "worker_failed";
			readonly address: string;
			/** The full error (a start's throw, a crash, the child's `fatal`): for the app's logs, never public. */
			readonly error: unknown;
			readonly stderrTail?: string;
	  }
	| {
			/** The app's `authorize` threw: the hold is refused (`forbidden`), the error stays private. */
			readonly kind: "authorize_failed";
			readonly address: string;
			readonly error: unknown;
	  }
	| {
			readonly kind: "worker_exited";
			readonly address: string;
			readonly code: number | null;
			readonly signal: string | null;
	  }
	| BatchError;

/** The workers component. */
// state 是按地址 key 的 JSON watchable；stop/retry/close 操作地址；step 返回 rollout 的一个步骤。
export interface Workers<K extends KindShape> {
	/** Per address key its `WorkerState`; no entry when stopped or never started. A JSON watchable. */
	readonly state: Watchable<Readonly<Record<string, WorkerState>>>;
	/** Suspends `address` while it has holders (`RouteHandle.suspend`), then stops its worker. */
	stop(address: Address<K>, context: Context): Promise<void>;
	/** Clears `address`'s failure and suspension: it starts again now if held (`RouteHandle.retry`). */
	retry(address: Address<K>, context: Context): Promise<void>;
	/** A rollout step shipping the kind's current set to every worker, one result per worker (§4). */
	step(name: string): RolloutStep;
	/** Cancels starts, stops every worker; new starts reject `released/closed`. */
	close(context: Context): Promise<void>;
}

/** Creates the workers component on `host`: it routes `Kind` itself (`host.route`, before `load`). */
// 用途：创建路由并绑定组件。输入 host、kind 描述、选项和 context，输出 Workers。构造后即开始监听 context 结束。
// 泛型 P 是 principal，N 是 kind 名，Q 是 params；返回值按 HostKind<N,Q> 精确标注，内部实现用更宽的 HostKind 工作。
// 关键点：必须早于 host.load 调用，否则该 kind 的路由已经确定，无法再挂 worker。
export function createWorkers<P extends Principal, N extends string, Q extends Params>(
	host: Host<P>,
	Kind: HostKind<N, Q>,
	options: WorkersOptions<P, HostKind<N, Q>>,
	context: Context,
): Workers<HostKind<N, Q>> {
	// Its addresses are `Address<HostKind<N, Q>>`, as the route hands them over.
	// 内部组件只依赖 HostKind 的通用能力；两处断言把具体的 N/Q 擦除，避免实现类为每个 kind 复制一份。
	const component = new WorkersComponent(options as unknown as WorkersOptions<Principal, HostKind>, context);
	const route = host.route(
		Kind,
		{
			authorize: (principal, address) => {
				// A throw would reach the holder as the hold's failure: the app's error stays private.
				// 应用钩子抛错时返回 false 并上报 authorize_failed；对调用方表现为 forbidden，而不是内部异常。
				try {
					return options.authorize(principal, address);
				} catch (error) {
					options.onError({ kind: "authorize_failed", address: address.key, error });
					return false;
				}
			},
			// The address is the route's, of `Kind` (the component works on any kind's); the principal is
			// `options.principal`'s, a `P`.
			// resolve 返回的 principal 由 options.principal 提供；trusted: true 表示这是服务器进程自己解析出的身份。
			resolve: (address, routing) =>
				component.resolve(address as unknown as Address<HostKind>, routing) as Promise<{
					link: Link;
					principal: P;
					trusted: true;
				}>,
		},
		context,
	);
	// 路由创建后回填给组件：stop/retry 需要调用 route.suspend/retry。
	component.route = route as unknown as RouteHandle<HostKind>;
	return component as unknown as Workers<HostKind<N, Q>>;
}

/**
 * A failure an address keeps until `retry` or a rollout: what the public sees (a fixed message, or the child's redacted
 * `fatal`; decision "Slice 10 fix round, worker errors in public") and when.
 */
// public 是唯一会进入 WorkerState.failed 和启动拒绝原因的错误；at 用于状态展示，不参与重试判断。
type Failure = { readonly error: CrossedError; readonly at: number };

/**
 * Why a child fails when it exits, recorded as it happens: a start that failed, a `fatal`, a lost link. `error` is the
 * full error (`onError` only); `public` what holders and `state` get (a fixed one from the exit when absent).
 */
// cause 在事件发生时写入 child.cause；退出回调据此决定“正常停止”还是崩溃。killed 标记组件主动杀死的启动失败，
// 这样退出时不会额外报告 worker_exited。
type Cause = {
	readonly error: unknown;
	readonly public?: CrossedError;
	/** The component ended the child itself (a failed start): its exit is no `worker_exited`. */
	readonly killed?: true;
};

/** How a child's reloads end once it is gone: stopped cleanly (a stop's exit) or with an error. */
// 用于结束排队中的 reload：正常 stop 返回 { host, stopped: true }；异常返回 error。
type Ended = { readonly kind: "stopped" } | { readonly kind: "failed"; readonly error: unknown };

/** One worker process of an address, with what its events recorded. */
// 每个 Child 都绑定自己的 WorkerProcess；所有迟到事件通过 child 参数归属，不会写到新子进程上。
type Child = {
	readonly process: WorkerProcess;
	status: "starting" | "running" | "stopping";
	/** A stop was asked for: its exit is no crash. */
	stopping: boolean;
	cause: Cause | undefined;
	/** `started`: the app's host listens on its link. */
	readonly started: PromiseWithResolvers<void>;
	/** `ready`: its load report; rejected when it exits before. */
	readonly ready: PromiseWithResolvers<CrossedReport>;
	/** Since when it is idle (from `ready`); `undefined` while busy or before `ready`. */
	idleSince: number | undefined;
	/** An idle stop is queued (checked again when it runs). */
	idleStop: boolean;
	/** The set its start message or its last reload that applied without failures carried. */
	shipped: string;
	/** Its reloads, one outstanding at a time; settles to nothing (a report kept as its value would stay alive). */
	reloading: Promise<void>;
	/** The waiter of its outstanding reload. */
	reloaded: ((reply: Extract<FromWorker, { readonly kind: "reloaded" }>) => void) | undefined;
	/** Set once its link is gone or it exited: every reload queued behind settles with it. */
	ended: Ended | undefined;
	/** The grace timer of a stop or of a lost link. */
	grace: ReturnType<typeof setTimeout> | undefined;
};

/** One address: its operations in a queue, its child, its failure. Kept while it has any of them. */
// 地址记录只在“有排队操作/存活子进程/失败状态”时保留；三者都清空后从 Map 删除，避免无限增长。
// starting 指向尚未 settle 的启动 Promise，rollout 重试已失败地址时需要等它完成。
type Routed = {
	readonly address: Address<HostKind>;
	queue: Promise<void>;
	pending: number;
	child: Child | undefined;
	failure: Failure | undefined;
	/** A start was queued and has not settled. */
	starting: Promise<unknown> | undefined;
};

/** Starts a worker may take until `started` (fork, lock, connect): 60 s. */
// 覆盖 fork、子进程取锁和建立 link 的时间；超时视为启动失败，避免永久占住地址队列。
const START_TIMEOUT = 60_000;

/** How long a stopping worker (or one whose link is gone) gets before its tree is killed: 5 s. */
// 先发 shutdown 给优雅关闭机会；超过宽限期则杀整个进程组。
const GRACE = 5_000;

/** How often idle workers are looked for: every second. */
// 扫描间隔；只在存在 worker 时运行，且 unref，不阻止服务器退出。
const IDLE_CHECK = 1_000;

/** How long a worker idles before it is stopped unless `idleMs` says otherwise: 5 minutes. */
const IDLE_MS = 5 * 60_000;

/** The public error of a start that failed. */
// 启动失败对外的固定错误：不暴露应用/子进程的内部信息，同时给出可用错误码。
const START_FAILED: CrossedError = { message: "worker failed to start", code: "unavailable" };

/** The link type a route's `resolve` returns. */
// 直接复用 WorkerProcess 的 link 类型，避免与 ipcLink/TellingLink 的具体实现脱节。
type Link = WorkerProcess["link"];

// WorkersComponent 实现全部状态机；它只操作通用 HostKind，具体 kind 的泛型由 createWorkers 断言收窄。
class WorkersComponent implements Workers<HostKind> {
	/** Set by `createWorkers` once the route exists. */
	// 使用 definite assignment：构造时路由尚不存在，createWorkers 在 host.route 后立即赋值。
	route!: RouteHandle<HostKind>;
	readonly state: Watchable<Readonly<Record<string, WorkerState>>>;
	readonly #state: WorkersState;
	readonly #options: WorkersOptions<Principal, HostKind>;
	readonly #addresses = new Map<string, Routed>();
	/** Aborted at `close`: starts waiting in the app's `start` or for `started` end. */
	// 关闭信号是所有启动等待的上界；它不直接杀进程，具体停止走每地址队列。
	readonly #closing = new AbortController();
	/** `#closing`'s signal as a context: what a start's waits are bounded by. */
	readonly #closingContext = withAbortSignal(this.#closing.signal, BACKGROUND_CONTEXT);
	/** Whether the route's context closes it already (its first `resolve` attached that). */
	// 第一次 resolve 时把路由 context 的中止接到 close；避免构造时拿不到路由 context。
	#routing = false;
	#idleTimer: ReturnType<typeof setInterval> | undefined;

	// 用途：保存选项、创建状态源，并把外部 context 的关闭接到组件。构造时还没有路由与子进程。
	constructor(options: WorkersOptions<Principal, HostKind>, context: Context) {
		this.#options = options;
		// Batch 把 state 变化合并发布；监听器抛错交给 onError（WorkersError 的 BatchError 分支）。
		this.#state = new WorkersState(this.#addresses, new Batch((error) => options.onError(error), undefined));
		// Its value is a `Record<string, WorkerState>`.
		this.state = this.#state as unknown as Watchable<Readonly<Record<string, WorkerState>>>;
		this.#closeWith(context);
	}

	/**
	 * The route's `resolve`: a failed address rejects at once with its (public) failure, nothing forks; otherwise a
	 * start, after the previous child's exit.
	 */
	// 用途：host hold 时解析地址。输入地址和路由 context，输出 link/principal/trusted。
	// 失败地址立即拒绝，不再 fork；关闭中拒绝 released/closed；否则把启动排进该地址队列，保证与停止/重载串行。
	// starting 记录在 Routed 上，rollout 重试时可等待这次启动完成。
	resolve(address: Address<HostKind>, routing: Context): Promise<{ link: Link; principal: Principal; trusted: true }> {
		if (!this.#routing) {
			this.#routing = true;
			// 路由的 context 通常随 host 关闭而中止；此后组件不再接受新启动。
			this.#closeWith(routing);
		}
		const routed = this.#routed(address);
		if (routed.failure !== undefined) return Promise.reject(uncrossed(routed.failure.error));
		if (this.#closing.signal.aborted) return Promise.reject(closed());
		const started = this.#enqueue(routed, () => this.#start(routed, routing));
		routed.starting = started;
		// 无论成功失败都清除 starting；用 then 的两个分支而不是 finally，避免产生未处理的派生 Promise。
		void started.then(
			() => this.#settled(routed, started),
			() => this.#settled(routed, started),
		);
		return started;
	}

	// 用途：停止地址。先 suspend 路由（之后的 hold 会等待/被拒），再排队停止子进程并等待其退出。
	// 不传 context 给 stop 的清理：外部等待可以中止，但进程停止操作本身会继续，避免留下半停状态。
	async stop(address: Address<HostKind>, context: Context): Promise<void> {
		this.route.suspend(address);
		const routed = this.#addresses.get(address.key);
		if (routed === undefined) return;
		await awaitWithContext(
			this.#enqueue(routed, () => this.#stop(routed)),
			context,
		);
	}

	// 用途：清除失败并恢复路由。输入地址和 context，返回 Promise<void>；不会直接启动，下一次 hold 才启动。
	// 若地址已有记录，刷新状态并尝试删除空记录；route.retry 让之前被 suspend 的 hold 重新解析。
	async retry(address: Address<HostKind>, _context: Context): Promise<void> {
		const routed = this.#addresses.get(address.key);
		if (routed !== undefined) {
			routed.failure = undefined;
			this.#state.refresh();
			this.#forget(routed);
		}
		this.route.retry(address);
	}

	// 用途：生成 rollout 步骤。name 仅用于标识；kinds 指定本组件负责的 facet kind；reload 在发布脚本集时调用。
	step(name: string): RolloutStep {
		return { name, kinds: [this.#options.kind], reload: (_built, context) => this.#rollout(context) };
	}

	// 用途：关闭组件。输入 context，返回所有 worker 停止后的 Promise。
	// 先中止 #closing（新启动和等待中的启动以 released/closed 结束），停掉 idle 定时器，再对每个地址排队 stop。
	// 每个地址的 stop 都会排队；任一 stop 失败会经 Promise.all 与 awaitWithContext 传播给关闭方。
	async close(context: Context): Promise<void> {
		if (!this.#closing.signal.aborted) this.#closing.abort(closed());
		clearInterval(this.#idleTimer);
		this.#idleTimer = undefined;
		const stops = [...this.#addresses.values()].map((routed) => this.#enqueue(routed, () => this.#stop(routed)));
		await awaitWithContext(Promise.all(stops), context);
	}

	/** `context`'s abort closes the component (the route's is aborted when the host closes). */
	// 只注册一次（once）；没有 signal 或已中止则不注册。close 的错误被吞掉，因为 context 中止路径没有调用方处理。
	#closeWith(context: Context): void {
		const signal = context.abortSignal;
		if (signal === undefined || signal.aborted) return;
		signal.addEventListener("abort", () => void this.close(BACKGROUND_CONTEXT).catch(() => {}), { once: true });
	}

	/** The record of `address`, made by its first use. */
	// 地址 key 是运行时身份；首次使用创建空记录，后续操作复用同一队列，保证串行。
	#routed(address: Address<HostKind>): Routed {
		let routed = this.#addresses.get(address.key);
		if (routed === undefined) {
			routed = {
				address,
				// 已完成队列：操作完成后都归一到 resolve，错误由每个 run 自己传播。
				queue: Promise.resolve(),
				pending: 0,
				child: undefined,
				failure: undefined,
				starting: undefined,
			};
			this.#addresses.set(address.key, routed);
		}
		return routed;
	}

	/** Runs `operation` after the address's earlier ones. */
	// 用途：把操作排到地址队列尾部。输入地址记录和操作，输出该操作的结果 Promise。
	// pending 计数包括排队和执行中的操作；queue 永不 reject（错误分支调用 #done 后 resolve），否则后续操作会被卡住。
	#enqueue<T>(routed: Routed, operation: () => Promise<T>): Promise<T> {
		routed.pending++;
		const run = routed.queue.then(operation);
		routed.queue = run.then(
			() => this.#done(routed),
			() => this.#done(routed),
		);
		return run;
	}

	/** An operation ended. */
	// 减少 pending 并尝试回收地址记录；不改变操作的返回值/错误。
	#done(routed: Routed): void {
		routed.pending--;
		this.#forget(routed);
	}

	/** A start settled: no longer starting. */
	// 只有仍指向本次启动时才清空，避免迟到的回调覆盖更新的 starting。
	#settled(routed: Routed, started: Promise<unknown>): void {
		if (routed.starting === started) routed.starting = undefined;
	}

	/** Forgets an address with no operation, no child and no failure. */
	// 三个条件都为空才删除，防止丢掉仍需要重试/停止的状态；空的 starting 不影响。
	#forget(routed: Routed): void {
		if (routed.pending === 0 && routed.child === undefined && routed.failure === undefined) {
			this.#addresses.delete(routed.address.key);
		}
	}

	/**
	 * A start: the app's start data, the fork, the start message with the kind's current set, then `started` within the
	 * start timer (fork, lock and connect only). Its failure fails the address; `close` ends it at any of its waits (an
	 * app's `start` that ignores its signal too), a forked child is stopped.
	 */
	// 用途：执行一次完整启动。输入地址记录和路由 context，输出新子进程的 link/principal/trusted。
	// 所有失败都会转成地址的公开失败（START_FAILED 或 redacted fatal）并抛公开错误；关闭导致的取消抛 released/closed。
	// 关键顺序：先等旧子进程退出（避免同一地址两个进程）-> 再取 start 数据 -> fork -> 发 start -> 等 started。
	async #start(routed: Routed, routing: Context): Promise<{ link: Link; principal: Principal; trusted: true }> {
		const { address } = routed;
		// After the previous child's exit (its link may close first): a crash recorded meanwhile rejects this start.
		// 旧进程的 link 可能先关闭而进程尚存；必须等 exited，确保锁和地址资源真正释放。
		await routed.child?.process.exited;
		const crashed = routed.failure;
		// 旧进程在等待期间崩溃时，failure 已被记录；本次启动直接以该公开错误拒绝。
		if (crashed !== undefined) throw uncrossed(crashed.error);
		if (this.#closing.signal.aborted) throw closed();
		// 应用 start 和后续等待都同时受组件关闭与本次路由 context 约束。
		const context = withAbortSignal(this.#closing.signal, routing);
		let data: JsonValue;
		try {
			// Promise.resolve 容纳同步返回值；awaitWithContext 让关闭能立即结束一个不响应 signal 的应用 start。
			data = await awaitWithContext(Promise.resolve(this.#options.start(address, context)), this.#closingContext);
		} catch (error) {
			// 关闭优先于应用错误：调用方应看到 released/closed，而不是内部的 start 抛错。
			if (this.#closing.signal.aborted) throw closed();
			throw this.#fail(routed, { error, public: START_FAILED }, undefined);
		}
		if (this.#closing.signal.aborted) throw closed();
		let child: Child;
		try {
			child = this.#fork(routed);
		} catch (error) {
			// fork 同步失败（entry 不存在等）：地址失败，没有子进程需要清理。
			throw this.#fail(routed, { error, public: START_FAILED }, undefined);
		}
		// 启动计时覆盖 fork、取锁和建立 link；超时主动杀掉子进程，并记录为组件主动结束（不额外报 worker_exited）。
		const timer = setTimeout(() => {
			const error = new Error(`worker ${address.key}: did not start within ${START_TIMEOUT / 1000} s`);
			child.cause ??= { error, killed: true };
			child.process.kill();
		}, START_TIMEOUT);
		// Every app hook of the start runs in here: what one throws stays private (`worker_failed`), its holders and
		// `state` get the fixed public message (Astra's recheck R3: `principal` threw through to a guest).
		// 发送 start 前取当前脚本集；shipped 记录实际发给子进程的集合，供 rollout 判断是否需要重载。
		try {
			const scripts = await this.#options.plugins.scripts(this.#options.kind, context);
			child.shipped = keyOf(scripts);
			const lock = this.#options.lock(address);
			// start 消息包含地址、JSON start 数据、脚本和跨进程锁名；子进程取锁后才建立 link。
			child.process.send({ kind: "start", address, start: data, scripts, lock });
			// 等子进程报告 started（应用 host 已在 link 上监听）；关闭时提前结束。
			await awaitWithContext(child.started.promise, this.#closingContext);
			return { link: child.process.link, principal: this.#options.principal(address), trusted: true };
		} catch (error) {
			// Closing is a stop (no failure); anything else fails the start.
			// 关闭时标记 stopping，让退出被视为正常停止；否则记录公开失败并主动杀掉子进程。
			if (this.#closing.signal.aborted) child.stopping = true;
			else child.cause ??= { error, public: START_FAILED, killed: true };
			child.process.kill();
			await child.process.exited;
			// 等进程退出后再次以关闭优先；否则抛已记录的公开失败（可能已被退出回调填充）。
			if (this.#closing.signal.aborted) throw closed();
			throw uncrossed(routed.failure?.error ?? START_FAILED);
		} finally {
			// 不论成功失败都清掉启动计时器，避免泄漏或误杀已启动的进程。
			clearTimeout(timer);
		}
	}

	/** Forks the address's worker and records its events on it as they happen. */
	// 用途：创建 WorkerProcess 并构造 Child 记录。输入地址记录，输出 Child；调用前 routed.child 必须为空。
	// 关键点：事件回调捕获的是本函数的 child 变量，因此旧子进程的迟到事件只会写到旧记录，不会影响新子进程。
	#fork(routed: Routed): Child {
		const { address } = routed;
		const onOutput = this.#options.onOutput;
		// 事件可能在构造器返回前排队，但不会同步触发；用 definite assignment 让闭包引用稍后赋值的 child。
		let child!: Child;
		const process = new WorkerProcess(
			{
				entry: this.#options.entry,
				// 只在提供时展开可选字段，保持传给 fork 的选项形状干净（undefined 与缺省语义可能不同）。
				...(this.#options.execArgv === undefined ? {} : { execArgv: this.#options.execArgv }),
				...(this.#options.env === undefined ? {} : { env: this.#options.env }),
				...(onOutput === undefined ? {} : { onOutput: (stream, chunk) => onOutput(address, stream, chunk) }),
			},
			{
				// 所有事件都带上 child，处理器据此判断是否仍是当前子进程。
				control: (message) => this.#control(routed, child, message),
				linkLost: () => this.#linkLost(child),
				linkClosed: () => this.#linkClosed(child),
				exited: (exit) => this.#exited(routed, child, exit),
			},
		);
		child = {
			process,
			status: "starting",
			stopping: false,
			cause: undefined,
			started: Promise.withResolvers(),
			ready: Promise.withResolvers(),
			idleSince: undefined,
			idleStop: false,
			shipped: "",
			// 初始化为已完成 Promise，让第一次 reload 直接排队执行。
			reloading: Promise.resolve(),
			reloaded: undefined,
			ended: undefined,
			grace: undefined,
		};
		// Nobody may wait for them.
		// 这两个 Promise 的拒绝由启动/退出路径处理；此处挂空 catch，避免无人 await 时触发 unhandledRejection。
		child.started.promise.catch(() => {});
		child.ready.promise.catch(() => {});
		routed.child = child;
		// 新子进程进入 starting 状态，通知 state 观察者。
		this.#state.refresh();
		// 有 worker 存在时启动 idle 扫描（若尚未启动）。
		this.#watchIdle();
		return child;
	}

	/** A control message of `child`. */
	// 用途：处理子进程控制消息。输入地址记录、子进程记录和 FromWorker，返回 void。
	// ready 只对当前子进程刷新 state；旧子进程的迟到消息仍更新旧记录，但不会覆盖新子进程的展示状态。
	#control(routed: Routed, child: Child, message: FromWorker): void {
		switch (message.kind) {
			case "started":
				// 应用 host 已开始监听 link；启动流程的 await 在此恢复。
				child.started.resolve();
				return;
			case "ready":
				child.status = "running";
				// idle 为 true 时从此刻开始计空闲；false 则保持 undefined（忙）。
				child.idleSince = message.idle ? Date.now() : undefined;
				child.ready.resolve(message.report);
				if (routed.child === child) this.#state.refresh();
				return;
			case "idle":
				// 已经是 idle 时保留最早的 idleSince，避免每次重复报告都重置空闲时长。
				child.idleSince = message.idle ? (child.idleSince ?? Date.now()) : undefined;
				return;
			case "fatal":
				// Redacted by the child's `redact`: public as it is.
				// fatal 可能早于 started 到达；同时拒绝 started，让启动流程立即失败而不是等到超时。
				child.cause ??= { error: uncrossed(message.error), public: message.error };
				child.started.reject(uncrossed(message.error));
				child.process.kill();
				return;
			case "reloaded":
				// 有等待中的 reload 时交付；没有则忽略（可能来自已超时/取消的 rollout）。
				child.reloaded?.(message);
		}
	}

	/** This side closed `child`'s link (the heartbeat, a protocol error): its child is stopped, its exit a crash. */
	// 本侧关 link 不代表子进程已退出；先结束排队 reload，再请求 shutdown，退出时按崩溃记录（除非已在停止）。
	#linkLost(child: Child): void {
		this.#ended(child);
		if (child.stopping) return;
		child.cause ??= { error: new Error("worker: link lost") };
		this.#shutdown(child);
		this.#state.refresh();
	}

	/**
	 * The child's side closed its link (it is exiting, or it closed its IPC and lives on): its reloads end; one that does
	 * not exit within the grace is killed, its exit a crash (link lost).
	 */
	// 子进程关闭 link 可能只是关闭 IPC 而进程仍存活；给它 GRACE 时间自行退出，否则按 link lost 杀死。
	// 已有 grace 定时器时不重复设置，避免延长或覆盖更早的截止时间。
	#linkClosed(child: Child): void {
		this.#ended(child);
		if (child.stopping || child.grace !== undefined) return;
		child.grace = setTimeout(() => {
			child.cause ??= { error: new Error("worker: link lost") };
			child.process.kill();
		}, GRACE);
	}

	/**
	 * `child` exited: a stop's exit forgets it; any other is a crash that fails the address (`worker_exited` and
	 * `worker_failed` once, the full error and stderr tail for the app's logs only), except once the component closes.
	 */
	// 用途：子进程退出的唯一收尾点。输入地址记录、子进程记录和 Exit，返回 void。
	// clean 仅当是主动停止且未记录 cause；其他退出都按崩溃处理。失败时会拒绝 started/ready 并写入地址 failure。
	// 若 routed.child 已不是该子进程（理论上不应发生，旧记录已清理），只做 Promise/重载收尾，不改当前状态。
	#exited(routed: Routed, child: Child, exit: Exit): void {
		clearTimeout(child.grace);
		const clean = child.stopping && child.cause === undefined;
		// cause 优先（启动失败、fatal、link lost 的完整错误）；没有则根据退出码/信号生成内部错误。
		const cause: Cause = child.cause ?? { error: exitError(routed.address, exit, child) };
		// 对外错误也优先使用公共版本（redacted fatal），否则使用固定的退出描述。
		const error = cause.public ?? publicExit(exit, child);
		child.started.reject(uncrossed(error));
		child.ready.reject(uncrossed(error));
		this.#ended(child);
		if (routed.child !== child) return;
		routed.child = undefined;
		if (!clean && !this.#closing.signal.aborted) {
			const { code, signal } = exit;
			// A failed start's kill is the component's own act (Opus's second recheck): only `worker_failed`.
			// 主动杀死启动失败的子进程时不再报告 worker_exited，避免一次失败产生两条事件。
			if (cause.killed !== true) {
				this.#options.onError({ kind: "worker_exited", address: routed.address.key, code, signal });
			}
			// 地址失败，stderrTail 仅进入 onError 的日志信息。
			this.#fail(routed, { ...cause, public: error }, child.process.stderrTail);
		}
		this.#state.refresh();
		this.#forget(routed);
	}

	/**
	 * `child`'s link is gone or it exited (the first of these): its outstanding reload and every one queued behind it
	 * settle, `stopped` when a stop asked for it, else failed.
	 */
	// 幂等：linkLost、linkClosed、exited 可能依次发生，只有第一次决定结局。
	// 等待中的 reload 用固定错误结束；若之后子进程退出，再按正常 stop/崩溃流程处理。
	#ended(child: Child): void {
		if (child.ended !== undefined) return;
		child.ended =
			child.stopping && child.cause === undefined
				? { kind: "stopped" }
				: { kind: "failed", error: new ChordError({ code: "unavailable", message: "worker: its link is gone" }) };
		child.reloaded?.({ kind: "reloaded", error: { message: "worker: its link is gone" } });
	}

	/**
	 * Fails `routed` with `cause` (`worker_failed` once, with the full error and `stderrTail`); returns the public error
	 * a start rejects with.
	 */
	// 用途：记录地址失败并上报。输入地址记录、带公开错误的 cause、stderr 末尾，输出公开 Error 供启动流程抛出。
	// failure 保留在 Routed 上，直到 retry/rollout；只有公开错误进入 state，完整错误只进 onError。
	#fail(routed: Routed, cause: Cause & { readonly public: CrossedError }, stderrTail: string | undefined): Error {
		routed.failure = { error: cause.public, at: Date.now() };
		this.#options.onError({
			kind: "worker_failed",
			address: routed.address.key,
			error: cause.error,
			...(stderrTail === undefined ? {} : { stderrTail }),
		});
		this.#state.refresh();
		return uncrossed(cause.public);
	}

	/** A stop: `shutdown`, the grace, then the tree killed; resolves at its exit. */
	// 用途：在地址队列中执行停止。输入地址记录，返回进程退出后完成的 Promise。
	// 没有子进程时直接返回；有则标记 stopping（使退出被视为正常停止），发 shutdown，并等待 exited。
	async #stop(routed: Routed): Promise<void> {
		const child = routed.child;
		if (child === undefined) return;
		child.stopping = true;
		this.#shutdown(child);
		this.#state.refresh();
		await child.process.exited;
	}

	/** Asks `child` to shut down and kills its tree after the grace. */
	// 发送 shutdown 后设置宽限定时器；若已有定时器（例如 linkClosed 的），清除并替换为统一的关闭截止时间。
	// 宽限期到达时杀整个进程组；正常退出会在 #exited 中清除该定时器。
	#shutdown(child: Child): void {
		child.status = "stopping";
		child.process.send({ kind: "shutdown" });
		clearTimeout(child.grace);
		child.grace = setTimeout(() => child.process.kill(), GRACE);
	}

	/** Starts the idle check (every second) while any worker exists. */
	// 只有一个定时器；unref 让它不阻止服务器进程退出。
	#watchIdle(): void {
		if (this.#idleTimer !== undefined) return;
		this.#idleTimer = setInterval(() => this.#checkIdle(), IDLE_CHECK);
		this.#idleTimer.unref();
	}

	/** Queues a stop for every worker idle since `idleMs()`; stops checking once no worker is left. */
	// 用途：定期扫描。输入无，返回 void；对每个足够久未活动的 running worker 排队一次 idle stop。
	// idleStop 标志防止同一空闲期重复排队；实际停止前 #idleStop 会再次检查，防止扫描后又有新 hold。
	// workers 计数只统计仍有子进程的地址；没有子进程时停止定时器，避免空转。
	#checkIdle(): void {
		const idleMs = this.#idleMs();
		const now = Date.now();
		let workers = 0;
		for (const routed of this.#addresses.values()) {
			const child = routed.child;
			if (child === undefined) continue;
			workers++;
			// 已排队停止或未进入 running（starting/stopping）的 worker 不处理。
			if (child.idleStop || child.status !== "running") continue;
			// idleSince 为 undefined 表示忙；未达到阈值也跳过。
			if (child.idleSince === undefined || now - child.idleSince < idleMs) continue;
			child.idleStop = true;
			void this.#enqueue(routed, () => this.#idleStop(routed, child));
		}
		if (workers === 0) {
			clearInterval(this.#idleTimer);
			this.#idleTimer = undefined;
		}
	}

	/** An idle stop when it runs: only if `child` is still the address's and still idle (a hold may have come since). */
	// 用途：实际执行空闲停止。输入地址记录和当初扫描到的子进程，返回 Promise<void>。
	// 先清除排队标志；若子进程已更替、已不空闲或空闲时长不足，则放弃。再次检查是因为排队期间可能有新请求。
	async #idleStop(routed: Routed, child: Child): Promise<void> {
		child.idleStop = false;
		if (routed.child !== child || child.idleSince === undefined) return;
		if (Date.now() - child.idleSince < this.#idleMs()) return;
		await this.#stop(routed);
	}

	/** How long a worker idles before it is stopped. */
	// 每次读取都调用 options.idleMs()，支持运行时调整；缺省为 5 分钟。
	#idleMs(): number {
		return this.#options.idleMs?.() ?? IDLE_MS;
	}

	/**
	 * The rollout step (§4): the set as this rollout applied it, read now (before another rollout changes it); the
	 * failures recorded before it cleared and the held ones retried (listed once ready or failed); the set shipped to
	 * every worker whose last applied set differs, in parallel. `context`'s abort ends only this wait: the entries
	 * still waiting are listed with its error.
	 */
	// 用途：执行一次 rollout。输入 context，输出每个受影响 worker 的结果列表。
	// 流程：取当前脚本集合并计算 key -> 清除所有失败并让路由重试（若正在启动则等待其结果）-> 对 shipped 不同的
	//   running worker 并行发送 reload。context 中止只影响本次等待，不取消已发出的重载。
	// 返回的 hosts 每个都有 host 名，并带 report、error 或 stopped 之一。
	async #rollout(context: Context): Promise<{ readonly hosts: readonly RolloutHost[] }> {
		const { kind, plugins } = this.#options;
		// current 是已经构建好的集合；没有则现场构建。两者都代表本次 rollout 的固定版本。
		const scripts = plugins.current(kind) ?? (await plugins.scripts(kind, context));
		const key = keyOf(scripts);
		const entries: { readonly host: string; readonly entry: Promise<RolloutHost> }[] = [];
		// 先处理失败地址：rollout 等价于一次隐式 retry，让它们有机会按新集合重新启动。
		for (const routed of [...this.#addresses.values()]) {
			if (routed.failure === undefined) continue;
			routed.failure = undefined;
			this.#state.refresh();
			this.route.retry(routed.address);
			const started = routed.starting;
			// 没有正在进行的启动：记录可直接回收；否则等这次启动完成并把结果列为 rollout 结果。
			if (started === undefined) this.#forget(routed);
			else entries.push({ host: routed.address.key, entry: this.#retried(routed, started) });
		}
		// 再处理运行中的 worker：只重载集合确实变化的；停止中的 worker 不再接收重载。
		for (const routed of this.#addresses.values()) {
			const child = routed.child;
			if (child === undefined || child.status === "stopping" || child.shipped === key) continue;
			entries.push({ host: routed.address.key, entry: this.#reload(routed.address.key, child, scripts, key) });
		}
		// 并行等待，但每个等待都被 context 约束；超时/中止的条目转成带 error 的结果，而不是让整个 rollout 抛出。
		return { hosts: await Promise.all(entries.map(({ host, entry }) => bounded(host, entry, context))) };
	}

	/** A retried address's entry: its start's load report once ready, or its error. */
	// 用途：等待一次重试启动。输入地址记录和启动 Promise，输出 RolloutHost。
	// 启动失败、启动后子进程又退出、或 ready 报告到达前退出，都转成 { host, error }，不向 rollout 抛出。
	async #retried(routed: Routed, started: Promise<unknown>): Promise<RolloutHost> {
		const host = routed.address.key;
		try {
			await started;
			const child = routed.child;
			// 启动成功后子进程可能立刻崩溃；没有 child 就没有报告可等。
			if (child === undefined) throw new Error("worker: exited");
			return { host, report: uncrossedReport(await child.ready.promise) };
		} catch (error) {
			return { host, error };
		}
	}

	/**
	 * Ships `scripts` to `child` after its outstanding reload; settles on `reloaded`, its link's loss or its exit. Only a
	 * reload that applied without failures marks the set shipped (a failed plugin is shipped again next time).
	 */
	// 用途：向一个子进程发送重载并等待结果。输入 host 名、子进程、脚本集和集合 key，输出 RolloutHost。
	// 串行化：接在 child.reloading 之后，保证同一子进程一次只有一个未完成重载。
	// 结算来源：reloaded 成功/失败、child.ended（link 丢失或退出）、或已 ended 时不发送直接返回。
	// 只有零失败的报告才更新 shipped；含失败插件的集合下次 rollout 会再次发送。
	#reload(host: string, child: Child, scripts: readonly PluginScript[], key: string): Promise<RolloutHost> {
		const reload = child.reloading.then(
			() =>
				new Promise<RolloutHost>((resolve) => {
					const settle = (ended: Ended): void => {
						resolve(ended.kind === "stopped" ? { host, stopped: true } : { host, error: ended.error });
					};
					// 排队期间子进程已经结束：不再发送，直接以结束原因结算。
					if (child.ended !== undefined) {
						settle(child.ended);
						return;
					}
					child.reloaded = (reply) => {
						// 一次只处理一条回复；清空 waiter，避免后续消息重复 resolve。
						child.reloaded = undefined;
						if ("report" in reply) {
							if (reply.report.failed.length === 0) child.shipped = key;
							resolve({ host, report: uncrossedReport(reply.report) });
						} else if (child.ended !== undefined) {
							// 错误回复与结束同时发生时，以更具体的结束原因（stopped/error）为准。
							settle(child.ended);
						} else {
							resolve({ host, error: uncrossed(reply.error) });
						}
					};
					child.process.send({ kind: "reload", scripts });
				}),
		);
		// 队列只等待完成，不保留报告（报告可能引用大对象）；错误也吞掉，由单个 reload Promise 传播。
		child.reloading = reload.then(
			() => {},
			() => {},
		);
		return reload;
	}
}

/** What new starts reject with once the component closes. */
// released/closed 是稳定错误码：调用方据此区分“服务器正常关闭”与其他失败，不重试。
function closed(): ChordError {
	return new ChordError({ code: "released", reason: "closed", message: "workers: closed" });
}

/** The full error of an exit nobody asked for (the app's logs). */
// 完整错误只进 onError：根据退出方式（信号或退出码）和阶段（starting 还是 running）生成可读消息。
function exitError(address: Address, { code, signal }: Exit, child: Child): Error {
	const how = signal === null ? `code ${code}` : `signal ${signal}`;
	const when = child.status === "starting" ? "exited before it was ready" : "exited";
	return new ChordError({ code: "unavailable", message: `worker ${address.key}: ${when} (${how})` });
}

/** The public error of an exit: a start that failed, or the exit's code or signal. */
// 对外不暴露完整命令/路径：启动阶段一律 START_FAILED，运行阶段只给退出信号/码。
function publicExit({ code, signal }: Exit, child: Child): CrossedError {
	if (child.status === "starting") return START_FAILED;
	return { message: `worker exited (${signal ?? `code ${code}`})`, code: "unavailable" };
}

/** A set's identity: its plugins and digests. */
// 脚本集的身份：每个插件名 + 构建摘要（构建失败的插件用 "failed"）。排序消除顺序差异。
// 同一集合无论以何种顺序传入，得到的 key 相同，rollout 才能判断 worker 是否已是最新。
function keyOf(scripts: readonly PluginScript[]): string {
	return scripts
		.map(({ plugin, built }) => `${plugin.name}@${built.kind === "script" ? built.digest : "failed"}`)
		.sort()
		.join("\n");
}

/** `entry`, or `host` listed with the abort's error once `context` aborts first (the entry goes on). */
// 用途：给单个 rollout 结果加等待上界。输入 host 名、结果 Promise 和 context，输出 RolloutHost。
// 中止只把“等待”转为错误结果；entry 本身继续执行（例如已发送的重载），不会因调用方离开而取消。
async function bounded(host: string, entry: Promise<RolloutHost>, context: Context): Promise<RolloutHost> {
	try {
		return await awaitWithContext(entry, context);
	} catch (error) {
		return { host, error };
	}
}

/** The workers' state: a JSON watchable of every address's `WorkerState`, published once per microtask turn. */
// #value 是惰性快照；refresh 只清缓存并在有观察者时安排一次微任务发布，避免频繁 fork/stop 造成多次通知。
class WorkersState extends Source {
	readonly #addresses: ReadonlyMap<string, Routed>;
	#value: Readonly<Record<string, WorkerState>> | undefined;
	#scheduled = false;

	constructor(addresses: ReadonlyMap<string, Routed>, batch: Batch) {
		super(batch);
		this.#addresses = addresses;
	}

	get value(): JsonValue {
		// 首次读取或 refresh 后重新计算；地址 Map 是活的引用，所以快照必须按需重建。
		this.#value ??= stateOf(this.#addresses);
		// Plain JSON: statuses, numbers and crossed errors.
		return this.#value as unknown as JsonValue;
	}

	deliver(context: Context): void {
		const value = this.value;
		// 一次性替换整个记录；键 "r" 是发布协议里的根字段名。
		this.publish(value, [["r", value]], false, context);
	}

	/** Something changed: published with the turn's other changes while someone watches or derives from it. */
	// 无人 watch 且无人 derive 时只清缓存，不安排发布；有变化合并到同一微任务，多次 refresh 只发布一次。
	refresh(): void {
		this.#value = undefined;
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
}

/** Every address's state: its child's, or its failure; none for an address with neither. */
// failed 优先于 child（失败地址可能仍有正在退出的子进程）；否则有 child 时输出其状态、pid 和启动时间。
// 空地址记录（只有队列/starting）不输出，因此 stop 后或未启动的地址在 state 中没有条目。
function stateOf(addresses: ReadonlyMap<string, Routed>): Record<string, WorkerState> {
	const state: Record<string, WorkerState> = {};
	for (const [key, { child, failure }] of addresses) {
		if (failure !== undefined) {
			state[key] = { status: "failed", ...failure };
		} else if (child !== undefined) {
			const { pid, startedAt } = child.process;
			state[key] = { status: child.status, pid, startedAt };
		}
	}
	return state;
}
