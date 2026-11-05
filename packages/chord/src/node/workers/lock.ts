// Process locks (slice 10 §3, Chord v1's `processLock`): one live worker per address. A lock is a listening socket the
// kernel owns for the holder's lifetime (an abstract socket on Linux and Android, a named pipe on Windows, a socket file
// elsewhere), so there is no race between two would-be holders; a socket file a crashed holder left fails closed (the
// error names it: a takeover would race another taker). A child finding the lock held waits
// without polling: it connects to the holder's socket, which the holder never answers, and tries again when that
// connection closes (the holder exited).

// 文件导读
// 所属模块：packages/chord/src/node/workers，跨进程的“每地址一个 worker”锁。
// 解决的问题：同一地址可能被两个服务器/启动者同时拉起 worker；用文件标记会有检查与创建之间的竞态。
//   这里让内核持有监听套接字：只有成功 listen 的进程才是持有者，进程退出内核自动释放。
// 职责边界：只负责获取和释放锁；不 fork、不杀进程、不判断地址是否该启动。Linux/Android 用抽象命名空间套接字，
//   Windows 用命名管道，其他平台用临时目录下的 socket 文件。
// 上游：workers.ts 的 #start 把锁名随 start 消息交给子进程；main.ts 的 #run 在子进程侧调用本模块取锁。
//   下游：Node 的 net、fs、crypto。成功时返回 ProcessLock；被占用时持续等待，context 中止则以其 reason 拒绝；
//   监听失败（非 EADDRINUSE）直接抛出；残留的 socket 文件报错并提示清理，不会冒险接管。
// 能力清单：
// - ProcessLock：已持有的锁，release() 释放（进程退出也会释放）。
// - LockAddress：锁的位置，kind 为 abstract/pipe/file。
// - processLock()：按平台选择地址并取锁。
// - lockAt()：在给定地址取锁，包含等待循环、释放与 socket 文件清理。
// - listened()：尝试监听，区分“成功”和“被占用”。
// - waitWhileHeld()：连接持有者并等待其连接断开，或识别无人接听的残留文件。
// - MAX_SOCKET_PATH_BYTES、socketPath()：保证 Unix socket 路径不超过 sun_path 限制。
// 组合关系：processLock -> 平台分支 -> lockAt -> 循环 listened/waitWhileHeld -> 返回 release 闭包。
// 示例（示例，不是本文件的运行代码）：
//   const lock = await processLock("notes|S1", context);
//   try { /* 运行该地址的 worker */ } finally { await lock.release(); }
// 建议阅读顺序：先看 ProcessLock/LockAddress，再看 processLock 的平台映射，随后看 lockAt 的等待循环和 release，
//   最后看 listened/waitWhileHeld/socketPath 的边界处理。

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../../context/index.ts";

/** A held lock: `release` frees it (the process's exit does too). */
// release 是异步的：等待 server.close 完成并断开所有等待者，确保下一个持有者能立即监听。
export type ProcessLock = { release(): Promise<void> };

/** Where a lock lives: an abstract socket (Linux, Android), a named pipe (Windows) or a socket file (elsewhere). */
// kind 决定“地址”是内核命名空间名、命名管道路径还是文件系统路径；file 额外需要退出时 unlink。
export type LockAddress = { readonly kind: "abstract" | "pipe" | "file"; readonly address: string };

/**
 * Takes the lock `name`, waiting while another process holds it (until `context` aborts: rejects with its reason).
 * Throws what listening throws besides "in use", and for a stale socket file (macOS, the BSDs) an error naming it.
 */
// 用途：按平台取锁。输入锁名和 context，输出 ProcessLock；被占用时等待，中止时拒绝。
// sha256 截断到 32 个十六进制字符：不同地址名映射到短且稳定的 key，同时避免路径/管道名过长。
// Windows 命名管道、Linux/Android 抽象套接字都不落在文件系统；macOS/BSD 才需要 socket 文件和路径长度处理。
export async function processLock(name: string, context: Context): Promise<ProcessLock> {
	const key = createHash("sha256").update(name).digest("hex").slice(0, 32);
	if (process.platform === "win32")
		return lockAt({ kind: "pipe", address: `\\\\.\\pipe\\chord-lock-${key}` }, context);
	if (process.platform === "linux" || process.platform === "android") {
		// 抽象套接字以 NUL 开头：不在文件系统留下节点，内核在最后一个引用关闭时释放。
		return lockAt({ kind: "abstract", address: `\0chord-lock-${key}` }, context);
	}
	return lockAt({ kind: "file", address: await socketPath(`chord-lock-${key}.sock`) }, context);
}

/**
 * Takes the lock at `lock`, waiting while it is held. A socket file nobody accepts on (a crashed holder's) fails closed:
 * taking it over races another taker (two could both unlink and listen), so the error names the file to remove.
 */
