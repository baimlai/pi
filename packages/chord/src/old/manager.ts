// Host manager (Node only): runs a child host process and keeps at most one instance of it alive.
// 文件导读（Chord v1 的 Node 子进程宿主管理）
// ==========================================
// 所属包与模块：packages/chord/src/old/manager.ts，是 Chord v1 的 Node 专用层，入口为 old/node.ts。
// 它把“子宿主进程”当成一个可启动、可观察、可替换的资源：fork 子进程、复用 Node IPC 通道发送控制消息、
// 监视存活状态、按宽限期关闭并清理整个进程组，以及用内核 socket 锁保证同名宿主只有一个存活实例。
//
// 职责边界：本文件不实现 Chord 协议帧、不创建宿主对象、不打开存储；只负责进程生命周期与控制通道。
// 上游：应用从 "@earendil-works/chord/old/node" 导入 createHostManager/forkDriver；子进程入口导入 childControl。
// 下游：link.ts 的 ipcLink（把 ChildProcess/process 包装成 Link）、errors.ts 的 ChordError，以及 node 内置的
// child_process/fs/net/os/crypto/path 模块。
// 结果与错误：start() 在子进程 ready 前完成或失败；spawn 抛错原样上抛；超时、提前退出或 fatal 转为
// unavailable 的 ChordError；stop() 在宽限期后强杀进程树；写控制消息失败被忽略，因为退出会经 exited/onExit 报告。
//
// 能力清单（导出项）：
// - ControlMessage：控制通道上的 init/ready/fatal/shutdown/status 联合消息。
// - Liveness / Exit：暴露给 keepAlive 的存活快照，以及子进程退出结果。
// - Instance：一个已启动子进程的 pid、link、exited、send/killTree/onControl。
// - Driver / ForkDriverOptions：可替换的启动器接口，以及 forkDriver 的选项。
// - processLock(name)：用内核 socket 实现跨进程单实例锁，返回异步 release 函数。
// - forkDriver(options)：用 node:child_process.fork 创建 Driver；子进程独立进程组，退出时清理后代。
// - HostManagerOptions / HostManager：管理器选项和 start/stop/replace/status/liveness 接口。
// - createHostManager(options)：创建串行化状态机，保证同一时刻最多一个子进程。
// - childControl(channel)：子进程侧控制端，提供 init/lock/ready/fatal/report/onShutdown。
//
// 组合关系与典型顺序：
//   父进程：forkDriver({ entry, init, lock }) -> createHostManager({ driver }) -> start()
//           -> 把 instance.link 交给 createHost(...).accept(...) -> stop() 或 replace()
//   子进程：childControl() -> await init -> await lock()（打开存储前）-> ready() -> report(status)
//           -> onShutdown(handleShutdown)
// 例子（示例，不是自动执行的代码）：
//   const manager = createHostManager({
//     driver: forkDriver({ entry: "/path/to/worker.js", init: { greeting: "hi" }, lock: "app:data" }),
//     keepAlive: (liveness) => liveness.idleFor < 60_000,
//   });
//   const instance = await manager.start(); // instance.link 可交给宿主 accept
//   await manager.stop();
//
// 建议阅读顺序：先看 ControlMessage/Liveness/Instance/Driver 这些数据契约，再看 processLock 的内核锁模型，
// 然后读 forkDriver 如何启动并包装子进程，接着读 createHostManager 的串行状态机，最后看子进程侧 childControl。
import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChordError } from "./errors.ts";
import { type IpcChannel, type IpcLink, ipcLink } from "./link.ts";

/** Control messages share the IPC channel with chord frames: `{ chord2control: message }`. */
// 控制消息与 Chord 协议帧共用同一条 IPC 通道：只有外层带 chord2control 字段的对象才是控制消息，
// 其余消息原样交给应用（ForkDriverOptions.onMessage）。type 是字符串字面量判别字段；
// 在 switch 或 if 中判断 type 后，TypeScript 会把联合收窄到对应成员，访问其它成员才存在的字段会报错。
export type ControlMessage =
	// init：父进程传给子进程的启动参数；由 forkDriver 的 options.init 发送，子进程用 childControl().init 等待。
	| { readonly type: "init"; readonly value: unknown }
	// ready：子进程完成初始化，管理器据此把状态从 starting 变为 running。
	| { readonly type: "ready" }
	// fatal：子进程在启动阶段失败；message 是必填文字，reason 可选，用来保留 ChordError 的细分原因。
	| { readonly type: "fatal"; readonly message: string; readonly reason?: string }
	// shutdown：父进程请求子进程优雅退出；子进程通过 onShutdown 注册的回调处理。
	| { readonly type: "shutdown" }
	// status：子进程报告当前负载；三个计数字段都可省略，管理器读取时用 ?? 0 补齐。
	| {
			readonly type: "status";
			readonly activeCalls?: number;
			readonly viewers?: number;
			readonly durableTasks?: number;
	  };

