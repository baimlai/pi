/**
 * GitLab Duo Provider Extension
 *
 * Provides access to GitLab Duo AI models (Claude and GPT) through GitLab's AI Gateway.
 * Delegates to pi-ai's built-in Anthropic and OpenAI streaming implementations.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-gitlab-duo
 *   # Then /login gitlab-duo, or set GITLAB_TOKEN=glpat-...
 */

/**
 * 文件导读（custom-provider-gitlab-duo 扩展示例入口）
 *
 * 所属与用途：本文件是 `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo`
 * 扩展包的入口，演示注册 `gitlab-duo` 供应商，通过 GitLab AI Gateway 访问 Claude 与 GPT 模型。
 * 它不自己实现 SSE 解析，而是把请求委托给 pi-ai 内置的 Anthropic Messages/OpenAI Responses
 * 流实现，本文件负责认证、网关地址、模型目录和事件转发。
 *
 * 上游如何进入：同目录 `package.json` 的 `pi.extensions: ["./index.ts"]` 指定本入口；
 * `pi -e <此目录>` 加载时调用默认导出，注册供应商。之后 `/login gitlab-duo` 走 OAuth，
 * 或设置 `GITLAB_TOKEN=glpat-...` 作为 API key；再用 `/model` 选择 `gitlab-duo/<模型 id>`。
 * 同目录 `test.ts` 也会导入本文件的 `MODELS` 与 `streamGitLabDuo`，是独立于宿主的命令行测试。
 *
 * 下游依赖：`@earendil-works/pi-ai/compat` 提供 `anthropicMessagesApi`、`openAIResponsesApi`、
 * 流事件类型与 `ThinkingLevelMap`；`@earendil-works/pi-coding-agent` 只提供扩展 API 类型。
 * 一次模型请求通常先向 gitlab.com 换 direct access token（缓存命中时省略），再向 GitLab AI Gateway
 * 发模型请求；不写文件，凭证持久化由宿主负责。
 *
 * 能力清单：
 * - `MODELS`：九个模型的元数据（后端类型、代理地址、价格、上下文窗口等），也供测试导入。
 * - `getDirectAccessToken` / `invalidateDirectAccessToken`：换取并缓存网关直连令牌。
 * - `generatePKCE`、`loginGitLab`、`refreshGitLabToken`：GitLab OAuth 登录与刷新。
 * - `streamGitLabDuo`：选择 Anthropic 或 OpenAI 内置实现并转发事件。
 * - 默认导出工厂：调用 `pi.registerProvider` 注册供应商、模型、OAuth 与流函数。
 *
 * 典型运行顺序（示例命令，均会访问网络）：
 *   1. `pi -e ./packages/coding-agent/examples/extensions/custom-provider-gitlab-duo`
 *   2. `/login gitlab-duo`，浏览器授权后把回调地址整段粘贴回终端
 *   3. `/model gitlab-duo/claude-sonnet-4-6`，然后正常对话
 * 也可以跳过登录：`GITLAB_TOKEN=glpat-... pi -e <此目录>`。
 * 失败行为：没有 token 时流上返回 error 事件；GitLab 403 时会给出“确认已启用 Duo”的提示。
 *
 * 示例（真实签名，不发起请求的纯函数调用）：
 *   import { MODELS } from "./index.ts";
 *   const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-6");
 *   console.log(sonnet?.backend); // "anthropic"
 * 真正调用 `streamGitLabDuo(model, context, { apiKey })` 会产生网络请求和费用。
 *
 * 建议阅读顺序：先看 `MODELS` 了解模型与后端分流，再看 `getDirectAccessToken`（最容易出错的
 * 认证步骤），随后看 `streamGitLabDuo`，最后读 OAuth 与默认导出。
 *
 * 注意：direct access token 缓存是模块级单槽，且没有按 GitLab token 区分；同一进程切换账号时
 * 可能复用上一个账号的缓存。缓存 TTL 固定 25 分钟，未使用响应里的实际过期时间。
 */

