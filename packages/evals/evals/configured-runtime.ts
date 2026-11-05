// 在被评测代理改好配置后，用真实 ModelRuntime 读取模型并发探测请求；目标 URL 可为本地假服务。
import { type Api, type Context, contentText, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// 只保留结构化评分所需模型字段；Array<"text" | "image"> 表示元素只能是这两种字面量。
// 这些类型是编译时约束，不自动验证磁盘上的 models.json。
type ModelFields = {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

// result 是成功数据或 error 对象的联合；调用者应按字段区分，不能把错误当成功响应。
export type ProviderRuntimeOutput = {
	result:
		| {
				// 调用场景 getter 查询假服务状态，不从响应文字反推请求是否合法。
				validRequestReceived: boolean;
				model: ModelFields;
				// 响应只摘文字、停止原因及输入/输出用量。
				response: { text: string; stopReason: string; inputTokens: number; outputTokens: number };
		  }
		| { error: string };
};

// 新增模型场景只报告模型字段与原模型是否仍可查到，不发聊天请求。
export type AddedModelOutput = {
	result: { model: ModelFields; existingModelsPreserved: boolean } | { error: string };
};

// 探测参数包含模型身份、上下文工厂、可选请求选项及状态读取回调。
// ? 表示 options 可省略；createContext 与 validRequestReceived 是方法签名，不在声明时执行。
export type ProviderScenario = {
	providerId: string;
	modelId: string;
	createContext(): Context;
	options?: ModelsSimpleStreamOptions;
	validRequestReceived(): boolean;
};

// 从已类型化模型投影评分字段；输入 Model<Api>，返回新对象，无文件或网络副作用。
// 例如复制 input 数组和 cost 对象，避免把整个 Provider 元数据暴露给严格对象评分。
function modelFields(model: Model<Api>): ModelFields {
	// 显式列字段，不把 api/baseUrl 等未评分字段展开进去。
	return {
		// id、name、provider 记录模型身份；下方 reasoning/input 记录能力。
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		// 展开运算符建立新数组，元素本身是字符串，不需要深复制。
		input: [...model.input],
		// 逐个拷贝四种单价，未包括 tiers 等额外定价信息。
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		// 保留声明的上下文与最大输出上限，不在此推导或实测容量。
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

// 重读配置、定位模型并等待一次探测完成，返回可评分的 result 或 error。
// 输入运行时和场景；例如本地 acme 回复 ACME_OK 时同时记录假服务是否收到准确探测文本。
// 副作用包括刷新本地模型配置和执行 completion；allowNetwork:false 只禁目录刷新网络，不禁后面的聊天请求。
// 刷新/getModel 位于 try 外，其异常会直接拒绝；try 内抛出的值才转成 error 字符串。
export async function inspectProvider(
	runtime: ModelRuntime,
	scenario: ProviderScenario,
): Promise<ProviderRuntimeOutput> {
	// 等待配置重载及可用性刷新，明确不下载模型目录。
	await runtime.refresh({ allowNetwork: false });
	// 读刷新后保存的配置/组合/可用性错误文字，不重新发请求。
	const configurationError = runtime.getError();
	// 发现已记录错误就返回结构化失败，跳过探测。
	if (configurationError) return { result: { error: configurationError } };
	// 按供应商与模型 id 查当前模型，没有则为 undefined。
	const model = runtime.getModel(scenario.providerId, scenario.modelId);
	// 模型缺失属于可预期失败，用 result.error 描述。
	if (!model) {
		// 错误中保留目标身份，便于与评分期望定位。
		// 成功完成 await 不等于模型成功：下面保留 stopReason，让评分检查真实状态。
		return { result: { error: `Model ${scenario.providerId}/${scenario.modelId} is unavailable after reload.` } };
	}
	// 从 completion 开始捕获运行时抛出的异常。
	try {
		// 调用上下文工厂并等待最终消息；提供者也可能返回 stopReason:error 的消息而不抛异常。
		const response = await runtime.completeSimple(model, scenario.createContext(), scenario.options);
		return {
			result: {
				validRequestReceived: scenario.validRequestReceived(),
				// 把已选模型投影到约定的评分形状。
				model: modelFields(model),
				response: {
					// contentText 合并文本内容块，不把思考或工具调用转换成文本。
					text: contentText(response.content),
					stopReason: response.stopReason,
					inputTokens: response.usage.input,
					outputTokens: response.usage.output,
				},
			},
		};
	// catch 变量在 TS 中是 unknown，需要判断 Error 才能读 message。
	} catch (error) {
		// 真实 Error 取 message，其他抛出值用 String 转成可评分文字。
		return { result: { error: error instanceof Error ? error.message : String(error) } };
	}
}

// 比较干净内置目录与重载后的配置；输入运行时、供应商和新增模型 id，返回字段及保留情况。
// 例如向 openai 加 fixture-chat 后，检查内置每个 id 仍可查到；不证明内置模型元数据完全未变。
// 会新建无 models.json 覆盖的基准运行时并刷新传入运行时；无聊天请求，本函数不捕获抛出的异常。
export async function inspectAddedModel(
	runtime: ModelRuntime,
	providerId: string,
	modelId: string,
): Promise<AddedModelOutput> {
	// modelsPath:null 不读取用户模型覆盖，allowModelNetwork:false 禁目录下载。
	const pristineRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	// 基准目录必须包含指定内置供应商。
	const pristineProvider = pristineRuntime.getProvider(providerId);
	// 缺供应商时不能建立保留基准，直接返回错误。
	if (!pristineProvider) return { result: { error: `Built-in provider ${providerId} is unavailable.` } };
	// map 的对象解构只取每个内置模型的 id，形成比较清单。
	const existingModelIds = pristineProvider.getModels().map(({ id }) => id);
	// 没有内置模型时不能把 every 空数组的 true 当作有意义的保留证明。
	if (existingModelIds.length === 0) {
		// 报告空内置目录，不继续重载比较。
		return { result: { error: `Built-in provider ${providerId} has no models.` } };
	}
	// 基准确定后重读被评测配置；这一步仍不从网络更新目录。
	await runtime.refresh({ allowNetwork: false });
	// 读取并转回重载错误，防止评分静默使用坏配置。
	const configurationError = runtime.getError();
	if (configurationError) return { result: { error: configurationError } };
	// 定位新增模型；只有查到后才比较原 id 是否保留。
	const model = runtime.getModel(providerId, modelId);
	// 未新增成功时返回带具体身份的错误。
	if (!model) {
		return { result: { error: `Model ${providerId}/${modelId} is unavailable after reload.` } };
	}
	// 输出模型字段及所有基准 id 的存在性。
	return {
		result: {
			model: modelFields(model),
			// every 对每个 id 执行查找，任一 undefined 就为 false；只检查存在，不比较字段值。
			existingModelsPreserved: existingModelIds.every((id) => runtime.getModel(providerId, id) !== undefined),
		},
	};
}
