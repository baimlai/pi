// 文件导读
// 所属：packages/chord/test/examples/59-chat，Chord 示例 59（多 channel 聊天）的端到端演示入口。
// 作用：启动一个 server + 每频道一个 worker 的 chat，然后按五步验证整条链路：
//   1. 打印登录页/页面地址；
//   2. 用 ephemeral login 以 "ada" 登录，取得 cookie，用 createHost + WebSocket 链路像页面一样加入，
//      在 #general/#random 各发一条消息；
//   3. 用 32 字节分块上传一张 1x1 PNG，share 成消息，再以 HTTP GET 取回附件，并列出已启动的 worker 地址；
//   4. 向 #random 发 120 条消息，验证实时窗口 100 条 + history 分页得到全部 121 条；
//   5. Node >= 26.5.1 时启动 owner 的终端客户端：看到 ada 的消息，发一条消息并以 `/attach` 上传本机文件，
//      Tab 切到 #random 后 PgUp 加载更旧的一页，最后 Ctrl-C 退出。
// 上游：./start.ts 的 chatDirectories/startChat；app/v1.ts 的 Room 契约；owner token 文件由 startServer 生成。
// 下游：src 的 createHost/webSocketLink、src/node/tui 的 startTerminal/requireSandboxNode、HTTP /files 路由。
// 能力清单：顶层脚本（无导出函数）；辅助闭包 shows；五个编号步骤与清理/--serve 分支。
// 典型调用与真实签名（示例）：
//   const { base, dataDir, root } = await chatDirectories();
//   const app: App<ChatPrincipal> = await startChat(dataDir, root, context); // Promise<App<ChatPrincipal>>
//   const terminal: RunningTerminal = await startTerminal({ url, credentials, input, output });
//   await terminal.exited; // Promise<number>
// 阅读顺序：先看 1 的启动，再看 2 的登录/链路/引用，然后 3 的分块上传与 HTTP 读回、4 的窗口与分页，
//   最后 5 的终端启动、断言辅助函数 shows、attach 确认与 Ctrl-C，以及末尾清理。
// 前置条件：Node 26.5.1+ 才能运行第 5 步（否则打印原因并跳过）；第 1-4 步只需 Node 能运行 TypeScript。
// 运行方式（在 packages/chord 下）：
//   node --conditions=source --experimental-strip-types test/examples/59-chat/main.ts
//   加 --serve 时服务器保持运行，打印 owner token 文件路径，供 57-tui 的 terminal.ts 使用。
// 预期输出：编号 1-5 的日志；第 5 步的 "[image: dot.png]" 与消息/附件行；结束时（不带 --serve）关闭全部资源。
// 副作用：创建临时目录与 owner token 文件、监听回环端口、fork worker、写插件副本、启动终端沙箱、
//   本机 HTTP/WebSocket 请求；不带 --serve 时删除临时目录。
// 校验边界：登录 POST 的 JSON 由服务端按 schema 校验；Room 方法参数在每个提供方调用边界校验；
//   state 与方法返回值不做运行时校验，读取依赖 TypeScript 类型与示例约定。
// 注意：`!` 非空断言和 `as unknown as WebSocketLike` 都是编译期写法，不会在运行时检查；
//   任何一步失败会抛出并使进程以非零码结束（--serve 除外），清理逻辑不执行。
//   所有 `while`/`shows` 轮询都没有超时，失败时会一直等待。

