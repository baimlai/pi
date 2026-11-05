/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是带超时的交互对话框。
 * 上游：用户输入 /timed、/timed-select、/timed-signal 时进入对应 handler；下游只调用
 * ctx.ui.confirm/select/notify，不写文件、不发网络请求、不调用模型。
 *
 * 演示的机制：ExtensionUIDialogOptions 的 timeout 是最省事的方案，对话框会在倒计时后
 * 自动取消并返回 undefined/false；AbortSignal 方案则由扩展自己计时并 abort，可以在
 * 取消后区分“超时”与“用户主动取消”。
 *
 * 能力清单：
 * - /timed：confirm 对话框，5 秒超时。
 * - /timed-select：select 对话框，10 秒超时。
 * - /timed-signal：手工 AbortController，5 秒后 abort，并检查 signal.aborted 区分原因。
 *
 * 典型运行顺序：加载扩展 -> 输入 /timed -> 对话框显示倒计时 -> 5 秒内点确认得到
 * "Confirmed by user!"，否则得到 "Cancelled or timed out"。
 *
 * 示例（真实签名）：
 *   const ok = await ctx.ui.confirm("Title", "Message", { timeout: 5000 });
 *   返回 Promise<boolean>；超时与关闭都可能是 false。
 *
 * 建议阅读顺序：先看 /timed 的 timeout 选项，再看 /timed-select 的返回值判空，最后看
 * /timed-signal 的计时器清理与取消原因区分。
 *
 * 前置条件：需要支持对话框的 TUI/RPC 模式；无 UI 时这些方法可能返回 undefined/false。
 */

/**
 * Example extension demonstrating timed dialogs with live countdown.
 *
 * Commands:
 * - /timed - Shows confirm dialog that auto-cancels after 5 seconds with countdown
 * - /timed-select - Shows select dialog that auto-cancels after 10 seconds with countdown
 * - /timed-signal - Shows confirm using AbortSignal (manual approach)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口：登记三个命令；对话框只在用户执行命令时出现。
export default function (pi: ExtensionAPI) {
	// Simple approach: use timeout option (recommended)
	// /timed：把 5000 毫秒超时交给 UI 实现处理。
	pi.registerCommand("timed", {
		description: "Show a timed confirmation dialog (auto-cancels in 5s with countdown)",
		handler: async (_args, ctx) => {
			// 第三个参数是对话框选项对象；timeout 由宿主实现倒计时，扩展无需自己计时。
			const confirmed = await ctx.ui.confirm(
				"Timed Confirmation",
				"This dialog will auto-cancel in 5 seconds. Confirm?",
				{ timeout: 5000 },
			);

			// 布尔值无法区分超时和用户点“取消”，两者都走 else。
			if (confirmed) {
				ctx.ui.notify("Confirmed by user!", "info");
			} else {
				ctx.ui.notify("Cancelled or timed out", "info");
			}
		},
	});

	// /timed-select：select 超时后返回 undefined。
	pi.registerCommand("timed-select", {
		description: "Show a timed select dialog (auto-cancels in 10s with countdown)",
		handler: async (_args, ctx) => {
			// 候选数组按显示顺序传入；返回所选项字符串或 undefined。
			const choice = await ctx.ui.select("Pick an option", ["Option A", "Option B", "Option C"], { timeout: 10000 });

			// 空字符串理论上也是合法候选，但本示例的候选都非空，因此判空足够。
			if (choice) {
				ctx.ui.notify(`Selected: ${choice}`, "info");
			} else {
				ctx.ui.notify("Selection cancelled or timed out", "info");
			}
		},
	});

	// Manual approach: use AbortSignal for more control
	// /timed-signal：扩展自己控制取消信号，因此能分辨超时。
	pi.registerCommand("timed-signal", {
		description: "Show a timed confirm using AbortSignal (manual approach)",
		handler: async (_args, ctx) => {
			// AbortController 提供 signal 与 abort() 配对；这里只用于取消对话框。
			const controller = new AbortController();
			// 5 秒后调用 abort；timeoutId 用于在对话框正常结束时清除计时器。
			const timeoutId = setTimeout(() => controller.abort(), 5000);

			ctx.ui.notify("Dialog will auto-cancel in 5 seconds...", "info");

			// 把 signal 交给对话框；abort 后 UI 取消等待并返回 false。
			const confirmed = await ctx.ui.confirm(
				"Timed Confirmation",
				"This dialog will auto-cancel in 5 seconds. Confirm?",
				{ signal: controller.signal },
			);

			// 无论结果如何都清掉计时器，避免 5 秒后无意义地 abort 已完成的操作。
			clearTimeout(timeoutId);

			// 先判断用户确认；否则用 signal.aborted 区分超时与用户关闭。
			if (confirmed) {
				ctx.ui.notify("Confirmed by user!", "info");
			} else if (controller.signal.aborted) {
				ctx.ui.notify("Dialog timed out (auto-cancelled)", "warning");
			} else {
				ctx.ui.notify("Cancelled by user", "info");
			}
		},
	});
}
