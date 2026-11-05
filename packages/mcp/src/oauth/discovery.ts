// 发现OAuth受保护资源/授权服务器文档，并解析认证挑战及选择resource参数。flow.runFlow调用发现，HTTP认证适配器读挑战；这里可发GET，不注册客户端、不换令牌或打开浏览器。
// “发现成功”表示通过下方局部规则，不代表完整验证授权服务器可信性、scope权限或端点凭证发送策略。
/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove Zod/CORS shims and enforce authorization-server issuer validation.
 */

// 仅导入可注入fetch函数的TS签名，运行时可用宿主fetch或调用方包装器。
import type { McpFetch } from "../auth-provider.ts";
// 元数据GET默认携带本地MCP协议版本，不向服务器动态查询这个常量。
import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
// 发行方不匹配时构造专用异常，便于上层区分失败来源。
import { OAuthIssuerMismatchError } from "./errors.ts";
// 导入元数据形状及实际未知JSON解析函数，带type的名字不会产生运行时代码。
import {
	// 授权服务器元数据的TS接口。
	type AuthorizationServerMetadata,
	// 解析认证头后返回的挑战形状。
	type OAuthChallenge,
	// 受保护资源元数据接口，包含resource/授权服务器列表。
	type OAuthProtectedResourceMetadata,
	// 组合发现的返回值类型。
	type OAuthServerInfo,
	// 局部校验授权服务器文档，主要URL允许HTTP/HTTPS，不在这里校验所有业务能力。
	parseAuthorizationServerMetadata,
	// 局部校验资源文档，保留扩展字段，坏字段可抛普通Error。
	parseProtectedResourceMetadata,
} from "./types.ts";

// 尽力丢弃可选Response正文，输入Response或undefined，无返回值；例：某候选404后取消body再试下一候选。void不等待取消完成，拒绝被吞，不表示服务端任务停止。
function discard(response: Response | undefined): void {
	// 两层?.处理无响应/无body，存在才cancel并catch；没有在这里读取正文或等待取消Promise。
	void response?.body?.cancel().catch(() => {});
}

/** 4xx and 502 mean "not here", so discovery tries the next candidate URL. */
// 判断发现候选是否按本地策略视为缺失，输入HTTP状态，返回boolean；例：401/404/502为true，500/503为false。不发送下一请求，由调用循环决定是否继续。
function isDiscoveryMiss(status: number): boolean {
	// 4xx半开范围与502特例，未检查status必须整数；“miss”是本地回退策略，不意味着这些状态都表示网络没问题。
	return (status >= 400 && status < 500) || status === 502;
}

