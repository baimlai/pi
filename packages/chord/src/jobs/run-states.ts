// A job's run state documents (§15, slice 6b §4.1, §4.3): one per run by its id, Chord's own slot apart from the
// object's `self.state` slots. In memory, or persisted in the object's store (namespace `chord.job-states`), always in
// memory while the run is unsettled (`ctx.state.value` reads it synchronously). A persisted run's deferred changes
// (D8) are adopted and published at once and held, stored before the next change's own, at the outcome, at close or
// when their deadline passes.

// 文件导读（每个运行的状态文档槽）
// 所属：packages/chord/src/jobs，Chord v2 作业模块的状态文档子层（slice 6b §4.1/§4.3）。
// 职责边界：实现一个 DocumentSlot + PersistedSlot，管理“运行 id -> 状态文档”的 tracker、存储位置、延迟写入和
// 旧版本定义；不创建 JobRun、不决定 phase、不驱动 running 列表（只通过 owner 回调通知变化）。
// 上游入口：host/attempt.ts 创建 RunStates；job.ts 的 ctx.state.change 经事务 draftSlot 走到 stage/adopt；
// records.ts 在运行创建时 stageCreate、结算/关闭时 stageHeld，对象结束时 drop。
// 下游依赖：documents 的 Persistence/SlotDefinition/StoredChange，delta 的 track/PendingOps，store 引擎的
// createDocument/changeDocument；RunStatesOwner 回连对象的 documents 与 running 投影。
// 结果与错误流向：草稿/提交错误循事务路径抛出（例如非法状态值 invalid/args、释放后的 released）；
// 延迟写入本身不立即落盘，错误只会在后续真正提交时出现；initial() 故意抛 released/settled。
// 能力清单：
// - HeldState：一个运行尚未落盘的折叠 ops、是否要求 base、最晚截止时间。
// - RunStatesOwner：回调接口（documents、changed、held），用于 running 更新与对象级截止调度。
// - DEFAULT_WITHIN_MS：延迟持久化默认上限 1000ms。
// - RunStates：本文件的核心类，提供 redefine/migrated/value/current/stage/adopt/retire/create/stageCreate/
//   deadline/heldIds/stageHeld/drop 等方法，并实现 DocumentSlot/PersistedSlot 的其余契约。
// - heldOps / NO_HELD_OPS_BASE：读取 held 内容但不消费队列的辅助函数与共享常量。
// 组合关系/典型顺序：运行创建 -> stageCreate（同时创建 chord.jobs 记录）-> run 中 ctx.state.change（deferred）→
// stage 返回 held -> adopt 把 ops 压入 #held 并通知 running -> 后续立即提交/结算/close/截止时间 -> stageHeld 合并写入。
// 示例（真实签名）：
//   const states = new RunStates(Progress, owner, persistence);
//   const adopt = states.stageCreate("r1", { output: "" }, () => tx.stageStore(store));
//   states.stageHeld("r1", writes); // 无 held 时返回 undefined
// 建议阅读顺序：HeldState/RunStatesOwner -> RunStates 字段 -> redefine/migrated（版本）-> stage/adopt（延迟路径）->
// stageCreate/stageHeld（存储写入）-> heldOps（折叠语义）。
// 延迟持久化（D8）是这里最特殊的部分：值立即采用并发布给 watcher，但 store 写入被压进 #held，
// 等下一次立即提交、运行结算、对象关闭或截止时间到达时，再与后续 ops 合并成一次写入。
import type { Context } from "../context/index.ts";
import { ChordError } from "../data/index.ts";
import { type Op, PendingOps, type Prepared, type Tracker, track } from "../delta/index.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "../documents/index.ts";
import {
	type DocumentChange,
	type DocumentSlot,
	type Documents,
	type Held,
	type PersistedSlot,
	type Persistence,
	SlotDefinition,
	type Stored,
	type StoredChange,
	storedAfter,
} from "../documents/internal.ts";
import { changeDocument, createDocument } from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";

/**
 * A held state's ops, folded as they come (`PendingOps`: repeated writes of one leaf keep one op; past its bound only
 * "store a base" stays), whether a held change asked for a base, and when it must be stored at the latest.
 */
// pending 只保存尚未落盘的增量；base 为 true 表示已经决定整份写入（再有 ops 也不需要保留）；
// deadline 用 Date.now() 绝对时间，Infinity 表示没有待写内容。HeldState 是可变对象，由 RunStates 内部持有。
type HeldState = { readonly pending: PendingOps; base: boolean; deadline: number };

