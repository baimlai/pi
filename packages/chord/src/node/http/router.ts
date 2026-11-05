// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的路由注册表与路由器（slice 10 §2，D1/D2/D8）。
// 职责边界：定义插件可贡献的 routes/wraps/sockets/hosts/framers/relays/csp/scripts，并把注册表组合成
// 请求可查询的 Router；不做准入、认证、响应生成或网络监听。
// 上游入口：http.ts 的 facet.serve(Http, { compose: composeRouter }) 把注册表组合成 Router；插件通过贡献
// HttpContribution 注册路由/包装器/套接字。下游依赖：HttpRequest/HttpResponse、Ctx、registries 的
// RegistryTable/ComposeContext、ws 的 WebSocket 类型（仅类型）。
// 结果与错误流向：composeRouter 永远返回 Router，冲突通过 report 报告（重复路由、非法模式、未承载方法、
// 命名不存在路由的 wrap 等）；route/socket 返回匹配、undefined 或 "bad_path"。路由器本身不抛错。
// 能力清单：
// - HttpRoute / HttpRouteOptions：路由处理函数与 public/page/crossSite 选项；
// - WrapPhase / HttpWrap / ResolvedWrap：observe/headers/transform 三阶段包装器及解析后的插件归属；
// - HttpSocket / HttpSocketOptions / WebSocketHandle：插件套接字处理与选项；
// - HttpRelay：本地转发中继的 verify 契约；
// - HttpContribution：插件贡献的全部字段；Router/RouteMatch/SocketMatch：组合结果与匹配结果；
// - Http："chord.http" 注册表令牌（贡献 HttpContribution，组合为 Router）；
// - UNCARRIED：Web Request 无法承载的 CONNECT/TRACE/TRACK；
// - composeRouter：组合主入口；内部还有模式解析、优先级树、参数解码校验与 wrap 解析。
// 组合关系：composeRouter 遍历注册表 -> 解析每个 "METHOD /pattern" -> 插入按方法分的模式树 -> 解析 wrap
// -> 返回闭包 Router；每次请求 route() 按 exact > :name > trailing * 的优先级查找并解码参数。
// 示例：const router = composeRouter(table, { report: (conflict) => log(conflict) });
//       const match = router.route("GET", "/notes/7"); // { pattern: "GET /notes/:id", params: { id: "7" }, ... }
// 建议阅读顺序：先看 HttpContribution/Router/RouteMatch 的形状，再看 composeRouter 的主循环，
// 随后 parseRoute/parsePattern 与 Node/insert 的优先级树，最后看 lookup/walk/safe 的参数校验和 resolveWraps。
// The router (slice 10 §2, D1, D2, D8): the registry `Http` that plugins contribute routes, wraps, sockets, allowed
// hosts, framers, relays and CSP sources to, and its `compose`, which builds the router every request reads: patterns
// matched segment by segment (exact before `:name` before a trailing `*`), each route's wraps resolved in phase and
// contributor order, conflicts reported with the first by plugin name winning.

import type { WebSocket } from "ws";
import type { Ctx } from "../../host/index.ts";
import { type ComposeContext, defineRegistry, type RegistryTable } from "../../registries/index.ts";
import type { HttpRequest } from "./request.ts";
import type { HttpResponse } from "./response.ts";

// 路由处理函数：输入已准入请求和请求作用域上下文，异步返回响应描述；异常由组件转成 500/HttpFailure 状态。
// 类型只约束编译期；运行时组件只检查返回对象的 kind。
/** A route: answers a request with a response description, in the request's scope (`ctx.principal`, its signal). */
export type HttpRoute = (request: HttpRequest, ctx: Ctx) => Promise<HttpResponse>;

// 路由选项：handler 必填；public 允许匿名访问；page 允许外站顶层导航携带认证；crossSite 允许任意外站请求，
// 但永远匿名（因此自动是 public）。三者都是字面量 true 才生效，避免 false 与缺省产生歧义。
/**
 * A route with its options: `public` serves it without a principal (deny by default: a route without one answers 401
 * to a request no authenticator recognized); `page` admits a top-level navigation from another site (a link to it)
 * with its authentication; `crossSite` admits any foreign request (a webhook), always anonymous, so public too.
 */
export type HttpRouteOptions = {
	readonly handler: HttpRoute;
	readonly public?: true;
	readonly page?: true;
	readonly crossSite?: true;
};