/** Path suffix for `/.well-known/<kind><path>`; empty for the root path. */
// 去掉路径最后一个斜杠，输入pathname，返回字符串；例："/team/"变"/team"，"/"变空串。只处理一个尾字符，不循环规范所有斜杠/解码路径，无外部副作用。
function pathSuffix(pathname: string): string {
	// endsWith命中才slice掉末位，否则返回原文字；不修改任何URL对象。
	return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

// 从认证头提取指定参数的首个匹配值，输入header/内部固定字段名，返回字符串或undefined；例：scope="read write"得到read write，scope=""当缺省。无网络，不能完整处理多挑战/转义引号或等号两侧任意空白。
// name直接插进正则未转义，不过当前调用点都是固定内部字段名；这里只局部扫描，不把它当通用可信输入解析器。
function field(header: string, name: string): string | undefined {
	// String.raw保留正则里的反斜杠；用开头/逗号/空白作字段边界，双引号捕获组或无空白逗号的裸值，i忽略大小写，match返回首个匹配或null。
	const match = header.match(new RegExp(String.raw`(?:^|[,\s])${name}=(?:"([^"]*)"|([^\s,]+))`, "i"));
	// An empty value (`scope=""`) carries no information, so it counts as absent.
	// ?.取捕获组，再用||让空串继续回退，最终undefined；不是以“键存在”区分显式空值。
	return match?.[1] || match?.[2] || undefined;
}

// 解析WWW-Authenticate的部分OAuth挑战，输入字符串/null，返回新对象；例：Bearer scope="read"得到scope。只接受头首个scheme为bearer/dpop，字段缺省可undefined，不校验所有挑战格式/地址协议或执行登录。
export function parseWwwAuthenticate(header: string | null): OAuthChallenge {
	// 无头/空串返回空对象，不抛认证错误。
	if (!header) return {};
	// 去开头空白后以空白拆首词并转小写，scheme识别只看这个首词，不逐个解析逗号分隔的所有挑战。
	const scheme = header.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
	// 首scheme不属bearer/dpop就忽略整个头，即使后面可能有其他挑战。
	if (scheme !== "bearer" && scheme !== "dpop") return {};
	// 提取资源元数据地址文字，空字段已被field视为缺省。
	const resourceMetadata = field(header, "resource_metadata");
	// 声明可选URL对象，缺省undefined；let供解析成功后赋值。
	let resourceMetadataUrl: URL | undefined;
	// 只有真值地址文字才尝试解析。
	if (resourceMetadata) {
		// 用try捕获不合法地址文字，不让一个坏头字段直接抛出。
		try {
			// new URL无base，通常须绝对可解析地址；此处没有isHttpUrl检查，file:等可解析方案也可成为对象。
			resourceMetadataUrl = new URL(resourceMetadata);
			// 坏地址忽略，resourceMetadataUrl继续undefined；不替换成服务器地址。
		} catch {}
	}
	// 返回固定四个属性的对象，这里没有compact，缺省字段可能以键存在且值undefined的形式返回。
	return {
		// 地址对象复用刚解析结果，不自动请求它。
		resourceMetadataUrl,
		// 原scope字符串，不拆列表/合并旧授权权限。
		scope: field(header, "scope"),
		// 原error字段文字，大小写不在此归一化。
		error: field(header, "error"),
		// 把snake_case的头字段映射到camelCase属性名，文字不脱敏。
		errorDescription: field(header, "error_description"),
	};
}

// 向指定元数据URL请求文档，输入URL/fetch/协议版本/可选signal，返回Response Promise；例：用注入fetch可纯内存模拟。无method字段时宿主fetch默认GET，增加JSON Accept和MCP版本头，不自动读JSON或检查状态。
// fetch可拒绝或忽略signal；本helper不创建超时、不加OAuth凭证，不强制HTTPS或同源，定制包装器自身仍可有额外行为。
async function fetchMetadata(
	// 传入已构造的URL对象，不在这里选择候选路径。
	url: URL,
	// 可注入请求函数，本地变量调用不绑定提供者对象this。
	fetch: McpFetch,
	// 要放进协议头的版本文字，当前函数不判断支持清单。
	protocolVersion: string,
	// signal参数位置必需但值可undefined，直接交请求函数。
	signal: AbortSignal | undefined,
	// async返回Response，不把非2xx自动改为异常，由上层分支处理。
): Promise<Response> {
	// 调用实际fetch并返回其Promise；这里没有额外await后检查正文。
	return fetch(url, {
		// 请求JSON元数据及声明MCP协议版本，未设置Authorization/Content-Type正文。
		headers: { Accept: "application/json", "MCP-Protocol-Version": protocolVersion },
		// 原signal透传，缺省没有本helper自己的时限。
		signal,
	});
}

// 发现受保护资源文档，输入服务器URL与选项，返回经parseProtectedResourceMetadata规范的新对象。先显式URL或带路径well-known，只有无显式URL、服务器非根路径且状态miss才再试根well-known。例：/mcp的404可转根发现。
// HTTP最终失败、JSON/字段错误或fetch失败会拒绝；不在JSON坏文档时继续回退，不验证resource路径是否覆盖服务器（selectResource另做）。这里只发发现GET，不调用授权/令牌端点。
export async function discoverProtectedResourceMetadata(
	// 服务器地址用于拼候选，即使有显式元数据地址也会先new URL解析它。
	serverUrl: string | URL,
	// 选项对象可省略，下面字段各自独立可选。
	options: {
		// 显式元数据地址可为string/URL；有真值配置时不自动改试默认路径。
		resourceMetadataUrl?: string | URL;
		// 可覆盖请求中MCP版本头，缺省本地默认版本。
		protocolVersion?: string;
		// 可注入请求函数，缺省globalThis.fetch。
		fetch?: McpFetch;
		// 可选取消信号，不自动附加超时时限。
		signal?: AbortSignal;
		// 默认新空选项对象，不修改调用方配置。
	} = {},
	// Promise返回规范的资源元数据，不含Response本身。
): Promise<OAuthProtectedResourceMetadata> {
	// 先解析服务器地址，不在这里限制其方案或网络权限。
	const server = new URL(serverUrl);
	// 选择本轮请求函数，函数本身可有自定义网络/模拟行为。
	const fetch = options.fetch ?? globalThis.fetch;
	// 协议版本仅null/undefined才回退，空字符串若被外部JS传入也会原样作为头值。
	const version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
	// 先请求一个候选Response，let允许后续根路径回退替换它。
	let response = await fetchMetadata(
		// 用配置真值选择显式地址分支；空字符串会走默认分支。
		options.resourceMetadataUrl
			? // 显式地址用new URL解析，无base，不在这行验证它与MCP服务器同源或HTTPS。
				new URL(options.resourceMetadataUrl)
			: // 否则在server.origin下拼/.well-known/oauth-protected-resource加去单尾斜杠的pathname，忽略原query/hash，根路径后缀为空。
				new URL(`/.well-known/oauth-protected-resource${pathSuffix(server.pathname)}`, server.origin),
		// 传本轮选择的fetch。
		fetch,
		// 传已选协议版本头文字。
		version,
		// 把取消信号继续向下透传。
		options.signal,
	);
	// 只有上述三项同时成立才根回退；服务器原路径"//"等非精确"/"仍按此条件判断，不按路径语义去重候选。
	if (!options.resourceMetadataUrl && server.pathname !== "/" && isDiscoveryMiss(response.status)) {
		// 尽力取消前一候选正文，不await它释放后才发下一GET。
		discard(response);
		// 用第二次请求Response替换response，最多这个额外根路径尝试。
		response = await fetchMetadata(
			// 候选固定为同origin的根well-known资源元数据路径。
			new URL("/.well-known/oauth-protected-resource", server.origin),
			// 沿用同一个请求函数。
			fetch,
			// 沿用同一个协议版本。
			version,
			// 沿用同一个取消信号，而非重新创建不取消的尝试。
			options.signal,
		);
	}
	// 最终Response非ok时不再解析元数据。
	if (!response.ok) {
		// 尽力取消其body，失败不会成为这条HTTP错误的新原因。
		discard(response);
		// 抛普通Error，说明HTTP状态，没有正文预览或专用OAuth错误码。
		throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
	}
	// 完整读JSON再作结构/HTTP URL校验，JSON解析/字段错误直接拒绝；这行没有继续尝试其他候选的catch。
	return parseProtectedResourceMetadata(await response.json());
}

// 纯函数生成授权服务器发现候选，输入issuer地址，返回带URL和oauth/oidc标签的有序数组；例：https://idp.example/team生成well-known前缀两种加/team以及/team下openid配置。无网络，坏URL可抛错。
export function buildAuthorizationServerDiscoveryUrls(
	// 输入可为文字或URL，查询/片段不会加入下面基于pathname/origin的候选。
	authorizationServerUrl: string | URL,
	// 返回数组成员同时包含url与类型标签；后续发现循环当前只用url，不据type切换不同JSON解析器。
): { url: URL; type: "oauth" | "oidc" }[] {
	// 解析issuer得origin/pathname，URL API可规范主机/路径，但这里不改原输入值供后面issuer比较。
	const issuer = new URL(authorizationServerUrl);
	// 去掉pathname的单个尾斜杠，根路径得到空后缀。
	const path = pathSuffix(issuer.pathname);
	// 创建有序候选数组，先OAuth再OIDC，保留各自标签。
	const urls: { url: URL; type: "oauth" | "oidc" }[] = [
		// 第一个为origin下/.well-known/oauth-authorization-server再接原issuer路径。
		{ url: new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin), type: "oauth" },
		// 第二个为origin下/.well-known/openid-configuration再接原路径。
		{ url: new URL(`/.well-known/openid-configuration${path}`, issuer.origin), type: "oidc" },
	];
	// 非空路径额外尝试路径末尾/.well-known/openid-configuration；根路径不再加这一项，也没对特殊重复路径做通用去重。
	if (path) urls.push({ url: new URL(`${path}/.well-known/openid-configuration`, issuer.origin), type: "oidc" });
	// 返回新数组及URL对象，不写缓存或查询服务器。
	return urls;
}

