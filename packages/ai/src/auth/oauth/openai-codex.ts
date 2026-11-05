// OpenAI Codex订阅认证适配：固定公开客户端支持浏览器/设备码两条路径，兑换后从token载荷提账号id；凭证保存由外层处理。
/**
 * OpenAI Codex (ChatGPT OAuth) flow
 *
 * NOTE: This module uses Node.js crypto and http (via callback-server.ts) for the OAuth callback.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
// typeof import(...).randomBytes仅取类型，|null表示异步加载前尚无函数；保留既有动态导入写法。
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
// 只有存在process且识别Node/Bun版本时才尝试导入Node加密模块。
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	/**
	 * 在Node/Bun环境异步导入加密模块，完成后保存randomBytes引用，无返回业务值。
	 * 例：模块加载尚未完成时createState仍会报不可用；这是保留原动态导入的运行语义，不改成新的加载策略。
	 */
	import("node:crypto").then((m) => {
		// 异步模块加载成功后保存实际函数引用。
		_randomBytes = m.randomBytes;
	});
}

// 环境读取复用供应商helper，包括Bun沙箱回退。
import { getProviderEnvValue } from "../../utils/provider-env.ts";
// type导入认证/交互/登录选项契约，运行时擦除。
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 共享回调服务与手动输入协调器，不是ChatGPT动态客户端的专用服务。
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
// 共享设备授权轮询协调。
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
// Web Crypto PKCE材料生成。
import { generatePKCE } from "./pkce.ts";

// Codex固定公开客户端id，不同于ChatGPT动态注册流程。
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// 认证服务固定根地址。
const AUTH_BASE_URL = "https://auth.openai.com";
// 浏览器授权页面。
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
// 授权码兑换和刷新共用端点。
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
// 授权阶段登记的固定localhost回调URI，不随监听host覆盖改写。
const REDIRECT_URI = "http://localhost:1455/auth/callback";
// 申请设备授权材料的JSON端点。
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
// 轮询设备授权码/verifier的JSON端点。
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
// 供用户在其他浏览器打开的设备授权页。
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
// 设备流程兑换code时使用远端redirect，不是本机回调。
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
// 本地设备轮询截止预算15分钟，单位秒。
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
// 宿主选择浏览器方式时返回的id。
const OPENAI_CODEX_BROWSER_LOGIN_METHOD = "browser";
// 宿主选择设备码方式时返回的id。
const OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code";
// 申请身份与离线刷新scope，不含ChatGPT direct token scope。
const SCOPE = "openid profile email offline_access";
// 从JWT载荷读取账号字段的命名空间键。
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

// 内部token结构，expires为毫秒绝对时刻；类型不替代远端校验。
type OAuthToken = { access: string; refresh: string; expires: number };
// 字面量联合只允许两种token操作名，供错误文字区分。
type TokenOperation = "exchange" | "refresh";

/**
 * 按当前环境读取回调监听host，返回覆盖或127.0.0.1，无网络。
 * 例：与固定REDIRECT_URI不同，host覆盖影响本地监听，不改授权表单里的localhost URI。
 */
