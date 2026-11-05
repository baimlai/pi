// A file of the refused plugin, imported dynamically by its facet (refused).

// 文件导读
// 所属：Chord 示例 37 的 plugins/refused 插件，一个普通文件。
// 演示什么：refused/server.ts 里的字面量动态 `import("./other.ts")` 指向本文件。插件脚本不允许动态 import，
// 构建在解析该导入时直接拒绝，所以本文件既没有被复制进 facet 脚本，也从未被求值或执行。
// 上游：refused/server.ts 的 `void import("./other.ts")`；下游：无。
// 能力清单：
// - other：值为 1 的常量，仅作为被拒绝动态导入的目标。
// 示例（真实构建错误文本，行列号随源码注释变化）：server.ts:<line>:<col>: import("./other.ts"): a plugin script has
//   no dynamic import (a file of the plugin is read through pluginFile(path) ...)
// 建议阅读顺序：读完 refused/server.ts 的动态 import 注释后回来看本文件即可。

// 普通的 ES 模块命名导出；本文件在构建阶段就因导入规则被拒绝，因此没有运行时行为。
export const other = 1;
