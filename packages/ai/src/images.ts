// 全局图片调用入口：先安装内置图片实现，再按 model.api 从图片注册表分发；需要自动解析凭证时应由上层 Models 入口负责。
// 只有模块副作用，没有导入变量：首次求值会注册 openrouter-images，且该注册会覆盖同 API 的已有条目。
import "./providers/images/register-builtins.ts";

// 读取独立于聊天 API 注册表的图片实现。
import { getImagesApiProvider } from "./images-api-registry.ts";
// type 导入只供 TypeScript 检查，不会提供运行时校验器。
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ProviderImagesOptions } from "./types.ts";

// 用途：按图片 API 名称找实现；输入如 "openrouter-images"，返回注册对象，缺失则同步抛错。这里只查询表，不加载实现或解析认证。
function resolveImagesApiProvider(api: ImageApi) {
	// 注册表没命中时返回 undefined。
	const provider = getImagesApiProvider(api);
	// 未注册是分发错误，不伪造一个成功的图片回复。
	if (!provider) {
		// 模板字符串插入本次请求的 API 名称，便于定位缺失实现。
		throw new Error(`No API provider registered for api: ${api}`);
	}
	// 返回原注册对象引用。
	return provider;
}

/**
 * Global image generation dispatched on `model.api` through the images api
 * registry. Auth must be passed explicitly via `options.apiKey`; prefer
 * `Models.generateImages()`, which resolves provider auth.
 */
// 用途：输入图片模型、文字/图片上下文与可选请求配置，返回图片结果 Promise；例如给已注册模型传入文字 "画一个圆"。
// 流程：按 model.api 查表，再调用实现。这里不补环境密钥、不验证模型目录或能力；请求及其副作用由实现承担。
// async 会把缺少实现或调用时的同步异常转为 Promise 拒绝；实现也可能正常兑现一个 stopReason:"error" 的结果，二者不能混为一谈。
export async function generateImages(
	// 模型带有本次分发使用的 API、供应商和模型 ID；类型声明不会验证外部传入的对象。
	model: ImageModel<ImageApi>,
	// 图片生成输入，例如包含文字提示或参考图的 input 数组。
	context: ImagesContext,
	// ? 允许省略；本入口直接转交配置，包括 apiKey、取消信号和 telemetry。
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	// 依据 API 而不是 provider 名称选择全局图片实现。
	const provider = resolveImagesApiProvider(model.api);
	// 返回并采用下层 Promise 的结算结果；不额外包装错误，也不自行重试。
	return provider.generateImages(model, context, options);
}
