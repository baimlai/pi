// 所属：packages/durable/src/tools，Durable 内置的文件读取工具。
// 解决的问题：模型需要读取文本和图片，但文本可能巨大、图片格式/尺寸可能不被 provider 接受，并发写入还可能让
// 读取看到半截内容；同时结果要分三路：给模型的 output、给程序（codemode）的 structuredOutput、给 UI 的 details。
// 这里统一实现 offset/limit 行选择、截断诊断、图片格式与尺寸检查、并发变化重读和读取器关闭。
// 职责边界：只读已存在的文件，不创建/修改文件；不做图片解码或缩放（有 ImageProcessor 时委托它）；不决定
// 模型能力，只查询当前会话模型是否支持图片。错误通过抛错或 isError 结果返回，不给不存在的文件兜底内容。
// 上游：Harness ToolTask 调用 createReadTool(options)；应用通过 createCodingTools({ images }) 注入图片处理器。
// 下游：requireEnv、resolveReadToolPath、ExecutionEnv.openBinaryReader/scanLines，image.ts 的格式/尺寸检测，
// image-processor.ts 的限制与 base64 辅助，truncate.ts 的 truncateHeadOf，以及 api.agent/api.models 的模型信息。
// 能力清单（导出项）：
// - ReadToolInput：由 readSchema 推导的参数类型 { path, offset?, limit? }。
// - ReadToolDetails：结果 details；truncation 描述文本如何被截断（不含 content 本身）。
// - ReadToolOptions：可选 images 处理器。
// - createReadTool(options?)：返回 name 为 "read" 的 ToolRegistration；构造时不读文件。
// 组合与流程：execute 解析路径 → 打开 BinaryReader → 读取前后文件信息，按图片/文本分流 → 若文件未变（或文本
// 仅追加）返回；否则最多重读一次 → finally 关闭 reader。文本走 readText，图片走 readImage。
// 示例（真实签名）：
//   const read = createReadTool({ images: processor });
//   // 模型调用 read({ path: "a.ts", offset: 10, limit: 20 })：从第 10 行起读最多 20 行。
// 建议阅读顺序：先看 schema/类型，再看 createReadTool 的 execute（并发变化处理），然后 readText（行选择与截断），
// 最后 readImage/imageModel（图片限制）；readHead 是 readText 的分块读取辅助。
import type { Context } from "@earendil-works/chord/context";
import { characterEnd } from "@earendil-works/chord/output";
import { lit, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	type BinaryReader,
	type FileInfo,
	getOrThrow,
	type LineScan,
	rangeDecoder,
	startsWithBom,
} from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolDiagnostic, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHeadOf,
	utf8ByteLength,
} from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { detectSupportedImageMimeTypeOf, imageDimensions } from "./image.ts";
import {
	base64Length,
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	INLINE_IMAGE_TYPES,
	toBase64,
} from "./image-processor.ts";
import { resolveReadToolPath } from "./path-utils.ts";

// read 的运行时参数 schema：path 必填；offset/limit 可省略。offset 从 1 开始计数，但 schema 不限制正数，
// 负数/小数会在 readText 中按 Array.slice 的语义处理。open:true 接受模型多传的额外字段。
const readSchema = obj(
	{
		path: str({ description: "Path to the file to read (relative or absolute)" }),
		offset: opt(num({ description: "Line number to start reading from (1-indexed)" })),
		limit: opt(num({ description: "Maximum number of lines to read" })),
	},
	{ open: true },
);

// Static 从 schema 推导编译期参数类型；实际 JSON 校验由 Harness 在调用 execute 前完成。
export type ReadToolInput = Static<typeof readSchema>;

/**
 * What programs such as code mode scripts get: the text of a text file, or the image block of an image, which code
 * mode's `image()` shows.
 */
// 程序调用 read 时拿到的 structuredOutput：文本文件是字符串；图片是一个带 type:"image" 的对象。
// union 在运行时校验其中一种分支；lit("image") 要求该字段恰好为字符串 "image"。
const readStructuredOutputSchema = union([
	str(),
	obj({ type: lit("image"), data: str(), mimeType: str() }, { open: true }),
]);

// 给 UI 的结果详情。truncation 用 Omit<TruncationResult, "content"> 去掉正文，只保留行数/字节数等元数据。
// 这个类型没有运行时校验；字段由 readText 按分支构造。
export type ReadToolDetails = {
	/** How the shown text was cut; the text itself is the result content. */
	truncation?: Omit<TruncationResult, "content">;
};

