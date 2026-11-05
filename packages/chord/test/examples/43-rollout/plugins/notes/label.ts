// The label every host shows; the example edits it.

// 文件导读
// 所属：packages/chord/test/examples/43-rollout/plugins/notes/label.ts，插件 @example/notes 的普通源文件，
//   不是契约，也不导入 Chord。
// 演示什么：同一个模块被 server.ts 与 worker.ts 两个 facet 导入，构成 rollout 的“共享输入”。示例把插件目录
//   复制到临时目录后覆写本文件为 v2，watcher 因此把整个插件标脏；重新构建后，server 与 worker 的脚本里都
//   嵌入了新字符串。
// 上游/下游：上游是 main.ts 中的 writeFile 与构建器的打包；下游是 plugins/notes 的两个 facet。没有运行时
//   副作用；导出值在构建（打包）时被读取，而不是在服务器运行中动态读取。
// 能力清单：label，一个字符串常量。
// 典型调用顺序：初始构建读到 v1 -> 示例覆写为 v2 -> watcher 标脏 -> build -> rollout -> 两个 facet 都显示 v2。
// 示例（示例，不是本文件的额外运行代码）：修改后文件内容为 export const label = "v2";
// 建议阅读顺序：先看本文件，再看 server.ts 与 worker.ts 如何把 label 拼进 constant，最后看 main.ts 的编辑步骤。
export const label = "v1";
// `const` 让 TypeScript 把 label 的类型推断为字面量 "v1"；这是编译期信息，不阻止示例在构建前改写文件。
// 运行时导出的是一个普通字符串，构建器把它打进 facet 脚本。
