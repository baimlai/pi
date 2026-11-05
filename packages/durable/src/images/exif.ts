// 所属：packages/durable/src/images，Durable 图片处理器在解码前读取 EXIF 方向的工具。
// 解决的问题：手机等设备拍出的 JPEG/WebP 常带 EXIF Orientation（1..8），文件里的像素排列本身没有旋正；
// 若直接送给模型，宽高和内容方向可能不对。本文件只从原始字节定位这个数值，不做像素解码。
// 职责边界：支持 JPEG 的 APP1 Exif 段和 WebP 的 EXIF RIFF 块；不验证完整 JPEG/WebP/TIFF 结构，不检查 EXIF
// 字段类型与计数，也不处理 XMP 或 PNG 等其他格式。任何“找不到、越界、值不合法”都返回 1（正常方向）。
// 上游：./index.ts 的 prepare() 在解码（PhotonImage.new_from_byteslice）之前调用，选定方向后再解码/旋正；
// 下游：没有外部依赖，只读取调用方传入的 Uint8Array，不修改它。
// 能力清单：
// - exifOrientation(bytes)：导出的唯一函数，返回 1..8 的方向值。
// - tiffStart(bytes)：内部辅助，按容器格式定位 TIFF 头，找不到返回 -1。
// - isExifHeader(bytes, offset)：内部辅助，判断六个字节的 Exif NUL NUL 标识。
// - ascii(bytes, offset, text)：内部辅助，比较固定 ASCII 标识。
// 组合：exifOrientation → tiffStart → isExifHeader/ascii；方向值随后由 index.ts 的 prepare 解释：
// 1 原样、2/3/4 用翻转、5..8 用像素转置。
// 示例（真实签名，示例值）：exifOrientation(bytes) 对带 Orientation=6 的 JPEG 返回 6；
// 对普通 PNG 或方向 9 返回 1。函数不抛错，也不证明返回 1 的容器一定合法。
// 建议阅读顺序：先读 exifOrientation 的主流程，再看 tiffStart 如何定位 TIFF 头，最后看 isExifHeader/ascii
// 的字节比较细节。
// EXIF orientation of JPEG and WebP files, read from the bytes without decoding the image.

// 函数说明：exifOrientation 输入任意字节数组（JPEG、WebP 或其他内容都可），返回 EXIF Orientation 的 1..8；
// 没有可读方向时返回 1。没有副作用，不修改 bytes，不抛异常；所有错误都以“返回 1”收敛。
// 主流程：定位 TIFF 头 → 选字节序 → 读 IFD0 偏移与目录项数量 → 逐项找 tag 0x0112 → 校验 1..8。
// 示例：exifOrientation(jpegWithOrientation6) 得到 6；exifOrientation(new Uint8Array([0xff, 0xd8])) 得到 1。
// 这与“图片已被旋正”无关：返回 6 只表示调用方还需要执行对应的转置。
/** The EXIF orientation of a JPEG or WebP, 1 to 8; 1 when absent or unreadable. */
/** 从不可信图片字节中提取 EXIF 方向，返回 1..8；找不到、越界或方向值不合法时退回 1。
 * 不解码像素、不修改输入，也不验证完整 JPEG/WebP/TIFF 格式；例如合法方向 6 表示需要转置后旋正。
 * Uint8Array 的类型只保证字节数组接口，不能保证文件内容，因此以下边界判断发生在运行时。 */
