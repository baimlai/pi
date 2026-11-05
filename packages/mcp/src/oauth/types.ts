// 声明OAuth发现/令牌/客户端注册的数据类型，并把外部未知JSON按本地规则解析为这些形状。discovery.ts/flow.ts调用下方解析器，provider.ts保存结果；本文件不发HTTP或验证令牌签名。
// interface/type仅供TS检查，运行时保证以各解析器实际执行的字段检查/转换为准，不等同完整OAuth schema验证。
/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to use dependency-free structural validation.
 */

// 复用非null非数组对象检查；它也接受类实例等对象，不保证所有属性都是自有普通数据字段。
import { isObject } from "../protocol/jsonrpc.ts";

// 受保护资源公布的元数据，例如MCP地址与它支持的授权服务器；不是access token本身。
export interface OAuthProtectedResourceMetadata {
	// 资源标识URL字符串，解析器只允许可解析的HTTP/HTTPS文本，不在这里核对是否包含当前MCP服务器路径。
	resource: string;
	// 可选授权服务器URL数组；解析器逐项限制HTTP/HTTPS，discoverOAuthServerInfo仅采用第一项而非依次尝试所有服务器。
	authorization_servers?: string[];
	// 可选支持scope字符串列表，空数组或空字符串成员未被此类型排除；不等于用户已获这些权限。
	scopes_supported?: string[];
	// 字符串索引签名允许额外未知字段，解析器会保留其自有可枚举字段，读取未知值仍须另查类型。
	[key: string]: unknown;
}

// 授权服务器的发现文档形状，供授权URL/令牌交换/注册等流程使用；解析器验证下面部分字段，不在此自动执行流程。
export interface AuthorizationServerMetadata {
	// 发行方标识文字；发现流程另对它与预期地址作字符串比较，类型本身不建立信任。
	issuer: string;
	// 用户授权入口，解析器允许HTTP/HTTPS，构造授权跳转时由flow使用。
	authorization_endpoint: string;
	// 兑换/刷新令牌的入口；这里只作URL形状限制，flow.tokenRequest另查发凭证的端点策略。
	token_endpoint: string;
	// 可选动态注册入口；接口存在不保证服务器一定允许注册。
	registration_endpoint?: string;
	// 可选支持的scope名称列表，不验证具体业务scope或是否已授权。
	scopes_supported?: string[];
	// 必需响应类型数组，解析器要求数组存在但空数组也通过；是否包含code由startAuthorization另查。
	response_types_supported: string[];
	// 可选授权方式列表，如authorization_code/refresh_token，类型没有枚举这些字符串。
	grant_types_supported?: string[];
	// 可选令牌端点客户端认证方式列表，flow再按支持值及client_secret选具体策略。
	token_endpoint_auth_methods_supported?: string[];
	// 可选PKCE挑战方法列表，授权流程另要求若声明该表则支持S256。
	code_challenge_methods_supported?: string[];
	// 可选客户端ID元数据文档支持标记；解析器仅保留真正boolean，非法类型被省掉而非报错。
	client_id_metadata_document_supported?: boolean;
	/** Whether authorization responses carry an `iss` parameter (RFC 9207). */
	// 是否声明授权响应带iss参数；flow据它与实际iss决定是否检查发行方，解析器同样只保留boolean。
	authorization_response_iss_parameter_supported?: boolean;
	// 允许其他未知元数据键，不自动按额外字段执行代码或发请求。
	[key: string]: unknown;
}

// 令牌端点结果的标准化形状；解析器只取下面已知字段，其他原字段不保留，不检查JWT签名或有效权限。
export interface OAuthTokens {
	// 必需非空访问令牌文本，空白串仍满足本地非空规则。
	access_token: string;
	// 必需非空令牌类型文字；解析器没把它限制为精确Bearer或区分大小写枚举。
	token_type: string;
	// 可选有效秒数，解析器可Number转换并检查有限，但不要求正数/整数；provider保存时才据它算tokensExpireAt。
	expires_in?: number;
	// 可选scope文本，解析器把null/空串/undefined视为缺省，不在这里拆分权限集合。
	scope?: string;
	// 可选刷新令牌，缺省/空串会被省略；是否沿用旧刷新令牌由flow.refreshAuthorization决定。
	refresh_token?: string;
	// 可选ID令牌，仅当作非空字符串保留，不验证其签名、claim或issuer。
	id_token?: string;
}

