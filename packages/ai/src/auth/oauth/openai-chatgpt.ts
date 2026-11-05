// ChatGPT直连OpenAI认证适配：每次授权动态注册客户端，校验回调state/client_id和direct scope；独立于Codex固定客户端的登录流程。
/**
 * OpenAI Responses API token sharing through Sign in with ChatGPT.
 *
 * This public-client flow uses no client secret and sends the resulting user
 * access token directly to api.openai.com.
 */

// Node加密随机数生成器，用于state与nonce。
import { randomBytes } from "node:crypto";
// createServer是运行值，Server/ServerResponse是会擦除的类型导入。
import { createServer, type Server, type ServerResponse } from "node:http";
// 生成成功/失败HTML页面，动态错误文字由页面helper处理。
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
// 统一读取回调host环境覆盖。
import { getProviderEnvValue } from "../../utils/provider-env.ts";
// type导入登录选项、交互及认证结果契约。
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 生成PKCE verifier/challenge，同一次授权配对使用。
import { generatePKCE } from "./pkce.ts";

// every login registers a new client with this ID; OpenAI returns the issued client ID in the callback
// 授权起点用动态注册占位id，兑换时必须用回调真实签发id。
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
// 调用方未给agentName时的名称提示。
const AGENT_NAME_HINT = "Pi";
// 正则i忽略大小写，只查UUID外形，不限定版本/变体。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 动态客户端授权页面端点，不同于Codex/oauth/authorize。
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
// 动态客户端token端点，区别Codex/oauth/token。
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
// 申请直接访问的资源标识，也放入兑换/刷新表单。
const RESOURCE = "https://api.openai.com/v1";
// 模块导入时读取监听host覆盖；改环境后本常量不会自动重算。
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
// 固定1455端口，与其他登录程序可能冲突。
const CALLBACK_PORT = 1455;
// 回调pathname必须匹配此固定路径。
const CALLBACK_PATH = "/auth/callback";
// 登记redirect_uri固定127.0.0.1，不随监听host覆盖改变。
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
// 必须获得的直用access token权限。
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
// 授权请求scope集合；服务端返回后仍要验证direct scope。
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh this long before the real expiry so a request never starts with a token about to expire.
// 本地把到期时间前移3分钟，是刷新调度余量，不保证任意请求绝不跨到期。
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

// 从回调得到的内部授权材料类型。
type AuthorizationResult = {
	// 短期一次性授权码，不是access token。
	code: string;
	// 本次服务端签发的客户端id。
	clientId: string;
};

// 启动结果同时含服务器和等待材料的Promise。
type CallbackServer = {
	// 调用方用server负责清理本地监听。
	server: Server;
	// Promise稍后由合法回调或服务错误结算。
	result: Promise<AuthorizationResult>;
};

// token JSON字段刻意unknown，运行时需逐项校验。
type TokenResponse = {
	// 可缺省未知access字段。
	access_token?: unknown;
	// 可缺省未知refresh字段。
	refresh_token?: unknown;
	// 可缺省未知有效期秒数。
	expires_in?: unknown;
	// 首次兑换要求有ID token，但不读取其内容。
	id_token?: unknown;
	// 授予scope文字，后面拆数组。
	scope?: unknown;
};

/**
 * 生成32随机字节并编码为base64url字符串，无网络或保存。
 * 例：state和nonce分别调用，得到独立随机值；base64url是编码，不是加密。
 */
function randomValue(): string {
	// Node生成32字节随机数据，编码为URL可用字符串。
	return randomBytes(32).toString("base64url");
}

/**
 * 从回调URL提取code、核对必需state，再取已签发client_id，返回授权材料。
 * 字段缺失/不匹配即抛错；例：client_id取回调值而非dynamic_agent_client。这里只处理查询参数，不核对URL路径/来源或远端token。
 */
