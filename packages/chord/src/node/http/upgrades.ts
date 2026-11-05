// 所属：packages/chord/src/node/http，Chord v2 HTTP 组件的 WebSocket 升级模块（slice 10 §2，D6/Q6）。
// 职责边界：完成 HTTP Upgrade、把套接字交给 links 端点或插件处理器、维持心跳、在宿主/中继/处理器离开时
// 撤销连接，并在组件关闭时统一关闭；不做准入/认证/路由本身，也不实现链接协议。
// 上游入口：http.ts 的 #upgradeSteps 在准入、Origin 检查、认证和路由后调用 link/socket；
// 下游依赖：ws 的 WebSocket/WebSocketServer、link 的 webSocketLink/WebSocketLike/PartLimits、
// context 的 withAbortSignal/withoutAbortSignal、host 的 Host.accept/Host.root、Router/HttpSocket。
// 结果与错误流向：升级失败在 http.ts 用 HTTP 错误行拒绝；处理器抛错报告 socket_failed 并以 1011 关闭；
// 输出上限或心跳超时只终止对应套接字；close 先发 1001，超时后 terminate。
// 能力清单：
// - Admission：放行连接所需的 allowed/relay/principal；
// - LinkOptions：链接端点的分片限制与最大帧；
// - SocketFailure：插件套接字处理器失败的载荷；
// - Upgrades：管理 link/socket/revoke/close 的连接集合；
// - limitedSocket：给链接套接字加 4 MiB 未发送缓冲上限的适配器；
// - 内部 upgrade/end/heartbeat 与常量 DEFAULT_LINK_PAYLOAD/SILENCE/MAX_UNSENT_BYTES。
// 组合关系：http.ts -> Upgrades.link/socket -> 私有 upgrade 创建 ws 服务器 -> #keep 登记连接 ->
// 心跳或处理器运行；Router 变化 -> revoke 终止不再被承认的连接；组件 close -> 关闭/终止全部连接。
// 示例：upgrades.link(message, stream, head, { allowed, relay, principal, limits }, host, context, opened);
// 建议阅读顺序：先看 Admission/Upgraded 与 Upgrades 的公开方法，再看 link/socket 的差别，
// 随后 revoke/close 的生命周期，最后看 heartbeat 与 limitedSocket 的背压保护。
// Upgraded connections (slice 10 §2, D6, Q6): the links endpoint (`host.accept` over a WebSocket with a per-socket
// output cap) and plugin sockets (a `ws` WebSocket handed to the contribution's handler for its own protocol, in a scope
// lasting until it closes, kept alive by a heartbeat). Each connection is kept with what admitted it: when that leaves
// (its allowed host, its relay, its socket handler) it is terminated at once and its scope sealed (decision "Slice 10
// fix round, allowed hosts only through contributions"); the component's close closes all (1001), terminating at its
// timeout those that never acknowledge.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { type Context, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Ctx, Host } from "../../host/index.ts";
import { type PartLimits, type WebSocketLike, webSocketLink } from "../../link/index.ts";
import type { HttpRequest } from "./request.ts";
import type { HttpRelay, HttpSocket, Router, SocketMatch } from "./router.ts";

/** What admitted an upgrade: the allowed host or the relay it came through (local: neither), and its principal. */
// 准入信息：哪个允许域名或中继放行了升级，以及认证得到的 principal；本地升级时 allowed 与 relay 都为 undefined。
export type Admission<P extends Principal> = {
	readonly allowed: string | undefined;
	readonly relay: HttpRelay | undefined;
	readonly principal: P;
};

// 链接端点选项：limits 控制每个分片/帧的解析限制，maxPayload 是该链接套接字的最大帧；缺省 1 MiB。
/** What the links endpoint gives one socket: its parts' limits and its largest frame (1 MiB by default). */
export type LinkOptions = { readonly limits?: PartLimits; readonly maxPayload?: number };

// 失败载荷：模式与插件用于定位处理器，error 是原始异常；组件把它转成 socket_failed 报告。
/** A plugin socket's handler failed: reported, the socket closed (1011). */
export type SocketFailure = { readonly pattern: string; readonly plugin: string; readonly error: unknown };

