// 所属：packages/durable/src/images，Durable 图片处理器的 Photon（Rust 编译到 WebAssembly）共享实现，
// 由 package.json 的 "./images" 导出；node.ts 与 cloudflare.ts 都调用本文件的 createPhotonImages。
// 解决的问题：模型只接收特定格式、尺寸和字节预算内的图片；这里把可解码图片解码、按 EXIF 方向旋正、缩放到限制内，
// 并按“JPEG 来源先试 JPEG、其余先试 PNG，质量依次 80/70/55/40，仍超限则按 3/4 缩小重试”的顺序处理，
// 直到 base64 长度满足 maxBytes。
// 职责边界：不做文件 I/O、不启动线程、不读取模型；输入输出都是内存数据，像素工作在调用线程执行。
// 上游：应用通过 createNodePhotonImages()/createCloudflarePhotonImages() 或直接 createPhotonImages(wasm)
// 得到 ImageProcessor，再交给 createCodingTools({ images })；read 工具调用 prepare。
// 下游：@silvia-odwyer/photon 的 initSync、PhotonImage、resize、fliph、flipv，以及 ./exif.ts 的 exifOrientation。
// 错误流向：初始化错误同步抛出；prepare 内部解码/旋转/缩放/编码异常都被捕获并返回 undefined，由 read 转成错误结果。
// 能力清单：
// - createPhotonImages(wasm)：导出的工厂，初始化 Photon 并返回 { prepare }。
// - JPEG_QUALITIES：内部常量，依次尝试的 JPEG 质量。
// - prepare(bytes, mimeType, limits)：内部主流程，返回 PreparedImage 或 undefined。
// - encodeWithin(image, size, maxBytes, jpegFirst)：内部尝试一组编码候选。
// - transposed(image, orientation)：内部处理方向 5..8 的像素转置。
// 组合与典型顺序：createPhotonImages(wasm) → prepare → exifOrientation → 解码/旋正 → encodeWithin → 缩小重试。
// 示例（真实签名）：
//   const wasmPath = createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
//   const images = createPhotonImages(await readFile(wasmPath));
//   const prepared = await images.prepare(pngBytes, "image/png", DEFAULT_IMAGE_LIMITS);
// 阅读顺序：先读 createPhotonImages 与常量，再读 prepare 主流程，然后 encodeWithin，最后 transposed 的坐标变换。
// The package declares only `module`, which bundlers use but Node does not: import the file itself.
// 包只声明了 module 字段，Node 的 exports 解析不一定找到子路径，所以这里直接导入包内具体文件 photon_rs.js。
import {
	fliph,
	flipv,
	initSync,
	PhotonImage,
	resize,
	SamplingFilter,
	type SyncInitInput,
} from "@silvia-odwyer/photon/photon_rs.js";
// 命名导入里的 type SyncInitInput 是内联类型导入：它只存在于编译期，不会成为运行时绑定。
// SamplingFilter 则是运行时的 wasm-bindgen 导出对象，prepare/encodeWithin 会读取它的 Lanczos3 成员。
// ImageProcessor 等接口来自 tools/image-processor.ts；import type 保证运行时不会加载那个模块。
import type { ImageLimits, ImageProcessor, PreparedImage } from "../tools/image-processor.ts";
// 下面三个是运行时值：INLINE_IMAGE_TYPES 用于判断格式能否直接内联，toBase64/base64Length 计算编码结果。
import { base64Length, INLINE_IMAGE_TYPES, toBase64 } from "../tools/image-processor.ts";
// EXIF 方向读取同目录的纯字节解析器；它不依赖 Photon。
import { exifOrientation } from "./exif.ts";

/** JPEG qualities tried in order. */
// 依次尝试的 JPEG 质量。数字从高到低：先保画质，字节超限再降质量；数组本身不被修改。
// 类型被推断为 number[]，不是只读元组；本文件内没有对它赋值。
const JPEG_QUALITIES = [80, 70, 55, 40];

