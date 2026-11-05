// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件核心（slice 10 §2；设计“HTTP core is a fetch handler”、
// “HTTP server is a native object”、“security baseline”、“settings are arguments, extensions are registries”）。
// 职责边界：把应用设置与 Http/Authenticators 注册表组装成 fetch 处理器、Node 升级适配器和宿主生命周期 facet；
// 按准入 -> 路由 -> 来源检查 -> 认证 -> 作用域 -> 响应写出 的顺序服务请求。不实现路由匹配、认证器、CSP 或监听器本身。
// 上游入口：应用调用 createHttp(host, options, context)；宿主加载 facet 后启动 HttpListener；应用也可把
// http.fetch 挂到自己的服务器，或把 http.upgrade 挂到 Node server 的 upgrade 事件。
// 下游依赖：admission（admit/isForeign/isNavigation/originAccepted/refused）、authenticate、headers（默认头与 nonce）、
// incoming（webIncoming）、node（NodeListener/NodeIncoming/connectionOf）、request（WebRequest/HttpFailure）、
// response（answerOf/webResponse）、router（composeRouter/Http/Router）、upgrades（Upgrades）。
// 结果与错误流向：serve 永不抛错；关闭/未就绪 503，准入/Origin 失败 403，非法路径 400，无路由 404，匿名访问非 public 401，
// 路由异常按 HttpFailure 状态或 500 回答，并通过 onError 报告 route_failed/wrap_failed/socket_failed/response_failed/hook_failed。
// 能力清单：
// - HttpOptions/LinksOptions：监听地址、链接端点、关闭超时和错误回调；
// - HttpError/HookName：组件报告的失败联合与钩子名；
// - HttpComponent：facet/fetch/upgrade/listening/close 五个对外能力；
// - createHttp：构建组件的入口；
// - HttpListener："chord.http.listener" 本地契约，原生值是 NodeListener；
// - 内部 Component 及其请求/升级/关闭步骤、tracked/refuse/Thrown/chainOf/tagged 辅助。
// 组合关系：createHttp -> Component 构造 -> facet.serve(Http/Authenticators/HttpListener) -> 监听器启动；
// 每个请求 fetch/serve -> #serve（准入/路由/认证）-> host.root(#run -> answerOf) -> 写出；升级走 #upgradeSteps -> Upgrades。
// 示例：const http = createHttp(host, { listen: { host: "127.0.0.1", port: 0 }, onError }, context);
//       const response = await http.fetch(new Request("http://127.0.0.1:8788/notes"), { localAddress: "127.0.0.1", localPort: 8788 });
// 建议阅读顺序：先看 HttpOptions/HttpComponent/createHttp，再看 Component 构造与 fetch/serve，随后 #serve 的流水线，
// 然后 #run/#failure/#principal，最后读升级步骤、关闭逻辑与 tracked/chainOf 等辅助函数。
// The HTTP component (slice 10 §2; decisions "The HTTP core is a fetch handler", "The HTTP server is a native object",
// "The HTTP component's security baseline", "Settings are arguments, extensions are registries"): `createHttp` takes
// the app's settings (where to listen, the links endpoint, the close bound) and builds one Web-standard handler,
// `fetch`, from the registries its facet serves (`Http`, `Authenticators`), an upgrade adapter for Node (`upgrade`), and
// the facet, whose host-lifetime listener object is Chord's own Node server. Every request is admitted (provenance), routed,
// checked for foreign origins, authenticated unless foreign, and served in one `host.root` scope with its principal
// that lasts until its body is delivered; every answer carries the default headers.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { awaitWithContext, type Context, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import { local } from "../../contracts/index.ts";
import { isChordError, type Principal } from "../../data/index.ts";
import { type Ctx, defineFacet, type Facet, type Host } from "../../host/index.ts";
import type { RegistryValue } from "../../registries/index.ts";
import {
	type Admitted,
	admit,
	type Connection,
	isForeign,
	isNavigation,
	originAccepted,
	refused,
} from "./admission.ts";
import { type AuthenticatorEntry, Authenticators, authenticate, composeAuthenticators } from "./authenticate.ts";
import { DefaultHeaders, Nonces } from "./headers.ts";
import { type Incoming, webIncoming } from "./incoming.ts";
import { connectionOf, type Handler, type ListenAddress, NodeIncoming, NodeListener, type Served } from "./node.ts";
import { HttpFailure, type HttpRequest, WebRequest } from "./request.ts";
import { type Answer, answerOf, errorAnswer, type HttpResponse, webResponse } from "./response.ts";
import { composeRouter, Http, type HttpRoute, type RouteMatch, type Router } from "./router.ts";
import { type LinkOptions, Upgrades } from "./upgrades.ts";

// 应用设置：listen 省略表示不启动自有监听器（由应用挂载 fetch）；links 配置链接端点；closeTimeout 限制关闭等待；
// onError 是唯一的错误出口，必须由应用提供。设置固定不变，修改需要重启组件。
/** What `createHttp` takes: the app's settings, fixed for the component's life (changing one is a restart). */
export type HttpOptions = {
	// port 0 让系统分配端口；listening() 会返回实际端口。
	/** Where Chord's own listener listens; none: no listener (an app mounting `fetch`). Port 0 picks one. */
	readonly listen?: ListenAddress;
	// 链接端点可给静态选项，或按请求与 principal 计算；后者在升级时调用并报告 hook_failed。
	/** The links endpoint: its path, and each socket's options, a value or per request and principal. */
	readonly links?: LinksOptions;
	// 关闭等待上限，默认 30 秒；超时后运行中的 scope 会被 abort。
	/** How long `close` waits for running requests and closing sockets: 30 s by default. */
	readonly closeTimeout?: number;
	readonly onError: (error: HttpError) => void;
};

