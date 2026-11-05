// 文件导读
// 所属：packages/chord/test/examples/40-http，Chord v2 插件组第 40 个示例，对应 slice 10（HTTP 组件）。
// 演示什么：服务器组件创建 HTTP 组件并设置监听地址；插件通过 Http 注册表贡献路由（HTML 页面、JSON、文件下载）；
// 组件负责准入、路由、认证、安全基线头和 Range；请求以 curl 风格打印。没有认证器，因此所有请求都是匿名访问，
// 路由必须显式声明 public: true。
// 上游入口：直接运行本文件；它创建 server host 与 http 组件，加载 plugins/ 下的 notes 插件，然后发起本机请求。
// 下游依赖：../../../src/context（BACKGROUND_CONTEXT）、../../../src/host（createHost）、../../../src/index.ts
// （Chord 公共 API，作为宿主包）、../../../src/node/http（createHttp）、../../../src/node/plugins（createPlugins）。
// 输出与副作用：stdout 打印每个请求的状态与 content-type、Content-Disposition（下载）和响应体；监听 127.0.0.1 的
// 临时端口，只发起本机 HTTP 请求；结尾关闭组件、宿主和 watcher。
// 失败行为：fetch 网络错误或组件关闭错误会让顶层 await 拒绝；HTTP 4xx 不会抛错，而是作为可打印的响应返回。
// 能力清单（按步骤）：
// - 第 1 步：createHost 与 createHttp（listen、onError）。
// - 第 2 步：createPlugins、load（core 里放 http.facet），等待 listening 得到实际端口。
// - 第 3 步：curl 辅助函数与六个请求，验证页面/JSON/下载/Range/404 与基线头。
// - 第 4 步：先 http.close 再 server.close，最后 plugins.close。
// 运行（从 packages/chord 目录）：
//   node --conditions=source --experimental-strip-types test/examples/40-http/main.ts
// 示例（真实签名）：
//   const http = createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);
//   await plugins.load(server, { kind: "server", core: [{ name: "chord.http", facet: http.facet }], modules }, context);
//   const { port } = await http.listening(context);
// 建议阅读顺序：先读 plugins/notes/server.ts 的三条路由，再按 1-4 步读本文件；HTTP 细节对照
// src/node/http/http.ts 的 HttpOptions/HttpComponent 与 router.ts 的 HttpContribution。

// HTTP (slice 10): a server answers HTTP requests with routes that plugins contribute. The notes plugin (`plugins/`)
// contributes a page, a JSON route and a file download; the server's own code only builds the component, says where
// Chord's own listener listens, and loads the plugins. Every answer carries the security baseline's headers.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/40-http/main.ts
// fileURLToPath 把 import.meta.url 转成本机路径，作为插件根。
import { fileURLToPath } from "node:url";
// 永不取消的根上下文；组件和宿主的所有异步操作都显式接收它。
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
// 进程内服务器宿主；它拥有 HTTP 组件 facet 与插件 facet 的生命周期。
import { createHost } from "../../../src/host/index.ts";
// Chord 公共 API 与 HTTP 组件都作为宿主包交给插件构建/求值。
import * as chord from "../../../src/index.ts";
import * as chordHttp from "../../../src/node/http/index.ts";
// 插件组件：发现、构建、加载 plugins/ 中的 server facet。
import { createPlugins } from "../../../src/node/plugins/index.ts";

// 1. A server host and its HTTP component; its settings are arguments: Chord's own listener listens on a free
//    loopback port. Nobody signs in here: no authenticator, every request is anonymous.
// principal 是本宿主代表应用自身操作时的身份，不是 HTTP 请求的身份；请求身份由认证器决定，这里没有认证器。
const server = createHost({ principal: { kind: "server" }, onError: console.error });
// createHttp 构造组件并登记 facet；此时监听器还没打开，要等 facet 被 host.load 发布。
// port 0 让系统分配空闲端口；listen 省略则不启动自有监听器，由应用挂载 http.fetch。closeTimeout 默认 30 秒。
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);