// 用途：在指定地址取锁。输入地址和 context，输出 ProcessLock；被占用时无轮询地等待。
// 关键设计：等待者与持有者建立套接字连接，持有者从不回应；连接断开就代表持有者退出，等待者再试 listen。
// 对 file 锁，如果连接被拒绝（ECONNREFUSED）说明文件残留但无人持有；此时不接管，直接报错要求人工删除。
export async function lockAt(lock: LockAddress, context: Context): Promise<ProcessLock> {
	const { address } = lock;
	const file = lock.kind === "file";
	// Connections are kept open, never answered: a waiter learns of the release when its connection closes.
	// waiters 保存所有等待者的 socket；release 时主动 destroy，使 close 回调能尽快完成。
	const waiters = new Set<Socket>();
	const server = createServer((socket) => {
		waiters.add(socket);
		// 等待者断开是正常流程，吞掉 error 防止未处理的 socket 错误导致进程崩溃。
		socket.on("error", () => {});
		socket.once("close", () => waiters.delete(socket));
	});
	for (;;) {
		// 每轮循环都检查中止：等待前和监听前都可能已被取消。
		context.abortSignal?.throwIfAborted();
		// 尝试监听成功即拿到锁；EADDRINUSE 由 listened 转成 false，进入等待。
		if (await listened(server, address)) break;
		const held = await waitWhileHeld(address, context);
		// 只有 file 锁会出现“有文件但没人监听”；返回 false 表示连接被拒绝，不能安全接管。
		if (!held && file) {
			throw new Error(`lock: ${address} is a stale lock file (no process holds it); remove it if no worker runs`);
		}
	}
	const removeFile = (): void => {
		try {
			unlinkSync(address);
		} catch {
			// Gone already.
			// 文件可能已被其他清理动作删除；退出路径上不需要因此失败。
		}
	};
	// 进程退出时删除 socket 文件；抽象套接字和命名管道不需要这一步。
	if (file) process.once("exit", removeFile);
	return {
		release: () =>
			new Promise<void>((resolve, reject) => {
				// 先移除退出监听，避免正常释放后退出时再次 unlink。
				if (file) process.removeListener("exit", removeFile);
				// close 会等待现有连接；随后 destroy 等待者，让它们感知到释放并重试监听。
				server.close((error) => (error ? reject(error) : resolve()));
				// Waiters see their connections close (and `close` waits for them).
				for (const socket of waiters) socket.destroy();
			}),
	};
}

/** Whether `server` now listens on `address`; `false` when it is in use. */
// 用途：尝试监听一次。输入 server 和地址，输出 true（已监听）或 false（被占用）；其他监听错误原样拒绝。
// 关键点：只把 EADDRINUSE 当作“被占用”，权限、路径不存在等错误必须让调用方看到，不能被当成等待。
function listened(server: Server, address: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const failed = (error: NodeJS.ErrnoException): void => {
			if (error.code === "EADDRINUSE") resolve(false);
			else reject(error);
		};
		server.once("error", failed);
		server.listen(address, () => {
			// 监听成功后移除一次性 error 监听，避免后续连接错误误触这里的判断。
			server.removeListener("error", failed);
			resolve(true);
		});
	});
}

/**
 * Connects to the holder of `address` and resolves when that connection closes or the address is gone (`true`: try
 * again), or with `false` when nobody accepts on it (a leftover socket file); `context`'s abort rejects.
 */
// 用途：等待持有者释放。输入地址和 context，输出 true（持有者退出，可重试）或 false（残留文件，无人接听）。
// 流程：连接 -> 连接成功则等 close（持有者退出）-> 若在连接成功前收到 ECONNREFUSED，说明没人监听（残留文件）。
// 中止时销毁连接并以 signal.reason 拒绝；无论哪种方式都移除 abort 监听，避免泄漏。
function waitWhileHeld(address: string, context: Context): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const signal = context.abortSignal;
		// 已中止的 context 不必发起连接，直接拒绝。
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const socket = connect(address);
		const abort = (): void => {
			socket.destroy();
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const settle = (held: boolean): void => {
			// 成功/失败路径统一清理监听，防止后续 abort 再次 settle。
			signal?.removeEventListener("abort", abort);
			resolve(held);
		};
		let connected = false;
		socket.once("connect", () => {
			connected = true;
		});
		// 捕获错误而不是抛出：等待期间持有者退出或地址残留都表现为 socket 事件。
		socket.on("error", (error: NodeJS.ErrnoException) => {
			// 只有“从未连接成功 + ECONNREFUSED”才是残留文件；连接后断开的错误交给 close 处理。
			if (!connected && error.code === "ECONNREFUSED") settle(false);
		});
		// 连接关闭意味着持有者已退出（或锁已释放），调用方应重新尝试监听。
		socket.once("close", () => settle(true));
	});
}

/** sun_path holds 104 bytes on macOS and the BSDs, the terminating NUL included. */
// 最长可用路径是 103 字节；超过后 listen 会失败（ENAMETOOLONG），因此需要换到更短的目录。
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * A lock socket's path: in the temporary directory, or, when that does not fit in sun_path (a deep TMPDIR), in a
 * private per-user directory under /tmp that only its owner can reach.
 */
// 用途：为 socket 文件选择合法路径。输入文件名，输出绝对路径；可能创建私有目录。
// 优先使用 tmpdir()；若字节数超过 sun_path 上限，退到 /tmp/chord-lock-<uid>。
// 安全检查：目录必须是真正的目录、属于当前用户、权限不含 group/other 位，否则报错，避免他人抢占或篡改。
// 注意：这里故意不用环境变量控制的临时目录作为回退，因为其长度不可控。
async function socketPath(file: string): Promise<string> {
	const preferred = join(tmpdir(), file);
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	// getuid 在 Windows 不存在，但本函数只在类 Unix 的 file 分支调用；兜底为 0 仅为类型/运行时完整。
	const uid = process.getuid?.() ?? 0;
	const directory = `/tmp/chord-lock-${uid}`;
	await mkdir(directory, { mode: 0o700, recursive: true });
	const stats = await lstat(directory);
	// lstat 而不是 stat：拒绝符号链接伪装成目录；权限检查防止其他用户连接或删除锁 socket。
	if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
		throw new Error(`lock directory ${directory} must be a directory only its owner can access`);
	}
	return join(directory, file);
}
