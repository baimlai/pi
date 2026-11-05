// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的 Node 监听与请求/响应适配层（slice 10 §2）。
// 职责边界：创建并管理 Node http.Server、把 IncomingMessage 转成 Incoming/Web Request、写出 Answer，
// 以及为挂载到第三方 Node 服务器的应用提供 nodeRequest；不做准入、路由、认证或响应描述翻译。
// 上游入口：http.ts 的 HttpListener 通过 NodeListener.listen(this, ...) 启动；http.upgrade 挂在 server 的
// upgrade 事件；应用可调用 nodeRequest 把自有 server 的请求交给 http.fetch。
// 下游依赖：node:http 的 createServer/IncomingMessage/ServerResponse、node:stream 的 Duplex、
// admission 的 Connection、incoming 的 Incoming/isForwarding、response 的 Answer、router 的 UNCARRIED。
// 结果与错误流向：正常请求交给 Handler.serve 得到 Served 并写回；线上拒绝（绝对目标 403、解析失败 400、
// 用户信息 Host 403、CONNECT/TRACE/TRACK 501）直接写错误响应；写 body 出错时销毁连接。
// 能力清单：
// - ListenAddress/Served/Handler：监听地址、应答加完成回调、组件需要监听器提供的能力；
// - NodeListener：监听、停止、关闭 Node server 的本地对象；
// - NodeIncoming：Incoming 的 Node 实现，惰性构造 Web Request；
// - WireRefusal：线上拒绝状态；NodeRequest/nodeRequest：挂载场景的转换结果与转换函数；
// - connectionOf：从 IncomingMessage 提取连接信息；
// - 内部函数 request/write/pump/bodyOf/drain/hasBody/declared 负责读写与背压。
// 组合关系：listen 创建 server -> request 转换并 serve -> write 先写头再写整段或拉取流；
// 未读 body 小于 64 KiB 时 drain 保持连接，否则加 Connection: close 并关闭。
// 示例：const listener = await NodeListener.listen(handler, { host: "127.0.0.1", port: 0 }, context);
//       const converted = nodeRequest(message, res); // {kind:"request"} 或 {kind:"refused", status}
// 建议阅读顺序：先看 Handler/NodeListener 的生命周期，再看 NodeIncoming.of 的线上拒绝规则，
// 随后 nodeRequest/webRequestOf 的挂载转换，最后看 write/pump/bodyOf 的背压与 drain 逻辑。
// Chord's own Node server (decision "The HTTP server is a native object"; "The HTTP core is a fetch handler; Chord's
// own Node server is the easy path"): the listener's native, a Node `http` server that hands each request to the
// component as it reads requests (origin-form targets only; a Web `Request` made only when something asks for one, its
// body streamed with backpressure), and writes its answer: whole, or pulled piece by piece as the socket drains. A body the route left unread is drained after the
// response when small, else the connection closes; the request's scope ends once the response is flushed or abandoned.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "../../context/index.ts";
import type { Connection } from "./admission.ts";
import { type Incoming, isForwarding } from "./incoming.ts";
import type { Answer } from "./response.ts";
import { UNCARRIED } from "./router.ts";

// 监听地址：host 是绑定地址（127.0.0.1 或 ::1），port 为 0 时由系统分配实际端口。
/** Where a listener listens. */
export type ListenAddress = { readonly host: string; readonly port: number };

// 一次应答：answer 是要写出的内容；finished 由消费者在 body 写完或放弃后调用，用于结束请求作用域。
// 监听器和 fetch 适配器都必须保证 finished 最终被调用一次。
/** An answer and what its consumer calls once the body is written or abandoned (the request's scope then ends). */
export type Served = { readonly answer: Answer; readonly finished: () => void };

// 监听器需要的组件能力：serve 永不抛错；refusal 用于线上拒绝；upgrade 处理 WebSocket 升级。
/** What the listener needs of the component. */
export interface Handler {
	/** Serves a request: never throws. */
	serve(incoming: Incoming, connection: Connection): Promise<Served>;
	/** The answer for a request refused before it could be made one (default headers only). */
	refusal(status: number): Answer;
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

// 类用途：把 Node server 包装成宿主生命周期对象；监听成功后保存真实地址，并提供 stop/closed 两阶段关闭。
// 私有构造强制通过 listen 创建，确保 server 已监听且地址已知。
/** The listener's native value: a listening Node server. */
export class NodeListener {
	readonly address: ListenAddress;
	readonly #server: Server;
	readonly #closed: Promise<void>;

