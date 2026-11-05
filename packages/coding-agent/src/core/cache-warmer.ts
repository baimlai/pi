// 管理一份模型请求的提示词缓存保温：SDK注册它，本轮Agent运行结束/设置变化时通知；计时器决定是否发额外模型请求，使用量另存usage条目。session仍可继续下一次提问。
import {
	// Api等是类型，下面calculateCost是实际计价函数，不是网络账单查询。
	type Api,
	// Context是已经规范化的模型输入结构。
	type Context,
	// 按模型目录单价计算估算费用，会改传入的局部usage.cost。
	calculateCost,
	// Model泛型保留供应商API关联。
	type Model,
	// ModelsSimpleStreamOptions包含路由/认证等模型运行时选项。
	type ModelsSimpleStreamOptions,
	// SimpleStreamOptions用于缓存保留与推理等共享字段。
	type SimpleStreamOptions,
	// Usage声明四种token及费用。
	type Usage,
} from "@earendil-works/pi-ai";
// 统一环境读取：既支持本次env覆盖，也遵循工具中的继承规则。
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
// 只需要ModelRuntime中流请求能力，后面用Pick缩小依赖。
import type { ModelRuntime } from "./model-runtime.ts";
// 当前分支与usage条目接口，不创建第二套会话管理器。
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
// 模式为off/streaming/idle，实际值由设置回调动态读取。
import type { CacheWarmingMode } from "./settings-manager.ts";

/** Streaming warming never continues past this long after the real request that started it. */
// 数字分隔符60_000等于60000毫秒；调度窗口从CacheWarmer.start时的本地时间算起，不随预热延长，并非网络任务的硬终止期限。
const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
// idle上限也从原startedAt计算，不是空闲后再计30分钟。
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
// 至少预期节省0.05美元才预热；扩展仍可覆盖这一动作。
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from our own usage; per-session estimates were not
 * better than this constant.
 */
// 空闲继续提问概率固定0.15，不是按当前用户实时学习出的值。
const IDLE_CONTINUATION_PROBABILITY = 0.15;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
// 计算提前刷新的等待毫秒，TTL<=10秒返回undefined；例：5分钟TTL得到270秒。只算数，不验证NaN/Infinity等全部异常数字，也不装定时器。
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	// 太短就不安排，避免没有10秒余量。
	if (ttlMs <= 10_000) return undefined;
	// 取90%TTL与TTL减10秒的较小者，向下取整，至少1ms。
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 */
// 按显式保留档、环境long/默认short读模型目录TTL，秒转毫秒；例：缓存none返回undefined。不探测服务端真实缓存命中或剩余寿命。
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	// 先选择保留档。
	const retention =
		// 可选链读显式值，??仅缺省才回退。
		options?.cacheRetention ??
		// 环境恰为long才选long，否则short；不把任意truthy都当长期。
		(getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
	// 显式关闭缓存就没有可预热TTL。
	if (retention === "none") return undefined;
	// 动态属性索引按档取秒数，模型没有声明则undefined。
	const seconds = model.promptCache?.[retention];
	// 缺失不伪造寿命；已有数字直接乘1000，没有额外范围检查。
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Anthropic's budget-based thinking (Claude models without
 * adaptive thinking) derives `budget_tokens` from `max_tokens`; the replay
 * would get a different budget, which Anthropic keys the message cache on,
 * and the model could still think for thousands of tokens.
 */
// 判断本策略是否允许以1输出token重放；例：Anthropic预算推理且未强制自适应时禁止。只是本地兼容策略，不证明远端必然缓存命中或只计费1token。
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	// 没启用reasoning或不是Anthropic消息API时直接允许；包括不在此细分的其他API。
	if (!options?.reasoning || model.api !== "anthropic-messages") return true;
	// API分支后用断言访问其兼容字段，只有明确true才允许该推理重放。
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