function authorizationResultFromCallback(url: URL, expectedState: string): AuthorizationResult {
	// 读取首个code查询值，缺失为null。
	const code = url.searchParams.get("code");
	// 缺失或空串都拒绝。
	if (!code) throw new Error("Missing authorization code");
	// 读取回传state。
	const state = url.searchParams.get("state");
	// state必须存在且非空。
	if (!state) throw new Error("Missing OAuth state");
	// 用严格字符串相等核对本次state，不对任意state放行。
	if (state !== expectedState) throw new Error("OAuth state mismatch");
	// client_id去两端空白后使用。
	const clientId = url.searchParams.get("client_id")?.trim();
	// 未提供真实签发client_id就拒绝，不沿用动态占位id。
	if (!clientId) throw new Error("OpenAI OAuth registration callback did not contain an issued client ID");
	// 属性简写返回两份授权材料。
	return { code, clientId };
}

/**
 * 解析手动粘贴的完整回调URL，要求origin/path等于固定REDIRECT_URI，再处理error/state/client_id。
 * 返回AuthorizationResult，无网络；例：裸授权码会拒绝，不能像Codex那样省略state；查询串顺序与额外参数不影响origin/path判断。
 */
function authorizationResultFromManualInput(input: string, expectedState: string): AuthorizationResult {
	// 声明解析后URL变量，成功构造后才赋值。
	let url: URL;
	// URL构造失败转为明确手动输入错误。
	try {
		// 先trim整段输入，必须是可解析绝对URL。
		url = new URL(input.trim());
		// 不尝试裸码或查询串回退。
	} catch {
		// 要求粘完整浏览器跳转URL。
		throw new Error("Paste the full callback URL from the browser");
	}
	// 解析固定回调URI作为比较基准。
	const expected = new URL(REDIRECT_URI);
	// origin含协议/主机/端口，pathname独立比较；不比较查询串/fragment。
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
		// 不合固定回调位置即拒绝。
		throw new Error(`The pasted callback URL must start with ${REDIRECT_URI}`);
	}
	// 回调error优先作为授权失败。
	const error = url.searchParams.get("error");
	// 非空error直接拒绝，不继续字段解析。
	if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
	// 校验同次state并提code/clientId。
	return authorizationResultFromCallback(url, expectedState);
}

/**
 * 给Node HTTP响应写状态、HTML头和正文并结束响应，无返回值。
 * 例：400错误页由oauthErrorHtml先生成；这里只发送body，不额外转义任意传入正文。
 */
function sendHtml(response: ServerResponse, status: number, body: string): void {
	// 发送HTTP状态与UTF-8 HTML响应头。
	response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	// 写HTML正文并结束此HTTP响应。
	response.end(body);
}

/**
 * 监听固定host/1455回调服务，返回server与后续授权材料Promise，不在此兑换token。
 * 路由错误/坏state给网页错误但继续等，带error参数则拒绝result；通过参数检查先发成功页，再resolve材料。例：浏览器成功页不保证后续token兑换成功。
 * 本实现只匹配pathname，不限制HTTP方法、无共享服务器的claimed锁、无独立取消/超时；调用方负责关闭。启动失败拒绝外层Promise，运行期error拒绝result。
 */