// 函数说明：createPhotonImages 接收 Photon 的 Wasm（字节或已编译模块），返回实现 ImageProcessor 的对象；
// 返回的 prepare 是 async 箭头函数，把同步处理结果包装成 Promise。输入 wasm 交给 initSync，之后的调用不会再换 Wasm。
// 副作用：首次调用初始化全局 Wasm 实例并占用其内存；不读取文件、不启动线程。错误：initSync 初始化失败会同步抛出。
// 主流程：initSync({ module: wasm }) → 返回 { prepare }；真正的解码/旋正/缩放/编码在 prepare 内完成。
// 示例：const images = createPhotonImages(wasmBytes);
//       const prepared = await images.prepare(bytes, "image/jpeg", DEFAULT_IMAGE_LIMITS);
// 上面是调用形状；返回 undefined 表示无法解码或无法压到限制内，而不是抛异常。
/**
 * An `ImageProcessor` on Photon (Rust compiled to WebAssembly), for `createCodingTools({ images })`. `wasm` is
 * Photon's `photon_rs_bg.wasm` as bytes or as a compiled module: `@earendil-works/pi-durable/images/node` reads it from
 * the installed package, `@earendil-works/pi-durable/images/cloudflare` imports it as a Workers module. Elsewhere, such
 * as a browser, fetch the file and pass its bytes. Photon loads once per process; later calls reuse the first `wasm`.
 *
 * An image already upright, in a format providers take inline, and within the limits is returned as it is, once it
 * decodes. Otherwise it is turned upright by its EXIF orientation, scaled to the
 * maximum width and height, and encoded as PNG or JPEG at falling qualities (JPEG first for JPEG sources), then at
 * smaller dimensions, 3/4 at a time, until the base64 fits. Formats providers do not take inline (BMP) become PNG.
 *
 * The work runs on the calling thread: about a second and a half for a 12-megapixel photo. Decoding takes the image's
 * RGBA size in WebAssembly memory, which does not shrink again; leave the processor out on memory-constrained hosts.
 */
/** 输入 Wasm 字节或已编译模块，初始化 Photon 并返回实现 prepare 的对象；初始化失败会同步抛出。
 * 例如 createPhotonImages(wasm).prepare(bytes, "image/png", limits) 返回符合限制的 base64 或 undefined。
 * 工厂本身不处理图片；对象的 async 箭头把同步处理结果包装成 Promise，像素工作仍在调用线程执行。 */
export function createPhotonImages(wasm: SyncInitInput): ImageProcessor {
	// Photon 的 initSync 复用模块级首次初始化；后续工厂不会替换已加载的 Wasm。
	// wasm 的类型 SyncInitInput = BufferSource | WebAssembly.Module，两种形态 initSync 都接受；
	// 传入 { module: wasm } 是新版签名，避免 Photon 打印弃用警告。
	initSync({ module: wasm });
	// 简写属性 prepare 是一个异步箭头函数，参数类型由 ImageProcessor 的返回类型推导。
	// 对象字面量被上下文类型 ImageProcessor 约束，因此 prepare 的签名必须匹配接口；async 使返回值成为 Promise。
	return { prepare: async (bytes, mimeType, limits) => prepare(bytes, mimeType, limits) };
}

// 函数说明：prepare 输入原始图片字节、调用方声明的 MIME 和限制，返回 { data, mimeType, resized?, convertedFrom? }
// 或 undefined。它不修改 bytes，不读写文件；会在 Wasm 内存中分配图片并在 finally 中释放自己持有的部分。
// 错误：解码失败、编码失败、尺寸计算异常等同步异常都被 catch 吞掉并转换为 undefined；不记录错误原因。
// 主流程：读 EXIF 方向 → 解码 → 满足条件则原样返回 → 旋正 → 计算初始尺寸 → 循环编码/缩小 → 返回结果。
// 内部示例：prepare(bmpBytes, "image/bmp", limits) 可能返回
// { data, mimeType: "image/png", convertedFrom: "image/bmp" }。
/** 将图片字节解码、旋正、缩放并编码到限制内；返回图片及转换元数据，处理失败返回 undefined。
 * 原始字节不会改写，但会申请/释放 Wasm 图片内存；例如过大 PNG 可能缩小或转为 JPEG。
 * limits 的类型只描述数字字段，本函数不另外验证正整数范围；调用者提供有意义的限制。 */
function prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): PreparedImage | undefined {
	// EXIF 是真实字节内容；mimeType 是调用者提供的格式信息，是否可直接传给模型由集合决定。
	// 两者都是运行时值：orientation 来自字节解析，inline 来自 Set.has；mimeType 的正确性不由类型保证。
	const orientation = exifOrientation(bytes);
	const inline = INLINE_IMAGE_TYPES.has(mimeType);
	// 保存当前拥有的 Wasm 图片，finally 无论成功失败都负责释放；undefined 表示暂不拥有。
	// 类型注解 PhotonImage | undefined：TS 只允许在判空后调用方法，不会自动管理 Wasm 内存。
	let image: PhotonImage | undefined;
	try {
		// try 覆盖解码、旋正、缩放和编码；任何同步异常都统一落到下面的 catch。
		// Decoded even when it is returned as it is: a damaged file is an error, not an image the provider rejects.
		// Photon 会真实解码像素，坏文件一般在这里抛出并落入下方 catch。
		image = PhotonImage.new_from_byteslice(bytes);
		// 快路径：五个条件必须同时成立；&& 从左到右短路，任一不满足就继续走转换流程。
		// 注意这里比较的是“原文件字节的 base64 长度”，不是解码后的原始字节数。
		if (
			// 只有格式可内联、方向已正、宽高及 base64 长度全部满足限制，才保留原文件编码。
			inline &&
			orientation === 1 &&
			image.get_width() <= limits.maxWidth &&
			image.get_height() <= limits.maxHeight &&
			base64Length(bytes.byteLength) <= limits.maxBytes
		) {
			// 返回原始内容的 base64；图片对象仍由 finally 释放。
			// 这里没有 resized/convertedFrom 字段，调用方据此知道坐标无需换算、格式未变。
			return { data: toBase64(bytes), mimeType };
		}
		// 方向 5..8 会交换宽高，不能靠简单的水平/垂直翻转修正。
		if (orientation >= 5) {
			// 5..8 要交换宽高，用手工像素映射避免 Photon 直角旋转丢像素的问题。
			const upright = transposed(image, orientation);
			// Freed first, so the upright copy reuses its WebAssembly memory.
			image.free();
			// 先取消所有权标记；新构造失败时 finally 不会再次释放旧对象。
			// 这两步赋值顺序重要：free 后旧对象已失效，若构造抛错，finally 看到的是 undefined。
			image = undefined;
			// PhotonImage 构造函数接管的是 upright.pixels 这份新数组；宽高已交换。
			image = new PhotonImage(upright.pixels, upright.width, upright.height);
		} else if (orientation !== 1) {
			// 2/3/4 分别是水平翻转、水平加垂直翻转、垂直翻转，均不交换宽高。
			// 条件写成“不是 4/2”而不是 switch，是因为只需处理三个方向；fliph/flipv 原地修改 Wasm 图片。
			if (orientation !== 4) fliph(image);
			if (orientation !== 2) flipv(image);
		}
		// 后续 from 尺寸取旋正后的图片；scale 不超过 1，避免把小图放大。
		// Math.min(1, ...) 同时处理宽、高两个约束：取更严格的那个比例，保证两边都不超过上限。
		const width = image.get_width();
		const height = image.get_height();
		// 除法结果可能是小数；宽度或高度为 0 时得到 Infinity，后续 Math.round 仍需按实际图片处理。
		const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
		// 取整后最少一个像素，target 可在编码失败时继续缩小。
		// target 被 let 声明，因为每轮失败后会替换为更小的对象；对象字段本身是 number。
		let target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
		// 无条件的 for(;;) 等价于 while(true)：退出只靠内部 return，或在 1x1 时返回 undefined。
		for (;;) {
			// 在当前尺寸尝试一组编码；JPEG 来源优先尝试 JPEG，其余来源先 PNG。
			// 返回值是 { data, mimeType } | undefined；undefined 只表示当前尺寸没有候选满足字节上限。
			const encoded = encodeWithin(image, target, limits.maxBytes, mimeType === "image/jpeg");
			// 判空后 TS 把 encoded 收窄为有 data/mimeType 的对象；下面才能安全展开。
			if (encoded !== undefined) {
				// 只有宽高实际变化时附上 resized；?: 两分支均返回对象，供稍后 ... 展开合并。
				const resized =
					target.width === width && target.height === height
						? {}
						: { resized: { from: { width, height }, to: target } };
				// 仅编码 MIME 与原 MIME 不同时报告 convertedFrom，旋正本身不算格式转换。
				const converted = encoded.mimeType === mimeType ? {} : { convertedFrom: mimeType };
				// 三个对象展开合并：encoded 提供 data/mimeType，后两个按条件覆盖或补充字段。
				// 空对象 {} 展开不添加字段；返回类型仍满足 PreparedImage 的可选字段约定。
				return { ...encoded, ...converted, ...resized };
			}
			// 一像素仍无法满足字节上限，继续缩小已无意义。
			if (target.width === 1 && target.height === 1) return undefined;
			// 用新对象替换 target；上一轮的尺寸被下一轮覆盖，旧对象可被回收。
			target = {
				// 每轮在两个方向各缩为四分之三，向下取整并保证最少一个像素。
				width: Math.max(1, Math.floor(target.width * 0.75)),
				height: Math.max(1, Math.floor(target.height * 0.75)),
			};
		}
	} catch {
		// Photon throws for bytes it cannot decode.
		// 此 catch 也覆盖旋正、缩放、编码过程的同步异常，统一以“不支持处理”返回。
		// catch 没有绑定变量：这里不需要读取异常对象，TypeScript 允许省略绑定（optional catch binding）。
		return undefined;
	} finally {
		// ?. 只在 image 存在时释放 Wasm 对象；JS 垃圾回收不会替代这里的显式 free。
		// finally 在 return 之后、函数真正返回之前执行，因此成功和失败的路径都会释放当前持有的图片。
		image?.free();
	}
}

