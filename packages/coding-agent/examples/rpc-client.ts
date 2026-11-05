/**
 * Run one prompt through a Pi RPC child process.
 *
 * Build the coding-agent package first, then run:
 * node examples/rpc-client.ts "Explain this repository"
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples，RPC 示例系列的第一个（另一个是 rpc-extension-ui.ts）。
 * 上游由 `node examples/rpc-client.ts "问题"` 运行，前提是先构建 coding-agent，使
 * `examples/../dist/cli.js` 存在；下游通过 RpcClient 启动 `node dist/cli.js --mode rpc
 * --no-session` 子进程，用 JSON 行协议发送 prompt 并接收事件。
 *
 * 演示什么：RpcClient 的最小用法。RpcClient 负责 spawn 子进程、按行解析 stdout 事件并提供
 * promptAndWait 的完成等待；onEvent 返回退订函数，文字增量写 stdout，工具开始写 stderr。
 * 命令行参数用空格拼成 prompt；没有参数时使用默认问题。--no-session 表示子进程不写会话文件。
 * 这会发起真实模型请求并可能产生费用；脚本没有捕获 start/promptAndWait 的错误，失败会让顶层
 * await 拒绝并以非零码退出，finally 仍会退订并停止子进程。
 *
 * 能力清单（按调用顺序）：
 * - RpcClient({ cliPath, args })：记录要启动的 CLI 与参数，构造时不 spawn。
 * - onEvent(handler)：订阅子进程事件，返回同步的退订函数。
 * - start()：启动子进程并完成 RPC 初始化；失败时拒绝。
 * - promptAndWait(text)：发送 prompt，收集到 settled 事件后返回；默认 60 秒超时。
 * - stop()：取消 stdout 读取、发 SIGTERM，约 1 秒后仍存活则尝试 SIGKILL，再清理管道。
 *
 * 典型运行顺序与预期输出：
 *   1. 构建后运行；子进程启动，若 dist/cli.js 不存在则 start 拒绝。
 *   2. 模型回答的 text_delta 直接写到 stdout；每次工具开始向 stderr 打印 `[tool: 名称]`。
 *   3. promptAndWait 返回后补一个换行；finally 退订并 stop，脚本退出。
 *
 * 示例（真实签名）：
 *   const client = new RpcClient({ cliPath: "/abs/dist/cli.js", args: ["--no-session"] });
 *   const off = client.onEvent((event) => { ... });
 *   await client.start();
 *   await client.promptAndWait("Explain this repository");
 *   off();
 *   await client.stop();
 *
 * 建议阅读顺序：先看路径与 prompt 的构造，再看事件订阅，最后看 start/promptAndWait/stop 的生命周期。
 */

// node:path 负责拼接 CLI 路径；fileURLToPath 把 import.meta.url 的 file: URL 转成本地路径。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

// 当前示例文件所在目录；import.meta.url 在 ESM 中是模块的 file: URL。
const exampleDirectory = dirname(fileURLToPath(import.meta.url));
// argv 前两项是 node 与脚本路径；slice(2) 取用户参数，空格拼接；空数组 join 得空串，再由 || 回退默认问题。
const prompt = process.argv.slice(2).join(" ") || "Explain this repository in one paragraph.";

// 构造只保存启动配置；cliPath 指向构建产物，而不是 src/cli.ts。
const client = new RpcClient({
	cliPath: join(exampleDirectory, "../dist/cli.js"),
	args: ["--no-session"],
});

// 订阅子进程事件并保存退订函数；回调在 RPC 客户端解析到事件时同步执行。
const unsubscribe = client.onEvent((event) => {
	// 先按 type 标签收窄为 message_update，再检查内部 assistant 事件的 text_delta 标签。
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		// 增量写入 stdout，不额外换行；这样回答看起来是连续流。
		process.stdout.write(event.assistantMessageEvent.delta);
	} else if (event.type === "tool_execution_start") {
		// 工具事件写 stderr，避免与 stdout 的回答文本混在一起；前后换行让提示独立成行。
		process.stderr.write(`\n[tool: ${event.toolName}]\n`);
	}
});

try {
	// 启动子进程并完成握手；构建缺失、CLI 退出或协议错误会在这里拒绝。
	await client.start();
	// 发送一次 prompt，等待整轮模型/工具循环落定；不是只等文本开始。
	// 默认 60 秒超时：长时间任务可能在此拒绝，示例没有自定义 timeout。
	await client.promptAndWait(prompt);
	// 回答通常不以换行结尾，这里补一个。
	process.stdout.write("\n");
} finally {
	// 先退订，避免 stop 期间仍收到事件；再等待子进程终止。
	unsubscribe();
	// stop 先 SIGTERM，约 1 秒后仍存活则 SIGKILL；它不保证进程树都被终止。
	await client.stop();
}
