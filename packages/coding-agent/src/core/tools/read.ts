import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { readRenderers } from "./renderers/read.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

// 中文工具边界：用运行时 schema 描述 read 参数；模型发来的 JSON 必须先经过这份规则校验。
const readSchema = Type.Object({
	// path 必须是字符串，例如 decision.txt；模型只能看到参数声明，看不到本机文件内容。
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

// typeof 在类型位置取得 schema 的类型，Static 再推导输入类型；类型检查与运行时校验各司其职。
export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

// 中文具体工具：工厂函数返回工具定义；创建定义不会立即读文件，执行 execute 才会。
export function createReadToolDefinition(
	// 工具默认工作目录，例 /project；相对路径 decision.txt 会据此解析。
	cwd: string,
	// 可选配置，例如替换为远程文件操作，或限制图片尺寸。
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	// 图片默认自动调整大小；?? 使显式 false 保持为 false。
	const autoResizeImages = options?.autoResizeImages ?? true;
	// 保存没有模型尺寸元数据时使用的图片配置。
	const fallbackResizeOptions = options?.resizeOptions;
	// 默认操作是真实文件系统 readFile/access；也允许调用者换成 SSH 等实现。
	const ops = options?.operations ?? defaultReadOperations;
	return {
		// 注册名字为 read；模型输出同名 toolCall 时，Agent 才能找到这份实现。
		name: "read",
		// 工具在界面上展示的名称，与调用查找用的 name 分开保留。
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		// 将参数 schema 暴露给模型及 Agent 的校验器。
		parameters: readSchema,
		// 描述给程序调用者的结构化输出：文本字符串，或图片对象。
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		// 真正读取文件的入口。Agent 工具管线调用它，模型本身不会直接执行本地文件 API。
		async execute(
			// 本次调用 id；下划线表示这个实现暂时不用该参数。
			_toolCallId,
			// 参数对象解构加类型声明。例如 {path:"a.txt", offset:11, limit:5} 表示从第 11 行读 5 行。
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			// 可选取消信号，由用户取消 query 一路传到这里。
			signal?: AbortSignal,
			// read 通常一次返回结果，不在这里报告中间进度；保留统一工具签名的位置。
			_onUpdate?,
			// 执行上下文，可提供当前工作目录/模型等信息。
			ctx?: ExtensionContext,
		) {
			// 返回异步工具结果：content 给模型看，details 存截断等额外信息；泛型只描述返回值形状。
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				// Promise 的两个出口：resolve 返回成功值，reject 传播失败。
				(resolve, reject) => {
					// 执行前用户已取消则立即失败，不再开始文件读取。
					if (signal?.aborted) {
						// 以取消错误结束 Promise；Agent 会把工具异常转换成失败 toolResult。
						reject(new Error("Operation aborted"));
						return;
					}
					// 执行中取消后记下状态，避免异步读取完成时再发布成功结果。
					let aborted = false;
					// 注册取消时要执行的回调，定义这个函数本身不会触发取消。
					const onAbort = () => {
						// 让后续 await 返回后可以看出工具已经被取消。
						aborted = true;
						// 以取消错误结束 Promise；Agent 会把工具异常转换成失败 toolResult。
						reject(new Error("Operation aborted"));
					};
					// 监听一次取消事件；文件读取本身未传信号，这里主要阻止取消后返回成功。
					signal?.addEventListener("abort", onAbort, { once: true });

					// 立即执行一个异步函数，以便在 Promise 的同步构造回调内使用 await。
					(async () => {
						try {
							// 将模型给的相对路径变成绝对路径；优先用执行上下文 cwd，否则用工厂参数 cwd。
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							// 若等待期间已取消，停止后续处理；取消回调已经 reject 了外层 Promise。
							if (aborted) return;
							// Check if file exists and is readable.
							// 先确认文件存在且可读，失败时进入 catch。
							await ops.access(absolutePath);
							// 若等待期间已取消，停止后续处理；取消回调已经 reject 了外层 Promise。
							if (aborted) return;
							// 检测是否为支持的图片；普通文本会走下面的文本分支。
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							// 声明模型可见内容数组，可以混合文字块和图片块。
							let content: (TextContent | ImageContent)[];
							// 声明额外详情；没截断时可以没有 details。
							let details: ReadToolDetails | undefined;
							// 模型不支持图片时准备说明文字；纯文本示例不依赖这个分支。
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							// 识别为图片时走图片处理路径，不能按 UTF-8 当作文本解码。
							if (mimeType) {
								// Read image as binary.
								// 真正从文件系统读取字节；Buffer 是原始字节，之后再按图片或文字解释。
								const buffer = await ops.readFile(absolutePath);
								// 按模型输入限制处理图片，例如调整尺寸和编码。
								const processed = await processImage(buffer, mimeType, {
									// 对象字段简写，使用之前确定的自动缩放开关。
									autoResizeImages,
									// 优先采用当前模型的图片约束，缺失才用工具配置的兜底值。
									resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
								});
								// 处理图片失败时返回可读说明，而不是把坏图片强行送给模型。
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								// 真正从文件系统读取字节；Buffer 是原始字节，之后再按图片或文字解释。
								const buffer = await ops.readFile(absolutePath);
								// 文本路径：把文件字节按 UTF-8 解码。例如字节变成“决定：使用 TypeScript”。
								const textContent = buffer.toString("utf-8");
								// 按换行拆成数组；例如两行文字会变成两个数组元素。
								const allLines = textContent.split("\n");
								// 记录文件总行数，生成截断提示时告诉模型还剩多少行。
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								// 用户行号从 1 开始，数组从 0 开始；例如 offset=11 对应下标 10。
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								// 展示给模型时再转回从 1 开始的行号。
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								// 起始行超出文件范围就报错，避免返回看似成功的空内容。
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								// 保存先按 offset/limit 选出来的文字，之后还要应用默认输出上限。
								let selectedContent: string;
								// 记录用户 limit 实际选了多少行；未指定 limit 时保持 undefined。
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								// 用户显式给 limit 时先尊重它；不能用真假值判断代替“是否提供”。
								if (limit !== undefined) {
									// 结束位置不能超过文件总行数；slice 的结束下标不包含在结果内。
									const endLine = Math.min(startLine + limit, allLines.length);
									// slice 取指定行，再用换行拼回文字。例如 offset=2、limit=2 取第 2、3 行。
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									// 计算这次实际选中的行数，后面判断是否还有内容可继续读。
									userLimitedLines = endLine - startLine;
								} else {
									// 没有 limit 时先取到末尾，下面的默认输出上限仍会限制返回长度。
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								// 工具输出截断：控制行数/字节数。这与调用模型总结整个对话的上下文压缩是两件不同的事。
								const truncation = truncateHead(selectedContent);
								// 准备最终给模型的文字，可能附“用 offset 继续读取”的说明。
								let outputText: string;
								// 连第一行都超过字节上限时不能按正常行数返回，给模型其他读取方法提示。
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									// 把截断详情另存，便于 UI 展示；正文仍在 content 中。
									details = { truncation };
									// 内容超过默认行数或字节限制，只返回允许的前半段并说明如何续读。
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									// 算出本次最后展示的实际行号。
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									// 下一次读取从本次最后一行的下一行开始，避免重复。
									const nextOffset = endLineDisplay + 1;
									// 采用截断器生成的正文；后面可能继续追加说明文字。
									outputText = truncation.content;
									// 按行数上限截断与按字节上限截断使用不同提示，方便模型判断读取方式。
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									// 把截断详情另存，便于 UI 展示；正文仍在 content 中。
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									// 用户 limit 提前停下时，计算文件后面还有多少行。
									const remaining = allLines.length - (startLine + userLimitedLines);
									// 给出下一次用户行号。例如从第 1 行读 5 行后，下次 offset=6。
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									// 采用截断器生成的正文；后面可能继续追加说明文字。
									outputText = truncation.content;
								}
								// 将最终文字包装成模型统一内容块；不会直接把 Buffer 交给模型。
								content = [{ type: "text", text: outputText }];
							}

							// 若等待期间已取消，停止后续处理；取消回调已经 reject 了外层 Promise。
							if (aborted) return;
							// 成功或失败后移除取消监听，避免工具结束后仍持有回调。
							signal?.removeEventListener("abort", onAbort);
							// 返回工具执行结果；Agent 随后运行后置钩子，并包装成 toolResult 消息。
							resolve({ content, details });
						} catch (error: any) {
							// 成功或失败后移除取消监听，避免工具结束后仍持有回调。
							signal?.removeEventListener("abort", onAbort);
							// 正常错误传播出去；已经因取消 reject 的 Promise 不必再次处理同一结果。
							if (!aborted) reject(error);
						}
					})();
				},
				// 读取完成后附上给程序调用者用的结构化输出；模型可见文字仍在 content 中。
			).then((result) => ({ ...result, structuredContent: toReadOutput(result.content) }));
		},
		...readRenderers,
	};
}

// 给低层 Agent 使用的适配工厂；会话还可通过扩展包装器把 ctx 传给工具定义。
export function createReadTool(cwd: string, options?: ReadToolOptions): TypeBoxAgentTool<typeof readSchema> {
	// 先创建统一工具定义，再适配为 AgentTool；创建阶段仍不会读取文件。
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
