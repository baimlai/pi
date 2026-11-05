// The catalog (slice 6a §2, §5): the table definitions the store records (version, state, columns, key, fingerprint,
// indexes), read once at open, changed only by `table`, `index`, `dropIndex` and `alter` writes inside a step, and in
// memory again only after `COMMIT` returned.
// 本文件负责内部目录表 `chord.tables` 的读写：打开时读出全部表定义，提交步骤中把改动后的定义写回。
// 上游是 openStore（readCatalog）和 Step/commit（writeCatalog）；目录是普通 SQL 行，值是 JSON 文本。
// 所属模块：packages/chord/src/store 的内部目录（chord.tables）。
// 上下游：openStore 调 readCatalog 读入内存；Step/commit 调 writeCatalog 在同一事务写回。依赖 TABLES 常量与 Step。
// 结果：readCatalog 返回 Map；writeCatalog 无返回。SQL/JSON 错误向上拒绝，不吞掉。
// 能力清单：
// - TableRecord：目录行的持久形状（版本、状态、列、主键、指纹、索引）。
// - readCatalog(executor)：读出全部表定义。
// - writeCatalog(step)：只写入本步骤改动过的表。
// 组合关系：打开时 readCatalog -> Step 内 table/index/alter 修改内存记录 -> 提交前 writeCatalog -> COMMIT 后 store 替换内存目录。
// 示例：const tables = await readCatalog(executor); tables.get("notes:items")?.version; // 例如 1
// 阅读顺序：先 TableRecord 各字段，再 readCatalog 的 JSON.parse 断言，最后 writeCatalog 的 OR REPLACE 语义。

import type { SqliteExecutor } from "../sqlite/index.ts";
import type { ColumnRecord } from "./columns.ts";
import { TABLES } from "./schema.ts";
import type { Step } from "./step.ts";

/** A table as the store records it, by its SQL name. */
// 这是目录的持久形状，不是 defineTable 的 TableDefinition；它只含运行副本所需的数据，不含插件代码或编解码器。
// 类型字段都是编译期描述；从数据库读出的 JSON 只经过 as TableRecord 断言，形状由写入端保证。
export type TableRecord = {
	// readonly 仅限制类型检查阶段的赋值；这里的对象按约定只读，不会因为类型而被运行时冻结。
	readonly table: string;
	readonly version: number;
	/** `migrating` while an eager migration of `version` runs (slice 6a §9). */
	readonly state: "ready" | "migrating";
	readonly columns: { readonly [name: string]: ColumnRecord };
	// 字符串索引签名表示按列名查记录，key 列表保存主键的顺序，不是无序集合。
	readonly key: readonly string[];
	readonly fingerprint: string;
	/** Index definitions by name: their declared columns (the key is appended when rendered). */
	// 索引名到列数组。主键列不会重复存进这里，渲染 SQL 时再追加，避免记录两份同样的信息。
	readonly indexes: { readonly [name: string]: readonly string[] };
};

/** Every recorded table, by SQL name. */
/** 从内部目录表读出全部表定义，以 SQL 表名为键返回 Map；例如一行 notes:items 对应一个 TableRecord。执行一次查询与 JSON.parse，SQL 或损坏 JSON 的错误直接向上传递。 */
export async function readCatalog(executor: SqliteExecutor): Promise<Map<string, TableRecord>> {
	// await 等查询完成；泛型只描述预期行字段，不会校验数据库实际返回值。
	const rows = await executor.all<{ readonly name: string; readonly definition: string }>(
		// 只从 Chord 固定内部表读取；definition 是写入目录时序列化的 JSON。
		`SELECT name, definition FROM ${TABLES.tables}`,
	);
	// map 的解构参数取出每行字段，as TableRecord 是内部存储约定的类型断言，并不验证 JSON 形状。
	return new Map(rows.map(({ name, definition }) => [name, JSON.parse(definition) as TableRecord]));
}

/** Writes the table records `step` changed, once each, inside its backend transaction. */
/** 把本次提交变动的目录记录逐项写入同一 SQL 事务，返回 Promise<void>；例如一次增加索引后只保存受影响表的最终定义。不会在这里更新 store 的提交后内存目录。 */
export async function writeCatalog(step: Step): Promise<void> {
	// Map 的每个条目解构为表名和最终记录；同表多次变动在 Step.tables 中只保留最后一份。
	for (const [name, record] of step.tables) {
		// 目录是 JSON 文本；序列化异常会拒绝当前 async 函数，交由提交事务处理。
		const definition = JSON.stringify(record);
		// 参数通过 ? 绑定，表名是固定内部常量；await 让下一项在这一项完成后才写入。
		await step.run(`INSERT OR REPLACE INTO ${TABLES.tables} (name, definition) VALUES (?, ?)`, name, definition);
	}
}
