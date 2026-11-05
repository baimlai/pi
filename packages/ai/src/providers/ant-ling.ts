// Ant Ling聊天供应商装配，供builtinProviders登记内置能力；组合目录、认证和OpenAI Chat Completions兼容延迟适配器，不在此发HTTP。
// 导入OpenAI Chat Completions兼容轻量工厂，实际流方法调用才加载重实现/SDK，不因导入这里就请求模型。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 导入通用API key认证器，构造阶段只保存名称和候选变量，login/resolve实际调用时才执行交互或取值。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行函数，type Provider是编译期契约；类型导入不会创建运行时类或自动验证配置。
import { createProvider, type Provider } from "../models.ts";
// 读取生成的Ant Ling聊天目录，来源为catalog生成流程；本文件不改生成模型表或数据。
import { ANT_LING_MODELS } from "./ant-ling.models.ts";

// 无参数创建Ant LingProvider，返回Provider<"openai-completions">；泛型限定聊天API，不是检查端点可访问或key有效。
// 流程身份/URL→key策略→静态目录→延迟流；例p=antLingProvider()后p.id为ant-ling，p.getModels()可列本地聊天项。
// 每次创建外层Provider与新数组，模型对象仍共享；不自动加入Models集合、不读环境或登录/联网/刷新目录，装配同步错误直接传播。
export function antLingProvider(): Provider<"openai-completions"> {
	// return把配置对象交统一工厂，得到目录读取和流派发方法，不在这条语句调用模型。
	return createProvider({
		// 供应商ID区分模型和凭证归属，不能当作模型自身ID。
		id: "ant-ling",
		// 展示名称只作元数据，不凭它推断账号套餐或协议兼容程度。
		name: "Ant Ling",
		// Provider级基础URL按原文保存；统一工厂不拿它改写模型自己的baseUrl，实际请求仍消费模型与认证覆盖。
		baseUrl: "https://api.ant-ling.com/v1",
		// 只登记ANT_LING_API_KEY候选；真正resolve时非空存储key优先，否则问宿主ctx.env，此处不读秘密。
		auth: { apiKey: envApiKeyAuth("Ant Ling API key", ["ANT_LING_API_KEY"]) },
		// Object.values(ANT_LING_MODELS)取可枚举自有值形成新聊天数组，条目引用不深克隆，也不接入图片/分类表。
		models: Object.values(ANT_LING_MODELS),
		// 创建延迟聊天能力，不调用stream或streamSimple，也没有动态fetchModels。Ling/Ring的思考格式和档位映射来自模型目录，不是在此根据名字推导或启动推理。
		api: openAICompletionsApi(),
	});
}
