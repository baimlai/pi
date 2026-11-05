// Google Gemini的供应商装配：静态聊天目录、GEMINI_API_KEY认证与Generative AI延迟流；与另一个Vertex/ADC供应商分开。
// 导入轻量工厂，真实Google SDK在实际流方法调用时才加载。
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
// 复用存储key优先、环境变量回退的认证策略。
import { envApiKeyAuth } from "../auth/helpers.ts";
// Provider是编译期类型，createProvider是真正的运行时构造助手。
import { createProvider, type Provider } from "../models.ts";
// 只读生成聊天目录，不直接编辑生成包装或其data。
import { GOOGLE_MODELS } from "./google.models.ts";

// 用途：无参数创建Google Provider，返回google-generative-ai聊天供应商；构造只装目录/认证/流函数，不验证key或发网络请求。
// 例models.setProvider(googleProvider())后读其聊天目录；当Models解析认证时优先存储key，否则查GEMINI_API_KEY，再由流适配器实际请求。
export function googleProvider(): Provider<"google-generative-ai"> {
	// 返回新供应商对象，泛型由传入模型/实现等信息推导。
	return createProvider({
		// 用于模型归属和凭证存储的键。
		id: "google",
		// 供应商展示名称。
		name: "Google",
		// 供应商端点元数据；此字段本身不会打开连接。
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		// envApiKeyAuth登录会询问secret；解析器查存储或环境，不做远端有效性校验。
		auth: { apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]) },
		// Object.values新建数组，模型对象保持生成目录原引用；这里只列聊天模型。
		models: Object.values(GOOGLE_MODELS),
		// 此时只创建延迟能力对象，stream/streamSimple调用才加载实现。
		api: googleGenerativeAIApi(),
	});
}
