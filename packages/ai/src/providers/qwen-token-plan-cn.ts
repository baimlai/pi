// 中国区Qwen Token Plan入口，与国际版分开供应商ID、端点、环境变量和静态目录；只装配聊天能力，不测试地区连通性。
// 聊天实现采用Completions延迟工厂，实际流方法调用才开始加载重实现。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 通用API key认证器工厂，声明查询哪一个变量，不在导入时读取真实key或弹登录框。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider负责运行时装配，type Provider只让TS检查返回接口。
import { createProvider, type Provider } from "../models.ts";
// CN专用生成聊天目录，底层从本地JSON摊平；本文件不生成它，也不查询远端模型列表。
import { QWEN_TOKEN_PLAN_CN_MODELS } from "./qwen-token-plan-cn.models.ts";

// 无参创建CN Provider，返回Completions聊天能力；例p=qwenTokenPlanCnProvider()后p.id为qwen-token-plan-cn，p.getModels()读的是CN表。
// 保存CN元数据→构造key认证→取得模型数组→装配lazy流，每次新建外层Provider/数组但共享模型对象。无即时登录/网络/写盘，构造异常向外传播；是否接受key与实际请求成功要等后续调用。
export function qwenTokenPlanCnProvider(): Provider<"openai-completions"> {
	// 统一工厂创建供应商对象，不自动把它加入某个Models实例或刷新目录。
	return createProvider({
		// CN有独立ID，不能把qwen-token-plan当作同一个注册键。
		id: "qwen-token-plan-cn",
		// 展示名明确CN，文字本身不切换地域。
		name: "Qwen Token Plan CN",
		// 记录北京区Provider端点；仅保存元数据，不重写生成模型baseUrl或在这里检测URL/连通性。
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		// 只查询CN专用QWEN_TOKEN_PLAN_CN_API_KEY；先取非空存储key，再按需查询此环境来源，不自动退到国际版变量。
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan CN API key", ["QWEN_TOKEN_PLAN_CN_API_KEY"]) },
		// 将CN聊天表的值转新数组，仍引用原模型；未注册图片/分类生成表，也不在此保证远端名单实时一致。
		models: Object.values(QWEN_TOKEN_PLAN_CN_MODELS),
		// 构造Completions lazy实现，不调用stream或等待模型回复。
		api: openAICompletionsApi(),
	});
}
