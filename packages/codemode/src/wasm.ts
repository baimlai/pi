/**
 * Node/Bun侧从磁盘读取QuickJS的WASM二进制并编译，给worker或其他沙箱复用编译模块。
 * 每条路径共享一个Promise，失败会删缓存允许下次重试；这里只编译，不创建VM或执行用户脚本。
 */
// fs/promises提供异步readFile，读取二进制得到Buffer。
import { readFile } from "node:fs/promises";
// 在ES模块里借createRequire取得包路径解析能力，不是把本文件改成CommonJS。
import { createRequire } from "node:module";

/**
 * A compiled `WebAssembly.Module` of `quickjs-wasi/quickjs.wasm`. Typed opaquely because the Node
 * type definitions do not declare the WebAssembly globals (they live in the DOM lib).
 */
/** 用object不透明地描述已编译模块；它不是WASM字节，也不是承诺任意object都能作为模块运行。 */
export type CodemodeWasmModule = object;

/** 这里只声明实际用到的WebAssembly.compile形状，弥补Node类型库未包含DOM全局类型。 */
interface WebAssemblyGlobal {
	// 输入字节，异步返回编译模块；不会进行WebAssembly实例化。
	compile(bytes: Uint8Array): Promise<CodemodeWasmModule>;
}

// 模块级强Map缓存“给定路径字符串→加载Promise”；命中不刷新、不按mtime失效，也不自动规范化别名。
const modules = new Map<string, Promise<CodemodeWasmModule>>();

/**
 * Read and compile the QuickJS wasm once per path. `path` defaults to the file in the installed
 * `quickjs-wasi` package; pass it when that file lives elsewhere, for example embedded in a Bun
 * compiled executable. A failed load is retried on the next call.
 */
/** loadQuickJSWasm()定位依赖内的wasm；传路径时从该路径读取。共享并发读取/编译，文件或编译错误会拒绝并移除该项。包定位失败可同步抛错。 */
export function loadQuickJSWasm(path?: string): Promise<CodemodeWasmModule> {
	// ??只在path为null/undefined时走默认解析；显式空串不会被改成默认路径。resolve只找路径，不执行WASM。
	const resolved = path ?? createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	// 取得已保存的Promise；加载中和已成功都可共享。
	let module = modules.get(resolved);
	// 仅缓存未命中时启动一次异步读取。
	if (!module) {
		// 双重断言只让TS知道运行时全局的compile形状，不会创建或检测WebAssembly能力。
		const { WebAssembly } = globalThis as unknown as { WebAssembly: WebAssemblyGlobal };
		// 此处module变量装的是Promise；不是保留字模块语法。
		module = readFile(resolved)
			// 文件读取完成再编译；异步链结果仍为Promise<CodemodeWasmModule>。
			.then((bytes) => WebAssembly.compile(bytes))
			// catch把读取或编译失败收口；unknown不假定错误一定为Error。
			.catch((error: unknown) => {
				// 删掉失败Promise，避免一次瞬时错误让此路径永久失败。
				modules.delete(resolved);
				// 重新抛错，使本次所有共享等待者都能看到失败，而不是返回undefined。
				throw error;
			});
		// 立刻缓存Promise，其他同路径调用可共享尚未完成的工作。
		modules.set(resolved, module);
	}
	// 返回同一Promise；不复制模块，也不替调用方加载worker。
	return module;
}
