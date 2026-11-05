// Documents for apps: definitions, handles and transactions.

// 文件导读
// 所属：packages/chord/src/documents，Chord v2 文档层面向应用的公开入口（应用 SDK 面）。
// 职责边界：只做 re-export，不实现行为；应用从这里拿定义函数、句柄类型与事务接口，Chord 内部层则用 internal.ts。
// 上游：应用通过包入口导入；下游：definition.ts 提供 defineState/StateDefinition，handles.ts 提供句柄类型，transaction.ts 提供 Tx。
// 结果/错误：本文件不产生运行期结果或错误；错误由下游实现抛出（如 defineState 的名称校验、事务提交失败）。
// 能力清单：defineState 创建状态定义；CommitPersistence 控制提交落盘时机；JsonObject 是文档根类型；StateDefinition 是定义类型；HandleOf 由定义选句柄；SingletonHandle/KeyedHandle 是单例/键控句柄接口；Tx 是事务回调接口。
// 组合关系：应用用 defineState 声明定义 → 框架 activation 生成句柄（类型由 HandleOf 推导）→ 句柄读值/开事务（Tx）→ 事务提交产生 watch 帧。
// 示例：import { defineState, int, obj } from "@earendil-works/chord"; const counter = defineState("counter", { schema: obj({ count: int() }), version: 1, initial: () => ({ count: 0 }) }); 之后 self.state(counter) 的类型是 SingletonHandle<{ count: number }>。
// 阅读顺序：先看 definition.ts 的 StateDefinition，再看 handles.ts 的句柄接口，最后看 transaction.ts 的 Tx。
// 其中只有 defineState 是运行期值；其余全是类型，编译后擦除，不能用于 instanceof 或 new。
export { type CommitPersistence, defineState, type JsonObject, type StateDefinition } from "./definition.ts";
// HandleOf<D> 是编译期条件类型：D 的 keyed 为 true 时映射为 KeyedHandle，否则 SingletonHandle。
// KeyedHandle / SingletonHandle 只描述应用可调用的方法，运行时不存在对应的值。
// export type 明确这是纯类型导出，不会被 JS 导入携带。
export type { HandleOf, KeyedHandle, SingletonHandle } from "./handles.ts";
// Tx 是事务回调收到的接口；实现类是 transaction.ts 的 Transaction，由 Documents.tx 创建后传入回调。
// 应用只依赖接口：不构造 Transaction，也不直接调用它的内部方法。
export type { Tx } from "./transaction.ts";