// 一条已升级连接：socket 本体、放行它的 allowed/relay、可选的插件处理器，以及立即封口作用域的函数。
// handler 只在插件套接字上有值；链接端点用 undefined。
/** One upgraded connection, with what admitted it and how to seal its scope. */
type Upgraded = {
	readonly socket: WebSocket;
	readonly allowed: string | undefined;
	readonly relay: HttpRelay | undefined;
	/** The handler that took it (plugin sockets only). */
	readonly handler: HttpSocket | undefined;
	/** Ends its work at once: the link closed, or the handler's scope sealed. */
	readonly seal: () => void;
};

// 链接套接字默认最大帧 1 MiB；可由 links.options.maxPayload 覆盖。
/** A link socket's largest frame unless `links.options` says otherwise: 1 MiB. */
const DEFAULT_LINK_PAYLOAD = 1024 * 1024;

// 类用途：一个 HTTP 组件实例的所有已升级连接；#open 是运行时 Set，close 时清空。
// 方法本身不把失败作为返回值；会话级失败通过回调或套接字关闭表达。
/** The upgraded connections of one HTTP component. */
export class Upgrades {
	readonly #open = new Set<Upgraded>();

	// 函数用途：把请求升级为 links 端点连接。输入 Node 升级三元组、准入信息+选项、宿主、上下文和 opened 回调。
	// 流程：用 maxPayload 完成 ws 升级 -> 用 limitedSocket 包装输出 -> 登记撤销信息 -> host.accept 接管链接 ->
	// opened() 若返回清理函数，则在 socket close 时调用。
	// 副作用：接管底层 Duplex、创建链接、登记连接；无返回值，失败由 http.ts 的升级步骤处理。
	// 例子：upgrades.link(message, stream, head, { principal, limits: { maxParts: 64 } }, host, context, opened)。
	// 注意：link.close 是封口动作；撤销时 end() 会先 terminate 再调用它，避免发送关闭帧。
	/**
	 * Upgrades `message` to the links endpoint: `host.accept` over the socket (its output capped) as the admitted
	 * principal, with `options`' limits; `context` is the parent of the work on the link. `opened` runs once the link
	 * is accepted; what it returns runs when its socket closes.
	 */
	link<P extends Principal>(
		message: IncomingMessage,
		stream: Duplex,
		head: Buffer,
		admission: Admission<P> & LinkOptions,
		host: Host<P>,
		context: Context,
		opened: () => (() => void) | undefined,
	): void {
		// maxPayload 缺省用 1 MiB；options 里只取 principal/limits，其余字段（allowed/relay）用于登记。
		const { principal, limits } = admission;
		upgrade(message, stream, head, admission.maxPayload ?? DEFAULT_LINK_PAYLOAD, (socket) => {
			// limitedSocket 只暴露链接需要的 WebSocketLike 接口，并在发送前限制未发送字节。
			const link = webSocketLink(limitedSocket(socket));
			// 登记连接：链接自身没有插件 handler；seal 关闭 link，使作用域结束。
			this.#keep({
				socket,
				allowed: admission.allowed,
				relay: admission.relay,
				handler: undefined,
				seal: () => link.close(),
			});
			// host.accept 在宿主中把链接作为 principal 运行；limits 可选，未提供时使用链接默认值。
			host.accept(link, { principal, ...(limits === undefined ? {} : { limits }) }, context);
			// opened 在链接接受后调用；返回的函数挂到 close 事件，用于应用跟踪（例如最后一个链接断开时结束会话）。
			const closed = opened();
			if (closed !== undefined) socket.once("close", closed);
		});
	}

	// 函数用途：把请求升级为插件套接字。输入升级三元组、包含 principal/match/request 的准入信息、宿主、
	// 上下文和失败回调；无返回值。
	// 作用域：每个套接字一个 host.root，principal 可为 undefined（仅 public 套接字），持续到套接字关闭。
	// 错误路径：处理器抛错 -> failed 报告并以 1011 关闭；作用域被关闭/撤销导致的拒绝不报告为处理器失败。
	// 例子：upgrades.socket(message, stream, head, { principal, match, request, allowed, relay }, host, context, failed)。
	/**
	 * Upgrades `message` to the plugin socket `match`: its handler gets the socket and `request` in a `host.root` scope
	 * acting as the admitted principal that lasts until the socket closes; a handler that throws is reported and closes
	 * it (1011).
	 */
	socket<P extends Principal>(
		message: IncomingMessage,
		stream: Duplex,
		head: Buffer,
		admission: Omit<Admission<P>, "principal"> & {
			/** Anonymous only for a public socket. */
			readonly principal: P | undefined;
			readonly match: SocketMatch;
			readonly request: HttpRequest;
		},
		host: Host<P>,
		context: Context,
		failed: (failure: SocketFailure) => void,
	): void {
		const { principal, match, request } = admission;
		// 每个套接字独立的 AbortController；close 或撤销通过 abort 封口作用域。
		upgrade(message, stream, head, match.maxPayload, (socket) => {
			// seal 同时用于 socket close 事件和 end()；重复 abort 是幂等的。
			const closed = new AbortController();
			// 先挂 close 监听，确保登记后的任何关闭都会封口。
			const seal = (): void => closed.abort(new Error("http: the socket closed"));
			socket.once("close", seal);
			// 登记连接；handler 用于之后判断该处理器是否仍在路由器中。
			this.#keep({ socket, allowed: admission.allowed, relay: admission.relay, handler: match.handler, seal });
			// 心跳从升级完成开始计时；客户端无响应会被 terminate。
			heartbeat(socket);
			// withoutAbortSignal 去掉父上下文带来的取消，withAbortSignal 只加上套接字自己的关闭信号；
			// 这样普通调用方的取消不会误伤长连接，而 close/revoke 仍能通过 abort 封口作用域。
			const scope = withAbortSignal(closed.signal, withoutAbortSignal(context));
			// run 是宿主作用域里的主体：等待处理器完成，再等待套接字关闭，保证作用域覆盖整个连接。
			const run = async (ctx: Ctx<P>): Promise<void> => {
				try {
					// 处理器可以是同步或异步；await 统一两种情况。
					await match.handler(socket, request, ctx);
				} catch (error) {
					// 处理器失败：报告模式/插件/错误，然后用 1011（内部错误）关闭。
					failed({ pattern: match.pattern, plugin: match.plugin, error });
					socket.close(1011, "internal error");
					return;
				}
				// 处理器正常返回但套接字仍开着：等待 close/撤销，避免作用域提前结束。
				if (!closed.signal.aborted) {
					await new Promise((resolve) => closed.signal.addEventListener("abort", resolve, { once: true }));
				}
			};
			// The scope sealed (its socket closed, the host closing) is no failure of the handler.
			// host.root 以 principal 运行；catch 忽略的是作用域被封口导致的拒绝，不是处理器异常（已在上方处理）。
			void host.root(run, scope, { principal }).catch(() => {});
		});
	}

	// 函数用途：路由器变化后撤销不再被承认的连接。输入新 Router，无返回值；副作用是终止套接字并封口作用域。
	// 规则：连接经过的 allowed 域名已不在 hosts、relay 已不在 relays、或插件套接字的 handler 已不在 socketHandlers。
	// 使用 terminate 而非 close：对端可以忽略关闭握手，撤销必须立即生效。
	/**
	 * The router changed: connections through a host or a relay no longer there, and plugin sockets whose handler left,
	 * are terminated at once and their scopes sealed (no close handshake a peer could ignore).
	 */
	revoke(router: Router): void {
		// 遍历当前所有连接；每个条件都只在对应字段存在时检查。
		for (const upgraded of this.#open) {
			const gone =
				// allowed 连接随域名撤销；relay 连接随中继撤销；插件套接字随处理器撤销。
				(upgraded.allowed !== undefined && !router.hosts.has(upgraded.allowed)) ||
				(upgraded.relay !== undefined && !router.relays.includes(upgraded.relay)) ||
				(upgraded.handler !== undefined && !router.socketHandlers.has(upgraded.handler));
			// 任一条件成立即立即终止并封口。
			if (gone) end(upgraded);
		}
	}

	// 函数用途：关闭所有连接。输入 deadline Promise（closeTimeout 到达或调用方取消时 resolve），输出完成 Promise。
	// 流程：为每个仍打开的套接字建立 close 等待 -> 发送 1001 going away -> 等待全部关闭或 deadline ->
	// 对仍未关闭的连接调用 end（terminate + seal）。
	// 副作用：关闭底层网络连接；调用方通常还会等待运行中的请求。
	/** Closes every connection (1001, "going away"); those still open at `deadline` are terminated. */
	async close(deadline: Promise<void>): Promise<void> {
		// 复制当前连接列表，避免迭代时集合被 close 事件修改。
		const open = [...this.#open];
		// 为每个连接创建 Promise；已经 CLOSED 的立即完成，否则等 close 事件。
		const closed = open.map(
			({ socket }) =>
				new Promise<void>((resolve) => {
					if (socket.readyState === socket.CLOSED) resolve();
					else socket.once("close", () => resolve());
				}),
		);
		// 1001 表示服务器主动离开；愿意握手的客户端会回应关闭。
		for (const { socket } of open) socket.close(1001, "going away");
		// 任一条件先完成：全部关闭，或 deadline 到期；不等待未响应的对端。
		await Promise.race([Promise.all(closed), deadline]);
		// 剩下仍打开的连接强制终止；此时 #open 可能已缩小。
		for (const upgraded of this.#open) end(upgraded);
	}

	// 私有方法：登记连接直到关闭。socket 的 error（例如超大海帧）只终止该连接，不影响其他连接。
	/** Keeps `upgraded` until its socket closes; an error (an oversized frame) terminates only that socket. */
	#keep(upgraded: Upgraded): void {
		const { socket } = upgraded;
		// error 监听先 terminate，防止 ws 默认的未处理错误终止进程。
		socket.on("error", () => socket.terminate());
		this.#open.add(upgraded);
		// close 时从集合移除；#open 不会持有已关闭的套接字。
		socket.once("close", () => this.#open.delete(upgraded));
	}
}

// 函数用途：用一次性 WebSocketServer 完成升级。输入消息/流/head、最大帧和回调，无返回值。
// 配置：noServer 表示不自己监听；clientTracking false 不额外持有客户端；perMessageDeflate false 禁用压缩，
// 避免压缩成本和内存放大。服务器对象随本次升级丢弃，不按帧大小缓存。
/**
 * Completes the upgrade with a `ws` server of its own (no listener, no client tracking, no compression), dropped with
 * the upgrade: nothing is kept per frame size.
 */
function upgrade(
	message: IncomingMessage,
	stream: Duplex,
	head: Buffer,
	maxPayload: number,
	then: (socket: WebSocket) => void,
): void {
	const server = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload, perMessageDeflate: false });
	server.handleUpgrade(message, stream, head, then);
}