// 依次GET候选授权服务器元数据，输入issuer与fetch/版本/跳issuer检查/signal选项，返回首个成功解析文档，全部miss返回undefined；例：前项404再试下一项。
// 只有非ok且属于4xx/502才继续，500/网络/JSON/字段/issuer不符等会拒绝而非悄悄跳过。默认比较双方原文字仅各去一个末尾斜杠，不作完整URL等价归一化；不自动注册/交换令牌。
export async function discoverAuthorizationServerMetadata(
	// 预期授权服务器地址，也决定候选路径；字符串原拼写在issuer比较中仍有意义。
	authorizationServerUrl: string | URL,
	// 选项整体缺省{}；skipIssuerValidation是真值时只跳额外发行方比较，不跳元数据结构/URL校验。
	options: { fetch?: McpFetch; protocolVersion?: string; skipIssuerValidation?: boolean; signal?: AbortSignal } = {},
	// 成功元数据或未发现的undefined包在Promise中，HTTP失败并非都返回undefined。
): Promise<AuthorizationServerMetadata | undefined> {
	// 选择可注入fetch或宿主默认函数。
	const fetch = options.fetch ?? globalThis.fetch;
	// 按有序候选逐一遍历，只解构url，忽略oauth/oidc类型标签。
	for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
		// 每次候选发一个元数据GET，串行await，不并发竞速。
		const response = await fetchMetadata(
			// 传当前候选URL。
			url,
			// 传选定请求函数，不把它当已缓存响应。
			fetch,
			// 本次选项缺版本才用默认值，每候选使用同规则。
			options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
			// 继续透传同一signal，没有内部候选超时。
			options.signal,
		);
		// 非ok进入状态分类，成功状态不尝试下一个候选。
		if (!response.ok) {
			// 尽力丢弃失败响应正文，不读取错误JSON。
			discard(response);
			// miss就continue到下一候选，包括401/403等4xx和502，而不是执行令牌恢复。
			if (isDiscoveryMiss(response.status)) continue;
			// 其他非ok抛带候选地址的普通Error，停止发现。
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		// 第一个ok响应必须能完整读JSON并通过授权服务器字段检查；失败不进入下一候选。
		const metadata = parseAuthorizationServerMetadata(await response.json());
		// 未配置真值跳过标记时执行额外issuer比对，缺省会检查。
		if (!options.skipIssuerValidation) {
			// String保留字符串输入原文字，URL对象输入则使用URL序列化；两者可能因规范化不同而比较结果不同。
			const expected = String(authorizationServerUrl);
			// URL parsing adds a trailing slash to bare origins, so compare without one on either side.
			// 局部trim只去整个文字最后一个/，不trim空白、不解码路径、不规范host大小写或默认端口；例："https://idp/"变"https://idp"。它不发请求/不改原值。
			const trim = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);
			// 两侧处理后仍不同就抛专用不匹配错误，保存未trim的原expected/issuer以供诊断。
			if (trim(metadata.issuer) !== trim(expected)) throw new OAuthIssuerMismatchError(expected, metadata.issuer);
		}
		// 返回首个成功文档，后续候选不会访问。
		return metadata;
	}
	// 候选都只遇到允许miss时返回undefined，交上层决定默认端点等流程。
	return undefined;
}