// 客户端向动态注册端点提交的元信息；这里的接口不是这些字段的完整运行时校验器，parseClientInformation只专门规范其中少数字段。
export interface OAuthClientMetadata {
	// 重定向地址字符串数组；返回解析器只查元素是字符串，不逐项safeUrl或校验允许的回调URI方案。
	redirect_uris: string[];
	// 可选令牌端点认证方式提示，字符串不限于flow支持的三个方式，选择阶段另作判断。
	token_endpoint_auth_method?: string;
	// 可选授权类型数组，提供者可默认填authorization_code/refresh_token。
	grant_types?: string[];
	// 可选响应类型数组，提供者可默认填code。
	response_types?: string[];
	/**
	 * OpenID Connect client type, `native` or `web`. Dynamic client registration derives it from
	 * `redirect_uris` when absent (MCP SEP-837).
	 */
	// 可选应用类型，接口仍是string而非native|web联合；flow注册缺省时才从redirect_uris推导，并非本类型自动补值。
	application_type?: string;
	// 客户端显示名，供服务器或授权页显示。
	client_name?: string;
	// 客户端网站地址文字；此字段没有在parseClientInformation中逐项验证为HTTP URL。
	client_uri?: string;
	// 客户端logo地址文字，类型不下载图片或检查内容。
	logo_uri?: string;
	// 客户端期望的scope文本，flow可按显式请求/资源元数据再决定使用值。
	scope?: string;
	// 可选联系地址数组，接口不检查邮件格式。
	contacts?: string[];
	// 可选服务条款地址，未在这里做可信域判断。
	tos_uri?: string;
	// 可选隐私政策地址。
	policy_uri?: string;
	// 可选公钥集合文档地址，声明字段不会自动请求此URL。
	jwks_uri?: string;
	// 可直接附公钥集合未知结构，unknown要求使用方另做相应验证。
	jwks?: unknown;
	// 可选软件标识，保持字符串元信息。
	software_id?: string;
	// 可选软件版本文本，不要求特定版本格式。
	software_version?: string;
	// 可选软件声明文字，类型不验证其签名。
	software_statement?: string;
}

// 服务器分配的客户端身份信息，与用户访问令牌不同；也可由宿主预配置而不动态注册。
export interface OAuthClientInformation {
	// 必需客户端ID，解析器要求非空字符串，不限定它一定是URL或普通短名称。
	client_id: string;
	// 可选客户端密钥，null/空串被解析器省略，不代表所有认证方式都不需密钥。
	client_secret?: string;
	// 可选ID签发时间数字；返回解析器仅查typeof number，不额外保证有限、整数或单位正确。
	client_id_issued_at?: number;
	// 可选密钥过期时间数字，运行时解析也不检查范围/有限性或自行使密钥失效。
	client_secret_expires_at?: number;
}

// &交叉类型要求身份信息与客户端元信息同时满足；这是TS组合，不是运行时对象合并函数。
export type OAuthClientInformationFull = OAuthClientInformation & OAuthClientMetadata;
// |联合允许仅身份信息或完整信息；由于Full本身包含身份字段，这不是互斥标签联合，使用方仍需按属性存在性判断。
export type OAuthClientInformationMixed = OAuthClientInformation | OAuthClientInformationFull;

// 可持久化的发现状态，provider可缓存以减少后续发现请求；字段声明不验证缓存来源或自动刷新。
export interface OAuthDiscoveryState {
	// 选定授权服务器的地址字符串。
	authorizationServerUrl: string;
	// 可选已发现授权服务器文档；缺省时flow可能再发发现请求。
	authorizationServerMetadata?: AuthorizationServerMetadata;
	// 可选受保护资源文档，供选择resource与默认scope。
	resourceMetadata?: OAuthProtectedResourceMetadata;
	// 可选资源元数据文档URL的文字快照，不是该文档正文；不保证缓存一定按它重新发现。
	resourceMetadataUrl?: string;
}

