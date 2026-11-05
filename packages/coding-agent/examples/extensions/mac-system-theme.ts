// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：启动时读取 macOS 系统外观，把 pi 主题设为 dark 或 light；之后每 2 秒轮询一次，系统切换时同步。
// 上游：`pi -e examples/extensions/mac-system-theme.ts` 加载；宿主在会话开始/结束时派发 session_start、
//   session_shutdown 事件。
// 下游：osascript 调用 System Events 查询外观；ctx.ui.setTheme 切换主题。只读系统状态，不修改 macOS 设置。
//   仅在 macOS 有意义；osascript 失败时按浅色处理。
// 能力：
//   isDarkMode()      异步执行 osascript 并解析 dark mode 布尔值。
//   默认导出函数       注册 session_start（启动轮询）与 session_shutdown（清理定时器）处理器。
// 典型顺序：会话启动 -> 读一次外观 -> 设置主题 -> 建立 2 秒 interval -> 外观变化时重设主题 ->
//   会话关闭 -> clearInterval。
// 示例：在系统设置里切换深色模式，最多约 2 秒后 pi 主题随之切换。
// 阅读顺序：先看 isDarkMode，再看默认导出里的定时器生命周期；注意定时器引用保存在闭包变量里。

/**
 * Syncs pi theme with macOS system appearance (dark/light mode).
 *
 * Usage:
 *   pi -e examples/extensions/mac-system-theme.ts
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// promisify 把回调式 exec 包装成返回 Promise 的函数；这里得到 (cmd) => Promise<{stdout,stderr}>。
const execAsync = promisify(exec);

// 查询 macOS 当前是否为深色模式。输入：无；输出：Promise<boolean>。
// 副作用：启动 osascript 子进程（只读系统偏好）。错误路径：命令失败或输出不是 true 时返回 false。
// 示例：系统为深色时 osascript 打印 "true"，函数返回 true。
async function isDarkMode(): Promise<boolean> {
	// try/catch 覆盖子进程启动失败、osascript 权限错误等；catch 不绑定错误变量，因为只做降级。
	try {
		// AppleScript 向 System Events 查询 appearance preferences 的 dark mode 属性。
		// 解构 stdout；stderr 不参与判断。
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		// osascript 输出带换行，trim 后与字符串 "true" 比较；其他值都视为浅色。
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是登记两个生命周期处理器。
// intervalId 在模块作用域内保存，让 session_shutdown 能拿到同一个定时器句柄。
// 示例：加载后主题立即与系统一致，无需手动执行命令。
export default function (pi: ExtensionAPI) {
	// ReturnType<typeof setInterval> 让句柄类型跟随运行环境（Node 返回 Timeout 对象，浏览器返回 number）。
	let intervalId: ReturnType<typeof setInterval> | null = null;

	// 会话启动后执行一次并开始轮询；_event 前缀下划线表示未使用，避免未使用变量告警。
	pi.on("session_start", async (_event, ctx) => {
		// 先读系统外观再设置主题；await 保证顺序，避免先闪一下旧主题。
		let currentTheme = (await isDarkMode()) ? "dark" : "light";
		ctx.ui.setTheme(currentTheme);

		// 每 2 秒重新查询；回调本身 async，setInterval 不会等待它，因此理论上可能重叠。
		// 演示场景下 2 秒间隔足够长，重叠风险很小。
		intervalId = setInterval(async () => {
			// 新外观与当前记录不同时才调用 setTheme，减少不必要的重绘。
			const newTheme = (await isDarkMode()) ? "dark" : "light";
			if (newTheme !== currentTheme) {
				// 先更新闭包变量，再设主题；下一次比较使用新值。
				currentTheme = newTheme;
				ctx.ui.setTheme(currentTheme);
			}
		}, 2000);
	});

	// 会话关闭时清理定时器，避免会话结束后仍继续调用 ctx.ui；幂等：没有定时器时不做任何事。
	pi.on("session_shutdown", () => {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	});
}
