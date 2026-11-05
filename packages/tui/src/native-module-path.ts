// 为 .node 原生模块列出打包位置候选；本文件不加载二进制，也不逐个检查 native 候选是否存在；包入口解析仍可能访问文件系统。
// ESM 借 createRequire 得到以本模块为基准的 CommonJS 解析能力。
import { createRequire } from "node:module";
// dirname 取父目录，join 按当前操作系统规则拼接/规范化路径。
import { dirname, join } from "node:path";
// import.meta.url 是 URL，先转成本地路径再交给 path 函数。
import { fileURLToPath } from "node:url";

// 创建解析器本身还没有 require 任何 native helper。
const moduleRequire = createRequire(import.meta.url);
// 优先解析独立安装的 TUI 包，兼容本模块被 bundler 挪动的场景。
const TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

// 可选环境覆盖；? 表示字段可省，缺省行为由下面函数实现。
export interface NativeModuleCandidateOptions {
	// 当前模块的 file: URL，不是普通目录路径；非法 URL 转换会抛错。
	moduleUrl?: string;
	// 可执行文件路径，供 native 与 standalone 二进制相邻的布局使用。
	execPath?: string;
	// 自定义包解析函数：输入包名，返回包入口文件路径，并非包根目录。
	resolvePackage?: (specifier: string) => string;
}

// 按 native 相对路径及可选位置覆盖，返回按尝试顺序去重的候选数组。
// 例：native/darwin/... 先放已安装 TUI 包根下，再放模块相对位置和可执行文件旁。
// 不读取/改写 native 文件内容；包解析可能读取包元数据，失败只省掉该候选，try 外的 URL 转换异常仍向外抛。
export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	// ?? 仅在 null/undefined 时回退；fileURLToPath 转换后去掉文件名。
	const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
	// 声明 string[]，接下来按优先级追加路径。
	const candidates: string[] = [];

	// 只捕获已安装包解析与对应候选构造的错误。
	try {
		// 默认 require.resolve 定位入口，不执行包入口代码；也可由测试注入解析器。
		const packageEntry = (options.resolvePackage ?? moduleRequire.resolve)(TUI_PACKAGE_NAME);
		// 入口在 dist/index.js，故从其目录退一层到包根，再接 nativePath。
		candidates.push(join(dirname(packageEntry), "..", nativePath));
		// 解析失败（包括自定义解析器抛错）也继续构造后备位置。
	} catch {
		// Standalone binaries do not have an installed TUI package.
	}

	// 一次 push 多个候选；顺序就是尝试顺序，不根据磁盘情况排序。
	candidates.push(
		// 源码 src/ 或编译输出 dist/ 的上一层通常是 TUI 包根。
		join(moduleDir, "..", nativePath),
		// 也兼容把 native 资源直接放在模块目录的打包方式。
		join(moduleDir, nativePath),
		// 最后尝试可执行文件所在目录，execPath 缺省使用当前进程。
		join(dirname(options.execPath ?? process.execPath), nativePath),
	);
	// Set 按首次出现去重；只比较字符串，不解析软链接或保证同一文件只有一种写法。
	return Array.from(new Set(candidates));
}
