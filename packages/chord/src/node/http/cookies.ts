// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的签名 cookie 工具（slice 10，安全基线 (5)）。
// 职责边界：只生成和读取 Set-Cookie/Cookie 文本，不做会话存储、加密、CSRF 防护或请求准入。
// 上游入口：路由在响应头中调用 cookie(...)；后续请求的路由/认证器调用 readCookie/readSignedCookie。
// 下游依赖：node:crypto 的 createHmac/timingSafeEqual、HttpRequest.headers 与 provenance（决定 Secure）。
// 结果与错误流向：cookie 返回可直接放入 Set-Cookie 的字符串；读取函数在签名、名字、密钥或到期时间不匹配时
// 返回 undefined，不抛错；URI 解码失败也按无效凭据处理。Cookie 文本经响应头写回客户端。
// 能力清单：
// - CookieOptions：密钥、请求来源、SameSite 与 maxAge 选项；
// - cookie：生成带 HMAC-SHA256 签名和安全默认属性的 Set-Cookie 值；
// - readCookie：读取并验签，只返回值；
// - readSignedCookie：读取并验签，同时返回签名载荷中的到期时间（毫秒），供续期判断。
// 组合关系：cookie 把 encodedValue.expiry 作为 payload 签名；readCookie 委托 readSignedCookie，后者拆出
// 名字、payload、到期秒数和签名，先等长比较 HMAC，再检查到期时间，最后 URI 解码。
// 示例：const set = cookie("session", "owner:1", { secret, request, maxAge: 3600 });
//       const value = readCookie(request, "session", secret); // 验签通过返回 "owner:1"，否则 undefined
// 建议阅读顺序：先看 CookieOptions 与 cookie 的格式，再看 readSignedCookie 的拆分/验签流程，
// 最后看 readCookie 与 signature 两个薄封装。
// Cookies (decision "The HTTP component's security baseline" (5)): `cookie` makes a signed `Set-Cookie` value with the
// safe defaults (`HttpOnly`, `Path=/`, `SameSite=Strict`, `Secure` on a remote origin), `readCookie` reads one back,
// its signature checked in constant time.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "./request.ts";

/** What `cookie` takes besides the name and the value. */
export type CookieOptions = {
	// readonly 只禁止 TypeScript 调用方重新赋值；这些选项本身不会冻结，也不是浏览器输入的运行时校验器。
	// 签名密钥：同一份 cookie 用不同密钥签署后无法互相验证；密钥本身不进入 cookie 文本。
	/** The key it is signed with (HMAC-SHA256). */
	readonly secret: string;
	// 只取请求的 provenance（来源），据此决定是否添加 Secure；不需要完整请求对象。
	/** The request it answers (its provenance): a remote one gets `Secure`. */
	readonly request: Pick<HttpRequest, "provenance">;
	// 默认 Strict：其他站点发起的导航不会携带；Lax 允许顶层 GET 导航携带，适合登录回跳。
	/** `Strict` by default; `Lax` lets a top-level navigation from another site carry it. */
	readonly sameSite?: "Strict" | "Lax";
	// 以秒为单位的有效期；不提供就是会话 cookie。到期时刻会被写进签名载荷，客户端改不了。
	/** Seconds until it expires; none: a session cookie. */
	readonly maxAge?: number;
};

/**
 * A signed `Set-Cookie` value for `name` and `value` (put it in a response's `headers`, `Set-Cookie`). With `maxAge`
 * its expiry is signed with it: a copy read back later is refused (Opus's recheck R3); without, it holds until the
 * secret changes.
 */
// 生成响应头文本，不写浏览器也不访问网络；输入名字、原值和密钥/来源，输出带签名的 Set-Cookie 字符串。
// 例如 maxAge: 60 会把到期秒数放进签名载荷，并附 Max-Age=60；远程来源还附 Secure。
export function cookie(name: string, value: string, options: CookieOptions): string {
	// URI 编码让分号等字符不能拆开 cookie 值；点仍可出现，因此读取时从右边拆签名。
	const encoded = encodeURIComponent(value);
	// undefined 表示会话 cookie；有时限时按当前时间计算整秒到期时间，并将它签名，客户端无法单独延长。
	const expires = options.maxAge === undefined ? "" : String(Math.floor(Date.now() / 1000 + options.maxAge));
	// 模板字符串拼出“编码值.到期秒数”，不加密原值。
	const payload = `${encoded}.${expires}`;
	// 数组按顺序保存主值及属性；?? 只在未提供 SameSite 时选 Strict。
	const parts = [
		`${name}=${payload}.${signature(name, payload, options.secret)}`,
		"HttpOnly",
		"Path=/",
		`SameSite=${options.sameSite ?? "Strict"}`,
	];
	// relayed 与 remote 都视为需要安全传输，只有 local 不添加 Secure。
	if (options.request.provenance.kind !== "local") parts.push("Secure");
	// maxAge 使用向下取整的秒数；不提供时省去此属性。
	if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
	// 仅返回文本，由路由放入 Set-Cookie 响应头。
	return parts.join("; ");
}

