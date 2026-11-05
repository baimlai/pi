// Sessions (slice 13 §2, decision "The app kit, point 3: authentication"): the kit's object on the server that issues
// and revokes sessions, and its authenticator. A session is a principal behind a token `<id>.<secret>` (random); only
// the secret's hash is kept. A browser carries its token in the kit's signed session cookie (`HttpOnly`,
// `SameSite=Strict`), a command-line client in `Authorization: Bearer <token>`. Browser and device sessions persist in
// the server's store and expire after 400 days unused; ephemeral sessions (a pick-a-name login, a public route) live
// in memory only (`EphemeralSessions`), at most `maxEphemeral` of them (past it the oldest ends), so a public login
// costs the same whatever came before; each ends with its client's connection (its last link closed, a grace period
// passed: the links endpoint's `opened` hook counts them), and none outlives the server's run.

// 所属：packages/chord/src/node/app，app kit 的会话与认证（slice 13 §2；decision 点 3）。
// 职责边界：签发、验证、撤销会话，提供 Authenticators 认证和滚动 cookie 包装；不处理登录页面或配对流程。
// 上游：startServer 调用 createSessions 并把 facet/opened 接入 host 和 HTTP；下游：EphemeralSessions、secrets、http 的 cookie/Authenticators、documents 持久化。
// 结果与错误：issue 返回 id/token/cookie；verify 返回 principal 或 null；revoke 成功返回 null；认证失败不抛错，未知、过期、伪造只得到 401。
// 能力清单：SessionKind/SessionInfo/Sessions/SESSION_COOKIE/SessionsDocument/SessionLimits/KitSessions 是类型与常量；createSessions 组合 facet/opened；sessionsFacet 实现对象与认证器；sessionCookie/rollingCookie/isSetCookie/bearerToken 是辅助。
// 组合顺序：createSessions → sessionsFacet → issue → sessionCookie；请求 → bearerToken/readCookie → authenticate → ctx.principal；响应 → rollingCookie。
// 示例：const kit = createSessions(secret); const { token } = await (await ctx.get(Sessions, {})).issue({ principal, label: 'cli', kind: 'device' }, ctx)。
// 建议阅读顺序：先看 Sessions 契约与 SessionsDocument，再看 createSessions/sessionsFacet 的 authenticate/issue，最后 cookie 辅助。
import type { Context } from "../../context/index.ts";
import { arr, bool, local, map, method, num, obj, oneOf, opt, str, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineState } from "../../documents/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	Authenticators,
	cookie,
	Http,
	type HttpRequest,
	type HttpWrap,
	type Provenance,
	readCookie,
	readSignedCookie,
} from "../http/index.ts";
import { EphemeralSessions } from "./ephemeral-sessions.ts";
import { hashToken, matchesHash, newToken } from "./secrets.ts";

// SessionKind 区分浏览器 cookie、命令行设备 token 和临时登录；持久化文档只允许前两种。
/** What a session is for: a browser (its cookie), a device (a command-line client's token), an ephemeral login. */
export type SessionKind = "browser" | "device" | "ephemeral";

// SessionInfo 是 list 的公开视图：不包含 token 或 hash，principal 以 unknown 保留应用自定义形状。
/** A browser or device session as `Sessions.list` shows it: never its token or hash. */
export type SessionInfo = {
	readonly id: string;
	readonly label: string;
	readonly kind: "browser" | "device";
	readonly principal: unknown;
	readonly created: number;
	readonly lastUsed: number;
};

