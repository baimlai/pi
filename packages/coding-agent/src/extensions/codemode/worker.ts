/**
 * Worker entry for the codemode sandbox in bundled builds. The Node bundle and the Bun binary
 * build this file as a separate entrypoint because pi-codemode's own worker file is not on disk
 * there; `getCodemodeWorkerSpecifier()` in config.ts resolves it.
 */
// 打包时独立 worker 的手写入口：只加载 pi-codemode/worker 的顶层安装逻辑，没有导出用户函数。
// Node bundle/Bun binary 需要把这个入口包含为单独产物，config.ts 按分发形式选择它；不是在宿主直接运行模型给的脚本。
// 这个没有绑定变量的 import 是副作用导入，执行被导入模块的初始化；不等于导入其所有名称到当前作用域。
import "@earendil-works/pi-codemode/worker";
