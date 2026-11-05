// A host's end of a link (§3, §22, 2b): the handshake, the link's codec, the checks of every message (skipped on a
// trusted link), the heartbeat, and messages handled in order while one waits for an asynchronous inflate; a protocol
// error closes the link.

// 文件导读
// 所属模块：packages/chord/src/link 的 Channel 层，位于裸 Link（字节通道）与 host/remote 协议处理之间。
// 职责与边界：负责 hello 握手、选择 Codec、解码后信封检查、心跳 ping/pong、异步处理期间的按序排队与释放，
// 以及协议错误统一上报并关闭链路。它不解释 hold/call 的业务含义，不管理流控窗口，不做 Part 解压本身
// （handler 返回 Promise 时只等待，不关心其内部在做什么）。
// 上游入口：host 构造 Link 后创建 Channel 并调用 start()；Link.onMessage 把整帧字节交给 #receive。
// 下游依赖：Link 的 send/onMessage/onClose；Codec 的 encode/decode；message.ts 的 checkMessage；
// data/internal.ts 的 PROTOCOL_VERSION；Context 传给 checkMessage 做遥测。
// 结果与错误流向：已检查的 Message 交给 ChannelHandler.message；opened/closed 通知生命周期。
// 任何解码/握手/schema/handler 异常都经 report 上报并关闭 Link；关闭后消息被丢弃，异步队列清空。
// 能力清单：
// - ChannelHandler：宿主必须实现的 opened/message/closed 回调接口。
// - ChannelOptions（内部类型）：codec、incarnation、calls、trusted、report。
// - ChannelState（内部类型）：greeting/open/closed 三态及各自数据。
// - Channel：公开类，提供 start/send/close/tick 与 peer/peerCalls/opened/closed 只读视图。
// 典型调用顺序：new Channel(link, handler, options, context) -> start()（发 hello、订阅消息/关闭）
// -> 对端 hello 到达 -> handler.opened() -> 收发业务消息；宿主定时器周期性调用 tick(now, pingMs, closeMs)。
// 示例：const channel = new Channel(link, handler, {
//         codec: binaryCodec, incarnation: "0123...", calls: 256, trusted: false, report: console.error,
//       }, context);
//       channel.start();
//       channel.send({ kind: "hold", hold: 1, type: "counter", version: 1, fingerprint: "0123456789abcdef", params: "...", address: { kind: "local", params: {} } });
//       // 握手完成前 send 会暂存；完成后按序发出。
// 建议阅读顺序：ChannelHandler 与 ChannelState 三态 -> 字段与构造函数 -> start/send/tick -> #receive/#handle
// -> #hold/#release（异步按序）-> #decode/#greet -> #failed/#closed。
import type { Context } from "../context/index.ts";
import { PROTOCOL_VERSION } from "../data/internal.ts";
import type { Link } from "./link.ts";
import { type Codec, checkMessage, type Message } from "./message.ts";

/** What the owner of a channel handles. */
// 宿主实现的生命周期回调。Channel 保证：
// - opened 只在收到合法 hello 后调用一次；
// - message 只收到握手完成后的业务消息（hello/ping/pong 已被 Channel 消费）；
// - closed 只调用一次（无论哪端先关）。
// 这是普通 interface，运行时不会检查对象是否真的实现了这些方法。
export interface ChannelHandler {
	/** The peer's `hello` arrived: the link is open. */
	// 链路已打开：此时 send 会直接写链路，不再排队。通常在这里启动引用/绑定流程。
	opened(): void;
	/**
	 * A checked message after the handshake (never `hello`, `ping` or `pong`). A throw is a protocol error. A promise
	 * (the message waits for an asynchronous inflate) holds every later message until it settles; a rejection is a
	 * protocol error too.
	 */
	// 处理一条已通过 schema（可信链路除外）的业务消息。返回 void 表示同步完成；
	// 返回 Promise 表示需要异步工作（例如等待 Part 解压），Channel 会暂停后续消息直到它 settle。
	// 同步 throw 或 Promise reject 都被视为协议错误，导致链路关闭。
	message(message: Message): void | Promise<void>;
	/** The link closed, from either end; called once. */
	// 链路关闭：清理该链路上的 hold/call 状态。Channel 已保证幂等，只调用一次。
	closed(): void;
}

