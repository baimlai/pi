// 文件导读
// 所属：packages/durable/src/env 的本地 Node 执行环境实现（NodeExecutionEnv），导出子路径 ./env/node。
// 解决的问题：Durable 的工具层只依赖 ExecutionEnv 抽象（文件系统 + shell），本地运行需要把 Node 的抛出式 API
// 转成 Result：每个可预期失败都返回 FileError/ExecutionError，而不是 throw；并统一路径解析、shell 选择、超时、
// 进程树终止、输出解码与过大输出的落地文件。
// 职责边界：实现 FileSystem（读写/元数据/目录/行读取/二进制读取/监视）与 Shell（exec/cleanup）；不实现工具策略、
// 不做输出截断（工具层决定）、不持久化任何状态。exec 中非零退出码仍返回 ok；超时/取消/回调异常/输出落盘失败
// 返回 err。NodeExecutionEnv 不实现可选的 listFiles。
// 上下游：上游是 Harness 通过 HarnessOptions.env / TaskRuntime.env(context) 注入；本地入口如 openNodeJsonlStorage 直接构造。
// 下游是 node:fs/promises、node:child_process、node:os、decode.ts（StreamDecoder）、line-scan.ts（LineScanner）、
// node-watch.ts（NodeFileWatcher）。所有相对路径先经 resolvePath：支持 ~、file://，并以 cwd 绝对化。
// 能力清单：
// - NodeExecutionEnv：id="node:local"、cwd；watch/absolutePath/joinPath/exec；文本与二进制读取器；
//   文件读写/截断/刷新/重命名；fileInfo/listDir/openDirReader/canonicalPath/exists；目录/删除/临时文件；cleanup。
// - NodeWatchOptions 转导出：watch 的 native/polling 与轮询间隔配置。
// - 内部读取器：NodeTextLineReader（严格 LF，保留 CR，区分最后一行是否终止）、NodeBinaryReader（按 1 MiB 分块
//   的位置读取、可中止重试）、NodeDirReader（分页目录读取）。
// - exec 内部：resolveTimeoutMs 校验秒数；getShellConfig 选 bash/sh；spawn 进程组；StreamDecoder 逐流解码；
//   spill 阈值与背压；waitForChildProcess 协调 exit/close 与 stdio 结束。
// 组合与流向：exec 校验参数 -> 选 shell 或 argv -> 检查 cwd -> spawn（字符串命令经 shell，数组直接启动）-> data
//   事件解码并调用 onOutput -> 达到 spill 阈值写临时文件 -> 进程退出/超时/取消 -> 汇总 exitCode 或错误。
// 示例（真实签名，context 来自 @earendil-works/chord/context）：
//   const env = new NodeExecutionEnv({ cwd: "/work", watch: { pollIntervalMs: 1000 } });
//   const result = await env.exec("printf hi", { timeout: 2 }, context);
//   if (result.ok) console.log(result.value.exitCode, result.value.spillPath);
// 建议阅读顺序：常量 -> resolveTimeoutMs/resolvePath -> 错误映射 toFileError -> NodeTextLineReader ->
// NodeBinaryReader -> NodeDirReader -> NodeExecutionEnv.watch/exec -> 其余文件方法 -> cleanup。
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type Dir, type Stats, type WriteStream } from "node:fs";
import {
	access,
	appendFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	opendir,
	open as openFile,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import { StreamDecoder } from "./decode.ts";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	type FileChange,
	FileError,
	type FileInfo,
	type FileKind,
	type FileWatcher,
	type LineScan,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputInfo,
	type TextLine,
	type TextLineReader,
	toError,
	type WatchTarget,
} from "./index.ts";
import { LineScanner } from "./line-scan.ts";
import { NodeFileWatcher, type NodeWatchOptions } from "./node-watch.ts";

// Node 定时器能表示的最大毫秒数（2^31-1）；秒数上限由它换算得到。
const MAX_TIMEOUT_MS = 2_147_483_647;
// 对外错误信息中展示的秒数上限，约 24.8 天。
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
// 进程已 exit 但 stdio 尚未 end 时的等待窗口；若仍有输出或 spill 未写完就顺延，避免截断尾部。
const EXIT_STDIO_GRACE_MS = 100;
// spill 写流的缓冲高水位（1 MiB）；超过后 write 返回 false，触发暂停子进程输出直到 drain。
const SPILL_HIGH_WATER_MARK = 1024 * 1024;
/** Largest single read of a `BinaryReader`, so a huge `length` allocates only as much as the file yields. */
// 单次位置读取的最大块；调用方请求很大时也只分配这么多，文件提前 EOF 就返回实际字节数。
const BINARY_READ_CHUNK = 1024 * 1024;

// spill 队列接受的块；data 事件给的是 Uint8Array，写入流也允许字符串。
type SpillChunk = string | Uint8Array;

/** 把可选秒数换算成毫秒并校验；undefined 表示不设超时。
 * 非有限数、非正数、超过 2^31-1 毫秒都返回 ExecutionError("timeout")，而不是抛错。
 * 例：2 -> ok(2000)；0 -> err(timeout)；NaN -> err(timeout)。
 */