// 包装器阶段，按数组顺序从外到内执行；observe 最先看到请求，transform 最靠近路由。
/** A wrap's phases, outermost first. */
export type WrapPhase = "observe" | "headers" | "transform";

// 包装器：name 用于报告，phase 决定顺序，scope 决定只包本插件路由还是所有路由，route 可进一步限定一个模式。
// wrap 接收请求、next（调用内层）和 ctx，返回响应；抛错会被组件标记为 wrap_failed。
/** A wrap (D2): runs around routes in its phase, around its own plugin's routes unless `scope` is `"all"`. */
export type HttpWrap = {
	readonly name: string;
	readonly phase: WrapPhase;
	/** `"own"` (default): around the contributing plugin's routes; `"all"`: every route. */
	readonly scope?: "own" | "all";
	/** Only around this route (`"GET /notes/:id"`); a route nobody contributes is a reported conflict. */
	readonly route?: string;
	readonly wrap: (
		request: HttpRequest,
		next: (request: HttpRequest) => Promise<HttpResponse>,
		ctx: Ctx,
	) => Promise<HttpResponse>;
};

// 插件套接字处理：拿到已认证的 ws WebSocket、请求和作用域上下文；作用域持续到套接字关闭。
// 返回 Promise 时组件会等待其完成；抛错会报告 socket_failed 并以 1011 关闭。
/**
 * A plugin socket's handler (D6): a `ws` WebSocket after the checks and authentication, its `error` listener attached;
 * its scope lasts until the socket closes.
 */
export type HttpSocket = (socket: WebSocketHandle, request: HttpRequest, ctx: Ctx) => void | Promise<void>;

// 套接字选项：public 允许没有 principal 的连接；否则认证失败在处理器运行前就返回 401。
/** A plugin socket with its options: `public` accepts it without a principal (else 401 before the handler runs). */
export type HttpSocketOptions = { readonly handler: HttpSocket; readonly public?: true };

// 对插件暴露的 WebSocket 类型就是 ws 的 WebSocket 的别名；插件处理器直接使用 ws 的接口。
/** A plugin socket: `ws`'s WebSocket, for the plugin's own protocol. */
export type WebSocketHandle = WebSocket;

// 中继契约：只用于本地回环上带 Forwarded/X-Forwarded-* 的请求；verify 返回来源与可选 framer，
// undefined 表示不认领。origin/framer 必须是单个来源，否则准入拒绝并报告。
/**
 * A relay (p2's Radius): a forwarder on loopback that sends forwarded headers. `verify` recognizes its requests (a
 * secret header, a signature) and names the origin the request came from and the origin allowed to frame it.
 */
export type HttpRelay = {
	readonly name: string;
	readonly verify: (request: Request) => { readonly origin: string; readonly framer?: string } | undefined;
};

// 插件对 Http 注册表的贡献；所有字段可选，组合时按贡献顺序合并。值不可变，但注册表变化会触发重新组合。
/** What a plugin contributes to `Http`: a plain value, or a writable of one (its change recomposes the router). */
export type HttpContribution = {
	// 路由键必须是 "METHOD /pattern"；值可以是处理函数本身或带选项的对象。
	/** Routes by `"METHOD /pattern"`: exact segments, `:name`, a trailing `/*`. */
	readonly routes?: Readonly<Record<string, HttpRoute | HttpRouteOptions>>;
	readonly wraps?: readonly HttpWrap[];
	// 套接字按路径模式（无方法）注册；同模式冲突时先贡献者胜出并报告。
	/** Plugin sockets by pattern (no method). */
	readonly sockets?: Readonly<Record<string, HttpSocket | HttpSocketOptions>>;
	// 该贡献项套接字的最大帧；缺省 1 MiB，只影响这个贡献注册的套接字。
	/** The largest frame this contribution's sockets accept; 1 MiB by default. */
	readonly maxPayload?: number;
	// 除回环外允许的 Host（小写化后比较）；经这些 Host 的请求按 https 来源处理。
	/** Hosts allowed besides loopback, as the client names them (`notes.example.com`): requests through them are https. */
	readonly hosts?: readonly string[];
	// 允许嵌入页面的来源，进入 CSP frame-ancestors；中继也可为单次请求追加 framer。
	/** Origins allowed to frame the app's pages (CSP `frame-ancestors`). */
	readonly framers?: readonly string[];
	// 本地转发中继；只有它们 verify 通过的转发请求才会被准入为 relayed。
	/** Relays whose forwarded requests are admitted (verified) on loopback. */
	readonly relays?: readonly HttpRelay[];
	// 额外 CSP 来源；与基线同名指令合并，首项 'none' 时被替换。
	/** Extra CSP sources by directive (`{ "img-src": ["https://cdn.example.com"] }`). */
	readonly csp?: Readonly<Record<string, readonly string[]>>;
	// 脚本加载路径；提供后 script-src 只允许这些路径 + nonce，避免同源任意响应被当脚本执行。
	/**
	 * The paths scripts load from (`/_chord/web/`): with any, `script-src` is these paths of the request's origin and the
	 * response's nonce instead of the whole origin, so no other same-origin response (an upload served as JavaScript)
	 * runs as a script.
	 */
	readonly scripts?: readonly string[];
};

