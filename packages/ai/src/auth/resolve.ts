// 统一认证调度层：Models 各请求入口共用它；ProviderEnv 只在编译期描述环境覆盖字典。
import type { ProviderEnv } from "../types.ts";
// 统一具体信号和可取消等待，不能把 race 当强制中止任意异步实现。
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
// 带 code/cause 的结构化错误类，用于区分凭证存储与 OAuth 操作错误。
import { ModelsError } from "../utils/models-error.ts";

// 保持此模块的错误导出入口；type 导出在 JS 中消失。
export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

// 以下均为接口/数据类型，真实认证方法由 Provider 注入。
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

// 单次认证解析的覆盖选项，不修改 Provider 或持久凭证的全局配置。
export interface AuthResolutionOverrides {
	// 显式 key 只在 Provider 具有 apiKey 方法时使用，空字符串仍算显式给值。
	apiKey?: string;
	// 本次宿主环境覆盖，常用于账户/网关字段，不自动全变成 HTTP 头。
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	// 最短剩余有效期的毫秒数；当前实现取它与默认五分钟的较大值，不在此验证数值有限性。
	minOAuthValidityMs?: number;
	// 可取消等待/合作任务的外部信号，省略则建立独立未取消信号。
	signal?: AbortSignal;
}

/**
 * Auth resolution shared by all operations in a `Models` collection.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
/**
 * 为 Models 的一次操作解析供应商认证，输入认证方法、存储、宿主环境及可选覆盖，返回 AuthResult 或 undefined。
 * 立即启动异步解析并与取消竞赛；错误按来源包装 ModelsError，取消能先结束等待，不保证底层回调已经停止。例：没有凭证就尝试 API key 环境来源，已有 OAuth 则按 OAuth 处理。
 */
export function resolveProviderAuth(
	// 只要求 id 与 auth 两字段，不必传完整模型目录对象。
	provider: { id: string; auth: ProviderAuth },
	// 应用自己的凭证后端，可能内存也可能持久化。
	credentials: CredentialStore,
	// 可注入的环境和文件探测能力。
	authContext: AuthContext,
	// 请求级覆盖可整体缺省。
	overrides?: AuthResolutionOverrides,
	// Promise 成功也可能表示未配置，而不是已验证远端成功。
): Promise<AuthResult | undefined> {
	// 将可选信号规范为实际 AbortSignal。
	const signal = operationSignal(overrides?.signal);
	// 为整个解析提供“取消先返回”的外层，不等待非合作回调永久卡住。
	return raceWithAbortSignal(
		// 立即执行内部 async 方法，之后 race 观察同一 Promise。
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		// 同一信号决定外层何时停止等待。
		signal,
	);
}

/**
 * 按优先级执行实际解析：显式 API key → 存储条目匹配的方法 → 无存储时的环境 API key。
 * 已有条目却没有匹配方法就返回 undefined，OAuth 刷新失败也不静默换环境 key；具体 API key handler 仍可逐字段补环境。
 * 例：存储为 oauth 但 Provider 只有 apiKey，不能无提示把账号切换到环境 key。解析回调/存储可能有 I/O。
 */
