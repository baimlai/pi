// The launcher's end of the sandbox's pipes (slice 11 §4; fix round 2: the sandbox a child process): messages as
// plain length-prefixed binary frames, not Node's IPC. A frame is a 4-byte big-endian length, then the payload: a
// 4-byte big-endian header length, the header (the message as JSON, its body field left out), and the body (the raw
// bytes of `bytes`, or the UTF-8 text of `data`). The sandbox's bootstrap has the same codec (`sandbox.ts`). What the
// sandbox sends is untrusted: each frame is bounded, and each message checked here before the launcher acts on it.
//
// 文件导读
// 所属：packages/chord 的 Node 终端启动器模块（node/tui），是启动器与沙箱子进程之间的私有帧协议实现。
// 职责边界：只负责编码、增量拆帧和信任边界校验，不处理业务动作、不碰终端、不做 I/O。
// 上游：launcher.ts 用 launcherFrame 发送消息并用 FrameReader 读取 stdout；sandbox.ts 用 startFrame 发送首帧。
// 下游：沙箱内 bootstrap（sandbox.ts 的模板脚本）实现同一种格式。合法结果转为 SandboxMessage；非法帧抛 Error，
// 由 Sandbox#read 捕获并终止沙箱子进程。
// 能力清单：
// - MAX_PIPE_FRAME：单帧上限 17 MiB（16 MiB 附件 + 头部）。
// - launcherFrame：把启动器消息编码为一帧，长文本/二进制放 body。
// - startFrame：握手首帧，body 是 base bundle 源码。
// - frame（私有）：拼接 4 字节负载长度、4 字节头部长度、JSON 头部和可选 body。
// - FrameReader：增量拆帧类，push 返回已完整消息，内部缓冲可复用并按需扩容。
// - sandboxMessage（私有）：校验负载头与消息 kind/字段，是沙箱管道的信任边界。
// - bridgeRequest（私有）：校验 fetch/copy/open/attach/base 请求形状。
// 组合与顺序：启动器 Sandbox.start → startFrame 写入 stdin；沙箱输出经 stdout → FrameReader.push → sandboxMessage
// → sandbox 的 onMessage。反向消息由 launcherFrame 编码后写入。
// 示例：`const reader = new FrameReader(); const messages = reader.push(chunk);` 可能返回 0 条或多条消息。
// 阅读顺序：先读帧格式注释与 frame，再读 launcherFrame/startFrame，然后 FrameReader.push，最后 sandboxMessage。

// 这些消息类型定义在 tui/bridge.ts；方向由类型名区分：LauncherMessage 是启动器→沙箱，SandboxMessage 反向。
import type { BridgeRequest, LauncherMessage, SandboxMessage } from "../../tui/bridge.ts";

/** The largest frame either side takes: 17 MiB (an attached file of 16 MiB and its header). */
// 任一方向单帧上限 17 MiB：容纳 16 MiB 附件加头部，同时防止无界缓冲。
export const MAX_PIPE_FRAME = 17 * 1024 * 1024;

/** The largest header of a frame from the sandbox: 1 MiB (a request's text or URL; frames carry their text as body). */
// 来自沙箱的 JSON 头部上限 1 MiB；大段文本放在 body，头部不会因此膨胀。
const MAX_HEADER = 1024 * 1024;

/** `message` as one frame for the sandbox. */
// 把启动器消息编码成一帧：输入消息对象，返回可写入子进程 stdin 的 Buffer。
// 对带二进制/长文本的消息，只把标识字段放进头部，内容放 body，避免 JSON 转义膨胀；
// 其余消息整体作为头部。无副作用；Buffer.from 可能复制字符串。
// 例如 input 消息 `{ kind: "input", data: "ls\r" }` 编码后 body 是 `ls\r` 的 UTF-8 字节。
export function launcherFrame(message: LauncherMessage): Buffer {
	// 输入文本放进 body。
	if (message.kind === "input") return frame({ kind: "input" }, Buffer.from(message.data));
	// 套接字二进制消息：socket 编号在头部，字节在 body。
	if (message.kind === "socket_message") return frame({ kind: message.kind, socket: message.socket }, message.bytes);
	// 附件：id 与文件名在头部，文件字节在 body。
	if (message.kind === "attached")
		return frame({ kind: message.kind, id: message.id, name: message.name }, message.bytes);
	// 其余短消息（opened、reply 等）没有 body。
	return frame(message, undefined);
}

