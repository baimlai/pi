// GitHub Copilot设备登录适配：GitHub身份token换短期Copilot token，读取账号模型目录，并在登录时尽力启用已知未配置模型策略。
/**
 * GitHub Copilot OAuth flow
 */

// 自动生成的模型目录提供已知集合，用于限定策略启用范围；应改catalog输入再生成，不手改*.models.ts产物。
import { GITHUB_COPILOT_MODELS } from "../../providers/github-copilot.models.ts";
// 可取消sleep用于429退避。
import { sleep } from "../../utils/sleep.ts";
// type导入认证接口，编译后擦除。
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 共享设备轮询器管理等待与截止。
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
// 只把验证URI限制为可解析HTTP(S)，非域名白名单。
import { trustedHttpUrl } from "./trusted-url.ts";

/**
 * 把Base64文字解码为客户端id，返回字符串，无网络；例：这只是公开常量的编码表示，不是保密或加密。
 */
const decode = (s: string) => atob(s);
// 模块求值时解码公开client_id常量。
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

// Copilot服务要求的兼容客户端标识头，不是从本机真实VS Code版本读取。
const COPILOT_HEADERS = {
	// 固定User-Agent。
	"User-Agent": "GitHubCopilotChat/0.35.0",
	// 固定编辑器版本标识。
	"Editor-Version": "vscode/1.107.0",
	// 固定插件版本标识。
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	// 固定集成来源标识。
	"Copilot-Integration-Id": "vscode-chat",
	// as const在编译期保留字面量/只读字段，不冻结运行时对象。
} as const;
// 账号模型目录请求使用的固定API版本。
const COPILOT_API_VERSION = "2026-06-01";

// 设备授权成功响应的内部结构，远端字段仍需入口验证。
type DeviceCodeResponse = {
	// 后续轮询用设备码。
	device_code: string;
	// 网页展示给用户的短码。
	user_code: string;
	// 用户打开的验证URI。
	verification_uri: string;
	// 可缺省轮询间隔，单位秒。
	interval?: number;
	// 设备授权相对有效期，单位秒。
	expires_in: number;
};

// 轮询成功形状，类型声明本身不校验JSON。
type DeviceTokenSuccessResponse = {
	// GitHub身份access token，后面用于换Copilot token。
	access_token: string;
	// 可选token类型，当前流程不使用。
	token_type?: string;
	// 可选授予scope，当前流程不使用。
	scope?: string;
};

// 轮询错误形状。
type DeviceTokenErrorResponse = {
	// OAuth错误码。
	error: string;
	// 可选可读错误描述。
	error_description?: string;
	// slow_down可能附新间隔秒数。
	interval?: number;
};

/**
 * 从可选URL/裸域名文字提取hostname，返回域名或null，无网络。
 * 例：https://company.ghe.com:8443/a只留下company.ghe.com；路径、端口、scheme被舍弃，不代表验证其属于GitHub。
 */
function normalizeDomain(input: string): string | null {
	// 先去输入两端空白。
	const trimmed = input.trim();
	// 全空白返回null，调用处可选择默认GitHub域。
	if (!trimmed) return null;
	// URL构造可能失败，捕获为null。
	try {
		// 含://直接按URL解析，否则在前面补https://。
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		// 仅取hostname，端口、路径及原scheme不保留。
		return url.hostname;
		// 任何解析异常都按无有效域名处理。
	} catch {
		// 返回null，不在此抛业务错误。
		return null;
	}
}

/**
 * 按域名拼三个固定HTTPS端点，返回地址对象，不请求或验证服务。
 * 例：github.com对应GitHub设备授权、OAuth token和api.github.com的Copilot token端点；企业域名采用相同拼接规则。
 */