// 组合后的路由器，是请求开始时读取的不可变快照；注册表变化会生成新的 Router，旧请求继续用旧值。
/** The router a request uses: as it was when the request started. */
export type Router = {
	// route：按方法和路径查匹配；HEAD 在没有显式 HEAD 路由时回退到 GET；非法路径返回 "bad_path"。
	/** The route for `method` and `path`, with its params and wraps; `bad_path` for a malformed one. */
	route(method: string, path: string): RouteMatch | "bad_path" | undefined;
	// socket：按路径查插件套接字；非法路径同样返回 "bad_path"。
	/** The plugin socket for `path`. */
	socket(path: string): SocketMatch | "bad_path" | undefined;
	// hosts/framers 是 Set，便于 O(1) 判断；relays/csp/scripts 保留贡献顺序。
	/** The hosts contributions allow (lowercased). */
	readonly hosts: ReadonlySet<string>;
	/** The origins allowed to frame pages. */
	readonly framers: ReadonlySet<string>;
	/** The relays, in contributor order. */
	readonly relays: readonly HttpRelay[];
	/** Extra CSP sources by directive. */
	readonly csp: ReadonlyMap<string, readonly string[]>;
	/** The paths scripts load from; none: the whole origin. */
	readonly scripts: readonly string[];
	/** The socket handlers it serves: a socket handed out by one no longer here is closed. */
	readonly socketHandlers: ReadonlySet<HttpSocket>;
};

// 路由匹配结果：模式、贡献插件、解码后的参数、处理函数、三个访问选项和已解析的包装器（最外层在前）。
// public 在组合时已把 crossSite 也算入；运行时组件直接读取这些布尔值。
/** A matched route: its pattern, plugin, params, handler, options and wraps (outermost first). */
export type RouteMatch = {
	readonly pattern: string;
	readonly plugin: string;
	readonly params: Readonly<Record<string, string>>;
	readonly handler: HttpRoute;
	/** Served without a principal: marked `public`, or `crossSite` (always anonymous). */
	readonly public: boolean;
	readonly page: boolean;
	readonly crossSite: boolean;
	readonly wraps: readonly ResolvedWrap[];
};

// 套接字匹配结果：模式、插件、参数、处理函数、是否 public，以及该贡献项的最大帧大小。
/** A matched plugin socket. */
export type SocketMatch = {
	readonly pattern: string;
	readonly plugin: string;
	readonly params: Readonly<Record<string, string>>;
	readonly handler: HttpSocket;
	readonly public: boolean;
	readonly maxPayload: number;
};

// 解析后的包装器：保留包装器本身和贡献它的插件，用于 own/all 作用域判断与错误报告。
/** A wrap as a route runs it, with its plugin. */
export type ResolvedWrap = { readonly wrap: HttpWrap; readonly plugin: string };

// 注册表令牌：贡献 HttpContribution，组合为 Router；版本 1。facet 提供者把 composeRouter 绑定到这里。
// 注册表按插件名排序贡献，因此“第一个贡献者胜出”是可预测的。
/** The registry the HTTP component defines and serves (`http.facet`, plugin `chord.http`). */
export const Http = defineRegistry<HttpContribution, Router>("chord.http", { version: 1 });

// 套接字默认最大帧 1 MiB；与链接端点的默认值独立。
/** A plugin socket's largest frame unless its contribution says otherwise: 1 MiB. */
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

