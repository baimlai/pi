// 本文件表示一台主机的一条双向连接：握手后统一收发协议消息，按消息方向分派给提供端或消费端，并负责分片压缩与心跳。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的连接门面，位于 host 层与 link 层之间。
// 职责边界：管理一条底层 Link 的握手、角色、对端身份、分片上限和消息方向；持有每个 origin 的 ProviderSide 与一个 ConsumerSide，但不解释具体调用语义。
// 上游入口：Host 的 connect/accept 与路由 resolve 创建 HostLink；底层 Channel 回调 opened/message/closed。
// 下游依赖：link 层的 Channel、Part/openPart/originPart；remote 层的 ConsumerSide 与 ProviderSide；host 提供压缩器、incarnation 与错误上报。
// 结果与错误流向：协议错误交给 host.report 并由 Channel 关闭连接；分片超限/畸形以异常向上抛；连接关闭时两个方向分别结束调用与持有。
//
// 能力清单：
// - type LinkRole：parent/child/route 三种建链角色。
// - class HostLink：实现 ChannelHandler；send/close/tick 委托 Channel，part/openPart 处理分片，inflates/inflate 处理异步解压，message 分派消息，drop/revokeUnbound/closed 管理提供端。
// - 模块内 HostLinkOptions 与常量 CALLS：建链选项（不导出）与本端声明的并发调用数。
//
// 组合关系：构造时创建 ConsumerSide 与 Channel，Channel 收到 hello 后 opened 打开消费窗口；入站 hold 按 origin 取得或创建 ProviderSide，回复类消息交给 ConsumerSide。
// 示例：const link = new HostLink(host, rawLink, { role: "parent", principal, trusted: false, codec, limits }, ctx);
// 建议阅读顺序：先看 LinkRole 与字段，再看 message 的分派表，然后 part/inflates/inflate，最后 closed 与 #hold。
// One link of a host (§3, §22): its channel, its role, the peer's principal, its limits per part, and both sides: a
// provider side per origin (holds and calls the peer sent, its own or a relay's for one of its downstream links) and
// the consumer side (holds and calls this host sent). Message kinds are directional, so each goes to its side; a
// revocation is honoured from the parent only. Parts are made and opened here, with the host's compressor, or inflated
// asynchronously for their owner when the host has none.

// 这些导入分别提供上下文类型、协议数据、主机内部接口、JSON 值，以及 Channel/分片/消息等链路基础设施。
import type { Context } from "../context/index.ts";
import type { ChordError, Principal } from "../data/index.ts";
import type { AnyHost } from "../host/internal.ts";
import type { JsonValue } from "../json.ts";
import {
	Channel,
	type ChannelHandler,
	type Codec,
	DeflatedPart,
	inflateAsync,
	type Limits,
	type Link,
	type Message,
	openPart,
	originPart,
	type Part,
} from "../link/internal.ts";
import { ConsumerSide } from "./consumer.ts";
import { ProviderSide } from "./provider.ts";

/**
 * How a link was made: `parent` by `connect` (holds arriving on it may name whom they act for), `child` by `accept`,
 * `route` by a route's `resolve`.
 */
// 三个字面量组成可区分联合：parent 指向父主机的连接，child 是父主机接受的子连接，route 是路由地址解析出的连接。
// 角色决定哪些字段可信，例如只有 parent 上的 revoke 会被执行，只有 parent/route 上允许出现 origin。
export type LinkRole = "parent" | "child" | "route";

/** What a link is made with. */
// 建链选项对象；readonly 只约束 TypeScript 赋值，运行时不会冻结。
type HostLinkOptions = {
	// 本端在这条连接中的角色。
	readonly role: LinkRole;
	/** The peer, as this host stamps it. */
	// 对端身份，由本主机在握手后盖章，后续授权判断都以它为准。
	readonly principal: Principal;
	/** Skips the message schema check (framing and the owners' checks still run). */
	// trusted 为真时跳过消息 schema 检查；这是信任边界上的决定，不能由网络输入自行声明。
	readonly trusted: boolean;
	// 链路编解码器，决定消息在字节与对象之间如何转换。
	readonly codec: Codec;
	// 每个分片允许的大小上限，由建链时的信任级别与显式配置决定，不来自对端 hello。
	readonly limits: Limits;
};

/** How many concurrent calls a host accepts on each of its links, announced in `hello`. */
// 本主机在每条连接上允许的并发调用数；它写进 hello 告诉对端，对端的调用窗口据此设限。
const CALLS = 256;

/**
 * A link of a host, both directions over one channel. Closing it, from either end, ends both sides: the provider sides
 * release the peer's holds, the consumer side's holds go loading until their path's next link.
 */
