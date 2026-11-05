// 本文件把下游 hold 原样续接到上游路径；只改来源信封，不解析参数、结果和状态正文。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的中继实现。
// 职责边界：代表下游来源在上游重新持有同一编号的 hold，转发 call/abort/retry/release；不执行用户方法、不解析分片、不检查结果。
// 上游入口：Hold.start 在 host.place 返回 path 时创建 RelayedHold 并调用 start；Path.connected 调用 attach。
// 下游依赖：ProviderSide（下游持有表与回复转发）、HostLink（上游发送）、Path（跨连接登记）。
// 结果与错误流向：上游断线时 dropped 让下游在途调用失败并发 loading；无上游时 call 立即以 unavailable 回复；revoked/lost 让下游结束。
//
// 能力清单：
// - class RelayedHold：保存下游提供端、请求副本、调用者身份、路径与当前上游；start 接管下游 pending 记录，heldOn 判断连接归属，attach 发送保存的 hold，dropped/unreachable 处理断线，revoked/lost 结束，call/abort/retry 转发，release/drop 退出路径。
//
// 组合关系：本地 Hold 被判定为中继后由本类替换；上游回复经 ProviderSide.forward 回到下游 origin，编号始终不变。
// 示例：new RelayedHold(id, provider, request, caller, placed.path).start()
// 建议阅读顺序：先看字段与 constructor，再看 start/attach，最后看 call/dropped/release 等转发与退出方法。
// Relayed holds (§4, §22, R1; decision "Relay flow control per origin"): a hold that arrived on one link (downstream)
// and that this host neither serves nor parses, held again on its path's link (upstream) with the same id under its
// downstream origin's number there; messages are forwarded between the two with the origin rewritten and parts
// untouched.

import { ChordError } from "../data/index.ts";
import type { Caller } from "../host/internal.ts";
import { type Message, wireError } from "../link/internal.ts";
import { actingFor, type HoldRequest } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { Path } from "./path.ts";
import type { ProviderSide } from "./provider.ts";

/**
 * One relayed hold: `id` on its downstream origin, and the same id upstream on its path's current link (none while
 * the path has no link). It keeps its `hold` message to hold again on the next link. Calls, `abort`, `retry` and
 * `release` go upstream at once; what comes back is forwarded by its downstream origin (`ProviderSide.forward`). Two
 * downstream holds are two upstream holds, each with its own encoders (R1).
 */
export class RelayedHold {
	// 字面量标签让提供端区分本地 Hold 与中继持有。
	readonly kind = "relayed";
	// 下游分配的持有编号，上游保留同一值。
	readonly id: number;
	// 接收请求的下游来源，负责转发回复和维护调用表。
	readonly #downstream: ProviderSide;
	/**
	 * What the upstream hold asks for, with the chain and decoded limit this host honoured; its params owned, not a view
	 * of the message they came in.
	 */
	// 保存原始持有内容，以便下一上游连接重新发送。
	readonly #request: HoldRequest;
	/** Whom the hold acts for, sent on route links. */
	// 已在入口决定的真实身份与 incarnation，不盲信下游消息声明。
	readonly caller: Caller;
	// 跨上游重连保存本请求的路径。
	readonly #path: Path;
	/** The upstream link while the path has one, and the downstream origin's number on it. */
	// 只有正在持有时才有连接与该下游在上游的来源编号。
	#upstream: { readonly link: HostLink; readonly origin: number } | undefined;

	// 创建中继持有：输入下游编号/提供端、请求、真实调用身份和上游路径，返回新实例。
	// 只保存元数据并复制二进制 params，防止长期保留整条输入缓冲；例如 tab 的 hold 3 在 worker 仍用 3，但另带来源编号。
	constructor(id: number, downstream: ProviderSide, request: HoldRequest, caller: Caller, path: Path) {
		// 保持下游 hold 编号。
		this.id = id;
		// 保存回送消息的提供端。
		this.#downstream = downstream;
		// 从请求解构出参数正文；这里不解析 JSON。
		const { params } = request;
		// Params are never deflated: the provider side refused deflated ones.
		// 字符串直接保留，字节视图复制出独立缓冲；断言依据入口已拒绝压缩 params。
		const owned = typeof params === "string" ? params : (params as Uint8Array).slice();
		// 浅展开保存请求，但用独立参数正文替换原视图。
		this.#request = { ...request, params: owned };
		// 保存入口认证后的调用者身份。
		this.caller = caller;
		// 保存后续附着和退出要操作的路径。
		this.#path = path;
	}

