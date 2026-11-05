import { createModels } from "@earendil-works/pi-ai";
import {
	type AnyTask,
	createRegistry,
	defineExtension,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	type Registry,
	type RegistryReader,
	type ReportInfo,
	type Storage,
} from "@earendil-works/pi-durable";
import { context, flush } from "./session-support.ts";

// 可手动完成的 Promise：T 默认 void；readonly 只防止替换 promise 属性。
// resolve 接收 T，reject 接收 unknown；这些类型不会验证运行时传值。
export type Deferred<T = void> = {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
};

// 建立 Promise 并把成功/失败函数一起交给测试，返回 Deferred<T>，不产生外部 I/O。
// 例如 const gate = deferred<number>(); gate.resolve(3) 后 await gate.promise 得 3；reject 则让等待者失败。
export function deferred<T = void>(): Deferred<T> {
	// 用确定赋值断言声明成功函数；Promise 执行器在构造时同步赋值。
	let resolve!: (value: T) => void;
	// 同样保存失败函数，unknown 允许测试模拟任意拒绝原因。
	let reject!: (error: unknown) => void;
	// 创建泛型 Promise；done 和 fail 由 JavaScript 引擎提供。
	const promise = new Promise<T>((done, fail) => {
		// 把成功入口保存到闭包外的局部变量。
		resolve = done;
		// 保存失败入口；调用任何一个后 Promise 的终态不能再改变。
		reject = fail;
	});
	// 返回三个引用，调用方可分别持有等待端和触发端。
	return { promise, resolve, reject };
}

