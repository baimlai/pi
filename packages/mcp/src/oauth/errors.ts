// 定义OAuth流程用的错误类型与诊断字段。discovery/flow用它们区分发行方不符、令牌错误、端点策略、动态注册失败和需要用户授权；创建异常本身不会请求、打开浏览器或清凭证。
// 继承Error保留普通message行为，readonly是TS赋值限制，不会运行时冻结实例。
export class OAuthError extends Error {
	// OAuth错误码文字，如invalid_grant/server_error，flow会据它选择是否作一次凭证失效处理后再试。
	readonly code: string;
	// 可选错误说明链接原文，字段位置必需但值可undefined；这里不验证URL或主动访问它。
	readonly errorUri: string | undefined;

	// 输入code/message与可选errorUri并返回异常实例；例：new OAuthError("invalid_grant","")会用code当message。只保存字段，不自动throw；空白说明是真值，仍原样保留。
	constructor(code: string, message: string, errorUri?: string) {
		// ||以message真值优先，空串回退code，再交Error保存；区别于??只排null/undefined。
		super(message || code);
		// 设置展示名称，不代替instanceof使用的原型关系。
		this.name = "OAuthError";
		// 保留code，后续代码可按精确字符串分支。
		this.code = code;
		// 保存原链接文字或undefined，不在这里safeUrl或脱敏。
		this.errorUri = errorUri;
	}
}

// 发现的issuer或授权回调iss与预期不符时使用；比较规则由调用方决定，本类仅报告expected/received，不自己规范化URL。
export class OAuthIssuerMismatchError extends Error {
	/** `undefined` when no authorization server metadata was discovered. */
	// 预期发行方，授权响应场景没发现文档时可undefined；字段仍存在，只是值可缺省。
	readonly expected: string | undefined;
	/** `undefined` when an authorization response lacks the `iss` parameter its server promised (RFC 9207). */
	// 实际发行方/iss，服务器没给iss时可undefined；不等于字符串"none"。
	readonly received: string | undefined;

	// 输入可选预期/实际字符串并构造异常；例：new OAuthIssuerMismatchError("https://idp.example",undefined)会显示received none。无网络/凭证副作用，不自行比较或throw。
	constructor(expected: string | undefined, received: string | undefined) {
		// 局部format把undefined显示为none，其余用JSON.stringify加引号并转义；它在super前只用参数/局部变量，未访问派生类this，因此语法允许。
		const format = (issuer: string | undefined) => (issuer === undefined ? "none" : JSON.stringify(issuer));
		// 模板调用format生成message，保留实际两侧数据用于排查，不隐藏其中的URL文字。
		super(`OAuth issuer mismatch: expected ${format(expected)}, received ${format(received)}`);
		// 设置发行方不匹配错误名。
		this.name = "OAuthIssuerMismatchError";
		// 保存原expected，不把字符串去尾斜杠或换成URL对象。
		this.expected = expected;
		// 保存原received，供上层读取，不从message反向解析。
		this.received = received;
	}
}

// 端点策略拒绝时的异常；flow.secureEndpoint用于令牌请求和显式元数据地址检查，有loopback例外。此类定义不保证所有OAuth地址都已走该检查。
export class OAuthInsecureEndpointError extends Error {
	// 保存被拒绝端点的文字，readonly仅作TS限制。
	readonly endpoint: string;

	// 输入端点字符串并返回实例；例：new OAuthInsecureEndpointError("http://idp.example/token")。只构造提示，不实际检查协议/loopback、取消请求或发网络，真正拒绝由调用方throw完成。
	constructor(endpoint: string) {
		// 把端点插入英文说明交Error；错误信息未自动脱敏。
		super(`Refusing to send OAuth credentials to non-HTTPS endpoint ${endpoint}`);
		// 设置端点策略错误名。
		this.name = "OAuthInsecureEndpointError";
		// 保留端点字符串供调用者判断/显示。
		this.endpoint = endpoint;
	}
}

// 动态客户端注册HTTP失败时的异常，flow.registerClient在响应非ok时使用；不会自己再次注册。
export class OAuthRegistrationError extends Error {
	// 原HTTP状态数字，不是OAuth error字符串或JSON-RPC错误码。
	readonly status: number;
	// 原响应正文，类本身没有截断/JSON解析/脱敏。
	readonly body: string;

	// 输入HTTP状态及正文，返回异常实例；例：new OAuthRegistrationError(400,"denied")。只拼message并存字段，不检验状态范围、不写凭证或自动throw。
	constructor(status: number, body: string) {
		// 说明同时含状态和完整传入body，不把它限制为固定预览长度。
		super(`OAuth dynamic client registration failed with status ${status}: ${body}`);
		// 设置注册失败的专用名称。
		this.name = "OAuthRegistrationError";
		// 保存status原数值。
		this.status = status;
		// 保存body原文字，后续可不经message拼接直接读取。
		this.body = body;
	}
}

// 告诉HTTP适配器“恢复需要用户交互”的异常；adaptOAuthProvider在授权流程返回REDIRECT时抛它，上层据此显示/继续登录，而不是构造器自己打开授权页。
export class McpOAuthAuthorizationRequiredError extends Error {
	// 无参数构造实例，固定说明和name；例：throw new McpOAuthAuthorizationRequiredError()只触发调用方错误路径，不在此启动回调服务器/浏览器。
	constructor() {
		// 固定说明表示需要用户交互，不携带实际授权URL或状态码。
		super("MCP OAuth authorization requires user interaction");
		// 设置专用错误名，方便上层按类型处理。
		this.name = "McpOAuthAuthorizationRequiredError";
	}
}
