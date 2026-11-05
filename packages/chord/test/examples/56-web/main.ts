// 文件导读
// 所属：packages/chord/test/examples/56-web，Chord 示例 56，对应 slice 11 §1-§3（web surface）。
// 作用：最小可运行地演示 app kit + web surface 的完整链路：
//   1) startBoard 启动服务器，构建页面 base bundle，发布插件的 web facets；
//   2) 用 owner token 作为命令行客户端拉取页面 HTML，看到注入的脚本/样式；
//   3) 在 Node 中用无浏览器页面（headlessPage）运行同一份客户端代码，并读取 Panels 注册表；
//   4) 修改 clock 插件的源码，调用 applyChanges 热更新，页面原地取得新脚本并刷新面板。
// 上游：从 packages/chord 目录执行
//   node --conditions=source --experimental-strip-types test/examples/56-web/main.ts
// 加 `--serve` 会保留服务器并打印 owner 登录链接，可复制到浏览器打开。
// 下游：./start.ts（startBoard/boardDirectories）、./headless.ts（headlessPage）、src/index.ts 的
// defineFacet，以及 board 的 v1 API 模块。
// 能力清单（按步骤）：
// - 启动与登录链接：startBoard、app.ownerLink、app.ownerTokenFile、app.web.base；
// - 页面抓取：fetch + Bearer token，正则列出 src/href；
// - 无头页面：defineFacet 提供 Panels 注册表，headlessPage 连接 /chord，host.registry 读取合并值；
// - 热更新：改写 clock/web.ts，轮询 app.plugins.state.value.dirty，app.applyChanges；
// - 清理：page.stop、app.close、rm 临时目录（非 --serve 时）。
// 典型运行/输出：每步打印一行，例如
//   1. owner link: http://127.0.0.1:PORT/_chord/owner#… | base bundle: <hash>
//   3. panels: clock: 12:00 | notes: ...
//   4. rolled out to: ...   panels: clock: 12:01 | ...
// 阅读顺序：先看四个编号步骤，再看 start.ts 的启动选项与 headless.ts 的客户端引导。
// 注意：示例会写文件（临时插件副本）、开回环端口、访问网络（仅本机）。它不是单元测试，
// 没有断言；失败会以异常或超时循环体现。示例结束会删除临时目录；--serve 模式下不会。

// The web surface (slice 11 §1-§3): a kit app (`start.ts`, the board) with a page. The server builds the page's base
// bundle from the app's web entry (`web/main.ts`: `startPage`, React) at start, serves the plugins' web facets as
// scripts that register themselves (one combined file at load), and the page through the app's template. A plugin
// edit applies in place: the page holds `WebScripts`, fetches the one changed script and reloads its host, keeping
// what is on screen. A browser is not needed here: a headless page in Node runs the same client code.
// Run from packages/chord (add `--serve` to keep the server running and open the owner link in a browser):
//   node --conditions=source --experimental-strip-types test/examples/56-web/main.ts
// Node 内建文件 API：readFile/rm/writeFile 都是异步 Promise 版本。
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
// 后台上下文：示例进程的生命周期没有请求级取消信号；`as context` 给导入起别名。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 命名空间导入：chord.defineFacet 等；`* as` 把所有导出挂在对象上。
import * as chord from "../../../src/index.ts";
// 仅类型导入：编译/类型剥离后不保留。
import type { BoardPrincipal } from "./app/principals.ts";
// API 模块以命名空间导入，稍后作为客户端模块表的值传下去。
import * as v1web from "./app/v1/web.ts";
import * as v1 from "./app/v1.ts";
import { headlessPage } from "./headless.ts";
import { boardDirectories, startBoard } from "./start.ts";

// 顶层 await 只在 ES module 中可用；先准备临时数据目录和插件副本。
// 解构得到 base 临时根、dataDir 数据目录、root 插件副本根。
const { base, dataDir, root } = await boardDirectories();

// 1. Start the board: the base bundle is built now (named by its content), the plugins' web facets built and published.
// startBoard 内部调用 startServer，返回后应用已经在监听端口、插件已发布。
const app = await startBoard(dataDir, root, context);
// ownerLink 是含一次性 token 的登录链接；token 在 URL fragment 中，不会随 HTTP 请求发给服务器。
// 这里只打印 origin+pathname 并用 `#…` 隐藏 token，避免示例输出泄露凭据。
const link = new URL(app.ownerLink());
// 可选链 `?.`：没有启用 web surface 时 app.web 为 undefined；base 是页面基础 bundle 的内容哈希。
console.log("1. owner link:", `${link.origin}${link.pathname}#…`, "| base bundle:", app.web?.base);