// 2. The plugins: the component's facet (its registries and the listener) goes first, then every plugin's server
//    facet. The listener opens once they are published.
// 宿主包映射：键是插件 import 的说明符，值是本进程模块实例；构建时保持 external，加载时由这里提供。
const modules = { "@earendil-works/chord": chord, "@earendil-works/chord/http": chordHttp };
// server kind 使用 Node 平台；hostPackages 只列说明符，实际模块在 load 的 modules 参数里给出。
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
// core 是应用自己的 facet：http.facet 提供 Http/Authenticators 注册表和监听器；插件 facet 追加在它后面。
// load 会先发现并构建 server 集合，再一次性发布整个集合；发布后监听器对象打开，端口开始接受连接。
await plugins.load(server, { kind: "server", core: [{ name: "chord.http", facet: http.facet }], modules }, context);
// listening 等待监听成功并返回实际地址；port 0 已由系统分配，所以这里拿到真实端口。
const { port } = await http.listening(context);

// 3. Some requests, printed like curl would.
// 辅助函数：发一个 GET 并打印状态、content-type、可选的 Content-Disposition 和 body。
// headers 默认空对象；Range 只影响这一次请求的请求头，响应体由组件按 206 处理。
async function curl(path: string, headers: Record<string, string> = {}): Promise<void> {
	// 全局 fetch（Node 内置）；URL 使用上一步拿到的端口，所有请求都发往本机回环地址。
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
	// 只在调用方提供 Range 时附加说明；其余请求打印空字符串。
	const range = headers.Range === undefined ? "" : ` (Range: ${headers.Range})`;
	console.log(`GET ${path}${range} -> ${response.status} ${response.headers.get("content-type")}`);
	// 下载响应带 Content-Disposition；普通响应为 null，此时不打印这一行。
	const download = response.headers.get("content-disposition");
	if (download !== null) console.log(`   ${download}`);
	// text() 读取完整 body（会消耗响应）；JSON 字符串本身已带引号，再 stringify 便于看出边界。
	// 页面 body 含随响应变化的 CSP nonce，正则把它替换成省略号，避免每次输出不同。
	console.log(`   ${JSON.stringify((await response.text()).replace(/nonce="[^"]+"/, 'nonce="…"'))}`);
}

// 页面路由：public 允许匿名访问，page 允许外站链接打开；body 是带 nonce 的 HTML。
await curl("/");
// JSON 路由：:name 是一个路径段的解码值，处理器把它放进 { note }。
await curl("/notes/hello");
// 文件下载：Range: bytes=0-6 请求前 7 字节，期望 206 与 Content-Disposition: attachment。
await curl("/notes/hello/download", { Range: "bytes=0-6" });
// 不存在的文件：fileResponse 返回 404（HttpFailure），组件把它回答成 404 文本。
await curl("/notes/nope/download");
// 未注册路径：路由器没有匹配，组件回答 404。
await curl("/nowhere");
// 再发一次普通请求读取安全基线头；这些头由组件默认添加，路由可以覆盖同名头。
const baseline = await fetch(`http://127.0.0.1:${port}/notes/hello`);
for (const name of ["cache-control", "x-content-type-options", "x-frame-options"]) {
	console.log(`   ${name}: ${baseline.headers.get(name)}`);
}

// 4. Close the component first: it refuses new requests and waits for running ones (the host's close would seal them
//    at once). Then the host.
// http.close 停止接收并拒绝新请求（503），关闭套接字和链接，等待运行中的请求最多 closeTimeout，然后封口作用域。
// 它不关闭 facet 的监听器对象；host.close 时监听器的 close 也会调用组件 close，但那时已来不及排空请求。
await http.close(context);
// 宿主关闭会结束剩余对象；HTTP 组件已在前面排空请求，所以顺序不能反。
await server.close(context);
// 最后停止 watcher；它不卸载已经关闭的宿主。
plugins.close();
