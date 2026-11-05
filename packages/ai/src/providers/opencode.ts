// 装配OpenCode Zen Provider：静态聊天/分类目录、API key认证和四种延迟聊天协议；工厂不登录或请求模型，实际调用时才执行对应实现。
// Anthropic聊天入口是轻量lazy工厂，下面再包装会话头。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
// Google聊天延迟入口，工厂调用不立即导入重SDK。
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
// OpenAI Completions协议的延迟入口。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// OpenAI Responses协议的延迟入口，与Completions分别按model.api分发。
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
// System One分类器延迟工厂，classify时才导入实现，不返回聊天事件流。
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
// 认证助手构造login/resolve：存储非空key优先，否则按配置的环境变量名查询；构造本身不问用户或取token。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行时装配函数，Provider只是编译期返回契约。
import { createProvider, type Provider } from "../models.ts";
// 只读生成目录的聊天/分类表；本文件不手改目录、向OpenCode发现模型或改写每个模型的端点。
import { OPENCODE_CLASSIFIER_MODELS, OPENCODE_MODELS } from "./opencode.models.ts";
// 会话头包装器仅作用在下方四种聊天实现，不会自动包装classifiers。
import { withOpenCodeSessionHeader } from "./opencode-headers.ts";

// 联合类型限定聊天API的四种文字，生成JS后擦除；分类协议通过classifiers独立装配，不混进这个聊天联合。
type OpenCodeApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

// 创建一份Zen供应商，无参数，返回Provider<OpenCodeApi>；例opencodeProvider().getModels()可列静态聊天模型而不发请求。
// 流程是构造认证器→合并聊天/分类静态条目→为四聊天API补头→加分类器→交createProvider；每次新建Provider/目录数组，但模型对象可共享。实际stream/classify/login有各自副作用，装配错误同步传播。
export function opencodeProvider(): Provider<OpenCodeApi> {
	// 显式泛型关联聊天协议联合，createProvider建立目录/能力方法，不在这里调用它们。
	return createProvider<OpenCodeApi>({
		// 注册ID是opencode，Models按此ID区分Go供应商。
		id: "opencode",
		// 展示名为OpenCode Zen，不拿名字自动推导URL。
		name: "OpenCode Zen",
		// 提供API key认证能力，只配置OPENCODE_API_KEY这一个环境候选；不提供OAuth，也不在工厂中读取凭据文件。
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		// Object.values各取表值，再展开合成新数组：含聊天及分类，不含生成入口里的图片表；条目仍引用生成模型对象。
		models: [...Object.values(OPENCODE_MODELS), ...Object.values(OPENCODE_CLASSIFIER_MODELS)],
		// 聊天实现按协议名映射，不是按模型ID建一个函数表。
		api: {
			// 构造Anthropic lazy流并包会话头；stream调用时先补options再触发实现加载。
			"anthropic-messages": withOpenCodeSessionHeader(anthropicMessagesApi()),
			// Google聊天流采用相同会话路由包装。
			"google-generative-ai": withOpenCodeSessionHeader(googleGenerativeAIApi()),
			// Completions聊天流同样注入或保留调用者会话头。
			"openai-completions": withOpenCodeSessionHeader(openAICompletionsApi()),
			// Responses聊天流独立包装，非在此把全部请求转换成Completions。
			"openai-responses": withOpenCodeSessionHeader(openAIResponsesApi()),
		},
		// OpenCode Zen serves TypeSafe's System One protocol at /inference/systemone/v1/systemone.
		// 分类能力按typesafe-system-one协议键提供；没有套聊天会话头包装，路由路径细节由分类实现/模型端点决定，工厂不发分类请求。
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
