// The terminal's sandbox (slice 11 §4, decision "Slice 11, P8"; fix round 2: a child process, as the owner decided
// after the worker thread was escaped through its shared realm): a Node child process of the launcher's binary.
// - The operating system's side: its stdin, stdout and stderr are pipes to the launcher (never the terminal: no
//   descriptor of the child is a TTY), its environment empty, its directory a private one holding only the bootstrap;
//   Node's permission model with nothing allowed but reading the bootstrap (no other file read, no write, no network,
//   no child processes, no workers, no addons, no inspector, no WASI) and `node:sqlite` removed
//   (`--no-experimental-sqlite`: SQLite opens files past the permission model). An escape from the JavaScript layer
//   reaches no terminal, no file, no socket, no launcher memory or token.
// - The JavaScript side, a second layer: downloaded code (the base bundle, a CommonJS script; the plugins' registered
//   scripts) is only evaluated by the bootstrap (`vm.Script` with no dynamic import callback, so `import()` throws),
//   with a `require` answering the allowed builtins only (`SANDBOX_BUILTINS`); `process` is a substitute with
//   `SANDBOX_PROCESS` only. The bootstrap keeps its own references to what it uses before any downloaded code runs.
// Messages go both ways as length-prefixed binary frames (`pipe.ts`). Known gaps, each needing the JavaScript layer
// broken first unless noted: the child may signal processes of the same user (Node has no permission for signals; the
// launcher ignores SIGUSR1, which would open its inspector), read machine details (`os`), learn whether any path exists
// (`require.resolve` fails one way for a file that exists, another for one that does not: Opus E13), and allocate
// memory outside its heap (no limit without a shell's `ulimit`; only the child dies). Needs Node 26.5.1 or later.
//
// 文件导读
// 所属：packages/chord 的 Node 终端启动器模块（node/tui），负责创建、通信和终止沙箱子进程。
// 职责边界：把下载来的终端代码放进一个受限 Node 子进程运行；本文件不决定是否运行、不持有 token，也不把输出写到终端。
// 上游是 launcher.ts 的 #startSandbox；下游是子进程本身及其内的 BOOTSTRAP 脚本。消息经 pipe.ts 编解码：
// onMessage 收到合法消息，onEnd 收到结束原因；资料错误/超限以拒绝或结束回调表达。
// 能力清单：
// - MAX_BUNDLE：base bundle 源码上限 8 MiB。
// - SANDBOX_BUILTINS：允许 require 的内置模块白名单。
// - SANDBOX_PROCESS：替代 process 对象允许的属性白名单。
// - sandboxFlags：生成权限模型、禁用 SQLite、限制堆大小的 Node 参数。
// - BOOTSTRAP_FILE：子进程主脚本文件名。
// - MAX_UNREAD：等待子进程读取的字节上限（64 MiB）。
// - requireSandboxNode：Node 26.5.1+ 版本门槛。
// - sandboxEnvironment：清空环境变量，仅保留 LD_LIBRARY_PATH。
// - Sandbox：运行句柄，提供静态 start、post、terminate，以及私有写帧/读帧/失败/结束逻辑。
// - BOOTSTRAP：受信任的 CommonJS 引导脚本全文（模板字符串），实现 JS 层防护。
// 两层防护：操作系统层（权限模型、无 TTY、空环境、私有目录、堆上限）与 JS 层（vm.Script、require 白名单、
// fake process、提前保存内置引用）。即使逃出 JS 层，也摸不到终端、文件、网络或启动器 token。
// 组合与顺序：Sandbox.start → mkdtemp/writeFile → spawn → startFrame 写入 stdin；子进程 stdout → FrameReader →
// onMessage；终止时 kill SIGKILL → 等待 close → 删除临时目录。
// 示例：`const sandbox = await Sandbox.start(source, start, onMessage, onEnd); sandbox.post({ kind: "input", data });`
// 阅读顺序：先看常量和 requireSandboxNode/sandboxEnvironment，再读 Sandbox 的 start/构造函数/消息方法，
// 最后读 BOOTSTRAP 前的结构导读（其内部代码按该导读顺序阅读）。已知缺口见英文头注释。

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeStart, LauncherMessage, SandboxMessage } from "../../tui/bridge.ts";
import { FrameReader, launcherFrame, MAX_PIPE_FRAME, startFrame } from "./pipe.ts";

