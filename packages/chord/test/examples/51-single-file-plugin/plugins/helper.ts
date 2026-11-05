// 文件导读
// 所属：packages/chord/test/examples/51-single-file-plugin/plugins，插件根目录顶层的普通文件。
// 作用：文件名没有 kind 段，所以 discovery 不把它当插件；单文件插件也不能导入它（bad.server.ts 因此构建失败）。
// 上下游：只被 bad.server.ts 导入，用于触发拒绝；运行时不会执行。
// 能力：helper——一个字符串常量。
// 运行：由 main.ts 的 build 触发失败；不单独运行。
// 示例：export const helper = "a helper";
// 阅读顺序：本文件 -> bad.server.ts。
// A plain file at the root's top: not a plugin (its name has no kind), and no single-file plugin may import it.

export const helper = "a helper";
