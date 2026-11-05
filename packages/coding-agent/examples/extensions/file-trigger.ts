// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./file-trigger.ts` 加载。
// 演示内容：监听固定文件 /tmp/agent-trigger.txt，文件出现非空内容时把它作为 custom message 注入会话，并触发一轮 agent。
// 上下游：session_start 创建 fs.watch；文件变化回调 readFileSync -> pi.sendMessage({customType,content,display:true},{triggerTurn:true}) -> 清空文件。ctx 只用于启动通知。不直接调用模型 API，但 triggerTurn 会启动 agent run。
// 能力清单：
// - 固定 triggerFile 路径。
// - fs.watch 回调：读取/trim、非空则 sendMessage、再写回空串。
// - ctx.hasUI 时通知正在监听。
// 典型运行顺序：启动会话 -> 通知 Watching -> `echo "Run the tests" > /tmp/agent-trigger.txt` -> watch 回调 -> 注入 custom message -> LLM 响应 -> 文件被清空。
// 示例（真实签名）：
//   echo "Run the tests" > /tmp/agent-trigger.txt
//   // 会话中出现 "External trigger: Run the tests"，并启动一轮回复
// 阅读顺序：先看 session_start 里的 watcher 创建，再看回调的读取/发送/清空，最后看 UI 通知。
// 前置与副作用：路径写死，多用户 /tmp 可预测；任何能写该文件的本机进程都可向 agent 注入内容。文件不存在时 fs.watch 可能同步抛 ENOENT，外层没有 try/catch（try 只包回调），session_start 会失败。watcher 没有保存/关闭，session_start 多次会累积多个 watcher，扩展卸载也不会自动清理；旧 watcher 仍可能调用已失效的 pi。fs.watch 可能对一次写入触发多次事件，没有防抖；首次清空后后续事件通常读到空。readFileSync 同步阻塞且没有大小上限。sendMessage 的正文会进入模型上下文（display 只控制 UI），triggerTurn 仅在空闲时启动新一轮；运行中按默认 steer 投递。catch 静默吞掉读取、发送和写入错误。
/**
 * File Trigger Extension
 *
 * Watches a trigger file and injects its contents into the conversation.
 * Useful for external systems to send messages to the agent.
 *
 * Usage:
 *   echo "Run the tests" > /tmp/agent-trigger.txt
 */

// 使用 node: 前缀引用内置模块；fs.watch/readFileSync/writeFileSync 都在这里使用。
import * as fs from "node:fs";
// import type 只引入类型；ExtensionAPI 用于标注入口，编译后擦除。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口：每个会话启动时创建一个文件 watcher；加载时不监听。
export default function (pi: ExtensionAPI) {
	// session_start 在启动/恢复/分叉/新会话时都会触发；每次都会新增 watcher。
	pi.on("session_start", async (_event, ctx) => {
		// 固定路径；示例没有提供配置项，也没有按会话隔离。
		const triggerFile = "/tmp/agent-trigger.txt";

		// fs.watch 创建 watcher；这里没有 try/catch，文件不存在时可能直接抛 ENOENT。
		fs.watch(triggerFile, () => {
			// try 只覆盖回调内部，不能捕获创建 watcher 时的同步异常。
			try {
				// 同步读取整个文件并 trim；文件很大时会阻塞事件循环。
				const content = fs.readFileSync(triggerFile, "utf-8").trim();
				// 只有非空内容才注入；空文件不触发 agent。
				if (content) {
					// sendMessage 注入 custom 消息；返回 void，不等待模型回复。
					pi.sendMessage(
						{
							// customType 供消息渲染/分类使用；示例没有注册对应 renderer。
							customType: "file-trigger",
							// 正文会进入模型上下文；外部内容没有转义或来源标记。
							content: `External trigger: ${content}`,
							// display:true 让消息显示在 transcript；它不控制是否进入模型上下文。
							display: true,
						},
						// triggerTurn:true 在空闲时启动新一轮；运行中默认按 steer 投递。
						{ triggerTurn: true }, // triggerTurn - get LLM to respond
					);
					// 读取后立刻清空文件；写入失败会进入 catch 并被静默忽略。
					fs.writeFileSync(triggerFile, ""); // Clear after reading
				}
			} catch {
				// 注释说文件可能尚不存在，但这里也吞掉了 sendMessage/写入等其它错误。
				// File might not exist yet
			}
		});

		// 仅交互模式提示；非 TUI 模式没有通知。
		if (ctx.hasUI) {
			// 通知只是 UI 提示；watcher 已经在上面创建。
			ctx.ui.notify(`Watching ${triggerFile}`, "info");
		}
	});
}