// 这些方法不能由 Web Request 承载（Fetch 规范的 forbidden methods）；组合时拒绝路由，线上请求则 501。
/**
 * The methods a Web `Request` cannot carry (the Fetch standard's forbidden methods): answered 501 at the wire, a route
 * for one refused at compose.
 */
export const UNCARRIED: ReadonlySet<string> = new Set(["CONNECT", "TRACE", "TRACK"]);

// 函数用途：把注册表表格组合成 Router。输入表格和冲突报告回调，输出不可变路由器；纯函数、无 I/O。
// 主要流程：合并 hosts/framers/relays/csp/scripts -> 解析路由并插入各方法树 -> 解析套接字树 -> 解析 wraps。
// 冲突处理：报告后跳过或保留先贡献者，绝不抛错，保证组件始终有可用路由器。
/** Builds the router from `table` (the registry's `compose`): pure, conflicts reported, the first by plugin name wins. */
export function composeRouter(table: RegistryTable<HttpContribution>, { report }: ComposeContext): Router {
	// routes 按方法分开建树；每个方法一个根节点，查找时先取对应方法。
	const routes = new Map<string, Node<RouteEntry>>();
	// sockets 只有路径模式，共用一个树；entries 收集成功插入的路由，供 wrap 解析。
	const sockets: Node<SocketEntry> = emptyNode();
	// 其余集合按贡献顺序累积；Set 去重 hosts/framers，数组保留 relays/scripts。
	const entries: RouteEntry[] = [];
	const hosts = new Set<string>();
	const framers = new Set<string>();
	const relays: HttpRelay[] = [];
	const csp = new Map<string, string[]>();
	const scripts: string[] = [];
	const socketHandlers = new Set<HttpSocket>();
	// 遍历注册表表格；解构出贡献插件名和值。表格顺序由注册表保证（插件名、类型）。
	for (const { plugin, value } of table) {
		// Host 统一小写，客户端 Host 也小写后比较；framer 原样加入，由贡献者提供合法的 CSP 来源文本。
		for (const host of value.hosts ?? []) hosts.add(host.toLowerCase());
		for (const framer of value.framers ?? []) framers.add(framer);
		relays.push(...(value.relays ?? []));
		scripts.push(...(value.scripts ?? []));
		// CSP 同名指令的多个贡献合并为数组；Object.entries 遍历贡献对象的键。
		for (const [directive, sources] of Object.entries(value.csp ?? {})) {
			csp.set(directive, [...(csp.get(directive) ?? []), ...sources]);
		}
		// 遍历该插件的每个路由键；key 必须是 "METHOD /pattern"。
		for (const [key, route] of Object.entries(value.routes ?? {})) {
			// parseRoute 返回方法与解析后的模式段；失败表示格式错误。
			const parsed = parseRoute(key);
			if (parsed === undefined) {
				report({ message: `route "${key}" is no "METHOD /pattern"`, plugins: [plugin] });
				continue;
			}
			// CONNECT/TRACE/TRACK 不能成为 Web Request 路由，组合时报告并跳过。
			if (UNCARRIED.has(parsed.method)) {
				report({ message: `route "${key}": ${parsed.method} is served for no resource (501)`, plugins: [plugin] });
				continue;
			}
			// 每个方法惰性创建根节点；没有该方法的树时查找直接返回 undefined。
			let tree = routes.get(parsed.method);
			if (tree === undefined) {
				tree = emptyNode();
				routes.set(parsed.method, tree);
			}
			// 路由值可能是函数或选项对象；统一成 { handler } 形状，后续只读 options.handler。
			const options = typeof route === "function" ? { handler: route } : route;
			// 入口保存模式原文、插件、处理函数、访问选项和解析后的段；wraps 先为空，稍后统一解析。
			const entry: RouteEntry = {
				pattern: key,
				plugin,
				handler: options.handler,
				// public 由 public 或 crossSite 推导：跨站路由永远匿名，所以必须 public。
				public: options.public === true || options.crossSite === true,
				page: options.page === true,
				crossSite: options.crossSite === true,
				segments: parsed.segments,
				wraps: [],
			};
			// 插入模式树；返回已存在的入口表示同一模式被重复贡献。
			const taken = insert(tree, parsed.segments, entry);
			// 首次插入才加入 entries；重复项只报告，不影响先贡献者。
			if (taken === undefined) entries.push(entry);
			else report({ message: `route "${key}" is contributed twice`, plugins: [taken.plugin, plugin] });
		}
		// 套接字最大帧可以按贡献项覆盖默认值。
		const maxPayload = value.maxPayload ?? DEFAULT_MAX_PAYLOAD;
		// 遍历套接字模式；没有方法前缀，因此 parsePattern 直接解析路径。
		for (const [pattern, socket] of Object.entries(value.sockets ?? {})) {
			const segments = parsePattern(pattern);
			if (segments === undefined) {
				report({ message: `socket "${pattern}" is no pattern`, plugins: [plugin] });
				continue;
			}
			// 套接字值可以是函数或选项对象；函数形式默认 public 为 undefined（组合后为 false）。
			const { handler, public: open } =
				typeof socket === "function" ? { handler: socket, public: undefined } : socket;
			// 套接字入口保存模式、插件、处理函数、public 和最大帧；参数稍后由匹配产生。
			const entry = { pattern, plugin, handler, public: open === true, segments, maxPayload };
			const taken = insert(sockets, segments, entry);
			// 只有成功插入的处理器才加入 socketHandlers；路由器变化时用它撤销已建立的套接字。
			if (taken === undefined) socketHandlers.add(handler);
			else report({ message: `socket "${pattern}" is contributed twice`, plugins: [taken.plugin, plugin] });
		}
	}
	// 所有路由插入后统一解析 wrap：阶段、作用域、指定路由和冲突都在这里处理。
	resolveWraps(table, entries, report);
	// 提前取出 GET/HEAD 树，避免每次 HEAD 查找都查 Map。
	const get = routes.get("GET");
	const head = routes.get("HEAD");
	// 返回的 Router 是闭包：捕获的集合和模式树在组合后不再修改。
	return {
		route: (method, path) => {
			// `HEAD` falls back to `GET` per path: an explicit `HEAD` route elsewhere hides no `GET` route.
			// HEAD 特殊处理：先查显式 HEAD；没有匹配时回退到 GET 树。orElse 保证 per-path 回退，
			// 而不是“只要存在任何 HEAD 路由就禁止所有 GET 回退”。
			if (method === "HEAD") return orElse(head === undefined ? undefined : lookup(head, path), get, path);
			const tree = routes.get(method);
			return tree === undefined ? undefined : lookup(tree, path);
		},
		// socket 只按路径查找，不涉及方法。
		socket: (path) => lookup(sockets, path),
		hosts,
		framers,
		relays,
		csp,
		scripts,
		socketHandlers,
	};
}

