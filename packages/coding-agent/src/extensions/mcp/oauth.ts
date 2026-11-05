/**
 * OAuth sign-in for remote MCP servers.
 *
 * Connections never start a browser flow on their own. They send the stored access token and, after
 * a 401, try the stored refresh token. When that is not possible they fail with
 * `McpOAuthAuthorizationRequiredError`, and the user signs in through `/mcp`, which runs
 * the authorization code flow (PKCE, a Client ID Metadata Document or dynamic client registration)
 * against a loopback callback.
 *
 * Credentials live in `<agent-dir>/mcp-auth.json`, keyed by server name and URL.
 */

// 远端 MCP 的独立 OAuth：平常取已存 access token，必要时刷新；只有显式登录才运行授权页面/回调流程。
// 上游 runtime.ts 建连接并创建认证提供者，CLI/扩展显式调用 signInMcpServer；凭证默认落在 agent 目录 mcp-auth.json，不是模型提供商的 auth.json。
// 例：三个请求同时收到旧 access-1 的 401 → 同一个提供者共享一次刷新 → 文件锁内再读凭证 → 保存 access-2 → 后续取新令牌。
// crypto 算摘要用于命名，fs/path 处理目录；摘要不是把 token 加密，凭证内容仍由存储后端保存。
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
// 成功/失败页面由共享 HTML helper 生成；这里只供本机 OAuth 回调显示，不是模型回复。
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
// 纯类型 import 不产生运行时代码；McpFetch 接收字符串或 URL、可选 RequestInit，返回 Promise<Response>。
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
// OAuth 流、提供者和本机回调服务来自 MCP 包；type 前缀只导入类型，其余是实际调用的函数/类。
import {
	type AuthorizationServerMetadata,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthChallenge,
	type OAuthClientInformationMixed,
	type OAuthClientMetadataDocument,
	parseWwwAuthenticate,
	stepUpScope,
} from "@earendil-works/pi-mcp/oauth";
// proper-lockfile 用 .lock 目录和定时更新 mtime 实现跨进程互斥；这里核对的是已安装库的实现，不能把“锁文件”理解为凭证本身。
import lockfile from "proper-lockfile";
// APP_NAME 控制客户端显示/默认文档策略；getAgentDir 解析项目统一的 agent 存储目录。
import { APP_NAME, getAgentDir } from "../../config.ts";
// 后端 withLock 保护凭证内容的读改写；另一个 refresh 锁要跨越联网过程，避免轮换同一 refresh token 两次。
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
// 名称归一化用于隔离服务器凭证；回调白名单辅助只决定能否使用 pi 的客户端文档，不代表整套 URL 校验。
import { isClientMetadataDocumentCallback, mcpNamespace } from "../../core/mcp-servers.ts";

// 默认监听 IPv4 本机回环地址；不是监听所有网卡。
const CALLBACK_HOST = "127.0.0.1";
// 默认授权回调路径，普通回调和服务器专有路径都由本机 HTTP 服务接收。
const CALLBACK_PATH = "/callback";
/** Where pi.dev serves pi's Client ID Metadata Documents: `client.json` and `<callback ID>/client.json`. */
// 客户端元数据文档 URL 是公开客户端标识，不是 access token；支持文档的授权服务器可用它替代动态注册。
const CLIENT_METADATA_BASE_URL = "https://pi.dev/oauth";
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
// 仅用于没有登记回调地址的刷新配置；刷新路径 onRedirect 是空回调，不自动打开浏览器。
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Access tokens this close to expiry are refreshed before they are sent. */
// 到期前 30 秒尝试预刷新；不保证一定成功，也不在没有 refresh_token 时阻止返回旧 access token。
const REFRESH_SKEW_MS = 30_000;
/**
 * Bounds each request to the authorization server, so an unresponsive one cannot hold the refresh lock,
 * delay shutdown, or keep a sign-in waiting for long.
 */
// 每次 fetch 增加 15 秒取消信号；不是整个授权流程/锁持有的总期限，自定义 fetch 不配合信号时也没有硬终止保证。
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
/** A refresh lock that its holder stopped renewing (the process was killed) is taken over after this. */
// 20 秒未续期视为过期；持锁过程中正常定时续期，所以不是拿锁 20 秒后必然释放。
const REFRESH_LOCK_STALE_MS = 20_000;
/** How long to wait for another process's refresh: longer than a stale lock lives. */
// 250 次固定 100ms 的重试等待预算约 25 秒，另有文件系统/调度耗时，不能当精确墙钟时限。
const REFRESH_LOCK_WAIT_MS = 25_000;
// 没有指数退避：每次冲突等待同一间隔。
const REFRESH_LOCK_RETRY_MS = 100;

/** OAuth 运行设置；已通过上游配置边界，secret 已解析，不在这个 interface 内做运行时校验。 */
export interface McpOAuthSettings {
	// 可省略字段 ? 表示未配置；预注册 clientId 与动态注册得到的 clientInformation 是不同来源。
	clientId?: string;
	/** Already resolved. */
	// 实际 secret 字符串，不再是 ! 命令/环境变量表达式；不等于已经通过服务器认证。
	clientSecret?: string;
	// 可固定监听端口；不填时尽量复用已注册端口，否则选空闲端口。
	callbackPort?: number;
	/** Loopback redirect URI; see `McpOAuthConfig.callbackUrl`. */
	// 对外发送的回调 URL 可能使用 localhost，实际监听地址可为 127.0.0.1。
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. */
	// scope 是权限名列表，空格分隔，例如 issues:read issues:write。
	scope?: string;
	/** `client_name` for dynamic client registration. Default: `APP_NAME`. */
	// 动态注册的显示名称，缺省由 APP_NAME 提供。
	clientName?: string;
	/** See `McpOAuthConfig.clientRegistration`. */
	// 字符串联合限定三种策略：自动选择、动态注册、客户端 ID 元数据文档；类型本身不会替运行输入填默认值。
	clientRegistration?: "auto" | "dcr" | "cimd";
	/** See `McpOAuthConfig.authServerMetadataUrl`. */
	// 这里接收已构造的 URL 对象，可覆盖自动发现的授权服务器元数据地址。
	authServerMetadataUrl?: URL;
}