async function resolveProviderAuthWithSignal(
	// 供应商认证能力与持久键，不从 model id 推断认证来源。
	provider: { id: string; auth: ProviderAuth },
	// 读改写统一走这份存储。
	credentials: CredentialStore,
	// 基础环境能力可能来自默认 Node 上下文或测试替身。
	authContext: AuthContext,
	// 该形参必占位置但值可 undefined，区别于把后续 signal 也变可选。
	overrides: AuthResolutionOverrides | undefined,
	// 内部流程始终有具体信号。
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	// 开始就取消时不再读取任何认证来源。
	signal.throwIfAborted();
	// 只有传 env 才建覆盖外观；空对象也 truthy，但不会增加实际变量。
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	// 显式非undefined key 且有 API key 能力时优先处理，可能覆盖已存 OAuth。
	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		// 把显式 key 也交 Provider 方法解释，避免绕过供应商专有认证规则。
		return resolveApiKey(
			// 使用已叠加本次环境的宿主上下文。
			requestAuthContext,
			// 已由条件确定存在的 API key 方法。
			provider.auth.apiKey,
			// 供应商 id 用于错误说明。
			provider.id,
			// 构造仅用于本次解析的临时凭证，不保存它。
			{
				// 字面量标签选 API key 分支。
				type: "api_key",
				// key 保留显式原文，包括空串；是否可用由方法决定。
				key: overrides.apiKey,
				// 显式环境也随临时凭证交具体方法读取。
				env: overrides.env,
			},
			// 合作取消信号传入 Provider。
			signal,
		);
	}

	// 显式覆盖未匹配时才读取存储，可能发生磁盘 I/O。
	const stored = await readCredential(credentials, provider.id, signal);
	// 有存储条目就限制在该条目的认证类别内。
	if (stored) {
		// OAuth 标签和 handler 都存在才进入自动刷新路径。
		if (stored.type === "oauth" && provider.auth.oauth) {
			// 返回 OAuth 结果/拒绝，不在后面再尝试 API key 环境。
			return resolveStoredOAuth(
				// 刷新需要同一存储的 modify 互斥能力。
				credentials,
				// 同一家供应商是凭证存储键。
				provider.id,
				// Provider 的 OAuth 刷新和转换方法。
				provider.auth.oauth,
				// 先读到的凭证用于乐观判断，锁内还会重新取最新值。
				stored,
				// 外部信号控制等待与进入回调前的取消。
				signal,
				// 可选有效期要求只影响 OAuth 路径。
				overrides?.minOAuthValidityMs,
			);
		}
		// API key 条目需要匹配 API key handler，不当作 OAuth token。
		if (stored.type === "api_key" && provider.auth.apiKey) {
			// 有 env 覆盖则浅复制凭证与 env，同名覆盖优先；不就地改存储条目。
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			// 解析存储类别内的请求认证，handler 可有字段级环境回退。
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		// 已存类别无 handler 时表示不可解析，不自动切换到环境账号。
		return undefined;
	}

	// Ambient (env vars, AWS profiles, ADC files).
	// 没有任何存储条目时才进入纯环境 API key 路径。
	return provider.auth.apiKey
		? // 不传凭证，让方法自己查询环境、AWS profile 或 ADC 等来源。
			resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: // 连 API key 能力也没有就没有可尝试的环境认证。
			undefined;
}

/**
 * 给宿主环境能力加本次请求覆盖，返回新外观，不修改原环境字典或文件能力。
 * env[name] 为真值时优先，否则 await 原 ctx.env；例：空字符串不能屏蔽基础环境中的 token。
 */
function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	// 返回新对象包装，基础宿主仍可复用。
	return {
		// 短路 || 表示空覆盖值仍回退原环境，await 只执行在需要回退的分支。
		env: async (name) => env[name] || (await base.env(name)),
		// 文件探测原样委托，不受 env 字典覆盖。
		fileExists: (path) => base.fileExists(path),
	};
}

// 正常请求提前五分钟触发刷新；这不是供应商原始 token 寿命。
const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
// 给正在执行的 OAuth refresh 创建十五秒信号，与调用者信号脱钩。
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh a stored OAuth credential under the credential-store lock and persist
 * the result before the lock is released. `needsRefresh` is re-checked under
 * the lock, so concurrent callers and processes refresh only once.
 *
 * `signal` cancels only the wait for the lock. Once a refresh starts, the
 * provider may already have rotated the refresh token, so the refresh and its
 * persistence ignore `signal` and are bounded only by a timeout. Otherwise a
 * cancelled caller could discard the only valid refresh token. Callers that
 * must return promptly on cancellation race this promise with their signal.
 *
 * Resolves with the stored OAuth credential after the operation, or undefined
 * when the provider no longer has an OAuth credential.
 */
/**
 * 在凭证存储的互斥修改回调里二次判断并刷新 OAuth，返回写后 OAuth 凭证或 undefined。
 * 排队等锁时响应调用者取消；进入回调先解除该信号传播，再检查此前是否已取消，通过后用独立十五秒信号刷新，避免后续取消丢掉已经轮换的 refresh token。
 * 存储是否跨进程互斥、怎样持久化由后端实现；十五秒信号需要刷新实现配合，也不代表整个存储写入有硬时限。
 * 例：两个请求先后等到同一锁，第一个已刷新，第二个重新检查后不再刷新。异常保留 oauth/auth 分类及 cause，不在此删除旧凭证。
 */
