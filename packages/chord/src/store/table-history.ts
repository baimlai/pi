// A table's history (slice 6a §9; decision "Second spec review: the majority"): the versions from a base
// `defineTable` through each `evolveTable`, the migration each version recorded, and what an activation does with the
// version the store recorded: create the table, use it, migrate it from there, or refuse it.

// 本文件描述表的历史与激活计划：planTable 把代码里的最新定义与 store 记录的版本、状态、指纹对比，
// 决定建表（create）、直接使用（ready）还是逐版迁移（migrate，含 resume）；它不执行任何 SQL。
// 上游是 table-evolve 生成的版本链与 catalog 读出的 TableRecord；下游是 table-migration 的建表/迁移执行。
//
// 能力清单（导出项）：
// - TableEdit：迁移中的一次结构编辑（rename/add/drop/json/index/dropIndex）的纯数据形式。
// - AlterEdit：其中进入 alter 写的四种（rename/add/drop/json）。
// - DataStep：一个版本的数据步骤，rows（逐行 patch）或 update（一条 updateWhere）。
// - Migration：before 编辑、可选数据步骤、after 编辑三部分。
// - TablePlan：激活计划，create/ready/migrate（含 versions 与 first=begin|resume）。
// - planTable：比较代码最新定义与 store 记录，得出上述计划。
//
// 典型顺序：defineTable/evolveTable 产生版本链 → 激活时 planTable 读取记录并给出计划 →
// table-migration 按计划建表或逐版本执行；本文件不执行 SQL。
// 示例：const recorded = store.table("app.store:edits"); planTable(EditsV3, recorded, `app.store: table "edits"`)，
// 当 recorded 停在 v1 且状态为 ready 时得到 { kind: "migrate", versions: [V2, V3], first: "begin" }。
// 建议阅读顺序：TableEdit/AlterEdit → DataStep → Migration → TablePlan → planTable → historyOf。

import type { TableRecord } from "./catalog.ts";
import type { ColumnRecord } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import type { TableDefinition } from "./table.ts";

/** One edit of a migration as its writes record it (`alter`, `index`, `dropIndex`); the table is named when applied. */
// TableEdit 是迁移中一次结构编辑的纯数据形式，会写进 outbox/归档并在应用端重放：
// rename 改列名，add 加列（带 ColumnRecord），drop 删列，json 改 json 列定义（只改记录，单元格读取时再迁移），
// index/dropIndex 增删索引。联合类型只约束代码；从归档读入的同形数据仍需 applier 在信任边界校验。
export type TableEdit =
	| { readonly kind: "rename"; readonly from: string; readonly to: string }
	| { readonly kind: "add"; readonly name: string; readonly column: ColumnRecord }
	| { readonly kind: "drop"; readonly name: string }
	| { readonly kind: "json"; readonly name: string; readonly column: ColumnRecord }
	| { readonly kind: "index"; readonly name: string; readonly columns: readonly string[] }
	| { readonly kind: "dropIndex"; readonly name: string };

/** The column edits an `alter` write records. */
// Extract<TableEdit, { kind: "rename" | "add" | "drop" | "json" }> 从联合中筛出会进入 alter 写的那几种；
// index/dropIndex 有各自的写类型，不走 alter。Extract 是编译期条件类型，运行时没有任何动作。
export type AlterEdit = Extract<TableEdit, { readonly kind: "rename" | "add" | "drop" | "json" }>;

/**
 * A version's data step over `table`, the columns between the edits before it and after it: `rows` patches each row
 * (synchronous and pure), `update` is one `updateWhere`.
 */
// DataStep 描述一个版本的数据迁移步骤；table 中的列是“步骤前编辑之后、步骤后编辑之前”的形态。
// rows 对每一行调用同步纯函数 patch；update 在声明时编译成一条 updateWhere。
// patch 返回 unknown，运行时由 table-migration 的 patchRow 逐列校验；where/set 则已在声明阶段编译。
export type DataStep =
	| {
			readonly kind: "rows";
			readonly table: TableDefinition;
			readonly patch: (row: { readonly [column: string]: unknown }) => unknown;
	  }
	| {
			readonly kind: "update";
			readonly table: TableDefinition;
			readonly where: WhereNode | undefined;
			readonly set: SetNode;
	  };

/** What one `evolveTable` changed: the edits before the data step, the step, the edits after it. */
// Migration 是一次 evolveTable 的全部改动：数据步骤之前的结构编辑、可选的数据步骤、之后的编辑。
// 执行时 before 与迁移记录一起提交 (A)，数据步骤按块提交，after 在最后一块 (Z) 提交。
export type Migration = {
	// before 里的 rename/add/json 必须在数据步骤读取行之前生效。
	readonly before: readonly TableEdit[];
	readonly step: DataStep | undefined;
	// after 里的 drop/dropIndex/index 可以等数据步骤完成后再做。
	readonly after: readonly TableEdit[];
};

