// The connection loop (slice 11 §2, decision "Slice 11, P6"; p2's `keepConnected`): a client keeps one link to the
// server and replaces it when it ends. After a drop it reconnects after a growing pause (250 ms doubling to 5 s; a
// connection that stayed open 10 s resets it), at once on a wake (visible again, back online, network changed); it
// replaces an open socket silent past the server's ping interval on a wake, gives up a socket not open after 20 s, and
// stops when the app's `canRetry` says no (an outdated client, a guest's ended share). The environment (time, timers,
// wakes) is given, so the same loop runs in a page and in a terminal's sandbox.

//
// 文件导读
// 所属：packages/chord 的 surfaces 层，实现客户端连接循环 keepConnected。
// 职责边界：管理一条链路从建立、打开、断线到退避重连的全过程，并在设备唤醒时提前重试或检查陈旧 socket；
// 它不打开 socket、不解析帧内容，也不决定业务是否应继续。平台差异（时钟、定时器、online、wake）由调用方注入，
// 因此浏览器页面和终端沙箱可共用同一循环。
// 上游入口：keepConnected(options)；client.ts 的 connect() 是主要调用者。下游依赖：options.open 返回的 LoopLink，
// 以及 onState/canRetry/environment 回调。
// 结果与错误：返回 { stop }；连接状态经 onState 报告。canRetry reject 被视为 true（未知错误时继续尝试）；
// open 或回调抛出的异常没有被本文件捕获，会沿调用栈传播。stop 幂等，并关闭当前链路。
// 能力清单：
// - RETRY_INITIAL_MS/RETRY_MAX_MS/STABLE_MS/CONNECT_TIMEOUT_MS/STALE_MS/WAKE_GRACE_MS：退避、稳定期、连接超时、
//   心跳陈旧判定和唤醒宽限的常量。
// - ConnectionState：界面可见的连接状态联合（connecting/connected/waiting）。
// - SocketEvents：socket 向循环报告的 opened/received 事件。
// - LoopLink：循环需要的最小链路接口（onClose/close）。
// - LoopEnvironment：注入的 now/after/online/onWake。
// - LoopOptions：open/onState/canRetry/environment。
// - keepConnected：创建并启动 Loop，返回 stop。
// - Attempt（私有）：一次尝试的链路、开始/打开时间、最后收帧时间与超时取消函数。
// - Loop（私有）：状态机，方法为 connect/stop/#closed/#schedule/#wake。
// 组合与典型顺序：keepConnected → new Loop → connect → open → opened/received → close → #closed → canRetry →
// #schedule → connect；wake 可在等待期立即重试，或在连接打开后安排陈旧检查。
// 示例：`const loop = keepConnected({ open: (events) => webSocketLink(url, events),
//   onState: setBadge, canRetry: async () => !guestEnded, environment: browserEnvironment() });`
// 阅读顺序：常量 → ConnectionState/SocketEvents/LoopLink/LoopEnvironment/LoopOptions → keepConnected →
// Attempt/Loop 字段 → connect → #closed → #schedule → #wake。

/** The first retry pause after a failed or short-lived connection: 250 ms, doubling from there. */
// 第一次重试等待 250ms；之后按指数增长（250、500、1000...），由 #schedule 计算。
export const RETRY_INITIAL_MS = 250;

/** The longest retry pause: 5 s (and the pause while offline). */
// 退避上限 5 秒；离线时也直接使用这个最长等待，避免无意义地频繁尝试。
export const RETRY_MAX_MS = 5000;

/** A connection that stayed open this long counted as working: the next retry starts at the initial pause again. */
// 连接打开超过 10 秒才算“稳定”，断线后失败计数清零；否则视为短命连接，继续加大退避。
export const STABLE_MS = 10_000;

/** A socket not open after this long is given up (browsers have no handshake timeout). */
// 浏览器 WebSocket 没有握手超时；20 秒仍未 opened 就主动关闭，让循环进入下一轮。
export const CONNECT_TIMEOUT_MS = 20_000;

/** The server's heartbeat pings every 15 s: an open socket silent for longer than this is presumed dead on a wake. */
// 服务器每 15 秒心跳；唤醒后若超过 25 秒没收到任何帧，就假定连接已死并替换。
export const STALE_MS = 25_000;

/** After a wake, messages held while the client was frozen get this long to arrive before the socket is judged. */
// 唤醒后至少等 1 秒再判断陈旧：冻结期间排队的消息可能还没送到，过早关闭会误杀健康连接。
export const WAKE_GRACE_MS = 1000;

