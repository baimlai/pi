// OpenAI供应商装配：组合Responses聊天、Decisions分类、API key及ChatGPT订阅认证；目录来自生成文件，实际请求由延迟适配器处理。
// 分类能力工厂只创建延迟入口，调用classify时才加载真实实现。
import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
// 聊天能力使用Responses协议，不在构造供应商时请求模型。
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
// 普通key认证器与OAuth延迟外观，各自在真正登录/解析时执行工作。
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
// 认证实现加载器被作为回调保存，导入此名字不等于开始OAuth登录。
import { loadOpenAIChatGPTOAuth } from "../auth/oauth/load.ts";
// createProvider构造供应商，isModelType按模型种类判断；type Provider仅约束返回形状。
import { createProvider, isModelType, type Provider } from "../models.ts";
// 分类模型类型与聊天Model不同；type导入编译时擦除。
import type { ClassifierModel } from "../types.ts";
// 只读自动生成的两类模型目录，更新应走catalog生成器，不手改这些产物。
import { OPENAI_CLASSIFIER_MODELS, OPENAI_MODELS } from "./openai.models.ts";

// 用途：无参数创建新的OpenAI Provider，返回聊天API泛型为openai-responses的供应商对象，同时可包含独立分类能力。
// 流程：装认证方法、合并两类静态目录、设置OAuth可用性过滤、接聊天/分类延迟接口；构造不登录、不刷新远端或发请求。
// 例models.setProvider(openaiProvider())后可读聊天目录；使用OAuth枚举getAvailableOfType("classifier","openai")时分类项被排除，而静态分类目录仍存在。
export function openaiProvider(): Provider<"openai-responses"> {
	// 显式泛型约束聊天协议；createProvider还负责按模型api选择分类等独立映射。
	return createProvider<"openai-responses">({
		// 集合、凭证存储和模型provider字段使用的稳定键。
		id: "openai",
		// 界面展示名，与小写id区分。
		name: "OpenAI",
		// 供应商端点元数据，不在此发HTTP或自动改写每个模型。
		baseUrl: "https://api.openai.com/v1",
		// 同时提供两类认证方法，由Models/宿主选择和编排。
		auth: {
			// 优先存储真值key，否则查OPENAI_API_KEY；登录只询问secret，持久化由上层负责。
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
			// 构造延迟OAuth对象，只先暴露元数据；首次login/refresh/toAuth才触发加载。
			oauth: lazyOAuth({
				// 认证方式展示文字。
				name: "OpenAI (ChatGPT subscription)",
				// 声明它是订阅流程，不在构造时核验账号套餐。
				isSubscription: true,
				// 交互入口上的按钮文字。
				loginLabel: "Sign in with ChatGPT",
				// 传函数引用，尚未执行加载或开启浏览器。
				load: loadOpenAIChatGPTOAuth,
			}),
		},
		// 拼接新目录数组，模型对象本身仍来自生成目录，聊天与分类可有相同id。
		models: [
			// ...把聊天表的值展开为数组成员，不把整张表放进一项。
			...Object.values(OPENAI_MODELS),
			// Object.values泛型说明分类值的API，未增加运行时验证或类型转换。
			...Object.values<ClassifierModel<"openai-decisions">>(OPENAI_CLASSIFIER_MODELS),
		],
		// Sign in with ChatGPT tokens only reach the Responses API; the Decisions API rejects them.
		// 这是全种类可用列表过滤回调，不改静态目录，也不是每次真实请求都执行的权限校验。
		filterAllModels: (models, credential) =>
			// OAuth标签时过滤所有classifier种类，返回新数组；API key或缺凭证则直接返回输入数组。
			credential?.type === "oauth" ? models.filter((model) => !isModelType(model, "classifier")) : models,
		// 装聊天流能力，具体Responses模块在实际流调用时加载。
		api: openAIResponsesApi(),
		// 分类实现独立按API映射，不能把它当同名聊天模型的stream。
		classifiers: {
			// Decisions调用到此延迟能力后才加载分类实现。
			"openai-decisions": openAIDecisionsApi(),
		},
	});
}
