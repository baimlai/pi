// 本文件保存远端状态成员的本地副本，先解码变化，再在主机批次中采用并通知订阅者。
//
// 所属模块：packages/chord/src/remote（Chord v2 远端层）的消费端状态副本。
// 职责边界：只管理单个成员的 value/failed/ended 状态、Delta 解码器、批次内操作与退役标志；不发送消息、不决定批次边界。
// 上游入口：RemoteObject.prepareBound 创建副本，prepare 调用 decode，批次闭包调用 adopt/fail/retireAlone，RemoteObject.#end 调用 end。
// 下游依赖：state 层的 Source/Batch（订阅与交付）、delta 的 decoder/applyImmutable、data 的错误构造函数。
// 结果与错误流向：decode 抛协议错误（非数组、失败成员未用根替换）；value 读取抛当前错误；采用后通过 Source.changed 通知 watch 与 derive。
//
// 能力清单：
// - type MemberSnapshot：快照成员只有 value/failed 两种形态。
// - class Replica：派生自 Source；value/start 读取，decode 预计算，adopt/fail/retireAlone/reset/vanish 在批次内改变状态，deliver 发布，end 永久结束。
//
// 组合关系：bound/state 消息中的每个成员对应一个 Replica；prepare 先 decode，批次闭包再 adopt，批次结束由 deliver 发布一次。
// 示例：const replica = new Replica(batch, { kind: "value", value: 1 }); const { value } = replica.decode([["r", 2]]); replica.adopt(value, [["r", 2]], false);
// 建议阅读顺序：先看 ReplicaState/MemberSnapshot，再看 constructor 与 value/start，然后 decode/adopt，最后 deliver/fail/end。
// Replicas (§7, §22): a state member of a remote reference on the consumer, built from the snapshot and then changed
// by the provider's ops, decoded with the member's own Delta decoder and applied without validation or copy
// (`applyImmutable` shares structure); replaced by the snapshot of each re-hold.

import type { Context } from "../context/index.ts";
import type { ChordError } from "../data/index.ts";
import { applyImmutable, decoder, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import { type Batch, handedOut, Source, type WatchStart } from "../state/internal.ts";

/**
 * Where a replica stands: a value, a failed member (reads throw; the provider's member failed, or a newly bound variant
 * lacks it, and either may come back; `last` is its last good value, `undefined` when it had none), or ended with its
 * reference.
 */
// kind 是可区分联合的标签：value 有值，failed 带错误和上次好值，ended 代表引用已永久结束。
type ReplicaState =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown; readonly last: JsonValue | undefined }
	| { readonly kind: "ended"; readonly error: ChordError };

/** A member as a snapshot has it: a value, or failed. */
// 快照只有值或失败两种情况；没有 last 字段，旧值由本地 Replica 自己保存。
export type MemberSnapshot =
	| { readonly kind: "value"; readonly value: JsonValue }
	| { readonly kind: "failed"; readonly error: unknown };

// 复用空操作列表；readonly 是类型层只读约束。
const NO_OPS: readonly Op[] = [];

/** One state member of a hold, as the consumer reads and watches it; changed only inside the consumer's batch. */
export class Replica extends Source {
	// 保存当前状态标签及该状态需要的数据。
	#state: ReplicaState;
	/** The member's decoder, started with the snapshot as the provider's encoder was; a new one per snapshot. */
	// 每个成员使用独立 Delta 路径解码词典。
	#decoder = decoder();
	/** The ops of the current batch's frame, and whether the provider's document was retired in it. */
	// 本批次的操作，交付后重新设为空。
	#ops = NO_OPS;
	// 本次待交付值是否带有退役事件。
	#retired = false;
	/** A retirement that reached it while failed: its next value carries the flag. */
	// 失败时不能发布好值帧，先记住退役直到恢复。
	#retiredWhileFailed = false;

	// 创建成员副本：输入主机共享批次和首份快照，返回新 Replica；只保存状态，不发布通知。
	// 失败时通过 handedOut 展开错误栈并保存 last 为 undefined；例：首次快照失败，读取 value 就抛该错误。
	constructor(batch: Batch, state: MemberSnapshot) {
		// 初始化 Source，令该副本参与同一主机的批次与订阅管理。
		super(batch);
		// 值快照直接保存；失败快照先物化错误栈，且首次没有上次好值。
		this.#state = state.kind === "value" ? state : { kind: "failed", error: handedOut(state.error), last: undefined };
	}

