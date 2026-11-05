/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是页脚状态栏。
 * 上游：宿主加载后，session_start/turn_start/turn_end 三个生命周期事件驱动更新。
 * 下游：只调用 ctx.ui.theme 与 ctx.ui.setStatus()，不写文件、不发网络请求、不调用模型。
 *
 * 演示的机制：setStatus(key, text) 以 key 为单位维护一段持久页脚文字，同一个 key 再次
 * 调用会替换而不是追加；文字可以包含主题着色后的 ANSI 序列。turnCount 只存在于本
 * 扩展的闭包中，用于展示“第几轮”，不是会话统计。
 *
 * 能力清单：
 * - session_start：把状态设为暗色的 "Ready"。
 * - turn_start：自增轮次，显示强调色的圆点加 "Turn N..."。
 * - turn_end：显示成功色的对勾加 "Turn N complete"。
 *
 * 典型运行顺序：加载扩展 -> 页脚出现 "●/✓ Ready" -> 每次模型轮次开始/结束时文字切换。
 *
 * 示例（真实签名）：
 *   ctx.ui.setStatus("my-ext", ctx.ui.theme.fg("dim", "Ready"));
 *   ctx.ui.setStatus("my-ext", undefined);   // 清除该 key
 *
 * 建议阅读顺序：先看 session_start 的主题取色，再看 turn_start/turn_end 如何替换同一
 * key 的文字。
 *
 * 前置条件：交互模式（TUI 或 RPC）下可见；纯无界面模式里 setStatus 不会显示，但调用
 * 本身不报错。
 */

/**
 * Status Line Extension
 *
 * Demonstrates ctx.ui.setStatus() for displaying persistent status text in the footer.
 * Shows turn progress with themed colors.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口：登记三个监听器；turnCount 的闭包值跨轮次保留，重载扩展后归零。
export default function (pi: ExtensionAPI) {
	// 轮次计数器，从 0 开始；只在 turn_start 中自增。
	let turnCount = 0;

	// 会话启动时初始化页脚状态。
	pi.on("session_start", async (_event, ctx) => {
		// theme 是只读主题对象；fg(color, text) 返回带 ANSI 颜色码的字符串。
		const theme = ctx.ui.theme;
		// "status-demo" 是本扩展专用的 key，其他扩展用不同 key 可并存。
		ctx.ui.setStatus("status-demo", theme.fg("dim", "Ready"));
	});

	// 每轮开始时更新为进行中状态。
	pi.on("turn_start", async (_event, ctx) => {
		// 先自增再显示，因此第一轮显示 Turn 1。
		turnCount++;
		const theme = ctx.ui.theme;
		// accent 颜色只影响圆点；dim 用于次要文字。
		const spinner = theme.fg("accent", "●");
		const text = theme.fg("dim", ` Turn ${turnCount}...`);
		// 字符串拼接把两个已着色的片段合成一段状态文字。
		ctx.ui.setStatus("status-demo", spinner + text);
	});

	// 每轮结束时把同一 key 替换为完成状态。
	pi.on("turn_end", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		// success 色对勾表示完成；这不代表任务成功，只表示轮次结束。
		const check = theme.fg("success", "✓");
		const text = theme.fg("dim", ` Turn ${turnCount} complete`);
		ctx.ui.setStatus("status-demo", check + text);
	});
}
