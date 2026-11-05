// The refused plugin's server facet: imports a facet script may not have, each a build error with its file and line.
// A script is evaluated with no module identity: no `import.meta` (a file of the plugin is read through `pluginFile`),
// no literal dynamic `import()`; and base code is reached through a host package, not by its path.

// 文件导读
// 所属：Chord 示例 37 的 plugins/refused 插件，它的 server facet。
// 演示什么：一个 facet 同时犯三种构建期禁止的错误，每次都在同一次构建报告里给出文件、行、列：
// 1. 用相对路径导入 base code（../../app/index.ts）：相对路径不能离开插件的 root；应用代码应通过宿主包导入。
// 2. 读取 import.meta.url：插件脚本没有模块身份。
// 3. 使用字面量动态 import("./other.ts")：插件脚本不允许动态 import（计算出的 import(x) 构建时看不见，会在运行时
//    被降级为 require 并走求值器的规则）。
// setup 回调本身不会执行：构建在求值之前就失败了。
// 同目录的 package.json（JSON 不能写注释，清单作用记录在这里）：`name: "@example/refused"` 是插件身份，
// `type: "module"` 是源码解析约定，`private: true` 防止误发布。
// 上游：main.ts 的 createPlugins 发现并构建所有 server facet；下游：构建器输出三条错误，插件在启动与重载时都被排除。
// 能力清单：
// - 默认导出：一个包含全部被禁导入的 facet，永远不会被求值。
// 示例（真实构建错误文本，行列号随源码注释变化）：server.ts:<line>:<col>: "../../app/index.ts": outside the plugin's
//   root (base code is reached through a host package, other repositories' plugins through dependencies)
// 建议阅读顺序：先看两条静态 import（一条宿主包、一条越界路径），再看 setup 里的 import.meta 和动态 import。
// 相关文件：同目录的 other.ts 是动态 import 的目标。

// 宿主包导入：允许，构建保持 external。
import { defineFacet } from "@earendil-works/chord";
// 相对路径向上离开 plugins/refused 目录，进入应用的 app/ 目录：构建错误，因为相对导入只能在同一 root 的插件之间。
// 正确方式是把 app 作为宿主包（本例的 @example/app）由应用传入。
import app from "../../app/index.ts";

// defineFacet 只记录 setup；构建失败发生在它被调用之前，因此下面的代码从未执行。
export default defineFacet(() => {
	// import.meta 在 CommonJS 产物中没有意义；构建把 esbuild 的 empty-import-meta 日志提升为 error，因此这里是构建错误。
	console.log(import.meta.url, app.name);
	// import() 返回 Promise；void 只表示“有意丢弃这个值”，不会让导入变得合法。字面量说明符在构建时被识别并拒绝。
	// 计算出的 import(x) 构建时无法检查，但运行时会走 facet 的 require 规则，同样受限。
	void import("./other.ts");
});