	// 同步读取快照当前值，无参数；成功返回 JSON，失败或结束时抛原因。
	// 例如 value 态的数组按原引用返回，不在这里复制或检查数据模式。
	get value(): JsonValue {
		// 保留本次操作读取的状态，kind 分支帮助 TypeScript 缩小可用字段。
		const state = this.#state;
		// 只有 value 分支才能读到当前 JSON 值。
		if (state.kind === "value") return state.value;
		// failed 和 ended 都有 error 字段，直接把原因交给调用者。
		throw state.error;
	}

	/** Its value, or while failed its failure and last good value. */
	// 提供新 watch 的起点，无参数；失败时返回错误与旧值，其余通过 value 读取。
	// 例如已有好值后失败，新 watch 可先取得旧值再收到失败；结束时 value 抛错。
	start(): WatchStart {
		// 保留本次操作读取的状态，kind 分支帮助 TypeScript 缩小可用字段。
		const state = this.#state;
		// 失败起点同时提供错误和旧好值，让 watch 决定能否启动。
		if (state.kind === "failed") return { kind: "failed", error: state.error, last: state.last };
		// 其他情况读取 value；ended 会在 getter 中抛错。
		return { kind: "value", value: this.value };
	}

	/**
	 * The value `wire` (this member's wire ops from one state part) makes, and its ops; changes nothing yet. Throws on
	 * ops that do not fit (a protocol error): an ended member's, and a failed member's other than its recovery, which
	 * the provider sends as `[["r", value]]`.
	 */
	// 预处理来自网络的 wire 操作列表，返回计算出的新值和解码操作；暂不采用值或通知订阅。
	// 网络是运行时校验边界：必须为数组，Delta 检查操作；失败态只接受根替换恢复。
	// 例如 [["r", {n: 1}]] 可恢复失败成员；解码器的路径词典会随解码更新，结构错误向上抛给协议层。
	decode(wire: unknown): { readonly value: JsonValue; readonly ops: readonly Op[] } {
		// Trust boundary: fresh JSON from the link; Delta's decoder checks each op.
		// 运行时检查网络输入的外形；TypeScript 的 unknown 在检查前不能当操作数组使用。
		if (!Array.isArray(wire)) throw new Error("part: a member's changes are a list of ops");
		// 由 Delta 解码并检查每条操作，更新该成员的路径词典。
		const ops = this.#decoder.decode(wire);
		// 保留本次操作读取的状态，kind 分支帮助 TypeScript 缩小可用字段。
		const state = this.#state;
		// 已永久结束的成员不能继续应用新操作。
		if (state.kind === "ended") throw state.error;
		// 从当前值计算新值，未变的子树共享引用；没有应用层 schema 校验。
		if (state.kind === "value") return { value: applyImmutable(state.value, ops), ops };
		// ?. 安全读取首项；失败后的恢复必须从根替换起步，不能在不可靠旧状态上做局部变化。
		if (ops[0]?.[0] !== "r") throw new Error("part: a failed member recovers with a root replacement");
		// 以 null 为起点应用含根替换的恢复操作，返回待采用结果。
		return { value: applyImmutable(null, ops), ops };
	}

	/**
	 * Adopts the member's new value, the ops that made it and whether the provider's document was retired, in the
	 * current batch (one adoption per member and batch).
	 */
	// 在当前批次中采用准备好的 value/ops/退役标志，无返回值；调用者保证每批次每成员一次。
	// 先合并失败期间的退役标志，再更新状态并标脏；例：失败期间退役，恢复值仍携带 retired。
	adopt(value: JsonValue, ops: readonly Op[], retired: boolean): void {
		// 当前或失败期间任一次退役，都要带到恢复帧。
		const flagged = retired || this.#retiredWhileFailed;
		// 切到有值状态并保存原值引用。
		this.#state = { kind: "value", value };
		// 保存对应操作供批次交付，不复制操作列表。
		this.#ops = ops;
		// 保存本次合并后的退役标志。
		this.#retired = flagged;
		// 标志已转入本次好值，不再留待后续帧。
		this.#retiredWhileFailed = false;
		// Source 标记订阅者待通知，并让依赖的 derive 失效。
		this.changed();
		// 有退役时把标志继续传给依赖链。
		if (flagged) this.retiredInBatch();
	}