// 一次发现组合的返回值，区别于存储状态不含resourceMetadataUrl字段。
export interface OAuthServerInfo {
	// 选出的授权服务器URL文字，即使没有发现文档也可保留。
	authorizationServerUrl: string;
	// 可选授权服务器元数据，所有候选miss时可undefined。
	authorizationServerMetadata?: AuthorizationServerMetadata;
	// 可选受保护资源元数据，资源发现的部分失败可被组合发现流程忽略。
	resourceMetadata?: OAuthProtectedResourceMetadata;
}

// WWW-Authenticate头解析得到的挑战信息，不等于解析/验证完整HTTP认证协议。
export interface OAuthChallenge {
	// 可选资源元数据URL对象；该头解析仅尝试new URL，没有在这里要求HTTP/HTTPS。
	resourceMetadataUrl?: URL;
	// 可选请求scope，解析时空文字视为缺省，不自动与旧权限合并。
	scope?: string;
	// 可选错误码文字，例如insufficient_scope，是否走增权由适配器判断。
	error?: string;
	// 可选错误描述，解析器不脱敏或展示给用户，如何显示由调用者决定。
	errorDescription?: string;
}

// 要求未知值是非null非数组对象，返回原引用供后续字段读取；输入value和错误标签，失败抛Error。例：object({},"metadata")通过，[]失败；不验证子字段或复制，getter可能在后续读取时执行。
function object(value: unknown, name: string): Record<string, unknown> {
	// 复用isObject局部检查，失败消息带name，不按类名推完整schema。
	if (!isObject(value)) throw new Error(`Invalid ${name}`);
	// 直接返回原对象，Record允许按字符串键读unknown，不保证每个键存在/是自有键。
	return value;
}

/** Drops `undefined` values so optional fields are absent rather than present-but-undefined. */
// 清掉对象顶层值为undefined的可枚举字符串字段，返回新普通对象；例：{a:1,b:undefined}变{a:1}。不改输入，也不递归清null/嵌套undefined；entries读取getter仍可抛错。
// 泛型T保留调用者TS视图，as T不证明必需undefined字段仍存在；符号键、不可枚举键和原型也不会由此复制保留。
function compact<T extends object>(value: T): T {
	// entries得到键值数组，filter解构跳过键只查值，fromEntries重新建对象；类型断言不补回被删字段。
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

// 取必需非空字符串，输入未知值和错误标签，合格返回原文字，失败抛Error；例："a"通过、""失败、" "通过。无trim/强制转换/副作用，不保证是有效URL或令牌。
function requiredString(value: unknown, name: string): string {
	// 类型不是string或长度为0就拒绝，||短路避免对普通非字符串继续读取length。
	if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${name}`);
	// 返回同一字符串值，不处理前后空白。
	return value;
}

/** Treats `null` and `""` as absent: servers send them for fields they have no value for, like `scope: ""`. */
// 判断可选值是否按本地约定算缺省，输入unknown，返回布尔并以类型谓词缩小TS类型；例：null/""为true、0/false为false。无修改，不把空数组也视为缺省。
function absent(value: unknown): value is undefined | null | "" {
	// 严格相等比较三个缺省形态，没有隐式转字符串或布尔。
	return value === undefined || value === null || value === "";
}

// 解析可选字符串，输入未知值和字段名，缺省三态返回undefined，其他交requiredString；例：null省略、42抛Error。无输入修改，不把非法数值变文字。
function optionalString(value: unknown, name: string): string | undefined {
	// 先处理undefined/null/空串，不让这些值进入必需字符串报错。
	if (absent(value)) return undefined;
	// 其余值须真正非空字符串，失败直接向外抛。
	return requiredString(value, name);
}

// 解析可选字符串数组，输入unknown/name，缺省null/undefined返回undefined，数组检查后浅复制；例：["read",""]通过，"read"失败，不拆单个scope串。
// 不逐项trim或要求非空，空数组允许；some跳过稀疏空槽而展开会把槽变undefined，直接传非JSON稀疏数组时未必真得到纯string[]，普通JSON数组没有这种空槽。
function optionalStrings(value: unknown, name: string): string[] | undefined {
	// 只把null/undefined当数组缺省，空字符串不在此豁免。
	if (value === undefined || value === null) return undefined;
	// 先须Array，再用some查是否有非字符串已存在元素；任一不合格抛Error，不过滤掉坏元素。
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Invalid ${name}`);
	// 展开复制数组顺序，成员字符串原样保留，不与输入共享数组容器。
	return [...value];
}

