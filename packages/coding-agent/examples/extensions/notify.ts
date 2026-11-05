// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：当 Agent 完整结束并等待输入时发送终端桌面通知；按环境选择 Windows toast、Kitty OSC 99 或
//   通用 OSC 777 三种协议。
// 上游：`pi -e ./examples/extensions/notify.ts` 加载；宿主在 agent_settled 事件时调用处理器。
// 下游：直接写 process.stdout 的 ANSI/OSC 序列，或在 WSL 下用 PowerShell 发 toast；不写文件、不发网络。
//   通知只是尽力而为：没有终端支持时序列可能被忽略，函数不检查结果。
// 能力：
//   windowsToastScript()  生成 PowerShell toast 命令行片段。
//   notifyOSC777()        写 OSC 777 通知序列。
//   notifyOSC99()         Kitty 专用 OSC 99 序列。
//   notifyWindows()       启动 powershell.exe 发送 toast。
//   notify()              按环境变量选择协议。
//   默认导出函数           注册 agent_settled 处理器。
// 运行：加载后在 Ghostty/iTerm2/WezTerm/Kitty 等终端里完成一轮对话，观察通知。
// 示例：agent 完成回复后调用 notify("Pi", "Ready for input")。
// 阅读顺序：先看 notify 的环境分支，再看三个协议函数，最后看 agent_settled 为什么不用 agent_end。

/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 构造 Windows toast 的 PowerShell 片段。输入：标题和正文；输出：用分号连接的脚本字符串。
// 副作用：无，仅拼字符串；不转义单引号，标题/正文含 ' 时脚本可能失效。
// 示例：windowsToastScript("Pi", "Done") 生成以 ToastNotificationManager 开头的脚本。
function windowsToastScript(title: string, body: string): string {
	// WinRT 类型名先存到常量，减少重复并让下面的模板字符串更短。
	const type = "Windows.UI.Notifications";
	// PowerShell 的 WinRT 类型加载语法：[Type, Assembly, ContentType = WindowsRuntime]。
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	// ToastText01 是只有一个文本节点的模板。
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	// $xml 是上一步创建的模板内容对象；这里在字符串里引用 PowerShell 变量（不是 TS 变量）。
	const toast = `[${type}.ToastNotification]::new($xml)`;
	// 依次加载类型、取模板、填入正文、创建 notifier 并 Show；> $null 抑制 PowerShell 输出。
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

// 发送通用 OSC 777 通知。输入：标题/正文；输出：无；副作用：写 stdout。
// 序列格式：ESC ] 777 ; notify ; 标题 ; 正文 BEL。终端不支持时通常静默忽略。
// 示例：notifyOSC777("Pi", "Ready") 输出 "\x1b]777;notify;Pi;Ready\x07"。
function notifyOSC777(title: string, body: string): void {
	// \x1b 是 ESC，\x07 是 BEL，用来结束 OSC 序列。
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

// 发送 Kitty 的 OSC 99 通知。输入：标题/正文；输出：无；副作用：写 stdout。
// 先发 d=0 的标题部分，再发 p=body 的正文部分，两段使用同一个 i=1 通知 id。
// 示例：notifyOSC99("Pi", "Done") 连续写两个 OSC 99 序列。
function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	// 结束符是 ST（ESC \），不是 BEL；两段序列必须使用相同 id 才能拼成一条通知。
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

// 通过 PowerShell 发送 Windows toast。输入：标题/正文；输出：无；副作用：启动子进程。
// require 是 CommonJS 运行时加载，只有真正需要发 Windows 通知时才解析模块；execFile 不经过 shell。
// 错误路径：未捕获 execFile 的错误；失败时通知静默丢失，不影响会话。
function notifyWindows(title: string, body: string): void {
	const { execFile } = require("child_process");
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

// 按运行环境选择通知实现。输入：标题/正文；输出：无；副作用：写终端或启动 PowerShell。
// 优先级：Windows Terminal（WSL）> Kitty > 通用 OSC 777。环境变量只用于探测，不修改。
// 示例：在 Kitty 中启动时选择 OSC 99；在普通终端中选择 OSC 777。
function notify(title: string, body: string): void {
	// WT_SESSION 由 Windows Terminal 设置，在 WSL 中也可用。
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		// KITTY_WINDOW_ID 只在 Kitty 中设置。
		notifyOSC99(title, body);
	} else {
		// 其余终端尝试通用 OSC 777；不是所有终端都支持。
		notifyOSC777(title, body);
	}
}

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是注册 agent_settled 处理器。
// 示例：加载后在支持的终端里跑完一轮对话，桌面会收到 "Pi: Ready for input"。
export default function (pi: ExtensionAPI) {
	// `agent_end` fires after each low-level run; Pi may still retry, compact,
	// or continue with queued follow-ups. Notify only after the full run settles.
	// agent_settled 表示本次完整运行已稳定，不再有重试/压缩/排队 follow-up；此时通知才准确。
	// async 是多余的（回调没有 await），但声明允许，宿主会 await 返回的 Promise。
	pi.on("agent_settled", async () => {
		notify("Pi", "Ready for input");
	});
}