function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	// 外层Promise只代表服务已成功监听，不代表授权完成。
	return new Promise((resolve, reject) => {
		// !为确定赋值断言；Promise执行器同步给resolveResult赋值，不是运行时非空检查。
		let resolveResult!: (result: AuthorizationResult) => void;
		// 保存后续授权等待的拒绝回调。
		let rejectResult!: (error: Error) => void;
		// 内层Promise等待授权材料，泛型说明成功值形状。
		const result = new Promise<AuthorizationResult>((resolveAuthorization, rejectAuthorization) => {
			// 保存授权成功结算函数供HTTP handler使用。
			resolveResult = resolveAuthorization;
			// 保存授权失败结算函数供HTTP/server错误使用。
			rejectResult = rejectAuthorization;
		});

		// 每个HTTP请求都会进入此回调，不在此限定method。
		const server = createServer((request, response) => {
			// 最外层try处理handler内意外异常。
			try {
				// 相对request.url以固定redirect基址解析，空值以空串代替。
				const url = new URL(request.url || "", REDIRECT_URI);
				// 仅pathname不同才在这里拒绝路由。
				if (url.pathname !== CALLBACK_PATH) {
					// 错误路由回404页面，不结算授权Promise。
					sendHtml(response, 404, oauthErrorHtml("Callback route not found."));
					// 结束本请求，继续等待下一请求。
					return;
				}

				// 正确路径先看远端error参数。
				const error = url.searchParams.get("error");
				// 非空error进入失败路径，尚未检查state。
				if (error) {
					// 给浏览器400授权失败页。
					sendHtml(response, 400, oauthErrorHtml("ChatGPT was not connected.", `Error: ${error}`));
					// 内层result以Error拒绝；Promise只采用首次结算。
					rejectResult(new Error(`ChatGPT authorization failed: ${error}`));
					// 不再尝试当code处理。
					return;
				}

				// 声明合法授权材料，校验成功后才赋值。
				let authorizationResult: AuthorizationResult;
				// 参数错误单独捕获，避免拒绝整个授权等待。
				try {
					// 要求code/state/client_id且state匹配。
					authorizationResult = authorizationResultFromCallback(url, expectedState);
					// 捕获缺字段/错state的Error。
				} catch (error) {
					// 未知抛出值用固定Invalid callback兜底。
					const message = error instanceof Error ? error.message : "Invalid callback";
					// 浏览器400，但result保持等待，允许正确回调随后到来。
					sendHtml(response, 400, oauthErrorHtml(message));
					// 终止本次错误请求。
					return;
				}

				// 先显示浏览器成功页，此时还没请求token端点。
				sendHtml(response, 200, oauthSuccessHtml("ChatGPT authentication completed. You can close this window."));
				// 合法材料交给登录协调继续兑换；后续重复resolve不会改变首个Promise结果。
				resolveResult(authorizationResult);
				// 其他handler异常在外层转500页面。
			} catch {
				// 只发送错误页，不在此rejectResult，等待仍可能继续。
				sendHtml(response, 500, oauthErrorHtml("Internal error while processing the callback."));
			}
		});

		// 启动阶段第一个监听错误使外层Promise拒绝。
		server.once("error", reject);
		// 按固定port和可覆盖host开始监听，回调代表绑定成功。
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			// 移除启动失败处理，避免运行期误拒绝已完成外层Promise。
			server.removeListener("error", reject);
			// 运行期服务error改为拒绝授权result。
			server.on("error", rejectResult);
			// 返回实际server和还在等待的result。
			resolve({ server, result });
		});
	});
}

/**
 * 把表单POST到ChatGPT token端点，返回顶层非数组对象视图，字段仍unknown。
 * HTTP失败/坏JSON/非对象拒绝，实际请求仅用传入signal，无独立超时或重试。例：200返回{}可通过本层，后续credential校验才报缺token。
 */
async function requestToken(body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
	// 向固定token URL发网络请求。
	const response = await fetch(TOKEN_URL, {
		// POST提交grant。
		method: "POST",
		// 准备JSON响应偏好与表单编码头。
		headers: {
			// 期望JSON返回。
			accept: "application/json",
			// 正文是URLSearchParams表单。
			"content-type": "application/x-www-form-urlencoded",
		},
		// 直接使用传入表单，不再二次拼接。
		body,
		// 只透传调用方signal，没有单独timer。
		signal,
	});
	// HTTP非2xx按token请求失败处理。
	if (!response.ok) {
		// 尽力读失败正文，读取失败用空串。
		const responseBody = await response.text().catch(() => "");
		// 状态和正文/状态文字进入Error，不脱敏。
		throw new Error(`OpenAI OAuth token request failed (${response.status}): ${responseBody || response.statusText}`);
	}
	// 成功HTTP解析结果先设unknown。
	const data: unknown = await response.json();
	// 信任边界排除null、数组和非object。
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		// 顶层不合对象规则就拒绝。
		throw new Error("OpenAI OAuth token response must be an object");
	}
	// as只给字段可选unknown的视图，不验证token内容。
	return data as TokenResponse;
}

/**
 * 验证token字段为去空白后非空字符串，返回原字符串而非trim后的副本。
 * field的字面量联合只允许3个字段名，供错误说明；例：" abc "返回原有空格，纯空白抛错。
 */
function requireTokenString(value: unknown, field: "access_token" | "refresh_token" | "scope"): string {
	// 必须字符串且trim后非空，排除纯空白。
	if (typeof value !== "string" || value.trim().length === 0) {
		// 用限定字段名报告错误。
		throw new Error(`OpenAI OAuth token response has invalid ${field}`);
	}
	// 返回原字符串，没把trim值覆盖回去。
	return value;
}

