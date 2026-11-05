// 连接、传输和 OAuth 运行层的延迟加载入口，供 MCP 扩展/命令按需取得连接类等导出；这里只定义加载函数，import 在调用时才执行。
// 动态 import 返回模块的 Promise，加载失败以拒绝传播；这里只借用模块系统缓存，没有另外保证多次调用返回同一个 Promise。
// 这是仓库已有的 lazy 机制，保持原表达式；加载模块本身会执行其顶层代码，不等于已经连接远端或启动 MCP 进程。
/** Loads the MCP client, transports, and OAuth sign-in on first use (see runtime.ts). */
export const loadMcpRuntime = () => import("./runtime.ts");