/**
 * What an activation does with a declared table: create it at the newest version, use it as recorded, or migrate it
 * through `versions` (oldest first), the first one from its start (`begin`) or, recorded `migrating`, after its (A)
 * commit (`resume`).
 */
// TablePlan 是 planTable 的结果：create 建新表；ready 版本已就绪；migrate 给出要依次执行的版本（从旧到新）。
// first 为 begin 表示从该版本 (A) 开始；为 resume 表示记录状态已是 migrating，跳过 (A) 直接从数据分块继续。
export type TablePlan =
	| { readonly kind: "create" }
	| { readonly kind: "ready" }
	| {
			readonly kind: "migrate";
			readonly versions: readonly TableDefinition[];
			// begin 会先做该版本的 before 编辑并记录 migrating；resume 假定 (A) 已完成。
			readonly first: "begin" | "resume";
	  };

/**
 * The plan for `definition` (the code's newest version) against `recorded`. A recorded version newer than the newest,
 * older than the history's base, or the same version with another fingerprint (a history edited in place) throws:
 * the object fails `broken`, the data stays.
 */
// 计算 definition（代码最新版本）相对记录版本 recorded 的激活计划；只读参数、无副作用。
// 返回 create/ready/migrate。recorded 更新、低于历史基准、同版本指纹不同，或记录 migrating 却没有数据步骤时
// 抛 Error，由调用方把对象标为 broken，数据保持原样。
// 示例：代码 v3、记录 v1（ready）→ { kind: "migrate", versions: [v2, v3], first: "begin" }。
export function planTable(definition: TableDefinition, recorded: TableRecord | undefined, what: string): TablePlan {
	// store 里没有这张表：新表按最新版本一次建成，无需迁移。
	if (recorded === undefined) return { kind: "create" };
	// 从记录里取出计划需要的三个字段；其余字段（columns 等）由指纹间接覆盖。
	const { version, state, fingerprint } = recorded;
	// 代码比 store 旧：不能猜测新版本的数据含义，拒绝让旧代码降级读取。
	if (version > definition.version) {
		throw new Error(`${what}: the store has version ${version}, newer than the code's ${definition.version}`);
	}
	// 沿 evolution.previous 回溯，得到由旧到新的完整历史。
	const versions = historyOf(definition);
	// 记录版本必须出现在历史中；找不到说明代码换了基准版本，旧数据无法沿当前历史迁移。
	const at = versions.find((each) => each.version === version);
	if (at === undefined) {
		throw new Error(
			`${what}: the store has version ${version}, older than the history's base ${versions[0]!.version}`,
		);
	}
	// 同版本但指纹不同 = 定义被原地修改；已记录的迁移步骤不再可信，必须拒绝。
	if (at.fingerprint !== fingerprint) {
		throw new Error(`${what}: version ${version} is recorded with another definition (a history edited in place)`);
	}
	// 记录版本就是代码最新版本且已就绪：不需要写任何东西。
	if (state === "ready" && version === definition.version) return { kind: "ready" };
	// migrating 表示上一轮在数据步骤中途中断；没有数据步骤就无法续跑，也无法确认旧数据已处理。
	if (state === "migrating" && at.evolution?.migration.step === undefined) {
		throw new Error(`${what}: version ${version} is recorded migrating, but has no data step to resume`);
	}
	// resume 把当前版本也纳入 versions：它的 (A) 已完成，迁移从该版本的数据分块继续。
	if (state === "migrating") {
		return { kind: "migrate", versions: versions.filter((each) => each.version >= version), first: "resume" };
	}
	// ready 且落后：从下一版开始，记录版本本身无需重做。
	return { kind: "migrate", versions: versions.filter((each) => each.version > version), first: "begin" };
}

/** Every version of `definition`'s history, the base first. */
// 收集 definition 所在历史的全部版本，基准版本在前：沿 evolution.previous 链回溯，用 unshift 保持由旧到新。
// 示例：v3 → [v1, v2, v3]；基准版本没有 evolution，循环条件随即结束。
function historyOf(definition: TableDefinition): TableDefinition[] {
	const versions: TableDefinition[] = [];
	// at 从最新版本开始；每次取上一版本，undefined 时停止，因此不会漏掉基准版本。
	for (let at: TableDefinition | undefined = definition; at !== undefined; at = at.evolution?.previous) {
		versions.unshift(at);
	}
	return versions;
}
