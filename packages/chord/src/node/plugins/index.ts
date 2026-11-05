// Chord v2's plugins component (`@earendil-works/chord/plugins`; slices 7c, 12): plugin directories and single-file
// plugins found, built into scripts checked against the app's API, evaluated, loaded and reloaded per plugin, watched,
// rolled out and installed, and a plugin tested alone. Node-only (`fs`, esbuild, `vm`); esbuild is an optional peer
// dependency, imported only here.

// 本文件是 plugins 子模块的公共出口（barrel）：Node 端应用从这里导入发现、构建、求值、安装、运行时、测试和监视
// API。上游是应用代码的 import "@earendil-works/chord/plugins"，下游分别落到各同名源文件；本文件不执行任何逻辑，
// 但本出口有运行时值导出 buildFacet，ESM 会因此加载 build.ts，而 build.ts 顶层静态导入 esbuild；需要“只求值、不构建”时用 ./plugins/runtime 入口。
// export { type X, value } 中的 type 修饰符只导出类型，编译后被擦除；不带 type 的标识符才是运行时绑定。
// 构建：buildFacet 把插件的 facet 入口打成一段脚本，同时给出摘要和读到的输入文件。
// 文件导读
// 所属模块：packages/chord/src/node/plugins，Chord v2 的 Node 端插件组件；本文件是整个子模块的公共出口。
// 职责边界：只重新导出各实现文件的能力，不含逻辑、不创建对象、不读取文件系统。应用通过
// `@earendil-works/chord/plugins` 进入；真正执行代码的是 build/discover/evaluate/install/plugins/runtime/testing/watcher。
// 上游入口：应用代码的 import，或 Chord 其他模块对插件组件的引用；esbuild 是可选 peer 依赖，但本出口重导出 buildFacet，
// 加载时也会加载 build.ts 及其顶层 esbuild 导入，因此只做 worker 侧求值时应使用 ./plugins/runtime 入口。
// 下游依赖：./build.ts、./discover.ts、./evaluate.ts、./install.ts、./plugins.ts、./runtime.ts、./stack.ts、
// ./testing.ts、./watcher.ts，本文件不改变它们的导出形状。
// 结果与错误流向：这里没有运行时结果或错误；调用各函数得到的值/异常按原样穿过再导出。
// 能力清单（按来源文件）：
// - build.ts：buildFacet 把某插件的某 facet 打成脚本；BuiltFacet 是 script/failed 联合；BuildOptions/BuildInput/AppApi
//   描述构建输入、应用 API 与公共资源路径。
// - discover.ts：discoverPlugins 列根目录插件；Plugin、PluginRoot、Discovery、DiscoveryOptions、DiscoveryProblem 描述
//   插件记录、根配置、发现结果与问题。
// - evaluate.ts：evaluateFacet 执行已构建脚本得到 Facet；BuiltScript、EvaluateOptions、HostPackages、pluginFile 描述
//   可求值脚本、求值输入、宿主包和插件内文件路径能力。
// - install.ts：installDependencies 安装插件依赖；installPlugin 从 git/npm 安装新插件；PluginSource、InstallOptions、
//   InstallPluginOptions 描述来源和选项。
// - plugins.ts：createPlugins 创建完整组件；Plugins、PluginsOptions、KindDefinition、PluginsError、Built、
//   RolloutHost、RolloutStep、RolloutResult 描述组件、配置、种类、错误与灰度发布步骤。
// - runtime.ts：createPluginRuntime 创建“只求值、不构建”的运行时；PluginRuntime、RuntimeLoad、PluginScript、
//   PluginError 描述加载/重载接口、输入、脚本和必选插件失败。
// - stack.ts：mapStack 把插件堆栈位置映射回源文件。
// - testing.ts：testPlugin 在内存宿主上单独测试插件；TestPluginOptions、TestedPlugin 描述测试输入与结果。
// - watcher.ts：PluginsState 是文件监视产生的标记状态（脏、待安装、待发现等）。
// 组合与典型顺序：discoverPlugins 得到 Plugin 记录 -> buildFacet 构建 -> evaluateFacet 求值（或由 runtime 代做）->
// Plugins 组件把三者与 watcher、rollout 组合；installPlugin 之后通常重新发现并构建；testPlugin 复用构建与求值但换成
// 内存宿主。只做 worker 侧加载时用 createPluginRuntime，不需要 esbuild。
// 示例：import { discoverPlugins } from "@earendil-works/chord/plugins";
// const discovery = await discoverPlugins(["./plugins"], { kinds: ["server", "worker"] }, context);
// discovery.plugins 是 Plugin[]，discovery.problems 是 DiscoveryProblem[]；这是真实签名，但示例只展示发现这一层，
// 不会自动构建或加载插件。
// 建议阅读顺序：先读 discover.ts 的 Plugin 形状，再读 build.ts 的 BuiltFacet，然后 evaluate.ts、runtime.ts，
// 最后 plugins.ts 看组件如何组合；watcher/testing/install/stack 可按需要单读。
export { type AppApi, type BuildInput, type BuildOptions, type BuiltFacet, buildFacet } from "./build.ts";
// 发现：从根目录扫描插件目录、单文件插件和 chord.plugins 清单，得到 Plugin 列表与问题列表。
export {
	type Discovery,
	type DiscoveryOptions,
	type DiscoveryProblem,
	discoverPlugins,
	type Plugin,
	type PluginRoot,
} from "./discover.ts";
// 求值：在 Node 的 vm 中执行已构建脚本，向插件提供 require、pluginFile 和应用的 API 模块。
export { type BuiltScript, type EvaluateOptions, evaluateFacet, type HostPackages, pluginFile } from "./evaluate.ts";
// 安装：用 npm/git 把插件装到根目录，并在插件目录内安装其依赖。
export {
	type InstallOptions,
	type InstallPluginOptions,
	installDependencies,
	installPlugin,
	type PluginSource,
} from "./install.ts";
// 组件：把发现、构建、求值、加载、重载、监视和灰度发布串成一个 Plugins 对象；应用通过 createPlugins 使用它。
export {
	type Built,
	createPlugins,
	type KindDefinition,
	type Plugins,
	type PluginsError,
	type PluginsOptions,
	type RolloutHost,
	type RolloutResult,
	type RolloutStep,
} from "./plugins.ts";
// 运行时：在宿主上按插件逐个加载/重载已构建的脚本；PluginError 汇总必选根目录的失败。
export {
	createPluginRuntime,
	PluginError,
	type PluginRuntime,
	type PluginScript,
	type RuntimeLoad,
} from "./runtime.ts";
// 堆栈映射：把插件脚本报错的位置改回插件源文件的行列。
export { mapStack } from "./stack.ts";
// 测试：testPlugin 在内存 SQLite 和桩模块上单独加载一个插件，供插件作者写测试。
export { type TestedPlugin, type TestPluginOptions, testPlugin } from "./testing.ts";
// 监视：watcher 产生的 PluginsState（脏、待安装、待发现等标记），供组件与外部观察者读取。
export type { PluginsState } from "./watcher.ts";
