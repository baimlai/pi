// 执行MCP OAuth授权：发现服务器、选/注册客户端、换码或刷新令牌，必要时生成带PKCE的授权URL交宿主处理。provider.ts负责状态存储，HTTP适配器在认证挑战后调用这里。
// 本文件可发发现/注册/令牌请求，但不监听回调、不直接开浏览器，也不验证回调state；宿主须完成用户交互/回调校验，再带authorizationCode和iss调用第二阶段。
/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove SDK/Zod dependencies and use WebCrypto for PKCE.
 */

// 只导入认证提供者/可注入fetch/失败响应上下文的类型，TS擦除后不产生这些名字的运行时引用。
import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.ts";
// 复用非null非数组对象检查，识别未知令牌响应中的OAuth error字段，不是完整JSON schema验证。
import { isObject } from "../protocol/jsonrpc.ts";
// 发现与挑战解析的运行时函数；发现可发请求，selectResource只核对文档资源与目标地址。
import {
	// 在已缓存授权服务器URL但缺文档时补做授权服务器发现。
	discoverAuthorizationServerMetadata,
	// 首次组合发现受保护资源及授权服务器。
	discoverOAuthServerInfo,
	// 从HTTP认证头取scope/resource_metadata/error等局部字段。
	parseWwwAuthenticate,
	// 按origin和路径覆盖关系选resource参数，可能拒绝不匹配文档。
	selectResource,
} from "./discovery.ts";
// 不同错误类让上层区分本地策略拒绝、服务器OAuth错误、注册失败和用户交互要求。
import {
	// 流程返回REDIRECT时适配器抛出的交互标记，不会自己开浏览器。
	McpOAuthAuthorizationRequiredError,
	// 带OAuth code的服务器错误，authorizeMcp按部分code重试一次。
	OAuthError,
	// 端点不满足本地安全策略时使用，不等于任意网络错误。
	OAuthInsecureEndpointError,
	// 发现issuer或回调iss比较失败时使用。
	OAuthIssuerMismatchError,
	// 动态注册HTTP非ok时保存状态和完整正文的异常。
	OAuthRegistrationError,
} from "./errors.ts";
// 从同一模块混合导入类型与实际解析函数；逐项type仅参与TS检查，不执行字段验证。
import {
	// 可选服务器文档形状，实际解析在发现模块。
	type AuthorizationServerMetadata,
	// 只允许authorization URL为http:/https:的运行时判断。
	isHttpUrl,
	// 客户端ID/可选secret的身份类型。
	type OAuthClientInformation,
	// 身份与注册元信息的交叉类型，Full不代表完整协议检查。
	type OAuthClientInformationFull,
	// 精简或完整客户端信息的联合类型。
	type OAuthClientInformationMixed,
	// 提交动态注册的客户端元信息类型。
	type OAuthClientMetadata,
	// 可以缓存的发现状态类型。
	type OAuthDiscoveryState,
	// 标准化令牌集合类型，不是JWT验证器。
	type OAuthTokens,
	// 局部解析注册响应，规范少数字段并保留额外元信息。
	parseClientInformation,
	// 解析未知token响应，挑已知字段/规范缺省值。
	parseOAuthTokens,
} from "./types.ts";

// 定制令牌请求客户端认证的函数类型，输入可变headers/params/目标URL/文档，返回void或Promise；例：回调set自定义头。它替代默认认证，自己负责需要的client_id/secret，不是额外再叠一层默认认证。
export type AddClientAuthentication = (
	// Headers实例可被回调原地set，变化进入稍后的fetch。
	headers: Headers,
	// URLSearchParams表单同样可被原地增删参数。
	params: URLSearchParams,
	// 目标地址类型允许字符串或URL，当前tokenRequest传已解析URL对象。
	url: string | URL,
	// 可选服务器元数据供选择自定义认证方案。
	metadata?: AuthorizationServerMetadata,
	// 函数返回同步void或异步Promise<void>，调用处统一await并传播异常。
) => void | Promise<void>;

/** A Client ID Metadata Document: an https URL used as `client_id`, and a redirect URI it lists. */
// 客户端ID元数据文档选择结果；这里只保存两个字符串，flow会局部校验文档URL但不会下载/验证其正文是否列出该回调。
export interface OAuthClientMetadataDocument {
	// 作为client_id的HTTPS文档地址，不是本地凭据文件路径。
	url: string;
	// 文档方案选择的回调地址，可以与provider.redirectUrl不同。
	redirectUrl: string;
}