// 模式段的可辨识联合：exact 固定文本、param 命名参数、rest 末尾通配；lookup 依赖 kind 收窄。
/** One pattern segment: an exact one, `:name`, or the trailing rest (`*`). */
type Segment =
	| { readonly kind: "exact"; readonly text: string }
	| { readonly kind: "param"; readonly name: string }
	| { readonly kind: "rest" };

// 路由条目：组合期保存的完整信息；wraps 在 resolveWraps 后填成只读数组，因此字段不是 readonly。
/** What a route contributes, with its wraps once resolved. */
type RouteEntry = {
	readonly pattern: string;
	readonly plugin: string;
	readonly handler: HttpRoute;
	readonly public: boolean;
	readonly page: boolean;
	readonly crossSite: boolean;
	readonly segments: readonly Segment[];
	wraps: readonly ResolvedWrap[];
};

// 套接字条目：与路由类似，但没有方法、page/crossSite，只有 public 与 maxPayload。
/** What a plugin socket contributes. */
type SocketEntry = {
	readonly pattern: string;
	readonly plugin: string;
	readonly handler: HttpSocket;
	readonly public: boolean;
	readonly segments: readonly Segment[];
	readonly maxPayload: number;
};

// 模式树节点：exact 子节点按文本索引，param 是最多一个参数子节点，rest/entry 在该节点结束。
// 参数名不存在节点上：同一位置的不同 :name 共享节点，匹配时再按各自 entry 的模式取名。
/** A node of a pattern tree: its children by kind, and the entry ending here. */
type Node<E> = {
	readonly exact: Map<string, Node<E>>;
	/** Any `:name` at this position (the names are each entry's own). */
	param: Node<E> | undefined;
	rest: E | undefined;
	entry: E | undefined;
};

