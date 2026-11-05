// 为Node网络适配器按环境变量选择HTTP/HTTPS代理，处理NO_PROXY主机/端口例外；只解析地址，不在此建立代理连接。
// 请求级环境覆盖的类型，便于独立配置某供应商代理。
import type { ProviderEnv } from "../types.ts";
// 兼容普通process.env与Bun沙箱回退的统一取值入口。
import { getProviderEnvValue } from "./provider-env.ts";

// URL没显式端口时按协议补目标端口，供NO_PROXY的端口匹配使用。
const DEFAULT_PROXY_PORTS: Record<string, number> = {
	// FTP目标的默认端口。
	ftp: 21,
	// Gopher目标的默认端口。
	gopher: 70,
	// HTTP目标默认80。
	http: 80,
	// HTTPS目标默认443。
	https: 443,
	// 普通WebSocket默认80。
	ws: 80,
	// 加密WebSocket默认443。
	wss: 443,
};

// 用途：查代理环境的大小写名字，优先请求级小写、请求级大写，再全局小写/大写。例http_proxy与HTTP_PROXY并存先取小写；都无值返回空字符串。
function getProxyEnv(key: string, env?: ProviderEnv): string {
	// 代理环境兼容常见两种大小写约定。
	const lowercaseKey = key.toLowerCase();
	// 生成对应大写形式，例如NO_PROXY。
	const uppercaseKey = key.toUpperCase();
	// 按短路或顺序取第一个非空值。
	return (
		// 请求级小写覆盖优先。
		env?.[lowercaseKey] ||
		// 其次请求级大写，不让全局小写压过显式请求配置。
		env?.[uppercaseKey] ||
		// 再从运行环境查小写变量，含Bun兼容回退。
		getProviderEnvValue(lowercaseKey) ||
		// 最后查全局大写变量。
		getProviderEnvValue(uppercaseKey) ||
		// 没配置时用空字符串表示不指定代理/例外列表。
		""
	);
}

// 用途：把合法字符串/已有URL统一为URL；例传https://a.test得到解析结果，坏字符串返回undefined，不因代理探测直接报错。
function parseProxyTargetUrl(targetUrl: string | URL): URL | undefined {
	// 合法联合类型分支：已经是URL就不重新解析。
	if (targetUrl instanceof URL) {
		// 保留调用方URL实例，此函数不修改它。
		return targetUrl;
	}

	// 字符串来自配置或请求目标，可能不是可解析的绝对URL。
	try {
		// 用标准URL规则取得协议、hostname、port等字段。
		return new URL(targetUrl);
		// 这里解析目标失败时只表示无法选代理，后续目标请求自有校验路径。
	} catch {
		// 无可用目标/代理时明确返回缺失。
		return undefined;
	}
}

