/**
 * Custom Provider Example
 *
 * Demonstrates registering a custom provider with:
 * - Custom API identifier ("custom-anthropic-api")
 * - Custom streamSimple implementation
 * - OAuth support for /login
 * - API key support via environment variable
 * - Two model definitions
 *
 * Usage:
 *   # First install dependencies
 *   cd packages/coding-agent/examples/extensions/custom-provider && npm install
 *
 *   # With OAuth (run /login custom-anthropic first)
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider
 *
 *   # With API key
 *   CUSTOM_ANTHROPIC_API_KEY=sk-ant-... pi -e ./packages/coding-agent/examples/extensions/custom-provider
 *
 * Then use /model to select custom-anthropic/claude-sonnet-4-5
 */

/**
 * 文件导读（custom-provider-anthropic 扩展示例入口）
 *
 * 所属与用途：本文件是 `packages/coding-agent/examples/extensions/custom-provider-anthropic`
 * 扩展包的入口，演示用 `pi.registerProvider` 注册一个名为 `custom-anthropic` 的供应商。
 * 它不修改 Pi 内置模型目录，而是自带两个模型定义，并同时展示 API key 与 OAuth 两种认证方式。
 *
 * 上游如何进入：同一目录的 `package.json` 用 `pi.extensions: ["./index.ts"]` 声明本入口；
 * 运行 `pi --extension <此目录>`（或 `pi -e <此目录>`）时，扩展加载器读取清单并导入本文件，
 * 调用默认导出的工厂。注册在扩展加载阶段排队，runner 绑定会话后生效；之后可用 `/login custom-anthropic`
 * 走 OAuth，或用环境变量 `CUSTOM_ANTHROPIC_API_KEY` 提供 key，再用 `/model` 选择模型。
 *
 * 下游依赖：`@anthropic-ai/sdk` 负责真正发送 Anthropic Messages 请求；`@earendil-works/pi-ai`
 * 提供统一的模型/消息/流事件类型、上下文重放工具和费用计算；`@earendil-works/pi-coding-agent`
 * 只提供扩展 API 的类型。本文件不直接写文件或启动服务器，网络请求发生在流函数被调用时。
 *
 * 能力清单：
 * - `generatePKCE`：生成 OAuth PKCE 的 verifier 与 SHA-256 challenge。
 * - `loginAnthropic`：输出授权地址、接收用户粘贴的授权码并换取 token。
 * - `refreshAnthropicToken`：用 refresh token 换新凭证。
 * - `convertMessages`/`convertTools`/`convertContentBlocks`：把 Pi 的 transcript 转成 Anthropic 请求格式。
 * - `mapStopReason`：把 Anthropic 停止原因映射为 Pi 的 `StopReason`。
 * - `streamCustomAnthropic`：自定义 `streamSimple` 实现，逐事件转发 Anthropic 流。
 * - 默认导出工厂：调用 `pi.registerProvider`，声明两个模型与 OAuth 配置。
 *
 * 典型运行顺序：
 *   1. `cd packages/coding-agent/examples/extensions/custom-provider-anthropic && npm install --ignore-scripts`
 *   2. OAuth：`pi -e <此目录>`，执行 `/login custom-anthropic`，再 `/model custom-anthropic/claude-sonnet-4-5`
 *   3. 或 API key：`CUSTOM_ANTHROPIC_API_KEY=sk-ant-... pi -e <此目录>`
 * 请求结束后 token 用量与费用写回 assistant 消息的 `usage`；错误通过 `error` 流事件返回。
 *
 * 示例（真实签名，仅示意注册形状）：
 *   pi.registerProvider("custom-anthropic", {
 *     baseUrl: "https://api.anthropic.com",
 *     apiKey: "$CUSTOM_ANTHROPIC_API_KEY",
 *     api: "custom-anthropic-api",
 *     models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true,
 *                input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
 *                contextWindow: 200000, maxTokens: 64000 }],
 *   });
 * 上面的模型字段由本文件真实使用；注册本身不发送模型请求。
 *
 * 建议阅读顺序：先看文件末尾的默认导出，确认注册了哪些能力；再看 `streamCustomAnthropic`
 * 了解请求与事件流；最后读消息转换和 OAuth 辅助函数。原英文头部中的 `custom-provider` 路径是
 * 旧目录名，当前目录名为 `custom-provider-anthropic`，实际命令应使用本目录。
 *
 * 注意：本示例为教学精简版，`streamSimple` 只转发了 `signal`、`maxTokens`、`reasoning` 等少量选项，
 * 没有调用 `SimpleStreamOptions` 中可选的 `options.onPayload`/`options.onResponse` 钩子；接入生产环境前需补齐。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ImageContent,
	type Message,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	ToolCallArgumentsStream,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// OAuth implementation adapted for the legacy extension compatibility interface.
// =============================================================================

// OAuth 常量区：CLIENT_ID 是 Claude 公开客户端的标识，不需要保密，但为了与上游保持一致的
// 混淆形式，这里先用 base64 保存，运行时用 `atob` 解码。`atob`/`btoa` 是浏览器和 Node 都提供的
// 全局函数，前者把 base64 文本还原成字符串，后者把字符串编成 base64。
const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// 这个回调地址只用于展示，用户实际是把浏览器地址栏中的 code 粘贴回终端。
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

/**
 * 生成 PKCE（Proof Key for Code Exchange）所需的一对值。
 *
 * 输入：无。
 * 输出：`verifier`（随机的客户端秘密）与 `challenge`（verifier 的 SHA-256 摘要，再做 base64url）。
 * 副作用：读取系统随机源，不做网络请求，也不写任何状态。
 * 错误路径：浏览器/Node 不提供 `crypto.subtle` 时 Promise 会拒绝；正常环境下不会失败。
 * 主要流程：取 32 字节随机数 -> 把字节串转成 base64url 作为 verifier -> 对 verifier 做 SHA-256
 * -> 把摘要也转成 base64url 作为 challenge。
 *
 * 示例：`await generatePKCE()` 可能返回
 * `{ verifier: "kL7...", challenge: "8mQ..." }`；两者是随机值，每次调用都不同。
 * 编译期只检查返回结构；`crypto.subtle` 是否存在是运行期才暴露的平台能力。
 */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// 32 字节正好是 SHA-256 输出长度，也是 OAuth PKCE 推荐的 verifier 熵。
	const array = new Uint8Array(32);
	// 用密码学安全随机源填充数组；`crypto` 是 Node 全局 Web Crypto，不是 `node:crypto` 模块。
	crypto.getRandomValues(array);
	// `String.fromCharCode(...array)` 把每个字节变成字符；展开运算符把 32 个参数传给函数。
	// base64url 是 base64 的变体：`+` 换成 `-`、`/` 换成 `_`，并去掉末尾的 `=` 填充。
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	// TextEncoder 把字符串按 UTF-8 编码成字节，供 Web Crypto 计算摘要。
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	// `crypto.subtle.digest` 返回 ArrayBuffer，必须 await；同样转成 base64url。
	const hash = await crypto.subtle.digest("SHA-256", data);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return { verifier, challenge };
}