function getUrls(domain: string): {
	// 返回类型声明设备授权URL字段。
	deviceCodeUrl: string;
	// 返回类型声明GitHub身份token端点字段。
	accessTokenUrl: string;
	// 返回类型声明Copilot token端点字段。
	copilotTokenUrl: string;
} {
	// 建立三个端点对象，不请求网络。
	return {
		// 拼设备码申请地址。
		deviceCodeUrl: `https://${domain}/login/device/code`,
		// 拼设备token轮询地址。
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		// api.前缀用于短期Copilot token交换。
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * Returns API URL like https://api.individual.githubcopilot.com
 */
/**
 * 从Copilot token文本里匹配proxy-ep并派生API根URL，返回字符串或null。
 * 例：proxy.individual.githubcopilot.com转api.individual.githubcopilot.com；只做正则提取与前缀替换，不校验JWT、host归属或token真伪。
 */
function getBaseUrlFromToken(token: string): string | null {
	// 正则抓取proxy-ep=之后到分号前的内容。
	const match = token.match(/proxy-ep=([^;]+)/);
	// 没有该字段返回null，让上层回退。
	if (!match) return null;
	// 第1捕获组作为proxy host文本。
	const proxyHost = match[1];
	// Convert proxy.xxx to api.xxx
	// 只替换开头proxy.，其他内容不校验或修改。
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	// 补https://生成API根地址。
	return `https://${apiHost}`;
}

/**
 * 决定Copilot API根URL：优先token中的proxy-ep，再企业域名，最后个人账号默认。
 * 返回字符串，无I/O；例：企业域名存在但token已给proxy端点时，仍采用token端点。
 */
function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	// If we have a token, extract the base URL from proxy-ep
	// token非空才优先尝试内含端点。
	if (token) {
		// 调用本地解析，不向token发行者查询。
		const urlFromToken = getBaseUrlFromToken(token);
		// 成功解析则直接返回，优先于企业回退。
		if (urlFromToken) return urlFromToken;
	}
	// Fallback for enterprise or if token parsing fails
	// 企业域存在时构造copilot-api.根URL。
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	// 其他情况使用个人默认根URL。
	return "https://api.individual.githubcopilot.com";
}

/**
 * 给未知JSON值取得字典视图，返回Record或undefined。
 * 例：数组也属于object会通过此浅检查，字段仍unknown；不复制、不做完整schema校验。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	// object浅判断允许数组；as只是类型视图，不验证属性。
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * 解析账号模型目录，返回可用id和待策略启用id两组数组，无请求。
 * 先排除坏id与明确不支持工具的项；picker优先，允许回退且picker全空时选policy=enabled；待启用仅含本地已知且unconfigured的候选。
 * 例：未知远端模型可在可用列表中，但不会进入自动policy启用列表；本函数不去重。
 */
function parseGitHubCopilotModelCatalog(raw: unknown, allowPolicyFallback: boolean) {
	// 取得远端顶层data字段，值仍unknown。
	const data = asRecord(raw)?.data;
	// 目录必须是数组，这是JSON输入边界检查。
	if (!Array.isArray(data)) {
		// 形状错误直接拒绝，不按空目录继续。
		throw new Error("Invalid Copilot models response");
	}

	// flatMap让不符合条件的条目返回[]以跳过。
	const accountModels = data.flatMap((rawItem) => {
		// 每项仅取得object视图。
		const item = asRecord(rawItem);
		// 读未知id字段。
		const id = item?.id;
		// 缺对象或id非字符串时不纳入；本处不额外排除空id。
		if (!item || typeof id !== "string") return [];

		// 读取可选能力对象。
		const capabilities = asRecord(item.capabilities);
		// 再读其supports对象。
		const supports = asRecord(capabilities?.supports);
		// 只有tool_calls明确false才排除；缺失不等于不支持。
		if (supports?.tool_calls === false) return [];

		// 合法项返回单元素数组，flatMap展开为一层。
		return [
			// 建立本地选择/策略判断所需的最小对象。
			{
				// 保留模型id。
				id,
				// picker标记只有严格true才开启。
				pickerEnabled: item.model_picker_enabled === true,
				// 策略state仍unknown，后面与特定字符串比较。
				policyState: asRecord(item.policy)?.state,
			},
		];
	});
	// 从归一化账号模型收集picker候选。
	const pickerModelIds = accountModels
		// picker开启且未明确disabled才纳入。
		.filter((model) => model.pickerEnabled && model.policyState !== "disabled")
		// map仅输出id，不在此去重。
		.map((model) => model.id);
	// 允许policy回退且picker没有任何项才启用回退。
	const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
	// 决定当前可用模型id列表。
	const availableModelIds =
		// 有picker项或不允许回退时保持picker结果。
		pickerModelIds.length > 0 || !allowPolicyFallback
			? // 直接采用picker列表。
				pickerModelIds
			: // 否则只选policy严格enabled的账号模型。
				accountModels
					.filter((model) => model.policyState === "enabled")
					.map((model) => model.id);
	// 另行计算可能需远端启用policy的id。
	const policyModelIds = accountModels
		// filter组合以下三项条件。
		.filter(
			// 每个账号模型逐项判断。
			(model) =>
				// 策略必须明确unconfigured。
				model.policyState === "unconfigured" &&
				// id必须为本地生成模型表的自有键，未知项不自动改策略。
				Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) &&
				// 还需picker开启，或已允许个人账号的空picker回退。
				(model.pickerEnabled || usePolicyFallback),
		)
		// 匹配后提取id。
		.map((model) => model.id);
	// 返回可用与待启用两种用途列表，不执行远端更改。
	return { availableModelIds, policyModelIds };
}

