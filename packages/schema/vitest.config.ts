// 为pi-schema测试选择Node环境、输出报告及工作区源码解析；本配置不会自动运行测试，也不加载benchmark候选。
// 从Vitest配置入口导入带类型提示的辅助函数；本机defineConfig运行时直接返回传入配置，不额外验证字段。
import { defineConfig } from "vitest/config";

// 默认导出测试配置对象，供Vitest发现此文件后读取。例从本包运行指定builders.test.ts，会采用下面选项；这里只组装数据。
export default defineConfig({
	// test集中声明测试运行选项，与下面Vite模块解析选项处于不同层级。
	test: {
		// 把describe/it/expect等API注册为测试全局；显式import这些API的测试也仍可使用它们。
		globals: true,
		// 使用Node测试环境，不提供jsdom浏览器DOM；不是因此禁止测试发网络请求。
		environment: "node",
		// 三元表达式按环境变量字符串的truthy值选报告器；例如字符串false也走GitHub分支。CI分支同时输出dot与GitHub Actions报告。
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	// Vite解析包条件导出时启用source条件，例如pi-schema包指向src/index.ts；不是把任意dist导入自动改写成源码。
	resolve: { conditions: ["source"] },
	// SSR模块解析路径同样启用source条件；外部化依赖还有自己的解析机制，不能据此承诺所有依赖均从源码加载。
	ssr: { resolve: { conditions: ["source"] } },
});
