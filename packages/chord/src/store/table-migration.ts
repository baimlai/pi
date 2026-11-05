// Declared tables brought to their version at activation (slice 6a §9): a table the store does not have is created at
// the newest version with its indexes (no replay); an older one is migrated eagerly, one version at a time, in its
// commits. Per version N: (A) the edits before the data step and `table { version: N, state: "migrating" }`; the data
// step's chunks; (Z) the last chunk (or the `update`) with the edits after the step and `state: "ready"`. Without a
// data step (A) and (Z) are one commit. A version recorded `migrating` resumes after (A), skipping the rows already
// stamped `$v >= N`. Its record holds the columns during the step but version N's fingerprint, not the fingerprint of
// those columns: the fingerprint names the version being reached, which resume, export and import check.

// 本文件执行表激活时的迁移：新表按最新版本一次创建；旧表逐版本、逐块提交迁移。
// 每个版本 N 分为 (A) before 编辑 + migrating 记录、数据步骤分块、(Z) after 编辑 + ready 记录；
// 没有数据步骤时 (A)(Z) 合并。中断后从 migrating 状态续跑，跳过 $v 已标记的旧块。
// 上游是 prepareTables（激活流程）；下游是 table-writes 的暂存写与 store 的提交队列。
//
// 能力清单（导出项）：
// - DeclaredTable：激活输入，最新定义 definition 与 SQL 名 table。
// - prepareTables：把一批声明表建表或迁移到最新版本，是激活调用的入口。
// - MIGRATION_CHUNK：rows 数据步骤每块的行数（100），也是每次提交的写数量。
// 非导出：MigrationTarget（store/table/fence 上下文）、creation、migrateTable、migrateVersion、
// migrateSteps、recordOf、updateStep、rowsStep、macrotask、patchRow、cellOf、sqlOf、commit。
//
// 组合关系：prepareTables 对各表调用 planTable（table-history）→ 新表一次提交 creation；
// 旧表 migrateTable 逐版本调用 migrateSteps，后者用 stageEdit/recordOf 组 (A)/(Z)，
// 数据步骤走 updateStep 或 rowsStep（内部 patchRow/cellOf，分块间 macrotask，await commit）。
// 示例：await prepareTables([{ definition: Edits, table: "app.store:edits" }], store, fence, "app.store", context);
// 建议阅读顺序：DeclaredTable → prepareTables → migrateTable/migrateVersion → migrateSteps →
// updateStep/rowsStep → patchRow/cellOf → sqlOf/macrotask/commit。

import { type Context, withoutAbortSignal } from "../context/index.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { Column } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import { encodeCell, ROW_VERSION, type Scalar } from "./rows.ts";
import { type Order, TableSql } from "./sql.ts";
import type { StagedWrite } from "./step.ts";
import type { ChordStore, CommitFence } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import { type DataStep, planTable, type TablePlan } from "./table-history.ts";
import {
	jsonVersions,
	recordedVersions,
	stageEdit,
	stageIndex,
	stageTable,
	stageUpdate,
	stageUpdateWhere,
} from "./table-writes.ts";

/** A declared table: its newest definition and its SQL name. */
// DeclaredTable 是激活输入：definition 是代码最新版本，table 是它的 SQL 名（<owner>:<table>）。
// definition.name 只是声明名，不能直接当 SQL 名用，所以这里显式保存两者。
export type DeclaredTable = { readonly definition: TableDefinition; readonly table: string };

/** Where a migration runs: the store, the table's SQL name and the commits' fence. */
// MigrationTarget 汇总迁移执行所需的上下文：store 提供提交队列与提交后目录，table 是 SQL 名，
// fence 是激活的提交栅栏（admit/adopt）；内部类型，不导出。
type MigrationTarget = { readonly store: ChordStore; readonly table: string; readonly fence: CommitFence };

/**
 * Brings `tables` to their definitions: the ones the store does not have created in one commit, then each older one
 * migrated. A table the code cannot use (see `planTable`) throws before anything is written; `what` names the owner.
 */
