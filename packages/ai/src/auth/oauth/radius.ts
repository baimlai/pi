// Radius网关的浏览器/设备码OAuth flow，Provider另负责模型目录；所有token/device接口固定从配置gateway根路径解析。
/**
 * Radius gateway OAuth flow.
 *
 * Radius is a pi-messages gateway. OAuth client APIs live on the configured
 * gateway; only the interactive browser authorization endpoint is discovered.
 * Model catalog loading is owned by the Radius provider.
 *
 * NOTE: This module uses node:http (via callback-server.ts) for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

// 网关规范化只补http(s)前缀/去末尾斜杠，不能推断已验证远端身份。
import { normalizeRadiusGatewayUrl } from "../../providers/radius-config.ts";
// 只导入认证方法、凭证、交互类型。
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 浏览器模式用共享Node回调服务，成功页面可等待兑换完成。
import { startOAuthCallbackServer } from "./callback-server.ts";
// 设备模式用共享轮询节奏，不在此重复实现睡眠循环。
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
// 生成Web Crypto PKCE材料。
import { generatePKCE } from "./pkce.ts";
// 服务器授权/验证URL仅接受http(s)协议并标准化，不做域名白名单。
import { trustedHttpUrl } from "./trusted-url.ts";

// 浏览器回调只监听本机IPv4地址。
const CALLBACK_HOST = "127.0.0.1";
// 固定1456端口，与OpenAI常用1455不同；本实现没有自动选空闲端口回退。
const CALLBACK_PORT = 1456;
// 精确回调路径。
const CALLBACK_PATH = "/oauth/callback";
// 浏览器授权及授权码兑换使用同一固定HTTP回调URL。
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
// 返回凭证到期提前扣一分钟供本地调度，再叠加外层可能的五分钟刷新窗口。
const TOKEN_EXPIRY_SKEW_MS = 60_000;
// 浏览器选择项id。
const LOGIN_METHOD_BROWSER = "browser";
// 设备码选择项id，带连字符，不能与其他flow的device_code拼写混用。
const LOGIN_METHOD_DEVICE_CODE = "device-code";
// 固定公共OAuth客户端标识，不是用户API key。
const OAUTH_CLIENT_ID = "pi-gateway";
// 申请网关访问及离线刷新权限的scope文字。
const OAUTH_SCOPE = "gateway offline_access";
// 设备授权grant的标准类型字符串。
const OAUTH_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// 本模块发现响应只需要浏览器授权地址，不采用响应里的issuer来推导其他端点。
type RadiusOAuthDiscovery = {
	// 发现结果允许独立授权站点，之后只校验Web协议格式。
	authorizationEndpoint: string;
};

// 预期设备响应字段形状，声明不执行运行时完整验证。
type DeviceAuthorizationResponse = {
	// 客户端轮询用的设备秘密code，不是给用户展示的短码。
	device_code: string;
	// 用户在浏览器输入的短码。
	user_code: string;
	// 用户验证页面URL，后面会经过协议边界检查。
	verification_uri: string;
	// 授权寿命秒数，不是Unix绝对到期时间。
	expires_in: number;
	// 可选轮询间隔秒数，省略交共用helper用默认五秒。
	interval?: number;
};

/**
 * 从配置网关读取OAuth发现信息，返回经过http(s)格式限制的浏览器授权端点。
 * 只请求/v1/oauth并检查HTTP状态，不从发现结果替换token/device端点；例：自定义网关可把浏览器授权放另一域名，域名本身没有白名单验证。
 */
async function loadRadiusOAuthDiscovery(gateway: string, signal: AbortSignal): Promise<RadiusOAuthDiscovery> {
	// 根路径/v1/oauth覆盖gateway原有path部分，不是相对子目录追加。
	const response = await fetch(new URL("/v1/oauth", gateway), {
		// 表示期望JSON发现信息，默认fetch方法为GET。
		headers: { accept: "application/json" },
		// 使用调用者信号，不在这次fetch另建超时/重试。
		signal,
	});

	// 非2xx状态不能继续采用发现内容。
	if (!response.ok) {
		// 抛可读请求错误，不在这里转设备状态。
		throw new Error(
			// 错误含网关、HTTP状态及响应正文，未额外脱敏/截断。
			`Could not load Radius OAuth config from ${gateway}: ${response.status} ${await response.text()}`,
		);
	}

	// JSON语法由response.json解析，Partial只说明字段可能缺省，不验证根对象或字段类型。
	const discovery = (await response.json()) as Partial<RadiusOAuthDiscovery>;
	// 将外部字段送unknown边界校验器，得到标准化URL或null。
	const authorizationEndpoint = trustedHttpUrl(discovery.authorizationEndpoint);
	// 没有合法http(s)地址就拒绝，不从issuer等其他字段猜地址。
	if (!authorizationEndpoint) {
		// 配置错误点名网关位置。
		throw new Error(`Invalid Radius OAuth config from ${gateway}`);
	}
	// 只返回需要的授权端点，不保留整个发现响应。
	return { authorizationEndpoint };
}