// 一条主机连接：实现 ChannelHandler，由 Channel 在握手完成、收到消息、连接关闭时回调。
// 同一条连接上两个方向并存：consumer 管本主机发出的请求，provider（按 origin 分组）管对端发来的请求。
export class HostLink implements ChannelHandler {
	// 所属主机，提供批次、压缩器、身份和上报入口。
	readonly host: AnyHost;
	// 建链角色，之后的 origin/revoke 规则依赖它。
	readonly role: LinkRole;
	// 对端身份。
	readonly principal: Principal;
	/** Whether the link is trusted: activation chains on holds arriving on it are honoured (Q5). */
	// 信任标记；只有可信连接上的 hold 才能携带激活链。
	readonly trusted: boolean;
	/** The limits per part of what arrives on this link (Q2). */
	// 本连接入站分片的解码上限。
	readonly limits: Limits;
	/** The parent of the work arriving on this link. */
	// 处理这条链路上入站工作时的父上下文，用于追踪与取消。
	readonly context: Context;
	// 消费端：本主机通过这条连接发出的 hold 与调用。
	readonly consumer: ConsumerSide;
	/**
	 * The provider side of each origin the peer sent holds for, made by its first and dropped once it holds nothing;
	 * `origin` is honoured only on parent and route links, where a relay's messages arrive (decision "Origins only from
	 * relays").
	 */
	// Map 的键是 origin：0 表示对端自己的消息，非零值表示对端替某个下游来源中继的消息。
	// 每个 origin 单独一个 ProviderSide，因而各自拥有独立的调用窗口、编号与中继记录。
	readonly #providers = new Map<number, ProviderSide>();
	// 底层 Channel，负责握手、编解码、消息检查、心跳和顺序处理。
	readonly #channel: Channel;
	/** Aborted when the link closes: stops its asynchronous inflates at once. */
	// 连接关闭时 abort，正在等待的异步解压立即结束，避免关闭后继续回调。
	readonly #closing = new AbortController();

	// 创建连接：输入主机、底层 Link、建链选项与上下文；构造时同时创建消费端和 Channel，并立即启动握手。
	// 构造不返回 Promise；start 会发送 hello 并注册底层回调，若连接已关闭，Channel 会在 start 中同步调用 closed。
	// 例：root 调用 connect 拿到底层 link 后，用 new HostLink(host, link, { role: "parent", ... }, ctx) 建立父连接。
	constructor(host: AnyHost, link: Link, options: HostLinkOptions, context: Context) {
		// 保存主机引用，供后续压缩、上报和批次操作使用。
		this.host = host;
		// 保存角色，后续消息分派要读取。
		this.role = options.role;
		// 保存对端身份。
		this.principal = options.principal;
		// 保存信任标记。
		this.trusted = options.trusted;
		// 保存分片上限。
		this.limits = options.limits;
		// 保存上下文。
		this.context = context;
		// 先创建消费端，因为 Channel 启动后可能立刻触发回调。
		this.consumer = new ConsumerSide(this);
		// 解构出编解码器和信任标记，减少重复的属性访问。
		const { codec, trusted } = options;
		// 协议错误统一交给主机的 report，由上层记录并决定关闭连接。
		const report = (error: unknown): void => host.report({ kind: "protocol_error", error });
		// Channel 选项：编解码器、本主机 incarnation、本端接受的调用数、是否跳过 schema 检查、错误上报函数。
		const channel = { codec, incarnation: host.incarnation, calls: CALLS, trusted, report };
		// 创建 Channel，把它自己作为消息处理者。
		this.#channel = new Channel(link, this, channel, context);
		// 最后启动：若连接在构造期间已关闭，start 会立即回调 closed，此时前面的字段必须已经就绪。
		// Last: a link closed already calls `closed` at once.
		this.#channel.start();
	}

	/** The peer's incarnation, from its `hello`. */
	// 读取对端 incarnation；握手前为空字符串。
	get peer(): string {
		// 直接委托 Channel 的状态。
		return this.#channel.peer;
	}

	/** Whether the peer's `hello` arrived (it may have arrived while the link was made). */
	// 读取握手是否完成；连接建立期间对端 hello 可能已经到达。
	get greeted(): boolean {
		// Channel.opened 表示状态处于 open。
		return this.#channel.opened;
	}

	/** Whether the link is open; one closed already when made is not kept. */
	// 读取连接是否仍可用；注意与 greeted 不同，greeted 只表示握手完成。
	get open(): boolean {
		// 取反底层 closed 标志。
		return !this.#channel.closed;
	}

	// 发送一条已构造好的协议消息，无返回值；握手前由 Channel 暂存，关闭后丢弃。
	send(message: Message): void {
		// 委托 Channel，由它负责编码与排队。
		this.#channel.send(message);
	}