// 函数用途：立即终止并封口。先 terminate 再 seal：链接的 close 会尝试发送关闭帧，撤销场景不需要。
/** Terminates `upgraded` and seals its scope at once. */
function end(upgraded: Upgraded): void {
	// Terminated first: a link's close would send a close frame.
	upgraded.socket.terminate();
	upgraded.seal();
}

// 心跳间隔：15 秒静默后 ping，再 15 秒仍无任何帧则 terminate；与链接心跳一致。
/** Silence after which a plugin socket is pinged, and after the ping terminated: 15 s each (the link heartbeat's). */
const SILENCE = 15_000;

// 函数用途：给插件套接字安装心跳。输入 WebSocket，无返回值；副作用是定时器和事件监听，close 时清理。
// 流程：计时器到点若已 ping 过则 terminate，否则 ping 并重新计时；收到 message/pong/ping 都视为有活动。
// timer.unref 允许进程在只剩心跳定时器时退出。
/**
 * Keeps a plugin socket honest (decision "plugin sockets get a heartbeat"): after 15 s without a frame from the peer it
 * is pinged, after 15 s more terminated; browsers and `ws` answer pings by themselves.
 */
function heartbeat(socket: WebSocket): void {
	let pinged = false;
	// pinged 表示上一轮已发 ping 且尚未收到任何响应。
	const timer = setTimeout(() => {
		// 已有 ping 无响应：对端可能卡死或网络中断，直接终止。
		if (pinged) {
			socket.terminate();
			return;
		}
		pinged = true;
		// 否则发 ping；refresh 让同一个定时器从现在重新计时，避免创建多个 timer。
		socket.ping();
		timer.refresh();
	}, SILENCE);
	// unref 不阻止 Node 进程退出；服务器本身仍保持进程运行。
	timer.unref();
	const heard = (): void => {
		pinged = false;
		timer.refresh();
	};
	// 任意帧都清除 pinged 并重置计时；浏览器/ws 会自动回 pong。
	socket.on("message", heard);
	socket.on("pong", heard);
	socket.on("ping", heard);
	socket.once("close", () => clearTimeout(timer));
}

