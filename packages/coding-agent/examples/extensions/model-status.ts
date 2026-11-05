// 演示模型选择事件：提示切换、更新页脚状态，并向控制台输出前后模型。

/**
 * Model status extension - shows model changes in the status bar.
 *
 * Demonstrates the `model_select` hook which fires when the model changes
 * via /model command, Ctrl+P cycling, or session restore.
 *
 * Usage: pi -e ./model-status.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 接收宿主 API 后登记监听器；不立即切换模型。例：选择另一模型后页脚换为该 id；UI/日志异常不在此捕获。
export default function (pi: ExtensionAPI) {
	// 模型选择发生时异步回调；即使没有 await，async 也会返回 Promise。
	pi.on("model_select", async (event, ctx) => {
		// 对象解构取得新模型、可缺省的旧模型和触发来源。
		const { model, previousModel, source } = event;

		// Format model identifiers
		// 模板字符串拼出供应商与模型的完整标识。
		const next = `${model.provider}/${model.id}`;
		// 三元表达式在没有旧模型时使用 none。
		const prev = previousModel ? `${previousModel.provider}/${previousModel.id}` : "none";

		// Show notification on change
		// 恢复会话时跳过弹出的通知，仍会更新下面的状态和日志。
		if (source !== "restore") {
			// 用信息等级显示新模型标识。
			ctx.ui.notify(`Model: ${next}`, "info");
		}

		// Update status bar with current model
		// 按固定 key 替换页脚片段，不修改模型配置。
		ctx.ui.setStatus("model", `🤖 ${model.id}`);

		// Log change details (visible in debug output)
		// 输出此次切换的起点、终点和来源，属于控制台副作用。
		console.log(`[model_select] ${prev} → ${next} (${source})`);
	});
}