/**
 * 校验access/refresh/scope与有限正有效秒数，要求direct token scope，再返回带clientId/scopes的新凭证。
 * 无存储/网络，例：expires_in=3600时本地到期设为57分钟后，外层另有刷新窗口；刷新也要求返回非空refresh字段，不自动沿用旧值，不保证新值与旧值不同。
 */
function credentialFromTokenResponse(token: TokenResponse, clientId: string): OAuthCredential {
	// 验证并读取access token。
	const access = requireTokenString(token.access_token, "access_token");
	// 验证本次refresh token，不因刷新响应省略而沿用旧值。
	const refresh = requireTokenString(token.refresh_token, "refresh_token");
	// scope必须是非空白文字。
	const scope = requireTokenString(token.scope, "scope");
	// expires_in必须有限正number，不接受数值字符串。
	if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
		// 无有效期拒绝，不猜默认寿命。
		throw new Error("OpenAI OAuth token response has invalid expires_in");
	}
	// 按一个或多个空白拆scope并去空项。
	const scopes = scope.trim().split(/\s+/).filter(Boolean);
	// 必须包含direct scope，不要求每个申请scope均出现。
	if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
		// 缺必需权限时拒绝此次认证。
		throw new Error(`OpenAI OAuth grant did not include ${DIRECT_TOKEN_SCOPE}`);
	}
	// 组统一新凭证，供外层保存。
	return {
		// OAuth类别字面量。
		type: "oauth",
		// 保存通过非空检查的原access文字。
		access,
		// 保存本次返回的refresh文字。
		refresh,
		// 秒转毫秒加现在，再前移3分钟。
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
		// 保存签发clientId供未来刷新，不用动态占位id。
		clientId,
		// 保存实际授予scope数组。
		scopes,
	};
}

/**
 * 使用回调签发client_id、code与本次PKCE verifier兑换token并生成凭证。
 * POST成功还要求非空id_token，但不解码身份、不验签、不核对nonce内容；例：最终存储access/refresh/clientId/scopes，不保存id_token。
 */
async function exchangeAuthorizationCode(
	// 回调授权码。
	code: string,
	// 同次PKCE verifier。
	verifier: string,
	// 回调真实签发的客户端id。
	clientId: string,
	// 调用方取消信号。
	signal: AbortSignal,
	// 异步返回带签发clientId与scope的新凭证。
): Promise<OAuthCredential> {
	// 发送授权码grant并等token响应。
	const token = await requestToken(
		// 构造URL编码表单对象。
		new URLSearchParams({
			// 采用authorization_code grant。
			grant_type: "authorization_code",
			// 使用真实client_id，而不是dynamic_agent_client。
			client_id: clientId,
			// 授权码作为code字段。
			code,
			// 提交本地保留verifier证明与challenge匹配。
			code_verifier: verifier,
			// redirect必须与授权阶段固定URI一致。
			redirect_uri: REDIRECT_URI,
			// 指定同一直接API资源。
			resource: RESOURCE,
		}),
		// 传总取消信号。
		signal,
	);
	// Pi does not use the ID token to identify the user or read profile data.
	// Keep the presence check as part of the token-response contract.
	// 首次兑换额外要求非空白ID token；不解析内容或验证签名/nonce。
	if (typeof token.id_token !== "string" || token.id_token.trim().length === 0) {
		// 缺ID token即违反当前响应契约。
		throw new Error("OpenAI OAuth token response did not contain an ID token");
	}
	// 校验其他必需字段和scope后生成credential，不存ID token。
	return credentialFromTokenResponse(token, clientId);
}

/**
 * 从已存凭证取签发clientId和refresh发刷新grant，再按相同scope/字段契约生成新凭证。
 * clientId缺失拒绝并提示重连，不动态注册替代；例：刷新正文不发scope，返回scope仍须含direct权限，且必须返回refresh字段；不要求id_token。
 */
