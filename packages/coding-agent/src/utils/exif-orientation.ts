// 从JPEG/WebP的EXIF元数据取方向并旋正Photon像素；不改源字节、不写文件，只读取本实现需要的少量TIFF字段。
import type { PhotonImageType } from "./photon.ts";

// typeof import在类型位置描述模块导出，不在运行时加载Photon；实际模块由调用方传入。
type Photon = typeof import("@silvia-odwyer/photon-node");

// 输入原字节和TIFF起点，读取首IFD的Orientation标签，返回1..8，未找到/若干越界情形回退1（不变换）。
// 例如标签0x0112内联值6表示顺时针90度；这里只取entry+8的16位值，未完整核验TIFF魔数、字段类型/数量或整个EXIF结构。
function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
	// TIFF头至少8字节；这是上界检查，没有在此补一套所有负偏移/损坏数据验证。
	if (tiffStart + 8 > bytes.length) return 1;

	// 两字节拼成字节序标记，0x4949是ASCII的II。
	const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1];
	// II采用小端，其他值都按大端处理，不单独验证必须为MM。
	const le = byteOrder === 0x4949;

	// 局部16位读取器捕获字节序，无I/O；小端低字节在前，大端高字节在前，不自行检查每次pos边界。
	const read16 = (pos: number): number => {
		if (le) return bytes[pos] | (bytes[pos + 1] << 8);
		return (bytes[pos] << 8) | bytes[pos + 1];
	};

	// 局部32位偏移读取器；位运算默认有符号32位，大端分支>>>0转无符号，小端分支没有此转换。
	const read32 = (pos: number): number => {
		if (le) return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
		return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
	};

	// TIFF头+4保存首个IFD相对TIFF开头的偏移。
	const ifdOffset = read32(tiffStart + 4);
	// 转成输入数组中的位置，不把偏移当文件绝对地址。
	const ifdStart = tiffStart + ifdOffset;
	// 至少要容纳2字节entry数量，否则保留默认方向。
	if (ifdStart + 2 > bytes.length) return 1;

	// 首IFD表开头是16位项数，不递归遍历所有子IFD。
	const entryCount = read16(ifdStart);
	// 每项固定12字节，逐项查Orientation编号。
	for (let i = 0; i < entryCount; i++) {
		// 跳过项数2字节，再按当前序号前进。
		const entryPos = ifdStart + 2 + i * 12;
		// 某项超当前字节窗口则直接回退1，不继续读虚构数据。
		if (entryPos + 12 > bytes.length) return 1;

		// 0x0112是方向tag，其他元数据不会改变像素处理。
		if (read16(entryPos) === 0x0112) {
			// 按预期短整型内联值布局读取，不另外追value offset。
			const value = read16(entryPos + 8);
			// 只接受1..8，其余数值视为无需变换。
			return value >= 1 && value <= 8 ? value : 1;
		}
	}

	// 此IFD没找到方向标签，采用不变换。
	return 1;
}

// 输入已识别JPEG头的字节，按标记段寻找带Exif\0\0的APP1，返回TIFF起点或-1，无I/O。
// 例如前一APP1是XMP就继续后面的APP1；不是完整JPEG解析器，不检查所有标记/段长语义或解码扫描数据。
function findJpegTiffOffset(bytes: Uint8Array): number {
	// 跳过FFD8起始标记。
	let offset = 2;
	// 至少能看两字节标记才继续。
	while (offset < bytes.length - 1) {
		// 当前位置不是FF标记前缀就不沿错误位置继续猜。
		if (bytes[offset] !== 0xff) return -1;
		// 后一字节决定段类型。
		const marker = bytes[offset + 1];
		// 重复FF填充时推进一字节，继续等实际标记。
		if (marker === 0xff) {
			offset++;
			continue;
		}

		// E1是APP1容器，可能是EXIF也可能是XMP等其他数据。
		if (marker === 0xe1) {
			// 需要标记2字节和长度2字节之后还有内容。
			if (offset + 4 >= bytes.length) return -1;
			// 段正文从标记+长度之后开始。
			const segmentStart = offset + 4;
			// 至少6字节才能比较Exif固定前缀。
			if (segmentStart + 6 > bytes.length) return -1;
			// 仅匹配EXIF的APP1才返回，跳过前缀后正好到TIFF头。
			if (hasExifHeader(bytes, segmentStart)) return segmentStart + 6;
		}

		// 普通段需要读两字节大端长度，不足则查找失败。
		if (offset + 4 > bytes.length) return -1;
		// JPEG段长度包含长度字段自身，不包含前面的FF+marker。
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		// 跳过标记2字节与声明段长，再找下一段。
		offset += 2 + length;
	}

	// 可见字节中没有找到匹配的EXIF段。
	return -1;
}

// 输入WebP RIFF字节，从偏移12顺块查EXIF，返回TIFF起点或-1，无I/O；可接受带/不带Exif前缀的块。
// 块大小用现有有符号32位位运算读取，只有局部范围检查，不能把此函数当任意恶意RIFF都完整验证的解析器。
function findWebpTiffOffset(bytes: Uint8Array): number {
	// RIFF头12字节之后开始第一个块。
	let offset = 12;
	// 一块头由4字符ID和4字节长度组成。
	while (offset + 8 <= bytes.length) {
		// 直接把四字节转字符，例如EXIF或VP8X，不按UTF8解码正文。
		const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
		// RIFF块长度是小端，这个表达式的最高位可能使结果为负，未额外>>>0。
		const chunkSize =
			bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
		// 正文紧跟块头，长度不含头和偶数填充。
		const dataStart = offset + 8;

		// 只对EXIF块解析方向，其他块按长度跳过。
		if (chunkId === "EXIF") {
			// 声明正文超过当前字节数组则不采用。
			if (dataStart + chunkSize > bytes.length) return -1;
			// Some WebP files have "Exif\0\0" prefix before the TIFF header
			// 有Exif\0\0前缀跳6字节，否则假设正文直接为TIFF。
			const tiffStart = chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
			return tiffStart;
		}

		// RIFF chunks are padded to even size
		// 奇数长度多跳1字节填充，不把填充误当下一块ID。
		offset = dataStart + chunkSize + (chunkSize % 2);
	}

	// 当前范围未找到EXIF。
	return -1;
}

