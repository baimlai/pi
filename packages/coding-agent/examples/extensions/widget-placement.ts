// 会话启动时分别在编辑器上下方放置文字挂件，展示 placement 选项。

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
