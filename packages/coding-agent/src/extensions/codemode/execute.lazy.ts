// codemode 第一次执行才调用本加载函数，延迟引入 worker/QuickJS 运行层；返回模块 Promise，加载错误以拒绝传播。
// 动态 import 是仓库已有设计，模块缓存由加载器负责；这里没有另存一个共享 Promise，也不在定义时执行脚本。
/** Loads the codemode sandbox runtime on the first script (see execute.ts). */
export const loadCodemodeExecutor = () => import("./execute.ts");
