// IPC 子进程夹具：父进程发来的字节原样回送；首字节 255 或通道关闭时以成功码退出。
// A forked child for the IPC link test: echoes every message of its parent link, and exits when the link closes.
import process from "node:process";
import { ipcLink } from "../../../src/link/index.ts";

// 把子进程 process 适配成 IPC 链路。Parameters 提取函数参数元组，[0] 取端口类型。
// as unknown as 是开发时双重断言，不会在运行时验证 process；Node 的真实 IPC 提供这些方法。
const link = ipcLink(process as unknown as Parameters<typeof ipcLink>[0]);
// 登记消息回调，输入是 Uint8Array，返回 void；回送会写父进程 IPC。
// 例如 [1,2] 被原样送回，而 [255] 使本夹具立即退出；这些是父测试实际使用的控制约定。
link.onMessage((message) => {
	// 十六进制 0xff 等于 255；匹配时直接结束进程，不执行后面的回送。
	if (message[0] === 0xff) process.exit(0);
	// 复用收到的字节数组交给链路发送，不在夹具内复制或解析业务内容。
	link.send(message);
});
// 无参数关闭回调以退出码 0 结束子进程；父进程断开后不让夹具继续挂着。
link.onClose(() => process.exit(0));
