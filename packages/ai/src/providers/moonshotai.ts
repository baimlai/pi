// Moonshot国际聊天入口：装配静态目录、API key认证和OpenAI Chat Completions延迟实现，不在此转换消息或实现HTTP。
// 导入轻量协议工厂；真实实现/SDK到流方法调用时才加载，导入本文件不请求模型。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 导入认证器构造函数，先保存变量名单，实际login/resolve才询问或读取key来源。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行值，type Provider只参与编译期接口检查，运行时没有这个类型对象。
import { createProvider, type Provider } from "../models.ts";
// 读取生成的Moonshot国际聊天模型表；生成入口在catalog/generate.ts，不能在此手改生成模型数据。
import { MOONSHOTAI_MODELS } from "./moonshotai.models.ts";

// 无参数创建Moonshot国际Provider，返回Provider<"openai-completions">；泛型限制聊天协议类型，不验证远端服务或key。
// 流程依次装配身份/认证/目录/lazy能力；例p=moonshotaiProvider()后p.id为moonshotai，p.getModels()只读本地目录。
// 每次新建外层对象和目录数组、共享模型条目；构造不登录、不读环境、不注册到Models集合或联网，装配同步错误直接传播。
export function moonshotaiProvider(): Provider<"openai-completions"> {
	// return把配置交给统一工厂，获得目录读取和流派发等方法；对象字面量本身不是一次模型请求。
	return createProvider({
		// 集合按此供应商ID区分条目和凭证，不把它当模型ID或根据当前位置自动替换。
		id: "moonshotai",
		// 展示名称作为元数据保存，不参与主机解析或账号校验。
		name: "Moonshot AI",
		// 它是Provider级元数据；统一工厂不据此重写生成目录中每个模型自己的baseUrl。
		baseUrl: "https://api.moonshot.ai/v1",
		// 只登记MOONSHOT_API_KEY环境候选，实际解析先用非空存储key，再问宿主ctx.env；这里不读取秘密。中国区入口也用这个变量；这里的provider ID不同，存储凭证仍可分开配置。
		auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]) },
		// Object.values(MOONSHOTAI_MODELS)新建数组、共享模型对象；这里只取聊天表，不把图片/分类表也装入。
		models: Object.values(MOONSHOTAI_MODELS),
		// 创建OpenAI Chat Completions延迟能力对象，不调用stream；没有fetchModels抓取器，也不启用动态目录刷新。
		api: openAICompletionsApi(),
	});
}