function getCallbackHost(): string {
	// 每次调用读当前host环境，空值回退127.0.0.1。
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

// 申请设备码后的内部材料类型。
type DeviceAuthInfo = {
	// 服务端设备授权id，供轮询。
	deviceAuthId: string;
	// 用户网页输入短码。
	userCode: string;
	// 归一化后数值间隔，单位秒。
	intervalSeconds: number;
};

// 设备轮询完成结果，下一步还需要token兑换。
type DeviceTokenSuccess = {
	// 服务器给的授权码。
	authorizationCode: string;
	// 服务器给的PKCE verifier，不由本地generatePKCE生成。
	codeVerifier: string;
};

// 只描述解码后可能存在的载荷字段，不验证token真实性。
type JwtPayload = {
	// 计算属性名使用命名空间常量，?允许整个认证子对象缺省。
	[JWT_CLAIM_PATH]?: {
		// 账号id也可缺省，后续需要它时再验证。
		chatgpt_account_id?: string;
	};
	// 索引签名允许其他未知字段，但不会自动信任其结构。
	[key: string]: unknown;
};

/**
 * 用已经加载的Node随机函数生成16字节hex state，返回字符串。
 * 引用尚未就绪则抛环境错误；例：state用于关联一次浏览器回调，不是access token，也不在此保存。
 */
function createState(): string {
	// 未加载到随机函数就拒绝，可能是环境不支持或异步导入尚未完成。
	if (!_randomBytes) {
		// 原错误统一称Node环境不可用，不据此断言一定运行在浏览器。
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	// 16随机字节编码为32个十六进制字符。
	return _randomBytes(16).toString("hex");
}

/**
 * 解析手动授权材料，返回可缺省code/state，无网络或state验证。
 * 顺序为完整URL、code#state、含code=的查询串、裸码；例：裸码不带state也能返回，实际调用方仅在state为真值时核对，不要求手工输入总带state。
 */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	// 去掉输入首尾空白。
	const value = input.trim();
	// 空输入返回空对象，调用处最终报缺授权码。
	if (!value) return {};

	// 先尝试绝对URL解析。
	try {
		// 可解析URL不在此验证origin/path。
		const url = new URL(value);
		// 返回URL查询材料，不自动验证state。
		return {
			// code缺失null转undefined。
			code: url.searchParams.get("code") ?? undefined,
			// state缺失null转undefined，空字符串仍保留。
			state: url.searchParams.get("state") ?? undefined,
		};
		// 不是URL时继续尝试其他形式。
	} catch {
		// not a URL
	}

	// 非URL含#时先按code#state拆，不再走查询串分支。
	if (value.includes("#")) {
		// 数组解构只取前两段，多余#之后被忽略。
		const [code, state] = value.split("#", 2);
		// 返回两段原文字，不额外trim每段。
		return { code, state };
	}

	// 有code=则当查询串。
	if (value.includes("code=")) {
		// URLSearchParams负责解析字段与转义。
		const params = new URLSearchParams(value);
		// 返回查询串中的可选材料。
		return {
			// 提取code，缺失为undefined。
			code: params.get("code") ?? undefined,
			// 提取state，缺失为undefined。
			state: params.get("state") ?? undefined,
		};
	}

	// 其他输入整段当裸code，不校验格式。
	return { code: value };
}

/**
 * 把token按点分成三段、atob解载荷并JSON.parse，返回断言的JwtPayload或null。
 * 只解码不验签、不校验issuer/过期/完整对象schema，也未额外做base64url字符替换；例：解析失败null，不能把提到accountId当身份真实性验证。
 */
function decodeJwt(token: string): JwtPayload | null {
	// 所有分段/解码/JSON异常都转换null。
	try {
		// 按点拆token文本，不做签名检查。
		const parts = token.split(".");
		// 只有恰好三段才继续。
		if (parts.length !== 3) return null;
		// 取中间载荷段，??为undefined兜空串。
		const payload = parts[1] ?? "";
		// 直接atob解码，没有额外标准化base64url或验证编码格式。
		const decoded = atob(payload);
		// JSON.parse后as只是载荷类型视图，不做字段schema验证。
		return JSON.parse(decoded) as JwtPayload;
		// 解析失败不向外抛。
	} catch {
		// 用null表示本函数没解析出载荷。
		return null;
	}
}

/**
 * 调用fetch并把signal已取消时的请求拒绝统一为Login cancelled，返回Response Promise。
 * 例：非2xx不会在这里抛错，仍需下层读取；没给signal不添超时，也不循环重试。
 */
async function fetchWithLoginCancellation(input: string, init: RequestInit): Promise<Response> {
	// 只包实际fetch异常。
	try {
		// await使fetch拒绝进入当前catch。
		return await fetch(input, init);
		// 网络/取消异常统一分流。
	} catch (error) {
		// 只有init.signal已中止才改成取消文字。
		if (init.signal?.aborted) {
			// 与宿主取消UI约定的错误消息。
			throw new Error("Login cancelled");
		}
		// 其他异常保留原值。
		throw error;
	}
}

/**
 * 读取token响应并映射内部OAuthToken，返回Promise；非2xx、坏JSON或缺关键字段拒绝。
 * access/refresh只做真值检查，类型断言不等于运行时字符串验证；expires_in只查number，不查正数/有限性。例：本地到期记录为现在加有效秒数，不提前减余量。
 */
async function readTokenResponse(response: Response, operation: TokenOperation): Promise<OAuthToken> {
	// 非2xx按token操作失败处理。
	if (!response.ok) {
		// 尽力读错误正文，读取失败用空串。
		const text = await response.text().catch(() => "");
		// 错误带exchange/refresh阶段、状态及正文/状态文字，不脱敏。
		throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`);
	}

	// 等待JSON解析，非法JSON会直接拒绝。
	const rawJson = await response.json();
	// as声明预期形状，不在运行时把任意JSON转换成合法对象。
	const json = rawJson as {
		// 可选access字段的声明，不是运行检查。
		access_token?: string;
		// 可选refresh字段的声明。
		refresh_token?: string;
		// 可选有效秒数的声明。
		expires_in?: number;
		// |null保留JSON可能为null的分支。
	} | null;
	// access/refresh仅做真值检查，有效期只查number，不额外检查有限/正数。
	if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		// 缺必需条件抛错并带JSON说明。
		throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}

	// 映射成内部驼峰token对象。
	return {
		// 保留远端access字段；依赖上面的真值检查，不是完整字符串schema验证。
		access: json.access_token,
		// 本次必须返回refresh字段，不会在缺失时沿用旧token。
		refresh: json.refresh_token,
		// 有效秒数乘1000加本地当前时间，不减提前刷新余量。
		expires: Date.now() + json.expires_in * 1000,
	};
}

/**
 * 用授权码、verifier和指定redirect_uri POST兑换token，返回内部OAuthToken Promise。
 * 固定client_id贯穿浏览器/设备码；例：设备路径必须用DEVICE_REDIRECT_URI，浏览器用REDIRECT_URI；不在此提取账号或存储。
 */
async function exchangeAuthorizationCode(
	// 授权码，来自浏览器/设备轮询。
	code: string,
	// 与本次challenge对应的verifier。
	verifier: string,
	// 根据浏览器/设备流程传不同redirect URI。
	redirectUri: string,
	// 调用方取消signal。
	signal: AbortSignal,
	// 异步返回内部token结构，不含后续提取的accountId。
): Promise<OAuthToken> {
	// 发授权码兑换HTTP，取消时用统一取消错误。
	const response = await fetchWithLoginCancellation(TOKEN_URL, {
		// POST提交表单。
		method: "POST",
		// 指定URL编码表单Content-Type。
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		// URLSearchParams负责表单字段转义。
		body: new URLSearchParams({
			// grant_type为authorization_code。
			grant_type: "authorization_code",
			// 固定Codex公开client_id。
			client_id: CLIENT_ID,
			// 授权码字段简写。
			code,
			// 提交本轮verifier。
			code_verifier: verifier,
			// 使用调用路径提供的redirect，不擅自改为默认。
			redirect_uri: redirectUri,
		}),
		// 透传总signal，没有独立超时。
		signal,
	});

	// 按exchange阶段读取/验证响应，返回token Promise。
	return readTokenResponse(response, "exchange");
}

/**
 * 用refresh token POST固定token端点，返回映射后的内部token。
 * fetch异常补token refresh error前缀，HTTP/JSON错误由readTokenResponse处理且不写stderr；例：没有自带重试/超时，调用方signal决定取消。
 */
async function refreshAccessToken(refreshToken: string, signal: AbortSignal): Promise<OAuthToken> {
	// 声明待赋值Response。
	let response: Response;
	// 只将fetch本身错误包装前缀。
	try {
		// 发刷新网络请求，没用登录取消文案helper。
		response = await fetch(TOKEN_URL, {
			// 采用POST。
			method: "POST",
			// URL编码表单头。
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			// 构建刷新表单。
			body: new URLSearchParams({
				// 固定刷新grant。
				grant_type: "refresh_token",
				// 提交旧refresh token。
				refresh_token: refreshToken,
				// 使用同一固定client_id。
				client_id: CLIENT_ID,
			}),
			// 调用方signal透传。
			signal,
		});
		// 网络/取消失败在这里统一加刷新错误前缀。
	} catch (error) {
		// Error或非Error都转可读文字，不写console.error。
		throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
	}

	// HTTP/JSON解析错误发生在前面catch之外，保留readTokenResponse的refresh错误。
	return readTokenResponse(response, "refresh");
}

/**
 * 申请Codex设备授权，返回设备id/用户码/轮询间隔；HTTP失败或关键字段无效拒绝。
 * 404特别提示改浏览器登录；间隔允许数字或可转数字的字符串，要求有限且>=0，码只查真值未完整验字符串。例："5"归一化为5秒，0随后由共享轮询器采用默认间隔。
 */
async function startOpenAICodexDeviceAuth(signal: AbortSignal): Promise<DeviceAuthInfo> {
	// 请求Codex设备授权材料，网络取消由helper规范化。
	const response = await fetchWithLoginCancellation(DEVICE_USER_CODE_URL, {
		// POST申请。
		method: "POST",
		// 这条设备端点用JSON，不是表单。
		headers: { "Content-Type": "application/json" },
		// 正文只含固定client_id。
		body: JSON.stringify({ client_id: CLIENT_ID }),
		// 透传总取消。
		signal,
	});

	// HTTP失败先看是否404的特殊诊断。
	if (!response.ok) {
		// 404单列为未启用设备登录的提示，给切换方式/检查地址建议，不进一步定位服务端根因。
		if (response.status === 404) {
			// 构建特殊Error。
			throw new Error(
				// 原提示给浏览器方式/服务地址建议，不在此自动切换。
				"OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.",
			);
		}
		// 其他失败尽力读正文，读不到用空串。
		const responseBody = await response.text().catch(() => "");
		// 构造通用设备申请失败Error。
		throw new Error(
			// 带状态与可选正文。
			`OpenAI Codex device code request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
		);
	}

	// 成功HTTP解析JSON，失败仍会拒绝。
	const rawJson = await response.json();
	// 为访问预期字段给类型视图，仍需后续运行检查。
	const json = rawJson as {
		// 预期设备授权id可缺省。
		device_auth_id?: string;
		// 预期用户短码可缺省。
		user_code?: string;
		// 远端interval可为数字或字符串。
		interval?: number | string;
		// 顶层视图也允许null。
	} | null;
	// 字符串先trim再Number转换，其他分支保留原值。
	const intervalSeconds = typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
	// 对必需真值和间隔数值规则组合校验。
	if (
		// 设备id仅检查非空真值，不完整验证字符串类型。
		!json?.device_auth_id ||
		// 用户短码同样只检查真值。
		!json.user_code ||
		// 间隔转换结果必须number。
		typeof intervalSeconds !== "number" ||
		// 排除Infinity和NaN。
		!Number.isFinite(intervalSeconds) ||
		// 允许0，但不允许负间隔。
		intervalSeconds < 0
	) {
		// 材料无效即拒绝，保留JSON说明。
		throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
	}

	// 返回内部驼峰字段结构。
	return {
		// 映射服务端device_auth_id。
		deviceAuthId: json.device_auth_id,
		// 映射user_code。
		userCode: json.user_code,
		// 保留已转数值的间隔。
		intervalSeconds,
	};
}

