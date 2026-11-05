// 定义MCP服务器配置、校验和扩展注册表；只存声明，不在这里启动命令/连接网络。配置加载器与扩展API调用它，MCP扩展收到变化后才连接。
/**
 * MCP server configuration and the servers extensions register with `pi.registerMcpServer()`.
 *
 * The core only validates and stores registrations. The MCP extension (built in, or another
 * extension that handles `mcp_servers_change`) connects them next to the servers from `mcp.json`.
 */

/**
 * Regular expression for a tool name pattern where `*` matches any characters, as `toolExposure`,
 * `--tools`, and `--exclude-tools` accept them.
 */
// 把工具名通配模式编译成正则；例：get_*匹配get_me，点号仍按字面处理。仅*有特殊意义，不是完整glob，也没有i/s标志；无I/O。
function toolPatternRegExp(pattern: string): RegExp {
	// 构造转义后的正则源码。
	const source = pattern
		// 以*分段，星号两边的文字各自处理。
		.split("*")
		// 转义段内正则元字符；替换串的$&表示匹配原文，前面加反斜杠。
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		// 再用.*连接各段，让*表示零个或多个普通字符；默认点号不跨换行。
		.join(".*");
	// ^/$锚定完整输入；没有m标志，不能忽略末尾换行，前面.*也默认不跨换行。
	return new RegExp(`^${source}$`);
}

/** Whether a tool name matches any of the entries, each an exact name or a pattern. */
// 预编译精确名Set和模式数组，返回(name)=>boolean闭包；例：["read","mcp__*"]允许两类名字。构造后不跟踪原entries数组变化，每次调用不再重编译。
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	// filter挑不含*的项，Set把同名精确项去重。
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	// 含*项编译成RegExp，重复模式未去重。
	const patterns = entries.filter((entry) => entry.includes("*")).map(toolPatternRegExp);
	// 返回箭头函数捕获两组结果，精确命中时||短路，否则some找第一个模式。
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

/** MCP resource tools, which reach every server with resources. */
// 列资源的公共工具名，不含具体服务器前缀。
export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
// 列带参数资源模板的公共工具名。
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
// 读取具体资源的公共工具名。
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

// ReadonlySet只限制通过此类型修改，不在运行时freeze。
const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
	// 将列资源工具加入归类集合。
	LIST_MCP_RESOURCES_TOOL,
	// 将列模板工具加入集合。
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	// 将读资源工具加入集合。
	READ_MCP_RESOURCE_TOOL,
]);

/** Whether a tool comes from MCP: a server tool (`mcp__<server>__<tool>`) or a resource tool. */
// 按命名前缀/三个资源工具名判断是否为MCP工具，返回boolean；例：mcp__x也满足前缀，并不证明已注册服务器或工具存在。
export function isMcpToolName(name: string): boolean {
	// startsWith不是完整工具名解析，||命中任一即可。
	return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
}

/**
 * - `codemode`: tools are callable from codemode scripts but neither declared to the model nor
 *   listed in the codemode description, which lists only the server's namespace. Scripts find them
 *   with `searchTools()`. `codemode-deferred` is accepted as an alias.
 * - `deferred`: not declared to the model until the `tool_search` tool loads them; the model then
 *   calls them directly. Does not need codemode.
 * - `direct`: tools are declared to the model like any other tool (and callable from codemode).
 * - `hidden`: tools are registered but unreachable.
 */
// 四种暴露策略：codemode只供代码发现调用，deferred检索后给模型，direct直接声明，hidden不可达；类型只列名字，真正行为由工具注册/搜索层执行。
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

// satisfies在编译期检查数组元素属于McpExposure，不会转换值；变量本身注解为readonly string[]便于unknown字符串校验。
const MCP_EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"] satisfies McpExposure[];

/** Older exposure names, accepted in configs and replaced by their current name when validated. */
// 只兼容旧codemode-deferred名字；Record声明键到策略映射，不是运行时字典形状检查。
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };

// 两种传输共用的配置基类；?表示可省，英语Default不是这里自动填字段。
interface McpServerConfigBase {
	/** Default: `codemode`. */
	// 未配置时查询函数默认codemode，配置值本身仍可undefined。
	exposure?: McpExposure;
	/**
	 * What the server offers, in a sentence. The `mcp_servers` system prompt section lists the server
	 * with it, tool search ranks the server's tools by it, and codemode's `describeNamespace()` returns it.
	 */
	// 给系统提示词/工具搜索展示的一句话，本层只检查字符串，不检查非空。
	description?: string;
	/**
	 * Exposure of single tools, overriding `exposure`. Keys are tool names as the server offers them,
	 * or patterns where `*` matches any characters. An exact name wins over patterns; among patterns
	 * the first match in the object wins. `hidden` removes tools, so `"exposure": "hidden"` with
	 * overrides for a few tools exposes only those.
	 */
	// 单工具覆盖表：精确名字优先，其次对象枚举顺序中的首个*模式。
	toolExposure?: Record<string, McpExposure>;
	/** Set to false to keep the entry without connecting. Default: true. */
	// false保留配置但不连接，连接层解释默认true。
	enabled?: boolean;
	/** Per-request timeout in seconds. Progress notifications from the server reset it. Default: 60. */
	// 以秒为单位；校验只要求number且>0，未要求整数或有限数。
	timeout?: number;
}

// stdio通过子进程标准输入输出传MCP，继承基础暴露/超时字段。
export interface McpStdioServerConfig extends McpServerConfigBase {
	// type也可省，校验可根据command推断分支；不是必需标签联合。
	type?: "stdio";
	// 执行程序名称/路径，本层允许空串，是否能启动由下游决定。
	command: string;
	// 可选参数数组，每一项保持独立，不在此拼shell命令。
	args?: string[];
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	// 环境值先存表达式文字，连接时才解析变量/!命令；校验不执行它们。
	env?: Record<string, string>;
	/** Relative paths resolve against the session working directory. */
	// 相对cwd解析交连接层，这里只验字符串。
	cwd?: string;
}

/** OAuth client settings for servers that do not support dynamic client registration. */
// OAuth可指定预注册客户端、回调和发现策略；接口只是编译契约，下面validateOAuth处理不可信配置。
export interface McpOAuthConfig {
	/** Pre-registered client id. Without it, pi registers a client with the authorization server. */
	// 预注册client id，缺省由OAuth层决定CIMD/DCR流程。
	clientId?: string;
	/** May reference environment variables (`${NAME}`) or commands (`!cmd`). */
	// 可保存变量或命令引用，本文件不解析或打印秘密值。
	clientSecret?: string;
	/**
	 * Port of the loopback callback server, for clients registered with a fixed redirect URI. Without
	 * `callbackUrl`, the redirect URI is `http://127.0.0.1:<port>/callback`.
	 */
	// 回调端口应1..65535整数，实际校验在下面。
	callbackPort?: number;
	/**
	 * Redirect URI registered for `clientId`, for example `http://localhost:8080/oauth/callback`. It must
	 * be an `http` URI on `localhost`, `127.0.0.1`, or `[::1]`. Without a port, the callback server
	 * listens on `callbackPort` or a free port, which is added to the URI (RFC 8252).
	 */
	// 回调URL需本地HTTP且无query/hash，具体路径仍可自定义。
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. Default: the scopes the server advertises. */
	// 空格分隔scope，本层只验字符串，不验证远端权限。
	scope?: string;
	/**
	 * `client_name` sent with dynamic client registration, for servers that only accept known clients.
	 * Default: `pi`.
	 */
	// clientName若提供不能全空白；通过校验后不自动trim值。
	clientName?: string;
	/**
	 * How pi identifies itself without `clientId`. `auto` (default): pi's Client ID Metadata Document on
	 * pi.dev when the authorization server supports it for public clients, otherwise dynamic client
	 * registration; with `clientName` or a `callbackUrl` other than `/callback` on localhost or 127.0.0.1,
	 * always dynamic client registration. `cimd`: always the document, and sign-in fails without support.
	 * `dcr`: always dynamic client registration.
	 */
	// auto自动选择、dcr动态注册、cimd客户端元数据文档；cimd有额外互斥/回调限制。
	clientRegistration?: "auto" | "dcr" | "cimd";
	/**
	 * Authorization server metadata document (RFC 8414 or OpenID Connect discovery) to use instead of
	 * discovery through the server, for servers that advertise a wrong authorization server or none.
	 * The document is trusted as configured. Must use https, except on loopback hosts.
	 */
	// 显式授权服务器元数据地址，HTTPS或本地HTTP；本层不联网判断内容可信或可达。
	authServerMetadataUrl?: string;
}

