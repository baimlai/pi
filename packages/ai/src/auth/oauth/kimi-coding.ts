// Kimi订阅设备登录和刷新适配：把远端JSON校验为统一OAuth凭证，请求时提供Bearer头；不在本文件写凭证存储。
/**
 * Kimi Code (subscription) OAuth flow
 *
 * RFC 8628 device authorization grant against https://auth.kimi.com with JSON
 * responses. The access token authenticates requests to
 * https://api.kimi.com/coding as an `Authorization: Bearer` header.
 */

// 通过统一helper读进程环境，保留Bun沙箱回退逻辑。
import { getProviderEnvValue } from "../../utils/provider-env.ts";
// 可取消sleep用于刷新失败后的指数退避。
import { sleep } from "../../utils/sleep.ts";
// type导入仅供编译期认证契约，不生成运行时检查。
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 共用设备授权的等待、取消与截止协调。
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
// 把远端浏览器地址限制为可解析HTTP(S)，不是Kimi域名白名单。
import { trustedHttpUrl } from "./trusted-url.ts";

// 公开订阅客户端id，不是用户密钥。
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
// 未配置环境覆盖时的OAuth根地址。
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
// 远端未给合法有效期时，设备流程默认15分钟。
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
// 远端未给合法间隔时，默认每5秒轮询。
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// 单次fetch的30秒期限，单位毫秒。
const REQUEST_TIMEOUT_MS = 30 * 1000;
// 允许额外3次刷新尝试，连首次最多4次。
const REFRESH_MAX_RETRIES = 3;

// 设备响应的内部类型；实际JSON由下面入口校验。
type DeviceAuthorization = {
	// 后续token轮询使用的设备码。
	deviceCode: string;
	// 网页授权时展示给用户的短码。
	userCode: string;
	// 不含预填短码的验证地址。
	verificationUri: string;
	// 含预填信息的完整地址，当前通知宿主使用这一项。
	verificationUriComplete: string;
	// 归一化后必有轮询间隔，单位秒。
	intervalSeconds: number;
	// 归一化后必有有效期，单位秒。
	expiresInSeconds: number;
};

// 内部token结果，区别远端snake_case JSON。
type TokenResponse = {
	// 调用推理接口的access token。
	access: string;
	// 下一次换发token使用的refresh token。
	refresh: string;
	// 毫秒过期时间戳，不是剩余秒数。
	expires: number;
};

/**
 * 选择OAuth服务根地址，返回去末尾斜杠的字符串，无网络。
 * KIMI_CODE_OAUTH_HOST优先，再KIMI_OAUTH_HOST，最后默认；例：覆盖为https://auth.example/得到https://auth.example，不校验域名或协议。
 */