// 2. The page, as a browser gets it (a command-line client's token here): the app's template with the assets.
// ownerTokenFile 是权限 0600 的设备 token 文件，供命令行客户端代替浏览器 cookie 使用。
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
// new URL("/", link) 以 link 的 origin 为基准解析出站点根；authorization 头走 Bearer token 认证。
// 双重 await：先 await fetch 得到 Response，再 await .text() 读响应体。
const html = await (await fetch(new URL("/", link), { headers: { authorization: `Bearer ${token}` } })).text();
console.log("2. the page's scripts and stylesheets:");
// matchAll 返回所有匹配的迭代器（正则必须带 g）；解构 `[, url]` 跳过整个匹配，只取第一个捕获组。
// 这里列出模板注入的 <script src> 与 <link href>，包括样式表、bootstrap、插件合并文件和基础脚本。
for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) console.log(`   ${url}`);

// 3. A page loads the combined file and renders the panels its plugins contribute (here read from its host).
// defineFacet 声明应用自己的 facet；回调拿到客户端 host 后，用 host.serve 成为 Panels 注册表的提供者。
// 泛型参数 <BoardPrincipal> 让宿主身份类型与示例其余部分一致。
const core = chord.defineFacet<BoardPrincipal>((host) =>
	// compose 接收注册表当前的所有贡献（已按插件名排序）；每个表项有 value 字段。
	// table.map(({ value }) => value) 把表项数组变成 Panel 数组，也就是页面的合并值。
	host.serve(v1web.Panels, { compose: (table) => table.map(({ value }) => value) }),
);
// headlessPage 用 Node 跑与浏览器页面相同的客户端代码：
// - 参数一：服务器 origin；参数二：owner token；
// - 参数三：插件脚本可导入的模块表（与 start.ts 里 api.modules 的键一致）；
// - 参数四：应用自己的 core facets。
const page = await headlessPage(link.origin, token, { "@board/app/v1": v1, "@board/app/v1/web": v1web }, [
	{ name: "@board/core", facet: core },
]);
// host.registry 返回 RegistryValue：`.value` 是最近一次成功合并的值；注册表变化时随之更新。
const panels = await page.host.registry(v1web.Panels, context);
// 用 map 把面板格式化成 "title: text"，再用 " | " 连接；join 用于一行输出。
console.log("3. panels:", panels.value.map(({ title, text }) => `${title}: ${text}`).join(" | "));

// 4. Edit the clock plugin and apply the change: the page fetches the clock's new script only and reloads in place.
// 改写临时插件副本中的 clock/web.ts；String.replace 只替换第一处 "12:00"。
// join(root, "clock", "web.ts") 拼出插件文件路径，不会碰仓库源码。
await writeFile(
	join(root, "clock", "web.ts"),
	(await readFile(join(root, "clock", "web.ts"), "utf8")).replace("12:00", "12:01"),
);
// 插件 watcher 异步发现改动并把插件名加入 dirty；这里每 10ms 轮询一次直到出现 "@board/clock"。
// `app.plugins.state` 是只读 Watchable，`.value.dirty` 是当前待构建插件名数组。
while (!app.plugins.state.value.dirty.includes("@board/clock")) await new Promise((resolve) => setTimeout(resolve, 10));
// applyChanges 只构建 dirty 插件，并按 server → workers → surfaces 的顺序发布；返回每个步骤的结果。
const rollout = await app.applyChanges(context);
// rollout.steps 的元素至少含 name；这里打印被滚动的步骤名。
console.log("4. rolled out to:", rollout.steps.map(({ name }) => name).join(", "));
// 页面通过 WebScripts 对象获知新脚本集合，下载变化的那一个并原地 reload；轮询面板直到出现 12:01。
while (!panels.value.some(({ text }) => text === "12:01")) await new Promise((resolve) => setTimeout(resolve, 10));
console.log("   panels:", panels.value.map(({ title, text }) => `${title}: ${text}`).join(" | "));

// `--serve` 模式保留服务器与页面，打印登录链接；否则按顺序释放资源并删除临时目录。
if (process.argv.includes("--serve")) {
	console.log(`Open ${app.ownerLink()} (Ctrl-C to stop)`);
} else {
	// page.stop 关闭无头客户端宿主；app.close 关闭 HTTP、workers、宿主、store、watcher 与数据目录锁。
	await page.stop(context);
	await app.close(context);
	// recursive: true 删除整个临时目录；force: true 让目录已不存在时也不报错。
	await rm(base, { recursive: true, force: true });
}
