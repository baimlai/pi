// MCP包的手写Vitest配置：Node运行环境、条件reporter和source导出条件；加载配置不代表所有测试都安全无I/O，具体副作用要读用例。
// defineConfig提供类型/配置辅助，不在这个调用里执行本包测试或构建dist。
import { defineConfig } from "vitest/config";

// 默认导出此配置对象，Vitest启动时读取；它没有限制用例文件名或自动排除真实本机传输测试。
export default defineConfig({
	// test区集中放测试运行选项，不是MCP客户端的业务参数。
	test: {
		// 允许测试里使用全局测试API；现有stdio文件仍显式import它们，globals不会阻止这种写法。
		globals: true,
		// 在Node测试环境运行，非浏览器DOM模拟；Node内置流、子进程等仍是真实API，除非用例主动mock。
		environment: "node",
		// GITHUB_ACTIONS环境值真值时加github-actions报告器，否则仅dot；字符串false也是真值，不做布尔解析。
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	// 给Vite解析加入source条件，workspace包有匹配exports时优先源码分支；不是自动编译所有依赖或保证每包都有该条件。
	resolve: { conditions: ["source"] },
	// SSR解析同样声明source条件，供服务端模块解析路径使用；不会自行启动HTTP服务或SSR网页。
	ssr: { resolve: { conditions: ["source"] } },
});