// 创建空节点；泛型 E 让同一棵树结构复用于路由和套接字条目。
function emptyNode<E>(): Node<E> {
	return { exact: new Map(), param: undefined, rest: undefined, entry: undefined };
}

// 函数用途：把 "GET /notes/:id" 拆成方法和段。输入路由键，输出方法/段或 undefined。
// 方法必须全大写字母；空格前为空或没有空格都非法；模式部分交给 parsePattern。
/** `"GET /notes/:id"` as its method and segments; `undefined` when it is none. */
function parseRoute(key: string): { readonly method: string; readonly segments: readonly Segment[] } | undefined {
	// 第一个空格分隔方法和模式；space <= 0 覆盖无空格和空方法。
	const space = key.indexOf(" ");
	if (space <= 0) return undefined;
	// 方法只允许 A-Z；小写方法会被报告为格式错误，避免路由永远匹配不到。
	const method = key.slice(0, space);
	if (!/^[A-Z]+$/.test(method)) return undefined;
	const segments = parsePattern(key.slice(space + 1));
	return segments === undefined ? undefined : { method, segments };
}

// 函数用途：把路径模式拆成段。输入模式字符串，输出段数组或 undefined。
// 规则：必须以 / 开头；* 只能在最后；: 后必须有名字；其余按 / 切分，空段（尾部 /）也是合法 exact 段。
// 例子："/notes/:id" => [exact notes, param id]；"/files/*" => [exact files, rest]。
/** A pattern's segments (`/files/*`, `/notes/:id`); `undefined` for one that is not a path or has `*` before its end. */
function parsePattern(pattern: string): readonly Segment[] | undefined {
	// 非绝对路径无法匹配请求路径，直接判非法。
	if (!pattern.startsWith("/")) return undefined;
	// 去掉开头的 / 再切分；根模式 "/" 得到空字符串段，因此只有精确根路径匹配。
	const parts = pattern.slice(1).split("/");
	const segments: Segment[] = [];
	// entries() 同时给出索引和段，索引用于判断 * 是否在末尾。
	for (const [index, part] of parts.entries()) {
		// 通配符必须是最后一段，否则后面的段永远无法到达。
		if (part === "*") {
			if (index !== parts.length - 1) return undefined;
			segments.push({ kind: "rest" });
			// 参数段要求至少一个字符；: 本身或 : 后为空都非法。
		} else if (part.startsWith(":")) {
			if (part.length === 1) return undefined;
			segments.push({ kind: "param", name: part.slice(1) });
		} else {
			// 其余文本作为精确匹配段；不做 URL 解码，解码发生在 lookup 的请求侧。
			segments.push({ kind: "exact", text: part });
		}
	}
	return segments;
}

// 函数用途：把条目插入模式树。输入树、段和条目，输出已占用该模式的旧条目（冲突）或 undefined。
// 泛型 E 让路由/套接字共用；rest 直接挂在节点上，exact/param 继续向下建节点。
/** Puts `entry` at `segments` in `tree`; returns the entry already there (the first by plugin name keeps it). */
function insert<E>(tree: Node<E>, segments: readonly Segment[], entry: E): E | undefined {
	// 从根开始逐段下降；node 始终指向当前前缀对应的节点。
	let node = tree;
	for (const segment of segments) {
		// rest 只能作为最后一段（parsePattern 已保证）；已有 rest 说明同模式重复。
		if (segment.kind === "rest") {
			if (node.rest !== undefined) return node.rest;
			node.rest = entry;
			return undefined;
		}
		// exact 段按文本取子节点，没有则创建；不同文本形成分支。
		if (segment.kind === "exact") {
			let next = node.exact.get(segment.text);
			if (next === undefined) {
				next = emptyNode();
				node.exact.set(segment.text, next);
			}
			node = next;
			// param 段不区分名字：同一位置的 :a 和 :b 共享节点，因此同一形状的路由被视为冲突。
		} else {
			// `:a` and `:b` at one position share the node: one shape, so the same pattern twice is a conflict.
			// ??= 只在 param 为空时创建，保留已有分支。
			node.param ??= emptyNode();
			node = node.param;
		}
	}
	// 所有段走完后，节点已占用表示该模式重复；返回旧条目供报告。
	if (node.entry !== undefined) return node.entry;
	node.entry = entry;
	return undefined;
}

