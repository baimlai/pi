// Chord v2's terminal launcher (`@earendil-works/chord/tui/launcher`; slice 11 §4): the trusted Node side of a terminal
// client, running the app's terminal code in the sandbox.
//
// 文件导读
// 所属：packages/chord 的 Node 端终端启动器模块（子路径导出 `@earendil-works/chord/tui/launcher`）。
// 职责边界：这是一个 barrel（汇总再导出）文件，不实现任何逻辑、不持有状态，只决定哪些符号可以从子路径导入。
// 上游：使用终端客户端的 Node 应用从这里导入启动函数；下游：同目录 credentials.ts（token 来源）、filter.ts
// （输出白名单）、launcher.ts（启动与消息循环）、sandbox.ts（子进程）。结果与错误都沿 launcher 的 Promise 返回，
// 本文件不包装也不吞掉任何错误。
// 能力清单（按导出项）：
// - PromptTerminal：向真实终端显示确认问题并读取 y/N 的接口类型，仅编译期存在。
// - TerminalCredentials：token 的三种来源联合（直接给出、文件、设备配对）。
// - filterOutput：把沙箱输出清洗为只含安全终端序列的函数。
// - TerminalOptions / RunningTerminal：启动选项与运行句柄的类型。
// - startTerminal：完成登录、下载、启动沙箱并接管终端的异步入口。
// - terminalFile：校验并解析终端 surface 文件路径的辅助函数。
// - requireSandboxNode：Node 版本门槛检查，不满足时抛错。
// 组合关系与典型顺序：应用先准备 TerminalCredentials，调用 startTerminal；它内部经 tokenOf 取 token、下载 bundle、
// 启动 Sandbox，之后沙箱输出由 filterOutput 过滤，退出时通过 RunningTerminal.exited 得知退出码。
// 示例：`import { startTerminal } from "@earendil-works/chord/tui/launcher";
// const running = await startTerminal({ url: "http://127.0.0.1:8788", credentials: { kind: "token", token } });
// const code = await running.exited;`
// 阅读顺序：先看 launcher.ts 的 TerminalOptions/RunningTerminal/startTerminal，再看 credentials.ts 与 sandbox.ts；
// 想理解安全边界时读 filter.ts 与 pipe.ts。`export type` 只在编译期存在，不会产生运行时导出。

// 转发“在真实终端上向用户提问”的接口类型；类型擦除后运行时没有对应对象。
export type { PromptTerminal } from "./actions.ts";
// 凭据来源的联合类型（直接 token、token 文件、设备配对）；这是编译期描述，运行时的真实校验在 credentials.ts。
export type { TerminalCredentials } from "./credentials.ts";
// 输出过滤器：把沙箱发来的帧清洗成只含安全终端序列的文本，实际实现在 filter.ts。
export { filterOutput } from "./filter.ts";
// 启动并控制一个终端客户端；同时导出启动选项与运行结果类型（后两者仅编译期存在）。
// 注意 `export { type X, fn }` 混合写法：`type` 修饰符让 X 只作为类型导出，fn 仍是普通运行时导出。
export { type RunningTerminal, startTerminal, type TerminalOptions, terminalFile } from "./launcher.ts";
// Node 版本门槛检查：沙箱依赖较新的权限模型，版本不足时启动会失败。
export { requireSandboxNode } from "./sandbox.ts";
