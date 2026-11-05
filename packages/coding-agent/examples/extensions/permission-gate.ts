// 在工具调用前用几个正则识别危险 bash 示例；它只查看命令字符串，不解析 shell，也不是完整沙箱。

/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口接收宿主 API，登记拦截器，无返回数据；登记本身不执行命令。
// 例：模型请求 bash 的 sudo 命令时才询问用户；回调异常由宿主事件链处理。
export default function (pi: ExtensionAPI) {
	// 数组保存正则对象；\b 是单词边界，\s+ 是空白，i 忽略大小写；只覆盖这几个文本模式。
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	// 每次工具执行前收到事件和上下文；async 返回 Promise，返回 block 可阻止这次调用。
	pi.on("tool_call", async (event, ctx) => {
		// 只处理名称为 bash 的工具，其他工具不表态并继续宿主流程。
		if (event.toolName !== "bash") return undefined;

		// 从输入取命令；as string 仅向编译器声明类型，不会把值转换成字符串或验证它。
		const command = event.input.command as string;
		// some 逐个测试，遇到任一匹配就返回 true；箭头回调的 p 是当前正则。
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		// 只对命中模式的命令进入人工确认路径。
		if (isDangerous) {
			// 没有可交互界面就无法询问，因此采用此示例明确的默认阻止规则。
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				// 返回阻止标记与供宿主显示的原因，不会在这里自行终止子进程。
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			// 等待选择结果；取消返回 undefined，只有精确的 Yes 才算允许。
			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			// No、关闭和取消都走阻止分支。
			if (choice !== "Yes") {
				// 告诉宿主拒绝本次工具调用。
				return { block: true, reason: "Blocked by user" };
			}
		}

		// 没有阻止意见；实际执行仍由工具及其他扩展共同决定。
		return undefined;
	});
}