/**
 * Accepts only `http:` and `https:` URLs. Servers supply these URLs, and the authorization endpoint is
 * opened with the platform URL handler, so a `file:` or custom protocol URL would launch local programs.
 */
// 解析HTTP/HTTPS地址文字，输入未知值/字段名，成功返回原字符串，失败抛普通Error；例：https://idp.example/token通过，file:或不可解析文字失败。
// 不强制HTTPS、不校验主机信任/同源/权限，也不把返回值规范化为URL.href；可解析时URL会规范化内部比较对象，但返回原文仍可含空白等原拼写。
function safeUrl(value: unknown, name: string): string {
	// 先要求非空字符串，再判断URL，不接受URL对象或自动String其他值。
	const text = requiredString(value, name);
	// URL parsing throws a `TypeError`, which discovery reserves for network failures.
	// 先canParse防new URL因普通非法文字抛TypeError，再查protocol只允许http:/https:；使用普通Error便于发现流程把坏元数据与TypeError分开处理。
	if (!URL.canParse(text) || !isHttpUrl(new URL(text))) throw new Error(`Invalid ${name}`);
	// 返回原text，不删除query/hash/用户信息或重新序列化地址。
	return text;
}

// 只按已解析URL的protocol判断HTTP/HTTPS，输入URL，返回boolean；例：http://localhost也true。不联网、不判断是否HTTPS安全端点/可信域，也不验证凭证发送策略。
export function isHttpUrl(url: URL): boolean {
	// 两个精确protocol值比较，合法URL对象会由URL API规范protocol大小写。
	return url.protocol === "http:" || url.protocol === "https:";
}

// 解析可选地址文字，输入unknown/name，缺省三态返回undefined，否则复用safeUrl；例：""省略、ftp地址抛Error。无网络或地址改写。
function optionalUrl(value: unknown, name: string): string | undefined {
	// 条件运算符只执行一个分支，缺省时不调用URL校验。
	return absent(value) ? undefined : safeUrl(value, name);
}

// 解析受保护资源文档，输入unknown，返回新对象：先查对象，再浅保留额外键、验证resource/授权服务器地址及scope列表，最后去顶层undefined。例：{resource:"https://api.example/mcp"}通过。
// 坏字段抛Error，不发请求、不核对resource是否覆盖当前MCP路径；嵌套扩展值仍共享，任意JS getter异常可传播。
export function parseProtectedResourceMetadata(value: unknown): OAuthProtectedResourceMetadata {
	// 对象骨架验证后取得原引用，没有深克隆。
	const input = object(value, "OAuth protected resource metadata");
	// 组装新对象后compact，再去掉顶层undefined字段。
	return compact({
		// 浅保留原自有可枚举字段，后面显式字段会覆盖同名项；未知字段没有完整schema验证。
		...input,
		// resource必需且只允许可解析HTTP/HTTPS原字符串，未在这里选resource参数。
		resource: safeUrl(input.resource, "OAuth protected resource metadata resource"),
		// 授权服务器列表可缺省，否则复制后逐项map验证；?.使缺省时不调用map。
		authorization_servers: optionalStrings(input.authorization_servers, "authorization_servers")?.map((url) =>
			// 逐个服务器文字也须HTTP/HTTPS，任一失败整份解析抛错，非逐项丢弃。
			safeUrl(url, "authorization server URL"),
		),
		// scope只检查字符串数组，不验证具体权限是否属于服务器实际支持集。
		scopes_supported: optionalStrings(input.scopes_supported, "scopes_supported"),
	});
}

