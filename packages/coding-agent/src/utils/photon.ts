// 懒加载Photon的JS/WASM后端，并临时兼容独立二进制中的WASM文件位置；会短暂替换进程共享fs.readFileSync。
/**
 * Photon image processing wrapper.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that works in:
 * 1. Node.js (development, npm run build)
 * 2. Bun compiled binaries (standalone distribution)
 *
 * The challenge: photon-node's CJS entry uses fs.readFileSync(__dirname + '/photon_rs_bg.wasm')
 * which bakes the build machine's absolute path into Bun compiled binaries.
 *
 * Solution:
 * 1. Patch fs.readFileSync to redirect missing photon_rs_bg.wasm reads
 * 2. Copy photon_rs_bg.wasm next to the executable in build:binary
 */

import type { PathOrFileDescriptor } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

// 在ESM模块中创建按本模块位置解析的CommonJS require，用于取得可改写的fs导出对象。
const require = createRequire(import.meta.url);
// typeof import("fs")在类型位置描述模块接口，不执行第二次导入；as不验证require返回形状。
const fs = require("fs") as typeof import("fs");

// Re-export types from the main package
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

// 复用重载readFileSync的完整函数类型，补丁最后通过断言适配该调用面。
type ReadFileSync = typeof fs.readFileSync;

// 精确匹配后端的WASM文件名；只针对这个后缀提供位置回退，不改任意缺失文件读取。
const WASM_FILENAME = "photon_rs_bg.wasm";

// Lazy-loaded photon module
// 成功模块缓存；null也可表示未开始或失败，loadPromise进一步区分是否已尝试。
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
// 共享正在/已经完成的加载Promise，并发调用不会各装一层补丁；失败null的Promise同样保留，不自动再次尝试。
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

// 输入fs支持的路径/句柄，返回字符串路径或null，无文件I/O；字符串直接返回，URL经fileURLToPath解析，数字fd/Buffer路径不识别。
// 例如file:///tmp/a.wasm转/tmp/a.wasm；无效/非file URL可抛，调用方没有在这个转换周围另设catch。
function pathOrNull(file: PathOrFileDescriptor): string | null {
	// 联合类型边界分流，而非验证已知字符串参数形状。
	if (typeof file === "string") {
		return file;
	}
	// URL对象需要转成本平台文件路径才判断WASM后缀。
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	// fd和字节路径仍可交原readFileSync使用，只是不参与此文件名回退。
	return null;
}

// 无输入，返回WASM回退候选数组，不验证文件存在；顺序为可执行文件旁、其photon子目录、当前工作目录。
// 例如独立pi二进制在/opt/pi，先看/opt/pi/photon_rs_bg.wasm；这里不是config.ts一般资源目录查找器。
function getFallbackWasmPaths(): string[] {
	// process.execPath是宿主可执行文件，不是当前TS源码目录。
	const execDir = path.dirname(process.execPath);
	return [
		// 发布构建可把WASM复制到二进制同级。
		path.join(execDir, WASM_FILENAME),
		// 也兼容专门photon子目录布局。
		path.join(execDir, "photon", WASM_FILENAME),
		// 最后才看运行时cwd，不能承诺这个位置属于可信安装资源。
		path.join(process.cwd(), WASM_FILENAME),
	];
}

