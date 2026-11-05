// 定义MCP传输的共同接口与事件订阅底座。McpClient只依赖这些接口，stdio、HTTP和内存传输负责各自I/O并继承事件分发；本文件本身不建立连接。
// 消息类型在JS中擦除，toError则是实际使用的异常规范化函数；类型声明不自动验证外部消息。
import { type JsonRpcMessage, toError } from "../protocol/jsonrpc.ts";

// 公共默认单条消息上限为16MiB，即16×1024×1024字节；这里只导出数字，具体stdio/SSE如何计数由各实现负责，内存传输没有自动套用这个上限。
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

// 消息监听器的函数类型，输入一条消息；void表示调用方不用返回值，不意味着会自动等待或捕获async回调。
export type McpTransportMessageListener = (message: JsonRpcMessage) => void;
// 错误监听器接收已规范化的Error，仍可能在执行时抛异常。
export type McpTransportErrorListener = (error: Error) => void;
// 关闭监听器不带参数；关闭原因通常另经错误或请求拒绝通道传递。
export type McpTransportCloseListener = () => void;

// 一次send的可选控制数据；这是TS接口契约，不是自动执行的取消器。
export interface McpTransportSendOptions {
	/**
	 * Aborted once the sender no longer waits for a reply (the request was cancelled, timed out, answered,
	 * or the client closed). A transport must not dispatch the message after that, for example when
	 * retrying it after an authorization refresh. It does not undo a message already dispatched.
	 */
	// 可选signal用于阻止等待/认证恢复后的迟到派发，不负责回滚已发送的请求。HTTP实现会检查它；当前stdio和内存send没有读取这个选项，不能仅凭接口宣称每个实现都落实了该规则。
	signal?: AbortSignal;
}

// 传输层约定：启动、发送、关闭、订事件及可选版本设置。implements只在TS开发期核对方法兼容，不会生成I/O或校验逻辑。
export interface McpTransport {
	// 启动传输并返回完成Promise，例如stdio会启动子进程；接口没有保证各实现都能重复启动。
	start(): Promise<void>;
	// 发送单条JSON-RPC消息，输入消息与可选控制数据，Promise表示实现定义的发送完成/失败；不等于等待远端工具执行结果，那由McpClient.pending管理。
	send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void>;
	// 关闭传输的异步入口；具体等待子进程、关闭HTTP会话或通知对端的行为由实现决定。
	close(): Promise<void>;
	// 订阅消息并返回退订函数；类型() => void表示无参清理动作。
	onMessage(listener: McpTransportMessageListener): () => void;
	// 订阅错误事件并返回退订函数，不代表错误必会导致连接关闭。
	onError(listener: McpTransportErrorListener): () => void;
	// 订阅关闭事件并返回退订函数；底座只抑制重复emitClose，不在晚订阅时补发旧事件。
	onClose(listener: McpTransportCloseListener): () => void;
	// ?使这个方法可省略；输入协商版本，例如HTTP用于后续请求头，方法本身是同步void而非Promise。
	setProtocolVersion?(version: string): void;
}

/** Listener bookkeeping shared by transports. `emitClose` fires at most once per transport. */
// 抽象基类只管理监听器和关闭事件去重，不实现McpTransport的start/send/close；abstract禁止TS正常直接new，子类可继承后调用protected分发方法。
export abstract class TransportEvents {
	// Set按函数引用保存消息监听器，同一个函数重复加入只存一份；private是TS访问限制，不是#运行时私有字段。
	private messageListeners = new Set<McpTransportMessageListener>();
	// 错误监听器独立成组，不与消息监听器混合。
	private errorListeners = new Set<McpTransportErrorListener>();
	// 关闭监听器组，收到事件时同步逐个调用。
	private closeListeners = new Set<McpTransportCloseListener>();
	// 记录关闭事件是否已开始分发，初始false；它不代表底层资源一定已释放完。
	private closeEmitted = false;

	// 注册消息回调并返回退订函数，输入listener，无I/O；例：const off=t.onMessage(m=>log(m)); off()。回调只在子类emitMessage时执行，注册时不回放旧消息。
	onMessage(listener: McpTransportMessageListener): () => void {
		// 将函数加入Set，不深复制函数或创建包装回调，相同引用会去重。
		this.messageListeners.add(listener);
		// 返回捕获listener的删除闭包；delete的实际布尔结果可被JS观察到，但公开void类型不要求使用它。
		return () => this.messageListeners.delete(listener);
	}

	// 注册错误回调并返回清理函数，输入listener，无I/O；例：onError(e=>log(e.message))。仅登记，不发送/关闭；回调异常由下方emitError原样向外传播。
	onError(listener: McpTransportErrorListener): () => void {
		// 加入错误监听集合，按函数引用去重。
		this.errorListeners.add(listener);
		// 返回只删除本次函数引用的清理闭包，不清掉其他错误监听器。
		return () => this.errorListeners.delete(listener);
	}

	// 注册关闭回调并返回退订函数，输入listener，无I/O；例：onClose(()=>showOffline())。如果关闭已发生，注册动作仍只加Set，不立即补调。
	onClose(listener: McpTransportCloseListener): () => void {
		// 保存关闭回调；不检查closeEmitted，因此晚注册的回调也会留在Set中。
		this.closeListeners.add(listener);
		// 返回清理该函数的闭包，不能借它重新打开已关闭的传输。
		return () => this.closeListeners.delete(listener);
	}

	// 把一条消息同步分给当前监听器，无返回值、不作协议验证或克隆；例：HTTP解码后调用它。protected允许子类使用，普通外部TS代码不能直接调用。
	// 没有捕获回调异常；一个同步throw会中断循环，async回调的Promise也不等待。
	protected emitMessage(message: JsonRpcMessage): void {
		// 直接遍历活Set，回调中增删监听可影响本轮遍历；不是先复制快照，所有监听器拿到同一个message引用。
		for (const listener of this.messageListeners) listener(message);
	}

	// 将未知错误规范为Error后同步广播，无返回值，不自动关闭；例：子类emitError("bad")让回调收到Error("bad")。toError或监听器自己抛错会向外传播，没有统一兜底。
	protected emitError(error: unknown): void {
		// 已有Error原样返回，其他值先String再包装；对象自定义字符串转换可能抛错，不在这里脱敏。
		const normalized = toError(error);
		// 直接遍历活错误Set，不捕获单个回调错误，也不await回调返回值；没有监听器就无人接收这个事件。
		for (const listener of this.errorListeners) listener(normalized);
	}

	// 发出至多一次关闭事件，无参数/返回；例：子类连续调用两次，只有第一次开始通知。它不替代实际close，也不清监听器；中途回调抛错会中断剩余通知且后续调用不会补发。
	protected emitClose(): void {
		// 已记录发过关闭事件则直接返回，避免正常关闭流程重复通知。
		if (this.closeEmitted) return;
		// 先把标记置true再调用回调，回调中重入emitClose也会被挡住。
		this.closeEmitted = true;
		// 同步遍历活Set调用关闭回调，不传原因、不做快照/异常捕获；监听器可能自行增删或抛错。
		for (const listener of this.closeListeners) listener();
	}
}