// 解析授权服务器文档，输入unknown，返回新对象并规范所列字段；例：包含issuer/authorization_endpoint/token_endpoint和response_types_supported:[]也可通过形状检查。
// 主要URL只限制HTTP/HTTPS，issuer与预期/端点同源不在这里比较；保留扩展字段。非法列表/必需字段抛Error，两个boolean支持标记的非法值则静默省略，不是完整协议认证。
export function parseAuthorizationServerMetadata(value: unknown): AuthorizationServerMetadata {
	// 先查非null非数组对象，不保证属性读取无getter或继承值。
	const input = object(value, "authorization server metadata");
	// 取响应类型列表，缺省null/undefined得到undefined，空数组仍是数组。
	const responseTypes = optionalStrings(input.response_types_supported, "response_types_supported");
	// 缺列表才报错，[]在JS是真值，所以不会在这里要求包含code；startAuthorization随后另查。
	if (!responseTypes) throw new Error("Invalid response_types_supported");
	// 合并标准化字段后去掉undefined，返回新普通对象。
	return compact({
		// 未知自有可枚举字段一并浅保留，原嵌套扩展对象未深拷贝。
		...input,
		// 发行方是必需HTTP/HTTPS地址文字，返回原文，不在此比对发现目标。
		issuer: safeUrl(input.issuer, "authorization server issuer"),
		// 授权端点也必需，拒绝file:/自定义协议但允许普通http:。
		authorization_endpoint: safeUrl(input.authorization_endpoint, "authorization endpoint"),
		// 令牌端点必需，向它发凭证的HTTPS/loopback策略在flow.secureEndpoint另行检查。
		token_endpoint: safeUrl(input.token_endpoint, "token endpoint"),
		// 注册端点可省，提供时只复用HTTP/HTTPS形状检查。
		registration_endpoint: optionalUrl(input.registration_endpoint, "registration endpoint"),
		// 规范支持scope列表，不进行授权策略判断。
		scopes_supported: optionalStrings(input.scopes_supported, "scopes_supported"),
		// 保留先前检查并复制的响应类型数组。
		response_types_supported: responseTypes,
		// 可选grant类型列表，字符串不限枚举值。
		grant_types_supported: optionalStrings(input.grant_types_supported, "grant_types_supported"),
		// 规范令牌端点认证方法列表，不在这里选方法。
		token_endpoint_auth_methods_supported: optionalStrings(
			// 读取原字段作为未知输入，按可选字符串数组检查。
			input.token_endpoint_auth_methods_supported,
			// 字段名文字仅用来生成失败说明。
			"token_endpoint_auth_methods_supported",
		),
		// 规范PKCE支持方法数组；是否要求S256由授权流程决定。
		code_challenge_methods_supported: optionalStrings(
			// 原方法列表供helper逐项类型检查。
			input.code_challenge_methods_supported,
			// 本字段的报错标签。
			"code_challenge_methods_supported",
		),
		// 以下三行将客户端ID文档支持标记规范为boolean或缺省。
		client_id_metadata_document_supported:
			// 仅typeof等于boolean的值才保留，"true"等字符串不转换。
			typeof input.client_id_metadata_document_supported === "boolean"
				? // 真布尔值直接采用，包括false。
					input.client_id_metadata_document_supported
				: // 其余值返回undefined，稍后compact删除字段，不抛该字段类型错误。
					undefined,
		// 授权响应iss参数支持声明也按同样的布尔策略处理。
		authorization_response_iss_parameter_supported:
			// 检查此字段是否为实际boolean。
			typeof input.authorization_response_iss_parameter_supported === "boolean"
				? // 实际布尔值原样保留。
					input.authorization_response_iss_parameter_supported
				: // 非法/缺省值去掉，不据此合成false字段。
					undefined,
	});
}

