// 文件导读
// 所属：packages/chord/test/examples/57-tui，Chord 示例 57，对应 slice 11 §4（终端 surface）。
// 作用：在示例 56 的 board 应用上验证终端客户端链路：
//   1) 直接读取服务器上的 TuiScripts 远程对象，查看终端 base bundle 哈希与插件脚本清单；
//   2) 用启动器 `startTerminal` 启动一个真实终端客户端：服务器下载 terminal 入口与插件脚本，
//      启动器把它们放进受限子进程沙箱，自己负责登录、链路中继与动作确认；
//   3) 用两个 PassThrough 假装终端（60 列 × 10 行），收集绘制帧，等出现 "Notes" 后发送 "q"，
//      读取退出码。
// 上游：从 packages/chord 运行
//   node --conditions=source --experimental-strip-types test/examples/57-tui/main.ts
// 加 `--serve` 保留 board，并打印可手动运行 terminal.ts 的命令。
// 下游：示例 56 的 startBoard/boardDirectories、src/node/tui 的 startTerminal/requireSandboxNode、
// src/index.ts 的 TuiScripts 契约。副作用：建临时目录、监听回环端口、fork 沙箱子进程。
// 能力清单：
// - 读取脚本清单：app.host.get(TuiScripts, {}) + scripts.set.value.plugins；
// - 版本门禁：requireSandboxNode（Node 26.5.1+ 才有权限模型沙箱）；
// - 脚本化终端：PassThrough 输入/输出 + startTerminal；
// - 帧断言：等待 "Notes" 文本，剥离 ANSI 后打印；
// - 干净关闭：app.close + rm 临时目录。
// 典型输出：
//   1. terminal base bundle: <hash>
//      terminal plugins: @board/notes /_chord/tui/plugin/…
//   2. the terminal shows:
//      Board
//        Notes: Buy milk
//      exit code: 0
// 阅读顺序：先看第 1 步的远程对象读取，再看第 2 步的沙箱与流注入；交互版本见 terminal.ts。
// 注意：这不是无副作用的纯测试：它会 fork 子进程、等待真实渲染。Node 版本不足时第 2 步会跳过并打印原因。

// The terminal surface (slice 11 §4): the board (example 56's app) with a terminal client. The server builds the
// terminal's base bundle from the app's terminal entry (`56-web/tui/main.ts`) and serves the plugins' terminal facets
// as registered scripts, like the web's. The client's launcher (trusted, Node 26.5.1 or later) signs in with the owner
// token file, downloads the bundle and the scripts and runs them in its sandbox, always: a child process without file
// system, processes, network or terminal, its link and its actions relayed and confirmed by the launcher.
// Run from packages/chord (with Node 26.5.1 or later the launcher runs here on a scripted terminal; `--serve` keeps the
// board running for `terminal.ts`):
//   node --conditions=source --experimental-strip-types test/examples/57-tui/main.ts
import { rm } from "node:fs/promises";
// PassThrough 是最简单的双工流：写入的字节原样从可读侧发出，适合伪造终端输入/输出。
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { TuiScripts } from "../../../src/index.ts";
// requireSandboxNode 做 Node 版本门禁；startTerminal 是可信启动器入口。
import { requireSandboxNode, startTerminal } from "../../../src/node/tui/index.ts";
import { boardDirectories, startBoard } from "../56-web/start.ts";

// 与示例 56 相同的启动方式：临时数据目录 + 可编辑插件副本。
const { base, dataDir, root } = await boardDirectories();
const app = await startBoard(dataDir, root, context);
// ownerLink 的 origin 就是服务器地址（去掉 fragment 中的一次性 token）。
const url = new URL(app.ownerLink()).origin;

