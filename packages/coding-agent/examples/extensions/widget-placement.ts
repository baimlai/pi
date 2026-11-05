// 会话启动时分别在编辑器上下方放置文字挂件，展示 placement 选项。

/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是编辑器周边挂件。
 * 上游：session_start 事件驱动；下游：ctx.ui.setWidget(key, content, options) 在 TUI 中
 * 绘制挂件。不写文件、不发网络请求、不调用模型。
 *
 * 演示的机制：同一方法有两种内容形式（字符串数组或组件工厂），这里用最简单的一行文字
 * 数组；options.placement 控制显示在编辑器上方（默认 aboveEditor）还是下方
 * （belowEditor）。两个挂件使用不同 key，因此可以同时存在。
 *
 * 能力清单：
 * - 默认导出 widgetPlacementExtension(pi)：注册 session_start 监听，设置上下两个挂件。
 *
 * 典型运行顺序：加载扩展 -> 新建/恢复会话 -> 编辑器上方出现 "Above editor widget"，
 * 下方出现 "Below editor widget"。
 *
 * 示例（真实签名）：
 *   ctx.ui.setWidget("w", ["line one", "line two"], { placement: "belowEditor" });
 *   真实运行时只有 TUI 能显示挂件；RPC/print 模式不会出现。
 *
 * 建议阅读顺序：先看 hasUI 守卫，再看两次 setWidget 的 key 与 placement。
 *
 * 前置条件：交互式 TUI 会话；非 UI 模式直接跳过。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 接收 API 后登记启动监听，不立即创建挂件；无返回数据。例：进入 TUI 会话看到上下各一行，非 UI 模式直接跳过。
export default function widgetPlacementExtension(pi: ExtensionAPI) {
	// _event 表示本示例不用事件内容，ctx 提供当前会话 UI。
	pi.on("session_start", (_event, ctx) => {
		// 无 UI 则结束本回调，不尝试设置挂件。
		if (!ctx.hasUI) return;
		// 字符串数组每项是一行，省略 placement 使用默认 aboveEditor。
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		// 用独立 key 设置下方挂件；对象选项显式指定 belowEditor。
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