// Liveness 是管理器和 keepAlive 回调之间的只读快照。它由子进程上报的 status 加本地时间计算，
// 字段类型只做编译期约束；运行时不校验子进程报来的数字是否合法（IPC 另一端属于同一应用）。
export interface Liveness {
	/** Started but not ready yet. */
	// booting 为 true 表示已经 spawn 但还没收到 ready；此阶段 activeCalls 等计数都为 0。
	readonly booting: boolean;
	// 子进程自己统计的进行中调用数。
	readonly activeCalls: number;
	/** Viewers the child reports (it counts heartbeating subscribers). */
	// 子进程统计的订阅者数；具体如何计数由子进程实现，本文件只转发。
	readonly viewers: number;
	// 子进程统计的持久任务数。
	readonly durableTasks: number;
	/** Milliseconds since the child last reported work (calls, viewers or tasks), or since it became ready. */
	// 空闲毫秒数：从“忙 → 闲”的转换开始计时，而不是从最后一次繁忙报告开始；见 createHostManager 的 idleSince。
	readonly idleFor: number;
}

// 子进程退出结果，直接对应 Node child_process 的 exit 事件参数：
// 正常退出时 code 是数字、signal 为 null；被信号杀死时 code 为 null、signal 是信号名。
export interface Exit {
	readonly code: number | null;
	readonly signal: string | null;
}

/** A running child: its link (for `host.accept`) and its exit. */
// Instance 是 Driver.spawn() 的产物，也是 HostManager 对外暴露的“当前子进程”。
// link 是已经包装好的 IPC 链路，可直接交给宿主 accept；exited 在子进程退出时完成，且永远不会拒绝。
export interface Instance {
	// fork 后的进程号；若 Node 没有给出 pid，forkDriver 用 -1 兜底。
	readonly pid: number;
	// Chord 帧链路；控制消息不经过它，而是走 send/onControl。
	readonly link: IpcLink;
	readonly exited: Promise<Exit>;
	// 发送一条控制消息；通道已断开时静默丢弃。
	send(message: ControlMessage): void;
	/** Kills the child and everything it spawned. */
	// 强杀子进程及其进程组（forkDriver 让子进程成为组长）；失败时退化为只杀子进程。
	killTree(): void;
	// 注册控制消息监听器；没有对应的注销方法，监听器随 Instance 一起被丢弃。
	onControl(listener: (message: ControlMessage) => void): void;
}

// Driver 把“如何启动一个子宿主”抽象出来：生产环境用 forkDriver，测试可注入假实现。
// 接口只有一个同步 spawn 方法；spawn 抛错由 createHostManager.doStart 捕获并把状态复位。
export interface Driver {
	spawn(): Instance;
}

// forkDriver 的选项。所有字段都是 readonly，避免启动后调用方再改配置造成两个子进程行为不一致。
export interface ForkDriverOptions {
	/** The child's entry module. */
	// 子进程入口模块路径，等价于 node 命令的第一个参数。
	readonly entry: string;
	// 传给入口模块的额外命令行参数；forkDriver 用展开语法复制成新数组，不持有调用方数组。
	readonly args?: readonly string[];
	// 追加/覆盖到子进程环境变量上的键值；会先复制父进程的 env，再 Object.assign 覆盖。
	readonly env?: Readonly<Record<string, string>>;
	/** Node flags for the child, e.g. `["--import", sourceResolver]` (default: none). */
	// 传给子进程的 Node 选项，例如源码解析 hook；同样复制成新数组，默认空数组。
	readonly execArgv?: readonly string[];
	/** Sent to the child as its first control message (`childControl().init`). */
	// 启动参数；只要不是 undefined，就会在 spawn 后立即作为第一条控制消息发送。
	readonly init?: unknown;
	/**
	 * A lock name: one live process per name, across managers and processes. The child acquires it as a kernel lock
	 * (`childControl().lock()`, before opening its storage); a second child fails to start with `unavailable/locked`.
	 */
	// 锁名：同名锁跨管理器和进程只允许一个存活持有者。forkDriver 把它写进子进程环境变量 CHORD2_LOCK，
	// 子进程必须显式调用 childControl().lock() 才真正获取；本文件不会替子进程取锁。
	readonly lock?: string;
	/** Optional stdout/stderr tap. Streams are still mirrored to the parent's standard output. */
	// 可选输出旁路：收到数据时先回调，再原样写到父进程同名标准流，所以不会吞掉日志。
	readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
	/** Optional application metadata tap; control messages and chord frames keep their normal handling. */
	// 可选消息旁路：每条 IPC 消息都会先经过它；带 chord2control 的仍继续分发给控制监听器，
	// 带 chord2 的仍由 IpcLink 处理，因此不会改变正常路由。
	readonly onMessage?: (message: unknown) => void;
}

