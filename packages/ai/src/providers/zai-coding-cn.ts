// Z.AI中国Coding聊天装配入口，供builtinProviders列入内置供应商；组合本地目录/认证/lazy流实现，不在此发送HTTP。
// 导入OpenAI Chat Completions兼容协议的轻量工厂，不意味着请求一定发往OpenAI，也不在导入时加载重SDK。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 导入可复用key认证器构造函数；这次调用只保存展示名和环境变量候选，实际取值在resolve。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行时函数，type Provider只参与TS静态检查；混合导入不为Provider类型创建运行对象。
import { createProvider, type Provider } from "../models.ts";
// 读取生成的Z.AI中国Coding聊天模型表；生成入口catalog/generate.ts消费catalog配置，此手写文件不重建或编辑生成数据。
import { ZAI_CODING_CN_MODELS } from "./zai-coding-cn.models.ts";

// 无参数构造Z.AI中国CodingProvider，返回泛型指定openai-completions的接口对象；类型限制不是端点或key的运行时验证。
// 流程装配身份和URL→创建认证器→取聊天条目数组→创建延迟协议能力；例p=zaiCodingCnProvider()后p.id为zai-coding-cn，p.getModels()读取本地已知目录。
// 每次新建Provider外框和目录数组，条目引用仍共享；不自动注册到Models集合、登录或刷新网络目录，装配同步错误直接传播。
export function zaiCodingCnProvider(): Provider<"openai-completions"> {
	// return把对象字面量交统一工厂，获得目录读取和流派发方法，不在这一层开始推理。
	return createProvider({
		// 供应商ID用于集合和凭证归属，不是模型ID；例如同名模型也可按zai-coding-cn这个归属区分。
		id: "zai-coding-cn",
		// 展示名作为元数据保存，不凭它验证账号、模型能力或远端厂商身份。
		name: "Z.AI Coding CN",
		// 明确使用bigmodel.cn的coding路径，不由国际域名做字符串替换；Provider元数据不覆盖模型baseUrl。
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		// 只配置ZAI_CODING_CN_API_KEY候选；实际解析优先非空存储key，其次才通过宿主ctx.env读此变量，构造时不读秘密。不自动使用国际入口的ZAI_API_KEY；存储key是否有效仍留给后续认证/实际请求处理。
		auth: { apiKey: envApiKeyAuth("Z.AI Coding CN API key", ["ZAI_CODING_CN_API_KEY"]) },
		// Object.values(ZAI_CODING_CN_MODELS)只取可枚举自有值组成新数组，元素仍是原聊天模型对象，不加入图片或分类表。
		models: Object.values(ZAI_CODING_CN_MODELS),
		// 仅创建延迟流对象，stream/streamSimple之后被调用才加载实现；没有传fetchModels，所以不暴露动态刷新。
		api: openAICompletionsApi(),
	});
}
