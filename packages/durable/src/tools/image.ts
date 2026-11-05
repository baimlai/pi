// 所属：packages/durable/src/tools，图片文件头识别与尺寸读取（不依赖图像库）。
// 解决的问题：read 在把文件交给模型前，需要知道它是不是受支持的静态图片、格式是什么、尺寸多大；对超大文件
// 不能先完整解码。这里只读文件头（PNG 还要沿 chunk 头走到首个 acTL/IDAT）来判断。
// 职责边界：只做字节级嗅探和头部尺寸解析；不解码像素、不校验图片完整性、不转换格式，也不自己打开文件
// （调用方通过 ByteSource 提供定位读取）。判断为“不受支持”时返回 undefined，而不是抛错。
// 上游：read.ts 的 execute 调用 detectSupportedImageMimeTypeOf，readImage 再调用 imageDimensions。
// 下游：无外部依赖；ByteSource 由 read.ts 用 BinaryReader 适配。
// 能力清单：
// - ByteSource：按偏移分块读取的接口，含文件总大小。
// - detectSupportedImageMimeTypeOf(source)：对整份文件做有限读取的格式检测，PNG 会区分 APNG。
// - detectSupportedImageMimeType(buffer)：对已读入内存的头部做同样检测。
// - imageDimensions(bytes, mimeType)：从头部读取声明宽高；头部不足或格式未知时返回 undefined。
// 组合：read 先用 detectSupportedImageMimeTypeOf 判断类型；是图片时再用 imageDimensions 检查尺寸限制。
// 示例（真实签名，read.ts 中的实际用法）：
//   const mime = await detectSupportedImageMimeTypeOf({ size, read: (offset, length) => reader.read(...) });
//   const dimensions = mime === undefined ? undefined : imageDimensions(bytes, mime);
// 建议阅读顺序：先看 ByteSource 与 detectSupportedImageMimeTypeOf，再看 detectSupportedImageMimeType/isPng/
// isAnimatedPng，最后读 imageDimensions 的各格式分支、isBmp 和字节读取辅助函数。

// PNG 文件固定签名；startsWith 会逐字节比较。0x0d/0x0a 是签名里的 CR/LF，不是文本换行。
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes every check except the APNG chunk walk needs: BMP reads up to offset 29. */
// 除 APNG 的 chunk 遍历外，所有格式的检测只需要前 32 字节；BMP 最远读到偏移 29。
const HEADER_BYTES = 32;
// APNG 遍历时每次最多读 64 KiB；chunk 可能比这个块大，bytesAt 会按需重新读取窗口。
const BLOCK_BYTES = 64 * 1024;

/** Positional reads of a file of `size` bytes. */
// 对已打开文件的定位读取抽象：read 返回从 offset 开始的至多 length 字节，允许少于 length（仅文件末尾）。
// read 可以是异步的（远端环境），因此检测函数返回 Promise。
export type ByteSource = {
	readonly size: number;
	read(offset: number, length: number): Promise<Uint8Array>;
};

/**
 * `detectSupportedImageMimeType` of a whole file, reading only its header and, for PNG, the chunk headers up to the
 * first `acTL` or `IDAT`.
 */
// 读取文件开头 32 字节做格式判断；返回 MIME 字符串或 undefined（不支持/损坏/APNG）。
// 副作用只有 source.read；读取失败时 Promise 会拒绝，由调用方决定如何报告。
// 例如普通 PNG 返回 "image/png"，而带 acTL chunk 的 APNG 返回 undefined。
export async function detectSupportedImageMimeTypeOf(source: ByteSource): Promise<string | undefined> {
	// 先取统一头部；对非 PNG 格式足够判断，对 PNG 还要继续走 chunk。
	const header = await source.read(0, HEADER_BYTES);
	// 不是 PNG 签名时交给内存版本处理（JPEG/GIF/WebP/BMP 都只需要头部）。
	if (!startsWith(header, PNG_SIGNATURE)) return detectSupportedImageMimeType(header);
	// PNG 还需确认 IHDR 正确，并排除动画 PNG（acTL 出现在首个 IDAT 之前）。
	return isPng(header) && !(await isAnimatedPngOf(source)) ? "image/png" : undefined;
}