export async function refreshStoredOAuthCredential(
	// 存储实现负责互斥和发布，当前函数不自己建文件锁。
	credentials: CredentialStore,
	// 供应商的存储键；实际互斥范围由后端决定，文件后端也可能锁整份凭证文件。
	providerId: string,
	// 可按需加载的 OAuth 方法外观。
	oauth: OAuthAuth,
	// 判断函数会在锁内再次作用于当前凭证，不能只相信锁外旧快照。
	needsRefresh: (credential: OAuthCredential) => boolean,
	// 原信号只在刷新正式开始前继续影响 lockWait。
	signal: AbortSignal,
	// 成功可能缺省，表示锁内已注销/切换为非 OAuth；错误仍可能拒绝。
): Promise<OAuthCredential | undefined> {
	// 保存 modify 的写后结果，不只使用 oauth.refresh 返回值。
	let post: Credential | undefined;
	// 单独控制等锁，不直接把原信号永久交存储。
	const lockWait = new AbortController();
	// 把原取消原因传给等锁控制器，不改变 reason。
	const cancelLockWait = () => lockWait.abort(signal.reason);
	// 等待期间只传播一次取消事件。
	signal.addEventListener("abort", cancelLockWait, { once: true });
	// 补检查已经发生的取消，避免只订阅未来事件而漏掉它。
	if (signal.aborted) cancelLockWait();
	// 整个存储修改过程归入 auth 错误边界，刷新错误另分类。
	try {
		// await 存储修改 Promise；回调内部刷新结果由 store 负责保存。
		post = await credentials.modify(
			// 供应商键决定互斥队列。
			providerId,
			// 进入修改回调时 current 才是最新条目，可能已被别的登录/注销改变。
			async (current) => {
				// 一旦取得执行机会，先停止把之后的原信号传播进存储。
				signal.removeEventListener("abort", cancelLockWait);
				// 仍检查进入回调之前/此刻已取消的情况，取消就不开始刷新。
				signal.throwIfAborted();
				// 当前已非 OAuth 时返回undefined，按 store 契约保持当前条目，而非删除它。
				if (current?.type !== "oauth") return undefined; // logged out meanwhile
				// 另一请求已刷新到够用时不重复兑换，modify 最终仍应返回当前凭证。
				if (!needsRefresh(current)) return undefined; // another process/request refreshed
				// 只把实际刷新失败归类 oauth，后端自身失败由外层处理。
				try {
					// 用独立超时信号刷新并返回新凭证给 store；信号不强制终止非合作实现，也不直接覆盖后续存储写入。
					return await oauth.refresh(current, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS));
					// 捕获 Provider 抛出的任意失败值。
				} catch (error) {
					// 保留原异常为 cause，方便上层诊断，不暴露为成功结果。
					throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
				}
			},
			// store 接收的是 lockWait 信号；进入回调后它不再跟随调用者后续取消。
			{ signal: lockWait.signal },
		);
		// 这里还能收到等锁/保存等存储错误。
	} catch (error) {
		// 已分类的 ModelsError 原样保留，避免把 oauth 再包成 auth。
		if (error instanceof ModelsError) throw error;
		// 若此时原信号已取消，优先传播它的 reason，而非一般存储错误说明。
		signal.throwIfAborted();
		// 其余非已分类失败包为存储 modify 错误，不擅自清掉凭证。
		throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		// 无论成功失败都清理原信号监听，避免长期保留此闭包。
	} finally {
		// 重复 remove 是允许的，回调中可能已经移除过。
		signal.removeEventListener("abort", cancelLockWait);
	}
	// 只对最终仍为 OAuth 的条目返回对象，API key 或缺省都返回undefined。
	return post?.type === "oauth" ? post : undefined;
}

/**
 * OAuth resolution with double-checked locking: tokens with less than five
 * minutes remaining are refreshed through `refreshStoredOAuthCredential`.
 */
/**
 * 用剩余有效期判断是否需要刷新，再从最终凭证派生请求认证，返回带 OAuth 来源的结果。
 * 默认至少按五分钟窗口判断，显式参数可要求更长；刷新后仅显式要求者再检查窗口，默认刷新结果不会被此处强行要求仍超过五分钟。
 * 例：显式要求三十分钟，刷新后只剩十分钟会抛 oauth 错；省略参数则没有这次显式后验检查。
 */
