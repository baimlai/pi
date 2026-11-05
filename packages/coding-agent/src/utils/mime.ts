// 通过少量文件头字节猜测受支持的图片类型，供read/@file和原生剪贴板分流；这是轻量探测，不是完整图像解码或文件安全验证。
import { open } from "node:fs/promises";

// 文件入口最多读前4100字节，后面很远的PNG动画元数据不一定落在此窗口。
const IMAGE_TYPE_SNIFF_BYTES = 4100;
// PNG固定8字节签名，十六进制字面量表示每个原始字节。
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// 输入字节返回JPEG/静态PNG/GIF/WebP/BMP的MIME或null，无I/O；例如BMP在此可识别，随后仍需转成内联支持的格式。
// 按固定顺序查签名和少量结构；GIF/WebP仅头部匹配，不证明整图可解码，PNG动画检测也只看到传入的字节范围。
export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	// JPEG先看FF D8 FF，随后排除第四字节为F7的标记；缺第四字节并不额外拒绝。
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	// PNG除签名外还检查IHDR位置，并尽力查acTL动画标记。
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	// 两种完整GIF版本签名均可识别，不在这里决定动画帧如何处理。
	if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) {
		return "image/gif";
	}
	// RIFF容器还需偏移8处WEBP，防止把普通WAV等RIFF文件当图。
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	// BMP需BM加部分DIB头约束，避免只凭两个字母误判。
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	// 没有支持的头部特征，不按文件扩展名猜测。
	return null;
}

// 输入文件路径，异步打开/读取最多4100字节探测并关闭，返回MIME或null；打开/读取/关闭失败可拒绝Promise。
// 例如一个.png后缀实际是文本仍可能返回null；finally关闭句柄，不读取整份大文件或执行内容。
export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	// r只读打开，成功后才进入try确保有可关闭句柄。
	const fileHandle = await open(filePath, "r");
	try {
		// 预分配零填充Buffer，真正检测时只传已读取部分，避免尾部零填充伪装真实数据。
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		// 从文件位置0读，解构实际bytesRead，短文件可小于4100。
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		// subarray是原Buffer视图，不另复制整段文件。
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		// 无论探测结果/异常都关闭，关闭错误也会向调用方传出。
		await fileHandle.close();
	}
}

// 输入已有PNG签名的字节，返回是否至少含长度13且名为IHDR的首块头，无I/O；不检查CRC/尺寸或完整13字节内容。
function isPng(buffer: Uint8Array): boolean {
	// &&短路先守住16字节长度，再读取首块长度与四字符类型。
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

// 输入PNG字节，顺块扫描是否在IDAT前遇acTL，返回布尔，无副作用；如遇IDAT就按静态处理，不解码压缩数据。
// 字节不足/块越界均返回false而非“已证实非动画”；文件入口只给头4100字节，因此不能推导全文件不存在动画标记。
function isAnimatedPng(buffer: Uint8Array): boolean {
	// 跳过8字节签名，从首个块长度字段开始。
	let offset = PNG_SIGNATURE.length;
	// 至少8字节才够读长度和类型，CRC/正文可能还不完整。
	while (offset + 8 <= buffer.length) {
		// PNG块长度是大端32位，不包括长度/类型/CRC自身。
		const chunkLength = readUint32BE(buffer, offset);
		// 块类型紧接4字节长度。
		const chunkTypeOffset = offset + 4;
		// 动画控制块先于图像数据时直接认定动画。
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		// 首个数据块之前没看到acTL就提前结束查找。
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		// 跨过长度4、类型4、正文chunkLength和CRC4；这里只计算偏移，不验CRC。
		const nextOffset = offset + 8 + chunkLength + 4;
		// 不前进或超过当前窗口就停止，避免用缺失块继续读。
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		// 下一轮读取下一个块。
		offset = nextOffset;
	}
	// 当前可见窗口未发现动画标记。
	return false;
}

// 检查BMP文件头和两类DIB头的局部一致性，输入字节返回布尔，无I/O；不验证像素数据/压缩方式或完整解码。
// 例如1平面24bpp可接受，planes=2拒绝；声明文件大小0被允许，且不会要求整个声明文件已读进buffer。
function isBmp(buffer: Uint8Array): boolean {
	// 先保证短DIB头相关字段可读。
	if (buffer.length < 26) return false;

	// BMP头以小端存储文件大小和像素起点。
	const declaredFileSize = readUint32LE(buffer, 2);
	// 此偏移要位于文件头+DIB头之后，不能指回头部。
	const pixelDataOffset = readUint32LE(buffer, 10);
	// DIB头大小决定下面字段位置，不通过名字推断版本。
	const dibHeaderSize = readUint32LE(buffer, 14);
	// 非0的声明大小不能比最短已检查头更小。
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	// 像素不能覆盖文件头/DIB头。
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	// 已声明大小时，像素起点必须严格位于其内。
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	// 两个分支都会赋值，TS能检查后面使用前已初始化。
	let colorPlanes: number;
	let bitsPerPixel: number;
	// 12字节旧DIB头在偏移22/24存平面和位深。
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
		// 40..124范围内都采用较新头字段位置，没有枚举所有合法头大小。
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		// 新字段到字节29，所以至少30字节。
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		// 不认识的DIB头范围不当作支持图片。
		return false;
	}

	// 要求一平面且常见位深之一，没有因此保证后端一定支持该BMP压缩格式。
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

// 从偏移读小端16位无符号数，无I/O；例如[1,2]得513，缺字节按0补，不自行验证越界。
function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

// 输入字节/偏移，返回大端32位非负数；最高字节乘2^24而非左移24，避免最高位触发JS有符号32位负数。
// 例如[0,0,1,0]为256；缺项??0只是补零，不证明文件结构完整。
function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

// 输入字节/偏移，返回小端32位非负数；最高字节同样乘2^24，其他字节左移到对应位，缺字节补0。
// 例如[0,1,0,0]为256，不修改buffer。
function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

// 比较字节签名前缀，输入数据和签名数字数组，返回布尔；先验长度再every逐项比，不读文件。
// 例如[FF,D8,FF]匹配JPEG前三字节，空签名按every规则为true。
function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	// 目标比签名短则不能匹配，避免把undefined与未读字节混淆。
	if (buffer.length < bytes.length) return false;
	// 回调得到签名字节和索引，===逐个比较实际数值。
	return bytes.every((byte, index) => buffer[index] === byte);
}

// 在给定偏移比较ASCII头文字，输入字节/偏移/文字返回布尔，无I/O；例如偏移8匹配WEBP。
// charCodeAt按UTF16取码元，当前调用只传ASCII；它不是通用Unicode文件编码识别器。
function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	// 必须容纳整段文字才继续。
	if (buffer.length < offset + text.length) return false;
	// for逐个字符比较，首个不同立即false。
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	// 全部字节一致才返回true。
	return true;
}