/** The largest base bundle a sandbox runs: 8 MiB. */
// 单个 base bundle 源码上限 8 MiB；超过在 Sandbox.start 中直接拒绝，避免把巨大脚本文本送进子进程。
export const MAX_BUNDLE = 8 * 1024 * 1024;

/**
 * The builtins code in the sandbox may `require`, each computation in memory without I/O, descriptors or machine
 * details: bytes and text (`buffer`, `string_decoder`, `punycode`, `querystring`), events and streams in memory
 * (`events`, `stream` and its submodules), formatting and type checks (`util`, `util/types`), URL and path strings
 * (`url`, `path`), timers, assertions, hashing and randomness (`crypto`: no keys from files, no network) and compression
 * in memory (`zlib`). Not `fs`, `tty`, `net`, `dgram`, `dns`, `http`, `https`, `http2`, `tls`, `child_process`,
 * `cluster`, `worker_threads`, `sqlite`, `inspector`, `vm`, `v8`, `os`, `module`, `process`, `perf_hooks`, `wasi`,
 * `repl`, `readline`, `trace_events` or anything else.
 */
// 允许沙箱 require 的内置模块白名单。选择标准：计算只发生在内存中，不触碰文件描述符、网络或机器信息。
// readonly string[] 只禁止通过这个引用改写数组元素类型，运行时数组本身仍可被修改（bootstrap 会把它序列化进脚本）。
// 例如允许 crypto 做哈希/随机数，但明确不允许 fs、net、http、child_process、worker_threads、node:sqlite 等。
export const SANDBOX_BUILTINS: readonly string[] = [
	"assert",
	"assert/strict",
	"buffer",
	"crypto",
	"events",
	"path",
	"path/posix",
	"path/win32",
	"punycode",
	"querystring",
	"stream",
	"stream/consumers",
	"stream/promises",
	"stream/web",
	"string_decoder",
	"timers",
	"timers/promises",
	"url",
	"util",
	"util/types",
	"zlib",
];

/**
 * The sandbox's `process`: a frozen plain object in place of Node's (no event emitter, so no prototype shared with
 * Node's internals leads back to the real one). Its properties, each harmless: which Node it is (`arch`, `platform`,
 * `version`, `versions`, `release`), time (`nextTick`, `hrtime`, `uptime`), ending the sandbox (`exit`), the permission
 * checks (`permission`), the allowed builtins (`getBuiltinModule`), fixed values (`env` empty, `argv`, `argv0`,
 * `execArgv`, `execPath`, `title`, `cwd` `/`), `stdout` (to the terminal through the bridge) and `stderr` (dropped),
 * and listener calls that keep nothing (`on`, `once`, `off`, `addListener`, `removeListener`, `removeAllListeners`,
 * `emit`, `emitWarning`, `listenerCount`, `listeners`). Not `binding`, `_linkedBinding`, `dlopen`, `_rawDebug`, `kill`,
 * `execve`, `chdir`, `abort`, `reallyExit`, `stdin`, `openStdin`, `report`, `pid`, `ppid`, `config`, the user and group
 * calls, `loadEnvFile`, `moduleLoadList`, resource and handle listings or any other.
 */
// 替代 process 对象允许暴露的属性名白名单。每一项都只提供信息或无害操作：
// 版本/平台/架构、时间、退出、权限查询、允许的内置模块、空 env、固定 argv/cwd、stdout/stderr，以及不保留监听器的 on/once 等。
// 不包含 kill、execve、chdir、pid、binding、dlopen 等可影响外部世界的成员。
// 运行时真正构造 fake 对象的代码在下方 BOOTSTRAP 模板里；这个数组同时用于文档与测试核对。
export const SANDBOX_PROCESS: readonly string[] = [
	"addListener",
	"arch",
	"argv",
	"argv0",
	"cwd",
	"emit",
	"emitWarning",
	"env",
	"execArgv",
	"execPath",
	"exit",
	"getBuiltinModule",
	"hrtime",
	"listenerCount",
	"listeners",
	"nextTick",
	"off",
	"on",
	"once",
	"permission",
	"platform",
	"release",
	"removeAllListeners",
	"removeListener",
	"stderr",
	"stdout",
	"title",
	"uptime",
	"version",
	"versions",
];

