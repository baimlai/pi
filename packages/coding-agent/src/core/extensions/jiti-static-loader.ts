// 独立可执行程序/打包 Node 的 jiti 静态转译入口；让打包器看见 Babel 依赖并把它嵌进产物。
// 懒加载发生在上游 loader 对本文件的动态 import：一旦本文件真正求值，jiti/static 就会静态引入 Babel；不是 createJiti 自身仍延迟加载 Babel。
// Compiled binaries need jiti's static entry so Bun and SEA bundlers embed the
// Babel transform. The module itself remains lazy until an extension is loaded.
// 重导出 jiti/static 的 createJiti 值工厂；例如 SEA 加载扩展时取此工厂，但此行不创建实例、不执行用户扩展。
export { createJiti } from "jiti/static";