// 内部Error子类额外携带status/oauthError，用于设备码协议switch。
class OAuthResponseError extends Error {
	// readonly限制TS编译期重新赋值，不冻结运行时Error对象。
	readonly status: number;
	// 可缺省OAuth业务码，HTTP错误不一定有结构化code。
	readonly oauthError?: string;

	/**
	 * 构造带HTTP状态和OAuth错误码的Error，输入可选错误码/描述及操作说明，无网络操作。
	 * 按错误码+描述、单码、描述或状态生成message；例：400/authorization_pending可供设备轮询分支识别，而不是只靠message解析。
	 */
	constructor(status: number, oauthError: string | undefined, description: string | undefined, message: string) {
		// 先按错误码是否有真值选择说明组合。
		const detail = oauthError
			? // 有错误码且有描述时合并两者。
				description
				? // 保留业务码与具体描述。
					`${oauthError}: ${description}`
				: // 只有错误码时直接用它。
					oauthError
			: // 无错误码时优先描述，仍无真值再用HTTP状态文字。
				description || String(status);
		// 调用父Error构造器初始化message，随后才可使用this。
		super(`${message}: ${detail}`);
		// 明确赋普通字段，不采用TS参数属性语法。
		this.status = status;
		// 记录业务码供轮询分支读取，不解析最终message猜码。
		this.oauthError = oauthError;
	}
}

/**
 * 尽力读取失败响应的正文，返回OAuthResponseError，不自行throw这个结果。
 * 正文可读且为JSON时提取字符串error/error_description；读取/解析失败按原文或状态回退。例：token端点400包含invalid_grant时保留码和说明，调用者再throw。
 */
async function readOAuthResponseError(response: Response, message: string): Promise<OAuthResponseError> {
	// 尽力读正文，读取拒绝降级为空串，不掩盖HTTP失败。
	const text = await response.text().catch(() => "");
	// 尚未提取业务错误码时undefined。
	let oauthError: string | undefined;
	// 尚未有描述时undefined，后面可用原文回退。
	let description: string | undefined;

	// 空正文不做JSON解析，最后由状态构造说明。
	if (text) {
		// 解析和提取字段都处于容错try内。
		try {
			// JSON语法解析后仅断言可能字段；若根null造成取属性错误，也进入catch回退原文。
			const data = JSON.parse(text) as { error?: unknown; error_description?: unknown };
			// 真实字符串error才作为业务码，其他值忽略。
			oauthError = typeof data.error === "string" ? data.error : undefined;
			// 真实字符串error_description才作描述。
			description = typeof data.error_description === "string" ? data.error_description : undefined;
			// JSON语法/字段访问失败后保留原文作为说明，不再次请求正文。
		} catch {
			// 原响应文字成为错误描述，可能含服务端细节。
			description = text;
		}
	}

	// 返回异常对象，由调用者throw；保留status便于区分HTTP层。
	return new OAuthResponseError(response.status, oauthError, description, message);
}

/**
 * 向当前网关/v1/oauth/token发送表单grant，返回新OAuth凭证；会请求网络，错误/取消/JSON失败拒绝。
 * 非成功HTTP转OAuthResponseError；成功JSON仅作类型断言，未全面验证token字段。例：authorization_code、device_code、refresh_token共享此请求实现。
 * 结果到期先减一分钟，不保存到CredentialStore，也不加载模型目录；没有在此另设重试或独立超时。
 */
