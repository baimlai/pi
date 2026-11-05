// The keys a reference holds (slice 6a §12; decision "References are the only indirection" (4)): its key watches and
// its factory's pins (`at(key)`) of its object's keyed members, one source per member and key shared by them, pinned on
// the object's live instance (loaded, mapped to the reference's version). While the object still follows the instance a
// key is pinned on (a swap's old instance, a restart's drain, a live failure's admitted commits) the key follows it on,
// as members do. When the reference moves to a new instance or a new object it pins the key there again, keeping the
// last value until that pin loads, then one frame; while it points at nothing the key keeps its last value (one
// `failed` call when its target failed, none while it loads).

// 所属：packages/chord/src/host 的引用级 keyed 键管理（slice 6a §12；决策“引用是唯一间接层”(4)）。
// 职责边界：为一个引用持有的每个 (member, key) 维护共享 ReferenceSource 与实例 pin；不直接读取文档值。
// 上游：reference.ts 的 Binding 在 keyed 访问时 hold、目标变化时 follow、失败/结束时 fail/end；
// 下游：Attempt.pinKey 在 live 实例上真正加载键，返回 PinnedKey；ReferenceSource.bind 把 pin.source 接入引用。
// 结果与错误：pin 加载失败转成 source 的 failed；没有值时的读取由 KeyHolder.none() 提供错误。
// 能力清单：
// - KeyHolder：引用向本模块暴露的最小接口（batch、version、target()、none()）。
// - KeyEntry（内部）：一个键的 source、持有者计数、实例身份、当前 pin 与进行中的 loading。
// - ReferenceKeys：按成员/键组织的条目表；hold 获取或创建条目并 pin，follow 在新实例上重新 pin，
//   fail/end 结束源，内部 #pin/#release/#unpin 管理 pin 生命周期。
// 关键不变量：每个实例 pin 恰好 release 一次；最后一个持有者离开时结束 source，避免引用与文档永久保留。
// 组合与典型顺序：读取 ref.doc("id") -> hold 创建条目 -> #pin 在 target 实例上加载 -> 目标更换 -> follow 重 pin ->
// 引用结束 -> end 结束所有 source。示例：ref.doc("todos").at("42").get() 会为 ("doc","42") 建立共享源。
// 示例：const keys = new ReferenceKeys(binding);
//       const pin = await keys.hold("doc", "42", context);
//       keys.follow(context);
// 建议阅读顺序：KeyHolder -> KeyEntry -> ReferenceKeys 字段/构造 -> hold -> follow -> fail/end -> #entry/#pin/#release/#unpin。

import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import type { Batch } from "../state/internal.ts";
import type { PinnedKey } from "./attempt.ts";
import type { Target } from "./reference.ts";
import { ReferenceSource } from "./reference-source.ts";

/** What a reference's keys need of it. */
// 引用需要向 ReferenceKeys 暴露的最小接口。这些成员由 Binding 实现；字段含义如下：
// batch：宿主批次，用于在正确时机发布源变化；version：消费者契约版本，读取的键值要映射回该版本；
// target()：当前绑定目标（未绑定时 undefined）；none()：从未加载过键值时读取应抛的错误。
export interface KeyHolder {
	readonly batch: Batch;
	/** Its contract version: keys are mapped to it. */
	readonly version: number;
	/** The object it is bound to; `undefined` while unbound. */
	target(): Target | undefined;
	/** What a read throws while a key never had a value. */
	none(): ChordError;
}

/** One key of one keyed member held by the reference: its source, its users, and the instance pin it follows. */
// 一个 (member, key) 的内部条目。source 是所有读取者共享的 ReferenceSource；holders 是当前持有者数量；
// instance 是正在（或已经）pin 的实例身份，用来判断是否需要重新 pin；pin 是当前生效的钉住句柄；
// loading 是进行中的 pin Promise，用于复用同一实例上的并发等待。
type KeyEntry = {
	readonly member: string;
	readonly key: string;
	readonly source: ReferenceSource;
	holders: number;
	/** The live instance its pin is (or is being) taken on; `undefined` while it points at nothing. */
	instance: unknown;
	/** The pin it follows. */
	pin: PinnedKey | undefined;
	/** The pin in flight, settled once the source follows it. */
	loading: Promise<void> | undefined;
};

