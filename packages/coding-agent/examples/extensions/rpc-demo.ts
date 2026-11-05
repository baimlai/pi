/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，专门配合 RPC 模式演示
 * 扩展 UI 协议。上游由 `pi --mode rpc -e ./rpc-demo.ts` 之类的 RPC 宿主加载（通常与
 * rpc-extension-ui-example.ts 脚本一起运行），下游只调用宿主传入的 ExtensionAPI 与
 * ctx.ui，不访问文件、网络或模型。
 *
 * 这个文件演示什么：扩展在 RPC（无终端 TUI、由外部程序驱动）模式下可以使用的全部 UI
 * 方法——select、confirm、input、editor、notify、setStatus、setWidget、setTitle、
 * setEditorText。RPC 宿主把每次 UI 请求转成协议消息交给客户端，扩展代码看起来与 TUI
 * 模式相同。它不实现游戏逻辑，也不保存状态；turnCount 只在本次进程内有效。
 *
 * 能力清单（按演示的机制）：
 * - session_start 监听：设置终端标题、顶部挂件和初始状态文字。
 * - turn_start / turn_end 监听：累加轮次并更新状态栏。
 * - tool_call 监听：对 rm -rf / sudo 这类 bash 命令弹出 select 选择框，可选择阻止。
 * - session_before_switch 监听：新会话前用 confirm 确认是否清除。
 * - /rpc-input、/rpc-editor、/rpc-prefill 三个命令：分别演示 input、editor、
 *   setEditorText，并用 notify 回报结果。
 *
 * 典型运行顺序：
 * 1. 在 RPC 客户端运行 `pi --mode rpc -e ./rpc-demo.ts`（具体参数以 rpc 示例脚本为准）。
 * 2. 会话启动后客户端应收到 setTitle/setWidget/setStatus 通知。
 * 3. 输入 /rpc-input 等命令，客户端弹窗并把选择/文字回传给扩展。
 * 4. 让模型执行危险的 bash 命令，客户端收到 select 请求，选择 Block 后该工具调用被阻止。
 *
 * 示例（命令处理器签名）：
 *   pi.registerCommand("rpc-input", {
 *     description: "Prompt for text input",
 *     handler: async (_args, ctx) => { await ctx.ui.input("Enter a value"); },
 *   });
 *   真实运行时，RPC 客户端负责渲染对话框；没有 UI 的宿主应检查 ctx.hasUI。
 *
 * 建议阅读顺序：先看 session_start 与 turn_* 三个简单监听，再看 tool_call 的阻止
 * 返回值和 session_before_switch 的 cancel，最后看三个自定义命令。
 *
 * 前置条件：扩展运行在支持 UI 对话框的 RPC 模式；非 UI 模式下 select/confirm 没有
 * 客户端可展示，代码用 ctx.hasUI 提前返回。不会产生费用或写入文件。
 */

