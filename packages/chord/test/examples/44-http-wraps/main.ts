// Wraps (slice 10): plugins wrap routes, their own or everyone's, in phases (`observe`, `headers`, `transform`,
// outermost first). Here the notes plugin wraps its own route to add a header, and an audit plugin wraps every route
// to log it; the audit plugin needs no route of its own.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/44-http-wraps/main.ts
// 文件导读
// 所属：packages/chord/test/examples/44-http-wraps，Chord slice 10 的 HTTP wraps 示例。
// 演示什么：两个插件通过 Http 注册表贡献包装器。notes 插件有路由 GET /notes，并用自己的 wrap（默认 scope
//   "own"）给响应加 Cache-Control；audit 插件没有任何路由，只有 scope "all" 的 wrap，包住所有匹配到的路由并
//   打印日志。没有匹配路由的请求（/missing）不会运行任何 wrap，只得到默认头。
// 上游/下游：由下一行命令启动；上游是 Node 的 fetch 客户端与 localhost 监听；下游调用 createHttp（HTTP 组件、
//   注册表 Http、默认响应头）、createPlugins（构建/求值插件）、createHost。脚本只发起本机 HTTP 请求，不写文件。
//   组件错误经 createHttp 的 onError 打印；插件构建错误经 createPlugins 的 onError 打印。
// 能力清单（按演示步骤）：
// - createHttp：listen 127.0.0.1:0（系统分配端口），onError 打印 HttpError。
// - modules：插件 import 说明符到本进程模块实例的映射，同时用于构建时的 external 列表。
// - createPlugins/load：把 chord.http facet 作为 core facet 加载，再加载两个插件。
// - http.listening：等待监听并返回实际端口。
// - fetch：请求 /notes（有路由、有 wrap）与 /missing（无路由、无 wrap）。
// 典型运行顺序：创建宿主与 HTTP 组件 -> 创建并加载插件 -> 等监听 -> 依次 GET 两个路径 -> 关闭 http、宿主、
//   watcher。
// 预期输出（示例，本机运行形状）：
//   GET /notes
//      audit: anonymous GET /notes 200
//      -> 200, Cache-Control: max-age=60
//   GET /missing
//      -> 404, Cache-Control: no-store
// 解读：/notes 的路由是 public，匿名可访问；audit 的 observe wrap 在最外层，next 返回后打印状态 200；
//   notes 的 headers wrap 把默认 Cache-Control: no-store 覆盖为 max-age=60。/missing 没有路由，不运行 wrap，
//   因此没有 audit 日志，且保留默认 no-store。
// 建议阅读顺序：先读 plugins/notes/server.ts（路由与自有 wrap），再读 plugins/audit/server.ts（全局 wrap），
//   最后回到本文件的装配与两个请求；wrap 的阶段与顺序见 docs/design.md §23。
import { fileURLToPath } from "node:url";
// 把 ./plugins 的 file: URL 转成 createPlugins 需要的路径字符串。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 永不取消的根 Context，作为组件与请求作用域的父上下文。
import { createHost } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
// Chord 包实例；插件构建时 "@earendil-works/chord" 保持外部，求值时从这个映射取。
import * as chordHttp from "../../../src/node/http/index.ts";
// HTTP 子模块（Node-only）：createHttp、Http 注册表、Authenticators 等。插件 import 的
// "@earendil-works/chord/http" 也映射到它。
import { createPlugins } from "../../../src/node/plugins/index.ts";

// 没有 address 的宿主：这个示例只需要一个宿主承载 HTTP 组件与请求作用域，不需要被路由或存储标识。
// principal 用于本机直接发起的操作；HTTP 请求的身份来自 Authenticators（本示例没有认证器，匿名）。
const server = createHost({ principal: { kind: "server" }, onError: console.error });
// createHttp 的设置在其生命周期内固定（改变要重启组件）：listen 指定自有 Node 监听器，port 0 让系统选端口；
// onError 接收 HttpError（route_failed/wrap_failed/socket_failed/response_failed/hook_failed）。
// 监听器是宿主生命周期对象，在宿主 load 发布之后打开。
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);
// modules 的两个用途：kinds 里 hostPackages 用 Object.keys(modules) 声明构建时保持外部的说明符；
// load 的 modules 参数把这些说明符映射到本进程的模块对象，供插件求值时 import。
const modules = { "@earendil-works/chord": chord, "@earendil-works/chord/http": chordHttp };
// 只声明 server 一种 facet；roots 下每个插件目录的 server.ts 会被发现和构建。
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
// core facet 是应用自己的 facet，与插件一起加载。名字 "chord.http" 是组件的插件名（用于报告）；
// http.facet 服务 Http 与 Authenticators 注册表，并（因为设置了 listen）服务监听器。load 之后两个插件
// 贡献的 routes/wraps 才可组合；请求在 load 之前会得到 503。
await plugins.load(server, { kind: "server", core: [{ name: "chord.http", facet: http.facet }], modules }, context);
// listening() 在监听成功后 resolve，返回实际地址；解构只取 port。
const { port } = await http.listening(context);

// 依次请求两个路径。Node 的 fetch 会自动设置正确的 Host 头；127.0.0.1 与端口构成回环本地来源。
for (const path of ["/notes", "/missing"]) {
	console.log(`GET ${path}`);
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	// Headers.get 返回 string | null；这里两个响应都设置了 Cache-Control，所以打印实际值。
	console.log(`   -> ${response.status}, Cache-Control: ${response.headers.get("cache-control")}`);
}
// The 404 has no route, so no wrap ran for it: the audit log shows only /notes, and it keeps the default
// `Cache-Control: no-store` that the notes wrap replaced on its own route.

// 关闭顺序很重要：先 http.close（拒绝新请求/升级，关闭套接字与链接，等待进行中的请求到 closeTimeout，
// 然后封口作用域），再 server.close。反过来的话，host.close 会立刻封口所有请求作用域，来不及排空。
// plugins.close 是同步的，最后停止文件监视器。
await http.close(context);
await server.close(context);
plugins.close();