/**
 * The child's Node flags for its script `script`: the permission model allowing only reading that file, no SQLite, a
 * 96 MiB heap. Exported for the tests of the operating system's layer alone.
 */
// 构造子进程的 Node 命令行参数（不含可执行文件路径）。元组的含义：
// --permission 开启权限模型；--allow-fs-read 只允许读 bootstrap 脚本；--no-experimental-sqlite 移除 SQLite
// （SQLite 可绕过权限模型打开文件）；--max-old-space-size=96 限制老生代堆为 96 MiB；最后是脚本路径本身。
// 返回 string[]，交给 spawn 作为参数数组，不经过 shell。
// 例子：sandboxFlags("/tmp/x/bootstrap.cjs") 返回 [...标志, "/tmp/x/bootstrap.cjs"]。
export function sandboxFlags(script: string): string[] {
	return ["--permission", `--allow-fs-read=${script}`, "--no-experimental-sqlite", "--max-old-space-size=96", script];
}

/** The bootstrap's file in the sandbox's directory: a script, not `-e`, which puts every builtin on `globalThis`. */
// bootstrap 文件名。用脚本文件而不是 `node -e`，因为 -e 的求值环境会让所有内置模块出现在 globalThis 上，
// 扩大下载代码可直接访问的能力面。
export const BOOTSTRAP_FILE = "bootstrap.cjs";

/** The most bytes waiting for the sandbox to read them before it counts as stuck: 64 MiB. */
// 等待子进程读取的字节上限 64 MiB。写入量超过“未读上限 + 单帧上限”时认为沙箱卡死/不读，直接结束它。
const MAX_UNREAD = 64 * 1024 * 1024;

/** Throws unless this Node is 26.5.1 or later, the Node the sandbox's permissions were checked on. */
// 版本门槛检查：权限模型行为是逐版本验证过的，低于 26.5.1 一律拒绝启动，避免不安全的降级运行。
// 输入 version 默认取当前 Node 版本，可注入以便测试；输出无，不符合则抛 Error。
// 解析：按 "." 分割并转数字，解构带默认值 0（例如 "26.5" 时 patch=0）。
// 比较逻辑等价于 (major, minor, patch) >= (26, 5, 1)，但避免了数组比较。
export function requireSandboxNode(version: string = process.versions.node): void {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	if (major > 26 || (major === 26 && (minor > 5 || (minor === 5 && patch >= 1)))) return;
	throw new Error(`the terminal client needs Node 26.5.1 or later for its sandbox (this is Node ${version})`);
}

/**
 * The child's environment: empty, but for `LD_LIBRARY_PATH` when the launcher has one: the launcher needed it to run
 * this same binary (a Node built against libraries outside the system's paths), and the server cannot influence it.
 */
// 构造子进程环境变量：默认完全清空，防止把 token、代理、调试开关等泄露给下载代码。
// 唯一例外是 LD_LIBRARY_PATH：启动器自己运行同一个 Node 二进制时就需要它，否则子进程可能找不到动态库。
// 返回值是普通对象；undefined 表示未设置，此时返回空对象。
export function sandboxEnvironment(): Record<string, string> {
	const libraries = process.env.LD_LIBRARY_PATH;
	return libraries === undefined ? {} : { LD_LIBRARY_PATH: libraries };
}