/** Where the loopback callback server listens and the redirect URI it serves. */
// 内部解析结果：把真正监听的位置与发给授权服务器的字符串分开。
interface CallbackSettings {
	/** Address to listen on. */
	// TCP 监听地址，IPv6 方括号会在解析阶段移掉。
	host: string;
	/** Host name in the redirect URI. */
	// 回调 URL 中的主机文字，可能与监听地址的写法不同。
	redirectHost: string;
	// | undefined 允许值为空，但字段在这个返回对象中仍要存在；不是 ? 可省略字段。
	port: number | undefined;
	// 接收回调的路径，不包括查询参数。
	path: string;
	/** The exact redirect URI, when the port is fixed. */
	// 有固定端口时使用的回调完整字符串，否则等待监听成功后由服务生成。
	fixedRedirectUrl: string | undefined;
}

// 把设置拆成监听参数；例 http://localhost:8080/callback 会监听 127.0.0.1:8080，对外回调仍用 localhost。可能因 URL 无效抛错，不做全套策略校验。
function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
	// ?? 只在没有 callbackUrl 时取默认；new URL 同时规范化主机/默认端口等内容。
	const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
	// 移除 IPv6 hostname 外的方括号；g 允许两端都替换，正则的两个分支分别匹配起点左括号和终点右括号。
	const address = url.hostname.replace(/^\[|\]$/g, "");
	// URL 解析后非空的 port 优先于独立 callbackPort；默认端口被 URL 规范化为空时会走后者。
	const port = url.port ? Number(url.port) : settings.callbackPort;
	// let 声明稍后可能赋值的结果，未赋时为 undefined。
	let fixedRedirectUrl: string | undefined;
	// A configured URI with a port is sent exactly as written, since servers compare it as a string.
	// 只要解析后的 URL.port 非空，就保留配置 URL 原字符串，避免改变服务器按字符串登记的值。
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	// 否则有 callbackPort 才补端口；没有就保持非固定回调。
	else if (port !== undefined) {
		// URL.port 的 setter 处理字符串端口，已有上游策略约束，不在此再校验。
		url.port = String(port);
		// 用规范化后的 href 生成固定地址。
		fixedRedirectUrl = url.href;
	}
	// 返回监听和对外地址所需字段的新对象。
	return {
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		// localhost 特判成 IPv4 回环；其他地址直接传下去，这一行不是 loopback 白名单。
		host: address === "localhost" ? CALLBACK_HOST : address,
		// URL 里的 host 仍使用 address 写法；IPv6 方括号在回调服务生成 URL 时补回。
		redirectHost: address,
		// 属性简写等于 port: port。
		port,
		// 只取路径，回调服务生成的动态 URL 不自动保留配置中的 search/hash。
		path: url.pathname,
		// 可能是原配置地址，也可能是补端口的地址或 undefined。
		fixedRedirectUrl,
	};
}

/** Scopes of both lists, each once. */
// 合并任意多份 scope 并去重，保持首次出现顺序。例 "read write" 和 "write admin" 得到 "read write admin"；全空返回 undefined。
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	// ...scopes 是剩余参数数组；flatMap 拆空白并扁平化，filter(Boolean) 去空串，Set 去重，再用展开语法变回数组。
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	// 非空数组用一个空格拼回字符串，没有权限名则不用空串伪装有效值。
	return merged.length > 0 ? merged.join(" ") : undefined;
}

// Record 约定磁盘 JSON 根对象按键存状态；这是 TS 声明，不保证文件内容已逐字段检查。
type StoredStates = Record<string, McpOAuthState>;

// 读取凭证 JSON 的边界：空文本返回空表，合法 JSON 的非数组对象做类型断言；语法错误仍抛出，状态内部结构不逐项校验。
function parseStates(content: string | undefined): StoredStates {
	// 可选链和 trim 识别 undefined/空白文件；没有为不存在文件在这里创建内容。
	if (!content?.trim()) return {};
	// 把不可信 JSON 先放 unknown，JSON.parse 可同步抛 SyntaxError。
	const parsed: unknown = JSON.parse(content);
	// 只筛根形状；as StoredStates 不验证 token/URL/过期时间字段，不能将断言解释成解码器。
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
}

// 将状态表写成两空格缩进的 JSON 并补 LF；没有加密或脱敏，循环引用等序列化错误可抛出。
function serializeStates(states: StoredStates): string {
	// 模板中的反斜杠 n 产生一个换行；JSON.stringify 的第二个参数 null 表示不用替换器。
	return `${JSON.stringify(states, null, 2)}\n`;
}

/**
 * Keys of a server's state: by name and URL, so servers sharing a URL keep separate accounts, and the
 * legacy key by URL alone, written by older versions.
 */
// 生成新旧两个存储键：新键含归一化名称和规范化 URL，旧键只有 URL。例 work/personal 共用地址时新键分开，但 work-test 与 work_test 归到同一命名空间。
function storeKeys(name: string, serverUrl: string): { key: string; legacyKey: string } {
	// URL 构造可抛错；规范化不去 hash，和下面 callbackId 主动清 hash 的规则不同。
	const legacyKey = String(new URL(serverUrl));
	// 对象返回值中 key 显式计算，legacyKey 用简写；键名本身不包含凭证。
	return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey };
}

/** 扩展基础 load/save 接口，额外提供覆盖整个异步刷新过程的互斥入口；实际是否有跨进程锁取决于构造设置。 */
export interface McpOAuthServerStore extends McpOAuthStateStore {
	/** Run `fn` while no other process refreshes the server's tokens. */
	// 方法级泛型 T 保留回调返回类型，Promise<T> 不表示回调必然成功；锁不可用时会拒绝。
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Per-server OAuth state (client registration, tokens, pending PKCE verifier) in `mcp-auth.json`. */
/** 按名称和 URL 存取 MCP OAuth 状态，支持旧 URL 键按首次加载迁移；不负责远端注销或验证 token 真伪。 */
export class McpOAuthCredentialStore {
	// readonly 只限制重赋后端引用；后端内容当然仍会更新。
	private readonly backend: AuthStorageBackend;
	/** Directory for the refresh lock files. Without one, refreshes are only serialized in this process. */
	// 没设置 lockDir 就不加跨进程刷新锁；同一 createMcpAuthProvider 自己共享 Promise，但不同提供者也不会因此自动串行。
	private readonly lockDir: string | undefined;

	/** 默认用 agent 目录的文件后端与刷新锁；注入后端时，刷新锁目录只采用显式 lockDir，不自行补默认。 */
	constructor(backend?: AuthStorageBackend, lockDir?: string) {
		// ?? 没给 backend 才创建文件后端；创建后端对象不立即读取/写入凭证。
		this.backend = backend ?? new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json"));
		// 有自定义 backend 则按调用者的 lockDir；没有 backend 时忽略传来的第二参数，固定用 getAgentDir。
		this.lockDir = backend ? lockDir : getAgentDir();
	}

