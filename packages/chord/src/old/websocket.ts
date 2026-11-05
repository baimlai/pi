// 把结构上兼容 WebSocketServer 的连接事件接入 Chord v1，并由应用认证结果决定连接身份。
/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/old/websocket.ts，Chord v1 的 WebSocket 接入适配层（旧实现）。
 *
 * 功能：把任意“结构上兼容”的 WebSocket 服务器接入 Chord：为每个 connection 认证请求、把 socket 包装成 Link，
 * 再以 client 身份交给 host.accept。它不实现 WebSocket 协议，也不实现认证逻辑。
 *
 * 职责边界：
 * - 负责：注册 connection 回调、调用应用认证器、创建 webSocketLink、按认证结果接受或关闭连接。
 * - 不负责：WebSocket 服务器/客户端实现、会话校验、重连、子 host 协商、Chord 帧的编解码（link.ts/connection.ts）。
 * - 永远按 client 接入：AcceptOptions 中的 principal/kind/name 被 Omit，kind 固定为 "client"，且不提供 name，
 *   所以连接没有 root、没有代码版本、不参与重载投票，也不能按名字路由。
 *
 * 关键设计：
 * - 结构类型而非依赖：WebSocketServerLike 只要求 on("connection", ...)，不 import `ws`；任何满足形状的服务器都能用。
 * - 先建 link 再认证：webSocketLink 立即包装 socket，认证期间到达的帧进入 Link 队列，不会因还没 host.accept 而丢失。
 * - 出站压缩、入站拒绝压缩：服务端压缩自己发出的较大负载（浏览器可异步解压）；不接受客户端的二进制压缩帧，
 *   避免不受信任的小包解压后占用大量内存。文本帧始终接受。
 * - 正常认证路径有三种结果：返回 P 则接受；返回 undefined 关闭（reason "unauthorized"）；Promise 拒绝关闭
 *   （reason "authentication failed"）。认证器同步抛错发生在 Promise.resolve 求值之前，不会进入拒绝回调。
 *
 * 上游 / 下游：
 * - 上游：应用把 WebSocketServer 和 host 传进来（见测试 packages/chord/test/old/websocket.test.ts）。
 * - 下游：connection.ts 的 AcceptOptions、host.ts 的 Host.accept、link.ts 的 WebSocketLike/webSocketLink。
 * 能力清单（导出项）：
 * - `WebSocketServerLike<Request>`：服务器需要的最小结构（一个 on 方法）。
 * - `WebSocketAcceptOptions<Request, P>`：AcceptOptions 去掉 principal/kind/name，加上必填认证器 principal(request)。
 * - `acceptWebSockets(server, host, options)`：注册连接处理器；返回 void，之后持续接受新连接。
 *
 * 典型调用（示例；认证函数由应用提供）：
 *   acceptWebSockets(wss, host, {
 *     principal: async (request) => (await authenticate(request)) ?? undefined,
 *     maxCalls: 100,
 *   });
 * 接受后的连接执行请求时使用 principal 返回值；连接本身不可按 host 名字寻址。
 *
 * 相关测试：packages/chord/test/old/websocket.test.ts 覆盖认证身份、冒充 host 被断开、未认证拒绝、
 * 大负载出站压缩以及客户端二进制入站被拒绝。
 *
 * 建议阅读顺序：先看 WebSocketServerLike 与 WebSocketAcceptOptions（尤其 Omit 掉的三个字段），再读
 * acceptWebSockets 的“建 link → 认证 → accept/close”流程；认证失败语义与入站压缩拒绝是易错点。
 */
import type { AcceptOptions } from "./connection.ts";
import type { Host } from "./host.ts";
import { type WebSocketLike, webSocketLink } from "./link.ts";