/** `isAnimatedPng` over a file read in blocks. */
// 不把整份 PNG 读进内存，而是分块缓存后沿 chunk 链前进：遇到 acTL 判为动画，遇到 IDAT 说明图像数据
// 已开始且此前没有 acTL，判为静态。文件被截断或 chunk 长度异常时返回 false（交给后续读取报错）。
// 参数 source 必须与 detectSupportedImageMimeTypeOf 使用的是同一份文件内容。
async function isAnimatedPngOf(source: ByteSource): Promise<boolean> {
	// 当前缓存块及其起点；初始为空块表示尚未读取。
	let block: Uint8Array = new Uint8Array(0);
	let blockStart = 0;
	// 取指定范围字节的局部函数；范围不在缓存块内时从 offset 重新读一个 BLOCK_BYTES 窗口。
	const bytesAt = async (offset: number, length: number): Promise<Uint8Array> => {
		// 目标范围完全落在当前块内才复用；否则重新读取。
		if (offset < blockStart || offset + length > blockStart + block.length) {
			blockStart = offset;
			block = await source.read(offset, BLOCK_BYTES);
		}
		// subarray 返回共享底层 buffer 的视图，不复制；相对偏移换算成本块内位置。
		return block.subarray(offset - blockStart, offset - blockStart + length);
	};
	// PNG chunk 结构：4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC；从签名后的第一个 chunk 开始。
	let offset = PNG_SIGNATURE.length;
	// 至少要有 8 字节的 chunk 头可读；循环不是 for，因为偏移由 chunk 长度动态决定。
	while (offset + 8 <= source.size) {
		const chunkHeader = await bytesAt(offset, 8);
		// 长度是大端 32 位无符号整数，位于 chunk 头前 4 字节。
		const chunkLength = readUint32BE(chunkHeader, 0);
		// 类型位于后 4 字节；acTL（animation control）是 APNG 的标志。
		if (startsWithAscii(chunkHeader, 4, "acTL")) return true;
		// 遇到 IDAT 时动画控制 chunk 已不可能再出现，可判定静态。
		if (startsWithAscii(chunkHeader, 4, "IDAT")) return false;
		// 下一 chunk 偏移 = 当前偏移 + 头 8 字节 + 数据长度 + CRC 4 字节。
		const nextOffset = offset + 8 + chunkLength + 4;
		// 防御损坏/截断文件：偏移不前进或越界时停止，避免死循环或越界读。
		if (nextOffset <= offset || nextOffset > source.size) return false;
		offset = nextOffset;
	}
	return false;
}

// 对内存中的字节（通常只是文件头）判断受支持的静态图片格式，返回 MIME 字符串或 undefined。
// 这里的 buffer 必须包含足够的头部；调用方不能只传任意短前缀还期望 BMP/WebP 被识别。
// 纯函数，不修改 buffer，也不抛错；各行按格式签名依次判断，命中即返回。
export function detectSupportedImageMimeType(buffer: Uint8Array): string | undefined {
	// JPEG：FF D8 FF 是 SOI + 标记前缀；0xF7 对应 JPEG-LS，provider 通常不接受，因此排除。
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
	// PNG：确认 IHDR 且不是 APNG；APNG 是动画，不能作为单张图片发送。
	if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : undefined;
	// GIF 有两个版本签名，均接受。
	if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) return "image/gif";
	// WebP 是 RIFF 容器：偏移 0 为 "RIFF"，偏移 8 为 "WEBP"。
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
	// BMP 只有 "BM" 太弱，还要通过 isBmp 校验 DIB 头字段。
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
	// 其他签名（含 HEIC/AVIF 等）不属于这四种内联格式，返回 undefined。
	return undefined;
}

// 校验 PNG 的 IHDR：偏移 8 的 chunk 长度必须为 13，偏移 12 的类型必须是 "IHDR"。
// 长度 13 是 PNG 规范中 IHDR 的固定数据长度；这是完整性嗅探，不是 CRC 校验。
function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

