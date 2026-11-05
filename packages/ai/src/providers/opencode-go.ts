// 装配OpenCode Go的静态聊天Provider，与Zen分开ID/目录，但共用API key变量和会话头包装；这里只创建能力对象，不实际请求。
// 先导入Anthropic聊天的延迟工厂，不在这行加载其重SDK实现。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
// Google聊天延迟工厂。
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
// Completions聊天延迟工厂。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// Responses聊天延迟工厂，按模型api选择而非按名字猜测。
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
// API key通用认证器：实际resolve才取存储/环境来源，login才向宿主问secret。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider真正创建对象；type Provider仅参与TypeScript检查。
import { createProvider, type Provider } from "../models.ts";
// Go生成目录只读，JSON入口摊平后得到模型引用，本文件不修改生成数据或现场查询服务。
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";
// 给聊天流选项加会话路由头，显式同名头（含null）由调用者保留控制。
import { withOpenCodeSessionHeader } from "./opencode-headers.ts";

// Go支持装配的聊天协议联合，与Zen这里四种相同，但不证明每个模型或远端套餐都支持所有协议。
type OpenCodeGoApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

// 无参数创建Go Provider，返回限定聊天API类型的对象；例opencodeGoProvider().getModels()只读本地聊天目录，不验证订阅。
// 流程构造认证器/目录数组，再为四API各创建lazy包装并交createProvider。每次新建外层对象，模型条目共享；未装配图片/分类能力，不自动登录或刷新远端，装配异常向调用方同步传播。
export function opencodeGoProvider(): Provider<OpenCodeGoApi> {
	// 把字段与能力映射交统一工厂，泛型保留协议联合，不能代替运行时服务能力探测。
	return createProvider<OpenCodeGoApi>({
		// 独立ID为opencode-go，不覆盖同一Models集合里的opencode条目。
		id: "opencode-go",
		// 展示名OpenCode Go，端点由模型元数据等后续层决定。
		name: "OpenCode Go",
		// 同Zen使用OPENCODE_API_KEY，存储非空key可优先于环境；工厂本身只创建认证方法，不执行它们。
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		// Object.values生成聊天模型新数组，原模型对象不深复制；未把Go图片/分类生成表加入此Provider。
		models: Object.values(OPENCODE_GO_MODELS),
		// 按model.api选取下面四种聊天实现。
		api: {
			// Anthropic流加会话路由包装，实际协议模块留到流方法调用加载。
			"anthropic-messages": withOpenCodeSessionHeader(anthropicMessagesApi()),
			// Google流应用同样sessionId转头规则。
			"google-generative-ai": withOpenCodeSessionHeader(googleGenerativeAIApi()),
			// Completions流也保留调用者已有的大小写无关会话头。
			"openai-completions": withOpenCodeSessionHeader(openAICompletionsApi()),
			// Responses流同样包装，cacheRetention:none不影响此会话路由逻辑。
			"openai-responses": withOpenCodeSessionHeader(openAIResponsesApi()),
		},
	});
}
