// A persisted job's run records in its object's store (slice 6b §4.1, D5): the record document of each unsettled run
// (namespace `chord.jobs`, kind the job name, key the run id, `history: none`), written whole in the transactions that
// change the run, and read once per object when it first activates; for a run of another job version, also what is
// stored of its state document (`chord.job-states`), never decoded, so its drop retires it whatever the code declares.

// 文件导读（持久化运行记录的 store 侧）
// 所属：packages/chord/src/jobs，Chord v2 作业模块的持久化子层（slice 6b）。
// 职责边界：只管理“运行记录文档”和“旧版本运行的状态文档位置”；不解析运行状态、不推进 phase、不创建 JobRun。
// 上游入口：records.ts 在激活时 load()，在 stage/flush/结算时 stage()/stageRetire()，在加载旧版本运行后
// findBlockedState()；reload 后能接管旧运行时 forgetBlockedState()。
// 下游依赖：documents 的 Persistence（地址/读/键分页）与 store 引擎的 createDocument/changeDocument/retireDocument；
// StagedWrite 把写入排进事务的提交步骤，adoption 回调只在提交成功后执行。
// 结果与错误流向：load 返回 LoadedRecord[]（store 的读取错误按 store 语义拒绝）；stage 系列不改内存，
// 通过返回的闭包在提交成功后更新 #stored/#blockedStates；提交失败时闭包不执行，状态保持可重试。
// 能力清单：
// - LoadedRecord：加载到的一条记录（运行 id、StoredRun、存储位置）。
// - KEYS_PAGE：分页读取的页大小常量。
// - PersistedRuns：记录与状态文档的 store 侧集合，提供 stage/stageRetire/findBlockedState/forgetBlockedState/load/drop。
// 组合关系/典型顺序：激活 load -> 每条记录交给 records.ts 恢复 JobRun -> 运行变化时 stage 生成 base 写入 ->
// 结算时 stageRetire 删除记录（旧版本运行还删除其状态文档）-> 对象结束 drop 清内存映射。
// 示例（真实签名）：
//   const runs = new PersistedRuns(recordsPersistence, statesPersistence);
//   const loaded = await runs.load(ctx); // [{ id: "r1", record: StoredRun, stored: { id, revision, ... } }]
//   const adopt = runs.stage("r1", storedRun(run, { phase: "running" }), writes);
// 建议阅读顺序：LoadedRecord -> PersistedRuns 字段 -> stage/stageRetire -> load 的分页循环 -> 两个状态文档方法。
// 为什么记录总是 base：运行记录是内部数据、变更频繁且结构不透明，使用差分没有收益；整份写入让恢复逻辑只需解析完整 JSON。
// 状态文档是另一条 Persistence（chord.job-states）：正常版本由 run-states.ts 管理；这里只为“另一个版本的运行”保存其存储位置，
// 以便在版本不匹配、无法解码时仍能安全退役，避免把不属于当前代码的数据留在 store 里。
import type { Context } from "../context/index.ts";
import type { JsonObject } from "../documents/index.ts";
import type { Persistence, Stored } from "../documents/internal.ts";
import { changeDocument, createDocument, retireDocument } from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";
import { RUN_RECORD, recordOf, type StoredRun } from "./stored.ts";

/** A run record as a load found it: its run id, the record and what is stored of it. */
// stored 是文档引擎的 id/revision/version/deltasSinceBase，后续 stage 用它做乐观并发（revision 必须匹配）。
export type LoadedRecord = { readonly id: string; readonly record: StoredRun; readonly stored: Stored };

/** The keys a load reads per page. */
// 分页读取避免一次性把大量运行记录拉进内存；100 只是内部批量大小，不是公开配置。
const KEYS_PAGE = 100;

/** The record documents of one persisted job's runs, and what is stored of each. */
// 生命周期与 JobRecords 相同：对象激活时创建，对象结束时 drop。map 里只记录“本对象已知的存储位置”，
// 不是运行列表本身（运行列表在 records.ts）。
export class PersistedRuns {
	// 两个 Persistence 分别指向 chord.jobs 与 chord.job-states；它们是对象级文档地址（owner+namespace+kind）。
	readonly #records: Persistence;
	readonly #states: Persistence;
	// 运行 id -> 记录文档的存储位置；键是运行 id，值随每次 stage 的 adoption 更新 revision。
	readonly #stored = new Map<string, Stored>();
	/** What is stored of the state documents of runs of another job version, by run id. */
	// 只保存“无法按当前代码解码”的状态文档位置；正常状态文档的存储在 run-states.ts 里。
	// 这个 map 的存在是为了退役时不需要先解码：即使代码不再认识旧 schema，也能按 id/revision 删除。
	readonly #blockedStates = new Map<string, Stored>();

	/** `records` and `states` are the job's record and state documents' store sides (`chord.jobs`, `chord.job-states`). */
	// 构造只保存引用，不做 I/O；两个 Persistence 由 host/attempt.ts 在声明持久化作业时创建。
	constructor(records: Persistence, states: Persistence) {
		this.#records = records;
		this.#states = states;
	}