// 把一批声明表带到各自的最新版本：先为 store 中不存在的表生成建表/索引写并一次提交，再逐张迁移旧表。
// planTable 的拒绝（更新版本、基准不符、指纹不同）在写任何东西之前抛出；what 标明调用方（例如 "app.store"）。
// 返回 Promise<void>；失败时已提交的创建/迁移块保留，未执行的表不再处理。
// 示例：prepareTables([{ definition: Edits, table: "app.store:edits" }], store, fence, "app.store", context)。
export async function prepareTables(
	tables: readonly DeclaredTable[],
	store: ChordStore,
	fence: CommitFence,
	what: string,
	context: Context,
): Promise<void> {
	// 两类工作分开收集：新建表可以一次提交，迁移必须按表逐版执行。
	const created: StagedWrite[] = [];
	const migrations: { readonly table: string; readonly plan: Extract<TablePlan, { readonly kind: "migrate" }> }[] = [];
	for (const { definition, table } of tables) {
		// 已记录的版本/状态决定 create、ready 或 migrate；不可用的定义在这里抛错。
		const plan = planTable(definition, store.table(table), `${what}: table "${definition.name}"`);
		// creation 返回 table + index 写；ready 不需要任何写；migrate 进入下一阶段。
		if (plan.kind === "create") created.push(...creation(definition, table));
		else if (plan.kind === "migrate") migrations.push({ table, plan });
	}
	// 所有新表放在一个提交里，减少一次激活的 commit 数。
	if (created.length > 0) await commit(created, { store, fence }, context);
	// 旧表逐张迁移；每张表内部再逐版本、逐块提交。
	for (const { table, plan } of migrations) {
		await migrateTable(plan, { store, table, fence }, context);
	}
}

/** The writes creating `definition` fresh as `table`: at its version, `ready`, with its indexes. */
// 为一张全新表生成写：一条 table 记录（最新版本、ready、指纹）以及每个索引一条 index 写。
// 属性解构里的 record: columns 把 definition.record 重命名为 columns，避免与后续变量重名。
function creation(definition: TableDefinition, table: string): StagedWrite[] {
	const { version, record: columns, key, fingerprint } = definition;
	return [
		stageTable({ kind: "table", table, version, state: "ready", columns, key, fingerprint }),
		// [...definition.indexes] 把 Map 转成 [name, columns] 条目数组；map 生成暂存写。
		...[...definition.indexes].map(([name, columns]) => stageIndex({ kind: "index", table, name, columns })),
	];
}

/**
 * Migrates the table through the plan's versions (oldest first, each with its migration), the first resumed after its
 * (A) commit when the plan says so. `context`'s abort is checked between chunks (a chunk admitted to the step completes); a data
 * step that throws, or returns a patch the version cannot take, rejects: the table stays `migrating` and the committed
 * chunks stay.
 */
// 按计划逐版本迁移：versions 从旧到新；第一个版本使用 plan.first（begin 或 resume），其后都是 begin。
// entries() 同时给索引与版本对象，index === 0 用于区分首版。错误直接向上抛，已提交的分块保留。
async function migrateTable(
	plan: Extract<TablePlan, { readonly kind: "migrate" }>,
	target: MigrationTarget,
	context: Context,
): Promise<void> {
	for (const [index, version] of plan.versions.entries()) {
		await migrateVersion(version, index === 0 ? plan.first : "begin", target, context);
	}
}

/** The size of a `rows` chunk: one commit each. */
// rows 数据步骤每块的行数，也是每次提交的写数量；100 与测试及成本模型一致。
export const MIGRATION_CHUNK = 100;

/** Migrates to `definition`'s version from its (A) commit (`begin`) or after it (`resume`). */
// 迁移到 definition 版本：先向 store 公告目标版本，使旧句柄立刻被版本栅栏拒绝，
// 再执行本版本的提交；finally 中撤回公告（即使中途抛错或中止）。公告覆盖 (A)(Z) 之间的所有分块。
async function migrateVersion(
	definition: TableDefinition,
	from: "begin" | "resume",
	target: MigrationTarget,
	context: Context,
): Promise<void> {
	const { table } = target;
	// Old handles are refused from now on: their SQL must never queue behind this version's DDL.
	// 公告期间 tableVersion 返回目标版本，旧 handle 的读会在 SQL 入队前被拒绝。
	const withdraw = target.store.announceTable(table, definition.version);
	try {
		await migrateSteps(definition, from, target, context);
	} finally {
		// 无论成功或失败都撤回；后续 handle 以已记录版本为准。
		withdraw();
	}
}

