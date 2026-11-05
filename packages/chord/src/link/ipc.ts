// IPC links (§3): a link over a Node IPC channel, a forked child (`fork` with `serialization: "advanced"`) or
// `process` in the child, typed structurally so Chord imports nothing from Node.

// 文件导读
// 所属模块：packages/chord/src/link 的 Node IPC 传输适配器，用于父子进程之间的可信链路。
// 职责与边界：把 ChildProcess/process 的消息与断开事件包装成 Link；每条消息一个 Uint8Array。
// 不做 fork、不做协议握手、不认证对端；非 Uint8Array 消息（例如应用自己的启动对象）直接跳过。
// 上游入口：host 在父进程对 child 调用 ipcLink(child)，或在子进程对 process 调用 ipcLink(process)。
// 下游依赖：LinkEnd 的排队/关闭逻辑；Node 的 EventEmitter 方法（on/removeListener）与 send(message, callback)。
// 结果与错误流向：send 的同步抛错、callback 非 null 错误、disconnect 事件都会关闭本端；
// 关闭后重复 send/close 是无操作。close 会先结束本端，再在端口仍 connected 时 disconnect。
// 能力清单：
// - IpcPort：结构化端口接口（send/on/removeListener/disconnect/connected），兼容 ChildProcess 与 process。
// - ipcLink：把端口包装成 Link 的公开工厂。
// - IpcLink（内部类）：订阅 message/disconnect、过滤 Uint8Array、处理发送回调与关闭清理。
// 典型调用顺序：父进程 fork(..., { serialization: "advanced" }) -> ipcLink(child) -> Channel.start()
// -> 子进程 ipcLink(process) -> Channel.start()；两端各自订阅，互发字节帧。
// 示例：const link = ipcLink(child);            // 父进程
//       const childLink = ipcLink(process);    // 子进程
//       channel.send(bytes);                  // 经 child.send(bytes, cb) 传输；返回 false 只是背压
// 建议阅读顺序：IpcPort 接口 -> ipcLink 工厂 -> IpcLink 的字段与构造器 -> send/close -> #end。

import { type Link, LinkEnd } from "./link.ts";

/**
 * The part of a Node IPC channel a link uses: a `ChildProcess` or the child's `process`. `send` returning `false` is
 * backpressure (the message is queued by Node), not a failure.
 */
// IpcPort 是结构类型：只要 ChildProcess 或 process 提供这些成员就可传入，不要求继承特定类。
// unknown 表示 IPC 还可能收到应用自己的启动对象；它们必须由下面的运行时 instanceof 区分。
export interface IpcPort {
	// 发送一个 Uint8Array；callback 在 Node 完成排队/发送后调用，error 非 null 表示失败。
	// 返回 false 只表示内部缓冲已满（背压），不是错误；Node 仍会保留消息。
	send(message: Uint8Array, callback: (error: Error | null) => void): boolean;
	// 订阅消息事件；listener 参数声明为 unknown，因为端口还可能送来应用自己的对象。
	on(event: "message", listener: (message: unknown) => void): unknown;
	// 订阅断开事件；连接消失时触发，无参数。
	on(event: "disconnect", listener: () => void): unknown;
	// 移除消息监听器；必须与注册时传同一个函数引用。
	removeListener(event: "message", listener: (message: unknown) => void): unknown;
	// 移除断开监听器；关闭清理时使用。
	removeListener(event: "disconnect", listener: () => void): unknown;
	// 主动断开 IPC 通道；对已断开的端口调用可能触发 Node 错误事件，调用前应查 connected。
	disconnect(): void;
	// 端口当前是否仍连接；构造器与 close 用它避免无效操作。
	readonly connected: boolean;
}

/**
 * A link over `port`: each message one `Uint8Array` (V8 serialization keeps it one). It listens from the moment it is
 * made and queues messages until its listener is set, so a child makes it before awaiting its start message; messages
 * that are no `Uint8Array` (the app's own, such as that start message) are not the link's and are skipped. A thrown
 * `send`, an error in its callback or `disconnect` closes the link once; its listeners are removed then.
 */
// 把现有 IPC 端口包装为 Link；返回新端点并立刻订阅消息/断开，不 fork 进程，也不认证调用方。
// 例如父进程 fork(...,{serialization:"advanced"}) 后传 child；启动对象被跳过，Uint8Array 才交给链路监听器。
export function ipcLink(port: IpcPort): Link {
	// 构造器处理已经断开的端口；对外返回 Link 类型，只暴露收发和关闭方法。
	return new IpcLink(port);
}

