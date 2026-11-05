// 文件导读
// 所属：packages/chord/test/examples/53-app，Chord 示例 53，对应 slice 13（app kit）。
// 作用：把 notes 应用从启动到关闭走一遍：
//   1) startNotes 启动服务器，打印 owner 链接和数据目录；
//   2) 未登录访问插件路由得到 401（deny-by-default）；
//   3) owner 打开链接，页面从 URL fragment 取出一次性 token，POST 后换成会话 cookie，链接随即作废；
//   4) 登录后 GET / 看到 AppInfo 与 Sections 注册表；笔记路由转发到项目 worker，worker 首次请求时启动；
//   5) 本机命令行客户端读取 0600 的 owner token 文件，用 Bearer 认证；
//   6) app.close 按 HTTP → workers → host → store 顺序释放资源，删除临时目录。
// 上游：./start.ts（startNotes）、./client.ts（call）、./worker.ts（worker 入口，由 start 选项引用）、
// ./app/（API 与 principal）、./plugins/（home 与 notes 两个内置插件）。
// 下游：packages/chord/src/node/app/index.ts 的 startServer/ownerLink/ownerTokenFile/App.close，
// src/node/http 的会话认证，以及 Node 的 fs/os/path 与回环 TCP。
// 能力清单（按步骤）：startNotes、app.ownerLink、app.ownerTokenFile、call、登录 cookie、AppInfo/Sections、
// 项目 worker 与 Files、app.close。
// 典型运行（示例）：
//   cd packages/chord
//   node --conditions=source --experimental-strip-types test/examples/53-app/main.ts
// 预期输出形如：
//   1. owner link: http://127.0.0.1:PORT/_chord/owner#…
//      data directory: logs, owner-token, plugins, server, workers
//   2. anonymous GET /: 401
//   3. the link's page: 200 (reads the fragment)
//      signed in: 200 signed in
//      the link again: 403
//   4. GET /: {"app":"notes v1","you":{"kind":"owner"},"sections":["Notes: /notes/:id"]}
//      GET /notes/p1: {"text":"milk, eggs","start":"{\"project\":\"project|p1\"}"}
//      worker directories: project%7Cp1
//   5. CLI GET /: ...{"you":{"kind":"owner"}}...
//   6. closed
// 阅读顺序：先看 1 的启动与 owner 链接，再看 3 的 fragment 登录；之后对照 start.ts 的选项与插件源码。
// 前置条件：Node 版本支持 --experimental-strip-types；从 packages/chord 目录运行，相对导入才按源码解析。
// 副作用：监听回环端口、创建并删除临时数据目录、启动 worker 子进程；只访问本机，不访问外网。
// 非断言式示例：失败会以异常、非预期状态码或输出差异体现；结束时删除临时目录（异常退出时不会）。
//
// The app kit (slice 13): an app is its API (`app/`), its built-in plugins (`plugins/`: home and notes) and a start
// script (`start.ts`) calling `startServer`; its workers' entry (`worker.ts`) calls `startWorker`. The kit makes the data
// directory, the server's store and host, HTTP (deny by default: no session, 401), one worker per project with its own
// store and files, and the owner's sign-in: a one-time owner link for the browser, an owner token file for command-line
// clients on the same machine.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/53-app/main.ts

// mkdtemp 建唯一临时目录；readdir 列目录；readFile 读 owner token；rm 清理。
// 全部来自 node:fs/promises，返回 Promise。
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
// 系统临时目录（macOS 上通常是 /var/folders/…）。
import { tmpdir } from "node:os";
// join 拼接跨平台路径。
import { join } from "node:path";
// 示例进程没有请求级取消信号，用后台上下文；`as context` 只是别名。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 示例共享的最小 HTTP 客户端。
import { call } from "./client.ts";
// 应用的启动函数（见 start.ts）。
import { startNotes } from "./start.ts";

// 顶层 await：ES module 中可直接等待异步初始化。
// 先建临时根，再在其下用 dataDir；让数据目录本身由 startServer 创建，便于观察 kit 建了哪些子目录。
const dataDir = join(await mkdtemp(join(tmpdir(), "notes-")), "data");

// 1. Start the app. The start script prints the owner link (single use, 10 minutes, a new one at each start).
// 1. 启动应用。ownerLink() 返回完整 URL；token 在 # 之后，不会随 HTTP 请求发送。
const app = await startNotes(dataDir, context);
// new URL 解析出 pathname、port 等部分；origin 例如 http://127.0.0.1:52341。
const link = new URL(app.ownerLink());
// link.port 是字符串；Number(...) 转成 call() 需要的 number。
const port = Number(link.port);
// 只打印 origin+pathname 并用 #… 隐藏 token，避免凭据出现在示例输出里。
console.log("1. owner link:", `${link.origin}${link.pathname}#…`);
// dataDir 此时已由 kit 建好：logs、owner-token、plugins、server、workers；排序让输出稳定。
// `(await readdir(dataDir)).sort()`：先等待读取，再对字符串数组排序；join(", ") 作为分隔符。
console.log("   data directory:", (await readdir(dataDir)).sort().join(", "));