/** What the run states tell their job: a document changed (`running` follows), a held change's deadline. */
// 这是回调型依赖：RunStates 不直接操作 running/job，而是让 owner 决定如何投影与安排计时器。
export type RunStatesOwner = {
	readonly documents: Documents;
	/** Run `id`'s document changed by `ops`, inside the commit step. */
	// 在提交步骤内调用，ops 是该状态文档的相对增量；owner 负责把它们挂到 running 条目的 state 下。
	changed(id: string, ops: readonly Op[]): void;
	/** A held change must be stored by `deadline` (`Date.now()` time). */
	// owner 会为最早的截止时间安排一个计时器（多个运行的 held 共用一个对象级计时器）。
	held(deadline: number): void;
};

/** How long a deferred change is held at most by default (Durable's `progress.persistWithinMs`). */
// 默认 1 秒；调用方可在 ctx.state.change 的 persistence 里覆盖（withinMs）。这是上限，不是固定延迟。
const DEFAULT_WITHIN_MS = 1_000;

/** A run's state documents. Created with the run, retired with its record; never drafted while absent. */
// “never drafted while absent”：状态文档只由作业内部创建（create/stageCreate），插件不能像 self.state 那样先 draft 再创建。
// 事务对已存在的状态文档仍可正常 draft；initial() 故意抛错，防止把已退役的状态当成新文档读取。
export class RunStates implements DocumentSlot, PersistedSlot {
	readonly owner: Documents;
	/** The store side when the job persists; `undefined` in memory. */
	// persisted 是接口字段：内存作业为 undefined，事务据此跳过所有 store 相关分支。
	readonly persisted: PersistedSlot | undefined;
	/** The definition new documents are of: the job's latest declaration's state. */
	// 新文档使用当前版本；旧运行可能仍使用 #older 里的旧定义。SlotDefinition 保存当前定义并做版本检查。
	definition: SlotDefinition;
	readonly #persistence: Persistence | undefined;
	readonly #states: RunStatesOwner;
	// 运行 id -> 状态文档的 Tracker（值 + 变更记录）；退役时删除。
	readonly #trackers = new Map<string, Tracker<JsonObject>>();
	// 运行 id -> 已落盘的存储位置；用于下一次写入的 revision 和 delta 基准。
	readonly #stored = new Map<string, Stored>();
	// 运行 id -> 尚未落盘的延迟变更。
	readonly #held = new Map<string, HeldState>();
	/**
	 * The definitions of documents older than `definition` (runs started before a reload's new job version), by run id:
	 * the old code keeps writing the version it knows; the document migrates once its run settles or moves to the new
	 * code (slice 7b §8).
	 */
	// 版本升级后，旧运行不能立刻用新 schema 解释自己的状态；只有当它结算或切换到新代码时才迁移。
	// 这张表就是“每个旧运行仍按哪个定义写”的答案。
	readonly #older = new Map<string, SlotDefinition>();

	constructor(
		definition: StateDefinition<JsonObject, false, boolean>,
		states: RunStatesOwner,
		persistence: Persistence | undefined,
	) {
		// 包装成 SlotDefinition，统一处理版本检查/升级；owner 用于对象标签与批处理。
		this.definition = new SlotDefinition(definition);
		this.owner = states.documents;
		this.#states = states;
		this.#persistence = persistence;
		// 自引用：只有持久化作业才把自己暴露为 PersistedSlot，事务看到 undefined 就不再走 store 分支。
		this.persisted = persistence === undefined ? undefined : this;
	}

	get persistence(): Persistence {
		// Only reached through `persisted`, which a persisted job's states alone have.
		// 非空断言 `!`：只有 persisted === this 的实例会被调用；运行期没有检查，属于内部不变量。
		return this.#persistence!;
	}

