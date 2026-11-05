// 国际版Qwen Token Plan供应商入口，组合静态聊天目录、单一Completions协议和API key认证；工厂不现场查询套餐或发请求。
// openAICompletionsApi是延迟工厂，实际stream调用才加载协议实现/SDK，不因import这一轻量模块就调用模型。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 认证助手只构造login/resolve方法；真正解析先用非空存储key，否则再向宿主查环境变量。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行装配函数，Provider为类型导入，生成JS后没有此接口值。
import { createProvider, type Provider } from "../models.ts";
// 本地生成聊天目录；只读这些模型对象，不手改生成文件、不把图片/分类目录混进来。
import { QWEN_TOKEN_PLAN_MODELS } from "./qwen-token-plan.models.ts";

// 无参创建国际套餐Provider，返回聊天API限为openai-completions的对象；例p=qwenTokenPlanProvider()后p.id为qwen-token-plan，p.getModels()只列本地聊天条目。
// 流程保存ID/展示名/端点，构造认证器，取静态表值，接延迟流；每次新建Provider与模型数组，模型对象仍共享。构造不读取密钥、不登录/联网，装配异常同步传播，实际认证/请求需之后调用相应方法。
export function qwenTokenPlanProvider(): Provider<"openai-completions"> {
	// 把数据交统一工厂，返回带目录读取与聊天分发方法的对象，不在此把Provider注册到全局Models。
	return createProvider({
		// 唯一ID区分国际、CN、Individual三份供应商，不由名称或地域自动合并。
		id: "qwen-token-plan",
		// 展示名只用于界面，不参与身份比较或认证验证。
		name: "Qwen Token Plan",
		// Provider层记录东南亚国际端点文字；createProvider不据此重写生成模型各自的baseUrl，实际请求还看模型/后续认证覆盖，不在这行发HTTP。
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		// API key能力使用QWEN_TOKEN_PLAN_API_KEY作为环境候选，与Individual共用变量名；空存储key可回退环境，这里未提供OAuth方法。
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan API key", ["QWEN_TOKEN_PLAN_API_KEY"]) },
		// Object.values新建模型数组，条目是生成表中原对象引用；没有在这里按套餐在线过滤或克隆模型。
		models: Object.values(QWEN_TOKEN_PLAN_MODELS),
		// 单个延迟Completions实现服务该Provider的聊天请求，不在此把api字段动态改成其它协议。
		api: openAICompletionsApi(),
	});
}
