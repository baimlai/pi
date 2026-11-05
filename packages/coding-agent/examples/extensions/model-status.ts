// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：监听 model_select 事件，在 /model 切换、Ctrl+P 循环或会话恢复导致模型变化时，弹出通知、
//   更新页脚状态，并向控制台打印前后模型。
// 上游：`pi -e ./model-status.ts` 加载；宿主在模型选择完成后派发事件。
// 下游：ctx.ui.notify/setStatus 只影响终端显示，console.log 写到标准输出；不改模型配置、不持久化。
// 能力：
//   默认导出函数   注册 model_select 处理器。
// 事件字段：model 新模型，previousModel 旧模型（首次可能 undefined），source 为 "set" | "cycle" | "restore"。
// 典型顺序：切换模型 -> model_select -> restore 时跳过弹窗 -> setStatus 更新页脚 -> console.log。
// 示例：执行 /model 选择另一模型，页脚出现新模型 id，控制台记录 "prev → next (set)"。
// 阅读顺序：先看事件字段，再看 source 分支；文件很短，可整体阅读。

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
// 示例：默认导出函数在扩展加载时执行一次；真正的模型切换处理发生在下面的回调里。
export default function (pi: ExtensionAPI) {
	// 模型选择发生时异步回调；即使没有 await，async 也会返回 Promise。
	// model_select 是通知型事件，handler 的返回值不会被当作新模型或取消信号。
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
		// key "model" 只影响显示；同一 key 的后续调用会替换旧状态，undefined 可清除。
		// 模板字符串把 emoji 与模型 id 拼成显示文本，不改 model 对象。
		ctx.ui.setStatus("model", `🤖 ${model.id}`);

		// Log change details (visible in debug output)
		// 输出此次切换的起点、终点和来源，属于控制台副作用。
		// 不进入会话消息，也不发给模型。
		console.log(`[model_select] ${prev} → ${next} (${source})`);
	});
}