/**
 * A process lock owned by the kernel for the holder's lifetime: an abstract socket (Linux, Android) or a named pipe
 * (Windows) vanishes with its process, so there is no stale state to take over and no race between two would-be
 * owners. Other platforms need a socket file, removed on exit; a leftover one nobody accepts on is taken over.
 * The child acquires it (before opening storage), so the lock follows the process that owns the data.
 */
// 获取一个跨进程的命名锁，返回释放函数。
//
// 输入：name 是应用给定的锁名（例如 "chord-app:<dataDir>"），函数内部再哈希成合法的 socket 名。
// 输出：Promise<释放函数>；释放函数再返回 Promise<void>，关闭监听 socket 后才完成。
// 副作用：创建一个只用于监听的本地 socket（Windows 命名管道 / Linux 抽象 socket / 其它平台的 socket 文件）。
// 错误：第二个持有者得到 ChordError("unavailable", reason: "locked")；其它 listen 错误原样抛出。
// 主要流程：把锁名哈希成固定长度地址 -> 选择平台地址 -> 循环 listen -> 地址被占用时区分“活动持有者”
// 与“残留文件” -> 成功即持有，返回关闭函数。
//
// 为什么用监听 socket 当锁：持有点只要求一个活的监听者，进程死亡时内核会回收地址；因此不需要写 PID 文件，
// 也不存在两个进程同时判断“文件已过期”再互相覆盖的竞态。
// 示例：
//   const release = await processLock("app:data");
//   await processLock("app:data"); // 另一个调用会以 unavailable/locked 拒绝
//   await release();
export async function processLock(name: string): Promise<() => Promise<void>> {
	// 哈希把任意锁名压成 32 个十六进制字符，既满足 socket 名长度限制，又避免名字里的路径分隔符。
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	// 只有 Windows 之外的平台可能使用文件系统 socket；Linux/Android 用抽象的、不落盘的 socket 名。
	const file = process.platform !== "win32" && process.platform !== "linux" && process.platform !== "android";
	// 三元表达式按平台选择地址：Windows 命名管道；需要文件 socket 的平台走 lockSocketPath；
	// 其余（Linux/Android）用前导 NUL 表示抽象命名空间。字符串里 \\\\.\\pipe\\ 是 JS 转义后的 \\.\pipe\。
	const address =
		process.platform === "win32"
			? `\\\\.\\pipe\\chord2-${key}`
			: file
				? await lockSocketPath(`chord2-${key}.sock`)
				: `\0chord2-${key}`;
	// 监听 socket 只承担“占用地址”的作用：任何探测连接都被立即关闭，不传输数据。
	const server = createServer((socket) => socket.end());
	// 循环处理“地址被占用”的两种情况：有活的持有者就失败；只有没人接受的残留文件就删除后重试。
	for (;;) {
		try {
			// once("error") 只监听第一次错误；listen 成功时移除它，避免之后连接错误被误当启动错误。
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(address, () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			// listen 成功：本进程成为唯一持有者，跳出重试循环。
			break;
		} catch (error) {
			// 只有“地址已存在”才进入锁判定；其它错误（权限、路径过长等）原样上抛。
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// 抽象 socket/命名管道无法残留：EADDRINUSE 就说明有活进程；文件 socket 则要探测是否真有人接受。
			// accepting 返回 false 只代表连接被拒绝或文件不存在，因此可以安全删除后重试。
			if (!file || (await accepting(address))) {
				throw new ChordError("unavailable", `lock ${name} is held by another process`, { reason: "locked" });
			}
			await rm(address, { force: true });
		}
	}
	// 进程退出清理：文件 socket 不会随进程消失，必须在 exit 时删除；unlinkSync 是同步的，exit 回调不能 await。
	const removeFile = (): void => {
		try {
			unlinkSync(address);
		} catch {
			// 已经被释放函数或其它清理路径删除；忽略即可。
			// Already gone.
		}
	};
	// 只有文件 socket 需要额外注册 exit 清理；抽象 socket 和命名管道由内核随进程回收。
	if (file) process.once("exit", removeFile);
	// 返回释放函数：先移除 exit 清理，避免重复删除；再关闭 server，关闭完成或失败才结束 Promise。
	return () =>
		new Promise<void>((resolve, reject) => {
			if (file) process.removeListener("exit", removeFile);
			// Node 的 server.close 回调参数是可选的错误；有错误时拒绝，否则完成。
			server.close((error) => (error ? reject(error) : resolve()));
		});
}

/** sun_path references 104 bytes on macOS and the BSDs, including the terminating NUL. */
// 103 = 104 字节的 sun_path 减去结尾的 NUL；这是 macOS/BSD 的套接字路径长度限制。
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * The lock socket's path: in the temporary directory, or, when that path does not fit in sun_path (a deep TMPDIR,
 * such as a test runner's below macOS's per-user one), in a private per-user directory under /tmp. Other users must
 * not be able to create or remove sockets there, so the directory has to be ours and closed to everyone else.
 */