import {
	type Api,
	type AssistantMessageEventStream,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	openAIResponsesApi,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

// GitLab 主站用于 OAuth 和 direct access token；AI Gateway 用于实际模型代理请求。
const GITLAB_COM_URL = "https://gitlab.com";
const AI_GATEWAY_URL = "https://cloud.gitlab.com";
// 两个后端各有一个代理前缀；Anthropic 路径末尾有斜杠，OpenAI 路径末尾没有，改动时需与网关约定一致。
const ANTHROPIC_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/anthropic/`;
const OPENAI_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/openai/v1`;

// 公开的 OAuth 客户端 id（不是密钥）。OAUTH_SCOPES 只有 "api"，即代表用户调用 GitLab API。
const BUNDLED_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const OAUTH_SCOPES = ["api"];
// GitLab 会把授权码重定向到这个地址。本示例不启动本地服务器；浏览器可能显示无法连接，
// 但地址栏仍带着 `?code=...`，用户把整段 URL 粘贴回终端即可。
const REDIRECT_URI = "http://127.0.0.1:8080/callback";
// direct access token 的本地缓存时长：25 分钟。代码不读取响应中的真实过期时间，
// 这只是固定的启发式时长，不是对服务端有效期的精确跟随。
const DIRECT_ACCESS_TTL = 25 * 60 * 1000;

// =============================================================================
// Models - exported for use by tests
// =============================================================================

// 字符串字面量联合类型：只允许这两个值，编译期防止把后端写错。
type Backend = "anthropic" | "openai";

/**
 * 本示例的模型描述，比 Pi 的 `Model` 多一个 `backend` 字段，用于选择内置流实现。
 * 这些字段只在 TypeScript 编译期检查；运行时数据是普通对象，不会校验。
 * `thinkingLevelMap` 可选：把 Pi 的推理档位映射成供应商值，例如 `{ xhigh: "max" }`。
 */
interface GitLabModel {
	id: string;
	name: string;
	backend: Backend;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

// 模型目录是静态数据：注册供应商时直接映射，流函数再按 id 查表取代理地址与后端类型。
// `: GitLabModel[]` 让编译器逐个检查对象字段，但数组内容不会在运行时校验。
export const MODELS: GitLabModel[] = [
	// Anthropic
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-5-20251101",
		name: "Claude Opus 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
	{
		id: "claude-sonnet-4-5-20250929",
		name: "Claude Sonnet 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 16384,
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	// OpenAI (all use Responses API)
	{
		id: "gpt-5.5-2026-04-23",
		name: "GPT-5.5",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.1-2025-11-13",
		name: "GPT-5.1",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5-mini-2025-08-07",
		name: "GPT-5 Mini",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5-codex",
		name: "GPT-5 Codex",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

// id 到模型对象的查找表；`MODELS.map` 生成 `[id, model]` 二元组数组，再交给 Map 构造。
const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

// =============================================================================
// Direct Access Token Cache
// =============================================================================

// GitLab 网关要求先用 GitLab 访问令牌换一个短期直连令牌，并附带响应给出的额外请求头。
// `headers` 是普通字符串字典；`expiresAt` 是本地计算的毫秒时间戳。
interface DirectAccessToken {
	token: string;
	headers: Record<string, string>;
	expiresAt: number;
}

// 模块级单槽缓存。它不是按 GitLab token 或用户区分的；同一进程切换账号时可能命中旧账号的令牌。
// 修改这个变量不是线程安全问题（Node 单线程），但并发调用可能产生重复请求。
let cachedDirectAccess: DirectAccessToken | null = null;

/**
 * 用 GitLab 访问令牌换取 AI Gateway 的 direct access token。
 *
 * 输入：`gitlabAccessToken`，来自 `options.apiKey`（OAuth access token 或 GITLAB_TOKEN）。
 * 输出：`{ token, headers, expiresAt }`，其中 headers 需要原样附加到模型请求上。
 * 副作用：缓存未命中时向 gitlab.com 发 POST；成功后写模块级缓存，约 25 分钟内复用。
 * 错误路径：403 抛出说明 Duo 未启用的错误；其他非 2xx 抛出状态码与响应正文。
 * 主要流程：检查缓存是否未过期 -> 请求 direct_access -> 处理错误 -> 缓存结果。
 *
 * 示例：`await getDirectAccessToken("glpat-xxx")` 返回
 * `{ token: "eyJ...", headers: { "X-Gitlab-...": "..." }, expiresAt: 1730000000000 }`。
 * 示例/真实差异：缓存返回时不会再发请求；所以观察到的输出可能立即返回。
 */
async function getDirectAccessToken(gitlabAccessToken: string): Promise<DirectAccessToken> {
	const now = Date.now();
	// 只要存在且未过期就直接复用；不校验缓存属于哪个 GitLab token。
	if (cachedDirectAccess && cachedDirectAccess.expiresAt > now) {
		return cachedDirectAccess;
	}

	const response = await fetch(`${GITLAB_COM_URL}/api/v4/ai/third_party_agents/direct_access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${gitlabAccessToken}`, "Content-Type": "application/json" },
		// feature_flags 打开新版 Duo Agent 平台；具体含义由 GitLab 服务端解释。
		body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 403) {
			// 403 在此示例中按“Duo 未启用”给出可操作提示；服务端也可能因权限、许可证或令牌范围返回 403。
			throw new Error(
				`GitLab Duo access denied. Ensure GitLab Duo is enabled for your account. Error: ${errorText}`,
			);
		}
		throw new Error(`Failed to get direct access token: ${response.status} ${errorText}`);
	}

	// 响应字段由服务端决定；类型断言不做运行时校验，缺字段不会在这里暴露，
	// 后续可能发出无效的认证头或收到失败的模型请求。
	const data = (await response.json()) as { token: string; headers: Record<string, string> };
	cachedDirectAccess = { token: data.token, headers: data.headers, expiresAt: now + DIRECT_ACCESS_TTL };
	return cachedDirectAccess;
}

/**
 * 清空 direct access token 缓存。
 *
 * 输入/输出/副作用：无参数、无返回值；把模块级缓存置空，使下一次请求重新换取。
 * 调用时机：登录成功或刷新 token 后，防止继续使用旧账号/旧权限的直连令牌。
 * 示例：`invalidateDirectAccessToken(); await getDirectAccessToken(newToken);` 会强制刷新。
 */
function invalidateDirectAccessToken() {
	cachedDirectAccess = null;
}

// =============================================================================
// OAuth
// =============================================================================

/**
 * 生成 OAuth PKCE 的 verifier 与 challenge。
 *
 * 输入：无。输出：`{ verifier, challenge }` 两个 base64url 字符串。
 * 副作用：读取系统随机源并计算 SHA-256；无网络、无文件。
 * 错误路径：平台缺少 Web Crypto 时摘要 Promise 拒绝。
 * 与 Anthropic 版本的实现相同：32 字节随机数 -> base64url 作为 verifier ->
 * verifier 的 SHA-256 -> base64url 作为 challenge。
 *
 * 示例：`const { verifier, challenge } = await generatePKCE();` 每次得到不同值。
 */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	// `String.fromCharCode(...array)` 把 32 个字节散开成字符参数；btoa 再做 base64。
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { verifier, challenge };
}

/**
 * 交互式 GitLab OAuth 登录。
 *
 * 输入：`callbacks`，宿主提供 `onAuth`（展示链接）和 `onPrompt`（读用户输入）。
 * 输出：`OAuthCredentials`，`expires` 是绝对毫秒时间戳。
 * 副作用：向 gitlab.com 发 token 请求；登录成功后清空 direct access 缓存。
 * 错误路径：回调 URL 不含 `code`、token 端点非 2xx 时抛错；`new URL` 遇到非法输入也会抛 TypeError。
 * 主要流程：生成 PKCE -> 拼授权 URL -> 展示 -> 用户粘贴回调 URL -> 解析 code ->
 * 用 `application/x-www-form-urlencoded` 换 token -> 计算过期时间。
 *
 * 示例：用户把 `http://127.0.0.1:8080/callback?code=abc&state=...` 粘回终端后，
 * 函数返回 `{ refresh: "...", access: "...", expires: 1730000000000 }`。
 * `state` 在这里只是随机生成并发送，回调解析时没有再校验它；这是一个真实的安全缺口。
 */
async function loginGitLab(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	// URLSearchParams 负责 URL 编码；scope 用空格连接，符合 OAuth 规范。
	const authParams = new URLSearchParams({
		client_id: BUNDLED_CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		scope: OAUTH_SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		// `crypto.randomUUID()` 生成随机 state；这里发送了，但下面没有比对返回值。
		state: crypto.randomUUID(),
	});

	callbacks.onAuth({ url: `${GITLAB_COM_URL}/oauth/authorize?${authParams.toString()}` });
	const callbackUrl = await callbacks.onPrompt({ message: "Paste the callback URL:" });
	// `new URL` 解析整段地址；`searchParams.get("code")` 取查询参数，缺失返回 null。
	const code = new URL(callbackUrl).searchParams.get("code");
	if (!code) throw new Error("No authorization code found in callback URL");

	const tokenResponse = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		// GitLab 的 token 端点要求表单编码，不是 JSON。
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: BUNDLED_CLIENT_ID,
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
		}).toString(),
	});

	if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
	// 类型断言只用于编译期；服务端实际返回的字段没有运行时校验。
	const data = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		created_at: number;
	};
	// 新账号的令牌不能继续复用旧的 direct access token。
	invalidateDirectAccessToken();
	return {
		refresh: data.refresh_token,
		access: data.access_token,
		// created_at 与 expires_in 都是秒；转毫秒后同样提前 5 分钟过期。
		expires: (data.created_at + data.expires_in) * 1000 - 5 * 60 * 1000,
	};
}

