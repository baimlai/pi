// 把图片转PNG并为Kitty终端登记同步转码器；附件处理也复用字节转换，但终端转换不会自动缩尺寸/限制载荷。
import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@earendil-works/pi-tui";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

// ReturnType得到加载Promise类型，Awaited取其结果，NonNullable去掉null，表示调用处已确认取得后端。
type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

// 输入已加载后端及图片字节，返回纠正EXIF方向后的PNG字节或null；解码/编码在当前线程执行，无文件输出。
// 例如横向存储且orientation=6的JPEG会编码为旋正PNG；内部释放取得的图像句柄，普通转换异常返回null。
function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	try {
		// 解码文件字节为WASM图像，不依据MIME选择解码器。
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		// 原地翻转或生成旋转后的新对象。
		const image = applyExifOrientation(photon, rawImage, bytes);
		// 旋转换对象时先释放原对象；若方向处理在返回前抛错，这个释放点也不会执行。
		if (image !== rawImage) rawImage.free();
		try {
			// get_bytes按Photon契约返回PNG；新Uint8Array再复制一份普通JS字节结果。
			return new Uint8Array(image.get_bytes());
		} finally {
			// 编码完成或失败都释放已得到的最终方向图像。
			image.free();
		}
	} catch {
		// Conversion failed
		return null;
	}
}

// 输入图片字节，懒加载Photon后返回PNG字节/null；例如BMP附件先用此函数规范格式，不访问系统剪贴板。
// 常见加载/解码失败返回null，但loadPhoton补丁自身异常仍可能向外拒绝，不能保证永远只返回null。
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	// 等WASM后端可用；首次可能加载文件并临时补丁fs。
	const photon = await loadPhoton();
	if (!photon) {
		// Photon not available, can't convert
		return null;
	}
	// 后端已非空，传给同步编码核心；此行CPU处理仍在当前线程。
	return encodePng(photon, bytes);
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
// 输入base64和声明MIME，返回PNG base64/MIME或null；仅精确image/png直接原样返回，不验证载荷是否真PNG。
// 例如JPEG先解码base64再转PNG，MIME带参数则也走转码；不做图片尺寸/体积限制或模型请求。
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	// 快速分支只比较字符串，无法由此承诺坏PNG载荷会被拒绝。
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	// Buffer的base64解码并非严格文件格式校验，真正图像解码在Photon里。
	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	// 与其他字节调用方共用方向纠正和PNG编码。
	const pngBytes = await convertImageBytesToPng(bytes);
	// 无结果就保留失败，不把原非PNG冒充PNG。
	if (!pngBytes) {
		return null;
	}

	return {
		// 返回标准base64载荷与实际PNG MIME。
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

/**
 * Load photon and return a synchronous PNG transcoder for pi-tui's Kitty image rendering.
 * Returns undefined if photon cannot be loaded.
 */
// 无输入，加载后端后返回同步ImageTranscoder或undefined；转码器供TUI渲染时调用，不在这里直接登记。
// 例如transcoder(jpegBase64,"image/jpeg")返回旋正PNG文字；闭包实际只接首参数，图像格式由字节解码，不使用传入MIME。
export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	// 异步加载一次后，返回闭包可同步编码，渲染调用仍消耗当前线程CPU。
	const photon = await loadPhoton();
	// 没后端就不提供转换函数。
	if (!photon) return undefined;
	// 上下文推导匹配ImageTranscoder，函数可忽略未使用的第二个MIME参数。
	return (base64Data) => {
		// 每次渲染转换由base64还原字节并执行方向纠正/PNG编码。
		const pngBytes = encodePng(photon, new Uint8Array(Buffer.from(base64Data, "base64")));
		// 编码失败返回null，让TUI按自己的文字回退/缓存策略处理。
		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

// 登记尝试的共享Promise，失败false也缓存，不在每次渲染重新加载。
let pngTranscoderLoad: Promise<boolean> | undefined;
// 是否已调用TUI setImageTranscoder登记，和Promise是否存在是两个状态。
let pngTranscoderRegistered = false;

/**
 * On Kitty-protocol terminals, register photon as pi-tui's image transcoder so non-PNG images render.
 * Loads photon once. `onRegistered` runs after registration so callers can re-render images that
 * showed text fallbacks; it is not called if the transcoder was already registered or cannot load.
 */
// 输入登记成功回调，无返回；仅Kitty图片协议且尚未登记时启动/复用异步加载，再设置TUI共享转码器。
// 例如首次图片先显示文字，登记后onRegistered触发重绘；加载中多次调用各挂then，成功时这些等待回调均会触发，已登记后新调用直接跳过。
// 不await或捕获链上异常；回调抛错/加载拒绝可能产生未处理拒绝，不能称无失败后台任务。
export function ensurePngTranscoder(onRegistered: () => void): void {
	// 只对实际能力images="kitty"启用；不为iTerm2或无图片终端加载此专用转换器。
	if (pngTranscoderRegistered || getCapabilities().images !== "kitty") return;
	// ??=只在尚未创建Promise时加载；已经完成false也不会重试。
	pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
		// 后端缺省时正常完成false，不登记假转换器。
		if (!transcoder) return false;
		// TUI登记还会清其PNG缓存，使新渲染可使用转换器。
		setImageTranscoder(transcoder);
		// 先记成功状态，后续调用可直接返回。
		pngTranscoderRegistered = true;
		return true;
	});
	// 每个等待调用都挂自己的回调，void只忽略Promise，不吞回调异常。
	void pngTranscoderLoad.then((registered) => {
		// 失败false时不通知重绘，成功才执行宿主回调。
		if (registered) onRegistered();
	});
}