// Sessions 是空参数本地契约；每个服务器一个对象，所有方法在服务器主机上执行。
/** The kit's sessions (one per server): issue, verify, revoke, and the watchable list of persisted ones. */
export const Sessions = local("chord.app.sessions", {
	version: 1,
	params: {},
	members: {
		// list 只列出持久会话；ephemeral 可能很多且生命短，不进入列表。
		/** The browser and device sessions (ephemeral ones are not listed: there may be many, and they are short). */
		list: arr(
			obj({
				id: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: unknown(),
				created: num(),
				lastUsed: num(),
			}),
		),
		// issue 接收 principal、标签、种类和可选 secure，返回 id、明文 token 和 Set-Cookie 文本。
		/**
		 * A new session for `principal`: its id, its token (shown once, kept only hashed) and the session cookie carrying
		 * it for a browser (`Set-Cookie`; `secure` for a remote one).
		 */
		// principal 用 unknown() 是因为应用身份形状由应用决定；kind 只允许三种固定值。
		issue: method(
			obj({
				principal: unknown(),
				label: str(),
				kind: oneOf("browser", "device", "ephemeral"),
				// secure 可选：远程浏览器需要 Secure cookie，本地回环不需要。
				secure: opt(bool()),
			}),
			obj({ id: str(), token: str(), cookie: str() }),
		),
		// verify 返回 principal 或 null；null 同时表示未知、已撤销、过期和格式错误，避免区分原因。
		/** The principal `token` authenticates as, or `null` (unknown, revoked, expired, malformed). */
		verify: method(str(), unknown()),
		// revoke 立即让 token 失效；对不存在的 id 也成功。
		/** Ends session `id` at once: its token authenticates nothing more. */
		revoke: method(str()),
	},
});

// cookie 名称固定；修改它会使已有浏览器会话失效。
/** The name of the kit's session cookie. */
export const SESSION_COOKIE = "chord-session";

