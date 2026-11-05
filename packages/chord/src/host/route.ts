// Routes (§3): how a host reaches hosts of one kind. `authorize` admits each hold routed over the route; `resolve`
// makes the link of one address, at most once at a time. No timer (slice 10 R2): an address resolves for a new hold,
// on `RouteHandle.retry`, or once after its link dropped while held; a rejected `resolve` (or a link closed before its
// handshake) fails its holders `failed { waiting }` until then, and a suspended address resolves nothing while held.
// 所属模块：packages/chord/src/host 的路由层（host.route）。
// 上下游：Host.route 用 RouteOptions 构造 Route；每次远端 hold 经 path 校验/授权取得 Path，Path 事件驱动 #resolve；
//   下游是 remote.Path、HostLink、host.routeLink 与宿主关闭。
// 结果：成功时一个地址共享一个 Path 和至多一个链接；失败以 failed { waiting } 让持有者等待，错误经 host.report 报告。
// 能力清单：
// - RouteOptions：应用实现的 authorize 与 resolve。
// - RouteHandle：retry 与 suspend 两个地址控制。
// - Route：按地址维护 Path、失败、暂停状态及链接映射。
// 组合关系：path -> 授权并复用 Routed -> attached 事件 -> #resolve -> routeLink -> path.connected；
//   断线 closed -> Path 事件 -> 握手成功后最多自动重连一次。
// 示例：const handle = host.route(Session, { authorize, resolve }, ctx); const path = route.path({ id: "s1" }, principal, ctx);
// 阅读顺序：先 RouteOptions/RouteHandle 的契约，再 path/retry/suspend 的对外入口，最后 #changed/#resolve/#settle 的事件流。

import type { Context } from "../context/index.ts";
import type { Address, HostKind, KindShape } from "../contracts/index.ts";
import { kindParams, type ParamsData } from "../contracts/internal.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { asChordError, checkAddress } from "../data/internal.ts";
import type { Codec, Link, PartLimits } from "../link/index.ts";
import { type HostLink, Path, type PathEvent, type Upstream } from "../remote/internal.ts";
import type { AnyHost } from "./host.ts";

/** What `host.route` takes for a kind. */
export type RouteOptions<P extends Principal, K extends KindShape> = {
	// P 约束调用身份，K 约束地址参数；这些泛型是开发期约束，接收的原始地址仍在 path 中校验。
	/** Whether `principal` may reach `address`; runs for every hold routed over the route, before anything starts. */
	authorize(principal: P, address: Address<K>): boolean;
	// resolve 是应用边界：返回实际 Link 及对端身份/信任/编解码/分片限制；同一地址同一时刻至多运行一次。
	// context 随宿主关闭而取消，因此阻塞的解析不会永久悬挂。
	/**
	 * The link to `address`: `principal` is who the host at the other end is, `trusted` skips the message check on it,
	 * `limits` bound its parts (as `accept`'s). `context` is the route's, aborted when this host closes. Runs at most
	 * once at a time per address.
	 */
	resolve(
		address: Address<K>,
		context: Context,
	): Promise<{
		readonly link: Link;
		readonly principal: P;
		readonly trusted?: boolean;
		readonly codec?: Codec;
		readonly limits?: PartLimits;
	}>;
};

/** What `host.route` returns: the app's controls of its addresses (D10b, R1). */
export type RouteHandle<K extends KindShape> = {
	// 立即重试：仅当地址仍被持有且没有链接时发起解析，并清除之前的失败与暂停；无持有者时什么也不做。
	/**
	 * Resolves `address` again now if it has holders and no link: its failure and its suspension end (a Retry button);
	 * an address nobody holds resolves at its next hold.
	 */
	retry(address: Address<K>): void;
	// 暂停：有持有者时停止解析并让它们在断链后看到 failed { waiting }；最后一个持有者离开或 retry 时解除。
	/**
	 * Resolves nothing for `address` while it has holders: they wait `failed { waiting }` ("suspended") once its link is
	 * gone; the suspension ends with its last holder or `retry`.
	 */
	suspend(address: Address<K>): void;
};