	/**
	 * Takes a reload's new job version's state `definition` for new documents (`SlotDefinition.check` refuses an older
	 * version or a schema changed without a bump); the documents there are keep the version they are of.
	 */
	// 输入新定义；输出 void。副作用：可能把旧定义记入 #older（表内已有则不覆盖，保留最早版本），然后替换当前定义。
	// check 会拒绝版本倒退或同版本换指纹；定义相同（引用相等）时直接返回，避免无谓重建。
	redefine(definition: StateDefinition<JsonObject, false, boolean>): void {
		const current = this.definition;
		if (definition === current.current) return;
		current.check(definition);
		// 只有版本号变化才需要标记旧文档；同版本仅 fingerprint 相同（check 已保证），文档形状一致。
		if (definition.version !== current.current.version) {
			for (const id of this.#trackers.keys()) if (!this.#older.has(id)) this.#older.set(id, current);
		}
		// 新定义只影响之后创建的文档；旧文档继续用 #older 中的定义。
		this.definition = new SlotDefinition(definition);
	}

	/**
	 * Run `id`'s document as the current definition reads it: migrated when it is of an older version (its run's
	 * outcome on the new code; the document itself is retired with the run), `undefined` once retired.
	 */
	// 用于 finish 在“新代码”上读取旧运行的状态：如果该运行有旧定义，就按旧版本号调用当前定义的 migrate。
	// 结果不写回存储；文档随运行结算被退役，因此迁移只是一次性读取。
	// 例：旧状态 {count:1} 在 v2 里叫 {total:1}，migrate 后返回新形状供 finish 使用。
	migrated(id: string, context: Context): JsonObject | undefined {
		const value = this.value(id);
		const older = this.#older.get(id);
		// 无值或无需迁移时原样返回；undefined 表示已退役。
		if (value === undefined || older === undefined) return value;
		return this.definition.current.migrate(value, older.current.version, context);
	}

	/** The definition run `key`'s document is of. */
	// 旧运行优先用旧定义，否则用当前定义；写入路径据此选择正确的 schema 版本。
	#definitionOf(key: string): SlotDefinition {
		return this.#older.get(key) ?? this.definition;
	}

	/** The value of run `id`'s document; `undefined` once retired. */
	// 可选链：没有 tracker 即文档已退役或尚未创建；ctx.state.value 依赖这个同步读取。
	value(id: string): JsonObject | undefined {
		return this.#trackers.get(id)?.value;
	}

	current(key: string): Tracker<JsonObject> | undefined {
		return this.#trackers.get(key);
	}

	initial(_context: Context): JsonObject {
		// 契约要求实现 initial()，但运行状态没有“默认文档”：缺少文档只能由内部 create/stageCreate 创建。
		// 抛 released/settled 表示这个槽不会被事务当作普通 document 新建。
		throw new ChordError({
			code: "released",
			reason: "settled",
			message: `${this.definition.current.name}: the run's document is retired`,
		});
	}

	/** Pinned in memory while the run is unsettled: never cold. */
	// 只要运行未结算，状态文档一定在内存；因此事务永远不需要为它做冷加载。
	cold(_key: string): boolean {
		return false;
	}

	stored(key: string): Stored | undefined {
		return this.#stored.get(key);
	}

	// PersistedSlot 要求实现 load；运行状态不会以“冷文档”方式按需加载（激活时由 records.ts 直接恢复），所以空实现。
	async load(_key: string, _context: Context): Promise<void> {}

	/**
	 * A change of run `key`'s document: a deferred one of a stored document is held (nothing written); an immediate
	 * one stores what is held with its own ops, as one delta on the stored revision or a base.
	 */
	// 两类路径：
	// 1) 延迟且文档已存在、不是退役、且有实际变更：只返回 held 描述，不产生 store 写；adopt 时把 ops 暂存。
	// 2) 其余（立即、创建、退役、已无变更）：走通用 Persistence.stage，并把此前 #held 的 ops 合并到本次写入。
	// `held && heldOps(held)` 的类型是 Held | undefined（&& 在对象为 undefined 时直接得到 undefined）。
	stage(
		key: string,
		change: DocumentChange,
		was: Stored | undefined,
		writes: StagedWrite[],
		persistence: CommitPersistence,
	): StoredChange {
		// 只有“已存在的文档 + 延迟持久化 + 非退役 + 有 prepared”才能纯粹挂在内存里；
		// 创建必须落盘（否则崩溃后运行记录存在但状态丢失），退役必须落盘。
		if (persistence.kind === "deferred" && was !== undefined && !change.retires && change.prepared !== undefined) {
			return { kind: "held", stored: was, withinMs: persistence.withinMs ?? DEFAULT_WITHIN_MS };
		}
		const held = this.#held.get(key);
		// 该运行当前的写入使用它自己的定义版本（可能是旧版），而不是全局当前版。
		return this.persistence.stage(key, this.#definitionOf(key).current, was, change, writes, held && heldOps(held));
	}

	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		change: StoredChange | undefined,
	): void {
		// 先把逻辑值应用到 tracker（广播由事务的 batch 统一处理）。
		tracker.adopt(prepared);
		// held：提交没有写 store，把变更压入内存等待后续合并。
		if (change?.kind === "held") this.#hold(key, prepared, change);
		// 其他写入：更新存储位置并清掉 held（本次写入已经包含之前的 held ops）。
		else if (change !== undefined) this.#settle(key, storedAfter(change));
		// 把本次 ops 告诉 owner，用于 running 条目里 state 字段的增量更新。
		this.#states.changed(key, prepared.ops);
	}

