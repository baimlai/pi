// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的准入/来源判定模块（slice 10 §2，R4，安全基线 (1)-(3)）。
// 职责边界：只回答“请求从哪里来、是否允许进入”，不做路由匹配、认证、CSP 生成或连接升级。
// 上游入口：http.ts 的 #serve 与 #upgradeSteps 在取得 Router 后调用 admit；nodeRequest 的使用方也复用同一规则。
// 下游依赖：Incoming（Host/转发头/Web Request）、HttpRelay（verify）、Router 的 hosts/relays、URL 解析器、
// Fetch Metadata 头（Sec-Fetch-Site/Dest/Mode）与 Origin。
// 结果与错误流向：返回 Admitted（provenance/origin/framer/allowed/relay）或 Refused；Refused.failed 会由组件
// 报告为 hook_failed。普通拒绝由组件回答 403，不抛错；来源判定本身无 I/O、不修改请求。
// 能力清单：
// - Provenance：local / remote / relayed 三种来源的联合类型；
// - Connection：监听器能提供的本地/远端地址与端口；
// - Admitted / Refused：准入成功与拒绝的结果类型，带 framer/allowed/relay 与失败详情；
// - admit：准入主入口，结合 Host、连接地址、允许域名和中继做判定；
// - HeaderSource / refused：Fetch Metadata 检查所需的头读取器与类型谓词；
// - isForeign：按 Sec-Fetch-Site/Dest 判断是否来自其他站点；
// - isNavigation：判断外来请求是否为用户顶层导航；
// - originAccepted：检查 Origin 头与请求来源是否一致；
// - 内部常量/助手：REFUSED/LOCAL、LOOPBACK_NAMES、isLoopbackName、isLoopbackAddress、relayed、isOrigin、FRAMES、SAFE。
// 组合关系：admit 先判 Host 是否回环名；回环且无转发头 -> local，回环但有转发头 -> relayed（逐个 verify）；
// 非回环 Host 必须在允许集合中 -> remote；随后 http.ts 再调用 isForeign/isNavigation/originAccepted 决定认证与放行。
// 示例：const result = admit(incoming, { localAddress: "127.0.0.1", localPort: 8788 },
//                       router.hosts, router.relays);
//       若 result.kind === "local"，来源就是本机回环，origin 为 http://<Host>。
// 建议阅读顺序：先看 Provenance/Admitted/Refused 三个结果类型，再看 admit 的 Host 分支，随后 relayed 与 isOrigin，
// 最后看三个 Fetch Metadata/Origin 辅助函数和回环地址判断。
// Admission (slice 10 §2, R4; decision "The HTTP component's security baseline" (1)-(3), "Relays"): where a request
// comes from, decided before anything else. Local only when the connection arrived on a loopback address, its `Host`
// is a loopback name with the listening port, and it carries no forwarded header; a forwarded request on loopback only
// when a contributed relay verifies it; otherwise only through an allowed host (https); else refused. Foreign requests
// (another site's, by Fetch Metadata) and a foreign `Origin` are classified here; the handler applies them per route.

import type { Incoming } from "./incoming.ts";
import type { HttpRelay } from "./router.ts";

// 联合类型（可辨识联合）：三个分支用 kind 区分，编译器在 switch/if 收窄后可访问各自字段；
// 运行时对象由 admit 构造，没有额外的 schema 校验。
// local 只用于“连接是回环 + Host 是回环名 + 没有转发头”的请求，不能由客户端单方面声称。
/** Where an admitted request came from. */
export type Provenance =
	| { readonly kind: "local" }
	| { readonly kind: "remote"; readonly host: string }
	| { readonly kind: "relayed"; readonly relay: string; readonly origin: string };

// 监听器知道的连接信息：本地地址/端口用于判断请求是否真的落在回环地址上，远端地址供限流；
// 挂载到第三方服务器时可能只有部分字段，缺 localAddress/localPort 的请求永远不会被当作 local。
/** The connection a request arrived on, as its listener knows it (a mounted handler passes what it has). */
export type Connection = {
	readonly localAddress?: string;
	readonly localPort?: number;
	readonly remoteAddress?: string;
};