// 函数用途：HEAD 回退。输入 HEAD 查找结果、GET 树和路径，返回 HEAD 结果或 GET 匹配。
// 只有显式 HEAD 完全没匹配（undefined）时才回退；"bad_path" 不回退，保持错误语义。
/** `found`, or when it is no route the `GET` route for `path` (`HEAD`'s fallback). */
function orElse(
	found: RouteMatch | "bad_path" | undefined,
	get: Node<RouteEntry> | undefined,
	path: string,
): RouteMatch | "bad_path" | undefined {
	if (found !== undefined || get === undefined) return found;
	return lookup(get, path);
}

// 函数用途：在模式树中查找路径。输入树与未解码路径，输出条目 + 参数、"bad_path" 或 undefined。
// 流程：先按 / 切分并逐段百分号解码（失败 -> bad_path），再 walk 按优先级找匹配，
// 最后按条目的模式提取 :name 与 * 参数，并检查每个解码段是否安全。
// 安全规则：参数不能含 /、\、NUL，也不能是 . 或 ..，防止参数被用于路径穿越。
/**
 * The entry `path` matches in `tree` with its params named by the entry's own pattern, the most specific segment by
 * segment from the left (exact before `:name` before `*`); `bad_path` for a segment that does not decode, or a `:name`
 * or rest segment decoding to one containing `/`, `\` or NUL, or to `.` or `..` (a param must never be a path).
 */
function lookup<E extends { readonly segments: readonly Segment[] }>(
	tree: Node<E>,
	path: string,
): (Omit<E, "segments"> & { readonly params: Readonly<Record<string, string>> }) | "bad_path" | undefined {
	// 去掉前导 / 后切分；空路径或只有 / 会得到 [""]，与根模式的 exact 空段对应。
	const raw = path.slice(1).split("/");
	// decoded 保存逐段解码后的文本；url 解析器已解析点段，但 %2E%2E 仍可能在这里变成 ..。
	const decoded: string[] = [];
	// 没有百分号的段无需解码，直接使用，省一次 decodeURIComponent 调用。
	for (const part of raw) {
		if (!part.includes("%")) {
			decoded.push(part);
			continue;
		}
		// 解码失败（非法百分号序列）属于路径格式错误，返回 bad_path 而非 404。
		try {
			decoded.push(decodeURIComponent(part));
		} catch {
			return "bad_path";
		}
	}
	// walk 返回匹配条目、按顺序捕获的参数值和 rest 起始位置。
	const found = walk(tree, decoded, 0, []);
	if (found === undefined) return undefined;
	// params 最终以参数名为键；TypeScript 的 Record 只是编译期形状。
	const params: Record<string, string> = {};
	// capture 记录当前读取到第几个 :name 捕获值；walk 按路径顺序压入。
	let capture = 0;
	// 遍历条目自己的模式段，只为 param 段取名；同一位置不同路由可以有不同参数名。
	for (const segment of found.entry.segments) {
		if (segment.kind !== "param") continue;
		// ! 断言捕获值一定存在：walk 的成功路径保证每个 param 段都有一个值。
		const value = found.captures[capture++]!;
		// 解码后的参数值必须通过 safe 检查，否则整个路径判为 bad_path。
		if (!safe(value)) return "bad_path";
		params[segment.name] = value;
	}
	// 有 rest 匹配时，把剩余段重新用 / 连接成 "*" 参数；每一段也必须 safe。
	if (found.rest !== undefined) {
		const rest = decoded.slice(found.rest);
		if (!rest.every(safe)) return "bad_path";
		params["*"] = rest.join("/");
	}
	// 丢弃内部的 segments 字段，只把条目其余字段和 params 返回给调用方。
	// 解构重命名 _segments 表示有意忽略；剩余属性用 ...entry 收集。
	const { segments: _segments, ...entry } = found.entry;
	return { ...entry, params };
}

// 函数用途：判断解码后的参数段能否安全作为单个路径段。输入段文本，输出布尔值；不修改输入。
/** Whether a decoded segment may be a param: no `/`, `\` or NUL, not `.` or `..`. */
function safe(segment: string): boolean {
	return segment !== "." && segment !== ".." && !/[/\\\0]/.test(segment);
}

