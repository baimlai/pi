// Vercel AI Gateway供应商装配，合并聊天与分类目录并分别挂协议实现；调用这些协议不等于直接访问原厂商。
// 聊天采用Anthropic Messages延迟能力，构造不加载完整请求实现或发模型请求。
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
// 分类采用System One延迟能力，classify返回Promise，与聊天事件流接口分开。
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
// 导入通用key策略，构造只保存展示名和环境候选，不弹窗或读取秘密。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider参与运行，type Provider只约束返回形状；泛型中的聊天API不限制独立分类字段的协议。
import { createProvider, type Provider } from "../models.ts";
// 读取生成的聊天/分类两张表；这里只读catalog生成结果，未导入图片生成表。
import { VERCEL_AI_GATEWAY_CLASSIFIER_MODELS, VERCEL_AI_GATEWAY_MODELS } from "./vercel-ai-gateway.models.ts";

// 无参数创建Vercel AI Gateway Provider，返回聊天泛型为anthropic-messages的对象，同时提供独立分类能力。
// 流程保存身份/URL→创建key策略→展开两类目录→挂聊天/分类lazy能力；例p=vercelAIGatewayProvider()后getModels只列聊天，getAllModels?.()含两类。
// 每次新建Provider外框和目录数组，模型对象仍共享；构造不自动注册Models、不登录/读环境/联网/刷新目录，装配同步错误直接传播。
export function vercelAIGatewayProvider(): Provider<"anthropic-messages"> {
	// 显式泛型只限制聊天协议；缺聊天或分类模型时也不会由泛型自动补目录或生成实现。
	return createProvider<"anthropic-messages">({
		// 供应商ID标识网关归属，和代理的各个模型ID、底层厂商名分开。
		id: "vercel-ai-gateway",
		// 展示名称只作元数据，不在此探测网关支持的模型或账户权限。
		name: "Vercel AI Gateway",
		// 网关基础URL保存为Provider元数据，不自动覆盖生成模型各自的聊天或分类baseUrl。
		baseUrl: "https://ai-gateway.vercel.sh",
		// 认证使用AI_GATEWAY_API_KEY，非空存储key优先，再由宿主环境解析；不会按代理模型改用原厂商的key变量。
		auth: { apiKey: envApiKeyAuth("Vercel AI Gateway API key", ["AI_GATEWAY_API_KEY"]) },
		// ...展开两个Object.values新数组到同一目录容器；合并的是聊天和分类条目引用，种类由模型type区分，不是把分类模型转成聊天模型。
		models: [...Object.values(VERCEL_AI_GATEWAY_MODELS), ...Object.values(VERCEL_AI_GATEWAY_CLASSIFIER_MODELS)],
		// 创建聊天延迟对象，不调用stream；实际消息转换和网关路径由适配器及模型配置决定。
		api: anthropicMessagesApi(),
		// AI Gateway serves TypeSafe's System One protocol at /typesafe/v1/systemone.
		// 按分类model.api装入System One延迟对象，路径能力与聊天独立；上方原英文说明的是网关服务路径，不在这行发请求。
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
