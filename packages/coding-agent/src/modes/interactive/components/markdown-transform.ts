// 为用户/助手 Markdown 连接扩展显示转换链；只返回展示文字，不修改原消息或模型上下文。
// type 导入提供上下文/回调签名，执行时擦除，不会在这里注册扩展。
import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";

/** Applies extension Markdown transformers. `isStreaming` is read per transform, so a reused component sees a stream end. */
// 创建适配 Markdown 渲染器的闭包，输入消息种类、流式状态读取器、转换列表和可选条目信息。
// 返回接收正文/可用列宽的同步函数；例流结束后同一组件再渲染，会通过 isStreaming() 看到 false。
// 创建时不执行转换器；调用时的 isStreaming 回调若抛错会传播，单个转换器异常则由下层忽略。
export function createMarkdownTransform(
	// 索引访问类型复用 user/assistant/assistant-thinking 联合，避免另写一套类型。
	messageType: MarkdownTransformContext["messageType"],
	// 传函数而非固定 boolean，每次真正转换时读取最新状态。
	isStreaming: () => boolean,
	// 只读数组类型防本函数通过该类型增删列表，不复制/冻结调用方原数组。
	transformers: readonly MarkdownTransformer[],
	// 持久化条目 ID 可省略，实时消息常没有。
	messageId?: string,
	// 可选条目时间戳，只透传，不解析日期或补当前时间。
	timestamp?: string,
	// 返回类型是函数：接字符串和可用显示列数，返回新显示字符串。
): (markdown: string, availableWidth: number) => string {
	// 箭头闭包保留创建时的消息身份与列表引用，正文/列宽则由每次 render 提供。
	return (markdown, availableWidth) =>
		// 把这次正文和完整上下文交给顺序执行器。
		applyMarkdownTransformers(
			// 本次待展示的原 Markdown，不在此改写原消息对象。
			markdown,
			// 属性简写与显式属性混用；isStreaming() 现在才执行，因此不会卡在构造时的流式状态。
			{ messageType, isStreaming: isStreaming(), availableWidth, messageId, timestamp },
			// 沿用同一转换器列表；列表内容被外部修改时，未来调用可观察到变化。
			transformers,
		);
}

// 依次把上一个转换结果交给下一个，返回最终显示文字；例 A 加前缀后 B 可继续处理带前缀的文字。
// 单个回调同步抛错或返回非字符串时保留已有结果继续；这些回调仍可能自行产生副作用，本函数不回滚。
function applyMarkdownTransformers(
	// 转换链的初始正文。
	markdown: string,
	// 同一上下文对象交给本次所有转换器，不为每个回调复制。
	context: MarkdownTransformContext,
	// 只读数组类型防本函数通过该类型增删列表，不复制/冻结调用方原数组。
	transformers: readonly MarkdownTransformer[],
): string {
	// let 保存当前累计结果，后续有效字符串可以替换它。
	let transformedMarkdown = markdown;
	// 按数组迭代顺序逐个调用；没有并发、await 或自动异步等待。
	for (const transformer of transformers) {
		// 对每个回调单独捕获，某个失败不会阻止后面的转换器。
		try {
			// 同步执行扩展，以最新累计文字和共享上下文为输入。
			const transformed = transformer(transformedMarkdown, context);
			// 扩展返回值的运行时边界：只有真实字符串才采用；Promise 等对象不会被等待。
			if (typeof transformed === "string") {
				// 采用此字符串，即使它是空串也有效，可让消息不显示正文。
				transformedMarkdown = transformed;
			}
			// 忽略该扩展的同步异常；不在此打印错误或恢复它自身的副作用。
		} catch {
			// Keep the current Markdown and continue with the next transformer.
		}
	}
	// 返回最后一个有效结果；列表为空或全失败就返回原 Markdown。
	return transformedMarkdown;
}
