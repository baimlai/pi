// 本文件实现一条连接的消费端：登记本主机自己发出的远端持有，在调用窗口内发送调用，并把 bound/state 消息成批应用到副本后确认。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的消费端，每个 HostLink 创建一个实例。
// 职责边界：只处理本主机主动发出的 hold 与调用；带 origin 的消息属于中继，转发给 host.relays 中对应的提供端，不在本类解析。
// 上游入口：RemoteObject.attach 调用 attach，RemoteObject.call 调用 call，HostLink.message 把 bound/state/failed/loading/result/error/gone 交给本类。
// 下游依赖：CallWindow（并发名额）、RemoteObject（准备与采用副本）、HostLink（发送与异步解压）、链路消息工具（解析分片）。
// 结果与错误流向：调用结果按 result/error 结算 Promise；单个条目 too_large 只失败该对象；畸形回复先拒绝调用再把错误抛给 Channel 作为协议错误关闭连接。
//
// 能力清单：
// - class ConsumerSide：attach 发 hold，call 发起调用，release/retry/forget 管理持有，opened 打开窗口，message 分派入站回复，closed 统一失败全部调用。
// - 私有类型 Reply/OutgoingCall：回复联合与调用生命周期数据，仅本文件使用。
//
// 组合关系：call 先过 CallWindow，获得名额后 #send 分配调用编号；回复经 #reply 结算并 freed；bound/state 先 #deflated 异步解压，再由 #bound/#state 准备并在一个批次中 adopt，最后 ack。
// 示例：const side = new ConsumerSide(link); side.opened(256); const id = side.attach(object, undefined); await side.call(id, 0, methodData, args, ctx);
// 建议阅读顺序：先看 OutgoingCall 与字段，再看 attach/call 的发送路径，然后 message/#bound/#state，最后 closed 与 #failCalls 的清理路径。
// The consumer side of a link (§7, §22, W1): the holds this host's own remote references sent on it, by this side's
// ids, the calls through them within the peer's call window, and each `bound` and `state` message applied to their
// replicas as one batch, then acknowledged. Messages with an origin answer holds this host relays: they go to that
// origin's provider side. On a host without a compressor, the deflated parts of this host's own holds and calls are
// inflated asynchronously first, and the message is handled once they are.

