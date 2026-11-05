// 主线程图片缩放入口：优先用一次性worker避免WASM堵住界面，worker抛错才回退当前线程；普通处理失败null不会再次重试。
import { Worker } from "node:worker_threads";
import {
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizedImage,
	type ResizeImageWorkerResponse,
	resizeImageInProcess,
} from "./image-resize-core.ts";

// 重导出类型供调用者使用同一契约，编译后不创建额外对象。
export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

// 输入调用方字节，返回由新ArrayBuffer拥有的副本，无I/O；例如postMessage转移副本后，原input仍能访问。
function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer detaches the buffer, so transfer a worker-owned copy and leave the
	// caller's bytes intact.
	// new Uint8Array(另一个视图)复制数值，不共享原buffer；泛型标明可转移的ArrayBuffer而非SharedArrayBuffer。
	return new Uint8Array(input);
}

// 输入worker通道的unknown值，返回标签是否匹配并做TS类型收窄；只检对象/type，不完整校验result/error字段。
// 例如Node的{"watch:require":...}被跳过，但伪造正确type的坏形状不由此函数全面拒绝。
function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	// typeof null为object所以先排null；in确认字段存在后才访问type。
	return (
		value !== null && typeof value === "object" && "type" in value && value.type === IMAGE_RESIZE_WORKER_RESPONSE_TYPE
	);
}

// 输入路径文字或URL，立即新建Worker并返回，会启动独立线程；例如源码入口用.ts、构建入口用.js，启动错误可抛或发error事件。
function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

// 为一次图片请求创建worker、传字节副本、等带标签响应并终止，返回缩放结果/null或拒绝Promise。
// 例如worker入口加载失败触发error，或回传error字段时拒绝，外层才回退；Photon常见加载失败得到null结果，不触发回退。这里没有响应硬超时/取消信号。
// finally发起terminate但不await终止完成；它不修改调用方输入，也不是复用常驻worker池。
async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	// 构造成功后才进入try；构造直接抛错时没有可终止的已取得worker引用。
	const worker = createResizeWorker(workerSpecifier);
	try {
		// 转移只分离副本的buffer，保留主线程原字节。
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		// 等message/error/exit竞争结算一次，返回前先走外层finally。
		return await new Promise<ResizedImage | null>((resolve, reject) => {
			// 防止先收到回复再exit时把成功结果改成失败。
			let settled = false;
			// 输入结果/null，成功结算一次，无返回；例如null是已处理但未产出图片，不是通信失败。
			const settle = (result: ResizedImage | null): void => {
				// 已结算的后续事件忽略。
				if (settled) return;
				settled = true;
				resolve(result);
			};
			// 输入错误，拒绝一次；外层resizeImage捕获后可换执行位置。
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			// 通道消息是跨线程边界，先以unknown接收而非直接信任TS接口。
			worker.on("message", (message: unknown) => {
				// Ignore messages Node posts on the worker channel itself, such as
				// `{ "watch:require": [...] }` under `node --watch` (nodejs/node#65044).
				// 跳过非本协议标签，不把Node调试/监视通知当图片结果。
				if (!isResizeImageWorkerResponse(message)) return;
				// in按联合字段分支，worker发错误文字时重建本线程Error，不传播原堆栈。
				if ("error" in message) fail(new Error(message.error));
				// 成功结果允许null，原样作为正常通信完成。
				else settle(message.result);
			});
			// 线程自身异常直接拒绝，不等待永远不会来的正常message。
			worker.once("error", fail);
			// 即使code=0，没发协议回复就退出也视为失败。
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			// 结构化克隆请求字段，transferList把副本buffer所有权移动到worker，避免再复制大字节。
			worker.postMessage(
				{
					// 只传副本视图，原输入不在转移列表。
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				// 必须传底层ArrayBuffer，不能直接把Uint8Array视图当transferable。
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		// 成功/拒绝都请求停线程；void忽略完成时间，catch吞终止失败，不等于无错误地保证线程已停。
		void worker.terminate().catch(() => undefined);
	}
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Runs Photon in a worker thread so WASM decoding, resizing, and encoding do not
 * block the TUI event loop. If the worker cannot be loaded (for example in some
 * Bun compiled executable layouts), fall back to in-process resizing so image
 * reads still work.
 */
// 输入图片字节/MIME及可选限制，返回缩放结果/null；Bun先试嵌入文字路径，再试模块相对URL，线程异常才在本线程回退。
// 例如源码运行通过import.meta.url选择.ts worker，发布JS选择.js；所有正常null结果直接返回，不做同输入第二次主线程缩放。
// 每次可新建线程并复制字节，有CPU/内存开销，不是网络调用或后台任务取消接口；主线程回退仍可能阻塞界面。
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	// import.meta.url描述本模块位置，按后缀选择当前运行布局，非检查任意TS能力。
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	// new URL相对当前模块解析，不依赖用户工作目录来找普通Node worker。
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	// Bun compiled executables resolve worker entrypoints by string path, not via
	// new URL(..., import.meta.url). Try the string path first under Bun so the
	// release binary uses the embedded worker instead of falling back in-process.
	// 运行环境边界检测Bun版本字段，支持编译可执行文件的特殊worker入口。
	if (typeof process.versions.bun === "string") {
		try {
			// 第一次尝试成功或正常null就直接返回；异常吞掉再继续URL方案。
			return await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
		} catch {}
	}

	try {
		// 通常的模块相对worker路径。
		return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
	} catch {
		// 任何线程方案拒绝均回退，不只“无法加载”一种错误；主线程后端异常仍由其本身规则处理。
		return resizeImageInProcess(inputBytes, mimeType, options);
	}
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
// 输入缩放信息，返回尺寸/坐标映射说明或undefined，无I/O；wasResized=false就不提示。
// 例如原2000x1000、现1000x500输出倍率2.00；倍率只按宽度算并保留两位小数，取整造成的高宽比例差不在此另算。
export function formatDimensionNote(result: ResizedImage): string | undefined {
	// 标志也可能因仅重新编码而为true，不能仅凭它断言尺寸不同。
	if (!result.wasResized) {
		return undefined;
	}

	// 方向修正后的原宽除最终宽；没有在这里验证width非0或映射坐标是否落入边界。
	const scale = result.originalWidth / result.width;
	// 模板串生成实际模型提示，toFixed(2)仅格式化比例，不转换图片像素。
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