/** The first frame: the bridge's start and the base bundle's text as body. */
// 握手第一帧：头部是 `{ kind: "start", start }`，body 是基础 bundle 源码的 UTF-8 文本。
// 沙箱 bootstrap 收到它后才开始执行下载代码；返回的 Buffer 由 Sandbox.start 写入。
export function startFrame(start: unknown, source: string): Buffer {
	return frame({ kind: "start", start }, Buffer.from(source));
}

/** A frame of `header` and `body`. */
// 通用组帧：头部 JSON + body，前面拼 8 字节前缀（总负载长度、头部长度）。
// 使用 allocUnsafe 后立即写满 8 字节，不会泄露未初始化内存；Buffer.concat 生成连续 Buffer。
function frame(header: object, body: Uint8Array | undefined): Buffer {
	const json = Buffer.from(JSON.stringify(header));
	const prefix = Buffer.allocUnsafe(8);
	prefix.writeUInt32BE(4 + json.length + (body?.length ?? 0), 0);
	prefix.writeUInt32BE(json.length, 4);
	return Buffer.concat(body === undefined ? [prefix, json] : [prefix, json, body]);
}

/**
 * Cuts the sandbox's output into messages as chunks arrive; throws (the sandbox is ended) on a frame over
 * `MAX_PIPE_FRAME`, a header over 1 MiB, or a message of no known shape. Each byte is copied in once, however small the
 * chunks the sandbox writes.
 */
// 增量拆帧器：管道数据是任意切块的，一次 push 可能含 0 个、1 个或多个完整消息，也可能只有半个帧。
// 内部维护一个可复用的 Buffer 和读写游标（#start 指向未读起点，#end 指向已写入终点），避免每个字节都分配。
// 上游是 launcher.ts 对子进程 stdout 的 data 事件；下游是 sandboxMessage 的信任边界校验。
// 实例有状态，但不是线程安全的：Node 的事件回调串行执行，所以同一实例不会被并发 push。
export class FrameReader {
	// 私有字段（# 开头）在运行时真正私有，外部无法访问；初始 64 KiB，按需增长。
	#buffer = Buffer.alloc(64 * 1024);
	// #start/#end 是相对 #buffer 的下标，[#start, #end) 为尚未消费的字节。
	#start = 0;
	#end = 0;

