// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录后加载。
// 演示内容：在新建/恢复会话和分叉之前弹出确认框，用 before_* 事件的 {cancel:true} 阻止破坏性操作。
// 上下游：上游是宿主的 session_before_switch/session_before_fork 可取消事件；下游使用 ctx.ui.confirm/select/notify 与 ctx.sessionManager.getEntries()。不调用模型、不写文件。
// 能力清单：
// - 默认导出 (pi: ExtensionAPI) => void：注册两个可取消事件处理器。
// - session_before_switch：reason 为 new 时确认清空；reason 为 resume 时只要会话里出现过 user 消息就确认切换。
// - session_before_fork：用 select 选择是否创建分支，只有精确的 "Yes, create fork" 放行。
// 典型运行顺序：用户执行 /new、恢复会话或分叉 -> 事件先到达 -> 无 UI 直接放行 -> 有 UI 时弹确认 -> 用户取消则返回 {cancel:true}。
// 示例（真实签名）：
//   await ctx.ui.confirm("Clear session?", "This will delete all messages in the current session.")
//   // 返回 false 时 handler 返回 { cancel: true }，宿主停止切换
// 阅读顺序：先看两个 pi.on 的事件类型，再分别看 new/resume 分支和 fork 的精确选择判断。
// 前置与副作用：没有交互 UI 时直接返回 undefined，等于放行，headless 模式无法获得保护。getEntries() 返回全部会话分支条目，不只看当前分支；resume 分支实际判断“整份会话是否出现过任何 user 消息”，英文注释所说的“最后一次助手回复之后的新消息”并不准确，已完成的对话也会触发确认。confirm 返回 false 时才算取消；select 的 undefined（Escape/取消）也会被当成取消。notify 只是提示，不改变事件结果。
/**
 * Confirm Destructive Actions Extension
 *
 * Prompts for confirmation before destructive session actions (clear, switch, branch).
 * Demonstrates how to cancel session events using the before_* events.
 */

// import type 只引入类型；SessionBeforeSwitchEvent 用于显式标注事件形状，SessionMessageEntry 只服务于类型谓词。
import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

// 扩展入口：注册两个可取消事件；加载时不弹窗、不读取会话。
// 示例：/new 时用户在确认框选择 Cancel，handler 返回 { cancel: true }，宿主保留当前会话。
export default function (pi: ExtensionAPI) {
	// session_before_switch 在新建或恢复会话之前触发；返回 {cancel:true} 可阻止操作，返回 undefined 放行。
	pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx) => {
		// 没有可交互 UI 时无法询问；直接放行，避免 headless 模式被永久卡住。
		if (!ctx.hasUI) return;

		// reason 只有 new/resume 两种；new 表示清空/新建，resume 表示切换到已有会话。
		if (event.reason === "new") {
			// confirm 返回 Promise<boolean>；await 让 handler 等待用户选择。
			const confirmed = await ctx.ui.confirm(
				"Clear session?",
				"This will delete all messages in the current session.",
			);

			// 用户明确取消：发出提示并返回 cancel，宿主不会执行清空。
			if (!confirmed) {
				ctx.ui.notify("Clear cancelled", "info");
				return { cancel: true };
			}
			return;
		}

		// 注意：实现实际检查“整份会话是否出现过任何 user 消息”，不是“最后一次助手回复之后的新消息”；已完成的对话也会算作有内容。
		// reason === "resume" - check if there are unsaved changes (messages since last assistant response)
		// getEntries() 返回所有分支的条目快照；只要任一分支有 user 消息，hasUnsavedWork 就为 true。
		const entries = ctx.sessionManager.getEntries();
		// some 遇到第一个匹配就返回 true；类型谓词只用于编译期收窄，运行时只执行 type/role 判断。
		const hasUnsavedWork = entries.some(
			(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
		);

		// 没有 user 消息时直接落到底部，返回 undefined 放行，不弹切换确认。
		if (hasUnsavedWork) {
			// 确认框正文明确提示当前会话有消息；返回 false 时才取消。
			const confirmed = await ctx.ui.confirm(
				"Switch session?",
				"You have messages in the current session. Switch anyway?",
			);

			// 用户拒绝切换：提示并返回 cancel，恢复操作停止。
			if (!confirmed) {
				ctx.ui.notify("Switch cancelled", "info");
				return { cancel: true };
			}
		}
	});

	// session_before_fork 在创建分支之前触发；返回 {cancel:true} 阻止分叉。
	pi.on("session_before_fork", async (event, ctx) => {
		// 同样在无 UI 时放行，避免无法交互的环境被阻塞。
		if (!ctx.hasUI) return;

		// 用 entryId 前 8 个字符标识分叉锚点；select 返回选中字符串或 undefined（取消）。
		const choice = await ctx.ui.select(`Fork from entry ${event.entryId.slice(0, 8)}?`, [
			"Yes, create fork",
			"No, stay in current session",
		]);

		// 只有精确匹配 "Yes, create fork" 才放行；Escape、取消或选择 No 都返回 cancel。
		if (choice !== "Yes, create fork") {
			// 取消提示只是 UI 通知；真正阻止分叉的是下面返回的 cancel 字段。
			ctx.ui.notify("Fork cancelled", "info");
			// cancel 结果由宿主处理，分叉不会发生。
			return { cancel: true };
		}
	});
}
