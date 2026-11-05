// xAI订阅设备授权适配：校验远端材料、轮询token、刷新并转通用apiKey；实际凭证持久化与提前刷新调度由外层负责。
/**
 * xAI OAuth device-code flow.
 */

// 仅导入认证类型，编译后擦除。
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 共享轮询器提供间隔等待、slow_down及截止规则。
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

// 公开客户端id，不是用户secret。
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
// 申请的scope包括离线刷新与API访问，是否授予由服务端决定。
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
// 固定设备码申请端点。
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
// 设备token和刷新共用的token端点。
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
// Refresh slightly before the reported expiry to avoid using a token that dies mid-request.
// 把本地到期时刻前移5分钟，不保证长请求不会跨远端真实有效期。
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// 响应省略expires_in时按3600秒估算。
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

// Record字典的每个远端字段为unknown，使用前需收窄。
type JsonObject = Record<string, unknown>;

// 内部HTTP结果，保留状态而非一见非2xx就抛错。
type OAuthHttpResponse = {
	// 是否HTTP 2xx。
	ok: boolean;
	// 具体HTTP状态码，供错误分流。
	status: number;
	// 归一化后的远端JSON字段字典。
	body: JsonObject;
};

// 已验证并改用驼峰名称的设备材料类型。
type XaiDeviceCode = {
	// 程序后续提交的设备码。
	deviceCode: string;
	// 用户网页授权需要的短码。
	userCode: string;
	// 必需的基础https验证地址。
	verificationUri: string;
	// ?表示可缺省完整URI。
	verificationUriComplete?: string;
	// 可缺省间隔，单位秒，缺省交共享器补默认。
	intervalSeconds?: number;
	// 必需的正有效秒数。
	expiresInSeconds: number;
};

/**
 * 从未知字段字典按名读取非空字符串，返回收窄后的值，不发请求。
 * 例：空串/缺失抛字段错误；空白串仍接受，不在此trim或验证token格式。
 */
