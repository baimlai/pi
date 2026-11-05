// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的请求视图与 body 读取模块（slice 10 §2，D4）。
// 职责边界：定义路由/认证器看到的 HttpRequest，提供 json/body 两种惰性读取；不做准入、路由匹配或响应生成。
// 上游入口：http.ts 在 admit 成功后构造 WebRequest 并写入路由参数；fetch 路径由 webIncoming 提供 Incoming。
// 下游依赖：Incoming（惰性 Request/头）、admission 的 Provenance、json.ts 的 JsonValue、Buffer/URLSearchParams。
// 结果与错误流向：body 正常结束或产出块；超过 limit 抛 HttpFailure(413)，格式错误或流中断抛 HttpFailure(400)，
// 第二次读取抛普通 Error。组件捕获 HttpFailure 并回答对应状态；其他错误按 500 报告。
// 能力清单：
// - HttpRequest：路由看到的请求接口（方法、路径、参数、查询、头、来源、nonce、对端地址、json/body）；
// - HttpFailure：携带 HTTP 状态码的错误类，route 抛出后由组件转成错误响应；
// - WebRequest：HttpRequest 的实现，组合 Incoming 与准入结果，缓存 query；
// - splitUrl：从序列化 URL 中切出 path 与 search 的内部函数；
// - DEFAULT_LIMIT/NO_PARAMS：1 MiB 默认上限与未匹配时的共享空参数对象。
// 组合关系：WebRequest 构造 -> headers 惰性取 Incoming.request() -> json 调用 body 收集块；body 先查声明长度，
// 再逐块累计实际长度，最后在 finally 释放 reader 锁。
// 示例：const request = new WebRequest(incoming, { origin, provenance }, nonce, remoteAddress);
//       const value = await request.json(64 * 1024); // 超过 64 KiB 抛 HttpFailure(413)
// 建议阅读顺序：先看 HttpRequest 的字段，再看 HttpFailure 与 WebRequest 构造，随后 body 的限制/单次读取逻辑，
// 最后看 json 的收集解析与 splitUrl 的字符串切分。
// Requests (slice 10 §2, D4): what a route, a wrap, a socket handler and an authenticator see of an HTTP request (a
// Web `Request` once admitted), and its body, read only when asked: `json(limit?)` (1 MiB by default, malformed 400,
// too large 413) and `body(limit?)`, an async iterable of chunks.

import type { JsonValue } from "../../json.ts";
import type { Provenance } from "./admission.ts";
import type { Incoming } from "./incoming.ts";