	/** Retires run `key`'s document (its record's deletion): what is held goes with it. */
	// 四个 map 一起清：运行结束后不再需要旧定义、值、存储位置或延迟变更。
	retire(key: string): void {
		this.#older.delete(key);
		this.#trackers.delete(key);
		this.#stored.delete(key);
		this.#held.delete(key);
	}

	/** Run `id`'s document with `value`, as its start created it or a load found it (`stored`: persisted). */
	// 输入完整值；track() 创建 Tracker。stored 可选：内存作业或新建但尚未提交时没有存储位置。
	create(id: string, value: JsonObject, stored: Stored | undefined): void {
		this.#trackers.set(id, track(value));
		if (stored !== undefined) this.#stored.set(id, stored);
	}

	/**
	 * Stages the creation of run `id`'s document with `value` into `writes` (its start); returns the adoption, which
	 * creates it in memory with what is stored.
	 */
	// 输入 id、初始值，以及一个返回写入数组的函数（延迟取得事务的 StagedWrite[]，因为事务可能尚未需要 store）。
	// 输出 adoption：提交成功后创建内存文档并记下存储位置。
	// 例（持久化作业）：start 事务同时创建 chord.jobs 记录与 chord.job-states 状态文档，两者同一次提交。
	stageCreate(id: string, value: JsonObject, writes: () => StagedWrite[]): () => void {
		const persistence = this.#persistence;
		// 内存作业无需写入：adoption 只建文档，不设 stored。
		if (persistence === undefined) return () => this.create(id, value, undefined);
		// 创建总是使用当前定义版本（新运行从新代码开始）。
		const { version, fingerprint } = this.definition.current;
		const created = { id: 0 };
		const base = { version, fingerprint, value };
		// 与 PersistedRuns.stage 相同：创建时 id 由步骤分配，通过回调写进闭包。
		writes().push(
			createDocument(persistence.at(id), base, JSON.stringify(value), (stored) => {
				created.id = stored;
			}),
		);
		return () => this.create(id, value, { id: created.id, revision: 1, version, deltasSinceBase: 0 });
	}

	/** When run `id`'s held changes must be stored at the latest (`Infinity`: none held, or none with a deadline). */
	// 返回绝对时间；对象级调度器会取所有运行的最小值，决定何时 flush。
	deadline(id: string): number {
		return this.#held.get(id)?.deadline ?? Number.POSITIVE_INFINITY;
	}