class IpcLink extends LinkEnd {
	/** The port while the link is open. */
	// 私有字段保存开放端口；undefined 是已经脱离传输的状态，防止关闭后继续 send。
	#port: IpcPort | undefined;
	// 收到一条外部 IPC 消息时执行；箭头函数固定 this，readonly 使注册和移除使用同一回调引用。
	// 例如应用的 {start:...} 不处理；只有实际 Uint8Array 才传给父类的排队/交付逻辑，无返回值。
	readonly #onMessage = (message: unknown): void => {
		// 这是 IPC 输入信任边界的运行时检查；TypeScript 的 unknown 本身不会筛选消息。
		if (message instanceof Uint8Array) this.deliver(message);
	};
	// 断开事件无输入，调用统一清理，返回 void；例如子进程退出触发它，重复事件不重复通知关闭。
	readonly #onDisconnect = (): void => this.#end();
	// Node 完成发送后回调：null 表示没有报告发送错误，否则结束此链路；不返回发送结果。
	// 例如端口在 send 期间退出，异步错误走这里，send 自身同步抛错则走下面 catch。
	readonly #onSent = (error: Error | null): void => {
		// 只看回调错误，不把 send 返回 false 的背压当失败。
		if (error !== null) this.#end();
	};

	// 接收现成 IPC 端口，初始化父类并马上监听；无显式返回值，不创建新进程。
	// 例如 child.connected 已为 false 时直接得到关闭的 Link；否则等待后续 message/disconnect 事件。
	constructor(port: IpcPort) {
		// 派生类先初始化 LinkEnd 的关闭状态和队列，之后才能使用 this。
		super();
		// 保存原端口引用供发送和移除监听器使用。
		this.#port = port;
		// 端口的当前连接状态是运行时传输状态；已经断开就不安装监听器。
		if (!port.connected) {
			// 统一清理自己的端口引用和监听器，再执行 LinkEnd 的幂等关闭通知。
			this.#end();
			// 提前结束当前 void 方法，不继续注册、发送或断开。
			return;
		}
		// 从构造时开始接收字节；host 尚未安装监听器时 LinkEnd 会暂存。
		port.on("message", this.#onMessage);
		// 订阅传输断开，关闭路径会用相同函数引用解除订阅。
		port.on("disconnect", this.#onDisconnect);
	}

	// 发送一条完整字节消息，没有返回值；关闭后跳过，发送同步/异步报错都结束链路。
	// 例如 Node 返回 false 仅表示积压，本方法仍让 Node 保留发送队列，不重复发送。
	send(message: Uint8Array): void {
		// 捕获当前端口；后面的清理即便把字段清空，此局部变量仍能用于必要的断开操作。
		const port = this.#port;
		// 已清理的链路不再操作端口，使重复 send/close 成为无操作。
		if (port === undefined) return;
		// 仅包住 Node 的发送调用；错误通过关闭链路表示，不从 send 向调用方重抛。
		try {
			// 把同一 Uint8Array 交给 Node，异步完成由 #onSent 处理；布尔返回值有意不用。
			port.send(message, this.#onSent);
			// 同步发送异常也走统一关闭路径，catch 不需要保留异常值。
		} catch {
			// 统一清理自己的端口引用和监听器，再执行 LinkEnd 的幂等关闭通知。
			this.#end();
		}
	}

	// 主动关闭包装端点并在端口仍连接时 disconnect；返回 void，不 kill 子进程。
	// 例如调用两次 close，第二次因 #port 已空而直接返回；端口断开后对端也会收到 disconnect。
	close(): void {
		// 捕获当前端口；后面的清理即便把字段清空，此局部变量仍能用于必要的断开操作。
		const port = this.#port;
		// 已清理的链路不再操作端口，使重复 send/close 成为无操作。
		if (port === undefined) return;
		// 统一清理自己的端口引用和监听器，再执行 LinkEnd 的幂等关闭通知。
		this.#end();
		// Disconnecting a channel that is gone already would emit an error.
		// 先检查实时状态，避免对已断开的 IPC 通道再次 disconnect 导致 Node 错误事件。
		if (port.connected) port.disconnect();
	}

	/** Detaches from the port and closes this end. */
	// 从端口移除本适配器的两个监听器并结束端点；无参数/结果，可由所有错误路径重复调用。
	// 例如异步错误随后又收到 disconnect，父类 ended 保证只通知一次。
	#end(): void {
		// 捕获当前端口；后面的清理即便把字段清空，此局部变量仍能用于必要的断开操作。
		const port = this.#port;
		// 先解除字段对端口的引用，阻止关闭回调里重入发送。
		this.#port = undefined;
		// ?. 只在端口存在时移除消息监听器，不影响应用自己注册的其他监听器。
		port?.removeListener("message", this.#onMessage);
		// 移除同一断开回调，防止已结束适配器被端口继续保留。
		port?.removeListener("disconnect", this.#onDisconnect);
		// 父类清空待收消息和回调，设置 closed 并通知关闭监听器。
		this.ended();
	}
}
