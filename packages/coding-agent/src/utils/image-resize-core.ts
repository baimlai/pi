// Photon缩放/编码核心，worker或主线程回退都调用它；限制的是base64载荷大小，处理在本线程同步WASM步骤中消耗CPU。
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

// 可选限制，省略时采用下方默认；number类型不代表这些值已验证为有限正整数，函数没有额外参数schema。
export interface ImageResizeOptions {
	// 最大像素宽度，按比例缩小而非拉伸填满。
	maxWidth?: number; // Default: 2000
	// 最大像素高度，与宽度约束依次应用。
	maxHeight?: number; // Default: 2000
	// base64文字的UTF-8字节上限，不是原图文件字节或像素数组内存。
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	// 第一档JPEG编码质量，其后还尝试85/70/55/40；配置低于85时后续并非全部单调降质。
	jpegQuality?: number; // Default: 80
}

// 输出编码和尺寸信息；original尺寸读取自应用EXIF方向后的图像，并非总是文件头原始宽高。
export interface ResizedImage {
	// 编码后的图片载荷，不含data:前缀。
	data: string; // base64
	// 实际选中PNG/JPEG或直通时原MIME。
	mimeType: string;
	// 方向规范后的输入像素宽/高。
	originalWidth: number;
	originalHeight: number;
	// 最终候选宽/高，可能与original相同但编码已改变。
	width: number;
	height: number;
	// 进入重新编码路径即true，不只表示像素尺寸真的变化。
	wasResized: boolean;
}

/**
 * Tag on image resize worker replies. Node can post its own messages on the worker channel
 * (for example `{ "watch:require": [...] }` under `node --watch`), so replies must be identifiable.
 */
// 固定消息标签让父线程跳过Node自己在worker通道发布的其他消息。
export const IMAGE_RESIZE_WORKER_RESPONSE_TYPE = "pi:image-resize-response";

// 带type的响应联合：成功可为null，失败为错误文字；不是序列化后的Error对象。
export type ResizeImageWorkerResponse =
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; result: ResizedImage | null }
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; error: string };

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
// 本地保守默认是4.5MiB编码载荷，不能据此保证任意provider的所有限制都满足。
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

// Required去掉四个可选修饰符，要求默认表覆盖全部字段；它不校验数值范围或运行时冻结对象。
const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	// 宽高默认各不超过2000像素。
	maxWidth: 2000,
	maxHeight: 2000,
	// 与原始文件大小的比较先用公式换算成base64长度。
	maxBytes: DEFAULT_MAX_BYTES,
	// 首选JPEG质量80，质量值的具体意义由Photon编码器解释。
	jpegQuality: 80,
};

// 某一次编码候选，包含体积供比较；不包含WASM图像句柄，句柄在编码结束后另行free。
interface EncodedCandidate {
	// 候选的base64载荷。
	data: string;
	// base64的UTF-8字节长度（其字符均ASCII）。
	encodedSize: number;
	// 对应编码格式的MIME。
	mimeType: string;
}

