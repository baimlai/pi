// 所属：packages/durable/src/images，Durable 图片处理器的 Cloudflare Workers / Durable Objects 适配入口，
// 由 package.json 的 "./images/cloudflare" 子路径导出。
// 解决的问题：Workers 运行时不能从字节编译 WebAssembly，而 Wrangler 的默认 CompiledWasm 规则会在构建时把
// photon_rs_bg.wasm 变成已编译的 WebAssembly.Module；本文件把这个模块交给共享工厂 initSync，令 Photon 可用。
// 职责边界：只做“模块导入 + 初始化 + 返回 ImageProcessor”，不解码、不缩放、不读取图片，也不启动 worker。
// 上游：应用在 Worker 中 import 本入口；下游：./index.ts 的 createPhotonImages 与 Photon 的 initSync。
// 错误流向：工厂初始化失败会同步抛出；之后 prepare 无法解码或无法满足限制时返回 undefined（见 index.ts）。
// 能力清单：
// - createCloudflarePhotonImages()：无参数，同步返回 ImageProcessor；仅适用于 Wrangler 构建的 Worker。
// 组合与典型顺序：createCloudflarePhotonImages() → createCodingTools({ images }) → read 工具调用 prepare。
// 示例（示例调用，不是运行时行为）：
//   import { createCloudflarePhotonImages } from "@earendil-works/pi-durable/images/cloudflare";
//   const images = createCloudflarePhotonImages();
//   registry.install(createCodingTools({ images }));
// 注意：与 /images/node 不同，这里没有 worker 线程，像素工作发生在调用线程的事件循环上。
// 建议阅读顺序：先读 ../tools/image-processor.ts 的 ImageProcessor 契约，再读 ./index.ts 的 createPhotonImages，
// 最后回到本文件的两行实现。
// Wrangler's default `CompiledWasm` rule turns this import into a `WebAssembly.Module`; Workers cannot compile
// WebAssembly from bytes at runtime. Other bundlers do not support it: use `createPhotonImages()` there.
// 默认导入的类型由 photon-wasm.d.ts 声明为 WebAssembly.Module；Wrangler 在打包阶段负责真正编译。
import photonWasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";
// import type 只引入编译期类型，运行时不会加载 image-processor.ts；ImageProcessor 用作返回值类型。
import type { ImageProcessor } from "../tools/image-processor.ts";
// 这是运行时导入：createPhotonImages 会调用 Photon 的 initSync 并返回 { prepare }。
import { createPhotonImages } from "./index.ts";

// 函数说明：createCloudflarePhotonImages 没有输入参数；返回一个 ImageProcessor，其 prepare 是异步接口。
// 副作用：调用时执行 Photon 的 initSync，首次调用会创建 Wasm 实例并占用其内存；之后调用复用同一实例。
// 错误：initSync 抛出的初始化错误会同步传播，调用方不会得到半初始化的处理器。
// 主流程：把导入的 photonWasm（WebAssembly.Module）原样传给 createPhotonImages，后者返回 { prepare }。
// 示例：const images = createCloudflarePhotonImages(); await images.prepare(bytes, "image/png", limits);
// 上述是调用形状；真实图片处理在 prepare 被调用时才发生，本函数本身不接触图片。
/** `createPhotonImages()` for Cloudflare Workers and Durable Objects, built with Wrangler. */
/** 为 Wrangler 构建的 Worker 创建图片处理器；没有参数，返回 ImageProcessor。
 * 模块导入得到已编译的 Wasm，交给共享工厂初始化；初始化错误直接抛出。
 * 例如把返回值传给 createCodingTools({ images })，之后 read 才会实际处理图片；这里不读取图片。 */
export function createCloudflarePhotonImages(): ImageProcessor {
	// 共享实现同步初始化 Photon，prepare 则以 Promise 返回处理结果。
	// photonWasm 的类型是 WebAssembly.Module（编译期声明）；initSync 内部先用 wasm 是否已定义判断是否首次初始化。
	// 返回值与 createPhotonImages 的返回类型一致：{ prepare(bytes, mimeType, limits): Promise<PreparedImage | undefined> }。
	return createPhotonImages(photonWasm);
}