/** The commits of `migrateVersion`. */
// 一个版本的提交序列：拆出 before 编辑、数据步骤、after 编辑。
// 无数据步骤时 (A)+(Z) 合成一次提交；update 步骤是 (A) → 一条 updateWhere+ready；
// rows 步骤是 (A) → 分块 → 最后一块+ready。from 决定是否跳过 (A)（resume）。
async function migrateSteps(
	definition: TableDefinition,
	from: "begin" | "resume",
	target: MigrationTarget,
	context: Context,
): Promise<void> {
	// 迁移版本必然有 evolution；非空断言表达这个调用前提。
	const { before, step, after } = definition.evolution!.migration;
	const { table } = target;
	// 把 TableEdit 列表映射成该版本的暂存写；version 固定为目标版本。
	const edits = (list: typeof before): StagedWrite[] => list.map((edit) => stageEdit(table, definition.version, edit));
	// (Z) 的公共部分：after 编辑 + state ready 的 table 记录。
	const ready = [...edits(after), recordOf(definition, definition, "ready", table)];
	// 没有数据步骤：before 与 ready 一次提交，跳过 migrating 状态。
	if (step === undefined) return commit([...edits(before), ...ready], target, context);
	// begin 先提交 (A)：before 编辑 + 迁移中的记录；resume 假定 (A) 已提交。
	if (from === "begin")
		await commit([...edits(before), recordOf(step.table, definition, "migrating", table)], target, context);
	// update 步骤本身是一条语句，与 ready 同一提交完成。
	if (step.kind === "update") return commit([updateStep(step, definition.version, table), ...ready], target, context);
	// rows 步骤需要分块；ready 交给最后一块。
	await rowsStep(step, definition.version, ready, target, context);
}

/** The `table` write of `table`'s columns and key, with `definition`'s version and fingerprint, in `state`. */
// 构造 table 写：columns/key 取自 columns 定义（数据步骤进行中的列形态），version/fingerprint 取自最终定义。
// 这正是迁移记录的特殊之处：目录记录当前列，但版本/指纹指向目标版本，供 resume/import 校验。
function recordOf(
	columns: TableDefinition,
	definition: TableDefinition,
	state: "ready" | "migrating",
	table: string,
): StagedWrite {
	const { version, fingerprint } = definition;
	return stageTable({ kind: "table", table, version, state, columns: columns.record, key: columns.key, fingerprint });
}

/** The `update` step: one `updateWhere` over the rows below version `v`, stamping it, so it never applies twice. */
// 把 update 数据步骤编译成一条 updateWhere：只处理 $v < v 的未迁移行，并在 set 中写入 $v = v，
// 因此重复执行不会再次命中已迁移行。where 为空时只用版本条件。返回暂存写；SQL 在此渲染，提交时执行。
function updateStep(step: Extract<DataStep, { readonly kind: "update" }>, v: number, table: string): StagedWrite {
	const sql = sqlOf(step.table, table);
	// 内部行版本列 ROW_VERSION（"$v"）记录每行已到哪个表版本。
	const below: WhereNode = { lt: [ROW_VERSION, v] };
	// 用户条件与版本条件用 and 组合；and 节点在 sql.ts 渲染为括号内的 AND。
	const where: WhereNode = step.where === undefined ? below : { and: [step.where, below] };
	const versions = jsonVersions(step.table, step.set);
	// 展开 step.set 并追加 $v；sql.updateWhere 的 versions 参数决定 json 列版本列的赋值。
	const statement = sql.updateWhere(where, { ...step.set, [ROW_VERSION]: v }, versions);
	// 记录的 set 不含内部 $v（recordedVersions 只看用户 set），version 字段单独记录目标版本。
	return stageUpdateWhere(statement, table, where, step.set, recordedVersions(step.set, versions), v);
}

/**
 * The `rows` step: chunks of `MIGRATION_CHUNK` rows below version `v` in key order, paging forward by the last key;
 * each patched row stamped `v`; the last chunk commits with `ready`.
 */
