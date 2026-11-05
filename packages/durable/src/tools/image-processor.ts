// 所属：packages/durable/src/tools，read 工具的图片处理契约与编码辅助。
// 解决的问题：模型只能接收特定格式和尺寸的图片，而文件可能是 BMP、超大 PNG 或带 EXIF 方向的 JPEG。这里定义
// “处理器把原始字节变成可发送图片”的接口和默认限制，并给出不依赖具体图像库的 base64 编码/长度计算。
// 职责边界：本文件只声明接口与限制、实现 base64 辅助；真正的解码/缩放/转码由 @earendil-works/pi-durable/images
// 的 Photon 处理器或其他实现完成，本文件不读取文件、不调用模型。
// 上游：read.ts 的 readImage 使用 ImageLimits/PreparedImage/INLINE_IMAGE_TYPES；createCodingTools({ images })
// 由应用注入 ImageProcessor。下游：无外部依赖（toBase64 使用平台 btoa）。
// 能力清单：
// - ImageLimits：模型可接收的最大宽、高（像素）与 base64 字节数。
// - DEFAULT_IMAGE_LIMITS：默认 2000x2000、4.5 MiB（低于 Anthropic 的 5 MB）。
// - PreparedImage：处理后的 base64 数据、mimeType，以及可选的缩放前后尺寸和原始格式。
// - ImageProcessor：prepare(bytes, mimeType, limits) 的异步接口。
// - INLINE_IMAGE_TYPES：所有 provider 都能内联接收的四种格式。
// - toBase64(bytes)：分块把字节编码为标准 base64，避免参数过多导致栈溢出。
// - base64Length(byteLength)：不编码即可算出带补齐符的 base64 长度。
// 组合：readImage 先检查 base64 长度和图片头尺寸；有处理器时调用 prepare，否则只放行内联格式。
// 示例（真实签名）：
//   const bytes = await env.readBinaryFile(path, context);
//   const prepared = await processor.prepare(bytes, "image/bmp", DEFAULT_IMAGE_LIMITS);
// 建议阅读顺序：先看 ImageLimits/PreparedImage，再看 ImageProcessor 的契约，最后读 toBase64/base64Length。
/** Limits an image the model sees must keep; the defaults below are the coding agent's. */
export type ImageLimits = {
	// readonly 仅阻止 TypeScript 调用方直接赋值，不会在运行时冻结对象。
	/** Pixels. Default 2000. */
	readonly maxWidth: number;
	/** Pixels. Default 2000. */
	readonly maxHeight: number;
	/** Bytes of base64. Default 4.5 MiB, below Anthropic's 5 MB. */
	readonly maxBytes: number;
};

// maxBytes 衡量编码后的 base64 字节数，不是原图片文件大小。
export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };

/** An image the model can take: a supported format, within the limits, as base64. */
export type PreparedImage = {
	// data 是不带 data: 前缀的 base64；mimeType 描述处理后的格式。
	readonly data: string;
	readonly mimeType: string;
	/** Set when the image was resized: its size before and after, for the model to map coordinates back. */
	readonly resized?: {
		// ? 允许整个 resized 缺省；from/to 在它存在时都必须提供。
		readonly from: { readonly width: number; readonly height: number };
		readonly to: { readonly width: number; readonly height: number };
	};
	/** The original format, set when it differs from `mimeType`: BMP becomes PNG, a large PNG may become JPEG. */
	readonly convertedFrom?: string;
};

/**
 * Decodes, orients, resizes, and re-encodes images so the model can take them. `read` uses one when given; without
 * one, it passes supported images within the byte limit through as they are. `@earendil-works/pi-durable/images`
 * provides a Photon-based one.
 */
export type ImageProcessor = {
	/**
	 * The image, prepared to fit `limits`, or `undefined` when it cannot be decoded or made to fit. A promise, so a
	 * processor can do the work off the event loop.
	 */
	// 此处只声明接口，不实现转换或运行时校验；具体处理器负责满足限制或返回 undefined。
	prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined>;
};

/** Formats every provider takes inline; others, such as BMP, need converting. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Standard base64 of `bytes`. `btoa` takes a binary string, built 8 KiB at a time: a single `String.fromCharCode`
 * call with megabytes of arguments overflows the stack.
 */
/**
 * 将 bytes 编成标准 base64 字符串；纯内存计算，不改输入。每次处理 8192 字节以限制函数实参数量。
 * 例如 Uint8Array([65]) 返回 QQ==。btoa 接收的是每个字符代表一个字节的字符串，不是任意 Unicode 文本。
 */
export function toBase64(bytes: Uint8Array): string {
	// string[] 是字符串数组的类型；各段先保存，最后一次拼接。
	const parts: string[] = [];
	// i 是本段起点；最后一段可以少于 8192 字节。
	for (let i = 0; i < bytes.length; i += 8192) {
		// `apply` takes any array-like, though its type asks for an array.
		// subarray 不复制字节；双重 as 只调整编译期类型，运行时仍是 Uint8Array。
		parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192) as unknown as number[]));
	}
	// 先合成二进制字符串，再由平台 btoa 编码；没有文件或网络副作用。
	return btoa(parts.join(""));
}

/** The length of the base64 of `byteLength` bytes. */
/** 计算 byteLength 个字节带补齐符的 base64 长度；每三字节占四字符，例如 1 或 3 都返回 4，不编码数据。 */
export function base64Length(byteLength: number): number {
	// ceil 向上取整，包含最后不足三字节时的 = 补齐；调用方负责传入有效的字节长度。
	return Math.ceil(byteLength / 3) * 4;
}
