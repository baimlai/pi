// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports/plugins/notes，notes 插件的 web 种类契约文件。
// 作用：文件名在扩展名前带 .web.，因此它是 web 种类文件：只有 web facet 能直接或间接导入它。search 的 web facet 合法
// 导入；peek 的 server facet 经 view.ts 间接导入，构建器按导入链拒绝。
// 上下游：build 的 onResolve 检查每个插件文件；本文件被 search/web.ts 使用，不参与 server 宿主运行。
// 能力：notesPanel——只读的常量对象 { title: "notes" }，供 web facet 拼面板标题。
// 运行：由 main.ts 的 build 阶段检查；命令见 50-plugin-imports/main.ts 文件头。
// 示例：import { notesPanel } from "../notes/contract.web.ts"; 只能在 web facet 中这样写。
// 阅读顺序：先看 as const 的类型效果，再读 search/web.ts 与 peek/view.ts 两个正反用例。
// The notes plugin's web contract file (a file of the web kind: `.web.` before its extension): only web facets may
// import it, directly or through other files.

/** The panel the notes plugin offers pages that list notes. */
// `as const` 把对象字面量收窄为只读字面量类型：title 的类型是 "notes" 而不是 string，属性也不可重新赋值。
// 这是编译期约束，运行时对象没有被冻结。
export const notesPanel = { title: "notes" } as const;