// 解析令牌端点返回的未知对象，只选已知字段并清undefined，返回新OAuthTokens；例：expires_in:"3600"转3600，scope:""省略。
// 必需token文字非空，expires仅要求转换后有限，允许负数/小数；不检查Bearer枚举、JWT签名或当前是否过期。Number转换/属性getter可能抛错，不保存令牌或发请求。
export function parseOAuthTokens(value: unknown): OAuthTokens {
	// 先要求对象骨架，数组/null会失败。
	const input = object(value, "OAuth token response");
	// `Number(null)` is 0, which would mark the token as expired at once.
	// 缺省三态不转数字，其他用Number：false可变0、true变1、空白串变0；对象自定义转换/Symbol等还可能抛错。
	const expires = absent(input.expires_in) ? undefined : Number(input.expires_in);
	// 转换结果若存在须有限，NaN/Infinity拒绝；不要求正数、整数或安全整数。
	if (expires !== undefined && !Number.isFinite(expires)) throw new Error("Invalid expires_in");
	// 只用下面选择出的字段建新对象，原其他键不会通过...input保留。
	return compact({
		// 访问令牌须非空字符串，但不验证可用于哪个resource或权限。
		access_token: requiredString(input.access_token, "access_token"),
		// token_type只须非空文字，不强制必须为Bearer。
		token_type: requiredString(input.token_type, "token_type"),
		// 保存秒数，不在此换成时间戳或根据Date.now判断有效。
		expires_in: expires,
		// scope缺省/null/空串会在compact后不存在，其余须非空字符串。
		scope: optionalString(input.scope, "scope"),
		// 可选刷新令牌同样把空串当缺省，不在这里继承旧令牌。
		refresh_token: optionalString(input.refresh_token, "refresh_token"),
		// ID令牌仅保留字符串，不解析JWT。
		id_token: optionalString(input.id_token, "id_token"),
	});
}

// 解析动态客户端注册结果，输入unknown，返回浅保留元信息并规范身份字段的新对象；例：{client_id:"c",client_secret:""}返回client_id及redirect_uris:[]。
// client_id必需，少数可选字段会转换为缺省；未完整验证OAuthClientMetadata，redirect_uris也只查字符串列表，不逐项检查地址。时间字段仅typeof number，NaN/Infinity也能保留，类型名Full不是完整安全认证保证。
export function parseClientInformation(value: unknown): OAuthClientInformationFull {
	// 先查对象，失败抛注册响应标签对应Error。
	const input = object(value, "OAuth client registration response");
	// 构造新对象后去掉顶层undefined，不修改原注册响应。
	return compact({
		// 双重断言只向TS声明可作客户端元信息，再浅展开真实自有可枚举字段；不会验证所有元信息字段或赋默认认证方法。
		...(input as unknown as OAuthClientMetadata),
		// 覆盖client_id为检查后的非空字符串，非法则整份解析抛错。
		client_id: requiredString(input.client_id, "client_id"),
		// 密钥可缺省/null/空串，其余须非空字符串，不加密或保存它。
		client_secret: optionalString(input.client_secret, "client_secret"),
		// 签发时间仅number就保留，不Number转换字符串，也没Number.isFinite检查。
		client_id_issued_at: typeof input.client_id_issued_at === "number" ? input.client_id_issued_at : undefined,
		// 密钥过期时间在下一行作相同的类型筛选。
		client_secret_expires_at:
			// 实际number原样保留，其他形态变undefined并被compact去掉；不检查是否已过期。
			typeof input.client_secret_expires_at === "number" ? input.client_secret_expires_at : undefined,
		// redirect_uris规范为新字符串数组，缺省/null补[]；不把每一条URI送safeUrl校验，也不要求数组非空。
		redirect_uris: optionalStrings(input.redirect_uris, "redirect_uris") ?? [],
	});
}
