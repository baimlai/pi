// 演示通过斜杠命令读取或设置当前会话的显示名称。

/**
 * Session naming example.
 *
 * Shows setSessionName/getSessionName to give sessions friendly names
 * that appear in the session selector instead of the first message.
 *
 * Usage: /session-name [name] - set or show session name
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 接收 API 并登记 /session-name；无返回数据。例：/session-name review 将名称设为 review；具体日志持久化由宿主实现。
export default function (pi: ExtensionAPI) {
	// 注册名称不含 / 的命令，用户输入时才调用 handler。
	pi.registerCommand("session-name", {
		// 命令说明用于帮助和发现，不是模型提示或执行逻辑。
		description: "Set or show session name (usage: /session-name [new name])",
		// 接收命令后的原始参数和命令上下文，Promise 在本次处理结束时完成。
		handler: async (args, ctx) => {
			// 删除两端空白；空串表示查询而非清空名称。
			const name = args.trim();

			// 非空名称进入写入路径。
			if (name) {
				// 请求宿主更新当前会话名称。
				pi.setSessionName(name);
				// 显示刚设置的名字。
				ctx.ui.notify(`Session named: ${name}`, "info");
				// 未提供非空参数时读取现有值。
			} else {
				// 未命名时返回 undefined。
				const current = pi.getSessionName();
				// 根据是否有名称选择查询结果文案。
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});
}