/** A running sandbox: messages both ways, and its end. */
// 单个沙箱子进程的句柄。应用不直接创建它，只通过静态 start；构造器私有，保证初始化顺序固定。
// 生命周期：start → 双向消息 → close/terminate；onEnd 恰好调用一次（#ended 保护）。
// 私有字段持有子进程、临时目录、回调、拆帧器和退出 Promise，以及“是否已结束/是否已开始运行”的标志。
export class Sandbox {
	// stdin/stdout/stderr 都非 null 的 ChildProcess 类型，便于直接使用流。
	readonly #child: ChildProcessWithoutNullStreams;
	// 存放 bootstrap 的临时目录；close 后递归删除。
	readonly #directory: string;
	// 每收到一条完整消息调用一次；#end 时调用 onEnd。
	readonly #onMessage: (message: SandboxMessage) => void;
	readonly #onEnd: (reason: string) => void;
	// 增量拆帧器，跨 data 块保存未完成字节。
	readonly #reader = new FrameReader();
	// 子进程 close 事件对应的 Promise；terminate 等待它。
	readonly #exited: Promise<void>;
	// 是否已结束：停止再向 stdin 写、停止分发消息、保证 onEnd 一次。
	#ended = false;
	/** Whether the child has sent anything: its bootstrap was read, so the file goes. */
	// 子进程是否已经产出过数据。首次收到数据说明 bootstrap 已被 Node 读取，可以删除磁盘上的脚本文件。
	#running = false;

	/**
	 * Starts a sandbox running the base bundle `source` (a CommonJS script) with `start` on its bridge; `onMessage` gets
	 * what it sends, `onEnd` its end (an exit, a crash, its memory limit, a malformed frame), once.
	 */
	// 启动沙箱的静态工厂：检查版本与源码大小，建立临时目录写入 bootstrap，启动子进程，再发送 start 帧。
	// 输入：source（CommonJS 源码）、start（bridge 初始描述）、消息回调、结束回调。
	// 输出：已启动的 Sandbox。副作用：创建临时目录/文件、spawn 子进程、写 stdin。
	// 错误：版本不足、源码超限、mkdir/writeFile/spawn 失败都会拒绝；此时调用方应结束客户端。
	// 例子：source 为 bundle 文本，start 含 base 哈希与列数；返回后子进程已开始读取 stdin 的 start 帧。
	static async start(
		source: string,
		start: BridgeStart,
		onMessage: (message: SandboxMessage) => void,
		onEnd: (reason: string) => void,
	): Promise<Sandbox> {
		requireSandboxNode();
		// 按 UTF-8 字节数而不是字符数限制；中文等多字节字符会占更多字节。
		if (Buffer.byteLength(source) > MAX_BUNDLE) throw new Error("terminal: the base bundle exceeds 8 MiB");
		// mkdtemp 生成唯一目录名（前缀 chord-tui-），避免并发实例互相覆盖。
		const directory = await mkdtemp(join(tmpdir(), "chord-tui-"));
		// 写入 bootstrap 脚本；权限模型将只允许读这个文件。
		await writeFile(join(directory, BOOTSTRAP_FILE), BOOTSTRAP);
		// 构造器内部 spawn；如果 spawn 同步抛错，临时目录会遗留（由操作系统清理）。
		const sandbox = new Sandbox(directory, onMessage, onEnd);
		// 第一帧必须是 start，bootstrap 据此执行 base bundle；source 放在 body 中。
		sandbox.#write(startFrame(start, source));
		return sandbox;
	}