	// 构造函数保存 server 与地址，并把 close 事件转成 Promise；closed() 可重复等待。
	private constructor(server: Server, address: ListenAddress) {
		this.#server = server;
		this.address = address;
		this.#closed = new Promise((resolve) => server.once("close", () => resolve()));
	}

	// 函数用途：创建并启动 Node server。输入组件 Handler、监听地址和启动上下文；输出 NodeListener。
	// 错误路径：端口占用等 listen 错误会 reject；监听成功后若上下文已取消，关闭 server 并抛出取消原因。
	// 副作用：创建 server、绑定端口、注册 request/upgrade 回调；listen 回调前上下文取消也能被处理。
	// 例子：await NodeListener.listen(handler, { host: "127.0.0.1", port: 8788 }, context)。
	/** A Node server for `handler` listening at `listen`; rejects with the listen error (a port in use). */
	static async listen(handler: Handler, listen: ListenAddress, context: Context): Promise<NodeListener> {
		// 每个普通请求创建一个异步任务；任何意外失败都销毁响应，避免连接悬挂。
		const server = createServer((message, res) => {
			void request(handler, message, res).catch(() => res.destroy());
		});
		// upgrade 请求绕过普通 request 回调，交给组件的升级适配器。
		server.on("upgrade", handler.upgrade);
		// 用一次性 error 监听等待监听成功；成功后移除，避免把运行期错误误当启动失败。
		await new Promise<void>((resolve, reject) => {
			const failed = (error: Error): void => reject(error);
			server.once("error", failed);
			server.listen(listen.port, listen.host, () => {
				server.removeListener("error", failed);
				resolve();
			});
		});
		if (context.abortSignal?.aborted) {
			server.close();
			throw context.abortSignal.reason;
		}
		// address() 可能是 string（Unix socket）或 null；TCP 监听时取实际端口，port 0 在这里变成系统分配值。
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : listen.port;
		return new NodeListener(server, { host: listen.host, port });
	}

	// 停止接受新连接并关闭空闲连接；正在处理的请求由组件 close 负责等待/封口。
	/** Stops accepting connections and closes the idle ones (the component's close runs next). */
	stop(): void {
		this.#server.close();
		this.#server.closeIdleConnections();
	}

	// 关闭所有连接并等待 server 的 close 事件；与 stop 不同，这里会强制关闭仍在使用的连接。
	/** Closes every connection still open and resolves once the server closed. */
	async closed(): Promise<void> {
		this.#server.close();
		this.#server.closeAllConnections();
		await this.#closed;
	}
}

// 类用途：IncomingMessage 的 Incoming 实现。构造时保存 Node 消息和可选响应；Web Request 惰性构造并缓存。
// 只在 Node 路径使用；方法/URL 已在 of 中校验为可转换的 origin-form。
/**
 * A Node request as the component reads it: Node's parsed headers, its URL parsed once, the Web `Request` made only
 * when something asks for it (a route's `headers` or body, a relay).
 */
export class NodeIncoming implements Incoming {
	// method 缺失时按 GET 处理；url 是 new URL(...).href 的规范化结果，不是原始 target。
	readonly method: string;
	readonly url: string;
	readonly #message: IncomingMessage;
	/** The response, to notice a client gone (none for an upgrade). */
	// #res 用于观察客户端提前断开；升级请求没有 ServerResponse，因此为 undefined。
	readonly #res: ServerResponse | undefined;
	#request: Request | undefined;

	// 私有构造：调用方必须先用 of 做线上校验，不能直接 new。
	private constructor(message: IncomingMessage, url: string, res: ServerResponse | undefined) {
		this.method = message.method ?? "GET";
		this.url = url;
		this.#message = message;
		this.#res = res;
	}

