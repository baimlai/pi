// OpenRouter专用图片生成的手写延迟入口；将实现加载推迟到generateImages调用，模块缓存交给运行宿主。
// ProviderImages只作类型，约束专用ImageModel、图片上下文及Promise结果，不等同聊天模型支持图片输入。
import type { ProviderImages } from "../types.ts";

/**
 * 创建OpenRouter图片生成的延迟能力对象，无参数，构造时不导入具体协议或发请求。
 * 例：const api=openrouterImagesApi(); await api.generateImages(model,ctx,opts)才加载并调用图片实现。这里不提供stream/streamSimple，也不缓存图片结果。
 */
// 圆括号内对象是无参箭头函数的返回值，工厂只构造一个能力对象。
export const openrouterImagesApi = (): ProviderImages => ({
	/**
	 * 加载图片实现后原样转发三项输入，返回AssistantImages的Promise；例：实现若拒绝，调用者catch即可，没有lazyStream那种聊天error事件包装。
	 */
	// 参数类型由ProviderImages推导；async在方法调用时执行导入，不等待调用者await结果才启动。
	generateImages: async (model, context, options) =>
		// await模块后转交model/context/options；返回实现的图片结果Promise，导入或实现错误直接使此Promise拒绝。
		(await import("./openrouter-images.ts")).generateImages(model, context, options),
});
