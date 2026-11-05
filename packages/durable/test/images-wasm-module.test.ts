// Its own file, so Photon is not yet initialized: vitest gives each file fresh modules, and Photon loads only once.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createPhotonImages } from "@earendil-works/pi-durable/images";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { expect, it } from "vitest";

// 用本地 Photon WASM 检查预编译模块入口；无参数测试回调返回 Promise，异常使测试失败。
// 示例是 1×1 GIF：真正解码成功后应原样返回；不证明所有 Cloudflare 环境和图像格式均可用。
it("createPhotonImages takes a compiled WebAssembly module, as Cloudflare Workers pass it", async () => {
	// createRequire 以本测试文件为基准解析已安装依赖中的 wasm，不请求网络。
	const path = createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
	// 为缺少完整 WASM 类型的环境补一个本地编译期形状；unknown 中转不校验 globalThis。
	const { WebAssembly } = globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } };
	// 先异步读字节再编译；Parameters<typeof ...>[0] 取得函数首参类型，as 只是让 TS 接受。
	const module = (await WebAssembly.compile(await readFile(path))) as Parameters<typeof createPhotonImages>[0];
	// 同步初始化 Photon，得到异步 prepare 接口；初始化错误使测试直接失败。
	const images = createPhotonImages(module);
	// A 1x1 GIF; returned as it is only once it decodes, which fails without an initialized Photon.
	// 固定合法 GIF 的 base64 字符串，不是从外部文件获取。
	const data = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	// Buffer 解码成字节，按默认尺寸/字节上限处理；即使无需转换也要先解码确认有效。
	const prepared = await images.prepare(Buffer.from(data, "base64"), "image/gif", DEFAULT_IMAGE_LIMITS);
	// 断言返回值只有原数据和 MIME，证明该例通过初始化且无需缩放或转换。
	expect(prepared).toEqual({ data, mimeType: "image/gif" });
});
