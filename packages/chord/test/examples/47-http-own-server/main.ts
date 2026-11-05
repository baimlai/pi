/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/47-http-own-server，Chord v2 的 HTTP 示例（slice 10）。
 * 演示什么：HTTP 组件可以不启动 Chord 自己的监听器。createHttp 省略 listen 后只提供 Web 标准的 fetch 处理器
 * 和 Node 升级适配器；应用把它挂到自己的 Node server 上，仍然得到同一套路由、准入检查和默认安全头。
 * 上游/下游：main.ts 创建宿主、HTTP 组件和插件组件，加载 chord.http 与 plugins/notes；notes 插件贡献 GET /notes。
 * 示例用 Node 的 createServer 建服务器，并用 http.request/fetch 只访问 127.0.0.1 的临时端口。
 * 能力清单：
 * - nodeRequest(message, res)：把 Node 请求转成 Web Request + Connection，或返回带状态的拒绝（400/403/501）；
 * - http.fetch(request, connection)：返回 Web Response，响应头可逐行读取；
 * - http.upgrade：可直接挂到 server.on("upgrade")；
 * - 第 4 段用 TRACE 和带 userinfo 的 Host 展示转换阶段的线上拒绝，应用服务器随后仍继续工作。
 * 典型运行顺序：创建无监听器的组件 -> 加载插件 -> 建自己的 Node server -> 发起正常/404/非法请求 -> 依次关闭。
 * 示例（真实签名）：
 *   const converted = chordHttp.nodeRequest(message, res);
 *   if (converted.kind === "request") {
 *     const response = await http.fetch(converted.request, converted.connection);
 *   }
 * 建议阅读顺序：先看 createHttp 省略 listen 的写法，再看自己的 request 处理函数如何转换/写回，最后看拒绝示例。
 * 前置条件与运行方式：从 packages/chord 执行
 *   node --conditions=source --experimental-strip-types test/examples/47-http-own-server/main.ts
 * 预期输出（端口随机）：GET /notes -> 200 且 x-content-type-options: nosniff；GET /nowhere -> 404；
 * TRACE -> 501；Host 含 userinfo -> 403。示例没有断言，失败会以异常或非预期输出暴露。
 */
// Your own server (slice 10): the HTTP component is a Web-standard `fetch` handler, so an app with a server of its own
// mounts it instead of Chord's listener. Here a plain Node server converts every request with `nodeRequest` (the
// listener's checks: a malformed target refused, a second `Host` kept for admission to refuse; and the connection:
// loopback requests count as local only with it), passes it to `http.fetch`, and every upgrade to `http.upgrade`.
// With Hono the same is one line: `app.all("/*", (c) => http.fetch(c.req.raw, connection))`.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/47-http-own-server/main.ts
// createServer 建应用自己的 Node 服务器；request 用于在后面的步骤里发原始 HTTP 请求（能表达 fetch 不允许的方法/头）。
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { createHost } from "../../../src/host/index.ts";
// 命名空间导入：chord 与 chordHttp 同时作为插件求值时的宿主包实例。
import * as chord from "../../../src/index.ts";
import * as chordHttp from "../../../src/node/http/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";

// 1. The component, without a listener: no `listen` setting.
// 注意 createHttp 的第二个参数没有 listen：组件不打开端口，也不创建监听器对象；只提供 fetch/upgrade/facet。
const server = createHost({ principal: { kind: "server" }, onError: console.error });
const http = chordHttp.createHttp(server, { onError: console.error }, context);
// 宿主包表：插件 import 的两个说明符都解析到本进程的模块实例。
const modules = { "@earendil-works/chord": chord, "@earendil-works/chord/http": chordHttp };
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
// 只加载 chord.http facet 和 notes 插件；因为没有 listen，宿主上不会有监听器对象。
await plugins.load(server, { kind: "server", core: [{ name: "chord.http", facet: http.facet }], modules }, context);

