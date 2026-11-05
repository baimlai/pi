// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/app，示例 38 的“应用基础代码”（base code），不是插件。
// 作用：main.ts 把整个 app/ 目录传给 createPlugins 的 base 选项；watcher 监视它，其中任何变化都只设置
// PluginsState.base = true。Chord 不会因此重启任何 host——这是应用的职责（真实应用在 base 变化后重启服务器和
// worker，让新代码生效），本示例只打印标记。
// 上游：本文件不被 main.ts import，只由 watcher 按路径监视；下游：无。
// 能力清单：导出常量 appName，作为“应用自己的配置”的占位内容。
// 示例（真实运行时行为）：main.ts 把 appName 的值从 example 改成 example 2 后，
// watcher 置 base；随后运行的构建和发布都不会清除它，只有应用自己重启才能消除。
// 建议阅读顺序：先看 main.ts 第 1 步的 base 选项和第 2 步末尾的编辑，再回到本文件。

// The app's own code (base code): the plugins component watches it and marks `base` when it changes; Chord restarts
// nothing for it, the app restarts its hosts.

// 这个字符串就是 main.ts 编辑的目标；构建插件时不会读取它，所以修改它不会让任何插件变脏。
export const appName = "example";
