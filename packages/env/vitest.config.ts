// 本包的测试配置：在 Node 中执行测试，并让支持 source 条件的工作区依赖直接加载 TypeScript 源码。
import { defineConfig } from "vitest/config";

// defineConfig 的对象重载提供配置的 TypeScript 类型提示；export default 把对象交给 Vitest，加载配置本身不运行测试。
// 例：从本包运行指定 test/connection.test.ts 时采用这些选项；此处没有排除 SSH 测试或自动启动 daemon。
export default defineConfig({
	test: {
		// 使用 Node 测试环境，测试可访问文件/进程 API；这不是隔离操作系统副作用的沙箱。
		environment: "node",
	},
	resolve: {
		// 导入包时允许匹配 exports.source，例如 pi-env 的源码入口，而非只能使用已经构建的 dist。
		conditions: ["source"],
	},
	// 对服务端依赖解析也启用同一条件；条件只影响具备对应 exports 分支的包，不会替代 Rust 二进制构建。
	ssr: { resolve: { conditions: ["source"] } },
});
