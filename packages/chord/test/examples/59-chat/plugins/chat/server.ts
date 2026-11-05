// 文件导读
// 所属：packages/chord/test/examples/59-chat/plugins/chat，聊天插件的服务器 facet（目录插件）。
// 同目录 package.json 是插件清单：`name`（@chat/chat）是插件身份，`private: true` 防止误发布，
// `type: "module"` 指定 ESM；同一目录下的 server.ts 与 worker.ts 按文件名作为不同 kinds 的 facet。
// 清单由 app kit 的插件发现/构建器读取。
// 作用：
//   - 在服务器上提供 Channels 远程对象（频道名列表，用 constant 包装成只读 Watchable）；
//   - 贡献 HTTP 路由：
//       GET /                      公开的选名登录页（内联脚本 POST /_chord/login，成功后跳 /chat）；
//       GET /files/:channel/:id    以当前登录用户身份取得频道 Room，读取附件元数据并以 bytes 流式返回。
// 上游：服务器插件加载器按 kind "server" 构建并执行本文件的 setup。
// 下游：@chat/app/v1 的 Channels/Room/constant、@chat/app/v1/server 的 Http、worker 中的 Room 与
// Files。副作用：只声明对象与路由；真正的网络 I/O 在请求到达时发生。
// 能力清单：
// - `CHANNELS` 常量（general、random）；
// - `signIn` 登录页 HTML；
// - 默认导出的 facet：serve Channels + contribute Http。
// 典型行为：浏览器访问 / 看到登录表单；加入后跳转 /chat；附件 URL 由页面拼成 /files/<channel>/<id>。
// 示例：GET / 返回登录页；POST /_chord/login 后跳 /chat；GET /files/general/<id> 以当前用户读取附件。
// 阅读顺序：先看 CHANNELS 与 signIn，再看默认导出的 serve/路由。
// 运行方式：随 startChat 的服务器插件加载；不单独执行。
// 安全说明：登录路由必须 public（尚无会话）；文件路由默认需要认证，ctx 是该请求的 principal 作用域，
// 因此 worker 的 authorize 和 Room 的每用户视图都会生效。未知/越权附件统一返回 404，避免泄露存在性。

// The chat plugin on the server: the channel list, the sign-in page (pick a name: the kit's ephemeral login), and the
// attachments' URLs (`/files/<channel>/<id>`), read from the channel's room as the signed-in user.

import { BACKGROUND_CONTEXT, Channels, constant, defineFacet, Room } from "@chat/app/v1";
import { Http } from "@chat/app/v1/server";

// 频道名同时作为 Channel 地址的 id；每个频道在首次被持有时 fork 一个 worker。
/** The chat's channels: two, each its own worker. */
const CHANNELS = ["general", "random"];

// 注意：模板字符串内部是浏览器代码，注释不能插进去（会改变 HTML/JS 或破坏格式）。
// 这里的关键点：
// - nonce 由 HTTP 组件为每个响应生成，并写进 CSP；内联脚本必须带同一 nonce 才能执行；
// - 表单提交被 preventDefault 拦截，改为 fetch JSON；
// - /_chord/login 是公开路由，成功（2xx）后跳转到 /chat；
// - FormData.get 的返回值可能不是字符串，但 JSON.stringify 会按实际值发送，服务器会做运行时校验。
/** The sign-in page: a name, posted to the kit's login, then the chat. */
const signIn = (
	nonce: string,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat</title></head>
<body><form id="login"><input name="name" placeholder="Pick a name" autofocus required> <button>Join</button></form>
<script nonce="${nonce}">
document.getElementById("login").addEventListener("submit", async (event) => {
	event.preventDefault();
	const name = new FormData(event.target).get("name");
	const answer = await fetch("/_chord/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
	if (answer.ok) location.href = "/chat";
});
</script></body></html>`;

// 默认导出的 facet setup。参数 host 用于 serve 服务器端对象，self 用于向注册表贡献 HTTP 路由。
export default defineFacet((host, self) => {
	// serve(Channels, factory)：该远程对象只有一个变体 main；names 状态是 constant(CHANNELS)。
	// constant 把普通数组包装成 Watchable，读者看到的是只读值；类型上需要与 arr(str()) 对齐。
	// 工厂不声明其他依赖，因此对象激活即就绪。
	host.serve(Channels, () => ({ variant: "main", members: { names: constant(CHANNELS) } }));
	self.contribute(Http, {
		// 路由键是 "METHOD /pattern"；:name 匹配单段并解码，`/*` 才能匹配剩余路径。
		routes: {
			// public: true 让匿名请求也能到达；没有它，HTTP 组件会要求已认证 principal。
			// handler 返回 tagged response：html 响应带 body 与默认安全头。
			"GET /": { public: true, handler: async (request) => ({ kind: "html", body: signIn(request.nonce) }) },
			// 文件路由没有 public：未登录请求在进入处理函数前即被拒绝。
			// 参数来自路由匹配；Record<string,string> 在 noUncheckedIndexedAccess 下仍可能是 undefined，
			// 因此这里用 `!` 断言模式中一定存在这两个段。
			"GET /files/:channel/:id": async (request, ctx) => {
				// ctx.get 返回 Room 引用；对象地址由 hostAddress 决定，即 Channel({ id: channel })。
				// 这也会触发 worker 的授权检查：只有 user/owner 能持有频道对象。
				const room = await ctx.get(Room, { id: request.params.channel! });
				// attachment 是远程调用；错误（如文件不存在）在这里被转成 undefined → 404。
				// 使用 BACKGROUND_CONTEXT：下载读取不随请求的取消信号中止（响应体可能分段读取）。
				const file = await room.attachment(request.params.id!, BACKGROUND_CONTEXT).catch(() => undefined);
				if (file === undefined) return { kind: "error", status: 404 };
				// bytes 响应：HTTP 组件按 256 KiB 拉取 read(offset, length)，支持 Range/HEAD。
				return {
					kind: "bytes",
					mime: file.mime,
					size: file.size,
					// 图片允许内联显示（inline 会带 sandbox CSP）；其他类型作为附件下载并给出文件名。
					// 三元表达式返回 true 或 undefined，省略字段而不是传 false。
					inline: file.mime.startsWith("image/") ? true : undefined,
					download: file.mime.startsWith("image/") ? undefined : file.name,
					// read 必须返回 Promise<Uint8Array>；这里把单次长度再限制到 1 MiB。
					// Math.min 防止恶意/错误的 Range 请求一次拉取过多数据。
					read: (offset, length) =>
						room.read({ id: file.id, offset, length: Math.min(length, 1024 * 1024) }, BACKGROUND_CONTEXT),
				};
			},
		},
	});
});