/** A request as routes see it, once admitted: `origin` and `provenance` come only from admission. */
// 接口描述路由看到的请求；所有字段在编译期只读，运行时对象由 WebRequest 提供，字段由组件在准入时写入。
// 路径和参数已经由路由器解码/校验；headers、query 和 body 在真正读取时才解析，避免无谓开销。
export interface HttpRequest {
	// 请求方法原样来自网络/适配器；路由表的方法键是全大写，因此实际匹配要求标准客户端发来的大写方法。
	readonly method: string;
	// path 不含查询串，保留百分号编码，但 URL 解析器已解析点段；params 另行解码，不能用于拼文件路径。
	/** The path, without the query, percent-encoded, its dot segments resolved (by the URL parser). */
	readonly path: string;
	// params 由路由参数模式和路由匹配产生；未匹配前是共享空对象 NO_PARAMS，匹配后替换成新对象。
	// Record<string, string> 是编译期映射类型；运行时值来自 decodeURIComponent，并经过 safe() 的路径字符检查。
	/** The matched pattern's params, percent-decoded (`*` for the rest of a `/*` pattern). */
	readonly params: Readonly<Record<string, string>>;
	// 查询参数是标准 URLSearchParams；首次读取时从序列化 URL 的查询串解析并缓存。
	readonly query: URLSearchParams;
	// 请求头是 Web Headers 视图；Node 侧第一次读取时才从 IncomingMessage 构造完整 Request，重复头保留为多行。
	/** The request's headers; read only. */
	readonly headers: Headers;
	// origin 不是客户端任意声称的 Origin，而是准入给出的规范来源：回环 http、允许域名 https 或中继来源。
	/** `http://<host>` on loopback, `https://<host>` for an allowed host, a relay's origin for a relayed request. */
	readonly origin: string;
	// provenance 是准入分类，cookie 的 Secure、跨站下载限制和日志都依赖它；运行时由 admit 产生。
	/** Where it came from (decision "The HTTP component's security baseline" (1), "Relays"). */
	readonly provenance: Provenance;
	// 每次响应新生成的 CSP nonce；页面内联脚本必须带同一个 nonce 才能执行，路由把它写进 HTML。
	/** The server's script nonce: a page's inline scripts carry it (`<script nonce="…">`), the CSP allows them. */
	readonly nonce: string;
	// 对端地址仅用于限流/诊断，不能当身份；中继请求使用中继连接的对端，fetch 挂载时可能为 undefined。
	/**
	 * The peer's address as the listener knows it (a relayed request: the relay's; `fetch` without a connection: none),
	 * for limits per client; never an identity.
	 */
	readonly remoteAddress: string | undefined;
	// 读取整个 body 并 JSON.parse；默认上限 1 MiB，超过 413，格式错误 400，body 读不完整同样 400。
	/** The body as JSON, at most `limit` bytes (1 MiB by default): `HttpFailure` 400 when malformed, 413 when larger. */
	json(limit?: number): Promise<JsonValue>;
	// 逐块异步迭代 body；默认上限 1 MiB，声明或实际超过 413，流中断 400；第二次读取会抛普通 Error。
	/** The body's chunks, at most `limit` bytes (1 MiB by default): `HttpFailure` 413 past it, 400 when cut short. */
	body(limit?: number): AsyncIterable<Uint8Array>;
}

// 错误类型：携带要回答的 HTTP 状态码。路由抛出它时，组件把 status 转成 error 响应；不在此处写响应。
// 例子：throw new HttpFailure(413, "too large") 最终回答 413 和该消息作为纯文本。
/** A failure that answers its request with `status` when it escapes a route (400 malformed, 413 too large). */
export class HttpFailure extends Error {
	readonly status: number;

	// 构造函数：设置 message、name 和 status；status 不做范围校验，调用方（本文件）只传 400/413。
	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpFailure";
		this.status = status;
	}
}

// 默认读取上限 1 MiB；json 和 body 都允许路由显式传入不同的 limit。
/** What `json` and `body` read unless a route says otherwise: 1 MiB. */
const DEFAULT_LIMIT = 1024 * 1024;

// 尚未匹配路由时共享的空参数对象；它被当作不可变值使用，组件之后用新对象替换 params。
/** The params of a request no pattern matched (yet). */
const NO_PARAMS: Readonly<Record<string, string>> = {};

// 类的用途：把 Incoming 的惰性读取能力与准入结果组合成 HttpRequest；实例只在一次请求内使用。
// 注意 params 不是 readonly：构造时为空，路由匹配成功后由组件赋值；其余字段构造后不再变化。
/** A request over what the component reads of it; the component sets its params once it matched a route. */
export class WebRequest implements HttpRequest {
	// 字段在构造时从 Incoming 和准入结果复制；只有 params 与惰性缓存的 query 会随后改变。
	readonly method: string;
	readonly path: string;
	params: Readonly<Record<string, string>> = NO_PARAMS;
	readonly origin: string;
	readonly provenance: Provenance;
	readonly nonce: string;
	readonly remoteAddress: string | undefined;
	readonly #incoming: Incoming;
	// 查询串（不含 ?）先存成字符串；URLSearchParams 只在第一次访问 query 时创建，缓存在 #query。
	/** The query string (without `?`), parsed when first read. */
	readonly #search: string;
	#query: URLSearchParams | undefined;
	// 私有字段 #taken 在运行时真正存在，用于阻止第二次读取 body；它不是编译期装饰。
	/** Whether a reader took the body (it is read once). */
	#taken = false;