// 计算文件 socket 的路径。
// 输入：file 是已经带 .sock 后缀的文件名（不含目录）。输出：可交给 server.listen 的绝对路径。
// 副作用：路径过长时创建 /tmp/chord2-<uid> 私有目录。错误：目录不属于当前用户、不是目录或权限过宽时抛 unavailable。
// 流程：优先 TMPDIR；超出 sun_path 限制时改用 /tmp 下按 uid 隔离的目录，避免使用别人的目录放置 socket。
// 示例：TMPDIR 很深时返回 "/tmp/chord2-501/chord2-<hash>.sock"；普通情况下返回 "<tmpdir>/chord2-<hash>.sock"。
async function lockSocketPath(file: string): Promise<string> {
	// 首选系统临时目录；路径长度按 UTF-8 字节数计算，而不是 JS 字符串长度。
	const preferred = join(tmpdir(), file);
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	// getuid 在 Windows 上不存在；本函数只在需要文件 socket 的平台调用，?? 0 只是类型兜底。
	const uid = process.getuid?.() ?? 0;
	const directory = `/tmp/chord2-${uid}`;
	// 递归创建，mode 0o700 表示只有属主可读写执行；recursive 对已存在目录不报错。
	await mkdir(directory, { mode: 0o700, recursive: true });
	// lstat 不跟随符号链接，能识别“目录被替换成链接”的情况。
	const stats = await lstat(directory);
	// 三个条件缺一不可：是目录、属于当前 uid、组和其他用户没有任何权限（0o077 掩码为 0）。
	if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
		throw new ChordError("unavailable", `lock directory ${directory} must be a directory only its owner can access`);
	}
	return join(directory, file);
}

// 探测某个本地 socket 地址是否有人接受连接。
// 输出：连接成功为 true；ECONNREFUSED（有文件但无人监听）或 ENOENT（文件不存在）为 false；
// 其它错误保守地当作 true（无法证明地址空闲，就不抢锁）。没有超时，依赖本地连接很快返回。
function accepting(address: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(address);
		// 连上就说明另一个进程正在监听；立即 destroy，不对它发送任何数据。
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		// 这两种错误都表示“没有活着的监听者”；其余错误可能来自权限等，按“可能被占用”处理。
		socket.once("error", (error: NodeJS.ErrnoException) =>
			resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"),
		);
	});
}

// 子进程从环境变量读取锁名；forkDriver 负责写入，childControl().lock() 负责读取并真正取锁。
const LOCK_ENV = "CHORD2_LOCK";

/** A control message to a peer process that is gone: dropped (its exit or `disconnect` is reported separately). */
// child.send 的回调：对端已经退出时写会失败（EPIPE），这里故意吞掉；进程退出本身通过 exited/onExit 报告。
const ignoreSendError = (): void => {};