// 按URL解析后的hostname比较，IPv6保留方括号形式。
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Whether a redirect URI can be served by pi's loopback callback server. */
// 判断文字是否是允许的本机HTTP回调，返回boolean；例：http://localhost/cb可用，HTTPS回调在此不允许。不做DNS解析，也不检查用户名/密码字段。
export function isLoopbackRedirectUri(value: string): boolean {
	// 不可解析直接false，避免new URL在这条路径抛。
	if (!URL.canParse(value)) return false;
	// 构造标准URL供协议/主机字段比较。
	const url = new URL(value);
	// 只允许三个主机、http、空search/hash；路径和端口由其他规则处理。
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

/**
 * Whether pi's Client ID Metadata Documents list a redirect URI for the loopback `callbackUrl`: they list
 * `/callback` on localhost and 127.0.0.1, on any port. Without `callbackUrl`, pi uses such a URI.
 */
// 在已通过本地回调校验的前提下检查CIMD支持的路径；缺省true，例：http://localhost/callback为true。直接传坏URL会抛；函数自身没有重新验证协议/主机白名单。
export function isClientMetadataDocumentCallback(callbackUrl: string | undefined): boolean {
	// 没有显式URL意味着下游采用支持的默认回调。
	if (callbackUrl === undefined) return true;
	// new URL可抛，调用者先做isLoopbackRedirectUri。
	const url = new URL(callbackUrl);
	// 仅排除IPv6并要求/callback；不能把本函数独立当完整安全校验。
	return url.hostname !== "[::1]" && url.pathname === "/callback";
}

// HTTP/streamable HTTP传输配置，共用基础策略。
export interface McpHttpServerConfig extends McpServerConfigBase {
	// type可省；运行时还接受streamable-http别名而原类型只声明http。
	type?: "http";
	// MCP端点URL字符串，校验要求HTTP/HTTPS但不在此连接。
	url: string;
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	// 头值允许表达式，后端连接前解析。
	headers?: Record<string, string>;
	// 可选OAuth覆盖。
	oauth?: McpOAuthConfig;
	/**
	 * Send the token of a pi provider (`/login <provider>`) instead of using OAuth. Not allowed in project
	 * `mcp.json` files, and requires https except on loopback hosts, since it sends the credential to `url`.
	 */
	// 复用Pi供应商凭据；项目文件禁止由上游配置加载器实施，本校验器本身不识别来源范围。
	auth?: { provider: string };
}

// 两种配置的联合不是严格必需type判别联合，可通过command/url等属性收窄。
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

// 服务器名仅ASCII字母/数字/_/-至少一位；不同名字的命名空间冲突由调用方另查。
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`, like the tool names. */
// 构造工具命名空间，例：my-server→mcp__my_server；不校验名字或检查是否已注册，-和_因此可能碰撞。
export function mcpNamespace(server: string): string {
	// replace带g替换所有-，模板串添加固定前缀。
	return `mcp__${server.replace(/-/g, "_")}`;
}

// 不可信配置边界的粗对象谓词；例：null/数组失败，普通对象通过。不检查原型或每个字段。
function isRecord(value: unknown): value is Record<string, unknown> {
	// &&短路排除null和数组，value is仅把这一判断结果提供给TS收窄。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 检查对象所有可枚举自有值都是字符串，返回类型谓词；例：{A:"x"}通过，空对象也通过，不检查变量名是否符合环境规则。
function isStringRecord(value: unknown): value is Record<string, string> {
	// 先isRecord再Object.values，every空数组为true。
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

// 校验可选OAuth配置，返回第一条错误文字或undefined；例：端口1.5失败。只验证本层列出的字段，保留未知键，不发授权请求/填默认值。
function validateOAuth(value: unknown): string | undefined {
	// 没配置OAuth不是错误。
	if (value === undefined) return undefined;
	// 有值必须粗对象。
	if (!isRecord(value)) return "oauth must be an object";
	// clientId提供时要求字符串，但没有非空要求。
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	// clientSecret同样只验字符串，undefined允许。
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
		// 返回明确字段错误，不抛异常对象。
		return "oauth.clientSecret must be a string";
	}
	// 取unknown端口供类型/数值检查。
	const port = value.callbackPort;
	// 依次要求number、整数、1..65535；短路保护后续判断。
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		// 首个失败立即返回，后续字段不再验证。
		return "oauth.callbackPort must be a port number";
	}
	// 只对显式callbackUrl执行URL规则。
	if (value.callbackUrl !== undefined) {
		// 先验字符串，再调用本地回调谓词。
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
			// 协议/主机/query/hash失败的统一说明。
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		// URL已通过可解析检查，读取显式/规范化端口文字。
		const urlPort = new URL(value.callbackUrl).port;
		// 两个端口都明确时必须相等；URL默认80可能规范化为空，不在本判断比较。
		if (urlPort && port !== undefined && Number(urlPort) !== port) {
			// 拒绝明确的不一致端口。
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	// scope可空串，不校验权限集合。
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	// clientName要求字符串且trim后非空，原值不会在这里trim回写。
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
		// 全空白名称给出错误。
		return "oauth.clientName must be a non-empty string";
	}
	// 保存注册策略unknown值。
	const registration = value.clientRegistration;
	// 缺省/auto/dcr跳过额外分支。
	if (registration !== undefined && registration !== "auto" && registration !== "dcr") {
		// 其余只接受cimd，未知策略立刻返回错误。
		if (registration !== "cimd") return 'oauth.clientRegistration must be "auto", "dcr", or "cimd"';
		// cimd不可显式带clientId或clientName，空串也算提供了字段。
		if (value.clientId !== undefined || value.clientName !== undefined) {
			// 互斥失败，不自动选择其他策略。
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		}
		// 在已通过回调校验后检查CIMD路径/IPv6，未配置回调按默认。
		if (!isClientMetadataDocumentCallback(typeof value.callbackUrl === "string" ? value.callbackUrl : undefined)) {
			// 失败要求文档覆盖的主机/路径。
			return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
		}
	}
	// 授权服务器元数据可另行配置。
	const metadataUrl = value.authServerMetadataUrl;
	// 仅提供时校验。
	if (metadataUrl !== undefined) {
		// 必须字符串且可解析才构造URL，否则undefined；不是类型断言验证。
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		// 允许任意HTTPS，或列出的本机HTTP，不检查query/hash/账号字段。
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
			// 其他协议/远程HTTP拒绝。
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	// 当前已知规则全部通过，undefined代表没有错误，不是配置对象。
	return undefined;
}

// 检查外部值是否为四个当前暴露策略，返回类型谓词；旧别名须先归一化。例：direct通过，visible失败。
function isExposure(value: unknown): value is McpExposure {
	// 先字符串判断，再用includes比较实际内容。
	return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

/** The exposure an alias stands for; other values are returned unchanged. */
// 将旧暴露名归一化，查表无值才返回原unknown；例：codemode-deferred→codemode。表是普通对象，toString等继承键也可能取到函数，后续isExposure再拒绝，不在这里验证策略。
function resolveExposureAlias(value: unknown): unknown {
	// ??只在查表无值时返回原值；表是普通对象，仍沿用其属性访问语义，不是Map。
	return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

/** A copy of the server entry with exposure aliases replaced by their current names. */
// 浅复制服务器对象并转换顶层/单工具暴露别名，返回unknown字段字典；例：旧名变codemode。未知字段保留，不深复制其他配置。
function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
	// 解构读两组配置，不删除原字段。
	const { exposure, toolExposure } = value;
	// 顶层新对象，env/oauth等暂仍共用引用。
	const resolved: Record<string, unknown> = { ...value };
	// 显式exposure才覆写归一化结果。
	if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
	// toolExposure是对象才逐项处理，不在此为错误输入报错。
	if (isRecord(toolExposure)) {
		// fromEntries将键值对重新构造成对象。
		resolved.toolExposure = Object.fromEntries(
			// map参数解构[tool,entry]，只转换值，名字不改。
			Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
		);
	}
	// 返回新顶层对象，后面校验器继续处理。
	return resolved;
}

/** Exposure of one tool of a server: its `toolExposure` entry, else the server's `exposure`. */
// 按精确工具名、枚举顺序首个通配、服务器默认返回策略；例：get_me显式direct胜过get_*。不修改配置，不检查该工具已存在。
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	// 没有覆盖用新空对象。
	const overrides = config.toolExposure ?? {};
	// 普通属性索引访问，不是hasOwn检查。
	const exact = overrides[toolName];
	// 非undefined精确值立即返回，不再考察模式。
	if (exact !== undefined) return exact;
	// Object.entries只遍历可枚举自有项，顺序遵从JS对象规则。
	for (const [pattern, exposure] of Object.entries(overrides)) {
		// 仅含*的键才当模式，每次此处会重新编译，不复用createToolNameMatcher缓存。
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	// 都未命中则服务器策略优先，缺省codemode；不写回配置字段。
	return config.exposure ?? "codemode";
}

/**
 * Validate one server entry of the `mcpServers` shape. Returns a copy of the config with exposure
 * aliases resolved, or an error message.
 */
// 校验一台服务器的外部声明，返回归一化配置或错误string；例：{command:"node"}通过，缺command/url返回错误。只存配置、不连接，不检查项目来源/namespace碰撞；未知字段保留，双重as不做补充验证。
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	// 先校验注册名，正则不允许空串或空格。
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	// raw是JSON/扩展边界unknown，必须非null非数组对象。
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	// 浅复制并替换旧暴露别名，不改原输入顶层。
	const value = resolveExposureAliases(raw);
	// 解构公共字段用于逐项校验。
	const { type, exposure, enabled, timeout, toolExposure, description } = value;
	// 将四种允许值拼成报错中的文字列表，map内value遮蔽外层同名变量。
	const exposures = MCP_EXPOSURES.map((value) => `"${value}"`).join(", ");
	// 提供exposure但不在集合就失败。
	if (exposure !== undefined && !isExposure(exposure)) {
		// 返回字符串错误而非throw，由上游决定显示或抛。
		return `server "${name}": exposure must be one of ${exposures}`;
	}
	// 可省单工具覆盖表。
	if (toolExposure !== undefined) {
		// 有值须是对象映射，数组不接受。
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		// 遍历每个工具名/策略值，这里的value是循环局部变量。
		for (const [tool, value] of Object.entries(toolExposure)) {
			// 任何策略非法就返回第一条错误；工具名本身不额外校验。
			if (!isExposure(value)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
		}
	}
	// enabled显式提供时必须boolean，false合法。
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	// description只检查字符串，不要求非空。
	if (description !== undefined && typeof description !== "string") {
		// 数字等类型拒绝。
		return `server "${name}": description must be a string`;
	}
	// timeout要求number且>0，拒绝NaN/非正数，但Infinity仍通过。
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		// 单位是秒，不在这里转换毫秒。
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	// 明确拒绝旧SSE，不静默切换传输。
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;

	// 有字符串url且type缺省/http/streamable-http时先走HTTP；若同时command存在，这个分支优先。
	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		// 先可解析再检查HTTP/HTTPS协议，不进行请求。
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
			// 不接受没有协议的地址。
			return `server "${name}": url must be an http or https URL`;
		}
		// headers有值须字典且所有可枚举值为字符串。
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			// 此处不解析Bearer变量/命令引用。
			return `server "${name}": headers must map names to strings`;
		}
		// 验证可选OAuth对象。
		const oauthError = validateOAuth(value.oauth);
		// 前缀补服务器名，返回同一错误内容。
		if (oauthError) return `server "${name}": ${oauthError}`;
		// 显式auth配置触发复用供应商凭据规则。
		if (value.auth !== undefined) {
			// 必须对象且provider是非空字符串；没trim，因此纯空白仍可通过这一层。
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) {
				// 拒绝缺provider/空串等形状。
				return `server "${name}": auth.provider must be a provider name`;
			}
			// URL已通过HTTP/HTTPS检查，可重新解析。
			const url = new URL(value.url);
			// 非HTTPS时仅本地主机允许携带供应商凭据。
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
				// 拒绝把该凭据发送到普通远程HTTP；项目文件限制仍由上游执行。
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
			}
		}
		// 双断言unknown桥接到类型，不删未知键、不补默认值、不把streamable-http文字改成http。
		return value as unknown as McpHttpServerConfig;
	}
	// 未走HTTP时，有字符串command且type缺省/stdio才走本地传输，空串command也满足类型检查。
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		// 下面合并判定可选args是否合格。
		if (
			// 只有提供args时才需要校验。
			value.args !== undefined &&
			// 必须数组且每个元素string；every空数组为true，内部arg来自不可信数组。
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		) {
			// 参数错误返回说明，不实际运行命令。
			return `server "${name}": args must be an array of strings`;
		}
		// env须字符串字典，空字典通过，不验证环境变量名规则。
		if (value.env !== undefined && !isStringRecord(value.env))
			// 只报类型错误，不执行其中的!cmd。
			return `server "${name}": env must map names to strings`;
		// cwd可省或字符串，包括空串；路径存在性不在此查。
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		// 声明验证通过；oauth/auth等HTTP相关额外字段如果混入本分支也不会被统一剔除。
		return value as unknown as McpStdioServerConfig;
	}
	// 所有已支持分支都未匹配时返回缺少传输入口说明，函数无成功副作用。
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** A server an extension registered with `pi.registerMcpServer()`. */
// 扩展注册的一条服务器记录，注册所有权用extensionPath追踪。
export interface RegisteredMcpServer {
	// 原始服务器名，不是规范化的mcp namespace。
	name: string;
	// 传输与暴露配置，本接口不强制深不可变。
	config: McpServerConfig;
	/** Path of the extension that registered the server. */
	// 注册来源扩展路径，注销时必须精确相等。
	extensionPath: string;
}

/** Servers registered by the extensions of one runtime. */
// 一个扩展运行时共享的服务器内存表；无网络/子进程连接，不自动持久化。变化监听只有一个，后续设置会替换。
export class McpServerRegistry {
	// Map按名字索引并保持插入顺序；readonly禁止重新赋这个Map字段，不禁止set/delete。
	private readonly servers = new Map<string, RegisteredMcpServer>();
	// 可选无参回调，不是多个监听器数组，也没有异步等待。
	private changeListener: (() => void) | undefined;

	/** Register or replace a server. The caller checks ownership. */
	// 登记或替换server后同步通知，返回void；例：同名set替换值不改变原插入顺序。保存原对象引用，所有权校验在上游；监听抛错时表已经改动，不自动回滚。
	register(server: RegisteredMcpServer): void {
		// 直接set，不复制配置或检查归属。
		this.servers.set(server.name, server);
		// 有监听才调用；即使值相同重新register也会通知。
		this.changeListener?.();
	}

	/** Remove a server registered by `extensionPath`. Servers of other extensions are left alone. */
	// 仅当当前记录归属精确等于extensionPath时删除并通知，返回void；例：别的扩展同名注销无操作。监听异常会传播，删除不回滚。
	unregister(name: string, extensionPath: string): void {
		// 缺记录或来源不同直接结束，可选链避免读undefined属性。
		if (this.servers.get(name)?.extensionPath !== extensionPath) return;
		// 按名字删除，不在这里关闭服务器连接。
		this.servers.delete(name);
		// 删除后同步通知，由MCP扩展协调实际连接。
		this.changeListener?.();
	}

	// 按名取当前原记录或undefined，无I/O；例：get("docs")不是复制，调用者改对象可能影响表。
	get(name: string): RegisteredMcpServer | undefined {
		// 直接Map.get，不做惰性加载。
		return this.servers.get(name);
	}

	/** Copies of the registered servers, in registration order. */
	// 按注册顺序返回每条新记录及深克隆配置，避免常规调用者改list影响表；例：修改list()[0].config不会改登记配置。structuredClone遇不可克隆的混入字段可能抛，克隆不是校验。
	list(): RegisteredMcpServer[] {
		// 展开values成数组；外层对象浅复制，config单独structuredClone，顺序不排序。
		return [...this.servers.values()].map((server) => ({ ...server, config: structuredClone(server.config) }));
	}

	/** Called after every change. The runner sets it when it binds, to emit `mcp_servers_change`. */
	// 替换唯一的变化回调或设undefined清除，返回void；例：runner绑定时登记，调用本方法不会立即回放旧变化。
	setChangeListener(listener: (() => void) | undefined): void {
		// 保存函数引用，不调用或Promise化它。
		this.changeListener = listener;
	}
}
