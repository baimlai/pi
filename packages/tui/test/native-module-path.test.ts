// 测原生 helper 候选路径的优先级/后备项，不加载 .node、不读候选二进制；包解析用注入函数替代，路径全是虚拟样本。
// 各 it 无参数、正常返回 void，断言失败抛错；本文件不能证明候选实际存在或原生库能成功加载。
import assert from "node:assert";
// dirname 取父目录，join 拼接，resolve 按当前 cwd 转绝对路径，均不创建磁盘文件。
import { dirname, join, resolve } from "node:path";
// 注册测试组及用例回调。
import { describe, it } from "node:test";
// pathToFileURL 把路径正确编码为 file URL，href 供被测模块还原；不是网络地址请求。
import { pathToFileURL } from "node:url";
// 真实函数只列候选并按字符串去重，默认包解析可能读元数据，但本测试覆盖为纯内存回调。
import { getNativeModuleCandidates } from "../src/native-module-path.ts";

// 分组检查“安装包可解析”与“包不可用但 standalone 有后备”。
describe("getNativeModuleCandidates", () => {
	// 包可解析例：bundler 把当前模块放到别处，第一候选仍应来自安装的 TUI 包根。
	it("resolves native helpers from the installed TUI package when the module is bundled elsewhere", () => {
		// virtual 前缀只是测试路径名，没有实际安装 node_modules。
		const packageRoot = resolve("virtual", "node_modules", "@earendil-works", "pi-tui");
		// 模拟编码后 chunk 在 coding-agent/dist/bundle/chunks 下，独立于 TUI 包根。
		const bundledModule = resolve("virtual", "pi-coding-agent", "dist", "bundle", "chunks", "chunk.js");
		// 拼 Windows ARM64 .node 相对路径，但 path.join 使用当前 OS 分隔符；不因此在本机执行 Windows 库。
		const nativePath = join("native", "win32", "prebuilds", "win32-arm64", "win32-platform.node");

		// 传相对 nativePath 与显式上下文，让结果不依赖真正包安装位置。
		const candidates = getNativeModuleCandidates(nativePath, {
			// 模拟当前 chunk 的 file URL。
			moduleUrl: pathToFileURL(bundledModule).href,
			// 模拟 node.exe 位置，作为最低优先级后备基础。
			execPath: resolve("virtual", "node", "node.exe"),
			// resolver 回调输入 specifier、返回入口文件路径，无磁盘/加载副作用；内部断言抛错本会被被测函数捕获，但下面第一候选断言也会暴露解析候选缺失。
			resolvePackage: (specifier) => {
				// 要求解析的包名为 TUI，而不是 coding-agent 或 native 文件。
				assert.equal(specifier, "@earendil-works/pi-tui");
				// 返回 dist/index.js 入口，不是直接返回 packageRoot；被测函数要退一层定位包根。
				return join(packageRoot, "dist", "index.js");
			},
		});

		// 第一项必须是安装包根加 nativePath，检优先级而不只是存在性。
		assert.equal(candidates[0], join(packageRoot, nativePath));
		// 当前 chunk 上级目录拼 nativePath 的候选也必须保留，不因包解析成功就丢所有后备。
		assert.ok(candidates.includes(join(dirname(bundledModule), "..", nativePath)));
	});

	// 包不可用例：resolver 主动抛错，被测函数应吞该失败并给三项有序后备。
	it("keeps standalone binary fallbacks when the TUI package is unavailable", () => {
		// 模拟 standalone bundle chunk。
		const bundledModule = resolve("virtual", "pi", "bundle", "chunks", "chunk.js");
		// 模拟可执行文件旁边也可能放 native 目录。
		const execPath = resolve("virtual", "pi", "pi.exe");
		// 构造 macOS ARM64 相对路径，不探测当前架构或打开 .node 文件。
		const nativePath = join("native", "darwin", "prebuilds", "darwin-arm64", "darwin-platform.node");

		// 调实际候选构造器。
		const candidates = getNativeModuleCandidates(nativePath, {
			// 提供 file URL，不把普通绝对路径直接冒充 URL。
			moduleUrl: pathToFileURL(bundledModule).href,
			// execPath 属性简写，相当于 execPath:execPath。
			execPath,
			// resolver 无参回调模拟解析失败，返回永不到达；例包未安装时直接 throw，不是真做 require.resolve。
			resolvePackage: () => {
				// 新 Error 作为控制流样本，被测函数在 try/catch 内接住。
				throw new Error("not installed");
			},
		});

		// 结构比较要求恰有三项且顺序一致，不只检其中某项。
		assert.deepEqual(candidates, [
			// 当前模块目录的父级下拼 native，第一后备。
			join(dirname(bundledModule), "..", nativePath),
			// 当前模块目录下拼 native，第二后备。
			join(dirname(bundledModule), nativePath),
			// 可执行文件目录下拼 native，第三后备；没有独立验证真实磁盘可访问。
			join(dirname(execPath), nativePath),
		]);
	});
});
