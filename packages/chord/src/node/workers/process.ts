// A worker process as the server sees it (slice 10 §3, Chord v1's `forkDriver`): forked with V8 serialization as a
// detached process group (the whole tree can be killed), stdout and stderr piped (the stderr tail kept, both mirrored to
// the server's own when the app takes no output), its IPC link made at the fork so the child's `hello` and early holds
// are queued, never lost; control messages, the link's close and the exit are told as they happen.

// 文件导读
// 所属模块：packages/chord/src/node/workers，服务器侧对子进程的封装。
// 解决的问题：worker 是独立进程，服务器需要可靠地 fork、收发 IPC、转发输出、杀整个进程树，并且能区分“自己关链接”
//   与“子进程关链接”。fork 时立即建立 link，避免子进程早期发送的 hello/hold 丢失。
// 职责边界：只负责进程与传输层；启动消息内容、重载、idle、重试策略都在 workers.ts。它不做授权，也不解释业务错误。
// 上游：workers.ts 的 #fork 创建 WorkerProcess，并把 ProcessEvents 接到自己的状态机。下游：node:child_process、
//   ipcLink。事件包括 control（FromWorker）、linkLost（本侧关闭）、linkClosed（子进程侧关闭）和 exited。
//   发送到已断开的子进程会被丢弃，由 exit/link 事件告知调用方；退出时先杀整个进程组再 resolve exited。
// 能力清单：
// - ForkOptions：entry、execArgv、env、onOutput。
// - Exit：退出码和信号。
// - ProcessEvents：control/linkLost/linkClosed/exited 四个回调。
// - WorkerProcess：pid、startedAt、link、exited Promise、stderrTail、send()、kill()。
// - TellingLink：包装 ipcLink，记录关闭方向，保证 onClose 监听者仍能收到通知。
// 组合关系：new WorkerProcess -> fork -> TellingLink(ipcLink) + child message 监听 -> 事件回调到 workers.ts；
//   workers.ts #shutdown 发 shutdown，超时后 kill；exit 时 #killGroup 清理子进程树。
// 示例（示例，不是本文件的运行代码）：
//   const child = new WorkerProcess({ entry: "/app/worker.js" }, {
//     control: (message) => console.log(message.kind),
//     linkLost: () => {}, linkClosed: () => {}, exited: ({ code }) => console.log(code),
//   });
//   child.send({ kind: "shutdown" });
// 建议阅读顺序：先看 ForkOptions/Exit/ProcessEvents，再看 WorkerProcess 构造器中的 fork 与事件接线，
//   随后看 send/kill/#killGroup，最后看 TellingLink 如何区分两侧关闭。

import { type ChildProcess, fork } from "node:child_process";
import type { Link } from "../../link/index.ts";
import { ipcLink } from "../../link/index.ts";
import { controlOf, envelope, type FromWorker, type ToWorker } from "./control.ts";

/** How a worker process is started: the bootstrap options of the workers component. */
// entry 是子进程模块（必须调用 workerMain）；execArgv 是 Node 参数；env 叠加在服务器环境之上。
// onOutput 存在时由应用接收输出；否则镜像到本进程对应的 stdout/stderr。
export type ForkOptions = {
	readonly entry: string;
	readonly execArgv?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	/** Its output; without it, mirrored to this process's own. */
	readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
};

/** How a worker process ended. */
// code 为数字或 null；signal 为 Node 的信号名或 null。二者至少一个非 null（正常退出/被信号终止）。
export type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** What a worker process tells as it happens. */
// 四个事件各司其职：control 是应用层控制消息；linkLost 是本侧主动关闭；linkClosed 是子进程侧关闭；
// exited 是进程真正结束。linkLost 与 linkClosed 可能发生在进程仍存活时，调用方需分别处理。
export type ProcessEvents = {
	readonly control: (message: FromWorker) => void;
	/** Its link was closed by this side (the heartbeat, a protocol error) while the child may live. */
	readonly linkLost: () => void;
	/** Its link was closed by the child's side (it exits, or it closed its IPC channel and may live on). */
	readonly linkClosed: () => void;
	readonly exited: (exit: Exit) => void;
};

/** How much of a worker's stderr is kept for its failure: 4 KiB. */
// 只保留末尾 4 KiB：失败诊断通常靠近最后输出，同时限制内存；完整输出由 onOutput/镜像负责。
const STDERR_TAIL = 4096;

/** A control message to a child that is gone: dropped (its exit or link close tells). */
// child.send 的回调必须存在以接收异步错误；这里刻意吞掉，因为进程退出/link 关闭事件才是权威通知。
const ignoreSendError = (): void => {};

/** One forked worker process. */
// 对外暴露 pid、启动时间、link、exited Promise 和 stderrTail；内部持有 ChildProcess 与 stderr 累积。
export class WorkerProcess {
	readonly pid: number;
	readonly startedAt = Date.now();
	/** The link to the child's host, made at the fork. */
	readonly link: Link;
	/** Resolves with its exit; every process it spawned is killed then. */
	readonly exited: Promise<Exit>;
	readonly #child: ChildProcess;
	#stderr = "";

