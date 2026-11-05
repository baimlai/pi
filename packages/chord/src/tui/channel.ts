// The sandbox's side of the bridge (slice 11 §4): one dispatcher of the launcher's messages (input, resizes, link
// sockets, replies), requests with their replies, and Chord links whose bytes the launcher relays to the server.
// 中文说明：本文件实现沙箱侧的桥接通道。上游是 runtime.ts 创建的 SandboxChannel；下游是启动器的
// launcher/pipe 代码，以及 Chord 客户端 host（它通过 RelayLink 收发字节）。
// 所有状态都留在当前沙箱进程内：请求等待表、socket 表、输入/尺寸监听集合；不写磁盘、不直接联网。
// 所属：tui 沙箱侧桥接层，把 bridge.ts 的消息词汇表变成可调用 API，并实现 Chord 链路中继。
// 边界：只在本进程内维护等待表和监听器，不编码帧、不建 WebSocket；拒绝回答转成 Error 交给调用方。
// 上游：runtime.ts 构造 SandboxChannel；下游：startClient 的 open/fetchScript/serverBase/outdated，以及 BridgeTerminal 的输入/尺寸订阅。
// 导出清单：RelayEvents 描述链路事件；SandboxChannel 负责请求、输入、尺寸与 socket；RelayLink 是 LinkEnd 的中继实现。
// 组合：takeBridge → new SandboxChannel → openSocket(RelayLink) → startClient；request 由 #settle 按 id 完成。
// 示例：const channel = new SandboxChannel(bridge); const base = await channel.request({ kind: "base" });
// 阅读顺序：RelayEvents → SandboxChannel 字段/构造 → 公共方法 → #dispatch/#settle → RelayLink。

import { LinkEnd } from "../link/link.ts";
import type { Bridge, BridgeRequest, BridgeStart, LauncherMessage } from "./bridge.ts";
import { splitFrames } from "./frames.ts";

/** What one relayed socket reports: it opened, a frame arrived. */
// 一条经启动器中继的 socket 对 RelayLink 的两个回调：连接真正打开时一次，每收到一帧时一次。
// 例如连接循环在 opened 后才认为链路可用；received 用来记录最近收帧时间以判断连接是否陈旧。
export type RelayEvents = { opened(): void; received(): void };

/** The sandbox's bridge: requests, relayed sockets, and the terminal's input and resizes. */
// 沙箱与启动器之间的中枢：把启动器消息分派给请求、socket、输入和尺寸监听者，并提供主动请求方法。
// 构造时传入 Bridge 并立即订阅消息；此后所有方法都是同步登记或发送，request 返回 Promise 等待 reply。
export class SandboxChannel {
	// #bridge：底层桥对象，所有发送都经过它；#replies 以请求 id 保存 resolve/reject。
	// #sockets 以本类分配的 socket 编号保存 RelayLink；#input/#resize 是应用监听器集合。
	// #next 同时为请求和 socket 分配递增编号；两者存在不同 Map 中，编号相同也互不影响。
	readonly #bridge: Bridge;
	readonly #replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly #sockets = new Map<number, RelayLink>();
	readonly #input = new Set<(data: string) => void>();
	readonly #resize = new Set<(columns: number, rows: number) => void>();
	#next = 0;

	// 订阅启动器消息；构造后立即可以接收 input/reply。回调只做分派，不执行长时间工作。
	constructor(bridge: Bridge) {
		this.#bridge = bridge;
		bridge.onMessage((message) => this.#dispatch(message));
	}

	/** What the launcher told at the start. */
	// 启动时启动器给出的固定信息：基础包摘要、尺寸、颜色能力与深浅模式。
	get start(): BridgeStart {
		return this.#bridge.start;
	}

	/** Asks the launcher; rejects with its refusal. */
	// 向启动器提出一个机器操作请求，返回其回答；启动器拒绝时以 Error 拒绝（错误文本来自启动器）。
	// 例如 request({ kind: "copy", text: "x" }) 在用户确认后 resolve 为布尔值（调用方按约定断言）。
	// 每次调用先分配 id 并登记 Promise 执行器，再发送；没有超时和取消机制。
	request(request: BridgeRequest): Promise<unknown> {
		const id = ++this.#next;
		return new Promise((resolve, reject) => {
			this.#replies.set(id, { resolve, reject });
			this.#bridge.send({ kind: "request", id, request });
		});
	}

	/** Runs the registered scripts `text` (named `filename` in stacks) through the sandbox's own evaluation. */
	// 在沙箱上下文中执行注册脚本正文；startTerminalRuntime 用它跑初始合并文件和后来下载的单个脚本。
	evaluate(text: string, filename: string): void {
		this.#bridge.evaluate(text, filename);
	}

	/** Writes `data` to the terminal, in frames the launcher takes (`splitFrames`). */
	// 把终端输出拆成安全帧后逐条发送；切点不会落在转义序列或代理对中间。
	write(data: string): void {
		for (const frame of splitFrames(data)) this.#bridge.send({ kind: "write", data: frame });
	}

	/** Tells the launcher this sandbox's code is outdated. */
	// 告知启动器当前基础包已过期；启动器负责启动新沙箱，本对象不自行退出。
	outdated(): void {
		this.#bridge.send({ kind: "outdated" });
	}

	/** Ends the terminal with `code`. */
	// 请求启动器以给定退出码结束终端；发送后本端仍可产生消息，直到进程实际结束。
	exit(code: number): void {
		this.#bridge.send({ kind: "exit", code });
	}

	/** Calls `listener` with each input (keys, pastes) until the returned removal. */
	// 订阅原始输入文本，返回移除函数；多个监听器按 Set 插入顺序同步调用。
	onInput(listener: (data: string) => void): () => void {
		this.#input.add(listener);
		return () => this.#input.delete(listener);
	}

	/** Calls `listener` at each resize until the returned removal. */
	// 订阅尺寸变化，返回移除函数；参数是本次 resize 报告的新列数和行数。
	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resize.add(listener);
		return () => this.#resize.delete(listener);
	}