// rows 数据步骤：按主键升序分页读取 $v < v 的行，每块最多 MIGRATION_CHUNK 行；对每行调用 patchRow 并提交 update 写；
// 最后一块附带 ready。游标用“上一块最后一行的主键”向前翻页，避免 OFFSET 成本。
// 每块之间通过 macrotask 让出事件循环并检查 abort；已进入提交的行不会被取消。
async function rowsStep(
	step: Extract<DataStep, { readonly kind: "rows" }>,
	v: number,
	ready: readonly StagedWrite[],
	target: MigrationTarget,
	context: Context,
): Promise<void> {
	const { table: columns } = step;
	const sql = sqlOf(columns, target.table);
	// 只按主键升序；主键唯一，因此分页无歧义。
	const order: Order = { columns: columns.key, direction: "asc" };
	const below: WhereNode = { lt: [ROW_VERSION, v] };
	let after: SqliteValue[] | undefined;
	// The fallback yield between chunks (`macrotask`), made by the first yield that needs it, closed at the end.
	// 延迟创建 MessageChannel：只有需要时（运行时无 setImmediate）才分配端口。
	let channel: InstanceType<typeof MessageChannel> | undefined;
	try {
		for (;;) {
			// 多取 1 行判断是否最后一块，与 page 的技巧相同。
			const statement = sql.select(below, order, after, MIGRATION_CHUNK + 1);
			// 读取不属于提交队列；但后续写提交会与并发写串行。
			const stored = await target.store.read(
				(executor) => executor.all<{ [column: string]: SqliteValue }>(statement.sql, ...statement.params),
				context,
			);
			const last = stored.length <= MIGRATION_CHUNK;
			// 截断探测行；后面只用前 MIGRATION_CHUNK 行。
			if (!last) stored.length = MIGRATION_CHUNK;
			// 每行生成一个暂存 update；patchRow 内部已解码并校验。
			const writes = stored.map((row) => patchRow(step, row, v, sql, target.table, context));
			// 最后一块把 ready 一起提交，迁移原子完成。
			if (last) return await commit([...writes, ...ready], target, context);
			await commit(writes, target, context);
			// 下一块的起点是上一块最后一行（截断后第 chunk 行）的主键值；! 由长度保证。
			after = columns.key.map((name) => stored[MIGRATION_CHUNK - 1]![name]!);
			// channel ??= 只在第一次调用时创建；闭包让 macrotask 在需要时才取。
			await macrotask(() => {
				channel ??= new MessageChannel();
				return channel;
			});
			// An abandoned activation stops here.
			// 激活被放弃时在这里停止；此时已提交的块保留，记录仍是 migrating。
			context.abortSignal?.throwIfAborted();
		}
	} finally {
		// 关闭端口，释放消息通道资源。
		channel?.port1.close();
	}
}

/**
 * Resolves after one macrotask (other commits and timers run between chunks) without the 1 ms clamp of
 * `setTimeout(0)`: `setImmediate` where the runtime has it (Node), else a message through the channel `channel()`
 * gives (browsers, Workers). In Node a message costs 0.27 ms per yield against `setImmediate`'s 13 µs (the 10k-row
 * migration bench: 100 ms against 70 ms).
 */
// 返回一个在“宏任务”后 resolve 的 Promise，让其他提交/定时器在分块之间运行；不用 setTimeout(0) 的 1ms 下限。
// 优先 setImmediate（Node），否则用 MessageChannel 消息（浏览器/Workers）。channel 回调按需提供通道。
function macrotask(channel: () => InstanceType<typeof MessageChannel>): Promise<void> {
	return new Promise((resolve) => {
		// A runtime feature check: Workers and browsers have no `setImmediate`. Read once from the global, and called only
		// when it is a function: a check by name (`in`) and a later lookup could disagree.
		// 运行时特性检查：Workers/浏览器没有 setImmediate；只读一次全局值，避免“先检查后查找”不一致。
		const immediate = (globalThis as { readonly setImmediate?: unknown }).setImmediate;
		// typeof === "function" 是运行时收窄：类型声明只是可选的全局。
		if (typeof immediate === "function") {
			immediate(resolve);
			return;
		}
		const { port1, port2 } = channel();
		// once: true 使消息只触发一次，Promise 只 resolve 一次。
		port1.addEventListener("message", () => resolve(), { once: true });
		// A port listened to with `addEventListener` delivers only once started (browsers, Workers).
		// addEventListener 监听的消息端口必须 start() 才会投递。
		port1.start();
		// 发送一条空消息；消息到达即代表一个宏任务边界。
		port2.postMessage(null);
	});
}