	/** 返回一台服务器的 load/save/withRefreshLock 闭包；此时只计算键，不立即读盘。load 首次可迁移旧键并写盘。 */
	forServer(name: string, serverUrl: string): McpOAuthServerStore {
		// 闭包捕获两个键，后续同一接口始终访问这组名称+URL。
		const { key, legacyKey } = storeKeys(name, serverUrl);
		// 每次 forServer 创建新接口对象，不是复用全局缓存。
		return {
			// The first server to load legacy state takes it over; others with the same URL sign in again.
			// load 是箭头属性，后端允许同步返回结果，接口也允许 Promise；调用方一般统一 await。
			load: () =>
				// withLock 把读、判断、迁移和写作为同一次后端临界区。
				this.backend.withLock((current) => {
					// 解析当前完整文件，语法错误直接传出；不改成静默丢失凭证。
					const states = parseStates(current);
					// 新键有 truthy 状态就用新键；旧键没有 truthy 状态则不迁移，注意这里是普通对象索引。
					if (states[key] || !states[legacyKey]) return { result: states[key] };
					// 把同一旧状态放到新键，不重新申请 token，也不在此深复制状态。
					states[key] = states[legacyKey];
					// 删除旧 URL 键，后来的另一个名称不再取得这份旧账号。
					delete states[legacyKey];
					// result 给调用者，next 通知后端写新文件；同时返回与写入不等于文件系统跨服务事务。
					return { result: states[key], next: serializeStates(states) };
				}),
			// save 只替换本服务器状态，其他键由 write 的读改写保留。
			save: (state) =>
				// 传更新回调，让 write 在后端锁内读取最新整表。
				this.write((states) => {
					// 完整状态赋到本键，不是按内部 token 字段逐项合并；旧键不在这里删除。
					states[key] = state;
				}),
			// 刷新锁只覆盖调用方主动包在 fn 内的工作；并不自动把任何独立 signIn 调用也纳入同一锁。
			withRefreshLock: (fn) => this.withRefreshLock(key, fn),
		};
	}

	/**
	 * A lock file per server. When the process exits, proper-lockfile removes the locks it holds; when
	 * it is killed, the lock goes stale because it is no longer renewed, and the next process takes it over.
	 */
	// 围住 fn 的跨进程刷新锁，覆盖读旧令牌、联网刷新和保存新令牌；失败时也释放。锁目录由摘要命名，不是靠 hash 加密凭证。
	private async withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		// 没有锁目录就直接执行 fn，不同 store/provider 在此没有全局进程内排队。
		if (!this.lockDir) return fn();
		// 递归建目录，0700 是新建时的权限请求，不会强制修正已有目录权限，Windows 也有平台差异。
		mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
		// SHA-256 截前 16 个十六进制字符作短文件名；不是无碰撞证明，也不包含明文令牌。
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		// 库会使用带 .lock 后缀的目录，不要求这个不带后缀的目标文件实际存在。
		const release = await lockfile.lock(join(this.lockDir, `mcp-auth-refresh-${hash}`), {
			// 不做 realpath，便于对尚不存在的命名目标加锁；仍会在库内 resolve 路径。
			realpath: false,
			// 正常持锁会定期续期；20 秒是未续期判断阈值，不是 fn 的执行时间上限。
			stale: REFRESH_LOCK_STALE_MS,
			// 冲突重试配置，只有拿锁阶段使用，fn 自身的业务失败不在这里重新执行。
			retries: {
				// 250 次重试再加初次尝试，固定等待约 25 秒；文件系统与事件循环耗时另计。
				retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
				// factor=1 表示不做指数增长。
				factor: 1,
				// 最短间隔 100ms。
				minTimeout: REFRESH_LOCK_RETRY_MS,
				// 最长也 100ms，和上面共同固定间隔。
				maxTimeout: REFRESH_LOCK_RETRY_MS,
			},
			// The default throws from a timer. A lost lock at worst lets two refreshes overlap.
			// 锁失效时空回调避免库的定时器直接抛错；fn 不会被取消，可能与其他刷新重叠，因此不是无条件互斥保证。
			onCompromised: () => {},
		});
		// 拿锁成功后才进入 try，获取锁失败不会运行 fn，也没有 release 可调用。
		try {
			// await 必须放在 try 内，让 finally 等业务结束后再释放，而不是刚返回 Promise 就释放。
			return await fn();
		} finally {
			// 业务成功/失败都尝试释放；释放错误忽略，原 fn 的成功值或异常继续返回。
			await release().catch(() => undefined);
		}
	}

	/** The stored tokens of a server, for noticing sign-ins done by another process. Does not take over legacy state. */
	/** 只读取当前 token 字段，不抢占旧 URL 键；用于发现其他进程完成的登录，返回值不代表 token 已被远端接受。 */
	tokens(name: string, serverUrl: string): McpOAuthState["tokens"] {
		// 和 load 使用同一键规范化规则。
		const { key, legacyKey } = storeKeys(name, serverUrl);
		// 后端锁内读整表，不提供 next，因此本方法不主动要求写入/迁移；文件后端本身可能做初始化。
		const states = this.backend.withLock((current) => ({ result: parseStates(current) }));
		// 新键 null/undefined 才落旧键，和 load 的 truthy 判断略有差异；可选链容许完全没有状态。
		return (states[key] ?? states[legacyKey])?.tokens;
	}

	/** Returns whether credentials were stored for the server. Removes legacy state the server would take over. */
	/** 删除本地一份新键状态，或没有新键时删除旧键；两份同时存在只删新键，不撤销授权服务器上的 grant。 */
	remove(name: string, serverUrl: string): boolean {
		// 准备规范化键，URL 无效可抛错。
		const { key, legacyKey } = storeKeys(name, serverUrl);
		// 删除和写回都在一次后端锁内，避免读改写覆盖别的服务器。
		return this.backend.withLock((current) => {
			// 解析文件，坏 JSON 不在这里吞掉。
			const states = parseStates(current);
			// in 包含原型链，不过这些键带命名空间/规范化 URL；两种键同时存在时优先选择新键。
			const stored = key in states ? key : legacyKey in states ? legacyKey : undefined;
			// 没有任何选中键则返回 false，省略 next，不要求重写文件。
			if (!stored) return { result: false };
			// delete 删除所选属性，不会帮用户到远端撤销 token。
			delete states[stored];
			// 返回 true 并写整表；不遍历清除所有同 URL 的其他账户。
			return { result: true, next: serializeStates(states) };
		});
	}