	// 用途：启动子进程并接线所有事件。输入 fork 选项和事件回调，构造后进程已在运行。
	// 关键点：detached 让子进程成为新进程组组长，之后可用负 pid 杀整棵树；advanced 序列化支持 Uint8Array 等值。
	constructor(options: ForkOptions, events: ProcessEvents) {
		const child = fork(options.entry, [], {
			// env 以服务器环境为底，应用提供的键覆盖同名项。
			env: { ...process.env, ...options.env },
			// 复制数组，避免调用方之后修改 execArgv 影响已启动进程。
			execArgv: [...(options.execArgv ?? [])],
			// 新进程组：崩溃清理时连同孙进程一起杀，避免孤儿进程。
			detached: true,
			serialization: "advanced",
			// stdin 关闭；stdout/stderr 走管道；第四个槽是 IPC 通道。
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		this.#child = child;
		// fork 失败时 pid 可能为 undefined；用 -1 表示无效，killGroup 会因此返回 false。
		this.pid = child.pid ?? -1;
		for (const stream of ["stdout", "stderr"] as const) {
			child[stream]?.on("data", (chunk: Buffer) => {
				// 只保留 stderr 的末尾窗口；字符串拼接后截断，避免无限增长。
				if (stream === "stderr") this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
				// 应用接管输出时不再镜像，避免重复打印。
				if (options.onOutput !== undefined) options.onOutput(stream, chunk);
				else process[stream].write(chunk);
			});
		}
		// 在 fork 后立即建立 link，子进程早期发送的帧会排在 IPC 队列中，不会因服务器尚未监听而丢失。
		this.link = new TellingLink(ipcLink(child), events);
		child.on("message", (message: unknown) => {
			// 同一条 IPC 通道上还有 link 帧；只有带控制信封的消息才交给 control。
			const control = controlOf<FromWorker>(message);
			if (control !== undefined) events.control(control);
		});
		this.exited = new Promise<Exit>((resolve) => {
			const ended = (exit: Exit): void => {
				// However the leader ended, nothing it spawned outlives it.
				// 先杀进程组再 resolve/发事件：调用方看到 exited 时，子进程树已经清理完毕。
				this.#killGroup();
				resolve(exit);
				events.exited(exit);
			};
			child.once("exit", (code, signal) => ended({ code, signal }));
			// A fork that failed (no `exit` follows).
			// 只有 fork 本身失败（pid 未产生）才用 error 补一个假退出；运行中的子进程错误仍由 exit 处理。
			child.once("error", () => {
				if (child.pid === undefined) ended({ code: null, signal: null });
			});
		});
	}

	/** The last bytes it wrote to stderr, if any. */
	// 无输出时返回 undefined 而不是空串，便于调用方用展开语法决定是否附带 stderrTail。
	get stderrTail(): string | undefined {
		return this.#stderr === "" ? undefined : this.#stderr;
	}

	/** Sends a control message; dropped when the child is gone (its exit tells). */
	// 只在 IPC 仍连接时发送；发送失败由 ignoreSendError 吞掉，状态由 exit/link 事件决定。
	send(message: ToWorker): void {
		if (this.#child.connected) this.#child.send(envelope(message), ignoreSendError);
	}

	/** Kills the child and every process it spawned. */
	// 优先杀整个进程组；没有进程组（fork 失败或平台不支持）时退化为杀单个子进程。
	kill(): void {
		if (!this.#killGroup()) this.#child.kill("SIGKILL");
	}

	/** Kills the process group; `false` when there is none. */
	#killGroup(): boolean {
		try {
			// 负 pid 表示向整个进程组发送信号；detached 保证了子进程是该组组长。
			process.kill(-this.pid, "SIGKILL");
			return true;
		} catch {
			// 进程/进程组已不存在，或 pid 为 -1；让调用方决定是否退化为单进程 kill。
			return false;
		}
	}
}

/** A link that also tells who closed it (`linkLost`: this side, `linkClosed`: the child's), whoever listens to it. */
// 目的：ipcLink 的 close 事件不说明方向；WorkerProcess 需要区分“服务器主动关”与“子进程关”，以便决定是否记为崩溃。
// 实现：包装 inner.onClose；本侧 close() 先置 #closed 再触发 linkLost，之后 inner 的 close 回调看到 #closed 为 true，
// 不再触发 linkClosed。子进程侧关闭时 #closed 仍为 false，于是触发 linkClosed。
class TellingLink implements Link {
	readonly #inner: Link;
	readonly #events: Pick<ProcessEvents, "linkLost" | "linkClosed">;
	#listener: (() => void) | undefined;
	#closed = false;

	constructor(inner: Link, events: Pick<ProcessEvents, "linkLost" | "linkClosed">) {
		this.#inner = inner;
		this.#events = events;
		inner.onClose(() => {
			const here = this.#closed;
			this.#closed = true;
			// 应用通过 onClose 注册的监听者只保留一个；先通知它，再根据关闭方向发出对应事件。
			this.#listener?.();
			if (!here) events.linkClosed();
		});
	}

	send(message: Uint8Array): void {
		this.#inner.send(message);
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		this.#inner.onMessage(listener);
	}

	close(): void {
		// 幂等：重复 close 不再触发事件或转发，避免重复的 linkLost 和状态变化。
		if (this.#closed) return;
		this.#closed = true;
		this.#events.linkLost();
		this.#inner.close();
	}

	onClose(listener: () => void): void {
		// 已关闭时同步回调，保证晚注册的监听者也能观察到关闭；否则留待 inner 关闭时调用。
		if (this.#closed) listener();
		else this.#listener = listener;
	}
}
