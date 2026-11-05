// 本文件把跨连接的持有请求归到同一路径，断线后在新连接上重新持有。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的路径与重连管理。
// 职责边界：只保存某条父连接或某个路由地址的当前连接与持有者集合；不解析消息、不分配 hold 编号、不决定路由策略。
// 上游入口：Host 为父连接创建 Path，路由为每个地址创建 Path，并调用 connected/disconnected/unreachable；RemoteObject.attach 与 RelayedHold.start 把自身登记进来。
// 下游依赖：HostLink 提供连接载体；Upstream 的两种实现（RemoteObject、RelayedHold）提供 attach/dropped/unreachable。
// 结果与错误流向：路径通过构造时的 changed 回调上报 attached/dropped/released；断线错误由 Path 创建并传给持有者，最终使调用失败。
//
// 能力清单：
// - type Upstream：路径持有者联合，本地远端对象或替下游中继的持有。
// - type PathEvent：路径事件联合，attached 带 holder，dropped/released 无负载。
// - class Path：link/linked/held 读取状态，attach/detach 增删持有者，connected 让每个持有者重新 attach，disconnected 广播 dropped，unreachable 广播暂时不可达，holders 返回持有者快照。
//
// 组合关系：连接建立后 connected 遍历持有者重新发 hold；连接断开后 disconnected 清空连接并通知所有人等待下一条。
// 示例：const path = new Path((event) => { if (event.kind === "attached") route.resolve(event.holder); }); path.attach(object);
// 建议阅读顺序：先看 Upstream/PathEvent 与字段，再看 attach/detach，最后看 connected/disconnected 的重连语义。
// Paths (§3 recovery): where this host's upstream holds go, the parent link or a route address's link, across links.
// Each new link of a path holds every holder of the path again; when it drops, every holder is told.

import { ChordError } from "../data/index.ts";
import type { HostLink } from "./host-link.ts";
import type { RelayedHold } from "./relay.ts";
import type { RemoteObject } from "./remote-object.ts";

/** What a path holds on its links: one of this host's remote references, or a hold it relays. */
// 联合类型允许本地主机自己的远端对象，或替下游中继的持有；两者都实现路径需要的 attach/dropped/unreachable 方法。
export type Upstream = RemoteObject | RelayedHold;

/**
 * What changed on a path without a link, for its route: a holder attached, its link dropped (its holders went
 * loading), its last holder left.
 */
// 带 kind 标签的联合类型：attached 才带 holder，另两种只描述断线或最后一个持有离开。
export type PathEvent =
	| { readonly kind: "attached"; readonly holder: Upstream }
	| { readonly kind: "dropped" }
	| { readonly kind: "released" };

// 复用无负载的离开事件，避免每次最后一个请求离开都分配对象。
const RELEASED: PathEvent = { kind: "released" };

// 复用断线通知对象。
const DROPPED: PathEvent = { kind: "dropped" };

/**
 * The parent link or one route address: its current link and its holders, held on that link and again on every next
 * one. `changed` runs when it gets a holder without a link, loses its link or its last holder (a route decides whether
 * to resolve), saying which.
 */
export class Path {
	// 保存跨断线仍然存在的请求，以对象身份去重。
	readonly #holders = new Set<Upstream>();
	// 回调由路径所有者提供，路径只报告事件，不自行连接。
	readonly #changed: (event: PathEvent) => void;
	// undefined 表示当前没有连接；不代表此路径从未连接过。
	#link: HostLink | undefined;
	/** Whether it ever had a link: a host never connected to a parent has no parent path to wait on. */
	// 记录历史上是否连接过，断线时不会重置。
	#linked = false;

	// 创建路径并保存事件回调，无网络操作；例：路由用 attached 事件触发地址解析。
	// 参数是接收 PathEvent 且无返回值的函数；构造结果是新 Path 实例。
	constructor(changed: (event: PathEvent) => void) {
		// 保存回调供后续事件使用。
		this.#changed = changed;
	}