	/**
	 * Stages run `id`'s record `record` into `writes` (rule 8: serialized now): its creation, or a new base of what is
	 * stored; returns the adoption, which takes what the commit stored.
	 */
	// 输入：运行 id、完整记录、事务的写入数组。输出：一个 adoption 回调（提交步骤内执行）。
	// 副作用：立即把 StagedWrite 推到 writes；不改 #stored，只有 adoption 才更新（提交失败时内存保持原状）。
	// 例（真实行为）：首次 stage("r1", rec) 生成 createDocument；提交成功后 adoption 把 #stored 设为 id=新 id、revision=1。
	stage(id: string, record: StoredRun, writes: StagedWrite[]): () => void {
		// 在入队前序列化（rule 8）：即使调用方之后修改 record 对象，写入的字节也已固定。
		const text = JSON.stringify(record);
		const stored = this.#stored.get(id);
		// 记录文档自身的版本/指纹固定为 RUN_RECORD，与作业版本无关；作业版本在 record.version 里。
		const { version, fingerprint } = RUN_RECORD;
		// 文档引擎的值类型是 JsonObject；StoredRun 已知是 JSON 形状，这里用双重断言表达该内部不变量。
		const value = record as unknown as JsonObject;
		if (stored === undefined) {
			// created 先占位 0，createDocument 在步骤执行时才分配真实 id，并通过回调写回。
			const created = { id: 0 };
			writes.push(
				// 地址由 Persistence.at(id) 计算；回调 `(made) => { created.id = made }` 把步骤分配到的 id 捕获到闭包。
				createDocument(this.#records.at(id), { version, fingerprint, value }, text, (made) => {
					created.id = made;
				}),
			);
			// adoption 只在提交成功后执行：此时 created.id 已由步骤填好。
			return () => this.#stored.set(id, { id: created.id, revision: 1, version, deltasSinceBase: 0 });
		}
		// 已存在：整份新 base，并带上已知 revision 做并发检查（revision 不匹配时 store 拒绝）。
		writes.push(changeDocument(stored.id, stored.revision, { kind: "base", version, fingerprint, value }, text));
		// 新 revision 是旧值 +1；deltasSinceBase 在 base 后归零（展开旧值后覆盖 revision）。
		return () => this.#stored.set(id, { ...stored, revision: stored.revision + 1 });
	}

	/**
	 * Stages the retirement of run `id`'s record into `writes` (the run settled or was dropped), and of its state
	 * document when the run is of another job version; the adoption forgets them.
	 */
	// 输入运行 id 与写入数组；返回 adoption。若记录不存在（例如还没提交过创建），只清 map，不产生写。
	// 例：结算一个正常运行会删除 chord.jobs 记录；结算一个旧版本运行还会删除 chord.job-states 里未解码的状态。
	stageRetire(id: string, writes: StagedWrite[]): () => void {
		const stored = this.#stored.get(id);
		// retireDocument 需要 id 与 revision：store 用它确认删除的是同一个版本，避免误删被别的提交改过的文档。
		if (stored !== undefined) writes.push(retireDocument(stored.id, stored.revision));
		const state = this.#blockedStates.get(id);
		if (state !== undefined) writes.push(retireDocument(state.id, state.revision));
		// adoption 清掉两个 map 条目；提交失败时不会执行，因此内存仍认为文档存在，可重试。
		return () => {
			this.#stored.delete(id);
			this.#blockedStates.delete(id);
		};
	}

	/** Finds what is stored of run `id`'s state document (a run of another job version), keeping it for the drop. */
	// 只读取存储位置，不解码内容：当前代码可能无法解释旧 schema，删除并不需要理解它。
	// 副作用：找到时写入 #blockedStates；找不到则不留任何标记。
	async findBlockedState(id: string, context: Context): Promise<void> {
		const found = await this.#states.find(id, context);
		if (found !== undefined) this.#blockedStates.set(id, found.stored);
	}

	/**
	 * A run of another job version that a reload's code now takes (`retryBlocked`): its state document is the job's
	 * again (read, decoded and retired with its record as any run's), no longer one to retire undecoded.
	 */
	// 版本匹配后，run-states.ts 会接管该状态文档；这里移除“待不解码退役”的标记，避免同一文档被退役两次。
	forgetBlockedState(id: string): void {
		this.#blockedStates.delete(id);
	}

	/** Every stored record of the job, in run id order, page by page with plain reads (activation holds the line). */
	// 输入 context（用于取消与计数）；输出按 id 排序的记录数组，同时把存储位置填进 #stored。
	// 流程：读取一页键 -> 逐个读取文档 -> 跳过并发删除的键 -> 记入内存；不足一页说明读完了。
	// 例：有 250 条记录时读三页（100/100/50），最后一页返回后结束循环。
	async load(context: Context): Promise<LoadedRecord[]> {
		const loaded: LoadedRecord[] = [];
		// after 是上一页最后一个键；undefined 表示从开头读。keys() 按 code point 顺序返回。
		let after: string | undefined;
		for (;;) {
			const keys = await this.#records.keys(after, KEYS_PAGE, context);
			for (const id of keys) {
				const document = await this.#records.read(id, context);
				// keys 与 read 之间可能有并发删除（另一个对象实例/恢复流程）；跳过不存在的键而不是报错。
				if (document === undefined) continue;
				const { record: stored, value, deltasSinceBase } = document;
				// 这里的 stored 是文档引擎的元数据（record 字段名容易与 StoredRun 混淆），重组成内存的 Stored。
				const found = { id: stored.id, revision: stored.revision, version: stored.version, deltasSinceBase };
				this.#stored.set(id, found);
				// value 的类型是 JsonObject（引擎保证），recordOf 再做一次契约断言还原 StoredRun。
				loaded.push({ id, record: recordOf(value as JsonObject), stored: found });
			}
			// 少于整页即到末尾；否则用本页最后一个键继续（at(-1) 支持负索引）。
			if (keys.length < KEYS_PAGE) return loaded;
			after = keys.at(-1);
		}
	}

	/** The object's documents are dropped: nothing is known of the store any more. */
	// 对象结束时调用；只清内存映射，不产生写（对象结束时的写由 close writer 单独处理）。
	drop(): void {
		this.#stored.clear();
		this.#blockedStates.clear();
	}
}