// 用途：去掉IPv6地址外层方括号。例[::1]变::1，普通example.com不变；不解析完整URL。
function stripBrackets(host: string): string {
	// 首尾成对时才截掉；slice终点-1表示最后一字之前。
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// 用途：解析NO_PROXY单项为主机和可选端口。例example.com:443得端口443，[::1]:80支持IPv6，port=0表示不限制端口；空项返回undefined。
function parseNoProxyEntry(entry: string): { host: string; port: number } | undefined {
	// 去外围空白并统一小写，域名比较不区分大小写。
	const trimmed = entry.trim().toLowerCase();
	// 空分隔项不产生例外规则。
	if (!trimmed) return undefined;

	// 带方括号IPv6可以明确分出地址和后面的端口。
	if (trimmed.startsWith("[")) {
		// 先找IPv6地址结束位置。
		const closingBracket = trimmed.indexOf("]");
		// 确有闭括号才按该结构解析，否则继续通用处理。
		if (closingBracket !== -1) {
			// 去掉括号取完整IPv6地址，内部冒号不能拿来当端口分隔。
			const host = trimmed.slice(1, closingBracket);
			// 闭括号后可能是:端口或空。
			const rest = trimmed.slice(closingBracket + 1);
			// 后缀以冒号开头才尝试数值端口。
			if (rest.startsWith(":")) {
				// 按十进制解析后缀；失败得到NaN。
				const port = Number.parseInt(rest.slice(1), 10);
				// 无效端口按未限制端口处理，不把NaN传入后续比较。
				return { host, port: Number.isNaN(port) ? 0 : port };
			}
			// 只有主机，没有端口限制。
			return { host, port: 0 };
		}
	}

	// 无方括号但有多个冒号，按裸IPv6地址处理，不误把最后一段当端口。
	if (trimmed.includes(":") && trimmed.split(":").length > 2) {
		// 整个条目作为主机；端口0表示任意端口。
		return { host: trimmed, port: 0 };
	}

	// 普通域名/IPv4规则再找最后一个冒号。
	const colonIndex = trimmed.lastIndexOf(":");
	// 只有恰好一个冒号才采用主机:端口格式。
	if (colonIndex !== -1 && colonIndex === trimmed.indexOf(":")) {
		// 冒号前是域名/IPv4部分。
		const host = trimmed.slice(0, colonIndex);
		// 冒号后按十进制读取端口。
		const port = Number.parseInt(trimmed.slice(colonIndex + 1), 10);
		// 可解析数值才保留端口限制。
		if (!Number.isNaN(port)) {
			// 字段简写返回解析后的主机与端口。
			return { host, port };
		}
	}

	// 整个条目作为主机；端口0表示任意端口。
	return { host: trimmed, port: 0 };
}

// 用途：判断目标是否仍应走代理。例NO_PROXY=example.com会排除该域及子域，NO_PROXY=*全部直连；true表示未命中直连例外。
function shouldProxyHostname(hostname: string, port: number, env?: ProviderEnv): boolean {
	// 读NO_PROXY并统一大小写，规则项后面按逗号/空白切开。
	const noProxy = getProxyEnv("no_proxy", env).toLowerCase();
	// 没有例外规则，允许按代理环境选择代理。
	if (!noProxy) {
		// 当前规则不排除目标，应继续考虑代理。
		return true;
	}
	// 整个配置只有星号表示所有目标都绕过代理。
	if (noProxy === "*") {
		// 命中直连例外，不使用代理。
		return false;
	}

	// 目标也统一小写并去IPv6括号，保证两边同一种表示。
	const normalizedTargetHost = stripBrackets(hostname.toLowerCase());

	// 每一条都不排除目标才走代理；every遇到一个false就短路结束。
	return noProxy.split(/[,\s]/).every((entry) => {
		// 把当前域名/端口规则解析为可比较形状。
		const parsed = parseNoProxyEntry(entry);
		// 空项不影响其他例外，也不能单独排除所有目标。
		if (!parsed) {
			// 当前规则不排除目标，应继续考虑代理。
			return true;
		}

		// 规则指定了端口但目标端口不同，本条例外不匹配。
		if (parsed.port && parsed.port !== port) {
			// 当前规则不排除目标，应继续考虑代理。
			return true;
		}

		// 准备规则域名，后面去掉常见通配前缀。
		let domain = stripBrackets(parsed.host);
		// 例如*.example.com先移除星号与点。
		if (domain.startsWith("*.")) {
			// 剩余example.com交给统一根域/子域比较。
			domain = domain.slice(2);
			// 兼容.example.com与*example.com前缀写法。
		} else if (domain.startsWith(".") || domain.startsWith("*")) {
			// 去掉一个前缀字符，留下域名主体。
			domain = domain.slice(1);
		}

		// 处理后为空不构成可用域名规则。
		if (!domain) {
			// 当前规则不排除目标，应继续考虑代理。
			return true;
		}

		// 目标恰好是规则主机，直接命中直连例外。
		if (normalizedTargetHost === domain) {
			// 命中直连例外，不使用代理。
			return false;
		}

		// 以点加规则域结尾才算子域，避免badexample.com误匹配example.com。
		if (normalizedTargetHost.endsWith(`.${domain}`)) {
			// 命中直连例外，不使用代理。
			return false;
		}

		// 当前规则不排除目标，应继续考虑代理。
		return true;
	});
}

// 用途：结合目标协议、默认端口和NO_PROXY选代理字符串。例HTTPS_PROXY=localhost:8080会补https://；不要求代理地址此时已被严格校验。
function getProxyForUrl(targetUrl: string | URL, env?: ProviderEnv): string {
	// 先统一目标为URL结构。
	const parsedUrl = parseProxyTargetUrl(targetUrl);
	// 无法得到协议/主机时无法匹配代理规则。
	if (!parsedUrl?.protocol || !parsedUrl.host) {
		// 目标不适用或命中NO_PROXY时用空字符串表示不走代理。
		return "";
	}

	// URL.protocol带冒号，取前缀例如https；!表达已知有首项。
	const protocol = parsedUrl.protocol.split(":", 1)[0]!;
	// 优先hostname；兜底从host去端口，再去IPv6括号。
	const hostname = stripBrackets(parsedUrl.hostname || parsedUrl.host.replace(/:\d*$/, ""));
	// 显式端口优先，否则按协议默认，再否则0。
	const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PROXY_PORTS[protocol] || 0;
	// NO_PROXY要求直连时，不继续读取代理地址。
	if (!shouldProxyHostname(hostname, port, env)) {
		// 目标不适用或命中NO_PROXY时用空字符串表示不走代理。
		return "";
	}

	// 协议专用代理优先于ALL_PROXY；只选择当前目标相关设置。
	let proxy = getProxyEnv(`${protocol}_proxy`, env) || getProxyEnv("all_proxy", env);
	// 代理值没写协议时，兼容按目标协议补齐的约定。
	if (proxy && !proxy.includes("://")) {
		// 例如https目标配代理host:8080会补成https://host:8080。
		proxy = `${protocol}://${proxy}`;
	}
	// 返回候选字符串，由公开入口继续验证可用代理协议。
	return proxy;
}

// 公开错误文案常量，后面的字符串是真正错误内容，不修改其中措辞。
export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

// 用途：对外得到合法HTTP/HTTPS代理URL或undefined。例SOCKS代理配置明确抛错，不静默误用；这里只选择/验证代理，不保证服务器可连接。
export function resolveHttpProxyUrlForTarget(targetUrl: string | URL, env?: ProviderEnv): URL | undefined {
	// 先完成环境优先级与NO_PROXY匹配。
	const proxy = getProxyForUrl(targetUrl, env);
	// 没有匹配代理时正常直连，不当作错误。
	if (!proxy) {
		// 无可用目标/代理时明确返回缺失。
		return undefined;
	}

	// 声明稍后解析出的URL，类型声明本身不创建对象。
	let proxyUrl: URL;
	// 字符串来自配置或请求目标，可能不是可解析的绝对URL。
	try {
		// 真正按URL语法解析代理配置。
		proxyUrl = new URL(proxy);
		// 代理配置格式错时保留底层原因，并加上有用的配置定位信息。
	} catch (error) {
		// 配置错误直接抛出供网络适配层报告，不拿坏代理继续请求。
		throw new Error(
			// JSON.stringify使异常值边界清晰，原因则兼容非Error抛出值。
			`Invalid proxy URL ${JSON.stringify(proxy)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// 本实现只支持HTTP/HTTPS代理；语法正确的SOCKS/PAC仍不受支持。
	if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
		// 具体说明遇到了哪种不支持的协议。
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
	}

	// 把校验后的URL对象交给真正负责建立代理连接的下层。
	return proxyUrl;
}
