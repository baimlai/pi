// 文件导读（Chord v1 的链路传输层）
// ===================================
// 所属包与模块：packages/chord/src/old/link.ts，Chord v1 的 Link 抽象与三种实现（内存、Node IPC、WebSocket）。
//
// 解决问题：上层只关心“按 FIFO 顺序收发 Chord Frame”，本文件提供统一的 Link 接口，并处理不同传输的差异：
// 接收者未安装时先排队、bye 帧关闭语义、关闭幂等、大负载压缩（Packed）、Node IPC 的消息包装、WebSocket 的
// 文本/二进制消息与二进制类型转换。上层 host/connection 不需要知道底层是 pipe 还是 socket。
//
// 职责边界：本文件只搬运 Frame，不校验完整帧 schema（那在 wire.ts 的 isFrame/接收方）、不做协议版本协商、
// 不负责重连、心跳或认证。压缩是传输优化：中继可以原样转发 Packed 字节而不解压；真正使用负载的一侧才 unpack。
// 上游：old/index.ts 重导出；host.ts/connection.ts/websocket.ts/manager.ts 使用 ipcLink/webSocketLink/memoryLinkPair。
// 下游：wire.ts 的 Frame 类型；Node 的 zlib（通过 getBuiltinModule 动态取用）、Buffer/TextEncoder；
// 浏览器的 Blob/DecompressionStream/Response。本文件不静态 import node:zlib 的运行时代码。
// 结果与错误流向：send 返回编码后大小（或 undefined）；解析失败/未知消息通常 close("protocol error")；
// 传输关闭通过 onClose(reason) 通知一次；Frame 业务错误不在这里处理，交给上层。
//
// 能力清单（导出项）：
// - Link：有序双向帧通道接口（closed/send/receive/onClose/close）。
// - PACK_THRESHOLD：负载 JSON 超过该字符数才压缩（64 KiB）。
// - Packed：尚未解压的负载字节；中继可原样转发。
// - unpack(value)：若值是 Packed 则解压并 JSON.parse，否则原样返回。
// - inflateMessage(data)：把 WebSocket 二进制消息解成文本帧（供只转发文本的启动器使用）。
// - MemoryLink / memoryLinkPair：进程内成对链路，异步且 FIFO，用于测试和同进程连接。
// - IpcChannel / IpcLink / ipcLink：Node 父子进程 IPC 通道上的 Link 适配。
// - WebSocketLike / WebSocketLinkOptions / WebSocketLink / webSocketLink：WHATWG/ws 风格 WebSocket 适配。
// 文件内实现（未导出）：BaseLink（排队、关闭、异步解码排序）、payload 打包/拆包辅助、parseFrame、inflate。
//
// 组合关系与典型调用顺序：
//   创建 Link -> 上层调用 receive(handler) 安装唯一接收者 -> send(frame) 发送 ->
//   传输关闭或收到 bye -> onClose(reason) 恰好通知一次 -> 上层清理。
//   大负载：发送方 packObject/packMessage 压缩 -> 接收方 unpackObject/splitMessage + inflate/unpack。
//
// 例子（示例；真实签名为 Frame 对象）：
//   const [a, b] = memoryLinkPair();
//   b.receive((frame) => console.log(frame.t)); // 安装前到达的帧会先排队
//   a.send({ t: "ping", n: 1 });                // 下一个微任务按序到达 b
//   a.close();                                  // b 会收到 bye 并按关闭处理
//
// 建议阅读顺序：先看 Link 接口，再读 BaseLink 的 receive/deliver/close/ended；随后读 payload packing 小节，
// 理解 Packed 与三种传输的打包差异；最后分别读 MemoryLink、IpcLink、WebSocketLink 的 transmit/shutdown。
import type * as Zlib from "node:zlib";
import type { Frame } from "./wire.ts";

