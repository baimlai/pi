// 文件导读
//
// 所属：仓库根目录的共享构建配置，不是测试文件。上游由 packages/coding-agent/vitest.config.ts、
// packages/evals/vitest.test.config.ts 与 packages/evals/vitest.evals.config.ts 导入；evals 的
// Docker 镜像也会把本文件复制进 /repo 供容器内配置使用。下游是 Vitest 的 defineConfig 结果。
//
// 作用：把工作区包名（如 @earendil-works/pi-ai）在测试时解析到对应 packages/*/src 源码，而不是
// node_modules 中已构建的 dist。这样大多数测试改源码后无需先 build；仍然依赖 dist 的测试
//（例如会启动 Node 子进程或 esbuild 打包的 Chord/Durable 测试）另需构建。导出的
// workspaceSourcePaths 还供消费方补充自己的别名。
//
// 能力清单：
// - workspaceSourcePaths：以本配置文件位置解析出的绝对源码路径常量表。
// - default defineConfig：只配置 resolve.alias，没有 test 选项；消费方通过 mergeConfig 追加。
//
// 运行方式与副作用：由 Vitest 加载配置时执行，没有独立 CLI；只计算路径、构造普通对象，不读文件、
// 不建目录、不启动子进程。路径基于 import.meta.url，因此从任意 cwd 运行或在 Docker 中复制后仍
// 指向同仓库相对位置。示例（真实签名）：
//   import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";
//   export default mergeConfig(baseConfig, defineConfig({ resolve: { alias: [...] } }));
//
// 建议阅读顺序：先看 workspaceSourcePaths 的分组，再看 alias 数组的顺序与通配规则，最后看哪些
// 入口（如 pi-coding-agent）故意留给消费方自行添加。
import { fileURLToPath } from "node:url";
// defineConfig 只提供类型约束与恒等包装；它不会在运行时校验 alias 是否命中。
import { defineConfig } from "vitest/config";

