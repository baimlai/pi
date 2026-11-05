// Answers initialize, spawns a grandchild that outlives stdin, and ignores stdin EOF and SIGTERM.
// stdio关闭测试专用故障服务：只回应initialize，保留timer并忽略SIGTERM；同时启动一个同样顽固的固定子进程。
// 被StdioTransport启动后，这个服务的子进程相对测试宿主是孙进程；import/运行本文件就会spawn，不作普通库加载。
// spawn是Node实际进程创建API，脚本来自本文件固定字符串，没有下载/外部模型调用。
import { spawn } from "node:child_process";
// readline只负责stdin行事件；stdin EOF关闭接口不等于关闭下面独立timer或其子进程。
import { createInterface } from "node:readline";

// 登记空SIGTERM处理器，POSIX上替代默认终止动作；不拦截无法捕获的SIGKILL，也不保证跨平台一致。
process.on("SIGTERM", () => {});
// 用当前Node运行固定-e代码：子进程自己也登记空SIGTERM回调并保留interval，不读取用户脚本或开网络。
// 这里没设detached，POSIX下继承本服务进程组；外层StdioTransport为本服务建独立组，便于组信号覆盖两者。
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
	// 子进程三条标准流忽略，不让它继承并保持服务到测试的协议管道；仍有独立进程和timer。
	stdio: "ignore",
});
// 把所获子进程pid写stderr供测试解析；pid可能尚无值，脚本没给spawn error装处理器或自行重试。
console.error(`grandchild ${grandchild.pid}`);
// 服务自身每秒空回调，timer未unref/clear，所以即使stdin结束也仍有活动资源，不是为了周期发协议消息。
setInterval(() => {}, 1000);

// 建stdin逐行接口，CRLF延时设置同正常fixture；本例不监听其close去停止timer。
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
// 每个line同步回调：解码后只响应initialize，其余return；例initialized通知被忽略。
// JSON/字段访问/写流异常没局部catch，不保证坏输入也保持活着；回调本身不启动浏览器或认证。
lines.on("line", (line) => {
	// 解码单行JSON，不作对象形状保护。
	const message = JSON.parse(line);
	// 非initialize直接返回；即使有id也不回method-not-found，符合只服务握手的故障样本用途。
	if (message.method !== "initialize") return;
	// 构造握手结果，用于让client.connect成功后测试关闭。
	const result = {
		// 固定已支持协议版本，不随目录常量自动更新。
		protocolVersion: "2025-06-18",
		// 不声明工具等能力，这份fixture也不实现工具结果。
		capabilities: {},
		// 固定顽固服务身份，区别正常stdio-fixture。
		serverInfo: { name: "stubborn-fixture", version: "1.0.0" },
	};
	// 按输入id输出一行握手结果；未检查id是否存在，所以这不是通用JSON-RPC服务器实现。
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