/**
 * 交互式 OAuth 登录：把授权地址交给上层展示，等用户粘贴授权码，再用它换取 token。
 *
 * 输入：`callbacks` 由宿主提供。`onAuth({url})` 用来展示授权链接，`onPrompt({message})` 打开输入框
 * 并返回用户输入。
 * 输出：`OAuthCredentials`，字段为 `refresh`、`access`、`expires`（毫秒时间戳）。
 * 副作用：向 Anthropic 的 token 端点发一次 POST；没有文件写入，凭证由宿主负责持久化。
 * 错误路径：HTTP 非 2xx 时抛错，错误文本包含响应正文；用户取消输入时 `onPrompt` 可能抛错或返回空串，
 * 空串会让后续 token 交换失败。
 * 主要流程：生成 PKCE -> 拼授权 URL -> 展示 -> 读授权码 -> 交换 token -> 提前 5 分钟标记过期。
 *
 * 示例：宿主调用 `loginAnthropic(callbacks)`；用户粘贴形如 `abc123#verifier` 的文本，
 * 函数返回 `{ refresh: "...", access: "...", expires: 1730000000000 }`。
 * 注意 `expires` 是绝对时间，不是剩余秒数。
 */
async function loginAnthropic(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	// 每次登录都生成新的 verifier，后续换取 token 时用它证明自己是发起授权的一方。
	const { verifier, challenge } = await generatePKCE();

	// URLSearchParams 会自动做 URL 编码，避免 scope 中的空格等字符破坏查询串。
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		// 这里复用 verifier 作为 state；Anthropic 的授权码会把 state 一并返回。
		state: verifier,
	});

	// 把授权地址交给调用方展示；本函数不直接打开浏览器。
	callbacks.onAuth({ url: `${AUTHORIZE_URL}?${authParams.toString()}` });

	// 等待用户在终端粘贴授权码；格式通常是 `<code>#<state>`。
	const authCode = await callbacks.onPrompt({ message: "Paste the authorization code:" });
	// 数组解构：按下 `#` 拆成两段，缺少第二段时 `state` 为 undefined。
	const [code, state] = authCode.split("#");

	// 用授权码换 token。注意这里没有传 `signal`，登录阶段无法通过 AbortSignal 取消请求。
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	// `fetch` 只有在网络层失败时才 reject；HTTP 4xx/5xx 仍会正常返回，需要手动检查 ok。
	if (!tokenResponse.ok) {
		throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
	}

	// 类型断言只影响编译期；运行时字段是否齐全完全取决于服务端响应。
	const data = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		// `expires_in` 单位是秒，乘以 1000 转毫秒；减去 5 分钟让宿主提前刷新。
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * 用 refresh token 换取新的访问凭证。
 *
 * 输入：旧凭证 `credentials`（至少使用 `refresh` 字段）与用于取消的 `signal`。
 * 输出：新的 `OAuthCredentials`；新旧 refresh token 都可能轮换，因此必须使用响应中的值。
 * 副作用：向 token 端点发 POST；调用方负责把返回值写回存储。
 * 错误路径：请求被 `signal` 中止时 `fetch` 抛出 AbortError；非 2xx 时抛出带响应正文的错误。
 * 主要流程：POST `grant_type=refresh_token` -> 检查状态 -> 解析 JSON -> 计算新的绝对过期时间。
 *
 * 示例：`await refreshAnthropicToken(oldCred, controller.signal)` 返回
 * `{ refresh: "new-r", access: "new-a", expires: ... }`。真实运行时 token 端点可能返回与输入
 * 完全相同的 refresh token，这不是错误。
 */