/**
 * RPC Extension UI Demo
 *
 * Purpose-built extension that exercises all RPC-supported extension UI methods.
 * Designed to be loaded alongside the rpc-extension-ui-example.ts script to
 * demonstrate the full extension UI protocol.
 *
 * UI methods exercised:
 * - select() - on tool_call for dangerous bash commands
 * - confirm() - on session_before_switch
 * - input() - via /rpc-input command
 * - editor() - via /rpc-editor command
 * - notify() - after each dialog completes
 * - setStatus() - on turn_start/turn_end
 * - setWidget() - on session_start
 * - setTitle() - on session_start
 * - setEditorText() - via /rpc-prefill command
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口：宿主加载模块时调用一次，参数 pi 是注册/调用 API；返回 void，所有行为都来自下面登记的回调。
export default function (pi: ExtensionAPI) {
	// 模块级闭包变量记录本进程已开始的轮次；不写会话日志，重载扩展或重启后会归零。
	let turnCount = 0;

	// -- setTitle, setWidget, setStatus on session lifecycle --

	// 会话启动事件：event 带 reason 等元数据，ctx 是当前会话上下文；回调异步但未 await 任何操作。
	pi.on("session_start", async (event, ctx) => {
		// 条件表达式按启动原因选择标题：reason 为 "new" 表示新建会话，其余（resume 等）用通用标题。
		ctx.ui.setTitle(event.reason === "new" ? "pi RPC Demo (new session)" : "pi RPC Demo");
		// 字符串数组重载把每一项渲染为一行挂件；key "rpc-demo" 用于后续替换或清除。
		ctx.ui.setWidget("rpc-demo", ["--- RPC Extension UI Demo ---", "Loaded and ready."]);
		// setStatus 按 key 更新状态栏；模板字符串把当前计数插入文字。
		ctx.ui.setStatus("rpc-demo", `Turns: ${turnCount}`);
	});

	// -- setStatus on turn lifecycle --

	// 一轮对话开始：自增计数，让 RPC 客户端看到 "running" 状态。
	pi.on("turn_start", async (_event, ctx) => {
		// 后置自增先读取旧值再 +1；这里不保存返回值，只更新闭包变量。
		turnCount++;
		// 同一个 key 的状态文字会被替换，不会堆叠多行。
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} running...`);
	});

	// 一轮对话结束：把同一 key 改成 done，计数保持不变。
	pi.on("turn_end", async (_event, ctx) => {
		// _event 下划线前缀是约定：本回调不需要事件内容。
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} done`);
	});

	// -- select on dangerous tool calls --

	// 每次模型请求执行工具时触发；返回对象可阻止这次调用，返回 undefined 表示放行。
	pi.on("tool_call", async (event, ctx) => {
		// 只审查 bash；其他工具直接返回 undefined，让正常流程继续。
		if (event.toolName !== "bash") return undefined;

		// input 是 unknown 形态的原始参数；as string 只告诉编译器按字符串用，不做运行时转换。
		const command = event.input.command as string;
		// 两个正则任一命中即视为危险：\b 单词边界，\s+ 空白，(-rf?|--recursive) 覆盖 -r/-rf/--recursive，i 忽略大小写。
		const isDangerous = /\brm\s+(-rf?|--recursive)/i.test(command) || /\bsudo\b/i.test(command);

		// 非危险命令不做任何交互。
		if (isDangerous) {
			// 没有可用 UI 时不能询问用户，只能保守阻止。
			if (!ctx.hasUI) {
				return { block: true, reason: "Dangerous command blocked (no UI)" };
			}

			// select 返回所选项字符串，取消/超时返回 undefined；await 会挂起本回调直到用户选择。
			const choice = await ctx.ui.select(`Dangerous command: ${command}`, ["Allow", "Block"]);
			// 只有明确选择 Allow 才放行；undefined 与 Block 都按阻止处理。
			if (choice !== "Allow") {
				// notify 是单向通知，不等待用户确认。
				ctx.ui.notify("Command blocked by user", "warning");
				return { block: true, reason: "Blocked by user" };
			}
			// 用户允许：通知后继续向下，最终返回 undefined 放行。
			ctx.ui.notify("Command allowed", "info");
		}

		// 明确的 undefined 是事件处理器的“不表态”，与返回空对象不同。
		return undefined;
	});

	// -- confirm on session clear --

	// 会话切换前触发；返回 { cancel: true } 可取消这次切换。
	pi.on("session_before_switch", async (event, ctx) => {
		// 只在新建/清除会话时确认，切换已有会话不打扰用户。
		if (event.reason !== "new") return;
		// 没有 UI 时直接放行，无法询问用户。
		if (!ctx.hasUI) return;

		// confirm 返回布尔值；关闭对话框也表现为 false。
		const confirmed = await ctx.ui.confirm("Clear session?", "All messages will be lost.");
		// 用户拒绝时通知并返回取消标记；接受时返回 undefined 让切换继续。
		if (!confirmed) {
			ctx.ui.notify("Clear cancelled", "info");
			return { cancel: true };
		}
	});

	// -- input via command --

	// 注册 /rpc-input 命令；用户输入命令后才执行 handler，args 是命令后的原始文本。
	pi.registerCommand("rpc-input", {
		description: "Prompt for text input (demonstrates ctx.ui.input in RPC)",
		handler: async (_args, ctx) => {
			// input 的第二个参数是占位提示文字；返回字符串或取消时的 undefined。
			const value = await ctx.ui.input("Enter a value", "type something...");
			// 空字符串也视为“没有输入”，与取消一起走 else 分支。
			if (value) {
				ctx.ui.notify(`You entered: ${value}`, "info");
			} else {
				ctx.ui.notify("Input cancelled", "info");
			}
		},
	});

	// -- editor via command --

	// 注册 /rpc-editor 命令，演示多行编辑器；prefill 字符串中的 \n 是真实换行，不是可插注释的模板内容。
	pi.registerCommand("rpc-editor", {
		description: "Open multi-line editor (demonstrates ctx.ui.editor in RPC)",
		handler: async (_args, ctx) => {
			// editor 返回提交的全文，取消时返回 undefined；它不会自动发送给模型。
			const text = await ctx.ui.editor("Edit some text", "Line 1\nLine 2\nLine 3");
			if (text) {
				// split("\n") 按换行切分数组，.length 得到行数；文本本身不改动。
				ctx.ui.notify(`Editor submitted (${text.split("\n").length} lines)`, "info");
			} else {
				ctx.ui.notify("Editor cancelled", "info");
			}
		},
	});

	// -- setEditorText via command --

	// 注册 /rpc-prefill 命令，演示直接改写输入框内容但不提交。
	pi.registerCommand("rpc-prefill", {
		description: "Prefill the input editor (demonstrates ctx.ui.setEditorText in RPC)",
		handler: async (_args, ctx) => {
			// 只替换编辑器正文；用户仍需自己按回车才会把文字发给模型。
			ctx.ui.setEditorText("This text was set by the rpc-demo extension.");
			ctx.ui.notify("Editor prefilled", "info");
		},
	});
}
