/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/48-http-baseline，Chord v2 的 HTTP 示例（slice 10 的安全基线）。
 * 演示什么：HTTP 组件的准入、来源检查、认证与默认拒绝如何配合。应用只负责“谁是谁”（签名 cookie），
 * 其余规则由组件强制执行：浏览器跨站发起的请求不会被认证；外来 Origin 被 403；指向 page 路由的顶层导航
 * 仍可带着登录态打开；crossSite 的 webhook 总是匿名运行。
 * 上游/下游：main.ts 创建宿主、HTTP 组件和插件组件，加载 chord.http、应用自己的认证 facet 和 plugins/notes。
 * 请求用 Node 的 http.request 手工设置 Cookie 与 Fetch Metadata 头，只访问 127.0.0.1 的临时端口。
 * 能力清单：
 * - app facet：POST /sign-in 用 cookie() 签出 Set-Cookie；Authenticators 用 readCookie() 还原 principal；
 * - browser(label, method, path, headers, body)：带 cookie 发送请求并打印状态码与响应体；
 * - 七步对比：同站读取/写入、跨站 Origin、跨站无 Origin、顶层导航、跨站 webhook。
 * 典型运行顺序：登录拿到 cookie -> 同站请求带认证 -> 跨站请求被拒/匿名 -> 关闭组件与宿主。
 * 示例（真实签名）：
 *   const set = chordHttp.cookie("user", "ada", { secret, request, sameSite: "Lax" });
 *   const name = chordHttp.readCookie(request, "user", secret); // 验签失败或过期时返回 undefined
 * 建议阅读顺序：先看 app facet 的登录与认证器，再看 browser 辅助函数，最后按 2-7 步对照请求头理解判定结果。
 * 前置条件与运行方式：从 packages/chord 执行
 *   node --conditions=source --experimental-strip-types test/examples/48-http-baseline/main.ts
 * 预期输出（cookie 与端口随机）：2. 200；3. 200 且列表新增 "call mom"；4. 403 Forbidden；
 * 5. 401 Unauthorized；6. 200 且页面显示 ada；7. 200 "anonymous"。示例没有断言。
 */
// The security baseline (slice 10): on by default, the app decides only who someone is. Here the app signs people in
// with a signed cookie (`cookie`, `readCookie`) and the notes plugin contributes a page, routes and a webhook. Requests
// another site's page makes in a browser (Fetch Metadata says so) are never authenticated (so a route not marked
// public answers them 401: deny by default, slice 13), a foreign `Origin` is refused, but a link to a page still opens
// it signed in, and a cross-site webhook runs anonymous.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/48-http-baseline/main.ts
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../src/host/index.ts";
import * as chord from "../../../src/index.ts";
import * as chordHttp from "../../../src/node/http/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";

// 应用自己的 principal 类型：可辨识联合用 kind 区分服务器自身和已登录用户。
// 这些 readonly 字段只是编译期约束；网络输入仍需由认证器解析并构造出这个形状。
type Principal = { readonly kind: "server" } | { readonly kind: "user"; readonly name: string };
// 签名密钥：真实应用要从安全配置读取并保密；示例固定成字符串只为让输出可复现。
const secret = "a long random secret";
// createHost<Principal> 固定宿主的身份类型，后面的 defineFacet<Principal> 必须与它一致。
const server = createHost<Principal>({ principal: { kind: "server" }, onError: console.error });
// 启动 Chord 自己的监听器；port: 0 由系统分配，稍后 listening() 返回真实端口。
const http = chordHttp.createHttp(server, { listen: { host: "127.0.0.1", port: 0 }, onError: console.error }, context);

// 1. The app's core facet: a sign-in route setting the cookie, and an authenticator reading it back.
// 应用 core facet：只声明“如何登录”和“如何从请求认出用户”，不实现安全基线的其他规则。
const app = defineFacet<Principal>((_host, self) => {
	// 登录路由必须 public，因为此时用户还没有 principal。handler 返回 json 描述，并用 headers 附上 Set-Cookie。
	self.contribute(chordHttp.Http, {
		routes: {
			"POST /sign-in": {
				public: true,
				handler: async (request) => {
					// request.json() 读取并 JSON.parse 请求体（默认上限 1 MiB）；示例发送的是 JSON 字符串 "ada"。
					// String(...) 把解析结果转成文本；cookie() 对 值+到期时间 做 HMAC 签名，返回完整 Set-Cookie 文本。
					// sameSite: "Lax" 允许其他站点发起的顶层 GET 导航携带该 cookie（第 6 步依赖这一点）。
					const set = chordHttp.cookie("user", String(await request.json()), { secret, request, sameSite: "Lax" });
					// headers 的值可以是字符串或字符串数组；这里只有一个 Set-Cookie。
					return { kind: "json", value: "signed in", headers: { "Set-Cookie": set } };
				},
			},
		},
	});
	// Authenticators 按贡献顺序依次询问；返回 undefined 表示“我没认出”，继续下一个认证器。
	// readCookie 在签名不符、格式错误或签名到期时间已过时返回 undefined，不会抛错。
	self.contribute(chordHttp.Authenticators, (request) => {
		const name = chordHttp.readCookie(request, "user", secret);
		// 三元表达式完成收窄：不是 undefined 时构造 user 形状的 principal。
		return name === undefined ? undefined : { kind: "user", name };
	});
});
// 宿主包表：notes 插件按这两个说明符 import，拿到的是本进程同一份模块实例。
const modules = { "@earendil-works/chord": chord, "@earendil-works/chord/http": chordHttp };
const plugins = createPlugins(
	{
		roots: [fileURLToPath(new URL("./plugins/", import.meta.url))],
		kinds: { server: { platform: "node", hostPackages: Object.keys(modules) } },
		onError: console.error,
	},
	context,
);
// core 是按顺序加载的应用 facet：HTTP 组件先服务 Http/Authenticators，应用 facet 再向这两个注册表贡献。
const core = [
	{ name: "chord.http", facet: http.facet },
	{ name: "@example/app", facet: app },
];
await plugins.load(server, { kind: "server", core, modules }, context);
// 监听器绑定后取实际端口；base 是本机请求的规范 origin。
const { port } = await http.listening(context);
const base = `http://127.0.0.1:${port}`;