export function exifOrientation(bytes: Uint8Array): number {
	// 先定位 TIFF 头；-1 表示未找到，头部至少需要八字节才能读首个目录偏移。
	// tiff 的类型是 number；-1 是内部约定的哨兵值，不是合法的字节下标。
	const tiff = tiffStart(bytes);
	// 短路求值：tiff < 0 时不会计算后面的越界表达式；头部不足 8 字节时没有字节序和目录偏移可读。
	if (tiff < 0 || tiff + 8 > bytes.length) return 1;
	// II 表示小端序；其他头按大端序读取，这里没有完整 TIFF 魔数检查。
	// 0x49 是 ASCII 的 'I'；两个 II 构成 TIFF 的小端标记，MM（0x4d 0x4d）则走下面的 else 分支。
	const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
	// 两个局部箭头函数按已选字节序组装整数；! 仅取消 TS 的 undefined 提示，不添加运行时检查。
	// 当前根 tsconfig 没有启用 noUncheckedIndexedAccess，Uint8Array 下标本身已推断为 number，因此 ! 主要是
	// 在更严格的索引检查配置下也保持可编译；若下标越界，运行时仍会读成 undefined 并参与位运算。
	// (at: number): number 是箭头函数的参数与返回类型注解；函数体只有一个表达式，省略 return 与花括号。
	const u16 = (at: number): number =>
		little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
	const u32 = (at: number): number =>
		// 位运算先产生有符号 32 位整数，>>> 0 再转成无符号数。
		little
			? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
			: ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
	// TIFF 目录偏移相对 TIFF 头；至少要容得下目录项数量这一 u16。
	// u32(tiff + 4) 读出 IFD0 的相对偏移；它可能极大，因此紧接着做长度检查而不是直接信任。
	const directory = tiff + u32(tiff + 4);
	if (directory + 2 > bytes.length) return 1;
	// 目录开头两字节是目录项数量；类型仍是普通 number，后续循环自己做边界判断。
	const entries = u16(directory);
	// 每项固定十二字节；只逐项寻找 Orientation，不构建整个 EXIF 对象。
	// index++ 只在循环末尾自增；entries 来自文件，可能为 0 或很大，循环体里会按字节长度提前返回。
	for (let index = 0; index < entries; index++) {
		const entry = directory + 2 + index * 12;
		// 文件字节不足完整目录项时停止并采用默认方向。
		// entry + 12 是下一项起点；这里不做 32 位溢出检查，极端偏移会因比较为 true 而返回 1。
		if (entry + 12 > bytes.length) return 1;
		// Tag 0x0112 is Orientation, a SHORT whose value sits in the entry.
		// 标签号本身也按文件字节序读取；0x0112 是 EXIF 规范里的 Orientation 标签。
		if (u16(entry) === 0x0112) {
			// 本实现读取内联值位置，不继续验证字段类型和计数；范围外视为未知方向。
			// TIFF 目录项的第 8..11 字节是 value/offset 字段；SHORT 方向值就放在前两字节。
			const value = u16(entry + 8);
			// 三元表达式只接受 1..8 的枚举值；0、9 等非法值统一当作未知方向。
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	// 所有目录项都没有匹配方向标签。
	return 1;
}

// 函数说明：tiffStart 输入图片字节，返回 TIFF 头的绝对下标；没有 EXIF 或结构不可读时返回 -1。
// 输入只读；没有副作用，不抛异常。主流程分两条互斥分支：先按 JPEG 的 FF D8 识别并遍历标记段，
// 若不是 JPEG 再按 RIFF....WEBP 识别并遍历 RIFF 块。
// 示例：JPEG 的 APP1 段内容为 Exif\0\0 + TIFF 时，本函数返回 TIFF 头下标（段头之后第 10 字节）。
// 这是内部辅助，示例只是对真实输入形状的说明，不保证任意损坏文件都能安全解析。
/** Where the TIFF header of a JPEG's APP1 or a WebP's EXIF chunk starts; -1 when there is none. */
/** 按 JPEG 标记段或 WebP RIFF 块寻找 TIFF 头的位置，不复制输入；无匹配返回 -1。
 * 例如 JPEG 的 APP1 后是 Exif\0\0 时，跳过段头和六字节标识，返回 TIFF 起点。 */
function tiffStart(bytes: Uint8Array): number {
	// JPEG 的 SOI 是 FF D8；从其后逐段前进。
	// 两条比较都以 0xff/0xd8 数字字面量进行；空数组或短数组读取到 undefined，比较自然为 false。
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		// for 语句省略了自增表达式：不同标记段长度不同，offset 在循环体里手动推进。
		// offset + 4 <= bytes.length 保证 FF、marker 和两字节长度字段都可读。
		for (let offset = 2; offset + 4 <= bytes.length; ) {
			// 当前段至少四字节，且必须由 FF 开头；格式不符合就退出搜索。
			if (bytes[offset] !== 0xff) return -1;
			// marker 是段类型：E0=APP0、E1=APP1、DA=SOS 等；! 只是编译期非空断言。
			const marker = bytes[offset + 1]!;
			// 连续 FF 是填充字节，逐字节跳过后继续读标记。
			if (marker === 0xff) {
				offset++;
				continue;
			}
			// E1 是 APP1；确认 Exif 标识后返回其后 TIFF 头位置。
			// offset+4 跳过 FF、marker 和两字节长度，指向段数据；offset+10 再跳过六字节 Exif 标识。
			if (marker === 0xe1 && isExifHeader(bytes, offset + 4)) return offset + 10;
			// JPEG 长度字段是大端序且包含长度字段本身；再加 FF+marker 的两个字节。
			// 按位或后得到 0..65535 的段长；若长度字段损坏，步进可能落到段数据内部并误读后续字节，
			// 但本函数不报错，只会继续按字节搜索或最终返回 -1。
			offset += 2 + ((bytes[offset + 2]! << 8) | bytes[offset + 3]!);
		}
		// JPEG 搜索结束但未发现 EXIF，不再尝试按 WebP 解读。
		return -1;
	}
	// RIFF 头是四字节 "RIFF"、四字节总长度、四字节 "WEBP"；这里只检查两个标识，不校验总长度字段。
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
		// WebP 文件头十二字节，其后的块由四字节类型、四字节小端长度和内容组成。
		// 循环同样省略自增表达式，offset 由块大小推进；不足 8 字节时不再尝试读取块头。
		for (let offset = 12; offset + 8 <= bytes.length; ) {
			const size =
				// 组装无符号 32 位长度；下面的 >>> 0 消除符号位影响。
				(bytes[offset + 4]! |
					(bytes[offset + 5]! << 8) |
					(bytes[offset + 6]! << 16) |
					(bytes[offset + 7]! << 24)) >>>
				0;
			// Some WebP files prefix the TIFF header with "Exif\0\0".
			// EXIF 块既兼容带 Exif 标识的 TIFF，也兼容直接从 TIFF 头开始的内容。
			// 四字节块类型为 "EXIF"；+8 跳过块头；若有 Exif\0\0 前缀，再 +6 得到 TIFF 头。
			if (ascii(bytes, offset, "EXIF")) return isExifHeader(bytes, offset + 8) ? offset + 14 : offset + 8;
			// RIFF chunks are padded to an even size.
			// 奇数长度补一个字节，下一轮从下一个块头继续。
			// size % 2 为 1 时补 1；size 来自文件，超出实际长度会在下一轮的边界检查处退出。
			offset += 8 + size + (size % 2);
		}
	}
	// 两种容器均未找到 EXIF。
	return -1;
}