// 输入编码后字节及MIME，返回base64/大小候选，无文件I/O；例如PNG字节被编码为ASCII base64后再与maxBytes比。
function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	// Buffer.from复制/包装输入为Node编码接口，toString("base64")产出新文字。
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		// 比较的是编码文字体积，不是buffer.byteLength。
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * returns null.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
// 输入图片字节/MIME/可选限制，异步加载Photon后在当前线程解码、EXIF纠正、缩放与尝试编码，返回候选或null。
// 例如4000x2000先变2000x1000，每轮先生成全部编码候选，再优先选PNG/首档JPEG、其次其他质量；全不合格才按0.75缩尺寸，直到1x1或无进展。
// 已满足尺寸且编码长度严格小于maxBytes则原字节直通；此时虽读取方向后尺寸，返回的仍是原EXIF载荷。解码/编码异常通常转null。
// 不修改inputBytes，但会分配/释放WASM图像；调用方应提供合理限制，不能把未验证任意number输入解释成必定终止/满足全部provider规则的保证。
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	// 后展开的选项覆盖默认，是浅合并；显式undefined也能覆盖对应默认值。
	const opts = { ...DEFAULT_OPTIONS, ...options };
	// base64每3字节对应4字符，末组向上补齐；未实际创建原图base64就能估长度。
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	// 懒加载可能读取WASM文件；后端不可用通常返回null。
	const photon = await loadPhoton();
	// 缺后端时即使图片很小也无法先知道像素尺寸，因此不直接放行。
	if (!photon) {
		return null;
	}

	// ReturnType取静态方法返回的图像类型，undefined用于finally判断是否获得需要释放的句柄。
	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		// 从编码文件字节解码为WASM像素图像，不是把压缩字节当RGBA直接用。
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		// 翻转可能原地修改，旋转可能返回另一个图像对象。
		image = applyExifOrientation(photon, rawImage, inputBytes);
		// 对象身份不同才释放旧句柄，避免两者相同时把后面还要用的图像释放。
		if (image !== rawImage) rawImage.free();

		// original在此指方向修正后的宽高。
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		// format仅供缺MIME的直通分支拼回退，不用于选择编码器。
		const format = mimeType.split("/")[1] ?? "png";

		// Check if already within all limits (dimensions AND encoded size)
		// 尺寸等于上限可接受，但编码长度必须严格小于体积上限。
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			// 不重新编码原图，保留原格式/EXIF信息，wasResized=false。
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// Calculate initial dimensions respecting max limits
		// 初始目标等于已纠正方向的原图，下面只在超过对应上限时按比例调整。
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		// 先限制宽，按同一比例四舍五入高度。
		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		// 经过宽限制后若高度还超，再同比缩宽；取整会带来小量比例误差。
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		// 给定宽高和质量列表，返回PNG及各JPEG候选；例如一轮会编码1份PNG和多份JPEG，最后释放临时图像。
		// 它捕获原image/photon，不保存文件；异常向外层catch传递，!是已知非空的静态断言，不添加运行时验证。
		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			// 每一轮都由原方向图像缩放，避免反复缩小上一轮图像造成累计采样损失。
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				// get_bytes返回PNG编码文件，不是原RGBA像素数组。
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				// 按传入质量顺序编码，未在这里对质量升降排序。
				for (const quality of jpegQualities) {
					// JPEG可能改变透明度/有损细节，最终选择侧重编码体积而非保留全部原格式特性。
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				// 返回普通字节/base64候选，随后释放WASM句柄不影响这些已编码结果。
				return candidates;
			} finally {
				// 成功/编码失败都释放此轮resize产生的句柄。
				resized.free();
			}
		}

		// Set去重保留插入顺序；默认为80,85,70,55,40，所以原英语decreasing并非严格单调。
		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		// 记录当前尝试尺寸，后面逐轮缩小。
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		// 每轮尝试当前尺寸所有编码；合格立即return，否则缩到下一尺寸。
		while (true) {
			// 数组解构分别取PNG、配置首档JPEG和剩余JPEG，不假定后面质量都小于首档。
			const [png, jpeg, ...lowerQualityJpegs] = tryEncodings(currentWidth, currentHeight, qualitySteps);
			// Prefer the smaller of PNG and JPEG at the configured quality; lower JPEG quality only if neither fits.
			// 只先比较PNG与首档JPEG，体积小的优先；不是从所有质量候选选全局最小。
			const preferred = jpeg && jpeg.encodedSize < png.encodedSize ? [jpeg, png] : [png, jpeg];
			// 两个首选都不合格才轮到其他质量，接受遇到的第一份合格结果。
			for (const candidate of [...preferred, ...lowerQualityJpegs]) {
				// 明确存在且严格低于编码体积预算才接受，等于也继续尝试。
				if (candidate && candidate.encodedSize < opts.maxBytes) {
					// 重编码路径始终wasResized:true，即使只是换格式/质量而宽高没变。
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}

			// 1x1已经最小仍不合格，退出循环返回null。
			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			// 各边乘0.75向下取整且至少1，已经1的边保持1。
			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			// 若两边都没变化就停止，避免正常尺寸条件下无限重复同一候选。
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			// 更新两边，下一轮仍从原image缩放到这一组尺寸。
			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		// 最小尺寸或停滞仍无合格编码，不返回超限候选。
		return null;
	} catch {
		// 解码/方向处理/编码等异常在此统一为null，不向调用方暴露具体后端错误。
		return null;
	} finally {
		// 已获得的最终方向图像在成功/失败都释放；finally自身的free异常没有额外catch。
		if (image) {
			image.free();
		}
	}
}