// 链接端点：path 是升级请求的路径；options 可为静态值或函数；opened 在链接接受后调用并返回关闭清理函数。
/** The links endpoint's path and what it gives each socket (`maxPayload` 1 MiB by default). */
export type LinksOptions = {
	readonly path: string;
	readonly options?: LinkOptions | ((request: HttpRequest, principal: Principal) => LinkOptions);
	/**
	 * Called when a link is accepted, with its request and principal; what it returns is called when that link closes
	 * (the app tracking its clients' links: the kit ends an ephemeral session with its last link).
	 */
	readonly opened?: (request: HttpRequest, principal: Principal) => (() => void) | undefined;
};

/** What the component reports. */
// 组件报告的错误联合：route_failed/wrap_failed/socket_failed/response_failed/hook_failed。
// 这些对象只记录定位信息和原始 error，不携带客户端响应内容；错误消息不会直接发给客户端。
export type HttpError =
	| { readonly kind: "route_failed"; readonly pattern: string; readonly plugin: string; readonly error: unknown }
	| { readonly kind: "wrap_failed"; readonly name: string; readonly plugin: string; readonly error: unknown }
	| { readonly kind: "socket_failed"; readonly pattern: string; readonly plugin: string; readonly error: unknown }
	/** A response that could not be made (an invalid header, no JSON) or read whole (a `bytes` read that threw). */
	| { readonly kind: "response_failed"; readonly pattern: string; readonly error: unknown }
	/** A contributed hook threw (`plugin`), or the app's `links.options` (no plugin). */
	| { readonly kind: "hook_failed"; readonly hook: HookName; readonly plugin?: string; readonly error: unknown };

/** The hooks the component calls. */
// 可能失败的钩子名：认证器、中继 verify、链接选项函数、链接打开回调。
export type HookName = "authenticate" | "relay" | "links.options" | "links.opened";

/** The running component. */
// 运行中组件的对外接口：facet 交给宿主；fetch 处理 Web 请求；upgrade 处理 Node Upgrade；
// listening 返回实际地址；close 停止接收并排空/封口。
export interface HttpComponent<P extends Principal> {
	// facet 在每次插件 reload 时保持同一个对象；它服务 Http/Authenticators，并在配置了 listen 时服务监听器。
	/**
	 * Its facet (plugin `chord.http`): serves `Http` and `Authenticators`, and with `listen` the listener, a
	 * host-lifetime object. The app loads it among its core facets, the same object at every reload.
	 */
	readonly facet: Facet<P>;
	// fetch 可被任意 Web 服务器挂载；connection 决定 local 判定，缺少 localAddress/localPort 时永远不会是 local。
	// host.load 之前 registry 抛 not_ready，fetch 立即回答 503，不等待加载。
	/**
	 * Answers a Web `Request` (an app's own server mounts it: `hono.all("/*", (c) => http.fetch(c.req.raw, …))`);
	 * `connection` is what the server knows of the socket: without `localAddress` and `localPort` no request is local.
	 * Requests before the host's `load` answer 503 at once (its `host.registry` throws `not_ready` then).
	 */
	fetch(request: Request, connection?: Connection): Promise<Response>;
	// upgrade 的签名与 server.on("upgrade", ...) 完全一致；内部错误只销毁套接字。
	/** Node's upgrade adapter (`server.on("upgrade", http.upgrade)`): the links endpoint and plugin sockets. */
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
	// listening 在监听成功后 resolve；close 或监听失败会 reject，等待受传入 context 取消约束。
	/** Where the listener listens, once it does (the real port when `listen.port` was 0). */
	listening(context: Context): Promise<ListenAddress>;
	// close 的顺序很重要：先拒绝新请求/升级，再关闭套接字和链接，等待运行中的请求到上限，最后封口作用域。
	// 应在 host.close 之前调用，否则宿主会立即封口所有请求作用域，来不及排空。
	/**
	 * Refuses new requests and upgrades (503), closes sockets and links (1001, terminated at `closeTimeout`), waits for
	 * running requests up to `closeTimeout` (an aborted `context`: not at all), then seals them. Run it before
	 * `host.close`, which seals every request's scope at once (the listener's close runs it then, too late to drain).
	 */
	close(context: Context): Promise<void>;
}

// 函数用途：创建 HTTP 组件。输入宿主、固定设置和组件上下文，输出 HttpComponent；实例构造时注册 facet。
// 泛型 P 让 principal 类型与宿主一致；组件本身不实现认证器，只按注册表值调用并把 principal 传给路由作用域。
/** Builds the HTTP component on `host` (a request's scope is a `host.root` with its principal). */
export function createHttp<P extends Principal>(
	host: Host<P>,
	options: HttpOptions,
	context: Context,
): HttpComponent<P> {
	return new Component(host, options, context);
}

// 本地契约：插件 chord.http、版本 1、无参数/成员；原生值是监听器对象。
// 它让监听器拥有宿主生命周期：facet open 时启动，facet close 时停止并关闭组件。
/** The listener: a host-lifetime object of plugin `chord.http` whose native is Chord's own Node server. */
export const HttpListener = local("chord.http.listener", { version: 1, params: {}, members: {} });

/** The registries a request reads, resolved once. */
// 一次解析得到的两个注册表值：Router 和认证器数组；后续请求复用，注册表变化由 Router watch 处理。
type Registries = {
	readonly router: RegistryValue<Router>;
	readonly authenticators: RegistryValue<readonly AuthenticatorEntry[]>;
};

/** A request or an upgrade from its arrival to its end: what `close` waits for, then seals. */
// 一个进行中的请求或升级：controller 用于关闭时封口，done 是组件 close 等待的完成信号。
type Running = { readonly controller: AbortController; done: Promise<unknown> };

/** `close`'s bound unless `closeTimeout` says otherwise: 30 s. */
// 默认关闭等待 30 秒；超时后 abort 所有 running controller。
const CLOSE_TIMEOUT = 30_000;

/** Who threw out of a route itself (no wrap). */
// 路由直接抛错的标记（没有包装器）；as const 让 kind 收窄为字面量 "route"。
const ROUTE = { kind: "route" } as const;