/**
 * 用 refresh token 刷新 GitLab OAuth 凭证。
 *
 * 输入：旧 `credentials`（使用 `refresh`）与取消信号 `signal`。
 * 输出：新凭证；refresh token 可能轮换，必须保存返回值。
 * 副作用：向 GitLab token 端点发 POST；成功后清空 direct access 缓存。
 * 错误路径：非 2xx 抛错；signal 中止时 fetch 抛 AbortError。
 * 主要流程：表单 POST -> 检查状态 -> 解析 -> 清缓存 -> 计算绝对过期时间。
 *
 * 示例：`await refreshGitLabToken(old, controller.signal)` 返回新的 access/refresh。
 */
async function refreshGitLabToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const response = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: BUNDLED_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		}).toString(),
		// 与登录不同，刷新阶段支持调用方中止。
		signal,
	});
	if (!response.ok) throw new Error(`Token refresh failed: ${await response.text()}`);
	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		created_at: number;
	};
	invalidateDirectAccessToken();
	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: (data.created_at + data.expires_in) * 1000 - 5 * 60 * 1000,
	};
}

// =============================================================================
// Stream Function
// =============================================================================

/**
 * GitLab Duo 的流式入口：换取直连令牌，选择内置后端实现，并把事件原样转发给调用方。
 *
 * 输入：
 * - `model`：宿主传入的模型对象，其 `id` 必须能在 `MODEL_MAP` 中找到；认证用的 GitLab 令牌在 `options.apiKey`。
 * - `context`：Pi transcript；原样交给内置 Anthropic/OpenAI 实现。
 * - `options`：透传给内置实现；本函数只覆盖 `apiKey` 与 `headers`。
 * 输出：立即返回外层 `AssistantMessageEventStream`，异步转发内层事件。
 * 副作用：通常一到两次网络请求（direct access + 模型调用）；无文件写入。
 * 错误路径：没有 token、模型 id 不在 MODELS 中、换取令牌失败、内置实现初始化抛错，
 * 都会在外层流上推送一个 `error` 事件并结束流；内层流自身的 error 事件只是被转发。
 * 主要流程：校验 token -> 查模型配置 -> 换取直连令牌 -> 覆盖代理地址与认证头 ->
 * 按 backend 调用内置实现 -> for-await 转发所有事件 -> 结束外层流。
 *
 * 示例（真实签名）：
 *   const s = streamGitLabDuo(model, context, { apiKey: gitlabAccessToken, maxTokens: 100 });
 *   for await (const e of s) if (e.type === "text_delta") process.stdout.write(e.delta);
 * 示例会访问 GitLab；没有可用账号时只会看到 error 事件。
 *
 * 重要细节：`apiKey: "gitlab-duo"` 只是占位值，内置实现要求非空 key；真正的认证在 `headers`
 * 的 `Authorization: Bearer <directAccess.token>`。`{ ...options, ... }` 也让调用方无法覆盖这两个字段。
 */