function requiredString(body: JsonObject, field: string): string {
	// 方括号按运行时field名读取unknown字段。
	const value = body[field];
	// 只接收长度非零的字符串，不trim。
	if (typeof value !== "string" || value.length === 0) {
		// 无效时抛具体字段错误，不能返回伪造token。
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	// 条件后TS已把value收窄为string。
	return value;
}

/**
 * 读取并验证有限正数，返回number，无I/O。
 * 例：expires_in=3600接受，字符串"3600"、0、Infinity均抛错；不是TypeScript类型断言代替运行校验。
 */
function positiveNumber(body: JsonObject, field: string): number {
	// 读取尚未验证的数值字段。
	const value = body[field];
	// 同时排除非数字、NaN/Infinity和非正数。
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		// 不满足即抛字段错误。
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	// 条件后value为合法number返回。
	return value;
}

// The verification URI is opened in the user's browser; force it to be an https URL
// so a malicious response cannot make `open` launch something else.
/**
 * 解析浏览器验证地址并限定https协议，返回规范化href，解析/协议不符抛错。
 * 例：http://...被拒绝；任意https域名仍可通过，不是xAI域名白名单，也不在此打开地址。
 */
function validateVerificationUri(raw: string): string {
	// 先声明URL变量，成功解析后再赋值。
	let url: URL;
	// URL构造可抛解析异常，需在边界捕获。
	try {
		// 解析绝对地址，URL负责标准化。
		url = new URL(raw);
		// 不合法地址转换成统一错误。
	} catch {
		// 仅说明验证URI未通过规则，不在此证明域名恶意。
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	// 精确比较协议为https:，http也不接受。
	if (url.protocol !== "https:") {
		// 协议不符时拒绝，避免宿主把其他scheme交系统打开。
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	// 返回规范化URL文字，而不是原始输入。
	return url.href;
}

/**
 * 向给定URL POST字符串表单，读取并归一化JSON，返回HTTP状态与字典。
 * 用户取消统一为Login cancelled；非2xx仍返回给业务层，非法JSON抛错。例：合法JSON数组会变{}，后续必需字段验证再失败；没有独立请求超时。
 */
async function postForm(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<OAuthHttpResponse> {
	// Response稍后由fetch赋值。
	let response: Response;
	// try仅包fetch，后面JSON读取另有catch。
	try {
		// 对所给URL发实际网络请求。
		response = await fetch(url, {
			// 固定POST。
			method: "POST",
			// 声明表单编码与JSON响应偏好。
			headers: {
				// 期望JSON，真实正文仍需解析。
				Accept: "application/json",
				// 配合URLSearchParams表单正文。
				"Content-Type": "application/x-www-form-urlencoded",
			},
			// URLSearchParams负责字段转义，直接作为fetch的BodyInit。
			body: new URLSearchParams(fields),
			// 原样传取消信号，未另设timeout。
			signal,
		});
		// fetch的网络/取消失败进入这里。
	} catch (error) {
		// 调用方signal已取消时优先给取消文案。
		if (signal.aborted) {
			// UI可识别Login cancelled。
			throw new Error("Login cancelled");
		}
		// 非取消保留原异常。
		throw error;
	}

	// 声明正文的内部字典类型。
	let body: JsonObject;
	// JSON正文读取/解析也可能失败。
	try {
		// 先把解析值视为unknown，不信任远端形状。
		const parsed = (await response.json()) as unknown;
		// 非空object且非数组才保留，其他合法JSON变成空字典。
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
		// 读取/解析异常走统一错误，而非静默{}。
	} catch {
		// JSON读取期间也可能收到取消。
		if (signal.aborted) {
			// 取消仍使用统一取消文案。
			throw new Error("Login cancelled");
		}
		// 其他解析失败带HTTP状态方便诊断。
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}
	// 成功读完JSON后返回HTTP与业务字段，尚未验证token。
	return {
		// 保留Response.ok。
		ok: response.ok,
		// 保留数值状态。
		status: response.status,
		// body属性简写。
		body,
	};
}

/**
 * 从HTTP结果构造带阶段、状态及可读OAuth字段的Error，返回而不抛出。
 * 例：调用方throw requestFailure(...)才真正拒绝流程；仅接受字符串error/description，不递归或脱敏。
 */
function requestFailure(action: string, response: OAuthHttpResponse): Error {
	// 字符串error才可用作可读错误码。
	const error = typeof response.body.error === "string" ? response.body.error : undefined;
	// 单独取得可选description。
	const description =
		// 非字符串description不插入错误文字。
		typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	// filter(Boolean)去缺失/空串，再以冒号连接两段。
	const detail = [error, description].filter(Boolean).join(": ");
	// 只构造Error，不在此throw；详细内容未脱敏。
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

/**
 * 校验设备材料，返回内部XaiDeviceCode，字段失败直接抛错。
 * 基础URI必需且只接受https；完整URI可缺省，但提供非空字符串时不合法就失败，不回退基础URI；例：interval=0改undefined，轮询器用默认5秒。
 */
function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	// RFC 8628 allows interval 0 (no minimum wait); fall back to the poller's
	// default instead of failing on non-positive or malformed values.
	// 取原始interval，0等无效值不会直接导致设备响应失败。
	const interval = body.interval;
	// 计算可选合法间隔。
	const intervalSeconds =
		// 有限正数才采用，否则undefined由共享器补默认。
		typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined;
	// 完整验证URI是可选字段。
	const verificationUriComplete =
		// 仅非空字符串才尝试验证；其他类型视为没给。
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
			? // 给了字符串但不是https时在这里抛错，不回退。
				validateVerificationUri(body.verification_uri_complete)
			: // 没提供有效类型的非空字符串则保留undefined。
				undefined;
	// 组装内部设备对象，必需字段逐一验证。
	return {
		// 设备码必须为非空字符串。
		deviceCode: requiredString(body, "device_code"),
		// 用户短码同样要求非空字符串。
		userCode: requiredString(body, "user_code"),
		// 基础URI即便有完整URI也必须存在且通过https规则。
		verificationUri: validateVerificationUri(requiredString(body, "verification_uri")),
		// 保存可选完整URI。
		verificationUriComplete,
		// 保存可选间隔。
		intervalSeconds,
		// 设备授权有效期必须有限且正，缺省也会抛错。
		expiresInSeconds: positiveNumber(body, "expires_in"),
	};
}

/**
 * 把token字段校验并转为OAuthCredential，过期时间提前5分钟，返回新对象不保存。
 * 刷新响应缺refresh_token且有旧值时沿用，明确空串仍失败；expires_in缺省才用1小时。例：缺有效期的token本地按55分钟后过期，外层还有自己的刷新窗口。
 */
function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredential {
	// access_token为必需非空字符串。
	const access = requiredString(body, "access_token");
	// xAI may omit refresh_token on refresh when the token is not rotated.
	// 按是否缺省远端refresh_token决定沿用或重读。
	const refresh =
		// 必须远端为undefined且旧值为真值才沿用；null/空串不会走沿用。
		body.refresh_token === undefined && previousRefreshToken
			? // 沿用原refresh token字符串。
				previousRefreshToken
			: // 否则验证本次远端refresh_token。
				requiredString(body, "refresh_token");
	// 计算相对有效秒数。
	const expiresInSeconds =
		// 只有undefined用3600秒；明确null或不合法数值拒绝。
		body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : positiveNumber(body, "expires_in");
	// 新建统一OAuth凭证对象。
	return {
		// 字面量type用于外层认证分流。
		type: "oauth",
		// 保存当前access。
		access,
		// 保存新值或沿用的refresh。
		refresh,
		// 秒转毫秒，加当前时间，再减本地5分钟余量。
		expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
	};
}

/**
 * 申请设备授权并校验成功材料，返回设备对象Promise；HTTP非2xx抛阶段错误。
 * 例：请求包含client_id、scope与referrer=pi；只申请设备码，不在此轮询或展示网页。
 */
async function requestDeviceCode(signal: AbortSignal): Promise<XaiDeviceCode> {
	// 发申请设备码的表单HTTP请求。
	const response = await postForm(
		// 使用固定申请端点。
		XAI_DEVICE_CODE_URL,
		// 表单字段均是字符串。
		{
			// 公开客户端标识。
			client_id: XAI_CLIENT_ID,
			// 申请预设scope集合。
			scope: XAI_SCOPE,
			// 附应用来源pi。
			referrer: "pi",
		},
		// 原样透传总取消。
		signal,
	);
	// HTTP非2xx先转业务错误，不尝试当设备材料使用。
	if (!response.ok) {
		// throw才使requestFailure创建的Error真正拒绝流程。
		throw requestFailure("device authorization", response);
	}
	// 成功HTTP也需验证设备字段，返回内部对象。
	return parseDeviceCode(response.body);
}

/**
 * 按设备间隔/有效期轮询完整OAuth凭证，先等待一次间隔，返回凭证Promise。
 * pending继续，slow_down交共享器调整，拒绝/过期/其他错误终止；例：HTTP成功仍须token字段校验。截止不会主动打断已挂起的fetch，本文件只传调用方signal。
 */
async function pollForTokens(device: XaiDeviceCode, signal: AbortSignal): Promise<OAuthCredential> {
	// 泛型complete结果是OAuthCredential，不由共享器验证其JSON来源。
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		// 应用已解析设备间隔。
		intervalSeconds: device.intervalSeconds,
		// 应用已解析设备有效期。
		expiresInSeconds: device.expiresInSeconds,
		// 第一次轮询前也等待间隔。
		waitBeforeFirstPoll: true,
		// 总signal控制轮询sleep与取消检查。
		signal,
		// 每轮异步请求并返回共享结果标签。
		poll: async () => {
			// 向token端点POST当前设备授权材料。
			const response = await postForm(
				// 使用固定token端点。
				XAI_TOKEN_URL,
				// 本轮请求正文表单。
				{
					// 固定设备授权grant类型。
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					// 相同公开client_id。
					client_id: XAI_CLIENT_ID,
					// 提交程序设备码，不提交用户短码。
					device_code: device.deviceCode,
				},
				// fetch也观察相同总signal。
				signal,
			);

			// HTTP成功时不再按error字段分流。
			if (response.ok) {
				// 先校验token字段，成功才返回complete；校验抛错直接终止。
				return { status: "complete", value: credentialsFromTokenResponse(response.body) };
			}

			// HTTP失败读取OAuth错误码进行分流。
			const error = response.body.error;
			// 尚未用户确认。
			if (error === "authorization_pending") {
				// pending使共享器按当前间隔继续。
				return { status: "pending" };
			}
			// 服务端要求slow_down。
			if (error === "slow_down") {
				// 提取可能的新间隔。
				const interval = response.body.interval;
				// 数字先传共享器，其有限/正数归一化由共享器继续处理。
				return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
			}
			// 两种拒绝错误均终止，不当pending。
			if (error === "access_denied" || error === "authorization_denied") {
				// failed让共享器以拒绝授权文案抛错。
				return { status: "failed", message: "xAI device authorization was denied" };
			}
			// 设备码已过期。
			if (error === "expired_token") {
				// 终止并提示本轮不能再用。
				return { status: "failed", message: "xAI device code expired" };
			}
			// 其他失败用阶段、状态与远端说明生成错误文字。
			return { status: "failed", message: requestFailure("device token polling", response).message };
		},
	});
}

/**
 * 协调设备登录，先请求材料，再通知宿主展示地址/短码，随后轮询得到凭证。
 * 返回OAuthCredential，不保存或自动打开浏览器；例：优先展示完整URI，但基础URI也已在解析阶段校验。
 */
async function loginXai(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 申请并解析设备登录材料。
	const device = await requestDeviceCode(interaction.signal);
	// 通知宿主展示，不在此执行浏览器启动。
	interaction.notify({
		// device_code事件类型。
		type: "device_code",
		// 展示用户需要输入的短码。
		userCode: device.userCode,
		// ??优先完整URI，缺省时才用基础URI。
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		// 把可选间隔也提供宿主。
		intervalSeconds: device.intervalSeconds,
		// 告知设备授权剩余时间依据的有效秒数。
		expiresInSeconds: device.expiresInSeconds,
	});
	// 返回轮询Promise，不在此保存凭证。
	return pollForTokens(device, interaction.signal);
}

/**
 * 用旧refresh token POST刷新grant，校验新响应并返回新credential，失败向外拒绝。
 * 例：服务未轮换refresh_token时可沿用传入旧值；不在此循环重试、删除存储或强行延长旧token。
 */
async function refreshXaiToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	// 发一次刷新表单请求，不自带重试循环。
	const response = await postForm(
		// 刷新和设备授权使用同一token端点。
		XAI_TOKEN_URL,
		// 准备刷新grant字段。
		{
			// grant选择refresh_token。
			grant_type: "refresh_token",
			// 公开客户端id。
			client_id: XAI_CLIENT_ID,
			// 旧refresh token作为表单值提交。
			refresh_token: refreshToken,
		},
		// 原样传调用方取消信号。
		signal,
	);
	// HTTP失败不进入token字段解析。
	if (!response.ok) {
		// 带token refresh阶段错误拒绝。
		throw requestFailure("token refresh", response);
	}
	// 提供旧refresh值，使响应省略新值时可以沿用。
	return credentialsFromTokenResponse(response.body, refreshToken);
}

// 由外层Models使用的OAuthAuth适配对象。
export const xaiOAuth: OAuthAuth = {
	// 认证方案显示名称。
	name: "xAI (Grok/X subscription)",
	// 标记订阅认证，不在此验证订阅套餐。
	isSubscription: true,
	// 宿主登录操作文案。
	loginLabel: "Sign in with SuperGrok or X Premium",
	// 引用设备登录入口，导入时不启动流程。
	login: loginXai,
	/**
	 * 将统一刷新回调接到refreshXaiToken，读取credential.refresh并透传signal。
	 * 例：这里不检查expires，外层调度决定什么时候调用；返回下层凭证Promise。
	 */
	refresh: (credential, signal) => refreshXaiToken(credential.refresh, signal),

	/**
	 * 从凭证access生成通用apiKey结果Promise，无网络和到期检查。
	 * 例：供xAI供应商适配器构造请求，返回对象不等于已验证远端token有效。
	 */
	async toAuth(credential) {
		// 把access映射apiKey，不在此构造Bearer头或校验远端有效性。
		return { apiKey: credential.access };
	},
};
