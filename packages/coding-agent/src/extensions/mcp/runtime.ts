/**
 * The part of the MCP integration that talks to servers: connections, transports, and OAuth
 * sign-in. It pulls in the MCP client, so index.ts loads it through runtime.lazy.ts only when a
 * server is configured.
 */

// 连接层把配置变成真正的 MCP 会话。上游通过 lazy 入口加载本文件，再调用 getClient/callTool；这里负责握手、工具发现、重连、登录状态和关闭。
// 例：模型调用远端工具 → withClient → getClient → 必要时 connectOnce → MCP client.callTool。资源内容转换在 resources.ts/tools.ts。
// Node 工具分别处理用户目录、路径、可取消的等待和 file:// URI；定时器导入用 as 改名，避免和普通 setTimeout 混淆。
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
// 同一个 import 中，type 项只参与编译期检查；McpClient、传输和错误类则会在运行时被创建或用于 instanceof 分支。
import {
	type AuthProvider,
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpAuthRequiredError,
	McpClient,
	McpError,
	McpHttpError,
	type McpRequestOptions,
	McpSessionExpiredError,
	type Tool as McpTool,
	type McpTransport,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
// OAuth 的“必须重新登录”错误与普通 HTTP 认证错误分开；challenge 记录服务器要求的权限/元数据地址。
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
// 握手使用项目版本号；配置表达式解析器可能读取环境变量或执行 ! 命令，失败会沿连接路径抛出。
import { VERSION } from "../../config.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
// import type 表示这里只借用结构；不会因这个声明在运行时加载对应模块。
import type { McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
// OAuth 提供者负责读取/刷新令牌；构造它不等于现在就登录、联网或读取凭证文件。
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
} from "./oauth.ts";
// implements 后面的两个接口约定“可调用工具”和“可读取资源”的形状；它们不生成运行时包装层。
import type { McpResourceServer } from "./resources.ts";
import type { McpToolCaller } from "./tools.ts";

// 重新导出供 lazy 调用方使用，让它们拿到同一组连接、日志和登录入口。
export { McpServerLog } from "./log.ts";
export { McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer } from "./oauth.ts";

// 默认每个 MCP 请求的秒数；数字分隔符 2_000 等于 2000，此处 stderr 取的是 JS 字符串末尾长度，不是 UTF-8 字节数。
const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
// HTTP 建连失败可再等 250ms、1000ms，各重试一次，总共最多尝试三次；stdio 不采用这组重试。
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

/**
 * `disconnected`: the connection dropped (for example the stdio server exited); the next call
 * reconnects.
 */
// 字符串字面量联合类型限制状态名。它不会自动检查状态转换是否合法；赋值和通知由下面各方法完成。
type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

// 传输工厂的函数类型：输入服务器配置、工作目录和可能没有的认证提供者，返回实现 McpTransport 的对象；便于测试注入内存传输。
export type McpTransportFactory = (
	// entry 包含配置、名称和来源；cwd 是本次会话的工作目录。
	entry: McpServerEntry,
	cwd: string,
	// AuthProvider | undefined 表示参数要传，但允许明确传 undefined；这和可省略参数的 ? 写法不同。
	authProvider: AuthProvider | undefined,
) => McpTransport;

// 把未知异常转成展示文字。例如 Error("断线") 取 message，抛出的字符串直接 String 化；不做脱敏，也不保留完整堆栈。
function errorMessage(error: unknown): string {
	// unknown 要先收窄才能读 message；instanceof 只识别当前 Error 类体系中的实例。
	return error instanceof Error ? error.message : String(error);
}

/** Network failures and overloaded or restarting servers, which are worth another attempt. */
// 按本实现的规则判断能否重试；TypeError 被宽泛当成网络类故障，并不能证明它一定来自网络。
function isTransientError(error: unknown): boolean {
	// HTTP 错误优先按状态码判断，不会继续落入下面的 TypeError 分支。
	if (error instanceof McpHttpError) {
		// 408 超时、429 限流和除 501 外的 5xx 都可重试；表达式没有另加小于 600 的上限，也不读取 Retry-After。
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	// 其他错误只有 TypeError 命中；配置表达式/回调抛出的 TypeError 也可能走到这个判断。
	return error instanceof TypeError;
}

// 根据认证来源生成操作提示，不自动弹登录界面。绑定 pi 提供商的服务器提示 /login 提供商，其余提示 /mcp。
function signInRequiredMessage(entry: McpServerEntry): string {
	// in 操作符区分 HTTP 配置；?. 在 auth 缺失时得到 undefined。
	const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
	// 模板字符串内嵌三元表达式，选两种提示；这里返回字符串，不执行任何命令。
	return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header or `auth`. */
// 决定 HTTP 是否采用独立 MCP OAuth：有 auth.provider 或任何大小写形式的 Authorization 头就排除；头的值即使为空也按键名判断。
function usesOAuth(entry: McpServerEntry): boolean {
	// 解构只取同一个 config 引用，没有深复制配置。
	const { config } = entry;
	// 没有 url 属于本地命令配置；config.auth 存在时由 pi 提供商供令牌。
	if (!("url" in config) || config.auth) return false;
	// ?? {} 在 headers 空缺时给空对象；some 只要发现一个认证头就停止，前面的 ! 把“发现”变成“不使用 OAuth”。
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
// 只展开当前用户的 ~、~/ 路径，以及 Windows 的 ~\ 路径。例 ~/bin/mcp 变成用户目录下 bin/mcp；不会处理 ~alice、$HOME 或 shell 引号。
function expandHome(value: string): string {
	// 整串只有波浪号时直接返回主目录。
	if (value === "~") return homedir();
	// startsWith 按字面前缀比较；反斜杠写成 \\ 是字符串转义，Windows 条件只影响这一种前缀。
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		// slice(2) 去掉波浪号和分隔符，再用平台路径规则拼接。
		return join(homedir(), value.slice(2));
	}
	// 其余输入原样返回，不做路径存在性检查。
	return value;
}

/**
 * 根据 entry 创建 HTTP 或 stdio 传输对象，返回值尚未 connect/start。
 * 流程：按 url 区分 → 解析请求头或进程环境 → 组装参数；解析 ! 命令可能产生副作用或抛错。
 * 例：{command:"node",args:["server.js"]} 会交给 StdioTransport，真正启动进程要等连接时。
 */
export function createDefaultTransport(
	// 配置由加载层校验；本函数不再验证所有字段的运行时形状。
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	// 取配置和名称；名称用于让配置解析失败的报错能指出是哪台服务器。
	const { config, name } = entry;
	// HTTP 分支用 in 收窄联合类型，后面可直接访问 config.url。
	if ("url" in config) {
		// 创建 Streamable HTTP 传输；构造只是保存参数，后续 client.connect 才启动会话。
		return new StreamableHttpTransport({
			// 服务器地址按配置传递，未在这里重写路径或加 token。
			url: config.url,
			// 逐个解析请求头值；配置缺失/命令失败等异常会终止本次构造。
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			// 对象属性简写等于 authProvider: authProvider；实际请求时再向它取 token。
			authProvider,
		});
	}
	// Record<string, string> 是“字符串键对应字符串值”的 TS 字典类型，{} 是此处新建的运行时空对象。
	const env: Record<string, string> = {};
	// Object.entries 把环境配置变成 [键, 值] 对；for...of 每次解构一对。
	for (const [key, value] of Object.entries(config.env ?? {})) {
		// 解析后写入此连接额外设置的环境变量；StdioTransport 默认还会继承 process.env，再由这些键覆盖同名值。
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	// 这里没有 shell:true；命令和参数分别传给进程库，并不是把一整段文本当 shell 脚本运行。
	return new StdioTransport({
		// 仅对命令本身展开 ~，PATH 查找由后续进程启动库处理。
		command: expandHome(config.command),
		// 可选链 map：没给 args 就保持 undefined；给了则每个参数都做同样的 ~ 展开，哪怕该参数不是文件名。
		args: config.args?.map(expandHome),
		// 相对 cwd 以会话目录为基准转成绝对路径；默认 . 就是会话目录。
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		// 传额外环境表；这里只组装，尚未创建子进程。
		env,
		// 捕获子进程标准错误，连接失败/断开时取尾部加入提示；不是把 stderr 混入 JSON-RPC stdout。
		stderr: "pipe",
	});
}

/** Servers that do not implement `resources/templates/list` have no templates. */
// 泛型 T 让成功值和空值保持同一类型。只吞 MCP methodNotFound，例“不支持模板列表”返回 []，认证或断网仍报错。
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	// try 必须覆盖 await 后的拒绝，才能在下方 catch 判断远端方法错误。
	try {
		// list 是无参回调，真正执行和等待在此发生。
		return await list();
	} catch (error) {
		// 同时检查错误类和方法不存在的错误码，避免把所有失败都伪装成空资源。
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		// throw 保留原异常对象交给调用方。
		throw error;
	}
}

// 获取所有资源模板页；默认 options={}，只有模板方法缺失才降级为空列表，分页由 MCP client 完成。
function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
	// 箭头函数推迟执行，[] 作为失败降级值；不在这里逐页遍历。
	return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/** One configured server. Reconnects lazily when a call finds the connection gone. */
/**
 * 管理一台服务器的连接和发现结果。implements 是编译期接口约束，private/readonly 主要也是 TS 访问约束。
 * 例：两个工具同时首次调用，共享 opening 这一次连接；断线后下一次调用才重连，没有后台无限重连。
 * 状态供 UI 读取；回调可同步抛错，本类没有隔离上游回调异常的通用保护。
 */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	// readonly 禁止通过本字段重新赋 entry，不会冻结 entry 内部对象。
	readonly entry: McpServerEntry;
	// 刚构造就标 connecting，但此时尚未真正发起连接。
	state: ServerState = "connecting";
	// 最近错误供状态展示；undefined 表示这里没有错误文字。
	error: string | undefined;
	// 最近发现的工具列表，失败/断开时不在所有路径清空；不能只看这个数组就断定服务器仍在线。
	tools: McpTool[] = [];
	/**
	 * Whether the server offers resources, which the resource tools list and read on demand. They are
	 * not listed at connect: listing every resource can take long (a large drive, say).
	 */
	// 只记录是否声明资源能力，连接时不拉取全部资源目录。
	hasResources = false;
	/** Server instructions from `initialize`, describing its tools as a group. */
	// 服务器给整组工具的说明，连接成功时去掉两端空白。
	instructions: string | undefined;
	/** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
	// 保存最近一次认证挑战，登录时可复用所需 scope 和资源元数据 URL；普通重连不会自动清空它。
	challenge: OAuthChallenge | undefined;
	// 当前已接管的客户端；关闭回调和刷新成功分支用身份比较过滤旧实例，刷新失败等路径仍可能改状态，见具体方法。
	private client: McpClient | undefined;
	// 正在进行的连接 Promise，多个并发调用共享它；成功或失败后 finally 清空，允许以后再尝试。
	private opening: Promise<McpClient> | undefined;
	/** Aborted by `close()`; cancels a connect in progress, including the wait between retries. */
	// 每个连接对象只有一个关闭信号；abort 后不会重置，所以 close 是终止该对象而不是临时断开。
	private readonly shutdown = new AbortController();
	/** Stderr of the last stdio server that failed to connect. */
	// 失败的 stdio 连接日志尾部；每轮连接前清空，避免沿用上轮错误。
	private stderrTail: string | undefined;
	// 保存会话工作目录，供进程 cwd 和 MCP roots 使用。
	private readonly cwd: string;
	// 注入工厂创建每次尝试的新传输，测试可以替换真实进程/HTTP。
	private readonly createTransport: McpTransportFactory;
	// 独立 MCP OAuth、pi 提供商令牌桥接，或不提供认证；并非所有连接都必有 OAuth。
	private readonly authProvider: McpAuthProvider | undefined;
	// 发现/刷新工具后通知上层注册工具；函数类型说明接收本连接，返回 void。
	private readonly onTools: (connection: McpServerConnection) => void;
	// 可选状态通知；括号把整个函数类型与 undefined 组合。
	private readonly onChange: ((connection: McpServerConnection) => void) | undefined;
	// 可选日志写入器，未设置就不订阅服务器日志通知。
	private readonly log: McpServerLog | undefined;

	/** 保存配置并创建按需取令牌的认证回调；不 connect，不启动子进程，也不在构造阶段读取 token。 */
	constructor(options: {
		// 参数对象集中放依赖，调用者可用字段名明确传入，避免位置参数混淆。
		entry: McpServerEntry;
		// 会话工作目录，用于执行/声明根目录，不是服务器自身声明的任意目录。
		cwd: string;
		// 传输工厂只在连接尝试时调用。
		createTransport: McpTransportFactory;
		// 凭证存储对象；forServer 创建按名称/URL寻址的访问接口，不立即读文件。
		credentials: McpOAuthCredentialStore;
		/** The current token of a pi provider, for servers with `auth.provider`. */
		// 可选异步函数，输入 pi 提供商名称，输出它当前可用的令牌或 undefined。
		providerToken?: (provider: string) => Promise<string | undefined>;
		// 工具变动通知是必填的；不提供默认空实现。
		onTools: (connection: McpServerConnection) => void;
		/** Called when `state`, `error`, or `tools` change. */
		// 状态通知可省略，具体触发位置由 changed 控制，不是属性自动观察器。
		onChange?: (connection: McpServerConnection) => void;
		/** Receives the server's log messages (`notifications/message`). */
		// 由调用者提供日志位置；此处不自行创建写日志目录。
		log?: McpServerLog;
	}) {
		// 依次保存输入的引用/函数；不是克隆一整套配置或依赖。
		this.entry = options.entry;
		// 记录目录字符串。
		this.cwd = options.cwd;
		// 记录工厂函数，不在赋值时调用。
		this.createTransport = options.createTransport;
		// 记录工具更新回调。
		this.onTools = options.onTools;
		// 记录可选状态回调。
		this.onChange = options.onChange;
		// 记录可选日志实例。
		this.log = options.log;
		// getter 按配置判断是否走独立 OAuth；它只是读配置。
		const url = this.oauthUrl;
		// 只有 HTTP 配置可能引用 pi 提供商；没有就得到 undefined。
		const provider = "url" in this.entry.config ? this.entry.config.auth?.provider : undefined;
		// 连续三元表达式按顺序选：独立 OAuth → pi 提供商令牌桥 → 无认证提供者。
		this.authProvider = url
			? createMcpAuthProvider({
					// 同一服务器名称+地址绑定一套独立凭证。
					serverUrl: url,
					// 只生成该服务器的存取接口，真正 load/save 在请求或登录过程中发生。
					store: options.credentials.forServer(this.entry.name, url),
					// 零参数箭头函数延迟解析 secret；不会因为暂时解析不到 secret 就让构造直接失败。
					settings: () => this.oauthSettings(),
					// 401 等响应带来认证挑战时保存下来，不在这个回调里自动启动浏览器登录。
					onChallenge: (challenge) => {
						// 直接替换最近挑战对象。
						this.challenge = challenge;
					},
				})
			: // 没有独立 OAuth 时再看是否有 pi 提供商名称。
				provider
				? // Read on every request, so the provider's refreshes apply; MCP stores no copy.
					// async 将返回值包成 Promise；每次 token() 读取最新提供商令牌，settled 是兼容关闭接口的空操作。
					{ token: async () => options.providerToken?.(provider), settled: async () => {} }
				: // 没有两种认证方案就交给传输使用配置头或匿名访问。
					undefined;
	}

	/** getter 让调用方像读字段一样取名称，例如 connection.name；不会缓存名称副本。 */
	get name(): string {
		// 读取 entry 当前名称。
		return this.entry.name;
	}

	// 私有 getter 把永久关闭信号转换成布尔值，不是检查某个 TCP 连接是否在线。
	private get closed(): boolean {
		// AbortSignal.aborted 一旦为 true 就保持为 true。
		return this.shutdown.signal.aborted;
	}

	/** 将配置秒数转成请求毫秒数；默认 60 秒，并不代表整个登录或整个会话的总时限。 */
	get timeoutMs(): number {
		// ?? 只在 null/undefined 时取默认值；乘法在这里不再额外做范围或溢出验证。
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** Server URL when the server authenticates with OAuth. */
	/** 仅独立 MCP OAuth 返回 URL；stdio、显式认证头和 auth.provider 都返回 undefined。 */
	get oauthUrl(): string | undefined {
		// && 先判断用途，再用 in 收窄后读 url；条件不成立走三元的 undefined 分支。
		return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
	}

	/** 把配置转成 OAuth 运行参数；可能解析 ! secret 命令或构造 URL 而抛错，不会自行连接/登录。 */
	oauthSettings(): McpOAuthSettings {
		// 从 HTTP 配置中取 oauth 段，stdio 没有该段。
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		// 完全没配 oauth 时给空设置，让 OAuth 层采用它的默认规则。
		if (!oauth) return {};
		// 返回新对象，字段未设置时保持 undefined，交给下一层决定默认值。
		return {
			// 可选的预注册客户端 ID。
			clientId: oauth.clientId,
			// secret 与普通字串字段不同，可能需要解析环境变量/命令。
			clientSecret:
				// 严格区分没设置与显式空字符串，不用 truthy 规则把空串当未设置。
				oauth.clientSecret === undefined
					? undefined
					: // 带服务器名称解析，失败提示可指出来源；返回的才是实际 secret。
						resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			// 回调监听端口；没有时下一层可选空闲端口。
			callbackPort: oauth.callbackPort,
			// 自定义回调 URL，格式约束在配置边界完成。
			callbackUrl: oauth.callbackUrl,
			// 所需权限 scope，仍是空格分隔的字符串。
			scope: oauth.scope,
			// 动态注册时使用的客户端显示名称。
			clientName: oauth.clientName,
			// auto/dcr/cimd 决定客户端注册策略。
			clientRegistration: oauth.clientRegistration,
			// 有值才构造 URL 对象；URL 构造器可能抛错，?. 并不自动吞异常。
			authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
		};
	}

	/** 取得在线客户端，必要时共享一次懒连接。已永久关闭则拒绝；连接失败后允许后续调用重新尝试。 */
	getClient(): Promise<McpClient> {
		// 此函数不声明 async，但可以直接返回 Promise.reject，调用者仍通过 await/catch 接收失败。
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		// 只复用真实 connectionState=connected 的客户端，不靠本类 state 字段猜测。
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		// ??= 仅在 opening 为 null/undefined 时启动连接；finally 无论成功失败都会运行。
		this.opening ??= this.open().finally(() => {
			// 清掉正在连接标记，不是清掉连接成功后的 this.client。
			this.opening = undefined;
		});
		// 并发首次调用拿到同一个 opening Promise，避免各启一个 stdio 子进程。
		return this.opening;
	}

	/** 调用一个远端工具并原样返回 MCP 结果；可能有写入副作用，不在普通暂时 HTTP 失败时重放。 */
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		// 通过闭包保存名称、参数和取消/超时选项；真正调用推迟到拿到客户端后。
		return this.withClient((client) => client.callTool(name, args, options));
	}

	/** 按 URI 读资源；readOnly=true 允许一次暂时 HTTP 错误重试，结果内容由上层转换。 */
	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
		// 传 true 使用只读请求的恢复策略，signal/timeout 随 options 继续下传。
		return this.withClient((client) => client.readResource(uri, options), true);
	}

	/** 列出指定 cursor 的一页资源，保留 nextCursor 给调用者继续分页；不是在这里拉全量。 */
	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult> {
		// 只读操作共享连接和恢复逻辑。
		return this.withClient((client) => client.listResourcesPage(cursor, options), true);
	}

	/** 获取一页资源模板；服务器不实现模板列表方法时降级为空页，其他异常继续传播。 */
	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult> {
		// 泛型 withClient 会从回调推断出这一页结果类型。
		return this.withClient(
			// 回调在 getClient 成功后执行。
			(client) =>
				// methodNotFound 才返回空 resourceTemplates；其他拒绝不会被当成“没有模板”。
				withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
			// 模板列表也是只读操作。
			true,
		);
	}

	/** 获取该服务器全部资源页，分页由 MCP client 完成；大列表可能耗时，不在连接握手时调用。 */
	allResources(options: McpRequestOptions): Promise<Resource[]> {
		// client.listResources 内部迭代 cursor，本方法只负责连接/恢复和参数传递。
		return this.withClient((client) => client.listResources(options), true);
	}

	/** 获取全部模板页，方法不存在时得到 []；请求选项继续传给内部分页请求。 */
	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
		// 包装后的 listTemplates 会做 methodNotFound 降级。
		return this.withClient((client) => listTemplates(client, options), true);
	}

	/**
	 * Run a request, reconnecting when needed. `readOnly` requests are retried once after a transient
	 * HTTP error; tool calls are not, since they may have run.
	 */
	/**
	 * 执行回调并按明确错误恢复：只读暂时 HTTP 错误等 250ms 再试一次；会话过期允许包括工具在内重建会话后再试一次。
	 * 两种情况共用 attempt 计数，总共最多执行回调两次。普通工具 HTTP 失败不重放，以免写操作执行两遍。
	 * getClient 在 try 外，建连失败用 open 的策略；这里不再套一层请求重试。等待不绑定请求 signal，第二次调用才由下层检查。
	 */
	private async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
		// 无条件循环依靠 return/throw/continue 控制；attempt 从 1 开始，只有第一次错误允许恢复。
		for (let attempt = 1; ; attempt++) {
			// 每轮重新取可用客户端；并发调用仍通过 opening 共享连接。
			const client = await this.getClient();
			try {
				// await 放在 try 里才能捕获 run 返回 Promise 的拒绝。
				return await run(client);
			} catch (error) {
				// 只有 McpHttpError 暂时错误且 readOnly 才进入；普通 TypeError 不走这条“请求重试”。
				if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
					// 这里是普通计时器等待，不可被 shutdown 或调用方 signal 提前打断，也不让旧客户端掉线。
					await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[0]));
					// continue 回到顶部；可能复用原连接，也可能因连接已断而重新建立。
					continue;
				}
				// 服务器忘记旧 session 时，MCP 协议错误表示该请求未执行，所以工具也允许重试。
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					// The server no longer knows the session (restart, deploy), so it did not run the request.
					// Retry once on a new session. The old client is detached but not closed: closing would
					// fail its other in-flight calls, which instead get the same 404 and retry the same way.
					// 只有仍是当前客户端才摘除它；不关闭旧实例，避免把它的其他在途请求立即打断。
					if (this.client === client) this.client = undefined;
					// 下一轮 getClient 负责拿/建新会话，此分支不额外等待 250ms。
					continue;
				}
				// 非认证错误直接原样抛出；重试耗尽也走这里，除非它本身属于需要登录的错误。
				if (!this.needsSignIn(error)) throw error;
				// 认证失败后丢弃连接，close 失败在 dropClient 内吞掉。
				await this.dropClient(client);
				// 清掉普通错误文字，状态换成需要登录并通知 UI。
				this.markNeedsAuth();
				// 向上抛用户可操作的登录指引，不自动打开浏览器。
				throw new Error(signInRequiredMessage(this.entry));
			}
		}
	}

	/** Connect again with fresh credentials, for example after signing in. */
	/** 登录完成后主动重连：等旧的建连结束 → 丢弃当前连接 → 建新连接；不会重置永久关闭信号。 */
	async reconnect(): Promise<void> {
		// 可选链表示没有 opening 就不等；有但失败时忽略该失败，仍继续重连。
		await this.opening?.catch(() => undefined);
		// 只关目前登记的客户端；工具表不在此行清空。
		if (this.client) await this.dropClient(this.client);
		// 等待新握手完成，失败会向调用方传播。
		await this.getClient();
	}

	/** Disconnect after the stored credentials were removed. */
	/** 断开并显示需登录状态；凭证删除由调用方先做，本方法本身不删除文件或撤销远端授权。 */
	async signOut(): Promise<void> {
		// 等待正在建立的连接结束，失败忽略，避免它随后又成为当前连接。
		await this.opening?.catch(() => undefined);
		// 有在线实例就丢弃并关闭。
		if (this.client) await this.dropClient(this.client);
		// 永久关闭对象不再被注销流程改回 needs-auth。
		if (!this.closed) this.markNeedsAuth();
	}

	/** OAuth servers that still reject the request after a refresh need the user to sign in again. */
	// unknown 错误在边界按类识别；独立 OAuth 的特定错误，或有提供者时的 MCP 认证错误，才转成登录提示。
	private needsSignIn(error: unknown): boolean {
		return (
			// 独立 OAuth 无法刷新/需要增权的专用错误。
			error instanceof McpOAuthAuthorizationRequiredError ||
			// 没有认证提供者时的 McpAuthRequiredError 不假装知道该用哪种登录方案。
			(this.authProvider !== undefined && error instanceof McpAuthRequiredError)
		);
	}

	// 统一写入需要登录状态并发通知；不在这里清工具、challenge 或 hasResources。
	private markNeedsAuth(): void {
		// 字面量值必须属于 ServerState 联合类型。
		this.state = "needs-auth";
		// 需要登录单独作为状态表达，清除之前的一般错误文字。
		this.error = undefined;
		// 通过可选回调让上层重新渲染/处理状态。
		this.changed();
	}

	// 集中触发可选状态回调；只是函数调用，没有防抖、排队或异常隔离。
	private changed(): void {
		// ?. 只在回调缺失时跳过，回调自身抛错仍会传播。
		this.onChange?.(this);
	}

	// 摘除指定客户端并尽力关闭；身份比较防止旧请求清掉新连接。关闭错误忽略，但会等待关闭 Promise 结束。
	private async dropClient(client: McpClient): Promise<void> {
		// 对象 === 比较实例身份，不比较连接参数是否相同。
		if (this.client === client) this.client = undefined;
		// catch 返回 undefined 把关闭失败转成正常完成。
		await client.close().catch(() => undefined);
	}

	// 运行完整建连尝试，HTTP 暂时错误最多试三次；每次新建客户端，最终统一记录失败/需登录状态。
	private async open(): Promise<McpClient> {
		// 即使上次 failed/disconnected，这次重新进入 connecting；不等于握手已经完成。
		this.state = "connecting";
		// 先通知连接开始。
		this.changed();
		// stdio 用空数组，因此首次失败就停止；HTTP 使用两个等待间隔。
		const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
		// attempt 从 0 开始，正好对应数组索引。
		for (let attempt = 0; ; attempt++) {
			// 清除上一轮 stderr，最终错误只带最近失败尝试的尾部。
			this.stderrTail = undefined;
			try {
				// 完整等单次创建、握手、工具发现成功，成功就跳出整个方法。
				return await this.connectOnce();
			} catch (error) {
				// 数组取不到下一项得到 undefined，表示重试额度耗尽。
				const delay = retries[attempt];
				// 关闭、次数耗尽或不可重试，任一满足就不再等。
				if (this.closed || delay === undefined || !isTransientError(error)) {
					// connectFailed 会更新状态，并返回带服务器名字的 Error 供抛出。
					throw this.connectFailed(error);
				}
				// promises 版 sleep 支持 AbortSignal；关闭时取消等待，catch 吞取消后由下一行统一报关闭失败。
				await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
				// 防止关闭过程中又启动一次连接。
				if (this.closed) throw this.connectFailed(error);
			}
		}
	}

	// 完成一次连接：创建 client → 订日志/关闭信号 → 创建传输并握手 → 发现工具 → 保存实例并通知上层；失败会关本次实例。
	private async connectOnce(): Promise<McpClient> {
		// 每次尝试新建 MCP client，不复用失败握手留下的协议状态。
		const client = new McpClient({
			// 向远端声明宿主名称 pi；它是协议客户端信息，不是工具命名空间。
			name: "pi",
			// 使用项目版本。
			version: VERSION,
			// 默认请求超时传入 client，具体单次调用仍可在 options 覆盖。
			requestTimeoutMs: this.timeoutMs,
			// 声明工作目录为一个 MCP root：pathToFileURL 正确转义路径，basename 只作为显示名；声明 root 本身不是文件系统沙箱。
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		// 取可选日志引用供下面通知回调闭包使用。
		const log = this.log;
		// 只订阅并写入服务器主动推送的日志；不会自动发送 logging/setLevel 请求。
		if (log) client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
		// Closing the client fails its pending initialize or discovery requests and closes the transport.
		// Memoized: a second `client.close()` returns before the first finished closing the transport.
		// 本次尝试自己的关闭 Promise，防止 abort 和 catch 同时触发时过早认为传输已关完。
		let closing: Promise<void> | undefined;
		// 局部箭头函数捕获本次 client，不会误关后来成功的新 client。
		const closeClient = () => {
			// 只发起一次关闭并等待同一个 Promise；关闭异常忽略。
			closing ??= client.close().catch(() => undefined);
			// 返回共享 Promise，让 catch 能等真实的首次关闭完成。
			return closing;
		};
		// 仅连接建立期间订阅关闭信号，once 在首次 abort 后移除监听；finally 也会做清理。
		this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
		// 先声明可能尚未创建成功的 transport；catch 需要据此判断是否读取 stdio 日志。
		let transport: McpTransport | undefined;
		try {
			// 调用注入工厂；默认实现此时解析配置值，但具体注入工厂可能有其他行为。
			transport = this.createTransport(this.entry, this.cwd, this.authProvider);
			// 启动传输并执行 MCP initialize 握手，可能启动子进程或发 HTTP；这里不是单纯构造。
			await client.connect(transport);
			// 握手后订阅服务器工具列表变更，后续重新获取工具定义。
			client.onNotification("notifications/tools/list_changed", () => {
				// void 表示不等待这次异步刷新；refreshTools 内处理请求失败，但上游回调抛错仍可能影响返回 Promise。
				void this.refreshTools(client);
			});
			// 用于读取标准错误尾部的具体传输类收窄；注入的其他传输不因此拥有 stderr。
			const stdio = transport instanceof StdioTransport ? transport : undefined;
			// 客户端断开后回调，闭包保留本次 client/stdio 传输身份。
			client.onClose(() => this.handleClientClose(client, stdio));
			// Servers without the tools capability (prompts or resources only) do not answer tools/list.
			// 只有声明 tools 能力才发现工具；仅提供资源/提示词的服务器也能正常连接。
			const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
			// await 期间可能被 close；关闭信号是并发状态，需要运行时判断。
			if (this.closed) throw new Error("shut down while connecting");
			// 握手后的工具发现期间也可能掉线，不能把断开的 client 标记为成功。
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			// 确认可用后才把实例登记为当前连接。
			this.client = client;
			// 保存这次发现的工具数组，不另做深拷贝。
			this.tools = tools;
			// 只检查能力字段是否存在，不在握手时列出资源。
			this.hasResources = client.serverCapabilities?.resources !== undefined;
			// 去掉服务器 instructions 首尾空白，空串转 undefined。
			this.instructions = client.instructions?.trim() || undefined;
			// 所有上述步骤完成才设置 connected。
			this.state = "connected";
			// 连接成功清掉之前的错误说明。
			this.error = undefined;
			// 让上层用当前工具重建注册；回调可抛错，抛出会进入 catch 并关闭本次 client。
			this.onTools(this);
			// 再通知状态变化。
			this.changed();
			// 把成功实例交给共享 opening 的所有等待者。
			return client;
		} catch (error) {
			// 无论工厂、握手、发现还是上游回调失败，都先关闭本次 client。
			await closeClient();
			// 只有标准 stdio 传输能按这个接口读取捕获日志。
			if (transport instanceof StdioTransport) {
				// trim 后取末 2000 个 UTF-16 代码单元；没有文字则不拼 stderr，不脱敏。
				this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
			}
			// 保留原错误供 open 决定重试/提示；不是在此改成成功。
			throw error;
		} finally {
			// 本轮连接过程结束，移除临时监听，避免已成功实例的关闭路径被重复订阅。
			this.shutdown.signal.removeEventListener("abort", closeClient);
		}
	}

	// 连接最终失败时更新展示状态并生成 Error；认证错误优先变登录提示，其他错误可带 stderr 尾部。
	private connectFailed(error: unknown): Error {
		// 已经永久关闭就不再转成 needs-auth。
		if (this.needsSignIn(error) && !this.closed) {
			// 设置需要登录并发通知。
			this.markNeedsAuth();
			// 返回新 Error，丢掉原错误的具体类；下游看到的是可操作文字。
			return new Error(signInRequiredMessage(this.entry));
		}
		// 按永久关闭信号选 closed，否则 failed。
		this.state = this.closed ? "closed" : "failed";
		// 有 stderr 就加一行；这些文字可能包含服务器输出和敏感信息，本方法没有过滤。
		this.error = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
		// 通知上层读取最新 state/error。
		this.changed();
		// 给异常加上服务器名称，不在这里抛出，由 open 的 throw 执行。
		return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
	}

	/** The transport dropped. The next call reconnects; until then the status shows why. */
	// 传输关闭回调：只有当前实例且宿主未关闭才标断线，后续请求再重连；不立刻自动重连。
	private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
		// 忽略旧实例迟到的关闭通知，也不覆盖显式 close 的状态。
		if (this.client !== client || this.closed) return;
		// 清掉登记实例，下次 getClient 才会新建连接。
		this.client = undefined;
		// disconnected 区分已连接后掉线与首次建连 failed。
		this.state = "disconnected";
		// stdio 可取最近 stderr；?. 让其他传输没有日志时得到 undefined。
		const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
		// 保留断线原因供 UI，工具列表/能力标记此处不清空。
		this.error = stderr ? `Connection closed\n${stderr}` : "Connection closed";
		// 同步通知状态变化。
		this.changed();
	}

	// 响应 tools/list_changed 再发现工具；过期成功回复被忽略，但失败分支仍会写 error，且多次刷新没有序号防止先发后到覆盖。
	private async refreshTools(client: McpClient): Promise<void> {
		try {
			// 向触发通知的那个 client 重新拉全工具列表。
			const tools = await client.listTools();
			// 异步等待后再比较身份和关闭状态，成功结果不会覆盖新连接。
			if (this.client !== client || this.closed) return;
			// 替换已发现工具表。
			this.tools = tools;
			// 通知上层重新注册工具；此回调若抛错也进入下方 catch。
			this.onTools(this);
		} catch (error) {
			// 记录失败说明，不将 state 改为 failed；本分支没有 client 身份/closed 检查。
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		}
		// 成功/失败都通知状态；成功也没有在这里清除旧 error。
		this.changed();
	}

	/** Resolves once no transport of this server is open, including one that was still connecting. */
	/** 永久关闭此连接对象，取消连接等待并尽力关闭当前/正在建立的传输，再等本对象正在刷新的凭证保存；不撤销远端授权。 */
	async close(): Promise<void> {
		// abort 触发连接期监听和可取消重试等待；不意味着所有已发出的远端操作立即停止。
		this.shutdown.abort();
		// 立即对外标记 closed，不等网络/进程清理完成。
		this.state = "closed";
		// 通知 UI 关闭状态。
		this.changed();
		// 先保存本次要关闭的实例，随后摘除，防止它的 onClose 改成 disconnected。
		const client = this.client;
		// 允许重复调用 close 时不再次取到同一登记实例；没有单独缓存整个 close Promise。
		this.client = undefined;
		// 并行等待当前客户端关闭和正在建连的流程落定，忽略两者拒绝；可选链产生的 undefined 由 Promise.all 当普通值处理。
		await Promise.all([client?.close().catch(() => undefined), this.opening?.catch(() => undefined)]);
		// A refresh the server already answered may have rotated the refresh token; exiting before the
		// new tokens are saved would lose the grant.
		// 等待当前认证提供者正在进行的刷新，避免轮换 refresh token 已到服务端却没写盘；不是等未来可能新启动的刷新或别的连接对象。
		await this.authProvider?.settled();
	}
}