/** What a channel is made with besides its link and handler. */
// 构造 Channel 的附加参数。readonly 只约束 TS，运行时不冻结对象。
type ChannelOptions = {
	// 该链路两端必须使用同一种 codec（binary 或 text），由 host 决定。
	readonly codec: Codec;
	/** This host's incarnation, sent in `hello`. */
	// 本 host 实例的 uuidv7，用于对端识别实例；必须在协议版本内唯一。
	readonly incarnation: string;
	/** How many concurrent calls this side accepts, sent in `hello`. */
	// 本端愿意接受的并发调用数（调用窗口 N），对端据此限制未完成 call。
	readonly calls: number;
	/** Skips the `MESSAGE` check (framing, the codec's decode and the owners' checks still run). */
	// 可信链路（如本机 IPC）跳过 checkMessage；codec 自身的结构检查与 owner 的业务检查仍然执行。
	readonly trusted: boolean;
	/** Where protocol errors go. */
	// 协议错误上报回调；Channel 调用后仍会关闭链路，report 不应抛错。
	readonly report: (error: unknown) => void;
};

/**
 * Where a channel stands: `greeting` until the peer's `hello`, with what this end sent meanwhile; `open` with the
 * peer's incarnation and call window.
 */
// 三态可辨识联合：
// - greeting：尚未收到对端 hello，queued 保存本端已编码但暂不能发的消息；
// - open：握手完成，peer 是对端 incarnation，calls 是对端允许的并发数；
// - closed：终态，所有后续 send 丢弃。
// kind 是运行时可读字段，switch/条件判断可收窄类型。
type ChannelState =
	| { readonly kind: "greeting"; readonly queued: Uint8Array[] }
	| { readonly kind: "open"; readonly peer: string; readonly calls: number }
	| { readonly kind: "closed" };

/**
 * One end of a link. It sends `hello { protocol, incarnation, calls }` first and nothing else until the peer's arrived
 * (its own messages wait). Every message is decoded by the link's codec and, unless the link is trusted, checked
 * against the message schema; a first message that is no `hello` of this codec, a second `hello`, another protocol
 * version, or a message failing a check closes the link and is reported. The heartbeat: every received message
 * stamps `lastReceived`; the host's timer calls `tick`, which pings a silent open link and closes a link silent for
 * too long (the handshake included); a `ping` is answered with `pong` at once. A message the handler handles
 * asynchronously holds the later ones, `ping` included, until it settles; they are handled in order then, and dropped
 * when the link closes meanwhile.
 */
// 链路一端的状态机。所有 # 字段都是真正的私有字段，外部无法访问或伪造；
// 实例方法通过 this 访问，回调统一用箭头函数或闭包绑定，避免丢失 this。
export class Channel {
	// 底层字节链路；Channel 只调用 send/onMessage/onClose/close。
	readonly #link: Link;
	// 两端约定的编解码器；构造时固定，之后不更换。
	readonly #codec: Codec;
	// 业务回调，由 host/remote 实现。
	readonly #handler: ChannelHandler;
	// 协议错误上报函数。
	readonly #report: (error: unknown) => void;
	// 是否跳过信封 schema 检查；只对可信传输（IPC）为 true。
	readonly #trusted: boolean;
	// 传给 checkMessage 的 Context，用于遥测计数与验证器缓存。
	readonly #context: Context;
	// 当前状态，初始为 greeting；queued 从空数组开始。
	#state: ChannelState = { kind: "greeting", queued: [] };
	/** When the last message arrived (`Date.now()`), or the channel was made. */
	// 最后收到消息的本地时间；tick 用它计算静默时长。构造时也算起点，因此握手超时会关闭。
	#lastReceived = Date.now();
	/** Whether a `ping` went out since the last received message. */
	// 自上次收到消息后是否已发过 ping；收到任何消息都会重置为 false，避免重复 ping。
	#pinged = false;
	/**
	 * Messages received while one is handled asynchronously, in order, and the index of the next to handle; `undefined`
	 * while none waits.
	 */
	// 异步处理期间的等待队列。queue 保存原始字节（尚未解码），next 是下一条待处理下标；
	// 使用对象而不是两个字段，便于一次性清空（#held = undefined）。
	#held: { queue: Uint8Array[]; next: number } | undefined;
	/** Whether a message is being handled asynchronously: the held ones wait. */
	// 当前是否有一个 handler Promise 尚未 settle；#release 循环中据此决定是否暂停。
	#waiting = false;
	// 预先编码好的 hello 字节；start 时直接发送，避免每次握手重新编码。
	readonly #hello: Uint8Array;

