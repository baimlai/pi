// xAI供应商装配：生成聊天目录、XAI_API_KEY或Grok/X订阅OAuth，以及OpenAI兼容Responses延迟传输；请求供应商仍为xAI。
// 使用兼容协议工厂，不在构造时访问OpenAI或xAI服务。
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
// 普通key策略与延迟OAuth外观。
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
// 具体xAI认证实现加载器，只有实际认证方法调用才经外观加载。
import { loadXaiOAuth } from "../auth/oauth/load.ts";
// 供应商运行时构造助手与编译期返回类型。
import { createProvider, type Provider } from "../models.ts";
// 只读生成聊天目录，不直接修改生成包装或data。
import { XAI_MODELS } from "./xai.models.ts";

// 用途：无参数创建xAI Provider，返回openai-responses聊天供应商；装目录/认证/流，不登录、不验证key、不主动刷新远端。
// 例models.setProvider(xaiProvider())后Models解析XAI_API_KEY或存储OAuth，再交Responses适配器请求xAI模型；工厂返回对象并不表示账号已经认证。
export function xaiProvider(): Provider<"openai-responses"> {
	// 创建新的Provider和认证外观，目录模型对象沿用生成引用。
	return createProvider({
		// 模型和凭证归属键。
		id: "xai",
		// 品牌展示名。
		name: "xAI",
		// xAI端点元数据，不在此检查服务可用性。
		baseUrl: "https://api.x.ai/v1",
		// 两类认证方法供上层编排。
		auth: {
			// 存储真值key优先，否则查询XAI_API_KEY；普通login询问secret，不现场测试key。
			apiKey: envApiKeyAuth("xAI API key", ["XAI_API_KEY"]),
			// OAuth元数据立即可读，登录/刷新/转换首次调用才加载实现。
			oauth: lazyOAuth({
				// 登录方式名称。
				name: "xAI (Grok/X subscription)",
				// 声明订阅方式，不代表此时核验用户套餐或模型权益。
				isSubscription: true,
				// 宿主可用来展示登录入口文字。
				loginLabel: "Sign in with SuperGrok or X Premium",
				// 保存函数引用，不在此执行设备码交互。
				load: loadXaiOAuth,
			}),
		},
		// 新目录数组来自生成表，各模型对象保持共享引用。
		models: Object.values(XAI_MODELS),
		// 构造延迟Responses能力，实际流调用才加载请求实现；Provider直调不自动解析Models凭证存储。
		api: openAIResponsesApi(),
	});
}