	// 私有构造器：只允许 start 调用，确保 spawn 参数、流监听和退出 Promise 一起建立。
	// stdio 全为 pipe：子进程拿不到父进程的终端；env 已清空；cwd 是临时目录；windowsHide 隐藏控制台窗口。
	private constructor(
		directory: string,
		onMessage: (message: SandboxMessage) => void,
		onEnd: (reason: string) => void,
	) {
		this.#directory = directory;
		this.#onMessage = onMessage;
		this.#onEnd = onEnd;
		// process.execPath 是当前 Node 可执行文件；参数由 sandboxFlags 生成，不经过 shell。
		this.#child = spawn(process.execPath, sandboxFlags(join(directory, BOOTSTRAP_FILE)), {
			stdio: ["pipe", "pipe", "pipe"],
			env: sandboxEnvironment(),
			cwd: directory,
			windowsHide: true,
		});
		// 只监听一次 close，resolve 退出 Promise；close 在流关闭后触发，比 exit 更适合等待资源释放。
		this.#exited = new Promise((resolve) => this.#child.once("close", () => resolve()));
		// stdout 的每个 data 块交给增量拆帧器。
		this.#child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
		// Dropped: the sandbox writes only through the bridge, and the terminal is the launcher's.
		// resume() 持续消费 stderr，防止管道填满导致子进程阻塞；内容直接丢弃。
		this.#child.stderr.resume();
		// A write after the child ended fails here; its end is reported by `close`.
		// 监听 stdin 的 error 并吞掉 EPIPE，避免未处理的 'error' 事件让启动器崩溃。
		this.#child.stdin.on("error", () => {});
		// 进程级错误（如 spawn 失败、kill 失败）转为结束；close 随后也会尝试结束，但 #end 幂等。
		this.#child.on("error", (error) => this.#end(`the terminal client failed: ${error.message}`));
		this.#child.on("close", () => {
			this.#end("the terminal client exited");
			// 递归删除临时目录；force 忽略不存在，避免清理错误成为未处理拒绝。
			void rm(this.#directory, { recursive: true, force: true });
		});
	}

	/** Sends `message` to the sandbox; a sandbox not reading what it was sent is ended. */
	// 向沙箱发送一条启动器消息；已结束则静默丢弃。编码为帧后交给 #write。
	// 无返回值；编码失败（例如字符串过大）会在 launcherFrame 中抛错，由调用方（launcher）的 try 处理。
	post(message: LauncherMessage): void {
		if (!this.#ended) this.#write(launcherFrame(message));
	}

	/** Ends the sandbox and waits for its exit. */
	// 强制结束沙箱：先置 #ended 阻止后续写入/分发，再 SIGKILL，等待 close。
	// 使用 SIGKILL 而非 SIGTERM：下载代码可能忽略优雅信号；这里不需要它做清理，临时目录由父进程负责。
	async terminate(): Promise<void> {
		this.#ended = true;
		this.#child.kill("SIGKILL");
		await this.#exited;
	}

	// 底层写帧：先检查子进程 stdin 的待写字节，若超过“未读上限 + 单帧上限”，认定沙箱不再读取并结束它，
	// 防止父进程内存被无限缓冲。否则直接 write（Node 内部会排队）。
	#write(frame: Buffer): void {
		if (this.#child.stdin.writableLength + frame.length > MAX_UNREAD + MAX_PIPE_FRAME) {
			this.#fail("the terminal client stopped reading");
			return;
		}
		this.#child.stdin.write(frame);
	}

	/** The sandbox's output: its messages, each passed on; a malformed one ends the sandbox. */
	// 处理子进程 stdout 的一块数据：首次收到时删除磁盘上的 bootstrap（Node 已读取），然后增量拆帧并分发。
	// 错误：拆帧失败（超限/畸形）时以该错误信息结束沙箱，不把异常抛给事件循环。
	// 注意分发循环中每条消息前都重新检查 #ended：前一条消息的处理可能已触发结束。
	#read(chunk: Buffer): void {
		if (this.#ended) return;
		if (!this.#running) {
			this.#running = true;
			// Read once at the start; a launcher killed later leaves at most an empty directory.
			// 删除失败也无妨（force 忽略不存在）；rm 返回 Promise，用 void 表示不等待。
			void rm(join(this.#directory, BOOTSTRAP_FILE), { force: true });
		}
		let messages: SandboxMessage[];
		try {
			messages = this.#reader.push(chunk);
		} catch (error) {
			// 这里是运行时错误，类型是 unknown；断言为 Error 以读取 message（FrameReader 只抛 Error）。
			this.#fail((error as Error).message);
			return;
		}
		for (const message of messages) if (!this.#ended) this.#onMessage(message);
	}

	// 内部失败路径：终止子进程并上报原因；#end 保证回调只执行一次。
	#fail(reason: string): void {
		this.#child.kill("SIGKILL");
		this.#end(reason);
	}

	// 统一结束入口：幂等置位后调用 onEnd。不会等待子进程退出（那是 terminate 的职责）。
	#end(reason: string): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#onEnd(reason);
	}
}