async function refreshAnthropicToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		}),
		// 宿主关闭或切换模型时可以中止这次刷新。
		signal,
	});

	if (!response.ok) {
		throw new Error(`Token refresh failed: ${await response.text()}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

// =============================================================================
// Streaming Implementation (simplified from packages/ai/src/api/anthropic-messages.ts)
// =============================================================================

// Claude Code tool names for OAuth stealth mode
// OAuth 凭证请求 Anthropic 服务端时，会模拟 Claude Code 客户端的工具名，以通过服务端的身份检查。
// 这段列表就是 Claude Code 认识的工具名；普通 API key 模式不进行这种改名。
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];
// 构建小写名到官方大小写的映射；`map` 回调返回二元组数组，交给 `new Map` 变成查找表。
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
// Pi 工具名可能大小写不同，查表时统一小写；`?? name` 表示未命中就保留原名。
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
/**
 * 把服务端返回的 Claude Code 工具名还原成 Pi 侧的真实工具名。
 *
 * 输入：`name` 为响应里的工具名；`tools` 是可选的当前工具定义列表。
 * 输出：在 `tools` 中找到大小写不敏感匹配时返回其原始 `name`，否则原样返回。
 * 副作用：无。错误路径：无，找不到只是返回输入值。
 *
 * 示例：`fromClaudeCodeName("read", [{ name: "Read", ... }])` 返回 `"Read"`；
 * 若工具列表为空，则 `"read"` 原样返回，后续执行可能因找不到工具而失败。
 */
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	const lowerName = name.toLowerCase();
	// 可选链 `?.`：`tools` 为 undefined 时整个表达式为 undefined，`find` 不会执行。
	const matched = tools?.find((t) => t.name.toLowerCase() === lowerName);
	return matched?.name ?? name;
};

/**
 * 判断一个 key 是否为本示例使用的 OAuth 访问令牌。
 *
 * 输入：`apiKey` 字符串。输出：布尔值。副作用：无。
 * 这里只是看 key 中是否包含 `sk-ant-oat`；这是启发式判断，不是服务端验证。
 * 示例：`isOAuthToken("sk-ant-oat01-...") === true`；普通 `sk-ant-api...` 返回 false。
 * 风险：如果普通 API key 恰好包含该子串，也会被当成 OAuth，从而使用错误的请求头。
 */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

/**
 * 把字符串中的 UTF-16 代理项（surrogate）替换成 Unicode 替换字符 U+FFFD。
 *
 * 输入：任意字符串。输出：替换后的新字符串。副作用：无。
 * 为什么需要：孤立的代理码元会让不少供应商的 JSON 序列化或解析失败；上游同类函数只删除
 * 未成对项，而本示例简化成正则替换全部代理码元。
 * 注意实现范围：正则 `[\uD800-\uDFFF]` 匹配所有代理码元，包括合法代理对的两个码元，
 * 因此 emoji 等扩展平面字符也会被逐个替换成 `\uFFFD`。这是该示例的真实行为，不是保守描述。
 *
 * 示例：`sanitizeSurrogates("hi \uD800")` 返回 `"hi \uFFFD"`；
 * `sanitizeSurrogates("\uD83D\uDE00")` 在 JS 中长度是 2，两个码元都会被替换，结果不再是原 emoji。
 */
function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

/**
 * 把工具结果里的内容块转成 Anthropic 的 tool_result content 形式。
 *
 * 输入：`content` 是文本块或图片块的数组。
 * 输出：没有图片时返回一个字符串；有图片时返回 Anthropic 内容块数组。
 * 副作用：无。错误路径：无；只做形状转换。
 * 主要流程：先检查是否至少有一个图片 -> 全是文本则拼接成一个字符串 -> 有图片则逐块转换 ->
 * 如果结果中没有文本块，补一句 `(see attached image)`。
 * 这是从上游实现沿用的保守处理：函数只检查是否存在文本块，不检查文本是否为空。
 *
 * 示例：`convertContentBlocks([{ type: "text", text: "hi" }])` 返回 `"hi"`；
 * 只有图片时返回数组，且首块是补上的 `{ type: "text", text: "(see attached image)" }`，
 * 后面才是转换后的图片块。类型上返回联合类型，调用方需要按实际分支处理。
 */
function convertContentBlocks(
	content: (TextContent | ImageContent)[],
): string | Array<{ type: "text"; text: string } | { type: "image"; source: any }> {
	// `some` 在遇到第一个图片块时返回 true，不会遍历完整个数组。
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		// 这里用断言 `as TextContent`，因为分支已保证没有图片；运行时仍是原对象。
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// `as const` 让字面量类型保持为 `"text"`/`"image"`，而不是被拓宽成 `string`。
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: sanitizeSurrogates(block.text) };
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType,
				data: block.data,
			},
		};
	});

	if (!blocks.some((b) => b.type === "text")) {
		// `unshift` 在数组头部插入，保证文本出现在图片之前。
		blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	}

	return blocks;
}

/**
 * 把 Pi 的完整消息数组转换成 Anthropic Messages API 的 `messages` 参数。
 *
 * 输入：`messages`（折叠后的 transcript 消息数组；其中的 system 消息由本函数跳过，
 * 系统提示另走顶层 `system` 参数）、`isOAuth`（决定工具是否改名）、`_tools`（本函数目前未使用，保留给签名兼容）。
 * 输出：Anthropic 格式的消息数组，元素是 `{ role, content }`；返回类型写成 `any[]`，没有运行时校验。
 * 副作用：无，返回新对象；不会修改输入消息。
 * 错误路径：无显式抛错；遇到未知角色会被忽略。
 * 主要流程：用户消息转文本或内容块 -> assistant 消息转 text/thinking/tool_use -> 连续的
 * toolResult 合并成一条 user 消息 -> 最后给最后一条 user 消息的最后一个块加缓存标记。
 *
 * 示例：输入 `[{ role: "user", content: "hi" }]` 返回 `[{ role: "user", content: "hi" }]`
 * （还会尝试对内容为字符串的末条消息加缓存，但字符串内容不是数组，因此实际跳过）。
 *
 * 关键规则：Anthropic 要求每个 tool_use 后面对应一个 tool_result，且多个工具结果可以合并为
 * 同一条 user 消息；这正是下面 `while` 循环和 `i = j - 1` 的作用。
 */
function convertMessages(messages: Message[], isOAuth: boolean, _tools?: Tool[]): any[] {
	const params: any[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "user") {
			// 用户内容有两种形状：纯字符串，或文本/图片块数组。
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				}
			} else {
				// 数组分支逐项转换；三元表达式按 `item.type` 收窄联合类型。
				const blocks: ContentBlockParam[] = msg.content.map((item) =>
					item.type === "text"
						? { type: "text" as const, text: sanitizeSurrogates(item.text) }
						: {
								type: "image" as const,
								source: { type: "base64" as const, media_type: item.mimeType as any, data: item.data },
							},
				);
				if (blocks.length > 0) {
					params.push({ role: "user", content: blocks });
				}
			}
		} else if (msg.role === "assistant") {
			// assistant 消息可能同时包含文本、思考过程和工具调用。
			const blocks: ContentBlockParam[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking" && block.thinking.trim()) {
					// 只有带签名的思考块才能回传给 Anthropic；这是服务端校验的要求。
					if ((block as ThinkingContent).thinkingSignature) {
						blocks.push({
							type: "thinking" as any,
							thinking: sanitizeSurrogates(block.thinking),
							signature: (block as ThinkingContent).thinkingSignature!,
						});
					} else {
						// 无签名时降级成普通文本，避免请求被服务端拒绝。
						blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuth ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments,
					});
				}
			}
			if (blocks.length > 0) {
				params.push({ role: "assistant", content: blocks });
			}
		} else if (msg.role === "toolResult") {
			// Anthropic 用 user 角色承载工具结果；连续的工具结果必须合并到同一条消息。
			const toolResults: any[] = [];
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// 从当前位置向后扫描同角色的消息；`j` 停在第一个非 toolResult 处。
			let j = i + 1;
			while (j < messages.length && messages[j].role === "toolResult") {
				const nextMsg = messages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}
			// 外层 for 循环还会执行一次 `i++`，所以这里退回到最后一个已处理项，
			// 下一次迭代正好从 `j`（第一个未处理消息）开始。
			i = j - 1;
			params.push({ role: "user", content: toolResults });
		}
	}

	// Add cache control to last user message
	// 给最后一条 user 消息的最后一个内容块打 ephemeral 缓存标记，便于服务端复用前缀。
	// 只有内容是数组时才可加字段；纯字符串内容会跳过，因此不是所有请求都有缓存标记。
	if (params.length > 0) {
		const last = params[params.length - 1];
		if (last.role === "user" && Array.isArray(last.content)) {
			const lastBlock = last.content[last.content.length - 1];
			if (lastBlock) {
				lastBlock.cache_control = { type: "ephemeral" };
			}
		}
	}

	return params;
}

/**
 * 把 Pi 的工具定义转成 Anthropic 的 tools 参数。
 *
 * 输入：`tools` 定义数组、`isOAuth` 是否重命名。
 * 输出：Anthropic 工具数组；返回类型为 `any[]`，字段正确性只靠约定。
 * 副作用：无。错误路径：类型文档约定 `tool.parameters` 是 JSON Schema；这里用 `as any` 读取
 * `properties`/`required`，运行时不校验 schema 是否真的符合 JSON Schema 规范。
 * 主要流程：逐个工具映射 name/description/input_schema，并从 JSON Schema 中取 properties 与 required。
 *
 * 示例：`convertTools([{ name: "read", description: "Read file", parameters: { type: "object",
 * properties: { path: { type: "string" } }, required: ["path"] } }], false)` 返回
 * `[{ name: "read", description: "Read file", input_schema: { type: "object", properties: {...}, required: ["path"] } }]`。
 */
function convertTools(tools: Tool[], isOAuth: boolean): any[] {
	return tools.map((tool) => ({
		name: isOAuth ? toClaudeCodeName(tool.name) : tool.name,
		description: tool.description,
		input_schema: {
			type: "object",
			// Pi 的工具参数是 JSON Schema；这里只取最外层 properties/required，丢弃其他关键字。
			properties: (tool.parameters as any).properties || {},
			required: (tool.parameters as any).required || [],
		},
	}));
}

/**
 * 把 Anthropic 的停止原因映射为 Pi 的 `StopReason` 联合类型。
 *
 * 输入：服务端返回的字符串。输出：`"stop" | "length" | "toolUse" | "error"` 之一。
 * 副作用：无。错误路径：未知原因统一归为 `"error"`，调用方会把它当作失败处理。
 *
 * 示例：`mapStopReason("tool_use")` 返回 `"toolUse"`；`mapStopReason("end_turn")` 返回 `"stop"`。
 * 该函数依赖 `switch` 覆盖有限值；新增的 Anthropic 停止原因会自动落入 default。
 */
function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

/**
 * 自定义供应商的流式实现：把 Pi 的上下文翻译成 Anthropic 请求，并把响应事件转成 Pi 事件流。
 *
 * 输入：
 * - `model`：Pi 的模型对象，提供 `id`、`baseUrl`、`api`、`provider`、`maxTokens`、`reasoning`、`cost`。
 * - `context`：带 brand 的 `TranscriptContext`，其中 `messages` 包含当前系统提示与工具定义。
 * - `options`：可选，本示例只使用 `apiKey`、`signal`、`maxTokens`、`reasoning`、`thinkingBudgets`。
 * 输出：立即返回一个 `AssistantMessageEventStream`；真正的网络循环在返回后异步运行。
 * 副作用：向 `model.baseUrl` 发起一次 Anthropic Messages 流式请求；不写文件。
 * 错误路径：请求失败、HTTP 错误、流在无 stop reason 时结束、或 signal 已中止，都会在流上推送
 * `error` 事件；`result()` 得到的是带错误信息的 assistant 消息，而不是 rejected Promise。
 * 主要流程：折叠系统消息 -> 取系统提示和工具 -> 构造 Anthropic client -> 发流式请求 ->
 * 按事件累积文本/思考/工具调用 -> 收到 done 后推送完成事件。
 *
 * 示例（真实签名）：
 *   const stream = streamCustomAnthropic(model, context, { apiKey: "sk-ant-api...", maxTokens: 256 });
 *   for await (const event of stream) {
 *     if (event.type === "done") console.log(event.message.usage);
 *   }
 * 该调用会产生真实网络请求和费用；`apiKey` 缺失时这里用空串，SDK 不会在构造时为空的
 * `apiKey` 报错，而是发出请求，随后通常由服务端返回 401 并在流迭代中进入 catch。
 *
 * 注意：示例没有实现 `SimpleStreamOptions` 文档中的 `onPayload`/`onResponse` 回调，
 * 也没有转发 `toolChoice`、自定义 `fetch`、`env` 等选项。
 */
function streamCustomAnthropic(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	// 先创建空事件流并立刻返回；下面的异步函数向它 push 事件。
	const stream = createAssistantMessageEventStream();
	// The transcript carries the prompt and tools in its system messages. This provider sends
	// one top-level system prompt, so fold later system messages into the leading one first.
	// Pi 的 transcript 把系统提示和工具定义放在 system 消息里；Anthropic 只接受顶层 system 参数，
	// 所以先合并 system 消息，并从中取出当前系统提示与工具列表。
	const transcript = collapseSystemMessages(context);
	const systemPrompt = getCurrentSystemPrompt(transcript.messages);
	const tools = getCurrentTools(transcript.messages);

	// 立即执行异步 IIFE；它的 Promise 没有被 await，错误只能通过流事件传出。
	(async () => {
		// 累积中的 assistant 消息，也是每个 partial 事件携带的对象；流事件读取的是同一引用。
		const output: AssistantMessage = {
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
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			// 宿主在调用前注入解析后的 key；缺失时用空串继续，请求通常以 401 失败。
			const apiKey = options?.apiKey ?? "";
			const isOAuth = isOAuthToken(apiKey);

			// Configure client based on auth type
			// 两个 beta 功能头：细粒度工具流式输入与交错的思考过程。
			const betaFeatures = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];
			// `any` 是为了同时容纳 apiKey 和 authToken 两种互斥配置；对象本身没有运行时校验。
			const clientOptions: any = {
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
			};

			if (isOAuth) {
				// OAuth 令牌走 Authorization: Bearer，而不是 x-api-key；所以 apiKey 显式置空。
				clientOptions.apiKey = null;
				clientOptions.authToken = apiKey;
				clientOptions.defaultHeaders = {
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					// 模板字符串拼接四个 beta 令牌：claude-code、oauth 和上面两个功能。
					"anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
					"user-agent": "claude-cli/2.1.2 (external, cli)",
					"x-app": "cli",
				};
			} else {
				clientOptions.apiKey = apiKey;
				clientOptions.defaultHeaders = {
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": betaFeatures.join(","),
				};
			}

			const client = new Anthropic(clientOptions);

			// Build request params
			// 构造请求体；`stream: true` 让 SDK 返回可迭代的事件流而不是一次性 JSON。
			const params: MessageCreateParamsStreaming = {
				model: model.id,
				messages: convertMessages(transcript.messages, isOAuth, tools),
				// 未显式指定时用模型最大输出 token 的三分之一，而不是直接用满。
				max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
				stream: true,
			};

			// System prompt with Claude Code identity for OAuth
			// OAuth 模式下先放一段固定的 Claude Code 身份提示，再把真实系统提示作为第二块。
			if (isOAuth) {
				params.system = [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
						cache_control: { type: "ephemeral" },
					},
				];
				if (systemPrompt) {
					params.system.push({
						type: "text",
						text: sanitizeSurrogates(systemPrompt),
						cache_control: { type: "ephemeral" },
					});
				}
			} else if (systemPrompt) {
				params.system = [
					{
						type: "text",
						text: sanitizeSurrogates(systemPrompt),
						cache_control: { type: "ephemeral" },
					},
				];
			}

			if (tools.length > 0) {
				params.tools = convertTools(tools, isOAuth);
			}

			// Handle thinking/reasoning
			// 只有模型确实支持推理且调用方要求时才开启 thinking，避免给普通模型发不支持的参数。
			if (options?.reasoning && model.reasoning) {
				// 按推理强度给出默认思考预算；`Record<string, number>` 表示任意字符串键到数字的映射。
				const defaultBudgets: Record<string, number> = {
					minimal: 1024,
					low: 4096,
					medium: 10240,
					high: 20480,
				};
				// `keyof typeof options.thinkingBudgets` 把键限制在 budget 类型定义的字段上；
				// 这里做了一次类型断言，因为 `reasoning` 的联合类型与 budget 字段并非完全一致。
				const customBudget = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
				params.thinking = {
					type: "enabled",
					// `??` 只处理 null/undefined：先取调用方预算，再取默认预算，最后兜底 10240。
					budget_tokens: customBudget ?? defaultBudgets[options.reasoning] ?? 10240,
				};
			}

			// `{ ...params }` 浅拷贝一份传给 SDK；原 params 之后不再使用，拷贝用于隔离两个引用。
			const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });
			// 先向 Pi 事件流推送 start，携带初始 partial 消息，此时 content 仍为空。
			stream.push({ type: "start", partial: output });

			// Stream state per Anthropic block index, kept off the content blocks so it never reaches partial messages.
			// ToolCallArgumentsStream reads each argument delta once and shows the arguments parsed so far.
			// Anthropic 的事件用块索引（event.index）标识内容块，而 Pi 用自己的 contentIndex；
			// 这张 Map 负责两者映射，并给工具调用保存参数拼接器，避免把内部状态塞进 partial 消息。
			const openBlocks = new Map<number, { contentIndex: number; arguments?: ToolCallArgumentsStream }>();

			// `for await...of` 按到达顺序消费 SSE 事件；循环结束表示服务端关闭了流。
			for await (const event of anthropicStream) {
				// 流刚开始：记录输入/输出/缓存 token 用量，并按模型价格计算费用。
				if (event.type === "message_start") {
					// 每个字段都用 `|| 0` 兜底；服务端未提供的字段按 0 记。
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = (event.message.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.message.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					// 该函数会原地写入 `output.usage.cost`，返回值不需要使用。
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					// 每个 Anthropic 内容块开始时，在 Pi 的 content 数组中创建对应块并记录索引映射。
					if (event.content_block.type === "text") {
						output.content.push({ type: "text", text: "" });
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
						openBlocks.set(event.index, { contentIndex: output.content.length - 1 });
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							// OAuth 模式下把 Claude Code 工具名还原为 Pi 侧名称；普通模式下直接使用。
							name: isOAuth ? fromClaudeCodeName(event.content_block.name, tools) : event.content_block.name,
							arguments: {},
						});
						openBlocks.set(event.index, {
							contentIndex: output.content.length - 1,
							arguments: new ToolCallArgumentsStream(),
						});
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
					// 其他块类型（例如服务端新增的类型）被静默忽略，不会出现在 output 中。
				} else if (event.type === "content_block_delta") {
					// 按 Anthropic 块索引找到对应的 Pi 内容块；未知索引用 `continue` 跳过。
					const open = openBlocks.get(event.index);
					if (!open) continue;
					const index = open.contentIndex;
					// 非空断言 `!` 告诉编译器这里一定存在；它不做运行时检查。
					const block = output.content[index]!;

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
					} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: event.delta.thinking,
							partial: output,
						});
					} else if (event.delta.type === "input_json_delta" && block.type === "toolCall" && open.arguments) {
						// append 返回“目前已解析出的参数对象”，并缓存未完成的 JSON 片段；
						// 每收到一段增量就更新 block.arguments，让上层看到最新的部分参数。
						block.arguments = open.arguments.append(event.delta.partial_json);
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: event.delta.partial_json,
							partial: output,
						});
					} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
						// 签名可能分多段到达，因此累加而不是覆盖。
						block.thinkingSignature = (block.thinkingSignature || "") + (event.delta as any).signature;
					}
				} else if (event.type === "content_block_stop") {
					// 块结束：从映射中删除并发送对应的 end 事件。
					const open = openBlocks.get(event.index);
					if (!open) continue;
					openBlocks.delete(event.index);
					const index = open.contentIndex;
					const block = output.content[index]!;

					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall" && open.arguments) {
						// One full parse of the complete text; malformed arguments are reported in `argumentsError`.
						// finish 对整个 JSON 文本做一次解析，把 arguments 与 argumentsError 合并进 block；
						// 参数不合法不会在这里抛错，而是记录在 argumentsError 中供上层处理。
						Object.assign(block, open.arguments.finish());
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					// 消息级增量：更新停止原因和最终 token 用量。
					if ((event.delta as any).stop_reason) {
						output.stopReason = mapStopReason((event.delta as any).stop_reason);
					}
					// 注意这里用本次事件的 usage 覆盖已有值；Anthropic 的 message_delta 通常只带
					// output_tokens，因此 input/cache 字段缺失时会被写成 0，覆盖 message_start 的记录。
					output.usage.input = (event.usage as any).input_tokens || 0;
					output.usage.output = (event.usage as any).output_tokens || 0;
					output.usage.cacheRead = (event.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			// 流结束后做一致性检查；任何异常都会进入下面的 catch。
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			// 一次正常响应必须至少有一个 stop reason；仍为 pending 说明流异常结束。
			if (output.stopReason === "pending") {
				throw new Error("Anthropic stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// 正常结束：推送 done 事件，携带完整 assistant 消息，然后关闭流。
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// 统一把错误转成 error 事件；`instanceof Error` 是运行时检查，非 Error 值用 JSON 序列化兜底。
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

/**
 * 扩展默认导出：向宿主注册 `custom-anthropic` 供应商。
 *
 * 输入：`pi` 是扩展 API，由加载器在导入后传入。
 * 输出：无返回值；注册信息由宿主保存。
 * 副作用：修改宿主内存中的供应商注册表；不发起网络请求，不写文件。
 * 错误路径：该对象中的字段若不符合 `ProviderConfigInput`，由 TypeScript 在编译期发现；
 * 运行时宿主可能忽略未知字段。
 * 主要流程：声明 baseUrl 与 API key 环境变量 -> 声明 API 标识 -> 列出两个模型 ->
 * 提供 OAuth 登录/刷新/取 key 三个回调 -> 绑定自定义流函数。
 *
 * 示例：加载本扩展后，`/model` 中会出现 `custom-anthropic/claude-sonnet-4-5`；
 * 选择它并发送消息，就会调用 `streamCustomAnthropic`。
 * `apiKey: "$CUSTOM_ANTHROPIC_API_KEY"` 是字符串模板语法，不是当前进程里已解析的值：
 * 宿主在解析请求认证时按该名称读取环境变量；变量缺失时没有可用 key。
 */
export default function (pi: ExtensionAPI) {
	// 第一个参数是供应商 id，会与模型 id 拼成 `/model` 中的完整名称。
	pi.registerProvider("custom-anthropic", {
		// 模型级 `api` 未指定时继承这里的供应商级 API 标识；`streamSimple` 也会按它注册。
		baseUrl: "https://api.anthropic.com",
		apiKey: "$CUSTOM_ANTHROPIC_API_KEY",
		api: "custom-anthropic-api",

		// 每个模型都是普通对象；`reasoning: true` 表示支持 thinking，输入限制为文本和图片。
		models: [
			{
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5 (Custom)",
				reasoning: true,
				input: ["text", "image"],
				// 费用单位按 Pi 模型目录约定（通常为每百万 token 的美元数），由 calculateCost 使用。
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5 (Custom)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
		],

		// OAuth 配置：`/login custom-anthropic` 时宿主调用 login；访问令牌过期时调用 refreshToken；
		// 每次请求前用 getApiKey 从凭证中取 access token。`cred` 的类型由注册接口推断。
		oauth: {
			name: "Custom Anthropic (Claude Pro/Max)",
			login: loginAnthropic,
			refreshToken: refreshAnthropicToken,
			getApiKey: (cred) => cred.access,
		},

		// 把上面的 API 标识绑定到自定义流实现；Pi 请求模型时用这个函数。
		streamSimple: streamCustomAnthropic,
	});
}
