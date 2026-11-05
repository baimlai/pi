/**
 * 在请求分发前，用已解析的 Cloudflare account/gateway 配置填模型 baseUrl 中的占位符。
 * 例 .../{CLOUDFLARE_ACCOUNT_ID}/... 在 options.env 给 account=a 时变 .../a/...；没有该配置则保留占位文字。
 * 这里只改请求使用的模型外壳，不修改目录原对象，不查环境/认证/网络，也不负责 URL 编码或验证账户权限。
 * 聊天 wrapper 仅转发 stream/streamSimple；分类 wrapper 转发 classify，不能当作复制任意扩展能力的通用代理。
 */
// 这些契约只约束编译期：请求方法、字符串配置表与分类能力，不生成运行时校验器。
import type { ProviderClassifier, ProviderEnv, ProviderStreams } from "../types.ts";

// 和认证模块输出 env 的键同名，模板会在本地组成带花括号的搜索文字。
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

/**
 * 按 account→gateway 顺序替换 baseUrl，返回同一个模型或仅浅复制 baseUrl 的模型。
 * TModel extends {baseUrl:string} 保留额外字段类型，聊天/分类模型都可用；例无 env 或最终文字没变化时原引用返回。
 * 缺失值用原占位符，空串会替换成空；不读 process.env、不 URL 编码。replaceAll 的替代字符串仍解释 $& 等 JS 替换语法，不是任意配置串的字面插入保证。
 */
export function resolveCloudflareModel<TModel extends { baseUrl: string }>(
	// 泛型只要求基础地址字符串，其他模型字段保留，不在运行时遍历检查。
	model: TModel,
	// 已由认证/请求装配合成的提供商环境，不是宿主全部环境。
	env: ProviderEnv | undefined,
): TModel {
	// 没有环境就不分配模型副本，也不读基础地址内容。
	if (!env) return model;
	// 字符串不可变，链式替换构造新文字，不原地改 model.baseUrl。
	const baseUrl = model.baseUrl
		// 替换所有精确 account 占位文字；?? 保留空串，缺值才把占位符原样作为替代串。
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, env[CLOUDFLARE_ACCOUNT_ID] ?? `{${CLOUDFLARE_ACCOUNT_ID}}`)
		// 再对上一步结果替换 gateway，因此 account 替入文字若含此占位符也会被本步处理。
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, env[CLOUDFLARE_GATEWAY_ID] ?? `{${CLOUDFLARE_GATEWAY_ID}}`);
	// 无变化保持引用；变化时只复制外层字段，嵌套 cost/compat 等对象仍共享。
	return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

/**
 * Wrap an API implementation so Cloudflare account/gateway endpoint
 * placeholders materialize from the resolved provider env before dispatch.
 */
/**
 * 包装聊天实现：每次调用先按 options.env 生成请求模型，再原样交入 context/options，返回内层事件流。
 * 例调用包装器的 streamSimple 时，内层收到已填 account/gateway 的 baseUrl，目录中的 model 仍带原占位符。
 * 构造时不加载/请求模型；只暴露两个流入口，不转发可选 fetchDeferred/cancelDeferred，也不捕获内层同步异常。
 */
export function cloudflareStreams(streams: ProviderStreams): ProviderStreams {
	return {
		// 参数由 ProviderStreams 推导；原生参数入口先替模型，不复制上下文或选项。
		stream: (model, context, options) =>
			streams.stream(resolveCloudflareModel(model, options?.env), context, options),
		// 简化参数入口走同一占位替换，返回同一个内层流，不加另一层事件转换。
		streamSimple: (model, context, options) =>
			streams.streamSimple(resolveCloudflareModel(model, options?.env), context, options),
	};
}

/** Classifier counterpart of {@link cloudflareStreams}. */
/** 创建分类请求外观，无请求副作用；例 classify(model,ctx,{env}) 先替 account，再委托原分类器并透传其 Promise。错误/取消策略由分类器自身决定，本层不包装答案或缓存结果。 */
export function cloudflareClassifier(classifier: ProviderClassifier): ProviderClassifier {
	return {
		// 合法分类模型也满足 baseUrl 泛型要求，其他字段/上下文/参数保持原引用。
		classify: (model, context, options) =>
			classifier.classify(resolveCloudflareModel(model, options?.env), context, options),
	};
}