/** The connection as the app shows it: an attempt under way, open, or waiting for the next attempt. */
// 三个状态是互斥的字符串字面量联合；应用可直接用于 UI。connecting 包括尚未 opened 的超时窗口。
export type ConnectionState = "connecting" | "connected" | "waiting";

/** What one socket reports to the loop. */
// socket 适配层只上报两个事件；opened 每个链路至多一次，received 每收到一帧调用一次（包括心跳）。
export interface SocketEvents {
	// 握手完成且链路可发送消息。
	opened(): void;
	/** Any frame: the server's pings keep an open socket from looking silent. */
	// 任意入站帧都刷新最后活动时间，防止服务器心跳被误判为静默。
	received(): void;
}

/** One attempt's connection as the loop sees it: it closes once, and closing it ends it at once. */
// 循环对链路的最小要求：能注册关闭回调、能主动关闭。它不关心 send/onMessage，避免和协议层耦合。
export interface LoopLink {
	// 注册关闭监听；具体实现应保证只通知一次。
	onClose(listener: () => void): void;
	// 主动关闭；随后应有 onClose 通知（或实现自行处理）。
	close(): void;
}

/** What the loop runs in: the clock, timers, whether the device is online, and its wake events. */
// 环境抽象：把时间、定时器、在线状态和唤醒源注入进来，循环本身不直接访问 window/navigator 或 Node API。
export interface LoopEnvironment {
	// 单调或墙钟时间均可，只要同一环境内一致；单位毫秒。
	now(): number;
	/** Runs `callback` after `ms`; returns its cancel. */
	// 定时器；返回取消函数，循环在 stop 或重新调度时调用它。
	after(ms: number, callback: () => void): () => void;
	/** `false` when the device is known to be offline. */
	// 仅当明确离线时返回 false；未知状态应返回 true，让正常退避继续。
	online(): boolean;
	/** Calls `listener` when the client may have been away (visible again, online, network changed); returns its removal. */
	// 唤醒可能由页面可见、网络恢复或网络切换触发；返回移除函数，stop 时必须调用。
	onWake(listener: () => void): () => void;
}

/** What the loop takes. */
// 循环参数。open 每次尝试调用一次，必须返回新的链路；onState/canRetry/environment 由调用方提供。
export type LoopOptions = {
	/** Opens one socket and its link; the socket reports to `events`. */
	// 建立一次连接。实现应把 open/message 事件转成 events.opened/received；返回的链路关闭时必须通知 onClose。
	readonly open: (events: SocketEvents) => LoopLink;
	// 每次状态变化同步调用：进入尝试时 connecting，握手后 connected，断开后 waiting（重试等待期）。
	readonly onState: (state: ConnectionState) => void;
	/** Asked after every close; `false` stops the loop. A rejection counts as `true` (unreachable, try again). */
	// 每次关闭后询问是否继续；false 永久停止。reject 视为 true，因为判断本身失败不应终止连接。
	readonly canRetry: () => Promise<boolean>;
	// 注入的时钟、定时器、在线状态与唤醒源。
	readonly environment: LoopEnvironment;
};

/** Keeps a client connected until `stop`. */
// 启动连接循环并返回停止句柄。创建后立即发起第一次连接，不等调用方再触发。
// stop 是幂等的：重复调用不会重复关闭链路；它不会等待异步的 canRetry 结果。
export function keepConnected(options: LoopOptions): { stop(): void } {
	const loop = new Loop(options);
	// 同步启动第一次尝试；open 可能是同步的，因此 onState("connecting") 会在本函数返回前发生。
	loop.connect();
	return { stop: () => loop.stop() };
}

/** One attempt: its link, when it started and opened, its last frame, its timeout's cancel. */
// 一次连接尝试的状态。每次 connect 创建新对象；#closed 用它判断回调是否来自当前尝试（旧尝试的迟到事件被忽略）。
// startedAt 记录尝试开始时间，当前实现未用它做判断；openedAt 为 undefined 表示仍在连接中。
// lastFrame 初始为开始时间，收到任意帧后刷新；cancelTimeout 在打开或关闭时取消 20 秒计时器。
type Attempt = {
	// 链路在 open 返回后才赋值；事件回调可能先于赋值触发，因此允许 undefined。
	link: LoopLink | undefined;
	// 尝试开始的时间（毫秒）。
	readonly startedAt: number;
	// 握手完成时间；undefined 表示未打开。
	openedAt: number | undefined;
	// 最近一次收到帧的时间；用于唤醒后的陈旧判断。
	lastFrame: number;
	// 取消连接超时定时器；初始为 no-op，open 返回后替换为真实取消函数。
	cancelTimeout: () => void;
};