function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	// 未提供 timeout 是合法状态，后续不创建定时器。
	if (timeout === undefined) return ok(undefined);
	// 排除 NaN/Infinity 与零/负数；TypeScript 只保证是 number，不保证范围。
	if (!Number.isFinite(timeout) || timeout <= 0) {
		// 错误码用 timeout 而不是 invalid：调用方按超时类别处理。
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	// 秒转毫秒；允许小数秒（例如 0.1 表示 100ms）。
	const timeoutMs = timeout * 1000;
	// 超出 setTimeout 可表示范围会让 Node 把延迟当成 1ms，因此必须拒绝。
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

/** 把调用者路径解析成绝对路径：展开 ~ 与 file:// URL，相对路径相对 cwd。
 * 纯词法操作，不访问文件系统；不检查路径是否存在，也不解析符号链接（canonicalPath 才做 realpath）。
 * 例：cwd="/work", path="../a" -> "/a"；path="~/x" -> "<home>/x"。
 */
function resolvePath(cwd: string, path: string): string {
	// 先按字符串规则归一化，再决定相对/绝对。
	let normalized = path;
	// 单独的 ~ 表示 home；只有 "~/"（Windows 还有 "~\\"）才展开，避免误改 "~user"。
	if (normalized === "~") {
		normalized = homedir();
		// 去掉 "~/" 两个字符后拼到 home；slice(2) 同时适用于 "~/" 与 "~\\"。
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
		// file:// URL 交给 Node 转成本地路径；格式错误则保留原字符串，让后续 open 报告 not_found/invalid。
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
		}
	}
	// resolve 还会折叠 "."、".." 与多余分隔符；绝对路径不依赖 cwd。
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/** 把 Stats 的类型谓词归成 FileKind；普通文件/目录/符号链接之外返回 undefined（如 FIFO、socket、设备）。
 * 是否看到符号链接取决于调用者用 stat（跟随）还是 lstat（不跟随）。
 */
function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	// 调用者用 lstat 时可能看到 symlink；用 stat/fstat 时看到的是目标类型。
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

/** 把 Stats 转成对外的 FileInfo：name 取路径最后一段，path 保留调用者给出的绝对路径，size/mtime 原样复制。
 * 不支持的文件类型返回 FileError("invalid")，由调用者决定是跳过还是失败。
 */
function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	// kind 为 undefined 表示 FIFO/socket/设备等；FileInfo 只表达三类。
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: basename(path),
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

/** 类型谓词：unknown 是否像 Node 错误（Error 且带 code 属性）。
 * 只证明 code 存在，不证明 code 是某个具体值；toFileError 的 switch 仍会处理未知 code。
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** 把任意异常转成 FileError，并保留原始错误为 cause。
 * 已经是 FileError 的原样返回；Node 错误的 errno code 映射成稳定错误码，其余归为 unknown。
 * path 优先取 Node 错误自带的 path，否则用调用者给的 fallbackPath。
 */
function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	// 非 Node 错误（例如手动 throw 的字符串/对象）没有 errno，只能走 unknown。
	const nodeError = isNodeError(error) ? error : undefined;
	// ENOENT 等错误通常带具体出错路径；没有时退回调用者预期的路径。
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		const message = nodeError.message;
		// errno 到 FileErrorCode 的固定映射；未列出的 code 落到最后的 unknown。
		switch (nodeError.code) {
			// AbortSignal 取消读取时 Node 抛 AbortError（code=ABORT_ERR）。
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			// 路径不存在；exists 依赖这个码返回 false。
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			// 权限不足统一成 permission_denied；Windows 常报 EPERM。
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			// 路径中间某段是文件而不是目录。
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			// 期望文件却遇到目录，例如以写方式打开目录。
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			// 参数或文件系统不接受该操作。
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	// 未知错误保留 message 与 cause，避免丢失诊断信息。
	return new FileError("unknown", cause.message, path, cause);
}

/** 若 signal 已取消，返回 aborted 的 FileError；否则返回 undefined 表示可以继续。
 * 调用者在每个 I/O 前后检查它，确保取消后不再执行下一步。
 */
function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

/** 用 access(F_OK) 判断路径是否存在；任何错误（权限、父路径不是目录等）都当作 false。
 * 仅用于 shell/目录发现的启发式判断；真正的文件操作仍会返回精确错误。
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** 执行一个短命令并收集 stdout，仅供查找 shell 的程序（which/where）使用。
 * 超时或启动失败时 status 为 null；超时通过 killProcessTree 终止进程，不向调用者抛错。
 */
async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		// spawn 同步抛错（参数非法等）时直接返回 null 状态，不创建定时器。
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		// 超时只杀进程树；Promise 仍等待 error/close 事件后再结束，避免泄漏监听器。
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		// which/where 的输出是路径文本，按 utf8 拼接即可。
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

/** 在 PATH 中查找 bash（Windows 用 where bash.exe），返回第一个存在的绝对路径；找不到返回 null。
 * where 可能返回多行，取第一行；结果还要再 access 一次，过滤掉失效条目。
 */
async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

/** shell 启动方式：程序、固定参数，以及命令如何传入（argv 追加到参数，或 stdin 写入）。
 * 普通 bash 用 ["-c", command]；遗留 WSL 启动器用 ["-s"] 并从 stdin 读命令。
 */
interface ShellConfig {
	shell: string;
	args: string[];
	// 未设置等价于 "argv"；只有 stdin 模式才需要给子进程创建 stdin 管道。
	commandTransport?: "argv" | "stdin";
}

// Keep in sync with packages/coding-agent/src/utils/shell.ts.
/** 判断路径是否是 Windows 自带的 WSL bash 启动器（SystemRoot\System32\bash.exe 或 Sysnative）。
 * 这类启动器不接受普通 bash 的参数方式，因此 getBashShellConfig 会改用 -s + stdin 传命令。
 * 调用前已确认在 Windows 上；SystemRoot 未知时退回常见的 C:\Windows 形式。
 */
function isLegacyWslBashPath(path: string): boolean {
	// 统一分隔符与大小写，避免 "C:/Windows/System32/bash.exe" 漏判。
	const normalized = win32.normalize(path).toLowerCase();
	// 优先用真实 SystemRoot；它必须是盘符路径，否则不做猜测。
	const systemRoot = process.env.SystemRoot;
	// 精确比较 System32 与 Sysnative 两种安装位置。
	if (systemRoot) {
		if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false;
		return ["System32", "Sysnative"].some(
			(directory) => normalized === win32.join(systemRoot, directory, "bash.exe").toLowerCase(),
		);
	}
	// 只在拿不到 SystemRoot 时使用正则兜底；不把任意目录下的 bash.exe 当成 WSL。
	// Fall back to conventional launcher paths only when the Windows directory is unknown.
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/** 根据 shell 路径生成启动配置：普通 bash 用 -c，遗留 WSL bash 用 -s 并从 stdin 读脚本。
 * 不检查文件是否存在；存在性由 getShellConfig 负责。
 */
function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

/** 选择并验证 shell：优先显式 shellPath，其次平台默认（Windows 找 Git Bash/PATH，POSIX 找 /bin/bash/PATH），
 * POSIX 最后退回 sh -c；显式路径不存在或 Windows 找不到 bash 时返回 ExecutionError("shell_unavailable") 并附排查建议。
 * 每次 exec 字符串命令都会调用；不缓存结果。
 */
async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	// 显式配置必须存在，否则报错而不是静默改用其他 shell。
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	// Windows 没有系统 /bin/bash，按 Git for Windows 的常见安装位置与 PATH 顺序查找。
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		// 最后尝试 PATH 中的 bash（Cygwin/MSYS2/WSL 等），仍找不到才失败。
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	// POSIX 优先固定的 /bin/bash，找不到再查 PATH。
	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	// 连 bash 都找不到时退回 POSIX sh；这里不验证 sh 是否存在，启动失败会在 exec 中变成 spawn_error。
	return ok({ shell: "sh", args: ["-c"] });
}

/** 组装子进程环境变量：inheritEnv=false 时只使用本次 extraEnv；
 * 否则按 process.env < 构造时的 shellEnv < 本次调用的 extraEnv 覆盖（后者优先）。
 */
function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	// 不继承时连构造时的 shellEnv 也不带，保证“纯净环境”的语义。
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

/** 终止进程树：POSIX 先杀进程组 -pid（exec 用 detached 创建组），失败再杀单个 pid；
 * Windows 用 taskkill /F /T。任何失败都忽略，因为进程可能已退出。
 */
function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			// 直接启动 taskkill；detached 避免它继承当前进程的控制台状态。
			const child = spawn(
				join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			// spawn 失败会异步发 error；必须消费，否则 Node 以未处理事件崩溃。
			child.once("error", () => {});
		} catch {
			// Ignore errors.
		}
		return;
	}

	try {
		// 负 pid 表示整个进程组，能覆盖 shell 再启动的子进程。
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			// 进程组不存在（例如子进程自己 setsid）时退回单进程。
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

/** 等待子进程结束并返回退出码/信号，同时处理 exit 与 close 的差异。
 * exit 在进程结束时触发，close 要等 stdio 关闭；若后代进程仍持有管道，close 可能永不发生。
 * 因此这里在 exit 且两个输出流都 end 时结束；否则等 100ms 静默窗口，窗口内仍有 data 或 spill 未写完就顺延。
 * finalize 会主动 destroy stdio，释放仍保持的句柄并 resolve；spawn 错误则 reject。
 */
function waitForChildProcess(
	child: ChildProcess,
	spillIsDraining: () => boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise, reject) => {
		// 状态机：settled 防重复结束；exited/exitCode/exitSignal 记录 exit，stdio 的 end 单独跟踪。
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		// exit 之后的静默计时器；处理 close 迟迟不来但有少量尾部输出的情况。
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		// 没有 pipe（stdio 不是 pipe）视为已结束；否则等待各自的 end 事件。
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		// 移除所有监听器并清定时器，避免结束后仍被事件回调触碰。
		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		// 唯一 resolve 点；destroy 输出流，防止后代进程持有管道导致句柄泄漏。
		const finalize = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise({ code: exitCode, signal: exitSignal });
		};
		// exit 且两个流都结束时立即结束，不必等满静默窗口。
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize();
		};
		// 重置静默窗口；spill 正在落盘时继续顺延，让完整输出写完。
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => {
				if (spillIsDraining()) armIdleTimer();
				else finalize();
			}, EXIT_STDIO_GRACE_MS);
		};
		// exit 之后仍有 data，说明尾部输出未结束，重新计时。
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		// 分别记录 stdout/stderr 结束；两者都结束才可提前 finalize。
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		// spawn 失败（如 ENOENT）直接 reject，由 exec 转成 spawn_error。
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		// 先记录退出信息；流尚未结束时启动静默窗口。
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		// close 是正常结束路径；即使静默窗口未到也立即 finalize，并以 close 的参数为准。
		const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
			exitCode = code;
			exitSignal = signal;
			finalize();
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		// 用 on 而不是 once：静默窗口需要每次 data 都重置。
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/** Strict LF reader; Node readline does not report whether its final line was newline-terminated. */
/**
 * 严格按 LF 切分的文本行读取器；Node 的 readline 不报告最后一行是否有换行符，所以这里自己实现。
 * 只把 "\n" 当分隔符，保留可能存在的 "\r"；返回的 terminated 表示该行是否由换行结束。
 * 文件句柄按显式 byteOffset 读取，取消后可用同一读取器重试而不会跳过字节。
 * 例：内容 "a\r\nb" 依次返回 { text: "a\r", terminated: true }、{ text: "b", terminated: false }、undefined。
 */
