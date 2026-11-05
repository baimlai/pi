// 运行剪贴板命令的底层子进程包装；调用它才读写系统后端，测试可传Node假命令，不必访问真实剪贴板。
import { spawn } from "node:child_process";

/** Undefined means the command failed; an empty buffer is a successful result. */
// 输入程序名、只读argv和可选输入/超时/输出预算，返回成功stdout Buffer或失败undefined；input存在时stdout忽略，空Buffer仍表示成功。
// 例如读取命令输出二进制原样保留，写入命令把text送stdin，code=0返回空Buffer；超时/超量尝试SIGKILL单个child并销毁管道，不保证杀所有后代。
// 默认3秒及50MiB字节输出上限；选项未额外校验。spawn的同步抛错会经Promise执行器变拒绝，不能把任意异常都说成undefined。
export function runClipboardCommand(
	command: string,
	args: readonly string[],
	options?: { input?: string; timeoutMs?: number; maxBufferBytes?: number },
): Promise<Buffer | undefined> {
	// Promise执行器立即spawn/挂事件，resolve只成功结算一次，未显式提供reject但同步异常仍可拒绝。
	return new Promise((resolve) => {
		// Clipboard writers can daemonize. Do not give them output pipes to retain.
		// Detach on POSIX so the daemon leaves pi's process group and Ctrl+Z suspend
		// (SIGTSTP to the group) does not stop the clipboard owner (#11179).
		// Run from / (the current drive root on Windows): clipboard tools ignore the cwd, and WSL cannot start
		// Windows executables (powershell.exe) when the cwd's \\wsl.localhost\... path
		// exceeds MAX_PATH (#11592). This also keeps daemons from pinning pi's cwd.
		// 程序与argv分开，未开启shell；后台剪贴板所有者不应持有Pi的cwd或进程组。
		const child = spawn(command, args, {
			// stdin始终管道；读取时捕获stdout，写入时忽略stdout，stderr始终忽略。
			stdio: ["pipe", options?.input === undefined ? "pipe" : "ignore", "ignore"],
			// Windows解释为当前驱动根；WSL长UNC cwd不传给Windows程序。
			cwd: "/",
			// POSIX独立进程组避免Ctrl+Z暂停剪贴板选择所有者，Windows不启用detached。
			detached: process.platform !== "win32",
			// 不为Windows命令弹控制台窗口。
			windowsHide: true,
		});
		// 分块保存原始Buffer，不在每块toString损坏跨块UTF8或二进制。
		const chunks: Buffer[] = [];
		// 统计原字节总量，非base64或JS码元数。
		let length = 0;
		// error/close/超时/超量可能竞争，用状态避免重复resolve。
		let settled = false;
		// 输入Buffer或undefined，无返回，清计时器并结算一次；例如成功空Buffer不能用if(result)改成失败。
		const finish = (result: Buffer | undefined): void => {
			// 第一个结算结果胜出，后续close等忽略。
			if (settled) return;
			settled = true;
			// timer在正常异步事件触发前已声明；关闭后不继续杀已结束进程。
			clearTimeout(timer);
			// 不把非零码包装Error，调用方用undefined决定换后端。
			resolve(result);
		};
		// 无输入/返回，请求终止单个child、关输入输出管道并标失败；不等待退出确认。
		const abort = (): void => {
			// 只向child发SIGKILL，不用负组PID或taskkill /T枚举后代。
			child.kill("SIGKILL");
			// 销毁可能被后代继承的读取管道，避免继续收无限输出。
			child.stdout?.destroy();
			// 也结束尚未发完的输入，不保证对方已消费全部text。
			child.stdin?.destroy();
			finish(undefined);
		};
		// ??保留0，未设超时才用3000ms；合法计时范围由调用方保证。
		const timer = setTimeout(abort, options?.timeoutMs ?? 3000);
		// 异步启动失败返回undefined，错误对象不在此透出。
		child.on("error", () => finish(undefined));
		// 等close而非exit，读取模式需要等stdio收尾；继承管道不关闭最终仍受上述超时限制。
		child.on("close", (code) => {
			// 仅code=0算成功，信号终止null也算失败；concat按已统计字节数拼接。
			if (!settled) finish(code === 0 ? Buffer.concat(chunks, length) : undefined);
		});
		// 写入模式没有stdout流，可选链跳过；读取模式逐块累计原字节。
		child.stdout?.on("data", (chunk: Buffer) => {
			// 结算后即使还有迟到数据也不再保留。
			if (settled) return;
			length += chunk.length;
			// 严格超出才abort，等于上限允许；超限整次失败，不返回裁剪后假成功。
			if (length > (options?.maxBufferBytes ?? 50 * 1024 * 1024)) abort();
			// 合格块保留引用，最终再concat成结果。
			else chunks.push(chunk);
		});
		// 写入端先退出的EPIPE等错误不另行抛，最终close/计时器决定结果。
		child.stdin?.on("error", () => {}); // A writer may exit before consuming all input.
		// 文字按Node默认UTF8发送并结束stdin；无input时只是发送EOF，空字符串仍选择写入模式。
		child.stdin?.end(options?.input);
	});
}
