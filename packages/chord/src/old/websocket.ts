// 把结构上兼容 WebSocketServer 的连接事件接入 Chord v1，并由应用认证结果决定连接身份。
import type { AcceptOptions } from "./connection.ts";
import type { Host } from "./host.ts";
import { type WebSocketLike, webSocketLink } from "./link.ts";

/** A WebSocket server (e.g. `ws`'s `WebSocketServer`), structurally: Chord does not depend on `ws`. */
export interface WebSocketServerLike<Request> {
	/** 注册连接回调，输入 socket 和应用定义的 Request；这里只要求 on 方法，不要求依赖某个 ws 实现。 */
	on(event: "connection", listener: (socket: WebSocketLike, request: Request) => void): unknown;
}

/** WebSocket peers are always accepted as clients: no roots, no code versions, no reload votes, not addressable. */
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
export function acceptWebSockets<Request, P = unknown>(
	server: WebSocketServerLike<Request>,
	host: Host<P>,
	options: WebSocketAcceptOptions<Request, P>,
): void {
	// Request、P 只帮助 TS 保持请求和身份类型；每次 connection 回调各自创建独立 link。
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
				else host.accept(link, { ...options, principal, kind: "client" });
			},
			// 异步认证拒绝时关闭，不把原异常内容暴露给对端；这个回调也不接收成功处理器随后抛出的异常。
			() => link.close("authentication failed"),
		);
	});
}
