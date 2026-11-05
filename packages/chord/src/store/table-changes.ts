// A transaction's writes to one table (slice 6a §6, §7; W10): checked and staged synchronously like a draft's ops (no
// I/O, a bad row throws at its own call), kept in staging order for the commit step, and overlaid on committed rows
// for `tx.get` until a bulk write makes that impossible (`invalid/read_after_bulk`).

// 文件导读
// 所属：packages/chord/src/store（store 层，单事务对单表的写入队列与 overlay）。
// 职责边界：同步校验并暂存 put/update/delete/updateWhere/deleteWhere，维护按键的 overlay 供 tx.get；不做 I/O，不提交事务。
// 上游：TableHandle 的写方法委托给它，所有表共享同一 staged 数组。下游：table-writes 生成 StagedWrite 供提交步骤执行；get 读取 committed 行后重放 overlay。
// 能力清单：
// - KeyWrite（内部）：put/update/delete 三种 overlay 记录；
// - TableChanges：写入入口与 overlay；
// - put/update/delete：单键写；
// - updateWhere/deleteWhere：批量写并置 #bulk；
// - get：按键合并 committed 行与 overlay；
// - #set/#write（内部）：编译 set、追加 overlay。
// 组合顺序：TableHandle.put -> rows.put 编码 -> staged.push(stagePut) -> #write 记录 overlay；批量写后 get 抛 invalid/read_after_bulk。
// 示例：changes.put({ id: 1, n: 2 }); await changes.get({ id: 1 }, ctx) 返回刚写入的行，无需等待提交。
// 建议阅读顺序：KeyWrite/TableChanges 字段 -> put/update/delete -> updateWhere/deleteWhere -> get -> #set/#write。
import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import { applySet, type EvaluatedRow } from "./evaluate.ts";
import { compileSet, compileWhere, type SetNode } from "./expression.ts";
import type { StagedWrite } from "./step.ts";
import type { TableHandle } from "./table-handle.ts";
import {
	jsonVersions,
	recordedVersions,
	stageDelete,
	stageDeleteWhere,
	stagePut,
	stageUpdate,
	stageUpdateWhere,
} from "./table-writes.ts";

/** One staged write of one key, as the overlay replays it. */
// overlay 记录：put 保存整行，update 保存 set 节点，delete 表示已删除。
type KeyWrite =
	| { readonly kind: "put"; readonly row: EvaluatedRow }
	| { readonly kind: "update"; readonly set: SetNode }
	| { readonly kind: "delete" };

/**
 * The writes of one transaction to one table: each appended to the transaction's staged list (`staged`, one order
 * across tables) and, for the single-key ones, to its key's overlay.
 */
// 一个事务对一张表的写入：staged 按全局提交顺序，byKey 供 tx.get 重放。
export class TableChanges {
	readonly handle: TableHandle;
	// 与其它表共享同一 staged 数组，保证提交步骤内全局顺序。
	readonly #staged: StagedWrite[];
	// 键身份（编码后的 JSON 参数）到该键写入序列；get 按键重放。
	readonly #byKey = new Map<string, KeyWrite[]>();
	/** An `updateWhere` or `deleteWhere` was staged: `get` is refused from then on (W10). */
	// 批量写之后 overlay 无法精确回答单键读，get 直接拒绝。
	#bulk = false;

	// 只保存句柄与共享 staged；不做 I/O。
	constructor(handle: TableHandle, staged: StagedWrite[]) {
		this.handle = handle;
		this.#staged = staged;
	}

	/** Stages a `put` of `row` (an upsert). */
	// 暂存 put（upsert）：校验行、生成 SQL、记录 overlay。
	put(row: unknown): void {
		const { definition, sql } = this.handle;
		// 行在此刻按当前表版本校验并编码；错误立即抛在调用点。
		const encoded = definition.rows.put(row, definition.version);
		// staged 顺序就是提交执行顺序；同一键的 put 覆盖旧行。
		this.#staged.push(stagePut(sql.put, sql.table, encoded, definition.version));
		// overlay 保存整行，供本事务后续 get 使用。
		this.#write(encoded.id, { kind: "put", row: encoded.row });
	}