// 创建一个基于 node:child_process.fork 的 Driver。
// 输入：ForkDriverOptions（入口、参数、环境、Node 选项、init、锁名、输出/消息旁路）。
// 输出：Driver；每次调用 spawn() 都会启动一个新的子进程并返回 Instance。
// 副作用：真实 fork 进程、建立 IPC 通道；可选的 stdout/stderr 旁路会把数据同时写到父进程标准流。
// 错误：fork 本身同步抛错时直接上抛（createHostManager 会把状态复位）；子进程启动后的失败通过控制消息报告。
// 主要流程：构造环境变量 -> fork（独立进程组 + IPC）-> 安装输出/消息/退出监听 -> 发送 init -> 返回 Instance。
// 示例：
//   const driver = forkDriver({ entry: "/path/to/worker.js", init: { greeting: "hi" }, lock: "app:data" });
//   const instance = driver.spawn(); // 子进程立即开始运行，等待其 ready() 由管理器负责
export function forkDriver(options: ForkDriverOptions): Driver {
	return {
		spawn() {
			// A lock this process inherited (e.g. as a child host itself) is not the child's: it gets only its own.
			// 复制父进程环境，避免修改真正的 process.env；先删除继承来的锁名，否则子进程会误以为自己继承了父锁。
			const env: NodeJS.ProcessEnv = { ...process.env };
			delete env[LOCK_ENV];
			// 调用方显式提供的 env 覆盖父进程值；随后只有配置了 options.lock 才写入新的锁名。
			Object.assign(env, options.env);
			if (options.lock !== undefined) env[LOCK_ENV] = options.lock;
			// Detached: the child leads a process group, so the whole tree can be killed.
			// detached 让子进程成为新进程组组长，之后可以用 kill(-pid) 一次清理它和它派生的所有后代。
			// args/execArgv 都用展开语法复制，避免 Node 或后续调用修改调用方传入的数组。
			// stdio 第 0 项忽略 stdin；第 1/2 项在有 onOutput 时用 pipe 以便旁路，否则 inherit 直接继承父进程流；
			// 第 4 项 "ipc" 是控制消息和 Chord 帧共用的通道。
			const child: ChildProcess = fork(options.entry, [...(options.args ?? [])], {
				env,
				execArgv: [...(options.execArgv ?? [])],
				detached: true,
				stdio: ["ignore", options.onOutput ? "pipe" : "inherit", options.onOutput ? "pipe" : "inherit", "ipc"],
			});
			if (options.onOutput) {
				// as const 把数组元素推断为 "stdout" | "stderr" 字面量，child[stream] 才能索引到对应的可读流。
				for (const stream of ["stdout", "stderr"] as const) {
					// ?. 是因为 stdio 配置在类型上仍可能得到 undefined；实际上这里已选择 pipe。
					child[stream]?.on("data", (chunk: Buffer) => {
						// ! 断言 onOutput 存在：外层 if 已经确认；先把数据交给旁路，再镜像到父进程同名流。
						options.onOutput!(stream, chunk);
						process[stream].write(chunk);
					});
				}
			}
			// fork 异步失败（error 事件）时 child.pid 可能为 undefined；-1 只是兜底。
			// 后续 kill(-pid) 会因目标不存在或无权限抛错，由 catch 处理（killTree 再退化为只杀子进程）。
			const pid = child.pid ?? -1;
			// 负 pid 表示整个进程组；SIGKILL 不可被捕获，确保关闭不会被忽略。
			const killGroup = (): void => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// 进程组已经不存在。
					// No group left.
				}
			};
			// exited 永远不会 reject：Node 的 exit 事件只给出 code/signal，这里原样保存。
			const exited = new Promise<Exit>((resolve) => {
				child.once("exit", (code, signal) => {
					// However the leader ended (graceful, crash, kill), nothing it spawned outlives it.
					// 组长退出后仍可能有后代存活，所以退出时再清一次整个进程组。
					killGroup();
					resolve({ code, signal });
				});
			});
			// 控制消息监听器集合；Instance.onControl 只增不减，实例被替换后集合随闭包回收。
			const listeners = new Set<(message: ControlMessage) => void>();
			child.on("message", (message) => {
				// 先给应用旁路看原始消息；旁路抛出的异常会沿 Node 事件回调传播，本文件不捕获。
				options.onMessage?.(message);
				// 用可选链读取 chord2control；message 可能是 null，也可能是应用自己的任意值。
				const control = (message as { chord2control?: ControlMessage } | null)?.chord2control;
				// 只有显式带 chord2control 的消息才进入控制通道；undefined 表示普通应用消息或 Chord 帧。
				if (control !== undefined) for (const listener of listeners) listener(control);
			});
			const send = (message: ControlMessage): void => {
				// A child that exited before the channel reported it fails the write (EPIPE): its exit is what counts.
				// connected 为 false 时直接放弃；写入失败的 EPIPE 交给 ignoreSendError 吞掉，避免未处理的 error 事件。
				if (child.connected) child.send({ chord2control: message }, ignoreSendError);
			};
			// init 是第一条控制消息；没有配置就不发，子进程的 childControl().init 会一直等待。
			if (options.init !== undefined) send({ type: "init", value: options.init });
			return {
				pid,
				// 双重断言是这里需要的强制转换：ChildProcess 的 send/on 重载比 IpcChannel 更宽，
				// 结构化类型无法自动收窄到所需子集；两者实际满足同一 IPC 契约，运行时不额外检查。
				link: ipcLink(child as unknown as IpcChannel),
				exited,
				send,
				killTree: () => {
					// 优先杀整个进程组；进程组不存在时才退化为只杀直接子进程。
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				},
				// 返回 Set.add 的返回值（Set 本身），但接口声明是 void；调用方不依赖返回值。
				onControl: (listener) => listeners.add(listener),
			};
		},
	};
}

// createHostManager 的配置。driver 必填；其余都是可选策略，默认值在 createHostManager 内联给出。
export interface HostManagerOptions {
	readonly driver: Driver;
	/** Evaluated every `checkInterval` while running; `false` stops the child. */
	// 每次检查时调用；返回 false 触发 stop。它接收上面定义的 Liveness 快照，不返回 Promise。
	readonly keepAlive?: (liveness: Liveness) => boolean;
	// keepAlive 检查间隔，默认 1000 毫秒；定时器会 unref，不阻止父进程退出。
	readonly checkInterval?: number;
	/** Milliseconds a child may take to shut down before its process tree is killed (default 5000). */
	// 发出 shutdown 后等待子进程自行退出的宽限期，超时则 killTree；默认 5000 毫秒。
	readonly grace?: number;
	/** Milliseconds to wait for `ready` (default 30000). */
	// 等待子进程 ready 的超时；超时以 unavailable 拒绝 start，并杀掉子进程树；默认 30000 毫秒。
	readonly readyTimeout?: number;
	/** The child exited on its own (crash, fatal) or after a stop. */
	// 子进程退出回调：主动 stop 和自行崩溃都会触发；停掉后的正常退出也会调用一次。
	readonly onExit?: (exit: Exit) => void;
}