async function requestOAuthToken(
	// 配置网关根地址，不从发现授权端点决定token地址。
	gateway: string,
	// 表单字段可表示三种不同grant，不限定此函数只处理首次登录。
	body: URLSearchParams,
	// 操作信号由登录或外层刷新调度传入。
	signal: AbortSignal,
): Promise<OAuthCredential> {
	// 先声明响应，在fetch错误边界成功后再读它。
	let response: Response;
	// 这里catch只包fetch本身，不包后续response.json全部步骤。
	try {
		// 请求始终到网关根/v1/oauth/token，构造URL不继承gateway子路径。
		response = await fetch(new URL("/v1/oauth/token", gateway), {
			// POST提交grant。
			method: "POST",
			// 请求为URL编码表单，期望JSON响应。
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			// URLSearchParams对象作为body，不再JSON.stringify。
			body,
			// 不在此安装单次超时，依赖调用者信号策略。
			signal,
		});
		// fetch抛错时检查是否总信号已取消。
	} catch (error) {
		// 信号取消时统一UI识别的登录取消文字。
		if (signal.aborted) {
			// 新Error替代底层DOMException等取消表示。
			throw new Error("Login cancelled");
		}
		// 非取消网络失败原样抛出。
		throw error;
	}

	// 非成功HTTP要读取协议错误详情，不能继续构造凭证。
	if (!response.ok) {
		// await生成带OAuth错误码的异常，再throw给浏览器页/轮询分支。
		throw await readOAuthResponseError(response, "Radius OAuth token request failed");
	}

	// 成功响应的JSON语法会解析，随后as只有编译期形状作用。
	const data = (await response.json()) as {
		// 预期access token字段，没有在这里运行typeof字符串检查。
		access_token: string;
		// 预期refresh token字段，缺省不自动沿用旧值。
		refresh_token: string;
		// 预期寿命秒数，未额外验证有限/正数。
		expires_in: number;
		// 可选scope，将在凭证里保留。
		scope?: string;
	};

	// 创建新凭证，不在此执行store.modify。
	return {
		// 用规范oauth标签。
		type: "oauth",
		// 请求access材料直接来自响应。
		access: data.access_token,
		// 刷新材料直接来自响应。
		refresh: data.refresh_token,
		// 把寿命秒数转毫秒，加当前时间再减一分钟安全余量。
		expires: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
		// 把服务返回scope也保存在额外凭证字段。
		scope: data.scope,
	};
}

/**
 * 执行Radius浏览器登录，输入网关、发现的授权地址和交互，返回兑换完成的凭证。
 * 生成PKCE/state，绑定127.0.0.1:1456，通知URL，等回调内部兑换；兑换成功后浏览器才看成功页，finally关闭服务。
 * 例：端口占用直接拒绝，这个flow没有手工贴码/随机端口回退；用户可另选设备码模式。notify异常发生在try之前，本实现不统一兜住任意宿主回调异常。
 */
