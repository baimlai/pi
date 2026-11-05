// 把本地Hugging Face聊天目录、token认证规则和延迟Completions适配器装成Provider，供builtinProviders或直接调用者注册。
// 导入的是延迟API工厂，调用它只造stream方法，实际聊天模块到流方法调用时才装载。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 通用key认证器保存HF_TOKEN这个变量名；构造不读取token，resolve时才先取存储key再问宿主环境。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是实际装配函数；type Provider只约束开发期接口，泛型下面限定聊天协议。
import { createProvider, type Provider } from "../models.ts";
// 读取生成的本地聊天模型表；该文件从JSON摊平目录，不在这里请求Hugging Face发现接口，也不手改生成物。
import { HUGGINGFACE_MODELS } from "./huggingface.models.ts";

// 无参数构造一个新的Provider并返回，静态目录/认证/流能力在此接起来，不登录、不刷新目录或发送聊天。
// 例：const p=huggingfaceProvider(); p.getModels()读本地模型；若调用流方法才进入延迟实现。createProvider装配错误会同步抛出。
export function huggingfaceProvider(): Provider<"openai-completions"> {
	// 把下面配置交真实工厂，返回它生成的对象；没有fetchModels配置，因此此实例不提供动态目录刷新方法。
	return createProvider({
		// 唯一供应商键为huggingface，集合用它查找，而非用展示名定位。
		id: "huggingface",
		// 用户可见名字保留大小写和空格，不是模型ID。
		name: "Hugging Face",
		// 设置Provider基础地址元数据；这里不验证连通性，也不会逐项改写下面目录模型原本的baseUrl。
		baseUrl: "https://router.huggingface.co/v1",
		// 认证对象提供apiKey分支，存储key优先、HF_TOKEN作环境回退；构造认证器不弹输入框或检验远端token有效性。
		auth: { apiKey: envApiKeyAuth("Hugging Face token", ["HF_TOKEN"]) },
		// Object.values新建包含所有自有可枚举模型值的数组，模型对象引用仍共享；只取聊天表，不混入图片生成/分类表。
		models: Object.values(HUGGINGFACE_MODELS),
		// 建立Completions流能力外观，交工厂用于stream/streamSimple分发，不在本行加载重SDK或调用服务。
		api: openAICompletionsApi(),
	});
}