/** An ordered (FIFO), bidirectional frame channel between two hosts. */
// 两个宿主之间的有序、双向 Frame 通道。所有实现都保证：同一方向按 send 调用顺序交付，
// 接收者安装前到达的帧先排队，关闭只发生一次。
export interface Link {
	// 链路是否已经结束；结束包括本地 close、远端 bye、传输断开或协议错误。
	readonly closed: boolean;
	/**
	 * Returns the size of the encoded frame as sent (JSON text length, or bytes of a packed message) when the transport
	 * knows it. The connection's flow control counts these sizes; frames without one count as zero, so a link that never
	 * reports sizes is not windowed.
	 */
	// 发送一帧，并在传输知道大小时返回编码后的长度：JSON 文本字符数或压缩后字节数。
	// 返回 undefined 表示该传输不报告大小（例如 Node IPC），上层流控把这类帧按 0 计，因此该链路不做窗口限制。
	send(frame: Frame): number | undefined;
	/** Sets the single receiver. Frames arriving earlier are queued. */
	// 设置唯一的接收者；只能有一个，重复调用会替换。设置之前到达的帧已经排队，会在这里按序补发。
	receive(handler: (frame: Frame) => void): void;
	// 注册关闭回调；链路已经关闭时会立即同步调用一次，reason 为 "closed"。
	onClose(handler: (reason: string) => void): void;
	/** Closes both ends: the peer gets a `bye`. */
	// 关闭链路：先尽量发送 bye 帧让对端知道原因，再结束本地并通知关闭回调。重复调用无效果。
	close(reason?: string): void;
}

/** Shared plumbing: receive queue, close handlers, `bye`. Transports implement `transmit` and `shutdown`. */
// BaseLink 把各传输共有的逻辑集中起来：单接收者、早到队列、异步解码排序、bye 处理、关闭幂等。
// 子类只需实现 transmit（实际写出）与 shutdown（释放传输资源），不直接管理队列。
abstract class BaseLink implements Link {
	// 当前接收者；undefined 表示尚未安装，此时帧进入 #queue。
	#handler: ((frame: Frame) => void) | undefined;
	#queue: Frame[] = [];
	// 关闭回调集合；ended 时逐个调用一次后清空。
	readonly #closeHandlers = new Set<(reason: string) => void>();
	#closed = false;
	/** The tail of frames being decoded asynchronously; undefined when none is. */
	// 正在异步解码（浏览器解压）的帧链尾部。后续帧必须等它完成，才能保持 FIFO。
	#decoding: Promise<void> | undefined;

	// closed 只读；getter 让实现和调用方看到同一状态。
	get closed(): boolean {
		return this.#closed;
	}

	// 子类实现：把一帧写到传输，返回大小或 undefined；不要在这里处理关闭通知。
	protected abstract transmit(frame: Frame): number | undefined;
	// 子类实现：释放底层资源（移除监听器、关闭 socket）。由 ended 调用一次。
	protected abstract shutdown(): void;