// 连接循环本身。所有字段只在同步回调或 Promise 回调中修改；Node/浏览器单线程执行使这些状态无需锁。
// 生命周期：constructor 订阅唤醒 → connect 发起尝试 → opened/close 推进状态 → canRetry 决定是否 #schedule。
class Loop {
	// 初始参数，含 open/onState/canRetry。
	readonly #options: LoopOptions;
	// 环境引用，避免每次调用都穿过 #options。
	readonly #env: LoopEnvironment;
	// 移除唤醒监听；stop 时调用，防止已停止的循环被唤醒。
	readonly #removeWake: () => void;
	// 连续失败计数，用于指数退避；连接稳定关闭后按规则重置。
	#failures = 0;
	// 当前唯一一次尝试；undefined 表示没有连接（等待重试或已停止）。
	#current: Attempt | undefined;
	// 取消等待中的重试定时器；undefined 表示没有待执行的重试。
	#cancelRetry: (() => void) | undefined;
	// 取消陈旧检查定时器；同一时刻至多一个。
	#cancelStaleCheck: (() => void) | undefined;
	/** Between a close and `canRetry`'s answer; a wake meanwhile retries at once. */
	// 已断开、正在等待 canRetry 的异步答案；此期间到来的 wake 不能直接 connect，只能记下标志。
	#deciding = false;
	// 等待 canRetry 期间是否发生过 wake；答案允许重试时用它决定是否跳过退避立即连接。
	#wokeWhileDeciding = false;
	// stop 后 #schedule/#wake 路径会检查 #stopped；链路关闭仍进入 #closed，但不会再安排重连。
	#stopped = false;

	constructor(options: LoopOptions) {
		this.#options = options;
		this.#env = options.environment;
		// 订阅环境唤醒；回调只安排重试或检查，不直接阻塞。
		this.#removeWake = this.#env.onWake(() => this.#wake());
	}

	/** Starts an attempt. */
	// 发起一次连接尝试。副作用：设置 #current、onState("connecting")、调用 open、注册关闭监听并启动超时。
	// 边界：open 若同步抛错，本方法不捕获，异常会冒泡到 keepConnected/调用方。
	// 注意事件可能早于 attempt.link 赋值（open 内部同步回调）：opened 校验 #current 以忽略旧尝试，
	// received 只刷新自己闭包里的 attempt。
	connect(): void {
		// 新尝试开始，之前等待的重试计时器已执行或作废。
		this.#cancelRetry = undefined;
		const env = this.#env;
		// 创建本次尝试的状态对象；时间戳都取注入时钟。
		const attempt: Attempt = {
			link: undefined,
			startedAt: env.now(),
			openedAt: undefined,
			lastFrame: env.now(),
			cancelTimeout: () => {},
		};
		this.#current = attempt;
		this.#options.onState("connecting");
		// open 返回链路；events 回调可能在 open 内部同步触发。
		const link = this.#options.open({
			opened: () => {
				// 迟到的 opened 只属于旧尝试时忽略，避免把新尝试误标为已连接。
				if (this.#current !== attempt) return;
				attempt.openedAt = attempt.lastFrame = env.now();
				// 已打开就不需要 20 秒握手超时；取消计时器。
				attempt.cancelTimeout();
				this.#options.onState("connected");
			},
			received: () => {
				// 任意帧刷新活动时间；不校验 #current，旧尝试的迟到帧不会影响新尝试。
				attempt.lastFrame = env.now();
			},
		});
		attempt.link = link;
		// 连接超时：到点时仍未 opened 就关闭链路；关闭会触发 onClose → #closed，进入重试流程。
		attempt.cancelTimeout = env.after(CONNECT_TIMEOUT_MS, () => {
			if (attempt.openedAt === undefined) link.close();
		});
		// 关闭只处理一次；若链路在注册前已关闭，实现应立即回调。
		link.onClose(() => this.#closed(attempt));
	}