// A chat (slice 11 with the app kit): one worker per channel (`Channel({ id })`), each channel's `Room` on its worker
// with every message in a table of the worker's store (the newest 100 live, older ones by page: `history`) and the
// attachments in its files (the kit's `Files`, sent in chunks); the server keeps the channel list and serves the page
// (`/chat`, after picking a name at `/`) and the terminal client. A browser and a terminal are live in the same room.
// Here a user who picked a name ("ada") joins over the same Chord link a page uses, and with Node 26.5.1 or later the
// owner's terminal client joins too.
// Run from packages/chord (`--serve` keeps it running: open the printed URL, and run the terminal with 57-tui's
// `terminal.ts` and the owner token file):
//   node --conditions=source --experimental-strip-types test/examples/59-chat/main.ts
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
// Node 的 ws 客户端；与浏览器 WebSocket 的 API 不同，因此链路上需要结构化适配。
import { WebSocket } from "ws";
// 后台上下文：这里的调用不随某个请求取消；BACKGROUND_CONTEXT 不带取消信号。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// createHost 构造客户端宿主；webSocketLink 把现成 socket 包装成 Chord 链路；
// WebSocketLike 是链路所需的最小结构类型，仅类型导入。
import { createHost, type WebSocketLike, webSocketLink } from "../../../src/index.ts";
// 终端启动器与 Node 版本门槛；requireSandboxNode 在版本不足时抛错（不返回布尔）。
import { requireSandboxNode, startTerminal } from "../../../src/node/tui/index.ts";
import type { ChatPrincipal } from "./app/principals.ts";
import { Room } from "./app/v1.ts";
import { chatDirectories, startChat } from "./start.ts";

// 1. 建临时目录、复制插件、启动服务器（监听 127.0.0.1 的随机端口）。
// ownerLink 含一次性 owner token（fragment 中），这里只取 origin 作为服务器地址；没有走 owner 登录，
// 而是随后用普通用户名登录。
const { base, dataDir, root } = await chatDirectories();
const app = await startChat(dataDir, root, context);
const url = new URL(app.ownerLink()).origin;
console.log(`1. the chat at ${url}/ (pick a name), the page at ${url}/chat`);