// 导入上下文、合约方法数据、错误工具、链路消息/分片工具，以及调用窗口与相邻的 hold、连接和远端对象类型。
import type { Context } from "../context/index.ts";
import { type MethodData, takesNoArgs } from "../contracts/internal.ts";
import { ChordError, isChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import {
	type BoundEntry,
	type ConsumerMessage,
	type DeflatedPart,
	errorFromWire,
	type Message,
	type Part,
	parsePayload,
	payloadPart,
	type StateEntry,
} from "../link/internal.ts";
import { CallWindow } from "./calls.ts";
import { actingFor } from "./hold.ts";
import type { HostLink } from "./host-link.ts";
import type { RemoteObject } from "./remote-object.ts";

/** A reply to a call. */
// 从消息联合中筛出 result 与 error 两种回复，后续 #reply 只处理这两类。
type Reply = Extract<Message, { readonly kind: "result" | "error" }>;

/**
 * A call through this side: waiting for a slot of the call window (no id yet), then in flight under its id until its
 * reply, its abort, its hold's release or `gone`, or the link's close.
 */
// 一个出站调用的完整生命周期数据；它在窗口排队时没有 id，真正发送时才分配。
type OutgoingCall = {
	// 所属持有所在消费端的编号。
	readonly hold: number;
	/** The method's index in the bound variant and its arguments' part. */
	// 方法在已绑定 variant 中的索引，避免传方法名字符串。
	readonly method: number;
	// 参数分片；无参数方法为 undefined。
	readonly args: Part | undefined;
	// 参数中携带的原始字节段（对应 bytes() 叶子），没有则为 undefined。
	readonly segments: readonly Uint8Array[] | undefined;
	// 结算调用方 Promise 的两个函数。
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	// 发送后分配；undefined 表示仍在窗口排队。
	id: number | undefined;
	// 窗口获得名额时调用的发送函数。
	send(): void;
};

/**
 * The consumer side of one link. Ids are its own counters, from 0; a reply naming an id this side gave up is ignored
 * (Q1). When the link closes, every call rejects `unavailable` (never resent) and its path tells every holder.
 */
// 每条连接一个实例，由 HostLink 构造；它只管理本主机主动发起的请求，中继请求由提供端另行处理。
export class ConsumerSide {
	// 所属连接，发送消息、读取角色与上限都通过它。
	readonly #link: HostLink;
	// 持有编号到远端对象的映射：本主机在这条连接上发出的 hold。
	readonly #entries = new Map<number, RemoteObject>();
	// 调用编号到在途调用的映射；只有已发送的调用在这里。
	readonly #calls = new Map<number, OutgoingCall>();
	// 对端声明窗口限制的先进先出调用队列。
	readonly #window = new CallWindow<OutgoingCall>();
	// 下一个 hold 编号，只增不减。
	#nextHold = 0;
	// 下一个调用编号，只增不减。
	#nextCall = 0;

	// 创建消费端：输入所属连接并保存；不做网络操作，连接启动后由 HostLink 调用 opened 打开窗口。
	// 例：HostLink 构造时 new ConsumerSide(this)，随后对端 hello 到达，opened(256) 放行排队调用。
	constructor(link: HostLink) {
		// 保存连接引用。
		this.#link = link;
	}

	/**
	 * Holds `holder` on this link and returns its new id: its first hold, or a re-hold on a new link; `chain`: the
	 * activation chain it is held for, if any (Q5).
	 */
	// 在连接上发出 hold 请求；输入要持有的远端对象和可选激活链，返回本次 hold 的编号。
	// 副作用是登记编号并立即发送 hold 消息；编号由消费端分配，与提供端无关。
	attach(holder: RemoteObject, chain: string[] | undefined): number {
		// 先取当前编号再自增，保证每条连接内唯一。
		const id = this.#nextHold++;
		// 登记对象，之后收到 bound/state/failed 等消息按编号找回它。
		this.#entries.set(id, holder);
		// 路由连接上需要声明调用者身份；其他角色返回空对象。
		const acting = actingFor(this.#link, holder.caller);
		// 组装并发送 hold：hold.request 含类型、版本、指纹、参数和地址。
		// 条件展开 `...(... ? {} : { chain })` 在无链时不发送该字段，而不是发送 undefined。
		this.#link.send({
			kind: "hold",
			hold: id,
			...holder.request,
			...acting,
			...(chain === undefined ? {} : { chain }),
		});
		// 返回编号供调用与释放使用。
		return id;
	}

	/**
	 * Calls method `method` (an index into the bound variant) on hold `hold` with `args`: left out for a method without
	 * arguments, with byte segments when its argument schema has a `bytes()` leaf, deflated above the threshold except on
	 * the parent link. The result is parsed here. The caller's cancellation rejects it at once and sends `abort` when it
	 * is in flight.
	 */
	// 发起一次远端方法调用；输入持有编号、方法索引、方法数据、参数与上下文，返回结果 Promise。
	// 调用先进入窗口排队，获得名额后才发送；调用方取消会立即 reject，并在已发送时补发 abort。
	call(hold: number, method: number, data: MethodData, args: unknown, context: Context): Promise<unknown> {
		// 上下文可能带取消信号；没有信号时为 undefined。
		const signal = context.abortSignal;
		// 若调用开始前已取消，这里同步抛出取消原因。
		signal?.throwIfAborted();
		// 无参数方法不序列化参数；否则按参数 schema 是否含 bytes() 叶子决定是否拆出字节段。
		const payload = takesNoArgs(data) ? undefined : payloadPart(args, data.args.bytes);
		// Up a parent link they travel uncompressed: the parent may have accepted this host as a child, and child links
		// refuse compressed parts (§22).
		// 父连接上的参数保持明文：对端可能把本主机当作子连接，而子连接拒绝压缩分片。
		const link = this.#link;
		// 三元表达式先判断是否有参数，再判断连接角色；link.part 可能按阈值压缩。
		const part =
			payload === undefined ? undefined : link.role === "parent" ? payload.json : link.part(payload.json, context);
		// Promise.withResolvers 一次性取出 promise 与两个结算函数，便于把结算交给调用表。
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		// 取消回调：移出窗口/发送 abort，再用取消原因拒绝调用方。
		const cancel = (): void => {
			// 从窗口或在途表移除，必要时发送 abort。
			this.#cancel(call);
			// signal 一定存在，因为只有存在信号时才注册该监听器；! 是非空断言。
			reject(signal!.reason);
		};
		// 结算前移除取消监听，避免已完成的调用再次触发。
		const done = (): void => signal?.removeEventListener("abort", cancel);
		// 构造调用数据；resolve/reject 包一层，确保先解绑监听器。
		const call: OutgoingCall = {
			// 记录所属持有。
			hold,
			// 记录方法索引。
			method,
			// 参数分片或 undefined。
			args: part,
			// 原始字节段原样保存。
			segments: payload?.segments,
			// 成功路径：解绑监听器后结算。
			resolve: (value) => {
				done();
				resolve(value);
			},
			// 失败路径：同样先解绑监听器。
			reject: (error) => {
				done();
				reject(error);
			},
			// 排队阶段还没有调用编号。
			id: undefined,
			// send 用箭头函数捕获 this 和 call，交给窗口在有名额时调用。
			send: () => this.#send(call),
		};
		// once: true 保证监听器最多执行一次。
		signal?.addEventListener("abort", cancel, { once: true });
		// 提交窗口；若已有名额且队列为空会同步调用 send。
		this.#window.submit(call);
		// 返回 Promise，调用方只关心最终结果。
		return promise;
	}

	/** Hold `hold` was released: the provider is told, its calls fail with `error`. */
	// 释放一个持有：先通知提供端，再在本地删除登记并让相关调用以 error 失败。
	release(hold: number, error: ChordError): void {
		// 发送 release 消息；提供端会释放对应对象与调用。
		this.#link.send({ kind: "release", hold });
		// 本地清理持有与调用。
		this.forget(hold, error);
	}

	/** `ref.retry()` on a failed hold, with `hops` left of its budget: the provider is asked for an attempt now. */
	// 请求提供端立即重试；hops 是剩余跳数预算，中继会原样转发而不消耗。
	retry(hold: number, hops: number): void {
		// 只发送请求，不在本地改变状态；结果通过后续 bound/failed 消息回来。
		this.#link.send({ kind: "retry", hold, hops });
	}

	/** Drops hold `hold` from the tables; its calls, in flight and waiting, fail with `error` and free their slots. */
	// 从消费端删除持有登记，并让该持有的所有调用失败；无返回值。
	forget(hold: number, error: ChordError): void {
		// 删除对象登记，后续迟到消息按 Q1 被忽略。
		this.#entries.delete(hold);
		// 统一结算该持有的调用。
		this.#failCalls(hold, error);
	}

	/** The peer's `hello` arrived: calls go out within its window. */
	// 对端 hello 到达后设置调用窗口容量；排队调用可能在此刻同步发出。
	opened(calls: number): void {
		// 委托窗口保存上限并排空队列。
		this.#window.opened(calls);
	}

	/**
	 * Handles one message from the provider: this host's own, or (with an origin) one for a relayed hold. A `bound`,
	 * `state` or `result` with deflated parts to inflate asynchronously returns that promise and is handled after it.
	 */
	// 处理来自提供端的消息；无返回值表示同步完成，返回 Promise 表示等待异步解压。
	message(message: ConsumerMessage): void | Promise<void> {
		// 带 origin 的消息属于本主机替下游中继的持有，转交对应中继，而不是本连接的 entries。
		// 可选链在找不到中继时静默丢弃，这是已失联来源的迟到消息。
		if (message.origin !== undefined) {
			this.#link.host.relays.get(message.origin)?.forward(message, this.#link);
			return;
		}
		// 按 kind 分派给具体处理函数；TypeScript 在 case 中收窄 message 类型。
		switch (message.kind) {
			case "bound":
			case "state": {
				// 先扫描是否有需要异步解压的分片；没有返回 undefined。
				const deflated = this.#deflated(message.holds);
				// 有则等解压完成后用同一条消息重新进入本方法。
				if (deflated !== undefined) return this.#link.inflate(deflated, () => this.message(message));
				// 首次绑定或重新绑定。
				if (message.kind === "bound") this.#bound(message.holds);
				// 普通状态变化。
				else this.#state(message.holds);
				break;
			}
			case "failed":
				// 提供端对象失败或依赖等待。
				this.#failed(message);
				break;
			case "loading":
				// 提供端对象开始新一轮尝试。
				this.#loading(message.hold);
				break;
			case "result":
			case "error":
				// 调用回复，可能同样需要异步解压。
				return this.#reply(message);
			case "gone":
				// 持有永久结束。
				this.#gone(message);
				break;
		}
	}

	/** The link closed: calls in flight and waiting reject `unavailable` (never resent, §7); the tables are dropped. */
	// 连接关闭：在途与排队调用都以 unavailable 失败，不自动重发；持有登记清空，等路径下一条连接重新持有。
	closed(): void {
		// 创建统一原因，所有调用共享同一个错误对象。
		const error = new ChordError({ code: "unavailable", message: "the link closed" });
		// 合并两张来源：已发送调用和窗口中等待的调用；展开先取快照，避免清空时边遍历边修改。
		const calls = [...this.#calls.values(), ...this.#window.clear()];
		// 清空在途表。
		this.#calls.clear();
		// 清空持有登记；对象的 loading 状态由 Path 通知。
		this.#entries.clear();
		// 逐个拒绝调用方。
		for (const call of calls) call.reject(error);
	}

	/** Sends a call that got its slot, with the next id. */
	// 窗口放行后真正发送调用：分配编号、登记在途表并发送 call 消息。
	#send(call: OutgoingCall): void {
		// 取当前调用编号并自增。
		const id = this.#nextCall++;
		// 把编号写回调用对象，后续回复按它查找。
		call.id = id;
		// 登记为在途，连接关闭或释放时可统一失败。
		this.#calls.set(id, call);
		// 解构出消息字段。
		const { hold, method, args, segments } = call;
		// 条件展开只在字段存在时加入消息，避免发送 undefined。
		this.#link.send({
			kind: "call",
			call: id,
			hold,
			method,
			...(args === undefined ? {} : { args }),
			...(segments === undefined ? {} : { segments }),
		});
	}

	/**
	 * Cancels `call`: a waiting one leaves the window and nothing is sent; one in flight sends `abort` and frees its
	 * slot. Settling the caller is the caller's.
	 */
	// 取消调用的传输部分；调用方 Promise 的结算由 call 内的 cancel 回调负责。
	#cancel(call: OutgoingCall): void {
		// id 未分配表示仍在排队：只从窗口移除，对端毫不知情。
		if (call.id === undefined) {
			this.#window.remove(call);
			return;
		}
		// 已发送：从在途表删除；返回 false 表示回复已经到达并结算，取消无效果。
		if (!this.#calls.delete(call.id)) return;
		// 通知提供端停止执行。
		this.#link.send({ kind: "abort", call: call.id });
		// 归还窗口名额，让后续排队调用前进。
		this.#window.freed();
	}

	/**
	 * The deflated parts of this side's own holds in `entries` that wait for an asynchronous inflate, each with the
	 * link's decoded limit; `undefined` when none does (nothing allocated). Entries of holds this side gave up are not
	 * inflated (Q1).
	 */
	// 收集需要异步解压的入站分片，返回 [分片, 解码上限] 数组或 undefined；不修改状态。
	// 只处理本消费端仍登记的持有，已放弃的编号直接跳过，避免为迟到消息浪费解压。
	#deflated(entries: readonly (BoundEntry | StateEntry)[]): [DeflatedPart, number][] | undefined {
		// 读取连接的分片上限。
		const { limits } = this.#link;
		// 延迟分配结果数组；没有分片时不产生垃圾。
		let deflated: [DeflatedPart, number][] | undefined;
		// 逐个持有条目检查。
		for (const entry of entries) {
			// 不是本消费端发出的持有就跳过（可能是已释放的编号）。
			if (!this.#entries.has(entry.hold)) continue;
			// bound 条目的成员带 value，state 条目的成员带 ops；"value" in member 是收窄判别。
			for (const member of entry.members) {
				// 取出该成员实际的分片。
				const part = "value" in member ? member.value : member.ops;
				// 类型谓词 inflates 会把 part 收窄为 DeflatedPart。
				if (!this.#link.inflates(part, limits)) continue;
				// 第一次命中时才创建数组。
				deflated ??= [];
				// 记录分片与本连接的解码上限。
				deflated.push([part, limits.decoded]);
			}
		}
		// 返回收集结果。
		return deflated;
	}

	/**
	 * One `bound` message: every entry prepared first (one that does not fit closes the link before anything changed)
	 * and applied in one batch; then the references go live, and the message is acknowledged. An entry with a part past
	 * the link's limits fails only its hold (`too_large/part`); the others apply.
	 */
	// 处理一条 bound 消息：先全部准备（协议错误在任何改动前抛出），再在主机的一个批次里统一采用，最后确认。
	// 单个条目超限只让该对象失败，不影响同一消息里的其他持有。
	#bound(holds: readonly BoundEntry[]): void {
		// 收集每个条目的采用函数，稍后在批次中执行。
		const adoptions: (() => void)[] = [];
		// 记录本次成功绑定的对象，批次结束后让它们进入 live。
		const bound: RemoteObject[] = [];
		// 记录超限的对象与错误，批次后单独处理。
		let oversized: [RemoteObject, ChordError][] | undefined;
		// 逐条准备。
		for (const entry of holds) {
			// 按 hold 编号找回本地对象；未知编号说明持有已放弃。
			const holder = this.#entries.get(entry.hold);
			// 已放弃的编号直接跳过。
			if (holder === undefined) continue;
			try {
				// prepareBound 解析快照并返回“批次内应用”的闭包；它本身不改变可观察状态。
				adoptions.push(holder.prepareBound(entry, this.#link));
			} catch (error) {
				// 只把 too_large 当作可恢复的条目错误；其他错误是协议错误，应关闭连接。
				// isChordError 带 code 时是类型谓词，catch 变量因此收窄为 too_large 变体。
				if (!isChordError(error, "too_large")) throw error;
				// 延迟分配超限列表。
				oversized ??= [];
				// 记下该对象与错误，批次后再让它失败。
				oversized.push([holder, error]);
				// 跳过该条目的其余处理。
				continue;
			}
			// 准备成功，记入待激活列表。
			bound.push(holder);
		}
		// 在同一个主机批次里应用所有采用函数：watch 与 derive 不会看到半个快照。
		this.#adopt(adoptions);
		// After the batch: the references go live with every replica of the message in place.
		// 批次结束后才转 live：此时所有副本都已就位，排队的调用和依赖可以继续。
		for (const holder of bound) holder.wentLive();
		// 超限对象各自释放并进入 broken 失败。
		for (const [holder, error] of oversized ?? []) holder.tooLarge(error);
		// 确认收到；提供端据此推进自己的 ack 窗口。
		this.#link.send({ kind: "ack" });
	}

	/** One `state` message, as `#bound` does it. */
	// 处理一条 state 消息，流程与 #bound 相同：准备、成批采用、处理超限、确认。
	#state(holds: readonly StateEntry[]): void {
		// 收集采用函数。
		const adoptions: (() => void)[] = [];
		// 收集超限条目。
		let oversized: [RemoteObject, ChordError][] | undefined;
		// 逐条准备。
		for (const entry of holds) {
			// 找回对象。
			const holder = this.#entries.get(entry.hold);
			// 未知编号跳过。
			if (holder === undefined) continue;
			try {
				// prepare 解码操作并返回采用闭包，暂不改变状态。
				adoptions.push(holder.prepare(entry, this.#link));
			} catch (error) {
				// 非超限错误向上抛，成为协议错误。
				if (!isChordError(error, "too_large")) throw error;
				// 记录超限条目。
				oversized ??= [];
				oversized.push([holder, error]);
			}
		}
		// 一个批次内采用全部变化。
		this.#adopt(adoptions);
		// 超限对象单独失败。
		for (const [holder, error] of oversized ?? []) holder.tooLarge(error);
		// 确认。
		this.#link.send({ kind: "ack" });
	}

	/** Applies prepared entries in one batch of this host, so no watch or derive sees half a provider commit (W1). */
	// 在一个主机批次中执行所有采用函数；没有条目时不创建空批次。
	#adopt(adoptions: readonly (() => void)[]): void {
		// 空数组直接返回，避免无意义提交。
		if (adoptions.length === 0) return;
		// batch.commit 先运行采用，再同步投递受影响的 watch/derive 帧。
		this.#link.host.batch.commit(() => {
			// 按准备顺序应用。
			for (const adopt of adoptions) adopt();
		}, this.#link.context);
	}

	/**
	 * `loading`: the hold's object, or its relay's upstream, starts over; its calls still waiting for a slot reject
	 * `unavailable` (they may name a method of the old variant).
	 */
	// 处理 loading：对象开始新一轮尝试；排队中的调用立即以 unavailable 失败，因为旧 variant 的方法索引可能失效。
	#loading(hold: number): void {
		// 找回对象；未知编号忽略。
		const holder = this.#entries.get(hold);
		if (holder === undefined) return;
		// 构造明确的失败原因。
		const error = new ChordError({ code: "unavailable", message: `hold ${hold}: rebinding` });
		// 只移除仍在排队的调用；已发送的由提供端按自身规则失败。
		for (const call of this.#window.removeHold(hold)) call.reject(error);
		// 通知对象转入 loading 状态。
		holder.loading();
	}

	/**
	 * `failed`: its holder fails; its calls still waiting for a slot reject with the cause (a bound hold is unbound by it,
	 * slice 7b; its calls in flight are rejected by the provider).
	 */
	// 处理 failed：把网络错误恢复成 ChordError，失败排队调用，并把消息交给对象。
	#failed(message: Extract<Message, { readonly kind: "failed" }>): void {
		// 找回对象；未知编号忽略。
		const holder = this.#entries.get(message.hold);
		if (holder === undefined) return;
		// errorFromWire 重建错误信封，asChordError 再把插件错误等统一成本地 ChordError。
		const error = asChordError(errorFromWire(message.cause.error), `hold ${message.hold}`);
		// 排队调用以同一原因失败。
		for (const call of this.#window.removeHold(message.hold)) call.reject(error);
		// 对象自身处理 failed 的 kind/retryIn。
		holder.failed(message);
	}

	/**
	 * `gone`: one for a hold this side gave up is ignored (Q1); the holder ends, which forgets its hold here and fails
	 * its calls.
	 */
	// 处理 gone：永久结束对象；未知编号（已放弃）按 Q1 忽略。
	#gone(message: Extract<Message, { readonly kind: "gone" }>): void {
		// 找回对象。
		const holder = this.#entries.get(message.hold);
		if (holder === undefined) return;
		// 把错误恢复成本地形式后交给对象；lost 会再调用 forget 清理本表。
		holder.lost(asChordError(errorFromWire(message.error), `hold ${message.hold}`));
	}

	/**
	 * A reply: its call settles with the parsed result or the error. A result past the link's limits rejects the call
	 * `too_large/part`. A malformed part rejects the call `unavailable` and throws (a protocol error: the link closes).
	 * A result to inflate asynchronously is inflated first (for a call still waiting), then handled again.
	 */
	// 处理 result/error 回复；返回 Promise 表示结果分片需要先异步解压。
	#reply(reply: Reply): void | Promise<void> {
		// 按调用编号查找在途调用；找不到说明已取消或已结算，忽略迟到回复。
		const call = this.#calls.get(reply.call);
		if (call === undefined) return;
		// 保存连接引用，供后面多次使用。
		const link = this.#link;
		// result 的值分片可能需要异步解压：先解压，再重新进入本方法。
		if (reply.kind === "result" && link.inflates(reply.value, link.limits)) {
			return link.inflate([[reply.value, link.limits.decoded]], () => this.#reply(reply));
		}
		// 回复已到：从在途表删除并归还窗口名额。
		this.#calls.delete(reply.call);
		this.#window.freed();
		try {
			// error 回复：重建错误并拒绝调用方。
			if (reply.kind === "error") call.reject(errorFromWire(reply.error));
			// 没有结果值：按协议解析为 null。
			else if (reply.value === undefined) call.resolve(null);
			// 正常结果：打开分片（检查上限/解压），再按字节段解析载荷。
			else call.resolve(parsePayload(link.openPart(reply.value, link.limits, link.context), reply.segments));
		} catch (error) {
			// 结果超过上限是可预期的调用失败：只拒绝该调用，不断连接。
			if (isChordError(error, "too_large")) {
				call.reject(error);
				return;
			}
			// 其他错误说明对端发了畸形回复：先让调用失败，再把错误抛给 Channel 作为协议错误关闭连接。
			call.reject(new ChordError({ code: "unavailable", message: `call ${reply.call}: a malformed reply` }));
			throw error;
		}
	}

	/** Fails `hold`'s calls in flight and waiting with `error`; each in-flight one frees its slot. */
	// 让某个持有的全部调用失败；每个在途调用归还窗口名额。
	#failCalls(hold: number, error: ChordError): void {
		// Waiting ones first: a freed slot must not send one of them.
		// 先移除排队调用：否则后面 freed() 可能立刻把同持有的排队调用发出去。
		const failed = this.#window.removeHold(hold);
		// 再扫描在途表，收集属于该持有的调用。
		for (const [id, call] of this.#calls) {
			// 属于其他持有的跳过。
			if (call.hold !== hold) continue;
			// 删除并归还名额。
			this.#calls.delete(id);
			this.#window.freed();
			// 加入待失败列表，统一在循环后结算。
			failed.push(call);
		}
		// 最后逐个拒绝，避免结算回调重入时表已清空。
		for (const call of failed) call.reject(error);
	}
}