// 组合资源与授权服务器发现，输入MCP服务器/选项，返回OAuthServerInfo。先试资源文档，若有显式授权文档则读它并信任其issuer，否则选资源列表首项或服务器根URL再做授权发现。
// 资源发现阶段仅TypeError重抛，其他错误被忽略后继续（包括普通HTTP/字段/JSON错误及非TypeError取消异常）；后续授权发现错误正常拒绝。显式授权文档仍在资源发现之后执行，不代表完全绕过前面网络；本函数不核验resource路径、scope或执行登录。
export async function discoverOAuthServerInfo(
	// 服务器地址既是资源发现基础，也是没有授权服务器声明时的根URL来源。
	serverUrl: string | URL,
	// 可选组合发现参数，不支持在此直接覆盖协议版本，内部使用本地默认。
	options: {
		// 从挑战获得的可选资源文档地址。
		resourceMetadataUrl?: URL;
		/** Metadata document to use instead of discovery. It is trusted as configured, so its issuer is not checked. */
		// 配置指定授权文档时信任它的issuer，不执行发现地址与issuer匹配；更严格HTTPS/loopback策略由flow对这一配置调用secureEndpoint，不在此函数自动保证。
		authorizationServerMetadataUrl?: URL;
		// 给全部发现请求使用的可注入fetch。
		fetch?: McpFetch;
		// 普通授权服务器发现的跳issuer检查选项，显式文档分支本来就不做该比较。
		skipIssuerValidation?: boolean;
		// 所有本函数发起的发现请求透传此signal，但catch分支仍只按错误类决定是否忽略。
		signal?: AbortSignal;
		// 缺省选项为新空对象。
	} = {},
	// Promise可能返回缺省的resourceMetadata/authorizationServerMetadata字段值，并非必须两文档齐全。
): Promise<OAuthServerInfo> {
	// 先声明可选资源元数据，本轮资源发现若被忽略失败就保持undefined。
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	// 只给资源发现阶段单独设catch，不把授权发现所有错误都吞掉。
	try {
		// 先尝试发现/解析资源文档，即使下面有显式授权文档配置也会先执行。
		resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, {
			// 传挑战指定的资源地址，缺省则用默认well-known候选。
			resourceMetadataUrl: options.resourceMetadataUrl,
			// 沿用注入fetch，缺省由下层选globalThis.fetch。
			fetch: options.fetch,
			// 透传取消信号，不在此覆盖成单独timeout。
			signal: options.signal,
		});
		// 捕获资源发现的失败，按下一条规则区别处理。
	} catch (error) {
		// 仅TypeError立即向上传播；不能反推出它一定是网络错，其他错误值/类型均被这一catch吞掉，AbortError也未单独在这里重抛。
		if (error instanceof TypeError) throw error;
	}
	// 有真值配置的授权文档地址时走直接读取分支，不再用资源文档的authorization_servers选择授权服务器。
	if (options.authorizationServerMetadataUrl) {
		// 保留配置URL对象引用，未用buildAuthorizationServerDiscoveryUrls去推路径。
		const url = options.authorizationServerMetadataUrl;
		// 向配置地址发元数据GET，不等于直接打开浏览器。
		const response = await fetchMetadata(
			// 用原配置URL，不额外比较它与MCP服务器同源。
			url,
			// 注入fetch缺省用宿主函数。
			options.fetch ?? globalThis.fetch,
			// 此分支使用本地默认MCP协议版本头。
			LATEST_PROTOCOL_VERSION,
			// 取消信号继续透传。
			options.signal,
		);
		// 显式文档HTTP失败立即报错，不自动尝试well-known发现替代。
		if (!response.ok) {
			// 尽力取消失败body。
			discard(response);
			// 错误说明包含配置地址和HTTP状态，不解析失败正文。
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		// 仍执行授权服务器字段/HTTP URL形状检查，但不把issuer与配置文档地址作相等检查。
		const metadata = parseAuthorizationServerMetadata(await response.json());
		// 选metadata.issuer作授权服务器URL，返回文档及可能已得的资源文档；没有额外resource匹配检查。
		return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
	}
	// 仅取authorization_servers第0项，空数组/缺省才回退服务器根URL；不依次尝试列表其他服务器，也不把MCP原路径保留作默认issuer。
	const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? String(new URL("/", serverUrl));
	// 组合普通发现分支返回对象，下面await仍可拒绝整个函数。
	return {
		// 返回本轮选出的授权服务器文字。
		authorizationServerUrl,
		// 按选定服务器继续有序候选发现，可能得到undefined文档。
		authorizationServerMetadata: await discoverAuthorizationServerMetadata(authorizationServerUrl, {
			// 沿用同一请求函数配置。
			fetch: options.fetch,
			// 传可选跳issuer比对设置，不影响safeUrl等字段检查。
			skipIssuerValidation: options.skipIssuerValidation,
			// 传同一取消信号，资源阶段吞掉取消不等于后续请求一定成功，遵守该信号的fetch仍可立即拒绝。
			signal: options.signal,
		}),
		// 带回本轮资源文档引用或undefined，不在这里保存到provider。
		resourceMetadata,
	};
}