// HostManager 对外只暴露状态和执行操作，不暴露内部串行队列。
// status 的四个字面量构成状态机；instance 只有在 starting/running/stopping 阶段可能非 undefined。
export interface HostManager {
	readonly status: "stopped" | "starting" | "running" | "stopping";
	readonly instance: Instance | undefined;
	readonly liveness: Liveness;
	/** Starts the child (or returns the running one) once it reported ready. Serialized with stop/replace. */
	// 启动并等待 ready；已有一个 running 实例时直接返回同一个实例。和 stop/replace 共用一条串行队列。
	start(): Promise<Instance>;
	/** Asks the child to shut down, then kills its process tree after the grace period. */
	// 请求优雅关闭，宽限期后强杀整个进程树；没有实例时直接完成。和 start/replace 串行。
	stop(): Promise<void>;
	/** Stop, wait for the exit, start. */
	// 先 stop（等到 exited 完成）再 start，返回新实例；用于代码/配置更新后的替换。
	replace(): Promise<Instance>;
}

// 创建子宿主进程管理器。
// 输入：HostManagerOptions。输出：HostManager，通过 getter 暴露实时状态。
// 副作用：按需 spawn 子进程、发送控制消息、设置 keepAlive 定时器；stop 会杀进程树。
// 错误：spawn 同步错误原样上抛；ready 超时、ready 前退出、子进程 fatal 都转为 unavailable 的 ChordError。
// 主要流程：doStart 启动并等待 ready -> running；doStop 发 shutdown，宽限期内未退出就强杀；
// replace = doStop + doStart；所有操作经 serialized 串行，避免两个启动/停止交错。
// 示例：
//   const manager = createHostManager({ driver: forkDriver({ entry }) });
//   const instance = await manager.start();
//   console.log(manager.status); // "running"
//   await manager.stop();        // 宽限期后仍未退出则强杀进程树
export function createHostManager(options: HostManagerOptions): HostManager {
	// 状态机的当前状态；instance 与 status 一起维护，所有修改都发生在串行步骤里。
	let status: HostManager["status"] = "stopped";
	let instance: Instance | undefined;
	// 串行队列：每次 start/stop/replace 都接到队尾，保证不会同时操作两个子进程。
	let queue: Promise<unknown> = Promise.resolve();
	// 最近一次 status 消息的计数；初始为 0，start 时会重置。
	let report = { activeCalls: 0, viewers: 0, durableTasks: 0 };
	/** When the child last became idle; undefined while it reports work. */
	// 最近一次进入空闲的时刻；undefined 表示当前有工作（或尚未开始计时）。
	let idleSince: number | undefined;
	let booting = false;
	// keepAlive 的定时器句柄；stop 和子进程退出时都要清理，避免重复触发。
	let timer: ReturnType<typeof setInterval> | undefined;

	// 把一个步骤接到串行队列尾部。then(step, step) 表示无论上一步成功还是失败都执行下一步；
	// 这样一次失败的 start 不会卡死后续 stop/replace。queue 自己吞掉错误以保持链可用，
	// 但返回给调用方的 next 保留原始成功/失败结果。
	const serialized = <T>(step: () => Promise<T>): Promise<T> => {
		const next = queue.then(step, step);
		queue = next.catch(() => {});
		return next;
	};

	// 构造不可变的存活快照：spread 把 report 的三个计数字段展开进来，再补 booting 和计算出的 idleFor。
	const liveness = (): Liveness => ({
		booting,
		...report,
		idleFor: idleSince === undefined ? 0 : Date.now() - idleSince,
	});

	// 停止当前子进程；没有实例时只复位状态。
	const doStop = async (): Promise<void> => {
		const current = instance;
		if (current === undefined) {
			// 已经停止或从未启动：确保 booting 残留被清掉。
			status = "stopped";
			booting = false;
			return;
		}
		status = "stopping";
		// 先停止 keepAlive 定时器，否则它在关闭过程中还会再次触发 stop。
		if (timer !== undefined) clearInterval(timer);
		current.send({ type: "shutdown" });
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		// Promise.race：谁先完成就用谁的结果。exited 完成返回 true；宽限定时器触发返回 false。
		// graceTimer 在 Promise 执行器里赋值，之后 clearTimeout(undefined) 是允许的（无操作）。
		const graceful = await Promise.race([
			current.exited.then(() => true),
			new Promise<boolean>((resolve) => {
				graceTimer = setTimeout(() => resolve(false), options.grace ?? 5000);
			}),
		]);
		clearTimeout(graceTimer);
		// 没能在宽限期内优雅退出：强杀整个进程组，然后仍等待 exited，确保 replace 不会与旧子进程重叠。
		if (!graceful) current.killTree();
		await current.exited;
		// 只在仍然是同一个实例时清空；避免误清掉期间替换进来的新实例（正常串行下不会发生）。
		if (instance === current) instance = undefined;
		status = "stopped";
	};

	// 启动子进程并等待它报告 ready；已有 running 实例时直接复用。
	const doStart = async (): Promise<Instance> => {
		if (instance !== undefined && status === "running") return instance;
		status = "starting";
		booting = true;
		// 新实例从零计数开始，避免沿用上一个子进程的负载。
		report = { activeCalls: 0, viewers: 0, durableTasks: 0 };
		let current: Instance;
		try {
			current = options.driver.spawn();
		} catch (error) {
			// fork 同步失败：必须把状态还原，否则后续 start 会误以为正在启动。
			status = "stopped";
			booting = false;
			throw error;
		}
		// 先登记实例再等待 ready，让 exited 监听可以把它清掉；onControl 也已经能收到后续消息。
		instance = current;
		current.exited.then((exit) => {
			// 只有当前实例仍然是它时才清空；replace 时旧实例退出不能覆盖新实例。
			if (instance === current) {
				instance = undefined;
				status = "stopped";
				if (timer !== undefined) clearInterval(timer);
			}
			// 无论是否主动停止，都把退出结果报告给应用。
			options.onExit?.(exit);
		});
		// 等待 ready、fatal 或 exited，三者竞争；settle 统一清理超时定时器，防止重复结算。
		await new Promise<void>((resolve, reject) => {
			// 超时默认 30 秒；Node 的 setTimeout 返回 Timeout 对象，这里只关心清除它。
			const timeout = setTimeout(
				() => reject(new ChordError("unavailable", "child not ready in time")),
				options.readyTimeout ?? 30_000,
			);
			// fn 是 resolve 或 reject 的包装；先 clearTimeout 再结算，避免超时与 ready 同时触发。
			const settle = (fn: () => void): void => {
				clearTimeout(timeout);
				fn();
			};
			// exited 在 ready 前完成视为启动失败；code ?? signal 展示退出码或信号名。
			current.exited.then((exit) =>
				settle(() =>
					reject(new ChordError("unavailable", `child exited before ready (${exit.code ?? exit.signal})`)),
				),
			);
			// ready 消息成功；fatal 消息失败并保留 reason；status 消息只更新计数，不结算。
			current.onControl((message) => {
				if (message.type === "ready") settle(resolve);
				else if (message.type === "fatal")
					settle(() =>
						reject(new ChordError("unavailable", `child failed: ${message.message}`, { reason: message.reason })),
					);
				else if (message.type === "status") {
					// 每个字段都可能省略，用 ?? 0 归一；旧报告被整体替换而非累加。
					report = {
						activeCalls: message.activeCalls ?? 0,
						viewers: message.viewers ?? 0,
						durableTasks: message.durableTasks ?? 0,
					};
					// The idle clock starts at the busy → idle transition, not at the last busy report.
					// 有任意工作时清空计时；空闲时只在尚未计时的情况下记下当前时刻。
					if (report.activeCalls + report.viewers + report.durableTasks > 0) idleSince = undefined;
					else idleSince ??= Date.now();
				}
			});
		}).catch(async (error: unknown) => {
			// 启动失败（超时/提前退出/fatal）：先清理可能还活着的进程树，等退出完成后再抛出原始错误。
			current.killTree();
			await current.exited;
			throw error;
		});
		// 到这里 ready 已经到达；booting 结束。若当前没有工作（从未收到 status，或计数全为 0），把此刻记为首次空闲。
		booting = false;
		if (report.activeCalls + report.viewers + report.durableTasks === 0) idleSince ??= Date.now();
		status = "running";
		if (options.keepAlive !== undefined) {
			// 保存为局部常量，闭包里使用时不需要再次处理 undefined。
			const keepAlive = options.keepAlive;
			timer = setInterval(() => {
				// 只在 running 时检查；返回 false 就排队执行 stop，避免与当前操作交错。
				if (status === "running" && !keepAlive(liveness())) void serialized(doStop);
			}, options.checkInterval ?? 1000);
			// unref 让这个定时器不单独维持父进程事件循环；不支持 unref 的假定时器用可选调用跳过。
			timer.unref?.();
		}
		return current;
	};

	return {
		// getter 每次读取都返回当前值，而不是创建时快照。
		get status() {
			return status;
		},
		get instance() {
			return instance;
		},
		get liveness() {
			// 每次访问都重新计算 idleFor。
			return liveness();
		},
		start: () => serialized(doStart),
		stop: () => serialized(doStop),
		replace: () =>
			serialized(async () => {
				// 串行步骤内部再调用 doStop/doStart，而不是递归 serialized，避免自己等自己造成死锁。
				await doStop();
				return doStart();
			}),
	};
}