	/** Takes the pending hold's place downstream and holds upstream (now, or when the path has a link). */
	// 让本对象替代下游 pending 记录并加入上游路径，无参数返回值。
	// 例如路由尚未连上时先登记，之后 Path.connected 再调用 attach；此处不等待就绪。
	start(): void {
		// 用本中继持有替换原来的本地待处理记录。
		this.#downstream.relayed(this);
		// 加入路径；已有连接时会同步触发 attach。
		this.#path.attach(this);
	}

	/** Whether it is held on `link` now: only that link answers for it. */
	// 判断是否正通过指定 link 持有，返回布尔值且无副作用。
	// 例如旧 worker 的迟到回复必须按这个结果过滤，不能更新另一 worker 的持有。
	heldOn(link: HostLink): boolean {
		// 可选链在未连接时得到 undefined，比较结果自然为 false。
		return this.#upstream?.link === link;
	}

	/** Holds on `link`, the path's link now: its kept `hold` message, with whom it acts for on a route link. */
	// 在路径的新 link 上重新持有，无返回值；分配该下游在此连接的来源编号并发送保存的请求。
	// 例如重连保持 hold id，但使用新连接注册的来源；actingFor 仅对 route 发送调用身份。
	attach(link: HostLink): void {
		// 登记下游来源在上游连接的编号，供双方回送。
		const origin = this.#downstream.relayTo(link);
		// 先保存连接身份，使之后的回复可验证来自正确连接。
		this.#upstream = { link, origin };
		// 只组装信封：保存的请求和该连接允许的身份字段一起发送，参数正文不解析。
		link.send({ kind: "hold", origin, hold: this.id, ...this.#request, ...actingFor(link, this.caller) });
	}

	/** The upstream link dropped: downstream its calls fail and the hold goes loading until the path's next link. */
	// 上游断线：清空连接记录，若此前连接过就让下游提供端失败在途调用并发 loading。
	// 无返回值，持有本身仍留在 Path；例如 worker 退出后，下游等待下一连接，不重放旧调用。
	dropped(error: ChordError): void {
		// 保留本次操作开始时的连接记录。
		const upstream = this.#upstream;
		// 清空当前上游，后续调用将按无连接处理。
		this.#upstream = undefined;
		// 仅实际连接过才通知断线，避免无连接请求重复触发。
		if (upstream !== undefined) this.#downstream.upstreamDropped(this, error);
	}

	/** Its path's address cannot be reached for now: downstream it fails `waiting` with `error` until the next link. */
	// 把路径暂时不可达原因转成 waiting 失败消息发下游，无返回值。
	// 例如 resolve 被拒绝，请求仍保留以便路由以后恢复。
	unreachable(error: ChordError): void {
		// 错误转成无栈的网络信封，发送可等待恢复的失败。
		this.#downstream.send({ kind: "failed", hold: this.id, cause: { kind: "waiting", error: wireError(error) } });
	}

	/**
	 * Whether it waits for its path's link (a route still resolving, or a dropped link's next): a revocation ends it then,
	 * since the link it is held on next gets no past `revoke` (§4).
	 */
	// 读取是否没有上游连接，无副作用；例：未连上 worker 的中继请求撤权时需直接结束。
	get waiting(): boolean {
		// 没有上游记录就代表当前等待连接。
		return this.#upstream === undefined;
	}

	/** Revoked while it waited for its path's link: forgotten, and `gone` with `error` downstream. */
	// 等待连接时被撤权：离开路径、从下游表删除，再发送 gone 原因，无返回值。
	// 例如撤销 tab 授权后不能让未来新 worker 继续持有这个请求。
	revoked(error: ChordError): void {
		// 先退出路径，防止后续重连重新持有。
		this.drop();
		// 下游删除这条持有以及相关的窗口/调用登记。
		this.#downstream.forget(this);
		// 告知下游永久结束及撤权原因。
		this.#downstream.send({ kind: "gone", hold: this.id, error: wireError(error) });
	}

	/** `gone` from upstream: the hold is forgotten (the downstream origin forwards the message). */
	// 上游 gone 已由下游提供端转发，此处只退出路径并删除记录，无参数返回值。
	// 例如上游撤权后该请求不会在重连时复活。
	lost(): void {
		// 先退出路径，防止后续重连重新持有。
		this.drop();
		// 下游删除这条持有以及相关的窗口/调用登记。
		this.#downstream.forget(this);
	}

	/**
	 * A call from downstream (registered there under its id), forwarded upstream at once; its reply comes back by the
	 * origin. Without an upstream link it is answered `unavailable` at once (it crossed the `loading` notice).
	 */
	// 转发 call：输入类型通过 Extract 从 Message 联合筛出 call 分支，无返回值。
	// 有上游便只替换 origin；无连接立即给下游 unavailable，不保存重发；例如调用与 loading 通知交错时明确失败。
	call(message: Extract<Message, { readonly kind: "call" }>): void {
		// 保留本次操作开始时的连接记录。
		const upstream = this.#upstream;
		// 只有现有上游才能立即转发调用。
		if (upstream !== undefined) {
			// 浅复制消息并覆盖 origin，参数和字节段保持原对象。
			upstream.link.send({ ...message, origin: upstream.origin });
			// 转发后结束，不再构造本地失败。
			return;
		}
		// 构造此调用的断线原因，持有仍可等待重连。
		const error = new ChordError({ code: "unavailable", message: `hold ${this.id}: its upstream link is down` });
		// 通过下游提供端结算调用并回送错误。
		this.#downstream.reply(message.call, { kind: "error", call: message.call, error: wireError(error) });
	}

	/** A downstream `abort` of call `id`, forwarded. */
	// 把下游调用 id 的取消送上游，无返回值；无上游则无动作。
	// 例如调用者取消 call 9，只发 abort，不在中继执行用户方法。
	abort(id: number): void {
		// 保留本次操作开始时的连接记录。
		const upstream = this.#upstream;
		// 可选链使无连接时不发送；连接存在时保留调用编号。
		upstream?.link.send({ kind: "abort", origin: upstream.origin, call: id });
	}

	/** A downstream `retry`, forwarded with its hop budget as it is (a relay visits no object). */
	// 转发 retry 并替换来源编号，无返回值；中继不访问对象，不消耗 hops。
	// 例如 hops=8 穿过中继后仍为 8，真正提供对象的主机才决定下一步。
	retry(message: Extract<Message, { readonly kind: "retry" }>): void {
		// 保留本次操作开始时的连接记录。
		const upstream = this.#upstream;
		// 保留重试预算等字段，只改来源编号。
		upstream?.link.send({ ...message, origin: upstream.origin });
	}

	/** Released downstream: released upstream (its calls with it) and no later link holds it. */
	// 下游主动释放：先退出路径，再在旧连接发 release，无参数返回值。
	// 例如引用释放后不会被新连接重新持有；正在途中的调用由提供端释放规则结束。
	release(): void {
		// 保留本次操作开始时的连接记录。
		const upstream = this.#upstream;
		// 先退出路径，防止后续重连重新持有。
		this.drop();
		// 用事先保存的旧连接发送释放；drop 已把当前记录清空。
		upstream?.link.send({ kind: "release", origin: upstream.origin, hold: this.id });
	}

	/** No later link holds it (gone, or its downstream origin closed, which `closed` tells the upstream links). */
	// 仅本地退出路径并清空上游，无参数返回值；不单独发送消息。
	// 例如下游整个来源关闭由 ProviderSide 发一条 closed，避免每个 hold 分别发 release。
	drop(): void {
		// 清空当前上游，后续调用将按无连接处理。
		this.#upstream = undefined;
		// 路径不再保存本对象，未来 connected 不会访问它。
		this.#path.detach(this);
	}
}
