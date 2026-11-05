// A Durable Object that hosts a Harness the way an application would: opened in the constructor, woken by its alarm
// through `onWake`. Tests drive it with `runInDurableObject()`, evict it, and run its alarm.
// 本地 workerd 测试用宿主：把 Harness 的持久任务接到 Durable Object 的 SQLite 和 alarm（平台唤醒事件）。
// 模型始终是 faux 脚本替身；驱逐对象会丢失实例字段，SQLite/kv 中的任务、脚本游标和时间偏移仍保留。
import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	type TaskId,
	type Wake,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

// 共用后台操作上下文；它不是 Cloudflare 的 DurableObjectState，也不是模型对话上下文。
const context = BACKGROUND_CONTEXT;

/** Sleeps until `at`, then completes with the Harness time it woke at. */
// 定义提醒状态机，尚未启动任务。三个泛型依次约束输入、检查点联合类型和结果；这些 TS 类型不会校验外部 JSON。
// 例：at=1000 时，wait 保存 deliver 检查点并休眠，到期恢复后把当时 Harness 时钟值提交为完成结果。
// sleepUntil 返回表示休眠已持久化，不表示已经等到 at；提交失败通过返回的 Promise 传给调度器。
export const Reminder = defineTask<{ at: number }, { phase: "wait" } | { phase: "deliver" }, number>({
	// name/version 是持久任务找到注册定义与版本的依据。
	name: "test.reminder",
	version: 1,
	// 新任务从 wait 开始；箭头后的括号表示返回对象，而非函数体。
	initial: () => ({ phase: "wait" }),
	phases: {
		// 使用输入截止时间，把下一阶段一起存入休眠记录；ctx 将本次调用的上下文传给运行时。
		wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, ctx),
		// deliver 不读任务输入，因此以 _task 命名；async 回调返回 Promise<void>。
		deliver: async (_task, runtime, ctx) => {
			// 记录恢复执行这一刻的 Harness 时间，不保证恰好等于截止时间。
			const woke = runtime.now();
			// commit 回调返回终态，await 等持久提交完成；结果保存为 number。
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: woke } }), ctx);
		},
	},
	// 收到中止请求后，独立调用的 abort 处理器提交 aborted 终态，不执行提醒。
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Scripted model responses, kept in storage so a new instance continues the script: `hang` waits for an abort. */
// responses 是回答队列，next 是下次读取的数组下标；声明本身不验证 kv 中已有数据。
type Script = { responses: string[]; next: number };

// 活跃工作即使进程消失，也最多按这个目标间隔安排恢复心跳；单位为毫秒，不保证准时调度。
export const HEARTBEAT_MS = 60_000;

// 测试通过 runInDurableObject 直接操作这个实例；普通 HTTP 入口见文件末尾默认导出。
export class TestSession extends DurableObject {
	// # 是运行时私有字段，readonly 仅限制 TS 中重新赋值引用，不冻结 state 对象。
	readonly #state: DurableObjectState;
	// ! 是明确赋值断言：告诉 TS 初始化由并发屏障内完成，本身不产生运行时检查。
	#harness!: Harness;
	/** Added to `Date.now()`, kept in storage, so a test can move the Harness clock across evictions. */
	#offset = 0;
	/** The wakes `onWake` received, in order. */
	readonly wakes: Wake[] = [];
	/** Resolves when this instance's model request starts and hangs. */
	readonly hanging = Promise.withResolvers<void>();