/**
 * 向URL发请求，仅对HTTP429按次数/时间预算重试，返回最终Response；网络/取消直接抛出。
 * 每次fetch额外5秒限制；有正重试次数及正时间预算时设总预算，等待超过剩余预算则返回当前429。例：maxRetries=2最多3次，Retry-After可为秒或日期，无效值不重试。
 */
async function fetchWithRateLimitRetry(
	// HTTP目标URL。
	url: string,
	// 请求方法/头/正文等标准fetch选项。
	init: RequestInit,
	// 调用方取消signal。
	signal: AbortSignal,
	// 额外尝试次数及本次操作总时间预算，单位毫秒。
	retryPolicy: { maxRetries: number; maxElapsedMs: number },
	// Promise<Response>表示异步返回HTTP响应；状态错误是否抛出由调用方决定。
): Promise<Response> {
	// 可选总预算信号，没满足正预算条件则不创建。
	const retryBudgetSignal =
		// 必须次数与时间都为正，才设总预算。
		retryPolicy.maxRetries > 0 && retryPolicy.maxElapsedMs > 0
			? // 创建maxElapsedMs之后中止的信号。
				AbortSignal.timeout(retryPolicy.maxElapsedMs)
			: // 否则仅有调用方signal与每次5秒限制。
				undefined;
	// 把总取消与可选预算合并。
	const requestSignal = retryBudgetSignal ? AbortSignal.any([signal, retryBudgetSignal]) : signal;
	// 记录绝对截止，用于决定是否值得再等待Retry-After。
	const retryDeadline = retryBudgetSignal ? Date.now() + retryPolicy.maxElapsedMs : undefined;
	// retry从0计，首次不算额外尝试；无循环条件，靠返回/异常结束。
	for (let retry = 0; ; retry++) {
		// 发本轮实际请求。
		const response = await fetch(url, {
			// 展开init保留方法/头/正文，下面signal覆盖init.signal。
			...init,
			// 每轮fetch额外叠加5秒超时。
			signal: AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]),
		});
		// 非429直接返回；429已达次数上限也返回，不在helper里抛HTTP错误。
		if (response.status !== 429 || retry === retryPolicy.maxRetries) return response;

		// 读服务端Retry-After头，可能为秒数或日期。
		const retryAfter = response.headers.get("retry-after");
		// 未给合法头时默认500ms起指数退避。
		let delayMs = 500 * 2 ** retry;
		// 非空Retry-After才尝试解析。
		if (retryAfter) {
			// parseFloat优先按数值解析，不是严格完整数字字符串验证。
			const seconds = Number.parseFloat(retryAfter);
			// 数值NaN才尝试日期，否则秒乘1000。
			delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
			// 两个形式都无法得到有限等待时直接返回当前429。
			if (!Number.isFinite(delayMs)) return response;
		}
		// 负日期差/负秒数被钳成0等待。
		delayMs = Math.max(0, delayMs);
		// 等待会用尽剩余总预算则立即返回当前429，等于剩余也不重试。
		if (retryDeadline !== undefined && delayMs >= retryDeadline - Date.now()) return response;
		// 重试前尽量取消当前响应正文，失败也会向外拒绝。
		await response.body?.cancel();
		// 按合并总预算/调用方signal可取消地退避，再下一轮。
		await sleep(delayMs, requestSignal);
	}
}

/**
 * 用Copilot token读取账号/models并解析可用/待启用集合，返回Promise；非2xx或无效JSON/目录抛错。
 * 例：只有精确个人默认根URL允许picker空时回退policy，企业/商业端点保持严格picker语义；仅读取目录，不在此启用模型。
 */