	/** The runs whose documents hold changes not stored yet. */
	// 返回新数组快照，避免调用方在遍历时被并发修改影响（keys() 是实时迭代器）。
	get heldIds(): readonly string[] {
		return [...this.#held.keys()];
	}

	/**
	 * Stages what run `id`'s document holds into `writes` (a flush: its deadline, the outcome, the close writer), as one
	 * delta on its stored revision or a base; returns the adoption, `undefined` when nothing is held.
	 */
	// 输入运行 id 与写入数组；输出 adoption 或 undefined（无 held/无存储位置/无 tracker 时不写）。
	// 流程：取 held 的折叠 ops -> 决定 base（曾要求 base 或存储版本落后）-> 生成 delta/base 写入 -> adoption 清 held。
	// 注意这里直接调用 store 引擎，而不是 Persistence.stage：因为要写入合并后的 held ops，而普通 stage 只处理本次 change。
	stageHeld(id: string, writes: StagedWrite[]): (() => void) | undefined {
		const held = this.#held.get(id);
		const stored = this.#stored.get(id);
		const tracker = this.#trackers.get(id);
		if (held === undefined || stored === undefined || tracker === undefined) return undefined;
		const { version, fingerprint } = this.#definitionOf(id).current;
		// tracker.value 是“当前完整值”：选择 base 时直接序列化它，不需要重放 ops。
		const value = tracker.value;
		const { ops, base: asked } = heldOps(held);
		// 存储版本与写入定义版本不一致时也必须写 base：旧 revision 的 delta 无法用新 schema 解释。
		const base = asked || stored.version !== version;
		// `as const` 把 kind 收窄为字面量 "base"/"delta"，满足 DocumentContent 的可判别联合类型。
		const content = base
			? ({ kind: "base", version, fingerprint, value } as const)
			: ({ kind: "delta", version, ops } as const);
		// 文本与内容必须一致：base 写完整 value，delta 写 ops 数组。
		writes.push(changeDocument(stored.id, stored.revision, content, JSON.stringify(base ? value : ops)));
		const deltasSinceBase = base ? 0 : stored.deltasSinceBase + 1;
		const after: Stored = { id: stored.id, revision: stored.revision + 1, version, deltasSinceBase };
		return () => {
			// 只有 held 仍是同一个对象时才清：期间可能有新的延迟变更到来，不能把它们一并丢弃。
			// （否则新变更会误以为已经落盘。）
			if (this.#held.get(id) === held) this.#settle(id, after);
		};
	}

	/** Drops every document (the object ended): what is held is lost, as a crash loses it. */
	// 对象结束时不做补偿写入：这是与“崩溃”一致的语义；需要保留的内容应在 close writer 阶段先行 flush。
	drop(): void {
		this.#older.clear();
		this.#trackers.clear();
		this.#stored.clear();
		this.#held.clear();
	}

	/** What is stored of run `key`'s document after a commit stored it: nothing is held any more. */
	// stored 为 undefined 表示文档已退役（storedAfter 对 retire 返回 undefined），因此删除存储位置。
	#settle(key: string, stored: Stored | undefined): void {
		if (stored === undefined) this.#stored.delete(key);
		else this.#stored.set(key, stored);
		this.#held.delete(key);
	}

	/** A deferred change adopted: its ops held (a base when `checkpointWhen` asks), its deadline told. */
	// 输入 prepared 与 held 描述；输出 void。副作用：更新/创建 #held，并通知 owner 最早截止时间。
	#hold(key: string, prepared: Prepared<JsonObject>, change: Extract<StoredChange, { kind: "held" }>): void {
		// 已有 held 就复用（保留累积的 ops 与更早的 deadline）；否则新建一个空队列。
		const held = this.#held.get(key) ?? {
			pending: new PendingOps(),
			base: false,
			deadline: Number.POSITIVE_INFINITY,
		};
		// 估算“如果再写一次 delta，前面已有多少 delta”：pending.size > 0 表示还有未落盘变更，这次也算一条。
		const deltasSinceBase = change.stored.deltasSinceBase + (held.pending.size > 0 ? 1 : 0);
		// checkpointWhen 是插件定义在持久化文档上的策略；这里传入当前完整值与本次 ops，由它决定是否值得写 base。
		if (this.#definitionOf(key).current.checkpointWhen(prepared.value, prepared.ops, { deltasSinceBase })) {
			held.base = true;
		}
		// A base stores the whole value: no op needs keeping for it.
		// 已决定写 base 时，之前累积的 ops 都可以丢掉：take() 清空队列。
		if (held.base) held.pending.take();
		else held.pending.push(prepared.ops);
		// 多个延迟变更取最早的截止时间：先到期的必须能触发一次 flush，覆盖后续变更。
		held.deadline = Math.min(held.deadline, Date.now() + change.withinMs);
		this.#held.set(key, held);
		// 只有有限截止时间才需要计时器；Infinity 表示没有待写内容（例如 base 已被处理）。
		if (Number.isFinite(held.deadline)) this.#states.held(held.deadline);
	}
}

/**
 * What `held` stores, its queue left as it was (a commit may still be refused): its folded ops, or a base once a held
 * change asked for one or the queue overflowed. Taking and pushing back one batch keeps it by reference: no copy.
 */
// 读取 held 的内容但不消费它：因为这次提交可能被 store 拒绝，拒绝后队列必须保持原样。
// take() 返回的结果要么是 ops 引用，要么是 replace（队列溢出）。push 回去时若只有一批，PendingOps 会按引用保留，不复制。
function heldOps(held: HeldState): Held {
	if (held.base) return NO_HELD_OPS_BASE;
	const taken = held.pending.take();
	if (taken.kind === "replace") {
		// 溢出后只能整份写 base；同时记住这个决定，后续 held 不再积累 ops。
		held.base = true;
		return NO_HELD_OPS_BASE;
	}
	// 原样放回，保持“尚未提交”的状态；返回的 ops 数组仍由队列持有，调用方只读。
	held.pending.push(taken.ops);
	return { ops: taken.ops, base: false };
}

// 共享的“无 ops、要求 base”常量，避免每次分配；Held 是只读形状，复用它不会被修改。
const NO_HELD_OPS_BASE: Held = { ops: [], base: true };
