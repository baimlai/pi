// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/greeter/label.ts，@example/greeter 的普通源文件。
// 演示什么：它不是 facet，而是被 server.ts 导入并在构建时内联的文本模块。main.ts 只改副本：先制造语法错误，
// 再修复并替换问候文本，用来观察构建失败与后续重载。
// 上游入口：greeter/server.ts 的 import；buildFacet 读取并内联本文件，watcher 把本文件计入 greeter 的 inputs，
// 所以改它会把 greeter 标脏。
// 下游依赖：无。上一级目录的 package.json 由 discoverPlugins 读取，name 是插件身份。
// 能力清单：导出 greeting 字符串常量。
// 示例（真实签名）：import { greeting } from "./label.ts"; host.serve(Greeting, () => ({ text: constant(greeting) }));
// 典型运行：启动 running 中问候为 hello；第 2 幕语法错误使 greeter 构建失败；修复后依次变为 hi 和 hey。
// 建议阅读顺序：只有导出常量，先读文件头再看 export。
// The greeting's text; the example breaks it with a syntax error, then fixes it.

// 导出被构建器复制进 greeter 脚本的文本；main 在临时副本制造/修复语法错误，不改此原件。
// const 让 TypeScript 把 greeting 推断为字符串字面量类型；运行时它只是普通字符串，没有额外校验。
export const greeting = "hello";
