// OAuth登录等界面用它把URL/文件交给操作系统默认处理器；只发起启动，不等待浏览器打开或完成认证。
import { spawn } from "node:child_process";

/**
 * Open a URL or file in the platform browser/default handler.
 *
 * This intentionally never invokes a shell. On Windows, do not use
 * `cmd /c start`: cmd.exe re-parses metacharacters (&, |, ^, ...) before
 * `start` runs, which would make attacker-controlled URLs injectable.
 */
// 输入目标文字，无返回；按平台选择open/rundll32/xdg-open，参数数组直传，不经shell解释。
// 例如https://example.com/?a=1&b=2中的&保持一个参数内容；这避免shell元字符重解析，不等于验证URL或默认处理器的所有行为。
// 启动错误事件被吞掉，调用方仍可展示链接；spawn参数等同步错误并没有额外try/catch保证。
export function openBrowser(target: string): void {
	// 元组类型[string,string[]]要求两项分别为命令和参数数组，解构后保持各自类型。
	const [cmd, args]: [string, string[]] =
		// macOS用系统open，目标独立作为一个argv元素。
		process.platform === "darwin"
			? ["open", [target]]
			: // Windows直接调用系统URL处理DLL入口，避免cmd /c start再次解释元字符。
				process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: // 其余平台交给xdg-open；本层不先探测它是否安装。
					["xdg-open", [target]];

	// spawn reports launcher failures (for example, missing xdg-open) via an
	// error event. Browser launch is best-effort: callers still present the target
	// to the user, so keep the launcher failure from becoming a process crash.
	// On WSL, xdg-open launches explorer.exe, which fails when the cwd's
	// \\wsl.localhost\... path exceeds MAX_PATH (#11592). The target is a URL,
	// so no launcher needs pi's cwd.
	// 忽略stdio避免占用管道，detached独立启动；cwd设/使WSL的长工作路径不影响启动器。
	spawn(cmd, args, { stdio: "ignore", detached: true, cwd: "/" })
		// error回调不报告结果，也不重试；消费事件以免缺失xdg-open等错误导致未处理异常。
		.on("error", () => {})
		// 不让这个子进程句柄阻止Pi退出；unref不表示浏览器已打开，也不会在此杀浏览器。
		.unref();
}