async function resolveStoredOAuth(
	// 同一后端用于锁内读取/写回。
	credentials: CredentialStore,
	// 供应商 id 用来串行及标错误。
	providerId: string,
	// OAuth 具体实现的 refresh/toAuth。
	oauth: OAuthAuth,
	// 锁外读到的初始凭证；不把它当锁内权威值。
	stored: OAuthCredential,
	// 调用者取消信号用于前置判断/等待。
	signal: AbortSignal,
	// 可选毫秒要求，省略与明确给0在刷新后检查策略上不同。
	minOAuthValidityMs?: number,
): Promise<AuthResult | undefined> {
	// Math.max 使有效刷新窗口不小于默认五分钟；?? 保留显式0，原逻辑未额外过滤 NaN 等数字边界。
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	// 箭头函数每次用当前 Date.now 检查，等于截止线也算需要刷新。
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	// let 允许刷新后用存储最终值替换最初快照引用。
	let credential = stored;

	// 先做快速判断，够用时完全不调用 modify。
	if (expiresSoon(credential)) {
		// Optimistic check said expired; the authoritative check runs under the lock.
		// 二次检查放进持锁刷新辅助，多个调用不各自用旧快照刷新一次。
		const post = await refreshStoredOAuthCredential(credentials, providerId, oauth, expiresSoon, signal);
		// 等锁期间已注销/换类别时没有可用OAuth结果。
		if (!post) return undefined; // logged out meanwhile
		// 后续转换采用 store 最终发布的凭证，不沿用旧token。
		credential = post;
		// The normal five-minute window triggers a refresh but does not impose a
		// provider contract. Explicit callers (such as bearer-token export) do
		// require the requested minimum after the refresh.
		// 只有显式传有效期要求时，刷新后仍不满足才拒绝；默认触发窗口不是这项后验契约。
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			// 报告刷新结果寿命不足，但此时 store 可能已经保存它，不自动回滚。
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	// toAuth 的派生失败单独归类，不当作存储失败。
	try {
		// 从有效凭证得到请求 key/headers/baseUrl；source 仅给可读来源标签。
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
		// 异步派生拒绝和同步抛错都会进这里。
	} catch (error) {
		// 保留派生失败原因；不在此尝试其他认证类别。
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

/**
 * 调用供应商 API key 解析器，返回它的结果，任何抛错/拒绝包为 auth 类 ModelsError。
 * 输入宿主环境、方法、供应商 id、可选存储凭证和信号；例：配置命令失败保留为 cause，不能自动当作无配置而换来源。
 */
async function resolveApiKey(
	// 给 API key 方法使用的宿主环境能力。
	authContext: AuthContext,
	// 具体认证方法而不是 key 文本。
	apiKey: ApiKeyAuth,
	// 用于错误位置的供应商键。
	providerId: string,
	// 可缺省存储/临时 API key 数据。
	credential: ApiKeyCredential | undefined,
	// 传给合作解析器的具体信号。
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	// Provider 的任意同步/异步失败都在此边界归一。
	try {
		// 对象简写传 credential/signal，ctx 显式改名为 authContext。
		return await apiKey.resolve({ ctx: authContext, credential, signal });
		// 不把解析失败吞成undefined，以免用户误以为只是未配置。
	} catch (error) {
		// API key 解析错误统一 auth 分类并保留 cause。
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

/**
 * 读取存储中一家凭证并透传取消，返回原后端结果；后端失败包为 auth 类 ModelsError。
 * 例：缺条目正常 undefined，文件读取拒绝才成为 Credential store read failed；此方法不刷新 token。
 */
async function readCredential(
	// 可注入内存或磁盘凭证后端。
	credentials: CredentialStore,
	// 只读取这一 provider 的条目。
	providerId: string,
	// 将取消选项传给真实后端，是否立即停止由实现决定。
	signal: AbortSignal,
): Promise<Credential | undefined> {
	// 只捕获读取阶段失败。
	try {
		// 缺条目正常返回undefined，成功值原样透传。
		return await credentials.read(providerId, { signal });
		// 外部后端可能抛任意值，由ModelsError cause保留。
	} catch (error) {
		// 把读取失败归类 auth，不伪装成无凭证。
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
