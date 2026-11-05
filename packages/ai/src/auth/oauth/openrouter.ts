// OpenRouter浏览器PKCE登录适配：本地回调与手动输入竞速，兑换长期API key；用OAuthCredential承载key而不实际刷新它。
/**
 * OpenRouter OAuth PKCE flow.
 *
 * OpenRouter exchanges an authorization code for a permanent, user-controlled
 * API key rather than an expiring access/refresh token pair. The callback is
 * handled by a one-shot loopback server on an ephemeral port, raced against a
 * manual prompt so remote/headless sessions can paste the redirect URL when
 * the browser cannot reach the loopback server.
 *
 * NOTE: This module uses node:http (via callback-server.ts) for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

// 通过统一环境helper读取host覆盖，含常规进程/Bun回退。
import { getProviderEnvValue } from "../../utils/provider-env.ts";
// type导入只提供编译期认证结构。
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
// 共享回调服务器负责一次认领，竞速helper负责等待和取消手动输入。
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
// 共享PKCE生成同次verifier/challenge配对。
import { generatePKCE } from "./pkce.ts";

// 用户浏览器打开的授权页面。
const AUTHORIZE_URL = "https://openrouter.ai/auth";
// 授权码兑换API key的JSON端点。
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
// 回调等待期限5分钟，单位毫秒。
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
// 30_000中的下划线只是数值分隔符，值为30000毫秒。
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * 读取本地回调监听host，返回配置覆盖或127.0.0.1，无网络。
 * 例：PI_OAUTH_CALLBACK_HOST=localhost影响监听和回调URI；这里不校验该覆盖一定是回环地址。
 */
function getCallbackHost(): string {
	// ||让空环境字符串回退默认host；不在此做URL验证。
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

// 未知远端JSON的字典视图，每个字段需另行收窄。
type JsonObject = Record<string, unknown>;

/**
 * 从手动输入提取授权码，返回字符串或undefined，无HTTP。
 * 依次尝试完整URL、含code=的查询串、裸码；例：" abc "变abc。完整URL只取参数，不要求域名/路径等于本次callback，也没有state校验。
 */
function parseAuthorizationInput(input: string): string | undefined {
	// 去两端空白，不改变内部字符。
	const value = input.trim();
	// 全空白输入直接返回缺失。
	if (!value) return undefined;

	// 尝试完整URL解析，失败才能走后续两种形式。
	try {
		// URL解析成功即返回code；没有code不会再把整条URL当裸码。
		return new URL(value).searchParams.get("code") ?? undefined;
		// 仅吞掉URL解析异常以尝试其他输入形式。
	} catch {
		// not a URL
	}

	// 非URL且含code=时按查询参数处理。
	if (value.includes("code=")) {
		// get缺失为null，??转undefined。
		return new URLSearchParams(value).get("code") ?? undefined;
	}

	// 否则把trim后的整段当授权码，不在此验证格式。
	return value;
}

/**
 * 从远端JSON按优先级提取错误说明，无副作用，返回可选字符串。
 * 例：error为对象时只看其message；空字符串也可被选中，函数不trim或脱敏。
 */
function errorDetail(body: JsonObject): string | undefined {
	// 首选error_description字符串，包括空串。
	if (typeof body.error_description === "string") return body.error_description;
	// 其次message字段。
	if (typeof body.message === "string") return body.message;
	// 再接受字符串error本身。
	if (typeof body.error === "string") return body.error;
	// error为非空非数组object时尝试嵌套message。
	if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
		// as只允许以字典方式访问，真实字段仍unknown。
		const message = (body.error as JsonObject).message;
		// 嵌套message确为字符串才返回。
		if (typeof message === "string") return message;
	}
	// 没有可读字段时不附详情。
	return undefined;
}

/**
 * 提交授权码与同次PKCE verifier兑换API key，返回统一OAuth凭证。
 * 合并调用方取消和30秒计时，fetch/正文解析结束后移除监听及计时器；HTTP失败/缺key会抛错。
 * 例：远端key存access，refresh为空，expires设最大安全整数以避免常规到期调度；不保证远端永不吊销key。
 */