async function refreshAccessToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	// clientId是OAuthCredential开放扩展字段，类型仍需收窄。
	const clientId = credential.clientId;
	// 缺失、非字符串或全空白不能刷新。
	if (typeof clientId !== "string" || clientId.trim().length === 0) {
		// 提示重连，不尝试注册新客户端替代。
		throw new Error("Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT");
	}
	// 发送刷新表单并等响应。
	const token = await requestToken(
		// 创建refresh grant的表单。
		new URLSearchParams({
			// grant_type为refresh_token。
			grant_type: "refresh_token",
			// 沿用已存签发clientId。
			client_id: clientId,
			// 提交旧refresh token。
			refresh_token: credential.refresh,
			// 继续指定直接API资源，没有在此发送scope。
			resource: RESOURCE,
		}),
		// 透传调用方signal。
		signal,
	);
	// 按同一字段/scope规则重建凭证；本路径不额外要求ID token。
	return credentialFromTokenResponse(token, clientId);
}

/** OpenAI identifies each installation ("agent host") by a stable URI such as `urn:uuid:<uuid>`. */
/**
 * 把宿主安装UUID验证并转urn:uuid:形式，返回字符串，无网络/生成UUID。
 * 例：大写UUID统一转小写，缺失/格式不符直接抛错；只检验8-4-4-4-12十六进制格式，不检查特定UUID版本位。
 */
function agentHostId(deviceId: string | undefined): string {
	// 安装UUID必须存在且符合固定十六进制分组外形。
	if (!deviceId || !UUID_PATTERN.test(deviceId)) {
		// 失败在发任何授权请求之前抛错。
		throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation");
	}
	// 小写UUID加URN前缀，作为安装身份提示。
	return `urn:uuid:${deviceId.toLowerCase()}`;
}

/**
 * 协调动态客户端授权：要求安装UUID，生成PKCE/state/nonce，先监听端口，再报告URL并让回调/手动完整URL竞速，最后兑换凭证。
 * 端口占用明确失败，不降级纯手动；进入try之后的成功/失败都会取消prompt、close并强关现有连接。例：notify或prompt同步抛错发生在try之前，不把finally保证扩到这些前置步骤。
 * 取消依赖交互prompt与fetch使用signal；回调result自身无取消/超时。nonce只发往授权端，不在本地验证ID token里的nonce。
 */