/** Prompt size of the most recent real request on the branch, as reported by the provider. */
// 倒序取分支最近assistant的输入+缓存读写量，无assistant返回0；例：usage条目本身跳过。不排除error/aborted，也不验证这次usage是否完整，只按现有数据估算。
function lastPromptTokens(entries: SessionEntry[]): number {
	// 从末项往前找，index--逐次减1。
	for (let index = entries.length - 1; index >= 0; index--) {
		// 读取当前原始条目引用，不复制。
		const entry = entries[index];
		// 双标签判断让TS知道它是assistant消息。
		if (entry.type === "message" && entry.message.role === "assistant") {
			// 取该消息的用量。
			const usage = entry.message.usage;
			// 提示词量不含output；不使用累计totalTokens。
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	// 没有可参考助手消息，使用0作为未知量。
	return 0;
}

// 用局部usage估算指定token组合的美元价格，返回total；例：只传cacheRead时其余计0。模型可有阶梯价格，计算只修改局部对象。
function price(
	// 模型目录包含单价与可能的输入档位。
	model: Model<Api>,
	// Pick选择四个token键，再用Partial让它们都可省；不是任意字符串字段字典。
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	// 先建立完整Usage供calculateCost使用。
	const usage: Usage = {
		// 普通输入缺省0。
		input: 0,
		// 输出缺省0。
		output: 0,
		// 缓存读缺省0。
		cacheRead: 0,
		// 缓存写缺省0。
		cacheWrite: 0,
		// totalTokens未重新相加，calculateCost依据各分项而非此字段。
		totalTokens: 0,
		// 局部费用容器由calculateCost覆写，不改模型的cost。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		// 对象展开在后，覆盖传入的token分项。
		...tokens,
	};
	// 返回估算总额，不是提交收费或供应商账单。
	return calculateCost(model, usage).total;
}

// 动作字面量联合便于分支收窄；warm发一次刷新，stop停止直到另一次start。
export type CacheWarmingAction = "warm" | "stop";

/** Inputs and outcome of one warm-or-stop decision, as shown by `/session`. */
// 一次经济决策的完整展示信息；数值可能随分支/阶段改变，接口不验证有限性。
export interface CacheWarmingDecision {
	/** "streaming" while the agent run that sent the request is still active. */
	// streaming指引发预热的Agent活动尚未settled；不表示预热自身正在逐字输出。
	phase: "streaming" | "idle";
	/** Price of this refresh: a cache read of the prompt plus one output token. */
	// 缓存读整个提示词加1输出token的目录估算。
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost. */
	// 下一真实请求丢缓存相对命中的额外估算，不是重发费用本身。
	missCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	// streaming固定1、idle固定0.15的概率假设。
	continuationProbability: number;
	/** `continuationProbability * missCost - warmCost`. */
	// 概率乘丢缓存额外成本，再减预热成本。
	expectedSavings: number;
	/** False when the prompt size or the model's prices are unknown. */
	// 按已知提示词量和正成本粗判能否比较；不是价格可靠性证明。
	economicsAvailable: boolean;
	/** Pi's decision: "warm" when `expectedSavings` is at least $0.05. */
	// Pi自身建议；扩展覆盖另在status标记。
	action: CacheWarmingAction;
}

/**
 * Fired before each refresh with pi's decision filled in. Everything else an
 * extension might want (model, idle state, context size) is on the context.
 */
// 发给扩展的轻量决策事件，不含完整请求正文。
export interface CacheWarmingDecisionEvent
	// extends Pick复用四个字段的类型，避免重复定义；不复制运行时对象。
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "action"> {
	// 固定type供扩展runner分发。
	type: "cache_warming_decision";
}

// 扩展可只返回覆盖动作，也可省略表示不改；runner负责合并。
export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	// 可选动作，不是新的永久全局设置。
	action?: CacheWarmingAction;
}

// 外部状态快照，字段可选性没有表达所有state之间的互斥关系。
export interface CacheWarmingStatus {
	/** "scheduled": a refresh timer is armed; "refreshing": a warm request is in flight. */
	// inactive无活动、scheduled有定时器、refreshing当前run无timer；最后一种也包含等待扩展决策阶段。
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	// 无活动的原因文字，可缺。
	reason?: string;
	// 下一决策计划的Unix毫秒时间；刷新中仍可能保留上一次值。
	nextWarmAt?: number;
	/** The pending decision, or the decision that stopped warming. */
	// 当前重新评估或保存的停止决策，非服务端缓存状态。
	decision?: CacheWarmingDecision;
	/** True when an extension changed `decision.action`. */
	// 本次是否由扩展改变动作，不表示所有扩展都执行成功。
	extensionOverride?: boolean;
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
// 保存要重放的请求材料，字段仍是原对象引用，不深复制快照。
export interface CacheWarmRequest {
	// 选择的具体模型。
	model: Model<Api>;
	// 请求上下文共享引用；调用方保证有效性，isCurrent另作检查。
	context: Context;
	// 会带认证/headers等选项，重放时浅复制并覆写输出/重试/取消项。
	options: ModelsSimpleStreamOptions;
}

// ActiveRun继承请求字段，再追加保温生命周期状态。
interface ActiveRun extends CacheWarmRequest {
	/** False once the session's model or messages no longer match the request. */
	// 无参回调动态判断原请求是否仍适用，不只是start时检查一次。
	isCurrent: () => boolean;
	// 模型目录的缓存寿命毫秒。
	ttlMs: number;
	// 每轮计划的等待间隔。
	delayMs: number;
	/** Latest safe time to send this refresh, leaving half the original expiry margin. */
	// 本层准入检查的截止时间，定时器晚醒可能越界；后续认证/路由等待不受这个字段硬中断。
	refreshDeadlineAt: number;
	// 原始start的本地时间，用作调度窗口起点；不是供应商接收到真实请求的时间。
	startedAt: number;
	// 保温专用取消控制器，替代原请求signal。
	controller: AbortController;
	// 当前按运行中/空闲评估收益。
	phase: "streaming" | "idle";
	// 最近安排的刷新时间。
	nextWarmAt: number;
	/** Set while a refresh that an extension forced is in flight. */
	// 刷新期间记录扩展覆盖，在schedule下一轮时重置。
	extensionOverride: boolean;
	// ReturnType取得当前Node计时器句柄类型；可缺用于表示刷新阶段。
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 */
// 单实例只持一个活动run；替换会取消旧run，但不等待远端任务真正终止。
export class CacheWarmer {
	// private为TS访问约束，?表示初始没有活动run。
	private run?: ActiveRun;
	// 保存停止原因和可选决策，getter可能返回这个同一对象。
	private inactive: CacheWarmingStatus;
	// readonly禁止重新赋models字段，不冻结该运行时对象。
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	// 只依赖持久化额外用量与读取分支两个能力。
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	// 函数引用每次调用获取最新模式。
	private readonly getMode: () => CacheWarmingMode;
	/** Lets extensions override `event.action`; failures fall back to pi's decision. */
	// 决策回调返回Promise，默认复用Pi建议，扩展失败在refresh回退。
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** Called with the persisted usage entry after each successful refresh. */
	// 可选成功通知函数，异常由refresh的try吞掉。
	onWarmed?: (entry: UsageEntry) => void;

	// 保存依赖和初始状态，不发请求/装计时器；例：先new CacheWarmer，再start才开始计划。没有复制传入服务。
	constructor(
		// 传可发模型流的对象，不在这里初始化供应商SDK。
		models: Pick<ModelRuntime, "streamSimple">,
		// 会话提供读取/记账接口。
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		// getMode可观察中途设置变化。
		getMode: () => CacheWarmingMode,
		// 缺省async回调返回event.action，async把值包装成Promise。
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
	) {
		// 保存模型服务引用。
		this.models = models;
		// 保存会话服务引用。
		this.sessionManager = sessionManager;
		// 保存模式读取器本身而不是首次结果。
		this.getMode = getMode;
		// 保存外部决策回调。
		this.decide = decide;
		// 首次start前有可展示的等待原因。
		this.inactive = { state: "inactive", reason: "waiting for first request" };
	}

	// 读取展示状态，不装/清定时器；例：上下文变更时显示inactive，但真正取消要由后续验证/显式动作完成。会读分支重新估价，回调/服务异常可向外抛。
	get status(): CacheWarmingStatus {
		// 开关off优先显示禁用，不直接clearRun。
		if (this.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		// 局部快照避免本段重复读可选字段。
		const run = this.run;
		// 无run返回已保存的inactive对象，并不深复制。
		if (!run) return this.inactive;
		// 上下文失效只报告，不在getter终止运行。
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		// 按当前分支/阶段重新估算，不一定等于最近一次扩展看到的数据。
		const decision = this.evaluate(run);
		// 没有timer就展示refreshing，包括扩展决策等待阶段。
		const refreshing = run.timer === undefined;
		// 无经济信息且只是计划中时显示inactive，内部timer仍可能存在。
		if (!decision.economicsAvailable && !refreshing) {
			// 回新对象覆盖展示原因，不改inactive字段。
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		// 有可展示run时构造新的状态对象。
		return {
			// 三元选择状态标签。
			state: refreshing ? "refreshing" : "scheduled",
			// 返回已有计划时间，刷新中它可已过去。
			nextWarmAt: run.nextWarmAt,
			// 简写保存此次重新评估结果。
			decision,
			// 扩展覆盖标记来自当前run。
			extensionOverride: run.extensionOverride,
		};
	}

	/** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
	// 用新请求替换旧run，计算TTL/资格后安排刷新，返回void；例：5分钟缓存先等4分半。start不立即请求模型，也不先按经济性拒绝，实际决策在定时器触发时。
	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		// 先取消旧run，即使新请求最后不合资格也不保留旧保温。
		this.clearRun();
		// 动态读设置。
		const mode = this.getMode();
		// off直接停止。
		if (mode === "off") {
			// 保存禁用原因。
			this.stop("cache warming disabled");
			// 不再创建run。
			return;
		}
		// 对预算推理兼容性作本地判断。
		if (!isReplayable(request.model, request.options)) {
			// 不可重放则停止。
			this.stop("request cannot be replayed safely");
			// 没有新的计时器。
			return;
		}
		// 读取本次保留档对应的模型TTL。
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		// 没有TTL就不可调度。
		if (ttlMs === undefined) {
			// 设置具体停止原因。
			this.stop(
				// 这里只看显式cacheRetention是否none。
				request.options.cacheRetention === "none"
					? // 明确是请求禁缓存。
						"request disabled prompt caching"
					: // 其他情况统一说寿命未知。
						"cache lifetime unavailable",
			);
			// 结束start。
			return;
		}
		// 算保留10秒余量的刷新等待。
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		// TTL太短时没有间隔。
		if (delayMs === undefined) {
			// 记录不能调度的原因。
			this.stop("cache lifetime unavailable");
			// 不进入活动态。
			return;
		}
		// 建立新的活动对象。
		this.run = {
			// 浅展开请求，model/context/options内部仍共享引用。
			...request,
			// 保存上下文有效性检查回调。
			isCurrent,
			// 寿命毫秒属性简写。
			ttlMs,
			// 间隔属性简写。
			delayMs,
			// 先占位，schedule会计算真实安全截止时间。
			refreshDeadlineAt: 0,
			// 所有后续调度窗口从此刻开始；SDK此时还没有真正发送原模型请求。
			startedAt: Date.now(),
			// 为保温创建独立控制器，不直接沿用原请求signal。
			controller: new AbortController(),
			// 初始先视为streaming，settled后再调整。
			phase: "streaming",
			// 下一次时间先占位0。
			nextWarmAt: 0,
			// 尚无扩展覆盖。
			extensionOverride: false,
		};
		// 同步安排计时器，自己不等待刷新结果。
		this.schedule(this.run);
	}

	// 通知原Agent活动已settled，切换idle或停止；例：streaming模式立即停。idle的30分钟仍从start计时，不从此刻重新算；返回void不等待已发请求结束。
	onAgentSettled(): void {
		// 快照当前run。
		const run = this.run;
		// 没活动无需处理。
		if (!run) return;
		// 只在streaming模式有此立即停止规则；其他模式切idle，off由后续检查处理。
		if (this.getMode() === "streaming") {
			// 取消timer/请求并保存原因。
			this.stop("agent run settled");
			// 不再进入idle分支。
			return;
		}
		// 直接改活动对象phase，后续成本概率变0.15。
		run.phase = "idle";
		// 固定原startedAt加30分钟。
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		// 下次计划超过截止或现在已经到期就停；nextWarmAt恰等截止且当前未到时此处不拦。
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			// 保存空闲安全窗口到期原因。
			this.stop("30-minute idle safety limit reached");
		}
	}

	/** Reconcile an active run after the persisted warming mode changes. */
	// 设置持久化变化后协调已有run，返回void；例：off会stop，不会凭新开关自动重建之前已停的run。
	onModeChanged(): void {
		// 读取当前活动。
		const run = this.run;
		// 没活动直接结束，等待下次真实请求start。
		if (!run) return;
		// 计算当前模式要求停止的原因。
		const reason = this.getModeStopReason(run);
		// 原因非空才清活动；否则保持原计划。
		if (reason) this.stop(reason);
	}

	// 显式取消保温，清计时器并请求abort，返回void；例：切分支后不再重放旧材料。不等待HTTP/模型任务真的结束。
	cancel(): void {
		// 统一经stop保存inactive原因。
		this.stop("inactive");
	}

	// 内部释放run引用、timer并发取消信号；例：新start先清旧run。无活动时无操作，不保存停止原因，也不await清理。
	private clearRun(): void {
		// 保存旧对象供后面清理。
		const run = this.run;
		// 本来就没活动则结束。
		if (!run) return;
		// 先断开身份关联，让旧异步结果不能作为当前run记账。
		this.run = undefined;
		// 有timer才清，不撤销已执行的定时器回调。
		if (run.timer) clearTimeout(run.timer);
		// 给保温自己的请求发取消信号，远端效果依底层实现。
		run.controller.abort();
	}

	// 统一停止并保存展示信息；例：经济性不足时附decision。Pick只允许传决策/覆盖字段，spread为浅复制；没有额外模型请求。
	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		// 先释放活动资源。
		this.clearRun();
		// 构造inactive并展开可选决策信息，保留原decision引用。
		this.inactive = { state: "inactive", reason, ...stopped };
	}

	// 给指定run安排下一轮，检查调度窗口后安装unref定时器，返回void；例：每次刷新后继续等相同delay，不重置startedAt。它不保证到30/60分钟就硬中止已发请求，内部依赖调用方传当前run。
	private schedule(run: ActiveRun): void {
		// 下一轮重新等待扩展决策，先清覆盖标记。
		run.extensionOverride = false;
		// 从当前本地时间加间隔，不沿旧计划累加。
		run.nextWarmAt = Date.now() + run.delayMs;
		// A timer can run late after sleep or event-loop blockage. Keep half of
		// the planned pre-expiry margin for that delay and request dispatch; a
		// late refresh is likely a full-price cache write, not a cache warm.
		// 例：TTL300秒、delay270秒，截止在计划后15秒；迟到太久就不冒险付全价重写。
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		// 按phase选30分钟或1小时的调度窗口，均从原startedAt算；refresh不再次按这个年龄检查。
		const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
		// 下一计划越界或现在已到期则立即停。
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			// 按phase选择展示原因。
			this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			// 不安装定时器。
			return;
		}
		// 回调void启动async refresh，不await；剩余等待钳到非负，回调异常不会由void捕获。
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		// 可选调用unref让这个timer自己不阻止进程退出，不等于取消timer。
		run.timer.unref?.();
	}

	// 一次刷新：验证上下文/期限，评估收益并让扩展覆盖，必要时重发请求、记录usage、续约计时。例：扩展stop则本轮不发模型请求。模型/记账块异常吞掉，但更早的回调/评估异常不在该try内。
	private async refresh(run: ActiveRun): Promise<void> {
		// 标记timer已触发，状态getter据此显示refreshing。
		run.timer = undefined;
		// 旧run、关闭模式、失效上下文均不可继续。
		if (!this.validateRun(run)) return;
		// 定时器太晚触发就停止，不用一次昂贵请求补救。
		if (this.refreshDeadlineMissed(run)) return;
		// 读取当前分支用量与目录费用。
		const decision = this.evaluate(run);
		// 解构本次向扩展公开的三个数字。
		const { warmCost, missCost, continuationProbability } = decision;
		// let允许扩展返回值替换建议动作。
		let action = decision.action;
		// 仅决策回调异常在这层catch中回退。
		try {
			// await期间可能切模型/上下文/设置，所以后面还要复验。
			action = await this.decide({
				// 事件固定标签。
				type: "cache_warming_decision",
				// 预热估算成本属性简写。
				warmCost,
				// 丢缓存额外成本属性简写。
				missCost,
				// 继续提问概率假设属性简写。
				continuationProbability,
				// 传原建议，扩展可保留或覆盖。
				action,
			});
			// 失败保持action原值，不令当前Agent运行失败。
		} catch {
			// Extension failures fall back to pi's own decision.
		}
		// await后再次验证活动身份和截止，避免过时决策发旧请求。
		if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
		// 只比较最终动作是否不同，不记录每个扩展中间意见。
		const extensionOverride = action !== decision.action;
		// stop分支停止后不会再schedule。
		if (action === "stop") {
			// 构造停止说明。
			const reason = extensionOverride
				? // 扩展改变了动作且结果为stop时说明扩展叫停。
					"stopped by extension"
				: // 否则按是否有经济信息区分。
					decision.economicsAvailable
					? // 有价格/输入量但收益不够。
						"expected savings below threshold"
					: // 输入量或价格不可用。
						"cache economics unavailable";
			// 在实例内保存这份决策与覆盖标记供状态显示，不写入会话文件。
			this.stop(reason, { decision, extensionOverride });
			// 立即结束本次刷新。
			return;
		}

		// 允许warm后先记录覆盖状态。
		run.extensionOverride = extensionOverride;
		// 下面请求/记账/通知都属尽力而为，异常不影响主Agent。
		try {
			// 使用共享运行时发请求并等待结果。
			const message = await this.models
				// 重放同一model和context，不重新跑普通Agent工具循环。
				.streamSimple(run.model, run.context, {
					// 浅复制旧options，再用后面三项覆盖。
					...run.options,
					// 请求输出上限为1，不保证供应商实际只计费1token或绝对命中缓存。
					maxTokens: 1,
					// 本次禁用供应商重试，不改变主会话重试设置。
					maxRetries: 0,
					// 替换原signal为本保温run的独立取消信号。
					signal: run.controller.signal,
				})
				// result等待最终AssistantMessage，不把生成内容作为普通对话消息追加。
				.result();
			// 结果到达后再次核对，已被替换/取消的旧请求不记账。
			if (!this.validateRun(run)) return;
			// error/aborted不记录；length在这里允许，区别于完整摘要的拒绝规则。
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				// 把额外用量写入当前会话，可能同步写盘并抛。
				const entry = this.sessionManager.appendUsage(
					// usage类别cache_warm，避免伪造成assistant。
					"cache_warm",
					// 用响应提供商而非假定等于原选择。
					message.provider,
					// 若有实际responseModel优先它，否则响应model。
					message.responseModel ?? message.model,
					// 保存供应商/运行时已经提供的用量，不在此重算费用。
					message.usage,
					// 扩展强制warm时附说明，否则undefined。
					extensionOverride ? "extension override" : undefined,
				);
				// 有通知函数才调用；通知抛错同样落入此catch。
				this.onWarmed?.(entry);
			}
			// 网络/编码/记账/通知等失败被吞掉，不重新抛给主查询。
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		// 仍是同一run才续约；即使本次请求error/抛错也可能继续，不使用本次warm重置安全窗口。
		if (this.run === run) this.schedule(run);
	}

	// 检查本轮准入截止，未超返回false，超时则stop并返回true；例：等于deadline仍可继续。该时间可晚于30/60分钟调度窗口，且下游认证/路由后才真正发送；无finite校验，NaN比较会停止。
	private refreshDeadlineMissed(run: ActiveRun): boolean {
		// 本地当前时间不晚于截止就没错过。
		if (Date.now() <= run.refreshDeadlineAt) return false;
		// 错过时清活动并保存原因。
		this.stop("cache refresh deadline missed");
		// true表示调用方应结束本轮。
		return true;
	}

	// 核对对象身份、模式与上下文，返回是否可继续；例：旧run结果回来时只返回false，不停止已经替换的新run。isCurrent抛错会向外传。
	private validateRun(run: ActiveRun): boolean {
		// 引用身份而非内容比较，旧异步任务不能操作新run。
		if (this.run !== run) return false;
		// 先看模式原因；??短路使有模式原因时不用再运行isCurrent。
		const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
		// 没有原因才允许继续。
		if (!reason) return true;
		// 当前run失效才统一停止。
		this.stop(reason);
		// 向上层表示应退出。
		return false;
	}

	// 按实时模式给出停止原因或undefined，不清活动；例：idle阶段改streaming则不再保持空闲缓存。
	private getModeStopReason(run: ActiveRun): string | undefined {
		// 每次重新调用getMode，不读旧捕获值。
		const mode = this.getMode();
		// off总是停止理由。
		if (mode === "off") return "cache warming disabled";
		// streaming只保活原Agent活动期间，idle不能继续。
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		// 其他组合可继续，本函数不检查TTL或上下文。
		return undefined;
	}

	// 估算一次warm的经济性，返回新决策对象，不发请求；例：idle预期省款=0.15乘丢缓存差价减预热成本。使用当前分支最近assistant，未要求与原请求usage完全相同。
	private evaluate(run: ActiveRun): CacheWarmingDecision {
		// 取被预热模型的目录单价。
		const model = run.model;
		// 每次读取当前分支并扫描最近assistant，没有缓存这次扫描结果。
		const promptTokens = lastPromptTokens(this.sessionManager.getBranch());
		// 按全部提示词作为cacheRead估计命中价格。
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		// 估计丢缓存后重建提示词的成本。
		const cacheMissCost = price(
			// 仍按同一模型计价。
			model,
			// 有正cacheWrite单价就按写缓存，否则普通input；没有按long档另填cacheWrite1h。
			model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens },
		);
		// 预热假设全部缓存读加1输出token。
		const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
		// 额外损失最少为0，缓存反而贵也不算负损失。
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		// 运行中假设肯定还有请求，空闲采用固定15%。
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		// 提示词正数且读/丢缓存估价有一个正数才算有经济信息；不等于所有数都有效。
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		// 数学期望减本轮成本，不是实际已节省金额。
		const expectedSavings = continuationProbability * missCost - warmCost;
		// 组装完整展示数据。
		return {
			// 阶段从run读。
			phase: run.phase,
			// 预热费用简写。
			warmCost,
			// 额外丢缓存费用简写。
			missCost,
			// 概率简写。
			continuationProbability,
			// 预期节省额简写。
			expectedSavings,
			// 是否有经济信息简写。
			economicsAvailable,
			// 恰好达到0.05也warm；此动作仅比较数值，没有把economicsAvailable另加进条件。
			action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}

// 把美元数显示到小数3位，负号放在$前；例：-0.12显示-$0.120。无副作用，不是高精度财务运算。
function formatDollars(value: number): string {
	// toFixed做显示舍入，正负分支都固定3位；NaN/Infinity没有额外修正。
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

// 把决策经济性变成一段说明，返回string；例：闲时15%概率。只展示已有数字，不重新评估，也不用扩展覆盖后的动作重算期望。
function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	// 未知成本直接短说明。
	if (!decision.economicsAvailable) return "cache economics unavailable";
	// 概率乘100再四舍五入，无0..100钳制。
	const probability = Math.round(decision.continuationProbability * 100);
	// 按阶段选择说明文字。
	const probabilityText =
		// 比较字符串字面量。
		decision.phase === "streaming"
			? // 运行中额外说明当前Agent仍活动。
				`${probability}% continuation probability while agent is running`
			: // 空闲只显示概率。
				`${probability}% continuation probability`;
	// 按原建议动作选比较符，不重新计算threshold。
	const comparison = decision.action === "warm" ? ">=" : "<";
	// 模板串拼费用/阈值，都是3位小数。
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

// 格式化下一决策倒计时；例：222000ms与now=0得到3m42s，没时间或已到期显示Decision now。只算文字，不启动计时器。
function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	// undefined或到期直接返回；NaN不会满足这些比较，可能最终显示NaNs。
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	// 向上取整到秒，防还有几毫秒时显示0秒。
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	// 算整小时。
	const hours = Math.floor(remainingSeconds / 3600);
	// %=把余秒原地更新为扣除整小时的余数。
	remainingSeconds %= 3600;
	// 从剩余秒算整分钟。
	const minutes = Math.floor(remainingSeconds / 60);
	// 最后秒数余数。
	const seconds = remainingSeconds % 60;
	// parts显式为字符串数组。
	const parts: string[] = [];
	// 有小时才加该段。
	if (hours > 0) parts.push(`${hours}h`);
	// 有分钟才加该段。
	if (minutes > 0) parts.push(`${minutes}m`);
	// 有秒或没任何段都要显示秒；保证合法零值不出现空说明。
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	// join空格拼接，不改变任何状态。
	return `Decision in ${parts.join(" ")}`;
}

/** One-line status for `/session`. */
// 为/session格式化一行状态，返回string，不检查真实缓存或控制预热；例：scheduled显示倒计时，refreshing显示Warming cache。now可注入作稳定展示。
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	// 读取已有决策，可能缺失。
	const decision = status.decision;
	// A decision is attached once pi (or an extension) acted on it; "inactive"
	// without one never got that far.
	// 没决策或停用且经济信息不足又无扩展覆盖时，展示简单Inactive。
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		// 原因仅null/undefined才回退unknown，空串仍原样。
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	// 有扩展覆盖时标记它，避免把Pi建议当实际执行。
	const details = status.extensionOverride
		? // 显示覆盖提示和原经济估算。
			`extension override, ${formatCacheWarmingEconomics(decision)}`
		: // 无覆盖时加箭头和Pi建议动作。
			`${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	// inactive且有可展示决策显示Stopped。
	if (status.state === "inactive") return `Stopped (${details})`;
	// refreshing不显示未来倒计时。
	if (status.state === "refreshing") return `Warming cache (${details})`;
	// 其余状态显示下一计划时间及说明。
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** One-line transcript text for persisted cache-warming usage. */
// 把已保存usage条目变成一句转录说明；例：带扩展备注时括号展示。只读entry，不重新计价或格式化全部token分项。
export function formatCacheWarmingUsage(entry: UsageEntry): string {
	// 真值note才加括号，空串不显示。
	const note = entry.note ? ` (${entry.note})` : "";
	// 先保留6位，再删除小数第3位之后末尾的0，最少留3位；不保证保留全部原精度。
	const cost = entry.usage.cost.total.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	// 返回已有总成本的展示，不代表此次调用执行了预热。
	return `Cache warmed${note}: $${cost}`;
}
