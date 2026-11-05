// 内置图片 API 的延迟加载与注册：入口先注册轻量包装，第一次生成时才加载 OpenRouter 实现；导入失败也会留在缓存 Promise 中。
// 只借用实际函数类型并改本地类型名，不因这条 type import 立即加载实现及其 SDK。
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
// 通过全局图片注册表发布包装器；这不是 Models 的供应商注册。
import { registerImagesApiProvider } from "../../images-api-registry.ts";
// 分别描述结果、API、模型、上下文、函数和配置；这些类型不参与运行时验证。
import type {
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
} from "../../types.ts";

// 延迟模块需要的最小形状，只声明本包装器会用到的导出。
interface OpenRouterImagesProviderModule {
	// 类型位置的 typeof 复用真实函数签名，避免在此重复维护参数和返回类型。
	generateImages: typeof generateImagesOpenRouterFunction;
}

// 首次调用前是 undefined；以后共享同一加载 Promise，包括已拒绝的 Promise，本文件没有清缓存接口。
let openRouterImagesProviderModulePromise: Promise<OpenRouterImagesProviderModule> | undefined;

// 用途：将加载/调用异常转换成没有输出的图片错误结果。输入模型和任意抛出值，返回带身份及时间戳的对象；例如 Error("缺少模块") 的 message 会写入 errorMessage。
// 不发请求，不把取消单独映射为 aborted；String(error) 采用普通字符串转换，不能把它当成永不抛错的外部值净化器。
function createLazyLoadErrorImages(model: ImageModel<ImageApi>, error: unknown): AssistantImages {
	// 返回的是正常对象；是否让外层 Promise 拒绝取决于本函数构造过程中是否另有异常。
	return {
		// 保留被请求模型的 API，而非从异常推测。
		api: model.api,
		// 保留供应商身份。
		provider: model.provider,
		// 结果中的 model 字段存模型 ID 字符串。
		model: model.id,
		// 本层没有可交付的图片或文字输出。
		output: [],
		// 此处统一表示错误，包括落入 catch 的取消异常。
		stopReason: "error",
		// unknown 必须先缩小才能读 message；非 Error 值用 String 表示，不执行脱敏。
		errorMessage: error instanceof Error ? error.message : String(error),
		// 记录创建此结果的本地毫秒时间，不是服务端生成时间。
		timestamp: Date.now(),
	};
}

// 用途：取得共享的 OpenRouter 图片模块加载 Promise。无参数，首次启动动态导入，后续复用；例如并发两次生成只在本变量中创建一次加载 Promise。
// ||= 仅在现值为假值时赋值；这里成功和失败 Promise 都为真值，因此加载拒绝后不会自行重试。断言只告诉 TS 所需模块形状，不验证导出。
function loadOpenRouterImagesProviderModule(): Promise<OpenRouterImagesProviderModule> {
	// 保留原动态导入表达式：实际实现及 SDK 到调用此函数时才开始加载。
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		// then 将加载到的模块作为所需接口使用，没有创建或验证 generateImages 函数。
		(module) => module as OpenRouterImagesProviderModule,
	);
	// 返回缓存 Promise；不是每次都创建新的导入任务。
	return openRouterImagesProviderModulePromise;
}

// 用途：输入模型、图片上下文和可选配置，异步返回生成结果；先加载模块，再委托真实实现，请求副作用在实现内部发生。
// 例首次调用会等待 import，再原样传入提示；导入或实现拒绝会在此转换为 stopReason:"error" 对象，不保留拒绝过程中未返回的部分输出。
export const generateImagesOpenRouter: ImagesFunction<ImagesOptions> = async (
	// 本层不再次检查 model.api，注册表包装器负责对应 API 的一致性检查。
	model: ImageModel<ImageApi>,
	// 文字和参考图输入不在本层重写。
	context: ImagesContext,
	// 可省略的密钥、信号、headers 等选项透传给真实实现。
	options?: ImagesOptions,
) => {
	// 同一 try 覆盖加载和实际异步生成的拒绝。
	try {
		// 等待共享的加载 Promise，失败进入下方 catch。
		const module = await loadOpenRouterImagesProviderModule();
		// return await 使实现的异步拒绝仍落入本层 catch；直接 return Promise 则捕获范围不同。
		return await module.generateImages(model, context, options);
	} catch (error) {
		// 把捕获值变成图片错误结果；真实实现自己返回的错误对象则直接从上面的 return 透出。
		return createLazyLoadErrorImages(model, error);
	}
};

// 用途：把延迟包装器安装到全局图片表，无参数和返回值；重复调用会把同 API 当前实现重新替换成此包装器。
// 流程只有注册，没有加载 SDK 或发请求；例如扩展覆盖 openrouter-images 后再调用本函数，扩展覆盖会被取代，不同于聊天入口的只填空策略。
export function registerBuiltInImagesApiProviders(): void {
	// 无条件 set：图片注册表不检查是否已经有自定义条目。
	registerImagesApiProvider({
		// 唯一在此安装的图片 API 键。
		api: "openrouter-images",
		// 传入函数引用，不在注册时执行生成。
		generateImages: generateImagesOpenRouter,
	});
}

// 模块首次求值即安装内置项；后续导入同一模块通常复用模块求值结果。
registerBuiltInImagesApiProviders();
