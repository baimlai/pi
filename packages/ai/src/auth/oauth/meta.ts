// Meta订阅登录适配：设备授权取得身份token，再兑换推理API key；本文件不保存凭证，存储与刷新调度在Models层。
/**
 * Meta Model API OAuth flow
 *
 * RFC 8628 device authorization grant against https://auth.meta.com (JSON
 * responses). Meta splits identity from API access: the resulting identity
 * token is not accepted for inference, so it is exchanged for a Model API
 * key via the Muse Code key-mint endpoint (minted keys live about a day).
 * The identity token is stored as `refresh` and the minted key as `access`,
 * so the standard OAuth scheduler re-mints the key when it expires with no
 * bespoke renewal machinery. The identity token itself is not renewable
 * (auth.meta.com answers grant_type=refresh_token with 404 and issues no
 * refresh_token), so a 401/403 from mint means the session is dead and the
 * user must sign in again.
 */

// type导入只提供编译期的认证契约，运行时会被擦除。
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 共享设备轮询器负责间隔、slow_down、截止与取消协调。
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
// 浏览器地址统一经HTTP(S) URL解析；该helper不验证域名属于Meta。
import { trustedHttpUrl } from "./trusted-url.ts";

// Muse Code CLI client id.
// 公开客户端标识，不是用户secret。
const CLIENT_ID = "1031625952748946";
// 设备身份服务固定根地址。
const AUTH_HOST = "https://auth.meta.com";
// 模板插值拼设备码申请URL；末尾斜杠属于实际端点。
const DEVICE_AUTHORIZATION_URL = `${AUTH_HOST}/oidc/device/authorization/`;
// 轮询身份token的端点，与申请端点不同。
const DEVICE_TOKEN_URL = `${AUTH_HOST}/oidc/device/token/`;
// 身份token转API key的独立业务端点。
const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
// 本地把新key视为24小时有效，单位毫秒。
const API_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
// 每次HTTP请求的取消期限为30秒。
const REQUEST_TIMEOUT_MS = 30 * 1000;

// 设备材料内部类型；type只约束开发期，不验证JSON。
type DeviceAuthorization = {
	// 程序轮询用的设备码，不是展示给用户的短码。
	deviceCode: string;
	// 用户需要在网页确认的短码。
	userCode: string;
	// 已解析的HTTP(S)验证地址。
	verificationUri: string;
	// ?允许缺省轮询间隔，单位秒。
	intervalSeconds?: number;
	// ?允许缺省有效期，交共享轮询器补默认秒数。
	expiresInSeconds?: number;
};

/**
 * 合并调用方取消和单次30秒超时，返回任一触发即中止的新signal；无网络操作。
 * 例：登录整体尚未取消时，某次fetch仍可因本次30秒期限中止，不代表整个登录只有30秒。
 */