/** A reference's held keys; every instance pin below them released exactly once. */
// 每个引用（Binding）一个 ReferenceKeys。构造时只保存 KeyHolder，不创建源或 pin。
// 例：ref.doc("id").get() 时会走到 hold("doc", "id", ctx)，首次访问才真正在实例上加载。
export class ReferenceKeys {
	readonly #holder: KeyHolder;
	// 两层 Map：成员名 → 键 → 条目；同一成员的不同键互不影响。
	readonly #entries = new Map<string, Map<string, KeyEntry>>();

	// 保存持有者引用；无其他动作。
	constructor(holder: KeyHolder) {
		this.#holder = holder;
	}

	/**
	 * Holds `key` of keyed member `member`: its source once pinned and loaded on the live instance; `context` ends only
	 * this caller's wait. `release` (once) lets it go with its last holder.
	 */
	// 取得（必要时创建）共享条目并增加持有计数；若尚无 pin，则等待在 live 实例上完成 pin。
	// 输入：成员名、键、调用者上下文。输出：{ source, release }；release 幂等。
	// 错误：pin 失败时减少计数并原样抛出；context 取消只结束本次等待，不影响其他持有者。
	// 例：两个组件同时读同一 keyed 成员，只触发一次 pinKey，两者共用 source。
	async hold(member: string, key: string, context: Context): Promise<PinnedKey> {
		const entry = this.#entry(member, key);
		entry.holders++;
		// released 标志保证 release 重复调用时只释放一次。
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			this.#release(entry);
		};
		try {
			// 已有 pin 时无需等待；否则等待 #pin 完成（context 取消只影响这一等待）。
			if (entry.pin === undefined) await awaitWithContext(this.#pin(entry), context);
		} catch (error) {
			// 等待失败：撤销本持有者，避免计数泄漏。
			release();
			throw error;
		}
		return { source: entry.source, release };
	}