// 2. Ada picks a name (the kit's ephemeral login) and joins over the links endpoint with her session cookie.
// 登录：POST /_chord/login 是 ephemeral facet 的公开路由，返回 JSON 并设置会话 cookie。
// body 是手写 JSON 字符串（不是对象字面量）；服务端会按 schema 校验 name。
const login = await fetch(`${url}/_chord/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: '{"name":"ada"}',
});
// Node 的 fetch 暴露 set-cookie 头；只取 name=value 段（分号前）供 WebSocket 握手使用。
// `!` 表示示例假定登录成功；若响应没有 set-cookie，这里会在 null 上调用 split 而抛 TypeError。
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
// 客户端宿主：onError 接收 Chord 的客户端错误（插件、连接、对象），这里静默。
// ChatPrincipal 只是编译期身份类型；服务器在握手时根据 cookie 决定真实 principal。
const ada = createHost<ChatPrincipal>({ onError: () => {} });
// load([]) 执行启动屏障：没有额外 facet，但宿主必须 load 过才能 connect/get。
await ada.load([], context);
// /chord 是服务器的链路端点；握手带上会话 cookie，服务器据此认证为 user "ada"。
// ws 的 WebSocket 类型与结构化 WebSocketLike 不是同一形状（事件/发送签名不同），
// `as unknown as` 是纯编译期断言，运行时仍是同一个 socket。
const socket = new WebSocket(`${url.replace(/^http/, "ws")}/chord`, { headers: { cookie } });
// connect 把链路作为父链接；客户端的 principal 只是链路标签（客户端不服务远程类型），
// 真实身份在服务器一侧由握手决定。这里写 server 与 startClient 内部约定一致。
ada.connect(webSocketLink(socket as unknown as WebSocketLike), { principal: { kind: "server" } }, context);
// get 等待引用首次绑定为 live（默认 readyTimeout），返回 Reference；Room 的 hostAddress 会把 hold
// 路由到 Channel({ id: "general" })，按需 fork 该频道的 worker，并由 authorize 允许 user。
const general = await ada.get(Room, { id: "general" }, context);
// 方法参数在 worker 的提供方校验；调用成功即消息已提交到表并更新实时窗口。
await general.post("hello from ada", context);
const random = await ada.get(Room, { id: "random" }, context);
await random.post("anyone here?", context);
console.log("2. ada posted in #general and #random");

// 3. A picture, in chunks as the page sends one: into #general's worker files, then shared as a message.
// 1x1 透明 PNG 的 base64；Buffer.from 解出字节，再包成 Uint8Array（bytes schema 认的叶子类型）。
// 外层 new Uint8Array(...) 是对 Buffer 的视图/复制转换，确保类型是普通 Uint8Array。
const png = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
		"base64",
	),
);
// 分块大小 32 字节：示例故意用小值展示多块上传与 offset 语义（页面/终端实际用 256 KiB）。
const upload = await general.begin({ name: "dot.png", mime: "image/png" }, context);
for (let offset = 0; offset < png.length; offset += 32) {
	// subarray 共享底层 buffer；offset 必须与 worker 已收字节数一致，顺序 await 保证背压。
	await general.append({ upload, offset, bytes: png.subarray(offset, offset + 32) }, context);
}
await general.share({ upload, text: "a picture" }, context);
// 读实时窗口的最后一条。share 在 worker 内先更新窗口再返回，链路按序交付状态与结果，
// 因此这里通常已经看到新消息；`!` 表示示例假定它存在（否则后续 file 访问会抛错）。
const shared = general.messages.value.at(-1)!;
// 附件通过服务器的 /files/:channel/:id 路由读取；请求带 ada 的 cookie，以她的身份获取 Room 并读文件。
const image = await fetch(`${url}/files/general/${shared.file!.id}`, { headers: { cookie } });
// 打印状态码、content-type 与完整字节数；content-type 来自附件元数据（image/png）。
console.log(
	`3. shared ${shared.file!.name}: GET /files/general/… ${image.status} ${image.headers.get("content-type")}, ${(await image.arrayBuffer()).byteLength} bytes`,
);
// workers 是“host kind 名 -> Workers 组件”的映射；state.value 是地址键到 WorkerState 的记录。
// 到这一步 general 与 random 都已被持有过，因此两个频道各启动了一个 worker。
console.log("   one worker per channel:", Object.keys(app.workers.get("channel")!.state.value).join(", "));

// 4. Every message is kept in the channel's table: the room shows the newest 100 live and pages older ones.
// 顺序 await 120 次 post；消息 id 由 worker 的 Store 对象用计数器分配（next++），提交完成顺序可能不同，
// 但实时窗口按 id 排序，因此读者看到的顺序稳定。
for (let n = 1; n <= 120; n++) await random.post(`message ${n}`, context);
// 状态推送是异步的：轮询直到本地镜像的最后一条是 "message 120"（没有超时）。
while (random.messages.value.at(-1)?.text !== "message 120") await new Promise((resolve) => setTimeout(resolve, 20));
// live 是实时窗口（最新 100 条，旧→新）；older 是窗口之前的一页（旧→新）。
// 此时 #random 共 121 条（"anyone here?" + message 1..120），因此 live=100、older=21。
const live = random.messages.value;
const older = await random.history({ before: live[0]!.id }, context);
// 打印总数、实时窗口起点、旧页条数与旧页起点；两个起点拼接即可验证分页无重叠。
console.log(
	`4. #random keeps ${older.length + live.length} messages: ${live.length} live (from "${live[0]!.text}"), ${older.length} older by history (from "${older[0]!.text}")`,
);