/**
 * `image` at `size` in the first encoding whose base64 fits `maxBytes`: PNG, then JPEG at falling qualities, or the
 * JPEG qualities first when `jpegFirst`; `undefined` if none fits.
 */
// 函数说明：encodeWithin 在指定尺寸下构造有序候选列表（PNG 与四个 JPEG 质量），逐个真正编码并比较
// base64 长度；返回第一个满足 maxBytes 的 { data, mimeType }，全部超限返回 undefined。
// 输入 image 归调用者所有，本函数不释放它；size 只读；jpegFirst 决定 JPEG 候选是否排在 PNG 前。
// 副作用：若 size 与原图不同，会创建一份缩放后的 PhotonImage（resize），并在 finally 中释放；编码是惰性回调。
// 错误：resize 或 encode 抛出的异常向外传播，由 prepare 的 catch 处理；本函数不自行吞错。
// 示例：encodeWithin(image, { width: 800, height: 600 }, 500_000, false)
//       先试 PNG，超限再按 80/70/55/40 依次试 JPEG。
function encodeWithin(
	image: PhotonImage,
	size: { readonly width: number; readonly height: number },
	maxBytes: number,
	jpegFirst: boolean,
): { readonly data: string; readonly mimeType: string } | undefined {
	// readonly 约束调用者在 TypeScript 中不改尺寸字段，不会在运行时冻结对象。
	// same 需要同时比较宽和高；若相同则无需 resize，直接复用调用者的 Wasm 图片。
	const same = size.width === image.get_width() && size.height === image.get_height();
	// Lanczos3 是 Photon 的采样枚举值；相同尺寸直接借用原图，避免多建 Wasm 对象。
	// 三元表达式两个分支都是 PhotonImage；same 只决定复用调用者的对象还是新建缩放对象。
	const scaled = same ? image : resize(image, size.width, size.height, SamplingFilter.Lanczos3);
	try {
		// encode 是延迟回调，只在选到该候选时才进行实际压缩。
		// png 是一个普通对象，encode 箭头函数捕获 scaled；类型被推断为 { mimeType: string; encode: () => Uint8Array }。
		const png = { mimeType: "image/png", encode: () => scaled.get_bytes() };
		const jpegs = JPEG_QUALITIES.map((quality) => ({
			// map 为每个质量建立候选；闭包保存各自 quality，尚不编码像素。
			mimeType: "image/jpeg",
			encode: () => scaled.get_bytes_jpeg(quality),
		}));
		// 展开语法复制候选数组：JPEG 优先时把 PNG 放最后，否则 PNG 在最前；原数组不被修改。
		for (const candidate of jpegFirst ? [...jpegs, png] : [png, ...jpegs]) {
			// 按顺序调用编码器，比较的是 base64 长度而非压缩文件本身的字节数。
			// base64Length 只做算术，不生成字符串；只有长度合格才调用 toBase64 真正编码。
			const bytes = candidate.encode();
			if (base64Length(bytes.byteLength) <= maxBytes) return { data: toBase64(bytes), mimeType: candidate.mimeType };
		}
		// 没有候选满足当前尺寸限制，由调用者决定再缩小。
		return undefined;
	} finally {
		// 原图由外层 prepare 释放；只有 resize 产生的新对象归此处释放。
		// 若在此处也释放原图，prepare 的 finally 会二次 free；!same 条件避免了这种所有权冲突。
		if (!same) scaled.free();
	}
}