class NodeTextLineReader implements TextLineReader {
	// file：已打开的只读句柄；path：解析后的绝对路径，用于错误信息。
	// decoder：跨块保留不完整 UTF-8 序列；chunk：复用的 64 KiB 读缓冲。
	// byteOffset：下一次显式读取的位置，只有成功读取并检查取消后才前进。
	// buffered：已解码但尚未按 LF 切出的文本；ended：底层文件已到 EOF；closed：读取器已关闭。
	private readonly file: Awaited<ReturnType<typeof openFile>>;
	private readonly path: string;
	private readonly decoder = new StreamDecoder();
	private readonly chunk = new Uint8Array(64 * 1024);
	private byteOffset = 0;
	private buffered = "";
	private ended = false;
	private closed = false;

	// 构造只保存句柄与路径；不读文件，也不检查是否目录。
	constructor(file: Awaited<ReturnType<typeof openFile>>, path: string) {
		this.file = file;
		this.path = path;
	}

	/** 返回下一行；文件结束且没有缓冲文本时返回 ok(undefined)。
	 * 每次底层读取前后都检查取消；取消返回 err(aborted)，读取器仍可继续重试。
	 * 读到尾部时用 decoder.decode() 冲洗不完整序列（坏字节会变成 U+FFFD）。
	 */
	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		// 先检查取消，避免在已取消的上下文中继续读。
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));

		try {
			while (true) {
				// 缓冲中已有完整行就立即返回，不必再读磁盘。
				const newline = this.buffered.indexOf("\n");
				if (newline !== -1) {
					const text = this.buffered.slice(0, newline);
					this.buffered = this.buffered.slice(newline + 1);
					// 换行符本身不放进 text；terminated 表示这一行确实以 LF 结束。
					return ok({ text, terminated: true });
				}
				// EOF 后缓冲里剩下的就是最后一行；没有剩余则本次读取结束。
				if (this.ended) {
					if (this.buffered.length === 0) return ok(undefined);
					const text = this.buffered;
					this.buffered = "";
					// 最后一行没有换行符：text 原样返回，调用者可据此区分。
					return ok({ text, terminated: false });
				}

				// Explicit positions allow an aborted read to be retried without skipping bytes.
				// 显式 position 读取，不依赖文件句柄内部偏移；取消后重试会从同一位置再读。
				const { bytesRead } = await this.file.read(this.chunk, 0, this.chunk.length, this.byteOffset);
				const afterReadAbort = abortResult<TextLine | undefined>(context.abortSignal, this.path);
				// 读到了但上下文已取消：不推进 byteOffset，也不把数据交给调用者；重试时重新读这一段。
				if (afterReadAbort) return afterReadAbort;
				// 只有确认没有取消才推进位置，避免重试跳过字节。
				this.byteOffset += bytesRead;
				// 0 字节表示 EOF；decode() 不带参数会冲洗解码器内部状态。
				if (bytesRead === 0) {
					// 冲洗可能残留的半个 UTF-8 序列（坏序列变成 U+FFFD）。
					this.buffered += this.decoder.decode();
					this.ended = true;
				} else {
					// 流式解码；subarray 不复制底层数组，decode 会立即消费这块数据。
					this.buffered += this.decoder.decode(this.chunk.subarray(0, bytesRead));
				}
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	/** 关闭读取器：幂等；清空缓冲并尽力关闭句柄，关闭失败也不上报（取消失败或已关闭都很常见）。 */
	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.buffered = "";
		try {
			await this.file.close();
		} catch {
			// Closing is best-effort, including after cancellation or an earlier I/O failure.
		}
	}
}