	/** The current link while one is open. */
	// 读取当前连接，无副作用；没有连接返回 undefined。例：断线后该值为空，但路径仍保存持有者。
	get link(): HostLink | undefined {
		// 直接返回当前连接对象或 undefined。
		return this.#link;
	}

	/** Whether it had a link once (it may be down now: its holders wait for the next). */
	// 读取是否曾连接过，无副作用；例：从未连接的客户端不能把不存在的父路径当成断线等待。
	get linked(): boolean {
		// 返回连接历史标志。
		return this.#linked;
	}

	/** Whether anything is held over this path. */
	// 读取是否仍有持有者，无副作用；例：路由只在 held 为真时继续重试。
	get held(): boolean {
		// 集合非空便表示路径仍被请求使用。
		return this.#holders.size > 0;
	}

	/** Holds `holder` over this path: on the current link now, and on every next one. */
	// 把 holder 加入路径，没有返回值；有连接便立即持有，没有便通知路径所有者。
	// 例如请求 worker S1 时先加入集合，由回调开始解析 S1；回调或 attach 抛错会向上传播。
	attach(holder: Upstream): void {
		// 登记请求，确保未来连接也会重新持有它。
		this.#holders.add(holder);
		// 没有连接时报告新请求，路由可按请求的调用者决定后续处理。
		if (this.#link === undefined) this.#changed({ kind: "attached", holder });
		// 已有连接时直接把请求挂到该连接。
		else holder.attach(this.#link);
	}

	/** `holder` was released or ended; no later link holds it. */
	// 让 holder 离开路径，无返回值；最后一项离开时通知 released。
	// 例如引用 release 后，后续重连不再替它发送 hold。
	detach(holder: Upstream): void {
		// 删除请求；不在集合中的项被删除也没有效果。
		this.#holders.delete(holder);
		// 集合为空时通知所有者，后续不需要为持有者重试。
		if (this.#holders.size === 0) this.#changed(RELEASED);
	}

	/** `link` is the path's link now: every holder is held on it. */
	// 将 link 作为当前连接并为全部持有者重新发送 hold，无返回值。
	// 例如旧连接断线后 connected(newLink) 会让原请求在新连接上继续；持有回调异常向上传播。
	connected(link: HostLink): void {
		// 记录新连接。
		this.#link = link;
		// 从此保留曾连接过的事实。
		this.#linked = true;
		// 逐个在新连接建立 hold，具体编号由持有者及连接一侧分配。
		for (const holder of this.#holders) holder.attach(link);
	}

	/** `link` closed (its sides ended their calls already): every holder goes loading until the next link. */
	// 处理指定 link 的断线，无返回值；旧连接的迟到通知不影响新连接。
	// 匹配时清空当前连接，通知所有持有者 dropped，再通知路径所有者；例如路由可随后安排重试。
	disconnected(link: HostLink): void {
		// 对象身份不同表示旧连接的通知，立即忽略。
		if (this.#link !== link) return;
		// 先切到无连接状态，持有者随后看到的是断线路径。
		this.#link = undefined;
		// 为这次断线构造共享原因，已发调用可据此失败。
		const error = new ChordError({ code: "unavailable", message: "the link closed" });
		// 通知各请求断线；请求仍在集合中等待下一连接。
		for (const holder of this.#holders) holder.dropped(error);
		// 让路径所有者处理重新解析等策略。
		this.#changed(DROPPED);
	}

	/** Its address cannot be reached for now (a route's `resolve` failed, a suspension): every holder fails waiting. */
	// 把地址暂时无法到达的 error 通知每个持有者，不移除请求，无返回值。
	// 例如路由 resolve 失败后，引用进入等待失败态，仍可等下一条连接。
	unreachable(error: ChordError): void {
		// 仅广播暂时无法到达的原因，不结束持有者。
		for (const holder of this.#holders) holder.unreachable(error);
	}

	/** Every holder, for the host's close. */
	// 返回当前持有者的新数组，无状态修改；例如主机关闭时逐一结束它们。
	// 数组为浅拷贝，元素仍是原来的请求对象。
	holders(): Upstream[] {
		// 用展开生成数组，避免把内部集合直接交给调用者。
		return [...this.#holders];
	}
}