// 从服务器地址复制一个URL并去片段，输入string/URL，返回新URL；例：https://api.example/mcp?q=1#part变成同地址无#part，查询仍在。不联网、不修改原URL，也不限定HTTP方案，坏地址可抛TypeError。
export function resourceUrlFromServerUrl(value: string | URL): URL {
	// new URL创建新对象并应用宿主URL解析/规范化规则，不仅把文本原样装箱。
	const url = new URL(value);
	// 仅清hash，pathname/search/用户信息等不由此主动删除。
	url.hash = "";
	// 返回可变新URL，类型不自动freeze它。
	return url;
}

// 选择授权请求的resource字符串：无元数据返回undefined；有文档时比较服务器/资源的origin及按斜杠边界的路径前缀，通过返回原metadata.resource，否则抛Error。例：资源https://api.example/api覆盖服务器/api/mcp，但不覆盖/api2。
// 不发请求，不验证token audience或权限；比较忽略query/hash和用户信息差异，路径保持URL编码/大小写规则，不是通用URI信任证明。直接传坏URL也可在构造阶段抛错。
export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
	// 没有文档不自行用serverUrl冒充resource参数，直接省略。
	if (!metadata) return undefined;
	// 解析服务器并去hash，供origin/pathname检查，未改调用方原地址。
	const requested = resourceUrlFromServerUrl(serverUrl);
	// 把文档resource另作URL解析；本函数没有自己调用safeUrl，正常发现路径中的协议限制来自上游解析器。
	const configured = new URL(metadata.resource);
	// origin比较含协议/规范化主机/端口，不比较username/password、查询或片段。
	if (requested.origin !== configured.origin) {
		// 不同origin立即拒绝，错误说明显示原资源及已去hash的服务器URL。
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	// 服务器路径若无尾/就补一个，保证相同路径及其子路径都按目录边界判断。
	const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
	// 资源路径也补尾/，避免/api错误匹配/api2；不把百分号路径主动解码。
	const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
	// 要求服务器路径以资源路径为前缀，方向不是反过来要求resource是服务器子路径。
	if (!requestedPath.startsWith(configuredPath)) {
		// 路径不覆盖就抛同样不匹配说明，不把资源自动改成服务器地址。
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	// 通过后返回原资源文字，可能仍含query/hash，不返回上面拼尾斜杠的比较字符串。
	return metadata.resource;
}
