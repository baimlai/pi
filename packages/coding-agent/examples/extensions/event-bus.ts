// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./event-bus.ts` 加载。
// 演示内容：用 pi.events 订阅 my:notification，并用 /emit 广播同一条事件；session_start 也会发一条启动通知。
// 上下游：session_start 保存 ExtensionContext；pi.events.on 注册跨扩展监听；/emit 调用 pi.events.emit。通知走 ctx.ui.notify。不写文件、不调用模型。
// 能力清单：
// - currentCtx：保存最近一次 session_start 的上下文，供事件监听器使用。
// - my:notification 监听器：把 data 断言成 {message, from} 后 notify。
// - /emit [message]：固定向 my:notification 发送消息；空参数用 hello。
// - 第二个 session_start：发出 Session started 事件。
// 典型运行顺序：启动会话 -> 第一个 session_start 保存 ctx -> 第二个 session_start 发启动事件 -> 监听器 notify -> 输入 /emit hi -> 再次 notify。
// 示例（真实签名）：
//   /emit hello
//   // 通知："Event from /emit command: hello"
// 阅读顺序：先看 currentCtx 与监听器，再看 /emit，最后看两个 session_start 的注册顺序。
// 前置与副作用：事件数据是 unknown，示例用 as 断言成 {message,from}，没有运行时校验；其他扩展发畸形数据会显示 undefined。pi.events.emit 同步开始通知监听器，但不等待异步处理器；本监听器是同步的。两个 session_start 处理器按注册顺序执行，先保存 ctx 再 emit，否则启动通知可能拿不到 ctx。监听器没有显式退订，扩展加载器会在扩展失效时统一清理。currentCtx 在会话替换时会被新的 session_start 覆盖；两次会话之间可能仍指向旧 ctx。命令描述写 /emit [event-name] [data]，实现却固定发 my:notification，并把整段 args 当 message。
/**
 * Inter-extension event bus example.
 *
 * Shows pi.events for communication between extensions. One extension
 * can emit events that other extensions listen to.
 *
 * Usage: /emit [event-name] [data] - emit an event on the bus
 */

// import type 只引入类型；ExtensionAPI 标注入口，ExtensionContext 标注 currentCtx。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 扩展入口：保存上下文、注册监听器/命令/启动事件；加载时不发送通知。
export default function (pi: ExtensionAPI) {
	// Store ctx for use in event handler
	// 最近一次会话的上下文；首次 session_start 之前是 undefined。
	let currentCtx: ExtensionContext | undefined;

	// 第一个 session_start：只保存 ctx，不发送事件。
	pi.on("session_start", async (_event, ctx) => {
		// 会话替换时用新 ctx 覆盖旧值；扩展实例本身不重建。
		currentCtx = ctx;
	});

	// Listen for events from other extensions
	// 订阅共享事件总线；channel 是字符串，data 的类型是 unknown。
	pi.events.on("my:notification", (data) => {
		// as 断言不验证结构；来自其他扩展的数据可能没有 message/from。
		const { message, from } = data as { message: string; from: string };
		// currentCtx 可能尚未设置（启动事件早于 session_start）或已失效；?. 避免直接抛错。
		currentCtx?.ui.notify(`Event from ${from}: ${message}`, "info");
	});

	// Command to emit events (emits "my:notification" which the listener above receives)
	// 命令描述写的是 [event-name] [data]，但 handler 只把参数当 message；这是示例的文档/实现不一致。
	pi.registerCommand("emit", {
		description: "Emit my:notification event (usage: /emit message)",
		// 未使用 ctx；事件发送走 pi.events，不依赖当前 UI 上下文。
		handler: async (args, _ctx) => {
			// trim 后为空则使用 hello；不解析事件名或 JSON。
			const message = args.trim() || "hello";
			// 固定频道 my:notification；data 是普通对象，按引用传给监听器。
			pi.events.emit("my:notification", { message, from: "/emit command" });
			// Listener above will show the notification
		},
	});

	// Example: emit on session start
	// 第二个 session_start：注册顺序在保存 ctx 之后，因此这里 emit 时 currentCtx 已存在。
	pi.on("session_start", async () => {
		// 启动事件也走同一频道；本扩展自己的监听器会收到并 notify。
		pi.events.emit("my:notification", {
			message: "Session started",
			from: "event-bus-example",
		});
	});
}
