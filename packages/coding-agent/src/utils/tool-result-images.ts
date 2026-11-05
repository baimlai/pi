// 工具结果进入历史前处理其中图片，防止后续每轮重放超大载荷；失败时保留原图片，不能把它当必定过滤坏图的安全关卡。
import type { ImageContent, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";

// 联合类型只允许文字/图片块，具体role:toolResult消息包装由会话层完成。
export type ToolResultContent = TextContent | ImageContent;

// 与统一图片管线对齐的可选偏好，模型限制由调用方传入，不在这里查模型目录。
export interface NormalizeToolResultImagesOptions {
	/** Whether oversized images are resized to inline provider limits. Default: true */
	// false仍会尝试把非内联格式转PNG，但不限制原支持格式的尺寸/体积。
	autoResizeImages?: boolean;
	/** Model-specific resize profile. Uses the conservative built-in defaults when omitted. */
	// 兼容ImageResizeOptions字段的模型特定限制，省略用缩放核心默认。
	resizeOptions?: ModelImageResizeOptions;
}

/**
 * Normalize image blocks returned by tool results.
 *
 * The `read` tool and `@file` CLI attachments run their images through `processImage`, but tools
 * that produce images themselves (extensions, MCP bridges, screenshot tools) hand back arbitrary
 * base64 payloads that go straight into session history and every subsequent provider request.
 * Oversized images make the provider reject the whole conversation, not just the offending turn,
 * so normalize them once as they enter history.
 *
 * Returns the original array when nothing changed so callers can skip rewriting the result.
 */
// 输入内容数组及可选限制，顺序处理图片后返回新数组或原数组；不改原块/数组，未变更时用引用相等通知上层无需重写。
// 例如大图成功缩小后输出“新image+提示text”，前后文字顺序保留；处理结果ok:false则保留原图，依赖异常仍可拒绝Promise。
export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	// 无图片直接返回同一数组，避免加载WASM或创建替代内容。
	if (!content.some((block) => block.type === "image")) {
		return content;
	}

	// nullish回退保留显式false。
	const autoResizeImages = options?.autoResizeImages ?? true;
	// 暂建新结果，最后若没有变化会丢弃它并返回content。
	const normalized: ToolResultContent[] = [];
	// 至少一张成功处理且文字/MIME/hints发生变化时才设true。
	let changed = false;

	// for...of内await表示图片逐张处理，保持输出块顺序，不并发占用多个缩放线程。
	for (const block of content) {
		// type字段收窄：非图片原对象直接保留。
		if (block.type !== "image") {
			normalized.push(block);
			continue;
		}

		// base64解码成字节后交统一格式/缩放处理，不从图片名称猜类型。
		const processed = await processImage(Buffer.from(block.data, "base64"), block.mimeType, {
			autoResizeImages,
			resizeOptions: options?.resizeOptions,
		});
		// 工具已产出图片，正常后端失败走保留策略，与read/@file省略图片的策略不同。
		if (!processed.ok) {
			// Unlike `read`, keep the original block. The tool already produced this image and the
			// failure may just be an unavailable image backend, so passing it through preserves the
			// behavior tools have today instead of silently deleting their output.
			normalized.push(block);
			continue;
		}

		// 三项都没变化才复用原块；仅尺寸提示也会使整份结果需要更新。
		if (processed.data === block.data && processed.mimeType === block.mimeType && processed.hints.length === 0) {
			normalized.push(block);
			continue;
		}

		// 成功替换仅构造标准图片字段，不把原块其他额外属性整体展开过去。
		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		// 可选说明紧跟这张图片，而非移到整个工具结果末尾。
		if (processed.hints.length > 0) {
			normalized.push({ type: "text", text: processed.hints.join("\n") });
		}
		// 标记至少有一块改变，后续即使其他图片原样通过仍返回新数组。
		changed = true;
	}

	// 三元分支保留未变时数组身份，供会话层判断是否需要替换结果。
	return changed ? normalized : content;
}
