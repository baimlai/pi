// pi mcp 命令层的延迟加载入口，供命令分派按需使用；这里只定义加载函数，import 在调用时才执行。
// 动态 import 返回模块的 Promise，加载失败以拒绝传播；这里只借用模块系统缓存，没有另外保证多次调用返回同一个 Promise。
// 这是仓库已有的 lazy 机制，保持原表达式；加载模块本身会执行其顶层代码，不等于已经连接远端或启动 MCP 进程。
/** Loads `pi mcp` and the MCP runtime only when the command runs (see cli.ts). */
export const loadMcpCommand = () => import("./cli.ts");