async function loginWithBrowser(
	// token兑换仍回到此网关，而不是浏览器授权站点。
	gateway: string,
	// 已经发现并限制Web协议的浏览器授权URL。
	authorizationEndpoint: string,
	// 宿主交互与具体取消信号。
	interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
	// 同一次登录的PKCE材料，verifier由闭包留给回调兑换。
	const { verifier, challenge } = await generatePKCE();
	// 随机UUID作为state，用于回调往返匹配。
	const state = crypto.randomUUID();
	// 构造独立浏览器授权地址，不在此fetch它。
	const authorizeUrl = new URL(authorizationEndpoint);
	// 用一份URL编码参数替换其原query。
	authorizeUrl.search = new URLSearchParams({
		// 请求授权码响应。
		response_type: "code",
		// 公共客户端id。
		client_id: OAUTH_CLIENT_ID,
		// 固定本机回调地址。
		redirect_uri: REDIRECT_URI,
		// 网关需要的scope文字。
		scope: OAUTH_SCOPE,
		// 只发送challenge，不把verifier放授权URL。
		code_challenge: challenge,
		// PKCE算法S256。
		code_challenge_method: "S256",
		// 网关协议要求handoff=url，具体由授权服务解释。
		handoff: "url",
		// 属性简写发送同次随机state。
		state,
		// toString负责查询编码，结果赋给URL.search。
	}).toString();

	// 实际绑定回调监听；失败直接拒绝，没有.catch降级为手工输入。
	const callback = await startOAuthCallbackServer({
		// 回调成功/失败页显示Radius名称，不读取options.name改这个页面标签。
		providerName: "Radius",
		// 监听127.0.0.1。
		host: CALLBACK_HOST,
		// 使用固定1456端口。
		port: CALLBACK_PORT,
		// 精确监听/oauth/callback路径。
		path: CALLBACK_PATH,
		// helper收到同次state，非匹配请求不会完成授权。
		state,
		// 有效回调内就开始兑换，返回Promise给helper等待。
		complete: (code) =>
			// 复用表单token请求，不先发成功页后再兑换。
			requestOAuthToken(
				// 兑换地址使用配置gateway。
				gateway,
				// 构造授权码grant表单。
				new URLSearchParams({
					// 授权码grant类别。
					grant_type: "authorization_code",
					// 公共客户端id。
					client_id: OAUTH_CLIENT_ID,
					// 兑换redirect必须与授权参数一致。
					redirect_uri: REDIRECT_URI,
					// 提交callback取到的code。
					code,
					// 提交同次原verifier证明PKCE，不提交challenge替代它。
					code_verifier: verifier,
				}),
				// 兑换请求用总登录信号，服务wait取消本身不强制中止非合作请求。
				interaction.signal,
			),
		// 回调等待也使用同一信号。
		signal: interaction.signal,
	});
	// 通知监听地址；这一行在后面try之前，notify若抛错并不由该finally统一关闭。
	interaction.notify({ type: "progress", message: `Listening for OAuth callback on ${REDIRECT_URI}` });
	// 同步给宿主授权URL通知，不在这里直接打开系统浏览器。
	interaction.notify({
		// 授权事件标签。
		type: "auth_url",
		// 已编码浏览器授权URL。
		url: authorizeUrl.toString(),
		// 用户操作说明。
		instructions: "Continue in your browser.",
	});

	// 正常等待回调这一段进入finally关闭范围。
	try {
		// wait的值是complete已经兑换好的完整凭证，不是裸code。
		const credential = await callback.wait();
		// 理论无值结果不能当作登录成功，明确拒绝。
		if (!credential) throw new Error("OAuth callback did not complete.");
		// 返回新凭证给外层持久化，当前flow不写文件。
		return credential;
		// 成功/等待失败/取消都请求关闭服务。
	} finally {
		// 关闭监听和未结算wait，已完成结果不被改写。
		callback.close();
	}
}

/**
 * 向配置网关请求设备授权，返回设备端code、用户短码、验证URL与寿命/间隔。
 * POST/v1/oauth/device，非2xx生成OAuthResponseError；成功仅有限真值筛选，再限制verification_uri为http(s)。
 * 例：file:验证链接被拒绝，但其余字段未逐个检查字符串/有限正数，as Partial不是完整网络schema验证。
 */
async function requestDeviceAuthorization(gateway: string, signal: AbortSignal): Promise<DeviceAuthorizationResponse> {
	// 保存fetch成功响应，后续检查在try之后。
	let response: Response;
	// 只把fetch取消统一为UI取消错误。
	try {
		// 直接请求网关根/v1/oauth/device，不做浏览器授权端点发现。
		response = await fetch(new URL("/v1/oauth/device", gateway), {
			// POST申请新设备授权。
			method: "POST",
			// 表单请求，期望JSON。
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			// 提交公共客户端id及scope，不使用用户API key。
			body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }),
			// 总登录信号直接传入。
			signal,
		});
		// 网络请求抛错进入这一catch。
	} catch (error) {
		// 总信号已取消时改成统一取消文字。
		if (signal.aborted) {
			// 取消Error交宿主UI识别。
			throw new Error("Login cancelled");
		}
		// 非取消错误原样传播，不在此自动重试。
		throw error;
	}

	// HTTP失败用协议错误对象保留业务码。
	if (!response.ok) {
		// 读取并抛带操作说明的OAuthResponseError。
		throw await readOAuthResponseError(response, "Radius OAuth device authorization failed");
	}

	// Partial断言不会验证网络根结构/各字段真实类型。
	const data = (await response.json()) as Partial<DeviceAuthorizationResponse>;
	// 仅检查必需字段为真值，不是逐字段string/number与范围校验。
	if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in) {
		// 真值检查失败报缺字段。
		throw new Error("Radius OAuth device authorization response is missing required fields");
	}
	// 验证用户链接为可解析http(s)并标准化。
	const verificationUri = trustedHttpUrl(data.verification_uri);
	// 链接协议/格式不符时拒绝，不能把任意系统协议交浏览器打开。
	if (!verificationUri) {
		// 错误描述为Untrusted仅对应此协议检查，不代表有域名信任名单。
		throw new Error("Untrusted verification_uri in Radius OAuth device authorization response");
	}

	// 返回供后面通知与轮询使用的新对象。
	return {
		// 设备端持有的授权码。
		device_code: data.device_code,
		// 用户端输入的短码。
		user_code: data.user_code,
		// 使用标准化后的验证URL。
		verification_uri: verificationUri,
		// 寿命秒数沿用原响应字段，未在此夹最小值。
		expires_in: data.expires_in,
		// 间隔可undefined，轮询helper会补默认值。
		interval: data.interval,
	};
}

