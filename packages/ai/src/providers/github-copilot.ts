// Copilot供应商：三种聊天协议及独立System One分类；OAuth账户元数据可筛聊天可用列表，分类在请求时补版本路径。
// 轻量聊天工厂延迟加载实际协议与SDK。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
// Completions聊天工厂。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// Responses聊天工厂。
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
// 分类工厂返回classify能力，与聊天流分开。
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
// 普通token解析与OAuth延迟外观，等实际操作时才执行。
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
// 仅保存OAuth加载器，不在构造时启动设备码登录。
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
// 构造助手为运行值，Provider为返回类型。
import { createProvider, type Provider } from "../models.ts";
// 分类接口返回Promise结果，不是聊天事件流。
import type { ProviderClassifier } from "../types.ts";
// 两类生成目录只读，不编辑其包装或data。
import { GITHUB_COPILOT_CLASSIFIER_MODELS, GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

// 字符串联合仅限定聊天协议，分类API在独立映射里描述。
type GitHubCopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * Copilot serves System One at `/v1/systemone`, while its chat APIs have no version prefix.
 * The login replaces the catalog base URL with the account's endpoint, so the prefix is added per request.
 */
// 用途：输入分类实现，返回补Copilot版本路径的包装器；构造不发请求。例如baseUrl=https://api.example在调用时变为https://api.example/v1，供内层再追加systemone路径。
// 只浅复制模型，去字符串末尾连续斜杠再字面追加/v1；不解析URL、去查询或识别已有/v1，不改原模型。请求及异步结果由内层承担。
function copilotSystemOne(classifier: ProviderClassifier): ProviderClassifier {
	// 仅构造classify入口，不复制额外成员。
	return {
		// 用途：输入模型/分类上下文/可选配置，返回内层Promise；例如OAuth把端点换成账户地址后，此时再补/v1。字符串操作若同步抛错仍直接传播，没有async自动转换。
		classify: (model, context, options) =>
			// 正则只删真正末尾的/；展开模型仅覆盖baseUrl，嵌套字段仍共享，上下文与配置透传。
			classifier.classify({ ...model, baseUrl: `${model.baseUrl.replace(/\/+$/u, "")}/v1` }, context, options),
	};
}

// 用途：无参数创建Copilot Provider，返回三聊天协议联合及独立分类能力的供应商；装认证/目录/过滤，不登录、不请求账户模型。
// 例OAuth凭证availableModelIds=["A"]时，聊天可用枚举只留A；不改静态目录、不校验真实请求权限，分类项也不被聊天ID集合误删。
export function githubCopilotProvider(): Provider<GitHubCopilotApi> {
	// 泛型限制聊天API范围，分类按另一映射处理。
	return createProvider<GitHubCopilotApi>({
		// 模型归属及凭证存储键。
		id: "github-copilot",
		// 展示名称。
		name: "GitHub Copilot",
		// 默认端点元数据，OAuth认证可带账户专属地址，不是所有账户固定此地址。
		baseUrl: "https://api.individual.githubcopilot.com",
		// 上层选择token或OAuth，由Models编排解析与持久化。
		auth: {
			// 存储真值key优先，否则读COPILOT_GITHUB_TOKEN；此工厂自身不换取访问token。
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			// 延迟OAuth实现；订阅标记不代表已核验账号权益。
			oauth: lazyOAuth({ name: "GitHub Copilot", isSubscription: true, load: loadGitHubCopilotOAuth }),
		},
		// 展开两类生成值到新数组，模型对象共享；同id可按chat/classifier区分。
		models: [...Object.values(GITHUB_COPILOT_MODELS), ...Object.values(GITHUB_COPILOT_CLASSIFIER_MODELS)],
		// 用途：输入聊天列表与可选凭证，返回原列表或筛选新数组；例有效OAuth空数组返回空聊天列表。无请求、不改凭证；上层全种类枚举只将此过滤应用于聊天。
		// 先看oauth标签，再检查Array.isArray及every结果；无效/缺失保留全部，检查通过则按ID集合筛选，保持原模型顺序。
		filterModels: (models, credential) => {
			// 普通key或缺凭证不采用OAuth账户目录过滤。
			if (credential?.type !== "oauth") return models;
			// 扩展字段类型为unknown，需要按实际存储元数据形状判断。
			const availableModelIds = credential.availableModelIds;
			// 数组及遍历到的成员字符串是边界检查；空数组every为true，无对应属性的空槽会被every跳过，不证明数组每个下标都有字符串。
			if (!Array.isArray(availableModelIds) || !availableModelIds.every((id) => typeof id === "string")) {
				// 无有效元数据保留原数组引用，不擅自认定账户没有模型。
				return models;
			}
			// Set去重账户ID，只匹配本地已有模型，不追加远端未知ID。
			const available = new Set(availableModelIds);
			// 精确字符串筛选，空集合会排除全部聊天，模型对象本身不复制。
			return models.filter((model) => available.has(model.id));
		},
		// 根据model.api选传输，而非模型显示名称。
		api: {
			// Anthropic协议。
			"anthropic-messages": anthropicMessagesApi(),
			// Chat Completions协议。
			"openai-completions": openAICompletionsApi(),
			// Responses协议。
			"openai-responses": openAIResponsesApi(),
		},
		// 分类先过版本路径包装，再按需加载真实System One实现，构造不调用classify。
		classifiers: { "typesafe-system-one": copilotSystemOne(typesafeSystemOneApi()) },
	});
}