/**
 * The value of cookie `name` on `request` when its signature with `secret` holds and its signed expiry has not passed;
 * `undefined` otherwise.
 */
// 从请求取指定 cookie，复用完整签名/到期校验，只暴露值；例如签名损坏返回 undefined，不会抛出解码错误。
export function readCookie(request: HttpRequest, name: string, secret: string): string | undefined {
	// ?. 在校验失败时短路，成功时丢弃调用者不需要的 expires 字段。
	return readSignedCookie(request, name, secret)?.value;
}

/**
 * Cookie `name` on `request` as `readCookie` checks it, with its signed expiry (milliseconds since the epoch; none for
 * a cookie without `maxAge`): what renewing a cookie before it expires needs.
 */
// 读取浏览器提供的 cookie：找到名字、拆签名与时戳、恒定时间比较签名，再 URI 解码。
// 返回 { value, expires } 或 undefined，无写入；expires 为毫秒，便于调用者决定续期。
// 例如未设置 maxAge 的合法值返回 expires: undefined；这里验证的是 wire 文本，as 类型声明不能替代它。
export function readSignedCookie(
	request: HttpRequest,
	name: string,
	secret: string,
): { readonly value: string; readonly expires: number | undefined } | undefined {
	// 缺少 Cookie 头时用空串；按分号逐项寻找，不把整份头当作某个 cookie。
	for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
		// 第一个等号左侧是名字；不匹配或没有等号就检查下一项。
		const equals = pair.indexOf("=");
		if (equals < 0 || pair.slice(0, equals).trim() !== name) continue;
		// 去掉等号后的外围空白，保留值内部内容。
		const signed = pair.slice(equals + 1).trim();
		// From the right: the value may hold dots, the expiry and the signature never do.
		// 最右点分隔签名，载荷内最右点分隔到期时间，值中的其他点属于编码值。
		const dot = signed.lastIndexOf(".");
		const payload = signed.slice(0, dot);
		const expiresAt = payload.lastIndexOf(".");
		// 来自 HTTP 的格式边界：两个分隔点必须齐全。
		if (dot < 0 || expiresAt < 0) return undefined;
		// 把签名字串转为 Buffer，先检查长度以满足 timingSafeEqual 的等长要求。
		const given = Buffer.from(signed.slice(dot + 1));
		const expected = Buffer.from(signature(name, payload, secret));
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
		// 空时戳是无明确到期时间；其余按数值秒转毫秒。签名保证时戳来自持有密钥的写入端。
		const stamp = payload.slice(expiresAt + 1);
		const expires = stamp === "" ? undefined : Number(stamp) * 1000;
		// 等于当前时间也算过期。
		if (expires !== undefined && expires <= Date.now()) return undefined;
		try {
			// decodeURIComponent 可能因不合法的百分号编码抛错，不能让坏 cookie 中断整次认证。
			return { value: decodeURIComponent(payload.slice(0, expiresAt)), expires };
		} catch {
			// 只把解码失败解释为该凭据无效。
			return undefined;
		}
	}
	// 请求中没有同名 cookie。
	return undefined;
}

/** The signature of a cookie's name and payload (its encoded value and expiry). */
// 用密钥签署名字及载荷，返回 base64url 文本，无 I/O；同一载荷不能换到另一个 cookie 名下使用。
// 例如 a=x 与 b=x 的签名输入不同。HMAC 验证完整性，不隐藏载荷。
function signature(name: string, payload: string, secret: string): string {
	// 链式调用建立 SHA-256 HMAC、输入 UTF-8 文本、输出适合 cookie 的编码。
	return createHmac("sha256", secret).update(`${name}=${payload}`).digest("base64url");
}
