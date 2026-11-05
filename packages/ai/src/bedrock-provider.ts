// Bun静态打包用的Bedrock流模块对象，将真实AWS实现的两函数显式连进构建依赖图。
// 与延迟工厂不同，这个导入会加载实际实现及SDK模块，但本行不调用stream/发模型请求。
import { stream, streamSimple } from "./api/bedrock-converse-stream.ts";

// 导出可交setBedrockProviderModule的函数集合；const限制变量重绑，不把对象/函数自动冻结。
export const bedrockProviderModule = {
	// 属性简写stream:stream，保留原始选项流函数引用。
	stream,
	// 简化选项流同样只存引用，不在组对象时执行函数。
	streamSimple,
};