	// 构造函数输入：组件读取的 Incoming、准入的 origin/provenance、本响应 nonce 和对端地址。
	// 输出是可供路由使用的请求；副作用只是保存引用，不读取 body，也不构造 Web Request。
	// 例子：new WebRequest(incoming, {origin:"http://127.0.0.1:8788", provenance:{kind:"local"}}, "n", "127.0.0.1")。
	// 真实运行时要求 incoming.method 已存在；URL 解析和点段处理已由适配器完成，这里只拆分路径/查询。
	constructor(
		incoming: Incoming,
		admitted: { readonly origin: string; readonly provenance: Provenance },
		nonce: string,
		remoteAddress: string | undefined,
	) {
		// 方法、路径、查询串、来源、nonce 和对端地址都是一次性快照。
		this.method = incoming.method;
		// The URL is parsed and serialized already (dot segments resolved, `\` as `/`): only split it here.
		const { path, search } = splitUrl(incoming.url);
		this.path = path;
		this.#search = search;
		this.origin = admitted.origin;
		this.provenance = admitted.provenance;
		this.nonce = nonce;
		this.remoteAddress = remoteAddress;
		this.#incoming = incoming;
	}

	// getter：每次读取 headers 都委托给 Incoming.request().headers；Node 侧第一次调用会构造 Web Request。
	// 因此只做准入而不读头/体时，可以避免构造完整 Request 的成本。
	/** The headers: on Chord's Node server the Web `Request` is made only when something reads them. */
	get headers(): Headers {
		return this.#incoming.request().headers;
	}

	// getter：query 为 undefined 时才解析，?? 赋值后缓存；URLSearchParams 会解码百分号编码。
	get query(): URLSearchParams {
		this.#query ??= new URLSearchParams(this.#search);
		return this.#query;
	}

	// 函数用途：读取并解析 JSON body。输入可选上限，输出 JsonValue；格式错误抛 HttpFailure(400)。
	// 流程：把 body 的所有块收集到数组，Buffer.concat 后按 UTF-8 转文本，再 JSON.parse。
	// 例子：body 为 {"a":1} => 返回对象；body 为 "{" => 抛出 400。
	// 类型断言 as JsonValue 只告诉编译器形状，JSON.parse 的运行时结果并没有用 schema 校验。
	async json(limit = DEFAULT_LIMIT): Promise<JsonValue> {
		// chunks 保存 Uint8Array 块；for await 会按 body() 的产出顺序等待每一块。
		const chunks: Uint8Array[] = [];
		for await (const chunk of this.body(limit)) chunks.push(chunk);
		// Buffer.concat 接受 Uint8Array 列表并返回 Buffer；toString("utf8") 按 UTF-8 解码，非法序列由 Node 替换。
		const text = Buffer.concat(chunks).toString("utf8");
		try {
			return JSON.parse(text) as JsonValue;
			// JSON.parse 的异常在运行时被捕获，统一转成 400；不把原始解析错误暴露给客户端。
		} catch {
			throw new HttpFailure(400, "the body is no JSON");
		}
	}

