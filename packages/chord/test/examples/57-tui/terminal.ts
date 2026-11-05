// 文件导读
// 所属：packages/chord/test/examples/57-tui，Chord 示例 57 的交互式终端客户端。
// 作用：在真实终端里运行 board 的终端界面。本进程是可信启动器：它用 token 文件登录服务器，
// 下载终端基础 bundle 与插件脚本，把代码放进 Node 权限模型沙箱的子进程执行，并转发终端输入、
// 输出与链路；下载的代码拿不到文件系统、进程、网络或真实终端。按 q 退出。
// 上游：从 packages/chord 运行，且 57-tui/main.ts --serve 已打印 url 与 token 文件路径：
//   node26 --conditions=source test/examples/57-tui/terminal.ts <url> <token file>
// 下游：src/node/tui/index.ts 的 startTerminal；它返回 RunningTerminal（exited、stop）。
// 能力清单：
// - 解析 argv 中的 url 与 token 文件路径；
// - startTerminal 使用默认的标准输入输出并接管终端原始模式；
// - 把客户端退出码写入 process.exitCode，再销毁 stdin 让事件循环自然结束。
// 典型行为：进入备用屏幕/原始模式显示 Board 与插件行；q 后恢复终端，进程退出码 0。
// 阅读顺序：先看 argv 解析与两个非空断言，再看 exitCode/stdin 的收尾。
// 前置条件：Node 26.5.1+（沙箱需要权限模型）；服务器仍在运行且 token 文件可读。
// 失败：参数缺失时 url!/tokenFile! 在运行时是 undefined，startTerminal 会在取 token 时抛错；
// 终端会显示启动器报告的错误。

// A terminal client of the board (slice 11 §4), interactive: the launcher in this process (Node 26.5.1 or later), the
// board's terminal code in its sandbox, this terminal its terminal. `q` quits.
// Run from packages/chord, with the board running (`57-tui/main.ts --serve` prints the URL and the token file):
//   node26 --conditions=source test/examples/57-tui/terminal.ts <url> <token file>
import { startTerminal } from "../../../src/node/tui/index.ts";

// process.argv 的前两项是 node 可执行文件与脚本路径；slice(2) 只留业务参数。
// 解构得到的元素类型是 string | undefined（数组可能不够长）；`!` 是非空断言，作者保证调用时传参。
// 运行时断言被擦除：参数缺失时这里不会报错，错误会推迟到 startTerminal 使用 undefined 时出现。
const [url, tokenFile] = process.argv.slice(2);
// 未注入 input/output：启动器使用 process.stdin/stdout，并在 TTY 上进入原始模式。
// credentials.kind "file" 表示从磁盘读取 owner 设备 token，不把 token 放进命令行参数。
const terminal = await startTerminal({ url: url!, credentials: { kind: "file", path: tokenFile! } });
// exited 在沙箱子进程结束时完成；把退出码写给 process.exitCode 而不是调用 process.exit()，
// 这样 Node 会等剩余清理/输出落盘后按该码退出。
process.exitCode = await terminal.exited;
// 启动器监听过 stdin（raw mode）；销毁它可移除事件循环中的句柄，避免进程因输入流未关闭而挂住。
process.stdin.destroy();