// 每个值都是绝对文件路径：new URL(相对路径, import.meta.url) 以本文件为基准解析，再由
// fileURLToPath 转成本地路径。as const 让属性为只读字符串字面量类型，消费方可直接当路径使用。
export const workspaceSourcePaths = {
	// Chord v2 的入口与子路径；每个键对应一个生产包导出或测试需要的源码文件。
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordJson: fileURLToPath(new URL("./packages/chord/src/json.ts", import.meta.url)),
	chordWatch: fileURLToPath(new URL("./packages/chord/src/watch.ts", import.meta.url)),
	chordOutput: fileURLToPath(new URL("./packages/chord/src/output.ts", import.meta.url)),
	chordSqlite: fileURLToPath(new URL("./packages/chord/src/sqlite/index.ts", import.meta.url)),
	chordSqliteNode: fileURLToPath(new URL("./packages/chord/src/sqlite/node.ts", import.meta.url)),
	chordSqliteCloudflare: fileURLToPath(new URL("./packages/chord/src/sqlite/cloudflare.ts", import.meta.url)),
	chordTelemetrySqlite: fileURLToPath(new URL("./packages/chord/src/telemetry-sqlite/index.ts", import.meta.url)),
	chordHttp: fileURLToPath(new URL("./packages/chord/src/node/http/index.ts", import.meta.url)),
	chordWorkers: fileURLToPath(new URL("./packages/chord/src/node/workers/index.ts", import.meta.url)),
	chordPlugins: fileURLToPath(new URL("./packages/chord/src/node/plugins/index.ts", import.meta.url)),
	chordPluginsRuntime: fileURLToPath(new URL("./packages/chord/src/node/plugins/runtime.ts", import.meta.url)),
	chordApp: fileURLToPath(new URL("./packages/chord/src/node/app/index.ts", import.meta.url)),
	chordWeb: fileURLToPath(new URL("./packages/chord/src/web/index.ts", import.meta.url)),
	chordSurfaces: fileURLToPath(new URL("./packages/chord/src/node/surfaces/index.ts", import.meta.url)),
	chordReact: fileURLToPath(new URL("./packages/chord/src/react/index.ts", import.meta.url)),
	chordTui: fileURLToPath(new URL("./packages/chord/src/tui/index.ts", import.meta.url)),
	chordTuiLauncher: fileURLToPath(new URL("./packages/chord/src/node/tui/index.ts", import.meta.url)),
	chordOld: fileURLToPath(new URL("./packages/chord/src/old/index.ts", import.meta.url)),
	chordOldNode: fileURLToPath(new URL("./packages/chord/src/old/node.ts", import.meta.url)),
	// telemetry 的运行时入口与测试辅助入口。
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	// pi-ai 的根入口与二级入口；api/providers/utils 是目录，供通配别名拼接子路径。
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiModels: fileURLToPath(new URL("./packages/ai/src/models.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	// Agent 与 codemode 的源码入口；编码在 alias 列表中使用，而不是靠包名自动推导。
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	// coding-agent 路径已导出但不在下方默认 alias 中：本包自己的测试配置不需要把自身包名
	// 指向源码，evals 配置则显式添加它，避免所有消费方都被迫接受同一条规则。
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	// pi-tui 的源码入口，供终端组件测试绕过 dist。
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
	// as const 不是运行时冻结；对象仍可变，只是类型层面收窄为只读字面量。
} as const;

// 默认配置只有别名；没有 test 选项，因此不规定环境、超时或包含规则，由消费方合并决定。
export default defineConfig({
	resolve: {
		// Vitest 按数组顺序匹配，命中第一条即停止；因此下面先列完整入口，再列带捕获组的
		// 子路径通配，避免根级规则误吞子路径。每条的 ^ 与 $ 把匹配限制在完整说明符上。
		alias: [
			{ find: /^@earendil-works\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@earendil-works\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@earendil-works\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@earendil-works\/chord\/json$/, replacement: workspaceSourcePaths.chordJson },
			{ find: /^@earendil-works\/chord\/watch$/, replacement: workspaceSourcePaths.chordWatch },
			{ find: /^@earendil-works\/chord\/output$/, replacement: workspaceSourcePaths.chordOutput },
			{ find: /^@earendil-works\/chord\/sqlite$/, replacement: workspaceSourcePaths.chordSqlite },
			{ find: /^@earendil-works\/chord\/sqlite\/node$/, replacement: workspaceSourcePaths.chordSqliteNode },
			{ find: /^@earendil-works\/chord\/sqlite\/cloudflare$/, replacement: workspaceSourcePaths.chordSqliteCloudflare },
			{ find: /^@earendil-works\/chord\/telemetry-sqlite$/, replacement: workspaceSourcePaths.chordTelemetrySqlite },
			{ find: /^@earendil-works\/chord\/http$/, replacement: workspaceSourcePaths.chordHttp },
			{ find: /^@earendil-works\/chord\/workers$/, replacement: workspaceSourcePaths.chordWorkers },
			{ find: /^@earendil-works\/chord\/plugins$/, replacement: workspaceSourcePaths.chordPlugins },
			{ find: /^@earendil-works\/chord\/plugins\/runtime$/, replacement: workspaceSourcePaths.chordPluginsRuntime },
			{ find: /^@earendil-works\/chord\/app$/, replacement: workspaceSourcePaths.chordApp },
			{ find: /^@earendil-works\/chord\/web$/, replacement: workspaceSourcePaths.chordWeb },
			{ find: /^@earendil-works\/chord\/surfaces$/, replacement: workspaceSourcePaths.chordSurfaces },
			{ find: /^@earendil-works\/chord\/react$/, replacement: workspaceSourcePaths.chordReact },
			{ find: /^@earendil-works\/chord\/tui$/, replacement: workspaceSourcePaths.chordTui },
			{ find: /^@earendil-works\/chord\/tui\/launcher$/, replacement: workspaceSourcePaths.chordTuiLauncher },
			{ find: /^@earendil-works\/chord\/old$/, replacement: workspaceSourcePaths.chordOld },
			{ find: /^@earendil-works\/chord\/old\/node$/, replacement: workspaceSourcePaths.chordOldNode },
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@earendil-works\/pi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@earendil-works\/pi-mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@earendil-works\/pi-mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@earendil-works\/pi-mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
		{ find: /^@earendil-works\/pi-ai\/models$/, replacement: workspaceSourcePaths.aiModels },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			// 通配规则：(.+) 捕获子路径，$1 在 replacement 中回填，并强制补 .ts 扩展名。
			// 因此只支持源码文件名与出口路径同名且扩展名为 .ts 的情况；其他扩展名不会命中。
			{
				find: /^@earendil-works\/pi-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@earendil-works\/pi-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@earendil-works\/pi-codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^@earendil-works\/pi-codemode\/declarations$/, replacement: workspaceSourcePaths.codemodeDeclarations },
			{ find: /^@earendil-works\/pi-codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			// 注意：这里没有 @earendil-works/pi-coding-agent 的默认规则；需要它的配置（如 evals）
			// 自行追加，指向 workspaceSourcePaths.codingAgentIndex。
			{ find: /^@earendil-works\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
