// 对服务器给的浏览器链接做协议边界检查，供设备码/发现流程使用；函数名不代表域名白名单验证。
/**
 * The `http:` or `https:` URL `value` names, normalized, or null. Login flows open server-supplied URLs with the
 * platform URL handler, which would also launch a `file:` URL or a custom protocol handler. Normalizing
 * percent-encodes control characters, so the URL can also be embedded in terminal hyperlinks.
 */
/**
 * 把未知输入限制为可解析的http/https URL，返回标准化href或null，不访问网络。
 * 例：file:///tmp/a被拒绝，https://example.test/path被接受；这只限定协议与格式，不验证域名归属、目标服务身份或链接内容可信。
 */
export function trustedHttpUrl(value: unknown): string | null {
	// unknown来自网络等外部边界，先确认字符串且URL可解析，否则返回null。
	if (typeof value !== "string" || !URL.canParse(value)) return null;
	// 用URL对象规范化路径/主机与转义，构造对象本身不发HTTP。
	const url = new URL(value);
	// 只允许两种Web协议，原样返回标准化href；不限制必须HTTPS或必须官方域名。
	return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}