	// 内部读改写工具：update 在后端锁内改整表，再统一序列化；回调或序列化出错时不返回 next。
	private write(update: (states: StoredStates) => void): void {
		// withLock 是后端协议；同步文件后端会持自己的文件锁，不等同于上面的长期刷新锁。
		this.backend.withLock((current) => {
			// 先读最新状态，保留其他服务器的数据。
			const states = parseStates(current);
			// 允许回调原地修改这个解析结果。
			update(states);
			// 调用方不需要结果，result 为 undefined；next 是要写的完整新 JSON 文本。
			return { result: undefined, next: serializeStates(states) };
		});
	}
}

/** `fetch` with `OAUTH_REQUEST_TIMEOUT_MS` per request, on top of the request's own signal. */
// 包装 fetch 为“每次请求额外 15 秒取消信号”；例原调用已带用户取消，则任一信号取消都能使遵守信号的 fetch 中止。
function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	// 返回闭包，创建包装器时不启动请求或计时器；默认参数在创建包装器时取得 globalThis.fetch。
	return (input, init) => {
		// 每次调用才新建 timeout；这是请求级时间，不给整个多请求授权流程总计时。
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		// ...init 保留 method/body 等，后写 signal 覆盖原字段为组合信号；没有原 signal 时直接用 timeout。
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

// 从完整动态注册信息取回调列表；仅有 client_id 的精简信息没有该字段，返回空数组。
function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	// in 在这里收窄 OAuthClientInformationMixed 联合类型，不重新解析/复制数组，也不验证地址。
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

/** 12 characters identifying an MCP server URL in callback paths, computed like Codex does. */
// 按去掉 hash 的规范化服务器 URL 算回调 ID：SHA-256 前 9 字节转 base64url，固定 12 字符；这是区分地址的短标识，不是密码或碰撞绝对保证。
function callbackId(serverUrl: string): string {
	// 先 URL 解析归一化，错误会传播。
	const url = new URL(serverUrl);
	// fragment 不发给 HTTP 服务，这个 ID 规则显式去除它；凭证 storeKeys 的规则却保留它。
	url.hash = "";
	// subarray 是字节视图，截的 9 字节不是 9 个十六进制字符；base64url 避免 + 和 / 进入路径。
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

/**
 * Whether sign-in may identify with pi's Client ID Metadata Document instead of registering. `auto`
 * registers when the user asked for a client name, the redirect URI is not one the documents list, or
 * a rebranded build would show up as pi.
 */
// 先判断本地策略是否愿意使用 pi 的客户端文档；不在此证明授权服务器支持它，后面还要看 metadata。
function offersClientMetadataDocument(settings: McpOAuthSettings): boolean {
	// 未配置按 auto；空字符串不是类型允许的取值，类型内正常调用只会是三种字面量之一。
	const registration = settings.clientRegistration ?? "auto";
	// 显式 cimd 允许尝试文档，dcr 不允许；这条在后面的客户端名称/回调限制之前。
	if (registration !== "auto") return registration === "cimd";
	// 自动模式有预注册 ID、自定义显示名或重品牌构建时不借用默认 pi 文档。
	if (settings.clientId || settings.clientName || APP_NAME !== "pi") return false;
	// 自动模式还要满足默认文档支持的回调形式，实际规则看配置 helper，不是任意 loopback 都行。
	return isClientMetadataDocumentCallback(settings.callbackUrl);
}

/**
 * pi's Client ID Metadata Document, chosen like Codex chooses its own, or `undefined` when the
 * authorization server does not support documents for public clients. Without the `iss` parameter in
 * authorization responses (RFC 9207), the redirect URI and the document are specific to the MCP server,
 * so a response cannot be mixed up with one from another authorization server (RFC 9700 section 4.4.2.2).
 */
// 按服务器元数据选择文档；支持公开客户端文档且支持 none 认证方法才返回。若授权响应无 iss，用服务器专有回调路径区分来源。
function clientMetadataDocument(
	// serverUrl 只用于生成专有 ID，不是要在这个函数里发请求。
	serverUrl: string,
	// 当前本机实际回调 URL，可能带动态端口。
	redirectUrl: string,
	// metadata 可缺失，这时不能假定文档能力。
	metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument | undefined {
	if (
		// 可选链先挡住没有元数据或未声明文档支持的情况。
		!metadata?.client_id_metadata_document_supported ||
		// 还必须显式包含 none；缺整个列表也按不支持处理。
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		// 不能用文档就返回 undefined，由调用方决定自动降级注册还是报错。
		return undefined;
	}
	// 授权响应承诺包含 iss 时可共用默认文档/路径；iss 的实际比较在 authorizeMcp 内。
	if (metadata.authorization_response_iss_parameter_supported) {
		// 返回普通文档 URL 和现有回调，不在这里下载/保存文档。
		return { url: `${CLIENT_METADATA_BASE_URL}/client.json`, redirectUrl };
	}
	// 无 iss 支持时用服务器专属 ID。
	const id = callbackId(serverUrl);
	// 复制成独立 URL 对象，避免修改输入字符串代表的其他状态。
	const redirect = new URL(redirectUrl);
	// 路径强制变成 /callback/ID；保留该 URL 的其他部分。
	redirect.pathname = `${CALLBACK_PATH}/${id}`;
	// 文档和回调采用相同 ID，降低授权响应混用的风险；仍需 state/PKCE 等检查配合。
	return { url: `${CLIENT_METADATA_BASE_URL}/${id}/client.json`, redirectUrl: redirect.href };
}

// 构造 OAuth 状态提供者；流程以后才发现服务器、注册、刷新/换码。onRedirect 是通知回调，不默认开浏览器。
function createProvider(
	// 提供者按这个精确规范化 URL 隔离存储状态。
	serverUrl: string,
	// 注入 load/save，可为持久文件或测试内存。
	store: McpOAuthStateStore,
	// 设置中的 secret 已解析。
	settings: McpOAuthSettings,
	// 当前回调字符串供动态注册和换码使用。
	redirectUrl: string,
	// 函数类型输入 URL、返回 void；实际登录会把 URL 记下来，后台刷新用空函数。
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	// new 只创建提供者并保存参数，真正联网由 authorizeMcp 驱动。
	return new McpOAuthProvider({
		// 属性简写直接沿用参数。
		serverUrl,
		// 提供者需要回调信息，即使本次只刷新而不跳浏览器。
		redirectUrl,
		// 显示名用 ??，显式空字符串不会自动退到 APP_NAME。
		clientMetadata: { client_name: settings.clientName ?? APP_NAME },
		// 只有本地策略允许时才传文档选择回调。
		clientMetadataDocument: offersClientMetadataDocument(settings)
			? // SDK 在没有存储/显式客户端信息时才用这个回调，不是在本行立即执行。
				(metadata) => {
					// 根据那次发现的真实元数据选择共享/专有文档。
					const document = clientMetadataDocument(serverUrl, redirectUrl, metadata);
					// 显式 cimd 不允许悄悄退回动态注册。
					if (!document && settings.clientRegistration === "cimd") {
						// 抛明确配置错误，由授权流程/调用方接收。
						throw new Error(
							'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
						);
					}
					// auto 不支持时返回 undefined，底层可以动态注册。
					return document;
				}
			: // 没有回调就不尝试文档方案。
				undefined,
		// 已有 clientId 时 SDK 使用配置客户端，不需要动态注册。
		clientId: settings.clientId,
		// secret 原样交给提供者，由 SDK 决定客户端认证方式。
		clientSecret: settings.clientSecret,
		// 同一服务器状态接口，用于读写 client/tokens/verifier 等。
		store,
		// 授权 URL 生成后才调用的回调。
		onRedirect,
	});
}

/** 在标准 token/onUnauthorized 接口上增加等待当前刷新落盘的入口，供连接关闭使用。 */
export interface McpAuthProvider extends AuthProvider {
	/** Resolves when no refresh is running, so shutdown does not drop rotated tokens before they are saved. */
	// 只等待本提供者当时已有的刷新，吞其失败；不是阻止未来刷新或等待全部进程。
	settled(): Promise<void>;
}

/**
 * Auth provider for MCP connections: sends the stored access token and refreshes it when it is about
 * to expire or after a 401. Throws `McpOAuthAuthorizationRequiredError` when the user has to sign in,
 * including when the server asks for more scope (`insufficient_scope`). `onChallenge` receives the
 * server's `WWW-Authenticate` challenge so sign-in can use its resource metadata URL and scope.
 * `settings` is only called when a refresh is needed, so a secret that fails to resolve fails the
 * refresh instead of the whole connection setup.
 *
 * Many servers rotate refresh tokens, so two refreshes with the same refresh token lose the grant.
 * Requests in this process share one refresh, and other processes are kept out by the store's
 * refresh lock, held from reading the tokens to saving new ones. Tokens that changed meanwhile
 * (another process refreshed them, or the user signed in) are used without refreshing.
 */
/**
 * 创建按请求供令牌/刷新的一组闭包，构造本身不读凭证或联网。token 在临近过期时尽力刷新，401 时按挑战刷新或提示重登。
 * 同一返回对象共享 refreshing；跨对象/进程依赖 store 的刷新锁，没配置锁目录则无跨对象互斥。
 * 例：access-1 被拒绝，拿锁后发现磁盘已有 access-2，就不再次使用旧 refresh token。此处不自动打开浏览器。
 */
export function createMcpAuthProvider(options: {
	// 确切服务器 URL，和 store 指向同一服务器。
	serverUrl: string;
	// 具有 load/save/withRefreshLock 的接口。
	store: McpOAuthServerStore;
	// 延迟读取设置，secret 解析失败只在确实要刷新时暴露。
	settings: () => McpOAuthSettings;
	// 把最新挑战送回连接对象，便于显式登录复用。
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	// 解构留下常用参数；其余回调通过 options 引用。
	const { serverUrl, store } = options;
	// 局部共享中的刷新 Promise；不放在模块全局，两个提供者有各自的值。
	let refreshing: Promise<void> | undefined;

	/** Replace `staleToken`, the access token that expired or was rejected. */
	// 尝试替换被拒绝/过期 token；可注入 fetch 和挑战。并发调用复用当前 Promise，后来调用不会把新 challenge/fetch 改进已启动流程。
	const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		// ??= 只有当前没有刷新时才建立整个锁内流程。
		refreshing ??= store
			// 锁覆盖加载最新状态、刷新请求和存储，不只保护文件写入的一瞬间。
			.withRefreshLock(async () => {
				// 拿锁后再次读；等锁时别的进程可能已把 token 换掉。
				const state = await store.load();
				// 当前 token 与本次失败 token 不同就退出刷新；包括当前已被删为 undefined 的情况，不保证一定存在一个可用新 token。
				if (state?.tokens?.access_token !== staleToken) return;
				// 没有 refresh_token 就要求显式登录，不尝试凭空获取访问令牌。
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				// 现在才读取/解析设置，可能因 secret 配置失败而拒绝刷新。
				const settings = options.settings();
				// 刷新需要提供 redirect 配置，按固定设置 → 首个已注册地址 → 默认回退选择。
				const redirectUrl =
					// 只有配置能确定固定 URL 时优先使用；不会为后台刷新启动回调 HTTP 服务。
					callbackSettings(settings).fixedRedirectUrl ??
					// 其次借用已动态登记过的回调地址。
					registeredRedirectUrls(state.clientInformation)[0] ??
					// 最后用不带端口的默认地址；后台刷新不真的让浏览器跳过去。
					FALLBACK_REDIRECT_URL;
				// onRedirect 空回调，SDK 若决定必须浏览器授权，只记状态/返回 REDIRECT，不自动开页面。
				const provider = createProvider(serverUrl, store, settings, redirectUrl, () => {});
				// Refreshes the tokens, or reports that a new sign-in is needed. Not cancellable: a refresh the
				// server answered may have rotated the refresh token, so its answer must be saved.
				// 调用通用授权流，优先尝试已存 refresh token；单次 fetch 有时间信号，但不传调用者取消信号，避免轮换结果没保存。
				const result = await authorizeMcp(provider, {
					// 目标 MCP 地址用于发现资源对应的授权服务器。
					serverUrl,
					// 挑战可能指定资源元数据位置。
					resourceMetadataUrl: challenge?.resourceMetadataUrl,
					// 显式授权服务器元数据 URL 可覆盖自动发现。
					authorizationServerMetadataUrl: settings.authServerMetadataUrl,
					// 普通挑战 scope；增权错误在 onUnauthorized 提前拒绝，不把刷新误当成授予新权限。
					scope: challenge?.scope,
					// 包装注入 fetch，为本流程每个请求加超时。
					fetch: timedFetch(fetch),
				});
				// 需要浏览器就转“必须登录”的错误；可能已写发现/PKCE等状态，但不会在这里展示登录页面。
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})
			// 不论成功失败都清刷新标记，未来请求可再尝试。
			.finally(() => {
				// 清的是 Promise 标记，不删除凭证。
				refreshing = undefined;
			});
		// 所有并发等待者看到同一次结果/异常。
		return refreshing;
	};

	// 返回适配标准 HTTP 认证接口的对象；方法执行时才读取 token。
	return {
		/** 获取下一次请求的 access token；预刷新失败尽量仍读当前存储，最终认证失败由远端响应决定。 */
		token: async () => {
			// 先等本对象已经在进行的刷新，失败忽略；不与另一个对象共享这条 Promise。
			await refreshing?.catch(() => undefined);
			// 每次重新 load，使外部登录/刷新能被看见，load 也可能迁移旧键。
			const state = await store.load();
			// 可选链安全取得可能不存在的 token。
			const token = state?.tokens?.access_token;
			// 有过期时间才比较“到期前30秒”；不是验证 token 格式/签名。
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			// 未临近到期或根本没有 refresh_token，就直接返回当前 token（即使它已过期）；后续请求可触发 401。
			if (!expired || !state?.tokens?.refresh_token) return token;
			// Failures fall through: the request goes out with the old token and a 401 decides what happens.
			// 预刷新错误不立即打断原请求；通用 SDK 的某些错误路径可能已清过凭证，所以不是一定还保留旧 token。
			await refresh(token).catch(() => undefined);
			// 刷新后重新读存储的当前值；可能是新值、旧值或 undefined，不强行返回先前捕获的变量。
			return (await store.load())?.tokens?.access_token;
		},
		/** 处理传输给出的认证失败；增权直接要求重登，其余共享一次刷新，失败向传输传播。 */
		onUnauthorized: async (context) => {
			// 解析 WWW-Authenticate 为挑战字段，不等于验证这个服务器已获用户信任。
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			// 先记录挑战；回调若抛错不会继续刷新。
			options.onChallenge(challenge);
			// A refresh keeps the granted scope, so more scope needs a new sign-in.
			// 旧 refresh grant 通常保留原权限，insufficient_scope 要走显式新授权。
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			// 传被拒绝的那次 token，避免锁内误把已更新的令牌再刷一遍。
			await refresh(context.token, context.fetch, challenge);
		},
		/** 关闭前等当前刷新完成；失败被吞，未进行刷新时立即完成，不新建请求。 */
		settled: async () => {
			// 可选链可等待 undefined；catch 只针对已有 Promise 的拒绝。
			await refreshing?.catch(() => undefined);
		},
	};
}

/** 宿主提供的登录交互接口；实现可以是真 UI、CLI 或测试假浏览器，不由本接口自行实现。 */
export interface McpSignInPrompt {
	/** Show the authorization URL to the user and open it in a browser. */
	// 显示/打开授权地址的同步回调；该签名不允许调用方依赖它的异步完成结果。
	showAuthorizationUrl(url: URL): void;
	/**
	 * Ask for the redirect URL from the browser address bar, for when the browser cannot reach the
	 * loopback callback (for example over SSH). Aborted once the callback arrives or the sign-in is
	 * cancelled. Resolves to `undefined` or an empty string when the user cancels.
	 */
	// 传入取消信号的手工粘贴框；实现要响应 abort 并落定 Promise，signal 本身不会强制取消任意函数。
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

/** 标识用户取消/取消信号的专用错误，供 CLI/UI 给简洁提示；不同于 OAuth 协议失败。 */
export class McpSignInCancelledError extends Error {
	/** 构造错误并设置可识别名称，不产生登录或文件副作用。 */
	constructor() {
		// super 调 Error 基类构造器；继承类必须先调用它再访问 this。
		super("Sign-in cancelled");
		// name 是展示字段，instanceof 仍按类原型判断。
		this.name = "McpSignInCancelledError";
	}
}

// Pick 从 OAuthCallback 只挑 code/iss 两个字段，沿用 iss 的可选性；state 检查完成后不用往下传。
type AuthorizationResponse = Pick<OAuthCallback, "code" | "iss">;

// 验证用户粘贴的完整回调地址：解析 → origin/path → OAuth错误 → state → code。返回授权码与可选发行方；iss 真正对比由换码流程完成。
function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL): AuthorizationResponse {
	// let 延后赋值，类型是 URL，不是可能一直未定义的可选字段。
	let url: URL;
	try {
		// 去外层空白后要求绝对 URL，不能只粘 code 或相对路径。
		url = new URL(input.trim());
	} catch {
		// 解析错误统一成可操作提示；原始 URL 不回显到这个错误中。
		throw new Error("Expected the full redirect URL from the browser address bar");
	}
	// A server-specific redirect URI tells authorization servers apart, so it must match exactly.
	// 只比较 origin 和 pathname（已规范化），不比较 hash/完整 query/用户名密码；query 正是携带 code/state 的位置。
	if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
		// 来源主机、协议、端口或路径不符就拒绝，不拿这份码去换 token。
		throw new Error("The redirect URL does not match this sign-in's redirect URI");
	}
	// URLSearchParams.get 返回第一份同名参数；这里不额外拒绝重复参数。
	const error = url.searchParams.get("error");
	// 先处理授权端 error，error_description 存在就用它（包括空串）；这一步先于 state 校验。
	if (error) throw new Error(url.searchParams.get("error_description") ?? error);
	// state 必须逐字相同，用于把回调关联到本次登录；不是 token 验签。
	if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
	// 从查询参数取授权码，不读 fragment。
	const code = url.searchParams.get("code");
	// 缺失或空码都不接受。
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	// iss 没有就 undefined，显式空字符串仍保留为空字符串，后续 SDK 比较。
	return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/**
 * Wait for the browser callback or a pasted redirect URL, whichever comes first. Aborting `signal`
 * aborts the prompt, which then cancels the sign-in.
 */
// 让本机回调与手工粘贴竞速，先落定的成功/失败决定结果；Promise.race 不会自动取消另一边。取消依赖 prompt 响应 signal。
async function waitForAuthorizationResponse(
	// 本机服务已经监听好，这里只登记要等哪个 state/路径。
	callback: OAuthCallbackServer,
	// 本次 OAuth 随机 state。
	state: string,
	// 实际授权 URL 使用的 redirect_uri，可能是服务器专有路径。
	redirectUrl: URL,
	// 交互实现由宿主注入。
	prompt: McpSignInPrompt,
	// 参数必须给出，但可传 undefined；不是省略形参的 ?。
	signal: AbortSignal | undefined,
): Promise<AuthorizationResponse> {
	// 局部控制器只用于在竞速结束后关闭手工提示等待。
	const controller = new AbortController();
	// 组合局部结束与外部取消；任一个 abort 都通知 prompt，不直接中止 callback.waitForCallback。
	const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
	// 回调服务内部还有默认5分钟等待计时，检查 state 和期望路径；不等于整个 signIn 的总5分钟。
	const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname);
	// 提示函数立即调用后接 then；它若同步抛错，会发生在下面 try 之前，不由这段 finally 清理。
	const fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
		// 无值/空白视为用户取消，抛专用错误。
		if (!input?.trim()) throw new McpSignInCancelledError();
		// 有值才解析并校验回调地址，错误也参与竞速。
		return responseFromRedirectUrl(input, state, redirectUrl);
	});
	try {
		// 先完成的是拒绝也会直接失败，不会等另一边再给成功结果。
		return await Promise.race([fromBrowser, fromUser]);
	} finally {
		// The losing side rejects once the prompt is aborted or the callback server closes.
		// 通知尚未结束的输入框停止；不直接关闭 HTTP 服务，外层 finally 会关。
		controller.abort();
		// 给输掉的 Promise 装拒绝处理器；不会把它变成已完成或取消底层等待。
		fromBrowser.catch(() => undefined);
		// 同样吸收迟到的用户输入失败，避免未处理拒绝；race 本次的返回/抛错不因此改变。
		fromUser.catch(() => undefined);
	}
}