/** Reject with the signal's reason once it aborts; for handlers that block until cancelled. */
// 返回只会拒绝的 Promise<never>，输入取消信号；已取消则立即安排拒绝，否则等待 abort。
// 例如 await aborted(controller.signal) 可让阶段停到测试调用 abort；该函数不取消任务本身。
export function aborted(signal: AbortSignal): Promise<never> {
	// 执行器同步安装监听；不用 resolve，所以没有成功返回值。
	return new Promise((_, reject) => {
		// 已取消时保留原 reason，避免错过此前发生的事件。
		if (signal.aborted) reject(signal.reason);
		// 将来取消也以原 reason 拒绝；once 让触发后的监听自动移除。
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** Flush macrotask turns until `check` holds. */
// 最多检查 200 次谓词，每次失败让出一个宏任务；成功返回 void，否则抛错。
// 例如等待工具计数变成 1；它不是 200ms 超时，check 也可以异步，错误直接传出。
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	// 次数上限防止测试永远轮询，但不能打断卡住的谓词。
	for (let attempt = 0; attempt < 200; attempt++) {
		// await 同时支持 boolean 与 Promise<boolean>，满足即返回。
		if (await check()) return;
		// 等待 session-support 的 setTimeout(0)，让调度器推进一轮。
		await flush();
	}
	// 用明确错误结束测试，而不是把未满足误当成功。
	throw new Error("Condition was not reached");
}

/** Whether `promise` has settled after pending work flushes. */
// 观察 Promise 在一次 flush 后是否已成功或失败，返回布尔值；不会等它最终结束。
// 例如 settled(未释放门闩.promise) 通常为 false；它也安装拒绝处理器，拒绝同样算 settled。
export async function settled(promise: Promise<unknown>): Promise<boolean> {
	// 闭包中的观察标志，初始未完成。
	let done = false;
	// 同时注册成功与失败回调，两条路径都只更新标志。
	promise.then(
		// 成功回调不读取值，只记录已完成。
		() => {
			// 将共享标志置真；失败分支做同样的记录。
			done = true;
		},
		() => {
			done = true;
		},
	);
	// 给成功或失败的回调一次运行机会。
	await flush();
	// 返回该观察时点的状态，不对之后的完成时刻作保证。
	return done;
}

/** Open a Harness whose registry holds `tasks`; failures passed to `onReport` are collected, their infos in `infos`. */
// 在 storage 上打开仅供任务测试的 Harness，安装 tasks，返回运行器/注册表及报告数组。
// options 可复用注册表、注入时间/计时器/遥测；例如 openTasks(storage, [Reminder])。
// 此函数不提交任务；安装冲突或打开失败会传出，调用方负责关闭运行器。
export async function openTasks(
	storage: Storage,
	tasks: readonly AnyTask[],
	options: {
		readonly registry?: Registry;
		readonly now?: () => number;
		readonly settings?: HarnessSettings;
		readonly onWake?: HarnessOptions["onWake"];
		readonly setTimer?: HarnessOptions["setTimer"];
		readonly telemetry?: HarnessOptions["telemetry"];
	} = {},
): Promise<{
	readonly harness: Harness;
	readonly registry: Registry;
	readonly reports: unknown[];
	readonly infos: ReportInfo[];
}> {
	// ?? 只在未提供注册表时创建新的；传入时安装会修改宿主注册表。
	const registry = options.registry ?? createRegistry();
	// 非空才安装名为 tasks 的扩展；同名扩展会由注册表替换。
	if (tasks.length > 0) registry.install(defineExtension({ name: "tasks", tasks }));
	// 原始错误值保存在独立数组，unknown 强制使用者先缩窄类型。
	const reports: unknown[] = [];
	// 元信息数组与 reports 一一按下标对应。
	const infos: ReportInfo[] = [];
	// 异步打开会话；模型路由为空，不接入真实供应商。
	const harness = await Harness.open(
		storage,
		{
			// 创建空模型路由；任务测试不必调用模型。
			models: createModels(),
			// 把上面装好任务的注册表交给 Harness。
			registry,
			// 解构报告，收集错误与来源信息供测试断言。
			onReport: ({ error, ...info }) => {
				// 追加原始错误。
				reports.push(error);
				// 追加同一报告的其余字段。
				infos.push(info);
			},
			// 以下条件展开只加入明确提供的选项，省略时保留 Harness 默认值。
			// now 供取时；settings 控制策略；onWake 接收唤醒通知；setTimer 安排计时；telemetry 记录观测数据。
			...(options.now === undefined ? {} : { now: options.now }),
			...(options.settings === undefined ? {} : { settings: options.settings }),
			...(options.onWake === undefined ? {} : { onWake: options.onWake }),
			...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
			...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
		},
		// 使用共享背景上下文完成打开。
		context,
	);
	// 交还句柄与可观察数组，后续报告会继续追加其中。
	return { harness, registry, reports, infos };
}

/** Next state that completes a task with `result`. */
// 把泛型结果包装为任务完成决策，纯对象返回，无存储写入；例如 completed(3)。
// 只有调用方把它交给 runtime.commit 才会落地；as const 保留 status 字面量供联合类型判别。
export function completed<R>(result: R) {
	// 外层 terminal 结束调度，内层 completed 表示成功并携带 result。
	return { status: "terminal", outcome: { status: "completed", result } } as const;
}

/** Next state that aborts a task. */
// 把原因包装为任务已取消决策；例如 abortedWith("stop")，仅构造对象，不发出取消信号。
// as const 防止 status 被推宽成普通 string，返回值可作为任务状态使用。
export function abortedWith(reason: string) {
	// terminal 结束任务，aborted 与 reason 保存取消结果。
	return { status: "terminal", outcome: { status: "aborted", reason } } as const;
}

/** Registry reader that counts live subscriptions. */
// 包装注册表为只读接口并统计当前订阅数；返回交叉类型，额外带 subscriptions()。
// 例如订阅两次并取消一次得到 1；取消函数幂等，重复取消不会继续减数。快照和通知仍委托原注册表。
export function countingReader(registry: Registry): RegistryReader & { subscriptions(): number } {
	// 计数属于这一包装器实例，而不是 registry 的所有订阅总数。
	let count = 0;
	// 返回由闭包共享 count 的读取器对象。
	return {
		// 每次读取原注册表的当前快照。
		snapshot: () => registry.snapshot(),
		// 每次订阅创建独立的 active 状态与取消函数。
		subscribe: (listener) => {
			// 先计入本次订阅；若底层 subscribe 抛错，这里没有回滚逻辑。
			count++;
			// 真正注册监听，保存底层的取消入口。
			const unsubscribe = registry.subscribe(listener);
			// 记录这个订阅是否还有效。
			let active = true;
			// 返回给调用者的取消闭包。
			return () => {
				// 已取消时立即结束，保证不会重复减计数。
				if (!active) return;
				// 先关闭状态，再修改计数并调用底层取消。
				active = false;
				// 只扣除本次订阅一次。
				count--;
				// 从真实注册表移除监听。
				unsubscribe();
			};
		},
		// 调用时返回最新计数，不捕获创建时的 0。
		subscriptions: () => count,
	};
}
