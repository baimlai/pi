/**
 * Entry bookmarking example.
 *
 * Shows setLabel to mark entries with labels for easy navigation in /tree.
 * Labels appear in the tree view and help you find important points.
 *
 * Usage: /bookmark [label] - bookmark the last assistant message
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 注册 /bookmark 和 /unbookmark；只登记命令，无返回数据。
// 命令读取全部日志条目并通过 setLabel 追加标签变更，影响持久化会话与树视图，不调用模型。
// 例如 /bookmark parser 给最新助手条目标 parser；无参数用当前时间生成名称。
export default function (pi: ExtensionAPI) {
	// 注册带参数文本的斜杠命令，description 用于命令列表。
	pi.registerCommand("bookmark", {
		description: "Bookmark last message (usage: /bookmark [label])",
		// 异步命令回调输入参数串和命令上下文；找到目标即设置标签并结束。
		handler: async (args, ctx) => {
			// trim 去掉两端空白，|| 在空参数时采用毫秒时间戳名称。
			const label = args.trim() || `bookmark-${Date.now()}`;

			// Find the last assistant message entry
			// 读取会话全部条目，并非仅当前分支；可包含消息以外的记录。
			const entries = ctx.sessionManager.getEntries();
			// 倒序遍历以先找到最新的助手条目。
			for (let i = entries.length - 1; i >= 0; i--) {
				// 读取本轮数组元素。
				const entry = entries[i];
				// type 和 role 判别联合类型，确保这一项确实是助手消息。
				if (entry.type === "message" && entry.message.role === "assistant") {
					// 给 entry.id 写标签；标签不是修改助手正文。
					pi.setLabel(entry.id, label);
					// 提示当前写入的标签。
					ctx.ui.notify(`Bookmarked as: ${label}`, "info");
					// 命中后立即结束，不再标记其他助手消息。
					return;
				}
			}

			// 遍历没有命中时发出警告。
			ctx.ui.notify("No assistant message to bookmark", "warning");
		},
	});

	// Remove bookmark
	// 撤销命令查找最近仍有有效标签的条目，不要求它是助手消息。
	pi.registerCommand("unbookmark", {
		description: "Remove bookmark from last labeled entry",
		// _args 未使用；回调只依赖会话上下文。
		handler: async (_args, ctx) => {
			// 取得撤销命令执行时的最新条目数组。
			const entries = ctx.sessionManager.getEntries();
			// 从最新日志记录开始向前检查标签。
			for (let i = entries.length - 1; i >= 0; i--) {
				// 当前条目 ID 用来查询标签变更后的有效值。
				const entry = entries[i];
				// getLabel 返回该 ID 当前标签或 undefined，不解析正文。
				const label = ctx.sessionManager.getLabel(entry.id);
				// 只处理非空标签，空值继续向前找。
				if (label) {
					// undefined 表示移除标签，仍由会话管理器记录变更。
					pi.setLabel(entry.id, undefined);
					// 展示被移除的旧标签。
					ctx.ui.notify(`Removed bookmark: ${label}`, "info");
					// 只移除最近一处标签。
					return;
				}
			}
			// 全日志都找不到有效标签时提示。
			ctx.ui.notify("No bookmarked entry found", "warning");
		},
	});
}