/** Listen on `port`, or on a free port when it is taken and not `required`. */
// 启动本机回调服务：指定首选端口失败且不是硬性要求时，再让系统选空闲端口。catch 对所有监听错误适用，不仅 EADDRINUSE。
async function listenForCallback(
	// 监听地址与对外主机/路径分开，来自 callbackSettings。
	settings: CallbackSettings,
	// 额外允许的服务器专有回调路径。
	extraPaths: string[],
	// 首选端口可没有，此时用 0 请求系统分配。
	port: number | undefined,
	// required=true 表示配置要求固定端口，失败不偷偷换。
	required: boolean,
): Promise<OAuthCallbackServer> {
	// 构造回调服务选项，不在此手写 HTTP 处理器。
	const options = {
		// 真正绑定的地址。
		host: settings.host,
		// 对外 redirect URL 中的主机文字。
		redirectHost: settings.redirectHost,
		// 默认接受路径。
		path: settings.path,
		// 额外接受路径，服务会再按每次等待的期望路径核对。
		extraPaths,
		// 标签联合 page.ok 收窄成功/失败页面，失败分支才有 message/details。
		renderPage: (page: OAuthCallbackPage) =>
			page.ok
				? // 成功显示共享 HTML helper 输出。
					oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
				: // 失败信息也通过对应页面 helper 处理，不直接拼入模板。
					oauthErrorHtml(page.message, page.details),
	};
	try {
		// await 放在 try 内才捕获异步监听失败；port=0 与未指定端口在服务层都表示动态选择。
		return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
	} catch (error) {
		// 显式固定端口或根本没给首选端口时不再重试；保留原始监听错误。
		if (required || port === undefined) throw error;
		// 退回动态端口只再尝试一次；第二次失败直接向上抛。
		return OAuthCallbackServer.listen(options);
	}
}