// 分块读取的大小：64 KiB。readHead 每次读这么多，既限制单次内存，也避免过多小读。
const READ_CHUNK = 64 * 1024;

/** `Array.prototype.slice`'s conversion of an index: NaN is 0, other values truncate toward zero. */
// 复现 Array.prototype.slice 对下标的转换：NaN 变成 0，其他小数向零截断。用于让 offset/limit 的选择
// 与 allLines.slice(...) 的行为一致（包括负数 limit 的边界）。纯函数。
function sliceIndex(value: number): number {
	return Number.isNaN(value) ? 0 : Math.trunc(value);
}

/**
 * The decoded start of bytes `[start, end)` of the file, decoded as part of the whole file: all of it, or enough for
 * `truncateHeadOf` (more than `DEFAULT_MAX_BYTES + 1` bytes, or `DEFAULT_MAX_LINES` newlines).
 */
// 从已打开文件的 [start, end) 字节区间读取“开头”文本，直到足够让 truncateHeadOf 判断截断为止：
// 行数达到 DEFAULT_MAX_LINES，或 UTF-8 字节数超过 DEFAULT_MAX_BYTES + 1。多读 1 字节用于判断是否刚好越界。
// skipBom 且 start 为 0 时跳过前 3 字节（UTF-8 BOM）。stream:true 让解码器处理跨块的多字节字符，
// 最后 decoder.decode() 冲刷残留。返回解码文本；读取失败由 getOrThrow 抛 FileError。
async function readHead(
	reader: BinaryReader,
	start: number,
	end: number,
	skipBom: boolean,
	context: Context,
): Promise<string> {
	// rangeDecoder 是环境中共享的解码器工厂，保证与整文件解码的替换字符行为一致。
	const decoder = rangeDecoder();
	let text = "";
	// 只数 \n；\r\n 的 \n 也会计入，行数与按 "\n" 切分一致。
	let newlines = 0;
	// 跳 BOM 只在从文件开头读时发生；position 是下一个要读的字节偏移。
	for (let position = skipBom && start === 0 ? 3 : start; position < end; ) {
		// 每次最多读 READ_CHUNK，且不超过区间终点；read 可能返回更少（文件末尾）。
		const bytes = getOrThrow(await reader.read(position, Math.min(READ_CHUNK, end - position), context));
		// 空读表示已到文件末尾，停止。
		if (bytes.length === 0) break;
		position += bytes.length;
		// stream:true 保留可能被切断的多字节字符，等下一块补齐。
		const decoded = decoder.decode(bytes, { stream: true });
		text += decoded;
		// 逐次查找本块解码文本中的换行；index+1 保证前进，不会死循环。
		for (let index = decoded.indexOf("\n"); index !== -1; index = decoded.indexOf("\n", index + 1)) newlines++;
		// 超过阈值后不必继续读：truncateHeadOf 只需要前缀和总数，行/字节上限已由扫描得到。
		if (newlines >= DEFAULT_MAX_LINES || utf8ByteLength(text) > DEFAULT_MAX_BYTES + 1) return text;
	}
	// 冲刷解码器内部残留，得到完整文本。
	return text + decoder.decode();
}

// read 的可选配置。images 是图片处理器：提供时可用 Photon 解码、缩放、转码；省略时只放行四种内联格式且
// 必须在 DEFAULT_IMAGE_LIMITS 内。readonly 只限制编译期赋值，不冻结运行时对象。
export type ReadToolOptions = {
	/** Resizes and converts images; without one, images within `DEFAULT_IMAGE_LIMITS.maxBytes` pass through as they are. */
	readonly images?: ImageProcessor;
};

/**
 * Reads text files and images. Remarks about truncation, continuation, and image processing are diagnostics; the content
 * is only file text, or one image. Programs get the text, or the image's `ImageContent`.
 */
