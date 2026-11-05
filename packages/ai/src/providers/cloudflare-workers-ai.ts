/**
 * 装配 Cloudflare Workers AI：聊天走 OpenAI Completions 兼容协议，分类走 Workers AI /ai/run 的 System One 协议。
 * 例同一家供应商下，Kimi 聊天项与 Jev/Clef 分类项分别进入各自能力表，不把分类模型当可聊天模型使用。
 * 工厂只登记认证、随包目录及延迟能力，不在构造时登录、发请求或刷新目录；请求时 wrapper 先填 account 占位符。
 */
// lazy 工厂构造能力外观，实际 classify/stream 时才加载具体适配器。
import { cloudflareWorkersAISystemOneApi } from "../api/cloudflare-workers-ai-system-one.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// createProvider 组织目录/认证/请求分发，Provider 泛型只限定聊天 API 联合。
import { createProvider, type Provider } from "../models.ts";
// 此认证器要求 key/account；具体解析在请求或显式 getAuth 时发生。
import { cloudflareWorkersAIAuth } from "./cloudflare-auth.ts";
// 两个 wrapper 都只处理本次模型 baseUrl，占位值来自已解析 options.env。
import { cloudflareClassifier, cloudflareStreams } from "./cloudflare-stream.ts";
// *.models.ts 由 catalog/generate.ts 生成，引用其数据不在这里手工改目录。
import {
	// 分类目录和聊天目录是分开的表，后面合进同一提供商全目录。
	CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
	CLOUDFLARE_WORKERS_AI_MODELS,
} from "./cloudflare-workers-ai.models.ts";

/**
 * 返回具备聊天/分类能力的内置 Provider，无输入；例注册后可按种类查聊天或分类模型，再分别 streamSimple/classify。
 * 构造新能力外观与模型数组，模型对象仍共享；未传 fetchModels，所以原始提供商没有自己的动态目录抓取方法。
 * 只装配本函数列出的两种操作，生成目录即使另有 image 表也不在这里注册图片生成实现。
 */
export function cloudflareWorkersAIProvider(): Provider<"openai-completions"> {
	// 聊天泛型不限制独立 classifiers 字段，它有自己的分类 API 契约。
	return createProvider<"openai-completions">({
		// 提供商注册键与展示名，不是具体账户/网关标识。
		id: "cloudflare-workers-ai",
		name: "Cloudflare Workers AI",
		// 只提供 API key 类认证，无 OAuth 能力；工厂此刻不读取 key。
		auth: { apiKey: cloudflareWorkersAIAuth() },
		// Object.values 取表里的模型，... 展开到新数组，未深复制模型/价格配置。
		models: [
			...Object.values(CLOUDFLARE_WORKERS_AI_MODELS),
			...Object.values(CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS),
		],
		// 单一聊天实现先填 account，再交延迟 OpenAI 兼容协议；没有提供商级固定 baseUrl，采用模型目录端点。
		api: cloudflareStreams(openAICompletionsApi()),
		// 分类不是聊天 function call；这是直接返回 ClassifierResult Promise 的独立操作。
		classifiers: {
			// 同样先替模型账户端点，再由延迟 System One 分类器发 /run 请求。
			"cloudflare-workers-ai-system-one": cloudflareClassifier(cloudflareWorkersAISystemOneApi()),
		},
	});
}
