// Meta供应商装配：通过OpenAI兼容Responses协议访问Meta模型，支持META_API_KEY或Muse订阅OAuth；目录来自生成数据。
// 协议工厂不等于OpenAI供应商，实际端点由Meta模型/请求配置决定。
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
// 普通key策略和延迟OAuth外观共用通用助手。
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
// 延迟加载的Meta认证flow入口，导入不启动登录。
import { loadMetaOAuth } from "../auth/oauth/load.ts";
// 构造供应商与其返回类型。
import { createProvider, type Provider } from "../models.ts";
// 只读生成聊天目录，不在本文件修改生成包装或data。
import { META_MODELS } from "./meta.models.ts";

// 用途：无参数创建Meta Provider，返回openai-responses聊天供应商；流程装两类认证、静态目录及延迟流，没有现场登录/远端刷新。
// 例models.setProvider(metaProvider())后Models可解析META_API_KEY或已存OAuth材料，再将请求交Responses适配器；直接Provider流不自动执行Models的凭证解析。
export function metaProvider(): Provider<"openai-responses"> {
	// 创建新供应商对象，不执行下面的认证回调。
	return createProvider({
		// 模型归属及凭证键。
		id: "meta",
		// 显示名称。
		name: "Meta",
		// Meta端点元数据，不在这里验证可访问性。
		baseUrl: "https://api.meta.ai/v1",
		// 上层按凭证/用户选择编排认证，构造并不核验账号。
		auth: {
			// 存储真值key优先，缺失则查META_API_KEY；login只询问待保存secret。
			apiKey: envApiKeyAuth("Meta Model API key", ["META_API_KEY"]),
			// 只先创建OAuth展示与代理方法，具体实现等调用时加载。
			oauth: lazyOAuth({
				// 原认证方式名称。
				name: "Meta (Muse subscription)",
				// 标记订阅方式，不证明套餐或模型权限已经有效。
				isSubscription: true,
				// 登录选择项文字。
				loginLabel: "Sign in with Meta",
				// 保存加载器，未执行设备流程或key铸造。
				load: loadMetaOAuth,
			}),
		},
		// 新建数组容器，生成的各模型对象不深克隆。
		models: Object.values(META_MODELS),
		// Responses协议到流调用时才加载SDK/实现，不因工厂调用就发请求。
		api: openAIResponsesApi(),
	});
}
