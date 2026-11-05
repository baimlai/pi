// The echo plugin: a WebSocket of its own protocol at `/echo/:room`, after the server checked who is connecting.

// 文件导读
// 所属：packages/chord/test/examples/45-plugin-socket/plugins/echo/server.ts，插件 @example/echo 的 server facet；
//   discoverPlugins 把插件目录里的 server.ts 识别为 kind "server" 的入口。
// 演示什么：贡献一个插件套接字。模式 "/echo/:room" 匹配路径并把 :room 解码进 request.params；贡献的是一个
//   裸函数，没有包 { handler, public: true }，因此默认拒绝匿名：没有 principal 的升级在处理器运行前得到 401。
//   处理器拿到已认证的 ws 套接字，发送欢迎语（含 principal 的 JSON），并把收到的每条消息回显。
// 上游/下游：上游是 http.ts 的升级步骤（准入/Origin/认证/路由）与 upgrades.ts 的 Upgrades.socket（建立作用域、
//   挂 error 监听、关闭时封口）；下游是 defineFacet 与 Http 注册表。没有文件或网络 I/O，消息只在本机回环。
// 能力清单：
// - default export：defineFacet 创建的 Facet，插件运行时要求默认导出。
// - sockets：模式到 HttpSocket 或 { handler, public } 的映射；模式只匹配路径（升级请求的 method 固定为 GET）。
// 组合关系：main.ts 的 WebSocket("ws://.../echo/lobby") -> 升级步骤 -> router.socket("/echo/lobby") ->
//   Upgrades.socket -> 本处理器；room 为 "lobby"。处理器抛错会被报告为 socket_failed 并以 1011 关闭套接字；
//   插件重载移除该贡献时，已建立的套接字立即终止（1012）；组件关闭时以 1001 going away 关闭。
// 示例（示例，不是本文件的额外运行代码）：
//   self.contribute(Http, { sockets: { "/chat/:room": (socket, request) => socket.send(String(request.params.room)) } });
//   // 允许匿名：self.contribute(Http, { sockets: { "/public": { handler, public: true } } });
// 同目录 package.json（JSON，不能加注释）提供插件名 @example/echo 与 ESM 类型；插件名会出现在 socket_failed
//   等报告里。
// 建议阅读顺序：先看 HttpSocket/HttpSocketOptions/WebSocketHandle（src/node/http/router.ts），再看本文件的
//   处理器，最后回到 main.ts 的认证器与连接步骤。
import { defineFacet } from "@earendil-works/chord";
import { Http } from "@earendil-works/chord/http";

// defineFacet 的回调只做声明；host 未使用，self.contribute 把套接字表写进 Http 注册表。
export default defineFacet((_host, self) =>
	self.contribute(Http, {
		// 键是路径模式：精确段优先于 :name，最后是结尾的 *；:room 在匹配后写入 request.params。同一模式被多个
		// 插件声明时先贡献者获胜，后者作为冲突报告。
		sockets: {
			// 裸函数等价于 { handler: fn }，即 public 缺省 false。匿名连接不会走到这里：服务器先返回 401。
			// 处理器签名是 (socket: WebSocketHandle, request: HttpRequest, ctx: Ctx) => void | Promise<void>；
			// 这里忽略返回的 Promise，套接字在事件监听器存在期间持续工作，作用域持续到套接字关闭。
			"/echo/:room": (socket, request, ctx) => {
				// ctx.principal 的类型是 Principal | undefined（Principal 是 { kind: string, ...JSON 字段 }）；
				// 非 public 套接字在运行时保证 principal 已定义，但类型仍包含 undefined，因为类型无法表达准入结果。
				// JSON.stringify 把身份对象转成文本放进欢迎语；若 principal 为 undefined（public 套接字才会发生），
				// 它会返回 undefined 并被模板串渲染成 "undefined"。
				const who = JSON.stringify(ctx.principal);
				// request.params 只在套接字匹配成功后写入（http.ts 的升级步骤）；room 是 URL 解码后的字符串。
				// 这条欢迎语是插件自己的协议，Chord 不解释消息内容。
				socket.send(`welcome to ${request.params.room}, ${who}`);
				// ws 的 message 事件默认给 Buffer；String(data) 按 UTF-8 解码。监听器在套接字关闭前一直有效；
				// 这里直接 send，不处理背压或未发送缓冲上限（组件对链接套接字才有 4 MiB 限制，插件套接字由插件负责）。
				socket.on("message", (data) => socket.send(`echo: ${String(data)}`));
			},
		},
	}),
);
