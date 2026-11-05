// Kimi Coding供应商装配：生成聊天目录、KIMI_API_KEY认证或Kimi订阅OAuth，以及Completions延迟流；不在构造时访问服务。
// 虽使用OpenAI兼容协议，模型供应商和端点仍是Kimi，不是把请求转给OpenAI。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 共用key解析与延迟OAuth外观，具体行为等方法调用才执行。
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
// OAuth实现加载器，导入名字不启动设备码登录。
import { loadKimiCodingOAuth } from "../auth/oauth/load.ts";
// 构造助手与只在编译期描述供应商的类型。
import { createProvider, type Provider } from "../models.ts";
// 静态生成聊天表只读，不手改包装或目录data。
import { KIMI_CODING_MODELS } from "./kimi-coding.models.ts";

// 用途：无参数创建Kimi Coding Provider，返回openai-completions聊天能力；装认证/目录/延迟流，不登录、校验key或请求模型。
// 例models.setProvider(kimiCodingProvider())后可读目录，Models解析认证时优先已存key或选用OAuth；流调用才加载真实适配器，构造本身不刷新远端。
export function kimiCodingProvider(): Provider<"openai-completions"> {
	// 每次创建新Provider及OAuth外观，模型对象仍来自生成表。
	return createProvider({
		// 与普通Moonshot供应商分开的凭证及模型归属键。
		id: "kimi-coding",
		// 界面展示名。
		name: "Kimi For Coding",
		// 端点元数据，不在此访问URL或改写各模型id。
		baseUrl: "https://api.kimi.com/coding/v1",
		// 两类认证由上层编排选择，本构造器不主动解析它们。
		auth: {
			// 普通方式：存储真值key优先，否则查KIMI_API_KEY；登录只询问待保存secret。
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			// 先暴露OAuth元数据，首次login/refresh/toAuth才加载实际flow。
			oauth: lazyOAuth({
				// 认证方式展示名。
				name: "Kimi Code (subscription)",
				// 声明订阅方式，不表示当场确认用户套餐有效。
				isSubscription: true,
				// 登录入口文字。
				loginLabel: "Sign in with Kimi Code",
				// 函数引用留给延迟外观使用，尚未执行加载。
				load: loadKimiCodingOAuth,
			}),
		},
		// Object.values创建数组容器，内部生成模型对象不深拷贝。
		models: Object.values(KIMI_CODING_MODELS),
		// Completions能力延迟加载实际请求模块，Provider直调不会自动走Models的凭证解析。
		api: openAICompletionsApi(),
	});
}