// 持久化文档按 id 保存 hash、标签、种类、principal 的 JSON 文本和时间戳。
/** The stored sessions: by id, each with its secret's hash and its principal (as JSON text: any of the app's). */
// principal 存成字符串而非 JSON 值，因为应用身份类型不在本文件的编译期范围内。
const SessionsDocument = defineState("chord.app.sessions", {
	// 外层 schema 是 sessions 映射；映射键就是会话 id。
	schema: obj({
		sessions: map(
			obj({
				hash: str(),
				label: str(),
				// 持久文档拒绝 ephemeral：临时会话不能落盘。
				kind: oneOf("browser", "device"),
				principal: str(),
				created: num(),
				lastUsed: num(),
			}),
		),
	}),
	version: 1,
	// 初始为空映射；persist 让 browser/device 会话跨重启保留。
	initial: () => ({ sessions: {} }),
	persist: true,
	// 累计 50 个增量写检查点，限制文档日志增长。
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

// 认证成功时最多每分钟写一次 lastUsed，避免每个请求都提交文档。
/** How often a session's `lastUsed` is written at most: once a minute (not one commit per request). */
const TOUCH_MS = 60_000;

// 闲置超过 400 天的会话在下一次使用时删除，与 cookie 的 Max-Age 对齐。
/** How long a persisted session lives unused: 400 days, as its cookie. */
const SESSION_IDLE_MS = 400 * 24 * 60 * 60_000;

// 临时会话上限默认 1000；超过时 EphemeralSessions 淘汰最老的一项。
/** The sessions' limits: how many ephemeral sessions live at once (1,000 by default; past it the oldest ends). */
export type SessionLimits = { readonly maxEphemeral?: number };

// KitSessions 组合 facet 与 links 的 opened 钩子；startServer 把两者接入 HTTP 和链路层。
/** The kit's sessions: the facet for the server's core facets, and the links endpoint's `opened` hook. */
export type KitSessions<P extends Principal> = {
	readonly facet: Facet<P>;
	// opened 接收原请求，返回关闭回调；只有临时会话需要按连接计数。
	/** A link opened with `request`'s credentials: an ephemeral session's links are counted (it ends with its last). */
	readonly opened: (request: HttpRequest) => (() => void) | undefined;
};

// 创建会话子系统：输入 cookie 签名密钥和上限，返回 facet 与 opened 钩子。
// 副作用：创建内存临时会话表；持久化在 facet 加载后由文档完成。
// 例子：const kit = createSessions(secret, { maxEphemeral: 100 }); host 加载 kit.facet，HTTP 用 kit.opened 记录连接。
/**
 * The kit's sessions: its facet serving `Sessions` (a host-lifetime object) and contributing its authenticator (the
 * bearer token first, else the session cookie signed with `cookieSecret`), and the links hook ending an ephemeral
 * session with its client's connection.
 */
export function createSessions<P extends Principal>(cookieSecret: string, limits: SessionLimits = {}): KitSessions<P> {
	// 临时会话管理器只保存在内存；maxEphemeral 缺省 1000。
	const ephemeral = new EphemeralSessions(limits.maxEphemeral ?? 1000);
	// opened 在每次链路打开时调用；它先从 Bearer 或 cookie 取 token。
	const opened = (request: HttpRequest): (() => void) | undefined => {
		// Bearer 优先，其次读取签名 cookie；两者都失败得到 undefined。
		const token = bearerToken(request) ?? readCookie(request, SESSION_COOKIE, cookieSecret);
		// token 的 id 是第一个点之前的部分；没有点或点在开头时 dot 为 -1 或 0。
		const dot = token?.indexOf(".") ?? -1;
		// 只有 dot > 0 才查临时会话；slice(0, dot) 取 id。! 表示此分支 token 非空。
		return dot > 0 ? ephemeral.linkOpened(token!.slice(0, dot)) : undefined;
	};
	// facet 负责 HTTP 认证与 Sessions 对象；opened 单独交给链路层计数。
	return { facet: sessionsFacet<P>(cookieSecret, ephemeral), opened };
}

// 构造 Sessions 的 facet：输入 cookie 密钥和临时会话表，返回 Facet<P>。
// 所有服务器主机共享同一临时表；持久会话通过文档状态访问。
/** The facet of `createSessions`. */
function sessionsFacet<P extends Principal>(cookieSecret: string, ephemeral: EphemeralSessions): Facet<P> {
	// defineFacet 的 setup 在加载时执行，注册本地契约并贡献认证器/包装。
	return defineFacet<P>((host) =>
		// host.serve 创建 host-lifetime 对象；每个服务器只有一个 Sessions。
		host.serve(Sessions, (_params, self) => {
			// 取得持久会话文档的状态句柄。
			const document = self.state(SessionsDocument);
			// change 是内部小助手：把修改包进文档变更，并忽略失败（认证路径不能因记账失败而拒绝请求）。
			const change = (fn: (sessions: Record<string, { lastUsed: number }>) => void, context: Context) =>
				// Not awaited by authentication: the request goes on; a write that fails is made again by a later request.
				// void 表示有意不等待；catch 吞掉错误，下一次请求会再尝试写入。
				void document.change((draft) => fn(draft.sessions), context).catch(() => {});
			/** The principal of `token`, or `undefined`; touches or lazily removes the persisted session it names. */
			// authenticate 验证 token：先查临时会话，再查持久文档；成功返回 principal。
			const authenticate = (token: string, context: Context): Principal | undefined => {
				// 找 id 与 secret 的分隔点；没有点或 id 为空都非法。
				const dot = token.indexOf(".");
				if (dot <= 0) return undefined;
				// id 是点之前，secret 是点之后；secret 可以包含点吗？这里只按第一个点切分，后续内容都算 secret。
				const id = token.slice(0, dot);
				const secret = token.slice(dot + 1);
				// 先查内存临时会话；临时会话没有持久文档记录。
				const short = ephemeral.get(id);
				// 摘要匹配时返回 principal；临时会话不更新 lastUsed，也不做 400 天过期。
				if (short !== undefined) return matchesHash(secret, short.hash) ? short.principal : undefined;
				// A trust boundary: `id` is the client's (`Object.hasOwn`: no inherited member is a session).
				// 持久会话是调用方 id 的信任边界：Object.hasOwn 防止 constructor/__proto__ 被当成会话。
				const sessions = document.value.sessions;
				// 没有自有键直接失败，不区分未知与继承键。
				if (!Object.hasOwn(sessions, id)) return undefined;
				// 非空断言：上一步已确认键存在。
				const session = sessions[id]!;
				// 用恒定时间比较摘要；secret 错误时不泄露其他信息。
				if (!matchesHash(secret, session.hash)) return undefined;
				// 两个时间判断共用同一个 now。
				const now = Date.now();
				// 闲置超过 400 天即过期，删除记录并拒绝。
				if (now - session.lastUsed > SESSION_IDLE_MS) {
					// 删除通过文档变更异步进行；本次请求立即失败。
					change((draft) => {
						delete draft[id];
					}, context);
					// 过期判断后返回 undefined，不更新 lastUsed。
					return undefined;
				}
				// 超过一分钟未记账才写 lastUsed，避免每个请求一次提交。
				if (now - session.lastUsed > TOUCH_MS) {
					// change 内先检查键仍在，防止并发撤销后写入不存在的会话。
					change((draft) => {
						// 只更新 lastUsed，不延长其他字段。
						if (Object.hasOwn(draft, id)) draft[id]!.lastUsed = now;
					}, context);
				}
				// principal 由 issue 从应用身份序列化，运行时 JSON.parse 后断言为 Principal。
				// Stored by `issue` from a principal of the app's type.
				// 认证器只返回身份，不修改请求；它可被多个组件复用。
				return JSON.parse(session.principal) as Principal;
			};
			// 向 Authenticators 贡献认证函数；Http 用它填充 ctx.principal。
			self.contribute(Authenticators, (request, context) => {
				// 认证顺序与 opened 一致：Bearer 优先于 cookie。
				const token = bearerToken(request) ?? readCookie(request, SESSION_COOKIE, cookieSecret);
				// 没有 token 时返回 undefined，让其他认证器继续尝试。
				return token === undefined ? undefined : authenticate(token, context);
			});
			// 向 Http 贡献响应头阶段的包装，用于滚动 cookie。
			self.contribute(Http, { wraps: [rollingCookie(cookieSecret, authenticate)] });
			// 返回对象实现 Sessions 契约。
			return {
				// list 从文档派生；ephemeral 不在文档中，因此不会出现。
				list: self.derive([document], ([value]) =>
					// 解构只取需要的字段；id 来自映射键。
					Object.entries(value.sessions).map(([id, { label, kind, principal, created, lastUsed }]) => ({
						id,
						label,
						kind,
						// Stored by `issue` as JSON text.
						// principal 的 JSON 文本在读取时解析；应用身份形状由应用保证。
						principal: JSON.parse(principal) as JsonValue,
						created,
						lastUsed,
					})),
				),
				// issue 生成 id 与 secret，再按种类选择临时或持久路径。
				issue: async ({ principal, label, kind, secure }, ctx) => {
					// id 12 字节、secret 32 字节；两者都来自加密随机源。
					const id = newToken(12);
					// secret 不保存明文，只保存摘要。
					const secret = newToken(32);
					// ephemeral 分支只写内存，不触碰 store。
					if (kind === "ephemeral") {
						// Principals are the app's: `issue`'s callers pass one of its type.
						// principal 在运行时由应用传入，断言成 Principal 供临时表保存。
						ephemeral.issue(id, hashToken(secret), principal as Principal);
						// browser/device 分支持久化，重启后仍可用。
					} else {
						// created 与 lastUsed 使用同一时刻，避免两条记录出现微小差异。
						const now = Date.now();
						// principal 序列化成 JSON 文本后存入文档。
						const stored = JSON.stringify(principal);
						// 文档变更在返回 token 前提交；失败会让 issue 抛错。
						await document.change((draft) => {
							// hash 只保存 secret 的摘要；label 用于管理列表。
							draft.sessions[id] = {
								hash: hashToken(secret),
								label,
								kind,
								// kind 在这里已排除 ephemeral，schema 允许 browser/device。
								principal: stored,
								// created 与 lastUsed 初始相同。
								created: now,
								lastUsed: now,
							};
						}, ctx);
					}
					// token 是 id 与 secret 的组合，只在签发时返回一次。
					const token = `${id}.${secret}`;
					// provenance 只影响 cookie 的 Secure 属性：远程为 remote，本地为 local。
					// Only whether the browser is remote matters to the cookie (`Secure`).
					// secure === true 用严格比较；缺省按本地处理。
					const provenance: Provenance = secure === true ? { kind: "remote", host: "" } : { kind: "local" };
					// sessionCookie 使用密钥签名，并选择是否设置 Max-Age。
					const set = sessionCookie(token, kind, { provenance }, cookieSecret);
					// 返回 id、明文 token 与 Set-Cookie 文本；调用方负责把 token 交给客户端。
					return { id, token, cookie: set };
				},
				// verify 复用 authenticate；JSON 值断言与 null 兼容；没有身份时返回 null。
				verify: async (token, ctx) => (authenticate(token, ctx) as JsonValue | undefined) ?? null,
				// revoke 先尝试临时会话；revoke 返回是否找到。
				revoke: async (id, ctx) => {
					// 临时会话已删除就成功返回，不再查持久文档。
					if (ephemeral.revoke(id)) return null;
					// 持久会话通过文档变更删除；不存在的 id 也成功。
					await document.change((draft) => {
						delete draft.sessions[id];
					}, ctx);
					// 返回 null 表示撤销完成。
					return null;
				},
			};
		}),
	);
}

// 生成会话 cookie：token、种类、请求的 provenance 和签名密钥；返回 Set-Cookie 文本。
// 持久会话的 Max-Age 是 400 天，临时会话不设置，浏览器关闭即失效。
/**
 * The session cookie carrying `token` (a session of `kind`) for a browser of `request`'s provenance: a persisted
 * session's lives as long as the session does unused (400 days, renewed by `rollingCookie`), an ephemeral one's only
 * while the browser runs.
 */
function sessionCookie(
	token: string,
	kind: SessionKind,
	request: Pick<HttpRequest, "provenance">,
	secret: string,
): string {
	// ephemeral 没有 Max-Age；其他种类使用 SESSION_IDLE_MS 的秒数。
	const maxAge = kind === "ephemeral" ? undefined : SESSION_IDLE_MS / 1000;
	// cookie 辅助函数负责签名、HttpOnly、SameSite 和 Secure 属性。
	return cookie(SESSION_COOKIE, token, { secret, request, maxAge });
}

// cookie 使用一天后才滚动续期，避免每个响应都改 cookie。
/** How old a session cookie gets before a response renews it: a day. */
const ROLL_MS = 24 * 60 * 60_000;

// 响应头阶段的 HttpWrap：请求认证成功后，如果 cookie 足够旧，就在响应里重新设置带新签名的 cookie。
// 不续期的情况：没有 principal、路由已设置 Set-Cookie、临时会话无到期时间、cookie 还很新、或 token 已不再有效。
// 例子：浏览器连续使用 401 天仍可保持登录；旧 cookie 的签名过期后自动换成新 cookie。
/**
 * The wrap around every route renewing the session cookie a request signed in with once it is older than a day: the
 * response sets it again with a fresh signed expiry, so a browser used within every 400 days stays signed in. Not when
 * the route sets a cookie itself, nor for an ephemeral session's (it has no expiry) or a token that no longer
 * authenticates.
 */
function rollingCookie(
	secret: string,
	authenticate: (token: string, context: Context) => Principal | undefined,
): HttpWrap {
	// wrap 有名字便于排错；phase 为 headers 表示在响应头生成阶段运行。
	return {
		name: "chord.app.rolling-cookie",
		// scope: all 表示所有路由都经过此包装。
		phase: "headers",
		scope: "all",
		// 先执行后续处理得到响应；包装在响应返回前修改 headers。
		wrap: async (request, next, ctx) => {
			// 先取响应；认证失败或没有 principal 时不续期。
			const response = await next(request);
			// 路由自行设置 Set-Cookie（例如登录）时不覆盖；Object.keys 对 headers 可能为 undefined。
			if (ctx.principal === undefined || Object.keys(response.headers ?? {}).some(isSetCookie)) return response;
			// 读取并验证签名 cookie；读不到或不匹配得到 undefined。
			const signed = readSignedCookie(request, SESSION_COOKIE, secret);
			// expires 不存在是临时会话，不续期；剩余寿命大于 399 天说明还新，也不续期。
			if (signed?.expires === undefined || signed.expires - Date.now() > SESSION_IDLE_MS - ROLL_MS) return response;
			// 再次认证，确认会话没有被撤销或过期；失败则不续期。
			if (authenticate(signed.value, ctx) === undefined) return response;
			// 用原 token 生成新的持久浏览器 cookie；不改变服务端会话记录。
			const renewed = sessionCookie(signed.value, "browser", request, secret);
			// 展开原响应并替换 Set-Cookie；其他头保持不变。
			return { ...response, headers: { ...response.headers, "Set-Cookie": renewed } };
		},
	};
}

// Header 名称大小写不敏感，统一转小写比较。
/** Whether a header name is `Set-Cookie` (any case). */
function isSetCookie(name: string): boolean {
	return name.toLowerCase() === "set-cookie";
}

// 从 Authorization 头提取 Bearer token；没有头、格式不符或空 token 返回 undefined。
/** The token of an `Authorization: Bearer <token>` header. */
function bearerToken(request: HttpRequest): string | undefined {
	// headers.get 返回 string 或 null。
	const header = request.headers.get("authorization");
	// 正则忽略大小写，要求 Bearer 后至少一个非空白字符；exec 返回匹配数组或 null。
	const match = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
	// match?.[1] 安全取第一个捕获组；没有匹配时为 undefined。
	return match?.[1];
}
