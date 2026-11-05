// A link wrapper that counts what crosses it, per direction: frames by type and bytes (JSON text length). It can also
// hold back the acknowledgements its own side sends (`paused`), to fill the peer's flow-control window.
import type { Frame, Link } from "../../../src/old/index.ts";

// 实现 Link 接口的测试包装器：把帧转给 inner，同时记录调用者看见的帧与 JSON 字符长度。
// implements 只让 TypeScript 检查成员签名，不会在运行时检查传入对象。
export class CountingLink implements Link {
	// readonly 禁止重新赋值字段，不会冻结底层 Link 或数组内容。
	readonly inner: Link;
	/** Frames this side sent, in order. */
	readonly sent: Frame[] = [];
	/** Frames this side received, in order. */
	readonly received: Frame[] = [];
	// 这里的 bytes 实际按 JSON 字符串的 UTF-16 长度累计，不等于网络 UTF-8 字节数。
	sentBytes = 0;
	receivedBytes = 0;
	/** Acknowledgements are held back (the peer's window fills up). */
	paused = false;
	// # 是 JavaScript 私有字段；只保留最近一个被暂停的 ack，undefined 表示没有。
	#held: Frame | undefined;

	// 接收已建立的通道，只保存引用，不建立连接；例如 new CountingLink(up) 包住内存端点。
	constructor(inner: Link) {
		// 后续发送、关闭和事件注册都转交这个端点。
		this.inner = inner;
	}

	// 属性读取器：读取包装器.closed 时返回底层当前状态，不缓存，也不触发关闭。
	get closed(): boolean {
		// 透传底层的布尔关闭状态。
		return this.inner.closed;
	}

	// 发送一帧并返回底层报告的大小；暂停的 ack 返回 0，不进入计数。
	// 例如 paused=true 时 send(ack) 只保存最新确认，release 才透传它。
	send(frame: Frame): number | undefined {
		// 仅拦截确认帧；其他帧即使暂停也继续发送。t 标签还帮助 TypeScript 缩窄帧类型。
		if (frame.t === "ack" && this.paused) {
			// 覆盖先前待发确认，利用累计确认只需最新值的测试设定。
			this.#held = frame;
			// 报告此次没有实际传输，结束本次发送。
			return 0;
		}
		// 把原帧引用追加到发送历史，不复制帧。
		this.sent.push(frame);
		// 先序列化并累加字符数；若序列化或底层发送抛错，本函数也会抛出。
		this.sentBytes += JSON.stringify(frame).length;
		// 交给底层真正发送，保留它的 number 或 undefined 返回值。
		return this.inner.send(frame);
	}

	/** Lets the held acknowledgement through and stops holding them. */
	// 恢复确认传输，没有返回值；例如暂停期间有多个 ack 时，只发最后保存的一帧。
	release(): void {
		// 先恢复正常发送模式。
		this.paused = false;
		// 保存待发帧的局部引用，便于清空私有槽。
		const held = this.#held;
		// 先清槽，避免这份待发状态继续保留帧。
		this.#held = undefined;
		// 有确认才直接发给 inner；绕过本包装器，所以该确认不补入 sent 或 sentBytes。
		if (held !== undefined) this.inner.send(held);
	}

	// 注册唯一收帧回调并包装统计；例如收到 state 时先计入 received，再调用调用者 handler。
	receive(handler: (frame: Frame) => void): void {
		// 底层收到帧时执行此闭包，frame 类型由 Link.receive 的签名推断。
		this.inner.receive((frame) => {
			// 按回调顺序保存收到的原帧。
			this.received.push(frame);
			// 按与发送相同的 JSON 字符长度口径累计接收量。
			this.receivedBytes += JSON.stringify(frame).length;
			// 统计完成后调用原回调；其异常不在此处捕获。
			handler(frame);
		});
	}

	// 把关闭监听器透传给底层；reason 是底层提供的原因字符串，无新增状态或返回值。
	onClose(handler: (reason: string) => void): void {
		// 真正注册在 inner 上，因此通知规则遵循底层实现。
		this.inner.onClose(handler);
	}

	// 请求关闭底层通道；可省略原因，例如 close() 使用底层默认原因。
	close(reason?: string): void {
		// 原因原样透传，本包装器不额外生成关闭帧。
		this.inner.close(reason);
	}

	/** Frames of type `t` this side sent (`sent`) or received (`received`). */
	// 按方向和帧标签计数，不改历史；例如 count("sent", "hold") 得到已经记录的 hold 数。
	// Frame["t"] 是索引访问类型，限定 t 为 Frame 联合里存在的标签。
	count(direction: "sent" | "received", t: Frame["t"]): number {
		// direction 联合类型限定只能选 sent 或 received；filter 创建新数组，再读取其长度。
		return this[direction].filter((frame) => frame.t === t).length;
	}

	/** Frames this side sent or received, except pings, pongs and acknowledgements. */
	// 返回排除心跳和确认后的新数组；例如只有 ping 与 state 的历史会留下 state，帧本身仍共享。
	traffic(direction: "sent" | "received"): Frame[] {
		// 同时排除 ping、pong、ack，保留其他全部帧种类。
		return this[direction].filter((frame) => frame.t !== "ping" && frame.t !== "pong" && frame.t !== "ack");
	}
}

// Extract 从 Frame 联合中挑出 t 为 state 的分支；类型在编译后消失。
export type StateFrame = Extract<Frame, { t: "state" }>;

// 从只读帧列表筛出 state 帧，不改输入；例如 [ping, state] 返回只含 state 的新数组。
// 回调返回类型 frame is StateFrame 是类型谓词，实际筛选依然由 t === "state" 在运行时完成。
export const stateFrames = (frames: readonly Frame[]): StateFrame[] =>
	frames.filter((frame): frame is StateFrame => frame.t === "state");