// 2. Ada signs in; her browser keeps the cookie.
// 请求体是 JSON 文本 "ada"（包含引号），因此服务端 json() 得到字符串 ada。全局 fetch 会像浏览器一样
// 自行补充 Fetch Metadata 头；登录路由是 public，未认证也能进入。
const signIn = await fetch(`${base}/sign-in`, { method: "POST", body: '"ada"' });
// get("set-cookie") 的类型是 string | null；! 是非空断言，只影响类型检查，运行时若为 null 会在 split 处抛错。
// 取分号前的 name=value 部分，丢掉 Path/SameSite 等属性，作为后续请求的 Cookie 头。
const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
// 只打印前缀，避免把完整签名写满屏幕；slice 不改变字符串本身。
console.log(`1. signed in: ${cookie.slice(0, 12)}…`);

// 用途：模拟 Ada 浏览器发请求，附带登录 cookie 和调用方指定的 Fetch Metadata/Origin 头。
// 输入：label 用于打印；method/path；headers 默认空对象；body 默认空串。输出：Promise<void>，只打印状态码与响应体。
// 例子：await browser("x", "GET", "/notes", { "sec-fetch-site": "cross-site" }) 得到 401 Unauthorized。
/** A request from Ada's browser: her cookie, and what Fetch Metadata says about who made it (`fetch` sets its own). */
async function browser(label: string, method: string, path: string, headers: Record<string, string> = {}, body = "") {
	// Promise<string> 包装回调式 request；headers 对象用展开语法先放 cookie，再让 headers 覆盖同名键。
	const answer = await new Promise<string>((resolve) => {
		const sent = request({ host: "127.0.0.1", port, method, path, headers: { cookie, ...headers } }, (response) => {
			let text = "";
			// 响应体分块到达；chunk 是 Buffer，+= 隐式转字符串。
			response.on("data", (chunk) => {
				text += chunk;
			});
			// 结束事件把状态码和完整 body 拼成一行并 resolve。
			response.on("end", () => resolve(`${response.statusCode} ${text}`));
		});
		// body 是字符串时 Node 按 UTF-8 发送；即使为空也要 end() 才发出请求。
		sent.end(body);
	});
	console.log(`${label}: ${answer}`);
}

// 同站请求：Fetch Metadata 声明 same-origin，Origin 与服务端算出的规范来源一致。
const ours = { "sec-fetch-site": "same-origin", origin: base };
// 跨站请求：浏览器会把 Origin 设成攻击者站点；没有 Sec-Fetch-* 的客户端则可能只带其中一个头。
const evil = { "sec-fetch-site": "cross-site", origin: "https://evil.example" };
// 2. 同站读取：认证器看到 cookie 并给出 user principal，GET /notes 正常返回。
await browser("2. our page reads the notes", "GET", "/notes", ours);
// 3. 同站写入：POST /notes 不在 SAFE 方法集合中，Origin 必须存在且匹配；认证通过后 handler 修改模块内数组。
await browser("3. our page adds a note", "POST", "/notes", ours, '"call mom"');
// 4. 跨站写：Origin 是 evil.example，与准入得到的 http://127.0.0.1:<port> 不同；Origin 检查在认证前返回 403，
//    handler 完全没有运行，所以数组不会加入 "pwned"。
await browser("4. evil.example posts a note", "POST", "/notes", evil, '"pwned"');
// 5. 跨站读：只带 Sec-Fetch-Site: cross-site，没有 Origin。GET 的安全方法检查通过，但外来请求不会被认证，
//    /notes 又没有 public/page 选项，于是默认拒绝 401。
await browser("5. evil.example reads the notes", "GET", "/notes", { "sec-fetch-site": "cross-site" });
// 顶层导航头：GET + navigate + document（或空 dest，兼容从已安装应用启动）才算“用户点了链接”，
// 这组条件由 isNavigation 判断。
const link = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
// 6. 到 page 路由的顶层导航例外：仍运行认证器，因此带着 cookie 打开页面时 principal 是 ada。
await browser("6. a link on evil.example to the page", "GET", "/", link);
// 7. crossSite 路由跳过 Origin 检查且永远匿名（不运行认证器）；它是 webhook 场景，因此不需要 cookie。
await browser("7. a build server's webhook", "POST", "/hooks/build", { origin: "https://ci.example" });

// 与 47 相同：先关 HTTP（拒绝新请求、排空运行中的请求），再关宿主，最后停止插件 watcher。
await http.close(context);
await server.close(context);
plugins.close();