export function streamGitLabDuo(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	// 异步 IIFE：错误不会 reject 外层调用，而是转成 error 事件。
	(async () => {
		try {
			// 供应商注册时 apiKey 模板解析出的 GitLab 令牌；OAuth 模式下是 access token。
			const gitlabAccessToken = options?.apiKey;
			if (!gitlabAccessToken) throw new Error("No GitLab access token. Run /login gitlab-duo or set GITLAB_TOKEN");

			// 用模型 id 找静态配置；未知 id 无法确定后端与代理地址。
			const cfg = MODEL_MAP.get(model.id);
			if (!cfg) throw new Error(`Unknown model: ${model.id}`);

			const directAccess = await getDirectAccessToken(gitlabAccessToken);
			// 覆盖 baseUrl 为对应后端的代理地址；其他模型字段（价格、上下文窗口）保持不变。
			const modelWithBaseUrl = { ...model, baseUrl: cfg.baseUrl };
			// 网关返回的 headers 可能包含额外元数据，必须保留；Authorization 用直连令牌覆盖。
			const headers = { ...directAccess.headers, Authorization: `Bearer ${directAccess.token}` };
			// 合并调用方选项并强制替换 key/headers；`options` 在展开前，所以前者会被覆盖。
			const streamOptions = { ...options, apiKey: "gitlab-duo", headers };

			// 按 backend 分流：三元表达式只创建对应后端的流，另一个分支不会执行。
			// 两处 `as Model<"...">` 是编译器无法从字符串收窄到具体 Api 泛型时的断言，无运行时效果。
			const innerStream =
				cfg.backend === "anthropic"
					? anthropicMessagesApi().streamSimple(
							{
								...(modelWithBaseUrl as Model<"anthropic-messages">),
								compat: {
									...(modelWithBaseUrl as Model<"anthropic-messages">).compat,
									// GitLab 代理要求 adaptive thinking（thinking.type: adaptive + effort）。
									forceAdaptiveThinking: true,
								},
							},
							context,
							streamOptions,
						)
					: openAIResponsesApi().streamSimple(
							modelWithBaseUrl as Model<"openai-responses">,
							context,
							streamOptions,
						);

			// 逐事件转发，保持顺序；内层流结束后关闭外层流。
			for await (const event of innerStream) stream.push(event);
			stream.end();
		} catch (error) {
			// 外层捕获设置与转发阶段的异常；内层实现通常把请求错误作为 error 事件送出，而不是抛错。
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

/**
 * 扩展默认导出：注册 `gitlab-duo` 供应商。
 *
 * 输入：`pi` 扩展 API。输出：无返回值。副作用：只改宿主内存中的注册表，不发请求。
 * 错误路径：字段结构错误在编译期报错；运行时宿主不会校验 `streamSimple` 的实际行为。
 * 主要流程：注册 baseUrl/API 标识 -> 把内部模型目录映射成 Pi 模型 -> 配置 OAuth -> 绑定流函数。
 *
 * 示例：加载后用 `/model` 能看到 `gitlab-duo/gpt-5.1` 等条目；选中后调用 `streamGitLabDuo`。
 * 环境变量 `GITLAB_TOKEN` 缺失且未 OAuth 登录时，首次请求会得到“没有 GitLab access token”的错误。
 */
export default function (pi: ExtensionAPI) {
	pi.registerProvider("gitlab-duo", {
		// 供应商级 baseUrl 只是目录信息；真正请求地址由 streamGitLabDuo 按后端覆盖为代理 URL。
		baseUrl: AI_GATEWAY_URL,
		apiKey: "$GITLAB_TOKEN",
		api: "gitlab-duo-api",
		// 解构参数只取 Pi 模型需要的字段，丢掉内部的 backend/baseUrl，避免宿主看到多余字段。
		models: MODELS.map(({ id, name, reasoning, thinkingLevelMap, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			thinkingLevelMap,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
		// OAuth 登录/刷新与取 key 回调；`cred` 是宿主保存的 OAuthCredentials。
		oauth: {
			name: "GitLab Duo",
			login: loginGitLab,
			refreshToken: refreshGitLabToken,
			getApiKey: (cred) => cred.access,
		},
		streamSimple: streamGitLabDuo,
	});
}