	// 函数用途：把 Node 请求转换为 NodeIncoming 或线上拒绝。输入 IncomingMessage 和可选响应，输出二者之一。
	// 规则：只接受 origin-form（以 / 开头）；Web Request 无法承载的 CONNECT/TRACE/TRACK 拒绝；Host+target 必须能组成 URL；
	// URL 不得含用户名/密码（Host: user@host 会让 URL 解析出 userinfo）。
	// 例子：target="/notes"、Host=127.0.0.1:8788 => NodeIncoming；target="http://x/" => 403。
	// 这些拒绝是 wire 边界上的运行时校验，生产者是任意客户端。
	/**
	 * `message` as the component reads it, or what refuses it at the wire (the listener and `nodeRequest` alike): an
	 * absolute-form target 403, a target that does not parse 400, a `Host` with userinfo 403 (never a loopback or
	 * allowed name), a method a Web `Request` cannot carry (`CONNECT`, `TRACE`, `TRACK`) 501: served for no resource.
	 */
	static of(message: IncomingMessage, res?: ServerResponse): NodeIncoming | WireRefusal {
		// 空 target 或绝对形式（http://...）、星号形式（OPTIONS *）都不以 / 开头，统一 403。
		const target = message.url ?? "";
		// Only origin-form targets: an absolute-form one names an authority of its own, `*` none.
		if (!target.startsWith("/")) return { kind: "refused", status: 403 };
		// 这些方法无法由 Web Request 表示；在线上直接 501，避免构造失败。
		if (UNCARRIED.has(message.method ?? "GET")) return { kind: "refused", status: 501 };
		let url: URL;
		try {
			// 用客户端 Host 作为 authority 解析；Host 缺失时用占位符 invalid 让 URL 先可解析，随后准入因缺少 Host 拒绝；
			// Host 文本非法导致 URL 构造抛错时，直接按 400 拒绝。
			// The authority is the `Host` the client sent; admission checks it, so a strange one parses but is refused.
			url = new URL(`http://${message.headers.host ?? "invalid"}${target}`);
		} catch {
			return { kind: "refused", status: 400 };
		}
		// Host 中带 user:pass@ 时 URL 会解析出 userinfo；这种 Host 绝不能匹配回环或允许域名。
		if (url.username !== "" || url.password !== "") return { kind: "refused", status: 403 };
		return new NodeIncoming(message, url.href, res);
	}

	// 按名字取头：headersDistinct 保留同名多值为数组，用 ", " 连接以与 Headers.get 一致。
	// 这是运行时访问 Node 已解析的头；名字应是小写（Node 规范化）。
	header(name: string): string | null {
		return this.#message.headersDistinct[name]?.join(", ") ?? null;
	}

