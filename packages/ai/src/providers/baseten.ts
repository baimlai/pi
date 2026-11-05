// Baseten聊天供应商装配入口，使用Completions协议、静态聊天目录与API key认证；不是在这里实现HTTP请求或推理参数转换。
// 导入轻量lazy工厂，实际流方法调用时才加载协议实现/SDK，不在模块导入时请求模型。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 通用key认证器保存展示名与变量名单，实际login/resolve才询问或读取认证来源。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是真正的对象装配函数，type Provider只在编译期检查返回接口。
import { createProvider, type Provider } from "../models.ts";
// 只读生成的Baseten聊天模型表，包含各模型自己的endpoint/compat等数据，不手工重建模型名单。
import { BASETEN_MODELS } from "./baseten.models.ts";

// 无参数创建Baseten Provider，返回聊天协议限定为openai-completions的对象；例p=basetenProvider()后p.id为baseten，p.getModels()可列本地条目。
// 流程保存元数据→创建key认证→取聊天目录数组→接lazy流；每次新建外层Provider和数组，模型对象仍共享。构造无登录、目录抓取或请求，装配错误同步传播，真实网络/宿主交互发生在之后的能力调用。
export function basetenProvider(): Provider<"openai-completions"> {
	// 交统一工厂生成目录/stream等方法，不自动注册到某个Models集合。
	return createProvider({
		// 供应商唯一ID，不是模型ID或必须等于URL主机的值。
		id: "baseten",
		// 展示名只作元数据，不据此探测账号或端点。
		name: "Baseten",
		// Provider级基础URL文字；统一工厂只保存它，不重写生成模型各自的baseUrl，后续请求仍看模型/认证覆盖。
		baseUrl: "https://inference.baseten.co/v1",
		// 只配置BASETEN_API_KEY环境候选；非空存储key优先，其次才查询此变量，工厂本身不读秘密或提供OAuth。
		auth: { apiKey: envApiKeyAuth("Baseten API key", ["BASETEN_API_KEY"]) },
		// Object.values建新聊天模型数组，元素保留生成表原引用；不把图片/分类生成表加入此Provider。
		models: Object.values(BASETEN_MODELS),
		// 创建延迟Completions实现而非调用stream；具体Baseten兼容字段由模型元数据和实际适配器消费。
		api: openAICompletionsApi(),
	});
}