	/**
	 * Its reference's target changed, inside a batch: a key pins again on a new live instance (last value meanwhile);
	 * while the target is not live it follows the instance it is pinned on as long as the object does (a commit admitted
	 * there still shows), then keeps its last value (one `failed` call for a failure) and its pin goes.
	 */
	// 目标变化时调整每个键的 pin。三种情况：
	// 1) 目标有 live 实例：若 pin 不在该实例上，重新 pin（失败由 #pin 内部报告到 source，无人等待）。
	// 2) 没有 live 实例，但该实例仍处于“跟随中”（attachable）：保持原 pin，让已接纳的提交继续显示。
	// 3) 否则目标指向空：目标失败则 source 收到一次 failed；仅 loading 则保持最后值；最后释放 pin。
	follow(context: Context): void {
		const target = this.#holder.target();
		const instance = target?.instance;
		const attachable = target?.attachable;
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				if (instance !== undefined) {
					// A failed load shows on the key (`failed`); nobody waits on this pin.
					if (entry.instance !== instance) this.#pin(entry).catch(() => {});
					continue;
				}
				if (attachable !== undefined && entry.instance === attachable) continue;
				// 取目标状态：failed 分支把失败原因传给共享 source，其余情况仅保持最后值。
				const state = target?.state;
				if (state?.kind === "failed") entry.source.fail(state.cause.error, context);
				else entry.source.hold();
				this.#unpin(entry);
			}
		}
	}

	/** Its reference left its object (`error`: why it waits), inside a batch: keys keep their last values, pins go. */
	// 引用暂时离开对象（例如重载后等待新版本）：每个键的 source 记录失败原因但保留最后值，pin 全部释放。
	// 这与 end 不同：source 不结束，之后还能重新绑定。
	fail(error: ChordError, context: Context): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				entry.source.fail(error, context);
				this.#unpin(entry);
			}
		}
	}

	/** Its reference ended, inside a batch: every key ends with `error` and releases its pin. */
	// 引用永久结束：每个 source 以错误结束（监听者收到结束通知），释放 pin，最后清空条目表。
	// 之后同一 ReferenceKeys 不再使用（引用已结束）。
	end(error: ChordError): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				entry.source.end(error);
				this.#unpin(entry);
			}
		}
		this.#entries.clear();
	}

	/** The entry of `member` and `key`, made by the first holder. */
	// 查找或创建条目：先按成员名建内层 Map，再按键查找；首次访问时创建共享 ReferenceSource 并登记。
	#entry(member: string, key: string): KeyEntry {
		let byKey = this.#entries.get(member);
		if (byKey === undefined) {
			byKey = new Map();
			this.#entries.set(member, byKey);
		}
		let entry = byKey.get(key);
		if (entry === undefined) {
			// ReferenceSource 绑定到引用批次和 KeyHolder，之后 source 的读取会按引用版本映射。
			const source = new ReferenceSource(this.#holder.batch, this.#holder);
			entry = { member, key, source, holders: 0, instance: undefined, pin: undefined, loading: undefined };
			byKey.set(key, entry);
		}
		return entry;
	}

	/**
	 * Pins `entry`'s key on the target's live instance (once per instance): the source keeps its last value meanwhile,
	 * follows the pin when it lands (one frame) and releases the previous one; a failed load shows as its failure.
	 */
	// 在目标当前 live 实例上加载键。输入条目；输出在 source 接上 pin 后完成的 Promise。
	// 副作用：设置 entry.instance/loading，调用 target.pinKey，成功后 bind 共享 source 到 pin.source 并释放旧 pin。
	// 错误：目标或实例不存在时拒绝 none()；pinKey 失败时 source 收到失败并继续抛出。
	#pin(entry: KeyEntry): Promise<void> {
		const { batch, version } = this.#holder;
		const target = this.#holder.target();
		const instance = target?.instance;
		// 没有目标或没有 live 实例：这个键从未有过值，读取应得到引用的 none() 错误。
		if (target === undefined || instance === undefined) return Promise.reject(this.#holder.none());
		// 同一实例已有进行中的 pin：复用，避免并发重复加载。
		if (entry.instance === instance && entry.loading !== undefined) return entry.loading;
		entry.instance = instance;
		// No frames from the old instance while the new one loads the key.
		// hold() 让 source 暂停跟随旧 pin，但保留最后值。
		entry.source.hold();
		// 用 BACKGROUND_CONTEXT 等待 pin 本身：键的加载不随某个读取者的取消而取消。
		const loading = target.pinKey(entry.member, entry.key, version, BACKGROUND_CONTEXT).then(
			(pin) => {
				// 等待期间目标可能又换了实例，或最后一个持有者已离开：此时新 pin 立即释放。
				if (entry.instance !== instance || entry.holders === 0) {
					pin.release();
					return;
				}
				const previous = entry.pin;
				entry.pin = pin;
				// bind 在批次内执行，保证监听者只看到一次值切换。
				batch.within(() => entry.source.bind(pin.source), BACKGROUND_CONTEXT);
				previous?.release();
			},
			(error: unknown) => {
				// 仍是同一实例才记录失败，避免把旧实例的错误写到新实例状态上。
				if (entry.instance === instance) {
					entry.instance = undefined;
					entry.loading = undefined;
					const failure = asChordError(error, target.label);
					batch.within(() => entry.source.fail(failure, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
				}
				// 继续抛出，让等待的 hold() 也失败。
				throw error;
			},
		);
		entry.loading = loading;
		return loading;
	}

	/** One holder of `entry` left; the last drops it and its pin. */
	// 减少持有计数；尚有人持有则返回。最后一个离开时：从表中删除条目、结束共享 source、释放 pin。
	#release(entry: KeyEntry): void {
		// 前缀自减：先减再判断，>0 表示还有持有者。
		if (--entry.holders > 0) return;
		const byKey = this.#entries.get(entry.member);
		// 条目可能已被 end() 清空或替换；按身份比较，避免误删新条目。
		if (byKey?.get(entry.key) !== entry) return;
		byKey.delete(entry.key);
		if (byKey.size === 0) this.#entries.delete(entry.member);
		// Its source ends: it leaves the document, whose other holders would keep it and its reference (Astra, GC).
		const released = new ChordError({ code: "released", message: `${entry.member}.at(${entry.key}): released` });
		const end = (): void => entry.source.end(released);
		// source 仍被使用时在批次内结束，避免在发布中途改变状态；否则同步结束。
		if (entry.source.inUse) this.#holder.batch.within(end, BACKGROUND_CONTEXT);
		else end();
		this.#unpin(entry);
	}

	/** Releases the pin `entry` follows or awaits: it points at nothing until pinned again. */
	// 释放当前 pin 并清空实例/加载状态。release() 幂等；loading 中的 pin 完成后由 #pin 的成功分支自行释放。
	#unpin(entry: KeyEntry): void {
		entry.pin?.release();
		entry.pin = undefined;
		entry.instance = undefined;
		entry.loading = undefined;
	}
}