/** One address of a route: its path, whether its `resolve` runs, why it fails its holders, whether it is suspended. */
type Routed = {
	// 每个地址只保留一条 Path；resolving/failure/suspended 分别记录正在解析、上次失败和人工暂停。
	readonly address: Address;
	readonly path: Path;
	resolving: boolean;
	/** A rejected `resolve`, or a link closed before its handshake: its holders fail with it until the next resolve. */
	failure: ChordError | undefined;
	suspended: boolean;
};

/**
 * A host's route for one kind. An address is kept while it has holders, a link or a running `resolve`: a resolve whose
 * holds were all released meanwhile finishes, and its link is kept until it closes.
 */
// 每个 kind 一条路由：地址在仍有持有者、链接或进行中的 resolve 时保留。
export class Route {
	readonly kind: string;
	readonly #params: ParamsData;
	readonly #options: RouteOptions<Principal, KindShape>;
	readonly #host: AnyHost;
	/** The route's context, aborted when the host closes: every `resolve` and its links' work run under it. */
	readonly #context: Context;
	readonly #addresses = new Map<string, Routed>();
	/** The addresses' links, which tell their address when they close, and whether each completed its handshake. */
	readonly #links = new Map<HostLink, { readonly routed: Routed; greeted: boolean }>();

	// 建立一种宿主地址的路由管理器，保存声明及宿主上下文，无网络副作用、无返回值。
	// 例如 Session 类型下 S1、S2 共用本管理器，但各自的链接与解析状态独立。
	constructor(kind: HostKind, options: RouteOptions<Principal, KindShape>, host: AnyHost, context: Context) {
		// 保存种类名和参数元数据：后者供 path 将 unknown 参数检查为合法地址。
		this.kind = kind.kind;
		this.#params = kindParams(kind);
		this.#options = options;
		// 解析成功后通过宿主建立协议链接，解析使用注册路由时的 context。
		this.#host = host;
		this.#context = context;
	}

