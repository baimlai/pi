// Qwen Token Plan Individual入口：独立供应商ID/模型目录，使用国际端点和国际API key变量；共享变量不等于账号权限或目录完全相同。
// openAICompletionsApi创建按需加载的聊天实现，不在工厂构造时加载SDK或发请求。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// 认证助手支持宿主交互输入key与按存储/环境解析；返回方法不等于此时已登录。
import { envApiKeyAuth } from "../auth/helpers.ts";
// 运行值createProvider装配能力，Provider接口只参与静态检查。
import { createProvider, type Provider } from "../models.ts";
// 只读Individual独立生成的聊天目录，不根据共用端点自动补入国际版其它模型。
import { QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS } from "./qwen-token-plan-individual.models.ts";

// 无参返回Individual的Completions Provider；例p=qwenTokenPlanIndividualProvider()后p.id为qwen-token-plan-individual，p.getModels()从独立静态表列模型。
// 依次保存元数据、构造认证、取目录数组、装配延迟流，外层对象/数组每次新建，模型对象仍共享。没有现场鉴权、动态目录抓取或写入凭据，装配失败同步抛出；请求/宿主认证能力在后续实际调用时执行。
export function qwenTokenPlanIndividualProvider(): Provider<"openai-completions"> {
	// 交统一工厂，不在这里把ID转换为国际版ID，也不自动注册到Models。
	return createProvider({
		// 独立ID让同一集合可同时保留国际/CN/Individual三个Provider；存储按ID时条目也可分开。
		id: "qwen-token-plan-individual",
		// 展示名包含Individual，不是根据当前key在线探测到的套餐名称。
		name: "Qwen Token Plan Individual",
		// Provider元数据使用国际版同一东南亚端点；不改生成模型的baseUrl，后续模型/认证层仍决定实际请求端点。
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		// 环境变量刻意复用QWEN_TOKEN_PLAN_API_KEY，没有另设INDIVIDUAL变量；非空存储key仍优先，宿主按不同provider ID保存的key可不同。
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan Individual API key", ["QWEN_TOKEN_PLAN_API_KEY"]) },
		// 取Individual表的值建新数组，不与国际表拼接；共享原模型对象，不执行远端资格检查。
		models: Object.values(QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS),
		// 单个Completions延迟实现，不装配图片/分类能力，也不在构造时生成回复。
		api: openAICompletionsApi(),
	});
}
