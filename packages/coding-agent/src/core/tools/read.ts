// read 负责读取文本或图片，应用输出上限，并返回模型内容及程序化结果；工具循环校验参数后执行，渲染函数负责终端显示。
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

// 用运行时 schema 描述 read 参数；模型发来的 JSON 必须先经过这份规则校验。
const readSchema = Type.Object({
	// path 必须是字符串，例如 decision.txt；模型只能看到参数声明，看不到本机文件内容。
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	// 可选起始行号，从 1 开始；Type.Optional 是运行时 schema 的可选字段描述，不是执行读取动作。
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	// 可选最大行数；没传时仍受默认行数和字节上限控制。
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

// 系统提示词使用的工具摘要/建议，告诉模型怎样选 read。
export const readToolSystemPromptContribution = {
	// 给模型的单行用途说明，不代表已经读取任何文件。
	snippet: "Read file contents",
	// 建议模型优先使用受控的 read 输出格式；不是操作系统级权限限制。
	guidelines: ["Use read to examine files instead of cat or sed."],
	// 保留字面量类型，编译时看作只读；运行时对象没有被自动冻结。
} as const;

// typeof 在类型位置取得 schema 的类型，Static 再推导输入类型；类型检查与运行时校验各司其职。
export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
// 程序化返回值允许两种形状；模型实际看到的仍是工具 content 字段。
const readOutputSchema = Type.Union([
	// 文本文件对应一个普通字符串。
	Type.String(),
	// 图片返回带固定 type:image 的对象，包含 base64 数据、MIME 类型和说明文字。
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

// 由输出 schema 推导 TS 联合类型，开发时可根据 type 判断图片分支。
export type ReadToolOutput = Static<typeof readOutputSchema>;

// 供显示/日志使用的额外详情，与模型 content 分开。
export interface ReadToolDetails {
	// 有截断时保存其规则与计数；? 表示该字段可以省略。
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
// 文件读取后端契约：默认本地实现，也可由宿主替换远程实现。
export interface ReadOperations {
	/** Read file contents as a Buffer */
	// 读取原始字节而非预解码文字，便于同一工具支持图片和文本。
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	// 确认路径可读；失败以 Promise 拒绝报告，无返回正文。
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	// 可选探测器：图片返回 MIME 字符串，非图片返回空值；这是类型契约，不自动提供实现。
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

// 真正文件系统操作集中在此，测试/宿主可用 options.operations 替换。
const defaultReadOperations: ReadOperations = {
	// 默认将绝对路径交给 Node 异步 readFile，返回 Buffer。
	readFile: (path) => fsReadFile(path),
	// R_OK 检查读取权限，区别于只查存在的 F_OK。
	access: (path) => fsAccess(path, constants.R_OK),
	// 共享 MIME 探测器识别支持的图片格式。
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

// 宿主创建工具时提供的设置，不是模型调用参数。
export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	// 可选图片自动缩放开关；不传时执行器默认 true。
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	// 缺少当前模型图片元数据时使用的尺寸/编码约束。
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	// 覆盖文件操作，便于远程文件系统或确定性测试。
	operations?: ReadOperations;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
/**
 * 把模型内容块转成供程序调用者读取的结果；有图片时返回图片数据及首段文字说明，否则返回首段文字。
 * 例如文本文件得到字符串“hello”；图片得到 {type:"image", data, mimeType, note}。纯转换，不执行 I/O。
 */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	// find 只取首个文字块；找不到返回 undefined，经 ?. 与 ?? 变成空字符串。
	const text = content.find((block) => block.type === "text")?.text ?? "";
	// 按标签 type 找第一张图片，TS 可据此收窄内容块类型。
	const image = content.find((block) => block.type === "image");
	// 三元表达式选图片对象或文本结果；不会把多段文字再次合并。
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

/**
 * 根据当前模型是否接收图片生成提示；未知模型或支持图片时返回 undefined，不主动猜测模型能力。
 * 例如 model.input 只有 text 时返回“本请求将省略图片”的说明；真正省略由后续模型输入处理完成。
 */
function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	// 没有明确模型，或模型声明支持 image，就不添加非视觉警告。
	if (!model || model.input.includes("image")) {
		// 没有需要返回的提示；这与返回空字符串是不同值。
		return undefined;
	}
	// 只构造给模型/用户看的文字，真正图像过滤不在本函数。
	return "[Current model does not support images. The image will be omitted from this request.]";
}

// 工厂函数返回工具定义；创建定义不会立即读文件，执行 execute 才会。
/**
 * 输入默认 cwd 与可选操作/图片配置，返回 read 的 schema、execute 与渲染器；工厂本身不读文件。
 * 执行流程：解析路径 → 检查可读 → 图片处理或 UTF-8 解码 → offset/limit 选行 → 行数/字节截断 → 返回内容与详情。
 * 例如 {path:"a.txt",offset:2,limit:3} 读取第 2～4 行。失败会拒绝 Promise，由上层 Agent 转成错误工具结果。
 */
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
	// 当前工厂返回一个工具定义对象；对象里的 execute 保存函数供以后调用。
	return {
		// 注册名字为 read；模型输出同名 toolCall 时，Agent 才能找到这份实现。
		name: "read",
		// 工具在界面上展示的名称，与调用查找用的 name 分开保留。
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		// 接上给系统提示词的简短用途。
		promptSnippet: readToolSystemPromptContribution.snippet,
		// 浅复制指南数组，避免返回工具直接持有只读元组类型。
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		// 将参数 schema 暴露给模型及 Agent 的校验器。
		parameters: readSchema,
		// 描述给程序调用者的结构化输出：文本字符串，或图片对象。
		outputSchema: readOutputSchema,
		// 支持的供应商可优先按 schema 约束参数生成，上层仍要校验实际参数。
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		// 真正读取文件的入口。Agent 工具管线调用它，模型本身不会直接执行本地文件 API。
		/**
		 * 执行单次 read，接收已通过 Agent schema 校验的参数；读取文件但不修改文件。
		 * 取消时拒绝结果并停止后续步骤；默认 readFile 本身没有接收 AbortSignal，因此不能承诺中断已经开始的磁盘读取。
		 */
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
						// 终止当前分支；Promise 在相邻 reject 中已进入失败状态，这里不额外 resolve。
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
						// 把异步路径/读取/图片处理的异常交给下方 catch，统一释放取消监听。
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
									// 图片处理失败时返回图片类型及处理说明，不发送损坏图片数据。
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									// 只有当前模型不支持图片时才附上说明；+= 将新文字接在已有说明后。
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									// 失败图片路径只返回文字说明，content 中没有 image 块。
									content = [{ type: "text", text: textNote }];
								} else {
									// 成功后使用处理结果的 MIME，格式可能因处理发生变化。
									let textNote = `Read image file [${processed.mimeType}]`;
									// 把缩放/转换等多个提示按换行拼接，而不是把数组对象直接放进文本。
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									// 只有当前模型不支持图片时才附上说明；+= 将新文字接在已有说明后。
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									// 成功图片结果由文字说明和图片内容两块组成。
									content = [
										// 保留图片说明供模型与界面阅读。
										{ type: "text", text: textNote },
										// 加入处理完成的图片数据，交给后续供应商适配器编码发送。
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
									// 超出文件范围时抛出带总行数的明确错误，模型可据此修正 offset。
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
									// 即使只有一行也可能很大，按 UTF-8 字节计算，并格式化为 KB/MB。
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
										// 告诉模型本次展示范围和下一次 offset，支持分次读取完整大文件。
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										// 按字节上限截断时额外写明上限，避免模型误以为读到了文件末尾。
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									// 把截断详情另存，便于 UI 展示；正文仍在 content 中。
									details = { truncation };
									// 没有触及默认截断，但用户指定 limit 提前停下时，也要提示后面还有行。
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									// 用户 limit 提前停下时，计算文件后面还有多少行。
									const remaining = allLines.length - (startLine + userLimitedLines);
									// 给出下一次用户行号。例如从第 1 行读 5 行后，下次 offset=6。
									const nextOffset = startLine + userLimitedLines + 1;
									// 将正文与剩余行数/续读行号拼接，原文件没有因此被裁剪。
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
							// 捕获来自文件系统/图片处理的错误；原代码使用 any，这里只解释，不为注释任务改类型。
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
		// 合入 UI 的工具调用/结果渲染器；这部分不参与读取参数或正文。
		...readRenderers,
	};
}

// 给低层 Agent 使用的适配工厂；会话还可通过扩展包装器把 ctx 传给工具定义。
/**
 * 返回供独立低层 Agent 使用的 read 适配工具；输入 cwd/options，无 I/O 副作用。
 * 例如将 createReadTool("/project") 加到 tools；execute 被调用时才会实际读取目标。
 */
export function createReadTool(cwd: string, options?: ReadToolOptions): TypeBoxAgentTool<typeof readSchema> {
	// 先创建统一工具定义，再适配为 AgentTool；创建阶段仍不会读取文件。
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