/** 统一的“读取器已关闭”错误；what 区分文本/二进制/目录读取器。 */
function closedResult<TValue>(what: string, path: string): Result<TValue, FileError> {
	return err(new FileError("invalid", `${what} is closed`, path));
}

/**
 * 基于 FileHandle 的二进制读取器：支持按偏移读取、读取元数据和流式行扫描。
 * 所有读取都是位置读取（positional read），不改变句柄的共享偏移；取消时返回 aborted，调用者可重试同一范围。
 * info 使用句柄自身的 stat，因此即使路径之后被替换，仍描述打开时的文件。
 */
class NodeBinaryReader implements BinaryReader {
	// file：打开的文件句柄；path：解析后的路径，用于错误信息；closed：关闭后所有操作返回 invalid。
	private readonly file: FileHandle;
	private readonly path: string;
	private closed = false;

	// 只保存句柄与路径；文件类型/可读性由 openBinaryReader 在打开时验证。
	constructor(file: FileHandle, path: string) {
		this.file = file;
		this.path = path;
	}

	/** 返回打开文件的元数据（fstat）；取消优先于关闭检查，关闭后返回 invalid。 */
	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const aborted = abortResult<FileInfo>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		try {
			return fileInfoFromStats(this.path, await this.file.stat());
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	/** 从 offset 读取最多 length 字节，文件提前结束就返回较短数组。
	 * offset/length 必须是安全非负整数；每次最多分配 1 MiB，避免巨大 length 直接分配内存。
	 * 取消时丢弃本次已读块并返回 aborted；重试同一 offset 是安全的。
	 */
	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const aborted = abortResult<Uint8Array>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		// 防止负数/NaN/超出安全整数范围的偏移导致底层行为不可预测。
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.path));
		}
		// 单块直接返回；多块最后合并成一个连续数组，调用者无需处理分段。
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (total < length) {
				// 每块最多 1 MiB，剩余不足时按需缩小。
				const chunk = new Uint8Array(Math.min(length - total, BINARY_READ_CHUNK));
				const { bytesRead } = await this.file.read(chunk, 0, chunk.length, offset + total);
				const afterReadAbort = abortResult<Uint8Array>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				// EOF：返回已经读到的字节，不把短读当错误。
				if (bytesRead === 0) break;
				// 短读时只保留有效字节；subarray 与已分配块共享内存。
				chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
				total += bytesRead;
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
		// 常见路径：只有一块，免去复制。
		if (chunks.length === 1) return ok(chunks[0]!);
		// 多块合并；最后返回独立数组，不持有临时块。
		const bytes = new Uint8Array(total);
		let position = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, position);
			position += chunk.length;
		}
		return ok(bytes);
	}

	/** 从文件开头扫描行范围，返回选中行的原始偏移与解码后字节数；EOF 时调用 scanner.finish()。
	 * 每次读 64 KiB 并顺序 push；取消会丢弃全部进度，重试仍从文件开头开始。
	 */
	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<LineScan, FileError>> {
		const aborted = abortResult<LineScan>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Binary reader", this.path);
		let scanner: LineScanner;
		try {
			// LineScanner 构造函数校验行号范围；非法范围在这里转成 invalid。
			scanner = new LineScanner(options.startLine, options.endLine);
		} catch {
			return err(new FileError("invalid", "Invalid line range", this.path));
		}
		const chunk = new Uint8Array(64 * 1024);
		try {
			for (let position = 0; ; ) {
				const { bytesRead } = await this.file.read(chunk, 0, chunk.length, position);
				const afterReadAbort = abortResult<LineScan>(context.abortSignal, this.path);
				if (afterReadAbort) return afterReadAbort;
				// EOF 才产出结果；之前只累积状态。
				if (bytesRead === 0) return ok(scanner.finish());
				// 把原始字节交给扫描器；它自行找 LF、统计行号并计算选中范围。
				scanner.push(chunk.subarray(0, bytesRead));
				position += bytesRead;
			}
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	/** 关闭句柄：幂等；关闭错误被忽略，避免取消失败掩盖原始结果。 */
	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.file.close().catch(() => undefined);
	}
}

/**
 * 目录分页读取器：包装 opendir 的 Dir，每次 next 最多返回 maxEntries 条。
 * 每次 read 后对条目做 lstat，因此能报告 size/mtime；枚举与 lstat 之间被删除的条目直接跳过。
 * 返回的 done 表示目录已经读完；关闭后所有操作返回 invalid。
 */
class NodeDirReader implements DirReader {
	// dir：Node 目录句柄；path：解析后的目录路径；done：已读到目录末尾；closed：已关闭。
	private readonly dir: Dir;
	private readonly path: string;
	private done = false;
	private closed = false;

	// 只保存句柄与路径；目录可读性由 opendir 在打开时验证。
	constructor(dir: Dir, path: string) {
		this.dir = dir;
		this.path = path;
	}

	/** 返回最多 maxEntries 个条目；maxEntries 必须是正安全整数。
	 * 目录读完、或条目在枚举后被删除，都可能返回空数组；done 表示是否还会再有条目。
	 */
	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const aborted = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return closedResult("Directory reader", this.path);
		// 0 或负数没有意义，直接报 invalid，避免无限循环。
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.path));
		}
		const entries: FileInfo[] = [];
		try {
			while (!this.done && entries.length < maxEntries) {
				const entry = await this.dir.read();
				// null 是 opendir 的 EOF 标志，之后保持 done=true。
				if (entry === null) {
					this.done = true;
					break;
				}
				// 每处理一个条目都检查取消，避免大目录长时间不响应。
				const loopAbort = abortResult<{ entries: FileInfo[]; done: boolean }>(context.abortSignal, this.path);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(this.path, entry.name);
				let stats: Stats;
				try {
					stats = await lstat(entryPath);
				} catch (error) {
					// Removed between enumeration and lstat: not part of the listing any more.
					// 条目在 readdir 与 lstat 之间被删除：不再属于当前目录列表，跳过而不是让整页失败。
					if (isNodeError(error) && error.code === "ENOENT") continue;
					return err(toFileError(error, entryPath));
				}
				const info = fileInfoFromStats(entryPath, stats);
				// FIFO/socket 等不支持的类型返回 err(invalid)，这里静默省略；其他错误已在上面返回。
				if (info.ok) entries.push(info.value);
			}
			return ok({ entries, done: this.done });
		} catch (error) {
			return err(toFileError(error, this.path));
		}
	}

	/** 关闭目录句柄：幂等；关闭错误忽略。 */
	async close(_context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.dir.close().catch(() => undefined);
	}
}