// 1. What a launcher downloads: the base bundle (an ES module for the sandbox) and the terminal plugins' scripts.
// host.get 取得 TuiScripts 远程对象的引用；空对象 {} 是它的 params（该契约没有参数）。
// 返回 Held：脚本集合是 state 成员 `set`，`.value` 是当前值；release 释放引用。
const scripts = await app.host.get(TuiScripts, {}, context);
// app.tui 只在启用终端 surface 时存在；base 是终端基础 bundle 的内容哈希。
console.log("1. terminal base bundle:", app.tui?.base);
// set.value.plugins 是脚本条目数组；每项 name 为插件名、url 为服务器上的下载路径。
// 解构重命名 `url: path` 避免与外层 url 变量重名。
console.log(
	"   terminal plugins:",
	scripts.set.value.plugins.map(({ name, url: path }) => `${name} ${path}`).join(", "),
);
// 引用不再需要，立即释放；远程对象没有其他持有者时服务器可以回收它。
scripts.release();

// 2. A terminal client, when this Node can sandbox it: a scripted terminal (pipes), its frames shown as text.
// 默认认为可以沙箱；若版本门禁抛错则改为 false，并只打印提示（示例仍能完成第 1 步）。
let sandboxed = true;
try {
	requireSandboxNode();
} catch (error) {
	sandboxed = false;
	// catch 变量在 strict/useUnknownInCatchVariables 下是 unknown；断言成 Error 才能读 message。
	// 这是编译期断言，运行时如果抛出的不是 Error，`.message` 可能为 undefined。
	console.log(`2. ${(error as Error).message}: run terminal.ts under a newer Node to see the client.`);
}
if (sandboxed) {
	// 输入：模拟用户按键；输出：模拟终端显示，Object.assign 额外挂上 columns/rows 供布局使用。
	const input = new PassThrough();
	const output = Object.assign(new PassThrough(), { columns: 60, rows: 10 });
	// frames 累积所有输出块；Buffer.toString() 默认按 UTF-8 解码，ANSI 序列会以 ESC 字符保留。
	let frames = "";
	output.on("data", (chunk: Buffer) => {
		frames += chunk.toString();
	});
	// startTerminal 是可信启动器：读完 owner token 文件、下载 bundle/脚本、fork 沙箱并转发链路。
	// 注入 input/output 后不会接管当前进程的标准输入输出。
	const terminal = await startTerminal({
		url,
		credentials: { kind: "file", path: app.ownerTokenFile },
		input,
		output,
	});
	// 渲染是异步的：轮询直到某一帧包含插件贡献的 "Notes"，每次等待 20ms。
	while (!frames.includes("Notes")) await new Promise((resolve) => setTimeout(resolve, 20));
	// Escape sequences stripped for the console.
	// 终端每次重绘以“清屏 + 光标归位”开始；split 后取最后一段，即最新一帧。
	// `.at(-1)` 允许负索引；`!` 非空断言表示至少有一个元素（frames 已包含 Notes）。
	// 再用正则删除 SGR 颜色序列 ESC[...m，便于在普通控制台阅读。
	const text = frames
		.split("\x1b[2J\x1b[H")
		.at(-1)!
		.replace(/\x1b\[[0-9;]*m/g, "");
	console.log("2. the terminal shows:");
	// 终端用 \r\n 换行；trim 去掉首尾空白后逐行打印。
	for (const line of text.trim().split("\r\n")) console.log(`   ${line}`);
	// 发送 q；终端入口的 onInput 会调用 runtime.exit(0)。
	input.write("q");
	// exited 在沙箱子进程结束时完成，值为退出码；这也是启动器清理完成的信号。
	console.log("   exit code:", await terminal.exited);
}

if (process.argv.includes("--serve")) {
	// 保留服务器，打印交互客户端所需的两个参数；terminal.ts 会接管真实终端。
	console.log(`Board at ${url}; token file ${app.ownerTokenFile}`);
	console.log(`Run: node26 --conditions=source test/examples/57-tui/terminal.ts ${url} ${app.ownerTokenFile}`);
} else {
	// 关闭应用并删除临时目录；沙箱已退出，无需再 stop。
	await app.close(context);
	await rm(base, { recursive: true, force: true });
}
