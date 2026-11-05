// A plugin socket (slice 10): a plugin contributes a WebSocket endpoint for its own protocol (a terminal, voice). The
// server checks the origin and authenticates first: without a principal the upgrade is refused before plugin code.
// Here the app's authenticator reads a principal from a header (a real app: a signed cookie, `readCookie`).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/45-plugin-socket/main.ts
// 文件导读
// 所属：packages/chord/test/examples/45-plugin-socket，Chord slice 10 的插件套接字示例。
// 演示什么：应用贡献一个认证器，插件贡献一个 WebSocket 端点 /echo/:room。服务器在升级阶段先做准入、Origin
//   检查与认证；没有 principal 的连接在插件代码运行前就得到 401。有身份时，ws 套接字被交给插件处理器，
//   处理器发送欢迎消息并回显收到的文本。最后演示 http.close 以 1001（going away）关闭套接字。
// 上游/下游：上游是 Node 的 ws 客户端与 localhost 监听；下游是 createHttp（升级步骤、Authenticators 注册表、
//   Upgrades）、defineFacet（应用认证器）、createPlugins/createHost。脚本只连本机，不写文件。
// 能力清单（按演示步骤）：
// - createHost<Principal>：宿主 principal 类型；没有 address，只承载组件与请求作用域。
// - Authenticators：core facet @example/app 贡献的认证函数，从 x-user 头读身份。
// - sockets：插件 @example/echo 贡献的 "/echo/:room"；不带 public，默认拒绝匿名。
// - http.close：拒绝新升级，关闭现有套接字（1001），等待到 closeTimeout；随后 server.close、plugins.close。
// 典型运行顺序：创建宿主与 Http -> 声明应用 facet -> 创建并加载插件（core 在前）-> 等监听 -> 匿名连接被拒
//   -> 带 x-user 连接、收欢迎语与回显 -> 关闭组件观察 1001 -> 关闭宿主与插件。
// 预期输出（示例，本机运行形状）：
//   1. anonymous: refused 401
//   2. welcome to lobby, {"kind":"user","name":"ada"}
//   2. echo: hello
//   3. closed with 1001
// 解读：401 发生在插件处理器之前（http.ts 的升级步骤对非 public 套接字拒绝匿名）；欢迎语里的 JSON 是
//   ctx.principal，即认证器返回的对象；1001 是组件关闭时发送的状态码，reason 为 going away。
// 对应测试/文档：packages/chord/test/node/http/upgrades.test.ts 的 "plugin sockets" 与 "close" 分组；
//   docs/slice-10.md、docs/design.md §23（套接字与认证顺序）。
// 建议阅读顺序：先读 plugins/echo/server.ts 的处理器，再回到本文件的认证器与连接步骤，最后看关闭顺序。
import { once } from "node:events";
// once(emitter, name) 返回 Promise，监听一次事件后 resolve 为该事件的参数数组；这里用于 open、close 与
// unexpected-response。它不会为事件设置超时，示例依赖本机连接很快完成。
import { fileURLToPath } from "node:url";
// 把 ./plugins 的 file: URL 转成 createPlugins 需要的路径字符串。
import { WebSocket } from "ws";
// ws 的客户端；服务端由 Http 组件基于同一个 ws 库建立，插件处理器拿到的是服务端套接字。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 永不取消的根 Context，作为组件和请求作用域的父上下文。
import { createHost, defineFacet } from "../../../src/host/index.ts";
// defineFacet 在应用侧声明 core facet：这里只贡献认证器，不在插件目录里。
import * as chord from "../../../src/index.ts";
// Chord 包实例；插件构建时 "@earendil-works/chord" 保持外部，求值时从这个映射取。
import * as chordHttp from "../../../src/node/http/index.ts";
// HTTP 子模块实例（Node-only）；插件 import 的 "@earendil-works/chord/http" 映射到它。
import { createPlugins } from "../../../src/node/plugins/index.ts";