// 5. The owner's terminal client in the same room (Node 26.5.1 or later): it shows ada's messages; its post and an
//    attached file (the launcher asks before it reads the file) reach ada at once; PgUp in #random loads older ones.
// 版本门槛：沙箱依赖 Node 26.5.1+ 的权限模型；requireSandboxNode 抛错则跳过第 5 步，前四步结果仍然有效。
let sandboxed = true;
try {
	requireSandboxNode();
} catch (error) {
	sandboxed = false;
	// error 在 catch 中是 unknown；断言成 Error 只为读取 message（运行时不检查形状）。
	console.log(`5. (${(error as Error).message})`);
}
if (sandboxed) {
	// 用 PassThrough 模拟终端：input 写按键，output 收集启动器写出的屏幕内容。
	const input = new PassThrough();
	// Object.assign 给流补上 columns/rows：启动器据此布局和判断提示是否放得下（缺省为 80x24）。
	const output = Object.assign(new PassThrough(), { columns: 80, rows: 20 });
	// screen 累积所有输出块；chunk 声明为 Buffer，因为未设置编码的流给 Buffer。
	let screen = "";
	output.on("data", (chunk: Buffer) => {
		screen += chunk.toString();
	});
	// 启动 owner 终端：凭据是 ownerTokenFile（设备 token，文件权限 0600）。
	// startTerminal 在沙箱启动并接管输入输出后 resolve；退出码通过 terminal.exited 观察。
	const terminal = await startTerminal({
		url,
		credentials: { kind: "file", path: app.ownerTokenFile },
		input,
		output,
	});
	// 辅助函数 shows：轮询屏幕直到出现纯文本 text。只去掉 SGR 颜色序列（...m），
	// 清屏/定位等序列仍留在 screen 中；没有超时，界面不出现就会一直等待。
	const shows = async (text: string): Promise<void> => {
		while (!screen.replace(/\x1b\[[0-9;]*m/g, "").includes(text))
			await new Promise((resolve) => setTimeout(resolve, 20));
	};
	// 终端默认在 #general：应看到第 3 步共享的图片占位符（跨客户端状态同步）。
	await shows("[image: dot.png]");
	// 取最后一次整屏输出（按清屏+回首页序列切分），去掉颜色，按行拆分，跳过第一行标签，取前两条消息行。
	// JSON.stringify 让换行等不可见字符在日志中可读。
	console.log(
		"5. the terminal shows:",
		JSON.stringify(
			screen
				.split("\x1b[2J\x1b[H")
				.at(-1)!
				.replace(/\x1b\[[0-9;]*m/g, "")
				.split("\r\n")
				.slice(1, 3),
		),
	);
	// 在终端输入行输入文本并按 Enter（\r）；TUI 的 send 会以 owner principal 调用 post。
	input.write("hi ada, from the terminal");
	input.write("\r");
	// 在临时根目录写一个真实文件，随后通过 /attach 让启动器读取并分块上传。
	const notes = join(base, "notes.txt");
	await writeFile(notes, "the agenda");
	// 输入命令与回车；TUI 解析 `/attach ` 前缀后请求启动器，启动器弹出确认提示。
	input.write(`/attach ${notes}`);
	input.write("\r");
	// The launcher's prompt names the file's real path and asks; only a yes lets it read the file. Keys typed in the
	// first 300 ms of a prompt are ignored (they were meant for the app).
	// 等待提示出现；等过 300ms 保护期后再写 "y"（提示按单键判断：只有 y/Y 是肯定，其他任意键否定）。
	await shows("Attach this file? [y/N]");
	await new Promise((resolve) => setTimeout(resolve, 350));
	input.write("y");
	// 上传完成后附件消息进入 #general 的实时窗口；轮询直到最后一条带 notes.txt。
	while (general.messages.value.at(-1)?.file?.name !== "notes.txt")
		await new Promise((resolve) => setTimeout(resolve, 20));
	// 取最后两条消息：文本消息与附件消息（附件消息 text 为空，回退显示文件名）。
	const last = general.messages.value
		.slice(-2)
		.map((message) => `${message.author}: ${message.text || message.file?.name}`);
	console.log("   ada sees:", last.join(" | "));
	// #random, then PgUp to its first message: the terminal loads the page before the live window.
	// Tab 从 general 切到 random；PgUp 序列各间隔 50ms，给异步加载历史页留出时间。
	input.write("\t");
	for (let n = 0; n < 8; n++) {
		input.write("\x1b[5~");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	// 8 屏（每屏 17 行）足以滚到最前；历史页加载后应出现 random 的第一条 "anyone here?"。
	await shows("ada anyone here?");
	console.log("   PgUp in #random reaches its first message: anyone here?");
	// Ctrl-C 交给 TUI 的运行时 exit(0)，启动器结束沙箱；等待退出码。
	input.write("\x03");
	await terminal.exited;
}

// 不带 --serve：释放两个引用、关闭客户端宿主（断开链路、结束对象）、关闭服务器（worker、HTTP、插件），
// 最后删除临时目录（数据、插件副本与 owner token 文件）。顺序保证先断开使用资源的客户端再停服务器。
// 带 --serve：只打印 owner token 文件路径，进程因服务器仍在监听而保持运行，供手动打开页面/终端。
if (process.argv.includes("--serve")) {
	console.log(`Owner token file: ${app.ownerTokenFile}`);
} else {
	general.release();
	random.release();
	await ada.close(context);
	await app.close(context);
	await rm(base, { recursive: true, force: true });
}