	// 关闭后 send 变成空操作并返回 undefined；否则交给子类实际发送。
	send(frame: Frame): number | undefined {
		if (this.#closed) return undefined;
		return this.transmit(frame);
	}

	// 安装接收者并同步回放队列。splice(0) 先取走整个队列再遍历，避免回放回调中新到达的帧混入本轮。
	receive(handler: (frame: Frame) => void): void {
		this.#handler = handler;
		for (const frame of this.#queue.splice(0)) handler(frame);
	}

	// 已关闭立即以 "closed" 回调；否则登记，等 ended 时通知。
	onClose(handler: (reason: string) => void): void {
		if (this.#closed) handler("closed");
		else this.#closeHandlers.add(handler);
	}

	// 关闭主动方：先发 bye，让对端把这次结束当作正常关闭而不是传输故障。
	// transmit 失败被忽略，因为传输可能已经消失；随后本地 ended。
	close(reason = "closed"): void {
		if (this.#closed) return;
		try {
			this.transmit({ t: "bye", reason });
		} catch {
			// The transport may already be gone.
		}
		this.ended(reason);
	}

	/** Delivers a parsed frame from the transport, after any frame still being decoded (`deliverLater`). */
	// 传输收到一帧时调用。若还有异步解码未完成，则把当前帧排到那条链之后；否则立即交付。
	protected deliver(frame: Frame): void {
		if (this.#decoding !== undefined) this.deliverLater(Promise.resolve(frame));
		else this.#deliverNow(frame);
	}

	/** Delivers a frame that is still being decoded (inflated in a browser); later frames wait for it, in order. */
	// 交付一个尚未解码完成的帧（Promise<Frame>），并保证之后到达的帧等待它，从而维持传输顺序。
	// 链的结构：等上一条解码链完成 -> 取当前帧 -> 交付或协议错误关闭 -> finally 清理链尾。
	protected deliverLater(frame: Promise<Frame>): void {
		const next = (this.#decoding ?? Promise.resolve())
			.then(() => frame)
			.then(
				(decoded) => this.#deliverNow(decoded),
				// 解码/解压失败：无法恢复帧边界，关闭链路并标记协议错误。
				() => this.close("protocol error"),
			)
			.finally(() => {
				// 只有自己仍是链尾时才清空，避免更晚的链覆盖后被提前清掉。
				if (this.#decoding === next) this.#decoding = undefined;
			});
		this.#decoding = next;
	}

	// 真正把帧交给接收者：bye 是链路自身的控制帧，不向上层交付；接收者未安装则排队。
	#deliverNow(frame: Frame): void {
		if (this.#closed) return;
		if (frame.t === "bye") {
			// 对端主动关闭；reason 可省略，缺省用 "peer closed"。
			this.ended(frame.reason ?? "peer closed");
			return;
		}
		if (this.#handler === undefined) this.#queue.push(frame);
		else this.#handler(frame);
	}

	/** Marks the link closed (transport ended) and notifies once. */
	// 无论结束原因是什么，都只执行一次：标记关闭、清空队列、调用子类 shutdown、最后通知关闭回调。
	// try/finally 保证 shutdown 抛错时回调仍会执行；之后异常继续向外传播（不再吞掉子类错误）。
	protected ended(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue = [];
		try {
			this.shutdown();
		} finally {
			for (const handler of this.#closeHandlers) handler(reason);
			this.#closeHandlers.clear();
		}
	}
}

// ─── payload packing ─────────────────────────────────────────────────────────
//
// A transport optimization, invisible above the links. A frame's payload (call args, a result value, a state snapshot)
// whose JSON exceeds `PACK_THRESHOLD` characters is sent deflated. A host that only relays the frame forwards the
// deflated bytes unread (`Packed`); the host that uses the payload inflates it (`unpack`). Only hosts with Node's zlib
// deflate (synchronously, so frames keep their order); a browser inflates with `DecompressionStream` before delivery.
//
// 中文：这是传输层优化，Link 之上的代码看不到压缩细节。只有 call.args、result.value、state.value 三个负载字段
// 会被压缩；帧的信封（type、id、版本等）始终以 JSON 传输。发送端压缩；只做转发的中间宿主把 Packed 原样转发，
// 真正使用负载的宿主再解压。Node 端用同步 zlib，保证帧顺序；浏览器端异步解压，由 BaseLink.deliverLater 排序。

/** Payloads whose JSON is longer than this many characters are deflated. */
// 阈值按 JSON 字符数计算，不是字节数，也不是压缩后的长度：超过 64K 字符才 deflate。
// 小负载压缩反而增加 CPU 和 base64/头部开销，所以保留阈值。
export const PACK_THRESHOLD = 64 * 1024;

// 运行时按需取 Node 内置 zlib：没有静态 import，浏览器打包时不会因此失败。
// 类型断言只是告诉 TypeScript globalThis.process 可能不存在、getBuiltinModule 的签名；值本身可以是 undefined。
const zlib: typeof Zlib | undefined = (
	globalThis as { process?: { getBuiltinModule?(id: "node:zlib"): typeof Zlib } }
).process?.getBuiltinModule?.("node:zlib");

/** A deflated JSON payload, kept as received until a host uses it. */
// 已压缩但尚未解压的负载。bytes 保留原始 deflate-raw 字节；中继可原样转发，不必解压。
// instanceof Packed 是运行时判定：Packed 是本模块的类，跨进程时不会出现，只有接收后在本进程内构造。
export class Packed {
	readonly bytes: Uint8Array;
	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
}

/** A frame payload as its user needs it: inflated and parsed if it arrived packed. */
// 把负载还原成用户可用的值：不是 Packed 就原样返回（普通小负载）；是 Packed 则用 zlib 同步解压并 JSON.parse。
// 注意这里只接受单值；帧本身是对象，必须由上层把 unpack 用于 args/value 字段，而不是整帧。
// 出错方式：没有 zlib 抛 TypeError；字节损坏时 inflateRawSync/JSON.parse 抛错，由调用方决定是否关闭链路。
export function unpack(value: unknown): unknown {
	if (!(value instanceof Packed)) return value;
	if (zlib === undefined) throw new TypeError("packed payload without zlib");
	return JSON.parse(zlib.inflateRawSync(value.bytes).toString("utf8"));
}

// 只有这三个帧类型带可压缩负载：call 的参数、result 的结果、state 的快照值。
// PayloadField 是字面量联合，编译期限制字段名只能是 "args" 或 "value"。
type PayloadField = "args" | "value";
// 运行时集合用于校验线上数据（unpackObject/splitMessage 收到的 z 字段来自对端），所以这里必须真实检查。
const PAYLOAD_FIELDS: ReadonlySet<string> = new Set<PayloadField>(["args", "value"]);

// 找出该帧应压缩/还原的负载字段；没有负载（例如 ping、ack、call 不带 args）返回 undefined。
// 判别依据是 Frame 联合的 t 标签，TypeScript 在这里自动缩窄到带 args/value 的分支。
function payloadField(frame: Frame): PayloadField | undefined {
	if (frame.t === "call") return frame.args === undefined ? undefined : "args";
	if (frame.t === "result" || frame.t === "state") return frame.value === undefined ? undefined : "value";
	return undefined;
}

/** The frame without its payload field (the envelope). */
// 取出帧的“信封”：浅拷贝整帧后删除负载字段。浅拷贝是安全的，因为删除只作用于新对象；
// 返回 Record<string, unknown> 是为了之后按动态字段名拼装，不改变帧本身。
function envelopeOf(frame: Frame, field: PayloadField): Record<string, unknown> {
	const envelope: Record<string, unknown> = { ...frame };
	delete envelope[field];
	return envelope;
}

/** The payload's deflated bytes: as received, or deflated now if large. Undefined: send it as JSON. */
// 计算负载的压缩字节：
// - 已是 Packed（中继收到后原样再发）：直接用原字节，不重复压缩；
// - 不压缩、无 zlib、没有 JSON 文本、未超过阈值：返回 undefined，表示按普通 JSON 发送；
// - 否则 deflateRawSync(level 1)：最快压缩级别，帧传输优先低延迟而不是最高压缩率。
function packedBytes(value: unknown, compress: boolean, json?: string): Uint8Array | undefined {
	if (value instanceof Packed) return value.bytes;
	if (!compress || zlib === undefined || json === undefined || json.length <= PACK_THRESHOLD) return undefined;
	return zlib.deflateRawSync(json, { level: 1 });
}

/** For object transports (Node IPC, memory): a packed payload travels as `z: [field, base64]`. */
// 面向对象传输（Node IPC、内存链路）：压缩后的负载用 z: [字段名, base64] 表示，其余字段保持信封 JSON。
// base64 让二进制能放进 Node IPC 的结构化克隆消息；这也意味着体积约增加 1/3。
function packObject(frame: Frame, compress: boolean): unknown {
	const field = payloadField(frame);
	if (field === undefined) return frame;
	// 动态下标访问负载字段；Frame 是联合，这里只能经 Record 读取。
	const value = (frame as Record<string, unknown>)[field];
	// 只有真的要压缩时才做 JSON.stringify，避免为不需要压缩的帧付出序列化成本。
	const bytes = packedBytes(value, compress, compress && zlib !== undefined ? JSON.stringify(value) : undefined);
	if (bytes === undefined) return frame;
	return {
		...envelopeOf(frame, field),
		// Buffer.from 的三参数视图避免复制底层数组；toString("base64") 生成可放进 IPC 的字符串。
		z: [field, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")],
	};
}

// unpackObject 是 packObject 的逆过程，处理来自线上的未知值，因此这里的类型检查是信任边界校验。
function unpackObject(message: unknown): unknown {
	if (message === null || typeof message !== "object" || !("z" in message)) return message;
	const { z, ...rest } = message as { z: unknown } & Record<string, unknown>;
	// z 必须是 [合法字段名, base64 字符串]；否则视为协议错误向上抛出。
	if (!Array.isArray(z) || !PAYLOAD_FIELDS.has(z[0]) || typeof z[1] !== "string")
		throw new TypeError("bad packed payload");
	// 还原成 Packed，而不是立即解压：只有真正使用负载的一侧才付解压成本。
	return { ...rest, [z[0]]: new Packed(Buffer.from(z[1], "base64")) };
}

// 复用的编解码器：每帧 new 一个会是热路径分配。
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * For WebSockets: a frame with a packed payload is a binary message, `[envelope length: u32 BE][envelope JSON, with
 * z: field][deflated payload]`; any other frame is text. The payload's JSON is spliced in, not encoded twice.
 */
// WebSocket 有两种消息：普通帧发文本；带压缩负载的帧发二进制，布局为
// [4 字节大端信封长度][信封 JSON（含 z 字段）][deflate-raw 负载]。
// 文本路径不先构造整帧再 stringify，而是把负载 JSON 直接拼进信封 JSON 的最后一个 } 前，
// 避免对大负载做第二次序列化。
function packMessage(frame: Frame, compress: boolean): string | Uint8Array {
	const field = payloadField(frame);
	if (field === undefined) return JSON.stringify(frame);
	const value = (frame as Record<string, unknown>)[field];
	// Packed 的字节已经压缩过，不重复 JSON 序列化；普通值才需要 json 文本。
	const json = value instanceof Packed ? undefined : JSON.stringify(value);
	const bytes = packedBytes(value, compress, json);
	const envelope = envelopeOf(frame, field);
	if (bytes === undefined) {
		// 未压缩：head 形如 {"t":"call",...}，去掉末尾 } 后补 ,"args":<json>}。
		// 这里 json 必定有值：bytes 为 undefined 且值不是 Packed 时，packedBytes 只有在不压缩/无 zlib/未超阈值时返回 undefined，
		// 这些情况都已计算过 json；若值是 Packed，packedBytes 会返回其字节，不会走到本分支。
		const head = JSON.stringify(envelope);
		return `${head.slice(0, -1)},${JSON.stringify(field)}:${json}}`;
	}
	// 压缩路径：信封里记录 z: field，接收方据此知道负载字段名。
	const head = encoder.encode(JSON.stringify({ ...envelope, z: field }));
	// 一次分配完整消息；DataView 以大端（默认）写入长度，与 splitMessage 的 getUint32 对应。
	const message = new Uint8Array(4 + head.byteLength + bytes.byteLength);
	new DataView(message.buffer).setUint32(0, head.byteLength);
	message.set(head, 4);
	message.set(bytes, 4 + head.byteLength);
	return message;
}

/** The envelope of a binary message and its payload bytes. */
// splitMessage 是 packMessage 二进制格式的逆过程，输入来自网络，必须校验。
function splitMessage(data: Uint8Array): { envelope: Record<string, unknown>; field: PayloadField; bytes: Uint8Array } {
	// 注意 DataView 要带 byteOffset/byteLength：data 可能是更大 ArrayBuffer 的视图（例如 ws 的 buffer 切片）。
	const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
	const envelope = JSON.parse(decoder.decode(data.subarray(4, 4 + length))) as unknown;
	if (envelope === null || typeof envelope !== "object") throw new TypeError("bad envelope");
	const { z: field, ...rest } = envelope as { z?: unknown } & Record<string, unknown>;
	if (typeof field !== "string" || !PAYLOAD_FIELDS.has(field)) throw new TypeError("bad packed payload");
	// slice 复制负载，使返回的字节不依赖原消息缓冲区。
	return { envelope: rest, field: field as PayloadField, bytes: data.slice(4 + length) };
}

/**
 * The text frame of a binary (packed) WebSocket message, inflated: for a transport that relays text frames only (the
 * TUI launcher feeding its sandbox). Needs zlib.
 */
// 只转发文本帧的中继（TUI 启动器把消息交给沙箱）需要把二进制压缩消息还原成等价文本帧。
// 与 packMessage 的未压缩文本路径产出相同结构：信封 JSON 的 } 前拼入 "字段名":<解压后的 JSON>。
export function inflateMessage(data: Uint8Array): string {
	if (zlib === undefined) throw new TypeError("inflateMessage needs zlib");
	const { envelope, field, bytes } = splitMessage(data);
	const head = JSON.stringify(envelope);
	return `${head.slice(0, -1)},${JSON.stringify(field)}:${zlib.inflateRawSync(bytes).toString("utf8")}}`;
}

/** Inflates without zlib (browsers). */
// 浏览器没有同步 zlib，改用 Web Streams 的 DecompressionStream("deflate-raw") 异步解压。
// 返回 Promise<unknown>：调用方（WebSocketLink）用 deliverLater 维持帧顺序。
async function inflate(bytes: Uint8Array): Promise<unknown> {
	// Blob 的构造类型要求 ArrayBuffer 支持的视图；这里的断言只是把 Uint8Array<ArrayBufferLike> 收窄。
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"));
	return JSON.parse(await new Response(stream).text());
}

/** Parses a JSON frame; anything else is a protocol error. */
// 解析文本帧：先 JSON.parse，再 unpackObject 还原可能存在的 z 负载，最后做最小结构校验。
// 这里的 typeof frame.t 检查服务线上输入边界；帧其余字段的完整校验在 wire.ts 的接收逻辑。
function parseFrame(data: string): Frame {
	const frame = unpackObject(JSON.parse(data)) as Frame;
	if (frame === null || typeof frame !== "object" || typeof frame.t !== "string") throw new TypeError("not a frame");
	return frame;
}

// ─── memory ──────────────────────────────────────────────────────────────────

// 进程内成对链路，用于测试和同进程 host 连接。行为刻意接近真实传输：
// 交付异步（微任务）、每方向 FIFO、发送时做一次 JSON 往返以复制数据并暴露不可序列化的值。
export class MemoryLink extends BaseLink {
	// 对端链路；由 memoryLinkPair 双向接好。手动使用时可以自行连接。
	peer: MemoryLink | undefined;
	// 模拟断网：置位后两个方向都静默丢帧，也不触发关闭。
	#severed = false;
	// 本方向的发送/交付链尾，保证与真实传输一样的异步 FIFO。
	#pending = Promise.resolve();

	/** Simulates a dead network: frames are dropped silently in both directions and no close is signalled. */
	// 模拟网络已死：只标记两边 severed，不发送 bye、不 close。用于测试超时/重连逻辑。
	sever(): void {
		this.#severed = true;
		if (this.peer) this.peer.#severed = true;
	}

	protected transmit(frame: Frame): number | undefined {
		if (this.#severed) return undefined;
		// A JSON round trip detaches the frame (and rejects what JSON would mangle silently, e.g. bigint).
		// JSON 往返模拟线上编码：调用方之后修改原对象不会影响对端；bigint 等不可 JSON 化的值会在此抛错。
		const data = JSON.stringify(packObject(frame, true));
		const peer = this.peer;
		// One promise chain per direction keeps delivery FIFO and asynchronous, like a real transport.
		// 每次 send 追加到本方向的链上；出错（例如对端回调抛异常）会让后续链变成 rejected，
		// 但 send 本身已经返回，符合异步传输的语义。
		this.#pending = this.#pending.then(() => {
			if (!this.#severed && peer !== undefined) peer.deliver(parseFrame(data));
		});
		// 内存链路的“线上大小”就是 JSON 文本长度，供上层流控计数。
		return data.length;
	}

	protected shutdown(): void {
		const peer = this.peer;
		// 不立即通知对端，而是排在已发送帧之后：对端先收到之前的帧，再收到“对端关闭”。
		this.#pending = this.#pending.then(() => peer?.ended("peer closed"));
	}
}

/** Two connected in-memory links (tests). */
// 创建一对互相连接的内存链路，返回 [a, b]；a.send 到达 b，b.send 到达 a。
// 例子：const [a, b] = memoryLinkPair(); b.receive(console.log); a.send({t:"ping"});
export function memoryLinkPair(): [MemoryLink, MemoryLink] {
	const a = new MemoryLink();
	const b = new MemoryLink();
	a.peer = b;
	b.peer = a;
	return [a, b];
}

// ─── Node IPC ────────────────────────────────────────────────────────────────

/** `process` in a forked child, or the parent's `ChildProcess`. Structural, so Chord needs no Node types here. */
// 结构化接口：子进程里的 process 与父进程里的 ChildProcess 都满足它。
// 只用结构类型而不 import Node 类型，是为了让本文件在浏览器构建中也能通过类型检查。
export interface IpcChannel {
	// 通道是否仍可写；进程退出/断开后会变成 false。
	readonly connected: boolean;
	/**
	 * With a callback, Node reports a failed write (the peer process exited and the pipe is broken: `EPIPE`) to it
	 * instead of emitting `error`, which nobody would handle.
	 */
	// 发送一条 IPC 消息。带 callback 时，写失败（对端退出导致 EPIPE）通过 callback 报告，
	// 而不是发出无人处理的 "error" 事件；返回值表示是否成功排入发送队列。
	send(message: unknown, callback?: (error: Error | null) => void): boolean;
	on(event: "message", listener: (message: unknown) => void): unknown;
	on(event: "disconnect", listener: () => void): unknown;
	off(event: "message", listener: (message: unknown) => void): unknown;
	off(event: "disconnect", listener: () => void): unknown;
}

/**
 * Chord frames on an IPC channel are wrapped as `{ chord2: frame }`; other messages (control) pass by. Both ends are
 * Node processes of one application, so large payloads are packed both ways. Node serializes the messages itself, so
 * the link reports no sizes and is not windowed: both ends are local processes.
 */
// Node 父子进程 IPC 上的 Link：
// - Chord 帧包装成 { chord2: frame }，与 manager 的控制消息（{ chord2control }）共存，其他消息不处理；
// - 两端都是本应用的本地进程，所以双向都允许压缩；
// - Node 自己序列化消息，本层无法得知线上大小，因此 send 返回 undefined，链路不做窗口流控。
export class IpcLink extends BaseLink {
	readonly #channel: IpcChannel;
	readonly #onMessage = (message: unknown): void => {
		// 只认 chord2 字段；控制消息、用户消息在这里直接略过。
		const frame = (message as { chord2?: unknown } | null)?.chord2;
		if (frame === undefined) return;
		try {
			// unpackObject 只把 z 负载还原成 Packed；真正解压留给消费该负载的一侧。
			this.deliver(unpackObject(frame) as Frame);
		} catch {
			// 解包失败说明对端发的不是合法 Chord 消息，无法继续信任帧边界。
			this.close("protocol error");
		}
	};
	readonly #onDisconnect = (): void => this.ended("ipc disconnected");
	/**
	 * A write can fail after the peer exited and before the channel reports `disconnect` (an `ack` or a `bye` sent then).
	 * The peer is gone either way: the link ends, as on `disconnect`.
	 */
	// 对端已退出但 disconnect 事件还没到（例如刚发出的 ack 或 bye）时，send 回调会收到 EPIPE。
	// 结果同样是“对端不在”：结束链路，reason 优先用错误码（例如 EPIPE），否则用错误消息。
	readonly #onSent = (error: Error | null): void => {
		if (error !== null) this.ended(`ipc send failed: ${(error as { code?: string }).code ?? error.message}`);
	};

	constructor(channel: IpcChannel) {
		super();
		this.#channel = channel;
		// 箭头函数字段保证 this 指向实例，且引用稳定，shutdown 能用同一引用 off。
		channel.on("message", this.#onMessage);
		channel.on("disconnect", this.#onDisconnect);
	}

	// 已断开时静默丢弃；否则包装成 { chord2 } 并发送。压缩始终开启（本地进程，CPU 便宜）。
	// 返回 undefined：Node IPC 不提供可计量的线上大小，上层流控不限制该链路。
	protected transmit(frame: Frame): undefined {
		if (this.#channel.connected) this.#channel.send({ chord2: packObject(frame, true) }, this.#onSent);
		return undefined;
	}

	// 只移除本实例注册的监听器；不主动断开通道，因为通道可能被其他模块共享。
	protected shutdown(): void {
		this.#channel.off("message", this.#onMessage);
		this.#channel.off("disconnect", this.#onDisconnect);
	}
}

// 工厂函数：new IpcLink(channel) 的简写，便于上层按依赖注入方式使用。
export const ipcLink = (channel: IpcChannel): IpcLink => new IpcLink(channel);

// ─── WebSocket ───────────────────────────────────────────────────────────────

/** The WHATWG WebSocket surface: the browser `WebSocket`, Node's global `WebSocket`, and `ws` sockets. */
// 结构化的 WHATWG WebSocket 子集：浏览器 WebSocket、Node 全局 WebSocket 与 ws 包都满足。
export interface WebSocketLike {
	// 0 CONNECTING、1 OPEN、2 CLOSING、3 CLOSED；0 和 1 时仍可排队发送。
	readonly readyState: number;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	// 方法重载：message 事件的回调收到带 data 的事件对象，open/close/error 事件的回调没有参数。
	// TypeScript 按 type 字面量选择对应签名，实现方只需提供一个兼容所有重载的函数。
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
}

// WebSocket.OPEN 的数值；用常量避免依赖具体实现的静态属性。
const OPEN = 1;

// 选项语义：
// - compress：是否压缩自己发出的帧。默认 false，通常只在服务端对客户端 socket 开启，
//   因为浏览器端解压是异步的，且压缩会消耗服务端 CPU；中继/服务端能控制对端时才有意义。
// - acceptPacked：是否接受对端的二进制压缩帧。默认 true；服务端面对不受信任的客户端时可设为 false，
//   避免为任意二进制消息付出解压资源。文本帧始终接受。
export interface WebSocketLinkOptions {
	/** Deflate large payloads of outgoing frames (default false; the server's side of client sockets). */
	readonly compress?: boolean;
	/** Accept packed (binary) frames from the peer (default true; false for a server's untrusted clients). */
	readonly acceptPacked?: boolean;
}

// WebSocket 上的 Link：未 OPEN 时发出的帧先进入 outbox，收到 open 事件后按序补发；
// 文本消息按普通帧解析；二进制消息按 packMessage 的布局拆分，Node 侧直接得到 Packed，
// 浏览器侧异步解压并经 deliverLater 保序。
export class WebSocketLink extends BaseLink {
	readonly #socket: WebSocketLike;
	readonly #compress: boolean;
	#outbox: (string | Uint8Array)[] = [];

	constructor(socket: WebSocketLike, options: WebSocketLinkOptions = {}) {
		super();
		this.#socket = socket;
		this.#compress = options.compress ?? false;
		const acceptPacked = options.acceptPacked ?? true;
		// Binary messages as ArrayBuffer (browsers and Node's WebSocket default to Blob).
		// 统一二进制消息类型为 ArrayBuffer：浏览器和 Node 的 WebSocket 都暴露 binaryType 且默认可能是 Blob，
		// 结构化的测试实现可能没有该属性，所以先用 in 检查再赋值。
		if ("binaryType" in socket) (socket as { binaryType: string }).binaryType = "arraybuffer";
		socket.addEventListener("open", () => {
			// 连接建立后按发送顺序冲刷 outbox；splice(0) 先清空，回调中再 send 不会混入本轮。
			for (const data of this.#outbox.splice(0)) socket.send(data);
		});
		socket.addEventListener("message", (event) => {
			// 所有解析错误都在这里收口为 "protocol error"：二进制布局/信封/压缩数据不可信。
			try {
				const data = event.data;
				if (typeof data === "string") {
					this.deliver(parseFrame(data));
					return;
				}
				if (!acceptPacked) throw new TypeError("packed frames are not accepted");
				// ArrayBuffer 与任意 TypedArray/DataView 都归一成 Uint8Array 视图；其他类型（Blob 等）视为未知消息。
				const bytes =
					data instanceof ArrayBuffer
						? new Uint8Array(data)
						: ArrayBuffer.isView(data)
							? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
							: undefined;
				if (bytes === undefined) throw new TypeError("unknown message type");
				const { envelope, field, bytes: payload } = splitMessage(bytes);
				// 有 zlib（Node）：直接把负载包成 Packed，解压推迟到真正使用负载时；
				// 无 zlib（浏览器）：异步解压，计算属性名 [field] 把结果放回正确字段。
				if (zlib !== undefined) this.deliver({ ...envelope, [field]: new Packed(payload) } as Frame);
				else this.deliverLater(inflate(payload).then((value) => ({ ...envelope, [field]: value }) as Frame));
			} catch {
				this.close("protocol error");
			}
		});
		// 无论正常关闭还是异常断开，都以 "socket closed" 结束本地链路。
		socket.addEventListener("close", () => this.ended("socket closed"));
	}

	// 编码一帧并发送或排队；返回值供上层流控计数：文本按字符数，二进制按字节数。
	protected transmit(frame: Frame): number {
		const data = packMessage(frame, this.#compress);
		// 只有 OPEN 才直接 send；CONNECTING 阶段规范不允许 send，先放进 outbox 等 open 事件冲刷。
		// CLOSING/CLOSED 时也会入队，但随后 shutdown 会清空 outbox，帧被丢弃。
		if (this.#socket.readyState === OPEN) this.#socket.send(data);
		else this.#outbox.push(data);
		return typeof data === "string" ? data.length : data.byteLength;
	}

	// 清空未发送队列；若 socket 仍可关闭（CONNECTING/OPEN），用 1000 正常关闭码关闭。
	protected shutdown(): void {
		this.#outbox = [];
		if (this.#socket.readyState <= OPEN) this.#socket.close(1000);
	}
}

// 工厂函数：new WebSocketLink(socket, options) 的简写。
export const webSocketLink = (socket: WebSocketLike, options?: WebSocketLinkOptions): WebSocketLink =>
	new WebSocketLink(socket, options);
