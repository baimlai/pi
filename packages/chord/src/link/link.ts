// Links (§3): an ordered, bidirectional channel of messages between two hosts, and the in-memory pair.

// 文件导读
// 所属模块：packages/chord/src/link 的传输抽象与进程内实现，是 Channel 之下、具体适配器之上的最小层。
// 职责与边界：定义 Link 的四个操作（send/onMessage/onClose/close），提供 LinkEnd 处理“监听器未安装时先排队、
// 关闭幂等、只保留一个监听器”的公共逻辑，以及基于 queueMicrotask 的 memoryLinkPair。
// 不负责编解码、握手、认证、重连、心跳；不复制字节，也不检查消息内容。
// 上游入口：Channel 调用 send/onMessage/onClose；host 用 memoryLinkPair 连接两个进程内端点。
// 下游依赖：浏览器的 queueMicrotask；ipc.ts 与 websocket.ts 都继承 LinkEnd。
// 结果与错误流向：send 无返回值；到达的消息在已安装监听器时同步交付，否则排队；关闭后交付被丢弃。
// 适配器自身不抛业务错误；监听器抛出的异常会沿调用栈传播（例如 IPC 事件回调中）。
// 能力清单：
// - Link：传输接口，适配器只需搬字节。
// - memoryLinkPair：创建双向连接的两个内存端点，消息下一微任务到达。
// - LinkEnd：导出给适配器继承的抽象基类，封装单监听器、早到队列与一次性关闭。
// - MemoryLink（内部）：内存端点，close 先关自己、下一微任务关对端。
// 典型调用顺序：host 取得 Link -> Channel.start() 先 send(hello) 再 onMessage/onClose
// -> 对端 send 的字节经微任务/事件到达 deliver -> Channel 处理。
// 示例：const [a, b] = memoryLinkPair();
//       b.onMessage((bytes) => console.log(bytes)); // 安装前到达的消息会先排队
//       a.send(new Uint8Array([1, 2]));             // 监听器在下一个微任务收到该数组
//       a.close();                                  // a 立即关闭，b 在下一个微任务关闭
// 建议阅读顺序：Link 接口 -> memoryLinkPair -> LinkEnd 的 onMessage/deliver/ended -> MemoryLink 的 send/close。

/** An ordered, bidirectional channel of `Uint8Array` messages between two hosts. Adapters only move bytes. */
// interface 只描述可替换的传输接口；Uint8Array 是一条完整消息的字节，不是对象状态或网络流的任意分片。
// 回调和 void 返回值也只在开发期约束实现；认证、协议检查和重连属于上面的 host/Channel。
export interface Link {
	/** Sends one message; a no-op once closed. */
	// 发送一整条消息（不是流式分片）。关闭后实现应静默忽略，不抛错。
	// 例：link.send(new Uint8Array([1, 2]))；调用后不要修改该数组，适配器可能延迟发送。
	send(message: Uint8Array): void;
	/**
	 * Sets the one listener for incoming messages; messages that arrived earlier are delivered to it first. On a closed
	 * link it is not kept.
	 */
	// 安装唯一的接收监听器；只有一份，重复调用会替换。安装前到达的消息由实现缓存并在此按序回放。
	// 关闭后调用不保存监听器，避免继续持有闭包。例：link.onMessage((bytes) => channel.receive(bytes))。
	onMessage(listener: (message: Uint8Array) => void): void;
	/** Closes both ends; messages not delivered yet are dropped. */
	// 关闭链路（可能连带关闭对端）；尚未交付的排队消息被丢弃。实现应保证幂等。
	close(): void;
	/** Sets the one listener for the close of either end; it runs at once when the link is closed already. */
	// 安装唯一的关闭监听器；若链路已经关闭，立即同步调用一次。例：link.onClose(() => log("closed"))。
	onClose(listener: () => void): void;
}

/** Two ends of one link: what one sends, the other receives asynchronously (a microtask later), in order. */
// 无参数地创建互相连接的两个内存端点，返回固定两项元组 [a,b]；只分配对象，不建立网络连接。
// 例如 a.send(new Uint8Array([1])) 后，b 的监听器在下一次微任务收到同一个数组引用；调用者应按约定不再修改它。
export function memoryLinkPair(): [Link, Link] {
	// 两次 new 分别建立各自的监听器、队列和关闭状态。
	const a = new MemoryLink();
	const b = new MemoryLink();
	// 双向指针使每个端点都能把消息交给另一端。
	a.peer = b;
	b.peer = a;
	// 数组解构 const [a,b] = memoryLinkPair() 可给调用方命名两端。
	return [a, b];
}

/**
 * What every link end shares: the one message listener (messages that arrived before it are queued for it), the one
 * close listener, and closing once. Subclasses move the bytes: `deliver` what arrived, `ended` when the transport
 * closed, and implement `send` and `close`.
 */
export abstract class LinkEnd implements Link {
	// abstract 类不能直接 new；implements 让 TS 检查它满足 Link。# 是运行时私有字段，外部不能读取。
	#closed = false;
	// (message)=>void 是函数类型；| undefined 表示还没有安装监听器。
	#listener: ((message: Uint8Array) => void) | undefined;
	/** Messages that arrived before the listener was set. */
	#queued: Uint8Array[] = [];
	#closeListener: (() => void) | undefined;