/** The child side of the control channel (call in the child's entry). */
// 子进程侧的控制端，应在子进程入口尽早调用。
// 输入：channel 默认是全局 process；测试或特殊运行时可传入结构兼容的对象。
// 输出：init/lock/ready/fatal/report/onShutdown 六个操作。
// 副作用：监听父进程消息；lock() 会创建进程锁；ready/fatal/report 会写 IPC。
// 错误：lock() 失败时先向父进程报 fatal，再把原错误抛给子进程入口；其余发送错误被忽略。
// 流程：等待 init -> 需要时取锁 -> 初始化业务 -> ready() -> 用 report() 汇报负载，并注册 onShutdown。
// 示例：
//   const control = childControl();
//   const init = await control.init;
//   await control.lock();          // 未配置锁时立即返回
//   const app = createApp(init);
//   control.ready();
//   control.onShutdown(() => app.close());
export function childControl(channel: NodeJS.Process = process): {
	readonly init: Promise<unknown>;
	/**
	 * Acquires the manager's lock (if one was configured) as a kernel lock held for this process's lifetime. Call it
	 * before opening storage. Fails with `unavailable/locked`, also reported to the manager as a fatal start error.
	 */
	lock(): Promise<void>;
	ready(): void;
	fatal(error: unknown): void;
	report(status: { activeCalls?: number; viewers?: number; durableTasks?: number }): void;
	onShutdown(handler: () => void | Promise<void>): void;
} {
	const send = (message: ControlMessage): void => {
		// A parent that is gone fails the write (EPIPE); the `disconnect` that follows is how a child notices.
		// 可选调用 send 是因为 Process.send 只在有 IPC 通道的 fork 子进程里存在；connected 已断开时不再尝试。
		// 四个参数对应 Node 的 send(message, sendHandle, options, callback)，最后一项用来吸收 EPIPE。
		if (channel.connected) channel.send?.({ chord2control: message }, undefined, undefined, ignoreSendError);
	};
	// init 的 resolve 先放一个空函数，保证后续同步赋值前类型完整；Promise 只会结算一次，
	// 因此重复收到 init 消息时第二次 resolve 不会改变结果。
	let resolveInit: (value: unknown) => void = () => {};
	const init = new Promise<unknown>((resolve) => {
		resolveInit = resolve;
	});
	// 关闭处理器集合；按注册顺序同步调用，不提供取消注册。
	const shutdown = new Set<() => void | Promise<void>>();
	channel.on("message", (message: unknown) => {
		// 与父进程相同：只有带 chord2control 字段的消息属于控制通道。
		const control = (message as { chord2control?: ControlMessage } | null)?.chord2control;
		// 可选链 + 字面量比较：control 不存在时直接跳过。
		if (control?.type === "init") resolveInit(control.value);
		// void 表示不等待异步处理器；处理器返回的 Promise 若拒绝，本函数不会替它捕获。
		if (control?.type === "shutdown") for (const handler of shutdown) void handler();
	});
	// 把任意异常报给父进程：Error 取 message，其它值转字符串；ChordError 额外保留 reason。
	// 条件展开 ...(cond ? { reason } : {}) 让没有 reason 时不产生该字段。
	const fatal = (error: unknown): void =>
		send({
			type: "fatal",
			message: error instanceof Error ? error.message : String(error),
			...(error instanceof ChordError && error.reason !== undefined ? { reason: error.reason } : {}),
		});
	return {
		init,
		lock: async () => {
			// 锁名由父进程通过环境变量传入；未配置时该平台/场景不需要单实例锁，直接完成。
			const name = process.env[LOCK_ENV];
			if (name === undefined) return;
			try {
				// 故意丢弃 processLock 返回的 release：锁必须持有到进程结束，由内核回收 socket 时释放。
				// 监听 server 本身也会保持事件循环活跃，因此子进程不会因为“无事可做”而自行退出。
				await processLock(name);
			} catch (error) {
				// 先报 fatal，让父进程的 start() 立即失败；再把错误抛给子进程入口，阻止它继续打开存储。
				fatal(error);
				throw error;
			}
		},
		ready: () => send({ type: "ready" }),
		fatal,
		// 展开 status 保留调用方给出的任意子集；管理器会把缺省字段当 0。
		report: (status) => send({ type: "status", ...status }),
		// 返回 Set.add 的返回值，但接口声明为 void；调用方不应依赖它。
		onShutdown: (handler) => shutdown.add(handler),
	};
}
