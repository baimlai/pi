// The invite plugin (slice 13 §3, decision "The app kit, point 2"): the owner makes an invite link for a principal of
// the app it chooses (`POST /_chord/invites`, owner only: `{ principal, label }` → `{ path }`); the invitee opens it,
// its page posts the token (the URL's fragment, never logged) to `POST /_chord/invite`, which consumes it (single use,
// 7 days) and answers with a browser session for that principal (§2's sessions). Invites wait in memory: a restart
// drops the ones not used. An exported facet, as `defineUsers` (see there why).

// 所属：packages/chord/src/node/app，app kit 的邀请插件（slice 13 §3；decision 点 2）。
// 职责边界：owner 创建一次性邀请链接，受邀者用 fragment token 换取指定 principal 的浏览器会话；邀请只存内存。
// 上游：应用把 inviteFacet() 导出到 API 并在服务器根加载；下游：Sessions 签发会话，owner.ts 的 fragmentPage 提供页面。
// 结果与错误：创建成功返回 { path }；非 owner 403，参数形状错 400，无效或过期 token 403，GET 页面固定 200。
// 能力清单：INVITE_MS/INVITE_PATH 是限制与路由；Invite 是记录；inviteFacet 创建 facet；三个路由完成创建、页面和消费。
// 组合顺序：POST /_chord/invites → 生成 token/hash → Map；GET 页面 → 浏览器读 fragment → POST /_chord/invite → sessions.issue。
// 示例：const facet = inviteFacet<AppPrincipal>(); // owner 已登录后 POST /_chord/invites { principal, label }
// 建议阅读顺序：先看 Invite 和常量，再看 inviteFacet 的三个路由。
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { Http } from "../http/index.ts";
import { fragmentPage } from "./owner.ts";
import { hashToken, newToken } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

// 有效期与路径常量：7 天、固定路由；改这里会影响所有邀请。
/** How long an invite is valid: 7 days. */
const INVITE_MS = 7 * 24 * 60 * 60_000;

/** The invite link's path: its page, and the post that consumes it. */
const INVITE_PATH = "/_chord/invite";

/** An invite waiting: the principal it signs in, its label, its expiry. */
// Invite 记录受邀身份、显示标签和到期时间；principal 以 JsonValue 存储，签发会话时不再校验业务形状。
type Invite = { readonly principal: JsonValue; readonly label: string; readonly expires: number };

/** The invite plugin's server facet. */
// 创建邀请 facet：无输入，返回绑定 principal 类型 P 的 Facet。
// 每次调用创建独立的内存 Map；例如 inviteFacet<MyPrincipal>() 后所有路由共享这一个 Map。
// 错误路径：非 owner 的创建请求 403，参数形状不对 400，无效或过期 token 403。
export function inviteFacet<P extends Principal>(): Facet<P> {
	// By their token's hash: what the map holds is no credential.
	// 键是 token 的 SHA-256 而非 token 本身；即使内存被读取，也不能直接得到可用邀请。
	const invites = new Map<string, Invite>();
	// defineFacet 的第二个参数 self 用于贡献 HTTP 路由；_host 未使用。
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				// 创建邀请的 POST 路由：默认不公开，Http 组件先做认证，因此这里假定 principal 已解析。
				"POST /_chord/invites": async (request, ctx) => {
					// 只有 owner 身份能创建邀请；可选链 ctx.principal?.kind 处理匿名请求。
					if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
					// A trust boundary: the owner's request, checked for its shape.
					// 请求体是信任边界：request.json() 解析 JSON，随后手写 typeof 检查，因为 as 只是编译期断言。
					const body = (await request.json()) as {
						readonly principal?: JsonValue;
						readonly label?: unknown;
					} | null;
					const principal = body?.principal;
					// principal 必须是对象且 label 必须是字符串；不在这里验证 principal 的业务字段，那是应用的责任。
					if (typeof principal !== "object" || principal === null || typeof body?.label !== "string") {
						return { kind: "error", status: 400 };
					}
					// 生成随机 token 并只保存摘要和到期时间；path 中的 fragment 不会随 HTTP 请求发送。
					const token = newToken();
					// Map 以摘要为键，邀请记录中不含 token 明文。
					invites.set(hashToken(token), { principal, label: body.label, expires: Date.now() + INVITE_MS });
					// json 响应把带 fragment 的链接交给 owner；服务端日志看不到 fragment。
					return { kind: "json", value: { path: `${INVITE_PATH}#${token}` } };
				},
				// GET 路由是公开的登录页；页面脚本读取 location.hash 并 POST 回来。
				[`GET ${INVITE_PATH}`]: {
					// public: true 表示跳过默认认证；页面本身不含邀请秘密，秘密只在 fragment 中。
					public: true,
					// fragmentPage 用响应 nonce 约束内联脚本；nonce 由 Http 组件生成。
					handler: async (request) => ({ kind: "html", body: fragmentPage(INVITE_PATH, request.nonce) }),
				},
				// 消费邀请的 POST 也是公开的：邀请 token 自己就是这次请求的凭据。
				[`POST ${INVITE_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						// A trust boundary: anyone may post here.
						// 请求体解析：token 可能是任意 JSON，运行时检查字符串后再取摘要。
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// hash 为 undefined 或 Map 找不到时都按无效邀请处理，统一 403，避免泄露 token 是否存在。
						const hash = typeof body?.token === "string" ? hashToken(body.token) : undefined;
						// invite 变量同时收窄类型；下一行据此决定是否删除。
						const invite = hash === undefined ? undefined : invites.get(hash);
						if (hash === undefined || invite === undefined) return { kind: "error", status: 403 };
						// 先删除再检查过期：无论 token 是否刚过期，都只能尝试一次。
						invites.delete(hash);
						// 到期后返回 403；删除已发生，过期邀请不会被再次使用。
						if (invite.expires <= Date.now()) return { kind: "error", status: 403 };
						// 从上下文取 Sessions 契约；ctx.get 按契约定位到服务器上的会话对象。
						const sessions = await ctx.get(Sessions, {});
						// 非本地请求（经网络或代理）的 cookie 加 Secure；本地 HTTP 测试不加，否则浏览器不发送。
						const secure = request.provenance.kind !== "local";
						// 为邀请记录中的身份签发浏览器会话；label 是 owner 创建邀请时填写的标签。
						const issued = await sessions.issue(
							{ principal: invite.principal, label: invite.label, kind: "browser", secure },
							ctx,
						);
						// 响应把会话 cookie 交给浏览器；JSON 值只是给脚本看的成功标记。
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}
