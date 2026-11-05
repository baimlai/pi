// cloudflare-workers-ai-system-one分类协议的手写延迟入口；分类返回Promise结果，与聊天lazyApi的事件流错误包装不同。
// ProviderClassifier仅描述classify的模型/上下文/选项与Promise结果，不在此加载模型实现。
import type { ProviderClassifier } from "../types.ts";

/**
 * 创建分类器延迟适配对象，无输入、返回ProviderClassifier，不在工厂调用时导入实现或发网络请求。
 * 例：const api=cloudflareWorkersAISystemOneApi(); await api.classify(model,ctx,opts)在classify调用时才加载实现；构造出来的是能力对象，非分类答案。
 * 对象本身不维护加载缓存/分类结果缓存，模块复用由import宿主决定，真实请求、认证及结果策略由实现处理。
 */
// (): ProviderClassifier表示无参箭头工厂；({ ... })用圆括号返回对象字面量，不是函数体。
export const cloudflareWorkersAISystemOneApi = (): ProviderClassifier => ({
	/**
	 * 异步加载具体分类实现并转发输入，返回ClassifierResult的Promise。例：同一个api连续classify两次仍各自调用实现，不因模块已加载就复用上次答案；加载错误可由调用者catch。
	 */
	// classify参数由接口推导类型；每次调用此async方法才开始导入，返回结果Promise，不套聊天事件流。
	classify: async (model, context, options) =>
		// 先await实现模块，再调用同名classify并原样传三个参数；async会接续它的Promise，导入/实现拒绝也直接拒绝，不在此包装成聊天error事件。
		(await import("./cloudflare-workers-ai-system-one.ts")).classify(model, context, options),
});