// 流程与宿主状态/UI之间的契约，可同步或异步实现；interface本身不校验持久状态、加锁或自动打开浏览器。
export interface OAuthClientProvider {
	// 默认回调地址，readonly只限制TS重新赋值，不冻结URL对象。
	readonly redirectUrl: string | URL;
	// 动态注册资料，flow可能从这里取默认scope，不代表已授权权限。
	readonly clientMetadata: OAuthClientMetadata;
	/**
	 * Client ID Metadata Document to identify as instead of registering dynamically, or `undefined` to
	 * register. Called when no client information is stored; the document is not stored. `metadata` is
	 * `undefined` when the authorization server has none; check `client_id_metadata_document_supported`.
	 */
	// 可选同步文档选择回调，只有没有客户端信息时调用；宿主负责能力策略，返回undefined才考虑注册。
	clientMetadataDocument?(metadata: AuthorizationServerMetadata | undefined): OAuthClientMetadataDocument | undefined;
	// 可选state生成/读取函数；这里把它放进URL，收到回调后的比较在宿主，不在此接口自动完成。
	state?(): string | Promise<string>;
	// 读客户端信息，可同步返回可选值或Promise；配置身份/动态存储的优先级由实现决定。
	clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
	// 可选保存客户端的方法；缺客户端且要注册时必须存在，保存失败会使授权流拒绝。
	saveClientInformation?(information: OAuthClientInformationMixed): void | Promise<void>;
	// 读当前令牌集合；flow不会仅凭存在access_token就返回AUTHORIZED，通常仍需refresh_token刷新。
	tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
	// 保存新令牌，流程await完成后才报告AUTHORIZED，持久化保证由实现决定。
	saveTokens(tokens: OAuthTokens): void | Promise<void>;
	// 把生成URL交宿主，可仅记录或打开浏览器；回调拒绝则整个流程拒绝。
	redirectToAuthorization(url: URL): void | Promise<void>;
	// 保存PKCE原始verifier供随后换码，不是保存哈希challenge。
	saveCodeVerifier(verifier: string): void | Promise<void>;
	// 取回verifier，缺值如何报错由实现决定，默认provider会抛Error。
	codeVerifier(): string | Promise<string>;
	// 可选客户端认证定制函数，存在时覆盖默认Basic/post/none处理。
	addClientAuthentication?: AddClientAuthentication;
	// 可选本地凭据失效操作；kind是字符串字面量联合，不自动撤销服务器令牌或清配置secret。
	invalidateCredentials?(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void | Promise<void>;
	// 可选缓存发现结果的写入接口，错误也会影响当前流程。
	saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
	// 可选发现缓存读取接口；返回类型没有TTL/来源验证保证。
	discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
}

// 一次授权步骤的参数：没有码时可刷新或准备跳转，有真值码时尝试换码；两阶段应使用一致的scope/回调配置。
export interface OAuthFlowOptions {
	// 目标MCP资源地址，用来发现并核对resource，不一定就是授权服务器。
	serverUrl: string | URL;
	// 可选授权码，运行时用真值判断；空串不会进入换码分支。
	authorizationCode?: string;
	/** `iss` parameter of the authorization response that delivered `authorizationCode` (RFC 9207). */
	// 回调里的原始iss文字，换码前精确比较；不同于发现阶段去一个尾斜杠的规则。
	iss?: string;
	// 可选请求权限，空字符串会沿||回退资源元数据/客户端默认值。
	scope?: string;
	// 挑战给出的资源元数据位置，已有可用发现缓存时不会因此自动换缓存。
	resourceMetadataUrl?: URL;
	/**
	 * Authorization server metadata document to use instead of discovery, for servers that advertise a
	 * wrong authorization server or none. It is trusted as configured. Must use https, except on loopback.
	 */
	// 显式授权服务器文档位置，进入flow时走secureEndpoint，并绕过发现缓存；文档issuer作为配置被信任，不与文档地址做等价比较。
	authorizationServerMetadataUrl?: URL;
	// 可注入请求函数，缺省全局fetch；注入者可以纯内存响应，也可有真实网络副作用。
	fetch?: McpFetch;
	/** Aborts every request of the flow. Requests have no time limit of their own; combine with a timeout as needed. */
	// signal透传给本流发出的fetch，没有自建时限，也不强制取消provider方法/URL生成；fetch实现是否遵守信号由实现决定。
	signal?: AbortSignal;
	// 仅跳发现时issuer比较，不跳文档字段解析或授权码iss比较，也不重新验证已缓存文档。
	skipIssuerValidation?: boolean;
	/**
	 * Go straight to the authorization redirect instead of refreshing stored tokens, for example when the
	 * server asks for scopes the current grant lacks (a refresh keeps the old scope).
	 */
	// 真值时不读取provider.tokens尝试刷新，直接走准备授权；并不跳过发现/选客户端等前置步骤。
	skipRefresh?: boolean;
}

// 返回值是两个字符串字面量之一：AUTHORIZED表示新令牌保存完成，REDIRECT表示URL已交宿主，不表示用户已完成授权。
export type OAuthFlowResult = "AUTHORIZED" | "REDIRECT";
// 内部只支持Basic头、表单secret或无secret三种方式，类型联合不保证服务器实际接受选中的方式。
type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

// 换码/刷新共用的请求选项；此接口不是网络响应验证器。
export interface TokenRequestOptions {
	// 元数据可缺省，缺时令牌地址从授权服务器根/token推导。
	metadata?: AuthorizationServerMetadata;
	// 本次客户端身份，可能含完整注册信息与认证提示。
	clientInformation: OAuthClientInformationMixed;
	// 可选resource表单参数，真值才加入，不自动从token推断。
	resource?: string;
	// 可选认证覆盖函数，能够修改表单/headers并拒绝。
	addClientAuthentication?: AddClientAuthentication;
	// 请求实现，缺省宿主fetch。
	fetch?: McpFetch;
	// 可选fetch取消信号，不添加内部timeout。
	signal?: AbortSignal;
}

// 判断主机文字是否是本地例外，无副作用返回boolean；例：localhost/127.0.0.1/[::1]通过。只列这几个精确值，不解析DNS、不覆盖全部127网段或localhost子域。
function loopback(hostname: string): boolean {
	// 用===和||逐项比较，不自行lowercase；通常输入来自URL.hostname已按URL规则处理。
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * The OpenID Connect `application_type` for `redirect_uris` (MCP SEP-837). Without one, OpenID Connect servers
 * assume `web`, which rejects http loopback redirect URIs. Loopback hosts and custom schemes are native (RFC 8252).
 */
// 从回调列表推导native/web注册提示，无网络；任一可解析地址为自定义scheme或列出的loopback就native，否则web。例：127.0.0.1回调→native，https应用回调→web；非法URI被忽略而非整体拒绝。
function applicationType(redirectUris: readonly string[]): "native" | "web" {
	// readonly string[]禁止此参数视图下改数组，some遇首个true即停止，不会验证所有元素。
	const native = redirectUris.some((uri) => {
		// canParse失败只让这一项false，流程仍可继续看其他回调。
		if (!URL.canParse(uri)) return false;
		// 构造URL读取规范化protocol/hostname，不修改原文字。
		const url = new URL(uri);
		// 非http/https的可解析scheme全部按native，或HTTP(S)的指定本地主机也native；不证明该URI能安全回调。
		return (url.protocol !== "http:" && url.protocol !== "https:") || loopback(url.hostname);
	});
	// 把是否命中native转换为二选一文字，空数组/全无效列表得到web。
	return native ? "native" : "web";
}

// 解析并检查凭据端点的本地策略，输入string/URL返回新URL，失败抛错；例：http://idp.example/token拒绝，http://localhost/token允许。条件是HTTPS或指定loopback，不是所有端点都统一走此函数，也未强制loopback必须http协议。
function secureEndpoint(value: string | URL): URL {
	// new URL可抛TypeError并规范化主机，返回值是新对象。
	const url = new URL(value);
	// 仅非https且非列出的loopback才抛专用错误；https地址不额外校验可信域/同源。
	if (url.protocol !== "https:" && !loopback(url.hostname)) throw new OAuthInsecureEndpointError(url.href);
	// 返回检查通过的对象，函数自己不发请求。
	return url;
}

// 根据客户端提示、secret及服务器支持表选择认证方法，输入信息/列表返回内部联合，无副作用；例：无提示无支持表且有secret→Basic。最终fallback未保证服务器声明支持，不能把选择结果当协商成功。
function selectClientAuthMethod(information: OAuthClientInformationMixed, supported: string[]): ClientAuthMethod {
	// in包括继承属性，同时让TS收窄联合后读提示；没该键时undefined，不做字段重新解析。
	const hinted = "token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined;
	// 以下三个条件同时满足才采用提示方式。
	if (
		// 提示须为真值，空字符串跳过。
		hinted &&
		// 提示必须精确属于本实现三个名字，不支持其他JWT认证方式。
		["client_secret_basic", "client_secret_post", "none"].includes(hinted) &&
		// 服务器列表为空视作未限制，否则要求包含提示；没有在此确认Basic提示一定有secret。
		(supported.length === 0 || supported.includes(hinted))
	) {
		// 断言只告诉TS已通过上方字符串检查，不转换值或发认证。
		return hinted as ClientAuthMethod;
	}
	// 没有支持表时有真值secret选Basic，否则none；不会读取clientMetadata里另一个对象的默认提示。
	if (supported.length === 0) return information.client_secret ? "client_secret_basic" : "none";
	// 有secret且支持Basic优先选Basic。
	if (information.client_secret && supported.includes("client_secret_basic")) return "client_secret_basic";
	// 否则有secret且支持post就选post。
	if (information.client_secret && supported.includes("client_secret_post")) return "client_secret_post";
	// 支持none时采用它，即使客户端还带secret也不在none中发送secret。
	if (supported.includes("none")) return "none";
	// 全部未命中仍有secret选post、无secret选none，没有抛不支持错误。
	return information.client_secret ? "client_secret_post" : "none";
}

// 原地把选定客户端认证写入headers/params，无返回值；例：none只加client_id，Basic加Authorization头。Basic无secret会抛Error；不发请求，不清除输入中已存在的其他字段。
function applyClientAuthentication(
	// 已选方法字面量，不在此重新协商服务器能力。
	method: ClientAuthMethod,
	// 身份提供client_id与可选secret。
	information: OAuthClientInformation,
	// 可变头对象，Basic分支会覆盖Authorization。
	headers: Headers,
	// 可变表单，非Basic分支写client_id，post可再写secret。
	params: URLSearchParams,
): void {
	// 精确Basic分支，不把任何truthy方式都当作Basic。
	if (method === "client_secret_basic") {
		// 要求secret为真值，空串/undefined失败；Basic提示优先但无secret的错误在此发生。
		if (!information.client_secret) throw new Error("client_secret_basic requires a client secret");
		// set在传入Headers对象上覆盖同名头，不创建副本。
		headers.set(
			// 标准HTTP Authorization头名，Headers按自己的规则处理名称。
			"Authorization",
			// 把原ID、冒号、原secret按UTF-8字节编码为Base64后加Basic前缀；这里没有先对ID/secret作表单百分号编码，也不是加密。
			`Basic ${Buffer.from(`${information.client_id}:${information.client_secret}`).toString("base64")}`,
		);
		// post或none共用表单client_id路径，不写Basic头。
	} else {
		// set覆盖同名client_id，保留其他参数。
		params.set("client_id", information.client_id);
		// 只有post且secret真值才加密钥；none不由此发送secret。
		if (method === "client_secret_post" && information.client_secret)
			// 原地设置client_secret，文字不脱敏/不编码成头，由URLSearchParams后续作表单编码。
			params.set("client_secret", information.client_secret);
	}
}

// 无参数生成PKCE配对Promise：随机32字节→base64url verifier→SHA-256→base64url challenge。例：授权URL只带challenge，换码时提交verifier；不联网/存储，WebCrypto失败可拒绝。
async function pkce(): Promise<{ verifier: string; challenge: string }> {
	// 分配32字节Uint8Array并用密码学随机值填满，getRandomValues返回同一数组。
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	// Buffer从字节创建后转无填充base64url，32随机字节得到43字符verifier。
	const verifier = Buffer.from(bytes).toString("base64url");
	// TextEncoder把verifier文字编码UTF-8，再await SHA-256得到ArrayBuffer；哈希的是verifier字符串，不是原随机bytes。
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	// 返回原verifier及哈希字节编码的challenge，不修改provider或自行打开授权页。
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

// 构造授权URL和PKCE verifier，输入授权服务器/客户端/回调/可选scope等，返回二者Promise；例：scope含offline_access加prompt=consent。校验已声明的code/S256能力及HTTP(S)授权scheme，但不联网、开浏览器、保存verifier或验证state回调。
export async function startAuthorization(
	// 授权服务器作为缺省/authorize地址的base，绝对路径会覆盖其原pathname。
	authorizationServerUrl: string | URL,
	// 内联对象类型描述本函数参数，不是动态schema。
	options: {
		// 可选已发现文档，存在时执行部分能力检查。
		metadata?: AuthorizationServerMetadata;
		// 客户端身份仅用其中client_id放URL，不把secret放授权URL。
		clientInformation: OAuthClientInformationMixed;
		// 回调String化加入参数，不在本函数核对是否已登记。
		redirectUrl: string | URL;
		// 可选scope字符串，真值才set，按空白拆分只为检查offline_access。
		scope?: string;
		// 可选关联state，真值才set；不自动生成或保存。
		state?: string;
		// 可选资源标识，真值才加入URL，不验证token audience。
		resource?: string;
	},
	// 返回对象中的URL可变、codeVerifier是原始随机字符串；Promise拒绝传回校验/WebCrypto错误。
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
	// 取元数据引用便于后面使用，不克隆文档。
	const metadata = options.metadata;
	// 有文档就要求response_types_supported包含精确code，[]也会拒绝；缺文档不作这项能力判断。
	if (metadata && !metadata.response_types_supported.includes("code")) {
		// 不支持授权码则先抛错，不生成PKCE/授权地址。
		throw new Error("Authorization server does not support authorization codes");
	}
	// 只有声明PKCE方法列表才要求包含S256；缺列表允许继续，显式[]不通过。
	if (metadata?.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
		// 已声明不支持S256时报错，没有降级plain。
		throw new Error("Authorization server does not support PKCE S256");
	}
	// 有authorization_endpoint用它，否则取授权服务器根/authorize；new URL建立新对象，保留该端点已有查询/片段等。
	const url = new URL(metadata?.authorization_endpoint ?? new URL("/authorize", authorizationServerUrl));
	// Callers open this URL with the platform URL handler, which also launches files and custom protocols.
	// 实际scheme检查拒绝file:/自定义协议，但允许公网http:，没有调用凭据端点的secureEndpoint。
	if (!isHttpUrl(url)) throw new Error(`Invalid authorization endpoint ${url.href}`);
	// await随机PKCE并用对象解构取两个字段。
	const { verifier, challenge } = await pkce();
	// URLSearchParams.set覆盖已有同名response_type为code。
	url.searchParams.set("response_type", "code");
	// 客户端ID进入授权URL，secret未在这里读取。
	url.searchParams.set("client_id", options.clientInformation.client_id);
	// 发送challenge哈希，不暴露原verifier。
	url.searchParams.set("code_challenge", challenge);
	// 声明challenge计算方法S256。
	url.searchParams.set("code_challenge_method", "S256");
	// 把回调字符串写redirect_uri，URLSearchParams负责查询编码。
	url.searchParams.set("redirect_uri", String(options.redirectUrl));
	// state真值才覆盖该参数；若未提供，不主动删除端点URL中已有的state。
	if (options.state) url.searchParams.set("state", options.state);
	// scope真值才覆盖，空串不会主动清旧端点查询中的scope。
	if (options.scope) url.searchParams.set("scope", options.scope);
	// 可选链让缺scope不调用split，正则按一个或多个空白拆分，包含精确offline_access就覆盖prompt为consent。
	if (options.scope?.split(/\s+/).includes("offline_access")) url.searchParams.set("prompt", "consent");
	// resource真值才set，否则也不主动清除端点原有resource。
	if (options.resource) url.searchParams.set("resource", options.resource);
	// 返回新URL与原verifier；保存和交宿主由runFlow后续负责。
	return { authorizationUrl: url, codeVerifier: verifier };
}

// 共用令牌POST：输入服务器地址、认证/请求选项及可变表单，返回解析令牌Promise。先查端点策略、加客户端认证，再fetch/读完整正文，优先识别OAuth error后查HTTP状态。例：即使HTTP200含error也拒绝；无响应大小/时间上限，fetch/回调/解析可失败。
async function tokenRequest(
	// 缺元数据端点时用授权服务器根/token，不是拼到其原路径后面。
	authorizationServerUrl: string | URL,
	// 共用选项不被整体改写，但定制回调可修改传入headers/params/URL对象。
	options: TokenRequestOptions,
	// 表单对象会被resource和客户端认证原地补字段，调用者不能假定输入不变。
	params: URLSearchParams,
): Promise<OAuthTokens> {
	// 取明确token_endpoint或根/token，再作HTTPS或loopback检查；策略失败发生在发请求前。
	const url = secureEndpoint(options.metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
	// 新建JSON Accept与表单Content-Type头，和JSON注册请求正文不同。
	const headers = new Headers({ Accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
	// 有真值resource才set，覆盖表单同名项；不在此重新匹配资源路径。
	if (options.resource) params.set("resource", options.resource);
	// 有认证覆盖回调就走定制分支。
	if (options.addClientAuthentication) {
		// await允许异步签名/加头；回调失败直接拒绝，没有默认认证后备，回调也能改可变url。
		await options.addClientAuthentication(headers, params, url, options.metadata);
		// 只有没有覆盖函数时才采用内建认证选择。
	} else {
		// 把选择结果、身份、头、表单交原地认证函数。
		applyClientAuthentication(
			// 先确定Basic/post/none，不代表令牌请求已获服务器接受。
			selectClientAuthMethod(
				// 以此次身份资料及其中可选方法提示进行选择。
				options.clientInformation,
				// 文档没给列表就[]，触发选择函数的默认策略。
				options.metadata?.token_endpoint_auth_methods_supported ?? [],
			),
			// 同一身份给apply读取ID/secret，不只给选择器。
			options.clientInformation,
			// 传待发送的Headers引用。
			headers,
			// 传同一个表单，修改进入body。
			params,
		);
	}
	// 实际请求使用注入fetch或全局fetch，await失败直接传播，不在此做重试。
	const response = await (options.fetch ?? globalThis.fetch)(url, {
		// 明确POST令牌端点。
		method: "POST",
		// 属性简写传构建/修改后的头。
		headers,
		// URLSearchParams作为body，由兼容fetch作表单序列化。
		body: params,
		// 透传signal，没有本函数内部timeout或完成后再次检查aborted。
		signal: options.signal,
	});
	// 完整读正文成字符串，没有长度截断或只读错误预览。
	const text = await response.text();
	// unknown要求使用前缩窄；let未赋值时运行时是undefined。
	let value: unknown;
	// try只包JSON.parse，不包fetch/text或之后字段解析。
	try {
		// 把任何合法JSON值存value，不保证一定对象。
		value = JSON.parse(text);
		// JSON语法失败在这里吞掉，value仍undefined，再由状态/parseOAuthTokens决定错误。
	} catch {}
	// Servers may report OAuth errors with any status, so check the body before the status.
	// 先查非null非数组对象且error字段为字符串，包括空字符串；原型属性也可被读取，不以response.ok为前提。
	if (isObject(value) && typeof value.error === "string") {
		// 构造并抛OAuthError以便上层按code分支。
		throw new OAuthError(
			// 服务端error原字符串作为code，不限固定枚举。
			value.error,
			// description实际是字符串才采用，否则code；OAuthError内部还会让空description回退code。
			typeof value.error_description === "string" ? value.error_description : value.error,
			// error_uri仅保留字符串，不在这里解析/访问其URL。
			typeof value.error_uri === "string" ? value.error_uri : undefined,
		);
	}
	// 没有OAuth error且HTTP非ok才用server_error，message包含完整text；即使响应JSON无效仍带原文。
	if (!response.ok) throw new OAuthError("server_error", `HTTP ${response.status}: ${text}`);
	// HTTP成功才解析令牌局部字段；无效JSON得到undefined因此抛字段错误，不凭2xx认定授权完成。
	return parseOAuthTokens(value);
}

// 动态注册客户端，输入服务器/文档/元信息/可选scope与fetch/signal，返回解析注册信息Promise；例：loopback回调自动推native。无文档默认根/register，有文档却无registration_endpoint直接拒绝；这里只解析/返回，不保存注册结果，也没有secureEndpoint检查注册地址。
export async function registerClient(
	// 授权服务器用于缺省注册base。
	authorizationServerUrl: string | URL,
	// 内联选项对象类型，字段值仍由实际调用方传入。
	options: {
		// 可选元数据决定是否必须有注册端点。
		metadata?: AuthorizationServerMetadata;
		// 元信息至少在TS视图里含redirect_uris，不运行时逐条验证回调URL。
		clientMetadata: OAuthClientMetadata;
		// 可选真值scope覆盖提交元信息里的scope，空串不覆盖。
		scope?: string;
		// 可注入纯内存或真实请求函数。
		fetch?: McpFetch;
		// signal仅传给fetch，不设置内部时限。
		signal?: AbortSignal;
	},
	// Full返回类型来自parseClientInformation的局部转换，不代表所有OAuth元信息都检查完整。
): Promise<OAuthClientInformationFull> {
	// 可选链取注册端点，未配置得undefined。
	const endpoint = options.metadata?.registration_endpoint;
	// 文档存在但端点为缺省/空串就拒绝；没有文档才能走默认/register。
	if (options.metadata && !endpoint)
		// 抛普通Error，不是OAuthRegistrationError，因为尚无HTTP响应。
		throw new Error("Authorization server does not support dynamic client registration");
	// 调用本轮fetch并等待Response，没有通用认证重试。
	const response = await (options.fetch ?? globalThis.fetch)(
		// 选元数据地址或授权服务器根/register再new URL，不在本行限制HTTPS/loopback；正常文档解析仅保证HTTP(S)。
		new URL(endpoint ?? new URL("/register", authorizationServerUrl)),
		// 后面对象是fetch的RequestInit。
		{
			// 用POST注册，不是GET发现。
			method: "POST",
			// 声明接受JSON并发送JSON正文，不加用户token或默认客户端认证。
			headers: { Accept: "application/json", "content-type": "application/json" },
			// 把下方浅合并对象序列化，循环引用/自定义toJSON等可能导致异常；不修改原元信息。
			body: JSON.stringify({
				// 先展开元信息自有可枚举字段，后写application_type/scope可覆盖同名字段。
				...options.clientMetadata,
				// 下一行决定应用类型默认，不由类型声明自动产生。
				application_type:
					// 显式application_type非null/undefined就保留，含空串也保留；否则按回调列表推导native/web。
					options.clientMetadata.application_type ?? applicationType(options.clientMetadata.redirect_uris),
				// 条件展开只在scope真值时加入覆盖项；否则保留原元信息可能已有的scope。
				...(options.scope ? { scope: options.scope } : {}),
			}),
			// 透传可选取消信号。
			signal: options.signal,
		},
	);
	// HTTP非ok时完整读正文并抛专用注册错误，不先检查OAuth error JSON，不截断内容。
	if (!response.ok) throw new OAuthRegistrationError(response.status, await response.text());
	// 成功才读JSON并局部解析注册信息，坏JSON/字段直接拒绝，不在这里保存client。
	return parseClientInformation(await response.json());
}

// 用授权码和PKCE verifier换令牌，输入服务器/共用选项及code、verifier、回调，返回tokenRequest的Promise。例：code:c/verifier:v进authorization_code表单；不核对回调state/iss，这些由宿主及runFlow上层负责。
export async function exchangeAuthorizationCode(
	// 服务器URL是缺省token端点base。
	authorizationServerUrl: string | URL,
	// &交叉类型要求同时满足共用选项和这三个必需字段，不是运行时把对象合并。
	options: TokenRequestOptions & { code: string; codeVerifier: string; redirectUrl: string | URL },
): Promise<OAuthTokens> {
	// 直接返回共用异步请求；async会采纳其兑现/拒绝，不增加重试或保存动作。
	return tokenRequest(
		// 传服务器给tokenRequest选择端点。
		authorizationServerUrl,
		// 选项原引用继续传入，含认证/fetch/signal。
		options,
		// 新建表单对象，字段值由URLSearchParams编码，不是JSON字符串。
		new URLSearchParams({
			// 固定授权码grant，不使用refresh_token。
			grant_type: "authorization_code",
			// 提交调用方给的code，不在本函数检查真值/一次性状态。
			code: options.code,
			// 提交原始verifier，与授权页接到的SHA-256 challenge配对。
			code_verifier: options.codeVerifier,
			// 回调转字符串，须由调用方确保与授权阶段一致，本函数不查注册回调列表。
			redirect_uri: String(options.redirectUrl),
		}),
	);
}

// 以旧refresh token换新令牌，输入服务器与共用选项/refreshToken，返回令牌Promise；例：服务器未给新refresh_token时沿用旧值。请求/解析异常直接拒绝，不自行保存或降级跳转（runFlow上层负责）。
export async function refreshAuthorization(
	// 授权服务器供默认令牌路径使用。
	authorizationServerUrl: string | URL,
	// 交叉类型额外要求refreshToken字符串，未在此判断是否为空或过期。
	options: TokenRequestOptions & { refreshToken: string },
): Promise<OAuthTokens> {
	// 等待共用token请求，其端点/认证/状态和JSON处理规则与换码相同。
	const tokens = await tokenRequest(
		// 传本次授权服务器base。
		authorizationServerUrl,
		// 沿用请求选项中的注入fetch等。
		options,
		// 表单只先含refresh_token grant和旧token，resource/客户端认证稍后由tokenRequest加入。
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken }),
	);
	// 先放旧refresh_token再展开响应，服务器实际给的新值优先；parseOAuthTokens省略空/缺值时旧值保留，新顶层对象不修改tokens。
	return { refresh_token: options.refreshToken, ...tokens };
}

// 补记录缺省scope，输入令牌与备选文字，返回原对象或浅副本；例：响应没scope、请求read时补read。有已有scope（包括直接调用传的空串）不覆盖，不检验真实授权权限，也不存储。
function withScope(tokens: OAuthTokens, scope: string | undefined): OAuthTokens {
	// 仅tokens.scope严格undefined且备选scope真值才复制补字段，否则返回原引用。
	return tokens.scope === undefined && scope ? { ...tokens, scope } : tokens;
}

/**
 * Scopes for a step-up authorization: the challenged scopes plus the ones granted so far, since a
 * challenge may list only the missing scopes and a token with just those would lose access the old
 * one had (SEP-2350). Without challenged scopes, `undefined` lets the flow pick its default.
 */
// 增权时合并已授予与挑战scope，输入可选两串返回去重文字/undefined，无副作用；例：repo read加repo admin得repo read admin。没有真值挑战就undefined让flow选默认，不是只返回旧scope。
export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
	// 空/缺挑战提前返回undefined，旧权限即使存在也不在这条路径返回。
	if (!challenged) return undefined;
	// flatMap逐串可选split空白、filter(Boolean)去空项，缺省用[]；先旧后新，空白挑战真值但可得到空串结果。
	const scopes = [granted, challenged].flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []);
	// Set按字符串精确值去重并保留插入顺序，展开成数组后用单空格连接，权限名大小写不归一化。
	return [...new Set(scopes)].join(" ");
}

// 单次授权主流程：发现/缓存→选资源与scope→取/注册客户端→有code换码，否则试refresh→准备URL。输入提供者/选项返回AUTHORIZED或REDIRECT Promise；例：已存refresh token可直接换新token，无refresh才通知宿主登录。发现/存储/回调均可有副作用且失败不回滚；本函数不在成功access_token存在时直接跳过刷新。
async function runFlow(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	// 显式文档URL先过安全策略；&&缺配置时结果undefined，配置无效会在读缓存/联网前拒绝。
	const metadataUrl = options.authorizationServerMetadataUrl && secureEndpoint(options.authorizationServerMetadataUrl);
	// With a configured metadata URL, discovery is not cached, so changing the URL applies at once.
	// 显式文档分支完全不读发现缓存；否则可选调用并await，缺方法得到undefined。
	const cached = metadataUrl ? undefined : await provider.discoveryState?.();
	// 缓存中authorizationServerUrl须真值才采用缓存分支；不是检查cache年龄或resourceMetadataUrl是否匹配新选项。
	const discovered = cached?.authorizationServerUrl
		? // 缓存分支构造本次发现对象，不重新请求受保护资源文档。
			{
				// 复用缓存选定的授权服务器文字，不自行重新比较可信域。
				authorizationServerUrl: cached.authorizationServerUrl,
				// 授权元数据按下一行缓存优先。
				authorizationServerMetadata:
					// ??仅缓存文档null/undefined时才补发现；存在对象不重新解析/检查issuer。
					cached.authorizationServerMetadata ??
					// 只有缺缓存文档时，对该缓存服务器补做候选发现并await。
					(await discoverAuthorizationServerMetadata(cached.authorizationServerUrl, {
						// 继续使用注入请求函数。
						fetch: options.fetch,
						// 只对这次补发现透传跳issuer标记。
						skipIssuerValidation: options.skipIssuerValidation,
						// 补发现也透传取消信号。
						signal: options.signal,
					})),
				// 资源元数据照用缓存引用，selectResource稍后仍检查目标覆盖。
				resourceMetadata: cached.resourceMetadata,
			}
		: // 没有可用缓存URL才组合发现，可能依次请求资源与授权文档。
			await discoverOAuthServerInfo(options.serverUrl, {
				// 挑战/配置的资源文档URL仅进入新发现分支。
				resourceMetadataUrl: options.resourceMetadataUrl,
				// 显式授权文档地址已经由secureEndpoint得到URL；组合发现依然会先试资源文档。
				authorizationServerMetadataUrl: metadataUrl,
				// 透传本流fetch，不由provider选择网络实现。
				fetch: options.fetch,
				// 透传发现阶段的issuer跳过标记。
				skipIssuerValidation: options.skipIssuerValidation,
				// 透传本流signal，不创建独立时限。
				signal: options.signal,
			});
	// 只有没显式授权文档才写发现缓存，即使本次数据来自旧缓存也会走这里。
	if (!metadataUrl) {
		// 可选保存方法不存在就await undefined，不要求所有提供者持久缓存。
		await provider.saveDiscoveryState?.({
			// 浅展开本次发现结果，嵌套文档引用仍可共享。
			...discovered,
			// 若选项有resourceMetadataUrl则附href快照；不会仅因这个快照与缓存不符就刷新旧资源文档。
			...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl.href } : {}),
		});
	}
	// 取出可选授权文档，后续缺文档时部分端点用默认路径。
	const metadata = discovered.authorizationServerMetadata;
	// 验证资源文档origin/路径覆盖目标，通过返回原resource字符串；不匹配会在客户端注册/换码前失败，但前面的缓存保存可能已发生。
	const resource = selectResource(options.serverUrl, discovered.resourceMetadata);
	// `||`, not `??`: an empty scope (for example from `scopes_supported: []`) falls through to the next source.
	// 按下面三个来源选择scope，不做权限集合合并。
	const scope =
		// 真值显式scope优先，再资源scopes_supported以空格连接，再客户端默认；||使空串继续回退，空白串仍真值。
		options.scope || discovered.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope;
	// await客户端信息，提供者可优先返回配置身份，读取失败终止。
	const stored = await provider.clientInformation();
	// 已有真值客户端信息就不调用文档选择函数；否则同步询问宿主，可能抛错。
	const clientDocument = stored ? undefined : provider.clientMetadataDocument?.(metadata);
	// 文档选择有结果才做以下局部URL检查。
	if (clientDocument) {
		// new URL解析文档ID，错误可抛TypeError，不下载该文档。
		const url = new URL(clientDocument.url);
		// 只允许HTTPS且pathname不是精确根/；没检查文档内容、查询片段、回调登记，也没在此自动核对metadata能力标记。
		if (url.protocol !== "https:" || url.pathname === "/") throw new Error("Invalid OAuth client metadata URL");
	}
	// 优先用stored，缺省时用文档URL组成只有client_id的临时身份；文档方案不调用saveClientInformation。
	let client = stored ?? (clientDocument && { client_id: clientDocument.url });
	// 仍无客户端才考虑动态注册。
	if (!client) {
		// 带真值授权码却无客户端直接报错，不临时注册新身份去交换旧码。
		if (options.authorizationCode) throw new Error("OAuth client information is missing during code exchange");
		// 没有保存方法就拒绝注册，避免流程拿到无法保留的动态身份。
		if (!provider.saveClientInformation) throw new Error("OAuth client information cannot be persisted");
		// 对发现授权服务器动态注册，可有网络副作用；方法拒绝则后续不执行。
		client = await registerClient(discovered.authorizationServerUrl, {
			// 传发现文档决定注册端点。
			metadata,
			// 提交提供者的客户端元信息，不提交存储tokens。
			clientMetadata: provider.clientMetadata,
			// 真值scope可覆盖注册元信息scope。
			scope,
			// 注册使用本流同一fetch。
			fetch: options.fetch,
			// 注册透传同一signal。
			signal: options.signal,
		});
		// 注册成功后先await保存，保存失败不撤销远端已注册客户端。
		await provider.saveClientInformation(client);
	}
	// The document's redirect URI may differ from the provider's, for example by a server-specific path.
	// 文档可覆盖本轮redirectUrl，否则用provider默认；动态注册不从响应redirect_uris自动另选一个回调。
	const redirectUrl = clientDocument?.redirectUrl ?? provider.redirectUrl;
	// 构造后面换码/刷新复用的选项对象，TS注解仅检查字段形状。
	const tokenOptions: TokenRequestOptions = {
		// 共享发现的可选文档引用。
		metadata,
		// 传已选客户端身份，客户端secret不进入授权URL，只可能进入令牌认证。
		clientInformation: client,
		// 传经过selectResource得到的resource或undefined。
		resource,
		// 复制自定义认证函数引用；tokenRequest稍后以选项属性调用该函数，不能假设保留provider作为this。
		addClientAuthentication: provider.addClientAuthentication,
		// 继续透传fetch。
		fetch: options.fetch,
		// 继续透传signal。
		signal: options.signal,
	};
	// 真值authorizationCode优先进入换码，不尝试刷新或生成新授权URL。
	if (options.authorizationCode) {
		// RFC 9207: never send a code from another authorization server to this one. Without metadata there
		// is no issuer to compare with, so any `iss` is rejected.
		// 取回调iss，未提供为undefined；这里不从serverUrl推断iss。
		const iss = options.iss;
		// 有实际iss或文档声明必须给iss时才比较，普通缺省且未声明可跳过。
		if (iss !== undefined || metadata?.authorization_response_iss_parameter_supported) {
			// 精确!==比较，不去尾斜杠、不URL规范化；有iss但无文档issuer也会拒绝，skipIssuerValidation不跳这一检查。
			if (iss !== metadata?.issuer) throw new OAuthIssuerMismatchError(metadata?.issuer, iss);
		}
		// 发行方检查通过才发换码请求。
		const tokens = await exchangeAuthorizationCode(discovered.authorizationServerUrl, {
			// 浅复制共用选项，之后额外字段补换码参数。
			...tokenOptions,
			// 使用本轮授权码，不自行读取回调/验证state。
			code: options.authorizationCode,
			// 先await提供者verifier，缺值默认实现会拒绝，阻止后续token fetch。
			codeVerifier: await provider.codeVerifier(),
			// 使用本轮文档选择或默认回调，宿主需两阶段配置一致。
			redirectUrl,
		});
		// A response without `scope` grants the requested scope (RFC 6749 §5.1). Recorded so a step-up can
		// keep it. Callers pass the options of the authorization request, so `scope` is what was requested.
		// 响应缺scope时补本轮所选scope后await保存；保存失败不会自动回滚服务器已兑换的code。
		await provider.saveTokens(withScope(tokens, scope));
		// 仅保存成功才报告AUTHORIZED，不表示通过JWT或权限实测。
		return "AUTHORIZED";
	}
	// skipRefresh真值直接undefined并短路不读tokens；否则await读取，未按expiresAt判断是否需要刷新。
	const existing = options.skipRefresh ? undefined : await provider.tokens();
	// 只有refresh_token真值才发刷新，即使已有access token仍可走刷新，没refresh就准备授权。
	if (existing?.refresh_token) {
		// 此try同时包刷新请求和后面的saveTokens，存储失败也会进同一个catch分类。
		try {
			// 尝试以旧刷新令牌换新token，可有轮换副作用。
			const tokens = await refreshAuthorization(discovered.authorizationServerUrl, {
				// 共享已选端点/认证/资源/fetch/signal。
				...tokenOptions,
				// 用读取到的旧refresh_token，是否跨进程互斥不是本函数负责。
				refreshToken: existing.refresh_token,
			});
			// A refresh without `scope` keeps the scope of the grant (RFC 6749 §6).
			// 响应没scope就沿用旧grant的scope，然后保存；这里不以新请求scope强行扩权限。
			await provider.saveTokens(withScope(tokens, existing.scope));
			// 保存成功返回AUTHORIZED，不再生成授权URL。
			return "AUTHORIZED";
			// 捕获请求、解析或保存期间抛出的值，按下面类型/信号决定传播或降级。
		} catch (error) {
			// signal此刻已aborted或是本地不安全端点错误就重抛，不降级登录；不是把所有异常都改成AbortError。
			if (options.signal?.aborted || error instanceof OAuthInsecureEndpointError) throw error;
			// OAuthError除server_error外都重抛供authorizeMcp处理；server_error及其他非上述错误被吞后准备重新授权，含某些解析/存储异常。
			if (error instanceof OAuthError && error.code !== "server_error") throw error;
		}
	}
	// 只有到达授权跳转阶段才await可选state方法，缺方法state为undefined；本步骤不核对回调state。
	const state = await provider.state?.();
	// 生成URL与PKCE，不在这个函数调用时监听/等待浏览器回调。
	const authorization = await startAuthorization(discovered.authorizationServerUrl, {
		// 发现文档用于授权端点及能力检查。
		metadata,
		// 传已选客户端ID，secret不会由startAuthorization放进查询。
		clientInformation: client,
		// 回调可被文档方案改写。
		redirectUrl,
		// 传这一步决定的scope。
		scope,
		// 传宿主生成/保存的关联state或undefined。
		state,
		// 传匹配目标的资源标识。
		resource,
	});
	// 先保存verifier再通知宿主，确保后续换码可读取；保存失败不发重定向回调。
	await provider.saveCodeVerifier(authorization.codeVerifier);
	// await宿主处理URL，可能只是记录，可能有UI/浏览器副作用，也可拒绝；URL交付失败不自动清已存verifier。
	await provider.redirectToAuthorization(authorization.authorizationUrl);
	// 回调成功才返回REDIRECT，表示需要用户授权/后续换码，不代表登录已完成。
	return "REDIRECT";
}