	// 遍历所有头名，发现 Forwarded/X-Forwarded-* 即返回 true；用于决定本地请求是否必须经过中继。
	forwarded(): boolean {
		for (const name in this.#message.headersDistinct) if (isForwarding(name)) return true;
		return false;
	}

	// 注册断开回调：响应已关闭则立即通知；否则等 close 事件，但只有 writableFinished 为 false 时才算提前离开。
	// 正常完成的响应 close 时不会触发 abort。
	cancelled(abort: (reason: unknown) => void): void {
		const res = this.#res;
		if (res === undefined) return;
		const gone = (): void => abort(new Error("http: the client disconnected"));
		if (res.closed) gone();
		else res.once("close", () => res.writableFinished || gone());
	}

	// 惰性构造并缓存 Web Request；重复读取 headers/body 使用同一个对象。
	request(): Request {
		this.#request ??= webRequestOf(this.#message, this.url);
		return this.#request;
	}
}

// 线上拒绝的状态只能是这三个；类型帮助调用方穷尽处理。
/** What refuses a Node request at the wire, with its status. */
export type WireRefusal = { readonly kind: "refused"; readonly status: 400 | 403 | 501 };

// 挂载转换结果：成功时给出 Web Request 和连接信息；失败时给出与自有监听器一致的拒绝状态。
/** A Node request as an app mounting `fetch` on its own Node server gets it: a Web `Request`, or refused. */
export type NodeRequest =
	| { readonly kind: "request"; readonly request: Request; readonly connection: Connection }
	| WireRefusal;

// 函数用途：为挂载到第三方 Node server 的 http.fetch 转换请求。输入 IncomingMessage/ServerResponse，
// 输出 NodeRequest；任何构造失败都变成拒绝，绝不向应用抛错。
// 副作用：注册客户端断开监听、构造 Web Request 并可能开始流式 body；不写响应。
// 例子：const converted = nodeRequest(message, res); if (converted.kind === "request") await http.fetch(converted.request, converted.connection)。
/**
 * Converts `message` for `http.fetch` on an app's own Node server, the whole conversion being the wire boundary: what
 * the listener refuses is refused with the same status (`NodeIncoming.of`), any other construction failure 400, never a
 * throw (Sol's rechecks N6 and A: a hand-made `Request` crashed the app on a malformed target, `TRACE /` or
 * `Host: user@…`). Raw headers keep their duplicates (two `Host`s: admission refuses); the signal aborts when the
 * client goes away before `res` finished.
 */
export function nodeRequest(message: IncomingMessage, res: ServerResponse): NodeRequest {
	// 复用自有监听器的校验；不是 NodeIncoming 就原样返回 WireRefusal。
	const incoming = NodeIncoming.of(message, res);
	if (!(incoming instanceof NodeIncoming)) return incoming;
	// AbortController 把客户端离开转成 Web Request 的 signal；只在提前离开时 abort。
	const gone = new AbortController();
	incoming.cancelled((reason) => gone.abort(reason));
	let request: Request;
	// 构造 Web Request 仍可能因平台限制失败（例如非法头值）；统一按 400 拒绝。
	try {
		request = webRequestOf(message, incoming.url, gone.signal);
	} catch {
		return { kind: "refused", status: 400 };
	}
	// 成功结果携带连接信息，使准入仍能判断是否回环；缺 localAddress/localPort 时不会被当作 local。
	return { kind: "request", request, connection: connectionOf(message) };
}

// 函数用途：构造 Web Request。输入 Node 消息、规范化 URL 和可选 signal，输出 Request。
// 关键点：rawHeaders 逐对 append，保留重复 Host；有 body 的非 GET/HEAD 请求使用流式 body 并设置 duplex:"half"。
// 头部值由 Headers 构造函数校验，非法值会抛错（由 nodeRequest 转 400）。
/**
 * The Web `Request` of `message` at `url`: its raw headers (duplicates kept), its body streamed when it has one, and
 * `signal` when the caller follows the client.
 */
function webRequestOf(message: IncomingMessage, url: string, signal?: AbortSignal): Request {
	const headers = new Headers();
	// rawHeaders 是扁平数组 [name, value, name, value...]；index += 2 逐对读取。
	// append 而非 set，保留重复头（两个 Host 会在准入时被拒绝）。
	const raw = message.rawHeaders;
	for (let index = 0; index < raw.length; index += 2) headers.append(raw[index]!, raw[index + 1]!);
	const method = message.method ?? "GET";
	// duplex 不是标准 RequestInit 字段，用交叉类型扩展；Node 的 fetch 要求流式 body 声明 half duplex。
	const init: RequestInit & { duplex?: "half" } = { method, headers, ...(signal === undefined ? {} : { signal }) };
	// GET/HEAD 按规范不带 body；即使有 content-length 也不把流放进 Request。
	if (hasBody(message) && method !== "GET" && method !== "HEAD") {
		init.body = bodyOf(message);
		init.duplex = "half";
	}
	return new Request(url, init);
}

// 函数用途：从 Node socket 读连接信息。输入 IncomingMessage，输出 Connection；缺失字段被省略。
// 使用条件展开，避免把 undefined 写成显式字段；这些值来自底层 socket，是准入的运行时依据。
/** What a Node socket knows of its connection. */
export function connectionOf(message: IncomingMessage): Connection {
	const { localAddress, localPort, remoteAddress } = message.socket;
	return {
		...(localAddress === undefined ? {} : { localAddress }),
		...(localPort === undefined ? {} : { localPort }),
		...(remoteAddress === undefined ? {} : { remoteAddress }),
	};
}

// 内部函数：服务一个普通请求。线上拒绝走 refusal，正常请求交给 handler.serve，然后统一 write。
// 这里不捕获 serve 的错误，因为 Handler.serve 约定永不抛错；write 失败由调用方销毁响应。
/** One request: served (an absolute-form target: 403; a URL that does not parse: 400), its answer written. */
async function request(handler: Handler, message: IncomingMessage, res: ServerResponse): Promise<void> {
	const incoming = NodeIncoming.of(message, res);
	if (!(incoming instanceof NodeIncoming)) {
		return write(message, res, { answer: handler.refusal(incoming.status), finished: () => {} });
	}
	await write(message, res, await handler.serve(incoming, connectionOf(message)));
}

// 请求体未读部分超过 64 KiB 就不再 drain，直接关闭连接，避免为不读 body 的客户端消耗带宽。
/** What `json` and `body` leave unread that is drained after the response, keeping the connection: 64 KiB. */
const DRAIN_LIMIT = 64 * 1024;

// 函数用途：把 Served.answer 写到 ServerResponse。输入 Node 消息、响应和 Served。
// 流程：客户端已走则直接 finished -> 判断未读 body 处理策略 -> writeHead -> 整段或流式写 body -> drain。
// 副作用：写网络、注册 close 回调；body 流失败时销毁连接。
/** Writes `served`'s answer to `res`; what is left of the request's body is drained after it or closes the connection. */
async function write(message: IncomingMessage, res: ServerResponse, { answer, finished }: Served): Promise<void> {
	// A client gone before its answer: nothing to write.
	// 客户端在应答前已断开：没有可写内容，立即结束作用域。
	if (res.closed) return finished();
	// 响应 close 时调用 finished，覆盖正常结束、客户端断开和 destroy 三种情况。
	res.once("close", finished);
	// message.complete 表示请求体已完整读入；没有 body 也不需要处理。
	// 有未读 body 时：声明长度 <= 64 KiB 可 drain，否则必须关闭连接。
	const left = message.complete || !hasBody(message) ? "none" : declared(message) <= DRAIN_LIMIT ? "drain" : "close";
	// AnswerHeaders.lines() 展开成 [name, value, ...] 扁平数组，Node writeHead 接受这种形式。
	const headers: string[] = [];
	for (const [name, value] of answer.headers.lines()) headers.push(name, value);
	if (left === "close") headers.push("connection", "close");
	// 需要关闭连接时显式发 Connection: close；writeHead 之后不能再改头。
	res.writeHead(answer.status, headers);
	const { body } = answer;
	// ReadableStream 走 pump，逐块写并处理背压；字符串/null 直接 end。
	if (body instanceof ReadableStream) await pump(body, res);
	else res.end(body ?? undefined);
	// 小 body 在响应后异步读完并丢弃，保持 keep-alive；大 body 已标记 close。
	if (left === "drain") drain(message);
}

// 函数用途：把 ReadableStream body 写给响应，按 socket drain 背压。输入流和 ServerResponse，无返回值。
// 错误路径：读流抛错（bytes 读取失败）直接 destroy 连接；客户端关闭时取消读取。
/** Writes `body` to `res` as the socket drains; a body that fails (reported by the component) destroys the connection. */
async function pump(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
	const reader = body.getReader();
	// 客户端关闭时取消 reader；catch 忽略取消失败，避免未处理的 rejection。
	const cancel = (): void => void reader.cancel().catch(() => {});
	res.once("close", cancel);
	for (;;) {
		let next: Awaited<ReturnType<typeof reader.read>>;
		// 逐块读取；Awaited<ReturnType<...>> 在编译期得到 read 的结果类型。
		try {
			next = await reader.read();
			// 流 error 说明响应 body 无法继续；已经写出部分内容，只能销毁连接。
		} catch {
			res.destroy();
			return;
		}
		// done 表示流正常结束，跳出循环后 end 响应。
		if (next.done) break;
		if (res.destroyed) return;
		// write 返回 false 表示缓冲区已满，等待 drain 或 close 再继续，形成背压。
		if (!res.write(next.value)) await drained(res);
	}
	// 正常结束前移除 close 监听，防止之后的 close 触发无意义的 cancel。
	res.removeListener("close", cancel);
	res.end();
}

// 函数用途：等待响应 drain 或 close。输入 ServerResponse，输出 Promise；两个事件任一发生即完成并清理另一个监听。
/** Resolves once `res` drained or closed. */
function drained(res: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			res.removeListener("drain", done);
			res.removeListener("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
}

// 函数用途：把 Node 请求体包装成 Web ReadableStream。输入 IncomingMessage，输出流。
// 背压：start 先 pause；消费者 pull 时 resume；data 事件按 desiredSize 决定是否再次 pause。
// 错误：连接在请求体完整前关闭时 controller.error；cancel 后剩余数据不再读取。
// 高水位使用字节队列策略，允许最多 64 KiB 缓冲。
/** A request body as a Web stream: read as its consumer pulls (the socket paused meanwhile); a disconnect errors it. */
function bodyOf(message: IncomingMessage): ReadableStream<Uint8Array> {
	// open 是运行时的流状态标志：end/close/cancel 后不再 enqueue 或 close。
	// Whether the stream still takes chunks (not ended, errored or cancelled).
	let open = true;
	return new ReadableStream<Uint8Array>(
		{
			// start 中注册 data/end/close 监听，并立即 pause 等待消费者拉取。
			start: (controller) => {
				// data 回调拿到 Buffer 块；open 为 false 时丢弃。
				message.on("data", (chunk: Buffer) => {
					if (!open) return;
					controller.enqueue(chunk);
					// desiredSize <= 0 表示缓冲已满，暂停 socket；pull 会再次 resume。
					if ((controller.desiredSize ?? 0) <= 0) message.pause();
				});
				// end 表示请求体完整到达；open 时关闭流，并清除标志。
				message.once("end", () => {
					if (open) controller.close();
					open = false;
				});
				// close 且 !message.complete 表示客户端在 body 完整前断开，向流报错；完整请求的 close 不报错。
				message.once("close", () => {
					if (open && !message.complete) controller.error(new Error("http: the client disconnected"));
					open = false;
				});
				message.pause();
			},
			// pull 由消费者调用，恢复 socket 读取；下一次 data 继续入队。
			pull: () => {
				message.resume();
			},
			// The rest stays unread: the response closes the connection (or drains a small rest).
			// cancel 表示消费者不再需要 body：停止读取并保持暂停，剩余部分由响应后的 close/drain 处理。
			cancel: () => {
				open = false;
				message.pause();
			},
		},
		// 字节队列策略按 byteLength 计算缓冲，高水位 64 KiB；它不是内存硬上限，只是背压阈值。
		new ByteLengthQueuingStrategy({ highWaterMark: DRAIN_LIMIT }),
	);
}

// 函数用途：丢弃请求体剩余部分。输入 IncomingMessage，无返回值；超过 64 KiB 或出错时销毁 socket。
// 只有在 write 判断为 "drain" 时调用，因此正常情况最多读 64 KiB。
/** Reads and drops the rest of the body (at most 64 KiB); more than that, or an error, closes the connection. */
function drain(message: IncomingMessage): void {
	let read = 0;
	// 继续计数；超过限制后没有移除监听器，后续 data 可能重复 destroy，但 destroy 是幂等的。
	message.on("data", (chunk: Buffer) => {
		read += chunk.byteLength;
		if (read > DRAIN_LIMIT) message.socket.destroy();
	});
	message.on("error", () => message.socket.destroy());
	message.resume();
}

// 函数用途：判断请求是否带 body。输入 IncomingMessage，输出布尔值。
// 规则：有 content-length 时看是否大于 0；否则有 transfer-encoding（chunked）就算有 body。
/** Whether `message` carries a body (a declared length above zero, or chunked). */
function hasBody(message: IncomingMessage): boolean {
	const length = message.headers["content-length"];
	if (length !== undefined) return Number(length) > 0;
	return message.headers["transfer-encoding"] !== undefined;
}

// 函数用途：取得声明的 body 长度；chunked 或缺省时返回正无穷，供 write 判断能否 drain。
// Number(NaN) 仍为 NaN，isFinite 为 false，因此非法长度按无穷处理（保守地关闭连接）。
/** The declared length of `message`'s body; infinite when chunked. */
function declared(message: IncomingMessage): number {
	const length = Number(message.headers["content-length"] ?? Number.NaN);
	return Number.isFinite(length) ? length : Number.POSITIVE_INFINITY;
}