// 准入成功后的完整上下文：provenance 是来源分类，origin 是规范化的来源（http/https），
// framer 是允许嵌入页面的来源（中继提供），allowed 与 relay 记录“是谁放行的”，
// 以便宿主或中继离开时撤销连接。
/** An admitted request: its provenance, its own origin, the origin allowed to frame it (a relay's), how it came. */
export type Admitted = {
	readonly provenance: Provenance;
	readonly origin: string;
	readonly framer: string | undefined;
	/** The allowed host it came through: its connections end when that host leaves. */
	readonly allowed: string | undefined;
	/** The relay that verified it: its connections end when that relay leaves. */
	readonly relay: HttpRelay | undefined;
};

// 拒绝结果：failed 仅在某个中继的 verify 抛错或返回非法来源时出现，调用方会把它报告为 hook_failed；
// 普通拒绝不带 failed，统一回答 403。
/** What admission refuses, and the relay hook that threw (reported by the caller). */
export type Refused = {
	readonly kind: "refused";
	readonly failed?: { readonly relay: string; readonly error: unknown };
};

// 函数用途：在路由前判定请求来源。输入是组件读取的请求、连接信息、允许域名集合和贡献的中继；
// 返回 Admitted 或 Refused，不修改请求、无 I/O、不抛错。
// 主要流程：读 Host -> 若 Host 是本机回环名则要求连接也来自回环，无转发头即 local，有转发头交给中继验证；
// 否则 Host 必须在允许域名集合中，记为 remote（https）；其余一律拒绝。
// 例子：连接 localAddress=127.0.0.1、Host=localhost:8788、无转发头 => {kind:"local"}, origin=http://localhost:8788。
// 例子：Host=notes.example.com 且被贡献允许 => {kind:"remote"}, origin=https://notes.example.com。
/**
 * Admits `request` arriving on `connection` with the allowed `hosts` and contributed `relays`, or refuses it (403):
 * no or several `Host`s, a host neither loopback nor allowed, a loopback `Host` on another connection, forwarded
 * headers no relay verifies.
 */
export function admit(
	request: Incoming,
	connection: Connection,
	hosts: ReadonlySet<string>,
	relays: readonly HttpRelay[],
): Admitted | Refused {
	// Host 头可能缺失；统一转小写后比较，避免大小写绕过允许列表。
	const host = request.header("host")?.toLowerCase();
	// 缺失、空串或包含逗号都拒绝：Node 会把多个 Host 用逗号连接，出现逗号说明客户端发了重复 Host。
	// Several `Host` headers arrive joined with commas.
	if (host === undefined || host === "" || host.includes(",")) return REFUSED;
	// 解构连接信息；localPort 用于验证 Host 里带的是监听端口（80 端口允许省略）。
	const { localAddress, localPort } = connection;
	// 先看 Host 是否声称自己是本机回环名；若不是，再检查允许域名。
	if (isLoopbackName(host, localPort)) {
		// Host 写 localhost 不够：连接本身必须来自回环地址，防止外部连接伪造 Host 冒充本地。
		if (localAddress === undefined || !isLoopbackAddress(localAddress)) return REFUSED;
		// 本地连接却带 Forwarded/X-Forwarded-*：说明前面有代理，只有贡献的中继验证通过才准入。
		if (!request.forwarded())
			// 纯本地请求：没有 framer、允许域名或中继；origin 使用 http 而非 https。
			// 注意：这里不读取远端地址，回环判断只看 localAddress。
			return {
				provenance: LOCAL,
				origin: `http://${host}`,
				framer: undefined,
				allowed: undefined,
				relay: undefined,
			};
		// 本地连接 + 转发头：交给中继逐个验证；全部不认领则拒绝。
		return relayed(request, relays);
	}
	// Host 不是回环名时，必须是某个插件贡献的允许域名，否则拒绝。
	if (!hosts.has(host)) return REFUSED;
	// 允许域名按 HTTPS 处理：外部流量必须经过 TLS 终止或受信代理，origin 固定为 https://host。
	// allowed 记录该域名，用于在域名被移除时终止已建立的连接。
	return {
		provenance: { kind: "remote", host },
		origin: `https://${host}`,
		framer: undefined,
		allowed: host,
		relay: undefined,
	};
}

// 结构类型 Pick：只要求 header 方法，Fetch Metadata/Origin 检查不需要完整请求；
// 运行时没有校验，传进来的对象由调用方保证（WebRequest 或 Incoming）。
/** What the Fetch Metadata and `Origin` checks read: a request's headers by name. */
export type HeaderSource = Pick<Incoming, "header">;

