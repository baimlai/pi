// 配置 Durable 在 Node 中的常规测试；独立的 workerd 测试使用 test-workers 内的配置。
// 读配置只构造路径和对象；setupFiles 指向的保留期设置在每个测试文件运行前执行。
// Node 的 URL 转路径工具能正确处理路径中的空格，不把 file: URL 字符串直接当作系统路径。
import { fileURLToPath } from "node:url";
// configDefaults 提供 Vitest 默认排除列表；defineConfig 用类型帮助检查配置并原样返回对象。
import { configDefaults, defineConfig } from "vitest/config";

// import.meta.url 是当前配置文件的 URL；new URL 的相对地址以它为基准，不依赖启动命令的当前目录。
const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
// 测试辅助入口单独定位；后面的精确别名只替换对应包路径，不匹配任意其他子路径。
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

// 默认导出的配置由 Vitest 消费；例如指定 test/harness-lifecycle.test.ts 后仍使用这里的测试环境与解析规则。
export default defineConfig({
	// test 分组控制测试执行，不是 TypeScript 编译器选项。
	test: {
		// 测试使用 Node 的全局环境；这不代表每项测试都不会访问进程、磁盘或网络。
		environment: "node",
		// Run in workerd by their own config: `npm run test:workers`.
		// ... 展开保留默认排除项，再加 Worker 目录，避免常规 Node 套件把 workerd 测试也收进去。
		exclude: [...configDefaults.exclude, "test-workers/**"],
		// 该文件读取 PI_DURABLE_DOCUMENT_RETENTION_MS；未定义时不覆盖默认值，定义时 Number 转换后传给设置函数。
		setupFiles: ["./test/setup-document-retention.ts"],
	},
	// resolve 是 Vite 模块解析规则；它不改变业务源码里的 import 字面量。
	resolve: {
		// 支持 source 导出条件的依赖可直接选中源码；没有此条件的子路径仍可能需要 dist。
		conditions: ["source"],
		// alias 按匹配规则替换模块地址；正则 ^ 和 $ 限定完整包名，\/ 在正则字面量里表示普通斜杠。
		alias: [
			// 包自身的根导入固定到当前工作区入口，避免误用已安装或旧 dist 版本。
			{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
			// /testing 也固定到源码；它是另一个精确入口，不会被上面的根名称正则匹配。
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
		],
	},
	// 服务端模块处理也启用 source 条件；这不向另起的 Node 子进程自动追加 --conditions=source。
	ssr: { resolve: { conditions: ["source"] } },
});