	/** Stages an `update` of the row with `key` (`set`: values, or a callback of column references). */
	// 暂存按键更新：键与 set 先检查，再生成 SQL 与 overlay。
	update(key: unknown, set: unknown): void {
		const { definition, sql } = this.handle;
		// 键先编码；未知字段或类型不符立即抛 invalid/args。
		const encoded = definition.rows.key(key, "update");
		// set 是插件值或回调，编译时检查列与表达式类型。
		const compiled = this.#set(set, "update");
		// 写入 json 列时还要记录版本，供 outbox 与列版本列使用。
		const versions = jsonVersions(this.handle.definition, compiled);
		// SQL 用键参数定位行；stageUpdate 记录 outbox 所需信息。
		this.#staged.push(
			stageUpdate(
				sql.update(compiled, encoded.params, versions),
				sql.table,
				encoded.key,
				compiled,
				recordedVersions(compiled, versions),
			),
		);
		// overlay 只保存 set 节点，get 时按顺序重放。
		this.#write(encoded.id, { kind: "update", set: compiled });
	}

	/** Stages a `delete` of the row with `key`. */
	// 暂存按键删除。
	delete(key: unknown): void {
		const { definition, sql } = this.handle;
		// 键编码同样在暂存时完成。
		const encoded = definition.rows.key(key, "delete");
		// 参数数组复制一份，避免后续修改影响已暂存语句。
		this.#staged.push(stageDelete({ sql: sql.delete, params: [...encoded.params] }, sql.table, encoded.key));
		// overlay 标记删除；后续 get 返回 undefined。
		this.#write(encoded.id, { kind: "delete" });
	}

	/** Stages an `updateWhere`: every row matching `where` gets `set`. */
	// 暂存批量更新：where/set 都先编译，再生成一条 SQL。
	updateWhere(where: unknown, set: unknown): void {
		const { definition, sql } = this.handle;
		// where 可以是回调或 Condition；回调收到列引用。
		const condition = compileWhere(
			definition,
			typeof where === "function" ? where(definition.refs) : where,
			"updateWhere",
		);
		// set 同样在暂存时编译，错误不会留到提交阶段。
		const compiled = this.#set(set, "updateWhere");
		const versions = jsonVersions(this.handle.definition, compiled);
		// 一条 SQL 更新所有匹配行。
		const statement = sql.updateWhere(condition, compiled, versions);
		this.#staged.push(
			stageUpdateWhere(statement, sql.table, condition, compiled, recordedVersions(compiled, versions)),
		);
		// 批量写后单键 overlay 不再可靠，get 改为拒绝（W10）。
		this.#bulk = true;
	}

	/** Stages a `deleteWhere`: every row matching `where` goes. */
	// 暂存批量删除；只有 where 需要编译。
	deleteWhere(where: unknown): void {
		const { definition, sql } = this.handle;
		// 与 updateWhere 相同的条件编译路径。
		const condition = compileWhere(
			definition,
			typeof where === "function" ? where(definition.refs) : where,
			"deleteWhere",
		);
		// 一条 SQL 删除所有匹配行。
		this.#staged.push(stageDeleteWhere(sql.deleteWhere(condition), sql.table, condition));
		// 批量删除后同样禁止 tx.get。
		this.#bulk = true;
	}

	/**
	 * The row with `key` as this transaction leaves it: the committed row with this transaction's `put`, `update` and
	 * `delete` of the key replayed; refused after a bulk write (W10).
	 */
	// 读取本事务视角下的单行：committed 行叠加本事务对该键的写入。
	// 输入是键与 context；输出行或 undefined；批量写后抛 invalid/read_after_bulk。
	// 示例：put 后立即 get 能读到新行；delete 后 get 返回 undefined。
	async get(key: unknown, context: Context): Promise<EvaluatedRow | undefined> {
		const { definition } = this.handle;
		// W10：批量写影响未知行集，无法再用按键 overlay 精确回答。
		if (this.#bulk) {
			throw invalid(
				"read_after_bulk",
				`${definition.name}: tx.get after an updateWhere or deleteWhere on the table`,
			);
		}
		// 键编码后查 overlay；未知键/坏键在这里拒绝。
		const encoded = definition.rows.key(key, "get");
		// 没有 overlay 时写入序列为空，只读 committed 行。
		const writes = this.#byKey.get(encoded.id) ?? [];
		// 从尾部向前跳过连续的 update，找到最后一个整体状态（put/delete）。
		let start = writes.length;
		while (start > 0 && writes[start - 1]!.kind === "update") start--;
		// start 前一个是起点；其后的 update 需要按顺序重放。
		const from = writes[start - 1];
		// A committed row is decoded by the table's columns: scalars and JSON, what the evaluator takes.
		// 起点缺失时读 committed；put 直接用 overlay 行；delete 得 undefined。
		let row: EvaluatedRow | undefined =
			from === undefined
				? ((await this.handle.get(encoded.key, context)) as EvaluatedRow | undefined)
				: from.kind === "put"
					? from.row
					: undefined;
		// 只有 update 会改变起点行；put/delete 已在起点处理。
		for (const write of writes.slice(start)) {
			// An `update` of an absent row changes nothing.
			if (row !== undefined && write.kind === "update") row = applySet(write.set, row, definition.name);
		}
		return row;
	}

	// 把 set（值或回调）编译成 SetNode；回调收到表列引用。
	#set(set: unknown, what: string): SetNode {
		const { definition } = this.handle;
		return compileSet(definition, typeof set === "function" ? set(definition.refs) : set, what);
	}

	// 追加 overlay 记录；同一个键保持写入顺序。
	#write(id: string, write: KeyWrite): void {
		const writes = this.#byKey.get(id);
		if (writes === undefined) this.#byKey.set(id, [write]);
		else writes.push(write);
	}
}