async function exchangeAuthorizationCode(
	// 浏览器或手动输入得到的授权码。
	code: string,
	// 必须属于生成本次challenge的原verifier。
	verifier: string,
	// 本次调用方取消信号。
	signal: AbortSignal,
	// 返回统一OAuthCredential的Promise，实际access保存长期API key。
): Promise<OAuthCredential> {
	// 已经取消则在创建timer或请求前拒绝。
	if (signal.aborted) throw new Error("Login cancelled");
	// 建立只属于本次兑换的控制器。
	const controller = new AbortController();
	/**
	 * 取消监听回调把调用方reason转给本次兑换控制器；无返回值，不直接清理timer。
	 * 例：用户取消时fetch观察controller.signal，catch再转Login cancelled。
	 */
	const onAbort = () => controller.abort(signal.reason);
	// 一次性转发用户取消，finally仍主动卸载监听。
	signal.addEventListener("abort", onAbort, { once: true });
	// 安排本次兑换的超时回调。
	const timeout = setTimeout(
		// 30秒到时发abort并附超时reason，不是直接抛出同步异常。
		() => controller.abort(new Error("OpenRouter OAuth token exchange timed out")),
		// 超时长度用独立兑换常量。
		TOKEN_EXCHANGE_TIMEOUT_MS,
	);

	// Response稍后由fetch赋值，类型本身不发送请求。
	let response: Response;
	// 默认空正文对象，便于非JSON错误返回时统一处理。
	let body: JsonObject = {};
	// try覆盖fetch和JSON读取，finally释放计时/监听。
	try {
		// 向固定兑换端点发HTTP请求。
		response = await fetch(TOKEN_URL, {
			// 使用POST提交授权码。
			method: "POST",
			// 发送JSON且期望JSON响应。
			headers: { accept: "application/json", "content-type": "application/json" },
			// JSON包含授权码、同次verifier及S256方法名。
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			// fetch使用同时接受用户取消和timer的控制器信号。
			signal: controller.signal,
		});
		// 正文解析单独捕获，以区分成功HTTP坏JSON与失败HTTP坏JSON。
		try {
			// 解析结果先声明unknown，不把远端JSON当可信类型。
			const parsed = (await response.json()) as unknown;
			// 仅接收非空非数组object为字段字典，其他合法JSON仍保留默认{}。
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonObject;
			// JSON读取/解析抛错进入此分支。
		} catch {
			// 成功HTTP坏JSON要拒绝；失败HTTP坏JSON则留给状态错误分支。
			if (response.ok) throw new Error("OpenRouter OAuth returned invalid JSON");
		}
		// 网络或内层抛错统一在此按取消/超时分流。
	} catch (error) {
		// 用户取消优先报告Login cancelled。
		if (signal.aborted) throw new Error("Login cancelled");
		// 本地timer取消时报告兑换超时。
		if (controller.signal.aborted) throw new Error("OpenRouter OAuth token exchange timed out");
		// 其他错误保留原值，例如无效JSON错误。
		throw error;
		// 无论请求成功或失败，都清理本次临时资源。
	} finally {
		// 停止尚未触发的超时timer。
		clearTimeout(timeout);
		// 移除对调用方signal的转发监听。
		signal.removeEventListener("abort", onAbort);
	}

	// HTTP非2xx不得当作已兑换成功。
	if (!response.ok) {
		// 从解析出的错误对象抽可读详情。
		const detail = errorDetail(body);
		// Error保留HTTP状态及可选远端说明，不脱敏。
		throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
	}

	// 成功HTTP还必须含非空字符串key；空白串未额外排除。
	if (typeof body.key !== "string" || body.key.length === 0) {
		// 缺key即失败，不伪造凭证。
		throw new Error('OpenRouter OAuth response carries no "key"');
	}

	// 把长期API key封装为外层统一OAuth数据结构。
	return {
		// type字面量使存储/解析选OAuth分支。
		type: "oauth",
		// 真实API key放access。
		access: body.key,
		// 没有refresh token，明确存空字符串。
		refresh: "",
		// 最大安全整数当本地远期过期时间，不是远端有效性承诺。
		expires: Number.MAX_SAFE_INTEGER,
	};
}

/**
 * 生成PKCE并启动随机端口、随机路径回调，然后通知宿主授权URL；回调和手动输入竞争。
 * 回调路径在complete内兑换，手动路径解析后兑换；成功/失败都在finally关闭回调服务。例：浏览器在别机时可粘贴完整URL或裸码。
 * 5分钟是回调等待期限，已开始的complete不由它强制中断；兑换另有30秒信号。监听失败直接拒绝，不降级为纯手动流程。
 */