/** openBinaryReader 在 noFollow 模式下遇到符号链接时的稳定错误；cause 可保留 ELOOP 细节。 */
function symlinkRefused(path: string, cause?: Error): FileError {
	return new FileError("invalid", "Refusing to follow a symbolic link", path, cause);
}

/**
 * 本地 Node 的 ExecutionEnv 实现：把 fs/promises 与 child_process 包装成不抛错的 Result API。
 * 同一个进程内所有实例共享文件系统，因此 id 固定为 "node:local"；cwd 是相对路径的基准，可在运行中修改。
 * shell 路径在每次 exec 字符串命令时解析，不缓存；shellEnv 是构造时的环境覆盖，逐次调用的 env 优先级更高。
 * exec 的预期失败（超时、取消、spawn 失败、回调抛错、spill 失败）都返回 err；非零退出码仍是 ok。
 * 例：new NodeExecutionEnv({ cwd: process.cwd() })；随后所有 path 参数都相对该 cwd。
 */
export class NodeExecutionEnv implements ExecutionEnv {
	/** Every local environment sees the same files. */
	// 环境标识：本地所有实例看到同一个文件系统，因此不区分实例。
	readonly id: string = "node:local";
	// 相对路径的基准目录；构造后可直接修改，下一次调用立即生效。
	cwd: string;
	// 显式 shell 路径；undefined 表示按平台自动查找（每次 exec 都重新查找）。
	private shellPath?: string;
	// 构造时附加给子进程的环境变量；逐次调用的 options.env 会覆盖它。
	private shellEnv?: NodeJS.ProcessEnv;
	// 传给 NodeFileWatcher 的选项（模式、轮询间隔、目录预算）。
	private watchOptions: NodeWatchOptions;
	// 正在运行的子进程 pid；cleanup 用它们终止整棵进程树，settle 时移除。
	private activeChildPids = new Set<number>();