	/** Stops the loop and closes the current link. */
	// 停止循环。幂等：重复调用直接返回。顺序：置 stopped → 移除唤醒 → 取消重试定时器 → 关闭当前链路。
	// 关闭链路会触发 #closed，但 #stopped 已为 true，因此不会安排下一次尝试。
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#removeWake();
		this.#cancelRetry?.();
		this.#cancelRetry = undefined;
		// 可选链：等待期间没有链路时无需关闭。
		this.#current?.link?.close();
	}

	/** `attempt`'s link closed: asks `canRetry`, then schedules the next attempt. */
	// 链路关闭的统一入口。只处理当前尝试，旧尝试的迟到关闭被忽略。
	// 副作用：清理当前尝试与定时器，状态转 waiting，异步询问 canRetry，然后按答案决定是否调度。
	#closed(attempt: Attempt): void {
		if (this.#current !== attempt) return;
		this.#current = undefined;
		// 关闭后握手超时和陈旧检查都没有意义，全部取消。
		attempt.cancelTimeout();
		this.#cancelStaleCheck?.();
		this.#cancelStaleCheck = undefined;
		if (this.#stopped) return;
		this.#options.onState("waiting");
		const { openedAt } = attempt;
		// 打开超过 STABLE_MS 视为成功连接：清空失败计数，下次从 250ms 重新开始退避。
		if (openedAt !== undefined && this.#env.now() - openedAt >= STABLE_MS) this.#failures = 0;
		// 进入“等待 canRetry 答案”阶段；此期间的 wake 只能记标志，不能抢先连接。
		this.#deciding = true;
		this.#wokeWhileDeciding = false;
		const decided = (retry: boolean): void => {
			this.#deciding = false;
			// 只有允许重试才调度；wake 标志决定是否跳过退避。
			if (retry) this.#schedule(this.#wokeWhileDeciding);
		};
		// reject 也按 true 处理：无法判断时继续尝试；then 的第二个回调避免未处理拒绝。
		this.#options.canRetry().then(decided, () => decided(true));
	}

	/** Schedules the next attempt: at once (`now`), else after the backoff (offline: the longest pause). */
	// 安排下一次连接。backoff = min(5s, 250ms * 2^failures)，每次调度后 failures 加一。
	// 离线时直接用 5s，避免每次立刻失败；wake 的 online 事件会提前重试。
	// now 为 true（等待期间发生 wake）则延迟 0，但仍经过定时器，让当前调用栈先结束。
	#schedule(now: boolean): void {
		if (this.#stopped) return;
		const backoff = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** this.#failures);
		this.#failures += 1;
		// Offline an attempt fails at once; the `online` wake retries sooner than this.
		// 三目嵌套：优先 now（0），否则在线用退避，离线用最大等待。
		const delay = now ? 0 : this.#env.online() ? backoff : RETRY_MAX_MS;
		// 保存取消函数；connect 执行时会把它清空。定时器回调只调用 connect；stop 会先取消它，因此正常情况下不会在停止后触发。
		this.#cancelRetry = this.#env.after(delay, () => this.connect());
	}

	/** A wake: a pending retry runs now; an open socket silent too long is replaced once its overdue ping is checked. */
	// 处理设备唤醒。三种情况：
	// 1. 正在等待重试：取消等待，立即连接；
	// 2. 正在等 canRetry：记下 wake，答案返回时跳过退避；
	// 3. 已有打开的连接：不立即关闭，而是在应收到的服务器心跳到期后检查是否真的静默。
	#wake(): void {
		if (this.#cancelRetry !== undefined) {
			// 先取消旧定时器，避免它稍后再次 connect 造成并发尝试。
			this.#cancelRetry();
			this.connect();
			return;
		}
		if (this.#deciding) {
			// canRetry 的 Promise 还未 settle；不能在这里 connect，只能让 decided 使用该标志。
			this.#wokeWhileDeciding = true;
			return;
		}
		const attempt = this.#current;
		// A connecting attempt has its own timeout.
		// 尚在握手（openedAt undefined）的尝试由 CONNECT_TIMEOUT_MS 管理，wake 不干预。
		if (attempt?.openedAt === undefined) return;
		// 同一连接可能连续 wake；先取消旧的检查，再按最新活动时间重新安排。
		this.#cancelStaleCheck?.();
		// After a network change the socket looks fine until the server's next ping is missing: check when it is due.
		// 到期时间 = max(1s 宽限, 最后收帧 + 25s + 1ms - now)；+1 保证严格超过 STALE_MS 才算陈旧。
		const due = Math.max(WAKE_GRACE_MS, attempt.lastFrame + STALE_MS + 1 - this.#env.now());
		this.#cancelStaleCheck = this.#env.after(due, () => {
			this.#cancelStaleCheck = undefined;
			// 检查时确认仍是同一尝试，且静默时间严格超过阈值；否则说明期间已有新帧，保留连接。
			if (this.#current === attempt && this.#env.now() - attempt.lastFrame > STALE_MS) attempt.link?.close();
		});
	}
}