// 内存版本的 APNG 检测：与 isAnimatedPngOf 逻辑相同，但 buffer 必须已经包含要检查的 chunk。
// 只用于 detectSupportedImageMimeType 的头部缓冲区；若 acTL 在头部之外，这里会误判为静态。
function isAnimatedPng(buffer: Uint8Array): boolean {
	// 从签名后第一个 chunk 开始；chunk 头由长度+类型组成。
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		// chunk 数据长度（大端 32 位），类型从 offset + 4 开始。
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		// acTL 表示动画控制 chunk，出现在 IDAT 之前即 APNG。
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		// 首个 IDAT 之后不再可能有 acTL，判为静态。
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
		// 跳到下一 chunk；长度异常或越界时停止并判为静态，避免无限循环。
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

/**
 * The width and height an image of `mimeType` declares in its header, without decoding it: PNG's IHDR, GIF's screen,
 * WebP's VP8, VP8L, or VP8X chunk, JPEG's first SOF segment. `undefined` when the header cannot be read.
 */
// 从头部解析声明宽高；返回只读对象或 undefined。不验证实际像素数据，也不处理 EXIF 旋转。
// 参数 bytes 必须从文件开头连续读取且包含相应头部；长度不足时按 undefined 处理，不抛错。
// 示例：imageDimensions(pngHeader, "image/png") → { width: 100, height: 50 }。
export function imageDimensions(
	bytes: Uint8Array,
	mimeType: string,
): { readonly width: number; readonly height: number } | undefined {
	// switch 按 MIME 字符串分支；TypeScript 不会用字面量收窄外部字符串，但运行时比较是真实存在的。
	switch (mimeType) {
		case "image/png":
			// IHDR 数据从偏移 16 开始：宽 4 字节、高 4 字节，均为大端；至少需要 24 字节。
			return bytes.length < 24 ? undefined : { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
		case "image/gif":
			// GIF 逻辑屏幕宽高位于偏移 6/8，小端 16 位；至少需要 10 字节。
			return bytes.length < 10 ? undefined : { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
		case "image/webp":
			// WebP 的各种变体至少需要 30 字节才能读到尺寸字段。
			if (bytes.length < 30) return undefined;
			// 有损 WebP：VP8 帧头中的宽高各 14 位，需要屏蔽掉高 2 位（缩放/版本标志）。
			if (startsWithAscii(bytes, 12, "VP8 "))
				return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
			// 无损 WebP：21 字节处的 32 位小端值含宽 14 位、高 14 位，存储的是“尺寸减 1”。
			if (startsWithAscii(bytes, 12, "VP8L")) {
				const bits = readUint32LE(bytes, 21);
				return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
			}
			// 扩展 WebP：24 字节处 24 位小端宽、27 字节处 24 位小端高，同样存储减 1 的值。
			if (startsWithAscii(bytes, 12, "VP8X")) {
				// 局部函数把 3 个小端字节拼成 24 位整数；?? 0 处理读取越界的理论情况。
				const uint24 = (offset: number): number => readUint16LE(bytes, offset) + ((bytes[offset + 2] ?? 0) << 16);
				return { width: uint24(24) + 1, height: uint24(27) + 1 };
			}
			return undefined;
		case "image/jpeg":
			// JPEG 是一条段链：每段以 FF + marker 开头，长度字段包含长度本身但不含 marker。
			for (let offset = 2; offset + 9 <= bytes.length; ) {
				// 每个段必须从 FF 开始；否则头部不可信。
				if (bytes[offset] !== 0xff) return undefined;
				// ! 是 TS 非空断言：循环条件已保证 offset+1 在范围内，运行时不增加检查。
				const marker = bytes[offset + 1]!;
				// FF 可能是填充字节，跳过后继续找真正的 marker。
				if (marker === 0xff) {
					offset++;
					continue;
				}
				// SOF0 到 SOF15 中，C4(DHT)、C8(JPG)、CC(DAC) 不是帧头，需要排除。
				// SOF0 to SOF15, except DHT (C4), JPG (C8), and DAC (CC), which share the range.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					// SOF 段中：长度 2 字节、精度 1 字节、高 2 字节、宽 2 字节，因此宽在 offset+7、高在 offset+5。
					return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) };
				}
				// 跳过当前段：2 字节 marker + 长度字段声明的字节数。
				offset += 2 + readUint16BE(bytes, offset + 2);
			}
			return undefined;
		default:
			// 未知格式没有统一的尺寸字段。
			return undefined;
	}
}

// 校验 BMP 的 DIB 头，降低仅凭 "BM" 误判的概率：文件大小、像素数据偏移、DIB 头长度、平面数和位深都要自洽。
// 只读头部，不检查像素数据；返回 true 表示“看起来是受支持的 BMP”，不保证能解码。
function isBmp(buffer: Uint8Array): boolean {
	// 最小头部需要读到偏移 26-29 的平面数/位深。
	if (buffer.length < 26) return false;
	// BMP 文件头：偏移 2 为文件大小（可为 0 表示未知），偏移 10 为像素数据偏移，偏移 14 为 DIB 头长度。
	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	// 声明大小必须能容纳最小文件；像素数据不能与头部重叠，也不能越过声明大小。
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	// 平面数和位深的位置随 DIB 头版本不同：12 字节的 OS/2 头与 40-124 字节的 Windows 头。
	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		// Windows DIB 头至少 40 字节；平面数在偏移 26、位深在偏移 28。
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}
	// 只接受单平面和常见位深；这是 provider 能处理的子集，不代表 BMP 规范的全部。
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

// 小端 16 位读取：低字节在前。?? 0 让越界读取得到 0，而不是把 undefined 参与运算得到 NaN。
function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

// 大端 16 位读取：高字节在前，常用于 PNG/JPEG 网络字节序。
function readUint16BE(buffer: Uint8Array, offset: number): number {
	return ((buffer[offset] ?? 0) << 8) + (buffer[offset + 1] ?? 0);
}

// 大端 32 位读取。最高字节用乘法而不是 << 24，避免结果被当成有符号 32 位整数。
function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

// 小端 32 位读取；最低字节在 offset。
function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

// 判断 buffer 是否以给定字节序列开头；长度不足时直接 false，every 逐项比较。
function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

// 判断 buffer 从 offset 开始是否为给定 ASCII 文本（chunk 类型、RIFF/WEBP、GIF 签名等）。
// charCodeAt 返回 UTF-16 码元；调用方只传 ASCII，超过 0x7F 的比较会自然失败，不做编码转换。
function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	// 先检查剩余长度，避免逐字符时越界。
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