	// 主动关闭连接，无返回值；两个方向随后都会收到一次 closed 回调。
	close(): void {
		// 关闭底层 Channel，进而关闭传输层 link。
		this.#channel.close();
	}

	/** The heartbeat (see `Channel.tick`). */
	// 心跳由主机定时器驱动：now 为当前时间，ping 为静默多久后发 ping，close 为静默多久后关闭。
	tick(now: number, ping: number, close: number): void {
		// 全部逻辑在 Channel.tick 中。
		this.#channel.tick(now, ping, close);
	}

	// 对端 hello 到达后由 Channel 调用：打开消费端调用窗口，并通知主机登记这条连接。
	opened(): void {
		// 用对端声明的并发数初始化消费端窗口，之前排队的调用可能立即发出。
		this.consumer.opened(this.#channel.peerCalls);
		// 主机登记这条连接；路由连接会在这里通知等待该地址的路由。
		this.host.linkOpened(this);
	}

	/** A JSON part this host originates on this link: deflated above the threshold when the host compresses. */
	// 把 JSON 字符串打包成本主机产生的分片；输入 json 与上下文，返回 Part。
	// 主机配置了同步压缩器时，超过阈值的正文会被压缩；否则保持原样。
	part(json: string, context: Context): Part {
		// originPart 统一处理压缩决策。
		return originPart(json, this.host.compression, context);
	}

	/** The JSON of a part arriving on this link, where it is owned, within `limits`. Throws as `openPart` does. */
	// 打开入站分片：输入分片、上限和上下文，返回字符串或字节；超限、类型不符或解压失败会抛错。
	// 这是网络输入的信任边界：openPart 在这里执行实际检查。
	openPart(part: Part, limits: Limits, context: Context): string | Uint8Array {
		// 使用本主机的压缩器与传入的上限解码。
		return openPart(part, limits, this.host.compression, context);
	}

	/**
	 * Whether `part` waits for an asynchronous inflate before its owner can open it: deflated, not inflated yet, on a
	 * host without a synchronous compressor, and within the wire limit (past it, opening refuses it uninflated).
	 */
	// 判断分片是否需要先异步解压；返回类型谓词 part is DeflatedPart，调用后 TypeScript 会把参数收窄为 DeflatedPart。
	// 运行时仍用 instanceof 检查，因为 part 来自网络，不能只信类型；四个条件必须同时成立。
	inflates(part: Part | undefined, limits: Limits): part is DeflatedPart {
		// 逐项说明：必须是 DeflatedPart 实例、尚未解压、主机关闭同步压缩器、且未超过 part 上限。
		// 超过上限时交给 openPart 直接拒绝，不再浪费内存解压。
		return (
			part instanceof DeflatedPart &&
			part.inflated === undefined &&
			this.host.compression === undefined &&
			part.bytes.byteLength <= limits.part
		);
	}

	/**
	 * Inflates `parts` (deflated parts an owner admitted, each with its decoded limit) one after another with the web
	 * `DecompressionStream`, then lets the owner handle its message again (`handle`); the channel holds the link's later
	 * messages until then. A link closed meanwhile stops the inflate at once and drops the message (race 13).
	 */
	// 异步解压一组分片：输入为 [分片, 解码上限] 的只读数组和重新处理消息的回调，返回 Promise<void>。
	// 这是异步路径：逐个 await 解压，全部完成后调用 handle；若期间连接关闭，signal 已 abort，直接返回并丢弃消息。
	async inflate(parts: readonly (readonly [DeflatedPart, number])[], handle: () => void): Promise<void> {
		// 读取关闭控制器的信号；abort 会传播给 inflateAsync。
		const { signal } = this.#closing;
		// 顺序解压，避免同时占用过多内存；for...of 按数组顺序执行。
		for (const [part, limit] of parts) {
			// 等待单个分片解压完成；失败会以异常向上传播，Channel 会把它当作协议错误。
			await inflateAsync(part, limit, signal, this.context);
			// 解压期间连接可能已关闭：此时不再继续，也不调用 handle。
			if (signal.aborted) return;
		}
		// 所有分片就绪后，让消息所有者重新执行处理；Channel 会等到返回的 Promise 结算才处理后续消息。
		handle();
	}

	/**
	 * A message from the peer, to its side. One whose owner first waits for an asynchronous inflate returns its promise:
	 * the channel holds later messages until it settled.
	 */
	// 处理一条入站消息；返回 void 表示同步完成，返回 Promise 表示需要异步解压，Channel 会等待它结算。
	// 抛出的异常由 Channel 视为协议错误并关闭连接。
	message(message: Message): void | Promise<void> {
		// 子连接（tab、TUI）不中继任何东西：带 origin 的消息会让每个来源得到独立窗口，破坏子连接语义。
		// A child (a tab, a TUI) relays nothing: its origins would each get their own call window and record.
		// "origin" in message 是收窄写法：先确认联合成员含有该字段，再访问值。
		if (this.role === "child" && "origin" in message && message.origin !== undefined) {
			// 直接抛出，由 Channel 上报并关闭连接。
			throw new Error(`${message.kind}: an origin on a child link`);
		}
		// switch 按消息 kind 分派；TypeScript 在每个 case 中收窄 message 的具体成员类型。
		switch (message.kind) {
			case "hold":
				// 持有请求：按 origin 找到或创建提供端。
				this.#hold(message);
				break;
			case "release":
			case "call":
			case "abort":
			case "retry":
			case "ack":
				// 这些消息都属于某个 origin；?? 0 把缺省的 origin 视为对端自己。
				// 可选链 ?. 在找不到提供端时返回 undefined，表示该 origin 没有已知的持有编号。
				// An origin this link has no holds for: its ids are unknown (Q1).
				return this.#providers.get(message.origin ?? 0)?.message(message);
			case "closed":
				// 某个 origin 的全部持有结束：先通知提供端，再从表中删除。
				this.#providers.get(message.origin)?.closed();
				this.#providers.delete(message.origin);
				break;
			case "bound":
			case "state":
			case "failed":
			case "loading":
			case "result":
			case "error":
			case "gone":
				// 这些是本主机发出的 hold 的回复，交给消费端。
				return this.consumer.message(message);
			case "revoke":
				// 只有父主机可以撤销身份；子连接或路由连接发来的 revoke 一律忽略，避免越权。
				// Only the parent revokes; a child or a route cannot (race 6).
				// revocation 的 JSON 结构已由消息 schema 检查；这里的断言只是告知 TypeScript 具体类型。
				// JSON from the parent, the app's revocation type there as here (the same app code).
				if (this.role === "parent") this.host.revoke(message.revocation as JsonValue, this.context);
				break;
			default:
				// hello、ping、pong 属于 Channel 自身，不会到达这里。
				// `hello`, `ping` and `pong` are the channel's.
				break;
		}
	}

	/** `provider` holds nothing any more: it goes (its relay's upstream links are told `closed`). */
	// 提供端已无任何持有时从表中移除；输入要删除的 ProviderSide，无返回值。
	// 先比较身份再删除，防止同一 origin 上新建的提供端被旧实例误删。
	drop(provider: ProviderSide): void {
		// 当前登记的不是这个实例时直接返回，说明它已被替换或已删除。
		if (this.#providers.get(provider.origin) !== provider) return;
		// 删除该 origin 的登记。
		this.#providers.delete(provider.origin);
		// 通知提供端关闭，让它通知中继的上游。
		provider.closed();
	}

	/** Ends the holds on this link that hold nothing and act for a principal `revoked` names (§4). */
	// 身份被撤销时清理本连接上未绑定的持有；输入判断函数与错误原因，无返回值。
	revokeUnbound(revoked: (principal: Principal) => boolean, error: ChordError): void {
		// 遍历所有 origin 的提供端，由它们各自检查自己的持有。
		for (const provider of this.#providers.values()) provider.revokeUnbound(revoked, error);
	}

	// 连接关闭回调，由 Channel 调用一次；终止异步解压、结束提供端与消费端，并通知主机。
	closed(): void {
		// 先 abort，使进行中的异步解压尽快停止。
		this.#closing.abort();
		// 通知每个提供端关闭：对端发来的持有与调用都结束。
		for (const provider of this.#providers.values()) provider.closed();
		// 清空按 origin 的登记表。
		this.#providers.clear();
		// 消费端处理本主机发出的持有：它们转入 loading，等待路径的下一条连接。
		this.consumer.closed();
		// 通知主机把这条连接从登记中移除。
		this.host.unlink(this);
	}

	/** A `hold` goes to its origin's provider side, made for the origin's first. */
	// 把 hold 消息交给对应 origin 的提供端；输入已收窄为 hold 分支的消息，无返回值。
	// 若该 origin 还没有提供端，就新建一个，并给它本端声明的调用窗口 CALLS。
	#hold(message: Extract<Message, { readonly kind: "hold" }>): void {
		// Extract 从 Message 联合中筛出 kind 为 "hold" 的成员；缺少 origin 时按 0 处理。
		const origin = message.origin ?? 0;
		// 先查找已有提供端。
		let provider = this.#providers.get(origin);
		// 第一次见到该 origin 时才创建。
		if (provider === undefined) {
			// 提供端记录本连接、origin 和对端可接受的并发调用数。
			provider = new ProviderSide(this, origin, CALLS);
			// 登记后供后续消息复用。
			this.#providers.set(origin, provider);
		}
		// 交给提供端处理持有请求。
		provider.message(message);
	}
}
