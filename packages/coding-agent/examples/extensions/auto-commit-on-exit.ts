// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例（coding-agent extension 示例系列），用 `pi -e ./auto-commit-on-exit.ts` 加载，或复制到 ~/.pi/agent/extensions/ 自动发现。
// 演示内容：在会话关闭事件里检查 Git 工作区，若存在变化就把全部变化提交，提交标题取最后一条助手回复的第一行并加 `[pi] ` 前缀。
// 上下游：上游是宿主的 session_shutdown 事件（退出、reload、/new、/resume、/fork 都可能触发，不只是进程退出）；处理函数调用 pi.exec 运行 git status/add/commit，读取 ctx.sessionManager.getEntries()，成功后用 ctx.ui.notify 提示。文件没有其他导出。
// 能力清单：
// - 默认导出 (pi: ExtensionAPI) => void：注册 session_shutdown 监听器；加载时不执行 Git。
// - session_shutdown 回调：读取 porcelain 状态、从最新到最旧查找助手消息、构造标题、暂存并提交。
// 典型运行顺序：加载扩展 -> 正常对话 -> 退出或切换会话 -> 监听器运行 -> 有变化且 Git 可用时产生一个提交。
// 示例（真实签名）：
//   pi -e ./examples/extensions/auto-commit-on-exit.ts
//   # 最后回复首行为 "Fix parser error"，退出后仓库出现提交 "[pi] Fix parser error"
// 阅读顺序：先看默认导出的监听器注册，再看状态检查、助手消息倒序扫描、标题构造，最后看 add/commit 及通知条件。
// 前置与副作用：必须在 Git 仓库中运行；`git add -A` 会暂存当前仓库的所有变化（包括删除和无关文件），提交会写索引与历史并触发 Git 钩子；需要已配置 user.name/user.email。示例不询问确认，提交失败时没有错误通知；会话切换/重载也可能触发，因此并非只提交一次。工作区干净时不会重复提交。
/**
 * Auto-Commit on Exit Extension
 *
 * Automatically commits changes when the agent exits.
 * Uses the last assistant message to generate a commit message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 注册退出时自动提交的示例；pi 是宿主提供的扩展 API，加载函数本身只登记监听器，无返回数据。
// 真正退出时查 Git 状态、取最后助手文字、暂存全部变化并提交；会修改索引和历史。
// 例如最后回复第一行是 Fix parser，提交标题会以 [pi] Fix parser 开头；以下并非本次注释任务执行的命令。
export default function (pi: ExtensionAPI) {
	// 退出回调接收事件和当前上下文；async/await 让宿主能等 Git 命令结束。
	// session_shutdown 的 reason 可以是 quit/reload/new/resume/fork；本示例不区分，任何原因关闭旧会话都会尝试提交。
	pi.on("session_shutdown", async (_event, ctx) => {
		// Check for uncommitted changes
		// 对象解构把 stdout 改名为 status，保留退出码 code；pi.exec 按 argv 启动 git，不经过隐式 shell。
		// pi.exec 返回 ExecResult（stdout/stderr/code/killed/truncated）；spawn 失败通常也以非零结果返回，下面只解构两项。
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);

		// Git 失败或 porcelain 输出为空就放弃；非零码在这里不一定是非仓库，也可能是其他 Git 错误。
		if (code !== 0 || status.trim().length === 0) {
			// Not a git repo or no changes
			// 无返回值结束退出回调，不继续暂存或提交。
			return;
		}

		// Find the last assistant message for commit context
		// getEntries 返回当前会话全部条目的浅数组，不局限当前树分支；条目带 type 判别字段。
		const entries = ctx.sessionManager.getEntries();
		// let 允许后面更新字符串；未找到助手消息时保留空串。
		let lastAssistantText = "";
		// 从尾部倒序查找，i-- 每轮向前一个位置，优先取日志中最新的助手条目。
		for (let i = entries.length - 1; i >= 0; i--) {
			// 数组索引取出这一条会话记录。
			const entry = entries[i];
			// 先检查条目类型再检查消息角色，TypeScript 据此收窄可访问的字段。
			if (entry.type === "message" && entry.message.role === "assistant") {
				// 助手 content 由文本、思考、工具调用等块组成。
				const content = entry.message.content;
				// 原示例保留数组判断；助手类型已声明块数组，这不是额外验证每个内容块。
				// 运行时判断的是 content 是否为数组；元素内部仍假定为带 type 的对象，示例没有逐个验证形状。
				if (Array.isArray(content)) {
					// 把筛选、转换、拼接的结果赋回变量；不会把思考和工具参数当提交文字。
					lastAssistantText = content
						// 箭头回调的 c is ... 是类型谓词：运行时只判断 type，开发时让后续元素类型带 text。
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						// map 为每个已筛出的文本块取 text，生成字符串数组。
						.map((c) => c.text)
						// 多个文本块用换行连接。
						.join("\n");
				}
				// 即使该助手没有文本也停止查找，不回退到更早的助手消息。
				break;
			}
		}

		// Generate a simple commit message
		// split 取第一行；空行或未找到文字时，|| 使用默认标题。
		// 只取第一行且不做 trim；纯空白首行不会被 || 替换成默认标题。
		const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
		// 模板字符串组合前缀和最多 50 个 UTF-16 码元，超过时加省略号，不按终端列宽截断。
		// slice 按 UTF-16 码元计数，可能从中间切开 emoji 等代理对；不是按字符或显示列宽。
		const commitMessage = `[pi] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

		// Stage and commit
		// git add -A 会把仓库所有变化（包括删除）写入索引；这里未检查暂存命令的退出码。
		await pi.exec("git", ["add", "-A"]);
		// 等待 git commit，解构时把 code 改名为 commitCode；钩子仍由 Git 正常执行。
		// commitMessage 作为独立 argv 传递，不经过 shell，因此不会发生 shell 注入；Git 钩子和签名配置仍会执行。
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);

		// 仅提交成功且宿主有对话 UI 时通知；失败码不在本示例中单独提示。
		if (commitCode === 0 && ctx.hasUI) {
			// 提示实际构造的提交标题；不表示工作目录一定完全干净。
			ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
		}
	});
}