// 公开单步骤入口，输入提供者/选项返回授权结果Promise。首次失败若invalid_client/unauthorized_client清all、invalid_grant清tokens，再最多重跑一次；例：刷新grant无效后可要求重新授权。其他异常原样传播，不通用重试网络、不自动回滚已写状态。
export async function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	// try只覆盖这第一次await runFlow及其失败，不递归调用authorizeMcp。
	try {
		// await让第一次异步拒绝进入本catch。
		return await runFlow(provider, options);
		// 首次错误才在这里分类，任意抛出的值不一定是Error。
	} catch (error) {
		// 只识别本地OAuthError实例且code精确匹配客户端问题，不仅根据message文字。
		if (error instanceof OAuthError && ["invalid_client", "unauthorized_client"].includes(error.code)) {
			// 若有失效方法则await清all，方法缺省不清；清理失败会替换原异常并阻止重跑。
			await provider.invalidateCredentials?.("all");
			// 直接返回第二次runFlow Promise，未在本catch内部再次await/捕获它的拒绝，所以不是无限重试。
			return runFlow(provider, options);
		}
		// invalid_grant精确匹配走仅清tokens路径，不清动态客户端/verifier/state（具体仍由提供者实现）。
		if (error instanceof OAuthError && error.code === "invalid_grant") {
			// 可选失效方法清本地tokens后等待完成，不发送撤销请求。
			await provider.invalidateCredentials?.("tokens");
			// 第二次同样使用原options，包括可能仍带原code；结果/失败直接交调用者，不保证一定转REDIRECT。
			return runFlow(provider, options);
		}
		// 其余错误保留原引用重抛。
		throw error;
	}
}

