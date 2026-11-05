// WebSocket links (§3): a link over a WebSocket, the browser's or `ws` in Node, typed structurally; binary frames,
// messages sent while it still connects buffered until it opens.

// 文件导读
// 所属模块：packages/chord/src/link 的 WebSocket 传输适配器，同时兼容浏览器 WebSocket 与 Node 的 ws 包。
// 职责与边界：把现成 socket 包装成 Link；每条消息一个 ArrayBuffer 二进制帧；连接期间 send 的消息先入队，
// open 后按序发送；文本帧（非本协议）直接关闭链路。不拨号、不重连、不握手认证。
// 上游入口：调用方自己 new WebSocket(url) 后传入 webSocketLink(socket)；host 再把 Link 交给 Channel。
// 下游依赖：LinkEnd 的排队/关闭逻辑；WebSocket 的 addEventListener/removeEventListener/send/close/readyState。
// 结果与错误流向：socket 的 close/error 只结束一次；send 同步抛错会关闭链路；主动 close 先结束本端再 socket.close；
// 连接中关闭时 ws 可能发出 error，监听器保留到 socket 自身 close，避免未处理错误结束进程。
// 能力清单：
// - WebSocketLike：结构化 socket 接口，只声明链路需要的成员。
// - webSocketLink：公开工厂，返回 Link。
// - WebSocketLink（内部类）：管理连接期队列、事件订阅、发送与幂等清理。
// 典型调用顺序：new WebSocket(url) -> webSocketLink(socket) -> Channel.start()（hello 可能在连接期入队）
// -> open 事件回放 -> 后续帧直接发送。
// 示例：const socket = new WebSocket("wss://example.test/chord");
//       const link = webSocketLink(socket); // readyState=0 时 hello 会等 open
//       channel.start();
// 建议阅读顺序：WebSocketLike 接口 -> webSocketLink -> 构造器（readyState 分支与事件注册）-> #onOpen/#onMessage
// -> send/close -> #end。

import { type Link, LinkEnd } from "./link.ts";