// 组件实现：既是对外 HttpComponent，也是 Node 监听器需要的 Handler；所有字段私有，facet 与 upgrade 公开。
class Component<P extends Principal> implements HttpComponent<P>, Handler {
	readonly facet: Facet<P>;
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
	readonly #host: Host<P>;
	readonly #options: HttpOptions;
	readonly #onError: (error: HttpError) => void;
	readonly #context: Context;
	/** The component's context without its cancellation: each request's scope adds its own signal. */
	// #base 是去掉调用方取消信号的上下文；每个请求再用 withAbortSignal 加自己的 controller，避免父取消误伤所有请求。
	readonly #base: Context;
	// 每个组件一份默认头生成器和 nonce 池；#upgrades 管理 WebSocket；#running 是关闭时要等待的集合。
	readonly #defaults = new DefaultHeaders();
	readonly #nonces = new Nonces();
	readonly #upgrades = new Upgrades();
	readonly #running = new Set<Running>();
	// 注册表解析 Promise 缓存：成功后用 #registries；失败时清空 #resolving，允许下一次请求重试。
	/** The registries while they resolve (once; again after a failed try), then the values themselves. */
	#resolving: Promise<Registries> | undefined;
	#registries: Registries | undefined;
	/** Aborted at `close`: the router's watch. */
	// #closing 是组件级取消：close 时 abort，用于停止 router watch 并让新请求回答 503。
	readonly #closing = new AbortController();
	#closed: Promise<void> | undefined;
	// listening 的 Promise.withResolvers：监听成功/失败或 close 时 settle；提前 catch 防止未处理 rejection。
	readonly #listening = Promise.withResolvers<ListenAddress>();

	// 构造函数：保存依赖，建立“去取消”的基础上下文，配置 upgrade 包装器和 facet。
	// 副作用：定义 facet（但监听器实际启动发生在宿主 open）；不立即监听端口。
	constructor(host: Host<P>, options: HttpOptions, context: Context) {
		this.#host = host;
		this.#options = options;
		this.#onError = options.onError;
		this.#context = context;
		this.#base = withoutAbortSignal(context);
		// 提前挂 catch：组件从未监听就 close 时，listening() 的 reject 不应成为未处理拒绝。
		this.#listening.promise.catch(() => {});
		// upgrade 包装器把同步错误和异步拒绝都转成 socket.destroy，满足 EventEmitter 回调不抛错的约定。
		this.upgrade = (message, socket, head) => {
			socket.on("error", () => socket.destroy());
			void this.#upgrade(message, socket, head).catch(() => socket.destroy());
		};
		const { listen } = options;
		// defineFacet 注册服务提供者：Http 与 Authenticators 总是服务；HttpListener 只在配置了 listen 时服务。
		this.facet = defineFacet<P>((facet) => {
			// composeRouter 是纯同步组合函数；注册表每次变化时由框架调用。
			facet.serve(Http, { compose: composeRouter });
			facet.serve(Authenticators, { compose: composeAuthenticators });
			// 未配置监听器时 facet 仍然提供 fetch/upgrade，应用可以自行挂载。
			if (listen === undefined) return;
			// 监听器作为本地对象服务：open 启动 NodeListener，close 先 stop 再关闭组件并等待连接关闭。
			facet.serve(HttpListener, (_params, self) => {
				self.open(
					// open 回调返回本地对象接口；这里没有成员，监听器地址通过 listening() 暴露。
					(opening) => this.#listen(listen, opening),
					async (listener, _reason, closing) => {
						listener.stop();
						await this.close(closing);
						await listener.closed();
					},
				);
				return {};
			});
		});
	}

	// 函数用途：处理一个 Web Request。输入请求和可选连接信息，输出标准 Response；永不抛错。
	// 流程：交给 serve 得到 Answer -> 若是拉取流则用 tracked 包装，读完才结束作用域；整段 body 则立即 finished。
	// 例子：await http.fetch(request, { localAddress: "127.0.0.1", localPort: 8788 })。
	async fetch(request: Request, connection: Connection = {}): Promise<Response> {
		const { answer, finished } = await this.serve(webIncoming(request), connection);
		// 整段 body 的 Response 一旦返回就脱离组件控制；拉取流则必须在消费者读完/取消后结束作用域。
		// A whole body is out of the component's hands once its `Response` is; a pulled one ends when it is read.
		// tracked 只包 ReadableStream；字符串/null body 不需要跟踪。
		if (answer.body instanceof ReadableStream)
			return webResponse({ ...answer, body: tracked(answer.body, finished) });
		finished();
		return webResponse(answer);
	}