/**
 * 轮询Codex设备授权，得到授权码与服务器提供的verifier，返回DeviceTokenSuccess Promise。
 * 首轮立即请求，后续按间隔等，截止预算15分钟；403/404直接当pending，不先分析正文，其他pending/slow_down按错误码分流。
 * 例：成功还未取得access token，需要下一步兑换；截止只协调轮询与sleep，不能强停未响应signal的挂起fetch。
 */
async function pollOpenAICodexDeviceAuth(device: DeviceAuthInfo, signal: AbortSignal): Promise<DeviceTokenSuccess> {
	// 泛型限定完成值为授权码与verifier对象。
	return pollOAuthDeviceCodeFlow<DeviceTokenSuccess>({
		// 传设备申请得到的间隔；0由共享器补默认。
		intervalSeconds: device.intervalSeconds,
		// 固定15分钟轮询预算，不从响应取expires_in。
		expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
		// 未传waitBeforeFirstPoll，默认首轮立即执行。
		signal,
		// 每轮执行此异步回调。
		poll: async () => {
			// 向设备授权轮询端点发请求。
			const response = await fetchWithLoginCancellation(DEVICE_TOKEN_URL, {
				// POST轮询。
				method: "POST",
				// 正文是JSON。
				headers: { "Content-Type": "application/json" },
				// 序列化本轮材料。
				body: JSON.stringify({
					// 程序设备授权id。
					device_auth_id: device.deviceAuthId,
					// 此端点还需要用户短码。
					user_code: device.userCode,
				}),
				// 实际fetch观察总signal。
				signal,
			});

			// HTTP成功先处理授权材料。
			if (response.ok) {
				// 等待JSON读取，失败直接拒绝。
				const rawJson = await response.json();
				// 只给预期字段视图，不运行字符串schema校验。
				const json = rawJson as { authorization_code?: string; code_verifier?: string } | null;
				// 授权码/verifier只需为真值，未额外验证字符串。
				if (!json?.authorization_code || !json.code_verifier) {
					// 无效结果返回共享failed。
					return {
						// failed使共享器抛出文案。
						status: "failed",
						// 错误带原JSON表示。
						message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`,
					};
				}
				// 合法材料返回共享complete结果。
				return {
					// complete结束设备轮询。
					status: "complete",
					// 授权码和服务端verifier组成下一步兑换材料。
					value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier },
				};
			}

			// 任何403/404都直接当pending，不先看正文是否access_denied。
			if (response.status === 403 || response.status === 404) {
				// 等待后继续，不把这两个状态当终止失败。
				return { status: "pending" };
			}

			// 其他失败先读正文，保留可诊断内容。
			const responseBody = await response.text().catch(() => "");
			// 错误码来源可以是未知JSON，先声明unknown。
			let errorCode: unknown;
			// 可选解析错误JSON，失败仍保留原正文。
			try {
				// 允许error为字符串或含code对象的类型视图。
				const json = JSON.parse(responseBody) as { error?: string | { code?: string } } | null;
				// 读取error字段。
				const error = json?.error;
				// object时取error?.code，否则用error本身，未做完整schema检查。
				errorCode = typeof error === "object" ? error?.code : error;
				// 空catch只忽略错误JSON解析，不忽略外层HTTP失败。
			} catch {}

			// 特定pending错误码也继续等。
			if (errorCode === "deviceauth_authorization_pending") {
				// 共享pending结果。
				return { status: "pending" };
			}
			// 服务端要求减速。
			if (errorCode === "slow_down") {
				// 不提供显式新间隔，共享器按默认增量加5秒。
				return { status: "slow_down" };
			}

			// 其余状态终止设备授权。
			return {
				// failed分支标签。
				status: "failed",
				// 保留HTTP状态及可选响应正文。
				message: `OpenAI Codex device auth failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
			};
		},
	});
}

/**
 * 为浏览器登录生成PKCE/state和授权URL，返回三份材料Promise，无网络/存储。
 * originator默认pi，例：agentName=my-app成为originator查询参数，授权用固定client_id和localhost回调；不动态注册客户端。
 */
async function createAuthorizationFlow(
	// 可选应用来源名称，缺省值pi只在参数undefined时采用。
	originator: string = "pi",
	// 返回类型内联声明三份字符串材料；类型不会自动验证服务端响应。
): Promise<{ verifier: string; state: string; url: string }> {
	// 生成本地PKCE verifier与challenge。
	const { verifier, challenge } = await generatePKCE();
	// 为本次浏览器授权生成随机state。
	const state = createState();

	// 以固定授权端点建立URL。
	const url = new URL(AUTHORIZE_URL);
	// 请求授权码响应类型。
	url.searchParams.set("response_type", "code");
	// 固定客户端标识，不动态注册。
	url.searchParams.set("client_id", CLIENT_ID);
	// 登记固定localhost回调URI。
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	// 申请预设scope集合。
	url.searchParams.set("scope", SCOPE);
	// 把challenge放查询串，verifier留本地。
	url.searchParams.set("code_challenge", challenge);
	// 使用S256 PKCE方法。
	url.searchParams.set("code_challenge_method", "S256");
	// 加入待回调核对的state。
	url.searchParams.set("state", state);
	// 要求ID token携带组织信息的服务参数，本文件不解析组织列表。
	url.searchParams.set("id_token_add_organizations", "true");
	// 服务端Codex简化授权流程参数。
	url.searchParams.set("codex_cli_simplified_flow", "true");
	// 应用名称作为originator提示。
	url.searchParams.set("originator", originator);

	// 返回本地保留材料及可打开URL，不发网络。
	return { verifier, state, url: url.toString() };
}

/**
 * 从解码载荷的指定命名空间取非空chatgpt_account_id，返回字符串或null。
 * 例：只读account字段，不核验token签名或确认账号所属；其他载荷字段不会被复制到凭证。
 */
function getAccountId(accessToken: string): string | null {
	// 只解码载荷，不校验签名和远端身份。
	const payload = decodeJwt(accessToken);
	// 可选链按命名空间取认证子字段。
	const auth = payload?.[JWT_CLAIM_PATH];
	// 读取可能缺省账号id。
	const accountId = auth?.chatgpt_account_id;
	// 只接受非空字符串，空白串仍可通过；否则null。
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * 从内部token提账号id并建立统一OAuthCredential，无请求/存储，提不到id抛错。
 * 例：access/refresh/expires原样保留并附accountId；账号id来自本地解析，不是额外访问账户端点。
 */
function credentialsFromToken(token: OAuthToken): OAuthCredential {
	// 从新access载荷取账号id，不查询账户接口。
	const accountId = getAccountId(token.access);
	// 无法取出账号id就拒绝。
	if (!accountId) {
		// 不给旧id或占位id兜底。
		throw new Error("Failed to extract accountId from token");
	}

	// 组新的统一OAuthCredential。
	return {
		// 标记OAuth类别。
		type: "oauth",
		// 保留当前access。
		access: token.access,
		// 保留当前refresh。
		refresh: token.refresh,
		// 保留当前毫秒到期时刻。
		expires: token.expires,
		// 附本地提取的accountId扩展字段。
		accountId,
	};
}

/**
 * 组合授权码兑换与凭证包装，返回OAuthCredential Promise。
 * 例：先await HTTP兑换，再同步提accountId；任一步失败都拒绝，不会保存半成品token。
 */
async function exchangeAuthorizationCodeForCredentials(
	// 本轮授权码。
	code: string,
	// 本轮verifier。
	verifier: string,
	// 当前流程所需redirect_uri。
	redirectUri: string,
	// 整体取消signal。
	signal: AbortSignal,
	// 异步返回完整OAuth凭证，包含提取的accountId。
): Promise<OAuthCredential> {
	// await兑换后再包装；任一步错误都使Promise拒绝。
	return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, redirectUri, signal));
}

/**
 * 协调设备登录：申请设备材料、通知宿主、立即开始轮询授权码/verifier，再走设备redirect兑换凭证。
 * 返回统一credential，不启本地回调服务器、不使用本地生成的PKCE；例：无浏览器本机回调能力时仍可用别处网页输入短码。
 */
async function loginOpenAICodexDeviceCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 先申请设备id与用户短码。
	const device = await startOpenAICodexDeviceAuth(interaction.signal);
	// 通知宿主展示，不开本地回调服务器。
	interaction.notify({
		// device_code事件类型。
		type: "device_code",
		// 用户在网页输入的短码。
		userCode: device.userCode,
		// 固定设备验证网页。
		verificationUri: DEVICE_VERIFICATION_URI,
		// 申请到的间隔秒数供显示。
		intervalSeconds: device.intervalSeconds,
		// 本地固定15分钟有效期供显示。
		expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
	});
	// 立即开始设备授权轮询，拿授权码/verifier而不是最终access。
	const code = await pollOpenAICodexDeviceAuth(device, interaction.signal);
	// 再调用通用兑换与凭证包装。
	return exchangeAuthorizationCodeForCredentials(
		// 服务端给出的授权码。
		code.authorizationCode,
		// 服务端给出的verifier，与浏览器本地PKCE来源不同。
		code.codeVerifier,
		// 使用设备授权专属远端redirect URI。
		DEVICE_REDIRECT_URI,
		// 沿用总取消signal。
		interaction.signal,
	);
}