	// 子类必须实现实际发送和关闭；这里的抽象签名不会产生默认运行逻辑。
	abstract send(message: Uint8Array): void;

	abstract close(): void;

	// 只读取本端是否结束，没有副作用；例如关闭后 end.closed 为 true。get 让调用方按属性访问。
	get closed(): boolean {
		return this.#closed;
	}

	// 安装或替换唯一消息监听器，并同步交付此前排队的消息；返回 void，不捕获监听器抛出的异常。
	// 例如先 deliver 两条再 onMessage，会按顺序立刻调用两次；第一条回调若关闭端点，第二条丢弃。
	onMessage(listener: (message: Uint8Array) => void): void {
		// A closed end delivers nothing: keeping the listener would keep its owner.
		// 已结束时既不回放，也不保存新回调，避免继续持有其闭包对象。
		if (this.#closed) return;
		// 后来的到达使用这个新回调；替换旧回调不会清空消息队列。
		this.#listener = listener;
		// A listener may close the link: what is still queued then is dropped.
		// splice(0) 取走所有排队消息再循环，回调中的新到达不会混进这份回放数组。
		for (const message of this.#queued.splice(0)) {
			// 每条回放前重查状态，因为上一次 listener 调用可能已关闭链路。
			if (this.#closed) return;
			// 直接调用，不复制字节；回调异常会向调用 onMessage 的代码传播。
			listener(message);
		}
	}

	// 设置唯一关闭监听器；关闭后安装则同步通知，未关闭则保存到 ended，返回 void。
	// 例如 end.close(); end.onClose(fn) 会立即执行 fn；本方法不会再打开端点。
	onClose(listener: () => void): void {
		// 这里保存的是回调本身而非执行结果；else 只在仍开着时运行。
		if (this.#closed) listener();
		else this.#closeListener = listener;
	}

	/** A message arrived; dropped once closed. */
	// 子类交入一条收到的消息；无监听器先排队，有监听器同步转交，关闭后丢弃，没有返回值。
	// 例如 IPC 构造后立即收到 bytes，但 host 尚未 onMessage，bytes 会暂留队列；protected 仅允许类及子类调用。
	protected deliver(message: Uint8Array): void {
		// 每次到达都检查当前状态，已经排进微任务的旧消息也受此门禁约束。
		if (this.#closed) return;
		// 保存原数组引用，监听器安装后按入队顺序消费。
		if (this.#listener === undefined) this.#queued.push(message);
		// 已有监听器时不再增加一层异步调度；传输适配器决定到达时机。
		else this.#listener(message);
	}

	/** Closes this end (once): nothing is delivered any more, and nothing the listeners reach is kept. */
	// 幂等结束本端：先标记关闭并释放队列/回调引用，再通知旧关闭监听器；不直接操作对端传输。
	// 例如 error 和 disconnect 连续到达仍只通知一次；监听器若抛错，此时清理和 closed=true 已经完成。
	protected ended(): void {
		// 重复结束不再次执行用户回调。
		if (this.#closed) return;
		this.#closed = true;
		// 临时保存回调，才能先解除字段引用再通知。
		const listener = this.#closeListener;
		// 释放消息与监听器的闭包引用，允许其可达对象被垃圾回收。
		this.#listener = undefined;
		this.#closeListener = undefined;
		this.#queued = [];
		// ?.() 只在回调存在时调用；这里并不吞掉它抛出的异常。
		listener?.();
	}
}

/**
 * One end of a memory link. Closing it closes this end at once and the peer a microtask later, as a transport would.
 * Portable: `queueMicrotask` only.
 */
// 内存链路的一端。由 memoryLinkPair 成对创建并互相接线；
// 消息通过 queueMicrotask 异步到达，模拟真实传输的“不会在 send 调用栈内同步回调”行为。
class MemoryLink extends LinkEnd {
	// peer 可在结束时清空；类型允许 undefined，发送前由工厂接线的约定保证它存在。
	peer: MemoryLink | undefined;

	// 把 bytes 原引用安排给对端的微任务，返回 void；例如连续 send(1),send(2) 保持微任务先后顺序。
	// 本端已关时不安排工作；微任务执行时对端若已关，其 deliver 仍会丢弃这条消息。
	send(message: Uint8Array): void {
		if (this.closed) return;
		// ! 是 TS 非空断言，运行时不会检查；先捕获对端使后续 close 清空 peer 不影响已排的回调。
		const peer = this.peer!;
		// 箭头函数捕获 peer/message；没有复制 Uint8Array，也不使用 Node 特有 API。
		queueMicrotask(() => peer.deliver(message));
	}

	// 无参数地同步关本端、下一微任务关对端；返回 void。例如 a.close() 后 a 立即关闭，b 稍后收到关闭通知。
	close(): void {
		// 幂等调用不会额外排入对端关闭任务。
		if (this.closed) return;
		const peer = this.peer!;
		// 先清除自己的 peer，再结束；对端指针由下面微任务清除。
		this.#end();
		queueMicrotask(() => peer.#end());
	}

	// 清除对端引用，再执行父类公共清理；无输入/返回值。例如双端关闭后不再通过 peer 互相保活。
	#end(): void {
		this.peer = undefined;
		this.ended();
	}
}