/**
 * 执行Radius设备码登录：请求设备授权→通知短码→按共用helper轮询token，返回凭证。
 * 每次poll向同网关发device grant，已知OAuth错误映为pending/slow_down/failed，未知/网络错误直接拒绝；例：authorization_pending后下一轮拿到token便返回。
 * 没有waitBeforeFirstPoll，默认立即第一次轮询；不会加载模型目录或把凭证写盘。
 */
async function loginWithDeviceCode(gateway: string, interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 先拿本次设备授权材料，再显示用户短码。
	const device = await requestDeviceAuthorization(gateway, interaction.signal);
	// 通知宿主显示设备码，不是prompt要求用户把code写回当前终端。
	interaction.notify({
		// device_code事件标签。
		type: "device_code",
		// 展示user_code，不展示device_code秘密材料。
		userCode: device.user_code,
		// 用户应访问的验证URL。
		verificationUri: device.verification_uri,
		// 秒数原样供界面展示，真正等待还在helper。
		intervalSeconds: device.interval,
		// 设备授权寿命秒数。
		expiresInSeconds: device.expires_in,
	});

	// 泛型使complete值和外层返回都为OAuthCredential。
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		// 建议轮询间隔交helper换算毫秒并限制最小一秒。
		intervalSeconds: device.interval,
		// 从此helper开始按寿命计算deadline。
		expiresInSeconds: device.expires_in,
		// 同一总信号用于睡眠与网络合作取消。
		signal: interaction.signal,
		/**
		 * 执行一次设备token请求并翻译协议状态，返回共用轮询结果Promise。
		 * 成功带OAuthCredential；例：slow_down不在此睡眠，交helper统一加间隔；非OAuthResponseError直接传播，不把网络异常当授权待完成。
		 */
		poll: async () => {
			// 一次token请求及协议错误翻译的边界。
			try {
				// 尝试用设备grant拿OAuth凭证。
				const credentials = await requestOAuthToken(
					// token API仍在同一网关。
					gateway,
					// 构造设备token表单。
					new URLSearchParams({
						// 用设备授权grant，区别于refresh或浏览器授权码。
						grant_type: OAUTH_DEVICE_CODE_GRANT_TYPE,
						// 公共客户端id。
						client_id: OAUTH_CLIENT_ID,
						// 提交客户端保留的device_code，不是用户短码。
						device_code: device.device_code,
					}),
					// 网络请求合作取消信号。
					interaction.signal,
				);
				// 成功凭证包成complete，helper会返回value结束循环。
				return { status: "complete", value: credentials };
				// 失败先区分是否为可解释OAuth协议错误。
			} catch (error) {
				// 网络异常/其他Error不走业务错误switch。
				if (!(error instanceof OAuthResponseError)) {
					// 原样拒绝，让helper直接结束，不把错误当pending。
					throw error;
				}
				// 按结构化业务码选择待完成/减速/最终失败。
				switch (error.oauthError) {
					// authorization_pending表示用户还未授权。
					case "authorization_pending":
						// pending交helper按现有间隔继续。
						return { status: "pending" };
					// slow_down请求减小轮询频率。
					case "slow_down":
						// 没有提供新interval，helper将原间隔增加五秒。
						return { status: "slow_down" };
					// 设备授权过期是终止状态。
					case "expired_token":
						// failed消息被helper转Error，不会自动发起新的设备授权。
						return { status: "failed", message: "Device authorization expired." };
					// 用户拒绝也是终止状态。
					case "access_denied":
						// 给出明确拒绝说明。
						return { status: "failed", message: "Device authorization was denied." };
					// 未认识的OAuth业务码不擅自恢复。
					default:
						// 抛原OAuthResponseError，保留HTTP状态与业务码。
						throw error;
				}
			}
		},
	});
}

