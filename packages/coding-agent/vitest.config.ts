// 为 coding-agent 测试合并工作区源码别名、Node 环境及默认离线标记；这里只构造配置，不启动 CLI。
// defineConfig 的类型约束帮助编辑配置；mergeConfig 按 Vite 规则合并对象，数组选项通常拼接而非简单覆盖。
import { defineConfig, mergeConfig } from "vitest/config";
// baseConfig 提供通用别名，workspaceSourcePaths 提供已按配置文件 URL 解析好的绝对源码路径。
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// 先放公共配置，再放本包选项；例如本包测试使用 pi-ai 根入口时会落到工作区 ai/src/index.ts。
export default mergeConfig(
	baseConfig,
	// 第二个配置只补充本包规则；defineConfig 不检查运行时环境变量或测试输入是否合法。
	defineConfig({
		// test 下的选项由 Vitest 测试运行器消费。
		test: {
			// 允许测试直接使用 describe、it、expect 等全局 API；不会替代 TypeScript 的全局类型声明。
			globals: true,
			// 使用 Node 测试环境；文件或网络副作用仍取决于被执行的测试和业务代码。
			environment: "node",
			// 单个测试默认最多等待30秒；它不是整个套件、全部异步任务或外部进程的统一期限。
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			// 向测试进程注入字符串环境变量；PI_OFFLINE 由项目代码遵守，本配置不是操作系统网络沙箱。
			env: { PI_OFFLINE: "1" },
			// 每项测试前恢复 vi.stubEnv 记录的替换；不等于撤销测试中任意直接 process.env 赋值。
			unstubEnvs: true,
			// 三元表达式按环境变量字符串的真值选报告器；即使字符串是 "false"，也会选择 GitHub Actions 这一支。
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			// 隐藏通过用例的控制台日志，保留失败用例日志；不把全部运行器报告静音。
			silent: "passed-only",
			// 指定测试服务如何加载依赖，和上面的测试结果报告是不同配置层。
			server: {
				deps: {
					// 正则命中的 photon-node 保持为外部依赖，交给 Node 加载，避免经 Vite 转换其原生/WASM 包装。
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		// 为本包测试补充精确的源码地址替换；不会改写生产包的 exports 声明。
		resolve: {
			// 每条规则的 ^/$ 限制为完整入口；旧作用域名称也在测试中指向当前工作区实现。
			alias: [
				// 当前 pi-ai 包根入口。
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				// 当前 Agent 状态机入口。
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				// 历史作用域 pi-ai 根入口，供旧扩展示例或测试夹具使用。
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				// 历史作用域 OAuth 入口单独替换，根入口正则不会吞掉这个子路径。
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				// 历史 Agent 包名仍使用当前源码，不另加载一份旧 Agent 实现。
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				// 历史 TUI 包名固定到当前工作区 TUI 入口。
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
