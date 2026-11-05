// Fireworks供应商装配两种聊天协议：Anthropic Messages与OpenAI Completions，按每个模型api分发；不根据所有模型共用的provider ID强选一种。
// Anthropic延迟工厂先提供能力对象，实际stream调用才导入协议实现。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
// Completions采用独立lazy实现，和Anthropic不是同一套请求/消息转换代码。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// API key认证助手只在后续resolve时查非空存储key或环境来源，构造不执行登录。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行装配器，Provider类型参数在编译期关联聊天协议联合，不形成运行时枚举。
import { createProvider, type Provider } from "../models.ts";
// Fireworks生成聊天目录只读；每个模型的api/baseUrl/compat决定后续协议与请求细节，不在本文件现场探测。
import { FIREWORKS_MODELS } from "./fireworks.models.ts";

// 无参创建双协议Fireworks Provider，返回两API联合的聊天能力；例模型api为anthropic-messages时选下面该键，而不是因为名字含某模型品牌就选协议。
// 保存元数据→构造key认证/目录数组→分别装两种lazy流→交统一工厂；新外层Provider/数组仍共享模型对象。构造无网络/认证/写盘，异常向外同步传播；实际调用不支持的api时统一分发器给错误流，不自动回退另一协议。
export function fireworksProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	// 统一工厂接稀疏API实现表，构造能力与目录方法，不立即消费任一流。
	return createProvider({
		// Fireworks供应商ID，区别于其模型可能是其它品牌这一目录事实。
		id: "fireworks",
		// 展示名只作界面元数据。
		name: "Fireworks",
		// Provider基础地址以/inference结尾；这里不自动拼/v1或重写模型baseUrl，具体模型端点仍保存在目录数据。
		baseUrl: "https://api.fireworks.ai/inference",
		// 只提供API key认证能力，环境候选为FIREWORKS_API_KEY；不在工厂读取凭据或执行OAuth。
		auth: { apiKey: envApiKeyAuth("Fireworks API key", ["FIREWORKS_API_KEY"]) },
		// 将聊天表值转新数组，原条目共享；未加入图片/分类生成目录。
		models: Object.values(FIREWORKS_MODELS),
		// 这里是协议名→实现对象映射，而非单个统一实现，实际分派看model.api。
		api: {
			// 为Anthropic聊天协议创建lazy流实现，不在此请求Anthropic或Fireworks服务。
			"anthropic-messages": anthropicMessagesApi(),
			// 为Completions协议独立创建lazy实现；两个工厂调用都不意味着两边同时发送请求。
			"openai-completions": openAICompletionsApi(),
		},
	});
}