async function loginOpenAIChatGPT(
	// 宿主提供通知/提示和总取消signal。
	interaction: ProviderAuthInteraction,
	// 可选安装id与应用名回调/值。
	options?: LoginOptions,
	// Promise成功值是凭证，交互或兑换失败则拒绝。
): Promise<OAuthCredential> {
	// 可选调用getDeviceId，缺失交agentHostId明确拒绝；不在此生成或写入设备id。
	const hostId = agentHostId(options?.getDeviceId?.());
	// 为本轮生成独立PKCE材料。
	const { verifier, challenge } = await generatePKCE();
	// 随机state用于回调关联核对。
	const state = randomValue();
	// 独立随机nonce只写入授权请求，本地未验证其回传内容。
	const nonce = randomValue();
	// Without this server, the browser's callback would reach whatever else holds the port (another
	// pending login or the Codex CLI), which rejects it as a state mismatch. Fail with a clear error instead.
	/**
	 * 把回调启动的EADDRINUSE转换为可操作说明，其他错误原样抛出。
	 * 例：不会自动连接已占用端口的另一个登录会话，错误中的原因只是可能性。
	 */
	const callback = await startCallbackServer(state).catch((error: unknown) => {
		// 只转换具有EADDRINUSE错误码的Error，其他启动失败继续抛出。
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
		// 构造端口被占用的明确说明。
		throw new Error(
			// 其他pi会话/Codex CLI只是可能占用者，不做进程检测。
			`Port ${CALLBACK_PORT} is in use, probably by an unfinished login in another pi session or by the Codex CLI. Cancel that login and try again.`,
		);
	});

	// 构造授权页面URL，服务器已经开始监听。
	const authorizationUrl = new URL(AUTHORIZE_URL);
	// 一次设置授权查询参数，自动转义。
	authorizationUrl.search = new URLSearchParams({
		// 以动态注册占位client_id开始授权。
		client_id: DYNAMIC_CLIENT_ID,
		// 应用名采用options值；??保留显式空字符串。
		agent_name_hint: options?.agentName ?? AGENT_NAME_HINT,
		// 当前安装的稳定URN。
		ext_agent_host_id: hostId,
		// 要求authorization code响应类型。
		response_type: "code",
		// 始终发固定127.0.0.1回调URI。
		redirect_uri: REDIRECT_URI,
		// 声明直接API资源。
		resource: RESOURCE,
		// 申请预设scope集合。
		scope: SCOPE,
		// 发送本次随机state。
		state,
		// 只把PKCE challenge放授权URL，verifier留本地。
		code_challenge: challenge,
		// 使用S256挑战方法。
		code_challenge_method: "S256",
		// 发送本次nonce。
		nonce,
		// 查询表单转字符串赋search。
	}).toString();
	// 通知宿主展示/打开浏览器授权URL。
	interaction.notify({
		// auth_url事件。
		type: "auth_url",
		// 序列化完整授权URL。
		url: authorizationUrl.toString(),
		// 附操作说明，实际开网页由宿主负责。
		instructions:
			// 说明无法自动回调时可手动粘贴完整URL。
			"Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
	});

	// 独立控制手动提示结束，不等同取消总登录。
	const manualAbort = new AbortController();
	// 现在就启动交互Promise，随后才进入try等待竞速。
	const manualCode = interaction
		// 调用宿主manual_code提示；若同步抛错不在后面try/finally范围内。
		.prompt({
			// 交互类型为manual_code。
			type: "manual_code",
			// 要求完整跳转URL，不接收裸码。
			message: "Complete login in your browser, or paste the final redirect URL here:",
			// 固定redirect作为占位示例。
			placeholder: REDIRECT_URI,
			// 任一手动结束或整体取消signal触发提示的合并signal。
			signal: AbortSignal.any([manualAbort.signal, interaction.signal]),
		})
		/**
		 * 手动prompt完成后校验整条回调URL与同次state，返回授权材料。
		 * 例：参数不完整时此Promise拒绝，可使后面的race失败；不在这里兑换token。
		 */
		.then((input) => authorizationResultFromManualInput(input, state));

	// 只有从这里开始的异常才进入当前catch/finally。
	try {
		// 标准Promise.race首个结算者决定结果/失败；另一边不会因此自动取消。
		const result = await Promise.race([callback.result, manualCode]);
		// 竞速得到材料后通知即将兑换。
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		// 用材料中的真实clientId与本地verifier兑换，await使清理等兑换结算。
		return await exchangeAuthorizationCode(result.code, verifier, result.clientId, interaction.signal);
		// 捕获竞速、进度通知、兑换异常。
	} catch (error) {
		// 总signal取消时统一UI取消文字。
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		// 非取消保留原异常。
		throw error;
		// 已进入try后无论成功失败都做下列清理。
	} finally {
		// 通知宿主结束仍在等的手动prompt；非合作prompt不会被强制终止。
		manualAbort.abort();
		// 请求关闭监听，不await关闭回调。
		callback.server.close();
		// close() only stops accepting new connections. Browsers open spare connections ahead of
		// time, and one that has not sent a request yet stays open and attached to this server.
		// A later login in the same process starts a new server with a new state, but the browser
		// may send that login's callback over the spare connection. This server would then handle
		// it and reject it with "OAuth state mismatch", and the new login would never see it.
		// 强关本服务器现有连接，避免浏览器预连接把下次登录送到旧state服务。
		callback.server.closeAllConnections();
	}
}

// 外层持有的OAuthAuth对象，导入时不触发登录。
export const openaiChatGPTOAuth: OAuthAuth = {
	// 登录列表展示名称。
	name: "OpenAI (ChatGPT subscription)",
	// 订阅标记，不是本地套餐有效性检查。
	isSubscription: true,
	// 登录按钮文字。
	loginLabel: "Sign in with ChatGPT",
	// 交动态客户端登录函数引用。
	login: loginOpenAIChatGPT,
	// 交刷新函数引用，外层负责调度。
	refresh: refreshAccessToken,
	/**
	 * 把access映射通用apiKey，返回认证Promise，无请求/到期检查。
	 * 例：直连Responses请求如何使用这个token由供应商适配器决定。
	 */
	async toAuth(credential) {
		// 返回access作为通用apiKey，不验证远端token有效性。
		return { apiKey: credential.access };
	},
};
