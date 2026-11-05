// Xiaomi Token Plan SGP的聊天装配入口，供builtinProviders创建内置供应商；本文件不实现MiMo参数转换或HTTP请求。
// 导入Completions的轻量lazy工厂，实际流方法调用才触发协议实现加载，不因导入这里就调用SDK。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 导入通用API key认证器工厂，构造只记录展示名和环境候选，login/resolve才执行对应操作。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行函数；type Provider只作编译期返回契约检查，类型会被擦除。
import { createProvider, type Provider } from "../models.ts";
// 导入生成的Xiaomi Token Plan SGP聊天目录表；生成输入位于catalog/providers，对应生成文件不在这里手改。
import { XIAOMI_TOKEN_PLAN_SGP_MODELS } from "./xiaomi-token-plan-sgp.models.ts";

// 无参数创建Xiaomi Token Plan SGPProvider，返回Provider<"openai-completions">；泛型限制聊天协议类型，并非检查远端当前是否可用。
// 流程保存身份/端点→配置认证→列静态聊天模型→挂lazy能力；例p=xiaomiTokenPlanSgpProvider()后p.id为xiaomi-token-plan-sgp，p.getModels()只列本地条目。
// 每次创建外层对象和模型数组，条目对象仍共享；构造不读key、不登录、不刷新目录、不自动注册集合或联网，装配同步错误直接传播。
export function xiaomiTokenPlanSgpProvider(): Provider<"openai-completions"> {
	// return把下面对象交给统一工厂，取得目录和流派发等方法；这里只装配能力，不是发出一次聊天请求。
	return createProvider({
		// 供应商ID用于目录与凭证的归属，与模型自身ID不同；四个Xiaomi入口各有自己的ID。
		id: "xiaomi-token-plan-sgp",
		// 界面展示名称按配置保存，不据此选择计费模式、探测账号或推导模型能力。
		name: "Xiaomi Token Plan SGP",
		// 保存此入口的Provider级基础URL；createProvider不拿它覆盖生成模型自己的baseUrl，实际请求仍消费模型及认证覆盖。
		baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		// 只登记XIAOMI_TOKEN_PLAN_SGP_API_KEY这一环境候选；实际resolve先用非空存储key，再查询宿主ctx.env，此处不读取秘密。不回退到普通XIAOMI_API_KEY或CN/AMS变量；SGP是这份明确配置的入口名。
		auth: { apiKey: envApiKeyAuth("Xiaomi Token Plan SGP API key", ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"]) },
		// Object.values(XIAOMI_TOKEN_PLAN_SGP_MODELS)创建新数组，复用目录里原模型引用；只接聊天表，不把图片/分类表一起装入。
		models: Object.values(XIAOMI_TOKEN_PLAN_SGP_MODELS),
		// 新建延迟Completions能力，不调用stream；思考档位/兼容字段来自模型目录并交实际适配器处理，不在这个工厂现场改写。
		api: openAICompletionsApi(),
	});
}