// 链接套接字未发送数据的上限：4 MiB。超过说明客户端停止读取，继续缓存会耗尽服务器内存。
/** Unsent data beyond the frame being sent at which a link socket is cut off: a client that stopped reading. */
const MAX_UNSENT_BYTES = 4 * 1024 * 1024;

// 函数用途：把 ws WebSocket 适配成链接层的 WebSocketLike，并限制输出缓冲。输入 socket，输出适配器。
// 发送前估算“除正在发送的那一帧外”的缓冲量：bufferedAmount - 最大在途帧；超过 4 MiB 立即 terminate。
// 这不是精确的流控，而是保护阈值；链接自己的流控应让正常客户端远低于它。
// 例子：一个 1 MiB 帧正在发送、bufferedAmount 为 6 MiB => sending=1 MiB，超出 4 MiB，终止连接。
/**
 * `socket` as the link sees it, its output capped (p2's `limitedSocket`): before each send, what is still buffered
 * beyond the largest frame being sent must stay under 4 MiB, or the socket is terminated (the client reconnects from
 * snapshots); Chord's flow control keeps a reading client far below it.
 */
// unsent 记录已调用 send 但回调尚未完成的帧；每个元素只需 bytes。
export function limitedSocket(socket: WebSocket): WebSocketLike {
	const unsent = new Set<{ readonly bytes: number }>();
	// readyState 用 getter、binaryType 用 getter/setter 透传，保持链接层看到的状态一致。
	return {
		get readyState() {
			return socket.readyState;
		},
		get binaryType() {
			return socket.binaryType;
		},
		set binaryType(type: string) {
			socket.binaryType = type as WebSocket["binaryType"];
		},
		// send 入口：非 OPEN 状态直接丢弃，避免 ws 在关闭后抛错。
		send(data) {
			if (socket.readyState !== socket.OPEN) return;
			// 找出当前在途帧的最大字节数；回调尚未触发的帧可能同时存在多个。
			let sending = 0;
			for (const frame of unsent) sending = Math.max(sending, frame.bytes);
			// bufferedAmount 包含所有排队数据；减去正在发送的最大帧，判断“尚未开始发送”的积压是否超限。
			// 终止后直接返回，不再调用底层 send。
			if (socket.bufferedAmount - sending > MAX_UNSENT_BYTES) {
				socket.terminate();
				return;
			}
			// 估算帧大小：数据字节加 10 字节最大服务器帧头；这是保守上界，不是精确协议长度。
			// The largest server frame header is 10 bytes.
			const frame = { bytes: data.byteLength + 10 };
			unsent.add(frame);
			// 回调删除记录；发送出错时 terminate，错误不会抛回调用方。
			socket.send(data, (error) => {
				unsent.delete(frame);
				if (error) socket.terminate();
			});
		},
		// close 透传，用于正常关闭；撤销路径走 terminate，不经过这里。
		close: () => socket.close(),
		// 事件监听器的类型参数被链接层泛化为字符串；as 只影响类型检查，运行时直接委托 ws。
		addEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) =>
			socket.addEventListener(type as "message", listener as never),
		removeEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) =>
			socket.removeEventListener(type as "message", listener as never),
	} as WebSocketLike;
}