/**
 * Auth provider for `StreamableHttpTransport`. After a 401 it refreshes the tokens, or throws
 * `McpOAuthAuthorizationRequiredError` when the user has to authorize (again). Concurrent 401s share
 * one refresh, and a request whose token was already replaced is just retried: with rotating refresh
 * tokens, a second refresh with the old refresh token would fail and discard the new grant.
 */
// 把OAuthClientProvider适配为HTTP AuthProvider，输入提供者返回闭包对象，构造时不读令牌/联网。例：两个401共享本返回对象中的一次恢复，迟到旧token失败可用现有新token重试；不同适配器不共锁，首个恢复上下文决定本轮参数，不保证跨进程互斥。
export function adaptOAuthProvider(provider: OAuthClientProvider): AuthProvider {
	// 闭包中的可选共享Promise，undefined表示当前未记录恢复；不是提供者永久状态或线程锁。
	let inFlight: Promise<void> | undefined;
	// 返回对象方法给HTTP传输使用，不立刻执行这些async函数。
	return {
		// 每次token调用await提供者读取并取access_token，不检查expires_in/tokensExpireAt、不等待inFlight或主动预刷新；读取错误会拒绝。
		token: async () => (await provider.tokens())?.access_token,
		// 接收HTTP失败上下文的async回调，成功时void，恢复/用户交互要求等可使其拒绝。
		onUnauthorized: async (context: UnauthorizedContext) => {
			// 读WWW-Authenticate头并局部解析挑战，没有在此消费响应正文。
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			// 精确识别insufficient_scope，其他error/大小写变体不视为增权。
			const insufficientScope = challenge.error === "insufficient_scope";
			// 普通挑战、当前没记录恢复且原请求有token快照时才查是否已被其他操作替换；增权不走这个快捷返回。
			if (!insufficientScope && !inFlight && context.token !== undefined) {
				// await可能让其他恢复在此期间开始，后面??=仍会复用当时已有inFlight。
				const current = (await provider.tokens())?.access_token;
				// 只有当前token已定义且不同于旧快照才直接成功，不检查新token真值/有效性；当前已删除为undefined不会快捷成功。
				if (current !== undefined && current !== context.token) return;
			}
			// ??=仅当前无Promise才建链，后到调用复用它；增权先调用tokens再Promise.resolve收其同步值/Promise，普通恢复用undefined。不提供跨适配器或跨进程锁，同步tokens抛错可在建链前使本次调用拒绝。
			inFlight ??= Promise.resolve(insufficientScope ? provider.tokens() : undefined)
				// then在前一步兑现后收到grant，读取失败会跳过授权并进入finally。
				.then((granted) =>
					// 启动通用授权，后续调用不会把自己的新挑战/地址替换进这条已建的链。
					authorizeMcp(provider, {
						// 用首个恢复上下文的MCP目标地址。
						serverUrl: context.serverUrl,
						// 传首个挑战中的资源文档位置，若provider有缓存仍按runFlow缓存规则处理。
						resourceMetadataUrl: challenge.resourceMetadataUrl,
						// 增权时合并旧grant和挑战scope，普通挑战直接用scope；合并缺挑战会返回undefined让默认值生效。
						scope: insufficientScope ? stepUpScope(granted?.scope, challenge.scope) : challenge.scope,
						// 透传HTTP传输的fetch，不在此选另一个网络客户端。
						fetch: context.fetch,
						// 增权跳过刷新，避免误以为刷新旧grant能授予新scope；也不会先删除旧令牌。
						skipRefresh: insufficientScope,
					}),
				)
				// 授权步骤结果只可能为AUTHORIZED或REDIRECT，前者让此链兑现void。
				.then((result) => {
					// 已把授权URL交宿主仍需要交互时抛专用错误，供连接/UI处理，不在此等待用户回调。
					if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
				})
				// 无论成功或失败都执行清理；finally不吞原拒绝，供所有等待者看同一结果。
				.finally(() => {
					// 清当前闭包标记让后续失败可再次恢复，不删除provider令牌/发现/客户端状态。
					inFlight = undefined;
				});
			// await共享Promise让本HTTP恢复回调等到保存/交互失败，调用者随后决定是否重试HTTP请求。
			await inFlight;
		},
	};
}
