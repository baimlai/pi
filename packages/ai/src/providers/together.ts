// Together聊天供应商入口，装配本地聊天目录、Completions实现和key认证；不同模型的thinkingFormat等兼容差异留在生成模型数据里。
// Completions从lazy入口导入，工厂调用只建立加载闭包，不立即加载重SDK或发请求。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 认证助手创建可供宿主调用的login/resolve，存储非空key优先于环境变量。
import { envApiKeyAuth } from "../auth/helpers.ts";
// 运行函数createProvider组对象，Provider接口在执行JS中擦除，不创建另一层实例。
import { createProvider, type Provider } from "../models.ts";
// Together生成目录只读，使用其中的原模型对象；不是实时向服务端枚举用户可用模型。
import { TOGETHER_MODELS } from "./together.models.ts";

// 无参创建Together Provider，返回限定Completions协议的聊天能力；例p=togetherProvider()后p.id为together，p.getModels()读本地目录。
// 保存ID/名字/端点，构造key认证并取模型数组，再装配lazy流；每次返回新外层对象/数组，目录成员共享。无即时认证、网络或写盘，装配失败同步抛出；实际请求与交互在后续方法中执行。
export function togetherProvider(): Provider<"openai-completions"> {
	// 统一工厂提供目录/流方法，不在此把Provider注册到全局兼容注册表。
	return createProvider({
		// ID=together，与目录对象provider字段的约定相配，但本行不遍历修正目录字段。
		id: "together",
		// 展示名Together，不按模型名称自动选择别的供应商。
		name: "Together",
		// 保存Provider端点元数据；不在这里覆盖每个模型baseUrl或验证网络连通性。
		baseUrl: "https://api.together.ai/v1",
		// 环境候选TOGETHER_API_KEY，仅创建认证器；存储key存在且非空时可直接使用，login所得凭据由宿主另行保存。
		auth: { apiKey: envApiKeyAuth("Together API key", ["TOGETHER_API_KEY"]) },
		// 取静态聊天表值建新数组，保留原模型引用及其思考/价格等元数据，不深复制或在线筛选。
		models: Object.values(TOGETHER_MODELS),
		// 单个延迟Completions实现负责聊天，具体请求字段按选中模型compat处理，不在这里统一改写全部模型的thinkingFormat。
		api: openAICompletionsApi(),
	});
}
