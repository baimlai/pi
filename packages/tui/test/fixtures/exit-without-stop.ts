// 供exit-restore.test.ts启动的子进程fixture：启动真实备用屏后立即退出，可选先stop，用于捕获退出复位控制码。
// 由测试以三路pipe运行时不接用户TTY；若直接手工运行本文件则会接管当前终端。这里不应被普通模块导入来仅获取定义，顶层代码会立即启动/退出。
// ProcessTerminal 是真实stdin/stdout适配器，start会写协议、安装监听，并在POSIX向本子进程自身发SIGWINCH；不是VirtualTerminal。
import { ProcessTerminal } from "../../src/terminal.ts";
// 备用屏实现提供进入/退出全屏和鼠标复位前后缀，TuiBase负责注册JS进程exit兜底。
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

// 构造备用屏并注入真实适配器：false隐藏硬件光标、undefined不提供日志目录、mouse:true请求鼠标模式；只构造尚未发备用屏启用码。
const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
// 实际启动，先挂exit钩子并进入备用屏/鼠标模式，再启动终端协议连接；请求首帧是异步调度，下面立即退出不等待首帧或协议回复。
tui.start();
// 只有第一个脚本参数精确为stop才正常停止；preserveScreen:true仍发送离开备用屏，只是不重放正文。正常stop会去掉本实例exit钩子并标记stopped，避免随后exit重复复位；其他参数都跳过stop。
if (process.argv[2] === "stop") tui.stop({ preserveScreen: true });
// 立即以退出码0结束孩子进程。若没正常stop，已挂的JS exit钩子尝试同步写复位串；不会完整执行stop、等待异步收尾或覆盖硬杀不运行JS的情形。
process.exit(0);