/**
 * The RGBA pixels of `image` turned upright for EXIF `orientation` 5 to 8, the orientations that swap width and
 * height. Photon's own `rotate` drops pixels at right angles, so the pixels are moved here.
 */
// 函数说明：transposed 只处理 EXIF 方向 5、6、7、8（这四种会交换宽高）。输入 Wasm 图片与方向值，
// 返回普通 JS 对象 { pixels: Uint8Array, width, height }；新数组由调用方接管并用于构造新 PhotonImage。
// 副作用：调用 image.get_raw_pixels() 复制出源像素；不修改也不释放 image，不申请 Wasm 内存。
// 错误：数组下标运算不会抛错；orientation 的其他值不会进入本函数（prepare 已按 >=5 分支）。
// 示例：方向 6（顺时针 90 度）会把源 (x, y) 映射到目标 (height-1-y, x)。
/** 对方向 5..8 重排 RGBA 像素并交换宽高；返回新的 JS 像素数组，不修改或释放原 image。
 * 例如方向 6 把源 (x,y) 放到 (height-1-y,x)，形成顺时针 90 度；类型 number 本身不保证范围，调用者已按 EXIF 分支选择。 */
function transposed(
	image: PhotonImage,
	orientation: number,
): { readonly pixels: Uint8Array; readonly width: number; readonly height: number } {
	// 读取尺寸和 Photon 导出的原始 RGBA 像素；每像素连续四字节。
	// get_raw_pixels 返回新的 Uint8Array 副本，因此后续读写不会影响 Wasm 中的原图。
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	// 目标像素总数不变，只有排列和宽高改变。
	// Uint8Array(length) 分配全零数组；长度与 source 相同，保证每个 RGBA 字节都有位置。
	const pixels = new Uint8Array(source.length);
	// 循环上界使用源图宽高；目标宽高已交换，目标下标由 outX/outY 单独计算。
	// y 是源行号；内层 x 是源列号。循环变量都是块作用域 let。
	for (let y = 0; y < height; y++) {
		// 外层逐行、内层逐像素遍历，覆盖每个源像素一次。
		for (let x = 0; x < width; x++) {
			// Where (x, y) lands in the upright image, which is `height` wide.
			// 目标坐标按 EXIF 定义组合：5=转置后水平镜像，6=顺时针 90°，7=转置后垂直镜像，8=逆时针 90°。
			// 两个 || 条件把方向分成两组；三元表达式只改变下标方向，不改变遍历次数。
			const outX = orientation === 5 || orientation === 8 ? y : height - 1 - y;
			const outY = orientation === 5 || orientation === 6 ? x : width - 1 - x;
			// 用行优先下标乘 4 得 RGBA 起点，subarray 取源四字节，set 写到目标像素。
			// 源起点是 (y * width + x) * 4；目标起点是 (outY * 目标宽 + outX) * 4，目标宽等于原图高（height）。
			// subarray 不复制，set 会把这四个字节复制到目标数组；每一步覆盖一个完整像素。
			pixels.set(source.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (outY * height + outX) * 4);
		}
	}
	// 转置后目标宽为原高、目标高为原宽；新对象交由 prepare 构造 PhotonImage。
	return { pixels, width: height, height: width };
}
