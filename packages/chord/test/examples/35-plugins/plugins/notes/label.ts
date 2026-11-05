// 文件导读
// 所属：packages/chord/test/examples/35-plugins/plugins/notes/label.ts，示例 35 的 @example/notes 插件的共享源码（slice 7c）。
// 插件清单：同目录 package.json 声明 name "@example/notes"、private 与 type:module；本文件自身不是 facet，
// 真正的 facet 入口是 server.ts 与 worker.ts，二者都导入这里。
// 演示内容：一个普通（非 facet）模块被两个 facet 入口导入，esbuild 在构建时把它内联进各自的脚本；
// 因此 server 和 worker 的脚本各有一份拷贝，运行时不共享模块实例。main.ts 只改写临时副本中的这个文件，
// watcher 依据上次构建记录的文件输入把 @example/notes 标脏，重新构建后才出现 v2。
// 上游入口：notes/server.ts、notes/worker.ts 的静态 import；下游调用：无，只有字符串导出。
// 文件与副作用：不读文件、不写文件、无异步；源目录在示例中保持 v1，编辑发生在 main.ts 的临时副本。
// 失败行为：无运行时分支；若构建时文件缺失，esbuild 会把该 facet 报为 failed 构建。
// 能力清单：导出唯一常量 label（供 Index 与 Notes 状态成员使用）。
// 示例（真实签名）：export const label = "v1";
// 阅读顺序：先看这里的字面量，再看两个 facet 如何把它放进 constant；最后看 main.ts 如何改副本并重建。
// 运行方式：由 35-plugins/main.ts 间接构建/装载，不能单独运行；预期编辑前 notes/index 显示 v1，rollout 后显示 v2。
// 相关文档：packages/chord/docs/slice-7c.md §2（导入内联）与 §5（watcher 的输入归属）。
// The label both of the plugin's facets show; the example edits it.

// 导出供 server/worker 打包进各自脚本的字符串；main.ts 修改的是临时副本，当前源码仍从 v1 起步。
// `const` 声明让 TypeScript 把初始值收窄为字面量类型 "v1"；这是编译期信息，运行时保存的仍是普通字符串。
export const label = "v1";
