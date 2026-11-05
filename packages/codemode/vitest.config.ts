// defineConfig 帮助 TS 检查配置形状；加载配置不等于已经执行测试。
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// 为测试提供全局 API，并使用 Node 环境，非浏览器或真实 Cloudflare 环境。
		globals: true,
		environment: "node",
		// 环境变量非空时再增加 GitHub Actions 报告器；这不会选择是否运行 e2e。
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	// 两处条件使包的 source 导出优先于 dist，分别覆盖常规解析和服务端依赖解析。
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
