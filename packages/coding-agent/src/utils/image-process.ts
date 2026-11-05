// 图片进入附件/工具结果的统一处理入口：规范MIME、必要时转PNG、可选缩放，返回base64和解释文字，不调用模型。
import { convertImageBytesToPng } from "./image-convert.ts";
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "./image-resize.ts";

// 图片处理偏好；TS类型只约束调用形式，不会核验字节内容与声明MIME是否一致。
export interface ProcessImageOptions {
	/** Whether to resize images to inline provider limits. Default: true */
	// false只跳过缩放/体积限制，未支持的格式仍会尝试转PNG。
	autoResizeImages?: boolean;
	/** Optional resize overrides. Uses resizeImage defaults when omitted. */
	// 模型特定限制传给resizeImage；缺省采用其保守默认，不在这里补字段。
	resizeOptions?: ImageResizeOptions;
}

// ok是联合类型判别字段：检查ok后，TS才允许读取成功data或失败message。
export type ProcessImageResult =
	| {
			// 成功表示本管线产出了内容，不是供应商已接受图片的证明。
			ok: true;
			// 编码后的base64文字，不是文件路径或带data:前缀的URL。
			data: string;
			// 输出图片MIME可能因转码/缩放编码改变。
			mimeType: string;
			// 格式转换与坐标缩放提示，交调用方决定如何展示。
			hints: string[];
	  }
	| {
			// 常见处理失败返回数据分支，不在这里必然throw。
			ok: false;
			// 可放入文字消息的省略原因。
			message: string;
	  };

// 格式规范化中间值，还不是最终base64结果。
interface NormalizedImage {
	// 已支持原字节或转码后的PNG字节。
	bytes: Uint8Array;
	// 规范成的小写主MIME，不含分号参数。
	mimeType: string;
	// 只有实际尝试并成功格式转码时记原MIME，用来生成提示。
	convertedFrom?: string;
}

// 输入MIME文字返回分号前、trim后的小写主类型，无I/O；例如IMAGE/PNG; charset=x变image/png，不检查图像字节。
function baseMimeType(mimeType: string): string {
	// ?.处理类型允许的首段缺值，??不会把空主类型当成缺值。
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

// 输入MIME返回四种内联格式之一或null，无副作用；例如image/jpg别名统一image/jpeg，不因扩展名推断格式。
function normalizeSupportedImageMimeType(mimeType: string): string | null {
	// switch只按主MIME分类，已声明支持的字节不会在此解码验证。
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "image/png";
		case "image/jpeg":
		// 两个case共用返回分支，统一JPEG别名。
		case "image/jpg":
			return "image/jpeg";
		case "image/gif":
			return "image/gif";
		case "image/webp":
			return "image/webp";
		// 其余格式交下一步尝试转PNG，而非直接认为没有图片。
		default:
			return null;
	}
}

// 输入图片字节/MIME，异步返回支持格式的中间对象或null；支持的MIME直接保留原字节，其余调用Photon转PNG。
// 例如BMP成功转换后convertedFrom=image/bmp；MIME伪称PNG时这里不会识别谎报，后续是否解码取决于缩放开关。
async function normalizeImage(bytes: Uint8Array, mimeType: string): Promise<NormalizedImage | null> {
	// 查询的是MIME名单，不是魔数探测函数。
	const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
	// 已支持格式省去不必要重新编码，bytes保持同一引用。
	if (normalizedMimeType) {
		return { bytes, mimeType: normalizedMimeType };
	}

	// 后端懒加载/解码/编码可能有WASM与文件加载副作用，正常失败返回null。
	const pngBytes = await convertImageBytesToPng(bytes);
	// 无可用转换后端或无法解码，不构造虚假PNG结果。
	if (!pngBytes) {
		return null;
	}

	return {
		// 只有成功转码后才把MIME明确设为PNG。
		bytes: pngBytes,
		mimeType: "image/png",
		// 保存主类型，用于最终提示；不保留MIME参数。
		convertedFrom: baseMimeType(mimeType),
	};
}

// 输入原/目标MIME，返回格式转换提示或undefined，无I/O；例如image/bmp→image/png生成一条说明，缺原格式则省略。
function conversionHint(from: string | undefined, to: string): string | undefined {
	// 没有实际转换来源或两者相同就不制造转换提示。
	if (!from || from === to) return undefined;
	// 这是实际消息文字，调用方可把它附到图片旁；不是当前console输出。
	return `[Image converted from ${from} to ${to}.]`;
}

// 输入字节/MIME/可选偏好，返回成功base64与hints或失败原因；先规范格式，再按开关缩放，不读用户剪贴板或发模型请求。
// 例如BMP且autoResizeImages=false仍转PNG，PNG且false则直接编码原字节，不检查体积；默认true会采用resizeImage限制。
// 常见转码/缩放失败是ok:false；依赖加载等未被底层捕获的异常仍可拒绝Promise，不能称所有输入都安全成功。
export async function processImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
	// ??保留显式false，省略才默认开启缩放。
	const autoResizeImages = options?.autoResizeImages ?? true;
	// 顺序等待格式规范化，缩放拿到的是规范后的字节/MIME。
	const normalized = await normalizeImage(bytes, mimeType);
	// 转码未成功时返回固定文字分支，不继续调用缩放。
	if (!normalized) {
		return {
			ok: false,
			message: "[Image omitted: could not be converted to a supported inline image format.]",
		};
	}

	// 只有自动缩放开启才检查尺寸及编码体积预算。
	if (autoResizeImages) {
		// worker优先，必要时在本线程回退；配置限制由缩放器解释。
		const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);
		// 缩放器未能产出合格候选，不能把原超限图当成功返回。
		if (!resized) {
			return {
				ok: false,
				message: "[Image omitted: could not be resized below the inline image size limit.]",
			};
		}

		// 收集可选说明，顺序是格式转换在前、尺寸说明在后。
		const hints: string[] = [];
		// 目标格式采用最终编码结果，可能PNG规范化后又选择JPEG。
		const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType);
		// 只有实际生成提示才push，undefined不进入string[]。
		if (convertedHint) hints.push(convertedHint);
		// 缩放/重新编码路径的尺寸提示由wasResized控制。
		const dimensionNote = formatDimensionNote(resized);
		// 小图直接保留时该提示可能缺省。
		if (dimensionNote) hints.push(dimensionNote);

		// 对象字段来自最终缩放结果，不复用最早声明的MIME。
		return {
			ok: true,
			data: resized.data,
			mimeType: resized.mimeType,
			hints,
		};
	}

	// 关闭缩放后仍可能有前一步的格式转换提示。
	const hints: string[] = [];
	// 使用规范格式作为目标，未发生转码则不产生提示。
	const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
	if (convertedHint) hints.push(convertedHint);

	// 返回未经尺寸/体积限制的规范图片字节，Buffer负责转base64。
	return {
		ok: true,
		data: Buffer.from(normalized.bytes).toString("base64"),
		mimeType: normalized.mimeType,
		hints,
	};
}
