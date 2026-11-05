// OAuth子入口集中重导出回调、发现、流程、存储和类型。例：从@earendil-works/pi-mcp/oauth导入authorizeMcp，不必依赖内部文件路径。export...from不是调用函数，监听/网络要等相应API实际执行。
// 同一组里带type的名字只供TS使用，运行时值导出仍让模块加载；这里没有包装函数改变底层错误/保存/安全策略。
export {
	// 成功回调code/state/可选iss的数据类型，不能作为运行时构造器使用。
	type OAuthCallback,
	// 成功/失败页面的ok标签联合类型。
	type OAuthCallbackPage,
	// HTTP回调服务类，显式listen才绑定端口，不自动打开浏览器。
	OAuthCallbackServer,
	// 监听主机/路径/时限和渲染器的选项类型。
	type OAuthCallbackServerOptions,
} from "./callback.ts";
// 重导出发现与挑战/资源选择函数，具体是否联网取决于被调用函数。
export {
	// 只生成有序授权服务器发现URL候选，不发网络。
	buildAuthorizationServerDiscoveryUrls,
	// 依候选GET授权服务器文档并按本地规则校验issuer，可能返回undefined或拒绝。
	discoverAuthorizationServerMetadata,
	// 先发现资源，再按配置/资源列表首项/根地址选授权服务器；不是完整信任认证。
	discoverOAuthServerInfo,
	// 发现受保护资源文档，状态允许时可能回退根well-known。
	discoverProtectedResourceMetadata,
	// 局部解析WWW-Authenticate头，返回部分挑战，不执行登录。
	parseWwwAuthenticate,
	// 复制服务器URL并去hash，保留query等，不发请求。
	resourceUrlFromServerUrl,
	// 按origin及路径覆盖关系选resource文字，不验证token audience。
	selectResource,
} from "./discovery.ts";
// 重导出错误类方便外部instanceof区分；导出/创建类实例不自动执行失败处理。
export {
	// 适配器报告需要用户交互的标记。
	McpOAuthAuthorizationRequiredError,
	// 带OAuth字符串code及可选errorUri的服务器错误。
	OAuthError,
	// 本地凭据端点HTTPS/loopback策略拒绝的错误。
	OAuthInsecureEndpointError,
	// 预期/实际issuer或iss不符的诊断错误。
	OAuthIssuerMismatchError,
	// 动态客户端注册HTTP失败错误，含状态和原正文。
	OAuthRegistrationError,
} from "./errors.ts";
// 重导出实际授权流程函数与相应TS契约，不额外套一层网络/缓存逻辑。
export {
	// 定制客户端认证回调类型，可原地改headers/表单。
	type AddClientAuthentication,
	// 把OAuthClientProvider适配为HTTP认证接口，并在同返回对象内共享恢复Promise。
	adaptOAuthProvider,
	// 单步骤授权入口，尝试换码/刷新或生成重定向，部分OAuth错误最多清理后重跑一次。
	authorizeMcp,
	// 提交authorization_code和PKCE verifier换令牌，不在自身核对回调state。
	exchangeAuthorizationCode,
	// 客户端ID文档地址与其选择回调的数据类型。
	type OAuthClientMetadataDocument,
	// 宿主提供状态/客户端/令牌/交互方法的接口，不自动创建存储。
	type OAuthClientProvider,
	// 目标地址、code、scope、fetch及signal等流程选项。
	type OAuthFlowOptions,
	// AUTHORIZED/REDIRECT字面量联合，分别指保存新token完成/URL已交宿主。
	type OAuthFlowResult,
	// 用refresh token换新令牌，服务器没给新refresh token时沿用旧值。
	refreshAuthorization,
	// 向注册端点提交客户端元信息，返回解析资料，不自行保存。
	registerClient,
	// 纯构造授权URL与PKCE配对，不开浏览器。
	startAuthorization,
	// 合并增权挑战与旧grant的scope，缺挑战则undefined。
	stepUpScope,
	// 换码/刷新共用认证与请求选项类型。
	type TokenRequestOptions,
} from "./flow.ts";
// 重导出默认状态提供者及可替换存储接口。
export {
	// 按规范化完整MCP地址绑定状态、串行同实例写入的提供者，默认内存存储。
	McpOAuthProvider,
	// 构造提供者的地址/元信息/配置client/store/重定向回调选项。
	type McpOAuthProviderOptions,
	// 可保存客户端、token、verifier、state和发现结果的状态类型。
	type McpOAuthState,
	// 同步或异步load/save接口，不自带文件锁或加密保证。
	type McpOAuthStateStore,
	// 读写时structuredClone的进程内存存储，进程退出不持久保留。
	MemoryOAuthStateStore,
} from "./provider.ts";
// 整个export type块仅重导出类型，在执行JS里擦除，不向外提供同名运行时值或验证器。
export type {
	// 授权服务器文档形状。
	AuthorizationServerMetadata,
	// 解析认证头得到的部分挑战形状。
	OAuthChallenge,
	// 客户端ID/可选secret身份信息。
	OAuthClientInformation,
	// 身份与客户端元信息的交叉类型。
	OAuthClientInformationFull,
	// 精简或完整客户端信息联合，不是互斥标签结构。
	OAuthClientInformationMixed,
	// 动态注册客户端的元信息类型。
	OAuthClientMetadata,
	// 可缓存的发现状态类型，没有自动TTL。
	OAuthDiscoveryState,
	// 受保护资源公布的resource/授权服务器等文档类型。
	OAuthProtectedResourceMetadata,
	// 组合发现返回的数据类型。
	OAuthServerInfo,
	// 访问/刷新令牌等字段类型，不意味着签名、权限或时间已验证。
	OAuthTokens,
} from "./types.ts";