	/** The messages complete with `chunk`. */
	// 追加一块管道数据并返回其中已完整的消息数组。未完整的尾部留在缓冲里等下一次 push。
	// 副作用：修改内部缓冲与游标。错误：帧头长度非法或 sandboxMessage 校验失败时抛错，调用方据此结束沙箱。
	// 例子：先 push 半帧不返回消息；再 push 剩余字节返回一条消息。返回的数组可能为空。
	push(chunk: Buffer): SandboxMessage[] {
		// 先把新字节接在未读数据后面（必要时搬移/扩容）。
		this.#append(chunk);
		// 收集本次可解析出的所有消息；返回给调用方逐条处理。
		const messages: SandboxMessage[] = [];
		// 至少要有 4 字节才能读长度前缀。
		while (this.#end - this.#start >= 4) {
			// 帧长度是“负载”长度，包含 4 字节头部长度字段，因此最小合法值是 4。
			const length = this.#buffer.readUInt32BE(this.#start);
			// 超限或过小都视为畸形：可能是协议错位或恶意输入，直接终止而不是试图重新同步。
			if (length < 4 || length > MAX_PIPE_FRAME) throw new Error("terminal: the sandbox sent a malformed frame");
			// 整帧还没到齐就停下，保留到下一次 push。`4 + length` 是含长度前缀的总字节数。
			if (this.#end - this.#start < 4 + length) break;
			// The message copies what it keeps: the buffer is reused.
			// 注释强调 sandboxMessage 返回的消息会复制 body；这里传的是切片视图，随后缓冲会被覆写。
			messages.push(sandboxMessage(this.#buffer.subarray(this.#start + 4, this.#start + 4 + length)));
			// 推进读游标，越过整帧。
			this.#start += 4 + length;
		}
		// 全部消费完时游标归零，下一次从缓冲区头部开始写，避免无限前移。
		if (this.#start === this.#end) this.#start = this.#end = 0;
		return messages;
	}

	/** Copies `chunk` in after the unread bytes, moving them to the front or growing the buffer when it is full. */
	// 把新块接到未读字节之后：空间够就原地追加，不够就搬到头部或扩容，保证未读数据连续。
	// 无返回值；副作用是 #buffer/#start/#end 更新。这里只处理内存搬运，不做协议校验。
	#append(chunk: Buffer): void {
		// 当前尚未消费的字节数。
		const unread = this.#end - this.#start;
		// 尾部剩余空间不足时才需要整理或扩容。
		if (this.#end + chunk.length > this.#buffer.length) {
			// 整理后至少需要容纳“未读 + 新块”。
			const needed = unread + chunk.length;
			// 三目运算符：未读数据本身加新块能放进现有容量就复用同一 Buffer；
			// 否则分配新 Buffer，大小取 needed 与“当前容量翻倍但不超过单帧上限+4”的较大者，避免频繁扩容。
			// Math.min 防止在接近上限时翻倍申请过大内存；MAX_PIPE_FRAME + 4 给长度前缀留空间。
			const target =
				needed <= this.#buffer.length
					? this.#buffer
					: Buffer.alloc(Math.max(needed, Math.min(this.#buffer.length * 2, MAX_PIPE_FRAME + 4)));
			// copy(target, targetStart, sourceStart, sourceEnd)：把未读区间搬到目标开头。
			this.#buffer.copy(target, 0, this.#start, this.#end);
			// 换成目标 Buffer，并把游标重置为从 0 开始。
			this.#buffer = target;
			this.#start = 0;
			this.#end = unread;
		}
		// 新块复制到已写入位置之后，再推进写游标。
		chunk.copy(this.#buffer, this.#end);
		this.#end += chunk.length;
	}
}

/**
 * The message in `payload` (a frame from the sandbox, without its length); throws for anything else. Trust boundary:
 * the sandbox's pipe.
 */
// 解析一个完整负载（长度前缀已由调用方去掉）：先读 4 字节头部长度，再 JSON 解析头部，剩余字节是 body。
// 这是明确的信任边界：沙箱代码不可信，所有字段都做运行时检查，任何不认识的形状都抛错。
// 校验通过后返回强类型的 SandboxMessage；调用方不再需要检查字段类型。
// 例子：头部 `{"kind":"write"}`、body 为 `"hi"` 时返回 `{ kind: "write", data: "hi" }`。
function sandboxMessage(payload: Buffer): SandboxMessage {
	// 头部长度本身也有限制：防止声明一个巨大头部造成超大字符串分配。
	// `4 + headerLength > payload.length` 保证头部没有越界（body 可以为空）。
	const headerLength = payload.readUInt32BE(0);
	if (headerLength > MAX_HEADER || 4 + headerLength > payload.length) throw malformed();
	// toString 的起止参数是 [4, 4 + headerLength)；JSON.parse 的结果运行时不可信，
	// 所以先断言为 Record<string, unknown> | null，再用 typeof 检查。若 JSON 语法错误，parse 会直接抛 SyntaxError。
	const header = JSON.parse(payload.toString("utf8", 4, 4 + headerLength)) as Record<string, unknown> | null;
	// subarray 是共享内存的视图，不复制；下面的分支在需要长期保留时显式复制。
	const body = payload.subarray(4 + headerLength);
	// 顶层必须是对象；数组虽然 typeof 也是 "object"，但后续 header.kind 会得到 undefined 并落入 default。
	if (typeof header !== "object" || header === null) throw malformed();
	// socket 字段只在部分消息里有意义；先取出，使用前逐个用 Number.isSafeInteger 校验。
	const socket = header.socket;
	// 根据 kind 做可辨识联合的分发；TypeScript 不会因为条件而自动收窄 unknown 字段，所以每个字段单独检查。
	switch (header.kind) {
		case "write":
			// 终端输出文本：body 以 UTF-8 解码；这里不限长，长度已由 MAX_PIPE_FRAME 间接限制。
			return { kind: "write", data: body.toString("utf8") };
		case "socket_send":
			// 套接字编号必须是安全整数（排除 NaN、Infinity、小数和超出 2^53-1 的值）。
			if (!Number.isSafeInteger(socket)) throw malformed();
			// A copy: the payload's memory is the reader's.
			// 必须复制：FrameReader 会复用底层 Buffer，若不复制，回调稍后读取的字节可能已被新数据覆盖。
			// `socket as number` 是编译期断言，运行时保证来自上一行的检查。
			return { kind: "socket_send", socket: socket as number, bytes: new Uint8Array(body) };
		case "socket_open":
		case "socket_close":
			// 打开/关闭只需合法编号；两个 case 共用同一段返回逻辑，header.kind 已收窄为这两种字面量。
			if (!Number.isSafeInteger(socket)) throw malformed();
			return { kind: header.kind, socket: socket as number };
		case "request":
			// 沙箱向启动器发起的能力请求：id 用于把响应配回；request 再经过 bridgeRequest 白名单校验。
			if (!Number.isSafeInteger(header.id)) throw malformed();
			return { kind: "request", id: header.id as number, request: bridgeRequest(header.request) };
		case "outdated":
			// 沙箱检测到 bundle 过期；没有额外字段。
			return { kind: "outdated" };
		case "failed":
			// 失败消息：String() 把任意值转成字符串，保证消息类型稳定（即使对端发了数字或对象）。
			return { kind: "failed", message: String(header.message) };
		case "exit":
			// 退出码：合法整数才采用，否则回退为 1，避免把任意值传进 process.exit。
			return { kind: "exit", code: Number.isSafeInteger(header.code) ? (header.code as number) : 1 };
		default:
			// 未知 kind 一律拒绝，不做兼容猜测。
			throw malformed();
	}
}

/** The request `value` names; throws for anything else. */
// 校验沙箱请求的“种类 + 必要字符串字段”：只放行 base/fetch/copy/open/attach 五种。
// 输入是 unknown（JSON 解析结果）；返回窄化后的 BridgeRequest。任何多余形状都抛 malformed。
// 这里的 typeof 检查不是多余的：value 来自管道，TypeScript 对它一无所知。
function bridgeRequest(value: unknown): BridgeRequest {
	// 先确保有个可索引对象；不是对象就退化为空对象，后续所有分支都不匹配，最终抛出。
	// 注意 `({} as Record<string, unknown>)` 只为让属性访问类型合法，不代表认可该输入。
	const request = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	// 每个分支同时检查 kind 和所需字段的运行时类型；字符串字段缺失或不是字符串都拒绝。
	if (request.kind === "base") return { kind: "base" };
	if (request.kind === "fetch" && typeof request.path === "string") return { kind: "fetch", path: request.path };
	if (request.kind === "copy" && typeof request.text === "string") return { kind: "copy", text: request.text };
	if (request.kind === "open" && typeof request.url === "string") return { kind: "open", url: request.url };
	if (request.kind === "attach" && typeof request.path === "string") return { kind: "attach", path: request.path };
	throw malformed();
}

// 统一的“畸形消息”错误工厂：调用方只看到错误消息并据此终止沙箱，不区分具体哪一条校验失败。
function malformed(): Error {
	return new Error("terminal: the sandbox sent a malformed message");
}
