// The owner (slice 13 §2, decision "The app kit, point 3: authentication"): no owner by loopback alone. At each start
// the kit makes a one-time owner link (a random token, single use, valid 10 minutes, the previous one dropped); the
// start script prints it. Its page reads the token from the URL's fragment (never sent to a server, so never in a
// log) and posts it; the post consumes it and sets a browser session cookie for the owner. The owner token file
// (mode 0600) carries a device session of the owner for command-line clients on the same machine.

// 所属：packages/chord/src/node/app，app kit 的 owner 登录（slice 13 §2；decision 点 3）。
// 职责边界：管理一次性 owner link、提供登录页和提交路由、维护命令行 token 文件；不负责会话存储本身。
// 上游：startServer 调用 new OwnerLink/renew/ownerFacet/ownerTokenFile；下游：Sessions 签发浏览器或设备会话，secrets 生成和比较 token，Http 提供路由。
// 结果与错误：renew 返回 token；consume 返回布尔值并消耗匹配 token；ownerTokenFile 返回 token，文件错误传播；POST 无效 token 403。
// 能力清单：OwnerPrincipal/OWNER 是身份；OwnerLink 管理单次 token；OWNER_PATH 是路由；ownerFacet 提供页面和提交；fragmentPage 生成登录页；ownerTokenFile 读取或建设备 token；isOwner 检查身份。
// 组合顺序：startServer → link.renew() → ownerFacet → 页面 POST → link.consume → sessions.issue；ownerTokenFile → sessions.verify/issue → writeSecret。
// 示例：const link = new OwnerLink(); const token = link.renew(); // 把 token 放进 URL fragment
// 建议阅读顺序：先看 OwnerLink 与 OWNER_PATH，再看 ownerFacet/fragmentPage，最后 ownerTokenFile/isOwner。
import { chmod } from "node:fs/promises";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { Http } from "../http/index.ts";
import { hashToken, matchesHash, newToken, readSecret, writeSecret } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

// OwnerPrincipal 是只有 kind 的最小身份；应用的 principal 联合必须包含它，否则 startServer 的类型约束不通过。
/** The kit's owner principal: a variant every app's principal type has. */
export type OwnerPrincipal = { readonly kind: "owner" };

// 常量 OWNER 被多处复用；对象内容不变，返回它时不要修改。
/** The owner principal. */
export const OWNER: OwnerPrincipal = { kind: "owner" };

// 链接有效期 10 分钟，与 token 是否被使用无关。
/** How long an owner link is valid: 10 minutes. */
const OWNER_LINK_MS = 10 * 60_000;

// OwnerLink 保存当前 token 的摘要和到期时间，不保存 token 明文。
/** The owner link's one-time token: made at each start (the previous one dropped), consumed by its first use. */
export class OwnerLink {
	// 私有 # 字段只能由类内访问；外部无法读取摘要，避免误打印。
	#hash: string | undefined;
	#expires = 0;

	// renew 生成新 token 并替换当前摘要，使旧链接立即失效；返回明文供启动脚本打印。
	/** A fresh token (the previous one no longer valid), valid for 10 minutes. */
	renew(): string {
		// newToken 使用加密随机源，默认 32 字节。
		const token = newToken();
		// 这里只存 SHA-256；比较时用 matchesHash 的恒定时间实现。
		this.#hash = hashToken(token);
		// 每次 renew 都重置 10 分钟窗口。
		this.#expires = Date.now() + OWNER_LINK_MS;
		return token;
	}

	// consume 校验并消耗 token：匹配当前摘要时，无论是否过期都会把它作废；返回是否成功登录。
	// 输入是调用方提交的字符串，输出布尔值；无 I/O。例子：consume(旧 token) 返回 false，且不影响当前 token。
	/** Whether `token` is the current one and has not expired; it is used up either way when it matches. */
	consume(token: string): boolean {
		// 先复制私有字段到局部变量；undefined 表示没有可用链接（首次启动或已消耗）。
		const hash = this.#hash;
		// 摘要不匹配直接失败；matchesHash 处理长度差异并做恒定时间比较。
		if (hash === undefined || !matchesHash(token, hash)) return false;
		// 匹配后立即清空摘要，保证单次使用；是否过期在下一行判断。
		this.#hash = undefined;
		// 只有时间未到才返回 true；过期 token 已被消耗，不能重试。
		return Date.now() < this.#expires;
	}
}

// owner 路由路径同时用于页面和提交。
/** The path of the owner link's page and post. */
export const OWNER_PATH = "/_chord/owner";

/**
 * The kit's facet for the owner link: `GET /_chord/owner`, a page posting the fragment's token, and `POST
 * /_chord/owner`, which consumes it and answers with the owner's session cookie.
 */