	// 只保存配置，不验证 cwd、不启动进程；错误留到实际调用时以 Result 返回。
	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv; watch?: NodeWatchOptions }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
		this.watchOptions = options.watch ?? {};
	}

	/** 建立文件监视：目标路径经 resolvePath 解析后交给 NodeFileWatcher.open。
	 * open 后若上下文已取消，会先停掉刚建立的 watcher 再返回 aborted，避免泄漏原生句柄。
	 * 失败统一转成 FileError；FileWatcher 的停止由调用者负责。
	 */
	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: FileChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const aborted = abortResult<FileWatcher>(context.abortSignal);
		if (aborted) return aborted;
		try {
			const watcher = await NodeFileWatcher.open(
				targets,
				(path) => resolvePath(this.cwd, path),
				onChange,
				this.watchOptions,
			);
			const afterOpenAbort = abortResult<FileWatcher>(context.abortSignal);
			if (afterOpenAbort) {
				// 打开期间被取消：关闭已建立的 watcher，不能把资源留给已取消的调用者。
				await watcher.stop(context);
				return afterOpenAbort;
			}
			return ok(watcher);
		} catch (error) {
			return err(toFileError(error));
		}
	}

	/** 纯词法绝对化：展开 ~ 与 file://，相对 cwd 解析；不访问文件系统、不检查存在性。 */
	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	/** 用 node:path 的 join 拼接；语义跟随平台（POSIX/Windows 分隔符），不相对 cwd 解析，也不检查取消。 */
	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	/**
	 * 执行命令：字符串经 shell 解释，字符串数组直接启动首元素程序；返回退出码与可选 spill 文件路径。
	 * 输出块解码后调用 options.onOutput；超过 spill 阈值时把完整原始输出写入临时文件。
	 * 非零退出码仍是 ok；超时/取消/spawn 失败/回调抛错/spill 失败返回 err（取消/超时错误会带上已创建的 spillPath）。
	 */
	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		// 先校验超时，非法值不启动进程。
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		// 本次调用的 cwd 优先；没有则用环境 cwd。
		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		// A string runs through the shell; an argv array runs its program directly, without shell parsing.
		let program: string;
		let args: readonly string[];
		// 仅遗留 WSL bash 使用：命令写入 stdin，其余情况 stdin 为 ignore。
		let stdinCommand: string | undefined;
		// 字符串交给 shell；数组则完全绕过 shell，参数边界不会被再次解析。
		if (typeof command === "string") {
			const shellConfig = await getShellConfig(this.shellPath);
			if (!shellConfig.ok) return shellConfig;
			// 普通 bash 把命令追加为 -c 的参数；stdin 模式只保留 -s，稍后写入管道。
			const commandFromStdin = shellConfig.value.commandTransport === "stdin";
			program = shellConfig.value.shell;
			// 展开复制参数，避免修改 getShellConfig 返回的数组。
			args = commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command];
			stdinCommand = commandFromStdin ? command : undefined;
		} else {
			// argv 模式：首元素是程序，其余是参数；不做 shell 解析。
			const [first, ...rest] = command;
			// 空数组没有可执行程序；明确报 spawn_error，而不是让 spawn 抛错。
			if (first === undefined) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
			program = first;
			args = rest;
		}
		try {
			// 先确认工作目录存在；失败时下面统一转成 spawn_error 并保留 cause。
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		return await new Promise((resolvePromise) => {
			// settled 保证 Promise 只 resolve 一次；timedOut 与 context.abortSignal 决定最终错误种类。
			let settled = false;
			let timedOut = false;
			// onOutput 抛错后记录 callback_error 并杀掉进程；后续输出不再回调。
			let callbackError: ExecutionError | undefined;
			// spill 创建/写入失败后记录错误；exec 最终返回它而不是“成功”。
			let spillError: ExecutionError | undefined;
			// spawn 失败时可能没有 child；所有回调都做可选访问。
			let child: ReturnType<typeof spawn> | undefined;
			// 超时定时器；settle 时清理。
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			// 阈值前收到的原始块；一旦超阈值，先写这些前缀再写当前块，保证 spill 从文件开头完整。
			const spillPrefix: SpillChunk[] = [];
			// 临时文件路径；成功、超时、取消都可能返回它。
			let spillPath: string | undefined;
			// 临时文件尚在创建时暂存的块；创建完成后按序写入。
			const spillQueue: SpillChunk[] = [];
			// 创建 spill 文件的异步过程；undefined 表示尚未触发 spill。
			let spillStart: Promise<void> | undefined;
			// 创建完成后的写流；failSpill 后可能已被销毁。
			let spillStream: WriteStream | undefined;
			// 写流返回 false 后置位；drain 时清除并恢复子进程输出。
			let spillBackpressured = false;

			// 取消/超时/回调失败/spill 失败共用的终止动作：杀整个进程树。
			const onAbort = () => {
				if (child?.pid) killProcessTree(child.pid);
			};
			// 只记录第一次回调错误；之后杀掉进程，让 exec 以 callback_error 结束。
			const failCallback = (error: unknown) => {
				if (callbackError !== undefined) return;
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				onAbort();
			};
			// One decoder per stream, so a character split across chunks of one stream survives interleaving.
			// 每个流独立解码，字符被块边界切开也不会因另一个流的块插入而错乱；BOM 只去流开头一个。
			const stdoutDecoder = new StreamDecoder();
			const stderrDecoder = new StreamDecoder();
			// No output reaches the caller after exec() settled, for example from a descendant holding stdio open.
			// 统一的输出出口：结束后/空串/未提供回调/已有回调错误时丢弃。
			const emit = (text: string, stream: ShellOutputInfo["stream"]): void => {
				if (settled || text === "" || options?.onOutput === undefined || callbackError !== undefined) return;
				try {
					// 回调拿到原始 context 与流标识；抛出即视为 callback_error。
					options.onOutput(text, context, { stream });
				} catch (error) {
					failCallback(error);
				}
			};
			// Output seen before the spill starts: counted against the thresholds and kept for the spill's prefix.
			// spill 触发前的累计原始字节数；一旦触发就不再使用。
			let seenBytes = 0;
			// spill 触发前累计的 LF 数，用于按行阈值判断。
			let seenNewlines = 0;

			// 唯一的 Promise resolve 点：清理定时器、取消监听、移除 active pid。
			const settle = (result: Result<ShellExecResult, ExecutionError>) => {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				if (signal) signal.removeEventListener("abort", onAbort);
				if (child?.pid) this.activeChildPids.delete(child.pid);
				resolvePromise(result);
			};
			// spill 初始化或写流背压时暂停两个管道，防止内存无限增长。
			const pauseOutput = () => {
				child?.stdout?.pause();
				child?.stderr?.pause();
			};
			// 只有在没有错误、未超时、未取消且未背压时才恢复；spill 失败后不再继续读。
			const resumeOutput = () => {
				if (callbackError || spillError || timedOut || signal?.aborted || spillBackpressured) return;
				child?.stdout?.resume();
				child?.stderr?.resume();
			};
			// spill 任何失败都终止进程并让 exec 返回 unknown 错误；完整输出无法保证时不能伪装成功。
			const failSpill = (error: unknown) => {
				if (spillError !== undefined) return;
				const cause = toError(error);
				spillError = new ExecutionError(
					"unknown",
					`Failed to preserve complete shell output: ${cause.message}`,
					cause,
				);
				spillBackpressured = false;
				onAbort();
			};
			// 写流背压时暂停管道并等 drain；即使已背压也继续写入（Node 会缓冲），但不重复注册 drain。
			const writeSpill = (chunk: SpillChunk): void => {
				if (spillStream === undefined || chunk.length === 0) return;
				if (spillStream.write(chunk) || spillBackpressured) return;
				spillBackpressured = true;
				pauseOutput();
				spillStream.once("drain", () => {
					spillBackpressured = false;
					resumeOutput();
				});
			};
			// 首次触发：暂存当前块，暂停输出，异步创建临时文件；创建期间到达的块进入 spillQueue。
			const startSpill = (chunk: SpillChunk): void => {
				if (spillStream !== undefined) {
					writeSpill(chunk);
					return;
				}
				spillQueue.push(chunk);
				if (spillStart !== undefined) return;
				pauseOutput();
				// createTempFile 尊重 context：取消会让 spill 创建失败并走 failSpill。
				spillStart = (async () => {
					const created = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context);
					if (!created.ok) throw created.error;
					spillPath = created.value;
					// 追加模式；高水位决定何时触发背压。
					spillStream = createWriteStream(spillPath, { flags: "a", highWaterMark: SPILL_HIGH_WATER_MARK });
					spillStream.on("error", failSpill);
					// 按到达顺序补写创建期间暂存的块，保持原始字节顺序。
					for (const queued of spillQueue) writeSpill(queued);
					spillQueue.length = 0;
				})()
					.catch(failSpill)
					// 无论创建成功还是失败都尝试恢复（失败时 resumeOutput 会因 spillError 拒绝恢复）。
					.finally(resumeOutput);
			};
			// 进程结束后等待 spill 创建完成并 end 写流；错误已被 failSpill 记录，这里只等 finish。
			const finishSpill = async (): Promise<void> => {
				await spillStart;
				const stream = spillStream;
				if (stream === undefined || spillError !== undefined || stream.destroyed) return;
				await new Promise<void>((resolveFinish) => {
					stream.once("error", () => resolveFinish());
					stream.once("finish", resolveFinish);
					stream.end();
				});
			};

			try {
				// 关键选项：cwd、环境、stdio；POSIX 上 detached 创建独立进程组，便于一次杀掉整棵树。
				child = spawn(program, args, {
					cwd,
					detached: process.platform !== "win32",
					env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
					stdio: [stdinCommand === undefined ? "ignore" : "pipe", "pipe", "pipe"],
					windowsHide: true,
				});
				// 记录活动 pid，cleanup 可在宿主关闭时兜底终止。
				if (child.pid) this.activeChildPids.add(child.pid);
				// 仅 stdin 传输模式需要管道；写入后 end，让 shell 读到 EOF。
				if (stdinCommand !== undefined) {
					// 子进程可能提前退出导致 EPIPE；忽略，最终以退出码/信号为准。
					child.stdin?.on("error", () => {});
					child.stdin?.end(stdinCommand);
				}
			} catch (error) {
				const cause = toError(error);
				// spawn 同步抛错（参数类型非法等）直接结束；程序不存在通常异步触发 waitForChildProcess 的 error。
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			// 定时器只标记 timedOut 并杀进程；真正的结算在子进程结束后进行，以便拿到已产生的 spillPath。
			timeoutId =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							onAbort();
						}, timeoutMs);

			// 若监听前已取消，立即杀进程；否则注册一次性 abort 监听，settle 时移除。
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			// 每个流的 data 处理：先解码交给 onOutput，再按原始字节决定是否/如何写 spill。
			const feed = (source: ShellOutputInfo["stream"], decoder: StreamDecoder) => (chunk: Uint8Array) => {
				// 解码是流式的；即使多字节字符跨块也能正确拼接。
				emit(decoder.decode(chunk), source);
				const spill = options?.spill;
				if (spill === undefined || chunk.length === 0) return;
				// spill 已触发：原始块直接进入 spill 流程（阈值判断只做一次）。
				if (spillStart !== undefined) {
					startSpill(chunk);
					return;
				}
				// 计数使用原始字节，不是解码后字符串长度，保证与 afterBytes 语义一致。
				seenBytes += chunk.length;
				// 统计 LF 0x0a；与行扫描一致，按原始字节而非文本换行。
				for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) seenNewlines++;
				// 最后一块没有以 LF 结尾时，当前未完成的一行也计入，因此“超过行数”不会晚一行触发。
				const lines = seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
				// 恰好等于阈值仍不 spill；必须严格超过才触发（与 contract 的 exceeds 语义一致）。
				if (seenBytes <= spill.afterBytes && lines <= spill.afterLines) {
					spillPrefix.push(chunk);
					return;
				}
				// 超阈值：把之前缓存的每个块依次写入，保证 spill 包含从第一块开始的完整原始输出。
				for (const prefix of spillPrefix) startSpill(prefix);
				spillPrefix.length = 0;
				startSpill(chunk);
			};
			// 两个流分别解码；stdout/stderr 的块可以交错，但解码状态互不干扰。
			child.stdout?.on("data", feed("stdout", stdoutDecoder));
			child.stderr?.on("data", feed("stderr", stderrDecoder));

			// spill 尚未创建完或写流背压时，waitForChildProcess 会顺延静默窗口，避免结束太早截断输出。
			void waitForChildProcess(
				child,
				() =>
					spillError === undefined &&
					spillStart !== undefined &&
					(spillStream === undefined || spillBackpressured),
			).then(
				async ({ code, signal: exitSignal }) => {
					// 子进程结束后先等写流真正 finish，再刷新解码器尾部，然后按优先级决定结果。
					await finishSpill();
					// decode() 无参数冲洗残留的半个 UTF-8 序列（坏字节变成 U+FFFD）。
					emit(stdoutDecoder.decode(), "stdout");
					emit(stderrDecoder.decode(), "stderr");
					// 回调错误优先于退出码/超时：宿主回调失败时不能报告命令成功。
					if (callbackError) {
						settle(err(callbackError));
						return;
					}
					// 超时与取消优先于普通退出；两者都可能已有 spillPath，需要一并带回。
					const interrupted = timedOut
						? new ExecutionError("timeout", `timeout:${options?.timeout}`)
						: signal?.aborted
							? new ExecutionError("aborted", "aborted")
							: undefined;
					// 把已创建的完整输出路径附在错误上，调用者仍可读取诊断。
					if (interrupted !== undefined) {
						if (spillPath !== undefined) interrupted.spillPath = spillPath;
						settle(err(interrupted));
						return;
					}
					// 输出未能完整保存，不能返回 ok。
					if (spillError) {
						settle(err(spillError));
						return;
					}
					// A process killed by a signal (e.g. OOM killer) has no exit code; map it
					// to the conventional 128 + signal number so callers do not mistake it
					// for a successful exit.
					// 被信号杀死时没有 code：用约定的 128+信号编号；未知信号按 0 计，无 code 也无信号则回退 1。
					const exitCode = code ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1);
					// 非零退出码也是 ok；是否算工具错误由上层（bash 工具）决定。
					settle(ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) }));
				},
				// waitForChildProcess 只会在 spawn 错误时 reject。
				(error: Error) => settle(err(new ExecutionError("spawn_error", error.message, error))),
			);
		});
	}

	/** 打开严格 LF 的文本行读取器；open 期间被取消会关闭刚打开的句柄再返回 aborted。 */
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<TextLineReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const file = await openFile(resolved, "r");
			const afterOpenAbort = abortResult<TextLineReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await file.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeTextLineReader(file, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 一次性读取整个文件为 UTF-8 字符串；signal 直接传给 readFile，取消由 Node 中断 I/O。 */
	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<string>(signal, resolved);
		if (aborted) return aborted;
		try {
			// 整文件读入内存；大文件应由调用者改用行读取器或二进制读取器。
			return ok(await readFile(resolved, { encoding: "utf8", signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 读取前 maxLines 行文本；maxLines 为 0/负数时直接返回空数组，不打开文件。
	 * 每行只返回 text（不含 LF，可能保留 CR）；无论成功/失败都在 finally 关闭读取器。
	 */
	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		// 快速返回，避免为 0 行做 open/close。
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			// 未设置上限时读到 EOF；设置时读满即停。
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				// undefined 表示文件结束；不是错误。
				if (line.value === undefined) break;
				// 只保留文本，丢弃 terminated 标志；CR 仍在 text 内。
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			// 即使读取出错也关闭句柄；close 本身不抛错。
			await opened.value.close(context);
		}
	}

	/** 一次性读取整个文件的原始字节；signal 传给 readFile，取消中断读取。 */
	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<Uint8Array>(signal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 打开二进制读取器：noFollow 时拒绝跟随最终组件的符号链接；只接受普通文件。
	 * POSIX 用 O_NOFOLLOW + O_NONBLOCK（打开 FIFO 不阻塞），Windows 改为打开前 lstat 检查（存在竞态）。
	 * 打开后取消会关闭句柄并返回 aborted。
	 */
	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<BinaryReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		const noFollow = options?.noFollow === true;
		let file: FileHandle | undefined;
		try {
			let flags = constants.O_RDONLY;
			if (process.platform === "win32") {
				// Windows has no O_NOFOLLOW; check the final component before opening (not race-free).
				// Windows 没有 O_NOFOLLOW；只能先检查再打开，期间链接可能被替换，因此不是无竞态的。
				if (noFollow && (await lstat(resolved)).isSymbolicLink()) return err(symlinkRefused(resolved));
			} else {
				// Nonblocking, so opening a FIFO does not wait for a writer.
				// 非阻塞打开：FIFO 没有写者时也不会卡住；随后的 isFile 检查会拒绝非普通文件。
				flags |= constants.O_NONBLOCK;
				// POSIX 上由内核保证最终组件不是符号链接（返回 ELOOP）。
				if (noFollow) flags |= constants.O_NOFOLLOW;
			}
			file = await openFile(resolved, flags);
			const stats = await file.stat();
			// 目录/FIFO/socket/设备都不支持按二进制文件读取。
			if (!stats.isFile()) {
				await file.close().catch(() => undefined);
				return err(
					stats.isDirectory()
						? // 目录给出更具体的 is_directory，其他类型统一 invalid。
							new FileError("is_directory", "EISDIR: illegal operation on a directory, read", resolved)
						: new FileError("invalid", "Not a regular file", resolved),
				);
			}
			const afterOpenAbort = abortResult<BinaryReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await file.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeBinaryReader(file, resolved));
		} catch (error) {
			// 任何失败路径都关闭可能已打开的句柄。
			await file?.close().catch(() => undefined);
			// O_NOFOLLOW reports a final-component symlink as ELOOP (EMLINK on some BSDs).
			// O_NOFOLLOW 命中符号链接时内核报 ELOOP（部分 BSD 报 EMLINK），统一转成 invalid。
			if (noFollow && isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
				return err(symlinkRefused(resolved, toError(error)));
			}
			return err(toFileError(error, resolved));
		}
	}

	/** 覆盖写入文件：先递归创建父目录，再写内容；取消信号传给 writeFile。
	 * 父目录创建后、写入前会再检查一次取消；写入可能部分完成后被取消（返回 aborted）。
	 */
	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			// 覆盖已有文件时会先截断再写入，不是“写临时文件再 rename”的原子替换；崩溃持久性由 flushFile 负责。
			await writeFile(resolved, content, { signal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 追加内容：先递归创建父目录；appendFile 本身没有 signal 参数，写入后再检查取消。
	 * 因此返回 aborted 时内容可能已经追加成功，调用者应按“结果未知”处理。
	 */
	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(signal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			// 追加不携带 signal：取消只能在写完后通过 afterAppendAbort 反映。
			await appendFile(resolved, content);
			// 写入已发生；这里返回 aborted 不代表没有追加。
			const afterAppendAbort = abortResult<void>(signal, resolved);
			return afterAppendAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 把文件截断/扩展到 size 字节：size 必须是安全非负整数；以 r+ 打开，要求文件已存在且可写。 */
	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		// 拒绝 NaN/负数/超出安全整数范围，避免底层截断到意外大小。
		if (!Number.isSafeInteger(size) || size < 0) {
			return err(new FileError("invalid", "File size must be a non-negative safe integer", resolved));
		}
		let file: Awaited<ReturnType<typeof openFile>> | undefined;
		try {
			// r+：文件必须存在；不存在返回 not_found，而不是创建新文件。
			file = await openFile(resolved, "r+");
			await file.truncate(size);
			const afterTruncateAbort = abortResult<void>(signal, resolved);
			return afterTruncateAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			await file?.close().catch(() => undefined);
		}
	}

	/** fsync 文件：等待数据与元数据落盘；以 r+ 打开，要求文件已存在且可写。 */
	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<void>(signal, resolved);
		if (aborted) return aborted;
		let file: Awaited<ReturnType<typeof openFile>> | undefined;
		try {
			file = await openFile(resolved, "r+");
			// POSIX refuses to open a directory for writing; Windows opens it, so check explicitly.
			// Windows 允许以写方式打开目录；显式拒绝，保持与 POSIX 一致的 is_directory。
			if ((await file.stat()).isDirectory()) return err(new FileError("is_directory", "Is a directory", resolved));
			// fsync；返回后数据已提交到存储设备（具体保证取决于文件系统）。
			await file.sync();
			const afterSyncAbort = abortResult<void>(signal, resolved);
			return afterSyncAbort ?? ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			await file?.close().catch(() => undefined);
		}
	}

	/** 重命名/移动文件：底层 rename，同一文件系统内原子；目标已存在时通常会被覆盖。
	 * 取消只在操作前检查；错误路径优先报告 source，但 Node 错误自带 path 时以它为准。
	 */
	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = resolvePath(this.cwd, sourcePath);
		const destination = resolvePath(this.cwd, destinationPath);
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		try {
			// 不先删除目标；rename 的覆盖语义由平台保证。
			await rename(source, destination);
			return ok(undefined);
		} catch (error) {
			// 失败可能发生在源或目标；Node 错误带 path 时 toFileError 会采用更精确的那个。
			return err(toFileError(error, source));
		}
	}

	/** 用 lstat 查询元数据：符号链接报告为 symlink，不跟随到目标；不存在返回 not_found。 */
	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			// lstat 而非 stat：调用者需要知道路径本身是链接还是普通文件。
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 列出目录的直接子项（不递归）：先 readdir 拿名字，再逐项 lstat 拿 size/mtime。
	 * 每个条目之间检查取消；不支持的类型静默省略；任一条目 lstat 失败都会使整个调用失败。
	 */
	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const signal = context.abortSignal;
		const aborted = abortResult<FileInfo[]>(signal, resolved);
		if (aborted) return aborted;
		try {
			// Dirent 只有类型和名字；FileInfo 需要 size/mtime，所以后面还要 lstat。
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				// 大目录逐项检查取消，避免取消后仍遍历全部。
				const loopAbort = abortResult<FileInfo[]>(signal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					// lstat 不跟随子项链接；链接以 symlink 形式返回。
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 打开分页目录读取器；适合大目录，避免一次性构造完整 FileInfo 数组。
	 * opendir 后若已取消，关闭目录句柄并返回 aborted。
	 */
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<DirReader>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			// opendir 只打开目录，不读取全部条目；读取由 DirReader.next 分页完成。
			const dir = await opendir(resolved);
			const afterOpenAbort = abortResult<DirReader>(context.abortSignal, resolved);
			if (afterOpenAbort) {
				await dir.close().catch(() => undefined);
				return afterOpenAbort;
			}
			return ok(new NodeDirReader(dir, resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 返回真实绝对路径（realpath）：解析所有符号链接与 ".."；路径必须存在。 */
	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 判断路径是否存在：只有 not_found 映射为 false，权限不足等其他错误仍返回 err。 */
	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		// 其他错误不能被当成“不存在”，否则会掩盖权限/IO 问题。
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	/** 创建目录；recursive 默认 true（与 Node fs.mkdir 默认 false 不同），recursive 为 true 时已存在的目录视为成功。 */
	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			// recursive 默认 true；显式 false 时父目录必须已存在。
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 删除文件或目录；recursive 默认 false，force 默认 false（不存在时报 not_found，除非 force）。 */
	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		try {
			// 透传 Node rm 的语义：递归删除目录需要 recursive=true。
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 在系统临时目录下创建唯一目录；prefix 默认 "tmp-"，返回完整路径。
	 * mkdtemp 会追加随机后缀，因此 prefix 不需要自己保证唯一。
	 */
	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		try {
			// 空字符串是合法前缀，只有 undefined/null 才用默认值。
			prefix ??= "tmp-";
			// tmpdir 跟随 TMPDIR/TEMP 等环境变量；目录权限由 mkdtemp 设为本用户可访问。
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	/** 创建唯一临时文件：先建一个临时目录，再在其中用 prefix+UUID+suffix 命名并创建空文件。
	 * 返回文件路径；临时目录不会自动删除，调用者需要时用 remove 清理。
	 */
	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		// UUID 保证同一目录内不冲突；prefix/suffix 供调用者识别文件用途（例如 pi-output-*.log）。
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			// 真正创建文件；失败时临时目录会残留，但错误信息包含文件路径。
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	/** 终止仍在本环境登记的活跃子进程（整棵进程树）并清空集合；用于宿主关闭/测试清理。 */
	async cleanup(_context: Context): Promise<void> {
		// 不等待退出；settle 仍会把 pid 从集合中移除，因此清理是尽力而为。
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}
// 转导出：调用者配置 NodeExecutionEnv.watch 时无需直接依赖 node-watch 模块。
export type { NodeWatchOptions } from "./node-watch.ts";