	// 构造只保存依赖并编码 hello，不发送、不订阅；start 才启动链路。
	// 这样调用方可以先完成 handler 的状态初始化，再开始接收消息。
	constructor(link: Link, handler: ChannelHandler, options: ChannelOptions, context: Context) {
		this.#link = link;
		this.#codec = options.codec;
		this.#handler = handler;
		this.#report = options.report;
		this.#trusted = options.trusted;
		this.#context = context;
		// hello 使用协议版本、实例 id 和本端调用窗口；编码后缓存。
		this.#hello = this.#codec.encode({
			kind: "hello",
			protocol: PROTOCOL_VERSION,
			incarnation: options.incarnation,
			calls: options.calls,
		});
	}

	/**
	 * Sends `hello` and starts listening: messages that arrived already are handled now, and a link closed already
	 * calls `closed` now; so the handler is complete before it starts.
	 */
	// 启动链路：先发 hello，再订阅消息与关闭事件。
	// 顺序很重要：LinkEnd 会缓存订阅前收到的消息，start 前到达的帧不会丢失，随后按序回放。
	// 若链路已经关闭，onClose 会立即调用 #closed，handler 仍能收到一次通知。
	start(): void {
		this.#link.send(this.#hello);
		// 箭头函数保留 this；Link.onMessage 的回调签名是 (bytes: Uint8Array) => void。
		this.#link.onMessage((bytes) => this.#receive(bytes));
		this.#link.onClose(() => this.#closed());
	}

	/** The peer's incarnation, from its `hello`; empty before it arrived (nothing else can arrive before it). */
	// 读取对端实例 id；未握手时返回空串而不是抛错，方便调用方在 opened 之前安全探测。
	// 三元表达式根据状态 kind 收窄，只有 open 分支能访问 peer 字段。
	get peer(): string {
		return this.#state.kind === "open" ? this.#state.peer : "";
	}

	/** How many concurrent calls the peer accepts, from its `hello`; 0 before it arrived. */
	// 对端声明的并发调用窗口；未握手时为 0，调用方应据此暂缓发 call。
	get peerCalls(): number {
		return this.#state.kind === "open" ? this.#state.calls : 0;
	}

	// 是否已完成握手；open 是唯一可收发业务消息的状态。
	get opened(): boolean {
		return this.#state.kind === "open";
	}

	// 是否已关闭；关闭是终态，不会回到 greeting/open。
	get closed(): boolean {
		return this.#state.kind === "closed";
	}

	/** Sends one message; before the handshake it waits, after the close it is dropped. */
	// 发送一条消息：关闭后静默丢弃；greeting 阶段编码后暂存（等 hello 完成再发）；
	// open 阶段直接写链路。编码异常不在这里捕获，由调用方/上层处理。
	// 注意：暂存的是编码后的字节，因此 codec 只需执行一次。
	send(message: Message): void {
		// 先保存状态引用：后面 await/回调不涉及，但可避免重复属性读取；
		// 且 state.kind 的收窄在局部变量上更稳定。
		const state = this.#state;
		if (state.kind === "closed") return;
		const bytes = this.#codec.encode(message);
		// greeting 的 queued 是可变数组（类型上 readonly 仅对外），push 合法。
		if (state.kind === "greeting") state.queued.push(bytes);
		else this.#link.send(bytes);
	}

	// 主动关闭底层链路；Link 负责通知 onClose，最终进入 #closed。
	// 重复调用由 Link 自身幂等处理。
	close(): void {
		this.#link.close();
	}

	/**
	 * The heartbeat, at `now`: a link silent for `close` ms (the handshake included) closes; an open one silent for
	 * `ping` ms sends one `ping`.
	 */
	// 心跳检查，由宿主定时器驱动（slice 规范：15s ping、30s close）。
	// now 是调用方的单调时间戳；silent 是距最后收到消息的毫秒数。
	// 超过 close：直接关闭，不再发 ping；超过 ping 且尚未 ping 且已握手：发一个 ping。
	// 握手阶段不发送 ping，只受 close 超时约束。
	tick(now: number, ping: number, close: number): void {
		const silent = now - this.#lastReceived;
		if (silent >= close) this.close();
		else if (silent >= ping && !this.#pinged && this.#state.kind === "open") {
			// 先置标志再发送，避免同一静默期重复 ping；收到任何消息后 #receive 会重置。
			this.#pinged = true;
			this.#link.send(this.#codec.encode({ kind: "ping" }));
		}
	}

	// 收到一整帧字节。关闭后直接丢弃；否则刷新心跳时间与 ping 标志。
	// 如果当前没有异步等待，立即处理；否则只入队，保持到达顺序。
	// 注意：这里只记录 Date.now()，不使用 tick 的 now，两者用途不同。
	#receive(bytes: Uint8Array): void {
		if (this.#state.kind === "closed") return;
		this.#lastReceived = Date.now();
		this.#pinged = false;
		if (this.#held === undefined) this.#handle(bytes);
		else this.#held.queue.push(bytes);
	}

	/** Handles one received message; one the handler handles asynchronously holds the next until it settles. */
	// 处理一条消息：greeting 阶段只接受 hello；open 阶段解码、检查、消费 ping/pong，其余交给 handler。
	// 所有同步异常（解码失败、二次 hello、schema 不符、handler 同步抛错）统一进入 #failed。
	#handle(bytes: Uint8Array): void {
		const state = this.#state;
		try {
			if (state.kind === "greeting") {
				// 握手消息单独处理；成功后状态变 open 并回放暂存消息。
				this.#greet(bytes, state.queued);
				return;
			}
			const message = this.#decode(bytes);
			// 握手后再次收到 hello：协议错误。
			if (message.kind === "hello") throw new Error("handshake: a second hello");
			// Control of the link itself, never queued behind the window.
			// ping 立即回 pong，不交给 handler，也不占用调用窗口；但若前面有异步处理的消息，它仍按到达顺序等待。
			if (message.kind === "ping") this.#link.send(this.#codec.encode({ kind: "pong" }));
			// pong 只用于证明对端存活（#receive 已刷新时间），无需业务处理。
			else if (message.kind !== "pong") {
				const handling = this.#handler.message(message);
				// undefined 表示同步处理完成；返回 Promise 则进入异步排队模式。
				if (handling !== undefined) this.#hold(handling);
			}
		} catch (error) {
			// 任何异常都是协议错误：上报并关闭。
			this.#failed(error);
		}
	}

	/** Holds later messages until `handling` settles, then handles them in order (each may hold again). */
	// 进入异步等待：创建/复用队列，置 waiting，然后等待 Promise。
	// then 的第二个参数处理 rejection：转成协议错误；成功则清除 waiting 并释放队列。
	// 这里不 return Promise，调用方（#handle）无需等待。
	#hold(handling: Promise<void>): void {
		// ??= 仅在 #held 为 undefined 时赋新对象；嵌套异步处理时复用同一队列。
		this.#held ??= { queue: [], next: 0 };
		this.#waiting = true;
		handling.then(
			() => {
				this.#waiting = false;
				this.#release();
			},
			(error: unknown) => this.#failed(error),
		);
	}

	/**
	 * The held message was handled: the ones behind it are handled in order, until one holds again (the handled ones are
	 * dropped from the queue then).
	 */
	// 释放等待队列：逐条处理已到达的消息。每处理一条可能再次进入异步等待（#waiting=true），
	// 此时把已处理的前缀 splice 掉、next 归零，然后返回；等下一次 settle 再继续。
	// 若链路在等待期间关闭，直接返回，队列随 #closed 清空。
	#release(): void {
		const held = this.#held;
		if (held === undefined) return;
		while (held.next < held.queue.length) {
			// 只有 open 状态才继续处理；greeting 不会出现队列（hello 在 #handle 直接处理）。
			if (this.#state.kind !== "open") return;
			// 先取下标再自增；! 断言下标在范围内（循环条件已保证）。
			this.#handle(held.queue[held.next++]!);
			if (this.#waiting) {
				// 新消息又触发了异步处理：丢弃已处理前缀，避免队列无限增长，保留未处理部分。
				held.queue.splice(0, held.next);
				held.next = 0;
				return;
			}
		}
		// 全部处理完：释放队列对象，之后的 #receive 走同步路径。
		this.#held = undefined;
	}

	/** A protocol error: reported, and the link closes. */
	// 统一错误出口：已关闭则忽略；否则上报一次并关闭链路。
	// 不在这里抛错，避免从事件回调中逃逸成未捕获异常。
	#failed(error: unknown): void {
		if (this.#state.kind === "closed") return;
		this.#report(error);
		this.close();
	}

	/** A message from its bytes, checked against the message schema unless the link is trusted. */
	// 解码并检查：codec.decode 负责帧结构，checkMessage 负责信封 schema；
	// 可信链路跳过后者（但仍经过 codec 的结构检查与 owner 的业务检查）。
	// codec.decode 或 checkMessage 抛错都会传播到 #handle 的 catch。
	#decode(bytes: Uint8Array): Message {
		const message = this.#codec.decode(bytes);
		return this.#trusted ? message : checkMessage(message, this.#context);
	}

	/** The first message: the peer's `hello` in this link's codec and protocol version. */
	// 握手：第一帧必须是本 codec 能解码的 hello，且协议版本一致。
	// 成功后：状态置 open，按顺序发送 greeting 期间暂存的本端消息，最后通知 handler.opened()。
	// 先发暂存消息再 opened，保证 opened 里发送的消息排在其后。
	// 解码失败用 Error 的 cause 保留原始错误，消息中带上 codec 名便于诊断。
	#greet(bytes: Uint8Array, queued: readonly Uint8Array[]): void {
		let message: Message;
		try {
			message = this.#decode(bytes);
		} catch (error) {
			throw new Error(`handshake: the first message is no ${this.#codec.name} message`, { cause: error });
		}
		if (message.kind !== "hello") throw new Error(`handshake: ${message.kind} before hello`);
		if (message.protocol !== PROTOCOL_VERSION) {
			throw new Error(`handshake: protocol ${message.protocol}, this host speaks ${PROTOCOL_VERSION}`);
		}
		// 进入 open：保存对端实例与调用窗口；此后 send 直接走链路。
		this.#state = { kind: "open", peer: message.incarnation, calls: message.calls };
		// 回放握手期间暂存的消息；它们已编码，顺序与 send 调用顺序一致。
		for (const bytes of queued) this.#link.send(bytes);
		this.#handler.opened();
	}

	// 链路关闭（任一端）：幂等切换到 closed，丢弃等待队列，通知 handler。
	// 不清空 #state.queued（对象被整体替换，旧状态由 GC 回收）。
	#closed(): void {
		if (this.#state.kind === "closed") return;
		this.#state = { kind: "closed" };
		this.#held = undefined;
		this.#handler.closed();
	}
}
