// The store's write vocabulary (`StoreWrite`, slice 6a §7, §8; decision "Writes carry their versions"): one change of
// the store each, as the outbox and archives record it.

// 所属：packages/chord/src/store 存储层的写入词汇表。
// 解决的问题：文档与表两类写入需要同一种可 JSON 序列化的记录，才能进入 outbox、导出到归档、
// 再由副本按相同顺序重放；本文件把两边已有的记录类型合成 StoreWrite，不定义新的运行时行为。
// 职责边界：只声明类型，没有函数、常量或运行时校验；导入的 DocumentWrite/TableWrite 都是 import type，
// 编译后完全擦除。真正的形状校验发生在信任边界（从归档读入时由对应 applier 完成）。
// 上游：engine.ts 的文档写（document.create/change/retire/revision）、table-writes.ts 的表写
// （table/index/dropIndex/alter/put/update/delete/updateWhere/deleteWhere）；
// 下游：StagedWrite.apply 返回 StoreWrite[]，提交步骤把记录交给 outbox 与归档。
//
// 能力清单：
// - StoreWrite：文档写或表写的联合类型，按 kind 字段区分具体动作；这是本文件唯一的导出。
// - DocumentWrite：来自 engine.ts，文档创建/变更/退休/修订记录。
// - TableWrite：来自 table-writes.ts，表结构或行数据的变更记录。
//
// 组合关系：事务或激活把操作暂存为 StagedWrite；apply(step) 执行后返回 StoreWrite[]；
// store 提交成功即把这些记录写入 outbox，归档再按同样顺序交给 appliers 重放。
// 示例：
// const write: StoreWrite = { kind: "index", table: "app.store:edits", name: "by_path", columns: ["path"] };
//
// 建议阅读顺序：先读本文件的 StoreWrite，再看 engine.ts 的 DocumentWrite 与 table-writes.ts 的 TableWrite，
// 最后看 step.ts 的 StagedWrite.apply 与归档导入的 applier，理解记录如何产生、提交和重放。

import type { DocumentWrite } from "./engine.ts";
import type { TableWrite } from "./table-writes.ts";

// import type 只参与开发时检查；本模块没有执行 SQL 或实例化文档引擎的运行时逻辑。

/** One change of the store, tagged by `kind`. */
/** StoreWrite 是一个联合：每个值恰好是 DocumentWrite 或 TableWrite 中的一种，都带 kind 标签。
 * 运行时没有自动收窄或校验；从 JSON 读回后需先按 applier 的规则检查。 */
export type StoreWrite = DocumentWrite | TableWrite;

// TS 语法：`|` 构成联合类型，kind 是判别字段（discriminant），赋值后也可能被 switch 自动收窄。
// 例如 `if (write.kind === "delete") write.key` 中 write 被收窄为表删除变体；两组 kind 名称不重叠，
// document.* 属于文档写，其余属于表写。类型只描述本仓库构造的对象形状，不校验外部 JSON。