/**
 * The trusted bootstrap (strict CommonJS, the child's main script). Before any downloaded code runs it keeps its own
 * references to what it uses (so code that changes shared prototypes later cannot steer it), closes the file system's
 * functions, shadows the real `process`'s listener calls, puts the substitute `process` in place, removes the module
 * globals and leaves the bridge on `globalThis`; then it waits for the launcher's start frame and evaluates the base
 * bundle through its own `require`. Frames as in `pipe.ts`.
 */
// 以下是 bootstrap 的完整源码模板（嵌在反引号里，因此内部不能插入注释）。按执行顺序说明：
// 1. 保存真实 process 及所需内置函数引用：getBuiltinModule、Reflect.apply、bind/call、JSON、Object.freeze、
//    Buffer 方法、vm.Script、nextTick/hrtime/uptime/exit、stdin/stdout 等。提前保存可防止下载代码之后篡改原型。
// 2. 关闭文件系统门面（node:fs 与 node:fs/promises 的所有函数替换为 deny）：权限模型管路径，但管道描述符仍需防；
//    同时禁用 v8 的快照/覆盖率/性能分析函数，并 syncBuiltinESMExports 让 ESM 侧也看到替换。
// 3. 把真实 process 的监听方法固定为 EventEmitter 原型上的函数；遍历其所有原型并将已有属性设为不可配置、
//    原型设为不可扩展，阻止下载代码通过原型链 getter 拿回真实 process。
// 4. 构造 allowed 白名单对象（无原型）与 builtin(id)：接受带或不带 "node:" 前缀，只返回白名单模块。
// 5. send(message)：把消息编码为与 pipe.ts 相同的帧写 stdout；write 文本与 socket 字节放 body，并在编码前检查 17 MiB。
// 6. 构造冻结的 fake process：固定版本/平台/空 env/cwd "/"、受控 stdout/stderr、转发时间与退出、listener 方法返回自身；
//    用 defineProperty 覆盖 globalThis.process，并删除 BroadcastChannel/localStorage/sessionStorage。
// 7. evaluate(text, filename)：用无原型的 options 构造 vm.Script，再 runInThisContext；不提供动态 import 回调，
//    因此下载代码里的 import() 会抛错。
// 8. 输入帧解析：首帧是 start（执行 base bundle），后续按 kind 还原 input 文本或 socket/attached 字节并交给监听器；
//    自己维护可增长的 pending 缓冲，长度超 MAX_FRAME 直接 exit(70)，stdin 结束则 exit(0)。
// 9. run(start, source)：创建冻结的 globalThis.chordBridge（start/send/onMessage/evaluate），再用
//    `(function (require, module, exports) { ... })` 包装源码执行，形成 CommonJS 环境；执行失败发送 failed 消息。
// 模板里的 ${MAX_PIPE_FRAME} 与 ${JSON.stringify(SANDBOX_BUILTINS)} 在父进程构造字符串时求值，其余 ${...} 属于脚本自身。
const BOOTSTRAP = `"use strict";
const real = process;
const getBuiltin = real.getBuiltinModule;
const apply = Reflect.apply;
const uncurry = Function.prototype.call.bind(Function.prototype.bind, Function.prototype.call);
const parse = JSON.parse;
const stringify = JSON.stringify;
const freeze = Object.freeze;
const define = Object.defineProperty;
const BufferFrom = Buffer.from;
const BufferAlloc = Buffer.allocUnsafe;
const BufferConcat = Buffer.concat;
const readUInt32BE = uncurry(Buffer.prototype.readUInt32BE);
const writeUInt32BE = uncurry(Buffer.prototype.writeUInt32BE);
const bufferText = uncurry(Buffer.prototype.toString);
const subarray = uncurry(Buffer.prototype.subarray);
const copyBytes = uncurry(Buffer.prototype.copy);
const isUint8Array = (value) => value instanceof Uint8Array;
const builtin0 = (id) => apply(getBuiltin, real, [id]);
const Script = builtin0("node:vm").Script;
const runInThisContext = uncurry(Script.prototype.runInThisContext);
const nextTick = real.nextTick;
const hrtime = real.hrtime;
const hrtimeBigint = real.hrtime.bigint;
const uptime = real.uptime;
const exit = real.exit;
const input = real.stdin;
const output = real.stdout;
const writeOutput = uncurry(output.write);
const onInput = uncurry(input.on);
const MAX_FRAME = ${MAX_PIPE_FRAME};
const deny = () => {
	throw new Error("unavailable in the terminal's sandbox");
};

// The file system's functions closed: the permission model guards paths, not the pipes' descriptors.
for (const facade of [builtin0("node:fs"), builtin0("node:fs/promises")]) {
	for (const name of Object.keys(facade)) {
		if (typeof facade[name] === "function") define(facade, name, { value: deny, writable: false, configurable: false, enumerable: true });
	}
}
const v8 = builtin0("node:v8");
for (const name of ["writeHeapSnapshot", "getHeapSnapshot", "queryObjects", "setFlagsFromString", "takeCoverage", "startCpuProfile", "startHeapProfile"]) {
	if (typeof v8[name] === "function") v8[name] = deny;
}
builtin0("node:module").syncBuiltinESMExports();
// Node emits on its own process (warnings among them): its listener calls are its own properties, not the shared
// prototype's, which downloaded code may change.
const emitter = builtin0("node:events").EventEmitter.prototype;
for (const name of Object.getOwnPropertyNames(emitter)) {
	if (name !== "constructor" && typeof emitter[name] === "function") define(real, name, { value: emitter[name], writable: false, configurable: false });
}
// Node reads properties its process does not have (noDeprecation, throwDeprecation, traceDeprecation,
// traceProcessWarnings, channel, connected, …): such a read goes up the prototype chain, where a getter would get the
// real process as its this (Opus E7: Buffer(1) warns, and the warning reads process.noDeprecation). Every prototype of
// the chain, Object.prototype included, takes no new property and keeps its own ones, so no getter and no other
// prototype gets in. Not frozen: Node assigns over prototype fields (\`this._events ??= {}\`).
for (let prototype = Object.getPrototypeOf(real); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
	for (const key of Reflect.ownKeys(prototype)) define(prototype, key, { configurable: false });
	Object.preventExtensions(prototype);
}

// The allowed builtins, by name with or without "node:"; looked up in an object of no prototype.
const allowed = Object.create(null);
for (const name of ${JSON.stringify(SANDBOX_BUILTINS)}) allowed[name] = true;
const builtin = (id) => {
	if (typeof id !== "string") throw new Error("unavailable in the terminal's sandbox");
	const name = id.length > 5 && id[0] === "n" && id[1] === "o" && id[2] === "d" && id[3] === "e" && id[4] === ":" ? id.slice(5) : id;
	if (typeof name !== "string" || allowed[name] !== true) throw new Error(id + ": unavailable in the terminal's sandbox");
	return builtin0("node:" + name);
};

// Frames out: the message's header as JSON, its write text or socket bytes as the body.
const send = (message) => {
	const kind = message.kind;
	let header;
	let body;
	if (kind === "write") {
		const data = String(message.data);
		// Refused before it is copied: a huge string costs no buffer of its size.
		if (data.length > MAX_FRAME) throw new RangeError("the terminal's bridge takes frames of at most 17 MiB");
		header = { kind };
		body = BufferFrom(data);
	} else if (kind === "socket_send") {
		if (!isUint8Array(message.bytes)) throw new TypeError("socket_send: bytes expected");
		header = { kind, socket: message.socket };
		body = message.bytes;
	} else {
		header = message;
	}
	const json = BufferFrom(stringify(header));
	const length = 4 + json.length + (body === undefined ? 0 : body.length);
	if (length > MAX_FRAME) throw new RangeError("the terminal's bridge takes frames of at most 17 MiB");
	const prefix = BufferAlloc(8);
	writeUInt32BE(prefix, length, 0);
	writeUInt32BE(prefix, json.length, 4);
	writeOutput(output, BufferConcat(body === undefined ? [prefix, json] : [prefix, json, body]));
};

// The substitute process.
const stdout = freeze({ isTTY: false, write: (data) => (send({ kind: "write", data: String(data) }), true) });
const listening = (name) => [name, function () { return fake; }];
const fake = freeze({
	arch: real.arch,
	platform: real.platform,
	version: real.version,
	versions: freeze({ ...real.versions }),
	release: freeze({ ...real.release }),
	nextTick: (...args) => apply(nextTick, real, args),
	hrtime: Object.assign((...args) => apply(hrtime, real, args), { bigint: () => apply(hrtimeBigint, real, []) }),
	uptime: () => apply(uptime, real, []),
	exit: (code) => apply(exit, real, [code]),
	permission: real.permission,
	env: freeze({}),
	argv: freeze(["node"]),
	argv0: "node",
	execArgv: freeze([]),
	execPath: "node",
	title: "node",
	cwd: () => "/",
	getBuiltinModule: builtin,
	stdout,
	stderr: freeze({ isTTY: false, write: () => true }),
	...Object.fromEntries(["on", "once", "off", "addListener", "removeListener", "removeAllListeners"].map(listening)),
	emit: () => false,
	emitWarning: () => {},
	listenerCount: () => 0,
	listeners: () => [],
});
define(globalThis, "process", { value: fake, writable: false, configurable: false, enumerable: false });
for (const name of ["BroadcastChannel", "localStorage", "sessionStorage"]) delete globalThis[name];

// Downloaded code runs only through here, with options of no prototype (nothing read from Object.prototype).
const evaluate = (text, filename) => {
	const options = Object.create(null);
	options.filename = String(filename);
	return runInThisContext(new Script(String(text), options));
};

// Frames in: the first is the start (the bridge's start and the base bundle), the rest the launcher's messages.
let listener;
let started = false;
// Unread bytes: one buffer, grown by doubling, each byte copied in once.
let pending = BufferAlloc(64 * 1024);
let start = 0;
let end = 0;
const received = (payload) => {
	const headerLength = readUInt32BE(payload, 0);
	const header = parse(bufferText(payload, "utf8", 4, 4 + headerLength));
	const body = subarray(payload, 4 + headerLength);
	if (!started) {
		started = true;
		run(header.start, bufferText(body, "utf8"));
		return;
	}
	if (header.kind === "input") header.data = bufferText(body, "utf8");
	else if (header.kind === "socket_message" || header.kind === "attached") header.bytes = new Uint8Array(body);
	if (listener !== undefined) listener(header);
};
onInput(input, "data", (chunk) => {
	if (end + chunk.length > pending.length) {
		const unread = end - start;
		const target = unread + chunk.length <= pending.length ? pending : BufferAlloc(Math.max(unread + chunk.length, pending.length * 2));
		copyBytes(pending, target, 0, start, end);
		pending = target;
		start = 0;
		end = unread;
	}
	copyBytes(chunk, pending, end);
	end += chunk.length;
	while (end - start >= 4) {
		const length = readUInt32BE(pending, start);
		if (length > MAX_FRAME) apply(exit, real, [70]);
		if (end - start < 4 + length) break;
		// A copy: the buffer is reused, and what the frame carries is kept by the sandbox.
		const payload = BufferAlloc(length);
		copyBytes(pending, payload, 0, start + 4, start + 4 + length);
		start += 4 + length;
		received(payload);
	}
	if (start === end) start = end = 0;
});
onInput(input, "end", () => apply(exit, real, [0]));
const run = (start, source) => {
	globalThis.chordBridge = freeze({
		start: freeze(start),
		send,
		onMessage: (next) => {
			listener = next;
		},
		evaluate,
	});
	try {
		const base = { exports: {} };
		evaluate("(function (require, module, exports) {" + source + "\\n})", "chord-base.js")(builtin, base, base.exports);
	} catch (error) {
		send({ kind: "failed", message: String(error && error.message) });
	}
};
`;
