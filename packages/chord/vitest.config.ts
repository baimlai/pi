// 配置 Chord 的 Node 测试，并让支持 source 条件的工作区包优先解析到 TypeScript 源码。
// 例如在包目录运行 vitest --run test/contracts/params.test.ts 时，Vitest 会读取本对象；这里本身不启动测试。
// defineConfig 接收配置对象并原样返回；它的重载类型帮助编辑器检查选项，不是对外部数据做运行时校验。
import { defineConfig } from "vitest/config";

// Workspace packages (pi-telemetry, pi-schema) resolve to their sources, so Chord's tests need no build.
// 默认导出供 Vitest 加载；没有导入根 vitest.base.ts，因此这里使用条件解析，不继承根配置的 alias 列表。
// 原英文概括的是 source 导出路径；测试另外启动的 Node 子进程或 esbuild 仍可能读 dist，整套测试按仓库规则先构建。
export default defineConfig({
	// environment 指定在 Node 环境执行测试；不会为代码提供浏览器的 DOM。
	test: { environment: "node" },
	// 给 Vite 的模块解析启用自定义 source 条件；能否选中源码还取决于被导入包的 exports 是否提供此键。
	resolve: { conditions: ["source"] },
	// 服务端模块解析同样启用 source，避免服务端处理路径按另一组条件选中包的构建入口。
	ssr: { resolve: { conditions: ["source"] } },
});
