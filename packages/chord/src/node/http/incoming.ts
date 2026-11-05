// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的请求适配层（slice 10 §2）。
// 职责边界：定义组件在准入之前需要读取的最小请求接口；不做路由、认证、准入或 body 解析。
// 上游入口：http.ts 的 fetch 收到 Web Request 时调用 webIncoming；node.ts 的 NodeIncoming 在自有监听器
// 和 nodeRequest 中实现同一接口。下游依赖：admission.ts（读 Host/转发头）、http.ts（方法/URL/取消）、
// authenticate.ts 与 router.ts（通过 WebRequest 间接读取）。
// 结果与错误流向：Incoming 只是只读视图；没有错误路径，也不抛错。真正的 HTTP 报文解析错误在 Node 适配器
// 或平台 Request 构造时已经处理。
// 能力清单：
// - Incoming：组件读取请求的六项能力（method、url、header、forwarded、cancelled、request）；
// - webIncoming：把已有 Web Request 包装成 Incoming，惰性委托头与取消信号；
// - isForwarding：判断一个小写头名是否表示代理转发。
// 组合关系：webIncoming -> admit（header/forwarded）-> WebRequest（request()）-> 路由/认证；
// Node 路径则用 NodeIncoming 实现同一流程，因此准入与路由只有一份实现。
// 示例：const incoming = webIncoming(request); if (incoming.forwarded()) { /* 需要中继验证 */ }
// 建议阅读顺序：先看 Incoming 接口的字段语义，再看 webIncoming 的委托实现，最后看 isForwarding 的匹配规则。
// 运行时说明：两个适配器都是内部输入，HTTP 边界由 Node 或平台 Request 解析器负责，本文件不做 schema 校验。
// What the component reads of a request (decision "The HTTP core is a fetch handler"): one shape for a Web `Request`
// (`fetch`) and for Chord's own Node server, so admission, routing and the baseline have one implementation. The Node
// side reads Node's own parsed headers and builds a Web `Request` only when something asks for it (a route's
// `headers` or body, a relay's `verify`).

/** A request as the component reads it. */
// 接口只描述“组件需要什么”，不规定实现方式；TypeScript 在编译期检查对象形状，运行时没有校验器。
// 两个实现分别是 webIncoming（内存中的 Web Request）与 NodeIncoming（Node 解析后的 IncomingMessage）。
export interface Incoming {
	// interface 只检查实现的形状，不在运行时生成对象或验证 HTTP 输入；两种适配器实现同一个入口。
	// 请求方法，如 "GET" 或 "POST"；Node 侧缺省时适配器会补成 "GET"，此处只按字符串读取。
	readonly method: string;
	/** The URL as the URL parser serialized it (dot segments resolved, `\` as `/`). */
	// 序列化后的完整 URL；解析器已解析点段（/a/../b 变成 /b）并把反斜杠当作斜杠。
	// 路径和查询参数稍后由 request.ts 的 splitUrl 从这里切出，避免二次解析。
	readonly url: string;
	/** A header's value, several of one name joined with `", "` (as `Headers.get`); `null` without it. */
	// 按名字读取一个头；同名多个值时用 ", " 连接（与 Headers.get 一致），不存在时返回 null。
	// 这个“连接后比较”的规则让准入逻辑能发现重复的 Host（例如 "a, b"）。
	header(name: string): string | null;
	/** Whether a proxy forwarded it: a `Forwarded` or `X-Forwarded-*` header. */
	// 是否带有代理转发痕迹（Forwarded 或 X-Forwarded-*）。有痕迹的本地请求必须由中继验证，不能直接当本地请求。
	forwarded(): boolean;
	/** Calls `abort` once when the client goes away before its answer is written (at once when it has). */
	// 注册“客户端提前离开”的回调；客户端已经离开时立即同步调用，否则等取消事件。
	// 回调只应执行一次；Web 适配器通过一次性监听保证这一点，Node 适配器由响应 close 事件保证。
	cancelled(abort: (reason: unknown) => void): void;
	/** The Web `Request`, made at the first call on the Node side. */
	// 取回完整的 Web Request。Node 侧在第一次调用时才构造，因此只读 URL/头做准入时不必复制请求体。
	request(): Request;
}

/** `request` as the component reads it. */
// 将已有 Web Request 包装为统一入口；不读请求体，也不复制请求。返回对象的方法闭包共享 request。
// 例如 header("host") 直接委托 Headers.get；cancelled 注册一次性 abort 监听，而不是创建新的网络请求。
// 函数输入是一个已经解析好的 Web Request，输出实现 Incoming 的对象字面量；不读 body、不发起网络请求。
// 真实运行时：每个方法都在需要时才访问原 Request，闭包让两者保持同一个请求对象。
export function webIncoming(request: Request): Incoming {
	// 对象字面量满足 Incoming 的结构类型；箭头函数保留外层 request 引用。
	return {
		// method 和 url 是 Request 已解析的字符串快照。
		method: request.method,
		url: request.url,
		// Headers.get 对不存在的名字返回 null，多个可合并值按 Web API 的规则读取。
		header: (name) => request.headers.get(name),
		forwarded: () => {
			// 遍历 Headers 规范化后的名字，一旦命中代理相关头就短路。
			for (const name of request.headers.keys()) if (isForwarding(name)) return true;
			// 没有命中任何代理头。
			return false;
		},
		cancelled: (abort) => {
			// 解构取得原请求信号，reason 会保留原始取消原因。
			const { signal } = request;
			// 已取消时同步通知，否则监听未来的取消；once 自动移除此监听器。
			if (signal.aborted) abort(signal.reason);
			else signal.addEventListener("abort", () => abort(signal.reason), { once: true });
		},
		// 需要请求体或完整 Headers 时，交回同一个 Request，未消费它的 body。
		request: () => request,
	};
}

/** Whether a (lowercased) header name says a proxy forwarded the request. */
// 判断已经小写的头名是否声明代理转发，无副作用；例如 x-forwarded-host 为 true，host 为 false。
export function isForwarding(name: string): boolean {
	// 精确匹配标准 Forwarded，或匹配所有 x-forwarded- 前缀的非标准头。
	return name === "forwarded" || name.startsWith("x-forwarded-");
}