	// 异步生成器：每次 yield 一块请求体，调用者用 for await 消费；输入是可选上限，无返回值（迭代结束即读完）。
	// 错误路径：第二次读取抛 Error；声明长度或实际字节超过上限抛 HttpFailure(413)；流读失败抛 400。
	// 例子：for await (const chunk of request.body(1024)) { ... } 逐块处理，超过 1 KiB 时抛 413。
	// 注意：错误是在迭代过程中抛出，不是调用 body() 时同步抛出。
	async *body(limit = DEFAULT_LIMIT): AsyncIterable<Uint8Array> {
		// 运行时闸门：body 只能被消费一次，避免路由读一半后认证器再读导致语义不清。
		if (this.#taken) throw new Error("request body: read twice");
		this.#taken = true;
		// content-length 缺失或非数字时得到 NaN；只做“声明值已超限”的提前判断，实际读取还会再次累计。
		// Number.NaN 作为 defaultValue 传给 Number 只是习惯写法；header 返回 null 时 ?? 会取它。
		const declared = Number(this.#incoming.header("content-length") ?? Number.NaN);
		if (declared > limit) throw new HttpFailure(413, `the body is larger than ${limit} bytes`);
		// 构造 Web Request 并取其 body 流；没有 body 时标准规定为 null，直接结束迭代。
		const stream = this.#incoming.request().body;
		if (stream === null) return;
		// getReader 取得独占读取器；后面在 finally 中释放锁，不取消流，避免重置连接。
		const reader = stream.getReader();
		let read = 0;
		try {
			// 无限循环直到 done；每一轮等待一次流读取，形成背压。
			for (;;) {
				// Awaited<ReturnType<typeof reader.read>> 在编译期展开 Promise 的结果类型；运行时就是读取结果对象。
				let next: Awaited<ReturnType<typeof reader.read>>;
				try {
					// reader.read 抛错表示流被中断（客户端断开、服务器中止），不能把已读前缀当完整 body。
					next = await reader.read();
				} catch {
					// A body cut short (a disconnect, a broken stream) is no body: a prefix must never parse as the
					// whole (Sol's recheck N4: valid JSON then an error ran the route).
					throw new HttpFailure(400, "the body could not be read whole");
				}
				// done 且没有 value 表示正常结束；直接 return 结束生成器。
				if (next.done) return;
				// 先累计长度再判断上限：超限时当前块不会 yield，但可能已被读入内存。
				read += next.value.byteLength;
				if (read > limit) throw new HttpFailure(413, `the body is larger than ${limit} bytes`);
				yield next.value;
			}
			// finally 在正常完成、超限抛出或调用者提前停止时都会执行；只释放锁，不 cancel。
		} finally {
			// Past the limit, or a reader that stopped early: the rest stays unread (its server closes the connection
			// after the response); a cancel could reset the connection before the response is written.
			reader.releaseLock();
		}
	}
}

/** A serialized URL's path (from the first `/` after the authority) and query (without `?`, no fragment). */
// 函数用途：从序列化 URL 中切出 path 与 search。输入完整 URL 字符串，返回两者，不解析查询内容。
// 例子："http://h:1/a/b?x=1#f" => { path: "/a/b", search: "x=1" }；没有路径时 path 为 "/"。
// 这里假设 URL 已被 URL 解析器序列化（authority 存在），因此用 // 和第一个 /、?、# 的位置切分。
export function splitUrl(url: string): { readonly path: string; readonly search: string } {
	const authority = url.indexOf("//") + 2;
	// indexOf("//") + 2 跳过协议后的双斜杠；authority 结束于第一个 /、? 或 #。
	let start = url.indexOf("/", authority);
	// start 是路径起点；end 是片段起点（没有片段则到字符串末尾）。
	let end = url.indexOf("#", authority);
	if (end < 0) end = url.length;
	// mark 是查询起点；路径起点晚于查询起点说明 URL 只有查询没有路径，此时把 start 置为 -1。
	const mark = url.indexOf("?", authority);
	// 路径终点取查询起点和片段起点中更早者；查询只在片段之前有效。
	if (start < 0 || (mark >= 0 && start > mark)) start = -1;
	const pathEnd = mark >= 0 && mark < end ? mark : end;
	// 没有路径时返回根路径 "/"；查询串去掉 ?，不含 # 之后的内容。
	return {
		path: start < 0 ? "/" : url.slice(start, pathEnd),
		search: mark >= 0 && mark < end ? url.slice(mark + 1, end) : "",
	};
}
