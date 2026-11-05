/**
 * OpenRouter 提供商装配：声明认证、随包三类模型，以及聊天/图片生成/分类所用的协议实现。
 * 例 anthropic-messages 聊天项交延迟 Anthropic 适配器，图片项交 OpenRouter 图片适配器，不把“聊天可看图”和“生成图片”混为一项能力。
 * 另导出账户目录个性化函数；工厂本身只用静态目录，不会自动调用它。coding-agent 的目录包装器会在刷新阶段显式调用。
 * *.models.ts 是生成目录输入到这里的结果，本文件不改生成数据；构造 Provider 不发请求、不登录。
 */
// 各 lazy 工厂仅建立能力对象，真正调用能力时才加载较重的实现模块。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
// API key 认证器按存储/环境解析；OAuth 外观按需加载流程，构造时不启动浏览器登录。
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenRouterOAuth } from "../auth/oauth/load.ts";
// createProvider 负责按 model.api 分发，RefreshModelsContext 是个性化函数接收的刷新阶段上下文。
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
// AnyModel 覆盖 chat/image/classifier，类型导入不对远端目录做运行检查。
import type { AnyModel } from "../types.ts";
// 正常目录省略 type 的旧项按 chat；类型谓词也让 TS 收窄聊天专有字段。
import { isModelType } from "../utils/model-operations.ts";
// 只读取生成的三类模型表；修改目录应走 catalog 输入及生成流程。
import { OPENROUTER_CLASSIFIER_MODELS, OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS } from "./openrouter.models.ts";
// HTTP 返回模型的候选类型，以及美元/token→美元/百万 token 的价格转换。
import { type OpenRouterModel, openRouterCost } from "./openrouter-api.ts";

// 默认请求基础地址；个性化函数允许 context.baseUrl 指定区域/代理地址。
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// 单次账户模型列表请求额外 15 秒信号，不是模型生成的超时。
const OPENROUTER_USER_MODELS_TIMEOUT_MS = 15_000;

/**
 * Restrict an OpenRouter catalog to the chat models the key may use, with the key's limits and
 * prices from `GET /models/user`. Image and classifier models are returned unchanged. A missing
 * limit keeps the catalog value. The request uses the provider's configured base URL, so regional
 * endpoints such as `https://us.openrouter.ai/api/v1` apply their region's filtering. When the
 * endpoint rejects the key (401/403) or does not exist (404), for example with a proxy configured
 * in models.json, the catalog is returned unchanged.
 */
/**
 * 用凭证请求 /models/user，再按该列表筛聊天目录并替换其限额/价格；图片与分类项原引用保留。
 * 输入候选全目录及刷新上下文，返回新数组或原目录；例账户只列 chat/a 时去掉 chat/b，image/b 仍保留。
 * 没非空 key 或 HTTP 401/403/404 直接返回原目录；其他 HTTP/JSON 错误向调用方拒绝，不自行 publish 或写目录缓存。
 * 本函数不检查 allowNetwork/force，也不做独立重试；外层刷新包装器负责决定何时调用，取消信号与 15 秒信号合并传 fetch。
 * 响应只确认 data 数组和各 entry.id 字符串，其余字段靠类型断言读取，不能据此保证限额/价格结构已完整验证。
 */