	/**
	 * The path to the address with `params`, for a hold acting as `principal`: the params checked against the kind
	 * (`invalid/host_address`), then `authorize` (`forbidden` when it refuses; a throw is the hold's failure).
	 */
	// 为一次请求校验参数与权限并取得共享路径，返回 Path；校验失败同步抛错，还不会调用 resolve。
	// 例如同一 S1 被请求两次会共享 Path，但每一次都执行 authorize，不能复用上次的身份许可。
	path(params: unknown, principal: Principal | undefined, context: Context): Path {
		// 原始地址参数是信任边界：按本种类的 schema 校验，得到包含规范 key 的地址。
		const address = checkAddress(this.kind, this.#params, params, context);
		if (principal === undefined || !this.#options.authorize(principal, address)) {
			// 没有身份时短路，不调用 authorize；拒绝统一转成 forbidden。
			throw new ChordError({ code: "forbidden", message: `${address.key}: not authorized` });
		}
		let routed = this.#addresses.get(address.key);
		// 首次见到地址时才分配状态，后续通过规范 key 复用。
		if (routed === undefined) {
			const made: Routed = {
				address,
				// 回调捕获本地址记录；Path 只在后续持有者变化时通知 #changed。
				path: new Path((event) => this.#changed(made, event)),
				resolving: false,
				failure: undefined,
				suspended: false,
			};
			routed = made;
			// 记录进入索引后供 retry/suspend/closed 寻找。
			this.#addresses.set(address.key, made);
		}
		return routed.path;
	}

	/** `RouteHandle.retry`: the address's failure and suspension end; it resolves now if held and unlinked. */
	// 清除某地址的失败与暂停；若仍有人持有且没有链接就立即解析，无返回值。
	// 例如“重试”按钮传 S1 的 key；不存在的地址不建立记录，下一次请求自然会创建。
	retry(key: string): void {
		const routed = this.#addresses.get(key);
		if (routed === undefined) return;
		// 这两个状态都要清除；运行中的 resolve 由 #resolveIfHeld 保证不重复启动。
		routed.failure = undefined;
		routed.suspended = false;
		this.#resolveIfHeld(routed);
	}

	/** `RouteHandle.suspend`: a held address resolves nothing until `retry` or its last holder; unheld, nothing is kept. */
	// 暂停已有持有者的地址，无返回值；不关闭健康链接，也不取消已启动的 resolve。
	// 例如工作进程被主动停止后暂停 S1，断开时持有者见 waiting，直到 retry 或最后持有者释放。
	suspend(key: string): void {
		const routed = this.#addresses.get(key);
		if (routed === undefined || !routed.path.held) return;
		// 无人持有的地址不记录暂停，避免留下无主的控制状态。
		routed.suspended = true;
		if (routed.path.link === undefined && !routed.resolving) routed.path.unreachable(suspended(routed));
	}

	/** One of this route's links completed its handshake: a later drop of it resolves its address again. */
	// 标记已完成握手的路由链接，无返回值；例如其后断线允许一次自动重连，未知链接忽略。
	opened(link: HostLink): void {
		const entry = this.#links.get(link);
		if (entry !== undefined) entry.greeted = true;
	}

	/**
	 * One of this route's links closed: its address resolves again once while held if the link had completed its
	 * handshake, else its holders fail (no loop over a worker that dies at start).
	 */
	// 处理链接关闭，返回是否属于本路由；握手前关闭记作失败，握手后掉线由 Path 触发一次重新解析。
	// 例如启动即退出的工作进程不会被无限重启；本函数清理链接索引并通知其路径。
	closed(link: HostLink): boolean {
		const entry = this.#links.get(link);
		if (entry === undefined) return false;
		// 先删索引，重复 closed 不会再次处理。
		this.#links.delete(link);
		const { routed } = entry;
		// greeted 区分启动失败与健康连接掉线；错误保存在地址记录中供 dropped 分支使用。
		if (!entry.greeted) {
			routed.failure = new ChordError({
				code: "unavailable",
				message: `${routed.address.key}: the link closed before its handshake`,
			});
		}
		routed.path.disconnected(link);
		// Path 会把持有者切换为未连接，并同步通知 #changed。
		return true;
	}

	/** Every holder of every path of this route, linked or not (revocation ends a revoked principal's). */
	// 收集本路由所有地址的持有者，返回新数组，无状态修改；撤权会遍历它结束相应身份的请求。
	// 例如 S1 有两位持有者、S2 有一位，则得到三项；未绑定的等待者也在 Path 中。
	holders(): Upstream[] {
		// 展开 Map 值再 flatMap，每个地址提供自己的持有者列表，不复制持有者对象。
		return [...this.#addresses.values()].flatMap(({ path }) => path.holders());
	}

	/**
	 * An address's path changed without a link: a new holder resolves it (a failed address too: a new hold is a new
	 * request), a dropped link resolves it once (or fails it, closed before its handshake), the last holder's release
	 * forgets it (its failure and suspension too) unless its link or `resolve` keeps it.
	 */
	// 处理某地址的 Path 事件，无返回值；事件可触发解析、报告等待失败或删除无人持有记录。
	// 例如最后一个请求释放且没有链接/解析任务时，删除地址以便回收；宿主关闭时不再恢复连接。
	#changed(routed: Routed, event: PathEvent): void {
		if (this.#host.closing) return;
		switch (event.kind) {
			case "released":
				// released 表示最后持有者离开，清除暂停；活链接或未完成解析仍会保留记录。
				routed.suspended = false;
				if (routed.path.link === undefined && !routed.resolving) this.#addresses.delete(routed.address.key);
				return;
			case "attached":
				// 新请求可以重新尝试失败地址；暂停时仅通知这一新增持有者不可达。
				if (routed.suspended) event.holder.unreachable(suspended(routed));
				else if (!routed.resolving) void this.#resolve(routed);
				return;
			case "dropped":
				// 无持有者则遗忘；仍有请求时优先暂停/启动失败，否则立即解析一次。
				if (!routed.path.held) this.#addresses.delete(routed.address.key);
				else if (routed.suspended) routed.path.unreachable(suspended(routed));
				else if (routed.failure !== undefined) routed.path.unreachable(routed.failure);
				else void this.#resolve(routed);
		}
	}

	/** Resolves the address if it has holders, no link, no running `resolve` and no suspension. */
	// 只有仍被持有、未连接、未解析且宿主未关闭时启动解析，无返回值。
	// 本方法由 retry 在清除 suspended 后调用；例如双击重试不会并发两个 resolve。
	#resolveIfHeld(routed: Routed): void {
		const { path } = routed;
		if (!path.held || path.link !== undefined || routed.resolving || this.#host.closing) return;
		void this.#resolve(routed);
	}

	/**
	 * Runs `resolve` once for the address. A rejection, or a link closed already, fails its holders with the error until
	 * the next resolve; a link returned after the host closed is closed at once.
	 */
	// 对一个地址调用应用 resolver 并接入协议链接；返回完成信号，resolver 失败报告并使请求等待。
	// 例如异步 fork 返回前宿主已关闭，迟到链接会被立即关闭，而不会加入路径；没有重试定时器。
	async #resolve(routed: Routed): Promise<void> {
		const key = routed.address.key;
		routed.resolving = true;
		// ReturnType 取得 resolve 的 Promise 类型，Awaited 去掉 Promise 得到其成功结果类型。
		let resolved: Awaited<ReturnType<RouteOptions<Principal, KindShape>["resolve"]>>;
		try {
			// resolver 是应用边界，可能启动进程或连接网络；这里等待它给出实际 Link。
			resolved = await this.#options.resolve(routed.address, this.#context);
		} catch (error) {
			// 先解除进行中标记。宿主关闭后的失败不再报告，正常失败转成 ChordError 给等待者。
			routed.resolving = false;
			if (this.#host.closing) return;
			this.#host.report({ kind: "resolve_failed", address: key, error });
			this.#settle(routed, asChordError(error, key));
			return;
		}
		routed.resolving = false;
		// 成功也必须重新检查宿主状态，await 期间宿主可能已经结束。
		if (this.#host.closing) {
			resolved.link.close();
			return;
		}
		const { link: made, ...options } = resolved;
		// 剩余 options 保留 principal/trusted/codec/limits，交宿主建立带协议角色的链接。
		const link = this.#host.routeLink(made, options, this.#context);
		if (!link.open) {
			// 连接已关闭时直接给路径失败，不留下一个永远 loading 的地址。
			this.#settle(
				routed,
				new ChordError({ code: "unavailable", message: `${key}: the link closed before its handshake` }),
			);
			return;
		}
		routed.failure = undefined;
		// A peer that greeted first had its `hello` handled while the link was made, before it was registered here.
		this.#links.set(link, { routed, greeted: link.greeted });
		// connected 通知已有持有者在该链接上重发 hold。
		routed.path.connected(link);
	}

	/**
	 * A resolve failed with `error`: its holders fail `failed { waiting }` with it (they stay on its path for its next
	 * link), or the address goes when nobody holds it any more.
	 */
	// 把一次解析失败交给路径，无返回值；无人持有则删记录，否则留错误等待新请求或 retry。
	// 例如解析报连接失败而地址同时被暂停，持有者看到 suspended，但原错误仍存在地址记录里。
	#settle(routed: Routed, error: ChordError): void {
		if (!routed.path.held) {
			this.#addresses.delete(routed.address.key);
			return;
		}
		routed.failure = error;
		// 路径保留持有者，unreachable 不释放请求，只改变它们可见的等待状态。
		routed.path.unreachable(routed.suspended ? suspended(routed) : error);
	}
}

/** The failure holders of a suspended address see. */
// 生成带地址的暂停错误，不修改路径；例：S1 的请求会收到 unavailable 和该 key 的 suspended 消息。
function suspended(routed: Routed): ChordError {
	return new ChordError({ code: "unavailable", message: `${routed.address.key}: suspended` });
}