// 临时替换共享CommonJS fs.readFileSync并返回恢复函数；只在目标WASM原读失败且错误码为ENOENT或没有code时尝试候选。
// 例如后端带构建机旧绝对路径时可转读二进制旁WASM；原文件可读则不重定向，权限等有其他code的错误直接抛。
// 这是进程全局补丁，异步导入期间其他读同名后缀的代码也可能受影响；恢复函数不恢复原方法身份，而写回bind后的原实现。
function patchPhotonWasmRead(): () => void {
	// bind固定fs作为this，保存本轮加载之前的读函数行为。
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	// 此时计算一次候选，后面cwd变更不会重新推算此数组。
	const fallbackPaths = getFallbackWasmPaths();
	// as暴露可赋值属性供补丁使用，不改变fs对象本身身份。
	const mutableFs = fs as { readFileSync: ReadFileSync };

	// rest参数接收原API实参，Parameters取函数参数元组类型；它不对运行时实参做schema校验。
	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		// 解构出前两项，调用原实现时仍可用...args完整透传。
		const [file, options] = args;
		// 只有可解释为字符串的路径参与特殊文件名判断。
		const resolvedPath = pathOrNull(file);

		// ?.使null跳过判断；endsWith仅检查后缀，没有核对包身份或真实路径归属。
		if (resolvedPath?.endsWith(WASM_FILENAME)) {
			try {
				// 原始位置能读就立即采用，不因候选存在而覆盖正常模块安装。
				return originalReadFileSync(...args);
			} catch (error) {
				// Node异常类型断言只方便读取code，不是运行时类型验证。
				const err = error as NodeJS.ErrnoException;
				// code非空且不是缺文件时保留原错误，不掩盖权限等真实故障。
				if (err?.code && err.code !== "ENOENT") {
					throw error;
				}

				// 按候选顺序找第一个存在位置；找到但读取失败不会继续下一个候选。
				for (const fallbackPath of fallbackPaths) {
					// 仅检查存在，不在此确认普通文件、完整WASM或可读。
					if (!fs.existsSync(fallbackPath)) {
						continue;
					}
					// 未传options时保持原API默认返回Buffer的调用方式。
					if (options === undefined) {
						return originalReadFileSync(fallbackPath);
					}
					// 若调用方要求编码/其他读选项，回退位置仍使用同一options。
					return originalReadFileSync(fallbackPath, options);
				}

				// 没有候选可用，抛最初原路径错误而非制造空字节。
				throw error;
			}
		}

		// 非目标WASM后缀或不识别的路径形式全部原样读取。
		return originalReadFileSync(...args);
	}) as ReadFileSync;

	try {
		// 通常可直接替换模块对象属性，不改磁盘或Photon源文件。
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		// 赋值失败时再尝试改属性描述；这个尝试若也失败会向外抛。
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	// 无参数恢复闭包，执行时把本轮保存的bind函数写回；不会协调其他模块同期对fs的改写。
	return () => {
		try {
			// 优先普通赋值恢复行为。
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			// 备用属性定义也可能抛错，因此不能保证所有恢复故障都被吞掉。
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
// 无输入，返回缓存Photon模块或null的Promise；首次临时补丁fs再动态导入，成功/常见导入失败后都恢复读函数。
// 例如多张图片同时首次调用共享loadPromise；缺WASM导致导入失败后缓存null，后续调用不会自动重试新安装的文件。
// 外层没有捕获补丁安装/恢复自身的异常，这些情况可拒绝Promise；async不代表WASM初始化完全不会阻塞线程。
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	// 模块已成功加载时最快返回，不再建立补丁。
	if (photonModule) {
		return photonModule;
	}

	// 既涵盖正在加载，也涵盖之前已完成为null/拒绝的Promise。
	if (loadPromise) {
		return loadPromise;
	}

	// 立即调用async表达式并保存其Promise，所有并发调用共享一次尝试。
	loadPromise = (async () => {
		// 安装发生在内部try之前；失败会直接让这个async尝试拒绝。
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			// 这是原有运行时懒导入，不是type位置的import表达式；真正触发模块/WASM初始化。
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			// 模块导入/初始化错误转null，不保留具体错误给图片调用方。
			photonModule = null;
			return photonModule;
		} finally {
			// 无论导入成功/失败都恢复，恢复自身错误仍会覆盖正常返回形成拒绝。
			restoreReadFileSync();
		}
	})();

	// async会接管共享Promise结局，不创建额外加载尝试。
	return loadPromise;
}