// 2. The app's own server: a Web `Request` in, a Web `Response` out (each header line kept: several `Set-Cookie`). A
//    real app adds its own routes around it.
// 处理函数是 async：先转换请求，再把 fetch 的 Response 写回 Node 的 ServerResponse。
// message/res 的类型由 Node 的 createServer 重载推断，不需要手写 IncomingMessage/ServerResponse。
const own = createServer(async (message, res) => {
	// nodeRequest 返回可辨识联合：{kind:"request", request, connection} 或 {kind:"refused", status}。
	// 它在信任边界上做与 Chord 监听器相同的检查，绝不抛错。
	const converted = chordHttp.nodeRequest(message, res);
	// 收窄为 refused 后 status 的类型是 400 | 403 | 501；void 表示不使用 writeHead().end() 的返回值。
	if (converted.kind === "refused") return void res.writeHead(converted.status).end();
	// connection 提供 localAddress/localPort；缺少它们时组件不会把请求当作 local。fetch 永不抛错。
	const response = await http.fetch(converted.request, converted.connection);
	// Headers 是可迭代对象，每项是 [name, value] 元组；appendHeader 保留重复头（例如多条 Set-Cookie）。
	for (const [name, value] of response.headers) res.appendHeader(name, value);
	// 响应体先读成 ArrayBuffer 再转 Buffer，一次性写出；真实应用可以改成流式管道。
	res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
});
// upgrade 的签名与 Node 的 "upgrade" 事件监听器一致；WebSocket 链接和插件套接字都走这里。
own.on("upgrade", http.upgrade);
// listen 是回调式 API；用 Promise<void> 等它真正绑定后再取地址。port: 0 由系统分配。
await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
const address = own.address();
// address() 的返回类型是 string | AddressInfo | null：只有对象分支才有 port；三元表达式在这里做运行时收窄。
const port = typeof address === "object" && address !== null ? address.port : 0;

// 3. Requests through the app's server get the same routes, checks and headers.
// 用全局 fetch 发普通 GET：/notes 命中插件路由；/nowhere 没有路由，得到 404，但仍带组件默认安全头。
for (const path of ["/notes", "/nowhere"]) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	// response.text() 是异步的，必须 await；模板字符串把状态码和响应体拼成一行。
	console.log(`GET ${path} -> ${response.status} ${await response.text()}`);
	console.log(`   x-content-type-options: ${response.headers.get("x-content-type-options")}`);
}

// 4. What a Web `Request` cannot carry is refused at the conversion, as Chord's listener refuses it; the app's server
//    lives on (`TRACE`: 501; a `Host` with userinfo: 403).
// 外层数组的 as const 让每个元素是只读元组，解构出的 method 保留字面量联合 "TRACE" | "GET"；
// host 仍推断为 string，因为模板表达式含运行时得到的 port。as const 不是运行时检查，只影响类型推断。
for (const [method, host] of [
	["TRACE", `127.0.0.1:${port}`],
	["GET", `attacker@127.0.0.1:${port}`],
] as const) {
	// Promise<number | undefined> 对应 Node 的 statusCode 类型；这里的 undefined 只可能出现在异常情况下。
	const status = await new Promise<number | undefined>((resolve) => {
		request({ host: "127.0.0.1", port, method, path: "/notes", headers: { host } }, (response) => {
			// resume() 丢弃未读响应体并让流继续，避免连接挂起；随后立即 resolve 状态码。
			response.resume();
			resolve(response.statusCode);
		}).end();
	});
	console.log(`${method} /notes (Host: ${host}) -> ${status}`);
}

// 5. The app closes its server and the component (it refuses, then waits for running requests), then the host.
// 先停止应用自己的 server（不再接受连接），再关闭 HTTP 组件和宿主；组件的 close 应在 host.close 之前调用。
await new Promise((resolve) => own.close(resolve));
await http.close(context);
await server.close(context);
plugins.close();