	// 函数用途：等待监听地址。输入调用方上下文，输出 ListenAddress；close 或监听失败时 reject。
	// awaitWithContext 只取消等待者，不会取消底层监听动作。
	listening(context: Context): Promise<ListenAddress> {
		return awaitWithContext(this.#listening.promise, context);
	}

	// 函数用途：关闭组件。输入调用方上下文，输出完成 Promise；多次调用共享同一个 #closed Promise。
	close(context: Context): Promise<void> {
		this.#closed ??= this.#close(context);
		return this.#closed;
	}

	// 函数用途：服务一个 Incoming 请求。输入组件读取的请求和连接信息，输出 Served（Answer + finished）。
	// 永不抛错：注册表解析失败、内部异常都转成 503/500 的 Answer；副作用是登记 running 并注册断开回调。
	/**
	 * Serves `request`: its answer, and what its consumer calls once the body is written or abandoned. Never throws:
	 * whatever fails answers (503 before the host's `load` or while closing, 403, 404, 500 reported).
	 */
	async serve(request: Incoming, connection: Connection): Promise<Served> {
		// controller 与 finished 共同描述请求生命周期：前者用于强制封口，后者由响应消费者调用。
		const controller = new AbortController();
		const finished = Promise.withResolvers<void>();
		// running 先加入集合，保证 close 能看到它；done 初始为 finished，若获得作用域则改为等待作用域。
		const running: Running = { controller, done: finished.promise };
		this.#running.add(running);
		// 客户端提前离开时 abort controller；拉取流和 host.root 作用域都监听这个信号。
		request.cancelled((reason) => controller.abort(reason));
		let answer: Answer;
		// #serve 内部按预期返回 Answer；真正未捕获的异常在这里兜底成 500，避免监听器拿到 rejected Promise。
		try {
			const served = await this.#serve(request, connection, controller, finished.promise);
			answer = served.answer;
			// 有作用域时请求要等“响应写完”和“作用域结束”两者；Scope 结束通常意味着路由的清理完成。
			// The request is over once its consumer finished and its scope (if it got one) ended.
			if (served.scope !== undefined) running.done = Promise.all([finished.promise, served.scope]);
		} catch {
			// 这里兜底未预期异常并回答 500；本层不报告 onError，具体失败通常已在 #run 或 #serve 报告。
			answer = this.refusal(500);
		}
		// running.done 完成后从集合移除；void 表示不等待删除本身。
		void running.done.then(() => this.#running.delete(running));
		return { answer, finished: () => finished.resolve() };
	}

	// 函数用途：生成拒绝/失败响应。输入状态、可选准入结果、可选路由器和是否 HEAD；输出 Answer。
	// 使用默认安全头和新的 nonce；admitted/router 提供 CSP 来源，拒绝前可能没有。
	// 例子：refusal(404) => 404 + Not Found + 默认头。
	/** The answer for a refused or failed request, outside any scope, with the default headers. */
	refusal(status: number, admitted?: Admitted, router?: Router, head = false): Answer {
		return errorAnswer(status, this.#defaults.of(admitted, router, this.#nonces.next()), undefined, head);
	}

	// 私有方法：请求流水线。输入 Incoming、连接、controller 和 finished，输出 Answer 与可选作用域 Promise。
	// 顺序：关闭检查 -> 注册表 -> 准入 -> 构造 WebRequest/路由 -> Origin 检查 -> 认证 -> 默认拒绝 -> host.root 执行。
	/** The steps of `serve`: closing, the registries, admission, the route, origins, the principal, then the scope. */
	async #serve(
		request: Incoming,
		connection: Connection,
		controller: AbortController,
		finished: Promise<void>,
	): Promise<{ readonly answer: Answer; readonly scope?: Promise<void> }> {
		// HEAD 只用于错误/拒绝响应时省略 body；正常 HEAD 由 answerOf 处理。
		const head = request.method === "HEAD";
		// 组件开始关闭后不再接收新请求，直接 503；注册表解析前后各查一次，覆盖解析期间开始关闭的情况。
		if (this.#closing.signal.aborted) return { answer: this.refusal(503, undefined, undefined, head) };
		let registries: Registries;
		try {
			// 注册表只解析一次；失败（宿主未 load）回答 503，不把 not_ready 暴露给客户端。
			registries = this.#registries ?? (await this.#resolve());
		} catch {
			return { answer: this.refusal(503, undefined, undefined, head) };
		}
		if (this.#closing.signal.aborted) return { answer: this.refusal(503, undefined, undefined, head) };
		// 路由器是请求开始时的快照；即使之后 reload，本次请求仍使用旧 Router。
		const router = registries.router.value;
		// 准入是第一个安全边界：决定来源、origin 与 framer，不通过则 403。
		const admission = admit(request, connection, router.hosts, router.relays);
		if (refused(admission)) {
			// 中继 verify 抛错/返回非法来源的详情交给 onError 报告为 hook_failed；普通拒绝没有 failed。
			if (admission.failed !== undefined) this.#hookFailed("relay", admission.failed.relay, admission.failed.error);
			return { answer: this.refusal(403, undefined, router, head) };
		}
		// 每个响应一个新 nonce，与默认头 CSP 中的 'nonce-...' 对应。
		// A fresh script nonce per response (decision "A CSP nonce per response").
		const webRequest = new WebRequest(request, admission, this.#nonces.next(), connection.remoteAddress);
		// 路由查询使用原始 method 与解码后的 path；HEAD 的回退在 Router 内部处理。
		const match = router.route(request.method, webRequest.path);
		// 未匹配 -> 404；路径解码失败/参数含路径字符 -> 400。两者都在认证前，且带准入信息生成 CSP。
		if (match === "bad_path" || match === undefined) {
			return { answer: this.refusal(match === undefined ? 404 : 400, admission, router, head) };
		}
		// 把匹配参数写回请求，路由/包装器/认证器都能读取。
		webRequest.params = match.params;
		// foreign 由 Fetch Metadata 判定，后续决定是否认证以及是否允许 bytes 下载。
		const foreign = isForeign(request);
		// crossSite 路由跳过 Origin 检查（webhook 等场景）；其余请求的 Origin 必须可接受（缺失时按方法与 Fetch Metadata 判断）或与 admission.origin 相等。
		if (!match.crossSite && !originAccepted(request.method, request, admission.origin)) {
			return { answer: this.refusal(403, admission, router, head) };
		}
		// 认证结果先置为 undefined（匿名）；只有满足条件时才调用认证器。
		let principal: P | undefined;
		// 认证条件：存在认证器、不是 crossSite、且（不是外来请求 或 是页面路由的顶层导航）。
		// 外站嵌入/脚本请求永远不会被认证，避免跨站请求借用用户凭据。
		// Foreign requests are never authenticated but a top-level navigation to a page; a cross-site route never is.
		const authenticators = registries.authenticators.value;
		if (
			authenticators.length > 0 &&
			!match.crossSite &&
			(!foreign || (match.page && isNavigation(request.method, request)))
		) {
			// 认证器通过注册表顺序执行；传入 controller.signal，使断开/关闭能竞速取消等待。
			principal = await this.#principal(registries, webRequest, controller.signal);
			// 认证期间组件开始关闭或客户端断开：不再执行路由，回答 503。
			if (this.#closing.signal.aborted || controller.signal.aborted) {
				return { answer: this.refusal(503, admission, router, head) };
			}
		}
		// 默认拒绝：没有 principal 且路由不是 public，插件代码不会运行，回答 401。
		// Deny by default (decision "The app kit, point 3"): no plugin code runs for nobody unless the route is public.
		if (principal === undefined && !match.public) return { answer: this.refusal(401, admission, router, head) };
		// answered 让 #serve 等待 host.root 内的路由结果；作用域封口时由 catch 兜底回答 503。
		const answered = Promise.withResolvers<Answer>();
		// 每个请求一个 host.root 作用域：principal 进入 ctx，controller 信号与基础上下文合并；
		// 作用域一直持续到响应 body 写完（finished），bytes 读取就在其中进行。
		const scope = this.#host
			.root(
				async (ctx) => {
					// #run 返回 Answer 后立即 resolve，调用方无需等作用域结束就能开始写响应。
					answered.resolve(await this.#run(request, webRequest, match, admission, router, foreign, ctx));
					// The scope lasts until the body is written or abandoned (a `bytes` body reads in it).
					// 等待响应写出/放弃；这是作用域保持存活的原因。
					await finished;
				},
				// withAbortSignal(controller.signal, #base) 组合组件基础上下文和请求取消；principal 可为 undefined。
				withAbortSignal(controller.signal, this.#base),
				{ principal },
			)
			// 作用域在回答前被关闭（断开/close）：resolve 503，保证 answered 不会永远挂起。
			.catch(() => {
				// The scope was sealed (a disconnect, `close`) before it answered: the request is over.
				answered.resolve(this.refusal(503, admission, router, head));
			});
		// 返回 Answer 和作用域 Promise；serve 会把两者都纳入 running.done。
		return { answer: await answered.promise, scope };
	}

	/** Runs the wraps and the route in the request's scope `ctx`, and makes its answer (a failure: a reported 500). */
	// 私有方法：在请求作用域内运行包装器链与路由，并生成 Answer。输入 Incoming、WebRequest、匹配、准入、
	// 路由器、foreign 和 ctx；输出 Answer。异常在这里转成 #failure 描述，不向作用域外抛。
	async #run(
		incoming: Incoming,
		request: WebRequest,
		match: RouteMatch,
		admitted: Admitted,
		router: Router,
		foreign: boolean,
		ctx: Ctx<P>,
	): Promise<Answer> {
		let response: HttpResponse;
		// chainOf 从最外层包装器到路由逐层调用；包装器可以替换响应或抛出。
		try {
			response = await chainOf(match, ctx)(request);
			// 路由/包装器异常不直接抛出，而是交给 #failure 决定状态并报告；保持 serve 永不抛错。
		} catch (error) {
			response = this.#failure(error, match);
		}
		// bytes 下载对外来请求一律 403：即使路由是 public/page，也不让其他站点拉取文件；在读取前替换响应。
		// Downloads are never another site's to take (rule 6).
		if (response.kind === "bytes" && foreign) response = { kind: "error", status: 403 };
		// failed 回调专门报告 response_failed：bytes 读取失败发生在响应头之后，无法再改状态码。
		const failed = (error: unknown): void =>
			this.#onError({ kind: "response_failed", pattern: match.pattern, error });
		// answerOf 合并默认头与路由头并生成 body；可能抛非法头/JSON 序列化错误。
		try {
			return answerOf(response, incoming, this.#defaults.of(admitted, router, request.nonce), ctx, failed);
			// 生成失败时报告并回答 500；HEAD 请求保持不写 body。
		} catch (error) {
			failed(error);
			return this.refusal(500, admitted, router, request.method === "HEAD");
		}
	}

	// 私有方法：把链路异常翻译成错误响应。输入任意 error 和匹配信息，输出 HttpResponse 描述。
	// 规则：Thrown 保留抛出者；HttpFailure 用其 status；ChordError forbidden -> 403；其余报告 route_failed/wrap_failed 并 500。
	// 500 不携带原始错误消息，避免泄露内部细节。
	/** What an error escaping the chain answers: its `HttpFailure`'s status, else a reported 500 without its message. */
	#failure(error: unknown, match: RouteMatch): HttpResponse {
		// 非 Thrown（理论上少见）按路由直接抛错处理；ROUTE 是共享的 {kind:"route"} 标记。
		const thrown = error instanceof Thrown ? error : new Thrown(ROUTE, match.plugin, error);
		// HttpFailure 是应用主动给出的 HTTP 语义（400/413 等），直接采用状态码。
		if (thrown.cause instanceof HttpFailure) return { kind: "error", status: thrown.cause.status };
		// Chord refused the caller (an anonymous scope's remote object, a route's `authorize`): no failure of the route.
		// Chord 的 forbidden 表示调用方权限不足，回答 403 而不是 500；不报告为路由失败。
		if (isChordError(thrown.cause, "forbidden")) return { kind: "error", status: 403 };
		// 按抛出位置分别报告：路由本身 -> route_failed；包装器 -> wrap_failed（带包装器名字）。
		if (thrown.by.kind === "route") {
			this.#onError({ kind: "route_failed", pattern: match.pattern, plugin: thrown.plugin, error: thrown.cause });
		} else {
			this.#onError({ kind: "wrap_failed", name: thrown.by.name, plugin: thrown.plugin, error: thrown.cause });
		}
		return { kind: "error", status: 500 };
	}

	// 私有方法：取得 principal。输入注册表、请求和取消信号，输出 principal 或 undefined。
	// authenticate 逐项执行；awaitWithContext 让等待与 signal 竞速，认证器忽略取消也不会拖住请求；
	// 竞速失败被 catch 成 undefined，调用方随后检查 signal 并回答 503。
	/**
	 * The principal the authenticators give `request`; one that throws is reported and skipped. Raced against `signal`
	 * (a disconnect, `close`'s seal): an authenticator ignoring it no longer holds the request; the caller sees the
	 * abort and answers 503.
	 */
	async #principal(registries: Registries, request: HttpRequest, signal: AbortSignal): Promise<P | undefined> {
		const failed = (plugin: string, error: unknown): void => this.#hookFailed("authenticate", plugin, error);
		// 认证上下文组合请求信号和组件基础上下文；每个认证器看到同一个上下文。
		const context = withAbortSignal(signal, this.#base);
		const authenticating = authenticate(registries.authenticators.value, request, failed, context);
		// The registry's values are typed by no principal type: an app's authenticators return its principals.
		// 注册表值没有 principal 类型参数，as P 是把应用认证器的返回类型接回宿主类型；运行时不做检查。
		return (await awaitWithContext(authenticating, context).catch(() => undefined)) as P | undefined;
	}

	// 私有方法：把钩子失败转成统一的 hook_failed 报告；plugin 缺省表示应用自己的钩子（links.options/opened）。
	#hookFailed(hook: HookName, plugin: string | undefined, error: unknown): void {
		this.#onError({ kind: "hook_failed", hook, ...(plugin === undefined ? {} : { plugin }), error });
	}

	// 私有方法：解析注册表。输入无，输出 Registries Promise；成功缓存，#follow 监听路由器变化。
	// 失败时清空 #resolving，让下一次请求重试（例如宿主稍后 load）。
	/** The registries: resolved once, after the host's `load` (`not_ready` before it); a failed try is tried again later. */
	// ??= 保证并发请求共享同一次解析；Promise.all 并行取两个注册表值。
	#resolve(): Promise<Registries> {
		this.#resolving ??= Promise.all([
			this.#host.registry(Http, this.#context),
			this.#host.registry(Authenticators, this.#context),
		]).then(
			// 成功后保存值并启动 router watch；follow 的失败被忽略：关闭可能先发生，watch 没有必要再启动。
			([router, authenticators]) => {
				this.#registries = { router, authenticators };
				// A close may come first: nothing to follow then (Astra's recheck R4: the stopped watch threw unhandled).
				this.#follow(router).catch(() => {});
				return this.#registries;
			},
			// 失败分支重置缓存后再抛，调用方回答 503。
			(error: unknown) => {
				this.#resolving = undefined;
				throw error;
			},
		);
		return this.#resolving;
	}

	// 私有方法：跟随路由器直到组件关闭。输入 RegistryValue<Router>，无返回值；变化时撤销不再被承认的连接。
	/** Follows the router until `close`: connections its changes no longer admit are terminated. */
	async #follow(router: RegistryValue<Router>): Promise<void> {
		// 关闭已经开始：不启动 watch，避免拿着已取消的上下文等待。
		if (this.#closing.signal.aborted) return;
		// watch 需要组件关闭信号与基础上下文；await 期间可能开始关闭。
		const watch = await router.watch(withAbortSignal(this.#closing.signal, this.#base));
		if (this.#closing.signal.aborted) return;
		// call.kind === "value" 表示完成了一次新组合；把新 Router 交给 Upgrades.revoke。
		watch.start(async (call) => {
			if (call.kind === "value") this.#upgrades.revoke(call.value);
		});
	}

	// 私有方法：处理一次 Node upgrade。输入消息/流/head，无返回值；负责跟踪工作并在关闭时被等待。
	// 客户端在认证期间断开也要能中止：除了 close，还要监听 end 并 read(0) 触发读取侧关闭检测。
	/** One upgrade, tracked from its arrival: refused while closing, else admitted and checked, then handed out. */
	async #upgrade(message: IncomingMessage, stream: Duplex, head: Buffer): Promise<void> {
		const controller = new AbortController();
		// A client gone while its upgrade authenticates aborts that work (Astra's recheck R1, Sol's N5).
		// 断开原因写入 controller，认证/作用域看到的是普通 Error。
		const gone = (): void => controller.abort(new Error("http: the client disconnected"));
		// 套接字已销毁直接取消；否则监听 close（RST/销毁）与 end（FIN）。
		if (stream.destroyed) gone();
		else {
			// A clean disconnect (FIN) is seen only by reading: nothing reads a detached upgrade socket, so start it
			// (Fable's second recheck: `end()` while authenticating went unnoticed).
			// 分离的升级套接字没有读者，'end' 只有开始读取后才会被观察到；read(0) 启动该检测。
			stream.once("close", gone);
			stream.once("end", gone);
			stream.read(0);
		}
		// running 先以已完成的 done 占位，随后替换成实际工作 Promise，保证 close 的等待列表完整。
		const running: Running = { controller, done: Promise.resolve() };
		const work = this.#upgradeSteps(message, stream, head, controller.signal);
		running.done = work;
		this.#running.add(running);
		// finally 清理监听并移除 running；无论工作成功、拒绝还是被关闭。
		try {
			await work;
		} finally {
			stream.removeListener("close", gone);
			stream.removeListener("end", gone);
			this.#running.delete(running);
		}
	}

	// 私有方法：升级的完整步骤。输入消息/流/head/信号，无返回值；失败时用 HTTP 错误行拒绝并关闭流。
	// 与普通请求相同的顺序：关闭检查 -> 线上转换 -> 注册表 -> 准入 -> Origin -> 认证 -> 路由器复核 -> links 或 socket。
	/** The steps of an upgrade (the same rules as a request's; a socket needs a principal), checked again at hand-out. */
	async #upgradeSteps(message: IncomingMessage, stream: Duplex, head: Buffer, signal: AbortSignal): Promise<void> {
		// 关闭中不再接受升级；refuse 直接写 HTTP 状态行并关闭字节流。
		if (this.#closing.signal.aborted) return refuse(stream, 503);
		const request = NodeIncoming.of(message);
		// 线上转换失败沿用 NodeIncoming.of 的状态（400/403/501）。
		if (!(request instanceof NodeIncoming)) return refuse(stream, request.status);
		let registries: Registries;
		try {
			registries = this.#registries ?? (await this.#resolve());
		} catch {
			return refuse(stream, 503);
		}
		// 认证/解析期间组件关闭或客户端断开：503。
		if (this.#closing.signal.aborted || signal.aborted) return refuse(stream, 503);
		// before 是准入和认证使用的路由器快照；认证完成后会再取一次当前值复核。
		const before = registries.router.value;
		const connection = connectionOf(message);
		const admission = admit(request, connection, before.hosts, before.relays);
		if (refused(admission)) {
			if (admission.failed !== undefined) this.#hookFailed("relay", admission.failed.relay, admission.failed.error);
			return refuse(stream, 403);
		}
		const sent = request.header("origin");
		// 升级不做 crossSite 例外：外来请求或 Origin 与准入来源不一致一律 403。
		// 没有 Origin 的客户端允许通过，但外来 Fetch Metadata 仍会被 isForeign 拒绝。
		if (isForeign(request) || (sent !== null && sent !== admission.origin)) return refuse(stream, 403);
		// 升级请求也生成 nonce/WebRequest，供 links.options、opened 和插件处理器读取。
		const webRequest = new WebRequest(request, admission, this.#nonces.next(), connection.remoteAddress);
		// 认证与普通请求相同；links 端点稍后要求必须有 principal，插件套接字则由 public 决定。
		const principal = await this.#principal(registries, webRequest, signal);
		if (this.#closing.signal.aborted || signal.aborted) return refuse(stream, 503);
		// The router now: a host, a relay or a socket removed while authenticating refuses the upgrade.
		// 复核路由器：认证期间域名/中继可能被移除，已准入的连接不能再交给新的路由器。
		const router = registries.router.value;
		const { allowed, relay } = admission;
		// allowed 域名或 relay 已不在当前 Router 中：拒绝；这防止撤销前建立的升级继续使用。
		if (
			(allowed !== undefined && !router.hosts.has(allowed)) ||
			(relay !== undefined && !router.relays.includes(relay))
		) {
			return refuse(stream, 403);
		}
		// 先判断 links 端点；它的路径优先于插件套接字。
		const { links } = this.#options;
		if (links !== undefined && webRequest.path === links.path) {
			// The links endpoint always needs a principal: a link acts as one.
			// 链接代表一个 principal，匿名连接不能建立链接。
			if (principal === undefined) return refuse(stream, 401);
			let options: LinkOptions;
			// 选项可以是静态对象或函数；函数抛错报告 hook_failed 并拒绝 403。
			try {
				options =
					// ?? {} 把 undefined 选项统一成空对象；admitted 合并允许/中继/principal 与链接选项。
					(typeof links.options === "function" ? links.options(webRequest, principal) : links.options) ?? {};
			} catch (error) {
				this.#hookFailed("links.options", undefined, error);
				return refuse(stream, 403);
			}
			const admitted = { allowed, relay, principal, ...options };
			// opened 包装：应用回调抛错只报告 hook_failed，不阻止链接建立；返回值作为关闭清理函数。
			const opened = (): (() => void) | undefined => {
				try {
					return links.opened?.(webRequest, principal);
				} catch (error) {
					this.#hookFailed("links.opened", undefined, error);
					return undefined;
				}
			};
			// 交给 Upgrades.link；它完成 ws 升级、登记撤销信息并调用 host.accept。
			return this.#upgrades.link(message, stream, head, admitted, this.#host, this.#context, opened);
		}
		// 不是 links 路径时按插件套接字路由；bad_path 表示模式参数解码非法。
		const match = router.socket(webRequest.path);
		if (match === "bad_path") return refuse(stream, 400);
		if (match === undefined) return refuse(stream, 404);
		// 插件套接字默认拒绝匿名；public 才允许 principal 为 undefined。
		if (principal === undefined && !match.public) return refuse(stream, 401);
		// 把套接字模式参数写入请求，处理器与认证器都可读取。
		webRequest.params = match.params;
		// 处理器失败回调：报告 socket_failed，然后 Upgrades.socket 以 1011 关闭。
		const fail = ({ pattern, plugin, error }: { pattern: string; plugin: string; error: unknown }) =>
			this.#onError({ kind: "socket_failed", pattern, plugin, error });
		const admitted = { allowed, relay, principal, match, request: webRequest };
		// 交给 Upgrades.socket；它建立独立作用域并运行处理器。
		this.#upgrades.socket(message, stream, head, admitted, this.#host, this.#context, fail);
	}

	// 私有方法：启动监听器。输入地址和 open 上下文，输出 NodeListener；成功时 resolve listening 地址。
	/** The listener's open: Chord's own Node server listening at `listen`. */
	async #listen(listen: ListenAddress, context: Context): Promise<NodeListener> {
		const listener = await NodeListener.listen(this, listen, context);
		this.#listening.resolve(listener.address);
		return listener;
	}

	// 私有方法：关闭实现。输入调用方上下文，无返回值。
	// 流程：标记 closing -> listening reject -> 计算 deadline（超时或调用方取消）-> 并行关闭升级和等待运行请求 ->
	// 清理定时器/监听 -> abort 所有仍运行的 controller。
	/** `close`: refuses from now on, then waits for sockets and running requests until the deadline, then seals. */
	async #close(context: Context): Promise<void> {
		// 先 abort #closing：新请求立即 503，router watch 停止，升级路径也检查它。
		this.#closing.abort();
		// 未监听或监听中的 listening() 等待者收到 reject；提前 catch 已避免未处理拒绝。
		this.#listening.reject(new Error("http: closed"));
		// closeTimeout 可被应用覆盖；默认 30 秒。
		const timeout = this.#options.closeTimeout ?? CLOSE_TIMEOUT;
		const signal = context.abortSignal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let aborted: (() => void) | undefined;
		// deadline 在超时或调用方取消时 resolve；已取消则立即完成，不等待。
		const deadline = new Promise<void>((resolve) => {
			// Already aborted: no wait at all (Sol's recheck N9).
			if (signal?.aborted) return resolve();
			// timer 与 aborted 只在未提前取消时设置；清理时需要判断。
			timer = setTimeout(resolve, timeout);
			aborted = () => resolve();
			signal?.addEventListener("abort", aborted, { once: true });
		});
		// 快照 running 的 done；等待期间集合可能增减，但 close 之后不应有新请求/升级。
		const running = Promise.all([...this.#running].map(({ done }) => done));
		// 同时等待升级关闭与运行请求，或 deadline；先到者决定何时强制封口。
		await Promise.race([Promise.all([this.#upgrades.close(deadline), running]), deadline]);
		clearTimeout(timer);
		// 清理定时器和 abort 监听，避免关闭完成后仍持有资源。
		if (aborted !== undefined) signal?.removeEventListener("abort", aborted);
		// 仍未完成的请求/升级：abort controller，让拉取流和 host.root 作用域结束。
		for (const { controller } of this.#running) controller.abort(new Error("http: closed"));
	}
}

// 函数用途：包装拉取式 body，确保消费者读完、流 error 或取消时调用 finished。输入流和完成回调，输出新流。
// 为什么需要：Web Response 可能被应用长期持有；若消费者不再读，请求作用域也必须最终结束。
// 例子：tracked(body, finished) 在 reader.closed 时调用 finished，即使外层没人再 pull。
/**
 * `stream` as read by its consumer, `finished` called once it is read to its end, failed or cancelled (a mounted
 * handler's `bytes` body: the request's scope lasts until then).
 */
function tracked(stream: ReadableStream<Uint8Array>, finished: () => void): ReadableStream<Uint8Array> {
	// 取得底层流的 reader；新流从它逐块转发。
	const reader = stream.getReader();
	// The owned stream ending (read whole, or errored by the scope's seal) ends the request too, whether or not its
	// consumer pulls again (Sol's second recheck B: an aborted `Response` nobody touched kept its request and scope).
	// reader.closed 在正常关闭或 error 时 settle；两个分支都调用 finished，防止作用域泄漏。
	reader.closed.then(finished, finished);
	return new ReadableStream<Uint8Array>(
		// 新流 highWaterMark 0：不预读，只有外层 pull 才向底层要数据。
		{
			pull: async (controller) => {
				// pull 转发一次读取；done 时关闭并 finished，出错时 error 并 finished。
				try {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						finished();
					} else {
						controller.enqueue(next.value);
					}
				} catch (error) {
					controller.error(error);
					finished();
				}
			},
			// cancel 先 finished 再取消底层 reader；顺序保证即使底层取消失败，请求也已结束。
			cancel: async (reason) => {
				finished();
				await reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

// 函数用途：用原始 HTTP/1.1 响应行拒绝升级并关闭流。输入 Duplex 和状态码，无返回值。
// 升级请求没有 ServerResponse，因此手写状态行、Connection: close 和 Content-Length: 0。
/** Refuses an upgrade with `status` and closes its connection. */
function refuse(stream: Duplex, status: number): void {
	stream.end(`HTTP/1.1 ${status} ${STATUS[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// 升级拒绝可用的状态短语；未知状态退化为空串（仍能形成合法状态行）。
/** The reason phrases of the statuses an upgrade is refused with. */
const STATUS: Readonly<Record<number, string>> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	501: "Not Implemented",
	503: "Service Unavailable",
};

// 内部错误：记录异常来自路由还是包装器（名字），以及插件名；cause 保存原始异常。
// 它只在请求链路内部使用，不会发给客户端。
/** Who threw out of a request's chain: the route, or a wrap (by name), with its plugin. */
class Thrown extends Error {
	readonly by: { readonly kind: "route" } | { readonly kind: "wrap"; readonly name: string };
	readonly plugin: string;

	constructor(by: Thrown["by"], plugin: string, cause: unknown) {
		super("thrown", { cause });
		this.by = by;
		this.plugin = plugin;
	}
}

// 函数用途：把匹配的包装器链和路由组合成一个调用函数。输入 RouteMatch 和 ctx，输出 (request) => Promise<HttpResponse>。
// match.wraps 是最外层在前；从数组末尾向前包裹，使第一个 wrap 最终位于最外层。
// 每个 wrap 捕获内层异常并标记自己的名字；已经是 Thrown 的异常保持原归属。
/** The route of `match` inside its wraps (outermost first), each throw tagged with who threw it. */
function chainOf(match: RouteMatch, ctx: Ctx): (request: HttpRequest) => Promise<HttpResponse> {
	// 最内层是路由本身；tagged 把路由抛错标记为 route。
	let next: (request: HttpRequest) => Promise<HttpResponse> = tagged(match.handler, match.plugin, ctx);
	// 逆序构建：最后处理的数组元素（最内层 wrap）先包住路由，循环结束时第一个元素在最外层。
	for (let index = match.wraps.length - 1; index >= 0; index--) {
		const { wrap, plugin } = match.wraps[index]!;
		// inner 是已经构建好的内层调用；闭包捕获当前 wrap/plugin。
		const inner = next;
		next = async (request) => {
			// 调用 wrap 时把 inner 作为 next；wrap 可以选择不调用 next（短路）。
			try {
				return await wrap.wrap(request, inner, ctx);
				// 内层已经标记过的 Thrown 不再覆盖，保留真正的抛出位置。
			} catch (error) {
				if (error instanceof Thrown) throw error;
				throw new Thrown({ kind: "wrap", name: wrap.name }, plugin, error);
			}
		};
	}
	return next;
}

// 函数用途：包装路由，把任何异常标记为 Thrown(ROUTE, plugin, error)。输入路由、插件名和 ctx，输出调用函数。
// ctx 在构建时固定，所有请求共享同一个作用域上下文。
/** `route` with its throws tagged as the route's. */
function tagged(route: HttpRoute, plugin: string, ctx: Ctx): (request: HttpRequest) => Promise<HttpResponse> {
	return async (request) => {
		try {
			return await route(request, ctx);
		} catch (error) {
			throw new Thrown(ROUTE, plugin, error);
		}
	};
}