	/**
	 * 接收平台 state 与环境绑定，安排异步打开/恢复 Harness；构造器本身没有 Promise 返回值。
	 * 并发屏障先安排兜底 alarm，再恢复偏移、替身、注册表和 SQLite；失败交给平台屏障处理。
	 * 例：同一对象被驱逐后重建，会从 kv 取回偏移和脚本位置，而 wakes/hanging 是新实例的数据。
	 */
	constructor(ctx: DurableObjectState, env: unknown) {
		// 初始化 Cloudflare 基类，再保存当前对象的 state 供后续方法使用。
		super(ctx, env);
		this.#state = ctx;
		// void 忽略 Promise 的表达式结果，并不捕获错误；平台屏障阻止其他事件抢在初始化前运行。
		void ctx.blockConcurrencyWhile(async () => {
			// A fallback before anything can throw: an object whose open or recovery fails is started again.
			// 这里用真实 Date 时钟，因为平台 alarm 也使用 epoch 毫秒。
			const fallback = Date.now() + HEARTBEAT_MS;
			const current = await ctx.storage.getAlarm();
			// 已有更早 alarm 则保留；没有或过晚才改写，避免恢复失败后永远没有下一次唤醒。
			if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
			// ?? 只在缺失/null 时回退到零；get<number> 是静态类型提示，不是数据验证。
			this.#offset = ctx.storage.kv.get<number>("offset") ?? 0;
			// 只建立内存模拟提供者，不连接真实模型服务。
			const faux = fauxProvider();
			// 建立八个延迟取脚本的响应函数；此时 #step 仅创建闭包，真正取值发生在模型请求时。
			faux.setResponses(Array.from({ length: 8 }, () => this.#step()));
			// Models 管理提供者；注册表管理持久任务定义，两者职责不同。
			const models = createModels();
			models.setProvider(faux.provider);
			const registry = createRegistry();
			registry.install(defineExtension({ name: "test", tasks: [Reminder] }));
			// 先打开同一对象的 SQLite 适配器，再异步打开 Harness；出错会拒绝屏障的 Promise。
			this.#harness = await Harness.open(
				await openDurableObjectSqliteStorage(ctx.storage),
				{
					// 对象简写把上面的模型集合与任务注册表作为宿主依赖传入。
					models,
					registry,
					// An eviction during a request is a failed attempt (#11139); its retry need not wait long here.
					settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
					// 箭头闭包保留 this；Harness 的睡眠截止时间用可偏移时钟。
					now: () => this.now(),
					// onWake 是同步通知，不能等待 alarm；记录每次通知，再启动异步平台写入。
					onWake: (wake) => {
						this.wakes.push(wake);
						// A failed alarm write resets the object; it arms again when it next starts.
						void this.arm(wake).catch(() => ctx.abort("Alarm write failed"));
					},
				},
				context,
			);
			// Armed before `resume()` runs anything, as for any call that can start work.
			// 在 resume 允许工作前等 alarm 写入完成，减小工作已提交但宿主未安排恢复的窗口。
			await this.arm(this.#harness.wake());
			this.#harness.resume();
		});
	}

	/** 无参数地返回当前实例打开的 Harness 引用，不复制或等待；例：测试用它读取任务。 */
	get harness(): Harness {
		return this.#harness;
	}

	/** 返回真实 epoch 毫秒加持久偏移，不修改状态；例：advance(100) 后相应前移约 100ms。 */
	now(): number {
		return Date.now() + this.#offset;
	}

	/** Move the Harness clock forward, for this instance and the ones after it. */
	/** 接收毫秒增量，无返回值；先改内存再同步写 kv，写入异常向外抛出。例：advance(600_000) 模拟过十分钟。 */
	advance(ms: number): void {
		// += 把增量累加到当前偏移；此方法本身不限制传入值必须为正。
		this.#offset += ms;
		// 同步 kv 持久化，使下次实例仍使用相同偏移。
		this.#state.storage.kv.put("offset", this.#offset);
	}

	/** 用字符串数组重置脚本及游标，无返回值；同步 kv 错误外抛。例：["hang", "ok"] 首次挂起、重建后回答 ok。 */
	script(responses: string[]): void {
		// satisfies 只在 TS 检查对象满足 Script，运行时仍保存同样的对象。
		this.#state.storage.kv.put("script", { responses, next: 0 } satisfies Script);
	}

	/** 平台 alarm 无参入口：先为可能启动的工作安排心跳，再恢复调度；写 alarm 失败则 Promise 拒绝。 */
	async alarm(): Promise<void> {
		// ... 展开当前唤醒状态，随后 active:true 覆盖原值，同时保留最早睡眠时间 at。
		await this.arm({ ...this.#harness.wake(), active: true });
		this.#harness.resume();
	}

	/** The alarm a host arms for `wake`: the earliest sleep, or a recovery heartbeat while work can run. */
	/**
	 * 接收 Wake，异步把平台 alarm 设为睡眠与心跳中较早者，或在两者皆无时删除；平台错误向调用方拒绝。
	 * 例：Harness 截止 1200、偏移 200，则平台睡眠 alarm 是 1000；active=true 还会参与心跳比较。
	 */
	async arm(wake: Wake): Promise<void> {
		// 只有活跃工作才需要以真实时钟计算恢复心跳。
		const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
		// 将 Harness 的偏移时间轴换回平台时间轴；没有睡眠时保留 undefined。
		const sleep = wake.at === undefined ? undefined : wake.at - this.#offset;
		// 任一缺失就用另一个（??），都有则 Math.min 选择更早时间。
		const at = heartbeat === undefined || sleep === undefined ? (heartbeat ?? sleep) : Math.min(heartbeat, sleep);
		// 这是副作用的分支：完全空闲删除 alarm，否则等待设定完成。
		if (at === undefined) await this.#state.storage.deleteAlarm();
		else await this.#state.storage.setAlarm(at);
	}

	/** 无参取得/创建根会话并选定 faux 模型，返回会话 Promise；失败外传。例：await root() 后可提交输入。 */
	async root(): Promise<Conversation> {
		// 只指定此测试提供者及模型 ID；实际运行依赖构造器已将 faux 注册进 models。
		return this.#harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	}

	/** 接收输入文字和去重 requestId，先安排 alarm 再持久接纳输入；不等待模型回答，任何 await 失败向外拒绝。 */
	async submit(text: string, requestId: string): Promise<void> {
		// Arm before admitting work: a process that dies after the commit is still woken.
		await this.arm({ ...this.#harness.wake(), active: true });
		// 内层 await 取会话，外层等待提交；对象简写保留传入 requestId，例如 "turn-1"。
		await (await this.root()).submit({ type: "input", content: text, requestId }, context);
	}

	/** 接收 Harness 时间轴上的截止毫秒，提交会话拥有的 Reminder 并启动调度，返回带 number 结果类型的任务 ID。 */
	async remind(at: number): Promise<TaskId<number>> {
		// 根会话/提交的拒绝会直接传给调用者；这里不会吞掉错误。
		const root = await this.root();
		const id = await root.commit(
			// tx 是事务视图；创建任务与其 ownership 一起持久化，尚未等到提醒完成。
			(tx) => tx.createTask(Reminder, { at }, { ownership: { kind: "conversation" } }),
			context,
		);
		// 允许调度器执行新任务；返回 ID 供 waitForTask 使用，例如 remind(now()+100)。
		this.#harness.resume();
		return id;
	}

	/** The next scripted response; the script position is stored before the response is used. */
	/**
	 * 无参创建 FauxResponseStep 回调，不立刻消费脚本；回调读 kv、先推进游标，再返回回答或挂起 Promise。
	 * 例："hang" 会通知 hanging 后一直等 abort；没有 signal 则不会自动结束，取消时以 AbortError 拒绝。
	 */
	#step(): FauxResponseStep {
		// _request 未使用；options 由 faux 提供，可能包含本次请求的取消信号。
		return (_request, options) => {
			// 泛型只提供静态形状；没有脚本就从空队列的第零项开始。
			const script = this.#state.storage.kv.get<Script>("script") ?? { responses: [], next: 0 };
			// 游标越界使用固定回答；空字符串不会触发 ?? 的回退。
			const text = script.responses[script.next] ?? "unscripted";
			// 在回答/挂起前推进持久游标，所以重建对象不会再次卡在同一个 hang。
			this.#state.storage.kv.put("script", { ...script, next: script.next + 1 });
			// 普通文字转成 faux 助手消息；只有完全等于 hang 才走挂起路径。
			if (text !== "hang") return fauxAssistantMessage(text);
			// withResolvers 的 resolve 唤醒等待请求已开始的测试，不是完成模型请求。
			this.hanging.resolve();
			// 不调用 _resolve，模拟尚未得到最终回答的请求。
			return new Promise((_resolve, reject) => {
				// 取消回调仅拒绝这次 Promise，错误随后由 faux/任务执行路径处理。
				const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
				// 已取消立即拒绝；否则通过可选链在存在 signal 时注册一次性事件。
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
			});
		};
	}
}

export default {
	// 无论请求内容如何都返回测试标识 Response；没有调用模型或进行状态读取。
	fetch: () => new Response("pi-durable test worker"),
};