/** The part of a WebSocket a link uses (the browser's `WebSocket`, `ws`'s `WebSocket`). */
// 结构接口同时容纳浏览器 WebSocket 和 Node ws；readonly 只限制 TS 赋值，状态仍由传输更新。
// message.data 是外部 unknown，必须在运行时区分 ArrayBuffer；Uint8Array<ArrayBuffer> 排除了共享内存底层。
export interface WebSocketLike {
	/** 0 connecting, 1 open, 2 closing, 3 closed. */
	// 构造器据此决定：0 要排队等 open，1 可直接发送，2/3 直接得到关闭端点。
	readonly readyState: number;
	// 接收帧类型；构造器设为 "arraybuffer"，使二进制帧的 event.data 是 ArrayBuffer。
	binaryType: string;
	/** Typed as the browser's `WebSocket` takes bytes: on an `ArrayBuffer`, never shared memory. */
	// 发送一个二进制帧；参数限定为底层为 ArrayBuffer 的 Uint8Array（排除 SharedArrayBuffer）。
	send(data: Uint8Array<ArrayBuffer>): void;
	// 请求关闭 socket；实际 close/error 事件随后由传输触发。
	close(): void;
	// 注册无参数事件；open/close/error 的监听器不接收事件对象。
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
	// 注册消息事件；data 声明为 unknown，必须运行时判断类型。
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	// 移除无参数事件监听器；必须传与注册相同的函数引用。
	removeEventListener(type: "open" | "close" | "error", listener: () => void): void;
	// 移除消息监听器；清理时停止交付。
	removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

const CONNECTING = 0;

const OPEN = 1;

/**
 * A link over `socket`, one binary frame per message (`binaryType = "arraybuffer"`). Messages sent while it connects
 * wait for `open`; a socket closing or closed already gives a closed link; `close` and `error` close the link once, and
 * so does a text frame (no message of this protocol). A frame above the transport's `maxPayload` closes the socket
 * (code 1009), which closes the link.
 */
// 包装现成 socket 并订阅事件，返回 Link，不拨号、不握手认证。
// 例如 new WebSocket(url) 尚在连接时包装它，早发的 hello 会存到 open 事件后发送；文本帧会关闭链路。
export function webSocketLink(socket: WebSocketLike): Link {
	// 构造器设置 binaryType 并处理连接中/已关闭状态；对外只给 Link 接口。
	return new WebSocketLink(socket);
}

class WebSocketLink extends LinkEnd {
	/** The socket while the link is open. */
	// 私有 socket 引用只在链路开放时存在；清空后 send/close 不再碰传输。
	#socket: WebSocketLike | undefined;
	/** Messages sent while the socket connects; `undefined` once it is open. */
	// 数组表示仍等 open 的发送队列；undefined 表示无需再等待或已结束。
	#connecting: Uint8Array[] | undefined;
	// open 回调把连接期的消息依次交回 send；不返回值，箭头函数保留实例 this。
	// 例如 hello、hold 先后入队，开放后仍按该顺序发送；某次 send 关闭链路后其余 send 会跳过。
	readonly #onOpen = (): void => {
		// ?? 仅在 undefined/null 时用空数组；这里先取出旧队列供本次回放。
		const queued = this.#connecting ?? [];
		// 先离开连接期，否则 send 回放又会重新入队；关闭清理也使用这个赋值丢弃待发消息。
		this.#connecting = undefined;
		// 逐条使用统一发送路径，不展开成函数参数，也不改变字节数组内容。
		for (const message of queued) this.send(message);
	};
	// 处理一帧外部消息：ArrayBuffer 建成 Uint8Array 视图并交付，其他类型关闭；无返回值。
	// 例如文本 "hello" 不是本协议字节，else 会 close；readonly 只限制本代码重写 event.data。
	readonly #onMessage = (event: { readonly data: unknown }): void => {
		// 这是 socket 输入边界检查；new Uint8Array(ArrayBuffer) 共享底层字节，不复制消息。
		if (event.data instanceof ArrayBuffer) this.deliver(new Uint8Array(event.data));
		// 拒绝文本/其他非 ArrayBuffer 帧；这里操作的是传输，不做 MESSAGE schema 检查。
		else this.close();
	};
	// socket 报错时无参数地清理链路；不会向外抛异常，底层 error 监听器保留到 socket 自身 close。
	readonly #onError = (): void => this.#end();

	// 接收现成 socket 并安装事件/连接期队列；副作用是改 binaryType，返回新实例。
	// 例如 readyState=3 时直接标记关闭，状态 0 则等 open；不在构造器发 Chord 消息。
	constructor(socket: WebSocketLike) {
		// 先初始化父类的关闭状态和接收队列。
		super();
		// 只有连接中(0)和已开放(1)可用；关闭中(2)、已关闭(3)直接结束。
		if (socket.readyState !== CONNECTING && socket.readyState !== OPEN) {
			// 父类标记关闭并清理接收队列/回调；构造器路径还未保存 socket。
			this.ended();
			// 提前结束 void 逻辑，不继续注册或发送。
			return;
		}
		// 保存开放/连接中的原 socket，后续发送和清理共享它。
		this.#socket = socket;
		// 要求接收事件用 ArrayBuffer 给二进制帧，供 #onMessage 的运行时分支识别。
		socket.binaryType = "arraybuffer";
		// 仅为尚未开放的 socket 分配发送等待队列并监听 open。
		if (socket.readyState === CONNECTING) {
			// 空数组本身就标记连接期，第一条待发消息会 push 进去。
			this.#connecting = [];
			// open 到来时回放连接期消息；#end 会解除这一监听器。
			socket.addEventListener("open", this.#onOpen);
		}
		// 立即接收帧；外部尚未 onMessage 的帧交由父类排队。
		socket.addEventListener("message", this.#onMessage);
		// `error` and `close` stay handled until the socket's own close, after this end closed: `ws` emits an `error`
		// for a socket closed while it connects, and an unhandled one would end the process.
		// 底层 close 事件回调无输入/返回值；移除 close/error 自身监听，再幂等清理端点。
		// 例如连接中主动 close 触发 ws 的 error，监听器仍在，直到实际 close 才解除，避免未处理错误。
		const onClose = (): void => {
			// 用命名局部函数引用解除自己的 close 监听，释放其闭包。
			socket.removeEventListener("close", onClose);
			// 实际关闭后才停止吸收 error；主动 #end 不提前移除此监听。
			socket.removeEventListener("error", this.#onError);
			// 停止交付/发送并清除队列，已清理时直接返回。
			this.#end();
		};
		// 注册底层最终关闭通知；与 error 都可能触发，但端点只结束一次。
		socket.addEventListener("close", onClose);
		// 防止传输错误无人接收；协议错误是否报告由 Channel 层决定。
		socket.addEventListener("error", this.#onError);
	}

	// 发送完整字节帧：连接中先排队，已清理跳过，socket.send 抛错则关闭；不返回状态。
	// 例如 open 前发送 hello 只 push，open 后经此方法实际 socket.send；没有自动重连或重试。
	send(message: Uint8Array): void {
		// 取当前传输引用，清理时即使清空字段仍可用这个局部引用执行 close。
		const socket = this.#socket;
		// 已结束时不再注册、发送或重复关闭传输。
		if (socket === undefined) return;
		// 数组存在表示还没等到 open，不能直接发帧。
		if (this.#connecting !== undefined) {
			// 暂存原 Uint8Array 引用，等待 open；调用者必须遵循消息不再被修改的约定。
			this.#connecting.push(message);
			// 提前结束 void 逻辑，不继续注册或发送。
			return;
		}
		// 把底层发送同步异常转换成链路关闭。
		try {
			// A link's messages are codec output or received frames, both on plain `ArrayBuffer`s.
			// as 是开发期断言，不复制或转换数组；此处依赖 codec 输出/接收帧都来自普通 ArrayBuffer 的内部约定。
			socket.send(message as Uint8Array<ArrayBuffer>);
			// 发送失败无法继续本连接，走统一主动关闭路径。
		} catch {
			// 清理端点并要求底层 socket 关闭，没有自动重发。
			this.close();
		}
	}

	// 主动丢弃本端队列并要求 socket 关闭，返回 void；例如重复 close 因字段已清空而跳过。
	// 先 #end 再 socket.close，关闭监听器里重入 send 也不会发新帧；底层 close 抛错不会被这里捕获。
	close(): void {
		// 取当前传输引用，清理时即使清空字段仍可用这个局部引用执行 close。
		const socket = this.#socket;
		// 已结束时不再注册、发送或重复关闭传输。
		if (socket === undefined) return;
		// 停止交付/发送并清除队列，已清理时直接返回。
		this.#end();
		// 要求底层关闭，实际 close/error 事件仍由构造器安装的监听器接收直到最终关闭。
		socket.close();
	}

	/** Stops listening for frames, drops what waits to be sent and closes this end. */
	// 结束本端但不再次调用 socket.close：清引用、解除 open/message、通知父类；无输入/返回值。
	// 例如 error 先到，端点马上不可用，close/error 两个底层监听器仍留到真正 close。
	#end(): void {
		// 取当前传输引用，清理时即使清空字段仍可用这个局部引用执行 close。
		const socket = this.#socket;
		// 已结束时不再注册、发送或重复关闭传输。
		if (socket === undefined) return;
		// 先阻止后续发送，也切断端点对 socket 的直接引用。
		this.#socket = undefined;
		// 先离开连接期，否则 send 回放又会重新入队；关闭清理也使用这个赋值丢弃待发消息。
		this.#connecting = undefined;
		// 不再回放连接期队列。
		socket.removeEventListener("open", this.#onOpen);
		// 不再向已结束的端点投递新帧。
		socket.removeEventListener("message", this.#onMessage);
		// 父类标记关闭并清理接收队列/回调；构造器路径还未保存 socket。
		this.ended();
	}
}