// Principal 是应用自己的身份联合：本机操作用 kind "server"，HTTP 用户用 kind "user"。
// 它只在编译期约束 createHost/defineFacet 的泛型参数；运行时 Chord 不校验 principal 的字段，认证器返回什么
// 对象，请求作用域里就是什么对象。
type Principal = { readonly kind: "server" } | { readonly kind: "user"; readonly name: string };
// 没有 address 的宿主：本示例不需要被路由或存储标识。principal 是本机直接发起操作时使用的身份；
// 来自 HTTP 的请求由 Authenticators 决定身份，不使用这个默认值。
const server = createHost<Principal>({ principal: { kind: "server" }, onError: console.error });
// listen 打开组件自有的 Node 监听器（port 0 让系统分配）；onError 接收 HttpError，其中与本示例相关的
// socket_failed 表示处理器抛错（随后套接字以 1011 关闭）。
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);
// The app's core facet: who someone is.
// 应用自己的 core facet：它不来自插件目录，而是在 load 时与 chord.http 一起加载。泛型 Principal 让这个
// facet 在编译期看到应用的宿主身份类型。
const app = defineFacet<Principal>((_host, self) => {
	// 往 Authenticators 注册表贡献一个认证函数。注册表值是“认证函数”本身，插件名由贡献上下文记录；
	// 多个认证器按贡献顺序询问，第一个返回非 undefined 的身份获胜，抛错的会被报告并跳过。
	self.contribute(chordHttp.Authenticators, (request) => {
		// Headers.get 返回 string | null，头名大小写不敏感。真实应用会校验签名 cookie（见 readCookie），
		// 这里为让示例自包含只读一个普通头。
		const name = request.headers.get("x-user");
		// 没有该头：返回 undefined，表示“这个认证器不认识”，请求保持匿名，是否放行交给路由/套接字的 public 规则。
		// 有该头：返回一个 Principal 形状的对象（kind 加 JSON 字段）。返回类型是包内的 Principal，而不是上面的
		// 联合；应用联合只用于本机宿主操作的编译期约束。
		return name === null ? undefined : { kind: "user", name };
	});
});
// 两个用途：kinds 的 hostPackages 用 Object.keys(modules) 声明构建时保持外部的说明符；load 的 modules 参数
// 把这些说明符映射到本进程的模块对象，供插件求值时 import。
const modules = { "@earendil-works/chord": chord, "@earendil-works/chord/http": chordHttp };
// 只声明 server 一种 facet；roots 下每个插件目录的 server.ts 会被发现、构建与求值。
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
// core facets 按数组顺序先于插件 facet 加载。chord.http 服务 Http/Authenticators 注册表与监听器；
// @example/app 贡献认证器。两个名字都用于报告，不参与路由。
const core = [
	{ name: "chord.http", facet: http.facet },
	{ name: "@example/app", facet: app },
];
// load 组合 core 与插件贡献；之后插件套接字才可路由。load 之前到达的请求会得到 503。
await plugins.load(server, { kind: "server", core, modules }, context);
// listening() 在监听成功后 resolve 并返回实际地址；这里只取端口用于拼 URL。
const { port } = await http.listening(context);

// 1. Without a principal: refused (401), the plugin never sees it.
// 不带 x-user 时认证器返回 undefined。套接字处理器没有声明 public，服务器在运行插件代码之前就拒绝：
// 升级步骤按 closing(503) -> 转换(400/403/501) -> 注册表(503) -> 准入(403) -> Origin(403) -> 认证 -> 路由
// 复核(403) -> links/socket 的顺序执行，非 public 且无 principal 在这一步返回 401。
// 注意：设计文档 §23 曾写过 403，实际代码（http.ts 升级步骤）与该示例运行结果都是 401，以代码为准。
const refused = new WebSocket(`ws://127.0.0.1:${port}/echo/lobby`);
// 握手得到 HTTP 错误响应时，ws 不触发 open，而是触发 "unexpected-response" 事件，参数是 [request, response]；
// once 只等这一次，因此不会留下未处理的 'error' 事件。
const [, response] = await once(refused, "unexpected-response");
// statusCode 类型是 number | undefined，这里由服务器写入，实际为 401。
console.log(`1. anonymous: refused ${response.statusCode}`);

// 2. As ada: the plugin's handler greets, then echoes.
// 第二个参数给握手请求附加头；认证器读到 x-user: ada，返回 { kind: "user", name: "ada" }，它成为该套接字的
// principal。非浏览器客户端可以不带 Origin；若带了 Origin，就必须与准入来源一致，否则 403。
const socket = new WebSocket(`ws://127.0.0.1:${port}/echo/lobby`, { headers: { "x-user": "ada" } });
// 显式标注元素类型：ws 的 message 事件默认给 Buffer，String(buffer) 按 UTF-8 解码成文本。
const messages: string[] = [];
// 监听器在套接字生命周期内保持注册；收到的欢迎语与回显都进同一个数组，顺序即发送顺序。
socket.on("message", (data) => messages.push(String(data)));
// 等握手完成后再发送，避免在 CONNECTING 状态调用 send 抛错。
await once(socket, "open");
// 发一条文本；插件的 message 监听器会回显。
socket.send("hello");
// The greeting and the echo.
// 事件是异步的：用 10 ms 的定时器轮询，直到两条消息都到齐。Promise 没有类型参数，TypeScript 推断为
// Promise<unknown>；await unknown 合法。示例没有超时，连接异常时会一直等待（测试里应使用 waitUntil 之类）。
while (messages.length < 2) {
	await new Promise((resolve) => setTimeout(resolve, 10));
}
// 欢迎语由插件处理器在升级时同步发送，内容包含 room 与 principal 的 JSON；第二条是 echo: hello。
for (const message of messages) console.log(`2. ${message}`);

// 3. Closing the component closes its sockets (1001, going away); then the host.
// 先注册 close 监听，再关闭组件，避免错过事件；once 的返回值是 [code, reason]。
const closed = once(socket, "close");
// http.close 必须早于 server.close：它拒绝新请求/升级，以 1001 going away 关闭套接字与链接，等待进行中的
// 请求到 closeTimeout，然后封口请求作用域。反过来先关宿主会立刻封口作用域，来不及排空。
await http.close(context);
// 再关闭宿主生命周期。
await server.close(context);
// 解构只取关闭码；reason（"going away"）被忽略。
const [code] = await closed;
console.log(`3. closed with ${code}`);
// plugins.close 是同步的：停止文件监视器，放在最后。
plugins.close();