	/** Opens a socket to the server's links endpoint through the launcher: its link, reporting to `events`. */
	// 经启动器打开一条到服务器 links 端点的 socket，返回可当作 Chord Link 使用的 RelayLink。
	// 编号复用 #next；打开前发送的字节由 RelayLink 缓冲，收到 socket_opened 后再发出。
	openSocket(events: RelayEvents): RelayLink {
		const socket = ++this.#next;
		const link = new RelayLink(socket, events, this.#bridge, () => this.#sockets.delete(socket));
		this.#sockets.set(socket, link);
		this.#bridge.send({ kind: "socket_open", socket });
		return link;
	}

	/** One message of the launcher, to whom it is for. */
	// 分派一条启动器消息。switch 按 kind 收窄联合类型；各分支 return，最后三种回复类型共享 #settle。
	#dispatch(message: LauncherMessage): void {
		switch (message.kind) {
			case "input":
				for (const listener of this.#input) listener(message.data);
				return;
			case "resize":
				for (const listener of this.#resize) listener(message.columns, message.rows);
				return;
			case "socket_opened":
				this.#sockets.get(message.socket)?.opened();
				return;
			case "socket_message":
				this.#sockets.get(message.socket)?.received(message.bytes);
				return;
			case "socket_closed":
				this.#sockets.get(message.socket)?.dropped();
				return;
			// reply/attached/refused 都回答某个请求 id，交给同一个结算函数；没有 default 是因为联合类型已穷尽。
			case "reply":
			case "attached":
			case "refused":
				this.#settle(message);
		}
	}

	/** Settles the request a reply or refusal answers. */
	// 结算一个等待中的请求：先删除等待项，避免重复回复；找不到说明请求已结束或 id 不属于本端，静默忽略。
	// 参数用 Extract 从 LauncherMessage 中挑出三种回复类型，调用点无需再写联合。
	#settle(message: Extract<LauncherMessage, { kind: "reply" | "attached" | "refused" }>): void {
		const waiting = this.#replies.get(message.id);
		this.#replies.delete(message.id);
		// 先删后结算：同一 id 的第二次回复不会再次影响 Promise；?. 让迟到回复安全无效。
		if (message.kind === "reply") waiting?.resolve(message.value);
		// attached 仅用于 attach 请求，包装成 TerminalRuntime 的 AttachedFile 形状。
		else if (message.kind === "attached") waiting?.resolve({ name: message.name, bytes: message.bytes });
		// 其余（refused）统一转成 Error；消息文本来自启动器/用户，只用于展示。
		else waiting?.reject(new Error(message.message));
	}
}

/** A Chord link over a socket the launcher holds: bytes relayed both ways, buffered until the socket opened. */
/** 经启动器中继的 Chord 链路端点：发送写到 socket_send，收到 socket_message 时交付；连接完成前先缓冲。
 * 继承 LinkEnd 复用“只关闭一次、消息/关闭监听器”的约定，只实现传输部分。 */
export class RelayLink extends LinkEnd {
	// #socket：启动器分配的 socket 编号；#events：连接循环关心的 opened/received 回调。
	// #bridge：发送 SandboxMessage 的桥；#forget：从 SandboxChannel 的 socket 表移除自己。
	// #connecting：socket 尚未打开时的发送缓冲；undefined 表示已打开，可以直接发送。
	readonly #socket: number;
	readonly #events: RelayEvents;
	readonly #bridge: Bridge;
	readonly #forget: () => void;
	/** Messages sent while the socket connects; `undefined` once open. */
	#connecting: Uint8Array[] | undefined = [];

	constructor(socket: number, events: RelayEvents, bridge: Bridge, forget: () => void) {
		super();
		this.#socket = socket;
		this.#events = events;
		this.#bridge = bridge;
		this.#forget = forget;
	}

	// 关闭后丢弃；连接中先入缓冲，打开后按原顺序补发，避免 WebSocket 握手前丢消息。
	send(message: Uint8Array): void {
		if (this.closed) return;
		if (this.#connecting !== undefined) this.#connecting.push(message);
		else this.#bridge.send({ kind: "socket_send", socket: this.#socket, bytes: message });
	}

	// 先通知启动器关闭远端，再结束本端；dropped 幂等（LinkEnd.ended 只执行一次）。
	close(): void {
		if (this.closed) return;
		this.#bridge.send({ kind: "socket_close", socket: this.#socket });
		this.dropped();
	}

	/** The launcher's socket opened: what was sent meanwhile goes out. */
	// 启动器确认 socket 打开：切换为直发模式，通知循环，再补发缓冲。
	// 先取走缓冲并清空 #connecting，补发过程中新 send 会直接走 socket，不再进入旧数组。
	opened(): void {
		const queued = this.#connecting ?? [];
		this.#connecting = undefined;
		this.#events.opened();
		for (const message of queued) this.send(message);
	}

	/** A frame arrived. */
	// 每帧先通知循环（更新最近收帧时间），再交给 LinkEnd.deliver 排队或转交 host。
	received(bytes: Uint8Array): void {
		this.#events.received();
		this.deliver(bytes);
	}

	/** The socket closed (either side): the link ends. */
	// 任一端关闭：从表中移除并结束本端；不再次发送 socket_close，避免与发起方重复。
	dropped(): void {
		this.#forget();
		this.ended();
	}
}