async function fetchGitHubCopilotModels(
	// 短期Copilot token，用于Bearer认证。
	copilotToken: string,
	// 可选企业域回退。
	enterpriseDomain: string | undefined,
	// 贯穿目录请求的取消信号。
	signal: AbortSignal,
	// 调用方为登录/刷新选择不同429重试预算。
	retryPolicy: { maxRetries: number; maxElapsedMs: number },
) {
	// 优先从token解析账号API端点。
	const baseUrl = getGitHubCopilotBaseUrl(copilotToken, enterpriseDomain);
	// Some Individual accounts return false for every picker flag despite explicit enabled policies.
	// Limit the fallback to that endpoint so other account types keep strict picker semantics.
	// 仅精确个人默认URL启用空picker的policy回退。
	const allowPolicyFallback = baseUrl === "https://api.individual.githubcopilot.com";
	// 调用仅重试429的helper。
	const response = await fetchWithRateLimitRetry(
		// 读取该账号根URL的/models。
		`${baseUrl}/models`,
		// 本请求未写method，fetch默认GET。
		{
			// 准备JSON、认证与兼容客户端头。
			headers: {
				// 期望JSON目录。
				Accept: "application/json",
				// 用Copilot短期token认证，不用GitHub身份token。
				Authorization: `Bearer ${copilotToken}`,
				// 加入固定兼容客户端标识。
				...COPILOT_HEADERS,
				// 目录请求指定固定API版本。
				"X-GitHub-Api-Version": COPILOT_API_VERSION,
			},
		},
		// 原样传取消。
		signal,
		// 原样传登录/刷新预算。
		retryPolicy,
	);
	// 最终Response若非2xx，目录整体失败。
	if (!response.ok) {
		// 读取状态及正文进入错误；正文读取失败也会拒绝。
		throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
	}
	// 成功HTTP仍需JSON解析及目录schema处理。
	return parseGitHubCopilotModelCatalog(await response.json(), allowPolicyFallback);
}

/**
 * 发给定HTTP请求并读取JSON，返回unknown；网络、非2xx或JSON失败会拒绝。
 * 例：请求signal/超时完全由init决定；此helper没有自己添加重试、脱敏或超时。
 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	// 按init原样发请求，没额外注入超时。
	const response = await fetch(url, init);
	// 非2xx不能作为成功JSON处理。
	if (!response.ok) {
		// 读取完整失败正文供诊断。
		const text = await response.text();
		// 抛HTTP状态/状态文字/正文，不脱敏。
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	// 返回JSON读取Promise，返回类型unknown迫使调用方处理字段边界。
	return response.json();
}

/**
 * 向选定GitHub域申请设备码并验证远端字段，返回设备材料。
 * 只校验数字类型而非有限正范围，间隔/有效期后由共享轮询器归一化；浏览器地址限定HTTP(S)，无域名白名单。例：无效URI在notify前拒绝。
 */
