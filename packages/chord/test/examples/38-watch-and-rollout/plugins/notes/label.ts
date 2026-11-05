// 文件导读
// 所属：packages/chord/test/examples/38-watch-and-rollout/plugins/notes，示例 38 的 notes 插件共享标签文件。
// 作用：server.ts 和 worker.ts 都导入 label，模块求值时把当时的值打包进各自的构建脚本；示例第 2、4、5、6 步逐步
// 编辑这行字符串，用 watcher 的 dirty 标记驱动重建。修改它只会让 notes 变脏（这是 notes 自己的文件）。
// 上游：notes/server.ts、notes/worker.ts 的 import；下游：无。输出：一个字符串常量，没有 I/O 或副作用。
// 能力清单：导出 label，初始值为 v1 字符串。
// 示例（真实运行时行为）：第一次构建出的两个 facet 都包含 v1 文本；把值改成 v2 并重建后，新的 facet 才包含 v2。
// 已加载的旧对象不会因为源文件变化而自动更新。
// 建议阅读顺序：先看 main.ts 第 2 步的编辑，再看两个 facet 如何用模板字符串拼出最终文本。

// The notes' label; the example edits it.

// 导出供两个 facet 打包进脚本的字符串；示例编辑的是临时副本，仓库中的源码仍从 v1 开始。
export const label = "notes v1";
