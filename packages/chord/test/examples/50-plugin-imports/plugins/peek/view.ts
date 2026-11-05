// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/plugins/peek，peek 插件的辅助文件（不是 facet）。
// 作用：把 notes 的 web 种类契约文件重新导出（re-export），演示构建器会跟随 re-export 链检查种类，即使中间文件本身
// 没有 kind 后缀。
// 上下游：peek/server.ts 导入本文件；本文件导入 ../notes/contract.web.ts；build 在解析相对导入时记录整条链并拒绝。
// 能力：转发导出 notesPanel，没有本地绑定。
// 运行：由 main.ts 的 build 触发；不能单独运行。
// 示例：export { notesPanel } from "../notes/contract.web.ts";
// 阅读顺序：本文件 -> peek/server.ts。
// A helper of the peek plugin that re-exports the notes plugin's web contract file.

// `export { x } from "…"` 是转发导出：不在本模块创建 x 的本地绑定，构建器仍会解析目标模块并检查其种类。
export { notesPanel } from "../notes/contract.web.ts";