function getOauthHost(): string {
	// ||按真值短路，第一项无值才看旧覆盖变量。
	const override = getProviderEnvValue("KIMI_CODE_OAUTH_HOST") || getProviderEnvValue("KIMI_OAUTH_HOST");
	// 覆盖/默认根地址去所有尾部斜杠，便于下面追加/api路径。
	return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

/**
 * 合并总取消与本次30秒超时，返回新signal。
 * 例：刷新有多次尝试，每次fetch重新建立30秒限制，不给整个重试循环加统一30秒期限。
 */
function requestSignal(signal: AbortSignal): AbortSignal {
	// 任一signal触发即中止；timeout每次调用新建。
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

/**
 * 把字符串字典编码为表单文字，不发请求。
 * Record<string,string>约束字段值类型；例：空格由URLSearchParams按表单规则编码，避免手工拼接破坏参数。
 */
function formUrlEncode(fields: Record<string, string>): string {
	// URLSearchParams负责转义，再转字符串作为表单正文。
	return new URLSearchParams(fields).toString();
}

/**
 * 读取JSON并尝试取得字典视图，返回对象或null；读取/解析失败转null。
 * 例：非法JSON不会在此继续抛出；object判断仍接受数组，不证明其中token字段合法。
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	// JSON正文读取也可能失败，因此在try内等待。
	try {
		// 消费响应正文并解析JavaScript值。
		const json = await response.json();
		// 检查非空object后断言字典视图；数组也属于object，字段仍unknown。
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
		// 读取或解析失败都归到这一分支。
	} catch {
		// null使后续调用按缺字段诊断。
		return null;
	}
}

/**
 * 向给定OAuth根地址申请设备码，校验两种码及两个HTTP(S)浏览器地址，返回设备材料。
 * 无效间隔回退5秒、有效期回退15分钟；非2xx/无效必需字段拒绝。例：这里同时要求基础与完整验证URI，并不只用一个可用URI兜底。
 */
async function startDeviceAuthorization(oauthHost: string, signal: AbortSignal): Promise<DeviceAuthorization> {
	// 对所选根地址发设备授权POST，网络失败直接拒绝。
	const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
		// 申请设备授权使用POST。
		method: "POST",
		// 指定表单编码和JSON响应偏好。
		headers: {
			// 正文是URL编码表单。
			"Content-Type": "application/x-www-form-urlencoded",
			// 请求服务返回JSON，后面仍需验证。
			Accept: "application/json",
		},
		// 只提交公开client_id，不提交用户token。
		body: formUrlEncode({ client_id: CLIENT_ID }),
		// 本次请求合并总取消及30秒期限。
		signal: requestSignal(signal),
	});

	// 先判断HTTP成功，再解析成功材料。
	if (!response.ok) {
		// 失败正文读取也可能拒绝，用空串兜底。
		const text = await response.text().catch(() => "");
		// 错误包括状态及可读正文，无正文时不加冒号。
		throw new Error(`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}

	// 成功HTTP若JSON无效，readJson返回null。
	const json = await readJson(response);
	// 设备码保持unknown，下面收窄。
	const deviceCode = json?.device_code;
	// 用户短码保持unknown，下面收窄。
	const userCode = json?.user_code;
	// 基础验证地址经HTTP(S)解析和规范化。
	const verificationUri = trustedHttpUrl(json?.verification_uri);
	// 完整验证地址也要独立通过相同规则。
	const verificationUriComplete = trustedHttpUrl(json?.verification_uri_complete);
	// 两种码检查字符串类型；本处未额外排除空字符串，但两个URL必须有效。
	if (typeof deviceCode !== "string" || typeof userCode !== "string" || !verificationUri || !verificationUriComplete) {
		// 缺必需字段时拒绝，附JSON原值的表示。
		throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
	}

	// 保留远端原始间隔以决定是否回退。
	const interval = json?.interval;
	// 保留远端原始有效期以决定是否回退。
	const expiresIn = json?.expires_in;
	// 返回内部驼峰命名的设备对象。
	return {
		// deviceCode属性简写。
		deviceCode,
		// userCode属性简写。
		userCode,
		// 保存规范化基础URI。
		verificationUri,
		// 保存规范化完整URI。
		verificationUriComplete,
		// 归一化间隔字段，下面三元表达式给数值。
		intervalSeconds:
			// 只接收有限正数，不转字符串，也不用零间隔。
			typeof interval === "number" && Number.isFinite(interval) && interval > 0
				? // 合法则采用远端间隔。
					interval
				: // 否则用5秒默认。
					DEFAULT_POLL_INTERVAL_SECONDS,
		// 归一化设备授权有效期。
		expiresInSeconds:
			// 同样只接受有限正数。
			typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
				? // 有效远端秒数优先。
					expiresIn
				: // 否则回退15分钟。
					DEVICE_CODE_TIMEOUT_SECONDS,
	};
}

/**
 * 校验token响应的非空access/refresh和有限正有效秒数，返回内部token对象。
 * operation仅进入错误文字；例：expires_in=60转为本地现在加60秒，未在此减提前刷新余量；字符串数字不接受，正文错误不脱敏。
 */
function parseTokenResponse(json: Record<string, unknown> | null, operation: string): TokenResponse {
	// 读取尚待验证的access token。
	const accessToken = json?.access_token;
	// 读取尚待验证的refresh token。
	const refreshToken = json?.refresh_token;
	// 读取相对有效秒数。
	const expiresIn = json?.expires_in;
	// 任一必需条件不满足就拒绝整个响应。
	if (
		// access必须是字符串。
		typeof accessToken !== "string" ||
		// 空access也不接受；空白串仍是真值。
		!accessToken ||
		// refresh必须是字符串。
		typeof refreshToken !== "string" ||
		// 空refresh不接受；刷新时也不自动沿用旧值。
		!refreshToken ||
		// 有效期必须为数字。
		typeof expiresIn !== "number" ||
		// 排除Infinity和NaN。
		!Number.isFinite(expiresIn) ||
		// 有效期必须严格大于0。
		expiresIn <= 0
	) {
		// 错误带操作阶段及JSON内容，不做内容脱敏。
		throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}
	// 创建通过检查后的内部token结构。
	return {
		// 远端access_token映射为access。
		access: accessToken,
		// 远端refresh_token映射为refresh。
		refresh: refreshToken,
		// 秒乘1000换毫秒，再加当前时间得到到期点。
		expires: Date.now() + expiresIn * 1000,
	};
}

/**
 * 按设备材料轮询token，返回完整TokenResponse；先等一次间隔，处理pending/slow_down与明确拒绝/过期。
 * 例：500直接终止，不沿用刷新入口的重试策略；成功HTTP也必须过parseTokenResponse。轮询期限不强行中断已经开始的poll，fetch另有30秒限制。
 */
async function pollForToken(
	// 本次OAuth服务根地址。
	oauthHost: string,
	// 已经归一化的设备码、间隔、有效期。
	device: DeviceAuthorization,
	// 调用方的整体取消信号。
	signal: AbortSignal,
	// 异步完成值为已验证的TokenResponse，之后登录入口再封装OAuthCredential。
): Promise<TokenResponse> {
	// 泛型规定complete携带TokenResponse，共享轮询器不替本文件校验token字段。
	return pollOAuthDeviceCodeFlow<TokenResponse>({
		// 采用申请阶段算好的间隔秒数。
		intervalSeconds: device.intervalSeconds,
		// 采用申请阶段算好的有效秒数。
		expiresInSeconds: device.expiresInSeconds,
		// 首次轮询前也等待该间隔。
		waitBeforeFirstPoll: true,
		// 整体取消贯穿轮询与sleep。
		signal,
		// 每次轮询实际执行这个异步回调。
		poll: async () => {
			// 向当前OAuth服务请求设备token。
			const response = await fetch(`${oauthHost}/api/oauth/token`, {
				// 采用POST提交grant表单。
				method: "POST",
				// 准备表单编码与JSON响应头。
				headers: {
					// 与formUrlEncode产生的正文匹配。
					"Content-Type": "application/x-www-form-urlencoded",
					// 期望JSON响应。
					Accept: "application/json",
				},
				// 构造本轮设备token表单。
				body: formUrlEncode({
					// 携带公开client_id。
					client_id: CLIENT_ID,
					// 使用设备码，而不是显示短码。
					device_code: device.deviceCode,
					// 固定为设备授权grant。
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				// 每次请求分别限制30秒并观察整体取消。
				signal: requestSignal(signal),
			});

			// 服务器错误在设备轮询中直接失败，不走刷新重试。
			if (response.status >= 500) {
				// 尽力读错误正文，读取失败用空串。
				const text = await response.text().catch(() => "");
				// 以共享失败结果结束轮询。
				return {
					// failed字面量标识不可继续。
					status: "failed",
					// 附状态和可读正文。
					message: `Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ""}`,
				};
			}

			// 读取成功/客户端错误的JSON供后续分流。
			const json = await readJson(response);
			// HTTP成功且access字段是字符串才进入完整校验。
			if (response.ok && typeof json?.access_token === "string") {
				// 完整字段检查抛错转换成共享failed结果。
				try {
					// 通过parseTokenResponse才标complete并返回三个token字段。
					return { status: "complete", value: parseTokenResponse(json, "poll") };
					// 捕获字段验证错误。
				} catch (error) {
					// 把任意抛出值转失败文字，不继续pending。
					return { status: "failed", message: error instanceof Error ? error.message : String(error) };
				}
			}

			// 读取远端OAuth错误码，仍可能缺失或非字符串。
			const error = json?.error;
			// 只有字符串description才附错误说明。
			const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
			// 尚待用户确认的分支。
			if (error === "authorization_pending") {
				// 保持当前间隔，等下一轮。
				return { status: "pending" };
			}
			// 服务器要求降低轮询频率。
			if (error === "slow_down") {
				// 取可选新间隔，交共享器进一步归一化。
				const interval = json?.interval;
				// 构造slow_down结果。
				return {
					// 告知共享器修改等待策略。
					status: "slow_down",
					// 本层只检查数字且正；有限性由共享轮询器继续处理。
					intervalSeconds: typeof interval === "number" && interval > 0 ? interval : undefined,
				};
			}
			// 设备授权过期的分支。
			if (error === "expired_token") {
				// 立即终止并提示重新登录。
				return { status: "failed", message: "Kimi Code device authorization expired. Please restart login." };
			}
			// 用户拒绝授权的分支。
			if (error === "access_denied") {
				// 立即终止，不重试这一设备授权。
				return { status: "failed", message: "Kimi Code login was denied." };
			}
			// 其他错误统一终止。
			return {
				// failed让共享器拒绝返回Promise。
				status: "failed",
				// 附HTTP状态，error为字符串时再附错误码/说明。
				message: `Kimi Code device token request failed (status ${response.status})${typeof error === "string" ? `: ${error}${description}` : ""}`,
			};
		},
	});
}

/**
 * 只按HTTP状态判断刷新是否适合重试，返回boolean，不读取正文。
 * 例：429与>=500为true；网络异常由refreshToken另行捕获，401在调用处单独终止。
 */
function isRetryableRefreshFailure(response: Response): boolean {
	// 只把429和>=500视为可重试HTTP状态。
	return response.status === 429 || response.status >= 500;
}

/**
 * 用旧refresh token请求新token，最多首次加3次重试，返回校验后的TokenResponse。
 * 网络/请求取消异常先保存再下一轮，429/5xx按1/2/4秒退避；总signal取消在sleep或下一次检查终止。401/403/invalid_grant及成功HTTP的无效字段立即拒绝。
 * 例：第一次429、第二次200时等1秒；这里不保存或删除credential，原英语提Models的后续处理应结合外层策略理解。
 */
async function refreshToken(oauthHost: string, refreshTokenValue: string, signal: AbortSignal): Promise<TokenResponse> {
	// 保存最后一次网络/可重试HTTP错误，可能尚未赋值。
	let lastError: Error | undefined;
	// 从0开始，<=3使首次加3次重试，总计最多4轮。
	for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
		// 只有额外尝试才先退避，首次直接请求。
		if (attempt > 0) {
			// **是幂运算，第1/2/3次额外尝试前等1/2/4秒；sleep可被整体signal中止。
			await sleep(1000 * 2 ** (attempt - 1), signal);
		}
		// 等待后再查整体取消，避免继续发请求。
		if (signal.aborted) {
			// 抛明确刷新取消错误。
			throw new Error("Kimi Code token refresh aborted");
		}

		// 声明本轮Response，只有fetch成功才赋值。
		let response: Response;
		// 这里只捕获fetch本身异常，不覆盖后面的token字段验证。
		try {
			// 对当前根地址发刷新请求。
			response = await fetch(`${oauthHost}/api/oauth/token`, {
				// 采用POST。
				method: "POST",
				// 准备URL编码表单和JSON响应偏好。
				headers: {
					// 正文使用表单编码。
					"Content-Type": "application/x-www-form-urlencoded",
					// 期望JSON返回。
					Accept: "application/json",
				},
				// 构造刷新grant的正文。
				body: formUrlEncode({
					// 使用同一公开客户端id。
					client_id: CLIENT_ID,
					// grant明确是refresh_token，不是设备授权。
					grant_type: "refresh_token",
					// 提交传入的旧refresh token。
					refresh_token: refreshTokenValue,
				}),
				// 整体取消与本次30秒超时合并。
				signal: requestSignal(signal),
			});
			// 网络/超时/请求取消异常都会先进入本分支。
		} catch (error) {
			// 保留Error或把其他抛出值包装为Error。
			lastError = error instanceof Error ? error : new Error(String(error));
			// 转下一轮，剩余预算允许时再退避；最后一轮则随后退出循环。
			continue;
		}

		// 读取JSON失败为null，后续按HTTP状态或缺字段处理。
		const json = await readJson(response);
		// HTTP成功时直接解析token，不因字段无效再重试。
		if (response.ok) {
			// 校验成功返回；校验异常在当前try之外，会向外拒绝。
			return parseTokenResponse(json, "refresh");
		}

		// Unauthorized: the stored credential is dead; Models clears it and prompts re-login.
		// 401/403或invalid_grant立即终止，具体清理/提示由外层决定。
		if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant") {
			// 远端描述是字符串才附上。
			const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
			// 以unauthorized错误拒绝，不在这里删除credential。
			throw new Error(`Kimi Code token refresh unauthorized (status ${response.status})${description}`);
		}

		// 429/5xx还需有剩余预算才进入重试分支。
		if (isRetryableRefreshFailure(response) && attempt < REFRESH_MAX_RETRIES) {
			// 记住可重试HTTP错误，以备后续全部网络失败时返回。
			lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`);
			// 进入下一轮并执行相应退避。
			continue;
		}

		// 其他HTTP错误把已解析JSON转字符串供错误说明。
		const text = JSON.stringify(json);
		// 抛状态与JSON说明，不继续重试。
		throw new Error(`Kimi Code token refresh failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}

	// 四轮网络等异常耗尽后抛最后错误；??只在没错误时用固定兜底。
	throw lastError ?? new Error("Kimi Code token refresh failed");
}

/**
 * 协调订阅设备登录：选根地址、申请设备码、通知宿主展示完整URI，再轮询并包装凭证。
 * 返回OAuthCredential，不调用prompt、不保存；例：宿主收到device_code事件后负责打开网页，token结果存access/refresh/expires。
 */
async function loginKimiCoding(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 当前环境覆盖决定本次OAuth根地址。
	const oauthHost = getOauthHost();
	// 申请设备授权信息，包含归一化后间隔与有效期。
	const device = await startDeviceAuthorization(oauthHost, interaction.signal);
	// 发送宿主通知，不直接启动浏览器进程。
	interaction.notify({
		// 事件类型为device_code。
		type: "device_code",
		// 用户网页授权需要的短码。
		userCode: device.userCode,
		// 使用完整验证URI，可能已预填用户短码。
		verificationUri: device.verificationUriComplete,
		// 提供间隔秒数便于展示。
		intervalSeconds: device.intervalSeconds,
		// 提供设备授权有效秒数。
		expiresInSeconds: device.expiresInSeconds,
	});
	// 等待轮询拿到经过校验的完整token。
	const token = await pollForToken(oauthHost, device, interaction.signal);
	// 统一credential类型，不直接返回内部TokenResponse。
	return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
}

// 认证适配对象，外层Models持有它并负责存储/调度。
export const kimiCodingOAuth: OAuthAuth = {
	// 登录列表展示名称。
	name: "Kimi Code (subscription)",
	// 订阅标记并非本地校验订阅有效性。
	isSubscription: true,
	// 宿主登录按钮文案。
	loginLabel: "Sign in with Kimi Code",

	// 传登录函数引用，导入模块时不会启动设备流程。
	login: loginKimiCoding,

	/**
	 * 刷新适配从当前环境重新选OAuth根地址，以credential.refresh换新token并返回统一凭证。
	 * 例：环境覆盖在登录后改变会影响本次刷新端点；本函数不沿用旧credential的额外字段，也不在此写存储。
	 */
	refresh: async (credential, signal) => {
		// 延后到调用时使用当前根地址与旧refresh换新token。
		const token = await refreshToken(getOauthHost(), credential.refresh, signal);
		// 用新token字段重建credential，不复制旧对象的额外数据。
		return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
	},

	/**
	 * 从access构造Bearer认证头，返回AuthResult的Promise，无网络或到期检查。
	 * 例：access="abc"得到Authorization:"Bearer abc"；这里返回headers而非apiKey，供最终供应商请求使用。
	 */
	async toAuth(credential) {
		// 生成Authorization头，不额外设置apiKey或检查远端有效性。
		return { headers: { Authorization: `Bearer ${credential.access}` } };
	},
};
