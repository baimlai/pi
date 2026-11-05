// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./bookmark.ts` 加载。
// 演示内容：用 pi.setLabel 给会话条目写持久化标签，并在 /tree 等导航界面显示；/bookmark 标记最新的助手消息，/unbookmark 清除最近一个有效标签。
// 上下游：命令由宿主斜杠命令入口调用，读取 ctx.sessionManager.getEntries()/getLabel()，通过 pi.setLabel() 追加标签变更并使用 ctx.ui.notify 提示；不调用模型、不写业务文件。
// 能力清单：
// - 默认导出 (pi: ExtensionAPI) => void：注册两个命令，加载时不读取会话。
// - /bookmark [label]：倒序找最新 assistant 消息并设置标签；无参数时用 `bookmark-<毫秒时间戳>`。
// - /unbookmark：从最新条目向前找 getLabel 非空的条目，清除该标签。
// 典型运行顺序：加载 -> 对话产生助手消息 -> 输入 /bookmark parser -> 标签写入会话日志并在树视图显示 -> /unbookmark 移除最近标签。
// 示例（真实签名）：
//   /bookmark parser
//   // 等价于 pi.setLabel(entry.id, "parser")，entry 为最新 assistant 消息条目
// 阅读顺序：先看两个 registerCommand 的 description/handler，再看倒序查找和 setLabel/getLabel 的配对。
// 前置与副作用：标签是追加到会话日志的变更记录，会持久化并在恢复/分叉后仍可按条目查询；不会修改助手正文。命令在无 UI 的模式下仍可执行，notify 可能不可见。标签名称由用户输入原样保存（去除首尾空白），可以包含空格。
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
			// 倒序只是优先最新；如果最新助手消息没有正文，仍会标记它，因为这里不检查 content。
			for (let i = entries.length - 1; i >= 0; i--) {
				// 读取本轮数组元素。
				const entry = entries[i];
				// type 和 role 判别联合类型，确保这一项确实是助手消息。
				if (entry.type === "message" && entry.message.role === "assistant") {
					// 给 entry.id 写标签；标签不是修改助手正文。
					pi.setLabel(entry.id, label);
					// 提示当前写入的标签。
					// notify 的第二个参数限定 info/warning/error；这里用 info 表示成功。
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
