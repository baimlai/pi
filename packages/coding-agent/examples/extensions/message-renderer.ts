// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示 registerMessageRenderer：为 customType 为 "status-update" 的自定义消息注册 TUI 渲染器，
//   按 info/warn/error 着色，并在展开时显示时间；同时提供 /status 命令生成这类消息。
// 上游：`pi -e examples/extensions/message-renderer.ts` 加载；用户输入 `/status [warn|error] 文字` 触发命令。
// 下游：pi.sendMessage 把自定义消息写入会话（display: true 才显示）；渲染器返回 pi-tui 的 Box/Text 组件。
//   不修改模型上下文中的普通消息，也不发网络请求。
// 能力：
//   默认导出函数   注册 "status-update" 消息渲染器与 /status 命令。
// 渲染器参数：message 是 CustomMessage，options 含 expanded/outputPad 等展示选项，theme 提供颜色。
// 典型顺序：加载 -> /status 解析等级 -> sendMessage -> 宿主按 customType 找到渲染器 -> 绘制。
// 示例：`/status warn 磁盘快满了` 生成黄色 [WARN] 行；展开后追加本地时间。
// 阅读顺序：先看 registerMessageRenderer 回调的三个参数，再看 /status 命令如何解析参数和构造消息。

/**
 * Custom message rendering example.
 *
 * Shows how to use registerMessageRenderer to control how custom messages
 * appear in the TUI, with colors, formatting, and expandable details.
 *
 * Usage: /status [message] - sends a status message with custom rendering
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是登记渲染器和命令（都不立即绘制）。
// 示例：加载后执行 /status error build failed，会看到红色 [ERROR] 标记。
export default function (pi: ExtensionAPI) {
	// Register custom renderer for "status-update" messages
	// 第一个参数必须与 sendMessage 的 customType 完全一致，否则宿主不会调用这个渲染器。
	// 第二个参数的对象解构直接取出 expanded 与 outputPad；theme 是第三个参数。
	pi.registerMessageRenderer("status-update", (message, { expanded, outputPad }, theme) => {
		// details 在类型上是 unknown，用 as 断言成预期形状；这只是编译期声明，运行时不会校验。
		// ?. 处理 details 缺失，?? "info" 提供默认等级。
		const details = message.details as { level: string; timestamp: number } | undefined;
		const level = details?.level ?? "info";

		// Color based on level
		// 嵌套三元表达式把三个已知等级映射到主题颜色名；未知等级落到 success。
		const color = level === "error" ? "error" : level === "warn" ? "warning" : "success";
		// theme.fg 返回带 ANSI 颜色的字符串；toUpperCase 只改显示，不改 details。
		const prefix = theme.fg(color, `[${level.toUpperCase()}]`);

		// 模板字符串把带色前缀和消息正文拼成一行；正文是 customType 消息的 content。
		let text = `${prefix} ${message.content}`;

		// Show timestamp when expanded
		// 只有展开且存在时间戳（0 也会被当成缺失）时才附加时间行。
		if (expanded && details?.timestamp) {
			// toLocaleTimeString 按运行环境地区/时区格式化，不负责时区转换说明。
			const time = new Date(details.timestamp).toLocaleTimeString();
			// \n 产生新行，dim 让时间戳弱化显示。
			text += `\n${theme.fg("dim", `  at ${time}`)}`;
		}

		// Use Box with customMessageBg for consistent styling
		// Box(paddingX, paddingY, bgFn)：左右留白用宿主 outputPad，上下各 1 行，
		// 背景函数给整行套 customMessageBg 颜色。addChild 加入文本组件后返回 Box 供 TUI 渲染。
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// Command to send status messages
	// 注册 /status 斜杠命令；handler 的 args 是命令名之后的原始字符串，_ctx 表示本示例无需上下文。
	pi.registerCommand("status", {
		description: "Send a status message (usage: /status [warn|error] message)",
		handler: async (args, _ctx) => {
			// 先 trim 再按一个或多个空白切分；空字符串会得到 [""]，后面靠默认分支处理。
			const parts = args.trim().split(/\s+/);
			// let 因为下面可能根据首词改写等级和正文。
			let level = "info";
			let content = args.trim();

			// Check for level prefix
			// 只有首词精确等于 warn/error 才当作等级；info 可以通过不写等级得到。
			if (parts[0] === "warn" || parts[0] === "error") {
				// parts[0] 已被上面的比较收窄为 "warn" | "error"。
				level = parts[0];
				// slice(1) 去掉等级词；join(" ") 用单空格重组；空内容时给默认文案。
				content = parts.slice(1).join(" ") || "Status update";
			}

			// sendMessage 写入会话；display: true 才在 TUI 中显示，details 供渲染器读取。
			// 这里不传 triggerTurn，因此不会因为这条消息自动启动模型回合。
			pi.sendMessage({
				customType: "status-update",
				content,
				display: true,
				details: { level, timestamp: Date.now() },
			});
		},
	});
}