/**
 * Sign in to an MCP server. Uses the stored refresh token when possible; otherwise runs the browser
 * authorization code flow. Tokens are saved to `store`. Aborting `signal` stops the sign-in at any
 * step with `McpSignInCancelledError`; requests to the authorization server are also time-limited.
 */
/**
 * 显式登录：读旧状态 → 开本机回调服务 → 决定保留客户端 → 先试刷新，必要时显示授权 URL → 接回调/粘贴 → 换码存 token → 关回调。
 * 例：远端要求 read 之外再加 write，就合并旧/新 scope 并跳过刷新，重新走用户授权。
 * 取消是协作式：入口检查已取消，网络请求传 signal，粘贴实现也须响应。读存储/起监听在 try 外，不可强行中断，也不全被改成取消错误。
 * 本方法不包 store.withRefreshLock，不承诺与另一个独立显式登录互斥；成功只代表流程完成，不返回 token。
 */
export async function signInMcpServer(options: {
	// 需要登录的 MCP 服务地址，授权服务器可通过发现确定。
	serverUrl: string;
	// 状态后端由调用者选择，保存令牌也可能失败。
	store: McpOAuthStateStore;
	// 已解析设置，clientSecret 不在这里再执行配置表达式。
	settings: McpOAuthSettings;
	// 可带先前 401/403 的挑战，为发现位置和增权提供依据。
	challenge?: OAuthChallenge;
	// 显示授权 URL 和粘贴等待的宿主交互。
	prompt: McpSignInPrompt;
	// 外部取消信号；没有时仍有每次网络请求的15秒信号和回调等待的默认5分钟。
	signal?: AbortSignal;
}): Promise<void> {
	// 取常用参数，其他字段仍通过 options 读取。
	const { serverUrl, store, settings, signal } = options;
	// 入口已经取消就立即拒绝，避免先读凭证/建监听。
	if (signal?.aborted) throw new McpSignInCancelledError();
	// 加载旧状态可触发旧键迁移，失败发生在下方 try 之前。
	const stored = await store.load();
	// 只有明确 insufficient_scope 才算增权，不把任意认证失败都当缺权限。
	const stepUp = options.challenge?.error === "insufficient_scope";
	// 拆分配置的回调地址和端口，URL 解析异常也在 try 外。
	const callbackOptions = callbackSettings(settings);
	// Reuse the port of the registered redirect URI so the registered client stays valid.
	// 尝试复用已动态注册的第一个回调地址，不搜索整张列表找空闲端口。
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	// 优先配置端口，其次已注册 URL 的非零端口；URL 的默认空 port 不能据此得到 80/443。
	const preferredPort =
		// || undefined 将 Number("") 得到的 0 变成无首选端口，和 ?? 的判断规则不同。
		callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	// 先做本地文档策略判断，服务器实际支持情况要等发现元数据。
	const offersDocument = offersClientMetadataDocument(settings);
	// 即使稍后 refresh 就成功，也先启动回调监听；不是只在浏览器授权时才开端口。
	const callback = await listenForCallback(
		// 监听地址、路径及可选固定回调信息。
		callbackOptions,
		// The redirect URI of a server-specific Client ID Metadata Document.
		// 仅允许文档策略时追加 /callback/ID，回调匹配仍受具体授权 redirect_uri 限制。
		offersDocument ? [`${CALLBACK_PATH}/${callbackId(serverUrl)}`] : [],
		// 配置端口或旧注册端口可作为首选。
		preferredPort,
		// 只有用户明确配置的端口是硬要求；旧注册端口忙了可以退到空闲端口，再判断需不需要新客户端。
		callbackOptions.port !== undefined,
	);
	// 优先使用固定字符串，否则使用监听器给出的实际动态端口 URL。
	const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
	try {
		// 有旧状态时先整理一份浅拷贝；不存在就由提供者在后续按需建立。
		if (stored) {
			// ...stored 只拷贝顶层，嵌套 tokens/clientInformation 仍共享引用，本段只删除顶层字段。
			const next: McpOAuthState = { ...stored };
			// Every sign-in gets a fresh `state` parameter.
			// 每次显式登录清旧 state，让后续 provider.state 生成新随机串。
			delete next.oauthState;
			// A registered client cannot use another redirect URI, and its tokens belong to it. `cimd` replaces a
			// registered client; `auto` keeps it. A Client ID Metadata Document is not stored, so tokens without
			// a stored client belong to the document.
			// 保留客户端的条件不是纯 boolean：settings.clientId 可能直接返回非空字符串，下面用 truthy 判断即可。
			const keepClient =
				// 显式 clientId 总是允许保留旧状态，这里不另外比对它是否与旧 ID 相同。
				settings.clientId ||
				// 否则按是否有已存 clientInformation 分两个分支。
				(stored.clientInformation
					? // 已登记客户端在显式 cimd 时要替换；auto/dcr 仍须回调相同。
						settings.clientRegistration !== "cimd" &&
						// includes 比较完整回调字符串，不用语义等价 URL 自动放宽。
						registeredRedirectUrls(stored.clientInformation).includes(redirectUrl)
					: // 没有已存客户端信息时，只有本地文档策略仍允许才保留原令牌。
						offersDocument);
			// 条件不满足就删除与原客户端绑定的注册信息/令牌；不执行远端撤销。
			if (!keepClient) {
				// 移除动态客户端登记资料。
				delete next.clientInformation;
				// 移除旧访问/刷新令牌。
				delete next.tokens;
				// 同时移除相应过期时间，避免残留判断。
				delete next.tokensExpireAt;
			}
			// 先保存整理后的状态再运行新流程；后续失败不会自动回滚这次清理。
			await store.save(next);
		}

		// 局部变量接住 SDK 稍后生成的授权 URL。
		let authorizationUrl: URL | undefined;
		// 创建提供者并注册记录 URL 的回调，不在这里直接打开浏览器。
		const provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
			// 授权流要求跳转时，闭包把 URL 保存供后面展示。
			authorizationUrl = url;
		});
		// 两次 authorizeMcp 共用流程选项，第一轮准备授权/刷新，第二轮携码换 token。
		const flow = {
			// 目标 MCP 地址。
			serverUrl,
			// 使用当前全局 fetch 的带时限包装，各请求单独计时。
			fetch: timedFetch(),
			// 外部取消继续传给 SDK 的网络请求，与 timedFetch 的时限信号组合。
			signal,
			// 可能来自服务器挑战的资源元数据位置。
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			// 显式覆盖授权服务器元数据 URL。
			authorizationServerMetadataUrl: settings.authServerMetadataUrl,
			// A server asking for more scope gets it on top of the configured scope and, since the challenge
			// may list only the missing scopes, on top of the scope granted so far.
			// 合并设置权限和挑战权限，保持顺序并去重。
			scope: mergeScopes(
				// 用户配置的权限始终参与合并。
				settings.scope,
				// 增权时连旧 grant 的权限也保留；没有挑战 scope 时 stepUpScope 返回 undefined，后续可由发现数据决定默认权限。
				stepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope,
			),
		};
		// A refresh keeps the granted scope; a server asking for more needs the browser flow.
		// 增权不试旧 refresh grant，直接要求新浏览器授权。
		const skipRefresh = stepUp;
		// 已有刷新成功就提前 return，但仍执行 finally 关闭回调服务；AUTHORIZED 不表示又打开过授权页面。
		if ((await authorizeMcp(provider, { ...flow, skipRefresh })) === "AUTHORIZED") return;
		// 非已授权却没有 URL 属异常，不让用户等一个永远不会展示的页面。
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");

		// 取本次随机 state，提供者会把它保存在 store；已由流程创建则复用。
		const state = await provider.state();
		// The flow picks the redirect URI, which may be specific to the MCP server.
		// 以实际授权 URL 的 redirect_uri 为准，支持客户端文档改成服务器专有路径；没有该参数才退回原地址。
		const authorizationRedirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		// 显示/打开 URL 的具体动作由宿主执行；这个同步调用可能抛错。
		options.prompt.showAuthorizationUrl(authorizationUrl);
		// 等待本机 HTTP 或手工粘贴；解构只取后面换码所需的 code/iss。
		const { code, iss } = await waitForAuthorizationResponse(
			// 传已经监听的回调实例。
			callback,
			// 期望匹配本次随机 state。
			state,
			// 核对授权流程实际采用的回调路径/来源。
			authorizationRedirectUrl,
			// 输入 UI 或 CLI 实现。
			options.prompt,
			// 取消通知传入等待逻辑，但输入实现不响应时 Promise 不会被强制终止。
			signal,
		);
		// 再次调用 SDK：校验 iss、取 PKCE verifier、用授权码换 token 并保存；该调用结果不额外检查，异常会传播。
		await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
	} catch (error) {
		// Aborted requests fail with the signal's reason; report them as the cancellation they are.
		// 只有 try 内抛错且此时 signal 已取消，才改成统一取消错误；成功完成的路径没有末尾再检查 signal。
		if (signal?.aborted) throw new McpSignInCancelledError();
		// 其他失败保留原异常供 UI/CLI 展示。
		throw error;
	} finally {
		// 成功/失败都关闭监听，并拒绝仍在等的回调；close 若再失败，可能覆盖先前返回或异常。
		await callback.close();
	}
}
