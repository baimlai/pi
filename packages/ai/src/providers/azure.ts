// Azure供应商装配：Responses直接用专用适配器，Chat Completions额外准备端点与部署名；配置失败在延迟流内表达，不在供应商构造时请求Azure。
// URL和部署名解析只处理配置优先级/字符串，不检查资源存在或授权。
import { resolveAzureBaseUrl, resolveDeploymentName } from "../api/azure-openai-config.ts";
// Responses专用延迟实现自己处理Azure配置。
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
// 把异步准备/加载/转发失败包装成统一事件流错误结果。
import { lazyStream } from "../api/lazy.ts";
// Azure部分模型仍走通用Chat Completions实现，在本文件外包Azure准备步骤。
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
// API key认证器负责存储key优先和环境变量回退。
import { envApiKeyAuth } from "../auth/helpers.ts";
// 供应商构造助手及只在编译期使用的Provider类型。
import { createProvider, type Provider } from "../models.ts";
// 泛型模型、聊天流集合与请求选项的契约，类型不会自动校验配置。
import type { Api, Model, ProviderStreams, StreamOptions } from "../types.ts";
// 只读生成目录，包含Responses和Completions两类协议模型。
import { AZURE_MODELS } from "./azure.models.ts";

// 用途：输入模型及可为undefined的配置，返回浅拷贝模型并填解析后的Azure baseUrl；例如资源根URL经助手规范为/openai/v1。
// 不改model.id或原对象，不发网络请求；URL缺失/无法解析时抛错，由调用处lazyStream转为流错误，而非自动尝试另一协议。
function resolveAzureModel(model: Model<Api>, options: StreamOptions | undefined): Model<Api> {
	// 展开模型后覆盖baseUrl，其他嵌套字段继续共享；解析器会结合请求选项/env/模型字段选择地址。
	return { ...model, baseUrl: resolveAzureBaseUrl(model, options) };
}

/** Send the deployment name as the request's model, keeping `model.id` as the catalog id. */
// 用途：输入目录模型与可选配置，返回原配置或带新onPayload的浅拷贝；例目录id=a映射部署prod，在载荷写model:prod，回复身份仍使用目录id=a。
// 流程：解析部署名；与id相同则直接返回，不额外安装回调；不同则包装调用方onPayload。构造无网络，回调在实际请求前运行且可异步拒绝或继续替换整个载荷。
function withDeploymentName<T extends StreamOptions>(model: Model<Api>, options: T | undefined): T | undefined {
	// 先按显式部署名、环境映射、原id选择；非法配置是否报错取决于实际解析器。
	const deploymentName = resolveDeploymentName(model, options);
	// 无需映射时保留同一options引用，调用方原onPayload也保持原样。
	if (deploymentName === model.id) return options;
	// 创建新配置对象，不原地修改调用方传入的选项。
	return {
		// 浅复制其他字段，后面的onPayload会覆盖原同名字段。
		...options,
		// 用途：收到待发送的unknown载荷和下层提供的模型，先写部署名，再让原回调检查/替换，返回最终载荷Promise；例如调用方可再加temperature。
		// as object仅帮助展开类型，不验证wire形状；这里不保证调用方最终仍保留部署名，回调副作用及异常照常传播。
		onPayload: async (payload, payloadModel) => {
			// 创建外层浅拷贝并覆盖model；原payload对象及目录模型不在这里原地改写。
			const params = { ...(payload as object), model: deploymentName };
			// 原回调若存在则等待它；null/undefined都由??回退params，其他返回值原样采用，不做形状校验。
			return (await options?.onPayload?.(params, payloadModel)) ?? params;
		},
		// as维持泛型配置视图，不转换或验证专有字段。
	} as T;
}

/**
 * Resolve the Azure endpoint and deployment before dispatch, inside `lazyStream` so an
 * unconfigured endpoint errors on the stream instead of throwing out of `stream()`.
 */
// 用途：给一组Completions流能力加Azure准备包装，输入原始/简化流集合，返回新的两函数对象；例无端点时返回error流，而不是在stream调用处同步抛配置错。
// 每次请求在lazyStream的async setup中解析模型端点/部署名并转交；不在本函数构造时读取配置或发请求。只保留stream/streamSimple，不复制输入的可选deferred方法。
function azureStreams(streams: ProviderStreams): ProviderStreams {
	// 新对象的两个闭包共享传入流集合引用。
	return {
		// 用途：原始选项流入口，输入模型/规范上下文/选项，即刻返回外层流，再异步准备与委托；准备或调用失败由lazyStream生成error终态。
		stream: (model, context, options) =>
			// async setup会立即开始执行直到首次await，调用方不必先迭代外层流才触发准备。
			lazyStream(model, async () =>
				// 先准备浅拷贝模型和配置，再调用捕获的stream；真正HTTP发生在下层适配器，不在配置解析器。
				streams.stream(resolveAzureModel(model, options), context, withDeploymentName(model, options)),
			),
		// 用途：与上一入口相同，但接通用简化选项并调用下层streamSimple；例如reasoning等级仍由适配器转换，Azure包装只准备地址/部署。
		streamSimple: (model, context, options) =>
			// 外层使用原目录模型身份，内部请求则收到带解析baseUrl的浅拷贝。
			lazyStream(model, async () =>
				// 保留上下文内容；withDeploymentName同样允许调用方onPayload在部署改写后继续处理。
				streams.streamSimple(resolveAzureModel(model, options), context, withDeploymentName(model, options)),
			),
	};
}

// 用途：无参数构造Azure供应商，返回聊天API为Responses或Completions联合的Provider；只装配目录/认证/协议映射，不访问Azure。
// 例目录中的DeepSeek模型api=openai-completions走azureStreams包装，GPT Responses模型走专用Azure适配器；由model.api分发，非靠名字猜协议。
export function azureProvider(): Provider<"azure-openai-responses" | "openai-completions"> {
	// 统一工厂创建新供应商，按模型api查下面映射。
	return createProvider({
		// 稳定供应商键。
		id: "azure",
		// 展示名。
		name: "Azure",
		// 存储真值key优先，否则读AZURE_OPENAI_API_KEY；端点配置不混入此认证器。
		auth: { apiKey: envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]) },
		// 生成聊天表转数组，保留原模型对象，构造不验证部署是否存在。
		models: Object.values(AZURE_MODELS),
		// 每个协议键对应自己的流集合，Provider每次用model.api选择。
		api: {
			// Responses已有Azure专用参数准备，不再套此文件的Completions包装。
			"azure-openai-responses": azureOpenAIResponsesApi(),
			// 通用Completions实现额外套Azure端点/部署名准备，SDK仍按需加载。
			"openai-completions": azureStreams(openAICompletionsApi()),
		},
	});
}