async function loginOpenRouter(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 解构得到这一次授权专属verifier和challenge。
	const { verifier, challenge } = await generatePKCE();
	// OpenRouter sends no `state`; the random path keeps stray requests from completing the sign-in.
	// 先等待服务成功监听，再准备授权URL。
	const callback = await startOAuthCallbackServer({
		// 用于共享回调服务的页面/错误显示名称。
		providerName: "OpenRouter",
		// 监听地址可由环境覆盖。
		host: getCallbackHost(),
		// port=0让操作系统挑空闲端口。
		port: 0,
		// 随机UUID拼回调路径；服务端不发state，本流程不额外比较state。
		path: `/oauth/callback/${crypto.randomUUID()}`,
		/**
		 * 收到回调code后用当前闭包verifier兑换key并返回Promise。
		 * 例：共享服务器等待兑换成功才发成功页面，失败会返回错误页面；这里没有独立生成第二套PKCE。
		 */
		complete: (code) => exchangeAuthorizationCode(code, verifier, interaction.signal),
		// 共享服务器观察整体取消信号。
		signal: interaction.signal,
		// 5分钟限制共享等待Promise；兑换已开始也可超时结算，但不会强行停止兑换工作。
		timeoutMs: LOGIN_TIMEOUT_MS,
	});

	// 服务启动后进入try，覆盖URL构造、notify、竞速与兑换。
	try {
		// 以固定授权页建立URL对象。
		const authorizeUrl = new URL(AUTHORIZE_URL);
		// 整体设置查询串，URLSearchParams负责转义。
		authorizeUrl.search = new URLSearchParams({
			// 把本次动态端口/随机路径的真实URI交服务端。
			callback_url: callback.redirectUri,
			// 只发送challenge，verifier保留在本地闭包。
			code_challenge: challenge,
			// 指定SHA-256派生的PKCE方法。
			code_challenge_method: "S256",
			// 查询参数转字符串赋给search，不手工拼&。
		}).toString();

		// 先通知宿主监听地址便于展示进度。
		interaction.notify({
			// progress事件，不触发额外HTTP。
			type: "progress",
			// 展示共享服务器返回的实际回调URI。
			message: `Listening for OpenRouter OAuth callback on ${callback.redirectUri}`,
		});
		// 再通知宿主可打开的授权页。
		interaction.notify({
			// auth_url事件由宿主决定如何打开/展示。
			type: "auth_url",
			// 把URL对象序列化为字符串。
			url: authorizeUrl.toString(),
			// 附浏览器与手动回填的操作说明。
			instructions:
				// 这是原始UI提示文案，不在代码中实现浏览器启动。
				"Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		// 同时启动手动提示；回调未认领时手动可接管，已认领则继续等其兑换；helper最后取消手动提示。
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			// 手动输入提示允许完整URL或裸码。
			message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
			// 用本次动态URI作为示例占位。
			placeholder: callback.redirectUri,
		});
		// 回调分支complete已兑换完，直接返回凭证，避免第二次兑换。
		if (result.type === "callback") return result.value;
		// 手动分支仅有输入文字，需要自行提取code。
		const code = parseAuthorizationInput(result.input);
		// 空/无code时明确拒绝，不发兑换请求。
		if (!code) throw new Error("Missing authorization code");
		// 通知即将兑换，不代表兑换已经成功。
		interaction.notify({ type: "progress", message: "Exchanging authorization code for an API key..." });
		// await覆盖兑换异常，使finally在兑换结算后关闭服务。
		return await exchangeAuthorizationCode(code, verifier, interaction.signal);
		// 成功、取消或失败均清理本地监听。
	} finally {
		// 关闭共享回调服务，调用不在此await关闭完成。
		callback.close();
	}
}

// 认证适配对象由供应商auth配置引用。
export const openRouterOAuth: OAuthAuth = {
	// 认证方案显示名称。
	name: "OpenRouter OAuth",
	// 登录按钮文案。
	loginLabel: "Sign in with OpenRouter",
	// 传登录函数引用，不在导入时执行。
	login: loginOpenRouter,
	/**
	 * 满足OAuthAuth刷新接口但原样返回credential，忽略_signal，不发网络。
	 * 例：长期key若被远端吊销不会在这里自动换key，需用户重新授权；async仍返回Promise。
	 */
	async refresh(credential, _signal) {
		// 保留原credential引用；不复制、不延长过期时间或发送请求。
		return credential;
	},
	/**
	 * 把credential.access映射为通用apiKey，返回Promise，无网络/到期校验。
	 * 例：key将由供应商请求适配器放入最终认证，不在此构造HTTP请求。
	 */
	async toAuth(credential) {
		// access中保存长期key，作为通用apiKey返回。
		return { apiKey: credential.access };
	},
};