/**
 * 协调浏览器登录：生成材料，尝试固定端口回调，报告授权URL，等共享回调/手工材料并兑换凭证。
 * 回调启动的任何拒绝都降为undefined手动路径；手工state只有给出非空值才比较，裸码可省略；finally关闭已建立服务。
 * 例：端口占用继续允许粘贴URL。notify位于try前，其同步异常不受这里finally覆盖；共享等待helper也不强停不响应取消的交互。
 */
async function loginOpenAICodex(
	// 宿主交互与总signal。
	interaction: ProviderAuthInteraction,
	// 可选agentName影响浏览器originator。
	options?: LoginOptions,
	// 异步返回凭证；可选options不决定设备流程，设备选择在公共login中完成。
): Promise<OAuthCredential> {
	// 生成本次浏览器材料；options未给name时使用pi默认。
	const { verifier, state, url } = await createAuthorizationFlow(options?.agentName);
	// Port 1455 is shared with the Codex CLI; when it is taken, fall back to the pasted redirect URL.
	// 尝试建立本地回调服务。
	const callback = await startOAuthCallbackServer({
		// 页面显示名称为OpenAI。
		providerName: "OpenAI",
		// 监听host采用当前环境覆盖。
		host: getCallbackHost(),
		// 固定1455端口，不尝试随机备用端口。
		port: 1455,
		// 精确回调路径。
		path: "/auth/callback",
		// 配置state，使共享服务要求GET回调的state严格匹配。
		state,
		/**
		 * 回调complete只把code异步返回，不在HTTP handler内兑换token。
		 * 例：共享服务可能已发成功页，但外层兑换仍可失败，不能据页面声称登录凭证已保存。
		 */
		complete: async (code) => code,
		// 服务wait观察整体取消signal。
		signal: interaction.signal,
		// 任何启动拒绝都转undefined后走手动，并非只捕获端口占用。
	}).catch(() => undefined);

	// 此通知发生在try前，若同步抛错下面finally不会执行。
	interaction.notify({
		// 授权URL事件交宿主打开/展示。
		type: "auth_url",
		// 使用刚生成的完整URL。
		url,
		// 原文是UI操作说明，代码本身不直接启动浏览器。
		instructions: "A browser window should open. Complete login to finish.",
	});

	// 从等待阶段起保证已有callback最终请求关闭。
	try {
		// 同时启动手动输入；浏览器已认领时共享helper仍优先等其complete。
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			// 提示允许裸码或完整重定向URL。
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			// 固定redirect作为占位，不代表手工解析会验证其origin/path。
			placeholder: REDIRECT_URI,
		});
		// 声明最终code，可能来自回调或手工。
		let code: string | undefined;
		// 分辨联合结果来源。
		if (result.type === "callback") {
			// callback的complete只返回授权码，尚未兑换。
			code = result.value;
			// 否则处理手动输入材料。
		} else {
			// 支持URL、code#state、查询串与裸码解析。
			const parsed = parseAuthorizationInput(result.input);
			// 只有给出真值state才核对；缺失/空串不会被此行拒绝。
			if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
			// 取得可选授权码。
			code = parsed.code;
		}

		// code缺失或空串不能发兑换请求。
		if (!code) throw new Error("Missing authorization code");
		// 用本地verifier与固定浏览器redirect兑换并包装凭证。
		return await exchangeAuthorizationCodeForCredentials(code, verifier, REDIRECT_URI, interaction.signal);
		// 等候/兑换正常或异常都请求清理服务。
	} finally {
		// 启动失败时callback缺省，可选调用无动作；close不await所有连接关闭。
		callback?.close();
	}
}