/** 判断 offset 处是否是六字节 Exif\0\0 标识；短输入自然比较失败，例如 ExifX 不是有效标识。 */
// 输入 bytes 与绝对偏移 offset，返回 boolean；只读，无副作用。&& 短路：前四字节不匹配时不再检查 NUL。
// 示例：offset 指向 ASCII "Exif\0\0" 时返回 true；指向 "ExifXX" 时返回 false。
function isExifHeader(bytes: Uint8Array, offset: number): boolean {
	// ascii 比四个 ASCII 字节，再单独核对两个 NUL；不做字符串解码。
	// 0 是 NUL 字符；越界下标得到 undefined，与 0 比较为 false，不会抛错。
	return ascii(bytes, offset, "Exif") && bytes[offset + 4] === 0 && bytes[offset + 5] === 0;
}

/** 比较 bytes 指定位置与固定 ASCII 文本；不修改数组，任一位置不同即 false。
 * 例如 ascii(bytes, 0, "RIFF") 只检查前四字节，不能证明整个容器合法。 */
// 输入是字节数组、起始下标和期望文本；返回 boolean。没有类型级保证 text 只含 ASCII，调用方传入的都是固定标识。
// 示例：ascii(bytes, 0, "RIFF") 为 true 只说明前四字节依次是 R、I、F、F。
function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
	// 固定标识均为 ASCII，因此每个 charCodeAt 值与一个字节对应。
	// 循环按 UTF-16 代码单元遍历；对非 ASCII 文本，charCodeAt 可能大于 255，从而永远匹配不到单字节。
	for (let index = 0; index < text.length; index++) {
		// 越界读取得到 undefined，与数字比较为 false；这里不需要额外长度检查。
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	}
	// 所有标识字节都匹配。
	return true;
}
