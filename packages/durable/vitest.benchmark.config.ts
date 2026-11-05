// 配置 Durable 的存储性能基准；npm 脚本 bench:storage 用 vitest bench 加载它。
// 这里独立定义配置，没有合并常规测试配置，所以不会自动加入其 setupFiles 或 Durable 自身的 alias。
// defineConfig 提供配置类型提示并返回输入对象；加载本文件不会直接执行基准函数。
import { defineConfig } from "vitest/config";

// 默认导出由 Vitest 的 benchmark 模式读取；输入是下面的静态对象，结果是同一个配置对象。
export default defineConfig({
	// 基准属于 test 配置中的 benchmark 分组，与普通 test.include 的收集规则分开。
	test: {
		// 在 Node 环境测量，不创建浏览器或 Worker 运行时。
		environment: "node",
		// 只有以 bench 模式启动时，这些选项才用于收集与报告性能基准。
		benchmark: {
			// ** 匹配 test 下任意层级；只收集名称以 .bench.ts 结尾的文件。
			include: ["test/**/*.bench.ts"],
			// verbose 输出每组基准的详细结果；它不是性能阈值或通过标准。
			reporters: ["verbose"],
		},
	},
	// 依赖包若声明 source 条件，可在此优先使用源码，而不是默认构建入口。
	resolve: { conditions: ["source"] },
	// 服务端模块解析使用相同 source 条件；不保证所有依赖或子进程都绕过构建产物。
	ssr: { resolve: { conditions: ["source"] } },
});