/**
 * The write of one row's patch: `patch` run on the decoded row, its result checked (an object of non-key columns of
 * the version, values of their types) and stamped `v` through the internal form of `update`.
 */
// 对一行执行 rows patch，并把结果转成一条按键 update：解码该行（按步骤时的列形态）→ 调用同步 patch →
// 校验返回对象/列名/非主键 → 用 cellOf 规范化值 → 取主键值 → 生成 update SQL 与暂存写。
// patch 抛错会中止迁移，已提交块保留。
function patchRow(
	step: Extract<DataStep, { readonly kind: "rows" }>,
	stored: { readonly [column: string]: SqliteValue },
	v: number,
	sql: TableSql,
	table: string,
	context: Context,
): StagedWrite {
	const { table: definition } = step;
	// patch 是插件代码：这里只调用一次，不捕获其异常；decode 失败也会向上抛。
	const patch = step.patch(definition.rows.decode(stored, context));
	const what = `${definition.name} version ${v}: rows`;
	// 运行时校验 patch 结果形状，因为插件返回类型在 JS 中不可信。
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
		throw new Error(`${what}: expected an object of column values`);
	}
	const set: { [column: string]: SetNode[string] } = {};
	for (const [name, value] of Object.entries(patch)) {
		const column = definition.byName.get(name);
		if (column === undefined) throw new Error(`${what}: no column "${name}"`);
		if (definition.key.includes(name)) throw new Error(`${what}: key column "${name}" cannot change`);
		set[name] = cellOf(column, value, `${what}: column "${name}"`);
	}
	const key: { [column: string]: Scalar } = {};
	// Key columns are non-opt `str` or `int`: stored scalars.
	// 主键列非 opt 且为 str/int，存的值就是标量；断言只表达这个声明约束。
	for (const name of definition.key) key[name] = stored[name] as Scalar;
	const versions = jsonVersions(definition, set);
	const params = definition.key.map((name) => stored[name]!);
	// 用主键值作为 WHERE 参数，并追加 $v = v；set 里也带 $v（内部 update 形式）。
	const statement = sql.update({ ...set, [ROW_VERSION]: v }, params, versions);
	return stageUpdate(statement, table, key, set, recordedVersions(set, versions), v);
}

/**
 * A patch value as a `set` node: `undefined` clears an `opt(...)` column, `json(...)` cells as JSON literals (a JSON
 * `null` too); a scalar `null` is refused by `encodeCell`.
 */
// 把 patch 的单个返回值规范化成 SetNode 的值：undefined 只允许清空 opt 列；其余交给 encodeCell 做类型校验/JSON 编码；
// json 列包成 { json: ... } 表达式（JSON null 也是合法值），标量列直接取 stored。
function cellOf(column: Column, value: unknown, what: string): SetNode[string] {
	if (value === undefined) {
		if (!column.optional) throw new Error(`${what} is not opt(...) and cannot be cleared`);
		return null;
	}
	const cell = encodeCell(column, value, what);
	// `encodeCell` returns a scalar for a scalar column.
	return column.type === "json" ? { json: cell.stored } : (cell.stored as Scalar);
}

// 为迁移步骤构造 TableSql：columns 是步骤时的列形态，physical/key 来自同一临时定义；
// 只在迁移开始时调用一次，后续分块复用。
function sqlOf(definition: TableDefinition, table: string): TableSql {
	return new TableSql(table, definition.columns, definition.rows.physical, definition.key);
}

/** Commits `writes` without the activation's abort: a commit admitted to the step completes (the fence refuses one). */
// 提交一组写，并去掉激活 context 的 abort signal：一旦提交被 fence 接纳，就必须完整执行，
// 不能因为激活结束而在事务中途取消；是否接纳由 fence.admit 决定。
async function commit(writes: StagedWrite[], target: Omit<MigrationTarget, "table">, context: Context): Promise<void> {
	await target.store.commit(writes, target.fence, withoutAbortSignal(context));
}