/** Whether `admission` refused its request. */
// 类型谓词（admission is Refused）：返回 true 时编译器把联合收窄为 Refused，调用方可安全读 failed；
// 运行时只检查 kind 属性是否存在。
export function refused(admission: Admitted | Refused): admission is Refused {
	return "kind" in admission;
}

/**
 * Whether a request is another site's (Fetch Metadata, p2's rule): `Sec-Fetch-Site` neither `same-origin` nor `none`,
 * or a frame or embed not from this origin. A request without the headers (a script, the TUI) is not.
 */
// 函数用途：根据 Fetch Metadata 判断请求是否来自另一个站点。输入只需 header 读取器，返回布尔值。
// 规则：Sec-Fetch-Site 存在且既非 same-origin 也非 none => 外来；或者站点不是 same-origin 且目标是 iframe 等嵌入式框架。
// 例子：sec-fetch-site: cross-site => true；完全没有这些头（脚本、TUI 客户端）=> false。
export function isForeign(headers: HeaderSource): boolean {
	const site = headers.header("sec-fetch-site");
	// 浏览器明确声明跨站来源；same-origin 与 none（用户直接输入地址）不算外来。
	if (site !== null && site !== "same-origin" && site !== "none") return true;
	// 框架/嵌入目标即使站点信息缺失也按外来处理，避免其他站点嵌入页面或资源；?? 把缺失目标当作空串。
	return site !== "same-origin" && FRAMES.has(headers.header("sec-fetch-dest") ?? "");
}

/**
 * Whether a foreign request is a top-level navigation (a link followed to a page): `GET`, `navigate`, a `document` (or
 * `empty`: Chrome on Android launching an installed app).
 */
// 函数用途：判断外来请求是否为“用户点击链接进入页面”的顶层导航。输入方法与请求头，返回布尔值。
// 只有 GET + navigate + document/empty 才算；empty 兼容 Chrome Android 从已安装应用启动的情况。
// 例子：GET + sec-fetch-mode: navigate + sec-fetch-dest: document => true；POST 或 dest=iframe => false。
export function isNavigation(method: string, headers: HeaderSource): boolean {
	const dest = headers.header("sec-fetch-dest");
	return (
		method === "GET" && headers.header("sec-fetch-mode") === "navigate" && (dest === "document" || dest === "empty")
	);
}

/**
 * Whether `headers`' `Origin` is acceptable for a request whose own origin is `origin`: absent or equal, and for an
 * unsafe method from a browser (one sending Fetch Metadata) present and equal.
 */
// 函数用途：检查 Origin 头是否可接受。输入方法、请求头和本请求的 origin，返回布尔值。
// 规则：带了 Origin 就必须完全相等；没带时，安全方法（GET/HEAD/OPTIONS）放行，
// 或者完全没有 Fetch Metadata（非浏览器客户端）也放行；浏览器发起的不安全方法必须带 Origin。
// 例子：POST 带 Origin: https://a.example 且 admission.origin 相同 => true；POST 缺少 Origin 且带 Sec-Fetch-Site => false。
export function originAccepted(method: string, headers: HeaderSource, origin: string): boolean {
	const sent = headers.header("origin");
	if (sent !== null) return sent === origin;
	return SAFE.has(method) || headers.header("sec-fetch-site") === null;
}

// 共享的拒绝单例：没有失败详情；只读约定要求调用方不要修改它。
const REFUSED: Refused = { kind: "refused" };

const LOCAL: Provenance = { kind: "local" };

// 允许的回环主机名；IPv6 用方括号形式，与 URL/ Host 头一致。
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** Whether `host` (lowercased) names this server on loopback with `port` (without it on port 80). */
// 函数用途：判断小写 Host 是否指向本机回环端口。输入 host 与监听端口，返回布尔值。
// 例子：port=8788、host=localhost:8788 => true；host=localhost:9999 => false；port=80 时 host=localhost 也允许。
// 没有端口信息就无法确认这是本服务器的监听地址，直接返回 false。
function isLoopbackName(host: string, port: number | undefined): boolean {
	if (port === undefined) return false;
	// 逐个名字比较“名字:端口”；端口 80 是 HTTP 默认端口，浏览器可能省略。
	for (const name of LOOPBACK_NAMES) {
		if (host === `${name}:${port}`) return true;
		if (port === 80 && host === name) return true;
	}
	return false;
}

