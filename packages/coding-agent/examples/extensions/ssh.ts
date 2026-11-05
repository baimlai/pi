/**
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/extensions 的扩展示例系列，主题是“通过 SSH 把工具
 * 执行转发到远程主机”。
 * 上游：用 `pi -e ./ssh.ts --ssh user@host[:/remote/path]` 加载；模型调用 read/write/edit/
 * bash 工具时进入扩展注册的同名工具。下游：node:child_process.spawn 启动系统 ssh 命令；
 * createReadTool/createWriteTool/createEditTool/createBashTool 的 operations 选项替换本地
 * 文件/命令执行；session_start 读取 --ssh flag；user_bash 事件接管用户 ! 命令；
 * before_agent_start 修改系统提示中的工作目录。
 *
 * 演示的机制：工具工厂把“读文件、写文件、建目录、执行命令”抽象成操作对象；扩展提供
 * 远程实现后，同一个内置工具逻辑就能在远端运行。路径用字符串前缀替换把本地 cwd 映射为
 * 远程 cwd，因此只适用于本地路径以 localCwd 开头的情况。
 *
 * 能力清单：
 * - sshExec(remote, command)：执行一次远程命令并收集 stdout，非 0 退出码 reject。
 * - createRemoteReadOps：cat/test -r/file --mime-type 实现读操作。
 * - createRemoteWriteOps：base64 管道写文件、mkdir -p 建目录。
 * - createRemoteEditOps：复用读/写操作，供编辑工具使用。
 * - createRemoteBashOps：exec 通过 ssh 执行命令，处理超时、abort 与退出码。
 * - 默认导出：注册 4 个覆盖工具、解析 --ssh、接管 user_bash、改写系统提示。
 *
 * 典型运行顺序：带 --ssh 启动 -> session_start 解析远程工作目录并显示状态 -> 模型读取或
 * 修改文件 -> 操作实际发生在远端 -> 用户 ! 命令也在远端执行。
 *
 * 示例（真实签名）：
 *   createReadTool(localCwd, { operations: createRemoteReadOps(remote, remoteCwd, localCwd) });
 *   // 返回的工具对象与内置 read 结构相同，execute 时调用远程 operations。
 *
 * 建议阅读顺序：先看 sshExec，再看四个 createRemote*Ops，最后看默认导出中的工具注册与
 * 三个事件处理器。
 *
 * 前置条件：SSH 必须使用密钥认证（不能弹出密码提示）；远端需要 bash 与常用命令；示例不会
 * 做 shell 转义之外的路径校验，路径映射只是字符串替换，不是完整的安全边界。
 */

/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

// 执行一次远程命令：把命令作为单个参数交给 ssh，收集 stdout 与 stderr。
// 注意：stdio 的 stdin 设为 ignore，因此需要交互输入的命令无法工作。
function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		// spawn 不经过本地 shell；command 字符串整体由远端 shell 解释。
		const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		// 数据可能分多个 chunk 到达，先收集再拼接，避免假设一次 data 事件包含全部输出。
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		// spawn 本身失败（例如找不到 ssh 可执行文件）走 error 事件。
		child.on("error", reject);
		child.on("close", (code) => {
			// 非 0 退出码视为失败；stderr 内容拼进错误消息便于诊断。
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				// 成功时只返回 stdout；stderr 被丢弃。
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

// 读操作的远程实现；toRemote 只是字符串替换，不做路径规范化。
function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	// 把本地绝对路径前缀换成远程目录；不匹配的路径保持不变。
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		// JSON.stringify 给路径加双引号并转义，避免空格/特殊字符被远端 shell 拆分。
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		// test -r 只验证可读；成功时 sshExec 返回空 Buffer，转成 void 满足接口。
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				// file --mime-type -b 只输出 MIME 类型本身。
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				// 只有内置支持的图片类型才返回，其他一律 null。
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				// 检测失败不影响读取：返回 null 表示“不是可识别图片”。
				return null;
			}
		},
	};
}

// 写操作的远程实现；内容先 base64 编码，避免引号、换行和二进制被 shell 破坏。
function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			// Buffer.from(content) 默认 UTF-8；base64 只含安全字符，可放进双引号参数。
			const b64 = Buffer.from(content).toString("base64");
			// 远端 base64 -d 解码后重定向到目标文件；> 会覆盖已有文件。
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		// mkdir -p 允许目录已存在，并递归创建父目录。
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

// 编辑工具只需要读、可读检查与写三个操作；直接复用上面的远程实现。
function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

// bash 操作的远程实现：命令、cwd、超时与 abort 语义要与本地实现保持一致。
function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				// 先 cd 到映射后的目录再执行命令；command 未转义，按调用方提供的 shell 语法执行。
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				// timedOut 记录超时原因，close 回调需要区分超时与主动 abort。
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				// stdout 与 stderr 都交给 onData，调用方按同一路流处理。
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				// abort 时结束子进程；once 保证监听器只触发一次。
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					// close 后移除监听，避免 signal 长时间存活时积累监听器。
					signal?.removeEventListener("abort", onAbort);
					// 三种终止原因按优先级判断；exitCode 为 null 时也走 resolve。
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

// 扩展入口：先创建本地工具作为兜底，再注册四个同名覆盖工具。
export default function (pi: ExtensionAPI) {
	// 注册字符串 flag；加载扩展时还读不到 CLI 值，要等 session_start。
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	// 本地 cwd 在工厂阶段固定；工具参数的相对路径由内置工具基于它解析。
	const localCwd = process.cwd();
	// 预创建本地工具实例，SSH 未启用时直接复用，避免每次调用重新构造。
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	// 延迟解析：null 表示未启用 SSH 或尚未解析。
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;

	// 用函数读取闭包变量，保证 execute 总能看到最新解析结果。
	const getSsh = () => resolvedSsh;

	// 覆盖内置 read：有 SSH 时创建带远程 operations 的新工具，否则走本地。
	pi.registerTool({
		// 展开本地工具定义，继承 name/label/description/parameters/渲染函数。
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				// 每次调用都新建工具对象；operations 捕获当前远程配置。
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	// 覆盖内置 write，逻辑与 read 相同，只是替换写操作。
	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteTool(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	// 覆盖内置 edit；编辑逻辑本身不变，读/写落到远端。
	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditTool(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	// 覆盖内置 bash；超时、abort、流式输出语义由 createRemoteBashOps 保持。
	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	// 会话启动时解析 flag；此时 CLI 参数已可用。
	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		// 类型断言来自 getFlag 的返回类型 string | boolean | undefined；flag 声明为 string。
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			// user@host:/path 形式直接拆分；只按第一个冒号拆分，路径中可再含冒号。
			if (arg.includes(":")) {
				const [remote, path] = arg.split(":");
				resolvedSsh = { remote, remoteCwd: path };
			} else {
				// No path given, evaluate pwd on remote
				// 未给路径时执行远端 pwd，trim 去掉换行。
				const remote = arg;
				const pwd = (await sshExec(remote, "pwd")).toString().trim();
				resolvedSsh = { remote, remoteCwd: pwd };
			}
			// 状态栏显示远程目标；setStatus 的 key 固定为 "ssh"。
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
			// 同时发通知，确保用户知道命令不会在本地执行。
			ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
		}
	});

	// Handle user ! commands via SSH
	// 用户输入的 ! 命令也走远程；返回 undefined 表示沿用本地执行。
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Replace local cwd with remote cwd in system prompt
	// 系统提示里的工作目录若仍是本地路径，模型会误判文件位置，因此这里替换。
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			// replace 只替换第一处匹配；提示词中通常只有一行工作目录。
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