/**
 * Refresh OpenAI Codex OAuth token
 */
/**
 * 用refresh token换内部token后重新提accountId并返回凭证Promise，无存储。
 * 例：新access缺可解析账号id会拒绝，不静默保留旧accountId。
 */
async function refreshOpenAICodexToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	// 先刷新token，再从新access重新提accountId。
	return credentialsFromToken(await refreshAccessToken(refreshToken, signal));
}

// 固定客户端的OAuthAuth适配对象。
export const openaiCodexOAuth: OAuthAuth = {
	// 登录列表显示名。
	name: "OpenAI (ChatGPT Plus/Pro)",
	// 订阅标记，不在此验证用户套餐。
	isSubscription: true,

	/**
	 * 请求宿主选择浏览器或设备码登录，再执行对应路径，返回凭证Promise。
	 * 例：列表首项browser只是交互呈现默认顺序，宿主返回未知字符串仍抛错，取消选择的拒绝原样传出。
	 */
	async login(interaction, options) {
		// 等待宿主选择登录方式，取消的拒绝直接传出。
		const method = await interaction.prompt({
			// select交互会返回选项id字符串。
			type: "select",
			// 给宿主的选择标题。
			message: "Select OpenAI Codex login method:",
			// 按此顺序展示两种方式，代码不自动猜选项。
			options: [
				// browser放第一项，label标为默认供宿主呈现。
				{ id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				// device_code适合无法接本机浏览器回调的场景。
				{ id: OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD, label: "Device code login (headless)" },
			],
		});

		// 明确设备码id才进设备流程。
		if (method === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD) {
			// 返回设备登录Promise，不创建浏览器PKCE/state服务。
			return loginOpenAICodexDeviceCode(interaction);
		}
		// 其余也必须等于browser，不把任意值视默认。
		if (method !== OPENAI_CODEX_BROWSER_LOGIN_METHOD) {
			// 未知选择抛错。
			throw new Error(`Unknown OpenAI Codex login method: ${method}`);
		}

		// 选择browser后调用本地回调/手动流程。
		return loginOpenAICodex(interaction, options);
	},

	/**
	 * 统一刷新回调从credential取refresh，透传signal，返回下层凭证Promise。
	 * 例：expires是否快到期由外层决定，不在这里触发额外认证检查。
	 */
	refresh: (credential, signal) => refreshOpenAICodexToken(credential.refresh, signal),

	/**
	 * 将credential.access映射通用apiKey，返回Promise，无网络/过期检查。
	 * 例：accountId仍存凭证供其他层使用，本方法返回对象不包含账号字段。
	 */
	async toAuth(credential) {
		// 仅把access映射apiKey，accountId未包含在此结果对象中。
		return { apiKey: credential.access };
	},
};