// 构造Radius认证外观所需选项，不包含模型目录或用户token。
export interface RadiusOAuthOptions {
	// 认证方式展示名。
	name: string;
	// 配置网关根地址，之后各API从根路径解析。
	gateway: string;
}

/**
 * 构造绑定名称和网关的Radius认证方法，返回OAuthAuth，本身不请求发现/登录。
 * 先简单规范网关，再提供login/refresh/toAuth；例：gateway="radius.example/"补https并去末尾斜杠，未校验目标连通性或可信域名。
 * OAuth flow只管身份与token，模型目录由radiusProvider.refreshModels单独管理。
 */
export function createRadiusOAuth(options: RadiusOAuthOptions): OAuthAuth {
	// 当前helper只补https及去末尾斜杠，不全面校验URL/域名；错误URL也可能稍后构造请求时才失败。
	const gateway = normalizeRadiusGatewayUrl(options.gateway);

	// 返回绑定gateway闭包的方法对象，构造时尚未fetch。
	return {
		// 外观name采用宿主给的名字。
		name: options.name,

		/**
		 * 询问browser/device-code并启动对应登录，返回凭证；未知选择/交互失败拒绝。
		 * 浏览器先发现唯一授权端点再绑定回调；设备码直接访问网关device/token端点。例：远程机器选device-code不需要1456端口。
		 */
		async login(interaction): Promise<OAuthCredential> {
			// 先等待宿主选择返回稳定id。
			const loginMethod = await interaction.prompt({
				// 选择提示类型。
				type: "select",
				// 提示展示配置名称，不是固定所有实例都叫Radius。
				message: `Sign in to ${options.name}:`,
				// 两个入口供不同环境使用，不在此自动探测浏览器是否能访问本机。
				options: [
					// 浏览器项列首并在文字建议使用，不代表已自动选择。
					{ id: LOGIN_METHOD_BROWSER, label: "Sign in with browser (recommended)" },
					// 设备码选项的对象起始，下面id/label解释选择和展示。
					{
						// 用户选它时返回device-code稳定id。
						id: LOGIN_METHOD_DEVICE_CODE,
						// 展示适用于跨设备登录的说明。
						label: "Sign in with device code (when signing in from another device)",
					},
				],
			});

			// 明确选择设备码则不请求浏览器发现API。
			if (loginMethod === LOGIN_METHOD_DEVICE_CODE) {
				// 返回设备授权及轮询完整结果。
				return loginWithDeviceCode(gateway, interaction);
			}
			// 只有browser分支才读取发现的授权端点。
			if (loginMethod === LOGIN_METHOD_BROWSER) {
				// await加载并验证授权URL，失败不自动切设备码。
				const discovery = await loadRadiusOAuthDiscovery(gateway, interaction.signal);
				// 传网关与发现URL分别用于token和浏览器授权。
				return loginWithBrowser(gateway, discovery.authorizationEndpoint, interaction);
			}
			// 未知选择拒绝，不默认为推荐项。
			throw new Error(`Unknown ${options.name} sign-in method: ${loginMethod}`);
		},

		/**
		 * 用当前凭证refresh字段向绑定网关兑换新OAuth凭证，返回新对象，失败拒绝。
		 * 不重新做浏览器端点发现，不自动继承旧额外字段或保存；例：轮换结果交外层Models在store.modify互斥回调中写回。
		 */
		async refresh(credential, signal): Promise<OAuthCredential> {
			// 刷新直接调用token请求，不重新发现授权页面或绑定端口。
			const refreshed = await requestOAuthToken(
				// 使用构造时已绑定网关。
				gateway,
				// 构造刷新表单。
				new URLSearchParams({
					// refresh_token grant类别。
					grant_type: "refresh_token",
					// 公共客户端id。
					client_id: OAUTH_CLIENT_ID,
					// 当前凭证的refresh材料，不采用access代替。
					refresh_token: credential.refresh,
				}),
				// 外层给的刷新信号通常有独立超时，本方法不另设。
				signal,
			);
			// 返回新凭证，由存储调度层决定发布，不自动保留旧额外属性。
			return refreshed;
		},

		/**
		 * 把最终OAuth access作为请求apiKey返回，无网络、存储或目录刷新。
		 * 例：radiusProvider的pi-messages适配器使用这个key发网关请求；凭证有效期判断由Models先完成。
		 */
		async toAuth(credential) {
			// 把access派生为请求key，实际HTTP头/协议由网关适配器处理。
			return { apiKey: credential.access };
		},
	};
}