	/**
	 * The provider's document was retired with no ops for this member (a derive whose value stayed, rule 21), in the
	 * current batch: the flag alone; while failed it waits for the next value (a failed member's value is never read).
	 */
	// 处理只有退役标志、没有操作的帧，无参数返回值。
	// 已有值便原值发布退役，失败时记到下一好值，结束态不做事；例：值未改变的 derive 也能传播退役。
	retireAlone(): void {
		// 保留本次操作读取的状态，kind 分支帮助 TypeScript 缩小可用字段。
		const state = this.#state;
		// 值未改也发布一个带退役标志的空操作帧。
		if (state.kind === "value") this.adopt(state.value, NO_OPS, true);
		// 失败态先积攒退役标志，等待下一次采用值。
		else if (state.kind === "failed") this.#retiredWhileFailed = true;
	}

	/**
	 * A re-hold's snapshot of the member, in the batch that applies it, with a fresh decoder (the provider's encoder
	 * starts anew with it): a value is one frame `[["r", value]]`, a failed member fails.
	 */
	// 采用重新持有的快照并重建 Delta 解码器，无返回值，在批次内调用。
	// 例如重连后的新快照变成一个根替换帧；失败快照交给 fail，下一值仍可恢复。
	reset(state: MemberSnapshot): void {
		// 新快照对应新的提供端编码词典，本地也必须重新开始。
		this.#decoder = decoder();
		// 快照报告失败时进入失败态并保留已有好值。
		if (state.kind === "failed") this.fail(state.error);
		// 好快照作为根替换采用，确保 watch 从新快照继续。
		else this.adopt(state.value, [["r", state.value]], false);
	}

	/**
	 * The provider's member failed, in the batch that applies it: reads throw `error`, watches get one failure call and
	 * stay open, derives over it fail; its recovery is `[["r", value]]`.
	 */
	// 把 error 记为可恢复失败，保存上次好值，无返回值；首次进入失败才标脏。
	// 例如连续两个失败只通知同一失败阶段一次；值仍保留供 watch 起点使用，直接 value 读取抛错。
	fail(error: unknown): void {
		// 保留本次操作读取的状态，kind 分支帮助 TypeScript 缩小可用字段。
		const state = this.#state;
		// 由 value 保存当前值，由 failed 继续保存旧值；ended 没有旧值。
		const last = state.kind === "value" ? state.value : state.kind === "failed" ? state.last : undefined;
		// 保存先物化栈的错误及旧值：V8 在取用 stack 前会保留抛出点的栈帧接收者（可能包含 host）。
		this.#state = { kind: "failed", error: handedOut(error), last };
		// Failed already: its watches and derives have the failure (one call per failure episode).
		// 连续失败仍更新内部错误，但同一失败阶段不重复通知。
		if (state.kind !== "failed") this.changed();
	}

	// 批次调用此方法向 watch/同步订阅者发送失败或值，结束态关闭订阅，无返回值。
	// 发完清空本批 ops/retired；例：一个提交多次更新被批次安排为一次成员交付。
	deliver(context: Context): void {
		// 保留本次操作读取的状态，kind 分支帮助 TypeScript 缩小可用字段。
		const state = this.#state;
		// 发送可恢复失败调用，watch 继续存活。
		if (state.kind === "failed") this.failWatches(state.error, context);
		// 把当前值、操作和退役标志一起发布。
		else if (state.kind === "value") this.publish(state.value, this.#ops, this.#retired, context);
		// 永久结束的状态只关闭订阅。
		else this.endWatches();
		// 交付完成后清掉操作引用。
		this.#ops = NO_OPS;
		// 退役是一次事件，不应出现在下一无关帧。
		this.#retired = false;
	}

	/**
	 * The member is not in a newly bound variant, in the batch that binds it: as a failure (`fail`) with `error`; a later
	 * binding of a variant that has it brings it back (`reset`), as on the provider's host.
	 */
	// 新 variant 缺少此成员时用 error 标为可恢复失败，无返回值。
	// 例如 editor 切到 reader 后缺失的成员等以后 reset 恢复，watch 在此不会永久关闭。
	vanish(error: ChordError): void {
		// 复用失败处理，允许后续绑定恢复该成员。
		this.fail(error);
	}

	/** Its reference ended (outside a batch): reads throw `error`, watches end `ended`. */
	// 引用永久结束时保存 error 并立即关闭所有 watch/订阅，无返回值，不需要批次。
	// 例如 release 后 value 会抛 released，旧 watch 不会再收到后续帧。
	end(error: ChordError): void {
		// 记录终态与以后读取要抛出的原因。
		this.#state = { kind: "ended", error };
		// 立即结束 watch 和同步订阅，不再等待批次。
		this.endWatches();
	}
}