/** A WebSocket server (e.g. `ws`'s `WebSocketServer`), structurally: Chord does not depend on `ws`. */
// 结构约束只覆盖多路复用器所需的最小面：能注册 connection 回调即可；on 的返回值被忽略。
// 运行时任何满足形状的服务器都能用；具体实现的 TypeScript 重载签名可能需要在类型层适配（测试里用了 as never）。
export interface WebSocketServerLike<Request> {
	/** 注册连接回调，输入 socket 和应用定义的 Request；这里只要求 on 方法，不要求依赖某个 ws 实现。 */
	on(event: "connection", listener: (socket: WebSocketLike, request: Request) => void): unknown;
}

/** WebSocket peers are always accepted as clients: no roots, no code versions, no reload votes, not addressable. */
// 认证结果 P 由应用定义；Chord 只把它作为该连接所有请求的 principal，不解释其结构。
// 继承的 restamp/maxCalls/心跳/窗口等选项照常生效，但 principal/kind/name 不允许由调用方覆盖。
export interface WebSocketAcceptOptions<Request, P = unknown>
	// Omit 删掉接入时由此模块确定的三个属性；其他超时、心跳、流控选项沿用 AcceptOptions。
	extends Omit<AcceptOptions<P>, "principal" | "kind" | "name"> {
	/** The authenticator: the principal of the connecting client, or undefined to refuse it. */
	/** 应用认证 request，返回身份 P 或 Promise<P>；undefined 拒绝，Promise 拒绝会关闭连接。例如读取并验证会话后返回用户身份。 */
	principal(request: Request): P | undefined | Promise<P | undefined>;
}

/** Accepts every connection of `server` on `host` as a client link stamped with the authenticated principal. */
/**
 * 给 server 注册连接处理器，将认证通过的套接字交给 host.accept；返回 void，注册后持续响应新连接。
 * 先封装 link 排队早到的帧，再等待 options.principal；无身份或异步认证失败则关闭。客户端不能携带宿主代码版本/重载投票。
 * 示例：acceptWebSockets(server, host, { principal: req => authenticate(req) })；不会在这里实现认证逻辑。
 * 注意 principal 的调用在 Promise.resolve 参数求值时发生，同步抛错不会进入下面的 Promise 拒绝回调。
 */
// Request 是服务器传给 connection 回调的请求类型；P 是应用 principal 类型（默认 unknown）。
// 函数只注册监听器并立即返回 void；真正的认证与 accept 发生在以后每个连接的回调中。
export function acceptWebSockets<Request, P = unknown>(
	server: WebSocketServerLike<Request>,
	host: Host<P>,
	options: WebSocketAcceptOptions<Request, P>,
): void {
	// Request、P 只帮助 TS 保持请求和身份类型；每次 connection 回调各自创建独立 link。
	// 每个连接独立走一遍认证；server.on 的回调可能并发执行，本函数不串行化认证或限制连接数。
	server.on("connection", (socket, request) => {
		// Wrap at once so frames sent while authenticating are queued, not lost. Large payloads go out deflated; clients
		// may not send packed frames (a small message could inflate to anything).
		// 服务端可以压缩发出的较大负载；不接收客户端压缩包，避免小包解压成过量数据。Link 接收者尚未设置时会排队。
		const link = webSocketLink(socket, { compress: true, acceptPacked: false });
		// Promise.resolve 统一处理同步返回的身份与 Promise；then 的两个回调分别处理完成与拒绝。
		Promise.resolve(options.principal(request)).then(
			(principal) => {
				// undefined 专门表示拒绝；合法 P 中其他值不按真假判断。
				if (principal === undefined) link.close("unauthorized");
				// 展开保留接入选项，再覆盖 principal/kind：请求只能作为 client，身份来自认证结果。
				// 展开 options 保留 LinkOptions（心跳、流控、restamp、maxCalls 等），再覆盖 kind/principal。
				// 不传 name：client 不可按名字路由，也不能作为 host 参与重载协调。
				else host.accept(link, { ...options, principal, kind: "client" });
			},
			// 异步认证拒绝时关闭，不把原异常内容暴露给对端；这个回调也不接收成功处理器随后抛出的异常。
			() => link.close("authentication failed"),
		);
	});
}