/** Whether `address` is a loopback address: 127.0.0.0/8, ::1, or 127.x mapped into IPv6. */
// 函数用途：判断监听地址是否为回环地址。支持 ::1、127.0.0.0/8 和 IPv4 映射到 IPv6 的形式。
// 这是字符串前缀判断，输入来自 Node socket，可信度由运行时提供；不做 DNS 解析。
function isLoopbackAddress(address: string): boolean {
	return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** A forwarded request on loopback: admitted as relayed when a relay verifies it, else refused. */
// 函数用途：本地连接但带转发头时的准入。输入请求和中继列表，返回 Admitted 或 Refused。
// 流程：按贡献顺序调用 relay.verify(Web Request)；undefined 表示不是该中继的请求，继续下一个；
// 返回结果则校验 origin/framer 是合法来源后准入；抛错或来源非法则立即拒绝并附带 failed 供报告。
// 例子：Radius 中继校验签名头成功，返回 {origin:"https://app.example"}，请求被记为 relayed。
// 副作用：verify 可能读取请求体/头；每个中继最多调用一次，不修改请求。
function relayed(request: Incoming, relays: readonly HttpRelay[]): Admitted | Refused {
	for (const relay of relays) {
		let verified: ReturnType<HttpRelay["verify"]>;
		// ReturnType<HttpRelay["verify"]> 在编译期取出 verify 的返回类型；先声明再在 try 中赋值。
		try {
			verified = relay.verify(request.request());
			// verify 抛错不是“未识别”，而是中继本身故障：停止尝试并返回拒绝详情，避免故障中继被绕过。
		} catch (error) {
			return { kind: "refused", failed: { relay: relay.name, error } };
		}
		// undefined 表示该中继不认领此请求，继续询问下一个。
		if (verified === undefined) continue;
		// Its origins reach the CSP: each must be one origin and nothing else (Fable's recheck N2).
		// origin 与 framer 都会进入 CSP；framer 可为 undefined，但 origin 必须存在。
		// 每个值必须是“恰好一个来源”的序列化文本，防止把空格、分号等注入 CSP 指令。
		for (const origin of [verified.origin, verified.framer]) {
			// undefined 的 framer 合法；其余交给 isOrigin 做运行时校验。
			if (origin === undefined || isOrigin(origin)) continue;
			// 构造带原因的错误，随 Refused.failed 交给组件报告为 hook_failed。
			const error = new Error(`relay ${relay.name}: ${JSON.stringify(origin)} is no origin`);
			return { kind: "refused", failed: { relay: relay.name, error } };
		}
		// 验证通过：记录中继名字与来源；allowed 为空，relay 引用用于之后撤销连接。
		return {
			provenance: { kind: "relayed", relay: relay.name, origin: verified.origin },
			origin: verified.origin,
			framer: verified.framer,
			allowed: undefined,
			relay,
		};
	}
	return REFUSED;
}

/** Whether `text` is exactly an origin (`https://host[:port]`): what the URL parser serializes it to. */
// 函数用途：判断文本是否恰好是一个 http/https 来源。输入字符串，返回布尔值，不抛错。
// 例子："https://a.example" => true；"https://a.example/path"、"https://a.example/" 或含空格的文本 => false。
// 依赖 URL 解析器做规范化，再要求 url.origin 与原文完全一致，因此路径、查询、默认端口的差异都会被拒绝。
function isOrigin(text: string): boolean {
	try {
		// 只接受 http/https；URL 构造函数对非法文本会抛错，由 catch 转成 false。
		const url = new URL(text);
		return (url.protocol === "https:" || url.protocol === "http:") && url.origin === text;
	} catch {
		return false;
	}
}

/** The `Sec-Fetch-Dest` of a frame or an embed. */
// 会被当作“嵌入”的 Sec-Fetch-Dest 值；object/embed 可能加载插件内容，fencedframe 是隐私沙箱框架。
const FRAMES: ReadonlySet<string> = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

/** The methods that change nothing. */
// 不改变服务器状态的方法；没有 Origin 头时这些方法仍可接受。
const SAFE: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