// 输入字节与偏移，比较六字节Exif\0\0签名，返回布尔，无副作用；缺任一字节比较也不等于预期值。
function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
	// &&逐项短路，十六进制依次表示E/x/i/f和两个NUL。
	return (
		bytes[offset] === 0x45 &&
		bytes[offset + 1] === 0x78 &&
		bytes[offset + 2] === 0x69 &&
		bytes[offset + 3] === 0x66 &&
		bytes[offset + 4] === 0x00 &&
		bytes[offset + 5] === 0x00
	);
}

// 输入原文件字节，按JPEG/WebP头选择EXIF查找器，再返回方向1..8；其他格式/没找到以1表示不变换。
// 例如PNG不在本方向探测列表，不能据此声称其所有方向元数据都已处理；本函数不加载Photon或改源文件。
function getExifOrientation(bytes: Uint8Array): number {
	// -1是尚未找到TIFF头的哨兵值。
	let tiffOffset = -1;

	// JPEG: starts with FF D8
	// 两字节先识别JPEG，再按段查找。
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		tiffOffset = findJpegTiffOffset(bytes);
	}
	// WebP: starts with RIFF....WEBP
	// 每行仍是同一条件的字节签名比较，不检查整个RIFF尺寸是否一致。
	else if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		tiffOffset = findWebpTiffOffset(bytes);
	}

	// 没定位到头就不再用-1偏移读取。
	if (tiffOffset === -1) return 1;
	// 方向标签只从已定位TIFF区域的首IFD读取。
	return readOrientationFromTiff(bytes, tiffOffset);
}

// 像素映射回调，输入原x/y/宽/高，返回目标图的一维像素索引（未乘RGBA的4字节）。
type DstIndexFn = (x: number, y: number, w: number, h: number) => number;

// 输入后端/像素图和索引映射，创建宽高互换的新图像；不修改/释放旧image，调用方比较身份后负责free旧句柄。
// 例如2x1旋90度变1x2，每个RGBA四通道一起搬；具体顺/逆时针由dstIndex公式决定，不由函数名字固定。
function rotate90(photon: Photon, image: PhotonImageType, dstIndex: DstIndexFn): PhotonImageType {
	// 取得源宽高和解码后的RGBA像素，不是PNG/JPEG编码文件。
	const w = image.get_width();
	const h = image.get_height();
	const src = image.get_raw_pixels();
	// 同像素数量的新字节数组，只改变坐标排列。
	const dst = new Uint8Array(src.length);

	// 按每行/每列遍历源像素。
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			// 行主序像素索引乘4，得到R通道偏移。
			const srcIdx = (y * w + x) * 4;
			// 映射返回目标像素位置，再乘4定位同一像素四通道。
			const dstIdx = dstIndex(x, y, w, h) * 4;
			// R/G/B/Alpha分别复制，不做颜色插值。
			dst[dstIdx] = src[srcIdx];
			dst[dstIdx + 1] = src[srcIdx + 1];
			dst[dstIdx + 2] = src[srcIdx + 2];
			dst[dstIdx + 3] = src[srcIdx + 3];
		}
	}

	// 目标宽为原h、高为原w；新WASM句柄需由调用方后续释放。
	return new photon.PhotonImage(dst, h, w);
}

// Flip orientations mutate in-place. Rotations return a new image (caller must free the old one if different).
// 输入Photon模块、已解码图像和原字节，按EXIF方向返回旋正图；翻转可原地修改，90度旋转返回新图，无文件I/O。
// 例如方向6顺时针90度，方向2水平翻转；返回新对象时本函数不free旧对象，转换/缩放调用方承担句柄生命周期。
export function applyExifOrientation(
	photon: Photon,
	image: PhotonImageType,
	originalBytes: Uint8Array,
): PhotonImageType {
	// 必须从原编码字节读EXIF，解码像素对象不提供该标签。
	const orientation = getExifOrientation(originalBytes);
	// 常见方向1快速复用原对象。
	if (orientation === 1) return image;

	// 分别处理标准八方向，不在此更改原文件EXIF标签。
	switch (orientation) {
		case 2:
			// 水平镜像原对象，返回身份不变。
			photon.fliph(image);
			return image;
		case 3:
			// 水平再垂直镜像等效180度旋转，两次都原地修改。
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			// 垂直翻转原对象。
			photon.flipv(image);
			return image;
		case 5: {
			// 先顺时针90度，再水平翻转新图，得到对角转置方向。
			const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			// 源(x,y)映射到新图(h-1-y,x)，也就是顺时针90度。
			return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
		case 7: {
			// 逆时针90度后再水平镜像，得到另一条对角镜像方向。
			const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			// 新图位置(y,w-1-x)，逆时针90度。
			return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
		default:
			// 未匹配方向不额外改图；正常探测已经把超出1..8的值回退1。
			return image;
	}
}