export async function personalizeOpenRouterCatalog(
	// readonly 只禁止通过此数组类型改容器，不深冻结每个模型。
	catalog: readonly AnyModel[],
	// credential 可省略，baseUrl 可覆盖默认；publish 在此函数内不调用。
	context: RefreshModelsContext,
): Promise<readonly AnyModel[]> {
	// OAuth 用 access，API key 凭证用 key；不会在这里刷新 OAuth 或退回环境变量。
	const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
	// 空 key 和缺凭证都不发 HTTP，原数组身份也保留。
	if (!key) return catalog;
	// 去末尾斜线再拼账户端点，不硬编码请求一定去默认域名；这里直接用全局 fetch。
	const response = await fetch(`${(context.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/models/user`, {
		// 只发这两个显式头，不在此合并 Provider/Models 的模型请求身份或其他 headers。
		headers: { accept: "application/json", authorization: `Bearer ${key}` },
		// 任一信号取消都能取消标准 fetch；不额外在返回后 throwIfAborted 或强制中断任意自定义 fetch。
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(OPENROUTER_USER_MODELS_TIMEOUT_MS)]),
	});
	// 认证拒绝/端点缺失保留原目录，便于不支持此接口的代理仍展示候选；不等于 key 已有效。
	if (response.status === 401 || response.status === 403 || response.status === 404) return catalog;
	// 其余失败直接抛状态码错误，没有在这里消费失败响应正文。
	if (!response.ok) throw new Error(`OpenRouter model list request failed: ${response.status}`);
	// JSON.parse 的结果保持 unknown，先检查访问 data 所需外形。
	const body: unknown = await response.json();
	// in 允许继承 data；只确认最外层对象及 data 真数组，不是完整 OpenRouter schema 校验。
	if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
		throw new Error("Invalid OpenRouter model list response");
	}
	// 以模型 ID 建查找表，同 ID 后出现的条目覆盖前条。
	const allowed = new Map<string, OpenRouterModel>();
	// 把数组元素看成 unknown，不能因 Array.isArray 就认定每项都有合法模型结构。
	for (const entry of body.data as unknown[]) {
		// 只认可非 null 对象且能读到字符串 id；数组/继承 id 也未被此式另外排除。
		if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string") {
			// as 不验证 top_provider/pricing 等深层字段，保存原 entry 引用。
			allowed.set(entry.id, entry as OpenRouterModel);
		}
	}
	// flatMap 让单个候选返回 [] 删除、[model] 保留；不会增加只在远端出现而不在 catalog 的模型。
	return catalog.flatMap((model): AnyModel[] => {
		// 非 chat 项完全不被账户列表筛选，也不改其价格/限额。
		if (!isModelType(model, "chat")) return [model];
		// 聊天项必须在允许表里有相同 ID。
		const entry = allowed.get(model.id);
		// 未列出的候选聊天模型从返回目录删除。
		if (!entry) return [];
		return [
			{
				// 新建聊天模型外壳，其他嵌套配置仍与候选共享。
				...model,
				// `||`: OpenRouter reports a missing limit as absent, null or 0, like the generator's fallback.
				// 首选 top_provider.context_length，再根 context_length，最后候选旧值；|| 同样会保留负数等真值，不验证合法范围。
				contextWindow: entry.top_provider?.context_length || entry.context_length || model.contextWindow,
				// 生成长度只有 top_provider 来源，没有读取根级 max_completion_tokens 的回退。
				maxTokens: entry.top_provider?.max_completion_tokens || model.maxTokens,
				// pricing 有真值就整份转换，缺少其中某项可变 0，不逐项保留 model.cost；无 pricing 才沿原 cost。
				cost: entry.pricing ? openRouterCost(entry.pricing) : model.cost,
			},
		];
	});
}

/**
 * 创建内置 OpenRouter Provider：登记 API key/OAuth、生成目录和四种协议能力，返回可被 Models 注册的对象。
 * 例同一提供商的 Claude 聊天走 anthropic-messages，普通聊天走 openai-completions；图片/分类各走独立能力表。
 * 构造时不调用 personalizeOpenRouterCatalog，也未传 fetchModels，所以这个原始 Provider 没有自身动态刷新；coding-agent 可另套个性化包装。
 */
export function openrouterProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	// 泛型只列聊天 API，图片和分类的能力由 CreateProviderOptions 的独立字段声明。
	return createProvider<"anthropic-messages" | "openai-completions">({
		// 注册标识/展示名和默认端点。
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: OPENROUTER_BASE_URL,
		auth: {
			// 认证解析时非空存储 key 优先，否则查宿主环境 OPENROUTER_API_KEY；构造不读 key。
			apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]),
			// OAuth 只登记元数据/加载器，调用 login/refresh/toAuth 后才实际加载。
			oauth: lazyOAuth({
				name: "OpenRouter OAuth",
				loginLabel: "Sign in with OpenRouter",
				load: loadOpenRouterOAuth,
			}),
		},
		// 三种生成表先各取 values，再展开成新数组；模型对象本身不深复制。
		models: [
			...Object.values(OPENROUTER_MODELS),
			...Object.values(OPENROUTER_IMAGE_MODELS),
			...Object.values(OPENROUTER_CLASSIFIER_MODELS),
		],
		// 聊天模型按其 model.api 找对应延迟实现，不按模型名字临时猜协议。
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
		// 图片生成是独立的一次性 Promise 接口，不是聊天中的图片输入。
		images: { "openrouter-images": openrouterImagesApi() },
		// OpenRouter serves TypeSafe's System One protocol at /api/v1/systemone.
		// 分类模型调用 TypeSafe System One 协议；具体路径/图片兼容由该适配器与模型 compat 决定。
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