async function startDeviceFlow(domain: string, signal: AbortSignal): Promise<DeviceCodeResponse> {
	// 按域名取得三个授权端点。
	const urls = getUrls(domain);
	// 请求设备授权端点。
	const data = await fetchJson(urls.deviceCodeUrl, {
		// POST申请设备码。
		method: "POST",
		// 准备JSON响应与表单正文头。
		headers: {
			// 期望返回JSON。
			Accept: "application/json",
			// URLSearchParams正文按表单编码。
			"Content-Type": "application/x-www-form-urlencoded",
			// 固定客户端User-Agent。
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
		// 创建表单，不手工拼接字段。
		body: new URLSearchParams({
			// 公开client_id。
			client_id: CLIENT_ID,
			// 申请read:user作用域。
			scope: "read:user",
		}),
		// 原样传总取消信号，本入口未单独设请求超时。
		signal,
	});

	// 远端顶层必须非空object，数组尚未排除。
	if (!data || typeof data !== "object") {
		// 非法顶层直接拒绝。
		throw new Error("Invalid device code response");
	}

	// as字典后读取设备码，仍unknown。
	const deviceCode = (data as Record<string, unknown>).device_code;
	// 读取用户短码。
	const userCode = (data as Record<string, unknown>).user_code;
	// 读取原始验证URI。
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	// 读取可选间隔。
	const interval = (data as Record<string, unknown>).interval;
	// 读取必需有效期。
	const expiresIn = (data as Record<string, unknown>).expires_in;

	// 逐字段验证，任一条件失败都拒绝。
	if (
		// 设备码要求字符串，空串此处未排除。
		typeof deviceCode !== "string" ||
		// 用户短码要求字符串。
		typeof userCode !== "string" ||
		// 验证URI先要求字符串，下面再解析协议。
		typeof verificationUri !== "string" ||
		// interval缺省可以，但给了就必须数字。
		(interval !== undefined && typeof interval !== "number") ||
		// 有效期必须数字，此处不检查有限正数。
		typeof expiresIn !== "number"
	) {
		// 报字段错误，不带入未校验材料。
		throw new Error("Invalid device code response fields");
	}

	// 按HTTP(S) URL解析并规范化验证地址。
	const trustedVerificationUri = trustedHttpUrl(verificationUri);
	// 不能解析或协议不符时拒绝。
	if (!trustedVerificationUri) {
		// 避免把不合规则的地址交宿主浏览器；并非域名归属检查。
		throw new Error("Untrusted verification_uri in device code response");
	}

	// 新建已检查设备响应对象。
	return {
		// 保留snake_case设备码供后续轮询。
		device_code: deviceCode,
		// 保留用户短码。
		user_code: userCode,
		// 用规范化URI替换原地址文字。
		verification_uri: trustedVerificationUri,
		// 间隔保留原数字/undefined，交共享器归一化。
		interval,
		// 有效秒数同样交共享器归一化。
		expires_in: expiresIn,
	};
}

/**
 * 按设备材料轮询GitHub身份access token，返回字符串Promise，首次也等待间隔。
 * pending继续、slow_down转共享等待策略、其他错误失败；非2xx由fetchJson直接拒绝，不解读其JSON pending。例：拿到的GitHub身份token随后作为credential.refresh，尚不是Copilot推理token。
 */
async function pollForGitHubAccessToken(
	// GitHub域名，决定身份token端点。
	domain: string,
	// 申请成功的设备响应材料。
	device: DeviceCodeResponse,
	// 总取消信号。
	signal: AbortSignal,
	// 完成值是GitHub身份token字符串，不是最终推理凭证。
): Promise<string> {
	// 按同一域生成轮询端点。
	const urls = getUrls(domain);
	// 泛型string声明完成结果是身份token。
	return pollOAuthDeviceCodeFlow<string>({
		// 可选间隔交共享器补默认/检查数值。
		intervalSeconds: device.interval,
		// 有效期由共享器处理默认与数值边界。
		expiresInSeconds: device.expires_in,
		// 第一次轮询前也等待。
		waitBeforeFirstPoll: true,
		// 共享器的sleep与取消检查观察总signal。
		signal,
		// 每轮执行异步身份token请求。
		poll: async () => {
			// 非2xx由fetchJson立即抛出，不按其正文error继续pending。
			const raw = await fetchJson(urls.accessTokenUrl, {
				// POST提交设备grant。
				method: "POST",
				// 准备表单及JSON头。
				headers: {
					// 期望JSON响应。
					Accept: "application/json",
					// 表单正文编码。
					"Content-Type": "application/x-www-form-urlencoded",
					// 固定User-Agent。
					"User-Agent": "GitHubCopilotChat/0.35.0",
				},
				// 构造设备grant字段。
				body: new URLSearchParams({
					// 公开client_id。
					client_id: CLIENT_ID,
					// 实际设备码。
					device_code: device.device_code,
					// 固定设备授权grant名称。
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				// 实际fetch也使用总signal。
				signal,
			});

			// 外部JSON检查为object且access_token是字符串；未要求非空。
			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
				// complete终止轮询并返回GitHub身份token。
				return { status: "complete", value: (raw as DeviceTokenSuccessResponse).access_token };
			}

			// 没有成功字段时尝试错误对象路径。
			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
				// 解构error、重命名error_description为description、读取interval；断言不校验额外字段。
				const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
				// 授权还没由用户确认。
				if (error === "authorization_pending") {
					// pending让共享器按当前间隔继续。
					return { status: "pending" };
				}

				// 服务器要求slow_down。
				if (error === "slow_down") {
					// 数字interval传共享器继续归一化，缺失则增加默认间隔。
					return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
				}

				// description为真值才附错误后缀，没有完整类型检查/脱敏。
				const descriptionSuffix = description ? `: ${description}` : "";
				// 其他OAuth错误终止本轮设备登录。
				return { status: "failed", message: `Device flow failed: ${error}${descriptionSuffix}` };
			}

			// 既无token也无可识别error时失败，不无限poll。
			return { status: "failed", message: "Invalid device token response" };
		},
	});
}

/**
 * 用GitHub身份token取得短期Copilot token，返回OAuthCredential，不请求模型目录。
 * 校验token字符串/到期数字后，expires从服务端秒级绝对时间转毫秒再提前5分钟；例：refresh保留GitHub身份token，access为Copilot token。无存储副作用。
 */
async function refreshGitHubCopilotAccessToken(
	// 参数名虽为refreshToken，实际保存GitHub身份access token。
	refreshToken: string,
	// 可选企业hostname。
	enterpriseDomain: string | undefined,
	// 本次请求取消信号。
	signal: AbortSignal,
	// Promise完成值为统一OAuth凭证，函数本身不保存。
): Promise<OAuthCredential> {
	// 未给企业域时默认github.com。
	const domain = enterpriseDomain || "github.com";
	// 找到短期Copilot token端点。
	const urls = getUrls(domain);

	// 默认GET读取Copilot token。
	const raw = await fetchJson(urls.copilotTokenUrl, {
		// 准备JSON与身份Bearer认证。
		headers: {
			// 期望JSON。
			Accept: "application/json",
			// 使用GitHub身份token换短期Copilot token。
			Authorization: `Bearer ${refreshToken}`,
			// 加入兼容客户端头。
			...COPILOT_HEADERS,
		},
		// 原样透传取消信号。
		signal,
	});

	// JSON顶层必须非空object，字段稍后检查。
	if (!raw || typeof raw !== "object") {
		// 无效形状拒绝。
		throw new Error("Invalid Copilot token response");
	}

	// 读未知Copilot token字段。
	const token = (raw as Record<string, unknown>).token;
	// 读取服务端秒级绝对到期时刻。
	const expiresAt = (raw as Record<string, unknown>).expires_at;

	// 要求token字符串和到期数字，但不额外查非空/有限性。
	if (typeof token !== "string" || typeof expiresAt !== "number") {
		// 字段类型不合即拒绝。
		throw new Error("Invalid Copilot token response fields");
	}

	// 统一OAuthCredential封装。
	return {
		// 标记OAuth类别。
		type: "oauth",
		// 长期GitHub身份token保存在refresh以便下次再换。
		refresh: refreshToken,
		// 短期Copilot token保存在access。
		access: token,
		// 服务端秒级绝对时间乘1000再减5分钟，本地标记提前到期。
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		// 可选企业域保存在开放扩展字段。
		enterpriseUrl: enterpriseDomain,
	};
}

/**
 * Refresh GitHub Copilot token
 */
/**
 * 先换发Copilot token，再读取账号模型目录，把availableModelIds附到新凭证返回。
 * 刷新阶段目录请求maxRetries=0，即便429也直接失败；例：这里不自动启用policy，目录请求失败时不返回前一步token给外层存储。
 */
async function refreshGitHubCopilotToken(
	// 旧GitHub身份token。
	refreshToken: string,
	// 可选企业域。
	enterpriseDomain: string | undefined,
	// 贯穿token与目录读取的取消signal。
	signal: AbortSignal,
	// 异步返回附账号模型列表的新凭证。
): Promise<OAuthCredential> {
	// 先换短期token，失败不继续读目录。
	const credentials = await refreshGitHubCopilotAccessToken(refreshToken, enterpriseDomain, signal);
	// 读账号可用目录，忽略待启用policy列表。
	const { availableModelIds } = await fetchGitHubCopilotModels(credentials.access, enterpriseDomain, signal, {
		// 刷新期间不额外重试429。
		maxRetries: 0,
		// 不设置额外目录总重试预算，单请求仍有5秒限制。
		maxElapsedMs: 0,
	});
	// 创建带账号可用模型id的新凭证对象。
	return {
		// 展开刚换得token字段。
		...credentials,
		// 附此刻目录选择结果。
		availableModelIds,
	};
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
/**
 * 向单个模型policy端点POST enabled，返回HTTP成功与否，存在账号策略修改副作用。
 * 最多额外2次429重试、单次操作5秒总预算；用户取消与最终429抛错，其他网络/超时失败转false，其他HTTP失败也false。例：false让批量入口继续下一模型。
 */
async function enableGitHubCopilotModel(
	// 短期token，认证policy修改请求。
	token: string,
	// 要启用的模型id，直接插路径，不额外encodeURIComponent。
	modelId: string,
	// 可选企业域回退。
	enterpriseDomain: string | undefined,
	// 调用方总取消信号。
	signal: AbortSignal,
	// 异步返回此模型policy请求是否HTTP成功。
): Promise<boolean> {
	// 按同一token确定账号API根地址。
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	// 模型id拼policy修改地址。
	const url = `${baseUrl}/models/${modelId}/policy`;

	// Response由下方成功fetch赋值。
	let response: Response;
	// 传输/预算失败在此转换为false或取消异常。
	try {
		// 执行带429预算的策略更新。
		response = await fetchWithRateLimitRetry(
			// 使用模型policy端点。
			url,
			// 请求配置对象。
			{
				// POST实际修改远端策略，不是仅本地选择。
				method: "POST",
				// 准备JSON、认证及策略场景头。
				headers: {
					// 发送JSON编码正文。
					"Content-Type": "application/json",
					// 以短期Copilot token认证。
					Authorization: `Bearer ${token}`,
					// 附固定兼容客户端标识。
					...COPILOT_HEADERS,
					// 表明chat-policy请求意图。
					"openai-intent": "chat-policy",
					// 附交互类型为策略调整。
					"x-interaction-type": "chat-policy",
				},
				// 请求把state设enabled。
				body: JSON.stringify({ state: "enabled" }),
			},
			// 传调用方取消。
			signal,
			// 每个模型独立最多2次额外重试、总5秒预算，不是整批统一5秒。
			{ maxRetries: 2, maxElapsedMs: 5000 },
		);
		// 捕获网络、sleep、预算超时等异常。
	} catch (error) {
		// 只有调用方signal确已取消才向上抛。
		if (signal.aborted) throw error;
		// 其他传输/内部超时失败转false，允许批次继续。
		return false;
	}
	// 预算/次数用尽后返回429时单独抛出。
	if (response.status === 429) {
		// 附最终限流正文，批次入口可据抛错停止后续。
		throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
	}
	// 其余状态仅返回HTTP成功与否。
	return response.ok;
}

/**
 * Enable the requested GitHub Copilot models and return the successful IDs.
 * Policy updates are best effort; exhausted rate limiting stops the batch.
 */
/**
 * 依序尽力启用指定模型，返回HTTP成功的id数组，会修改远端账号策略。
 * 用户取消抛出，其余被下层抛出的错误（如耗尽429）停止剩余批次；下层false只跳该项。例：第一个传输失败false时仍试第二个，而不是整批全部成功才返回。
 */
async function enableGitHubCopilotModels(
	// 账号短期token。
	token: string,
	// readonly只限制TS修改此输入数组，不冻结运行时对象。
	modelIds: readonly string[],
	// 可选企业域。
	enterpriseDomain: string | undefined,
	// 整批共享调用方取消signal。
	signal: AbortSignal,
	// 异步返回成功启用的模型id数组，可能只有输入的子集。
): Promise<string[]> {
	// 收集成功启用id，初始为空。
	const enabledModelIds: string[] = [];
	// for...of逐个等待，不并发发policy请求。
	for (const modelId of modelIds) {
		// 单模型异常的批次协调范围。
		try {
			// true才计入成功列表，false会继续下一个。
			if (await enableGitHubCopilotModel(token, modelId, enterpriseDomain, signal)) {
				// 保存这次HTTP成功的模型id。
				enabledModelIds.push(modelId);
			}
			// 下层最终429或其他抛错进入这里。
		} catch (error) {
			// 用户取消必须传出，不能伪装部分成功。
			if (signal.aborted) throw error;
			// 其他抛错停止剩余批次，保留前面成功列表。
			break;
		}
	}
	// 返回成功子集，不保证所有候选已启用。
	return enabledModelIds;
}

/**
 * 协调登录：问企业域、申请/展示设备码、轮询GitHub身份、换Copilot token、读目录并尽力启用候选策略。
 * 返回携带可用模型id的新凭证，不保存；模型策略POST属于实际远端修改。例：空域输入用github.com，最终可用id为原目录和成功启用列表的有序去重并集。
 */
async function loginGitHubCopilot(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 先请求宿主输入企业URL/域名。
	const input = await interaction.prompt({
		// text类型prompt，返回字符串Promise。
		type: "text",
		// 空输入代表默认公共GitHub。
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		// 仅是示例占位，不设真实默认企业域。
		placeholder: "company.ghe.com",
	});
	// 等待输入后优先尊重已发生的取消。
	if (interaction.signal.aborted) throw new Error("Login cancelled");

	// 保存trim结果以区分空输入与有内容但解析失败。
	const trimmed = input.trim();
	// 将输入规范化为hostname或null。
	const enterpriseDomain = normalizeDomain(input);
	// 非空输入解析失败才报无效企业域；空输入允许默认。
	if (trimmed && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");
	// 企业域优先，否则github.com。
	const domain = enterpriseDomain || "github.com";

	// 申请并校验设备材料。
	const device = await startDeviceFlow(domain, interaction.signal);
	// 向宿主报告展示材料，不在此直接打开网页。
	interaction.notify({
		// 事件类型标识设备登录。
		type: "device_code",
		// 用户短码。
		userCode: device.user_code,
		// 已通过HTTP(S)规则的验证URI。
		verificationUri: device.verification_uri,
		// 可选轮询间隔秒数。
		intervalSeconds: device.interval,
		// 设备授权有效秒数。
		expiresInSeconds: device.expires_in,
	});

	// 等待GitHub身份token。
	const githubAccessToken = await pollForGitHubAccessToken(domain, device, interaction.signal);
	// 用身份token换短期Copilot凭证。
	const credentials = await refreshGitHubCopilotAccessToken(
		// 传刚拿到的GitHub身份token。
		githubAccessToken,
		// null归一化为undefined以匹配可选域参数。
		enterpriseDomain ?? undefined,
		// 原样传整体取消。
		interaction.signal,
	);
	// 登录阶段读取账号模型目录。
	const models = await fetchGitHubCopilotModels(
		// 用新短期Copilot token认证。
		credentials.access,
		// 可选企业域回退。
		enterpriseDomain ?? undefined,
		// 目录请求观察相同总signal。
		interaction.signal,
		// 登录读取目录允许有限429重试。
		{
			// 最多额外2次目录请求。
			maxRetries: 2,
			// 本次目录操作总预算5秒。
			maxElapsedMs: 5000,
		},
	);
	// 默认没有通过policy新启用的id。
	let enabledModelIds: string[] = [];
	// 有候选才产生策略修改请求。
	if (models.policyModelIds.length > 0) {
		// 通知宿主即将启用模型，实际动作在下一函数。
		interaction.notify({ type: "progress", message: "Enabling models..." });
		// 逐个尽力更新候选账号策略。
		enabledModelIds = await enableGitHubCopilotModels(
			// 短期token作为认证。
			credentials.access,
			// 仅传解析器筛出的已知、工具未明确禁用、未配置候选。
			models.policyModelIds,
			// 可选企业域。
			enterpriseDomain ?? undefined,
			// 整批观察总取消。
			interaction.signal,
		);
	}
	// 返回最终凭证，不在这里写store。
	return {
		// 保留短期token/长期身份token/过期/企业域。
		...credentials,
		// Set保留首次顺序并去重目录id与成功启用id的并集。
		availableModelIds: [...new Set([...models.availableModelIds, ...enabledModelIds])],
	};
}

/**
 * 从凭证开放扩展字段enterpriseUrl中取企业域，返回规范化hostname或undefined。
 * 例：旧存储含完整URL也可归一化；只校验非空字符串并解析，不保证域名可访问。
 */
function copilotEnterpriseDomain(credential: OAuthCredential): string | undefined {
	// 开放扩展字段读取出来仍需检查类型。
	const enterpriseUrl = credential.enterpriseUrl;
	// 字段非字符串或空串时当无企业域。
	if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return undefined;
	// 解析失败的null也统一为undefined。
	return normalizeDomain(enterpriseUrl) ?? undefined;
}

// OAuthAuth接口约束适配对象，不是在导入时执行登录。
export const githubCopilotOAuth: OAuthAuth = {
	// 登录界面显示名。
	name: "GitHub Copilot",
	// 订阅标记不是本地套餐验证。
	isSubscription: true,
	// 登录函数引用，等待外层调用。
	login: loginGitHubCopilot,
	/**
	 * 把统一刷新回调接到Copilot刷新协调，传GitHub身份token、规范化企业域和取消signal。
	 * 返回新凭证Promise；例：不是用短期credential.access当refresh token。
	 */
	refresh: (credential, signal) =>
		// refresh回调把长期身份token及规范化域交刷新协调。
		refreshGitHubCopilotToken(credential.refresh, copilotEnterpriseDomain(credential), signal),

	/** Derive the credential-specific proxy endpoint for each request. */
	/**
	 * 为每次请求从凭证派生apiKey与baseUrl，返回认证对象Promise，无网络/存储。
	 * 例：access内proxy-ep改变时返回不同根URL；不在此验证token是否真实或仍有效。
	 */
	async toAuth(credential) {
		// 组通用认证对象，每次调用重新派生端点。
		return {
			// 短期access作为最终apiKey。
			apiKey: credential.access,
			// token内proxy-ep优先，其次企业/个人回退。
			baseUrl: getGitHubCopilotBaseUrl(credential.access, copilotEnterpriseDomain(credential)),
		};
	},
};
