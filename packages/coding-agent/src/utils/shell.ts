// 为bash/PowerShell工具选择可执行文件和参数、补子进程PATH、清理输出，并记录/终止需要退出清理的子进程。
// 配置选择不执行用户命令；PATH探测会同步启动where/which，终止函数则会发信号或启动Windows taskkill。
import { accessSync, constants } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

// shell启动约定：执行器按这个对象决定如何把命令交给所选程序，而不是把整个对象交给操作系统。
export interface ShellConfig {
	// 可执行文件路径或可在PATH查找的命令名，例如/bin/bash。
	shell: string;
	// 命令正文之前的启动参数；普通bash为["-c"]，旧WSL启动器为["-s"]。
	args: string[];
	// ?表示可省略；联合类型限定两种文字，省略时现有bash执行器按argv传正文。
	commandTransport?: "argv" | "stdin";
}

// Keep in sync with packages/durable/src/env/node.ts.
// 根据路径判断是否旧Windows WSL bash启动器，输入路径返回布尔，无I/O；不是对所有WSL环境的检测。
// 先按Windows规则规范/小写，再用真实SystemRoot拼System32/Sysnative；例如D:/WinNT/System32/BASH.EXE可匹配D:\WinNT。
// 仅SystemRoot缺省才回退盘符:\windows的约定路径，非法的相对SystemRoot不会扩大匹配范围。
function isLegacyWslBashPath(path: string): boolean {
	// win32让非Windows测试环境也按Windows分隔符处理；小写用于这种路径身份比较。
	const normalized = win32.normalize(path).toLowerCase();
	// 使用环境中的Windows安装目录，不假定必须位于C盘。
	const systemRoot = process.env.SystemRoot;
	// 非空SystemRoot存在时只认其下的系统启动器。
	if (systemRoot) {
		// 要求盘符加根分隔符；不接受WinNT这样的相对目录。
		if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false;
		// some只要两个候选目录任一个匹配就返回true，箭头回调逐项比较规范后的完整路径。
		return ["System32", "Sysnative"].some(
			// 正向斜杠/大小写差异由win32.normalize及小写处理，不做真实文件链接解析。
			(directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
		);
	}
	// Fall back to conventional launcher paths only when the Windows directory is unknown.
	// 环境缺省才接受任意盘符下约定Windows目录，正则限定完整路径而非任意bash.exe。
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

// 为已选bash生成启动配置，输入可执行文件字符串返回新对象，无I/O；不检查该程序确实支持bash参数。
// 例如普通Git Bash采用-c并让执行器追加命令参数；旧WSL bash用-s并由stdin接收正文，避开旧启动器参数问题。
function getBashShellConfig(shell: string): ShellConfig {
	// 三元表达式两分支都保留传入shell；只有旧启动器显式标注stdin传输。
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

// Matches harness-v2's pathExists (packages/durable/src/env/node.ts).
// On Unix this is identical to existsSync() (both are access(F_OK)), just
// spelled with try/catch. On Windows we explicitly avoid existsSync(): its
// extra stat check rejects runnable Store aliases (nodejs/node#36790).
// 检查候选路径的F_OK访问是否成功，输入路径返回布尔，同步I/O；失败统一false，不暴露具体权限/不存在错误。
// 例如Windows商店执行别名可能能启动却不能stat，故用accessSync；它不检查X_OK、不保证是可执行普通文件或启动一定成功。
function shellPathExists(path: string): boolean {
	try {
		// constants.F_OK只要求可访问的存在性，错误以抛异常报告。
		accessSync(path, constants.F_OK);
		// 没抛错则接受候选，后续真正spawn仍可能失败。
		return true;
	} catch {
		// 候选无法访问就继续寻找其他shell，不把探测异常向外抛出。
		return false;
	}
}

// 同步在PATH查找程序，输入命令名返回首条路径或null；Windows运行where并做F_OK，Unix运行which后信任其首条输出。
// 例如where返回两条bash路径时只尝试第一条，第一条不可访问不会接着尝试第二条；探测失败/超时结果视为未找到。
// 5000ms是传给spawnSync的超时选项，不是另一个异步计时器；未在这里运行最终用户命令。
function findExecutableOnPath(executable: string): string | null {
	// 按宿主平台选择查找器，不按传入文件后缀推断系统。
	if (process.platform === "win32") {
		// Windows: use 'where' and check the returned path.
		try {
			// 参数数组避免把程序名拼进shell正文，结果按UTF-8返回文字。
			const result = spawnSync("where", [executable], {
				// 字符串编码使stdout可trim/split，而非Buffer。
				encoding: "utf-8",
				// 查找器超时交给Node终止/返回错误结果，本函数只检查正常退出码。
				timeout: 5000,
				// Windows不为探测弹出控制台。
				windowsHide: true,
			});
			// 退出码0且有输出才解析，spawn错误的null状态不会被当成功。
			if (result.status === 0 && result.stdout) {
				// 去掉末尾换行后，只取首行；正则兼容CRLF和LF。
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				// where返回路径还需通过商店别名兼容的F_OK检查。
				if (firstMatch && shellPathExists(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		// 没有满足条件的首条结果，Windows分支到此结束。
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		// Unix查找结果不再次stat/access，兼容Termux等特殊文件系统。
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		// 只有成功且有stdout才认为有候选。
		if (result.status === 0 && result.stdout) {
			// 多结果时同样只取第一行，不解析shell引号或别名定义。
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			// 空白输出即使状态0也不作为可执行路径。
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	// which未找到/失败都用null，调用方继续走平台回退。
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
// 输入可选自定义shell路径，返回shell/参数/传输配置；读取环境/路径并可能同步执行where或which，找不到时按平台回退或抛错。
// 非空自定义路径失败会直接抛错，不偷偷换别的shell；空串视作未提供。函数返回配置，不启动用户命令。
// 例如Unix通常得到{shell:"/bin/bash",args:["-c"]}；全部bash探测失败返回sh配置而不提前验证sh存在。
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	// 可选字符串按真值判断，非空才进入用户明确指定路径分支。
	if (customShellPath) {
		// 只验证F_OK，配置为其他类型shell也仍按bash参数生成配置。
		if (shellPathExists(customShellPath)) {
			// 配置选择结束，命令稍后由工具执行器传入。
			return getBashShellConfig(customShellPath);
		}
		// 显式配置出错应报告用户，不回退掩盖拼错路径。
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	// Windows默认专门寻找bash，不把cmd.exe当bash兼容替代。
	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		// 按环境给出的安装根构造候选，数组顺序决定优先级。
		const paths: string[] = [];
		// 主ProgramFiles可位于任何盘，不写死C盘。
		const programFiles = process.env.ProgramFiles;
		// 根目录有值才添加Git Bash常见路径。
		if (programFiles) {
			// 模板字符串仅拼路径，不执行这里面的文字。
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		// 带括号的环境键用方括号访问，不能直接用点号标识符。
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		// 32位安装根作为第二个Git Bash候选。
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		// for...of按候选值遍历，首个可访问项直接胜出。
		for (const path of paths) {
			// 仍只做F_OK，不启动bash试运行。
			if (shellPathExists(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		// 常见安装目录没找到后才同步运行where。
		const bashOnPath = findExecutableOnPath("bash.exe");
		// 非null候选交给旧WSL路径识别器决定argv/stdin。
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		// Windows没有sh兜底，给出安装/配置建议和已尝试Git目录；字符串正文保持实际报错内容。
		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	// Unix优先固定/bin/bash，即使PATH里有另一个bash也先选它。
	if (shellPathExists("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	// 固定路径失败才用which寻找PATH版本。
	const bashOnPath = findExecutableOnPath("bash");
	// 找到就仍按bash约定返回。
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	// 最后返回可由PATH解释的sh名字；真正不存在时由后续spawn报错。
	return { shell: "sh", args: ["-c"] };
}

// PowerShell固定启动参数；as const只把数组类型收窄为只读字面量元组，并不在运行时Object.freeze。
// NoProfile不加载用户配置，NonInteractive不交互，ExecutionPolicy Bypass用于本次启动，Command后再追加实际命令。
export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
// 无输入，返回Windows PowerShell启动配置；同步读环境/检查路径/运行where，非Windows或无可用程序时抛错。
// 优先PATH pwsh→ProgramFiles的7版→PATH powershell→SystemRoot旧版；例如离PATH安装的PowerShell7仍先于PATH旧版胜出。
export function getPowerShellConfig(): ShellConfig {
	// 工具明确只支持Windows，此处不是跨平台pwsh发现器。
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	// let允许按优先级逐步填入候选，找不到时为null。
	let shell = findExecutableOnPath("pwsh.exe");
	// Installation directories may be on any drive and need not be on PATH.
	// 使用环境安装根，以支持自定义盘符/目录。
	const programFiles = process.env.ProgramFiles;
	// 仅PATH没有新pwsh且安装根有值时尝试常见7版位置。
	if (!shell && programFiles) {
		// win32.join明确按Windows路径规则拼接。
		const pwsh7 = win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
		// 单行if赋值也只在可访问候选存在时执行。
		if (shellPathExists(pwsh7)) shell = pwsh7;
	}

	// ??=只在shell为null/undefined时执行右边查找，已选中的PowerShell7不会被旧版覆盖。
	shell ??= findExecutableOnPath("powershell.exe");
	// 旧Windows PowerShell安装路径由真实系统目录决定。
	const systemRoot = process.env.SystemRoot;
	// PATH旧版也没有才尝试系统安装路径。
	if (!shell && systemRoot) {
		// v1.0是该传统目录名称，不是在此判断实际PowerShell版本号。
		const windowsPowerShell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		// 可访问时记录最终兜底候选。
		if (shellPathExists(windowsPowerShell)) shell = windowsPowerShell;
	}

	// 所有候选失败，向调用工具抛出清楚错误而非返回空路径。
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	// 展开只读常量元组生成新的可变string[]，调用者改args不改共享常量数组。
	return { shell, args: [...POWERSHELL_ARGS] };
}

// 为子进程构造环境副本，无输入，返回NodeJS.ProcessEnv，不修改process.env，也不创建bin目录。
// 读取受管理bin目录并在PATH缺少它时前置，原有Path/PATH键的拼写尽量保留；例如工具可优先找到Pi管理的rg/fd。
// 路径去重只做includes严格字符串比较，不做realpath/大小写规范，重复环境PATH键也不会在这里全部合并清理。
export function getShellEnv(): NodeJS.ProcessEnv {
	// 配置助手统一兼容安装布局，返回用户agent目录下bin路径。
	const binDir = getBinDir();
	// Object.keys加find选首个大小写不敏感等于path的键，未发现则使用PATH。
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	// 方括号按实际键读取；缺省用空串，方便下面split。
	const currentPath = process.env[pathKey] ?? "";
	// delimiter是当前平台PATH分隔符，filter(Boolean)只用于比较时去掉空条目。
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	// 严格判断完整条目是否已有受管理bin，不做路径等价解析。
	const hasBinDir = pathEntries.includes(binDir);
	// 已包含则完整保留原串；否则前置bin，保留非空原PATH串的内容和顺序。
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		// 对象展开复制环境字典，不向父进程原环境写值。
		...process.env,
		// 计算属性名覆盖所选PATH键，其余环境变量照旧交给子进程。
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Unicode interlinear annotation characters U+FFF9..U+FFFB (crash string-width due to a bug)
 */
// 输入已解码文字返回去除特定控制字符后的新串，无I/O；例如NUL被删，制表/换行/回车保留。
// 它不负责解码二进制或完整删除ANSI序列；调用方常先stripAnsi再清理，不能把本函数当任意终端转义过滤器。
export function sanitizeBinaryOutput(str: string): string {
	// All removed characters are single UTF-16 code units, so surrogate pairs are never split.
	// 字符类选中ASCII控制字符（排除tab/LF/CR）及FFF9..FFFB，g逐处删除，不拆emoji的代理对。
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
// 模块内登记待退出清理的PID；Set<number>去重，仅保存数字，不监听进程存活，也不自动注册系统信号。
const trackedDetachedChildPids = new Set<number>();

// 输入已启动子进程PID，无返回；只登记集合，不验证PID或启动/终止进程。
// 例如bash执行器spawn后登记，Pi收到退出信号时统一调用killTrackedDetachedChildren清理。
export function trackDetachedChildPid(pid: number): void {
	// add相同PID多次仍只保存一份。
	trackedDetachedChildPids.add(pid);
}

// 输入已结束/收尾子进程PID，无返回；只撤销登记，不会向进程发信号。
// 例如bash执行器finally撤销PID，避免后续退出清理继续使用旧PID；不存在的登记删除也无影响。
export function untrackDetachedChildPid(pid: number): void {
	// delete返回是否存在，但此接口有意不返回该布尔值。
	trackedDetachedChildPids.delete(pid);
}

// 无输入/返回，逐个请求强制终止已登记进程，再清空集合；由交互/打印/RPC退出路径调用。
// 例如登记了两个shell就各调用killProcessTree；不等待实际退出，也不在这里确认所有后代确已结束。
export function killTrackedDetachedChildren(): void {
	// 遍历当前登记数字，不扫描操作系统的所有进程。
	for (const pid of trackedDetachedChildPids) {
		// 平台差异和尽力回退由统一终止器处理。
		killProcessTree(pid);
	}
	// 已发出清理尝试后撤销全部记录，即使底层某次终止未成功也不自动重试。
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
// 输入工具启动的PID，无返回；Windows启动taskkill /F /T，Unix优先按同号进程组SIGKILL，失败再杀单个PID。
// 例如Unix detached shell的PID也充当组ID，负PID给整组发信号；并非遍历任意进程树，离开该组的后代不受这条组信号保证。
// macOS先尽力SIGSTOP减少取消时a;b继续跑b的竞态；失败都吞掉，Windows异步启动后不等待taskkill结果，不保证原子终止。
export function killProcessTree(pid: number): void {
	// Windows没有这里使用的Unix组信号语义，交给系统taskkill递归终止。
	if (process.platform === "win32") {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		try {
			// 异步启动系统目录中的taskkill，不依赖PATH查到可能同名的程序。
			const child = spawn(
				// SystemRoot缺省/空串时回退C:\Windows；join使用当前平台路径规则。
				join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
				// /F强制、/T包含后代、/PID指定目标，String把数字转成argv文字。
				["/F", "/T", "/PID", String(pid)],
				{
					// 不为清理器创建需要读取的输出管道。
					stdio: "ignore",
					// 让清理器独立启动；此处并未调用unref或等待它结束。
					detached: true,
					// 隐藏Windows清理器控制台窗口。
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			// once只消费一次启动error事件，空回调表示尽力清理失败不再抛给主流程。
			child.once("error", () => {});
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		// 只有macOS需要下述先停再杀的竞态缓解，Linux直接进入SIGKILL。
		if (process.platform === "darwin") {
			// macOS signals group members individually after releasing the group lock. A killed
			// child can wake its waiting shell before that shell is signalled, letting `a; b`
			// start b during cancellation (#11252). Stop the group first to reduce this race;
			// this is best-effort, not an atomic freeze. SIGKILL also kills stopped processes.
			// Linux holds tasklist_lock across group signalling; child exit notification needs
			// its write lock, so the shell is signalled before observing the killed child's exit.
			try {
				// 负PID表示目标进程组；停止是尽力尝试，不是全组原子冻结保证。
				process.kill(-pid, "SIGSTOP");
			} catch {
				// A failed stop must not prevent the kill attempt or its single-process fallback.
			}
		}
		// Use SIGKILL on Unix/Linux/Mac
		try {
			// 强制杀该组，包括之前被SIGSTOP停住的进程；这里只发送信号，不await退出。
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				// 组不存在或无权发信号时，退而只终止指定PID，不能据此声称后代全被清理。
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
