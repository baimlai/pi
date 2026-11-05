// The paths plugin's server facet: a script has no `__dirname` or `__filename` (it is evaluated with no file of its
// own); a file of the plugin is read through `pluginFile`. Each use is a build error.

// 文件导读
// 所属：Chord 示例 37 的 plugins/paths 插件，它的 server facet。
// 演示什么：插件脚本由 vm 求值，只有一段源码、没有自己的模块身份，因此没有 __dirname、__filename，也不能使用
// import.meta。构建器把自由的 __dirname/__filename 替换成内部标记，再扫描产物，把每处使用变成带文件、行、列的
// 构建错误；插件要读取自己的文件，应使用 @earendil-works/chord/plugins 的 pluginFile(path)。
// 注意：错误是静态产生的，即使这两行在 setup 回调里、本次加载从未执行，构建仍会失败。
// 同目录的 package.json（JSON 不能写注释，清单作用记录在这里）：`name: "@example/paths"` 是插件身份，
// `type: "module"` 是源码解析约定，`private: true` 防止误发布。
// 上游：main.ts 的 createPlugins 发现并构建所有 server facet；下游：构建器输出两条错误，插件在启动与重载时都被排除。
// 能力清单：
// - 默认导出：一个故意使用 __dirname/__filename 的 facet，永远不会被求值。
// 示例（真实构建错误文本，行列号随源码注释变化）：server.ts:<line>:<col>: import.meta.url, __dirname and
//   __filename are not available in a plugin script (a file of the plugin is read through pluginFile(path) ...)
// 建议阅读顺序：先看 node:path 的 join 为何允许，再看两处被禁止的路径全局。

// node:path 是 Node 内置模块：Node 构建中保持 external，求值时通过插件的 require 正常加载，因此允许。
import { join } from "node:path";
// Chord 的 API 是宿主包，保持 external，求值时由应用注入。
import { defineFacet } from "@earendil-works/chord";

// setup 在加载/重载时运行；但构建会先静态检查源码里的特殊标识符，所以下面的两行足以让整个 facet 构建失败。
export default defineFacet(() => {
	// __dirname 没有声明在任何地方；esbuild 的 define 先把它换成内部标记，构建结束时扫描标记并定位回这一行。
	// 正确做法是 pluginFile("data.json")，它返回本插件目录内文件的绝对路径。
	console.log(join(__dirname, "data.json"));
	// __filename 同样被替换并报告；插件脚本没有真实文件，不能依赖它。
	console.log(__filename);
});