// 2. Nobody is signed in: every plugin route answers 401 before the plugin runs.
// 2. 未携带 cookie 或 Bearer：服务器在进入插件路由前就返回 401，插件代码不会执行。
// call 返回 Answer；这里只打印 status。
console.log("2. anonymous GET /:", (await call(port, "GET", "/")).status);

// 3. The owner opens the link: the page posts the token from the URL's fragment (never sent in a URL, so never in a
//    log) and gets the session cookie. The link is used up.
// 3. owner 打开链接。GET 得到一段 HTML，其中内联脚本读取 location.hash 并 POST 回 token。
// link.pathname 是 /_chord/owner；不带 fragment，所以页面渲染结果不含 token。
const page = await call(port, "GET", link.pathname);
// String(page.body) 把 unknown 转成字符串（这里 body 是 HTML 文本）；includes 检查脚本是否在读 fragment。
// 三元表达式在命中时输出 “(reads the fragment)”，否则输出空字符串。
console.log(
	"3. the link's page:",
	page.status,
	String(page.body).includes("location.hash") ? "(reads the fragment)" : "",
);
// link.hash 形如 "#<token>"；slice(1) 去掉 #。请求体是 { token }，call 会序列化为 JSON。
// `{}` 是空 headers；第三个参数之后是 body。
// POST 成功时服务器消耗 token 并 Set-Cookie；Answer.cookie 只保留 name=value。
const signedIn = await call(port, "POST", link.pathname, {}, { token: link.hash.slice(1) });
// 服务器总会签发 cookie；`?? ""` 是防御性兜底，让 browser 对象的类型是确定的字符串。
// 后续请求把它作为 Cookie 头发送。
const browser = { cookie: signedIn.cookie ?? "" };
// body 是 JSON 字符串 "signed in"（JSON.parse 后就是普通字符串），输出不带引号。
console.log("   signed in:", signedIn.status, signedIn.body);
// 同一个 token 再用一次：链接已作废，服务器返回 403。
console.log("   the link again:", (await call(port, "POST", link.pathname, {}, { token: link.hash.slice(1) })).status);

// 4. Signed in, the home plugin reads the kit's `AppInfo` and lists the sections of its registry (the notes plugin's);
//    the notes plugin's routes reach the project's worker (it starts on the first request) with its store and the
//    start data the app gave it.
// 4. 登录后 GET /：home 插件用 AppInfo 拼出 "notes v1"，用 Sections 合并结果拼出区块列表。
// JSON.stringify 把解析后的对象重新序列化，输出一行稳定的 JSON。
console.log("4. GET /:", JSON.stringify((await call(port, "GET", "/", browser)).body));
// POST /notes/p1：body 是纯文本 "milk, eggs"（headers 只有 cookie，没有 content-type），
// 服务器按 request.json() 接收 JSON 值——此处 JSON 字符串恰好是合法 JSON。
await call(port, "POST", "/notes/p1", browser, "milk, eggs");
// 再次 GET：worker 在首次访问时启动，返回当前文本与 WorkerInfo.start（JSON 字符串化的启动数据）。
console.log("   GET /notes/p1:", JSON.stringify((await call(port, "GET", "/notes/p1", browser)).body));
// 每个项目一个 worker 目录：workers/<kind>/<编码后的 key>；"project|p1" 中的 | 被 percent-encode 成 %7C。
console.log("   worker directories:", (await readdir(join(dataDir, "workers", "project"))).join(", "));

// 5. A command-line client on the same machine reads the owner token file (mode 0600) and sends it as a bearer token.
// 5. 本机命令行客户端：读取 owner token 文件（权限 0600），trim 去掉末尾换行。
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
// Bearer 认证；与浏览器 cookie 是同一套会话存储，只是会话 kind 不同。
const cli = { authorization: `Bearer ${token}` };
// 输出与第 4 步的 GET / 相同（都是 owner 身份）。
console.log("5. CLI GET /:", JSON.stringify((await call(port, "GET", "/", cli)).body));

// 6. Close: HTTP, workers, host, store, in that order.
// 6. 关闭：app.close 停止 HTTP、结束 workers、释放 host 与 store；之后链接与端口都不再可用。
await app.close(context);
// dataDir 的父目录就是 mkdtemp 建的临时根；连它一起删。
// recursive: true 删目录树；force: true 让不存在时不报错。
await rm(join(dataDir, ".."), { recursive: true, force: true });
// 最后一行确认清理完成。
console.log("6. closed");
