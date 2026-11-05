// Documents for Chord's layers: an object's documents and slots, the handles' classes, the seal token, transactions.

// 文件导读
// 所属：packages/chord/src/documents，Chord 内部层汇总出口（不是应用 API）。
// 职责边界：把文档层内部类型与类集中 re-export 给 host/jobs 等兄弟模块；不定义行为、不做校验。
// 上游：host、jobs 等 Chord 源码；下游：AddressSource、Documents、SealToken、handles、keyed-slot、persistence、slot、transaction 的实现文件。
// 结果/错误：导出本身无运行期行为；被导出实现抛出的 ChordError 由调用层处理。
// 能力清单：AddressSource 文档地址源基类；Documents/DocumentsOwner/TransactionCancelled 对象文档管理与取消报告；SealToken 封条；KeyDeclarer/Keyed/Singleton 句柄；KeyedSlot/KeySource 键控槽与源；Persistence 及存储类型；AnyDefinition/DocumentSlot/PersistedSlot/SlotDefinition 槽抽象；Staged/Transaction 事务。
// 组合关系：host 创建 Documents → declare 产生句柄 → 句柄 tx 创建 Transaction → Transaction 通过 slot 与 Persistence 提交；SealToken 横贯这些步骤做封条。
// 示例：import { Documents } from "../documents/internal.ts"; const docs = new Documents(owner);（内部代码用法，应用不应这样导入）。
// 阅读顺序：先看 index.ts 的公开面，再按 Documents → slot → persistence → transaction 的顺序读实现。
// 纯类型与运行期值混在同一出口：AddressSource、Documents、SealToken、Keyed、Singleton、KeySource、Persistence、SlotDefinition 是运行期值；其余多为类型。
// AddressSource：跟随单个文档地址的可观察源基类；slot 与 KeySource 通过它把提交结果变成 watch 帧。
export { AddressSource } from "./address-source.ts";
// Documents 是一个对象的文档管理器；DocumentsOwner 是宿主提供的回调与上下文；TransactionCancelled 是取消事务的报告形状。
export { Documents, type DocumentsOwner, type TransactionCancelled } from "./documents.ts";
// SealToken：尝试、单次任务或对象共用的封条；封住后新事务被拒，在途事务被切断。
export { SealToken } from "./fence.ts";
// KeyDeclarer 限定工厂内 at(key) 的声明者；Keyed / Singleton 是两个运行期句柄类。
export { type KeyDeclarer, Keyed, Singleton } from "./handles.ts";
// KeyedSlot 是键控槽类型；KeySource 是每个 pinned 键的源，由 keyed-slot.ts 实现。
export { type KeyedSlot, KeySource } from "./keyed-slot.ts";
// 持久化层：DocumentChange 是一次事务对一个文档的改动；Held 是延迟写入的 ops；Persistence 封装 store 读写；Stored 是内存已知坐标；StoredChange 是提交要写入的内容；storedAfter 给出提交后的 Stored。
export {
	type DocumentChange,
	type Held,
	Persistence,
	type Stored,
	type StoredChange,
	storedAfter,
} from "./persistence.ts";
// 槽层：AnyDefinition 抹平值类型；DocumentSlot 是事务可草拟/收养的抽象；PersistedSlot 是持久槽的额外能力；SlotDefinition 管定义版本校验。
export { type AnyDefinition, type DocumentSlot, type PersistedSlot, SlotDefinition } from "./slot.ts";
// 事务：Staged 是 Chord 自有变更（如任务运行记录）的收养/落定回调；Transaction 是运行期实现。这里用 export type 只导出类型。
export type { Staged, Transaction } from "./transaction.ts";