// walk 的匹配结果：条目、按出现顺序的 :name 捕获值、rest 从哪个路径段开始（无 rest 则 undefined）。
/** A match found by `walk`: its entry, its `:name` values in order, where the rest starts (for `*`). */
type Found<E> = { readonly entry: E; readonly captures: readonly string[]; readonly rest: number | undefined };

// 函数用途：按优先级深度优先匹配。输入节点、解码后的段、当前索引和已捕获值，输出 Found 或 undefined。
// 优先级：exact 子节点 > param 子节点 > rest；先尝试的分支失败后才回退到下一个，因此“最具体”优先。
/** Depth first in precedence order: the first match found is the most specific from the left. */
function walk<E>(node: Node<E>, parts: readonly string[], index: number, captures: string[]): Found<E> | undefined {
	// 路径段耗尽：只有 entry 或 rest 能结束匹配；rest 在末尾匹配空前缀（/files 也能命中 /files/*）。
	if (index === parts.length) {
		if (node.entry !== undefined) return { entry: node.entry, captures, rest: undefined };
		// `/files/*` matches `/files`: the rest is empty.
		return node.rest === undefined ? undefined : { entry: node.rest, captures, rest: index };
	}
	// 精确段分支：存在同文本子节点才递归；失败后继续尝试参数/rest。
	const part = parts[index]!;
	const exact = node.exact.get(part);
	const viaExact = exact === undefined ? undefined : walk(exact, parts, index + 1, captures);
	if (viaExact !== undefined) return viaExact;
	// 参数段不匹配空段（避免 // 被当作参数）；[...captures, part] 创建新数组，不修改兄弟分支的捕获列表。
	if (node.param !== undefined && part !== "") {
		const viaParam = walk(node.param, parts, index + 1, [...captures, part]);
		if (viaParam !== undefined) return viaParam;
	}
	// 前面分支都失败时，当前节点的 rest 吃掉剩余全部路径；返回 rest 起始索引供 lookup 拼接。
	return node.rest === undefined ? undefined : { entry: node.rest, captures, rest: index };
}

// 包装器阶段从外到内的固定顺序；Array.indexOf 用于排序，未知阶段不会出现（类型保证）。
/** The wrap phases, outermost first. */
const PHASES: readonly WrapPhase[] = ["observe", "headers", "transform"];

// 函数用途：为每个路由解析 wrap 列表。输入注册表、路由条目和报告回调，无返回值，原地写 route.wraps。
// 流程：收集所有 wrap -> 按阶段稳定排序 -> 报告指定不存在路由的 wrap -> 为每个路由过滤 own/all 和 route。
// 同一阶段内保持贡献顺序；Array.sort 在现代 JS 中是稳定排序。
/**
 * Gives every route its wraps: by phase (outermost first), within a phase in contributor (table) order; `own` ones
 * around their plugin's routes, `all` ones around every route; one naming a route nobody contributes is reported.
 */
function resolveWraps(
	table: RegistryTable<HttpContribution>,
	routes: RouteEntry[],
	report: ComposeContext["report"],
): void {
	// all 保存 {wrap, plugin}，插件名用于 own 判断和错误报告。
	const all: ResolvedWrap[] = [];
	for (const { plugin, value } of table) for (const wrap of value.wraps ?? []) all.push({ wrap, plugin });
	// 排序只比较阶段索引；同阶段返回 0，保留原贡献顺序。
	all.sort((a, b) => PHASES.indexOf(a.wrap.phase) - PHASES.indexOf(b.wrap.phase));
	// 指定 route 的 wrap 必须指向一个真实贡献的路由，否则报告冲突（不会静默忽略）。
	for (const { wrap, plugin } of all) {
		if (wrap.route !== undefined && !routes.some((route) => route.pattern === wrap.route)) {
			report({
				message: `wrap "${wrap.name}" names route "${wrap.route}", which nobody contributes`,
				plugins: [plugin],
			});
		}
	}
	// 每个路由按过滤结果生成自己的 wrap 数组；scope 缺省视为 own。
	for (const route of routes) {
		// 条件：scope 为 all 或插件相同，且没有 route 限定或限定匹配当前模式。
		route.wraps = all.filter(
			({ wrap, plugin }) =>
				(wrap.scope === "all" || plugin === route.plugin) &&
				(wrap.route === undefined || wrap.route === route.pattern),
		);
	}
}
