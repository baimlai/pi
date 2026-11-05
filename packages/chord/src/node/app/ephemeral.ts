// The ephemeral login plugin (slice 13 §3, decision "The app kit, point 2"): an IRC-like "pick a name and you're in".
// `POST /_chord/login` (public: `{ name }`) issues an ephemeral session for `{ kind: "user", id: <fresh>, name }`
// (the app's principal type must allow it) and answers with its cookie. No account is stored. The session ends with
// the browser (its cookie has no lifetime) or the server (ephemeral sessions are dropped whenever it starts); ending it
// with the client's last link waits for slice 11's clients (carry-over). An exported facet, as `defineUsers`.

// 所属：packages/chord/src/node/app，app kit 的临时登录插件（slice 13 §3；decision 点 2）。
// 职责边界：提供一个公开的 POST /_chord/login，把名字变成新的临时 user 身份并签发 cookie；不校验账号、不存资料。
// 上游：应用通过 API 导出 ephemeralLoginFacet() 的 facet 并在服务器根加载；下游：Sessions 签发临时会话，Http 提供路由。
// 结果与错误：成功返回身份 JSON 和 Set-Cookie；名字为空或非字符串返回 400，请求体超过 4 KiB 由 request.json 拒绝。
// 能力清单：EphemeralUser 是身份形状；MAX_NAME 是 40 字符上限；ephemeralLoginFacet 构造 facet，并用 ..._fits 强制 P 包含临时身份。
// 组合顺序：请求 → request.json → trim/slice → newToken(12) → sessions.issue → Set-Cookie。
// 示例：const facet = ephemeralLoginFacet<AppPrincipal>(); // AppPrincipal 必须含 { kind: 'user'; id: string; name: string }
// 建议阅读顺序：先看 EphemeralUser 与泛型约束，再看路由处理函数。
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import { Http } from "../http/index.ts";
import { newToken } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

// EphemeralUser 是临时登录能产生的身份形状；应用的 principal 联合必须包含它，否则下面的编译期检查失败。
/** The principal an ephemeral login gives. */
export type EphemeralUser = { readonly kind: "user"; readonly id: string; readonly name: string };

// 名字的最大长度 40 个字符；截断发生在服务端，调用方无法绕过。
/** The longest name taken. */
const MAX_NAME = 40;

// 创建临时登录 facet：无普通运行时输入，返回 Facet<P>；加载时贡献一个公开路由。
// 类型参数 P 必须是 Principal，且必须覆盖 EphemeralUser；不满足时调用处编译失败，而不是运行时才发现。
// 副作用只在请求到达时发生：创建会话、写 cookie；函数本身不建会话、不读磁盘。
// 例子：ephemeralLoginFacet<AppPrincipal>() 中 AppPrincipal 必须含 {kind:'user', id, name}，否则无法调用。
/** The ephemeral login plugin's server facet; a type error unless the app's principal type holds `EphemeralUser`. */
// ..._fits 是编译期技巧：条件类型满足时为空元组，不满足时是含错误文字的元组；参数在运行时完全不用。
export function ephemeralLoginFacet<P extends Principal>(
	// EphemeralUser extends P 检查应用身份联合是否覆盖临时用户；字符串只是类型错误提示。
	..._fits: EphemeralUser extends P ? [] : ["the app's principal type must hold { kind: 'user', id, name }"]
): Facet<P> {
	// defineFacet 的 self 用于贡献 Http；_host 未使用。
	return defineFacet<P>((_host, self) =>
		// 把路由表贡献给 Http 组件；同一 facet 可以贡献多个组件路由。
		self.contribute(Http, {
			// routes 的键是 '方法 路径'，值描述处理函数与是否公开。
			routes: {
				// 登录路由固定为 POST /_chord/login。
				"POST /_chord/login": {
					// public: true 表示不需要已有会话；任何人都可以用任意名字登录。
					public: true,
					// handler 接收 HttpRequest 和上下文；返回 json、error 等响应对象。
					handler: async (request, ctx) => {
						// 请求体是信任边界：request.json(4096) 限制 4 KiB，防止超大 JSON。
						// A trust boundary: anyone may log in under a name.
						const body = (await request.json(4096)) as { readonly name?: unknown } | null;
						// name 只在是字符串时 trim 并截到 40；其他类型得到空字符串。as 是编译期断言，不验证运行时形状。
						const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
						// trim 后为空（包括非字符串、null、纯空白）返回 400，不创建身份。
						if (name === "") return { kind: "error", status: 400 };
						// 每次登录生成新的 12 字节随机 id，因此同名用户彼此独立。
						const principal: EphemeralUser = { kind: "user", id: newToken(12), name };
						// 取得 Sessions 契约；ctx.get 定位到当前服务器上的会话对象。
						const sessions = await ctx.get(Sessions, {});
						// 本地回环请求的 cookie 不加 Secure；经网络/代理的请求加 Secure，避免明文传输。
						const secure = request.provenance.kind !== "local";
						// 签发临时会话：principal 是刚生成的身份，label 用名字，kind 为 ephemeral。
						const issued = await sessions.issue({ principal, label: name, kind: "ephemeral", secure }, ctx);
						// json 响应把对象交给 Http 组件序列化；headers 原样附加。
						// 响应返回身份 JSON 和 Set-Cookie；cookie 没有 Max-Age，浏览器关闭即失效（服务器重启也会清除临时会话）。
						return { kind: "json", value: principal, headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}