// 创建 read 工具注册；options 缺省为空对象，因此无图片处理器。构造时不打开文件，execute 在模型调用时运行。
// 描述文字里的图片格式列表随是否有处理器变化：只有处理器能转换 BMP。返回普通 ToolRegistration。
// 例：createReadTool() 只能原样发送四种内联图片；createReadTool({ images }) 可处理 BMP 和超大图片。
export function createReadTool(options: ReadToolOptions = {}): ToolRegistration<typeof readSchema, ReadToolDetails> {
	// 默认参数只在实参为 undefined 时生效；显式传 null 不符合类型，也不能到达这里。
	const formats = options.images === undefined ? "jpg, png, gif, webp" : "jpg, png, gif, webp, bmp";
	return defineTool({
		name: "read",
		description: `Read the contents of a file. Supports text files and images (${formats}). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		structuredOutputSchema: readStructuredOutputSchema,
		// args 已由 schema 校验；api.env 提供文件系统，context 携带取消信号。offset/limit 可缺省。
		async execute(args, api, context) {
			// 解构出路径和行选择参数；offset/limit 仍是 number | undefined。
			const { path, offset, limit } = args;
			// 没有执行环境直接失败；不会回退到宿主 Node 文件系统。
			const env = requireEnv(api);
			// read 专用路径解析会尝试常见的 Unicode/空格变体，返回首个存在的绝对路径。
			const absolutePath = await resolveReadToolPath(env, path, context);
			// 打开定位读取器；undefined 表示不禁止跟随符号链接。打开的句柄在 finally 中关闭。
			const reader = getOrThrow(await env.openBinaryReader(absolutePath, undefined, context));
			try {
				// A concurrent writer can change the file between the scan and the reads. Appending (a growing log) leaves
				// the scanned text as it was; an image must be whole. Otherwise the file is read again once.
				// attempt 从 0 开始；最多重读一次（attempt === 1 时若仍变化就报错）。
				for (let attempt = 0; ; attempt++) {
					// 读取前的文件元数据（size/mtime）用于事后比较。
					const before = getOrThrow(await reader.info(context));
					// 只读头部判断是否图片；ByteSource.read 把环境的 Result 转成异常。
					const mimeType = await detectSupportedImageMimeTypeOf({
						size: before.size,
						read: async (position, length) => getOrThrow(await reader.read(position, length, context)),
					});
					// 非图片走 readText，图片走 readImage；三目表达式的结果是同一个 ToolExecutionResult 形状。
					const result =
						mimeType === undefined
							? await readText(reader, path, offset, limit, context)
							: await readImage(
									reader,
									before,
									path,
									mimeType,
									options.images,
									await imageModel(api, context),
									context,
								);
					// 读取完成后再取一次元数据，检测读取期间是否被并发修改。
					const after = getOrThrow(await reader.info(context));
					// 大小和 mtime 都相同视为未变化；文本文件仅变长（追加日志）也可接受，因为已扫描的前缀仍有效。
					const unchanged = after.size === before.size && after.mtimeMs === before.mtimeMs;
					if (unchanged || (mimeType === undefined && after.size > before.size)) return result;
					// 第二次尝试仍变化：不返回可能不完整的内容，直接报错。
					if (attempt === 1) throw new Error(`${path} changed while it was read`);
				}
			} finally {
				// 无论成功、抛错还是取消，都关闭读取器释放句柄；close 本身也可能抛错。
				await reader.close(context);
			}
		},
	});
}

/**
 * One image block, prepared by `processor` or, without one, as it is when its format is inline and it fits the limits
 * (its size is checked before reading it, its dimensions from its header); otherwise an error result saying why. What happened to the image is an `info` diagnostic, so programs get the
 * bare `ImageContent`. A model without image input sees pi-ai's placeholder instead; a diagnostic says so.
 */
// 读取一张图片并组织为工具结果。有 processor 时把整个文件字节交给它解码/缩放/转码；没有时只允许四种内联格式，
// 且先按 base64 长度和头部声明尺寸检查限制，避免把超大图片读入内存。无法满足限制时返回 isError 结果而不是抛错。
// 参数 info 是读取前的元数据；{ vision, limits } 是解构 ImageModel 的两个字段。副作用只有 reader.read 和 processor。
// 返回 output 与 structuredOutput 都是同一个 image block；处理说明放在 diagnostics。
async function readImage(
	reader: BinaryReader,
	info: FileInfo,
	path: string,
	mimeType: string,
	processor: ImageProcessor | undefined,
	{ vision, limits }: ImageModel,
	context: Context,
): Promise<ToolExecutionResult<ReadToolDetails>> {
	// image 最终保存 base64 数据与处理后 mimeType；notes 收集给模型看的处理说明。
	let image: { readonly data: string; readonly mimeType: string };
	const notes: string[] = [];
	if (processor !== undefined) {
		// 有处理器时可以读取整个文件，由处理器负责解码、方向和尺寸调整。
		const bytes = getOrThrow(await reader.read(0, info.size, context));
		const prepared = await processor.prepare(bytes, mimeType, limits);
		// undefined 表示无法解码或无法压到限制内；这是一种工具错误结果，而不是异常。
		if (prepared === undefined)
			return imageError(`${path} is an image (${mimeType}) that cannot be prepared for the model`);
		image = prepared;
		// 处理器转换过格式时告知模型原始格式（例如 BMP → PNG）。
		if (prepared.convertedFrom !== undefined)
			notes.push(`Converted from ${prepared.convertedFrom} to ${prepared.mimeType}.`);
		if (prepared.resized !== undefined) {
			const { from, to } = prepared.resized;
			// 缩放比例用于让模型把截图坐标映射回原图；toFixed(2) 保留两位小数。
			const scale = (from.width / to.width).toFixed(2);
			notes.push(
				`Resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${scale} to map them to the original.`,
			);
		}
	} else {
		// 无处理器：provider 不能内联的格式（如 BMP）直接拒绝。
		if (!INLINE_IMAGE_TYPES.has(mimeType)) {
			return imageError(
				`${path} is an image (${mimeType}) that needs converting, and no image processor is configured`,
			);
		}
		const unshrinkable = "and no image processor is configured to shrink it";
		// 先按文件字节数换算 base64 长度检查上限，此时还没把图片读进内存。
		if (base64Length(info.size) > limits.maxBytes) {
			return imageError(
				`${path} is an image (${mimeType}) of ${formatSize(info.size)}, too large to send, ${unshrinkable}`,
			);
		}
		// 通过字节限制后才真正读取；随后从头部解析尺寸，避免解码整张图。
		const bytes = getOrThrow(await reader.read(0, info.size, context));
		const size = imageDimensions(bytes, mimeType);
		if (size === undefined) return imageError(`${path} is an image (${mimeType}) whose size cannot be read`);
		if (size.width > limits.maxWidth || size.height > limits.maxHeight) {
			return imageError(
				`${path} is an image (${mimeType}) of ${size.width}x${size.height}, larger than ${limits.maxWidth}x${limits.maxHeight}, ${unshrinkable}`,
			);
		}
		// 原样发送：转成 base64，mimeType 不变。
		image = { data: toBase64(bytes), mimeType };
	}
	// 模型不支持图片时，pi-ai 会把图片替换成占位文本；这里提前说明，避免模型误解。
	if (!vision) notes.push("The current model does not support images; it sees a placeholder instead.");
	// diagnostics 只用于告知，不改变图片数据；code "image" 便于调用方识别。
	const diagnostics: ToolDiagnostic[] = [
		{ severity: "info", code: "image", message: [`Read image file [${image.mimeType}].`, ...notes].join(" ") },
	];
	// as const 让 type 字段收窄为字面量 "image"，满足 ImageContent 类型；对象本身不被冻结。
	const block = { type: "image" as const, data: image.data, mimeType: image.mimeType };
	// output 给模型，structuredOutput 给 codemode 脚本；两者共享同一对象引用，都是不可变约定下的普通数据。
	return { output: [block], structuredOutput: block, diagnostics };
}

/** What the conversation's model takes: whether images, and within which limits. */
// 当前会话模型的图片能力快照：vision 表示输入是否包含 image，limits 是该模型允许的缩放上限。
// 这是本文件的内部类型，只在 readImage/imageModel 之间传递。
type ImageModel = { readonly vision: boolean; readonly limits: ImageLimits };

/**
 * The conversation model's image input: `DEFAULT_IMAGE_LIMITS` overridden by its `inputLimits.images.resize`. Without
 * a resolvable model, it counts as one that takes images within the defaults.
 */
// 查询当前会话使用模型的图片输入能力与尺寸限制。api.agent(context) 返回解析后的 agent，其 model 是可选的
// provider/modelId 引用；找不到模型时按“支持图片、使用默认限制”处理（乐观假设，最终由 provider 报错）。
// 只读 api.models 目录，不发请求。例：模型配置了 inputLimits.images.resize.maxWidth=1024 时覆盖默认 2000。
async function imageModel(api: ToolExecutionApi, context: Context): Promise<ImageModel> {
	// ref 是 { provider, modelId } 或 undefined；没有模型配置时无法查目录。
	const ref = (await api.agent(context)).model;
	// 目录查询是同步的；getModel 对未知模型返回 undefined。
	const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
	// 可选链逐层读取 resize 配置；任一层缺失都是 undefined。
	const resize = model?.inputLimits?.images?.resize;
	return {
		// input 是支持的输入类型数组；?? true 表示未知模型按支持图片处理。
		vision: model?.input.includes("image") ?? true,
		// 每个限制字段优先用模型配置，否则回退 DEFAULT_IMAGE_LIMITS。
		limits: {
			maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
			maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
			maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
		},
	};
}

// 构造图片相关的错误工具结果：没有模型可见输出，isError:true，错误原因放在 error 诊断里。
// 不抛异常，使调用方能把“图片不受支持”当作一次正常的工具失败处理。
function imageError(message: string): ToolExecutionResult<ReadToolDetails> {
	return { output: [], isError: true, diagnostics: [{ severity: "error", code: "unsupported_image", message }] };
}

/**
 * The read result for the opened file. It equals decoding the whole file with `TextDecoder`, splitting it on `\n`,
 * and bounding the selected lines with `truncateHead`, while reading only one scan's worth of the file plus the head.
 */
// 读取文本文件的行选择与截断结果。offset 是 1-based 起始行（可缺省），limit 是最多行数（可缺省）。
// 先调用 scanLines 一次得到总行数和所选区间字节范围，再只读该区间开头（readHead）交给 truncateHeadOf。
// 返回值含 output（模型可见文本）、structuredOutput（同文本）、可选 details（截断元数据）和 diagnostics。
// 会访问 reader；offset 超出文件时抛错，其他读取失败由 getOrThrow 抛出。例：offset=2, limit=1 只返回第二行。
async function readText(
	reader: BinaryReader,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
	context: Context,
) {
	// offset 是用户视角的 1-based 行号；转成 0-based 起点，负数按 0 处理。
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	// 展示给用户的行号仍是 1-based。
	const startLineDisplay = startLine + 1;
	// Lines are selected like `allLines.slice(startLine, endLine)`, which truncates fractional indices.
	// 复现 slice 对小数下标的截断；后续扫描使用截断后的整数。
	const sliceStart = sliceIndex(startLine);
	// One pass finds the line count and the selection; a selection past the last line ends with it, as `slice` does,
	// and an empty one (a zero or negative limit) is scanned as one line and then ignored.
	// A start beyond any file is scanned from 0 only to count lines; the offset check below then fails as before.
	// 扫描起点必须是安全整数；startLine 若大到不安全，就从 0 开始扫描只为数总行数，随后 offset 检查会失败。
	const scanStart = Number.isSafeInteger(sliceStart) ? sliceStart : 0;
	// 请求的结束行：至少扫描一行，避免 limit<=0 时 end 小于 start 导致空扫描；小数同样截断。
	const requestedEnd = limit === undefined ? undefined : Math.max(scanStart + 1, sliceIndex(startLine + limit));
	// 只有安全整数才作为扫描终点传给环境；否则交给环境按“到文件末尾”处理。
	const scanEnd = requestedEnd !== undefined && Number.isSafeInteger(requestedEnd) ? requestedEnd : undefined;
	// 局部函数封装 scanLines 的 Result → 异常转换，并省略 undefined 的 endLine（条件展开）。
	const scanOf = async (endLine: number | undefined): Promise<LineScan> =>
		getOrThrow(
			await reader.scanLines({ startLine: scanStart, ...(endLine === undefined ? {} : { endLine }) }, context),
		);
	// 第一次扫描：得到总换行数和所选区间的字节范围/首行字节数。
	let scan = await scanOf(scanEnd);
	// 总行数 = 换行数 + 1；空文件也按 1 行计（但没有内容）。
	const totalFileLines = scan.newlines + 1;
	// 起点超过总行数时报错，而不是返回空内容；offset 未提供时为 undefined。
	if (startLine >= totalFileLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
	}

	// userLimitedLines 记录“用户 limit 实际覆盖了多少行”，用于最后的续读提示。
	let userLimitedLines: number | undefined;
	// 默认选择从起点到文件末尾。
	let selectedLineCount = totalFileLines - sliceStart;
	if (limit !== undefined) {
		// 结束行不超过总行数；limit 为负时 endLine 可能小于 startLine。
		const endLine = Math.min(startLine + limit, totalFileLines);
		userLimitedLines = endLine - startLine;
		// `slice` counts a negative end from the end of the lines, which only the line count tells; scan again for it.
		// 负数 end 表示从文件末尾倒数，依赖总行数；需要重新扫描正确区间的字节范围。
		const relativeEnd = sliceIndex(endLine);
		const sliceEnd = relativeEnd < 0 ? Math.max(totalFileLines + relativeEnd, 0) : relativeEnd;
		// slice 语义下区间可能为空（limit<=0）；Math.max(0, ...) 防止负数行数。
		selectedLineCount = Math.max(0, sliceEnd - sliceStart);
		// 仅当确实选了行且 end 为负时才重新扫描；空选择不需要字节范围。
		if (selectedLineCount > 0 && relativeEnd < 0) scan = await scanOf(sliceEnd);
	}
	// empty 表示按 slice 语义没有选中任何行。
	const empty = selectedLineCount === 0;
	// Counted like `truncateHead`: a trailing newline adds no line, and empty text has none.
	// 末尾换行不算额外一行：lastLineStart === end 且区间非空，说明最后一行以换行结束。
	const endsWithNewline = !empty && scan.lastLineStart === scan.end && scan.lastLineStart > scan.start;
	// totals 是 truncateHeadOf 需要的总行数/总字节数（按所选区间计，不是整个文件）。
	const totals = {
		lines: empty || scan.selectedBytes === 0 ? 0 : selectedLineCount - (endsWithNewline ? 1 : 0),
		bytes: empty ? 0 : scan.selectedBytes,
	};
	// 读前 3 字节判断 UTF-8 BOM；startsWithBom 只比较字节，不做解码。
	const firstBytes = getOrThrow(await reader.read(0, 3, context));
	// 只读所选区间开头足够判断截断的前缀；空选择不读。
	const head = empty ? "" : await readHead(reader, scan.start, scan.end, startsWithBom(firstBytes), context);

	// content 是实际展示文本；其余字段（truncated、totalLines 等）进入 details。
	const { content: headText, ...truncation } = truncateHeadOf(head, totals);
	const diagnostics: ToolDiagnostic[] = [];
	let outputText = headText;
	let details: ReadToolDetails | undefined;
	if (truncation.firstLineExceedsLimit) {
		// Show the start of the line, cut at the byte limit on a character boundary. Like `allLines[startLine]`, a
		// fractional start line names no line.
		// 首行本身超过字节上限：只展示该行开头，并在字符边界截断，避免输出半个 UTF-8 字符。
		const integral = Number.isInteger(startLine);
		// 小数起点按 slice 语义对应“不存在的行”，因此编码空文本；?? "" 处理 split 结果为空的情况。
		const lineBytes = new TextEncoder().encode(integral ? (head.split("\n")[0] ?? "") : "");
		// 首行完整字节数来自扫描；小数起点没有对应行，按 0 报告。
		const lineSize = integral ? scan.firstLineBytes : 0;
		// characterEnd 返回不超过字节上限且不切断多字节字符的结束偏移。
		const end = characterEnd(lineBytes, DEFAULT_MAX_BYTES);
		outputText = new TextDecoder().decode(lineBytes.subarray(0, end));
		diagnostics.push({
			severity: "warn",
			code: "truncated",
			message: `Line ${startLineDisplay} is ${formatSize(lineSize)}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; showing its first ${formatSize(end)}. Use bash: sed -n '${startLineDisplay}p' ${path} | tail -c +${end + 1}`,
		});
		details = { truncation: { ...truncation, outputBytes: end, outputLines: 1 } };
	} else if (truncation.truncated) {
		// 正常截断：报告展示的行范围与下一个 offset；按行截断时不重复写字节上限。
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const limitText = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		diagnostics.push({
			severity: "info",
			code: "truncated",
			message: `Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${limitText}. Use offset=${nextOffset} to continue.`,
		});
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
		// 没触发工具截断，但用户的 limit 提前结束：提示还剩多少行以及续读 offset。
		const remaining = totalFileLines - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		diagnostics.push({
			severity: "info",
			message: `${remaining} more lines in file. Use offset=${nextOffset} to continue.`,
		});
	}

	// 空文本不产生 text block（模型看到空输出），但 structuredOutput 仍是 ""；
	// as const 收窄 type 字面量。details 只在有值时条件展开。
	return {
		output: outputText === "" ? [] : [{ type: "text" as const, text: outputText }],
		structuredOutput: outputText,
		...(details === undefined ? {} : { details }),
		diagnostics,
	};
}
