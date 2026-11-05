// 一次性缩放worker入口：接收一条请求，在独立线程调用WASM核心，再给父线程发带标签结果或错误；不处理模型/API请求。
import { parentPort } from "node:worker_threads";
import {
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizeImageWorkerResponse,
	resizeImageInProcess,
} from "./image-resize-core.ts";

// 线程协议的预期请求形状，接口本身会擦除，真实通道输入下面仍需检查。
interface ResizeImageWorkerRequest {
	// 主线程转移来的字节副本，由worker取得其ArrayBuffer所有权。
	inputBytes: Uint8Array;
	// 调用方声明的MIME，未在协议层对魔数做完整验证。
	mimeType: string;
	// 可选缩放配置，协议守卫没有进一步验证每个数值。
	options?: ImageResizeOptions;
}

// 输入unknown通道消息，返回是否有字节视图和字符串MIME并收窄类型；例如任意watch通知不符合这两字段。
// 它仅检查两个必需字段，不检查options形状/尺寸边界，不能把类型谓词当完整请求schema。
function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	// 在跨线程输入边界先排空值和非对象。
	if (!value || typeof value !== "object") return false;
	// as允许按字符串键读取未知对象，不执行数据转换。
	const record = value as Record<string, unknown>;
	// Uint8Array排除普通数组/文字，MIME要求真正字符串。
	return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}

// 本地别名便于条件后TS将parentPort从可空类型收窄。
const port = parentPort;
// 主线程直接导入此入口会没有parentPort，立刻报错；它应由Worker运行。
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

// 一次性入口只接收第一条消息，不是常驻多请求服务。
port.once("message", (message: unknown) => {
	// 立即调用async箭头函数处理await；void忽略该Promise，内部try负责把常见处理异常转响应。
	void (async () => {
		try {
			// 协议不匹配就走统一error响应，不执行图像核心。
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			// 核心正常失败可返回null，仍是result响应而非通信error。
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			// 显式联合类型保证发出的标签/字段形状，未在此复制原图回父线程。
			const response: ResizeImageWorkerResponse = { type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE, result };
			// 结构化克隆结果，其中图片已是base64文字，不需转移原字节buffer。
			port.postMessage(response);
		} catch (error) {
			// 捕获请求检查/图像处理/首个发送异常，只回传文字，不传Error原型或堆栈。
			const response: ResizeImageWorkerResponse = {
				type: IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
				// 任意抛出值统一转可跨线程的字符串。
				error: error instanceof Error ? error.message : String(error),
			};
			// 若这次postMessage自身仍抛错，外面没有第二层catch兜底。
			port.postMessage(response);
		}
	})();
});
