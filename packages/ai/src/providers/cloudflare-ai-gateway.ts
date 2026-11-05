/**
 * 装配 Cloudflare AI Gateway：用网关认证与账户/网关路由，按模型 api 分发到三种既有聊天协议。
 * 例 Claude 目录项走 Anthropic 透传、OpenAI Responses 项走 OpenAI 透传，基础路由由生成目录指定。
 * 不在这里把三种协议互相转换，也不自动轮换失败端点；构造只登记能力，真正请求前 wrapper 替换 URL 占位符。
 */
// 各 lazy 工厂先建能力对象，等流方法调用时才加载实现模块。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
// createProvider 负责按 model.api 找能力；type Provider 导入编译时擦除。
import { createProvider, type Provider } from "../models.ts";
// 自动生成目录只作输入；端点/模型能力变更应修改 catalog 源并重新生成。
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
// Gateway 认证输出专用头及 account/gateway env，不把 Cloudflare key 作为上游服务 key。
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
// wrapper 只转发两个聊天流方法，并在调用时准备模型端点。
import { cloudflareStreams } from "./cloudflare-stream.ts";

// 显式列全支持的三种聊天 API，不能只由当前生成目录碰巧有哪些模型推断；此 type 不产生运行枚举。
type CloudflareAIGatewayApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * 新建内置 Gateway Provider，无参数，返回认证/静态聊天目录/按 API 分发的能力对象；本身不联网或弹登录框。
 * 例当前目录没有 Completions 项时，能力表仍保留 openai-completions，之后目录变化不会让 TS 装配类型漏掉该协议。
 * 没有 fetchModels，也没注册图片/分类能力；三个 wrapper 仅保留 stream/streamSimple，不在本层暴露 deferred 接口。
 */
export function cloudflareAIGatewayProvider(): Provider<CloudflareAIGatewayApi> {
	// The api map is pinned to all three APIs: models.dev's gateway catalog drops and
	// restores `workers-ai/*` (openai-completions) entries over time, and inference from
	// `models` alone would otherwise reject the openai-completions entry whenever the
	// generated catalog happens to contain none.
	// 用显式泛型保持能力表三项都合法，不依赖生成模型集合的暂时形状。
	return createProvider<CloudflareAIGatewayApi>({
		// 注册标识与展示名，不是在这里指定某一账户/网关实例。
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		// 声明 API key 类认证方法；实际 key/account/gateway 解析仍延后执行。
		auth: { apiKey: cloudflareAIGatewayAuth() },
		// 新建目录数组，模型对象及其 baseUrl 模板不深复制。
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		// CreateProvider 按 model.api 选择，不因某个请求失败自动改选另外一项。
		api: {
			// Anthropic 原生消息协议，先填模型端点的账户/网关占位符。
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			// OpenAI Completions 兼容协议，用模型目录给定的 compat 等端点。
			"openai-completions": cloudflareStreams(openAICompletionsApi()),
			// OpenAI Responses 协议，透传路由与实际路径由目录及具体适配器组合。
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
