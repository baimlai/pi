// 所属：packages/durable/src/images，Node/Bun 图片处理器的 worker 线程入口（不是 package.json 的 exports 子路径）。
// 解决的问题：Photon 解码一张大照片可能在调用线程占用一两秒；node.ts 把这个文件作为 Worker 入口，让解码、
// 缩放和编码发生在独立线程，调用方的事件循环保持可响应。
// 职责边界：本文件是 worker 端脚本，不创建 worker、不导出运行时函数；它只初始化 Photon、接收请求、调用共享
// prepare，并把结果或错误通过 postMessage 回传。文件选择、并发控制和 worker 生命周期都由 node.ts 管理。
// 上游：node.ts 的 PhotonThread 用 new Worker(new URL("./node-worker.ts" 或 ".js", import.meta.url)) 启动，
// 并 postMessage 一条 PrepareRequest，同时转移一份字节副本；下游：./index.ts 的 createPhotonImages、
// node:worker_threads 的 parentPort，以及 node:fs/node:module 读取已安装的 wasm。
// 错误流向：初始化失败会让 Worker 触发 error/exit，node.ts 在收到首个回复前视为“worker 不可用”并回退到调用线程；
// 单张图片无法处理时 prepare 返回 undefined，正常回传 result: undefined；回调链自身异常则以 error 字符串回传。
// 能力清单：
// - PrepareRequest：请求消息形状（id、bytes、mimeType、limits）；导出仅供 node.ts 做类型引用。
// - PrepareReply：回复消息联合类型，成功带 result、失败带 error。
// - 模块顶层副作用：断言 parentPort 存在、解析并同步读取 wasm、初始化处理器、订阅 message；没有导出函数。
// 组合与典型顺序：主线程 new Worker(node-worker) → postMessage(PrepareRequest, 转移 buffer) →
// 本文件 images.prepare(...) → postMessage(PrepareReply) → 主线程按 id 结算对应 Promise。
// 示例（消息形状，不是可执行代码）：{ id: 1, bytes: new Uint8Array([...]), mimeType: "image/png",
//   limits: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592 } }。
// 建议阅读顺序：先看 PrepareRequest/PrepareReply，再看 parentPort 断言与初始化，最后看 message 回调如何配对 id。
// The worker thread of `createNodePhotonImages()`: Photon prepares images here, off the caller's event loop.
// readFileSync 在 worker 启动阶段同步读取 wasm；createRequire 在 ESM 中构造 require 以解析已安装包内路径。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// parentPort 是当前 worker 与创建者通信的 MessagePort；在主线程中为 null。
import { parentPort } from "node:worker_threads";
// 这两个只在编译期使用：类型来自图片处理器契约，不参与运行时导入。
import type { ImageLimits, PreparedImage } from "../tools/image-processor.ts";
// 共享 Photon 工厂；本文件在顶层调用一次，整个 worker 复用同一个 Wasm 实例。
import { createPhotonImages } from "./index.ts";

/** One request: the image to prepare, and its ID for the reply. */
// 请求消息：id 由主线程递增分配，用于把异步回复匹配回对应的 Promise；
// bytes 是结构化克隆/转移后的字节副本，mimeType 与 limits 原样来自调用方。
// readonly 只阻止 TypeScript 代码在编译期改写字段；postMessage 的运行时对象仍是普通可写对象。
export type PrepareRequest = {
	readonly id: number;
	// 图片原始字节；发送方先 slice 再 transfer，worker 收到的是独立副本，主线程的数组不会被清空。
	readonly bytes: Uint8Array;
	// 调用方声明的 MIME；prepare 只把它当作“能否直接内联”等判断的输入，不做嗅探。
	readonly mimeType: string;
	// 最大宽高和 base64 字节数；字段本身的有效性由调用方保证。
	readonly limits: ImageLimits;
};

/** The reply to a request: its result, or why it failed. */
// 回复是二选一的联合类型：两个分支都只有 id，成功分支多 result，失败分支多 error。
// 没有显式 kind 字段，接收方用 "error" in reply 做运行时收窄；result 可以是 undefined（图片无法处理）。
export type PrepareReply =
	| { readonly id: number; readonly result: PreparedImage | undefined }
	| { readonly id: number; readonly error: string };

// 先把 parentPort 存到局部常量：模块顶层在主线程被执行时它是 null，此时直接抛错，避免把主线程误当 worker。
// if 检查后 TypeScript 把 port 收窄为 MessagePort，后面的 port.on/postMessage 不再需要非空断言。
const port = parentPort;
if (port === null) throw new Error("The Photon image worker needs a parent thread");
// import.meta.url 是当前模块地址；createRequire 以它为基准解析依赖包内的 wasm 文件路径。
// readFileSync 返回 Buffer（Uint8Array 的子类），符合 createPhotonImages 的 SyncInitInput（BufferSource）。
// createPhotonImages 在顶层只执行一次；初始化若抛错，会在 Worker 启动阶段变成 error 事件。
const images = createPhotonImages(
	readFileSync(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")),
);
// 订阅主线程消息；回调参数 request 的类型来自消息形状，但 postMessage 的运行时数据没有类型保证。
// 多个请求可以先后排队：像素工作是同步的，同一 worker 内实际串行执行。
port.on("message", (request: PrepareRequest) => {
	// void 明确表示不等待这个 Promise；错误由 then 的第二个回调处理，不会变成未处理的 rejection。
	// then(onFulfilled, onRejected) 的两个回调都通过 postMessage 回复，再用 satisfies 在编译期核对形状。
	void images.prepare(request.bytes, request.mimeType, request.limits).then(
		// prepare 的失败通常以 undefined 结算，而不是 reject；这里仍处理 rejection 以防意外异常。
		(result) => port.postMessage({ id: request.id, result } satisfies PrepareReply),
		// rejection 原因类型是 unknown（JS 可抛任意值）；instanceof Error 是真实运行时判断，
		// 只有 Error 才取 message，其他值用 String 转成可读文本。
		(error: unknown) =>
			port.postMessage({
				id: request.id,
				error: error instanceof Error ? error.message : String(error),
			} satisfies PrepareReply),
	);
});