function requestSignal(signal: AbortSignal): AbortSignal {
	// AbortSignal.any任一取消即取消；timeout创建本次独立计时信号。
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

/**
 * 读取响应JSON，返回对象字典或null；JSON读取/解析失败在此吞掉。
 * Record<string,unknown>表示字段还未验证，数组也通过此处的object判断；例：空正文得到null，后续业务字段仍须检查。
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	// JSON流读取也可能抛错，所以包含在try内。
	try {
		// 等待完整正文并解析为JavaScript值。
		const json = await response.json();
		// 只检查非空object，as声明字典视图，不验证每个字段，也不排除数组。
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
		// 捕获读取和JSON解析失败，不在这里区分其原因。
	} catch {
		// 以null交后续字段检查，不把解析异常继续抛出。
		return null;
	}
}

/**
 * 按既定优先级抽取首个非空错误字段，返回带冒号的说明或空串，不发请求。
 * 例：同时含detail与message时选detail；只接受字符串，不遍历嵌套error对象，也不脱敏正文。
 */
function errorDetail(json: Record<string, unknown> | null): string {
	// for...of按这个字段列表的先后顺序查错误文字。
	for (const key of ["error_description", "detail", "message", "error"]) {
		// ?.允许json为null；方括号按变量名取字段。
		const value = json?.[key];
		// 只接收非空字符串，trim去两端空白后返回并停止扫描。
		if (typeof value === "string" && value.trim()) return `: ${value.trim()}`;
	}
	// 所有候选都没文字时不给额外说明。
	return "";
}

/**
 * 把未知远端数值收窄为有限正数，否则undefined，让轮询器采用默认策略。
 * 例：5保留，0/NaN/字符串"5"均缺省；不把字符串隐式转数值。
 */
function positiveNumber(value: unknown): number | undefined {
	// typeof完成unknown的数值收窄，isFinite排除Infinity/NaN，>0排除非正数。
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 向固定设备授权端点POST客户端id，校验返回字段与HTTP(S)浏览器地址，返回轮询材料。
 * 非2xx、JSON/字段无效会拒绝；例：优先用verification_uri_complete，缺失或不合HTTP(S)规则时尝试基础URI；不是域名白名单。
 */
async function startDeviceAuthorization(signal: AbortSignal): Promise<DeviceAuthorization> {
	// 发起设备授权请求，网络失败会拒绝本async函数。
	const response = await fetch(DEVICE_AUTHORIZATION_URL, {
		// 设备授权使用POST，不把client_id放查询串。
		method: "POST",
		// 声明发送表单并期望JSON。
		headers: {
			// 表单编码对应下面的URLSearchParams正文。
			"Content-Type": "application/x-www-form-urlencoded",
			// 要求服务返回JSON，仍需自己解析与校验。
			Accept: "application/json",
		},
		// 把公开client_id编码为表单字符串。
		body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
		// 本次fetch同时观察总取消和30秒期限。
		signal: requestSignal(signal),
	});
	// 尝试读JSON，即便非2xx也可从中提取错误详情。
	const json = await readJson(response);
	// Response.ok只表示HTTP 200到299，不表示业务字段有效。
	if (!response.ok) {
		// 保留状态和可读远端详情，Promise以Error拒绝。
		throw new Error(`Meta device authorization failed with status ${response.status}${errorDetail(json)}`);
	}
	// 读取unknown设备码，下面再收窄。
	const deviceCode = json?.device_code;
	// 读取unknown用户短码。
	const userCode = json?.user_code;
	// 完整验证URL优先；??只在helper返回undefined时尝试基础URL。
	const verificationUri = trustedHttpUrl(json?.verification_uri_complete) ?? trustedHttpUrl(json?.verification_uri);
	// 两种码必须为非空字符串，地址必须已通过URL规则。
	if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode || !verificationUri) {
		// 错误附原JSON的序列化表示；这里没有脱敏处理。
		throw new Error(`Invalid Meta device authorization response: ${JSON.stringify(json)}`);
	}
	// 建立内部驼峰字段对象，不直接透传未校验远端对象。
	return {
		// 属性简写保存程序设备码。
		deviceCode,
		// 保留用户展示短码。
		userCode,
		// 保存已规范化的验证地址。
		verificationUri,
		// 无效间隔改为undefined，默认由共享轮询器提供。
		intervalSeconds: positiveNumber(json?.interval),
		// 同样只接受有限正有效秒数。
		expiresInSeconds: positiveNumber(json?.expires_in),
	};
}

/**
 * 用设备材料轮询身份token，返回字符串Promise；先等待一次间隔，再由共享轮询器处理pending/slow_down/过期。
 * 例：用户未确认时继续等，access_denied转为失败；每次HTTP请求独立30秒限制，轮询截止不强行截断已在等待的poll回调。
 */
async function pollForIdentityToken(device: DeviceAuthorization, signal: AbortSignal): Promise<string> {
	// 泛型<string>约束complete结果类型，不进行运行时token验证。
	return pollOAuthDeviceCodeFlow<string>({
		// 采用申请结果中的可选间隔。
		intervalSeconds: device.intervalSeconds,
		// 采用申请结果中的可选有效期。
		expiresInSeconds: device.expiresInSeconds,
		// 第一次请求token前也等待间隔。
		waitBeforeFirstPoll: true,
		// 总signal传给轮询器，控制等待和取消检查。
		signal,
		// 每轮执行此异步回调，返回共享轮询结果联合。
		poll: async () => {
			// 本次向身份token端点发请求。
			const response = await fetch(DEVICE_TOKEN_URL, {
				// 采用POST提交设备授权材料。
				method: "POST",
				// 指定表单正文和JSON响应。
				headers: {
					// 与URLSearchParams.toString的编码匹配。
					"Content-Type": "application/x-www-form-urlencoded",
					// 期望JSON，但不免除后面的实际解析。
					Accept: "application/json",
				},
				// 构造设备授权grant表单。
				body: new URLSearchParams({
					// 固定设备码grant类型，区别刷新grant。
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					// 携带程序设备码，不用用户短码兑换。
					device_code: device.deviceCode,
					// 携带公开客户端id。
					client_id: CLIENT_ID,
					// 表单对象显式转字符串作为正文。
				}).toString(),
				// 每次poll的fetch有独立30秒限制。
				signal: requestSignal(signal),
			});
			// 读取JSON失败得到null，再按失败结果处理。
			const json = await readJson(response);
			// HTTP成功且access_token为非空字符串才算完成。
			if (response.ok && typeof json?.access_token === "string" && json.access_token) {
				// complete让共享轮询器结束并返回身份token。
				return { status: "complete", value: json.access_token };
			}
			// 按远端error分流，不因任意HTTP失败都自动重试。
			switch (json?.error) {
				// 用户还没确认授权。
				case "authorization_pending":
					// pending使轮询器继续按当前间隔等待。
					return { status: "pending" };
				// 服务器要求改变轮询速度。
				case "slow_down":
					// 给出有限正间隔则采用它，否则共享轮询器增加间隔。
					return { status: "slow_down", intervalSeconds: positiveNumber(json?.interval) };
				// 用户拒绝授权的分支。
				case "access_denied":
					// failed让共享轮询器抛出该错误文字。
					return { status: "failed", message: "Meta login was denied." };
				// 设备授权已过期的分支。
				case "expired_token":
					// 提示重新登录，不能复用本轮设备码。
					return { status: "failed", message: "Meta device authorization expired. Please restart login." };
				// 其他状态都进入终止失败。
				default:
					// 构造失败结果，不把未知错误当pending。
					return {
						// status字面量用于联合类型收窄。
						status: "failed",
						// 附HTTP状态和首个可读远端错误字段。
						message: `Meta device token request failed with status ${response.status}${errorDetail(json)}`,
					};
			}
		},
	});
}

/** Exchange an identity token for a Model API key. Keys are valid for about a day. */
/**
 * 用身份token调用mint端点取得Model API key，返回OAuthCredential；这一步不是refresh_token grant。
 * 401/403要求重新登录，其他HTTP失败或缺key也拒绝；例：身份token存refresh，key存access，expires按本地24小时常量估算，不读取服务端精确过期时间。
 */
async function mintApiKey(identityToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	// 向独立mint端点请求推理API key。
	const response = await fetch(API_KEY_MINT_URL, {
		// 采用POST创建/换发key。
		method: "POST",
		// 准备JSON及身份认证请求头。
		headers: {
			// 期望服务返回JSON。
			Accept: "application/json",
			// 身份token放Bearer头，不直接作为推理apiKey。
			Authorization: `Bearer ${identityToken}`,
			// 发送的正文是JSON空对象。
			"Content-Type": "application/json",
			// 固定mint业务API版本。
			"x-api-version": "1.0.0",
		},
		// 空JSON对象也是实际发送正文，不能当无body。
		body: "{}",
		// 合并总取消和本次30秒限制。
		signal: requestSignal(signal),
	});
	// 解析JSON失败暂存null，后面仍按HTTP/字段诊断。
	const json = await readJson(response);
	// 401/403单列为身份失效，不尝试refresh_token grant。
	if (response.status === 401 || response.status === 403) {
		// Identity token is not renewable (see file header); only a fresh device flow helps.
		// 抛出重新登录的提示。
		throw new Error(
			// 补状态与远端详情，不在此实际执行/login。
			`Meta session expired (status ${response.status}). Run \`/login meta\` to sign in again.${errorDetail(json)}`,
		);
	}
	// 其他非2xx也拒绝，不继续提取key。
	if (!response.ok) {
		// 错误保持mint失败语义。
		throw new Error(`Meta API key mint failed with status ${response.status}${errorDetail(json)}`);
	}
	// 读取unknown的api_key。
	const apiKey = json?.api_key;
	// 必须是非空字符串；不额外验证其内容格式。
	if (typeof apiKey !== "string" || !apiKey) {
		// 没发key时，尝试取HTTP(S)后续设置地址。
		const actionUrl = trustedHttpUrl(json?.action_url);
		// 有有效地址才附设置提示，不自动打开它。
		throw new Error(`Meta did not issue an API key.${actionUrl ? ` Complete setup at ${actionUrl}` : ""}`);
	}
	// refresh存身份token，access存推理key；本地当前时刻加24小时得到毫秒时间戳。
	return { type: "oauth", refresh: identityToken, access: apiKey, expires: Date.now() + API_KEY_LIFETIME_MS };
}

/**
 * 协调Meta登录：申请设备码、通知宿主展示、轮询身份、再mint推理key，返回凭证而不保存。
 * 任一阶段抛错向外传播，若总signal已取消则统一为Login cancelled；例：notify只报告进度，实际打开网页由宿主决定。
 */
async function loginMeta(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// try覆盖设备流程、通知宿主及mint异常。
	try {
		// 先申请并校验设备授权材料。
		const device = await startDeviceAuthorization(interaction.signal);
		// 通知宿主设备登录信息，不在此调用浏览器程序。
		interaction.notify({
			// 事件字面量标识设备码展示。
			type: "device_code",
			// 展示网页需输入的用户短码。
			userCode: device.userCode,
			// 优先选出的验证地址已包含在device中。
			verificationUri: device.verificationUri,
			// 可选间隔也提供给宿主展示。
			intervalSeconds: device.intervalSeconds,
			// 可选有效秒数供宿主说明。
			expiresInSeconds: device.expiresInSeconds,
		});
		// 等待授权成功，得到身份token。
		const identityToken = await pollForIdentityToken(device, interaction.signal);
		// 通知下一阶段即将开通API访问。
		interaction.notify({ type: "progress", message: "Enabling Meta Model API access..." });
		// await让mint的拒绝也进入当前catch。
		return await mintApiKey(identityToken, interaction.signal);
		// 捕获各阶段抛出值，包括宿主notify异常。
	} catch (e) {
		// An in-flight fetch rejects with a DOMException on abort; the login UI matches on this message.
		// 总signal已取消时统一输出UI识别的取消文字。
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		// 非取消保留原异常，不吞掉错误。
		throw e;
	}
}

// 提供符合OAuthAuth接口的适配对象；外层决定何时登录、存储和刷新。
export const metaOAuth: OAuthAuth = {
	// 登录列表里的显示名称。
	name: "Meta (Muse subscription)",
	// 订阅标记用于上层呈现/能力选择，不在此验证订阅有效。
	isSubscription: true,
	// 登录按钮的文案。
	loginLabel: "Sign in with Meta",

	// 函数引用交给宿主调用，此处不立即发请求。
	login: loginMeta,

	/**
	 * 刷新入口复用已存身份token重新mint推理key，返回新凭证Promise；会发HTTP。
	 * 例：credential.refresh仍是同一身份token，身份失效时抛错要求重新设备登录，不在这里删除存储。
	 */
	refresh: (credential, signal) => mintApiKey(credential.refresh, signal),

	/**
	 * 把已解析OAuth凭证转为请求认证，返回apiKey对象Promise；无网络、无到期检查。
	 * 例：access="LLM|key"时得到{apiKey:"LLM|key"}，最终请求头由供应商适配器处理。
	 */
	async toAuth(credential) {
		// access是mint得到的key，映射到通用认证结果。
		return { apiKey: credential.access };
	},
};
