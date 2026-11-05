// 旧版OpenAI Codex供应商装配：生成聊天目录、ChatGPT订阅OAuth及Codex Responses延迟流，与openai供应商的公开API路径分开。
// 轻量工厂到实际流调用时才加载Codex传输实现。
import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
// OAuth延迟外观先提供元数据，不立即加载Node认证流程。
import { lazyOAuth } from "../auth/helpers.ts";
// 具体flow加载器，不在导入时进行登录。
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
// 构造运行值与Provider类型。
import { createProvider, type Provider } from "../models.ts";
// 只读生成聊天目录，不手改*.models.ts。
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

// 用途：无参数创建旧Codex Provider，返回openai-codex-responses聊天供应商；装目录/OAuth/延迟流，不访问ChatGPT或核验订阅。
// 例models.setProvider(openaiCodexProvider())后由models.login("openai-codex","oauth",interaction)编排登录及存储；本工厂只声明OAuth方式，没有另装API key登录器，也不在此禁止请求显式选项。
export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	// 新建供应商对象，真实请求能力留待后续调用。
	return createProvider({
		// 独立凭证和模型归属键，区别openai。
		id: "openai-codex",
		// 原展示名保留legacy标记，不由此决定运行时禁用。
		name: "OpenAI Codex (legacy)",
		// 账户后端地址元数据，不是公开api.openai.com地址。
		baseUrl: "https://chatgpt.com/backend-api",
		// 这里只装一个OAuth认证方法，不在构造时解析已有凭证。
		auth: {
			// 首次具体认证方法调用时才加载flow，加载Promise的复用由lazyOAuth管理。
			oauth: lazyOAuth({
				// 方式展示名。
				name: "OpenAI (ChatGPT Plus/Pro)",
				// 订阅元数据，不保证账号实际享有某模型权限。
				isSubscription: true,
				// 加载函数引用，不在此启动回调服务器或浏览器。
				load: loadOpenAICodexOAuth,
			}),
		},
		// 目录表取值成新数组，模型对象仍共享生成数据引用。
		models: Object.values(OPENAI_CODEX_MODELS),
		// 只创建延迟流包装，不在此开启HTTP/WebSocket请求。
		api: openAICodexResponsesApi(),
	});
}