// 创建 owner 登录 facet：输入 OwnerLink，返回 Facet<P>；GET 返回读 fragment 的页面，POST 消耗 token 并签发浏览器会话。
// 错误路径：token 非字符串或无效/过期时返回 403；会话签发失败向上传播。
export function ownerFacet<P extends Principal>(link: OwnerLink): Facet<P> {
	// defineFacet 的 self 用于贡献 Http；_host 未使用。
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				// GET 路由公开：登录页本身不含秘密，秘密在 URL fragment 中。
				[`GET ${OWNER_PATH}`]: {
					public: true,
					// fragmentPage 用请求 nonce 生成 CSP 兼容的内联脚本。
					handler: async (request) => ({ kind: "html", body: fragmentPage(OWNER_PATH, request.nonce) }),
				},
				// POST 路由也公开：token 是这一请求的凭据。
				[`POST ${OWNER_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						// 请求体是信任边界；as 只用于编译期，下面逐个检查字段。
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// A trust boundary: anyone may post here.
						// token 必须是字符串且 consume 成功，否则统一 403。
						if (typeof body?.token !== "string" || !link.consume(body.token))
							return { kind: "error", status: 403 };
						// 从服务器对象取 Sessions；这里拿到的是会话契约而非全局单例。
						const sessions = await ctx.get(Sessions, {});
						// 本地回环请求不加 Secure，浏览器才会在 http://localhost 上发送 cookie；远程请求加 Secure。
						const secure = request.provenance.kind !== "local";
						// 为 owner 签发浏览器会话；label 只用于管理列表。
						const issued = await sessions.issue(
							{ principal: OWNER, label: "owner browser", kind: "browser", secure },
							ctx,
						);
						// 把 cookie 放进响应头；JSON 值是给页面脚本看的成功标记。
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}

/**
 * A sign-in page for a link with a token in its fragment (the owner link, an invite): its script (the response's nonce)
 * posts the token to `path`, then opens the app.
 */
// 生成登录页 HTML：脚本从 location.hash 读取 token，替换掉历史记录里的 fragment，然后 POST 到 path。
// 输入 path 和 CSP nonce，输出字符串；无副作用。owner 链接和邀请页共用此函数。
// token 在执行时由浏览器从 fragment 取得，不会进入服务端渲染的 HTML；nonce 来自响应头生成器。
export function fragmentPage(path: string, nonce: string): string {
	// 数组各元素是 HTML 行；join 在末尾合成为完整页面。
	return [
		// 页面先显示状态文本，脚本执行后替换或跳转。
		"<!doctype html><title>Sign in</title><p id=status>Signing in…</p>",
		// nonce 属性让浏览器允许这段内联脚本；脚本内容本身不含 token。
		`<script nonce="${nonce}">`,
		// location.hash.slice(1) 读取 # 后的 token；history.replaceState 立即从地址栏移除它，避免复制或历史泄露。
		"const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);",
		// JSON.stringify(path) 生成带引号的 JS 字符串；fetch 发送 JSON 体。
		`fetch(${JSON.stringify(path)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })`,
		// 成功就跳转根路径，失败显示固定提示；不使用服务端返回的错误文本，避免注入。
		"  .then((r) => { if (r.ok) location.replace('/'); else document.getElementById('status').textContent = 'This link is used up or expired.'; });",
		// 脚本结束标签；join 后形成完整页面。
		"</script>",
	].join("\n");
}

/**
 * The owner token file at `path`: kept when its token still authenticates as the owner (its session exists, its secret
 * matches, it has not expired; its mode set to 0600 again), else a new device session of the owner written there (mode
 * 0600, in one step). Its token, for the start script.
 */
// 读取或创建 owner 的命令行 token 文件：已有 token 仍能认证为 owner 时复用并恢复 0600；否则签发新的设备会话并原子写入。
// 输入 path、host、context；输出 token 字符串。文件读写和 chmod 的 I/O 错误会传播。
// 在 host.root 回调里执行，是为了取得服务器主机上的 Sessions 对象和一致上下文。
// 例子：启动后打印此 token，客户端用 Authorization: Bearer <token> 访问。
export async function ownerTokenFile<P extends Principal>(
	path: string,
	host: Host<P>,
	context: Context,
): Promise<string> {
	// 先读文件；不存在得到 undefined。
	const existing = await readSecret(path);
	// host.root 在服务器的根上下文中执行回调，回调可安全访问核心对象。
	return host.root(async (ctx) => {
		// 取得 Sessions 契约。
		const sessions = await ctx.get(Sessions, {});
		// verify 检查会话存在、secret 摘要匹配且未过期；isOwner 再检查身份种类。
		if (existing !== undefined && isOwner(await sessions.verify(existing, ctx))) {
			// 仍有效时重新设置 0600，修复曾被放宽权限的文件。
			await chmod(path, 0o600);
			// 返回原 token，保持命令行客户端可用。
			return existing;
		}
		// 失效时签发新的设备会话；设备会话持久化在 store 中。
		const { token } = await sessions.issue({ principal: OWNER, label: "owner token file", kind: "device" }, ctx);
		// 存在旧文件用 replace，首次用 create；writeSecret 保证 0600 与原子发布。
		await writeSecret(path, token, existing === undefined ? "create" : "replace");
		// 返回新 token。
		return token;
	}, context);
}

/** Whether `principal` (as `Sessions.verify` gives it) is the owner. */
// isOwner 是运行时形状检查：verify 返回 unknown，不能直接按编译期类型访问 kind。
function isOwner(principal: unknown): boolean {
	// 只检查对象非空且 kind === 'owner'；principal 的其他字段与这里无关。
	return typeof principal === "object" && principal !== null && (principal as { kind?: unknown }).kind === "owner";
}
